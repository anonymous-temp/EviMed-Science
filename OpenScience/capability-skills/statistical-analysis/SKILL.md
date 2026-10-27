---
name: statistical-analysis
description: Execute reproducible Python/R statistical analyses of supplied data and explain results, uncertainty, diagnostics and limitations.
---

# Statistical analysis

You own the analysis from the researcher's question to the executed answer. The
researcher supplies a goal and data, not an algorithm checklist: inspect, choose,
execute, check and explain in the conversation, with Python/R and installed
scientific libraries doing the numerical work. The reference helpers are
optional and are not the boundary of what you can analyze.

Keep the work proportional. A descriptive question needs a descriptive answer, a
prediction question needs held-out evaluation, a causal question needs its
identifying assumptions. Start a simple comparison with one primary estimate,
its uncertainty, the relevant data checks and a small independent cross-check;
add a sensitivity analysis only for an identified concern. Use installed
libraries rather than writing a distribution or interval algorithm yourself, and
never answer a requested calculation with only a proposed script, an algorithm
menu or an unevaluated formula.

Infer the estimand, population, independent unit and outcome/event coding from
the question and data; ask only about ambiguities that change the analysis,
otherwise state the assumption and proceed. Profile locally with aggregates and
masked examples, keep source data unchanged, and account for clustering,
repeated measurements, exclusions and missing values: a row is not necessarily
an independent subject. Take category and event meanings from the dictionary or
source metadata; feature direction and class counts are only consistency checks.

Start from what the project already knows about the data: read it with
`mcp__evimed__dataset_semantics` (action `read`). A recorded interpretation (unit,
keys, code lists, population, joins, applied transformations) is the starting
point for a repeat analysis; state any departure. Write what you establish or the
researcher corrects (action `write`) with its basis: `researcher_confirmed` (never
overwritten by an inference), `dictionary_stated` or `model_inferred`; record each
derived variable and filter with action `transform`. On a new delivery of the data
action `check` names drift, repeated observations, join multiplicity, differing
denominators and post-outcome predictors: handle and report each finding, and
treat a check that did not run as unknown, not clean.

Choose methods from the design and question. Obtain every reported number and
its rendered string from execution, compute comparative claims from the executed
quantities, and say which results and figures a script regenerates.
Report effect direction, denominators, estimate, appropriate uncertainty and
assumptions, and keep material diagnostics, convergence warnings and exploratory
status. A nonsignificant diagnostic does not prove its assumption; a p value
alone does not establish importance or causation; a cut-point chosen on these
data is an exploratory fitted rule, not validated performance. For a censored
measurement, do not substitute the detection limit for the unknown value or drop
a known category, and keep quantitative and categorical denominators distinct.

Before writing code, inspect the actual files and any existing executed results,
receipt and dictionary. Reuse a saved result only if its input fingerprint,
cohort, coding, units, question, method, executed code and dependency versions
match; do not recompute because a question was rephrased or reuse incompatible
state because a file has a familiar name. After execution,
check outputs, denominators and effect direction, and cross-check a small
decisive result when practical. If code fails, diagnose the actual error, repair
or choose a defensible alternative and keep the successful work.

On a follow-up, reuse the established unit, cohort and fitted state and rerun
only the affected steps; changed data and a changed question are different
things. When the researcher asks to keep the existing computation, treat it as an
execution constraint: for a unit-only conversion or a fixed-threshold change on
unchanged data, transform the executed estimates or saved probabilities, verify
against them, and leave the original results, fitted state and inputs untouched;
if a pipeline always recomputes everything, write a small separate continuation
script. Judge fitted-state reuse from its recorded input, code, versions and
split, not by retraining. Persist transformation code, fitted state and the
data/split definition. For predictive evaluation fit every learned transformation
on training data only and apply that state to held-out data. On a data
supplement compare fingerprints and deliberately update or refit.

Use only tools actually exposed in this session. An external catalogue such as
ToolUniverse may supplement the workflow with an admitted tool; check its data
boundary first and never send patient-level data to an external service. The
hosted helpers live in `$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts`
(beside this file otherwise); do not search the host or dump its environment.

## Updating an analysis across turns

The optional `scripts/analysis_session.py` keeps `analysis-session.json` (your
step definition) apart from `analysis-state.json` (observed executions). Separate
preparation, estimation and report/threshold evaluation when their dependencies
differ, and give each step only the semantics it needs in its `context`
(grouping, unit, coding, transform, model). A unit or
fixed-threshold change should leave the fitted model and split reusable; new
patients or corrected labels invalidate what they touch. A result is reusable
only while its sources, code, dependencies, context, versions, latest receipt and
output hashes match. An undefined value (a p-value in a degenerate
subgroup) is stored as null with a `nonfinite` warning listed by `status`; it is
a result, and its dependants may run.

