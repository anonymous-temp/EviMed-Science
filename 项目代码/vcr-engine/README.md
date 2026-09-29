# vcr-engine

The deterministic statistics and simulation engine behind 「虚拟临研」 (EviMed
Virtual Clinical Research). **Every number the module shows is computed here.**

It is an independent container driven by the control plane's job queue, in the
same shape as the meta and MR engines: a frozen scenario goes in, a result and
a manifest come out. It holds no model client, mounts no data volume, and
opens exactly the files a job names. A language model never enters this path.

- Plan: `docs/superpowers/specs/2026-09-28-EviMed虚拟临研平台方案.md` (§5, §6.2, §7.2, §8.2, §11.4, §12.4)
- Contract: `docs/superpowers/specs/2026-09-28-vcr-build-contract.md` (§3.3, §4)
- Protocol authority: `OpenScience/packages/domain/src/vcrEngineJob.mjs`

---

## 1. What it guarantees

| Guarantee | How | Case |
|---|---|---|
| Same seed, any core count, bit-identical | one L'Ecuyer-CMRG substream per replicate; reduction in replicate order | N06, E03 |
| Interruptible and resumable | a checkpoint per batch, carrying the scenario hash and the next stream state | N06, E03 |
| Cancel is immediate and keeps finished batches | a cancel file checked between batches; the partial result is returned with `status: "canceled"` | E03 |
| Every simulated number carries its Monte-Carlo standard error | `vcr_measure(simulated = TRUE)` refuses to construct without one | N03, N04, AC-28 |
| Replicate counts follow from the target precision | `vcr_replicates_for_mcse` + the plan's floors (20,000 null / 5,000 alternative) | N05 |
| Analytic first, simulation as the check | every simulated design carries `diagnostics.analyticCheck` with the difference in MCSE units | E07, N02 |
| "Not estimable" is a deterministic verdict, never a fabricated 0 | seven named rules in `VCR_NOT_ESTIMABLE_RULES`; `measures` stays empty | N09, N11, N17 |
| The four counts stay apart | `vcr_counts()` + `vcr_validate_counts()`; `NULL` is the only stand-in for unknown | E04, C2-05, N17 |
| Reconstructed pseudo-patients are never real patients | `counts.reconstructedPseudoPatients`, source `reconstructed` | N16, N17 |
| The engine reads only the files the job names, hash-verified | `vcr_read_input` | E06 |

## 2. Running it

R 4.3.3 with the library in `R/package-lock.json`. On this development box:

```bash
export VCR_R_LIBS=/home/coder/R/vcr-4.3
export VCR_ENGINE_ROOT="$PWD"

# every numeric acceptance case, one line each, `PASSED x/y` last
tests/run_all.sh
VCR_TEST_ONLY='N0[1-6]' tests/run_all.sh     # a subset, by id regex
VCR_TEST_CORES=1 tests/run_all.sh            # the reproducibility cases cover 1, 4 and 8

# one job from a file
Rscript service/run_job.R job.json /tmp/out   # writes /tmp/out/result.json

# the HTTP service (needs requirements.txt installed)
VCR_ENGINE_TOKEN=... python3 -m uvicorn service.app:app --port 8080 --workers 1
```

`VCR_ENGINE_CORES` caps parallelism; `VCR_ENGINE_CPU_SECONDS` and each job's
own `cpuSecondsLimit` cap CPU; `VCR_ENGINE_WORK_DIR` is where job directories
live. Global concurrency is 1 by design (plan §11.4: the production host is a
shared four-core box).

## 3. HTTP interface

```
POST /jobs                 body = a full job (§4)   -> 202 {jobId, accepted}
GET  /jobs/{id}            -> {jobId, state, progress:{done,total}, cpuSeconds, cpuSecondsLimit}
POST /jobs/{id}/cancel     -> {canceled}
GET  /jobs/{id}/result     -> the full result (409 until it exists)
DELETE /jobs/{id}          -> discard a finished job's directory
GET  /health               -> {ok, engineVersion, rVersion, protocolVersion, methods, packageLockHash, rngKind, issues}
```

`Authorization: Bearer <VCR_ENGINE_TOKEN>` when the variable is set. States are
`queued | running | canceling | succeeded | failed | canceled | not_estimable`.

## 4. Methods

