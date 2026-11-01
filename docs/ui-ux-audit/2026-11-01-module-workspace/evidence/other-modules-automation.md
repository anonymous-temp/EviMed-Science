# Code audit: other-modules-automation

Source reading of GitHub main 38b5af2a8 (2026-11-01), by a read-only agent. No browser was run. Paths are relative to `OpenScience/apps/web/src` unless they say otherwise; line numbers belong to that commit.

I could not write `/tmp/lay-1101/audit-rest.md`. This session is read-only (no write tool, and shell writes are barred), so the full audit is below for you to save. Nothing in the source tree was touched, and I did not run the app or the UI walk.

## SUMMARY (15 lines)
1. **Chaotic pages:** 9 of the 15 pages in my scope put a conversation (or a button that leaves for one), status or progress, and a pending ask or confirmation on one screen. Only 定时任务 and 主动科研 also embed the live frame and have all five ingredients, and both stack extra blocks around it. This count is my judgment. Details are in §Matrix.
2. **A1, start AI work:** about 56 call sites in 5 families.
   - 26 `newRuntimeUiIntent(` calls in 22 files, plus 2 hand-built intents.
   - 2 direct dispatches.
   - 10 agenda-state calls.
   - 4 embedded `registerTaskPane` panes.
   - about 12 pipeline kicks (compile, re-read, draft zone and similar).
3. **A2, enter a conversation:** 10 mechanisms. They include 25 `navigate("/app/chat…")` sites in 20 files, 4 direct chat links, 4 embedded panes, the handoff route, the run→chat resolver, and sidebar rows.
4. **A3, report progress:** 14 vehicles. `ActivityStrip` is used in only 2 places (知识页 view and VCR). `StepRail` has 1 production use (GEO) and `ProgressRail` 1 (医学检索). There are 306 toasts, 157 `Note`s and 130 `role="status"` lines.
5. **A4, ask for input:** 9 patterns.
6. **A5, ask for confirmation:** 9 patterns. There are 42 `ConfirmDialog` sites in 30 files, 11 "撤销" toasts and 28 unsent-draft handoffs.
7. **B, status vocabulary:** about 9 label sets describe one run.
   - Running is said as 进行中, 研究进行中, 执行中, 运行中 or 工作中.
   - Cancelled is 已取消 in some places and 已停止 in others.
   - 待核对 has 4 meanings.
   - `WEB_RUN_STATUS_LABEL` has no importer.
   - The deliverable enum has 2 label maps, and the material enum is mapped twice.
8. **C, background automation:** 22 `*Worker.mjs` files plus 9 `server.mjs` timers. A person can stop the effect of about 7 of the workers. About 11 have no user control, and about 9 have no user-visible surface.
9. **D1, top defect (CONFIRMED):** a running scheduled task locks the project's chat. 新对话 then shows "这个项目正在执行你设定的定时任务，结束后即可继续。" with no earlier warning (`RuntimeUiFrame.tsx:148`, `AutopilotPage.tsx:230`).
10. **D2 (CONFIRMED):** 主动科研 stacks 8 or more blocks, has 3 "open the conversation" buttons, and is declared T4 in `page-templates.json` while rendering no T4 slots.
11. **D3 (CONFIRMED):** 添加到这个任务 (`MaterialPicker.tsx:49`) silently resumes a paused task through `startAgenda` (`AutopilotPage.tsx:338`).
12. **D4 (CONFIRMED):** inbox 处理 → 解除绑定 unbinds Feishu in one click (`InboxPage.tsx:557`). The same action in 设置 has a `ConfirmDialog` (`FeishuRows.tsx:171`).
13. **D5 (CONFIRMED):** the inbox never refreshes while open, though the bell polls every 60 s.
14. **D6 and D7 (CONFIRMED):** two statuses never update on their own: the zone message "正在为这个专区搜集内容，通常几分钟内出现第一批" and the challenge status "已提交，正在复核…".
15. **Rule 10:** only 1 of the AI-start surfaces in my scope has an `ActivityStrip` (知识页). The other 3 modules and 3 evidence/frontier flows have only a toast or a one-shot sentence.

---

## §Matrix (module rows)

Legend: Conv = conversation; AI = ways to start AI work; Fin = how the page learns a run finished and how the result returns; BG = background work and whether the page says so. Paths are under `apps/web/src`.

