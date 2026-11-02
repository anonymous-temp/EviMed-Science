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
- `tools/bench-driver.mjs` — one driver process: throwaway account, a project per group, a new open-domain session per item,
  dispatch, poll, transcript and files captured, settled cost from `/api/runs/:id/usage`; per-group personal skill (`groupSkill`) with
  mounting evidence; resumable; `tools/test/driver-flows.test.mjs` runs it against a fake control plane (`node tools/test/driver-flows.test.mjs`,
  about two minutes; `TEST_FILTER=<regexp>` runs a subset). What it records beyond the answer (bench-driver/3):
  - Files: at most 40 are read, report-like ones first (a document under `report/`, any Markdown/Word/PDF file at any depth; newest
    then largest), then figures of a report, then the rest in the run record's order. A 54-file `artifacts` list once hid
    `report/report.md` behind its own code files, which made two ResearchClawBench reports look missing.
  - A run that times out is cancelled, then the workspace is scanned (`list_dir`) for report-like files written after the dispatch; the
    newest are captured too and `lastReport` {path, bytes, mtime, saved} names the newest document, or is null when there is none.
    Scorers and judge packets read it as delivery `at-cap`; report.py reports the strict figure (timeout = 0) and the at-cap one.
  - `firstReportAtMs` (first completed write of a report-like file by a tool call, milliseconds after the turn began; `firstReportPath`)
    and `deliveredWithinCap` (the run ended on its own inside the cap with an answer or a report) — null/false when not known.
  - Cost: a usage record that still shows an uncertain call or an open reservation when it is read is read again (every `--usage-poll-ms`,
    10 s, for up to `--usage-settle-s`, 90 s; `0` reads once); `costSettle` {waitedMs, reads, first, final, settled} says what was seen first and last, and
    a record that never closes is kept as the ledger last said it.
  - Item field `timeBudgetMinutes` (absent by default) is passed to the dispatch as the product's field of the same name and
    recorded; `timeoutMin` stays the driver's own cap and is never sent.
  - A dispatch answered 500/502/503/504 is infrastructure: asked again with a bounded exponential backoff (10 s doubling to 2 min,
    12 tries), every try in `dispatchRetries`, `infrastructure` {retries, statuses}; if it never succeeds the item is
    `dispatch_refused` with `infrastructureFailure: true` and is run again by the next start. 429/423 keep their flat 60 s waits.
    `--retry-scale` multiplies every wait (tests).
- `tools/lane.sh` — the host's queue runner. `lane.sh` is the default lane, unchanged (`lane/lane.log`, `lane/STOP`, container
  `bench-<queue>`; a queue paused by its STOP file stays pending). `lane.sh <id>` is a named lane (`lane/lane-<id>.log`,
  `lane/STOP-<id>`, container `bench-<queue>-<id>`) so several lanes can run on one host: they share `lane/pending.txt` and
  `lane/done.txt` under `lane/pending.lock`, claim a queue with `mkdir lane/claims/<queue>` (atomic), and each queue has its own
  `--out`. `lane/STOP-ALL` stops every lane after its current queue. A lane that stops on a non-zero exit keeps its claim; `--status`
  shows claims and lanes, `--release-stale` frees the claims of lanes that are not running (never silently taken over). Test seams:
  `BENCH_LANE_ROOT`, `BENCH_LANE_IDLE_S`, `BENCH_LANE_RUN`; test: `node --test tools/test/lane.test.mjs` (bash and flock, no docker).
  How many lanes, and where, is the owner's decision; nothing here starts one.
- `tools/shard_queue.py` — `split --queue queue/NAME.jsonl -k K` writes queues `NAME.s1`..`NAME.sM` (original lines, original order) and
  `NAME.shards.json`. Items of one group stay in one shard (the driver keeps one project, skill copy and runtime per group and one account
  per process), and so do the arms of one row (same bench and id without `#r<n>`). Units are balanced by `timeoutMin`, greedy and
  deterministic. A queue that is one big group, or arms in separate groups over the same rows, is one unit and stays one shard (stderr and
  the manifest say so); `--split-groups` spreads a group over lanes while keeping each row's arms together, at the price of one more
  project, skill copy and runtime per lane. `--replace-pending lane/pending.txt` swaps the queue for its shards under `pending.lock`;
  `check` verifies the partition; `merge-answers` joins `answers/<shard>.jsonl` back in queue order.
