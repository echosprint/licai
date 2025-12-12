# licai

Batch-fetch product names and registration codes from xinxipilu.chinawealth.com.cn via their signed API, writing results to CSV with intelligent search, retries, and pacing.

## Two Implementations

This project provides both **TypeScript** and **Bash** implementations:

### TypeScript Version (index.ts)

Production-ready implementation following TypeScript best practices with:

- ✅ **Intelligent fallback search**: If full name not found, tries first 8 characters
- ✅ **Similarity matching**: Finds best match using longest common prefix algorithm
- ✅ **Graceful handling**: Returns empty code for products not found (continues processing)
- ✅ **Retry logic**: Exponential backoff (up to 5 attempts)
- ✅ **Type safety**: Full TypeScript types, no `any` types
- ✅ **Comprehensive docs**: JSDoc documentation on all functions
- ✅ **Clean architecture**: Organized into logical sections (API, utilities, file I/O)

**Prerequisites:**

- macOS: `curl -fsSL https://bun.sh/install | bash`
- Windows (PowerShell): `irm https://bun.sh/install.ps1 | iex`

**Setup:**

```bash
bun install
```

**Run:**

```bash
bun run index.ts --input products.txt --output results.csv --interval 8
# or use scripts:
# bun start -- --input products.txt --output results.csv --interval 8
# bun run fetch -- products.txt results.csv 8
# positional form: bun run index.ts products.txt results.csv 8
```

**CLI Options:**

- `--input/-i`: text file, one product name per line (default: products.txt)
- `--output/-o`: CSV output path (default: results.csv)
- `--interval/-t`: seconds to wait between products (default: 8s)

**Features:**

1. **Search Flow:**
   - First tries full product name
   - If no results, waits and tries first 8 characters
   - If multiple results, uses similarity matching to find best match
   - If still no results, returns empty `prodRegCode` and continues

2. **Similarity Matching:**
   - Normalizes by removing special chars: `()（）""''""''`
   - Uses longest common prefix algorithm
   - Shorter names win ties

3. **Error Handling:**
   - Exponential backoff for rate limits (5 attempts, 8s → 16s → 32s...)
   - All products written to CSV (even if code is empty)
   - Detailed logging for debugging

### Bash Version (fetch_licai.sh)

Minimal implementation with hardcoded configuration constants.

**Prerequisites:**

- `curl`, `jq`, `openssl` (pre-installed on most Unix systems)

**Configuration:**

Edit constants at the top of `fetch_licai.sh`:

```bash
INPUT_FILE="products.txt"
OUTPUT_FILE="results.csv"
INTERVAL_SECONDS=8
```

**Run:**

```bash
./fetch_licai.sh
```

## Code Structure (TypeScript)

The TypeScript implementation (585 lines) is organized into clear sections:

1. **Type Definitions** (lines 6-81): All interfaces (`Product`, `ProductResult`, `ApiCredentials`, etc.)
2. **Constants** (lines 83-119): `API_CONFIG`, `TIMING_CONFIG`, `HTTP_HEADERS`
3. **Utility Functions** (lines 121-208): String normalization, similarity matching, delays
4. **API Functions** (lines 210-318): Get credentials, sign requests, search products
5. **Core Logic** (lines 320-415): Main fetch with fallback, retry wrapper
6. **File I/O** (lines 417-458): Read input, write CSV
7. **CLI Parsing** (lines 460-508): Parse command line arguments
8. **Main Execution** (lines 510-585): Orchestrate the entire process

All functions have JSDoc documentation explaining parameters, returns, and behavior.

## Technical Notes

- Both scripts sign requests using RSA-SHA256 with the site's public key
- No browser automation is used
- Output CSV header: `prodName,prodRegCode`
- TypeScript version handles products not found by returning empty `prodRegCode`
- Input file cleaned: trims whitespace, removes quotes (English & Chinese), removes all spaces
