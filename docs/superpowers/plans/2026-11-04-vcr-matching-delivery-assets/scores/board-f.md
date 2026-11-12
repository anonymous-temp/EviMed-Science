# Board F: n2c2 2018 Track 1, split test

Real de-identified notes; aggregates only. Readings: (a) no yes or no is wrong; (b) it is not met; (c) as (b) but ENGLISH and MAKES-DECISIONS met; (d) it is met.
Patient bootstrap, 2000 resamples, 95% percentile intervals. Patients scored: 86 of 86 in the split (1118 pairs).

Accuracy (a): 0.545 [0.516, 0.574]. Unknown share: 0.395 [0.366, 0.425] {'not enough information': 440, 'not applicable': 2}.

| reading | accuracy | micro F1 (official) | macro F1 (official) |
|---|---|---|---|
| (b) | 0.876 [0.859, 0.892] | 0.871 [0.853, 0.887] (0.871) | 0.777 (0.777) |
| (c) primary | 0.924 [0.909, 0.938] | 0.922 [0.907, 0.937] (0.922) | 0.821 (0.821) |
| (d) | 0.609 [0.581, 0.637] | 0.594 [0.563, 0.622] (0.594) | 0.499 (0.499) |
| majority baseline | 0.765 | 0.761 | 0.427 |

| criterion | gold met | unknown | acc (a) | acc (b) | acc (c) | acc (d) | F1 (b) | F1 (c) | F1 (d) |
|---|---|---|---|---|---|---|---|---|---|
| ABDOMINAL | 30 | 0.57 | 0.40 | 0.93 | 0.93 | 0.43 | 0.92 | 0.92 | 0.39 |
| ADVANCED-CAD | 45 | 0.17 | 0.63 | 0.80 | 0.80 | 0.63 | 0.79 | 0.79 | 0.56 |
| ALCOHOL-ABUSE | 3 | 0.21 | 0.78 | 0.97 | 0.97 | 0.80 | 0.69 | 0.69 | 0.57 |
| ASP-FOR-MI | 68 | 0.06 | 0.81 | 0.86 | 0.86 | 0.83 | 0.73 | 0.73 | 0.59 |
| CREATININE | 24 | 0.23 | 0.69 | 0.91 | 0.91 | 0.70 | 0.89 | 0.89 | 0.69 |
| DIETSUPP-2MOS | 44 | 0.37 | 0.49 | 0.84 | 0.84 | 0.51 | 0.83 | 0.83 | 0.34 |
| DRUG-ABUSE | 3 | 0.44 | 0.56 | 1.00 | 1.00 | 0.56 | 1.00 | 1.00 | 0.42 |
| ENGLISH | 73 | 0.53 | 0.44 | 0.45 | 0.97 | 0.97 | 0.44 | 0.93 | 0.93 |
| HBA1C | 35 | 0.48 | 0.49 | 0.97 | 0.97 | 0.49 | 0.96 | 0.96 | 0.45 |
| KETO-1YR | 0 | 0.97 | 0.03 | 1.00 | 1.00 | 0.03 | 0.50 | 0.50 | 0.03 |
| MAJOR-DIABETES | 43 | 0.44 | 0.49 | 0.86 | 0.86 | 0.56 | 0.86 | 0.86 | 0.45 |
| MAKES-DECISIONS | 83 | 0.14 | 0.81 | 0.83 | 0.94 | 0.94 | 0.56 | 0.63 | 0.63 |
| MI-6MOS | 8 | 0.52 | 0.47 | 0.98 | 0.98 | 0.48 | 0.93 | 0.93 | 0.43 |

The model's yes and no by basis: {'stated': 675, 'silent': 1} (`stated` has a sentence behind it, `silent` has none).
Completion: 86 of 86 patients have a record, 86 complete; failed by code {}; tokens in 591822, out 830870, cost CNY 3.86.
