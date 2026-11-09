# Frozen protocol: does a person's own history improve the forecast for that person? (plan R33)

Frozen on 2026-11-09, before the first evaluation run. The machine-readable half is `protocol.json` (data hashes, folds, windows, bootstrap
seed); `run_individual.R` is the only code that produces the result, and it refuses to run on bytes whose SHA-256 is not the one written here.
The RUN file (`RUN-<date>.md`) states the commit this protocol was committed in and the hashes of the three files it ran with.

## What is being tested

Plan C.3 separates three claims. This evaluation tests only the third on real data:

1. 「生成一批虚拟患者」: distributional fidelity (not tested here; N-cases and `population.check`).
2. 「为真实患者做群体模型预测」: a forecast from baseline covariates alone (the `popmodel` arm below).
3. 「用每个人的历史个体化」: the same population model conditioned on the person's own earlier observations (the `eb` arm).

The beta_logit (Alzheimer) individualization is **not** evaluated on real data: no open individual-level AD data exists without an ADNI
application. It is validated by known-truth simulation only (numeric case N130d-e: the Laplace posterior against a grid, coverage of held-out
visits on simulated people). Nothing about it is claimed beyond that.

## Data (all public, hashes in `protocol.json`)

| Dataset | Role | Source | Outcome (scale) | History (known at the origin) | Primary target |
|---|---|---|---|---|---|
| `survival::pbcseq` | primary | survival 3.5-8, 1,945 rows, 312 randomized patients | log serum bilirubin | visits with day <= 243 (6-month landmark day 183 plus the 60-day window used for the target), at least 2 | the visit nearest day 365 within +-60 days, after the history |
| `JM::aids` | secondary | JM 1.5-2 `data/aids.rda`, 1,405 rows, 467 patients | square root of CD4 (the data's own scale) | observations at month <= 6, at least 2 | the observation at month 12 |
| ACTG175 | secondary | speff2trial 1.0.5 `data/ACTG175.txt`, 2,139 rows | square root of CD4 count | `cd40` (week 0) and `cd420` (week 20, nominal) | `cd496` (week 96, nominal); observed for 1,342 |

The pbcseq history rule is not the plan's literal "visits by day 183": before any accuracy was computed, counting eligible people showed that
the first follow-up visit falls just after day 183 for most patients (98 people with two visits by day 183, 189 by day 213, 205 by day 243), so
the history window carries the same 60-day tolerance the target has. The counts were the only thing looked at; no error of any method on any
of these data had been computed. The ACTG175 times are the trial's nominal weeks, since the file holds no exact visit date; `cd496` is missing
for 37% of patients and the evaluation is among those who have it (a limitation, stated in the result).

Data files are downloaded and extracted into their own directories outside the repository and are never committed. `aids.rda` is R's
serialization format and is only ever loaded into a fresh environment by the runner, which checks the object is a data frame.

## Splits

Person-level 5-fold cross-validation. A person's fold is `strtoi(first 8 hex of SHA-256("<dataset>:<id>"), 16) mod 5`. For each fold the
population model is fitted on the other four folds' people with ALL their rows (their own target visit included), and every eligible person of
the held-out fold is predicted from their history only. Every eligible person is therefore tested exactly once and the denominator is the
whole eligible set. No selection (window, covariates, transformation, model form) is made on any test fold; the model below is the only one
run.

## The five forecasts

All forecasts are for the observed value at the target visit, on the outcome's scale above.

- `locf`: the person's last history value.
- `lin`: the person's own least-squares line through the history, evaluated at the target time (the last value when the history has one time).
- `popmean`: the mean target of the training people who meet the same rules (no covariates, no history).
- `popmodel`: the linear mixed model's fixed part for the person's baseline covariates, with its predictive spread (the claim-2 arm).
- `eb`: the same model conditioned on the history, posterior mean of the person's random effects (the claim-3 arm).

The model (`vcr_lmm_fit`, REML, random intercept and slope with an unstructured 2 x 2 covariance, no package outside the engine's lock):

- pbcseq, time in years: intercept, time, treatment, treatment x time, age (centered 50), female.
- aids, time in months: intercept, time, drug (ddI), drug x time, male, previous AIDS-defining event, AZT failure.
- ACTG175, time in weeks: intercept, time, three treatment-arm indicators and their time interactions, age (centered 35), male.

Intervals are normal. `popmodel` and `eb` use the model's predictive SD (random-effect spread, residual, fixed-effect uncertainty; the
fitted covariance is treated as known). The three plug-in forecasts have no model, so each uses the root-mean-square error that same
forecast made for the training people who meet the same rules, so every interval is calibrated on the training folds only.

## Metrics (per dataset, pooled over the out-of-fold predictions)

MAE, RMSE, bias; coverage of the 50%, 80% and 95% intervals; the interval score (Gneiting and Raftery) at 50%, 80% and 95%; the PIT
histogram (10 bins) of every forecast; error by horizon (months since the last history visit for pbcseq and aids, weeks for ACTG175) from
**all** later visits of the tested people, in the bins given in `protocol.json` (descriptive: point errors only, no claim).
Every headline metric carries a 95% percentile interval from 2,000 person-level bootstrap resamples (seed 20261109, a person's predictions
move together).

## What may be claimed

Per dataset, independently, with no pooling and no adjustment across datasets:

- **"Individualization helps" (EB beats the plug-ins)** is claimed for a dataset only if the 95% person-bootstrap interval of the paired MAE
  difference (`eb` minus `locf`) lies entirely below zero AND the interval of (`eb` minus `lin`) lies entirely below zero. Both are required
  (intersection of two comparisons, so no multiplicity adjustment is needed).
- Otherwise the RUN file says in one plain sentence that it does not, for that dataset, and reports the differences with their intervals.
  pbcseq is the primary result; aids and ACTG175 are secondary and are labelled so wherever they are quoted.
- Nothing is claimed about calibration beyond the coverages and PIT counts reported with their bootstrap intervals (a coverage whose
  interval excludes its nominal level is reported as such).
- `popmodel` versus `popmean` and `eb` versus `popmodel` are descriptive; no claim attaches to them.
- No claim is made about any other disease, endpoint, horizon, model or population, about the AD beta_logit model on real people, or about
  a "digital twin" (the platform's rule: individual conditioning is one of four conditions and calibration and a validation record are the others).
  TADPOLE is the warning: no entry beat a plain mixed-effects benchmark on ADAS-Cog13 (benchmark MAE 4.19, best entry 4.70; Marinescu et al.
  2021), so a result that does not beat LOCF is as likely as one that does and is published as such.

## Known limits (said in the RUN file)

pbcseq and aids are randomized-trial visit schedules, not routine care; their history windows and target visits are protocol-driven. The
random-slope model is linear in time; the mixed-model hyperparameters are treated as known when forming the interval; ACTG175's `cd496` is
missing for 37% and the missing are not at random in the usual sense; ACTG175 has three visits in total, so its history is two points.

## Frozen files

`protocol.json`, `run_individual.R` and the engine's `R/individualize.R` (its SHA-256 is in `protocol.json`; the runner refuses a different
file). The command is

```
Rscript --vanilla run_individual.R --engine <vcr-engine> --jm <aids.rda> --actg <ACTG175.txt> --source-commit <commit> --out <result.json>
```

## Amendment 1 (2026-11-09, after the first run, before the second): the fold rule was implemented wrongly

The first run (runner at commit `dbcc66e2b`) used `strtoi(<8 hex digits>, 16)`, which returns NA above 2^31 - 1, so about half of the people
had no fold: they were neither tested nor used in any training set. The run therefore tested 93 of 205 eligible people on pbcseq, 109 of 223
on aids and 665 of 1,342 on ACTG175, and fitted on the other half. The fold rule written above is unchanged; the runner now computes the same
32-bit number exactly (two 16-bit halves) and stops if any eligible person is not tested. No window, covariate, model, metric, interval or
claim rule changed. The first run's output is kept as an invalid run in the RUN file (its summary) and is not a result.
