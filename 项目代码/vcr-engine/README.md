# vcr-engine

The deterministic statistics and simulation engine behind 「虚拟临床研究」 (EviMed
Virtual Clinical Research). **Every number the module shows is computed here.**

It is an independent container driven by the control plane's job queue, in the
same shape as the meta and MR engines: a frozen scenario goes in, a result and
a manifest come out. It holds no model client, has no network egress, and reads
exactly the files a job names, under one read-only data root (section 3). A
language model never enters this path.

- Plan: `docs/superpowers/specs/2026-09-28-EviMed虚拟临研平台方案.md` (§5, §6.2, §7.2, §8.2, §11.4, §12.4)
- Integration contract (the authority for everything below that crosses a
  boundary): `docs/superpowers/specs/2026-09-29-vcr-integration-contract.md`
  (§2 the two rule grammars, §3.2 data inputs, §3.4 the result, §3.5 the service)
- Protocol authority: `OpenScience/packages/domain/src/vcrEngineJob.mjs`,
  `vcrScenarioSchemas.mjs`, `vcrRules.mjs`

---

## 1. What it guarantees

| Guarantee | How | Case |
|---|---|---|
| Same seed, any core count, bit-identical | one L'Ecuyer-CMRG substream per replicate; reduction in replicate order | N06, E03, E10b |
| Interruptible and resumable | a checkpoint per batch, carrying the scenario hash and the next stream state | N06, E03 |
| Cancel keeps finished batches and is honoured everywhere a job loops | a cancel file checked between simulation batches, bootstrap batches, accrual batches and synthetic copies | E03, E10b |
| A job returns its partial result before the kernel kills it | the R-side CPU budget is 0.9 of the smaller of the job's `cpuSecondsLimit` and `VCR_ENGINE_CPU_LIMIT`; the code `cpu_budget_exhausted` says why | E10b |
| Every simulated number carries its Monte-Carlo standard error | `vcr_measure(simulated = TRUE)` refuses to construct without one; a bootstrap's standard error is such a measure, and its interval endpoints' errors are in `diagnostics.bootstrap` (`vcr_boot_summary`) | N03, N04, AC-28, N33-N35 |
| Replicate counts follow from the target precision | `vcr_replicates_for_mcse` + the domain's floors (20,000 null / 5,000 alternative); a run held below its floor by `VCR_ENGINE_MAX_REPLICATES` is `limited` | N05, E10b |
| Analytic first, simulation as the check | every simulated design carries `diagnostics.analyticCheck` with the difference in MCSE units | E07, N02, N04c |
| "Not estimable" is a deterministic verdict, never a fabricated 0 | the named rules in `notEstimableRules` (seven at the first release, then `too_few_events` for a Cox model and `nuisance_model_not_estimable` for the doubly robust one); `measures` stays empty | N09, N11, N17, N33, N35 |
| The four counts stay apart | `vcr_counts()` + `vcr_validate_counts()`; `NULL` is the only stand-in for unknown; only `observed` rows are real patients | E04, C2-05, N17, E09 |
| Reconstructed pseudo-patients are never real patients | `counts.reconstructedPseudoPatients`, source `reconstructed` | N16, N17 |
| A rule is data, never code | no `eval`/`parse` anywhere in `R/` or `service/`; an `expression` key anywhere in a scenario is refused by name | N23 |
| The engine reads only what the job names, hash-verified, under the data root | `R/inputs.R` (section 3) | E06, N24, N25 |
| A job never raises | every malformation ends as a named refusal in a protocol-valid result | E10a |
| A result is labelled with the weakest source of the columns it used, not of its whole table | `columnSources` on a table input; `vcr_used_sources` (`R/inputs.R`) | N32 |
| Every dispatched method has a reference case the validation evidence records | the methods are the engine's own registry; `scripts/ops/vcr-method-references.mjs` names the case that holds each to something outside it, the evidence generator refuses a method with none, and a CI step checks it before the numeric run (section 12) | N41, `check-method-references.mjs` |

## 2. Running it

R 4.3.3 with the library in `R/package-lock.json`. On this development box:

```bash
export VCR_R_LIBS=/path/to/the/R/library   # built by scripts/vcr/r-library.sh install
export VCR_ENGINE_ROOT="$PWD"

# every numeric acceptance case, one line each, `PASSED x/y` last (40-60 min at 2 cores)
VCR_TEST_CORES=2 tests/run_all.sh
VCR_TEST_ONLY='N0[1-6]' tests/run_all.sh     # a subset, by id regex

# one job from a file (the service's own entry point; A1's, not this README's)
Rscript service/run_job.R job.json /tmp/out   # writes /tmp/out/result.json

# the HTTP service tests (no R needed: they use a fake engine)
python3 -m pytest tests/service -q
```

### Environment

