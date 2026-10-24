# D — External memory API and web UI review (2026-10-23)

Scope: PART 1 external agent-memory API (`OpenScience/apps/server/src/agentMemory*.mjs`, `agentApiKeys.mjs`), PART 2 web UI (`OpenScience/apps/web/src`).
Evidence tags: VERIFIED = read in code; INFERRED = deduced from code/docs, not exercised. Paths are relative to `OpenScience/` unless absolute. Read-only review; nothing executed.

## 1. Summary

**External API.** Of the eight gaps verified on 2026-09-21, five are fixed (identity/subjects, observations intake, recall with methods + capsuleIds, API-only preset, OpenAPI wording), two are partly fixed (board API: dashboard + acts exist but packs/export/import/trial and project pause stay cookie-only; clinical face: lineage packer script + per-stage methods exist, fact kinds are still researcher-shaped), and two remain open (`organization` scope has no writer; no org-held shelf review states). Gap 8 is moot by policy (the extraction checkpoint was retired 2026-10-10) but the docs still claim a reader of `tcmToxicHerbs` that does not exist outside observations. The OpenAPI "activated 0 by construction" text is now true (`holdForOwner`).

**The one serious external finding is new: the API is engine-blind.** The native OpenViking engine is on by default whenever OpenViking is configured, and the API-only CDSS stack ships OpenViking, so the institution account and every newly created subject account are native by default. For such accounts `/episodes` is a silent no-op that still answers 202, `/recall` reads stale PostgreSQL copies instead of the engine, and `/records`, `/dashboard` and every record act (forget/edit/undo) touch rows the engine never reads. Nothing in the API, OpenAPI or docs says so.

**Web UI.** The memory page is largely LIVE and coherent with the 2026-10 rulings: map is the landing view (five views, sparse maps still drawn, partial read errors named, never zeros), three list tabs, drawers for every record, forgotten/undo/remember/share/import/received shelf all call real routes. Defects: the landing (map) page has no header controls at all (no 记忆 switch, no ⋯ menu, so sharing/import, forgotten list, project pause and reset are only reachable after switching to a list tab) and no 「刚记住了」 prompt; the Import tab shows a permanent red load error when sharing is off (default); for native accounts 已忘记的内容 can never list forgotten memories; notes proposed by an external agent (`/note` candidates) have no web surface although docs say the owner confirms them "on their memory page"; 本项目不使用记忆 acts on the shell project rather than the project the tab shows; 主题 view is empty under 12 memories. There are ten dead client functions and several server routes without a UI caller. No forbidden or back-office wording was found on screen.

## 2. External API gap re-check (verified 2026-09-21 list vs code today)

Surface today: `AGENT_MEMORY_ENDPOINTS` (apps/server/src/agentMemoryRoutes.mjs:57-65): POST /recall, /note, /episodes, /observations; GET /records, /dashboard, /methods/{id}; PUT /settings; PATCH /records/{id}; POST /records/{id}/(confirm|forget|restore|undo); POST /methods/{id}/(retire|restore|rollback); POST /notes/{id}/(confirm|reject); DELETE /subject; plus GET / and GET /openapi.json. Registered by one line `if (await agentMemoryRoutes(req, res)) return;` at server.mjs:6307; built at server.mjs:3063-3077. Switch: `config.agentMemoryApiEnabled` = `OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED`, default **false** (config.mjs:3213-3214; docker-compose.yml:437-438, .env.example:90-91). Rate limit 120/min/key, in-memory (agentMemoryRoutes.mjs:50-51).

