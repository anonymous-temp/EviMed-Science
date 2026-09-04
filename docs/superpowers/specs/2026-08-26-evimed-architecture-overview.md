# EviMed Science 架构总览（2026-08-26）

- 文档性质：**当前架构的独立可读总览**——把分散在插排-插头方案（v3.9，30 章）、两份七月上位方案与执行状态（STATUS S0–S158、PROGRESS）里的设计收成一份。它回答四件事：系统是什么、为什么这样设计（原则与逻辑）、每一部分怎么运作（机制）、算法与能力是按什么流程搭起来的。
- 口径：只写核实过的事实；已设计未落地的部分标【设计】，已落地标【已落地】，部分落地标【部分】。深度细节一律指向 `2026-08-22-evimed-dsh-plug-harness-design.md`（下文简称 spec）的章节，本文不复制决策日志。
- 上位文档：`2026-07-16-evimed-openscience-platform-design.md`（平台统一底座 v4）、`2026-07-17-evimed-grok-build-fusion-design.md`（融合方案）；生态接入清单：`plans/2026-08-24-dsh-ecosystem-adoption-shortlist.md`。
- 读者：需要在两小时内完整理解 EviMed 技术形态的工程师、合作方架构师、产品负责人。

---

## 1. 一句话与定位

> **EviMed Science 是一个面向医学科研的 Agent SaaS：一个 React 控制面 + 每项目一个隔离的运行时容器；容器里唯一的 Agent 执行内核是 DeepSeek Harness（DSH），我们的全部科研能力以一个 DSH bundle（「插座」`@evimed/dsh-socket`）挂上去；控制面持有账本、门禁、网关、记忆与计量，运行时只做沙箱里的 LLM 工作。**

用一个比喻贯穿全文：**DSH 是插排，我们做插座**。插排负责电（Agent loop、工具调度、会话、沙箱、模型适配）；插座负责我们家里的电器怎么接（能力目录、契约、证据、记忆、预算）。插座只碰插排文档化的「缝」，并且所有接触点收口在一个防腐层包里，因此插排换型号时改动可定位、可回滚、一个 PR（spec §0.1、§5）。

五件换任何 harness 都不变的东西（护城河，spec §21.6）：契约注册表与门禁规则（`@evimed/domain`）；123 源目录与连接器 + 13 个私有数据 API；六个专科 Python 引擎；从用户资料与行为蒸馏出的方法论（记忆胶囊）；评测语料（RQ 31 份、title-to-paper 50 篇、记忆集）。**它们全部在 DSH 之外。**

三条产品线跑在同一套机制上：科研核心线（证据综述、药物评价、Meta、MR、文献计量、审稿、选题、数据集画像…）、即时问答线（无交付物的直接回答）、GEO 线（P3）。它们不是「模式」，是同一次运行里可以任意组合的**能力**（§5.2）。

---

## 2. 设计原则（每条都有出处，也都有过反例）

| # | 原则 | 含义 | 为什么 |
|---|---|---|---|
| 1 | 简单、明确、清楚、完整 | 上位方案的四字方针；每个模块能用一句话说清它隐藏了什么 | 07-16 方案；Ousterhout《A Philosophy of Software Design》是 spec §14 的母本 |
| 2 | 只写核实事实 | 设计文档里的每个 API 名、事件名、数字都对着源码或数据核过；推断标「推断」，未核标「待核」（V1–V41） | 先前资料里 `ctx.on('tool/after-execute')`、`ctx.subagent.spawn()` 等 API 根本不存在（spec §0.3） |
| 3 | 不形成双 Harness | 系统里只有一个 Agent loop（DSH 的 `dsh-agent-loop`）；插座是策略层不是第二个 loop | 07-17 方案铁律；社区的 agent-teams 之类编排器因此只借模式不整装（§16.3） |
| 4 | 契约绑产出，不绑输入 | 交付物提交时声明契约种类，按种类校验；安全内容触发器兜底；**没有 Mode Router、没有按产品线的 preset** | 输入只能猜，产出可以查；跨模式需求（「若干问题的证据现状」既是综述也是 GEO 提案）靠输入分类必错；DSH preset 产出后不能换（spec §9.1） |
| 5 | 模型判、代码核、人在回路但不挡路 | 模型做判断与生成；机械规则做核验；人只在产物离开平台前签核一次 | `coverageJudge` 实测 3/114 真阳性，语义判分不足以阻断（spec §4.2） |
| 6 | 少门禁：全系统只有 6 个阻断点 | 契约校验、服务端外部门禁、完成检查、预算守卫、路径守卫、导出签核；其余一切非阻断（notice / 标记 / 可回滚） | v3.5 收口删掉 9 项过度设计（spec §29.2–29.3）；UX 优先于安全门是用户的明确取舍 |
| 7 | 被检查方不能提供考题 | 服务端门禁与运行侧门禁**同一份实现**（`@evimed/domain`），但服务端在容器外独立再核一次 | 运行侧 preflight 与服务端门禁在生产漂移三次，每次赔一份完整交付（CLAUDE.md） |
| 8 | 工作区文件为权威 | 计划 = `task-plan.json`；交付物 = `deliverables/<id>/`；回执 = `delivery-receipt.json`；运行状态投影 = `.evimed-run/state.json`；控制面**永不读 DSH 存储** | DSH rc.8 曾无迁移地改存储格式；容器活一次运行、`--rm` 即消失（spec §2.2、§7.2） |
| 9 | 胶囊是上下文，不是权限 | 记忆塑造「怎么做」，永远不能覆盖契约与安全规则；导入的胶囊是不可信内容 | spec §19.3 |
| 10 | 裁决与数学封进引擎，通用手艺留在过程层 | 统计、编译、契约是确定性引擎/门禁（封死）；作图、排版、翻译这类通用步骤保持技能/工具形态（开放） | LLM 永不做统计（各专科引擎 README）；留在过程层的步骤生态在免费替我们升级（spec §21.8） |
| 11 | 生态优先，默认采用而不是设防 | 三档：直接用 > 小改 > 仅护城河自建；插件按 npm 依赖对待（pin + 冒烟 + 夜间矩阵），不设审批流 | spec §16 #22（2026-08-24 拍板） |
| 12 | 断言结果，不断言机制 | 验收条件写成「我要的东西在不在」，不写「我做的动作有没有报错」；对上游配置的断言落在上游读到的值上 | P0 真机验收 22 个缺陷里的共同形状：读法错了都产出「空」，而空与「确实没有」外观相同（spec §30.2） |
| 13 | 不训练任何模型 | 「更了解我」存在上下文里，不在参数里 | LaMP：RAG 式个性化 +14.92% vs PEFT +1.07%（spec §27.2）；DeepSeek 无托管微调（V37） |
| 14 | 一名一义、单点定义 | `kind` 只用于 DSH 判别字段；契约种类 `contractKind`、记忆种类 `factKind`、事件 `eventType`…；每个限额只在控制面 `config.mjs` 定义一次向下派生；版本只在 `deps-version.json` 定义一次 | spec §14 规则 11、21；§10.4；§12.1 |

---

## 3. 分层总览

```text
浏览器（React，简体中文基线，设计令牌单一来源）
   │ HTTPS ── Caddy
   ▼
控制面 apps/server（Node .mjs，checkJs + ESLint 0 warning）【已落地】
   ├─ 身份与项目（OIDC / 本地认证）、运行账本 agentRuns、交付门禁（@evimed/domain）
   ├─ 三个内部网关 /internal/{model,sources,search}/v1（规划：asr / embeddings / capsule / geo-probe）
   ├─ runtimeManager + runtimeControllerServer（容器生命周期，特权 Docker 操作走 unix socket）
   ├─ Postgres 产品账本（运行、交付物、胶囊、议程、额度、通知）
   └─ SSE GET /api/runs/:id/events → 浏览器
   │ unix socket（socat 桥）+ 方法白名单
   ▼
每项目一个运行时容器 deploy/runtime-dsh【已落地，验收中】
   ├─ dsh web（127.0.0.1:4096）profile = dsh-base + dsh-web-app + @evimed/dsh-socket
   ├─ preset evimed-universal：persona + 8 个插座插件 + DSH 出厂工具行 + 技能根 + MCP 行
   ├─ MCP server `evimed`（Python stdio，26 工具）；工作负载令牌，无真钥
   ├─ 沙箱：Docker 加固（cap-drop ALL、no-new-privileges、pids、memory）+ 容器内 Landlock workspace-write
   └─ 工作区（项目数据卷）：.evimed-brief/ · task-plan.json · deliverables/<id>/ · .evimed-run/state.json · delivery-receipt.json
   │ 出网只经网关（HTTPS，服务端持钥）
   ▼
外部与后端服务
   ├─ DeepSeek（经模型网关；证书化的是实际运行的模型）
   ├─ 公共生物医学源 53 个 base URL（经 publicSourceGateway：主机白名单 + SSRF 防护）
   ├─ 六个专科 Python 引擎（Meta / MR / 审稿 / 文献计量 / 选题 / 药物安全），HMAC 适配器容器
   ├─ MemOS 2.0 自托管（记忆底座）【设计，pin 已定】· OpenList（网盘聚合）【设计】· MinerU（文档解析）【设计】
   └─ 私有数据 API 13 个（EVIMED_*_URL 适配器）
```

