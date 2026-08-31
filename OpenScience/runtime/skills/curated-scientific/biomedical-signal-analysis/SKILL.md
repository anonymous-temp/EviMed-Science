---
name: biomedical-signal-analysis
description: Process and analyze physiological and biomedical time-series signals. Use for ECG, PPG, EEG, EMG, EDA, respiration, wearable signals, event detection, quality control, and reproducible feature extraction.
---

# Biomedical signal analysis

Record modality, device, channels, units, sampling rate, acquisition protocol,
reference, timing, subject and session identifiers, and known interventions.
Preserve raw data and create a processing manifest before transformations.

Inspect clipping, dropout, motion, line noise, baseline drift, synchronization,
and channel quality. Choose filters from signal bandwidth and scientific target;
record every cutoff, order, phase property, resampling step, and rejected segment.
Never hide artifacts through undocumented smoothing.

Validate event detection and derived features against labeled segments or a
defensible reference. Split evaluation by subject, not window, and avoid using
future samples in real-time claims. Quantify coverage, failure rate, uncertainty,
and sensitivity to processing choices. Signal features are not a diagnosis.

Write `signal-analysis.ipynb`, `signal-features.csv`, `quality-control.csv`, and
`signal-report.md`. If the required parser or signal library is unavailable,
write the environment requirement and stop rather than inventing output.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill biomedical-signal-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
