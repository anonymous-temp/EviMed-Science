# F1：循证 GEO「信源」行打不开 / 对话页底部无留白——代码级事实核查

范围与口径：

- 代码基线是线上 R12 的 worktree `/home/coder/evimed-wt/release`（HEAD `adcd02e6b`，2026-10-08），下文所有路径都相对 `/home/coder/evimed-wt/release/OpenScience/`，格式 `path:line`。没有读 `/home/coder/workspace/EviMedScience/OpenScience`（陈旧分支）。
- 只读：没有改任何源文件、没有 commit、没有 stash/checkout。
- 内核（DSH）的浏览器包：release worktree 的 `node_modules/.pnpm` 里只有 `dsh-client-ui-renderer/slots/sidebar-browser/modules`，没有 `ui-conversation`、`ui-chat`；本机其他位置只有 0.1.2-rc.1 的旧包（不能用）。所以我从 npm 取了 `@deepseek-ai/dsh-client-ui-{conversation,chat,layout,theme}@0.1.7-rc.2` 的 tarball，解到 `/tmp/f1-kernel-fetch/x/`（只读文件、未执行），用 python 做上下文摘取。`deps-version.json` 说明 73 个内核子包都按 exact 钉在 0.1.7-rc.2（`deps-version.json:20`），所以这批 tarball 与线上镜像应当是同一份，但我没有拿线上镜像逐字节比对，凡引用内核包处都标「内核包 `lib/client.js` @偏移」，偏移是压缩后文件的字符位置。
- R12 对本报告涉及区域的改动：`git diff --stat 3e52ca1f2..adcd02e6b -- OpenScience/apps/web OpenScience/apps/server/src/runtimeUi*` 输出为空，`packages/harness-port`、`packages/socket` 也不在这 16 个提交的改动清单里（改动只在 autopilot、frontier、runtime、vcr 技能文本、monitoring 等）。所以下面两个问题都是 R11 及更早就存在的行为，R12 没有动过。

---

## 问题 1：循证 GEO 项目页「信源」标签，点列表项打不开

### 1.1 谁在渲染，行有没有点击行为、悬停样式、详情页

- 标签注册：`apps/web/src/app/routes/GeoProjectPage.tsx:45-53`（`TABS` 里 `sources: SourcesTab`）；标签清单 `apps/web/src/components/geo/geoTabs.ts:20-28`（总览、可见度、准确与安全、问题与回答、信源、行动、方案）。
- 组件：`apps/web/src/components/geo/tabs/SourcesTab.tsx`。
  - 数据加载 `:33`（`getGeoSources(geoId)`），空列表走 `StepPending` `:38`。
  - 过滤行 `:99-107`：`FilterChips`（全部引擎 + 有被引的引擎，`:78-84`）、`SearchInput` 「搜索信源」`:103`、`FilterSelect` 「只看」`:104`；右侧摘要 `:92-95`（「N 个信源 · 已排除 M 个冒名站」；N 是过滤后的行数，冒名站被从列表里剔除并收在底部的 `Disclosure` 「冒名站」`:142-152`）。
  - 列表 `:114-135`：每行是共享组件 `ListRow`（`apps/web/src/components/ui/ListRow.tsx:41`），一次显示 30 条（`SOURCES_SHOWN` `:16`），其后「显示更多」。
- **行有点击行为，但只是「就地展开」**：`SourcesTab.tsx:123` `onOpen={() => setOpen(expanded ? null : key)}`、`:124` `expanded`。`ListRow` 在只有 `onOpen`（没有 `to`/`href`）时把标题渲染成 `<button aria-expanded>` 并用 `after:absolute after:inset-0` 把它拉伸成整行的点击目标（`ListRow.tsx:97-112`）。点开后只在行内 `meta` 里多出一段 `SourceDetail`（`SourcesTab.tsx:125-130, 208-233`）。
- **没有任何「某个信源」的详情页/抽屉/路由**：`apps/web/src/app/router.tsx:101-102` 只有 `geo/:geoId/answers/:snapshotId` 和 `geo/:geoId/:tab?`，没有 `geo/:geoId/sources/:x`；`SourcesTab.tsx` 里没有 `Drawer`、`Link`、`navigate`。
- 悬停/光标样式：
  - 光标：`ListRow` 的 `<button>` 没有自写 `cursor`；web 用 Tailwind 3.4.19（`apps/web/node_modules/tailwindcss/package.json`），其 preflight 给 `button, [role="button"]` 设 `cursor: pointer`（`node_modules/tailwindcss/src/css/preflight.css:343-345`），伪元素继承它，所以整行是手型。
  - 悬停底色：`ListRow.tsx:115` `interactive && "hover:bg-surface-1"`。`surface-1` 是 `#f5f7f9`（暗色 `#161b21`），页面底色 `bg` 是 `#fafbfc`（`DESIGN.md:62-65`），两者只差一小步，肉眼几乎不可见。而 `DESIGN.md:388` 把悬停态写成 `surface-2`（`#edf0f3`），所以 `ListRow` 的悬停比规范浅一档（我没有在浏览器里量对比度，上面是按 token 值推的，标 未核实 的是「肉眼是否看得出」这一句）。
  - 没有 chevron、没有「展开」字样、没有「查看」按钮：展开前整行看起来与不可点的行没有区别，只有 `aria-expanded` 给读屏。
  - 行右侧的 `trailing`（自有/覆盖/锚点 + 单价）在 `relative z-10` 的容器里（`ListRow.tsx:121-129`），盖在拉伸的点击层上面，所以**点右侧那个角色词不会展开**（死区）。
