### Board A: TrialGPT 2.0 judged-pair ranking (SIGIR 2016, TREC CT 2021, TREC CT 2022; all 183 patients, 75,061 pairs)

Patients/topics scored: 183 (sigir 58, trec_2021 75, trec_2022 50). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (graded) | P@10 (eligible) | MRR | Excluded in top 10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–9 | EviMed + Flash z-fusion (all pairs) | hybrid + LLM on every pair | Qwen3.7 + Jev 1.14 + DeepSeek V4.1 Flash | **0.791** | [0.762, 0.818] | 0.723 | 0.650 | 0.840 | 0.147 | ≈¥1.1/patient | this run (saved outputs) |
| 2 | 1–9 | EviMed RRF → Flash reorders top 20 | cascade | Qwen3.7 + Jev 1.13 + Flash | **0.777** | [0.745, 0.807] | 0.713 | 0.643 | 0.831 | 0.141 | ≈¥0.29/patient | this run (saved outputs) |
| 3 | 1–9 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.13 | **0.777** | [0.746, 0.807] | 0.714 | 0.636 | 0.823 | 0.156 | ≈¥0.24/patient | this run (saved outputs) |
| 4 | 1–9 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.14 | **0.775** | [0.743, 0.805] | 0.710 | 0.634 | 0.820 | 0.152 | ≈¥0.24/patient | this run (saved outputs) |
| 5 | 1–9 | Jev 1.13 top 20 → Flash (11-05 cascade) | cascade | Jev 1.13 + Flash | **0.764** | [0.732, 0.794] | 0.700 | 0.636 | 0.821 | 0.129 | ≈¥0.21/patient | this run (saved outputs) |
| 6 | 1–9 | Flash fit only (score sort) | LLM pointwise | DeepSeek V4.1 Flash | **0.762** | [0.731, 0.791] | 0.697 | 0.626 | 0.829 | 0.143 | ≈¥0.89/patient | this run (saved outputs) |
| 7 | 1–10 | Jev 1.13 five-level fit | typed scorer | Jev 1.13 | **0.755** | [0.723, 0.784] | 0.690 | 0.628 | 0.837 | 0.124 | ≈¥0.16/patient | this run (saved outputs) |
| 8 | 1–10 | Jev 1.14 five-level fit | typed scorer | Jev 1.14 | **0.751** | [0.719, 0.782] | 0.686 | 0.623 | 0.841 | 0.124 | ≈¥0.16/patient | this run (saved outputs) |
| 9 | 1–10 | TrialGPT 2.0 method, DeepSeek V4.1 Flash | LLM pointwise (score + confidence) | DeepSeek V4.1 Flash | **0.750** | [0.719, 0.780] | 0.684 | 0.612 | 0.824 | 0.143 | ≈¥0.89/patient | this run (saved outputs) |
| 10 | 7–10 | Qwen3.7 rerank (V3 policy) | cross-encoder rerank | Qwen3.7-text-rerank | **0.693** | [0.662, 0.723] | 0.637 | 0.515 | 0.718 | 0.243 | ≈¥0.08/patient | this run (saved outputs) |
| – | – | TrialGPT 2.0 | LLM pointwise | GPT-5.4 | 0.760 | n/r | 0.700 | n/r | 0.850 | n/r |  | arXiv 2609.01202v2 Fig. 5d/Supp. 3c (bar labels, low-confidence read) |
| – | – | TrialGPT 2.0 | LLM pointwise | Gemini-3.1-pro-preview | 0.760 | n/r | 0.690 | n/r | 0.840 | n/r |  | same (low-confidence read) |
| – | – | TrialGPT 1.0 (re-run in 2.0 paper) | LLM criterion-level | GPT-5.4 | 0.740 | n/r | 0.670 | n/r | 0.840 | n/r |  | same |
| – | – | TrialGPT 2.0 | LLM pointwise | GPT-4.1 | 0.720 | n/r | 0.660 | n/r | 0.800 | n/r |  | same |
| – | – | TrialGPT 1.0 (re-run in 2.0 paper) | LLM criterion-level | Gemini-3.1-pro-preview | 0.720 | n/r | 0.670 | n/r | 0.780 | n/r |  | same |
| – | – | TrialGPT 1.0 (re-run in 2.0 paper) | LLM criterion-level | GPT-4.1 | 0.680 | n/r | 0.630 | n/r | 0.730 | n/r |  | same |

Per cohort (nDCG@10):

| System | sigir | trec_2021 | trec_2022 |
|---|---|---|---|
| EviMed + Flash z-fusion (all pairs) | 0.668 | 0.887 | 0.818 |
| EviMed RRF → Flash reorders top 20 | 0.655 | 0.876 | 0.800 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.633 | 0.881 | 0.816 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.628 | 0.880 | 0.815 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | 0.654 | 0.841 | 0.796 |
| Flash fit only (score sort) | 0.651 | 0.845 | 0.789 |
| Jev 1.13 five-level fit | 0.647 | 0.837 | 0.780 |
| Jev 1.14 five-level fit | 0.634 | 0.831 | 0.788 |
| TrialGPT 2.0 method, DeepSeek V4.1 Flash | 0.651 | 0.830 | 0.768 |
| Qwen3.7 rerank (V3 policy) | 0.541 | 0.776 | 0.761 |

Paired differences, each system minus EviMed + Flash z-fusion (all pairs) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed RRF → Flash reorders top 20 | -0.014 | [-0.024, -0.004] | 0.003 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | -0.014 | [-0.028, -0.000] | 0.022 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.016 | [-0.029, -0.004] | 0.005 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | -0.027 | [-0.040, -0.015] | 0.000 |
| Flash fit only (score sort) | -0.029 | [-0.043, -0.015] | 0.000 |
| Jev 1.13 five-level fit | -0.037 | [-0.053, -0.020] | 0.000 |
| Jev 1.14 five-level fit | -0.040 | [-0.057, -0.023] | 0.000 |
| TrialGPT 2.0 method, DeepSeek V4.1 Flash | -0.041 | [-0.056, -0.027] | 0.000 |
| Qwen3.7 rerank (V3 policy) | -0.099 | [-0.122, -0.076] | 0.000 |

Paired differences, each system minus TrialGPT 2.0 method, DeepSeek V4.1 Flash (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed + Flash z-fusion (all pairs) | +0.041 | [+0.027, +0.056] | 1.000 |
| EviMed RRF → Flash reorders top 20 | +0.027 | [+0.013, +0.042] | 1.000 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | +0.027 | [+0.006, +0.049] | 0.993 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | +0.025 | [+0.004, +0.046] | 0.990 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | +0.014 | [+0.002, +0.026] | 0.991 |
| Flash fit only (score sort) | +0.012 | [+0.004, +0.020] | 0.999 |
| Jev 1.13 five-level fit | +0.005 | [-0.013, +0.023] | 0.702 |
| Jev 1.14 five-level fit | +0.001 | [-0.017, +0.020] | 0.555 |
| Qwen3.7 rerank (V3 policy) | -0.057 | [-0.083, -0.031] | 0.000 |
