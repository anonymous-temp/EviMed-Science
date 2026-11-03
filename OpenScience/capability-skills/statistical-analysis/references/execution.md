# Analysis execution and continuity reference

Read the section needed for the current task. This is a reference, not a checklist of analyses to add.

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

For programmatic consumption, prefer `analysis-results.json` for the executed
quantities and an optional `analysis-output.json` containing `schemaVersion: 1`,
a short `summary`, `tables: [{path, title}]`,
`figures: [{path, title, dataPath, caption}]`, and `code: [path]`. Paths are relative
to the workspace and must name real files from this analysis. This index helps
the caller find outputs; it does not establish scientific verification or grant
file access. Never invent download URLs. Keep full numerical precision in JSON
and machine-readable tables, with units, population and effect direction.

Make plots when requested or when they clarify a result. Save an actual PNG
preview and, when useful, SVG/PDF; use an installed headless plotting backend
(Matplotlib Agg or the R graphics device), readable labels and units, an explicit
legend and uncertainty where appropriate. Save the exact plotted summary data
as CSV/JSON and identify it with `dataPath`. Check the files open and their
labels/arrays agree with the reported analysis. For repeated observations, show
subject-level structure; for survival, show censoring/time units and numbers at
risk when relevant. Build Kaplan-Meier curves from a mature library's full event
table over the union of event and censoring times, not just death times. Carry
the plateau through the last observed follow-up; check the plotted data's event
and censor totals against the input and use the correct risk-set convention.
The optional `analysis_checks.audit_survival_curve` checks a complete static-cohort
table against declared `n`, `events`, `censored`, and `max_time` (column names are
configurable). It reports findings without judging censoring assumptions; delayed
entry, weights, competing risks or an explicitly truncated plot need their own
scope. A correct landmark estimate alone does not validate the whole plot. A decorative image is not a statistical figure. An HTML
interactive figure is an additional downloadable artifact, not a substitute for
a static preview. If plotting fails, retain tables/numbers, diagnose the failure
and state what is missing rather than claiming a chart was produced.

For longitudinal, clustered, competing-risk, missing-data or causal questions,
use the installed specialist skills/libraries appropriate to the design; the
nine helpers below are not a reason to force an unsuitable simple model.
Record the estimand and assumptions, show the affected population and perform a
proportionate sensitivity check. Predictive discrimination, a fitted association
or a feature-importance plot does not identify a treatment effect. After
execution, check these distinctions in the final reply as well as the report.

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

## Model-test interpretation

With interactions, state the tested contrast and sums-of-squares definition. A
balanced design does not make Type II and treatment-coded Type III main-effect
tests interchangeable. A permutation test for an interaction must preserve the
appropriate null model and nuisance main effects; shuffling treatment labels
within strata may instead test a stronger no-treatment-effect null. Similar
p values from different nulls do not establish robustness. Avoid supplementary
tests that the question and primary-model diagnostics do not require.
