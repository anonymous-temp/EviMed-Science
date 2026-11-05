# Precedent retrieval comparison (虚拟临床研究, algorithm round E5)

`findPrecedents` (apps/server/src/vcrEvidence.mjs) ranks the registry trials a search found. Until 2026-11-03 it ranked them by a weighted word
overlap that counted "the record has results" as 0.15 of the score. It now ranks them by BM25 over the trial's title, conditions and interventions
plus the knowledge base's embedder over their meaning, with the weight following the language of the question
(`apps/server/src/vcrPrecedentRanking.mjs`), and "has results" is shown beside a candidate and only breaks a tie. This directory measures whether that
is better than what it replaced, on labels that can be had cheaply. **The labels are structural, not expert.**

```bash
cd OpenScience
node --test evals/vcr-precedent-retrieval/tests/*.test.mjs                        # the label rule and the metrics, no network
node evals/vcr-precedent-retrieval/run.mjs --embed-key-file <dashscope key file>  # the whole comparison (about 2 minutes, about 1,300 short texts embedded)
node evals/vcr-precedent-retrieval/run.mjs                                        # without a key: the lexical rows only, and it says so
```

Options: `--conditions N` (of the 25 in the file), `--queries N` per condition (default 8), `--seed`, `--delay-ms` between registry requests, `--out`.
The embedder is the knowledge base's (`KbEmbedder`, the pin in `deps-version.json`); its key is read from `--embed-key-file` (or
`OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE`, the name the server's configuration reads), held in memory, never printed or written. If the embedder does not
answer, the run stops: it never reports the lexical fallback as the hybrid.

## What is compared, and the labels

