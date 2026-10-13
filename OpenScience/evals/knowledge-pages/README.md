# Knowledge pages: do they make answers better?

An offline instrument for one question: do a project's documents compiled into linked knowledge pages (「知识页」) make the research assistant answer cross-document questions better than `kb_search` over the documents plus one sentence of guidance, without worse single-fact answers or worse citations? The product compiles its pages with OpenViking's official `llm-wiki` skill (the engine's Compile, scheduled by `apps/server/src/knowledgePageService.mjs`). This harness measures pages; it does not make them.

## The result on record

On 2026-10-12 the pages of the platform's self-built compiler (`capabilities/knowledge-compile`, removed on 2026-10-13 without ever having been switched on) were measured as arm B. **Pages did not raise cross-document answer quality over `kb_search` + one sentence**: synthesis B−A′ = +0.014 [−0.053, 0.085] with one project per topic (15 questions, 95% interval) and −0.065 [−0.175, 0.038] in one pooled 24-document project. Single-fact answers did not regress (B−A′ −0.014 [−0.042, 0.000]) and citations held (verified rate 0.997 against 0.991). The verdict, `open: false`, stands as recorded. The value of pages is browsing, accumulation and the graph; the product does not claim an answer-quality gain for them.

### Arm C: result

**Not run.** No directory under `results/` holds an arm C record yet. When one does, write here its run id and date, synthesis C−A′ and C−A with their intervals (per-topic and pooled), single-fact C−A′, the citation rates, and `decisions.C` from its `summary.json`.

## Arms

| Arm | Status | What `kb_search` searches |
|---|---|---|
| **A** | runnable | The project's documents. The status quo. |
| **A′** | runnable | The documents, and the prompt gains one sentence: *when a question spans several documents, first split it into sub-questions, search for each one separately, and then combine what you found into one answer.* |
| **C** | runnable, not yet run | The documents and the pages of one tree compiled by OpenViking's official `llm-wiki` skill and exported from the engine. No sentence. |
| **B** | on record only | The documents and the pages of the self-built compiler. No sentence. Its records stay under `results/2026-10-12-*` and `--stage summarize` recomputes them; a new run refuses `--arms B` and says why. |

The bar for a page arm is A′, the cheapest alternative aimed at the same weakness. Every arm answers with one system prompt (`lib/prompts.mjs`), unchanged since the recorded runs (a test pins its hash, and the judge's, against `results/2026-10-12-three-arm/config.json`); only A′ appends the sentence. Its paragraph telling the model to cite the document a page names, never the page, is inert in A and A′.

## Design

**Corpus.** Three topics of eight PubMed abstracts each, fetched once by `fetch_corpus.mjs` and committed under `corpus/<topic>/docs/`; each manifest records PMID, DOI, title, journal, year, URL, publication types and the copyright line PubMed returns. Document ids are `src_` plus the first 32 hex characters of `sha256('<topic>/<pmid>')`, the shape the platform's source ids have.

| Topic | Documents |
|---|---|
| `af-doac-warfarin` | RE-LY, ROCKET AF, ARISTOTLE, ENGAGE AF-TIMI 48, AVERROES, J-ROCKET AF, ELDERCARE-AF, and the 2014 Lancet meta-analysis of the four pivotal trials |
| `sglt2-hf-ckd` | DAPA-HF, EMPEROR-Reduced, EMPEROR-Preserved, DELIVER, DAPA-CKD, EMPA-KIDNEY, CREDENCE, and the 2022 Lancet heart failure meta-analysis |
| `aspirin-primary-prevention` | ARRIVE, ASCEND, ASPREE (cardiovascular events; all-cause mortality), JPPP, the 2009 collaborative meta-analysis, the 2019 JAMA meta-analysis, and the 2022 USPSTF statement |

**Questions.** Per topic, 5 cross-document synthesis questions and 4 single-fact questions, 27 in all, written by hand from the abstracts before any model output existed. Each carries key points, each key point verbatim supporting quotes. `check_corpus.mjs` verifies in code that every quote is in its document (as a plain substring, whitespace collapsed, and by the citation check below), that a synthesis question draws on at least two documents and a single-fact question on exactly one, and that the manifest's hashes and ids are the derived ones.

**Retrieval.** `lib/retrieval.mjs`: an in-process BM25 (k1 1.2, b 0.75) over passages of about 700 characters, the title searchable with every passage; lower-case, light stemming, decimals kept, CJK as unigrams and bigrams. `kb_search(query)` returns the top 5 passages with the id and title they come from; at most 6 searches per question. A page is a document of the index with the id `page:<its path in the tree>`. Its passages are its blocks (a paragraph with the source link under it, a table, a list), packed up to about 1,100 characters and never cut, because upstream writes a sentence over several lines and its source link on the next.

**Arm C's pages** are read, not compiled: `upstream/<topic>/rep<N>/` by default (`--upstream-pages <dir>`), one tree per topic per repetition, every `.md` file in it (hidden files skipped; the engine's `_listing.json` is not a page). The model sees a page with each source link `[title](viking://…/sources/<srcId>.md "verbatim sentence")` rewritten as `title <!-- evimed-source:{"sourceId":"<srcId>","quote":"<sentence>"} -->`, the citation marker of every arm, so a page shows which document to cite and with which words, as B's pages did. A source link without a quotation becomes `title (document id: <srcId>)`; a `viking://` link that names no document of the topic keeps its words only; relative links between pages stay. When a topic has fewer trees than repetitions they are reused in order, and each record names the tree it searched (`pages`). A topic with no tree: its C cells are skipped and reported, and the verdict on C is inconclusive. A run copies the trees it searches into `results/<run-id>/upstream/` and from then on reads only that copy.

**Producing the trees.** Compile each topic's eight documents in OpenViking with the official skill and export the wiki target, once per repetition. The documents must be pushed under the ids in `corpus/<topic>/manifest.json` (`…/resources/p/<project>/sources/<sourceId>.md`): a project of the product names its documents by ids of its own (`sourceIdFor` in `apps/server/src/sourceService.mjs`), its trees would cite none of these documents, and the run refuses a tree whose source links name none of its topic's documents. The course-correction lab of 2026-10-12 pushed `af-doac-warfarin` that way (`.evimed-local/acceptance/course-correction-20261012/lab/knowledge/pages/med-wiki-quote/wiki-q1`…`q3`, local to the maintainer's checkout): three trees of 17 to 19 pages, and all 280 of their quotations beside claims are in the documents they name.

**Answering protocol.** The reply is prose plus, after each fact taken from a document, `<!-- evimed-source:{"sourceId":…,"quote":"…verbatim…"} -->`. A page is never cited.

**Metrics**, per question, arm and repetition:

1. *Correctness.* An LLM judge (`deepseek-v4-pro`, temperature 0, thinking off) sees the question, the key points and the answer without its citation comments, and not the arm. For each key point it returns `covered`, `partial` or `missing` and a `contradicted` flag; code scores `(covered + 0.5·partial) / points`, a contradicted point counting 0.
2. *Citations.* Code only (`lib/citations.mjs`): each marker against the document it names by the platform's comparison (`quoteIsPresent`, `@evimed/domain/clinical-evidence`). A marker naming a page or an unknown id, or a quotation under 10 or over 600 characters, does not verify; those limits are the ones the recorded runs were checked with, and re-checking all their 513 answers gives the recorded result for each. `verifiedRate` is pooled over markers; the share of answers that carry markers is reported beside it.
3. *Cost.* Tokens and searches per answer.
4. *The pages themselves*, counted after the fact without a model. For C, per tree (`summary.json` → `upstreamPages`): pages, typed pages, source links beside claims, how many carry a quotation, how many of those are in the document named (`checkPageQuotations`), and links that name no document of the topic. For B, the compile statistics the recorded runs kept (`compile`).

**Repetitions and statistics.** Every (question, arm) cell is answered at least **3** times at temperature 0.7 (a per-run `seed` is sent; the provider may ignore it); thinking is off throughout. Scores are averaged over a question's repetitions, so the question is the unit; each paired difference (page arm − A′, page arm − A, A′ − A) is bootstrapped over questions (10,000 draws, seed 20261012, percentile 95% interval), separately for the 15 synthesis and the 12 single-fact questions, and so is the citation-rate difference.

**Two scopes.** `--kb-scope topic` (the default, the formal verdict) asks each question of its topic's eight documents and, in C, that topic's tree. `--kb-scope pooled` asks it of one project holding all three topics, a sensitivity analysis of harder retrieval; a disagreement between the two is reported, not resolved.

**Spend.** Prices are the platform's reference list at the daytime rate: flash 0.04 / 2 / 8 CNY per million tokens (cache hit / miss / output), pro 0.3 / 9 / 27. `--budget` (default CNY 15) caps a run and `--total-cap` (default CNY 20) caps every run under `results/` together; the client refuses a call the remaining budget cannot cover, stops, keeps what it finished, and writes each call's tokens and cost to `calls.jsonl`.

## Decision thresholds (fixed before any result existed)

`decide(summary, arm)` in `lib/decide.mjs` applies exactly these constants (`THRESHOLDS`, pinned by the tests) to a page arm: B in the recorded runs, C when it runs. Its verdict is `summary.json` → `decisions.<arm>`; `decision` is B's, the field the recorded summaries have. A page arm passes only if **all** hold:

| # | Check | Threshold |
|---|---|---|
| 0 | Data | every one of the 27×3 (question, arm) cells of the page arm, A′ and A has ≥ 3 judged repetitions. Otherwise `open: false, inconclusive: true` |
| 0 | Judge | the judge scores a reference answer made of the key points ≥ 0.90 on average and an empty answer ≤ 0.10 (`--stage sanity`, 27 + 27 calls) |
| 1 | Synthesis, page arm − A′ | the 95% CI lower bound is **> 0** |
| 2 | Synthesis, page arm − A′ | the mean is **≥ 0.05**, so a significant but trivial gain does not count |
| 3 | Synthesis, page arm − A | the mean is **> 0** (if A′ were worse than A, beating A′ would mean nothing) |
| 4 | Single-fact, page arm − A′ and page arm − A | mean **≥ −0.05** and CI lower bound **≥ −0.10**, for each |
| 5 | Citations | pooled `verifiedRate` of the page arm ≥ that of A′ − 0.03, and ≥ that of A − 0.03 |

Reported, not gating: tokens and searches, answers carrying markers, A′−A, per-topic means, the numbers of the pages. A page arm that fails any row has shown no answer-quality gain, and none is claimed for its pages.

## How to run

From this directory; Node ≥ 22, no dependencies (`@evimed/domain` resolves through the workspace).

```bash
node check_corpus.mjs                        # the corpus and every reference quote (no network)
node --test test/harness.test.mjs            # pure logic, and the recorded summaries recomputed (no network)

# arm C, once the trees are exported (see "Producing the trees")
node run_eval.mjs --dry-run --upstream-pages <dir>                                  # the plan, each tree's numbers, an upper bound
export OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/deepseek.api-key                 # read into memory only
node run_eval.mjs --run-id <id> --upstream-pages <dir> --total-cap 25               # sanity check, answers, judgements, summary

node run_eval.mjs --run-id <id> --stage summarize                                   # recompute a run's summary.json, no call
```

The default arms are A, A′ and C. With a tree for every topic, `--dry-run` plans 243 answers, 243 judgements and 54 judge sanity calls, an upper bound of CNY 8.64 (8.10 with `--reuse-from 2026-10-12-three-arm`, which takes that run's judge check: same judge, same instructions); the formal run of the same size spent CNY 5.16 on answers and judgements. The recorded runs spent CNY 13.63, so the default `--total-cap 20` leaves 6.37 and the run would stop there; raising it is a decision, not a default.

Other flags: `--kb-scope pooled`, `--questions-per-topic 3` (a trial), `--reps N`, `--arms A,Aprime,C`, `--topics a,b`, `--stage sanity|run|summarize`, `--concurrency 4`, `--answer-model`, `--judge-model`, `--thinking enabled`, `--results-dir`. A run is resumable and idempotent: records are appended to `runs.jsonl`, a judged (topic, question, arm, repetition) is skipped, and the spend already in `calls.jsonl` counts against the budget, so after an interruption run the same command again. `config.json` records the models, the prompt hashes, the settings and the trees; a run under the same id with different ones is refused unless `--force-config`. `--stage summarize` writes only `summary.json`, from the plan the run recorded.

`fetch_corpus.mjs` rebuilds the corpus from PubMed, which is needed only to change topics; run `check_corpus.mjs` after it.

## Reading the results

`results/<run-id>/` holds `config.json`, `runs.jsonl` (per (topic, question, arm, repetition): the answer, the searches, tokens, cost, the citation check, the judge's verdicts, the score and, in C, the tree searched; the last line for a key wins), `calls.jsonl` (every API call's tokens and cost; no request or key), `judge-sanity.json` and `summary.json`; a C run also `upstream/<topic>/rep<N>/` (the trees as searched), the recorded runs `compiled/<topic>-rep<N>/` (B's pages, held claims and patches). In `summary.json`, `categories.<synthesis|single>.diffs["C-Aprime"]` (`"B-Aprime"` in the recorded runs) is the number that decides, `citations.overall.<arm>.verifiedRate` the code-checked citation rate, `coverageByArm` the complete cells, and `decisions.<arm>.reasons` every check with `pass:` or `FAIL:`.

## Runs on record (`results/`)

| Run | What it is |
|---|---|
| `2026-10-12-three-arm` | **The formal run of B**: per-topic projects, 27 questions × A, A′, B × 3 repetitions, a fresh compile per topic per repetition, the judge sanity check. CNY 6.99. |
| `2026-10-12-three-arm-pooled` | Its sensitivity run (`--kb-scope pooled --reuse-from 2026-10-12-three-arm`): one 24-document project, the same compiles. CNY 5.06. |
| `2026-10-12-pilot` | The dress rehearsal: 9 questions, 1 repetition, to measure cost and find three defects before the formal run. In no verdict. CNY 1.58. |
| — | Arm C: no run yet. |

## Known limits

- **Small projects.** Eight documents per topic, about 40 passages: five hits are a tenth of a project, every arm scores high, and the formal result is conservative for pages. The pooled run (24 documents) probes harder retrieval a little; nothing here measures hundreds of documents or the cost of keeping pages current.
- **Abstracts, English, a lexical stand-in for `kb_search`.** The product's retriever is not BM25, and the size of any gain from pages depends on how good retrieval already is.
- **Thinking is off** (cost, and a meaningful temperature). With reasoning on the model decomposes on its own, which could change what both the sentence and the pages add.
- **Trees vary.** The lab's three trees of one topic held 17 to 19 pages and 50 to 159 quoted links beside claims; B's compiles held 5 to 13 pages. A verdict rests on the trees it searched. C's passages are longer than B's, which costs tokens in every hit.
- **Only pages + `kb_search` against `kb_search`.** The memory capsule's document-summary layer was never an arm.
- **An LLM judge** of the family that answers, which sees only prose and key points and is checked by the sanity run; the key points were written to be decidable (numbers, directions, populations).
- **Fifteen synthesis and twelve single-fact questions**: wide intervals, which is what the `ciLow > 0` threshold is for. Repetitions reduce answer noise, not question-sample noise. A′ is one wording; a better one could close more of the gap.
- **B cannot be reproduced.** Its pages came from one JSON compile and up to two repair rounds whose system prompt was the then `capabilities/knowledge-compile/SKILL.md`, settled by the page contract of `@evimed/domain` at the time; both were removed on 2026-10-13. Its records, pages and held claims stay readable.
