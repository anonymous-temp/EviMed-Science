# Heart-rate batch evaluation and the ACTG175 comparison on the public data — 2026-11-09

## Status: run in full on the public sources; nothing here is private input

[RUN-20261107-batch.md](./RUN-20261107-batch.md) built the batch path on a synthetic fixture because the inputs were believed to be private. They are public, so this run fetches them, pins their bytes, and runs the frozen protocol of [RUN-20261105.md](./RUN-20261105.md) through the product's batch path. Every number below was produced by the code at the revision named here; patient rows stay in a local scratch directory outside the repository and are not committed.

## Code and data

- Code: repository commit `e6c2eee3d` (scripts and drivers of this directory; engine and domain as of that tree). R 4.3.3, Node 22.
- Data: [public-data-manifest-20261109.json](./public-data-manifest-20261109.json), fetched by [fetch_public_data.py](./fetch_public_data.py), which refuses any file whose SHA-256 differs.
  - PhysioNet Challenge 2012 (ODC-By 1.0), sets A/B/C `8cb250f1…ca920`, `b1637a2a…c30`, `a4a56b95…ee1`; outcome files `2613ea60…83c`, `1305f297…d5`, `0b32dcb7…c9` (full hashes in the manifest).
  - ACTG175 from CRAN `speff2trial` 1.0.5 (GPL-2), the data member only (2,139 rows; its MD5 equals the package's own `MD5` file entry). The package archive SHA-256 is `ecb35796…4a1`.
- R library: the 68 of the engine's 70 runtime-lock packages the run touches are present at their locked versions; `dosresmeta` and `mixmeta` (used only by `evidence.dose_response`) are not installed on this box, so `r-library.sh verify` itself was not green here and the Docker route of `run.sh` was not used. The drivers were run directly (`prepare.py`, `hr_baseline.py`, `hr_model.R`, `cohort.R`, `actg.R`, `hr_uncertainty.py`, `hr_batch_eval.mjs`) against the local library.

Outputs (private): `hr-model-result.json` `83f54a44…5e2`, `hr-batch-b.json` `ae2f30b7…57`, `hr-batch-c.json` `42c7f708…da`, `hr-uncertainty.json` `20a8888c…a0`, `actg-result.json` `26d3b4a9…36e`, `cohort-result.json` `092124b2…2b2`. These do not equal the 11-05 job hashes because the drivers ran outside the earlier container; the numbers do equal (below).

## Heart rate, 24 h ahead, through the batch path

Task (frozen): last valid HR in hours 0–6 predicts the HR nearest hour 24 (window 23–25 h); a stay missing either is dropped before the batch and counted. One linear equation was fitted by the engine on all of split A (3,753 stays; HR = 37.50 + 0.563 × early HR, residual SD 14.36) and applied unchanged to B and C. Nothing was chosen on B or C. The adapter is local and deterministic (no model, no network); the batch path supplies the batching, ledger and origin cut.

| | B | C |
|---|---|---|
| stays in the split | 4,000 | 4,000 |
| dropped before the batch (no early or no 24 h HR) | 252 | 242 |
| submitted / completed / rejected / failed | 3,748 / 3,748 / 0 / 0 | 3,758 / 3,758 / 0 / 0 |
| forecasts evaluated, missing forecasts, missing outcomes | 3,748, 0, 0 | 3,758, 0, 0 |
| persistence MAE, bpm (95% patient-cluster bootstrap, 200) | 12.600 (12.294–12.953) | 12.378 (12.002–12.766) |
| engine regression MAE, bpm | 11.184 (10.905–11.478) | 10.941 (10.638–11.264) |
| persistence RMSE / regression RMSE, bpm | 16.763 / 14.586 | 16.681 / 14.255 |
| MAE improvement, paired stay bootstrap (500) | 1.415 [1.173, 1.627] | 1.437 [1.219, 1.696] |
| calibration slope of the regression on the outcome | 0.989 [0.939, 1.050] | 0.958 [0.904, 1.007] |

The batch path and the engine's own direct scoring agree to the last digit (MAE 11.1845 and 10.9407), and the counts and intervals reproduce RUN-20261105 (B 3,748/4,000, C 3,758/4,000; improvement intervals [1.173, 1.627]/[1.219, 1.696]). The adapter gives no per-prediction uncertainty and the ledger says so.

## ACTG175 (2,139 participants, 521 composite events)

Outcome: first of a 50% CD4 decline, AIDS progression or death; the three active arms are pooled against zidovudine monotherapy, within one randomized trial. 1,000-day restricted mean survival time difference 85.83 days (95% CI 60.13–111.54); baseline entropy-weighted (ATT, age, weight, sex, CD4) 87.27 days (62.70–112.77), effective sample size 524.3. Equal to RUN-20261105 (85.8338; 87.2654; 524.34). Known-truth `N73b` passed on this checkout (300 simulated trials of 600). The cohort job on the 12,000 PhysioNet stays counted 6,557 aged 65 or more (profile and cohort jobs succeeded), as before.

## What this run shows

- The batch path runs end to end on 8,000 real stays with a complete denominator and gives the same numbers as the direct engine path, so the platform's batching, ledger and evaluation do not change the result.
- A single-predictor regression fitted on A lowers the 24-hour heart-rate error against persistence by about 1.4 bpm in both held-out splits, with calibration slopes near 1.
- The bug that the 11-07 fixture could not reveal: the engine's predictions file is quoted and names its id `patientId`, which the evaluator read as "every forecast missing". Fixed with a regression test.

## What it does not show

- It is not a validation of individual prediction. The task is one lab-like variable, one predictor, one linear fit; the gain is small in absolute terms (about 11% of persistence MAE) and says nothing about trajectories of other variables, other horizons or other populations.
- Splits A, B and C are three 4,000-stay samples of one challenge; they are not independent hospitals or periods, and B and C were inspected in earlier assessments. The intervals cover resampling of fixed predictions only, not training, selection or site variation.
- The batch adapter is a deterministic local function: it tests the pipeline and the metric code, not a forecasting model's behaviour behind a network.
- ACTG175 pools arms inside a randomized trial; it is not an external-control or transportability validation.
- The five-copy synthesis, its scoring and the encoding check of `run.sh` were not rerun here (they are not part of the batch evaluation, need a 6 GB container and the locked image); their results remain those of RUN-20261105.
- No clinical-validation, safety or deployment claim.
