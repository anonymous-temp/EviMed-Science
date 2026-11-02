# Code audit: vcr-tools

Source reading of GitHub main 38b5af2a8 (2026-11-01), by a read-only agent. No browser was run. Paths are relative to `OpenScience/apps/web/src` unless they say otherwise; line numbers belong to that commit.

I did not write `/tmp/lay-1101/audit-vcr.md`. This session is read-only and forbids creating files, so the full audit is inline below for you to save. The audit is by source reading only. "CONFIRMED" means shown by the code; nothing was observed in a running browser.

**Counts:** 8 routes, plus the chat view and 3 library views. 15 defects: 14 CONFIRMED, 1 UNCERTAIN. 10 status vocabularies. 17 `<Drawer>` sites. 9 header-menu entries. About 15 kinds of "confirm" control.

**Top defects**
1. **Start buttons look alike but behave differently.** "生成虚拟患者" only opens chat with an unsent draft. "为该患者找试验" and "开始评估" start server jobs at once.
2. **Home "新研究" then "开始" starts nothing.** It lands in the global assistant with a draft.
3. **"需要你" shows for readers who cannot act.** Following "去处理" lands on a page that shows nothing to do.
4. **"停止" and "取消" cancel the whole study.** They are labelled as if they affect one step.
5. **`awaiting_budget` is shown as a failed comparison.** The page offers a retry that queues a second job.
6. **A paused study never shows as paused.**

---

# 虚拟临床研究 (VCR) / 科研工具 / 插件与技能: front-end audit

Paths are relative to `/tmp/lay-1101/OpenScience/apps/web/src/`.
Abbreviations: `VHP` = `app/virtual-research/VcrHomePage.tsx`, `VSP` = `app/virtual-research/VcrStudyPage.tsx`, `SF` = `components/vcr/StudyFrame.tsx`, `VST` = `components/vcr/VcrStates.tsx`, `VHV` = `components/vcr/VcrHomePreview.tsx`, `UC` = `components/ui`.

## 1. Routes, template, render per state

Templates come from `scripts/ops/page-templates.json`.

**R1 `/app/virtual-research` (VHP:103). T2 `MasterDetail`, budget data (json:51).**
- Left column (340 px):
  - `PageHeader` "虚拟临床研究", with the primary "新研究" only when a study is chosen (VHP:278).
  - Toolbar (VHP:211): pinned select "查看" (研究/参考试验/人群定义/模型与参数), chips "状态" (全部/需要你/进行中/已完成, only counts > 0), select "排序" (最近更新/按状态), search "搜索研究", summary "N 项", icon button "刷新研究列表".
  - List "研究": name, status line, `updatedAt`.
  - Disclosure "历史独立计算 · N" and, below it, "旧版未发送草稿 · N".
- Right column (at least 560 px):
  - Nothing chosen: form "新研究" (VHP:332). It holds a SegmentedControl "研究任务" (患者匹配/人群与患者/合成对照/虚拟试验), a summary line, a Tag (`inputLabel`), Disclosure "数据要求" and button "开始".
  - Study chosen via `?study=`: `VcrStudyPreview` (VHV:205). It has:
    - Title and status line.
    - Buttons "打开研究", "原研究对话" or "继续未发送的研究问题", and "关闭预览".
    - A Note "需要你 · …" per attention line.
    - Facts 研究问题/最新结论/最近更新.
    - A Section "进度 n / m" with the step marks.
- States:
  - Empty: EmptyState "暂无研究" ("选一项任务开始后，研究会列在这里。", VHP:252) plus the form.
  - Loading: skeleton.
  - Filter matches nothing: "没有匹配的研究" with "清除筛选".
  - Load error: LoadError, or the retained list plus LoadError.
  - Module off: "虚拟临床研究还没有在这个工作空间开放。"
  - Failed study: no per-row failure. It appears only as "需要你 · 「患者」这一步没有做完，已算出的部分保留".

**R2 `/app/virtual-research?tab=precedents|definitions|models` (VHP:350, `OtherViews`). T1 (json:52-53).**
- `PageShell` with back link "回到研究列表". The toolbar merges the panel's controls.
- The models view is not in the walk table. Its empty state is "还没有保存的模型与参数", with "在对话中整理来源" opening the global assistant.