24 methods, all at `1.0.0`, keyed exactly as `VCR_ENGINE_METHODS` in
`@evimed/domain`. The engine refuses to start if the two lists differ
(`vcr_engine_self_check`, case N00b). `R/domain-snapshot.json` is generated
from the live domain by `tests/helpers/emit-domain-snapshot.mjs`; case N00a
regenerates it and fails on any drift.

| Method | Does | Cross-checked against |
|---|---|---|
| `profile.snapshot` | column summaries, cells below `VCR_MIN_CELL_SIZE` suppressed | — |
| `cohort.build` | named inclusion rules, kept / excluded / indeterminate | — |
| `population.scenario` | declared marginals + Gaussian copula + constraints + missingness | simstudy semantics |
| `population.literature` | a published baseline table as a population | — |
| `population.synthpop` | sequential CART synthesis with a holdout | synthpop |
| `population.quality` | the fixed fidelity / utility / disclosure suite | synthpop, SDMetrics shapes |
| `patients.continuous` `.binary` `.time_to_event` | the three reference simulators | simsurv, `survival` |
| `evidence.pool` | DL / REML / HKSJ + prediction interval | metafor |
| `evidence.reconstruct_km` | Guyot reconstruction + quality control | round-trip (N16) |
| `comparator.entropy_balance` | ATT weights, balance, ESS, bootstrap | WeightIt, cobalt |
| `comparator.propensity_weight` | logistic PS weights (overlap diagnostics) | WeightIt |
| `comparator.rmst` | weighted KM, RMST(τ), the τ rule | survRM2 |
| `comparator.maic` | anchored / unanchored MAIC, STC | independent BFGS on TSD 18's objective |
| `comparator.evalue` | E-values | EValue |
| `comparator.map_prior` | MAP by quadrature, robustify, prior ESS, conflict | RBesT |
| `design.analytic` | Schoenfeld, Lan-DeMets boundaries, n, Simon two-stage | rpact, gsDesign |
| `design.simulate` | the ADEMP runner | `design.analytic` |
| `design.grid` | designs × truths, one immutable run per cell | — |
| `design.assurance` | power averaged over a design prior | closed form vs quadrature |
| `design.procova` | prognostic-adjustment sample size, three paths | EMA 2022 qualification opinion |
| `accrual.poisson_gamma` | Poisson-Gamma accrual, closed form and simulated | closed form vs simulation (E01) |
| `matching.evaluate` | Kleene three-valued eligibility | Kleene truth table |

`VCR_JOB_METHODS` maps 16 job kinds onto these 24 methods, so eight methods
have no kind of their own and ride a neighbouring one (see §8).

## 5. Result shapes other packages read

### `evidence.pool` → `vcrEvidence.mjs`'s `readPoolResult`

```jsonc
"measures": [
  { "name": "pooled",      "value": -0.8928, "interval": { "kind": "confidence", "low": …, "high": … } },
  { "name": "prediction",  "value": -0.8928, "interval": { "kind": "prediction", "low": …, "high": … } },
  { "name": "i_squared",   "value": 0.0 },
  { "name": "tau_squared", "value": 0.0 },
  { "name": "tau",         "value": 0.0 },
  { "name": "k",           "value": 5 }
],
"diagnostics": {
  "scale": "logit" | "log" | "identity",
  "poolingMethod": "random_effects_dl" | "random_effects_reml" | "random_effects_hksj" | "fixed_effect" | "single_study",
  "distribution": { "kind": "beta", "alpha": …, "beta": …, "basis": "prediction" },
  "predictionIntervalAvailable": true, "predictionIntervalReason": null,
  "heterogeneity": { "Q": …, "df": …, "pQ": …, "h2": … }, "weights": [ … ]
}
```

`diagnostics.distribution` is the pooled result reparameterized so a simulation
can draw from it directly: **proportions** are pooled on the logit and returned
as a `beta`; **times** and **ratios** are pooled on the log and returned as a
`lognormal`; everything else is `normal`. `basis` says whether the spread is
the prediction distribution (what a new trial is a draw from) or only the
confidence distribution.

**When `k < 3` the `prediction` measure is absent**, and `diagnostics`
says why. That is deliberate: the Higgins-Thompson-Spiegelhalter prediction
interval is `t` on `k − 2` degrees of freedom and does not exist for two
studies. The confidence interval is never substituted for it — seeding a
design prior with a confidence interval understates a future trial's spread by
`sqrt(1 + var(μ)/τ²)`, invisibly.

