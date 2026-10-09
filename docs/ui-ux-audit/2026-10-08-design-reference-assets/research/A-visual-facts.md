# A. 视觉 / 版式 / 组件 / 无障碍 / 性能事实核对（针对 2026-10-08-evimed-design-reference.md v1.0）

核对基准：现行 = R11.2 工作树 `/home/coder/evimed-wt/release`（分支 `r11/ui-audit`，提交 3e52ca1f2）；文档相对链接实际解析到 `/home/coder/workspace/EviMedScience`（HEAD c1f02c3cc）的陈旧树。下文 `R11` 指前者，`陈旧树` 指后者。路径均相对 `OpenScience/`，除非另写。
令牌包版本：R11 与陈旧树 `packages/design-tokens/package.json` 均为 **2.1.2**，`src/index.mjs` 两树逐字节相同（`diff -q` 无差异）；因此第 10 节引用的"令牌数值"本身没有陈旧问题。陈旧的是**消费令牌的代码**（组件/页面）和 `DESIGN.md`：两树 `DESIGN.md` 有 3 处差异（陈旧树缺 「页面结构 (2026-10-07)」六条规则、缺 coarse-pointer 点击区加宽与 `ScrollRegion` 一段、缺 `Tabs trailing`；记忆胶囊增长线在陈旧树仍写"页面顶部"，R11 已移入"成长"标签页）。
文档整体是对着陈旧树写的：证据之一，文档 §3.2/§4.5/§15.2/§20.2/§20.3 全部使用已被业主 2026-10-07 废止的名称「虚拟临研」，陈旧树 `components/sidebar/Sidebar.tsx:83` 的侧栏标签还是 "虚拟临研"，R11 同一行已是 "虚拟临床研究"（`apps/web/src/components/sidebar/Sidebar.tsx:84`）。

判定图例：正确 / 错误 / 部分正确 / 过时:R11已变 / 无法核实。严重度：S1 = 文中声明的现行约束与代码或规则冲突；S2 = 误导或不完整；S3 = 措辞。
"目标规范"性质的句子（文档自己在 §1.1 声明不代表已实现）只在与现行规则冲突或可以指出现行机制时才列行。

**摘要（先看这里）**

S1（文中声明的现行约束与代码/规则冲突，共 4 处 + 2 处遗漏）：
1. §10.3 L474 侧栏"默认 280，收起 56"——R11 实际默认 232、可调 184–340、收起为 0（`apps/web/src/lib/store.ts:10-12`，`Sidebar.tsx:182`）；280/56 是被外壳隐藏的内核侧栏列（10.3-e）。
2. §10.3 L473 "宽视口按现有规则可至 1280"——令牌定义了 `wide-max`，但全应用无任何使用，`wide` 恒 1200（10.3-d）。
3. §5.1 L206 "小于 768 时正文侧边距 16 px"——`PageShell` 恒 `px-6`，只有报告阅读器在 640 以下改 16；768 处只有输入框 16 px 字（5.1-a）。
4. 全文把模块写成已退役的「虚拟临研」（L115/116/199/650/848/870），R11 与 AGENTS.md 规定用「虚拟临床研究」（N-a）。
5. 遗漏：2026-10-07 起的『页面结构』六条规则及其走查闸门（M01）；退役词/模块名闸门（M02）。
6. 遗漏：真正的侧栏行为（M16，与 1 同源）。

S2 要点：来源层级漏了规范 v2.1（1.1-a）；`read` 版心在 `PageShell` 里不存在，证据卡/证据专区/证据矩阵的版心与文中模板不符（4.2-a/b）；知识库已是『单列表 + 右侧抽屉』，不再三栏（4.2-b）；文中把已修复的 B02 写成待办（5.3-a）；大字 3:1、44×44、1440/768/390 三档与本平台规则/规范不一致（19.1-b/f、20.4-a）；`text-graphic` 与『已取消』圆点 2.69:1 低于 3:1（19.1-c）；通用 `DataTable` 没有排序/选择/行详情，17 处搜索框里只有 3 处接了清除（9.1-g/n）；缺失机制：ui-walk 预算、陈列页比对、`contrast.mjs`、ESLint/文案测试（M03–M09）。

陈旧树证据：本文有几处只在陈旧树里成立——模块名『虚拟临研』（N-a）、知识库三栏（4.2-b）、把侧栏 B02 当待办（5.3-a）、触屏热区尚无任何实现（19.1-f）；完整对照见 1.7。两树逐字节相同的部分（令牌 2.1.2、`index.css`、ESLint、`designTokens.test.ts`）是 §10 数值可以信赖的原因。


---

## 1. 逐条核对表

### 1.1 §1.1 规则效力 / 来源层级

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| 1.1-a | §1.1 L21 | "视觉数值以 设计令牌源文件 为唯一事实源，DESIGN.md 是现行工程说明。本文不另建一套颜色、尺寸或组件令牌。" | 部分正确 | 令牌表唯一事实源：`DESIGN.md:8` "The table is index.mjs, and nowhere else"；DESIGN.md 自述为工程摘要并"defers to it [the full spec] and to the table"（`DESIGN.md:11-12`）。设计规范 v2.1 正文（`docs/superpowers/specs/2026-09-26-design-system-assets/build/combined.md`，未入库）第 48–57 行的层级表规定：数值以令牌表为准、**规则以规范正文为准**、DESIGN.md 与正文不一致时改 DESIGN.md。本文第 1 节与第 22 节均不提规范 v2.1；§10 又整表重述了数十个数值，与"不另建"的自我约束相悖（虽标注为快照）。DESIGN.md:12 写的是 "v2.0, 2026-09-26"，规范已于 2026-09-27 升至 2.1（combined.md:18-20，令牌 2.1.1），DESIGN.md 自己也陈旧。 | "视觉数值以设计令牌源文件为唯一事实源；视觉与交互规则的正文是《EviMed 前端设计规范 v2.1》（`docs/superpowers/specs/2026-09-26-design-system-assets/`，2026-09-27 发布，未入库）；`DESIGN.md` 是二者的工程摘要，冲突时先改 DESIGN.md。本文是产品层面的设计参考，不新增令牌、数值或组件规则；与上述三者冲突时以它们为准。" | S2 |
| 1.1-b | §1.1 L15–19 | "现行约束：已写入项目规则、设计系统或产品契约的要求……不代表全部页面已经符合" | 正确 | 该免责声明恰好适用于下列多处"现行约束"与代码不符的地方（见 4.1-a、4.2-a、5.1-a、10.3-d、10.3-e），但文档没有标出哪些不符，读者会把它当作可直接验收的规则。 | 在每条"现行约束"后注明执行机制或"尚未落实"（见第 2 部分清单）。 | S2 |

### 1.2 §4 页面布局 与 §5 响应式、滚动与焦点

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| 4.1-a | §4.1 L154 | "现行约束：使用 PageShell；标题、操作区与主体共享左边界。" | 部分正确 | 规则：`DESIGN.md:276-279`；实现：`apps/web/src/components/layout/PageShell.tsx:62-72`（标题、操作、正文同在一个 `mx-auto w-full px-6 py-6 max-w-*` 盒子里）。不是所有页：`app/routes/GeoAnswerPage.tsx:82`、`app/routes/FrontierEventPage.tsx:137` 手写同款盒子；`app/routes/RunFilePage.tsx:187`、`components/report/ReportReader.tsx:305` 用已退役别名 `max-w-content-full` 且 `max-sm:px-0`；`app/routes/HandoffRoute.tsx:63` 为 `max-w-read px-6 py-12`。R11 的 PageShell 新增 `back` 槽（标题上方的返回链接，`PageShell.tsx:39-70`），陈旧树没有。机器检查：`scripts/ops/ui-walk.mjs:561-564`（桌面 1512 px 下页面块/列表行标题多于一条左边界即失败，`PROVISIONAL_PAGES` 仅告警，ui-walk.mjs:571）。 | "页面使用 `PageShell`：标题、操作区与正文在同一栏内、同一条左边界（页边距 24 px）；下钻页用 `back` 槽在标题上方放返回链接。`ui-walk` 在 1512 px 桌面视口检查页面块与列表行标题的左边界。" | S2 |
| 4.1-b | §4.1 L154 | "页头为单行标题，可附灰色数量或更新时间，最多一个主要按钮与两个图标操作，或一个搜索框。不得添加解释系统机制的副标题。" | 部分正确 | 文字与 `DESIGN.md:281-283` 一致。但 R11 新增的 页面结构 第 3 条（`DESIGN.md:358-359`）是 "title, the scope and at most one primary button — and a search box"：搜索框与主按钮**可以并存**，R11 知识库页头就是搜索框 + 实心「添加」按钮（`app/routes/SourcesPage.tsx:345-346`），插件与技能页头同（`app/extensions/ExtensionsPage.tsx:143`）；文档的"或"与此相反。结构保证：`PageHeader.tsx:25-49` 没有副标题位置（`description` 仅留在类型上、不渲染）。机器检查：`ui-walk.mjs:553/1485`（页头内出现 `<p>` 即失败）、`:554/1453-1455`（页头内多于一个 `bg-accent` 控件即失败）；"两个图标按钮"的上限无任何检查。 | "页头为单行：标题，可附灰色数量、范围或更新时间；右侧至多一个主要按钮（实心强调色），可同时有搜索框，或另加至多两个图标按钮。`PageHeader` 没有副标题位置；`ui-walk` 对页头里的段落和第二个实心强调色按钮判失败。" | S2 |
| 4.2-a | §4.2 L168–176 | 阅读型 → "`read`"；"`read`、`page`、`wide` 的当前数值见第 10 节" | 过时:R11已变（与 DESIGN.md 意图也不符） | 数值正确（`packages/design-tokens/src/index.mjs:672-684` read 720 / page 1040 / wide 1200）。但 `PageShell` 的宽度类型只有 `page \| wide \| full`（`+ 已退役的 narrow/content → page`，`PageShell.tsx:33,68`），**没有 `read`**；全应用 `max-w-read` 只出现在 `app/routes/HandoffRoute.tsx:63` 与 `/__gallery`。报告阅读器用退役别名 `max-w-content`（=720，`components/report/ReportReader.tsx:320,336,344`）套在 `max-w-content-full`（=1040）外壳里；证据卡阅读页（`app/routes/EvidenceReadingPage.tsx:181-183`，DESIGN.md:261 把"evidence card"列在 read）、事件页、GEO 答案页都在默认 `page`（1040）栏里，正文靠 `max-w-measure(-body)` 限行宽；证据专区（DESIGN.md:263 列在 wide）`EvidenceZonesPage.tsx:155`、`EvidenceZonePage.tsx:187` 也没传 `width`，是 1040。陈旧树同。 | 表中加一列"现状"，或改写为："阅读型：设计意图为 `read` 720（`PageShell` 尚无 `read` 档，报告阅读器经退役别名 `max-w-content` 取得 720；证据卡/事件页目前在 `page` 栏内用 `max-w-measure-body` 640 限行宽）。" | S2 |
| 4.2-b | §4.2 L173, L198 | 材料工作区 "知识库、证据矩阵 \| `wide`；集合、对象、预览分区 \| 三栏仅在可读时并列"；§4.5 知识库 "集合与资料列表、所选资料预览" | 过时:R11已变 | R11 知识库 `PageShell width="wide"`（`SourcesPage.tsx:340-342`）但内容是**单一列表** `List` + `FilterChips`（资料类型）+ 页头 `meta` 里的范围菜单，资料详情在右侧 `SourceDrawer`（`SourcesPage.tsx:358,373`）——页面结构 第 2 条"Detail opens in the right-hand drawer"（DESIGN.md:356-357）。不再有"集合 \| 列表 \| 预览"三栏（陈旧树 `SourcesPage.tsx:345` 仍有左侧 rail）。证据矩阵页 `RunFilePage.tsx:187` 是 `max-w-content-full`=1040，不是 wide。DESIGN.md:263 仍写"the three-column knowledge base"，也已陈旧。 | "知识库：`wide` 栏内一张资料列表（类型筛选行 + 搜索 + 添加），点开一份资料在右侧抽屉里读；不并列多栏。证据矩阵目前在 `page` 栏。" | S2 |
| 4.2-c | §4.2 L171–172 | 列表型 → `page`（前沿精选、工具、收件箱、扩展、记忆）；数据型 → `wide`（GEO 指标、研究结果总览） | 正确 | `PageShell` 默认 `page`（`PageShell.tsx:48`）：`FrontierPage.tsx:687`、`CapabilitiesPage.tsx:154`、`InboxPage.tsx:233`、`ExtensionsPage.tsx:143`、`MemoryHubPage.tsx:291` 均未传宽度；`GeoProjectPage.tsx:180-184`、`VcrHomePage.tsx:121`、`VcrStudyPage.tsx:228` 传 `width="wide"`。 | — | — |
| 4.3-a | §4.3 L180 | "在 1440 × 900 桌面和 390 × 844 手机视口中，普通列表页应在无需滚动时看到至少一条可理解的内容及其主操作" | 部分正确（目标条件，文档已声明；但与唯一的自动化视口不一致） | 唯一的线上走查 `scripts/ops/ui-walk.mjs:169-170` 的视口是**桌面 1512 × 945**（"the owner's screen"）与手机 390 × 844；没有 1440 × 900，也没有平板。首屏相关的机器检查很少：前沿手机首条标题顶部 > 520 px 只告警（`ui-walk.mjs:997`）、GEO"不能下单"一句须在首屏（失败，`:986`）、GEO 进度条不得占首屏（失败，`:983`）。`gallery:shot` 用 1280 宽（`scripts/ops/gallery-shot.mjs:83`）。 | 把视口写成："桌面 1512 × 945（业主屏幕，`ui-walk` 基准）与 1440 × 900、手机 390 × 844"；并注明首屏条件目前只有上述个别页面有自动检查。 | S3 |
| 4.4-a | §4.4 L188 | "通过间距表达分组，再使用背景差异，最后使用边线。现行规则限制至多一层带边框的容器嵌套" | 正确（不完整） | `DESIGN.md:251-252`（"Separate by space first, then a quiet ground, and draw a line last"）、`:290-291`（"at most one bordered container deep, and no rule under a card's title"）。遗漏"卡片标题下不加分隔线"。没有任何测试直接测"嵌套深度"；间接的只有 `ui-walk` 的边框种类上限（≤3 种，数据页 3、GEO 项目 6、扩展 5：`ui-walk.mjs:205,221,232,258`）与 ESLint 禁止组件库之外手写带边框胶囊/按钮（`apps/web/.eslintrc.cjs:73-95`）。 | 补一句："卡片标题下不加分隔线；`ui-walk` 以'边框种类 ≤3'（数据页同为 3，GEO 项目页 6，扩展页 5）间接约束。" | S3 |
| 5.1-a | §5.1 L206 | "断点为 640、768、1024、1280、1536 CSS px；小于 1024 时全局侧栏使用覆盖式抽屉；小于 768 时正文侧边距 16 px。" | 部分正确 | 断点与 <1024 抽屉：正确（`index.mjs:784`；`Sidebar.tsx:179` `max-lg:fixed … max-w-[85vw]`；`AppShell.tsx:184` 遮罩 `lg:hidden`；Esc 关闭 `AppShell.tsx:82-92`）。**"<768 → 16 px" 在代码里不存在**：`PageShell.tsx:68` 在所有宽度恒为 `px-6`（24）；全应用无任何 `md:px-*`/`max-md:px-*`（grep 为空）；报告阅读器在 **640** 以下才改 `max-sm:px-4`（`ReportReader.tsx:257,321,336`），外层 `max-sm:px-0`。唯一的 768 分界在输入框：`max-md:text-body`（<768 输入文字升 16 px，防 iOS 聚焦放大，`components/ui/Input.tsx:26`）。DESIGN.md:445-446 同句，两树一致，代码从未落实（对话内核框内会话栏的边距由内核自己的 CSS 决定，本次未核）。机器检查：只有"手机 390 px 页面不得横向溢出"（`ui-walk.mjs:555`）。 | "断点为 640、768、1024、1280、1536 CSS px；小于 1024 时全局侧栏变为覆盖式抽屉（至多 85% 视口宽，Esc 关闭，关闭后 `inert`）；`PageShell` 页边距固定 24 px，报告阅读器在 640 px 以下用 16 px；小于 768 时输入框文字为 16 px；390 px 下任何页面不得横向滚动（`ui-walk` 检查）。" | S1 |
| 5.1-b | §5.1 L214 | 宽表 "表头固定，必要时冻结标识列 \| 表内横向滚动并有提示" | 部分正确 | `components/ui/DataTable.tsx:6-23,124-137,174,194`：粘性表头 `sticky top-0`；第一列为 `rowHeader` 时冻结；横向滚动容器是 `ScrollRegion`（溢出时才成为带名称、可聚焦的 `role=region`，`ScrollRegion.tsx:43`），R11 DESIGN.md:301-302 已写入，陈旧树 DESIGN.md 没有。"提示"（滚动提示）只有 Tabs 行有末端渐隐（`Tabs.tsx:42-50`），表格没有。机器检查：横向滚动区域必须可聚焦或含可聚焦子元素且有名称（`ui-walk.mjs:740-743` 失败）。 | "宽表：表头固定；作为行标题的首列冻结；横向滚动区是带名称的可聚焦区域（`ScrollRegion`），溢出才进 Tab 序列。" | S3 |
| 5.1-c | §5.1 L211 | 报告依据：桌面 "与正文并排，或非遮挡面板"；手机 "打开单层阅读抽屉，关闭回到原结论" | 部分正确（目标布局，与现行实现不同） | R11 的『依据』是**点击打开的非模态弹出层**（`components/markdown-viewer/ClaimCitation.tsx:248`：`w-96`(384) `max-h-96`、`rounded-card`、`shadow-pop`(=e2)、`z-50`），不是并排面板，也不是抽屉；规范 v2.1 §23.1 L2640 同："非模态弹出层，宽 360～400"，长内容（整段证据）才进抽屉或详情页（§22.8 L2577）。`z-50` 低于令牌规定的 popover 层 60（令牌注释 `index.mjs:759-767` 明说引用卡在 60）。 | 把表中此行标为『目标』，并注明现行形态是点击出的非模态弹出层；弹出层的 z 层应为 `z-popover`。 | S3 |
| 5.3-a | §5.3 L231 | "不得仅将隐藏侧栏宽度设为零却保留内部可聚焦元素。2026年10月7日审查 B02 发现过此类问题；验收应直接测试关闭状态下的完整 Tab 路径" | 过时:R11已变 | R11 已修：折叠侧栏 `aside[aria-label=侧栏]` 带 `inert`（`Sidebar.tsx:165-171`），折叠后焦点回到"展开侧边栏"按钮（`AppShell.tsx:94-109`），测试 `app/layout/AppShell.sidebarFocus.test.tsx`；上线走查：折叠侧栏不 inert 即失败（`ui-walk.mjs:738`），390 px 下前两个 Tab 停靠点不得在侧栏内（`ui-walk.mjs:774-778`，**只测前两个停靠点，不是完整 Tab 路径**）。文中说法把已修复项写成待办、把 R11 已有的机器检查写成空白。 | "折叠的侧栏必须 `inert`、移出 Tab 序列（R11 已落实，`ui-walk` 检查 inert 与 390 px 首两个 Tab 停靠点）；设计验收仍应完整走一遍关闭状态下的 Tab 路径。" | S2 |
| 5.3-b | §5.3 L227–229 | "关闭最上层后恢复到触发控件……Escape 关闭当前可关闭层，不连续退出整个工作流" | 正确 | `components/ui/Drawer.tsx:55-71`（恢复触发控件、Esc `stopPropagation`、内嵌模态层优先）、`ConfirmDialog.tsx:66-70`（初始焦点在取消）、`Tooltip.tsx` 捕获阶段先吃掉 Esc。注意 `Drawer` 在无障碍上是**模态对话框**（`role=dialog aria-modal=true` + 焦点陷阱 + 遮罩 `bg-scrim`，`Drawer.tsx:80-86`），"抽屉用于保持背景的对象阅读"只能理解为"视觉上保留背景"。 | 可补："抽屉与对话框同为模态层：焦点陷阱、Esc 关闭、关闭后回到触发控件。" | S3 |