依赖只向内：浏览器 → 控制面 → 运行时 → 外部；反向只有 SSE 与账本事件。**控制面是多租户边界**（DSH 的 Web 宿主是单机单用户产品，spec §2.4），所以租户、权限、计量、通知、调度全部在控制面，运行时对这些一无所知。

仓库落点（`OpenScience/`）：`apps/server`（控制面）· `apps/desktop`（React 前端；`src-tauri` 待附 B 删除）· `packages/domain`（契约、门禁、状态词汇、工具名、错误码——**唯一实现**）· `packages/harness-port`（防腐层）· `packages/socket`（插座：plugins/ + presets/evimed-universal/）· `packages/contracts/<dep>`（对上游依赖的契约测试）· `capabilities/<id>`（11 份能力清单 + SKILL.md）· `capability-skills/`（打包进镜像的能力正文）· `runtime/mcp/evimed-research`（MCP server）· `deploy/{runtime-dsh,web,specialist-adapter,memos}` · `evals/`（五套评测）· `deps-version.json`（版本单点）。

---

## 4. 运行时组装：插排、插座与防腐层

### 4.1 DSH 的组装模型（核实于 rc.2 源码）

- **Bundle** = 带 `dsh.bundle.patch` manifest 的 npm 包，贡献一份 `cordis.patch.yml`（插入或按 `id` 整体替换行）；**profile** = `$DSH_HOME/profiles/<name>`，列出 bundle 顺序 + 用户自己的 patch。层序：各 bundle → profile patch → home patch → `--patch` 覆盖层；后层按行胜出，`config` 整值替换不深合并（spec §2.3.1）。
- **Agent preset 是模型可见面的唯一决定者**：工具、提示词节、persona 只属于挂它的会话；宿主组合持有注册表、沙箱、审批、持久化、模型路由。preset 在 agent 已产出内容后不能切换（`agent-preset-locked`）。剥离编码工具 = 不写进我们的 preset，零工作量（spec §2.3.4）。
- 缝（seam）：`tools/pre-execute | tools/execute | tools/post-execute | tools/result`、`session/event`、`agent/pre-step`、`agent/turn-stopping`；子代理 `ctx.subagents.start('spawn'|'fork', …)`；工作流 `ctx.workflowEngine`；模型可见注入 `agent.inject()`；插件自有状态 `ctx.storageDomain`。
- 约束：第三方 bundle 不能向会话日志追加自定义事件类型（rc.2 持久化读路径拒绝仓库外类型）——所以任务状态镜像放 `storageDomain`，模型可见的状态经 `agent.inject()` 成一等 `user/message`（D6）。

### 4.2 统一组合 `evimed-universal`（spec §9.2）

一个 preset 供所有会话使用；托管与本地的差异只在 profile patch 与环境变量。行清单：`persona`（EviMed 医学研究助手；简单问题直答；需交付物则 plan → delegate → complete_run；检索顺序记忆/胶囊 → 文献 → 网页；不编造文献、不给具体诊疗建议）→ 五个 agent 面插座插件 → DSH 出厂 `tool-bash / tool-fs / tool-fs-search / tool-jobs / skill-filesystem{includeDefaultRoots:false, customSkillDirs:[core, curated-scientific, office, community]} / tool-skill / tool-ask-user（托管禁用）` → `compaction` 组（`compaction-basic` + `tool-result-pruner{8192/4096/1024}`）→ `delegation` 组（`tool-subagent{spawn, continuable}`、`subagent-control`、`subagent-report{quiet}`、`workflow-worker-thread`、`tool-workflow`）。**不挂**：`tool-todo`（计划只有一个面）、`agent-instructions`（工作区文件不得成为指令）、`str_replace_editor`、`tool-web`、`plan-mode`、`tool-ralph`、`tool-lsp`、`code-runtime`、`cordis` 自指插件工具。能力正文不进技能根——由 `evimed_delegate` 预注入子代理，避免模型绕过委派。

### 4.3 八个插座插件（spec §5.3；`packages/socket/plugins/`）【已落地骨架】

| 面 | 插件 | 隐藏的知识 | 接触的缝 |
|---|---|---|---|
| 宿主 | `seam-probe` | 「本部署的 DSH 是否还是我们认识的那个」：缝存在、覆盖行生效、沙箱等级、版本一致；门禁级失败即拒绝启动 | `ctx.get`、`ctx.tools`、`ctx.shell`、`ctx.agentPresets` |
| 宿主 | `evidence-store` | `storageDomain` 域 `evimed-run@1` 的 schema，与把 `planIndex / evidence / gateRuns` 投影成工作区 `.evimed-run/state.json` | `ctx.storageDomain.open`、`domain/changed` |
| agent | `guidance` | 模型看到的编排指引：能力目录、契约种类摘要、检索优先级、引文卫生 | `ctx.systemPrompt.section` |
| agent | `run-policy` | 「一次运行何时算完成、何时可接受」：四个框架工具 `evimed_plan / evimed_delegate / evimed_submit_deliverable / evimed_complete_run`、题面一次性注入、路径守卫、尝试上限、预算、子代理失败传播、`concludeTurn()` | `defineTool`、`tools/pre-execute`（仅策略）、`tools/execute`、`agent/pre-step`、`agent/turn-stopping`、`session/event`、`ctx.subagents.start`、`agent.inject` |
| agent | `evidence` | 证据台账摄入：在 `tools/result` 上观察 `mcp__evimed__*`，`queued → ready → verified / rejected / stale` | `tools/result`（observer，失败隔离） |
| agent | `capsule` | 记忆胶囊运行时面：`evimed_capsule_recall / evimed_capsule_note`；活动胶囊的方法经 `ctx.skills.register()` 成为技能 | `defineTool`、`ctx.skills.register` |
| agent | `review` | 语义审查者组装：`evimed_review_run`（P2 开关） | `ctx.subagents.start` |
| agent | `screening` | 批量筛选组装：`evimed_screen_batch`（切片、并发上限、只读工具集、固定裁定 schema、CSV 台账） | `defineTool`、`ctx.subagents.start` |

工具统一信封 `{ok, code?, data?, issues?}`；裁定是**返回值**，不经 `deny`。真机验收得出的一条结构规则：preset 作用域里发布的服务必须放进 `isolate` 领域（否则被容器内所有会话共享，内核拒绝挂载——S123 #27）。

### 4.4 防腐层 `@evimed/harness-port` 与 `seam-manifest.json`（spec §5.4–5.6）【已落地】

- port **拥有自己的类型**（`ToolCall`、`TurnEnd`、`PolicyDecision`、`SubagentRequest`）并做形状转换；插件只认这些类型，不读 DSH 原生对象字段。全仓只有 port 可以 `import '@deepseek-ai/*'`（含 JSDoc `import()`），由 grep 测试主承力、ESLint 为辅。
- `seam-manifest.json` 是唯一来源：列出 dsh 版本、必需/可选服务键、事件名、会话事件类型、线协议方法白名单；port 的导出集合、插件 `inject` 常量（`inject ⊆ services`）、启动自检清单、契约测试清单、适配器方法白名单都从它派生。插件不得写 `ctx.on('<字面量>')`，只能调 port 的 `onXxx`。
- 启动自检分级：门禁级（`seam-probe`、`run-policy`、`guidance`；`tools / systemPrompt / agents / sessions / subagents / agentPresets / shell`）缺失即不启动、`/api/ready` 503；增强级（`evidence / capsule / review`；`storageDomain / skills`）降级 + 具名计数 + `qualityNotices` 标注。
- 构建冒烟不止「启动一下」：**启动后真开一次会话**（与控制面同一线协议 `POST /api/session.create`），任何 preset 行装不上即构建失败——这道关在它上线的第一次构建里就抓到了 #27（S120、S123）。

### 4.5 控制面接线（spec §6）【已落地】

- 接线方案 A：DSH Web 宿主 API（`POST /api/<method>` 一元 + WebSocket `/api/events.mux`、`/api/events.host`）。选它因为 stdio SDK 无 preset / 取消 / 审批，ACP 无工具活动流。对冲方案 D（自写协议驱动插件）只在矩阵观察到线协议频繁变动时启用。
- `DshRuntimeAdapter` 五件事：`session.create{cwd, agentPreset:'evimed-universal'}`；派发 `session.prompt{mode:'queue'}`——**没有 `system` 参数**，研究上下文由控制面写入 `.evimed-brief/context.md`，插座在首个 `agent/pre-step` 一次性 `agent.inject()`；读历史 `session.history` 归一化为 `@evimed/domain` 的 `RunTranscript`；读状态用 `events.host` 的 running-status 帧 + `state.json`（`session.status` 不存在）；取消 `session.cancel`。`turn/end.reason.kind` 映射：`completed → succeeded`、`aborted → runtime_canceled`、`blocked → runtime_tool_error{turn_blocked}`、`error / max-tokens → runtime_session_error`、`interrupted → runtime_stopped`。
- profile patch **由控制面每次启动运行时生成**（0o600）：网关地址、令牌变量、preset 根、技能目录、限额派生值；bundle 自己的 patch 不含任何部署路径——同一个插座插托管与本地两种插排不改一行（spec §5.2、§6.5）。
- 镜像：Debian + uv + R + chromium + 科学栈 + curated 技能烟测，`@deepseek-ai/dsh@<精确版>`（integrity 校验）+ 插座 tarball（sha256）+ 预初始化只读 profile；`DEEPSEEK_API_KEY` 不注入。就绪探针走一次真正的线协议调用（`POST host.describe` 信封），不用「有东西在监听」当就绪（S156）。

