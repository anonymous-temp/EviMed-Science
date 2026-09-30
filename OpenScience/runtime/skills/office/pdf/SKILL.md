---
name: pdf
description: Create a Unicode PDF from workspace Markdown through the shared offline Pandoc and Chromium renderer.
license: MIT
---

# PDF artifact creation

Use `scripts/create_pdf.py` for a PDF with the runtime's CJK fonts, then retain the UTF-8 source and inspect the pages and extracted text.

```bash
python3 scripts/create_pdf.py --input report.txt --output report.pdf
```

The runtime supplies Pandoc, Playwright, Chromium, Noto CJK and TeX Gyre mathematics fonts. Headings, tables, mathematics and Chinese text use the shared renderer; remote images and executable HTML are unavailable. Missing resources remain visibly labelled. Tagged PDF accessibility is not claimed.
