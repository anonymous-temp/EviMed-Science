# Natural multi-turn statistical acceptance

These cases start with research questions, not selected functions. `cases.json`
asks the actual platform to choose a method, execute it, correct a grouping,
convert units, incorporate an additional file and continue a fitted model.
`build_fixtures.py` freezes synthetic subjects plus this suite's public WDBC CSV;
`fixture-sources.json` records their hashes. Never upload `judge.py`, bindings or
reference answers into an Agent workspace.

## Execution

Use the existing `evals/general-tasks/runner/harness.mjs` with the candidate
socket/profile, real control-plane model gateway, an isolated Postgres database
and throwaway local accounts. Its `HostKernelProvider` launches the actual pinned
DSH on the host: this is a real model/kernel test, **not** Docker-image or
production-deployment acceptance. Keep the provider key in the control-plane key
file, never in the DSH environment. Disable learning, evolution and LoopX for
these finite test cases. Enable the existing result-replay service if exercising
`research_calculate`; record unavailable services explicitly.

```bash
python live/build_fixtures.py
node live/run.mjs --case continuity --base http://127.0.0.1:48861 --data /tmp/analysis/data --out /tmp/analysis/results
node live/run.mjs --case correction --base http://127.0.0.1:48861 --data /tmp/analysis/data --out /tmp/analysis/results
node live/run.mjs --case prediction --base http://127.0.0.1:48861 --data /tmp/analysis/data --out /tmp/analysis/results
node live/run.mjs --case reconciliation --base http://127.0.0.1:48861 --data /tmp/analysis/data --out /tmp/analysis/results
node live/run.mjs --case cached-unit --base http://127.0.0.1:48861 --data /tmp/analysis/data --out /tmp/analysis/results
```

Run from `evals/statistical-analysis`. `--data` is the local harness's data root;
the driver intentionally refuses remote hosts. Each turn uploads only its own
new inputs, uses the same unbound session, dispatches as automated, and preserves
the transcript and complete bounded workspace before the next turn. Cancellation
must settle before capture; an unsettled run stays known to the account cleanup
hook. Accounts are deleted in `finally`. An uncertain registration is recorded
as an unconfirmed cleanup, not a successful deletion.

The first report request should route to statistical analysis. Contextual
follow-ups may legitimately route to ordinary conversation; a route is not a
replacement for execution and artifact evidence. `executionComplete` means only
the turns ended and were captured. `agentEvidenceComplete` additionally checks
basic execution/files and the presence of prior analysis on continuation. Neither
means numerical or scientific acceptance. Record raw verdicts before independent
review; do not edit them to look successful.

Resume deliberately remains `complete: false` / `reuseVerification:
requires-independent-judge` even when its structural files exist. A successful
shell call may have refitted the model. Independently compare the supplied
archive's original file hashes, the snapshots before/after the continuation and
the actual tool transcript/new continuation code. Only that separate state
verdict can establish selective reuse. A pending independent verdict is not a
failure of the platform run and must not cause the Agent to recompute.

## Independent checks

After inspecting the returned files, create evaluator-owned bindings from result
keys to quantities. The bindings say which population and estimate a field
means; they never redefine the reference answer. Run:

```bash
python live/judge.py --artifacts /tmp/analysis/results/CASE-TIMESTAMP --bindings bindings.json --out numerical-verdict.json
```

Each turn binding has `index`, `referenceKind` (`comparison` or `prediction`),
`results`, `required` reference names and `bindings` (reference, typed JSON
source path, absolute/relative rounding tolerance). Comparison options are
`scale`, `supplement`, `corrected`; correction verifies identical patients and
measurements with only the group labels swapped. Prediction also names a
captured CSV in `predictions` and its `predictionOptions` (`id_column`,
`source_id_column`, `probability_column`, optional `threshold`); its labels come
from frozen WDBC data, where 0 is malignant. Select the held-out rows explicitly
and preserve the selection in the evaluator evidence. An unknown source ID or
duplicate prediction is a failure.

The verdict binds artifacts, predictions, fixtures, bindings and judge code by
SHA-256, and records numerical-library versions. Compare every requested primary
quantity, not just one convenient metric. Inspect the actual code/split for
leakage, missingness and exclusions; verify report and reply population labels.
Replay generated scripts or serialized models only in a separate local sandbox
without provider keys or network access, on a copy of the public fixtures.
Record any rounding sensitivity and unavailable diagnostic honestly.

For continuity, compare unchanged input/model/split hashes, old and new result
values, and execution history. A unit change scales the mean difference and
interval, not its p value or group counts. The supplement has 101 raw rows,
100 distinct synthetic patients and 98 complete outcomes after one repeated
patient and two missing outcomes. For the threshold follow-up, model bytes and
predicted probabilities must remain unchanged; only the requested operating point
and report should change. Checkers diagnose defects; they do not suppress the
platform's useful partial deliveries.
