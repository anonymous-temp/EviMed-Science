# GEO Connected Journey Implementation Plan

> **For agentic workers:** Use subagent-driven-development with a bounded team: one implementation worker, root integration, and independent specification then quality review. Do not deploy.

**Goal:** Connect project discovery, the project workbench and the existing DSH conversation into a task-scoped journey, and revise the installed 51-skill private method pack to the current platform contract.

**Architecture:** Existing projects, steps, question sets, rounds, runs, article versions and authorization remain authoritative. A shared pure workflow projection derives requested scope and actual dependencies; the frontend projects current work and next actions without another state database or composer. The private pack is revised as an independently versioned artifact, never published as source in the public repository.

**Tech Stack:** React/TypeScript, Node ESM, shared domain functions, native DSH, PostgreSQL, private Markdown/Python method package.

## Work and ownership

- [x] W1 Root: shared `packages/domain/src/geoWorkflow.mjs`, exports/tests; orchestrator consumes it. Remove implicit full-program escalation from a completed question set. Preserve explicit single-step prerequisites and legacy queued work. Test content/evidence-only, monitoring/diagnosis-only, full explicit programme, no-request no-dispatch.
- [x] W2 UI worker: shared stage-aware journey projection; project list/preview, project shell, overview and native options use it. Fix default-tier first use; keep partial/unknown/error data. Link preview steps and actual runs; make draft discussion versus execution clear; keep native composer and eight result destinations. Single permission/pause logic for failed/empty/NeedsYou/settings. Use real dependencies from W1. Three initial task intents and contextual continuation replace six equal generic starters. Tests cover empty/partial/queued/failed/paused/read-only/history and stale scope.
- [x] W3 Root: remove external-AI outcome guarantees and 98% mandatory target admission; retain explicit targets as goals, measurement uncertainty, historical reads and scoped numerical controls. Align four capabilities and `geo-drug-value`, generated copies and tool catalogue. No forced complete programme for unclear intent; no batch probing inside model turns; evidence-unknown remains distinct from wrong.
- [x] W4 Root: retrieve full installed private pack read-only; verify 51 entries against the audit. Correct each method body and shared references, consolidate orchestration under the platform, move engineering/export functions to internal or explicit modes without losing reusable methods. Build a private release archive with hash, inventory and per-skill change ledger. Public code verifies its version/contract without embedding proprietary text. Do not change the running service.
- [x] W5 Root: local end-to-end fixture using the real app/native composer and isolated database. Cover new product, existing question import and diagnosis, existing manuscript revision, single monitoring without distribution, partial provider failure, failed run with retained output, paused/read-only and result-to-conversation-to-result. Distinguish mocked external providers from actual DSH/model execution. Use bounded live-model cases only with owned throwaway local scope, retain receipts and do not touch protected earlier audit runs.
- [x] W6 Independent Sol/Terra reviews: specification first, quality second; fix concrete HIGH/MEDIUM and recheck. Run focused and combined suites, type/lint/build, seam/generated-package/credential checks. Publish code only after final local checks. Push feature branch; no merge or deployment unless separately requested.

## Acceptance invariants

1. Opening the same project from any surface retains its identity, current task, session and result scope.
2. Default configuration is not evidence of work; no-data, pending, partial, failed, stale and measured zero are distinct.
3. Every action states whether it opens an unsent draft, starts a task, changes project state or publishes externally.
4. Only explicitly requested steps and their minimal dependencies run. Locking a question set alone does not request content, distribution or recurrence.
5. Background run identity, actual errors and retained outputs are reachable; normal primary conversation history is not fabricated.
6. A snapshot or report never becomes a source of permission. Roles and paused state constrain every action consistently.
7. No skill may invent measurements, silently change denominators, guarantee external AI behavior or withhold readable work because of advisory findings.
8. Private method source and provider credentials stay out of Git. Build receipts establish what the future image would carry; they do not claim online activation.

## Progress and evidence

Baseline: origin/main `8c9c8e52e`. Prior audit: private `geo-audit-20261031` directory; installed method package 3.0.1 (51 skills), runtime/preset bodies identical. Product source changes and private package release remain separately verifiable.


