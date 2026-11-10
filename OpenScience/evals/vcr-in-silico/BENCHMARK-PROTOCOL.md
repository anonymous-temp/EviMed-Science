# Matched-budget search benchmark: frozen protocol (round-2 plan R36, §C.6 ability 2)

Frozen before the first result run. The script is `search-benchmark-matched.mjs` (same directory); a smoke run of 3 seeds was made while
writing it to check that it executes and that the domain's own verdict agrees with the benchmark's recomputation, and it is not a result.
Nothing below changes after a result is seen; a change would be a new protocol with a new RUN file.

## Question

At the same budget of simulated trials, does the platform's campaign find a design that meets fixed requirements as reliably as ordinary
alternatives: equal allocation, random search, successive halving on replicate count, and a two-stage OCBA-style procedure?
Richter, Friede & Rahnenfuhrer 2022 (Biometrical Journal 64:948) report Bayesian optimization about 20x faster than an exhaustive grid with no
random arm and no matched budget; Bayesian optimization is context only here (no GP package in the engine's lock). The agent-directed arm
(R16) is a slot (below), run later on the live harness.

## Worlds (what is searched, and the truth)

Every world is a design space of the 2026-11-07 benchmark, scored against its high-precision exhaustive results
(`results/search-benchmark-20261107.json`, every candidate at the domain floors: 5,000 replicates under the alternative, 20,000 under the
null). The script records that file's SHA-256. In a world, design i has `patients` (deterministic), a true power `p_i` and a true type I
error `q_i`, taken as exactly those estimates. **Limitation, stated up front:** each is one run's estimate (standard error about 0.5 points
for power, 0.11 for type I error), so a design whose true value sits within about a point of a bound is feasible or not by the luck of that one
run; the benchmark measures the searches in this defined world, not the engine's true rates. A design is *truly feasible* when `p_i >= bound`
and `q_i <= 2.5%`; the optimum is the fewest patients among the truly feasible.

| World | Space | Power bound | Designs | Truly feasible | Optimal |
| --- | --- | --- | --- | --- | --- |
| `survival` | patients/arm {100..200} x accrual {12, 18, 24} months, two-arm log-rank, HR 0.70 | 80% | 15 | 1 | 1 (400 patients) |
| `level` | patients/arm {200, 225, 250} x analysis level {2.5%, 2.35%, 2.2%, 2.0%}, 24 months | 80% | 12 | 11 | 4 (400) |
| `level85` | the same designs and truth table under a 85% power requirement | 85% | 12 | 7 | 3 (450) |

The analytic family (15 closed-form designs) is not benchmarked: its values are exact, so every arm that evaluates all designs picks the exact
optimum and there is no search noise to measure.

## Budget and trial accounting

Unit: simulated trials (one replicate under one truth). Budgets: 40,000, 80,000, 160,000, 320,000, 640,000. One full-precision evaluation of a
design is 25,000 trials (5,000 alternative + 20,000 null), so the exhaustive search costs 375,000 trials (survival) or 300,000 (level worlds).
A unit's outcome is a draw from Binomial(replicates, true rate) with a keyed random stream per (world, arm, budget, seed, unit), which is the
distribution of an engine rejection count over independent replicates. **Validation against the real engine** (below) is part of this protocol.
Arms never overspend; the table of trials actually spent is reported.

## Arms

Every baseline splits a design's trials 20% under the alternative (power) and 80% under the null (type I error), the floors' own ratio.

1. **grid**: equal allocation, B / (number of designs) trials to every design.
2. **random**: a random order of the designs (a keyed permutation), each at the full 25,000-trial precision until the next one does not fit.
3. **halving**: successive halving on replicate count: ceil(log2 K) rounds, each with B / rounds trials split equally over the survivors, estimates
   accumulating; after a round the better half (rounded up) survives, ranked by point-feasible first, then fewer patients, then the larger
   feasibility margin min(z_power, z_type I). The pick is made among the final survivors.
4. **ocba**: two-stage. Stage 1: 30% of B equally over all designs. Stage 2: the remaining 70% to the *critical* designs (those with at most as many
   patients as the smallest point-feasible design after stage 1, or all designs when none is point-feasible), over their two cells (power,
   type I error) in proportion to (sigma / max(|estimate - bound|, 0.005))^2, the OCBA allocation with an indifference floor of 0.5 points
   (Chen & Lee; Kim & Nelson 2001 for the indifference-zone idea). It is OCBA-style, simplified to one allocation step and two constraint
   cells; it is not an implementation of OCBA-CO.
5. **ours**: the platform's campaign exactly as it stands (`@evimed/domain` `vcrExperimentSearch`: screening at a low replicate count, the
   designs whose screened power is hopeless eliminated by the one-sided Clopper–Pearson bound, finalists ranked point-feasible first then by size,
   finalists evaluated at the floors, verdict by Clopper–Pearson bounds). The only things set from the budget are the two manifest parameters, by
   one frozen rule: finalists = min(5, max(1, floor(B / 26,667))); screening replicates = min(4,999, max(200, floor((B - finalists x 25,000) / K
   / 100) x 100)), alternative only. At B = 80,000 and K = 15 that is the 11-07 campaign (3 finalists, 300 replicates). The campaign cannot spend
   more than 5 x 25,000 + K x 4,999 trials, so its curve ends where its structure ends.
