# Jev batch 3, 2026-10-06 (E1-E4)

Total spend: Jev about $0.010 (370 calls, about 233k input tokens at $0.042/M, output free); Flash about 0.045 CNY (estimate at 1/2 CNY per M in/out). Budget was $0.50 / 5 CNY.
Every label here is **authored by me (weak)**; no third-party labels were used. Corpora with labels and per-row provenance are in `corpora/`; raw rows in `e*-results.json`; resumable via `STATUS`.
Caveats that apply to all four: small n, labels written by the same author who wrote the questions, and no repeated sampling. Treat the results as direction, not measurement.

## E1 科研选题 relevance gate (n=90: 48 fixture records + 42 off-topic SGLT2/CKD records; 23 labelled relevant, 5 of them borderline and excluded from headline numbers, so 85 scored: 18 relevant)
Fixture = `missed_dialysis_retrieval_2026_09_27.json` (it carries no labels of its own; mine are from reading titles/abstracts against its direction).

| Arm | Kept | Recall | Precision |
|---|---|---|---|
| Lexical legacy per-entity (the incident; reproduces 3 kept) | 2 | 0.00 | 0.00 |
| Lexical current (`concept_groups`, real `_filter_relevant_records`) | 28 | 1.00 | 0.64 (10 FP, all dialysis records not about adherence) |
| Flash, short prompt | 14 | 0.78 | 1.00 |
| Jev noul >=0.3 / 0.5 / 0.7, question "adherence to dialysis treatment or missed sessions" | 16 / 14 / 13 | 0.83 / 0.78 / 0.72 | 0.94 / 1.00 / 1.00 |
| Jev, question widened to "(dialysis sessions, medication, diet or fluid)" at 0.3 / 0.5 / 0.7 | 24 / 19 / 18 | 1.00 / 1.00 / 1.00 | 0.75 / 0.95 / 1.00 |

Jev median latency 224 ms per call (one record per call, about 530 input tokens); Flash 765 ms. Cost: Jev $0.004 for both Jev runs, Flash 0.025 CNY.
Note: the widened-wording run was tuned after seeing which medication-adherence records the first wording missed (4 of 18), on the same labels, so its 1.00 recall is optimistic. The single remaining FP at 0.5 is the pruritus paper (0.50, passing mention of adherence).
Verdict: the current grouped lexical gate already fixes the incident (3 of 688 to 28 of 48 here, full recall) but keeps every dialysis paper regardless of topic (precision 0.64). Jev removes those false positives while keeping recall near 1.0, once the question names the intended scope, and it is about as precise as Flash at about 3x lower latency. It looks usable as a second-stage precision filter after the lexical recall gate (keep a record if lexical passes and Jev >=0.3 to 0.5); it should not replace the lexical gate as first stage, and the question wording matters more than the threshold.

## E2 "already covered" / same-method matching (n=41 pairs: 17 same, 12 related, 12 different; both orders averaged; existing methods from domain METHOD_RECORDS / VCR_ENGINE_METHODS, candidate wording authored, includes Chinese and 3 literal id matches)

| Arm | Same recall | False "same" (on 24 non-same) | 3-way accuracy |
|---|---|---|---|
| Exact id equality (today, `METHOD_RECORDS` hasOwn) | 0.18 (3/17) | 0 | n/a |
| Word-Jaccard >=0.5 (`evolutionMaintenance.mjs:511`, on descriptions) | 0.06 (1/17) | 0 | n/a |
| Jev choice different/related/same | 0.94 (16/17) | 0 (0/12 related called same) | 0.90 |
| Flash, one batch call | 0.88 | 0 | 0.83 |

