---
name: statistical-analysis
description: Analyze supplied data with executed Python/R, preserve multi-turn state, and return results, tables, figures and reproducible code.
---

# Statistical analysis

The researcher gives a question and data. You own the analysis: inspect the
actual input, choose a suitable installed method, execute, check, and explain.
DeepSeek/DSH handles the conversation and tools; numerical libraries compute the
numbers. Do the work, not an algorithm-selection form or an unevaluated script.

## Work to the question

Start with one primary analysis that answers the question. Return its estimate,
uncertainty when relevant, population/denominator and requested outputs. A small
comparison needs a short report, not a catalogue of tests. Do not add power
simulations, alternative estimators, a methods bibliography, speculative clinical
mechanisms or extended sensitivity sections unless the researcher requested them
or a concrete failure of the primary analysis makes them necessary. One small
independent calculation is usually enough. Stop when the requested work is ready.
A prediction task can require validation; a descriptive task does not require a
predictive model. General data, corpus and exploratory work are valid here.

## Read the data and its meaning

Inspect real files, sheets/tables, types, keys and existing results before coding.
CSV, Excel, JSON and Parquet have different schemas and missing-value conventions.
Repeated exports are not extra participants. Check join cardinality and unmatched
keys; use patient plus encounter keys when the relation needs both. A document
chunk/embedding table is a corpus, not a clinical cohort. Use selected columns or
batches for large inputs; do not dump private rows into the conversation.

Read established meaning with `mcp__evimed__dataset_semantics` (`read`). Preserve
researcher-confirmed meanings; record corrections and derived variables with
`write`/`transform`, and check drift when new data arrives. If that service is
unavailable, continue from the files and disclose the missing check. Keep source
snapshots unchanged and derived files separate. An unfetched URL is not data.

Infer the estimand, independent unit, coding, units and analysis population from
the question/dictionary. Ask only when an ambiguity changes the answer and cannot
be resolved from supplied material. A row or unique ID does not prove independence,
absence of clustering, absence of time-dependent bias or noninformative censoring.
Name unobserved design assumptions; do not invent absent treatment/event histories.
Separate observed table facts, quoted source statements and unverified hypotheses
in quality findings (use `evidenceBasis` when useful). Cross-view correspondence
does not reveal how a file was produced; all-zero indicators may include reference
categories or unknowns. Missingness associated with observed outcomes does not
identify MAR/MNAR. Preserve contradictory ranges literally and mark them unknown;
do not reorder endpoints or invent units, averaging rules or clinical dose limits.
Coding coverage is not clinical applicability. Hashing an identifier does not
establish the patient/episode identity that identifier represents.

## Execute and check

Use the installed scientific libraries and relevant skills. Native Python/R is
open-ended; the nine reference helpers are optional components, not a capability
boundary. Do not install unpinned packages during a research turn. Locate helpers
at `$EVIMED_CAPABILITY_SKILLS_DIR/statistical-analysis/scripts`, beside this skill
otherwise. Read `references/execution.md` only for the helper or continuity details
needed now; do not perform every workflow it describes.

Check execution, effect direction, denominators, exclusions, missingness and
material warnings. Preserve working results if another calculation fails. Obtain
reported numbers from executed outputs, keep full precision in machine-readable
results, and round only display strings. A successful script is not scientific
verification. A diagnostic that fails to reject its null does not prove the
assumption. Nonsignificance is not equivalence or proof of no effect; p values
do not establish importance or causation. Different tests
can address different nulls, so their agreement need not establish robustness.
Permutation tests need the relevant exchangeability/randomization; signed-rank
location interpretations need symmetry. Do not label an arbitrary sample median
as a signed-rank effect estimate. Finite-cohort missing-outcome scenarios are not
population bounds, confidence intervals or comparable uncertainty components.

For prediction, keep learned preprocessing/selection/tuning/calibration inside
training folds, preserve splits and probabilities, and label the positive class
explicitly. Use `analysis_checks.audit_predictions` when its declared checks fit;
it does not prove absence of every leakage risk or external validity.

For survival plots, use a library's complete timeline including censor-only
times, carry the curve through the last follow-up, and check event/censor totals
and risk sets against the input. `analysis_checks.audit_survival_curve` checks a
complete static-cohort table; delayed entry, weights or competing-risk estimands
need their own scope. A correct landmark estimate does not validate a whole plot.
For all-cause death, transplantation or a treatment change is not automatically
a competing event: death can still occur afterwards. If death follow-up stops,
consider potentially informative censoring, without inventing a bias direction.
Competing-event definitions depend on the endpoint. Keep Greenwood's cumulative
term distinct from Var(S), which is S squared times that term (and SE squared).

When a report goes beyond directly counted facts and arithmetic cannot check its interpretation, use a
brief read-only review by an available native subagent when useful: have it read
the primary report, executed results and plotted data, checking estimand, units,
denominators, null hypotheses and source-supported limitations. Review existing
work, do not request extra analyses. Correct supported findings in place and
retain useful results and explicit uncertainty; this is not a delivery veto.

## Continue without losing valid work

Read prior results, code, data fingerprints, split and fitted state. Reuse only
compatible state and rerun only affected steps. Unit-only and fixed-threshold
changes must not retrain a model. For linear unit conversion, use
`analysis_checks.convert_result_units` to deep-copy JSON and update explicit
numeric/unit paths; preserve method labels, diagnostics, p values and counts.
Variances need a squared factor separately. Check unchanged metadata against the
original. A threshold change reuses saved probabilities. New patients or corrected
labels require deliberate invalidation. The optional `analysis_session.py` step
graph and `run_analysis.py` receipts retain dependencies, hashes and history.
Say what the continuation actually did: a statistic recomputed as a check was
recomputed, even if its prior result was also reused.

## Return usable outputs

Give a concise answer plus `statistical-report.md`, executed `analysis-results.json`
and useful code/receipts. Prefer `schemaVersion: 1` and
`analyses: [{id,status,method,estimand,n,estimate,interval,pValue,warnings}]`;
omit inapplicable fields, explain partial/unsupported values, never fake a number.
`research_calculate(action=render)` can bind display strings to executed JSON.

For requested figures, save an actual PNG preview and useful SVG/PDF; use headless
plotting, clear labels/units and suitable uncertainty. Save the exact plotted data
as CSV/JSON, check the image opens and the plot matches those arrays. Optional
interactive HTML is an additional download. Never claim a plot exists when it
failed. Do not overwrite prior results on a follow-up.

Write a small `analysis-output.json` with `schemaVersion: 1`, `summary`,
`tables: [{path,title}]`, `figures: [{path,title,dataPath,caption}]`, and `code: [path]`.
Paths must name actual files relative to the workspace or this manifest's folder.
The API validates files and returns download URLs; do not invent URLs yourself.
This index is not scientific proof or permission to read another workspace.

Keep private data and source credentials in their authorized boundary. Use only
exposed tools; an optional external catalogue does not authorize sending patient
rows elsewhere. Do not replace useful partial work with a stub or require human
approval to deliver it. State material limits in both the report and final reply.
