# licai

Script to batch-fetch product names and registration codes from xinxipilu.chinawealth.com.cn via their signed API, writing results to CSV with retries and pacing.

## Two Implementations

This project provides both **TypeScript** and **Bash** implementations:

### TypeScript Version (index.ts)

Full-featured with retry logic, flexible CLI arguments, and exponential backoff.

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

**Options:**

- `--input/-i`: text file, one product name per line (default: products.txt)
- `--output/-o`: CSV output path (default: results.csv)
- `--interval/-t`: seconds to wait between products (default: 8s)
- Retries each product with exponential backoff (up to 5 attempts, starting at 8s)

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

## Notes

- Both scripts sign requests using RSA-SHA256 with the site's public key
- No browser automation is used
- Output CSV header: `prodName,prodRegCode`
