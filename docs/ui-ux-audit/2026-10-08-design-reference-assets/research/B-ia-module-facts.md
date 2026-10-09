# B · 信息架构 / 模块 / 页面行为 / AI 任务状态 —— 对 R11.2 的事实核对

被审文档：`docs/ui-ux-audit/2026-10-08-evimed-design-reference.md`（v1.0，行号取 Read 工具编号）。
核对基线：release 11.2，worktree `/home/coder/evimed-wt/release`（`r11/ui-audit`，3e52ca1f2）。下文 `src/` 一律指 `OpenScience/apps/web/src/`，除非写了完整前缀。
R11 的取舍依据：`docs/ui-ux-audit/2026-10-07-review/R11-两份审查整改方案.md` 及其 `R11/triage-*.md`。
只读核对：没有改动任何代码树；没有浏览器/网络/ssh。内核（DSH）浏览器客户端包不在仓库内（只有 renderer/slots/sidebar-browser 三个），凡涉及内核自绘行为而仓库注释/测试没有记录的，一律标「无法核实」。

## 判定与严重度约定

- 判定：正确 / 错误 / 部分正确 / 过时:R11已变 / R11已否决 / 无法核实。「R11 已实现」「仍未实现」写在证据列开头，用来分类。
- S1 = 把「现行」写错（名称、路由、状态映射、数字）、用了退役词、或与 R11 的明确决定相冲突。
- S2 = 目标规范与 R11 现状有实质差距，或把已上线的能力写成纯目标；不改会误导排期。
- S3 = 措辞/细节偏差。

## 0. 摘要（先读这个）

1. **文档是对着过期树（HEAD c1f02c3cc，430 个 web 文件落后于 R11）写的。** 最典型的三处：侧栏「虚拟临研」（R11 为「虚拟临床研究」，退役词，`retiredWords.test.ts:58-60` 与 ui-walk 都会失败）、插件与技能指向 `/app/extensions/plugins`（R11 侧栏指向 `/app/extensions/skills`）、`FrontierNavigation.tsx` 在 R11 已不存在（被 `FrontierControls.tsx` 取代，文档 L960 的链接是死链）。
2. **§7.1 称「沿用统一 runState 与 RunStatusDot」不成立（旧树同样不成立）。** R11 里 `RunStatusDot` 只被组件陈列页 `GalleryPage.tsx` 使用（生产构建不含），`runState()` 的唯一生产用途是侧栏的「进行中」转圈（`components/sidebar/useProjectRuns.ts:14-16`）。运行记录页 2026-09-20 已删（`router.tsx:103-105`）。
3. **§8.4「局部修改与版本」在 R11 已大半上线**（选中内容→在对话中修改→不可变新版本→修改记录→版本比较→来源更新），文档把它写成纯目标；而 §8.5 的「分享」在 R11 没有对应的报告分享功能。
4. **多处与 R11 的明确否决冲突**：能力地图（§15.1，R11 已从研究者页面移除）、模拟会员/模拟退款（§16.4，R11 已删页）、热榜「排序含义」说明（§12.4，所有者 09-23/10-07 删除「热度怎么算」）、与我相关的推荐解释（§12.7）、登录页「恢复方式」（§16.3，平台无找回通道，R11 否决）、全局命令面板（§3.5，2026-09-22 已删）。
5. **对话界面是 DSH 内核自己的网页应用（跨域 iframe）**，外壳只能通过 slot、语言包（`zh-x-evimed`）、主题令牌层、CSS 隐藏规则和 postMessage 桥影响它。§5.2 流式跟随、§6.2 输入区、§7.2–7.4 对话内状态、上传状态、过程视图基本不归外壳渲染。详见第 3 部分。
6. **「历史消息在运行环境不可用时仍可看」目前做不到**：对话文本只在内核会话库里，账本不存回复正文（`RuntimeUiFrame.tsx:1058-1060` 的注释明说）；R11 只能给「查看已有成果」。
7. 数量（表中共 94 行）：S1 10 条，S2 33 条，S3 28 条，另 23 行核对无异议。S1 清单：B03 链接落旧树、B05 虚拟临研、B06 插件路由、B27 RunStatusDot、B51 前沿动态结构、B55 热榜排序含义、B62 推荐解释、B76 能力地图、B88 模拟会员/退款、B89 侧栏宽度。

## 1. 逐条核对表

列：`id | 文档节/行号 | 原文(短引) | 判定 | 证据（R11 file:line；旧树差异）| 建议改写 | 严重度`。判定为「正确」且无需改写的行，建议列写「—」。

### 1.1 §2.3 工作对象（L61-74）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B01 | §2.3 L65-72 | 任务「查看、取消、按支持范围继续」；事件「跟踪、阅读原文、深入研究」；记忆「编辑、停用、恢复」 | 部分正确 | 任务没有独立页面：取消=侧栏对话行 ⋯「停止」（`components/sidebar/ConversationMenu.tsx:151`，确认框「停止这条对话？已完成的文件会保留。」:163）或内核输入框的停止；R11 没有断点恢复，所以没有「继续」。事件页顶栏只有「深入研究」（`app/routes/FrontierEventPage.tsx:167`），「关注此事件」在卡片 ⋯ 菜单（`components/frontier/FrontierCard.tsx:128`），星标只作用于条目不作用于事件。记忆的动作是「编辑」「忘记」（带「撤销」）和「已忘记的内容」里恢复（`components/memory/FactDrawer.tsx:306-307`）。 | 任务行：「查看对话与成果、停止、追问」；事件行：「关注、阅读原文、深入研究」；记忆行：「编辑、忘记（可撤销，可在已忘记的内容里恢复）、用于后续工作」 | S3 |
| B02 | §2.3 L63-72 | 八个稳定对象 | 部分正确（漏项） | R11 用户可见而表里没有：证据卡/证据专区、结果版本、定时任务及其每次执行的对话、记忆里的「做法」、研究包。见第 2 部分。 | 增补「证据卡」「结果版本」两行；任务行注明「定时任务的每次执行各有自己的对话」 | S3 |

### 1.2 §3.1–3.5 入口、导航、项目、搜索

R11 侧栏实际顺序（`components/sidebar/Sidebar.tsx:61-98`）：新对话；〔前沿动态〕；科研工具；〔虚拟临床研究〕；〔循证 GEO〕；知识库；记忆胶囊；定时任务；插件与技能。方括号的行只在 `/api/me` 的 `features.frontier/vcr/geo` 为真时出现（`apps/server/src/server.mjs:5839-5847`；模块开关 `OPEN_SCIENCE_FRONTIER_ENABLED`/`GEO_ENABLED`/`VCR_ENABLED` 默认关 `config.mjs:325,699,840`；受众 `FRONTIER_AUDIENCE` 默认 all，`GEO_AUDIENCE`/`VCR_AUDIENCE` 默认 operators `config.mjs:283,670,804`）。收件箱是页头铃铛，设置是底部齿轮，都不在这个列表里。

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B03 | §3.2 L108；L960 | 「主入口、顺序和模块可见性以 Sidebar.tsx 为准；路由以 router.tsx 为准」，链接指向 `../../OpenScience/apps/web/src/...` | 过时:R11已变 | 链接落到 HEAD c1f02c3cc 的旧树：旧 `Sidebar.tsx:84` 仍写「虚拟临研」，`:67` 指向 `/app/extensions/plugins`，没有 `isCurrent()`（R11 :106-113）、没有 `inert`/`<aside>` 地标（R11 :168-171）；旧 `router.tsx` 缺 `frontier/authors`、`memory/shared`、`memory/delivered`、`extensions/:tab/:itemId?`（旧树是四条独立的 plugins/skills 路由）；旧 `packages/domain/src/researchBilling.mjs:21-26` 的 `SIMULATED_WALLET_PAGES` 仍含四页。 | 在 §1.2 与 §22.3 写明「以 release 11.2（3e52ca1f2）的文件为准」，链接改指该提交 | S1 |
| B04 | §3.2 L113 | 「前沿动态 … 开通时紧接新对话；内部容纳证据专区」 | 部分正确 | 位置正确（Sidebar.tsx:95）。证据专区不是前沿动态内部的视图：它是页头的文字链接「证据专区 ›」（`app/routes/FrontierPage.tsx:692`），通向另一组页面 `/app/frontier/zones`、`/zones/:zoneId`、`/zones/:zoneId/evidence/:cardId`、`/app/frontier/authors/:authorId`（`app/router.tsx:93-96`）。 | 「…；证据专区从前沿动态页头进入，是同一模块下的另一组页面」 | S3 |
| B05 | §3.2 L115、L116、L199、L650、L848、L870 | 「虚拟临研」（导航表、布局表、§15.2 标题、覆盖矩阵、A13） | 错误（退役词） | 侧栏标签「虚拟临床研究」（Sidebar.tsx:84）；所有者 2026-10-07 改名（`packages/domain/src/retiredNames.mjs:28-31`）；`app/retiredWords.test.ts:58-60` 与 ui-walk 的 `RETIRED_NAMES` 在任何页面出现旧名即失败。路由 `/app/virtual-research` 不变。旧名只在搜索框里被读作新名，到 2027-01-07 止。 | 全文「虚拟临研」→「虚拟临床研究」（六处） | S1 |
| B06 | §3.2 L120、L124 | 「插件与技能 `/app/extensions/plugins`」 | 错误（路由） | 侧栏指向 `/app/extensions/skills`（Sidebar.tsx:67）；`router.tsx:127` 把 `extensions` 重定向到 `/skills`；默认页签「技能」排在「插件」前（`app/extensions/ExtensionsPage.tsx:145`）。`/app/extensions/plugins` 仍有效，入口是设置左栏「插件」（`app/routes/AccountPage.tsx:99`）和页内页签。 | 地址列改 `/app/extensions/skills`（默认技能页签）；L124 加「默认进入技能」 | S1 |
| B07 | §3.2 L121 | 收件箱 `/app/inbox` 作为全局导航的一行 | 部分正确 | 路由正确；但侧栏没有这一行：入口是侧栏页头的铃铛（Sidebar.tsx:191，`components/sidebar/InboxBell.tsx`）。有未读时是小红点；含未读临床安全时图标换成盾（InboxBell.tsx:92-96）。 | 「当前入口」列写「侧栏页头铃铛」，层级要求保留 | S2 |
| B08 | §3.2 L122 | 「设置 `/app/account` — 账户、外观、额度、数据源、项目等」 | 部分正确 | 入口是侧栏底部账户行右侧的齿轮（Sidebar.tsx:219-237）。分区：账户·外观·通知·用量（开科研计费时叫「科研额度」）·数据源·项目，运维仅 operator（`AccountPage.tsx:28-37`）；「通知」在文中漏列；设置左栏另有「插件」「技能」两个链接（:99-100）。 | 「账户、外观、通知、用量/科研额度、数据源、项目，运维按权限」 | S3 |
| B09 | §3.2 L124 | 「专业模块未向当前账户提供时…旧深链仍应给出具体说明和有效返回入口」 | 部分正确 | 导航行隐藏 ✓（Sidebar.tsx:92-98）。旧深链落到「一句话、没有任何可点击内容」的页面：「前沿动态还没有在这个工作空间开放。」（`components/frontier/FrontierStates.tsx:7,13-22`）、虚拟临床研究（`components/vcr/VcrStates.tsx` 的 `VcrOffPage`）、循证 GEO（`components/geo/GeoStates.tsx:6` 的 `GEO_OFF_SENTENCE`）。有效返回入口就是全局侧栏。 | 「旧深链给出一句具体说明；返回靠全局侧栏」；要页内返回按钮须作为新决定 | S3 |
| B10 | §3.3 L128 | 「项目是账户级选择，普通路由不携带项目 ID」 | 正确 | `app/router.tsx:52-54` | — | — |
| B11 | §3.3 L132-133 | 同名项目加区分信息；「旧请求的迟到响应不得覆盖新项目」 | 正确（R11 已实现） | `lib/projectNames.ts:75-98`（同名加创建日期/时间/序号）；切项目时页面以项目为 key 重挂载（`app/layout/AppShell.tsx:226`）；对话 iframe 按项目保留至多 2 个，先释放再启动（`app/layout/SessionFrameHost.tsx:20,119-135`）；用例 `AppShell.projectSwitch.test.tsx:81-109` | — | — |
| B12 | §3.3 L135 | 「浏览器前进、后退恢复筛选、滚动位置、当前对象和阅读位置」 | 部分正确（仅前沿动态已实现） | 前沿动态：视图/筛选在 URL，页数与滚动写进 history state（`FrontierPage.tsx:117,205-232,572-598`、`components/frontier/frontierReadingState.ts`，用例 `FrontierPage.test.tsx:1018`）。其余：知识库范围/类型/搜索、收件箱筛选、记忆搜索只在 React state，离开再回来即重置（`SourcesPage.tsx` 的 `useState`）；报告阅读页没有滚动记忆（`lib/scrollMemory.ts` 只用于文件预览）。 | 标注「R11 仅前沿动态已实现，其余页面为目标」 | S2 |
| B13 | §3.3 L134 | 「跨项目成果链接先解析所属范围…无权限、对象已删除、连接失败分别处理」 | 部分正确 | 解析 ✓：`RunFilePage.tsx:81-95` 在别的项目里找该 run 并把外壳切过去；`/app/runs?run=` 同理（`router.tsx:189-202`）。「无权限」与「已删除」不可区分：研究/回答等一律 404，注释写明「someone else's, or deleted」（`lib/vcrClient.ts:1828-1831`），文案「这个研究不存在或已删除。」。 | 「不属于当前账户的对象与已删除对象给同一种说明（不泄露存在性）；连接失败单独给『重试』」 | S2 |
| B14 | §3.3 L136 | 「嵌入宿主平台时由宿主承担全局导航」 | 正确 | `?embed=1` 或 wujie：只渲染内容区，不画侧栏与快捷键表（`AppShell.tsx:41,162-189,233`；`app/layout/embed.ts`） | — | — |
| B15 | §3.5 L146 | 「搜索框应注明范围，例如“搜索本项目资料”“搜索动态”」 | 部分正确 | 知识库「搜索资料和内容」、记忆「搜索记忆」、定时任务「搜索任务」、科研工具「搜索工具」；前沿动态只叫「搜索」（`FrontierPage.tsx` 的 `label="搜索"`），插件与技能也只叫「搜索」。知识库的范围由页头范围菜单决定。 | 前沿动态改「搜索动态」，插件与技能改「搜索插件与技能」 | S3 |
| B16 | §3.5 L148 | 「全局命令面板属于探索项」 | R11已否决 | 2026-09-22 已删：`Sidebar.tsx:52-54`（「neither ChatGPT, Claude nor Gemini opens one for navigation」）；`components/command-palette/` 目录为空，只剩测试里的 mock。 | 从探索项移除，或写「2026-09-22 已否决，除非所有者重开」 | S2 |
| B17 | §3.5 L148 | 「`/` 等单字符快捷键在输入框和中文输入法组合期间不触发，并允许关闭或改为组合键」 | 部分正确 | R11 只有 `?`（快捷键表）：在 INPUT/TEXTAREA/contentEditable 中不触发（`components/ui/ShortcutHelp.tsx:23-30`），不检查输入法组合态，不可关闭；另有 ⌘/Ctrl+B（`AppShell.tsx:69-79`）。内核 iframe 里按这两个键经 `shell-shortcut` 转发（`RuntimeUiFrame.tsx:764-775`）。没有 `/`。 | 「现行只有 ? 与 ⌘/Ctrl+B；新增单字符快捷键须避开输入框与输入法组合期并可关闭」 | S3 |

