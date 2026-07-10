#!/usr/bin/env python3
"""Extract a sanitized transaction table from SBI report PDFs.

This script intentionally uses an allowlist output schema and never writes or
prints raw PDF text. Diagnostics include filenames and counts only.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

try:
    import pdfplumber
except ImportError as exc:
    raise SystemExit(
        "Missing dependency: pdfplumber. Install with "
        "`python3 -m pip install -r requirements-analysis.txt`."
    ) from exc


OUTPUT_FIELDS = [
    "source_pdf_sha256",
    "source_file",
    "report_date_from_filename",
    "report_type_from_filename",
    "trade_date",
    "settlement_date",
    "asset_name",
    "side",
    "quantity",
    "unit_price",
    "gross_amount",
    "account_type",
    "currency",
    "parser_status",
]

SIDE_MAP = {
    "買": "BUY",
    "売": "SELL",
}

AMOUNT_RE = re.compile(
    r"^(?:(?P<name>.*?)\s+)?"
    r"(?P<qty>[0-9][0-9,]*)\s+"
    r"(?P<unit>[0-9][0-9,]*(?:\.[0-9]+)?)\s+"
    r"(?P<amount>[0-9][0-9,]*)$"
)

DATE_RE = re.compile(r"(?P<year>20[0-9]{2})年\s*(?P<month>[0-9]{1,2})月\s*(?P<day>[0-9]{1,2})日")

FILENAME_RE = re.compile(r"^(?P<date>[0-9]{4}_[0-9]{2}_[0-9]{2})-(?P<type>.+?)-")


@dataclass(frozen=True)
class ParsedRow:
    source_pdf_sha256: str
    source_file: str
    report_date_from_filename: str
    report_type_from_filename: str
    trade_date: str
    settlement_date: str
    asset_name: str
    side: str
    quantity: int | None
    unit_price: float | None
    gross_amount: int | None
    account_type: str
    currency: str
    parser_status: str


def normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).replace("−", "-").replace("△", "-")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_asset_name(value: str) -> str:
    text = normalize(value)
    text = re.sub(r"^\d{3}\s+\d+\s+\d+\s+", "", text)
    text = re.sub(r"(?:20[0-9]{2}年\s*[0-9]{1,2}月\s*[0-9]{1,2}日\s*){1,2}", "", text)
    text = re.sub(r"\s+", "", text).strip()
    text = re.sub(r"^[,.\-:;]+|[,.\-:;]+$", "", text)
    return text


def is_noise_line(line: str) -> bool:
    return bool(
        re.search(
            r"^(自動|株式 取引報告書|取引報告書|作成日|特定口座|単価は|決算日|"
            r"市場:|以下余白|◎|[0-9]{10,}|あたり|1万口|様$|[0-9]+/[ 0-9]+ページ)",
            line,
        )
    )


def account_type(after_text: str) -> str:
    if "NISAつみたて投資枠" in after_text:
        return "NISAつみたて投資枠"
    if "NISA成長投資枠" in after_text:
        return "NISA成長投資枠"
    if "特定区分:特定対象" in after_text or "特定" in after_text:
        return "特定"
    return ""


def parse_two_dates(lines: list[str], start_index: int) -> tuple[str, str]:
    for idx in range(start_index, max(-1, start_index - 8), -1):
        dates = [
            f"{m.group('year')}-{int(m.group('month')):02d}-{int(m.group('day')):02d}"
            for m in DATE_RE.finditer(lines[idx])
        ]
        if len(dates) >= 2:
            return dates[-2], dates[-1]
        if len(dates) == 1:
            return dates[0], ""
    return "", ""


def filename_metadata(path: Path) -> tuple[str, str]:
    match = FILENAME_RE.match(path.name)
    if not match:
        return "", ""
    return match.group("date").replace("_", "-"), match.group("type")


def extract_lines(path: Path) -> list[str]:
    with pdfplumber.open(path) as pdf:
        text = "\n".join(
            (page.extract_text(x_tolerance=1, y_tolerance=3) or "")
            for page in pdf.pages
        )
    return [normalize(line).strip() for line in text.splitlines() if normalize(line).strip()]


def parse_trade_rows(path: Path) -> tuple[list[ParsedRow], int]:
    pdf_hash = sha256_file(path)
    report_date, report_type = filename_metadata(path)
    lines = extract_lines(path)
    rows: list[ParsedRow] = []
    failed_rows = 0

    for side_index, side_marker in enumerate(lines):
        if side_marker not in SIDE_MAP:
            continue

        amount_index = None
        amount_match = None
        for idx in range(side_index - 1, max(-1, side_index - 8), -1):
            match = AMOUNT_RE.match(lines[idx])
            if match:
                amount_index = idx
                amount_match = match
                break

        if amount_index is None or amount_match is None:
            failed_rows += 1
            continue

        name_parts: list[str] = []
        if amount_match.group("name"):
            name_parts.append(amount_match.group("name"))
        else:
            for idx in range(amount_index - 1, max(-1, amount_index - 5), -1):
                if not is_noise_line(lines[idx]):
                    name_parts.insert(0, lines[idx])
                    break

        for idx in range(amount_index + 1, side_index):
            if not is_noise_line(lines[idx]) and not AMOUNT_RE.match(lines[idx]):
                name_parts.append(lines[idx])

        asset_name = clean_asset_name("".join(name_parts))
        if not asset_name:
            failed_rows += 1
            continue

        trade_date, settlement_date = parse_two_dates(lines, amount_index)
        after_text = " ".join(lines[side_index + 1 : side_index + 6])

        rows.append(
            ParsedRow(
                source_pdf_sha256=pdf_hash,
                source_file=path.name,
                report_date_from_filename=report_date,
                report_type_from_filename=report_type,
                trade_date=trade_date,
                settlement_date=settlement_date,
                asset_name=asset_name,
                side=SIDE_MAP[side_marker],
                quantity=int(amount_match.group("qty").replace(",", "")),
                unit_price=float(amount_match.group("unit").replace(",", "")),
                gross_amount=int(amount_match.group("amount").replace(",", "")),
                account_type=account_type(after_text),
                currency="JPY",
                parser_status="parsed",
            )
        )

    return rows, failed_rows


def iter_pdfs(input_dir: Path, year: str | None) -> list[Path]:
    pdfs = sorted(input_dir.rglob("*.pdf"))
    if year:
        pdfs = [path for path in pdfs if path.name.startswith(f"{year}_")]
    return pdfs


def write_csv(path: Path, rows: list[ParsedRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: getattr(row, field) for field in OUTPUT_FIELDS})


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract sanitized SBI transaction rows from local PDFs.")
    parser.add_argument("--input-dir", type=Path, default=Path("downloads/2018-2026"))
    parser.add_argument("--output", type=Path, default=Path("analysis-output/sanitized_transactions.csv"))
    parser.add_argument("--year", help="Optional filename year filter, e.g. 2024")
    args = parser.parse_args()

    pdfs = iter_pdfs(args.input_dir, args.year)
    rows: list[ParsedRow] = []
    failed_files = 0
    failed_rows = 0

    for pdf_path in pdfs:
        try:
            parsed, failures = parse_trade_rows(pdf_path)
            rows.extend(parsed)
            failed_rows += failures
        except Exception:
            failed_files += 1

    write_csv(args.output, rows)
    print(
        "sanitized extraction complete: "
        f"pdfs_scanned={len(pdfs)} rows_written={len(rows)} "
        f"failed_files={failed_files} failed_rows={failed_rows} output={args.output}"
    )
    return 0 if failed_files == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
