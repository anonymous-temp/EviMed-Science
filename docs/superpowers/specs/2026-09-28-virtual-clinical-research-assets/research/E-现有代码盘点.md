# E · 现有代码盘点：虚拟临研（2026-09-28，只读）

- **盘点对象**：`main` @ `d94dc6255`，行号均取自当前工作树。
- **另读**：Vue 融合壳 `.evimed-local/evimed-web/evimed-web-feat-research-workflows-migration`（独立仓库，分支 `fusion/evimed-science`，最新提交 `b0d4d07`）。
- **只读**：没有改动、暂存或删除任何东西。
- **写法**：先写"代码里有什么"，再写"缺什么、放哪里"。凡标"建议"的都是推断。
- **行号记法**：同一文件内第二次引用时只写 `:行号`。
- **命名约定**：本文建议的新名字统一用前缀 `vcr`（virtual clinical research），页面路径沿用 v1.0 §15.5 的 `/app/virtual-research`。

---

## 1. 结论先行

1. **v1.0 §15.5 说"没有 GEO 一级路由"，这份代码里不成立。**
   - `apps/web/src/components/sidebar/Sidebar.tsx:77` 定义 `GEO_NAV`（`/app/geo`，雷达图标），`:80-86` 的 `navRows()` 把它插在「科研工具」之后。
   - `apps/web/src/app/router.tsx:80-82` 有三条 GEO 路由。
   - 两者来自提交 `6f8667617`（09-25 07:11）。`Sidebar.test.tsx:144-147` 已把"GEO 紧跟科研工具"写成断言。
   - 所以「虚拟临研」的落点很具体：`navRows()` 里「科研工具」之后先插虚拟临研，再插 GEO；测试改成两段相邻关系。
2. **Vue 融合壳里没有「科研工具」这一行。**
   - Science 页面列在 `src/utils/researchNav.js:18-24` 的 `RESEARCH_NAV` 里：前沿动态 · 知识库 · 记忆胶囊 · 主动科研 · 循证 GEO。
   - 它们排在壳自己的 新建任务 · 科研工作流 · 证据卡片 · 证据专区 之后（`src/components/Sidebar/index.vue:61-146`）。
   - 「科研工具」在这里只是输入框按钮（`EvComposer.vue:202`）。
   - 两个前端要一致，就在 `RESEARCH_NAV` 的 `geo` 之前插入，读同一个 `/api/me` 功能位。上线仍取决于 EviMed 团队合入这个分支（缺口清单 B1）。
3. **GEO 是现成的一级模块模板。**
   - 规模：24 个 `geo*.mjs` 加两个外部客户端，共 26 个文件、16,582 行。
   - 数据与开放：独立 schema `evimed_geo`（25 张表）；开关、开放范围和预览名单经 `/api/me` 的 `features.geo` 下发。
   - 运行时：内部通道 `/internal/geo/v1` 和可选工具 `geo_read` / `geo_write`。
   - 编排：编排器在项目自己的有界运行时里派发能力包，**按落库数据**判断步骤完成；副作用先认领后执行，保证幂等；后台是租约 worker。
   - 分工原则是"AI 想，平台测、平台办"。虚拟临研照抄这个形状，不需要新机制。
4. **确定性统计与模拟引擎基本不存在，这是最大的技术缺口。**
   - 运行时镜像只有 numpy / scipy / pandas / statsmodels / scikit-learn，外加 R 的 `r-base-core`、`r-recommended`；没有 lifelines、MatchIt、metafor、pyarrow、PyMC / Stan。
   - Meta 引擎库能合并比例、率、均数和 HR，也出预测区间，但没有 MAP / 借用，也没有"合并给定数据"的入口。
   - 生产上已经吃过亏（记忆 ganzheng-meta-paper-2026-09-26）：MetaAgent 接不住人工审定的研究集，运行里模型自写的 Python 把 Egger 检验重复加权，预测区间的自由度也用错了。
   - 所以虚拟临研的数字必须出自有数值基准的版本化引擎。
5. **"患者级数据"没有工程边界：设计过，没有建。**
   - DSH 方案 D16（`docs/superpowers/specs/2026-08-22-evimed-dsh-plug-harness-design.md:44`）设计了数据保险库、`public / patient-level` 分级、探索 / 确认分区，要求原始行不进模型上下文；代码里只剩两个无人调用的词表（`packages/domain/src/agenda.mjs:64, 67`）。
   - 今天的表格数据走知识库：CSV/TSV 原样读入并可被检索，XLSX 发往外部解析服务（缺口清单 C1：明文 HTTP 的测试服）。
   - 知识库只读挂进运行时，内核有 `bash`，**原始行可以进入模型上下文**。
6. **只有个人账户，没有组织和角色。**
   - `deploy/web/saas-capability-contract.json:19, 26, 29` 写明 `organizationProfile: null`、`organizationSaasReady: false`、`institutionalComplianceReady: false`。
   - 唯一的"角色"是配置里的 `operatorUsers`，项目只属于一个用户。
   - v1.0 §14 的九类角色和"组织 × 项目 × 用途 × 来源 × 字段 × 时间窗"访问交集都要新建。这部分工作量大于页面。
7. **试验先例几乎没有结构化。**
   - `clinical_trial_search` 走 EviMed API（ChiCTR / CT.gov / Cochrane Central），回退 CT.gov v2 时只取 id / 标题 / 状态 / 疾病 / 干预。
   - 入排标准、分组、终点、结果都没有结构化。
   - ChiCTR 和 WHO ICTRP 直连是 `blocked_no_api`；EviMed 的 v2 试验端点在网关白名单里，但没有任何代码调用。
8. **"报告数字只取自计算结果"还不是机制，只有三处零件。**
   - 闸门里的提示级检查 `dataset-number-provenance`；
   - 独立审阅模块 L3 档里的 `numericTraceability`（该模块默认关闭）；
   - meta 引擎内部的事实包 `core/manuscript_facts.py`。
   - AC-20 应做成"结果 JSON → 模板渲染"。阻断预算 6 个已用完，不宜新增阻断。
9. **重模拟不能放进内核回合，也不宜放在共享生产机上。**
   - 工具调用 180 秒上限（`apps/server/src/dshProfilePatch.mjs:64`）；运行时默认 2 CPU / 8 GB；生产机 4 vCPU / 15 GB，与至少八个产品共用；AgentBay 有代码、生产未开。
   - 建议：新建确定性引擎容器（第 9 层）加控制面租约作业（第 2 层），运行时工具只负责提交和查询。
10. **能力包规矩现成，但 V1 范围远大于 GEO。**
    - 新能力按 `capability.yaml`、SKILL.md、校验器、合约登记、至少 3 条真实 brief 的规矩做，照 GEO 用 `display.listed: false` 隐藏；不能用 `visibility: internal`，否则绑定会 403。
    - 规模对比：GEO 一个模块的控制面约 1.66 万行；虚拟临研还要加引擎、数据平面、组织与角色三块新地基。
    - 建议先交付不含患者级数据的旅程 A（v1.0 §17）。

