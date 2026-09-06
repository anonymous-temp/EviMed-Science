# Full SaaS Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver and publish the complete individual-researcher SaaS approved in the September 5 production review, retaining the native DSH Web UI and plugin composition.

**Architecture:** Keep the existing EviMed control plane, per-project DSH containers, native browser application, domain validators and specialist engines. Complete the transport policy, durable product services and native-client integration before enabling the corresponding external workflows. Use one persisted state and one acceptance contract per feature; a schema, mock or disabled page never counts as delivery.

**Tech Stack:** Node ESM/checkJs, React/TypeScript, PostgreSQL, DSH 0.1.2-rc.1, Docker, Python specialists, MemOS, OpenList and MinerU.

## Authorized scope and execution

The user approved implementation and production publication of the full reviewed scope. Do not repeat design or release permission prompts. Ask only for missing operator resources that cannot be discovered, and continue independent work. The original July/Gitee worktree is preserved; implementation occurs in the clean GitHub checkout on `codex/full-saas-delivery-20260905`.

The full requirement register is the September 5 production review, with IDs BASE01–QA02. Its rows remain open until their actual acceptance evidence exists, except the user's explicit first-release exclusions below. This file tracks implementation batches; the existing August design supplies detailed feature contracts. Production configuration, customer data and credentials must be preserved.

**First-release exclusions, explicitly confirmed by the user on September 5:** retain the public IP address; do not require a domain, off-host backup or an actual payment channel. Keep local encrypted backup/restore and durable usage/budget controls in scope. Do not enable payment collection or introduce external-storage requirements as blockers for this release.

## Batch 1: native UI policy parity (UI02, part of UI05/ECO04/BILL02)

**Files:**
- Modify `OpenScience/apps/server/src/runtimeUiServer.mjs` to validate origins and supply one request/frame authorization policy.
- Modify `OpenScience/apps/server/src/runtimeManager.mjs` only at its browser WebSocket proxy, replacing unexamined byte tunneling with a bounded message relay.
- Create `OpenScience/apps/server/src/runtimeUiMuxProxy.mjs` for WebSocket lifecycle and frame policy.
- Create `OpenScience/apps/server/test/runtimeUiSecurity.test.mjs` for real local HTTP/WebSocket fixtures; extend existing UI proxy tests where needed.
- Modify server dependencies and lockfile only if a supported WebSocket package is required.

- [x] Write and execute failing integration tests before production changes. The tests must exercise real sockets and show: unauthenticated upgrade refused; foreign/missing Origin refused in production; `settings/describe` and every forbidden namespace denied inside `open` frames; `session/prompt` refused when spend admission fails; allowed read and cancel frames still work; logout revokes an established socket; excessive message size and connection count are bounded.

Representative assertion pattern (fixture identity is local test data):

```js
const socket = await openUiSocket({ origin: allowedUiOrigin, cookie: sessionCookie });
socket.send(JSON.stringify({ type: 'open', streamId: 'blocked', endpoint: 'settings/describe', payload: { args: {} } }));
assert.equal((await nextFrame(socket)).error.code, 'runtime_ui_method_denied');
assert.equal(upstreamCalls.includes('settings/describe'), false);
```

- [x] Commit the executed RED reproducer on the active branch.
- [x] Implement a single endpoint policy used by HTTP and WebSocket, retaining native DSH frame envelopes and named per-stream errors. The relay must preserve independent cancel/end streams, reject malformed frames, close on failed session revalidation, retain the project resolved at upgrade, apply bounded payload/connection/backpressure controls and clean up both peers on every close/failure. Do not expose raw upstream cookies or provider keys.
- [x] Run `node --test apps/server/test/runtimeUiSecurity.test.mjs` and the existing runtime proxy tests; run server lint and checkJs typecheck. Commit GREEN.
- [x] Perform independent specification review, then code/security quality review; resolve findings and retain evidence.

## Batch 2: primary UI identity and delivery flow (UI01, UI03–UI06)