### 1.3 §9 组件与通用交互（表在下方续）

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| 9.1-a | §9.1 L372 | "现行约束：复用现有 components/ui、布局组件和状态组件。交互控件具备默认、悬停、按下、键盘焦点、禁用和加载状态；存在校验的控件另有错误状态。列表页面具备加载、空、错误和内容四种状态。" | 正确（缺执行机制） | `DESIGN.md:395-397`、`AGENTS.md:177-179`。三个目录：`apps/web/src/components/ui/`（约 30 个原语）、`components/layout/`（PageShell/PageHeader/PageTitle）、`components/cards/`（EmptyState/LoadError/Skeletons）。机制：ESLint 在 `components/{ui,layout,cards}` 之外禁止手写带边框胶囊与带边框 `<button>`（`apps/web/.eslintrc.cjs:72-95`，`componentRules` 只挂在第一个 override 上（`:153`），原语目录的 override 不含它（`:166`））；`/__gallery` 画 18 行原语（Button、IconButton、Tooltip、Input/SearchInput、Tag、Tabs/Segmented/FilterChips、Switch/Disclosure/Menu、ListRow/RunStatusDot、StatTile/Delta、ChartCard、DataTable、Citation、SeverityBadge、ProgressRail、Skeleton/EmptyState/LoadError、Dialog、Drawer、Toast，`apps/web/src/test/__screenshots__/gallery.png.rows.json`），CI 任务 `gallery` 浅/深各比对一次（`.github/workflows/web.yml:353-420`）。 | 在句末补："`/__gallery` 陈列全部原语的全部状态，`pnpm gallery:check` 浅色、深色各比对一次，像素差异超过 0.5% 失败；ESLint 拒绝手写带边框的胶囊与按钮。" | S3 |
| 9.1-b | §9.1 L374–388 | 组件表 13 行（Button … EmptyState） | 部分正确（不全） | R11 `components/ui` 另有表中未列的现行原语：`Tag`（22 高、12 px、圆角 6、不可点击，`Tag.tsx`）、`List/ListRow`（整行可点、至多两个常显操作 + ⋯，`ListRow.tsx`）、`Panel/PanelRow`、`Switch`、`SegmentedControl`、`Card`、`StatTile/Delta/ChartCard`、`ProgressRail`、`SeverityBadge`、`FormDialog`、`ScrollRegion`、`navItemClasses`（36 高导航行）；`DESIGN.md:319-340` 的组件表即这些。表里的 Tabs 缺 R11 的 `trailing` 槽（`DESIGN.md:327`，陈旧树无）。 | 补行：Tag、List/ListRow、Panel、Switch、SegmentedControl、Card、StatTile/Delta/ChartCard、ScrollRegion；或在表前加"完整清单见 `DESIGN.md` 的 The component set 与 `/__gallery`"。 | S2 |
| 9.1-c | §9.1 L376 | Button "动词和对象明确；主要动作最突出" | 正确 | `components/ui/Button.tsx:34-48`：`primary` 实心强调色（每视图一个）、`secondary` 灰底无边框、`text`、`danger` 仅用于确认不可撤销操作；**没有描边按钮**；高度 28/36/44（`sm/md/lg`）；`loading` 置 `aria-busy` 并禁用。`ghost` 是 `secondary` 的旧名。 | 补："没有描边按钮；危险红色实心按钮只用于确认框里的那一个。" | S3 |
| 9.1-d | §9.1 L377 | IconButton "图形、可访问名称和说明一致" | 正确 | `IconButton.tsx`：`label` 必填并同时作 `aria-label` 与 Tooltip；28（`sm`）/36（`md`）；图标恒 16。 | — | — |
| 9.1-e | §9.1 L378 | Tabs "当前项明确，键盘操作符合组件模式；可分享视图进入 URL" | 正确 | `Tabs.tsx:122-133`：`role=tab`、仅选中项 `tabIndex=0`、←→/Home/End；高 40（`h-10`）、`text-ui font-medium`、选中项 = 正文色字 + 2 px 正文色下划线（`border-text`），**不是强调色**；行溢出时末端渐隐（`Tabs.tsx:49`）；`?tab=` / `?view=` 进 URL（`ui-walk.mjs:119-153` 的路由即是）。 | 补："当前项用正文色加下划线表示，不用强调色。" | S3 |
| 9.1-f | §9.1 L379 | FilterChips "表示可叠加的条件或明确的单选集合" | 部分正确 | `FilterChips.tsx`：28 高、13 px、全圆、无边框，未选为纯文字、选中落在 `surface-2` 并 500；**一个主维度一行**，超过 6 个选项第 7 个起收进"更多 ▾"（`maxVisible = 6`，`:99`），其他维度用 `FilterSelect`，开/关型用 `pressed` 的 `FilterChip`。页面结构 第 5 条：至多一行视图切换、一行筛选（`DESIGN.md:363-365`）。"可叠加"只能理解为多个维度各一个胶囊。 | "FilterChips：一行一个主维度的单选；其他维度用 FilterSelect；开关型筛选用可按下的胶囊。一页至多一行视图切换、一行筛选。" | S3 |
| 9.1-g | §9.1 L380；§3.5 L146 | SearchInput "指明搜索范围，保留关键词 \| 清除可用" | 部分正确（与 R11 约定冲突） | `SearchInput.tsx:12-13`：占位文字就是它的名字，"a word, not a sentence about what can be searched"；v2.1 §18.3-2（combined.md:1972）同："搜索""搜索工具""搜索记忆"，不写长句。R11 现有 17 处 `<SearchInput>`，其中 12 处标签是字面量：搜索、搜索工具 ×2、搜索记忆 ×2、搜索任务、搜索信源、搜索研究、搜索稿件、搜索结论、搜索问题、搜索资料和内容（知识库，最长）。范围由页面标题与页头位置给出，而不是写进占位文字。**清除**：`onClear` 只接在 3 处（`app/routes/FrontierPage.tsx:700`、`app/routes/EvidenceAuthorPage.tsx:119`、`components/report/EvidenceMatrixTable.tsx:166`）；其余 14 个搜索框隐藏了浏览器自带的取消钮（`[&::-webkit-search-cancel-button]:hidden`，`SearchInput.tsx:62`）又没有替代，实际上不能一键清除。 | "搜索框占位文字即名称，一个词（搜索 / 搜索工具 / 搜索记忆），范围靠页面与位置表达；有输入时应出现「清除搜索」按钮，Esc 清空（R11 仅 3 处接线，其余为待补）。" | S2 |
| 9.1-h | §9.1 L381 | Menu "键盘移动、Escape、关闭后焦点恢复完整" | 正确 | `Menu.tsx:71,99,107,126`：箭头/Home/End、Esc（`stopPropagation`，不连带关闭下层抽屉）、关闭回到触发器；面板 `z-popover`、`rounded-card`(12)、`shadow-e2`、内边距 4、最小宽 160；**菜单项高 32**（`h-8`，不在 28/36/44 档内，v2.1 §6.7 L790 明定"32（鼠标）；触屏 44"，触屏 44 在 R11 未实现）；无子菜单。 | 补："菜单项高 32（触屏规范为 44，尚未落实）。" | S3 |
| 9.1-i | §9.1 L382 | Tooltip "不承载唯一的关键依据或长表单；触摸可获得等价信息" | 正确（缺现行参数） | `Tooltip.tsx`：悬停 300 ms 出现、键盘聚焦立即出现、离开 100 ms 消失（`TOOLTIP_DELAYS`，`:147,225`）；Esc 关闭（捕获阶段先于抽屉，`:151-165`）；指针可移到提示上（WCAG 1.4.13）；纯文字 ≤ 40 字、最宽 280（`:208`）、`z-tooltip`、渲染到 `document.body`、反色底 `bg-text text-bg`、`rounded-card`、12 px、**无阴影**；**触屏不出现**（`pointerType === "touch"` 直接返回，`:200,223`），所以"触摸等价信息"只能靠可见文字或 `aria-label`——这正是"不得只放在 Tooltip"的原因。浏览器原生 `title` 由 `app/nativeTitles.test.ts` 禁止（但扩展属性展开绕过：`components/runs/RunStatusDot.tsx:35` 仍给 `<span>` 传 `title`）。 | 补："Tooltip：悬停 300 ms / 键盘聚焦立即显示，离开 100 ms 消失，Esc 关闭，指针可移入；≤ 40 字；触屏不出现，故不得是任何信息的唯一载体。" | S3 |
| 9.1-j | §9.1 L383 | Disclosure "按钮和区域关系明确，展开状态可被辅助技术识别" | 正确 | `Disclosure.tsx`：原生 `<details>/<summary>`，"全产品只有这一种折叠"（v2.1 §22.9 L2596）。 | — | — |
| 9.1-k | §9.1 L384 | Drawer "适应窄屏；有标题、关闭入口和可预测的返回" | 正确 | `Drawer.tsx:55-71,80-100`：右侧整高面板、默认 `max-w-xl`（576）、手机 `w-full`；标题 24/600、一行说明、36 px 关闭钮；模态（`role=dialog aria-modal`、焦点陷阱、遮罩点击/Esc 关闭、关闭后回到触发器）；`z-drawer`；`shadow-e3`；**无圆角**（见 10.3-f）。页面结构 第 2 条规定"详情开在右侧抽屉里，列表留在原处"（`DESIGN.md:356-357`）。 | 补："详情默认在右侧抽屉打开，列表保持原位（页面结构 第 2 条）。" | S3 |
| 9.1-l | §9.1 L385 | ConfirmDialog "危险操作初始焦点在取消" | 部分正确 | `ConfirmDialog.tsx:66`：初始焦点在「取消」，**两种 `tone`（danger / primary）一律如此**，不限于危险操作；Enter 只由获得焦点的按钮响应；`busy` 时确认钮禁用且对话框不可关闭；宽 400、`rounded-panel`、`shadow-e3`、`z-modal`；`role=alertdialog`。 | "确认框的初始焦点一律在取消；`busy` 期间不可关闭，防止重复提交。" | S3 |
| 9.1-m | §9.1 L386 | Toast "重要错误同时留在上下文中，不依赖短暂提示" | 正确（缺现行参数） | `lib/toast.ts:31,40-42`、`Toaster.tsx:22,51-57`：成功 5 s、带操作 10 s、**错误不自动消失**（`TOAST_DURATIONS.error = 0`）；同时至多 3 条；悬停/聚焦暂停计时；底部居中距底 24；最小高 36；`z-toast`；发丝线边 + `shadow-e2`；成功 `role=status`、错误 `role=alert`。 | 补上述参数（5 s / 10 s / 错误常驻 / ≤3 条）。 | S3 |
| 9.1-n | §9.1 L387 | DataTable "单位、排序方向、选中范围、横向滚动和行详情清楚" | 部分正确（共享组件不提供排序/选择/行详情） | `components/ui/DataTable.tsx`：粘性表头、行标题列冻结、`ScrollRegion`、四态（骨架/空/错误+重试/内容）、脚注说一次分母、**整列为空则不画该列**（`drawnColumns`，`DataTable.tsx:48`）、"我方行"高亮。组件内**没有**排序、选择、行展开；全应用没有 `aria-sort`（grep 为空）。v2.1 §21.4 L2340-2343 写了这三项，R11 未实现。 | "DataTable 现有：表头吸顶、行标题列冻结、可聚焦的横向滚动区、四种状态、分母脚注、整列为空自动隐藏；排序、批量选择、行详情是规范（v2.1 §21.4）要求但共享组件尚未提供。" | S2 |
| 9.1-o | §9.1 L388 | EmptyState "说明当前为何没有内容并给下一步" | 正确 | `components/cards/EmptyState.tsx`：20 px 图标 + 一句（`text-ui font-medium`）+ 可选说明（`text-caption`）+ 可选一个操作；`DESIGN.md:336` "an icon and one sentence; no button the header already has"，v2.1 §22.9 L2589 同——"给下一步"不得重复页头已有按钮。 | 补："不重复页头已有的按钮。" | S3 |
| 9.1-p | §9.1 L390 | "真正改变位置的导航使用链接；改变当前状态的动作使用按钮。" | 正确 | `Sidebar.tsx:293-299`（`NavRow` 是 `<Link>`，注释 U10）、`ListRow.tsx`（标题为链接/按钮并铺满整行）；v2.1 §27.1-3 L3068。 | — | — |
| 9.2-a | §9.2 L394 | "标签始终可见，placeholder 只提供格式或例子。" | 部分正确 | 字段：`Input.tsx` 的 `label` 在控件上方、`text-ui font-medium`、间距 8（v2.1 §18.1 L1930）。例外：搜索框的占位文字就是它的名字（见 9.1-g）。`Input` 在 `<768` 为 16 px 字（`max-md:text-body`，`Input.tsx:26`），防 iOS 聚焦放大——这是 §10.2 "ui 14 px" 的一个现行例外。 | 加例外："搜索框以占位文字为名；输入框文字在 768 px 以下为 16 px。" | S3 |
| 9.3-a | §9.3 L402 | "数字右对齐并采用等宽数字；……排序标记不依靠颜色" | 正确 | `index.css:557-560`（`table, .tabular-nums { font-variant-numeric: tabular-nums }`）；`DataTable.tsx` `align="right"`。排序标记见 9.1-n（未实现）。 | — | — |
| 9.3-b | §9.3 L406；§5.1 L214；A09 | "证据矩阵在手机上优先保留结论、来源入口和核查状态，其余字段可进入行详情"；宽表手机"重要字段提供行详情" | 正确（R11 已对证据矩阵实现，通用 DataTable 未实现） | `components/report/EvidenceMatrixTable.tsx:28-60`：按**自身容器宽度**（不是视口）切换——盒宽 < 640 变『卡片列表』，回到表格要 ≥ 672（防抖，`TABLE_MIN_WIDTH/TABLE_RETURN_WIDTH`）；初值按 `(max-width: 767px)`；『核对』是第二列，永不在屏幕外；点一行在抽屉里看 PICO、每条引文原文及其在来源中的位置（`EvidenceMatrixDrawer.tsx`）；搜索框『搜索结论』带清除（`:166`）。走查：`ui-walk.mjs` 的 `walkMatrix` 点行开对话框、Esc 回焦点（`ui-walk.mjs:1291-1305,1635-1660`），页面名 `evidence-matrix` 按数据页预算（暂列 `PROVISIONAL_PAGES`）。该页本身在 `RunFilePage`（`max-w-content-full`=1040）。 | 在 §9.3 加一句"证据矩阵：容器 < 640 px 变卡片列表，行详情在抽屉里"；DataTable 本身不含行详情。 | S3 |
| 9.4-a | §9.4 L421 | "加载布局应接近最终结构；已经显示的有效内容不因后台刷新变回整页骨架。" | 正确（缺现行措辞规则） | `components/cards/Skeletons.tsx`（36 px 行高与真实行一致）；`DESIGN.md:392` "a skeleton, never a spinner where a skeleton fits"。**现行文案规则被省略**：状态词"正在 + 动词"、不带省略号，禁用"加载中/处理中/思考中"，引号用 “” 不用 「」，均由 `app/copyRules.test.ts:99-127` 检查。 | 在 §9.4/§18.4 加："状态写成『正在读取……』的短语时不加省略号，不写『加载中』『处理中』；引号用 “ ”，不用「 」。（`copyRules.test.ts`）" | S2 |

