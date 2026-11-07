# Patient matching, round 2: the measured ranking architecture and every leaderboard

**Date:** 2026-11-07. **Branch:** `codex/vcr-match-delivery-20261104`. **Plugin:** core and native bundle 0.1.2 (worker 0.1.0 unchanged). Not published, not deployed.

**Owner direction (2026-11-07):** the earlier stop on leaderboards held only until the architecture was settled; Jev goes in; find the best architecture by experiment; use the current retrieval (Qwen3.7 hybrid) and build the TREC index for the leaderboards; delete what is unused; commit and push; list every result table and every compared system for the external technical report.

Machine-readable tables: [assets](2026-11-07-vcr-matching-round2-assets/). Earlier evidence stays where it was: [V1 diagnosis](2026-11-05-vcr-matching-next-phase.md), [V3 design](2026-11-05-vcr-matching-plugin-v3.md), [V3 execution](2026-11-05-vcr-matching-plugin-v3-execution.md).

## 1. The architecture the experiments chose

```text
patient record
  → lexical recall: product FTS5/BM25 over the condition and up to 32 ranked terms (Flash writes them), age/sex filter
  → dense recall: Qwen3.7 text embedding (1024-d) of the record against the plugin's trial index
  → reciprocal-rank fusion of the recall lists (depth 300 by default, at most 500)
  → Qwen3.7 text rerank of the fused list (relevance order)
  → Jev five-level typed fit of each candidate's whole record (eligibility-aware order)
  → final order = reciprocal-rank fusion of the rerank order and the Jev order   (policy rrf-qwen-jev-v1, k = 60)
  → native DSH managed Flash child: criterion-level eligibility, evidence and calculation tools, for the pairs the user assesses
```

What the measurements decided:

| Decision | Evidence |
|---|---|
| Ranking makes no reasoning-model call | On Board A a Flash trial-level score over the fused head added nothing on dev and −0.003 (top 10) / −0.006 (top 20) on held-out topics; on Board E dev it moved −0.04 (2021), +0.05 (2022), −0.10 (2023). Flash on every pair (z-fusion) gains +0.006 held-out on Board A at 4–5 times the cost |
| Jev is the second order, fused with Qwen | Qwen alone (the V3 policy) 0.762 held-out; Jev alone 0.798–0.802; their fusion 0.838–0.839 |
| Fusion, not a cascade | Jev top 20 → Flash (the 11-05 cascade) 0.809 held-out; Qwen→Jev→Flash cascades 0.80–0.81 on dev |
| Lexical recall gets the ranked terms back, in English | V3 sent the condition alone (eligible recall@500 0.476/0.469 in 2021/2022 against 0.559/0.634 with the terms); the old skill text also let the model write Chinese phrases for English records |
| Dense query without Qwen's query instruction | Dev recall@300 0.492/0.519/0.252 (2021/22/23) without it, 0.417/0.484/0.261 with it |
| Clinical eligibility never reorders the list | The native assessment labels each assessed pair; the benchmark scores the saved discovery order |