| Variable | Read by | Meaning |
|---|---|---|
| `VCR_ENGINE_DATA_ROOT` | R | the only place a job's inputs are read from; unset means no patient-level file can be read |
| `VCR_ENGINE_CORES` | R, service | the ceiling; a job's own `cores` can only **lower** it (default 1) |
| `VCR_ENGINE_MAX_REPLICATES` | R, service | most replicates a job may ask for (default 200,000) |
| `VCR_ENGINE_CPU_LIMIT` | R | the kernel's CPU limit on the process; R stops at 0.9 of `min(this, the job's cpuSecondsLimit)` |
| `VCR_ENGINE_MAX_INPUT_BYTES` | R | one input file's size cap (default 512 MiB) |
| `VCR_ENGINE_MAX_RECORDS` | R | most generated records per job (default 2,000,000) |
| `VCR_ENGINE_DEBUG` | R | full R error text in `handler_error` (never set in production) |
| `VCR_ENGINE_TOKEN_FILE`, `VCR_ENGINE_RECEIPT_KEY_FILE` | service | required request token and optional receipt key, as files (>= 32 bytes, no symlink); omitting the receipt key preserves authenticated execution and hash verification. Only `VCR_ENGINE_INSECURE_DEV=1` permits a missing request token |
| `VCR_ENGINE_MAX_TABLE_BYTES` | service | largest output table the table route streams (default 512 MiB; over it is 413 `table_too_large`) |
| `VCR_ENGINE_WORK_DIR`, `VCR_ENGINE_CPU_SECONDS`, `VCR_ENGINE_MAX_CPU_SECONDS`, `VCR_ENGINE_MEMORY_BYTES`, `VCR_ENGINE_MAX_BODY_BYTES`, `VCR_ENGINE_KEEP_JOBS`, `VCR_ENGINE_CANCEL_GRACE_SECONDS`, `VCR_ENGINE_KILL_GRACE_SECONDS` | service | see the docstring of `service/app.py` |

Global concurrency is 1 by design (plan §11.4: the production host is a shared
four-core box).

## 3. Where a job's data comes from

`inputs[].location` is a path **relative to `VCR_ENGINE_DATA_ROOT`**. The
engine refuses (with a fixed code, never an echo of file content): an absolute
path, `..`, a symlink at any level, a directory, a missing or wrong `hash`
(`input_hash_missing`, `input_hash_mismatch`), a format that is not csv, tsv,
json or parquet (`input_format_unsupported`), a file over the cap
(`input_too_large`) and a table that will not parse (`input_parse_failed`).
The bytes are hashed and then parsed *from memory*, so the file that was
checked is the file that was read. Parquet is the engine's own reach, not the
product's: the control plane's intake takes csv, tsv, json and xlsx and refuses a
Parquet upload by name, so a job it builds never names one.

`valueSource` is honoured, not assumed. The control plane sets it from the
snapshot or population the file came from, and the domain says per method which
sources are a record of real people (`individualInputSources`):
`population.synthpop` and the entropy-balance, propensity-weight and MAIC
comparators read `observed`, `extracted`, `calculated` or `imputed` rows and refuse
any other (`input_source_not_individual`); `comparator.rmst` also reads the
`reconstructed` pseudo-patients of a literature control. `counts.realPatients`
counts the rows of those four real-patient sources; reconstructed rows are counted
apart as `reconstructedPseudoPatients` and synthetic ones as `generatedRecords`,
never as real patients.

`columnSources` (optional, a table input's, written only by the control plane) is
the source of single columns: `{ "age": "imputed", "male": "observed" }`, each
word one of `observed`, `extracted`, `calculated`, `imputed` (most direct first;
the order is the domain's `VCR_COLUMN_SOURCES`). A column it does not name has the
table's `valueSource`, which the control plane sets to the weakest of the table's
columns. It is accepted only on a table of real people's rows (never on a
synthetic, aggregate or reconstructed one). A method then labels its result with
the weakest source among the columns it **used** (covariates, arm and outcome
columns, the columns its rules name; a profile and a synthesis read every
column), so one imputed column that the method never read does not mark the
result imputed. What it used is in `diagnostics.valueSourcesUsed`
(`weakest`, `basis` = `columns` when any used column had a source of its own and
`table` when none did, and each used column's source). Counts such as `rows` and
`cohort_size` carry that source; an estimate is `calculated` unless it rests on an
imputed column, when it says `imputed` (a computed value ranks above an imputed
one, so an estimate cannot be more direct than the column it was computed from).
How a source is spelled in Define-XML and ADaM for an export is the domain's
(`VCR_COLUMN_SOURCE_EXPORT`), not this engine's.

Analysis tables come in three shapes: `subject` (ADSL, one row per person),
`longitudinal` (BDS, one row per person and visit) and `events` (ADTTE: `AVAL`
is the time, `CNSR = 1` means censored, so the event indicator is `1 - CNSR`;
`parameterCode` picks a `PARAMCD`). Output tables are written into the job's
output directory and named in `tables[]` by a bare file name plus sha256.

## 4. HTTP interface

```
GET    /livez              -> {ok}                          no token, nothing else
GET    /health             -> {ok, engineVersion, rVersion, protocolVersion, methods, packageLockHash}
POST   /jobs               -> 202 {jobId, accepted}
GET    /jobs/{id}          -> {jobId, state, progress:{done,total}, cpuSeconds, cpuSecondsLimit, error}
POST   /jobs/{id}/cancel   -> {canceled}
GET    /jobs/{id}/result   -> the full result, optionally signed when configured (409 until it exists)
GET    /jobs/{id}/tables/{name} -> one output table's bytes (text/csv), only a table the finished result lists
DELETE /jobs/{id}          -> {discarded: true}
```

`Authorization: Bearer <token>`. Refusals are `{"detail": "<fixed code>"}`: 401
`unauthorized`; 404 `job_not_found`, `table_not_found`; 409 `job_already_submitted`,
`job_still_running`, `result_not_ready`, `job_directory_conflict`; 413
`job_body_too_large`, `table_too_large`; 422 `job_body_invalid`, `job_id_invalid`,
`job_field_invalid` (+ `field`), `job_replicates_too_large`; 503
`job_directory_unavailable`, `engine_self_check_failed`. A job's `error` is one
of `engine_crashed`, `cpu_limit_exceeded`, `memory_limit_exceeded`, `canceled`,
`result_unreadable`, `spawn_failed`. States are `queued | running | canceling |
succeeded | failed | canceled | not_estimable`. No response carries R's stderr
or a traceback.

## 5. Methods

The methods of the domain's `VCR_ENGINE_METHODS`, at `1.0.0` (the first release's 24
and, appended after them, the comparator-effect methods of section 11, the
robustness methods below and the trajectory generator `patients.longitudinal`), except
`design.analytic` (1.1.0), `design.assurance` (1.1.0: group sequential) and
`design.simulate` / `design.grid` (1.2.0: single-arm means and survival times; a
job recorded at an earlier version stays valid for what that version could run:
`legacyVersion` by design, `legacyReleases` by design and endpoint), one job kind each, keyed exactly as that registry. The
engine refuses to start if the lists differ
(`vcr_engine_self_check`, N00b). `R/domain-snapshot.json` is generated from
the live domain by `tests/helpers/emit-domain-snapshot.mjs` (never edit by
hand); N00a regenerates it and fails on drift. The engine reads the domain's
own scenario schemas, patient-level kinds, design support table and limits from
that snapshot and validates every job against them before a handler runs.

| Method | Does | Cross-checked against |
|---|---|---|
| `profile.snapshot` | column summaries, cells below the minimum cell size suppressed | — |
| `cohort.build` | named row rules (`rule` grammar, §2 of the contract): kept / excluded / indeterminate per rule, criterion impact, time zero, exit, member table, the rules' hash; with `compare` ({ rules, covariates }) a second version of the definition on the same table: both sizes, the overlap and each covariate's standardized difference (`vcr_smd`, pooled denominator; a difference of proportions for a 0/1 covariate), a covariate it cannot compare named with its reason | a truth table (C2-01..07); base-R arithmetic (N37) |
| `population.scenario` | declared marginals + Gaussian copula + row-rule constraints (violating rows are redrawn) + missingness, `paramSd` for parameter uncertainty; `diagnostics.profile` describes the generated table beside what was declared (section 12) | closed-form moments; the profile recomputed from the CSV (N45a) |
| `population.literature` | a published baseline table (mean/sd with optional bounds, proportion, categorical proportions, lognormal) as a population; an assumed correlation comes with its sensitivity; `diagnostics.profile` as above | moment recovery (N28a, N45b) |
| `population.synthpop` | sequential CART, `m` in 5–50 copies, rare levels merged, holdout (the copies are not pooled into an estimate: no combining rule ships until a job needs one); `diagnostics.profile` of the first copy with the small-cell rule | synthpop; the small-cell rule (N45c) |
| `population.quality` | the fixed fidelity / utility / disclosure suite; the disclosure axis is size-matched | a memorizer, a shuffle (C2-15..18) |
| `patients.continuous` `.binary` `.time_to_event` | the reference simulators; for a stored population, arms by a fixed uniform and `truth.covariateEffects` (centred at the population mean) | regression on the output (N28c), common random numbers (E10c) |
| `patients.longitudinal` | a continuous trajectory: the linear mixed model `y_ij = (b0 + u0_i) + (b1 + u1_i) t_j + delta z_i t_j + beta' x_i + e_ij` (random intercept and slope with SDs and a correlation, the treatment effect changes the slope, MCAR monotone dropout per visit, one row of uniforms per person so the same seed is the same person under another scenario); a long table, the arms' mean trajectories with the band that holds 95% of the patients, three example individuals shown under both arms | `nlme::lme` fitted to the output and the closed-form mean and SD at every visit (N46a), common random numbers and retention (N46b, N46c) |
| `evidence.pool` | DL / REML / HKSJ + prediction interval; k = 1 is `single_study` | metafor |
| `evidence.reconstruct_km` | Guyot reconstruction + quality control | round trip (N16) |
| `comparator.entropy_balance` | ATT weights, balance, ESS, whole-pipeline stratified bootstrap; dispatches on the endpoint (weighted mean, binary, or weighted KM + RMST(τ)) | WeightIt, cobalt |
| `comparator.propensity_weight` | logistic PS weights (overlap diagnostics) | WeightIt |
| `comparator.rmst` | weighted KM, RMST(τ), the τ rule | survRM2 |
| `comparator.maic` | anchored / unanchored MAIC, whole-pipeline bootstrap variance | independent BFGS on TSD 18's objective |
| `comparator.weighted_cox` | weighted Cox hazard ratio, robust variance and whole-pipeline bootstrap, the proportional-hazards test, the RMST difference beside it | `survival::coxph` on WeightIt weights; `tt()` and hand-written Breslow score tests; a known hazard ratio |
| `comparator.covariate_sets` | the comparator analysis (entropy balance, logistic propensity weights or the doubly robust estimate) re-run under 2-8 pre-declared covariate sets: each set's estimate and verdict, the range | WeightIt weights per set; the analyses' own jobs bit for bit; a design with known confounders |
| `comparator.aipw` | doubly robust (AIPW) estimate of the ATT for a single-arm study against an external control (binary or continuous): influence-function and whole-pipeline bootstrap standard errors | the formula on WeightIt weights and `glm` (1e-10); a simulation with an exactly integrated truth, four model specifications |
| `comparator.maic_time_to_event` | unanchored / anchored MAIC for hazard ratios (weighted Cox on the study's patients and the comparator's reconstructed patients; Bucher on the log scale), robust and bootstrap variance | the maicplus 0.1.2 vignettes (to 7 digits); a simulation with an oracle target |
| `comparator.evalue` | E-values on every scale | EValue |
| `comparator.map_prior` | MAP by quadrature, robustify, prior ESS (ELIR), conflict against the MAP alone, hybrid operating characteristics | RBesT, an independent joint grid |
| `design.analytic` | Schoenfeld, Lan-DeMets boundaries (`sided` honoured), n, exact single-arm binomial rejection/power, Simon two-stage over the whole grid | rpact, gsDesign, `stats::binom.test`, published Simon designs |
| `design.simulate` | the ADEMP runner: fixed two-arm, calendar-time group sequential, exact binary single-arm, frozen Simon, explicitly synthetic stratified binary external controls; single-arm trials of a mean (one-sample t or z against a fixed benchmark) and of a survival time (one-sample log-rank against a benchmark distribution), section 12 | `design.analytic`, independent binomial/joint-table enumeration, beta-binomial moments, independent `survdiff` (N04c), `stats::power.t.test` (N48a), an independent plain-R simulation (N48c) |
| `design.grid` | designs × truths, one immutable run per cell, a long-format table | — |
| `design.assurance` | power averaged over a design prior (normal on effect, on log HR, on the risk difference); for a group-sequential design the probability of crossing a boundary at any look, with the share at each look and a simulated check carrying its Monte-Carlo error (section 12) | numerical integration, a Monte-Carlo z-test; rpact's group-sequential power integrated over the prior (N47) |
| `design.procova` | prognostic-adjustment sample size, three paths | the closed form, EMA 2022 |
| `accrual.poisson_gamma` | per-site Poisson-Gamma accrual, staggered starts, screen failure, event target | closed form vs simulation, metafor-style REML for the pool (N27) |
| `matching.evaluate` | Kleene three-valued eligibility; a criterion that does not apply cannot exclude | the truth table (N29) |

