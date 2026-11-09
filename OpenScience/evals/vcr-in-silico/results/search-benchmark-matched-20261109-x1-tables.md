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
| ours2 | 22.0% [16.8%, 28.2%] | 41.0% [34.4%, 47.9%] | 36.5% [30.1%, 43.4%] | 44.5% [37.8%, 51.4%] | 44.5% [37.8%, 51.4%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 39.5% | 43.5% | 45.5% | 44.0% |
| random | 3.0% | 10.5% | 20.0% | 34.5% | 40.0% |
| halving | 19.0% | 19.5% | 21.0% | 26.0% | 21.5% |
| ocba | 28.5% | 33.0% | 42.5% | 42.5% | 53.5% |
| ours | 14.0% | 50.0% | 47.0% | 46.5% | 44.5% |
| ours2 | 22.0% | 41.0% | 36.5% | 44.5% | 44.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (0–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (50–50) |
| ocba | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 0 (0–50) |
| ours | 50 (50–50) | 25 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| ours2 | 50 (50–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 29.5% | 32.0% | 30.5% | 35.0% | 38.0% |
| random | 94.5% | 85.0% | 73.5% | 50.5% | 41.0% |
| halving | 76.5% | 78.0% | 74.5% | 71.5% | 77.5% |
| ocba | 28.0% | 37.0% | 27.5% | 34.0% | 32.5% |
| ours | 70.5% | 33.5% | 32.5% | 31.5% | 34.0% |
| ours2 | 66.5% | 41.5% | 42.5% | 35.0% | 37.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.8% / 63.8% | 41.9% / 62.5% | 37.4% / 56.8% | 30.0% / 56.2% | 29.0% / 45.2% |
| random | 45.5% / 81.8% | 30.0% / 50.0% | 24.5% / 58.5% | 30.3% / 53.5% | 32.2% / 56.8% |
| halving | 19.1% / 61.7% | 11.4% / 54.5% | 17.6% / 49.0% | 8.8% / 54.4% | 4.4% / 57.8% |
| ocba | 60.4% / 61.8% | 47.6% / 65.9% | 41.4% / 53.1% | 35.6% / 56.8% | 20.7% / 51.9% |
| ours | 52.5% / 62.7% | 24.8% / 45.1% | 30.4% / 57.0% | 32.1% / 57.7% | 32.6% / 54.5% |
| ours2 | 34.3% / 50.7% | 29.9% / 64.1% | 36.5% / 53.0% | 31.5% / 59.2% | 29.4% / 56.3% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached, ours2 not reached

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% [0.3%, 3.6%] | 2.0% [0.8%, 5.0%] | 3.5% [1.7%, 7.0%] | 2.0% [0.8%, 5.0%] | 1.0% [0.3%, 3.6%] |
| random | 0.0% [0.0%, 1.9%] | 0.0% [0.0%, 1.9%] | 0.5% [0.1%, 2.8%] | 0.0% [0.0%, 1.9%] | 4.0% [2.0%, 7.7%] |
| halving | 1.0% [0.3%, 3.6%] | 1.5% [0.5%, 4.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 2.0% [0.8%, 5.0%] |
| ocba | 1.0% [0.3%, 3.6%] | 1.0% [0.3%, 3.6%] | 4.0% [2.0%, 7.7%] | 2.5% [1.1%, 5.7%] | 5.0% [2.7%, 9.0%] |
| ours | 1.0% [0.3%, 3.6%] | 4.5% [2.4%, 8.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 3.5% [1.7%, 7.0%] |
| ours2 | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 2.0% [0.8%, 5.0%] | 1.5% [0.5%, 4.3%] | 1.5% [0.5%, 4.3%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% | 2.0% | 3.5% | 2.0% | 1.0% |
| random | 0.0% | 0.0% | 0.5% | 0.0% | 4.0% |
| halving | 1.0% | 1.5% | 2.0% | 2.5% | 2.0% |
| ocba | 1.0% | 1.0% | 4.0% | 2.5% | 5.0% |
| ours | 1.0% | 4.5% | 2.0% | 2.5% | 3.5% |
| ours2 | 0.0% | 1.0% | 2.0% | 1.5% | 1.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ocba | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours2 | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 99.0% | 98.0% | 96.5% | 98.0% | 99.0% |
| random | 100.0% | 100.0% | 99.5% | 100.0% | 96.0% |
| halving | 99.0% | 98.5% | 98.0% | 97.5% | 98.0% |
| ocba | 99.0% | 99.0% | 95.5% | 97.5% | 95.0% |
| ours | 99.0% | 95.5% | 98.0% | 97.5% | 96.0% |
| ours2 | 100.0% | 99.0% | 98.0% | 98.5% | 98.5% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 50.0% | 0.0% / 25.0% | 0.0% / 28.6% | 0.0% / 50.0% | 0.0% / 0.0% |
| random | n/a / n/a | n/a / n/a | 0.0% / 0.0% | n/a / n/a | 0.0% / 12.5% |
| halving | 0.0% / 100.0% | 0.0% / 66.7% | 0.0% / 50.0% | 0.0% / 80.0% | 0.0% / 100.0% |
| ocba | 0.0% / 50.0% | 0.0% / 50.0% | 11.1% / 33.3% | 0.0% / 60.0% | 0.0% / 40.0% |
| ours | 0.0% / 50.0% | 0.0% / 66.7% | 0.0% / 75.0% | 0.0% / 60.0% | 12.5% / 50.0% |
| ours2 | n/a / n/a | 0.0% / 0.0% | 0.0% / 75.0% | 0.0% / 33.3% | 0.0% / 33.3% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached, ours2 not reached

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 375k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 40k | 80k | 110k | 125k | 125k |
| ours2 | 38k | 70k | 117k | 143k | 157k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-24 pts [-32, -15]) | better (10 pts [1, 20]) | equal (3 pts [-6, 13]) | equal (1 pts [-9, 11]) | equal (1 pts [-9, 10]) |
| random | better (11 pts [6, 17]) | better (40 pts [31, 47]) | better (27 pts [18, 36]) | better (12 pts [2, 21]) | equal (4 pts [-5, 14]) |
| halving | equal (-5 pts [-12, 2]) | better (31 pts [21, 39]) | better (26 pts [17, 35]) | better (21 pts [11, 29]) | better (23 pts [14, 32]) |
| ocba | worse (-14 pts [-22, -7]) | better (17 pts [7, 26]) | equal (4 pts [-5, 14]) | equal (4 pts [-6, 14]) | equal (-9 pts [-19, 1]) |
| ours2 | worse (-8 pts [-15, -0]) | equal (9 pts [-1, 19]) | better (10 pts [1, 20]) | equal (2 pts [-8, 12]) | equal (0 pts [-10, 10]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (-2 pts [-5, 2]) | equal (1 pts [-3, 4]) | equal (3 pts [-1, 6]) |
| random | equal (1 pts [-1, 4]) | better (5 pts [2, 8]) | equal (2 pts [-1, 5]) | better (3 pts [0, 6]) | equal (-0 pts [-5, 4]) |
| halving | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (0 pts [-3, 3]) | equal (0 pts [-4, 4]) | equal (2 pts [-2, 5]) |
| ocba | equal (0 pts [-3, 3]) | better (3 pts [0, 7]) | equal (-2 pts [-6, 2]) | equal (0 pts [-4, 4]) | equal (-2 pts [-6, 3]) |
| ours2 | equal (1 pts [-1, 4]) | better (3 pts [0, 7]) | equal (0 pts [-3, 3]) | equal (1 pts [-2, 4]) | equal (2 pts [-1, 6]) |

Check: ours's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours's stop reasons: 40k inconclusive_at_precision x168; 40k no_feasible_beneficial_candidate x30; 40k acceptable_precision x2; 80k inconclusive_at_precision x190; 80k no_feasible_beneficial_candidate x1; 80k acceptable_precision x9; 160k inconclusive_at_precision x196; 160k acceptable_precision x4; 320k inconclusive_at_precision x194; 320k acceptable_precision x5; 320k no_feasible_beneficial_candidate x1; 640k inconclusive_at_precision x191; 640k acceptable_precision x8; 640k no_feasible_beneficial_candidate x1.


**ours2 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-16 pts [-24, -7]) | equal (1 pts [-8, 11]) | equal (-7 pts [-16, 3]) | equal (-1 pts [-11, 9]) | equal (1 pts [-9, 10]) |
| random | better (19 pts [13, 25]) | better (31 pts [22, 38]) | better (16 pts [8, 25]) | better (10 pts [0, 19]) | equal (4 pts [-5, 14]) |
| halving | equal (3 pts [-5, 11]) | better (21 pts [13, 30]) | better (16 pts [7, 24]) | better (19 pts [9, 27]) | better (23 pts [14, 32]) |
| ocba | equal (-6 pts [-15, 2]) | equal (8 pts [-1, 17]) | equal (-6 pts [-15, 4]) | equal (2 pts [-8, 12]) | equal (-9 pts [-19, 1]) |
| ours | better (8 pts [0, 15]) | equal (-9 pts [-19, 1]) | worse (-10 pts [-20, -1]) | equal (-2 pts [-12, 8]) | equal (0 pts [-10, 10]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-1 pts [-4, 1]) | equal (-1 pts [-4, 2]) | equal (-2 pts [-5, 2]) | equal (-1 pts [-4, 3]) | equal (0 pts [-2, 3]) |
| random | equal (0 pts [-2, 2]) | equal (1 pts [-1, 4]) | equal (2 pts [-1, 5]) | equal (2 pts [-1, 4]) | equal (-3 pts [-6, 1]) |
| halving | equal (-1 pts [-4, 1]) | equal (-0 pts [-3, 2]) | equal (0 pts [-3, 3]) | equal (-1 pts [-4, 2]) | equal (-1 pts [-4, 3]) |
| ocba | equal (-1 pts [-4, 1]) | equal (0 pts [-3, 3]) | equal (-2 pts [-6, 2]) | equal (-1 pts [-4, 2]) | equal (-4 pts [-8, 0]) |
| ours | equal (-1 pts [-4, 1]) | worse (-3 pts [-7, -0]) | equal (0 pts [-3, 3]) | equal (-1 pts [-4, 2]) | equal (-2 pts [-6, 1]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x199; 40k inconclusive_at_precision x1; 80k inconclusive_at_precision x70; 80k budget_exhausted x129; 80k acceptable_precision x1; 160k inconclusive_at_precision x149; 160k budget_exhausted x47; 160k acceptable_precision x4; 320k inconclusive_at_precision x189; 320k acceptable_precision x3; 320k budget_exhausted x8; 640k inconclusive_at_precision x197; 640k acceptable_precision x3.

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
| ours2 | 64.5% [57.7%, 70.8%] | 94.0% [89.8%, 96.5%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| random | 51.5% | 92.0% | 99.0% | 100.0% | 100.0% |
| halving | 98.0% | 99.5% | 100.0% | 100.0% | 100.0% |
| ocba | 99.5% | 100.0% | 100.0% | 100.0% | 100.0% |
| ours | 61.5% | 97.5% | 100.0% | 100.0% | 100.0% |
| ours2 | 64.5% | 94.0% | 99.5% | 100.0% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 0 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 0 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 19.5% | 0.0% | 0.0% | 0.0% | 0.0% |
| halving | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 38.5% | 2.5% | 0.0% | 0.0% | 0.0% |
| ours2 | 35.5% | 6.0% | 0.5% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 22.0% | 0.0% / 20.0% | 0.0% / 21.0% | 0.0% / 26.0% | 0.0% / 38.5% |
| random | 0.0% / 9.9% | 0.0% / 15.5% | 0.5% / 16.5% | 0.0% / 29.0% | 0.0% / 26.5% |
| halving | 1.5% / 13.0% | 0.0% / 17.0% | 0.0% / 10.5% | 0.0% / 7.0% | 0.0% / 7.0% |
| ocba | 0.5% / 27.5% | 0.0% / 28.0% | 0.0% / 25.0% | 0.0% / 28.5% | 0.0% / 28.0% |
| ours | 0.0% / 39.8% | 0.0% / 26.7% | 0.0% / 34.5% | 0.0% / 17.5% | 0.0% / 27.0% |
| ours2 | 0.0% / 42.6% | 0.0% / 31.9% | 0.0% / 27.6% | 0.0% / 22.5% | 0.0% / 26.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 40k, random 80k, halving 40k, ocba 40k, ours 80k, ours2 80k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 5.5% [3.1%, 9.6%] | 21.5% [16.4%, 27.7%] | 48.0% [41.2%, 54.9%] | 89.0% [83.9%, 92.6%] | 99.0% [96.4%, 99.7%] |
| random | 10.0% [6.6%, 14.9%] | 30.0% [24.1%, 36.7%] | 45.5% [38.7%, 52.4%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] |
| halving | 22.0% [16.8%, 28.2%] | 54.5% [47.6%, 61.3%] | 86.0% [80.5%, 90.1%] | 97.0% [93.6%, 98.6%] | 100.0% [98.1%, 100.0%] |
| ocba | 27.5% [21.8%, 34.1%] | 59.0% [52.1%, 65.6%] | 86.0% [80.5%, 90.1%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] |
| ours | 4.0% [2.0%, 7.7%] | 33.5% [27.3%, 40.3%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] | 81.0% [75.0%, 85.8%] |
| ours2 | 2.5% [1.1%, 5.7%] | 15.0% [10.7%, 20.6%] | 73.0% [66.5%, 78.7%] | 94.0% [89.8%, 96.5%] | 95.5% [91.7%, 97.6%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.0% | 66.0% | 95.5% | 100.0% | 100.0% |
| random | 25.5% | 59.0% | 83.5% | 99.5% | 100.0% |
| halving | 52.5% | 78.0% | 97.0% | 99.5% | 100.0% |
| ocba | 32.5% | 67.0% | 92.5% | 100.0% | 100.0% |
| ours | 4.0% | 33.5% | 82.5% | 83.5% | 81.0% |
| ours2 | 2.5% | 15.0% | 73.0% | 96.5% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–150) | 50 (50–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| random | 150 (50–150) | 50 (0–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| halving | 50 (50–150) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 150 (0–150) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 150 (150–150) | 150 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 150 (150–150) | 150 (150–150) | 0 (0–150) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 13.0% | 0.0% | 0.0% | 0.0% |
| random | 59.5% | 18.5% | 5.0% | 0.0% | 0.0% |
| halving | 46.0% | 21.5% | 3.0% | 0.5% | 0.0% |
| ocba | 50.0% | 21.5% | 3.5% | 0.0% | 0.0% |
| ours | 96.0% | 66.5% | 17.5% | 16.5% | 19.0% |
| ours2 | 97.5% | 85.0% | 27.0% | 3.5% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.8% / 9.6% | 0.6% / 6.3% | 0.0% / 2.0% | 0.0% / 6.0% | 0.0% / 5.0% |
| random | 0.0% / 4.9% | 0.0% / 4.3% | 0.0% / 3.7% | 0.0% / 1.0% | 0.0% / 4.0% |
| halving | 0.0% / 5.6% | 0.0% / 2.5% | 0.0% / 2.6% | 0.0% / 2.0% | 0.0% / 7.5% |
| ocba | 2.0% / 8.0% | 0.6% / 8.3% | 0.0% / 6.7% | 0.0% / 5.0% | 0.0% / 7.5% |
| ours | 0.0% / 37.5% | 0.0% / 16.4% | 0.0% / 3.6% | 0.0% / 7.2% | 0.0% / 6.2% |
| ours2 | 0.0% / 20.0% | 0.0% / 16.7% | 0.0% / 4.1% | 0.0% / 6.7% | 0.0% / 5.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 160k, ours 160k, ours2 320k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |
| ours2 | 37k | 71k | 136k | 165k | 182k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| random | better (36 pts [26, 44]) | better (29 pts [22, 35]) | better (8 pts [5, 13]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| halving | worse (-22 pts [-30, -13]) | better (6 pts [2, 11]) | better (5 pts [1, 8]) | equal (1 pts [-1, 3]) | equal (0 pts [-2, 2]) |
| ocba | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours2 | equal (-3 pts [-12, 6]) | equal (4 pts [-1, 8]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-6, 3]) | better (12 pts [3, 21]) | better (33 pts [24, 41]) | equal (-6 pts [-13, 1]) | worse (-18 pts [-24, -13]) |
| random | worse (-6 pts [-11, -1]) | equal (4 pts [-6, 13]) | better (36 pts [26, 44]) | equal (2 pts [-6, 10]) | equal (-2 pts [-10, 6]) |
| halving | worse (-18 pts [-25, -12]) | worse (-21 pts [-30, -11]) | equal (-5 pts [-12, 2]) | worse (-14 pts [-20, -8]) | worse (-19 pts [-25, -14]) |
| ocba | worse (-24 pts [-30, -17]) | worse (-25 pts [-35, -16]) | equal (-5 pts [-12, 2]) | worse (-17 pts [-22, -11]) | worse (-19 pts [-25, -14]) |
| ours2 | equal (2 pts [-2, 5]) | better (19 pts [10, 27]) | equal (8 pts [-0, 16]) | worse (-11 pts [-17, -5]) | worse (-14 pts [-21, -8]) |

Check: ours's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours's stop reasons: 40k inconclusive_at_precision x191; 40k acceptable_precision x8; 40k no_feasible_beneficial_candidate x1; 80k acceptable_precision x67; 80k inconclusive_at_precision x133; 160k acceptable_precision x165; 160k inconclusive_at_precision x35; 320k acceptable_precision x167; 320k inconclusive_at_precision x33; 640k acceptable_precision x162; 640k inconclusive_at_precision x38.


**ours2 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-35 pts [-41, -28]) | worse (-6 pts [-10, -2]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| random | better (39 pts [29, 47]) | better (25 pts [18, 32]) | better (8 pts [5, 13]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| halving | worse (-19 pts [-27, -10]) | equal (3 pts [-2, 8]) | better (5 pts [1, 8]) | equal (1 pts [-1, 3]) | equal (0 pts [-2, 2]) |
| ocba | worse (-35 pts [-41, -28]) | worse (-6 pts [-10, -2]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours | equal (3 pts [-6, 12]) | equal (-4 pts [-8, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-3 pts [-7, 1]) | equal (-7 pts [-14, 1]) | better (25 pts [15, 34]) | equal (5 pts [-1, 11]) | worse (-4 pts [-7, -0]) |
| random | worse (-8 pts [-13, -3]) | worse (-15 pts [-23, -7]) | better (27 pts [18, 36]) | better (13 pts [7, 20]) | better (13 pts [7, 19]) |
| halving | worse (-20 pts [-26, -13]) | worse (-40 pts [-47, -31]) | worse (-13 pts [-21, -5]) | equal (-3 pts [-7, 1]) | worse (-5 pts [-8, -2]) |
| ocba | worse (-25 pts [-32, -18]) | worse (-44 pts [-52, -35]) | worse (-13 pts [-21, -5]) | worse (-6 pts [-10, -2]) | worse (-5 pts [-8, -2]) |
| ours | equal (-2 pts [-5, 2]) | worse (-19 pts [-27, -10]) | equal (-8 pts [-16, 0]) | better (11 pts [5, 17]) | better (14 pts [8, 21]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x195; 40k acceptable_precision x5; 80k budget_exhausted x170; 80k acceptable_precision x30; 160k acceptable_precision x146; 160k budget_exhausted x54; 320k acceptable_precision x193; 320k budget_exhausted x7; 640k acceptable_precision x200.

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
| ours2 | 4.5% [2.4%, 8.3%] | 53.5% [46.6%, 60.3%] | 80.0% [73.9%, 85.0%] | 88.0% [82.8%, 91.8%] | 91.0% [86.2%, 94.2%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 68.5% | 71.5% | 84.5% | 91.5% | 99.0% |
| random | 61.5% | 90.5% | 93.0% | 91.5% | 89.0% |
| halving | 92.5% | 95.5% | 100.0% | 100.0% | 100.0% |
| ocba | 69.0% | 73.0% | 77.5% | 93.0% | 99.5% |
| ours | 0.0% | 68.0% | 91.5% | 92.5% | 90.0% |
| ours2 | 4.5% | 53.5% | 80.5% | 88.0% | 91.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 100 (100–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 38.0% | 5.5% | 1.0% | 0.0% | 0.0% |
| halving | 1.5% | 1.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 89.0% | 26.5% | 0.0% | 0.0% | 0.0% |
| ours2 | 85.0% | 37.0% | 10.0% | 1.5% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 31.5% / 45.0% | 28.5% / 36.0% | 15.5% / 27.5% | 8.5% / 25.0% | 1.0% / 24.5% |
| random | 0.8% / 11.3% | 4.2% / 20.1% | 6.1% / 24.2% | 8.5% / 31.5% | 11.0% / 28.0% |
| halving | 6.1% / 17.8% | 3.5% / 15.2% | 0.0% / 8.5% | 0.0% / 10.5% | 0.0% / 10.0% |
| ocba | 31.0% / 42.5% | 27.0% / 41.5% | 22.5% / 33.5% | 7.0% / 27.0% | 0.5% / 23.0% |
| ours | 100.0% / 95.5% | 7.5% / 25.2% | 8.5% / 25.5% | 7.5% / 24.0% | 10.0% / 27.5% |
| ours2 | 70.0% / 76.7% | 15.1% / 38.9% | 10.6% / 31.7% | 10.7% / 26.4% | 9.0% / 25.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 160k, random 80k, halving 40k, ocba 320k, ours 160k, ours2 160k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 3.5% [1.7%, 7.0%] | 7.5% [4.6%, 12.0%] | 27.0% [21.3%, 33.5%] | 65.5% [58.7%, 71.7%] | 90.5% [85.6%, 93.8%] |
| random | 7.5% [4.6%, 12.0%] | 13.5% [9.4%, 18.9%] | 30.5% [24.5%, 37.2%] | 58.0% [51.1%, 64.6%] | 56.5% [49.6%, 63.2%] |
| halving | 14.0% [9.9%, 19.5%] | 32.0% [25.9%, 38.8%] | 61.5% [54.6%, 68.0%] | 85.5% [80.0%, 89.7%] | 98.0% [95.0%, 99.2%] |
| ocba | 5.5% [3.1%, 9.6%] | 22.0% [16.8%, 28.2%] | 55.0% [48.1%, 61.7%] | 91.5% [86.8%, 94.6%] | 100.0% [98.1%, 100.0%] |
| ours | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 53.5% [46.6%, 60.3%] | 54.5% [47.6%, 61.3%] | 57.5% [50.6%, 64.1%] |
| ours2 | 0.5% [0.1%, 2.8%] | 4.5% [2.4%, 8.3%] | 44.5% [37.8%, 51.4%] | 72.0% [65.4%, 77.8%] | 83.0% [77.2%, 87.6%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.0% | 73.5% | 98.0% | 100.0% | 100.0% |
| random | 26.5% | 54.5% | 80.5% | 100.0% | 99.0% |
| halving | 56.0% | 76.0% | 90.0% | 96.5% | 99.5% |
| ocba | 16.0% | 42.5% | 78.5% | 97.5% | 100.0% |
| ours | 0.0% | 1.0% | 56.0% | 56.5% | 61.0% |
| ours2 | 0.5% | 4.5% | 45.0% | 81.0% | 99.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) |
| random | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–50) |
| halving | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ocba | 100 (100–100) | 100 (50–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 100 (100–100) | 0 (0–100) | 0 (0–100) | 0 (0–100) |
| ours2 | 100 (100–100) | 100 (100–100) | 100 (0–100) | 0 (0–50) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 53.5% | 26.5% | 2.0% | 0.0% | 0.0% |
| random | 73.5% | 45.5% | 19.5% | 0.0% | 1.0% |
| halving | 43.5% | 24.0% | 10.0% | 3.5% | 0.5% |
| ocba | 83.5% | 57.0% | 20.5% | 2.5% | 0.0% |
| ours | 100.0% | 99.0% | 44.0% | 43.5% | 39.0% |
| ours2 | 99.5% | 95.5% | 55.0% | 19.0% | 0.5% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.1% / 2.2% | 0.0% / 3.4% | 0.0% / 6.6% | 0.0% / 7.0% | 0.0% / 9.0% |
| random | 0.0% / 1.9% | 0.0% / 3.7% | 0.0% / 3.7% | 0.0% / 5.0% | 0.0% / 5.6% |
| halving | 0.9% / 4.4% | 0.0% / 3.9% | 0.0% / 2.2% | 0.0% / 3.6% | 0.0% / 7.0% |
| ocba | 3.0% / 12.1% | 1.2% / 9.3% | 1.3% / 10.1% | 0.0% / 7.2% | 0.0% / 7.5% |
| ours | n/a / n/a | 0.0% / 50.0% | 0.0% / 8.9% | 0.0% / 2.7% | 0.0% / 6.6% |
| ours2 | 0.0% / 0.0% | 0.0% / 11.1% | 0.0% / 3.3% | 0.0% / 2.5% | 0.0% / 2.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 320k, ours not reached, ours2 320k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |
| ours2 | 37k | 71k | 148k | 232k | 229k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-61 pts [-67, -54]) | equal (-2 pts [-11, 7]) | better (8 pts [1, 14]) | equal (1 pts [-5, 6]) | worse (-9 pts [-14, -5]) |
| random | worse (-32 pts [-39, -26]) | better (13 pts [3, 22]) | better (15 pts [7, 22]) | equal (1 pts [-5, 6]) | equal (1 pts [-5, 7]) |
| halving | worse (-61 pts [-67, -53]) | equal (-6 pts [-15, 2]) | equal (5 pts [-1, 11]) | equal (-2 pts [-8, 3]) | worse (-10 pts [-15, -6]) |
| ocba | worse (-64 pts [-70, -56]) | equal (-4 pts [-13, 4]) | better (14 pts [7, 21]) | equal (-1 pts [-6, 4]) | worse (-9 pts [-14, -5]) |
| ours2 | worse (-5 pts [-8, -2]) | better (15 pts [5, 24]) | better (12 pts [5, 18]) | equal (4 pts [-2, 10]) | equal (-1 pts [-7, 5]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-4 pts [-7, -1]) | worse (-7 pts [-11, -3]) | better (27 pts [17, 35]) | worse (-11 pts [-20, -1]) | worse (-33 pts [-41, -25]) |
| random | worse (-8 pts [-12, -4]) | worse (-13 pts [-18, -8]) | better (23 pts [13, 32]) | equal (-3 pts [-13, 6]) | equal (1 pts [-9, 11]) |
| halving | worse (-14 pts [-19, -9]) | worse (-31 pts [-38, -24]) | equal (-8 pts [-17, 2]) | worse (-31 pts [-39, -22]) | worse (-41 pts [-48, -33]) |
| ocba | worse (-6 pts [-10, -2]) | worse (-21 pts [-27, -15]) | equal (-2 pts [-11, 8]) | worse (-37 pts [-45, -29]) | worse (-43 pts [-49, -36]) |
| ours2 | equal (-1 pts [-3, 1]) | worse (-3 pts [-7, -0]) | equal (9 pts [-1, 19]) | worse (-17 pts [-27, -8]) | worse (-26 pts [-34, -17]) |

Check: ours's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours's stop reasons: 40k inconclusive_at_precision x140; 40k no_feasible_beneficial_candidate x60; 80k inconclusive_at_precision x197; 80k no_feasible_beneficial_candidate x1; 80k acceptable_precision x2; 160k inconclusive_at_precision x88; 160k acceptable_precision x112; 320k inconclusive_at_precision x87; 320k acceptable_precision x113; 640k inconclusive_at_precision x78; 640k acceptable_precision x122.


**ours2 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-56 pts [-63, -49]) | worse (-16 pts [-26, -7]) | equal (-4 pts [-12, 4]) | equal (-4 pts [-10, 3]) | worse (-8 pts [-13, -4]) |
| random | worse (-28 pts [-35, -20]) | equal (-2 pts [-12, 8]) | equal (3 pts [-5, 11]) | equal (-4 pts [-10, 3]) | equal (2 pts [-4, 8]) |
| halving | worse (-56 pts [-63, -48]) | worse (-21 pts [-30, -12]) | equal (-6 pts [-14, 1]) | worse (-6 pts [-12, -1]) | worse (-9 pts [-14, -5]) |
| ocba | worse (-59 pts [-66, -51]) | worse (-19 pts [-28, -10]) | equal (3 pts [-6, 10]) | equal (-5 pts [-11, 1]) | worse (-8 pts [-13, -5]) |
| ours | better (5 pts [2, 8]) | worse (-15 pts [-24, -5]) | worse (-12 pts [-18, -5]) | equal (-4 pts [-10, 2]) | equal (1 pts [-5, 7]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-3 pts [-7, -0]) | equal (-3 pts [-8, 2]) | better (18 pts [8, 26]) | equal (6 pts [-3, 15]) | worse (-8 pts [-14, -1]) |
| random | worse (-7 pts [-12, -3]) | worse (-9 pts [-15, -3]) | better (14 pts [5, 23]) | better (14 pts [5, 23]) | better (27 pts [18, 35]) |
| halving | worse (-14 pts [-19, -9]) | worse (-28 pts [-35, -20]) | worse (-17 pts [-26, -7]) | worse (-14 pts [-21, -5]) | worse (-15 pts [-21, -10]) |
| ocba | worse (-5 pts [-9, -2]) | worse (-18 pts [-24, -11]) | worse (-11 pts [-20, -1]) | worse (-20 pts [-27, -12]) | worse (-17 pts [-23, -12]) |
| ours | equal (1 pts [-1, 3]) | better (3 pts [0, 7]) | equal (-9 pts [-19, 1]) | better (17 pts [8, 27]) | better (26 pts [17, 34]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x199; 40k acceptable_precision x1; 80k budget_exhausted x191; 80k acceptable_precision x9; 160k budget_exhausted x115; 160k acceptable_precision x85; 320k acceptable_precision x159; 320k budget_exhausted x41; 640k acceptable_precision x199; 640k budget_exhausted x1.

