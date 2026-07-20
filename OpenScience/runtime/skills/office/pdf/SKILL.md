---
name: pdf
description: Create a simple auditable PDF artifact from workspace text using a first-party dependency-free exporter.
license: MIT
---

# PDF artifact creation

Use `scripts/create_pdf.py` for a portable text PDF, then retain the UTF-8 source and validate the PDF header and trailer.

```bash
python3 scripts/create_pdf.py --input report.txt --output report.pdf
```

The baseline exporter supports wrapped Latin text and multiple pages. For complex typography, tagged accessibility, equations, or CJK font embedding, stop and declare the additional renderer and font dependency instead of silently degrading the document.