Implemented in `packages/patient-matching-core/src/ranking.mjs` (`RANKING_POLICY`, the Jev rubric, `trialRecordText`, `composeRanking`), `apps/server/src/patientMatchingModels.mjs` (`jevFit`, one request per candidate, eight in flight, a failed answer leaves that candidate to the rerank order), `apps/server/src/patientMatchingDiscovery.mjs` (terms, depth, stage orders) and three settings: `OPEN_SCIENCE_PATIENT_MATCHING_JEV_ENABLED` (default on), `…_DISCOVERY_DEPTH` and `…_JEV_DEPTH` (default 300). The production profile pins Jev 1.14 (the plugin's pinned model); 1.13 and 1.14 differ within their intervals on every board, so both rows are reported.

## 2. Board A — TrialGPT 2.0's judged-pair ranking protocol

SIGIR 2016 (58 patients), TREC CT 2021 (75), TREC CT 2022 (50): every judged trial of a patient is ranked, unjudged trials never enter, 75,061 pairs. Metrics are the official TrialGPT 2.0 evaluator's (`eval_trialgpt_rankings_qrels.py`, unchanged): nDCG@10 with gains 2/1/0, graded P@10 = Σ(grade/2)/10, MRR on the first eligible trial; cohort means, then their mean. The design was chosen on 78 dev patients (all SIGIR, ten TREC 2021, ten TREC 2022) with the rule written before the 105 held-out patients were read (`arch_search.py`, `CHOICE.json`). Every row below was computed from saved per-pair answers; a cascade orders exactly as a live run would. EviMed rows use the plugin's own `composeRanking` on those answers (`product_rank.mjs`).

### 2.1 All 183 patients (TrialGPT 2.0's own reporting unit)

Patients/topics scored: 183 (sigir 58, trec_2021 75, trec_2022 50). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (graded) | P@10 (eligible) | MRR | Excluded in top 10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–9 | EviMed + Flash z-fusion (all pairs) | hybrid + LLM on every pair | Qwen3.7 + Jev 1.14 + DeepSeek V4.1 Flash | **0.791** | [0.762, 0.818] | 0.723 | 0.650 | 0.840 | 0.147 | ≈¥1.1/patient | this run |
| 2 | 1–9 | EviMed RRF → Flash reorders top 20 | cascade | Qwen3.7 + Jev 1.13 + Flash | **0.777** | [0.745, 0.807] | 0.713 | 0.643 | 0.831 | 0.141 | ≈¥0.29/patient | this run |
| 3 | 1–9 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.13 | **0.777** | [0.746, 0.807] | 0.714 | 0.636 | 0.823 | 0.156 | ≈¥0.24/patient | this run |
| 4 | 1–9 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.14 | **0.775** | [0.743, 0.805] | 0.710 | 0.634 | 0.820 | 0.152 | ≈¥0.24/patient | this run |
| 5 | 1–9 | Jev 1.13 top 20 → Flash (11-05 cascade) | cascade | Jev 1.13 + Flash | **0.764** | [0.732, 0.794] | 0.700 | 0.636 | 0.821 | 0.129 | ≈¥0.21/patient | this run |
| 6 | 1–9 | Flash fit only (score sort) | LLM pointwise | DeepSeek V4.1 Flash | **0.762** | [0.731, 0.791] | 0.697 | 0.626 | 0.829 | 0.143 | ≈¥0.89/patient | this run |
| 7 | 1–10 | Jev 1.13 five-level fit | typed scorer | Jev 1.13 | **0.755** | [0.723, 0.784] | 0.690 | 0.628 | 0.837 | 0.124 | ≈¥0.16/patient | this run |
| 8 | 1–10 | Jev 1.14 five-level fit | typed scorer | Jev 1.14 | **0.751** | [0.719, 0.782] | 0.686 | 0.623 | 0.841 | 0.124 | ≈¥0.16/patient | this run |
| 9 | 1–10 | TrialGPT 2.0 method, DeepSeek V4.1 Flash | LLM pointwise (score + confidence) | DeepSeek V4.1 Flash | **0.750** | [0.719, 0.780] | 0.684 | 0.612 | 0.824 | 0.143 | ≈¥0.89/patient | this run |
| 10 | 7–10 | Qwen3.7 rerank (V3 policy) | cross-encoder rerank | Qwen3.7-text-rerank | **0.693** | [0.662, 0.723] | 0.637 | 0.515 | 0.718 | 0.243 | ≈¥0.08/patient | this run |
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

### 2.2 Held-out 105 patients (never read during selection)

Patients/topics scored: 105 (trec_2021 65, trec_2022 40). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (graded) | P@10 (eligible) | MRR | Excluded in top 10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–9 | EviMed + Flash z-fusion (all pairs) | hybrid + LLM on every pair | Qwen3.7 + Jev 1.14 + DeepSeek V4.1 Flash | **0.844** | [0.802, 0.882] | 0.831 | 0.798 | 0.913 | 0.066 | ≈¥1.1/patient | this run |
| 2 | 1–10 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.14 | **0.839** | [0.794, 0.879] | 0.823 | 0.781 | 0.907 | 0.083 | ≈¥0.24/patient | this run |
| 3 | 1–10 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | hybrid: rerank + typed fit, RRF | Qwen3.7-rerank + Jev 1.13 | **0.838** | [0.794, 0.877] | 0.824 | 0.783 | 0.901 | 0.083 | ≈¥0.24/patient | this run |
| 4 | 1–10 | EviMed RRF → Flash reorders top 20 | cascade | Qwen3.7 + Jev 1.13 + Flash | **0.832** | [0.788, 0.871] | 0.820 | 0.785 | 0.892 | 0.071 | ≈¥0.29/patient | this run |
| 5 | 1–10 | Jev 1.13 top 20 → Flash (11-05 cascade) | cascade | Jev 1.13 + Flash | **0.809** | [0.763, 0.852] | 0.800 | 0.775 | 0.882 | 0.051 | ≈¥0.21/patient | this run |
| 6 | 1–10 | Flash fit only (score sort) | LLM pointwise | DeepSeek V4.1 Flash | **0.805** | [0.763, 0.844] | 0.795 | 0.761 | 0.881 | 0.069 | ≈¥0.89/patient | this run |
| 7 | 1–10 | Jev 1.14 five-level fit | typed scorer | Jev 1.14 | **0.802** | [0.758, 0.844] | 0.789 | 0.765 | 0.896 | 0.048 | ≈¥0.16/patient | this run |
| 8 | 1–10 | Jev 1.13 five-level fit | typed scorer | Jev 1.13 | **0.798** | [0.756, 0.838] | 0.784 | 0.760 | 0.896 | 0.048 | ≈¥0.16/patient | this run |
| 9 | 1–10 | TrialGPT 2.0 method, DeepSeek V4.1 Flash | LLM pointwise (score + confidence) | DeepSeek V4.1 Flash | **0.793** | [0.749, 0.834] | 0.783 | 0.749 | 0.876 | 0.068 | ≈¥0.89/patient | this run |
| 10 | 2–10 | Qwen3.7 rerank (V3 policy) | cross-encoder rerank | Qwen3.7-text-rerank | **0.762** | [0.719, 0.802] | 0.745 | 0.642 | 0.837 | 0.207 | ≈¥0.08/patient | this run |

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

### 2.3 Per cohort (official evaluator, nDCG@10 / graded P@10 / MRR)

| System | SIGIR | TREC 2021 | TREC 2022 | TrialGPT 1.0 paper subset, macro nDCG@10 |
|---|---|---|---|---|
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 0.633 / 0.471 / 0.642 | 0.881 / 0.867 / 0.934 | 0.816 / 0.805 / 0.892 | 0.781 |
| EviMed rrf-qwen-jev-v1 (Jev 1.14) | 0.628 / 0.466 / 0.631 | 0.880 / 0.865 / 0.924 | 0.815 / 0.797 / 0.906 | 0.779 |
| EviMed + Flash z-fusion (all pairs) | 0.668 / 0.492 / 0.672 | 0.887 / 0.868 / 0.949 | 0.818 / 0.809 / 0.899 | 0.792 |
| TrialGPT 2.0 method on DeepSeek V4.1 Flash | 0.651 / 0.480 / 0.700 | 0.830 / 0.807 / 0.947 | 0.768 / 0.765 / 0.825 | 0.760 |
| Flash fit only (score sort) | 0.651 / 0.480 / 0.690 | 0.845 / 0.824 / 0.950 | 0.789 / 0.787 / 0.848 | 0.766 |
| Jev 1.13 five-level fit | 0.647 / 0.484 / 0.700 | 0.837 / 0.821 / 0.938 | 0.780 / 0.766 / 0.873 | 0.762 |
| Jev 1.14 five-level fit | 0.634 / 0.467 / 0.726 | 0.831 / 0.817 / 0.911 | 0.788 / 0.773 / 0.885 | 0.759 |
| Qwen3.7 rerank alone | 0.541 / 0.408 / 0.486 | 0.776 / 0.760 / 0.823 | 0.761 / 0.742 / 0.845 | 0.697 |
| TrialGPT 2.0, GPT-5.4 (reported) | 0.66 / 0.50 / – | 0.84 / 0.82 / – | 0.78 / 0.77 / – | – |
| TrialGPT 2.0, GPT-4.1 (reported) | 0.64 / 0.48 / – | 0.79 / 0.78 / – | 0.72 / 0.72 / – | – |
| TrialGPT 1.0 re-run, GPT-5.4 (reported) | 0.62 / 0.45 / – | 0.83 / 0.82 / – | 0.75 / 0.73 / – | – |
| TrialGPT 1.0 re-run, GPT-4.1 (reported) | 0.58 / 0.42 / – | 0.76 / 0.77 / – | 0.70 / 0.71 / – | – |
| TrialGPT 1.0, GPT-4, Nat Commun 2024 (reported, top-500 of its own retrieval) | – | – | – | 0.7275 |

SIGIR is the one cohort where an LLM on every pair still leads (0.651–0.668 against 0.633): its grades mean "would refer", which rewards reading every candidate. TREC is where the fusion gains most (+0.05 against the TrialGPT 2.0 method on the same backbone).

### 2.4 Cost and speed (measured)

| Stage | Tokens | Cost | Latency |
|---|---|---|---|
| Qwen3.7 rerank, whole Board A | 29.3 M | CNY 14.66 (CNY 0.08 per patient) | 2.6 s per 100-document request (p50) |
| Jev five-level fit, one question | ≈1,300 input tokens per pair | ≈USD 4.1 for the board (≈CNY 0.16 per patient) | 0.25 s per pair (p50), eight in flight |
| Flash trial-level fit, every pair (TrialGPT 2.0 method) | 1,621 in / 361 out per pair | CNY 161.73 (CNY 0.88 per patient, peak price) | — |

The chosen ranking costs about CNY 0.24 per patient, a quarter of the TrialGPT 2.0 method on the same backbone, and has no reasoning-model call in its path.

## 3. Board E — TREC Clinical Trials 2021, 2022, 2023 on the whole corpus

The real task: every trial of the frozen ClinicalTrials.gov snapshot (375,580 for 2021/2022, 451,538 for 2023), official qrels, official measures with an unjudged trial counted not relevant: nDCG@10 (gains 2/1/0), P@10 and RR on eligible trials only. TREC's own P@10 is eligible-only, so it is not Board A's graded P@10. Both snapshots were indexed for this run with the plugin's embedding profile (Qwen3.7 text embedding, 1024 dimensions, the balanced ranking view; CNY 40.06 and 48.31). Retrieval choices were made on the dev topics only (the first ten of each year; nine scorable in 2023); test is every other topic. The rows for EviMed use the plugin's `composeRanking` on saved answers; the first 300 fused candidates are reranked and scored by Jev.

**Read J@10 before comparing with TREC runs.** TREC pooled the submitted runs (2022: depth 40, 41 runs); a system built later finds trials no run retrieved, and each such trial in the top ten scores zero. Half of EviMed's 2023 top ten and a third of its 2021/2022 top ten were never judged. The condensed nDCG@10 (unjudged trials removed, Sakai 2007) is shown as an auxiliary view only; it is not comparable with TREC's official numbers either.

### 3.1 TREC CT 2021, all 75 topics

Patients/topics scored: 75 (2021 75). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.563** | [0.498, 0.624] | 0.495 | 0.756 | 0.605 | 0.853 |  | this run |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.559** | [0.491, 0.624] | 0.488 | 0.741 | 0.600 | 0.863 |  | this run |
| 3 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.521** | [0.459, 0.581] | 0.396 | 0.697 | 0.635 | 0.776 |  | this run |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.511** | [0.453, 0.568] | 0.389 | 0.654 | 0.676 | 0.729 |  | this run |
| 5 | 2–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.431** | [0.366, 0.494] | 0.323 | 0.611 | 0.572 | 0.682 |  | this run |
| – | – | h2oloo monoT5'-CT (Waterloo), NQS + BM25/RM3 + monoT5 trained on TREC-style data | official TREC 2021, best automatic | T5-base fine-tuned | 0.712 | n/r | 0.593 | 0.816 | n/r | n/r |  | Pradeep et al. SIGIR 2022, Table 3 |
| – | – | TDMINER (manual run) | official TREC 2021, manual | human-curated concepts | 0.715 | n/r | 0.576 | 0.834 | n/r | n/r |  | TDMINER TREC 2021 notebook |
| – | – | damoebrtog (Alibaba DAMO) | official TREC 2021, 2nd team | - | 0.595 | n/r | 0.409 | 0.608 | n/r | n/r |  | Pradeep et al. Table 3 |
| – | – | CSIROmed_inc | official TREC 2021, 3rd team | - | 0.532 | n/r | 0.317 | n/r | n/r | n/r |  | Pradeep et al. Table 3 |
| – | – | Kusa et al. BM25+ entities + age/sex filter | post-hoc, no neural | BM25+ | 0.513 | n/r | 0.337 | 0.604 | n/r | n/r |  | Kusa et al. JBI 2023, Table 4 |
| – | – | Peikos et al. ChatGPT IEMT + RM3 | post-hoc | gpt-3.5-turbo + BM25 | 0.512 | n/r | 0.323 | 0.541 | n/r | n/r |  | Peikos et al. arXiv 2306.02077, Table 15 |
| – | – | BM25 on the raw note | baseline | BM25 | 0.469 | n/r | 0.264 | 0.471 | n/r | n/r |  | Peikos et al. |
| – | – | TREC 2021 median of automatic runs | track median | - | 0.304 | n/r | 0.161 | 0.294 | n/r | n/r |  | Pradeep et al. / TDMINER |

### 3.2 TREC CT 2022, all 50 topics

Patients/topics scored: 50 (2022 50). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.589** | [0.510, 0.668] | 0.532 | 0.799 | 0.688 | 0.802 |  | this run |
| 2 | 1–5 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.585** | [0.508, 0.660] | 0.526 | 0.809 | 0.676 | 0.801 |  | this run |
| 3 | 1–5 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.542** | [0.464, 0.620] | 0.464 | 0.740 | 0.696 | 0.749 |  | this run |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.529** | [0.454, 0.604] | 0.436 | 0.673 | 0.692 | 0.715 |  | this run |
| 5 | 1–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.478** | [0.396, 0.560] | 0.408 | 0.556 | 0.642 | 0.679 |  | this run |
| – | – | Jullien et al. GPT-4-turbo coarse-grained eligibility rerank | post-hoc, LLM rerank of a top-500 | GPT-4-turbo | 0.693 | n/r | 0.718 | 0.769 | n/r | n/r |  | arXiv 2409.18998, Table 2 |
| – | – | IELAB GPT-4 judge of CE top 20 | post-hoc | GPT-4 + cross-encoder | 0.659 | n/r | 0.568 | n/r | n/r | n/r |  | IELAB TREC 2023 notebook, Table 1 |
| – | – | h2oloo frocchio_monot5_e (Waterloo) | official TREC 2022, best run | T5 fine-tuned | 0.613 | n/r | 0.508 | 0.726 | n/r | n/r |  | TREC 2022 overview, Table 4 |
| – | – | Kusa et al. TCRR-Bio | post-hoc | BioBERT reranker | 0.604 | n/r | 0.482 | 0.672 | n/r | n/r |  | Kusa et al. JBI 2023, Table 5 |
| – | – | DoSSIER_5 | official TREC 2022, 2nd team | - | 0.556 | n/r | 0.456 | n/r | n/r | n/r |  | TREC 2022 overview, Table 4 |
| – | – | Peikos et al. ChatGPT NRIEMT + RM3 | post-hoc | gpt-3.5-turbo + BM25 | 0.509 | n/r | 0.372 | 0.623 | n/r | n/r |  | Peikos et al., Table 15 |
| – | – | CSIROmed monobert500 | official TREC 2022 | monoBERT | 0.491 | n/r | 0.362 | n/r | n/r | n/r |  | TREC 2022 overview |
| – | – | TREC 2022 median (two sources disagree: 0.392 / 0.498) | track median | - | 0.392 | n/r | 0.258 | 0.411 | n/r | n/r |  | Kusa et al. Table 5 (Jullien et al. give 0.498/0.380/0.598) |

### 3.3 TREC CT 2023, all 37 scorable topics (3 of 40 have no qrels)

Patients/topics scored: 37 (2023 37). Primary metric nDCG@10; 95% CI: percentile bootstrap over patients within each cohort, 10,000 resamples, macro over cohorts.

| Rank | Rank spread | System | Type | Backbone | nDCG@10 | 95% CI | P@10 (eligible) | MRR | J@10 | condensed nDCG@10 | Cost | Source |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.13) | same, Jev 1.13 | Qwen3.7 embed+rerank, Jev 1.13 | **0.511** | [0.437, 0.583] | 0.459 | 0.767 | 0.541 | 0.886 |  | this run |
| 2 | 1–4 | EviMed rrf-qwen-jev-v1 (Jev 1.14) | hybrid recall → Qwen3.7 rerank ⊕ Jev, RRF | Qwen3.7 embed+rerank, Jev 1.14 | **0.504** | [0.433, 0.573] | 0.451 | 0.778 | 0.524 | 0.872 |  | this run |
| 3 | 1–4 | Hybrid recall → Qwen3.7 rerank (V3 policy) | rerank only | Qwen3.7 embed+rerank | **0.498** | [0.427, 0.569] | 0.370 | 0.583 | 0.605 | 0.774 |  | this run |
| 4 | 1–5 | Hybrid recall only (lexical ⊕ dense, RRF) | first stage | FTS5 BM25 + Qwen3.7 embedding | **0.380** | [0.324, 0.437] | 0.265 | 0.459 | 0.535 | 0.696 |  | this run |
| 5 | 4–5 | Lexical recall only (product FTS5, condition + ranked English terms) | first stage | FTS5 BM25 | **0.275** | [0.202, 0.356] | 0.241 | 0.426 | 0.316 | 0.779 |  | this run |
| – | – | CSIROmed qe_prr_ft (query expansion + fine-tuned GPT-3.5 rerank) | official TREC 2023 | GPT-3.5 fine-tuned | 0.738 | n/r | 0.527 | 0.667 | n/r | n/r |  | CSIROmed TREC 2023 notebook, Table 1 |
| – | – | IELAB GPT-4 rerank of top 20 | official TREC 2023 | GPT-4 + cross-encoder | 0.736 | n/r | 0.511 | n/r | n/r | n/r |  | IELAB TREC 2023 notebook, Table 2 |
| – | – | DoSSIER_3 | official TREC 2023 | - | 0.684 | n/r | 0.584 | 0.642 | n/r | n/r |  | DoSSIER TREC 2023 notebook, Table 2 |
| – | – | IELAB CE_weighted | official TREC 2023 | cross-encoder | 0.672 | n/r | 0.443 | n/r | n/r | n/r |  | IELAB notebook |
| – | – | CSIROmed bm25_bsln | official TREC 2023 baseline | BM25 | 0.619 | n/r | 0.330 | 0.563 | n/r | n/r |  | CSIROmed notebook |
| – | – | IELAB dense retrieval only | official TREC 2023 | dense retriever | 0.577 | n/r | 0.324 | n/r | n/r | n/r |  | IELAB notebook |
| – | – | TREC 2023 median | track median | - | 0.648 | n/r | 0.394 | 0.538 | n/r | n/r |  | DoSSIER / CSIROmed notebooks |

