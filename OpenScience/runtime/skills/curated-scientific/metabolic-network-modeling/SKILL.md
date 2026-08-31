---
name: metabolic-network-modeling
description: Build and analyze constraint-based metabolic-network models. Use for SBML validation, flux-balance analysis, flux variability, gene knockouts, media constraints, gap analysis, and model comparison.
---

# Metabolic network modeling

Record model source, version, organism or cell context, identifiers, compartments,
gene-protein-reaction rules, objective, exchange reactions, units, and growth or
media conditions. Validate mass balance, charge balance, bounds, blocked
reactions, cycles, and solver status before biological interpretation.

Run flux-balance analysis with an explicit objective and constraints, then test
alternate optima with flux variability. For knockout or intervention analyses,
preserve the exact rule changes and compare against a validated baseline. Use
gap filling only with an explicit candidate reaction source and penalty; do not
silently add reactions to force feasibility.

Explore sensitivity to objective, uptake bounds, maintenance costs, solver
tolerance, and model version. Flux predictions are conditional on the model and
constraints, not direct measurements of intracellular rates.

Write `metabolic-model-analysis.ipynb`, `flux-results.csv`,
`model-validation.json`, and `metabolic-model-report.md`. Preserve infeasible
runs and solver warnings instead of replacing them with plausible fluxes.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill metabolic-network-modeling --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