---

## 5. 一次运行的生命周期

### 5.1 时序

```text
① 题面进入控制面 ──期望检查（正则路由 + LLM 分类器，只给期望契约种类，不阻断）
② reserveRun → 起/复用项目容器 → 生成 profile patch → session.create(evimed-universal)
③ 控制面写 .evimed-brief/{brief.md, context.md, index.json}（题面 + 知识切片 + 记忆 + 胶囊画像 + 工作方式包）
④ session.prompt → 首个 agent/pre-step：run-policy 判定根代理、一次性 inject 题面与上下文、runMirror 建行
⑤ 模型：简单问题直接回答；否则 evimed_plan 写 task-plan.json（clarifications 必非空；deliverables[{id, contractKind, capability, dependsOn}]）
⑥ evimed_delegate 起子代理：能力清单 → toolFilter + 预注入 SKILL.md + persona + outputSchema；依赖未 accepted 则排队；并行 ≤ maxParallelChildren
⑦ 子代理检索：mcp__evimed__* → tools/result 观察 → 证据表 queued/ready；全文落 .evimed-sources/<digest>.md
⑧ 子代理写 deliverables/<id>/ → evimed_submit_deliverable → runGate（@evimed/domain）→ {ok:false, issues}（分层：必修/建议/可选）或写回执 delivery-receipt.json
⑨ 根代理综合 → evimed_complete_run：计划履约 + 全部产物与最终回复过安全内容触发器 → 永远产出 delivery-summary.md → concludeTurn
⑩ turn/end → 控制面从宿主挂载卷读取工作区（回执、state.json、交付物）——容器生死与判定无关
⑪ 服务端外部门禁 reconcileSession：按 deliverables/<id>/ 逐件重跑同一份 domain 校验（过渡期也接受写在工作区根的交付物，S153），核 sha256 与 bundle/domain 版本，题面只认服务端那份
⑫ 折叠为账本 status（四值）+ 投影 phase（九态）→ SSE run/state 帧 → 浏览器；被退回的交付物进修复回环（只重派 rejected，deliveryAttemptLimit=3）
```

⑩ 是 2026-08-25/26 真机验收里修正的关键点：此前门禁只读容器里的转录，容器一没就记 `failed / artifacts 0`（S130–S132）；现在的桥是**持久的工作区文件**，转录降级为容器活着时的增强信号（进度心跳、停滞检测）。

### 5.2 状态：账本四值 + 投影九态（spec §7.1）

公开 `status ∈ {running, succeeded, failed, canceled}` + `verification ∈ {verified, unverified, unchecked}` + `errorCode` + `attempts`；九态 `RUN_PHASES`（reserved → dispatched → running → delivering → accepted | degraded | repairing → running | failed | canceled）由 `@evimed/domain` 的纯函数 `runPhase(record)` 派生、不存储。`degraded` = 成功但 `verification ∉ {verified}` 或 `partial` 交付（次数用尽时 `evimed_complete_run{partial:true}` 仍产出摘要，账本写 `succeeded + partial`，**不是** failed）。合法相序在折叠时断言，非法只计数与 notice，不抛——历史数据不能让读取崩溃。

### 5.3 运行侧镜像与证据池（spec §7.2–7.3）

`storageDomain` 域 `evimed-run@1` 四张表：`runMirror`（会话、版本、题面摘要、尝试、预算、最近 turn/end）、`planIndex`（`task-plan.json` 的索引，不是第二份计划）、`evidence`（来源、DOI、落盘路径、digest、状态）、`gateRuns`（每次门禁的 issues 与四指标）。每张表的 `status` 只有一个写入者：`transition(table, from, event)`。没有 `claims` 表——claim ↔ 来源的绑定就是 `clinical-evidence-matrix.json`。镜像每一步都写（S154 教训：只在回合结束写的镜像是「第一秒的镜像」，失败的运行恰好看不见）。

### 5.4 可靠执行（spec §7.5）

进程崩溃由 DSH 冷加载补记 `interrupted`；逻辑卡死由控制面按「进展」信号判（根会话消息/工具计数 + 子代理活动，否则委派后空闲会被误判停滞）；业务重试只重派 `rejected` 交付物；子代理结算非 `completed` 自动重派一次再标 `failed{code}` 并 `next-step` 唤醒父代理；依赖关系由 `evimed_delegate{dependsOn}` 排队，不让模型写 workflow 脚本串联交付物；预算终值写账本 `finished` 事件。

---

## 6. 编排与并发

### 6.1 三层调度（spec §21.4）

1. **编排器（模型）决定做什么**：看能力目录与题面，决定交付物、能力、并行度、是否追问。
2. **`evimed_delegate`（代码）决定怎么装**：按能力清单组装子代理的工具集（`manifest.tools ∪ {read, write, edit, glob, grep, bash?, skill, evimed_submit_deliverable, report}`）、预注入技能、persona、输出 schema、交付目录；`maxDepth = 1` 是常量不是配置。
3. **MCP 路由表（代码）决定去哪做**：私有适配器 → 失败或未配置时公共连接器经网关 → 本地编译；`data_source_catalog` 把「哪些源现在可用」暴露给模型，模型据此调整而不是猜。

四个走法（spec §9.6）：「你好」不写计划直接答，`turn/end` 过安全触发器、服务端过引文卫生；「分析这 5 个问题的证据现状」= 5 × `clinical-evidence-report` + 1 × `research-brief`（dependsOn 前五者），5 个委派并行；续问「基于这些做 GEO 提案」同一会话追加交付物——**没有模式可切**；「这个病人能不能用 X 药」无 `clinical-decision-brief` 能力时按人设不给诊疗建议。

### 6.2 并发的三个层级，只建前两个（spec §10）

| 层 | 机制 | 上限 |
|---|---|---|
| 一次运行内 | 进程内子代理（spawn / fork，continuable 后台）、`workflow`（模型写 JS 脚本，`parallel()/pipeline()` 在 worker 线程）、`job_*` | `maxDepth=1`；`maxParallelChildren=30`；DSH `maxParallelSubCalls=10` |
| 跨运行 | 控制面 `TaskManager` 全局/每项目并发、`MAX_RUNNING_RUNTIMES(_PER_USER)`、模型网关每项目并发 | 配置 |
| 团队协作（花名册 / DAG / 邮箱） | DSH experimental `agentTeams`——**不启用**；社区 `dsh-agent-teams` 只借三个交互细节（自动认领 + 撤销陈旧尝试、continuable 成员、成员邮箱） | — |

不引入 BullMQ / Redis / 进程外 worker：一项目一个 Node 进程承载 30 个进程内子代理，CPU 密集的 R/Python 本来就是沙箱子进程。「50 个 agent 筛 5000 篇」是确定性复合工具 `evimed_screen_batch`（切片 → 并行只读子代理 → 固定裁定 schema → `screening-ledger.csv`），不交给模型即兴编排。

### 6.3 限额单点（spec §10.4）

`deliveryAttemptLimit=3`、`maxParallelChildren=30`、`evidenceStaleMinutes=10`、`agentRunMonitorStallMs=15min`、`agentRunMonitorTimeoutMs=4h`、容器 `--memory 4g`、`--pids-limit 256`、空闲超时 30 min——全部只在控制面 `config.mjs` 定义，经 profile patch 派生给插座，不另设旋钮。

---

## 7. 质量守卫：三层、一份实现、六个阻断点

### 7.1 三层（spec §8）

| 层 | 在哪 | 性质 | 做什么 |
|---|---|---|---|
| 第 0 层 运行侧硬门 | 插座 `run-policy`，`evimed_submit_deliverable` | 机械、阻断、裁定是返回值 | 按 `task-plan.json` 派生的契约种类查 `@evimed/domain` 注册表跑校验器；输入只认 `deliverables/<id>/` + 题面只读副本；不通过返回分层 issues（必修 / 建议 / 可选）；通过写回执（sha256 + bundle/domain 版本，唯一写入者）。首次不通过是常态，不是异常 |
| 第 1 层 服务端外部门禁 | 控制面 `reconcileSession` | 机械、阻断、独立进程 | 多交付物逐件重跑**同一份** domain 校验；回执 sha256 与取回文件一致、版本与镜像声明一致；题面只认服务端那份；期望检查作为输入；无计划的直接回答过引文卫生 + 安全触发器；撤稿机械检查（Crossref `update-to` / PubMed `Retracted Publication`，P1） |
| 第 2 层 语义审查 | 插座 `review`，`evimed_review_run`（P2） | 模型判、代码核、**不阻断** | 全新上下文的子代理，只读工具 + 检索 + 固定附加的接地工具（推理者没用过的），固定裁定 schema；跨交付物冲突审查（`contradicts` 边）、抽样事实核查、草稿审查；结果经 `inject` 作为建议，写 `qualityNotices`，不改 `status`。结构将采用社区 review-workflow 的「N 评审员隔离盲评 + 主席合议」 |

### 7.2 契约的内容（`@evimed/domain`，源自 `clinicalEvidenceQuality.mjs`）【已落地】