```json
{"schemaVersion":1,"steps":[{"id":"estimate","script":"estimate.py","interpreter":"python","inputs":["data.csv"],"outputs":["estimates.json"],"results":"estimates.json","dependsOn":[],"context":{"group":"B minus A","unit":"mm"}},{"id":"report","script":"report.py","interpreter":"python","inputs":["estimates.json"],"outputs":["report-values.json","statistical-report.md"],"results":"report-values.json","dependsOn":["estimate"],"context":{"displayUnit":"cm"},"args":["--scale","0.1"]}]}
```

```bash
SCRIPTS="$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts"
python "$SCRIPTS/analysis_session.py" status --workspace . --spec analysis-session.json --state analysis-state.json
python "$SCRIPTS/analysis_session.py" run --workspace . --spec analysis-session.json --state analysis-state.json --step estimate
```

Only the named step runs: check `status`, run any stale dependency first, one
command at a time. Declare every script, fitted state, configuration and input a
step reads, pass a single parameter as an argument or a small declared file, and
write all declared outputs. A failed update keeps the prior results and history;
hashes establish continuity, not scientific correctness.

## Deliverables and helpers

Deliver the answer in plain language and a substantive `statistical-report.md`
with the findings, remaining uncertainty and limitations, plus useful
reproducibility artifacts (optional names `analysis-results.json`,
`analysis-run.json`, `analysis.py`, `analysis.R`; no empty placeholders, no need
for both languages). Prefer structured results with `schemaVersion: 1` and
`analyses: [{id, status, method, estimand, n, estimate, interval, pValue,
warnings}]`; omit inapplicable fields, give a failed or unsupported status a
reason, and never label a null or non-finite estimate complete.

`scripts/analysis_methods.py` (add its directory to `sys.path`) has
`compare_groups`, `covariate_balance`, `contingency_test`, `linear_regression`,
`logistic_regression`, `kaplan_meier`, `log_rank`, `cox_regression` and
`adjust_pvalues`. Each returns an entry shaped for `analysis-results.json` with
its diagnostics, method record and library versions; a computation the data
cannot support comes back `unsupported` with a reason and no number, and every
other analysis stays. Its diagnostics are labels, not verdicts.

`scripts/run_analysis.py` records provenance:

```bash
python "$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts/run_analysis.py" --workspace . --interpreter python --script analysis.py --input data.csv --results analysis-results.json --receipt analysis-run.json
```

Use `--interpreter r --script analysis.R` for native R; repeat `--input`,
`--transform` (persisted state) and `--arg`; `--parent` links a follow-up to an
earlier execution id. It records hashes, versions and output observations and
selects no method. Direct native execution is valid; a missing receipt is only a
traceability notice.

To carry executed numbers into the report, write it as a template with
`{{n:alias.key|format}}` references and call `mcp__evimed__research_calculate`
with `action=render`, naming each alias's `{resultsPath, receiptPath}`. It writes
a new file; an unresolved reference reads 未计算 and typed numbers are checked.

For prediction, `scripts/analysis_checks.py` provides `audit_predictions` over
row dictionaries. Supply `outcome_column`, `positive_label`, `negative_label`,
`probability_column`, `probability_label`, `split_column` and `patient_id_column`;
labels stay typed strings and the event is the label you name, never inferred
from numeric order. Keep training rows in the input, declare every learned stage
(imputation, selection, tuning, calibration, final fit) in `fit_stages` as
`{"name":..., "fitIds":[...], "idLevel":"patient", "predictors":[...]}` with the
IDs it really fitted on, give `predictor_columns`, and count upstream exclusions
in `withheld_rows`. A row-number ID is an observation key, not evidence of
independent patients; keep each patient on one side of a split. Without a true
patient ID or fitting scope, report that limit rather than claim no leakage. Its
findings and metrics do not prove external validity.

`compare_reported_numbers(results, comparisons)` checks explicit bindings such
as `{"id":"auc","source":["metrics","auc"],"reported":0.923,"absoluteTolerance":0.0005}`
for the numbers inserted into the report; it certifies no prose. Keep numerical
results, probabilities and model state at full precision and round only display
strings. Label every denominator by its population (full data, training,
held-out, complete cases) and recompute each percentage from that population's
numerator and denominator, in the reply as well as the report, reusing the
executed display strings.

An unavailable package, invalid model input, failed extra calculation or
formatting error affects that operation. Preserve existing results and code,
state the limitation and use a defensible alternative. Never fabricate an
execution, replace a failed estimate with zero, discard a whole package or require
human approval to continue. Do not print raw patient rows, credentials,
environment dumps or complete process logs into the report.
