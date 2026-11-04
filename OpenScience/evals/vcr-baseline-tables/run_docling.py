#!/usr/bin/env python3
"""Docling (CPU, no OCR: the PDFs carry a text layer) on each PDF; its Markdown is what is scored.

    python3 -I run_docling.py <pdf-dir> <out-dir> [pmcid ...]

One converter, the layout model and TableFormer on the CPU, ``do_ocr`` off. A failure is written down as it is and the run goes on.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption


def main(argv):
    pdf_dir, out_dir = Path(argv[1]), Path(argv[2])
    only = set(argv[3:])
    out_dir.mkdir(parents=True, exist_ok=True)
    options = PdfPipelineOptions()
    options.do_ocr = False
    options.do_table_structure = True
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    report = []
    for pdf in sorted(pdf_dir.glob("PMC*.pdf")):
        if only and pdf.stem not in only:
            continue
        started = time.time()
        try:
            document = converter.convert(str(pdf)).document
            text = document.export_to_markdown()
            (out_dir / (pdf.stem + ".txt")).write_text(text, encoding="utf-8")
            report.append({"id": pdf.stem, "ok": True, "chars": len(text), "seconds": round(time.time() - started, 1)})
        except Exception as error:  # noqa: BLE001 - recorded, the next paper still runs
            report.append({"id": pdf.stem, "ok": False, "error": type(error).__name__, "message": str(error)[:200], "seconds": round(time.time() - started, 1)})
        print(report[-1], flush=True)
        (out_dir / "_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv)
