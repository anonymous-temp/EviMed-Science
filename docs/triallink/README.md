# TrialLink: benchmark results

**EviMed · November 2026 · TrialLink `triallink-1`**

TrialLink is EviMed's patient-to-trial matching system: one pipeline from a patient record to a ranked list of clinical trials, with a
criterion-by-criterion eligibility assessment of the trials a clinician opens. This report gives its results on the public benchmarks
that the field reports on, beside every published system we could find a comparable number for.

## Headline results

| Benchmark | TrialLink | Best published comparator |
|---|---|---|
| Patient-to-trial ranking, SIGIR 2016 + TREC CT 2021 + TREC CT 2022 (183 patients, TrialGPT 2.0 protocol) | **nDCG@10 0.775**, P@10 0.710, MAP 0.617 | TrialGPT 2.0 (GPT-5.4): 0.76, 0.70, 0.60 |
| — the 105 patients held out from all development | **nDCG@10 0.839** | not reported |
| NIH-TrialBench, target trial in the top 10 (126 vignettes, 11 NIH institutes) | **96.0%** | TrialGPT 2.0: 70% |
| TREC CT 2022, full collection (50 topics, 375,580 trials) | nDCG@10 0.585; **P@10 0.526; RR 0.809** | best official run: 0.613; 0.508; 0.726 |
| TREC CT 2021, full collection (75 topics) | nDCG@10 0.559 | best official automatic run: 0.712 |
| TREC CT 2023, full collection (37 judged topics, 451,538 trials) | nDCG@10 0.504 (lower bound, see §3.3) | best official run: 0.738 |

- On the TrialGPT 2.0 benchmark TrialLink has the highest nDCG@10, P@10 and MAP reported. Its 95% interval for nDCG@10
  (0.743–0.806) overlaps TrialGPT 2.0 with GPT-5.4 (0.76); published systems report point estimates only, so no paired test is possible.
- No TrialLink component was trained or fine-tuned on any benchmark; every model is used as released.
- Ranking costs about CNY 0.24 (USD 0.03) per patient for some 410 candidate trials.

![Patient-to-trial ranking, nDCG@10](fig1-ranking.png)

![NIH-TrialBench, recall@10](fig2-nih-trialbench.png)

## 1. The system

TrialLink has three stages.

![TrialLink architecture](fig0-architecture.png)

1. **Retrieval.** A keyword search over the patient's condition and up to 32 ranked English search terms written from the record,
   fused by reciprocal rank with a dense semantic search (Qwen3.7 text embedding, 1024 dimensions); trials are kept or dropped by the
   age and sex their registry record states; the first 300 go on. In the product the keyword search runs live against
   ClinicalTrials.gov, the EU CTIS and ChiCTR.
2. **Ranking.** Two complementary readings of each candidate's whole registry record: a relevance reranker (Qwen3.7 text rerank) and a
   five-level eligibility-fit scorer (Jev 1.14), whose orders are fused by reciprocal rank (k = 60). Ranking makes no call to a
   general reasoning model.
3. **Assessment.** For the trials a clinician selects, a DeepSeek V4.1 Flash agent judges each inclusion and exclusion criterion against
   cited passages of the record (met, not met, not enough information). The assessment explains the ranking; it does not reorder it.

## 2. Evaluation protocol

- **Benchmarks and scorers.** The patient-to-trial ranking and NIH-TrialBench boards use TrialGPT 2.0's released data and its official
  evaluation scripts (`eval_trialgpt_rankings_qrels.py`, `eval_nih_trialbench_target_recall_at10.py`). TREC CT uses the official qrels
  and the track's measures, with an unjudged trial counted as not relevant.
- **Two meanings of P@10.** On the TrialGPT 2.0 board P@10 is graded (an excluded or potentially eligible trial earns half credit), as
  that paper defines it. On TREC CT, P@10 counts eligible trials only, as the track defines it. The two are not comparable.
- **Development and held-out patients.** Every design choice was made on 78 development patients (all 58 SIGIR patients and the first
  ten topics of each TREC year). The remaining 105 patients of the ranking board were not read until the design was fixed; they are
  reported separately. NIH-TrialBench was used for testing only. On TREC CT, retrieval choices were made on the first ten topics of each
  year.
- **Uncertainty.** 95% intervals are percentile bootstraps over patients (10,000 resamples, within each cohort, then macro-averaged).
- **Comparators.** Every comparator number is copied from the cited source. TrialGPT 2.0 gives its results as bar charts without a
  table; its values are read from the bar labels (two decimals).

## 3. Leaderboards

### 3.1 Patient-to-trial ranking (TrialGPT 2.0 protocol)

183 patients — SIGIR 2016 (58), TREC CT 2021 (75), TREC CT 2022 (50) — and all 75,061 judged patient–trial pairs. Each system ranks
every judged trial of a patient; the score is the mean of the three cohort means.

