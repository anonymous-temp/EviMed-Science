# Board C: criterion-level label agreement

Agreement over all 1015 rows (missing counted wrong): ours 778/1015 = 76.7% [73.3%, 79.9%]; GPT-4 886/1015 = 87.3%.
Paired difference (ours minus GPT-4): -10.6 points [-15.2, -5.9] (patient bootstrap).
Answers: 1014 usable, 1 missing, 0 unrecognised.

| label | decisive | expert rows | ours predicted | ours precision | ours recall | GPT-4 precision | GPT-4 recall |
|---|---|---|---|---|---|---|---|
| included | yes | 150 | 156 | 87.8% | 91.3% | 97.1% | 90.0% |
| not included | yes | 23 | 42 | 40.5% | 73.9% | 69.2% | 78.3% |
| excluded | yes | 10 | 18 | 44.4% | 80.0% | 62.5% | 100.0% |
| not excluded |  | 484 | 499 | 82.4% | 84.9% | 97.2% | 85.5% |
| not applicable |  | 55 | 50 | 64.0% | 58.2% | 45.4% | 98.2% |
| not enough information |  | 293 | 249 | 69.5% | 59.0% | 88.2% | 87.0% |

False favourable (ours / GPT-4): 88 / 15; wider definition 107 / 16.

Silent rows (610; ours correct 453, GPT-4 536):

| basis | rows | correct | false favourable |
|---|---|---|---|
| (missing) | 1 | 0 | 0 |
| inferred | 59 | 29 | 10 |
| silent | 516 | 392 | 46 |
| stated | 34 | 32 | 0 |

Completion: 53 of 53 patients have a record, 53 finished; 105 of 105 pairs have answers; failed by code -.