- **主张三型**：`direct`（逐字引语绑定到一个来源）、`synthesized`（跨源结论：≥ 2 个保留来源且各有引语 + 置信标签）、`derived`（分析者自己的估计：必须写明引语锚定的输入、方法、假设、敏感性，报告中标为 derived，**永远不得携带实践性安全建议**）。
- **安全规则数据化**：药物与场景规则在 `clinical-safety-rules.json`，药师可改无需动代码；通用规则留在 `.mjs`；加载时拒绝无 pattern 的规则（strict 化时抓到的真缺陷）。
- **泄漏禁词**：报告正文禁止出现工具名、网关名、产物路径、第一人称检索日记，`mcp__evimed__` 前缀一并覆盖。
- **四个验证门指标**（Apodex）机械算出写进 `gateRuns.metrics`：引用覆盖率、`synthesized` 置信分布、争议占比（P2）、未决数（含 `stale` 证据）；另加时效性 notice。先作 notice，阈值进配置后再决定是否阻断。
- **契约注册表**（`contractRegistry.mjs`）目前登记 20 个契约种类：`clinical-evidence-report`（8 件必需文件）、`drug-evaluation-report`、`drug-selection-report`、`off-label-report`、`meta-analysis-report`、`mendelian-randomization-report`、`bibliometric-analysis-report`、`peer-review-report`、`adr-analysis-report`、`research-topic-report`、`dataset-scoping-package`（10 件）、`research-brief`、`appraisal-table`、`manuscript-section`、`geo-content-pack`、`clinical-decision-brief`、`agenda-delta`、`episode-plan`、`analysis-plan`、`reproducibility-pack`。新种类 = 在 domain 增加一个校验器（代码改动，D10）。
- 文件不解析时门禁必须说「文件没解析」而不是把 `undefined` 当空矩阵报 24 条「CLM-001 无法解析」（2026-08-26 修正：一个语法错误曾被报成两打内容问题）。

### 7.3 单实现不变式与六个阻断点

**一份实现**：服务端与插座同时 `import '@evimed/domain'`；clinical 的 `preflight.py` 已删除（其他两份同名脚本是能力自带工具，不是门禁镜像，保留）。运行侧修复提示词的语义就是「用 `evimed_submit_deliverable` 重新提交，按它返回的 issue 修，直到它接受」（S157）。

**六个阻断点**（spec §29.3）：契约校验（返回值）、服务端外部门禁、`evimed_complete_run` 的计划履约与内容触发器、预算守卫（步数 / token / 子代理 / 时钟 / 日周上限 / 余额）、路径守卫（题面、回执、状态投影、`data/` 越界）、产物离开平台前的用户签核。其余一切非阻断。

---

## 8. 资产与能力：九类资产、能力清单、新能力怎么搭

### 8.1 九类资产的封装（spec §21.1 精简）

| 资产 | 封装 | 接入 DSH | 调度由谁决定 | 护城河所在 |
|---|---|---|---|---|
| 11 个能力 | `capability.yaml + SKILL.md + domain 契约校验器` | `evimed_delegate` 起子代理（toolFilter、预注入、outputSchema） | 编排器选**哪个**，delegate 定**怎么装** | SKILL.md 与契约（ACE 式回路）；31 份 RQ 平价语料 |
| 通用技能（core 13 / curated 38 / office 4 / community） | SKILL.md + scripts；curated 经统一执行器 + `inventory.json`（sha256、烟测） | `skill-filesystem` 四根 + `skill` 工具按需加载；脚本在 Landlock 沙箱内经 bash 执行 | 模型按 `<available_skills>` 选 | 执行器与 inventory 审计 |
| MCP 26 工具（server `evimed`） | 纯标准库 Python stdio JSON-RPC | `dsh-mcp-client` 行 → `mcp__evimed__*`；`failOnStartupError: true` | 子代理 toolFilter；MCP 内部按路由表选源 | 连接器质量、来源目录 |
| 私有数据 API 13 个 | `EVIMED_*_URL` 适配器，各带熔断 | 经 MCP | 适配器优先，公共连接器回落 | 数据覆盖 |
| 公共连接器 53 个 base URL / 123 源目录 | `public_sources.py` / `science_connectors.py` | 经 MCP；托管面全部经 `publicSourceGateway` | `data_source_catalog` 暴露状态 | 目录的 `blocked_*` 逐个解除 |
| 六个专科 Python 引擎 | `deploy/specialist-adapter`（FastAPI + HMAC，一容器一专科，`start / status / capabilities`） | MCP 管理作业工具；P2 包装为 DSH `ctx.jobs` | 子代理 start 后轮询 | **各引擎本身**（统计、检索、评审规则）——与内核完全无关 |
| 内部网关族 | 控制面 `*.mjs`，HMAC 运行时令牌 | 运行时只知道网关地址 | — | 凭据与配额；certified 模型集合 |
| 插座原生工具 8 个 | `defineTool` 于 socket | agent 面 | 编排器 | 编排指引与契约 |
| Notebook 内核 + 评测 | `runtime/kernel` 桥；`evals/` | 沙箱内 Python/R | — | 评测语料 |

MCP 26 工具六个子类（spec §21.2）：检索（`literature_search`、`guideline_search`、`clinical_trial_search`、`patent_search`、`biomedical_source_search`）、全文与页面（`open_access_full_text`、`official_page_fetch`、`web_search`）、药学数据（`drug_label_search`、`pharmacy_reference_search`、`adr_case_query`、`adr_signal_analysis`、`drug_term_normalize`）、确定性编译（`offlabel_evidence_packet`、`comprehensive_drug_evaluation`、`drug_selection_evaluation`，各有 `requirements / retrieve / compile` 三动作，`compile` 本地无网络并给输入 SHA-256）、管理作业（`meta_analysis`、`mendelian_randomization`、`bibliometric_analysis`、`research_topic_selection`、`peer_review`、`drug_safety_analysis`）、本地（`data_source_catalog`、`evidence_deduplicate`、`term_normalize`、`health`）。根代理 ≈ 20 个工具（文件、bash、jobs、skill、subagent、四个框架工具、少数伞形检索）；≈ 25 个专用工具只在委派出的子代理里可见（渐进披露，spec §9.7）。

### 8.2 能力清单 `capability.yaml`（spec §9.3）

字段：`id / title / description / version`、`whenToUse`（一句「何时委派给我」）、`skills[]`（委派时预注入）、`tools[]`（子代理 `toolFilter.allow`，构建期对 `tools/list` 校验，不存在即失败）、`persona`、`produces[]`（`{contractKind, outputs[{path, required}], checks[], validator}`）、`inputs`、`safetyClass ∈ {general, clinical, regulated}`（`regulated` 的契约种类必须通过服务端外部门禁才交付）、`dataSources / starterPrompts / estimatedMinutes`。

目录：`clinical-evidence-synthesis`（P0）、`comprehensive-drug-evaluation / drug-selection / off-label-analysis`、`meta-analysis / mendelian-randomization / bibliometric-analysis / peer-review / adr-analysis / research-topic-selection`、`dataset-research-scoping`（以上 11 份已在 `capabilities/`）；规划：`research-brief`、`evidence-appraisal`（RoB 2 / NOS / QUADAS-2）、`manuscript-support`（GB/T 7714 / Vancouver、EQUATOR / ICMJE、SPIRIT / CONSORT / PRISMA 模板）、`geo-content`（P3）、`patient-education`、`clinical-decision-brief`（`regulated`，上线与否是产品决定）。`open-domain-answer` 并入编排器指引，不是能力。能力目录是外推性的边界：目录里有的模型就能组合，没有的它如实说没有。

### 8.3 搭一个新能力的流程（D10）

1. 写 `capabilities/<id>/capability.yaml` + `SKILL.md`（frontmatter `name / description / whenToUse`，正文只引用本组合挂载的工具名——进厂检验会拒收引用不存在工具的技能）；
2. 在 `@evimed/domain/contractRegistry.mjs` 登记契约种类与校验器（必需文件、机械检查、内容触发器适用范围）；
3. 需要确定性计算的部分做成引擎（专科适配器）或 MCP 编译工具——LLM 永不做统计；
4. 能力正文打包进镜像（`capability-skills/`），`deploy.test` 断言「每个能力的技能正文都随镜像发」；
5. 准备 ≥ 3 份真实题面进 `evals/`，跑内核平价与门禁 errorCode 分布；
6. 不改内核、不改插座核心层、不改前端——能力目录与 `/api/capabilities` 自动更新。

---

## 9. 记忆体系：底座、胶囊、六条算法

### 9.1 三级栈（spec §19.16、§19.21）

| 级 | 是什么 | 在哪 | 状态 |
|---|---|---|---|
| L0 工作记忆 | 一次运行内的上下文：题面注入、compaction、`session-query` FTS、`storageDomain`、技能 | DSH 原语 | 【已落地】 |
| L1 会话记忆 | 每次运行结束异步写入的观察与候选事实，自动、逐字、情景 | MemOS 会话 cube | 【设计，pin 2.0.30】 |
| L2 记忆胶囊 | 每用户一个：资料 / 知识 / 画像 / 方法 / 经历 五层 + 双时间轴 + 溯源；蒸馏、语义 + 程序 | MemOS 胶囊 cube + Postgres 产品账本 + 对象存储 | 【部分：domain `capsule.mjs`、socket `capsule` 插件、`.evimedcap` 容器已实现】 |

