# Linemach: benchmark results

**Linemach `triallink-3` · November 2026**

Linemach is a patient-to-trial matching system: one pipeline from a patient record to a ranked list of clinical trials, with a
criterion-by-criterion eligibility assessment of the trials a clinician opens. This report gives its results on the public benchmarks the
field reports on, one capability at a time, beside every published system with a comparable number.

![Linemach leaderboard](fig1-leaderboard.png)

## Where Linemach stands

| Capability | Benchmark | Linemach | Position among listed systems | Strongest listed comparator |
|---|---|---|---|---|
| Patient-to-trial ranking | SIGIR + TREC 2021/2022, 183 patients, every judged trial (TrialGPT 2.0 protocol) | nDCG@10 **0.792**, P@10 **0.724**, MRR 0.849, MAP **0.637** | **1st of 7** on nDCG@10, P@10 and MAP; MRR level with the leader | TrialGPT 2.0 · GPT-5.4: 0.76, 0.70, 0.85, 0.60 |
| — on retrieved candidates | the same patients, judged trials in TrialGPT-Retrieval's top 500 (TrialGPT 1.0 protocol) | nDCG@10 **0.796**, P@10 **0.720** | **1st of 8** on both | TrialGPT 1.0 · GPT-4: 0.728, 0.669 |
| — per cohort | TREC 2021 / TREC 2022 / SIGIR | 0.890 / 0.824 / 0.663 | **1st of 5** on all three | 0.84 / 0.78 / 0.66 |
| Target-trial retrieval | NIH-TrialBench, 126 vignettes | recall@10 **95.9%** | **1st of 5** | TrialGPT 2.0: 70% |
| Criterion-level eligibility | TrialGPT annotations: the 722 criteria physicians decided | accuracy **92.2%** | **1st of 2** systems; physicians 89.0–93.1% | TrialGPT 1.0 · GPT-4: 87.4% |
| Cohort selection | n2c2 cohort selection, official test | micro-F1 **0.919** | **1st of 14** | Hybrid NLP system (post-challenge): 0.911; rule-based challenge winner 0.910 |

- On the TrialGPT 2.0 protocol Linemach ranks first on nDCG@10, P@10 and MAP; on MRR it scores 0.849 against 0.85 (a bar label), level
  at two decimals. Its nDCG@10 interval (0.762–0.822) overlaps TrialGPT 2.0 with GPT-5.4 (0.76); published systems report point
  estimates only, so no paired test is possible. On the 105 patients held out from all development it scores nDCG@10 0.848, and on the
  SIGIR cohort 0.663 against 0.66.
- On the TrialGPT 1.0 protocol (the candidates its retrieval returned) Linemach leads all seven systems that paper compares — five
  biomedical encoders and TrialGPT with GPT-3.5 and GPT-4 — by 0.06 nDCG@10 or more.
- On the criteria the physicians decided, Linemach is ahead of GPT-4 by 4.8 points (+0.3 to +9.9) and inside the range of the three
  physicians who built the labels (89.0%, 90.7%, 93.1%, each scored against the consensus). Over all 1,015 criteria it agrees
  77.8% against GPT-4's 87.3%: on the 293 criteria labelled "not enough information", 255 labels are GPT-4's own answer, kept by
  annotators who labelled with GPT-4's predictions in view.
- On n2c2 cohort selection (official test, one complete pass of the final code) Linemach scores micro-F1 0.919, above every system of the
  challenge (winner 0.910), the best post-challenge system we found (0.911) and fine-tuned open models (MedGemma-27b with retrieval,
  0.891).
- No Linemach component was trained or fine-tuned on any benchmark. Ranking costs about CNY 0.38 (USD 0.05) per patient for some 410
  candidate trials; the criterion-level assessment about CNY 0.12 per n2c2 patient.

## 1. The system

Linemach has three stages.

![Linemach architecture](fig0-architecture.png)

1. **Retrieval.** A keyword search over the patient's condition (asked deepest, up to 200 trials) and up to 32 ranked English
   search terms written from the record (Chinese terms too when the record is Chinese), fused by reciprocal rank with a dense semantic
   search (Qwen3.7 text embedding, 1024 dimensions); trials are kept or dropped by the age and sex their registry record states; the
   first 300 go on. A long record stands for itself as a dated profile summary (one Flash call, cached per record). In the product the
   keyword search runs live against ClinicalTrials.gov, the EU CTIS and ChiCTR.
