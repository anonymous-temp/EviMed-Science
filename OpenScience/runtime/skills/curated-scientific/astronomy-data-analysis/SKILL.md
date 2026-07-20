---
name: astronomy-data-analysis
description: Process and interpret astronomical observations and simulations. Use for FITS files, WCS coordinates, photometry, spectra, light curves, catalogs, uncertainty propagation, or Astropy-style workflows.
---

# Astronomy data analysis

Inspect FITS headers, extensions, units, world-coordinate metadata, calibration state,
masks, observation time, instrument, and data rights before analysis. Preserve the raw
file and create calibrated derivatives with explicit bias, dark, flat, background, and
quality-mask handling as applicable.

Propagate measurement uncertainty through photometry, spectroscopy, coordinate
transformations, model fitting, and time-series operations. Keep time scales, frames,
zero points, apertures, redshift conventions, and cosmological parameters explicit.
Compare derived quantities with a small trusted calculation or catalog cross-match.

Produce `astronomy-analysis.md`, reusable code, tables or figures, and a provenance
manifest with observation identifiers, software versions, parameters, and hashes. Do not
claim a detection when calibration, significance, multiple testing, or source matching is
unresolved.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill astronomy-data-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
