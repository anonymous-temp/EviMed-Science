# Code audit: geo

Source reading of GitHub main 38b5af2a8 (2026-11-01), by a read-only agent. No browser was run. Paths are relative to `OpenScience/apps/web/src` unless they say otherwise; line numbers belong to that commit.

I did not write `/tmp/lay-1101/audit-geo.md`. My role here is read-only and forbids creating files, so the full audit is below instead of in a file, and it runs past your 15-line limit. The digest comes first, the evidence after it.

## Digest
- **Unseen kernel code.** The code that draws the frame's heading, card and three options is not in the snapshot. Only the payload it receives is: `frameGeoOptions.ts:54-57`, posted as `evimed.runtime-ui.geo` (`RuntimeUiFrame.tsx:719-724,1126-1129`). `packages/socket/plugins` has no slot code.
- **Counts.**
  - Step/progress displays: 9.
  - Step-state vocabularies: 8 owners, 10 words on the rail alone.
  - Next-action implementations: 8.
  - Conversation-opening buttons: about 35 in 19 files.
  - Immediate server starts: 6 sites on 3 APIs.
  - Page-level overlays: 8.
  - Tab-level drawers: 9.
  - Navigation dimensions at once on a result tab: 5, plus filters, search and the signals list.
  - Tabs shown as a control: 0 of 8.
- **Top defects.**
  1. The rail says 未请求 for dependency steps that will run automatically.
  2. 「查看诊断与开始测量」 lands on a tab with no start button.
  3. The same fact has 4 to 5 different words on one screen.
  4. The rail word contradicts its own glyph for waiting steps.
  5. In chat the page shows no results and no to-dos, and the header primary is gone.
  6. A rail step press is dead while a `?signal=` detail is open.
  7. Editing engines or coverage silently stops automatic monitoring.
  8. The 「会自动复测」 toast over-promises.
  9. There is no stop control and no `ActivityStrip`.

## 1. Element inventory

**(a) Step/progress: 9 implementations**
1. `StepRail` in the band: `GeoProjectPage.tsx:543`, built by `geoBand.ts:34-56`, drawn by `StepRail.tsx:127-166`.
2. The home preview's 「进度」 list, `GeoHomePreview.tsx:168-180`. Its `stepMark` (`:61-71`) is a second copy of the `bandSteps` mapping.
3. The journey card in the Overview tab: `GeoJourneySummary.tsx:21-31`, via `OverviewTab.tsx:85,97`.
4. The journey card in the home preview: `GeoHomePreview.tsx:147-153`.
5. The journey card in the native frame, as the `journey` payload: `frameGeoOptions.ts:55-57`. One computation, `geoJourney.ts:16-79`, three renderings.
6. The rail's trailing sentence `bandNow`: `geoBand.ts:107-142`, passed at `GeoProjectPage.tsx:543`.
7. `progressLine`, the list-row subline: `GeoHomePreview.tsx:36-52`.
8. `StepPending`/`StepState` in the tab body: `geoTabKit.tsx:89-134`, `StepState.tsx:94-189`.
9. The Tag 「项目第 N 周」, `GeoProjectPage.tsx:470,547`, plus `DiagnosisProgress` (`GeoQuestionWorkbench.tsx:249`) and the 「AI 运行」 drawer (`:453,593`).
- `ActivityStrip` is never used by GEO pages, although `PageShell` has the slot (`PageShell.tsx:175`).

**(b) Status words, by owner**
- Server step codes: `none|queued|running|done|minimal|failed` (`geoVocabulary.mjs:50`). They go raw to the frame in `journey.steps[].status` (`frameGeoOptions.ts:57`).
- `ProgressRail.tsx:39-46`: 已完成 / 进行中 / 等你 / 部分完成 / 需要留意 / 未开始.
- `geoBand.ts:55` overrides with 待确认 / 待开始 / 未请求 / 未开始 / 排队中. `GeoHomePreview.tsx:66,69` repeats this.
- `bandNow` (`geoBand.ts:107-142`):
  - 正在… / 排队中： / 复测等待额度 / 复测进行中 / 复测排队中
  - AI 回答测量暂停中 / …暂停测量
  - 待复测 / 计划日期 / 下次复测
