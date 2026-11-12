# Board A: ranking against the qrels pools

Patient bootstrap, 10000 resamples, seed 20261104, 95% percentile intervals.
Official script means are shown; the intervals come from per-patient values that reproduce them.

## All patients

| cohort | patients | nDCG@10 | P@10 | MRR | MAP |
|---|---|---|---|---|---|
| sigir | 58 | 0.6573 [0.6025, 0.7094] | 0.4784 [0.4164, 0.5414] | 0.6984 [0.5948, 0.7976] | 0.5189 [0.4656, 0.5717] |
| macro (sigir) | | 0.6573 [0.6025, 0.7094] | 0.4784 [0.4164, 0.5414] | 0.6984 [0.5948, 0.7976] | 0.5189 [0.4656, 0.5717] |

## Dev topics

| cohort | patients | nDCG@10 | P@10 | MRR | MAP |
|---|---|---|---|---|---|
| sigir | 58 | 0.6573 [0.6031, 0.7097] | 0.4784 [0.4181, 0.5397] | 0.6984 [0.5952, 0.7961] | 0.5189 [0.4655, 0.5711] |
| macro (sigir) | | 0.6573 [0.6031, 0.7097] | 0.4784 [0.4181, 0.5397] | 0.6984 [0.5952, 0.7961] | 0.5189 [0.4655, 0.5711] |

## TrialGPT 1.0 paper subset (pairs its own retrieval judged)

| cohort | patients | nDCG@10 | P@10 | MRR | MAP |
|---|---|---|---|---|---|
| sigir | 58 | 0.6617 [0.6050, 0.7174] | 0.4681 [0.4043, 0.5319] | 0.6840 [0.5742, 0.7868] | 0.5305 [0.4735, 0.5867] |
| macro (sigir) | | 0.6617 [0.6050, 0.7174] | 0.4681 [0.4043, 0.5319] | 0.6840 [0.5742, 0.7868] | 0.5305 [0.4735, 0.5867] |

## Finished patients only

| cohort | patients | nDCG@10 | P@10 | MRR | MAP |
|---|---|---|---|---|---|
| sigir | 58 | 0.6573 [0.6023, 0.7084] | 0.4784 [0.4155, 0.5397] | 0.6984 [0.5946, 0.7944] | 0.5189 [0.4655, 0.5700] |
| macro (sigir) | | 0.6573 [0.6023, 0.7084] | 0.4784 [0.4155, 0.5397] | 0.6984 [0.5946, 0.7944] | 0.5189 [0.4655, 0.5700] |

## Completion

| cohort | patients | with a record | finished | pairs | judged | unjudged | failed by code |
|---|---|---|---|---|---|---|---|
| sigir | 58 | 58 | 58 | 3835 | 3835 | 0 | - |
