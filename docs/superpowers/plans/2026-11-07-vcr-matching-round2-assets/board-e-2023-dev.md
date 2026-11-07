### Board E: TREC CT 2023 full corpus (451,538 trials), dev topics; official measures, unjudged = not relevant

Patients/topics scored: 9 (2023 9). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.636** | [0.552, 0.730] | 0.522 | 0.778 | 0.667 | 0.824 |  | this run (saved outputs) |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.600** | [0.487, 0.719] | 0.556 | 0.944 | 0.633 | 0.848 |  | this run (saved outputs) |
| 3 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.590** | [0.486, 0.714] | 0.533 | 0.944 | 0.633 | 0.874 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.463** | [0.347, 0.587] | 0.389 | 0.680 | 0.567 | 0.692 |  | this run (saved outputs) |
| 5 | 2–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.330** | [0.179, 0.505] | 0.333 | 0.451 | 0.367 | 0.722 |  | this run (saved outputs) |

Per cohort (nDCG@10):

| System | 2023 |
|---|---|
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.636 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.600 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.590 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.463 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.330 |

Paired differences, each system minus Hybrid recall → Qwen3.7 rerank (V3 policy) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.036 | [-0.163, +0.083] | 0.287 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | -0.046 | [-0.155, +0.071] | 0.209 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.173 | [-0.267, -0.083] | 0.000 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.306 | [-0.426, -0.189] | 0.000 |
