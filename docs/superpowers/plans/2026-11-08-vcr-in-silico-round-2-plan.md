# VCR in-silico round 2: review fixes, the open items, and the scientific layer

Date: 2026-11-08 (Asia/Shanghai). Status: **approved by the owner on 2026-11-09, in execution.** The owner's answers to D1–D7 are in §H; the execution record is §J.

This plan answers three inputs:
- **The owner's request of 2026-11-08:** 「把还没解决的和没做的也都做完（世界模型训练除外）」.
- **The independent review** `2026-11-08-vcr-in-silico-independent-review.md`. It holds seven P1 findings (F01–F07) and a known-gap table. The owner holds the copy; it is not in the repository yet.
- **The owner's scientific gaps.** The message announces nine gaps and gives seven (G1–G7). The owner later withdrew the other two (§C.8).

It builds on section 17 of `2026-11-07-vcr-in-silico-platform-implementation-plan.md` and three literature sweeps (§I).

Code, file names and identifiers below are as they stand on `codex/int-1108` at `34bd1869c`. Every reviewer claim and every current-state statement in §A–§C was checked against that revision. The check was by reading code and by the reviewer's own reproductions. None of it was assumed from the review.

---

## 0. Baseline: what changed since the review

- **The reviewed code is in production.** The review targets `8cddedc10` on `codex/vcr-in-silico-20261107`. Since then another session did three things:
  - merged that branch into `codex/int-1108`;
  - released `codex/release-1108` (`57daaf5ea`);
  - switched production to `evimed-57daaf5eae99-1` at 2026-11-08 07:57Z.

  So F01–F07 are in the live deployment. `github/main` (`05f5f3a0a`) has not received any of it.
- **`int-1108` already fixed other review items, but none of F01–F07** (table in §A):
  - `1e9fc2ca6`: campaign candidates leave the study's result lists; a randomized-selection dose design takes no precision block; an analytic rule naming a missing path is refused; non-finite objectives rank nowhere; old/new/observed uses the deployment's small-cell threshold; a campaign on a paused or deleted study stops with `study_unavailable`.
  - `c9ed870cc`: the beta_logit symptomatic effect is converted at time on drug; the strong null runs on the full floor; posterior covariates are named.
  - `51099488e`: web fixes, including the patient list staying the list and the lab saying more or less by sign.
  - `1bc2ae967`: beta_logit reference cases.
- **Work branch:** `codex/vcr-in-silico-r2-20261108`, cut from `codex/int-1108` `34bd1869c`, not from main. When `int-1108` lands on main, this branch merges main in. Defect fixes (M0) are kept as small commits that can be cherry-picked onto a release delta.

## 1. Scope and standing rules

**In scope:**
- F01–F07 and their classes (§A).
- Every open item of round 1 (§B).
- The scientific gaps G1–G7 (§C).
- PBPK, which was deferred last round (R38).

**Out of scope:**
- T11/T12, temporal world-model training. The owner is finding data; `evals/vcr-in-silico/world-model-protocol.md` stays as written.
- Patient matching (another session).
- Any production change, unless the owner asks (decision D1).

**Rules carried unchanged:**
- **Run and say the premise:** only real execution issues refuse a calculation.
- **The model never does statistics, and regex never does language.**
- **No new approval, gate, form or badge ladder.** A verdict never withholds a delivery.
- **One premise block per page:** 「这个结论的前提」.
- **General first:** nothing grows the root conversation's always-on text. Extend an existing tool, job kind or method before adding one.
- **Never weakened to get a green result:** the alpha constraint, small-cell rules, source authorization and evidence labels.
- **Locks:** the R runtime lock does not change without decision D2. `nlme`, `mgcv`, `MASS` and `Matrix` are recommended packages already in the engine image (`rocker/r-ver:4.3.3`; the Dockerfile notes they ship with R and sit in neither lock). So MMRM-by-GLS and GAM-based value of information need no lock change.

---

## A. Review findings, verified on the live revision

Every finding is still present at `34bd1869c`. One reported defect calls for a search of its class, so each row also names the same defect class found elsewhere in the code.

| ID | Where (at 34bd1869c) | Confirmed | Same class elsewhere | Fix (task) |
|---|---|---|---|---|
| F01 | `packages/domain/src/vcrForecastEvaluation.mjs:329` and `:371` | Two places. `compareForecasts` sets `dataClass` from the two forecasts only (`:329`). `compareVersionsToObserved` takes the synthetic fast path on `base.dataClass` (`:371`) and never reads `outcomes.dataClass`. The server also passes `dataClass: first.content.dataClass` (`vcrLongitudinal.mjs:372`). | `evaluate` (`:184–198`) already takes the strictest of history and outcomes, so the rule exists and was not reused. Audit every `dataClass` derivation in `vcrForecast*`, `vcrLongitudinal`, the trial benchmark and the views. | R01 |
| F02 | `apps/server/src/vcrLongitudinal.mjs:366–381` | The comparison's lineage unions the two predictions and drops the outcome history. The `forecast.evaluate` branch just above (`:357–365`) does include the outcomes. | Audit every `artifacts.save` that reads more than one artifact: `forecast.trial_benchmark` passes only `parentId`, and import and replay need checking. | R02 |
| F03 | `apps/server/src/vcrExperiments.mjs:186–224` | `jobs.enqueue` runs outside the row lock. The conditional `UPDATE … WHERE state->'inFlight'->>'jobId' IS NULL` (`:220`) is not checked for a matched row, so a job the cancel raced past is never cancelled or attached. | **F03b, new.** In `startExperiment` (`:375–397`) the arms are written only in the `finally` `keep()`, and `keep()` overwrites `state` wholesale with `{arms}`. A `cancel()` during start (`:314–321`) sees no arm jobs, and its `cancelRequested` flag is then erased by `keep()`. The arms run on, untracked. | R03 |
| F04 | `vcrExperiments.mjs:384` (arm jobs carry no conversation origin); `vcrConversationCompletions.mjs:74–107` | `reconcileCampaigns` selects `kind='campaign'` only. The job path needs `checkpoint.conversationOrigin`. A comparison (`kind='experiment'`) matches neither, so it never produces a completion. | Any parent object that keeps the origin while its children do not. Today that is only campaigns (handled) and experiments. | R04 |
| F05 | `packages/domain/src/vcrExperimentSearch.mjs:892` | When the coupling leaves the contrast's MCSE unknown, it is replaced by `Math.hypot` of the marginal errors, a missing error counts as 0, and the basis is labelled `independent_error`. | `:1065`: on the `independent` path a missing marginal MCSE also becomes 0. | R05 |
| F06 | `vcrExperimentSearch.mjs:991–1011` | A reference eliminated at screening is pushed into `finalists` but keeps `status: 'eliminated'`. The final loop skips it. So the verdict has no reference objective, the improvement block is skipped, and the campaign stops with `acceptable_precision` even when `minImprovement` was asked for. | Compare experiments: an arm refused at enqueue may be the comparison's reference. | R06 |
| F07 | `apps/web/src/components/vcr/PatientTrajectoryWorkspace.tsx:85–89, :154` | `page.last` is kept regardless of the request key, and an error shows only `!shown`. | `VirtualLabWorkspace.tsx:282` (`list.last`), and the hook itself (`vcrTabKit.tsx:62–122`): its `last` is keyless by design. | R07 |