### 3.4 Held-out topics only, against the previous pipeline (11-05, same topics)

| Year (test topics) | EviMed rrf-qwen-jev-v1, Jev 1.14 | Jev 1.13 | Qwen rerank only (V3 policy) | Hybrid recall only | Previous pipeline 11-05 |
|---|---|---|---|---|---|
| 2021 (65) | 0.558 | 0.561 | 0.516 | 0.498 | 0.475 |
| 2022 (40) | 0.593 | 0.593 | 0.536 | 0.542 | 0.529 |
| 2023 (28) | 0.474 | 0.485 | 0.454 | 0.354 | 0.366 |

Eligible P@10 on the same test topics: 2021 0.492 / 0.498, 2022 0.530 / 0.532, 2023 0.418 / 0.436 (Jev 1.14 / 1.13). Full tables per year and split are in the assets (`board-e-<year>-{all,test,dev}.md`).

### 3.5 Standing against the track

- **2021:** 0.559–0.563 sits third among the teams' best automatic runs (h2oloo 0.712, DAMO 0.595, then EviMed; CSIROmed 0.532), above every post-track system listed without a model trained on TREC data, and far above the automatic median 0.304.
- **2022:** 0.585–0.589 sits between the official first (h2oloo 0.613) and second (DoSSIER 0.556); its eligible P@10 0.526–0.532 and RR 0.80–0.81 are above the official best run's 0.508 and 0.726. Two post-track GPT-4 systems score higher nDCG@10 (0.693, 0.659).
- **2023:** 0.504–0.511 is below the track median 0.648 on the official measure; its eligible P@10 0.451–0.459 is above the median 0.394. With half of the top ten unjudged this year is where pooling decides the most; the condensed view is 0.87–0.89.

