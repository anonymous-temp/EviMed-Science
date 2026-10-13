---
name: docx
description: Read, edit in place, and create Word documents (.docx) - contracts, letters, reports, meeting minutes, forms. Use whenever a .docx is something the user hands over or asks for; change one clause without disturbing the rest, keep revisions visible, or build a new document with headings, tables and Chinese text.
license: MIT
---

# Word documents

Three flows: read what exists, edit it in place, create what does not exist yet. The pinned libraries are `python-docx` and `lxml`; `python3` already has them. Keep scripts and outputs in the workspace.

## Read

```bash
python3 scripts/docx_tool.py outline contract.docx          # P1, P2 ... every paragraph, table cells and headers/footers included
python3 scripts/docx_tool.py find contract.docx "30 days"   # finds text even when Word split it across runs
```

## Edit a document that already exists

Edit, do not rebuild: a rebuilt document loses styles, numbering, headers and anything python-docx does not model.

```bash
python3 scripts/docx_tool.py replace contract.docx --find "30 days" --with "45 days" --paragraph 18
python3 scripts/docx_tool.py replace contract.docx --find "30 days" --with "45 days" --paragraph 18 --track-changes --author "Name" --out contract-redline.docx
python3 scripts/docx_tool.py diff contract-original.docx contract.docx
```

- `replace` rewrites only the XML part that holds the match and copies every other part as it was; inside the paragraph only the characters that differ change, so a bold "30" becomes a bold "45" and its neighbours keep their formatting. Without `--out` it edits the file itself; keep a copy first (or give `--out`) when the original may still be needed.
- When the text occurs more than once it refuses and lists the paragraphs. Choose the one the user means with `--paragraph`; use `--all` only when every occurrence must change.
- `--track-changes` writes a real Word revision (deletion plus insertion by the named author) - use it when the user says "show changes", "redline" or "for review".
- `diff` between the original and the result must show exactly the intended paragraphs and no "formatting only" entries. Say in one sentence what changed and where.
- Beyond a text change (a new paragraph after P12, a table row, a style), open the file with `Document(path)`, change those objects, save. Setting `paragraph.text` drops the formatting of its runs; change `run.text` instead. python-docx rewrites the whole package and does not create revisions (use `replace --track-changes`).

## Create

- A report, letter or minutes: write Markdown, then `python3 scripts/create_docx.py --input report.md --output report.docx` (headings, tables, math, Chinese text; the same renderer produces PDF).
- Exact layout control (cover page, header and footer, columns, merged cells): build with python-docx. Use paragraph styles (`Heading 1`, `List Bullet`) rather than bold body text; `table.style = "Table Grid"`; set the East Asian font for Chinese (`run._element.rPr.rFonts.set(qn("w:eastAsia"), "Noto Sans CJK SC")`).

## Check and deliver

Reopen the saved file and run the kernel's structural check, which also asserts that the text you meant to write is there: `python3 ../shared/office_kit.py check contract.docx --contains "45 days"` (a pass says the package is sound; it does not say the page looks right). To see a page, render it: `python3 ../shared/office_kit.py render --input contract.docx --output-dir preview-1 --pages 1,3` (a fresh directory each time; LibreOffice pagination can differ a little from Word). For a PDF copy: `python3 ../shared/office_kit.py convert --input contract.docx --output contract.pdf`. Leave the final file in the workspace under the name the user expects and tell them its name; an edit keeps the original name.
