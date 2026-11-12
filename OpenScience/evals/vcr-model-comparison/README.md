# VCR model component comparison

This directory evaluates proposed components without enabling them in the product.
The source baseline is `cde64eddca7f2e77486e1ecee45ed6b9c8cb4929` from
`codex/vcr-remediation-20261101`, fetched on 2026-11-02. This is newer VCR work
than the main branch inspected at the start. It is not a deployment receipt.

## Results — 2026-11-02

Matching: Flash 57.59%, Jev 1.13 53.88%, Jev 1.14 52.69% on the frozen 837-row evaluation partition. Neither confidence cascade improves Flash. These are expert-label agreements under an explicit unknown policy, not clinical accuracy.

Ranking global nDCG@10: BM25 .4517; default DashScope .4740; Jev 1.13 .5058; Jev 1.14 .5068. A separately frozen post-primary control with the identical clinical task instruction gives DashScope .4760; the Jev advantage remains. One Jev1.14 transport failure is retained through topic-level BM25 fallback. No established ranking benefit from changing the pin to1.14.

The public gain condition for a new TypeSafe n2c2 matching comparison was not met. Local cached-answer replay and verification were completed without new clinical-data transmission. See [aggregate results](results/2026-11-02-summary.json); detailed private evidence and issue records stay outside Git. 26 comparison, 89 matching and 23 n2c2 tests passed. No product integration or deployment.

## Experiment contract

### Criterion decisions

All 1,015 public TrialGPT annotations are predicted by Flash, Jev 1.13 and
Jev 1.14. These are **53 synthetic patient descriptions**, not 183 patients or
1,015 independent people. Ten whole patient groups (178 annotations) are used
only to calibrate each Jev cascade's threshold; the remaining 43 groups (837
annotations) form the paired evaluation partition. The public data were already
used by this project: neither partition is claimed to be a new clinical holdout.
The dataset's original row-level `training` flag overlaps patient identities,
so it is not used to construct these partitions.

Inputs allow only patient text, trial title/identity, criterion type/text and
annotation identity. Expert answers, GPT-4 answers, explanations and evidence
labels never enter provider requests. Each request contains up to five criteria
from the same patient and trial. Numeric and Boolean conditions in the raw-model
arms are diagnostic; these arms do not replace the production code evaluator.

All models use the same missingness policy: absent information remains unknown,
including unmentioned exclusion conditions. `met` denotes the condition being
true, including when that condition is an exclusion. Benchmark agreement is
reported separately from clinical correctness. Historical TrialGPT annotations
sometimes infer an absent exclusion from silence, so their published accuracy
is not a matched control for this policy. The original GPT-4 answer column is
retained as a historical reference only.

Jev receives typed choice questions and independent per-sentence relevance
questions. Flash returns a structured label and evidence-sentence IDs. Both
evidence mechanisms are disclosed; sentence membership is not proof of semantic
entailment. Jev confidence is a distribution statistic, not a clinical probability.

The cascade routes a criterion to the already recorded Flash answer if Jev is
invalid, below its development-only threshold, supplies no evidence for a definite
claim, or the criterion contains a numeric/temporal/Boolean pattern. That last
route is a component ablation using Flash, **not** a newly implemented clinical
calculator. Production still owns typed numeric, date, unit and logical evaluation.
Cascades are replayed offline; no online cascade latency or cost saving is claimed.

### Candidate ranking

All 165 TREC 2021–2023 topics use their frozen, independently selected BM25 top-ten
pool: 1,650 candidate pairs. The full 2021 snapshot has 375,580 trials and the full
2023 snapshot has 451,538. The 2021 snapshot is also the 2022 track's corpus.
The original candidate arrays were shuffled: their BM25 baseline order is
recovered from the independent selector ledger, never from gold judgments.

Compare BM25, configured `qwen3-rerank`, Jev 1.13 and Jev 1.14 on the same text
representation and truncation. Jev scores each patient/trial pair; DashScope
ranks ten candidates together. Preserve this difference when reading cost and
latency. Three 2023 topics have no qrels; all 165 are processed but metrics use
162 judged topics. Unjudged documents receive zero metric gain, not a clinical
ineligibility judgment. Grade 2 means eligible, grade 1 related but ineligible.

Report global-qrel nDCG@10 and candidate-pool nDCG separately, plus eligible MRR,
P@1, P@10 and recall@10. Reordering the same ten cannot improve P@10 or recall@10.
This does not reproduce TrialGPT's candidate pools or its published 0.7275, and
does not measure the platform's live three-registry retrieval recall.

### Real-note follow-up

