---
name: statistical-analysis
description: Plan and execute reproducible statistical analyses for research data. Use for model selection, assumptions, effect estimates, uncertainty, multiplicity, missing data, sensitivity analyses, and auditable result tables.
---

# Statistical analysis

Define the estimand and analysis population before choosing a model. Inspect variable types, clustering, repeated measures, censoring, missingness, and sampling design. Report effect sizes with confidence or credible intervals; do not rely on p-values alone.

Check model assumptions with diagnostics appropriate to the method. Handle multiplicity explicitly and distinguish prespecified from exploratory analyses. For missing data, state the assumed mechanism and compare a defensible sensitivity analysis when material.

Execute in a notebook with fixed seeds and recorded package versions. Check required imports before running; if a dependency is unavailable, write an environment specification and stop instead of silently installing or fabricating output. Keep input hashes, code, warnings, and convergence diagnostics.

Write `analysis.ipynb`, `results.csv`, and `statistical-report.md`. Never report a calculated value that is absent from the executed notebook.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill statistical-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
