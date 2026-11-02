# Data Analysis API evaluation

Last updated: 2026-11-02.

This is a development evaluation of the existing DeepSeek + DSH analysis agent
through the [Data Analysis API](../../../docs/DATA_ANALYSIS_API.md). The agent
chooses and executes scientific Python/R code; the nine bundled helper methods
are reusable components, not the boundary of supported research questions.
Successful execution, correct primary numbers, complete delivery, correct
figures, interpretation and state reuse are separate findings.

The [acceptance ledger](results/acceptance.json) retains all 19 observed public
or synthetic attempts in this snapshot: 14 completed analyses, one verified
cancellation with partial output, one successful seeded delivery smoke, and
three failed attempts. These cover nine analytical scenarios and one delivery
scenario; the precomputed smoke is not a successful research study,
and no aggregate scientific pass rate is claimed. The selected datasets and
questions are development tests, not a full BixBench score or external clinical
validation. CI, merge, release-image verification and production deployment are
not established by this record.

## Inputs and reference answers

[cases.json](cases.json) contains the research questions. Only the question and
its input files reach the agent. Keep evaluator bindings, reference answers and
judge code outside its workspace. Public source bytes, transformations, package
versions, hashes and licenses are recorded in [datasets.json](datasets.json) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the reused WDBC/lung fixtures
retain their [original source manifest](../fixtures/source-manifest.json).

| Input | Source and evaluation purpose |
| --- | --- |
| Heart failure | UCI, CC BY 4.0; censoring, 90-day survival, full curve and risk counts |
| Sleep | R 4.2.2 `datasets`; 10 paired subjects and a display-only hours-to-minutes continuation |
| ToothGrowth | R 4.2.2 `datasets`; categorical dose-by-supplement interaction in an animal experiment |
| PBC | R `survival` 3.5-3; randomized versus additional observational participants, distinct transplant/death codes |
| WDBC | Frozen parent fixture; positive-class coding, held-out prediction, train-only preprocessing and threshold continuation |
| Lung | Frozen parent R `survival` fixture; native R execution, censoring codes and full unadjusted population |
| Diagnostic interpretation | Synthetic fixture from `../live/fixtures`; mean difference and the limits of assumption tests |
| Nested bundle delivery | MIT-licensed repository-owned ZIP with eight precomputed files, current version 3 and nested version 2; delivery selection only, no participant records or scientific claim |

The heart-failure CSV, XLSX, table-oriented JSON and Parquet representations
describe the same cohort. [format-manifest.json](fixtures/format-manifest.json)
records the conversions. `test_public_data.py` tests the installed library paths
for these four formats, including subject codes and missing values. Library
round trips are separate from the live equivalent-format scenario, which has
now passed the bounded checks described below. `continuity-supplement` was used
for cancellation acceptance; its partial output does not establish a completed
supplement or continuation analysis.

## Run on a local candidate

Use an isolated Linux control plane with PostgreSQL, the real model gateway and
the existing `DockerRuntimeProvider`, configured as in the API documentation.
Enable `OPEN_SCIENCE_DATA_ANALYSIS_API_ENABLED`, use the candidate runtime image
and mounted candidate skills, and keep provider credentials in the control
plane. Disable learning, evolution and LoopX for finite evaluation accounts.
The driver requires local throwaway-account authentication and accepts loopback
origins only. It does not provision a server or deploy the candidate.

Run from `OpenScience/`. Use an output directory outside Git. `--data` is the
local candidate control plane's actual data root, not the input-fixture directory.

```bash
node evals/statistical-analysis/api/run.mjs \
  --case paired-sleep \
  --base http://127.0.0.1:8787 \
  --data /tmp/evimed-analysis-candidate/data \
  --out /tmp/evimed-analysis-evidence
```

The driver creates an isolated account, creates an analysis and scoped key,
uploads inputs, repeats idempotent requests, waits for each turn, downloads and
hash-checks every exposed artifact, then re-downloads earlier artifact IDs after
continuation. A turn has a 15-minute limit and requests cancellation on timeout.
Failures and cleanup outcomes remain in `run.json`; dependent turns stop after a
failed attempt. Bounded transport retries preserve request identity and record
retry events. A completed record is runtime/capture evidence only.

For authorized private fixtures, place both the case specification and fixtures
outside the checkout, and add `--spec /private/path/cases.json --fixture-root
/private/path/fixtures` to the command. File paths in the specification resolve
under that explicit fixture root. Keep its questions, outputs and outcomes
outside Git as well. This published ledger contains no private study results.

