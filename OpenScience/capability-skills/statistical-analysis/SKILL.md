---
name: statistical-analysis
description: Execute reproducible Python/R statistical analyses of supplied data and explain results, uncertainty, diagnostics and limitations.
---

# Statistical analysis

Infer the estimand, population, independent unit and outcome/event coding from the question and data. Ask only about ambiguities that change the analysis; otherwise state the assumption and proceed. Profile locally with aggregates and masked examples, keep source data unchanged, and account for clustering, repeated measurements, exclusions and missing values. A row is not necessarily an independent subject.

Start from what the project already knows about this data: read it with `mcp__evimed__dataset_semantics` (action `read`). A recorded interpretation — observation unit, patient and observation keys, units, code lists, population, time window, joins and the transformations already applied — is the starting point for a repeat analysis of the same dataset; use it instead of inferring it again, and state any departure. Write what you establish or what the researcher corrects (action `write`) with its basis: their own words as `researcher_confirmed` (a later inference never overwrites it), a supplied data dictionary as `dictionary_stated`, your own reading as `model_inferred` with what it was read from. Record each derived variable and filter with action `transform` (its inputs and the script that makes it), so a repeat analysis applies the same transformation or is told what changed.

On a new delivery of the data, action `check` names what drifted (a renamed column, a changed unit, type, code list or scale), observations repeated by the declared key, joins that are not the multiplicity they were declared with, denominators that differ between steps or from the last analysis (give the steps), and predictors measured after the outcome window opens (give the cutoff column). Each finding is information to handle and report: an exact repeat may be dropped, rows that disagree need a stated rule, a renamed or re-united column is confirmed before it is relied on. None of them stops the rest of the analysis, and a check that says it did not run is not a clean result.

Choose methods from the design and question. Execute Python, R or a notebook; obtain every reported numerical result and its rendered string from execution. Report the effect direction, denominators, estimate, appropriate uncertainty and relevant assumptions. Keep diagnostics, convergence warnings and exploratory status when material. A nonsignificant diagnostic does not prove its assumption; a p value alone does not establish clinical importance or causation.

Use source metadata or a codebook to establish category meanings; feature direction and class counts are consistency checks, not independent proof of a label's meaning. Compute comparative claims from the executed quantities, including p-value orders of magnitude and the denominator behind a standardized effect. A rounded cut-point and its stated comparison operator must reproduce the reported count; choosing a cut-point on these data is an exploratory fitted rule, not validated performance. Explain flagged observations from their actual group and values without inventing clinical plausibility. State precisely which results and figures the script regenerates; do not claim it regenerates prose or execution records it never writes.

Separate quantitative estimation from threshold classification: a censored measurement may lack an exact value while its bound still determines an outcome category. Do not replace its unknown value with the detection limit or discard a known category. Keep quantitative subsets and eligible categorical denominators distinct, and disclose bounded or sensitivity analyses where the category is ambiguous.

Persist transformation code, fitted state and the data/split definition for follow-ups. When the task calls for predictive evaluation, fit learned transformations on training data only and apply the same fitted state to held-out data. There is no universal train/test split. On a data supplement, compare input fingerprints and deliberately update or refit state; do not silently reuse incompatible results.

Deliver a substantive `statistical-report.md` with the actual findings and limitations, plus the useful reproducibility artifacts. The optional names are `analysis-results.json`, `analysis-run.json`, `analysis.py` and `analysis.R`; do not create empty placeholders or require both languages. Named scripts, notebooks, figures and tables may accompany them. Prefer structured results with `schemaVersion: 1` and `analyses: [{id, status, method, estimand, n, estimate, interval, pValue, warnings}]`; omit inapplicable fields and use failed/unsupported status with a reason for unavailable calculations. Descriptive summaries do not require a p value or interval. Do not label null or non-finite estimates complete.

For lightweight provenance, use the helper shipped beside this skill:

```bash
python scripts/run_analysis.py --workspace . --interpreter python --script analysis.py --input data.csv --results analysis-results.json --receipt analysis-run.json
```

Use `--interpreter r --script analysis.R` for native R; repeat `--input` for sources, `--transform` for persisted state, and `--arg` for script arguments. `--parent` links a follow-up to an existing receipt execution id. The helper records real hashes, versions and output observations per attempt; it selects no method and installs no dependencies. It is provenance, not proof that a statistic is correct. Direct native execution is valid; a missing helper receipt is only a traceability notice.

An unavailable package, invalid model input, failed extra calculation or formatting error affects that operation. Preserve existing results and code, state the limitation, and use a defensible available alternative when appropriate. Never fabricate an execution, replace a failed estimate with zero, discard a whole package or require human approval to continue. Do not print raw patient rows, credentials, environment dumps or complete process logs into the report.