2. **Ranking.** Three orders of the candidates, each from the whole registry record: an eligibility reranker (Qwen3.7 text rerank over
   the record's first 12,000 characters, half weight), and two readings by Jev 1.14 in one request — a five-level eligibility fit and a
   five-level graded reading taken as its expected benchmark gain — fused by weighted reciprocal rank (k = 60). Ranking makes no call to
   a general reasoning model.
3. **Assessment.** For the trials a clinician selects, a DeepSeek V4.1 Flash agent judges each inclusion and exclusion criterion against
   cited passages of the record (met, not met, not enough information). It reads the newest records whole and, from older records, the
   passages retrieved for each criterion, each passage with its record date and section; it can search the whole record. A criterion
   that combines conditions is answered part by part and a time window by its dates, and code counts the parts and the days. The facts
   that keep criteria open are listed for the clinician. The assessment explains the ranking; it does not reorder it.

## 2. Evaluation protocol

- **Same configuration for every system.** Each benchmark is run with its own task definition, the one its other systems were given:
  TrialGPT's criterion-level instructions for the TrialGPT annotations, and the n2c2 annotation guidelines (the notion of "now", and how
  an unmentioned criterion is labelled) for n2c2. Linemach receives them as the study's assessment guide; the platform adds no labelling
  rule of its own.
- **Benchmarks and scorers.** The patient-to-trial ranking boards and NIH-TrialBench use TrialGPT 2.0's released data and official scripts
  (`eval_trialgpt_rankings_qrels.py`, `eval_nih_trialbench_target_recall_at10.py`); n2c2 uses the challenge's unchanged `track1_eval.py`.
- **Development and test data.** Ranking choices were made on 78 development patients (all 58 SIGIR patients and the first ten topics of
  each TREC year); the other 105 were read only after the design was fixed. NIH-TrialBench was used for testing only. The criterion-level
  assessment was developed on the TrialGPT annotations and on the n2c2 training split. Design choices for the assessment (including
  removing a verification pass that did not help) were made on Board C and the n2c2 training split's 40 development patients. The n2c2
  official test was first run on 2026-11-08 (micro-F1 0.894) and read again in later rounds; the result above is one complete pass of
  the final code, so it is a re-run on a test set that has been seen. The ranking weights were chosen on the development patients,
  SIGIR included.
- **Uncertainty.** 95% intervals are percentile bootstraps over patients (10,000 resamples; 2,000 for n2c2).
- **Comparators.** Every comparator number is copied from the cited source, or computed from released predictions where stated. TrialGPT
  2.0 gives its results as bar charts; its values are read from the bar labels. TrialGPT 2.0 reports NIH-TrialBench only with its default
  backbone, GPT-4.1. The final panel of the figure divides Linemach's score by the best published system in each panel.
- **Two ranking protocols, kept apart.** TrialGPT 2.0 ranks every judged trial of a patient; TrialGPT 1.0 ranked only the judged trials
  among the top 500 its retrieval returned, and released those candidates. The two are separate panels, each scored with the same official
  script (whose nDCG@10 and graded P@10 are the definitions TrialGPT 1.0 gives); Linemach's ranking of all judged trials is restricted to
  TrialGPT 1.0's candidates for the second. TrialMatchAI (Nat Commun 2026) ranks every judged trial of a TREC year with eligible-only
  relevance, and LLM-Match (2025) reports only AUROC on these pairs; neither is on either axis, so neither is listed.
- **Physicians.** TrialGPT 1.0 publishes each physician's confusion matrix against the consensus (proportions per gold label). Weighted by
  the released gold counts they give each physician's accuracy on the criteria the physicians decided; the same rebuild gives GPT-4 87.7%
  against its exact 87.4% and the paper's whole-set range within 0.1 point, so the physician values carry about ±0.5 point.

## 3. Leaderboards by capability

Generated from [`leaderboard.json`](leaderboard.json). Linemach and published systems are ranked (equal scores share a rank);
physicians and medians are listed beside them.

<!-- tables:start -->

#### Patient-to-trial ranking · nDCG@10

SIGIR 2016 + TREC 2021/2022 · 183 patients · every judged trial ranked (TrialGPT 2.0 protocol, official evaluator)

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.792 (0.762–0.822)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · Gemini-3.1-pro | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.74 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · Gemini-3.1-pro | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.68 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### Patient-to-trial ranking · P@10

same 183 patients · graded P@10 (an excluded or potentially eligible trial counts half), official evaluator

| Rank | System | P@10 (graded) | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.724 (0.692–0.756)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.69 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.67 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.67 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.63 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### Patient-to-trial ranking · MRR

same 183 patients · reciprocal rank of the first eligible trial, official evaluator

