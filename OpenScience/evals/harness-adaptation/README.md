# Harness2 adaptation for EviMed Science (RSI round 1)

Task-level recursion from the pinned upstream Harness2 core (`google-research/harness2` @ `1cfe254e8d25b15f37048c3730134686abe60335`, Apache-2.0), with the
platform's own DSH + DeepSeek runtime as the solver and the round's benchmark domains as adapters. Offline research arm only (docs/superpowers design, sections 7 and 14):
nothing here ships in the runtime image, the server or the production deployment.

```
setup.sh                    fetch the pinned commit into a work dir, apply patches/, write the setup marker      (PATCHES.md is its manifest)
run_round.py                the resumable driver (k=1, parallel mode only)
config/channels.json        per-stage improver models (Sonnet / DeepSeek / Opus) and the DeepSeek endpoint row
evimed_h2/surface.py        the DSH SurfaceSpec: guidance.md (<= 4,000 chars) + skills; no plugin, hook, sub-agent, script
evimed_h2/adapter.py        BenchmarkAdapter over the lab broker (request, digest identity, bundle, cost, isolation)
evimed_h2/broker.py         brokerctl wrapper + the shared inbox (global fetch, one lock)
evimed_h2/families.py       the seven domains, task builders, hash-order selection, public fetch lists
evimed_h2/trajectory.py     DSH transcript -> [ACTION]/[OBSERVATION]/[ERROR]; deliverables = final answer + report-like files
evimed_h2/channels.py       Proposer subclass per stage on the `claude` CLI; usage, failure classification
evimed_h2/guard.py          request guard (no gold/rubric/score) and tree guard (process text only)
evimed_h2/ledger.py|balance.py   rsi1-ledger.jsonl; balance floor 500 CNY read at most once a minute, round cap 800 CNY
tools/                      snapshot_guidance.mjs, audit_results.py, live_stage_check.py
tests/                      fake lab (fake_brokerctl.py, uses lab/broker.py's own validation) and fake CLI; 80 tests, no network
```

## Run

```bash
cd OpenScience/evals/harness-adaptation
./setup.sh                                  # needs git and Python >= 3.12; H2_SOURCE=<local clone> works offline
python3 run_round.py --select-ppc           # once: writes bench/rsi/ppc-tasks.json (+ ppc-fetch.json for brokerctl --fetch)
python3 run_round.py --dry-run              # plan, no side effects
python3 run_round.py [--domains a,b] [--max-tasks 4] [--concurrency 2]      # resumable: run it again after any stop
python3 run_round.py --ledger-report
python3 -m unittest discover -s tests       # (run from this directory; tests/ imports its own support module)
```

Exit codes: 0 every task adopted or honestly excluded, 2 some task failed for a reason of its own, 3 infrastructure stopped it (quota, lab, balance, cap): run again later, 1 usage or identity mismatch.
Heavy state lives in `/tmp/rsi1-scratch/h2-runs` (`RSI1_SCRATCH`, `H2_RUNS_ROOT`); only small text (libraries, adopted trees, summaries, the ledger) is copied to `bench/rsi/h2/<domain>/`.

## The round, as built

For each of the four chosen tasks of a domain, in hash order, with the domain's library threaded forward: one base rollout on the unmodified image (no probe text; the router decides) ->
upstream's `run_parallel(k=1)`: an invariant candidate (Sonnet) and a domain candidate (DeepSeek) each edit the empty base tree and are rolled once as probes; the composer (Opus) writes `agg1`, rolled once ->
a blind selector (Opus) chooses between the **base run and `agg1`** (baseline stays in the pool) -> the reflector (Opus) writes the EXPERIENCE entry -> the library of that domain gets the adopted tree + entry.
Per task: 4 rollouts and 5 improver sessions at most. The method never sees a score; `score()` raises.

* **Probe**: `guidance.md` is `probe.preamble`; all skills are merged into one `groupSkill` (sections, one description); `probe.line` pins the route the base run took (`answer` for `open-domain-answer`, else the capability id) and so does `item.line`.
  Scripts do not reach the lab (a `groupSkill` is title, description, instructions), so `validate_tree` refuses them with an actionable message instead of silently dropping them (the design said "optional scripts/"; this is the one place the surface is narrower).
* **Request**: `{rid, image: "base", item: <bench-driver queue line>, probe: {preamble, line}}`. `rid = h2.<run id>.<sha256(image,item,probe)[:10]>` (<= 120 chars): a changed input is a different request, the same input is the same one. `item.key = <bench>/<id>#<rid>`, `item.group = h2-<digest>` (own project per run, deleted after).
* **Tasks** are the registered *development* pools only (`families.Family.tasks()` refuses an id outside the list and never reads the confirmation list), built from raw data exactly as `bench/tools/build_*.py` built the baseline items; `tests/test_families.py` reproduces the baseline queue lines (medcalc 120/120, arb deep 30/30 and wide 15/15, mbc 80/80, bixbench 10/12, rcb 7/8: the other 3 differ only where the baseline queue was edited later for gzipped host copies). Only solver-visible columns are projected at read time.
* **Selection**: first 4 feasible development ids by `sha256("rsi1-ppc|<id>")` per domain (bixbench: >= 3 questions, <= 250 MB; rcb: not the three ruled out by the baseline builder, <= 300 MB). Written to `bench/rsi/ppc-tasks.json` (never replaced silently; `--force`).

