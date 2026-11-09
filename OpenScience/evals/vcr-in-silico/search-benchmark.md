# Design-search benchmark (plan T10, acceptance A19)

What it answers: on the shared host's one-job profile, does a staged campaign (screen cheaply, re-check a few finalists at full
precision on new random streams) find a design that meets fixed requirements, at what cost, against an ordinary grid and an ordinary
random search given the same CPU budget and no model call; and what does one candidate cost in queue, CPU, wall time and memory.

Every arm runs the platform's own decision code (`@evimed/domain` vcrExperimentSearch: manifest validation, seeds, screening, the
Clopper–Pearson and nominal-level verdicts, stop reasons). The only stand-in is the transport: each unit is one
`Rscript service/run_job.R` process, run serially, which is the engine's global concurrency of 1.

## The 42 predeclared candidates

| Family | Method | Candidates | Objective | Constraints |
| --- | --- | --- | --- | --- |
| analytic (cheap) | `design.analytic` 1.4.0, closed form | allocation {0.5, 0.6, 2/3} x accrual duration {12, 15, 18, 21, 24} months: 15 | fewest `required_patients` | `required_events` <= 330 (exact) |
| survival (heavy) | `design.simulate` 1.5.0, two-arm log-rank, HR 0.70, control median 12, follow-up 12 | patients per arm {100, 125, 150, 175, 200} x accrual duration {12, 18, 24}: 15 | fewest `expected_sample_size` | power >= 0.80 (one-sided 97.5% Clopper–Pearson lower bound); type I error <= 0.025 under HR 1, held to the simulation's 97.5% Clopper–Pearson upper bound (the log-rank test is asymptotic: a rate at its nominal level is "inconclusive", never a pass) |
| level (heavy; added with the undecided-verdict work) | `design.simulate` 1.5.0, the same log-rank design at 24 months of accrual | patients per arm {200, 225, 250} x analysis level `analysis.alpha` {2.5%, 2.35%, 2.2%, 2.0%}: 12 | fewest `expected_sample_size` | power >= 0.80; type I error <= 0.025, **the constraint unchanged** while the analysis level varies at or below it |

Frozen before any run: the truths (HR 0.70 and 1), the constraint (2.5% one-sided), the analysis, the stage sizes, the budgets, the order of the
random arm (a fixed permutation, seed 20261107), the reference design (150 per arm, 18 months of accrual), the level family's grid. Final runs
are at the domain floors: 5,000 replicates under the alternative, 20,000 under the null.

## Arms

| Arm | What it does | Budget |
| --- | --- | --- |
| reference | the fixed expert design, both truths at full precision | none |
| staged | all 15 screened at 300 replicates (alternative only), 3 finalists re-run at the floors on new streams | none (its use sets the matched budget) |
| grid | full precision in space order (smallest first) until the budget is spent | the staged arm's CPU seconds |
| random | full precision in the fixed random order until the budget is spent | the staged arm's CPU seconds |
| exhaustive | every candidate at full precision: the answer the others are scored against (an estimate, not an oracle) | none |
| level-fixed | level family restricted to the 2.5% level (3 designs): the control that may not lower the level; 300-replicate screen, 3 finalists | none |
| level-searched | the whole level family, 300-replicate screen, 4 finalists | none |
| level-exhaustive | all 12 level-family designs at full precision | none |
| agent | the live model proposing candidates through `virtual_trial_search`, run later by the controller | the staged arm's CPU seconds and a stated model-call budget |

The agent arm is not run here (no paid model call in this stream). Its slot: start a campaign from a hosted conversation with the same
family, truths, constraints and budget (`budget.cpuSeconds` = the matched budget below, `budget.modelCalls` stated), export the
campaign view (`GET /api/vcr/studies/<study>/experiments/<campaign>`) to a file, and score it against the exhaustive arm:

```
node OpenScience/evals/vcr-in-silico/search-benchmark.mjs --score <campaign-view.json> --reference OpenScience/evals/vcr-in-silico/results/search-benchmark-20261107.json
```

## How to run

```
export VCR_R_LIBS=<the engine's R library>  VCR_ENGINE_ROOT=<repo>/项目代码/vcr-engine  VCR_TEST_CORES=2  TMPDIR=<scratch>
cd OpenScience
setsid nohup node evals/vcr-in-silico/search-benchmark.mjs --exhaustive --cache $TMPDIR/bench-cache.jsonl \
  --out evals/vcr-in-silico/results/search-benchmark-20261107.json </dev/null > $TMPDIR/bench.out 2> $TMPDIR/bench.log &
```

Resumable: a finished unit is cached by its deterministic idempotency key and CPU ceiling, so the same command after an interruption
reuses it with its recorded numbers and cost (a unit that did not succeed is never cached). `--families analytic,survival,level` narrows the
run. The JSON holds, per arm, the stop reason, the chosen design (or, when nothing passed every constraint, the closest undecided design with
each undecided constraint's simulated value, error and the replicates that would decide it), every candidate's status and verdicts, and every
unit's engine CPU, wall time, peak memory and the queue it would have waited in had all the arm's units been submitted together to the
one-job queue.

## Results

Re-run 2026-11-07 18:31–19:00 UTC on the shared development box (other work was running, so wall times are inflated; engine CPU seconds are the
comparable figure), from an empty cache at revision `7e2f3a4d2`, under the rule of 951926fef (an asymptotically calibrated test is held to the
simulation's bound) and the undecided read of this round. The earlier JSON of this file predated that rule and is replaced: its type I error
"passes" rested on the log-rank test's nominal level, which the platform no longer accepts. Engine design.simulate 1.5.0 / design.analytic 1.4.0,
2 cores per unit, concurrency 1.

### Analytic family

Stop: `acceptable_precision`; best allocation 0.5, duration 24 (386 patients, 247 events); 15 of 15 feasible (exact values, no simulation); 15
units, 13.1 engine CPU-s, 21.3 s wall (R start included), peak 133 MB.

### Survival family

Matched budget (the staged arm's engine CPU): 241.0 CPU-s.

| Arm | Stop | Chosen design | Its size | Power (final) | Candidates evaluated | Units | Engine CPU-s | Wall s | Queue if submitted together, max s | Peak MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reference | `no_feasible_beneficial_candidate` | — | — | — | 1 | 2 | 61.7 | 37.6 | 10.9 | 168 |
| staged | `inconclusive_at_precision` | — | — | — | 15 | 21 | 241.0 | 159.2 | 128.7 | 168 |
| grid | `budget_exhausted` | — | — | — | 6 | 11 | 242.5 | 139.0 | 136.0 | 171 |
| random | `budget_exhausted` | — | — | — | 5 | 9 | 242.5 | 136.4 | 134.3 | 168 |
| exhaustive | `inconclusive_at_precision` | — | — | — | 15 | 30 | 884.1 | 496.2 | 467.7 | 171 |

**No arm found a design that met every constraint.** The log-rank test's type I error is simulated at 2.30–2.72% across the arms' final runs (20,000 replicates each); its
97.5% upper bound is above 2.5% for every design, so every design that met the power requirement stays "inconclusive" on type I error, and the
campaigns that finished their finalists stop `inconclusive_at_precision`: nothing failed, nothing could be shown to pass. The grid and random
arms stop `budget_exhausted` first (their last unit is cut by the CPU ceiling; the cut units are not counted as results).

What a stopped campaign now says (staged arm, closest design no constraint failed): 200 per arm with 18 months of accrual, 400 patients, power
80.24% ± 0.56 (inconclusive, about 105,000 replicates would decide it by the normal approximation) and type I error 2.48% ± 0.11 on a bound of
2.5% (inconclusive; the replicates that would decide it by that approximation are about 1.5 million, a lower guide). The exhaustive arm
reports the same design with 80.42% ± 0.56 and 2.57% ± 0.11. A rate on or just inside its bound is the case more replicates cannot settle.

Exhaustive arm, every candidate at full precision (power under HR 0.70 at 5,000 replicates, type I error under HR 1 at 20,000):

| Candidate | Status | Power | Type I error | Power verdict | Type I error verdict |
| --- | --- | --- | --- | --- | --- |
| nTreat 100, nControl 100, duration 12 | evaluated | 47.18% ± 0.71 | 2.46% ± 0.11 | fail | inconclusive |
| nTreat 100, nControl 100, duration 18 | evaluated | 51.20% ± 0.71 | 2.62% ± 0.11 | fail | inconclusive |
| nTreat 100, nControl 100, duration 24 | evaluated | 53.74% ± 0.71 | 2.44% ± 0.11 | fail | inconclusive |
| nTreat 125, nControl 125, duration 12 | evaluated | 55.10% ± 0.70 | 2.51% ± 0.11 | fail | inconclusive |
| nTreat 125, nControl 125, duration 18 | evaluated | 59.68% ± 0.69 | 2.51% ± 0.11 | fail | inconclusive |
| nTreat 125, nControl 125, duration 24 | evaluated | 63.82% ± 0.68 | 2.67% ± 0.11 | fail | inconclusive |
| nTreat 150, nControl 150, duration 12 | evaluated | 65.16% ± 0.67 | 2.60% ± 0.11 | fail | inconclusive |
| nTreat 150, nControl 150, duration 18 | evaluated | 67.82% ± 0.66 | 2.42% ± 0.11 | fail | inconclusive |
| nTreat 150, nControl 150, duration 24 | evaluated | 71.50% ± 0.64 | 2.56% ± 0.11 | fail | inconclusive |
| nTreat 175, nControl 175, duration 12 | evaluated | 71.94% ± 0.64 | 2.40% ± 0.11 | fail | inconclusive |
| nTreat 175, nControl 175, duration 18 | evaluated | 74.60% ± 0.62 | 2.54% ± 0.11 | fail | inconclusive |
| nTreat 175, nControl 175, duration 24 | evaluated | 78.36% ± 0.58 | 2.54% ± 0.11 | fail | inconclusive |
| nTreat 200, nControl 200, duration 12 | evaluated | 77.30% ± 0.59 | 2.60% ± 0.11 | fail | inconclusive |
| nTreat 200, nControl 200, duration 18 | evaluated | 80.42% ± 0.56 | 2.57% ± 0.11 | inconclusive | inconclusive |
| nTreat 200, nControl 200, duration 24 | evaluated | 83.82% ± 0.52 | 2.49% ± 0.11 | pass | inconclusive |

Power verdicts are the same as before (one pass, 200 per arm with 24 months; one inconclusive, 200 per arm with 18 months, a one-sided lower
bound below 80%; the other 13 fail). The type I error column is the change: no design passes and none fails.

### Level family: the analysis level as a design variable

The question: with the constraint frozen at 2.5%, does letting the campaign test at a lower level give the design the margin the simulation
needs? Two campaigns on the same designs, one allowed only the 2.5% level, one allowed the four levels.

| Arm | Stop | Chosen design | Candidates evaluated | Units | Engine CPU-s | Wall s | Feasible / inconclusive finalists |
| --- | --- | --- | --- | --- | --- | --- | --- |
| level-fixed | `inconclusive_at_precision` | — (closest: nTreat 200, nControl 200, analysis level 2.5%) | 3 | 9 | 231.3 | 127.0 | 0 / 3 |
| level-searched | `acceptable_precision` | nTreat 200, nControl 200, analysis level 2.35% | 12 | 20 | 312.5 | 184.4 | 2 / 2 |
| level-exhaustive | `acceptable_precision` | nTreat 200, nControl 200, analysis level 2.2% | 12 | 24 | 901.4 | 484.0 | 5 / 7 |

Level-exhaustive, all 12 designs at full precision:

| Candidate | Status | Power | Type I error | Power verdict | Type I error verdict |
| --- | --- | --- | --- | --- | --- |
| nTreat 200, nControl 200, analysis level 2.5% | evaluated | 83.14% ± 0.53 | 2.48% ± 0.11 | pass | inconclusive |
| nTreat 200, nControl 200, analysis level 2.35% | evaluated | 82.48% ± 0.54 | 2.34% ± 0.11 | pass | inconclusive |
| nTreat 200, nControl 200, analysis level 2.2% | evaluated | 81.66% ± 0.55 | 2.17% ± 0.10 | pass | pass |
| nTreat 200, nControl 200, analysis level 2% | evaluated | 80.50% ± 0.56 | 1.97% ± 0.10 | inconclusive | pass |
| nTreat 225, nControl 225, analysis level 2.5% | evaluated | 87.20% ± 0.47 | 2.66% ± 0.11 | pass | inconclusive |
| nTreat 225, nControl 225, analysis level 2.35% | evaluated | 86.72% ± 0.48 | 2.44% ± 0.11 | pass | inconclusive |
| nTreat 225, nControl 225, analysis level 2.2% | evaluated | 86.32% ± 0.49 | 2.27% ± 0.11 | pass | pass |
| nTreat 225, nControl 225, analysis level 2% | evaluated | 85.56% ± 0.50 | 2.07% ± 0.10 | pass | pass |
| nTreat 250, nControl 250, analysis level 2.5% | evaluated | 90.92% ± 0.41 | 2.50% ± 0.11 | pass | inconclusive |
| nTreat 250, nControl 250, analysis level 2.35% | evaluated | 90.32% ± 0.42 | 2.35% ± 0.11 | pass | inconclusive |
| nTreat 250, nControl 250, analysis level 2.2% | evaluated | 89.80% ± 0.43 | 2.23% ± 0.10 | pass | pass |
| nTreat 250, nControl 250, analysis level 2% | evaluated | 89.20% ± 0.44 | 2.04% ± 0.10 | pass | pass |

What happened, including what is not clean:

- **The fixed-level campaign could not decide**: all three designs it checked at the 2.5% level are inconclusive on type I error (2.71%, 2.29% and
  2.47% on its own streams), so it stopped `inconclusive_at_precision` and reported the closest design (200 per arm, 400 patients, type I error
  2.71% ± 0.11, about 22,000 replicates by the normal approximation, for that stream's estimate). The constraint stayed 2.5% and nothing passed
  on a point estimate, which is the rule.
- **The searched campaign found designs that pass the unchanged 2.5% constraint**: 200 per arm at levels 2.35% and 2.2% pass (400 patients, power
  82.8% and 82.3%), and it stopped `acceptable_precision` with 200 per arm at 2.35% as its best (the objective ties across levels at 400
  patients; the lower index wins). Cost: 312.5 CPU-s against 231.3 for the fixed-level control: the extra level candidates, not more replicates.
- **A level only 6% below the constraint is not reliably enough.** The same design at 2.35% passes in the searched campaign (2.27% ± 0.11) and is
  inconclusive in the exhaustive run (2.34% ± 0.11): the upper bound of 20,000 replicates sits about 0.2 points above the estimate, so the
  margin must exceed that. 2.2% passed in every run that evaluated it (200 per arm in both runs; 225 and 250 per arm in the exhaustive run), and 2.0% passed on type I
  error for all three sizes in the exhaustive run (its power at 200 per arm, 80.5%, is inconclusive). The platform's advice therefore proposes the constraint less the bound's gap above the estimate, rounded down to a tenth of a percent
  (2.2% for a 2.5% constraint at 20,000 replicates), not a fixed fraction. **Scope of these findings (round 2, R34):** they are results of the
  tested configurations only: the log-rank design at 24 months of accrual, 200 to 250 patients per arm, 20,000 replicates, a 2.5% constraint and
  these three runs. They are not a property of an analysis level in general: the level the advice proposes is an estimate from one run's own
  margin, and whether it passes is decided by the simulation of the new campaign that tries it.
- **Streams differ between campaigns on purpose** (seeds derive from the campaign's identity, the guard against selection bias), so the same
  design (200 per arm at 2.5%) read 2.48%, 2.44% and 2.71% in the three campaigns: that is the Monte-Carlo error of about ±0.11 at work, and the
  reason a verdict that rests on a point estimate near its bound would be luck.
- **The screen at 300 replicates left the 2.0% candidate out of the four finalists**: the ranking puts designs whose screening power point
  estimate meets 80% first and then the smaller size, so it follows that the 2.0% candidate's 300-replicate estimate was under 80% (its
  full-precision power is 80.5%, itself inconclusive); the fourth finalist went to a 450-patient design at the 2.5% level, which stayed
  inconclusive. One run of one
  family: this does not say how often a staged search finds the level that passes, only that the mechanism works and what it costs.
- **Power pays for the margin**: 200 per arm at 24 months has 83.1% power at 2.5% and 80.5% at 2.0% (the exhaustive run).

### One-job profile per unit (staged arm, survival family)

| Unit | Count | Mean engine CPU-s | Mean wall s | Max peak MB |
| --- | --- | --- | --- | --- |
| screening (300 replicates) | 15 | 1.9 | 2.2 | 132 |
| final, alternative (5,000) | 3 | 14.6 | 8.6 | 136 |
| final, null (20,000) | 3 | 56.1 | 33.6 | 168 |

### What this shows, and what it does not

- **The staged campaign's cost advantage holds**: 241 engine CPU-s against 884 for the exhaustive grid (27%); its 300-replicate screen set aside
  10 designs whose most favourable bound already fell short of 80% power (their full-precision powers are 47–72%) and re-checked three on new
  streams (175/18, 200/18, 200/24).
- **Under the new rule the headline of the previous run is gone**: the staged campaign no longer "found the best design", because no design of the
  log-rank family can be shown to hold 2.5% at 20,000 replicates when it is tested at 2.5%. It stops undecided and says which design is closest.
  Nothing in the previous JSON's power findings changed (the power verdicts are the same), and the previous run's type I error passes were the
  nominal-level assumption the platform removed.
- **At the same CPU budget an ordinary grid or one fixed random order found nothing either**: neither reached a design meeting the power
  requirement and both stopped at the budget. One random order is one draw; nothing here compares search strategies' decision quality.
- **The expert reference design (150 per arm, 18 months) does not meet the power requirement** (69.1% ± 0.65 on this run's stream).
- **Cost per unit on this host** (staged arm): a 300-replicate screen 1.9 CPU-s, a 5,000-replicate alternative 14.6 CPU-s, a 20,000-replicate null
  56 CPU-s, peak memory 170 MB; an R process start is part of every wall time. The null runs at the floor are most of every arm's cost: screening
  saves by not running them for candidates that never reach the final stage.
- **Queue**: the campaign holds one unit in flight, so its units wait for nothing of their own; had the staged arm's 21 units been submitted
  together to the one-job queue, the last would have waited 129 s. Other studies' jobs share that queue.

### Capacity decision

Keep the engine's global concurrency at 1 on the shared host: one unit of the heavy family already uses both of a job's cores, and
this box (6 GB, four cores, other sessions running) is no place to measure two concurrent jobs without the measurement being the
other sessions' load. A 1-versus-2-job comparison (p95 queue and interactive latency, core oversubscription, peak memory, throughput,
seed reproducibility) is to be run on an isolated worker before any change; it was not run here.

### Agent arm

Not run in this stream (no model calls). The controller runs it with the live model at the matched budget above and scores the
exported campaign view with `--score` against `results/search-benchmark-20261107.json`.
