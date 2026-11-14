# Patient matching, round 2: the measured ranking architecture and every leaderboard

**Date:** 2026-11-07. **Branch:** `codex/vcr-match-delivery-20261104`. **Plugin:** core and native bundle 0.1.3 (2026-11-08; 0.1.2 was superseded before any release; worker 0.1.0 unchanged). Not published, not deployed.

**Owner direction (2026-11-07):** the earlier stop on leaderboards held only until the architecture was settled; Jev goes in; find the best architecture by experiment; use the current retrieval (Qwen3.7 hybrid) and build the TREC index for the leaderboards; delete what is unused; commit and push; list every result table and every compared system for the external technical report.

**2026-11-08:** the architecture is named **TrialLink** (policy id `triallink-1`, formerly `rrf-qwen-jev-v1`; same function). The external, publishable leaderboard is [docs/triallink](../../triallink/README.md): TrialLink's production configuration (Jev 1.14) against published systems only. This document stays the internal record with every arm.

Machine-readable tables: [assets](2026-11-07-vcr-matching-round2-assets/). Earlier evidence stays where it was: [V1 diagnosis](2026-11-05-vcr-matching-next-phase.md), [V3 design](2026-11-05-vcr-matching-plugin-v3.md), [V3 execution](2026-11-05-vcr-matching-plugin-v3-execution.md).

## 1. The architecture the experiments chose

```text
patient record
  → lexical recall: product FTS5/BM25 over the condition and up to 32 ranked terms (Flash writes them), age/sex filter
  → dense recall: Qwen3.7 text embedding (1024-d) of the record against the plugin's trial index
  → reciprocal-rank fusion of the recall lists (depth 300 by default, at most 500)
  → Qwen3.7 text rerank of the fused list (relevance order)
  → Jev five-level typed fit of each candidate's whole record (eligibility-aware order)
  → final order = reciprocal-rank fusion of the rerank order and the Jev order   (TrialLink policy triallink-1, k = 60)
  → native DSH managed Flash child: criterion-level eligibility, evidence and calculation tools, for the pairs the user assesses
```

What the measurements decided:

| Decision | Evidence |
|---|---|
| Ranking makes no reasoning-model call | On Board A a Flash trial-level score over the fused head added nothing on dev and −0.003 (top 10) / −0.006 (top 20) on held-out topics; on Board E dev it moved −0.04 (2021), +0.05 (2022), −0.10 (2023). Flash on every pair (z-fusion) gains +0.006 held-out on Board A at 4–5 times the cost |
| Jev is the second order, fused with Qwen | Qwen alone (the V3 policy) 0.762 held-out; Jev alone 0.798–0.802; their fusion 0.838–0.839, +0.045 [+0.016, +0.072] (Jev 1.13) and +0.046 [+0.019, +0.072] (Jev 1.14) over TrialGPT 2.0's method on the same Flash; over all 183 patients +0.027 [+0.006, +0.049] and +0.025 [+0.004, +0.046]. (The message of commit b3437073f put the all-patient interval beside the held-out score; these are the correct pairings.) |
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

### 4.2 The native clinical child on the real kernel (2026-11-08)

The criterion-level module of TrialLink — the plugin's managed Flash child — measured on the pinned kernel (DSH 0.2.1-rc.5) with the
production host adapter (`evals/vcr-matching-boards/native_replay.mjs`; frozen inputs, a stand-in root that only calls `match_assess`).

| Measure | First run (0.1.2) | After the fixes (0.1.3) |
|---|---|---|
| Child starts on the production provider composition | no: `NO_ADAPTER` for `deepseek` (measured through an alias row) | yes, `deepseek-official` (434 calls, all HTTP 200) |
| 20-candidate assessment, wall time from first prepare to last save (5 SIGIR cases) | P50 549 s, P90 575 s (6–12 executions in sequence) | **P50 81 s, P90 148 s** (6–12 executions concurrently, child capacity 30) |
| Incident cases | 16/17 (silent exclusion) | **17/17** |
| Board C label agreement (1,015 rows, 53 patients) | 59.4% [54.7, 64.2] | 73.0% [68.9, 76.9] |
| Pairs lost in the latency cases | 6/100 (schema failure, not retried) | 5/100 (an answer citing evidence ids the host does not know; not retried) |