- 单测证明展开可用：`apps/web/src/components/geo/tabs/GeoTabs.test.tsx:360-378`（展开后出现 `[data-geo-source-detail]`、「三项都未核实」）。R11 的 walk 也点过（见 1.4）。所以「打不开」更可能是：展开后只看到三项条件 + 单价（多数行可能只有「三项都未核实」），读者期待的是「谁引了它、讲错了什么」。线上每行实际展开成什么样 未核实（我没有线上数据）。

### 1.2 行的 view model、服务端已经能给什么

行的字段（`apps/web/src/lib/geoClient.ts:413-426` `GeoSourceRow`）：`id`、`domain`、`name`、`kind`、`layer`（`anchor|coverage|owned|null`，`:53`）、`conditions{icp,newsIndexed,medical}`、`impostor`、`cited: Record<engine, number>`、`mentionsOurs`、`wrongOurs`、`market{price,resourceId}|null`。`GeoSources` 外层另有 `linklessEngines`、`expectations`、`battlefield`、`tiers`、`chosenTier`（`:434-` 起）。

接口：`GET /api/geo/projects/:id/sources`，`geoClient.ts:730-732` → `apps/server/src/geoRoutes.mjs:352` → `GeoService.sources` `apps/server/src/geoService.mjs:1121` → `sourcesOf` `:1124`；行映射在 `:1165-1172`（`cited` 的 pool 维度被折叠成每引擎一个整数，`:1168-1169`）。表是 `evimed_geo.sources`（`apps/server/src/geoPersistence.mjs:397-419`），读取上限 2000 行（`apps/server/src/geoStore.mjs:979`），所以「1,440 个信源」是真实行数。

三个计数怎么来的（**这决定了「有 14 处讲错」能不能指到这个信源**）：`apps/server/src/geoMeasureStore.mjs:1068-1105` `refreshSourceCitations`，由 `geoMetricsJob.mjs:52, 200-201` 在 baseline / weekly / single_step 这三种轮结束时调用：

- 取这一轮所有 `valid|refusal` 的快照，连同 `facts`（`:1069-1072`）；
- 每个快照里出现过的引用域名各记一次（`www.` 折叠，同一快照同一域名只算一次，`:1077`）；
- `被引用 N 次` = 引用了该域名的**答案数**（所选引擎的 `cited[engine]` 之和，不是链接数；`SourcesTab.tsx:54-58, 172-189`）；
- `提到你 M 次` = 这些答案里 `facts.mentions_ours` 为真的个数（`geoMeasureStore.mjs:1084`）；
- `有 K 处讲错` = 这些答案里 `facts.failure_mode === "wrong_ours"` 的个数（`:1085`），而 `failure_mode` 是整条答案级的：只要答案里有一条陈述 `verdict === "wrong"` 就是 `wrong_ours`（`apps/server/src/geoParse.mjs:343-344`）；
- 数字是「这一轮」的，不是累计（`geoMeasureStore.mjs:1063-1067`，以及 `:1090-1093` 没被这轮引用的域名会被清零）。

结论：`wrongOurs` 是**共现计数**（答案引用了该站、且这条答案讲错了我方），**不是归因**，答案里讲错的那句话未必出自这个站。

「信源 → 引用它的答案 / 它被归因的错误」的查询现在**不存在**：

- 没有 `GET …/sources/:item`：`geoRoutes.mjs:62-72` 的路径归一化允许 `/:tab/:item`，但 GET 处理只有 `answers`（`:375`）和 `screenshots`（`:376` 起）有 4 段路径；`geo_read` 的 `sources` 视图（`geoService.mjs:1530-1534`）也只是同一份 `sourcesOf` 分页。
- 数据其实都在库里，现成的可复用查询模式：
  - 答案 → 引用：`evimed_geo.snapshots.citations jsonb`（`geoPersistence.mjs:255-272`），每项 `{url, domain, title, inBody}`（`geoParse.mjs:232-233, 241-258`）；`#linklessEngines` 已经示范了对它做 `jsonb_array_elements` 横向展开（`geoService.mjs:1042-1049`）。
  - 答案 → 问题/引擎/日期/讲错：`snapshots`（`question_id`、`engine`、`asked_at`、`round_id`）⋈ `facts`（`failure_mode`、`mentions_ours`、`statements`），`GeoService.answer` 里已有同类 join（`geoService.mjs:1057-1100`）。
  - **精确归因**另有一条路：`evimed_geo.errors.cited_source jsonb`（`geoPersistence.mjs:317`）。`traceError`（`geoErrors.mjs:149-166`）在答案带行内角标时把这句错话归到一个具体来源：`{url, domain, attribute, basis: "inline_marker"}`；没有任何检索则 `basis: "no_retrieval"`；有引用但无法定位到哪一条则 `basis: "not_attributable"` 加 `candidates`（最多 5 个域名）。这些已经随 `diagnosis` 接口下发（`errorView` `geoService.mjs:203-217`，`citedSource` 在 `:211`；诊断的错误列表上限 `geoDiagnosisErrorLimit` 默认 300，`geoService.mjs:319, 886-887`）。所以前端**不加服务端接口**就能按 `error.citedSource.domain` 在客户端分组出「被归因到这个站的错误」（每条带 `firstSnapshotId`、`statement`，可链到 `/app/geo/:geoId/answers/:snapshotId`），只是这个数不会等于行上的「有 14 处讲错」，文案必须区分「被引用的答案里有 14 条讲错」与「其中 N 条能指到这个站」。
  - 想要「所有引用它的答案（引擎、问题、日期）」这一层则**需要一个新的服务端契约**（例如 `GET /api/geo/projects/:id/sources/:sourceId` 返回 `citedBy[]` 与 `errors[]`）。