选 MemOS 自托管的理由：MemCube 是现成的分享原语、多用户作用域、异步调度、已是 DSH 生态成员；DSH 自身只有记忆**原语**没有跨项目层；生态记忆插件都是单机本地文件（spec §19.21）。Mem0 保留为 `memorySubstrate` 端口后的第二 provider。方法论以 **SKILL.md（Agent Skills 开放标准）**存储——离开 EviMed 也能用，「即插即用」不是比喻。

### 9.2 内容模型（spec §19.4）

资料层（sensory：上传的一切）→ 知识层（semantic：结构化摘要、MeSH 实体、索引）→ 画像层（semantic about user：身份、专长、偏好、立场、写作风格）→ 方法层（procedural：SKILL.md）→ 经历层（episodic：每次运行的摘要、结果、教训、纠正）+ 时间轴（`valid_from / valid_to` + `recorded_at`）+ 溯源（每条指向片段 / 运行步骤 / 反馈 id）。工作记忆不在胶囊里。

### 9.3 六条协同算法（互补学习系统框架，spec §19.22）

- **A1 写入（L1）**：运行结束异步写入观察（≈ 500 token）与候选事实；每条带 `importance ∈ [1,10]`（Flash 评分）、`run_id / project_id / recorded_at`、MeSH 规范化实体、`source_kind`；敏感预筛在前；ADD / UPDATE / MERGE 交给 MemOS `add`。
- **A2 检索与装配**：候选来自 MemOS 混合检索（BM25 + 向量 + 图），重排 `score = 3·relevance + 2·importance/10 + 1·γ^Δhours + 1·utility`，`γ = 0.995/h`；装配预算：画像区块 ≤ 1,500 token 常驻 + top-k 召回（初值 8，`tokenMeter` 实测定）+ 相关方法按需作为技能加载。
- **A3 巩固（睡眠期）**：重放近期条目、按实体聚类并生成条目间链接（A-MEM）；晋升规则 `promote ⇐ (跨 ≥ 2 次运行出现 ≥ 3 次) ∨ 用户显式记录 ∨ 用户正反馈 ≥ 1，且无未决矛盾`；矛盾则旧事实 `valid_to` 失效不删历史；≥ 3 条成功轨迹共享同一例程 → 归纳为方法草稿（AWM），已有方法 → ACE 式增量 delta；累计重要度超阈值（150）→ 反思条目。
- **A4 遗忘与再巩固**：L1 强度 `S(t) = S₀·e^(−Δt/τ)`（τ = 30 天），命中检索 `S ← S + r`；`S < θ` → `archived`（可召回不删除）；胶囊条目不衰减但有效用分，长期未用提议退休；删除沿溯源图传播。
- **A5 记忆操作即工具，策略不交给模型**：编排器只有 `evimed_capsule_recall` 与 `evimed_capsule_note`（`origin: explicit`）；自动召回在首个 `agent/pre-step`；存什么、何时晋升、何时遗忘由 A1–A4 的代码决定。
- **A6 评估**：LongMemEval / LoCoMo 风格的中文医学科研本地化集；EvoMemBench 式自演化评估（同一用户连续 N 次运行，方法遵循度是否上升）。

生态对照：Microsoft SkillOpt-Sleep（夜间收割会话→挖重复任务→held-out 门后固化技能）与本节 A3 同构；`stylotrace` 是 §11 编辑偏好推断的在野实现——两者都作对照实现，不装。

### 9.4 画像蒸馏配方（Nuwa，spec §27.3.1）

五层（表达 DNA / 心智模型 / 决策启发式 / 反模式 / 诚实边界）；三重验证（跨域 ≥ 2、生成力、区分度）取代「≥ 3 次出现」作为立场晋升规则；矛盾保留为「内在张力」；输出 `persona/SKILL.md`（全文）+ `profile.md`（≤ 1,500 token 摘要）两级披露；每份生成的 SKILL.md 按 Agent Skills 作者规范校验（< 500 行、description ≤ 1,024 字符、references 一层、≥ 3 个来自用户真实运行的测试场景）；计分卡不阻断。

### 9.5 分享与容器（spec §19.15、§28）【已落地：`.evimedcap` 16 个测试，零依赖】

- 分享默认 = **工作方式包**：方法 + 方法关联的知识/事实 + 工作标准与偏好 + 教训（可选背景知识主题与脱敏范例）；客体激活模式 `own / guest / blend`；分享的是版本快照不是实时连接；导入的胶囊是不可信内容，脚本剥离。
- 三种形态：工作态结构化明文（向量与全文索引不能在密文上工作；运营方在技术上可读，如实声明）；备份态每 blob 按胶囊 DEK AES-256-GCM、DEK 由 KEK 封装；便携态 `.evimedcap` v1（JCS 签名 manifest + Merkle 根 + 版本链、每条目 AES-256-GCM 带 AAD、包密钥 X25519+HKDF 按接收者封装、Ed25519 签名、可选 scrypt/Argon2id 口令副本、`memos/textual_memory.json` 作为条目；pickle / adapter 永不包含；口令包 `maxmem` 按 header 推算但封顶 1 GiB）。威胁模型如实写明密码学不解决转发与运营方可读。

---

## 10. 统一分析层：原始库在用户手里，理解在我们这里（spec §26）【设计；domain `analysis.mjs` 骨架】

**定案**：用户的网盘（自托管 OpenList 聚合 40+ 网盘）与本地文件夹是原始库，平台上传只是兜底；我们只存派生物（解析文本、结构化抽取、索引、胶囊条目）与原件指纹；数据文件例外（复制进数据保险库以挂载分析）。一个连接器契约（`list / fetch / capabilities / isProcessed / saveRaw?`，借 Mirobody 的 provider 契约）；内部产物（运行、交付物、回合、反馈、笔记）走同一条线。

六段流水线（控制面异步作业，Postgres 队列 + worker）：① 入库（清单与变更检测、指纹、精确 / MinHash 近重复 / 版本家族）→ ② 分流（类型 × 价值向量 → 深度）→ ③ 抽取（按类型的抽取契约：必填槽位、逐块迭代、map-reduce、书用 RAPTOR 树、录音/视频与幻灯对齐、SOP → SKILL.md、医案四诊 schema、cohort codebook）→ ④ 审计 → ⑤ 归并（术语归一、研究档案、方法与立场归纳、病例的确定性关联挖掘、晋升 / 失效 / 链接，接 §9.3 A3）→ ⑥ 物化（五层 + 时间轴 + MemOS cube + 索引 + 整理台）。

**分流算法**：22 类文档类型；五维价值向量 `profile / method / knowledge / evidence / data`（附 `authorship ∈ {self, coauthor, other, unknown}`、`relevance`、`novelty`、`quality`、`cost`、`risk`）；四级级联（元数据规则 → 结构探针 → Flash 分类 ≈ 2–4k token → 用户先验：文件夹角色 + 显式标签 + 覆盖规则，不训练模型）；深度 `skip / index_only / structured / deep`；优先级 `Σ 价值 × 层权重 − cost`；批量接入先全部 `index_only`（几小时内可检索）再按优先级蒸馏（几天内，整理台显示 ETA）；每个判定带 `reasons[]`，用户覆盖即反馈。

**两种完整性**：索引完整性 100% 由构造保证（`coverage_ledger` 记录每个单元的去向）；蒸馏完整性按深度审计——槽位核对 → 二次抽取、QA 式遗漏审计（`deep` 100%、`structured` 20% 采样）、产出量异常自动升档重跑、抽取器版本变化按价值选择性重蒸馏；目标遗漏率 `deep` ≤ 5%、`structured` ≤ 15%（MemReader / HaluMem 量级）；时效：入库 → 可检索 < 2 h / 1,000 文件。解析器 MinerU 3.4.5（CJK 版式、表格、公式），`pypdf` 作纯文本回退；社区已有 MinerU 的 DSH 插件可对照。

---

## 11. 蒸馏与用户模型：「更了解我」怎么来（spec §27）【设计】

- **先定义成可测的东西**：四个每周在留出事件上打分的预测任务——编辑预测（AI 草稿 → 我会改哪）、决策预测（简报卡 → 采纳 / 驳回 / 追问）、措辞预测、方法预测；结果就是胶囊总览的「理解度」，并驱动提问队列（只问不确定且影响大的地方）。
- **三种蒸馏分开**：A 从资料与行为蒸出结构化理解——做，主线；B 把大模型标注蒸成平台级小模型——暂不做（触发条件是分流 / 槽位抽取的成本成为主要开销）；C 每用户参数记忆——暂不做（DeepSeek 无托管微调；LaMP 上 RAG 式个性化远优于 PEFT）。所以「更了解我」= 每次派发注入的上下文更准、更省、更像我。
- **四个信号回路**：显式（上传、笔记、「记到胶囊」、冷启动访谈——模型先读完已蒸馏内容再就 8–12 个不确定且影响大的点提问）；编辑（PRELUDE / CIPHER：对每次编辑推断潜在偏好描述，连情境存入标准层，生成时检索 k=5 个最近情境聚合注入；度量同类任务编辑距离随时间下降）；决策与行为（采纳 / 驳回 / 追问 / 投票 / curate / 插话——插话是最高质量的纠正）；反思（睡眠期巩固，理解度失分项进提问队列）。提问纪律：每天最多一个小问题，随简报，不阻塞，被忽略两次即放弃，必须附「我们为什么想知道」。
- **运行时装配**：画像区块 ≤ 1,500 token 固定分节顺序（KV 缓存前缀稳定）；按情境召回的偏好聚合为「本次请遵守」；方法作为技能；本人范例 ≤ 2 条 few-shot；子代理只拿它需要的；冲突披露：用户本次明示 > 胶囊标准 > 平台默认，**立场与证据冲突时点明——立场永不改变证据规则**（过度个性化守卫）。