### 1.4 §10 视觉与排版

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| 10.0-a | §10 L425 | "本节为现行设计系统的引用快照，基于 design-tokens 2.1.2。" | 正确 | `packages/design-tokens/package.json:3` 与 `src/index.mjs:53` `DESIGN_TOKENS_VERSION = '2.1.2'`，`src/release.json` 记录同版本的产物摘要；R11 与陈旧树的 `index.mjs` 逐字节相同。规范 v2.1 正文仍写令牌 2.1.1（combined.md:20）。 | — | — |
| 10.1-a | §10.1 L429 | "浅色 accent 为 `#0a5dc1`，深色使用其已定义角色值。提供浅色、深色与跟随系统；首次绘制前应用主题，避免闪白。" | 正确 | 浅 `brand-600 #0a5dc1`，深 `brand-400 #5f97e0`（`index.mjs:250`，`index.css:145,210`）；三态 `light/dark/system`，`public/theme-init.js` 在 `<head>` 同步脚本里按 `localStorage["ai4s.theme"]` 设 `data-theme`（`index.html:23`），`ThemeProvider` 之后接管并实时跟随系统；每个主题块声明 `color-scheme`（`index.css:130,195`）。「AIHOT 的青色不进入品牌体系」也对：循证青 `#00756b` 已于 2026-09-26 退役（`DESIGN.md:50-51`）。 | — | — |
| 10.1-b | §10.1 L433 | accent："主要动作、链接、当前选择、对应核对标记" | 部分正确 | 令牌注释（`index.mjs:247-249`）：主按钮、链接、焦点环、选中行、✓ 核对标记、图表里"我方"。但"当前选择"在 R11 有三种做法：页签 = 正文色字 + 2 px 正文色下划线（`Tabs.tsx:133`，v2.1 §20.1-2 L2156 明写）；筛选胶囊 = `surface-2` 底 + 500（`FilterChips.tsx:35`）；导航行/选中行 = `accent-soft` 底 + 正文色 500（`NavItem.ts:18`）。只有 `accent-soft` 行与核对标记真正用强调色系。 | "accent：主按钮、链接、焦点环、✓ 核对标记、图表中的『我方』；选中行用 accent-soft 底；页签和筛选胶囊的选中态用中性色（正文色下划线 / surface-2 底），不用强调色。" | S2 |
| 10.1-c | §10.1 L434 | "accent-soft / strong：当前选择背景与其上的文字" | 部分正确 | `accent-soft` = "Selected rows, the current sidebar row, the verified chip. Never text"（`index.mjs:252`）；`accent-strong` = `accent-soft` 底上的文字。R11 导航行实际用 `text-text` 而非 `text-accent-strong`（`NavItem.ts:18`），与 v2.1 §16.4 L1787 / §4.4 L506 的"accent-soft 底 + accent-strong 字"不一致（代码与规范分歧，不是文档错）。 | 不必改，可补"accent-soft 绝不用作文字色"。 | S3 |
| 10.1-d | §10.1 L435 | "text / text-2 / text-3：正文、次级说明、元信息 \| 不以过淡灰色承载必要文字" | 正确（缺一档） | 数值（实测，`contrastRatio`，未四舍五入）：`text #1a1f25` 16.00、`text-2 #3e454d` 9.37、`text-3 #5f686f` 5.48（画布）/ 5.29（侧栏）/ 4.61（内嵌轨道 surface-3）。**漏列 `text-graphic`**：`#939ca6`，画布上 2.69:1，只用于图标与线条，"绝不承载文字"（`DESIGN.md:74-75`，v2.1 §4.3 L459-461）。注意 `index.mjs:245` 与 `index.css:144` 的注释写 "2.90"，实测 2.69，注释已陈旧（`DESIGN.md:75` 的 2.69 是对的）。 | 表中加一行：`text-graphic`——图标与线条用（2.69:1），绝不用于文字。 | S2 |
| 10.1-e | §10.1 L436 | "surface / surface-1 / surface-2：内容、分区、悬停与结构层次 \| 不靠重阴影区分所有面板" | 部分正确（缺 bg、surface-3） | 表面共 5 级（v2.1 §4.3 L450）：`bg #fafbfc`/`#0f1318`（页面）、`surface #fff`（卡片/对话框/菜单/阅读栏）、`surface-1 #f5f7f9`（侧栏、表头、内嵌轨道、代码块；深色 = surface）、`surface-2 #edf0f3`（悬停、中性选中行、骨架条）、`surface-3 #e4e8ec`（surface-2 上元素的悬停/按下）。深色下 `surface-1` 与 `surface` 同为 `#161b21`。 | 补 `bg`、`surface-3` 两行。 | S3 |
| 10.1-f | §10.1 L437–439 | warn / error·danger / ok 三行 | 正确 | `DESIGN.md:89-93`：红色只给危险与未处理（临床安全、破坏性操作、错误、未读徽标）；"需要核对"是琥珀；`ok` 不是核对标记。红色还用于 `RunStatusDot` 的"未完成"方块（`DESIGN.md:128-131`）。文中 error/danger 行未提未读徽标与"未完成"状态，不算错。 | — | — |
| 10.1-g | §10.1 L441 | "不对图片与整页应用反相滤镜；品牌按钮文字使用 accent-fg，不能硬编码白字。" | 正确 | `apps/web/src` 无 `filter: invert` / `invert(`（grep 为空）；`accent-fg`/`error-fg` 在深色取 `dark-bg`（`index.css:211,221`）；`DESIGN.md:146`；报告里的图在两个主题下保持白底（`DESIGN.md:446`，`MarkdownViewer.tsx:74` `bg-white`，v2.1 §4.8-6）。该句出处是 v2.1 §4.7-10 / §4.8-6，DESIGN.md 只有后半句。 | — | — |
| 10.2-a | §10.2 L445 | "界面使用现有无衬线字体栈；衬线仅由 wordmark、hero、doc-title 三个语义档位承担。每页最多四组字号与字重组合，中文层级优先使用 400 与 600。" | 部分正确 | 字体栈与三档衬线：正确（`index.mjs:477-482,621-641`；`designTokens.test.ts:182-194` 断言恰好 `["doc-title","hero","wordmark"]` 三档；ESLint 在 `ui/layout/cards` 禁 `font-serif`，`.eslintrc.cjs:61-67,160-166`）。**"每页最多四组"在 R11 只是提示，不会失败**：`TYPE_PAIR_NOTICE = 4`，超过只写进报告（`ui-walk.mjs:527,568-569`），"2026-09-26 走查实测 4–16 组/页"。"中文 400/600"：Button、Tabs、Input 标签、EmptyState 标题都用 500（`Button.tsx` 基类 `font-medium`、`Tabs.tsx:132`、`Input.tsx` label `font-medium`、`EmptyState.tsx` 标题），`copyRules.test.ts:125-127` 只对循证 GEO 禁 `font-medium/bold`。 | "……每页至多四种『字号 × 字重』组合（上线走查统计并报告，目前只提示不拦截）；中文层级以 400 与 600 区分，循证 GEO 页由测试强制，其余页面的 500 只用于拉丁字母/数字或与颜色一起出现。" | S2 |
| 10.2-b | §10.2 L449–451, L453, L457 | 元信息与图注 meta/caption 12 px；紧凑 compact 13 px；ui 14 px / 22 px；body 16 px / 1.75；title 24 px / 32 px；doc-title 24 px / 34 px 衬线；hero 40 px | 正确 | `index.mjs:621-641`：`meta 12/1.5`、`caption 12/20px`、`compact 13/20px`、`ui 14/22px`、`body 16/1.75`、`title 24/32px`、`doc-title 24/34px serif`、`hero 40/50px serif`；输出为 rem（`index.css:267-298`，`designTokens.test.ts:131-133`）。 | — | — |
| 10.2-c | §10.2 L452–454 | section "18 px / 26 px"；heading "20 px / 28 px" "数据页分区或预览标题" | 部分正确（用途描述） | 数值对（`section 18/26px`，`heading 20/28px`）。用途：`section` = "回答或报告中的小节标题"（`index.mjs:633`），`heading` = "数据页的卡片标题、预览窗中的文档标题"（`:634`）；文中把 heading 说成"分区"标题，实际是**卡片**标题；分区/小节标题是 section(18)。 | "section 18/26：回答、报告中的小节标题；heading 20/28：数据页的卡片标题、预览窗中的文档标题。" | S3 |
| 10.2-d | §10.2 L455 | metric / metric-lg "数据页指标 \| 32 / 40 px" | 部分正确（记法歧义，漏一档数值） | 同一表里 `ui` 写 "14 px / 22 px"（字号 / 行高），此行 "32 / 40 px" 按同一记法读成 32 px 字号配 40 px 行高，只对 `metric` 成立（`32/40px`）；`metric-lg` 是 **40 px / 48 px**（`index.mjs:638-639`）。§10.2 L460 又把 "32/40" 当作"两个字号"使用。 | 拆成两行：`metric 32 px / 40 px — 数据页的 KPI 数字`；`metric-lg 40 px / 48 px — 看板里唯一的主指标`。 | S2 |
| 10.2-e | §10.2 L447–458 | 字号表的完整性 | 部分正确（缺三个现行档位） | `TYPE_SCALE` 共 15 档（另有退役别名 `ui-sm`）；表中缺 `badge 12/1`（胶囊里的计数，R11 零使用）、`wordmark 16/1.3 serif`（侧栏字标，文中 L445 提到 wordmark 却不在表里）、`display 24/1.3`（登录页、整页空状态）。九个字号是封闭集合（12/13/14/16/18/20/24/32/40）："第十个就是缺陷"（`DESIGN.md:194-195`，`designTokens.test.ts:176-180`，ESLint 拒绝 `text-[Npx]` 与默认 `text-xs…`：`.eslintrc.cjs:8-15`）。 | 补三行，并写明"字号集合封闭为九个，第十个由测试和 ESLint 拒绝"。 | S2 |
| 10.2-f | §10.2 L458 | hero "首页唯一主标题 \| 40 px，现有品牌表达例外" | 部分正确 | `hero 40/50px serif`（`index.mjs:640`）。React 外壳**零使用**（`grep text-hero` 为空；`FrontierEventPage.tsx:221` 误用 `text-display` 显示热度数字不算）；首页大标题属于对话内核的空白页/Vue 外壳（v2.1 §26.1 L2991）。 | 注明"React 外壳目前没有首页大标题，档位保留给对话内核的空白页"。 | S3 |
| 10.2-g | §10.2 L460 | "尺寸在浏览器中使用 rem；不能通过禁用缩放来维持布局。32/40 的指标档位只用于数据页。中文不使用全大写转换或额外字距。" | 正确 | rem：`index.mjs:826-838`、`index.css:267-298`；`index.html:5` 视口无 `user-scalable`/`maximum-scale`；`metric` 仅在 VCR/StatTile 数据页（5 个文件）；`DESIGN.md:227-230` 无 `letter-spacing`、无 `uppercase`。该处"32/40"应写为"32 与 40 两个字号"。 | 见 10.2-d。 | S3 |
| 10.2-h | §10.2 L462 | "ui/body 下分别使用 measure 560 / measure-body 640 的行宽限制，目标不超过约 40 个汉字" | 正确 | `index.mjs:681-682`（measure 560、measureBody 640）；14×40=560、16×40=640（`DESIGN.md:243-245`，v2.1 §5.4-5 L646）；`max-w-measure(-body)` 在 R11 有 71 处使用。 | — | — |
| 10.3-a | §10.3 L468–469 | 基础间距 4、8、12、16、20、24、32、40、48、64；分组：组内 8、组间 16—24、章节间 32—48 | 正确 | `SPACE.scale`（`index.mjs:650-657`）；`DESIGN.md:251-252`；v2.1 §6.4 L732（"2 只允许用于细部校准"）。 | — | — |
| 10.3-b | §10.3 L470 | "页面侧边距 24；卡片内边距 16；网格间距 12" | 部分正确 | `SPACE.pageGutter 24 / cardPadding 16 / gridGap 12`（`index.mjs:653-655`）；`PageShell.tsx:68` 全宽度恒 `px-6`；`Card.tsx` 默认 `p-4`，紧凑 `p-3`。<768 改 16 的规则未落实（见 5.1-a）。 | — | S3 |
| 10.3-c | §10.3 L471–472 | 阅读容器 read 720；列表容器 page 1040 | 正确（数值），使用情况见 4.2-a | `CONTAINERS.read 720 / page 1040`（`index.mjs:674,676`）；`PageShell` 无 `read` 档。 | — | — |
| 10.3-d | §10.3 L473 | "数据容器 \| wide 1200；宽视口按现有规则可至 1280" | **错误**（引用了不存在的"现有规则"） | 令牌定义了 `wideMax 1280`（`index.mjs:678`，`--width-wide-max`，Tailwind `max-w-wide-max`），DESIGN.md:263 与 v2.1 §6.2 L709 写"≥1440 时 1280"。但**全应用没有任何地方使用 `wide-max`，也没有 ≥1440 的媒体查询**（`grep -rn "wide-max\|1440" apps/web/src` 只命中 index.css 的变量声明）；`PageShell.tsx:68` 的 `wide` 恒为 `max-w-wide`=1200。两树一致。 | "数据容器 wide 1200。令牌另定义了 wide-max 1280（规范意图：视口 ≥ 1440 时使用），目前没有页面使用，实际上限仍是 1200。" | S1 |
| 10.3-e | §10.3 L474 | "侧栏 \| 默认 280，收起 56；可调整行为沿用现有实现" | **错误**（两树一致，来自 DESIGN.md/v2.1 的陈旧数值） | 实现：`apps/web/src/lib/store.ts:10-12` `SIDEBAR_MIN 184`、`SIDEBAR_MAX 340`、**`SIDEBAR_DEFAULT 232`**；折叠 = 宽度 0（`Sidebar.tsx:182` `style={{ width: sidebarCollapsed ? 0 : width }}`，`inert`），另在主区顶部放一个 36 px「展开侧边栏」按钮（`AppShell.tsx:191-206`），不存在 56 px 图标条；拖动到 < 140 自动收起（`Sidebar.tsx:33,147`）。`--width-sidebar:280px`/`--width-sidebar-collapsed:56px` 在 React 外壳无任何消费者（grep 仅命中 index.css）。280 是**对话内核自己的**侧栏列宽——外壳把内核的 `_sidebarCol` 整列 `display:none`（`packages/harness-port/src/runtimeUiShell.mjs:151,161`）。键盘调节：分隔条是 `role=separator`，←/→ 16 px（Shift 64），Home/End 到两端，Enter 收起（`Sidebar.tsx:245-270`）。 | "侧栏：默认 232，可拖动或用键盘在 184–340 之间调整，宽度按设备记住；收起时宽度为 0（`inert`），主区顶部留一个『展开侧边栏』按钮；小于 1024 时为覆盖式抽屉（≤ 85% 视口宽）。（令牌里的 280 / 56 是对话内核自己的侧栏尺寸，外壳已将其隐藏。）" | S1 |
| 10.3-f | §10.3 L475 | "圆角 \| 标签 6；控件和行 8；卡片 12；面板/抽屉/对话框 16；输入组合区 24" | 部分正确 | 数值与 `RADII`（`index.mjs:691-698`）、`rounded-*` 预设一致（`tailwind-preset.js` borderRadius）。缺项：弹出层、菜单、Toast、Tooltip 也是 12（v2.1 §7.1 L828；`Menu.tsx:107`、`Toaster.tsx:57`、`Tooltip.tsx:208`）；`rounded-full` 给筛选胶囊/圆点/开关/徽标。**抽屉实际无圆角**：`Drawer.tsx:94` 是贴右、整高的面板，只有 `border-l`；对话框里有 3 个用 16（ConfirmDialog、FormDialog、ShortcutHelp），4 个循证 GEO 手写对话框用 `rounded-card`(12)+`shadow-modal`+`z-50`（`components/geo/MembersDialog.tsx:79`、`ArticleTextDialog.tsx:42`、`ProducerDialog.tsx:65`、`tabs/BudgetDialog.tsx:105`）。 | "圆角：标签 6；控件、行、菜单项 8；卡片、弹出层、菜单、Toast、Tooltip 12；对话框与面板 16（右侧抽屉贴边，无圆角）；全站输入框 24；筛选胶囊、圆点、开关、未读徽标全圆。" | S2 |
| 10.3-g | §10.3 L476 | "控件高度 \| 小型 28；默认 36；主要表单动作 44；标签 22" | 正确（有现行例外） | `CONTROL_HEIGHTS`（`index.mjs:704-710`）；`Button` sm 28/md 36/lg 44（`Button.tsx:44-48`）；`Input` 36，`size="sm"` 28（`Input.tsx:45`）；`Tag` 22；`IconButton` 28/36。例外（规范允许）：菜单项 32（`Menu.tsx:126`）、页签 40（`Tabs.tsx:132`）、页头最小高 32（`PageHeader.tsx:37`）、Toast 最小高 36。R11 仍有 ~27 处用间距刻度写高度（`h-6/7/8/9/10`），对比 ~29 处用高度令牌。 | — | S3 |
| 10.3-h | §10.3 L477 | "图标 \| Lucide，16 / 20，统一 1.5 描边" | 正确 | `ICON_SIZES {inline:16, chrome:20}`、`ICON_STROKE 1.5`（`index.mjs:713-720`）；`index.css:566-568` `svg.lucide { stroke-width: var(--icon-stroke) }`，`designTokens.test.ts:213-215` 检查；ESLint 拒绝 `size={N}`（N 非 16/20）与传 `strokeWidth`（`.eslintrc.cjs:90-98`）。补用途：16 与文字同行，20 用于无文字的外壳图标（v2.1 §8.1-3）。 | 补用途。 | S3 |
| 10.3-i | §10.3 L479 | "静态卡片不投影；确实浮起的容器使用 e1，输入组合区、菜单、浮层和提示使用 e2，抽屉与对话框使用 e3。" | 部分正确 | 阶梯正确（`ELEVATION`，`index.mjs:726-734`）。"提示"在 v2.1 §7.3 L857 指**提示条（Toast）**，而 Tooltip 无阴影（`Tooltip.tsx:208`），宜写 Toast。`Card.tsx` 无阴影 ✓。`shadow-e1` 在 R11 只有自动研究页的回复框在用（`AutopilotPage.tsx:293`，且它是 composer，规范说 composer 用 e2）；Toast/菜单/弹层用 e2 ✓，抽屉/对话框用 e3 ✓。`shadow-pop`/`shadow-modal` 是 e2/e3 的退役别名，仍有 7 处在用（`Sidebar.tsx:179`、`Switch.tsx:51`、`ClaimCitation.tsx:248`、`geo` 对话框 ×4）。ESLint 错误信息仍把 `shadow-pop/modal` 当作"正确写法"（`.eslintrc.cjs:26-27`）。 | 将"提示"改为"Toast（提示条）"。 | S3 |
| 10.4-a | §10.4 L483 | "沿用 fast 120 ms、base 200 ms、slow 320 ms 及统一进入/退出曲线。" | 正确 | `MOTION`（`index.mjs:741-747`）：120/200/320 ms、`ease-standard cubic-bezier(0.2,0.8,0.2,1)`、`ease-exit cubic-bezier(0.3,0,1,1)`；位移 抽屉 24 / Toast 8 / 菜单 4（`MOTION_DISTANCE`，`:755`，文中未写）。 | 补位移距离 24 / 8 / 4。 | S3 |
| 10.4-b | §10.4 L485 | "减少动态效果模式取消移动距离，淡入淡出不超过 120 ms；图表库另行关闭动画。" | 正确 | `index.css:425-433`（三个位移变 0，`--dur-base/slow` 归 `--dur-fast`）、`:614-631`（只保留颜色/透明度过渡，循环动画只播一次，`.animate-spin/ping/pulse` 静止）；`designTokens.test.ts:223-229`。图表：`components/charts/echartsBase.ts:26-30,184-195` 在减少动态时给根和每个系列设 `animation:false` 并在设置变化时重绘（`DESIGN.md:512` Known gaps 仍写"host 要自己设"，已过时）。 | — | — |
| 10.4-c | §10.4 L487 | "浮层使用现有层级令牌：页面、固定区、抽屉、对话框、浮层、提示、tooltip、跳转链接。……不不断增大 z-index" | 部分正确 | 八层数值 `0/10/40/50/60/70/80/90`（`Z_INDEX`，`index.mjs:769-778`，`index.css:343-350`）：page、sticky（固定区）、drawer、modal、popover（浮层，含在对话框内打开的菜单）、toast（文中"提示"）、tooltip、skip（跳转链接）。数值文中未给出。原语都用层名（Drawer `z-drawer`、ConfirmDialog `z-modal`、Menu `z-popover`、Toaster `z-toast`、Tooltip `z-tooltip`、跳转链接 `z-skip`），但**没有 lint 禁止数字 z**，R11 仍有 `z-10`×10、`z-20`、`z-30`、`z-40`×3、`z-50`×5（如 `ClaimCitation.tsx:248` 的依据弹层用 `z-50`，低于令牌规定的 popover 60；四个 GEO 对话框 `z-50`）。 | 补出数值表；"提示"改"Toast"。 | S3 |
| 10.5-a | §10.5 L491–493 | "每页最多一个品牌表达重点……记忆胶囊符合历史长度条件时的单条增长线。" | 正确（R11 位置已变） | `DESIGN.md:106-117`：一页一个 brand moment；列表页唯一图表 = 记忆胶囊增长线（`CapsuleGrowth`），**R11 起放在『成长』标签页（四个页签 关于你·项目·做法·成长 的最后一个），不在页面顶部**；历史跨度满两周才绘制；至多三个时刻；无图块/图例/指标档位。陈旧树 DESIGN.md 仍写顶部。机器检查：`ui-walk` 的 `SECTION_SHAPES_BY_PAGE` 把 memory 各页签限制为 2 种区块（`ui-walk.mjs:328-336`）。 | 补："增长线位于『成长』标签页"。 | S3 |

