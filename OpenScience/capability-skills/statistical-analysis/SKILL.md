---
name: statistical-analysis
description: Execute reproducible Python/R statistical analyses of supplied data and explain results, uncertainty, diagnostics and limitations.
---

# Statistical analysis

## LLM-driven analysis agent

You own the analysis from the researcher's question to the executed answer. The
researcher supplies their goal and available data, not an algorithm checklist.
Use the native conversation to understand, inspect, choose, execute, check and
explain; use Python/R and installed scientific libraries for numerical work.
The reference helper is optional. Its nine functions are not the boundary of
what you can analyze, and the absence of a helper entry is not a refusal reason.

Keep the work proportional. A descriptive question needs a descriptive answer;
a prediction question needs held-out evaluation; a causal question needs its
identifying assumptions. Do not run every available test or turn exploratory
associations into a causal or individual-treatment recommendation. Explain
material choices briefly and proceed when a reasonable assumption suffices.

For a small group-comparison question, start with one primary estimate and its
uncertainty, relevant data checks and a small independent cross-check. Add a
sensitivity analysis only when it answers an identified concern. A full battery
of normality tests, alternative tests, bootstrap variants and exploratory models
does not make a simple answer better. Use installed numerical libraries rather
than implementing a new distribution or confidence-interval algorithm inside
the report script. Keep the first useful delivery short enough to inspect.

Before writing code, inspect the actual files and any existing executed
notebook, results, analysis receipt and data dictionary. Reuse a saved result
only if its input fingerprint, cohort, coding, units and analysis question
match, and its method record, executed code digest and numerical dependency
versions remain compatible. Check the fit before carrying a number forward. Do not recompute simply
because the same question is phrased differently, and do not reuse incompatible
state merely because a file has a familiar name.

After execution, inspect outputs and diagnostics, verify denominators and effect
direction, and independently cross-check a small decisive result when practical.
If the code fails, diagnose the actual error, repair or choose a defensible
alternative, and keep the successful work. Never answer a requested calculation
with only a proposed script, an algorithm menu or an unevaluated formula.

On a follow-up, reuse the established unit, cohort and fitted state, incorporate
the correction, and rerun only affected steps. Distinguish changed data from a
changed analytical question. Deliver the answer in plain language with useful
figures/tables and reproducible files; name remaining uncertainty. Do not
introduce an extra form, mandatory approval step or fixed report length.

Treat a request to keep the existing computation as an execution constraint.
For a unit-only conversion or a fixed-threshold change with unchanged source
data, read the executed estimates or saved probabilities and transform only
those values. Do not run the original analysis, refit a model, rerun bootstrap/CV,
or invoke a `run_all` script just to refresh timestamps, rebuild provenance,
revalidate the whole package or make an advisory notice disappear. Verify the
affected transformation against the cached values and leave the original result
file, fitted state and input files byte-identical. If an existing pipeline always
recomputes everything, write a small separate continuation script; do not call
that pipeline. For a fitted-state reuse decision, inspect its recorded input,
code, versions and split rather than retraining to demonstrate reproducibility.
An explicit request to replay the whole analysis is a different task.

Use only tools actually exposed in this session. An optional external catalogue
such as ToolUniverse supplements the workflow when it has an appropriate
admitted tool; it is not a prerequisite, another orchestrator or a reason to
send patient-level data to an external service. Inspect the tool's input and
execution/data boundary before using it. Native local Python/R remains the
normal execution path for supplied datasets.

The hosted skill's helpers live in
`$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts`. Use that specific
environment path to locate them; do not search the host or dump its environment.
In a non-hosted installation, use the `scripts/` directory beside this SKILL.md.
If no helper is available, direct native analysis remains valid.

Infer the estimand, population, independent unit and outcome/event coding from the question and data. Ask only about ambiguities that change the analysis; otherwise state the assumption and proceed. Profile locally with aggregates and masked examples, keep source data unchanged, and account for clustering, repeated measurements, exclusions and missing values. A row is not necessarily an independent subject.

Start from what the project already knows about this data: read it with `mcp__evimed__dataset_semantics` (action `read`). A recorded interpretation — observation unit, patient and observation keys, units, code lists, population, time window, joins and the transformations already applied — is the starting point for a repeat analysis of the same dataset; use it instead of inferring it again, and state any departure. Write what you establish or what the researcher corrects (action `write`) with its basis: their own words as `researcher_confirmed` (a later inference never overwrites it), a supplied data dictionary as `dictionary_stated`, your own reading as `model_inferred` with what it was read from. Record each derived variable and filter with action `transform` (its inputs and the script that makes it), so a repeat analysis applies the same transformation or is told what changed.