| Module (route · template) | Page top to bottom | Conv · AI | Steps · status words · awaiting · confirm | Fin · BG |
|---|---|---|---|---|
| **新对话** `/app/home`→`/app/chat/:sessionId?` (`router.tsx:86,91`). Template "kernel", no PageShell (`page-templates.json` unwalked). | `ConnectorNeedNotice` strip (`app/routes/RuntimeUiFrame.tsx:1217`), then the full-bleed iframe (`:1252`). Cover or error alert with 重试 / 新建对话 / 查看已有成果 / 查看定时任务 / 查看额度 (`:1224-1237`). Frame is resident in `app/layout/SessionFrameHost.tsx:80-320`, `display:none` off-surface (`:286`). `SessionRoute.tsx:65` renders only `PageTitle "对话"`. | **Conv:** embedded frame. **AI:** sidebar 新对话 `freshState` (`Sidebar.tsx:215,346-360`) → `GlobalHomeRoute` mints the intent (`SessionRoute.tsx:84-86`). Per-project "+" (`ProjectBrowser.tsx:307`). Strip "继续" dispatches a run directly (`ConnectorNeedNotice.tsx:79`). Frame messages `shell-navigate` / `bind-capability` (`RuntimeUiFrame.tsx:796-832,943-961`). | **Steps:** kernel-owned. The shell posts `run-state` and reply-check rows (`:1137-1152`). **Status:** 正在打开 (`:289`), 正在准备运行环境 (`:182`), 所有运行环境都在使用中，空出后会自动开始。(`:161`), 正在清理上一次任务的运行环境，完成后自动继续 (`:142`), 正在重连 (`:1246`). Six wordings for "unreachable": 对话暂时无法打开 (`SessionRoute.tsx:92`), 对话暂时无法连接 (`SessionFrameHost.tsx:290`), 这条对话暂时无法打开 (`:979,1169`), 对话暂时无法连接，请重试。(`:93`), 连接中断，正在重连 (`:619`), 连接暂时无法恢复，请重试 (`:794`). **Awaiting:** credential strip 去配置 / 继续 / 关闭提示. **Confirm:** none in the shell. | **Fin:** ledger poll 20 s (`lib/runtimeUiBridge.ts:266,327`) plus run SSE (`:312`). Sidebar poll 20 s (`useProjectRuns.ts:7`) → spinner "进行中" (`ProjectBrowser.tsx:954`), "未打开" dot (`:957`). No toast. Files open at `/app/runs/:id/files/*` (`:847-856`). **BG:** runtime warm-up (`SessionFrameHost.tsx:241-248`), reply checks, memory and learning writers. The page says nothing except cover lines. |
| **知识库** `/app/files/:sourceId?` (`router.tsx:142`), T2 `MasterDetail` (`SourcesPage.tsx:489`). `KnowledgeOpenPage` `/app/files/open` (`router.tsx:140`) is a redirect screen "知识页" showing "正在打开" (`KnowledgeOpenPage.tsx:57-62`). | Left column: `PageHeader` 知识库 plus 添加 menu (`:450`). Views 资料 / 知识页 / 图谱 / 对话产出 (`:451`). Toolbar of type chips and search, or "已选 N 份" + 在对话中使用 (`:374-389`). Rows (`SourceRow`). Right pane: `SourceReader` 内容 | 原文 (`:465`). Dialogs: upload, link, note, applies-to, delete, conversation-project, drive drawer (`:493-516`). Not PageShell. | **Conv:** none embedded. Handoff: 在对话中使用 (`SourcesPage.tsx:317-333`, `SourceReader.tsx:186-215`) → draft plus references. **AI:** upload (`:249-291`); 添加网页链接 / 新建笔记 / 从网盘导入 (`:391-396`); 重新读取 / 重试 (`:229-235`); 重新整理知识页 (`ProjectKnowledge.tsx:67-72`, `KnowledgePageView.tsx:84`). | **Steps:** compile `ActivityStrip` "整理知识页" only in the 知识页 view (`ProjectKnowledge.tsx:173-182`). **Status (docs):** 正在读取 / 没能读取 · 重试 / 部分无法读取 / 只保存原件 / 原件已移除 / 已取消 (`components/sources/sourceView.ts:22-33`). **Status (upload):** 正在传输 / 已传输 / 正在读取 / 可以搜索 / 失败 (`ui/FileDrop.tsx:4`). **Status (compile):** 整理中 · … / 资料有更新，稍后会自动整理 / 已整理 · 上次整理于… / 资料还不够：再加 N 份就会开始整理 / 资料已就绪，随时可以整理成知识页 / 知识引擎暂不可用… / 上次整理没有完成… (`knowledgeView.ts:39-68`). **Awaiting:** empty recipe `StepState` (`ProjectKnowledge.tsx:119-128`); which project (`:509`). **Confirm:** delete (`:511`), applies-to (`:508`), project choice (`:509`). | **Fin:** doc rows poll 5 s while any is reading (`useDocumentList.ts:12,128-140`). Compile status polls 5 s while busy (`useKnowledge.ts:6,26-36`). No completion toast. The handoff is one-way. **BG:** `sourceWorker` (parse plus a silent understanding pass, deliberate per `sourceView.ts:18-21`) and `knowledgePageWorker` (auto-compile). The compile is visible only in the 知识页 view. The status dot draws only when attention is needed (`KnowledgeStatusDot.tsx:19`). |
| **记忆胶囊** `/app/memory?tab=self\|methods\|received` (`router.tsx:148`), T2. A bare entry redirects to 总览 when the map is on (`MemoryHubPage.tsx:101-104`). | `MemoryFrame` (`components/memory/MemoryFrame.tsx:113-148`). Nav column: title 记忆胶囊, 记忆 switch, 总览 / 关于你 / 做法 / 收到的, 记住这一条, ⋯. Beside it a PageShell with search toolbar, then pending rows, then grouped rows. Drawers: fact, method, 记住这一条, 导入, 分享与导入, 已忘记 (`MemoryHubPage.tsx:371-397`). | **Conv:** draft handoff only: 在对话里说说你自己 (`:318,282-283`), 就这个提问 (`AskMenu.tsx`→`useAskAbout.ts:19`), source links (`ConversationLink.tsx:22`). **AI:** 记住这一条 (engine writes in about 12 s), 从其他 AI 导入 (`ImportDialog.tsx:122`), 试用一次 (`ReceivedShelf.tsx:166`). | **Steps:** none. **Status:** 正在记住 / 还在记，比平时慢一些 (`MemoryRows.tsx:69`), 待确认 (`FactDrawer.tsx:305`), 已暂停 / 已开启 (`MemoryControls.tsx:114`). **Awaiting:** 待确认 notes from outside agents, button 确认 (`FactDrawer.tsx:227-233`). **Confirm:** ConfirmDialog for 重置记忆 (`MemoryControls.tsx:155`), discard edit (`FactDrawer.tsx:254`), delete (`:377,386`). Undo toasts: 已忘记 (`:170,212`), 已停用 (`PracticeDrawer.tsx:153`), "刚记住了 N 条 撤销" (`useMemoryWritePrompt.ts:57`). | **Fin:** pending poll 3 s, gives up at 60 s (`usePendingMemory.ts:5-6,29`). Writes are announced on the next visit. **BG:** `nativeMemoryWorker`, `learningWorker`, `memoryIndexWorker`. The page discloses learning only in "做的研究多了，会从中学到做法，出现在这里。" (`MemoryHubPage.tsx:339`). The stop is the 记忆 switch (`MemoryControls.tsx:99-116`). |
| **记忆总览** `/app/memory/overview` (`router.tsx:152`), T4. | Frame nav, then toolbar (range, 只看需要看一眼 N, search), headline, 星图, `StatBand` with 4 tiles (`MemoryOverviewPage.tsx:213-227`), 变化 chart, 最近变化 table (`:255-262`). | **Conv:** 就这个提问 in drawers. **AI:** empty state 从其他 AI 导入 (`:286`). | **Status:** 暂时读不到记忆。 / 有一部分记忆没有读到，对应的数字先不显示。 **Confirm:** none. | **Fin:** reload on change, no poll. **BG:** same as the hub. |
| **收到的分享** `/app/memory/shared/:token`, `/delivered/:id` (`router.tsx:154-155`), PageShell (`SharedCapsulePage.tsx:114`). | Card, `StarCover`, 工作方式, entries disclosure, name input 收下后的名称, buttons. | **Conv:** 试用一次 navigates to chat (`:148-150`). **AI:** 试用一次 (`startCapsuleTrial`). | **Steps:** 收下 → 试用一次 / 启用 / 稍后再说 (`:144-166`). **Status:** "已收下“…”。它还没有生效：先试用一次，或直接启用。" **Awaiting:** name (`:162`). **Confirm:** two-step flow; 不需要 declines with no dialog (`:167`). | **Fin:** none. **BG:** capsule cleanup every 30 s (`server.mjs:9360`), not disclosed. |
| **定时任务** `/app/autopilot/:taskId?` (`router.tsx:146`), T2, no PageShell. | List column: `PageHeader` + 新建 icon, search, groups 即将执行 / 已暂停 / 已完成 (`TaskList.tsx:91-109`). Pane: `TaskBar` (最新结果, 切换执行, 立即运行 / 停止本次, ⋯ with 研究进展 / 任务材料 / 编辑 / 暂停·启用 / 删除; `TaskBar.tsx:69-100`), then notes, errors, then the embedded conversation (`TaskPane.tsx:71,195`). Or `NewTaskPane`. Drawers: 研究进展, 任务材料 (`AutopilotPage.tsx:484`). | **Conv:** embedded frame via `registerTaskPane`. **AI:** 立即运行 (`:322-328`), 创建并启用 (`TaskForm.tsx:108-112`), 启用 (`:343`), 补充材料并继续 (`:338,380`), 创建研究议程 (`EvolutionOpportunities`), the task timer itself. | **Steps:** plan items 待开始 / 进行中 / 已完成 / 未完成 (`TaskPane.tsx:11-13`). **Status:** 排队中, 研究进行中, 未完成, 已取消, 研究结果, 等待自动重试, 没有新证据, 任务预算已用完, 等待余额, 等待运行资源, 余额不足, 运行资源暂不可用, 正在安排 (`taskPresentation.ts:77-100`). **Awaiting:** "需要你补充：…" with 补充材料并继续 (`:139`, `TaskBar.tsx:96-99`). **Confirm:** 暂停任务？ / 删除任务？ (`AutopilotPage.tsx:496`), 放弃未保存的修改？ (`:492`, `NewTaskPane.tsx:201`). | **Fin:** poll 5 s while an execution is in flight, 30 s idle (`:48-50,245-265`), paused while the tab is hidden. When a bounded run ends the pane switches to the conversation (`TaskPane.tsx:210`). Results also go to inbox digests (`:267-304`). **BG:** `autopilotWorker`, 60 s schedule timer. The page states next run and zone (`scheduleLine`). Spend is not stated except in the hidden budget fields. |
| **主动科研** `/app/active-research` (`router.tsx:147`), PageShell wide, declared T4. | Header: 新建长期研究 (primary) + 新建定时研究 (`:388-389`). Notices (`:394-399`). `ResearchQueue` (`:405`). `ResearchObservatory` (`:406`: status, 6 counters, 7-stage scene, live feed). 当前研究 (`:410-420`: 停止本次 / 立即执行, 调整研究方向, 打开任务对话). `ResultsPanel` + `ResearchDataPanel` (`:423-426`). 执行记录 (`:428`). `GoalWorkbench` (`:441`). `NativeResearchPane` (`:442`). Dialogs: steering, database, picker, new scheduled. | **Conv:** embedded native pane for long goals; three open buttons: 打开任务对话 (`:417`), 在本页打开对话 (`:500`), 打开所属对话 (`:501`). **AI:** `startLongResearch` writes `/loopx ` intent (`:346-353`), `runNow` (`:300`), steer (`:319`), follow-up (`:327`). | **Steps:** queue and observatory stages. **Status:** `QUEUE_MODE_WORD` 进行中 / 排队中 / 已完成 / 未完成 / 已暂停 / 待执行 / 已结束 (`ResearchQueue.tsx:13`); observatory 实时 / 重新连接 / 连接中 / 等待开始 / 已结束 (`ResearchObservatory.tsx:119`). **Awaiting:** the "调整研究方向" textarea (`:444`). **Confirm:** none; stop, run and steer fire at once. | **Fin:** two sources of truth. Observatory uses the run SSE stream (`lib/researchObservation.ts:320`). The rest polls 5 s / 30 s plus runs every 20 s (`:253-254`). **BG:** same scheduler as 定时任务, not disclosed on the page. |
| **前沿动态** `/app/frontier` (`router.tsx:97`), T1 with 7 tabs. | PageShell title + band with tabs 精选 / 全部 / 关注 / 热榜 / 追踪 / 简报 / 证据专区 (`FrontierControls.tsx:19-27`) and a sub-switch in 热榜, 追踪, 简报, 证据专区. Toolbar and filters. "有 N 条新的" (`FrontierFeed.tsx:99`), 未能刷新 (`:93`). Cards. Drawers: 管理关注, zone editor. | **Conv:** handoff only: 深入研究 / 继续追问 (`FrontierCard.tsx:103-104`→`frontierAsk.ts:11`). **AI:** 新建专区 (`FrontierControls.tsx:34-36`). | **Steps:** none. **Status:** 有 N 条新的, 未能刷新. **Awaiting:** none. **Confirm:** 不感兴趣 → reasons strip, no dialog. | **Fin:** `/status` poll 120 s (`FrontierPage.tsx:63,224-246`). **BG:** `frontierWorker` with 12 loops (`frontierWorker.mjs:55`), not stated on the feed. |
| **前沿文章** `/app/frontier/items/:itemId` (`router.tsx:99`), T5. | PageShell (`FrontierArticlePage.tsx:202`), 深入研究 primary (`:213`), 速读 | 正文, 继续追问 chips (`:236`). | **Conv:** handoff. **AI:** 深入研究, 继续追问, 自己提问…. | Opening marks the item read (`:88`). No steps. |
| **证据专区** `/app/frontier/zones` → `Navigate` to `?view=zones` (`EvidenceZonesPage.tsx:14-17`). Zone page `/app/frontier/zones/:id` (`router.tsx:111`), PageShell with tabs 概览 / 动态 / 证据卡片. | Zone: header (follow or edit, ⋯: 深入研究, 复制链接, 以此新建我的专区, 公开到平台, 删除; `FrontierZonePage.tsx:240-262`). Editor drawer (`ZoneEditorDrawer.tsx:240-249`: free text "想持续看什么？" + 生成). | **Conv:** handoff (`FrontierZonePage.tsx:227`). **AI:** 生成 → `draftZone` (`ZoneEditorDrawer.tsx:96`), 建立. | **Status:** "正在为这个专区搜集内容，通常几分钟内出现第一批" (`:324`). **Confirm:** 删除专区“…”？ (`:299`). | **Fin:** none. Overview effect deps `[zone.id, overviewAttempt]` (`:187`); a manual 重新加载 is the only refresh. **BG:** `frontierWorker` loops zones / zone-planner / evidence-upkeep. |
| **证据卡阅读** `/app/frontier/zones/:zoneId/evidence/:cardId` (`router.tsx:113`), PageShell document title. | 问这条证据 (primary), ⋯ 编辑证据 / 发布·撤回证据, editor (`CardEditor`), error `EmptyState`, `EvidenceReading`, 用这张卡继续研究, links, 评议与讨论 with review and comment forms, per-claim 质疑. | **Conv:** two handoffs: 问这条证据 (`EvidenceReadingPage.tsx:141-152`, current project) and 用这张卡继续研究 (`EvidenceCardLinks.tsx:32-60`, creates a new project). | **Status:** 草稿 (`EvidenceCardHeader.tsx:52`), 已撤回, challenge states (`EvidenceChallenge.tsx:17-21`). **Awaiting:** review, comment and challenge forms. **Confirm:** publish and withdraw fire at once (`:162-175,211`); `EvidenceEditors.tsx` has its dialogs. | **Fin:** none. Challenges are read once (`:110-117`). **BG:** `evidence-upkeep` loop answers challenges. |
| **医学检索** `/app/search/:category?` (`router.tsx:98`), PageShell. | Home, or results with category tabs, search, filters, selection, reader. 原文 flow in a dialog (`EvimedSearchActions.tsx:172-262`). | **Conv:** none (hand-off happens on the external origin). **AI:** 获取原文 (`:250`). | **Steps:** `ProgressRail` 查找流程 (`EvimedSearchTransition.tsx:114`). **Status:** 原文正在获取中。 **Confirm:** 确认下载 · N 灵豆 (`:256`). | **Fin:** polls 6 times at 10 s, then "原文仍在获取中，可以稍后刷新状态。" (`:205-217`). |
| **收件箱** `/app/inbox` (`router.tsx:156`), T1. | Toolbar 全部 / 未读 N, source chips, 全部已读, batch selection (`InboxPage.tsx:378-409`). 需要优先查看 · 未读 N 条 section. Rows and folded groups. Group drawer. | **Conv:** rows navigate (`actionHref`, `:~470`): task, chat via `/app/runs?run=`, digest, memory, GEO, VCR. **AI:** none. | **Status:** 未读, 待回答 / 待核对 (`:53`), 已处理 (`:550`). **Awaiting:** 待回答 tag. **Confirm:** ⋯ 处理 resolves at once (`:557-563`). | **Fin:** bell polls 60 s (`InboxBell.tsx:12,70`); the page itself never refreshes. **BG:** `autopilotWorker` digests, `frontierWorker` daily and weekly, `imWorker`, `notificationTimer`. |
| **设置** `/app/account` (`router.tsx:160`), T6. | Left rail 账户 / 外观 / 通知 / 用量(额度) / 数据源 / 项目, then `Panel`s (`AccountPage.tsx:26-109`). | **Conv:** link list in 项目 (`ProjectsSection.tsx:392`). **AI:** none. | **Status:** Feishu 正在连接 / 已连接 / 正在重连 / 连接中断 / 未连接 (`FeishuRows.tsx:66-72`). **Awaiting:** credentials, password. **Confirm:** `ConnectorsSection.tsx:215`, `FeishuRows.tsx:171`, `ProjectsSection.tsx:328`, and a typed-id confirm for account deletion (`AccountSection.tsx:86-87,154`). | **Fin:** Feishu registration polls. **BG:** `imWorker`, `evimedCreditsWorker`, not described here. |
| **运行文件** `/app/runs/:runId/files/*` (`router.tsx:135`). Declared T5 (`page-templates.json:95`), but no PageShell. | Hand-built header: arrow, 返回对话, h1, 结果版本, 存入知识库 (`RunFilePage.tsx:161-173`). Then report reader, matrix, or file preview. | **Conv:** 返回对话 (`:155`). **AI:** 存入知识库 (`:96-105`). | **Status:** 正在打开, 正在读取 {filename}. | **Fin:** one-shot load. |
| **Shell** (PageShell, Sidebar) | PageShell band slots: steps, activity, tabs, toolbar (`PageShell.tsx:41-52`). Sidebar: 7 fixed rows plus 前沿动态, 医学检索, 虚拟临床研究, 循证 GEO when offered (`Sidebar.tsx:63-103`). Footer: bell, 运维, 设置. 证据专区 has no sidebar row. | — | The `activity` slot is used only by VCR (`StudyFrame.tsx:153`). `steps` is used only by GEO (`GeoProjectPage.tsx:543`). None of my modules use either slot. | Sidebar polls runs every 20 s and the bell every 60 s; VCR completion toast at `Sidebar.tsx:130` (`useVcrFinishedToasts.ts`). |