---

## 12. 主动式科研（Autopilot）：AI 在夜里做研究，人早上做决定（spec §24）【设计；契约种类 `agenda-delta / episode-plan / analysis-plan / reproducibility-pack` 已登记】

**产品定义**：用户把资料和数据倒进胶囊、设日额度；每晚按研究议程跑若干**预注册的研究回合**；早晨简报说「发现了什么、什么变了、需要你决定什么、花了多少」；用户在手机上做决定，决定改变下一晚的议程。三个面：今晨简报（消费）、科研直播（透明：运行树 + 旁白 + 发现墙，可插话可停）、收件箱（控制：审阅 > 提问 > 通知）。六种自主任务（全部映射到已有能力，不新增内核能力）：文献哨兵、证据更新（living review）、数据探矿、假说建议、写作流水线（默认关）、信号监测。没有自主等级：按任务类型开关 + 日上限，唯一人工步骤是产物离开平台前的签核。

**算法**：
1. **议程 = 世界模型**：控制面 `agenda_items(itemType ∈ question | hypothesis | claim | watchlist | dataset | analysis_plan | task | decision, payload, status, score, provenance, valid_from/valid_to, recorded_at)`，工作区投影 `agenda.md` ≤ 3,000 token 作为回合的工作记忆；双时间，冲突不覆盖。
2. **每日计划**：计划回合（Flash）产出 `episode-plan` 交付物，然后由**代码**评分与分配：`priority = 4·userSignal + 2·novelty + 2·evidenceGap + 1·freshness − 1·costClass`（`userSignal ∈ {追问 1.0, 采纳 0.6, 点赞 0.3, 驳回 −1.0}`）；防锁死用确定性规则（同一方向连续 3 回合无 `gated` 以上 claim → 优先级减半，再 3 回合 `parked`；驳回置底、追问置顶；v1 不上 Thompson 采样）；按日预算、单回合上限、线程并发（默认 2）、谷时优先贪心装入；「今晚计划」卡 22:00 前可删改。
3. **回合 = 一次普通运行**：同一组合、同一套工具与门禁；差别只有题面由议程生成、预算来自分配器、必产出 `agenda-delta`（新 claim 必带 `type / sources / tier: unverified`；新假说必带 `evidence_for/against`；每条带 `provenance`）、控制面确定性合并 delta（语义去重、矛盾成对进收件箱、`tier` 只由验证回合提升）。长任务切成回合：压缩有损、可独立计费门禁取消重试、控制面重启只需重排队。
4. **验证优先与分级**：契约门禁 → `gated`；独立反驳者（`evimed_review_run` 以反驳为目标，每晚每线程 ≤ 20 条）→ `stands` 才保留、`refuted` 降为 `unverified`；干净沙箱从 `reproducibility-pack` 重跑（相对容差 1e−6）→ `reproduced`。简报头条只放 `reproduced` 或「direct 型且 stands」；`synthesized / derived` 必带 `what_would_change` 与置信标签，用「解释」而非「发现」措辞——这是对 Kosmos 综合性陈述 57.9% 准确率的直接对策。
5. **预注册守卫**：数据集按行哈希确定性切探索 30% / 确认 70%；探索分区只产假说与分析计划草稿（多重比较默认 BH 标注）；分析计划由模型起草、代码校验后自动 `frozen`（sha256 + 时间戳）——冻结是记录不是审批；确认分区只在计划冻结后挂载，路径守卫拒绝越界；偏离必须作为新计划再冻结；报告确认结果与冻结计划并排、探索性发现明标。
6. **假说建议**：每个开放问题每晚 ≤ 5 个，先做新颖性核对（MeSH 检索 + 独立裁判比对最近邻文献并引用）；v1 只出建议卡不做锦标赛——Agents4Science 2025 的结论是 AI 论文「技术正确但既不有趣也不重要」，「有趣与重要」留给人；锦标赛（Elo）作后期可选。
7. **停止规则**：单回合上限（时钟 2 h）→ `partial`；日 / 周上限；方向收益递减；同一任务类型连续 2 回合失败 → 暂停进审阅；简报连续 7 天未打开 → 线程自动暂停；余额低于 1 天日上限 → 暂停自主；硬禁 `regulated` 能力、对外发送、购买、目录外数据源；总闸立即 `session.cancel`。
8. **学习回路**：每个决定都是信号 → 方向奖励、胶囊晋升 / `lesson` / 方法 delta、明日任务——全部是代码与数据，不训练模型。

调度器是控制面 Postgres `SKIP LOCKED` 队列 + leader 锁 + 独立运行时池 + 谷时窗口（北京工作日 09–12、14–18 为峰）+ 公共源令牌桶与缓存；DSH 的 `goal` 与 `ralph` 不用于调度。

---

## 13. 计量、额度与通知（横切，spec §25）【设计；B 轨】

- **计量在网关，不在运行时**：模型 token 由 `modelGateway.mjs` 在每个流式响应最后一个 `usage` 块记 `usage_events(run_id, session_id, step, model, cache_hit, cache_miss, output, peak, cost, at)`，峰谷按 UTC 窗口写入时判定；ASR 按分钟、向量按 token 同表；专科作业 `start` 成功计一次；公共源只计数不计费；存储每日快照。运行时上报的 `assistant/message.usage` 只用于预算守卫与 UI，不作计费依据。
- **额度**：`credit_ledger(user_id, delta, reason: topup|run|episode|refund|adjust, ref, balance_after, at)`；价目按资源 × 峰谷，**夜间 5 折直接传导给用户**；预估按能力 × 任务类型历史分布给 P50–P90（冷启动用 `estimatedMinutes` 折算，P90 覆盖率 ≥ 90% 进指标）；单次交互运行只提示不确认（超 P90 状态条变色），唯一硬停是余额为零（`credits_exhausted`）；告警：日花费 80%、单回合超 P90、可用天数 < 3。
- **通知**：`notifications(noticeType: notify|question|review, priority, actions, source, due_at, default_action, …)`；渠道站内必有、邮件、企业微信 webhook；静默时段默认 22:00–08:00；简报 08:00；同线程 5 分钟聚合；审阅到期执行 `default_action` 并写时间轴。
- **保留**：交互运行产物随项目；自主回合产物线程内 90 天后只留 `agenda-delta` 与回执；数据集用户删即删、派生 claim 标 `source_deleted`；通知 180 天；计量账本按财务要求保留并可导出。

---

## 14. 前端（spec §18、§23）【部分：绞杀者路线已落地】

- **保留并改造现有 React 应用**，不用 TUI，DSH Web 客户端只用于本地 profile（它没有受支持的页内嵌入途径，且是单用户产品 UI）。会话层按 DSH 事件词汇重写：控制面订阅 `/api/events.mux`，归一化后经**控制面自己的** `GET /api/runs/:id/events`（SSE）转发；`run/state` 帧携带 `status` 与 `phase`。
- **绞杀者路线**：`SessionRoute.tsx` 按 `/api/me` 的 `sessionView`（由内核名派生）选择 `RunStreamSessionPage`（新，消费控制面 SSE）或 `LiveSessionPage`（旧 store）；翻默认后同一 PR 删旧 store + `packages/sdk` + `src-tauri`。
- **新对象**：运行树（根代理 + 委派子代理）、交付回执卡（sha256 前 8 位、契约种类、bundle / domain 版本、门禁结论：通过 / 通过但有提示 / 被退回 n 次后部分交付；退回 issue 按必修 / 建议 / 可选分层；`verification` 三值用文案不用颜色单独承载）、证据台账、计划卡预估。
- **信息架构 10 项**：新任务 / 今晨简报 / 知识库 / 科研笔记本 / 记忆胶囊 / 能力模板 / 运行记录 / 收件箱 / 账户与额度 / 设置。**十二条全局规则**要点：单一状态词汇、四态纪律（空 / 加载 / 错误 / 成功）、撤销优于确认、「新」标记、流式停靠区、渐进披露、花钱前先看预估、旁白由工具名确定性生成、分块可续传上传（每文件状态机）、一切可撤销。全系统**没有阻断式对话框**（同意卡已按用户拍板移除）。
- 借的呈现模式（借模式不借代码）：DSH 客户端的运行树折叠、agent-teams 的交互式任务 DAG 面板、Mermaid 卡片渲染、Markdown 圈注→结构化修订请求（paperlab / md-annotator）。
> **【2026-09-04：本条的前提已被实测推翻，见 spec §16 #26】** 托管会话面**就是**运行时容器里的那张页面，在同主机的另一个端口上按项目代理出来（路径前缀行不通：它用 `location.origin` 拼绝对路径，`/plugins/…` 与 `/api/<方法>` 会落回控制面，页面启动即死而每个请求都是 200）。因此 UI 插件在托管面**有**落点，client-ui 包按显式清单进镜像；托管的设置类面板逐行 `disabled`，真正的界是 `@evimed/domain` 的 runtime-UI 方法名单。以下为原文：
>
> **前端插件化的边界**：DSH 生态的 UI 插件（bundle 声明 `dsh.client`，随包带浏览器端代码，装进 profile 刷新即生效）只作用于 **DSH 自己的 Web 页面**——本地面 `evimed-web` 直接享受整个 UI 插件生态；托管面用户看到的是我们的 React 应用，不加载 DSH 客户端 bundle，浏览器只消费控制面 SSE，运行时容器里的 `dsh web` 页面无人访问，所以「往 DSH 插前端插件改托管页面」在拓扑上没有落点，托管前端吃生态靠借模式。

