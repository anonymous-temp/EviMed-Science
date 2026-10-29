# GEO V3 local development checkpoint — 2026-10-25

> Historical checkpoint: later main-branch repairs and the current local integration evidence are recorded in [GEO integration follow-up](GEO_INTEGRATION_FOLLOWUP_2026-10-27.md). The unfinished items below describe the state on 2026-10-25, not the current tree.

## Delivery boundary

The owner requested an immediate commit and push of the implemented work, with remaining gaps listed separately. This is a development-branch checkpoint, not a release qualification or an assertion that every planned item has passed. Online deployment was explicitly cancelled. No production deployment is part of this checkpoint.

Branch: `codex/geo-v3-complete-20261023`. The base before this checkpoint was `71564b2ca83ea96641cdb790eb2fc00620ed9936`.

## Implemented in this checkpoint

- Evidence/journey, claim applicability, error distributions, publication execution, project finance and historical observation analyses complete the registered V01–V27 catalogue. V28 is the common selected export/conversation action, not another page.
- Scope, exact membership, missing states, historical versions and frozen native inputs share the selected-analysis contract. Large retained contexts use bounded object pages and spreadsheet continuation rows. Five export formats retain the same source values and materials.
- V15 separates retained error observations, actual recurrence, assessment changes, submitted tasks, current handling and administrative history. Unknown observation times remain unknown. V27 shows actual business events beside metric-specific sample intervals; before/after association is not a causal claim. M-20 uses its complete deduplicated ask population, including unpaired and suspect asks.
- Historical question-version and assessment-detail actions retain the addressed native conversation. Native session creation, accepted inputs, actor attribution and context selection reuse the existing DSH conversation and composer.
- GEO knowledge, capsule, memory and learning paths carry explicit project context and provenance. Source-change signals and signal contexts retain exact historical profiles. Publication and pruning use a shared transaction lock, with post-commit notification; equivalent import paths and physical symlinks do not bypass the GEO import boundary.
- Runtime cold callers coalesce before asynchronous policy checks, with current per-caller authorization. Python package verification resolves directory aliases and preserves isolated `-I` execution. The outstanding rejected-admission cleanup defect below is not claimed fixed.
- Account export explicitly describes the nonportable GEO context/signal omissions; it does not export runtime authority or claim a complete portable GEO account archive. Reader-facing notices, controller protocol checks, native-memory fixtures and handoff observers are aligned with the implemented contracts.

## Local evidence and limits

These are separate focused runs, not one additive overall test total:

| Check | Observed result |
| --- | --- |
| Current server and web TypeScript/checkJs | Passed immediately before checkpoint preparation |
| Source credential audit | Passed; no hard-coded credentials detected |
| Web production build | Passed; existing large-chunk warning remains |
| Generated skill-package and tool-graph checks | Regenerated using canonical builders; 21/21 tests passed |
| F4 historical analysis | 17/17 Node tests, including two disposable PostgreSQL scenarios and a 27-view export/native catalogue; 59/59 focused React tests |
| F4 actual exports | 20 CSV/XLSX/DOCX/PDF/HTML artifacts read back, including complete retained materials and spreadsheet continuation rows |
| GEO Python adapter | 34/34 focused tests passed |
| Historical-profile retention and import-boundary repairs | Author 106/106; independent specification 44/44 and quality 65/65, zero skips |
| Runtime and package-verifier repair snapshot | 191/191 focused tests passed; subsequent independent failure-path probing found the open defect below |
| Account export, notices and error classification | 40 + 2 focused checks passed |
| Native-memory fixtures | 12 unit tests, 15 transfer PostgreSQL tests and 9 native-memory PostgreSQL tests passed |
| Controller and handoff fixtures | 52 controller checks, 2 protocol checks and 2 handoff checks passed |
| Vector and database-isolation rerun | 71/71 across eight independently isolated PostgreSQL suites passed |
| Composition fixture | 42/43 on full rerun; the remaining account-epoch fixture assertion was repaired and its targeted rerun passed 1/1; no later full-file pass claimed |