### Other results

Every result validates against `validateEngineResult` before it is returned
(the engine runs the domain's own rules on its own output). `counts` always
carries the four keys; optional keys appear only when their route was used.
`diagnostics.analyticCheck` appears on every simulated design.

## 6. Layout

```
R/protocol.R         job & result validation, canonical JSON, replicate arithmetic, sha256
R/rng.R              L'Ecuyer-CMRG substreams, ordered parallel map
R/simulators.R       the three reference simulators and their analyses
R/population.R       scenario / literature / synthpop populations, mechanistic interface, vpop selection
R/quality.R          synthetic-data report suite, model cards, calibration, temporal leakage
R/weighting.R        entropy balancing, propensity weights, SMD, ESS, bootstrap, not-estimable rules
R/rmst.R             weighted KM, RMST, the τ rule
R/reconstruct.R      Guyot reconstruction and its quality control
R/maic.R             MAIC (anchored / unanchored) and STC
R/evidence_pool.R    DL / REML / HKSJ pooling and prediction intervals
R/map_prior.R        MAP by quadrature, robustify, prior ESS, conflict
R/design_analytic.R  Lan-DeMets boundaries, Schoenfeld, exact log-rank power, Simon
R/design_simulate.R  the ADEMP runner: batches, checkpoints, cancel, MCSE
R/assurance.R        power averaged over a design prior
R/procova.R          prognostic-adjustment sample size
R/accrual.R          Poisson-Gamma accrual, online update, back-test
R/engine.R           job dispatch, the 24 handlers, the manifest, the self-check
R/domain-snapshot.json   generated from @evimed/domain (never edit by hand)
R/package-lock.json      the pinned library the Dockerfile verifies
service/app.py           FastAPI: queue of one, CPU rlimit, cancel
service/run_job.R        one job, one process
service/parquet_bridge.py  Parquet → CSV, converts only
tests/numeric/           N00–N22, C2-01–C2-14, E01–E08
tests/run_all.sh         one command, one line per case
```

## 7. Numeric acceptance

`tests/run_all.sh` prints one line per case:

```
N01    PASS AC-30,AC-04 | 3.7103/2.5114/1.9930 …  [6.5s]
…
PASSED 44/44
```

Ids are C1's `N01`–`N22`, C2's `C2-01`–`C2-14`, plus `N00a`–`N00e` (the
protocol mirror) and `E01`–`E08` (cases this engine adds: accrual, cancel and
budget, count separation, input discipline, analytic/simulated agreement across
all three endpoint families, group-sequential operating characteristics). Each
line carries the `AC-…` scenarios it covers so the acceptance table can be
built by grepping the output.

## 8. Things a caller should know

1. **`VCR_JOB_METHODS` covers 16 of the 24 methods.** `population.literature`,
   `population.quality`, `patients.continuous`, `patients.binary`,
   `comparator.propensity_weight`, `comparator.maic`, `comparator.evalue` and
   `design.procova` have no job kind of their own. `validateEngineJob` checks
   `kind` and `method` independently, so any non-patient-level kind works — but
   the pairing rule belongs in the domain rather than in each caller's head.
2. **Six job kinds are patient-level** (`VCR_PATIENT_LEVEL_JOB_KINDS`) and are
   refused without a `snapshot` input, including `match_criteria`.
3. **Scenario hashing is over canonical JSON.** R reproduces ECMAScript's
   `JSON.stringify` exactly, including shortest-round-trip number formatting
   and `null` for non-finite numbers — so `followup: Infinity` is hashable and
   means the same thing on both sides (case N00c).
4. **A `canceled` result still carries measures** computed from the batches
   that finished, and its `diagnostics.replicatesCompleted` says how many.
5. **A quality band is a notice.** The only invariant in the synthetic-data
   suite is that declared hard constraints are violated zero times; every
   colour threshold except `S_pMSE`'s is this product's default, marked
   `product_default` in `bandSources`, to be revisited against about twenty
   real datasets.
6. **The disclosure axis refuses to compute without a holdout** rather than
   reporting absolute distances that read like a verdict. It reports what was
   measured; it never concludes that anything is anonymous.
