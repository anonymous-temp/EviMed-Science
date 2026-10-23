# Knowledge, Memory, and OpenViking Integration Implementation Plan

> For agentic workers: use the installed subagent-driven-development or executing-plans skill after the owner approves this plan. Steps use checkboxes for execution tracking. The owner requested GPT-6.1-Sol execution agents with the primary agent coordinating and reviewing.

**Goal:** Make EviMed's existing knowledge base, source-grounded conversations, OpenViking integration and memory-capsule boundaries reliable, understandable, and demonstrably useful.

**Architecture:** Retain one OpenViking service and separate knowledge Resources, native memory, legacy derived indexes and capsule indexes. Preserve PostgreSQL's business authority, the existing hybrid knowledge retriever, native OpenViking extraction and official Compile skills. Unify access, lifecycle, provenance and completion contracts across these paths, without creating another engine or navigation hierarchy.

**Tech Stack:** React/TypeScript, existing design primitives and native DSH workspace, Node ESM, PostgreSQL/pgvector, product document/job ledger, pinned OpenViking service/plugin/skills.

**Status:** Approved by the owner on 2026-10-23; implementation in progress.
**Research date:** 2026-10-23, Asia/Shanghai.
**Code baseline:** 01e965e99a1118439557210b7ab28b9b7e7338a9.
**Research record:** _knowledge_base/research-kb-openviking-agent-products-20261023.md.
**Execution boundary:** Finish the approved iteration and its acceptance. No subsequent iteration starts automatically.

---

## 1. Decisions this plan preserves

1. EviMed is a general agent platform first, with medical evidence methods added when relevant. Normal documents, spreadsheets, code and office work remain first-class.
2. Home remains the general conversation. Knowledge management stays at /app/files; project selection and the main sidebar remain the only project hierarchy.
3. Use DSH's native conversation file workspace, tabs, browser, previews, resizing and fullscreen. Do not build another competing right pane.
4. Reuse existing source reader, source selection, notes, output-save, wiki, graph, capsule transfer and memory controls. Existing code is not presented as newly built functionality.
5. The agent kernel remains DSH. OpenViking owns native extraction and official context compilation; EviMed owns tenancy, user choices, evidence labels, metering and delivery.
6. Knowledge is not memory. A document's contents are not automatically the user's preferences or instructions. Skills are reusable procedures, not a substitute source store.
7. Clinical labels and source warnings remain advisory as established by the delivery policy. Do not introduce a new report-withholding gate.
8. Preserve source identifiers, old citations, routes and existing public API semantics. New internal identity fields are additive and migrated explicitly.
9. Ordinary actions remain direct: add, read, search, use in chat, edit, remove. Do not add approval steps for reversible work.
10. The owner approved full execution on 2026-10-23, including the planned bounded evaluations, release and acceptance. This authorizes this iteration only; no subsequent iteration starts automatically.
11. During the later authorized release, old unused images/build caches can be removed as requested. PostgreSQL, OpenViking native memory, source originals, secrets and current persistent volumes are not build caches.
12. A passing test, healthy endpoint or completed Compile task is not proof of ingestion, retrieval, citation navigation, memory learning or production acceptance.

## 2. Verified current integration

### 2.1 One deployment, several data owners

| Object | Authoritative state | OpenViking representation | Main read path |
|---|---|---|---|
| Project source | Product source ledger, original bytes, extraction capture | User resources / p / projectHash / sources | PostgreSQL kb_search; OV kb_browse |
| Personal library | Account library ledger and retained read-only copy | User resources / library | Scoped KB search and Compile input |
| Wiki and graph | Engine-generated artifacts plus product mirrors and user edits | Project resources / wiki and / kg | Product reader/graph; runtime browse |
| Legacy memory | PostgreSQL research-memory records | memories/evimed/user, project, session | Engine candidates, then authoritative hydration |
| Capsule | Capsule facts, revisions, activation and transfer ledger | memories/evimed/capsule | Candidate recall followed by activation/revision checks |
| Native memory | Engine memory files and sessions, with PostgreSQL overlay | memories / eight native types | Official plugin, memory gateway, native store |

Source files: OpenScience/apps/server/src/openVikingLayout.mjs, openVikingClient.mjs, openVikingResources.mjs, openVikingSessions.mjs, kbIndex.mjs, memoryIndexing.mjs, nativeMemoryStore.mjs, capsuleService.mjs.

Important identity fact: the current deployment uses ONE upstream OpenViking account, normally evimed. Each EviMed application account becomes an opaque OpenViking user; projects are hashed subscopes. This is not an existing one-enterprise-one-OV-account model. Personal library sharing is same-account reuse, not organizational sharing.

### 2.2 What is already correct

- One pinned service and durable volume; no public engine port; control-plane mediation.
- Opaque user identity and explicit Resource/memory targets.
- Official memory plugin, native session commits, extraction templates and Compile skills.
- Existing native edit/forget/undo, source-change labels and capsule export from native files.
- Legacy derived memory hits are hydrated and checked against current records.
- Per-feature readiness and ordinary-conversation degradation.
- Model gateway accounting; separate knowledge and extraction purposes.
- Full engine-volume backup contract because native data is not a disposable index.

The project runtime has no provider keys. Do not overstate this as no credential anywhere: the engine's configured embedding integration does use an operator-managed credential.

### 2.3 What is incomplete

- Source/version identity and file writes are inconsistent under restore and concurrency.
- Resource browse does not apply the same current-lifecycle check as capsule recall.
- Partial replica failures can be treated as a fully prepared Compile input.
- Personal-library changes do not fully invalidate dependent artifacts.
- Scope and status state leak across frontend transitions.
- External Agent Memory API still uses legacy storage paths for native accounts.
- Current OpenViking candidate compatibility, shared-load behavior and restoration require live proof.
- The current official Wiki answer-quality arm has no result.

### 2.4 Version facts

Current main pins engine 0.5.0 and official DSH memory plugin 0.5.26 independently. Their different numbers are not a mismatch.

Upstream release 0.5.1.1, published October 20 and observed as latest on the research date, fixes later session commits missing from search in 0.5.1. This does not establish that 0.5.0 has that same bug. Evaluate 0.5.1.1 as the candidate; pin exact engine/image/plugin/skill bytes after compatibility evidence.

The local note saying Compile identity fix #5750 has no released tag is stale: the 0.5.1 release notes include it. Do not delete the shim on this observation alone.

## 3. Official product and technical research

These are documented public behaviors, not reverse-engineered vendor internals. Date observed: 2026-10-23. Limits, plan eligibility and product names can change.

