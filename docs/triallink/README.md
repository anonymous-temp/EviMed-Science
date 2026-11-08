# TrialLink: benchmark results

**EviMed · November 2026 · TrialLink `triallink-1`**

TrialLink is EviMed's patient-to-trial matching system: one pipeline from a patient record to a ranked list of clinical trials, with a
criterion-by-criterion eligibility assessment of the trials a clinician opens. This report gives its results on every public benchmark the
field reports on, one capability at a time, beside every published system we found a comparable number for.

![TrialLink leaderboard](fig1-leaderboard.png)

## Where TrialLink stands

| Capability | Benchmark | TrialLink | Position among listed systems | Best published |
|---|---|---|---|---|
| Patient-to-trial ranking | SIGIR 2016 + TREC 2021/2022, 183 patients (TrialGPT 2.0 protocol) | nDCG@10 **0.775**, MAP **0.617** | **1st of 7** on both | TrialGPT 2.0 · GPT-5.4: 0.76, 0.60 |
| — per cohort | TREC 2021 / TREC 2022 / SIGIR 2016 | 0.880 / 0.815 / 0.628 | **1st of 5** / **1st of 5** / 3rd of 5 | 0.84 / 0.78 / 0.66 |
| Target-trial retrieval | NIH-TrialBench, 126 vignettes | recall@10 **96.0%** | **1st of 5** | TrialGPT 2.0: 70% |
| Full-collection retrieval | TREC CT 2021 / 2022 / 2023 | nDCG@10 0.559 / 0.585 / 0.504 (lower bounds) | 3rd of 6 / 5th of 8 / 6th of 6 | 0.712 / 0.693 / 0.738 |
| Criterion-level eligibility | TrialGPT annotations, 1,015 criteria | accuracy 76.7% | 2nd of 2 | TrialGPT 1.0 · GPT-4: 87.3% |
| Cohort selection | n2c2 2018 Track 1, official test | micro-F1 0.894 | 5th of 9 | GPT-4 zero-shot: 0.93 |

- TrialLink ranks first wherever the task is ranking candidate trials for a patient: the TrialGPT 2.0 benchmark (nDCG@10 and MAP), both
  TREC cohorts and NIH-TrialBench. Its nDCG@10 interval on the TrialGPT 2.0 benchmark (0.743–0.806) overlaps TrialGPT 2.0 with GPT-5.4
  (0.76); published systems report point estimates only, so no paired test is possible. On the 105 patients held out from all
  development it scores nDCG@10 0.839.
- On the full TREC collections its official scores are lower bounds: TREC judged only what the participating runs retrieved, and 32–48%
  of TrialLink's top ten was never judged. Its eligible-trial P@10 and RR on TREC 2022 are above the best official run.
- Criterion-level agreement and n2c2 measure the clinical judgment of the assessment stage. There TrialLink is behind GPT-4 based
  systems; the n2c2 result (0.894) is above the 47-team median (0.823) and 0.016 below the challenge winner (0.910).
- No TrialLink component was trained or fine-tuned on any benchmark. Ranking costs about CNY 0.24 (USD 0.03) per patient for some 410
  candidate trials.

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

- **Benchmarks and scorers.** The ranking and NIH-TrialBench boards use TrialGPT 2.0's released data and official scripts
  (`eval_trialgpt_rankings_qrels.py`, `eval_nih_trialbench_target_recall_at10.py`). TREC CT uses the official qrels and the track's
  measures, an unjudged trial counted as not relevant. n2c2 uses the challenge's unchanged `track1_eval.py`.
- **Two meanings of P@10.** On the TrialGPT 2.0 board P@10 is graded (an excluded or potentially eligible trial earns half credit); on
  TREC CT it counts eligible trials only. The two are not comparable.
- **Development and held-out data.** Ranking choices were made on 78 development patients (all 58 SIGIR patients and the first ten topics
  of each TREC year); the other 105 patients were read only after the design was fixed. NIH-TrialBench was used for testing only. The
  criterion-level assessment was revised on the TrialGPT annotation set, which is therefore its development set; the n2c2 official test
  was then run once on the frozen system, scored under the reading named before scoring.
- **Uncertainty.** 95% intervals are percentile bootstraps over patients (10,000 resamples for ranking and TREC, 2,000 for n2c2).
- **Comparators.** Every comparator number is copied from the cited source. TrialGPT 2.0 gives its results as bar charts; its values are
  read from the bar labels. The final panel of the figure divides TrialLink's score by the best published system in each panel.

