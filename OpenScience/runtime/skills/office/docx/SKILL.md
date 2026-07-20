---
name: docx
description: Create a standards-based DOCX document from workspace text without proprietary skill content or external dependencies.
license: MIT
---

# DOCX artifact creation

Use `scripts/create_docx.py` for a deterministic first-party baseline export. Keep source text in the workspace, run the exporter, then verify the generated ZIP package before claiming success.

```bash
python3 scripts/create_docx.py --input report.md --output report.docx
```

The baseline exporter preserves paragraphs and Unicode text. It does not claim full Word editing, tracked changes, embedded media, or complex layout support. Keep the source document beside `document.docx` so the artifact is reproducible.