### 1.5 §11 数据与科学图表

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| 11.1-a | §11.1 L499–501 | "零、未知、不适用和计算失败分开表示。没有历史值时不显示 0% 变化" | 正确（R11 已有实现） | `components/ui/Delta.tsx`：`value` 为 null/undefined 不渲染；噪声带内写『持平』不画箭头；比率变化写『个百分点』；▲▼ + 颜色 + 读屏文字三样同说；**变好用品牌蓝、变差用正文深灰，只有临床风险指标变差才用红**（`Delta.tsx:3-20`；v2.1 §21.6）。`StatTile`：不存在的数用词（『—』『未测』『样本不足』）以 20 px（`text-heading`）显示，不写 0（`StatTile.tsx:21,95-98`）；`ChartCard` 空态是一句话，不是空画框；缺测时段不插值、线断开（v2.1 §32.5-7、§32.10）。 | 可补上 Delta 的配色规则（变好品牌蓝、变差深灰、红仅限临床风险）。 | S3 |
| 11.2-a | §11.2 L503–514 | 图表选择表（用户问题 → 首选呈现） | 部分正确（缺禁止项） | 本表是目标性质的"按问题选图"，与 v2.1 §32.2（combined.md:3534-3551）不冲突，但漏掉现行禁令：**禁止 3D、仪表盘、词云、彩虹色阶、红绿配色、装饰性图形；双轴默认禁止；排名用『排序的数据表 + 行内条形』而不是图表；超过 4 个份额不用饼图**；条形/柱形/面积数值轴从 0 开始；比值类效应量用以 1 为中心的对数轴；图中文字只用 13 与 12 两个字号；图表标题是一句结论，不写『图 1』（`ChartCard.tsx:7-8`）。 | 在表后加一段"禁止项"（以上各项），并引用 ChartCard 的"标题即结论"。 | S2 |
| 11.3-a | §11.3 L518 | "品牌比较图沿用 EviMed 为品牌色、竞争对象为灰阶的规则，用户主动选定的对象可获得强调。科学分组使用已定义分类色板" | 正确（缺数值） | `CHART_OWN`：浅 `#0a5dc1`、深 `#5f97e0`（2.1.2 起深色单独取值，因 `#0a5dc1` 在深色卡片上只有 2.76:1，`index.mjs:408-411`）；对手三级灰 `#5a626b/#737c85/#8a939c`（白底 6.19/4.24/3.12，深色画布 3.01/4.39/5.98，已由 `contrast.mjs:DATA_CONTRAST_RULES` 构建时校验）；用户钉住的对手取分类色第 2 槽（橙）、同屏至多一个；我方线宽 2.5、其余 1.5、标记 5（`CHART_STROKES`，`index.mjs:819`）；分类色 8 槽顺序固定不轮换（`CHART_COLORS.series`，`:377`，`CHART_SERIES.dark` 另有深色 8 色）；有中点的数据用发散色阶 蓝—浅灰—橙 7 级（`:389`），缺测格 `#bac2ca`；连续量用单色相 6 级热力（`:378`）。 | 补出这三组（比较 / 分类 / 连续 / 发散）的名称和『不用红绿』。 | S3 |
| 11.3-b | §11.3 L520 | "证据确定性沿用单色阶，不使用红黄绿等级暗示安全。颜色不能独立承担组别识别；增加直接标签、线型、符号或数据表。图表提供键盘可达的等价数据，关键数值不只存在于 hover tooltip。" | 部分正确 | 前两句：正确（`DESIGN.md:104-105`；`echartsBase.ts:34-42,120-150`：提高对比度（`prefers-contrast: more`）/强制色，或≥3 类且无直接标注时，ECharts 贴花 + 每条折线独有的线型与标记形状 `LINE_PATTERNS`，需注册 `AriaComponent`）。"键盘可达的等价数据"：`HeatGrid` 是真 `<table>`（有 `<caption>`），`ShareBar` 是 `role="img"` + 汇总 `aria-label`，但 **`TrendChart` 只有 `role="img" aria-label`（`TrendChart.tsx:84`），没有『查看数据』切换，也没有键盘逐点移动**，v2.1 §32.13 L3664-3665 要求二者，R11 未实现。 | 保持原句，另注"『查看数据』表切换与图表内键盘逐点移动是规范要求，趋势图尚未提供"。 | S3 |
| 11.3-c | §11.3 L522 | "上传或引用的原始图片保持原比例、图例与坐标完整，支持放大和打开原图。" | 正确（目标） | `components/markdown-viewer/MarkdownViewer.tsx:35,74`：图片 `max-w-full`，报告里的图 `bg-white p-3`，两主题下保持白底（`DESIGN.md:446`）。放大/打开原图未核。 | — | — |
| 18.1-a | §18.1 L743 | "现行约束：浏览器通过应用服务端访问研究能力；领域对象、状态与错误口径来自现有共享契约；设计值来自令牌包。界面不能直接连接研究内核或复制一套领域判定。" | 正确 | `AGENTS.md:28-31`（内核"only by the control plane (never by a browser)"）；设计值：`@evimed/design-tokens`；错误口径：ESLint `errorTextRules` 禁止渲染原始 `Error.message`（`apps/web/.eslintrc.cjs:101-125`）。例外要点：对话界面是嵌入的**内核页面**（iframe，`app/routes/RuntimeUiFrame.tsx`），外壳只经 `overrideTokens`（60 个 `--dsw-*` 变量，仅颜色与字体，`packages/design-tokens/src/kernel.mjs`）和插槽改造它；内核几何（圆角/间距）没有令牌（`DESIGN.md:505-507`）。本文完全没有这个"内核框"视觉边界。 | 在 §18.1 表后加一段：对话工作区是内核页面，外壳与它共用颜色与字体令牌（60 个变量），几何由与内核版本绑定的样式处理；外壳向内核看齐。 | S2 |
| 18.1-b | §18.1 L745–751 | 层次表（设计令牌 / UI 原语 / 页面模板 / 业务组件 / 数据契约） | 正确 | 令牌 `packages/design-tokens`；原语 `components/ui`；模板 `components/layout`（PageShell/PageHeader）；业务组件按模块目录（`components/{frontier,geo,vcr,memory,sources,…}`）；契约 `@evimed/domain`。 | — | — |
| 18.3-a | §18.3 L770 | "页面级错误边界保留全局壳与导航" | 正确 | `app/router.tsx:56-71`：每条会渲染内容的路由都有 `errorElement: <RouteError/>`，挂在包住全部工作台页面的无路径路由上，侧栏与对话框保留；`RouteError.tsx` 一句话 + 『重新载入』，过期分块自动刷新；`ui-walk` 拒绝路由器的英文错误页（`ui-walk.mjs:186` 的 `Unexpected Application Error`、`dynamically imported module`）。 | — | — |
| 18.4-a | §18.4 L776–785 | "基线语言为简体中文……内部 API、枚举、模型 ID、运行路径和原始错误串不进入普通正文"；应避免/建议表达表 | 正确 | `DESIGN.md:437-441,463-467`、`AGENTS.md:151-154`；机器检查：`ui-walk.mjs:171-174,184-187`（运行 id、`deepseek/`、`undefined`、`NaN`、`已交付`（单独成词）、`核对 N 条`、`用过 N 次`、`起生效`、`缓存命中`、`tok/s`、token 计数、`openFDA 药品召回…`），`app/vocabulary.test.tsx`（对话行不得以 run_/ses_/模型名/大写能力键开头），`app/retiredWords.test.ts`（见第 2 部分）。表中例子『核对 37 条』恰是 `BACK_OFFICE` 的第二条正则。标识符用等宽字体（JetBrains Mono，DOI/PMID/NCT/run id，`DESIGN.md:168-169`）——文中未提。 | 补"标识符用等宽字体"。 | S3 |
| 18.4-b | §18.4 L787 | "界面自行撰写的中英文和数字之间遵循现有空格规范；引用原文与 AI 生成正文不做会改变内容的批量替换。" | 正确（缺规则正文） | 规则：界面文案在中文与拉丁字母/数字之间**手打半角空格**（『打开 PubMed 检索』『共 29 条』），不加：全角标点两侧、% 与 ° 之前、格式化日期时刻内部；AI 正文与引文逐字节不动，由 `body { text-autospace: normal }` 补间距，代码/标识符关闭（`DESIGN.md:232-239`；`index.css:538,552`；v2.1 §5.5 L652-657）。测试：`app/copyRules.test.ts:121-123`（未加空格的字符串失败，日期部分豁免）。 | 把"现有空格规范"替换成上述两句规则 + 引用 `copyRules.test.ts`。 | S3 |
| 18.5-a | §18.5 L791 | "不增加解释系统机制的页面副标题、重复提示或“为什么入选”模块。" | 正确 | `DESIGN.md:464-467`、`AGENTS.md:151-154`；`PageHeader`/`Card` 都"没有地方放说明"（`hint`/`description` 仅留在类型上、不渲染，`Card.tsx:9-14`）；`ui-walk` 页头 `<p>` 失败。 | — | — |
| 19.1-a | §19.1 L799 | "目标为 WCAG 2.2 AA，并沿用现有更高对比度、强制颜色和减少动态效果支持。" | 正确 | `index.css:437-502`（`forced-colors: active` 层、`prefers-contrast: more` 层）、`:425-433,614-631`（减少动态）；`data-forced-colors="preserve"` 保护颜色即数据的元素（`DESIGN.md:414`）。 | — | — |
| 19.1-b | §19.1 L803 | "普通文字至少 4.5:1；符合标准定义的大字至少 3:1" | 部分正确（与本平台更严的规则不同） | 本平台**不借用大字号 3:1 的放宽**：所有文字角色在所有表面上 ≥ 4.5:1（v2.1 §4.9 L579；`contrast.mjs` 33 组规则 × 浅/深 × 标准/提高对比度共 132 项，未四舍五入，不达标即构建失败）。最低文字组合 4.61:1（text-3 在 surface-3 上），最低图形组合 3.10:1（控件边框在侧栏上，`contrast.mjs:CONTRAST_RULES`）。 | "文字对比度：所有文字角色在所有表面上 ≥ 4.5:1（不适用大字 3:1 的放宽），令牌构建时逐对实算、不四舍五入。" | S2 |
| 19.1-c | §19.1 L804 | "识别控件与必要图形的信息至少 3:1" | 部分正确 | `border-control` 浅 3.21（侧栏 3.10）、焦点环 6.05、`dot-running/failed/done` 在 `contrast.mjs` 列表里。**但令牌表有一个有意低于 3:1 的图形角色 `text-graphic #939ca6`（2.69:1）**，用于图标/线条（`VcrDiagrams.tsx:120,358`、`DataTable.tsx:225` 的『对手』行内条形、趋势图动作线 `TrendChart.tsx:176`），**且『已取消』圆点 `dot-canceled` 就是它（`#939ca6`，浅 2.69 / 深 2.71）**，与 `DESIGN.md:131`、v2.1 §22.6 L2526『所有记号 ≥ 3:1』矛盾；`contrast.mjs` 既未列 `text-graphic` 也未列 `dot-canceled/dot-review`，所以不会失败。 | "非文字对比度：控件边界、焦点环、承载含义的图形 ≥ 3:1；令牌表唯一的例外是纯装饰的 `text-graphic`（2.69:1），承载含义的状态记号不得使用它（R11 的『已取消』圆点目前仍是）。" | S2 |
| 19.1-d | §19.1 L805 | "焦点：可见且不被固定层完全遮挡；不只依赖 box-shadow" | 正确 | 全局 `:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }`（`index.css:592-595`），文本框改边框变色 + 1 px 内环（`Input.tsx`），强制色下 `Highlight`；`designTokens.test.ts:217-221,241-248`（禁 `outline: none`、禁 `components/ui` 里的 `focus:ring-`）。"不被固定层遮挡"（2.4.11）：只有 Tabs 设 `scroll-px-6`（`Tabs.tsx:108`），其余固定区没有统一的 `scroll-padding`（v2.1 §6.8-2 要求，未落实）。 | — | S3 |
| 19.1-e | §19.1 L806 | "AA 的最小目标按 24 × 24 CSS px 或相应间距/例外规则核查" | 正确 | `DESIGN.md:299-300`；`ui-walk` 统计 `smallTargets`（宽或高 < 24 的可见控件数，`ui-walk.mjs:1493`）但**只记录、不判失败**（页首注释 `:59-60`）。 | — | — |
| 19.1-f | §19.1 L807 | "主要触摸操作以 44 × 44 的点击区域为产品目标，不将其误称为 AA 的统一要求" | 部分正确（与现行规则/实现不一致） | 三个来源三个数：v2.1 §10.5-1 L1096 写**触屏（`pointer: coarse`）上主要操作与图标按钮的热区 ≥ 44 × 44**（与本文措辞一致），§16.3-2 L1774 更宽——**所有可点击目标**都扩到 44 × 44；R11 `DESIGN.md:299-301`（两句：24×24 为底线；`coarse` 下）：**`IconButton` 与筛选胶囊的热区在 `coarse` 下扩到 40**（陈旧树 DESIGN.md 没有这句）；代码实际：`IconButton` `sm` 热区 **32 × 40**、`md` **40 × 44**（`IconButton.tsx:48-50`，类注释写"40 × 40"算术有误），筛选胶囊 **高 40**（`FilterChips.tsx:34`），其余 `Button` sm/md、导航行、菜单项（32）、`Input` 在触屏上**不扩**。`coarse:` 变体来自 `apps/web/tailwind.config.js:29-34`。 | "触摸热区：规范要求触屏上的可点击目标 ≥ 44 × 44；R11 实现为图标按钮 32×40（sm）/ 40×44（md）、筛选胶囊高 40，视觉尺寸不变，其余控件未扩展——24 × 24 仍是 AA 的底线。" | S2 |
| 19.1-g | §19.1 L808 | "普通内容在等效 320 CSS px 下可重排；文字放大至 200% 仍可使用" | 部分正确 | 现行可检查的是 390 px 下页面不得横向滚动（`DESIGN.md:445`；`ui-walk.mjs:555` 失败项）；320 px / 400% 缩放 / 200% 缩放只写在 v2.1（§6.5-1 L766、§10.6 L1101-1105），没有任何自动检查。 | 保持，但注明"自动检查只覆盖 390 px"。 | S3 |
| 19.1-h | §19.1 L809–810, L814 | 输入/操作；"每页提供跳到主要内容；……图标按钮有名称；对话框有标题并管理焦点" | 正确 | 跳转链接『跳到主要内容』是每页第一个 Tab 停靠点（`AppShell.tsx:162-172`，`z-skip`，嵌入模式不渲染）；`IconButton.label` 必填；`Drawer`/`ConfirmDialog` 焦点移入/陷阱/回到触发器；侧栏宽度有键盘替代（`separator` ←/→/Home/End/Enter，`Sidebar.tsx:245-270`）；折叠侧栏 `inert`。路由切换后『把焦点移到新页面 h1』（v2.1 §10.3-8）在 R11 **未实现**——`AppShell` 只在跳转链接点击时聚焦 `<main>`。 | — | S3 |
| 19.2-a | §19.2 L818 | "LCP 不高于 2.5 秒，INP 不高于 200 毫秒，CLS 不高于 0.1。这是拟采用的页面性能目标" | 正确（与规范一致；R11 无采集） | 阈值与 v2.1 §34.4 L3836 一致（p75，桌面/手机分别统计）。R11 **没有任何 `web-vitals`/`PerformanceObserver` 采集**（grep 为空），v2.1 §34.4-2 要求的按路由 RUM、首屏 JS 增幅 >10% 需评审等均未落实。 | 注明"R11 尚无采集"。 | S3 |
| 19.3-a | §19.3 L826 | "按路由和交互需要加载资源；报告中的大图按需加载" | 正确 | `app/router.tsx:22-45` 24 个路由 `lazy()`；`vite.config.ts:35-37` 把 React/router 拆成单独分块；ECharts 只引 `echarts/core` 按图注册（`echartsBase.ts:1-12`）；`LazyMenu`；构建目标 Chromium 109 / iOS 15.4（`vite.config.ts:15`，低于下限显示升级页）。 | — | — |
| 20.1-a | §20.1 L834 | "视觉调整附变更前后截图，组件变化同时更新浅色和深色基准。" | 正确（缺机制） | `DESIGN.md:486-494`：`/__gallery` 画每个原语的每个状态（含浮层），`pnpm gallery:shot`（`--theme dark` 录深色基准 `gallery.dark.png`）与 `pnpm gallery:check`（像素差异 > 0.5% 失败，每通道容差 8），CI 任务 `gallery` 浅/深各一次；条件固定：1280 宽、2× 像素、`reducedMotion: reduce`、Ubuntu 24.04 + fonts-noto-cjk（`scripts/ops/gallery-shot.mjs:83-90`；`.github/workflows/web.yml:353-420`）。 | 补："组件外观变更 = 看新截图并重录浅色、深色两张参考图；`gallery:check` 差异 > 0.5% 失败。" | S3 |
| 20.4-a | §20.4 L877 | "核心流程至少覆盖 1440 × 900 桌面、768 × 1024 平板和 390 × 844 手机；普通内容补充等效 320 CSS px 重排检查。浅色与深色均检查" | 部分正确（与现行自动化视口不一致） | 现行自动化：`ui-walk` 桌面 **1512 × 945**（业主屏幕）+ 手机 390 × 844，**无平板、无 320、不测深色**（`ui-walk.mjs:169-170`）；`gallery` 1280 宽、浅/深各一张。规范 v2.1 验收宽度 = 320、390、768、1024、1280、1440、1512、1920 + 浏览器 200% 缩放，并要求记录真实 CSS 视口宽度（§6.5-5 L770、§37.3-3 L4077）；设计评审清单只要求 1440 与 390（§37.1 #14）。本文的三档是二者的子集且混合了两套。 | "视口：设计评审至少看 1440 与 390；验收宽度 320 / 390 / 768 / 1024 / 1280 / 1440 / 1512 / 1920 与 200% 缩放，记录真实 CSS 宽度。现行自动化：ui-walk 1512 × 945 与 390 × 844；gallery 1280。" | S2 |
| 20.5-a | §20.5 L883–887 | 检查方式（自动化 / 无障碍自动检测结合键盘和辅助技术抽查 等） | 部分正确 | R11 现有机制：ESLint 令牌/组件/图标/错误文案规则 + `jsx-a11y`；`designTokens.test.ts`（生成块逐字节、无字面色值、衬线只三档、焦点用 outline、减少动态保留淡出）；`contrast.mjs` 构建期 132 项；`copyRules`/`retiredWords`/`nativeTitles`/`vocabulary` 四个文案测试；`gallery:check`；上线后 `ui-walk`（预算 + 结构探针 + 首行点击）。**v2.1 §10.11 / §34.7 规定的 Playwright + axe-core（带 `wcag22aa` 标签）扫描在仓库里不存在**（`axe-core` 只作为 `eslint-plugin-jsx-a11y` 的传递依赖）。"低影响文案调整不新增只镜像实现的测试"与现有文案/退役词测试并不冲突，但它们是**必须通过**的闸门，且退役词只能在注释或标 `retired-word-ok` 的行里出现。 | 重写为列出上述机制，并注明 axe-core 扫描尚未落地。 | S2 |

