import { KJUR, KEYUTIL, hextob64 } from "jsrsasign";
import { promises as fs } from "fs";
import path from "path";
import minimist from "minimist";

// ============================================================================
// Type Definitions & Interfaces
// ============================================================================

/**
 * Product information from the wealth management API
 */
interface Product {
  prodName: string;
  prodRegCode: string;
}

/**
 * Response from the initialization endpoint containing RSA public key
 */
interface ApiInitResponse {
  code?: number | string;
  msg?: string;
  data?: string; // RSA public key for signing requests
}

/**
 * Response from the product search endpoint
 */
interface ProductListResponse {
  code?: number | string;
  msg?: string;
  data?: {
    list?: Product[];
    total?: number;
  };
}

/**
 * Final product result (may have empty code if not found)
 */
interface ProductResult {
  prodName: string;
  prodRegCode: string; // Empty string if product not found
}

/**
 * Command line arguments configuration
 */
interface CliOptions {
  input: string;
  output: string;
  intervalMs: number;
  sessions: number;
}

/**
 * Request body structure for product search API
 */
interface SearchRequest {
  prodName: string;
  prodRegCode: string;
  orgName: string;
  pageNum: number;
  pageSize: number;
  prodStatus: string;
  prodSpclAttr: string;
  prodInvestNature: string;
  prodOperateMode: string;
  prodRiskLevel: string;
  prodTermCode: string;
  actDaysStart: null;
  actDaysEnd: null;
}

/**
 * API credentials needed for making authenticated requests
 */
interface ApiCredentials {
  publicKey: string | null;
  cookie: string | null;
}

/**
 * Session slot with cached credentials and rate limiting
 */
interface Session {
  credentials: ApiCredentials; // Cached credentials for this session
  lastUsedAt: number; // timestamp in milliseconds
}

// ============================================================================
// Constants
// ============================================================================

/**
 * API endpoint configuration
 */
const API_CONFIG = {
  BASE_URL: "https://xinxipilu.chinawealth.com.cn",
  ENDPOINTS: {
    INIT: "/lcxp-platService/product/getInitData",
    SEARCH: "/lcxp-platService/product/getProductList",
  },
  PAGE_SIZE: 20,
} as const;

/**
 * Timing and retry configuration
 */
const TIMING_CONFIG = {
  DEFAULT_INTERVAL_MS: 8000,
  MAX_RETRY_ATTEMPTS: 5,
  INITIAL_RETRY_WAIT_MS: 8000,
  FALLBACK_SEARCH_DELAY_MS: 8000,
  PREFIX_LENGTH: 8,
} as const;

/**
 * HTTP headers for API requests
 */
const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Content-Type": "application/json;charset=UTF-8",
  Accept: "application/json, text/plain, */*",
  Referer: API_CONFIG.BASE_URL,
} as const;

// ============================================================================
// Session Pool Management
// ============================================================================

/**
 * Session pool manager for reusing API sessions with rate limiting.
 * Maintains a pool of sessions, each with its own 8s cooldown period.
 */
class SessionPool {
  private sessions: Session[] = [];
  private maxSessions: number;
  private intervalMs: number;

  constructor(maxSessions: number, intervalMs: number) {
    this.maxSessions = maxSessions;
    this.intervalMs = intervalMs;
  }

  /**
   * Get a session from the pool.
   * - If pool < max: create new session slot with fresh credentials
   * - If pool >= max: reuse oldest session (wait if needed for rate limit cooldown)
   */
  async getSession(): Promise<Session> {
    const now = Date.now();

    // If pool not full, create new session slot with credentials
    if (this.sessions.length < this.maxSessions) {
      console.log(`Creating new session slot (${this.sessions.length + 1}/${this.maxSessions})...`);

      // Fetch credentials (rate limiting handled inside getApiCredentials)
      const credentials = await getApiCredentials();

      const session: Session = {
        credentials,
        lastUsedAt: Date.now(), // Mark as used immediately
      };
      this.sessions.push(session);
      return session;
    }

    // Pool is full - find oldest session
    const oldestSession = this.sessions.reduce((oldest, current) =>
      current.lastUsedAt < oldest.lastUsedAt ? current : oldest
    );

    // Wait if necessary to respect rate limit cooldown
    const timeSinceLastUse = now - oldestSession.lastUsedAt;
    const waitTime = this.intervalMs - timeSinceLastUse;

    if (waitTime > 0) {
      console.log(`Waiting ${Math.round(waitTime / 1000)}s for session cooldown...`);
      await delay(waitTime);
    }

    // Mark session as used when we allocate it
    oldestSession.lastUsedAt = Date.now();

    return oldestSession;
  }

