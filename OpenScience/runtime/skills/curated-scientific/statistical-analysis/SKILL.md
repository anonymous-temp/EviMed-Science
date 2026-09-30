---
name: statistical-analysis
description: Plan and execute reproducible statistical analyses for research data. Use for model selection, assumptions, effect estimates, uncertainty, multiplicity, missing data, sensitivity analyses, and auditable result tables.
---

# Statistical analysis

Define the estimand and analysis population before choosing a model. Inspect variable types, clustering, repeated measures, censoring, missingness, and sampling design. Report effect sizes with confidence or credible intervals; do not rely on p-values alone.

Check model assumptions with diagnostics appropriate to the method. Handle multiplicity explicitly and distinguish prespecified from exploratory analyses. For missing data, state the assumed mechanism and compare a defensible sensitivity analysis when material.

Execute reproducible Python, R or notebooks with recorded package versions and seeds where randomness matters. If a dependency is unavailable, preserve completed results and explain only that calculation's limitation; use a defensible available alternative when appropriate. Keep input hashes, code, warnings, fitted transformation state and convergence diagnostics. Fit transforms on training data only when the task calls for predictive evaluation, and preserve that split and state across follow-ups.

Deliver a substantive `statistical-report.md` and the useful executed scripts or notebook and result artifacts. No notebook format or fixed file set is mandatory. Never report a calculated value absent from execution output, and retain valid partial results when another calculation fails.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill statistical-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader native Python/R workflow above and preserve the same provenance and failure boundaries.