| Rank | System | Organization | Backbone | nDCG@10 | P@10 (graded) | MRR | MAP |
|---|---|---|---|---|---|---|---|
| 1 | **TrialLink** | EviMed | TrialLink | **0.775** (0.743–0.806) | **0.710** (0.676–0.743) | 0.820 (0.776–0.863) | **0.617** (0.588–0.645) |
| 2 | TrialGPT 2.0 | NCBI/NLM, NIH | GPT-5.4 | 0.76 | 0.70 | 0.85 | 0.60 |
| 2 | TrialGPT 2.0 | NCBI/NLM, NIH | Gemini-3.1-pro-preview | 0.76 | 0.69 | 0.84 | 0.56 |
| 4 | TrialGPT 1.0 | NCBI/NLM, NIH | GPT-5.4 | 0.74 | 0.67 | 0.84 | 0.55 |
| 5 | TrialGPT 2.0 | NCBI/NLM, NIH | GPT-4.1 | 0.72 | 0.66 | 0.80 | 0.54 |
| 5 | TrialGPT 1.0 | NCBI/NLM, NIH | Gemini-3.1-pro-preview | 0.72 | 0.67 | 0.78 | 0.55 |
| 7 | TrialGPT 1.0 | NCBI/NLM, NIH | GPT-4.1 | 0.68 | 0.63 | 0.73 | 0.49 |

Ranked by nDCG@10. TrialGPT rows: arXiv 2609.01202v2, Fig. 5d (GPT-4.1) and Supplementary Fig. 3 (GPT-5.4, Gemini-3.1-pro-preview);
TrialGPT 1.0 rows are that paper's re-runs.

**Per cohort** (nDCG@10 / P@10):

| System | SIGIR 2016 | TREC CT 2021 | TREC CT 2022 |
|---|---|---|---|
| **TrialLink** | 0.628 / 0.466 | **0.880 / 0.865** | **0.815 / 0.797** |
| TrialGPT 2.0 · GPT-5.4 | **0.66 / 0.50** | 0.84 / 0.82 | 0.78 / 0.77 |
| TrialGPT 2.0 · GPT-4.1 | 0.64 / 0.48 | 0.79 / 0.78 | 0.72 / 0.72 |
| TrialGPT 1.0 · GPT-5.4 | 0.62 / 0.45 | 0.83 / 0.82 | 0.75 / 0.73 |
| TrialGPT 1.0 · GPT-4.1 | 0.58 / 0.42 | 0.76 / 0.77 | 0.70 / 0.71 |

TrialLink leads on both TREC cohorts and trails on SIGIR, whose grades mean "would refer" rather than "eligible".

**Held-out patients.** On the 105 patients never read during development (TREC CT 2021: 65, TREC CT 2022: 40) TrialLink scores
nDCG@10 0.839 (0.794–0.880), P@10 0.823, MRR 0.907, MAP 0.671.

### 3.2 NIH-TrialBench: target-trial retrieval

126 patient vignettes written from NIH trials across 11 institutes; each is ranked against its own search space, and a hit is the
vignette's own trial in the top ten. Recall@10 is macro-averaged over institutes, as TrialGPT 2.0 reports it.

| Rank | System | Organization | Recall@10 (institute macro) | Recall@10 (all 126 cases) | MRR |
|---|---|---|---|---|---|
| 1 | **TrialLink** | EviMed | **96.0%** | 89.7% (84.1–94.4) | 0.604 |
| 2 | TrialGPT 2.0 (GPT-4.1) | NCBI/NLM, NIH | 70% | – | – |
| 3 | TrialGPT 1.0 (GPT-4.1) | NCBI/NLM, NIH | 54% | – | – |
| 4 | ChatGPT-5.5 Thinking, web interface | OpenAI | 43% | – | – |
| 5 | Gemini-3.5 Flash Extended Thinking, web interface | Google | 21% | – | – |

Comparators: arXiv 2609.01202v2, Fig. 5c.

### 3.3 TREC Clinical Trials Track, full collection

The track's own task: find, among every trial of a frozen ClinicalTrials.gov snapshot, those a patient is eligible for. nDCG@10 with
gains 2 (eligible), 1 (excluded), 0; P@10 and reciprocal rank (RR) count eligible trials only.

**How to read TrialLink's TREC numbers.** TREC judged only trials that the participating runs retrieved. A system built later finds
trials no run retrieved; those were never judged and count as not relevant. Official runs had their own top ten judged; TrialLink's top
ten was judged for 60% (2021), 68% (2022) and 52% (2023) of its trials, so its official scores are lower bounds.

**2021** (75 topics, 375,580 trials)

| Rank | System | Kind | nDCG@10 | P@10 | RR |
|---|---|---|---|---|---|
| – | TDMINER | official run, manual | 0.715 | 0.576 | 0.834 |
| 1 | h2oloo monoT5 (University of Waterloo) | official, best automatic | 0.712 | 0.593 | 0.816 |
| 2 | damoebrtog (Alibaba DAMO) | official | 0.595 | 0.409 | 0.608 |
| 3 | **TrialLink** | this report | **0.559** (0.491–0.624) | 0.488 | 0.741 |
| 4 | CSIROmed_inc (CSIRO) | official | 0.532 | 0.317 | – |
| 5 | BM25+ with entities, age/sex filter (Kusa et al.) | post-track | 0.513 | 0.337 | 0.604 |
| 6 | ChatGPT query generation + RM3 (Peikos et al.) | post-track | 0.512 | 0.323 | 0.541 |
| 7 | BM25 on the patient note | baseline | 0.469 | 0.264 | 0.471 |
| – | Track median, automatic runs | reference | 0.304 | 0.161 | 0.294 |