### 1.3 其他 GEO 标签：哪些行「看着可点但点不开」，哪些真能打开

| 标签 | 行/元素 | 实际行为 | 位置 |
|---|---|---|---|
| 总览 | 「本周」`ListRow` | `to={weekTarget(...)}` 真跳转（目标由 `weekTarget` 决定，可能为 null 则是静态行） | `tabs/OverviewTab.tsx:202-215`；`geoOverviewModel.ts:702` |
| 总览 / 准确与安全 | `GeoErrorCard`（错误卡） | 卡本身不可点；卡内「看回答」`Link` → `/app/geo/:geoId/answers/:snapshotId`，「写纠错稿」按钮开对话 | `components/geo/GeoErrorCard.tsx:61-73`；`tabs/AccuracyTab.tsx:342`；`tabs/OverviewTab.tsx:147` |
| 可见度 | 数字（`CellLink`） | 数字本身是链接，悬停加下划线，打开该数字背后的第一条答案 | `tabs/geoTabKit.tsx:232-262`；`tabs/VisibilityTab.tsx:231, 264, 340` |
| 准确与安全 | 按类型的 `DataTable`、`Disclosure` | 静态 / 折叠，无跳转 | `tabs/AccuracyTab.tsx:160, 268` |
| 问题与回答 | 问题组标题 | `<button>` + chevron，点开展开该组 | `tabs/QuestionsTab.tsx:246-257` |
| 问题与回答 | **每条测量问句 `<li>`** | **整行有 `hover:bg-surface-1`，但整行不是点击目标**；只有行尾的「看回答」`Link`（有答案时）和「移出测量问句」按钮能点 | `tabs/QuestionsTab.tsx:297, 306, 312`；落点路由 `router.tsx:101`、`geoTabText.ts:212` |
| 行动 | 稿件 `ListRow` | 有 `runId+path` 则 `onOpen` 打开该运行文件；只有 `cardId` 则打开阅读弹窗；两者都没有则整行是静态 `<span>` | `tabs/ContentTab.tsx:125-128`（并列「打开 / 查看 / 放行」文字按钮 `:142-145`） |
| 行动 | 投放订单 | 只有外链 `<a>` 按钮，行本身不可点 | `tabs/DistributionTab.tsx:172, 230` |
| 方案 | 结论（claim）`ListRow` | 点开就地展开引用原文 | `tabs/EvidenceTab.tsx:124-127` |
| 方案 | 引擎检索触发率等 | `CellLink` 同上 | `tabs/PlanStrategy.tsx:193` |
| 信源 | 信源 `ListRow` | 就地展开三项条件 + 单价，无详情页 | 见 1.1 |

「真正点进具体对象详情」的只有 `/app/geo/:geoId/answers/:snapshotId` 一条（`router.tsx:101`），入口是 `CellLink`、`GeoErrorCard`、问题行的「看回答」。**信源没有对应的详情落点**。

### 1.4 walk 与 DESIGN.md 对「看着可点的行」的约束

`scripts/ops/ui-walk.mjs:345-351`：

```
export const ROW_CLICK_PAGES = new Set([
  "files", "memory", "memory-project", "memory-methods", "memory-growth",
  "frontier", "frontier-hot", "frontier-daily", "frontier-all",
  "extensions-plugins", "extensions-skills", "virtual-research",
  // R11: a source opens its three conditions in place; a scheduled task opens its drawer. Both read what the row holds and write nothing.
  "geo-sources", "autopilot",
]);
```