**Production impact.** F01 and F02 are privacy and authorization defects:
- F01 lets real outcomes below the small-cell floor reach a page, a model read or a report.
- F02 lets a comparison stay readable after its outcome source's grant was withdrawn.

F03 and F03b can leave engine work running after a stop. All of these are live now. Recommendation (D1): ship R01–R07 as a delta on `release-1108` once their tests and CI are green, ahead of everything else in this plan.

## B. Open items from round 1, with what "closed" means

| Item | State now | Closed when | Task |
|---|---|---|---|
| The model does not choose the lab's design search, even when asked | The backend campaign exists. Live, the model iterated single designs and grids. | On the real kernel, explicit search requests start a campaign at a measured rate, and ordinary single-design questions do not (thresholds in R10). A run of standalone designs is not proof. | R10 |
| A new conversation cannot reuse an earlier study (D7) | `vcrConversationReference.mjs:26` refuses a study bound to another conversation. The gateway resolves only the current conversation's own study. | An explicit, authorized handoff exists: a person-chosen continuation, recorded, revocable. Implicit reads are not widened. | R11 |
| A derived accrual duration reads 「假设」 | The model turns 「每月入组 20 人」 into a duration. The schema has only `accrual.duration`. | The stated rate goes in as stated. Code derives the duration, which reads as derived from the person's data, in their units. | R12 |
| Completion after the turn (D5) | Fixed for jobs and campaigns, never seen live. F04 shows comparisons have no completion at all. | R04 is built, and a live run where a job and a comparison each outlive their turn wakes the conversation once. | R04, R39 |
| Word/PDF reports lack the laboratory | The lab block is in `reportModel`. The templates do not reference it. | An exported Word/PDF of a study with lab work contains the lab section. Its numbers are rendered references, never typed. | R14 |
| Real-data batch evaluation (PhysioNet 2012, ACTG175) | A command exists; the data was believed private. | Both sources are public: PhysioNet Challenge 2012 under ODC-By 1.0, about 6.3 MB per set; ACTG175 in CRAN `speff2trial`, GPL-2. They are fetched here with pinned hashes, kept out of the tree, and the frozen evaluation runs in full. | R15 |
| Agent-directed search benchmark arm | Not run. | Run at a matched budget against the fixed baselines (R36/R37). | R16 |
| 1-vs-2 engine capacity test | Not run (needs an isolated worker). | Measured on an isolated engine container: p95 queue and interactive latency, peak memory, throughput, seed reproducibility. A recorded decision follows; production stays at 1 unless decided. | R17 |
| Packed install probes (T14) | Source-level plugin tests only. | Each bundle is packed with `pnpm pack`, installed into a clean standalone DSH profile and into the hosted composition, and probed. | R18 |
| CI engine job at 1 h 57 m of its 120 min limit | Main's 11-05 run already timed out. | The numeric suite is sharded so that each shard finishes under 60 min, with a check that every case runs exactly once. | R19 |
| Release checks | `audit:capabilities` was not re-probed against the deployment; trial-bundle re-admission is unverified. | Both are run read-only against production and recorded. | R20 |
| Completion wording | §17 says "Done" for T08, T09, T10 and T14. | The status reads as the review asks: substantial implementation with green engineering CI, seven confirmed defects and explicit acceptance gaps. T08/T09/T10/T14/T15 are not called fully accepted until their R-tasks close. | R21 |

## C. The scientific gaps

Each gap below has four parts:
- **Now:** what the code does today, verified.
- **Target:** what we build.
- **Design:** how.
- **Claim boundary:** what the result may say and not say.

### C.1 G1: from "if the drug works, how does the trial go" to "might this drug work"

**Now.** The `beta_logit` family takes the drug as the researcher's statement: a symptomatic Emax given in points at a week, or a disease-modifying share of the mean slope (`patients_progression_beta_logit.R` header: 「The drug is the researcher's hypothesis」). The posterior the engine loads already carries three fitted AChE-inhibitor effects:

| Drug | eStar | ET50 | γ (dose exponent) |
|---|---|---|---|
| Donepezil | 0.1382 | 1.62 wk | 0.24 |
| Galantamine | 0.1553 | 8.98 wk | 0.20 |
| Rivastigmine | 0.1262 | 7.91 wk | 0.11 |

Reference doses are 5 mg, 24 mg and 6 mg (AD-SOURCE §2.7). These effects are not exposed: a researcher cannot ask for "donepezil 10 mg".

**Target.** Replace the single point assumption with an **effect distribution with a stated origin**, from one of three tiers. The tier is named on the page:

1. **Tier A, data-fitted for a marketed drug (R29).** An arm can name `treatment.reference: { drug, doseMg }` for donepezil, galantamine or rivastigmine, within the fitted dose range. It uses the posterior's own effect draws, so its uncertainty travels with `posterior_draws`.
   - **Literature check (consistency only):** at the posterior medians, donepezil 10 mg at 26 weeks gives −2.54 to −2.73 ADAS-cog points from a baseline of 22–25. This is our calculation from the logit-scale Emax. Cochrane (Birks & Harvey 2018) pools −2.67 (95% CI −3.31 to −2.02) at 24–26 weeks. These data overlap the model's fitting set, so this is a check of our implementation, not an independent validation, and the page says so.
   - **Background therapy:** an add-on trial of a new drug on stable AChE inhibitors is modelled with the inhibitor started before baseline. Post-2011 placebo arms had 83–100% of patients on AChE inhibitors or memantine.
2. **Tier B, a mechanism chain for a new disease-modifying antibody (R30, exploratory pack).** Exposure → biomarker → clinical effect, each link from a published model with its own uncertainty (§C.1a). The chain outputs a *distribution* of the disease-modifying fraction, which feeds R25's assurance. The claim boundary is written into the result: "if this relationship holds…". Three mismatches are named as premises:
   - the endpoint scale: the link's evidence is on mixed ADAS-Cog versions and CDR-SB, while the model is ADAS-cog 11;
   - the population: early AD at MMSE 20–30 versus mild-to-moderate AD at MMSE 14–26;
   - the link: it was fitted on the same trials it is checked against.
3. **Tier C, from the researcher's own or the literature's data (R31).** An `evidence.pool` result, or the researcher's phase-2 estimate, becomes the effect prior. It carries its source and its estimand: ICH E9(R1) A.4 warns that historical effects may rest on a different estimand.

#### C.1a The Tier B chain, as far as published parameters carry it

