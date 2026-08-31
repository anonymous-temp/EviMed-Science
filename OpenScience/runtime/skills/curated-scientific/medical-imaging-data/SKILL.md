---
name: medical-imaging-data
description: Inspect and analyze DICOM or research imaging datasets with privacy and provenance safeguards. Use for metadata inventory, series selection, quality control, conversion planning, annotation, and reproducible imaging analysis.
---

# Medical imaging data

Keep imaging data local unless the user explicitly authorizes an approved destination. Treat DICOM headers, private tags, UIDs, filenames, overlays, burned-in pixels, annotations, and linked reports as potentially identifying.

Do not describe tag deletion as verified de-identification. A release requires a project-specific de-identification profile, UID remapping, private-tag policy, burned-in-pixel review, re-identification risk testing, and documented validation. If these are absent, stop any export or upload and label the dataset restricted.

Inventory modality, study/series relationships, orientation, spacing, frames, transfer syntax, pixel type, acquisition parameters, and corrupt/incomplete objects. Never alter originals. Check imaging dependencies before execution; do not install them implicitly.

Write `imaging-inventory.csv`, `imaging-qc.md`, and `imaging-analysis.ipynb`. Do not infer a diagnosis from image appearance without a validated task and ground truth.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill medical-imaging-data --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
