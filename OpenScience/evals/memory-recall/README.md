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

## 2026-09-11, DashScope Qwen — pending

Production embeds with DashScope (`qwen3.7-text-embedding`, dimension 1024, in
the index's own `ov.conf`) and reranks in the control plane. Nothing here has
been measured yet: no DashScope key existed when the arms were defined, so this
section records what will be run, not what was found. Three arms, same 12
queries and same 300 records:

| label | what it is |
|---|---|
| `builtin` | the shipped term matcher; the floor, and the fallback when the index is down |
| `qwen` | OpenViking vector order with the DashScope embedder |
| `qwen-rerank` | the same vector candidates, reordered by the control-plane reranker |

The third arm is separate from the second because the reranking does not happen
in the index: `/search/find` never reranks, and `/search/search`, which does,
returns nothing at all for this memory layout — it navigates by directory
abstracts that no language model generates here. So a rerank section in `ov.conf`
would buy nothing, and the comparison that matters is the last two rows: what the
extra call to DashScope adds over the vector order, and what it costs in latency.

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
| recall@5 | 0.000 | not yet measured |
| queries returning nothing relevant | 16 of 16 | not yet measured |

The lexical baseline is the whole finding: sixteen out of sixteen reworded
questions get nothing at all. A substring match cannot answer a question the
researcher phrased differently from the fact, which is what a capsule is for —
and until the index answers these, capsule recall works only for someone who
already knows the words the distiller used. The index arm needs a
DashScope-configured server and has not been run; the row stays visible and
empty rather than absent, because an unmeasured arm is a fact about this
comparison.
