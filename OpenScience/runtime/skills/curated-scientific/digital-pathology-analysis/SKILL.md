---
name: digital-pathology-analysis
description: Build reproducible whole-slide image and histopathology analysis workflows. Use for WSI tiling, stain normalization, tissue segmentation, morphology, pathology annotations, PathML-style pipelines, or slide-level machine learning.
---

# Digital pathology analysis

Record slide format, scanner, objective magnification, microns per pixel, stain, specimen,
annotation source, and patient or case identifier. Preserve raw slides and derive tissue
masks, tiles, and features with recorded coordinates and transformations. Reject slides
with unreadable scale metadata unless it can be independently verified.

Measure blur, background, tissue coverage, folds, pen marks, staining variation, and
scanner or site effects. Keep all tiles from a patient or case in the same split. Report
both slide-level and patient-level performance and test sensitivity to tiling, stain
normalization, and aggregation choices.

Write `pathology-analysis.md`, QC tables, coordinate-linked outputs, figures, and a
provenance manifest. Minimize protected data and fail closed on identity, magnification,
annotation, or split ambiguity. Do not turn exploratory image findings into a diagnosis.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill digital-pathology-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
