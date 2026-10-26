# Scheduled Tasks Correction Implementation Plan

> **For agentic workers:** Use the subagent-driven-development workflow for the independent ownership areas below. The owner approved implementation of the preceding audit in this conversation. Commit only after integrated verification and review; do not deploy.

**Goal:** Resolve all thirteen scheduled-task audit findings and close the associated interaction, unattended-execution and local acceptance gaps.

**Architecture:** Retain the domain calendar, control-plane durable queue, account/project boundaries and DSH executor. Keep user intent stable across failures, make task/job/execution state consistent, and expose truthful schedule, result and recovery facts through both UI and conversation tools.

**Tech Stack:** Node ESM, PostgreSQL, React/TypeScript, Python MCP, DSH at the existing repository pin.

## Scope and ownership

- Backend owner: `autopilotService.mjs`, `autopilotWorker.mjs`, `autopilotOutcome.mjs`, `autopilotNextAction.mjs`, `autopilotRoutes.mjs`, associated tests. F01/F02/F05/F07/F11 and server history pagination for F13. Coordinate creation transactions/material interfaces with the gateway owner; no parallel edits to the service file.
- Gateway owner: `taskToolsGateway.mjs`, a narrow task-command helper if needed, `runtime/mcp/evimed-research/task_tools.py`, tool registration and tests. F03/F06/F12, durable material references, truthful paused duplicate handling. Coordinate shared service hooks explicitly.
- Frontend owner: `AutopilotPage`, `TaskList`, `TaskForm`, `TaskDialog`, `TaskBar`, `TaskPane`, `SessionFrameHost`, `autopilotClient` and associated tests. F08/F09/F10/F13, exact first-occurrence preview, understandable timezone, ordinary task material access and result feedback.
- Coordinator: feature availability in `server.mjs`/`runtimeManager.mjs` (F04), unattended/recursive-scheduling runtime boundaries, isolated PostgreSQL and real-kernel acceptance, integrated quality checks, review and final commit.

## Execution sequence

- [x] Capture a failing behavioral regression for each assigned correctness finding, using the existing isolated reproductions as inputs rather than implementation-shaped assertions.
- [x] Keep routine intent available only to the same intended ordinary job after transient failures; preserve legitimate exploratory research behavior and explicit resume.
- [x] Make retry-pending executions cancellable and settle skipped jobs/episodes consistently. Verify pause/delete/cancel races, final-failure notification deduplication and once-only recovery.
- [x] Atomically deduplicate conversation task creation and quota admission within authenticated project scope. Return persisted state truthfully after a partial update, with retry safety.
- [x] Use the same edit boundary for schedule projections and dispatch. Retain timezone/DST behavior and publish cursor-based execution history with stable labels.
- [x] Disable scheduling admission/scans/workers coherently when the feature is off. Protect unattended runs from recursive scheduling and blocking questions without changing attended conversations.
- [x] Replace the empty split layout with an actionable first-use page; make examples populate a draft, not create tasks. Show the exact next occurrence and material association, with clear result destinations.
- [x] Give every task pane loading/unavailable/retry states and every row operation visible feedback. Support older execution navigation without misnumbering partial history.
- [x] Run focused unit, HTTP, MCP and component regressions, then real isolated PostgreSQL scheduling/concurrency/recovery tests.
- [x] Run desktop/mobile browser journeys against a local fixture; run bounded real-kernel unattended checks where locally available. No production writes or deployment.
- [x] Run applicable type, lint, build, source-secret, contract and broader regression checks. Obtain independent specification, code and security reviews; repair all actionable findings.
- [x] Record actual evidence and remaining external validation boundaries, stage only this task's files, and commit after verification. Do not push or deploy unless separately instructed.

## Core verification commands

```sh
cd OpenScience
node --test packages/domain/test/agendaSchedule.test.mjs apps/server/test/autopilotWorker.test.mjs apps/server/test/autopilotDispatchRecovery.test.mjs
node --test apps/server/test/taskToolsGateway.test.mjs apps/server/test/autopilotNextAction.test.mjs apps/server/test/autopilotOutcome.test.mjs
pnpm --filter @ai4s/web exec vitest run src/app/routes/AutopilotPage.test.tsx src/components/autopilot/TaskForm.test.tsx src/components/autopilot/TaskPane.test.tsx src/components/autopilot/taskPresentation.test.ts src/lib/autopilotClient.test.ts
pnpm typecheck:server
pnpm typecheck
pnpm audit:source-secrets
```