### 1.3 §6 输入、澄清与跨页面交接（L233-271）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B18 | §6.1 L239-245 | 输入承接表；现行约束「普通问答与文件交付型研究是两条产品路径」 | 正确 | 简单问题走 `open-domain-answer` 线；报告意图由 LLM 分类器（默认开）或用户选「工具」标签决定；已有数据→`dataset-research-scoping`；文献/事件→「深入研究」草稿带原文链接与标识（`components/frontier/frontierText.ts:342-364`）；报告修改→带 `resultRevision` 引用的草稿（`components/inspector/ResultVersionInspector.tsx:164-181`）。用户看到的是产品名工具标签，不是内部智能体名。 | — | — |
| B19 | §6.2 L249-251 | 「输入区应明确当前项目、已选材料与提交动作；材料显示为可移除的对象条目…上传中、上传失败、已上传但尚未读完分别呈现」 | 部分正确，且主要不归外壳 | 输入区是内核组件。外壳只加了：工具标签 `conversation.composer.dock`（id `evimed-tool`，`runtimeUiCommands.mjs:490`）、空白会话的工具标签与示例按钮 `conversation.hero.agentPreset`（:544）、上传按钮 `conversation.input.left`（id `evimed-upload`）、附件栏接管（`conversation.input.attachments`，`runtimeUiComposer.mjs:69-72`）、`@` 引用知识库资料。当前项目不在输入区显示（在侧栏分组里）。上传：「Fetch 没有进度，输入框显示『发送中』直到完成」（`runtimeUiTransport.mjs:306-308`），失败/重试/移除是内核附件栏自带，没有「已上传但尚未读完」这一态（附件进项目附件库，由模型用工具读），单文件上限 50 MiB（`config.mjs:1834`）。 | 按第 3 部分改写成对内核现实的描述 | S2 |
| B20 | §6.2 L251 | 「常用参数通过小范围控件提供，例如人群、时间范围、结果形式…已从材料获得的信息先展示为可修正值」 | 部分正确（仅 GEO 与虚拟临床研究有） | 参数控件只有两处：循证 GEO 的「覆盖周期」「AI 引擎」（`geo-options`）与虚拟临床研究的「起点」「预期用途」（`vcr-options`）（`RuntimeUiFrame.tsx:844-853`；`runtimeUiCommands.mjs` 头注释：「没有表单；用户没说的由平台设定并标『AI 设定』」）。临床证据综合等没有人群/结果形式控件，也没有「从材料得到的可修正值」。 | 标注「R11 仅 GEO 与虚拟临床研究有参数控件，其余为目标」 | S2 |
| B21 | §6.2 L253 | 「“开始研究”…“生成草稿”…“保存”」按钮语义 | 仍未实现 | apps/web、harness-port、domain 全库没有这两个字符串；发送键是内核的，唯一被改的相关文案是 `input.send.queue`「排队发送 · Ctrl/⌘+Enter 插话」（`runtimeUiLocale.mjs:84`）。 | 标为目标；注明「发送键由内核渲染，名称只能经 zh-x-evimed 语言包改，且键名须先在内核词典里确认」 | S2 |
| B22 | §6.3 L257-259 | 「聚合相关问题，提供可选答案与自由输入」 | 无法核实 / 取决于开关 | 结构化提问是内核的 `ask_user_question` 视图（在 `runtimeUiSlots.mjs` 的 SHIPPED_TOOL_VIEW_KEYS 里），但运行时的 ask-user 插件由 `OPEN_SCIENCE_RUNTIME_ASK_USER` 控制，**默认关**（`config.mjs:2084`、`dshProfilePatch.mjs:680`；生产值未核实）。关时模型只能在正文里提问。虚拟临床研究的做法是不问、设默认并标「AI 设定」。 | 「结构化提问取决于部署开关；默认以正文提问加『AI 设定』默认值」 | S2 |
| B23 | §6.4 L263 | 交接「至少携带：原对象、来源链接或材料引用、当前项目、选定范围和用户要做的动作」 | 部分正确 | 载体只有一个文本草稿：`RuntimeUiIntent = {kind, projectId, requestId, sessionId, draft?, resultRevision?}`（`lib/runtimeUiNavigation.ts:4-11`，注释「a draft never submits」）。前沿条目草稿含标题/来源/原文链接/DOI/PMID/注册号/导读；事件页含一手来源列表（`frontierText.ts:366-378`）；知识库只含标题与文件名（`SourcesPage.tsx` 的 `openInConversation`）；GEO「问 AI」含数值、样本、测量日（`components/geo/AskAi.tsx` 的 `geoNumberDraft`）；证据卡「问这条证据」走 `prepareEvidenceResearch`。没有结构化对象 id 进入对话，也没有「选定范围」。 | 「至少携带：对象名称、来源链接/标识、用户要做的动作（以草稿文本形式；项目随账户选择）」；结构化对象引用写成需要新契约的目标 | S2 |
| B24 | §6.4 L265 | 「“深入研究”沿用…草稿交接…点击一次、返回再进入、刷新深链均不得造成重复提交」 | 正确（R11 已实现） | `FrontierCard.tsx:132`、事件页 `research`（`FrontierEventPage.tsx:167`）；草稿只进输入框；会话 id 由外壳先生成，内核 `createBoundSession(requestedId)` 幂等（`runtimeUiBridge.mjs:82-96`）；确认后外壳删掉 state 里的意图（`RuntimeUiFrame.tsx:864-870`）。 | — | — |
| B25 | §6.5 L271 | 「托管环境不允许的动作应清楚说明…不能生成一个实际上无法批准的弹窗」 | 正确（R11 比文档更强） | 托管 profile 审批策略 `never`，只有一个预设「项目工作区」，越界尝试直接被拒，不出审批弹窗（`dshProfilePatch.mjs:521-545,580-593`）；预设芯片被 CSS 隐藏（`runtimeUiShell.mjs:112`）。 | — | — |
| B26 | §6.5 L269；§14.2 L628 | 「授权范围、预算与停止条件在持续任务设置处集中管理」 | 部分正确 | 表单：名称·任务指令·重复·时间·高级（时区·任务类型·单次/每日/每周上限）（`components/autopilot/TaskForm.tsx:73-99`）。「停止条件」由规划器决定并写在任务上（「已暂停：…」/「需要你补充：…」，`taskPresentation.ts:111-130`），不在表单里；通知方式在设置→通知。 | 去掉「停止条件」，或写「由规划器决定并写在任务上」 | S3 |

### 1.4 §7 AI 长任务与状态（L273-319）

