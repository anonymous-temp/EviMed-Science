---
name: xlsx
description: Export CSV or tabular workspace data to a standards-based XLSX workbook with no external package dependency.
license: MIT
---

# XLSX artifact creation

Use `scripts/create_xlsx.py` to turn a UTF-8 CSV into a single-sheet workbook. Preserve the CSV as the canonical data source and validate the generated package.

```bash
python3 scripts/create_xlsx.py --input results.csv --output results.xlsx --sheet Results
```

The baseline exporter supports strings, finite numbers, booleans, and blank cells. It does not claim formula calculation, charts, macros, pivot tables, or style fidelity.
