### Board E: TREC CT 2022 full corpus (375,580 trials), all topics; official measures, unjudged = not relevant

Patients/topics scored: 50 (2022 50). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.589** | [0.510, 0.668] | 0.532 | 0.799 | 0.688 | 0.802 |  | this run (saved outputs) |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.585** | [0.508, 0.660] | 0.526 | 0.809 | 0.676 | 0.801 |  | this run (saved outputs) |
| 3 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.542** | [0.464, 0.620] | 0.464 | 0.740 | 0.696 | 0.749 |  | this run (saved outputs) |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.529** | [0.454, 0.604] | 0.436 | 0.673 | 0.692 | 0.715 |  | this run (saved outputs) |
| 5 | 1–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.478** | [0.396, 0.560] | 0.408 | 0.556 | 0.642 | 0.679 |  | this run (saved outputs) |
| – | – | Jullien et al. GPT-4-turbo coarse-grained eligibility rerank | post-hoc, LLM rerank of a top-500 | GPT-4-turbo | 0.693 | n/r | 0.718 | 0.769 | n/r | n/r |  | arXiv 2409.18998, Table 2 |
| – | – | IELAB GPT-4 judge of CE top 20 | post-hoc | GPT-4 + cross-encoder | 0.659 | n/r | 0.568 | n/r | n/r | n/r |  | IELAB TREC 2023 notebook, Table 1 |
| – | – | h2oloo frocchio_monot5_e (Waterloo) | official TREC 2022, best run | T5 fine-tuned | 0.613 | n/r | 0.508 | 0.726 | n/r | n/r |  | TREC 2022 overview, Table 4 |
| – | – | Kusa et al. TCRR-Bio | post-hoc | BioBERT reranker | 0.604 | n/r | 0.482 | 0.672 | n/r | n/r |  | Kusa et al. JBI 2023, Table 5 |
| – | – | DoSSIER_5 | official TREC 2022, 2nd team | - | 0.556 | n/r | 0.456 | n/r | n/r | n/r |  | TREC 2022 overview, Table 4 |
| – | – | Peikos et al. ChatGPT NRIEMT + RM3 | post-hoc | gpt-3.5-turbo + BM25 | 0.509 | n/r | 0.372 | 0.623 | n/r | n/r |  | Peikos et al., Table 15 |
| – | – | CSIROmed monobert500 | official TREC 2022 | monoBERT | 0.491 | n/r | 0.362 | n/r | n/r | n/r |  | TREC 2022 overview |
| – | – | TREC 2022 median (two sources disagree: 0.392 / 0.498) | track median | - | 0.392 | n/r | 0.258 | 0.411 | n/r | n/r |  | Kusa et al. Table 5 (Jullien et al. give 0.498/0.380/0.598) |

Per cohort (nDCG@10):

| System | 2022 |
|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.589 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.585 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | 0.542 |
| Hybrid recall only (lexical ⊕ dense, RRF) | 0.529 |
| Lexical recall only (product FTS5, condition + ranked English terms) | 0.478 |

Paired differences, each system minus EviMed rrf-qwen-jev-v1 (Jev 1.13) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.005 | [-0.023, +0.013] | 0.309 |
| Hybrid recall → Qwen3.7 rerank (V3 policy) | -0.047 | [-0.088, -0.008] | 0.009 |
| Hybrid recall only (lexical ⊕ dense, RRF) | -0.061 | [-0.115, -0.003] | 0.019 |
| Lexical recall only (product FTS5, condition + ranked English terms) | -0.111 | [-0.168, -0.054] | 0.000 |
