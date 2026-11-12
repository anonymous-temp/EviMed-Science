### Board E: TREC CT 2021 full corpus (375,580 trials), test topics; official measures, unjudged = not relevant

Patients/topics scored: 65 (2021 65). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–6 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.561** | [0.489, 0.629] | 0.498 | 0.747 | 0.600 | 0.863 |  | this run (saved outputs) |
| 2 | 1–6 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.558** | [0.483, 0.631] | 0.492 | 0.737 | 0.597 | 0.874 |  | this run (saved outputs) |
| 3 | 1–6 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.516** | [0.447, 0.584] | 0.394 | 0.718 | 0.615 | 0.781 |  | this run (saved outputs) |
| 4 | 1–6 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.498** | [0.434, 0.560] | 0.385 | 0.649 | 0.654 | 0.730 |  | this run (saved outputs) |
| 5 | 1–6 | Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | historical | FTS5 + qwen3-rerank + Flash | **0.475** | [0.401, 0.550] | 0.434 | 0.599 | 0.531 | 0.819 |  | this run (saved outputs) |
| 6 | 1–6 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.429** | [0.360, 0.502] | 0.329 | 0.627 | 0.566 | 0.684 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2021 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.561 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.558 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.516 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.498 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | 0.475 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.429 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.003 | [-0.021, +0.016] | 0.378 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.044 | [-0.084, -0.006] | 0.013 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.063 | [-0.118, -0.008] | 0.012 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | -0.086 | [-0.128, -0.042] | 0.000 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.131 | [-0.190, -0.073] | 0.000 |