The proposed new TypeSafe n2c2 comparison is conditional on a public matching gain.
Neither Jev matching arm or cascade met the fixed gain criterion in this run,
so the condition did not trigger. No n2c2 note was sent to TypeSafe or another
new cloud model in this campaign.

The user-supplied local n2c2 cache was nevertheless verified and replayed through
the actual current `assessPatient` / production `assessSubject` path: 202 training
patients were scored, and 86 official test patients were replayed to states only.
The sealed test archive was hashed without opening its labels. The 40 development
and 162 other training patients were used in earlier rounds, so they are regression
evidence. All 288 cached outputs are from mixed earlier prompt/code generations;
there is no combined new-model accuracy claim.

The newer local cache's 0.88088658 is **reading-C micro F1**, which imputes unknowns
according to benchmark conventions. Its strict accuracy is 0.4031. Eight of 14
producer file hashes differ from the fetched code. Replaying the same answers
through this code gives reading-C micro F1 0.8546: this isolates an evaluator/version
difference, not a model comparison or evidence that the current model got worse.

## Running

Requires Python 3.9+ and the standard library. `trec_eval` is used for an independent
ranking-metric cross-check. No SDK or model installation is required. Use a private
copy of `provider-config.example.json` containing key **file paths**; protect it
and the key files. Do not commit keys, real notes, or patient-level caches.

```sh
export VCR_EVAL_PROVIDER_CONFIG=/absolute/private/provider-config.json
python3 -m unittest discover -s OpenScience/evals/vcr-model-comparison -p 'test_*.py'
python3 OpenScience/evals/vcr-model-comparison/matching.py prepare \
  --inputs /path/to/allowlisted-trialgpt-inputs.json --out /private/run/matching
python3 OpenScience/evals/vcr-model-comparison/matching.py run \
  --arm flash --out /private/run/matching --workers 4
# Repeat run for jev113 and jev114, then open gold only in the scorer.
python3 OpenScience/evals/vcr-model-comparison/matching.py score \
  --gold /path/to/private-reference-labels.json --out /private/run/matching
python3 OpenScience/evals/vcr-model-comparison/ranking.py --help
```

`matching.py prepare` freezes patient splits and all request hashes before any
call. Ranking `freeze` similarly precedes provider execution; `--help` documents
its prepared-input and corpus-root arguments. Scorers revalidate request identity,
model identity, source text and candidate ownership. Missing/invalid predictions
remain in denominators. A failed ranking topic uses the original BM25 order and
is labelled as fallback. Raw first responses, errors and uncertainty are retained.

Requests resume from immutable receipts, never from whichever answer scores best.
A request reserved in the spend ledger without a terminal receipt is uncertain
and will not be silently purchased again. Ranking can resume after an explicitly
reviewed transport failure while retaining that failed first response without retry;
the scheduler amendment and first interruption remain in the private run artifacts.

Budget units are CNY for DeepSeek/DashScope and USD for TypeSafe. Budget ceilings
are per receipt directory, with the ranking runner also checking the combined Jev
plan. For a larger campaign add up directories before dispatching. Cost values use
reported usage and documented/reference prices; they are not supplier invoices.
Unreturned usage remains unknown. The experiment does not meter or alter production.

## Evidence and interpretation

Private artifacts are under `.evimed-local/acceptance/vcr-model-comparison-20261102/`:
frozen prompts and identities, every receipt, per-annotation disagreements, paired
patient bootstrap results, TREC official-scorer comparisons, local n2c2 replay,
code reviews and a report. The public results file carries aggregates only.

Scorer robustness fixes made after the first Flash calls changed no model-visible
payload: all 753 matching payload hashes (251 per model) were independently checked.
Fixes bind scoring to frozen request/model identity, preserve malformed answers as
failures, handle the dataset's null criterion text at annotation 883, and bind the
offline replay to exact patient XML, cached answer and prompt bytes. The old replay
protocol was retained; aggregates were unchanged after its provenance correction.

The model comparison is not hosted E2E acceptance, independent clinical validation,
an official leaderboard submission, a release gate, or a deployment. Chinese
records, long longitudinal records, source-to-fact semantic verification, live
registry recall, and a genuinely new clinical validation set remain separate work.

References: [TrialGPT paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC11574183/),
[public criterion data](https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations),
[TREC 2022 data](https://trec.nist.gov/data/trials2022.html),
[TypeSafe models](https://docs.typesafe.ai/models),
[TypeSafe confidence](https://docs.typesafe.ai/confidence),
[qwen3-rerank price and limits](https://help.aliyun.com/zh/model-studio/qwen3-rerank).