## 3. Leaderboards by capability

Generated from [`leaderboard.json`](leaderboard.json). TrialLink and published systems are ranked; manual runs, physicians, baselines
and track medians are listed beside them.

<!-- tables:start -->

#### Patient-to-trial ranking · nDCG@10

SIGIR 2016 + TREC 2021/2022 · 183 patients · judged trials

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **TrialLink** | **0.775 (0.743–0.806)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · Gemini-3.1-pro | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.74 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · Gemini-3.1-pro | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.68 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### Patient-to-trial ranking · MAP

same 183 patients · graded MAP, official evaluator

| Rank | System | MAP | Source |
|---|---|---|---|
| 1 | **TrialLink** | **0.617 (0.588–0.645)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.60 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.56 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.54 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.49 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### SIGIR 2016 cohort

58 patients · judged trials · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | TrialGPT 2.0 · GPT-5.4 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · GPT-4.1 | 0.64 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 3 | **TrialLink** | **0.628 (0.567–0.686)** | this report |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.62 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.58 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2021 cohort

75 patients · judged trials · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **TrialLink** | **0.880 (0.844–0.912)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.83 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.79 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2022 cohort

50 patients · judged trials · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **TrialLink** | **0.815 (0.747–0.877)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.75 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### NIH-TrialBench

126 vignettes · target trial in top 10 · % (institute macro)

| Rank | System | Recall@10 (%) | Source |
|---|---|---|---|
| 1 | **TrialLink** | **96.0** | this report |
| 2 | TrialGPT 2.0 · GPT-4.1 | 70.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 3 | TrialGPT 1.0 · GPT-4.1 | 54.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 4 | ChatGPT-5.5 Thinking (web) | 43.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 5 | Gemini-3.5 Flash Ext. Thinking (web) | 21.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |

#### TREC CT 2021

full collection · 375,580 trials · 75 topics · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| – | TDMINER (manual run) (manual run) | 0.715 | TDMINER, TREC 2021 notebook |
| 1 | h2oloo monoT5 | 0.712 | Pradeep et al., SIGIR 2022, Table 3 |
| 2 | Alibaba DAMO | 0.595 | Pradeep et al., SIGIR 2022, Table 3 |
| 3 | **TrialLink** | **0.559 (0.491–0.624)** | this report |
| 4 | CSIROmed | 0.532 | Pradeep et al., SIGIR 2022, Table 3 |
| 5 | Kusa et al. (BM25+) | 0.513 | Kusa et al., JBI 2023, Table 4 |
| 6 | Peikos et al. (ChatGPT+RM3) | 0.512 | Peikos et al., arXiv 2306.02077, Table 15 |
| – | BM25 on the note (baseline) | 0.469 | Peikos et al., arXiv 2306.02077 |
| – | Track median (reference) | 0.304 | Pradeep et al., SIGIR 2022 |

TrialLink top-10 judged 60%: unjudged trials count as not relevant, so its score is a lower bound.

#### TREC CT 2022

