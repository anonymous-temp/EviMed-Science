---
name: docx
description: Create a standards-based DOCX document from workspace text through the shared offline Pandoc renderer.
license: MIT
---

# DOCX artifact creation

Use `scripts/create_docx.py` for the shared first-party Markdown conversion. Keep source text in the workspace, run the exporter, then verify the generated ZIP package before claiming success.

```bash
python3 scripts/create_docx.py --input report.md --output report.docx
```

The renderer preserves Unicode text, Markdown headings, tables and inline mathematics using Pandoc installed in the research runtime. This CLI accepts a text document; platform conversion additionally freezes and verifies local raster figures. It does not provide tracked changes or full Word editing. Keep the source document beside `document.docx` so the artifact is reproducible.