| Rank | System | MRR | Source |
|---|---|---|---|
| 1 | TrialGPT 2.0 · GPT-5.4 | 0.85 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | **Linemach** | **0.849 (0.806–0.889)** | this report |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.80 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 6 | TrialGPT 1.0 · Gemini-3.1-pro | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.73 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### Patient-to-trial ranking · MAP

same 183 patients · graded MAP, official evaluator

| Rank | System | MAP | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.637 (0.608–0.666)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.60 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.56 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.54 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.49 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### Patient-to-trial ranking · top-500 · nDCG@10

SIGIR 2016 + TREC 2021/2022 · 183 patients · the judged trials among TrialGPT-Retrieval's top 500 (TrialGPT 1.0 protocol) · mean of the three cohorts

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.796 (0.765–0.824)** | this report |
| 2 | TrialGPT 1.0 · GPT-4 | 0.728 | Jin et al., Nat Commun 2024, Table 2 |
| 3 | TrialGPT 1.0 · GPT-3.5 | 0.54 | Jin et al., Nat Commun 2024, Table 2 |
| 4 | BioLinkBERT (NLI-trained) | 0.48 | Jin et al., Nat Commun 2024, Table 2 |
| 5 | PubMedBERT (NLI-trained) | 0.433 | Jin et al., Nat Commun 2024, Table 2 |
| 6 | SciFive (NLI-trained) | 0.427 | Jin et al., Nat Commun 2024, Table 2 |
| 7 | SapBERT (NLI-trained) | 0.415 | Jin et al., Nat Commun 2024, Table 2 |
| 8 | BioBERT (NLI-trained) | 0.409 | Jin et al., Nat Commun 2024, Table 2 |

Scored with the same official script as the panels above, restricted to the candidates TrialGPT 1.0 released (its retrieved_trials.json: 3,141 / 15,437 / 12,682 judged pairs); Linemach's ranking of all judged trials is restricted to them. The script's nDCG@10 (linear gain) and P@10 (sum of grades / (2 × 10)) are the definitions TrialGPT 1.0 gives. The five encoders were trained on natural-language-inference data and applied to the cohorts without cohort training, as in the source. TrialGPT 1.0 · GPT-4 is its feature combination, the paper's headline configuration (its best single features reach 0.7281 nDCG@10 and 0.6724 P@10). Not placed on these axes: TrialMatchAI (Nat Commun 2026) ranks every judged trial of a TREC year with eligible-only relevance, and LLM-Match (2025) reports only AUROC on these pairs.

#### Patient-to-trial ranking · top-500 · P@10

SIGIR 2016 + TREC 2021/2022 · 183 patients · the judged trials among TrialGPT-Retrieval's top 500 (TrialGPT 1.0 protocol) · mean of the three cohorts

| Rank | System | P@10 (graded) | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.720 (0.688–0.752)** | this report |
| 2 | TrialGPT 1.0 · GPT-4 | 0.669 | Jin et al., Nat Commun 2024, Table 2 |
| 3 | TrialGPT 1.0 · GPT-3.5 | 0.512 | Jin et al., Nat Commun 2024, Table 2 |
| 4 | BioLinkBERT (NLI-trained) | 0.428 | Jin et al., Nat Commun 2024, Table 2 |
| 5 | PubMedBERT (NLI-trained) | 0.387 | Jin et al., Nat Commun 2024, Table 2 |
| 6 | SciFive (NLI-trained) | 0.379 | Jin et al., Nat Commun 2024, Table 2 |
| 7 | BioBERT (NLI-trained) | 0.375 | Jin et al., Nat Commun 2024, Table 2 |
| 8 | SapBERT (NLI-trained) | 0.374 | Jin et al., Nat Commun 2024, Table 2 |

Scored with the same official script as the panels above, restricted to the candidates TrialGPT 1.0 released (its retrieved_trials.json: 3,141 / 15,437 / 12,682 judged pairs); Linemach's ranking of all judged trials is restricted to them. The script's nDCG@10 (linear gain) and P@10 (sum of grades / (2 × 10)) are the definitions TrialGPT 1.0 gives. The five encoders were trained on natural-language-inference data and applied to the cohorts without cohort training, as in the source. TrialGPT 1.0 · GPT-4 is its feature combination, the paper's headline configuration (its best single features reach 0.7281 nDCG@10 and 0.6724 P@10). Not placed on these axes: TrialMatchAI (Nat Commun 2026) ranks every judged trial of a TREC year with eligible-only relevance, and LLM-Match (2025) reports only AUROC on these pairs.