| Reference | Documented pattern | Apply to EviMed | Do not infer/copy |
|---|---|---|---|
| Codex | Repository instructions, skills/MCP, local generated memory, per-chat memory use/generation controls [S01-S04] | Distinguish procedures, documents and memory; bounded on-demand context; explicit controls | An undocumented Codex cloud vector database or automatic ingestion of every file |
| ChatGPT Projects | Files, instructions and conversations grouped by project; project memory boundary; response saved as source [S05] | Clear project scope; reusable outputs; sources remain reachable from conversation | Another top-level project tree |
| ChatGPT Company Knowledge | Connected sources subject to source permissions; cited answers [S06] | Connector access is checked independently of connection existence | That a configured connector is synchronized or a project link implies sync |
| Claude Projects/Cowork | Project knowledge, instructions, RAG as content grows, project library of artifacts [S07-S09] | Small-source direct reading plus larger-source retrieval; project context continuity | Vendor capacity/performance claims as EviMed measurements |
| Claude memory/Claude Code | Reviewable/editable memory, per-chat controls, instructions distinct from automatic memory [S10-S11] | Use/learn controls and project scoping; explain persistence simply | Mix legacy and current product behavior or treat instructions as evidence |
| NotebookLM / current Gemini Notebook help | Selectable sources, notes, citation navigation, synchronized-source access revocation, interactive mind maps [S12-S14] | Source-first reader; scoped questions; graph nodes lead to evidence and chat | A second standalone conversation system or decorative charts without evidence |
| Copilot Studio | Distinct source types and authenticated permission-trimmed knowledge [S15] | Explicit source capability/status contracts and negative access tests | Its answer-withholding policy; EviMed retains ordinary reply delivery |
| Glean | Content, identity, activity and permissions metadata; connector-specific indexing [S16] | Metadata/facets, ownership and update history | A new social/person graph or a marketplace of hundreds of connectors |
| OpenViking | Resources/memory/skills, L0/L1/L2, multi-tenant identity, Compile and queue semantics [S17-S21] | Native engine reuse with adapter contracts | That a shared service means common data ownership or universal authorization |
| Anthropic engineering and citations | Contextual hybrid retrieval, selective context, page/text/block citations [S22-S24] | Preserve passage context and exact locations; test retrieval and citation separately | Provider-specific API/model switch or borrowed benchmark gains |
| OpenAI Retrieval API | Indexed removal is eventually consistent [S25] | Immediate logical exclusion at the application boundary, followed by async cleanup | Eventual index deletion as sufficient for a user-visible revocation promise |

## 4. Architecture options and recommendation

### A. Shared service with separated namespaces and explicit authority — recommended

Keep the physical engine and existing data owners. Add one coherent access/lifecycle contract across adapters. Benefits: preserves native features and stable references, least migration risk, fixes the observed root causes. Cost: PostgreSQL and engine replicas need durable synchronization and reconciliation.

### B. Separate OpenViking deployments for knowledge and memory

Provides workload and failure isolation but duplicates operations, backups, keys, version adoption and cost controls. It does not fix source tombstones or application scope bugs. Consider only if a measured Compile load materially harms memory latency or a deployment requires physical isolation.

### C. Move all knowledge retrieval and capsule authority into OpenViking

Looks unified but replaces exact source/version/location semantics, signed capsule lifecycle and established PG indexes without evidence of improved results. Reject for this iteration. A future retriever experiment can compare equivalent backends without migrating business ownership.

### 4.1 Target boundary

~~~mermaid
flowchart TD
  UI[Knowledge reader / main conversation / memory capsule] --> CP[Control plane: actor, owner, project and user policy]
  CP --> PG[PostgreSQL source, library, job and activation ledgers]
  CP --> FS[Immutable source versions and native file workspace]
  CP --> OV[One OpenViking deployment]
  PG --> K[Existing hybrid knowledge search]
  OV --> R[Project and personal-library Resources]
  OV --> N[Native memory and sessions]
  OV --> D[Legacy and capsule derived indexes]
  R --> C[Official Compile: wiki and graph]
  PG --> E[Durable change and reconciliation jobs]
  E --> R
  E --> D
  C --> M[Product mirrors, user edits and source labels]
  K --> V[Current-scope and lifecycle validation]
  R --> V
  D --> V
  V --> UI
~~~

The diagram does not imply native memory is rebuilt from PostgreSQL. Its engine files are authoritative; the overlay carries product metadata and controls.

### 4.2 Scope contract

- Resolve authenticated actor, data owner and project membership before accepting IDs or engine paths.
- The runtime cannot supply a broader owner, tenant or Resource target.
- Every retrieval path has explicit targets. Ordinary conversations without a selection retain normal project policy; an explicitly selected scope that becomes empty never expands to a broader search.
- Current-project knowledge is the default project material. Personal-library items are included only under the account's explicit library policy; a strict project mode excludes external project/personal facts.
- Selected-source mode enforces source IDs in tools and references, not merely in a prompt. It cannot erase text already shown earlier in a conversation or the model's prior knowledge; UI and acceptance must not claim otherwise.
- Memory reading, learning from a turn, and capsule activation/sharing are separate decisions. Turning learning off does not implicitly delete memory; disabling use does not silently re-enable learning.
- A project collaborator gains access only to explicitly authorized project materials, never the owner's private memory or personal capsule.
- Preserve the current deployment-account/hashed-user mapping in this iteration. Record mapping version 1 explicitly. Do not silently relocate existing data to organizational resource roots.
- If an existing project-collaboration path is authorized, resolve actor versus owner through its existing membership model. If no such model supports a proposed team-library action, do not expose it. Organizational shared libraries are a separate owner decision.

| Selection mode | IDs | Retrieval result |
|---|---|---|
| Not specified | Omitted | Existing project and enabled personal-library policy |
| Explicit selected sources | One or more valid IDs | Authorized intersection only |
| Explicit selected sources | Empty, deleted or all invalid | No eligible source; retain the user's narrow scope and explain the missing material |

Store the mode independently of array length. Removing the final selected reference does not silently change the mode; the user can explicitly return to normal project scope.

### 4.3 Source identity and version contract

Use existing source families/revisions where possible; add only the missing distinctions:

| Identity | Meaning | Rule |
|---|---|---|
| Logical document | The note/file/web item the user manages | Stable across revisions; two independently created notes are distinct |
| Source version ID | An existing source record addressed by citations | Preserve every existing src_ ID and historical link |
| Content digest | Immutable original bytes | Deduplicate storage, not independently authored note identity |
| Parsed-text digest | A particular extraction result | Changes when extraction changes, even if original bytes do not |
| Processing generation | Fence for parse/index/publish/delete work | Old jobs cannot publish or remove a newer generation |
| Current revision pointer | Version used by default | Switched atomically in the ledger; historical versions remain addressable |

For new notes, derive source-version identity from logical document identity and content, not content alone. Preserve existing uploaded-file content deduplication. Existing ambiguous merged notes require an inventory and explicit recovery records, never automatic attribution guessed from filenames.

Restoring a deleted version must revive it with a new processing generation and cancel/fence old cleanup work. User-forgotten memory is not revived merely because its source is restored.

### 4.4 Consistency and failure contract

Use existing product jobs as the durable outbox rather than adding Kafka or a second scheduler. Mutation and event publication must be in the same database transaction or recoverable through an explicit transaction-owned outbox row.

A proposed internal event payload is:

~~~json
{
  "schemaVersion": 1,
  "operation": "source-replaced",
  "actorUserId": "authenticated-actor",
  "ownerUserId": "authorized-owner",
  "projectId": "authorized-project",
  "sourceId": "existing-source-version-id",
  "generation": 3,
  "mutationRevision": 7,
  "mutationId": "durable-business-change-id",
  "previousSourceId": "historical-source-version-id",
  "textSha256": "captured-text-digest",
  "targets": ["kb-index", "ov-resource", "knowledge-pages", "derived-context"]
}
~~~