R11 对话内的运行状态绝大部分由内核自绘；外壳自己的生产状态表达只有：侧栏对话行的「进行中」转圈和「未打开」小点（`components/sidebar/ProjectBrowser.tsx:883-897`）、对话打开前的封面/告警（`RuntimeUiFrame.tsx`）、定时任务/虚拟临床研究/循证 GEO 各自的状态词表。

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B27 | §7.1 L283 | 「现有运行标识沿用统一 runState 与 RunStatusDot 的状态映射」 | 错误（旧树与 R11 都如此；旧树里也只有陈列页 import 它） | `RunStatusDot` 只被组件陈列页使用（`app/routes/GalleryPage.tsx:32,220-239`；`/__gallery` 在生产构建里排除，`router.tsx:146-155`）；`runState()` 唯一生产调用是 `isRunning`（`components/sidebar/useProjectRuns.ts:14-16`）；`webRunOutcome`、`runMetaLine` 无调用方；运行记录页 2026-09-20 已删（`router.tsx:103-105`）。 | 「侧栏只显示『进行中』转圈与『未打开』小点；定时任务、虚拟临床研究、循证 GEO 各有自己的状态词表。若要统一，需先恢复一个生产使用方」 | S1 |
| B28 | §7.1 L279 | 执行状态示例「进行中、已结束、未完成、已取消」 | 部分正确（词不同） | 现有词表：进行中/已完成/待核对/未完成/已停止（`lib/runPresentation.ts:33-45`）；停止后的提示「已停止。」（`ConversationMenu.tsx:88`）；定时任务：排队中/结果核验中/研究进行中/未完成/已取消/研究结果（`taskPresentation.ts:61`）。 | 示例改「进行中、已完成、未完成、已停止」 | S2 |
| B29 | §7.1 L283 | 「已完成的绿色圆点…品牌色的核对标记…两者不能混用」 | 部分正确 | 令牌 ✓：`dot-done`=ok-600（绿）、`verify-ok`=brand-600、`verify-pending`=warn-600（`packages/design-tokens/src/index.mjs:280-298`），「依据 ✓/⚠」用后者（`ClaimCitation.tsx:217`）。但 R11 的 `runState` 把核对折进了运行状态：`review`「待核对」菱形=已交付但仍有未决核对（`runPresentation.ts:47-58`），且绿点不在生产页渲染（见 B27）。 | 保留颜色规则，删去「沿用统一映射」 | S2 |
| B30 | §7.2 L292 | 「已接收或等待运行：真实等待状态、任务归属；可提供动作 查看、取消（若支持）」 | 部分正确 | 对话打开前的等待由外壳封面说：「正在清理上一次任务的运行环境，完成后自动继续」（`RuntimeUiFrame.tsx:129`）、「所有研究环境都在使用中，空出后会自动开始。」（:148）、「正在准备运行环境」（:169）；清理最多等 120 s（:131），间隔 3/5/8/15 s（:130）。定时任务：排队中/等待运行资源/等待余额（`taskPresentation.ts:61-78`）。对话内的排队/插话是内核的。 | — | S3 |
| B31 | §7.2 L293 | 「正在工作：最近可观察的有效变化、已有结果；可提供动作 查看部分结果、取消、离开页面」 | 部分正确 | 无伪百分比 ✓。「最近可观察的有效变化」：服务端有停滞提示 `run_stall_observed`（「约 N 分钟没有可观测的进展…运行仍在继续…可以停止它」，`apps/server/src/agentRuns.mjs:7025`），但前端没有渲染质量提示分级的组件：`summarizeQualityNotices`/`noticeCountsLine` 无调用方，只有 `InboxBody` 和 `ReportReader.tsx:99`（取安全结论 id）在读（`lib/qualityNotices.ts`）。内核自绘「EviMed 思考中…」（`runtimeUiLocale.mjs:89`）、折叠过程行「N 次工具调用 · M 个子任务」、子任务行（`runtimeUiToolviews.mjs`）。离开页面 ✓：对话 iframe 隐藏不卸载（`SessionFrameHost.tsx:229-231`），运行在服务端继续；取消 ✓：输入框停止或侧栏「停止」。 | 把「最近可观察的有效变化」标成需要新的前端绑定 | S2 |
| B32 | §7.2 L294 | 「需要关键输入：缺什么、影响什么、输入位置；可提供动作 补充后继续（若支持）」 | 部分正确 | 定时任务：规划器停在「需要你补充：…」，回复即继续（`taskPresentation.ts:111-130`，`resumableByReply`）。对话内：同 B22。 | — | S3 |
| B33 | §7.2 L295 | 「当前连接断开：连接状态与最后确认的任务状态；可提供动作 重连、查看已有内容」 | 部分正确 | 重连 ✓：封面「正在重连」+「重新连接」（`RuntimeUiFrame.tsx:1097-1101`）；前端断网不判失败 ✓：续租按 1/3/10/30 s 退避，`online`/`visibilitychange` 触发续租，租约没过期不弹窗（:259,539-597）；侧栏转圈来自账本每 20 s 轮询（`useProjectRuns.ts:6`）。「查看已有内容」✗：连接封面是不透明的整屏层（:1098），盖住对话。 | 如实写「重连期间对话内容被封面遮住；已有成果从侧栏或『查看已有成果』进入」，或列为目标 | S2 |
| B34 | §7.2 L296 | 「部分结果可用：可读结果与具体缺项；可提供动作 打开、导出、补做缺项（若支持）」 | 正确（部分已实现） | 逐句 ✓/⚠ 与「⚠ N 条待核对」（`lib/claimCitations.ts:178-183`）；虚拟临床研究「部分结果 / 结果已过期（数字保留灰显）」（`VcrStates.tsx` 头注释）；补做：数据源补齐后的「继续」（`components/runs/ConnectorNeedNotice.tsx:43-45,130`）。 | — | — |
| B35 | §7.2 L298 | 「工作未完成：已保留内容、具体原因、正确恢复入口；禁止表现 所有错误都引向“查看额度”」 | 部分正确 | 额度按钮只给额度类拒绝 ✓（R11 已修）：启动被拒按原因分流 `runtimeStartRecovery`→spend/wait/autopilot/slots/room/preparing（`RuntimeUiFrame.tsx:100-110,1083-1094`），草稿保留。对话内某次运行失败后，外壳没有「未完成」面板（运行记录页已删），原因与恢复入口由内核的失败行/重试行决定（语言包 `runtimeUiLocale.mjs:94-106`）。 | — | S2 |
| B36 | §7.2 L299 | 「已取消：停止状态及仍然保存的内容」 | 正确 | 停止确认框「停止这条对话？已完成的文件会保留。」（`ConversationMenu.tsx:163`）；删除「删除后不可恢复；产出文件仍在项目工作区。」（:173） | — | — |
| B37 | §7.3 L303 | 「AI 研究不使用伪百分比、虚构倒计时或循环播放的固定阶段」 | 正确 | 外壳封面只有一句「正在打开」（`RuntimeUiFrame.tsx:272-279`，注释记录了 2026-09-23 去掉清单式阶段）；上传只显示「发送中」（`runtimeUiTransport.mjs:306`）。 | — | — |
| B38 | §7.3 L305 | 「展开后显示简洁的行动历史、来源与时间；工程日志留在诊断入口」 | R11已否决（与所有者裁定有张力） | 内核的「运行」视图（时间总览+逐步账本+记录检查器）对所有账号开放：`OPERATOR_ONLY_BROWSER_PANELS=[]`（`dshProfilePatch.mjs:361`），页签名由语言包改成「运行」（`runtimeUiLocale.mjs:137-139`）；所有者 2026-09-22 裁定、2026-09-29 再确认「原生运行详情对研究者可见，运维才看会话统计」。诊断类只有：输入框统计行与回合页脚用量（仅 operator，`runtimeUiShell.mjs:118-125`）、侧栏「复制诊断信息」（仅 operator，`ConversationMenu.tsx:155`）。 | 「展开后可进入内核的『运行』视图查看逐步记录；用量/统计与诊断信息仅对运维显示」 | S2 |
| B39 | §7.4 L311 | 「会话运行环境不可用时，应尽可能继续显示已经保存的历史消息和成果」 | 部分正确（成果可，消息不可） | 成果 ✓：「查看已有成果」→该对话已交付的报告，否则项目文件（`RuntimeUiFrame.tsx:1061-1074`）。消息 ✗：注释写明「对话文本在内核会话库里，不从账本伪造，账本不存回复正文」（:1058-1060）。 | 「运行环境不可用时可读取已交付的成果；对话原文须待运行环境恢复」；显示历史消息列为需要新数据契约 | S2 |
| B40 | §7.4 L311 | 「没有服务端断点恢复能力时，按钮必须叫“重新发起”，不能叫“继续”」 | 部分正确（R11 无此按钮） | R11 没有断点恢复，也没有「重新发起」：外壳按钮是「重试」（重新打开对话框架，`RuntimeUiFrame.tsx:1057`）、「重新连接」「新建对话」「查看已有成果」；「继续」只出现在数据源补齐条（向同一对话追发一轮让模型补做被跳过的部分，`ConnectorNeedNotice.tsx:43-45`）和内核长度上限提示「发送“继续”接着写」（`runtimeUiLocale.mjs:94-95`）。 | 「『重试』=重新打开对话；『继续』=在同一对话追发一轮；R11 没有『重新发起整个任务』按钮」 | S2 |
| B41 | §7.4 L313 | 恢复优先级 | 部分正确 | R11 实际顺序：自动等待（清理最多 2 分钟，满座无限期）→「重试」→「查看已有成果」（`RuntimeUiFrame.tsx:454-482,1083-1094`）。 | — | S3 |
| B42 | §7.5 L317 | 现行约束「可读成果与质量发现一起呈现，不能因格式、模板或非阻断性检查而整体扣留」 | 正确 | 2026-09-17 裁定，只有 `CLINICAL_CHECK_TIERS` 里 blocking/safety 为 required，交付带 `verification:"unverified"`；报告里安全结论块在正文前且不折叠（`components/report/ReportReader.tsx:270-276`）。 | — | — |
| B43 | §7.5 L319 | 「界面应提供“已有什么”和“还缺什么”」 | 部分正确 | 「还缺什么」只限逐句核对（⚠ N 条待核对）与模块自己的「部分结果」；非逐句的 MUST FIX/advice 质量提示在 R11 没有任何生产界面渲染（见 B31）。 | — | S2 |
| B93 | §7.2 L297 | 「工作结束：结果入口、适用范围、真实发现的问题；可提供动作 阅读、核查、修改、导出；禁止表现 只有庆祝图标没有内容」 | 部分正确 | 回答末尾的文件卡：文档优先排序（报告→证据矩阵→文档→表格→图片→其它），最多先显示 4 个，其余「显示全部 N 个文件」，交付摘要排在最后（`packages/harness-port/src/runtimeUiPanels.mjs:66-95,357-372`）；来源卡（证据等级、研究类型徽标、「在报告中查看」）与复核行（仅有问题时）接在文件卡前后（`runtimeUiSources.mjs`、`runtimeUiReplyChecks.mjs`）。无庆祝图标 ✓。「适用范围」没有单独位置：报告阅读器的四项事实（检索截止、依据、模型、限制，「未注明」兜底）才有（`ReportReader.tsx` 的 `ReportFacts`）。 | 「适用范围」写成报告阅读器里的『四项事实』，对话里不显示 | S3 |

### 1.5 §8 成果、依据与版本（L321-366）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B44 | §8.1 L327-331 | 报告与引用三层：结论与引用标记 / 依据浮层 / 来源原文位置 | 正确（R11 已实现，仅在外壳的报告阅读器里） | ① 句末「依据 ✓/⚠」（`components/markdown-viewer/ClaimCitation.tsx:217`）；② 弹层含引文高亮、研究类型徽标、位置「表/行/列/页」、PICO/确定性/偏倚（:243-248；`lib/claimCitations.ts:152` `sourceLocationText`；`ClaimAppraisal.tsx`）；③「定位原文」→ `/app/runs/:runId/files/*?quote=&version=` 并高亮（ClaimCitation.tsx:52）。对话里的回答没有逐句座位（内核 markdown 组件不给钩子，`runtimeUiSources.mjs`/`runtimeUiReplyChecks.mjs` 头注释），只有回答下面的来源卡与复核行。 | 加一句「对话内回答无逐句标记；逐句依据在报告阅读器中」 | S3 |
| B45 | §8.2 L342 | 「核对标记要解释它检查了什么」 | 部分正确 | 弹层里已有「引文已在保存的原文中核对」（`claimCitations.ts:138`）；但证据矩阵列里仍是「✓ 已核对」（:203），对话内复核行为「⚠ N 处引用待核对」（`runtimeUiReplyChecks.mjs:93`）。 | 矩阵列文字改「✓ 引文已在原文中找到」 | S3 |
| B94 | §8.2 L333-340、L344 | 结论类型表（直接陈述/跨来源综合/推导或估计/暂缺依据）；「AI 生成与人工修改的区别应在…需要追踪版本时可识别」 | 正确（R11 已实现） | 类型词：直接证据/综合结论/推导结果（`lib/claimCitations.ts:239`）；推导有「推导：方法」「不确定性：…」折叠（`components/markdown-viewer/ClaimCitation.tsx:171-176`）、核对标记「推导，无引文」（`claimCitations.ts:207`）；暂缺依据=「这条结论没有给出可核对的引文」（:141）。AI 参与披露在证据卡「编写与核查」里（`EVIDENCE_AI_STEPS` 检索/筛选/抽取/综合/复核，`packages/domain/src/evidenceCard.mjs:139-140`）；修改版本由修改记录区分（`successorOrigin:"system_generated"`）；报告段落不贴 AI 标签 ✓。 | — | — |
| B46 | §8.3 L348-352 | 研究类型/确定性/推荐价值/热度/相关性分别命名；「缺少评价时显示“未评估”」 | 部分正确 | 分别命名 ✓：证据类型标签（`FrontierCard.tsx:100`）、「编辑评分·满分 100」（:161）、热度数字、独立的「与我相关」页签。GRADE：逐结论「确定性 高/中/低/极低」+PICO，与交付门禁用同一份计算（`lib/claimAppraisal.ts:1-15`）；回答级证据等级 A–D/U，U 读作「未分级」（`packages/domain/src/answerEvidenceGrade.mjs:71-75`）。「未评估」✗：逐结论没有评价时什么也不画（`claimAppraisal.ts:73` 返回 null）。 | 「缺少评价时不显示确定性标签；回答级显示『未分级』」 | S3 |
| B47 | §8.4 L356 | 「目标交互是选中对象→描述改动→查看影响范围→生成候选修改→比较并保留所需版本」 | 过时:R11已变（大半已上线） | 选中：结果版本面板里选中文本/表格单元/图（`ResultVersionInspector.tsx`，`selectionResultAnchor`）；描述改动：「在对话中修改所选内容」（:280）→`continueRevision`（:164）把草稿和 `resultRevision` 引用交给内核输入框，传输层把它附到 `session/prompt`（`runtimeUiTransport.mjs` `revisionPayload`；`runtimeUiBridge.mjs:121-128`）；产出：新的不可变版本，记录 `successorOrigin:"system_generated"`、`adoption:"not_recorded"`（`packages/domain/src/resultCorrection.mjs:25,244-245`）；影响与差异：「修改记录」（类型 analytic/evidence/presentation/unknown、你的要求、所选内容、「重新计算：key（前→后）」，`ResultCorrectionPanel.tsx:40`）、「与历史版本比较」（:275，`ResultComparison` :305）、「来源更新与后续研究」（`ResultImpactPanel.tsx`）。没有「候选」这一步，也没有「保留所需版本」——所有版本都保留。「候选」在 `retiredWords.test.ts` 里是记忆页禁用词。 | 重写为：「选中内容→在对话中描述修改→生成新版本（原版保留）→在版本面板查看修改记录与差异→需要时重算或导出」；删去「候选」「保留所需版本」 | S2 |
| B48 | §8.4 L358 | 「人工修改过的内容不得被无声覆盖。来源版本变化时，保留原成果采用的依据，并提示新版本的具体影响」 | 正确（R11 已实现） | 历史版本只读它自己的证据：「A historical source must never fall through to current workspace bytes」（`components/report/useClaimMatrix.ts:77`）；「检查来源更新」（`ResultImpactPanel.tsx`）。R11 没有「人工直接编辑报告正文」，人工改动=提修改请求。 | — | — |
| B49 | §8.4 L360 | 「局部重算、分支对比和差异合并属于需要能力支持的目标交互；未支持时…不出现虚假的“仅重算这一段”」 | 部分正确 | 整件重算：「重算此结果」只在 `reuseEligibility.replay.status==="available"` 时可点，否则列出原因（`ResultVersionInspector.tsx:253,259`）；局部重算只体现在修改记录的「重新计算」行；分支对比=相关版本互比；差异合并没有。 | 补一句现行范围 | S3 |
| B50 | §8.5 L364-366 | 复制/下载/打印/分享保留内容意义；「分享链接与下载权限分别判断」；「报告打印沿用现有浅色打印副本，隐藏侧栏与工具栏」 | 部分正确 | 阅读器工具栏：「下载 Markdown」「打印 / 存为 PDF」（`ReportReader.tsx:240-248`）；打印副本浅色 `data-theme="light"`、`data-print-hide` 隐藏工具栏（:374-390）✓。Word/PDF/HTML 转换（排队/就绪/部分/失败/取消，可重试可取消）只在「结果版本」面板和虚拟临床研究导出里（`components/document/DocumentExportActions.tsx`）；另有「导出研究包」。下载文件名固定 `report.<格式>`（`lib/documentExport.ts:26`）。**报告没有分享链接**：R11 的分享只有记忆胶囊（`/app/memory/shared/:token`）和公开证据专区。 | 「分享」改为目标，并注明现行只有记忆胶囊与证据专区可分享 | S2 |

