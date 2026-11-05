# Patient-matching boards

Public benchmark boards for the patient-to-trial matching feature. The feature is
what is measured: scores are computed by the unchanged official evaluators from
what the feature saved. Nothing here calls a model, and no downloaded data or
patient text is committed.

| Board | Data | Official evaluator | Score |
|---|---|---|---|
| A | SIGIR, TREC 2021, TREC 2022: every judged candidate of each patient, no retrieval | `eval_trialgpt_rankings_qrels.py` | nDCG@10, P@10, MRR, MAP |
| B | NIH-TrialBench: 126 vignettes, one target trial each | `eval_nih_trialbench_target_recall_at10.py` | target recall@10 |
| C | 1,015 annotated criterion rows, 53 patients, 105 pairs | none (public labels) | six-label agreement against the experts, paired with GPT-4 |

## Pins

Fetch both clones at the full commit, check out the detached head, and keep them outside the repository.

| Input | Pin |
|---|---|
| TrialGPT 2.0 (public domain) | `https://github.com/TrialGPT2/TrialGPT2.0` at `1c5f9ebc3b98d1f780ceea68043efdaa2daba880` |
| TrialGPT 1.0 | `https://github.com/ncbi-nlp/TrialGPT` at `1b3242cd50c153a9c324661d4a0bd94fc68a4226` |
| Criterion annotations | `https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations`, `train.parquet`, sha256 `14c547184fac9b013cd17441fd028845b40150c76b022e58334f5494077e5234` |

```sh
git init T && cd T && git remote add origin <repo> && git fetch --depth 1 origin <full sha> && git checkout --detach FETCH_HEAD
```

`prepare.py` reads each clone's `.git/HEAD`, checks the two evaluators against reviewed digests
(`common.EVALUATORS`) and writes `inputs.sha256`, a digest of every input file used (about 58,000 trial files included).
Downloaded code is never run except those two short evaluators, which were read first. Run Python with `-I`;
the scripts add their own directory to the path. The interpreter needs `tqdm` (the evaluators) and `pyarrow`
(only `prepare.py`, for the parquet), installed in a private virtual environment, not the user site, which `-I` excludes.

## Prepare

```sh
python -I -B prepare.py --tg2 <clone> --tg1 <clone> --annotations train.parquet --out <inputs dir> --labels-out <labels dir>
```

Both output directories must be outside the repository and apart from each other. The run is idempotent and
byte-deterministic: a second run verifies and reports `already prepared`; it never overwrites.

`<inputs dir>` (what a runtime may be given)

- `A-sigir`, `A-trec2021`, `A-trec2022`, `B-nih`: `cases.jsonl`, one case per patient:
  `{ caseId, patientId, cohort, collection, split, note, candidateIds, candidateCount }`. Candidates are ordered by
  `sha256(seed|patient|trial)`, a function of ids only, so input order cannot leak a label. Board B cases carry no target.
- `C-criterion/cases.jsonl`, one case per patient: the sentence-numbered note and, per trial, the exact annotated clause list
  `{ annotationId, kind, number, text }` with `number` counted from 0 within `kind` (the TrialGPT 1.0 convention).
  `rows.json` is the flat seven-field form (`annotation_id, patient_id, note, trial_id, trial_title, criterion_type, criterion_text`).
- `collections/<id>/collection.json` and `<id>.sqlite`: one sealed index per cohort in the format
  `apps/server/src/vcrTrialCorpus.mjs` reads (`trialgpt-json`, documents plus a contentless FTS5 `terms` table, the layout
  `evals/vcr-platform-comparison/prepare.py` writes). Trial JSON maps `title`, `brief_summary` and `raw_criteria` unchanged to
  title, summary and eligibility; `condition` and `phases` are joined; `sex`, ages and `overall_status` are kept; interventions and
  detailed description are empty because the source has none. `node check-collection.mjs <collection.json> <NCT id> "<condition>"`
  opens one with the platform's own reader.