Values above illustrate the internal contract, not new browser request fields. The idempotency key includes mutation ID, owner, source, generation and target. Ordering follows the source lifecycle or library-entry revision, not timestamps alone. Repeating one event deduplicates; library add-remove-add and two metadata changes within one parse generation are distinct events and must create new jobs.

- Commit logical deletion first; all subsequent tool reads reject it immediately.
- Clean replicas asynchronously with bounded retries and a fair reconciliation cursor.
- A late successful push cannot override a newer delete or restore.
- A partial update leaves readable older artifacts available with a source-change indication, but cannot be reported as fully fresh.
- Store per-source digests actually present in the engine when Compile is submitted.
- Failure or unavailable authorization must not fall back to unrestricted engine reads.

### 4.5 Provenance and memory interaction

- Store source ID, source generation, original/text digest, locator, extraction revision and artifact revision where known.
- Locators can be PDF page, character range, sheet/cell, or explicit unknown; never manufacture page/region precision.
- A source-to-memory association records whether it was explicitly observed from a run, extracted from a source marker, or manually attached. Do not fabricate lineage by semantic similarity.
- Source-derived capsule facts retain project restrictions and remain distinct from native personal memory.
- Source changes notify wiki, graph, result dependencies, derived facts and linked native overlays through one replayable process.
- Imported text, notes, metadata and compiled pages remain untrusted content. Embedded requests to change system rules, activate a capsule, install a skill or disclose another project's data are not authoritative instructions. Test that source retrieval cannot grant those actions.
- Historical quotation validity and current availability are separate facts. Preserve historical labels while making their version/time understandable.
- Personal user edits and explicit forgetting win over automated re-publication.
- Exporting or activating a capsule does not automatically grant access to the original project documents.

## 5. Product interaction specification

### 5.1 Knowledge landing page

One header: Knowledge, scope selector, one Add primary action. Keep three existing views: Sources, Knowledge pages, Graph. Search, type/status filters and sorting use the shared toolbar. Do not create an extra project sidebar or a second composer.

Add opens existing choices: upload, web link, note and configured drive. Show existing connection state; do not imply unconfigured providers are ready.

Use task language: saved, available for questions, still reading, could not read, source changed. Technical task IDs/URIs and token costs belong in operations diagnostics, not the standard page.

### 5.2 Sources and reader

- Preserve original/key-points reader and native preview reuse.
- Show title, type, source/update time and understandable availability.
- Search results expose a relevant passage and navigate to the exact preserved source version.
- Source actions are consistent in row and reader: use in chat, edit when applicable, refresh/re-read, versions, personal-library reuse, download and delete.
- Same-scope background refresh can preserve content. Scope changes reset data and disable old actions until the new scope resolves.
- Conflicting edits preserve the user's unsaved draft and permit copy/compare; they do not silently replace it with the server text.
- A connector source records whether it is a snapshot or synchronized, last successful sync and revoked/inaccessible state.
- No new folder hierarchy is required. Reuse source metadata and filters before adding taxonomy.

### 5.3 Conversation and reusable outputs

Use the existing selection/reference mechanism and the native DSH input. Choosing sources prepares a draft; it does not auto-send.

Existing entry paths to verify are source selection, the reader's whole-source action and a graph node. Add two bounded conveniences in existing surfaces: reader excerpt to chat and graph edge evidence to chat. They carry source ID, source version, available locator and selected text/evidence, reuse the same composer, and never create another conversation pane. The same source set and project must reach the server and runtime.

Generated files retain the existing Save to knowledge action. Verify that it creates a source, becomes readable and searchable, and can be cited in a later conversation. Do not automatically index every temporary output.

For a useful answer saved as a note, preserve citation associations and mark it as a user-retained/generated note. It must not become independent corroborating evidence for its own original claim.

### 5.4 Wiki and graph

- Wiki remains a linked synthesis, not another file list or per-document digest.
- Read, edit, inspect sources, show outdated inputs, and take a topic into chat.
- Graph keeps page-link and entity-relation views, explicit edge evidence, neighborhood expansion, zoom, keyboard access and an equivalent list.
- Zero search hits show zero hits.
- Small graphs show their actual nodes with a useful list or simple diagram; no fabricated relationships. The empty view explains how to add source material and which action is available.
- Keep expansion/fullscreen within existing chart primitives; downloading a graph is a view export with scope and provenance.
- Memory-map links open the same scoped knowledge reader. Do not make a separate competing knowledge map.
- Recompilation must preserve user-authored additions and restore canonical navigation.

### 5.5 Memory and capsules

Keep the existing memory/capsule surface. Clarify with actions rather than backend names:

- What is remembered, where it applies, and where it came from.
- Use existing memory versus learn from this conversation.
- Personal versus current-project scope.
- Edit, forget, undo, trial, activate, deactivate, export/import and share/revoke.
- A trial capsule does not silently teach the receiving account.
- A shared project does not imply shared personal preferences.
- Standard UI does not expose native/legacy engine terminology; operators and API diagnostics report it accurately.

## 6. Complete defect and gap traceability

| ID | Confirmed defect or gap | Work packages | Acceptance |
|---|---|---|---|
| K01 | Deleted-SHA reupload / A-B-A conflict and file overwrite | W03-W04 | J03-J05 |
| K02 | Concurrent note/web saves mutually retire versions | W03-W04 | J04-J05 |
| K03 | Deleted Resource still readable through kb_browse | W02, W05 | J06-J07 |
| K04 | Partial sync failure ignored before Compile | W04, W06 | J08 |
| K05 | Old project tree/graph survives scope change | W02, W10 | J09 |
| K06 | Independent identical notes collapse | W03 | J03 |
| K07 | Personal-library removal misses dependent invalidation | W04, W07 | J07-J08 |
| K08 | Fixed top-50 reconciliation starves older projects/accounts | W04 | J10 |
| K09 | Valid personal-library citation marked unavailable | W05, W09 | J11 |
| K10 | One failed busy poll stops polling | W10 | J12 |
| K11 | Zero-hit graph search shows everything | W10 | J13 |
| K12 | Deleted source remains in selected references | W05, W10-W11 | J14 |
| G01 | External memory API is not engine-aware | W08 | J18 |
| G02 | Current docs/account mapping can be mistaken for enterprise tenancy | W00-W02 | J02, J19 |
| G03 | Candidate engine/plugin/skills and shim need compatibility proof | W01 | J01, J17 |
| G04 | Source/native/capsule lineage and asynchronous invalidation need real replay | W07, W12 | J16-J17 |
| G05 | Native capsule cross-store snapshot and activation lifecycle need proof | W12 | J20 |
| G06 | Official Wiki quality arm C has no result | W15 | J23 |
| G07 | Real product retrieval/graph/office-data evaluation is missing | W15 | J24-J25 |
| G08 | Shared engine load, budgets and recovery need measured boundaries | W14, W16 | J21-J22 |
| G09 | Native/legacy external API documentation and capability reporting diverge | W08, W17 | J18 |
| G10 | Historical quotation status lacks time/version clarity | W09 | J11 |
| G11 | Output-save, reader, graph and map links exist but need complete acceptance | W09-W13 | J13-J16 |
| G12 | Local dependency and current CI failures prevent a complete green claim | W00, W16 | J00 |