6. **agent** (slot, not run here): see below.

## Pick rules (frozen; both reported for every arm)

- **Rule S (point):** the fewest-patients design whose point estimates meet both constraints (ties: the lower index); a baseline considers every
  design it evaluated (halving: the survivors), ours its finalists' final estimates. Nothing picked when none qualifies.
- **Rule P (platform verdict):** the fewest-patients design for which both Clopper–Pearson bounds (the constraint's confidence, as the domain
  uses) pass: power's lower bound at or above its bound, type I error's upper bound at or below 2.5%. For ours this is the campaign's own best
  design (`vcrCampaignVerdict`); the script also recomputes it independently and reports any disagreement. Rule P is the platform's safety-first
  contract: in a world where a design's type I error sits at the bound it rarely passes anything, by design.

## Metrics (each arm x budget x world, 200 seeds numbered 1..200, rules S and P)

- **Probability of correct selection (PCS):** the pick is truly feasible and has the optimal patients; Wilson 95% interval.
- **Success within epsilon:** truly feasible and at most epsilon = 50 patients (one grid step) above the optimum.
- **Simple regret** (patients), median and IQR over seeds: pick's patients minus the optimum when truly feasible; **no pick, or a truly infeasible
  pick, scores the penalty regret** (largest patients in the space plus one step, minus the optimum). The objective is a deterministic function
  of the design, so "independent re-evaluation" of regret is exact in the world.
- **Budget to success within epsilon:** the smallest budget at which at least 80% of seeds succeed (or "not reached").
- **Constraint violation of the picked design** (of runs that picked): by truth, and after an independent re-evaluation of the pick at the floors
  (5,000 + 20,000 fresh trials, a violation when its point estimate misses either constraint). No-pick rate is reported separately.
- Ours against each baseline: the difference in PCS with a Newcombe 95% interval, read mechanically: better if the interval is above 0, worse if below, otherwise equal.

## Validation of the simulated world against the real engine (`--calibrate`, heavy lock, 2 cores)

The design 200 per arm, 24 months (survival world) on the real engine (`design.simulate` 1.5.0, `Rscript service/run_job.R`) with new seeds:
30 screening runs (300 replicates, alternative), 10 final alternative runs (5,000), 5 final null runs (20,000). Criteria, fixed now: the standard
deviation of the engine's estimates divided by the binomial standard deviation sqrt(p(1-p)/replicates) lies in [0.8, 1.25] for each case; and
the engine's mean differs from the table value by at most 3 combined standard errors (the engine mean's own, and the table value's from its 5,000 or
20,000 replicates). A failure is reported in the RUN file as a limit of the simulated world and not repaired by changing the benchmark.

## The agent arm's slot (R16)

Run on the live harness with the same worlds, constraints and budgets: a hosted campaign started from a conversation over the same candidates,
with `budget.cpuSeconds` set to the engine seconds that correspond to the trial budget (25,000 trials is one full-precision unit pair; the
11-07 JSON records the engine seconds per unit), and `budget.modelCalls` stated; export the campaign view and score it:

```
node OpenScience/evals/vcr-in-silico/search-benchmark-matched.mjs --score-agent <campaign-view.json> --world survival|level|level85 [--trials <n>]
```

It reports the same pick category, regret and violation (rule P: the campaign's best design) and the trials spent; the agent run is compared with
the arms at the nearest budget in the RUN file's tables, with at least three samples per world as the live harness allows.

## Reading the result

The RUN file states, per world and budget, where ours is better, equal or worse than each baseline on PCS, regret and violation under both rules, and
which arm needs the least budget to reach success within epsilon. It claims nothing the table does not show, in particular nothing about the engine's
true rates and nothing about arms or budgets not run.

## Addendum D5 (2026-11-09, after the first result run; the frozen text above is unchanged)

Arm 7, **ours2**, is `ours` with `budget.replicates = B` and the stage sizes of `vcrCampaignBudgetPlan` (screening takes a fifth of B, below the floor,
alternative case; one finalist in the first wave); the rest of B is allocated by the domain's sequential rule (`VCR_ALLOCATION`, see the RUN file's D5
addendum). Same worlds, budgets, seeds 1..200, pick rules, metrics and reading as above; the original five arms are re-run unchanged and must reproduce the first run
byte for byte (they do: 150 of 150 cells). Development of the rule used seeds 1001..1100 (`--seed-from`), never reported; `--arms` runs a subset of arms for such a
development run. A unit of ours2 may carry its own `replicates` (a fresh re-run of a final evaluation); the simulated world draws it exactly like any other unit.