| # | Gap (2026-09-21) | Status | Evidence |
|---|---|---|---|
| 1a | One key = one user; no subject under an integrator key | **FIXED** | Integration key `subjects:true` + `X-Subject` header, one real account per subject (`auth_type='subject'`, id `subj_<digest>`), `evimed_agent.subjects` mapping, `DELETE /subject` (agentApiKeys.mjs:60-80, 249-292; agentMemoryRoutes.mjs:150-177, 436-449). VERIFIED |
| 1b | No org fallback | **FIXED (by convention)** | Without X-Subject the request is the key's own account = "the institution" (agentMemoryRoutes.mjs:35-37, 157-159). There is no separate org object; the institution is just the key owner's account. VERIFIED |
| 1c | `organization` scope word has no reader/writer | **STILL OPEN** | `organization` is accepted as a read filter (agentMemoryRoutes.mjs:292; researchMemoryPersistence.mjs:26; memoryValidity.mjs:53 rank 0; knowledgeChange.mjs:47) but no code writes a record with `scope:"organization"` (grep of apps/server/src finds no writer). Dead vocabulary. VERIFIED (negative grep) |
| 2 | Board API only behind cookie | **MOSTLY FIXED** | Dashboard (portrait + pending + forgotten + habits + recentChanges with per-item undo), edit/confirm/forget/restore/undo, methods retire/restore/rollback + versions, switches (learningPaused/recallPaused only), note confirm/reject (agentMemoryBoard.mjs; routes 258-449). **Still cookie-only:** capsule packs list/enable/disable/trial/import/export/share (operator uses `/api/capsules/*` with a browser session, docker-compose.api-only.yml:27-31); project-level pause; "reset memory"; memory map; engine-aware reads. `recentChanges` is capped (20 items, 30 days) so it is not a full timeline. VERIFIED |
| 3 | Learning intake anchored on a run | **FIXED** | `POST /observations` (scope `memory.observe`), kernel-free counting in code, one gateway wording call, written to the same method ledger (agentMemoryObservations.mjs:1-45, 351-490; routes 313-326). Names only, no dose, toxic herbs kept aside (`TCM_TOXIC_HERBS`). VERIFIED. Requires `productDatabase && learningService`, otherwise `observations` is null and the route answers 503 (server.mjs:3071). |
| 4 | Recall returns no methods, no capsuleIds | **FIXED** | `recallForAgent` returns `methods` (own learned + capsule work-style, same selectors and budget as the mount) and honours `capsuleIds` (max 8, subject may name the institution's capsules) and `methods` mode all/own/capsules/none (agentMemoryRecall.mjs:1-244; routes 197-246). Reading counts nothing. VERIFIED |
| 5 | Clinical face: no per-stage methods/standards/lineage-card packer | **PARTIALLY FIXED** | `scripts/ops/pack-lineage-capsule.mjs` exists (header read: one `method_preference` per stage M02/M03/M04, `standards.jsonl`, `profile.md`, signed+encrypted like an export, refuses dose/identifier/unreviewed cards) and docs/AGENT_MEMORY_API.md:135-157 describe it. VERIFIED header only; body not executed. `CAPSULE_FACT_KINDS` is still the researcher vocabulary (profile, preference, behavior, stance, expertise, writing_style …, packages/domain/src/capsule.mjs:40-54); no TCM fact kinds; `/note` takes those kinds only. The MCP adapter (runtime/mcp/evimed-memory/server.py:38) carries a stale enum `preference, stance, project_fact, method, constraint, background` - three of the six (`method`, `constraint`, `background`) are not valid kinds, so `memory_recall factKinds:["method"]` would 400. It also passes no `capsuleIds`, `methods`, or `X-Subject`. VERIFIED |
| 6 | Org shelf and review | **STILL OPEN (partly worked around)** | Institution's shelf = the key owner's account capsules; a subject may name them via `capsuleIds` (agentMemoryRecall.mjs:57-68). No pack-level draft/reviewing/effective/retired, no reviewer: grep of capsuleService/capsuleTransferService finds none. Pack governance lives only in the lineage card / import "publisher unverified" label. VERIFIED (negative grep) |
| 7 | No API-only preset; API off by default | **FIXED / by design** | `deploy/web/docker-compose.api-only.yml` switches the API on and drops runtimes/web app; docs/AGENT_MEMORY_API.md. Default in the base stack remains off (503 `agent_memory_disabled`, including openapi.json). VERIFIED |
| 8 | Checkpoint vocabulary western-only | **MOOT / PARTIAL** | The extraction checkpoint was retired by the 2026-10-10 owner ruling (memoryIntelligence.mjs:108-139: only `external_source` hold remains). Toxic-herb list exists as data (`tcmToxicHerbs`, packages/domain/src/clinical-safety-rules.json) and is read ONLY by observations (never-learned). docs/AGENT_MEMORY_API.md:117-119 still claims "the memory checkpoint and the capsule import scan read" it; grep shows no such reader in capsuleTransferService/capsuleContainer/memoryIntelligence -> **docs stale**. VERIFIED |

### OpenAPI wording "always pending / activated 0 by construction"
**Not stale now.** It is true by construction: `/episodes` calls `recordRun(..., {holdForOwner:true})` which writes everything `pending` and refuses changes to in-force memories (memoryIntelligence.mjs:1331-1441); the route reports `activated` from the outcome (agentMemoryRoutes.mjs:356-371) and OpenAPI says so (agentMemoryOpenApi.mjs:68, 371-377). The earlier mismatch (extraction activating everything) was fixed by `holdForOwner`. Residual: the route comment says "Zero on this path by construction" but the value is read from the outcome rather than forced to 0; harmless. VERIFIED. Note the **native-engine case below breaks the "pending" story differently**: nothing is written at all.

### Behaviour for a NATIVE (OpenViking) account vs legacy — **the API is legacy-only and not engine-aware** (VERIFIED)
- Zero references to native/engine in agentMemory*.mjs, agentApiKeys.mjs (except the deletion hook) or their tests (grep `native|engine`).
- Default engine: `ovNativeMemoryEnabled` defaults to **true whenever OpenViking is configured** (config.mjs:324,344), and a new account's engine row is decided on first `memoryEngine()` call as `native` when the deployment has it (researchMemory.mjs:1887-1898). The api-only stack ships OpenViking (docker-compose.api-only.yml header), so by default the institution account and every newly created subject account are **native**.
- Effects for a native account:
  1. `POST /episodes`: `recordRun` returns `skippedResult("native_engine")` (memoryIntelligence.mjs:1249-1252): proposed/extracted/pending all 0, HTTP 202 - the integrator is told success while nothing was learned. No `source`/`skipped` field is returned by the route, so the caller cannot tell. DEFECT.
  2. `POST /recall`: passes `memorySubstrate` unconditionally (agentMemoryRoutes.mjs:226-228); the in-runtime path deliberately passes `null` for a native account (capsuleGateway.mjs:163-166). So the external API reads the PostgreSQL record copies "left as they are" for the fallback window (stale or empty), never the engine's own memories. Capsule facts and methods still work. DEFECT.
  3. `GET /records`, `/dashboard`, record acts, `PUT /settings`: all go to `researchMemory` (PostgreSQL) -> a native account's engine memories are invisible, and edits/forgets/undo change rows the engine never reads. A forget through the API does not forget in the engine. DEFECT (privacy-relevant: "forget" is silently ineffective for native).
  4. `POST /note` goes to capsules (PostgreSQL product ledger), engine-independent: works.
  5. `/observations` and methods: learning ledger, engine-independent: works.
  6. `DELETE /subject` does erase native data (`nativeMemory.erase`, server.mjs:1680-1681): correct.
  7. No `memory_engine_unsupported` code and no `engine` field anywhere in the API/OpenAPI; docs/AGENT_MEMORY_API.md:7-8 says "the same PostgreSQL records the workbench's memory page shows", false for native accounts.
- Workaround today: set `OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED=false` in the CDSS deployment (then every account is `legacy`), or move the institution account with `scripts/ops/memory-engine.mjs`; subject accounts created later still follow the deployment default. INFERRED (config logic read; not run).

### Other API findings
- `GET /records` accepts `status=archived` etc. but on `kind` lists omits `stance/expertise` etc. (fine; those are capsule kinds). Records `scope=organization` filter returns nothing ever (see 1c).
- `/note` for a subject without a given project: `projectOf(user, "default")` ok; for the institution account without `projectId` it writes a project-less note (capsules.note gets null) - INFERRED fine.
- Rate limiter keyed by keyId, in-process only: with more than one control-plane replica the limit is per replica. Minor.
- Tests: `apps/server/test/agentMemory{Api,Board,Observations,Recall}*.test.mjs` (56 cases) use doubles; none exercise a native account. INFERRED from grep (no `native` string).

## 3. UI element -> client call -> server route

Web paths relative to `OpenScience/apps/web/src`; server files in `OpenScience/apps/server/src`. Route registration order in server.mjs:6325-6328 (capsules, learning, handbooks), 6764-6766 (memory map, memory, memory timeline). "Switch" column = the server-side gate that decides whether the element works.

Routes: `/app/memory` (MemoryHubPage), `/app/memory/map` (MemoryMapPage), `/app/memory/shared/:token` and `/app/memory/delivered/:id` (SharedCapsulePage), router.tsx:139-144; `/app/capsules` redirects to `?tab=capsules` which the page ignores (falls to the default tab). Sidebar entry 「记忆胶囊」 Sidebar.tsx:65.

### 3.1 Memory page frame and lists (app/routes/MemoryHubPage.tsx)
| Element | Client | Server route | Engine / switch notes |
|---|---|---|---|
| Landing: plain `/app/memory` redirects to the map when `me.features.memoryMap` is on (MemoryHubPage.tsx:100-104) | `useMemoryMapFeature` (lib/memoryMapFeature.ts) reads `/api/me` | `/api/me` | `OPEN_SCIENCE_MEMORY_MAP_ENABLED`, default follows `OPEN_SCIENCE_MEMORY_ENABLED` (true), config.mjs:3189 |
| Tabs 地图 · 关于你 · 项目 · 做法 (MemoryFrame.tsx:12-28) | - | - | 地图 hidden when the flag is off |
| Reads feeding lists: profile / my capsule / methods / handbooks (useMemoryReads.ts:35-47) | `fetchMemoryProfile` -> `GET /memory/profile`; `fetchMyCapsule` -> `GET /capsules/mine`; `listAllMethods("approved")` -> `GET /methods`; `listAllHandbooks("active")` -> `GET /handbooks` | memoryRoutes.mjs:276 (native branch -> `nativeMemory.profile`); capsuleRoutes.mjs:75; learningRoutes.mjs:138; handbookRoutes.mjs:62 | Both engines served. Native profile carries `conversations:{}` and `usage:{}` (nativeMemoryStore.mjs:327-336) so 来源对话 titles are absent. Each read fails independently, failed list != empty list (MemoryHubPage.tsx:212-213, 295) |
| Search box (250 ms debounce, server side) | `searchMemories` -> `GET /memory/search?q=` | memoryRoutes.mjs:383 (native `nativeMemory.search`) | no sort control, no hit highlighting |
| Header switch 「记忆」 (only on list tabs) | `updateMemorySettings` -> `PUT /memory/settings` (learningPaused+recallPaused together) | memoryRoutes.mjs:140; native also archives pre-pause sessions (memoryRoutes.mjs:152-165) | both engines |
| ⋯ > 本项目不使用记忆 | `updateMemorySettings({pausedProjects})` with `getWebProjectId()` (MemoryControls.tsx:46,106-119) | same | targets the shell's project, not the 项目 tab's chosen one (defect 6) |
| ⋯ > 重置记忆 (ConfirmDialog) | `resetMemory` -> `POST /memory/reset` | memoryRoutes.mjs:174 | both engines (native erases files + overlay) |
| ⋯ > 分享与导入 | opens ShareDrawer | see 3.3 | |
| ⋯ > 已忘记的内容 | opens ForgottenDrawer | see 3.2 | |
| Button 记住这一条 (only when `profile.engine==="native"`, MemoryHubPage.tsx:374) | `rememberMemory` -> `POST /memory/remember` | memoryRoutes.mjs:211; legacy answers 400 `memory_engine_unsupported` | hidden for legacy accounts (no UI path, so the 400 is never hit) |
| Pending rows 「正在记住」 + 3 s poll for 60 s | `usePendingMemory` re-reads profile | - | native only (`pending` from overlay) |
| Write prompt toast 「刚记住了 N 条 撤销」 | `fetchMemoryChanges` -> `GET /memory/changes`; undo `undoMemoryRecord` -> `POST /memory/records/:id/undo` | memoryRoutes.mjs:259, 449 (native branch) | fires only inside MemoryHub (list tabs), not on the map landing (defect 3) |
| 项目 tab overview (card, 这个项目做过, 作品) | `fetchProjectOverview` -> `GET /memory/projects/:id/overview` | memoryRoutes.mjs:319 | both engines (native: project-context memory) |
| Row -> FactDrawer; method row -> MethodDrawer; handbook row -> HandbookDrawer | see 3.2 | | |

### 3.2 Drawers
| Element | Client | Server route | Notes |
|---|---|---|---|
| FactDrawer 编辑/保存 (record) | `updateStructuredMemory` -> `PATCH /memory/records/:id` (native: summary/importance stripped client side, apiClient.ts:1710-1712) | memoryRoutes.mjs:477-560 | native refuses summary/importance with `memory_engine_unsupported`; the client avoids sending them |
| FactDrawer 确认 (pending record) | same PATCH `status:"active"` | same | legacy only; native has no pending (`pendingCount:0`) |
| FactDrawer 忘记 | `archiveMemoryRecord` -> PATCH `status:"archived"`; toast 撤销 -> `undoMemoryRecord` | same; native `update()`->`remove(keepText)` (nativeMemoryStore.mjs:507-516) | native: forgotten text lives in overlay revisions only |
| FactDrawer 撤销上次改动 (menu) | `undoMemoryRecord` | memoryRoutes.mjs:449 | both |
| FactDrawer 不再记这条 (delete + reject) | `deleteStructuredMemory` -> `DELETE /memory/records/:id` | memoryRoutes.mjs:565 / native `remove(keepText:false)` | both |
| FactDrawer 以这条为准 (conflict) | `settleMemoryConflict` -> `POST /memory/conflicts/resolve` | memoryRoutes.mjs:428; native answers `memory_engine_unsupported` (line 430) | button only drawn when `record.relations.conflicts` exist, which native records never have -> no dead button |
| FactDrawer 关联 section | `fetchRecordLinks` -> `GET /memory/records/:id/links` | memoryMap.mjs LINKS | native via `createNativeRecordLinks` (server.mjs:5040) |
| FactDrawer 依据的资料 | `fetchMemorySources` -> `GET /memory/records/:id/sources` | memoryRoutes.mjs:350 | |
| FactDrawer on a capsule note (entry): edit/forget/undo | `updateCapsuleEntry` PATCH `/capsules/:id/entries/:eid`; `retireCapsuleEntry` PATCH; `undoCapsuleEntry` POST `.../undo` | capsuleRoutes.mjs:336-342 | engine independent |
| MethodDrawer 不再使用 / 回到上一版 / 以前的版本 / 从哪里学到的 | `retireMethod` POST `/methods/:id/retire`; `rollbackMethod` POST `/methods/:id/rollback`; `methodVersions` GET `/methods/:id/history`; `methodSources` GET `/methods/:id/sources` | learningRoutes.mjs (parts 1-2) | engine independent; needs learning service |
| HandbookDrawer same set | `/handbooks/:id`, `/history`, `/retire`, `/rollback` | handbookRoutes.mjs | |
| ForgottenDrawer list | profile `status==="archived"` records + `mine.forgotten` + `listAllMethods("retired")` + `listAllHandbooks("retired")` (ForgottenDrawer.tsx:43-79) | profile, `/capsules/mine`, `/methods?status=retired`, `/handbooks?status=retired` | **native profile never contains archived records** (nativeMemoryStore.mjs:228-250 lists live files only) |
| ForgottenDrawer 恢复 | memory: `updateStructuredMemory(status:"active")`; note: `restoreCapsuleEntry`; method/handbook: rollback | PATCH records/:id; PATCH entries/:eid; rollback | legacy ok; native memory row can never appear so never clicked |
| RememberDialog | `rememberMemory` | `POST /memory/remember` | native only |

### 3.3 Share / export / import / received shelf (CapsuleTransferPanel.tsx, components/capsule/*)
| Element | Client | Server route | Switch / notes |
|---|---|---|---|
| ShareDrawer opens -> ensure own capsule | `ensureMyCapsule` -> `POST /capsules/mine` | capsuleRoutes.mjs:75-77 | |
| Export tab: 署名, scopes checkboxes, 「对方会看到什么」 | `previewCapsuleExport` -> `POST /capsules/:id/exports/preview` | capsuleRoutes.mjs:239 | native-aware (capsuleTransferService.mjs:305). Entries are listed but not individually removable (spec 9.3 says each can be ticked off) |
| 加密导出 | `exportCapsule` -> `POST /capsules/:id/exports` (password) + `saveCapsuleDownload` | capsuleRoutes.mjs:226 | `productDocuments` required; KDF concurrency gate `OPEN_SCIENCE_CAPSULE_KDF_*` |
| 导出的版本: 再次下载 / 更新并下载 / 撤回 | `listCapsuleExports` GET exports; `downloadCapsuleExport` GET exports/:sid; `revokeCapsuleExport` DELETE exports/:sid; with sharing on `takeDownSnapshot` POST exports/:sid/takedown | capsuleRoutes.mjs:225,242-258,200 | takedown only when `capsuleShare` on |
| 分享给平台里的人 (panel) | `deliverCapsule` POST `/capsules/:id/deliveries`; `listSentDeliveries`; `createShareLink` POST `/links`; `listShareLinks`; `revokeShareLink`; `downloadMethodPack` GET `/capsules/:id/methods/export?format=agent-skills` | capsuleRoutes.mjs:159-198 | whole panel is drawn only when `useCapsuleShareFeature()==="on"` = `OPEN_SCIENCE_CAPSULE_SHARE_ENABLED`, **default false** (config.mjs:746). Note 导出做法 (method pack) lives inside this panel, so it disappears with sharing off although `/methods/export` does not need the switch (capsuleRoutes.mjs:188 is outside `shares()`) |
| Import tab: file, password, 预览, 收下 | `previewCapsuleImport` POST `/capsules/transfers/preview`; `importCapsule` POST `/capsules/transfers/import` | capsuleRoutes.mjs:211-222 | |
| 待收下的分享 (rows, 收下, 不需要) | `listPendingDeliveries` GET `/capsules/deliveries`; `openDelivery`, `importDelivery`, `declineDelivery` | capsuleRoutes.mjs:117-136 | `shares()` throws 404 `capsule_share_not_enabled` when sharing is off; **ReceivedShelf is rendered unconditionally** (CapsuleTransferPanel.tsx:308) so `PendingDeliveries` shows a LoadError (defect 4) |
| 收到的胶囊 rows: switch 启用/停用 | `fetchReceivedCapsules` GET `/capsules/received`; `enableReceivedCapsule` POST `/capsules/:id/enable`; `disableCapsule` POST `/capsules/:id/disable` | capsuleRoutes.mjs:71,285-300 | toast 撤销 calls disable. Max 8 enabled enforced server side (INFERRED) |
| 试用一次 | `startCapsuleTrial` POST `/capsules/:id/trial` then `navigate("/app/chat", runtimeUiIntent)` | capsuleRoutes.mjs:302 | needs a runtime; in the API-only stack there is none |
| 只在“项目”启用 | `enableReceivedCapsule(id, projectId)` | same | |
| Share link page / delivery page | `openShareLink`/`importShareLink`; `openDelivery`/`importDelivery`/`declineDelivery`; then 试用一次 or 启用 | capsuleRoutes.mjs:117-150 | gated by sharing switch; failure screen is honest (SharedCapsulePage.tsx) |
| Evidence-zone subscribe row (EvidenceZonePage.tsx:329) | `zoneSubscriptionStatus`/`subscribeZone`/`unsubscribeZone` -> `/capsules/subscriptions` | capsuleRoutes.mjs:91-115 | needs `subscriptions.enabled` and frontier audience; outside the memory page |

### 3.4 Memory map (app/routes/MemoryMapPage.tsx, components/memory/map/*)
| Element | Client | Server route | Notes |
|---|---|---|---|
| Whole page document | `fetchMemoryMap` -> `GET /memory/map?include=summary,facets,nodes,edges,buckets,lanes,events` | memoryMap.mjs:477 | sources assembled; a failing source goes to `doc.missing`, named on screen (MemoryMapPage.tsx:196-201). Native account drawn from engine files (server.mjs:5025-5026) |
| Views 关系 / 主题 / 维度 / 时间 / 活跃 (chips in toolbar, one selection in the address) | none (switch over the one document) | - | mapToolbar.ts; all five LIVE |
| Project scope (header), time range, kind, 只看需要看一眼的, search | none (client narrowing) | - | |
| Mark -> drawer (record / method) or page | `MapDrawer`: `fetchMemoryProfile`, `listAllMethods("approved")` | profile, methods | the same FactDrawer / MethodDrawer, so edit/forget/undo work on marks. A method that is not `approved` has no drawer ("这条做法已经不在了") |
| 这条关联不对 (hide edge) + toast 撤销 | `hideMapEdge` -> `PUT /memory/map/edges/:id` | memoryMap.mjs:68-73 (needs `MapEdgeCorrections`, productDatabase) | |
| 主题: rename / merge / 不是这个 | `editTopic` -> `PATCH /memory/topics/:id` | memoryMap.mjs:109 | |
| 主题 regroup request | `refreshTopics` -> `POST /memory/topics/refresh` (from useMemoryMap) | memoryMap.mjs:104 | server groups only with at least 12 eligible memories (config default 12) |
| Thin map (no node but 「you」): 3 numbers + 去对话 | none | - | MemoryMapPage.tsx:150-164 |
| Header controls on the map page | **none** (`MemoryFrame` called without `actions`, MemoryMapPage.tsx:186-190) | - | defect 3 |

## 4. Design-point table (build spec A3/A5, 10.1-10.7, 11; owner rulings of 2026-10-10/12/19)

Status: LIVE = works as designed; PARTIAL = exists with a defect or reduced; DEAD = code exists nothing reaches it; MISSING = not built. "By ruling" = absent on purpose because a later owner ruling removed it.

| # | Design point | Status | Evidence |
|---|---|---|---|
| 1 | One page at `/app/memory`, nav name 「记忆胶囊」 (10.1) | LIVE | router.tsx:139; Sidebar.tsx:65; MemoryFrame.tsx title |
| 2 | One-sentence definition under the title; "EviMed 眼中的你" three sentences; 最近变化 block | MISSING, by ruling | removed by the 2026-09-23 plan (memoryClient.ts:137-141; MemoryHubPage.tsx:74-80); "page header has no subtitle" rule. `/api/memory/timeline|growth|learned` still served (memoryTimeline.mjs:611-621) with no web caller |
| 3 | Two switches (总开关, 本项目不用) + reset in the header (A3) | PARTIAL | present on the three list tabs (MemoryControls.tsx); **absent on the map landing page**; the project switch targets the shell project, not the 项目 tab's project (MemoryControls.tsx:46) |
| 4 | Memory visualization is the landing view with five views (owner 10-12/10-19) | LIVE | MemoryHubPage.tsx:100-104 redirect; five views mapToolbar.ts:9-12; VERIFIED in code, not rendered |
| 5 | Sparse records still drawn; small-sample chart choices | PARTIAL | graph draws unless no node besides 「you」 (mapModel.ts:134); dims fall back to bars (DimsView.tsx:19-23); topics shown from 1 topic (TopicsView MIN_TOPICS=1) **but** the server makes no topics below 12 eligible memories (memoryTopics.mjs:327; config.mjs:3200) so 主题 is empty for small accounts |
| 6 | Partial read errors never become zeros | LIVE | `doc.missing` -> LoadError naming the part; `empty` requires `missing.length===0` (MemoryMapPage.tsx:182); thin tiles suppressed when missing (line 153); list tabs: `tabUnread`/`unread` (MemoryHubPage.tsx:212-213,295); small residual: Time/Activity empty-state sentences ("还没有记下的事…") still render beside the banner |
| 7 | Search: one box, 250 ms debounce, server side, keyword+semantic union (10.3) | PARTIAL | LIVE for debounce/server union (MemoryHubPage.tsx:147-158); MISSING sort (最近使用/最近更新) and hit highlighting; does not search source-conversation titles or project names |
| 8 | Row composition: sentence, source chip, strength, source conversation, usage (10.2) | MISSING, by ruling | MemoryRows.tsx header: "no mark of where it came from"; provenance/usage removed 2026-10-10. Source conversation link and 以前的版本 / 曾经如此 remain in the drawer (FactDrawer.tsx) -> LIVE |
| 9 | Row actions: 改 · 忘记 (toast 撤销) · 不对 (delete, one confirm) · 撤销上次改动 · 恢复; method: 停用 · 回到上一版 | LIVE (legacy), PARTIAL (native) | FactDrawer/PracticeDrawer. Native: forgotten memories cannot be listed or 恢复d (see defect 5); only the 8-second toast undo |
| 10 | Timeline: derived from ledgers, no second writer, each change undoable (10.4) | PARTIAL | now the map's 时间 view (TimeView.tsx): weekly bars + lineages, events open the record drawer where undo lives; the old "最近变化 (5)" with per-row undo is gone (by ruling). The 「刚记住了 … 撤销」 prompt (`useMemoryWritePrompt`) exists but runs only on list tabs |
| 11 | No in-chat controls (10.5) | LIVE | no memory UI in chat components (grep of RuntimeUiFrame/runs components) |
| 12 | Write prompt only as a toast on the capsule page; inbox notices silent but deep-link | PARTIAL | toast: list tabs only (defect 3). Inbox deep-link: InboxPage.tsx:442 (`?record=`), MemoryHubPage.tsx:181-209 opens the drawer |
| 13 | Received shelf: whole-pack 启用/停用, 试用一次, project-scoped enable, version upgrade preview (A5, 9.4) | LIVE | ReceivedShelf.tsx; upgrade shown in ImportPanel ("会更新你已收下的…") |
| 14 | Pending delivery shelf 待收下的分享 | PARTIAL | live when sharing is on; shows a red load error when sharing is off (defect 4) |
| 15 | Send: scopes, "对方会看到什么", password, 发出的版本 with 更新/撤回 (A5, 9.3) | LIVE | ExportPanel; the preview is read-only (no per-entry untick); withdraw text says what cannot be taken back |
| 16 | In-platform delivery + one-time link (spec: "second phase") | PARTIAL | built (CapsuleSharePanel, SharedCapsulePage) but behind `OPEN_SCIENCE_CAPSULE_SHARE_ENABLED` default false |
| 17 | Method pack export (agent-skills zip) | PARTIAL | server route is ungated; UI button lives inside the sharing panel so it vanishes when sharing is off |
| 18 | Forgotten list 已忘记的内容 (30-day restorable) | PARTIAL | legacy LIVE (memories, notes, methods, handbooks); native: memories absent (defect 5). No 30-day expiry logic seen in UI (INFERRED: not checked server side) |
| 19 | 「记住这一条」 | LIVE for native only | by design; legacy has no entry |
| 20 | Per-account engine awareness in the UI | LIVE | `data.profile.engine`, `isFileMemory`, `memoryNative.ts`, summary stripping (apiClient.ts:1710) |
| 21 | Forbidden / back-office wording on screen (10.6; owner 10-10) | LIVE (no violation found) | grep of memory/capsule/map UI for 置信度, 候选, approved, SKILL.md, digest, 蒸馏, 无痕, 签名, 扫描, 未验证, 推断, engine names: only identifiers and fixtures. Non-violations worth noting: 「待确认」 tag on a pending record (a state the owner acts on, not provenance); 「来源已撤回/已过期/已更改」 badges (source state, content-relevant) |
| 22 | Key management UI for the external API | MISSING | no web caller for `/api/agent-keys` (docs: "There is no management page for keys yet"); operator uses curl |
| 23 | Interface contracts (spec 11) vs routes | PARTIAL | `records/:id/usage`, `packs/:id/{trial,enable,disable,dropped}` of the spec are `/capsules/:id/{trial,enable,disable}` in code; no `dropped` route (owner 10-10 hid scan results) |

### 4.1 Dead client functions (no caller outside tests)
- lib/apiClient.ts:1653 `fetchMemoryStatus` (`GET /memory/status` has no other caller)
- lib/memoryClient.ts:92 `retireLearnedMethod`, :97 `restoreLearnedMethod` (leftovers of the removed in-chat 「不对」)
- lib/productClient.ts: `listCapsules` (:75), `createCapsule` (:80), `listCapsuleEntries` (:81), `addCapsuleEntry` (:84), `activateCapsule` (:90), `trashCapsule` (:93), `restoreCapsule` (:96)

### 4.2 Server routes with no UI caller
- `/api/memory/timeline`, `/api/memory/growth`, `/api/memory/learned` (memoryTimeline.mjs:611-621, wired at server.mjs:6766)
- `GET /api/memory/status`, `GET /api/memory/records` (the page uses `/profile` and `/search`)
- `/api/capsules` list/create, `DELETE /api/capsules/:id`, `POST .../restore`, `POST .../activate`, `GET|POST .../entries`, `.../history`, `GET /capsules/active`, `POST /capsules/recall` (runtime/agent side), `POST /capsules/takedowns` (operator, curl only)
- `/api/agent-keys`, `/api/agent-memory/v1/*` (external by design)

### 4.3 Elements backed by a default-off switch
- 分享给平台里的人 panel, 导出做法, 待收下的分享, share link and delivery pages: `OPEN_SCIENCE_CAPSULE_SHARE_ENABLED=false`.
- Evidence-zone subscription row: frontier + subscriptions switches.
- 地图 tab: on by default (follows memory).
- 主题 view data: `OPEN_SCIENCE_MEMORY_TOPICS_ENABLED` default true, needs 12 memories.
- 记住这一条: native engine only.
- External API: `OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=false` (true only in the api-only overlay).

## 5. Defects, ranked

1. **HIGH, API: the agent-memory API ignores the memory engine.** Native is the default when OpenViking is configured (config.mjs:324,344; researchMemory.mjs:1887-1898), and the api-only stack includes OpenViking. For a native institution/subject account: `POST /episodes` -> `recordRun` returns `skippedResult("native_engine")` (memoryIntelligence.mjs:1249-1252) and the route still answers 202 with zeros (agentMemoryRoutes.mjs:354-371), no skipped/engine field; `POST /recall` passes `memorySubstrate` unconditionally (agentMemoryRoutes.mjs:255) where the in-runtime gateway passes null for native (capsuleGateway.mjs:163-166) so it reads stale PostgreSQL copies; `GET /records`, `/dashboard`, edit/forget/undo/confirm use `researchMemory` only, so a forget through the API does not forget in the engine. No test covers it; docs (AGENT_MEMORY_API.md:7-8) describe PostgreSQL only. Options: pin subject accounts and the institution to `legacy` on creation for this API, or route reads/acts to `nativeMemory` and make episodes answer `memory_engine_unsupported`; at least return `engine` and `skipped` in responses. VERIFIED (code), not exercised.
2. **MED-HIGH, API+UI: notes proposed through `POST /note` are invisible in the web UI.** `capsules.mine` reads `approved` and `retired` only (capsuleService.mjs:206-211) and no web code reads `candidate`; OpenAPI/docs say the owner confirms "on their memory page". Only a `memory.manage` key can confirm/reject (`/notes/{id}/confirm|reject`). Legacy `pending` records from `/episodes` do show with 待确认 + 确认. VERIFIED.
3. **MED, UI: the landing page has no header controls.** `/app/memory` now redirects to the map, which renders `MemoryFrame` without `actions` (MemoryMapPage.tsx:186-190): no 记忆 switch, no ⋯ (分享与导入, 已忘记的内容, 本项目不使用记忆, 重置记忆), no 记住这一条, and `useMemoryWritePrompt` never runs. A person who lands on the map cannot pause memory or reach sharing without first clicking 关于你/项目/做法. Spec A3 wants the switches on the page. VERIFIED.
4. **MED, UI: permanent red error on the Import tab when sharing is off (the default).** `ReceivedShelf` is rendered unconditionally (CapsuleTransferPanel.tsx:308); `PendingDeliveries` calls `GET /capsules/deliveries`, the server answers 404 `capsule_share_not_enabled` (capsuleRoutes.mjs:117-119), and the component shows 「暂时读不到待收下的分享。」 with 重试 (ReceivedShelf.tsx:73). Gate it with `useCapsuleShareFeature()==="on"`. VERIFIED.
5. **MED, UI+engine: native accounts cannot see or restore forgotten memories.** The native `records()` lists live files only (nativeMemoryStore.mjs:228-250); ForgottenDrawer builds its memory rows from `status==="archived"` records (ForgottenDrawer.tsx:43-50), so for native accounts only notes/methods/handbooks appear. The only restore is the toast 撤销 right after forgetting. Spec 10.2 promises a restorable archive. VERIFIED.
6. **LOW-MED, UI: 本项目不使用记忆 targets the wrong project.** It toggles `getWebProjectId()` (the shell's current project, MemoryControls.tsx:46), while the 项目 tab shows whichever project the dropdown selects and the overview line 「本项目已暂停记忆」 reads that project's flag (ProjectOverview.tsx:108). Viewing project B and pressing the menu item pauses project A. VERIFIED (code reading).
7. **LOW-MED, UI vs ruling: 主题 view empty for small accounts.** The server will not group below 12 eligible memories (memoryTopics.mjs:327, config.mjs:3200 min 4 default 12) though the client is built to draw a single topic. Against the 2026-10-19 ruling "sparse real records remain visible". Consider a client-side or deterministic grouping (by kind/project) for small samples. VERIFIED.
8. **LOW, UI: sharing-related features hidden together.** 导出做法 (method pack) needs no sharing switch server-side but is inside the share panel, so it disappears with the default config. VERIFIED.
9. **LOW, API: MCP adapter drifted.** `FACT_KINDS` enum contains `method`, `constraint`, `background` (server.py:38) which the API rejects; `memory_recall` has no `capsuleIds`/`methods`, and neither tool can send `X-Subject`, so the adapter cannot serve the CDSS use case. VERIFIED.
10. **LOW, docs: AGENT_MEMORY_API.md is stale in three places.** "same PostgreSQL records" (native), toxic herbs "read by the memory checkpoint and the capsule import scan" (only observations read `tcmToxicHerbs`), "owner confirms ... on their memory page" for notes (defect 2). VERIFIED.
11. **LOW, API: `organization` scope** is accepted by `/records` filters and ranked in validity code but has no writer anywhere; gap 1c still open. Org shelf review states (gap 6) still absent.
12. **LOW, UI: search lacks sort and highlight** (spec 10.3); source-conversation titles and project names are not searched.
13. **LOW, hygiene: ten dead client functions and unreferenced routes** (4.1, 4.2); `useMemoryWritePrompt`'s `SEEN_KEY` is one global localStorage key although its comment says per account and project (useMemoryWritePrompt.ts:7), so two accounts in one browser share the clock.
14. **LOW, API: rate limit is per process** (agentMemoryRoutes.mjs:50-51); fine for one replica, wrong for several.

## 6. Open questions

1. Is the external dashboard (`BOARD_SOURCES` labels 本人设置 / 从改方学习 / 系统推断 / 来自研究) covered by the owner's 2026-10-10 rule that back-office provenance is never shown to users? The CDSS plan asks for these labels; the platform's own pages dropped them. Decide whether the CDSS may show them.
2. For the CDSS deployment, which engine is intended: native (then the API must be rebuilt on `nativeMemory`) or legacy (then pin `OPEN_SCIENCE_OV_NATIVE_MEMORY_ENABLED=false` in the api-only overlay and say so in docs)? The current default in that overlay is accidental.
3. Should external `/note` candidates be listed on the memory page, or is the API dashboard the only intended confirmation surface? (docs say both)
4. Should the map landing page carry the header controls, or should the landing be the first list tab with the map one click away? The owner ruling names the visualization as the landing view; the spec names the switches as part of the page.
5. Is a topics view for fewer than 12 memories wanted (deterministic grouping), or is the empty state the accepted answer to "sparse records remain visible"?
6. Spec 9.3 "每条可勾掉" (untick entries before export) and 10.3 sort/highlight were not found: confirm they are dropped, not pending.
7. Not verified: a live account on the production deployment (no server or browser was started). All statements above are from code reading; no tests were run.
