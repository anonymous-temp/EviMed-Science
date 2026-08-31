---
name: drug-discovery-data
description: Prepare and evaluate drug-discovery datasets and benchmarks. Use for Therapeutics Data Commons-like tasks, molecular or biological splits, leakage control, baseline models, metrics, and reproducible benchmark reports.
---

# Drug discovery data

Record dataset name, version, task, endpoint definition, units, censoring, license, and source. Preserve raw identifiers and define a deterministic preprocessing manifest.

Choose splits that match the scientific claim: scaffold, time, target, protein-cluster, or external validation when random splits would leak related examples. Detect duplicates and near-duplicates across splits. Fit preprocessing only on training data.

Check dependencies before execution and never install them implicitly. Fix seeds, compare against simple baselines, report uncertainty, calibration where relevant, and failed runs. Benchmark performance does not establish experimental activity or clinical utility.

Write `dataset-card.md`, `split-manifest.csv`, `benchmark.ipynb`, `metrics.json`, and `benchmark-report.md`.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill drug-discovery-data --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