---

## 2. 逐项盘点

### 2.1 导航与页面

**侧栏**（`Sidebar.tsx`）
- 固定行 `NAV`（`:57-63`）：新对话、科研工具、知识库、记忆胶囊、主动科研。
- 条件行：`FRONTIER_NAV`（`:71`）在「新对话」后；`GEO_NAV`（`:77`）在「科研工具」后。由 `navRows`（`:80-86`）用 `flatMap` 插入。
- 功能位来自 `useFrontierFeature` / `useGeoFeature`（`:95-96`）。
- 项目树 `ProjectBrowser` 用 `useGeoProjectIds` 给 GEO 项目换雷达图标（`ProjectBrowser.tsx:113-118, 492, 581`）。
- **虚拟临研**：加 `VCR_NAV`，在 capabilities 行后依次推入 `[VCR_NAV, GEO_NAV]`；再加一个同形的 `useVcrProjectIds`，让研究项目在项目树里有自己的图标。

**功能位怎样算**
- `/api/me` 返回 `features: { frontier, review, geo: Boolean(geo) && geoAudienceAllows(config, user), openList }`（`apps/server/src/server.mjs:3894-3895`）。其中 `geo` 只在 `config.geoEnabled && productDatabase` 时组装（`:1535`）。
- `geoAudienceAllows`（`geoService.mjs:98-104`）：关 → false；`all` → true；否则须是 `operatorUsers` 或 `geoPreviewUsers` 之一。
- 配置在 `config.mjs:362-414`：
  - `OPEN_SCIENCE_GEO_ENABLED`（默认 false，`:391`）、`_AUDIENCE`（默认 operators，`:362`）、`_PREVIEW_USERS`（`:394`）；
  - 另有 `_POLL_MS`、`_LEASE_MS`、`_DAILY_BUDGET_CNY`（默认 20，`:385`）、`_TIMEZONE`、`_NIGHT_WINDOW`、`_WEEKLY_ASK_CAP`、`_SOCIAL_URL`、`_INCLUSION_ENGINES`。
- 前端 `lib/geoClient.ts`：`:656-660` 的 `geoOffered`（`WebMe` 类型没有声明 `features`，按类型转换读取），`:672` 的 `useGeoFeature`。
- 模块关闭时：页面给一句话（`components/geo/GeoStates.tsx` 的 `GeoOffPage`）；接口回 404 `geo_not_enabled`（`server.mjs:1522-1523`）。
- **虚拟临研**：`OPEN_SCIENCE_VCR_ENABLED` / `_AUDIENCE` / `_PREVIEW_USERS`，加 `features.vcr`。建议默认开放范围 `operators`，与缺口清单 D3 对 GEO 的处理一致。

**路由与项目范围**
- 路由：懒加载块在 `router.tsx:33-35`，路由在 `:77-82`。
- 规矩（`:43-46`）：路由不带项目 id；当前项目由请求头 `X-Open-Science-Project` 携带（`lib/apiClient.ts:1035-1061`）。
- GEO 的做法：URL 里放自己的 `:geoId`（即 `evimed_geo.projects.id`）；首页列出本账户全部 GEO 项目（`geoService.mjs:409-410`，按 user id 取）；打开对话前先把项目选择器切到对应项目（`components/geo/useOpenGeoConversation.ts`）。
- v1.0 §4 的做法是"沿用当前项目选择作为范围"。
- 两者都不产生跨项目访问，前提是服务端按 user 校验归属。**建议**照 GEO，用 `/app/virtual-research/:vrId/:workspace?`，打开研究时同步切换项目。

**新增一级页必须同步的登记点**
- 测试：`Sidebar.test.tsx:135-147`、`router.test.tsx:81-84, 120`。
- 走查脚本：`scripts/ops/ui-walk.mjs:90-99` 的 `ROUTES`，以及 GEO 项目路由的展开（`:191`、`:445`）。
- 内核 frame 跳转：`packages/harness-port/src/runtimeUiBridge.mjs:431` 的 `SHELL_DESTINATIONS`（含 `geo`）；`RuntimeUiFrame.tsx:526-536` 的 `geo` 目的地；`:613` 的 `geo-options` 消息。
- 输入框挂模块标签：`runtimeUiCommands.mjs:48-50, 104-109`（`vocabulary.geo`）、`components/geo/useFrameGeoOptions.ts`。虚拟临研若要"输入框挂上「虚拟临研」"，就走同一条路。

**页面组件**
- `PageShell`（`components/layout/PageShell.tsx:29-40`）：`page` 1040、`wide` 1200、`full`；标题一行、没有副标题。GEO 项目页用 `wide`（`GeoProjectPage.tsx:113`）。
- `components/ui/` 可直接用：
  - `Tabs.tsx:22`；
  - `ProgressRail.tsx:43`（GEO 页头的步骤轨）；
  - `StatTile.tsx:51`（含 `StatBand`、`BulletBar`）；
  - `ChartCard.tsx:23`；
  - `DataTable.tsx:42`（含 `InlineBar`）；
  - `Delta`、`SeverityBadge`、`Drawer`、`Disclosure`、`SegmentedControl`。
- 二级分组导航：v1.0 §4 的"研究 / 运营 / 共享资源"三组，可沿用"地点列"配方 `navItemClasses`（`components/ui/NavItem.ts`，设置页分区和知识库类型栏已在用）。GEO 自己只用 7 个页签（`components/geo/geoTabs.ts`）。
- 四态：AGENTS.md 要求每个列表页有加载、空、出错可重试、成功四态。现成件有 `cards/Skeletons.tsx`、`cards/EmptyState.tsx`、`cards/LoadError.tsx`、`geo/GeoErrorCard.tsx`。
  - v1.0 §4.2 还要"部分结果、模型或数据不兼容、结果过期"三态，现有组件没有对应，要新增。
  - "界面不解释系统"的规矩禁止把内部状态写成文字，但"观测 / 合成 / 预测"这类来源标注是科学事实，不属于内部状态。
- 图表：`components/charts/`（`echartsBase`、`TrendChart`、`HeatGrid`、`ShareBar`）。生存曲线加模拟带、平衡图、分布图都要新画，ECharts 主题由令牌统一生成。
- 设计令牌：`@evimed/design-tokens` 2.1.2（`packages/design-tokens/src/index.mjs`），产出 CSS、Tailwind 预设、Element Plus 主题、ECharts 主题、内核主题和 Figma 文件，两个前端共用。

**四个研究工作区能复用哪些现成件**（建议；"新画"指现有组件里没有）

