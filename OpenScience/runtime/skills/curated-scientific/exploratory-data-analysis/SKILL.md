---
name: exploratory-data-analysis
description: Profile and validate scientific or clinical research datasets before modeling. Use for data dictionaries, missingness, ranges, duplicates, distributions, outliers, cohort flow, leakage checks, and reproducible exploratory figures.
---

# Exploratory data analysis

Work on a copy and never overwrite raw input. Record file hashes, encoding, row/column counts, units, value labels, identifiers, and time semantics. Detect duplicate entities, impossible values, inconsistent units, missingness patterns, censoring, and train/test leakage.

Separate data-quality findings from scientific findings. Treat outliers as observations to investigate, not rows to delete automatically. Avoid subgroup fishing and causal language. Suppress or aggregate small cells when human data could be identifiable.

Execute in a notebook with deterministic seeds and package versions. Check dependencies first; if unavailable, write an environment specification and stop. Produce `data-dictionary.csv`, `data-quality-report.md`, `eda.ipynb`, and only figures that materially clarify a finding.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill exploratory-data-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