`--data` also captures local raw transcripts, which may contain inputs and model
output. Always keep the entire `--out` directory outside Git. Do not publish raw
transcripts, generated full reports, model pickles/joblib files or private data.
The repository ledger contains only selected public/synthetic metadata and
independent findings.

To test cancellation after a useful output first appears, add
`--cancel-after-output true` and supply `--data`. The driver watches for a
changed CSV/JSON/PNG under `deliverables/`, requests cancellation, and requires
both a settled cancelled status and downloadable partial output. The recorded
synthetic cancellation attempt passed this narrow lifecycle/capture check;
it did not complete the analysis or produce a final summary.

All recorded attempts used the local Linux control plane and actual Docker
runtime. The initial diagnostic used `live/run.mjs`, whose raw `environment`
field retains an inaccurate legacy host-kernel label. The coordinating
operator's execution receipt records that driver running inside
`evimed-analysis-api-cp` against the ordinary control plane and
`DockerRuntimeProvider`; the ledger preserves both the raw label and this
correction. Subsequent API-driver records identify that topology directly.
Later receipts identify `deepseek-flash`, DSH `0.2.1-rc.5`, no runtime network
egress, and `imageVerified: false`. These are observations from those runs, not
new dependency pins or production-image qualification.

## Independent verification

Run deterministic checks with Python packages used by the fixtures and judge
(pandas, NumPy, SciPy, statsmodels, pytest, Pillow, matplotlib, openpyxl and
pyarrow) and R with `survival` and `jsonlite` available:

```bash
python3 -m pytest evals/statistical-analysis/api -q
node --test evals/statistical-analysis/api/transport.test.mjs
```

After inspecting a run's returned schema, bind every required primary quantity
to its actual JSON field. The checked-in `results/*-bindings.json` describe the
original matching attempts; do not assume later outputs reuse those paths.

```bash
python3 evals/statistical-analysis/api/judge.py \
  --artifacts /tmp/evimed-analysis-evidence/paired-sleep-TIMESTAMP \
  --bindings evals/statistical-analysis/api/results/paired-sleep-bindings.json \
  --out /tmp/evimed-analysis-evidence/paired-primary-verdict.json
```

`judge.py` compares required primary values against SciPy or native R references,
checks downloaded bytes against their hashes, and checks PNG/SVG readability.
Its pass scope excludes prose, plot semantics, supplemental methods, leakage and
state reuse. A readable survival plot may still omit censoring or truncate its
tail. Compare all curve steps, confidence limits, risk counts and plotted tables;
review the actual labels and report separately. In the lung output, exclude
`reported_timepoint` summary rows before comparing the full step timeline.

For prediction, `replay_model.py` checks source-row identities, held-out
assignment, train-only scaler parameters, saved-pipeline probabilities, AUC,
Brier and the threshold-0.3 confusion matrix. It deserializes an untrusted model:
run it only in a disposable container without network, credentials or sensitive
mounts, using copies of the public fixtures. It is tailored to the original
WDBC artifact schema. Hash retention alone does not prove no retraining; also
inspect execution history and compare model, split and probability state.

## Observed attempts and limits

Attempt IDs below are relative to the local evidence root's `results/`. The
machine ledger records the `run.json` digest and observed turn metadata for each
one. Scientific findings are separately recorded independent-review findings;
they are not inferred from a run's `succeeded` status.

