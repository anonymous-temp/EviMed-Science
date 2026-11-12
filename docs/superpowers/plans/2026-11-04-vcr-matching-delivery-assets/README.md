# Patient matching delivery: scores and analysis

Everything here supports section 16 of [the delivery plan](../2026-11-04-vcr-matching-delivery-plan.md). Aggregates only: no patient note, no per-patient value, and for the real records no text at all.

**2026-11-05 follow-up:** [Results diagnosis](../2026-11-05-vcr-matching-next-phase.md) reanalyzes the saved TREC topic scores, reports English SIGIR separately, distinguishes historical fixes from current gaps, and corrects comparison/acceptance limitations. [V3 plugin architecture](../2026-11-05-vcr-matching-plugin-v3.md) is the current proposal, following the [V2 integration plan](../2026-11-05-vcr-matching-next-phase-v2.md). Original scores below remain unchanged. Board G is historical only; the owner requested English SIGIR without further translated-SIGIR runs.

**Frozen revision of the scored runs:** `a2d109cf5`, prompts `fit-3` and `criteria-5`, model `deepseek-flash`, whole-trial reading without thinking, clause reading with thinking high. Later commits on the branch change no prompt. They do change the verdict and the reader's order, which no board scores.

## `scores/`

| File | What it is | How it ran |
|---|---|---|
| `board-a` | Ranking, SIGIR and TREC 2021 and 2022, all judged pairs, official TrialGPT 2.0 and 1.0 evaluators | `dev_job.mjs --split all --mode fit --thinking off` |
| `board-b` | NIH-TrialBench target recall, official evaluator | `narrow_board.mjs --top 100`, then as above: the first 100 after the product's rerank, not all pairs |
| `board-c` | Clause agreement with the TrialGPT annotations | `--mode criteria --thinking high`. Its prompt was tuned on these rows, so this is in-sample |
| `board-e-end2end` | Full-corpus TREC, 133 test topics, official qrels | `retrieve_e.mjs --set test`, `e2e_e.mjs --top-n 100` |
| `board-f` | n2c2 2018 Track 1 official test, official scorer | `--mode criteria --thinking high --unseal`. Reading (c) was named primary before scoring |
| `board-g-chinese-sigir` | Historical only: SIGIR notes translated into Chinese, the same qrels; retired from future evaluation on 2026-11-05 | as board A |
| `incidents-on-the-real-job.json` | 17 synthetic cases from customer feedback, red-team ideas and defects, three repeats each | `incidents.mjs`, on the frozen revision. Its verdict of 符合 at fit 0 is the defect fixed in `trialVerdict` afterwards |
| `zh-real-text-usability.json` | 115 real Chinese free-text requests, counts only, no gold, so no accuracy | `zh_usability.mjs` |

The runners and scorers are in `OpenScience/evals/vcr-matching-boards/`, and its README describes them.

## `analysis/`

| File | What it is |
|---|---|
| `final-review.md` | The independent read before release: what blocks delivery, gaps G1 to G29. Written against the branch before the fix round, which is what commits after it answer |
| `behaviour-review.md`, `security-review.md` | The two earlier independent reviews. Their blockers were fixed on this branch; `final-review.md` says which still hold |
| `gap-register.md` | The audit of the old path that set the plan's gap list, against commit `6e1841609` |
| `knowledge-gaps.md` | What public knowledge sources exist for matching, checked against their official pages on 2026-11-04 |

Kept out of the repository: real records, per-patient values, the local inventory of private assets and session notes, conversation transcripts and walk screenshots.
