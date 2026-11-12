# Board C: criterion-level label agreement

Agreement over all 1015 rows (missing counted wrong): ours 803/1015 = 79.1% [75.0%, 82.9%]; GPT-4 886/1015 = 87.3%.
Paired difference (ours minus GPT-4): -8.2 points [-12.3, -3.9] (patient bootstrap).
Answers: 1006 usable, 9 missing, 0 unrecognised.

| label | decisive | expert rows | ours predicted | ours precision | ours recall | GPT-4 precision | GPT-4 recall |
|---|---|---|---|---|---|---|---|
| included | yes | 150 | 135 | 93.3% | 84.0% | 97.1% | 90.0% |
| not included | yes | 23 | 21 | 42.9% | 39.1% | 69.2% | 78.3% |
| excluded | yes | 10 | 19 | 42.1% | 80.0% | 62.5% | 100.0% |
| not excluded |  | 484 | 556 | 80.6% | 92.6% | 97.2% | 85.5% |
| not applicable |  | 55 | 46 | 71.7% | 60.0% | 45.4% | 98.2% |
| not enough information |  | 293 | 229 | 78.2% | 61.1% | 88.2% | 87.0% |

False favourable (ours / GPT-4): 98 / 15; wider definition 117 / 16.

Silent rows (610; ours correct 474, GPT-4 536):

| basis | rows | correct | false favourable |
|---|---|---|---|
| (missing) | 8 | 0 | 0 |
| silent | 437 | 349 | 67 |
| stated | 165 | 125 | 10 |

Completion: 53 of 53 patients have a record, 53 finished; 105 of 105 pairs have answers; failed by code -.