| Link | Published source and values | What it does not give |
|---|---|---|
| PK | **Aducanumab** (Muralidharan et al., CPT PSP 2022;11:7–19, PMC8752104, Table 1): IV, linear two-compartment, CL 0.0159 L/h, V1 3.59 L, V2 6.04 L, Q 0.0194 L/h; weight, age, sex and Asian covariates; IIV (CV%) CL 21.6, V1 14.8, V2 17.0. **Lecanemab** (CPT PSP 2024;13:2111, PMC11646937, Table 1): CL 0.0154 L/h, V1 3.24 L, V2 2.00 L, Q 0.00718 L/h, with covariates and IIV. | SC bioavailability for either; label effective half-lives were not read |
| Amyloid PET | **Aducanumab, same paper, Table 2:** indirect response with drug-stimulated loss, dSUVR/dt = Kin − Kout·(1 + Emax·C/(EC50 + C))·SUVR. BL 1.40, Kout 8.51×10⁻⁵ /h, Emax 0.702, EC50 46.4 mg/L, covariates, IIV. Lecanemab's PK/PD model (PAGE 2022 poster) gives no values we could read. | Centiloid conversion for this tracer and reference region is a separate published mapping |
| Amyloid → clinical | **Pang et al., Alzheimers Dement 2023;19:1292** (instrumental-variable meta-analysis, 16 RCTs): per 0.1 SUVR decrease, ADAS-Cog decline is reduced by 0.33 points (95% CI 0.12–0.55; ADAS-Cog versions mixed), CDR-SB by 0.09 (0.034–0.15). **Ren et al. 2025** (arXiv 2504.06807; 23 RCTs, 7 antibodies): CDR-SB slope 1.41 per 1.0 SUVR (0.60–2.21), used as sensitivity. **Ackley et al., BMJ 2021:** no association with MMSE. | A per-patient causal link. These are trial-level associations across mixed populations (mostly early AD) and scales, partly fitted on the trials one would check against |

**First pack: aducanumab end to end.** It is the only antibody with PK and amyloid PD published together with values. Lecanemab is second: its PK is published, its PD values are not.

**Conversion to the model's terms.** The clinical link's point difference at the stated week is converted to the model's disease-modifying fraction by deterministic inversion at the typical study. The link slope is drawn per simulated trial from its interval.

**Validation available.** Reproduce the published SUVR course of the PRIME/EMERGE doses within a stated tolerance. Clinical agreement with EMERGE/ENGAGE is not independent of the link, and the page says so.

**Claim boundary.**
- **Tier A:** says what the data-fitted model predicts for a marketed drug.
- **Tier B:** says what follows if a published mechanism chain holds. It never says that the drug works.
- **Tier C:** says what follows if this evidence transfers.

None of the tiers is a probability that the drug works, and no regulatory status transfers.

### C.2 G2: one executable set of patients shared by the population and the lab

**Now.** Three facts, all verified:
- `vcrExperimentRecord` declares `populationRef` and `modelRef` (`vcrExperiment.mjs:23–27`), but no server code uses it.
- Every arm job is enqueued with `inputs: []` (`vcrExperiments.mjs:188, 384`).
- The AD family samples its own people from `population.mmseRange` and the posterior's covariate model (`patients_progression_beta_logit.R:469–471`).

In addition, `VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS` aligns the *definitions* of the population, not the people. Arm seeds differ (`own:${arm.name}`), so different simulated people stand in each arm.

**Target (R23).** One execution chain:

> saved population version → fixed per-person baseline state and model parameters → model version → intervention → observation → endpoint analysis

Two experiment modes, named and kept apart because they answer different questions:
- **Paired, same people (`paired_counterfactual`).** Every person of the population version is simulated under every arm with the same individual random effects and common random numbers for the residuals. The answer is "the same patients, different interventions": a per-person contrast and its distribution under the model. This is model-implied, not an observed individual treatment effect.
- **Repeated trials (`resampled_trials`).** Each simulated trial draws n people from the population version and randomizes them. The answer is "what a trial recruiting from this population would show": power and its Monte Carlo error.

**Design.**
- **The virtual patient record:** baseline covariates plus the model-specific individual parameters. For beta_logit these are the intercept η and the slope α, drawn once at "instantiate" with the population version's seed and stored in the data plane with their hash, bound to the model version. A changed model version marks the old record "made for an earlier model", exactly as T07's readiness does.
- **The engine reads the population as an input:** `patients.progression` (beta_logit first) accepts the population table as an `analysis_table` input of shape `subject`, through the existing `inputs.R` reader (path and hash, data plane only). Covariates outside the model's fitted ranges stay premises, never refusals.
- **The lab passes the population on:** a design or disease experiment that names a population version passes the same input to every arm, with a seed shared by construction.
- **The dormant protocol record goes:** `vcrExperimentRecord` either becomes the launch record or is deleted ("build to delete"). The decision is taken in R23 once the call sites are known.

### C.3 G3: batch forecasting is not individual prediction

**Now.**
- **Engineering, proven:** every person of a batch gets a result or a named reason, and the counts add up.
- **Not proven:** that any individual forecast is accurate. The AD path generates virtual individuals and calibrates nothing to an uploaded patient's history. The only real-data number is the PhysioNet heart-rate regression against persistence; the new batch path's real-data run is pending (R15).

**Target.** Three claims, each with its own words in the domain, the page and the reply:
1. 「生成一批虚拟患者」: distributional fidelity (marginals, correlations, trajectory spread), judged by distribution checks.
2. 「为真实患者做群体模型预测」: only baseline information is used, so this is a population-model forecast for that person, labelled as such.
3. 「用每个人的历史个体化」: posterior individual parameters given the person's own observations.

**Design (R32).** Empirical-Bayes individualization: a MAP estimate of the random effects with a Laplace approximation, and a posterior predictive by sampling the approximate posterior.
- **beta_logit:** validated by known-truth simulation only, through coverage of held-out visits. No open individual-level AD data exists without an ADNI application.
- **A generic linear-mixed provider for continuous longitudinal endpoints:** validated on real data (R33).

**Evaluation (R33, frozen before running).**
- **Primary:** `survival::pbcseq`, log serum bilirubin at the visit nearest 12 months (±60 days), predicted from the history up to a 6-month landmark. Patients are split train/test by person.
- **Secondary:** `JM::aids` (CD4 at 12 months from the history to 6 months) and ACTG175 (`cd496` from `cd40` and `cd420`).
- **Baselines:** last value carried forward, per-person linear extrapolation, population mean, and the population model with covariates but no history.
- **Metrics:** MAE, RMSE, coverage of the 50/80/95% intervals, interval score, PIT calibration, and error by horizon, with 95% person-bootstrap CIs.
- **What may be claimed:** "individualization helps" only where it beats last value carried forward and linear extrapolation on MAE with the CI excluding zero. TADPOLE shows the risk: no entry beat a plain mixed-effects benchmark on ADAS-Cog13 (benchmark MAE 4.19; best entry 4.70; Marinescu et al. 2021).

### C.4 G4: the research question and its estimand, and an analysis aligned to it

