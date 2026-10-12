# Knowledge pages: should they be on by default?

This harness answers one question for the owner of 「知识页」 (knowledge pages, `capabilities/knowledge-compile`): does compiling a project's documents into linked, quote-bound pages make the research assistant answer cross-document questions better than the status quo plus one sentence of guidance? Single-fact questions must not get worse.

It compares three arms on the same corpus, the same questions and the same answering prompt.

| Arm | What the assistant has |
|---|---|
| **A** | `kb_search` over the project's documents. The status quo. |
| **A′** | A, plus one sentence: *when a question spans several documents, first split it into sub-questions, search for each one separately, and then combine what you found.* Zero code. |
| **B** | The documents compiled into knowledge pages first (the page files are searchable documents beside the originals, as in the product), then `kb_search`. **No** decomposition sentence. |

The owner's rule: B must be **significantly** better than A′ on cross-document questions, or pages are not opened by default. A′ is the bar because it is the cheapest alternative that targets the same weakness.

The three arms use one answering system prompt (`lib/prompts.mjs`). Only A′ appends the decomposition sentence. The prompt that tells the model to cite documents and never a page is in all three arms (in A and A′ there are no pages, so it is inert). It follows the wording of `apps/server/src/sourceConversationContext.mjs`.

## Design

**Corpus.** Three real topics, eight PubMed abstracts each, fetched once by `fetch_corpus.mjs` from NCBI E-utilities and committed under `corpus/<topic>/docs/`. Each topic has trials that can be compared and that disagree in places (design, population, dose, outcome). The manifest of each topic records PMID, DOI, title, journal, year, URL, publication types and the copyright line PubMed returns.

| Topic | Documents |
|---|---|
| `af-doac-warfarin` | RE-LY, ROCKET AF, ARISTOTLE, ENGAGE AF-TIMI 48, AVERROES, J-ROCKET AF, ELDERCARE-AF, and the 2014 Lancet meta-analysis of the four pivotal trials |
| `sglt2-hf-ckd` | DAPA-HF, EMPEROR-Reduced, EMPEROR-Preserved, DELIVER, DAPA-CKD, EMPA-KIDNEY, CREDENCE, and the 2022 Lancet heart failure meta-analysis |
| `aspirin-primary-prevention` | ARRIVE, ASCEND, ASPREE (cardiovascular events; all-cause mortality), JPPP, the 2009 collaborative meta-analysis, the 2019 JAMA meta-analysis, and the 2022 USPSTF statement |

Document ids are `src_` plus the first 32 hex characters of `sha256('<topic>/<pmid>')`, because the domain's quote check requires that shape. Each text is the title, one citation line and the labelled abstract, cut at a sentence end if over 2800 characters (`truncatedFrom` in the manifest says which were).

**Questions.** Per topic, 5 cross-document synthesis questions and 4 single-fact questions; 27 in all. Each carries `reference.keyPoints`, and each key point carries `support: [{doc, quote}]`. `doc` is a document key from the manifest (`pmid-…`). `check_corpus.mjs` verifies, in code, that every quote is a verbatim substring of its document (whitespace collapsed) and that the platform's own `checkKnowledgeEvidence` accepts it; that a synthesis question draws on at least two documents and a single-fact question on exactly one; and that the manifest hashes and ids are the derived ones. The questions and key points were written by hand from the abstracts, before any model output existed.

**Retrieval.** `lib/retrieval.mjs`: an in-process BM25 (k1 1.2, b 0.75) over passages of about 700 characters cut at sentence ends, with offsets. Tokenizer: lower-case, light stemming, numbers keep their decimals, CJK as unigrams plus bigrams, so Chinese and English both work. The document title is searchable with every passage. `kb_search(query)` returns the top 5 passages with the id and title of their document. Pages are indexed as documents with the id `page:<slug>`; their passages carry the `<!-- evimed-source:… -->` markers exactly as written, which is what a search hit shows the model. At most 6 tool calls per question.

**Answering protocol.** The reply is prose plus, after each fact taken from a document, `<!-- evimed-source:{"sourceId":…,"quote":"…verbatim…"} -->`. A page is never to be cited: the model is told to follow the marker to the document.

