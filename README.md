# sbi-playwright-script

Playwright automation for downloading SBI Securities electronic-delivery PDF reports after a user manually logs in.

The script does not ask for credentials. It launches a persistent local Chromium profile, opens SBI's electronic-delivery page, and waits for the user to complete login in the browser.

## Install

```bash
npm install
```

## Run

Download currently visible reports in the SBI report viewer:

```bash
SBI_INSPECT_ONLY=1 SBI_VIEWER=1 SBI_DOWNLOAD_VISIBLE=1 npm start
```

Filter by delivery date before downloading:

```bash
SBI_INSPECT_ONLY=1 \
SBI_VIEWER=1 \
SBI_FILTER_FROM=2024/01/01 \
SBI_FILTER_TO=2024/12/31 \
SBI_DOWNLOAD_VISIBLE=1 \
npm start
```

Download records exposed by SBI's legacy viewer:

```bash
SBI_INSPECT_ONLY=1 \
SBI_VIEWER=1 \
SBI_LEGACY=1 \
SBI_LEGACY_DOWNLOAD_VISIBLE=1 \
SBI_FROM_YEAR=2018 \
SBI_TO_YEAR=2026 \
npm start
```

## Output

Downloaded PDFs are written under `downloads/`, with a JSONL manifest under `downloads/`.

## Sanitized Analysis

Install the PDF parsing dependency:

```bash
python3 -m pip install -r requirements-analysis.txt
```

Extract an allowlisted transaction CSV without printing raw PDF text:

```bash
python3 scripts/extract_sanitized_transactions.py \
  --input-dir downloads/2018-2026 \
  --year 2024 \
  --output analysis-output/sanitized_transactions_2024.csv
```

The extractor writes only deterministic transaction fields such as dates, asset name, side, quantity, unit price, gross amount, account type, currency, source filename, and source PDF hash. It does not write account-holder names, account numbers, raw PDF text, browser data, or snapshots.

## Security Notes

The repository intentionally ignores local browser profiles, downloaded PDFs, snapshots, manifests, analysis output, dependencies, and `.env` files. Review `git status` before pushing so no account records or session data are staged.