| 工作区 | 可直接用 | 需新画 |
|---|---|---|
| 虚拟队列 | 基线表 `DataTable`；关键数 `StatTile` / `StatBand`；A/B 定义对比 `SegmentedControl` + `Delta`；分布用 `ChartCard` 包 ECharts | 入排流向图（每步人数、原因、未知数） |
| 虚拟患者 | 单人详情 `Drawer`；情景切换 `SegmentedControl`；假设展开 `Disclosure` | 轨迹图：观测段、预测区间、受限期分段着色 |
| 合成对照 | 有效样本量等 `StatTile`；诊断清单 `DataTable` + `SeverityBadge` | 平衡图（标准化均数差）、权重分布、重叠图 |
| 虚拟试验 | 情景对比表 `DataTable` + `Delta` / `InlineBar`；步骤轨 `ProgressRail`（作业进度） | 功效曲线、带蒙特卡洛误差的点估计 |

**GEO 项目怎样叠在普通项目上**
- `evimed_geo.projects`（`geoPersistence.mjs:100-116`）有 `user_id`、`project_id`，约束 `UNIQUE(user_id, project_id)`。
- 新建时，`createGeoRoutes` 的 `projects.create` 调 `createResearcherProject`，再把首个会话预绑到 `geo-insight`（`server.mjs:1582-1603`）。
- 文件、记忆、对话仍归这个普通项目。
- **虚拟临研**：同样是"一个普通项目 + 一行 `evimed_vcr.studies`"。

**Vue 融合壳要改的地方**
- `RESEARCH_NAV` 在 `geo` 前插一项（`researchNav.js:18-24`；过滤函数 `visibleResearchNav` 在 `:33`）。
- `SCIENCE_SUB_APP_PAGES`（`src/api/science.js:472-482`，封闭词表）加 `'virtual-research': '/app/virtual-research'`。
- 标题表：`ScienceSubApp.vue:112-113`。
- 图标形状数据：`src/components/ui/icons.js`（与 React 用同一 Lucide 字形）。
- frame 目的地：`src/composables/useRuntimeFrame.js:146` 附近。

### 2.2 控制面模块模板

**GEO 文件逐个一句话**（均在 `apps/server/src/`）

| 文件 | 作用 |
|---|---|
| `geoService.mjs` (1516) | 页面读模型、开关与开放范围（`:98`）、就绪与指标；页面上的数只读 `metrics` 表，不在读时计算 |
| `geoRoutes.mjs` (351) | `/api/geo/*`（模式 `:50-60`）：项目增删改查、页签读取、`run`（让 AI 做，`:333`）、`export`（`:340`）、预算与订单 |
| `geoPersistence.mjs` (610) | `CREATE SCHEMA evimed_geo`（`:98`），25 张表（`projects :100` … `schedule_marks :566`），一套 DDL 管所有包 |
| `geoStore` / `geoMeasureStore` / `geoMarketStore` | 内容侧、测量侧、市场侧三个 store |
| `geoOrchestrator.mjs` (1607) | 程序状态机：下一步由平台规则决定；派发运行、入队测量轮、排周期任务、发通知 |
| `geoWorker.mjs` (288) | 一个定时器驱动多个循环，带跨进程租约；维护期可暂停 |
| `geoProbeQueue` / `geoSanity` / `geoScreenshots` | 服务端单并发测量队列、答案合理性校验、按内容寻址存截图 |
| `geoParse` / `geoJudge` / `geoMetricsJob` / `geoErrors` | 规则抽取 → 模型判定、代码复核 → 按 `@evimed/domain` 的 `geo/metrics.json` 计算 → 讲错我方的生命周期 |
| `geoGateway.mjs` (304) | `/internal/geo/v1/{read,write,social}`（`:10-12, :43`）；凭证是运行时自己的模型网关令牌，**令牌决定账户与项目**，没有 id 参数；按项目每分钟限次（`:46`） |
| `geoWrites.mjs` (1176) | `geo_write` 逐项校验、逐项拒绝，从不整批失败 |
| `geoDeliveryImport.mjs` | 运行结束后从交付物（`claims.json`）登记，即"合约约束输出" |
| `geoMarket` / `mediaMarketClient` / `geoMarketText` | 钱只由代码管：预留、结算、退款、对账 |
| `geoNotify.mjs` | 只发五种通知 |
| `geoProbeGateway` / `socialCrawlClient` / `geoInclusionClient` | 三个外部通道 |
| `geoDataFixes.mjs` | 运维一次性修正（默认 dry-run，幂等） |

**组装与挂钩**（`server.mjs`）
- 组装在 `:1535`；路由分类 `:546`，通道分类 `:567`；`createGeoRoutes` 在 `:1582`。
- 运行结束有两个挂钩：
  - `:2087-2090`：导入交付物；
  - `:2198-2209`：释放有界运行时，再交 `orchestrator.onRunFinished`。
- 编排器在 `:3106-3125`，worker 从 `:3143` 起。

**编排器怎样派发、怎样收结果**
- 步骤到能力的映射：`GEO_RUN_CAPABILITIES`（`geoOrchestrator.mjs:66-71`）；步骤依赖：`NEEDS`（`:74-77`）。
- 实际派发是 `dispatchGeoRun`（`server.mjs:3177`），按顺序：
  1. 按 `dispatchId` 重放去重；
  2. 项目里已有运行在跑，回 409 `runtime_busy`，下一拍重试（研究者自己的对话也算）；
  3. 算预算：`boundedRunBudget({purpose:"geo"})`（`boundedRunBudget.mjs:49`）；
  4. 没有交互运行时，就 `reserveBoundedRuntimeSession`；
  5. `researchSessions.put(...{mode:"specialist", agentId})` 绑定能力；
  6. `agentRuns.dispatch`，提示词末尾加 `<evimed-geo-run>` 标记（`geoRunPrompt :473`）。
- 结果按数据收：主张存在、问题集锁定、稿件已登记（header `:34-41`）。
- 副作用按键认领到 `schedule_marks`（`:28-39`），重启和多进程都不会重复。

**分工原则（对虚拟临研最重要的一条）**
- GEO 方案 §6.2 和编排器 header（`:9-11`）写明："要想的步骤跑在 AI 运行里；要测和要办的步骤跑在平台后台"。
- 虚拟临研照此划分：
  - **AI 运行**：方案与入排结构化、先例抽取、变量映射建议、结果解释、资料包撰写；
  - **平台后台**：数据剖析、队列构建、合成、模拟、估计、入排规则求值。
- 后台作业不是 run，因此不占"一项目一运行"的名额，长模拟也不会挡住研究者的对话。

