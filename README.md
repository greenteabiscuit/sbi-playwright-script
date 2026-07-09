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

## Output

Downloaded PDFs are written under `downloads/`, with a JSONL manifest under `downloads/`.

## Security Notes

The repository intentionally ignores local browser profiles, downloaded PDFs, snapshots, manifests, dependencies, and `.env` files. Review `git status` before pushing so no account records or session data are staged.