| Attempt | Observed result and acceptance limit |
| --- | --- |
| `initial/diagnostic-interpretation-1793590252043` | Completed, 83 tool calls. Primary Welch result correct and variance-test interpretation improved. Unrequested supplementary methods and an insufficient permutation caveat prevent full acceptance. |
| `api/paired-sleep-1793591183044` | Failed before a run was created: `invalid_research_session`. Actual session-store input was corrected; this failed attempt remains retained. |
| `api/paired-sleep-1793591375341` | Two completed turns; 10 primary numerical checks and PNG readability passed. Wilcoxon was incorrectly interpreted as a median test. |
| `api/heart-survival-1793591471802` | Seven primary numerical checks passed. Plot represented only 30 of 203 censors and ended at day 241 rather than 285: failed figure semantics. |
| `api/lung-native-r-1793592367465` | Actual R execution; eight primary checks and the complete 187-row timeline (186 nonzero times plus origin) verified, with 165 deaths, 63 censors and maximum day 1022. Extra `reported_timepoint` rows require filtering. No blanket prose verdict. |
| `api/factorial-tooth-1793592367465` | Three primary sample-size/interaction F/p checks passed. Supplementary permutation-null reasoning and the Type II/III equivalence claim were wrong. |
| `api/pbc-population-1793592840625` | Primary 312 randomized/106 observational counts and outcome coding correct. Nested tables and extra figures were absent from the old API capture; complete delivery unverified. |
| `api/wdbc-prediction-1793592840625` | Two turns; independent saved-pipeline replay passed for the selected quantities below. First-turn nested ROC/calibration figures were absent from the API manifest. |
| `final/paired-sleep-1793593688295` | Primary estimates correct, but continuation overwrote a diagnostic method label with Hodges-Lehmann. Metadata continuity failed. |
| `final/heart-survival-1793593688295` | Full 149-time curve correct: 96 deaths, 203 censors, maximum day 285. Scenario-width versus confidence-interval interpretation and all-cause/competing-risk prose remained wrong. |
| `final/wdbc-prediction-1793594972528` | Transport `fetch failed`; no settled turn capture. Retained as a failed attempt, with no numerical verdict. |
| `closure/paired-sleep-1793594972528` | Transport `fetch failed`; no settled turn capture. Retained as a failed attempt, with no numerical verdict. |
| `compact/paired-sleep-1793596288416` | Two turns; primary estimates, exact 60-fold display conversion, all analysis metadata/diagnostics and four plotted/subject tables preserved. Independent review gave bounded approval. All 16 earlier API artifacts were rechecked after continuation. |
| `compact/heart-survival-1793596288416` | Primary estimates correct; all 148 nonzero-time survival/CI rows matched R within 5e-11. All-cause/competing-risk wording and a cumulative Greenwood term mislabeled as variance remained; no full scientific pass. |
| `closure/equivalent-formats-1793602972343` | Completed with 13 artifacts, including PNG/SVG encodings of one four-panel figure. Independently verified all requested metrics, the identical 299-record union, comparison tables and all 12 plotted rows. Captured artifact sizes/hashes and figure readability passed; PNG labels and values were visually inspected. Approval is limited to data consistency and the inspected outputs. |
| `closure/continuity-supplement-1793602972343` | Intentionally cancelled after output appeared. Settled `canceled` with six frozen, hash-verified partial artifacts, including readable PNG/SVG; all carry `verification: unverified`. Missing manifest and summary are explicit notices. Cancellation/partial-output acceptance passed; numerical, interpretation and continuation acceptance are not claimed. |
| `verified/heart-survival-1793605363453` | Completed with 13 artifacts and PNG/SVG encodings of one figure. Independent R comparison, full curve, risk table and visual inspection passed. Earlier censoring/tail, Greenwood-scale and competing-risk defects were resolved; the scenario-range ranking claim was absent. Three report wording/version corrections remain. Generated code implemented its own KM and compared with lifelines; this does not prove a call to helper KM 1.1.0. |
| `verified/wdbc-prediction-1793605362329` | Bounded independent pass for saved-model replay, selected metrics/intervals, full saved ROC/calibration data, four PNG visuals and threshold-0.3 reuse without observed refitting. Two turns returned 23 and 17 artifacts; all 40 sizes/hashes matched, and all 23 first-turn artifacts were rechecked after continuation. Four medium and two low report/metadata findings remain; no external-validity or full model-selection-replication claim. |
| `verified/nested-bundle-delivery-1793606110320` | Seeded delivery smoke after restarting the candidate control plane with the selection fix. The API selected version 3 summary/results and retained nested version 2 as attachments, with an explicit `nested_output_bundles` notice. All eight returned files exactly matched the public input ZIP. Delivery acceptance only; no scientific analysis was performed. |

The original WDBC replay used 398 training and 171 test rows, including 64
malignant test cases. AUC was 0.9861273364485981 and Brier score
0.025121328509196017. At threshold 0.3, TN/FP/FN/TP were 106/1/4/60. The saved
scaler matched training-only source statistics and the pipeline reproduced
saved probabilities. This verifies the selected fitted state and primary
metrics, not external validity, all narrative claims or missing figures.

The separate final WDBC attempt also used 398 training and 171 test rows, with
64 malignant test cases. Independent replay reproduced its saved split,
training-only imputer/scaler parameters and probabilities (maximum difference
1.11e-16). Its AUC was 0.9969334112149533 and Brier score
0.02000730202643435; at threshold 0.3, TN/FP/FN/TP were 101/6/1/63. The review
reproduced 2,000 AUC/Brier bootstrap replicates, all 10 saved ROC coordinates,
10 calibration bins and 201 threshold-sweep rows. Four PNGs were visually
reviewed; SVG/PDF were not separately rendered. Tool history and unchanged
model/split/probability hashes supported no refitting during the follow-up.
The reviewer replayed the saved pipeline in an isolated no-network container;
the full hyperparameter search was not independently repeated.