**运行时工具怎样暴露**
- 工具实现：`runtime/mcp/evimed-research/geo_platform.py:81`（`geo_read`）、`:110`（`geo_write`），读 `EVIMED_GEO_GATEWAY_URL`（`:151`）。
- 注册：`server.py:890`；归入 `OPTIONAL_TOOLS`（`:970`）；分派在 `:1967`。
- 规范名：`packages/domain/src/toolNames.mjs:65-68`。
- 地址只在模块开启时写进运行时环境（`runtimeManager.mjs:1572`）；否则工具判为关闭（`:1708`）。
- AgentBay 运行时走公共入口 `/runtime-gateway/geo/…`（`runtimeGatewayEntry.mjs:16`）。

**通用账本与租约作业**
- `productPersistence.mjs`：`evimed_product.documents`（`:55`）、`revisions`（`:112`）、`jobs`（`:123-145`）。
- `jobs` 的列：`status`（queued / running / succeeded / failed / canceled）、`result`、`error`、`attempts / max_attempts`、`run_after`、租约列，以及 `UNIQUE(user_id, idempotency_key)`。**没有**进度、检查点、取消请求、资源用量列。
- `ProductJobs.enqueue`（`productJobs.mjs:24`）；`claim(kinds, workerId, {leaseMs})` 用 `FOR UPDATE SKIP LOCKED`（`:80-92`）。
- 前沿动态立下的规矩：大批量队列放模块自己的 schema，共享账本只放少数作业种类（`productPersistence.mjs:13-16`）。虚拟临研的模拟作业应照此放进 `evimed_vcr`。

### 2.3 能力包

**现有 21 个**（`capabilities/*/capability.yaml`，中文名取自 `display.title`）

| 用途 | 能力（展示名） |
|---|---|
| 证据 | clinical-evidence-synthesis 临床证据深度分析 · evidence-appraisal 证据质量评价 · meta-analysis 自动化 Meta 分析 · off-label-analysis 超说明书用药分析 |
| 药学 | adr-analysis 药品安全性分析 · comprehensive-drug-evaluation 综合药品评价 · drug-selection 药品遴选评价 |
| 设计与数据 | dataset-research-scoping 数据集科研可行性勘查 · research-topic-selection 科研选题 · research-grant-development 基金申报书开发 · mendelian-randomization 孟德尔随机化 · bibliometric-analysis 文献计量分析 |
| 写作与质量 | manuscript-support 论文章节写作 · peer-review 论文审稿 |
| GEO（public，`display.listed:false`） | geo-insight · geo-strategy · geo-content · geo-proposal |
| internal | source-understanding · method-distillation · method-relations |

**dataset-research-scoping（可复用度最高）**
- 清单 v1.7.0：
  - persona 写明"原始行不进入你的上下文，你只看结构、统计与样例"；
  - 合约 `dataset-scoping-package`，10 个必需产物（`data-profile.md/.json/.py`、`data-quality.md`、`evidence-map.md`、`feasibility-matrix.md`、`external-linkage.md`、`research-portfolio.md`、`study-protocol.md`、`scoping-run.json`）；
  - 自动任务类型 `data-prospecting`。
- SKILL.md 的四条规矩：
  - 抽样导出不是队列（`:42-66`），要给出方法在规模化时所需的样本量；
  - 标识符不出数据：假名在内存里派生，映射不落盘（`:67-89`）；
  - 剖析前先声明"既往数据接触"（Phase 0）；
  - 数据质量用 Kahn 2016 的术语。
- `scripts/profile_dataset.py`（707 行，只用标准库；XLSX 需 openpyxl，`:417-423`）：逐列统计填充率、基数、类型、词表；检查包含依赖（跨表 join 可达性）；检测陷阱；给标识列掩码（`:38-80`）；输出逐字节确定。
- 这正是 v1.0 §5.1 第 5 步"完整性、一致性、合理性、重复、连接质量"的现成实现，可直接进虚拟临研的数据接入。它缺：字段映射、单位与编码、三时钟、缺失原因。
- 标识符检查分两处：运行侧在本能力的 `preflight.py`（`:6, 79-124`）；控制面对该合约只做 `validateReportShaped` 加提示级 `datasetScopingFindings`（`contractRegistry.mjs:724-727`）。

**meta-analysis 与 `项目代码/meta` 引擎**
- 工具 `meta_analysis`（`server.py:742-757`）：只有 `capabilities / start / status`，参数 `topic`、`maxPapers`、`analysisType`（pairwise / network）、`userPdfDirectory`、`ipdData`。
- 引擎库 `new_meta/engines/`：
  - `meta_engine.py`：`fixed_effect :16`、`random_effects_dl :75`、`random_effects_reml :255`、`random_effects_hksj :324`、`meta_regression :407`、`cumulative_meta_analysis :485`、`_heterogeneity :536`（Q / I² / τ²）；预测区间写在 `:135 / :316 / :399`。
  - `effect_size.py`：OR / RR / RD / MD / SMD；由 CI 反推 HR（`:201`）；比例 Freeman-Tukey（`:231`）；IRR（`:295`）；中位数转均数（`:157`）。
  - `prevalence.py`：logistic-normal GLMM（`:93`）、Clopper-Pearson（`:205`）。
  - `incidence.py`：Poisson-normal GLMM（`:126`）。
  - `ipd.py`：一阶段 logistic / linear / Cox（`:252-336`）。
  - `influence.py`：Paule-Mandel（`:181`）。
  - 另有 `nma`、`dta`、`dose_response`、`publication_bias`。
  - `core/manuscript_facts.py`：从确定性输出构建事实包，再加硬校验。
- 这些都是纯 Python 库，可直接被新引擎导入，把先例参数合并成假设分布。
- 没有的：贝叶斯、MAP / 稳健混合先验、功效先验、动态借用、先验有效样本量（全仓 grep 无）。

**clinical-evidence-synthesis / evidence-appraisal**
- 用途：产出"先例与参数来源"的证据包。
- claim 三类（`clinicalEvidence.mjs`）：direct、synthesized、derived。derived 必须写明输入、方法、假设、敏感性，并在报告中标明。
- 虚拟临研的"假设登记"可沿用 derived 的字段纪律，但假设本身应是 `evimed_vcr.assumptions` 里的版本化记录，而不是报告里的一段文字。

**adr-analysis**
- 确定性信号（ROR / PRR / χ² / IC / EBGM）。与虚拟临研关系弱，只可作安全性参数的来源。

**包装规矩**
- 清单字段由 `capabilityManifest.mjs:157-214` 校验：`title`、`description`、`whenToUse`、`persona`、`skills`、`produces` 必填，另有 `tools`、`inputs`、`autopilot`、`display{…, listed}`、`visibility`、`safetyClass`。
- 生成器 `scripts/build/generate-capability-manifests.mjs` 产出 socket / 运行时清单、`capability-display.json` 和 `capability-contracts.json`。`capability-contracts.json` 按 `safetyClass` 派生 `CLINICAL_CONTRACT_KINDS`，`clinical` 类会套用临床安全规则。
  - **建议**：模拟、对照类包用 `general`；招募材料、患者说明类包用 `clinical`。