### Robustness methods (2026-10-04)

Three methods for the question "how far can this comparison be wrong". Each takes
named inputs, refuses by name, reports `not_estimable` with an empty `measures`
under a named rule, carries a Monte-Carlo standard error on anything simulated,
and is seeded and reproducible (same seed, same bytes). None reads an `eval` or a
`parse`.

| Method (job kind) | Does | Held to |
|---|---|---|
| `comparator.negative_control` (`negative_control_comparator`) | outcomes the treatment cannot affect, analysed with the primary's adjustment: per control an estimate, an interval and a bias-screen verdict; with at least 30 estimable controls an empirical null N(mu, tau^2 + se_i^2) fitted by maximum likelihood (`stats::optim`, L-BFGS-B, tau^2 >= 0) and a calibrated p-value for the effect of interest | EmpiricalCalibration 3.1.4's `sccs` example (vendored under `tests/fixtures`, Apache-2.0), metafor's ML fit, WeightIt, a known-bias simulation (N37) |
| `comparator.tipping_point` (`tipping_point`) | missing outcomes. Binary: exact enumeration of how many of the missing responded in each arm, the analysis's own test at each grid point (Fisher exact, the pooled risk-difference test, or the exact binomial for a single arm), the region where the conclusion changes and the nearest tipping point. Time to event: a delta-adjusted hazard after censoring (Jackson et al. 2014) by seeded multiple imputation, the smallest delta that overturns the result with its Monte-Carlo error | a table counted by hand, `fisher.test` / `prop.test` / `binom.test` cell by cell, `survival::coxph` for the kernel and for the worst-case limit, replication over seeds (N38) |
| `comparator.prognostic_adjustment` (`prognostic_adjustment_comparator`) | a pre-specified prognostic score (a column) in a logistic or a Cox model, reported as a marginal effect: binary, the standardised risk difference, risk ratio and odds ratio with an influence-function (sandwich) standard error beside a stratified bootstrap; time to event, the conditional hazard ratio and the standardised RMST difference. Every result carries `diagnostics.regulatoryStatus` | FDA 2023 guidance Table 1, an M-estimation sandwich from numerical Jacobians, `sandwich::sandwich`, `survival::coxph` and `survfit(newdata)`, simulations against integrals (N39) |