Jev median 224 ms per call (82 calls); Flash 1.7 s for the batch; cost $0.0017 / 0.003 CNY. Jev errors: one same called related (design.analytic vs sample-size-power-calculation, P(same)=0.15) and three related called different (burst detection, bibliographic coupling, negative-control calibration), all on the conservative side.
Verdict: today's two lexical tests almost never fire across wording or language, so a candidate that restates an existing method would be built again. Jev finds the paraphrases and Chinese variants and never merged a related-but-distinct method (0 of 12), which is the failure that matters for J11. Strong candidate to replace the covered-check; keep exact id as a free shortcut before it. Caveat: my synonym pairs are written in clear paraphrase, so real scout cards may be harder.

## E3 paper to capability relevance (n=40 papers from title-to-paper corpus-v3, 14 labelled relevant of which 5 are "adjacent" (single-cell/eQTL/NAFLD-epidemiology style), 16 public listed capabilities + none; choice, none first)

| Arm | Exact capability on 14 positives | Flagged any on positives | False flags on 26 negatives | Top-8 positives |
|---|---|---|---|---|
| First-come (no judge, shuffled order) | n/a | n/a | n/a | 3 of 8 |
| Jev argmax | 8 | 9 | 0 | 8 of 8 when ranked by 1-P(none) (7 of 8 counting only the 9 non-adjacent positives) |
| Flash, one batch | 6 | 6 | 0 | n/a (no probabilities) |

Jev score threshold 0.5: 12 flagged, 12 true; 0.3: 14 flagged, 13 true; 0.7: 9 flagged, 9 true. Two positives fall below 0.5 (eQTL 0.32, tissue single-cell map 0.28); the argmax picked "none" for three more (ROC guide 0.57, CellChat 0.55, Seurat multimodal 0.52) and the wrong capability for clusterProfiler (statistical-analysis instead of gene-expression-analysis). These are mostly my "adjacent" labels. Median 226 ms per call; cost $0.0022 / 0.007 CNY.
Verdict: as a ranker Jev is clearly better than first-come (8/8 vs 3/8 in the top 8, no clinical-trial or burden paper above a method paper, the highest-scoring negative is 0.48) and has no false flags at 0.5. Exact capability agreement is only 8/14, with misses concentrated where my labels are debatable, so use it to rank and gate "worth a scout", not to pick the capability. Caveat: the corpus contains few real method papers, so the positive class is thin.

## E4 same-study detection for evidence_deduplicate (n=34: 15 same-trial pairs (protocol / main / secondary analyses of DAPA-CKD, EMPA-KIDNEY, CREDENCE, CANVAS), 4 duplicate-record variants, 15 different-trial pairs on the same drug)

| Arm | Recall (19 same) | FP (15 different) | Same-trial pairs found | Duplicate-record variants | Different-trial called same |
|---|---|---|---|---|---|
| Exact DOI/PMID/normalized title (today) | 0.21 | 0 | 0/15 | 4/4 | 0/15 |
| Jev noul >=0.5 / 0.7 (both orders) | 1.00 | 0 | 15/15 | 4/4 | 0/15 |
| Jev >=0.3 | 1.00 | 1 | 15/15 | 4/4 | 1/15 |
| Flash batch | 1.00 | 0 | 15/15 | 4/4 | 0/15 |

Jev median 234 ms per pair (two calls in parallel); cost $0.0019 / 0.01 CNY.
Verdict: exact identity only catches the same record twice; a protocol, a main report and a secondary analysis of one trial pass through as three studies, which double counts the trial. Jev separates same-trial from different-trial-same-drug perfectly at 0.5 here, but Flash does equally well, and the labels are easy because the trial acronym appears in the text. A harder test (reports without acronyms, overlapping cohorts) is needed before trusting it for pooling; as a flag that sends candidate pairs to a reader it is already worthwhile.

## Files
`lib.mjs`, `build_*.py`, `e1.mjs e1b.mjs e1_lexical.py e2.mjs e3.mjs e4.mjs`, `corpora/e{1,2,3,4}.json`, `e*-results.json`, `COSTS.jsonl`, `STATUS`.
