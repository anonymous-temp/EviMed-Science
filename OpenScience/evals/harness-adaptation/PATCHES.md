# Patch manifest for the pinned Harness2

Upstream: `google-research/harness2` at `1cfe254e8d25b15f37048c3730134686abe60335` (v0.1.0, Apache-2.0, Google LLC). It is never vendored here:
`setup.sh` fetches the pin into a work directory (default `/tmp/rsi1-scratch/harness2`), applies `patches/*.patch`, and writes
`<workdir>/.h2-setup.json`; `evimed_h2/upstream.py` refuses a work directory whose pin or patch digests differ, and `tests/test_upstream.py` runs
upstream's own `tests/test_workflow.py` on the patched tree (5 tests, pass). No open upstream pull request is imported.

## Patches (changes to upstream's files)

Real size: **1 file, 2 lines added** (`git diff --stat`: `harness2/core/recursion.py | 2 ++`).

| # | file | change | reason | test | limitation | delete when |
|---|---|---|---|---|---|---|
| 0001 | `harness2/core/recursion.py` (`_roll`, line 289) | `except Exception` re-raises an exception whose class carries `infrastructure = True` | `_roll` turns every exception into a dead `RunView`, so a lab or broker failure became a rollout "result" and the stages after it ran on a hole (docs/design section 7: a slot failure must stay an infrastructure failure) | `tests/test_adapter.py::test_infrastructure_failure_passes_through_upstream_roll`, `test_round.py::test_resume_after_an_infrastructure_stop_reuses_everything_already_paid` | duck-typed attribute, no import of this package; `_run_stage`'s outer `except Exception` around `context.build` (recursion.py:166) still folds an adapter bug into a fallen-back stage, which the driver reports and excludes | upstream separates infrastructure failures from dead rollouts, or accepts an equivalent hook |

## Overrides (upstream behaviour replaced from this package, no change to upstream's files)

Each is a place where upstream's default is wrong for this platform and the replacement fits in a subclass, a registry entry or the driver. They are listed
because the design asks for every deviation from upstream to be explicit, and because each assumes something about upstream that `tests/test_upstream.py`
pins (`test_private_names_this_package_relies_on`, `test_upstream_defaults_this_package_replaces`).

| # | upstream (file:line) | replaced by | reason | test | delete when |
|---|---|---|---|---|---|
| O1 | `core/proposer.py:105-125` `Proposer.env`: the `claude_cli` channel is Vertex only (`CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`) and drops all `ANTHROPIC_*` | `evimed_h2/channels.py` `H2Proposer.env`: this box's own Claude login; no Vertex; scrubs `ANTHROPIC_*`/`CLAUDE_CODE_*` inherited from a parent shell; a provider row adds `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` read from the key file at spawn | the round runs on a Claude login and on DeepSeek through the same CLI | `test_round.py::test_env_hygiene_of_every_session`, `test_channels.py::test_deepseek_stage_gets_its_endpoint_and_key_and_the_key_is_not_stored` | upstream gets a non-Vertex `claude_cli` channel |
| O2 | `core/proposer.py:210-250` `Proposer._claude_cli`: `--dangerously-skip-permissions`, full tools, no `--model`, no usage kept | `H2Proposer._claude_cli`: `--safe-mode --restricted --tools Read,Write,Edit,Glob,Grep --permission-mode acceptEdits --permission-prompts none --no-session-persistence --model --max-budget-usd`; parses `usage`; classifies failures | sessions must not see this box's files, shell, CLAUDE.md or settings; usage must be counted | verified live (README, "What was verified"); `test_channels.py` | upstream makes the sandbox flags configurable |
| O3 | `core/proposer.py:126-208` `Proposer.call` retries any `Exception` and ends in `ProposerError`, which `_run_stage` (recursion.py:195) turns into an inherited-harness stage | `H2Proposer.call` wraps it: every paid attempt is written to the ledger; a quota, auth, transport or timeout ending is raised as `InfrastructureFailure` (not a `ProposerError`, so `_run_stage` does not catch it); a spent session budget or an empty reply stays the stage's own failure | design section 7: a dependency or slot failure must not silently become a successful inherited-harness candidate | `test_channels.py::test_quota_is_infrastructure_and_not_a_proposer_error` and neighbours; `test_round.py::test_quota_is_a_transport_failure_never_a_fallen_back_candidate` | upstream distinguishes transport failure from a bad reply |
| O4 | `core/proposer.py:507` `_call_fingerprint(label, mission, system, context_dir)`: a cached reply is keyed without channel, model or effort | `channels.build_router`: one audit (= cache) directory per (stage, provider, model, effort) | a reply made by one model must never be served as another's after a config change | `test_channels.py::test_another_model_is_another_cache` | the key includes the channel spec |
| O5 | `core/prompts.py:664-671` `_SURFACE_TEXTS`/`_st`: only `opencode` and `codex` surfaces exist | `evimed_h2/surface.py` `register_prompts()` adds a `dsh` entry (private dict and dataclass, pinned by test) | the DSH surface needs its own words (guidance.md, skills, 4,000-character cap, no scripts/plugins/hooks) | `test_upstream.py::test_surface_text_is_registered_and_prompts_build_for_every_domain` | upstream has a public surface registry |
| O6 | `core/schedule.py:480-720` `_run_one_mode`/`run_task`/`run_domain`: finals-only pool (`selection.py:93-105`, `del base`), a trivial selection at k=1 (`schedule.py:514`), library entries added whatever stages fell back | `run_round.py` `Round.run_task`, composed from upstream's `recursion.run_parallel`, `selection.run_selection(pool_kind="mixed")`, `selection.reflect_adoption` and `library.Library` unchanged | design section 7: the baseline stays in the selection pool; a fallen-back stage is visible and keeps the task out of the library; an infrastructure stop leaves a resumable record | `test_round.py` (whole recursion, baseline in the pool, fell-back exclusion, resume) | upstream offers a baseline-inclusive pool and a fell-back flag on the library |
| O7 | `config.py:178` `PROPOSER_CONCURRENCY = 2`, `config.py` `RUNS` (default `./runs` inside the checkout) | set before import by `upstream.load()` (`RSI1_IMPROVER_CONCURRENCY`, `HARNESS2_RUNS_DIR` in scratch) | keep run state out of any repository checkout; bound concurrent CLI sessions | `upstream.py` | never |

## Contract assumptions about the lab (code against `lab/brokerctl.py` as built)

`submit REQUEST.json` is idempotent by rid and refuses a key naming an answer, rubric or score; `status --json` lists `claimed`, `resultsReady`, `infraFailed` (it does not
list pending rids); `fetch DIR` pulls every ready bundle as `<rid>.tgz` (+ `.meta.json`) and every terminal failure as `<rid>.infra-failed.json`, then deletes them on the host.
`fetch` is therefore global: the adapter serialises it with a lock, shares one inbox, and archives a bundle after use. A bundle is a tar.gz of a bench-driver result folder
(`result.json`, `answer.md`, `transcript.json`, `run.json`, `files/`), at the top or under one directory. `lab/lane.py` is not built yet: if its bundle layout differs,
`DshAdapter._bundle_root` is the one place to change.