Four medium-severity WDBC report/metadata corrections remain:

- Describe one fixed holdout split and model specification, with implementation
  and plotting reruns; the recorded constant `testSetEvaluations=1` does not
  establish one physical test-set evaluation.
- State verified row-level separation, leaving patient-level independence as a
  source/design assumption unless patient identity is verified.
- Remove the claim that similar training-CV and holdout scores exclude a
  favorable split; this is one split without external validation.
- Label intervals per metric: AUC/Brier bootstrap, calibration intercept/slope
  logistic Wald, and calibration bins Wilson. Disclose the clipping to
  `[1e-6, 0.999999]` before the calibration logit transform (16 rows affected).

Two lower-severity corrections also remain: saved probabilities drove the
follow-up decisions, but `predict_proba` was rerun for verification without
refitting; the general range of Youden's J is -1 to 1, not 0 to 1. These warnings
are retained alongside the bounded numerical and reuse pass.

The equivalent-format comparison independently reproduced 299 rows, 96
`DEATH_EVENT=1` records, mean serum creatinine 1.3938795986622072 in source units,
and zero missing serum-creatinine values in each format. All three parsed
tables matched the frozen CSV exactly. Each pair compared 3,887 cells with zero
differences; the naive 897-row stack contains 598 duplicate exports and a union
of 299 distinct record vectors. No patient identifier is present, so this
verifies record equivalence rather than independently verified patient identity.
The 13 returned artifacts and six cancelled-run artifacts were independently
checked against both the captured API manifest and downloaded bytes; no new
HTTP re-download was possible after account cleanup. No generated code was
executed for these checks.

The final heart-failure review used R 4.6.0 with `survival` 3.8.6. It reproduced
90-day survival 0.7626795340593714, a 95% log-log interval of
0.7092429420863027 to 0.8076422418121261, Greenwood variance
0.0006270961172106266 and 189 at risk. All 148 nonzero-time rows through day 285
and eight risk-table rows matched the source; survival and confidence-limit
differences from R were below 5e-11. Report corrections remain: Python is
3.11.2 in the observed session information but 3.11.14 in prose; variable
follow-up alone cannot distinguish a common administrative cutoff from other
censoring mechanisms; metadata absent from this CSV is not the same as unknown
dataset provenance. These residuals prevent an unqualified report pass.

## Local implementation checks

The coordinating execution reports the following local checks. They are
separate from the live model's scientific findings and production readiness.

| Check | Recorded result and scope |
| --- | --- |
| `python -m pytest evals/statistical-analysis -q -p no:cacheprovider -rs` | 226 tests and 26 subtests passed in the final candidate image, with network disabled and read-only mounts for current code/wheels. Fourteen existing matplotlib/pyparsing warnings remained. |
| `node --test apps/server/test/dataAnalysisAdmission.integration.test.mjs` | One test passed against an isolated loopback PostgreSQL sidecar: four parallel admissions with a metadata pool of one. (The native-workspace allocator that shared this run was removed on 2026-11-02; a catalogue click opens a conversation in the current project.) |
| `dataAnalysisArtifacts.test.mjs` | Eight focused regression tests passed, covering nested artifact capture and coherent selection of current, archived and explicitly presented result bundles without mixing summary/results from different bundles. |
| Final source reviews | Helper changes, TypeScript and security review were approved after the result-selection fix. These are source-review outcomes, not live scientific or deployment approval. |

The generic result-selection fix also passed the separate public seeded
delivery smoke after the candidate control plane restarted. Its eight files
were checked against [revision-package.zip](fixtures/revision-package.zip),
with the current summary and structured results selected coherently. This
tests selection and preservation, not newly generated scientific estimates.

## Remaining closure

- Correct and recheck the final WDBC report/metadata findings. Its saved-state,
  numerical, plotted-data and follow-up reuse checks have bounded independent
  passing evidence; the full model-selection process was not replicated.
- Correct and recheck the three final heart-report wording/version findings.
  Its primary calculations, full curve and earlier blockers have separate
  independent passing evidence.
- Preserve the original factorial and diagnostic supplementary-method findings;
  the paired continuation's bounded approval does not resolve them. Recheck PBC
  nested delivery separately if claiming complete PBC output coverage.
- A completed supplement/continuation analysis remains untested in these lanes;
  the deliberately cancelled `continuity-supplement` attempt only verifies
  preservation and honest labeling of partial output.

Update this dated snapshot only with new evidence. Keep previous failures and
their source digests; append new attempts without selecting away bad outcomes.