- [ ] Establish a standard external HTTPS route for the native UI, preserving its absolute-URL semantics. Prefer a managed domain once supplied; do not create an unauthenticated kernel endpoint.
- [ ] Replace mutable host-wide project selection with signed per-frame/connection identity, including multitab isolation and reconnect tests.
- [ ] Connect shell deep links, new-task and capability-start actions to exact native DSH session identity through supported native client integration.
- [ ] Record and accept every native user turn as a run, including late adoption, repeat turns, cancellation, repair, disconnection and restart.
- [ ] Verify using real browser sessions and a real isolated kernel. A fallback screenshot does not certify the primary UI.

## Remaining independently deliverable batches

- [ ] **Batch 3 — durable SaaS state:** BASE01/02, ACCT01/02, BILL01/02 and NOTICE01. Add migrations and scoped repositories for usage, reservations/settlements, notifications and customer lifecycle. Enforce real limits across all entry paths. Keep pricing and payment-provider decisions explicit.
- [ ] **Batch 4 — sources and ingestion:** ING01–ING06. Implement OpenList/local/upload connectors, source/version/unit ledgers, MinerU/fallback workers, coverage audits, materialization and the user tidying surface.
- [ ] **Batch 5 — memory and capsules:** MEM01–MEM06. Integrate MemOS through real endpoint contracts; persist capsules and versions; connect runtime recall/note, methods and portable import/export; implement evidence-based feedback and user controls.
- [ ] **Batch 6 — proactive research:** AUTO01–AUTO05. Implement persistent agenda/episode scheduling and bounded allocation, reuse ordinary research runs and gates, connect independent verification, digest and decision feedback, and test every stopping condition.
- [ ] **Batch 7 — capability and ecosystem delivery:** ECO01–ECO05 and CAP01–CAP06. Unify capability discovery, complete genuine bundle/client lifecycle, establish native plugin compatibility tests and execute full scientific positive/negative/combined tasks.
- [ ] **Batch 8 — production readiness and release:** BILL03, OPS01–OPS04, QA01/02. Complete the explicitly nonpaid first-release contract, local encrypted restoration, alert delivery, resource acceptance, clean CI and full customer journeys. Build immutable images and manifests, back up before migrations, stage the candidate, verify, publish, and verify again through public customer routes.

Each remaining batch receives its concrete file/API/test plan immediately before implementation, using the approved feature contracts and the state delivered by preceding batches. Do not invent successful external integration evidence while waiting for an operator account, endpoint or credential.

## Completion bookkeeping

- [x] Production source and current GitHub main inspected; base revision `8ce276f2c4ea820d9edc6b15b8f84f885cbfdaa7`.
- [x] Clean implementation branch created; original local edits preserved.
- [x] User confirmed public IP, local backup and nonpaid first release; domain, off-host storage and payment integrations are deferred.
- [ ] All 48 acceptance rows linked to implemented code and fresh evidence.
- [ ] Full reviewed release committed and pushed.
- [ ] Immutable production release deployed and public full-path acceptance retained.

## Reconciled acceptance register — September 6

This register supersedes the stale implementation checkboxes above for status reporting. Baseline: production `evimed-20260906-f041aa0`, source `f041aa0361dccacbcfc2db1cb5656d00d2559f5d`. `Implemented` describes source coverage only; a row is not accepted until its complete customer-path evidence exists. No completion percentage is inferred from unit-test counts or readiness. Historical source audits remain reference evidence, not current acceptance results.

Fresh external Chrome evidence is retained under the workspace's ignored `outputs/audit/reports/2026-09-06-customer-journeys/`: registration and the real native UI loaded, the first native turn succeeded, a second native turn answered but produced no separate run, and reopening the session in a second frame retained the transcript. The browser was run directly, without the failing automation proxy. The latest retained API E2E exited 1 with a missing artifact; no retry erases that result.

