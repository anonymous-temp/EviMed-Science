---
name: pptx
description: Create a simple standards-based PPTX presentation with a first-party dependency-free exporter.
license: MIT
---

# PPTX artifact creation

Use `scripts/create_pptx.py` for a one-slide title-and-body presentation, retain the source text, and validate the generated OOXML package.

```bash
python3 scripts/create_pptx.py --title "Study summary" --body-file summary.txt --output summary.pptx
```

This baseline exporter is deliberately narrow. It does not claim template fidelity, charts, speaker notes, animation, or arbitrary slide editing.
