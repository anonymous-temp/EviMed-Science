# Statistical Analysis 1.4.0: real Agent continuity and result checks

This round implements the three requested priorities: natural multi-turn Agent
acceptance, reusable analysis state, and stronger checks before adding algorithms.
The model still chooses the method and writes/executes Python or R. The new
helpers neither schedule work nor decide platform delivery.

## Delivered changes

- `analysis_session.py`: an optional workspace step graph. Data, code, semantic
  context, arguments, numerical-library versions, upstream outputs and the latest
  execution receipt determine reuse. Missing/changed outputs, failed attempts and
  stale receipts invalidate affected steps. Unrelated branches remain reusable.
  Unknown manifest fields are rejected, so a misspelled unit/grouping field cannot
  silently escape the signature. Prior results and failure history survive.
- `analysis_checks.py`: explicit outcome/probability coding; patient overlap,
  fitting-stage contamination, target/identifier/split/probability predictors;
  missingness, duplicates and repeated observations; held-out discrimination,
  probability error and calibration diagnostics; exact bound report-number checks.
  Empty or unavailable evidence is not a clean result. No raw patient rows/IDs are
  emitted. Findings preserve useful partial work and do not veto delivery.
- The skill now locates its shipped helpers directly, keeps the workflow
  proportional, distinguishes training/test/whole-data denominators, and forbids
  refitting or running the original pipeline merely to refresh provenance during
  unit/threshold changes. Full precision belongs in numerical/fitted state;
  rounding belongs in display strings.
- The live driver uses real unbound conversations and automated test turns,
  uploads extra data at the relevant turn, captures before continuing, waits for
  cancellation, and deletes its throwaway accounts. Structural evidence,
  independent numbers and state reuse have separate verdicts.
- `pnpm test:statistical-analysis` runs the scientific checks and live-driver
  regressions in the ordinary Web CI, with the same scientific-library pins
  already installed in the runtime.

## What was actually run

Real control plane, real DeepSeek gateway calls (`deepseek-flash`), the pinned
DSH kernel and existing research MCP ran locally. The kernel provider was the
repository's **host-kernel acceptance harness**. This is not a production-image,
native-browser or deployment acceptance claim. The result-replay service was
available; the host analysis environment lacked matplotlib, and the Agent
preserved its numerical work and used available figure alternatives. The saved
prediction pipeline was independently loaded only inside a read-only,
no-network Docker sandbox without provider credentials.

Five cases completed **11 turns**; all five accounts were deleted. Independent
judging checked **83 bound numerical quantities**, including explicitly declared
rounding bounds. These are checks of selected quantities, not a claim that every
sentence or every possible scientific assumption is correct.

| Case | Turns | Observed outcome | Qualification / follow-through |
| --- | ---: | --- | --- |
| Continuity | 4 | Chose/executed a comparison; converted mm to cm; incorporated a supplementary file; answered the final follow-up from existing results | The first unit follow-up unnecessarily reran the full pipeline. Correct numbers did not make this a selective-recompute pass. The final cached-unit case closes that finding. |
| Group correction | 2 | Same 80 subjects and measurements; corrected A/B labels reversed the estimate and interval direction, preserving p and counts | Native script/schema errors were diagnosed and corrected during real execution. The canonical state helper was used, with append-only execution history. |
| Prediction | 2 | Training/test split, trained preprocessing and saved model; fixed-threshold follow-up retained model and predictions | Primary numerical results passed. Whole-data prevalence was incorrectly used in one held-out PPV explanation; reconciliation closes that report-scope finding. |
| Reconciliation | 1 | Recomputed from existing predictions, corrected the population/denominator statements and retained a correction log | No classifier was refitted. Missing files in the deliberately reduced review input are transfer-context limitations, not missing outputs from the original prediction run. |
| Cached-unit replay | 2 | Restored the prior executed package; converted cached values using new conversion/check scripts | All 15 archive files remained byte-identical in both snapshots. Six critical numerical/code/data files also retained their modification times. No original analysis or `run_all` execution occurred. |