Use a private temporary PostgreSQL cluster and an `evimed_test*` database for integration tests, with explicit environment variables and cleanup. Do not reuse production or another worker's database. Preserve existing unrelated untracked files and the prior audit progress entry. All new evidence must identify its source revision and distinguish mocked, database, browser, kernel and model execution.


## Completed implementation and acceptance

All F01-F13 audit findings and the follow-up review findings are addressed. The correction keeps the existing scheduler and DSH execution architecture. Additional reviewed repairs cover connection-pool/migration lock ordering, stable intent on unchanged edits, durable outcome receipts, delayed cancellation identity, cancellation recovery after reload, per-request signed attendance independent of optional learning, and mandatory proof persistence before HTTP/mux forwarding.

Controller protocol 15 transports the public attendance verifier only. The API retains its signing secret. The runtime composition baseline was recorded from the actual pinned CLI and all eight production-ordered bundles; its only byte changes are the three attendance configuration fields. Kernel/package pins and dependency lockfiles were not changed.

Final verification in the local isolated environment:

- Web: 403 files, 5,041 tests passed; TypeScript and production Vite build passed.
- Domain: 1,216 passed; socket: 300 passed.
- Harness port: 370 standard checks passed; the eight optional native-client/Chromium checks were separately enabled and all passed. Native extension-manager tests use the pinned kernel's pnpm 11.7.0; workspace commands use pnpm 9.4.0. No repository dependency change was needed.
- Server scheduling, gateway, separate-process PostgreSQL admission, native UI and controller combination: 440 passed, zero skipped. RuntimeManager/native UI broad checks additionally passed; the PostgreSQL-native-fence case was included in the 440-check run.
- Python task tools: 24 passed. Server, web, domain, port and socket type/lint checks passed for the changed surfaces. Existing frontend warnings remain warnings; the build warns about existing large chunks.
- Generated capability/token/runtime inventory checks, source-secret audit, seam verification, whitespace check and 68 live-dump kernel invariants passed.
- Independent code/specification, TypeScript, Python and security reviewers found no remaining actionable issue after repair and re-review.

Real DSH + DeepSeek evidence (host-process provider with the production socket/profile, isolated PostgreSQL; not production deployment):

1. A future once-only task fired with the browser closed, produced `scheduled-check.txt` containing `17 + 25 = 42`, completed successfully and delivered its in-app notification.
2. A real native human conversation, with learning disabled, called `schedule_task` and then `update_task`. The stored record matched the requested 2026-10-26 10:00 Asia/Shanghai once-only schedule and changed calculation.
3. With the browser attached, a shared-runtime execution attempted exactly one `ask_user_question`. The preserved native tool result contains `unattended_question_unavailable`; the run continued, wrote `browser-open-check.txt` with `11+31 = 42`, completed and notified. The episode records `interactive: true`.
4. A human then continued that same scheduled-task conversation. The native question card appeared, accepted the choice and completed with the selected color. Attendance did not remain stuck on the prior unattended run.
5. Actual desktop and 390px browser inspection covered first use, creation, schedule preview, pause, native conversation and result/history controls. A paused detail's missing state label found in this walk was corrected and regression-tested.

Local evidence is retained under `outputs/audit/reports/scheduled-tasks-20261025/`; raw runtime logs and credentials are not committed. No production task, external messaging channel or deployment was changed. Production rollout validation remains a deployment activity; this work ends with a reviewed local commit. A future release must ship API, controller protocol 15 and runtime image together.

The supplemental serialized controller/cloud compatibility group passed 95 checks; three opt-in disposable-container/evolution isolation checks remained disabled. Their implementation was not changed by this task (only protocol-version assertions were updated). The core scheduling/database/native-kernel acceptance above ran directly without skips. Local test apps and their future schedules were stopped after evidence capture.

## UI acceptance handoff — 2026-10-26

The product-specific requirements below are transferred from design specification v3.0 to this module authority. They are acceptance requirements, not a claim that pending product implementation has shipped. Shared component, state, ownership and proof rules are maintained in [Frontend Design System v3.1](../../../OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md). Later explicit owner decisions update this plan without creating another design-system copy of the product scope.

Schedules display instruction, scope, timezone, recurrence and next occurrence before enabling. Distinguish enabled/paused, last execution, failure, waiting for input and next run. The task opens its own conversation and useful results. Creation examples are optional and editable; one primary action states that creation also enables. Do not claim a successful recurring execution from a dialog screenshot.
