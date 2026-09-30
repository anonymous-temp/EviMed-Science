# vcr-engine

The deterministic statistics and simulation engine behind 「虚拟临研」 (EviMed
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
| Every simulated number carries its Monte-Carlo standard error | `vcr_measure(simulated = TRUE)` refuses to construct without one | N03, N04, AC-28 |
| Replicate counts follow from the target precision | `vcr_replicates_for_mcse` + the domain's floors (20,000 null / 5,000 alternative); a run held below its floor by `VCR_ENGINE_MAX_REPLICATES` is `limited` | N05, E10b |
| Analytic first, simulation as the check | every simulated design carries `diagnostics.analyticCheck` with the difference in MCSE units | E07, N02, N04c |
| "Not estimable" is a deterministic verdict, never a fabricated 0 | seven named rules in `notEstimableRules`; `measures` stays empty | N09, N11, N17 |
| The four counts stay apart | `vcr_counts()` + `vcr_validate_counts()`; `NULL` is the only stand-in for unknown; only `observed` rows are real patients | E04, C2-05, N17, E09 |
| Reconstructed pseudo-patients are never real patients | `counts.reconstructedPseudoPatients`, source `reconstructed` | N16, N17 |
| A rule is data, never code | no `eval`/`parse` anywhere in `R/` or `service/`; an `expression` key anywhere in a scenario is refused by name | N23 |
| The engine reads only what the job names, hash-verified, under the data root | `R/inputs.R` (section 3) | E06, N24, N25 |
| A job never raises | every malformation ends as a named refusal in a protocol-valid result | E10a |

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
| `VCR_ENGINE_TOKEN_FILE`, `VCR_ENGINE_RECEIPT_KEY_FILE` | service | secrets, as files (>= 32 bytes, no symlink); `VCR_ENGINE_INSECURE_DEV=1` lets either be missing |
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
checked is the file that was read.

`valueSource` is honoured, not assumed: weighting, propensity, RMST, MAIC and
synthetic-data generation need `observed` rows (`input_source_not_individual`
otherwise), and `counts.realPatients` counts only observed rows.

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
GET    /jobs/{id}/result   -> the full result, with manifest.signature added (409 until it exists)
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

24 methods, all at `1.0.0`, one job kind each, keyed exactly as the domain's
`VCR_ENGINE_METHODS`. The engine refuses to start if the lists differ
(`vcr_engine_self_check`, N00b). `R/domain-snapshot.json` is generated from
the live domain by `tests/helpers/emit-domain-snapshot.mjs` (never edit by
hand); N00a regenerates it and fails on drift. The engine reads the domain's
own scenario schemas, patient-level kinds, design support table and limits from
that snapshot and validates every job against them before a handler runs.

| Method | Does | Cross-checked against |
|---|---|---|
| `profile.snapshot` | column summaries, cells below the minimum cell size suppressed | — |
| `cohort.build` | named row rules (`rule` grammar, §2 of the contract): kept / excluded / indeterminate per rule, criterion impact, time zero, exit, member table, the rules' hash | a truth table (C2-01..07) |
| `population.scenario` | declared marginals + Gaussian copula + row-rule constraints (violating rows are redrawn) + missingness, `paramSd` for parameter uncertainty | closed-form moments |
| `population.literature` | a published baseline table (mean/sd with optional bounds, proportion, categorical proportions, lognormal) as a population; an assumed correlation comes with its sensitivity | moment recovery (N28a) |
| `population.synthpop` | sequential CART, `m` in 5–50 copies, rare levels merged, holdout (the copies are not pooled into an estimate: no combining rule ships until a job needs one) | synthpop |
| `population.quality` | the fixed fidelity / utility / disclosure suite; the disclosure axis is size-matched | a memorizer, a shuffle (C2-15..18) |
| `patients.continuous` `.binary` `.time_to_event` | the reference simulators; for a stored population, arms by a fixed uniform and `truth.covariateEffects` (centred at the population mean) | regression on the output (N28c), common random numbers (E10c) |
| `evidence.pool` | DL / REML / HKSJ + prediction interval; k = 1 is `single_study` | metafor |
| `evidence.reconstruct_km` | Guyot reconstruction + quality control | round trip (N16) |
| `comparator.entropy_balance` | ATT weights, balance, ESS, whole-pipeline stratified bootstrap; dispatches on the endpoint (weighted mean, binary, or weighted KM + RMST(τ)) | WeightIt, cobalt |
| `comparator.propensity_weight` | logistic PS weights (overlap diagnostics) | WeightIt |
| `comparator.rmst` | weighted KM, RMST(τ), the τ rule | survRM2 |
| `comparator.maic` | anchored / unanchored MAIC, whole-pipeline bootstrap variance | independent BFGS on TSD 18's objective |
| `comparator.evalue` | E-values on every scale | EValue |
| `comparator.map_prior` | MAP by quadrature, robustify, prior ESS (ELIR), conflict against the MAP alone, hybrid operating characteristics | RBesT, an independent joint grid |
| `design.analytic` | Schoenfeld, Lan-DeMets boundaries (`sided` honoured), n, Simon two-stage over the whole grid | rpact, gsDesign, published Simon designs |
| `design.simulate` | the ADEMP runner: calendar-time group sequential, dropout, `sided`, costs | `design.analytic`, an independent `survdiff` simulation (N04c) |
| `design.grid` | designs × truths, one immutable run per cell, a long-format table | — |
| `design.assurance` | power averaged over a design prior (normal on effect, on log HR, on the risk difference) | numerical integration, a Monte-Carlo z-test |
| `design.procova` | prognostic-adjustment sample size, three paths | the closed form, EMA 2022 |
| `accrual.poisson_gamma` | per-site Poisson-Gamma accrual, staggered starts, screen failure, event target | closed form vs simulation, metafor-style REML for the pool (N27) |
| `matching.evaluate` | Kleene three-valued eligibility; a criterion that does not apply cannot exclude | the truth table (N29) |

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
checklist that keeps it so: 40 entries (method, path, key, expected schema
node), each looked up in the domain's schemas by case N26, which fails naming any
that is missing or unreachable (and asserts it looked up all of them). A missing
entry is also overlaid in memory so the rest of the suite still runs against the
intended contract.

`cohort.build`: `timeZero.column`, `exit.column`, `idColumn` · `population.scenario`:
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
R/evidence_pool.R    DL / REML / HKSJ pooling and prediction intervals
R/map_prior.R        MAP by quadrature, robustify, prior ESS, conflict, hybrid operating characteristics
R/design_analytic.R  Lan-DeMets boundaries, Schoenfeld, asymptotic log-rank power, Simon
R/design_simulate.R  the ADEMP runner: batches, checkpoints, cancel, budget, MCSE; the design grid
R/assurance.R        power averaged over a design prior
R/procova.R          prognostic-adjustment sample size
R/accrual.R          Poisson-Gamma accrual, event target, online update, back-test
R/engine.R           job dispatch, the 24 handlers, the manifest, the self-check, the engine's own issue codes
R/domain-snapshot.json   generated from @evimed/domain (never edit by hand)
R/package-lock.json      the runtime library the Dockerfile verifies (62 packages)
service/app.py           FastAPI: queue of one, process group, rlimits, cancel, receipt signature
service/run_job.R        one job, one process (A1's)
service/parquet_bridge.py  Parquet -> CSV, converts only
tests/numeric/           the numeric acceptance cases (one file per family)
tests/helpers/           harness, canonical fixtures, the schema-additions overlay
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
survival, literature, borrowing, PROCOVA), `N23-N29` (rules, data plane, schema
agreement, accrual and pooling, populations and patients, matching), `C2-01-C2-18`
(cohort, models, quality), `E01-E10` (the engine itself: accrual, cancel and
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
