# Public benchmarks (baseline v1, 2026-10-28)

EviMed Science measured as a product: every item is a new conversation of a throwaway account on the live deployment (one
lane, runs marked `automated`, so nothing is learnt from them), routed exactly as a user's message would be. The scores are
internal: where a benchmark needs a model judge, the judge is Claude (judge/PROTOCOL.md), not the benchmark's official judge,
and no number here is a leaderboard entry.

Benchmarks in v1 (stratified samples, seed 20261028): MedCalc-Bench, MedBrowseComp, AutoResearchBench, DeepResearch Bench,
BixBench, ResearchClawBench, BioXArena (local held-out split; official scoring is CodaBench). LABBench2 and BiomniBench-DA
need a Hugging Face account that accepted their gates; BioASQ needs a registered participant; TRACES has no downloadable set.

Datasets, decoded items and gold answers are not in this tree (AutoResearchBench asks that its questions not be reposted;
BioXArena data is CC BY-NC). The builders under tools/ recreate them into a work directory (`BENCH_ROOT`).

## Pieces

- `tools/build_*.py` — items per benchmark (`items/<bench>.jsonl`: prompt, gold, scorer); `validate_items.py` checks them.
- `tools/host_fetch.py` — large files fetched on the serving host through the deployment's edge proxy (credentials on stdin).
- `tools/bench-driver.mjs` — one lane: throwaway account, a project per group, a new open-domain session per item, dispatch,
  poll, transcript and files captured, settled cost from `/api/runs/:id/usage`; per-group personal skill (`groupSkill`) with
  mounting evidence; resumable; `tools/test/driver-flows.test.mjs` runs it against a fake control plane.
- `tools/lane.sh` — the host's queue runner (one driver after another; a queue paused by its STOP file stays pending).
- `tools/collect.sh` — results back to the work directory, `answers/<queue>.jsonl` for the scorers.
- `tools/score_*.py` — deterministic scorers (MedCalc official tolerance, AutoResearchBench official deep/wide, short-answer
  pre-scoring, BixBench ranges, BioXArena metrics); `tools/judge_packets.py` and `judge/*.md` for the Claude judge passes.
- `tools/report.py` — scores with 95% intervals (Wilson; bootstrap for continuous scores), cost and time per benchmark.
- `tools/build_rsi_items.py`, `rsi_slice.py`, `export_skill_arms.py`, `preview_choice.mjs` — the capability-skill RSI
  campaign's production arms (evals/rsi-campaigns/skill_campaign.mjs is the consumer the lab runs).