G10 is a clarification/improvement, not a claim that deleted sources still show a green available link. Missing evidence is not equivalent to proven malfunction.

## 7. Work packages and executable handoff

Paths beginning with OpenScience/ or docs/ are relative to the repository root. Other apps/, packages/, deploy/ and scripts/ paths in work packages are relative to OpenScience/. A bare filename in a Modify or Tests list shares the preceding directory. All code and committed documentation remain English. UI copy remains Simplified Chinese using existing localization conventions.

### W00 — Freeze baseline and restore a trustworthy test environment

Files: OpenScience/pnpm-lock.yaml; OpenScience/package.json; existing release checklist; this plan.
Tests: existing focused KB, capsule and OpenViking suites.

- [ ] Record baseline commit, main/branch divergence, production image IDs, active engine/plugin versions and feature settings separately. Refresh before implementation; reconcile concurrent memory work rather than overwrite it.
- [ ] Install locked dependencies using pnpm install --frozen-lockfile from OpenScience. Resolve missing echarts/core and fflate through the committed workspace configuration, not unpinned ad-hoc installs.
- [ ] Supply the existing pinned-plugin fixture through the repository's approved artifact path; record its digest.
- [ ] Diagnose the current evolutionRuntime Docker failure in CI and missing database test configuration. Keep this separate from KB defects; rerun the failed environment-dependent gate.
- [ ] Create an isolated PostgreSQL test database and disposable engine volume. Secrets are runtime-only; report capabilities and hashes without values.
- [ ] Capture a machine-readable baseline inventory and test results under .evimed-local/acceptance/knowledge-integration-<run>/.

Use the exact verification commands in section 7.1. CI must supply OPEN_SCIENCE_TEST_POSTGRES_URL for a disposable local database whose name contains evimed_test; do not substitute production credentials. The existing integration fixtures enforce this restriction.

### W01 — Adopt OpenViking only through a measured compatibility matrix

Modify: OpenScience/deps-version.json; packages/contracts/openviking/; apps/server/src/openVikingClient.mjs; openVikingResources.mjs; openVikingSessions.mjs; openVikingEngine.mjs; deploy/web/openviking/; deploy/web/docker-compose.yml; scripts/ops/openviking-configuration.mjs.
Tests: openVikingClient, openVikingDeploy, openVikingEngine, openVikingShim, openVikingBackup and contract fixtures.

- [ ] Replay the existing contract against 0.5.0, then exact 0.5.1.1 candidate bytes on a copied volume.
- [ ] Measure create/replace semantics, body timeout removal, HTTP timeout versus background cancellation, task polling and three successive same-session commits.
- [ ] Verify original bytes, tags, source digests, memory retrieval, user settings and identities after migration.
- [ ] Verify native Compile identity forwarding, same-user success, other-user rejection, task status and cancellation.
- [ ] Remove shim, wrapper, configuration, mounts, health probes and obsolete assertions together only after that evidence. If proof fails, keep the compatible baseline and report candidate failure.
- [ ] Test 100/128/129+ typed pages and user-edit/Compile races. Keep existing limits until their reason is disproved on the candidate.
- [ ] Update plugin and official skill pins only to tested compatible versions; do not assume their versions equal the server version.
- [ ] Record candidate adoption or rejection. An unsuccessful upgrade does not waive the source consistency repairs.

### W02 — One application scope policy across knowledge and memory boundaries

Modify: apps/server/src/openVikingLayout.mjs; kbSearchGateway.mjs; kbBrowseGateway.mjs; memoryGateway.mjs; capsuleGateway.mjs; sourceConversationContext.mjs; sourceRoutes.mjs.
Create only if no equivalent exists: apps/server/src/knowledgeAccess.mjs.
Tests: kbSearchGateway.test.mjs, kbBrowseGateway.test.mjs, memoryGateway.test.mjs and PostgreSQL scope integration suites.

- [ ] Write negative tests for other account, other project, withdrawn library source, forged owner/URI and empty source selection.
- [ ] Resolve actor, owner and membership once through existing auth/project primitives; adapters receive the resolved context.
- [ ] Apply scope to candidate generation and recheck current eligibility before returning content.
- [ ] Keep personal-library inclusion and strict project mode explicit; preserve existing defaults unless a documented migration changes them.
- [ ] Test use-memory and learn-memory independently through attended, automated, subagent and trial paths.
- [ ] Document current upstream-account mapping; prohibit unconstrained shared Resource roots.

Contract cases to add to the existing authenticated gateway fixtures: user B cannot retrieve any title, body or count from user A's project; explicit empty selected-source scope returns no sources; a missing scope uses only the documented default, never unrestricted engine roots. The existing HTTP route may use 403 or existence-hiding 404, but must return no protected content.

### W03 — Separate logical identity from content and repair restoration

Modify: apps/server/src/sourceService.mjs; knowledgeBaseEntries.mjs; sourceFiles.mjs; productStore.mjs; productPersistence.mjs; relevant domain source helpers.
Tests: apps/server/test/sourceService.test.mjs; knowledgeBaseEntries.test.mjs; sourceDeletion.integration.test.mjs; knowledgeBaseEntries.integration.test.mjs. Reuse test/helpers/knowledgeBaseApp.mjs for real route/database cases.

- [ ] Add failing real-PG cases: delete/reupload exact bytes; note A-B-A; identical independent notes; same source saved unchanged.
- [ ] Reuse source family as logical identity where unambiguous; add an internal logical key for new independent notes.
- [ ] Preserve existing source IDs and citations; use content digests for storage deduplication, not note identity.
- [ ] Restore tombstoned source records through an explicit revision-checked operation with generation fencing.
- [ ] Inventory existing merged notes, file-hash mismatches and families with conflicting live versions. Save recoverable originals and a deterministic migration report.
- [ ] Test older citations and capsule/native provenance still resolve after migration.

Acceptance assertions:

~~~text
addNote(title, body) twice => different logical documents
delete(source); upload(same bytes) => successful registration and valid current version
parsing completes => readable/indexed as observed; before completion => accurate pending state
save(note, A); save(note, B); save(note, A) => current bytes A, no 409
registration failure => prior current bytes and record still agree
~~~

### W04 — Transactional publication, durable change jobs and fair reconciliation

Modify: apps/server/src/server.mjs upload helper; knowledgeBaseEntries.mjs; sourceService.mjs; productStore.mjs; productPersistence.mjs; openVikingSourceSync.mjs; knowledgePageWorker.mjs.
Tests: apps/server/test/sourceApp.integration.test.mjs; sourceDeletion.integration.test.mjs; knowledgePageCatchUp.test.mjs.
Create: apps/server/test/sourcePublication.integration.test.mjs and apps/server/test/openVikingSourceSync.test.mjs for publication faults and per-source reconciliation failures.

