---
name: scientific-data-engineering
description: Design scalable, reproducible processing for large tabular, array, and partitioned scientific datasets. Use for Polars, Dask, Arrow, Zarr, chunking, lazy execution, schema evolution, memory constraints, or conversion between scientific formats.
---

# Scientific data engineering

Profile the input schema, units, missing-value semantics, identifiers, cardinality, size,
and storage layout before choosing an engine. Preserve raw inputs as read-only and define
a canonical schema with explicit types, units, keys, and invariants. Prefer streaming,
predicate pushdown, partition pruning, and bounded-memory aggregation over loading the
whole dataset.

Make conversions loss-aware: test row counts, keys, nulls, numeric tolerances, metadata,
and round trips on a representative fixture. Partition on fields that match actual query
patterns and avoid creating many tiny files. Pin library and file-format versions; record
worker count, memory limits, spill behavior, and deterministic ordering where relevant.

Deliver `data-contract.md`, executable transformations, validation results, a small
benchmark, and a provenance manifest with input and output hashes. Fail rather than
silently coercing invalid values, dropping records, or changing units.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill scientific-data-engineering --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