**Now.**
- **Analysis:** a Welch test or ANCOVA of the change among those still observed at the analysis visit, not adsim's MMRM (file header, line 35).
- **Dropout:** Weibull on age and baseline MMSE with a study frailty, independent of arm and outcome (AD-SOURCE §2.5).
- **Missing:** treatment discontinuation as distinct from study withdrawal, rescue medication, death, and any statement of which treatment effect is wanted.

Real AD trials show why this matters: discontinuation depends on arm.
- **Clarity AD:** treatment discontinuation for adverse events 6.9% on lecanemab vs 2.9% on placebo; trial discontinuation 18.8% vs 15.6%.
- **TRAILBLAZER-ALZ 2:** treatment discontinuation for adverse events 13.1% on donanemab vs 4.3%.

Neither paper states an estimand (Hendrix et al. 2026). EMA's AD guideline asks for one; FDA's 2024 early-AD draft has no estimand text.

**Target, part 1 (R22): a research question object 「研究问题与假设」.** The agent assembles it from the conversation, a field at a time, and the person can edit it on the page. Every model run and analysis records the question version it answers. Nothing requires the object to be complete: a missing field is a default the premises name. Fields follow ICH E9(R1) A.3:
- the question in the person's words;
- the population, with an optional population-version reference;
- the treatment conditions, with an intervention model and its tier (C.1);
- the variable: endpoint, scale, time point or window;
- the intercurrent events, each `{event, strategy, mechanism assumption}`, where strategy is one of treatment policy, hypothetical, composite, while on treatment, principal stratum;
- the population-level summary;
- the decision context: what will be decided and at which thresholds;
- the assumptions, each with its value source.

Two further fields:
- **A read-only calibration estimand:** what the model's source data represent. For the CAMD model that is mixed trial data, mostly on-treatment, analysed under MAR. When it differs from the target estimand, the premise says so (E9(R1) A.4).
- **For each intercurrent event, whether the simulation can represent it:** an event whose strategy has no generator or estimator here is stated as 「这个模拟表示不了」 in the premises. It is never refused and never silently defaulted.

A changed question marks the results that answered the earlier version, as model versions already do.

**Target, part 2 (R26): a simulation that can represent each strategy, and estimators matched to it.** The literature is unanimous that a treatment-policy estimand needs the off-treatment path generated and an estimator that uses it, and that MAR-MMRM on on-treatment data is then not aligned (E9(R1) A.3.2/A.5.1; Polverejan & Dragalin 2020; Bell et al. 2025).
- **Intercurrent events in the AD engine:**
  - **Treatment discontinuation:** its hazard may depend on arm (adverse events) and, as a stated MNAR scenario, on the latent progression (lack of efficacy). It is separate from study withdrawal.
  - **Off-treatment follow-up:** a stated retrieved share. Under the model's own equations the symptomatic effect washes out with its half-life and the disease-modifying effect persists, so the off-treatment path needs no new biology.
  - **Study withdrawal:** the existing Weibull, optionally with arm or progression terms stated as a scenario.
  - **Death:** composite only, when a composite strategy is chosen.
- **Estimators:**
  - completers' change and ANCOVA (kept);
  - **MMRM**: unstructured covariance, visit × arm and visit × baseline. It is built on two paths. The fast path is an exact ML factored likelihood for monotone missing data (closed form, deterministic). The `nlme::gls` REML path covers non-monotone data and is the internal cross-check. The `mmrm` vignette measures `gls` at about 12–49× slower than `mmrm`, which is why `gls` cannot be the path inside power loops;
  - **reference-based imputation** (jump to reference / copy reference) by deterministic conditional-mean imputation (Wolbers et al. 2022). A single-fit version keeps the cost per simulated trial bounded; the jackknife SE is for real-data analysis, not inside power loops;
  - **a tipping-point delta** in the data-generating model.
- **The true value of each estimand:** computed by the engine from the data-generating process. For the treatment-policy truth, everyone is followed through any discontinuation and no one withdraws. For the hypothetical truth, no one discontinues. Each result can therefore report the estimator's bias, coverage and power against the estimand it claims, and say when the analysis does not estimate the effect the question asked for. Polverejan & Dragalin show power moving across roughly 35–80% with the retrieved share and the discontinuation rates.
- **Numeric cases:**
  - MMRM fast path against `nlme::gls` on fixed data;
  - against the `mmrm` package as an oracle in the test lock only (D2);
  - a known-truth bias and coverage table for each strategy and estimator pair.

### C.5 G5: three different "80%", and model error that more simulations cannot fix

**Now.** All three uncertainty modes are labelled 「功效」 (`vcrProgression.mjs:155–157, 209`):
- `typical_study` is conditional power at the posterior medians;
- `new_study` averages over between-study variation;
- `posterior_draws` also averages over the disease model's parameter uncertainty, but still at a fixed, stated drug effect.

None of these is assurance in O'Hagan, Stevens & Campbell's sense, which averages over a prior on the treatment effect. None is a programme's probability of success.

**Target.**
- **R24, vocabulary.** One closed set of names, the same in the domain, the page and the reply:
  - 「在典型研究条件下的把握度」: conditional on the parameters.
  - 「考虑研究之间差异后的预期把握度」.
  - 「再考虑模型参数不确定性后的预期把握度」.
  - 「按药效的不确定性平均后，得到显著结果的概率（assurance）」: only when an effect distribution with a source is given (C.1, R25). It counts significant results whatever the true effect, including a null or irrelevant one.
  - 「药效至少达到最小重要差异时的预期把握度」: shown with Pr[effect ≥ MID] beside it, and only when the person states a minimal important difference.

  A trial-level "probability of success" (significant *and* effect ≥ MID) is shown only when four things hold: a sourced effect prior, a stated MID, between-study variation switched on, and an analysis aligned to the estimand (C.5a). A programme or "研发成功率" figure is never computed from these. It would need a declared denominator, phase-transition evidence and attribution, as §7 of the 11-07 plan already says.

  These are the names of different quantities, not a badge ladder: a result carries the name of what it computed.

  Every result also states that more replicates reduce only Monte Carlo error. Model-form error and a wrong drug assumption are untouched by them.
- **R25, effect distributions.** `treatment.symptomatic.pointsAt` and `disease_modifying.fraction` accept a distribution `{family, parameters, source}` drawn once per simulated trial. The result is assurance proper, and its source names the tier (C.1).
- **R27, external validation of the placebo progression on trials the model never saw.** The frozen validation set is placebo arms of post-2011 mild-to-moderate trials that report ADAS-cog 11:
  - bapineuzumab 301 (APOE4 carriers): +8.7, SE 0.5, at week 78;
  - bapineuzumab 302 (non-carriers): +7.4, SE 0.5, at week 78;
  - verubecestat EPOCH: +7.7, SE 0.3, at week 78;
  - intepirdine MINDSET (on donepezil): +0.75, SE 0.21, at week 24;
  - the three idalopirdine trials (on AChE inhibitors): +0.4 to +0.8 at week 24;
  - semagacestat IDENTITY (+6.19 at week 76, baseline 22.8, from the ClinicalTrials.gov results). Its MMSE, APOE4 and background-therapy shares are not recovered, so that run states them as assumptions.

  Each trial is simulated from its own published baseline table (age, MMSE mean/SD and entry range, sex, APOE4, background therapy) in the `posterior_draws` mode, which also draws a new study per trial. We record:
  - the predicted change and its predictive interval against the observed LS mean ± SE;
  - the bias, the z-score and the coverage.

  The protocol and the set are frozen before the first run. The result becomes a premise on every AD page: 「在 N 项模型没见过的试验安慰剂组上，预测的 78 周变化平均偏差 X 分」.
