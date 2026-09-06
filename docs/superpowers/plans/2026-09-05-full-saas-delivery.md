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

This register supersedes the stale implementation checkboxes above for status reporting. Baseline: production `evimed-20260906-a09f012`, source `a09f01244bdf7ef2c09d66fa5a8cf37cb80734a0`, published at `2026-09-06T14:45:21Z`; `2301600` remains available for rollback. `Implemented` describes source coverage only; a row is not accepted until its complete customer-path evidence exists. No completion percentage is inferred from unit-test counts or readiness. Historical source audits remain reference evidence, not current acceptance results.

External Chrome evidence is retained under the workspace's ignored `outputs/audit/reports/2026-09-06-customer-journeys/`. On `8b3f610`, two native turns produced distinct successful run records; capsule recall/note, encrypted transfer/import, revoked-import rejection and the actual customer file-export download were observed. Expired five-minute frames prevented later input; fresh frames restored it. Release `6ce0af3` includes the reviewed frame renewal, immutable source capture/current-turn proof, digest reading/inactivity and embedding-readiness fixes. Public readiness, source/image preflight and synthetic resolved alert delivery passed. Authenticated semantic capsule search returned the approved entry in 249/191/259 ms after more than five minutes of engine uptime. The first long-turn browser attempt stopped during runtime boot before prompt admission and remains retained. After correcting the harness to wait for the actual bridge ready/session acknowledgement, the second attempt passed: run_23dc60fb1275d57c0a61b56f66bf838a ran for 364 seconds, crossed its original expiry with the same iframe, preserved draft and an unended actual transcript turn, then run_1f60e59c903a711c07a6c63ae042cc4f independently succeeded. Three renewals retained the same frame identity. The earlier complete scientific API E2E failure remains retained; component successes do not replace it.

