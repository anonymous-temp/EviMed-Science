### Board E: TREC CT 2022 full corpus (375,580 trials), dev topics; official measures, unjudged = not relevant

Patients/topics scored: 10 (2022 10). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.575** | [0.388, 0.752] | 0.530 | 0.742 | 0.590 | 0.908 |  | this run (saved outputs) |
| 2 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.567** | [0.396, 0.716] | 0.480 | 0.638 | 0.650 | 0.852 |  | this run (saved outputs) |
| 3 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.549** | [0.369, 0.722] | 0.510 | 0.719 | 0.550 | 0.908 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.477** | [0.322, 0.629] | 0.380 | 0.617 | 0.570 | 0.787 |  | this run (saved outputs) |
| 5 | 1–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.459** | [0.274, 0.636] | 0.380 | 0.547 | 0.540 | 0.774 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2022 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.575 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.567 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.549 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.477 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.459 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.008 | [-0.076, +0.062] | 0.417 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.026 | [-0.058, +0.003] | 0.044 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.098 | [-0.232, +0.022] | 0.059 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.116 | [-0.236, -0.018] | 0.007 |