**R3 `/app/virtual-research/:studyId/:tab?` (VSP:93, SF:83). T3 conversation/result variant (json:88-94, "budget":"geo", shapes 3).**
- Header:
  - Back link "虚拟临床研究" (or "独立计算").
  - Title is the study name. Meta is the tier plus, when downgraded, a button "{申请} → {上限}" opening Drawer "预期用途".
  - Primary is "确认预算" or the tab's own primary ("选定方案" on 试验).
  - Secondary is "研究对话" (hidden in chat). Overflow is "更多操作" with 9 entries: 重命名, 导出…, 数据接入, 成员与角色, 计算预算, 暂停/继续, 变更记录, AI 运行, 删除.
- Sticky band:
  - `ActivityStrip` (SF:55).
  - Toolbar navigation: select "查看" (对话 plus 总览/匹配/人群与患者/对照/试验/依据), a second select "人群与患者" (队列总览/个体患者) on population, then the tab's own views, filters and actions (SF:128-138).
- Body, top to bottom: Note "请求已保留。研究对话连接后会恢复到输入框，由你发送。" (VSP:297), `VcrTierOffer` ("升到 T?"), the budget Note, then the tab body or `VcrPackageReader` (`?package=`).
- Per-state render of any step tab:
  - Empty: `VcrStepPending` (VST:133). EmptyState "还没有{noun}", then "用 … 得到 …", then a button named for the action (e.g. "生成虚拟患者").
  - Queued: "{step}，排队中" with "轮到它时会自动开始。" and "取消".
  - Running: strip "正在{label}" plus a body "正在{step}" with "停止".
  - Has results: result blocks wrapped in `Stale` and `PartialResultNote`.
  - Failed: `VcrStepFailed` (VST:250). "这一步未完成", the step's note, and "在对话中继续".
- 总览 (`OverviewTab.tsx:46`), stacked: Headline, "研究进展" (3 independent states), counts band, attention Notes, "研究记录" (7 step rows with `RailMark`), "交付物". With no question or definition it shows "先在对话里说一句要研究什么" and "说明研究问题".
- 依据 (`DataTab.tsx:136-190`) stacks:
  - Followup history, definition card (PICO) and 病种定义包 select with "绑定".
  - Reference search and registry coverage.
  - 假设卡 master-detail, 参考试验 table, 待核对的参考试验.
  - In the empty case the start button is last.
- 匹配 (`MatchingTab.tsx`): chips "匹配方向" (给试验找患者/给患者找试验), selects "查看方案" and "患者", action "开始评估", coverage Note, funnel tiles, patient list with criteria table, "临床记录与更正". Unavailable state: "暂时无法进行患者匹配" with three buttons.
- 人群 / 患者 / 对照 / 试验: toolbar actions, result blocks and `Stale` as above. Trial chips are 方案/访视/监管.
- **R3b `/app/virtual-research/:studyId/chat`:**
  - `StudyPane` (`StudyPane.tsx:280`): an empty box that the resident kernel iframe (with its composer) overlays.
  - A run holding the conversation shows `StepState` "正在…", "停止" and "结束后可以在这里继续".
  - Other panes: "这项研究的对话在负责人的项目里"; "正在准备对话", then after 20 s "对话暂时打不开" with "重试".
  - Not in the walk table.

**R4 `/app/capabilities/calculations/:studyId` (`routes/VcrCalculationWorkbenchPage.tsx:16`). T1.**
- Header links "资料与证据" and "入排匹配".
- Body: Section "历史计算", or EmptyState "这里还没有历史计算" with link "开始研究对话".
- Rows with no method have no `onOpen`.
- With `:tab` it renders `VcrStudyPage` (a calculation frame with the same header, strip and band).

**R5 `/app/capabilities/methods/:methodId?study&job&view` (`routes/VcrMethodWorkbenchPage.tsx:17`). T4.**
- Without ids: "计算已移入研究对话" / "描述研究问题，AI 会查找证据、选择方法并调用计算。" with link "开始研究任务".
- With ids: back link "返回研究结果" or "计算历史", header link "研究对话" (programme studies only), `VcrMethodResult`, and Disclosure "本次运行配置".