**2022** (50 topics, 375,580 trials)

| Rank | System | Kind | nDCG@10 | P@10 | RR |
|---|---|---|---|---|---|
| 1 | GPT-4-turbo eligibility rerank of a top 500 (Jullien et al.) | post-track | 0.693 | 0.718 | 0.769 |
| 2 | GPT-4 judgement of a cross-encoder top 20 (IELAB) | post-track | 0.659 | 0.568 | – |
| 3 | h2oloo frocchio_monot5_e (University of Waterloo) | official, best run | 0.613 | 0.508 | 0.726 |
| 4 | TCRR-Bio (Kusa et al.) | post-track | 0.604 | 0.482 | 0.672 |
| 5 | **TrialLink** | this report | **0.585** (0.508–0.660) | 0.526 | **0.809** |
| 6 | DoSSIER_5 | official, second team | 0.556 | 0.456 | – |
| 7 | ChatGPT query generation + RM3 (Peikos et al.) | post-track | 0.509 | 0.372 | 0.623 |
| 8 | CSIROmed monobert500 (CSIRO) | official | 0.491 | 0.362 | – |
| – | Track median | reference | 0.392 | 0.258 | 0.411 |

Among official runs TrialLink's nDCG@10 falls between the first and second teams, and its P@10 and RR are above the best official run.
Its RR is the highest of every system listed.

**2023** (37 of 40 topics judged, 451,538 trials)

| Rank | System | Kind | nDCG@10 | P@10 | RR |
|---|---|---|---|---|---|
| 1 | CSIROmed qe_prr_ft (CSIRO) | official | 0.738 | 0.527 | 0.667 |
| 2 | IELAB GPT-4 rerank of a top 20 | official | 0.736 | 0.511 | – |
| 3 | DoSSIER_3 | official | 0.684 | 0.584 | 0.642 |
| 4 | IELAB CE_weighted | official | 0.672 | 0.443 | – |
| 5 | CSIROmed BM25 baseline | official | 0.619 | 0.330 | 0.563 |
| 6 | IELAB dense retrieval | official | 0.577 | 0.324 | – |
| 7 | **TrialLink** | this report | **0.504** (0.433–0.573) | 0.451 | **0.778** |
| – | Track median | reference | 0.648 | 0.394 | 0.538 |

2023 is where judging coverage decides most: half of TrialLink's top ten was never judged. Its P@10 is above the track median and its RR
is the highest listed.

## 4. Cost and speed

Measured on the ranking board (some 410 candidates per patient): Qwen3.7 rerank CNY 0.08 per patient, 2.6 s per 100 trials; Jev 1.14
scoring CNY 0.16 per patient, 0.25 s per trial with eight in flight. A product search ranks 300 candidates.

## 5. Reproduce

Evaluation code: `OpenScience/evals/vcr-matching-boards/` (runners, scorers and the leaderboard builder). Benchmark data and official
scorers: the TrialGPT 2.0 repository (commit `1c5f9eb`) and the TREC Clinical Trials qrels for 2021–2023. The numbers behind this page are
in [`leaderboard.json`](leaderboard.json); `make_figures.py` draws the figures.

## References

- TrialGPT 2.0. *Towards Responsible AI-Assisted Clinical Trial Matching: Practical Considerations, Multicenter Evaluation, and
  Real-World Deployment.* arXiv 2609.01202v2 (2026), Fig. 5c–d and Supplementary Fig. 3.
- Jin Q. et al. *Matching patients to clinical trials with large language models* (TrialGPT). Nature Communications 15, 9074 (2024).
- Pradeep R. et al. *Neural query synthesis and domain-specific ranking templates for multi-stage clinical trial matching.* SIGIR 2022,
  Table 3 (TREC CT 2021 runs and median).
- Roberts K. et al. *Overview of the TREC 2022 Clinical Trials Track.* TREC 2022, Table 4.
- TDMINER, *TREC 2021 Clinical Trials Track* notebook paper.
- Kusa W. et al. *Effective matching of patients to clinical trials using entity extraction and neural re-ranking.* Journal of Biomedical
  Informatics (2023), Tables 4–5.
- Peikos G. et al. *Utilizing ChatGPT to enhance clinical trial retrieval.* arXiv 2306.02077, Table 15.
- Jullien M. et al. arXiv 2409.18998, Table 2 (GPT-4-turbo eligibility reranking on TREC CT 2022).
- IELAB (University of Queensland), CSIROmed (CSIRO) and DoSSIER, *TREC 2023 Clinical Trials Track* notebook papers.