- [ ] Stage new bytes in an immutable version location, calculate digest, then publish the ledger's current pointer. All readers use the committed version: original download, note editor, parser resolution, runtime mirror/native file preview, source reader and exports. Interrupted publication cannot expose mixed bytes through an older stable path.
- [ ] Treat runtime mirroring as an acknowledged replica, not part of an imaginary cross-filesystem/SQL atomic transaction. Source-to-runtime operations name the immutable version path and check its digest; a pending mirror remains pending. Stable workspace aliases change only after a verified atomic file replacement. Ordinary user workspace files remain ordinary files, and an unchanged original is not silently rewritten to repair a knowledge ledger.
- [ ] Serialize current-version changes with database concurrency control across processes. Retire only a verified predecessor, never every family member except self.
- [ ] Publish source/library mutations and target jobs transactionally using the existing job ledger.
- [ ] Include business mutation ID/revision in job identity and ordering; test library add-remove-add and two fact updates within one source generation.
- [ ] Fence old pushes, parsing, understanding publication and deletions by current generation.
- [ ] Replace fixed-prefix reconciliation with a persisted cursor or last-checked ordering; include library-only and deleted-last-source owners.
- [ ] Inject crash points before/after file staging, transaction, job lease and engine writes; replay twice and assert one effective outcome.
- [ ] With 201 projects and 51+ active projects, verify all receive a reconciliation pass within the bounded number of cycles.

### W05 — Immediate logical revocation and selected-source validation

Modify: apps/server/src/kbBrowseGateway.mjs; kbSearchGateway.mjs; libraryService.mjs; sourceRoutes.mjs; sourceConversationContext.mjs.
Tests: kbBrowseGateway.test.mjs; kbSearchGateway.test.mjs; sourceApp.integration.test.mjs.

- [ ] Reproduce residual engine reads after source deletion in read, grep and list; cover shared copies and compiled references.
- [ ] Validate current source/library eligibility before returning original Resource text; a database failure returns unavailable, never unvalidated body.
- [ ] Keep asynchronous engine cleanup retryable and observable.
- [ ] Validate selected references on submission; return identifiable unavailable selections and preserve valid ones with a user-visible explanation.
- [ ] Distinguish retrieval revocation from physically deleting preserved history and from material already delivered in a chat.
- [ ] Verify delete, restore, delayed stale job, project removal and account re-creation cannot reintroduce old eligible content.

### W06 — Compile only an observed, consistent input snapshot

Modify: apps/server/src/knowledgePageService.mjs; knowledgePageWorker.mjs; openVikingSourceSync.mjs; openVikingResources.mjs.
Tests: apps/server/test/knowledgePages.integration.test.mjs; knowledgePageCatchUp.integration.test.mjs; knowledgePageCatchUp.test.mjs; knowledgePageThreshold.integration.test.mjs; openVikingSourceSync.test.mjs.

- [ ] Add a failure case where one push or removal fails while the engine itself remains healthy.
- [ ] Inspect reconciliation failures and actual engine digests before submitting Compile.
- [ ] Persist the successfully prepared input set; do not copy every expected source into taken.
- [ ] Retry missing work without erasing existing pages. A source change during Compile schedules the next round and retains stale attribution.
- [ ] Keep writer/Compile exclusion per target; test user edits, restart, task expiry and successful partial artifacts.
- [ ] Bound compile attempts and cost. Report partial, waiting, failed and ready separately in diagnostics.
- [ ] Ensure old pages remain usable with accurate freshness labels; do not convert this consistency requirement into a general chat-delivery block.

### W07 — Replay source changes into library, capsules and native lineage

Modify: apps/server/src/libraryService.mjs; derivedMemory.mjs; knowledgeChange.mjs; sourceDependents.mjs; nativeMemoryWorker.mjs; nativeMemoryOverlay.mjs.
Tests: library.integration.test.mjs; derivedMemory.integration.test.mjs; knowledgeChange.integration.test.mjs; nativeMemory.integration.test.mjs.

- [ ] Make source-understanding publication durable and idempotent, including text digest and generation.
- [ ] Emit library-add/remove and source-replace/revoke events to all dependent project artifacts.
- [ ] Publish source-derived capsule context only in its allowed project scope.
- [ ] Retain observed source associations on native memory, including how the association was obtained.
- [ ] Source restoration clears applicable stale labels but never resurrects explicitly forgotten or user-retired facts.
- [ ] Replay out-of-order delete-before-publish, edit-before-publish, repeated events and user corrections.
- [ ] Verify dependencies in other projects are reached only through authorized library reuse.

### W08 — Make the existing external Agent Memory API engine-aware

Modify: apps/server/src/agentMemoryRoutes.mjs; agentMemoryBoard.mjs; agentMemoryOpenApi.mjs; agentMemoryRecall.mjs; memoryRecall.mjs; memorySubstrate.mjs; agentMemoryObservations.mjs; memoryRoutes.mjs; nativeMemoryStore.mjs; server.mjs.
Update: OpenScience/docs/AGENT_MEMORY_API.md.
Create only if needed: apps/server/src/memoryEngineAdapter.mjs.
Tests: apps/server/test/agentMemoryApi.test.mjs; agentMemoryBoard.integration.test.mjs; agentMemoryRecall.integration.test.mjs. Create apps/server/test/agentMemoryNative.integration.test.mjs for native external-API cases.

- [ ] Reproduce native records returning legacy data and external episodes reporting a skipped legacy path.
- [ ] Reuse an engine router for browser and external API; no second extractor/store.
- [ ] Keep /api/agent-memory/v1, project-bound credentials, subject rules and candidate-confirmation semantics.
- [ ] Route external recall through agentMemoryRecall, memoryRecall and memorySubstrate as well as records routes. Native unavailable never falls back to legacy personal memory; preserve separately authorized capsule/method recall and pause/scope policy. Declare historical asOf capability explicitly; unsupported historical queries return a typed unsupported result rather than current data mislabeled as historical.
- [ ] Keep external material in the existing observation/candidate ledger before confirmation. Do not send it to an extracting native session first. For native episodes, stage the submitted conversation batch as a pending external-session note; return its existing candidate ID and confirmation link, with extracted=0 and no active memory until confirmation. Document this explicit compatibility behavior for native accounts in the existing API.
- [ ] Reuse /records/:id/confirm and /notes/:id/confirm; do not invent an episode-confirm endpoint. A confirmation maps candidate ID and revision to one durable admission job, then the existing native session/commit path. Store the resulting task ID and native-record lineage. A session batch can yield multiple native records; record that mapping rather than assuming one-to-one identity.
- [ ] Duplicate confirmation returns the same admission receipt. On uncertain task submission, inspect session/task state before retrying; never blindly append a batch twice. Failed native admission retains the candidate and truthful retry state. Legacy confirmation behavior stays unchanged.
- [ ] Test list/recall/edit/forget/undo/episode submission and the existing confirmation routes, native and legacy, project-bound keys, unauthorized subjects, expired credentials, unsupported asOf and engine failure.
- [ ] Update OpenAPI and examples to distinguish accepted, pending, completed and skipped, with no false-success response.

### W09 — Unified source locators and historical/current verification

Modify: apps/server/src/knowledgePageService.mjs; sourceQuotations.mjs; sourceMaterials.mjs; apps/web/src/components/sources/KnowledgePageView.tsx; KnowledgeMarkdown.tsx; SourceOriginal.tsx.
Tests: existing reader, knowledge-page and source-quotation suites.