**R6 `/app/capabilities` (`routes/CapabilitiesPage.tsx:161`). T1 (json:47).**
- Toolbar: chips "分类", search "搜索工具", summary "N 个". Above the list: `SimulatedAllowanceNotice`.
- Sections per category, rows with:
  - Tag (availability), "约 a～b 分钟", "约 N 灵豆".
  - Link "去添加" when a connector is missing.
- A row press binds the capability and opens a new, empty `/app/chat`.
- States: skeleton; "无法加载工具目录：…"; "没有符合条件的科研工具" with "清除筛选".

**R7 `/app/extensions/:tab/:itemId?` (`app/extensions/ExtensionsPage.tsx:53`). T1, budget "extension" (json:74-77).**
- Header "插件与技能", project meta, and Menu "导入与创建" (trigger button "添加技能": 导入技能/创建技能).
- Toolbar: views 发现/已添加; filters 类型/来源/分类; search.
- Notes: up to 10 per-source retry notes ("重试技能目录" …), plus "继续核查普通导入" and pending transfers.
- Body: `CatalogueView`, grouped by origin (第三方 / EviMed Science / 我的技能). 发现 is a card grid, 已添加 is `ListRow`s with switches.
- Drawers: personal skill, platform skill, extension, citation/inventory.
- `?compose=create|import` swaps the whole body for the editor or import form.
- States: skeleton; EmptyState "没有找到匹配项" / "还没有添加这类扩展" / "暂无可添加的扩展" with "浏览全部".

## 2. Element inventory

**Step or progress display.** Four coexisting forms, plus `ActivityStrip`:
1. 总览 "研究记录" (OverviewTab:95-121).
2. Home preview "进度 n / m" (VHV:274).
3. List line "已完成 n / m 步" (VHV:171).
4. Per-tab `StepState`.

`ActivityStrip` shows counts and elapsed time but no percentage, and "另有 N 项排队".

**Status vocabularies**

| # | Owner | Words |
|---|---|---|
| 1 | step status, `packages/domain/src/vcrVocabulary.mjs:441` | 未开始/排队中/进行中/已完成 (done and minimal)/已过期/未完成 |
| 2 | job state (:794) | 排队中/进行中/已完成/未完成/已取消/待确认预算. Exported by `vcrText.ts:71`; the only web references are re-export comments; no UI renders `jobStateLabel`/`jobWaitLabel`. |
| 3 | study status (:542) | 未命名/进行中/已暂停/已归档. Never rendered; only the toasts "已暂停。" and "已继续。" (VSP:200). |
| 4 | list state (VHP:68; VHV:160-171) | 需要你/进行中/已完成/"已完成 n / m 步"/还没开始 |
| 5 | rail words (`UC/ProgressRail.tsx:39`; VHV:178) | 已完成/进行中/等你/部分完成/需要留意/未开始 (+未请求) |
| 6 | research progress (`VcrResearchProgress.tsx:16-20`) | 10 calculation values (尚无计算结果, 排队中, 计算中, 等待计算预算, 计算未完成, 计算已取消, 结果已生成, 结果有局限, 不可估计, 结果已过期，需重新计算); 4 input values; 人群定义 已保存/尚未保存 |
| 7 | waiting phrases (`vcrActivity.ts:68-74`) | 等计算引擎恢复/等研究额度/等这次运行做完/等“X”做完/等待开始 |
| 8 | stale (5 wordings) | 输入已变更，排队重算中 / 输入已变更，这些数字可能已过期 / 已过期 / "{n} 个结果已过期" / "输入已变更，结果已过期" |
| 9 | conclusion and route/criterion states | 可估计/有限制地估计/不可估计; 不适用/情景/设计期可用 |
| 10 | 插件与技能 activation (`catalogueModel.ts:6-38`) | 15 strings, from 已启用 and 已关闭 through 生效状态待确认, 下次对话生效, 等待当前任务结束后生效, 暂未生效，稍后会自动再试, 更改未生效，请重试, 需要处理, 需要连接账户, 正在准备, 已从个人库移除, 未在当前项目启用, 循证 GEO 项目中不适用 to 当前环境未提供 |

**Next action.**
- The server's `vcrNext` is not consumed. `study.next` has no reference in the web code.
- `OverviewTab.tsx:32-34` claims the next step is in the header of every tab. `SF:117` shows only "确认预算" or the tab primary ("选定方案").
- So VCR has no "next" anywhere except per-tab empty states and attention Notes.