**Negative controls.** A control is a 0/1 column of the subject table (analysed
here: the weights are the primary's, entropy balance or propensity, re-estimated in
every bootstrap resample, and the effect is the weighted log risk ratio or log odds
ratio) or an estimate and standard error on the log scale that was analysed
elsewhere (the way a hazard ratio enters). The verdict of a control is a function of
its interval: `signals_bias` (the interval excludes 0), `uninformative` (it contains
0 and also the effect of interest, so a bias that large is compatible), else
`consistent_with_null`. **The calibration floor is 30 estimable controls** (a domain
preset, `negativeControlCalibrationMin`, never a scenario key): the null's spread is
estimated from the controls themselves, a standard deviation from k independent
values has a relative standard error of about 1 / sqrt(2 (k - 1)) (13% at 30, 20% at
13), and the literature's guidance for empirical calibration is 30 to 50 controls
(Schuemie 2014, 2018). Below it the result lists each control with its verdict and
says the set is too small, `conclusion: limited`, no null, no calibrated p-value.
**No calibrated interval is ever reported**: that needs positive controls with a known
true effect, which one comparison does not have. A control with an arm without
events has no risk ratio: it is listed with its reason and left out of the screen and
the null; none estimable is `negative_controls_not_estimable`. Only a 0/1 column is
analysed in the engine; a time-to-event control comes in as an estimate. A result
computed only from estimates, or from tipping-point counts, that a caller typed
labels its measures `aggregate` (a summary, not patients); one that analysed a column
says `calculated`.