- `geoJourney.ts:38-72` produces:
  - 尚未提交工作 / 本次工作：… / 历史工作范围待确认
  - 正在X / 已排队：X / 待继续：X
  - X等待额度 / X没有完成 / 本次工作已有结果
  - 自动监测已开启，等待下一轮 / 尚未开启自动监测
  - 项目已暂停 / 项目已归档
- `progressLine` (`GeoHomePreview.tsx:36-52`): 还没开始 / 正在做X / 只做了X / X没有做完.
- `StepState.tsx:125-185`: 还没有X / X，排队中 / 正在X / X没有完成.
- `NeedsYou.tsx:157,171`: X在等额度 / X没有做完.
- 「AI 运行」 drawer, `ProgrammeRunsDrawer.tsx:19`: 进行中 / 已完成 / 未完成.
- Monitoring heading, `GeoMonitoringAutomation.tsx:35`: 已开启自动监测 / 尚未开启自动监测 / 可选：持续监测.
- Domain labels:
  - Signals, `geoSignals.mjs:6`: 待处理 … 未完成，可继续处理.
  - Actions, `geoVocabulary.mjs:493`: 待写 … 已跳过.
- **Conflicts**
  - The same state (requested, not started) is 待开始 on the rail, 待继续： in the journey and 排队中 in the tab body (`geoTabKit.tsx:76-79,125`).
  - `minimal` means a dependency run at lower fidelity (`geoOrchestrator.mjs:162`, `fidelity: requested ? "full" : "minimal"`). The rail words it 部分完成.
  - Failure is worded four ways: 需要留意, 没有完成, 没有做完, 未完成.
  - The release act is worded three ways: 安全问题待确认 (`GeoHomePreview.tsx:31`), 放行 (`NeedsYou.tsx:89`) and 等你放行 (`ActionsParts.tsx:165`).

**(c) Next action: 8 implementations**
1. Header primary 「对话」 / 「在对话中开始」 (`GeoProjectPage.tsx:550`).
2. Toolbar `contextAction` per step (`:494-501,532`): 设预算 / 在对话中补充结论 / 在对话中重画旅程 / 在对话中补充问题 / 选目标档 / 在对话中写下一批.
3. `journey.next`, rendered four times: `GeoJourneySummary.tsx:26`, `GeoHomePreview.tsx:152` 「继续当前工作」, `GeoHomePage.tsx:267` 「继续工作」, and the frame's `nextLabel`.
4. NeedsYou rows, Overview tab only (`OverviewTab.tsx:91,161`).
5. The Overview Note with 查看产品依据 / 整理问题 (`OverviewTab.tsx:87`).
6. The three intent buttons 「在对话中诊断 AI 回答」 etc. (`GeoJourneySummary.tsx:29-31`).
7. The `StepPending` recipe button (`geoTabKit.tsx:131`).
8. The frame's three starters.
- `DESIGN.md:624` says the header primary is 「下一步：…」, but the code has 「对话」.

**(d) Inputs awaiting**
- Product facts:
  - the composer template `inputDraft` (`geoJourney.ts:37`)
  - the 先确认产品与资料 Note (`geoTabKit.tsx:127-129`)
  - the 身份待确认 Tag (`EvidenceTab.tsx:95`)
  - the frame card
- Budget has 5 doors and one `BudgetDialog`:
  - the rail tooltip 待你确认预算 (`geoBand.ts:54`)
  - NeedsYou (`NeedsYou.tsx:76-83`)
  - the toolbar 设预算 (`GeoProjectPage.tsx:494`)
  - `BudgetLine` (`ActionsTab.tsx:288`)
  - the settings row (`GeoSettingsDrawer.tsx:100`)