**Inputs awaiting.**
- Page-level only for allowance (`StepState` credits plus `AllowanceTopUp`) and budget (header "确认预算" plus Note "有 N 项计算等你确认预算").
- A missing definition shows "先在对话里说一句要研究什么".
- `conversation.awaitingInput` and `submitted` are mapped at `lib/vcrClient.ts:542,1769` and never read.

**Things to confirm.** About 15 kinds across 9 containers (header primary, Note, strip, menu, drawers, dialogs, toolbar, body buttons, tier offer):
- Budget ("确认预算", "全部确认", "确认").
- "升到 T?".
- "选定方案" / "改选方案", which opens a Drawer ending in "写入决策记录" (`TrialTab.tsx:643`).
- "复核这份评估", "改判", "签注复核".
- "确认字段映射", the snapshot freeze, "授权", "保存云端处理授权", "保存脱敏文本".
- "登记预测", "添加监管沟通".
- The matching evidence-request decision record, and "申请成为平台病种定义包".

**Ways of starting work (each button)**

| Button | What it does |
|---|---|
| Home "开始" (VHP:339) | `ask(task.draft)`: `select("default")` then `navigate /app/chat` with an unsent draft in the global assistant (`useGeneralResearchDraft.ts:64`). Creates no study. |
| Home "新研究" (VHP:186) | Sets `?new=1` and shows the form. No state change. |
| Empty-state button, e.g. "生成虚拟患者" (VST:208) | `frame.openChat(draft, {kind:"step"…})`: navigates to chat with an unsent draft. |
| "在对话中调整", "在对话中生成新版本", "在对话中添加方案", "在对话中调整假设" | Same: draft plus object reference. |
| "为该患者找试验" (`PatientTrials.tsx:135`) | `runVcrTrialSearch`: starts a run now. |
| "开始评估", "开始评估所选方案", "重新评估" (`ClinicalMatchingDetails.tsx:38-48`) | `enqueueVcrMatching`: queues jobs now. |
| "比较所选预测" (`VcrForecastComparison.tsx:52`) | `queueVcrJob`: queues a job now. |
| "比较版本" in the 定义库 section (`VcrKnowledge.tsx:480`) | Runs `compareVcrDefinition` directly. |
| Menu "导出…" | Starts an export run via `useVcrRun` (VSP:192). |
| "用于本研究", "存入定义库", "绑定", "升到 T?", "暂停/继续" | Direct writes. |
| Nothing | Publishes. No publish control found in these files. |

**Conversation entry points.** About 15 labels, 3 destinations:
- Study chat view: "研究对话" (header), "对话" (查看 select), "说明研究问题", "在对话中继续", "原研究对话", "继续未发送的研究问题", "返回研究对话", "重试连接研究对话", "恢复到对话输入框", "将比较请求放入研究对话".
- Global assistant: "开始", "在对话中使用", "在对话中补充来源", "在对话中整理来源".
- Two link labels that go to the VCR home list, not a conversation: "开始研究对话", "开始研究任务".

**How conversation and results coexist.** Swap, not side by side.
- Chat or a result destination is chosen with the `查看` select or the header "研究对话".
- The chat box is a placeholder that the resident frame overlays (StudyPane:313).
- Results are unmounted while in chat.

**Composer position.** Inside the page, below header and band, with height fitted to the viewport (`StudyPane.tsx:239-259`).

**Drawers and dialogs.**
- 17 `<Drawer>` sites in VCR: 预期用途, 变更记录, AI 运行, 数据接入, 计算预算, 在对话中比较版本, 成员与角色, 选定方案, 添加监管沟通记录, 方案 x, 登记预测, 改判, 存入定义库, 虚拟患者, 模型评估, number provenance, registry trial.
- Plus `VcrRenameDialog`, `VcrExportDialog`, and the delete `ConfirmDialog` "删除“…”？".
- Plus 5 drawers in 插件与技能.

## 3. Conversation and page link

