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
  FALLBACK_SEARCH_PREFIX_LENGTH: 8,
  CREDENTIAL_FETCH_COOLDOWN_MS: 1000, // Initial delay between credential requests (adaptive)
  GLOBAL_REQUEST_COOLDOWN_MS: 1000, // Initial minimum delay between requests (adaptive)
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
 * Session pool manager for reusing API sessions.
 *
 * How it works:
 * - Maintains a pool of sessions, each with cached API credentials
 * - Creates new sessions up to maxSessions, then rotates through them
 * - Rate limiting is handled by AdaptiveRateLimiter, not by session pool
 *
 * Example with 4 sessions:
 *   Request 1-4: Use sessions 1-4 immediately (no wait)
 *   Request 5+: Rotate through existing sessions (adaptive timing controls delays)
 */
class SessionPool {
  private sessions: Session[] = [];
  private readonly maxSessions: number;
  private currentIndex = 0;

  constructor(maxSessions: number) {
    this.maxSessions = maxSessions;
  }

  /**
   * Get an available session from the pool.
   * Creates new sessions up to maxSessions, then rotates through them.
   * Rate limiting is handled by AdaptiveRateLimiter.
   *
   * @returns Session with credentials ready to use
   */
  async getSession(): Promise<Session> {
    // Create new session if pool not yet full
    if (this.sessions.length < this.maxSessions) {
      return await this.createNewSession();
    }

    // Pool is full - rotate through sessions in round-robin fashion
    const session = this.sessions[this.currentIndex]!;
    this.currentIndex = (this.currentIndex + 1) % this.maxSessions;
    return session;
  }

  /**
   * Create a new session with fresh credentials
   */
  private async createNewSession(): Promise<Session> {
    const sessionNumber = this.sessions.length + 1;
    console.log(`Creating new session slot (${sessionNumber}/${this.maxSessions})...`);

    // Fetch credentials (rate limiting handled inside getApiCredentials)
    const credentials = await getApiCredentials();

    const session: Session = {
      credentials,
      lastUsedAt: Date.now(), // Keep for potential future use
    };

    this.sessions.push(session);
    return session;
  }