- `split.json` (frozen, also committed beside the code), `manifest.json`, `inputs.sha256`.

`<labels dir>`: `C-criterion/labels.jsonl` (expert and GPT-4 columns) and `B-nih/targets.jsonl`. Board A labels stay in the
pinned qrels, which only the scorer reads. A patient's note and candidates are the only things the feature receives.

Pair counts (checked, candidate lists equal the qrels pools): SIGIR 3,835 (59 cases, 58 with candidates;
`sigir-201428` has none and is not a case), TREC 2021 35,832 (75), TREC 2022 35,394 (50), NIH-TrialBench 101,682 (126).

Split: dev is every SIGIR topic, the first ten TREC 2021 and ten TREC 2022 topics in `queries.jsonl` order (not the
lexicographic order of the case files) and the criterion board, which is drawn from SIGIR patients. Test is the rest, the 40 TREC 2023
topics (reserved; not in the pinned data, ids follow the earlier campaign's `trec-2023-N` naming and must be mapped when that
data is pinned) and NIH-TrialBench. Changing it means deleting `split.json` and re-freezing with `--freeze-split`, a reviewed act.

## Judgments and scoring

The feature's saved judgments, one JSON record per patient (extra keys are ignored):

```
{ patientId, status, ranking: [ { registryId, fit, confidence, verdict, rank, criteria?: [ { number, kind, label, sentenceIds, basis, text } ] } ],
  failed: [ { registryId, code } ], usage?: { inputTokens, outputTokens, costCny } }
```

`to_official.py` writes `full_email_<patient_id>.json` with a `cover_page_list` in saved `rank` order. Candidates with no saved
judgment follow every judged one in input order and are counted by failure code; ids outside the case and repeated ids are dropped
and counted. A patient with no record at all is written as all-unjudged by default (`--absent skip` writes no file). Labels are
never an input, so nothing can be reordered by them.

```sh
python -I -B score.py a --boards <inputs> --tg2 <clone> --tg1 <clone> --work <private dir> --out <results dir> \
    --python <interpreter with tqdm> --judgments sigir=<file> trec_2021=<file> trec_2022=<file>
python -I -B score.py b --boards <inputs> --tg2 <clone> --work <private dir> --out <results dir> --python <...> --judgments <file>
python -I -B score.py c --boards <inputs> --labels <labels> --work <private dir> --out <results dir> --judgments <file>
```

`--out` receives `board-<x>.json` and `.md` with aggregates only. Converted official inputs, per-patient values and per-row
answers stay under `--work`. Resamples default to 10,000 with a fixed seed; intervals are 95% percentile, by patient.