**Live refresh.**
- `useStudy` re-reads the study every 4 s while a run, queue or job moves (`vcrActivity.ts:19,47`), 5 s after it ends, and 6 s on the chat view or a draft study.
- It also re-reads on `visibilitychange`, and on `evimed:vcr-study-refresh`.
- Tabs reload when `studyVersion` changes (`useVcrLoad`, `vcrTabKit.tsx`). The version covers step status, job state, `updatedAt`, last run end and run id.
- The inbox is polled every 20 s, producing a toast with "查看结果" (`useVcrFinishedToasts.ts:98`).
- UNCERTAIN: a conversation turn that changes data without touching those fields is not polled on a non-chat tab, because `pollInterval` returns null.

**Result back to conversation.**
- `openChat(draft, reference)` (VSP:249) navigates to `/chat` with `state.runtimeUiIntent {kind:"open", sessionId, draft, vcrReference}`.
- `RuntimeUiFrame.tsx:1030` stages the reference. The draft is never sent.
- Reference kinds are `population`, `patient_set`, `comparator`, `trial_scenario`, `model` and `step`; `compareTo` carries a second version.
- With no session yet, the request is held (`pendingChat`) and the Note "请求已保留。…" shows.

**Duplicates of the composer.** No second chat box, but several look-alikes:
- The home form "新研究" with submit "开始".
- The native frame chip 起点 and 预期用途. Changes are written to the study with PATCH (`useFrameVcrOptions.ts:75-100`), and the study page shows no 起点.
- Search inputs "检索参考试验" and "搜索登记试验".
- Typed forms in drawers (选定方案, 添加监管沟通记录, 改判, 计算预算 "增加计算时间（分钟）", and 数据接入 with its field-map and grant inputs).

## 4. Automation

**Runs by itself.**
- Programme steps run in a bounded runtime that locks the conversation (StudyPane:272). The pane says "结束后可以在这里继续".
- Step queue with `waitingFor`, engine jobs with counts, and automatic resume after an engine outage ("等计算引擎恢复").
- Stale recompute: "输入已变更，排队重算中".
- Allowance wait: "…在等额度，充值后会自动开始。" (`packages/domain/src/researchBilling.mjs:128`).
- Finish notices and toasts, and the "AI 运行" drawer for programme runs.

**Needs a person.**
- Sending any draft.
- The lead's budget confirmation.
- The reviews, confirmations and sign-offs listed in the "confirm" inventory above.
- The domain defines two human stops (`compute_over_budget`, `clinical_safety`). The web has a control only for the first.

**What the page says.**
- "轮到它时会自动开始。"
- "“X”做完后自动开始。"
- Strip: "正在{label}", "{label} · 排队中".
- No sentence says which steps need a human and which do not, other than the budget Note.

**科研工具 and 插件与技能.**
- No page automation.
- Plugin and skill activation applies when the running runtime allows.
- The page polls with waits of 3, 6, 12, 24, 48, 60 and 60 s (213 s), then stops (`catalogueModel.ts:44`).

## 5. Differences from GEO and across modules

**GEO (`routes/GeoProjectPage.tsx`).**
- `StepRail` on every tab (:543).
- Header primary "在对话中开始" / "对话" (:550).
- Secondary "周报" starts a job directly.
- Toolbar `contextAction` continues the current step.
- Stale handling: Notes "读取最新结果" and "更新暂时失败，仍显示上次结果。"

**VCR.**
- No step rail, no header "next", six destinations in one `查看` select. Statuses are scattered across the four step displays (inventory above), the strip and the facts list.
- "Start" means opening chat with an unsent draft.
- Each tab's empty state carries its own start.
- Some tabs start jobs directly.

| Job | VCR | 科研工具 | 插件与技能 |
|---|---|---|---|
| Start task | Header none. Home "开始" goes to the global assistant. Tab buttons go to the study chat with a draft, or run directly. | Whole row binds the capability and opens a blank `/app/chat` (no draft). | "开始使用" on the row, or row press (`ExtensionsPage.tsx:199-202`). Same binding as 科研工具, duplicated, and shown as 已添加. |
| Status | Four step displays, plus strip and facts list. | Availability Tag and estimates before start only; nothing after. | Per-row activation text (15 strings), polled for 213 s. |
| Next action | None. | None. | "添加" opens the detail drawer; the switch is in the list for skills only. |
| Inputs awaiting | Allowance and budget only. | None. | Notes "继续核查普通导入" and pending transfers; state "需要连接账户". |
| Confirm | About 15 kinds. | None. | `ConfirmDialog` "移除插件"; button "移出当前项目". |
| Conversation | Swap via `查看`; second entry is the header button. | Leaves the page. | Leaves the page. |
| Result back to conversation | Drafts with object references. | One-way. | One-way. |