### 1.6 §12 前沿动态、事件与简报（L524-590）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B51 | §12.2 L542 | 「现行结构：动态、证据专区、简报、关注；动态内部有精选、热榜、全部、与你相关等视图」 | 错误 | `components/frontier/FrontierControls.tsx:13-20`：一行页签「精选·全部·热榜·与我相关·关注·简报」，简报里再用「日报｜周报」切换（:22-25）；「证据专区」是页头文字链接（`FrontierPage.tsx:692`），自成一组路由。视图与筛选都在 URL：`?view=&q=&lane=&specialty=&window=&starred=&sort=&day=`，另有 `follow`、`week`、`item`（`FrontierPage.tsx:58-64,81-88`），旧地址 `?view=hot` 等仍有效 ✓。 | 「前沿动态页有六个视图：精选、全部、热榜、与我相关、关注、简报（日报/周报）；证据专区是从页头进入的另一组页面」 | S1 |
| B52 | §12.7 L578、L580；§12.2 L542；§20.2 L842 | 「与你相关」 | 错误（名称） | 页签与代码注释用「与我相关」（`FrontierControls.tsx:17`，`ForYouView.tsx:60`）；只有空态一句「暂无与你相关的动态」（`ForYouView.tsx:35`）和后端注释还说「与你相关」。 | 统一为「与我相关」 | S2 |
| B53 | §12.2 L544 | 「移动端保留主导航与当前视图，把低频筛选收进同一面板；简报页不再显示…动态筛选」 | 部分正确 | <640 px 时右侧控件落到页签下一行（`FrontierControls.tsx:40-43`），不是「同一面板」；简报视图右侧只剩「日报｜周报」（:71-73）✓。 | — | S3 |
| B54 | §12.3 L550、L552 | 「资讯标题打开原文；站内解读、事件详情和深入研究使用各自明确入口」；收藏/深入研究/更多不只在 hover 出现 | 正确（R11 已实现） | `FrontierCard.tsx:172` 标题链接 `item.url` 新标签；「详情」抽屉、「同一事件的全部报道」（:128,141）、「深入研究」（:132）各自独立；三个动作常显（头注释，所有者 2026-09-24）；R11 否决「标题开站内详情」（triage-B F01）。 | — | — |
| B55 | §12.4 L556 | 热榜「明确计算窗口、更新时间与排序含义」 | R11已否决（排序含义部分） | 窗口+更新时间 ✓「近 72 小时 · 22:40 更新」（`frontierText.ts:262-268`），只在服务端给出 `takenAt` 时显示（`FrontierHot.tsx` 的 `HotWindowChips` 注释）。「排序含义」✗：所有者 2026-09-23 删「热度怎么算」，2026-10-07 再删（`frontierText.ts:8-11`）；R11 triage-B F02 明确 Reject，热度只显示一个数字。 | 「热榜标明时间范围与更新时间；不在页面解释热度算法」 | S1 |
| B56 | §12.4 L558 | 「图线只能呈现真实保存的历史…不能绘制补齐的平滑曲线」 | 部分正确（代码与目标规则冲突） | 少于 2 个读数→「暂无走势」✓（`Sparkline.tsx:22`）；但读数中间有 `null` 时，`sparkline()` 把有读数的点直接连成一条折线，缺口被抹平（`frontierText.ts:276-287`）。 | 若保留该规则，这是 R11 要改的缺陷；否则删去该句 | S2 |
| B57 | §12.4 L560 | 「“新上榜”…“热度上升”」 | 部分正确（词不同） | 徽标是「新」「升温」（`FrontierHot.tsx` 的 `HotRow`）。 | 「新」「升温」 | S3 |
| B58 | §12.5 L564-568 | 事件详情建议顺序、时间线、一手来源筛选、收藏事件 | 部分正确 | 顺序：标题+「N 家机构报道·更新时间」→「概要」（含「最新」，`FrontierEventPage.tsx:178`）→「一手材料」→「其他报道」→「相关事件」（类型词：后续进展/取代了之前的说法/预印本与正式发表/撤稿/更正/相关，:45）；右栏热度/走势/机构/首报/一手材料（:217）。**未实现**：新旧排序切换（固定新→旧，:153）、标注发生/发布时间、背景综述折叠、收藏事件（顶栏只有「深入研究」:167）；一手来源筛选=分组+「≥10 条时按来源类型下拉」（:189）。关系规则与服务端一致：标识符不等于同事件、仅相似度不足以成事件、模型判 yes 才并、related 只连边（`apps/server/src/frontierEvents.mjs` 头注释）。 | 保留顺序与关系规则；把「排序可切换/发生 vs 发布时间/收藏事件」标为未实现目标 | S2 |
| B59 | §12.6 L576 | 「日报默认按北京时间 07:30 出刊…实际配置的时区与出刊时间应一致呈现」 | 部分正确 | 07:30/北京时间 ✓：`OPEN_SCIENCE_FRONTIER_DAILY_TIME`=07:30、`OPEN_SCIENCE_FRONTIER_TIMEZONE`=Asia/Shanghai（`config.mjs:291,295`）；窗口 [D−1 07:00, D 07:00)（`frontierDaily.mjs:13-20,136-143`）；复制稿写「（北京时间）」（:282）。界面把「07:30」写死在空态：「今日日报 07:30 发布」（`components/frontier/DailyView.tsx:120`），页面不显示时区。 | 空态读配置（或去掉具体时刻），页头加时区 | S2 |
| B60 | §12.6 L574 | 目录/往期/「返回本期目录」/日期控件 | 部分正确 | 粘性页头：日期、条数/时长、「复制」「分类」（≥3 个栏目才出现，列出栏目与条数并滚动到该栏）、「往期」（最多 14 期，`DailyView.tsx:26,123`）；前一日/后一日；无日历，无「返回本期目录」按钮（页头一直在）；从事件页返回可恢复阅读位置（`frontierReadingState.ts`）。 | 「目录」写成「分类」菜单；删去日历 | S3 |
| B61 | §12.6 L576 | 「界面必须区分“本期没有新内容”和“本期暂时无法生成或读取”，保留上一期时显示其真实日期」 | 部分正确 / 需新数据契约 | 保留上一期并显示真实日期 ✓（缺省显示最新一期，页头 `shortDate(issue.day)`，`DailyView.tsx:43-61,132`）。两种「空」的区分 ✗：服务端设计上从不把「没出刊」当错误给读者（「never shown to a reader as an error」，`frontierDaily.mjs` 头注释；只上报 `missing` 指标与告警）；前端只有读取失败→「加载失败+重试」，与无期→「暂无日报」/「今日日报 07:30 发布」（:119-120）。 | 把「区分」标成目标，注明「需服务端提供当日状态（无内容/生成失败）」 | S2 |
| B62 | §12.7 L580 | 「推荐范围应可调整，支持减少此类内容；反馈到底改变…要按真实能力说明」 | R11已否决（说明部分） | 可减少 ✓：「不感兴趣」（`FrontierCard.tsx:124`）与「屏蔽 <来源>」；「按真实能力说明」✗：triage-B F04「no new explanation UI」（所有者 09-23「为什么入选 must go」）。 | 去掉「要按真实能力说明」，改「不在页面解释推荐机制」 | S1 |
| B63 | §12.7 L582 | 关注：分清主题/事件/来源；管理入口；取消关注不删收藏；空状态给入口 | 正确（R11 已实现） | 类型词 主题/药物/专科/来源/事件（`FrontierFollows.tsx:15`）；「屏蔽」与「移除」分开；空态「关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。」+「添加关注」+「浏览证据专区」（`FollowingView.tsx:106-109`）。 | — | — |
| B64 | §12.7 L584 | 「专区内区分原始研究、综述、指南和证据解读，不把所有材料统一称为“高质量证据”」 | 部分正确 | 专区三类：官方/产品/用户专区（`packages/domain/src/evidenceCard.mjs:102-103`）；证据卡自带标签「性质 一手·原创分析/复算核验/原创研究 或 解读·综合/速览」「时效」「核验 n/m」「出品方·类型·与产品的关系」（`components/frontier/EvidenceCardHeader.tsx:14-18,26-50`）；「原始研究/综述/指南」是来源徽标，不是卡片分类。解读页以问题为标题，折叠「编写与核查」「评议与讨论」「更新记录」（`app/routes/EvidenceReadingPage.tsx`）。 | 「卡片标注性质（一手/解读）、时效与核验情况；来源徽标区分研究类型」 | S2 |
| B65 | §12.8 L588-590 | 摘要/原文区分；失效深链给对象级错误 | 正确（R11 已实现） | 抽屉：「中文摘要」「原文摘要」分标题（`FrontierDetails.tsx:128`）、「原文 ↗」「免费全文 ↗」；失效 `?item=`：「这条动态已下架，不再提供。」+「关闭」（`FrontierLinkedItem.tsx:34-41`）；失效事件「这个事件已不存在」+「看热榜」（`FrontierEventPage.tsx`）。 | — | — |
| B91 | §12.1 L530-538 | AIHOT 借鉴表：区分报道数/独立来源数/独立研究数；最新进展独立于背景摘要；热榜紧凑摘要；简报有终点；不新增「为什么入选」栏；推荐分不映射为医学可信度 | 部分正确 | 报道数是「N 家机构报道」（机构数，不是独立来源数，更不是独立研究数；`components/frontier/frontierText.ts:245,292`）；事件页「最新」与概要同段，没有「已读事件优先新增事实」；精选页热点紧凑 3 行、完整榜单另页 ✓（`FrontierHot.tsx` 的 `HotCard`）；简报有日期·条数·时长·分类·往期·前后翻页，没有「终点」文案；来源可追踪 ✓（原文 ↗ / 免费全文 / 存入知识库）；「为什么入选」不新增 ✓（摘要最后一句承担，`FrontierCard.tsx` 头注释）；评分标「编辑评分」，热度只是数字 ✓。 | 「独立研究数」「已读事件优先新增事实」标为目标，需要新数据（事件—研究去重、已读基线） | S3 |