- GEO 的七个页面都在 walk 路由里（`ui-walk.mjs:235-236` 的 `geo-overview … geo-plan`），但**被「点第一行」的只有 `geo-sources`**，另有 `geo-answer` 页只做版面预算（`:280, 294`）。`geo-questions`、`geo-accuracy`、`geo-actions`、`geo-plan` 不在名单里，所以「问题行悬停像可点但整行不可点」这类问题 walk 抓不到。
- 点击探针 `rowProbe`（`:1518-1546`）只枚举 `main ul/ol > li [data-row-title]` 的第一项并 `control.click()`——**这是程序化 click，不是按坐标点**，抓不到「点到右侧 trailing 死区无反应」；而 QuestionsTab 的行没有 `data-row-title`，天然不在探针范围。
- 通过标准（`rowClickShown` `:622-624`）只要「出现 dialog / 地址变 / 开新标签 / `aria-expanded='true'` 变多」之一；`geo-sources` 另有 `afterClickFindings`（`:1096`）：只检查 `[data-geo-source-detail]` 出现（`:1070`）。**没有任何断言说明展开后的内容有用**，「三项都未核实」也算通过。
- 行数提示预算：`ROW_COUNT_NOTICE_BY_PAGE = { "geo-accuracy": 20, "geo-sources": 40 }`（`:713`）。
- `DESIGN.md`：
  - 规则 2：「Detail opens in the right-hand drawer (`Drawer`); the list stays where it is. A row does not take the reader to another page to read what it holds.」`DESIGN.md:356-357`。
  - 规则 6：「What looks clickable shows a result where the reader is looking. A drawer, a new page, a tab or a row opened in place … The walk clicks the first row of each list on the rebuilt pages and fails a click that shows nothing.」`DESIGN.md:365-367`。
  - 悬停态是 `surface-2`：`DESIGN.md:388`（与 `ListRow.tsx:115` 的 `surface-1` 不一致）。
  - `ListRow`：「the title is the row's target … at most two quiet actions and “⋯”, always visible」`DESIGN.md:334`；`ListRow.tsx:76-79` 的注释记录了 owner 2026-09-24 的裁定：只在指针下才出现的操作「reads as missing」。
  - Don't 列表：「rely on hover to reveal anything a keyboard user needs」`DESIGN.md:464-465`。
  - 规范里没有「就地展开的行必须带 chevron」这一条。

### 1.5 自有 / 覆盖 / 锚点，以及「只看」菜单

- 词表：`apps/web/src/components/geo/geoText.ts:334-338` `GEO_SOURCE_LAYER_WORDS = { anchor: "锚点", coverage: "覆盖", owned: "自有" }`；域内标签是「锚点层 / 覆盖层 / 自有层」`packages/domain/src/geoVocabulary.mjs:201-202`。`SourceTrailing` 在行右边显示这个词和「¥xx/篇」`SourcesTab.tsx:191-201`，组件注释写的是「Where we would place there」（我们在那儿投放的层）。
- 代码里**没有给这三层下定义**，层属是 `geo-strategy` 能力的模型在写策略时给每个站写进去的 `layer`（`capabilities/geo-strategy/SKILL.md:59-64`；写入校验 `apps/server/src/geoWrites.mjs:764-840`，其他层名如 `correction_only/excluded/unassigned/blacklist` 一律存成「无层」`:801-838`）。代码里能确认的语义只有：
  - `owned`：被当作「我方自有域名」使用——`projectContext` 读 `layer = 'owned'` 的域名去判断答案是否引用了我方（`geoMeasureStore.mjs:256`）；数据修复脚本也有「误标成自有」的纠正（`geoDataFixes.mjs:176-178`）。
  - `coverage`：平台可以下单投放的层，必须三项条件（备案、新闻源、医疗）都为真才会下单——`SKILL.md` 里「The three conditions decide placement: the market only ever places into a site whose icpMatches, newsIndexed and medicalVertical are all true」`capabilities/geo-strategy/SKILL.md:76-79`。
  - `anchor`：权威外部机构，只靠被引、不投放——来自一份评测产物的描述「外部权威机构只靠被引，不投放」`evals/geo-strategy/results/2026-09-25-xinermei-sources-step/deliverable/deliverables/geo-strategy/geo-strategy.md:147`，不是代码里的定义（未核实它是否仍是现行口径）。
  - 私有 geo-skills（`runtime/skills/geo-private/`，gitignored）里可能有正式定义，本 worktree 里没有，未核实。
- 「只看」菜单（`SourcesTab.tsx:18-24, 66-71, 104`）：
  - 「全部信源」（清除）
  - 「讲错过我方」→ `wrongOurs > 0`
  - 「提到过我方」→ `mentionsOurs > 0`
  - 「自有渠道」→ `layer === "owned"`
  - 引擎 chip 是「全部引擎」+ 在某个信源里出现过引用的引擎，其值决定 `citedCount` 取哪个引擎的计数并用它排序 `:87-90`。

### 可行的改法与所需改动（问题 1）

1. **点开后给读者想要的东西**（需要决定落点形式）：
   - 落点按 `DESIGN.md:356` 用右侧 `Drawer`（`apps/web/src/components/ui/Drawer.tsx`），改 `SourcesTab.tsx:119-132`：`onOpen` 开抽屉而不是就地展开，原三项条件 + 单价放进抽屉头部。
   - 抽屉里至少能列：引用它的答案（引擎、问题文本、日期、是否正文引用）与被归因到它的错误（链到 `answerPath` `geoTabText.ts:212`）。
   - **不加服务端契约的版本**：只列 `getGeoDiagnosis` 里 `errors[].citedSource.domain === source.domain` 的错误（`geoService.mjs:211` 已下发，上限 300 条）；做不到「所有引用它的答案」。
   - **完整版本需要新契约**：`GET /api/geo/projects/:id/sources/:sourceId`（在 `geoRoutes.mjs` `:375` 附近加 handler，`geoService.mjs` 加 `sourceDetail`，用 `jsonb_array_elements` 展开 `snapshots.citations` 并 join `facts`/`errors`），客户端在 `geoClient.ts:730` 旁加 `getGeoSource` 和类型，并更新 `GeoTabs.test.tsx`、`ui-walk.mjs`（`AFTER_CLICK_KIND`/`afterClickProbe` `:1070, 1096, 1552`，让它断言抽屉里有内容而不仅是出现）。