- `tools/register_pools.py` — registers the development and confirmation pools of each benchmark under `$BENCH_ROOT/pools/<bench>.json`
  (ids only, outside the repo). Baseline v1 (every `items/*.jsonl`, the rsi arms and `medcalc_used_rows.json`) is excluded first; the rest is
  split by `sha256("<salt>|<id>")[0]`, even to development, odd to confirmation, salt `20261028` (`SEED`; MedCalc keeps the salt of
  `rsi/pools.json`). Confirmation ids that share a MedCalc note or a BixBench data family with a development or v1 id are dropped and listed.
  The file carries counts, the baseline file hashes and a digest; `--check` verifies them and re-derives the registration; a registered file is
  never overwritten without `--force` (the old one goes to `pools/superseded/`). RCB lists the tasks beyond the 40 leaderboard ones under
  `extraTasks`, unsplit. `python3 -I tools/register_pools.py --root $BENCH_ROOT [--bench NAME] [--check|--force]`; the MedCalc Verified
  test set is read from `data/medcalc_verified/test_data.csv` (fetch command in the file header). Registered 2026-10-31:

  | bench | universe | v1 excluded | development | confirmation | dropped |
  |---|---|---|---|---|---|
  | bixbench (capsules) | 59 | 12 | 23 | 15 | 9 |
  | drb | 100 | 30 | 33 | 37 | 0 |
  | rcb (leaderboard) | 40 | 6 | 19 | 15 | 0 |
  | arb deep | 600 | 30 | 288 | 282 | 0 |
  | arb wide | 400 | 15 | 179 | 206 | 0 |
  | medbrowsecomp | 605 | 80 | 260 | 265 | 0 |
  | medcalc | 1100 | 235 | 386 | 278 | 201 |
- `tools/collect.sh` — results back to the work directory, `answers/<queue>.jsonl` for the scorers.
- `tools/score_*.py` — deterministic scorers (MedCalc official tolerance, AutoResearchBench official deep/wide, short-answer
  pre-scoring, BioXArena metrics); `tools/judge_packets.py` and `judge/*.md` for the Claude judge passes.
- `tools/score_bixbench.py` — the benchmark's own verifiers, ported from Future-House/BixBench `bixbench/graders.py`: `str_verifier`
  (letters and digits only, lower-cased: equal, or the answer inside the ideal) and `range_verifier` (`lower <= x <= upper`);
  `llm_verifier` and whatever misses both rules are `needs_judge`. Two deviations, both stated in the file: an answer with no letter or
  digit is incorrect (the official code would pass it), and a range answer that is not a single number is read by its first number
  (`rule: first-number`; `--official-only` turns that off). `--deterministic-only` prints the strict and upper-bound figures of the
  range and str questions, `--compare judge/bixbench.final.jsonl` the agreement with a judge and every disagreement.
  Measured on the 57 questions of baseline v1: code settles 35, 34 agree with the Claude verdicts, the one disagreement is the
  fraction-versus-percent case (bix-18-q5); the strict deterministic figure is 12/49 (24.5%) against the judge's 22/49 (44.9%) on the
  same questions, because a `str_verifier` answer is a long free-text line, not the value alone (1 of 23 settled correct by code, 9 by the judge).
  The official open-answer harness sends range questions and unmatched str questions to an LLM, so code alone is a floor.
- `tools/judge_packets.py` — packets per benchmark (`drb`, `bixbench`, `rcb`); `$BENCH_ROOT` is the work directory. A timed-out run with a
  `lastReport` gets a packet that carries it (`delivery: "at-cap"` in meta.json); `--repeats N` writes N independent packet sets
  (p1…pN; large trees linked, no verdict anywhere in them); `--modes llm_verifier` / `--bix-unsettled` limit a BixBench packet to the
  questions for a judge.
- `tools/report.py` — scores with 95% intervals (Wilson; bootstrap for continuous scores), cost and time per benchmark. `score` is strict
  (a timeout is 0), `scoreAtCap` the judged score of the at-cap reports; `deliveredWithinCapRate` and `medianFirstReportSeconds` from the
  driver's records. Repeated judging: `judge/<name>.p2.jsonl`, `.p3.jsonl` … are further passes over the same reports; an item's value is
  the mean of its passes, `judgeSd` the pooled within-item SD (null for one pass, never 0), `flipRate` for proportions.
- `tools/noise_sample.py` — the judge-noise sample of phase 0.4: `packets` writes three blind passes of the 5 delivered ResearchClawBench
  reports, DeepResearch Bench tasks 59, 27, 75, 63, 77, 3, 13, 53, 62, 100 and the BixBench `llm_verifier` questions of the answered
  capsules to `judge/packets-noise/`; `band` reads the verdict files (`judge/noise/<bench>.p<k>.jsonl`) and prints the noise of one
  judging (pooled SD, 95% half-width, mean pair difference, the smallest difference judge noise alone would hide for 8 to 40 reports).
