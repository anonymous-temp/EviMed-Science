---
name: bulk-rna-seq
description: Build reproducible bulk RNA-seq expression and differential-analysis workflows. Use for count matrices, sample metadata, design formulas, contrasts, QC, normalization, batch handling, differential expression, and pathway follow-up.
---

# Bulk RNA-seq

Validate that rows are stable gene identifiers and columns match sample metadata exactly. Preserve raw integer counts. Define the biological replicate, design formula, contrasts, blocking variables, known batches, and reference levels before fitting.

Report library size, sample correlations, PCA, outliers, filtering, normalization, dispersion/model diagnostics, effect sizes, adjusted p-values, and independent filtering. Avoid applying count models to already normalized values. Do not remove a batch confounded with biology and then claim the biological effect is identified.

Check analysis dependencies first and never install them implicitly. Record package versions, genome build, annotation release, code, seeds, and input hashes. Use `pathway-enrichment` only after preserving the ranked statistic and tested gene universe.

Write `bulk-rnaseq.ipynb`, `differential-expression.csv`, `qc-report.md`, and `analysis-design.json`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill bulk-rna-seq --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