2. **让「可点」看得出来**：`ListRow` 在 `onOpen` 行上加 chevron（`leading` 或 `trailing`）并把悬停底色改成 `surface-2`（`ListRow.tsx:115`，共享组件，影响所有列表）；`trailing` 的 `z-10` 死区（`ListRow.tsx:121-129`）要么让点击穿透要么把角色词也变成可点。
3. **文案按口径改**：「有 14 处讲错」是「引用它的答案里有 14 条讲错」（共现），不是「它讲错了 14 处」；需要改成不会被读成归因的句式，或只显示归因计数（能指到这个站的）。
4. 问题与回答的问句行：要么去掉整行 `hover:bg-surface-1`（`QuestionsTab.tsx:297`），要么把整行变成「看回答」的目标。
5. 把 `geo-questions` / `geo-accuracy` 等加入 `ROW_CLICK_PAGES`（`ui-walk.mjs:345`）时，问题行要先有 `data-row-title`，否则探针看不到。

---

## 问题 2：对话页底部——模块 chip 与参数 select 堆在最底，没有底部留白

### 2.1 哪些元素是内核渲染，哪些是 EviMed 放在内核槽里的

对话页是一个 `<iframe>`（内核的浏览器应用），外壳只负责把它铺满：`apps/web/src/app/layout/SessionFrameHost.tsx:230-241` → `apps/web/src/app/routes/RuntimeUiFrame.tsx:1104-1108`（`absolute inset-0 h-full w-full border-0`），外层 `AppShell.tsx:156`（`flex h-dvh w-screen overflow-hidden bg-bg`）和 `:208`（`<div className="relative min-h-0 flex-1">`）都没有任何内边距。EviMed 在 iframe 里的代码是 `packages/harness-port/src/runtimeUi*.mjs`（经 `packages/socket/scripts/build-client.mjs` 打成客户端 bundle，`runtimeUiFrame.mjs:189-212`）。

| 截图元素 | 谁渲染 | 槽 / 位置 | 证据 |
|---|---|---|---|
| 回复下方一行图标（复制、分支/分享、「用量 6.1M tok」、时间） | 内核 `ui-chat` 的 `turn-tail` 节点 | `conversation.chat.node` key `turn-tail`，子槽 `conversation.chat.turnTail`、`conversation.chat.assistant-actions` | 内核包 chat `lib/client.js`@307758；shell 测试把「复制」「在新对话中分支」当作保留的按钮 `packages/harness-port/test/runtimeUiShell.test.mjs:101-106`。「分享」这个图标具体是哪一个我没有核实 |
| 输入框卡片、占位文字「继续提问…」、「＋」按钮 | 内核 `ui-conversation` `InputBar` | `conversation.composer.bar`。「＋」是内核的命令菜单按钮（`aria-label` = `input.commands`，`/工具` 就挂在这里） | 内核包 conversation `lib/client.js`@672336 |
| 回形针 | **EviMed** | `conversation.input.left`，id `evimed-upload`，order -100 | `packages/harness-port/src/runtimeUiComposer.mjs:71` |
| 模型选择「deepseek-flash High ⌄」、发送键 | 内核 | `conversation.input.model`、`primary` 按钮 | 内核包 conversation@673937 |
| 「1 轮 86 步 · 251 tok/s」「6.1M tok · 缓存命中 95%」 | 内核 `ui-chat` 的 `StatsPills`（`TimePill`、`UsagePill`） | `conversation.composer.dock`，id `stats`，order 0 | 内核包 chat@322375, @528086（`ctx.slots.register({ name: "conversation.composer.dock", id: "stats", order: 0 }, StatsPills)`）；`packages/harness-port/src/runtimeUiSlots.mjs:106-110` 的注释同说 |
| 蓝色 chip「虚拟临床研究 ×」 | **EviMed** `ToolChip` | `conversation.composer.dock`，id `evimed-tool`，order 10（排在统计之后） | `packages/harness-port/src/runtimeUiCommands.mjs:376-406, 484-490` |
| select「起点：队列 ⌄」「预期用途：探索 ⌄」 | **EviMed** `VcrControls`（原生 `<select>`） | 与 chip 在同一个 `DockedChip` 里，同一个槽 | `runtimeUiCommands.mjs:465-482, 484-490` |
| 圆环「20%」 | 内核 `ContextMeter`（上下文占用），**不在任何槽里**，直接渲染在 dock 容器里的槽之后 | 容器 `InputBar` 的 `.dock` | 内核包 conversation@677451（`renderSlot("conversation.composer.dock") … , activity ? null : jsx(ContextMeter)`）；@644668 起 `ContextMeter` 定义 |

chip 与 select 的数据来源：外壳（`apps/web`）读研究，通过 bridge 消息 `vcr` 发给 iframe。`apps/web/src/components/vcr/useFrameVcrOptions.ts:34-80`（会话绑定到五个 vcr 能力之一，才去读研究）→ `frameVcrOptions.ts:86-98`（`controls: study !== null`；`startOptions` 只在有 `write` 权限时才有；`canSetUse` 需要 `manage_study`）。iframe 里 `runtimeUiCommands.mjs:326-328` 收到后保存，用户改动通过 `vcr-options` 回写（`changeVcr` `:334-338`）；GEO 同构（`:293-295`）。