  /**
   * Get current pool size
   */
  getPoolSize(): number {
    return this.sessions.length;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Simple delay utility
 * @param ms - Milliseconds to wait
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove special characters for similarity comparison.
 * Removes: () （） " " " ' ' '
 *
 * @param str - Input string to normalize
 * @returns Normalized string without special characters
 */
function normalizeForComparison(str: string): string {
  return str.replace(/[()（）]/g, "").replace(/["""''']/g, "");
}

/**
 * Find exact matching product after normalization.
 * Returns the product that exactly matches the search term after removing special characters.
 *
 * @param searchTerm - The original search term to match against
 * @param candidates - Array of products returned from API
 * @returns The product that exactly matches, or null if no exact match found
 */
function findExactMatch(searchTerm: string, candidates: Product[]): Product | null {
  if (candidates.length === 0) {
    return null;
  }

  const normalizedSearch = normalizeForComparison(searchTerm);

  for (const candidate of candidates) {
    if (!candidate) continue;

    const normalizedCandidate = normalizeForComparison(candidate.prodName);

    // Exact match after normalization
    if (normalizedSearch === normalizedCandidate) {
      return candidate;
    }
  }

  // No exact match found
  return null;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Track last credential fetch time to enforce rate limiting
 */
let lastCredentialFetchTime = 0;
const CREDENTIAL_FETCH_COOLDOWN_MS = 2000; // 2s between credential requests

/**
 * Track last API request time for global rate limiting
 */
let lastApiRequestTime = 0;
const GLOBAL_REQUEST_COOLDOWN_MS = 1000; // Minimum 1s between ANY requests

/**
 * Get API credentials (RSA public key and session cookie) from the init endpoint.
 * The public key is used to sign subsequent requests.
 * Includes automatic rate limiting to avoid overwhelming the server.
 *
 * @returns API credentials or null values if request fails
 */
async function getApiCredentials(): Promise<ApiCredentials> {
  // Rate limiting: wait if needed before fetching credentials
  const now = Date.now();
  const timeSinceLastFetch = now - lastCredentialFetchTime;
  const waitTime = CREDENTIAL_FETCH_COOLDOWN_MS - timeSinceLastFetch;

  if (lastCredentialFetchTime > 0 && waitTime > 0) {
    console.log(`[Credentials] Waiting ${Math.round(waitTime / 1000)}s before fetching...`);
    await delay(waitTime);
  }
  const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.INIT}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: HTTP_HEADERS,
      body: "{}",
    });

    const text = await response.text();
    const cookie = response.headers.get("set-cookie");

    let publicKey: string | null = null;
    try {
      const parsed = JSON.parse(text) as ApiInitResponse;
      publicKey = parsed?.data ?? null;
    } catch (error) {
      console.warn("Failed to parse init response:", error);
    }

    // Record fetch time for rate limiting
    lastCredentialFetchTime = Date.now();

    return { publicKey, cookie };
  } catch (error) {
    console.warn("Failed to get API credentials:", error);

    // Record fetch time even on error
    lastCredentialFetchTime = Date.now();

    return { publicKey: null, cookie: null };
  }
}

/**
 * Create an RSA-SHA256 signature for the request body.
 *
 * @param body - Request body object to sign
 * @param publicKey - RSA public key for signing
 * @returns Base64-encoded signature or null if signing fails
 */
function createSignature(
  body: SearchRequest,
  publicKey: string | null
): string | null {
  if (!publicKey || typeof publicKey !== "string") {
    return null;
  }

  try {
    const key = KEYUTIL.getKey(publicKey);
    const sig = new KJUR.crypto.Signature({ alg: "SHA256withRSA" });
    sig.init(key);
    sig.updateString(JSON.stringify(body));
    return hextob64(sig.sign());
  } catch (error) {
    console.warn("Failed to create signature:", error);
    return null;
  }
}

/**
 * Search for products by name using the signed API.
 *
 * @param searchTerm - Product name to search for
 * @param sessionPool - Session pool for managing rate limiting and credentials
 * @returns Array of matching products (empty if none found)
 */
async function searchProducts(
  searchTerm: string,
  sessionPool: SessionPool
): Promise<Product[]> {
  // Get session from pool (waits if necessary, marks as used immediately)
  const session = await sessionPool.getSession();

  // Global rate limiting: enforce minimum delay between ANY requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastApiRequestTime;
  const globalWaitTime = GLOBAL_REQUEST_COOLDOWN_MS - timeSinceLastRequest;

  if (lastApiRequestTime > 0 && globalWaitTime > 0) {
    console.log(`[Global] Waiting ${Math.round(globalWaitTime / 1000)}s between requests...`);
    await delay(globalWaitTime);
  }

  // Use cached credentials from session
  const credentials = session.credentials;

  const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}`;

  const requestBody: SearchRequest = {
    prodName: searchTerm,
    prodRegCode: "",
    orgName: "",
    pageNum: 1,
    pageSize: API_CONFIG.PAGE_SIZE,
    prodStatus: "",
    prodSpclAttr: "",
    prodInvestNature: "",
    prodOperateMode: "",
    prodRiskLevel: "",
    prodTermCode: "",
    actDaysStart: null,
    actDaysEnd: null,
  };

  const signature = createSignature(requestBody, credentials.publicKey);

  const headers = {
    ...HTTP_HEADERS,
    ...(credentials.cookie ? { Cookie: credentials.cookie } : {}),
    ...(signature ? { signature } : {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  // Record request time for global rate limiting
  lastApiRequestTime = Date.now();

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as ProductListResponse;
  return json.data?.list ?? [];
}

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Fetch product information by name with intelligent fallback.
 *
 * Flow:
 * 1. Search with full product name
 * 2. If no results, wait and try with first 8 characters
 * 3. If multiple results, use similarity matching to find best match
 * 4. If still no results, return empty code
 *
 * @param productName - Product name to search for
 * @param sessionPool - Session pool for managing rate limiting
 * @returns Product result (may have empty prodRegCode if not found)
 */
async function fetchProduct(
  productName: string,
  sessionPool: SessionPool
): Promise<ProductResult> {

  // Try searching with full product name
  let results = await searchProducts(productName, sessionPool);

  // If no results, try with first N characters
  if (results.length === 0) {
    const prefix = productName.slice(0, TIMING_CONFIG.PREFIX_LENGTH);
    console.log(
      `No results for full name, trying first ${TIMING_CONFIG.PREFIX_LENGTH} chars: "${prefix}"`
    );

    results = await searchProducts(prefix, sessionPool);

    if (results.length === 0) {
      console.log(
        `No products found for "${productName}" (tried full name and ${TIMING_CONFIG.PREFIX_LENGTH}-char prefix), returning empty code`
      );
      return { prodName: productName, prodRegCode: "" };
    }
  }

  // Find exact match from results
  const selected = results.length === 1 ? results[0] : findExactMatch(productName, results);

  if (!selected) {
    console.log(`No exact match found for "${productName}", returning empty code`);
    return { prodName: productName, prodRegCode: "" };
  }

  return {
    prodName: selected.prodName,
    prodRegCode: selected.prodRegCode ?? "",
  };
}

/**
 * Fetch product with retry logic and exponential backoff.
 * Helps handle transient errors and rate limits.
 *
 * @param productName - Product name to search for
 * @param sessionPool - Session pool for managing rate limiting
 * @param maxAttempts - Maximum number of retry attempts
 * @returns Product result
 * @throws Error if all retry attempts fail
 */
async function fetchProductWithRetry(
  productName: string,
  sessionPool: SessionPool,
  maxAttempts = TIMING_CONFIG.MAX_RETRY_ATTEMPTS
): Promise<ProductResult> {
  let attempt = 0;
  let retryDelayMs = 1000; // Start with 1 second

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fetchProduct(productName, sessionPool);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      console.log(
        `Retry ${attempt}/${maxAttempts} for "${productName}" after ${retryDelayMs / 1000}s`
      );

      // Exponential backoff: wait before next retry
      await delay(retryDelayMs);
      retryDelayMs *= 2; // Double the delay for next retry
    }
  }

  throw new Error(`Failed to fetch after ${maxAttempts} attempts`);
}

// ============================================================================
// File I/O Functions
// ============================================================================

/**
 * Read and parse product names from input file.
 * Cleans up lines by:
 * - Trimming whitespace
 * - Removing quotes (English & Chinese)
 * - Removing all spaces
 *
 * @param filePath - Path to input file
 * @returns Array of cleaned product names
 */
async function readLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^["'"']|["'"']$/g, "")) // Remove quotes
    .map((line) => line.trim())
    .map((line) => line.replace(/\s+/g, "")) // Remove all spaces
    .filter((line) => line.length > 0);
}

/**
 * Write product results to CSV file.
 *
 * @param rows - Array of product results
 * @param outputPath - Path to output CSV file
 */
async function writeCsv(
  rows: ProductResult[],
  outputPath: string
): Promise<void> {
  const header = "prodName,prodRegCode";
  const lines = rows.map((row) => `${row.prodName},${row.prodRegCode}`);
  const csv = [header, ...lines].join("\n");

  await fs.writeFile(outputPath, csv, "utf8");
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

/**
 * Parse command line arguments.
 * Supports both named flags and positional arguments.
 *
 * Examples:
 * - bun index.ts --input products.txt --output results.csv --interval 8 --sessions 4
 * - bun index.ts products.txt results.csv 8 4
 *
 * @returns Parsed CLI options
 */
function parseArgs(): CliOptions {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      input: "i",
      output: "o",
      interval: "t", // seconds
      sessions: "s",
    },
    string: ["input", "output", "interval", "sessions"],
    default: {
      input: "products.txt",
      output: "results.csv",
      sessions: "1",
    },
  });

  const positional = argv._;

  const input =
    (positional[0] ? String(positional[0]) : argv.input) ?? "products.txt";
  const output =
    (positional[1] ? String(positional[1]) : argv.output) ?? "results.csv";

  const intervalCandidate =
    argv.interval ?? (positional[2] !== undefined ? positional[2] : undefined);
  const intervalSeconds = Number(intervalCandidate);
  const intervalMs =
    Number.isFinite(intervalSeconds) && intervalSeconds >= 0
      ? intervalSeconds * 1000
      : TIMING_CONFIG.DEFAULT_INTERVAL_MS;

  const sessionsCandidate =
    argv.sessions ?? (positional[3] !== undefined ? positional[3] : "1");
  const sessions = Number(sessionsCandidate);
  const sessionsCount = Number.isFinite(sessions) && sessions >= 1 ? sessions : 1;

  return {
    input,
    output,
    intervalMs,
    sessions: sessionsCount,
  };
}

// ============================================================================
// Main Execution
// ============================================================================

/**
 * Main execution flow:
 * 1. Parse command line arguments
 * 2. Read product names from input file
 * 3. Create session pool with max sessions
 * 4. Fetch all products concurrently using session pool
 * 5. Write results to CSV
 */
async function main(): Promise<void> {
  const { input: inputFile, output: outputFile, intervalMs, sessions } = parseArgs();

  if (Number.isNaN(intervalMs) || intervalMs < 0) {
    console.error("Invalid interval (ms).");
    process.exit(1);
  }

  if (Number.isNaN(sessions) || sessions < 1) {
    console.error("Invalid sessions count (must be >= 1).");
    process.exit(1);
  }

  // Read product names from input file
  let productNames: string[];
  try {
    productNames = await readLines(inputFile);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.error(`Input file not found: ${inputFile}`);
      console.error(
        "Usage: bun index.ts [--input products.txt] [--output results.csv] [--interval seconds] [--sessions count]"
      );
      process.exit(1);
    }
    throw error;
  }

  if (productNames.length === 0) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  console.log(`Processing ${productNames.length} products with ${sessions} concurrent session(s)...`);
  console.log(`Each session has ${intervalMs / 1000}s cooldown between requests.\n`);

  // Create session pool
  const sessionPool = new SessionPool(sessions, intervalMs);

  // Fetch products sequentially (one by one)
  // SessionPool controls timing - with N sessions, we'll use them in rotation
  const results: ProductResult[] = [];
  let successCount = 0;
  let failedCount = 0;

  for (const productName of productNames) {
    try {
      // Fetch product (sessionPool handles rate limiting internally)
      const result = await fetchProductWithRetry(productName, sessionPool);

      const displayCode = result.prodRegCode || "(empty)";
      console.log(`✓ ${result.prodName},${displayCode}`);

      results.push(result);

      // Count as success if we got a registration code
      if (result.prodRegCode) {
        successCount++;
      } else {
        failedCount++;
      }
    } catch (error) {
      console.log(`✗ Failed for "${productName}" after retries: ${error}`);
      // Still add product with empty code if it failed completely
      results.push({ prodName: productName, prodRegCode: "" });
      failedCount++;
    }
  }

  // Write results to CSV
  const outputPath = path.resolve(outputFile);
  await writeCsv(results, outputPath);
  console.log(`\n✓ Written ${results.length} rows to ${outputPath}`);
  console.log(`Session pool stats: ${sessionPool.getPoolSize()} session(s) created`);
  console.log(`\n📊 Summary:`);
  console.log(`   Total products: ${productNames.length}`);
  console.log(`   ✓ Successfully fetched: ${successCount}`);
  console.log(`   ✗ Failed (empty code): ${failedCount}`);
}

// Run main function
main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