| ID | Source status | Verified evidence or remaining acceptance |
| --- | --- | --- |
| BASE01 | Implemented | Isolated GitHub worktree and source revision identified; original work preserved. Generated test directories still require cleanup. |
| BASE02 | External authorization blocked | Root workflows exist. GitHub OAuth lacks workflow scope; push is rejected and remote CI cannot be certified. Preserve workflows and commits while awaiting the already-requested authorization. |
| UI01 | Implemented | External Chrome loaded the authenticated native DSH frame on 8443 after registration; retain this evidence in the final release run. |
| UI02 | Implemented | Shared HTTP/mux authorization exists; real native denial, logout and spend-boundary acceptance remains. |
| UI03 | Implemented | Signed per-frame binding exists; second-frame reopening works; distinct-project multitab/reconnect acceptance remains. |
| UI04 | Implemented | External saved-session reopening retained the transcript; capability-start, back/forward and project switching remain. |
| UI05 | Deployed; partial acceptance | Native per-turn identity and receipt paths were verified on 8b3f610. The 6ce0af3 renewal passed a 364-second live task and a distinct second turn; 2301600 passed two fresh native turns. Current a09f012 adds authenticated child-session progress with first-owner and sequence/replay boundaries. Its actual delegated-run monitoring acceptance remains pending. |
| UI06 | Partial | Native conversation and run side panel exist; synchronized evidence/files/revisions, mobile and keyboard journeys remain. |
| ECO01 | Partial | Pin/seam/support manifests exist; publish and verify the actual supported host/client/tool/skill lifecycle. |
| ECO02 | Reviewed candidate; not deployed | Installed dsh-cite 0.3.2 directly calls Crossref and fails under the production network boundary. Bridge 8f7e721 passed independent code/security review and 244 tests, including all five real tools, native registry lifecycle, both pinned DSH bundle orders, controller v5 propagation and actual credential rotation/missing-file behavior. It still requires a coordinated Web/controller/runtime release and public Crossref acceptance. Three other candidates remain explicitly rejected/incompatible. |
| ECO03 | Missing | Immutable operator-built bundles do not provide the designed customer configuration, enable/disable, update/removal and rollback lifecycle. |
| ECO04 | Partial | Fixed composition is confined; prove isolation through the implemented plugin lifecycle once available. |
| ECO05 | Partial | Upstream matrix workflow exists; operated cadence, migrations and rollback evidence remain. |
| CAP01 | Implemented | Canonical capability catalog is unified in source; verify every visible launch through the native surface. |
| CAP02 | MR image verified; scientific rerun active | Four public BMI/CHD scenarios matched strict official IVW/Egger references in the deployed Linux MR image without network or JWT. Hosted local-file dispatch is being implemented; authenticated OpenGWAS is separate. The 2301600 aripiprazole review failed with runtime_monitor_stalled and zero artifacts while its child worked. Current a09f012 rerun run_0282021a1898973b1d5a36531cceacb4 started at 14:47:35 UTC. The same prompt routed directly to clinical-evidence-synthesis this time: delivery acceptance and actual child-monitor acceptance must be recorded separately. |
| CAP03 | Deployed fixes; scientific recovery open | Canonical receipts, immutable source reuse, current-turn proof, topic delegation rollback, actual child-session source proof and one-use repair revisions are deployed. Current a09f012 counts authenticated kernel sequence advances directly; mutable workspace projections cannot reset stalls. Cross-process grants, run reconciliation, child ancestry/epoch and replay boundaries passed independent review. End-to-end scientific recovery remains unaccepted until the real rerun and delegated path finish. |
| CAP04 | Partial | Bounded screening/review exists; screening writes its ledger after all waves and lacks durable mid-run resume. |
| CAP05 | Partial | Adapter/source readiness is green; current source/data correctness and external credential-dependent capabilities remain distinct gates. |
| CAP06 | Partial | Exporters and contracts exist; actual office-file rendering, source/code/data provenance and clean reproduction remain. |
| ING01 | Partial | OpenList is connected with scoped browse/import; customer connection lifecycle and incremental change detection remain. |
| ING02 | Reviewed deletion candidate; partial | Durable source-delete consumption now retires canonical units/facts, cancels ingestion, cleans only owned copies and survives retry/restart. Epoch-aware producer/metadata writes and lease-specific attempts close late-worker races; Linux/PostgreSQL 18 cases and 17 units passed independent review. Not yet deployed. Resumable upload and the local connector remain. |
| ING03 | Partial | MinerU service is deployed and healthy; real document, table, formula and fallback acceptance remains. |
| ING04 | Partial | Parser units are recorded; declared analysis depth does not change extraction. Typed understanding, methods and merge/materialization remain. |
| ING05 | Partial | Physical unit counts exist; parser-failure ratio is not a question-based omission audit. Reprocessing/version coverage remains. |
| ING06 | Partial | Tidying UI exists; meaningful depth, automatic progress and understanding revision flow remain. |
| MEM01 | Reviewed recovery fix; partial | MemOS live write/recall/delete contract previously passed. A newly reviewed fix makes unchanged PostgreSQL fingerprints verify actual engine records before skipping recovery, with retry on unavailability. Real PostgreSQL drift, cross-account isolation and lease-expiry rollback/recovery pass; the fix is not deployed. This does not prove Qdrant ranking or complete historical-scope reconstruction, and all six stateful auxiliary volumes remain in the recovery set. |
| MEM02 | Deployed; runtime path verified | Controller protocol 3 propagates the capsule endpoint. Real native recall and candidate note persistence passed on 8b3f610; its first cold embedding exceeded 3 seconds. 6ce0af3 keeps the model resident and checks actual embeddings before readiness; public semantic search now takes 191–259 ms. Native first-query and broader lifecycle acceptance remain. |
| MEM03 | Transfer partially accepted | Actual UI encrypted export/decrypt/preview/import passed. The imported entry stays a candidate; revoked preview yields canImport=false and a direct import is rejected 409. Cross-account sharing, revoked-file reupload UX and the complete lifecycle remain unaccepted. |
| MEM04 | Partial | Evidence-backed entries and lifecycle exist; conflict/decay/promotion/consolidation and five-layer collaboration remain. |
| MEM05 | Missing | CRUD and extraction do not implement contextual feedback learning and held-out personalization evaluation. |
| MEM06 | Partial | History API and method exports exist; timeline, method-as-skill publication and run-version traceability remain. |
| AUTO01 | Partial | Durable agendas/leased episodes exist; actual restart and coordinated scheduling acceptance remains. |
| AUTO02 | Partial | Spend caps exist; daily task choice is a hash, not a research-state and remaining-budget allocation plan. |
| AUTO03 | Partial | Ordinary run gates and artifact binding exist; independent validation episodes and frozen analysis-plan execution remain. |
| AUTO04 | Deployed; partial workflow | PostgreSQL digest persistence, inbox-to-owned-project navigation and read-after-display activity are deployed. Real PostgreSQL/producer-consumer tests pass; customer browser digest acceptance and decisions changing subsequent allocation remain. |
| AUTO05 | Deployed; partial acceptance | Inactivity is now enforced before enqueue and before paid dispatch, using actual digest opens and explicit resume. Fresh-lease checks preserve stop authority after slow activity reads. Long-running operator/customer stopping-condition acceptance remains. |
| BILL01 | Partial | Durable model reservations/settlements and uncertain states exist; complete resource accounting and provider reconciliation remain. |
| BILL02 | Partial | Per-request durable admission exists; all native/specialist/background paths need real concurrent acceptance. |
| BILL03 | Deferred by user | Actual payment is excluded. Nonpaid scope and enforced customer allowances remain required. |
| NOTICE01 | Partial | Durable inbox exists; digest source, business actions and due-action effects must connect to their owning workflows. |
| ACCT01 | PostgreSQL and native export accepted; partial lifecycle | Current 2301600 actual customer UI download contains supported PostgreSQL documents/revisions, inbox/preferences, usage, the existing capsule and a fresh native journal with both actual turn markers. Public-field and archive-path allowlists passed; concatenated Zstandard journal frames were fully decoded. The 156,929-byte archive has 22 entries, 7 documents and 8 revisions. Account deletion/recovery/support/terms remain unaccepted. |
| ACCT02 | Missing | Personal account UI does not implement a scoped operator tenant-support console. |
| OPS01 | PostgreSQL host restore accepted; volume coverage open | Native journal backup c3dd5df is deployed in 2301600; pre-cutover data restore covered 2,987 files. Existing daily PostgreSQL backup was upgraded in place to reviewed 9f7882c at 14:11:53 UTC, preserving the timer file and recovering previous host files privately. Its actual encrypted/decrypted temporary-database restore passed all 26 application table counts from one exported snapshot; source identity matches the live database and no owned drill database remains. All 29 retained archive checksums passed after retention; the new archive is 324,448 bytes. Public readiness stayed healthy. The next Web release must consume the non-secret status directory; separate Memos attachments, MemOS stores/queues and OpenList configuration still require recovery coverage. Control-plane and old Memos share the evimed database; off-host custody alone is excluded. |
| OPS02 | Partial | Online host preflight delivered a synthetic resolved alert; independent host-loss and operational response acceptance remains. |
| OPS03 | Capacity constrained | The a09 Web build temporarily reduced free disk to 4,987,551,744 bytes, below the 5 GiB gate. After that build completed, the operator removed only generated dependency directories with no container references and 18 exact private build-cache records; an independent snapshot confirmed 5,729,136,640 bytes free again. Six outstanding auxiliary volumes total about 519 MiB, mostly Neo4j. Current/rollback images and customer volumes remain. Metadata-only cache ordering is reviewed in source 6fd745c, not deployed; recovery peak-space and sustained capacity acceptance remain open. |
| OPS04 | Partial | Public native loading and a six-minute renewal/two-turn journey passed. The IP certificate expires at 2026-09-11T07:07:14Z; enabled evimed-certbot-renew.timer last succeeded September 6 12:09 CST. The ACME staging renewal dry run succeeded after disabling its observed 310-second test-only random delay; the production certificate serial/expiry stayed unchanged and Nginx remained active. Continuous browser/WS and full certificate alert lifecycle remain. |
| QA01 | Not accepted | Current a09f012 public health/readiness, immutable Web/controller image and model receipt pass independent verification. Unchanged runtime/specialist images retain their earlier provenance; 2301600 native two-turn/account-export and 6ce0af3 renewal evidence remain scoped to the paths actually tested. Retain failed scientific run_8df46eff9c1437bfe4589509a3b357a2; the new single-case rerun is active. The full capability audit and remaining customer journeys are unaccepted. No ci:web or aggregate pass claim. |
| QA02 | In progress | This register reconciles all 48 rows; keep code state, deployed revision and actual evidence separate after each batch. |