版面怎么定的（`runtimeUiCommands.mjs`）：

- `DockedChip`（`:484-489`）是一个 `display:inline-flex; flexWrap:wrap; alignItems:center; gap:4px; minWidth:0; maxWidth:100%; marginTop:8px` 的 `<span>`，里面依次放 `ToolChip`、`GeoControls`、`VcrControls`。`marginTop: '8px'` 在这里（`:487`），`ToolChip` 的 docked 模式也带 `marginTop:'8px'`（`:400`）。
- 每个 select 的样式是 `optionStyle`（`:411-414`：24px 高、`padding: 0 8px`、12px 字、圆角 999px）加 `appearance:'auto'`（`:474, 478`）；**没有 `width`/`maxWidth`**。
- 「预期用途」select 很宽的原因：原生 `<select>` 的宽度取全部 `<option>` 里最长的一条，而选项文字是 `预期用途：${label}`（`:480`），`label` 来自 `VCR_INTENDED_USE_LABELS_ZH`：探索 / 研究设计支持 / 指定研究分析 / 申报准备（`packages/domain/src/vcrVocabulary.mjs:170-172`）。最长的是「预期用途：研究设计支持」「预期用途：指定研究分析」（各 11 个汉字），所以选中「探索」时控件也按 11 个汉字撑宽。「起点：…」选项最长是「起点：自动/队列/患者/对照/试验」（`frameVcrOptions.ts:36-42`），短得多。
- 注意 `runtimeUiFrame.mjs:119-124` 里关于 vcr 的注释写「carries no frame controls … not chips on the composer」，已经与现行行为矛盾（`runtimeUiCommands.mjs:326-338, 465-482` 明明画了控件），是过期注释。

### 2.2 内核默认在输入框下面渲染什么、EviMed 对研究者/运营者的差别

- 内核默认（0.1.7-rc.2）：`.dock` 里是 `renderSlot("conversation.composer.dock")`（仅当 `variant==="composer"` 且有 session 时，内核包 conversation@677378）加 `ContextMeter`；`StatsPills` 默认模式 `detailed`（`DEFAULT_PERFORMANCE_USAGE = "detailed"`，chat@507951），详细模式画 `TimePill`（`stats.counts` = 「{turns} 轮 {steps} 步」+ tok/s，chat@234644, @314106）和 `UsagePill`（「{总 tok} · 缓存命中 {n}%」，chat 函数 `UsagePill`）。两者都是 `aria-haspopup="dialog"` 的按钮，点开会话统计弹层。这与截图一致。
- EviMed 的差别在 `packages/harness-port/src/runtimeUiShell.mjs`：
  - `:120` `operator ? '' : '[data-composer-stats]{display:none !important}'`——**研究者看不到整块统计（含「N 轮 M 步 · tok/s」与「tok · 缓存命中」）**；
  - `:125` `operator ? '' : '[data-turn-tail] span:has(> button[aria-haspopup="dialog"]){display:none !important}'`——研究者看不到回复尾部的「用量」「用时」按钮（复制、分支、时间仍在）；
  - **圆环「20%」没有被隐藏**：`ContextMeter` 用 CSS-module 哈希类（`JObwrW_*`），shell 样式表里没有针对它的规则（`runtimeUiShell.mjs:85-197` 全文），对研究者和运营者都显示。
- operator 标志的来源：iframe 启动脚本 `runtimeUiBootstrapSource` 的 `operator` 字段（`apps/server/src/runtimeUiServer.mjs:690-701`，`config.operatorUsers.includes(String(user.id))`）← `apps/server/src/config.mjs:2794-2796`（`OPEN_SCIENCE_OPERATOR_USERS` 逗号分隔的账号 id）← `deploy/web/docker-compose.yml:847, 2052`；iframe 里 `runtimeUiShell.mjs:305`（`target.__EVIMED_FRAME__?.operator === true`）传给 `shellStylesheet`。这条规则来自 2026-09-29 的 owner 裁定（「operators may see session statistics」），提交 `1e1ef19c5`（2026-09-29）；2026-09-24 的 `8590a468e` 先把它们对所有人隐藏。单测 `runtimeUiShell.test.mjs:98-122` 两个分支都断言。`DESIGN.md:464-467` 的 Don't 清单也把 `token, 缓存命中, tok/s` 列为不应出现在用户页面的后台文字。
- 截图里统计行出现，按代码推断：该账号在 `OPEN_SCIENCE_OPERATOR_USERS` 里。生产环境实际的 operator 名单我没有读（未核实，只做了推断），所以「owner 账号会不会看到」答案是：**会，只要它的 id 在该列表里；截图本身说明这个账号在**。

### 2.3 底部留白：哪些 CSS 决定，有没有被 EviMed 去掉

内核 `ui-conversation`（0.1.7-rc.2）自己的规则（全部来自 `lib/client.js` 里内联的 CSS 字符串）：

