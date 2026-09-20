# B — Shell pages, navigation and the session frame lifecycle (read-only code audit, 2026-09-20)

Produced by a read-only sub-investigation for `../2026-09-20-产品现状根因分析与一次性整改方案.md`. File and line references are as of commit 70683e97a.

I have the full picture. Report follows.

---

## A. Capabilities

**Current flow.** `/app/capabilities` renders compact rows (`CapabilitiesPage.tsx:223-246`); a click sets `?capability=<id>` (`:105-110`) and opens a **right-side `Drawer`** (`:202-217`) holding `CapabilityCard`.

- **「开始」** (`CapabilityStart.tsx:96-98` → `start` at `:41-57`) → `dispatchResearch(capabilityTarget(agent), text)` (`lib/dispatch.ts:49-62`): mints `web-<uuid24>` session id, `PUT /api/research-sessions/:id` with `{mode:"specialist", agentId, agentVersion}` (`apiClient.ts:1575-1587`), then `POST` dispatch. The control plane then skips routing (`effectiveRouteReason:"session-binding"`, `agentRuns.mjs:4131`). The user **stays on the capabilities page**; `onDispatched` closes the drawer and shows a `DispatchReceipt` banner at the top (`CapabilitiesPage.tsx:155-159`, `components/runs/DispatchReceipt.tsx`) offering 打开对话 / 查看进度 / 停止 / 改线. Starter-prompt buttons dispatch directly unless `ui.materials` is set, in which case they only fill the box (`CapabilityCard.tsx:36-52`).
- **「在对话里写」** (`CapabilityStart.tsx:59-63, 99-101`) → `navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(capabilityBrief(title, question || starterPrompts[0])) } })`. Binds nothing; a draft only.

**The red-error state bug.** `CapabilityStart` owns `failure` locally (`:37`) and clears it only in its own `onChange` (`:81`) and in `start()` (`:48`). But the parent fills the textarea through the **prop**: `CapabilityCard.tsx:38` `setQuestion(prompt)` (materials capabilities). So: press 开始 empty → `setFailure("先写下要研究的问题。")` (`CapabilityStart.tsx:44-45`) → click a starter prompt → textarea now has text, `failure` untouched → red line stays. Same for any programmatic fill.

**Data a landing page already has** (`researchAgentUi.ts:39-56`, from `packages/domain/src/capability-display.json`, 15 capabilities): `title`, `category`, `description`, `starterPrompts[]` (3 each), `estimatedMinutes{min,max}` → `minutesText` 「通常 20–40 分钟」, `outputs[]` (你会拿到), `knownLimits[]`, `materials` (前置资料), `evaluation{lastStatus,lastRunAt,runs,delivered,typicalMinutes}` → `evaluationLines()` (`:82-96`), plus the control-plane record's `id`/`version`/`inputs`/`outputs`, and `capabilityIcon(id)`.

**Pinning a capability to a new chat today — two mechanisms exist:**
1. **Hard binding**: `PUT /research-sessions/:id {mode:"specialist"}` before the first prompt (`dispatch.ts:53-58`). Immutable afterwards (`store.mjs:1423` `research_session_identity_conflict`) — which is why 改线 starts a new session (`dispatch.ts:72-81`). Nothing currently creates a *bound* session and lands the user in the frame on it; 开始 dispatches server-side instead.
2. **Draft prefix** (soft, editable): `capabilityBrief` in `packages/domain/src/capabilityDisplay.mjs:89-91` — exactly:
   `` `请以「${title}」能力完成以下任务：\n${prompt}` `` (one newline; Lexical renders two as five blank lines). Parsed back off run titles by `capabilityBriefTask` (`:114-124`), used by `agentRuns.mjs:179`.
3. The kernel's own hero inside the frame already renders the same cards, each carrying `brief: capabilityBrief(...)` (`runtimeUiServer.mjs:237-259`, shipped via `__evimed_bootstrap.js` `capabilities:` at `:417`); clicking one posts `shell-navigate {destination:"new-task", draft}` which the shell turns into `/app/chat` + intent (`RuntimeUiFrame.tsx:454-471`). There is also a `/能力` slash command in the frame (`runtimeUiServer.mjs:231`). **A GPT-style landing page therefore needs no new plumbing: route `/app/capabilities/:id` → hero + composer, then either `newRuntimeUiIntent(capabilityBrief(...))` or a pre-bound session.**

## B. Runs page