- **R28, structural uncertainty and population shift.**
  - **A second model structure:** run a structurally different published ADAS-cog model side by side and show the spread between the two. Candidates to read in R28, none read this round:
    - Samtani et al. 2012 (ADNI, ADAS-cog);
    - Delor et al. 2013 (ADAS-Cog13);
    - Ueckert et al. (item-response models).

    The Ito 2010 literature model is the same family and is not independent. If no second structure with usable parameters exists for ADAS-cog 11 in mild-to-moderate AD, the result says so instead of manufacturing one. Weights are not invented: model averaging only with a stated, validated rule.
  - **Population shift:** a target population is a population version (C.2) run through the model, with the range checks as premises.
  - **Credibility record:** each result records an ICH M15-style credibility entry (question of interest, context of use, model influence, decision consequence, verification, validation, applicability), computed where it is computable and stated where it is not (§C.5a).

#### C.5a What "probability of success" and "credible" require

- **Kunzmann et al. (Am Stat 2021) separate four quantities:**
  - **Assurance:** the marginal probability to reject, PoS₀ = Pr[reject], after O'Hagan et al.
  - **PoS:** Pr[reject and effect ≥ MCID].
  - **Expected power:** E[power | effect ≥ MCID].
  - **The product rule:** PoS = EP × Pr[effect ≥ MCID], so a PoS never exceeds the prior probability of a relevant effect.

  The authors warn against calling a joint probability "power". We therefore name only what we compute (R24) and never print a PoS without a stated, sourced effect prior and an MCID.
- **Programme success is a different object:** it needs phase-transition evidence. Wong, Siah & Lo 2019 report 13.8% overall and 15.0% for CNS. Cummings et al. 2014 report 0.4% for AD trials of 2002–2012, a class base rate, not a mechanism's. It also needs dependence between phases. The platform does not compute it.
- **ICH M15 (Step 5, EMA/CHMP/ICH/496426/2024, adopted by CHMP 2026-01-23, effective 2026-07-23)** defines what the credibility record holds:
  - **The model's role:** question of interest, context of use, model influence (low/medium/high) and decision consequence, which together give the model risk.
  - **The evaluation:** verification, validation and an applicability assessment for each intended use.

  M15 prescribes no method for model-form uncertainty, model averaging or transportability. Those stay our explicit choices (C.5, R28), stated as such.

### C.6 G6: from parameter search to "which experiment next"

Three abilities, each measured on its own.

