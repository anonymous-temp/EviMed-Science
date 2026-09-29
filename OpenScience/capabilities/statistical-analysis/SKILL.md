---
name: statistical-analysis
description: Execute reproducible Python/R statistical analyses of supplied data and explain results, uncertainty, diagnostics and limitations.
---

# Statistical analysis

Infer the estimand, population, independent unit and outcome/event coding from the question and data. Ask only about ambiguities that change the analysis; otherwise state the assumption and proceed. Profile locally with aggregates and masked examples, keep source data unchanged, and account for clustering, repeated measurements, exclusions and missing values. A row is not necessarily an independent subject.

Choose methods from the design and question. Execute Python, R or a notebook; obtain every reported numerical result and its rendered string from execution. Report the effect direction, denominators, estimate, appropriate uncertainty and relevant assumptions. Keep diagnostics, convergence warnings and exploratory status when material. A nonsignificant diagnostic does not prove its assumption; a p value alone does not establish clinical importance or causation.

Persist transformation code, fitted state and the data/split definition for follow-ups. When the task calls for predictive evaluation, fit learned transformations on training data only and apply the same fitted state to held-out data. There is no universal train/test split. On a data supplement, compare input fingerprints and deliberately update or refit state; do not silently reuse incompatible results.

Deliver a substantive `statistical-report.md` with the actual findings and limitations, plus the useful reproducibility artifacts. The optional names are `analysis-results.json`, `analysis-run.json`, `analysis.py` and `analysis.R`; do not create empty placeholders or require both languages. Named scripts, notebooks, figures and tables may accompany them. Prefer structured results with `schemaVersion: 1` and `analyses: [{id, status, method, estimand, n, estimate, interval, pValue, warnings}]`; omit inapplicable fields and use failed/unsupported status with a reason for unavailable calculations. Descriptive summaries do not require a p value or interval. Do not label null or non-finite estimates complete.

For lightweight provenance, use the helper shipped beside this skill:

```bash
python scripts/run_analysis.py --workspace . --interpreter python --script analysis.py --input data.csv --results analysis-results.json --receipt analysis-run.json
```

Use `--interpreter r --script analysis.R` for native R; repeat `--input` for sources, `--transform` for persisted state, and `--arg` for script arguments. `--parent` links a follow-up to an existing receipt execution id. The helper records real hashes, versions and output observations per attempt; it selects no method and installs no dependencies. It is provenance, not proof that a statistic is correct. Direct native execution is valid; a missing helper receipt is only a traceability notice.

An unavailable package, invalid model input, failed extra calculation or formatting error affects that operation. Preserve existing results and code, state the limitation, and use a defensible available alternative when appropriate. Never fabricate an execution, replace a failed estimate with zero, discard a whole package or require human approval to continue. Do not print raw patient rows, credentials, environment dumps or complete process logs into the report.
