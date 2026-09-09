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
node evals/memory-recall/run_recall_eval.mjs --arm builtin \
  --out evals/memory-recall/results/$(date +%F)-builtin.json

OPEN_SCIENCE_OPENVIKING_API_KEY_FILE=/path/to/key \
node evals/memory-recall/run_recall_eval.mjs --arm openviking \
  --url http://127.0.0.1:1933 --seed-index \
  --out evals/memory-recall/results/$(date +%F)-openviking.json
```

## 2026-09-09, 300 records, top 5

| | term matcher | OpenViking v0.4.19 |
|---|---|---|
| recall@5 | 0.667 | 0.800 |
| mean reciprocal rank | 0.736 | 0.917 |
| queries returning nothing relevant | 2 | 0 |
| median added latency | none | 650 ms |

The number that decided it is the third row. Two of twelve questions got no
relevant memory at all from the term matcher, and a run cannot repair what it
never saw. Latency is the cost: 650 ms on a run measured in minutes.

Measured against a live OpenViking with `bge-m3` on Ollama — the embedding model
the MemOS overlay already runs, so this is not a comparison of embedders. No
language model was configured: a write with none returns `semantic_status:
"skipped"` and `vector_status: "complete"`, so recall needs an embedder only.

At 15 records the two arms were within one hit of each other. The term matcher
degrades with corpus size, which is the regime that matters: a user accumulates
records for as long as they use the product.
