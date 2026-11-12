### Board E: TREC CT 2023 full corpus (451,538 trials), all topics; official measures, unjudged = not relevant

Patients/topics scored: 37 (2023 37). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.511** | [0.437, 0.583] | 0.459 | 0.767 | 0.541 | 0.886 |  | this run (saved outputs) |
| 2 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.504** | [0.433, 0.573] | 0.451 | 0.778 | 0.524 | 0.872 |  | this run (saved outputs) |
| 3 | 1–4 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.498** | [0.427, 0.569] | 0.370 | 0.583 | 0.605 | 0.774 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.380** | [0.324, 0.437] | 0.265 | 0.459 | 0.535 | 0.696 |  | this run (saved outputs) |
| 5 | 4–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.275** | [0.202, 0.356] | 0.241 | 0.426 | 0.316 | 0.779 |  | this run (saved outputs) |
| – | – | CSIROmed qe_prr_ft (query expansion + fine-tuned GPT-3.5 rerank) | official TREC 2023 | GPT-3.5 fine-tuned | 0.738 | n/r | 0.527 | 0.667 | n/r | n/r |  | CSIROmed TREC 2023 notebook, Table 1 |
| – | – | IELAB GPT-4 rerank of top 20 | official TREC 2023 | GPT-4 + cross-encoder | 0.736 | n/r | 0.511 | n/r | n/r | n/r |  | IELAB TREC 2023 notebook, Table 2 |
| – | – | DoSSIER_3 | official TREC 2023 | - | 0.684 | n/r | 0.584 | 0.642 | n/r | n/r |  | DoSSIER TREC 2023 notebook, Table 2 |
| – | – | IELAB CE_weighted | official TREC 2023 | cross-encoder | 0.672 | n/r | 0.443 | n/r | n/r | n/r |  | IELAB notebook |
| – | – | CSIROmed bm25_bsln | official TREC 2023 baseline | BM25 | 0.619 | n/r | 0.330 | 0.563 | n/r | n/r |  | CSIROmed notebook |
| – | – | IELAB dense retrieval only | official TREC 2023 | dense retriever | 0.577 | n/r | 0.324 | n/r | n/r | n/r |  | IELAB notebook |
| – | – | TREC 2023 median | track median | - | 0.648 | n/r | 0.394 | 0.538 | n/r | n/r |  | DoSSIER / CSIROmed notebooks |

Per cohort (nDCG@10):

| System | 2023 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.511 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.504 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.498 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.380 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.275 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.007 | [-0.029, +0.015] | 0.279 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.013 | [-0.066, +0.042] | 0.323 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.131 | [-0.193, -0.065] | 0.000 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.236 | [-0.307, -0.159] | 0.000 |
