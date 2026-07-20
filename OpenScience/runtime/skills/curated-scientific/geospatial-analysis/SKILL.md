---
name: geospatial-analysis
description: Analyze scientific data with coordinates, geometries, rasters, regions, or spatial dependence. Use for GeoPandas-style workflows, CRS transformations, spatial joins, distance calculations, maps, exposure surfaces, or geographic epidemiology.
---

# Geospatial analysis

Identify the coordinate reference system, datum, axis order, geometry type, spatial
resolution, temporal coverage, and privacy constraints. Validate geometry and repair only
with a recorded rule. Use an appropriate projected CRS for distance or area; never measure
them directly in geographic degrees.

Check boundary definitions, geocoding uncertainty, missing locations, spatial sampling
bias, edge effects, autocorrelation, and scale sensitivity. Separate individual-level
inference from area-level association and flag ecological fallacy. For maps, use honest
classification, legends, units, accessible colors, and uncertainty overlays.

Write `spatial-analysis.md`, machine-readable outputs, reusable code, and a provenance
manifest containing source versions, CRS transformations, filters, and hashes. Aggregate
or redact sensitive locations and fail closed when coordinate systems or geographic joins
cannot be verified.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill geospatial-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