### 1.7 §13 知识库与数据理解（L592-614）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B66 | §13.1 L596-600 | 「列表优先显示名称、类型、来源、更新时间和实际可用状态…常用操作为打开原文件、用于研究与管理…可按类型、来源和时间筛选」 | 部分正确 | 行 = 图标·标题·状态/要点行·「类型·站点·页数或大小·来源·所有项目可用」·右侧日期；这个日期是创建日，不是更新时间（`components/sources/SourceRow.tsx:63-70`，`sourceView.ts:57`）。抽屉两个页签「内容」「原文」，底栏「在对话中使用」「下载」（`SourceDrawer.tsx:73,90-92`），不是「用于研究」；下载在解析失败时仍可用（仅 `!path` 时禁用，:92）✓。筛选 = 类型芯片 + 范围菜单（本项目/所有项目）+ 服务端搜索（`SourcesPage.tsx:297-300,343-345`），**没有来源、时间筛选**。 | 「…右侧为上传日；常用操作『在对话中使用』『下载』；可按类型筛选」 | S3 |
| B67 | §13.2 L604-606 | 「应区分上传完成、文字可读、表格可用、图像或页面尚未解析；系统没有读取到的部分必须说明」 | 仍未实现（数据已就绪，界面没画） | 行/抽屉只有「正在读取 / 没能读取 / 部分无法读取 / 原件已移除 / 已取消」（`sourceView.ts:22-33`）。`coverage.materials`（页码映射、结构化表格数、单元格定位、图注）已存在，客户端有类型（`lib/sourceMaterials.ts:1-27`）但没有任何界面使用。 | 标注「数据已有，缺界面，不需新契约」 | S2 |
| B68 | §13.2 L606 | 「重新解析与重新上传不是同一个动作」 | 部分正确 | 「重新读取」（失败/部分/链接）与上传分开；链接页面「页面有更新，正在重新读取 / 页面没有变化」（`SourcesPage.tsx` 的 `readAgain`）；版本列表不展示。 | — | S3 |
| B69 | §13.3 L610-614 | 「需要研究者确认的内容就地可改；已确认字段不在每次分析前重复询问」 | 部分正确 | 面板只读 + 批量「确认以上推断」；更正「在对话里说，本页只确认它所显示的」（`components/sources/DatasetMeaningPanel.tsx:18`）。依据层级「你已确认 N / 数据字典所述 N / 模型推断 N」+「另有判断…没有采用」✓（:119-143）；检查结果 重复观测/连接/分母/时间泄漏 → 结果词+对象+「需要决定」✓（`LastCheck` :145）；文件版本与记录版本不一致的横幅 ✓（:81）。弱依据不覆盖强依据是领域契约（`packages/domain/src/dataSemantics.mjs`）。 | 「就地可改」→「就地确认；修改在对话里提出」 | S2 |

### 1.8 §14 记忆、定时任务、通知（L616-638）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B70 | §14.1 L620-624 | 记忆页：来源/适用范围/有效时间/修订；冲突、过期、被替代、来源撤回分别呈现；编辑/停用/恢复可找回 | 正确（R11 已实现，用词不同） | 四页签「关于你·项目·做法·成长」（`app/routes/MemoryHubPage.tsx:37`）；行→抽屉：编辑、忘记（带撤销）、这不对、以这条为准、撤销上次改动、以前的版本、出处+来源对话（`components/memory/FactDrawer.tsx:29-42,199-203,259,306-307`）；不确定性徽标「有冲突/来源已撤回/来源已过期/来源已更改/尚未生效/已被替代」；「已忘记的内容」可恢复。「做法」是学来的、从不手写。不在每条消息旁堆命中数（「本次用到的背景」已退役，`retiredWords.test.ts`）。 | 「停用」→「忘记（可撤销）」 | S3 |
| B71 | §14.1 L624 | 「导入胶囊前说明内容与目标范围，胶囊本身不授予任何执行权限」 | 正确 | 导入先预览：条目、「不会带上 N 条」、「试用一次」（不写记忆）/「启用」，只传文本（`app/routes/SharedCapsulePage.tsx:45,114-136`；`CapsuleTransferPanel.tsx:232,246`） | — | — |
| B72 | §14.2 L626-632 | 创建持续委托要确定「目标、范围、触发时间与时区、预算、停止条件、通知方式」；任务列表显示下次/最近结果/启停；详情先结果历史再配置 | 部分正确 | 表单见 B26；列表行「下次 … · 重复规则」「上次 … · 研究结果/未完成」（`taskPresentation.ts:90,105`，`AutopilotPage.tsx` 的 `taskGroup`）✓；时区始终显示（抽屉页头、表单摘要）✓。详情抽屉是「页头配置摘要→操作→任务指令→研究进展→时间线（最新在底部）→追问输入」，配置摘要在前。 | — | S3 |
| B73 | §14.2 L630 | 「暂停日程只影响未来触发，是否同时取消当前运行必须按实际功能明确区分」 | 部分正确 | R11 只有一种「暂停任务」，确认框如实说「暂停后将取消正在进行和排队中的研究，已产生的结果会保留。」（`AutopilotPage.tsx:302`）；没有「仅暂停后续」。 | 如实写：「暂停同时取消进行中与排队中的研究」 | S2 |
| B74 | §14.2 L632 | 「没有新证据、失败、产生了结果，是三个不同状态」 | 部分正确（需契约） | 执行状态词 排队中/结果核验中/研究进行中/未完成/已取消/研究结果，外加 任务预算已用完/等待余额/等待运行资源/余额不足/运行资源暂不可用（`taskPresentation.ts:61-78`）；「没有新证据」不是执行状态，而是规划器停任务并写原因「已暂停：…」（`pauseNotes` :111）。 | 须有 episode 结果类型（无新证据）才能区分 | S2 |
| B75 | §14.2 L632 | 「通知直接到达本次结果」 | 正确（R11 已实现） | `?digest=` 解析到该次执行的对话并跳转（`AutopilotPage.tsx:150-167`）；时间线直链成果（`components/autopilot/TaskTimeline.tsx` 的 `snapshotHref`）。 | — | — |
| B92 | §14.3 L634-638 | 「取消订阅、减少此类内容、暂停委托和关闭渠道互不混淆；设置页修改通知方式后保留研究任务本身」 | 正确（R11 已实现） | 四件事在 R11 各是独立动作：关注页「移除」/「屏蔽」、卡片「不感兴趣」、定时任务「暂停任务」、设置→通知的开关；每个通知开关下一行说明送达位置——永远进收件箱，绑定飞书后加飞书（`components/settings/NotificationsSection.tsx:29`，`FrontierDigestRow.tsx` 头注释「前沿日报」开关与简报时刻）。 | — | — |

### 1.9 §15 科研工具与专业模块（L640-672）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B76 | §15.1 L646 | 「工具目录提供按研究任务查找的方式，能力地图作为辅助探索」 | R11已否决 | R11 plan C02「fixed（+ reject "fill the map"）」：研究者页面没有能力地图，仅运维只读路由。科研工具页 = 搜索 + 分类芯片（临床证据/药学评价/研究设计与数据/写作与传播）+ 卡片网格（`app/routes/CapabilitiesPage.tsx:26,161-179`）。 | 删去能力地图一句 | S1 |
| B77 | §15.1 L644 | 「每项工具说明它能交付什么、需要什么输入，以及已知的时间或额度信息」 | 部分正确 | 卡片 = 一句话说明 + 「约 30～70 分钟」；「约 ¥4～8 额度」只在模拟钱包部署显示（`CapabilitiesPage.tsx:38-60`，`durationText`/`allowanceText`）；「需要什么输入」不在卡片，选中工具后由输入框说（头注释 :73-77）；状态标签只在需要用户处理时出现（受限/不可用/规划中）。 | 「输入要求在选中工具后的输入框里说明」 | S3 |
| B78 | §15.1 L648 | 现行约束（内部能力不入目录、模块专用能力不铺入通用页、NCBI GEO 与循证 GEO 分开命名） | 正确 | `capabilityListed(agent.id)` 过滤（`CapabilitiesPage.tsx:107`）；基因表达分析的标识永不叫 `geo` | — | — |
| B79 | §15.2 L652 | 「默认显示当前阶段的实际内容，不让七阶段流程占据整页第一屏」 | 部分正确 | 一行页签「总览·定义与证据·人群·虚拟患者·对照·试验·匹配与招募」，每个页签带状态点 todo/partial/done/active/attention（`components/vcr/vcrTabs.ts:25,71-80`）；步骤轨已删；默认进入「总览」而不是「当前阶段」（`resolveVcrTab`，:101）。无第二个输入框，页头「对话」是唯一入口（`VcrStudyPage.tsx` 头注释）。模块首页另有方法库/试验先例/人群定义三个资料库页签（`?tab=models／precedents／definitions`）。 | 「默认进入总览，页签状态点显示各阶段进度」 | S3 |
| B80 | §15.2 L654 | 「完成状态必须对应可打开的材料或结果；尚无结果时不能显示“研究完成”」 | 正确（R11 已修） | 步骤状态按数据判定；没有计算结果的方案不提供「选定方案」；部分结果/模型不适用/结果已过期（数字保留灰显）三种状态（`components/vcr/VcrStates.tsx` 头注释；R11 VCR 包）。 | — | — |
| B81 | §15.3 L660-666 | 循证 GEO：指标卡进同口径明细；AI 答案详情保留回答时点与快照；后续测量产生新快照 | 正确（R11 已实现） | 七页签「总览·可见度·准确与安全·问题与回答·信源·行动·方案」（`components/geo/geoTabs.ts`）；回答页 `/app/geo/:geoId/answers/:snapshotId`，日期切换在同一问题同一引擎的各次回答间，截图为存证（`GeoAnswerPage.tsx` 头注释）；总览/指标卡/图表/可见度页共用 `readingChange()`（`components/geo/geoOverviewModel.ts`，R11 GEO-A）。 | — | — |
| B82 | §15.4 L670-672 | 状态用「可用」「安装中」「需要处理」；更新、停用、回退、安装失败应可理解 | 部分正确（词不同） | `extensionState`：可用/准备中/需处理/已移除（`app/extensions/ExtensionDrawer.tsx:22-28`）；阶段词 准备中/待启用/已保存/需要重试/此环境不支持/需要连接账户/正在启用/已恢复上一版（`lib/extensionsClient.ts:57`）；有「更新到最新版」、停用/启用、版本历史、回退（`ExtensionDrawer.tsx:117,127`，`rollbackWebPlugin`）。页签顺序：技能在前（`ExtensionsPage.tsx:145`）。 | 状态词改「可用 / 准备中 / 需处理」 | S3 |

### 1.10 §16 通知、设置与边界页面（L674-702）

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B83 | §16.1 L678-680 | 通知回答发生了什么/对象/时间/能做什么；已读与已处理分开 | 正确 | 行=未读点·标题·一行·时间，整行打开；「标为已读」悬停出现；未读临床安全置顶，「全部已读」不动安全项；待回答/待核对（`app/routes/InboxPage.tsx:31-60`） | — | — |
| B84 | §16.2 L684-688 | 设置分区；额度说明可用/占用/已消耗；普通任务区不显示 token | 正确 | 见 B08；「可用科研额度 = 充值 ＋ 赠送 − 冻结」（`components/settings/ResearchAllowance.tsx:60-66`）；ui-walk 的 `BACK_OFFICE` 禁用 token/tok/s/缓存命中；运维才看原生统计（所有者 2026-09-29） | — | — |
| B85 | §16.3 L692 | 「提供可理解的失败原因和恢复方式…登录后返回先前请求的有效对象，不能总是丢到空白首页」 | 仍未实现（返回地址）/ R11已否决（恢复方式） | 失败原因 ✓（`LoginPage.tsx:65-68` `signInMessage`）；显示密码 ✓（:138-140）。**恢复方式=找回密码，R11 否决**（平台没有找回通道，R11 plan 不采纳清单）。**登录后总是 `navigate("/app/chat")`**（`LoginPage.tsx:82`）；已登录访问 `/login` 也跳 `/app/chat`（:40）；OIDC 返回地址固定 `/app/chat`（:113）；`AppShell.tsx:150` 重定向 `/login` 时不记录来路。 | 「登录后返回先前请求的地址」列为目标（需在 `/login` 保存 returnTo）；「恢复方式」改「可理解的失败原因；不提供找回密码」 | S2 |
| B86 | §16.3 L694-696 | 首次使用不强制引导、演示内容标示例；回访恢复上次工作；可再次查看帮助 | 部分正确 | R11 没有引导遮罩，也没有示例内容；回访恢复上次对话（`lastSessionId`，`app/layout/SessionFrameHost.tsx:152-186`）；「稳定位置再次查看帮助」只有 `?` 快捷键表。 | — | S3 |
| B87 | §16.4 L700 | 「不存在页面提供返回工作区；不存在对象提供返回所属列表；无权限页面说明无法访问并保留可用导航；服务错误保留…重试」 | 部分正确 | 404：「页面不存在」+「返回首页」（`app/routes/NotFound.tsx:16-20`；所有者 2026-09-23 裁定「标题 + 一条回首页」，R11 不采纳「返回上一页」，`NotFound.test.tsx` 守住）；路由/页面错误：「出了点问题」+「重新载入」，侧栏与对话保留（`RouteError.tsx`，`router.tsx:67-71`）；模块未开放：一句话、无按钮；对象不存在各页自带（事件「这个事件已不存在」+看热榜；研究/回答「…不存在或已删除。」；任务「未找到这个任务」；插件/技能找不到→回列表；失效分享链接→恢复卡片）。**没有无权限页**：403 只在 `apiClient.ts:268` 的兜底文案里，别人的对象按 404 处理。 | 「不存在页面提供『返回首页』」；「无权限页」删去或标未实现 | S2 |
| B88 | §16.4 L702 | 「现有模拟充值、模拟会员、模拟订单和模拟退款页面」 | 错误（R11 已删两页） | 只剩 `/app/account/simulated/recharge`（模拟充值）和 `/app/account/simulated/orders`（模拟订单）（`packages/domain/src/researchBilling.mjs:44-47`；`router.tsx:120-126`；`SimulatedWalletPage.tsx:38-44`）；`/membership`、`/refunds` 现在答 404 页（ui-walk `ROUTES` 里有断言）。每页开头一句「不动真实资金」，每个金额带「模拟」标记。 | 「现有模拟充值和模拟订单页面…」 | S1 |