- 合约种类及中文名登记在 `contractKinds.mjs`（例如 `:30, :139`），校验器注册在 `contractRegistry.mjs`；新检查的中文标签放 `gateIssueText.mjs`。
- 评测：每个 public 能力在 `evals/<id>/briefs.json` 至少 3 条真实 brief，由模型按 mustDo / mustNotDo 评分（`evals/acceptance-ledger.json → definitions.briefCount`）。
  - v1.0 AC-10、AC-11 的数值验收属于另一类，应仿照 `evals/geo-gate-coverage`（突变式覆盖）建一个基准夹具集。
- 改 SKILL 或清单会连带约六个服务端测试（记忆 capability-edit-ripples）。

### 2.4 专科引擎

**调用链**
- 运行时 MCP 工具按 `ADAPTER_ENV`（`server.py:895-914`）直接 POST 到引擎。
- 认证用控制面签发的工作负载令牌（`runtimeManager.mjs:1138-1258`）：HMAC-SHA256，TTL 30–900 秒，绑定项目作用域，以令牌文件 `evimed-workload.token` 交给运行时。
- 调用失败有熔断（`server.py:1310-1360`）。
- 引擎侧有两类：
  - **通用适配器**：`deploy/specialist-adapter/evimed_specialist_adapter/service.py`，服务 MR / 计量 / 选题 / 审稿 / 药物安全五个引擎。作用域只从令牌推导；用固定参数启动 `evimed_runner.py`；写 `request.json`（`:1293`）、读 `result.json`（`:1329`）；只发布工作区相对路径的产物。签名回执用 Ed25519（`audit_receipt.py:100-109, 291`）。
  - **Meta 引擎**：自有镜像（`项目代码/meta/Dockerfile.evimed`，端口 8024）。

**部署**（`deploy/web/docker-compose.yml`）
- 引擎 URL 在 `:751-756`。
- 各引擎挂载整个 `open-science-data:/data` 卷（`:1005, 1090, 1245, 1297, 1344, 1398`）：只读根文件系统，`cap_drop: ALL`。
  - 这意味着引擎在文件系统层面能看到所有项目的工作区，隔离靠适配器按令牌推导作用域。
  - 患者级数据如果进这个卷，边界就只剩代码一层。
- 资源：MR / 计量 / 选题 / 审稿 / 药物安全各 1.5 CPU / 2 GB / 256 pids（`:1124-1126, 1264-1266, 1316-1318, 1363-1365, 1421-1423`）；meta 引擎没设上限（`:962-1036`）。
- 花费上报：经 `/internal/usage/v1/engine`，用工作负载密钥签名（`usage_report.py`）。缺口清单 E4 指出引擎至今直连 DeepSeek、事后记账。
- 同容器回退：`specialist_jobs.py` 按 `EVIMED_*_AGENT_ROOT` 在运行时里跑，只在没配 URL 时用。

**R 与 Python**
- 引擎镜像：`specialist-adapter/Dockerfile` 用 `ARG AGENT_KIND` 按引擎装依赖。MR 装 `r-base-core`、`r-recommended` 和一批 `r-cran-*`（`:44-51`），再跑锁定的 `install_r_packages.R`（`:94`）。这是新 R 依赖引擎的现成写法。
- 运行时镜像（`deploy/runtime-dsh/install-runtime.sh`）：
  - apt 装 `r-base-core`、`r-recommended`（`:72-73`）；
  - Python 锁版本（`:169-189`）：numpy 2.2.6、pandas 2.2.3、scipy 1.15.3、statsmodels 0.14.6、scikit-learn 1.6.1、openpyxl、matplotlib、jupyterlab；
  - R 只验一行 `Rscript`（`:218`）。
- curated 技能 `statistical-power`（`simulate_power.py`，注释写明 survival 例子需要 lifelines）、`survival-analysis`、`bayesian-modeling`、`experimental-design` 随镜像发布，但镜像里没有 lifelines 和 PyMC。

**新的"临床模拟与统计引擎"放哪里**

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 运行时里的脚本 / 笔记本 | 零部署 | 180 秒上限、8 GB、与对话同生共死；模型能改代码（疳证就是这样出错的）；原始行在模型可达范围 |
| B. 控制面 Node worker 直接算 | 已有租约队列 | 控制面是租户边界，不应跑重 CPU；Node 没有统计栈 |
| **C. 新引擎容器 + 控制面租约作业 + 运行时工具只提交 / 查询**（照 `meta_analysis` 的 `start/status`） | 版本化、签名回执、资源隔离；可迁到独立节点或 AgentBay；LLM 永不算统计 | 新镜像、新作业表、新契约 |

- **建议选 C。** 引擎只接受冻结的 scenario JSON 和数据快照引用，输出 `result.json`、种子、环境摘要和输出哈希。
- 可以作为 `AGENT_KIND` 新值复用适配器，也可以独立镜像。二选一的依据是：要不要只挂数据保险库、而不挂整个数据卷。

### 2.5 数据接入

**入口与上限**
- `/api/files/upload`（`server.mjs:5097`）收 base64 JSON，上限 `maxFileBytes` 50 MB（`config.mjs:1250`），不能断点续传（DSH 方案 G13，`:1975`）。
- 解析 API 上限 100 MB（`documentParserClient.mjs:40`），本地文本上限 16 MB（`:254`）。
- 来源按内容寻址为 `src_<sha256>`。OpenList 导入走 `openListClient.mjs`，但生产还没挂存储（缺口清单 A5）。

**格式路由**（`packages/domain/src/sourceDocuments.mjs`）
- `SOURCE_API_FORMATS`（`:21`，含 xls / xlsx）发往外部解析服务。
- `SOURCE_LOCAL_TEXT_FORMATS`（`:29`，含 csv / tsv / json）原样读取。
- Parquet / SAV / DTA 不在 `KNOWLEDGE_BASE_FORMATS`（`:40`）里，会被拒收；但 `sourceService.mjs:345` 仍把它们归为 `cohort-data`，两处不一致。

**理解与索引**
- `cohort-data` 的深度是 `structured`：先物化成可读副本，再派发 `source-understanding` 运行（`sourceWorker.mjs:203-221`）。
- codebook 下限要求覆盖 ≥ 90% 的列（`analysis.mjs:274`）。
- `kbIndex` / `kbSearchGateway` 对 `cohort-data` 没有特殊处理，CSV 片段可被 `kb_search` 检索。