- 输入区外层 `.root{padding:0 var(--dsh-composer-side-clearance) 4px; flex-direction:column; align-items:center; display:flex}`——**底部内边距只有 4px**（@651974 起的 `InputBar` CSS）。
- 卡片下面的行 `.dock{justify-content:center; align-items:center; gap:12px; max-width:100%; padding-top:4px; display:flex}`——**没有 `flex-wrap`**，单行居中，项目间距 12px（同上）。
- 变量：`--dsh-composer-side-clearance:16px; --dsh-composer-dock-inset:8px; --dsh-composer-stack-gap:6px; --dsh-composer-card-max-width: 内容宽 + 32px`（@578758 起，`.wSkVaW_body`、`.wSkVaW_composerStack`）。
- 对话活跃时 `.composerSeat` 是 `position:sticky; bottom:0`，背景是 36px 的渐变（同处）。所以输入框 + dock 总是贴在滚动容器的底边；消息列表本身在 `ui-chat` 的 `.scroll` 里有 16px 上下内边距（chat@82057）。
- 没有任何其他容器给输入区加底部内边距。

EviMed 侧：

- `runtimeUiShell.mjs:85-197` 的样式表里**没有任何** `padding-bottom` / `margin-bottom` / `composer` / `dock` 规则；`runtimeUiTheme.mjs` 只覆盖颜色与字体 token（`THEME_LAYER_SOURCE` 注释 `:5-58`），没有几何 token（内核本身也没有几何 token，见 `runtimeUiTheme.mjs:44-46` 的注释）。也没有「去掉内核底部内边距」的规则。
- EviMed 反而在 dock 里加了高度：`DockedChip` 的 `marginTop:8px`（`runtimeUiCommands.mjs:487`）。因为 `.dock` 是 `align-items:center`，这个外边距让 chip 组的外框变成 8+24=32px，并把 chip 内容相对统计行向下推约 4px（按 CSS 推算，未在浏览器里量）。
- 外壳也不加缓冲：`RuntimeUiFrame.tsx:1104-1108`、`SessionFrameHost.tsx:230-241`、`AppShell.tsx:208` 都没有 padding。所以最下面这一行离窗口底边是 4px。

dock 行高度（按 CSS 推算，未核实实际像素）：`StatsPills` 的胶囊 12px 字、`line-height:20px`、`padding:1px 8px`，约 22px；`ContextMeter` 触发器也约 22px；chip/select 24px + 8px 外边距 = 32px；加 `.dock` 的 `padding-top:4px` 与 `.root` 的 `padding-bottom:4px`，输入卡片下方整体约 40px（有 chip 时），无 chip 时约 30px。

换行时：`.dock` 自己不换行，所有子项 `min-width:0` 收缩；`StatsPills` 的标签有省略号（chat@310125 的 `.bOPqQW_label{text-overflow:ellipsis}`）；`DockedChip` 的外层 `<span>` 自带 `flex-wrap:wrap`（`runtimeUiCommands.mjs:487`），所以空间不够时是 chip 组自己折成多行，dock 变高，`sticky` 的输入座位整体上移，输入卡片被顶高，底边仍贴着 iframe 底。

底部那条黑条：**未核实**。代码里 iframe 之下没有任何元素：`AppShell.tsx:156` 根节点 `bg-bg`（浅色 `#fafbfc`）；iframe 自己 `absolute inset-0`；`runtimeUiDocument.mjs` 只改 `<head>` 里的 base 与脚本地址，没有背景色。不能从源码解释黑条，候选是截图工具或操作系统窗口边缘、或 iframe 内核文档在浅色外壳里按暗色 `color-scheme` 绘制画布（`apps/web/src/index.css:130, 195` 只管外壳）——需要在浏览器里检查 iframe 的 computed 背景才能定。

### 2.4 内核在输入区附近的槽（0.1.7-rc.2）

EviMed 契约表 `packages/harness-port/src/runtimeUiSlots.mjs:83-125` 登记的与输入区相关的槽，加上我从内核包里读到的完整集合（conversation 包 24 个、chat 包 6 个、layout 包 2 个）：

| 槽 | 类型 | 位置 | EviMed 现状 |
|---|---|---|---|
| `conversation.input.dock` | list | 卡片**上方**，`composerStack` 内，注释说它「spans the frame」，占用者须自己限制到输入框宽度 | 已声明未占用，2026-09-23 起空（`runtimeUiSlots.mjs:101-105`） |
| `conversation.composer.bar` | single | 整个输入栏（可整体替换） | 未占用 |
| `conversation.input.left` | list | 卡片底栏左侧：「＋」→ 权限/计划 → 此槽 | EviMed 占用（上传回形针，order -100） |
| `conversation.input.right` | list | 卡片底栏右侧，位于**模型选择之前**；容器是 `.trailing{flex:none; gap:12px; margin-left:auto}` 里的 `.standardControls{display:flex; gap:12px; min-width:0}`（活动面板展开时 `hidden`） | 已声明未占用（`runtimeUiSlots.mjs:115`） |
| `conversation.input.model` / `.permission` / `.plan` | single | 模型选择 / 访问模式（EviMed 用 CSS 隐藏了 permission 的按钮，`runtimeUiShell.mjs:112`）/ 计划 | 未占用 |
| `conversation.input.attachments` | single | 附件条 | EviMed 接管但原样保留内核行为（`runtimeUiComposer.mjs:70`） |
| `conversation.input.activity`、`conversation.input.overlay` | single / list | 活动面板 / 输入框上方的浮层锚点 | 未占用 |
| `conversation.composer.dock` | list | 卡片**下方**，`.dock` 单行居中 | 内核 `stats`（order 0）+ EviMed `evimed-tool`（order 10） |
| `conversation.composer` | chain | 整个输入座位（含审批等） | 未占用 |
| `conversation.hero.agentPreset` | single | 空白会话的标题下 | EviMed 占用（`HeroTools` + starters，`runtimeUiCommands.mjs:535-544`） |

