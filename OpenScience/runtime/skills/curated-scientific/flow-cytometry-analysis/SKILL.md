---
name: flow-cytometry-analysis
description: Analyze flow or mass cytometry experiments from FCS files. Use for compensation, spectral unmixing, transformations, gating, batch correction, population discovery, marker summaries, or cytometry quality control.
---

# Flow cytometry analysis

Capture instrument, panel, fluorochrome or isotope mapping, sample identifiers, controls,
acquisition settings, spillover or unmixing matrix, and batch structure. Validate FCS
metadata and channel names before analysis. Keep raw events immutable and record every
filter, transform, compensation, and gate.

Use time, scatter, viability, singlet, and control-based QC as appropriate. Apply gates
consistently, retain boundary definitions, and quantify excluded events. For unsupervised
methods, fix seeds, check stability, compare with control-informed populations, and avoid
assigning biological identities solely from clusters.

Produce `cytometry-analysis.md`, a gating or transformation specification, population
tables, QC figures, machine-readable results, and a provenance manifest. Fail closed on
missing controls, channel ambiguity, invalid compensation, or sample-identity conflicts.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill flow-cytometry-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
