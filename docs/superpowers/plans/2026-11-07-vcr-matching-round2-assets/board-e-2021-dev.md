### Board E: TREC CT 2021 full corpus (375,580 trials), dev topics; official measures, unjudged = not relevant

Patients/topics scored: 10 (2021 10). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.601** | [0.469, 0.731] | 0.420 | 0.692 | 0.820 | 0.727 |  | this run (saved outputs) |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.576** | [0.414, 0.721] | 0.470 | 0.816 | 0.640 | 0.788 |  | this run (saved outputs) |
| 3 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.563** | [0.393, 0.711] | 0.460 | 0.766 | 0.620 | 0.793 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.549** | [0.390, 0.702] | 0.410 | 0.555 | 0.760 | 0.739 |  | this run (saved outputs) |
| 5 | 1–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.437** | [0.301, 0.564] | 0.280 | 0.508 | 0.610 | 0.668 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2021 |
|---|---|
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.601 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.576 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.563 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.549 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.437 |

Paired differences, each system minus Hybrid recall only (lexical ⊕ dense, RRF) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | -0.025 | [-0.127, +0.087] | 0.320 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.038 | [-0.149, +0.076] | 0.254 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.051 | [-0.178, +0.057] | 0.201 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.163 | [-0.253, -0.076] | 0.000 |