**Ability 1: organize an experiment from natural language (R37a).** Did the agent understand the question and choose the right model, method and parameters?
- **Request set:** 20 frozen requests in Chinese, run on the real kernel, 3 samples each.
- **Grading:** code grades the tool-call arguments against written keys (method, fixed parameters, stated assumptions, the research question object's fields) before any number is read.

**Ability 2: optimize a design inside a fixed model (R36).** Is the search better than grid, random or another fair optimizer at the same simulation budget?
- **Arms:** equal-allocation grid, random, successive halving on replicate count, a two-stage OCBA/indifference-zone procedure (Kim & Nelson 2001; OCBA; screening-then-finalists is two-stage ranking and selection), and ours. GP-based Bayesian optimization is cited as context only: Richter et al. 2022 report BO about 20× faster than an exhaustive grid at comparable power, with no random arm and no matched budget, and DiceKriging is not in the lock.
- **Budget unit:** total simulated trials.
- **Ground truth:** the high-precision exhaustive cache the 11-07 benchmark already built.
- **Metrics:**
  - probability of correct selection;
  - simple regret of the chosen design on independent re-evaluation;
  - budget needed to reach a regret of at most ε;
  - the rate of constraint violations after re-evaluation.

  Each metric runs over ≥50 seeds and is reported as median and IQR curves against budget.
- **Also:** the 2.2%-analysis-level finding is restated as a result of the tested configurations only.

**Ability 3: choose the next scientific experiment (R35 + R37c).** Find the uncertainty that most changes the decision, and the most valuable next simulation or real evidence.
- **New engine method `decision.value_of_information`.** A frozen decision (designs, or go/no-go) and a utility the person states (success indicator, or net benefit) are run over probabilistic draws of named uncertain inputs: posterior draws, the effect distribution, the dropout mechanism parameter, the control progression. It returns EVPI and per-input EVPPI by GAM regression (Strong, Oakley & Brennan 2014; `mgcv`), their ranking, and the decision-flip threshold for any input without a proper distribution. A triple of optimistic, base and pessimistic values is not a prior; for those, only thresholds are reported.
  - **Later:** EVSI by regression (Strong et al. 2015), for "collect n more natural-history patients" or "run a phase 2 of size m".
  - **Not in the runtime:** `voi` (GPL-3, nine imports) stays out of the runtime and serves as the test oracle in the cross-check lock (D2).
- **The agent's part:** it explains the table and proposes or runs the top-ranked next step. It never ranks by itself.
- **Evaluation (R37c):** 8 known-truth scenarios, each with a planted decisive uncertainty (for example, the dropout mechanism dominates, or the effect size dominates). We measure whether VOI ranks the planted input first, and whether the agent chooses the step VOI recommends.

None of the published agent benchmarks separates these three abilities: ScienceAgentBench, DiscoveryBench, LAB-Bench, BED-LLM. A 2025 study found LLMs do not exploit feedback for in-context experimental design (arXiv 2509.21403). We therefore build the separation ourselves and do not claim "AI does experiments" beyond what R37 measures.

### C.7 G7: an optimum under one assumption is not a recommendation

**Now.** A campaign optimizes under one frozen truth. The benchmark's effect, control course and follow-up are preset. The page marks one best design.

**Target (R34).** Robust design reporting in the clinical-scenario-evaluation style (Benda et al. 2010; FDA complex innovative designs guidance 2020):
- **Frozen scenarios:** the campaign manifest holds named scenarios, optimistic, base and pessimistic effect, control progression, subgroup population versions (C.2), and dropout or intercurrent mechanisms (C.4). Each candidate is evaluated in every scenario with common random numbers.
- **Outputs:**
  - an operating-characteristics table per scenario: power, type I error, expected N, duration, and exposure as a safety proxy, each with MCSE;
  - worst-case power (maximin);
  - maximum regret against the best design in each scenario;
  - expected power over scenario weights, only when the person states the weights;
  - the Pareto set over N, duration and worst-case power;
  - the **near-optimal set**: designs within an MCSE-aware tolerance of the best on each criterion.
- **Presentation:** no single 「最优」 badge. The reply and the page say 「在这些假设下」 and show the cheapest design that stays acceptable across the scenarios beside the cheapest design under the base case.

### C.8 Gaps 8 and 9

The owner's message announced nine gaps and stopped after seven. On 2026-11-09 the owner withdrew gaps 8 and 9 as wrong (D7). Nothing is built for them.

---

## D. Shared contracts introduced (one place each)

| Contract | Lives in | Read by |
|---|---|---|
| Research question object (versioned) | `@evimed/domain` `vcrResearchQuestion.mjs` + a `research_question` document per study | gateway (`vcr_write what=research_question`, `vcr_read`), every job's frozen scenario (`questionRef`), views, report |
| Virtual patient record and population input | domain contract and `inputs.R` shape check; data-plane table with hash | `patients.progression`, experiments, campaigns, the population page |
| Uncertainty vocabulary | `vcrVocabulary.mjs` (closed set + Chinese labels) | engine result `uncertainty`, views, the reply's sentences, report |
| Effect distribution `{family, parameters, source, tier}` | `vcrScenarioSchemas.mjs` | beta_logit, `design.assurance`, the VOI method |
| Robust campaign output | `vcrExperimentSearch.mjs` verdict v2 | lab view, completion, report |
| Credibility record (ICH M15 fields) | `vcrModelUse.mjs` beside `assessModelUse` | premises block (3–5 decisive premises), folded remainder, report |

## E. Task list (todo)

The priority column takes P1, P2 or "must" (an owner-required closure). Size is S (under half a day), M (about a day) or L (multi-day). "Deps" names tasks that must land first. IDs leave gaps between milestones; the live after-turn check that would have been R13 is part of R39. Acceptance always includes the focused tests named, a regression test that fails on the old code, and no lowered expectation.

### M0: review defects (hotfix lane)

| ID | Task | Pri | Size | Deps | Acceptance |
|---|---|---|---|---|---|
| R01 | Provenance class = strictest of every participating source in `compareForecasts`, `compareVersionsToObserved`, the server call and every presenter. Small-cell suppression applies to real outcomes in the nested and outer summaries. | P1 | S | — | Mixed-origin counterexamples (synthetic forecasts + real outcome) at the computation, `presentLongitudinal`, the model read (`vcr_read`), the page view and the report: `observed=1` never visible at minCell 5. |
| R02 | The comparison saves the outcome history's full lineage (snapshots, sources, field bindings). Every multi-input `artifacts.save` is audited; reads and exports recheck every source. | P1 | S | — | Withdraw the outcome grant: a comparison read is denied (the reviewer's harness shape). Same for export. |
| R03 | Admission versus cancel: link the job only if the conditional update matched a row; otherwise cancel and settle the job under its idempotency key (restart-safe). `startExperiment` records each arm as it is enqueued (merge, never overwrite), checks `cancelRequested` between arms, and `keep()` preserves it. | P1 | M | — | Barrier-controlled concurrent tests for the campaign and experiment start: no queued job without an owner, `cancelInvocations` ≥ 1 for a lost link, restart repeats nothing. |
| R04 | `reconcileExperiments`: an experiment with an origin whose arms are all terminal yields one aggregate completion (succeeded / partial / failed / canceled), fingerprinted once. A comparison finished inside its turn does not wake it. | P1 | M | R03 | Busy root, turn end, partial failure, cancellation, restart and duplicate reconcile, each in a test. Outbox rows = 1. |
| R05 | Dependence-aware contrast. Unknown coupling with both marginal MCSEs known uses the Cauchy–Schwarz bound `sa + sb`, basis `worst_case`. A missing marginal makes the improvement unassessed, and a `minImprovement` stop is then not satisfied. Line 1065 gets the same treatment. | P1 | S | — | The reviewer's unknown-covariance case stops `inconclusive_at_precision`; basis is never `independent_error` unless the seeds differ. |
| R06 | A screened-out reference is evaluated at the final stage for the contrast (status `reference`, never eligible to win). A reference that cannot be evaluated makes the improvement unassessed. | P1 | S | R05 | The reviewer's screened-reference case: the reference has a final objective, improvement is computed, the stop honours `minImprovement`. Benchmark regression at a matched budget. |
| R07 | `useVcrLoad` keeps `last` only for the same key; a refresh shows 「正在刷新」; a changed-key or denied read never shows the old table. Applied to the trajectory and lab lists. | P1 | S | — | The reviewer's stale-row test passes; a 403 after switching shows the error state; layout and copy rules pass. |
| R08 | Hotfix delta: R01–R07 on `release-1108` behind the full local battery and CI, released only on the owner's word (D1). | P1 | S | R01–R07 | CI green on the delta; the release walk. |

### M1: round-1 open items

| ID | Task | Pri | Size | Deps | Acceptance |
|---|---|---|---|---|---|
| R10 | Search reachable from the conversation. First, a baseline on the real kernel: 12 frozen request phrasings × 3 samples. Then:<br>• a minimal `action=search` form (method + base scenario + `vary` ranges + goal), which code compiles into the frozen manifest (stages, budget, error-control constraint from the frozen alpha);<br>• `action=shape kind=search` returns a filled example;<br>• a one-line pointer in grid and repeated-design results.<br>Then re-measure. The description stays within its 420-character cap. | must | M | R05, R06 | ≥80% of explicit search requests start a campaign; ≤10% of single-design questions do; spend logged. |
| R11 | Cross-conversation continuation (D7). 「在新对话中继续」 on the history row and the study page, and a study reference in the composer, write a grant row `study_conversations(study_id, session_id, granted_by, granted_at, revoked_at)`. The gateway accepts an explicit `studyId` from a granted session only; per-operation authorization is unchanged. | must | M | — | Tests: no implicit read; revoked grant denied; other project and member roles; completion goes to the conversation that started each job. Live A16/A20. |
| R12 | `accrual.rate` (+ unit) accepted; the duration is derived by code. A new premise source `derived` (「由你给的数据算出」) points to its parent, in the vocabulary and the premise block. | must | S | — | The live case 「每月入组 20 人」 reads 「你给的数据」 for the rate and 「由你给的数据算出」 for the duration. |
| R14 | Laboratory section in the Word/PDF report: the `vcr-package` templates reference lab fields; the renderer resolves them; no typed number. | must | S | — | An exported .docx and .pdf of a study with a comparison and a campaign contain the section, checked by reading the files. |
| R15 | Fetch the public PhysioNet 2012 A/B/C (ODC-By) and ACTG175 (`speff2trial`) with pinned SHA-256 into a local, ignored directory, and run the frozen batch evaluation in full. | must | M | — | Full denominators; results file; no private data. |
| R16 | Agent-directed search arm of the benchmark. | must | M | R10, R36 | See R36/R37. |
| R17 | 1-vs-2 capacity test on an isolated engine container on the dev box. | must | M | — | p95 queue and interactive latency, peak memory, throughput, bit-identical seeds; recorded decision. |
| R18 | Packed install probes: `pnpm pack` each VCR bundle; clean standalone DSH profile + hosted composition; probe. | must | M | — | Each bundle alone, together, uninstalled, from the packed artifact. |
| R19 | Shard the vcr-engine CI job (2–3 shards by a case-id partition file; a check that the union is every case once). | must | S | — | Each shard < 60 min on CI. |
| R20 | `audit:capabilities` against production (read-only) and trial-bundle receipt check. | must | S | — | Recorded result. |
| R21 | Status wording in §17, PROGRESS, TECHNICAL_DESIGN as the review asks. | must | S | — | Text. |

