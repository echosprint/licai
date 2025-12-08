# licai

Script to batch-fetch product names and registration codes from xinxipilu.chinawealth.com.cn via their signed API, writing results to CSV with retries and pacing.

## Prerequisites (install Bun)
- macOS: `curl -fsSL https://bun.sh/install | bash`
- Windows (PowerShell): `irm https://bun.sh/install.ps1 | iex`

## Setup
```bash
bun install
```

## Run
```bash
bun run index.ts --input products.txt --output results.csv --interval 8
# or positional: bun run index.ts products.txt results.csv 8
```
- `--input/-i`: text file, one product name per line (default: products.txt)
- `--output/-o`: CSV output path (default: results.csv)
- `--interval/-t`: seconds to wait between products (default: 8s)
- Script retries each product with exponential backoff (up to 5 attempts, starting at 8s).

## Notes
- The script signs requests using the site’s init data; no browser automation is used.
- Output CSV header: `prodName,prodRegCode`.