## Improver channels (verified 2026-11-01 on this box, `claude` 2.1.312)

| stage | label | model | route |
|---|---|---|---|
| invariant editor | `inv*` | `claude-sonnet-5-5` | box login |
| domain editor | `dom*` | `deepseek-v4-pro[1m]` | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` from `deepseek.api-key`, same CLI |
| composer / selector / reflector | `agg*`, `select.*`, `experience.*` | `claude-opus-5-5` | box login |

* DeepSeek endpoint and ids, from <https://api-docs.deepseek.com/guides/anthropic_api> and `/quick_start/agent_integrations/claude_code`: base URL `https://api.deepseek.com/anthropic`; ids `deepseek-flash`, `deepseek-v4-pro`; `claude-opus*` maps to v4-pro, `claude-sonnet*`/`claude-haiku*` to flash; other non-`claude` ids are a 400; the Claude Code page uses the `[1m]` suffix. A real call on this box returned `OK` for `deepseek-v4-pro` and, with Read/Write/Edit/Glob/Grep tool use, for `deepseek-v4-pro[1m]` (CLI context window 1,000,000 instead of 200,000).
* **The CLI prices DeepSeek wrongly** (`costBasis: unknown`, Claude-like rates, about 3.6x the real cost; `total_cost_usd` for 3,747 in / 7,680 cached / 492 out was $0.0264, the DeepSeek table gives about $0.0072). The ledger therefore records tokens for every call and computes DeepSeek cash itself at the platform's reference rates (`packages/domain/src/metering.mjs`, peak; the provider halves it off-peak) and marks it an estimate. Claude stages are subscription usage: tokens and the API-equivalent `usd_reported`, no cash.
* **Sandbox** (probe: Sonnet session asked to read `/etc/hostname`, `/home/coder/.claude/CLAUDE.md` and run `echo hi`): `--safe-mode --restricted --tools Read,Write,Edit,Glob,Grep --permission-mode acceptEdits --permission-prompts none --no-session-persistence`. Edits inside the scratch cwd worked; both reads outside were denied (`permission_denials` recorded), there is no shell tool, no CLAUDE.md, no MCP, no hooks. `--dangerously-skip-permissions` is not used (`--restricted` refuses it). The session scratch directory is upstream's own `mkdtemp`, moved under the runs root. Each session is bounded by `timeout` and `--max-budget-usd` (upstream's `ChannelSpec.steps` is ignored by its `claude_cli` path).
* Inherited `ANTHROPIC_*`, `CLAUDE_CODE_*`, Vertex variables of the starting shell are scrubbed; the key is read from its file at spawn, passed in the child's environment only, never stored or logged (`test_secret_key_never_reaches_disk_or_the_cli_log`).

## Qualification before any paid run (design section 7)