### Execution order after the global review

1. Restore primary customer correctness: controller-to-runtime capsule wiring; native per-turn ledger/contract lifecycle; bounded native browser regression with preserved failure evidence.
2. Close cross-service state loops: digest/inbox integration, decisions and activity before spend, source deletion propagation. Test real service pairs rather than permissive mocks.
3. Complete source understanding and memory workflows against the approved design, including effective depth, omission audit, feedback and methods.
4. Complete supported plugin lifecycle and capability/reproducibility acceptance, incorporating separately owned scientific benchmark outcomes.
5. Finish account/support, capacity and full-stack restore acceptance; push/CI and one reproducible production cutover with final customer-path evidence.

Do not rerun a failed whole-product model journey without a new diagnostic hypothesis. Persist release identity, run/session IDs, terminal outcome and artifacts before cleanup; report infrastructure failures, valid evidence insufficiency and scientific-quality failures separately. Deterministic artifact movement/registration should not depend on whether a model remembers to copy a file. Coordinate any production restart with the separate published-paper evaluation task before cutover.

The separate published-paper evaluation reports `dsh-cite` Crossref network failures while managed literature/full-text tools work. This is live ECO02 evidence of an installed-but-unusable plugin path; preserve the first failure and diagnose controlled egress rather than broadening runtime network access.

