---
name: quantum-computing-analysis
description: Design, simulate, and evaluate quantum circuits and algorithms. Use for Qiskit, Cirq, PennyLane, QuTiP, Hamiltonians, variational circuits, noise models, transpilation, or comparisons with classical baselines.
---

# Quantum computing analysis

Define the problem encoding, qubit count, circuit model, observables, objective, backend,
shot budget, noise assumptions, and success metric. Preflight framework and backend
availability without silently switching from hardware to a simulator. Fix seeds and
record transpiler settings, topology, gate set, circuit depth, and calibration snapshot.

Validate small instances against an exact or classical reference. Separate sampling
error, optimizer variability, hardware noise, and approximation error. Report resource
scaling and include competitive classical baselines; never infer quantum advantage from
one small or selectively reported run.

Write `quantum-experiment.md`, runnable circuits, raw counts or state outputs, analysis
tables, and a provenance manifest. Fail closed on unverified normalization, endianness,
observable mapping, backend identity, or incomplete jobs.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill quantum-computing-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