For each of 25 English condition strings, a ClinicalTrials.gov API v2 search for the condition (100 records, the registry's own order) is the
candidate list. Records without MeSH terms for their condition or their intervention cannot be labelled and are left out (more than half: 1,134 of about 2,500 were kept). A random sample
of up to 8 trials per list are the questions: each asks with the condition and the drug names its own record states, as a run would write them. Every
other trial in the list is labelled from the MeSH terms ClinicalTrials.gov's own indexer attached to the two records (`score.mjs`):

- **2**: the same condition (a shared condition descriptor) and the same drug under any name (a shared intervention descriptor);
- **1**: the same condition and the same narrow chemical family (a shared intervention ancestor term);
- **0**: otherwise. A term held by more than 3% of the corpus (Placebos, Organic Chemicals; 49 of them) never counts. A question needs at least two
  relevant trials in its list to be used.

This is a rule over an index, not a judgement by a person. It is correlated with the words of the records (the indexer maps words to terms), it does
not know that two drugs of one class are or are not good precedents for each other, and "the same family" is chemical structure, not pharmacology. It
tells which records the registry itself files under the same condition and the same drug, which is what a precedent search first has to find.

The rankings, all over the same list: `registry` (the order returned), `overlap_old` (the previous formula: 0.35 condition + 0.30 intervention + 0.10 phase
+ 0.10 design + 0.15 has-results), `overlap_new` (the same overlap without has-results), `bm25` (the shipped ranking with no embedder), `embedding` (the
embedder alone), `hybrid` (the shipped ranking, 0.4 BM25 + 0.6 embedder) and `hybrid_equal` (0.5 + 0.5, not shipped). The weights were fixed before the
comparison was run and were not tuned on it. Metrics: nDCG@10 with the gains 0/1/2, P@5, MAP, MRR, and **name-blind recall@10**: of the relevant trials
whose intervention names share no word with the question's drug names (a brand and a generic, a class mate), the share found in the first ten. That is
the part of the task the words cannot see and the meaning is for. Intervals are percentile bootstrap over questions, 2000 resamples, seed 20261103.

## Result (2026-11-03, 193 questions over 25 conditions, 1,134 labelled records, mean list of 47 trials, 12.3% of a list relevant)

`results/2026-11-03.json` holds these numbers, the paired differences and the NCT ids of the pool.

| ranking | nDCG@10 | P@5 | MAP | MRR | name-blind recall@10 (151 questions) |
|---|---|---|---|---|---|
| registry order (no ranking) | 0.166 [0.142, 0.190] | 0.124 [0.103, 0.146] | 0.190 [0.174, 0.205] | 0.274 [0.232, 0.317] | 0.215 [0.171, 0.267] |
| word overlap, as it was (with has-results) | 0.520 [0.476, 0.565] | 0.362 [0.320, 0.404] | 0.452 [0.412, 0.492] | 0.675 [0.618, 0.733] | 0.183 [0.144, 0.226] |
| word overlap without has-results | 0.592 [0.545, 0.641] | 0.426 [0.381, 0.469] | 0.513 [0.470, 0.558] | 0.715 [0.659, 0.769] | 0.158 [0.117, 0.201] |
| BM25 alone | 0.649 [0.605, 0.693] | 0.464 [0.421, 0.507] | 0.558 [0.516, 0.600] | 0.770 [0.719, 0.819] | 0.227 [0.180, 0.277] |
| embedder alone | 0.611 [0.573, 0.650] | 0.429 [0.395, 0.465] | 0.526 [0.491, 0.561] | 0.775 [0.729, 0.822] | 0.304 [0.257, 0.356] |
| **hybrid, as shipped (0.4 BM25 + 0.6 embedder)** | 0.686 [0.645, 0.723] | 0.493 [0.453, 0.534] | 0.595 [0.558, 0.633] | 0.816 [0.769, 0.860] | 0.281 [0.232, 0.336] |
| hybrid at equal weight (not shipped) | 0.686 [0.646, 0.723] | 0.498 [0.459, 0.539] | 0.596 [0.558, 0.635] | 0.804 [0.757, 0.848] | 0.285 [0.235, 0.341] |

Paired differences over the same questions (mean and 95% interval):

| | nDCG@10 | MAP | name-blind recall@10 |
|---|---|---|---|
| hybrid minus the old overlap | +0.166 [+0.134, +0.200] | +0.144 [+0.117, +0.170] | +0.098 [+0.040, +0.160] |
| hybrid minus BM25 alone | +0.036 [+0.014, +0.060] | +0.037 [+0.018, +0.057] | +0.054 [+0.004, +0.105] |
| BM25 alone minus the old overlap | +0.129 [+0.095, +0.164] | +0.106 [+0.079, +0.132] | +0.044 [-0.016, +0.106] |
| embedder alone minus BM25 alone | -0.038 [-0.072, -0.002] | -0.032 [-0.065, -0.000] | +0.077 [+0.021, +0.133] |
| the old overlap without has-results minus with it (difference of the means) | +0.072 | +0.061 | -0.025 |

## What this does and does not say

- On these labels the shipped hybrid ranks better than the overlap it replaced (nDCG@10 0.52 to 0.69) and better than BM25 alone (+0.036); the embedder
  alone is a little worse than BM25 overall and clearly better at the trials the words cannot see (0.30 against 0.23). Removing has-results from the
  overlap alone is worth +0.07 nDCG@10. The labels do not reward has-results by construction, so this is no finding that results are never wanted: the
  flag is still on the candidate and still breaks a tie.
- The hybrid at equal weight is as good as 0.4/0.6 here, so these English-question labels do not choose the weights. The reason the weight is 0 for BM25
  when the question has no Latin word is not shown by this data (see below).
- The absolute numbers are not a measure of usefulness to a researcher. The labels share their source with the words (MeSH is assigned from the
  record's text), which favours the lexical rows; the name-blind recall of every row, 0.16 to 0.30, says most of what the words cannot see is still not
  found in the first ten.
- **Not tested:** a question written in Chinese (the case the weighting rule is for: a benchmark in the survey notes had BM25 at equal weight pulling a
  Chinese question's nDCG@10 from 0.620 to 0.330; no labelled Chinese trial set was available cheaply), ChiCTR and CTIS records (only
  ClinicalTrials.gov lists), the phase and design terms (the questions state neither, so both stay neutral), lists longer than 100, and any judgement by a
  person of what a good precedent is. The labels are rebuilt from the live registry, so a rerun will not reproduce the numbers to the digit; the pool
  ids are in the results file.
