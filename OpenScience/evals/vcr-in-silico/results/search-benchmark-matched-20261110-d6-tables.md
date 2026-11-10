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
| ours3 | 13.0% [9.0%, 18.4%] | 32.5% [26.4%, 39.3%] | 39.5% [33.0%, 46.4%] | 37.0% [30.6%, 43.9%] | 39.0% [32.5%, 45.9%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 39.5% | 43.5% | 45.5% | 44.0% |
| random | 3.0% | 10.5% | 20.0% | 34.5% | 40.0% |
| halving | 19.0% | 19.5% | 21.0% | 26.0% | 21.5% |
| ocba | 28.5% | 33.0% | 42.5% | 42.5% | 53.5% |
| ours | 14.0% | 50.0% | 47.0% | 46.5% | 44.5% |
| ours2 | 22.0% | 41.0% | 36.5% | 44.5% | 44.5% |
| ours3 | 13.0% | 32.5% | 39.5% | 37.0% | 39.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (0–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (0–50) | 50 (50–50) |
| ocba | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 0 (0–50) |
| ours | 50 (50–50) | 25 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| ours2 | 50 (50–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |
| ours3 | 50 (50–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) | 50 (0–50) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 29.5% | 32.0% | 30.5% | 35.0% | 38.0% |
| random | 94.5% | 85.0% | 73.5% | 50.5% | 41.0% |
| halving | 76.5% | 78.0% | 74.5% | 71.5% | 77.5% |
| ocba | 28.0% | 37.0% | 27.5% | 34.0% | 32.5% |
| ours | 70.5% | 33.5% | 32.5% | 31.5% | 34.0% |
| ours2 | 66.5% | 41.5% | 42.5% | 35.0% | 37.0% |
| ours3 | 76.0% | 51.5% | 33.0% | 46.0% | 35.5% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.8% / 63.8% | 41.9% / 62.5% | 37.4% / 56.8% | 30.0% / 56.2% | 29.0% / 45.2% |
| random | 45.5% / 81.8% | 30.0% / 50.0% | 24.5% / 58.5% | 30.3% / 53.5% | 32.2% / 56.8% |
| halving | 19.1% / 61.7% | 11.4% / 54.5% | 17.6% / 49.0% | 8.8% / 54.4% | 4.4% / 57.8% |
| ocba | 60.4% / 61.8% | 47.6% / 65.9% | 41.4% / 53.1% | 35.6% / 56.8% | 20.7% / 51.9% |
| ours | 52.5% / 62.7% | 24.8% / 45.1% | 30.4% / 57.0% | 32.1% / 57.7% | 32.6% / 54.5% |
| ours2 | 34.3% / 50.7% | 29.9% / 64.1% | 36.5% / 53.0% | 31.5% / 59.2% | 29.4% / 56.3% |
| ours3 | 45.8% / 58.3% | 33.0% / 59.8% | 41.0% / 59.0% | 31.5% / 60.2% | 39.5% / 58.1% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached, ours2 not reached, ours3 not reached

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% [0.3%, 3.6%] | 2.0% [0.8%, 5.0%] | 3.5% [1.7%, 7.0%] | 2.0% [0.8%, 5.0%] | 1.0% [0.3%, 3.6%] |
| random | 0.0% [0.0%, 1.9%] | 0.0% [0.0%, 1.9%] | 0.5% [0.1%, 2.8%] | 0.0% [0.0%, 1.9%] | 4.0% [2.0%, 7.7%] |
| halving | 1.0% [0.3%, 3.6%] | 1.5% [0.5%, 4.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 2.0% [0.8%, 5.0%] |
| ocba | 1.0% [0.3%, 3.6%] | 1.0% [0.3%, 3.6%] | 4.0% [2.0%, 7.7%] | 2.5% [1.1%, 5.7%] | 5.0% [2.7%, 9.0%] |
| ours | 1.0% [0.3%, 3.6%] | 4.5% [2.4%, 8.3%] | 2.0% [0.8%, 5.0%] | 2.5% [1.1%, 5.7%] | 3.5% [1.7%, 7.0%] |
| ours2 | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 2.0% [0.8%, 5.0%] | 1.5% [0.5%, 4.3%] | 1.5% [0.5%, 4.3%] |
| ours3 | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 0.5% [0.1%, 2.8%] | 1.5% [0.5%, 4.3%] | 0.0% [0.0%, 1.9%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.0% | 2.0% | 3.5% | 2.0% | 1.0% |
| random | 0.0% | 0.0% | 0.5% | 0.0% | 4.0% |
| halving | 1.0% | 1.5% | 2.0% | 2.5% | 2.0% |
| ocba | 1.0% | 1.0% | 4.0% | 2.5% | 5.0% |
| ours | 1.0% | 4.5% | 2.0% | 2.5% | 3.5% |
| ours2 | 0.0% | 1.0% | 2.0% | 1.5% | 1.5% |
| ours3 | 0.0% | 1.0% | 0.5% | 1.5% | 0.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| random | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| halving | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ocba | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours2 | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |
| ours3 | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) | 50 (50–50) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 99.0% | 98.0% | 96.5% | 98.0% | 99.0% |
| random | 100.0% | 100.0% | 99.5% | 100.0% | 96.0% |
| halving | 99.0% | 98.5% | 98.0% | 97.5% | 98.0% |
| ocba | 99.0% | 99.0% | 95.5% | 97.5% | 95.0% |
| ours | 99.0% | 95.5% | 98.0% | 97.5% | 96.0% |
| ours2 | 100.0% | 99.0% | 98.0% | 98.5% | 98.5% |
| ours3 | 100.0% | 99.0% | 99.0% | 98.5% | 100.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 50.0% | 0.0% / 25.0% | 0.0% / 28.6% | 0.0% / 50.0% | 0.0% / 0.0% |
| random | n/a / n/a | n/a / n/a | 0.0% / 0.0% | n/a / n/a | 0.0% / 12.5% |
| halving | 0.0% / 100.0% | 0.0% / 66.7% | 0.0% / 50.0% | 0.0% / 80.0% | 0.0% / 100.0% |
| ocba | 0.0% / 50.0% | 0.0% / 50.0% | 11.1% / 33.3% | 0.0% / 60.0% | 0.0% / 40.0% |
| ours | 0.0% / 50.0% | 0.0% / 66.7% | 0.0% / 75.0% | 0.0% / 60.0% | 12.5% / 50.0% |
| ours2 | n/a / n/a | 0.0% / 0.0% | 0.0% / 75.0% | 0.0% / 33.3% | 0.0% / 33.3% |
| ours3 | n/a / n/a | 0.0% / 50.0% | 50.0% / 100.0% | 0.0% / 66.7% | n/a / n/a |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid not reached, random not reached, halving not reached, ocba not reached, ours not reached, ours2 not reached, ours3 not reached

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 375k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 40k | 80k | 110k | 125k | 125k |
| ours2 | 38k | 70k | 117k | 143k | 157k |
| ours3 | 38k | 71k | 110k | 144k | 208k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-24 pts [-32, -15]) | better (10 pts [1, 20]) | equal (3 pts [-6, 13]) | equal (1 pts [-9, 11]) | equal (1 pts [-9, 10]) |
| random | better (11 pts [6, 17]) | better (40 pts [31, 47]) | better (27 pts [18, 36]) | better (12 pts [2, 21]) | equal (4 pts [-5, 14]) |
| halving | equal (-5 pts [-12, 2]) | better (31 pts [21, 39]) | better (26 pts [17, 35]) | better (21 pts [11, 29]) | better (23 pts [14, 32]) |
| ocba | worse (-14 pts [-22, -7]) | better (17 pts [7, 26]) | equal (4 pts [-5, 14]) | equal (4 pts [-6, 14]) | equal (-9 pts [-19, 1]) |
| ours2 | worse (-8 pts [-15, -0]) | equal (9 pts [-1, 19]) | better (10 pts [1, 20]) | equal (2 pts [-8, 12]) | equal (0 pts [-10, 10]) |
| ours3 | equal (1 pts [-6, 8]) | better (18 pts [8, 27]) | equal (7 pts [-2, 17]) | equal (10 pts [-0, 19]) | equal (5 pts [-4, 15]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (-2 pts [-5, 2]) | equal (1 pts [-3, 4]) | equal (3 pts [-1, 6]) |
| random | equal (1 pts [-1, 4]) | better (5 pts [2, 8]) | equal (2 pts [-1, 5]) | better (3 pts [0, 6]) | equal (-0 pts [-5, 4]) |
| halving | equal (0 pts [-3, 3]) | equal (3 pts [-1, 7]) | equal (0 pts [-3, 3]) | equal (0 pts [-4, 4]) | equal (2 pts [-2, 5]) |
| ocba | equal (0 pts [-3, 3]) | better (3 pts [0, 7]) | equal (-2 pts [-6, 2]) | equal (0 pts [-4, 4]) | equal (-2 pts [-6, 3]) |
| ours2 | equal (1 pts [-1, 4]) | better (3 pts [0, 7]) | equal (0 pts [-3, 3]) | equal (1 pts [-2, 4]) | equal (2 pts [-1, 6]) |
| ours3 | equal (1 pts [-1, 4]) | better (3 pts [0, 7]) | equal (2 pts [-1, 5]) | equal (1 pts [-2, 4]) | better (4 pts [1, 7]) |

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
| ours3 | better (9 pts [2, 16]) | equal (8 pts [-1, 18]) | equal (-3 pts [-12, 6]) | equal (8 pts [-2, 17]) | equal (5 pts [-4, 15]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-1 pts [-4, 1]) | equal (-1 pts [-4, 2]) | equal (-2 pts [-5, 2]) | equal (-1 pts [-4, 3]) | equal (0 pts [-2, 3]) |
| random | equal (0 pts [-2, 2]) | equal (1 pts [-1, 4]) | equal (2 pts [-1, 5]) | equal (2 pts [-1, 4]) | equal (-3 pts [-6, 1]) |
| halving | equal (-1 pts [-4, 1]) | equal (-0 pts [-3, 2]) | equal (0 pts [-3, 3]) | equal (-1 pts [-4, 2]) | equal (-1 pts [-4, 3]) |
| ocba | equal (-1 pts [-4, 1]) | equal (0 pts [-3, 3]) | equal (-2 pts [-6, 2]) | equal (-1 pts [-4, 2]) | equal (-4 pts [-8, 0]) |
| ours | equal (-1 pts [-4, 1]) | worse (-3 pts [-7, -0]) | equal (0 pts [-3, 3]) | equal (-1 pts [-4, 2]) | equal (-2 pts [-6, 1]) |
| ours3 | equal (0 pts [-2, 2]) | equal (0 pts [-3, 3]) | equal (2 pts [-1, 5]) | equal (0 pts [-3, 3]) | equal (2 pts [-1, 4]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x199; 40k inconclusive_at_precision x1; 80k inconclusive_at_precision x70; 80k budget_exhausted x129; 80k acceptable_precision x1; 160k inconclusive_at_precision x149; 160k budget_exhausted x47; 160k acceptable_precision x4; 320k inconclusive_at_precision x189; 320k acceptable_precision x3; 320k budget_exhausted x8; 640k inconclusive_at_precision x197; 640k acceptable_precision x3.


**ours3 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-25 pts [-32, -16]) | equal (-7 pts [-16, 2]) | equal (-4 pts [-14, 6]) | equal (-9 pts [-18, 1]) | equal (-5 pts [-14, 5]) |
| random | better (10 pts [5, 16]) | better (22 pts [14, 30]) | better (20 pts [11, 28]) | equal (3 pts [-7, 12]) | equal (-1 pts [-10, 9]) |
| halving | equal (-6 pts [-13, 1]) | better (13 pts [4, 21]) | better (19 pts [10, 27]) | better (11 pts [2, 20]) | better (18 pts [9, 26]) |
| ocba | worse (-15 pts [-23, -8]) | equal (-1 pts [-10, 9]) | equal (-3 pts [-13, 7]) | equal (-5 pts [-15, 4]) | worse (-15 pts [-24, -5]) |
| ours | equal (-1 pts [-8, 6]) | worse (-18 pts [-27, -8]) | equal (-7 pts [-17, 2]) | equal (-10 pts [-19, 0]) | equal (-5 pts [-15, 4]) |
| ours2 | worse (-9 pts [-16, -2]) | equal (-8 pts [-18, 1]) | equal (3 pts [-6, 12]) | equal (-8 pts [-17, 2]) | equal (-5 pts [-15, 4]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-1 pts [-4, 1]) | equal (-1 pts [-4, 2]) | worse (-3 pts [-7, -0]) | equal (-1 pts [-4, 3]) | equal (-1 pts [-4, 1]) |
| random | equal (0 pts [-2, 2]) | equal (1 pts [-1, 4]) | equal (0 pts [-2, 2]) | equal (2 pts [-1, 4]) | worse (-4 pts [-8, -1]) |
| halving | equal (-1 pts [-4, 1]) | equal (-0 pts [-3, 2]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-4, 2]) | equal (-2 pts [-5, 0]) |
| ocba | equal (-1 pts [-4, 1]) | equal (0 pts [-3, 3]) | worse (-4 pts [-7, -0]) | equal (-1 pts [-4, 2]) | worse (-5 pts [-9, -2]) |
| ours | equal (-1 pts [-4, 1]) | worse (-3 pts [-7, -0]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-4, 2]) | worse (-4 pts [-7, -1]) |
| ours2 | equal (0 pts [-2, 2]) | equal (0 pts [-3, 3]) | equal (-2 pts [-5, 1]) | equal (0 pts [-3, 3]) | equal (-2 pts [-4, 1]) |

Check: ours3's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours3's stop reasons: 40k budget_exhausted x197; 40k inconclusive_at_precision x3; 80k budget_exhausted x135; 80k inconclusive_at_precision x64; 80k acceptable_precision x1; 160k budget_exhausted x48; 160k inconclusive_at_precision x150; 160k acceptable_precision x2; 320k inconclusive_at_precision x188; 320k budget_exhausted x9; 320k acceptable_precision x3; 640k inconclusive_at_precision x200.

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
| ours3 | 77.0% [70.7%, 82.3%] | 94.0% [89.8%, 96.5%] | 99.0% [96.4%, 99.7%] | 100.0% [98.1%, 100.0%] | 100.0% [98.1%, 100.0%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| random | 51.5% | 92.0% | 99.0% | 100.0% | 100.0% |
| halving | 98.0% | 99.5% | 100.0% | 100.0% | 100.0% |
| ocba | 99.5% | 100.0% | 100.0% | 100.0% | 100.0% |
| ours | 61.5% | 97.5% | 100.0% | 100.0% | 100.0% |
| ours2 | 64.5% | 94.0% | 99.5% | 100.0% | 100.0% |
| ours3 | 78.5% | 94.5% | 99.5% | 100.0% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 0 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 0 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours3 | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 19.5% | 0.0% | 0.0% | 0.0% | 0.0% |
| halving | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 38.5% | 2.5% | 0.0% | 0.0% | 0.0% |
| ours2 | 35.5% | 6.0% | 0.5% | 0.0% | 0.0% |
| ours3 | 21.5% | 5.5% | 0.5% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% / 22.0% | 0.0% / 20.0% | 0.0% / 21.0% | 0.0% / 26.0% | 0.0% / 38.5% |
| random | 0.0% / 9.9% | 0.0% / 15.5% | 0.5% / 16.5% | 0.0% / 29.0% | 0.0% / 26.5% |
| halving | 1.5% / 13.0% | 0.0% / 17.0% | 0.0% / 10.5% | 0.0% / 7.0% | 0.0% / 7.0% |
| ocba | 0.5% / 27.5% | 0.0% / 28.0% | 0.0% / 25.0% | 0.0% / 28.5% | 0.0% / 28.0% |
| ours | 0.0% / 39.8% | 0.0% / 26.7% | 0.0% / 34.5% | 0.0% / 17.5% | 0.0% / 27.0% |
| ours2 | 0.0% / 42.6% | 0.0% / 31.9% | 0.0% / 27.6% | 0.0% / 22.5% | 0.0% / 26.5% |
| ours3 | 0.0% / 19.1% | 0.0% / 19.0% | 0.0% / 16.1% | 0.0% / 15.0% | 0.0% / 13.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 40k, random 80k, halving 40k, ocba 40k, ours 80k, ours2 80k, ours3 80k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 5.5% [3.1%, 9.6%] | 21.5% [16.4%, 27.7%] | 48.0% [41.2%, 54.9%] | 89.0% [83.9%, 92.6%] | 99.0% [96.4%, 99.7%] |
| random | 10.0% [6.6%, 14.9%] | 30.0% [24.1%, 36.7%] | 45.5% [38.7%, 52.4%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] |
| halving | 22.0% [16.8%, 28.2%] | 54.5% [47.6%, 61.3%] | 86.0% [80.5%, 90.1%] | 97.0% [93.6%, 98.6%] | 100.0% [98.1%, 100.0%] |
| ocba | 27.5% [21.8%, 34.1%] | 59.0% [52.1%, 65.6%] | 86.0% [80.5%, 90.1%] | 99.5% [97.2%, 99.9%] | 100.0% [98.1%, 100.0%] |
| ours | 4.0% [2.0%, 7.7%] | 33.5% [27.3%, 40.3%] | 81.0% [75.0%, 85.8%] | 83.0% [77.2%, 87.6%] | 81.0% [75.0%, 85.8%] |
| ours2 | 2.5% [1.1%, 5.7%] | 15.0% [10.7%, 20.6%] | 73.0% [66.5%, 78.7%] | 94.0% [89.8%, 96.5%] | 95.5% [91.7%, 97.6%] |
| ours3 | 13.5% [9.4%, 18.9%] | 38.5% [32.0%, 45.4%] | 79.0% [72.8%, 84.1%] | 97.0% [93.6%, 98.6%] | 95.5% [91.7%, 97.6%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.0% | 66.0% | 95.5% | 100.0% | 100.0% |
| random | 25.5% | 59.0% | 83.5% | 99.5% | 100.0% |
| halving | 52.5% | 78.0% | 97.0% | 99.5% | 100.0% |
| ocba | 32.5% | 67.0% | 92.5% | 100.0% | 100.0% |
| ours | 4.0% | 33.5% | 82.5% | 83.5% | 81.0% |
| ours2 | 2.5% | 15.0% | 73.0% | 96.5% | 100.0% |
| ours3 | 13.5% | 39.0% | 81.0% | 99.5% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–150) | 50 (50–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| random | 150 (50–150) | 50 (0–100) | 50 (0–50) | 0 (0–0) | 0 (0–0) |
| halving | 50 (50–150) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 150 (0–150) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 150 (150–150) | 150 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 150 (150–150) | 150 (150–150) | 0 (0–150) | 0 (0–0) | 0 (0–0) |
| ours3 | 150 (150–150) | 150 (0–150) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 37.5% | 13.0% | 0.0% | 0.0% | 0.0% |
| random | 59.5% | 18.5% | 5.0% | 0.0% | 0.0% |
| halving | 46.0% | 21.5% | 3.0% | 0.5% | 0.0% |
| ocba | 50.0% | 21.5% | 3.5% | 0.0% | 0.0% |
| ours | 96.0% | 66.5% | 17.5% | 16.5% | 19.0% |
| ours2 | 97.5% | 85.0% | 27.0% | 3.5% | 0.0% |
| ours3 | 86.5% | 61.0% | 19.0% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.8% / 9.6% | 0.6% / 6.3% | 0.0% / 2.0% | 0.0% / 6.0% | 0.0% / 5.0% |
| random | 0.0% / 4.9% | 0.0% / 4.3% | 0.0% / 3.7% | 0.0% / 1.0% | 0.0% / 4.0% |
| halving | 0.0% / 5.6% | 0.0% / 2.5% | 0.0% / 2.6% | 0.0% / 2.0% | 0.0% / 7.5% |
| ocba | 2.0% / 8.0% | 0.6% / 8.3% | 0.0% / 6.7% | 0.0% / 5.0% | 0.0% / 7.5% |
| ours | 0.0% / 37.5% | 0.0% / 16.4% | 0.0% / 3.6% | 0.0% / 7.2% | 0.0% / 6.2% |
| ours2 | 0.0% / 20.0% | 0.0% / 16.7% | 0.0% / 4.1% | 0.0% / 6.7% | 0.0% / 5.0% |
| ours3 | 0.0% / 3.7% | 0.0% / 6.4% | 0.0% / 2.5% | 0.0% / 2.5% | 0.0% / 3.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 160k, ours 160k, ours2 320k, ours3 160k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |
| ours2 | 37k | 71k | 136k | 165k | 182k |
| ours3 | 38k | 71k | 114k | 146k | 214k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| random | better (36 pts [26, 44]) | better (29 pts [22, 35]) | better (8 pts [5, 13]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| halving | worse (-22 pts [-30, -13]) | better (6 pts [2, 11]) | better (5 pts [1, 8]) | equal (1 pts [-1, 3]) | equal (0 pts [-2, 2]) |
| ocba | worse (-38 pts [-44, -31]) | equal (-2 pts [-5, 1]) | equal (-1 pts [-3, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours2 | equal (-3 pts [-12, 6]) | equal (4 pts [-1, 8]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours3 | worse (-16 pts [-24, -6]) | equal (4 pts [-1, 8]) | equal (1 pts [-2, 3]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-6, 3]) | better (12 pts [3, 21]) | better (33 pts [24, 41]) | equal (-6 pts [-13, 1]) | worse (-18 pts [-24, -13]) |
| random | worse (-6 pts [-11, -1]) | equal (4 pts [-6, 13]) | better (36 pts [26, 44]) | equal (2 pts [-6, 10]) | equal (-2 pts [-10, 6]) |
| halving | worse (-18 pts [-25, -12]) | worse (-21 pts [-30, -11]) | equal (-5 pts [-12, 2]) | worse (-14 pts [-20, -8]) | worse (-19 pts [-25, -14]) |
| ocba | worse (-24 pts [-30, -17]) | worse (-25 pts [-35, -16]) | equal (-5 pts [-12, 2]) | worse (-17 pts [-22, -11]) | worse (-19 pts [-25, -14]) |
| ours2 | equal (2 pts [-2, 5]) | better (19 pts [10, 27]) | equal (8 pts [-0, 16]) | worse (-11 pts [-17, -5]) | worse (-14 pts [-21, -8]) |
| ours3 | worse (-10 pts [-15, -4]) | equal (-5 pts [-14, 4]) | equal (2 pts [-6, 10]) | worse (-14 pts [-20, -8]) | worse (-14 pts [-21, -8]) |

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
| ours3 | worse (-13 pts [-21, -4]) | equal (0 pts [-5, 5]) | equal (1 pts [-2, 3]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-3 pts [-7, 1]) | equal (-7 pts [-14, 1]) | better (25 pts [15, 34]) | equal (5 pts [-1, 11]) | worse (-4 pts [-7, -0]) |
| random | worse (-8 pts [-13, -3]) | worse (-15 pts [-23, -7]) | better (27 pts [18, 36]) | better (13 pts [7, 20]) | better (13 pts [7, 19]) |
| halving | worse (-20 pts [-26, -13]) | worse (-40 pts [-47, -31]) | worse (-13 pts [-21, -5]) | equal (-3 pts [-7, 1]) | worse (-5 pts [-8, -2]) |
| ocba | worse (-25 pts [-32, -18]) | worse (-44 pts [-52, -35]) | worse (-13 pts [-21, -5]) | worse (-6 pts [-10, -2]) | worse (-5 pts [-8, -2]) |
| ours | equal (-2 pts [-5, 2]) | worse (-19 pts [-27, -10]) | equal (-8 pts [-16, 0]) | better (11 pts [5, 17]) | better (14 pts [8, 21]) |
| ours3 | worse (-11 pts [-17, -6]) | worse (-24 pts [-32, -15]) | equal (-6 pts [-14, 2]) | equal (-3 pts [-7, 1]) | equal (0 pts [-4, 4]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x195; 40k acceptable_precision x5; 80k budget_exhausted x170; 80k acceptable_precision x30; 160k acceptable_precision x146; 160k budget_exhausted x54; 320k acceptable_precision x193; 320k budget_exhausted x7; 640k acceptable_precision x200.


**ours3 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-22 pts [-28, -16]) | worse (-6 pts [-10, -2]) | equal (-1 pts [-4, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| random | better (51 pts [42, 59]) | better (25 pts [18, 32]) | better (8 pts [4, 13]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| halving | equal (-6 pts [-14, 1]) | equal (3 pts [-2, 8]) | better (4 pts [1, 8]) | equal (1 pts [-1, 3]) | equal (0 pts [-2, 2]) |
| ocba | worse (-22 pts [-28, -16]) | worse (-6 pts [-10, -2]) | equal (-1 pts [-4, 1]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours | better (16 pts [6, 24]) | equal (-4 pts [-8, 1]) | equal (-1 pts [-3, 2]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |
| ours2 | better (13 pts [4, 21]) | equal (0 pts [-5, 5]) | equal (-1 pts [-3, 2]) | equal (0 pts [-2, 2]) | equal (0 pts [-2, 2]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | better (8 pts [2, 14]) | better (17 pts [8, 26]) | better (31 pts [22, 39]) | better (8 pts [3, 13]) | worse (-4 pts [-7, -0]) |
| random | equal (4 pts [-3, 10]) | equal (9 pts [-1, 18]) | better (34 pts [24, 42]) | better (16 pts [10, 22]) | better (13 pts [7, 19]) |
| halving | worse (-9 pts [-16, -1]) | worse (-16 pts [-25, -6]) | equal (-7 pts [-14, 0]) | equal (0 pts [-4, 4]) | worse (-5 pts [-8, -2]) |
| ocba | worse (-14 pts [-22, -6]) | worse (-20 pts [-30, -11]) | equal (-7 pts [-14, 0]) | equal (-3 pts [-6, 0]) | worse (-5 pts [-8, -2]) |
| ours | better (10 pts [4, 15]) | equal (5 pts [-4, 14]) | equal (-2 pts [-10, 6]) | better (14 pts [8, 20]) | better (14 pts [8, 21]) |
| ours2 | better (11 pts [6, 17]) | better (24 pts [15, 32]) | equal (6 pts [-2, 14]) | equal (3 pts [-1, 7]) | equal (0 pts [-4, 4]) |

Check: ours3's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours3's stop reasons: 40k budget_exhausted x173; 40k acceptable_precision x27; 80k budget_exhausted x123; 80k acceptable_precision x77; 160k acceptable_precision x158; 160k budget_exhausted x42; 320k acceptable_precision x195; 320k budget_exhausted x5; 640k acceptable_precision x200.

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
| ours3 | 40.0% [33.5%, 46.9%] | 74.0% [67.5%, 79.6%] | 96.0% [92.3%, 98.0%] | 97.0% [93.6%, 98.6%] | 96.0% [92.3%, 98.0%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 68.5% | 71.5% | 84.5% | 91.5% | 99.0% |
| random | 61.5% | 90.5% | 93.0% | 91.5% | 89.0% |
| halving | 92.5% | 95.5% | 100.0% | 100.0% | 100.0% |
| ocba | 69.0% | 73.0% | 77.5% | 93.0% | 99.5% |
| ours | 0.0% | 68.0% | 91.5% | 92.5% | 90.0% |
| ours2 | 4.5% | 53.5% | 80.5% | 88.0% | 91.0% |
| ours3 | 45.5% | 80.5% | 96.5% | 97.5% | 96.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| random | 50 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| halving | 0 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ocba | 0 (0–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours2 | 100 (100–100) | 0 (0–100) | 0 (0–0) | 0 (0–0) | 0 (0–0) |
| ours3 | 100 (0–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 38.0% | 5.5% | 1.0% | 0.0% | 0.0% |
| halving | 1.5% | 1.0% | 0.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 89.0% | 26.5% | 0.0% | 0.0% | 0.0% |
| ours2 | 85.0% | 37.0% | 10.0% | 1.5% | 0.0% |
| ours3 | 47.0% | 16.5% | 2.0% | 0.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 31.5% / 45.0% | 28.5% / 36.0% | 15.5% / 27.5% | 8.5% / 25.0% | 1.0% / 24.5% |
| random | 0.8% / 11.3% | 4.2% / 20.1% | 6.1% / 24.2% | 8.5% / 31.5% | 11.0% / 28.0% |
| halving | 6.1% / 17.8% | 3.5% / 15.2% | 0.0% / 8.5% | 0.0% / 10.5% | 0.0% / 10.0% |
| ocba | 31.0% / 42.5% | 27.0% / 41.5% | 22.5% / 33.5% | 7.0% / 27.0% | 0.5% / 23.0% |
| ours | 100.0% / 95.5% | 7.5% / 25.2% | 8.5% / 25.5% | 7.5% / 24.0% | 10.0% / 27.5% |
| ours2 | 70.0% / 76.7% | 15.1% / 38.9% | 10.6% / 31.7% | 10.7% / 26.4% | 9.0% / 25.0% |
| ours3 | 14.2% / 32.1% | 3.6% / 22.8% | 1.5% / 20.9% | 2.5% / 17.5% | 4.0% / 22.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid 160k, random 80k, halving 40k, ocba 320k, ours 160k, ours2 160k, ours3 80k

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 3.5% [1.7%, 7.0%] | 7.5% [4.6%, 12.0%] | 27.0% [21.3%, 33.5%] | 65.5% [58.7%, 71.7%] | 90.5% [85.6%, 93.8%] |
| random | 7.5% [4.6%, 12.0%] | 13.5% [9.4%, 18.9%] | 30.5% [24.5%, 37.2%] | 58.0% [51.1%, 64.6%] | 56.5% [49.6%, 63.2%] |
| halving | 14.0% [9.9%, 19.5%] | 32.0% [25.9%, 38.8%] | 61.5% [54.6%, 68.0%] | 85.5% [80.0%, 89.7%] | 98.0% [95.0%, 99.2%] |
| ocba | 5.5% [3.1%, 9.6%] | 22.0% [16.8%, 28.2%] | 55.0% [48.1%, 61.7%] | 91.5% [86.8%, 94.6%] | 100.0% [98.1%, 100.0%] |
| ours | 0.0% [0.0%, 1.9%] | 1.0% [0.3%, 3.6%] | 53.5% [46.6%, 60.3%] | 54.5% [47.6%, 61.3%] | 57.5% [50.6%, 64.1%] |
| ours2 | 0.5% [0.1%, 2.8%] | 4.5% [2.4%, 8.3%] | 44.5% [37.8%, 51.4%] | 72.0% [65.4%, 77.8%] | 83.0% [77.2%, 87.6%] |
| ours3 | 2.0% [0.8%, 5.0%] | 19.5% [14.6%, 25.5%] | 49.0% [42.2%, 55.9%] | 70.5% [63.8%, 76.4%] | 81.5% [75.5%, 86.3%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 46.0% | 73.5% | 98.0% | 100.0% | 100.0% |
| random | 26.5% | 54.5% | 80.5% | 100.0% | 99.0% |
| halving | 56.0% | 76.0% | 90.0% | 96.5% | 99.5% |
| ocba | 16.0% | 42.5% | 78.5% | 97.5% | 100.0% |
| ours | 0.0% | 1.0% | 56.0% | 56.5% | 61.0% |
| ours2 | 0.5% | 4.5% | 45.0% | 81.0% | 99.5% |
| ours3 | 3.0% | 23.5% | 57.5% | 90.0% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) |
| random | 100 (50–100) | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–50) |
| halving | 50 (50–100) | 50 (0–50) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ocba | 100 (100–100) | 100 (50–100) | 0 (0–50) | 0 (0–0) | 0 (0–0) |
| ours | 100 (100–100) | 100 (100–100) | 0 (0–100) | 0 (0–100) | 0 (0–100) |
| ours2 | 100 (100–100) | 100 (100–100) | 100 (0–100) | 0 (0–50) | 0 (0–0) |
| ours3 | 100 (100–100) | 100 (100–100) | 50 (0–100) | 0 (0–50) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 53.5% | 26.5% | 2.0% | 0.0% | 0.0% |
| random | 73.5% | 45.5% | 19.5% | 0.0% | 1.0% |
| halving | 43.5% | 24.0% | 10.0% | 3.5% | 0.5% |
| ocba | 83.5% | 57.0% | 20.5% | 2.5% | 0.0% |
| ours | 100.0% | 99.0% | 44.0% | 43.5% | 39.0% |
| ours2 | 99.5% | 95.5% | 55.0% | 19.0% | 0.5% |
| ours3 | 97.0% | 76.5% | 42.5% | 10.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.1% / 2.2% | 0.0% / 3.4% | 0.0% / 6.6% | 0.0% / 7.0% | 0.0% / 9.0% |
| random | 0.0% / 1.9% | 0.0% / 3.7% | 0.0% / 3.7% | 0.0% / 5.0% | 0.0% / 5.6% |
| halving | 0.9% / 4.4% | 0.0% / 3.9% | 0.0% / 2.2% | 0.0% / 3.6% | 0.0% / 7.0% |
| ocba | 3.0% / 12.1% | 1.2% / 9.3% | 1.3% / 10.1% | 0.0% / 7.2% | 0.0% / 7.5% |
| ours | n/a / n/a | 0.0% / 50.0% | 0.0% / 8.9% | 0.0% / 2.7% | 0.0% / 6.6% |
| ours2 | 0.0% / 0.0% | 0.0% / 11.1% | 0.0% / 3.3% | 0.0% / 2.5% | 0.0% / 2.0% |
| ours3 | 0.0% / 0.0% | 0.0% / 4.3% | 0.0% / 3.5% | 0.0% / 2.2% | 0.0% / 3.5% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 160k, halving 160k, ocba 320k, ours not reached, ours2 320k, ours3 320k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 300k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 160k | 185k | 185k |
| ours2 | 37k | 71k | 148k | 232k | 229k |
| ours3 | 38k | 71k | 145k | 187k | 231k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-61 pts [-67, -54]) | equal (-2 pts [-11, 7]) | better (8 pts [1, 14]) | equal (1 pts [-5, 6]) | worse (-9 pts [-14, -5]) |
| random | worse (-32 pts [-39, -26]) | better (13 pts [3, 22]) | better (15 pts [7, 22]) | equal (1 pts [-5, 6]) | equal (1 pts [-5, 7]) |
| halving | worse (-61 pts [-67, -53]) | equal (-6 pts [-15, 2]) | equal (5 pts [-1, 11]) | equal (-2 pts [-8, 3]) | worse (-10 pts [-15, -6]) |
| ocba | worse (-64 pts [-70, -56]) | equal (-4 pts [-13, 4]) | better (14 pts [7, 21]) | equal (-1 pts [-6, 4]) | worse (-9 pts [-14, -5]) |
| ours2 | worse (-5 pts [-8, -2]) | better (15 pts [5, 24]) | better (12 pts [5, 18]) | equal (4 pts [-2, 10]) | equal (-1 pts [-7, 5]) |
| ours3 | worse (-40 pts [-47, -33]) | equal (-6 pts [-15, 3]) | equal (-4 pts [-10, 0]) | worse (-5 pts [-10, -0]) | worse (-6 pts [-11, -1]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-4 pts [-7, -1]) | worse (-7 pts [-11, -3]) | better (27 pts [17, 35]) | worse (-11 pts [-20, -1]) | worse (-33 pts [-41, -25]) |
| random | worse (-8 pts [-12, -4]) | worse (-13 pts [-18, -8]) | better (23 pts [13, 32]) | equal (-3 pts [-13, 6]) | equal (1 pts [-9, 11]) |
| halving | worse (-14 pts [-19, -9]) | worse (-31 pts [-38, -24]) | equal (-8 pts [-17, 2]) | worse (-31 pts [-39, -22]) | worse (-41 pts [-48, -33]) |
| ocba | worse (-6 pts [-10, -2]) | worse (-21 pts [-27, -15]) | equal (-2 pts [-11, 8]) | worse (-37 pts [-45, -29]) | worse (-43 pts [-49, -36]) |
| ours2 | equal (-1 pts [-3, 1]) | worse (-3 pts [-7, -0]) | equal (9 pts [-1, 19]) | worse (-17 pts [-27, -8]) | worse (-26 pts [-34, -17]) |
| ours3 | equal (-2 pts [-5, 0]) | worse (-19 pts [-25, -13]) | equal (5 pts [-5, 14]) | worse (-16 pts [-25, -7]) | worse (-24 pts [-32, -15]) |

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
| ours3 | worse (-36 pts [-43, -28]) | worse (-20 pts [-29, -11]) | worse (-16 pts [-22, -10]) | worse (-9 pts [-14, -4]) | worse (-5 pts [-10, -0]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-3 pts [-7, -0]) | equal (-3 pts [-8, 2]) | better (18 pts [8, 26]) | equal (6 pts [-3, 15]) | worse (-8 pts [-14, -1]) |
| random | worse (-7 pts [-12, -3]) | worse (-9 pts [-15, -3]) | better (14 pts [5, 23]) | better (14 pts [5, 23]) | better (27 pts [18, 35]) |
| halving | worse (-14 pts [-19, -9]) | worse (-28 pts [-35, -20]) | worse (-17 pts [-26, -7]) | worse (-14 pts [-21, -5]) | worse (-15 pts [-21, -10]) |
| ocba | worse (-5 pts [-9, -2]) | worse (-18 pts [-24, -11]) | worse (-11 pts [-20, -1]) | worse (-20 pts [-27, -12]) | worse (-17 pts [-23, -12]) |
| ours | equal (1 pts [-1, 3]) | better (3 pts [0, 7]) | equal (-9 pts [-19, 1]) | better (17 pts [8, 27]) | better (26 pts [17, 34]) |
| ours3 | equal (-2 pts [-5, 1]) | worse (-15 pts [-21, -9]) | equal (-4 pts [-14, 5]) | equal (2 pts [-7, 10]) | equal (2 pts [-6, 9]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x199; 40k acceptable_precision x1; 80k budget_exhausted x191; 80k acceptable_precision x9; 160k budget_exhausted x115; 160k acceptable_precision x85; 320k acceptable_precision x159; 320k budget_exhausted x41; 640k acceptable_precision x199; 640k budget_exhausted x1.


**ours3 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-21 pts [-30, -11]) | equal (4 pts [-5, 13]) | better (12 pts [6, 18]) | better (5 pts [1, 10]) | equal (-3 pts [-7, 0]) |
| random | equal (8 pts [-1, 17]) | better (18 pts [9, 27]) | better (19 pts [13, 26]) | better (5 pts [1, 10]) | better (7 pts [2, 12]) |
| halving | worse (-20 pts [-30, -11]) | equal (-1 pts [-9, 8]) | better (9 pts [4, 15]) | equal (3 pts [-2, 7]) | worse (-4 pts [-8, -1]) |
| ocba | worse (-24 pts [-33, -14]) | equal (2 pts [-7, 10]) | better (18 pts [12, 25]) | equal (4 pts [-0, 9]) | worse (-4 pts [-7, -0]) |
| ours | better (40 pts [33, 47]) | equal (6 pts [-3, 15]) | equal (4 pts [-0, 10]) | better (5 pts [0, 10]) | better (6 pts [1, 11]) |
| ours2 | better (36 pts [28, 43]) | better (20 pts [11, 29]) | better (16 pts [10, 22]) | better (9 pts [4, 14]) | better (5 pts [0, 10]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-5, 2]) | better (12 pts [5, 19]) | better (22 pts [13, 31]) | equal (5 pts [-4, 14]) | worse (-9 pts [-16, -2]) |
| random | worse (-5 pts [-10, -1]) | equal (6 pts [-1, 13]) | better (19 pts [9, 28]) | better (13 pts [3, 22]) | better (25 pts [16, 33]) |
| halving | worse (-12 pts [-18, -7]) | worse (-13 pts [-21, -4]) | worse (-13 pts [-22, -3]) | worse (-15 pts [-23, -7]) | worse (-17 pts [-23, -11]) |
| ocba | equal (-4 pts [-8, 0]) | equal (-2 pts [-10, 5]) | equal (-6 pts [-16, 4]) | worse (-21 pts [-28, -13]) | worse (-19 pts [-24, -13]) |
| ours | equal (2 pts [-0, 5]) | better (19 pts [13, 25]) | equal (-5 pts [-14, 5]) | better (16 pts [7, 25]) | better (24 pts [15, 32]) |
| ours2 | equal (2 pts [-1, 5]) | better (15 pts [9, 21]) | equal (4 pts [-5, 14]) | equal (-2 pts [-10, 7]) | equal (-2 pts [-9, 6]) |

Check: ours3's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours3's stop reasons: 40k budget_exhausted x198; 40k acceptable_precision x2; 80k acceptable_precision x22; 80k budget_exhausted x178; 160k budget_exhausted x106; 160k acceptable_precision x94; 320k acceptable_precision x162; 320k budget_exhausted x38; 640k acceptable_precision x200.

## heldout world

27 designs; 5 truly feasible, 1 of them optimal (140 patients); 200 seeds per arm and budget; ε = 50 patients; penalty score 170 patients (regret 30 for no pick or an infeasible pick).

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 24.0% [18.6%, 30.4%] | 30.5% [24.5%, 37.2%] | 40.5% [33.9%, 47.4%] | 51.5% [44.6%, 58.3%] | 66.5% [59.7%, 72.7%] |
| random | 2.0% [0.8%, 5.0%] | 8.5% [5.4%, 13.2%] | 20.0% [15.0%, 26.1%] | 32.5% [26.4%, 39.3%] | 59.0% [52.1%, 65.6%] |
| halving | 22.5% [17.3%, 28.8%] | 31.0% [25.0%, 37.7%] | 50.0% [43.1%, 56.9%] | 66.0% [59.2%, 72.2%] | 83.0% [77.2%, 87.6%] |
| ocba | 16.5% [12.0%, 22.3%] | 27.5% [21.8%, 34.1%] | 34.0% [27.8%, 40.8%] | 48.5% [41.7%, 55.4%] | 64.0% [57.1%, 70.3%] |
| ours | 0.0% [0.0%, 1.9%] | 10.5% [7.0%, 15.5%] | 67.0% [60.2%, 73.1%] | 70.0% [63.3%, 75.9%] | 69.0% [62.3%, 75.0%] |
| ours2 | 0.0% [0.0%, 1.9%] | 9.0% [5.8%, 13.8%] | 51.0% [44.1%, 57.8%] | 63.0% [56.1%, 69.4%] | 62.5% [55.6%, 68.9%] |
| ours3 | 12.0% [8.2%, 17.2%] | 43.0% [36.3%, 49.9%] | 60.5% [53.6%, 67.0%] | 73.0% [66.5%, 78.7%] | 75.0% [68.6%, 80.5%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 30.5% | 34.0% | 44.5% | 52.0% | 67.0% |
| random | 16.0% | 46.5% | 63.0% | 73.0% | 61.5% |
| halving | 70.5% | 86.5% | 94.0% | 95.0% | 100.0% |
| ocba | 24.5% | 32.5% | 39.0% | 51.5% | 65.5% |
| ours | 0.0% | 10.5% | 71.5% | 70.0% | 69.5% |
| ours2 | 0.0% | 9.0% | 52.0% | 63.5% | 62.5% |
| ours3 | 12.5% | 53.0% | 71.5% | 74.0% | 75.5% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 30 (10–30) | 30 (0–30) | 30 (0–30) | 0 (0–30) | 0 (0–30) |
| random | 30 (30–30) | 30 (10–30) | 20 (10–30) | 10 (0–30) | 0 (0–30) |
| halving | 10 (10–30) | 10 (0–20) | 5 (0–10) | 0 (0–10) | 0 (0–0) |
| ocba | 30 (30–30) | 30 (0–30) | 30 (0–30) | 10 (0–30) | 0 (0–30) |
| ours | 30 (30–30) | 30 (30–30) | 0 (0–30) | 0 (0–30) | 0 (0–30) |
| ours2 | 30 (30–30) | 30 (30–30) | 0 (0–30) | 0 (0–30) | 0 (0–30) |
| ours3 | 30 (30–30) | 10 (0–30) | 0 (0–30) | 0 (0–30) | 0 (0–2.5) |

**No pick** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| random | 79.5% | 45.5% | 21.5% | 4.5% | 0.0% |
| halving | 7.5% | 1.5% | 1.0% | 0.0% | 0.0% |
| ocba | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| ours | 88.0% | 58.5% | 0.5% | 0.0% | 0.0% |
| ours2 | 84.0% | 67.0% | 17.5% | 3.5% | 0.0% |
| ours3 | 77.0% | 34.0% | 7.0% | 1.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule S (point estimates meet both constraints; the same pick rule for every arm))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 69.5% / 64.0% | 66.0% / 59.0% | 55.5% / 48.0% | 48.0% / 42.0% | 33.0% / 29.0% |
| random | 22.0% / 12.2% | 14.7% / 12.8% | 19.7% / 16.6% | 23.6% / 18.8% | 38.5% / 30.0% |
| halving | 23.8% / 18.9% | 12.2% / 9.1% | 5.1% / 5.1% | 5.0% / 4.0% | 0.0% / 0.0% |
| ocba | 75.5% / 68.5% | 67.5% / 56.5% | 61.0% / 51.0% | 48.5% / 37.5% | 34.5% / 30.0% |
| ours | 100.0% / 87.5% | 74.7% / 55.4% | 28.1% / 23.1% | 30.0% / 24.0% | 30.5% / 24.5% |
| ours2 | 100.0% / 90.6% | 72.7% / 54.5% | 37.0% / 29.7% | 34.2% / 27.5% | 37.5% / 32.0% |
| ours3 | 45.7% / 34.8% | 19.7% / 15.2% | 23.1% / 16.7% | 25.3% / 21.7% | 24.5% / 20.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule S): grid not reached, random not reached, halving 80k, ocba not reached, ours not reached, ours2 not reached, ours3 not reached

**Probability of correct selection (a truly feasible design with the fewest patients)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 1.5% [0.5%, 4.3%] | 2.5% [1.1%, 5.7%] | 13.0% [9.0%, 18.4%] | 40.0% [33.5%, 46.9%] | 74.0% [67.5%, 79.6%] |
| random | 1.5% [0.5%, 4.3%] | 8.0% [5.0%, 12.6%] | 17.0% [12.4%, 22.8%] | 33.5% [27.3%, 40.3%] | 73.5% [67.0%, 79.1%] |
| halving | 6.0% [3.5%, 10.2%] | 21.5% [16.4%, 27.7%] | 47.0% [40.2%, 53.9%] | 69.5% [62.8%, 75.5%] | 83.0% [77.2%, 87.6%] |
| ocba | 2.0% [0.8%, 5.0%] | 6.0% [3.5%, 10.2%] | 18.5% [13.7%, 24.5%] | 35.0% [28.7%, 41.8%] | 66.5% [59.7%, 72.7%] |
| ours | 0.0% [0.0%, 1.9%] | 11.0% [7.4%, 16.1%] | 74.5% [68.0%, 80.0%] | 80.5% [74.5%, 85.4%] | 84.0% [78.3%, 88.4%] |
| ours2 | 0.0% [0.0%, 1.9%] | 9.5% [6.2%, 14.4%] | 64.5% [57.7%, 70.8%] | 91.5% [86.8%, 94.6%] | 97.5% [94.3%, 98.9%] |
| ours3 | 6.5% [3.8%, 10.8%] | 47.0% [40.2%, 53.9%] | 71.0% [64.4%, 76.8%] | 95.5% [91.7%, 97.6%] | 94.0% [89.8%, 96.5%] |

**Success within ε (truly feasible and at most ε patients above the optimum)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 41.0% | 74.0% | 98.5% | 100.0% | 99.5% |
| random | 14.5% | 45.5% | 69.0% | 91.0% | 99.5% |
| halving | 70.0% | 88.0% | 97.5% | 100.0% | 100.0% |
| ocba | 7.0% | 20.5% | 53.5% | 91.5% | 97.0% |
| ours | 0.0% | 11.0% | 94.0% | 100.0% | 98.5% |
| ours2 | 0.0% | 9.5% | 66.5% | 93.5% | 100.0% |
| ours3 | 7.0% | 56.5% | 88.0% | 99.0% | 100.0% |

**Simple regret in patients, median (IQR); no pick or an infeasible pick counts the penalty** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 30 (20–30) | 20 (10–30) | 10 (10–20) | 10 (0–10) | 0 (0–10) |
| random | 30 (30–30) | 30 (10–30) | 20 (10–30) | 10 (0–20) | 0 (0–10) |
| halving | 20 (10–30) | 10 (10–20) | 10 (0–10) | 0 (0–10) | 0 (0–0) |
| ocba | 30 (30–30) | 30 (30–30) | 20 (10–30) | 10 (0–20) | 0 (0–10) |
| ours | 30 (30–30) | 30 (30–30) | 0 (0–10) | 0 (0–0) | 0 (0–0) |
| ours2 | 30 (30–30) | 30 (30–30) | 0 (0–30) | 0 (0–0) | 0 (0–0) |
| ours3 | 30 (30–30) | 10 (0–30) | 0 (0–10) | 0 (0–0) | 0 (0–0) |

**No pick** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 56.5% | 23.5% | 1.0% | 0.0% | 0.0% |
| random | 85.5% | 54.5% | 31.0% | 8.5% | 0.0% |
| halving | 29.5% | 11.5% | 2.5% | 0.0% | 0.0% |
| ocba | 91.0% | 77.5% | 44.5% | 7.0% | 1.0% |
| ours | 100.0% | 89.0% | 6.0% | 0.0% | 1.0% |
| ours2 | 100.0% | 90.5% | 33.0% | 6.5% | 0.0% |
| ours3 | 93.0% | 43.5% | 12.0% | 1.0% | 0.0% |

**Constraint violation of the picked design, by truth (of picks) / after independent re-evaluation at the floors (of picks)** (Rule P (the platform's verdict: Clopper–Pearson bounds pass both constraints))

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 5.7% / 3.4% | 3.3% / 3.3% | 0.5% / 0.0% | 0.0% / 0.0% | 0.5% / 1.0% |
| random | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.7% | 0.5% / 0.0% | 0.5% / 1.0% |
| halving | 0.7% / 0.7% | 0.6% / 0.6% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.5% |
| ocba | 22.2% / 22.2% | 8.9% / 8.9% | 3.6% / 3.6% | 1.6% / 1.1% | 2.0% / 2.0% |
| ours | n/a / n/a | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.5% | 0.5% / 0.5% |
| ours2 | n/a / n/a | 0.0% / 0.0% | 0.7% / 0.7% | 0.0% / 0.0% | 0.0% / 0.0% |
| ours3 | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% | 0.0% / 0.0% |

**Budget to success within ε** (smallest budget at which at least 80.0% of seeds succeed, Rule P): grid 160k, random 320k, halving 80k, ocba 320k, ours 160k, ours2 320k, ours3 160k

**Trials actually spent (median) at each budget**

| Arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | 40k | 80k | 160k | 320k | 640k |
| random | 25k | 75k | 150k | 300k | 625k |
| halving | 40k | 80k | 160k | 320k | 640k |
| ocba | 40k | 80k | 160k | 320k | 640k |
| ours | 39k | 80k | 157k | 260k | 260k |
| ours2 | 35k | 74k | 151k | 214k | 255k |
| ours3 | 38k | 76k | 142k | 163k | 218k |

**ours against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-24 pts [-30, -18]) | worse (-20 pts [-28, -12]) | better (27 pts [17, 35]) | better (18 pts [9, 28]) | equal (2 pts [-7, 12]) |
| random | equal (-2 pts [-5, 0]) | equal (2 pts [-4, 8]) | better (47 pts [38, 55]) | better (37 pts [28, 46]) | better (10 pts [1, 19]) |
| halving | worse (-23 pts [-29, -17]) | worse (-21 pts [-28, -13]) | better (17 pts [7, 26]) | equal (4 pts [-5, 13]) | worse (-14 pts [-22, -6]) |
| ocba | worse (-17 pts [-22, -12]) | worse (-17 pts [-24, -9]) | better (33 pts [23, 42]) | better (21 pts [12, 31]) | equal (5 pts [-4, 14]) |
| ours2 | equal (0 pts [-2, 2]) | equal (2 pts [-4, 7]) | better (16 pts [6, 25]) | equal (7 pts [-2, 16]) | equal (6 pts [-3, 16]) |
| ours3 | worse (-12 pts [-17, -8]) | worse (-33 pts [-40, -24]) | equal (7 pts [-3, 16]) | equal (-3 pts [-12, 6]) | equal (-6 pts [-15, 3]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-4, 1]) | better (9 pts [4, 14]) | better (62 pts [53, 68]) | better (41 pts [31, 49]) | better (10 pts [2, 18]) |
| random | equal (-2 pts [-4, 1]) | equal (3 pts [-3, 9]) | better (57 pts [49, 65]) | better (47 pts [38, 55]) | better (10 pts [2, 18]) |
| halving | worse (-6 pts [-10, -3]) | worse (-11 pts [-18, -3]) | better (28 pts [18, 36]) | better (11 pts [3, 19]) | equal (1 pts [-6, 8]) |
| ocba | equal (-2 pts [-5, 0]) | equal (5 pts [-1, 11]) | better (56 pts [47, 63]) | better (46 pts [36, 53]) | better (17 pts [9, 26]) |
| ours2 | equal (0 pts [-2, 2]) | equal (2 pts [-5, 8]) | better (10 pts [1, 19]) | worse (-11 pts [-18, -4]) | worse (-14 pts [-19, -8]) |
| ours3 | worse (-7 pts [-11, -3]) | worse (-36 pts [-44, -28]) | equal (4 pts [-5, 12]) | worse (-15 pts [-21, -9]) | worse (-10 pts [-16, -4]) |

Check: ours's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours's stop reasons: 40k no_feasible_beneficial_candidate x56; 40k inconclusive_at_precision x144; 80k no_feasible_beneficial_candidate x13; 80k inconclusive_at_precision x165; 80k acceptable_precision x22; 160k acceptable_precision x188; 160k inconclusive_at_precision x12; 320k acceptable_precision x200; 640k acceptable_precision x198; 640k inconclusive_at_precision x2.


**ours2 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-24 pts [-30, -18]) | worse (-22 pts [-29, -14]) | better (10 pts [1, 20]) | better (12 pts [2, 21]) | equal (-4 pts [-13, 5]) |
| random | equal (-2 pts [-5, 0]) | equal (0 pts [-5, 6]) | better (31 pts [22, 39]) | better (31 pts [21, 39]) | equal (4 pts [-6, 13]) |
| halving | worse (-23 pts [-29, -17]) | worse (-22 pts [-29, -14]) | equal (1 pts [-9, 11]) | equal (-3 pts [-12, 6]) | worse (-20 pts [-29, -12]) |
| ocba | worse (-17 pts [-22, -12]) | worse (-19 pts [-26, -11]) | better (17 pts [7, 26]) | better (15 pts [5, 24]) | equal (-2 pts [-11, 8]) |
| ours | equal (0 pts [-2, 2]) | equal (-2 pts [-7, 4]) | worse (-16 pts [-25, -6]) | equal (-7 pts [-16, 2]) | equal (-6 pts [-16, 3]) |
| ours3 | worse (-12 pts [-17, -8]) | worse (-34 pts [-42, -26]) | equal (-9 pts [-19, 0]) | worse (-10 pts [-19, -1]) | worse (-13 pts [-21, -3]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | equal (-2 pts [-4, 1]) | better (7 pts [2, 12]) | better (52 pts [43, 59]) | better (52 pts [43, 59]) | better (24 pts [17, 30]) |
| random | equal (-2 pts [-4, 1]) | equal (2 pts [-4, 7]) | better (48 pts [39, 55]) | better (58 pts [50, 65]) | better (24 pts [18, 31]) |
| halving | worse (-6 pts [-10, -3]) | worse (-12 pts [-19, -5]) | better (18 pts [8, 27]) | better (22 pts [14, 29]) | better (15 pts [9, 20]) |
| ocba | equal (-2 pts [-5, 0]) | equal (4 pts [-2, 9]) | better (46 pts [37, 54]) | better (57 pts [48, 64]) | better (31 pts [24, 38]) |
| ours | equal (0 pts [-2, 2]) | equal (-2 pts [-8, 5]) | worse (-10 pts [-19, -1]) | better (11 pts [4, 18]) | better (14 pts [8, 19]) |
| ours3 | worse (-7 pts [-11, -3]) | worse (-38 pts [-45, -29]) | equal (-6 pts [-16, 3]) | equal (-4 pts [-9, 1]) | equal (4 pts [-1, 8]) |

Check: ours2's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours2's stop reasons: 40k budget_exhausted x200; 80k budget_exhausted x200; 160k acceptable_precision x68; 160k budget_exhausted x132; 320k acceptable_precision x176; 320k budget_exhausted x24; 640k acceptable_precision x200.


**ours3 against each other arm: probability of correct selection, 95% interval of the difference (better / equal / worse)**

Rule S:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | worse (-12 pts [-19, -4]) | better (13 pts [3, 22]) | better (20 pts [10, 29]) | better (21 pts [12, 30]) | equal (8 pts [-0, 17]) |
| random | better (10 pts [5, 15]) | better (35 pts [26, 42]) | better (41 pts [31, 49]) | better (41 pts [31, 49]) | better (16 pts [7, 25]) |
| halving | worse (-11 pts [-18, -3]) | better (12 pts [3, 21]) | better (10 pts [1, 20]) | equal (7 pts [-2, 16]) | worse (-8 pts [-16, -0]) |
| ocba | equal (-5 pts [-11, 2]) | better (15 pts [6, 24]) | better (26 pts [17, 36]) | better (25 pts [15, 33]) | better (11 pts [2, 20]) |
| ours | better (12 pts [8, 17]) | better (33 pts [24, 40]) | equal (-7 pts [-16, 3]) | equal (3 pts [-6, 12]) | equal (6 pts [-3, 15]) |
| ours2 | better (12 pts [8, 17]) | better (34 pts [26, 42]) | equal (9 pts [-0, 19]) | better (10 pts [1, 19]) | better (13 pts [3, 21]) |

Rule P:

| Other arm | 40k | 80k | 160k | 320k | 640k |
| --- | --- | --- | --- | --- | --- |
| grid | better (5 pts [1, 9]) | better (44 pts [37, 52]) | better (58 pts [49, 65]) | better (55 pts [48, 62]) | better (20 pts [13, 27]) |
| random | better (5 pts [1, 9]) | better (39 pts [31, 47]) | better (54 pts [45, 61]) | better (62 pts [54, 69]) | better (20 pts [13, 27]) |
| halving | equal (1 pts [-4, 5]) | better (26 pts [16, 34]) | better (24 pts [14, 33]) | better (26 pts [19, 33]) | better (11 pts [5, 17]) |
| ocba | better (5 pts [0, 9]) | better (41 pts [33, 48]) | better (52 pts [44, 60]) | better (61 pts [53, 67]) | better (27 pts [20, 35]) |
| ours | better (7 pts [3, 11]) | better (36 pts [28, 44]) | equal (-4 pts [-12, 5]) | better (15 pts [9, 21]) | better (10 pts [4, 16]) |
| ours2 | better (7 pts [3, 11]) | better (38 pts [29, 45]) | equal (6 pts [-3, 16]) | equal (4 pts [-1, 9]) | equal (-4 pts [-8, 1]) |

Check: ours3's own verdict and the rule-P pick recomputed from its final estimates disagreed in 0 of 1000 runs.

ours3's stop reasons: 40k budget_exhausted x200; 80k budget_exhausted x193; 80k acceptable_precision x7; 160k acceptable_precision x104; 160k budget_exhausted x96; 320k budget_exhausted x15; 320k acceptable_precision x185; 640k acceptable_precision x200.