---

## 15. 安全与隔离不变式（spec §11、§30）【已落地并在生产宿主实测】

| 不变式 | 落实 |
|---|---|
| 运行时不持真钥 | `llm-deepseek.baseURL` → 模型网关，`apiKeyEnv` → HMAC 短期工作负载令牌；`DEEPSEEK_API_KEY` 三处不注入（测试断言）；`web_fetch`/`web_search` 直连关闭 |
| 外联只经内部网关 | 容器网络只能到 `/internal/*`；MCP 只认 `EVIMED_*_URL`；公共源经 `publicSourceGateway`（主机白名单、私网 / 链路本地地址拒绝、服务端凭据） |
| 只访问当前工作区 | DSH `workspace-write` + 容器只挂项目卷；读越界靠文件系统边界、网络越界靠上一行；路径守卫保护题面、回执、状态投影、`data/` |
| 托管默认执行、无逐动作审批 | 权限预设 `evimed-hosted = workspace-write + never`（`never` = 自动**拒绝**一切 ask，正是所需）；本地面 `ask` |
| 进程隔离 | Docker `--cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 4g --cpus` + 容器内 **Landlock**。生产宿主内核已升至 7.0，DSH 报 `fully enforced`；实测容器内工作区外读写均 DENIED、工作区内允许 |
| 遥测不外传 | `DSH_TELEMETRY_DISABLED=1` 硬关（DSH 遥测无脱敏规则） |
| 特权操作只在本机 | DSH 把 `settings.* / credentials.* / host.*` 钉在 loopback；控制面方法白名单由 `seam-manifest.wire.unary` 派生再拒一次 |
| 热重载关闭 | `hmr.disabled: true`；profile patch 0o600 只由控制面写 |
| 可观测性 | 运行指标经 `.evimed-run/state.json` 与账本 `finished` 事件进 `/api/ops/metrics`；`exited` 事件将带退出码 / OOMKilled / 尾部输出（2026-08-26 待办） |

验收纪律（spec §30.3）：**同一镜像、同一命令，宽松容器退出 0、`--cap-drop ALL` 退出 1**——只有掉权限才现形的缺陷在开发机上永远测不出，所以一切验收在生产同款参数下执行。验收 / 生产结构差异清单：tmpfs `noexec`、掉能力、只读根、pid 上限、控制面在宿主而生产在运行时网络（ufw 需一条最窄放行）。

---

## 16. 版本同步与生态接入

### 16.1 跟版依赖只有一套机制（spec §12；`deps-version.json`）【已落地】

- 单点 pin：`dsh 0.1.1-rc.2 / cordis 4.0.1 / pnpm 11.7.0`、`memos 2.0.30`、`openlist 4.2.5`、`mineru 3.4.5`；Dockerfile ARG、`seam-manifest.dsh`、peer、`release-manifest` 由测试断言相等；子包 `latest` dist-tag 不可信，永远写精确版本。
- 契约测试（每次 CI，`packages/contracts/<dep>/`）：对已安装版本断言缝可 import、服务键存在、`defineTool` 接受我们的 option 形状、`host.describe` 方法集 ⊇ 白名单；金帧夹具断言 port 转换函数输出形状不变。
- 一致性套件（keyless）：脚本化 `LlmAdapter` 回放工具调用；真实 Loader 下挂载 `evimed-universal` 并委派；缺文件的包 → `{ok:false, issues}` 点名文件，补齐 → 回执；`--dump-config` 快照行 id 集合不变；恶意工作方式包不改任何门禁判定。
- 夜间矩阵：拉最新 rc 构建镜像（临时放宽 peer），跑契约 + 一致性 + 5 份 RQ 平价，diff 上游事件/工具/持久化目录，结果写 `compat-matrix.json`；安全修复当日走同一套。**不承诺零改动，承诺改动可定位、可回滚、一个 PR。**
- 发布清单 `release-manifest.json` 已为 DSH 形态（web / runtime / proxy 三个镜像 id 真实、`dshVersion`、技能与输入 digest）；CI `web.yml` 六道关卡漂移即红。

### 16.2 生态接入三档与动作（spec §16 #22、§21.8）【已落地工具链】

- 三档：**直接用**（技能进 `skills/community/`；bundle / MCP 加 patch 行）> **小改**（换 provider 不换 consumer——DSH 的 Service Definition / Provider / Consumer 分层）> **仅护城河自建**。第四类**借模式**只学设计不装。
- 机械进厂检验（对 rc.2 源码核实）：技能目录一层深（`<name>/SKILL.md` 或平铺）、frontmatter 必填 kebab-case `name` + `description`、与四根不重名、**正文引用的工具名必须是本组合挂载的**（引用不存在工具的技能不报错，只让模型照做然后降级——所以拒收）；bundle 看 `dsh.bundle`；pin 精确版本 / commit；`--dump-config` 快照 + 启动冒烟；描述对代码抽查。
- 已有工具链：`skills/community/` 根（`customSkillDirs` 末位，首根赢重名——社区技能永远盖不掉自研）+ `sources.json` + `scripts/dev/vendor-community-skills.mjs`（按 commit 拉、跑进厂检验、写 `PROVENANCE.md`）+ `check:community-skills` 进 CI + `try:community-bundles` 试装档（不改镜像、不做门禁，只回答「装得上吗、什么形态」）。
- 插件按 npm 依赖对待；插座插件永不 `inject` 第三方服务（硬依赖、缺失静默不 apply、宿主作用域跨会话共享）；社区能力只以工具 / 技能形态被模型消费；运行内协同走 port 缝，跨运行 / 跨用户走控制面，不用 Cordis 事件当平台总线。
- preset 四条融合路径：抄 persona、抄行配置、拎随包技能、整只映射成 `capability.yaml`（委派形态一次运行可组合多只，比原生 preset 好用）。
- 一期实况（spec §21.9）：清单里「技能形态五件」有四件其实是工具形态；实收 `dsh-ppt`、`deep-structural-analysis` 两件，四件转试装档；三个包卡在 `@deepseek-ai/dsh-fs` 的 peer 范围（#4236 类，每轮重试）；托管合入排在 A 绿 + 内核平价之后（对照组必须干净）。本地面「科研者桌面」推荐组（Origin / Stata / Zotero / Overleaf / dsh-market）连接用户自己的桌面软件，是托管面够不着的那一半，不是它的降级版。V41（第三方 bundle 在我们 preset 作用域下干净组合）仍待第一个真 bundle 关掉。

---

## 17. 工程方法论

1. **只写核实事实**：文档里的 API、事件、字段对源码核；DSH 的 400 个 `.d.ts` 拉到本地作真值，四路并行比对「我们读什么 vs DSH 声明什么」，再过一轮对抗性证伪（S155）。
2. **断言结果，不断言机制**：验证「想要的效果发生了」而不是「命令成功」；对上游配置的断言落在 `--dump-config` 读到的值上而不是我们写出去的文本上；tar 退 0 是机制、字节到没到是结果（S121）。
3. **「空」与「确实没有」外观相同**——这是本项目最常见的缺陷家族（读错字段名、`json()` 对不解析的文件返回 `undefined`、容器死了转录读到空、镜像只写第一秒）。对策：读法失败要落**具名错误码**（`runtime_history_unavailable`、`runtime_turn_end_unknown`…）并计数；未知枚举值显式落码不吞；空目录、空目录录、空能力目录一律 fail-loud。
4. **配测试并验齿**：每个修复附一条把修复撤回就必须变红的测试（阴性对照）；一次「走查」测试必须证明它走过（否则一个坏掉的遍历永远绿）。
5. **生产同款参数验收**：`--cap-drop ALL` 等；验收 / 生产结构差异记进仓库。
6. **单写入者、一名一义、单点定义**：每张状态表一个写入者 `transition()`；`kind` 只给 DSH；限额只在 `config.mjs`；版本只在 `deps-version.json`；插件文件头写「本模块隐藏了什么」；工具 `description` 是模型可见的接口注释（写能力边界、何时不用、输出契约）。
7. **常量 vs 配置**：算法参数（重排权重、衰减 τ、晋升阈值、优先级权重、容差）是 `@evimed/domain` 里带测试的常量；只有预算、节奏、上限、采样率是配置。
8. **规范母本**：spec §14 按 Ousterhout 分章写成 40 条可检查规则（深模块与信息隐藏、依赖只向内、接口与错误、命名与注释、DSH 插件专项：函数插件只具名导出 `name / inject / Config / apply`、每条 patch 行显式 `id`、生成文件只写字面值、`strict: true`、JSDoc 禁 `any`）。
9. **过程纪律**：长任务在当前回合内跑完并可断点续跑——工作区根 `STATUS` 一步一行、开步前先读、幂等；`OpenScience/PROGRESS.md` 每个真实里程碑一行（新的在上）；提交标题是「一句话结论」，正文写 why 与测试；代码、文件、注释、提交英文，讨论中文。
10. **少过度设计**：v3.5 删 9 项（事前确认、自主等级、计划冻结的人审、「继续吗」成本确认、每用户分类器训练、每周人工抽样、四套跟版流程副本…）；任何新增门禁先问「它是六个阻断点之一吗」。

