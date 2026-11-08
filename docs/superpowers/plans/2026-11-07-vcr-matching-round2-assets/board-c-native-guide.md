# Board C: criterion-level label agreement

Agreement over all 1015 rows (missing counted wrong): ours 767/1015 = 75.6% [71.0%, 79.7%]; GPT-4 886/1015 = 87.3%.
Paired difference (ours minus GPT-4): -11.7 points [-15.9, -7.3] (patient bootstrap).
Answers: 1014 usable, 1 missing, 0 unrecognised.

| label | decisive | expert rows | ours predicted | ours precision | ours recall | GPT-4 precision | GPT-4 recall |
|---|---|---|---|---|---|---|---|
| included | yes | 150 | 186 | 76.9% | 95.3% | 97.1% | 90.0% |
| not included | yes | 23 | 66 | 28.8% | 82.6% | 69.2% | 78.3% |
| excluded | yes | 10 | 26 | 30.8% | 80.0% | 62.5% | 100.0% |
| not excluded |  | 484 | 573 | 80.3% | 95.0% | 97.2% | 85.5% |
| not applicable |  | 55 | 51 | 66.7% | 61.8% | 45.4% | 98.2% |
| not enough information |  | 293 | 112 | 92.0% | 35.2% | 88.2% | 87.0% |

False favourable (ours / GPT-4): 138 / 15; wider definition 156 / 16.

Silent rows (610; ours correct 460, GPT-4 536):

| basis | rows | correct | false favourable |
|---|---|---|---|
| (missing) | 1 | 0 | 0 |
| inferred | 123 | 76 | 19 |
| silent | 451 | 354 | 67 |
| stated | 35 | 30 | 0 |

Completion: 53 of 53 patients have a record, 53 finished; 105 of 105 pairs have answers; failed by code -.