## 6. Defects (ranked)

1. **CONFIRMED. Same-looking start buttons, three outcomes.**
   - The empty-state button names the action ("生成虚拟患者") but only navigates to the chat view with an unsent draft ("请根据已有资料完成患者，先说明还缺哪些输入，再调用适用工具。", VST:208,214; the "完成患者" wording is garbled).
   - `StepState.tsx:18-21` and DESIGN rule 10 say the button starts the work and does not take the person away.
   - Beside it, "为该患者找试验" (`PatientTrials.tsx:135,153,172`), "开始评估" (`ClinicalMatchingDetails.tsx:283`) and "比较所选预测" (`VcrForecastComparison.tsx:52,65`) run immediately.
   - Scenario: on 匹配 "开始评估" queues jobs, while on 患者 "生成虚拟患者" ejects you to chat and runs nothing until you send.
2. **CONFIRMED. Home "新研究" and "开始" create and start nothing.**
   - VHP:186,332,339 and `useGeneralResearchDraft.ts:64-70` do `select("default")` and navigate to `/app/chat` with an unsent draft ending in "：".
   - Result: the person leaves the module for the general assistant.
   - EmptyState VHP:252 ("研究会列在这里") promises a study that exists only after sending, elsewhere.
   - The VCR variant text says tasks fill a draft. DESIGN T3 forbids "a button that carries the person to the conversation". The two rules conflict.
3. **CONFIRMED. "需要你" for readers who cannot act.**
   - The server emits attention lines regardless of ability: `budget_confirm` has no tab or action (`apps/server/src/vcrViews.mjs:358`) and `step_failed` (:362).
   - The list counts any `tone === "attention"` (VHV:147-149).
   - The preview shows every line with "去处理" (VHV:258-270).
   - `OverviewTab.tsx:150,166-168` drops `budget_confirm` and any line without an action.
   - The budget Note exists only with `manage_study` (VSP:280).
   - Scenario: a member without `manage_study` sees "需要你 · 1 项计算在等你确认计算预算", clicks "去处理", and lands on a 总览 with nothing to do.
4. **CONFIRMED. One state, several words.**
   - An unstarted but requested step reads "还没开始" (VHV:171), "未开始" (OverviewTab:113, VHV:189), and "排队中" with "轮到它时会自动开始。" (VST:189-194, `StepState.tsx:137-138`).
   - An allowance wait reads "等你" in the preview (VHV:180), "排队中" in 总览, a credits sentence in the tab, and an attention Note.
   - Failure reads "未完成" / "这一步未完成" / "「患者」这一步没有做完，已算出的部分保留".
5. **CONFIRMED. "停止" and "取消" are study-wide and labelled per step.**
   - VST:148,178 and SF:92-99 call `cancelVcrStudy`. Its own comment (`lib/vcrClient.ts:2509-2511`) says it stops the run and every open job, and holds the programme.
   - Labels are "停止" (`StepState.tsx:160`) and "取消" (:141, `ActivityStrip.tsx:92`).
   - Scenario: "停止" on the 患者 tab also stops 对照, and no text says so.
6. **CONFIRMED. `awaiting_budget` is shown as a failure.**
   - `VcrForecastComparison.tsx:38-41` treats `awaiting_budget` like failed or canceled. It shows an error alert "本次比较未完成，可在研究对话中查看原因或重试。"
   - The job is waiting for the lead (header "确认预算"). Retrying queues a second job.
7. **CONFIRMED. Paused study never shows as paused.**
   - VSP:195-215 offers "暂停/继续" in the menu and toasts "已暂停。"
   - No page text shows the state, and `studyStateOf` (VHV:147) ignores `status`.
   - A paused study with running steps still reads "进行中".