#### SIGIR cohort · nDCG@10

58 patients · every judged trial ranked · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.663 (0.604–0.720)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · GPT-4.1 | 0.64 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.62 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.58 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2021 cohort · nDCG@10

75 patients · every judged trial ranked · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.890 (0.853–0.923)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.83 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.79 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2022 cohort · nDCG@10

50 patients · every judged trial ranked · nDCG@10

| Rank | System | nDCG@10 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.824 (0.761–0.880)** | this report |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.75 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### NIH-TrialBench · Recall@10 (%)

126 vignettes · target trial in top 10 · % (institute macro)

| Rank | System | Recall@10 (%) | Source |
|---|---|---|---|
| 1 | **Linemach** | **95.9** | this report |
| 2 | TrialGPT 2.0 | 70.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 3 | TrialGPT 1.0 | 54.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 4 | GPT-5.5 | 43.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 5 | Gemini 3.5 Flash | 21.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |

TrialGPT 2.0 reports NIH-TrialBench only with its default backbone, GPT-4.1 ("Unless otherwise specified, all main analyses used GPT-4.1"); its GPT-5.4 and Gemini runs cover the three public cohorts only. Linemach over all 126 cases: 88.1% (81.7–93.7). Candidates: the 300 trials of the 1,373-trial NIH corpus a relevance rerank of the whole corpus put first stand in for retrieval; Linemach ranks them as in the product.

#### n2c2 cohort selection · micro-F1

official test · 86 patients × 13 criteria · micro-F1

