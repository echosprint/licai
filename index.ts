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
 * Calculate the longest common prefix length between two strings.
 * Used for similarity matching between product names.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns Length of the matching prefix
 */
function longestCommonPrefixLength(a: string, b: string): number {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);

  let i = 0;
  const minLength = Math.min(normalizedA.length, normalizedB.length);

  while (i < minLength && normalizedA[i] === normalizedB[i]) {
    i++;
  }

  return i;
}

/**
 * Find the best matching product from multiple candidates using longest common prefix algorithm.
 * If multiple products have the same prefix length, prefer the shorter product name.
 *
 * @param searchTerm - The original search term to match against
 * @param candidates - Array of products returned from API
 * @returns The product with the longest matching prefix (shorter names win ties)
 */
function findBestMatch(searchTerm: string, candidates: Product[]): Product {
  if (candidates.length === 0) {
    throw new Error("Cannot find best match from empty candidates array");
  }

  const firstCandidate = candidates[0];
  if (!firstCandidate) {
    throw new Error("First candidate is undefined");
  }

  let bestMatch = firstCandidate;
  let bestScore = longestCommonPrefixLength(searchTerm, bestMatch.prodName);

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;

    const score = longestCommonPrefixLength(searchTerm, candidate.prodName);

    // Use longest prefix, or shorter name as tie-breaker
    if (
      score > bestScore ||
      (score === bestScore &&
        candidate.prodName.length < bestMatch.prodName.length)
    ) {
      bestMatch = candidate;
      bestScore = score;
    }
  }

  return bestMatch;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get API credentials (RSA public key and session cookie) from the init endpoint.
 * The public key is used to sign subsequent requests.
 *
 * @returns API credentials or null values if request fails
 */
async function getApiCredentials(): Promise<ApiCredentials> {
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
 * @param credentials - API credentials (public key and cookie)
 * @returns Array of matching products (empty if none found)
 */
async function searchProducts(
  searchTerm: string,
  credentials: ApiCredentials
): Promise<Product[]> {
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
 * @returns Product result (may have empty prodRegCode if not found)
 */
async function fetchProduct(productName: string): Promise<ProductResult> {
  const credentials = await getApiCredentials();

  // Try searching with full product name
  let results = await searchProducts(productName, credentials);

  // If no results, try with first N characters
  if (results.length === 0) {
    const prefix = productName.slice(0, TIMING_CONFIG.PREFIX_LENGTH);
    console.log(
      `No results for full name, trying first ${TIMING_CONFIG.PREFIX_LENGTH} chars: "${prefix}"`
    );

    await delay(TIMING_CONFIG.FALLBACK_SEARCH_DELAY_MS);
    results = await searchProducts(prefix, credentials);

    if (results.length === 0) {
      console.log(
        `No products found for "${productName}" (tried full name and ${TIMING_CONFIG.PREFIX_LENGTH}-char prefix), returning empty code`
      );
      return { prodName: productName, prodRegCode: "" };
    }
  }

  // Select best match from results
  const selected =
    results.length === 1 ? results[0] : findBestMatch(productName, results);

  if (!selected) {
    throw new Error("Selected product is undefined");
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
 * @param maxAttempts - Maximum number of retry attempts
 * @param initialWaitMs - Initial wait time before first retry
 * @returns Product result
 * @throws Error if all retry attempts fail
 */
async function fetchProductWithRetry(
  productName: string,
  maxAttempts = TIMING_CONFIG.MAX_RETRY_ATTEMPTS,
  initialWaitMs = TIMING_CONFIG.INITIAL_RETRY_WAIT_MS
): Promise<ProductResult> {
  let attempt = 0;
  let waitMs = initialWaitMs;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fetchProduct(productName);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      console.log(
        `Retry ${attempt}/${maxAttempts} for "${productName}" after ${Math.round(
          waitMs / 1000
        )}s`
      );

      await delay(waitMs);
      waitMs *= 2; // Exponential backoff
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
 * - bun index.ts --input products.txt --output results.csv --interval 8
 * - bun index.ts products.txt results.csv 8
 *
 * @returns Parsed CLI options
 */
function parseArgs(): CliOptions {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      input: "i",
      output: "o",
      interval: "t", // seconds
    },
    string: ["input", "output", "interval"],
    default: {
      input: "products.txt",
      output: "results.csv",
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

  return {
    input,
    output,
    intervalMs,
  };
}

// ============================================================================
// Main Execution
// ============================================================================

/**
 * Main execution flow:
 * 1. Parse command line arguments
 * 2. Read product names from input file
 * 3. Fetch each product with retries and pacing
 * 4. Write results to CSV
 */
async function main(): Promise<void> {
  const { input: inputFile, output: outputFile, intervalMs } = parseArgs();

  if (Number.isNaN(intervalMs) || intervalMs < 0) {
    console.error("Invalid interval (ms).");
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
        "Usage: bun index.ts [--input products.txt] [--output results.csv] [--interval seconds]"
      );
      process.exit(1);
    }
    throw error;
  }

  if (productNames.length === 0) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  console.log(`Processing ${productNames.length} products...`);

  // Fetch each product with retries and pacing
  const results: ProductResult[] = [];

  for (let i = 0; i < productNames.length; i++) {
    const productName = productNames[i];
    if (!productName) continue;

    try {
      const result = await fetchProductWithRetry(productName);
      results.push(result);

      const displayCode = result.prodRegCode || "(empty)";
      console.log(`${result.prodName},${displayCode}`);
    } catch (error) {
      console.log(`Failed for "${productName}" after retries: ${error}`);
    }

    // Wait between products (except after last one)
    if (i < productNames.length - 1) {
      await delay(intervalMs);
    }
  }

  // Write results to CSV
  const outputPath = path.resolve(outputFile);
  await writeCsv(results, outputPath);
  console.log(`\nWritten ${results.length} rows to ${outputPath}`);
}

// Run main function
main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