**Arm B compile.** For each topic and each repetition a fresh compile is run on `deepseek-v4-flash`: the system prompt is `capabilities/knowledge-compile/SKILL.md` verbatim; the user message carries the complete `knowledge-compile-input.json` (`schemaVersion`, `sources` with `generation`/`textSha256`/`text`, empty `pages`, `changed`, `held`, and the domain's `limits`); the model returns `wiki-patch.json` in JSON mode. Then up to two in-place repair rounds: the specific messages of `knowledgePatchIssues` (required and advisory) are sent back with the instruction to change only those places and return the complete patch. Then `settleKnowledgePage` checks every claim against the whole documents; claims that do not stand are held (recorded, counted, never written into a page), the surviving claims are rendered with `renderKnowledgePage`, and `renderKnowledgeIndex` writes the index page. The result lands in `results/<run-id>/compiled/<topic>-rep<N>/` (`wiki-patch.json`, `pages/`, `index.md`, `held.json`, `compile.json`).

**Metrics**, per question, per arm, per repetition:

1. *Correctness.* An LLM judge (`deepseek-v4-pro`, temperature 0, thinking off) sees the question, the key points and the answer **without** its citation comments and without knowing the arm. For each key point it returns `covered`, `partial` or `missing` and a `contradicted` boolean; it rewrites and advises nothing. The score is computed in code: `(covered + 0.5·partial) / points`, a contradicted point counting 0.
2. *Citation support.* Code only. Every `evimed-source` marker in the answer is checked against the document it names with the domain's `checkKnowledgeEvidence`. `verifiedRate` = verified markers / all markers, pooled over answers; a marker that names a page, an unknown id, or a quote shorter than 10 characters does not verify. An answer with no marker adds no marker (it is not a 0 in the rate), so the share of answers that carry markers is reported beside it.
3. *Cost.* Prompt + completion tokens of all the answering calls of the question, and the number of `kb_search` calls. For B, the compile tokens and CNY per topic per repetition, the pages, the claims kept and the claims held (with the reasons).

**Repetitions.** Every (question, arm) cell is answered at least **3** times at temperature 0.7 (a per-run `seed` is also sent; the provider may ignore it). Arm B recompiles its pages for every repetition. Thinking is disabled for answering, judging and compiling (see limits).

**Statistics.** Scores are first averaged over the repetitions of a question, so the question is the unit. The differences B−A′, B−A and A′−A are then taken per question and bootstrapped (paired, questions resampled with replacement, 10,000 draws, seed 20261012, percentile 95% interval), separately for the 15 synthesis and the 12 single-fact questions. The citation `verifiedRate` difference is bootstrapped the same way over questions.

**Spend.** Prices are the platform's reference list (`packages/domain/src/metering.mjs`) at the daytime rate: flash 0.04 / 2 / 8 CNY per million tokens (cache hit / miss / output), pro 0.3 / 9 / 27. The client refuses to start a call the remaining budget cannot cover (default CNY 15; the run stops and keeps what it finished) and writes every call's tokens and the cumulative spend to `results/<run-id>/calls.jsonl`.

## Decision thresholds (fixed before any result existed)

`decide(summary)` in `lib/decide.mjs` applies exactly these constants (`THRESHOLDS`); the tests pin them. Pages are opened by default only if **all** hold:

| # | Check | Threshold |
|---|---|---|
| 0 | Data | every one of the 27×3 (question, arm) cells has ≥ 3 judged repetitions. Otherwise `open: false, inconclusive: true` |
| 0 | Judge | the judge scores a reference answer made of the key points ≥ 0.90 on average and an empty answer ≤ 0.10 (`--stage sanity`, 27 + 27 calls) |
| 1 | Synthesis, B−A′ | the 95% CI lower bound is **> 0** |
| 2 | Synthesis, B−A′ | the mean is **≥ 0.05** (so a significant but trivial gain does not open the feature) |
| 3 | Synthesis, B−A | the mean is **> 0** (B must also beat the status quo; if A′ were worse than A, beating A′ would mean nothing) |
| 4 | Single-fact, B−A′ and B−A | mean **≥ −0.05** and CI lower bound **≥ −0.10**, for each of the two |
| 5 | Citations | pooled `verifiedRate` of B ≥ that of A′ − 0.03, and ≥ that of A − 0.03 |

Not gating, reported only: tokens and searches per question, answers carrying markers, A′−A, per-topic means, compile cost. Cost is not a gate because the owner's rule is about quality; it is printed so the owner can weigh it. A result that fails any row means: do not open by default.

## How to run

Everything runs from this directory; Node ≥ 22, no dependencies (`@evimed/domain` resolves through the workspace).

```bash
cd OpenScience/evals/knowledge-pages
node check_corpus.mjs                       # the corpus and every reference quote (no network)
node --test test/harness.test.mjs           # pure logic (no network)

export OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/deepseek.api-key   # the file is read into memory only
node run_eval.mjs --dry-run                                           # the plan and an upper-bound cost
node run_eval.mjs --run-id <id> --stage sanity                        # judge sanity check
node run_eval.mjs --run-id <id> --reps 3 --budget 15                  # compile, answer, judge, summarize
node run_eval.mjs --run-id <id> --stage summarize                     # recompute summary.json from the records, no calls
```

Useful flags: `--questions-per-topic 3` (a small trial: two synthesis and one single-fact question per topic), `--reps N`, `--arms A,Aprime,B`, `--topics a,b`, `--concurrency 4`, `--answer-model`, `--judge-model`, `--compile-model`, `--thinking enabled`. A run is **resumable and idempotent**: results are appended to `runs.jsonl`; a (topic, question, arm, repetition) that is already judged is skipped, a finished compile (`compile.json` present) is read back from disk, and the spend already in `calls.jsonl` counts against the budget. After an interruption, run the same command again. `config.json` records the models, the prompt hashes and the settings; resuming with different ones is refused unless `--force-config`.

`fetch_corpus.mjs` rebuilds the corpus from PubMed; it is needed only to change topics. It overwrites the committed files with what PubMed serves today, so run `check_corpus.mjs` after it.

## Reading the results

`results/<run-id>/`:

- `config.json`: models, temperatures, prompt and method hashes, budget, repetitions.
- `runs.jsonl`: one line per (topic, question, arm, repetition): the answer, the searches (queries and what they returned), tokens, cost, the citation check, the judge's per-point verdicts and the score. The last line for a key wins.
- `calls.jsonl`: every API call with tokens, cost and cumulative spend. No request or key is stored.
- `compiled/<topic>-rep<N>/`: the pages arm B searched, the held claims with reasons, the patch.
- `judge-sanity.json`, `summary.json` (everything the table prints, plus `decision`).

In `summary.json`: `categories.<synthesis|single>.diffs["B-Aprime"]` is the number that decides (`mean`, `ciLow`, `ciHigh`, `n` questions). `citations.overall.<arm>.verifiedRate` is the code-checked citation rate; `compile.overall.heldShare` is the fraction of the compiler's sentences that the platform could not confirm and withheld from the pages. `decision.reasons` lists every check with `pass:` or `FAIL:`.

## Known limits

- **Only pages + `kb_search` against `kb_search` were compared.** The memory capsule's `sources` layer (document-summary facts) was **not** measured: no arm has summary facts. So the evidence bears on whether to open knowledge pages, and on whether a *summary layer* can be dropped only conditionally: if B passes, pages do the cross-document work that summaries might have done, which is a reason to stop writing document summaries but not a measurement of that; if B fails, nothing here says summaries help either. A capsule-layer arm (C: summaries + `kb_search`) is the missing control.
- **Small projects.** Eight documents per topic, about 40 passages: five hits are ~12% of the whole knowledge base. Real projects are larger, where retrieval alone should do worse and pages could matter more; the result is conservative for pages, and it says nothing about hundreds of documents, nor about the cost of keeping pages current.
- **Abstracts, not full texts**, English only (the questions are English because the retriever is lexical; the platform's semantic search would let a Chinese question meet English documents). The grading is about what a careful reader can pull from abstracts.
- **Lexical stand-in for `kb_search`.** The product's retriever is not BM25. All arms share the stand-in, but the size of the gain from pages depends on how good retrieval already is.
- **Thinking is off** for answering and compiling (cost and a meaningful temperature). With reasoning on, the model decomposes on its own, which could shrink the gap between A and A′ and make pages matter less (or more).
- **One compile, not the product job.** The platform job reads files and submits a contract inside a DSH run with repair turns; here the compile is a single JSON reply plus two repair rounds. The cost, and the held share, of the real job will differ.
- **LLM judge.** One model family judges answers produced by another size of the same family. The judge sees only the prose and the key points and is checked by the sanity run, but it is still a model; key points were written by hand to be decidable (numbers, directions, populations).
- **Question count.** Fifteen synthesis and twelve single-fact questions: the intervals are wide, and that is what the `ciLow > 0` threshold is for. Repetitions reduce answer noise, not question-sample noise.
- **Citation rule is the platform's.** Quotes shorter than 10 characters or longer than 600 do not verify even if they are present in the document; a marker that names a page does not verify. That is deliberate (the reader could not use them) and applies to all arms.
- **Prompt effects.** The A′ sentence is one wording; a better one could close more of the gap. The B pages carry long marker comments, which cost tokens in every hit.
