---
name: mass-spectrometry-analysis
description: Analyze proteomics, metabolomics, and spectral-library data with traceable preprocessing and identification control. Use for mzML or MGF inspection, feature alignment, matching, quantification, QC, and FDR analysis.
---

# Mass spectrometry analysis

Record acquisition mode, instrument, polarity, chromatography, calibration,
sample preparation, batches, blanks, pooled QC, standards, and file conversions.
Hash raw and converted files and preserve the conversion parameters.

Define centroiding, noise filtering, peak picking, retention-time alignment,
deconvolution, normalization, missing-value rules, and batch correction before
interpreting biology. Track feature coverage in blanks and QC samples. Avoid
imputation that creates group separation or hides limit-of-detection behavior.

For identifications, record database or spectral library version, mass and
retention tolerances, decoy strategy, score threshold, and false-discovery rate.
Separate identified, annotated, and unknown features. Validate quantitative
comparisons with QC drift, replicate agreement, and sensitivity analyses.

Write `mass-spec-analysis.ipynb`, `feature-table.csv`, `identification-ledger.csv`,
and `mass-spec-report.md`. Do not infer a compound or protein identity from an
unvalidated mass match alone.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill mass-spectrometry-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