- [ ] Resolve title and availability through the same authorized project/library source resolver as text.
- [ ] Preserve source ID/version/digest and PDF page or sheet/cell/character location when available.
- [ ] Separate original quotation check from current source availability and changed-source state.
- [ ] On reparse with changed text digest, recompute applicable quote labels even if page bytes remain unchanged.
- [ ] Show historical verification time/version without claiming a deleted source is currently readable.
- [ ] Test page, paragraph and table-cell navigation, missing locators, changed versions and broken links.
- [ ] Never label a plausible quote as verified merely because its source title exists.

### W10 — Repair frontend scope, polling, selection and search state

Modify: apps/web/src/components/sources/useKnowledge.ts; KnowledgeGraphView.tsx; knowledgeGraph.ts; apps/web/src/app/routes/SourcesPage.tsx.
Tests: useKnowledge.test.tsx; knowledgeGraph.test.ts; KnowledgeGraphView.test.tsx; SourcesPage.test.tsx.

- [ ] Add component regressions for A-to-B delayed/failed loads; clear or key state by scope before new data is actionable.
- [ ] Make retry scheduling survive failed busy polls and page visibility changes, with bounded backoff.
- [ ] Represent inactive query separately from a query with zero matches.
- [ ] Remove explicitly deleted selections while preserving valid selections on other pages.
- [ ] Test scope, count, rows, source links and chat destination together.
- [ ] Verify keyboard, narrow viewport, loading, empty, error and recovery behavior.

### W11 — Close source-to-conversation and generated-output reuse

Modify: apps/web/src/app/routes/SourceReaderPage.tsx; SourcesPage.tsx; RunFilePage.tsx; RuntimeUiFrame.tsx; apps/web/src/lib/sourceClient.ts; apps/server/src/sourceConversationContext.mjs.
Tests: SourceReaderPage.test.tsx; RuntimeUiFrameCards.test.tsx; RunFilePage.test.tsx; source routes integration.

- [ ] Keep the existing native composer and references; source actions prepare but never automatically send.
- [ ] Verify existing whole-source and node selections retain exact project/version context. Add excerpt and edge-to-chat actions with source ID, version, locator and text/evidence; test that the composer receives them without auto-send.
- [ ] Make Save to knowledge complete the registered-source/parse/index path; repeat saves remain idempotent.
- [ ] Preserve provenance when an answer or output is saved as a note; generated restatements do not count as new independent evidence.
- [ ] Exercise source selection, reader, graph, native file preview and follow-up conversation as one journey.

### W12 — Complete capsule/native lifecycle and consistent transfer

Modify: apps/server/src/capsuleTransferService.mjs; capsuleService.mjs; capsuleRoutes.mjs; nativeMemoryStore.mjs; nativeMemoryWorker.mjs; memoryAdmission.mjs.
Tests: capsuleNativeExport.test.mjs; capsuleTransferService.integration.test.mjs; capsuleRecipientKeys.integration.test.mjs; capsuleShare.integration.test.mjs; capsuleAccountLifecycle.integration.test.mjs.

- [ ] Reuse native snapshot export and existing signing/encryption; no new cryptography protocol.
- [ ] Record per-file hashes and capture times; recheck changing native files before finalizing a capsule snapshot.
- [ ] Verify preview/trial/project activation/account activation/deactivation/upgrade and sharing.
- [ ] Workstyle sharing excludes raw source content; optional knowledge items preserve provenance and declared applicability.
- [ ] Verify trial does not learn, forgetting survives re-extraction, and source restoration does not undo user intent.
- [ ] Clarify share-link revocation versus copies already imported by a recipient; do not promise remote erasure of exported bytes.
- [ ] Test source soft restoration and any already-supported project restoration separately from account deletion. Account deletion must fully revoke and clean up; this plan adds no account-undo feature. Backup restoration runs in an isolated environment and cannot give old jobs authority over a newly created account.

### W13 — Make knowledge views useful without expanding navigation

Modify: apps/web/src/app/routes/SourcesPage.tsx; SourceReaderPage.tsx; KnowledgeOpenPage.tsx; MemoryMapPage.tsx; components/sources/KnowledgePageView.tsx; KnowledgeGraphView.tsx; existing chart options/primitives.
Tests: view/component suites and focused production page walk.

- [ ] Keep one Add action and the three existing knowledge views; use shared slots and tokens.
- [ ] Add draft retention and compare/copy choices to the existing wiki editor when a save conflicts. These are bounded new affordances; the current editor does not preserve the draft.
- [ ] Make node/edge actions lead to evidence, the source reader or a prepared chat.
- [ ] Keep real small datasets visible without fabricating graph edges; provide an accessible equivalent list.
- [ ] Verify zoom, expand/collapse, full view and scope-preserving export using existing chart infrastructure.
- [ ] Keep connector state and freshness comprehensible; offer retry/refresh only where it works.
- [ ] Preserve scope/query/scroll when returning from sources; knowledge links from memory map resolve current addresses.

### W14 — Operational visibility, cost separation and shared-load behavior

Modify: apps/server/src/openVikingEngine.mjs; openVikingModelCaller.mjs; openVikingSourceSync.mjs; knowledgePageWorker.mjs; nativeMemoryWorker.mjs; existing metrics/readiness and monitoring configuration.
Tests: worker/backoff/metering suites and controlled load scenarios.

- [ ] Report resource sync, compile, native extraction and capsule-index health separately.
- [ ] Record queue age, last success, retry counts, partial failures, source counts and latest processed generation.
- [ ] Preserve platform-level metering where upstream requests lack trustworthy tenant attribution; never invent per-user exact billing.
- [ ] Test one large Compile alongside short native memory commit/recall and normal chat.
- [ ] Introduce purpose-specific concurrency/admission limits within the existing workers only if measurements show starvation; do not split services without evidence.
- [ ] Budget exhaustion leaves pending work with an explicit reason, not a false completion or irreversible discarded commit.
- [ ] Set operator alerts from measured thresholds; keep implementation details out of standard user flows.

### W15 — Evaluate actual usefulness with frozen, separate experiments

Modify: OpenScience/evals/knowledge-pages/README.md and existing harness.
Create: OpenScience/evals/knowledge-product/ with corpus manifest, cases, runner, scorer and acceptance report.
Reuse: existing general-task and memory-policy evaluation utilities.

- [ ] Run the existing A/A-prime/C comparison with genuine official compiled trees, source IDs/hashes and existing prompt/judge/threshold contracts. Keep historical B results separate.
- [ ] Freeze before evaluation: models, DSH/engine/plugin/skills, retrieval settings, source snapshots, questions and budgets.
- [ ] Use 90 unique product questions: 30 general office/code, 30 medical research, 30 lifecycle/access/adversarial-source cases; distribute across small, medium and large projects.
- [ ] Include Chinese/English, PDF/Word/text/code, spreadsheet tables, contradictions, absent answers, changed/deleted sources and identical text across projects.
- [ ] Include embedded malicious instructions as untrusted source content and an original-only audio/archive case. Original-only files remain downloadable/openable, show accurate limitations and do not claim full-text or citation support.
- [ ] Run real product kb_search/kb_browse and DSH instead of presenting offline BM25 as product retrieval.
- [ ] Measure retrieval recall, grounded factual coverage, contradictions, citation validity/coverage, source-version correctness, latency, cost and failure recovery.
- [ ] Test knowledge-only, memory-only and combined context with clean accounts; capsule activation must not contaminate the control arm.
- [ ] Report confidence intervals by independent questions, not inflated repeated-run sample size. No claimed answer-quality gain unless the preregistered interval clears zero.
- [ ] Separately measure reader/graph tasks: find evidence, follow a citation, compare versions, preserve edits, save and reuse an output.
- [ ] If quality improvement is unproven, retain useful browsing features with an honest result; do not block ordinary file delivery.