**原始行进入模型的路径：存在。**
- 知识库只读挂到 `/workspace/knowledge-base`（`runtimeManager.mjs:2420, 2746`）；内核有 `bash`（`packages/socket/src/runPolicy.mjs:141`）；模型网关看到完整上下文。
- 防护只有四样：剖析器掩码、技能约定、运行侧 `preflight.py`、闸门的 `record-identifier-leak`（`clinicalEvidence.mjs:2667-2695, 3806-3813`）。
- `record-identifier-leak` 只认"字母 + ≥6 位数字"这一种形状。它不在 `CLINICAL_CHECK_TIERS`（`:431-450`）里，按 `:452-454` 判为 advisory，只提示、不扣交付。

**v1.0 要的，现在都没有**
- 身份与假名服务；
- 来源登记（权利人、用途、接收方、保留期）；
- 三时钟（事件、记录、平台可得时间）；
- 缺失原因词表；
- 不可变快照与哈希；
- 字段和时间窗级访问；
- 逐次访问评估。

**设计过、没建的底稿**（DSH 方案）
- 数据保险库（`:2290`：对象存储、按用户隔离、服务端加密）；
- DuckDB 画像（`:2099-2100`）；
- 模型只看 schema 与 `head(5)`（`:2547`）；
- A1 验收"注入 / 越权读取 0 命中"（`:2362`）。

这几条可以直接作为虚拟临研数据平面的起点。

### 2.6 证据连接器

**规范工具**（`toolNames.mjs:46-104`）
- 检索：`literature_search`、`reference_list`、`guideline_search`、`clinical_trial_search`、`biomedical_source_search`、`open_access_full_text`、`web_read`、`web_search`、`locate_quote`。
- 药学：`drug_label_search`、`pharmacy_reference_search`、`adr_case_query`、`adr_signal_analysis`、`offlabel_evidence_packet`。
- 六个引擎工具。
- 模块与知识库：`kb_search`、`frontier_search`、`geo_*`。
- 七个 science connectors。
- 辅助：`data_source_catalog`、`evidence_deduplicate`、`term_normalize`、`drug_term_normalize`。

**`clinical_trial_search`**（`server.py:561-581`）
- 参数：`registry` 0 / 1 / 2、`status`、`phase`、`studyType`、`hasArticles`、`source`、样本量范围。
- 实现（`public_sources.py:1221-1262`）：调 EviMed `/review/api/clinical-trial`，取回登记号、状态、分期、样本量、疾病、申办方、干预。接口说明见 `接口文档/EviMed医学证据检索.md:37, 86-103`：0 = ChiCTR、1 = CT.gov、2 = Cochrane Central；"注册记录不等于结果"。
- 落空时回退 CT.gov v2（`:1499-1545`）。
- 网关白名单里还有 v2 试验端点（`publicSourceGateway.mjs:299`），但运行时代码没有调用。

**来源目录**（`source_catalog.json`）
- `clinicaltrials-gov`：active；
- `chictr`、`who-ictrp`：`blocked_no_api`；
- `ema-epar`：需凭证；
- `openfda`、`faers`：可用；
- 药审中心：已停用（缺口清单 D4）；
- 另有 `science_connectors.py:137` 的一个 CT.gov 查询。

**知识信源插件**（`项目代码/knowledge-plugin`）
- `registry/extra-sources.json:5` 的 `evimed-chictr`；`probe-sources.json:12575` 起的 CT.gov 三期新注册与结果首发。
- `enrich/trials.py:17` 只取 phase / status / enrollment / sponsor / 摘要，有意不取联系人。
- 它为前沿动态服务，也能直接当"竞争试验监测"的信号源。

**先例库还缺什么**
- CT.gov v2 的 `eligibilityModule`（入排原文）、`armsInterventionsModule`、`outcomesModule`（终点与时间框架）、`resultsSection`（结果、事件数）都没抽。
- 没有 criterion 结构化（极性、阈值、时间条件），也没有 USDM 映射。
- 抽取后的每个字段都要带出处位置，这可沿用 `locate_quote` 与闸门的逐字引用核对。

### 2.7 横切服务

- **模型用量**
  - 用途表：`USAGE_PURPOSES`（`usagePurpose.mjs:34`）。
  - 不计入用户上限：`UNCAPPED_USAGE_PURPOSES = engine, frontier, geo`（`usageLedger.mjs:31`）。GEO 用的是"模块自己的日预算、不占用户上限"。
  - 一次内核请求先预留约 ¥1.03（记忆 run-budget-below-one-reservation）。
  - 建议加 `vcr` 用途和模块日预算。模拟引擎的 CPU 用量目前无处计量，要新增。
- **通知**：`notificationService.mjs:412`（`create`），加 `geoNotify` 的"只发几种"模式；飞书经 `imService.mjs`。
- **记忆与胶囊**
  - 存储：`ResearchMemoryStore`（`researchMemory.mjs:602`）、`CapsuleService`（`capsuleService.mjs:40`）；胶囊事实种类在 `capsule.mjs:40`。
  - 胶囊只是上下文，从不是权限。
  - 胶囊分享是点对点导出 / 导入，没有项目共享和多人成员。
  - v1.0 §12 的评审和决定记录应进 `evimed_vcr` 业务表，记忆只作召回副本。
- **主动科研**
  - 任务类型 `AUTOPILOT_TASK_TYPES`（`capabilityManifest.mjs:85-92`），派发 `dispatchEpisode`（`server.mjs:2830`）。
  - 任务到能力的映射表是 `AUTOPILOT_EPISODE_CAPABILITIES`（`:113-120`）。GEO 吃过亏：它声明 `signal-monitoring`，而这张表把该类型交给 `adr-analysis`，结果 GEO 监测从未真正运行。
  - 修法（`:95-105` 注释）：监测改由 GEO 模块自己的调度器负责，GEO 能力不再声明任务类型；并加测试 `apps/server/test/autopilotEpisodeCapabilities.test.mjs`，逐条核对各能力的声明与映射表。
  - "竞争试验监测"建议照此处理：放在模块自己的调度器里，或者新增任务类型并同步补上映射行和测试。
- **运行账本与事件**
  - `RUN_EVENT_TYPES`（`runTranscript.mjs:182`）；`states.mjs` 的 `RUN_PHASES :25`、`PLAN_ITEM_STATES :38`、`EVIDENCE_STATES :49`、`VERIFICATION_STATES :63`。
  - v1.0 §13.1 要求沿用。模拟作业由运行发起时回链 `runId`。
- **交付闸门**
  - 必需检查只有 `CLINICAL_CHECK_TIERS` 所列，其余全是提示；阻断预算 6 个，已用完（原则 4）。
  - 可复用的测量件：
    - `dataset-number-provenance`（`datasetScopingContract.mjs`；`contractRegistry.mjs:108`）；
    - `numericTraceability`（`reviewService.mjs:477-487`，只在 L3 档用，且排除 dataset-scoping；审阅模块默认关，`config.mjs:640`）。
- **导出**：GEO 的 `export` 路由加编排器 `requestExport`，由 AI 运行生成资料包。

