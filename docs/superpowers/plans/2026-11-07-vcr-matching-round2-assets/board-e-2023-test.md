### Board E: TREC CT 2023 full corpus (451,538 trials), test topics; official measures, unjudged = not relevant

Patients/topics scored: 28 (2023 28). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.485** | [0.400, 0.573] | 0.436 | 0.710 | 0.511 | 0.890 |  | this run (saved outputs) |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.474** | [0.391, 0.556] | 0.418 | 0.725 | 0.489 | 0.879 |  | this run (saved outputs) |
| 3 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.454** | [0.373, 0.540] | 0.321 | 0.520 | 0.586 | 0.757 |  | this run (saved outputs) |
| 4 | 1–6 | Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | historical | FTS5 + qwen3-rerank + Flash | **0.366** | [0.267, 0.470] | 0.346 | 0.521 | 0.404 | 0.855 |  | this run (saved outputs) |
| 5 | 1–6 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.354** | [0.293, 0.413] | 0.225 | 0.388 | 0.525 | 0.698 |  | this run (saved outputs) |
| 6 | 4–6 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.257** | [0.176, 0.345] | 0.211 | 0.418 | 0.300 | 0.797 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2023 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.485 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.474 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.454 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | 0.366 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.354 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.257 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.012 | [-0.038, +0.013] | 0.182 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.031 | [-0.091, +0.030] | 0.154 |
| Previous pipeline, 11-05 (lexical → qwen3-rerank → Flash fit on top 100) | -0.119 | [-0.213, -0.025] | 0.006 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.132 | [-0.204, -0.058] | 0.000 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.228 | [-0.307, -0.147] | 0.000 |
