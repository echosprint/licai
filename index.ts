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
 * Product queue item tracking fetch status
 */
interface ProductQueueItem {
  name: string;
  attemptCount: number;
  triedFullName: boolean; // Whether we've already tried full name search
  success: true | false | null; // true = success, false = fail, null = pending
}

/**
 * Command line arguments configuration
 */
interface CliOptions {
  input: string;
  output: string;
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
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
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
 * Flow:
 * 1. Search with full product name (if not already tried)
 * 2. If no results, try with first 8 characters
 * 3. If multiple results, use exact matching to find best match
 *
 * @param item - Queue item tracking search state
 * @param credentials - API credentials for authentication
 * @returns Product result (may have empty prodRegCode if not found)
 */
async function fetchProduct(
  item: ProductQueueItem,
  credentials: ApiCredentials
): Promise<ProductResult> {

  // Increment attempt count once per call
  item.attemptCount++;

  let results: Product[] = [];

  // If haven't tried full name yet, only search with full name
  if (!item.triedFullName) {
    try {
      results = await searchProducts(item.name, credentials);

      // If empty, mark as tried and throw to re-queue for prefix search
      if (results.length === 0) {
        item.triedFullName = true;
        console.log(`No results for full name "${item.name}", will retry with prefix`);
        throw new Error("Empty results for full name search");
      }
    } catch (error) {
      // Re-throw for retry
      throw error;
    }
  } else {
    // Already tried full name, now try prefix fallback
    const prefixLength = TIMING_CONFIG.FALLBACK_SEARCH_PREFIX_LENGTH;
    const prefix = item.name.slice(0, prefixLength);
    console.log(
      `Trying prefix search (first ${prefixLength} chars): "${prefix}"`
    );

    try {
      results = await searchProducts(prefix, credentials);

      if (results.length === 0) {
        // Both full name and prefix failed - mark as failed
        item.success = false;
        console.log(
          `No products found for "${item.name}" (tried both full name and prefix), returning empty code`
        );
        return { prodName: item.name, prodRegCode: "" };
      }
    } catch (error) {
      // Re-throw for retry
      throw error;
    }
  }

  // Find exact match from results
  const selected = results.length === 1 ? results[0] : findExactMatch(item.name, results);

  if (!selected) {
    // No exact match - mark as failed
    item.success = false;
    console.log(`No exact match found for "${item.name}", returning empty code`);
    return { prodName: item.name, prodRegCode: "" };
  }

  // Successfully found product
  item.success = true;
  return {
    prodName: selected.prodName,
    prodRegCode: selected.prodRegCode ?? "",
  };
}

/**
 * Process product queue with retry logic.
 * Processes items with success=null, retries on failure with exponential backoff.
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
  while (true) {
    // Find first pending item (success = null)
    const item = queue.find(item => item.success === null);

    if (!item) {
      // No more pending items
      break;
    }

    try {
      const result = await fetchProduct(item, credentials);

      // fetchProduct already set success = true, just store result
      results.set(item.name, result);

      const displayCode = result.prodRegCode || "(empty)";
      console.log(`✓ ${result.prodName},${displayCode}`);

    } catch (error) {
      // fetchProduct already incremented attemptCount
      if (item.attemptCount >= TIMING_CONFIG.MAX_RETRY_ATTEMPTS) {
        // Max attempts reached - mark as failed
        item.success = false;
        results.set(item.name, { prodName: item.name, prodRegCode: "" });
        console.log(`✗ Failed for "${item.name}" after ${item.attemptCount} attempts`);
      } else {
        // Retry with exponential backoff
        const backoffMs = 1000 * Math.pow(2, item.attemptCount - 1);
        console.log(`Retry ${item.attemptCount}/${TIMING_CONFIG.MAX_RETRY_ATTEMPTS} for "${item.name}" (waiting ${backoffMs / 1000}s)`);
        await delay(backoffMs);
        // Item stays in queue with success=null for next iteration
      }
    }
  }
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
 * - bun index.ts (uses defaults: products.txt, results.csv)
 * - bun index.ts --input products.txt --output results.csv
 *
 * @returns Parsed CLI options
 */
function parseArgs(): CliOptions {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      input: "i",
      output: "o",
    },
    string: ["input", "output"],
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

  return {
    input,
    output,
  };
}

// ============================================================================
// Main Execution
// ============================================================================

/**
 * Main execution flow:
 * 1. Parse command line arguments
 * 2. Read product names from input file
 * 3. Fetch API credentials once
 * 4. Initialize product queue with all items
 * 5. Process queue with smart retry logic (exponential backoff, stateful retries)
 * 6. Write results to CSV
 */
async function main(): Promise<void> {
  // Start timer
  const startTime = Date.now();

  const { input: inputFile, output: outputFile } = parseArgs();

  // Read product names from input file
  let productNames: string[];
  try {
    productNames = await readLines(inputFile);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.error(`Input file not found: ${inputFile}`);
      console.error(
        "Usage: bun index.ts [--input products.txt] [--output results.csv]"
      );
      process.exit(1);
    }
    throw error;
  }

  if (productNames.length === 0) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  console.log(`Processing ${productNames.length} products with queue-based retry logic...\n`);

  // Get API credentials once for all requests
  console.log("Fetching API credentials...");
  const credentials = await getApiCredentials();

  if (!credentials.publicKey || !credentials.cookie) {
    console.error("Failed to get API credentials");
    process.exit(1);
  }

  // Initialize product queue
  const queue: ProductQueueItem[] = productNames.map(name => ({
    name,
    attemptCount: 0,
    triedFullName: false,
    success: null,
  }));

  // Process queue with retry logic
  const resultsMap = new Map<string, ProductResult>();
  await processProductQueue(queue, credentials, resultsMap);

  // Convert map to array preserving original order
  const results: ProductResult[] = productNames.map(name =>
    resultsMap.get(name) || { prodName: name, prodRegCode: "" }
  );

  // Count successes and failures
  let successCount = 0;
  let failedCount = 0;
  for (const result of results) {
    if (result.prodRegCode) {
      successCount++;
    } else {
      failedCount++;
    }
  }

  // Write results to CSV
  const outputPath = path.resolve(outputFile);
  await writeCsv(results, outputPath);
  console.log(`\n✓ Written ${results.length} rows to ${outputPath}`);

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

  // Show queue statistics
  const successItems = queue.filter(item => item.success === true).length;
  const failedItems = queue.filter(item => item.success === false).length;
  console.log(`\n📋 Queue Statistics:`);
  console.log(`   Success: ${successItems}`);
  console.log(`   Failed: ${failedItems}`);
  console.log(`   Total attempts: ${queue.reduce((sum, item) => sum + item.attemptCount, 0)}`);
  console.log(`   ⏱️  Total time: ${timeDisplay}`);
}

// Run main function
main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