Its complete baseline is retained in `outputs/audit/reports/2026-09-06-published-paper-benchmark/benchmark-report.md`: two review failures and two nominally successful topic runs that bypassed the outdated specialist service. Additional required integration fixes are the topic service's old two-field request schema, action-specific `jobId` semantics, delegation failure rollback, actual downloadable artifact paths, and consistent parent/child preservation evidence and final acceptance/freeze authority. Retracted references and a retained power-table error remain scientific quality findings, not resolved by a technical success status. The benchmark finished and stopped all its runtimes; candidate cutover no longer needs to wait for it.

Reviewed a6b2386 ships three missing Python helpers for topic selection and dataset scoping, regenerates the socket package, and extends parity checks to all sibling Python helpers. Both shipped preflight entry points now execute their CLI help locally; final-image invocation remains required.

The user confirmed the OpenGWAS token is still being requested and directed testing with publicly downloadable GWAS data meanwhile. Use pinned official published-data subsets for local MR/harmonization/reference checks, retain provenance and checksums, and keep authenticated OpenGWAS extraction as a distinct pending acceptance step. Do not simulate API access or mislabel an offline fixture run as online connector acceptance.

### Remaining local recovery set implementation

The September 6 source review confirmed that the following six complete volumes are not covered by the current application-data and PostgreSQL backups: Memos attachments, MemOS registry/files, Neo4j, Qdrant, Redis and OpenList configuration. The deployed MemOS source was inspected, not inferred from container names. PostgreSQL facts cover only part of their state; record readback does not prove vector recovery. The six measured volumes total about 519 MiB. Pinned Ollama weights and explicitly reproducible attachment derivatives are the only established rebuild exemptions.

- [ ] Reuse the existing host timer as one capture-set coordinator. Remove independent sidecar scheduling only when its replacement is verified; retain the sidecar as a bounded archive tool/health observer without Docker authority.
- [ ] Add an expiring maintenance request and actual idle verification before stopping writers. Refuse new mutations/claims, let current work finish, and defer busy or unknown state without cancelling customer work. Persistent timer catch-up must respect the maintenance window.
- [ ] Capture application data, one exported PostgreSQL snapshot and the fixed six auxiliary volumes during the same verified no-write interval. Record exact component/container/volume identities, image digests and capture times; do not call this a cross-database transaction.
- [ ] Preserve numeric ownership for volume restores; the current application archive's zero-owner and no-same-owner behavior is insufficient. Capture each member separately with bounded peak-space estimates and fail the entire set on a missing member or changing file.
- [ ] Restore previously running services immediately after capture, including failure/termination recovery. Keep the previous verified set usable while a new set's isolated drill runs; a failed attempt cannot refresh success or delete the last verified set.
- [ ] Run restore drills only in newly identified volumes/containers/internal networks. Verify actual PG table contents/counts, attachment bytes, MemOS registry and records, Neo4j relationships, Qdrant vectors/payload, Redis consumer/acknowledgement state and OpenList configuration. Disable clone scheduling, production callbacks and external storage access.
- [ ] Publish and verify one complete set receipt before making Web readiness require it. Preserve local-only backup custody; off-host storage remains excluded by the user.

## Verified implementation checkpoints

- Transport policy passed independent specification and code review at `98e98dc`; native envelope hardening followed at `4fc862a`. Production publication and live acceptance remain open.
- Durable product document/job foundation passed PostgreSQL integration, ownership/CAS/history/lease regressions, specification, database and code reviews (`f2de593`, `50a6937`, `6cfaef1`). This is infrastructure for the remaining product services, not completion of Batch 3.
- Capsule CRUD/approval/activation and lexical recall are in implementation review. MemOS adapter contract implementation is awaiting integration; semantic recall and live engine acceptance remain open.
- Research delivery review also identified missing root CI wiring and insufficient typed scientific engine-receipt validation. Both remain Batch 7/8 release requirements.