### W16 — Migration, recovery, image and release acceptance

Modify: existing scripts/ops migration/backup/readiness/release tooling and deployment manifests.
Create only the missing targeted migration and dry-run scripts, with no broad data-cleaning utility.

- [ ] Run read-only migration inventory first; preserve original source bytes, IDs, current pointers and dependency counts.
- [ ] Make additive migrations restartable and idempotent. Rehearse interrupted file/ledger publication and old-job replay.
- [ ] Back up both PostgreSQL and OpenViking native data at a compatible checkpoint; restore into a new isolated volume and verify actual content.
- [ ] Clean only unused images, completed build caches and identified temporary release files. Do not prune active persistent volumes or assume code can recreate native memories.
- [ ] Build exact web/runtime images and publish their digests with the manifest; include the tested engine candidate only if W01 passed.
- [ ] Deploy the approved batch, verify running image/config identity, then execute real user journeys with disposable accounts.
- [ ] Resolve the failing CI environment and run required PostgreSQL tests without silently counting skips as passes.
- [ ] Keep a release evidence ledger with each gate's status; no blanket “all done” while a required gate is missing.

### W17 — Documentation, review and owner handoff

Modify: OpenScience/docs/AGENT_MEMORY_API.md; WEB_OPERATIONS_RUNBOOK.md; EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md; packages/contracts/openviking/README.md; relevant product/technical docs.
Update root/OpenScience instruction files only where a verified architecture rule changed.

- [ ] Replace stale engine/version/identity statements with tested facts.
- [ ] Document project/personal scopes, memory use versus learning, source removal and capsule sharing semantics.
- [ ] Update source and memory API examples and error/pending behavior.
- [ ] Conduct code, TypeScript/JavaScript, security and database reviews for the changed files; Python review if the shim changes.
- [ ] Reconcile K01-K12 and G01-G12 against evidence. Unresolved items remain explicit.
- [ ] Present the release result and next-iteration choices to the owner. Do not begin a new iteration without that decision.

### 7.1 Exact verification commands

Run each command in the stated working directory after implementing its work package. Do not use a passed mock suite as the result of a PostgreSQL or live-engine command.

Working directory OpenScience/:

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck:server
pnpm typecheck
pnpm lint
pnpm test:contracts
pnpm verify:seams
~~~

Working directory OpenScience/apps/server/; W04 and W08 create the new suites included here:

~~~sh
node --test test/sourceService.test.mjs test/knowledgeBaseEntries.test.mjs test/knowledgeBaseEntries.integration.test.mjs test/sourceDeletion.integration.test.mjs test/sourceApp.integration.test.mjs test/sourcePublication.integration.test.mjs
node --test test/kbSearchGateway.test.mjs test/kbBrowseGateway.test.mjs test/openVikingSourceSync.test.mjs test/knowledgePages.integration.test.mjs test/knowledgePageCatchUp.integration.test.mjs test/knowledgePageThreshold.integration.test.mjs
node --test test/library.integration.test.mjs test/derivedMemory.integration.test.mjs test/knowledgeChange.integration.test.mjs test/nativeMemory.integration.test.mjs test/agentMemoryApi.test.mjs test/agentMemoryNative.integration.test.mjs
node --test test/capsuleNativeExport.test.mjs test/capsuleTransferService.integration.test.mjs test/capsuleRecipientKeys.integration.test.mjs test/capsuleShare.integration.test.mjs test/capsuleAccountLifecycle.integration.test.mjs
node --test test/openVikingClient.test.mjs test/openVikingLayout.test.mjs test/openVikingDeploy.test.mjs test/openVikingEngine.test.mjs test/openVikingShim.test.mjs test/openVikingBackup.test.mjs
~~~

Working directory OpenScience/apps/web/:

~~~sh
pnpm exec vitest run src/components/sources/useKnowledge.test.tsx src/components/sources/useKnowledgeScope.test.tsx src/components/sources/knowledgeGraph.test.ts src/components/sources/KnowledgeGraphView.test.tsx src/components/sources/KnowledgePageView.test.tsx src/components/sources/KnowledgeMarkdown.test.tsx
pnpm exec vitest run src/app/routes/SourcesPage.test.tsx src/app/routes/SourceReaderPage.test.tsx src/app/routes/KnowledgeOpenPage.test.tsx src/app/routes/RunFilePage.test.tsx src/app/routes/RuntimeUiFrameCards.test.tsx src/app/routes/MemoryMapPage.test.tsx
~~~

Working directory OpenScience/evals/knowledge-pages/; these two commands are offline and do NOT run arm C:

~~~sh
node check_corpus.mjs
node --test test/harness.test.mjs
~~~

After focused checks pass, run pnpm test:web and the configured hosted end-to-end workflow from OpenScience/. The existing C runner and new product runner require the separately frozen corpus/configuration, real engine snapshots and explicit cost caps from W15; never run a paid experiment with an unspecified default budget. Expected result for each required suite is no failures and no missing-dependency/database skips. Record intentional unrelated CI exclusions separately.

## 8. Acceptance journeys and closure evidence

| ID | Journey | Required result |
|---|---|---|
| J00 | Locked dependencies, database and plugin fixtures; current failing CI case | Executed checks with no unacknowledged missing dependency or skip |
| J01 | Baseline and candidate engine contracts | Exact bytes/config recorded; capability differences explained |
| J02 | Two accounts, same titles/content, different projects | No unauthorized content, count, title, graph edge or source identifier |
| J03 | Two identical notes; delete/reupload; A-B-A | Independent notes; successful restore; old references preserved |
| J04 | Two browser saves / two server processes | One consistent current version; no mutual retirement |
| J05 | Crash before/after publication and delayed old delete | Files and ledger agree; replay cannot remove newer data |
| J06 | Delete while engine copy remains | read/search/grep/list and new selected-source use exclude revoked source |
| J07 | Personal-library remove and cross-project dependency | Cross-project reuse stops; affected artifacts are marked/updated |
| J08 | One sync operation fails, Compile healthy | No false fully-fresh snapshot; pending work retries |
| J09 | A-to-B scope switch, delayed and failed B | No A content/actions under B; correct chat destination |
| J10 | 201 projects, library-only account, last-source deletion | Fair sweep reaches all; retired replicas cleaned |
| J11 | Library citations, historical/changed source, reparse | Valid source available; location/version and labels truthful |
| J12 | Busy poll failure, hidden tab, recovery | Status and view recover automatically |
| J13 | Graph zero hits, small data, node/edge and keyboard | Accurate results; usable evidence navigation |
| J14 | Cross-page selection then deletion | Valid selections retained; deleted reference excluded |
| J15 | Generate file, save, index, retrieve next chat | Existing output-save completes end to end, idempotently |
| J16 | Source edit, wiki edit/Compile race, memory-map navigation | User draft survives; dependent labels and destinations agree |
| J17 | Native short turn and three later commits | Each accepted commit settles; new eligible memory is searchable |
| J18 | Native and legacy external Memory API | Engine-correct reads/actions; pending confirmation; no silent skip |
| J19 | Project collaborator and personal scope | Shared project access does not grant private memory/capsules |
| J20 | Capsule export/import/trial/activate/disable/revoke | Hashes/signature valid; correct scope and learning behavior |
| J21 | Large Compile plus short memory and chat | Measured queues/latency/cost; no indefinite starvation |
| J22 | Restore PostgreSQL + engine into new environment | Native facts, source history, tags and activation remain consistent |
| J23 | Existing official-Wiki C experiment | Preserved real trees, reproducible result including negative result |
| J24 | 90-question real-product benchmark | Scope/source/version correctness; quality/cost measurements |
| J25 | Desktop/narrow-screen product walkthrough | Reader, native pane, graph and memory interactions all usable |