---

## 18. 算法与能力的搭建流程

### 18.1 三种构件，三种搭法

| 构件 | 例子 | 搭法 |
|---|---|---|
| **能力**（LLM 参与、按契约交付） | 证据综述、数据集画像、稿件支持 | §8.3 的 D10 流程：清单 + SKILL.md + 契约校验器 + 打包 + 评测 |
| **确定性引擎**（数学与裁决） | Meta 引擎、ROR/PRR/EBGM 信号、三个编译工具、门禁校验器 | 独立进程或纯函数；numpy / scipy / pandas；**LLM 永不做统计**；输入哈希、无网络 `compile`；经 HMAC 适配器或 MCP 暴露；有自己的单测与 pytest |
| **学习型算法**（记忆、分析、自动驾驶、画像） | A1–A6、分流级联、每日计划、理解度 | 下面的七步 |

### 18.2 学习型算法的七步（本项目所有算法章节都是这么写出来的）

1. **把目标定义成可测量的东西**：先写指标再写机制——遗漏率 ≤ 5%、理解度四个预测任务、P90 覆盖率 ≥ 90%、方法遵循度随 N 上升。
2. **参照系：取什么、不取什么**：每条来源（论文、开源实现、产品）写明取哪一点、不取哪一点、为什么（spec §19.2、§24.2、§26.2 的三张表）；联网复核（v3.5 §29.1）。
3. **机制分层**：模型做判断与生成（评分、抽取、起草）；代码做决定（评分公式、晋升规则、分配、合并、冻结）；人只在离开平台前签核。对应 A5「记忆操作即工具，策略不交给模型」、24.4.2「由代码做分配」。
4. **常量进 domain 带测试**：权重 (3,2,1,1)、γ=0.995/h、τ=30 天、阈值 150、(4,2,2,1,1)、30/70、1e−6 都是有测试的常量；旋钮只留预算与节奏。
5. **先 notice 后阻断**：新的判定先以 notice / 标记 / 计分卡形式运行，积累实测分布后再决定是否进六个阻断点（四指标、期望检查、语义审查都是这样）。
6. **评测集本地化与非回归**：LongMemEval / LoCoMo / EvoMemBench / HaluMem 风格集做中文医学科研版；31 份 RQ 平价与 50 篇 title-to-paper 作能力非回归；升级 PR 必跑。
7. **生态对照与回路演化**：找到在野的同类实现作对照（SkillOpt-Sleep、stylotrace、review-workflow、frontier-repro），借表示与交互不借架构；能力 SKILL.md 走 ACE 式增量 delta 回路（由门禁判决与修复驱动，代码核验 + 维护者审阅 + 31-RQ 非回归），用户方法走胶囊反思回路——**都不训练模型**。

### 18.3 一个例子：证据综述从题面到交付

题面 → 期望检查给出 `clinical-evidence-report` → 计划一份交付物 → 委派 `clinical-evidence-synthesis`（预注入 SKILL.md、工具集 = 检索 + 全文 + 药学 + 本地）→ 15 次检索、去重、纳入（证据表 queued → ready）→ 写 8 件必需文件（学术报告、证据矩阵、引文台账、`references.bib`、引文审计、检索留痕、问题覆盖、运行元数据）→ 提交 → 门禁核主张三型、引语绑定、引文可解析、泄漏禁词、安全触发器、四指标 → 退回则按 issue 修 → 回执 → 完成 → 服务端逐件复核 → `accepted` 或 `degraded`。RQ-15（速效救心丸 ADR 溯源）在 2026-08-25 第一次真实走完这条线：17 分钟、243 命中、141 去重、23 源、26 KB 中文报告并如实报告阴性发现。

---

## 19. 当前状态与路线（截至 2026-08-26）

**已落地**：内核替换的全部骨架（domain / harness-port / socket / contracts、`DshRuntimeAdapter`、profile patch 生成、`runtime-dsh` 镜像与启动冒烟、`/api/opencode/*` 退役、控制面 SSE、绞杀者前端路由、`.evimedcap`、`deps-version.json` + 夜间矩阵、发布清单 DSH 形态、CI 六道关卡）；P0 真机验收在生产宿主完成基础设施层与模型链路（首份真实交付物 RQ-15）；运行 → 账本的持久桥根因找到并修复；盲审 30 条已核实缺口清零（29 FIXED + 1 DUPLICATE，每条带 verdict / verifiedBy / fixLocation / testLocation）；生态一期工具链（community 根、vendor / check / try）。

**未闭合**（按优先级）：
1. 第八跑容器在 19 分钟无解释消失——`exited` 事件不带退出码 / 输出（`runtimeManager.mjs` exit 回调丢弃 `(code, signal)`，`--rm` 让事后 inspect 读到 not-found，`runtime.kind` 是字面量 `"opencode"`）；先在宿主取证（`docker events --filter event=die`、`dmesg`），再补仪表与阴性对照。
2. 一次新鲜单跑走到 `accepted`（或可读的内容失败）→ 之后才开 33 篇批测（谷时）。
3. `audit:capabilities` 证据自 08-14 过期（外部探测，需授权刷新）。
4. 托管默认内核仍为 `opencode`（`OPEN_SCIENCE_RUNTIME_KERNEL` 开关）；翻默认 → 同一 PR 删 `LiveSessionPage` 旧 store、`packages/sdk`、`src-tauri`、`runtime/harness`、`deploy/runtime-opencode`（附 B）。
5. V41；三个社区包的 peer 范围；生态一期合入镜像排在平价之后。

**阶段与轨道**：P0 换内核（收尾中）→ P1（其余 10 个能力清单、门禁多交付物、预算、screening、撤稿检查、视觉通道 G1）→ P2（review 插件、evidence 摄入、作业包装、manuscript-support、OpenCode 清零）→ P3（GEO 工具与网关）。并行轨：F（前端）、C（胶囊 C1 起）、U（上传与分析层 U0–U4）、B（计量与通知 B0 起）、A（自动驾驶 A0–A4，依赖 P1 + C1 + B0）。

---

## 20. 附录

### 20.1 术语

| 术语 | 含义 |
|---|---|
| 插排 / 插座 | DSH 内核 / 我们的 bundle `@evimed/dsh-socket` |
| 缝（seam） | DSH 文档化的扩展点（事件、服务、工具注册、子代理）；插座只碰这些 |
| 防腐层 | `@evimed/harness-port`：全仓唯一 import `@deepseek-ai/*` 的包，拥有自己的类型 |
| bundle / profile / patch / preset | DSH 的组装四件：可安装的 npm 包 / 可启动的组合 / 行覆盖层 / 模型可见面 |
| 能力（capability） | `capability.yaml + SKILL.md + 契约校验器`；模型可在一次运行里任意组合 |
| 契约种类（contractKind） | 交付物提交时声明并据此校验的种类；20 种 |
| 交付物 / 回执 / 投影 | `deliverables/<id>/` / `delivery-receipt.json` / `.evimed-run/state.json` |
| 阻断点 | 全系统六个可以让运行停下的地方 |
| 胶囊 / 工作方式包 | 每用户的五层记忆 / 分享的默认范围 |
| 回合 / 议程 / tier | 自动驾驶的一次普通运行 / 控制面的世界模型 / claim 的验证等级 `unverified < gated < reproduced` |
| 价值向量 / 深度 | 分析层对每个来源的五维评分 / `skip < index_only < structured < deep` |
| 试装档 | 只回答「装得上吗、什么形态」的隔离试装流水线 |

### 20.2 关键文件索引

`OpenScience/apps/server/src/{agentRuns,runtimeManager,runtimeControllerServer,dshRuntimeAdapter,dshProfilePatch,modelGateway,publicSourceGateway,config}.mjs` · `OpenScience/packages/domain/src/{contractRegistry,clinicalEvidence,clinical-safety-rules.json,states,plan,receipt,runTranscript,toolNames,workspaceLayout,errorCodes,capsule,agenda,analysis,metering}.mjs` · `OpenScience/packages/harness-port/{index.mjs,seam-manifest.json}` · `OpenScience/packages/socket/{plugins/*.mjs,presets/evimed-universal/agent.cordis.yml,cordis.patch.yml}` · `OpenScience/capabilities/<id>/{capability.yaml,SKILL.md}` · `OpenScience/runtime/mcp/evimed-research/server.py` · `OpenScience/deploy/runtime-dsh/{Dockerfile,build-smoke.sh}` · `OpenScience/deploy/web/release-manifest.json` · `OpenScience/deps-version.json` · `OpenScience/scripts/dev/{vendor-community-skills,try-community-bundles}.mjs` · 工作区根 `STATUS`、`OpenScience/PROGRESS.md`。

### 20.3 决策索引

用户拍板与执行裁决全部在 spec §16（#1–#22）与 §20.1（锁定决策 1–25）；待核事实 V1–V41 在 §15；缺口复审在 §17、§22；收口审查在 §29；真机验收在 §30。本文与它们冲突时以 spec 为准并回来修本文。