## Review corrections incorporated

- Confirmed monitoring scope is distinct from historical requested flags. Saved contracts cannot silently replace the selected engines. Automatic confirmation creation rechecks authorization while locking the project row in the round/jobs transaction.
- Actual accepted rounds, not the monitoring daemon flag, determine running state. List, workbench and conversation share this projection; completed historical weeks do not hide a new active round.
- Orchestrator insight prepares only its commissioned scope and never starts a second baseline. The native attended path retains explicit one-shot starts.
- An empty engine/pool descriptor is not an observation. The zero/no-data tests use the actual server envelope.
- Native conversation panes retain their intended height. Equivalent scope descriptors retain the same resident frame; invalid supplied scopes remain on the restricted module route.
- Private release 3.1.0 retains 51 method names, with active method/reference content and a section-preservation ledger. No proprietary source enters Git. Public image recipes reject a stale private base pack.

## Local verification receipts

Evidence is retained outside Git under `outputs/audit/geo-connected-journey-20261031/` and the named local test logs. These receipts do not attest production deployment.

- GEO web suite: 900 tests across 70 files passed. Subsequent focused native/frame/status suite: 154 passed.
- Domain/bridge/command/method-pack contract suite: 190 passed. Private pack refresh and release binding: 12 passed.
- PostgreSQL suites used isolated databases on the existing local fixture: question imports/authorization races 24, measurements/parsing 52, orchestration 39; related members, routes, writes, views and native composition suites passed separately.
- Public capabilities, skill-package digests, tool graph and kernel seam checks passed. Server/web/domain/port type and lint checks, API-enabled web build, and credential audit passed before the final native-context correction.
- Private method package: 31 package checks, 16 helper regressions, ZIP CRC/vendor and exact tree/hash verification passed. Independent specification and Python helper reviews passed. This does not assert that every clinical method was run on a real product.

## Live-path findings and final bounded acceptance

The real DSH + DeepSeek fixture uncovered an authenticated native-context gap: an ordinary new GEO primary had no selected-object context, so its module-only capabilities and write tools were absent. The model could create a local file but could not update the project. This was corrected at the authenticated native route boundary. Only the original server-admitted request supplies module authority; it is revalidated, frozen, and granted to the current root turn. Forged copies, cross-project reuse, revoked membership and next-turn leakage are covered by regression tests. Independent review found no remaining HIGH/MEDIUM in this change.

The browser fixture also exhibited first-document loads timing out before the native bridge booted, with retry succeeding. HTTP 200 on the document alone does not qualify the browser path. A separate in-app browser opened the same conversation on its first attempt, restored the composer after a refresh in 1.454 seconds, and opened a new project without retry. The Chrome-specific observation remains a compatibility follow-up; its cause was not established and is not asserted fixed.


Final live checks used a disposable local PostgreSQL database, the actual pinned DSH kernel and actual DeepSeek calls through the control-plane gateway. The provider boundary launched a local process instead of Docker; this does not qualify production container isolation or online connectors. Earlier fixture failures (missing routing endpoint, old absolute module symlink, wrong token audience and an undersized run budget) were recorded, corrected and not counted as passes.

The successful case wrote two synthetic product fields from the native composer, read them back, displayed them in the workbench and project preview, returned to the same primary session and resident frame, and changed only the requested brand field in a second turn. API readback confirmed the change and unchanged generic name. All eight requested flags remained false; PostgreSQL held zero measurement rounds and zero probe jobs. No external publication or production data was touched. Article-version, question-import, partial-provider, role, pause and monitoring-race paths are covered by focused component/HTTP/PostgreSQL tests; they were not all rerun as paid end-to-end model campaigns.

Final additional regression groups: socket/native route 134, native inputs 26, full composition repair 4, and HTTP/MUX transport/composition 15, all passed without skips. Public capabilities were versioned to geo-insight 1.4.0, geo-content 2.4.0, geo-strategy 1.3.0 and geo-proposal 1.2.0; generated manifests and package digests agree. Commit/push receipts are recorded separately at handoff. No deployment is authorized for this delivery.