No component was trained on TREC data. h2oloo's monoT5, CSIROmed's GPT-3.5 and Kusa's rerankers were fine-tuned on earlier TREC or SIGIR judgments.

### 3.6 What retrieval changed, measured on dev topics

| Change | Eligible recall@300, 2021 / 2022 / 2023 dev |
|---|---|
| Old lexical (condition + 32 terms, some written in Chinese) | 0.530 / 0.488 / 0.213 |
| Lexical with English terms | 0.532 / 0.547 / 0.192 |
| Dense alone: condition + record | 0.492 / 0.519 / 0.252 |
| Dense alone: with Qwen's query instruction | 0.417 / 0.484 / 0.261 |
| **Chosen: English lexical ⊕ dense (RRF)** | **0.550 / 0.577 / 0.246** |
| Whole-record BM25 (the classic TREC baseline), for reference | 0.216 / 0.319 / 0.151, but J@10 0.84 / 0.90 / 0.93 |

The whole-record BM25 list is what the TREC pools are made of (its top ten is almost all judged) and it finds far fewer eligible trials; adding it would have raised the official score by matching the pool, not by finding better trials, so it is not in the product.


## 4. Other boards

### 4.1 Board B — NIH-TrialBench target recall@10 (TrialGPT 2.0's fourth benchmark)