### 2.8 算力约束

- **运行时容器**
  - 默认 `--cpus 2 --memory 8g --pids-limit 1024`（`config.mjs:1503 / 1510 / 1522`；`runtimeManager.mjs:1092-1093, 2411-2414`）。
  - 内存用量超过上限的 80% 时记一次 `memory_pressure`（`:5951-5954`）。
- **运行时数量**
  - 默认 docker 8 个、每人 4 个；agentbay 100 个、每人 2 个（`config.mjs:1358, 1378`）。
  - 生产是 4 个、每人 2 个（记忆 runtime-slot…、runtime-limits…）。
- **生产机**：4 vCPU / 15 GB，与至少八个产品共用；swap 曾满；无 KVM；依赖重装会让主机失去响应约 20 分钟（记忆 lockfile-change…、tencent-host-has-no-kvm）。
- **AgentBay**
  - 开关在 `config.mjs:1068`；代码在 `apps/server/src/agentbay/`（`runtimeProvider`、`workspaceSync`、`linkTunnel`、`browser`）。
  - 生产未开（缺口清单 A12）。
  - 规格 2c4g–16c32g，单次命令 API 限 50–60 秒，标准网络共享 5 Mbps（记忆 agentbay-facts）。它是运行时沙箱，不是作业集群。
- **作业设施**：`ProductJobs` 与 GEO 的 `schedule_marks` / worker 租约都可用，但缺进度、检查点、取消、CPU 秒四样。
- **建议**
  - 作业进 `evimed_vcr.jobs`：租约、分块检查点、可取消，预算按复制数 × 场景的 CPU 秒计。
  - V1 在共享机上全局并发 1。
  - 规模化时把引擎容器挪到独立节点，接口不变。

### 2.9 已有的相关工作

- **没有实现的**：virtual patient、trial simulation、patient matching、TrialGPT 一类功能全仓都没有。
- **只在语料里出现的**：
  - "synthetic control""digital twin""MatchIt"各只命中 1 个文件（`evals/title-to-paper/corpus-v3/...`、`项目代码/科研选题/modules/new_analysis_modules.py`、一份 meta 检索结果）；
  - cohort / 样本量 / estimand / Monte Carlo / propensity 的命中几乎都在 `evals/title-to-paper` 语料、curated 技能文本和报告规范清单里。
- **最接近的资产**：
  - `statistical-power` 技能（闭式公式 + 模拟功效）；
  - `survival-analysis` 与 `experimental-design` 技能文本；
  - dataset-scoping 剖析器；
  - meta 引擎库；
  - `docs/superpowers/specs/dataset-research-scoping-skill.md:114-122, 443`：精度要在施加全部设计排除后的分析队列上算（Gokhale 2016），这对"虚拟队列可行性"同样成立。
- **缺口清单相关项**：
  - E14 统计分析能力包（9 月 9 日提出，未做）：建议与虚拟临研引擎合并规划；
  - E4 引擎直连 DeepSeek、E9 签名回执不全：新引擎应从第一天做对；
  - C1 解析服务是明文测试服，患者级 XLSX 不能走它；
  - E22 meta 引擎裁掉的记录不落盘：可复现性问题，虚拟临研要避免同类问题；
  - D3 GEO 只对运营账号开放：虚拟临研同样从 `operators` 起步。

---

## 3. 复用映射表

### 3.1 需求 → 资产 → 缺口 → 落点层

| 虚拟临研需要 | 现有资产 | 缺口 | 落点层 |
|---|---|---|---|
| 一级入口（科研工具下、GEO 上） | `Sidebar.tsx:77-86`、`router.tsx:77-82`、Vue `researchNav.js:18-24` | 新行、路由、测试、ui-walk、frame 目的地 | 1 |
| 按账号开放 | `geoAudienceAllows`、`server.mjs:3894`、`config.mjs:362-414` | `OPEN_SCIENCE_VCR_*`、`features.vcr` | 2 |
| 研究 = 普通项目 + 档案 | `evimed_geo.projects` 的 UNIQUE；`server.mjs:1582-1603` | `evimed_vcr.studies` | 2 |
| 组织、角色、用途授权 | 只有个人账户与 `operatorUsers` | 组织、成员、角色、授权、逐次评估、审计 | 2 |
| 数据接入与剖析 | `profile_dataset.py`、dataset-scoping 合约 | 保险库（不挂运行时）、映射、三时钟、缺失原因、快照、Parquet | 2 + 9 |
| 方案与入排 | 无（`study-protocol.md` 只是文本） | 方案版本、criterion 模型、USDM 映射 | 4 + 8 |
| 先例库 | `clinical_trial_search`、CT.gov 回退、插件流、v2 白名单 | 入排、分组、终点、结果的结构化与出处 | 3 + 8 |
| 参数合并 | meta 引擎库 | 直接合并入口、MAP / 借用 | 9 |
| 合成队列、虚拟患者、试验模拟 | 仅 `simulate_power.py` 技能脚本 | 三族参考模拟器、种子、MC 误差 | 9 |
| 外部对照 | R `survival`、statsmodels | 匹配 / 加权、平衡与 ESS、RMST | 9 |
| 数字只取自结果 | 三处零件（见结论 8） | 结果 → 模板渲染、报告合约 | 4 + 8 |
| AI 编排与解释 | `GeoOrchestrator`、`dispatchGeoRun`、`geo_read / geo_write` | `/internal/vcr/v1` 与三个工具 | 2 + 3 + 7 |
| 长作业 | `ProductJobs`、`schedule_marks` | `evimed_vcr.jobs`（进度、检查点、取消、CPU 秒） | 2 + 9 |
| 通知 | `notificationService`、`geoNotify` | 通知种类 | 2 |
| 竞品试验监测 | 插件流、autopilot | 任务类型 | 2 + 8 |
| 决定与评审 | 记忆、胶囊（只是上下文） | 与输入 / 输出哈希绑定的评审记录 | 2 |
| 计费 | `usageLedger`、`USAGE_PURPOSES` | `vcr` 用途、CPU 秒 | 2 + 4 |

### 3.2 v1.0 验收场景 → 现有机制