Mechanical invariants J02-J14, J18-J20 require zero violations in their frozen cases. Runtime performance targets are proposed: zero starvation, and foreground p95 latency under representative Compile load no more than 20% above the same candidate without that load. Record hardware, concurrency and confidence; do not invent an absolute service guarantee.

For real-product factual quality, pre-register a 2 percentage-point non-inferiority margin for grounded factual coverage and citation correctness, separately for the general and medical factual strata. A candidate is non-inferior only when the lower bound of the paired 95% interval for candidate-minus-baseline exceeds -0.02. An interval crossing that boundary is inconclusive, not a pass; add independent questions or retain that limitation rather than more repetitions masquerading as a larger sample. The 30 lifecycle/access cases are a separate zero-violation suite, excluded from factual-coverage denominators. Unanswerable questions score correct acknowledgment of missing evidence and absence of fabricated support. Use the existing C experiment's fixed decision rule for claims of improvement. Clinical controls require reviewer analysis of every material contradiction. These research findings do not withhold ordinary replies or files.

## 9. Delivery sequence and parallel ownership

All batches below are parts of this ONE proposed iteration, not automatically authorized future iterations.

1. Batch A: W00 baseline and W01 candidate lab; W02 scope contracts and W03 identity model can be prepared independently.
2. Batch B: W03-W08 source lifecycle, read revocation, Compile and memory API. Merge backend contracts before depending UI work.
3. Batch C: W09-W13 citations, frontend behavior and capsule transfer; use fixed adapters from Batch B.
4. Batch D: W14 shared-load measurement, W15 quality experiments, W16 release/recovery, W17 handoff.

Suggested worker ownership, after approval:
- Backend source worker: source identity/publication/sync/Compile. No concurrent edits to sourceService by another worker.
- Memory worker: native/legacy router, lineage and capsule transfer; coordinate server composition changes through primary.
- Frontend worker: sources reader/tree/graph/selection and focused component tests.
- Primary: architecture, contract freeze, integration, review and release evidence.
- Independent reviewers: changed code quality, scope/security, PostgreSQL concurrency, API compatibility and browser journeys. Reviewers do not approve their own implementation.

No fixed duration is promised before W00 measures dependency and migration state. The completion unit is a closed journey plus evidence, not a number of commits.

## 10. Explicitly outside this iteration

- A replacement agent kernel, RAG engine, custom wiki compiler or second automatic memory extractor.
- Moving all PostgreSQL knowledge search to OpenViking without an equivalent experiment.
- A second physical engine or organization-wide shared library without measured need and a separate ownership/migration design.
- Bulk new connectors, paid provider subscriptions, public sharing of private material.
- Rebuilding DSH's file browser or adding another chat pane.
- Automatic ingestion of every output or automatic conversion of all source text into personal memory.
- Copying every Notebook product's audio/video/quiz feature into the knowledge page. Existing capabilities may create those deliverables when asked.
- Training/fine-tuning model weights from user knowledge or memory.
- Destructive cleanup of native memory, originals, databases or active data volumes.

These exclusions are deliberate scope decisions, not hidden unfinished tasks.

## 11. Release evidence format

Each result records: baseline/candidate commit, image digest, engine/plugin/skill bytes, account type, scope, source and artifact digests, job/task outcome, test command, timing, result and remaining limitation. Never record credentials or unnecessary sensitive document text.

Track separate gates:
- code review and contract compatibility;
- unit/component tests;
- real database races and lifecycle;
- real engine/plugin/DSH integration;
- quality and usability experiment;
- image build and manifest;
- deployment and config identity;
- live user journeys;
- restored-state replay;
- owner-facing delivery record.

Only mark the approved iteration complete when its required journeys have evidence. An unresolved candidate upgrade or inconclusive quality gain must be named explicitly, with the retained compatible behavior.

## 12. Official source register

All sources were inspected through official pages or official repository results on 2026-10-23. Source summaries are paraphrases; recommendations and thresholds are EviMed design proposals.

- S01 Codex memories: https://learn.chatgpt.com/docs/customization/memories
- S02 Codex repository instructions: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- S03 Codex skills: https://learn.chatgpt.com/docs/build-skills
- S04 OpenAI Docs MCP: https://developers.openai.com/learn/docs-mcp
- S05 ChatGPT Projects: https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- S06 Company Knowledge: https://help.openai.com/en/articles/12628342/ and https://openai.com/business/plugins/company-knowledge/
- S07 Claude project RAG: https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
- S08 Claude Projects: https://support.claude.com/en/articles/9517075-what-are-projects
- S09 Claude project redesign: https://claude.com/resources/articles/projects-redesigned
- S10 Claude chat search/memory: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- S11 Claude Code memory: https://code.claude.com/docs/en/memory
- S12 Notebook source handling: https://support.google.com/gemininotebook/answer/16215270
- S13 Notebook notes: https://support.google.com/gemininotebook/answer/16262519
- S14 Notebook mind maps: https://support.google.com/gemininotebook/answer/16212283
- S15 Copilot Studio sources: https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-copilot-studio and https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-sharepoint
- S16 Glean graph/indexing: https://docs.glean.com/security/knowledge-graph and https://docs.glean.com/get-started/learn/crawling-and-learning
- S17 OpenViking types/layers: https://docs.openviking.ai/en/concepts/02-context-types and https://docs.openviking.ai/en/concepts/03-context-layers
- S18 OpenViking tenancy/ACL: https://docs.openviking.ai/en/concepts/11-multi-tenant and https://docs.openviking.ai/en/concepts/15-acl
- S19 OpenViking completion: https://docs.openviking.ai/en/concepts/16-queue-lifecycle
- S20 OpenViking Compile: https://docs.openviking.ai/en/context-compilation/01-overview
- S21 OpenViking upgrade notes: https://github.com/volcengine/OpenViking/releases/tag/v0.5.1 and https://github.com/volcengine/OpenViking/releases/tag/v0.5.1.1
- S22 Context engineering: https://www.anthropic.com/research/effective-context-engineering-for-ai-agents
- S23 Contextual retrieval: https://www.anthropic.com/research/contextual-retrieval
- S24 Citation locations: https://platform.claude.com/docs/en/build-with-claude/citations
- S25 OpenAI Retrieval consistency: https://developers.openai.com/api/docs/guides/retrieval