**Tipping point.** Binary: the reference cell is how the primary analysis treated the
missing (`non_responders`, the corner (0, 0), or `complete_cases`, the missing
responding at their own arm's observed rate, rounded); the nearest tipping point is
searched in the direction that threatens the conclusion (against the treatment when
the primary is significant, in its favour when it is not, `direction` overrides) by
L1 distance in patients, and the nearest in any direction is reported beside it. The
grid is at most 40,000 scenarios (a limit on work, refused by name above it). Time to
event: `horizon` is the end of the analysis window; the primary Cox model, the
imputation and the analysis all use data administratively censored there. People
censored before it, in the arms the delta applies to (`treatment`, or `both_opposite`
with the control's delta the reciprocal), are imputed at every delta, delta = 1
included, from a Cox model with a piecewise-linear Breslow baseline refitted on a
stratified bootstrap in every imputation; the other arm keeps its censoring. The
job's `replicates` is the number of imputations (at least 40). Rubin's rules combine;
the tipping delta is interpolated on common random numbers and its Monte-Carlo error
is a delete-one jackknife. The worst case (delta without bound: the threatened arm's
early-censored fail at the moment of censoring) is reported beside the grid and is
exact. A delta of 1 reproduces the primary analysis within Monte-Carlo error plus a
finite-sample difference of up to about 7% of the primary's standard error
(measured over 20 data sets; N38c allows 10%), which `diagnostics` shows.

**Prognostic adjustment.** The score is a pre-specified covariate, taken on trust: in
a randomized trial it buys precision and not a different answer, in a non-randomized
comparison it is one more covariate and corrects no confounding. The headline is
marginal because the conditional odds ratio and hazard ratio are not collapsible
(FDA 2023, Table 1: conditional 8.0, marginal 4.8; N39a reproduces it). **No
regulator has qualified this beyond continuous outcomes**: the EMA qualification
opinion on PROCOVA (CHMP, adopted 15 September 2022) leaves binary and time-to-event
as future work, and FDA's 2023 guidance calls nonlinear adjustment "potentially
acceptable" and asks sponsors to discuss it with the review division. That statement
is `diagnostics.regulatoryStatus` (`qualification: none_beyond_continuous`, the
domain's `VCR_PROGNOSTIC_QUALIFICATION`) on every result, refusals included, so the
page can say it. A continuous endpoint is refused by the protocol (`design.procova`
sizes the EMA-qualified method). A missing score, covariate or outcome value is
refused (`missing_covariate`), never dropped.

Two not-estimable rules are new: `negative_controls_not_estimable` and
`primary_analysis_not_estimable` (an arm with no event or no person, a model without
a maximum, a score with no spread). `tau_beyond_followup` is the prognostic method's
RMST horizon rule, as in `comparator.rmst`.

## 6. The result

Every result validates against `validateEngineResult` before it is returned
(the engine runs the domain's own rules on its own output; a result this build
cannot validate becomes `failed`). Beyond the protocol's fields:

- `conclusion` is `estimable | limited | not_estimable`, top level, with
  `notEstimableRule` when it is not estimable.
- every measure carries `source`, one of the nine value sources.
- `manifest.outputHash` is computed in R over the canonical result;
  `manifest.signature` (HMAC over jobId, scenarioHash, outputHash) is added by
  the service. `manifest.packageLockHash` hashes the runtime lock's package
  contents only.
- `counts` always carries the four keys; optional keys appear only when their
  route was used.
- `diagnostics.issues` is the list of refusals (`code`, `field`, `detail`); a
  result stopped by `cpu_budget_exhausted` is `failed` and still carries the
  measures of the replicates that finished. A canceled job names no replicate
  count when it completed none.

`evidence.pool` (`vcrEvidence.mjs`'s `readPoolResult`): measures `pooled_estimate`
(with a confidence interval), `prediction_interval`, `i_squared`, `tau_squared`,
`tau`, `k`; `diagnostics.distribution` is the pooled result reparameterized so a
simulation can draw from it (proportions -> beta on the logit, times and ratios
-> lognormal, else normal), with `basis` saying whether the spread is the
prediction distribution. **When `k < 3` the prediction measure is absent** and
`diagnostics` says why; the confidence interval is never substituted for it.

## 7. Scenario keys the handlers read

The domain's scenario schemas are the authority, and the domain lists every key
the handlers read. `tests/helpers/scenario-schema-additions.json` is the
checklist that keeps it so: 65 entries (method, path, key, expected schema
node), each looked up in the domain's schemas by case N26, which fails naming any
that is missing or unreachable (and asserts it looked up all of them). A missing
entry is also overlaid in memory so the rest of the suite still runs against the
intended contract.

`cohort.build`: `timeZero.column`, `exit.column`, `idColumn`, `compare.rules`, `compare.covariates` · `population.scenario`:
`variables[].paramSd` · `population.literature`: `baselineTable[].proportions`,
`.levels` · `population.synthpop`/`.quality`: `analyses[]`, `tstrOutcome` ·
`patients.*`: `truth.covariateEffects` · `evidence.reconstruct_km`: `provenance`,
`treatmentArm` · `comparator.entropy_balance`/`propensity_weight`: `endpoint`, `tau`,
`timeUnit`, `parameterCode`, `cohortRules`, `targetTrial` · `comparator.rmst`:
`parameterCode`, `cohortRules` · `comparator.maic`: `treatmentColumn`, `endpoint`
(and the two routes are separate variants: unanchored states `aggregateOutcome` and
`outcomeColumn`, anchored states `aggregateEstimate`) · `comparator.map_prior`:
`operatingCharacteristics` · `design.simulate`/`.grid`: `costs` · `design.assurance`:
`designPrior.kind`, `.basis`, `.basisOverride`, `analysis.sided` · `design.procova`:
`analysis.sided` · `accrual.poisson_gamma`: `eventHazard`.

## 8. Layout

```
R/protocol.R         job & result validation against the domain snapshot, canonical JSON, output hash, replicate arithmetic (A1's)
R/rules.R            the row-rule grammar: validate and evaluate, three-valued, never parsed as code
R/inputs.R           the data-root reader, table inputs, job context (cancel, CPU budget), refusals
R/rng.R              L'Ecuyer-CMRG substreams, ordered parallel map, the core ceiling
R/simulators.R       the three reference simulators and their analyses
R/population.R       scenario / literature / synthpop populations, mechanistic interface
R/quality.R          synthetic-data report suite, model cards, calibration, temporal leakage
R/weighting.R        entropy balancing, propensity weights, SMD, ESS, whole-pipeline bootstrap, not-estimable rules
R/rmst.R             weighted KM, RMST, the τ rule
R/reconstruct.R      Guyot reconstruction and its quality control
R/maic.R             MAIC (anchored / unanchored) and STC
R/comparison.R       what the comparator-effect methods share: the weighted frame, a bootstrap's own Monte-Carlo error
R/weighted_cox.R     the weighted Cox hazard ratio, its robust variance, the proportional-hazards test
R/maic_tte.R         the time-to-event MAIC, unanchored and anchored
R/aipw.R             the doubly robust (AIPW) ATT estimator
R/covariate_sets.R   the comparator analysis re-run under alternative covariate sets
R/evidence_pool.R    DL / REML / HKSJ pooling and prediction intervals
R/map_prior.R        MAP by quadrature, robustify, prior ESS, conflict, hybrid operating characteristics
R/design_analytic.R  Lan-DeMets boundaries, Schoenfeld, asymptotic log-rank power, Simon
R/design_simulate.R  the ADEMP runner: batches, checkpoints, cancel, budget, MCSE; the design grid
R/assurance.R        power averaged over a design prior; the assurance of a group-sequential design
R/longitudinal.R     the linear mixed model's generator and the summaries the patients page draws
R/single_arm.R       single-arm trials of a mean and of a survival time against a benchmark
R/procova.R          prognostic-adjustment sample size
R/accrual.R          Poisson-Gamma accrual, event target, online update, back-test
R/negative_control.R, R/tipping_point.R, R/prognostic_adjustment.R   the three robustness methods (sourced after the core list)
R/engine.R           job dispatch, the handlers (one per method), the manifest, the self-check, the engine's own issue codes
R/domain-snapshot.json   generated from @evimed/domain (never edit by hand)
R/package-lock.json      the runtime library the Dockerfile verifies (62 packages)
service/app.py           FastAPI: queue of one, process group, rlimits, cancel, receipt signature
service/run_job.R        one job, one process (A1's)
service/parquet_bridge.py  Parquet -> CSV, converts only
tests/numeric/           the numeric acceptance cases (one file per family)
tests/helpers/           harness, canonical fixtures, the schema-additions overlay, the robustness methods' and the 2026-10-07 extensions' handler jobs
tests/fixtures/          third-party data a case is held to (EmpiricalCalibration's sccs example, with its license)
tests/service/           the service tests (fake engine, no R)
tests/package-lock.crosscheck.json   the cross-check library (96 packages) of the test image
tests/run_all.sh         one command, one line per case
```

## 9. Numeric acceptance

`tests/run_all.sh` prints one line per case:

```
N01    PASS AC-30,AC-04 | 3.7103/2.5114/1.9930 …  [6.5s]
…
PASSED n/n
```

Case families: `N00a-l` (the protocol mirror), `N01-N22` (design, weighting,
survival, literature, borrowing, PROCOVA), `N23-N31` (rules, data plane, schema
agreement, accrual and pooling, populations and patients, matching, a column
name is data and never code (N30), single-arm references (N31)), `C2-01-C2-18`
(cohort, models, quality), `N32` (the source of a column), `N33` (the weighted Cox hazard ratio), `N34` (the time-to-event MAIC), `N35` (the doubly robust estimator), `N36` (covariate sets), `N37-N39` (the
robustness methods: negative controls, tipping point, prognostic adjustment), `N40`
(their protocol parity and breaking battery), `N41` (reference cases for
`profile.snapshot` and `population.synthpop`), `N42` (two versions of a cohort
definition compared on one table), `N43-N44` (a design is sized for an effect: `design.analytic` refuses a null effect by name in every family, and `design.simulate` on the same null scenarios reports the type I error), `N45` (the profile of a generated population), `N46` (longitudinal virtual patients), `N47` (the assurance of a group-sequential design), `N48` (single-arm means and survival times), `N49` (the extensions' protocol parity, breaking battery and published examples), `E01-E10` (the engine itself: accrual, cancel and
budget, counts, inputs, analytic vs simulated across the families, group
sequential, the T0 chain, robustness and limits), `Z99` (every method went
through `vcr_run_job`, and through a case that asserts numbers). Each line carries
the `AC-…` scenarios it covers, so the acceptance table is built by grepping.

A statistical case names its reference (a package in the cross-check lock, a
closed form, or an independent simulation written in the case) and would have
failed on the code it replaced; the comment on the case says what it pins.

## 10. Things a caller should know

1. **Scenario hashing is over canonical JSON.** R reproduces ECMAScript's
   `JSON.stringify` exactly, including shortest-round-trip number formatting
   and `null` for non-finite numbers, so `followup: Infinity` hashes the same
   on both sides (N00c).
2. **`alpha` is the total.** A two-sided test spends `alpha / 2` per tail in
   every analysis, every analytic reference and every boundary.
3. **The asymptotic log-rank power is a first-order reference**, good to about a
   percentage point at the effect sizes a trial is designed for (its measured
   accuracy is in `R/design_analytic.R`); the simulation is the check on it and
   `analyticCheck` reports the difference in MCSE units.
4. **A quality band is a notice.** The only invariant in the synthetic-data
   suite is that declared hard constraints are violated zero times; the colour
   thresholds are this product's defaults, marked `product_default` in
   `bandSources`.
5. **The disclosure axis refuses to compute without a holdout**, compares
   like sizes (it averages three subsamples) and never concludes that anything
   is anonymous.
6. **A refusal of a job whose own `seed`, `method`, `methodVersion`, `jobId` or
   `replicates` is malformed echoes that field, so the refusal itself fails
   result validation on it.** The control plane validates a job before it sends
   it; only a direct caller can see this, and reads `diagnostics.issues`.
7. **The engine's own issue codes** (`VCR_ENGINE_OWN_ISSUE_CODES` in
   `R/engine.R`) are the ones the protocol registry does not carry; E10d fails
   when a code is literal in the sources and in neither list.
8. **`design.analytic` sizes a design for an effect.** A scenario whose effect
   is exactly null (hazard ratio 1, effect 0, equal binary rates, risk
   difference 0, odds ratio 1) has no sample size, and is refused as
   `design_effect_null` on the field that states the effect; the type I error of
   a design is `design.simulate`'s measure on the same scenario (N43, N44).
   The exact single-arm design is given its size and so computes at a null rate.
### Binary single-arm contracts (design methods 1.1.0)

`single_arm` requires `design.n`, `truth.nullRate`, `truth.responseRate` and
`analysis.method: exact_binomial` with an explicit `alternative` (`greater`,
`less`, `two.sided`) and matching `sided`. Its success rule is exact p-value
less than or equal to alpha; the two-sided convention orders binomial
probabilities as [R's exact test](https://www.stat.ethz.ch/R-manual/R-devel/library/stats/html/binom.test.html).
Response rates may equal zero or one. Analytical rejection probability is
exact count enumeration; confidence intervals are Clopper-Pearson and remain
distinct from the Monte Carlo interval on simulated performance.

`simon_two_stage` analytical search retains optimal/minimax selection over
the complete grid ([Simon 1989](https://pubmed.ncbi.nlm.nih.gov/2702835/)).
Simulation requires the selected, frozen `design.n1/n/r1/r`: stop for futility
when first-stage responses are at most r1; after continuing, success requires
total responses strictly greater than r. It draws no unobserved second-stage
records after stopping. Rejection, PET and expected N carry MCSE and exact
references. The naive stopped response estimate is labeled as such; an adjusted
sequential confidence interval is not implemented, so no coverage is fabricated.

`single_arm_external` supports **binary two-stratum synthetic scenarios only**.
The frozen `external.kind: stratified_beta_binomial` declares historical size,
source/target covariate prevalences, finite beta `parameterInformation`,
`logOddsDrift`, and a finite `sensitivityDrifts` list. Truth gives two
`controlRates` and `treatmentRates`; analysis declares ATT and
`stratified_risk_difference`. Both response means are standardized to the fixed
treatment target. The historical generation law has shared stratum parameter
uncertainty; increasing generated historical size never removes that component.
Its Wald variance includes that declared beta-binomial uncertainty. Calibration,
bias, coverage, effective historical N and every drift sensitivity are actually
simulated. Missing target-stratum support produces `not_estimable`; replicate
failures remain in performance denominators. This is neither observed controls
nor a causal guarantee: selection, time drift and unmeasured confounding remain
limitations ([FDA external-control guidance](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-design-and-conduct-externally-controlled-trials-drug-and-biological-products)).

Single-arm null floors derive from responseRate minus nullRate, or target ATT,
not from a flag that changes no generating law. A contradictory `truth.null` is
refused. All generated records remain synthetic; realPatients is zero. The
single-arm trial of a mean or a survival time is section 12. Prior supported
two-arm/group-sequential (and analytical Simon) jobs may replay version 1.0.0;
new variants require 1.1.0 (and the single-arm means and survival times 1.2.0). N31 records numerical evidence; local unpinned R runs
are exploratory, and release validation runs the locked R 4.3.3 library in CI.

## 11. Comparator-effect methods

Added after the first release's 24; each is a method of its own with its own job kind
(appended to the domain's list), schema, numeric cases and refusals. The weights are
always estimated **inside** the job: a weighted number whose weights somebody else
estimated has an interval that treats them as known, so none of these methods takes a
weight column, and every bootstrapped quantity is reported with its own Monte-Carlo
standard error (`diagnostics.bootstrap.seMcse`, and the order-statistic standard error
of each interval endpoint in `intervalMcse`; the bootstrap standard error is also a
`simulated` measure carrying `mcse`).

### `comparator.weighted_cox` (case N33)

`Surv(time, status) ~ arm`, with case weights from entropy balancing or the logistic
propensity score (`weighting`, the weighting jobs' own rules and thresholds, the same
refusals of a malformed table), `ties` Efron (default) or Breslow. Reported:
`hazard_ratio` (the trial's against the control's) with the **bootstrap** percentile
interval (rows resampled within arm, the weights re-estimated and the Cox model refitted
in every resample), `hazard_ratio_robust` with the Lin-Wei sandwich interval (the weights
treated as known), their standard errors, and the ratio of the two in
`diagnostics.varianceComparison` (a metric, never a gate: the robust variance is biased
low when the effective sample size is small). `ph_test_chisq` and `ph_test_p` are
`survival::cox.zph` (a weighted score test with the weights treated as fixed, so
descriptive when they were estimated), the per-term and global rows are in
`diagnostics.proportionalHazards`, the scaled Schoenfeld residuals in the table
`ph-schoenfeld`. The level (`phAlpha`) and the time transform (`phTransform`) are in the
scenario, declared before the data is read, and **the estimator is not switched by the
result**: when it rejects, the hazard ratio is still reported, the conclusion is
`limited` (`limitedBy: proportional_hazards_rejected`) and `rmst_difference`,
`rmst_treatment`, `rmst_control` and `survival_difference_at_tau` at the scenario's `tau`
stand beside it (`tau` is required so the companion is always computable; a `tau` beyond
follow-up keeps the hazard ratio and says `rmst_companion_unavailable`). An arm with no
event, or a fit that does not converge, is `not_estimable` / `too_few_events` with no
number; fewer than `limits.coxFewEvents` (10) events in an arm is `few_events`, a notice.
A budget that runs out inside the bootstrap keeps the point estimate, the robust variance
and the PH test and reports no bootstrap interval (`failed`, `cpu_budget_exhausted`,
`limited`, the engine's partial-result convention).

### `comparator.maic_time_to_event` (case N34)

Weights are `vcr_maic_weights` (MAIC is entropy balancing), taken at the TSD 18 / maicplus
scale `exp(X' lambda)` with the covariates centred at the aggregate trial's means
(`targets`) and **never rescaled to n**: the study's weighted patients and the
comparator's reconstructed patients (weight 1) share one Cox model, so the weight scale
moves the hazard ratio (0.2806 rescaled, 0.283478 as published, on the maicplus data).
The study's patients are the subject table (and its events table); the comparator's
pseudo-individual rows are a `snapshot_file` input labelled `reconstructed` (a Guyot
reconstruction's `time`, `status`, and for an anchored comparison `arm`), named in the
scenario by `pseudoIpdInputId`. Real patients and reconstructed ones are kept apart
(`counts.realPatients`, `counts.reconstructedPseudoPatients`), the effective sample size
is the study weights' and never exceeds the real patients, and a comparator table that
is not a reconstruction, or a study table that is one, is refused by name.

*Unanchored*: `Surv(time, status) ~ arm` on both sets of patients; always `limited`
(`limitedBy: unanchored_comparison`), whatever the balance. *Anchored*: the study has a
common comparator (`arm` 1 = active, 0 = common); the study contrast is the weighted
Cox model on the study's arms, the comparator's contrast is either the reconstructed rows
of both its arms (unweighted Cox) or a published log hazard ratio with its standard error
(`aggregateEstimate`, `aggregateSe`), and the indirect contrast is Bucher's difference on
the log scale; `hazard_ratio_ac_adjusted`, `hazard_ratio_ac_unadjusted` and
`hazard_ratio_bc` are reported with it. Every route reports the crude indirect estimate
beside the adjusted one (`hazard_ratio_unadjusted`, TSD 18's reporting rule).

Two variances, both reported: `hazard_ratio_robust` (the Lin-Wei sandwich, the weights
treated as known, biased low when the effective sample size is small) and `hazard_ratio`
(the headline: the bootstrap, which resamples the study's patients and the comparator's
reconstructed rows within arm and re-estimates the weights on the resampled study
patients every time), each with its standard error (the bootstrap's is a `simulated`
measure with its `mcse`) and `diagnostics.varianceComparison` for their ratio. The
aggregate trial's baseline means are treated as fixed (`targetsTreatedAsFixed`). A target
outside the study's range is `entropy_balance_infeasible`; a weighted effective sample
size below the domain's floor (10) is `effective_sample_size_below_floor`; an arm without
an event is `too_few_events`. The vignette data under `tests/fixtures/maicplus-0.1.2` is
Apache-2.0 (see its `NOTICE`); maicplus is a reference, never a dependency.

### `comparator.aipw` (case N35)

For a single-arm study against an external control (`arm` 1 is the trial, 0 the external
source): the effect in the trial's own population (the ATT), binary or continuous.
The propensity model (membership of the trial, logistic) and the outcome model (fitted on
the **external controls only**, logistic or linear) may use different covariates
(`propensityCovariates`, `outcomeCovariates`, each defaulting to `covariates`; main effects
only, so a nonlinear term is a column of the table). The control mean of the trial's
patients is `[sum over trial of m0(X) + sum over controls of e/(1-e) (Y - m0(X))] / n_trial`
and the effect is the trial's mean minus it: consistent when **either** model is right, which
N35 shows against a truth integrated exactly (either model wrong leaves no bias, both wrong
leaves about two standard deviations). The odds weights are not rescaled (rescaling is a
different, normalised estimator).

Two standard errors, both reported: `aipw_difference_se_influence` (the efficient influence
function of the ATT with the fitted models plugged in; it ignores their estimation, so it is
not the headline) and `aipw_difference_se_bootstrap` (rows resampled within arm, **both models
refitted in every resample**; a `simulated` measure with its `mcse`); `aipw_difference`
carries the bootstrap interval, `aipw_difference_influence` the influence-function one. A
binary outcome also gives `aipw_risk_ratio` and `aipw_odds_ratio` (not written when the
adjusted control risk is not positive, or when it reaches one for the odds ratio; a
control mean outside the unit interval is itself flagged,
`limitedBy: adjusted_control_mean_outside_unit_interval`, because the augmented estimate
is then outside the parameter space), and the
outcome-model-only and weighting-only estimates sit beside the augmented one in
`diagnostics.components`. Overlap is the existing common-support rule and the weighted
effective sample size the existing floor (both `not_estimable`); balance is a notice
(`limitedBy: standardized_difference_above_floor`) because the outcome model carries the
residual imbalance; weight truncation at the controls' 99th percentile is a sensitivity
analysis only. A model that cannot be fitted (collinear covariates, fewer controls than the
outcome model has coefficients, a control with a propensity score of 1) is
`not_estimable` / `nuisance_model_not_estimable`; an outcome model that separates keeps the
estimate and says `outcome_model_separation`.

### `comparator.covariate_sets` (case N36)

`analysis` (`entropy_balance`, `propensity` or `aipw`) is re-run under two to eight named
`covariateSets`, the first being the primary analysis; every other key is the analysis' own,
stated once. **Each set is a full run of the analysis by its own handler** (its weights,
balance, overlap and effective-sample-size rules and whole-pipeline bootstrap), so a set
told something by itself is told the same here (N36 holds the per-set numbers and
intervals identical to the analysis run alone on the same table and seed). The job's seed
is each set's seed, so the sets are compared on the same resamples. Cost is the number of
sets times the bootstrap.

Reported: `covariate_set_estimate_k` for each set that has an estimate (the analysis'
primary measure: `weighted_difference`, `rmst_difference` or `aipw_difference`, with its
interval; `note` is the set's name), `covariate_set_range_low`, `_high` and `_width` over
those, and `covariate_sets_total` / `covariate_sets_estimable`. **A set that breaks a
not-estimable rule is in `diagnostics.sets` and in the `covariate-sets` table with that
rule, never dropped**, a set refused for its input (a column the table does not have) is
there with its code, the conclusion is `limited` and `limitedBy` says
`covariate_set_without_estimate` (and `primary_set_without_estimate` when it is the primary
that has none). When no set has an estimate the job is `not_estimable` with the primary's
rule, or refused by the primary's code. `diagnostics.agreement` says whether the sets agree
in sign and whether every interval excludes the null: a description of how far the
estimate moves with the adjustment set, never a rule for choosing among them. A cancel
returns no measures; a spent CPU budget keeps the sets that finished and says that the rest
were not run.

## 12. Numerical-validation evidence: one reference case per method

The module shows, per method, whether its numerical validation is measured. The
file it reads (`OPEN_SCIENCE_VCR_METHOD_VALIDATION_FILE`) is produced by CI, never
written by hand: the `vcr-engine` job runs every numeric case with
`VCR_NUMERICAL_EVIDENCE_FILE` set (`tests/run_all.R` writes the cases, the methods
each one ran, the lock hash and R's version) and `check-numeric-log.sh` proves the run
was whole; the artifact `vcr-numerical-evidence-<sha>` is turned into the evidence
by `OpenScience/scripts/ops/import-vcr-method-validation.mjs`, which binds it to the
run, the engine's numerical-source digest and the lock.

A method is "measured" only if a case holds it to a reference that is not its own
code. `OpenScience/scripts/ops/vcr-method-references.mjs` names, per case, the
methods it holds and the literal lines of the case that show the comparison (an
anchor that is no longer in the case fails the generator). The deployed file covered
12 of 24 methods because that table named 15 cases and nothing noticed the rest.
Now **the method list is the engine's dispatch** (the methods of
`R/domain-snapshot.json`, which the start-up check holds equal to the handler table),
the generator refuses evidence (`method_reference_missing`, naming the methods) when
a dispatched method has no reference case that ran, and `scripts/vcr/check-method-references.mjs`
says the same in seconds at the top of the CI job. A method added to the engine has
to bring a case.

## 12. The 2026-10-07 extensions

**The profile of a generated population.** `population.scenario`, `population.literature` and
`population.synthpop` return `diagnostics.profile`: one entry per variable of the generated table,
computed from the table alone. `{ variable, label, kind: continuous|binary|categorical, declared,
n, missing, … }` with, for a continuous variable, `mean sd median q1 q3 min max` and a seven-bin
`histogram { breaks, counts }`, and for a binary or categorical one `levels: [{ level, n, p }]`.
`declared` repeats the family, parameters and constraints the scenario or baseline table stated
(`null` for empirical synthesis); a population variable and a baseline row may carry a display
`label`. Numbers are rounded to four significant digits in R. An empirical synthetic table is made
from real people, so it keeps the small-cell rule through the same helper as the real-data profile
(`vcr_suppress_cells`): a level below the floor is `{ level, n: null, p: null, suppressed: true }`,
hidden together with the next-smallest cell, the extremes of a table too small to hide a record and
a histogram bin below the floor are withheld, and the entry's `suppressed` list says what. The
contract is `validatePopulationProfile` in the domain; N45 asks it of what R wrote.

**`patients.longitudinal`** (job kind `generate_patients_longitudinal`, 1.0.0). Scenario: `design`
(`nTreat`, optional `nControl`), `endpoint: continuous`, `visits` (2–50 increasing times),
`truth` (`effect` = delta, required; `intercept`, `slope`, residual `sd`, `randomEffects`
`{ sdIntercept, sdSlope, correlation }`, `covariateEffects` from a stored population) and
`dropoutPerVisit`. The treatment effect changes the slope, so the arms start alike. Person i is one
row of uniforms drawn by row, whatever the scenario says: random effects, a residual and a dropout
draw per visit; so the same seed under two scenarios is the same person twice (common random
numbers), and adding people changes nobody before them. Dropout is MCAR, monotone, never before the
first visit; the values a person would have had after leaving are generated and withheld from the
table. The result carries the long table (`virtual-patients`), the arms' mean trajectories with the
band that holds 95% of the patients, up to twelve individual lines per arm, the model-implied mean and
SD per arm and visit (`expected`), and three example individuals (the 10th, 50th and 90th percentile of
the latent slope) each drawn under both arms.

**Assurance of a group-sequential design** (`design.assurance` 1.1.0, `design.kind:
group_sequential`, time-to-event only). The power of the whole sequential procedure at an effect,
by one pass over the looks of the same Lan-DeMets recursion `design.analytic` uses (rpact agrees
stage by stage to 1e-8), integrated over the design prior by Gauss-Hermite; `byLook` says how much of the
assurance is an early stop. The measure `assurance_simulated` is the same number by simulation (an effect
drawn from the prior, then the trial's B-value path against the boundaries) with its Monte-Carlo
error; `diagnostics.crossCheck` reports the difference in errors. The boundary search uses 1201 grid
nodes (`VCR_ASSURANCE_BOUNDARY_NODES`: the default 4001 takes seconds per look); N47b holds the
boundaries to `design.analytic`'s to 1e-8.

**Single-arm means and survival times** (`design.simulate` / `design.grid` 1.2.0, `design.kind:
single_arm`). The benchmark is fixed, only the trial's n patients are random. A mean: `truth.benchmark`
(default 0), `truth.effect` (true mean minus benchmark, 0 for the null), `truth.sd`; analysis
`one_sample_t`, or `one_sample_z` with the SD it takes as known in `analysis.sd`. A survival time:
`truth.hazardRatio` (the trial's hazard over the benchmark's, 1 for the null) and the benchmark
`truth.controlMedian` or `truth.controlDistribution`, the usual `accrual`; analysis
`one_sample_logrank` (Breslow: `(E - O) / sqrt(E)`, effect `log(O / E)`, Poisson standard error).
`analysis.alternative` describes the parameter: for a survival time `less` is a benefit. Power, type I
error, bias, coverage and the rest carry their Monte-Carlo errors; the analytic check is the exact
non-central t (or the normal closed form for z) and, for the log-rank, a first-order normal
approximation held to a documented tolerance (`VCR_ONE_SAMPLE_LOGRANK_APPROXIMATION_BIAS`). The
external-control and Simon designs stay binary.
