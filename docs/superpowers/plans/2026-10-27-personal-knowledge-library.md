# Personal knowledge library implementation plan

> Execute with subagent-driven-development and independent specification/code reviews. The owner approved the preceding live-audit recommendation and requested local verification, commit and push, without deployment.

**Goal:** Make the knowledge base an account's materials entry point, with direct personal intake and optional project organization, while preserving project authorization and source history.

**Architecture:** Extend the existing source ledger and personal library. An account-owned reserved storage project keeps originals through the existing immutable upload pipeline; it is not a user-visible or interactive project. Project-scoped wiki/graph generation remains separate. No new retrieval or memory engine is introduced.

**Tech stack:** Existing React/TypeScript UI, Node ESM routes and workers, PostgreSQL product ledger, existing parser and OpenViking adapters.

## Approved behavior and boundaries

- `/app/files` defaults to **My materials**, an account-owned source list across projects and personal storage. Existing project addresses continue to select their project. The cross-project-available personal library remains an explicit subset, not a rename of all sources.
- Add file/link/note defaults to personal storage outside a project view. An optional project destination uses the existing project intake. Direct personal additions join the existing personal library in the same source-publication transaction; membership failure must not report successful intake.
- Use `evimed-library` as a reserved internal storage project, distinct from the background understanding project `evimed-sources`. Reuse internal-project hiding, interactive-request refusal, account ownership, capacity and source processing limits. Never expose it in project pickers or admit it as an interactive runtime.
- Existing source routes remain the authority for readers, edit/refetch, immutable versions and removal. Personal source replacement updates its own active library contribution; it cannot revoke an independently retained same-byte source or another live logical binding. Legacy library entries retain explicit user intent. A library-only unshare does not delete the source itself and must not be silently reversed by later edits or background refresh.
- An explicit **Add to project** action copies the selected immutable version through the existing intake, retaining its origin reference. It is an independent project version, not an unannounced live-edit link. Only an owned ordinary project is eligible. Shared GEO access remains governed by its existing authorization policy.
- Project Compile defaults to project sources only. Personal storage never compiles as a synthetic project. Keep personal-resource synchronization running; do not filter it out of the shared source-reconciliation inventory. Existing library recall for ordinary private conversations remains; shared GEO conversations still exclude private library material.
- The cloud-drive entry stays visible with truthful connection states. Reuse OpenList and existing operator readiness UI. No credentials, storage connection, online configuration or production data are changed in this iteration.
- No source is fabricated to make an empty production page look populated. Positive data-path tests use owned local fixtures. Native/model-backed claims require real observed evidence; deterministic adapter fixtures are labelled accordingly.

## Contract

```ts
type SourceScope = { kind: 'all' } | { kind: 'shared' } | { kind: 'project'; projectId: string };
type SourceDestination = { kind: 'personal' } | { kind: 'project'; projectId: string };
type DriveState = 'ready' | 'unconfigured' | 'storage_missing' | 'permission_denied' | 'unavailable';
```

- `GET /api/sources?scope=all` retains the existing filters, cursor and `{items,counts,nextCursor,passages?}` response. It must use bounded SQL pagination under the authenticated account, not client-side project enumeration. Ordinary internal work is excluded; personal storage is included. Listing does not grant retrieval permission across projects.
- `POST /api/library/uploads` accepts `{filename,data,encoding}` and returns the existing source-registration shape; the server owns the directory and rejects paths/owner/project overrides.
- `POST /api/library/links` accepts `{url}`; `POST /api/library/notes` accepts `{title,body}`. They use existing URL safety, source limits, publication and parsing.
- `POST /api/library/:sourceId/projects` accepts `{projectId,expectedRevision}` and returns the registered immutable project copy. Under the source lock, require the source owner, the selected current revision and an allowed destination; derive original source/generation/hash/publication provenance on the server. Reject stale selections, including A-B-A reactivation. Repeat-copy identity includes the frozen version and destination.
- `GET /api/sources/openlist/status` returns `{state: DriveState}` without requiring a project. No raw upstream messages, addresses or credentials are returned. Existing `/api/me.features.openList` remains compatible.
- Existing source/library routes, source IDs, selected-empty behavior, project/shared authorization and DSH composer/right pane remain compatible. A mixed all-materials selection needs a destination where every item is eligible or an explicit version-copy action before preparing its references; never drop IDs and widen the conversation scope.

## Task 1: Backend intake, listing and scope

