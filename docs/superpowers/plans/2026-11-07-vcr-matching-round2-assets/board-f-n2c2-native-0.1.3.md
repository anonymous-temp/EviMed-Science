# Board F: n2c2 2018 Track 1, split test

Real de-identified notes; aggregates only. Readings: (a) no yes or no is wrong; (b) it is not met; (c) as (b) but ENGLISH and MAKES-DECISIONS met; (d) it is met.
Patient bootstrap, 2000 resamples, 95% percentile intervals. Patients scored: 86 of 86 in the split (1118 pairs).

Accuracy (a): 0.745 [0.702, 0.784]. Unknown share: 0.175 [0.134, 0.220] {'not enough information': 142, 'not applicable': 2, 'no answer': 52}.

| reading | accuracy | micro F1 (official) | macro F1 (official) |
|---|---|---|---|
| (b) | 0.877 [0.853, 0.898] | 0.872 [0.847, 0.895] (0.872) | 0.784 (0.783) |
| (c) primary | 0.897 [0.879, 0.914] | 0.894 [0.876, 0.912] (0.894) | 0.801 (0.801) |
| (d) | 0.789 [0.758, 0.817] | 0.789 [0.758, 0.817] (0.789) | 0.658 (0.658) |
| majority baseline | 0.765 | 0.761 | 0.427 |

| criterion | gold met | unknown | acc (a) | acc (b) | acc (c) | acc (d) | F1 (b) | F1 (c) | F1 (d) |
|---|---|---|---|---|---|---|---|---|---|
| ABDOMINAL | 30 | 0.06 | 0.86 | 0.91 | 0.91 | 0.87 | 0.90 | 0.90 | 0.87 |
| ADVANCED-CAD | 45 | 0.05 | 0.66 | 0.69 | 0.69 | 0.69 | 0.67 | 0.67 | 0.66 |
| ALCOHOL-ABUSE | 3 | 0.15 | 0.84 | 0.99 | 0.99 | 0.84 | 0.93 | 0.93 | 0.60 |
| ASP-FOR-MI | 68 | 0.05 | 0.81 | 0.84 | 0.84 | 0.84 | 0.72 | 0.72 | 0.68 |
| CREATININE | 24 | 0.29 | 0.60 | 0.86 | 0.86 | 0.64 | 0.83 | 0.83 | 0.63 |
| DIETSUPP-2MOS | 44 | 0.38 | 0.48 | 0.80 | 0.80 | 0.53 | 0.80 | 0.80 | 0.42 |
| DRUG-ABUSE | 3 | 0.14 | 0.85 | 0.99 | 0.99 | 0.85 | 0.93 | 0.93 | 0.62 |
| ENGLISH | 73 | 0.21 | 0.77 | 0.77 | 0.98 | 0.98 | 0.69 | 0.95 | 0.95 |
| HBA1C | 35 | 0.52 | 0.44 | 0.94 | 0.94 | 0.47 | 0.94 | 0.94 | 0.42 |
| KETO-1YR | 0 | 0.06 | 0.93 | 0.99 | 0.99 | 0.93 | 0.50 | 0.50 | 0.48 |
| MAJOR-DIABETES | 43 | 0.20 | 0.69 | 0.80 | 0.80 | 0.77 | 0.80 | 0.80 | 0.76 |
| MAKES-DECISIONS | 83 | 0.10 | 0.86 | 0.88 | 0.94 | 0.94 | 0.66 | 0.63 | 0.63 |
| MI-6MOS | 8 | 0.07 | 0.90 | 0.94 | 0.94 | 0.92 | 0.84 | 0.84 | 0.82 |

The model's yes and no by basis: {'stated': 364, 'inferred': 346, 'silent': 212} (`stated` has a sentence behind it, `silent` has none).
Completion: 86 of 86 patients have a record, 82 complete; failed by code {'patient_matching_native_decision_failed': 4}; tokens in 7458815, out 1158240, cost CNY 24.79.