### 1.6 补充：全文中与本范围相关的名称问题

| id | 文档节/行 | 原文（短引） | 判定 | 证据 | 建议改写 | 严重度 |
|---|---|---|---|---|---|---|
| N-a | §3.2 L115、§4.5 L199、§15.2 L650、§20.2 L848、§20.3 L870 | "虚拟临研"（模块名，共 5 处，另 §3.2 L116 "位于虚拟临研之后"） | **错误**（已被业主废止的名称） | 2026-10-07 业主改名：模块叫「循证 GEO」与「虚拟临床研究」，「循证传播」「虚拟临研」是**退役词**（`AGENTS.md:156-165`；`DESIGN.md:369-371`）。R11 侧栏标签 = 「虚拟临床研究」（`Sidebar.tsx:84`；陈旧树 `Sidebar.tsx:83` 仍是「虚拟临研」，证明文档对着陈旧树写）。`app/retiredWords.test.ts:41-42` 与 `ui-walk.mjs:197` 的 `RETIRED_NAMES` 在产品页面上失败；搜索框把旧名当新名读到 2027-01-07。设计参考文档不在测试范围内，但 AGENTS.md 规定"凡读者或模型看到的地方"都用新名，且文档本身是后续设计与评审的名称来源。 | 全文替换为「虚拟临床研究」（路由 `/app/virtual-research`、标识符 `vcr` 不变）；§3.2 L115 的「当前入口」列也用新名。 | S1 |


### 1.7 陈旧树与 R11 的差异中影响本文断言的项（本文是对着陈旧树写的证据）

两树**逐字节相同**的（因此这些断言在两树都成立或都不成立）：`packages/design-tokens/src/*`（含 `index.mjs`、`contrast.mjs`、`kernel.mjs`、`release.json`）、`apps/web/src/index.css`、`.eslintrc.cjs`、`store.ts`（侧栏 232/184/340）、`designTokens.test.ts`、`nativeTitles.test.ts`、`vite.config.ts`、`index.html`、`public/*`、`scripts/ops/gallery-shot.mjs`、`components/cards/*`。**有差异的**（均为 2026-10-07 两次前端审计在 R11 里的修复，`ui-walk.mjs` 页首注释称 B-02/B-03/B-04）：

| 项 | 陈旧树 | R11 | 受影响的文档断言 |
|---|---|---|---|
| 触屏热区 | 无 `coarse:` 变体，`IconButton`/`FilterChip` 无加宽 | `tailwind.config.js:29-34` 新增 `coarse` 变体；`IconButton.tsx:48-50`、`FilterChips.tsx:34` 加宽到 32×40 / 40×44 / 高 40；DESIGN.md:299-301 新增一句 | §19.1 L806–807（触摸 44×44） |
| 侧栏可达性 | 折叠仅宽度 0，内部链接仍可 Tab；无焦点交接；autopilot 页还单独隐藏侧栏（`onTasks`） | `Sidebar.tsx:165-171` `inert`；`AppShell.tsx:43-110` 焦点交接、Esc 关抽屉、抽屉打开时 `<main inert>`；`AppShell.sidebarFocus.test.tsx` | §5.3 L231（B02） |
| 宽表 | `DataTable`/`HeatGrid` 用 `overflow-x-auto`，无冻结列 | `ScrollRegion` + 冻结行标题列（`DataTable.tsx`、`HeatGrid.tsx`）；DESIGN.md:301-302 | §5.1 L214、§9.3、§19.1 |
| 页签 | 仅下划线页签 | `trailing` 槽、`dot` 状态点、末端渐隐（`Tabs.tsx:49-111`）；DESIGN.md:327 | §9.1 Tabs 行 |
| 抽屉 | 打开时聚焦『关闭』钮（其 Tooltip 吃掉第一次 Esc，需按两次） | 面板自身取焦点；内嵌模态层优先（`Drawer.tsx:49-70`） | §5.3 L229、§9.1 Drawer 行 |
| 搜索框 | 无清除；固定 256 px 宽 | `onClear`（清除钮 + Esc）、手机占满栏宽（`SearchInput.tsx`） | §9.1 SearchInput 行 |
| 输入框 / 菜单 | 无 | `Input trailing` 槽（显示密码）；`Menu` 的分组标题与 Esc 不外溢 | §9.1 Menu 行 |
| 页面外壳 | `PageShell` 无 `back` | `back` 槽（标题上方的返回链接，`PageShell.tsx:39-70`） | §4.1 |
| 数据卡/图表 | `StatTile` 是 `<section><h3>`，`ChartCard` 恒 `h3`，`ProgressRail` 无折叠 | `StatTile` 改 `role=group`+`<p>`、`dense`；`ChartCard level`；`ProgressRail summary` 手机折叠；`TrendChart bounds` | §11、§19.1 标题层级 |
| 知识库 | 左侧 rail + 列表（`SourcesPage.tsx:345`） | 单列表 + 类型筛选行 + 右侧抽屉 | §4.2、§4.5 |
| 侧栏名称 | "虚拟临研"（`Sidebar.tsx:83`） | "虚拟临床研究"（`:84`） | §3.2、§4.5、§15.2、§20.2、§20.3 全部用旧名 |
| 规则文本 | `AGENTS.md`、`DESIGN.md` 无『页面结构』『模块名』两段；DESIGN.md 记忆胶囊增长线写在页面顶部 | 两段均有（`AGENTS.md:157-169`，`DESIGN.md:342-371`）；增长线在『成长』标签页 | §10.5、§4.1 |
| 测试与走查 | `copyRules`/`retiredWords` 无模块改名项；`ui-walk` 无结构探针/区块形状/首行点击/退役名 | 均有（`retiredWords.test.ts:41-42`，`ui-walk.mjs:197,328-351,633-780`） | §20.5 |