| # | requirement | how it is met | test |
|---|---|---|---|
| a | a dependency or slot failure stays an infrastructure failure; upstream's `fell_back` is visible and excludes the task from the library | lab / broker / driver / quota / transport / timeout / budget raise `InfrastructureFailure` (patch 0001 lets it through `_roll`; the improver wrapper raises it past `_run_stage`); the task is recorded `infra`, nothing around it is adopted, no rollout is spent on a stand-in. A stage that fell back for its own reasons (bad tree twice) is listed in `summary.json` with its error and the task is `excluded` (no library entry, no reflection) | `test_round.py::test_resume_after_an_infrastructure_stop...`, `::test_quota_is_a_transport_failure...`, `::test_a_stage_that_fell_back...`; `test_adapter.py::test_a_run_that_did_not_happen...` |
| b | cost attribution in one ledger | `rsi1-ledger.jsonl`: one keyed row per rollout (settled CNY from `result.json`), per improver attempt (tokens, API-equivalent USD, DeepSeek CNY estimate); `--ledger-report` totals; the round cap and the balance guard read it | `test_round.py::test_cost_attribution_lands_in_one_ledger`, `test_channels.py::LedgerTest` |
| c | resume identity includes input digest and channel/model; re-running does not pay twice | rollouts: rid carries the request digest, finished runs are found by marker, fetched bundles by inbox; improver replies: upstream's content key + one cache directory per (stage, provider, model, effort); per-domain `identity.json` (pin, patch digests, channels, surface text, prompt pack, task prompt digests, guard parameters) refuses a resume with anything changed | `test_round.py::test_resume_pays_nothing_twice`, `::test_identity_mismatch_...`, `test_channels.py::test_another_model_is_another_cache`, `test_adapter.py::test_changed_input_is_a_different_request` |
| d | no score reaches a session | requests are whitelisted and scanned (`guard.assert_request_clean`, stricter than the broker's own rule, checked against `lab/broker.py` in a test); bundle reads are limited to answer, transcript, report-like files and cost; any grading-named file in a bundle is deleted and recorded; upstream's `assert_tree_has_no_grader_verdicts` and `assert_no_grader_verdicts` run on every context and tree; `leak_globs` is the tripwire. Audit of the 756 baseline result folders: no grading key and no grading file (`tools/audit_results.py`); DRB: 3 of 30 runs share a 60-character stretch with the reference article, all in tool observations of public pages (run 76 also in its own text), RCB: 0 of 8 with the rubric. That is retrieval of public text, the same exposure the solver had, and it is reported rather than hidden | `test_guard.py`, `test_adapter.py::test_a_grading_file...`, `test_round.py::test_nothing_gold_reaches...`, `test_trajectory.py::RealTranscripts` |
| e | baseline stays in the selection pool | the pool is `{base1, agg1}`, `pool_kind="mixed"` (the selector is told an unmodified run is a valid pick); upstream's finals-only pool and trivial k=1 selection are not used | `test_round.py::test_one_task_whole_recursion` (`id_map` = agg1 + base1) |
| f | a tree with task text, numbers or dataset names is refused | `guard.TreeGuard` in `adapter.validate_tree`: a 60-character verbatim stretch of any development prompt of the domain (case and spacing folded), more than 12 numerals (list markers excluded), a benchmark / file / UUID / trial / arXiv / task-id name; the message names what was found and goes back to the editor as upstream's retry feedback. The `tts` prompt pack ("generalize, do not memorize") is used; the default pack tells editors to write workspace facts into the harness | `test_guard.py::TreeGuard`, `test_adapter.py::test_validate_tree...`, `test_upstream.py::...every_domain` |

Also: the baseline-run route is persisted per task (`routes/<domain>.json`) so a resumed probe pins the same line; a stale infra-failed marker is archived before a fresh ask; the driver's per-task summary lists every stage, rollout, the selection (with anonymised id map) and the experience.

## What was verified live (2026-11-01, `tools/live_stage_check.py`)

One synthetic task (a fixture patient note, fake lab, a synthetic base run that answers "roughly 41" from recall without a tool), the real `claude` CLI through `H2Proposer`, upstream's own `_run_stage`:

| stage | model | result | usage |
|---|---|---|---|
| `inv1` | `claude-sonnet-5-5`, box login | accepted: `guidance.md`, 965 characters, five process rules (recompute in code, name the calculator first, input/time-point discipline, unit and rounding, the requested final line last); the notes cite the trajectory moment | 14 s, 7 turns, 8 in + 8,018 cache-write + 32,281 cache-read + 1,124 out tokens, 0 denials, API-equivalent $0.047 (no cash) |
| `dom1` | `deepseek-v4-pro[1m]` via `api.deepseek.com/anthropic` | accepted: `guidance.md` (869 characters) + `skills/missing-input/SKILL.md` with its trigger line in the guidance; no number, name or task wording | 67 s, 16 turns, 8,140 in + 48,512 cached + 5,050 out tokens, 0 denials, about CNY 0.22 at the reference rates |

The first DeepSeek run was refused twice by the tree guard for writing the bare word "MedCalc" (CNY 0.63 for the two sessions, 120 s each): a false positive of the name list (it is also the name of an ordinary calculator site), so the bare word was removed from the list and the benchmark names stay. In all, the live checks spent about CNY 0.87 of DeepSeek, more than "a few cents"; the Sonnet session counted against the box's Claude quota only.

## Limits worth knowing

* The lab's `lane.py` and bundle layout were not built when this was written; the adapter accepts a bundle that holds `result.json` at its root or under one directory, and treats a bundle whose `result.json` status is not final (`succeeded|failed|canceled|timeout`) as an infrastructure failure, like the driver's own `dispatch_refused` / `driver_error`.
* With k=1 every candidate has one rollout: a difference between `base1`, `inv1`, `dom1` and `agg1` is one draw each. The reflector is told to call such rows `confounded`; the library lessons are hypotheses for the lead's distillation, not findings.
* Per-run projects mean no warm runtime: probes pay the cold-start the baseline paid (the baseline driver also made one project per group).
* The bench-driver result folder is the only run record. A run that wrote a report as `.docx`/`.pdf` is shown to the editors by name and size only.
* Disk: `/home` is nearly full; nothing large is written there. The runs root is `/tmp/rsi1-scratch/h2-runs`.