- Target tier: 选这一档 (`PlanStrategy.tsx:137`) and 选目标档 (`GeoProjectPage.tsx:500`). It is not in NeedsYou, the rail or the journey.
- Engines are shown in 4 controls, 2 of which write: `GeoSettingsDrawer.tsx:68-86` (write), the frame chip (`useFrameGeoOptions.ts:108-137`, write), `GeoScopeDialog.tsx:55-57` (read filter), and the tab 引擎 selects.
- Coverage days: the drawer (`GeoSettingsDrawer.tsx:87-98`) and the frame chip both write; the scope dialog's date range only filters.
- Producer / reviewer: `ActionsTab.tsx:67-70,292`.
- Automation consent: `GeoMonitoringAutomation.tsx`, shown on the 可见度 tab only.

**(e) Things to confirm**
- One list, `NeedsYou.tsx:37-61`, on the Overview tab only. Its kinds are set_budget, release_articles, correct_severe_error, client_action, credits_waiting and step_failed (`geoClient.ts:251`).
- Also elsewhere: legacy 待确认 on the rail and in the journey, the product-identity Tag, automation consent, five `ConfirmDialog`s, and signal disposition (`GeoSignalsWorkbench.tsx:222`).

**(f) Ways to start work: what each does**
- Starts server work immediately, with no confirm:
  - `StepPending` 「开始任务：X」 → `runGeoStep` (`geoTabKit.tsx:102-116`)
  - NeedsYou 「接着做」 → `runGeoStep` (`NeedsYou.tsx:179-186`)
  - 「周报」 and menu 「导出周报」 / 「导出提案资料包」 → `exportGeo` (`GeoProjectPage.tsx:370-384,450-451,552`). The label says export but it starts a generation run.
  - 「启动第 N 版诊断」 → `startGeoDiagnosis` (`GeoQuestionWorkbench.tsx:198-208,234`)
- Writes consent or authority:
  - 开始自动监测 (`GeoMonitoringAutomation.tsx:32,40`)
  - 设置预算 saves, then the toast says 「稿件会在预算内自动投放。」 (`GeoProjectPage.tsx:617`)
  - 选这一档 (`PlanStrategy.tsx:101-111`: 「之后按这一档写稿和投放」)
  - 放行 / 撤回 (`useArticleActions.tsx:46-60`, behind a confirm)
  - 登记链接 (`OwnedLinkForm.tsx:54-62`)
- Only fills the composer with an unsent draft, never sends (`geoText.ts:372-376`): every 「在对话中…」, 「问 AI」, 「让 AI …」, 「写纠错稿」, the 3 frame starters, and the frame journey button. Some drafts start with a visible `/geo-insight` (`QuestionsTab.tsx:296`, `GeoQuestionWorkbench.tsx:232`).
- Changes state: 暂停 / 继续 (`GeoProjectPage.tsx:441-445`), engine/coverage 保存, the frame chip patch.
- Opens a conversation; the next two bullets are not start-work buttons:
  - 新建项目 creates the project and opens its conversation (`GeoHomePage.tsx:108-118`).
  - 「选目标档」 navigates to 方案#targets.

**(g) Conversation entry points**
- 19 files call `useOpenGeoConversation`, about 35 labelled buttons. Labels vary: 对话, 在对话中开始, 在对话中X, 问 AI, 让 AI X, 写纠错稿, 准备纠错内容, 核查所选版本.
- The 「对话」 button (`GeoProjectPage.tsx:550`, `openChat` at `:420-425`) opens `heldSession`, i.e. the project's primary session or the one in `?session=`, with no draft.
- It is not rendered in chat (`!onChat`). It is hidden or replaced for read-only roles (`:398-402`).
- Opening a conversation navigates to `/app/geo/:id/chat/:session` (`useOpenGeoConversation.ts:67-70`). That is another route, not a view of the same page.