---

## 2. 文档遗漏的现行规则与执行机制

"放在"列写本文应该在哪一节落笔；"严重度"按遗漏的后果判：S1 = 读者按本文设计会直接违反一条会失败的闸门；S2 = 缺少一个已存在的机制；S3 = 细节。

| # | 现行规则 / 机制 | 执行位置（R11） | 本文应放在 | 严重度 |
|---|---|---|---|---|
| M01 | **「页面结构 (2026-10-07)」六条规则**：①一页一种对象、以列表呈现（别的种类进页签或另一页，不堆在上下）；②详情在右侧抽屉里打开，列表留在原处；③页头 = 标题 + 范围 + 至多一个主按钮（可有搜索框），两个实心强调色按钮失败；④只放『能做的事』与结果本身——系统状态、版本号、模型名、标识符、统计口径怎么数的，不在用户页面；⑤至多一行视图切换、一行筛选；⑥看起来可点的东西必须在读者正看的地方有结果（抽屉/新页/页签/就地展开），不得只改折叠线以下。 | 规则正文 `DESIGN.md:342-371`（陈旧树无）、`AGENTS.md:141-146`；出处是业主批准的整改方案 §9.4「写进设计规范的规则」（`docs/ui-ux-audit/2026-10-07-页面与模块整改方案.md:494-503`，只在 release 工作树里，未入库）。机器：`scripts/ops/ui-walk.mjs`——①`SECTION_SHAPES_BY_PAGE` 以元素形状计页面主体的区块种类，超预算失败（`:328-336`；files/memory 各页签 2、frontier 3、capabilities 2、extensions 2、virtual-research 2、VCR 研究各页 3）；③页头 `<p>` 与 `bg-accent` 按钮数（`:553-554,1453-1455`）；⑥`ROW_CLICK_PAGES` 点击各列表首行，什么也没出现即失败（`:345-351,603-624`）。②④⑤靠评审。 | §4.1 紧随页头规则新增『页面结构六条』；②并入 §9.1 Drawer 与 §5.3；④并入 §18.5；⑤并入 §9.1 Tabs/FilterChips 与 §12.2 | S1 |
| M02 | **退役名称与词**：模块名只能是「循证 GEO」「虚拟临床研究」（标识符 `geo`/`vcr` 不变）；「循证传播」「虚拟临研」是退役词，搜索框把旧名当新名读到 2027-01-07；另有 15 个退役界面词（运行记录、无痕、本次用到的背景、写一个方法、放进胶囊、待你复核、待人工复核、自证未通过、主张、改线、按哪条线处理、置信度、候选、蒸馏、采纳……）和只在可见文本里禁止的 `approved`/`SKILL.md`/`digest`。 | `AGENTS.md:156-165`；`apps/web/src/app/retiredWords.test.ts:19-58`（凡可见字符串中出现即失败，注释或标 `retired-word-ok` 的行除外）；`ui-walk.mjs:197,550`（线上任何页面出现即失败）；服务端 `geoProductName.test.mjs`。 | §3.2 导航表与全文改名（见 N-a）；§18.4 增一条『退役词』并给出名单入口 | S1 |
| M03 | **上线走查的样式预算**：桌面每页 控件种类 ≤ 8、文字颜色 ≤ 5、边框种类 ≤ 3；前沿精选 9/8/3（标题是链接，另有安全红与名次色）；数据页（知识库、GEO、虚拟临床研究首页）10/7/3；GEO 项目与 VCR 研究各页签 10/7/6；扩展中心两个列表 9/5/5；前沿证据专区首页 9/8/4；超出失败，R11 新页面（`PROVISIONAL_PAGES`）只告警。另：标题与正文块、列表行标题须在**一条左边线**；『字号 × 字重』组合 ≤ 4 只提示；`smallTargets`（<24 px）与无标注的装饰 SVG 只记录。 | `ui-walk.mjs:205-283`（预算表）、`:292-298`、`:556-571`、`:527`、`:1493-1494`；规范 v2.1 §11.5 L1256、§26.6 L3021。 | §4.4（边框）、§10.5（颜色/控件预算）、§20.5（检查方式）新增一张预算表 | S2 |
| M04 | **上线走查的词汇与结构闸门**：页面不得出现运行 id（`run_…`、`ses_…`）、`deepseek/`、`undefined`、`NaN`、`[object`、残留的 `<!-- claim` 标记；后台词汇 已交付（单独成词时）、`核对 N 条`、`已核对 N/…`、`用过 N 次`、`N月N日 起生效`、`缓存命中`、`tok/s`、token 计数、`openFDA 药品召回…`、`理解遗漏`、`处理第 N 代`；每个可见控件须有名称；页面有自己的标题；不得显示路由器英文错误页；页面自己的 API 不得 4xx/5xx；390 px 不横向溢出。结构探针：侧栏是唯一的 `aside[aria-label=侧栏]` 且含分隔条与『新对话』链接，手机折叠须 `inert`，首两个 Tab 停靠点不在折叠的侧栏内；横向滚动区必须可聚焦且有名称；GEO 总览与记忆页的标题层级不跳级；项目列表里不得有两个同名项目；VCR 手机的计数标签不被截断。 | `ui-walk.mjs:171-187,536-555,633-780`。 | §18.4（词汇）、§19.1（无障碍结构）、§20.5 | S2 |
| M05 | **组件陈列页比对**：`/__gallery`（生产构建仅在 `VITE_EVIMED_GALLERY=1` 时注册，`router.tsx:151-153`）画 18 行原语的全部状态（含浮层），`pnpm gallery:shot` 录制、`pnpm gallery:check` 比对，浅色 `gallery.png`、深色 `gallery.dark.png` 各一张，像素差异 > 0.5%（每通道容差 8）失败；条件固定：1280 宽、2× 像素、减少动态效果、Ubuntu 24.04 + fonts-noto-cjk。 | `DESIGN.md:486-494`；`scripts/ops/gallery-shot.mjs`；`.github/workflows/web.yml:353-420`；`apps/web/src/test/__screenshots__/`。 | §20.1 | S2 |
| M06 | **对比度在构建期实算**：33 组 前景/背景 × 浅/深 × 标准/提高对比度 = 132 项，另有 13 项数据色图形（我方 4 + 对手灰 9）；比较不四舍五入，不达标即令牌构建失败；不得估算。`text-graphic`、`dot-canceled`、`dot-review` **不在**清单里（见 19.1-c）。 | `packages/design-tokens/src/contrast.mjs:CONTRAST_RULES / DATA_CONTRAST_RULES`；`designTokens.test.ts:250-256`。 | §19.1、§10.1 | S2 |
| M07 | **ESLint 令牌与组件闸门**（`src/**` 内出现即失败）：任意字号 `text-[Npx]`、Tailwind 默认字号 `text-xs…text-9xl`、任意圆角 `rounded-[Npx]`、裸 `shadow-sm/md/lg`、`shadow-card`、令牌色加透明度修饰（`bg-accent/10`）、任意十六进制颜色类、退役的 `text-ui-sm`；`font-serif` 在 `components/{ui,layout,cards}` 内；在 `components/ui` 之外手写带边框的胶囊或 `<button>`；图标 `size` 非 16/20、给图标传 `strokeWidth`；直接渲染 `Error.message`；`jsx-a11y`。注意：透明度修饰的禁用名单漏了 `surface-3`、`badge`、`badge-fg`，却含不存在的 `unread`、`unread-fg`（`.eslintrc.cjs:37`）。 | `apps/web/.eslintrc.cjs:7-125,138-185`。 | §9.1 前言、§18.1 | S2 |
| M08 | **令牌测试**：生成块与 `dist/tokens.css` 逐字节一致；Tailwind 刻度等于令牌表；每个颜色角色浅/深各定义一次且生成块之外不得重定义；源码中不得出现十六进制或 `rgb()/hsl()/oklch()` 字面量（具名例外 6 个文件：`OfficePreview`、`AnomalyMapView`、`FitsView`、`MeshView`、`QCodeView`、`lib/xlsx.ts`，`designTokens.test.ts:58-66`）；字号集合恰为九个；衬线恰为三档且不进无衬线栈；拉丁衬线只发 2 个字重、不带 CJK 衬线网页字体；图标线宽读令牌；焦点用 `outline` 且无 `outline: none`；减少动态保留淡出；等宽区关闭 autospace；z 层有名字；`components/ui` 内不得有 `focus:ring-`。令牌版本随产物字节走：`release.json` 记录摘要，字节变而版本不变则 `tokens:check` 失败。 | `apps/web/src/app/designTokens.test.ts:90-288`；`packages/design-tokens/src/release.json`；`DESIGN.md:36-42`。 | §10 开头 + §20.1 | S2 |
| M09 | **文案闸门**：引号用 “ ” 与 ‘ ’，不用 「」『』；状态写『正在 + 动词』且不带省略号，不写『加载中/处理中/思考中』；界面文案中文与拉丁字母/数字之间手打半角空格（日期除外）；循证 GEO 的中文只用 400/600（不用 `font-medium/bold`）。 | `app/copyRules.test.ts:25-127`（扫描整个外壳的字符串字面量与 JSX 文本）。 | §9.4、§18.4 | S2 |
| M10 | **原生 `title` 提示被禁**（Tooltip 是唯一提示层；`iframe`、`abbr` 例外）；运行 id、会话 id、模型名、大写能力键不得作为对话行的领衔文字。注意 `RunStatusDot.tsx:35` 用属性展开绕过了前者。 | `app/nativeTitles.test.ts`；`app/vocabulary.test.tsx`。 | §9.1 Tooltip 行、§18.4 | S3 |
| M11 | **Tooltip / Toast 的现行参数**：Tooltip 300 ms 显示（键盘聚焦立即）、100 ms 消失、Esc 关闭、指针可移入、≤ 40 字、最宽 280、`z-tooltip`、触屏不出现；Toast 成功 5 s、带操作 10 s、错误常驻、≤ 3 条、悬停/聚焦暂停、底部居中距底 24、`z-toast`、`shadow-e2`、成功 `role=status`/错误 `role=alert`。 | `packages/design-tokens/src/index.mjs:804,812`；`components/ui/Tooltip.tsx`；`components/ui/Toaster.tsx`；`lib/toast.ts:31-42`。 | §9.1 Tooltip / Toast 行；§10.4 | S3 |
| M12 | **ScrollRegion 与冻结列**：横向滚动的表/热力格/Markdown 表（`DataTable`、`HeatGrid`）冻结行标题列；溢出时容器变成带名称、可聚焦的 `role=region`（否则 WebKit/Firefox 键盘读者无法移动宽表），不溢出则不占 Tab 停靠点。 | `components/ui/ScrollRegion.tsx`；`DataTable.tsx:124-137,174,194`；`DESIGN.md:301-302`；`ui-walk.mjs:740-743`。 | §5.1 宽表行、§9.3、§19.1 | S2 |
| M13 | **颜色配额与禁用项**：一屏至多三种『有颜色的元素』（非灰黑白的：主按钮、状态标签、核对标记、一张图表整张算一个），第四个要设计评审；红色只给危险与未处理；卡片不上色、不加彩色边/顶条；图标不上色块；渐变只有会员卡一处，禁渐变文字/发光/流光；不用 emoji、不用 `Sparkles`；列表胜过卡片墙；Tag 的 `accent`/`warn` 色仅限前沿热榜的『新』『升温』。 | `DESIGN.md:454-455,376-382`；规范 v2.1 §4.7 L546-555、§8.2 L908-909、§20.4 L2189-2204；`Tag.tsx:3-12`。『三种』目前无机器检查，靠评审（v2.1 §37.1 #3）；走查的 colours ≤ 5 是另一个量（文字颜色种类）。 | §10.1 末尾、§10.5 | S2 |
| M14 | **文字规则**：`text-3` 是能承载文字的最浅色，`text-graphic` 永不承载文字；不用纯黑/纯白做正文；界面行高 = 字号 + 8，阅读正文 1.75；`font-synthesis-weight: none`（不合成粗体）；`text-autospace: normal` 补 AI 正文中西文间距，代码/标识符 `no-autospace` + `text-spacing-trim: space-all`；数字等宽并右对齐；标点字体 `EviMed CJK Punct`（只含 “ ” ‘ ’ …… ——，`local()` 不下发字体文件）；`lang="en"` 文本用不含它的字体栈；标识符（DOI/PMID/NCT/run id）用 JetBrains Mono；中文不加字距、不大写；网页字体只有 Inter 400/500/600、JetBrains Mono 400/500、Source Serif 4 400/600（均为拉丁子集），中文走系统字体。 | `index.css:1-13,505-560`；`index.mjs:477-582`；`DESIGN.md:152-246`；规范 v2.1 §5.1–§5.5、§34.5 L3844-3849。 | §10.2 | S2 |
| M15 | **对话内核框的视觉边界**：外壳与内核页面同窗口，『外壳向内核看齐』；颜色与字体经 `overrideTokens`（60 个 `--dsw-*` 变量，仅颜色与字体族）进入框内，**内核几何（圆角、间距）没有令牌**，外壳触及的部分写在与内核版本绑定的样式里（`runtimeUiShell.mjs`：隐藏内核自己的 280 px 侧栏列 `_sidebarCol`、重排网格、禁横向滚动……）；标点字体的 `@font-face` 已随主题注入框内（`runtimeUiFrame.mjs:103`，`DESIGN.md:509-511` 的 Known gap 已过时）；内核升级时复核。 | `DESIGN.md:3-6,505-511`；`packages/design-tokens/src/kernel.mjs`；`packages/harness-port/src/runtimeUiFrame.mjs:95-103`、`runtimeUiShell.mjs:143-175`；规范 v2.1 §10.10、§34.6。 | §4.2『对话工作区』行 + §10 开头加一段『内核框』 | S2 |
| M16 | **侧栏现行行为**：默认 232、184–340 可拖动或键盘调整（分隔条 `role=separator`，←/→ 16 px、Shift 64、Home/End、Enter 收起）、拖到 < 140 自动收起、宽度与收起状态按设备记住、`<1024` 为覆盖式抽屉（≤ 85% 视口，遮罩/Esc 关闭）、折叠后 `inert` 且焦点回到『展开侧边栏』按钮、Ctrl/⌘+B 切换。 | `lib/store.ts:5-12,63-70`；`Sidebar.tsx:33,117-282`；`AppShell.tsx:82-124,181-206`。 | §4.1 全局侧栏行；§10.3 | S1（见 10.3-e） |
| M17 | **无障碍现行机制**：每页第一个 Tab 停靠点『跳到主要内容』（`z-skip`，嵌入模式不渲染）；焦点环 2 px outline、偏移 2；强制色层（`Highlight` 焦点、系统边框、选中态下划线、`data-forced-colors="preserve"`）；`prefers-contrast: more` 层（text-2/text-3/text-graphic 与三种描边各加深一级）；`prefers-reduced-motion`；`<html lang="zh-CN">`、`theme-color` 随主题；图表在提高对比度（`prefers-contrast: more`）/强制色或 ≥3 类无直接标注时开启贴花与线型；Input `aria-invalid`+`aria-errormessage`。 | `AppShell.tsx:156-172`；`index.css:425-502,592-631`；`index.html:3-12`；`echartsBase.ts:34-42`；`Input.tsx:101-102`。 | §19.1 表后一段『现行机制』 | S2 |
| M18 | **性能/兼容现行事实**：构建目标 Chromium 109 / Edge 109 / Firefox 115 / Safari 15.4 / iOS 15.4，低于下限显示升级页；React+router 单独分块（约 290 KB，供回访读者跨发布缓存）；24 个路由 `lazy()`；ECharts 只引 `echarts/core` 并按图注册；`LazyMenu`；每页 `<title>`（`页面名 · EviMed`）；无 RUM。 | `vite.config.ts:8-37`；`app/router.tsx:22-45`；`components/charts/echartsBase.ts:1-12`；`components/layout/PageTitle.tsx`。 | §19.2/§19.3 | S3 |
| M19 | **输入控件在 <768 px 为 16 px 字**（防 iOS 聚焦缩放）；搜索框宽 256，手机占满栏宽；图标按钮与筛选胶囊触屏热区加宽（见 19.1-f）；菜单项 32。 | `Input.tsx:26`、`SearchInput.tsx:57-60`、`IconButton.tsx:48-50`、`FilterChips.tsx:34`、`Menu.tsx:126`。 | §9.2、§19.1 | S3 |
| M20 | **打印**：`@media print` 只印报告的浅色副本（`[data-print-root]`，`beforeprint` 时挂载），页面白底、边距 16 mm × 18 mm、正文 11 pt、标题/表/引用块/图不分页；无头 PDF 渲染器若不触发 `beforeprint` 会印出外壳。 | `index.css:653-687`；`DESIGN.md:446-448,516-517`。 | §8.5（已有『浅色打印副本』一句，可补参数与已知缺口） | S3 |
| M21 | **嵌入模式**：`?embed=1`（或 wujie 容器）下外壳只渲染内容区，不画侧栏、项目栏与快捷键面板；跳转链接亦不渲染。 | `DESIGN.md:416-419`；`AppShell.tsx:166-181,214-216`。 | §3.3 已有『嵌入时不能叠加第二个侧栏』，可加参数名 | S3 |
| M22 | **改令牌 / 改组件的流程矩阵**：刻度内调整间距、行密度、选版心、Lucide 内换图标 = 直接改；新颜色令牌、色阶明度、新增阻断性视觉状态、一屏第四个有颜色元素 = 设计评审；任何颜色 = 重新计算对比度；图表系列色 = 令牌表、`@ai4s/shared` 的 `CHART_PALETTE_*`、`openscience.mplstyle` 三处同改并重算相邻色差（下限 ΔE 15，现 ≥ 22）；组件外观 = 看新截图并重录基准；其余 = 改令牌表 → `pnpm tokens:build` → 升版本 → `record-release`。 | `DESIGN.md:471-498`；规范 v2.1 §11.4 L1227-1243。 | §20.1、§21.2 | S3 |
| M23 | **上游陈旧项（本文若照抄会继承）**：①`DESIGN.md:274` 侧栏 280/56（实为 232/0，见 10.3-e）；②`:263` 宽版 1280（未实现，10.3-d）；③`:263` 三栏知识库（R11 为单列表 + 抽屉，4.2-b）；④`:445-446` <768 边距 16（未实现，5.1-a）；⑤`:131` 『所有圆点 ≥ 3:1』（已取消圆点 2.69，19.1-c）；⑥`:316-317` 『无处使用浏览器 title』（`RunStatusDot` 仍用）；⑦`:512-513` ECharts 要宿主自己关动画（`echartsBase.ts` 已处理）；⑧`:509-511` 标点字体未注入内核框（`runtimeUiFrame.mjs:103` 已注入）；⑨`:428` 把 `QualityNotices` 列为签名组件，R11 **没有这个组件**，只剩 `lib/qualityNotices.ts` 里给收件箱用的 `splitNoticeBody`，渲染规则（安全=危险色+盾牌永不折叠；必须修改=琥珀；提示=折叠一行）见 v2.1 §22.4；⑩`:12` 写『v2.0』而规范已是 2.1；⑪`:502-503` 『`text-ui-sm` 是别名不是错误』——ESLint 已拒绝它（`.eslintrc.cjs:49-51`）且代码零使用（`max-w-content-full` 仍是别名，在 `RunFilePage.tsx:187`、`ReportReader.tsx:305` 使用）；⑫令牌 `note` 字段陈旧：`text-graphic` 写 2.90（实测 2.69）、`accent-strong` 写 9.93（实测 9.44）、`accent` 写『白字 6.24』（实测 6.27）（`index.mjs:245,250,257`），本文若引用请以 `contrast.mjs` 实算为准。 | 各条已注行号。 | §1.1 说明『DESIGN.md 本身有已知陈旧项，冲突以令牌表与代码为准』 | S2 |