On a new delivery of the data, action `check` names what drifted (a renamed column, a changed unit, type, code list or scale), observations repeated by the declared key, joins that are not the multiplicity they were declared with, denominators that differ between steps or from the last analysis (give the steps), and predictors measured after the outcome window opens (give the cutoff column). Each finding is information to handle and report: an exact repeat may be dropped, rows that disagree need a stated rule, and a renamed column or a changed unit is confirmed with the researcher or a dictionary, then recorded, before it is relied on. None of them stops the rest of the analysis, and a check that says it did not run is not a clean result.

Choose methods from the design and question. Execute Python, R or a notebook; obtain every reported numerical result and its rendered string from execution. Report the effect direction, denominators, estimate, appropriate uncertainty and relevant assumptions. Keep diagnostics, convergence warnings and exploratory status when material. A nonsignificant diagnostic does not prove its assumption; a p value alone does not establish clinical importance or causation.

Use source metadata or a codebook to establish category meanings; feature direction and class counts are consistency checks, not independent proof of a label's meaning. Compute comparative claims from the executed quantities, including p-value orders of magnitude and the denominator behind a standardized effect. A rounded cut-point and its stated comparison operator must reproduce the reported count; choosing a cut-point on these data is an exploratory fitted rule, not validated performance. Explain flagged observations from their actual group and values without inventing clinical plausibility. State precisely which results and figures the script regenerates; do not claim it regenerates prose or execution records it never writes.

Separate quantitative estimation from threshold classification: a censored measurement may lack an exact value while its bound still determines an outcome category. Do not replace its unknown value with the detection limit or discard a known category. Keep quantitative subsets and eligible categorical denominators distinct, and disclose bounded or sensitivity analyses where the category is ambiguous.

Persist transformation code, fitted state and the data/split definition for follow-ups. When the task calls for predictive evaluation, fit learned transformations on training data only and apply the same fitted state to held-out data. There is no universal train/test split. On a data supplement, compare input fingerprints and deliberately update or refit state; do not silently reuse incompatible results.

For analysis that is being updated across turns, prefer the optional
`scripts/analysis_session.py` helper. It keeps `analysis-session.json` (your step
definition) separate from `analysis-state.json` (observed executions). Separate
preparation, estimation/model fitting and report/threshold evaluation when they
have different dependencies. Put only the semantics relevant to each step in
its `context`, including grouping, unit, event coding, transform and model
choices. A presentation-unit or fixed-threshold change should normally leave the
fitted model and patient split reusable; new patients or corrected group labels
invalidate the affected preparation and estimates. Check state before deciding
what to run. A result is reusable only while its sources, code, dependencies,
context, runtime versions, latest execution receipt and output hashes match.

```json
{"schemaVersion":1,"steps":[{"id":"estimate","script":"estimate.py","interpreter":"python","inputs":["data.csv"],"outputs":["estimates.json"],"results":"estimates.json","dependsOn":[],"context":{"group":"B minus A","unit":"mm"}},{"id":"report","script":"report.py","interpreter":"python","inputs":["estimates.json"],"outputs":["report-values.json","statistical-report.md"],"results":"report-values.json","dependsOn":["estimate"],"context":{"displayUnit":"cm"},"args":["--scale","0.1"]}]}
```

```bash
SCRIPTS="$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts"
python "$SCRIPTS/analysis_session.py" status --workspace . --spec analysis-session.json --state analysis-state.json
python "$SCRIPTS/analysis_session.py" run --workspace . --spec analysis-session.json --state analysis-state.json --step estimate
python "$SCRIPTS/analysis_session.py" run --workspace . --spec analysis-session.json --state analysis-state.json --step report
```

The paths above are examples; invoke the helper at its actual skill location.
Only the named step runs; you choose the method and explicitly run any stale
dependencies first. Serialize commands. Declare every helper script, fitted
state, configuration and input a step reads. Do not make every step read the
whole manifest just to obtain one parameter: pass the relevant parameter as an
argument or a separate declared configuration file. Each executed step writes
all its declared outputs. Existing native notebooks and receipts remain valid;
the helper is optional and never a reason to discard them. A failed update keeps
the prior results and execution history; inspect the actual error before fixing
the affected operation. Hashes establish continuity, not scientific correctness.

Deliver a substantive `statistical-report.md` with the actual findings and limitations, plus the useful reproducibility artifacts. The optional names are `analysis-results.json`, `analysis-run.json`, `analysis.py` and `analysis.R`; do not create empty placeholders or require both languages. Named scripts, notebooks, figures and tables may accompany them. Prefer structured results with `schemaVersion: 1` and `analyses: [{id, status, method, estimand, n, estimate, interval, pValue, warnings}]`; omit inapplicable fields and use failed/unsupported status with a reason for unavailable calculations. Descriptive summaries do not require a p value or interval. Do not label null or non-finite estimates complete.