8. **CONFIRMED. Inputs awaiting and things to confirm are not visible at page level.**
   - `awaitingInput` is never read, and `jobStateLabel`/`jobWaitLabel` are never rendered.
   - `attentionOf` (`vcrViews.mjs:334-385`) has no entry for an unconfirmed field map or an unfrozen snapshot.
   - Those live only in the 数据接入 drawer (`FieldMapEditor.tsx:216-218` "确认字段映射"; `intakeState.ts:325` "请先确认字段映射，再冻结快照。").
   - That drawer holds long configuration, which DESIGN rule 2 sends to the main area.
   - Four labels open it: "数据接入", "数据来源" (`PopulationTab.tsx:114`), "接入数据" (`ComparatorTab.tsx:301`), "检查患者资料" (`MatchingTab.tsx:143`).
9. **CONFIRMED. "比较版本" means three things.**
   - Toolbar (`PopulationTab.tsx:126`, `PatientsTab.tsx:198`, `TrialTab.tsx:132`, `ComparatorTab.tsx:223`) opens Drawer "在对话中比较版本" ending in "将比较请求放入研究对话" (draft).
   - `VcrKnowledge.tsx:480` runs the engine compare immediately, inside the Population tab.
   - "比较所选预测" queues a job.
10. **CONFIRMED. Same row affordance, different outcome, in 插件与技能.**
    - A tool row press starts a new conversation (`ExtensionsPage.tsx:199-202`). A skill or plugin row press opens a drawer.
    - Tools appear as 已添加 (`added: true`) with no switch.
    - If binding fails, both pages silently open an unbound chat (`CapabilitiesPage.tsx:231`, `ExtensionsPage.tsx:177`): the person believes the tool is chosen.
11. **CONFIRMED. Plugin enabling is three steps with no list switch at first.**
    - "添加" installs and opens the drawer (`ExtensionsPage.tsx:166`).
    - An installed but unselected plugin has no action in 已添加 (:223-224); state "未在当前项目启用".
    - The only enable is "用于当前项目" in the drawer (`ExtensionDrawer.tsx:131`). Skills have a switch directly (:195,208).
12. **CONFIRMED. Activation polling stops silently.**
    - 213 s of waits (`catalogueModel.ts:44`; `ExtensionsPage.tsx:289-296`).
    - "等待当前任务结束后生效" then stays on screen with no refresh and no notice.
13. **CONFIRMED. Calculation frame leaks.**
    - `SF:132` offers 总览 for a calculation. `VSP:133,270-273` then redirect to the history list (different page shape).
    - The same view has two addresses: `/app/virtual-research/:id/data` (header links, `VcrCalculationWorkbenchPage.tsx:26`) and `/app/capabilities/calculations/:id/data` (`openView`).
    - Empty-state links "开始研究对话" (:28) and "开始研究任务" (`VcrMethodWorkbenchPage.tsx:23`) go to the VCR home list, not a conversation.
14. **CONFIRMED. Silent staleness and error swap.**
    - A failed `useStudy` poll keeps the old study with no notice (`useStudy.ts:176-181`).
    - A failed tab re-read replaces the results with an error card, unconditionally (`vcrTabKit.tsx`, `useVcrLoad`).
    - Compare GEO's "更新暂时失败，仍显示上次结果。"
15. **UNCERTAIN. Step rail in substance.**
    - 总览 "研究记录" (`OverviewTab.tsx:95-121`), preview "进度 n / m" (VHV:274), and "已完成 n / m 步" (VHV:171) are the seven-step vocabulary the reset says to remove.
    - Only the `查看` select navigates six destinations (SF:131), which DESIGN says cannot be the only discoverable workflow.
    - Walk status and stale comments (`VSP:75-78` "seven tabs … step bar") are unreconciled.

Notes not ranked:
- `scrollIntoView` at `PopulationTab.tsx:164`, `PatientsTab.tsx:261`, `DataTab.tsx:50`, `VcrKnowledge.tsx:282`, `VcrReferenceSearch.tsx:29`. DESIGN rule 9 forbids it, but that rule is stated for step-rail modules.
- The home filter chip disappears when its count falls to 0 while the filter stays applied (VHP:190-199,255-256), against the DESIGN v3.1 line "a selected filter is never erased because a refreshed count fell to zero".
- Task names differ across surfaces:
  - Home: 患者匹配/人群与患者/合成对照/虚拟试验.
  - Frame chip 起点: 自动/队列/患者/对照/试验.
  - Domain actions: 创建虚拟队列/创建虚拟患者/构建合成对照/模拟临床试验.
  - Destinations: 总览/匹配/人群与患者/对照/试验/依据.