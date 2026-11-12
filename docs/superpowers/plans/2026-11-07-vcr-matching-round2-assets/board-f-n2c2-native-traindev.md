# Board F: n2c2 2018 Track 1, split train-dev

Real de-identified notes; aggregates only. Readings: (a) no yes or no is wrong; (b) it is not met; (c) as (b) but ENGLISH and MAKES-DECISIONS met; (d) it is met.
Patient bootstrap, 2000 resamples, 95% percentile intervals. Patients scored: 40 of 40 in the split (520 pairs).

Accuracy (a): 0.917 [0.892, 0.942]. Unknown share: 0.015 [0.006, 0.025] {'not enough information': 8}.

| reading | accuracy | micro F1 (official) | macro F1 (official) |
|---|---|---|---|
| (b) | 0.931 [0.908, 0.954] | 0.930 [0.905, 0.953] (0.930) | 0.876 (0.876) |
| (c) primary | 0.931 [0.908, 0.954] | 0.930 [0.905, 0.953] (0.930) | 0.876 (0.876) |
| (d) | 0.919 [0.892, 0.944] | 0.918 [0.891, 0.944] (0.918) | 0.861 (0.861) |
| majority baseline | 0.767 | 0.764 | 0.428 |

| criterion | gold met | unknown | acc (a) | acc (b) | acc (c) | acc (d) | F1 (b) | F1 (c) | F1 (d) |
|---|---|---|---|---|---|---|---|---|---|
| ABDOMINAL | 13 | 0.00 | 0.95 | 0.95 | 0.95 | 0.95 | 0.95 | 0.95 | 0.95 |
| ADVANCED-CAD | 24 | 0.03 | 0.72 | 0.75 | 0.75 | 0.72 | 0.69 | 0.69 | 0.64 |
| ALCOHOL-ABUSE | 3 | 0.00 | 0.97 | 0.97 | 0.97 | 0.97 | 0.92 | 0.92 | 0.92 |
| ASP-FOR-MI | 27 | 0.00 | 0.88 | 0.88 | 0.88 | 0.88 | 0.84 | 0.84 | 0.84 |
| CREATININE | 12 | 0.10 | 0.88 | 0.97 | 0.97 | 0.88 | 0.97 | 0.97 | 0.86 |
| DIETSUPP-2MOS | 21 | 0.00 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 |
| DRUG-ABUSE | 4 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ENGLISH | 39 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| HBA1C | 11 | 0.05 | 0.93 | 0.95 | 0.95 | 0.95 | 0.94 | 0.94 | 0.94 |
| KETO-1YR | 0 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.50 | 0.50 | 0.50 |
| MAJOR-DIABETES | 18 | 0.00 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 | 0.82 |
| MAKES-DECISIONS | 38 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| MI-6MOS | 5 | 0.03 | 0.95 | 0.97 | 0.97 | 0.95 | 0.94 | 0.94 | 0.89 |

The model's yes and no by basis: {'silent': 192, 'inferred': 168, 'stated': 152} (`stated` has a sentence behind it, `silent` has none).
Completion: 40 of 40 patients have a record, 40 complete; failed by code {}; tokens in 3678749, out 530491, cost CNY 11.80.