full collection · 375,580 trials · 50 topics · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | Jullien et al. (GPT-4-turbo) | 0.693 | Jullien et al., arXiv 2409.18998, Table 2 |
| 2 | IELAB (GPT-4) | 0.659 | IELAB, TREC 2023 notebook, Table 1 |
| 3 | h2oloo (official #1) | 0.613 | TREC 2022 overview, Table 4 |
| 4 | Kusa et al. (TCRR-Bio) | 0.604 | Kusa et al., JBI 2023, Table 5 |
| 5 | **TrialLink** | **0.585 (0.508–0.660)** | this report |
| 6 | DoSSIER (official #2) | 0.556 | TREC 2022 overview, Table 4 |
| 7 | Peikos et al. (ChatGPT+RM3) | 0.509 | Peikos et al., arXiv 2306.02077, Table 15 |
| 8 | CSIROmed | 0.491 | TREC 2022 overview |
| – | Track median (reference) | 0.392 | Kusa et al., JBI 2023, Table 5 |

TrialLink top-10 judged 68% (lower bound). Its P@10 0.526 and RR 0.809 are above the best official run (0.508, 0.726).

#### TREC CT 2023

full collection · 451,538 trials · 37 topics · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | CSIROmed (fine-tuned GPT-3.5) | 0.738 | CSIROmed, TREC 2023 notebook, Table 1 |
| 2 | IELAB (GPT-4) | 0.736 | IELAB, TREC 2023 notebook, Table 2 |
| 3 | DoSSIER | 0.684 | DoSSIER, TREC 2023 notebook, Table 2 |
| 4 | IELAB cross-encoder | 0.672 | IELAB, TREC 2023 notebook |
| – | Track median (reference) | 0.648 | DoSSIER and CSIROmed, TREC 2023 notebooks |
| – | CSIROmed BM25 (baseline) | 0.619 | CSIROmed, TREC 2023 notebook |
| 5 | IELAB dense | 0.577 | IELAB, TREC 2023 notebook |
| 6 | **TrialLink** | **0.504 (0.433–0.573)** | this report |

TrialLink top-10 judged 52% (lower bound). Its P@10 0.451 is above the track median 0.394 and its RR 0.778 is the highest listed.

#### Criterion-level eligibility

TrialGPT annotations · 1,015 criteria · 53 patients · accuracy %

| Rank | System | Accuracy (%) | Source |
|---|---|---|---|
| – | Physician (highest) (physician) | 90.0 | Jin et al., Nat Commun 2024 |
| – | Physician (lowest) (physician) | 88.7 | Jin et al., Nat Commun 2024 |
| 1 | TrialGPT 1.0 · GPT-4 | 87.3 | Jin et al., Nat Commun 2024 |
| 2 | **TrialLink** | **76.7 (73.3–79.9)** | this report |

Annotators labelled with GPT-4's predictions in view, so the reference favours GPT-4.

#### n2c2 2018 cohort selection

official test · 86 patients × 13 criteria · micro-F1

| Rank | System | Micro-F1 | Source |
|---|---|---|---|
| 1 | GPT-4 zero-shot (Wornow et al.) | 0.93 | Wornow et al., arXiv 2402.05125, Table 1 |
| 2 | Graz (official #1, rules) | 0.91 | Stubbs et al., JAMIA 2019, Table 2 |
| 3 | U Michigan | 0.908 | Stubbs et al., JAMIA 2019, Table 2 |
| 4 | Sorbonne Université | 0.907 | Stubbs et al., JAMIA 2019, Table 2 |
| 5 | **TrialLink** | **0.894 (0.876–0.912)** | this report |
| 6 | MedGemma-27b + RAG + LoRA | 0.891 | Chen et al., arXiv 2604.05190, Table 3 |
| – | 47-team median (reference) | 0.823 | Stubbs et al., JAMIA 2019 |
| 7 | GPT-3.5 | 0.82 | Wornow et al., arXiv 2402.05125, Table 3 |
| 8 | Mixtral-8x7B | 0.79 | Wornow et al., arXiv 2402.05125, Table 1 |
| 9 | Llama-2-70b | 0.67 | Wornow et al., arXiv 2402.05125, Table 1 |

Official evaluator (track1_eval.py). A criterion answered neither met nor not met is read as not met, except ENGLISH and MAKES-DECISIONS (read as met): the reading named before scoring.

<!-- tables:end -->

## 4. Cost and speed

Measured on the ranking board (some 410 candidates per patient): Qwen3.7 rerank CNY 0.08 per patient, 2.6 s per 100 trials; Jev 1.14
scoring CNY 0.16 per patient, 0.25 s per trial with eight in flight. A product search ranks 300 candidates. The criterion-by-criterion
assessment of 20 trials for one patient takes a median of 79 s (90th percentile 117 s; five patients, measured end to
end on the production agent runtime), with the trials' criteria split across up to 12 concurrent Flash agents.

## 5. Reproduce

Evaluation code: `OpenScience/evals/vcr-matching-boards/` (runners, official scorers, `native_replay.mjs` for the assessment stage on the
real agent kernel). Benchmark data: the TrialGPT 2.0 repository (commit `1c5f9eb`), the TREC Clinical Trials qrels for 2021–2023 and the
n2c2 2018 Track 1 data. Every number on this page is in [`leaderboard.json`](leaderboard.json); `make_figures.py` draws the figures
and writes the tables above from it.

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
- Stubbs A. et al. *Cohort selection for clinical trials: n2c2 2018 shared task track 1.* JAMIA 26(11), 2019, Table 2.
- Wornow M. et al. *Zero-shot clinical trial patient matching with LLMs.* arXiv 2402.05125, Tables 1 and 3.
- Chen et al. arXiv 2604.05190, Table 3 (MedGemma-27b with retrieval and LoRA on n2c2 2018).