**(h) Settings, panels, drawers, dialogs**
- Page level (8), rendered in `GeoProjectPage.tsx:578-631`:
  - settings drawer
  - members dialog
  - runs drawer
  - rename dialog
  - producer dialog
  - budget dialog
  - delete confirm
  - 分析范围 dialog
- Tab level, 9 drawers: Error, Cluster, Action, Source, Claim (`EvidenceTab.tsx:188`), Order (`DistributionWorkbench.tsx:118`), MetricMembers, AnalysisMembers, ErrorGroup.
- Also `ArticleTextDialog` and 6 more `ConfirmDialog` sites.

## 2. Steps, tabs, selects

**The tabs**
- `GEO_TABS` (`geoTabs.ts:13-22`) is never drawn as a control. It appears only as an sr-only h2 (`GeoProjectPage.tsx:648`) and as 「返回{tab}」 (`:666`).

**The mapping**
- `GEO_STEP_HOME` (`geoTabs.ts:78-87`) maps the 8 steps onto 6 tabs.
- 总览 and 方案 have no step. 总览 is reached only through the back link (`:540`). 方案 is reached only through 分析视图 (`:508`), 选目标档 (`:500`) or in-body links.
- On 方案, `geoViewedStep` falls through to `GEO_TAB_STEPS.plan[0]` = sources (`geoTabs.ts:198`), so the 信源 step is underlined.

**Controls on a result tab, in the order they sit**
1. Rail: 8 links.
2. 数据分析 select: 27 views plus 当前业务 (`:515`, options at `geoAnalysisMode.ts:4-32`).
3. 分析视图 select, only for the diagnosis, sources and monitoring steps (`:506-509,516`). It renames tabs: visibility is 可见度 or 趋势, actions is 执行记录.
4. The tab's own 视图 chips or selects, set in `QuestionsTab.tsx:209`, `EvidenceTab.tsx:75`, `SourcesTab.tsx:284` and `AccuracyTab.tsx:251`.
5. 分析范围 button, which opens the dialog (`:526`).
6. Below those: filters, search, `contextAction` and the signals list (`GeoSignalsWorkbench.tsx`).

**What a press does**
- Rail step: pushes the destination (`:472-486`) and keeps the scope and filters. It exits analysis mode and leaves chat.
- 数据分析: pushes `?analysis=Vxx`, replaces the body with `GeoAnalysisMainArea` (`:657-669`), and the 分析视图 select disappears (`:516`).
- 分析视图: pushes the other tab (`:517`).
- Tab 视图 chips: replace in place.
- Scope apply: replaces the URL, shows a skeleton and hides the body (`:574-575`).

**Overlaps**
- The analysis views mirror existing tab objects: V13/V12 ↔ 准确与安全, V02 ↔ 可见度, V16 ↔ 依据, V17–V22 ↔ 信源, V23/V25 ↔ 行动, V26 ↔ 方案, V10 ↔ 旅程, V01 ↔ 总览.
- The 依据 chip 「证据覆盖」 is itself a link into V16 (`EvidenceTab.tsx:88`).
- There are 14 in-body `GeoAnalysisEntry` links as a third door to the same 27 views.
- 问句池, 引擎 and 问题群 are filters in different UI kinds across tabs and the dialog.
- Rule 5 in `DESIGN.md:565` allows one row of views.