| ID | Source status | Verified evidence or remaining acceptance |
| --- | --- | --- |
| BASE01 | Implemented | Isolated GitHub worktree and source revision identified; original work preserved. Generated test directories still require cleanup. |
| BASE02 | Partial | Root workflows exist; successful remote push and current remote CI remain unproven. |
| UI01 | Implemented | External Chrome loaded the authenticated native DSH frame on 8443 after registration; retain this evidence in the final release run. |
| UI02 | Implemented | Shared HTTP/mux authorization exists; real native denial, logout and spend-boundary acceptance remains. |
| UI03 | Implemented | Signed per-frame binding exists; second-frame reopening works; distinct-project multitab/reconnect acceptance remains. |
| UI04 | Implemented | External saved-session reopening retained the transcript; capability-start, back/forward and project switching remain. |
| UI05 | Broken in production | Two native user turns produced one run ledger entry. Fix per-turn identity, routing, monitoring and replay handling before accepting the primary surface. |
| UI06 | Partial | Native conversation and run side panel exist; synchronized evidence/files/revisions, mobile and keyboard journeys remain. |
| ECO01 | Partial | Pin/seam/support manifests exist; publish and verify the actual supported host/client/tool/skill lifecycle. |
| ECO02 | Partial | One citation bundle is installed; three candidates are explicitly rejected/incompatible. Verify shipped assets and tools; do not claim all candidates work. |
| ECO03 | Missing | Immutable operator-built bundles do not provide the designed customer configuration, enable/disable, update/removal and rollback lifecycle. |
| ECO04 | Partial | Fixed composition is confined; prove isolation through the implemented plugin lifecycle once available. |
| ECO05 | Partial | Upstream matrix workflow exists; operated cadence, migrations and rollback evidence remain. |
| CAP01 | Implemented | Canonical capability catalog is unified in source; verify every visible launch through the native surface. |
| CAP02 | Partial | Capability contracts and engines exist; retain current scientific positive/insufficient-evidence/failure outcomes, including the separate published-paper benchmark. |
| CAP03 | Partial | Plan/delegation/repair primitives exist; mixed-capability delivery and preservation of accepted outputs remain unaccepted. |
| CAP04 | Partial | Bounded screening/review exists; screening writes its ledger after all waves and lacks durable mid-run resume. |
| CAP05 | Partial | Adapter/source readiness is green; current source/data correctness and external credential-dependent capabilities remain distinct gates. |
| CAP06 | Partial | Exporters and contracts exist; actual office-file rendering, source/code/data provenance and clean reproduction remain. |
| ING01 | Partial | OpenList is connected with scoped browse/import; customer connection lifecycle and incremental change detection remain. |
| ING02 | Partial | Source fingerprints, versions, retries and cancellation exist; source-delete enqueues a job with no consumer. Resumable upload/local connector delivery remains. |
| ING03 | Partial | MinerU service is deployed and healthy; real document, table, formula and fallback acceptance remains. |
| ING04 | Partial | Parser units are recorded; declared analysis depth does not change extraction. Typed understanding, methods and merge/materialization remain. |
| ING05 | Partial | Physical unit counts exist; parser-failure ratio is not a question-based omission audit. Reprocessing/version coverage remains. |
| ING06 | Partial | Tidying UI exists; meaningful depth, automatic progress and understanding revision flow remain. |
| MEM01 | Partial | MemOS live write/recall/delete contract previously passed; old Memos and capsule state need end-to-end ownership and lifecycle acceptance. |
| MEM02 | Broken in production | Web derives a capsule endpoint, but the controller rebuilds the launch plan without it and disables recall/note tools. Fix the non-secret launch contract. |
| MEM03 | Implemented | Encrypted capsule transfer and candidate/activation/revocation APIs exist; customer export/import/revocation journey remains. |
| MEM04 | Partial | Evidence-backed entries and lifecycle exist; conflict/decay/promotion/consolidation and five-layer collaboration remain. |
| MEM05 | Missing | CRUD and extraction do not implement contextual feedback learning and held-out personalization evaluation. |
| MEM06 | Partial | History API and method exports exist; timeline, method-as-skill publication and run-version traceability remain. |
| AUTO01 | Partial | Durable agendas/leased episodes exist; actual restart and coordinated scheduling acceptance remains. |
| AUTO02 | Partial | Spend caps exist; daily task choice is a hash, not a research-state and remaining-budget allocation plan. |
| AUTO03 | Partial | Ordinary run gates and artifact binding exist; independent validation episodes and frozen analysis-plan execution remain. |
| AUTO04 | Broken integration | Digest source type is rejected by NotificationService; decisions do not affect later agendas and viewing does not update activity. |
| AUTO05 | Partial | Cancel/budget/lease controls exist; inactivity is checked after work rather than before spending, and digest-open activity is not updated. |
| BILL01 | Partial | Durable model reservations/settlements and uncertain states exist; complete resource accounting and provider reconciliation remain. |
| BILL02 | Partial | Per-request durable admission exists; all native/specialist/background paths need real concurrent acceptance. |
| BILL03 | Deferred by user | Actual payment is excluded. Nonpaid scope and enforced customer allowances remain required. |
| NOTICE01 | Partial | Durable inbox exists; digest source, business actions and due-action effects must connect to their owning workflows. |
| ACCT01 | Broken export; partial lifecycle | External registration and tenant identity succeeded. Account export returns 403 `path_forbidden` after native startup because archive collection traverses the kernel's generated dependency symlinks; exclude runtime installation/credentials and retain scoped customer data. Deletion/recovery/support/terms remain. |
| ACCT02 | Missing | Personal account UI does not implement a scoped operator tenant-support console. |
| OPS01 | Partial; off-host deferred | Local encrypted restore previously passed for 2,827 files. Confirm complete coverage of all newly added authoritative state; off-host custody alone is excluded. |
| OPS02 | Partial | Online host preflight delivered a synthetic resolved alert; independent host-loss and operational response acceptance remains. |
| OPS03 | Partial | Runtime quotas exist; current host disk is 94% full, with about 12 GB free. Bound test/runtime work and verify service capacity/recovery. |
| OPS04 | Partial | External native loading is now observed once; continuous browser/WS and certificate lifecycle acceptance remains. |
| QA01 | Not accepted | Latest retained complete API E2E failed; native second-turn defect reproduced. No aggregate pass claim. |
| QA02 | In progress | This register reconciles all 48 rows; keep code state, deployed revision and actual evidence separate after each batch. |

