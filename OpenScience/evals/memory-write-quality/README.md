# Memory write quality

The classes of bad memory the extractor wrote on production, one case each, so
a change to the extraction instructions can be tried and checked instead of
answered with another keyword (principles 5 and 6).

| Class | What was written | Decided by |
|---|---|---|
| `hollow-summary` | 「GLORY-1 试验的注册号、剂量、人群与文献标识。」 — field names, no fact | judgement |
| `internal-id` | a value carrying the GEO module's own id `ge_c4de7529…` | code (string present) |
| `one-off-bookkeeping` | 「本轮检索日期为 2026-09-22」, 「安全状态均为 clear」 | judgement |
| `default-project-follow-up` | five assistant-floated directions filed as 「我的研究」 to-dos | code (kind × project); also refused at write time since 2026-09-27 |
| `near-duplicates` | three keys for 「说明书核对口径为转载页」 | code (record count) |
| `platform-brief-as-user-words` | the GEO brief stored as `explicit` | code (the tagged brief never reaches the extractor) |
| `pending-state-and-inventory` | 「待用户提供一句话研究问题或上传方案…」, 「平台现有三份病种知识包…」 from 虚拟临研 conversations | judgement |

`written` is copied from the audit's captures, never paraphrased. A `replay` is
the conversation the case is run against; one marked `reconstructed` was
rebuilt for the eval because the original transcript stays on production, and
its placeholders (`NCT-PLACEHOLDER-1`) are not facts.

```bash
node evals/memory-write-quality/run_write_quality_eval.mjs --offline
OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/key \
  node evals/memory-write-quality/run_write_quality_eval.mjs --out evals/memory-write-quality/results/$(date +%F).json
```

A `needs-judgement` verdict prints what was written beside the case's `judge`
question; it is read by a person or a model judge, never matched by a pattern.
`apps/server/test/memoryWriteQualityCorpus.test.mjs` holds the corpus shape and
the code-decidable checks offline.

## 2026-09-27, deepseek-flash — the two judgement classes, before and after one instruction

Replays of the reconstructed conversations through the real extractor; the
records written, read by hand. "Before" is `main@1cf308956`'s instructions,
"after" adds two sentences (a summary states the fact; nothing true of one run
only). Raw outputs in `results/`.

| Replay | before (2 samples) | after (3 samples) |
|---|---|---|
| `one-off-bookkeeping` — records written from 「本轮检索日期…」「快照已更新」「状态均为 clear」「工具能力缺口」 | 4, 1 | 0, 0, 0 |
| `hollow-summary` — a summary that lists fields | 0, 0 | 0, 0, 0 |
| `hollow-summary` — 「…整理，供后续写文章使用」 kept as a follow-up | 1, 1 | 0, 1, 1 |

The decided classes passed in every sample. The last row is still open: the
reason a conversation compiled something is recorded as a to-do in most
samples.