A reference-checked helper ships beside the skill: `scripts/analysis_methods.py` (add the skill's `scripts` directory to `sys.path`). It has `compare_groups`, `covariate_balance`, `contingency_test`, `linear_regression`, `logistic_regression`, `kaplan_meier`, `log_rank`, `cox_regression` and `adjust_pvalues`. Each returns one entry shaped for `analysis-results.json` with the diagnostics the data earned (missing values, repeated measurements, censoring, zero cells, separation, covariate imbalance, unadjusted multiplicity), the method record it ran (assumptions, references) and the library versions. A computation the data cannot support comes back `unsupported` with a named reason and no number: keep every other analysis. Use it or your own code with the same care; its diagnostics are labels, never verdicts, and it is not a substitute for choosing the method from the design.

For two independent event rates, the helper uses a Newcombe interval built from Wilson scores for the risk difference, including sparse boundary tables. It records the interval method and uses the observed counts even if an optional continuity correction is requested for odds or risk ratios. Confidence levels must be finite and strictly between zero and one.

For lightweight provenance, use the helper shipped beside this skill:

```bash
python "$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts/run_analysis.py" --workspace . --interpreter python --script analysis.py --input data.csv --results analysis-results.json --receipt analysis-run.json
```

Use `--interpreter r --script analysis.R` for native R; repeat `--input` for sources, `--transform` for persisted state, and `--arg` for script arguments. `--parent` links a follow-up to an existing receipt execution id. The helper records real hashes, versions and output observations per attempt; it selects no method and installs no dependencies. It is provenance, not proof that a statistic is correct. Direct native execution is valid; a missing helper receipt is only a traceability notice.

To carry executed numbers into the report without retyping them, write the report as a template with `{{n:alias.key|format}}` references and call `mcp__evimed__research_calculate` with `action=render`, naming each alias's `{resultsPath, receiptPath}` (the results JSON and its `run_analysis.py` receipt); it writes a new file, and an unresolved reference reads 未计算 rather than a number; numbers typed by hand stay as written and are checked.

For prediction, `scripts/analysis_checks.py` provides `audit_predictions` over
local row dictionaries. Explicitly supply `outcome_column`, `positive_label`,
`negative_label`, `probability_column`, `probability_label`, `split_column` and
`patient_id_column`. CSV labels remain strings. In WDBC, source label **0** is
malignant: a column for class 1 cannot be called malignant probability. An ID
created from row numbers is only an observation key, not evidence that patients
are independent. Preserve patient-group splits when patients repeat.

Keep the training rows in the audit input as well as test predictions; training
probabilities may be absent. Declare each learned stage in `fit_stages` as
`{"name":"scaler","fitIds":[...],"idLevel":"patient","predictors":[...]}`,
including imputation, feature selection, tuning, calibration and the final fit.
These IDs describe the actual fitting data, never an invented clean split.
Supply `predictor_columns`, and count upstream exclusions in `withheld_rows`.
Use the existing dataset-semantics checks for temporal leakage and units too.
If no true patient ID or fitting scope is available, report that limit rather
than claim the audit established absence of leakage.

The audit reports missingness, repeated/duplicate records, train/test patient
overlap, fitting on test observations, target leakage and class/probability
mismatches. Its probability metrics include discrimination, Brier error and
calibration-bin counts/observed rates; the joint calibration intercept and slope
are unavailable when not estimable. Brier is not a pure calibration metric, and
neither a high AUC nor clean declared metadata proves external validity.
Repair the specific problem, recompute affected steps, and retain useful work.

`compare_reported_numbers(results, comparisons)` checks explicit numerical
bindings such as `{"id":"auc","source":["metrics","auc"],"reported":0.923,
"absoluteTolerance":0.0005}`. Use it for the numbers actually inserted into the
report. Unknown/nonfinite values remain not checked; this function does not
certify arbitrary prose. A count of matching bindings is not a claim that all
report sentences or the conversational reply were verified. Keep numerical
results, probabilities and executable model state at full precision; round only
their displayed strings. Label every denominator by its population (full data,
training set, held-out set or complete cases). Recompute each percentage from
that population's actual numerator and denominator, including in the final
reply: the full-data event proportion cannot explain a held-out PPV as though
the two populations had the same proportion. Reuse the executed display strings
in the reply as well as in the report.

Prefer native rendering directly from the numerical
results when `mcp__evimed__research_calculate` is unavailable. Never manufacture a successful
receipt or run unrelated skills merely to eliminate an advisory notice. Once
the requested result is computed, checked and delivered, stop.

An unavailable package, invalid model input, failed extra calculation or formatting error affects that operation. Preserve existing results and code, state the limitation, and use a defensible available alternative when appropriate. Never fabricate an execution, replace a failed estimate with zero, discard a whole package or require human approval to continue. Do not print raw patient rows, credentials, environment dumps or complete process logs into the report.