| 场景 | 现有可依托的 | 还要做的 |
|---|---|---|
| AC-01 四个动作进入真实流程 | GEO 的"让 AI 做"与编排器 | 四个工作区的配置页和引擎 |
| AC-02 无患者数据完成参考试验 | 无 | 参数化队列加参考模拟器（旅程 A） |
| AC-03 / AC-09 来源可区分，生成记录不算观测 | 闸门的 claim 三分法（只管文字） | 值级来源字段；分开计数观测数、事件数、有效样本量、生成数 |
| AC-04 可复现 | dataset-scoping 的确定性剖析器、适配器回执 | 引擎环境摘要、种子、输出哈希 |
| AC-06 / AC-22 受限期不取不推 | 无 | 来源可见性策略（在数据平面层执行） |
| AC-10 / AC-11 Ⅰ类错误、功效在精度内 | 无；疳证案例提示要对照 R 参考实现 | 数值基准夹具集 |
| AC-17 跨租户 | 令牌决定项目（GEO 通道、适配器） | 引擎不再挂整卷；缓存与导出按授权 |
| AC-19 失败与取消 | `jobs.status` 含 canceled；GEO 的"失败仍收数据" | 部分产物与花费的如实记录 |
| AC-20 报告数字 | 三处零件 | 模板渲染 |
| AC-24 至少三条真实 brief | `evals/<id>/briefs.json` 惯例 | 与合成基准分开的真实 brief |

---

## 4. 建议的落点草图与风险

### 4.1 各层落点（全部是建议）

- **第 1 层 · 浏览器**
  - 页面：总览、四个研究工作区、三个运营工作区、四个共享资源；二级导航分三组。
  - 代码：`lib/vcrClient.ts`（`useVcrFeature`、`vcrOffered`）、`components/vcr/*`。
  - 结果页分开显示观测数、事件数、有效样本量、生成数；计算失败不画成 0。
- **第 2 层 · 控制面**
  - 文件：`vcrService`、`vcrRoutes`（`/api/vcr/*`）、`vcrPersistence`、`vcrOrchestrator`、`vcrWorker`、`vcrGateway`、`vcrAccess`（逐次评估数据使用授权）。
  - `evimed_vcr` 的表，对应 v1.0 §13 的业务对象：`studies`、`members`、`grants`、`sources`、`snapshots`、`field_maps`、`protocol_versions`、`criteria`、`assumptions`、`cohorts`、`scenarios`、`jobs`、`results`、`reviews`、`decisions`、`matches`、`referrals`、`audit`。
  - 在 `createWebApiApp` 里一行注册；模块关闭时整体消失，普通对话不受影响。
- **第 3 层 · 通道**
  - `/internal/vcr/v1/{read,write,simulate}`：令牌决定项目，字段封闭，逐项拒绝。
  - 引擎通道：工作负载令牌加签名回执。
- **第 4 层 · 领域**
  - 词表：来源种类（observed / extracted / calculated / imputed / predicted / assumed / synthetic）、结果状态（estimated / limited / not-estimable）、缺失原因、意图用途。
  - 合约种类：`vcr-cohort-package`、`vcr-comparator-package`、`vcr-trial-simulation-package`，检查全部从提示级起步。
- **第 7 层 · 运行时镜像**：可选工具 `vcr_read`、`vcr_write`、`vcr_simulate`（`start/status`）。
- **第 8 层 · 能力包**
  - `vcr-protocol`（方案与入排）、`vcr-precedent`（先例与参数）、`vcr-design`（配置与解释）、`vcr-report`（资料包）。
  - 全部 `listed:false`，各配至少 3 条真实 brief。
- **第 9 层 · 引擎**
  - 形态：`项目代码/vcr-engine`，或适配器新增一个 `AGENT_KIND`。
  - 首批方法：三族参考模拟器；固定设计的功效与 Ⅰ 类错误；RMST；IPW / 匹配加平衡诊断；先例合并（复用 meta 库）。
  - 数值基准对照 R 的 `survival` 和 `metafor`。
- **不做**：不起第二个内核；控制面不做运行时代码加载；不加新阻断；不让模型写或改统计数字。

### 4.2 数据平面与作业生命周期

**数据平面**
- 患者级数据只进一个**不挂进运行时**的保险库（独立卷或对象存储）。控制面登记来源、授权和快照（哈希）。
- 引擎只读取快照引用，只写聚合结果。
- 模型只看 schema、统计和聚合摘要。
- 这正是 DSH 方案 D16 与 A1 的原设计，这次落地即可。

**作业生命周期**
1. 编排器或页面动作冻结场景（输入快照、方法版本、种子、复制数）；
2. 按键入队（幂等）；
3. worker 领取并调用引擎，引擎分块写检查点和进度；
4. 结果和哈希入 `results`；
5. 通知；
6. 报告能力读 `vcr_read` 渲染。

取消、重试、从检查点续算三件事都在作业层完成，不经过内核。

**v1.0 §13.2 的八个逻辑操作各落在哪里**

| 操作 | 谁做 | 落点 |
|---|---|---|
| 登记与剖析数据 | 平台（确定性） | `vcrService` 登记来源与授权；引擎跑剖析，复用 `profile_dataset.py` 的算法 |
| 起草与审阅方案 | AI 起草，人审阅 | 能力 `vcr-protocol` 经 `vcr_write` 写 criterion；审阅记在 `reviews` |
| 构建队列 | 平台 | 引擎按已审定义和快照求值；入排规则由代码求值，不交给模型 |
| 生成虚拟患者 | 平台 | 引擎参考模拟器（种子、版本） |
| 评估与构建对照 | 平台，AI 解释 | 引擎估计与诊断；"不可估计"作为结果状态返回 |
| 模拟试验 | 平台 | 引擎作业（复制数、MC 误差、检查点） |
| 匹配候选 | 平台求值，人裁决 | criterion 求值给出满足 / 不满足 / 未知 / 延后四态，附证据；裁决记录入 `matches` |
| 组装交付物 | AI 写文字，代码填数字 | 能力 `vcr-report` 读 `vcr_read`，数字按结果 JSON 渲染 |

### 4.3 分期（对齐 v1.0 §18.2）

1. **模块骨架**：开关、schema、页面空态、侧栏两端入口。
2. **引擎与旅程 A**：参数化队列 → 虚拟患者 → 参考试验，数值基准通过。
3. **数据平面、授权与观测对照**：保险库、授权、观测队列、外部对照。
4. **匹配、招募、随访**：先做结构化方案与判定证据链。

### 4.4 需要负责人拍板的

- 引擎放哪里：共享机试点，还是一开始就独立节点；
- 统计栈：Python 为主加 R 参考，还是 R 为主；
- 组织与角色模型是否在本模块首次引入；
- 模块内部命名和图标。

### 4.5 风险

1. **数据平面是先决条件。** 知识库路径会让原始行进模型可达范围，XLSX 还会过外部解析服务，引擎也能看到整个数据卷。这些都属于原则 14 的工程边界，要先建再接合作方数据。
2. **组织和角色从零开始。** 个人账户模型撑不起 v1.0 §14。
3. **容量。** 共享 4 vCPU 主机上的蒙特卡洛会拖慢其他产品。
4. **阻断预算已满。** 新检查只能是提示或指标；"不可估计"是合法交付。
5. **两个前端。** Vue 入口取决于 B1。
6. **范围与人力。** 需要统计专人和数值验收；V1 以旅程 A 为先，而不是四个工作区同时铺满。