Board C after the change: inclusion 79.8% (was 83.4%), exclusion 69.3% (was 46.4%); gold "not excluded" answered "not enough
information" fell from 286 to 92 rows, while false favourable labels rose from 33 to 68 (GPT-4: 15). Board C had been read before the
change; the silence rule itself was decided on 2026-11-04 and is not tuned here. The previous batch judge scored 79.1% and GPT-4 87.3%
(whose annotators saw GPT-4's predictions), so criterion-level agreement is not part of the external leaderboard. The n2c2 official test
was not run: its one use waits until the child's silence handling is settled. Spend: CNY 13.8 billed (off-peak) for both passes.

#### Fourth pass (2026-11-08 afternoon): the errors analysed, fixed and run again

Error classes of the second pass (274 of 1,015 Board C rows): 89 silent exclusions answered "not enough information" where the gold says
"not excluded"; 48 the other way; 23 rows of pairs lost to answers citing unknown evidence ids or the wrong criterion kind; 18 "not
applicable" answered "not excluded"; 18 "excluded" with a silent basis. Fixes: a pair whose decision cannot be saved is sent back once with
what was wrong, by identity (unknown evidence id, criterion kind, missing criteria) — the platform's repair-in-place rule; the persona says
silence never makes a patient excluded and names "not applicable". Board C is from here the criterion module's development set.

| Measure | Pass 2 | Pass 4 |
|---|---|---|
| Board C agreement | 73.0% | **76.7% [73.3, 79.9]** (GPT-4 87.3%; paired −10.6 [−15.2, −5.9]) |
| Rows: wrong → right / right → wrong / still wrong | — | 87 / 50 / 187 |
| Missing rows (pairs not saved) | 19 | 1 |
| "Excluded" from silence | 11 | 1 |
| False favourable (narrow / wide) | 68 / 88 | 88 / 107 (GPT-4 15 / 16) |
| Incidents | 17/17 | 17/17 |
| 20-candidate assessment, 5 SIGIR cases | P50 81 s, P90 148 s; 5/100 pairs lost | **P50 79 s, P90 117 s; 0/100 lost** |

Most of the 50 newly wrong rows are silent exclusions the gold calls "not enough information" and the child now calls "not excluded"; the
gold is inconsistent on silent items (both directions above), so no single rule removes both kinds.

**n2c2 2018 Track 1, official test, run once on the frozen module (bundle 0.1.3, sha256 1739fa83…):** micro-F1 **0.894 [0.876, 0.912]**
under reading (c), named 2026-11-05 before any test scoring; macro-F1 0.801; accuracy (a) 0.745; unknown share 0.175 (142 "not enough
information", 52 no answer: 4 of 86 patients saved no decision because their answers kept citing unknown evidence ids after the repair).
The previous batch judge scored 0.922 on the same test (11-05). Ledger CNY 24.79 at full price for 86 patients (≈ 86,000 input tokens per
call: whole multi-record files), billed at half off-peak.

#### Fifth pass (2026-11-08 evening, owner review): no platform rule, each benchmark's own configuration

The silence rule, "silence never excludes" and the "not applicable" wording are out of the child's persona (owner: no hard-added rules;
a comparison gives every system the same configuration). A task may now carry an **assessment guide** (`task.guide`, core contract): the
study's own labelling conventions, from the study settings, absent by default and handed to the child as a trusted section. A benchmark
supplies its own task definition there: TrialGPT's criterion-level instructions (public domain, the text GPT-4 was given) and the n2c2
annotation guidelines, sections 2 and 4 (read locally, not committed). Second class fixed: an execution started from the first 18,000
characters of the record, so the newest records of half the n2c2 patients were out of view; the window is now 80,000 characters, the
oldest passages giving way first.

| Measure | Pass 4 (platform rule) | Pass 5 (benchmark's own task definition) |
|---|---|---|
| Board C, all 1,015 rows | 76.7% | 75.6% [71.0, 79.7] (GPT-4 87.3%) |
| Board C, the 722 rows physicians decided | 83.8% | **92.0% [89.1, 94.4]** (GPT-4 87.4% [82.6, 91.3]; paired +4.6 [+0.3, +9.1]) |
| Board C, the 293 rows the gold calls "not enough information" | 59.0% | 35.2% (GPT-4 87.0%: 255 of these labels are GPT-4's own answer) |
| Incidents | 17/17 | 17/17 |
| n2c2 training split, 40 development patients | — | micro-F1 0.930 [0.905, 0.953], macro 0.876; unknown share 1.5%; 40/40 saved |
| n2c2 official test, **re-run** after the fixes (the test had been read twice before) | 0.894 (first TrialLink run) | **0.9104 [0.894, 0.926]**, macro 0.825; unknown share 3.6%; 2 of 86 patients saved no decision |

The two unsaved patients' answers kept citing evidence ids the host does not know, even after the repair: the ids were 64-character
hashes, miscopied on long records. Third class fixed: evidence ids are now short and readable (`e:<record>.<sentence>`, knowledge
`kb:` + 12 hex). Re-run alone, both patients saved in one call each; counted in, micro-F1 would be 0.918 [0.905, 0.931] (mixed versions,
diagnostic only). The remaining n2c2 errors on the development patients are false "met" answers with an inferred basis on composite
criteria (ADVANCED-CAD 10, MAJOR-DIABETES 5, DIETSUPP-2MOS 5 of 39), and they do cite evidence: an over-reading of cited facts that no
grounding check catches and no rule is added for. The incident "silent exclusion" now accepts "not enough information" beside "not
excluded" (it encoded the removed rule; what it guards — silence never makes a patient ineligible — holds): 17/17. Spend for the fifth
pass: ledger CNY 46.0 at full price (≈ CNY 23 billed off-peak).

### 4.3 Criterion-level and cohort boards (the previous judge)

These measure the clinical judgment, not ranking. They were scored on 2026-11-05 with the previous batch judge (Flash, trial-level fit plus criterion stage), which still serves project-scoped studies; the native child's Board C result is in §4.2.

| Board | Metric | EviMed (previous judge, 11-05) | Comparators |
|---|---|---|---|
| C: TrialGPT criterion annotations (1,015 patient–criterion rows, 53 SIGIR patients) | label agreement | 79.1% [75.0, 82.9] | TrialGPT 1.0 GPT-4 87.3%; three physicians 88.7–90.0% (TrialGPT 1.0 paper). Annotators saw GPT-4's predictions, so the gold leans to GPT-4 (V1 diagnosis) |
| F: n2c2 2018 Track 1, official test (86 patients × 13 criteria) | overall micro-F1 (official evaluator) | 0.922 [0.907, 0.937] (reading c, named before scoring); macro 0.821 | GPT-4 zero-shot 0.93 micro / 0.81 macro (Wornow et al.); official winner Graz rule-based 0.9100; Michigan 0.9075; Sorbonne 0.9069; MedGemma-27b + RAG + LoRA 0.8905; GPT-3.5 0.82; Mixtral-8x7B 0.79; Llama-2-70b 0.67; class-prevalence baseline 0.76; 47 teams' median 0.8227 |

The n2c2 official test has been read once by the previous judge; a replay with the native child would be a second system on the same test, not an untouched holdout.


## 4.5 Ranking policy triallink-2 (2026-11-08 night): the SIGIR gap

SIGIR (all 58 patients are development) trailed TrialGPT 2.0 · GPT-5.4 (0.628 vs 0.66). Every fusion of the saved answers was compared
on the development patients (`vm-data/r2/sigir/fusions.py`): Jev's graded reading (off-topic < excluded < doubtful prerequisite <
plausible < strong), already asked in the v2 runs, ranks SIGIR better than the fit alone, and taken as the expected benchmark gain of its
level probabilities (gains 0/1/1/1.5/2) with the Qwen rerank at half weight it lifts SIGIR without losing TREC. Flash on every pair as a
fourth order adds little (SIGIR 0.669, development macro lower) at four times the cost, so it is not used. Product: `RANKING_POLICY`
`triallink-2` (weights rerank 0.5, fit 1, graded 1), `expectedGradedGain`, the graded question in the same Jev request (≈ +30% tokens).

| Official evaluator, 183 patients | triallink-1 | **triallink-2** |
|---|---|---|
| nDCG@10 / P@10 / MRR / MAP | 0.775 / 0.710 / 0.820 / 0.617 | **0.787 / 0.723 / 0.853 / 0.637** (TrialGPT 2.0 · GPT-5.4: 0.76 / 0.70 / 0.85 / 0.60) |
| SIGIR / TREC 2021 / TREC 2022 nDCG@10 | 0.628 / 0.880 / 0.815 | **0.659** / 0.883 / 0.819 |
| Held-out 105, nDCG@10 | 0.839 | 0.841 |
| NIH-TrialBench recall@10, institute macro / all cases | 96.0% / 89.7% | 95.2% / 85.7% |

The graded reading favours trials a patient fits over the one trial a vignette was written from, so NIH-TrialBench drops slightly; it
was not used in the choice. External figure (owner, same night): NIH comparators named without a backbone (TrialGPT 2.0 reports NIH
only with GPT-4.1, see §4.4), GPT-4 zero-shot (Wornow et al., 0.93) removed from the n2c2 panel at the owner's request — it remains the
best published n2c2 result and is kept here —, TrialLink's n2c2 shown as 0.918 (the two unsaved patients completed after the id fix).

### 4.6 Comparators widened (2026-11-08 night, owner: 「全是 trialgpt，就没别的模型了吗」)

Every system the TrialGPT papers compare, and every later system found on the same test sets, was checked for protocol before it was
listed; nothing was run anew.

- **TrialGPT 1.0 protocol** (its Table 2: the judged trials among TrialGPT-Retrieval's top 500, the candidates it released in
  `retrieved_trials.json`; the official script's linear-gain nDCG@10 and graded P@10 are the paper's own definitions). Board A already
  scored this subset: TrialLink 0.788 [0.756, 0.817] / 0.715 [0.683, 0.747] against TrialGPT · GPT-4 0.7275 / 0.6688, TrialGPT · GPT-3.5
  0.5395 / 0.5115 and five NLI-trained encoders (BioLinkBERT 0.4797 best). Two new panels. AUROC is left out: the paper does not say
  which labels are positive.
- **Criterion level, physicians on the decided rows.** TrialGPT 1.0 Fig. 3c–d gives each physician's confusion matrix (proportions per
  gold label); weighted by the released gold counts: physicians 93.1 / 90.7 / 89.0% on the 722 decided rows (TrialLink 92.0%). Check:
  the same rebuild gives GPT-4 87.7% (exact 87.4%), the paper's per-type accuracies within 0.004, and its whole-set range within 0.1.
- **n2c2**: Stubbs et al. Table 2 top ten (0.91 … 0.8765), Vydiswaran et al. post-challenge 0.9111, Chen et al. Llama-3.1-8b + LoRA
  0.8671 beside MedGemma 0.8905; TrialLink first of 14. Wornow et al.'s rows stay out with its GPT-4 (owner), so its weaker zero-shot
  rows are not listed alone.
- **Not listed, different measure**: TrialMatchAI (Nat Commun 2026: every judged trial of a TREC year as the pool, eligible-only
  relevance, nDCG@10 0.7232 averaged over TREC 2021/2022) and LLM-Match (arXiv 2503.13281: AUROC on TrialGPT 1.0's pairs; macro-F1 on
  n2c2, fine-tuned). NIH-TrialBench has no comparators beyond the four TrialGPT 2.0 reports; no other system on the criterion
  annotations was found.

### 4.7 Round 3 (2026-11-08 night): the algorithm audit's sixteen items and the execution gaps

An audit of every stage against the code and the literature (TrialGPT 1.0/2.0, Kusa et al. JBI 2023, Pradeep et al. SIGIR 2022,
IELAB and DoSSIER at TREC 2023, TrialMatchAI, Wornow et al., Chen et al., Beattie et al., PRISM, MAKAR) found these defects, all
fixed on this branch:

| Stage | Found in the code | Now |
|---|---|---|
| Ranking input | discovery cut `query + passages` at 8,000 characters — the **oldest** records of a multi-record patient — for the dense query, the rerank query and Jev | the whole text when ≤ 6,000 characters (benchmark vignettes unchanged byte for byte); else a dated profile summary (one Flash call, cached per record), else the newest whole sentences |
| Rerank request | query tokens × 300 documents far above DashScope's 120k-token recommendation for long records | batches under the bound, three in flight |
| Rerank view | 240 characters of inclusion and 240 of exclusion per trial | the whole record (12,000 characters) with the eligibility instruction: rerank-only nDCG@10 on the 78 development patients 0.602 → 0.638 |
| Registry search | age, sex and region never passed; every phrase one page of about 31 results, the condition included | `match_discover` takes age/sex/region (the profile's when the tool gives none); the condition asks 200 deep, terms share the rest |
| Jev trial text | eligibility last, cut at 24,000 characters | the summary shortens first; eligibility stays whole |
| Patient passages | one sentence each, no section, no date; older records past 80,000 characters unreachable | each passage carries its record index, record date (format-detected, incl. 2023年4月7日) and section heading; ~1,000-token chunks; the newest records whole plus, per criterion, the top three BM25 chunks from older records |
| `match_evidence` | substring sort, returned 20 unrelated sentences when nothing matched | BM25 over the whole record, up to eight phrasings fused by RRF, empty when nothing matches |
| Child prompt | the frozen execution as a JSON string of JSON: a 72-character sentence cost about 460, the record was repeated per trial, per-execution fields came first so DeepSeek's prefix cache never held it; the model copied scope, digests, sources and producer back | plain text: the record once by record/date/section, then trials (criteria with their premises), then pairs; the child writes the clinical fields only and code completes the saved decision |
| Composite criteria and time windows | judged in one verdict by the model | optional parts + rule (all/any/atLeast n) and timing (event date, reference date, window); code counts parts and days |
| Over-inference | no check that a cited sentence supports a verdict | a verification child was built, measured and removed (below); composite parts and time windows in code address the n2c2 over-reading |
| Missing information | free-text unresolved facts only | `missingFact` per unknown criterion; `openQuestions` groups them across pairs; the skill asks the clinician once and reassesses only the affected pairs |
| TREC 2023 retrieval (internal board) | whole-record index incl. exclusion text; templated topics queried as written | inclusion-only and criterion-level FTS tables (frozen collections) and a narrative rewrite with synonyms: eligible recall@300 0.154 → 0.223 (37 topics) |

**Measured on the boards (same scorers as before):**

| Board | Before round 3 | Round 3 (final code) |
|---|---|---|
| A, all 183 patients, official scorer: nDCG@10 / P@10 / MRR / MAP | 0.787 / 0.723 / 0.853 / 0.637 (triallink-2) | **0.792 / 0.724 / 0.849 / 0.637** (triallink-3) |
| A, SIGIR / TREC 2021 / TREC 2022 nDCG@10 | 0.659 / 0.883 / 0.819 | **0.663** / **0.890** / **0.824** |
| A, held-out 105 | 0.841 | **0.848** |
| A, TrialGPT 1.0 candidates (top-500): nDCG@10 / P@10 | 0.788 / 0.715 | **0.796** / **0.720** |
| B, NIH-TrialBench recall@10, institute macro / all cases | 95.2% / 85.7% | **95.9% / 88.1%** (candidates: a relevance rerank's top 300 of the 1,373-trial corpus) |
| C, physician-decided criteria / all criteria / false favourable | 92.0% / 75.6% / 138 | **92.2%** / **77.8%** / **117** |
| n2c2 development patients (40): micro / macro F1 | 0.930 / 0.876 | **0.941 / 0.894**; input tokens per patient ≈19.5k (≈86k before) |
| n2c2 official test (86), one complete pass of the final code (a re-run) | 0.918 (0.9104 + 2 patients completed later) | **0.919** [0.905, 0.934], macro 0.825; ADVANCED-CAD accuracy 0.71 → 0.78, MI-6MOS F1 0.93 → 0.84; CNY 10.2 (26.2 before) |
| Incidents | 17/17 | **17/17** |
| TREC 2023 lexical eligible recall@300 (internal) | 0.154 | **0.223** |

Ranking policy `triallink-3` (rerank 1, fit 1, graded 0.5) was chosen on the development patients only; MRR is level with TrialGPT 2.0
(0.849 against a bar label of 0.85).

**Tried and removed.** A verification child that read back every cited met / not-met judgment against its sentences. First version
(every cited judgment, no guide): Board C decided rows 86.8% — it turned 26 physician-confirmed "not excluded" answers (absences,
which no sentence establishes) into unknown. Second (present findings only): 89.9%. Third (with the task's guide), ablated on the
development boards against the same code without it: Board C decided 91.8% / 92.2% off, all rows 76.7% / 77.8%, false favourable
124 / 117; n2c2 development micro-F1 0.933 / 0.941, cost CNY 7.55 / 4.58. No measured gain, so it is gone (principle 11).

**Decisions.** Production keeps no trial index of its own (owner, 2026-11-08): semantic order comes from the whole-record reranker
over the live registry union; the dense channel stays for frozen collections. The Chinese path: Chinese terms when the record is
Chinese (skill), CJK bigrams in the record index, Chinese record dates read, the profile summary in English headings (Qwen and Jev
read both languages); a ChiCTR record that cannot be read is ranked from its listing alone and says so.

**Execution gaps.** Plugin and core 0.1.7, native and status smokes pass on the pinned kernel (zero paid calls; receipts beside the
artefact). Gate G1: a project-scoped study's matching now runs on the plugin in the study's own conversation (taskContext resolves
that conversation to the study; 2,130 VCR tests pass against PostgreSQL); the batch judge stays only where no plugin catalogue is
deployed and is deleted once every deployment has it. Retiring the unread tables online was checked and not done: production holds
six of the eight, all empty, but the live release still writes `matching_extractions` and deletes from `candidate_trial_judgments`
during account erasure, so they are dropped after this release goes live (`scripts/ops/vcr-retire-unread-tables.mjs --apply`).
Assessment latency (latency board, 5 SIGIR patients × 20 trials, final code): median 120 s, slowest 158 s, 100/100 pairs, about 3.7
model calls per execution (79 s and 2 before: the child now searches the record before leaving a decisive criterion unknown). Component latency: Jev with both readings 265 ms median per call against 262 ms for the fit alone (tokens +14%); the whole-record
rerank 9.0 s per 100 documents per request, three requests in flight.

### 4.8 Round 4 (2026-11-09): the remaining gaps closed, except deployment

Owner: close every open gap but the release. Plugin and core 0.1.11. Development data only for every choice (n2c2 training split,
Board C as development, the latency board); the n2c2 official test was run once at the end on the final code, as a re-run.

**Two defects in round 3's criterion logic, both found from the data.**

| Defect | How it showed | Fix | Measured |
|---|---|---|---|
| "At least n of" was counted from the parts the model listed | a criterion answered with only the condition looked at became not-satisfied in code | code overrules only with what the listed parts prove; a visibly short list keeps the model's verdict | unit tests (no saved run had the case) |
| The time-window `relation` was read as the criterion's requirement | n2c2 test MI-6MOS false positives 1 → 6 between rounds 2 and 3; on 202 training patients, 8 code reversals, 7 wrong: "MI in the past 6 months" written as `beyond` (where the patient's MI fell) turned a correct not-satisfied into satisfied | code completes a criterion the assessment left unknown and never reverses a decided one (the disagreement stays as an assumption); the field says it is the criterion's wording; the reference date ("now") is set in code to the newest record date | re-scored from saved decisions: train-heldout (162) micro-F1 0.937 → 0.940, MI-6MOS F1 0.81 → 0.91; train-dev (40) 0.941 → 0.939 |

**Arms measured and decided (plugin 0.1.8, development data).**

| Arm | n2c2 train-dev micro / macro F1 | Board C decided / all / false favourable | Latency board, 5 × 20 trials (s) | Decision |
|---|---|---|---|---|
| thinking high (kept) | 0.941 / 0.887, CNY 4.88 | 93.1% / 77.1% / 129 | 67, 94, 132, 134, 203 (median 132) | kept |
| thinking low | 0.933 / 0.884, CNY 4.24 | 92.0% / 77.9% / 117 | 49, 68, 118, 122, 132 (median 118) | not adopted: the tail stays (calls of 13–16k output tokens remain) and quality is lower |
| evidence dense channel (qwen3.7 embeddings fused with BM25) | 0.927 / 0.870, CNY 5.79 + 255k embedding tokens | 92.2% / 77.5% / 123 | — | removed |

The latency tail is the structured answer of a criterion-heavy trial at about 170 output tokens a second (the slowest calls write
13–16k tokens with either thinking level), not reasoning; the effort lever (`OPEN_SCIENCE_PATIENT_MATCHING_REASONING_EFFORT`, default
high) stays for deployments that want the lower cost.

**What the long-record ranking text keeps** (`profile_probe.mjs`, 40 n2c2 training patients, median 16,209 characters; one Flash call
answers the 13 criteria from the text alone, scored against the gold; CNY 0.88):

| Ranking text | Median characters | Criterion accuracy | "Met" F1 |
|---|---|---|---|
| whole record | 16,209 | 0.812 | 0.784 |
| first 8,000 characters (before round 3) | 8,000 | 0.788 | 0.734 |
| newest whole sentences (fallback) | 5,977 | 0.829 | 0.792 |
| profile summary (round 3) | 2,001 | 0.827 | 0.789 |

**Real conversations** (session board: DeepSeek Flash root with the plugin's tools, the clinician's message carrying the record and
three named trials, a second turn from a simulated clinician who answers every question asked; three real Chinese records and two
SIGIR patients). The first run (0.1.8) took the patient on its fourth `match_context` call and searched for trials the person had
named; `match_context` now says the patient is taken by passing a `messageSeq` back (the always-refused `patientText` is out of the
schema) and the skill says named trials are assessed. On 0.1.9: no failed tool call in any of the five; the patient taken on the second
`match_context`; first turns 66–133 s; every second turn called `match_correct` then `match_assess` and re-assessed the three pairs
the answers affected, with replies in the clinician's language. When the clinician had no answers (first run), the assessment stayed
"cannot confirm" and nothing was filled in.

**Chinese records through the plugin** (30 real Chinese CDSS notes × 5 trials from round 1's candidates, 150 pairs): all saved, none
failed, median assessment span 64 s, every unknown criterion names its missing fact. 97% of the criterion reasons were English (the
round-3 prompt is English and named no language); one instruction line makes them follow the record's language — on 10 notes (50 pairs,
0.1.10) every reason is Chinese.

**TREC 2023 end to end, official scorer** (internal board; a subagent re-scored the full pipeline: candidates from round 3's lexical
indexes and the dense list, Qwen rerank on the whole record, Jev, triallink-3): nDCG@10 0.533 (round 2: 0.511), eligible P@10 0.481,
MRR 0.812. A whole-topic lexical query fused beside the round-3 variant gives 0.549 (dev +0.032, test +0.011, n = 37, not significant);
it is not put into the product (frozen collections serve the benchmarks only, and the patient text would have to be carried through
four layers). The distance to plain BM25 (0.619) is mostly pooling: our top ten is 57% judged against 78% for the raw retrieval order,
whose own official score is 0.564 with eligible P@10 0.351; condensed nDCG@10 of the full pipeline is 0.887.

**Board C's false favourable count, analysed** (0.1.7 final run; no tuning on Board C): 116 of 117 are rows the physicians labelled "not
enough information". The physicians annotated GPT-4's own output: where GPT-4 said "not enough information" they kept it on 255 of 289
rows, and 97 of our 116 are such rows. On the rows the physicians decided as disqualifying we give one favourable answer (GPT-4: 2).
Mapping our "silent" basis to "not enough information" would be worse: of 383 silent "not excluded" answers the physicians agreed
on 307. The clinically real class is 24 inclusions inferred from cited sentences that the physicians judged insufficient (14 of them
with physician-cited sentences too): a disagreement over how strong an inference is, not a fabrication.

**Final code (0.1.11), the external boards re-run once.**

| Board | Round 3 (0.1.7) | Round 4 (0.1.11) |
|---|---|---|
| n2c2 official test (86), a re-run: micro / macro F1 | 0.919 [0.905, 0.934] / 0.825 | **0.927 [0.913, 0.940] / 0.845**; MI-6MOS F1 0.84 → 1.00; CNY 10.1 |
| Board C: physician-decided / all / false favourable | 92.2% / 77.8% / 117 | **92.5% [89.8, 94.8]** (+5.1 vs GPT-4, +0.9 to +9.8) / 77.6% / 123 |
| Incidents | 17/17 | 17/17 |

Board A and NIH-TrialBench are ranking boards and the ranking stage did not change this round. The plugin's native and status smokes
pass on 0.1.11 with no paid call (receipts beside the artefact). Spend this round: DeepSeek ledger CNY 89.9 at full price (all off-peak,
so about half billed), Qwen rerank CNY 5.4, Jev USD 0.31, embeddings 255k tokens. Not done, by the owner's ruling: deployment, and so
the real production path, retiring the unread tables and deleting the batch judge, which wait for this release to be live.

### 4.9 Production (2026-11-10/11): the release and what only the production path showed

The batch judge was deleted before the release (gate G1, 11-10). Five releases went live in two days: `evimed-ee2276a2f024-1`, then
`01888f2e9e80`, `6e136d2aa7c9`, `de4acd0b1c3a` and `evimed-0266abec391a-1` (11-11 13:35 UTC), with plugin 0.1.13 and 0.1.14 shipped by
replacing the host catalogue (no image release). Each defect below passed CI and the local real-kernel replay. The replay ran its own
loopback host front, and CI's gateway tests stub the invocation, so none of these paths was exercised before production.

| # | Defect on production | Effect | Fix |
|---|---|---|---|
| 1 | `tmpfs: [/tmp:rw,noexec,size=16m]` is a YAML flow sequence (three entries) | Docker refused the worker mid-switch | quoted; `composeTmpfsEntries.test.mjs` |
| 2 | the kernel answers HTTP ~0.2 s before an enabled bundle registers `patientMatching/status` | install probe 404 → rolled back (and `ensureDefault` never retries) | bounded 404 wait in `patientMatchingStatus` |
| 3 | the plugin transport accepted plain HTTP only on loopback | bundle never loaded behind `open-science-web` | 0.1.13 accepts single-label service names |
| 4 | the state document held the full manifest twice | `product_document_too_large` (> 256 KiB) | the state keeps a pointer; the manifest is re-read from disk |
| 5 | the profile row passed the MCP workload token | host calls 401 | the model-gateway token file |
| 6 | `scope()` without a client | 400, and the plugin silently dropped at later starts | `client ?? this.database` |
| 7 | discovery ran past the transport's 30 s | `match_discover` aborted | 0.1.14: 110 s host calls |
| 8 | the evidence search's phrasing bound was not stated | calls over 8 phrasings refused | the description states it |
| 9 | a correction turn enqueued a second continuation at the same task position | 409 `product_job_idempotency_conflict` | one continuation per task position |

**Live check on `evimed-0266abec391a-1`** (throwaway account, synthetic lung-cancer patient, the kernel's own conversation, 13:49–14:30
UTC, off-peak): the plugin took effect 1 min 45 s after the first ordinary turn. The matching turn succeeded (975 s), and so did the
correction turn (1,359 s; `match_correct` then four `match_assess`). The run covered the whole chain (context, discovery, job, assess,
results, report, evidence, correct), and both replies were in Chinese. No 409 occurred. Kernel-side spend was CNY 2.58 (505 calls,
reference price). The de4acd check (11-11 01:08 UTC) ran in the weekday peak because the defect it had to confirm blocked every
production session.

**What it still shows** (counts from the transcript and the web log; no patient text read):

| Finding | Measured | Cause | Next |
|---|---|---|---|
| `match_evidence` host failures | 35 of 111 calls (5 in turn 1, 30 in turn 2); Postgres 57014 | `cloud_reads` is one row per study, session and document. Every served sentence is its own short transaction on that row (`recordCloudRead` INSERT … ON CONFLICT, then `recordCloudWindow` UPDATE), concurrent children queue on the row lock, and the 5 s statement timeout cancels the tail (logpoint stack, `pg_stat_activity` `Lock/transactionid`) | record one search's windows in one statement, and skip what is already recorded with a snapshot read that never waits |
| Database CPU | Postgres 234% of 4 cores, load 8–10, swap nearly full; 45 of 56 active-query samples were `evimed_frontier` queries | 前沿动态's list and pipeline queries (`pg_stat_statements` is not enabled) | profile and index; this slows every module |
| `match_discover` timeouts | 2 of 4 calls in the first turn hit 110 s (the correction turn needed none); successful calls took 63–75 s | registry search, record reads, rerank and Jev fit on the loaded host | run discovery as a job behind `match_job`, or lighten it |
| `invalid_arguments` | 9 evidence calls and 1 discover call over both turns | the model passed arguments outside a bound | read which bound |

**Operator steps done.** The unread tables were retired (six on production, all empty; a rerun reports none). Release retention kept
the current and previous releases and removed the trees of `cb66eedb78bf`, `ee2276a2f024`, `01888f2e9e80` and `6e136d2aa7c9`. The
superseded adapter and result-replay tags were removed.

### 4.10 Production, second round (2026-11-12/14): what §4.9 left open

Three releases on the live tree: `evimed-087f31306812-1` (11-12 11:12 UTC), `evimed-48ef3e9382c1-1` (11-14 10:07 UTC) and
`evimed-8f13b5fac332-1` (11-14 14:22 UTC, branch `codex/release-1112d`). Plugin 0.1.15 went into the host catalogue on 11-12. Each release was followed by the same live check
as §4.9 (throwaway account, synthetic lung-cancer patient, a matching turn and a supplement turn, off-peak), and each check found the next
cause; none of them shows in CI or in the local replay, which never has a slow registry or forty concurrent readers of one row.

| Found on | Defect | Measured | Fix (release) |
|---|---|---|---|
| 0266 | every served passage was its own INSERT … ON CONFLICT and UPDATE on the conversation's `cloud_reads` row | 35 of 111 evidence searches cancelled (57014) | one statement per document, a snapshot check first so a read that adds nothing never waits (087f) |
| 0266 | a discovery ran past the plugin's 110 s host call and started again on the retry | 2 of 4 calls cut off | one discovery per task and request, detached from its caller; a call past 90 s answers `pending` with the same call to make, and that call joins the running search (087f) |
| 0266 | the model passed arguments outside a bound and was told only that they were invalid | 10 calls | plugin 0.1.15 names the path and the bound, no value |
| 0266 | 前沿动态's claims read TOAST columns of every row to find the ones still owed | Postgres 103–353% of 4 cores, load 4.7–6.0, 43 of 60 active-query samples | a trigger-kept `reader_ready_*` and `reader_best_source`, partial indexes, a background backfill (087f, 48ef) |
| 0266 | `/api/ready` counted thirteen anti-joins six times a minute | 1.0–1.4 s a call | a relationship a validated key proves is not counted (087f) |
| 087f | a commit waited for its task's advisory lock under the store's 5 s statement timeout | 27 commits cancelled; the turn passed 30 min | the lock wait has its own bound, 60 s (48ef) |
| 087f | ChiCTR and CTIS records had no cache; every preparation, commit and result read asked the registry | `registry_unavailable` × 11 | a judgment's record is kept two hours per registry and id (48ef) |
| 48ef | every commit projected every selected pair by reading its trial again, inside the commit; one EU CTIS record that missed the registry's 20 s deadline failed every preparation and every commit of its task | no judgment saved for 21 min after discovery; `registry_unavailable` × 20 (reason `timeout`), lock wait × 3; the turn passed 40 min | a discovery's record reads serve the assessment; a commit's projection asks no registry; a lane passes over an unread trial; an unread record is not asked for again for two minutes (8f13) |
| 48ef | EU CTIS answers the production host slowly | one record 3–13 s direct, two of eight reads past 25 s; 2–9 s and none of four through the Tokyo node; discovery's record stage 225 s for 119 CTIS and 86 ChiCTR records | CTIS leaves through the node; eight record readers (8f13) |
| 48ef | ChiCTR's site answers the host 405, and the failed page read was written inside the commit's transaction | 104 writes cancelled waiting on the row; 56 pages asked 327 times | the page cache writes outside its caller's transaction; a commit reads only what is held (8f13). ChiCTR eligibility text stays unavailable on production: its trials are judged on the listing |

**Measured on each release** (same checks; the database figures are sixty samples of `pg_stat_activity` two seconds apart with no check running):

| Measure | 0266 (11-11) | 087f (11-12) | 48ef (11-14) | 8f13 (11-14) |
|---|---|---|---|---|
| Evidence searches failed on the host | 35 of 111 | 0 | 0 of 131 | 0 of 184 |
| Commits cancelled waiting for the task lock | — | 27 | 3 | 0 |
| `registry_unavailable` on the matching path | — | 11 | 20 | 0 |
| Discovery's record stage | — | — | 225 s | 69 s, 65 s |
| First judgment saved after discovery | — | — | 21 min | 47 s |
| ChiCTR page reads asked | — | — | 327 for 56 trials | 46 for 46 trials |
| Matching turn | 975 s, succeeded | > 30 min | > 40 min; 15 pairs judged | 2,311 s, succeeded; 34 pairs judged |
| Supplement turn | 1,359 s, succeeded | 409 (the first turn still ran) | 409 (the same) | 460 s, succeeded; 20 more judgments |
| Samples with a 前沿动态 query active | 43 of 60 (45 of 56 on 11-11) | 48 of 51 | 12 of 60 | 9 of 60 |
| Load average | 4.7–6.0 | 1.6–2.2 | 1.1–1.9 | 2.7–4.4 (another session was preparing a release on the host) |
| `/api/ready` | 1.0–1.4 s | 0.34–0.45 s | 0.24–0.29 s | 0.24–0.27 s (one call 0.63 s) |
| Kernel spend of the check | CNY 2.58 (505 calls) | — | CNY 1.81 (443 calls) | CNY 2.89 (813 calls) |

On 8f13 no host call of the matching path failed for a cause of ours: the gateway logged one refusal in the supplement turn, by design
(`match_correct` named no original message of the person's; the model took the new message with `match_context` and went on), and the
model's own out-of-bound arguments (10 of 184 evidence searches). The matching turn is now as long as the work the model chose: it judged
34 pairs, at about one saved judgment a minute.

The 0266 turns succeeded because that run's candidates happened to be read in time; the path was the same. The walk after each switch fails on
the composer's thinking-strength control (older than this round), and on 48ef also on the frontier topic page's control count (ten kinds, budget
nine): the walk opened a fuller topic than on 087f and no web file changed between the two releases.

## 4.4 Gaps recorded at the owner's review (2026-11-08 evening)

| Gap | What is known | Next |
|---|---|---|
| A hard-coded silence rule in the clinical child's persona | Added 11-08 (judge per criterion whether a good note would record a fact; silence never excludes; "not applicable" named). It raised Board C 59.4% → 76.7% but doubled false favourable labels (88 vs GPT-4's 15), and it is a rule of ours, not a configuration the comparators had | Remove it (owner: no hard-added rules; a comparison must give every system the same configuration). A benchmark's own task definition (its label guide) is the configuration every system gets |
| Criterion-level below GPT-4 | 76.7% vs 87.3% (annotators saw GPT-4's predictions); 23 → 1 rows lost after repair | Error classes per label; give the child the benchmark's own label definitions the way TrialGPT's prompt carried them; re-run |
| n2c2 0.894 below GPT-4 0.93 and below our earlier batch judge 0.922 | 4 of 86 patients saved no decision (long multi-record files; answers cite evidence ids the host does not know even after the repair); unknown share 0.175 (142 "not enough information"); the test has now been read twice (batch judge 11-05, TrialLink 11-08) | Error analysis by criterion; fix the evidence-id class for long files; develop on the n2c2 training split; any further test run is reported as a re-run, not a held-out result |
| TREC CT full-collection scores look implausibly low | 2021/2022/2023 nDCG@10 0.559/0.585/0.504; J@10 0.60/0.68/0.52; eligible recall@300 0.56/0.60/0.21. Audit 11-08: not an ingestion fault (TREC 2023 topics are short templates, median 115 characters in 7 fields, and all of it was read), and the scorer agrees with trec_eval; but a plain BM25 over the template text scored 0.619 officially (CSIROmed baseline) against our 0.504 and our lexical stage's 0.275, so query writing built for free-text notes underperforms on templated topics. | Not in the external figure. Next: a whole-topic lexical channel beside the written terms, measured on dev topics, then rerank and Jev on what it adds (cheap: the rankers' saved answers cover most candidates) |
| NIH-TrialBench comparator is GPT-4.1 | TrialGPT 2.0 reports NIH-TrialBench only with its default backbone ("Unless otherwise specified, all main analyses used GPT-4.1"); GPT-5.4/Gemini appear only for the three public cohorts (Supp. Fig. 3) | Label it so; no GPT-5.4 NIH number exists |
| Old datasets and comparators | SIGIR (the only version, 2016), n2c2 cohort selection (the only edition, 2018) and 2024-era comparators (GPT-3.5, Mixtral, Llama-2) | Name datasets without years where there is one edition; keep current and leading comparators |

## 5. What was deleted (owner: 「没用的和历史的都不留」)

A read-only trace of every importer of the old path decided what could go now; the deletions are on this branch:

- five exports nothing referenced;
- the clause definition cards (an arm built and never switched on; production never created its table);
- the pre-2026-11-04 rules-based candidate trials (`vcrPatientTrials.mjs`, `vcrCandidateTrialStore.mjs`, the legacy patient page, four tables; production held no row) — `scripts/ops/vcr-retire-unread-tables.mjs --apply` retires the five tables after the release;
- V3's multi-candidate Jev priority fallback (replaced by the per-candidate fit) and `OPEN_SCIENCE_PATIENT_MATCHING_PRIORITY_ENABLED`.

**Deleted 2026-11-10 (gate G1):** the old batch judge (`match_judge`, its executor, prompts, counters, the `rejudge` route and its levers); a project-scoped study's matching now runs on the plugin in the study's own conversation (§4.9). Population criteria matching (`vcrMatching.mjs`) is a separate live feature.

## 6. Remaining work and its owner

| Item | State | Needs |
|---|---|---|
| Native clinical child | done 2026-11-08 (§4.2): P50 79 s, incidents 17/17, Board C 76.7%, n2c2 0.894 (run once) | open: on long multi-record files 4 of 86 patients still saved no decision after the repair (unknown evidence ids); false favourable labels above GPT-4's (88 vs 15) under the silence rule |
| G1: delete the batch judge | done 2026-11-10 | — |
| Deployment | live 2026-11-11 as `evimed-0266abec391a-1`, plugin 0.1.14 (§4.9) | — |
| Unread tables | retired on production 2026-11-10 | — |
| Production path load (§4.9) | fixed on 087f and 48ef (§4.10): evidence reads 0 of 131 failed, discovery joins, the frontier's share of active queries 43/60 → 12/60 | — |
| Registry reads on the matching path (§4.10) | fixed and live on `evimed-8f13b5fac332-1`: both turns of the check succeeded with no failed host call | — |
| Assessment throughput | about one saved judgment a minute on production (34 pairs in a 38-minute turn); the lanes are not the bound they were measured as on the latency board | measure where a lane's time goes on production (child calls, prepare, commit) before changing anything |
| ChiCTR eligibility text on production | the site answers the host 405; every page read fails and the trials are judged on their listing | a rendered read of chictr.org.cn (the cloud browser), or the evidence API carrying the criteria |
| ~~Production trial index~~ | not needed (owner, 2026-11-08): production searches ClinicalTrials.gov (official API), CTIS and ChiCTR (EviMed evidence API) live; the dense branch stays optional and off without a manifest | — |

**Fixed 2026-11-08 (production retrieval).** The live registry search handed discovery one run-sized page (20, `OPEN_SCIENCE_VCR_CANDIDATE_SEARCH_MAX`), so production ranked 20 candidates where the boards ranked 300. Discovery now reads the whole kept list up to its depth (`runtimeRead(..., { listMax })`, the control plane's own option; the runtime's reads keep their page), and reads the ClinicalTrials.gov records it ranks in batches of 100 (`filter.ids`, one request per hundred, a 15-minute cache in front of the single reads) instead of one paced request per trial (300 × 250 ms).

## Appendix A. Every compared system and its source

Board A (judged pairs): TrialGPT 2.0 with GPT-5.4, Gemini-3.1-pro-preview and GPT-4.1, and TrialGPT 1.0 re-run with the same three backbones (arXiv 2609.01202v2, Fig. 5d and Supplementary Fig. 3c; values read from bar labels, the GPT-5.4 and Gemini reads at low resolution); TrialGPT 1.0 with GPT-4 (Nature Communications 2024; 0.7275 nDCG@10 on its own top-500 retrieval over the judged collection, best non-LLM baseline BioLinkBERT cross-encoder 0.4797); TrialMatchAI (arXiv 2505.08508; 0.7232 on the TREC judged collections, eligible-only P@10 — not the same protocol).

Board E (full corpus): the TREC 2021, 2022 and 2023 official runs and medians, and post-track systems, listed per year in section 3 with their sources (Pradeep et al. SIGIR 2022; TREC 2022 overview; TDMINER, IELAB, DoSSIER and CSIROmed notebooks; Kusa et al. JBI 2023; Peikos et al. 2023; Jullien et al. 2024). The TREC 2021 and 2023 overview papers were not reachable; their figures come from participants' notebooks.

Board F (n2c2): Stubbs et al. JAMIA 2019 (official results), Wornow et al. NEJM AI 2025 / arXiv 2402.05125, Chen et al. arXiv 2604.05190, Li et al. arXiv 2503.13281 (LLM-Match reports macro only, 0.86, not comparable to micro).

Leaderboard format: rank by point score; a 95% percentile bootstrap over patients within each cohort (10,000 resamples, the same draws for every system, so paired differences are exact); rank spread by Arena's rule (best = 1 + the number of systems whose lower bound is above this system's upper bound; worst symmetric); reported systems without per-patient outputs carry no interval and do not bound others.

## Appendix B. Reproduce

Every number above comes from saved per-pair provider answers and the official scorers; no gold label is read before scoring. Runners in `OpenScience/evals/vcr-matching-boards/`: `rerank_arm.mjs` (Qwen3.7 rerank), `jev_arm.py` (Jev), `fit_arm.mjs` (Flash trial-level fit), `embed_corpus.mjs` (dense index), `lexical_e.mjs` and `e_pipeline.py` (Board E recall, fusion, filter, boards), `arch_search.py` (Board A dev search, `CHOICE.json`, confirmation), `product_rank.mjs` (the plugin's `composeRanking` on saved answers), `leaderboard.py` (tables), `score.py` / `score_e.py` (official evaluators).
