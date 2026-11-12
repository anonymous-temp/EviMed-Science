# Board F: n2c2 2018 Track 1, split test

Real de-identified notes; aggregates only. Readings: (a) no yes or no is wrong; (b) it is not met; (c) as (b) but ENGLISH and MAKES-DECISIONS met; (d) it is met.
Patient bootstrap, 2000 resamples, 95% percentile intervals. Patients scored: 86 of 86 in the split (1118 pairs).

Accuracy (a): 0.886 [0.848, 0.914]. Unknown share: 0.036 [0.010, 0.073] {'not enough information': 14, 'no answer': 26}.

| reading | accuracy | micro F1 (official) | macro F1 (official) |
|---|---|---|---|
| (b) | 0.909 [0.889, 0.926] | 0.907 [0.886, 0.923] (0.907) | 0.818 (0.819) |
| (c) primary | 0.912 [0.896, 0.928] | 0.910 [0.894, 0.926] (0.910) | 0.824 (0.825) |
| (d) | 0.898 [0.875, 0.918] | 0.897 [0.873, 0.916] (0.897) | 0.797 (0.797) |
| majority baseline | 0.765 | 0.761 | 0.427 |

| criterion | gold met | unknown | acc (a) | acc (b) | acc (c) | acc (d) | F1 (b) | F1 (c) | F1 (d) |
|---|---|---|---|---|---|---|---|---|---|
| ABDOMINAL | 30 | 0.02 | 0.84 | 0.86 | 0.86 | 0.84 | 0.85 | 0.85 | 0.83 |
| ADVANCED-CAD | 45 | 0.06 | 0.66 | 0.69 | 0.69 | 0.70 | 0.66 | 0.66 | 0.66 |
| ALCOHOL-ABUSE | 3 | 0.02 | 0.98 | 1.00 | 1.00 | 0.98 | 1.00 | 1.00 | 0.87 |
| ASP-FOR-MI | 68 | 0.02 | 0.85 | 0.85 | 0.85 | 0.87 | 0.71 | 0.71 | 0.74 |
| CREATININE | 24 | 0.05 | 0.85 | 0.88 | 0.88 | 0.86 | 0.86 | 0.86 | 0.84 |
| DIETSUPP-2MOS | 44 | 0.02 | 0.91 | 0.92 | 0.92 | 0.92 | 0.92 | 0.92 | 0.92 |
| DRUG-ABUSE | 3 | 0.02 | 0.97 | 0.99 | 0.99 | 0.97 | 0.93 | 0.93 | 0.82 |
| ENGLISH | 73 | 0.02 | 0.95 | 0.95 | 0.98 | 0.98 | 0.91 | 0.95 | 0.95 |
| HBA1C | 35 | 0.05 | 0.92 | 0.95 | 0.95 | 0.93 | 0.95 | 0.95 | 0.93 |
| KETO-1YR | 0 | 0.03 | 0.97 | 1.00 | 1.00 | 0.97 | 0.50 | 0.50 | 0.49 |
| MAJOR-DIABETES | 43 | 0.08 | 0.76 | 0.83 | 0.83 | 0.77 | 0.83 | 0.83 | 0.77 |
| MAKES-DECISIONS | 83 | 0.02 | 0.92 | 0.92 | 0.94 | 0.94 | 0.59 | 0.63 | 0.63 |
| MI-6MOS | 8 | 0.03 | 0.95 | 0.98 | 0.98 | 0.97 | 0.93 | 0.93 | 0.91 |

The model's yes and no by basis: {'stated': 352, 'silent': 366, 'inferred': 360} (`stated` has a sentence behind it, `silent` has none).
Completion: 86 of 86 patients have a record, 84 complete; failed by code {'patient_matching_native_decision_failed': 2}; tokens in 8342551, out 1174458, cost CNY 26.61.
