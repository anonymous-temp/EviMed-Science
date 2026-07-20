---
name: survival-analysis
description: Plan and execute reproducible time-to-event analyses. Use for censoring, competing risks, recurrent events, Cox or parametric models, survival prediction, calibration, and sensitivity analysis.
---

# Survival analysis

Define the estimand, eligibility, time origin, event, competing events, censoring,
follow-up window, analysis population, and treatment-assignment rule before
fitting a model. Inspect delayed entry, interval censoring, recurrent events,
immortal time, informative censoring, and time-dependent exposures.

Start with event counts, follow-up summaries, Kaplan-Meier or cumulative-incidence
estimates, and numbers at risk. Choose Cox, flexible parametric, accelerated
failure-time, competing-risk, multi-state, or recurrent-event methods from the
estimand and data structure. Report effect estimates and absolute risks with
uncertainty, not p-values alone.

Test proportional hazards where applicable, inspect functional forms,
influential observations, convergence, calibration, and discrimination. Use
time-aware validation and keep preprocessing inside each resampling fold. Add
sensitivity analyses for censoring, missing data, competing risks, and modeling
choices that can change the conclusion.

Execute in `survival-analysis.ipynb` and write `survival-results.csv` and
`survival-report.md`. Record package versions, seeds, warnings, and diagnostics.
If a dependency is missing, specify it and stop; never fabricate fitted values.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill survival-analysis --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