### Execution order after the global review

1. Restore primary customer correctness: controller-to-runtime capsule wiring; native per-turn ledger/contract lifecycle; bounded native browser regression with preserved failure evidence.
2. Close cross-service state loops: digest/inbox integration, decisions and activity before spend, source deletion propagation. Test real service pairs rather than permissive mocks.
3. Complete source understanding and memory workflows against the approved design, including effective depth, omission audit, feedback and methods.
4. Complete supported plugin lifecycle and capability/reproducibility acceptance, incorporating separately owned scientific benchmark outcomes.
5. Finish account/support, capacity and full-stack restore acceptance; push/CI and one reproducible production cutover with final customer-path evidence.

Do not rerun a failed whole-product model journey without a new diagnostic hypothesis. Persist release identity, run/session IDs, terminal outcome and artifacts before cleanup; report infrastructure failures, valid evidence insufficiency and scientific-quality failures separately. Deterministic artifact movement/registration should not depend on whether a model remembers to copy a file. Coordinate any production restart with the separate published-paper evaluation task before cutover.

The separate published-paper evaluation reports `dsh-cite` Crossref network failures while managed literature/full-text tools work. This is live ECO02 evidence of an installed-but-unusable plugin path; preserve the first failure and diagnose controlled egress rather than broadening runtime network access.

## Verified implementation checkpoints

- Transport policy passed independent specification and code review at `98e98dc`; native envelope hardening followed at `4fc862a`. Production publication and live acceptance remain open.
- Durable product document/job foundation passed PostgreSQL integration, ownership/CAS/history/lease regressions, specification, database and code reviews (`f2de593`, `50a6937`, `6cfaef1`). This is infrastructure for the remaining product services, not completion of Batch 3.
- Capsule CRUD/approval/activation and lexical recall are in implementation review. MemOS adapter contract implementation is awaiting integration; semantic recall and live engine acceptance remain open.
- Research delivery review also identified missing root CI wiring and insufficient typed scientific engine-receipt validation. Both remain Batch 7/8 release requirements.