## 3. Conversation versus workbench
- **Hidden in chat.** The body is only the pane (`GeoProjectPage.tsx:564-567`). Hidden: all tab bodies, signals, NeedsYou, every toolbar control (`:505`), and the header primary (`:550`). Still shown: back link, Tag, 周报/继续, the ⋯ menu, the rail and its trailing sentence.
- **Results while chatting.** No. The only live signal is the rail's state words and the trailing sentence.
- **Refresh after a turn.** The page polls every 10 s while steps run and every 30 s otherwise (`:99-100,239-246`), and on `visibilitychange`. It re-reads the shared views when `stepsState` changes or `freshRead` is set (`:198-203`). The frame's chip options refresh only on `RUNS_CHANGED_EVENT` (`useFrameGeoOptions.ts:63-68`). That event is announced only by `dispatch.ts:60`, `ConversationMenu.tsx:76,99`, `ProjectsSection.tsx:367` and `ConnectorNeedNotice.tsx:85`. No frame-to-shell message announces a finished turn (message list at `RuntimeUiFrame.tsx:772-1010`).
- **Result back into the conversation.**
  - `stageGeoPlanContext` plus an unsent draft, from drawers, the answer page, plan, analysis, signals and errors.
  - `resultRevision` for article revisions.
  - The header 「对话」 sends no context. The URL carries `result` and `step` only to underline the rail (`useOpenGeoConversation.ts:65`).
  - Page to conversation is by button. Conversation to page is by rail or back link, or the frame's `shell-navigate geo+tab` (`RuntimeUiFrame.tsx:809-817`).
- **Composer position.**
  - The shell only sizes the pane, `max(360, clientHeight − top − 24)` (`GeoConversationPane.tsx:31-35`), and pads for the safe-area inset (`RuntimeUiFrame.tsx:1218-1223`).
  - Empty and has-messages are kernel states. The locale keys `placeholder.hero` and `placeholder.default` (`runtimeUiLocale.mjs:71-74`) show two states exist.
  - The composer's position per state is UNCERTAIN, because it is not in this repo.

## 4. Automation
- **Runs on its own.**
  - Dependencies of a requested step: `geoWorkflowState` `required` (`geoWorkflow.mjs:26-30`). They run at fidelity "minimal" (`geoOrchestrator.mjs:162`).
  - Queued-step chaining, `StepState.tsx:138` 「做完后自动开始」, and exports (`GeoProjectPage.tsx:382,384`).
  - Allowance resume (`NeedsYou.tsx:158`).
  - Scheduled weekly, sentinel, post-publication and noise rounds. These run only if automation consent matches the engines and coverage days, and monitoring is wanted (`geoOrchestrator.mjs:633,1850`; `geoWorkflow.mjs:47-54`).
- **Needs a person.**
  - Budget, release/withdraw, producer and reviewer, client actions, allowance top-up.
  - Automation consent, 选这一档, the question version and 启动诊断, and product facts.
- **What the page says.**
  - The rail trailing sentence.
  - `StepState` queued text.
  - Toasts: 「…排在前一项之后，做完会自动开始」, 「预算已设好，稿件会在预算内自动投放」.
  - The `GeoMonitoringAutomation` copy (`:37,41`).
- **Where it says nothing.**
  - Nothing says required dependencies auto-run: the rail says 未请求.
  - 部分完成 is never explained as "minimal fidelity".
  - `GEO_STEP_WAITING` (`geoText.ts:211`) has the "starts after X / next morning / every Monday" copy, but only the diagnosis line is used (`GeoHomePreview.tsx:81`).
  - Consent is not shown as 等你 on the rail.
  - Changing engines or coverage stops automation with no note.
  - Starts show no cost, except in `GeoMonitoringAutomation.tsx:41`.
  - A running step has no stop.

## 5. Defects, ranked
1. **CONFIRMED.** The rail says 未请求 for dependency steps that are about to run, while the tab body says 排队中.
   - `bandSteps` reads only the raw `requested` flag (`geoBand.ts:55`).
   - Dependencies are `required` but not `requested` (`geoOrchestrator.mjs:720`, `geoWorkflow.mjs:26`), and the tab shows 排队中 (`geoTabKit.tsx:76-79,125`).
   - You press 开始任务 on a downstream step and its upstream steps stay 未请求 until they run.
