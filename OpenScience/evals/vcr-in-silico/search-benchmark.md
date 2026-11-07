# Design-search benchmark (plan T10, acceptance A19)

What it answers: on the shared host's one-job profile, does a staged campaign (screen cheaply, re-check a few finalists at full
precision on new random streams) find a design that meets fixed requirements, at what cost, against an ordinary grid and an ordinary
random search given the same CPU budget and no model call; and what does one candidate cost in queue, CPU, wall time and memory.

Every arm runs the platform's own decision code (`@evimed/domain` vcrExperimentSearch: manifest validation, seeds, screening, the
Clopper–Pearson and nominal-level verdicts, stop reasons). The only stand-in is the transport: each unit is one
`Rscript service/run_job.R` process, run serially, which is the engine's global concurrency of 1.

## The 30 predeclared candidates

| Family | Method | Candidates | Objective | Constraints |
| --- | --- | --- | --- | --- |
| analytic (cheap) | `design.analytic` 1.4.0, closed form | allocation {0.5, 0.6, 2/3} x accrual duration {12, 15, 18, 21, 24} months: 15 | fewest `required_patients` | `required_events` <= 330 (exact) |
| survival (heavy) | `design.simulate` 1.5.0, two-arm log-rank, HR 0.70, control median 12, follow-up 12 | patients per arm {100, 125, 150, 175, 200} x accrual duration {12, 18, 24}: 15 | fewest `expected_sample_size` | power >= 0.80 (one-sided 97.5% Clopper–Pearson lower bound); type I error <= 0.025 under HR 1 (the log-rank test's nominal level, contradicted only if the simulated lower bound exceeds it) |

Frozen before any run: the truths (HR 0.70 and 1), alpha 0.025 one-sided, the analysis, the stage sizes, the budgets, the order of the
random arm (a fixed permutation, seed 20261107), the reference design (150 per arm, 18 months of accrual). Final runs are at the
domain floors: 5,000 replicates under the alternative, 20,000 under the null.

## Arms (survival family)

| Arm | What it does | Budget |
| --- | --- | --- |
| reference | the fixed expert design, both truths at full precision | none |
| staged | all 15 screened at 300 replicates (alternative only), 3 finalists re-run at the floors on new streams | none (its use sets the matched budget) |
| grid | full precision in space order (smallest first) until the budget is spent | the staged arm's CPU seconds |
| random | full precision in the fixed random order until the budget is spent | the staged arm's CPU seconds |
| exhaustive | every candidate at full precision: the answer the others are scored against (an estimate, not an oracle) | none |
| agent | the live model proposing candidates through `virtual_trial_search`, run later by the controller | the staged arm's CPU seconds and a stated model-call budget |

The agent arm is not run here (no paid model call in this stream). Its slot: start a campaign from a hosted conversation with the same
family, truths, constraints and budget (`budget.cpuSeconds` = the matched budget below, `budget.modelCalls` stated), export the
campaign view (`GET /api/vcr/studies/<study>/experiments/<campaign>`) to a file, and score it against the exhaustive arm:

```
node OpenScience/evals/vcr-in-silico/search-benchmark.mjs --score <campaign-view.json> --reference OpenScience/evals/vcr-in-silico/results/search-benchmark-20261107.json
```

## How to run

```
source /home/coder/evimed-wt/vcrfix-handoff/isl/env.sh   # VCR_R_LIBS, VCR_ENGINE_ROOT, VCR_TEST_CORES=2, TMPDIR
cd OpenScience
setsid nohup node evals/vcr-in-silico/search-benchmark.mjs --exhaustive --cache $TMPDIR/bench-cache.jsonl \
  --out evals/vcr-in-silico/results/search-benchmark-20261107.json </dev/null > $TMPDIR/bench.out 2> $TMPDIR/bench.log &
```

Resumable: a finished unit is cached by its deterministic idempotency key and CPU ceiling, so the same command after an interruption
reuses it with its recorded numbers and cost. The JSON holds, per arm, the stop reason, the chosen design with its final numbers and
verdicts, every candidate's status, and every unit's engine CPU, wall time, peak memory and the queue it would have waited in had all
the arm's units been submitted together to the one-job queue.

## Results

Units ran 2026-11-07 15:58–16:49 UTC on the shared development box (load average about 10 on 4 cores during the run, so wall times are inflated; engine CPU seconds are the comparable figure); the JSON was regenerated from the unit cache at revision `81379e80d` with every unit reused. Engine design.simulate 1.5.0 / design.analytic 1.4.0, 2 cores per unit, concurrency 1.

### Analytic family

Stop: `acceptable_precision`; best allocation 0.5, duration 24 (386 patients, 247 events); 15 of 15 feasible; 15 units, 23.8 engine CPU-s, 45.4 s wall (R start included), peak 132 MB.

### Survival family

Matched budget (the staged arm's engine CPU): 287.9 CPU-s.

| Arm | Stop | Chosen design | Its size | Power (final) | Candidates evaluated | Units | Engine CPU-s | Wall s | Queue if submitted together, max s | Peak MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reference | `no_feasible_beneficial_candidate` | — | — | — | 1 | 2 | 94.1 | 116.6 | 19.8 | 145 |
| staged | `acceptable_precision` | nTreat 200, nControl 200, duration 24 | 400 | 83.8% ± 0.52 | 15 | 21 | 287.9 | 283.4 | 248.5 | 168 |
| grid | `budget_exhausted` | — | — | — | 6 | 12 | 288.0 | 167.7 | 156.7 | 173 |
| random | `budget_exhausted` | nTreat 200, nControl 200, duration 24 | 400 | 82.6% ± 0.54 | 5 | 10 | 288.7 | 165.7 | 158.8 | 168 |
| exhaustive | `acceptable_precision` | nTreat 200, nControl 200, duration 24 | 400 | 83.8% ± 0.52 | 15 | 30 | 944.4 | 583.5 | 505.2 | 169 |

| Arm | Found the exhaustive best | Size above it | Feasible design found |
| --- | --- | --- | --- |
| reference | false | — | false |
| staged | true | 0 | true |
| grid | false | — | false |
| random | true | 0 | true |

Exhaustive arm, every candidate at full precision (power under HR 0.70 at 5,000 replicates, type I error under HR 1 at 20,000):

| Candidate | Status | Power | Type I error | Power verdict | Alpha verdict |
| --- | --- | --- | --- | --- | --- |
| nTreat 100, nControl 100, duration 12 | evaluated | 47.2% ± 0.71 | 2.46% ± 0.11 | fail | pass |
| nTreat 100, nControl 100, duration 18 | evaluated | 51.2% ± 0.71 | 2.63% ± 0.11 | fail | pass |
| nTreat 100, nControl 100, duration 24 | evaluated | 53.7% ± 0.71 | 2.44% ± 0.11 | fail | pass |
| nTreat 125, nControl 125, duration 12 | evaluated | 55.1% ± 0.70 | 2.51% ± 0.11 | fail | pass |
| nTreat 125, nControl 125, duration 18 | evaluated | 59.7% ± 0.69 | 2.51% ± 0.11 | fail | pass |
| nTreat 125, nControl 125, duration 24 | evaluated | 63.8% ± 0.68 | 2.67% ± 0.11 | fail | pass |
| nTreat 150, nControl 150, duration 12 | evaluated | 65.2% ± 0.67 | 2.60% ± 0.11 | fail | pass |
| nTreat 150, nControl 150, duration 18 | evaluated | 67.8% ± 0.66 | 2.42% ± 0.11 | fail | pass |
| nTreat 150, nControl 150, duration 24 | evaluated | 71.5% ± 0.64 | 2.56% ± 0.11 | fail | pass |
| nTreat 175, nControl 175, duration 12 | evaluated | 71.9% ± 0.64 | 2.40% ± 0.11 | fail | pass |
| nTreat 175, nControl 175, duration 18 | evaluated | 74.6% ± 0.62 | 2.54% ± 0.11 | fail | pass |
| nTreat 175, nControl 175, duration 24 | evaluated | 78.4% ± 0.58 | 2.54% ± 0.11 | fail | pass |
| nTreat 200, nControl 200, duration 12 | evaluated | 77.3% ± 0.59 | 2.60% ± 0.11 | fail | pass |
| nTreat 200, nControl 200, duration 18 | evaluated | 80.4% ± 0.56 | 2.57% ± 0.11 | inconclusive | pass |
| nTreat 200, nControl 200, duration 24 | evaluated | 83.8% ± 0.52 | 2.49% ± 0.11 | pass | pass |

### One-job profile per unit (staged arm)

| Unit | Count | Mean engine CPU-s | Mean wall s | Max peak MB |
| --- | --- | --- | --- | --- |
| screening (300 replicates) | 15 | 3.5 | 7.1 | 132 |
| final, alternative (5,000) | 3 | 17.1 | 16.2 | 136 |
| final, null (20,000) | 3 | 61.2 | 42.5 | 168 |

### What this shows, and what it does not

- **The staged campaign found the design the exhaustive full-precision grid ranks best** (200 per arm, 24 months of accrual, 400 patients,
  power 83.8% ± 0.52 on its final run) for 288 engine CPU-s, 30% of the exhaustive grid's 944. Its 300-replicate screen set aside the
  10 designs of 100 to 150 per arm and 175 per arm with 12 months, whose most favourable bound already fell short of 80% (their full-precision
  powers are 47–72%); of the five left it re-checked three on new streams (175/18, 200/18, 200/24). The screen preferred 175/18 (final power
  74.6%) to 175/24 (78.4%) by chance: a screening number ranks and is never a result, which is why the final runs decide.
- **At the same CPU budget an ordinary grid found no feasible design**: in space order it spent the budget on 100- and 125-per-arm
  designs, each needing a 20,000-replicate null run. **The one fixed random order happened to reach the best design** within its budget.
  One random order is one draw: this run does not say how often random search succeeds at this budget, and it is no evidence that the
  staged campaign beats random search in general. A comparison of decision quality needs repeated random orders (and repeated seeds).
- **The expert reference design (150 per arm, 18 months) does not meet the power requirement** (67.8% ± 0.66).
- **200 per arm with 18 months of accrual is "inconclusive", not met**: 80.4% ± 0.56 has a one-sided lower bound below 80%.
- **Every type I error "pass" rests on the log-rank test's nominal level** (`analyticSupport`): the simulated rates are 2.40–2.67% at
  20,000 replicates and none has a lower bound above 2.5%, so the simulation does not contradict the nominal level; held to the
  simulation's own upper bound instead, every one of the 15 designs would be inconclusive. The basis is stated in the result.
- **Cost per unit on this host** (staged arm): a 300-replicate screen 3.5 CPU-s, a 5,000-replicate alternative 17 CPU-s, a
  20,000-replicate null 61 CPU-s, peak memory 170 MB; an R process start is part of every wall time. The null runs at the floor are
  two thirds of every arm's cost: screening saves by not running them for candidates that never reach the final stage.
- **Queue**: the campaign holds one unit in flight, so its units wait for nothing of their own; had the staged arm's 21 units been
  submitted together to the one-job queue, the last would have waited 249 s. Other studies' jobs share that queue.

### Capacity decision

Keep the engine's global concurrency at 1 on the shared host: one unit of the heavy family already uses both of a job's cores, and
this box (6 GB, four cores, other sessions running) is no place to measure two concurrent jobs without the measurement being the
other sessions' load. A 1-versus-2-job comparison (p95 queue and interactive latency, core oversubscription, peak memory, throughput,
seed reproducibility) is to be run on an isolated worker before any change; it was not run here.

### Agent arm

Not run in this stream (no model calls). The controller runs it with the live model at the matched budget above and scores the
exported campaign view with `--score` against `results/search-benchmark-20261107.json`.
