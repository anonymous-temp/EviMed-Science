# Memory recall

Which ranker puts the right memory in front of the model.

This is the cheap gate for adopting a recall index behind `memorySubstrate`. It
is not the end-to-end question — `evals/method-quality/configs/memory-ablation-v1.json`
asks whether memory changes a delivered package — but a provider that cannot win
here cannot win there either.

Both arms answer the same 12 queries over the same 300 records. Every query is
worded the way a researcher would ask rather than the way the record is written,
because a query that shares the record's words measures nothing an index could
improve. The distractors share the gold records' vocabulary for the same reason:
a corpus of unrelated noise flatters every ranker equally.

```bash
node evals/memory-recall/run_recall_eval.mjs --arm builtin --label builtin \
  --out evals/memory-recall/results/$(date +%F)-builtin.json

OPEN_SCIENCE_OPENVIKING_API_KEY_FILE=/path/to/key \
node evals/memory-recall/run_recall_eval.mjs --arm openviking --label qwen \
  --url http://127.0.0.1:1933 --seed-index \
  --out evals/memory-recall/results/$(date +%F)-qwen.json
```

`--label` is free-form and defaults to the arm. It exists because the arm no
longer says what was measured: two `openviking` runs against servers configured
with different embedders are two different arms, and a comparison whose rows are
both called `openviking` is one nobody can read a month later.

## 2026-09-09, 300 records, top 5 — history

Measured against a live OpenViking v0.4.19 with `bge-m3` on Ollama, the embedder
that deployment ran at the time. Production no longer runs it; the numbers stay
because they are what the adoption decision was made on.

| | term matcher | OpenViking v0.4.19 + bge-m3 |
|---|---|---|
| recall@5 | 0.667 | 0.800 |
| mean reciprocal rank | 0.736 | 0.917 |
| queries returning nothing relevant | 2 | 0 |
| median added latency | none | 650 ms |

The number that decided it is the third row. Two of twelve questions got no
relevant memory at all from the term matcher, and a run cannot repair what it
never saw. Latency is the cost: 650 ms on a run measured in minutes.

No language model was configured: a write with none returns `semantic_status:
"skipped"` and `vector_status: "complete"`, so recall needs an embedder only.

At 15 records the two arms were within one hit of each other. The term matcher
degrades with corpus size, which is the regime that matters: a user accumulates
records for as long as they use the product.

## 2026-09-14, DashScope Qwen — measured

Against a live OpenViking v0.4.19 configured exactly as production renders it —
`dashscope` / `qwen3.7-text-embedding`, dimension 1024, `allow_private_networks:
false`, uid 10001 with `cap_drop: ALL` — and the control-plane reranker
(`qwen3-rerank` on the OpenAI-compatible reranks path). Same 12 queries, same
300 records, top 5.

| | term matcher | + qwen3.7 embedding | + control-plane rerank |
|---|---|---|---|
| recall@5 | 0.667 | 0.933 | **1.000** |
| mean reciprocal rank | 0.736 | **1.000** | 0.958 |
| queries returning nothing relevant | 2 | 0 | 0 |
| median added latency | none | 274 ms | 467 ms |

Two things worth reading carefully. The embedder alone already answers every
question — nothing relevant fell to zero, and every first hit was a gold record,
which is what a mean reciprocal rank of exactly 1 means. The reranker then finds
the *last* gold record for the one query that was still missing one, at the cost
of pushing one other gold record from first place to second: recall goes to 1.0
and MRR falls by 0.042. Both ranks are inside a budget of five, so the recall is
the row that decides, and reranking stays on.

The comparison with the retired `bge-m3` arm above is not close: 0.800 → 0.933
recall and 650 ms → 274 ms, so the embedder that replaced it is both better and
faster here.

## Capsule recall

`capsule-corpus.json` and `capsule-queries.json` are the same measurement for the
other recall path: 172 capsule facts across every kind in `CAPSULE_FACT_KINDS`
and every layer in `CAPSULE_LAYERS`, held by two capsules (one owned, one shared
by a colleague), and 16 researcher-worded queries. The distractors share the gold
facts' vocabulary exactly as the record corpus does — several of them are true
statements about the same drugs, the same trials and the same appraisal tools,
answering a question nobody asked.

`--mode capsule` runs it. The `builtin` arm is the lexical PostgreSQL fallback
`CapsuleService` falls back to — `ProductDocuments.search`, one `strpos` of the
whole question against the fact's content, newest first — reproduced in process
because what is compared is a ranking and a ranking needs no rows of its own.
The `openviking` arm writes each fact at the URI the capsule index uses in
production and reads the hits back through the same parser, so a layout change
breaks the measurement instead of quietly making it meaningless.

```bash
node evals/memory-recall/run_recall_eval.mjs --mode capsule --arm builtin --label lexical
OPEN_SCIENCE_OPENVIKING_API_KEY_FILE=/path/to/key \
node evals/memory-recall/run_recall_eval.mjs --mode capsule --arm openviking --label qwen-capsule \
  --url http://127.0.0.1:1933 --seed-index
```