### 1.11 范围外顺带发现

| id | 节/行 | 原文 | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| B89 | §10.3 L474 | 「侧栏 默认 280，收起 56」 | 错误 | 外壳侧栏：默认 232、范围 184–340、收起=宽度 0 且 `inert`（`lib/store.ts:10-12`；`Sidebar.tsx:171,182`）。280/56 是内核自己的常量（`DESIGN.md:274`「the kernel's constants」），内核左栏在托管里整个被移除（`runtimeUiShell.mjs:161`）。DESIGN.md 本身也该改。 | 「侧栏默认 232（可拖 184–340），收起为 0 并移出焦点序列」 | S1 |
| B90 | §22.3 L960 | 链接「前沿导航 `components/frontier/FrontierNavigation.tsx`」 | 过时 | R11 无此文件，被 `FrontierControls.tsx`（页签+右侧控件）、`FrontierFilters.tsx`、`FrontierBack.tsx` 取代；旧树仍有。 | 指向 `FrontierControls.tsx` | S2 |

### 1.12 分类索引

- **R11 已实现（文档与现状一致，或文档把已上线的能力写成了目标）**：B10 B11 B14 B18 B24 B25 B34 B36 B37 B42 B44 B47（大半）B48 B54 B63 B65 B70 B71 B75 B78 B80 B81 B83 B84 B92。
- **R11 已否决 / 已变更（文档与 R11 的决定相冲突）**：B05 改名、B06 路由、B16 命令面板、B38 运行视图对研究者开放、B55 热度算法不解释、B62 推荐机制不解释、B76 能力地图、B85 找回密码、B88 模拟会员/退款、B89 侧栏宽度。
- **仍未实现（文档目标在 R11 没有对应物）**：B12（前沿动态以外的页面）B20 B21 B22（取决于部署开关）B23（结构化对象引用）B31 与 B43（质量提示无界面）B33（重连期间看已有内容）B39（历史消息）B40（无「重新发起」）B46（「未评估」）B50（报告分享）B56（走势缺口）B58（事件时间线排序/收藏）B59（日报时区/时刻读配置）B60（返回本期目录）B61（简报失败态）B64（卡片分类）B67（覆盖范围 UI）B69（就地修改变量含义）B73 与 B74（仅暂停后续 / 无新证据状态）B85（登录返回原地址）B86（引导与帮助）B87（无权限页）。

## 2. R11 中存在而文档未覆盖的页面 / 对象 / 行为

`src/` = `OpenScience/apps/web/src/`。「文档里该放哪」指建议补进的章节。

| 对象 / 页面 | 路由或入口 | 文件 | R11 行为（事实） | 建议补入 |
|---|---|---|---|---|
| 转为深度研究（交接页） | `/app/handoff#<payload>` | `app/routes/HandoffRoute.tsx`，`lib/researchHandoff.ts` | EviMed AI 搜索的「转为深度研究」：控制面绑定会话并写入「来自 AI 搜索」卡片，页面把外壳切到目标项目，打开会话并把首条消息放进输入框，不发送；无负载→「没有要转入的问题」+「开始新对话」；链接损坏→「这条转入链接已失效」；失败→「无法转入深度研究。」+重试 | §6.4 |
| 报告 / 文件阅读页 | `/app/runs/:runId/files/*`（`#CLM-003`、`?quote=`、`?version=`、`?claim=`）；`/app/runs?run=<id>` 解析后重定向到所属对话 | `app/routes/RunFilePage.tsx`，`router.tsx:106-110,189-202` | 「返回对话」·「结果版本」开关·「存入知识库」；报告用完整阅读器，证据矩阵用表格，其它文件用文件预览；run 不在当前项目时到别的项目找并切过去 | §8、§3.2 |
| 证据矩阵（阅读器页签 / 独立页 / 抽屉） | 报告阅读器「证据矩阵」页签；`*matrix*.json` 的文件页 | `components/report/EvidenceMatrixTable.tsx`，`EvidenceMatrixDrawer.tsx`，`useClaimMatrix.ts` | 紧凑行（编号·核对·结论·首个来源·类型）、搜索、核对（全部/已核对/需要复核）与类型筛选，点行开抽屉看引文/PICO/位置；盒宽 <640 px 变卡片；核对中显示「核对中」而不是「未核对」 | §8.2、§9.3 |
| 结果版本面板 | 文件页「结果版本」；`?version=<id>` | `components/inspector/ResultVersionInspector.tsx`，`ResultCorrectionPanel.tsx`，`ResultImpactPanel.tsx`，`ResultLineagePanel.tsx` | 版本下拉、下载此版本、重算此结果（可重算才亮）、导出研究包、发布为证据卡、来源对话、依据与核对意见、修改记录、版本比较、来源更新检查、「在对话中修改所选内容」 | §8.4 |
| 文档导出作业 | 版本面板「导出此版本」、虚拟临床研究导出 | `components/document/DocumentExportActions.tsx`，`lib/documentExport.ts` | Word/PDF/HTML 逐格式 排队/就绪/部分/失败/取消，可重试可取消 | §8.5 |
| 证据卡阅读页 | `/app/frontier/zones/:zoneId/evidence/:cardId` | `app/routes/EvidenceReadingPage.tsx` | 标题=证据问题；「问这条证据」（草稿进新对话）；⋯ 编辑/发布/撤回；折叠「评议与讨论」「更新记录/变更记录」；每条结论可「质疑」；「回到相关动态」仅当原动态未下架 | §12.7 |
| 专区目录与专区页 | `/app/frontier/zones`（`?scope=following／owned`、`?fromItem=`、`?request=`），`/zones/:zoneId` | `app/routes/EvidenceZonesPage.tsx`，`EvidenceZonePage.tsx` | 页签「全部专区/我创建的/我关注的」；「申请选题」抽屉；条目卡「整理为证据卡片」跳到此处；专区页有关注、反馈、可见性、维护、变更记录 | §12.7 |
| 作者页 | `/app/frontier/authors/:authorId` | `app/routes/EvidenceAuthorPage.tsx` | 以作者名为标题，页签 证据卡/专区/变更；只写不为零的计数；无作者排名 | §12.7 |
| 事件页路由 | `/app/frontier/events/:eventId`（合并事件的旧地址 308 到幸存者） | `app/routes/FrontierEventPage.tsx` | §12.5 描述了内容但没有给路由 | §3.2/§12.5 |
| 安全警示条、当前热点卡 | 精选页顶部 | `components/frontier/SafetyStrip.tsx`，`FrontierHot.tsx` 的 `HotCard` | 近 48 小时官方安全公告；热点前三（手机只显示第一行）+「完整热榜 ›」；搜索/筛选时不显示 | §4.5、§12.3 |
| 记忆：成长 / 做法 / 分享与导入 / 已忘记 | `/app/memory?tab=growth／methods`，⋯ 菜单两个抽屉；`?record=`、`?method=` | `app/routes/MemoryHubPage.tsx`，`components/memory/*`，`components/capsule/*`，`app/routes/CapsuleTransferPanel.tsx` | 成长=胶囊增长线与时间轴；做法=学来的方法与手册，只读/可停用/可回退，不可手写；顶栏有「记忆」开关、「本项目不使用记忆」「重置记忆」；写入提示「刚记住了 … 撤销」 | §14.1 |
| 分享 / 收到的胶囊 | `/app/memory/shared/:token`，`/app/memory/delivered/:deliveryId` | `app/routes/SharedCapsulePage.tsx` | 预览条目与「不会带上 N 条」，「试用一次」（不写记忆）或「启用」；失效链接给恢复卡片 | §14.1 |
| 虚拟临床研究：资料库与研究包 | `/app/virtual-research?tab=models／precedents／definitions`；`/app/virtual-research/:studyId?package=<id>` | `app/virtual-research/VcrHomePage.tsx`，`components/vcr/VcrPackageReader.tsx`，`useVcrFinishedToasts.ts` | 方法库、试验先例、人群定义三个资料库；研究包在研究自己的地址上读；后台计算结束时，人在同一研究的别处会收到 toast 并给结果入口；预算/成员对话框、额度等待与充值入口 | §15.2 |
| 循证 GEO：回答快照页 | `/app/geo/:geoId/answers/:snapshotId` | `app/routes/GeoAnswerPage.tsx` | 左侧同一问题各引擎、右侧该引擎当日回答，错误句波浪线，日期切换，截图存证；浏览器标签名「AI 回答监测」 | §15.3 |
| 设置：通知 / 数据源 / 项目 / 运维 | `/app/account?tab=notifications／connectors／projects／ops` | `components/settings/*`，`app/routes/OpsPage.tsx` | 通知里绑定飞书、简报推送开关；数据源=连接账户与凭据表单；项目=行内重命名/导出（悬停）与 ⋯ 删除（同名带日期，删除框说明模块项目的连带删除）；运维=运行资源在前，然后配置检查、任务、审计、错误、安全、GEO 订单与循证进化卡片（`app/routes/OpsPage.tsx:50-56`） | §16.2 |
| 科研额度与模拟钱包 | `/app/account?tab=usage`；`/app/account/simulated/recharge`、`/app/account/simulated/orders` | `components/settings/ResearchAllowance.tsx`，`SimulatedAllowance.tsx`，`app/routes/SimulatedWalletPage.tsx`，`components/runs/AllowanceTopUp.tsx` | 额度=充值＋赠送−冻结；模拟钱包部署下科研工具卡显示「约 ¥X～Y 额度」、额度低/用完时页首提示；模拟充值只能选 50/100/200/500 四档（`SIMULATED_TOPUP_PACKAGES`）；虚拟临床研究步骤等待额度时就地给充值入口；无模拟钱包的部署访问这两页得到一句话说明和回设置的路 | §16.2、§16.4 |
| 数据源补齐条 | 对话 iframe 上方的一条 | `components/runs/ConnectorNeedNotice.tsx` | 上一轮缺数据源时，就地填凭据「去配置」，保存后「继续」=向同一对话追发一轮补做 | §7.2 |
| 对话启动 / 等待 / 拒绝态 | 对话 iframe 的封面与告警 | `app/routes/RuntimeUiFrame.tsx`，`app/layout/SessionFrameHost.tsx` | 封面标题+一句话（正在打开 / 正在准备运行环境 / 清理 / 所有研究环境都在使用中）；告警按原因给动作：重试、新建对话、查看已有成果、查看定时任务、查看科研额度、去模拟充值；「对话暂时无法连接」+重试；「打开超时，请重试」 | §7.2、§7.4 |
| 对话内由内核承载的对象 | 对话 iframe 内部 | `packages/harness-port/src/runtimeUi*.mjs` | 交付文件卡（含「存入知识库」）、来源卡（证据等级 A–D/U、研究类型徽标、「在报告中查看」）、复核行（仅有问题时「⚠ N 处引用待核对」）、工具行（计划/子任务）、工具标签+示例按钮+`/工具`+`@` 引用、GEO/VCR 参数控件、「运行」视图 | 第 3 部分 |
| 数据含义面板与「这份数据可用的工具」 | 知识库表格资料的抽屉「内容」页签 | `components/sources/DatasetMeaningPanel.tsx`，`components/evolution/EvolutionPanel.tsx` | 变量/表/连接的依据层级与检查结果；按数据要求匹配的循证进化工具（验证等级 V0–V4、数据等级 D0–D4） | §13.3 |
| 循证进化入口 | 定时任务页「机会」、收件箱决策卡、运维页 | `components/evolution/EvolutionOpportunities.tsx`，`EvolutionDecisionCard.tsx`，`EvolutionPanel.tsx` | 文档完全没有提及 | 新增小节或明确「不在本规范范围」 |
| 侧栏项目树与对话菜单 | 侧栏 | `components/sidebar/ProjectBrowser.tsx`，`ConversationMenu.tsx`，`ConversationMatches.tsx` | 项目为可折叠分组，每组先显示 5 条对话，再「展开其余 N 条对话」；组内悬停有新建/重命名；模块项目归入末尾两个分组；对话 ⋯ = 停止/重命名/归档/删除（运维另有复制诊断信息）；对话全文搜索来自内核并 8 秒超时 | §3.3 |
| 嵌入模式 | 任意页加 `?embed=1`（或 wujie） | `app/layout/embed.ts`，`AppShell.tsx` | 只渲染内容区，不画侧栏、跳转链接、快捷键表 | §3.3 |
| 旧地址重定向 | `/app/sources`、`/notebooks`、`/capsules`、`/settings`、`/ops`、`/live`、`/runs`、`/files`、`/memory`、`/agents` 等 | `app/router.tsx:127-141,156-170` | 全部保留并跳到新位置，不是 404 | §3.2 |
| 组件陈列页 | `/__gallery`（仅 CI 构建） | `app/routes/GalleryPage.tsx` | 每个组件每个状态，CI 截图比对（`scripts/ops/gallery-shot.mjs`，浅色/深色各一份基准） | §20.1、§20.5 |