  /**
   * Get current pool size (for statistics)
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
 * Removes: () （） " " " ' ' ' and spaces
 *
 * @param str - Input string to normalize
 * @returns Normalized string without special characters or spaces
 */
function normalizeForComparison(str: string): string {
  return str.replace(/[()（）]/g, "").replace(/["""''']/g, "").replace(/\s+/g, "");
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
// Rate Limiting Management
// ============================================================================

/**
 * Adaptive rate limiter that learns from API responses.
 * Automatically adjusts timing based on success/failure patterns:
 * - Increases delays when hitting rate limits (503, 429 errors)
 * - Decreases delays when requests succeed consistently
 * - Self-tunes to find optimal throughput without triggering limits
 */
class AdaptiveRateLimiter {
  private lastCredentialFetchTime = 0;
  private lastApiRequestTime = 0;

  // Adaptive timing (explicitly typed as number to allow dynamic adjustment)
  private currentCredentialDelay: number = TIMING_CONFIG.CREDENTIAL_FETCH_COOLDOWN_MS;
  private currentRequestDelay: number = TIMING_CONFIG.GLOBAL_REQUEST_COOLDOWN_MS;

  // Success/failure tracking
  private recentSuccesses = 0;
  private recentFailures = 0;
  private readonly ADAPTATION_WINDOW = 10; // Require more successes (10) to prevent premature speedup
  private lastAdjustmentTime = 0; // Track when we last adjusted timing

  // Anti-jiggling: minimum time between adjustments
  private readonly MIN_ADJUSTMENT_INTERVAL_MS = 15000; // Wait at least 15s between speed changes

  // Min/max bounds for adaptive timing
  private readonly MIN_REQUEST_DELAY = 500;   // 0.5s minimum
  private readonly MAX_REQUEST_DELAY = 5000;  // 5s maximum
  private readonly MIN_CREDENTIAL_DELAY = 1000; // 1s minimum
  private readonly MAX_CREDENTIAL_DELAY = 10000; // 10s maximum

  // Asymmetric adjustment rates (back off faster than speed up)
  private readonly SPEEDUP_FACTOR = 0.95;  // Reduce by 5% (conservative)
  private readonly BACKOFF_FACTOR = 1.5;   // Increase by 50% (aggressive)

  /**
   * Wait before fetching credentials (with adaptive timing)
   */
  async waitForCredentialFetch(): Promise<void> {
    const now = Date.now();
    const timeSinceLastFetch = now - this.lastCredentialFetchTime;
    const waitTime = this.currentCredentialDelay - timeSinceLastFetch;

    if (this.lastCredentialFetchTime > 0 && waitTime > 0) {
      console.log(`[Credentials] Waiting ${Math.round(waitTime / 1000)}s (adaptive: ${Math.round(this.currentCredentialDelay / 1000)}s)`);
      await delay(waitTime);
    }

    this.lastCredentialFetchTime = Date.now();
  }

  /**
   * Wait before making an API request (with adaptive timing)
   */
  async waitForApiRequest(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastApiRequestTime;
    const waitTime = this.currentRequestDelay - timeSinceLastRequest;

    if (this.lastApiRequestTime > 0 && waitTime > 0) {
      console.log(`[Adaptive] Waiting ${Math.round(waitTime / 1000)}s (delay: ${Math.round(this.currentRequestDelay / 1000)}s)`);
      await delay(waitTime);
    }

    this.lastApiRequestTime = Date.now();
  }

  /**
   * Report a successful API request
   * Gradually decreases delays on consistent success
   * Anti-jiggling: requires multiple successes AND cooldown period before adjusting
   */
  reportSuccess(): void {
    this.recentSuccesses++;
    this.recentFailures = Math.max(0, this.recentFailures - 1);

    const now = Date.now();
    const timeSinceLastAdjustment = now - this.lastAdjustmentTime;

    // Anti-jiggling: Only adjust if we have enough successes AND enough time has passed
    if (
      this.recentSuccesses >= this.ADAPTATION_WINDOW &&
      timeSinceLastAdjustment >= this.MIN_ADJUSTMENT_INTERVAL_MS
    ) {
      this.recentSuccesses = 0;
      this.lastAdjustmentTime = now;

      // Speed up conservatively (5% reduction)
      const oldDelay = this.currentRequestDelay;
      this.currentRequestDelay = Math.max(
        this.MIN_REQUEST_DELAY,
        Math.round(this.currentRequestDelay * this.SPEEDUP_FACTOR)
      );

      // Only log if delay actually changed
      if (this.currentRequestDelay !== oldDelay) {
        console.log(`[Adaptive] 🎯 Speeding up: ${Math.round(oldDelay / 1000)}s → ${Math.round(this.currentRequestDelay / 1000)}s`);
      }
    }
  }

  /**
   * Report a rate limit error (503, 429, etc.)
   * Immediately increases delays to back off (ignores cooldown for safety)
   */
  reportRateLimit(): void {
    this.recentFailures++;
    this.recentSuccesses = 0;
    this.lastAdjustmentTime = Date.now(); // Reset adjustment timer

    const oldRequestDelay = this.currentRequestDelay;
    const oldCredentialDelay = this.currentCredentialDelay;

    // Back off aggressively: increase by 50%
    this.currentRequestDelay = Math.min(
      this.MAX_REQUEST_DELAY,
      Math.round(this.currentRequestDelay * this.BACKOFF_FACTOR)
    );

    this.currentCredentialDelay = Math.min(
      this.MAX_CREDENTIAL_DELAY,
      Math.round(this.currentCredentialDelay * this.BACKOFF_FACTOR)
    );

    console.log(
      `[Adaptive] ⚠️  Rate limited! Backing off:\n` +
      `   Request: ${Math.round(oldRequestDelay / 1000)}s → ${Math.round(this.currentRequestDelay / 1000)}s\n` +
      `   Credential: ${Math.round(oldCredentialDelay / 1000)}s → ${Math.round(this.currentCredentialDelay / 1000)}s`
    );
  }

  /**
   * Get current timing stats (for debugging)
   */
  getStats(): { requestDelay: number; credentialDelay: number; successRate: string } {
    const total = this.recentSuccesses + this.recentFailures;
    const successRate = total > 0
      ? `${Math.round((this.recentSuccesses / total) * 100)}%`
      : 'N/A';

    return {
      requestDelay: this.currentRequestDelay,
      credentialDelay: this.currentCredentialDelay,
      successRate,
    };
  }
}

// Global adaptive rate limiter instance
const globalRateLimiter = new AdaptiveRateLimiter();

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get API credentials (RSA public key and session cookie) from the init endpoint.
 * The public key is used to sign subsequent requests.
 * Includes automatic rate limiting to avoid overwhelming the server.
 *
 * @returns API credentials or null values if request fails
 */
async function getApiCredentials(): Promise<ApiCredentials> {
  // Apply rate limiting before fetching
  await globalRateLimiter.waitForCredentialFetch();

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

    return { publicKey, cookie };
  } catch (error) {
    console.warn("Failed to get API credentials:", error);
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

  // Apply global rate limiting before making request
  await globalRateLimiter.waitForApiRequest();

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

  // Check for rate limiting responses
  if (response.status === 429 || response.status === 503) {
    globalRateLimiter.reportRateLimit();
    throw new Error(`Rate limited: ${response.status} ${response.statusText}`);
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as ProductListResponse;

  // Report success to adaptive rate limiter
  globalRateLimiter.reportSuccess();

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

  // If no results, try with first N characters as fallback
  if (results.length === 0) {
    const prefixLength = TIMING_CONFIG.FALLBACK_SEARCH_PREFIX_LENGTH;
    const prefix = productName.slice(0, prefixLength);
    console.log(
      `No results for full name, trying first ${prefixLength} chars: "${prefix}"`
    );

    results = await searchProducts(prefix, sessionPool);

    if (results.length === 0) {
      const prefixLength = TIMING_CONFIG.FALLBACK_SEARCH_PREFIX_LENGTH;
      console.log(
        `No products found for "${productName}" (tried full name and ${prefixLength}-char prefix), returning empty code`
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
 * Fetch product with retry logic.
 * Retries failed requests without additional delays.
 * The adaptive rate limiter handles all timing adjustments automatically.
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

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fetchProduct(productName, sessionPool);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      // Just retry - adaptive rate limiter will enforce appropriate delays
      console.log(`Retry ${attempt}/${maxAttempts} for "${productName}"`);
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
 * - bun index.ts --sessions 4 (recommended - adaptive timing handles interval)
 * - bun index.ts --input products.txt --output results.csv --sessions 4
 * - bun index.ts products.txt results.csv 8 4 (legacy format with interval)
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
      sessions: "4", // Default to 4 concurrent sessions for optimal performance
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
  // Start timer
  const startTime = Date.now();

  const { input: inputFile, output: outputFile, intervalMs, sessions } = parseArgs();

  // Session count validation only (interval is optional with adaptive timing)
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
        "Usage: bun index.ts [--input products.txt] [--output results.csv] [--sessions count] [--interval seconds]"
      );
      console.error("Note: --interval is optional (adaptive timing adjusts automatically)");
      process.exit(1);
    }
    throw error;
  }

  if (productNames.length === 0) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  console.log(`Processing ${productNames.length} products with ${sessions} concurrent session(s)...`);
  console.log(`Adaptive rate limiter will optimize request timing automatically.\n`);

  // Create session pool
  const sessionPool = new SessionPool(sessions);

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

  // Show adaptive rate limiter stats
  const rateLimiterStats = globalRateLimiter.getStats();
  console.log(`\n⚡ Adaptive Rate Limiter:`);
  console.log(`   Request delay: ${Math.round(rateLimiterStats.requestDelay / 1000)}s`);
  console.log(`   Credential delay: ${Math.round(rateLimiterStats.credentialDelay / 1000)}s`);
  console.log(`   Success rate: ${rateLimiterStats.successRate}`);

  // Calculate elapsed time
  const endTime = Date.now();
  const elapsedMs = endTime - startTime;
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const timeDisplay = minutes > 0
    ? `${minutes}m ${seconds}s`
    : `${seconds}s`;

  console.log(`\n📊 Summary:`);
  console.log(`   Total products: ${productNames.length}`);
  console.log(`   ✓ Successfully fetched: ${successCount}`);
  console.log(`   ✗ Failed (empty code): ${failedCount}`);
  console.log(`   ⏱️  Total time: ${timeDisplay}`);
}

// Run main function
main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
