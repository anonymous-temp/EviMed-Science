### Board E: TREC CT 2021 full corpus (375,580 trials), all topics; official measures, unjudged = not relevant

Patients/topics scored: 75 (2021 75). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.563** | [0.498, 0.624] | 0.495 | 0.756 | 0.605 | 0.853 |  | this run (saved outputs) |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.559** | [0.491, 0.624] | 0.488 | 0.741 | 0.600 | 0.863 |  | this run (saved outputs) |
| 3 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.521** | [0.459, 0.581] | 0.396 | 0.697 | 0.635 | 0.776 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.511** | [0.453, 0.568] | 0.389 | 0.654 | 0.676 | 0.729 |  | this run (saved outputs) |
| 5 | 2–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.431** | [0.366, 0.494] | 0.323 | 0.611 | 0.572 | 0.682 |  | this run (saved outputs) |
| – | – | h2oloo monoT5'-CT (Waterloo), NQS + BM25/RM3 + monoT5 trained on TREC-style data | official TREC 2021, best automatic | T5-base fine-tuned | 0.712 | n/r | 0.593 | 0.816 | n/r | n/r |  | Pradeep et al. SIGIR 2022, Table 3 |
| – | – | TDMINER (manual run) | official TREC 2021, manual | human-curated concepts | 0.715 | n/r | 0.576 | 0.834 | n/r | n/r |  | TDMINER TREC 2021 notebook |
| – | – | damoebrtog (Alibaba DAMO) | official TREC 2021, 2nd team | - | 0.595 | n/r | 0.409 | 0.608 | n/r | n/r |  | Pradeep et al. Table 3 |
| – | – | CSIROmed_inc | official TREC 2021, 3rd team | - | 0.532 | n/r | 0.317 | n/r | n/r | n/r |  | Pradeep et al. Table 3 |
| – | – | Kusa et al. BM25+ entities + age/sex filter | post-hoc, no neural | BM25+ | 0.513 | n/r | 0.337 | 0.604 | n/r | n/r |  | Kusa et al. JBI 2023, Table 4 |
| – | – | Peikos et al. ChatGPT IEMT + RM3 | post-hoc | gpt-3.5-turbo + BM25 | 0.512 | n/r | 0.323 | 0.541 | n/r | n/r |  | Peikos et al. arXiv 2306.02077, Table 15 |
| – | – | BM25 on the raw note | baseline | BM25 | 0.469 | n/r | 0.264 | 0.471 | n/r | n/r |  | Peikos et al. |
| – | – | TREC 2021 median of automatic runs | track median | - | 0.304 | n/r | 0.161 | 0.294 | n/r | n/r |  | Pradeep et al. / TDMINER |

Per cohort (nDCG@10):

| System | 2021 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.563 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.559 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.521 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.511 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.431 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.004 | [-0.021, +0.013] | 0.310 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.042 | [-0.077, -0.007] | 0.009 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.051 | [-0.102, -0.002] | 0.022 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.132 | [-0.186, -0.079] | 0.000 |
