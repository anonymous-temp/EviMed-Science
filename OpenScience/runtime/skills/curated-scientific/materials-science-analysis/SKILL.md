---
name: materials-science-analysis
description: Analyze crystal structures, compositions, phases, electronic structure, and materials properties. Use for CIF or POSCAR data, pymatgen-style workflows, phase diagrams, density-of-states, band structures, or materials database queries.
---

# Materials science analysis

Normalize composition, structure format, units, oxidation-state assumptions, coordinate
convention, periodic boundary conditions, and calculation objective. Validate lattice,
site occupancy, symmetry, and structure identity before comparing records. Preserve the
original structure and every transformation applied to it.

For computed properties, record code, pseudopotential, functional, basis or cutoff,
k-point mesh, spin settings, convergence criteria, and relaxation state. Compare only
quantities produced under compatible definitions. For database data, record material ID,
release, query, retrieval time, and license; distinguish measured from calculated values.

Deliver `materials-analysis.md`, normalized structures, machine-readable property tables,
figures where useful, and a provenance manifest. Fail closed on unit, structure, phase,
or convergence ambiguity, and do not infer experimental performance from a single
unvalidated calculation.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill materials-science-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