### 2026-09-11, 172 capsule facts, 16 queries, top 5

| | lexical PostgreSQL | OpenViking |
|---|---|---|
| recall@5 | 0.000 | measured on 2026-09-14, below |
| queries returning nothing relevant | 16 of 16 | measured on 2026-09-14, below |

The lexical baseline is the whole finding: sixteen out of sixteen reworded
questions get nothing at all. A substring match cannot answer a question the
researcher phrased differently from the fact, which is what a capsule is for —
so without the index, capsule recall works only for someone who already knows
the words the distiller used.

### Capsule recall, 2026-09-14 — measured

Same server and the same reranker, 172 facts and 16 queries, top 5.

| | lexical fallback | + qwen3.7 embedding | + control-plane rerank |
|---|---|---|---|
| recall@5 | 0.000 | **0.900** | 0.850 |
| mean reciprocal rank | 0.000 | **0.828** | 0.802 |
| queries returning nothing relevant | 16 | 1 | 1 |
| median added latency | none | 227 ms | 593 ms |

The first column is the finding, not the last: the lexical fallback answers
**nothing** — 16 of 16 questions return no relevant fact — because one `strpos`
of a whole researcher-worded question against a fact's text matches only when
the researcher happens to quote the fact. It is a safe degradation, not a
working ranker, and a deployment that loses the index loses capsule recall
rather than slowing it down.

The reranker does not help here. It moves one gold fact out of the top five
(0.900 → 0.850 recall, 18 of 20 gold facts found rather than 19) and mixes four
queries' ordering, two better and two worse. That is one fact of twenty on
sixteen questions, which is not enough to change a default on — the reranker
stays on for both paths and this table is the number a later decision can start
from rather than an argument for one now.

## 2026-10-12, OpenViking v0.4.23 — the pin moved, the rankings did not

Rehearsed before moving the pin, on an isolated v0.4.23 started with the
production `ov.conf` unchanged (its own network and empty volume, an ephemeral
root key) — same corpora, same queries, same embedder:

| | v0.4.19 (2026-09-14) | v0.4.23 |
|---|---|---|
| research recall@5 / MRR | 0.933 / 1.000 | 0.933 / 1.000 |
| + control-plane rerank | 1.000 / 0.958 | 1.000 / 1.000 |
| capsule recall@5 / MRR | 0.900 / 0.828 | 0.900 / 0.828 |
| + control-plane rerank | 0.850 / 0.802 | 0.800 / 0.833 (one gold fact of twenty) |

What changed is the scale: from v0.4.22 a `find` score is (cosine + 1) / 2, so
the same memory and query scored 0.861 where v0.4.19 said 0.712. The search
floor `OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE` moved from 0.5 to 0.75 with the
pin — the same cut on the new scale. Latency here runs through an ssh tunnel
from the dev box, so it is not comparable with the September rows.

## 2026-10-13, OpenViking's native engine — measured

The `native` arm (`--arm native`): the same 300 records and 12 questions, recalled the way the memory plugin recalls — a
`mode: context` search through the memory gateway (`memoryGateway.mjs` rewrites the plugin's request: `purpose` and `quotas`
removed, `query_expansion: off`, the derived index and shared areas excluded) — against OpenViking v0.5.0 with the production
embedder and the policy templates mounted. A hit is a returned memory file whose text carries the gold record's statement whole.

Two ways of storing the corpus, because they ask different questions:

| | term matcher | OpenViking v0.4.23 + qwen3.7 + rerank (2026-09-14) | **native, files written straight in** (retrieval only) | **native, stated in a conversation** (session → commit) |
|---|---|---|---|---|
| gold records the engine holds whole | 13 of 13 | 13 of 13 | **13 of 13** | **1 of 13** |
| recall@5 | 0.667 | 1.000 | **0.933** | 0.067 |
| mean reciprocal rank | 0.736 | 0.958 | **1.000** | 0.083 |
| queries returning nothing relevant | 2 | 0 | **0** | 11 |
| median latency of the search through the gateway | none | 467 ms | **328 ms** | 221 ms |

(`results/2026-10-13-native-files-v0.5.0.json`, `results/2026-10-13-native-conversation-v0.5.0.json`; one run each.)

Read the two native columns apart. **Retrieval** (third column): the engine's own search puts the right memory first for every
question, and finds all but one of the fourteen gold records in the first five — the same recall as the index arm without the
reranker, in less time. **Writing** (fourth column): when the 300 records are *stated* to the engine, it keeps one of the thirteen
gold ones. That is the write policy working, not retrieval failing: this corpus is the legacy store's, 292 of its 300 records are
analysis findings ("what a paper or a method shows") that no person said about themselves, and the engine's templates keep only
what the person stated and would expect to be known next month. Recall cannot rise above what is stored, so the fourth column is
the answer to "does the engine keep what it should", which `evals/memory-write-quality` measures with cases written for it — not
to "does it rank well". A corpus of a person's own standing facts for the native arm is the next case to write.