## 3. 对话界面的内核边界表

事实基线：对话页是 DSH 内核自己的浏览器应用，放在**另一个源**的 iframe 里（`app/routes/RuntimeUiFrame.tsx:1104-1109`，`sandbox="allow-scripts allow-same-origin …"`，`title="对话"`），由 `SessionFrameHost` 在路由之上挂载、离开对话页时 `display:none` 而不卸载（`app/layout/SessionFrameHost.tsx:229-231`）。`/app/chat/:sessionId` 路由本身只是个占位（`app/routes/SessionRoute.tsx`）。内核版本钉 0.1.7-rc.2（`runtimeUiShell.mjs:51`）。外壳影响内核页面的**全部**通道：

1. **Slot**（契约表 `packages/harness-port/src/runtimeUiSlots.mjs` 的 `RUNTIME_UI_SLOTS`）。**已占用**：`sidebar`（占空，左栏内容被换掉）、`sidebar.brand.mark/name`、`conversation.hero.brand.mark`、`conversation.hero.workspace`（占空）、`conversation.hero.agentPreset`（空白会话的工具标签+示例）、`conversation.composer.dock`（工具标签）、`conversation.input.left`（上传按钮）、`conversation.input.attachments`（接管但原样保留内核 props）、`conversation.chat.node`（键 `assistant-step` 被三层接管：-1 复核行、-2 文件卡、-3 来源卡；`system-prompt`/`context`/`unknown` 对非运维渲染为空）、`tool.call.toolview`（每个 evimed 工具一行）。**已声明未占用**：`conversation.view`（「运行」页签是内核自己的 trajectory 视图，只改了名）、`conversation.input.dock`（2026-09-23 起空）、`conversation.composer.bar`、`conversation.input.right`、`sidebar.right.pane.tab(.title)`（外壳断言 `rightbar` 不被占用）。
2. **语言包 `zh-x-evimed`**（`runtimeUiLocale.mjs:68-141`）：只覆盖 conversation / chat / subagent / workspace / slash.menu / trajectory 六个命名空间里的 39 个键，其余仍是内核的 `zh`；`<html lang>` 校正为 zh-CN。
3. **主题令牌层**：`ctx.theme.overrideTokens('@evimed/dsh-socket', kernelThemeTokens)` + 外壳的浅/深/跟随系统经 `theme` 消息交给 `setTheme`（`runtimeUiTheme.mjs`；`RuntimeUiFrame.tsx:923-934`）。只有颜色与字体（含本地 `@font-face`「EviMed CJK Punct」），**内核没有间距/圆角令牌族**。
4. **CSS 隐藏/摆放规则**（`runtimeUiShell.mjs:85-197`）：隐藏「添加工作区」「选择工作区」芯片、「访问模式」芯片、（非运维）统计行与回合页脚用量、空工具行；移除左栏（`[class$="_sidebarCol"]`）并重新钉轨；锁定阅读宽度。
5. **面板启停**（`apps/server/src/dshProfilePatch.mjs:371-420`）：`ui-settings-*`、`ui-permission`、`ui-agent-preset`、`ui-message-feedback`、`ui-goal`、`ui-cordis`、`ui-brand-official`、`ui-open-in-app`、`session-log-download` 等禁用；`ui-sidebar-files` / `ui-sidebar-documentpreview`（右栏文件树与预览）**启用**（2026-09-22 起）；`ui-trajectory`（运行视图）对所有账号启用；`ui-chat` 硬依赖 `ui-sidebar-right`，右栏关不掉。
6. **postMessage 桥**（`runtimeUiBridge.mjs:8-30`，`evimed.runtime-ui.<type>`，每条带 version/frameId/projectId/seq）：外壳→内核 `navigate · resume · theme · run-state · evidence · kb-result · reply-check · capability · geo · vcr · search`；内核→外壳 `booted · ready · connecting · error · ack · session · shell-navigate · shell-shortcut · open-artifact · save-to-knowledge-base · kb-query · bind-capability · geo-options · vcr-options · search-result`。内核页没有任何会话/令牌，所有数据由外壳读后推入。

| 文档要求 | 实际由谁渲染 | 可调手段 | 对文档的含义 |
|---|---|---|---|
| §5.2 流式回答只在用户仍处于底部时自动跟随，向上阅读后停止并给「查看新内容」 | DSH 内核（对话滚动体；内核自带粘性回合导轨与「回到底部」按钮，见 `runtimeUiShell.mjs:176-182` 的注释） | 无已知手段。仓库只有 `[data-conversation-scroll]{overflow-x:hidden}` 与 `[class$="_scroll"]:has(> [data-chat-flow]){overflow-x:clip}`（:181-182）；语言包没有相关键。内核客户端源码不在仓库，**无法核实**它是否「仅在底部时跟随」以及按钮叫什么 | 改写为「对话内滚动跟随沿用内核行为」，或作为向上游提出的需求；不得写进外壳验收 |
| §5.2 新动态进入时显示可点击更新提示 | 外壳 React（`FrontierFeed.tsx:67-69`「有 N 条新的」） | 全权 | 只适用前沿动态；对话里没有 |
| §6.2 输入区：当前项目、已选材料、提交动作；材料为可移除条目 | 内核输入框 + 外壳 slot 占位 | `conversation.composer.dock`（工具标签）、`conversation.hero.agentPreset`（空白会话的工具标签+示例）、`conversation.input.left`（上传）、`conversation.input.attachments`（接管但「原样保留内核 props」）、`@` 触发源；语言包键 `conversation.input.upload/commands/send.queue`、`placeholder.hero/default/workspace`、`hero.headline/preview` | 项目名**不在**输入区；没有「开始研究」「生成草稿」；材料条目、移除、失败重试是内核附件栏的 |
| §6.2 上传中 / 上传失败 / 已上传但尚未读完 | 内核附件栏；上传走 `__DSH_FILE_UPLOAD__` 载体，仅限 `/api/session/uploadFileBinary`，单文件 ≤50 MiB | 外壳只能限路径与大小；Fetch 无进度，只显示「发送中」（`runtimeUiTransport.mjs:306-310`；`config.mjs:1834`） | 「尚未读完」没有数据来源；图片附件的文件名只在 aria-label 里（记忆条目 chat-attachments-need-five-things），「长文件名可完整查看」做不到 |
| §6.3 澄清：聚合问题、可选答案 + 自由输入 | 内核 `ask_user_question` 视图（仅当 `OPEN_SCIENCE_RUNTIME_ASK_USER` 开，默认关） | 可在 `tool.call.toolview` 以该键接管（须低于内核条目） | 默认只有正文提问；设计不能假设有结构化提问卡 |
| §6.5 审批 / 弹窗 | 内核；托管策略 `never` | — | 没有审批弹窗，越界即拒绝 |
| §7.2 提交尚未确认：输入仍保留、防重复点击、失败后重试 | 内核输入框（发送/排队/插话） | 语言包只有 `input.send.queue`（「排队发送 · Ctrl/⌘+Enter 插话」）；外壳无法介入发送流程 | 无法在仓库内核实内核在提交未确认时是否保留输入；外壳不能补这一态 |
| §7.2 对话内的「正在工作」「失败」「重试」行 | 内核对话行 | 语言包：`chat.deepDiving`「EviMed 思考中…」、`message.retry.*`（「正在重试…」「已重试」「已取消重试」）、`message.maxTokens`/`.hint`、`message.failure.auth`、`subagent.*`、`workspace.status.subagentsRunning.*`；内核工具行状态词 运行中/失败/已停止（取自 0.1.5 清单 `docs/ui-ux-audit/2026-09-18-review/A-kernel-native-ui-inventory.md`，0.1.7 未复核） | 状态词的措辞可调、结构不可调；「最近可观察的有效变化」要靠外壳推 `run-state` 再由 evimed 工具行显示 |
| §7.2 连接断开 / 重连 | 外壳（封面+告警+租约续期）+ 内核自己的 `connecting`/`error` 消息 | 全权（外壳） | `RuntimeUiFrame.tsx:1097-1101`；封面不透明，盖住对话 |
| §7.2 取消 | 内核输入框的停止（`session/cancel`）+ 外壳侧栏 ⋯「停止」 | 外壳菜单可调 | 两个入口都停同一运行 |
| §7.3 / §7.5 过程视图、行动历史 | 内核 `conversation.view` 的 trajectory「运行」页签（时间总览 + 逐步账本 + 记录检查器）+ 折叠过程行「N 次工具调用 · M 个子任务」 | 页签名 `trajectory.view.trajectory`=「运行」；`message.turnProcess.subagents.*`=「子任务」；面板启停表（`ui-trajectory` 未禁用） | 「工程日志留在诊断入口」与现状不符；藏掉「运行」是新决定，且帧数据仍会到浏览器（隐藏只是装饰性） |
| §7.4 重新发起 vs 继续 | 内核没有断点恢复；长度上限提示「发送“继续”接着写」是内核行 | 语言包 + 外壳按钮 | 外壳能控的只有「重试 / 重新连接 / 新建对话 / 查看已有成果」 |
| §7.4 运行环境不可用时仍显示历史消息 | 内核会话库（需运行环境）；账本不存回复正文 | 无 | 不可行，须新数据契约（见 A04） |
| §8.1 依据浮层 | **外壳 React**（`ReportReader`/`ClaimCitation`），不在内核 | 全权 | 完整的三层引用只在报告阅读器。对话里的回答没有逐句座位（内核 markdown 组件不给钩子），只有回答下方的来源卡（-3，可展开引文并「在报告中查看」）、复核行（-1，仅有问题时出现）、文件卡（-2） |
| §8.1 / §8.4 交付文件如何打开 | 文件卡是内核 slot 里的 EviMed 组件；点击**优先**走内核原生预览 `sidebarRight.openResource(dsh-resource://file/session/<id>/<path>)`，原生不可用才回退到外壳阅读器（`runtimeUiPanels.mjs:245-254`） | `ui-sidebar-files` / `ui-sidebar-documentpreview` 启用 | 从对话卡片打开报告，默认看到的是内核预览（没有 ✓/⚠ 依据标记）；要看依据须从来源卡「在报告中查看」或收件箱/定时任务的链接进入外壳阅读器。设计里必须写明「报告有两个阅读面」 |
| §8.4 局部修改 | 选中与版本在外壳；「描述改动」在内核输入框；`resultRevision` 引用由传输层附到 `session/prompt` | `RuntimeUiIntent.resultRevision` + 桥的 `setDraft` + `__EVIMED_RESULT_REVISION__.stage`（`runtimeUiTransport.mjs`、`runtimeUiBridge.mjs:121-128`） | 「描述改动」这一步必然发生在内核输入框；外壳无法内联给「候选修改」，只能事后在版本面板比较 |
| 文件卡（§7.2「工作结束」、§8.5） | 内核 slot 里的 EviMed 组件：交付文件按类型排序，最多先显示 4 个，其余「显示全部 N 个文件」；每张卡有「存入知识库」 | `runtimeUiPanels.mjs` 的 `fileCardsModel` | 只在该次运行的最新回合末尾出现（`turnCarriesRun`） |
| §10 / 主题与深色 | 令牌层（颜色、字体）+ 外壳 `theme` 消息 | 几何（圆角/间距）无令牌族，只靠 `shellStylesheet` 的隐藏/摆放；EviMed 自绘卡片用内联样式照抄壳几何（`runtimeUiStyles.mjs`） | §10.3 的圆角/间距规则不能约束内核自绘部分 |
| §18.4 文案与本地化 | 语言包 `zh-x-evimed` | 以键为单位覆盖，未覆盖的键仍是内核 `zh` | 不能「批量替换」；每条要改的文案须先确认内核键名 |
| §19.1 对话内无障碍 | 内核；外壳只管 iframe 名称与焦点交接（`RuntimeUiFrame.tsx:1024-1028,1105`） | 无 | 对话内的键盘/读屏项无法由外壳测试验收，只能真机探测 |
| §3.5 快捷键 | 外壳；帧内的 Ctrl+B 与 ? 经 `shell-shortcut` 转发（`RuntimeUiFrame.tsx:764-775`） | 封闭词表 | 其余按键归内核 |

