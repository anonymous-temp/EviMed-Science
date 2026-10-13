#!/usr/bin/env python3
"""Read a PDF: its text by page, where a phrase occurs, its tables (to Excel or CSV), and what a page looks like.

    pdf_tool.py info report.pdf
    pdf_tool.py text report.pdf --pages 1-3,7
    pdf_tool.py find report.pdf "net revenue"
    pdf_tool.py tables report.pdf --page 5 --xlsx table-p5.xlsx
    pdf_tool.py render report.pdf --pages 5 --out-dir pages-5

A PDF has no table object, only positioned words and ruling lines; `tables` recovers rows and
columns from them (ruled tables first, then alignment of the words) and shows what it found so the
result can be checked against the page image before it is used. A scanned PDF holds pictures, not
text: `info` shows pages without a text layer, and those need OCR, which is not part of this tool.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
import office_kit  # noqa: E402


def page_numbers(spec: str | None, total: int) -> list[int]:
    if not spec or spec == "all":
        return list(range(1, total + 1))
    chosen: list[int] = []
    for part in spec.split(","):
        low, _, high = part.strip().partition("-")
        chosen += range(int(low), int(high or low) + 1)
    bad = [n for n in chosen if not 1 <= n <= total]
    if bad:
        raise SystemExit(json.dumps({"ok": False, "error": f"the PDF has {total} pages; no page {bad[0]}"}))
    return chosen


def cmd_info(args: argparse.Namespace) -> int:
    with pdfplumber.open(args.file) as pdf:
        pages = pdf.pages
        counts = [len(page.chars) for page in pages]
        print(json.dumps({"file": args.file.name, "pages": len(pages), "metadata": {k: str(v) for k, v in (pdf.metadata or {}).items() if k in ("Title", "Author", "CreationDate")},
                          "page_size_pt": [round(float(pages[0].width)), round(float(pages[0].height))] if pages else None,
                          "pages_without_text_layer": [i for i, c in enumerate(counts, 1) if c == 0]}, ensure_ascii=False))
    return 0


def cmd_text(args: argparse.Namespace) -> int:
    with pdfplumber.open(args.file) as pdf:
        for number in page_numbers(args.pages, len(pdf.pages)):
            text = pdf.pages[number - 1].extract_text(layout=args.layout) or ""
            print(f"===== page {number} =====")
            print(text)
    return 0


def cmd_find(args: argparse.Namespace) -> int:
    pattern = re.compile(re.escape(args.text), re.IGNORECASE)
    hits = 0
    with pdfplumber.open(args.file) as pdf:
        for number, page in enumerate(pdf.pages, 1):
            lines = (page.extract_text() or "").splitlines()
            for line in lines:
                if pattern.search(line):
                    hits += 1
                    print(f"page {number}: {line.strip()[:160]}")
    print(f"{hits} line(s)")
    return 0 if hits else 2


STRATEGIES = {
    "lines": {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
    "text": {"vertical_strategy": "text", "horizontal_strategy": "text"},
}


def extract_tables(page, strategy: str) -> list[list[list[str]]]:
    order = ["lines", "text"] if strategy == "auto" else [strategy]
    for name in order:
        found = [[[(cell or "").replace("\n", " ").strip() for cell in row] for row in table] for table in page.extract_tables(STRATEGIES[name])]
        found = [t for t in found if len(t) >= 2 and max(len(r) for r in t) >= 2]
        if found:
            return found
    return []


NUMBER = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?$")


def as_cell(value: str, numbers: bool):
    return float(value) if numbers and NUMBER.match(value) and "." in value else int(value) if numbers and NUMBER.match(value) else value


def cmd_tables(args: argparse.Namespace) -> int:
    with pdfplumber.open(args.file) as pdf:
        pages = page_numbers(args.page, len(pdf.pages))
        found = [(n, table) for n in pages for table in extract_tables(pdf.pages[n - 1], args.strategy)]
    for index, (number, table) in enumerate(found, 1):
        print(f"--- table {index} (page {number}): {len(table)} rows x {max(len(r) for r in table)} columns")
        for row in table[: args.show]:
            print(" | ".join(row))
    if not found:
        print("no table found; try --strategy text, or read the page text")
        return 2
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as handle:
            csv.writer(handle).writerows(found[0][1])
    if args.xlsx:
        import xlsxwriter

        book = xlsxwriter.Workbook(str(args.xlsx))
        for index, (number, table) in enumerate(found, 1):
            sheet = book.add_worksheet(f"p{number}_t{index}"[:31])
            for r, row in enumerate(table):
                for c, value in enumerate(row):
                    cell = as_cell(value, args.numbers)
                    sheet.write_number(r, c, cell) if isinstance(cell, (int, float)) else sheet.write_string(r, c, cell)
        book.close()
    print(json.dumps({"ok": True, "tables": len(found), **({"xlsx": str(args.xlsx)} if args.xlsx else {}), **({"csv": str(args.csv)} if args.csv else {})}))
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    try:
        manifest = office_kit.render(args.file, args.out_dir, args.pages or "all", args.dpi)
    except (office_kit.KitError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "pages": [image["path"] for image in manifest.get("images", [])]}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    info = sub.add_parser("info", help="page count, metadata, pages with no text layer")
    info.add_argument("file", type=Path)
    text = sub.add_parser("text", help="text of the chosen pages, page by page")
    text.add_argument("file", type=Path)
    text.add_argument("--pages", help="e.g. 1-3,7 (default all)")
    text.add_argument("--layout", action="store_true", help="keep the horizontal layout of the page")
    find = sub.add_parser("find", help="lines that contain a phrase, with page numbers")
    find.add_argument("file", type=Path)
    find.add_argument("text")
    tables = sub.add_parser("tables", help="tables of the chosen pages; --xlsx / --csv writes them out")
    tables.add_argument("file", type=Path)
    tables.add_argument("--page", help="e.g. 5 or 5-7 (default all)")
    tables.add_argument("--strategy", choices=["auto", "lines", "text"], default="auto")
    tables.add_argument("--xlsx", type=Path, help="one sheet per table")
    tables.add_argument("--csv", type=Path, help="the first table as CSV")
    tables.add_argument("--numbers", action="store_true", help="write plain numbers as numbers (everything else stays text exactly as printed)")
    tables.add_argument("--show", type=int, default=12, help="rows to print per table")
    render = sub.add_parser("render", help="PNG images of pages (through the bundled LibreOffice Kit)")
    render.add_argument("file", type=Path)
    render.add_argument("--pages", help="e.g. 1,3 (default all)")
    render.add_argument("--out-dir", type=Path, required=True, help="a directory that does not exist yet")
    render.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args()
    return {"info": cmd_info, "text": cmd_text, "find": cmd_find, "tables": cmd_tables, "render": cmd_render}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
