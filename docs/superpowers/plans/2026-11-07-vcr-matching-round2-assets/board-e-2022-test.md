### Board E: TREC CT 2022 full corpus (375,580 trials), test topics; official measures, unjudged = not relevant

Patients/topics scored: 40 (2022 40). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–6 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.593** | [0.509, 0.676] | 0.530 | 0.831 | 0.708 | 0.775 |  | this run (saved outputs) |
| 2 | 1–6 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.593** | [0.505, 0.680] | 0.532 | 0.814 | 0.713 | 0.776 |  | this run (saved outputs) |
| 3 | 1–6 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.542** | [0.455, 0.624] | 0.450 | 0.687 | 0.722 | 0.697 |  | this run (saved outputs) |
| 4 | 1–6 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.536** | [0.449, 0.622] | 0.460 | 0.765 | 0.708 | 0.724 |  | this run (saved outputs) |
| 5 | 1–6 | Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | historical | FTS5 + qwen3-rerank + Flash | **0.529** | [0.444, 0.612] | 0.483 | 0.708 | 0.675 | 0.741 |  | this run (saved outputs) |
| 6 | 1–6 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.483** | [0.391, 0.573] | 0.415 | 0.559 | 0.667 | 0.655 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2022 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.593 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.593 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.542 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.536 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | 0.529 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.483 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.14) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | -0.000 | [-0.020, +0.022] | 0.476 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.052 | [-0.113, +0.011] | 0.053 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.057 | [-0.101, -0.016] | 0.003 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | -0.065 | [-0.108, -0.021] | 0.002 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.111 | [-0.180, -0.042] | 0.001 |