126 synthetic vignettes, each ranked against its own search space (101,682 pairs in all); the measure is whether the trial a vignette was written for is in the top ten, macro-averaged over the 11 NIH institutes as TrialGPT 2.0 reports it (the official `eval_nih_trialbench_target_recall_at10.py`). Every vignette is a test case; nothing was tuned on this board.

| System | Recall@10, institute macro | Recall@10, all cases | MRR | Source |
|---|---|---|---|---|
| Qwen3.7 rerank of the whole search space | **97.3%** | 94.4% (119/126) [90.5, 98.4] | 0.710 | this run |
| EviMed rrf-qwen-jev-v1 (Jev 1.14 on the rerank's first 100) | 96.0% | 89.7% (113/126) [84.1, 94.4] | 0.604 | this run |
| EviMed rrf-qwen-jev-v1 (Jev 1.13) | 95.7% | 88.9% (112/126) [83.3, 93.7] | 0.633 | this run |
| Previous path: qwen3-rerank first 100 → Flash fit (11-05) | 93.3% | 88.1% (111/126) | 0.506 | 11-05 frozen run |
| TrialGPT 2.0 (GPT-4.1) | 70% | – | – | arXiv 2609.01202v2 Fig. 5c |
| TrialGPT 1.0 | 54% | – | – | same |
| ChatGPT-5.5 Thinking (web interface) | 43% | – | – | same |
| Gemini-3.5 Flash Extended Thinking (web interface) | 21% | – | – | same |

This board asks for the one trial a vignette describes, which is a relevance question: the Jev fusion that wins on eligibility ranking (Boards A and E) costs 1.3 points of institute-macro recall here, mostly in NCI cases where several trials take the same patient. Every EviMed arm is above TrialGPT 2.0's 70%.

### 4.2 Criterion-level and cohort boards (the previous judge; the native clinical child is not yet replayed)

These measure the clinical judgment, not ranking. They were scored on 2026-11-05 with the previous batch judge (Flash, trial-level fit plus criterion stage), which still serves project-scoped studies. The V3 native clinical child has not been replayed on them in this round (its frozen replay harness needs a private configuration prepared on the machine that ran V3); this is listed under remaining work.

| Board | Metric | EviMed (previous judge, 11-05) | Comparators |
|---|---|---|---|
| C: TrialGPT criterion annotations (1,015 patient–criterion rows, 53 SIGIR patients) | label agreement | 79.1% [75.0, 82.9] | TrialGPT 1.0 GPT-4 87.3%; three physicians 88.7–90.0% (TrialGPT 1.0 paper). Annotators saw GPT-4's predictions, so the gold leans to GPT-4 (V1 diagnosis) |
| F: n2c2 2018 Track 1, official test (86 patients × 13 criteria) | overall micro-F1 (official evaluator) | 0.922 [0.907, 0.937] (reading c, named before scoring); macro 0.821 | GPT-4 zero-shot 0.93 micro / 0.81 macro (Wornow et al.); official winner Graz rule-based 0.9100; Michigan 0.9075; Sorbonne 0.9069; MedGemma-27b + RAG + LoRA 0.8905; GPT-3.5 0.82; Mixtral-8x7B 0.79; Llama-2-70b 0.67; class-prevalence baseline 0.76; 47 teams' median 0.8227 |

The n2c2 official test has been read once by the previous judge; a replay with the native child would be a second system on the same test, not an untouched holdout.


## 5. What was deleted (owner: 「没用的和历史的都不留」)

A read-only trace of every importer of the old path decided what could go now; the deletions are on this branch:

- five exports nothing referenced;
- the clause definition cards (an arm built and never switched on; production never created its table);
- the pre-2026-11-04 rules-based candidate trials (`vcrPatientTrials.mjs`, `vcrCandidateTrialStore.mjs`, the legacy patient page, four tables; production held no row) — `scripts/ops/vcr-retire-unread-tables.mjs --apply` retires the five tables after the release;
- V3's multi-candidate Jev priority fallback (replaced by the per-candidate fit) and `OPEN_SCIENCE_PATIENT_MATCHING_PRIORITY_ENABLED`.

**Kept on purpose:** the old batch judge (`match_judge`) is still the live executor for project-scoped studies and for every deployment without a patient-matching catalogue, and V3 persists into the old judgment store. It is deleted once the plugin serves project-scoped studies and ships in every deployment (gate G1, with the deployment decision). Population criteria matching (`vcrMatching.mjs`) is a separate live feature.

## 6. Remaining work and its owner

| Item | State | Needs |
|---|---|---|
| Native clinical child on C, n2c2 and the incident cases; 20-candidate latency (target P50 2 min) | not run in this round; discovery stages measured (rerank 2.6 s per 100 trials, Jev 0.25 s per pair with eight in flight, dense and lexical under 2 s) | a reference-host configuration on this machine (≈CNY 10 of Flash) |
| G1: the plugin serves project-scoped studies and ships everywhere; then delete the batch judge, `match_judge`, the old reranker, `legacy-matching.md`, old eval drivers, prompt builders | old path still live | the deployment decision; one real-session check that a programme run binds the project study |
| Publication and deployment of plugin 0.1.2 (worker 0.1.0 unchanged) | native smoke and status smoke pass offline on the pinned kernel (DSH 0.2.1-rc.5, zero model calls; bundle SHA256 a9b95abb…85e2e1, receipts in the assets) | owner |
| Operator step after the release | — | `node scripts/ops/vcr-retire-unread-tables.mjs --apply` (five tables) |
| Production trial index (ClinicalTrials.gov + ChiCTR, Qwen3.7, 1024-d) | the TREC snapshots were indexed for the benchmark only | operator build with `deploy/patient-matching/build-trial-index.mjs` |

## Appendix A. Every compared system and its source

Board A (judged pairs): TrialGPT 2.0 with GPT-5.4, Gemini-3.1-pro-preview and GPT-4.1, and TrialGPT 1.0 re-run with the same three backbones (arXiv 2609.01202v2, Fig. 5d and Supplementary Fig. 3c; values read from bar labels, the GPT-5.4 and Gemini reads at low resolution); TrialGPT 1.0 with GPT-4 (Nature Communications 2024; 0.7275 nDCG@10 on its own top-500 retrieval over the judged collection, best non-LLM baseline BioLinkBERT cross-encoder 0.4797); TrialMatchAI (arXiv 2505.08508; 0.7232 on the TREC judged collections, eligible-only P@10 — not the same protocol).

Board E (full corpus): the TREC 2021, 2022 and 2023 official runs and medians, and post-track systems, listed per year in section 3 with their sources (Pradeep et al. SIGIR 2022; TREC 2022 overview; TDMINER, IELAB, DoSSIER and CSIROmed notebooks; Kusa et al. JBI 2023; Peikos et al. 2023; Jullien et al. 2024). The TREC 2021 and 2023 overview papers were not reachable; their figures come from participants' notebooks.

Board F (n2c2): Stubbs et al. JAMIA 2019 (official results), Wornow et al. NEJM AI 2025 / arXiv 2402.05125, Chen et al. arXiv 2604.05190, Li et al. arXiv 2503.13281 (LLM-Match reports macro only, 0.86, not comparable to micro).

Leaderboard format: rank by point score; a 95% percentile bootstrap over patients within each cohort (10,000 resamples, the same draws for every system, so paired differences are exact); rank spread by Arena's rule (best = 1 + the number of systems whose lower bound is above this system's upper bound; worst symmetric); reported systems without per-patient outputs carry no interval and do not bound others.

## Appendix B. Reproduce

Every number above comes from saved per-pair provider answers and the official scorers; no gold label is read before scoring. Runners in `OpenScience/evals/vcr-matching-boards/`: `rerank_arm.mjs` (Qwen3.7 rerank), `jev_arm.py` (Jev), `fit_arm.mjs` (Flash trial-level fit), `embed_corpus.mjs` (dense index), `lexical_e.mjs` and `e_pipeline.py` (Board E recall, fusion, filter, boards), `arch_search.py` (Board A dev search, `CHOICE.json`, confirmation), `product_rank.mjs` (the plugin's `composeRanking` on saved answers), `leaderboard.py` (tables), `score.py` / `score_e.py` (official evaluators).