Local execution used macOS and Node 24.13.0. Some tests use synthetic providers, engine/session doubles or local HTTP servers; those do not certify installed DSH/OpenViking behavior, Linux/Node 22 containment, clinical validity, or external consumer-AI performance. Detailed local receipts are retained under the ignored `outputs/audit/geo-v3-execution-20261023/` tree and are not published as source.

## Remaining work

### P0 — runtime cleanup after a rejected admission

A real PostgreSQL deferred foreign-key COMMIT failure (`23503`) can reject startup after a runtime has been created. The current waiting `stop()` catches the rejected startup promise and returns without closing that captured resource. A no-explicit-stop control also leaves the failed-admission runtime live. Preserve any replacement runtime while closing the exact failed attempt, and await cleanup before reporting stop completion. The previous early-stop timing defect is repaired; this later failure path remains open. Regression coverage must include real COMMIT failure, no explicit stop, concurrent stop, replacement identity and generation/guard changes.

### P1 — finish independent reviews

F4 specification review is complete, but its final independent quality review was interrupted by the model usage limit. The 12-file account-export/notice/fixture batch also has specification approval but an interrupted quality review. The final F4 Python delta needs its dedicated quality review. Runtime cleanup still requires repair, specification recheck and fresh quality review. No interrupted review is recorded as approval.

### P1 — finish remaining integration fixtures and full regression

- Adapt the older native GEO routing/identity fixtures to explicit primary-conversation opening, real context authority and current request binding. Preserve their queue/steer, routing and negative-authority assertions.
- Update programme-run pagination expectations, and seed complete rival observation provenance instead of relying on aggregate-only fixtures. Retain aggregate-only unknown-state controls.
- Rerun the entire relevant backend/frontend/Python and generated-contract gates on the final combined tree. The earlier broad server diagnostic had 114 failures across environment, stale fixtures, shared-database contamination and real integration defects; several groups are now closed, but a final full green run has not been established.
- Qualify Linux-only procfs/coreutils cases, the actual immutable Cowork preparation artifact and R-backed numerical suites in their appropriate local environments. Do not treat unsupported local prerequisites as passed tests.

### P1 — final ordinary-account browser and retained-output checks

Run the current frontend/backend through all eight visible GEO steps, filters, exact-member drawers, historical navigation, source-page-to-scoped-plan navigation and outsider denial. The prepared main-plane recipe deliberately refuses kernel/provider/background work; this final browser lane has not been executed. Existing N09 native output is preserved, but final combined-candidate import-only recovery and visible scoped-plan acceptance remain separate. Do not regenerate the protected historical paid run.

### P1 — integrate the newer remote main branch

The last fetched `origin/main` is `98fedc73d` and has not been merged into this checkpoint. Relative to the common ancestor it changes 474 files, with 32 overlapping the current work. Preserve both the newer frontier/knowledge/runtime changes and this GEO work, resolve overlaps, and rerun affected checks before any main-branch merge. Pushing this development branch does not imply it contains those newer main changes.

### P2 — complete installed OpenViking fixture qualification

The exact pinned image was started locally with network disabled and read-only mounts; the owned container was removed and the eight preexisting containers were unchanged. The harness health probe failed, so transport/ACL/configuration-observer checks did not run. Exact image source shows the probe supplied trusted-identity headers without the API key; the entrypoint used a genuinely anonymous health request. Correct that fixture contract and preserve bounded failure diagnostics before using a new single-use snapshot. Startup logs also contain embedding retries: provider-attempt count is unknown, not zero. Do not describe this as a completed native-memory or semantic compilation acceptance.

### Deferred by the owner

The external consumer-AI/social-collection host `43.248.117.249` remains deferred. It was not repaired or revalidated here. Online deployment is cancelled, not a pending automatic action.

## Receipt fixture decision

The pre-dispatch scratch-file case was timing-sensitive because filesystem mtime has sub-millisecond precision while run start has millisecond precision. Its fixture now places that preexisting file unambiguously before the run, preserving the exact receipt assertion. Production ordinary-file discovery was not restricted. This is a fixture-premise correction, not a new claim that arbitrary files are clinically verified.
