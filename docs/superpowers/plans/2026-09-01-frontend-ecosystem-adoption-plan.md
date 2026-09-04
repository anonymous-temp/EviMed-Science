# 前端生态接入方案(2026-09-01)

> **2026-09-04 起，本方案的「明确不做」第二、三条已作废（spec §16 #26）。** 托管会话面改为内核自带的浏览器应用本身，服务在同主机的另一个端口上（路径前缀被实测否掉：它用 `location.origin` 拼绝对路径，`/plugins/…` 与 `/api/<方法>` 在前缀下落回控制面，页面在启动时死而每个请求都是 200）。因此：**UI 件进托管镜像**，按显式清单；**B 轨「借交互不借代码」对会话面不再适用**——那八类呈现现在直接由上游提供，B 轨只保留 DSH 没有的三样。A 轨（本地面 UI 组）不变。

一句话:**UI 插件只作用于 DSH 自己那张网页,所以本地面整包享受、托管面借交互进我们的 React 应用、不给托管建插槽体系。** 拓扑结论与边界见架构总览 §14「前端插件化的边界」;本方案是执行细则,两条轨 + 一条明确不做。

前置事实(已核实):`dsh-web-ui` 这个包不存在(npm 404);真实包族是官方 `@deepseek-ai/dsh-client-ui-{primitives,theme,workflow-run}` 与社区 `dsh-client-ui-aqua`、`@linxin666/dsh-client-ui-{task-board,git-graph,web-ui-settings}` 等(已核 200 的标注在下表);`evimed-web` 本地安装器**尚不存在**(D11 的本地面未立项),所以 A 轨先以「命令块 + pin 清单」交付,安装器立项时并入。

## A 轨:本地面「科研者桌面」UI 组(即插即用的那一半)

**落点**:并入生态清单首批动作 #3 的桌面推荐组(Origin / Stata / Zotero / Overleaf / dsh-market),加一节 UI 件。当下交付形态 = 本文档的命令块 + pin;`evimed-web` 安装器立项后变成安装器里的一段。

**候选(试装档终选 3–5 件;╳ 表示不选)**:

| 包 | 是什么 | npm | 备注 |
|---|---|---|---|
| `dsh-client-ui-aqua` | 玻璃拟态主题 | 200 已核 | 主题位,一件够 |
| `@linxin666/dsh-client-ui-task-board` | 会话任务看板 | 200 已核 | 科研多任务并行的直观收益 |
| `@linxin666/dsh-client-ui-web-ui-settings` | 设置面板增强 | 200 已核 | — |
| `@deepseek-ai/dsh-client-ui-theme` / `-workflow-run` | 官方主题/运行呈现 | 待试装核 | primitives(200)多半是依赖库,不单装 |
| `dsh-md-preview` 系(LeslieWylie / poiuyjie) | Markdown 预览停靠 | 待试装核 | 科研者高频看 md 交付物 |
| `a735624258/dsh-skill-picker` | 技能选择器(composer 旁) | 待试装核 | 与我们 community 技能根相配 |
| `@linxin666/dsh-client-ui-git-graph` | git 图 | ╳ | 对医学科研用户价值低 |

**步骤**(半天到一天,任何一只手可做,不碰 OpenScience 核心):
1. `try:community-bundles` 试装档跑一轮上表候选(它的定位就是「不改镜像、不做门禁,回答装得上吗/什么形态」);淘汰装不上与名实不符的。
2. 终选 3–5 件,精确版本 pin,写入本节命令块并记 `sources` 式来源(repo + commit + 一句为什么):

```sh
# 科研者桌面 · UI 组(版本以试装档终选为准)
dsh plugin --profile evimed-web add dsh-client-ui-aqua@<pin> \
  @linxin666/dsh-client-ui-task-board@<pin> \
  @linxin666/dsh-client-ui-web-ui-settings@<pin>
```

3. 与桌面工具组(Origin/Stata/Zotero/Overleaf/dsh-market)合并为一份 starter pack 说明。

**验收(全部机械)**:①干净 profile 按命令块装齐、重启后页面生效(截图留档);②`dsh plugin remove` 逐件卸载后恢复原样(社区 rc 期有 remove 残留缺陷,本地面备 `dsh-fix-duplicate-loader-id` 与「删残留行重装」流程);③pin 与来源记录齐全;④**托管镜像零变化**——`deploy/runtime-dsh` 不得出现任何 `client-ui` 包(评审断言)。

## B 轨:托管面借交互(线上生效的唯一路径 = 我们发版)

**规则**:借交互设计不借代码;组件只挂 RunStream 新路径(控制面 SSE),不进旧 `LiveSessionPage`;过设计令牌与 ESLint(禁新增任意值);不引第三方运行时 JS 依赖;每件配 Vitest;用 RQ-15 真实运行数据渲染验收。

**第一批(排在「翻默认 + 同 PR 删旧会话层」之后,每件天级)**:
1. **任务 DAG 面板**:`task-plan.json` 的交互式依赖图(借 agent-teams 活动面板 / SmileBuild dsh-planchart 的呈现),挂在运行树旁;归档运行保留全史。
2. **Mermaid / 图表卡片**:交付物与回复里的 mermaid 围栏渲染为可缩放卡片(借 genius-alray/dsh-mermaid-render 的交互:缩放、适宽、全屏、码图切换)。

**第二批(F 轨验收后按产品优先级)**:
3. **运行记录看板视图**(借 task-board:按 phase 分列的运行卡)。
4. **圈注 → 结构化修订请求**(借 md-annotator / paperlab:交付物预览里选中文本提修订,接修复回环)——价值最大,依赖修复回环 UI,故放第二批。
5. workflow-run 的运行呈现细节(借官方件的状态排版)。

## 遇到新前端插件的三问路由(以后按此分流,不逐个讨论)

①有没有工具/技能的那一半?→ 托管照收那一半(混合型很常见:drawio = 四个工具 + 一块画板,收工具丢画板,SVG 产物由我们的前端渲染)。②交互值不值得抄?→ 进 B 轨借模式清单,随发版到达托管用户。③纯 UI/主题?→ A 轨本地推荐组。占比:awesome 收录里 UI/主题/市场/娱乐约三四成只走 ②③;对产品最值钱的六七成(工具/技能/文档/视觉/语音/记忆/工作流)托管完全可用。

## 明确不做与触发条件

- **不给托管前端建插槽体系 / 微前端**(路 C):当且仅当产品决定把托管界面开放给第三方开发者时再立项。
- **不把容器里的 DSH 网页开出去**:`dsh web` 拒绝 `--host 0.0.0.0`、单机单用户、无租户;也无受支持的页内嵌入。
- **UI 件不进托管镜像**:装了也没有浏览器加载,徒增供应链面。

## 排期与依赖

主线不动:L5 四项环境 → e2e → 翻默认 → 附 B 删旧。A 轨随生态一期即可做(独立、零托管风险);B 轨第一批排在翻默认 PR 之后(避免在两套会话页上重复投入);第二批随 F 轨。完成时各记 `PROGRESS.md` 一行。