**Exists only on `RunsPage.tsx`** (function list): `RunsFilterBar` (`:147`) + `FacetChip` (`:1327`) status/时间 facets (`:412-478`); `DaySection`/`groupByDay`/`dayLabel` (`:201,1301,1315`); `HostedRunsView` (`:278`) with `?run=` deep-link resolution + cross-project search (`resolveLink` `:302`, `linkSearch`), 60 s polling (`:361-377`), search debounce; `WebRunRow` (`:610`) + `RunTitleEditor` (`:718`, `renameWebAgentRun`); `RunDetail` (`:763`): **取消运行** (`cancelWebAgentRun`, `:788-798`, confirm at `:958`), **复查与复现** (`reproduce` `:418-434`, drafts a `runtimeUiIntent`), 打开对话, `forkedFrom` 打开原对话 (`:824-833`), `RouteLine`, `RunVerdict` (`:1094`) + credential link, claim summary; `SteerBox` (`:1007`, `steerWebAgentRun`); `RunActivity` (`:974`, phases/counts/**cost** `runCostText`); 产物 + **未通过核验的文件** (`:867-880`); `ArtifactRow` (`:1252`, **download** `downloadArtifact`, 预览, 阅读); `RunFilePreview` (`:1230`, lazy `FilePreviewInspector`); `DeliverableFeedback` (`:1131-1209`, **采纳/我改过** → `reportWebDeliverableFeedback`/`listWebDeliverableFeedback`); `RunDeliverableList` (`:1053`, **plan items**, attempts, 核验通过/必须修改); `QualityNotices` (verification badges); 个性化依据 (recalledMemories); 已阅读的网页 (`ReadPagesList`); 技术标识 (run/session/model/agent/phase/**usage+cost**).

**Inbound links to `/app/runs`** — frontend: `Sidebar.tsx:49` (nav), `CommandPalette.tsx:91`, `ProjectBrowser.tsx:58,63` (a run with a non-addressable `sessionId`), `InboxPage.tsx:233,323`, `DispatchReceipt.tsx:124`, `RuntimeUiFrame.tsx:460` (`shell-navigate` `runs`) and `:660` (slot-cap 「去运行记录」), `RunFilePage.tsx:100,109-111` (back link), `router.tsx:80` (`/runs` redirect). To `/app/runs/:id/files/*`: `RuntimeUiFrame.tsx:494` (`open-artifact` from the frame's 交付物/依据 tabs), `RunsPage.tsx:1221-1223` `readerHref`, `ClaimCitation.tsx:54`, `lib/readPages.ts:26` `snapshotHref`, `report/ReportReader.tsx:61`. **Server-generated:** `imService.mjs:94` `runLink` → `/app/runs?run=`, `:100` `runFileLink` → `/app/runs/:id/files/*`, `:104-110` `noticeLink` (Feishu cards, pushed notices); `notificationService.mjs:173,331` bodies say 「查看运行记录」; `runtimeUiServer.mjs:91` and `RuntimeUiFrame.tsx:77` slot-cap text tells the reader to go there to stop a run.

**Breaks if the list page goes** (keeping `runs/:runId/files/*`): (a) `RunFilePage.tsx:100` back link becomes a 404 — needs `/app/chat/:sessionId` instead; (b) every `?run=` link above (inbox, IM cards, sidebar fallback, receipt, `openRunProject`'s remount-at-same-address trick in `lib/runLocation.ts:31-43`) needs a new target; (c) the only place to **stop a run**, **download an unverified file**, **give 采纳/我改过 feedback**, **rename a run**, **steer a run**, see **cost/usage**, **plan items** and **quality notices** disappears — the frame draws run-state/deliverables/evidence (`runtimeUiBridge.ts`) but has no cancel/feedback/rename channel; (d) `RuntimeUiFrame.tsx:459-462` `routes.runs` and `:660` need removing or repointing.

## C. Sidebar and the frame cold-start

`ProjectBrowser` lists every project as a collapsible group (`:103`), tasks read per project only when wanted (`useProjectRuns.ts:38-81`, 20 s poll + `RUNS_CHANGED_EVENT`), 5 rows then 展开其余. A task row is a **`Link`** for the current project and a **`button`** for another (`ProjectBrowser.tsx:792-824`). Click → `openTask` → `go()` (`:200-222`): same project = `select(id)` no-op + `navigate(taskTarget(run))`; other project = `select(id, land)` which `flushSync`es `currentId` **and** the navigation in one render (`lib/projects.ts:144-147`).

**Unmount/remount sources (each = one `POST /api/runtime-ui/frames` + fresh iframe document + kernel reconnect):**
1. `AppShell.tsx:120` `<Outlet key={currentProjectId}>` — any project switch remounts the route.
2. `RuntimeUiFrame.tsx:209` `key={`${origin}:${projectId}`}` — second, redundant remount on the same switch.
3. **Route identity**: `router.tsx:45` `chat` and `:46` `chat/:sessionId` are two route objects. `/app/chat` ⇄ `/app/chat/:id` therefore unmounts `SessionRoute` — and `SessionRoute.tsx:66` itself does `navigate("/app/chat/<id>", {replace:true})` after resuming, so a plain visit to `/app/chat` costs a remount.
4. `SessionRoute.tsx:105-112` the `resolving` branch returns `FrameWaiting` **instead of** the subtree containing `RuntimeUiFrame` — mount, unmount, remount.
5. Any navigation to a non-chat page (`/app/runs`, `/app/files`, `/app/capabilities`, `/app/inbox`, the run-file reader) unmounts `SessionRoute` entirely; the lazy `Suspense` fallback (`AppShell.tsx:112`) replaces the subtree too.
6. `RuntimeUiFrame.tsx:272-299` effect deps `[projectId, origin, attempt]`: cleanup `release(frameId)` **DELETE**s the binding; `:284` resets all state; `:672-673` `<iframe key={binding.frameId}>` guarantees a new document per binding. `setAttempt` also fires on `:269` (navigation change while an error is showing) and on every 重试.
7. `lib/runLocation.ts:31-43` `openRunProject` deliberately switches project to remount the page — another frame.

**Keep-alive would have to:** hoist the frame above the router (render it once in `AppShell`, visibility-hidden when off-chat), drop the two `key=`s (2) and (1) (or scope the key to the project only, with per-project frames cached), merge `chat`/`chat/:sessionId` into one route with an optional param, make `resolving` an overlay rather than a branch (`SessionRoute.tsx:105`), and make `release` happen on project change/logout rather than on unmount. Note the frame already handles session switching by `postMessage` (`RuntimeUiFrame.tsx:569-580` `navigate` intent) — the surface does not need a remount to change conversation.

## D. Memory bar (clean-cut inventory)

`SessionRoute.tsx:119` is the only mount: `{sessionId && <SessionMemoryBar sessionId={sessionId} />}` (comment at `:113-114`).
`SessionMemoryBar.tsx` renders a 40 px bar: the marked banner 「无痕对话：不会记住这段对话，也不调取记忆」 / capsule-trial line (`:96-101`), **「本次用到的背景」** button with a 新记下 N counter (`:103-106`), and the **无痕：开/关** switch (`:107-121`). Endpoints: `GET /api/product/memory/sessions/:id` (`memoryClient.ts:135-137`), `PUT` same with `{incognito}` (`:140-142`), `GET /memory/changes?since&sessionId` polled every 60 s (`SessionMemoryBar.tsx:12,52`), plus undo via `POST /memory/records/:id/undo` (`useMemoryWritePrompt`).
`SessionBackgroundPanel.tsx` (Drawer, 20 s refresh): `GET …/sessions/:id/background` (`:154-156`), `POST/DELETE …/exclusions` (`:145-152`), `PATCH /memory/records/:id` (`:159-161`), `POST /methods/:id/retire` and `/rollback` (`:164-172`), `PATCH /capsules/:id/entries/:eid` (`:175-178`), `POST …/undo` (`:38-49`). Sections: 记忆（N）/方法（N）/本次新记下（N）, buttons 不对 / 本次不用 / 恢复使用 / 撤销.
`MemoryControls.tsx` is **not** on the session surface — it is the 记忆开关 card on the memory hub (学习/回答参考/当前项目 + 重置全部记忆, `fetchMemorySettings`/`updateMemorySettings`/`resetMemory`). Nothing there mentions incognito, so it is unaffected.
Other incognito UI: none in the shell besides the above. Server side: `memoryClient` PUT → `researchMemory.mjs:1248-1290`, read at `:441-469`, honoured in `capsuleGateway.mjs:66-87` and `learningTriggers.mjs:169-170`. Removing the bar leaves those server paths dead-but-harmless (no other caller of `setSessionIncognito`).

## E. Duplicated concepts in the shell

- **任务 / 会话 / 运行** for one thing: nav 「新任务」 → `/app/chat` (`Sidebar.tsx:48`); the page titles itself 「研究会话」 (`SessionRoute.tsx:108,118,127,134`); the ledger calls the same object 「运行记录」 (`Sidebar.tsx:49`, `RunsPage.tsx:506`); the sidebar tree calls its rows 任务 (`ProjectBrowser.tsx:50-54` `taskTarget`, 「新任务」 per group). `SessionRoute.tsx:14-18` already documents this as the 2026-09-15 A1/A6 finding.
- **知识库 / 文件 / 整理进度**: one destination 「知识库」 with tabs 「文件」 and 「整理进度」 (`KnowledgePage.tsx:17-26`), while the palette additionally offers 「资料整理进度」 → `/app/files?tab=sources` (`CommandPalette.tsx:93`) and `/app/sources` still redirects (`router.tsx:65,82`). `CapabilityCard.tsx:94` links 「去知识库」 to the same `?tab=sources`.
- **记忆胶囊 / 方法 / 资料 / 时间轴**: nav 「记忆胶囊」 (`Sidebar.tsx:51`) hides six tabs 总览/对你的理解/项目档案/方法/资料/时间轴 (`MemoryHubPage.tsx:43-59`), while the palette lists three of them as separate destinations named 「方法」 and 「胶囊时间轴」 (`CommandPalette.tsx:95-96`) — and 「资料」 (memory hub) vs 「知识库」 (files) are two different things under near-identical words.
- **收件箱** has no nav row (it is the bell, `Sidebar.tsx:113`) but is a palette destination (`CommandPalette.tsx:99`) and a route (`router.tsx:55`).
- **停止 vs 取消**: `DispatchReceipt.tsx:129` 「停止」/「停止这次运行？」 and `RunsPage.tsx:849` 「取消运行」/「取消这次运行？」 call the same `cancelWebAgentRun`.
