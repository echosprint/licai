import { KJUR, KEYUTIL, hextob64 } from "jsrsasign";
import { promises as fs } from "fs";
import path from "path";
import minimist from "minimist";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Content-Type": "application/json;charset=UTF-8",
  Accept: "application/json, text/plain, */*",
  Referer: "https://xinxipilu.chinawealth.com.cn/",
};

type ProdListResponse = {
  code?: number | string;
  msg?: string;
  data?: { list?: any[]; total?: number };
};

type ProdRow = { prodName: string; prodRegCode: string }; // prodRegCode can be empty if not found

const DEFAULT_WAIT_BETWEEN_PRODUCTS_MS = 8000; // default gap between products
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_WAIT_MS = 8000;

// Remove special characters for similarity comparison
function normalizeForComparison(str: string): string {
  return str
    .replace(/[()（）]/g, "")
    .replace(/["""''']/g, "");
}

// Calculate longest common prefix length between two strings
function longestCommonPrefixLength(a: string, b: string): number {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  let i = 0;
  while (
    i < normalizedA.length &&
    i < normalizedB.length &&
    normalizedA[i] === normalizedB[i]
  ) {
    i++;
  }
  return i;
}

// Find the best matching product from multiple candidates
function findBestMatch(searchTerm: string, candidates: any[]): any {
  let bestMatch = candidates[0];
  let bestScore = longestCommonPrefixLength(searchTerm, bestMatch.prodName);

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const score = longestCommonPrefixLength(searchTerm, candidate.prodName);

    // Use longest prefix, or shorter name as tie-breaker
    if (
      score > bestScore ||
      (score === bestScore && candidate.prodName.length < bestMatch.prodName.length)
    ) {
      bestMatch = candidate;
      bestScore = score;
    }
  }

  return bestMatch;
}

// Fetch a single product by name via the signed API request.
async function fetchProduct(searchValue: string): Promise<ProdRow> {
  const initRes = await fetch(
    "https://xinxipilu.chinawealth.com.cn/lcxp-platService/product/getInitData",
    {
      method: "POST",
      headers,
      body: "{}",
    }
  );
  const initText = await initRes.text();
  let licenseStr: string | null = null;
  try {
    const parsed = JSON.parse(initText);
    licenseStr = parsed?.data ?? null;
  } catch {
  }
  const setCookie = initRes.headers.get("set-cookie");

  const url =
    "https://xinxipilu.chinawealth.com.cn/lcxp-platService/product/getProductList";

  // Helper function to perform API search with a given term
  const searchByTerm = async (term: string): Promise<any[]> => {
    const body = {
      prodName: term,
      prodRegCode: "",
      orgName: "",
      pageNum: 1,
      pageSize: 20,
      prodStatus: "",
      prodSpclAttr: "",
      prodInvestNature: "",
      prodOperateMode: "",
      prodRiskLevel: "",
      prodTermCode: "",
      actDaysStart: null,
      actDaysEnd: null,
    };

    const signature =
      licenseStr && typeof licenseStr === "string"
        ? (() => {
            try {
              const key = KEYUTIL.getKey(licenseStr);
              const sig = new KJUR.crypto.Signature({ alg: "SHA256withRSA" });
              sig.init(key);
              sig.updateString(JSON.stringify(body));
              return hextob64(sig.sign());
            } catch (e) {
              console.warn("sign failed", e);
              return null;
            }
          })()
        : null;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        ...(setCookie ? { Cookie: setCookie } : {}),
        ...(signature ? { signature } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as ProdListResponse;
    return json.data?.list ?? [];
  };

  // Try searching with full product name
  let results = await searchByTerm(searchValue);

  // If no results, try with first 8 characters
  if (results.length === 0) {
    const prefix = searchValue.slice(0, 8);
    console.log(
      `No results for full name, trying first 8 chars: "${prefix}"`
    );
    await delay(DEFAULT_WAIT_BETWEEN_PRODUCTS_MS); // Wait before retry with prefix
    results = await searchByTerm(prefix);

    if (results.length === 0) {
      console.log(
        `No products found for "${searchValue}" (tried full name and 8-char prefix), returning empty code`
      );
      return { prodName: searchValue, prodRegCode: "" };
    }
  }

  // Select best match from results
  const selected =
    results.length === 1 ? results[0] : findBestMatch(searchValue, results);

  const prodRegCode = selected?.prodRegCode ?? "";
  const prodName = selected?.prodName ?? searchValue;
  return { prodName, prodRegCode };
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry with exponential backoff to avoid transient 503/rate limits.
async function fetchProductWithRetry(
  name: string,
  maxAttempts = MAX_RETRY_ATTEMPTS,
  initialWaitMs = INITIAL_RETRY_WAIT_MS
): Promise<ProdRow> {
  let attempt = 0;
  let waitMs = initialWaitMs;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fetchProduct(name);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.log(
        `retry ${attempt}/${maxAttempts} for "${name}" after ${Math.round(
          waitMs / 1000
        )}s`
      );
      await delay(waitMs);
      waitMs *= 2;
    }
  }
  throw new Error(`Failed to fetch after ${maxAttempts} attempts`);
}

async function readLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .map((l) => l.replace(/^["'"']|["'"']$/g, "")) // Remove leading/trailing quotes (English & Chinese)
    .map((l) => l.trim()) // Trim again after removing quotes
    .map((l) => l.replace(/\s+/g, "")) // Remove all spaces
    .filter((l) => l.length > 0);
}

async function writeCsv(rows: ProdRow[], outputPath: string) {
  const header = "prodName,prodRegCode";
  const lines = rows.map((r) => `${r.prodName},${r.prodRegCode}`);
  const csv = [header, ...lines].join("\n");
  await fs.writeFile(outputPath, csv, "utf8");
}

type CliOptions = {
  input: string;
  output: string;
  intervalMs: number;
};

// Parse CLI flags/positionals.
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
      : DEFAULT_WAIT_BETWEEN_PRODUCTS_MS;

  return {
    input,
    output,
    intervalMs,
  };
}

// Main flow: read names -> fetch each with retries -> write CSV.
async function main() {
  const { input: inputFile, output: outputFile, intervalMs } = parseArgs();

  if (Number.isNaN(intervalMs) || intervalMs < 0) {
    console.error("Invalid interval (ms).");
    process.exit(1);
  }

  let names: string[];
  try {
    names = await readLines(inputFile);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.error(`Input file not found: ${inputFile}`);
      console.error(
        "Usage: bun index.ts [--input products.txt] [--output results.csv] [--interval seconds]"
      );
      process.exit(1);
    }
    throw err;
  }
  if (names.length === 0) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  const results: ProdRow[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (!name) continue;
    try {
      const row = await fetchProductWithRetry(name);
      results.push(row);
      const displayCode = row.prodRegCode || "(empty)";
      console.log(`${row.prodName},${displayCode}`);
    } catch (err) {
      console.log(`Failed for "${name}" after retries: ${err}`);
    }
    if (i < names.length - 1) {
      await delay(intervalMs || DEFAULT_WAIT_BETWEEN_PRODUCTS_MS);
    }
  }

  const outPath = path.resolve(outputFile);
  await writeCsv(results, outPath);
  console.log(`Written ${results.length} rows to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