要点：模块 chip 和参数可以搬进卡片底栏——`conversation.input.right` 正好在模型选择的左边，`conversation.input.left` 在回形针旁，`conversation.input.dock` 在卡片上方；但底栏容器 `.trailing` 是 `flex:none`，不会收缩，现有三个控件（chip、起点、预期用途，宽度合计约 400px）塞进去会挤占左侧，需要先把它们收成更紧凑的形态。空白会话没有输入栏上的槽（`conversation.input.left/right` 只在有 session 时渲染，`runtimeUiCommands.mjs:50-53` 的注释），所以空白会话的 chip 在 hero 座位里（`:535-544`）。

### 2.5 GEO 对话的参数控件

同一个槽、同一个组件：`DockedChip`（`runtimeUiCommands.mjs:484-490`）里 `GeoControls`（`:429-458`）在 `ToolChip` 之后、`VcrControls` 之前：

- 原生 `<select aria-label="覆盖周期">`，选项「覆盖 30/60/90/180 天」（`GEO_COVERAGE_DAYS` `geoText.ts:242`；iframe 里 `:443-445`）。
- `<details>` 摘要「N 个 AI 引擎 ▾」，展开为 checkbox 弹层，样式 `popoverStyle` 是 `position:absolute; top:'28px'`（`:415-420`）——**向下展开**。因为 dock 贴着 iframe 底边（离底 4px），这个弹层会被 iframe 裁掉一部分或全部；这一点来自样式推断，**未在浏览器里核实**。
- 数据来源 `apps/web/src/components/geo/useFrameGeoOptions.ts`、`frameGeoOptions.ts:30-56`（`controls: project !== null`；`engines`、`offered`、`coverageOptions`）。

### 可行的改法与所需改动（问题 2）

1. **把 chip + 参数从底部行搬走**：改 `packages/harness-port/src/runtimeUiCommands.mjs:490` 的 `kit.occupy({ slot: 'conversation.composer.dock', … })`：chip 占 `conversation.input.left`（或 `conversation.input.dock` 在卡片上方，需限制到输入框宽度，见 `:32-37` 的注释），参数占 `conversation.input.right`（模型选择之前）。这个槽表已存在，**不需要新的数据契约**；要先把三个 select 缩成一个紧凑的设置入口。改 `runtimeUiCommands.mjs` 要重建 socket 客户端 bundle（`packages/socket/scripts/build-client.mjs`），随运行时镜像发布，不只是 web 发布；`packages/harness-port/test/runtimeUiCommands.test.mjs` 里与槽名有关的断言要同步。
2. **预期用途 select 过宽**：给 `optionStyle`（`runtimeUiCommands.mjs:411-414`）加 `maxWidth`/固定宽度，或只在打开时显示完整文案、收起时显示「预期用途：探索」的短标签。无数据契约改动。
3. **补底部留白**：只改 EviMed 侧——`runtimeUiShell.mjs:85-197` 的 `shellStylesheet` 里加一条规则（需要用内核的稳定属性，如 `[data-slot="conversation.composer.dock"]` 的父级 `:has(...)`，而不是哈希类；shell 里已有同类写法 `:195`、`:132`），或者给 `DockedChip` 加 `marginBottom`。因为内核本身只给 4px，不是 EviMed 去掉的；`GEOMETRY_KERNEL_PIN`（`runtimeUiShell.mjs:51`）要和内核 pin 同步。
4. **GEO 引擎弹层**：`popoverStyle` 把 `top:'28px'` 改成 `bottom:'28px'`（`runtimeUiCommands.mjs:416`），或随位置搬走。
5. 顺手：更新 `runtimeUiFrame.mjs:119-124` 的过期注释。

---

## 未核实清单

- 线上「信源」每行展开后的实际内容、有多少行三项都未核实（需要线上数据）。
- `ListRow` 悬停色 `surface-1` 在页面上是否肉眼可见（按 token 推断，没有量）。
- 「分享」图标的真身（shell 测试只出现「复制」「在新对话中分支」）。
- dock 行与输入区下方的像素高度、chip 组与统计行的 4px 错位、GEO 引擎弹层是否被裁（都来自 CSS 推算，没有在浏览器里量）。
- 底部黑条的来源。
- 生产环境 `OPEN_SCIENCE_OPERATOR_USERS` 的实际内容（只按截图推断 owner 账号在其中）。
- 锚点 / 覆盖 / 自有的权威定义（私有 geo-skills 不在本 worktree，上面三条是从 SKILL.md、代码用途和一份评测产物拼出来的）。
- 内核包取自 npm 上的 0.1.7-rc.2 tarball，未与线上运行时镜像逐字节比对。

<!-- F1 DONE -->