### Ingredient matrix

An X means the ingredient is on that page's screen.

| Page | Conversation or handoff | Steps / progress | Status words | Awaiting input | Confirm |
|---|---|---|---|---|---|
| 新对话 | X | X | X | X | – |
| 知识库 | X | X | X | X | X |
| 记忆胶囊 | X | X | X | X | X |
| 收到的分享 | X | X | X | X | X |
| 定时任务 | X | X | X | X | X |
| 主动科研 | X | X | X | X | – |
| 证据专区 (zone) | X | X | X | X | X |
| 证据卡阅读 | X | – | X | X | X |
| 收件箱 | X | – | X | X | X |
| 医学检索 | – | X | X | X | X |
| 设置 | – | – | X | X | X |
| 记忆总览, 前沿动态, 前沿文章, 运行文件, 知识页 (open) | partial | – | partial | – | – |

---

## §A. Cross-module counts

| Dimension | Distinct ways | Call sites (grep) | Components / functions |
|---|---|---|---|
| (1) Start AI work | 5 families, about 56 sites | See next row. | Draft handoff, direct dispatch, agenda state, embedded pane, pipeline kicks. |
| (1a) Draft handoff | 1 | 26 `newRuntimeUiIntent(` in 22 files, plus `continuationIntent` (`EvidenceCardLinks.tsx:23`) and `handoffIntent` (`HandoffRoute.tsx:42`) = 28. | `CapabilitiesPage`, `ExtensionsPage`, `SessionRoute`, `RuntimeUiFrame`, `ProjectBrowser`, `ConversationMenu`, `SourcesPage`, `SourceReader`, `useKnowledgeConversation`, `useAskAbout`, `ReceivedShelf`, `SharedCapsulePage`, `FrontierEventPage`, `FrontierTopicPage`, `FrontierZonePage`, `frontierAsk`, `EvidenceReadingPage`, `ActiveResearchPage`, `useGeneralResearchDraft`, `useOpenGeoConversation`, `HandoffRoute`. |
| (1b) Direct dispatch | 2 | `ConnectorNeedNotice.tsx:79`, `lib/dispatch.ts:59`. | 继续. |
| (1c) Agenda state | 10 | `runAgendaNow` ×2, `startAgenda` ×4 (`TaskForm:112`; `AutopilotPage:338,343,380`), `createAgenda` ×1, `followUpAgenda` ×1, `steerWebAgentRun` ×1, `adoptEvolutionOpportunity` ×1. | 立即运行 / 立即执行, 启用, 创建并启用, 补充材料并继续, 调整研究方向, 创建研究议程. |
| (1d) Embedded pane | 4 | `registerTaskPane` in `TaskPane.tsx:71`, `ActiveResearchPage.tsx:521`, `GeoConversationPane.tsx:26`, `StudyPane.tsx:101`. | — |
| (1e) Pipeline kicks | about 12 | `requestKnowledgeCompile` ×2, `retrySource` ×2, `refetchSource` ×2, `saveToKnowledgeBase` ×2, `draftZone` ×1, `requestEvimedFullText`, challenge submit, 记住这一条, `ImportDialog`, upload. | — |
| (2) Enter a conversation | 10 mechanisms | See next rows. | See next rows. |
| (2a) `navigate("/app/chat…")` | 1 | 25 sites in 20 files. | — |
| (2b) Chat links | 1 | `router.tsx:218`, `ActiveResearchPage.tsx:501`, `ProjectsSection.tsx:392`, `ConversationMatches.tsx:68`, plus `ConversationLink`, `SourceKeyPoints:325`, `RunFilePage:155`, `ProvenancePanel`, `ResultVersionInspector`. | — |
| (2c) Embedded pane | 1 | 4 sites (see 1d). | — |
| (2d) Handoff route | 1 | `HandoffRoute`. | — |
| (2e) Run→chat resolver | 1 | `RunRedirect` (`router.tsx:231`), used by inbox, key points, digest. | — |
| (2f) Sidebar | 1 | `ProjectBrowser.tsx:283-309`, `Sidebar` 新对话 freshState. | — |
| (2g) Frame→shell | 1 | `shell-navigate` 8 destinations, `bind-capability`, `session` fork / clear (`RuntimeUiFrame.tsx:796-832,943-961,1001-1020`). | — |
| (2h) Task and goal | 2 | `/app/autopilot/:id`; `openGoalConversation`. | — |
| (2i) Global home | 1 | `/app/home`, `/live` redirects. | — |
| (3) Report progress | 14 | See next row. | See next row. |
| (3 detail) | — | `ActivityStrip` 2 sites; `StepRail` 1; `ProgressRail` 1; `StepState` 5 files; `RunStatusDot` (autopilot) and sidebar spinner; observatory; `PendingMemoryRows`; `PendingFeedback` about 15 sites; `FrameSkeleton` cover lines; `ConnectorNeedNotice`; `Note` 157 sites in 67 files; `toast` 306 in 107 files; `role="status"` 130 in 86 files; kernel `run-state` / reply-check rows; bell dot with announcer. | — |
| (4) Ask for missing input | 9 | `ConnectorNeedNotice` (`RuntimeUiFrame.tsx:1217`); autopilot note "需要你补充：" (`TaskBar.tsx:96-99`); `ResearchProgress.tsx:31`; inbox 待回答 / 待核对 (`InboxPage.tsx:53`); `StepState` empty recipes (5 files); memory empty recipes and 待确认 (`FactDrawer.tsx:305`); `ConversationProjectDialog`; evidence forms (评议, comment, 质疑); GEO `NeedsYou` and VCR 需要你 (others'). | — |
| (5) Ask for confirmation | 9 | `ConfirmDialog` 42 sites in 30 files; unsent draft (28); undo toast (11 "撤销"); `AsyncSwitch`; `FormDialog` / `Drawer` dirty guard (`useUnsavedGuard` ×10 files); two-step page (`SharedCapsulePage`); priced confirm (`EvimedSearchActions:256`); reasons strip (`FrontierHideStrip`); typed-id confirm (`AccountSection:86`). | — |

Confirm sites in my modules: Autopilot 3, Memory 4 (`FactDrawer` 3 plus `MemoryControls` 1), Knowledge 1, Frontier/Evidence 5 (`EvidenceEditors` 3, `FrontierZonePage` 1, `LegacyZoneView` 1), Settings 5, Sidebar 2, Inbox 0, ActiveResearch 0, Home 0.

---

## §B. Status vocabulary

| Label set | File:line | Words |
|---|---|---|
| `WEB_RUN_STATUS_LABEL` (dead, no importer) | `lib/runPresentation.ts:6-11` | 执行中 / 成功 / 失败 / 已取消 |
| `RUN_STATE_LABEL` (sidebar and `RunStatusDot`) | `runPresentation.ts:33-45` | 进行中 / 已完成 / 待核对 / 未完成 / 已停止 |
| `RUN_STATES` and `runState()` (autopilot) | `components/autopilot/taskPresentation.ts:77-100` | 排队中 / 研究进行中 / 未完成 / 已取消 / 研究结果, plus extras (等待自动重试, 没有新证据, routine: 进行中 / 已完成, 任务预算已用完, 等待余额, 等待运行资源, 余额不足, 运行资源暂不可用, 正在安排) |
| `QUEUE_MODE_WORD` | `ResearchQueue.tsx:13` | 进行中 / 排队中 / 已完成 / 未完成 / 已暂停 / 待执行 / 已结束 |
| `RUN_WORD` and `AGENT_WORD` | `ResearchObservatory.tsx:10-11` | 进行中 / 已完成 / 未完成 / 已停止; 工作中 / 待命 / 已完成 / 未完成 / 已停止 |
| Observatory header and call state | `ResearchObservatory.tsx:119,270` | 实时 / 重新连接 / 连接中 / 等待开始 / 已结束; 进行中 / 未成功 / 已完成 |
| Plan items (autopilot) | `TaskPane.tsx:11-13` | 待开始 / 进行中 / 已完成 / 未完成 |
| Deliverables (same enum) | `lib/runProgress.ts:159-167` | 待开始 / 进行中 / 核对中 / 需修改 / 已通过核对 / 已交付 / 未完成 |
| `RAIL_STATE_WORDS` and `DOT_WORDS` | `ui/ProgressRail.tsx:40-47`, `ui/Tabs.tsx:40` | 已完成 / 进行中 / 等你 / 部分完成 / 需要留意 / 未开始 |
| Ops ledger | `lib/statusLabel.ts:30-55`; `WebTasksCard.tsx:14-20`; `WebResourcesCard.tsx:186-189` | 运行中, 排队中, 失败, 已取消, 已超时, 已停止 |
| Programme runs | `ProgrammeRunsDrawer.tsx:19` | 进行中 / 已完成 / 未完成 |
| VCR | `VcrHomePage.tsx:68`; `VcrResearchProgress.tsx:9-12` | 需要你 / 进行中 / 已完成; 计算中 / 排队中 / 等待计算预算 / 计算未完成 / 计算已取消 |
| Documents | `sourceView.ts:22-33` | 正在读取 / 没能读取 / 部分无法读取 / 只保存原件 / 原件已移除 / 已取消 |
| Materials (duplicate maps) | `taskPresentation.ts:171`, `ResearchDataPanel.tsx:10-14` | 正在读取 / 需要处理 / 无法使用 |
| Compile | `knowledgeView.ts:39-68` | 整理中 / 已整理 / 资料有更新，稍后会自动整理 / 资料还不够 / 资料已就绪 / 知识引擎暂不可用 / 上次整理没有完成 |
| Task schedule | `taskPresentation.ts:130-134,184,249-261` | 即将执行 / 已暂停 / 已完成 / 下次… / 暂无下次运行 / 定时执行暂不可用 / 停止尚未完成 / 删除尚未完成 |
| Inbox | `InboxPage.tsx:53,550` | 未读 / 待回答 / 待核对 / 已处理 |
| Memory | `MemoryRows.tsx:69`, `FactDrawer.tsx:305` | 正在记住 / 还在记，比平时慢一些 / 待确认 / 已确认 |
| Evidence | `EvidenceCardHeader.tsx:52`, `ZoneCardBlock.tsx:13`, `EvidenceChallenge.tsx:17-21` | 草稿 / 已撤回 / 已提交，正在复核 / 已通知出品方 / 复核结果 |
| Connection | `FeishuRows.tsx:66-72` | 正在连接 / 已连接 / 正在重连 / 连接中断 / 未连接 |
| Congress | `FrontierCongressPage.tsx:59` | 进行中 / 即将召开 / 已结束 / 尚未开始 |
| Extension | `app/extensions/catalogueModel.ts:14-37` | 已启用 / 已关闭 / 生效状态待确认 |

Synonyms and conflicts to resolve:
- **Running:** 进行中, 研究进行中, 执行中, 运行中, 工作中.
- **Cancelled:** 已取消 (`taskPresentation.ts:77`, `sourceView.ts:31`) against 已停止 (`runPresentation.ts:44`, `ResearchObservatory.tsx:10`).
- **Failed:** 失败, 未完成, 未成功, 没能读取. `RUN_STATE_LABEL` explicitly avoids 失败.
- **Waiting:** 排队中, 待开始, 待执行, 等待中, 即将执行 (list) against 待执行 (queue) for the same state.
- **Done:** 已完成 is used for both a run and a one-time task that is finished.
- **Awaiting you:** 需要你, 等你, 待回答, 待核对, 待确认, 需要你补充.
- **待核对 has 4 meanings:** run delivered with an open verdict (`runPresentation.ts:39`), inbox review (`InboxPage.tsx:53`), "⚠ N 条待核对" (`claimCitations.ts:182`), and a payment under confirmation (`GeoMarketCard.tsx:23`).
- **正在读取** is both the generic loading sentence (`ProjectsSection.tsx:313`, `ConnectorsSection.tsx:195`, `AccountSection.tsx:106`) and the document-parsing status (`sourceView.ts:28`).
- **Run it again:** 重新整理, 重新读取, 重试, 刷新状态.
- **Run now:** 立即运行 (`TaskBar.tsx:77`) against 立即执行 (`ActiveResearchPage.tsx:415`).

---

## §C. Background automation

All paths are under `apps/server/src`. "Surface" is what a user can see. "Stop" is whether a person can stop it.

| Worker or timer | Module | Trigger | Does | Surface | Stop |
|---|---|---|---|---|---|
| `autopilotWorker.mjs` + `scheduleAutopilot` (`server.mjs:9101,9366`) | 定时任务, 主动科研 | 1 s poll + 60 s schedule | Dispatches due episodes and independent verifications. | Task page, inbox digests. | Yes: 暂停 / 删除 / 停止本次. |
| `learningWorker.mjs` + `scheduleConsolidation` (`server.mjs:9372`) | 记忆 | 5 s poll, hourly consolidation, off-peak window | Distills and consolidates methods from runs. | 做法 tab. | Yes: 记忆 switch (`MemoryControls.tsx:99`). |
| `nativeMemoryWorker.mjs` | 记忆 | per-account pass | Reads engine commits into revisions. | "刚记住了 N 条 撤销". | Yes: same switch, 忘记, 撤销. |
| `memoryIndexWorker.mjs` | 记忆 | 1 s poll | Indexes facts for recall. | None. | Indirect. |
| `sourceWorker.mjs` | 知识库 | 1 s poll | Parses documents and runs the understanding pass. | Row 正在读取. | Partial: delete cancels (`:253`). |
| `knowledgePageWorker.mjs` | 知识库 | 5 s poll + catch-up (first pass 1 min after start) | Compiles knowledge pages and the graph. | Strip and dot in 知识页 only. | No user switch. |
| `openVikingSourceSync.mjs`, `kbIndex.mjs` | 知识库 | timers | Sync and index sources. | None. | No. |
| `frontierWorker.mjs` | 前沿动态, 证据专区 | 5 s base, 12 loops (`:55`) | Pull, process, compose, evidence upkeep (answers 质疑), tags, leads, topics, zones, cleanup. | Feed, 简报, inbox. | Partial: 前沿日报 / 前沿周刊 / 相关安全警示 switches, unfollow. |
| `geoWorker.mjs`, `vcrWorker.mjs` | GEO, VCR | 5 s base, many loops | Probes, orders, studies, recompute. | Module pages, toast, inbox. | Project-level (covered by others). |
| `imWorker.mjs` | 设置 · Feishu | 2 s poll | Inbound tasks and pushes. | Feishu, 通知. | Yes: unbind or switch. |
| `reviewWorker.mjs` | 新对话 | 3 s poll | Reply checks on answers. | Row under each answer. | No. |
| `evimedCreditsWorker.mjs` | 额度 | 60 s | Retries 灵豆 settlements. | 用量. | No. |
| `evolutionWorker.mjs`, `evolutionServingWorker.mjs` | 定时任务, operators | 15 s, heavy window | Research opportunities, decisions, 进化日报. | 研究机会 group, operator inbox. | Operator only. |
| `rsiOnlineWorker.mjs` | operators | poll | Online export and withdrawal queues. | None. | Operator. |
| `pluginApplyWorker`, `personalSkillGenerationWorker`, `extension{Generation,Operation,Preparation}Worker` | 插件与技能 | 1 s polls | Apply plugins and skills, restart runtime. | State words on 插件与技能; 正在准备运行环境 in the frame. | Partial: disable or uninstall. |
| `documentExportWorker`, `resultReplayWorker` | export, VCR | 2 s | Render exports; replay results. | Download; VCR results. | No. |
| `webReadExtractWorker.mjs` | web read | on demand | Isolated HTML parser thread, not a scheduler. | None. | n/a |
| `server.mjs` timers | shell | 30 s capsule cleanup, 30 s notification defaults, 60 s usage reconcile, 60 s idle-runtime sweep, 15 s failed-stop reconcile, hourly session purge, 60 s research-DB cleanup | Housekeeping. | Idle runtime stops: "用到时自动启动" (`WebResourcesCard.tsx:189`). | No. |

Note: the notification timer applies a notice's default action when due, but only evolution decisions set one, and the inbox shows no "default applied" marker.

---

## §D. Defects (ranked)

1. **CONFIRMED:** a bounded scheduled run blocks the project's conversation with no earlier warning. `AutopilotPage.tsx:229-232`, `taskPresentation.ts:153-160`, `RuntimeUiFrame.tsx:117-119,148,1235`. The sidebar mark excludes non-conversation runs (`useProjectRuns.ts:15-19`). Scenario: a 07:00 task is running and you click 新对话. You get the alert "这个项目正在执行你设定的定时任务，结束后即可继续。" with 重试 and 查看定时任务.
2. **CONFIRMED:** 主动科研 stacks queue, observatory, current research, results, data, history, goal workbench and native pane (`ActiveResearchPage.tsx:393-455`). It has 3 open-conversation buttons (`:417,500,501`) and two truth sources, SSE against polling (`lib/researchObservation.ts:320` and `:253-254`). It is declared T4 (`page-templates.json`) but has no headline, ChartGrid or table.
3. **CONFIRMED:** a button that does not say it starts paid work. 添加到这个任务 (`MaterialPicker.tsx:49`) on a task paused for input calls `startAgenda` (`AutopilotPage.tsx:338`). Only the other path is labelled 补充材料并继续 (`ResearchProgress.tsx:43`).
4. **CONFIRMED:** the inbox ⋯ → 处理 → 解除绑定 unbinds Feishu in one click (`InboxPage.tsx:557-563` → `imService.mjs:608-615`). The same action in 设置 has a `ConfirmDialog` (`FeishuRows.tsx:171-177`).
5. **CONFIRMED:** the inbox list never refreshes while open. It reloads only on `[filter]` (`InboxPage.tsx:78-170`) and has no event or timer. The bell polls every 60 s (`InboxBell.tsx:12,70`) and shows a dot the list does not match.
6. **CONFIRMED:** the zone page says "正在为这个专区搜集内容，通常几分钟内出现第一批" (`FrontierZonePage.tsx:324`) but its only refresh is a manual 重新加载. The fetch effect has deps `[zone.id, overviewAttempt]` (`:187`). The same message shows for any active zone with no content, even one long established.
7. **CONFIRMED:** the challenge status "已提交，正在复核。结果会写进变更记录，也会通知你。" (`EvidenceChallenge.tsx:21`) never updates. Challenges are read once (`EvidenceReadingPage.tsx:110-117`).
8. **CONFIRMED:** the 正在记住 row stops polling at 60 s (`usePendingMemory.ts:6,29`) and stays on "还在记，比平时慢一些" (`MemoryRows.tsx:69`) until the page is reopened, even if the memory writes later.
9. **CONFIRMED:** one enum with divergent labels. Deliverable status has two maps (`TaskPane.tsx:11-13` against `runProgress.ts:159-167`). The material enum has two maps (`taskPresentation.ts:171` and `ResearchDataPanel.tsx:10-14`). `WEB_RUN_STATUS_LABEL` is dead (`runPresentation.ts:6`) and contradicts its sibling's comment about avoiding 失败. 待核对 has 4 meanings.
10. **CONFIRMED:** the knowledge compile is invisible outside the 知识页 view. `ProjectKnowledge.tsx:173-182` shows the strip only there, and the status dot draws only on attention (`KnowledgeStatusDot.tsx:19`). I found no user control to turn compiling off.
11. **CONFIRMED:** two modules over the same data use different words. 立即运行 (`TaskBar.tsx:77`) against 立即执行 (`ActiveResearchPage.tsx:415`). 新建定时任务 (`NewTaskPane.tsx:61`) against 新建定时研究 (`ActiveResearchPage.tsx:384`), both using `TaskForm`. 主动科研 lists routine jobs as 研究 (`ActiveResearchPage.tsx:153`), against `taskPresentation.ts:90`.
12. **CONFIRMED:** `RunFilePage` is declared T5 but is hand-built with its own header, arrow and h1 (`RunFilePage.tsx:161-173`). **UNCERTAIN:** `backTo` is `chatPath(run?.sessionId)` (`:155`). When the run is not found it falls back to bare `/app/chat`, which resumes the last conversation rather than the run's.
13. **CONFIRMED:** in `EvidenceReadingPage`, an error from a failed publish, comment or research shows a full `EmptyState` whose 重试 only reloads the card (`:237-246`), not the failed action. **UNCERTAIN:** 问这条证据 (current project) and 用这张卡继续研究 (creates a new project) sit side by side with similar wording.
14. **CONFIRMED:** only VCR has a completion toast (`useVcrFinishedToasts.ts`). Autopilot, compile, zone fill and challenge review have none, and `ActivityStrip` is used by only 2 of the AI-start surfaces. This contradicts DESIGN rule 10.
15. **UNCERTAIN:** AI input boxes sit inside overlays, against rule 2 ("A drawer never holds ... a second input box"): `ZoneEditorDrawer.tsx:240-249` ("想持续看什么？" plus 生成) and the 调整研究方向 dialog (`ActiveResearchPage.tsx:444`).

I did not read GEO or VCR (covered by others). The Frontier event, topic and congress pages I only grepped, and `Capabilities` and `Extensions` appear only through their counted intent sites.