---

## 3. 与 v2.1 规范的关系

规范：`docs/superpowers/specs/2026-09-26-design-system-assets/build/combined.md`（5100 行，版本 2.1，2026-09-27 发布，取代 2.0；令牌 2.1.1；**未入库**，`DESIGN.md:11-12` 自称『defers to it』；该规范在 combined.md:48-57 规定『规则以本文为准，DESIGN.md 与正文不一致时改 DESIGN.md』）。10-08 文档全文**一次也没有提到它**，第 22 节的参考资料表也没有。

### 3.1 10-08 文档与 v2.1 重复（未注明出处）的内容

| 10-08 节 | v2.1 对应 | 说明 |
|---|---|---|
| §4.1 页头一行、无副标题、至多一个主操作 + 两个图标按钮或搜索框 | §6.6 L774-782；§16.5-7 L1799；§37.1 #1 | 文字几乎照搬；『或』的歧义同源（见 4.1-b） |
| §4.2/§10.3 三种版心 | §6.2 L699-717 | 数值同；v2.1 另有『窄 560』『回答页 720 + 来源栏 280–320（≥1280）』『width=full』，本文只在 §10.3 给了 read/page/wide |
| §4.4 先间距、再底色、最后线；至多一层带边框容器 | §6.4-2 L749；§7.2-3 L842；§16.5-8 L1800 | 同 |
| §5.1 断点、<1024 抽屉、<768 边距 16、不缩字号 | §6.5 L752-770；§6.1 L697；§6.2-2 L714 | 同；320 px 重排、验收宽度也出自此处 |
| §5.2 滚动约定（流式跟随、更新提示、固定区不遮焦点） | §6.8 L795-804；§9.4-3 L1028；§10.8-3 L1121 | 同 |
| §5.3 层级与 Esc | §22.7 L2543；§10.3-7 L1074 | 同 |
| §9.1 组件表 | §17–§22 各组件规格 | 本文是缩写，丢了尺寸、角色、文案规则 |
| §10.1 颜色规则（含『不反相』） | §4.3–§4.8（反相禁令在 §4.7-10 L555、§4.8-6 L564，DESIGN.md 里没有） | 同 |
| §10.2 字号表与行宽 | §5.2 L605-632；§5.4 L640-648 | 数值同；本文缺字重列与三档 |
| §10.3 间距/圆角/高度/图标/阴影 | §6.4、§7.1、§16.3、§8.1、§7.3 | 数值同 |
| §10.4 动效与层级 | §9.2、§9.5、§7.4 | 同；本文缺 z 数值与组件动效表（§9.3） |
| §10.5 品牌预算 | §3.5 L383-398、§4.7-9 | 同 |
| §11.3 图表色 | §32.4 L3570-3597；§32.13 L3661-3668 | 同 |
| §19.1 WCAG 2.2 AA、24×24、重排 | §10.1–§10.6 | 同；对比度与 44×44 处措辞不同（见下） |
| §19.2 Web Vitals 阈值 | §34.4 L3834-3842；§2.3 L302 | 同 |
| §20.1 视觉调整附前后截图 | §11.4 L1235；§36.2 | 同 |
| §20.4 视口与样本 | §6.5-5 L770；§37.3 L4073-4081 | 本文是子集 |
| §18.4 文案 | §12–§14 | 本文只摘一页 |
| §18.5 帮助信息放置 | §12.4 L1334 | 同 |

### 3.2 10-08 文档与 v2.1 的冲突

| # | 10-08 | v2.1 | 评语 |
|---|---|---|---|
| C1 | §3.5 L146：搜索框"应注明范围，例如『搜索本项目资料』" | §18.3-2 L1972：占位文字就是它的名字，一个词（『搜索』『搜索工具』『搜索记忆』），不写长句 | R11 的 `SearchInput` 注释（`SearchInput.tsx:12-13`）与 17 处用法站在 v2.1 一边 |
| C2 | §19.1 L803：『大字至少 3:1』 | §4.9 L579：不借用大字号 3:1 放宽，所有文字角色 ≥ 4.5:1 | 见 19.1-b |
| C3 | §19.1 L807：主要触摸操作 44×44（产品目标） | §10.5-1 L1096：触屏上主要操作与图标按钮热区 ≥ 44×44（规则，不是目标）；§16.3-2 L1774 更宽：所有可点击目标 | 措辞与 §10.5-1 一致，但 v2.1 把它写成规则；DESIGN.md 只有 40，代码 32×40/40×44（见 19.1-f） |
| C4 | §20.4 L877：1440×900 + 768×1024 + 390×844；320 重排 | §6.5-5 L770：320/390/768/1024/1280/1440/1512/1920 + 200% 缩放；§37.1 #14 L4048：设计评审看 1440 与 390 | 本文的三档两头不靠；自动化实际是 1512×945 与 390×844 |
| C5 | §4.1 L154：页头『一个主要按钮与两个图标操作，或一个搜索框』 | §6.6 L774：『至多一个主操作，外加至多两个图标按钮或一个搜索框』 | v2.1 的结构是 主操作 +（图标×2 或搜索框）；本文的逗号把它读成互斥（R11 知识库页头 = 搜索框 + 主按钮） |
| C6 | §20.5 L885：自动化『无障碍自动检测结合键盘和辅助技术抽查』 | §10.11 L1149、§34.7 L3871：Playwright + axe-core，**必须开启 WCAG 2.2 标签**，每个关键状态扫描，有违规即失败 | 仓库里没有这个扫描（见 20.5-a）；两处都需要如实写 |
| C7 | §9.1 L385：危险操作初始焦点在取消 | §22.7 L2543-2545：确认框焦点移到『取消』；Enter 只触发获得焦点的按钮 | 一致，R11 实现对两种 tone 都如此（9.1-l）；本文可加『Enter 不被全局映射为确认』 |
| C8 | §3.5 L148：全局命令面板属于探索项，`/` 等单字符键在输入框内不触发 | §10.3-6 L1073：『没有命令面板』，全部快捷键 = Ctrl/⌘+B、`?`、Esc | 不矛盾，但规范已明确现行没有；R11 `components/command-palette/` 是空目录 |

### 3.3 10-08 文档遗漏、而 v2.1 有的规则（节选，按对设计评审的影响排序）

| v2.1 位置 | 规则 | 10-08 对应处 |
|---|---|---|
| §4.7-4 L549、§37.1 #3 | 一屏至多三种有颜色的元素 | 无 |
| §4.7-7/8/9 L552-554 | 卡片不上色；图标不上色块（科研工具四组例外，但 R11/DESIGN.md 已取消该例外）；渐变只有会员卡一处 | 无 |
| §7.2 L840-847 | 1 px 一种线宽；两种描边色不互换；表格不画竖线与外框；虚线只用于文件拖放区与图表目标线；左侧彩色竖条只给提示与引用块 | §4.4 只取了前两条的意思 |
| §7.3 L860-862 | 禁用框架默认阴影和手写阴影；悬停不加阴影 | §10.3 只写 e1/e2/e3 |
| §7.5 L888 | 不透明度只用三处：禁用 40%、遮罩、拖动 80% | 无 |
| §8.2 L908-909、§8.3 L913-915 | 禁 emoji、禁 `Sparkles`；纯图标按钮只给通用动作，有后果的动作带文字；名称写『动作 + 对象』 | §9.1 IconButton 一行未涉及 |
| §5.2 L629、§5.3 L637 | 每页 ≤ 4 组字号×字重；中文层级只用 400/600，500 不能单独区分 | 已有简写，缺『500 在雅黑上显示为 400』的理由 |
| §5.5 L650-657 | 中西文混排四条（手打半角空格及例外、AI 正文逐字、`text-autospace`、数值与单位间用 U+00A0） | §18.4 一句『遵循现有空格规范』 |
| §9.3 L1003-1020 | 组件动效表（对话框 98%→100%、页签不做滑动指示条、路由切换无过渡、骨架 2 s 周期、图表入场 ≤ 320 且更新不重播） | 无 |
| §9.4 L1022-1029 | 流式输出按块追加（100–200 ms 合批），不做打字机效果 | 无（§5.2 只有跟随规则） |
| §10.3-8 L1075 | 路由切换后先更新标题，再把焦点移到新页面 h1；仅改地址参数不移焦点 | §5.3 只有『焦点策略不同』一句 |
| §10.4 L1078-1092 | 地标命名、每条回答以隐藏标题开头、状态播报区、流式回答不进 live region | §19.1 末段一句 |
| §10.9 L1123-1133 | 强制色/提高对比度兜底层的具体规则 | §19.1 只提到『沿用』 |
| §17.1 L1850-1857 | 按钮文案『动词 + 对象』≤ 6 字、禁『确定/好的』确认不可撤销操作、文字不截断不换行 | §6.2 只有『开始研究/生成草稿/保存』语义 |
| §17.3 L1883-1893 | 正文链接必须加下划线；外链新标签 + `ExternalLink` 图标 + 名称末尾『（在新标签页打开）』 | 无 |
| §17.4 L1910-1915 | 菜单 5–15 项，只有一层不做子菜单，不可用项置灰并说明原因 | 无 |
| §20.1 L2158-2161 | 页签最多 7 个、放不下横向滚动不折行、选中态写 `?tab=` | §9.1 Tabs 行有『URL』 |
| §22.1 L2451-2467 | Toast 不用于临床安全/表单校验/引文核对；文字 ≤ 20 字；操作须在别处也能完成 | 无 |
| §22.7 L2534-2544 | 对话框宽 400/560/720，窄于 480 全屏；有未保存输入先问『放弃未保存的修改？』 | 无 |
| §28.2 L3177-3190 | 等待时间阈值：0–300 ms 不显示加载指示；300 ms–2 s 控件内；骨架屏预期 10 s 内；任何前端计时不得宣告失败 | §19.3 只写『立即反馈』 |
| §32.2–§32.12 | 图表禁用项、数值轴从 0、对数轴、两个字号、禁双轴、迷你走势、看板布局 | §11.2 只给选图表 |
| §34.3–§34.5 | 浏览器下限/设计验收基线（Chromium ≥ 109 / ≥ 111；iOS ≥ 15.4 / ≥ 16.4）、字体加载（`font-display: swap`、首屏只预加载 Inter 400） | §19.2/§19.3 无 |

### 3.4 v2.1 自身相对 R11 已陈旧的地方（行号为 combined.md）

| # | v2.1 位置 | v2.1 说法 | R11 现实 |
|---|---|---|---|
| S-1 | L176、L692、L2221 | 侧栏宽 280，收起为 56 | 默认 232，收起为 0（`store.ts:10-12`，`Sidebar.tsx:182`）；280 是被外壳隐藏的内核侧栏列 |
| S-2 | L709、L760 | 宽版 ≥1440 时 1280 | 无任何实现（10.3-d） |
| S-3 | L714、L764 | <768 页边距 16 | 未实现；`PageShell` 恒 24，报告阅读器在 640 以下才改 16 |
| S-4 | L709、L3012-3015 | 『三栏知识库』『三栏页』 | R11 知识库是单列表 + 右侧抽屉（页面结构 第 1、2 条，2026-10-07 晚于 v2.1） |
| S-5 | L1081 | 侧栏 `<nav aria-label="主导航">` | `<aside aria-label="侧栏">` 内含 `<nav aria-label="工作台">`（`Sidebar.tsx:169,196`），走查要求恰有一个 `aside[aria-label=侧栏]`（`ui-walk.mjs:648,734`） |
| S-6 | L1075 | 路由切换后焦点移到新页面 h1 | 未实现（`AppShell` 只在点跳转链接时聚焦 `<main>`） |
| S-7 | L1149、L3871 | Playwright + axe-core（带 WCAG 2.2 标签）扫描 | 仓库中没有 |
| S-8 | L3664-3665 | 每张图提供『查看数据』切换与键盘逐点移动 | `TrendChart` 没有 |
| S-9 | L3672-3674 | 默认 SVG 渲染，>1000 图元换 Canvas | `echartsBase.ts` 只注册 `CanvasRenderer` |
| S-10 | L2526 | 所有运行状态记号 ≥ 3:1 | 『已取消』圆点 2.69/2.71（浅/深） |
| S-11 | L1096、L1774 | 触屏上主要操作与图标按钮（§16.3-2：所有可点击目标）44×44 | 仅图标按钮 32×40/40×44 与筛选胶囊高 40 |
| S-12 | L790、L1905 | 菜单项触屏 44 | `Menu` 恒 32 |
| S-13 | L3836-3837 | `web-vitals` 按路由采集 | 无 |
| S-14 | L553 | 科研工具四组各用一种图标底色 | R11 与 DESIGN.md:381-382 都已无彩色图标块（`CapabilitiesPage.tsx:232` 图标仅 `text-accent`） |
| S-15 | L20 | 令牌 2.1.1 | 2.1.2（2.1.2 把『我方』系列色拆成浅/深两值：`CHART_OWN`） |
| S-16 | L2540 | 对话框圆角 16 | 4 个 GEO 手写对话框是 12（`MembersDialog.tsx:79` 等，10.3-f） |
| S-17 | L2570 | 『代码中不再有原生 title』 | `RunStatusDot.tsx:35` 仍有 |