## 4. 验收案例 A01–A16 可行性（L854-873）

分类：**今日可测**（写明用什么测）/ **需要新数据契约** / **被内核框阻塞** / **需要新实现（非契约）**。已有的自动化手段：vitest（`apps/web`，`pnpm test`）、服务端 `node --test`（`apps/server/test`）、ui-walk（`scripts/ops/ui-walk.mjs`，发布后只读走查，桌面 1512 与手机 390 两个视口，另有风格预算）、组件陈列截图比对（`scripts/ops/gallery-shot.mjs`，浅/深色各一份基准）、真机验收脚本（`scripts/ops/*-acceptance.mjs`、`hosted-production-e2e.mjs`）。

| 案例 | 今日能不能测 | 要补什么 | 备注（含对通过条件的建议） |
|---|---|---|---|
| A01 从事件发起深入研究 | 文本级今日可测：vitest `components/frontier/frontierText.test.ts:184`（草稿含标题/来源/原文链接/标识）、`FrontierCard.test.tsx`、`RuntimeUiFrame.test.tsx`（意图只发一次、草稿不提交）；ui-walk 只点开菜单/抽屉，不点「深入研究」 | 对象级需新契约：若要求对话里保留「可点回事件的对象引用」，`RuntimeUiIntent`（`lib/runtimeUiNavigation.ts:4-11`）要加对象引用字段，内核侧要有 slot 渲染它（如 `conversation.chat.node` 的用户行） | 现状「原事件」只是草稿里的文字；「当前项目」不在输入区显示。通过条件建议写成「草稿含事件标题、来源链接与标识，输入框不自动发送」 |
| A02 阅读报告并查看某条依据 | 弹层部分今日可测：`ReportReader.test.tsx:213`（`focusClaim` 自动聚焦并打开依据）、`ClaimCitation.test.tsx`（引文、来源、PICO/确定性）。**返回后阅读位置会失败**：弹层关闭焦点回到「依据」标记（Radix 默认），但点「定位原文」是路由跳转，返回后阅读位置不恢复（阅读页无滚动记忆，`lib/scrollMemory.ts` 只用于文件预览；`RunFilePage` 的滚动容器是内部 `overflow-y-auto`） | 需新实现（非契约）：阅读位置恢复 | 被内核框部分阻塞：从对话文件卡打开报告默认是内核原生预览，没有依据标记（见第 3 部分『交付文件如何打开』一行）；A02 只对外壳阅读器成立，入口应写明「来源卡『在报告中查看』/收件箱/定时任务链接」 |
| A03 任务运行时刷新或离开再返回 | 外壳层今日可测：vitest `RuntimeUiFrame.test.tsx`（续租不替换原生文档、不重放导航：:125；意图只发一次、确认后清除）、`useFrameRunBinding`（`lib/runtimeUiBridge.ts`，重新读 `run/state`）；真机 `hosted-production-e2e.mjs` | 无 | 「不重复提交」在外壳层成立（草稿从不提交，会话 id 幂等）；刷新后内核输入框草稿与排队消息是否保留属于内核，**无法核实**。发布会回收运行时、终止在跑的运行（记忆条目 release-kills-running-runs），验收要避开发布窗口 |
| A04 任务断连后执行恢复动作 | 外壳部分今日可测：`RuntimeUiFrame.test.tsx`（续租退避、「重新连接」）；ui-walk 的对话清理封面（`OPEN_SCIENCE_WALK_CHAT=1`） | 「运行环境不可用时仍显示历史消息」需新数据契约（账本存回复正文，或脱机会话库） | 被内核框阻塞：任务失败后的恢复由内核失败行承载，R11 没有「重新发起」按钮。建议把通过条件改成「连接失败显示『重新连接』且不改变运行；『重试』=重新打开对话；任务失败由内核行呈现」 |
| A05 有成果但部分检查未通过 | 今日可测：服务端交付测试（交付带 `verification:"unverified"`，`agentRuns` 相关用例）、`ReportReader.test.tsx`（「⚠ N 条待核对」、安全块）、domain 的 `claimVerification` 用例 | 非逐句质量提示（MUST FIX/advice）没有生产界面（B31/B43），要「就近显示」须新增前端渲染 | 现状「真实问题就近显示」只对逐句核对与安全结论成立 |
| A06 切换项目且旧请求稍后返回 | 今日可测：vitest `app/layout/AppShell.projectSwitch.test.tsx:81-109`（无刷新重挂载、旧地址不在新项目下挂载、切换被拒时页面不动）；页面内 generation 计数 | 无 | 内核对话按项目各一个 iframe，天然隔离；草稿属内核按会话保存 |
| A07 手机关闭侧栏后连续 Tab | 今日可测：vitest `AppShell.sidebarFocus.test.tsx`（jsdom 不实现 `inert`，只断言属性与 `focus()` 目标）；ui-walk 在 390 px 检查关闭侧栏 `inert` 与前两个 Tab 停靠点（`ui-walk.mjs:738,768-770`） | 无 | 完整 Tab 序列需真机 Playwright |
| A08 在长列表打开对象，再返回 | 仅前沿动态今日可测：vitest `FrontierPage.test.tsx:1018`（页数、展开、滚动位置） | 知识库、收件箱、记忆、定时任务列表**未实现**（范围/类型/搜索只在 React state），非契约问题，需实现 | 通过条件需注明适用范围 |
| A09 表格横向滚动或查看行详情 | 今日可测：ui-walk（390 px 无横向溢出；横向滚动区必须是 Tab 停靠点或包含停靠点）、vitest `EvidenceMatrixTable.test.tsx`（窄盒变卡片、行→抽屉） | 无 | 「单位」取决于数据 |
| A10 更新来源或修改报告局部内容 | 今日可测：服务端 `resultRevisionNative`/`resultCorrection`/`resultLineage` 一组用例、web `ResultVersionInspector.test.tsx`；真机 `scripts/ops/result-revision-acceptance.mjs` | 无 | R11 没有「人工直接编辑报告正文」，"人工改动不被静默覆盖"应改述为「修改请求产生新版本，原版保留」 |
| A11 简报当天没有内容或更新失败 | 一半今日可测：vitest `components/frontier/DailyView.test.tsx`（粘性页头、往期、分类）；保留上一期并显示真实日期 ✓ | **需要新数据契约**：服务端须暴露当日状态（无内容 / 生成失败）；现在前端分不出（B61）。另：无期空态直接 `return`，没有往期菜单（`DailyView.tsx:119-120`），「可读往期」在空态下也不满足 | — |
| A12 同一 GEO 指标在概览与详情查看 | 部分今日可测：vitest `components/geo/geoOverviewModel.test.ts`（同一 `readingChange()`）、GEO 各页签用例 | 缺跨页夹具：同一快照读概览与详情并比对数值/分母/时间，没有现成用例；ui-walk 不比数值 | 讲错计数不再截断（R11 GEO-A）需服务端用例保证 |
| A13 虚拟临床研究显示阶段完成 | 今日可测：vitest `app/virtual-research/VcrStudyPage.test.tsx`、`components/vcr/vcrTabs.ts`；服务端步骤状态判定用例（R11 VCR 包）；ui-walk 走已有研究的七个页签 | 无 | 名称按 B05 改 |
| A14 切换深色、放大文字、减少动态效果 | 部分今日可测：组件级深浅色截图比对（`gallery-shot.mjs`）、令牌对比度（`packages/design-tokens/src/contrast.mjs`）、`prefers-reduced-motion` CSS（`index.css:425,614`）与图表（`components/charts/echartsBase.ts:72`） | 页面级深色走查（ui-walk 只有浅色）、200% 放大没有自动化，需手测 | 内核 iframe 内的深色走令牌层可测，但减少动态效果在内核内部**不归外壳** |
| A15 生成式视图渲染失败 | 不可测 | R11 没有生成式视图（文档 §17 是探索项）；对话内渲染还受内核 slot 限制 | 须先有功能 |
| A16 对象删除、权限撤回或模块关闭后打开旧链接 | 今日可测：ui-walk 已含 `memory-shared-missing`、`extensions-plugin-missing`、`extensions-skill-missing`、`not-found`、`account-simulated-membership／refunds`（期望 404）（`ui-walk.mjs` 的 `ROUTES`）；各页 vitest | 「权限撤回」与「已删除」不可区分（统一 404，不泄露存在性，B13）；模块关闭页只有一句话，没有按钮 | 通过条件的「有效返回」应改写为「全局侧栏可用，页内给一句具体说明」；事件/研究/回答/任务/插件/技能各有自己的失效文案 |

### 4.1 §20.2 页面覆盖矩阵（L838-850）的可行性

| 页面组 | 今日能覆盖 | 缺口 |
|---|---|---|
| 导航与项目 | 展开/收起、同名项目、项目切换失败、旧深链（重定向表）、跨项目对象（`openRunProject`）：vitest + ui-walk | — |
| 对话与任务 | 外壳层的封面/告警/重连/清理等待：vitest + ui-walk 对话清理封面 | 运行中、完成、取消、失败恢复、历史读取主要在内核帧里，外壳测不到；需真机 |
| 前沿动态 | 精选、热榜、搜索无结果、与我相关、关注空态、事件有效/失效、简报有刊/无刊：vitest | 「简报失败」无契约（B61） |
| 证据专区 | 目录、有内容主题、空主题、解读：vitest（`EvidenceZonesPage/EvidenceZonePage/EvidenceReadingPage.test.tsx`） | 「来源不可用」只有原动态下架这一种（`sourceItemLive`） |
| 知识库 | 上传、疑似重复、部分无法读取、预览失败：vitest | 「大表」「变量含义修正」（只有确认，修改在对话里）；覆盖范围 UI 未做（B67） |
| 成果阅读 | 长报告、依据浮层、引文待核对、导出、局部修改版本：vitest | 打印需浏览器 print 媒体；来源缺失只有「原文未保存」一种文案 |
| 记忆与定时任务 | 空态、冲突、过期、编辑失败、计划启停、执行历史：vitest | 「无新发现与失败的区别」无契约（B74） |
| 科研工具与扩展 | 能力选择、安装中（准备中）、不可用、项目配置、权限差异（受众开关） | 「输入不足」由输入框说，不在页面 |
| 虚拟临床研究与 GEO | 页面状态：vitest | 「有效对象」需要账户里真有研究/项目；ui-walk 只在账户有对象时才走详情页（空账户只走「一句话」页）。文档自己要求记录覆盖缺口 |
| 通知与设置 | 通知深链、保存失败、额度限制、主题、时区、数据源不可用：vitest | — |
| 边界页面 | 登录失败、404、模块未开放、服务错误（`routeError.test.tsx`）、模拟交易（两页） | 「无权限」没有对应页面（B87） |

## 5. 未能在代码树内核实、需要真机确认的点

1. 内核对话是否「仅在底部时自动跟随」、「回到底部」按钮的文案与出现条件（内核客户端包不在仓库，仓库内只有一处注释提到该按钮）。
2. 内核附件栏对失败/重试/长文件名/图片缩略图的具体呈现（只有记忆条目 chat-attachments-need-five-things 记录过图片的文件名仅在 aria-label）。
3. 0.1.7-rc.2 的内核工具行状态词（现有记录是 0.1.5-rc.2 清单：运行中/失败/已停止）。
4. 生产环境 `OPEN_SCIENCE_RUNTIME_ASK_USER` 的实际值（决定对话里有没有结构化提问卡）。
5. 文件卡点击时右栏原生座位在生产是否挂载（`sidebarRight.openResource` 成功与否决定走内核预览还是外壳阅读器）。
6. Radix Popover 关闭后焦点回到「依据」标记是库的默认行为，仓库内没有为它写专门的用例（A02 的第一半）。
7. 生产里 `features.frontier/vcr/geo` 对普通账户是否为真（默认模块开关关、GEO/VCR 受众默认只对 operator）。


<!-- DONE -->
