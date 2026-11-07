# Temporal patient-state models — data inventory and frozen protocol (plan T11)

Status 2026-11-07: **not started.** No dataset on hand records administered treatments with times and later outcomes under
rights that allow training, so the first T11 box (an authorized longitudinal treatment/outcome dataset) is open, and the
remaining boxes wait on it. This file is the protocol a run must freeze before tuning anything, and the inventory that says why
nothing has been trained. It is research scaffolding, not a product capability; nothing in the five entrances depends on it.

## 1. Questions (plan section 8)

- **H1** a learned latent state/transition beats persistence and a strong task-specific baseline at multi-step factual
  forecasting, at the same information boundary.
- **H2** action conditioning improves forecasts beyond history, severity and treatment-selection correlation (still factual
  evidence, not a causal effect).
- **H3** a mechanism-informed hybrid improves a named endpoint or robustness metric over each of its components.
- **H4** the model stays useful when an optimizer searches its outputs, not only on typical held-out cases.

"JEPA does not improve this task" is a legitimate, publishable outcome of every arm.

## 2. Data inventory

| Source | Where | Actions with times? | Outcomes over time? | Usable for | Not usable for |
| --- | --- | --- | --- | --- | --- |
| PhysioNet/CinC 2012 sets A/B/C (12,000 ICU stays, first 48 h) | owner's machine only (private inputs of `vcr-professional-plugins/RUN-20261105.md`); not on the dev box | no administration records (a ventilation indicator only) | vitals/labs hourly-irregular, in-hospital death | H1 factual forecasting of vitals; the existing HR baseline (MAE 11.18/10.94 bpm vs persistence 12.60/12.38) is the regression bar | H2–H4: there is no treatment action to condition on. Stays, not people: a stay split is labelled as such |
| ACTG 175 (2,139 participants) | owner's machine only | randomized arm fixed at baseline, no time-varying dosing | CD4 at baseline, ~20 and ~96 weeks; composite event | two-time-point arm-conditioned models; known randomization helps a causal check of a fixed-arm contrast | sequence models of actions; the composite (CD4 decline, AIDS, death) is not death alone |
| Patient-matching corpora (TrialGPT, TREC, n2c2) | matching workstream | no | no | nothing here | everything here: excluded by plan section 10 |
| Recruitment partner pre-enrolment / post-exit records | partner systems | no in-trial treatment | no in-trial outcome | matching, population description | inferring hidden in-trial states (plan section 8) |

Candidates that would satisfy the first box, each needing its own access, data-use and training/serving rights checked per
artifact before any transfer (plan section 8; existing n2c2 permission covers none of them): credentialed ICU databases with
medication administration timestamps (e.g. MIMIC-IV `inputevents`/`emar`, eICU-CRD, AmsterdamUMCdb, HiRID); a disease registry or
trial consortium dataset with dated dosing and repeated endpoints (for the first disease pack, the Alzheimer ADAS-cog line,
patient-level CAMD/ADNI-type data). None has been requested or downloaded in this round.

## 3. Protocol to freeze before tuning

1. **Units and splits.** Split by recoverable person identity first, then reserve later time or another site. Keep training,
   calibration, model selection and final test apart; challenge splits that have been looked at are development evidence.
2. **Anchors and availability.** Each prediction has an anchor time; only data *available* by then (documentation time, not
   occurrence time) enters. Logged-action replay is scored apart from a deployable forecast. Tests: a post-anchor lab value and a
   later-charted medication must not change the prediction.
3. **Actions.** Administered exposure with its timestamps; orders, recommendations and intentions are different events. Missing
   observations and observation frequency are modelled, never read as normal values.
4. **Arms with identical information.** Persistence; the current prognostic/trajectory baseline; a non-JEPA temporal model;
   a JEPA-style latent-transition model (encoder reuse, limited adaptation and joint training before any scale-up); a hybrid
   only when a concrete mechanism mapping exists. Same inputs, targets, tuning budget and test split.
5. **Readouts.** Typed clinical readouts from the latent state and an explicit initial-state population mechanism; no clinical
   value is read off an embedding coordinate.
6. **Metrics, on the full frozen denominator.** Multi-horizon MAE/RMSE; event discrimination, Brier and calibration; interval
   coverage where an interval exists; rollout drift; subgroup results; missing-input tolerance; action removal/shuffling controls;
   out-of-distribution behaviour. Output coverage and failures are counted against every frozen input.
7. **Resource probe first.** A bounded training probe produces the costed full-run manifest (GPU hours, memory, storage) before a
   full run is proposed; the manifest emits the exact commands and caps.
8. **Promotion.** Factual forecasting, model-conditional scenarios and independently evaluated intervention comparison stay three
   separate claims. A model without a measured gain may stay runnable as an explicitly experimental candidate (plan T12); a
   default recommendation never claims a gain the comparison did not show.

## 4. What must happen before T11 starts

- An owner decision on which dataset to request, and its access and rights record (data use, training, inference, serving).
- The frozen items of section 3 written into a run manifest beside this file.
- A place to train: the dev box has no GPU and about 1 GB free on `/home`; the serving host is shared. A separate machine is a
  resource decision, not part of this plan.
