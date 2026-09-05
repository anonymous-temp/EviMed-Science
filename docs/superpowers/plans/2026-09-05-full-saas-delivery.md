# Full SaaS Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver and publish the complete individual-researcher SaaS approved in the September 5 production review, retaining the native DSH Web UI and plugin composition.

**Architecture:** Keep the existing EviMed control plane, per-project DSH containers, native browser application, domain validators and specialist engines. Complete the transport policy, durable product services and native-client integration before enabling the corresponding external workflows. Use one persisted state and one acceptance contract per feature; a schema, mock or disabled page never counts as delivery.

**Tech Stack:** Node ESM/checkJs, React/TypeScript, PostgreSQL, DSH 0.1.2-rc.1, Docker, Python specialists, MemOS, OpenList and MinerU.

## Authorized scope and execution

The user approved implementation and production publication of the full reviewed scope. Do not repeat design or release permission prompts. Ask only for missing operator resources that cannot be discovered, and continue independent work. The original July/Gitee worktree is preserved; implementation occurs in the clean GitHub checkout on `codex/full-saas-delivery-20260905`.

The full requirement register is the September 5 production review, with IDs BASE01–QA02. Its 48 rows remain open until their actual acceptance evidence exists. This file tracks implementation batches; the existing August design supplies detailed feature contracts. Production configuration, customer data and credentials must be preserved.

## Batch 1: native UI policy parity (UI02, part of UI05/ECO04/BILL02)

**Files:**
- Modify `OpenScience/apps/server/src/runtimeUiServer.mjs` to validate origins and supply one request/frame authorization policy.
- Modify `OpenScience/apps/server/src/runtimeManager.mjs` only at its browser WebSocket proxy, replacing unexamined byte tunneling with a bounded message relay.
- Create `OpenScience/apps/server/src/runtimeUiMuxProxy.mjs` for WebSocket lifecycle and frame policy.
- Create `OpenScience/apps/server/test/runtimeUiSecurity.test.mjs` for real local HTTP/WebSocket fixtures; extend existing UI proxy tests where needed.
- Modify server dependencies and lockfile only if a supported WebSocket package is required.

- [ ] Write and execute failing integration tests before production changes. The tests must exercise real sockets and show: unauthenticated upgrade refused; foreign/missing Origin refused in production; `settings/describe` and every forbidden namespace denied inside `open` frames; `session/prompt` refused when spend admission fails; allowed read and cancel frames still work; logout revokes an established socket; excessive message size and connection count are bounded.

Representative assertion pattern (fixture identity is local test data):

```js
const socket = await openUiSocket({ origin: allowedUiOrigin, cookie: sessionCookie });
socket.send(JSON.stringify({ type: 'open', streamId: 'blocked', endpoint: 'settings/describe', payload: { args: {} } }));
assert.equal((await nextFrame(socket)).error.code, 'runtime_ui_method_denied');
assert.equal(upstreamCalls.includes('settings/describe'), false);
```

- [ ] Commit the executed RED reproducer on the active branch.
- [ ] Implement a single endpoint policy used by HTTP and WebSocket, retaining native DSH frame envelopes and named per-stream errors. The relay must preserve independent cancel/end streams, reject malformed frames, close on failed session revalidation, retain the project resolved at upgrade, apply bounded payload/connection/backpressure controls and clean up both peers on every close/failure. Do not expose raw upstream cookies or provider keys.
- [ ] Run `node --test apps/server/test/runtimeUiSecurity.test.mjs` and the existing runtime proxy tests; run server lint and checkJs typecheck. Commit GREEN.
- [ ] Perform independent specification review, then code/security quality review; resolve findings and retain evidence.

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
- [ ] **Batch 8 — production readiness and release:** BILL03, OPS01–OPS04, QA01/02. Complete operator-dependent service channels, off-host restoration, alert delivery, resource acceptance, clean CI and full customer journeys. Build immutable images and manifests, back up before migrations, stage the candidate, verify, publish, and verify again through public customer routes.

Each remaining batch receives its concrete file/API/test plan immediately before implementation, using the approved feature contracts and the state delivered by preceding batches. Do not invent successful external integration evidence while waiting for an operator account, endpoint or credential.

## Completion bookkeeping

- [x] Production source and current GitHub main inspected; base revision `8ce276f2c4ea820d9edc6b15b8f84f885cbfdaa7`.
- [x] Clean implementation branch created; original local edits preserved.
- [x] Operator-resource question issued for domain, off-host storage and payment channel; dependent configuration remains pending an answer or discovery.
- [ ] All 48 acceptance rows linked to implemented code and fresh evidence.
- [ ] Full reviewed release committed and pushed.
- [ ] Immutable production release deployed and public full-path acceptance retained.
