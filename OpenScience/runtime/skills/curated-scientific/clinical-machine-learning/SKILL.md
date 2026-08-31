---
name: clinical-machine-learning
description: Develop and evaluate clinically valid, auditable machine-learning models. Use for diagnostic or prognostic prediction, temporal validation, calibration, explainability, fairness, and deployment-readiness analysis.
---

# Clinical machine learning

Define intended use, target population, prediction time, outcome window, unit of
analysis, clinical action, comparator, and harm from errors. Construct a cohort
diagram and feature-availability table. Exclude target leakage, post-index data,
duplicate patients across splits, and preprocessing fitted outside training data.

Use a clinically meaningful baseline before complex models. Split by patient and
time or site as required, nest tuning inside resampling, and preserve prevalence.
Report discrimination, calibration, threshold metrics, uncertainty, and decision
utility; accuracy alone is insufficient. Evaluate missingness, subgroup behavior,
dataset shift, and external validation. Explainability methods describe model
behavior and do not establish biological causality.

Record feature definitions, code, seeds, package versions, model artifacts,
threshold selection, and all exclusions. Align reporting with the applicable
prediction-model guidance, while clearly marking any unmet item.

Write `clinical-ml.ipynb`, `model-card.md`, `performance.csv`, and
`predictions.csv`. Never claim clinical readiness without representative external
validation, calibration, and a defined workflow evaluation.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill clinical-machine-learning --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
