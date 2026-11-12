### Board A held-out topics (105 TREC 2021/2022 patients never read during selection)

Patients/topics scored: 105 (trec_2021 65, trec_2022 40). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (graded) | P@10 (eligible) | MRR | Excluded in top 10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–9 | EviMed + Flash z-fusion (all pairs) | hybrid + LLM on every pair | Qwen3.7 + Jev 1.14 + DeepSeek V4.1 Flash | **0.844** | [0.802, 0.882] | 0.831 | 0.798 | 0.913 | 0.066 | ≈¥1.1/patient | this run (saved outputs) |
| 2 | 1–10 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.14 | **0.839** | [0.794, 0.879] | 0.823 | 0.781 | 0.907 | 0.083 | ≈¥0.24/patient | this run (saved outputs) |
| 3 | 1–10 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.13 | **0.838** | [0.794, 0.877] | 0.824 | 0.783 | 0.901 | 0.083 | ≈¥0.24/patient | this run (saved outputs) |
| 4 | 1–10 | EviMed RRF → Flash reorders top 20 | cascade | Qwen3.7 + Jev 1.13 + Flash | **0.832** | [0.788, 0.871] | 0.820 | 0.785 | 0.892 | 0.071 | ≈¥0.29/patient | this run (saved outputs) |
| 5 | 1–10 | Jev 1.13 top 20 → Flash (11-05 cascade) | cascade | Jev 1.13 + Flash | **0.809** | [0.763, 0.852] | 0.800 | 0.775 | 0.882 | 0.051 | ≈¥0.21/patient | this run (saved outputs) |
| 6 | 1–10 | Flash fit only (score sort) | LLM pointwise | DeepSeek V4.1 Flash | **0.805** | [0.763, 0.844] | 0.795 | 0.761 | 0.881 | 0.069 | ≈¥0.89/patient | this run (saved outputs) |
| 7 | 1–10 | Jev 1.14 five-level fit | typed scorer | Jev 1.14 | **0.802** | [0.758, 0.844] | 0.789 | 0.765 | 0.896 | 0.048 | ≈¥0.16/patient | this run (saved outputs) |
| 8 | 1–10 | Jev 1.13 five-level fit | typed scorer | Jev 1.13 | **0.798** | [0.756, 0.838] | 0.784 | 0.760 | 0.896 | 0.048 | ≈¥0.16/patient | this run (saved outputs) |
| 9 | 1–10 | TrialGPT 2.0 method, DeepSeek V4.1 Flash | LLM pointwise (score + confidence) | DeepSeek V4.1 Flash | **0.793** | [0.749, 0.834] | 0.783 | 0.749 | 0.876 | 0.068 | ≈¥0.89/patient | this run (saved outputs) |
| 10 | 2–10 | Qwen3.7 rerank (V3 policy) | cross-encoder rerank | Qwen3.7-text-rerank | **0.762** | [0.719, 0.802] | 0.745 | 0.642 | 0.837 | 0.207 | ≈¥0.08/patient | this run (saved outputs) |

Per cohort (nDCG@10):

| System | trec_2021 | trec_2022 |
|---|---|---|
| EviMed + Flash z-fusion (all pairs) | 0.892 | 0.795 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.887 | 0.791 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.884 | 0.791 |
| EviMed RRF → Flash reorders top 20 | 0.885 | 0.779 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | 0.844 | 0.774 |
| Flash fit only (score sort) | 0.851 | 0.760 |
| Jev 1.14 five-level fit | 0.838 | 0.766 |
| Jev 1.13 five-level fit | 0.844 | 0.752 |
| TrialGPT 2.0 method, DeepSeek V4.1 Flash | 0.835 | 0.751 |
| Qwen3.7 rerank (V3 policy) | 0.785 | 0.740 |

Paired differences, each system minus EviMed + Flash z-fusion (all pairs) (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | -0.005 | [-0.019, +0.009] | 0.254 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | -0.006 | [-0.022, +0.010] | 0.225 |
| EviMed RRF → Flash reorders top 20 | -0.012 | [-0.023, -0.001] | 0.016 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | -0.035 | [-0.053, -0.017] | 0.000 |
| Flash fit only (score sort) | -0.039 | [-0.058, -0.019] | 0.000 |
| Jev 1.14 five-level fit | -0.042 | [-0.065, -0.018] | 0.000 |
| Jev 1.13 five-level fit | -0.046 | [-0.069, -0.024] | 0.000 |
| TrialGPT 2.0 method, DeepSeek V4.1 Flash | -0.051 | [-0.072, -0.029] | 0.000 |
| Qwen3.7 rerank (V3 policy) | -0.081 | [-0.112, -0.052] | 0.000 |

Paired differences, each system minus TrialGPT 2.0 method, DeepSeek V4.1 Flash (same resamples):

| System | Δ nDCG@10 | 95% CI | P(system > reference) |
|---|---|---|---|
| EviMed + Flash z-fusion (all pairs) | +0.051 | [+0.029, +0.072] | 1.000 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | +0.046 | [+0.019, +0.072] | 1.000 |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | +0.045 | [+0.016, +0.072] | 0.998 |
| EviMed RRF → Flash reorders top 20 | +0.039 | [+0.019, +0.058] | 1.000 |
| Jev 1.13 top 20 → Flash (11-05 cascade) | +0.016 | [+0.001, +0.032] | 0.978 |
| Flash fit only (score sort) | +0.012 | [+0.002, +0.023] | 0.991 |
| Jev 1.14 five-level fit | +0.009 | [-0.015, +0.035] | 0.773 |
| Jev 1.13 five-level fit | +0.005 | [-0.017, +0.028] | 0.666 |
| Qwen3.7 rerank (V3 policy) | -0.030 | [-0.063, +0.002] | 0.036 |