---

## 4. 建议的第 10 节替换稿（令牌 2.1.2）

> 以下为可直接替换原 §10 的正文。数值逐项取自 `packages/design-tokens/src/index.mjs`（2.1.2）并经实算核对；"执行"列标出违反时由谁拦住：**T** = `designTokens.test.ts` / 令牌包测试（`pnpm tokens:check`、`pnpm test:tokens`）；**L** = ESLint（`apps/web/.eslintrc.cjs`）；**W** = 上线走查 `scripts/ops/ui-walk.mjs`（桌面 1512 × 945、手机 390 × 844；F = 失败，N = 仅提示）；**G** = 组件陈列页比对 `pnpm gallery:check`（差异 > 0.5% 失败，浅、深各一张基准）；**C** = 对比度构建闸门 `contrast.mjs`；**X** = 文案与词汇测试（`copyRules` / `retiredWords` / `nativeTitles` / `vocabulary`）；**R** = 只有评审，无机器检查。

## 10 视觉与排版

本节是现行设计系统的引用快照。数值唯一来源是 `packages/design-tokens/src/index.mjs`（2.1.2）；`DESIGN.md` 与《EviMed 前端设计规范 v2.1》是它的文字说明。本文不新增令牌，也不从本表反向创建常量。令牌源文件里个别 `note` 注释（如 `text-graphic` "2.90"）已陈旧，对比度以 `contrast.mjs` 实算为准。对话工作区是嵌入的内核页面：外壳只把颜色与字体族（60 个 `--dsw-*` 变量）经 `overrideTokens` 传进去，内核几何没有令牌，外壳向内核看齐。

### 10.1 颜色与主题

| 角色 | 浅色 | 深色 | 用途与限制 | 执行 |
|---|---|---|---|---|
| `bg` | `#fafbfc` | `#0f1318` | 页面底，比白略灰，白卡不描边也有边界 | T C |
| `surface` | `#ffffff` | `#161b21` | 卡片、对话框、菜单、弹出层、阅读栏 | T C |
| `surface-1` | `#f5f7f9` | `#161b21` | 侧栏、表头、内嵌轨道、代码块 | T C |
| `surface-2` | `#edf0f3` | `#1e242b` | 悬停、中性选中行、骨架条、次按钮底 | T |
| `surface-3` | `#e4e8ec` | `#262d35` | 已在 surface-2 上的元素的悬停与按下 | T |
| `scrim` | 32% `#0f1318` | 56% 黑 | 对话框、抽屉后的遮罩 | T |
| `border-hairline` / `faint` / `light` | `#e4e8ec` / `#edf0f3` / `#d6dce2` | `#262d35` / `#1e242b` / `#262d35` | 装饰线（分隔、卡片边、列表内最弱的线、已靠底色区分的胶囊） | T |
| `border-control` | `#858e97` | `#646e78` | 控件的可见边界，≥ 3:1（画布 3.21，侧栏 3.10） | C |
| `text` | `#1a1f25` | `#eef1f4` | 正文与标题，16.00:1 | C |
| `text-2` | `#3e454d` | `#c3cad2` | 次要文字，9.37:1 | C |
| `text-3` | `#5f686f` | `#8d96a0` | 元信息，5.48:1；能承载文字的最浅色（内嵌轨道上 4.61:1） | C |
| `text-graphic` | `#939ca6` | `#535b64` | 只用于图标与线条，2.69:1；绝不承载文字，也不用于承载含义的状态记号 | R |
| `accent` | `#0a5dc1` | `#5f97e0` | 主按钮、链接、焦点环、✓ 核对标记、图表中的"我方"；白字在其上 6.27:1 | C |
| `accent-fg` | `#ffffff` | `#0f1318` | 强调色实底上的文字与图标（不得写死白字） | C |
| `accent-soft` / `accent-strong` | `#eef4fc` / `#0c3e7f` | `#0a1f3e` / `#8fb5ea` | 选中行与当前导航项的底 / 其上的文字（9.44:1）；`accent-soft` 绝不作文字色 | C |
| `accent-pressed` | `#0a4da0` | `#8fb5ea` | 强调色表面的悬停与按下 | T |
| `ok` | `#1c7347` | `#7cc0a0` | 已完成、已通过；不等于"证据已核实" | C |
| `warn`（`warn-strong`） | `#985600`（`#7f4800`） | `#e0b169`（`#e0b169`） | 待核对、需要留意；一般不确定性不升级为红色 | C |
| `error` = `danger`（`danger-strong`） | `#bc342a`（`#9a2a22`） | `#e0877f`（`#e0877f`） | 临床安全、破坏性操作、错误、未读徽标、"未完成"记号 | C |
| `verify-ok` / `verify-pending` | `#0a5dc1` / `#985600` | `#8fb5ea` / `#e0b169` | ✓（引文与保存原文一致）用品牌蓝，⚠（待核对）用琥珀；✓ 不用绿，⚠ 不用红 | R |
| `highlight` | `#fdeba8` | `#7f4800` | 原文引语定位、检索命中；其上正文 ≥ 4.5:1 | C |

规则：
1. 一个强调色，链接也用它；主按钮靠"实心"与其他按钮区分，不靠换色相。**R**
2. 红色只给危险与未处理；"待核对"是琥珀；`ok` 不是核对标记。**R**
3. 每个状态说三遍：颜色、形状、文字。运行状态：进行中＝脉冲圆点（品牌蓝）、已完成＝实心圆（绿）、已完成有提示＝菱形（琥珀）、未完成＝方形（红）、已取消＝空心圆（灰）。**R**
4. 一屏至多三种"有颜色的元素"（非灰黑白：主按钮、状态标签、核对标记、一张图表整张算一个），第四个须经设计评审；上线走查另限文字颜色种类（见 10.5）。**R / W**
5. 不写字面色值（`#…`、`rgb()`、`hsl()`、`oklch()`；具名例外共 6 个文件：Office 预览、异常图与 FITS 两个固定深色画布、Mesh 的 WebGL 背景、QCode 的标签色、xlsx 默认边框）；不给令牌色加透明度修饰（`bg-accent/10` 不生成样式，需要浅色用 `-soft`/`-strong`）。**T L**
6. 主题三态（浅色 / 深色 / 跟随系统），首帧前由 `public/theme-init.js` 写 `data-theme`，每个主题块声明 `color-scheme`；深色是同一角色指向另一级而非反相，不对图片和整页加滤镜；报告里的图与打印始终白底。**T R**
7. 对比度：所有文字角色在所有表面上 ≥ 4.5:1（不借用大字 3:1 的放宽）；控件边界、焦点环、承载含义的图形 ≥ 3:1；33 组 × 浅/深 × 标准/提高对比度共 132 项在令牌构建期实算（另有 13 项数据色图形：我方 4、对手灰 9），不四舍五入。**C**

### 10.2 字体与字号

字体栈（无衬线）：`"EviMed CJK Punct", Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif`。"EviMed CJK Punct" 只含 “ ” ‘ ’ …… —— 五个码位，取自读者系统里的中文字体，不下发字体文件；`lang="en"` 的文字用不含它的栈。衬线栈只用于 `wordmark`、`hero`、`doc-title` 三档；等宽（JetBrains Mono）只用于 DOI、PMID、NCT、run id 与代码。网页字体仅 Inter 400/500/600、JetBrains Mono 400/500、Source Serif 4 400/600（拉丁子集），中文走系统字体。**T L**

| 档位 | 字号 / 行高 | 字重 | 用途 |
|---|---|---|---|
| `badge` | 12 / 1 | 400·600 | 胶囊里的计数 |
| `meta` | 12 / 1.5 | 400 | 日期、期刊、计数、图例 |
| `caption` | 12 / 20 px | 400 | 说明与次要单行 |
| `compact` | 13 / 20 px | 400 | 小号控件、筛选胶囊、数据页密集表格 |
| `ui` | **14 / 22 px** | 400·600 | 界面文字、对话、列表行、控件——默认 |
| `body` | 16 / 1.75 | 400 | 报告正文与阅读栏 |
| `wordmark` | 16 / 1.3，衬线 | 600 | 侧栏字标 |
| `section` | 18 / 26 px | 600 | 回答与报告中的小节标题 |
| `heading` | 20 / 28 px | 600 | 数据页的卡片标题、预览窗中的文档标题 |
| `title` | 24 / 32 px | 600 | 每页 H1 |
| `doc-title` | 24 / 34 px，衬线 | 600 | 报告、文章、证据卡的标题 |
| `display` | 24 / 1.3 | 600 | 登录页、整页空状态 |
| `metric` | 32 / 40 px | 600 | KPI 数字——仅数据页 |
| `metric-lg` | 40 / 48 px | 600 | 看板唯一的主指标——仅数据页 |
| `hero` | 40 / 50 px，衬线 | 600 | 首页大标题——全产品一处（React 外壳目前无此用法） |

规则：
- 字号集合封闭为九个（12 / 13 / 14 / 16 / 18 / 20 / 24 / 32 / 40），第十个即缺陷；以 rem 输出，浏览器默认字号设置随之生效；不禁用缩放。**T L**
- 字重只有 400 / 500 / 600；中文层级用 400 与 600 区分（雅黑没有 500，500 显示为 400），500 只用于拉丁字母与数字或与颜色、字号一起出现；循证 GEO 页由测试强制。**X R**
- 每页至多四种"字号 × 字重"组合；上线走查逐页统计并报告，目前只提示不拦截。**W-N**
- 一行多行文字不超过 40 个汉字：`max-w-measure` 560（14 px）/ `max-w-measure-body` 640（16 px）。**R**
- 中文不加字距、不转大写；数字用等宽数字并右对齐；界面文案中西文间手打半角空格，AI 正文与引文逐字不动（由 `text-autospace: normal` 补间距）；输入框文字在窄于 768 px 时为 16 px（防 iOS 聚焦放大）。**X R**

### 10.3 空间与几何

| 项目 | 现行规则 | 执行 |
|---|---|---|
| 间距刻度 | 4、8、12、16、20、24、32、40、48、64；组内 8，组间 16–24，章节间 32–48 | R |
| 页面与卡片 | 页面边距 24（`PageShell` 全宽度固定；报告阅读器在 640 px 以下为 16）；卡片内边距 16（紧凑 12）；网格间距 12 | R |
| 版心（`PageShell`） | `page` 1040（默认）· `wide` 1200（`width="wide"`）· `full`（自排版，仍留边距）；阅读版心 `read` 720 供阅读页使用（`PageShell` 尚无此档，报告阅读器经 `max-w-content` 取得）；`narrow` 560 用于抽屉里的表单；令牌另定义 `wide-max` 1280（规范意图：视口 ≥ 1440 时的数据版心），目前没有页面使用 | T（数值）W（一条左边线） |
| 行宽 | `measure` 560 / `measure-body` 640 | R |
| 侧栏 | 默认 232，可拖动或用键盘在 184–340 之间调整（分隔条为 `separator`，←/→ 16 px，Shift 64，Home/End，Enter 收起），拖到 140 以下自动收起；收起后宽度为 0 并 `inert`，主区顶部留"展开侧边栏"按钮；窄于 1024 时为覆盖式抽屉（≤ 视口 85%，遮罩与 Esc 关闭）。令牌里的 280 / 56 是对话内核自己的侧栏尺寸，外壳已将其隐藏 | W（唯一 `aside` 地标、手机折叠须 `inert`） |
| 圆角 | 标签 6；按钮、输入框、行、菜单项 8；卡片、弹出层、菜单、Toast、Tooltip 12；对话框与面板 16（右侧抽屉贴边，无圆角）；全站输入框 24；筛选胶囊、圆点、开关、未读徽标全圆 | L（禁任意值） |
| 控件高度 | 小 28 · 默认 36 · 主要表单动作 44 · 标签 22（`h-sm / h-control / h-form-primary / h-tag`）；同一行控件等高；例外：菜单项 32、页签 40 | R W（控件种类预算） |
| 图标 | Lucide；16（与文字同行）/ 20（无文字的外壳图标）；线宽统一 1.5，由样式表读令牌 | T L |
| 描边 | 全产品一种线宽 1 px；装饰线用 `border-hairline`，控件边界用 `border-control`；至多一层带边框的容器；卡片标题下不画线；表格只画表头下线与行间淡线 | W（边框种类 ≤ 3）R |
| 阴影 | 静态卡片无阴影；`e1` 确实浮起的卡片；`e2` 输入组合区、菜单、弹出层、Toast；`e3` 对话框、抽屉。禁用 `shadow-sm/md/lg` 与 `shadow-card`（任意手写阴影靠评审） | L |

### 10.4 动效与层级

| 项目 | 现行规则 | 执行 |
|---|---|---|
| 时长 | `fast` 120 ms（状态变化）· `base` 200 ms（容器）· `slow` 320 ms（页面级）；进入 `cubic-bezier(0.2, 0.8, 0.2, 1)`，退出 `cubic-bezier(0.3, 0, 1, 1)` | T |
| 位移 | 抽屉 24 px，Toast 8 px，菜单 4 px；不做弹跳、视差、循环装饰动画；只对 `transform` 与 `opacity` 做动画（侧栏宽度过渡是唯一例外） | T R |
| 减少动态效果 | 位移归零，`base`/`slow` 降为 120 ms，只保留颜色与透明度过渡，循环动画只播一次，旋转图标静止；图表根级与每个系列设 `animation: false` | T |
| 焦点环 | 2 px `outline`，偏移 2 px，颜色 `--focus`；文本框改边框变色 + 1 px 内环；禁止用 `box-shadow`/`ring-*` | T |
| Tooltip | 悬停 300 ms 或键盘聚焦立即显示，离开 100 ms 消失，Esc 关闭，指针可移入；≤ 40 字、最宽 280；触屏不出现，故不得是任何信息的唯一载体 | X R |
| Toast | 成功 5 s，带操作 10 s，错误不自动消失；同时至多 3 条，悬停或聚焦暂停；底部居中距底 24 | R |
| 层级 | `page` 0 · `sticky` 10 · `drawer` 40 · `modal` 50 · `popover` 60 · `toast` 70 · `tooltip` 80 · `skip` 90；遮挡问题靠放进正确的层解决，不加大数字 | T（层名存在）R（数字写法尚无 lint） |
| 不透明度 | 只用于禁用（40%）、遮罩、拖动中的元素（80%）；颜色的浅色版本一律用 `-soft` 配对令牌 | L |

### 10.5 品牌表达与走查预算

- 每页至多一个品牌表达重点（渐变、衬线大标题、首页主视觉）。阅读与列表页保持安静；图表与 32/40 指标档位属于数据页。已有特例：首页主标题、文档标题、会员卡的渐变、记忆胶囊"成长"标签页里的单条增长线（历史跨度满两周才绘制，至多三个时刻，无图块、图例与指标档位）。不要把特例推广成每个列表都有图表和大数字。**R**
- 不用彩色卡片、彩色图标块、`Sparkles` 或任何"AI 装饰"；渐变只有会员卡一处。**R**
- 上线走查的样式预算（桌面 1512 × 945；超出为失败，R11 新页面在测得分布前仅提示）：

| 页面类别 | 控件种类 | 文字颜色种类 | 边框种类 |
|---|---|---|---|
| 阅读与一般列表页（默认） | ≤ 8 | ≤ 5 | ≤ 3 |
| 前沿精选 / 热榜 / 日报 / 全部 | ≤ 9 | ≤ 8 | ≤ 3 |
| 前沿证据专区首页 | ≤ 9 | ≤ 8 | ≤ 4 |
| 数据页：知识库、循证 GEO 首页、虚拟临床研究首页 | ≤ 10 | ≤ 7 | ≤ 3 |
| 循证 GEO 项目各页签、虚拟临床研究各页签 | ≤ 10 | ≤ 7 | ≤ 6 |
| 插件、技能列表 | ≤ 9 | ≤ 5 | ≤ 5 |

  另：标题与正文块、列表行标题须在一条左边线上；页面主体的区块种类不得超过 `SECTION_SHAPES_BY_PAGE`（列表型页 2，前沿 3，虚拟临床研究各页签 3）；页头至多一个实心强调色按钮、不得有副标题；每个列表的首行点击必须有结果。**W-F**

<!-- DONE -->
