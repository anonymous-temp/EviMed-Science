#!/usr/bin/env python3
"""Tables out of every page of each PDF with pdfplumber, three ways, untuned.

    python3 -I run_pdfplumber.py <pdf-dir> <out.json> [pmcid ...]

``lines``: ``page.extract_tables()`` with its default settings (ruling lines make the cells). ``text``: the same call with both strategies
set to ``text`` (the alignment of the words makes the cells). ``gaps``: no table detection at all, the layout text of the page cut into
cells wherever two or more spaces separate words, which is what a pipeline without a table finder does. None of them is tuned to any paper.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import pdfplumber

TEXT = {"vertical_strategy": "text", "horizontal_strategy": "text"}


def clean(cell):
    return re.sub(r"\s+", " ", cell).strip() if isinstance(cell, str) else ""


def main(argv):
    pdf_dir, out = Path(argv[1]), Path(argv[2])
    only = set(argv[3:])
    result = {}
    for pdf in sorted(pdf_dir.glob("PMC*.pdf")):
        pmcid = pdf.stem
        if only and pmcid not in only:
            continue
        started = time.time()
        entry = {"lines": [], "text": [], "gaps": []}
        try:
            with pdfplumber.open(str(pdf)) as document:
                for number, page in enumerate(document.pages, start=1):
                    for name, settings in (("lines", None), ("text", TEXT)):
                        try:
                            tables = page.extract_tables(settings) if settings else page.extract_tables()
                        except Exception as error:  # noqa: BLE001 - one page that pdfplumber cannot do is recorded, the rest goes on
                            entry.setdefault("errors", []).append("%s p%d %s" % (name, number, type(error).__name__))
                            continue
                        for table in tables:
                            entry[name].append({"page": number, "grid": [[clean(c) for c in row] for row in table]})
                    try:
                        layout = page.extract_text(layout=True) or ""
                    except Exception as error:  # noqa: BLE001
                        entry.setdefault("errors", []).append("gaps p%d %s" % (number, type(error).__name__))
                        continue
                    rows = [[c for c in re.split(r"\s{2,}", line.strip()) if c] for line in layout.splitlines() if line.strip()]
                    entry["gaps"].append({"page": number, "grid": rows})
        except Exception as error:  # noqa: BLE001
            entry["fatal"] = type(error).__name__
        entry["seconds"] = round(time.time() - started, 1)
        result[pmcid] = entry
        print(pmcid, {k: len(v) for k, v in entry.items() if isinstance(v, list)}, entry["seconds"], "s", flush=True)
    out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv)