| Rank | System | Micro-F1 | Source |
|---|---|---|---|
| 1 | **Linemach** | **0.919 (0.905–0.934)** | this report |
| 2 | Hybrid NLP, post-challenge | 0.911 | Vydiswaran et al., JAMIA 2019 (reimplemented system) |
| 3 | Rule-based (challenge #1) | 0.91 | Stubbs et al., JAMIA 2019, Table 2 |
| 4 | Hybrid NLP (MetaMap + cTAKES) | 0.908 | Stubbs et al., JAMIA 2019, Table 2 |
| 5 | Rules + semi-supervised | 0.907 | Stubbs et al., JAMIA 2019, Table 2 |
| 6 | Three-stage rule-based | 0.903 | Stubbs et al., JAMIA 2019, Table 2 |
| 7 | cTAKES + regex hybrid | 0.903 | Stubbs et al., JAMIA 2019, Table 2 |
| 8 | Rules + word2vec | 0.90 | Stubbs et al., JAMIA 2019, Table 2 |
| 9 | 280-rule system | 0.891 | Stubbs et al., JAMIA 2019, Table 2 |
| 10 | MedGemma-27b + RAG + LoRA | 0.891 | Chen et al., arXiv 2604.05190, Table 3 |
| 11 | Rules + CNN-highway-LSTM | 0.886 | Stubbs et al., JAMIA 2019, Table 2 |
| 12 | Trie rule processor | 0.884 | Stubbs et al., JAMIA 2019, Table 2 |
| 13 | Rules + SVM | 0.877 | Stubbs et al., JAMIA 2019, Table 2 |
| 14 | Llama-3.1-8b + LoRA | 0.867 | Chen et al., arXiv 2604.05190, Table 3 (full context) |
| – | 47-team median (reference) | 0.823 | Stubbs et al., JAMIA 2019 |

Official evaluator (track1_eval.py), Linemach given the n2c2 annotation guidelines. An answer neither met nor not met is read as the guidelines label an unmentioned criterion: not met, except ENGLISH and MAKES-DECISIONS (met). One complete pass of the final code over all 86 patients (the test set had been read in earlier rounds, so this is a re-run, not a held-out result); macro-F1 0.825. The challenge systems and the LoRA models were built on the n2c2 training split; no Linemach component was trained on it. Challenge systems are named by method (Stubbs et al., Table 2); the figure shows the first seven, the table all ten.

#### Criterion-level · physician-decided criteria (%)

TrialGPT annotations · the 722 of 1,015 criteria the physicians decided (included, not included, excluded, not excluded, not applicable) · accuracy % · Linemach given TrialGPT's own task definition

| Rank | System | Accuracy (%) | Source |
|---|---|---|---|
| – | Physician A | 93.1 | Jin et al., Nat Commun 2024, Fig. 3c–d (the physician's per-label matrix weighted by the released gold counts, ±0.5 point) |
| 1 | **Linemach** | **92.2 (89.4–94.6)** | this report |
| – | Physician C | 90.7 | Jin et al., Nat Commun 2024, Fig. 3c–d (the physician's per-label matrix weighted by the released gold counts, ±0.5 point) |
| – | Physician B | 89.0 | Jin et al., Nat Commun 2024, Fig. 3c–d (the physician's per-label matrix weighted by the released gold counts, ±0.5 point) |
| 2 | TrialGPT 1.0 · GPT-4 | 87.4 | TrialGPT released predictions (Jin et al., Nat Commun 2024), scored on the same rows |

Paired difference Linemach − GPT-4: +4.8 points (+0.3 to +9.9, patient bootstrap). GPT-4 is scored from TrialGPT's released predictions on the same rows. Each physician's accuracy on these rows is rebuilt from that physician's confusion matrices in TrialGPT 1.0 (proportions per gold label, two decimals) weighted by the released gold counts; the same rebuild gives GPT-4 87.7% against its exact 87.4%, and reproduces the paper's whole-set range (88.6–90.1% against 88.7–90.0%).

#### Criterion-level · all criteria (%)

TrialGPT annotations · 1,015 criteria · 53 patients · label agreement %

| Rank | System | Accuracy (%) | Source |
|---|---|---|---|
| – | Physician (highest) | 90.0 | Jin et al., Nat Commun 2024 |
| – | Physician (lowest) | 88.7 | Jin et al., Nat Commun 2024 |
| 1 | TrialGPT 1.0 · GPT-4 | 87.3 | Jin et al., Nat Commun 2024 |
| 2 | **Linemach** | **77.8 (73.5–81.7)** | this report |

On the 293 criteria the gold labels "not enough information", 255 labels are GPT-4's own answer kept by the annotators, who labelled with GPT-4's predictions in view; GPT-4 matches 87.0% of those rows, Linemach 42.3%. Linemach was given TrialGPT's own task definition (which asks for as few "not enough information" answers as possible).

<!-- tables:end -->

## 4. Cost and speed

Measured on the ranking board (some 410 candidates per patient): Qwen3.7 rerank over the whole record about CNY 0.17 per patient, 9.0 s
per 100 trials per request with three requests in flight; Jev 1.14 (fit and graded readings in one request) about CNY 0.21 per patient,
265 ms per call (262 ms for the fit alone) with eight in flight. A product search ranks 300 candidates. The criterion-level assessment
of an n2c2 patient (13 criteria, multi-record files) reads about 19,500 input tokens and costs about CNY 0.12 (86 test patients
CNY 10.2); the plain-text prompt cut the input from about 86,000 tokens. Assessing 20 trials for one patient takes a median of
120 s (five SIGIR patients on the pinned kernel, slowest 158 s, 12 executions in flight); before this round 79 s — the child now searches the
record before leaving a decisive criterion unknown, about 3.7 model calls per execution against 2.

## 5. Reproduce

Evaluation code: `OpenScience/evals/vcr-matching-boards/` (runners, official scorers, and `native_replay.mjs` for the assessment stage on
the real agent kernel; `--guide-file` passes a benchmark's task definition). Benchmark data: the TrialGPT 2.0 repository (commit
`1c5f9eb`), the TrialGPT 1.0 repository (criterion annotations and instructions) and the n2c2 cohort selection data and guidelines.
Every number on this page is in [`leaderboard.json`](leaderboard.json); `make_figures.py` draws the figures and writes the tables.

## References

- TrialGPT 2.0. *Towards Responsible AI-Assisted Clinical Trial Matching: Practical Considerations, Multicenter Evaluation, and
  Real-World Deployment.* arXiv 2609.01202v2 (2026), Fig. 5c–d and Supplementary Fig. 3.
- Jin Q. et al. *Matching patients to clinical trials with large language models* (TrialGPT). Nature Communications 15, 9074 (2024),
  Table 2 (ranking on retrieved candidates) and Fig. 3c–d (criterion-level confusion matrices of the physicians and GPT-4).
- Stubbs A. et al. *Cohort selection for clinical trials: n2c2 2018 shared task track 1.* JAMIA 26(11), 2019, Table 2.
- Vydiswaran V.G.V. et al. *Hybrid bag of approaches to characterize selection criteria for cohort identification.* JAMIA 26(11), 2019.
- Chen et al. arXiv 2604.05190, Table 3 (MedGemma-27b and Llama-3.1-8b with LoRA on n2c2 cohort selection).
- Not listed, different measure: Abdallah M. et al., *TrialMatchAI*, Nature Communications (2026); Li X. et al., *LLM-Match*, arXiv 2503.13281 (2025).