Natural contextual turns legitimately routed to `open-domain-answer`; initial
new analyses routed to `statistical-analysis`. Routing was observed, never forced
to make an acceptance pass. The driver originally rejected a valid new filename
(`operating-point-0.3.json`) and a valid ordinary-conversation audit. Those
instrument defects were fixed with regressions; the raw original records were
not rewritten. See `structural-reassessment.json` for the separate reassessment.
Resume itself still requires `cached-unit/state-verdict.json`; a successful shell
call or a file named “state” is not proof that computation was reused.

## Independent numerical and state evidence

- Original B−A mean difference: **2.959987625 mm**, 95% CI
  **[2.315310399, 3.604664851]**, 40 subjects per group. The group correction
  gives the negative difference and reversed negative endpoints.
- Supplement: **101 raw rows → 100 unique synthetic patients → 98 complete
  outcomes**, A/B 49 each. One repeated export and two missing outcomes were
  handled explicitly. Updated difference: about **0.3035626 cm**, 95% CI
  **[0.2458963, 0.3612288]**. The last follow-up made no workspace changes.
- Prediction: **398 training / 171 held-out rows**, with **64 malignant**
  held-out observations. Source class **0** means malignant. Independent saved
  pipeline replay reproduced **AUC 0.9932827103**, **AP 0.9919386387**,
  **Brier 0.0215783750**, and calibration intercept **−0.0027811219** / slope
  **1.1538054500**. The calibration calculation has an epsilon guard, but it
  changed zero held-out probabilities in this replay.
- Threshold 0.3: **TP 62 / FN 2 / FP 6 / TN 101**. Model bytes, fitted-state
  bytes, prediction bytes and their modification times remained unchanged.
  Training-only scaler means/variances independently matched the source rows;
  predictor exclusions and source identities/labels also matched. Source review
  found training-fold preprocessing inside the CV pipeline. These checks do not
  certify every possible temporal leakage risk or external validity.
- The report correction distinguishes **212/569 = 37.3%** (whole data),
  **148/398 = 37.2%** (training), and **64/171 = 37.4%** (held-out). PPV at 0.5
  is **62/63**, not sensitivity's **62/64**. The original wording defect and the
  corrected report/C1 log are retained rather than hidden by a numerical pass.

The final cached conversion used an older numerical artifact rounded to six
decimals in mm, then displayed cm to six decimals. Its combined absolute rounding
bound is `0.1 × 0.5e-6 + 0.5e-6`; the initial overly tight evaluator verdict is
preserved in the archive. No statistic was changed to satisfy the checker.

## Reproduction and limits

`acceptance.json` records run IDs, routes, durations, tool counts, cleanup,
source digests and archive SHA-256. Extract `captured-workspaces.tar.gz` to recover
the raw run records, replies, manifests and workspace snapshots under
`captured/<captureDirectory>/`. Full reasoning-bearing transcripts are retained
only in local acceptance evidence; the archive's raw run records include tool
names, statuses and bounded inputs/outputs. Evaluator bindings and verdicts are
plain JSON in each case folder; replay with `live/judge.py` after extraction.
Bindings never entered the Agent workspace. The model replay receipt separately
records its inputs and numerical-library versions. The artifact archive's 334
text files were scanned for credential patterns; none were found.

Final focused verification: **179 Python tests**, **11 driver tests**, and
the statistical capability/domain contracts. The deployment-configuration
contract suite passed 75 tests on macOS; its existing empty-array Bash test
requires GNU Bash and passed separately in a Linux Node container. Independent
specification, Python and JavaScript reviews approved the source/evaluators.
CI registration was added; a local result is not a claim that GitHub CI has run.

The original eight candidate turns preceded the final role-column diagnostics
and stricter report-scope/reuse wording; the later three turns exercise the
targeted corrections, and final source regressions cover the additional checks.
The initial comparison still over-expanded its methods and took minutes.
Latency, avoiding unnecessary sensitivities, larger/longitudinal/multicentre
data, privacy controls on real patient data, and actual image/browser journeys
remain further evaluation work. No production deployment, production data
change, new external analysis service or advanced algorithm was introduced.

Method references: [scikit-learn leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html),
[probability calibration](https://scikit-learn.org/stable/modules/calibration.html),
and [Brier score](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.brier_score_loss.html).