### M2: shared scientific contracts

| ID | Task | Pri | Size | Deps | Acceptance |
|---|---|---|---|---|---|
| R22 | Research question object (C.4): domain contract, versioned document, `vcr_write`/`vcr_read`, editable card on the study page, `questionRef` on every job, "answered an older version" marks. No required fields. | P1 | L | — | Domain tests; a live conversation builds it over three turns without a form; the page edits it; a result shows which version it answers. |
| R23 | Executable population (C.2): the virtual patient record, the instantiate step, beta_logit reading a population input, experiments passing it, `paired_counterfactual` vs `resampled_trials`, the decision on `vcrExperimentRecord`. | P1 | L | — | N-cases: the same input + seed gives bit-identical people across arms; a paired contrast's MCSE is smaller than an unpaired one's on known truth; covariates out of range become premises. |
| R24 | Uncertainty vocabulary (C.5) in the domain, engine result, views, reply sentences, report. | P1 | S | — | No 「功效」 label on a mode-averaged number; copy rules. |
| R25 | Effect distributions in the beta_logit scenario; assurance proper. | P1 | M | R24 | N-case: with a degenerate distribution it equals the fixed-effect power; with a normal prior it matches an independent Monte Carlo of the assurance integral. |

### M3: the science

| ID | Task | Pri | Size | Deps | Acceptance |
|---|---|---|---|---|---|
| R26 | Intercurrent events, MMRM (fast + GLS), reference-based conditional-mean imputation, tipping-point delta, true estimand values, bias/coverage per strategy×estimator (C.4). | P1 | L | R22 | N-cases: MMRM fast path = `nlme::gls` (tolerance stated); oracle `mmrm` in the test lock (D2); known-truth table; CPU per replicate measured before replicate floors are set. |
| R27 | External validation of placebo progression on the frozen post-2011 set (C.5). Each trial is analysed as it reported: MMRM LS mean, longitudinal ANCOVA or observed means. Trials stopped early (EPOCH, IDENTITY, bapineuzumab 3000) keep their reduced late-visit counts as stated premises. | P1 | M | R23, R26, R29 | Protocol frozen first; every trial run; bias/z/coverage table; the premise on AD pages. |
| R28 | A second ADAS-cog model structure + target-population runs + credibility record (C.5). | P2 | L | R23, R27 | Side-by-side spread on the R27 set; credibility fields on each result. |
| R29 | Tier A: marketed AChE inhibitors from the fitted posterior (C.1). | P1 | M | R25 | N-case vs the posterior's own Emax equation; the Cochrane consistency check documented as non-independent. |
| R30 | Tier B: aducanumab exposure → SUVR → clinical chain (C.1a), exploratory pack, output an effect distribution; lecanemab next. | P2 | L | R25 | N-cases reproduce Muralidharan 2022's PK and SUVR equations and its reported SUVR course within a stated tolerance; the clinical link draws Pang 2023's slope interval; the claim boundary and the three mismatches are premises. |
| R31 | Tier C: evidence → effect prior with source and estimand. | P2 | S | R25 | An `evidence.pool` result feeds R25. |
| R32 | Individualization (C.3): MAP/Laplace for beta_logit and a generic linear-mixed provider; the three claims' vocabulary. | P1 | L | R23 | Known-truth coverage within MCSE of nominal; vocabulary in views and reply. |
| R33 | Individual-prediction evaluation (C.3), frozen first. | P1 | M | R32, R15 | Full table with baselines; claims only as the protocol allows. |
| R34 | Robust recommendation (C.7). | P1 | L | R23, R26 | Per-scenario OC table, maximin, regret, Pareto, near-optimal set on the page and in the completion; no single 「最优」; benchmark on the frozen space. |
| R35 | `decision.value_of_information` (EVPI, EVPPI by GAM, thresholds; EVSI later) (C.6). | P1 | L | R25 | N-cases against Strong 2014's worked example (or a closed-form case) and `voi` as oracle (test lock). |
| R36 | Matched-budget search benchmark (C.6, ability 2). | P1 | M | R05, R06 | PCS / regret / budget-to-ε curves over ≥50 seeds for every arm. |
| R37 | Agent evaluations (C.6): (a) organization, 20×3; (c) next-experiment, 8 known-truth scenarios ×3. | must | M | R10, R22, R35 | Graded by code against keys; spend logged. |

### M4: PBPK, acceptance, documents

| ID | Task | Pri | Size | Deps | Acceptance |
|---|---|---|---|---|---|
| R38 | PBPK, scoped to one concrete exposure question (D4; default: a CYP3A4 interaction on midazolam with a published open model). Engine path decided first: closed-form/ODE in base R, or an ODE package (lock change, D2). | must | L | D4 | Reproduces the published clinical AUC ratios within the stated tolerance; premises state the model's context of use. |
| R39 | Live acceptance on the real-kernel harness. Scenarios:<br>• comparison after turn end;<br>• search by request;<br>• cross-conversation continuation;<br>• accrual by rate;<br>• research question over turns;<br>• AD with donepezil add-on and a mechanism-tier drug;<br>• robust table;<br>• VOI next step;<br>• Word/PDF export. | must | M | all | Each scenario kept with its transcript and code revision; defects fixed and re-run. Spend within D5. |
| R40 | TECHNICAL_DESIGN, PRD, DESIGN.md (new page parts), PROGRESS, this plan's execution record; memory note. | must | S | all | Docs. |

## F. Order and streams

1. **M0 first** (R01–R07 in parallel, R08 after). One executor stream per pair: R01+R02, R03+R04, R05+R06, R07. I review every diff; an independent reviewer re-runs the review's six harnesses against the fixed code.
2. **M1 and M2 in parallel**, each stream owning its files:
   - R10/R16 (gateway, tool description, `vcrExperimentSearch` compile);
   - R11 (gateway, store, web history);
   - R12/R24 (domain vocabulary, schema);
   - R14 (`vcr-package`, renderer);
   - R15/R17/R18/R19/R20 (ops, CI);
   - R22 (domain, gateway, web card);
   - R23/R25 (engine, domain, experiments).
3. **M3** once R22/R23/R25 land:
   - R26 → R34;
   - R27 → R28;
   - R29 → R30/R31;
   - R32 → R33;
   - R35 → R37c;
   - R36 → R16.
