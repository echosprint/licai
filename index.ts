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
 * Custom error for API-related failures
 */
class ApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Custom error for search-related failures (triggers retry)
 */
class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
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
 * Product queue item tracking fetch status
 */
interface ProductQueueItem {
  name: string;
  attemptCount: number;
  triedFullName: boolean; // Whether we've already tried full name search
  status: "success" | "fail" | "pending";
}

/**
 * Command line arguments configuration
 */
interface CliOptions {
  input: string;
  output: string;
  verbose: boolean;
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
  MAX_RETRY_ATTEMPTS: 5,
  FALLBACK_SEARCH_PREFIX_LENGTH: 8,
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

/**
 * Global verbose flag for controlling log output
 */
let VERBOSE = false;

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  GRAY: "\x1b[90m",
  RESET: "\x1b[0m",
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
 * Log message only if verbose mode is enabled
 * Messages are displayed in gray color to distinguish from normal output
 * @param args - Messages to log
 */
function logVerbose(...args: (string | number | boolean)[]): void {
  if (VERBOSE) {
    console.log(`${COLORS.GRAY}%s${COLORS.RESET}`, args.join(" "));
  }
}

/**
 * Format progress counter with padding for vertical alignment.
 *
 * @param completed - Number of completed items
 * @param total - Total number of items
 * @returns Formatted progress string like "[  3/100]"
 */
function formatProgress(completed: number, total: number): string {
  const padding = String(total).length;
  return `[${String(completed).padStart(padding, " ")}/${total}]`;
}

/**
 * Log a product result with progress counter and color-coded status.
 *
 * @param completed - Number of completed items
 * @param total - Total number of items
 * @param result - Product result to log
 */
function logProductResult(completed: number, total: number, result: ProductResult): void {
  const displayCode = result.prodRegCode || "(empty)";
  const icon = result.prodRegCode
    ? `${COLORS.GREEN}✓${COLORS.RESET}`
    : `${COLORS.RED}✗${COLORS.RESET}`;
  const progress = formatProgress(completed, total);
  console.log(`${progress} ${icon} ${result.prodName},${displayCode}`);
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
 * @param credentials - API credentials for authentication
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
    throw new ApiError(
      `Request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const json = (await response.json()) as ProductListResponse;

  return json.data?.list ?? [];
}

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Fetch product information with intelligent fallback.
 *
 * Search Strategy:
 * 1. First attempt: Search with full product name
 * 2. If no results: Search with first 8 characters (prefix fallback)
 * 3. Find exact match: Single result or exact match from multiple results
 *
 * @param item - Queue item tracking search state
 * @param credentials - API credentials for authentication
 * @returns Product result (may have empty prodRegCode if not found)
 */
async function fetchProduct(
  item: ProductQueueItem,
  credentials: ApiCredentials
): Promise<ProductResult> {
  item.attemptCount++;

  // Step 1: Determine search term based on attempt history
  const searchTerm = determineSearchTerm(item);

  // Step 2: Search for products
  const results = await performSearch(searchTerm, item, credentials);

  // Step 3: Find exact match from results
  const match = findProductMatch(results, item);

  // Step 4: Return result
  if (!match) {
    item.status = "fail";
    logVerbose(`No exact match found for "${item.name}", returning empty code`);
    return { prodName: item.name, prodRegCode: "" };
  }

  item.status = "success";
  return {
    prodName: match.prodName,
    prodRegCode: match.prodRegCode ?? "",
  };
}

/**
 * Determine what search term to use based on previous attempts.
 *
 * @param item - Queue item with attempt history
 * @returns Search term (full name or prefix)
 */
function determineSearchTerm(item: ProductQueueItem): string {
  if (!item.triedFullName) {
    // First attempt: use full name
    return item.name;
  }

  // Fallback: use prefix
  const prefix = item.name.slice(0, TIMING_CONFIG.FALLBACK_SEARCH_PREFIX_LENGTH);
  logVerbose(
    `Trying prefix search (first ${TIMING_CONFIG.FALLBACK_SEARCH_PREFIX_LENGTH} chars): "${prefix}"`
  );
  return prefix;
}

/**
 * Perform search and handle empty results.
 * Throws error to trigger retry if appropriate.
 *
 * @param searchTerm - Term to search for
 * @param item - Queue item to update state
 * @param credentials - API credentials
 * @returns Array of matching products (may be empty)
 */
async function performSearch(
  searchTerm: string,
  item: ProductQueueItem,
  credentials: ApiCredentials
): Promise<Product[]> {
  const results = await searchProducts(searchTerm, credentials);

  // Handle empty results
  if (results.length === 0) {
    if (!item.triedFullName) {
      // Mark full name as tried and trigger retry with prefix
      item.triedFullName = true;
      logVerbose(`No results for full name "${item.name}", will retry with prefix`);
      throw new SearchError("Empty results for full name search");
    }

    // Both strategies failed - no retry needed
    item.status = "fail";
    logVerbose(
      `No products found for "${item.name}" (tried both full name and prefix)`
    );
  }

  return results;
}

/**
 * Find exact product match from search results.
 * Single result is accepted directly; multiple results require exact match after normalization.
 *
 * @param results - Products returned from search
 * @param item - Queue item with original product name
 * @returns Exact matching product or null if no match found
 */
function findProductMatch(results: Product[], item: ProductQueueItem): Product | null {
  if (results.length === 0) {
    return null;
  }

  // Always use exact match, even for single results
  const exactMatch = findExactMatch(item.name, results);
  if (!exactMatch) {
    logVerbose(`No exact match found for "${item.name}"`);
  }

  return exactMatch;
}

/**
 * Process product queue with retry logic.
 * Processes items with status="pending", retries on failure with exponential backoff.
 *
 * @param queue - Array of product queue items
 * @param credentials - API credentials for authentication
 * @param results - Map to store successful results
 */
async function processProductQueue(
  queue: ProductQueueItem[],
  credentials: ApiCredentials,
  results: Map<string, ProductResult>
): Promise<void> {
  const total = queue.length;
  let completed = 0;

  while (true) {
    // Find first pending item
    const item = queue.find(item => item.status === "pending");

    if (!item) {
      // No more pending items
      break;
    }

    try {
      const result = await fetchProduct(item, credentials);

      // fetchProduct already set status to success, just store result
      results.set(item.name, result);
      completed++;
      logProductResult(completed, total, result);

    } catch (error) {
      // fetchProduct already incremented attemptCount
      if (item.attemptCount >= TIMING_CONFIG.MAX_RETRY_ATTEMPTS) {
        // Max attempts reached - mark as failed
        item.status = "fail";
        const failedResult: ProductResult = { prodName: item.name, prodRegCode: "" };
        results.set(item.name, failedResult);
        completed++;
        logVerbose(`Failed for "${item.name}" after ${item.attemptCount} attempts`);
        logProductResult(completed, total, failedResult);
      } else {
        // Retry with exponential backoff
        const backoffMs = 1000 * Math.pow(2, item.attemptCount - 1);
        logVerbose(`Retry ${item.attemptCount}/${TIMING_CONFIG.MAX_RETRY_ATTEMPTS} for "${item.name}" (waiting ${backoffMs / 1000}s)`);
        await delay(backoffMs);
        // Item stays in queue with status="pending" for next iteration
      }
    }
  }
}

// ============================================================================
// File I/O Functions
// ============================================================================

/**
 * Validate product name meets basic requirements.
 *
 * @param name - Product name to validate
 * @returns True if valid, false otherwise
 */
function isValidProductName(name: string): boolean {
  // Must be non-empty after trimming
  if (!name || name.trim().length === 0) {
    return false;
  }

  // Must not be too long (reasonable limit)
  if (name.length > 200) {
    return false;
  }

  // Must contain at least one non-whitespace character
  return /\S/.test(name);
}

/**
 * Read and parse product names from input file.
 * Cleans up lines by:
 * - Trimming whitespace
 * - Removing quotes (English & Chinese)
 * - Removing all spaces
 * - Filtering invalid names
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
    .filter((line) => line.length > 0 && isValidProductName(line));
}

/**
 * Escape CSV field value if it contains special characters.
 * Wraps field in quotes and escapes internal quotes.
 *
 * @param value - Field value to escape
 * @returns Escaped CSV field
 */
function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
  const lines = rows.map((row) =>
    `${escapeCsvField(row.prodName)},${escapeCsvField(row.prodRegCode)}`
  );
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
 * - bun index.ts (uses defaults: products.txt, results.csv)
 * - bun index.ts --input products.txt --output results.csv
 * - bun index.ts --verbose (enables detailed logging)
 *
 * @returns Parsed CLI options
 */
function parseArgs(): CliOptions {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      input: "i",
      output: "o",
      verbose: "v",
    },
    string: ["input", "output"],
    boolean: ["verbose"],
    default: {
      input: "products.txt",
      output: "results.csv",
      verbose: false,
    },
  });

  const positional = argv._;

  const input =
    (positional[0] ? String(positional[0]) : argv.input) ?? "products.txt";
  const output =
    (positional[1] ? String(positional[1]) : argv.output) ?? "results.csv";
  const verbose = argv.verbose ?? false;

  return {
    input,
    output,
    verbose,
  };
}

// ============================================================================
// Main Execution
// ============================================================================

/**
 * Load and validate product names from input file.
 *
 * @param filePath - Path to input file
 * @returns Array of product names
 */
async function loadProductNames(filePath: string): Promise<string[]> {
  try {
    const productNames = await readLines(filePath);

    if (productNames.length === 0) {
      console.error("Input file is empty.");
      process.exit(1);
    }

    return productNames;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.error(`Input file not found: ${filePath}`);
      console.error(
        "Usage: bun index.ts [--input products.txt] [--output results.csv]"
      );
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Fetch and validate API credentials.
 *
 * @returns Validated API credentials
 */
async function fetchCredentials(): Promise<ApiCredentials> {
  logVerbose("Fetching API credentials...");
  const credentials = await getApiCredentials();

  if (!credentials.publicKey || !credentials.cookie) {
    console.error("Failed to get API credentials");
    process.exit(1);
  }

  return credentials;
}

/**
 * Initialize product queue with all items in pending state.
 *
 * @param productNames - Array of product names to process
 * @returns Initialized queue
 */
function initializeQueue(productNames: string[]): ProductQueueItem[] {
  return productNames.map(name => ({
    name,
    attemptCount: 0,
    triedFullName: false,
    status: "pending",
  }));
}

/**
 * Convert results map to ordered array matching input order.
 *
 * @param productNames - Original product names in order
 * @param resultsMap - Map of product name to result
 * @returns Ordered array of results
 */
function orderResults(
  productNames: string[],
  resultsMap: Map<string, ProductResult>
): ProductResult[] {
  return productNames.map(name =>
    resultsMap.get(name) || { prodName: name, prodRegCode: "" }
  );
}

/**
 * Count successful and failed results.
 *
 * @param results - Array of product results
 * @returns Object with success and failure counts
 */
function countResults(results: ProductResult[]): { successCount: number; failedCount: number } {
  let successCount = 0;
  let failedCount = 0;

  for (const result of results) {
    if (result.prodRegCode) {
      successCount++;
    } else {
      failedCount++;
    }
  }

  return { successCount, failedCount };
}

/**
 * Format elapsed time in human-readable format.
 *
 * @param startTime - Start timestamp in milliseconds
 * @returns Formatted time string (e.g., "2m 30s" or "45s")
 */
function formatElapsedTime(startTime: number): string {
  const elapsedMs = Date.now() - startTime;
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Print execution summary with statistics.
 *
 * @param productNames - Original product names
 * @param results - Final results array
 * @param queue - Processed queue with statistics
 * @param elapsedTime - Formatted elapsed time string
 */
function printSummary(
  productNames: string[],
  results: ProductResult[],
  queue: ProductQueueItem[],
  elapsedTime: string
): void {
  const { successCount, failedCount } = countResults(results);
  const successItems = queue.filter(item => item.status === "success").length;
  const failedItems = queue.filter(item => item.status === "fail").length;
  const totalAttempts = queue.reduce((sum, item) => sum + item.attemptCount, 0);

  console.log(`\n📊 Summary:`);
  console.log(`   Total products: ${productNames.length}`);
  console.log(`   ${COLORS.GREEN}✓${COLORS.RESET} Successfully fetched: ${successCount}`);
  console.log(`   ${COLORS.RED}✗${COLORS.RESET} Failed (empty code): ${failedCount}`);

  console.log(`\n📋 Queue Statistics:`);
  console.log(`   Success: ${successItems}`);
  console.log(`   Failed: ${failedItems}`);
  console.log(`   Total attempts: ${totalAttempts}`);
  console.log(`   ⏱️  Total time: ${elapsedTime}`);
}

/**
 * Main execution flow:
 * 1. Parse arguments and load input
 * 2. Fetch API credentials
 * 3. Initialize and process queue
 * 4. Write results to CSV
 * 5. Print summary
 */
async function main(): Promise<void> {
  const startTime = Date.now();
  const { input: inputFile, output: outputFile, verbose } = parseArgs();

  // Set global verbose flag
  VERBOSE = verbose;

  // Step 1: Load and validate input
  const productNames = await loadProductNames(inputFile);
  logVerbose(`Processing ${productNames.length} products with queue-based retry logic...\n`);

  // Step 2: Fetch API credentials
  const credentials = await fetchCredentials();

  // Step 3: Initialize and process queue
  const queue = initializeQueue(productNames);
  const resultsMap = new Map<string, ProductResult>();
  await processProductQueue(queue, credentials, resultsMap);

  // Step 4: Order results and write to CSV
  const results = orderResults(productNames, resultsMap);
  const outputPath = path.resolve(outputFile);
  await writeCsv(results, outputPath);
  console.log(`\n--- Written ${results.length} products to ${outputPath} ---`);

  // Step 5: Print execution summary
  const elapsedTime = formatElapsedTime(startTime);
  printSummary(productNames, results, queue, elapsedTime);
}

// Run main function
main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