- A: the official script runs as a subprocess on all patients, on the dev and test topics, on finished patients, and on the
  TrialGPT 1.0 paper subset (qrels restricted to the pairs in that repository's `retrieved_trials.json`: 3,141, 15,437 and 12,682).
  Per-patient values for the intervals come from the same evaluator's functions and must reproduce its printed means, else the run fails.
  The three-cohort figure is the mean of the cohort means.
- B: the official script as a subprocess; missing output and an unranked target count as misses.
- C: agreement over all 1,015 rows with a missing or unrecognised answer counted wrong; paired patient bootstrap against
  `gpt4_eligibility` on the same rows; per-label precision and recall; the decisive labels (`included`, `not included`, `excluded`);
  confusion matrices; false favourable (expert `not enough information` or disqualifying, answered `included` or `not excluded`;
  a wider count also takes `not applicable`) beside GPT-4's; rows whose expert cites no sentence, split by the answer's `basis`.
  GPT-4 must reproduce at 886/1015 or the scorer stops.
- Completion: patients with a record and finished, pairs judged and unjudged, failures by code, tokens and cost when reported.

## What the numbers can and cannot be compared with

- TrialGPT 2.0 scored every judged pair of the qrels pools. TrialGPT 1.0's reported 0.7275 and 0.6688 are on the judged pairs
  among its own top-500 retrieval; use the `tg1_subset` variant of the same run for that comparison. Unjudged pairs are not in the
  qrels pools and drop out of these metrics, so the figures are not retrieval results.
- Unjudged candidates are placed after judged ones in shuffled input order. A patient with fewer than ten judged pairs gets chance
  placement for the rest; the completion table counts them. Board B scored on a reranked top-100 only is not the full-list protocol.
- The criterion experts annotated while looking at GPT-4's output, which favours GPT-4. SIGIR and TREC patients are synthetic
  vignettes and every compared figure is the authors' own evaluation. Nothing here is clinical validation.

## Behaviours of the official scripts worth knowing

- The ranking script averages over patients present in the queries, the qrels and the results. A patient with no `full_email` file
  (or an empty list) is dropped from the means, not scored zero. The converter writes every case so nobody drops silently.
- MRR counts only label-2 trials, so even a perfect ranking scores below 1.0 when some patient has none (SIGIR perfect: 0.9138).
- `--pad-to-pool` appends missing pool trials in id order. The NIH script does not restrict to the case's candidates; a foreign id
  could displace the target, which is why the converter drops foreign ids.
- Patient ids come from the file's `patient_id` (or `_id`/`id`), else the file name; the official matcher writes `patient_ID`, which
  the evaluators do not read. Both are written.

## Tests

```sh
python -I -B -m unittest discover -s . -p 'test_*.py'     # stdlib only; the official-path tests skip without the next line
VCR_BOARDS_TG2=<clone> VCR_BOARDS_PYTHON=<interpreter with tqdm> python -I -B -m unittest test_official_path
python -I -B selfcheck.py --boards <inputs> --labels <labels> --tg2 <clone> --tg1 <clone> --python <interpreter with tqdm>
```

The self-check pushes a perfect and a reversed ranking (SIGIR), target-first and target-last (NIH), and expert, GPT-4 and empty
answers (criterion) through the real converter and evaluators.

## Budget guard

`budget.py --key-file <path> [--floor 200] [--require-off-peak]` reads the DeepSeek balance endpoint with the key from the file,
prints only `balance CNY <n>` and exits 2 under the floor, 3 when the balance cannot be read, 4 when `--require-off-peak` and it is
peak. Peak is weekdays 01:00-04:00 and 06:00-10:00 UTC. `is_off_peak()` is importable for runners. The key is never printed or put on
a command line.

## Boards F, G and D (added 2026-11-04)

These live apart from A to C: their prepared inputs are in their own private directories and `prepare.py`'s digests do not cover them.

### F: n2c2 2018 Track 1, real notes

`prepare_f.mjs --n2c2-root <dir> --out <inputs> --labels-out <labels>` writes `F-n2c2/cases.jsonl` (one case per training patient: the file's
own `Record date:` blocks as dated records) and, apart, `F-n2c2/labels.jsonl`. The split is the n2c2 README's: 40 development patients by the
fixed salted hash of `evals/vcr-matching/n2c2/data.mjs`, the other 162 held out (ids digests `abf3d521...` and `966c56cf...`, checked by a test).
`dev_job.mjs --board n2c2 --split train-dev|train-heldout --n2c2-boards <inputs> --n2c2-labels <labels> --n2c2-root <dir>` uploads each record as
a document dated by its record date and judges one protocol, the thirteen criteria in the annotation guide's wording (`n2c2/criteria.mjs`), against
the whole roster in one job, clause k being tag k. The **sealed test split is refused** by the loader and by the options unless `--unseal` is passed,
run once, after the prompts are frozen; `prepare_f.mjs` does not write the test notes without `--with-test`; only `unseal_f.mjs` opens the sealed gold, to write the labels `score.py f --split test --unseal` reads.

`score.py f` reads each label as met, not met or neither (`not enough information`, `not applicable`, no answer), keeps `included` and `not included`
as the model gave them, silent or stated, and reads the rest in four ways: (a) wrong, in the denominator (accuracy only); (b) not met, the unfavourable
reading and the annotators' convention; (c) as (b) except ENGLISH and MAKES-DECISIONS, met (guide section 4); (d) met, the favourable reading. **(c) is
the primary reading**, named on 2026-11-05 before the official test split was scored, because the plan's line of 0.8293 is that reading of the earlier
pipeline; (b) and the unknown share are printed beside it, since the reading alone can move a score across the majority baseline. The
unchanged `track1_eval.py` (digest pinned) scores (b), (c) and (d) and must equal the module's own micro and macro F1 or nothing is written. Reported:
accuracy and micro F1 with a patient bootstrap, macro F1, per criterion, the unknown share and its kinds, the model's yes and no by basis, a
majority baseline learnt from the patients outside the split, completion and cost. Aggregates only; no note is read by the scorer.

### G: Chinese robustness

Historical instrument only. On 2026-11-05 the owner retained English SIGIR and removed translated SIGIR from future evaluations. Keep the recorded scores for reproducibility; do not schedule new board-G translation or scoring. Real Chinese intake/search is evaluated separately through product workflows. See the [V3 plugin architecture](../../../docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3.md).

`prepare_zh.mjs` translates the SIGIR notes and the TREC 2021 and 2022 development-topic notes once, on `deepseek-flash` with thinking off, through the
control plane's gateway call (so the usage ledger books it), under the same guards and a stage budget (default CNY 2). The instruction forbids adding,
omitting, explaining and inferring, and leaves numbers, units and dates as written; code checks the numbers (a multiset, asked again once, counted when
it still differs) and that the result is Chinese. Each board is written once with its hashes (`A-sigir-zh`, `A-trec2021-zh-dev`, `A-trec2022-zh-dev`);
the trials, candidate lists, collections and qrels are A's, so `dev_job.mjs --board sigir-zh --zh-boards <dir> --boards <A's inputs>` changes only the
language of the note. Score with `score.py a` as for A; the dev-topic and finished variants are the ones that apply.

### D: patient-level eligibility (VERDICT's form)

Read at stanford-oval/clinical-trial-matching, commit `a56e3ed09f10928dd033baefb1b78856943aa99f` (Apache-2.0), with `gh api`, no clone. Their F1
(`scripts/tables/table2_trec2021_f1.py`): a pair is `<patient>__<NCT>`, the frozen file holds `{pair, gold}` with gold `eligible` or `ineligible`, a
system's answer is `eligible` or not, eligible is the positive class, P = tp/(tp+fp), R = tp/(tp+fn), F1 = 2PR/(P+R), accuracy = (tp+tn)/n. **The
pair files are not obtainable:** at that commit the repository holds only a demo pair; `data/headline/`, `data/gold/`, `dataset/clinical_trial/sigir/`
and every `verdicts.jsonl` the documents mention are not in it (no commit in its history touches `dataset/`), the SIGIR gold is the majority of five LM judges (3 of 5),
not a human label, and the 363 TREC 2021 pairs (`test_clean_tagged.jsonl`, built from an unreleased compiled pair set by taking every fifth NCT and dropping
73 pairs their parser could not use) are in `svpo-rl`, a private repository. So there is no board data; `score.py d --pairs <their-shaped file> --judgments <file>`
is ready for files the owner obtains. The mapping from our verdict: eligible to eligible; ineligible and insufficient to ineligible; `possible` reported both
ways (`possible_is_eligible`, `possible_is_ineligible`); a pair without a verdict is reported both left out and as ineligible. Their reported numbers
(VERDICT F1 0.863 on 539 SIGIR pairs by their own judges' gold; 0.828 on TREC 2021 with GPT-5-mini) are their authors' own and not paired with ours.