The product default (2026-11-09, controller) derives the same budget from `budget.cpuSeconds` and a measured CPU rate when `budget.replicates` is absent; `ours2` states the replicate budget directly, so this addendum's numbers do not change.

## Addendum D6 (2026-11-10, written and committed before the first search was run on the held-out world; the text above is unchanged)

**Why.** After X1 the campaign (`ours2`) matched grid but trailed the OCBA-style and halving arms at most budgets. The reading of the RUN file is that the loss is in
*which* design the final evaluations are spent on: screening looks at power alone, so a cheap design that is powered but fails its type I error looks as good as one
that passes, and the sequential final stage then spends 25,000 trials on it. Screening was an equal split of a fifth of the budget.

**Arm 8, `ours3`:** `ours2` with `budget.screening = 'ocba'` (domain `screeningIncrement`): the campaign's screening share (a fifth of B, as before) is allocated by an
OCBA-CO-style rule instead of equally. (1) First look: `ocba.firstShare` = 0.5 of the screening share, equally over the designs and over **both** constraint cells (power under
the alternative, type I error under the null; the cell size is `floor(0.5 x 0.2 B / K / 2 / 100) x 100`, at least 200). (2) Then, one unit at a time, the rest in
steps of at most 1/`ocba.steps` = 1/4 of what remains: the cheapest design whose point estimates meet every screened constraint is b; the designs with at most b's patients
are critical (all designs when none meets), each on its dominant cell (a feasible one on its hardest constraint, an infeasible one on its most clearly violated); the
unit goes to the cell furthest below its OCBA target share w_i / sum w, w_i = sigma_i^2 / max(|estimate - bound|, 0.005)^2 with the smoothed estimate (k + 1/2) / (n + 1)
and 0.005 as the indifference zone. A design more expensive than b is dominated for free because patients are exact. Screening increments are pooled into the design's
screening estimate; a screening estimate still never certifies, and a type I error screened above its bound by the one-sided Clopper-Pearson interval eliminates a design
exactly as a screened power below its bound already did; the screened error-control estimate otherwise ranks only. The sources for the rule: Chen et al. 2000 (OCBA) and
Lee, Pujowidianto, Li, Chen & Yap 2012 (OCBA-CO, IEEE TAC 57:2940). The paper's theorem could not be retrieved from the web here, so the ratios are the structure of
OCBA-CO written for an exact objective and one-sided proportions, not a transcription of its formulas; the arm is called OCBA-CO-style and nothing is claimed for the
paper's optimality.

**The final verdict is untouched:** a fresh final run at or above the floor, each look read at `1 - (1 - c)/(maxRounds + 1)`, frozen alpha, `inconclusive_at_precision`.
`test/vcrBudgetedSearchErrorControl.test.mjs` (the S3 state machine) and the same test under OCBA screening (`vcrScreeningOcba.test.mjs`) hold.

**Parameter choice, disclosed.** `firstShare` 0.5, `steps` 4 and the 0.005 indifference were written before any run. Development used seeds 1001..1100 of the three existing worlds
only (never reported, never the held-out world): a first version that screened the power cell alone gave no gain over `ours2`; a version whose screening also looked at the type I
error cell and ranked finalists by it gave the gain; three alternative settings (firstShare 0.3 / 0.7, steps 8) differed from 0.5 / 4 by less than the seed noise, so 0.5 / 4 stayed.
The three existing worlds are therefore in-sample for the *design* of `ours3`, as they were for the re-run cap (review S16).

**Held-out world `heldout` (frozen now).** An exact closed-form truth table, `heldout-world.R` -> `results/search-benchmark-heldout-world-20261110.tsv`
(SHA-256 `6e18fcd79de51ef12293ed8876cb3d370ef11a61c25b9bbae0ed2148251b4a4c`): a two-arm comparison of means, SD 1, true difference 0.5, one-sided test of the pooled-variance t statistic against the **normal** critical value z(1 - alpha),
so the type I error is P(T_{2n-2} > z) and exceeds alpha at every size; power is the noncentral t tail. Designs: n per arm 40, 45, ..., 80 (total patients 80..160) x analysis
alpha {0.025, 0.02, 0.015}, 27 designs, power requirement 80%, type I error at most 2.5%. By the table 5 designs are truly feasible and one is optimal (140 patients, alpha 0.02,
power 0.816, type I error 0.0209); no design at alpha 0.025 is feasible (type I 0.0258-0.0268). No part of the table is an estimate, so its feasibility is exact; unlike
the first three worlds nothing was tuned on it and no search had been run on it when this was written. It is **not calibrated against the real engine** (the first world's
`--calibrate` is the only engine check) and the manifest shell is the level family's (nothing in a search reads the endpoint; a unit's outcome is a draw from the truth table).
Budgets, seeds 1..200, pick rules, metrics and reading are those above, for every arm; the earlier arms re-run on the three first worlds must reproduce the previous result file.