- `tools/drb_pairwise.py` — DeepResearch Bench between two of our arms. RACE against the fixed reference compresses at the top (a perfect
  10 only reaches 0.573, `report/analysis-drb.md` §6), so a +10 point change is invisible; this compares the two reports directly.
  `packets --task ID --a PATH --b PATH --arm-a X --arm-b Y [--passes 2] [--seed N] [--out DIR]` writes judge packets (`task.txt`,
  `criteria.json`, `report_1.md`, `report_2.md`, `meta.json`) and, apart, `order.json`: every pair is judged in both orders and the
  order never appears in a packet. A judge writes one line per packet (`judge/drb-pairwise.md`): a preference from -3 to +3 on each
  criterion. `aggregate --verdicts … --order DIR/order.json` maps them back to the arms: the mean signed preference by dimension and in
  total (bootstrap 95% CI over tasks), win/tie/loss with a ±0.25 dead zone, a position-bias estimate, the order-swap agreement, and the
  tasks it had to leave out (listed, never zero). No provider is fixed: the judge is whoever reads the packets (Claude subagents, or an API
  judge later). A calibration against the official judge (GPT-5.5 since 2026-05-11, Gemini-2.5-Pro on the legacy board) would run the
  official pipeline on the same tasks for both arms and compare the sign and rank of the differences; it needs the owner's decision on a
  paid judge, and nothing here calls one.
- `tools/build_round_gold.py`, `score_round.py`, `judged_packets_round.py` (with `round_lib.py` and `score_runs.mjs`) — the development-side scoring path of an RSI
  round (2026-11-01), on the box that holds the gold (`$BENCH_ROOT/rsi/score/`, never in git, never in a lane request). `build_round_gold.py --rows rows.json`
  writes the development gold of the rows a round names in the shape `export_harness_arms.py` reads (`<domain>.items.jsonl`, `<domain>.rows.json`, a manifest)
  and REFUSES, by name and before reading anything, any id on a pool's confirmation list (also dropped, baseline-v1 and unknown ids). `score_round.py --arm NAME=PREFIX
  ... --rows rows.json` reads the lanes' bundles (`<rid>.tgz` + `.meta.json`, safely unpacked, sha256 checked) and scores them with the lab's own scorers
  (`score_runs.mjs` calls `evals/rsi-campaigns/harness_scorers.mjs`; nothing is ported): per family and arm the score with a bootstrap interval, delivery, timeouts,
  time, settled cost, tool calls, language mismatches, contamination hits and the at-cap facts, per-slice tables, and paired differences over rows. Infrastructure
  failures (by `export_harness_arms.classify`) and runs that have not arrived are listed apart and never zero-filled; BixBench capsules code cannot score are
  judge-only and the open-question share is printed because `bixbench-deterministic` is a floor. `judged_packets_round.py` writes blinded packets for the judged
  parts (DeepResearch Bench pairwise with swapped order, or absolute; ResearchClawBench; BixBench questions code leaves to a judge; MedBrowseComp cases) with the
  key to the arms kept apart in `operator/`. Tests: `test_build_round_gold.py`, `test_score_round.py`, `test_judged_packets_round.py` (synthetic data only).
- `tools/export_harness_arms.py`, `register_round.py`, `make_harness_bundle.py`, `make_cost_closure.py` — the harness-patch / tool-patch campaign's export, pre-registration
  and candidate tools (evals/rsi-campaigns/README.md has the campaign). A run whose ledger record is uncertain keeps `cost.cost` (the settled sum, a lower bound) in the source and
  is listed in `<out>.uncertain-costs.json`; only a run with no cost record is null. `register_round.py` computes the judge's call budget from the registration and refuses a lower maximum,
  takes `--exclude-opened FILE` (rows earlier campaigns opened) and `--surface tool-patch`. `make_harness_bundle.py --tool-patch` records a branch's code (`--code-path`,
  `--tool-catalogue-chars`) in the candidate; `export_harness_arms.py --surface tool-patch` carries it onto the arm. `make_cost_closure.py` collects the ledger records of the runs a refused
  receipt names (`--run ROW:ARM:REPEAT=result.json`) for `rsi-lab-harness.sh <month> <family> close`.
- `tools/build_rsi_items.py`, `rsi_slice.py`, `export_skill_arms.py`, `preview_choice.mjs` — the capability-skill RSI
  campaign's production arms (evals/rsi-campaigns/skill_campaign.mjs is the consumer the lab runs).

## Tests

```sh
cd OpenScience/evals/public-benchmarks
node tools/test/driver-flows.test.mjs                                    # the driver against a fake control plane (~2 min; TEST_FILTER=<regexp> for a subset)
python3 -I -m unittest discover -s tools/test -p 'test_*.py'             # scorers, packets, report, noise, pairwise, pools, shards (synthetic fixtures only)
node --test tools/test/lane.test.mjs                                     # lanes against a fake driver (bash, flock; no docker)
```

Python is 3.10-compatible and run with `-I`; the tools find their data through `BENCH_ROOT` (default the current directory) and never
write into this tree. The registered pools (`register_pools.py`) are written under `$BENCH_ROOT/pools/`, not here.