Files: `OpenScience/apps/server/src/internalProjects.mjs`, a focused personal-intake module, `sourceRoutes.mjs`, `sourceService.mjs`, `libraryService.mjs`, `knowledgePageService.mjs`, `knowledgePageRoutes.mjs`, `server.mjs`, and focused server tests.

- [x] Add failing account-boundary/listing tests: all scope includes two owned projects and personal material, excludes another account and unrelated internal work, preserves counts/cursors/search and explicit selected-empty retrieval.
- [x] Add failing personal-intake tests for file/link/note without project input, invalid/forged fields, quotas, source/member atomicity, retry, replacement A-B-A, deletion and cross-account refusal.
- [x] Implement the reserved storage identity and existing-pipeline adapter. Keep source registration and membership transactional and preserve failed immutable staging without publishing partial ledger state.
- [x] Add explicit project-copy support with frozen origin, ordinary-project authorization and repeat-save idempotence.
- [x] Keep storage sources synchronized; reject their Compile requests and background Compile scheduling. Default ordinary Compile to project-only input while preserving private-library recall and shared-GEO exclusion.
- [x] Run focused unit and real-PostgreSQL integration tests; record adapter-fixture versus real engine coverage separately.

## Task 2: Cloud-drive state

Files: `OpenScience/apps/server/src/sourceRoutes.mjs`, `openListSourceConnector.mjs` or a small existing-client adapter, and focused tests.

- [x] Test absent connector, missing storage, rejected credentials, unreachable upstream and mounted storage.
- [x] Expose the bounded status contract using the existing connector. Account-authenticate it; preserve the existing boolean feature contract.
- [x] Return a generic unavailable state for transport failure; never turn it into an empty successful drive listing.

## Task 3: Unified materials UI

Files: `OpenScience/apps/web/src/lib/sourceClient.ts`, `knowledgeNav.ts`, `components/sources/useKnowledgeScope.ts`, `AddEntryDialogs.tsx`, `SourceRow.tsx`, `app/routes/SourcesPage.tsx`, source conversation handoff helpers and their tests.

- [x] Add `all` scope and make it the default. Keep project deep links and back/forward/query state stable. Display project provenance without exposing storage project internals.
- [x] Make personal/project destination explicit for file, link and note entry; all/shared views default to personal. Reuse design-system controls and preserve partial upload outcomes.
- [x] Provide Add to project using the explicit snapshot-copy endpoint. Cross-project selections must resolve a valid conversation destination; do not silently broaden its source eligibility.
- [x] Show knowledge pages/graph only for a chosen project; keep all/shared browsing useful without a competing project hierarchy or right pane.
- [x] Keep the cloud-drive menu visible. On unavailable connection show a clear reason, retry and direct-upload alternative; operator-only navigation may point to the existing `/app/ops` readiness page, never a nonexistent setup form.
- [x] Test scope transitions, personal intake, project copy, source removal, pending/errors, reader return state, project/graph rules and narrow keyboard-accessible forms.

## Task 4: Local end-to-end verification and delivery

- [x] Exercise a local plain-text source through real PostgreSQL intake/capture/index and explicit library membership, project copy, history and revocation. Deterministic parser/model/engine seams must be named as such.
- [x] Exercise the in-app browser with local owned fixtures: default list, personal note/file, project copy, failed cloud-drive state and upload fallback, reader/back navigation, first-click upload and narrow viewport. Link behavior and project-only graph are covered by focused component and PostgreSQL/engine-stub tests; the browser did not run a real model or native engine.
- [x] Run server/web type checks, scoped and then full relevant tests, lint, frontend build and source credential audit. Fix real failures without weakening assertions.
- [x] Complete independent spec, JavaScript/security/database review as applicable; resolve findings and rerun affected tests.
Delivery: update the existing progress log and operations docs, then commit only this iteration's files and push the branch. Do not merge/deploy or modify production configuration/data. Retain unrelated owner files.

Verification commands start in `OpenScience/`: `pnpm typecheck:server`, `pnpm typecheck`, `pnpm lint`, `pnpm build:web`, `pnpm audit:source-secrets`; focused Node and Vitest paths are recorded with the implementation's actual tests. Successful checks do not imply unperformed production or answer-quality acceptance.

## Verification boundary

The local full frontend suite passed 489 files / 5,834 tests; the 18-file real-PostgreSQL backend set passed 159 tests without skips. The additional personal-source-to-project Compile integration passed against real PostgreSQL and business workers with a deterministic OpenViking stub and fixture embeddings. The in-app browser used a dedicated loopback-only database and mock runtime; no production data, cloud configuration or external models were touched. Real OpenViking/model/DSH and post-deployment acceptance were not performed in this non-deployment delivery.
