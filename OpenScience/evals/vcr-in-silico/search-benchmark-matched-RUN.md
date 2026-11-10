# Matched-budget search benchmark: RUN (round-2 plan R36)

Protocol: `BENCHMARK-PROTOCOL.md`, frozen in commit 07e04f9c3 before this run (the runner is in the same commit; nothing was tuned afterwards).
Run: 2026-11-09, `node evals/vcr-in-silico/search-benchmark-matched.mjs`, 200 seeds per arm, budget and world (5 arms x 5 budgets x 3 worlds x 200
= 15,000 searches, each scored under two pick rules), 42 s on one core, no model call. Data: `results/search-benchmark-matched-20261109.json`
(every run's pick, category, regret, re-evaluation), the tables below as `results/search-benchmark-matched-20261109-tables.md`, curves
`results/search-benchmark-matched-{survival,level,level85}.svg` (probability of correct selection, success within ε and violation of picks,
against the budget, rule S). Truth: `results/search-benchmark-20261107.json` (every design at 5,000 + 20,000 replicates).

## What was run, in one paragraph

Five arms search the same designs at the same budget of simulated trials: equal-allocation **grid**, **random** (full-precision designs in a random
order), **halving** (successive halving on replicate count), **ocba** (two-stage, OCBA-style, simplified), and **ours** (the platform's
campaign, driven by the domain's own state machine, so its screening, elimination, finalist ranking and Clopper–Pearson verdict are the product's code).
A unit's outcome is an exact binomial draw from the world's true rate. The agent-directed arm (R16) is not run here: its scoring slot is
`--score-agent` (see the protocol) and it is compared against this file's tables on the live harness.
Rule S picks on point estimates for every arm; rule P is the platform's own verdict (both Clopper–Pearson bounds must pass). Ours' verdict
and an independent recomputation agreed in 3,000 of 3,000 runs.

## Limits to read first

- **The truth is a table of one earlier run's estimates** (standard error about 0.5 points on power, 0.11 on type I error), taken as exact. The
  survival world's single feasible design (200 per arm, 24 months, type I error 2.49% against 2.5%) is feasible by about one standard error of that
  run; its other designs sit at 2.4–2.7%, which is the log-rank test's nominal 2.5% plus noise. So the survival world is close to a lottery: it
  measures how the arms handle a requirement they cannot settle, not how well they find a clear optimum. The level worlds have a real structure
  (type I error moves with the analysis level) and are the informative ones.
- Three worlds from two truth tables (`level85` is `level` under a stricter power requirement); results are not independent across the two.
- **Ours is capped by its structure**: finalists are at most 5 and screening replicates below 5,000, so it spends at most about 125,000 + K x 4,999 trials
  (the "trials spent" table); the baselines use the whole budget. Its curve flattens where the campaign cannot spend more, by design of the
  product, not by a setting of this benchmark.
- OCBA here is OCBA-style (one allocation step, two cells per design), not OCBA-CO; halving ranks by a feasibility-first key of our own.
  Bayesian optimization is not an arm (no GP package in the lock).
- Simulated trials stand for engine replicates; wall time per trial differs between a screening run and a floor run (fixed R start-up per unit),
  and the budget unit ignores it. The engine check below says whether the draw model is faithful.

## Plain verdict

Where **ours** is better, equal or worse than each baseline, on the frozen reading (probability of correct selection, 95% interval of the
difference; tables below):

1. **Against equal allocation and the OCBA-style procedure, ours has no advantage at a matched budget.** Rule S, level world: worse at 40k
   (62% against 99%), equal from 80k on. Rule S, level85: worse at 40k (0% against 61–64%), equal at 80k and 320k, better at 160k against grid and
   ocba (92% against 84% and 78%), worse at 640k (90% against 99%). Rule P, level worlds: ours is better than grid at 80k–160k (level) and 160k
   (level85) but worse than ocba and halving at 40k, 80k, 320k and 640k (level 640k: 81% against 100%; level85 640k: 58% against 100%) and equal at 160k.
2. **Against random search**, rule S: level world, ours is better at 40k–160k (62% against 26% at 40k, 98% against 69% at 80k) and equal from 320k;
   level85, worse at 40k (0% against 32%), better at 80k–160k, equal after.
3. **Against successive halving**, rule S: level world, worse at 40k, better at 80k–160k (98% and 99.5% against 91% and 95%), equal after;
   level85, worse at 40k and 640k, otherwise equal. Rule P: worse at every budget except 160k in the level worlds: halving concentrates trials on
   survivors and ends with more final precision than ours' three to five finalists.
4. **Survival (the near-lottery world)**: nothing separates the arms except at the edges (ours 14% at 40k, 50% at 80k, then 45–47%; grid 38–46%;
   ocba 29–54%). Under rule P no arm reaches 6% correct selection at any budget, which restates the 11-07 finding: a log-rank design tested at its
   nominal level cannot be shown to hold 2.5% at these replicates.
5. **Budget to success within ε** (80% of seeds): level world, rule S: grid, halving and ocba 40k, random and ours 80k; rule P: every arm 160k.
   level85, rule S: halving 40k, random 80k, grid and ours 160k, ocba 320k; rule P: grid, random and halving 160k, ocba 320k, ours not reached
   (its curve ends at 56–61%). Survival: no arm reaches 80% under either rule.
6. **Constraint violation of the picked design (by truth)**: under rule P it is 0–3% for every arm wherever an arm picks. Under rule S it is 4–60%
   of picks in the survival world (point-estimate picking at a bound), at most 1.5% in the level world and up to 31% at small budgets in level85
   (ours: 100% of the few picks it makes at 40k, 7–10% from 80k). Where ours picks nothing under rule P (17–19% of runs at 160k and above in the
   level world, 39–44% in level85, 96–100% at 40k) it is on the safe-but-silent end of the trade, and that silence is where it loses correct
   selection to halving and OCBA.

Net: the staged campaign is a **cost saver against exhaustive and random search, not against a plain equal-allocation grid or a two-stage
allocation at the same trial budget**. Its conservative verdict plus its fixed structure leave it behind halving and OCBA-style allocation once
the budget exceeds what its screening and five finalists can use (about 125,000 trials in the survival world, 185,000 in the level worlds). On point-estimate
picks (rule S) at 80k–160k trials it is as good as the best baselines or better, below that it is worse, above that it is capped. Nothing was tuned
after seeing results; what this suggests (more finalists or a second screening round when the budget allows, allocating finalists' replicates by margin) is a
candidate for a new protocol, not part of this one.

Where ours is worse than a simple arm the finding stands as a measurement of the product, and it contradicts any reading of the 11-07 benchmark
as showing a staged search to be better than ordinary search: that benchmark compared against grid and random at one budget with one random
order and found nothing either.

## Validation of the simulated world against the real engine (frozen criteria, passed)

Real `design.simulate` 1.5.0 through `service/run_job.R`, the design 200 per arm / 24 months (survival world), new seeds 1001+, under the heavy lock
(`results/search-benchmark-matched-calibration-20261109.json`). The first attempt of `--calibrate` failed before any engine call (a manifest built with an
out-of-range CPU ceiling in the calibration path only; no result was produced); the fix changes that one line and none of the benchmark's logic or numbers.

| Case | Seeds | Engine mean | Table value | SD of engine estimates | Binomial SD | SD ratio (criterion 0.8–1.25) | Mean difference in combined SE (criterion within 3) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| screening, 300 replicates, power | 30 | 0.8291 | 0.8382 | 0.0200 | 0.0213 | 0.94 | -1.43 |
| final, 5,000 replicates, power | 10 | 0.8268 | 0.8382 | 0.0050 | 0.0052 | 0.97 | -2.09 |
| final, 20,000 replicates, type I error | 5 | 0.0239 | 0.0249 | 0.0012 | 0.0011 | 1.08 | -0.81 |

Both criteria hold: the engine's replicate noise is the binomial noise the benchmark draws. The engine's means sit below the table value in all three
cases (about one point of power, 0.1 of type I error): the table is one run's estimate and was probably on the high side, the limitation stated
above; it does not change the noise model, and it would move true feasibility, not the comparison of arms on the same world.

## Tables (every arm, every budget; generated)

## survival world

15 designs; 1 truly feasible, 1 of them optimal (400 patients); 200 seeds per arm and budget; ε = 50 patients; penalty score 450 patients (regret 50 for no pick or an infeasible pick).

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% [31.1%, 44.4%] | 39.5% [33.0%, 46.4%] | 43.5% [36.8%, 50.4%] | 45.5% [38.7%, 52.4%] | 44.0% [37.3%, 50.9%] |
| random | 3.0% [1.4%, 6.4%] | 10.5% [7.0%, 15.5%] | 20.0% [15.0%, 26.1%] | 34.5% [28.3%, 41.3%] | 40.0% [33.5%, 46.9%] |
| halving | 19.0% [14.2%, 25.0%] | 19.5% [14.6%, 25.5%] | 21.0% [15.9%, 27.2%] | 26.0% [20.4%, 32.5%] | 21.5% [16.4%, 27.7%] |
| ocba | 28.5% [22.7%, 35.1%] | 33.0% [26.9%, 39.8%] | 42.5% [35.9%, 49.4%] | 42.5% [35.9%, 49.4%] | 53.5% [46.6%, 60.3%] |
| ours | 14.0% [9.9%, 19.5%] | 50.0% [43.1%, 56.9%] | 47.0% [40.2%, 53.9%] | 46.5% [39.7%, 53.4%] | 44.5% [37.8%, 51.4%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 39.5% | 43.5% | 45.5% | 44.0% |
| random | 3.0% | 10.5% | 20.0% | 34.5% | 40.0% |
| halving | 19.0% | 19.5% | 21.0% | 26.0% | 21.5% |
| ocba | 28.5% | 33.0% | 42.5% | 42.5% | 53.5% |
| ours | 14.0% | 50.0% | 47.0% | 46.5% | 44.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (0–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (50–50) |
| ocba | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 0 (0–50) |
| ours | 50 (50–50) | 25 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 29.5% | 32.0% | 30.5% | 35.0% | 38.0% |
| random | 94.5% | 85.0% | 73.5% | 50.5% | 41.0% |
| halving | 76.5% | 78.0% | 74.5% | 71.5% | 77.5% |
| ocba | 28.0% | 37.0% | 27.5% | 34.0% | 32.5% |
| ours | 70.5% | 33.5% | 32.5% | 31.5% | 34.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.8% / 63.8% | 41.9% / 62.5% | 37.4% / 56.8% | 30.0% / 56.2% | 29.0% / 45.2% |
| random | 45.5% / 81.8% | 30.0% / 50.0% | 24.5% / 58.5% | 30.3% / 53.5% | 32.2% / 56.8% |
| halving | 19.1% / 61.7% | 11.4% / 54.5% | 17.6% / 49.0% | 8.8% / 54.4% | 4.4% / 57.8% |
| ocba | 60.4% / 61.8% | 47.6% / 65.9% | 41.4% / 53.1% | 35.6% / 56.8% | 20.7% / 51.9% |
| ours | 52.5% / 62.7% | 24.8% / 45.1% | 30.4% / 57.0% | 32.1% / 57.7% | 32.6% / 54.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% [0.3%, 3.6%] | 2.0% [0.8%, 5.0%] | 3.5% [1.7%, 7.0%] | 2.0% [0.8%, 5.0%] | 1.0% [0.3%, 3.6%] |
| random | 0.0% [0.0%, 1.9%] | 0.0% [0.0%, 1.9%] | 0.5% [0.1%, 2.8%] | 0.0% [0.0%, 1.9%] | 4.0% [2.0%, 7.7%] |
| halving | 1.0% [0.3%, 3.6%] | 1.5% [0.5%, 4.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 2.0% [0.8%, 5.0%] |
| ocba | 1.0% [0.3%, 3.6%] | 1.0% [0.3%, 3.6%] | 4.0% [2.0%, 7.7%] | 2.5% [1.1%, 5.7%] | 5.0% [2.7%, 9.0%] |
| ours | 1.0% [0.3%, 3.6%] | 4.5% [2.4%, 8.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 3.5% [1.7%, 7.0%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% | 2.0% | 3.5% | 2.0% | 1.0% |
| random | 0.0% | 0.0% | 0.5% | 0.0% | 4.0% |
| halving | 1.0% | 1.5% | 2.0% | 2.5% | 2.0% |
| ocba | 1.0% | 1.0% | 4.0% | 2.5% | 5.0% |
| ours | 1.0% | 4.5% | 2.0% | 2.5% | 3.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ocba | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 99.0% | 98.0% | 96.5% | 98.0% | 99.0% |
| random | 100.0% | 100.0% | 99.5% | 100.0% | 96.0% |
| halving | 99.0% | 98.5% | 98.0% | 97.5% | 98.0% |
| ocba | 99.0% | 99.0% | 95.5% | 97.5% | 95.0% |
| ours | 99.0% | 95.5% | 98.0% | 97.5% | 96.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 50.0% | 0.0% / 25.0% | 0.0% / 28.6% | 0.0% / 50.0% | 0.0% / 0.0% |
| random | n/a / n/a | n/a / n/a | 0.0% / 0.0% | n/a / n/a | 0.0% / 12.5% |
| halving | 0.0% / 100.0% | 0.0% / 66.7% | 0.0% / 50.0% | 0.0% / 80.0% | 0.0% / 100.0% |
| ocba | 0.0% / 50.0% | 0.0% / 50.0% | 11.1% / 33.3% | 0.0% / 60.0% | 0.0% / 40.0% |
| ours | 0.0% / 50.0% | 0.0% / 66.7% | 0.0% / 75.0% | 0.0% / 60.0% | 12.5% / 50.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 375k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 40k | 80k | 110k | 125k | 125k |

**Ours against each baseline: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-24 pts [-32, -15]) | better (10 pts [1, 20]) | equal (3 pts [-6, 13]) | equal (1 pts [-9, 11]) | equal (1 pts [-9, 10]) |
| random | better (11 pts [6, 17]) | better (40 pts [31, 47]) | better (27 pts [18, 36]) | better (12 pts [2, 21]) | equal (4 pts [-5, 14]) |
| halving | equal (-5 pts [-12, 2]) | better (31 pts [21, 39]) | better (26 pts [17, 35]) | better (21 pts [11, 29]) | better (23 pts [14, 32]) |
| ocba | worse (-14 pts [-22, -7]) | better (17 pts [7, 26]) | equal (4 pts [-5, 14]) | equal (4 pts [-6, 14]) | equal (-9 pts [-19, 1]) |

Rule P:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (-2 pts [-5, 2]) | equal (1 pts [-3, 4]) | equal (3 pts [-1, 6]) |
| random | equal (1 pts [-1, 4]) | better (5 pts [2, 8]) | equal (2 pts [-1, 5]) | better (3 pts [0, 6]) | equal (-0 pts [-5, 4]) |
| halving | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (0 pts [-3, 3]) | equal (0 pts [-4, 4]) | equal (2 pts [-2, 5]) |
| ocba | equal (0 pts [-3, 3]) | better (3 pts [0, 7]) | equal (-2 pts [-6, 2]) | equal (0 pts [-4, 4]) | equal (-2 pts [-6, 3]) |

Check: ours' own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

Ours' stop reasons: 40k inconclusive_at_precision x168; 40k no_feasible_beneficial_candidate x30; 40k acceptable_precision x2; 80k inconclusive_at_precision x190; 80k no_feasible_beneficial_candidate x1; 80k acceptable_precision x9; 160k inconclusive_at_precision x196; 160k acceptable_precision x4; 320k inconclusive_at_precision x194; 320k acceptable_precision x5; 320k no_feasible_beneficial_candidate x1; 640k inconclusive_at_precision x191; 640k acceptable_precision x8; 640k no_feasible_beneficial_candidate x1.

## level world

12 designs; 11 truly feasible, 4 of them optimal (400 patients); 200 seeds per arm and budget; ε = 50 patients; penalty score 550 patients (regret 150 for no pick or an infeasible pick).

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 99.0% [96.4%, 99.7%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |
| random | 26.0% [20.4%, 32.5%] | 69.0% [62.3%, 75.0%] | 91.0% [86.2%, 94.2%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |
| halving | 83.5% [77.7%, 88.0%] | 91.0% [86.2%, 94.2%] | 95.0% [91.0%, 97.3%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] |
| ocba | 99.0% [96.4%, 99.7%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |
| ours | 61.5% [54.6%, 68.0%] | 97.5% [94.3%, 98.9%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| random | 51.5% | 92.0% | 99.0% | 100.0% | 100.0% |
| halving | 98.0% | 99.5% | 100.0% | 100.0% | 100.0% |
| ocba | 99.5% | 100.0% | 100.0% | 100.0% | 100.0% |
| ours | 61.5% | 97.5% | 100.0% | 100.0% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 0 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 19.5% | 0.0% | 0.0% | 0.0% | 0.0% |
| halving | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 38.5% | 2.5% | 0.0% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 22.0% | 0.0% / 20.0% | 0.0% / 21.0% | 0.0% / 26.0% | 0.0% / 38.5% |
| random | 0.0% / 9.9% | 0.0% / 15.5% | 0.5% / 16.5% | 0.0% / 29.0% | 0.0% / 26.5% |
| halving | 1.5% / 13.0% | 0.0% / 17.0% | 0.0% / 10.5% | 0.0% / 7.0% | 0.0% / 7.0% |
| ocba | 0.5% / 27.5% | 0.0% / 28.0% | 0.0% / 25.0% | 0.0% / 28.5% | 0.0% / 28.0% |
| ours | 0.0% / 39.8% | 0.0% / 26.7% | 0.0% / 34.5% | 0.0% / 17.5% | 0.0% / 27.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 40k, random 80k, halving 40k, ocba 40k, ours 80k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 5.5% [3.1%, 9.6%] | 21.5% [16.4%, 27.7%] | 48.0% [41.2%, 54.9%] | 89.0% [83.9%, 92.6%] | 99.0% [96.4%, 99.7%] |
| random | 10.0% [6.6%, 14.9%] | 30.0% [24.1%, 36.7%] | 45.5% [38.7%, 52.4%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] |
| halving | 22.0% [16.8%, 28.2%] | 54.5% [47.6%, 61.3%] | 86.0% [80.5%, 90.1%] | 97.0% [93.6%, 98.6%] | 100.0% [98.1%, 100.0%] |
| ocba | 27.5% [21.8%, 34.1%] | 59.0% [52.1%, 65.6%] | 86.0% [80.5%, 90.1%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] |
| ours | 4.0% [2.0%, 7.7%] | 33.5% [27.3%, 40.3%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] | 81.0% [75.0%, 85.8%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.0% | 66.0% | 95.5% | 100.0% | 100.0% |
| random | 25.5% | 59.0% | 83.5% | 99.5% | 100.0% |
| halving | 52.5% | 78.0% | 97.0% | 99.5% | 100.0% |
| ocba | 32.5% | 67.0% | 92.5% | 100.0% | 100.0% |
| ours | 4.0% | 33.5% | 82.5% | 83.5% | 81.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–150) | 50 (50–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| random | 150 (50–150) | 50 (0–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| halving | 50 (50–150) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 150 (0–150) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 150 (150–150) | 150 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 13.0% | 0.0% | 0.0% | 0.0% |
| random | 59.5% | 18.5% | 5.0% | 0.0% | 0.0% |
| halving | 46.0% | 21.5% | 3.0% | 0.5% | 0.0% |
| ocba | 50.0% | 21.5% | 3.5% | 0.0% | 0.0% |
| ours | 96.0% | 66.5% | 17.5% | 16.5% | 19.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.8% / 9.6% | 0.6% / 6.3% | 0.0% / 2.0% | 0.0% / 6.0% | 0.0% / 5.0% |
| random | 0.0% / 4.9% | 0.0% / 4.3% | 0.0% / 3.7% | 0.0% / 1.0% | 0.0% / 4.0% |
| halving | 0.0% / 5.6% | 0.0% / 2.5% | 0.0% / 2.6% | 0.0% / 2.0% | 0.0% / 7.5% |
| ocba | 2.0% / 8.0% | 0.6% / 8.3% | 0.0% / 6.7% | 0.0% / 5.0% | 0.0% / 7.5% |
| ours | 0.0% / 37.5% | 0.0% / 16.4% | 0.0% / 3.6% | 0.0% / 7.2% | 0.0% / 6.2% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 160k, ours 160k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |

**Ours against each baseline: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| random | better (36 pts [26, 44]) | better (29 pts [22, 35]) | better (8 pts [5, 13]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| halving | worse (-22 pts [-30, -13]) | better (6 pts [2, 11]) | better (5 pts [1, 8]) | equal (1 pts [-1, 3]) | equal (0 pts [-2, 2]) |
| ocba | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-6, 3]) | better (12 pts [3, 21]) | better (33 pts [24, 41]) | equal (-6 pts [-13, 1]) | worse (-18 pts [-24, -13]) |
| random | worse (-6 pts [-11, -1]) | equal (4 pts [-6, 13]) | better (36 pts [26, 44]) | equal (2 pts [-6, 10]) | equal (-2 pts [-10, 6]) |
| halving | worse (-18 pts [-25, -12]) | worse (-21 pts [-30, -11]) | equal (-5 pts [-12, 2]) | worse (-14 pts [-20, -8]) | worse (-19 pts [-25, -14]) |
| ocba | worse (-24 pts [-30, -17]) | worse (-25 pts [-35, -16]) | equal (-5 pts [-12, 2]) | worse (-17 pts [-22, -11]) | worse (-19 pts [-25, -14]) |

Check: ours' own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

Ours' stop reasons: 40k inconclusive_at_precision x191; 40k acceptable_precision x8; 40k no_feasible_beneficial_candidate x1; 80k acceptable_precision x67; 80k inconclusive_at_precision x133; 160k acceptable_precision x165; 160k inconclusive_at_precision x35; 320k acceptable_precision x167; 320k inconclusive_at_precision x33; 640k acceptable_precision x162; 640k inconclusive_at_precision x38.

## level85 world

12 designs; 7 truly feasible, 3 of them optimal (450 patients); 200 seeds per arm and budget; ε = 50 patients; penalty score 550 patients (regret 100 for no pick or an infeasible pick).

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 61.0% [54.1%, 67.5%] | 70.0% [63.3%, 75.9%] | 84.0% [78.3%, 88.4%] | 91.5% [86.8%, 94.6%] | 99.0% [96.4%, 99.7%] |
| random | 32.0% [25.9%, 38.8%] | 55.5% [48.6%, 62.2%] | 77.0% [70.7%, 82.3%] | 91.5% [86.8%, 94.6%] | 89.0% [83.9%, 92.6%] |
| halving | 60.5% [53.6%, 67.0%] | 74.5% [68.0%, 80.0%] | 86.5% [81.1%, 90.6%] | 94.5% [90.4%, 96.9%] | 100.0% [98.1%, 100.0%] |
| ocba | 63.5% [56.6%, 69.9%] | 72.5% [65.9%, 78.2%] | 77.5% [71.2%, 82.7%] | 93.0% [88.6%, 95.8%] | 99.5% [97.2%, 99.9%] |
| ours | 0.0% [0.0%, 1.9%] | 68.0% [61.2%, 74.1%] | 91.5% [86.8%, 94.6%] | 92.0% [87.4%, 95.0%] | 90.0% [85.1%, 93.4%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 68.5% | 71.5% | 84.5% | 91.5% | 99.0% |
| random | 61.5% | 90.5% | 93.0% | 91.5% | 89.0% |
| halving | 92.5% | 95.5% | 100.0% | 100.0% | 100.0% |
| ocba | 69.0% | 73.0% | 77.5% | 93.0% | 99.5% |
| ours | 0.0% | 68.0% | 91.5% | 92.5% | 90.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 38.0% | 5.5% | 1.0% | 0.0% | 0.0% |
| halving | 1.5% | 1.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 89.0% | 26.5% | 0.0% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 31.5% / 45.0% | 28.5% / 36.0% | 15.5% / 27.5% | 8.5% / 25.0% | 1.0% / 24.5% |
| random | 0.8% / 11.3% | 4.2% / 20.1% | 6.1% / 24.2% | 8.5% / 31.5% | 11.0% / 28.0% |
| halving | 6.1% / 17.8% | 3.5% / 15.2% | 0.0% / 8.5% | 0.0% / 10.5% | 0.0% / 10.0% |
| ocba | 31.0% / 42.5% | 27.0% / 41.5% | 22.5% / 33.5% | 7.0% / 27.0% | 0.5% / 23.0% |
| ours | 100.0% / 95.5% | 7.5% / 25.2% | 8.5% / 25.5% | 7.5% / 24.0% | 10.0% / 27.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 160k, random 80k, halving 40k, ocba 320k, ours 160k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 3.5% [1.7%, 7.0%] | 7.5% [4.6%, 12.0%] | 27.0% [21.3%, 33.5%] | 65.5% [58.7%, 71.7%] | 90.5% [85.6%, 93.8%] |
| random | 7.5% [4.6%, 12.0%] | 13.5% [9.4%, 18.9%] | 30.5% [24.5%, 37.2%] | 58.0% [51.1%, 64.6%] | 56.5% [49.6%, 63.2%] |
| halving | 14.0% [9.9%, 19.5%] | 32.0% [25.9%, 38.8%] | 61.5% [54.6%, 68.0%] | 85.5% [80.0%, 89.7%] | 98.0% [95.0%, 99.2%] |
| ocba | 5.5% [3.1%, 9.6%] | 22.0% [16.8%, 28.2%] | 55.0% [48.1%, 61.7%] | 91.5% [86.8%, 94.6%] | 100.0% [98.1%, 100.0%] |
| ours | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 53.5% [46.6%, 60.3%] | 54.5% [47.6%, 61.3%] | 57.5% [50.6%, 64.1%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.0% | 73.5% | 98.0% | 100.0% | 100.0% |
| random | 26.5% | 54.5% | 80.5% | 100.0% | 99.0% |
| halving | 56.0% | 76.0% | 90.0% | 96.5% | 99.5% |
| ocba | 16.0% | 42.5% | 78.5% | 97.5% | 100.0% |
| ours | 0.0% | 1.0% | 56.0% | 56.5% | 61.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) |
| random | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–50) |
| halving | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ocba | 100 (100–100) | 100 (50–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 100 (100–100) | 0 (0–100) | 0 (0–100) | 0 (0–100) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 53.5% | 26.5% | 2.0% | 0.0% | 0.0% |
| random | 73.5% | 45.5% | 19.5% | 0.0% | 1.0% |
| halving | 43.5% | 24.0% | 10.0% | 3.5% | 0.5% |
| ocba | 83.5% | 57.0% | 20.5% | 2.5% | 0.0% |
| ours | 100.0% | 99.0% | 44.0% | 43.5% | 39.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.1% / 2.2% | 0.0% / 3.4% | 0.0% / 6.6% | 0.0% / 7.0% | 0.0% / 9.0% |
| random | 0.0% / 1.9% | 0.0% / 3.7% | 0.0% / 3.7% | 0.0% / 5.0% | 0.0% / 5.6% |
| halving | 0.9% / 4.4% | 0.0% / 3.9% | 0.0% / 2.2% | 0.0% / 3.6% | 0.0% / 7.0% |
| ocba | 3.0% / 12.1% | 1.2% / 9.3% | 1.3% / 10.1% | 0.0% / 7.2% | 0.0% / 7.5% |
| ours | n/a / n/a | 0.0% / 50.0% | 0.0% / 8.9% | 0.0% / 2.7% | 0.0% / 6.6% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 320k, ours not reached

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |

**Ours against each baseline: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-61 pts [-67, -54]) | equal (-2 pts [-11, 7]) | better (8 pts [1, 14]) | equal (1 pts [-5, 6]) | worse (-9 pts [-14, -5]) |
| random | worse (-32 pts [-39, -26]) | better (13 pts [3, 22]) | better (15 pts [7, 22]) | equal (1 pts [-5, 6]) | equal (1 pts [-5, 7]) |
| halving | worse (-61 pts [-67, -53]) | equal (-6 pts [-15, 2]) | equal (5 pts [-1, 11]) | equal (-2 pts [-8, 3]) | worse (-10 pts [-15, -6]) |
| ocba | worse (-64 pts [-70, -56]) | equal (-4 pts [-13, 4]) | better (14 pts [7, 21]) | equal (-1 pts [-6, 4]) | worse (-9 pts [-14, -5]) |

Rule P:

| Baseline | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-4 pts [-7, -1]) | worse (-7 pts [-11, -3]) | better (27 pts [17, 35]) | worse (-11 pts [-20, -1]) | worse (-33 pts [-41, -25]) |
| random | worse (-8 pts [-12, -4]) | worse (-13 pts [-18, -8]) | better (23 pts [13, 32]) | equal (-3 pts [-13, 6]) | equal (1 pts [-9, 11]) |
| halving | worse (-14 pts [-19, -9]) | worse (-31 pts [-38, -24]) | equal (-8 pts [-17, 2]) | worse (-31 pts [-39, -22]) | worse (-41 pts [-48, -33]) |
| ocba | worse (-6 pts [-10, -2]) | worse (-21 pts [-27, -15]) | equal (-2 pts [-11, 8]) | worse (-37 pts [-45, -29]) | worse (-43 pts [-49, -36]) |

Check: ours' own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

Ours' stop reasons: 40k inconclusive_at_precision x140; 40k no_feasible_beneficial_candidate x60; 80k inconclusive_at_precision x197; 80k no_feasible_beneficial_candidate x1; 80k acceptable_precision x2; 160k inconclusive_at_precision x88; 160k acceptable_precision x112; 320k inconclusive_at_precision x87; 320k acceptable_precision x113; 640k inconclusive_at_precision x78; 640k acceptable_precision x122.

---

# Addendum D5 (2026-11-09): the allocation fixed at its root, `ours2` beside `ours`

The section above stays as it was. This one adds a sixth arm, **ours2**, and reports it on the same protocol, the same worlds, budgets and seeds 1..200
(`BENCHMARK-PROTOCOL.md`, addendum D5). Run: `node evals/vcr-in-silico/search-benchmark-matched.mjs` (all six arms, 18,000 searches, 65 s, no model call).
Data: `results/search-benchmark-matched-20261109-d5.json`, tables `results/search-benchmark-matched-20261109-d5-tables.md` (every metric of the
first run for every arm, plus `ours2` against each arm), curves `results/search-benchmark-matched-{survival,level,level85}-d5.svg`.

**Check that nothing moved.** The five original arms were re-run with the changed domain code and reproduce the first run exactly: all 150 aggregate cells
(3 worlds x 5 arms x 5 budgets x 2 rules) are byte-identical to `results/search-benchmark-matched-20261109.json`; the domain's own verdict and the
independent recomputation agreed in 3,000 of 3,000 `ours` runs and 3,000 of 3,000 `ours2` runs.

## Root cause of the cap

`budget.cpuSeconds` was only a ceiling, checked before each unit; it was never an input of the allocation. The stage sizes were fixed in the manifest
(screening below the floor, alternative case only; at most `finalCountMax` = 5 finalists; one final run each), the finalists were chosen once from the
screening rank, and after that single round the verdict stopped the campaign with `acceptable_precision` whatever was left. So (1) the curve ends where the
structure ends (about 125,000 + K x 4,999 trials), (2) when all five finalists fail there is no recourse (the 17-19% no-pick at 160k and above in the level
world, 39-44% in level85), (3) a design the first run left undecided never got more replicates, and (4) a finalist that failed its power check was still run on
the 20,000-replicate null truth. Not a bug of the benchmark: the product behaves so.

## The fix (`@evimed/domain` `vcrExperimentSearch.mjs`, opt-in `budget.replicates`)

A campaign that states `budget.replicates` is *budgeted*; one that does not has the same canonical bytes and the same fixed stages as before.
- Screening is unchanged (ranking and elimination only, never a pass), sized by one stated rule (`vcrCampaignBudgetPlan`: a fifth of the budget, alternative
  case, below the floor); the first wave is one finalist (plus the reference).
- Then one unit at a time: the next design judged is the cheapest by the objective whose estimate, less z times its own error, could still beat the best
  feasible design so far (designs the screening says may meet the design constraints first). A design judged *inconclusive* is run again, fresh, with the
  replicates its gap to the bound needs (OCBA's rule of thumb), at most twice, and only when that is within 4 times its run: a gap that would take more is
  inside the indifference zone of what the budget can resolve, so the design is neither passed nor chased. A finalist whose design constraint already fails
  on its final run is not run on its error-control truth. It stops when nothing in play can beat the best, or nothing in play fits the budget; the stop
  records `allocation` (budget, spent, unspent, and why: `decided`, `precision_not_reachable`, `next_unit_does_not_fit`) and a reason for every design
  that was not judged (`not_needed:cannot_beat_best`, `not_evaluated:budget`, `not_screened:budget`).
- **Error control is untouched.** A verdict still reads one final run at the method's floor or more, on a stream no screening unit and no earlier run of that
  design used, at the constraints' own confidence (Clopper-Pearson); alpha is frozen; `inconclusive_at_precision` is still a stop reason. A re-run is judged on
  its own fresh data alone (the earlier run only decided to run it; it is kept as `superseded`, never pooled). **Correction (X1 addendum below): the clause "so each design's bound stays exact" was wrong.** A design that may be run up to three times and is certified on the look it ends on is certified more often than one look would: 3.3% against 2.4% for a design exactly on its type I error bound at a 97.5% confidence (20,000 simulated campaigns). The numbers in this addendum D5 are of that rule; the X1 addendum has the corrected rule. What more
  designs judged does change is the chance that one of them passes by luck (the family-wise note of `verdict.selection`, which holds for any larger
  finalist set); the table below measures it: the picked design violated a constraint in truth in 0 of the picks of `ours2` at every budget in the
  level world and survival, and in 1 budget of 5 in level85 (80k: 1 of its 14 picks, 7%; the other four budgets 0).

## Disclosure of how the rule was chosen

The first version of the rule (no cap on a re-run's size) was run once on seeds 1..200. It was no improvement in the level world at 320k (platform rule:
67% correct selection against 83% for `ours`; level85 it was better, 61% against 55% at 320k and 95% against 57% at 640k): it spent 300k-510k chasing designs
whose true value sits on the bound (a type I error of 2.475% against 2.5%). Its numbers are kept in `results/search-benchmark-matched-20261109-d5-v1-superseded.json`. The cap (re-run
at most 4 times its run, at most twice) was then chosen on **development seeds 1001..1100** the protocol never reports (`--seed-from 1001`; rounds/growth
2/4, 3/8 and 3/16 were tried there and 2/4 was best), and the reported run is seeds 1..200 once with that rule. The seeds 1..200 therefore did
influence one decision (that a cap was needed), the choice of its value did not use them. **That is not the whole of it (review S16):** the development seeds 1001..1100 are other
seeds of the SAME three truth tables that are reported, so the cap (rounds 2, growth 4) was chosen on the worlds it is then reported on; only the seeds differ. "Ours2 matches grid and
OCBA from about 160k" is in-sample for the worlds and out-of-sample for the seeds only. No world that was not used in the choice was run.

## Result

**level, Rule P: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 6% (38%, 40k) | 22% (13%, 80k) | 48% (0%, 160k) | 89% (0%, 320k) | 99% (0%, 640k) |
| random | 10% (60%, 25k) | 30% (19%, 75k) | 46% (5%, 150k) | 81% (0%, 300k) | 83% (0%, 300k) |
| halving | 22% (46%, 40k) | 55% (22%, 80k) | 86% (3%, 160k) | 97% (1%, 320k) | 100% (0%, 640k) |
| ocba | 28% (50%, 40k) | 59% (22%, 80k) | 86% (4%, 160k) | 100% (0%, 320k) | 100% (0%, 640k) |
| ours | 4% (96%, 39k) | 34% (67%, 80k) | 81% (18%, 160k) | 83% (17%, 185k) | 81% (19%, 185k) |
| ours2 | 7% (94%, 37k) | 27% (73%, 71k) | 81% (20%, 127k) | 96% (3%, 148k) | 99% (0%, 159k) |

**level, Rule S: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 99% (0%, 40k) | 100% (0%, 80k) | 100% (0%, 160k) | 100% (0%, 320k) | 100% (0%, 640k) |
| random | 26% (20%, 25k) | 69% (0%, 75k) | 91% (0%, 150k) | 100% (0%, 300k) | 100% (0%, 300k) |
| halving | 84% (0%, 40k) | 91% (0%, 80k) | 95% (0%, 160k) | 100% (0%, 320k) | 100% (0%, 640k) |
| ocba | 99% (0%, 40k) | 100% (0%, 80k) | 100% (0%, 160k) | 100% (0%, 320k) | 100% (0%, 640k) |
| ours | 62% (39%, 39k) | 98% (3%, 80k) | 100% (0%, 160k) | 100% (0%, 185k) | 100% (0%, 185k) |
| ours2 | 65% (36%, 37k) | 93% (8%, 71k) | 100% (1%, 127k) | 100% (0%, 148k) | 100% (0%, 159k) |

**level85, Rule P: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 4% (54%, 40k) | 8% (27%, 80k) | 27% (2%, 160k) | 66% (0%, 320k) | 91% (0%, 640k) |
| random | 8% (74%, 25k) | 14% (46%, 75k) | 31% (20%, 150k) | 58% (0%, 300k) | 56% (1%, 300k) |
| halving | 14% (44%, 40k) | 32% (24%, 80k) | 62% (10%, 160k) | 86% (4%, 320k) | 98% (1%, 640k) |
| ocba | 6% (84%, 40k) | 22% (57%, 80k) | 55% (21%, 160k) | 92% (3%, 320k) | 100% (0%, 640k) |
| ours | 0% (100%, 39k) | 1% (99%, 80k) | 54% (44%, 160k) | 55% (44%, 185k) | 57% (39%, 185k) |
| ours2 | 1% (99%, 37k) | 7% (93%, 71k) | 57% (43%, 142k) | 89% (8%, 196k) | 93% (0%, 187k) |

**level85, Rule S: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 61% (0%, 40k) | 70% (0%, 80k) | 84% (0%, 160k) | 92% (0%, 320k) | 99% (0%, 640k) |
| random | 32% (38%, 25k) | 56% (6%, 75k) | 77% (1%, 150k) | 92% (0%, 300k) | 89% (0%, 300k) |
| halving | 61% (2%, 40k) | 75% (1%, 80k) | 87% (0%, 160k) | 95% (0%, 320k) | 100% (0%, 640k) |
| ocba | 64% (0%, 40k) | 73% (0%, 80k) | 78% (0%, 160k) | 93% (0%, 320k) | 100% (0%, 640k) |
| ours | 0% (89%, 39k) | 68% (27%, 80k) | 92% (0%, 160k) | 92% (0%, 185k) | 90% (0%, 185k) |
| ours2 | 5% (85%, 37k) | 49% (42%, 71k) | 80% (9%, 142k) | 90% (1%, 196k) | 92% (0%, 187k) |

**survival, Rule P: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1% (99%, 40k) | 2% (98%, 80k) | 4% (97%, 160k) | 2% (98%, 320k) | 1% (99%, 640k) |
| random | 0% (100%, 25k) | 0% (100%, 75k) | 1% (100%, 150k) | 0% (100%, 300k) | 4% (96%, 375k) |
| halving | 1% (99%, 40k) | 2% (99%, 80k) | 2% (98%, 160k) | 3% (98%, 320k) | 2% (98%, 640k) |
| ocba | 1% (99%, 40k) | 1% (99%, 80k) | 4% (96%, 160k) | 3% (98%, 320k) | 5% (95%, 640k) |
| ours | 1% (99%, 40k) | 5% (96%, 80k) | 2% (98%, 110k) | 3% (98%, 125k) | 4% (96%, 125k) |
| ours2 | 1% (99%, 38k) | 4% (97%, 70k) | 5% (96%, 118k) | 5% (95%, 144k) | 2% (99%, 162k) |

**survival, Rule S: probability of correct selection (no pick, trials spent at the median)**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 38% (30%, 40k) | 40% (32%, 80k) | 44% (31%, 160k) | 46% (35%, 320k) | 44% (38%, 640k) |
| random | 3% (95%, 25k) | 11% (85%, 75k) | 20% (74%, 150k) | 35% (51%, 300k) | 40% (41%, 375k) |
| halving | 19% (77%, 40k) | 20% (78%, 80k) | 21% (75%, 160k) | 26% (72%, 320k) | 22% (78%, 640k) |
| ocba | 28% (28%, 40k) | 33% (37%, 80k) | 43% (28%, 160k) | 43% (34%, 320k) | 54% (33%, 640k) |
| ours | 14% (71%, 40k) | 50% (34%, 80k) | 47% (33%, 110k) | 47% (32%, 125k) | 45% (34%, 125k) |
| ours2 | 22% (66%, 38k) | 42% (43%, 70k) | 39% (40%, 118k) | 44% (35%, 144k) | 48% (37%, 162k) |

Trials spent are the median of the whole search; `ours` is capped near 110k-185k, `ours2` stops when its verdict is decided (about 127k-196k in the level
worlds at 160k and above) or when the next unit does not fit the budget.

**Plain statement of where ours now stands** (rule P is the platform's own verdict and the reading that matters for the product; differences are the
frozen Newcombe reading, tables file):
- **The cap is gone.** The structure no longer limits the spend (the domain test `vcrBudgetedSearch` has a campaign spend 265k+ against the fixed structure's
  ceiling of about 185k, and the first version of the rule spent up to 525k here); in these three worlds the question is settled by 127k-196k, so `ours2` stops there
  with a stated reason instead of flattening. At 320k and 640k the level worlds are no longer where `ours` flattened: level 96% and 99% (`ours`: 83% and 81%, better by 13 and
  17 points with intervals above 0), level85 89% and 93% (`ours`: 55% and 57%, better by 35 and 36 points).
- **Against grid:** better or equal at every budget in the level worlds on rule P (better by 33 and 7 points at 160k and 320k in level, 30 and 24 in level85),
  worse than grid on rule S at 40k-80k, equal after in level (level85 also worse at 640k).
- **Against random search:** better at 160k and above on rule P in both worlds; worse at 40k-80k in level85.
- **Against successive halving and the OCBA-style procedure it still trails at small budgets:** rule P, level: 40k and 80k worse by 16-32 points; level85: 40k-80k
  worse by 5-26 points. Reason: a verdict at the floors costs 25,000 trials per design and the baselines judge on whatever precision a small budget buys them
  (spread over 12 designs, 40k-80k is 3,300-6,700 trials a design, a precision the platform's own rules refuse); ours cannot lower that without loosening
  error control, so below about 100k it stays behind. At 160k: equal to both in both worlds. At 320k: equal to halving, 4 points below OCBA in level (interval
  [-7, -0], read mechanically as worse) and equal in level85. At 640k: equal in level, 5 and 7 points below halving and OCBA in level85 (worse).
- **Survival (the near-lottery world):** rule P 1-5% for every arm, ours2 included, and no arm differs from it on rule P except random at 80k-320k (ours2 higher by 4-5
  points); on rule S ours2 is better than halving from 80k and than random at 40k-160k, and worse than grid at 40k.
- **Rule S** (point estimates): ours2 is behind ours at 80k-160k in the level worlds (level 93% against 98% at 80k; level85 49% against 68% at 80k, 80% against 92% at
  160k) because it stops after the first design the verdict passes and so has judged fewer designs at the floors than `ours`' five finalists; at 640k in level85 it
  is 8 points below halving and OCBA (92% against 100%).
- **Not verified:** why level85 at 640k ends at 93% while budget remains (the stop reason of those runs is `acceptable_precision`; whether the missing 7% are
  designs held inconclusive by the re-run cap or truly infeasible by one standard error of the truth table was not measured: the benchmark rows keep the stop
  reason, not the allocation record). The agent arm (R16) is still the `--score-agent` slot. Update (controller decision): every new campaign now asks for the sequential allocation (`budget.allocation: 'sequential'`, written by the short form and
  so by every hosted default); with no explicit `budget.replicates` the budget is derived from `budget.cpuSeconds` and the CPU seconds per replicate the campaign measures
  (first completed unit, re-derived when a unit differs by 25%, recorded in the state and the stop record, `cpuSeconds` never exceeded). Stored manifests without the field keep
  their bytes and fixed stages. The `ours2` arm here states `budget.replicates` explicitly, so its behaviour at a stated budget is unchanged and no rerun was needed.

Verdict in one sentence: the structural cap is removed and the budgeted campaign now matches grid and the OCBA-style procedure from about 160k trials in the
level worlds while keeping every error-control rule, but it still trails successive halving and the OCBA-style procedure below that budget (and by 5-7 points
at 640k in level85), because their small-budget verdicts rest on precision the platform does not allow itself.


# Addendum X1 (2026-11-09): the re-runs' error is split across the looks, and what that costs

**What was wrong.** Addendum D5 said that error control is untouched and each design's bound stays exact. It did not. The domain's state machine, driven with binomial
outcomes for one design whose true value sits exactly on its bound (a type I error of 2.5% against a bound of 2.5%, or a power of 80% against 80%; 6,000 to 20,000
campaigns each), certified that design in 3.3% of campaigns with re-runs against 2.4% with one final run (`packages/domain/test/vcrBudgetedSearchErrorControl.test.mjs`
holds the experiment; on the old rule it reads 3.27% and 3.25%). A design gets up to three looks (`maxRounds` 2 plus the first) and passes if the look it ends on
passes; every look was read at the constraint's 97.5% confidence, so the confidence that "type I error is at most alpha" really holds fell to about 96.6%. The frozen
alpha was never touched; the confidence of the claim was.

**The fix.** In a budgeted campaign each final look is read at the constraint's error split across the looks (`vcrFinalConfidence`, Bonferroni): 1 - (1 - c) / 3,
99.17% for c = 97.5%. The chance that any look certifies a design at its bound is then at most 2.5%; the same experiment now certifies at most 2.5% (test). A fixed-structure
campaign (no `budget.replicates`, no sequential allocation) has one look and is read as before.

**The benchmark again**, same protocol, worlds, budgets and seeds 1..200 (`node evals/vcr-in-silico/search-benchmark-matched.mjs`, 67 s): the five other arms reproduce
their aggregate cells exactly (ours included: every cell that differs from D5 is an ours2 cell), and `ours2` changes. Data: `results/search-benchmark-matched-20261109-x1.json`, tables
`results/search-benchmark-matched-20261109-x1-tables.md`; the D5 files stay. Rule P, probability of correct selection at 40k / 80k / 160k / 320k / 640k trials:

| World | ours2 in D5 (3 looks at 97.5%) | ours2 now (looks at 99.17%) | grid | halving | OCBA |
|---|---|---|---|---|---|
| level | 6.5 / 27.0 / 80.5 / 96.0 / 98.5% | 2.5 / 15.0 / 73.0 / 94.0 / 95.5% | 5.5 / 21.5 / 48.0 / 89.0 / 99.0% | 22.0 / 54.5 / 86.0 / 97.0 / 100% | 27.5 / 59.0 / 86.0 / 99.5 / 100% |
| level85 | 1.0 / 6.5 / 57.0 / 89.0 / 93.0% | 0.5 / 4.5 / 44.5 / 72.0 / 83.0% | 3.5 / 7.5 / 27.0 / 65.5 / 90.5% | 14.0 / 32.0 / 61.5 / 85.5 / 98.0% | 5.5 / 22.0 / 55.0 / 91.5 / 100% |
| survival | 1.0 / 3.5 / 4.5 / 5.0 / 1.5% | 0.0 / 1.0 / 2.0 / 1.5 / 1.5% | 1.0 / 2.0 / 3.5 / 2.0 / 1.0% | 1.0 / 1.5 / 2.0 / 2.5 / 2.0% | 1.0 / 1.0 / 4.0 / 2.5 / 5.0% |

Where ours stands now, plainly: the price of a valid error control with re-runs is up to 17 points of correct selection (level85 at 320k: 72% against 89% before; at 640k 83% against 93%, where
halving and OCBA read 98 and 100%). In the level world ours2 is now below grid at 40k to 80k and above it at 160k to 320k (73% against 48%, 94% against 89%), but it trails
halving and OCBA at every budget up to 320k and is 3.5 points below grid at 640k (95.5% against 99.0%); in level85 it is above grid from 160k to 320k and below it at 640k. The picked design
violated a constraint in truth in 0% of the picks of ours2 at every budget in all three worlds (one 7.1% cell of level85 at 80k in D5 is 0% now). "Matches grid and
OCBA from about 160k" (D5) is withdrawn: it matches grid, and trails OCBA and halving. The tuning disclosure above applies to the cap, which this addendum did not re-choose;
the worlds are the ones it was chosen on, so the table is in-sample for the worlds. The recomputation check of the runner now reads ours2's looks at the same split
confidence; ours2's own verdict and that recomputation agree in 1,000 of 1,000 runs per world.


# Addendum D6 (2026-11-10): the screening share allocated by an OCBA-CO-style rule, and a held-out world

Protocol addendum D6 (`BENCHMARK-PROTOCOL.md`) was committed before the first search ran on the held-out world; everything above and in X1 stays as it was.
Data: `results/search-benchmark-matched-20261110-d6.json`, tables `…-d6-tables.md`, one SVG per world `…-<world>-d6.svg` (the held-out one included), 200 seeds
(1..200), seven arms, five budgets, four worlds (14,000 searches per world and arm set; 1,000 `ours3` runs per world; 67 s). **The earlier six arms on the three first worlds
reproduce the X1 result cell by cell (180 of 180 aggregate cells identical)**; the runner's rule-P recomputation of `ours3`'s own verdict disagreed in 0 of 1,000 runs in each of the four worlds.

**What `ours3` is.** `ours2` with `budget.screening = 'ocba'`: the same campaign, the same final verdict (fresh final run at or above the floor, each look at 99.17% confidence,
frozen alpha, `inconclusive_at_precision`), but the fifth of the budget that screening takes is spent by an OCBA-CO-style rule (Chen et al. 2000; Lee et al. 2012) over the
power cell **and** the type I error cell, instead of equally over the power cell alone. The paper's theorem could not be retrieved, so this is the structure of OCBA-CO written
for an exact objective (designs worse than the best screened-feasible one need nothing; the rest by (sigma / distance to the bound)^2), not a transcription. It is opt-in
and **not the product default** (the short form does not offer it and the hosted default is unchanged): whether to turn it on is the controller's decision.
A real engine check: a type I error screening unit of 400 replicates with the screening block runs on `design.simulate` and is labelled screening precision.

**Rule P (the platform's verdict), probability of correct selection at 40k / 80k / 160k / 320k / 640k trials (200 seeds):**

| World | ours2 | ours3 | grid | halving | OCBA |
|---|---|---|---|---|---|
| level (in-sample) | 2.5 / 15.0 / 73.0 / 94.0 / 95.5% | 13.5 / 38.5 / 79.0 / 97.0 / 95.5% | 5.5 / 21.5 / 48.0 / 89.0 / 99.0% | 22.0 / 54.5 / 86.0 / 97.0 / 100% | 27.5 / 59.0 / 86.0 / 99.5 / 100% |
| level85 (in-sample) | 0.5 / 4.5 / 44.5 / 72.0 / 83.0% | 2.0 / 19.5 / 49.0 / 70.5 / 81.5% | 3.5 / 7.5 / 27.0 / 65.5 / 90.5% | 14.0 / 32.0 / 61.5 / 85.5 / 98.0% | 5.5 / 22.0 / 55.0 / 91.5 / 100% |
| survival (in-sample) | 0.0 / 1.0 / 2.0 / 1.5 / 1.5% | 0.0 / 1.0 / 0.5 / 1.5 / 0.0% | 1.0 / 2.0 / 3.5 / 2.0 / 1.0% | 1.0 / 1.5 / 2.0 / 2.5 / 2.0% | 1.0 / 1.0 / 4.0 / 2.5 / 5.0% |
| **heldout (not tuned on)** | 0.0 / 9.5 / 64.5 / 91.5 / 97.5% | 6.5 / 47.0 / 71.0 / 95.5 / 94.0% | 1.5 / 2.5 / 13.0 / 40.0 / 74.0% | 6.0 / 21.5 / 47.0 / 69.5 / 83.0% | 2.0 / 6.0 / 18.5 / 35.0 / 66.5% |

Rule S, correct selection, `ours3` against `ours2`: level 77.0 / 94.0 / 99.0 / 100 / 100 against 64.5 / 94.0 / 99.5 / 100 / 100; level85 40.0 / 74.0 / 96.0 / 97.0 / 96.0 against 4.5 / 53.5 / 80.0 / 88.0 / 91.0
(with the share of picks that were truly infeasible at 70 / 15 / 11 / 11 / 9% for `ours2` and 14 / 4 / 2 / 3 / 4% for `ours3`); heldout 12.0 / 43.0 / 60.5 / 73.0 / 75.0 against 0.0 / 9.0 / 51.0 / 63.0 / 62.5.

**Read plainly.**
- Where the screening change helps: at small budgets, where screening decides which design gets the first 25,000-trial final evaluation. In the held-out world `ours3` is above `ours2`
  by 6.5 / 37.5 / 6.5 / 4.0 points up to 320k (the Newcombe interval of the difference is above 0 at 40k and 80k only; equal at 160k to 640k) and 3.5 points below it at 640k (94.0 against 97.5%, equal by that interval); it is above every other arm at 80k (47.0%, halving 21.5%),
  at 160k (71.0%, halving 47.0%), at 320k (95.5%, halving 69.5%) and at 640k (94.0%, halving 83.0%), with the Newcombe interval of the difference above 0 in each of those cells against halving
  (equal at 40k), against grid, OCBA and random at every budget. In the level world it is above `ours2` at 40k and 80k by that interval (13.5 / 38.5% against 2.5 / 15.0%; 79.0% against 73.0% at 160k is equal), equal after, and still
  below halving and OCBA at 40k and 80k and below grid at 640k (95.5% against 99.0%). In level85 it is above `ours2` at 80k and equal elsewhere on rule P, and below halving at every budget.
  In the survival world (one truly feasible design out of 15) nothing separates any arm from chance on rule P and `ours3` is not different from `ours2`.
- Where it does not: the price of a valid error control with re-runs (X1) is untouched and still shows at 640k, where `ours3` is 3.5 points below grid in level and 9 points below it in level85
  (81.5 against 90.5%) and 16 to 19 points below halving and OCBA there. Screening cannot buy that back; the final looks at 99.17% decide it.
- The picked design violated a constraint in truth in 0% of the picks of `ours3` under rule P in every world and budget but one: survival at 160k, where it picked in 2 of 200 seeds and one of the two picks was truly infeasible (survival has one truly feasible design and is below chance resolution for every arm).
- **The held-out result needs a caution.** One held-out world of 27 designs is one world. It has the feature the new screening reads (cheap designs that are powered and fail only the type I
  error), which is also what makes the level worlds' cheap designs expensive for `ours2`; I chose the world after seeing that mechanism in the in-sample worlds, though before any run on it,
  and its truth is a closed form and not calibrated against the engine. A world with no such trap would show less of the gain. The three first worlds are in-sample for the design of `ours3`
  (the disclosure in protocol addendum D6: one design change was made on their development seeds), as they were for the re-run cap (S16).
- Baselines' rule P reads their single-look data at 97.5%; `ours2`/`ours3` read each look at 99.17%. At equal budget that is less certifying power by design (S3), so the rule-P columns
  are not a like-for-like contest of allocation alone; rule S (same pick for every arm) is.
- No error-control rule was loosened: `test/vcrBudgetedSearchErrorControl.test.mjs` passes unchanged and its OCBA-screening twin (`vcrScreeningOcba.test.mjs`, a design exactly on its type I bound,
  1,500 campaigns) certifies at no more than 2.5% plus two standard errors. A screened type I error whose one-sided 97.5% Clopper–Pearson lower bound is above 2.5% now eliminates a design at
  screening in an OCBA campaign, as a screened power whose upper bound is below 80% always did; this can drop a design that is truly feasible (a false elimination, at most 2.5% per look), which
  costs the search a candidate and never certifies one.
- Not done: the agent arm (slot unchanged), a default for the hosted short form, the engine calibration of the held-out world.