2. **CONFIRMED.** The next-step label 「查看诊断与开始测量」 (`geoJourney.ts:45`) goes to `GEO_STEP_HOME.diagnosis` (准确与安全#errors, `geoTabs.ts:82`).
   - `AccuracyTab` has no `StepPending` or start control; only Journey, Questions, Actions, Evidence and Sources tabs use it.
   - The real start is 「启动第 N 版诊断」 in 问题与回答 (`GeoQuestionWorkbench.tsx:234`).
   - You see 未测 tiles and no button.
3. **CONFIRMED.** Four to five words describe one state on one screen: rail 未请求 (`geoBand.ts:55`), card 尚未提交工作 (`geoJourney.ts:38`), list 还没开始 (`GeoHomePreview.tsx:48`), and todo 未开始 (`ProgressRail.tsx:45`). Requested-not-started is 待开始 / 待继续 / 排队中 (see (b)).
4. **CONFIRMED.** For waiting steps the rail word contradicts its glyph.
   - `state` becomes "waiting" for budget or allowance (`geoBand.ts:48`), but `stateLabel` wins in the tooltip (`StepRail.tsx:137,148`).
   - Budget wait with status none shows 待开始 or 未请求.
   - Allowance wait (always `queued`, `allowanceWait.ts:9`) shows 排队中 with the waiting glyph.
   - `bandNow` excludes it from 「排队中：」 (`geoBand.ts:114-121`), while NeedsYou and the journey say 在等额度 / 等待额度.
5. **CONFIRMED.** In chat the user sees no results and no to-dos, and the page's single primary action disappears.
   - NeedsYou is Overview-only (`OverviewTab.tsx:91,161`), and chat renders only the pane (`GeoProjectPage.tsx:564-567`).
   - `DESIGN.md:652` forbids "a button that carries the person to the conversation", and `:606` says the conversation is a view of the same page, yet the code navigates to `/chat`.
   - `DESIGN.md:600` says the primary is 「对话」, while `:624` says 「下一步：…」.
6. **CONFIRMED.** A rail step press is dead while a signal detail is open.
   - `destination()` never drops `signal` or `signals` (`GeoProjectPage.tsx:472-486`).
   - The tab body stays hidden by `params.has("signal")` (`:575`) and the detail stays (`GeoSignalsWorkbench.tsx:45`).
   - The underline moves; the content does not. Only 「返回记录」 clears it.
7. **CONFIRMED.** Changing engines or coverage days silently stops automatic monitoring.
   - Writers: `GeoSettingsDrawer.tsx:49-55` and `useFrameGeoOptions.ts:124`.
   - Their toasts say only 「下一轮测量按新的引擎问」 (`GeoSettingsDrawer.tsx:51`).
   - The server claims rounds only if consent still matches engines and `coverage_days` (`geoOrchestrator.mjs:633-640`).
   - The 「下次复测」 text vanishes from the rail (`geoBand.ts:131`). Only the 可见度 tab explains it (`GeoMonitoringAutomation.tsx:37`).
8. **CONFIRMED.** The link-registration toast 「发布后第 1、2、4、8、12 周会自动复测」 (`OwnedLinkForm.tsx:62`) is unconditional, but those rounds exist only under automation consent (`geoOrchestrator.mjs:1850,1923`).
9. **CONFIRMED.** Running work has no stop or cancel.
   - `GeoProjectPage` passes no `activity` (`:535-557`); `StepPending` passes no `onStop` (`geoTabKit.tsx:124-125`).
   - `StepState` draws 停止 and 取消 only with `onStop` (`StepState.tsx:140,160`).
   - The only running signal is a truncated caption (`StepRail.tsx:164`).
   - Rule 10 at `DESIGN.md:604` and the T3 `activity` slot at `:624` expect an `ActivityStrip`.
10. **CONFIRMED.** Buttons that look alike have very different consequences, and none of the immediate ones ask for confirmation. The exceptions are release and withdraw (`useArticleActions.tsx:46-60`), cancel order and mark-updated (`DistributionWorkbench.tsx:137,203`), delete and leave-edit.
    - Immediate starts and writes: the six start sites, 开始自动监测 (recurring spend), 设预算 (authorizes auto-placement), 选这一档, and 导出* (labelled export, but starts a run).
    - Draft-only: about 35 conversation buttons, none of which say 「发送后开始」, except the single Overview Note (`GeoJourneySummary.tsx:30`).
11. **CONFIRMED.** Three of 8 steps have no start recipe in their destination: 诊断, 投放 and 监测. 监测 gets an opt-in section and 投放 gets `BudgetLine` plus the workbench (`ActionsTab.tsx:288-289`). This breaks rule 12 (`DESIGN.md:610`). `StepPending` even has an unreachable monitoring branch (`geoTabKit.tsx:104-107`).
12. **CONFIRMED.** Monitoring consent is a human stop, but the rail never marks it 等你.
    - The rail comment says the budget is the only one (`geoBand.ts:26`).
    - The journey gives monitoring its own blocked stage (`geoJourney.ts:67-69`).
13. **CONFIRMED.** The Tag 「项目第 1 周」 appears on a project where nothing has started.
    - `weekOf(startedAt ?? createdAt)` (`geoText.ts:428-432`, `GeoProjectPage.tsx:470,547`).
    - The qualifier 「不代表已经完成测量」 is hover-only.
    - It sits beside 8 × 未请求 and 「尚未提交工作」.
14. **CONFIRMED in code.** The header label and 周报 change once the monitoring read lands.
    - `unstarted` needs `watched` (`GeoProjectPage.tsx:436-440`): 「对话」 + 「周报」 first, then 「在对话中开始」 with 周报 gone (`:550-552`).
    - 导出提案资料包 is offered on an empty project (`:451`).
15. **CONFIRMED.** The page has 8 tabs and no tab control. 分析视图 relabels tabs (`:506-509`), and 总览 and 方案 are unreachable from the rail (see §2).
16. **CONFIRMED.** Engine chips look the same but behave differently: the drawer writes, the scope dialog filters (`GeoScopeDialog.tsx:55`, labelled 「AI 平台（不选即全部）」), and the frame chip writes.
17. **CONFIRMED in code; effect UNCERTAIN.** The frame's journey card refreshes only on `RUNS_CHANGED_EVENT` (`useFrameGeoOptions.ts:63-68,98`), while the rail refreshes by poll. After a turn writes the project, the card can say 「尚未提交工作」 while the rail has moved on. Whether the kernel hero outlives the first message is unknown.
18. **CONFIRMED.** The same input requirement is stated five times on the screen.
    - The card detail (`geoJourney.ts:40`), the card button's draft (`:37`), and the three requirement lines. Two of the three requirement lines are identical (`frameGeoOptions.ts:54`).
    - The lines don't match what the starter drafts actually ask. 诊断 asks for 受众与场景 (`geoText.ts:378`), and 策略 asks for 受众、要解决的问题、已有资料与约束 (`:380`), but both lines say 「产品与适用场景、目标受众、本次目标」.
19. **CONFIRMED.** The answer page has two back controls with different targets: 项目总览 (`GeoProjectPage.tsx:540-542`) and the ArrowLeft `BackLink` (`GeoAnswerPage.tsx:129-133`). It also has two conversation buttons: the header 「对话」 with no draft and the answer's 「在对话中处理」 / 「写纠错稿」 (`:256`).
20. **CONFIRMED.** Release wording and spec disagree. The NeedsYou header says 「Nothing here is an approval」 (`NeedsYou.tsx:30`), but `release_articles` is a publishing approval confirmed by 「可以对外发布」 (`useArticleActions.tsx:55-60`).

**Kernel-owned unknowns (UNCERTAIN, not counted as defects)**
- How the kernel renders `journey.steps[].status`, which is raw English codes in the payload (`frameGeoOptions.ts:57`).
- How the kernel uses `nextStep`. The shell maps only tab names, and step keys happen to pass `isGeoTab` through redirects (`RuntimeUiFrame.tsx:814`).
- Whether any kernel button sends `new-task` plus a draft, which navigates to the ordinary `/app/chat` instead of the GEO conversation (`RuntimeUiFrame.tsx:803,832`).