4. **M4**: R38 (after D4), R39 (live, once), R40.

Execution subagents run on Sonnet with written briefs (files, commands, acceptance). The main session commands, reviews and integrates. Three independent reviews (statistics, engineering/access, product) run before the live round, as last time. Heavy jobs run one at a time on this box: two disks with little room, 6.9 GB RAM shared with other sessions.

## G. Acceptance and retest

- **The review's retest rule holds:** retest on the final integrated revision; reuse unchanged methods' evidence; rerun every case and native path a fix touches.
- **Five layers for every task (11-07 plan §10):** execution success, numerical correctness, data/model quality, scientific usefulness for the declared context, and product usability. API success is not proof of the native route; a screenshot is not a model-quality score.
- **Every frozen protocol is committed before its first run** (R15, R27, R33, R36, R37), with source revision, data hashes, splits, metrics, full denominators and budgets.

## H. Owner decisions needed

| # | Decision | Recommendation | Owner's answer (2026-11-09) |
|---|---|---|---|
| D1 | F01/F02 (privacy, authorization) and F03 (orphaned work) are live. Ship R01–R07 as a hotfix delta now? | Yes, after CI and the walk. | Yes: build the hotfix delta (built and pushed; not deployed, per the same message). |
| D2 | Locks. The runtime lock needs no change for M0–M3 (`nlme`, `mgcv` ship with R). Add test-only oracles to the cross-check lock: `mmrm` (Apache-2.0, TMB compiled), `voi` (GPL-3), optionally `rbmi` (Apache-2.0)? | Yes to `mmrm` and `voi` in the test lock only. | Yes. |
| D3 | First interventions: Tier A = donepezil (+ galantamine, rivastigmine); Tier B pack = aducanumab end to end (PK and amyloid PD from Muralidharan 2022, the clinical link from Pang 2023), lecanemab next. Or a product you name? | As proposed, unless you have a real product question. | As recommended. |
| D4 | PBPK: which exposure question? | Default: midazolam CYP3A4 interaction. A question you name is better. | Midazolam CYP3A4 interaction. |
| D5 | Paid model calls on the shared DeepSeek key: R10 baseline and re-measure, R37 (about 84 conversations), R39. | About CNY 15–25 in total; logged per phase. | Approved. |
| D6 | Base on `codex/int-1108` (live), not main. | Yes; merge main once `int-1108` lands there. | Yes. `int-1108` reached `github/main` before execution began, so the branch is based on `github/main` (`aacd5eee5`). |
| D7 | Gaps 8 and 9 did not arrive. | Send them; they become R41+. | Gaps 8 and 9 withdrawn. |

## I. Sources used

Engineering facts are from the code at `34bd1869c`. Scientific sources were read through the web on 2026-11-08; working notes with locations are in the handoff directory (`RES-A.md`, `RES-B.md`, `RES-C.md`).

- **AD model and data:**
  - Rogers et al. 2012, J Pharmacokinet Pharmacodyn 39:479–498 (closed access);
  - EMA/CHMP/SAWP/567188/2013;
  - adsim 3.0 posterior (AD-SOURCE);
  - Ito et al. 2010, Alzheimers Dement 6:39–53;
  - Birks & Harvey 2018, Cochrane CD001190.pub3;
  - Salloway et al. 2014, NEJM 370:322 (PMC4159618);
  - Egan et al. 2018, NEJM 378:1691 (PMC6776074);
  - Lang et al. 2021, Alzheimers Dement TRCI 7:e12136 (PMC8165732);
  - Atri et al. 2018, JAMA 319:130 (PMC5833662);
  - lecanemab population PK, CPT Pharmacometrics Syst Pharmacol 2024;13:2111 (PMC11646937).
- **Estimands and estimators:**
  - ICH E9(R1) Step 4 (2019), A.3–A.5;
  - Hendrix et al. 2026, Alzheimers Dement e71676;
  - Sims et al. 2023, JAMA 330:512 (TRAILBLAZER-ALZ 2);
  - van Dyck et al. 2023, NEJM 388:9 (Clarity AD; ICER 2023 report);
  - Polverejan & Dragalin 2020, Stat Biopharm Res 12:142;
  - Bell et al. 2025, Pharm Stat e2472;
  - Carpenter, Roger & Kenward 2013;
  - Cro et al. 2020;
  - Wolbers et al. 2022, Pharm Stat 21:1246;
  - `mmrm` and `rbmi` (CRAN).
- **Uncertainty and credibility:**
  - O'Hagan, Stevens & Campbell 2005, Pharm Stat 4:187;
  - Kunzmann et al. 2021, Am Stat 75:424 (arXiv 2006.15715);
  - Temple & Robertson 2021, Pharm Stat 20:1102;
  - Wong, Siah & Lo 2019, Biostatistics 20:273;
  - Cummings, Morstorf & Zhong 2014, Alzheimers Res Ther 6:37;
  - ICH M15 Step 5 (EMA/CHMP/ICH/496426/2024);
  - FDA 2023 credibility guidance (devices; it makes no in-silico-trial recommendation). ASME V&V 40 was not read.
- **Mechanism layer:**
  - Muralidharan et al. 2022, CPT PSP 11:7 (aducanumab PK and SUVR);
  - Pang et al. 2023, Alzheimers Dement 19:1292;
  - Ren et al. 2025, arXiv 2504.06807;
  - Ackley et al. 2021, BMJ 372:n156;
  - Lin et al. 2022, CPT PSP 11:362 (aducanumab QSP);
  - Jamalian et al. 2023, CPT PSP 12:794 (CDR-SB model).
- **Search, robust choice and value of information:**
  - Richter, Friede & Rahnenführer 2022, Biom J 64:948;
  - Kim & Nelson 2001, ACM TOMACS;
  - Li et al. 2018, JMLR 18:185;
  - Benda et al. 2010, Drug Inf J 44:299;
  - FDA CID guidance 2020;
  - Strong, Oakley & Brennan 2014, MDM 34:311;
  - Strong et al. 2015, MDM 35:570;
  - Heath et al. 2018, MDM 38:163;
  - Rainforth et al. 2024, Stat Sci 39:100;
  - arXiv 2509.21403.
- **Individual prediction:**
  - Marinescu et al. 2021 (TADPOLE);
  - Koval et al. 2021, Sci Rep, doi:10.1038/s41598-021-87434-1;
  - Maheux et al. 2023, Nat Commun, doi:10.1038/s41467-022-35712-5;
  - `survival::pbcseq`, `JM::aids`, `speff2trial::ACTG175`, PhysioNet Challenge 2012 (ODC-By).

## J. Execution record

Work branch `codex/vcr-in-silico-r2-20261108` (from `github/main` `aacd5eee5`); hotfix branch `codex/vcr-review-hotfix-20261109` (from the live tree `fdbfb6552`, the M0 commits cherry-picked with `-x`). Entries are added as tasks close.
