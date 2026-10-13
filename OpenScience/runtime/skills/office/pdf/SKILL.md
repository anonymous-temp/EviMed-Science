---
name: pdf
description: Read PDFs (text by page, find a phrase, extract tables to Excel or CSV, see a page as an image) and create or convert PDFs - from Markdown, or from Word, Excel and PowerPoint files. Use whenever a PDF is an input to summarize or mine, or the deliverable.
license: MIT
---

# PDF files

Pinned libraries: `pdfplumber` (text and tables), `pypdf` (pages), and the bundled LibreOffice Kit (page images, conversion).

## Read

```bash
python3 scripts/pdf_tool.py info report.pdf                        # pages, metadata, pages with no text layer
python3 scripts/pdf_tool.py text report.pdf --pages 1-3,7          # text, page by page
python3 scripts/pdf_tool.py find report.pdf "net revenue"          # lines and page numbers
python3 scripts/pdf_tool.py render report.pdf --pages 5 --out-dir page-5   # PNG of a page, a directory that does not exist yet
```

A summary quotes the document: take each fact from `text` or `find` and keep its page number. A page with no text layer is a scan: render it and read the image if you can; there is no OCR here, and say so when it matters.

## Tables

```bash
python3 scripts/pdf_tool.py tables report.pdf --page 5 --xlsx table-p5.xlsx           # one sheet per table
python3 scripts/pdf_tool.py tables report.pdf --page 5 --strategy text --csv table.csv  # tables without ruling lines
```

It prints the rows it found. Compare them with the page image before using them; a merged header or a wrapped cell can shift columns. Cells are written exactly as printed; add `--numbers` to store plain numbers (`120`, `45.5`) as numbers while text, percentages, thousands separators and units stay text.

## Create and convert

- From Markdown: `python3 scripts/create_pdf.py --input report.md --output report.pdf` (Chinese text, tables, math).
- From Word, Excel or PowerPoint: `python3 ../shared/office_kit.py convert --input deck.pptx --output deck.pdf` (the output must be a new file).
- Pages: `pypdf` merges, splits, rotates and reorders (`PdfReader`, `PdfWriter`, `writer.add_page(page)`); it does not black out content, so do not claim a redaction.

Leave the deliverable in the workspace and tell the user its name and page count.
