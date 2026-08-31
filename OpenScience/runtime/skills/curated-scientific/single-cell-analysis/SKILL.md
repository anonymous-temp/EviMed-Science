---
name: single-cell-analysis
description: Analyze single-cell RNA or multi-omic datasets with explicit sample-level replication and QC. Use for AnnData, Scanpy, CELLxGENE-derived data, filtering, integration, clustering, annotation, differential testing, and provenance-aware outputs.
---

# Single-cell analysis

Treat the donor or biological sample, not each cell, as the usual unit of inference. Record genome build, feature identifiers, assay, tissue, donor metadata, consent/use restrictions, and dataset version. Preserve raw counts in a separate layer.

Predeclare QC metrics and thresholds; show sensitivity to filtering. Detect doublets and batch effects without erasing biological structure. Record normalization, highly variable genes, dimensionality reduction, neighbors, clustering resolution, annotation evidence, and random seeds. Prefer pseudobulk or sample-aware models for group comparisons.

Check required Python/R packages before execution; never install them implicitly. If dependencies or controlled data are unavailable, emit a reproducible environment/data-access specification and stop. Do not infer clinical response from cell-state association alone.

Write `single-cell-analysis.ipynb`, `qc-metrics.csv`, `cell-annotations.csv`, and `single-cell-report.md`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill single-cell-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
