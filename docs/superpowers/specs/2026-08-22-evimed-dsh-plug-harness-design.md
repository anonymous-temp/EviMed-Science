# EviMed × DeepSeek Harness「插排-插头」架构方案

- 文档状态：**v3.9 定版（2026-08-24）**——锁定清单见 §20；v3.9 增生态接入决策（§16 #22、§21.8、V41）：生态优先三档（直接用 > 小改 > 仅护城河自建）、社区技能根 `skills/community`、preset 四条融合路径、插件按 npm 依赖对待不设审批流，首扫清单在 `plans/2026-08-24-dsh-ecosystem-adoption-shortlist.md`；v3.8 记入 P0 首次真机验收的结果（§30）：V13 已在生产宿主实测并解决（内核升 7.0，Landlock `fully enforced`），另七个只有真容器才暴露的缺陷已修并各配可验齿的检查；v3.7 裁决运行状态词汇：公开 `status` 四值不变，九态改为投影 `phase`（§7.1.1、§16 #20）；v3.6 为执行后的裁决修订：cordis 实为 4.0.1、preflight 删除只限 clinical（§16 #2 补注）、执行裁决记录见 §16 #15–#19；v3.5 为收口版：联网复核全部算法（§29.1）、删 9 项过度设计（§29.2）、阻断点收敛到 6 个（§29.3）、规范符合性核对与 14 处改名（§29.4）、补 Nuwa 蒸馏配方（§27.3.1）、不训练任何模型；v3.4 新增蒸馏模型与用户模型（§27）、胶囊容器格式与密钥（§28）；v3.3 新增记忆胶囊的统一分析层（§26：原始库在用户网盘 / 本地、经 OpenList 与本地代理接入，分流 → 抽取 → 审计 → 归并），并按用户 2026-08-23 拍板移除同意卡与合规 / 版权内容；v3.2 新增第四轮全对话缺口复审（§22）、前端设计与交互细则（§23）、主动式科研 Autopilot（§24）、计量 / 额度 / 通知（§25）；v3.1 补记忆底座定案与协同算法（§19.21–19.22）、资产封装与接入总表（§21）；v2 纳入用户 2026-08-22 的拍板（§16）：全面换内核、**取消 Mode Router 与产品线 preset，改为统一组合 + 能力清单 + 按产出绑定契约**（§9）；第二轮联网 + 源码复审的缺口与修订见 §17；前端适配（§18）与记忆胶囊（§19）为 2026-08-22 晚新增；§19.16–19.20 为第三轮复审（记忆层选型、平台自演化、参考产品、交互设计、残余风险）
- 日期：2026-08-22
- 上位方案：[EviMed SaaS 科研 Agent 统一底座最终方案](./2026-07-16-evimed-openscience-platform-design.md)（v4 Final）、[EviMed × Grok Build Harness 融合建设方案](./2026-07-17-evimed-grok-build-fusion-design.md)（v2 Implemented Baseline）
- 核查对象：
  - DeepSeek Harness 源码 `github.com/deepseek-ai/deepseek-harness`，本地 clone，`HEAD = b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（2026-08-21，`release/dsh-0.1.1-rc.2` 合入），下文凡标 `dsh:` 的路径均指该仓库；
  - 用户提供的「DSH 重构方案」资料（Google Drive 文件夹 `1Ebqmvl8p5GA-gVVwy39jEFzTTa6g1hT_`）：《医学科研 AI Agent 架构设计——最终定版》、《医学科研 Agent 项目代码规范与工程原则》、《Apodex 设计思想对医学科研 Agent 架构的借鉴分析》，以及 Apodex-1.0 技术报告原文（PDF）；
  - 本仓库现状：`OpenScience/apps/server/src/*.mjs`、`OpenScience/runtime/**`、`OpenScience/deploy/**`、`OpenScience/docs/REQUEST_PATH.md`。
- 适用范围：EviMed 托管 SaaS（`OpenScience/`）的 Agent 执行内核替换，以及让同一个医学 Agent 在**没有模式边界**的前提下承接科研、即时问答、GEO、临床决策辅助等任意组合的任务。
- 写作原则：只写能在源码或数据里核实的事实；推断处标「推断」；未核实处标「待核」。与上位方案冲突之处在 §1.3 逐条列出，不默默改写。

---

## 0. 执行结论

### 0.1 一句话

> **DSH 取代 OpenCode，成为每个项目隔离 runtime 容器里唯一的 Agent 执行内核；EviMed 的控制面、网关、账本、门禁原样保留；我们的全部科研能力以一个 DSH Bundle（插头）的形式挂到 DSH（插排）上，插头只通过 DSH 文档化的「缝」（seam）接触插排，并且所有接触点收口在一个防腐层包里。**

术语：这一层定名「插座」（`@evimed/dsh-socket`）；早期章节里的「插头」与「dsh-bundle」指同一个东西。

这不是「在 OpenCode 旁边再加一个 Harness」，而是**换内核**：2026-07-17 方案锁定的「不形成双 Harness」铁律继续成立——系统里仍然只有一个 Agent Loop，它现在是 DSH 的 `dsh-agent-loop`。

### 0.2 拟锁定的架构决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | **DSH 是唯一执行内核**，部署位置 = 现在 OpenCode 所在的每项目 runtime 容器；`apps/server` 控制面、`/internal/*` 内部网关族（模型、公共源、搜索；后续加 asr / embeddings / capsule / geo-probe）、`agentRuns` 账本、交付门禁不动 | DSH 的 Web 宿主只服务本机且无租户模型（§2.4）；我们的多租户边界已在控制面实现 |
| D2 | **插座 = 一个 Bundle**（`@evimed/dsh-socket`），由若干 Cordis 插件 + agent preset + skills + MCP 配置行组成；它是 Apodex 意义上的「工作流策略层」，**不是第二个 loop** | Apodex §5.1：policy 在窄门面之上，机制在其下；DSH 的 preset/事件/工具缝恰好是这个门面（§2.3） |
| D3 | **只依赖 DSH 文档化的缝，且全部经由防腐层包 `@evimed/harness-port` 进入**；其他包禁止 `import '@deepseek-ai/*'`（含 JSDoc 里的 `import()` 类型；ESLint + CI grep 强制）；port 拥有自己的类型词汇并做形状转换，不是改名表 | DSH 明确声明预发布期**无兼容承诺**（§2.2），接触面必须可一处替换——改名与改形状都算 |
| D4 | **「每版同步」是机制不是承诺**：精确 pin + 夜间兼容矩阵（跟最新 rc）+ 启动期缝自检（fail-closed）+ 契约测试；升级 = 一个 PR | 11 天 10 个 npm 版本（§2.1）；事件被改名时监听器会**静默失效**，必须自检 |
| D5 | **没有 Mode Router，也没有按产品线划分的 preset。** 每个会话挂同一个统一组合 `evimed-universal`；查询进来后由模型**计划 → 委派 → 按契约交付**（§9）。能力（证据综述、Meta、GEO、临床决策辅助…）是**能力清单**（由 `agent.yaml` 演化），模型可在一次运行里任意组合；契约按**产出**绑定（声明的 kind ∪ 内容触发器），不按输入分类 | 跨模式需求（「若干问题的证据现状」既是多篇综述也是 GEO 前的提案）无法靠输入分类穷尽；DSH preset 不能中途切换，所以组合必须一开始就完整；产出可检查、输入只能猜 |
| D6 | **任务状态机的权威状态在控制面账本；运行侧镜像放 DSH 的 `ctx.storageDomain`（插件自有状态的唯一受认可去处）；模型可见的状态变更经 `agent.inject()` 写成一等的 `user/message`**。**不**向 DSH 会话日志追加自定义事件类型。30 并发用进程内子代理 + `workflow`，不引入 BullMQ/Redis | DSH 0.1.1-rc.2 的持久化读路径**拒绝**仓库外的事件类型，且 `Session.append` 不暴露 `ignorable`（`dsh:packages/core/session/src/known-event-types.ts:9-18`，「registration surface … deferred until such a consumer exists」）；我们的账本已有 started/dispatch/progress/finished 折叠模型 |
| D7 | **运行侧硬门在 `evimed_submit_deliverable`，裁定是返回值不是 `deny`；`evimed_complete_run` 核对计划履约与安全触发器后结束回合**；服务端门禁保持**外部独立**；LLM 判分一律「模型判、代码核、不阻断」。**门禁规则只保留一份实现**：`clinicalEvidenceQuality.mjs` 抽成纯 ESM 领域包 `@evimed/domain`，服务端与插座同时 import；`preflight.py` 删除 | Apodex §3.1「验证必须外部于被验者」= 我们 8 月结论「被检查方不能提供考题」；`coverageJudge` 实测 3/114 真阳性（§4.2）；preflight 与门禁已漂移三次；首次提交不通过是常态不是异常（Ousterhout ch.10） |
| D8 | **证据池 = 插头内 `storageDomain` 的证据表 + 现有工作区台账**（matrix / ledger / question-coverage），证据图是其**投影**，不新建数据库；写入由 `tools/result` 观察钩子驱动 | 已有 8 个必需交付件构成完整证据链（§3.2）；`tools/result` 是只读、失败被隔离的观察缝 |
| D9 | **安全不变式不降级**：runtime 不持真钥（`llm-deepseek.baseURL` → 模型网关，`apiKeyEnv` → 工作负载令牌）、`web_fetch` 保持关闭、外联一律过网关、DSH 沙箱在 Docker 内二次限制；托管默认执行、本地桌面 `ask` | 07-16 上位方案 §11 + 07-17 融合方案 §18.1；DSH `llm-deepseek` 配置支持 `baseURL`/`apiKeyEnv`（§2.5） |
| D10 | **新能力 = 一份能力清单 + skills + tools + 在 `@evimed/domain` 注册一个契约校验器**；编排器的能力目录自动更新，不改内核、不改插座核心层、不改前端 | 能力目录是外推性的边界：目录里有的模型就能组合，目录里没有的它会如实说没有（§9.6） |
| D11 | **本地/桌面形态改为 `dsh --profile evimed-web`**（dsh-base + dsh-web-app + 我们的 bundle），Tauri 壳退役 | 同一个插头插两种插排；消灭第二套前端-运行时耦合（§3.3） |
| D12 | **前端保留并改造现有 React 应用**：按 DSH 事件词汇重写会话层与运行树，其余不动；不用 TUI 作为产品界面；DSH Web 客户端只用于本地 profile | DSH 客户端没有受支持的页内嵌入途径且是单用户产品 UI；我们的核心面（项目、证据台账、交付回执、胶囊）它没有（§18） |
| D13 | **记忆 = MemOS 底座 + 两层 + 胶囊**：MemTensor/MemOS 自托管作为记忆底座（usememos 退役）；第一层会话 cube 自动记、第二层胶囊 cube 蒸馏沉淀；每用户一个胶囊，融合知识库 + 记忆 + 方法论 + 经历，双时间轴、可追溯；方法论以 SKILL.md（Agent Skills 开放标准）存储；分享默认为「工作方式包」（§19.15）；胶囊是上下文不是权限 | 用户提出的核心产品方向；MemCube 正是共享原语（§19.16）；与编排器、门禁、安全不变式相容的落法见 §19 |
| D14 | **主动式科研 = 系统发起的运行，不是新内核能力**：研究议程（世界模型）在控制面，调度器按日预算在谷时排「预注册的研究回合」，每回合就是一次普通运行（同一组合、同一门禁），必产出 `agenda-delta`；验证优先（独立反驳者 + 重跑复现）与陈述分级决定什么能进简报；三个面 = 简报（消费）/ 直播（透明）/ 收件箱（控制） | Kosmos 综合性陈述 57.9% 准确、Sakana 42% 实验失败（§24.1）；DSH `goal` 自述「state, not scheduling」（§24.2）；契约绑产出的原则原样适用 |
| D15 | **计量在网关、额度先于功能**：`usage_events` 由模型 / ASR / 向量网关写入（运行时上报只用于预算守卫）；额度按资源 × 峰谷定价，夜间 5 折传导给用户；事前预估、实时计量、日 / 周上限、无人看自动暂停 | 现状 `billingIntegrated: false`、网关不记 usage（§22 G10）；Manus 的反例（§24.1）；DeepSeek 峰谷计费（§24.1） |
| D16 | **数据资产三件套**：数据保险库（原始行只在保险库与只读挂载卷）、数据画像与分级（`public / patient-level`，只作分享范围与挂载策略的默认值，不设审批、不设同意卡）、探索 / 确认分区 + 分析计划冻结；原始行不进模型上下文 | 预注册文献对 LLM 自主分析的建议（§24.4.5）；合规与版权由用户方的管理资质覆盖，不在本方案范围（2026-08-23 用户拍板） |
| D17 | **原始库在用户手里，理解在我们这里**：网盘（自托管 OpenList 聚合 40+ 网盘）、本地文件夹（本地分析代理）、平台上传三种连接器共一个契约；分析层只存派生物与指纹；分流输出价值向量决定深度（`skip / index_only / structured / deep`），索引完整性 100% 由构造保证，蒸馏完整性按深度用覆盖台账 + 槽位 + QA 遗漏审计度量（`deep` 遗漏 ≤ 5%）；内部产物走同一条线 | 用户提出的原始库形态；Mirobody 的 Collect → Standardize → Answer 与 provider 契约；MemReader 主动抽取；「长文档摄入主要失败是遗漏」的文献（§26.2） |
| D18 | **理解存在上下文里，不在参数里**：「更了解我」定义为四个可测的预测任务（编辑 / 决策 / 措辞 / 方法）；三种蒸馏分开——从资料与行为蒸出结构化理解（主线）、把大模型标注蒸成平台级小模型（后期选项，当前不训练任何模型）、每用户参数记忆（暂不做）；四个信号回路（显式与冷启动访谈、编辑偏好推断、决策与插话、睡眠期反思）；过度个性化守卫：立场永不改变证据规则 | LaMP 七数据集：RAG 式个性化 +14.92% vs PEFT +1.07%（ICTIR 2025）；PRELUDE / CIPHER 从编辑学偏好（NeurIPS 2024）；MemReader 四动作；DeepSeek 无托管微调（V37） |
| D19 | **胶囊三种形态**：工作态结构化明文（边界内，可检索）；持久与备份态按胶囊 DEK 加密；便携态 `.evimedcap` 容器——明文格式开放（Markdown / JSONL）、容器 AES-256-GCM 加密、X25519 封装给接收者、Ed25519 签名、Merkle 根与版本链；算法全在 Node 核心 `crypto`，零新依赖 | 「谁都能看」不成立，「谁都能读懂」保留；密码学解决泄露、截获、冒充、篡改，不解决转发与运营方可读，方案如实声明（§28.4） |

### 0.3 先前资料中需要修正的结论

用户提供的《最终定版》文档整体方向正确；下面四点与核实结果不符，本方案按核实结果改写，细节见 §2.6：

1. 「Mode Router 同会话内动态切换模式」——DSH 禁止已产出内容的 agent 换 preset，而且跨模式需求本来就分不清；v2 取消模式与路由，改为统一组合内由模型计划与委派（§9）。
2. 「剥离 LSP / code-runtime / str_replace_editor 等模块以减负」——模型可见面由 **preset** 决定而非 profile；不写进我们的 preset 即不可见，**零剥离工作量**（LSP 甚至不在 `dsh-base` 里）。
3. 「`ctx.on('tool/after-execute')`、`ctx.on('subagent/completed')`、`ctx.sessions.emit(...)`、`ctx.subagent.spawn()/fork()`、`ctx.workflow.parallel()`」——这些事件名与 API 都不存在；真实缝是 `tools/pre-execute | tools/execute | tools/post-execute | tools/result` 与 `session/event`、`agent/*`（§2.3.3）；子代理是 `ctx.subagents.start(providerName, request)`（`spawn`/`fork` 是 provider 名），工作流是 `ctx.workflowEngine.start()`，`parallel()/pipeline()` 是模型所写脚本内部的钩子（§5.4）。
4. 「DSH 升级零侵入 / 零改动」——DSH 在首个正式 tag 前不做兼容承诺；零侵入是我们要**建设**出来的属性（§12），不是 DSH 赠送的。

---

## 1. 输入资料与本方案的关系

### 1.1 保留的思路

来自用户资料、本方案**原样采纳**的骨架：

- 「插排-插头」隔离模型与 Cordis 三角色（Service Definition / Provider / Consumer）；
- 「DSH 做『怎么跑 Agent』，我们做『科研 Agent 该干什么』」的工作量切分；
- 任务状态机 + 轻量队列 + 可靠执行保障（30 并发不上分布式）；
- Apodex 的四个可移植思想：外部验证团队、异步共享报告池、证据图全局验证、AgentOS 内核/工作流分层；
- 同一个底座承接科研、即时问答、GEO 等多类任务（v2 改为在同一组合内由模型组合，不再「分别装配」，§9）；
- Ousterhout 式代码规范（深模块、定义错误于无形、战略性编程），并加上 DSH 插件专项规则。

### 1.2 改写的部分

| 资料中的说法 | 本方案的处理 | 原因 |
|---|---|---|
| 「Mode Router 是流程激活器，同会话切换」 | 取消 Mode Router；统一组合 + 能力清单 + 按产出绑定契约 | §9 |
| 「三层守卫全部挂钩子、不通过就回退状态机」 | 机械可核的规则阻断；语义判断不阻断、只出 notice | §4.2 实测数据 |
| 「证据池放 Redis / SQLite 新表」 | 放 DSH 的 `ctx.storageDomain`（插件自有状态的受认可去处，JSON/SQLite 后端二选一）+ 现有工作区台账；不自建库 | D8、§7.3 |
| 「DSH 内置上下文压缩 80% / 16% / 8192 token」 | 工具结果裁剪 8192/4096/1024 已在 `standard` preset 证实；压缩触发比例**待核**（§2.6） | 只写核实值 |
| 「`$DSH_HOME/.agent-presets/` 放三个 Mode 预设」 | 只有一个预设 `evimed-universal`，随 bundle 作为**受信根**分发；用户根只放用户自己复制的副本 | §2.3.4 `roots` + `trust`、§9.2 |
| 「P0 = Mode Router + Q&A」 | P0 = 内核替换 spike（一个专科包端到端过现有门禁） | 先证明插排能供电，再谈插头功能（§13） |

### 1.3 与上位方案（2026-07-16 / 07-17）的差异声明

| 上位方案锁定项 | 本方案 | 性质 |
|---|---|---|
| 「OpenCode 是唯一 Agent 执行内核」 | DSH 是唯一执行内核 | **替换**，需上位方案作 v5 修订 |
| 「不形成双 Harness」 | 继续成立：仍只有一个 loop | 不变 |
| 「`agent.yaml + SKILL.md` 是唯一专项 DSL」 | 继续成立；`agent.yaml` 演化为**能力清单**（capability manifest），仍是唯一的能力定义 | 不变（字段增加，不是第二套 DSL） |
| 「开放域入口 + 多个专项入口；入口决定绑定哪个 Agent Package」 | 入口保留为**模板**（预填题面、点名能力）；不再绑定包，每个会话都是同一个统一组合 | **替换**（§9.8） |
| 「不设计工作流 DSL」 | 继续成立；状态机是事件投影，不是流程脚本；DSH 的 `workflow` 工具是模型在运行时写的 JS，不是我们定义的 DSL | 不变 |
| 「隔离 runtime 内默认执行，无逐动作权限」 | 托管 profile 继续如此；本地 profile 用 DSH 的 `ask` | 不变 + 明确分面 |
| 「UI 不直接调用运行时，经 `packages/sdk`」 | 托管面 UI 只调用 `apps/server`；`/api/opencode/*` SSE 直通路由退役 | 收紧 |
| 「Tauri 桌面可选」 | 桌面形态改为 DSH Web 本地 profile | 替换（D11） |

---

## 2. DSH 核实报告

> 本节每一条都标注了来源。读者若只看一节，看这节。

### 2.1 身份与发布节奏

- **是什么**：DeepSeek 开源的 Agent Harness，MIT，"everything is a plugin"，内核是 vendored 的 Cordis 4.0（`dsh:vendor/cordis`，发布名 `@deepseek-ai/cordis`，见 `dsh:docs/rescope.md`）。
- **规模**：`dsh:packages/` 下 52 个分组目录、**234 个 `package.json`**（资料中的「186 个官方包」是旧数）；分组清单与每组的「发布预期」见 `dsh:packages/README.md`——绝大多数标 `Product — stable API`，`experimental/` 标 `Unreleased`，`e2b/` 标 `POC`，`test-support/` 标 `lower compatibility expectations`。
- **节奏**（`npm view @deepseek-ai/dsh time`）：`0.0.1-rc.1` 2026-08-10 → `0.1.0-rc.2` 08-13（公开预览）→ `0.1.0-rc.7` 08-17 → `rc.8` 08-19 → `0.1.1-rc.1` 08-21 06:49 → `0.1.1-rc.2` 08-21 12:42。**11 天 10 个版本**，仍无正式 tag。
- **npm 发布面**：`@deepseek-ai/dsh`、`dsh-tools`、`dsh-agent`、`dsh-session`、`dsh-skill`、`dsh-subagent`、`dsh-workflow`、`dsh-agent-presets`、`dsh-hooks-claude-code`、`dsh-sdk-client`、`dsh-acp`、`dsh-mcp-client`、`dsh-web`、`dsh-goal`、`dsh-system-prompt` 均已发布；`dsh-sdk-server`、`dsh-test-support`、`dsh-preset`（不存在此名）未发布。注意多数子包的 `latest` dist-tag 仍指向 `0.0.1-rc.1`，**安装必须写精确版本**。
- **Node**：`^22.19.0 || >=24.0.0`（`dsh:package.json`）；我们的 `engines.node >= 22.22.0` 兼容。

### 2.2 兼容性承诺：没有

`dsh:AGENTS.md` 第 5–7 行，原文：

> **Pre-release stance: foundation over blast radius.** Remove this section at the first tagged release. With no external consumers, prefer the correct foundation over compatibility shims: rename or repackage freely and update every reference together. Backends reject old on-disk formats. SQLite uses monotonic `SCHEMA_VERSION`; `dsh-session` keeps `SESSION_FORMAT_VERSION` at `0` with no compatibility promise.

`dsh:README.md`：「THERE WILL BE COMPATIBILITY-BREAKING CHANGES.」`dsh:docs/persistence-catalog.md`：会话日志格式「pre-release, no compatibility implied」。

**含义**：

1. 「插排每次升级我们都不用动」在当前阶段是**错误预期**；正确预期是「升级的改动被限制在防腐层一个包里，并且在夜间矩阵里第一时间被发现」。
2. 会话日志不保证跨版本可读——我们的运行账本、交付件、证据台账必须**继续以工作区文件为权威**（现状如此），DSH 会话日志只作回放与 UI，不作交付依据。
3. 这是预发布期的成本；DSH 一旦出正式 tag，D3/D4 的机制不会白费——它们本来就是任何第三方插件该有的纪律。

### 2.3 架构要点（与插头直接相关的部分）

#### 2.3.1 组装：bundle → profile → patch

- **Profile** = `$DSH_HOME/profiles/<name>`，一个 `package.json`（`dsh.profile.bundles` 有序列表，由 `dsh plugin` 维护）+ 用户自己的 `cordis.patch.yml`。
- **Bundle** = 一个 npm 包，`package.json` 声明 `dsh.bundle.patch = ./cordis.patch.yml`；patch 是行列表，`insert` 新行或按 `id` **整体替换**目标行的 `config`（不是深合并）。
- **组合顺序**（`dsh:apps/cli/reference/README.md`）：各 bundle 按 profile 列表顺序 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 每个 `--patch` 覆盖层；后者按行覆盖前者。
- `dsh-base` 是每个 profile 的第一层（模型适配、工具、持久化、沙箱、审批、设置、凭据、遥测），`dsh-web-app` 加浏览器应用，`dsh-headless` 加一次性运行器。
- 安装：`dsh plugin --profile <name> add <pkg|./dir|github:owner/repo#sha>`；改 bundle 集合需重启 profile，改 patch 可热重载。
- 查看实际树：`dsh --profile <name> --dump-config`。

#### 2.3.2 缝（seam）与三角色

`dsh:docs/architecture.md`「Capability seams」：一个缝 = Service Definition（抽象类，拥有 `ctx.<key>`）+ Provider + Consumer；换一个 provider 换整个能力栈。核心 `ctx` 键：`ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`、`ctx.agents`、`ctx.agentLoop`、`ctx.llm`；能力缝：`ctx.shell`、`ctx.subprocess`、`ctx.terminals`、`ctx.jobs`、`ctx.fs`、`ctx.sandbox`、`ctx.commands`、`ctx.goals`、`ctx.subagents`、`ctx.workflowEngine`、`ctx.compaction`、`ctx.agentPresets`、`ctx.skills`（`dsh:docs/capability-seams.md` 为生成图）。

`dsh:packages/README.md` 的纪律：**「Extension plugins depend on Service Definitions, never concrete providers.」** 这条正是 D3 的上游依据。

#### 2.3.3 三个事件域与回合流

`dsh:docs/architecture.md`「Events」与「Turn flow」：

- **Session events**（持久，写入日志并经 `session/event` 广播）：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`。事实要跨重载存活，用这一类；新增模型可见输入必须扩展 `SessionEventMap`。
- **Agent events**（`agent/*`，在途工作）：`agent/session-start`、`agent/pre-step`（waterfall，可改写/拒绝本步输入）、`agent/request`、`agent/request-error`、`agent/turn-stopping`（串行，可再推一步）。
- **Capability events**（`fs/*`、`tools/*`、`telemetry/*`）：挂策略与适配器。
- **工具管线**：`tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*`；三个 `tools/*` 是 waterfall，监听器必须 `next()` 委托；`tools/pre-execute` 返回类型化决定（`allow | deny | ask`），`ctx.tools.guard()` 提供单调终局拒绝，`tools/execute` 可包裹派发生命周期（超时/重试/度量），`tools/post-execute` 改写结果，`tools/result` 只读观察最终结果（`dsh:docs/cookbook/extension-cookbook.md`）。
- **`ToolExecution.concludeTurn()`**：成功的终结工具调用它，loop 在本步后停止——这是 `evimed_complete_run` 结束回合的机制基础（§8.1）。
- 回合结构：turn ⊇ step（一次模型请求 + 其工具调用）；`deriveMessages()` 从日志投影模型历史；**Model-visible ⟺ logged** 由运行时不变式断言。

#### 2.3.4 Agent preset：模型可见面的唯一决定者

`dsh:packages/preset/README.md`、`dsh:packages/preset/agent-presets/README.md`、`dsh:apps/cli/config/agent-presets/*/agent.cordis.yml`：

- 一个 preset = 一个目录，内含 `agent.cordis.yml`（行列表）+ 可选 `preset.yml`（仅 `name`/`description`/`order` 展示元数据）。
- preset 在**agent 作用域**下挂载：它注册的工具、提示词节、persona 只属于该会话；宿主组合（`dsh-base` + `dsh-web-app`）持有 preset **不得**拥有的东西：注册表本身、沙箱与审批栈、持久化、模型路由。发布进程全局服务的行在挂载时被拒绝；需要每会话实例的服务行必须放在带 `isolate` realm 的 `cordis:group` 内。
- 发现根：`roots[]`（有序，`trust: system | user`）+ 派生的 `<dshHome>/.agent-presets`（user）。**先出现的根赢得重名**——所以我们的 preset 作为 **system 受信根**随 bundle 分发，用户复制出的副本才落在 user 根。
- 默认 preset 是用户设置（`settings.yaml` 的 `agent-presets.default`）。
- **切换规则**：`recompose()` 只对「尚未产出任何内容」的 agent 合法；网关在线上以 `agent-preset-locked` 拒绝（`dsh:packages/host/apiproxy`）。子代理通过 `composeFrom()` 加入父代理的同一组合，不重新挂载。
- 出厂 preset：`standard`（完整编码 agent）、`code`（standard + Code Mode 呈现）、`minimal`（仅持久 bash + `str_replace_editor`，`persona.complete: true`）、`cordis`（自指插件工具）。`standard` 的关键行：`persona`、`agent-instructions`（AGENTS.md，65536 字节预算）、`tool-bash`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`skill-filesystem` + `tool-skill`、`tool-goal`、`planning` 组（`plan-mode`）、`compaction` 组（`compaction-basic` + `command-compact` + `tool-result-pruner{thresholdChars: 8192, headChars: 4096, tailChars: 1024}`）、`delegation` 组（`tool-subagent{provider: spawn, backgroundMode: continuable}`、`subagent_fork`、`workflow-worker-thread`、`tool-workflow`、`tool-ralph{maxRounds: 64}`）、`tool-ask-user`、`tool-todo`、`tool-web{fetch: false, searchTimeoutMs: 60000}`。

**推论**：只有一个 preset（`evimed-universal`，§9.2）；托管与本地的差异全在 profile patch 与环境变量；「剥离编码工具」= 不写进这个 preset。

#### 2.3.5 persona 行

`dsh:packages/preset/persona/README.md`：`@deepseek-ai/dsh-persona` 只能在 preset 内挂载，`text` 支持 `{{model}}`、`{{cwd}}` 模板变量，`complete: true` 时为整个系统提示词的唯一节，`includeRuntimeContext: false` 关闭运行时上下文快照。前缀在 agent 生命期内稳定，利于 KV 缓存。

#### 2.3.6 插件编写的最小契约（`dsh:docs/user/develop/basic/*`）

```ts
// 一个插件模块的导出面
export const name = 'evimed-xxx'
export const inject = ['tools']              // 依赖的服务键；可选服务用 ctx.get('key')
export interface Config { /* ... */ }
export const Config: Schema<Config> = Schema.object({ /* 默认值写在 schema 上 */ })
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({ /* name, description, parameters, output, execute */ }))
  ctx.on('tools/pre-execute', async (exec, next) => next())
  // 所有注册都是 ctx.effect，卸载/HMR 自动回滚
}
```

- `defineTool` 来自 `@deepseek-ai/dsh-tools`；对象输出 schema 必须写 `additionalProperties: true`（社区教程 Discussion #961 踩坑）。
- 配置用 `@deepseek-ai/schemastery`，「任何两个部署可能设不同的值都必须是配置字段」（`dsh:docs/user/develop/basic/config.md`）。
- 从 git 安装的包需要 `prepare` 脚本且 pnpm ≥10 要 `allowBuilds` 白名单；**发布构建产物到 npm 或 tarball 更省事**（`dsh:docs/user/develop/basic/publish.md`）。

### 2.4 宿主形态与托管 SaaS 的差距

| 能力 | DSH 现状（来源） | 对我们的含义 |
|---|---|---|
| Web 宿主 | `dsh web` 默认 `127.0.0.1:3080`，**「intentionally does not support `--host 0.0.0.0` yet and exits with a usage error」**（`dsh:apps/cli/reference/README.md`）；`/api` 有浏览器信任栅栏 `--trusted-host` | 不能把 DSH Web 直接暴露为 SaaS；它是单机产品 |
| 身份 | `packages/identity` = 「Shared anonymous identity」 | 无用户/租户模型；租户边界仍在 `apps/server` |
| 多会话 | 一个宿主进程内可运行多个不同 preset 的 agent（`dsh:packages/preset/README.md`） | 每项目一个 DSH 进程足够承载该项目的并发会话与子代理 |
| 程序化驱动 | `packages/sdk`「Out-of-process runtime SDK: JSON-RPC protocol, TypeScript client, and server plugin」；`packages/acp` 自动化用 ACP 服务器；`python/` Python SDK；`dsh --profile headless "<task>"` 一次性运行（退出码 0/1，stdout 打印最终文本） | 控制面 ↔ 容器内 DSH 的接线候选；方法清单与传输见 §6 |
| 远程沙箱 | `packages/e2b` 标 **POC**；`ctx.fs`/`ctx.subprocess` 可指向远程执行世界 | 现阶段仍用「Docker 容器 + 容器内 DSH 本地沙箱」 |
| 沙箱默认 | 新会话默认 `workspace-write`：bash 与文件写限制在会话工作区与临时根，**读与网络不受限**；bwrap 私有 PID 命名空间，Landlock/Seatbelt 不隐藏宿主进程；`DSH_PERMISSION_MODE` 改进程级回退 | 网络不受限 ⇒ **必须**继续靠容器网络策略 + 网关持钥来禁止直连外网（D9） |
| 遥测 | 默认本地；`DSH_TELEMETRY_MODE=FULL` 会外传消息全文、工具参数与工作区路径，**无脱敏规则** | 托管 profile 必须 `DSH_TELEMETRY_DISABLED=1` |
| 凭据 | 环境变量 > `$DSH_HOME/.credentials.yaml` > 项目 `.env` > `$DSH_HOME/.env`；搜索用 `DEEPSEEK_API_KEY` | 容器内只放工作负载令牌，不放真钥 |
| MCP | `@deepseek-ai/dsh-mcp-client` 随 CLI 发布，但**默认不启用任何 server**，「each server command is trusted executable code outside the agent sandbox」 | 我们的 `evimed-research` 以 patch 行挂载；它本来就在沙箱外（现状同） |

### 2.5 与我们的安全不变式直接相关的配置点

- `@deepseek-ai/dsh-llm-deepseek` 配置（`dsh:docs/config-catalog.md`「dsh-llm-deepseek」）：`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`，每请求解析）、`baseURL`（回退 `$DEEPSEEK_BASE_URL`）、`thinking`、`reasoningEffort`（默认 `high`）、`maxTokens`（默认 256,000）、`defaultContextWindow`（默认 1,000,000）、`models[]`、`streamIdleTimeoutMs`（默认 5 分钟）、`retryPolicy`。
  - ⇒ 把 `baseURL` 指向 `/internal/model/v1`，`apiKeyEnv` 指向注入的工作负载令牌变量名，即可复用现有 `modelGateway.mjs`（它本来就接受 HMAC 令牌、服务端换真钥、强制 `thinking`/`reasoning_effort`、空闲超时 300 s）。**待核**：模型网关的 `/chat/completions` 形状是否与 `dsh-llm-deepseek` 的直连请求（含 `thinking` 字段、流式 `reasoning_content`）逐字段兼容，见 §15。
- `dsh-base` 默认模型行：`agent-default-model{provider: deepseek-official, model: deepseek-v4-flash}`——我们要在 patch 里整体替换为 `deepseek-v4-pro`（与 `modelGateway.mjs` 的 certified 集合一致）。
- `web_fetch` 默认关闭、需 patch 插入 provider 才开；`web_search` 默认走 `dsh-web-search-deepseek`（DeepSeek 搜索 API，需 `DEEPSEEK_API_KEY`）。我们**不**启用这两者：检索走 MCP 的 `evimed_web_search`（SearXNG 网关）与 `evimed_*` 检索工具，保持「运行时永不指定主机」。
- `dsh-base` 默认启用 `hmr{root: ['.']}`（监视工作目录热重载）——托管 profile 关闭（`- id: hmr\n  disabled: true`，headless bundle 已这么做）。
- `session-persistence-jsonl{root: dshHomePath('sessions')}`——托管时 `DSH_HOME` 指向容器内项目数据卷，使会话日志随项目持久化；`session-query-sqlite{path: ':memory:'}` 保持内存（我们不依赖 DSH 的全文检索）。

### 2.6 对先前资料若干说法的核对表

| 资料说法 | 核对结果 |
|---|---|
| Cordis 五个核心服务 Fiber/Registry/Reflect/Events/Context；Fiber 生命周期 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED` | **待核**（vendored cordis；npm latest 实为 **4.0.1**，2026-08-24 注册表核实——早稿写 4.0.0-rc.7 有误，已按 `deps-version.json` 更正） |
| 工具管线 `pre-execute → 单调守卫 → execute → post-execute → finalizeContent → result` | 基本正确；`finalizeContent` 是内部步骤，对插件可见的缝是四个 `tools/*` 事件 + `ctx.tools.guard()` |
| 7 种子代理 provider | `spawn-in-process`、`fork-in-process`、`acp`、`codex`、`claude-code`、`dsh-sdk` 六个 provider 名在 `standard` preset 与 CLI 文档中可见；`in-process-driver` 是共享实现 |
| 工具结果裁剪 8192 / 头 4096 / 尾 1024 | **已证实**，但单位是 **Unicode 码点**而非字符/字节（`dsh:packages/compaction/compaction-tool-result-pruner/src/config.ts:11-13`）；另有 `spill-policy.maxInlineBytes: 50000`（UTF-8 字节）是 `dsh-base` 的设置值、插件本身默认关闭 |
| 压缩在 80% 触发、保留 16% 尾部、摘要 ≤ 8192 token | **已证实**：`compaction-basic` 的 `thresholdRatio = 0.8`、`retainRatio = 0.16`（按**路由模型**的上下文容量计）、`maxTokens = 8192`（是摘要调用的**生成上限、含推理 token**，不是摘要长度保证）；另有 `agent/request-error` 上的溢出恢复路径、`compactionRetries: 1`（`dsh:packages/compaction/compaction-basic/src/config.ts:20-91`） |
| 会话持久化 JSONL + SQLite；崩溃补记 `interrupted` 的 `turn/end` | **已证实**：JSONL（默认，zstd 帧、`$DSH_HOME/sessions/`）与 SQLite（opt-in）；冷加载时为未闭合的 turn 追加合成的 `tool/result`（`TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN`）与 `turn/end{reason.kind: 'interrupted'}`，不截断日志（`dsh:docs/subsystems/persistence.md:13-15`） |
| `web_search` 内置、rc.8 起并发 | 内置已证实：`web_search({queries: string[]})` 一次 1–4 个查询；后端是 DeepSeek 的 Anthropic 兼容 Messages API 上的 `web_search_20250305` 服务端工具，**每次检索花费一整个模型回合**，复用 `DEEPSEEK_API_KEY`（`dsh:packages/web/web-search-deepseek/README.md`）。我们不启用它（§2.5） |
| Goal、Workflow `parallel()/pipeline()`、Ralph Loop、ACP | Goal（`dsh-goal` + `dsh-goal-round-driver` + `tool-goal`）、workflow（`workflow-worker-thread` + `tool-workflow`）、ralph（`tool-ralph`）、ACP（`packages/acp`）均已证实；`parallel/pipeline` 的脚本 API **待核** |
| 三档沙箱 `read-only / workspace-write / danger-full-access` | **已证实**（`dsh:packages/sandbox/sandbox-policy/README.md:13`）；策略按会话持久（`sandbox/mode` 事件），后端（bwrap/Landlock/Seatbelt）按进程一次选定 |
| `dsh plugin --profile web add <pkg>` 一行安装 | 已证实 |
| 「186 个官方包」 | 实为 234 个 `package.json`（含 vendor/apps/website） |
| LSP 需要剥离 | `dsh-tool-lsp` 不在 `dsh-base` 依赖中，亦不在任何出厂 preset 里；无需剥离 |
| `minimal` preset = bash + `str_replace_editor` | 已证实（持久 bash + `str_replace_editor`，`persona.complete: true`） |
| Agent Teams「蜂群」 | 存在于 `packages/experimental/{agent-team,tool-agent-team}`，`ctx.agentTeams`：持久花名册、任务 DAG（`blockedBy` 无环、`writeScopes` 仅建议性）、持久邮箱、`foldTeam()` 回放；**标注 Unreleased / 无稳定性承诺** |

---

## 3. 现状资产盘点与迁移映射

> 盘点由两个只读检索代理逐文件完成，结论按「搬进插头 / 留在控制面 / 被 DSH 取代 / 退役」四类归并。行号对应 2026-08-22 的工作树。

### 3.1 控制面 `apps/server/src`

| 模块 | 行数 | 归类 | 说明 |
|---|---|---|---|
| `agentRuns.mjs` | 2,289 | **留在控制面**（~95% 运行时无关） | 账本折叠、交付判定、修复回环、进度三态、源错误码两分法。对运行时只依赖四个注入函数（`readSessionHistory` / `readSessionStatus` / `runtimeWorkspaceRoot` / `sendPrompt`，接线在 `server.mjs:385-387`）+ 一个**消息形状**（`message.info.role`、`parts[].type === "tool"`、`part.state.{status,input,output}`、`part.tool` 含 `evimed_`）。迁移改动：消息形状归一化为 `@evimed/domain` 的 `RunTranscript`；`delivering` 触发条件改为「计划含交付物」；多交付物逐件判定；`max-tokens` / `aborted` / `blocked` 子码；顺手修 S4–S6 |
| `clinicalEvidenceQuality.mjs` | 4,262 | **留在控制面**，同时其规则**镜像进插头**（§8） | 纯函数门禁；`validateClinicalEvidencePackage:3452`、`citationIntegrityIssues:1836`、`coverageJudgeContext:3336` |
| `clinical-safety-rules.json` | — | **随插头分发 + 控制面读取** | 药师可编辑的数据；两侧读同一份 |
| `coverageJudge.mjs` | 451 | 留在控制面（不阻断的判分） | 「模型判、代码核」范式的实现样本（§4.2） |
| `specialistRouting.mjs` / `specialistClassifier.mjs` | 192 / 189 | **降级为期望检查，不再路由**（§9.4） | 分类器「按所委托的交付物而非所提及的话题判断」的提示词移入编排器指引；点名 = 高置信期望；正则安全网退役；`clinical-safety-rules.json` 的 `routingEntities` 改为**内容触发器** |
| `agentRegistry.mjs` | 406 | **留在控制面 + 生成能力清单** | `agent.yaml` 契约校验；`runtimeAgent = "evimed-" + id` 退役，改为能力 id 与契约 kind（§9.3） |
| `researchSessions.mjs` | 252 | 留（简化） | 不再按会话绑定专科；记录统一组合 id、bundle 版本与能力目录摘要，供回放时重建当时可委派的能力集 |
| `researchContext.mjs` | 407 | 留 | 知识库切片、记忆召回、系统提示词组装（`<evimed-knowledge>`/`<evimed-memory>` 包裹） |
| `memoryIntelligence.mjs` / `memosClient.mjs` | 487 / 723 | 留 / **替换** | 运行后记忆抽取保留（敏感预筛、观察生成）；`memosClient.mjs` 换成 `memorySubstrate.mjs`（MemOS REST 端口，§19.16） |
| `modelGateway.mjs` | 438 | **留，成为 DSH 的 `baseURL`** | 运行时不持钥；certified 模型集合；空闲超时 |
| `publicSourceGateway.mjs` / `webSearchGateway.mjs` | 753 / 281 | 留 | 外联唯一出口；SSRF 防护 |
| `runtimeManager.mjs` | 4,676 | **被 DSH 取代（约 90%）** | OpenCode 启动计划、就绪探针、HTTP+SSE 代理、`syncRuntime{AgentPackages,ModelProvider,EviMedMcp,Skills}`、`generatedRuntimeAgent`；**保留**：`issue/verifyEviMedWorkloadToken:1553/1593`、`issue/verifyModelGatewayRuntimeToken:1663/1698`、`refreshEviMedWorkloadToken:1763`、`validateEviMedAdapterConfig:2029`、配额/空闲/容量策略 |
| `runtimeControllerClient/Server.mjs` | 212 / 723 | 留（特权 Docker 代理） | 与内核无关；启动的是 DSH 镜像而非 OpenCode 镜像 |
| `mockRuntime.mjs` | 259 | **退役 → 换成 DSH 假内核** | 现有「第三种运行时」先例证明 `RuntimeManager` 已可多内核 |
| `server.mjs` 的 `ALL /api/opencode/:projectId/*` | — | **退役** | 浏览器直通 SSE 的唯一路由（`:1164`）；替换为控制面自己的会话事件流（§6） |
| `store.mjs` / `controlPlaneDatabase.mjs` / `oidc.mjs` / `security.mjs` / `taskManager.mjs` / `commands.mjs` / `config.mjs` / `releaseManifest.mjs` / `saasProfile.mjs` | — | 留 | 租户、会话、安全文件系统、内核命令、配置、发布溯源 |

`config.mjs` 集中读取 137 个 `OPEN_SCIENCE_*` 环境变量；仅 `modelGateway.mjs:26` 与 `runtimeManager.mjs` 直接读 `process.env`。**迁移时新增的变量只在 `config.mjs` 增加**，运行时相关的 `OPEN_SCIENCE_OPENCODE_{BIN,VERSION}`、`OPEN_SCIENCE_RUNTIME_SKILL_DIRS` 等改名为 `OPEN_SCIENCE_DSH_*`（保留旧名一个发布周期作硬错误提示，不做静默别名）。

### 3.2 运行时侧资产

| 资产 | 现状 | DSH 对应物 | 迁移难度 |
|---|---|---|---|
| `runtime/mcp/evimed-research/` | 纯标准库 Python，stdio JSON-RPC，MCP `2024-11-05`，**24 个 `evimed_*` 工具**，8 个 unittest 文件 3,688 行；由 `runtimeManager.mjs:~2545` 写入 `opencode.json` 的 `mcp[...]` 条目 | `@deepseek-ai/dsh-mcp-client` 一行 patch（每 server 一个插件实例，工具名 `mcp__<server>__<tool>`） | **低**：服务零改动；工具名前缀变化需同步 `agent.yaml.requiredTools`、SKILL.md 文内工具名、`clinicalEvidenceQuality.mjs` 的泄漏禁词（`evimed_*` → 也要禁 `mcp__evimed-research__*`）、`agentRuns.mjs` 的 `part.tool` 匹配 |
| `runtime/skills/evimed/*`（12 个专科包：`agent.yaml + SKILL.md`） | `agent.yaml` 字段：`id, version, title, category, description, skill, companionSkills, estimatedMinutes, starterPrompts, requiredInputs, optionalInputs, requiredTools, optionalTools, dataSources, outputs[{path, required}], completionChecks` | `agent.yaml` **改名**为 `capability.yaml`（§9.3），构建时校验，在统一组合内供编排器委派；SKILL.md 经 `skill-filesystem` 根发现 | **中**：生成器是新代码；SKILL.md 中「`$XDG_CONFIG_HOME/opencode/skills/...`」等 OpenCode 路径要改 |
| `clinical-evidence-synthesis/scripts/preflight.py` | 3,039 行，~60 条规则，与服务端门禁逐字段镜像；SKILL.md 第 1717 行要求「修到 `ok: true` 再交付」 | **删除**：规则单实现在 `@evimed/domain`，运行侧由 `evimed_submit_deliverable` 返回裁定（§8.1）；SKILL.md 改为「提交直到 ok」 | **低**：删文件 + 改文案 |
| `runtime/skills/core/*`（13）、`curated-scientific/*`（38 + `_runtime/execute_skill.py` + `inventory.json` 交付契约）、`office/*`（4） | 标准 `name/description` frontmatter；4 个带 `allowed-tools`（Anthropic 工具名） | 同上；`allowed-tools` 需映射到 DSH 工具名或删除 | **低** |
| `runtime/skills/external/*` | gitignored 第三方包，不进镜像 | 不变 | — |
| `runtime/kernel/` | Python/R JSON-over-stdio 内核桥，与 Harness 无关 | 不变 | — |
| `runtime/harness/` | 仅 markdown（AGENTS.md/KNOWLEDGE.md），由桌面壳播种到工作区 | 删除；其「自演化」意图由胶囊方法层承担（§19）；统一组合不挂 `agent-instructions` | **低** |
| `runtime/opencode-profile/` | 空占位 | 删除 | — |
| `deploy/runtime-opencode/` | Debian + OpenCode 1.17.13（sha256 pin）+ uv + R + chromium + 科学栈 + curated skills 烟测 | **`deploy/runtime-dsh/`**：同一镜像去掉 OpenCode、加 Node 22 + 固定版本 `@deepseek-ai/dsh` + 我们的 bundle（tarball pin）+ 一个预初始化的 profile 目录 | **中**：镜像构建脚本新写；烟测照搬 |
| `deploy/specialist-adapter/` | FastAPI + HMAC 工作负载令牌，五个 `项目代码/` 专科 | 不变（MCP → adapter 的 HTTP 合约与内核无关） | — |

### 3.3 前端与 SDK 耦合点（必须切断的地方）

`packages/sdk/src/OpenCodeClient.ts`（894 行）解码 OpenCode 的 SSE 形状（`message.part.updated`、`part.state.metadata.{output,diff,sessionId}`、`question.v2.*`、`permission.v2.*`），`apps/desktop/src/lib/runtime.ts` 直接 import `OpenCodeClient` 与 `DEFAULT_OPENCODE_URL`，并把 OpenCode 的 approval mode 当 UI 状态；`packages/sdk/src/runtime.ts` 的 `AgentRuntime` 接口（25 个方法）是作者自述的「可移植切片」。

迁移决定：

1. 托管面前端**只与 `apps/server` 通信**；会话事件由控制面从 DSH 订阅、解码为 `@evimed/domain` 的 `RunEvent` 联合后经 SSE 转发（§18.4）；前端的运行时 store 重写（§18.3）。
2. `AgentRuntime` 接口保留为控制面内部的内核适配接口（`OpenCodeRuntimeAdapter` → `DshRuntimeAdapter`），`OpenCodeClient` 退役。
3. 桌面形态按 D11 改为 DSH 本地 profile；`apps/desktop/src-tauri/src/opencode_config.rs` 的 110 条 OpenCode 权限 glob 规则（`DANGEROUS_BASH` 50 词表）**不再移植**——DSH 的 `workspace-write` + `ask` 审批取代之。

### 3.4 评测资产 → 内核平价评测

- `uploads/20260813-final/`（31 份 RQ 交付 + `audit/rungate.mjs` 回放门禁 + `audit/judgelive.mjs`）与 `uploads/20260812-sxjxw-33/briefs`（题面）：这是现成的**内核平价语料**。迁移验收标准（§13 P0/P1）：同一题面分别经 OpenCode 与 DSH 内核跑完，`validateClinicalEvidencePackage` 的 `errorCode`/`blockingIssues` 分布不得劣化；55 条人工标注缺陷的召回不得下降。
- `evals/title-to-paper/`（50 篇 OA 语料、10 个评分器、发布阈值 ≥0.98 终态成功 / ≤0.05 重大无据主张 / ≤0.08 逐字复用）照跑。
- `evals/capability-audit/verify_release_audit.py` 的发布门禁继续作为 `ci:web` 的一部分；`release-manifest.json` 增加 `dsh.version` 与 bundle 摘要。

---

## 4. Apodex 思想的取舍（以我们自己的实测为准）

### 4.1 采纳

| Apodex 机制（原文位置） | 在本方案中的落点 |
|---|---|
| 外部验证：验证者「不共享被审推理轨迹、被提示去评价而非续写、可调用原推理者没用过的接地工具」（§3.1） | 服务端门禁（不同进程、题面由服务端持有）+ 交付终结工具硬门（§8）；LLM 判分用独立调用、独立 prompt、只看摘录 |
| 异步共享报告池（`queued / in progress / ready` 状态表，主 agent 按自己的节奏读）（§3.2） | DSH 子代理 `backgroundMode: continuable` + `tool-subagent-report` 的 `reportDelivery: quiet / next-step` 回报机制 + 插头 `storageDomain` 里的证据表（§7.3） |
| 证据图全局验证：「验证者推理的是拼装好的图，而不是产生它的团队」（§4.1） | 证据图 = `clinical-evidence-matrix.json` + `citation-ledger.csv` + `question-coverage.json` 的投影；题面逐问核对已是图上的连通性检查（每个 Claim 至少一条 supports 边到 Evidence） |
| AgentOS 内核/工作流分离、单一窄门面、依赖只向内（§5.1）；hooks（observers + middleware）与 components 两类扩展（§5.2） | DSH = 内核；我们的 bundle = 工作流策略；防腐层 = 我们这一侧的窄门面（§5） |
| 工作流脚手架 `clarify → solve → verify → report`，verify 门按「引用覆盖、平均置信、争议占比、未决主张数」回环到 solve（§5.3） | 任务状态的四段（§7.1）：clarify = `evimed_plan.clarifications[]`；verify 门的四个指标由 `@evimed/domain` 从 matrix / ledger 机械计算写入 `gateRuns.metrics`（先作 notice，§8.1）；回环上限是 `deliveryAttemptLimit`（§10.4） |
| 五个扩展点 Tool / MCP server / Skill / Component / Workflow（Table 1） | DSH 对应：`defineTool` / `dsh-mcp-client` 行 / `SKILL.md` / 我们的 Cordis 插件（= component）/ `evimed_plan`（= workflow 选择） |

### 4.2 不采纳或降级采纳（以及为什么）

1. **「三层验证者全部阻断」——降级为「机械可核者阻断、语义判断不阻断」。** 依据 `OpenScience/PROGRESS.md` 2026-08-16 三条记录：`coverageJudge` 在 29 份真实交付上产出 129 条判断，代码核验后留 114 条，**只有 3 条落在人工标注上**（每份交付约 4 条噪声换 1 条真）；同一输入 temperature 0 跑五次得 6/4/4/3/4 条且「罪名」不同——**不可复现的东西不能当回归信号**。Apodex 的验证团队是**训练出来**的行为（其 §4.1：「This verification reasoning behavior is learned rather than prompted」），我们用的是通用模型 + 提示词，精度不在一个量级。所以：阻断只来自代码可核的规则；模型判断产出 notice 并标 `verification: unverified | unchecked`。
2. **「验证是模型层行为」——我们反过来：验证是机制层行为。** 同一份 PROGRESS 记录了三次「门禁被绕过」的教训（同义词、拆句、一个限定从句即可穿透六条新检查）。结论已经是「架构而非再加门禁」：把题面送进门禁、被检查方不能提供考题。本方案把这条原则机械化：交付终结工具是唯一的交付通道，preflight 在其 `tools/pre-execute` 上运行。
3. **「150 个子代理、15,000 步」——不以此为目标。** 我们的交付是 8 个必需文件 + 一份 1,851 行的 SKILL 约束，瓶颈不是探索广度而是证据链完整性；30 并发（进程内）是上限设计，`agentTeams` 作为后期可选项（§10）。
4. **「数据飞轮 / SFT·DPO·RL」——不在本方案范围。** 轨迹采集（DSH 会话日志 + 账本）本来就有；训练是另一个项目。

---

## 5. 插座的内部结构

> 用户称这一层为「插座」；本文早期章节称「插头」、包名称 `dsh-bundle`，定版统一为 **`@evimed/dsh-socket`**（§20）。

### 5.1 仓库位置、包布局与依赖方向

插座住在现有 `OpenScience/` pnpm 工作区里，共用 `ci:web`；三个新包必须进根 `lint` / `typecheck` / `test:web` 脚本（§14 规则 40）：

```text
OpenScience/
  packages/
    domain/                @evimed/domain        纯领域库，零依赖 ESM，浏览器安全（不 import node:* 内建）：门禁规则与契约注册表、
                                                 claim 类型、引用完整性、题面比对、clinical-safety-rules.json、状态机 transition()、
                                                 错误码注册表、工具名 / 契约种类 / 工作区布局 / 三套状态词汇的唯一定义
    harness-port/          @evimed/harness-port  防腐层：仓库里唯一允许 import '@deepseek-ai/*' 的包；拥有自己的类型词汇并做形状转换；
                                                 seam-manifest.json 是它与自检、lint、契约测试的共同来源
    socket/                @evimed/dsh-socket    可安装 Bundle：cordis.patch.yml + presets/evimed-universal/（含随 preset 发行的技能目录）+ plugins/*.mjs
  apps/server/             控制面：DshRuntimeAdapter、账本、交付判定、期望检查、胶囊服务（import @evimed/domain）
  apps/web/                前端（原 apps/desktop 去掉 src-tauri）；import @evimed/domain 的类型与纯函数
  deploy/runtime-dsh/      运行时镜像：Node 22 + 精确版 @deepseek-ai/dsh + @evimed/dsh-socket + 预初始化 profile
```

依赖只朝一个方向，由 `dependency-cruiser` 强制（§14 规则 3）：

```text
apps/server ───────────► @evimed/domain
apps/web ──────────────► @evimed/domain（仅类型与纯函数）
@evimed/dsh-socket ────► @evimed/domain
@evimed/dsh-socket ────► @evimed/harness-port ───► @deepseek-ai/*（peer: @deepseek-ai/cordis）
apps/server ──✗──► @evimed/dsh-socket     （控制面与插座只通过工作区文件和线协议通信）
@evimed/domain ──✗──► 任何东西
```

- 语言与构建：plain ESM `.mjs` + `checkJs` + JSDoc，**新包 `strict: true`、禁 `{any}`**（不沿用 `apps/server` 的 `strict: false`）；无构建步骤，避开 git 安装的 `prepare` / `allowBuilds` 坑。
- 分发：`@evimed/dsh-socket` 依赖 `workspace:*` 的 `domain` 与 `harness-port`，`pnpm pack` 不会把它们装进 tarball——发布前用 `pnpm deploy` 产出自包含目录或把两者列为 `bundledDependencies`（V17 核实哪种能被 `dsh plugin add ./x.tgz` 正确解析）；sha256 pin 进镜像。
- 版本 pin 单点：`OpenScience/deps-version.json` 的 `dsh` 键是 `@deepseek-ai/dsh` 精确版本的唯一定义（同一文件还钉 `memos / openlist / mineru`，§12.1）；Dockerfile ARG、`seam-manifest.dsh`、`peerDependencies`、`release-manifest` 由测试断言相等（§14 规则 35）。
- function plugin 只具名导出 `name / inject / Config / apply`，无 default export（DSH postmortem 0001）。

### 5.2 Bundle 清单与 patch

```json
{
  "name": "@evimed/dsh-socket",
  "version": "0.1.0",
  "type": "module",
  "files": ["index.mjs", "plugins", "presets", "cordis.patch.yml"],
  "exports": { ".": "./index.mjs", "./plugins/*": "./plugins/*.mjs", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "4.0.1" },
  "dependencies": { "@evimed/domain": "workspace:*", "@evimed/harness-port": "workspace:*" }
}
```

bundle 的 `cordis.patch.yml` **只放与部署无关、不含路径的行**；所有带路径或地址的行（MCP 命令、preset 根、网关地址、令牌变量、技能目录）由**部署方生成的 profile patch** 提供——托管面由控制面在每次启动运行时生成（§6.5），本地面由 `evimed-local` 安装脚本生成。这样同一个 bundle 插两种插排不需要改一行。

```yaml
# @evimed/dsh-socket/cordis.patch.yml — 宿主面，三行
- insert:
    - id: evimed-seam-probe          # 启动自检（§5.6）；门禁级缝缺失即抛错
      name: '@evimed/dsh-socket/plugins/seam-probe'
    - id: evimed-evidence-store      # storageDomain 域 evimed_run@1（§7.2），provide 服务 evimedRun
      name: '@evimed/dsh-socket/plugins/evidence-store'
- id: hmr                            # 两种部署都不需要源码热重载
  disabled: true
```

patch 只有两种操作：`insert`（无 `id` 追加到顶层；有 `id` 则插入该 `group: true` 行内）与按 `id` 的字段覆盖（`config` 整值替换）；**没有 `remove`**，删除用 `disabled: true`；匹配不到只在 stderr 告警——所以 §5.6 的自检要核对我们覆盖的**每一行**。`agent-presets` 行（在 `dsh-web-app` bundle 里）的 `roots` 由 profile patch 整值替换。

### 5.3 插件清单（全文唯一清单；其他章节只引用）

| 面 | 行 id | 阶段 | 隐藏的知识 | 接触的缝 |
|---|---|---|---|---|
| 宿主 | `evimed-seam-probe` | P0 | 「本部署的 DSH 是否还是我们认识的那个」：缝存在、覆盖行生效、沙箱等级、版本一致 | `ctx.get`、`ctx.tools.register/execute`、`ctx.shell`、`ctx.agentPresets.list` |
| 宿主 | `evimed-evidence-store` | P2 | storageDomain 域的 schema 与投影：把 `planIndex / evidence / gateRuns` 投影成工作区 `.evimed-run/state.json`，控制面与前端只读该文件，不碰 DSH 存储格式 | `ctx.storageDomain.open`、`domain/changed`、`ctx.provide` |
| agent | `evimed-guidance` | P0 | 模型看到的编排指引：能力目录、契约种类摘要、检索优先级（胶囊/会话记忆 → 文献检索 → 网页检索）、引文卫生规则（原 `open-domain-answer`） | `ctx.systemPrompt.section`（order 100–199） |
| agent | `evimed-run-policy` | P0 骨架 / P1 门禁 / P2 预算 | 「一次运行何时算完成、何时可接受」这一整项知识：`evimed_plan`、`evimed_delegate`、`evimed_submit_deliverable`、`evimed_complete_run` 四个工具；题面与上下文的一次性注入；路径守卫；尝试上限；预算；子代理失败传播；`concludeTurn()` | `defineTool`、`tools/pre-execute`（仅策略）、`ctx.tools.guard`、`agent/pre-step`、`agent/turn-stopping`、`session/event`、`ctx.subagents.start`、`agent.inject`、`exec.concludeTurn` |
| agent | `evimed-evidence` | P2 | 证据台账的摄入与状态：`tools/result` 上观察 `mcp__evimed__*`，`queued → ready → verified / rejected / stale` 经 domain `transition()` | `tools/result`（observer） |
| agent | `evimed-capsule` | C1 | 记忆胶囊的运行时面：`evimed_capsule_recall` / `evimed_capsule_note`；把活动胶囊的方法经 `ctx.skills.register()` 注册为技能（从部署指定的只读目录读取，不经工作区） | `defineTool`、`ctx.skills.register` |
| agent | `evimed-review` | P2 | 语义审查者的组装：`evimed_review_run`（跨交付物冲突审查）以 `spawn` + 固定附加接地工具启动 | `ctx.subagents.start` |
| agent | `evimed-screening` | P2 | 批量筛选的组装知识（§10.2）：切片、并发上限、只读工具集、固定裁定 schema、CSV 台账——`evimed_screen_batch` 的宿主（v3.7 补：方案原文漏给该工具安排插件，执行时按知识切分单独成件是对的） | `defineTool`、`ctx.subagents.start` |

DSH 出厂行按 §9.2 的统一组合取舍。`evimed-budget`、`evimed-gate`、`evimed-orchestration`、`evimed-evidence-ingest`、`evimed-tool-policy` 等早期名字不再使用——它们的知识并入上表。

### 5.4 防腐层 `@evimed/harness-port`：有自己的类型词汇，不是改名表

D3 承诺「DSH 改名只改一处」，这只在 port **拥有形状**时成立。port 因此导出自己的 typedef 并做转换；插件只认这些类型，不读 DSH 原生对象字段，也不得在 JSDoc 里 `import('@deepseek-ai/...')`：

```js
// packages/harness-port/index.mjs（节选）
/** @typedef {{ callId: string, name: string, args: Record<string, unknown>, sessionId: string, signal: AbortSignal }} ToolCall */
/** @typedef {{ kind: 'completed'|'aborted'|'blocked'|'error'|'max-tokens'|'interrupted'|'unknown', code?: string }} TurnEnd */
/** @typedef {{ allow: true } | { allow: false, code: string, reason: string }} PolicyDecision */
/** @typedef {{ capability: string, prompt: string, tools: readonly string[], persona?: string, outputSchema: object }} SubagentRequest */

import { defineTool as dshDefineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { SEAMS } from './seam-manifest.json' with { type: 'json' }

export function defineTool(spec)                        { return dshDefineTool(toDshToolSpec(spec)) }        // 统一信封 {ok, code?, data?, issues?}
export function onToolPolicy(ctx, fn)                   { return ctx.on(SEAMS.events.toolPolicy, async (exec, next) => { const d = await fn(toToolCall(exec)); return d.allow ? next() : { kind: 'deny', reason: d.reason } }) }
export function onToolObserved(ctx, fn)                 { return ctx.on(SEAMS.events.toolObserved, (exec, result) => fn(toToolCall(exec), toToolOutcome(result))) }
export function onTurnEnd(ctx, fn)                      { return ctx.on(SEAMS.events.sessionEvent, (session, ev) => { if (ev.type === 'turn/end') fn(toSessionRef(session), toTurnEnd(ev)) }) }
export function onPreStep(ctx, fn)                      { return ctx.on(SEAMS.events.preStep, async (payload, next) => { const d = await fn(toStepInfo(payload)); return d.allow ? next() : { kind: 'reject', reason: d.reason } }) }
export function registerSection(ctx, section)           { return ctx.systemPrompt.section(section) }
export function injectContext(agent, text, plugin)      { return agent.inject({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } }) }
export function startSubagent(ctx, /** @type {SubagentRequest} */ req, parent, signal) { return ctx.subagents.start('spawn', toDshSubagentRequest(req, parent, signal)) }
export function openDomain(ctx, spec)                   { return ctx.storageDomain.open(defineDomain(spec)) }
export function readWorkspaceFile(ctx, path)            { /* 经 ctx.fs，不用 node:fs */ }
export function writeWorkspaceFile(ctx, path, text)     { /* 同上 */ }
export function toTurnEnd(ev) { const k = ev.data?.reason?.kind; return KNOWN_TURN_END.has(k) ? { kind: k, code: ev.data.reason.error?.code } : { kind: 'unknown', code: String(k) } }  // 未知值显式落码
export async function probeSeams(ctx, opts)             { /* §5.6 */ }
```

规则：每条缝恰好经**一个**导出进入（而不是「每个导出对应一条缝」）；事件名只在 `seam-manifest.json` 出现一次，插件不得写 `ctx.on('<字面量>')`；`toTurnEnd` 等转换函数是 §12.2 契约测试的断言对象；JSDoc 类型来自 port 自己的 typedef。

### 5.5 `seam-manifest.json`：唯一来源

```json
{
  "dsh": "0.1.1-rc.2",
  "services": { "required": ["tools", "systemPrompt", "agents", "sessions", "subagents", "agentPresets", "shell"], "optional": ["storageDomain", "skills"] },
  "events": { "toolPolicy": "tools/pre-execute", "toolWrap": "tools/execute", "toolObserved": "tools/result", "sessionEvent": "session/event", "preStep": "agent/pre-step", "turnStopping": "agent/turn-stopping" },
  "sessionEventTypes": ["turn/end", "tool/call", "tool/result", "assistant/message", "user/message", "subagent/descriptor", "agent-preset/selected"],
  "packages": { "@deepseek-ai/cordis": "peer", "@deepseek-ai/schemastery": "re-exported", "@deepseek-ai/dsh-tools": "dependency", "@deepseek-ai/dsh-storage-domain": "dependency", "@deepseek-ai/dsh-llm": "types-only", "@deepseek-ai/dsh-persona": "config-row", "@deepseek-ai/dsh-mcp-client": "config-row", "@deepseek-ai/dsh-agent-presets": "config-row" },
  "wire": { "unary": ["host.describe", "session.create", "session.prompt", "session.cancel", "session.history", "session.fork", "session.list", "subagent.list", "subagent.history", "skill.list", "agentPreset.list"], "respond": "/api/respond", "downlink": ["/api/events.mux", "/api/events.host"] }
}
```

从它派生、不得另写一份的东西：port 的导出集合、插件的 `inject` 常量（`inject ⊆ services.required ∪ services.optional`）、ESLint 白名单、启动自检的探测清单、§12.2 契约测试的方法清单、§6.4 的适配器方法白名单。`@deepseek-ai/schemastery` 由 port 重导出 `Schema`，插件不直接依赖它。`session.status` **不存在**于 apiproxy（`rpc-map.ts` 核实），运行状态来自 `events.host` 的 running-status 帧。

### 5.6 启动自检：门禁级崩溃、增强级降级

```js
// plugins/seam-probe.mjs — 伪代码
export const name = 'evimed-seam-probe'
export const inject = SEAMS.services.required                      // 由清单派生
export const Config = Schema.object({ requiredEnforcement: Schema.union(['full', 'partial']).default('full') })  // 托管 full；本地 macOS Seatbelt 可能只有 partial
export async function apply(ctx, config) {
  const fatal = []
  for (const key of SEAMS.services.required) if (!ctx.get(key)) fatal.push(`seam missing: ctx.${key}`)
  if (ctx.get('dshVersion')?.() !== SEAMS.dsh) fatal.push('dsh version ≠ seam-manifest.dsh')
  // 1. 全管线探测：注册探针工具，断言 policy 与 observed 两条缝都触发（事件改名会在这里显形，而不是静默失效）
  // 2. 覆盖行核对：llm-deepseek.baseURL 指向网关、tool-web / hmr / session-telemetry-otel 已 disabled、agent-presets 根含 evimed-universal
  // 3. 沙箱：经 ctx.shell 执行 `true`，enforcement ≥ config.requiredEnforcement（dsh:packages/sandbox/sandbox-local/src/index.ts:320 证实该字段）
  if (fatal.length) throw new Error('evimed: ' + fatal.join('; '))   // 门禁级：不启动
  for (const key of SEAMS.services.optional) if (!ctx.get(key)) ctx.get('evimedDiagnostics')?.degrade(key)  // 增强级：降级 + 具名计数 + /api/ready 可见
}
```

分级表：

| 级别 | 插件 / 缝 | 失效后 |
|---|---|---|
| 门禁级（fail-closed） | `seam-probe`、`run-policy`、`guidance`；`tools`、`systemPrompt`、`agents`、`sessions`、`subagents`、`agentPresets`、`shell` | 不启动；控制面 `/api/ready` 503 |
| 增强级（degrade + 可见） | `evidence`、`capsule`、`review`；`storageDomain`、`skills` | 运行继续，相应能力关闭，具名计数器与 `qualityNotices` 标注「本次未启用 X」 |

---

## 6. 托管拓扑与接线

### 6.1 拓扑

```text
浏览器 ── HTTPS ──► Caddy ──► apps/server（控制面：OIDC、项目、账本、路由、门禁、三网关、SSE 给浏览器）
                                  │  unix socket（socat 桥）+ 方法白名单
                                  ▼
                    每项目一个 runtime 容器（deploy/runtime-dsh 镜像，Docker 网络策略：只能到 /internal/* 网关）
                    ┌──────────────────────────────────────────────────────────────┐
                    │ dsh web --no-open --port 4096（127.0.0.1）                    │
                    │   profile evimed-runtime = dsh-base + dsh-web-app + @evimed/dsh-socket │
                    │   ├─ 宿主面：seam-probe、evidence-store、mcp-evimed(python3 server.py)  │
                    │   ├─ agent 面：preset evimed-universal（persona/guidance/orchestration/gate/ingest）│
                    │   ├─ 沙箱：bwrap/Landlock workspace-write（容器内二次限制）              │
                    │   └─ 会话日志：$DSH_HOME=/runtime/dsh-home（项目数据卷）                 │
                    │ socat UNIX-LISTEN:/runtime/control/dsh.sock → TCP:127.0.0.1:4096        │
                    └──────────────────────────────────────────────────────────────┘
                                  │ HTTPS（服务端持钥）
                                  ▼
              /internal/model/v1（DeepSeek）、/internal/sources/v1（DOI/Unpaywall/公共源）、/internal/search/v1（SearXNG）
```

与今天的差别只有一处：容器里跑的是 `dsh web` 而不是 `opencode serve`；`open-science-opencode-serve.sh` 的 socat 模式原样沿用。

### 6.2 接线方式的选择

| 方案 | 能力 | 缺口 | 结论 |
|---|---|---|---|
| **A. Web 宿主 API**（`POST /api/<method>` + WebSocket `/api/events.mux`、`/api/events.host`，52 个一元方法，`dsh:packages/host/apiproxy/src/api/rpc-map.ts:24-76`） | `session.create{cwd, agentPreset}` / `prompt` / `cancel` / `history` / `fork` / `list`、`subagent.*`、审批 `POST /api/respond`、`GET /api/session.export` | 线协议只在仓库内文档化、无版本字段（「client and host ship together」）；单用户（一进程一项目正好）；`--host` 只能 127.0.0.1（容器内无妨） | **P0 采用**。功能最全，形状与今天的 OpenCode HTTP+SSE 最接近 |
| B. stdio JSON-RPC SDK（`@deepseek-ai/dsh-sdk-client`，`dsh:packages/sdk/protocol/src/types.ts:92-105`） | `initialize` / `session/prompt` / `shutdown`；`session.event` 全量流 | **无 preset 选择、无取消、无审批、无 resume/fork/list**；取消 = 杀进程 | 不满足专科运行的取消与预设需求 |
| C. ACP（`@deepseek-ai/dsh-acp`） | 多会话、取消、`session/request_permission` | 只回传已提交文本（无工具活动、无流式增量）；`mcpServers` 必须为空 | 不满足 UI 的工具活动展示 |
| D. 自写协议驱动插件（cookbook「external protocol driver」模式，`inject = ['agents','sessions','sessionPersistence']`） | 我们定义并版本化线协议，只暴露需要的 8 个方法 | 需重写 apiproxy 已做的冷恢复、所有权栅栏、单飞等细节；接触面转移到 `ctx.agents`/`ctx.agentPresets.mount`/`ctx.approval` | **P2 的对冲方案**：若 A 的线协议在两次升级内变动超过一次，切换到 D |

### 6.3 容器与 profile

- 镜像 `deploy/runtime-dsh/Dockerfile`：沿用 `runtime-opencode` 的 Debian + uv + R + chromium + 科学栈 + curated skills 烟测；去掉 OpenCode；加 Node 22（`^22.19.0`）、`npm i -g @deepseek-ai/dsh@<精确版>`（sha512 校验 `npm pack` 的 integrity）、`@evimed/dsh-bundle` tarball、`/opt/evimed/mcp/`、`/opt/evimed/dsh/presets/`、`/opt/evimed/skills/`。
- `$DSH_HOME=/runtime/dsh-home`（项目数据卷）：`profiles/evimed-runtime/package.json`（`dsh.profile.bundles = [dsh-base, dsh-web-app, @evimed/dsh-socket]`，镜像构建时用 `dsh plugin --profile evimed-runtime add` 预初始化，运行期只读）、`profiles/evimed-runtime/cordis.patch.yml`（**控制面每次启动生成**，§6.5）、`sessions/`、`attachments/`、`storages/`。
- 启动脚本 `open-science-dsh-serve.sh`：`DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=workspace-write dsh --profile evimed-runtime web --no-open --port 4096 --trusted-host evimed-runtime` + socat 桥；退出码语义照旧。
- 环境注入（与今天相同的变量名）：`EVIMED_MODEL_GATEWAY_URL`、`EVIMED_WORKLOAD_TOKEN_FILE`、`EVIMED_PUBLIC_SOURCE_GATEWAY_URL`、`EVIMED_WEB_SEARCH_GATEWAY_URL`、`EVIMED_*_URL`（专科适配器）。**`DEEPSEEK_API_KEY` 不注入**。

### 6.4 控制面适配器 `DshRuntimeAdapter`

`AgentRunStore` 对运行时只依赖四个注入函数 + `dispatchPrompt`（`server.mjs:385-387`）。新适配器实现这五件事，并在 `RuntimeManager` 里按 `OPEN_SCIENCE_RUNTIME_KERNEL=opencode | dsh`（P0–P1 并存，P2 删除 `opencode`）选择：

| 控制面需要 | OpenCode（今天） | DSH（方案 A） |
|---|---|---|
| 创建会话 | `POST /session` + 每轮 `agent` 字段钉专科身份 | `session.create{cwd, agentPreset: 'evimed-universal'}`；不再有按线路的身份，能力身份落在委派出的子代理上（persona + toolFilter）；`researchSessions` 记录组合 id + bundleVersion |
| 派发 | `POST /session/:id/prompt_async`（`text` + `system` + `agent`） | `session.prompt{sessionId, mode: 'queue', content: PromptContentPart[]}`（返回入队回执）。**没有 `system` 参数**：今天经 `prepareResearchContext` 生成、以 `system` 发送的研究上下文（知识库切片 + 记忆 + 能力目录）改由控制面在派发前写入工作区 `.evimed-brief/context.md`，插头在 `agent/session-start` 读取并 `agent.inject()` 成一等 `user/message`（模型可见 ⟺ 已记录，`<evimed-knowledge>` / `<evimed-memory>` 包裹规则照旧） |
| 读历史（门禁用） | `GET /session/:id/message` | `session.history` → 归一化（下表） |
| 读状态（监控用） | `sessionStatus` | `events.host` 的 running-status 帧（`session.status` 方法**不存在**，`rpc-map.ts` 核实）+ `.evimed-run/state.json` 的子代理活动；500 ms 轮询 `session.history` 作兜底 |
| 取消 | `POST /session/:id/abort` | `session.cancel{sessionId}` |
| 图片输入 | （无） | `PromptContentPart{type:'image'}` → 适配器上传到 `{baseURL}/files`，我们的网关没有该端点且适配器无 404 回退 ⇒ **P0 托管文本-only**；P2 网关透传 `/files`（体积上限、按项目计量）或插头在 `agent/request` 改写为 `image_url` 内联 |
| 浏览器实时流 | `/api/opencode/:projectId/*` SSE 直通 | 控制面订阅 `/api/events.mux`，归一化后经**控制面自己的** `GET /api/runs/:id/events`（SSE）转发给浏览器；直通路由删除 |
| 方法白名单 | `isAllowedRuntimeProxyRoute` | 由 `seam-manifest.wire.unary` 派生：`host.describe`、`session.{create,prompt,cancel,history,fork,list}`、`subagent.{list,history}`、`skill.list`、`agentPreset.list`；**拒绝** `settings.*`、`credentials.*`、`host.{pickDirectory,openPath,…}`、`workspace.*`、`session.selectModel`、`goal.*`（P3 GEO 需要时再加） |

消息形状归一化（`agentRuns.mjs` 读的是 OpenCode 形状：`message.info.role`、`parts[].type === "tool"`、`part.state.{status,input,output}`、`part.tool`）：

| DSH 持久事件 | 归一化为 |
|---|---|
| `user/message` | `{info:{role:'user'}, parts:[{type:'text', text}]}` |
| `assistant/message`（含 `usage`、`interrupted?`） | `{info:{role:'assistant', error?}, parts:[text…]}` |
| `tool/call{callId, name, arguments}` + 对应 `tool/result{message, error?, meta?}` | `parts[{type:'tool', tool: name, state:{status: error ? 'error' : 'completed', input: JSON.parse(arguments), output}}]` |
| `turn/end{reason.kind}`（实际枚举 `completed / aborted{reason} / blocked / error{error} / max-tokens / interrupted`，`dsh:packages/core/session/src/types.ts:155-171`） | `completed → succeeded`；`aborted → runtime_canceled`；`blocked → runtime_tool_error`（子码 `turn_blocked`）；`error → runtime_session_error`；`max-tokens → runtime_session_error`（子码 `model_max_tokens`）；`interrupted` → 由冷加载补记，视为 `runtime_stopped` |

适配器把它归一化为 `@evimed/domain` 的 `RunTranscript`（不再是 OpenCode 形状，§14 规则 5）；`agentRuns.mjs` 改读新类型，并顺手修掉 `REQUEST_PATH` S4–S6（读历史/状态失败 ≠ 无进展，落 `runtime_history_unavailable` 并计数）；`terminalFromMessages`、`recordProgress` 的语义不变，进展信号加入子代理活动（§7.5）。

### 6.5 控制面生成的 profile patch（每次启动运行时）

```yaml
# /runtime/dsh-home/profiles/evimed-runtime/cordis.patch.yml — 由 runtimeManager 生成，0o600
- id: llm-deepseek
  config:
    baseURL: https://open-science-web:8787/internal/model/v1       # 控制面生成时写字面值，不用 !!js（§14 规则 25）
    apiKeyEnv: EVIMED_WORKLOAD_TOKEN                              # 引用名；值在 $DSH_HOME/.credentials.yaml 的 refs:（热重载，每 150 s 原子重写）
    thinking: enabled
    reasoningEffort: high
    models: [{ id: deepseek-v4-pro, contextWindow: 1000000 }]
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-v4-pro }
- id: session-telemetry-otel
  disabled: true
- id: session-persistence-jsonl
  config: { root: /runtime/dsh-home/sessions }
- id: mcp-evimed
  config:
    serverName: evimed
    transport:
      type: stdio
      command: python3
      args: ['/opt/evimed/mcp/evimed-research/server.py']
      env:
        EVIMED_PUBLIC_SOURCE_GATEWAY_URL: https://open-science-web:8787/internal/sources/v1   # 字面值
        EVIMED_WORKLOAD_TOKEN_FILE: /runtime/secrets/workload-token
        # … 与今天 opencode.json 里 allowlisted 的同一组键
```

`apiKeyEnv` 是引用名，值放在 `$DSH_HOME/.credentials.yaml` 的 `refs:`（0600、热重载、每请求解析）；控制面每 150 s 原子重写该文件，令牌刷新无需重启（V2 已定）。生成的 patch 一律写字面值，不用 `!!js`。

### 6.6 超时与可靠性映射

沿用 `REQUEST_PATH.md` §4 的表，只换被代理的一侧：`dispatchPrompt` 120 s 总时限不变；`session.history` 读取与 `events.host` 订阅**加上**超时（今天是无超时，S2/S4/S5 静默点的根源之一）；模型网关 300 s 空闲超时与 `llm-deepseek.streamIdleTimeoutMs`（默认 5 分钟）对齐；run monitor 的「进展」定义不变。`turn/end.reason.kind === 'max-tokens'` 是 OpenCode 没有、DSH 有的终态，账本新增一个子码。

### 6.7 对冲：自写驱动插件 D 的最小规格

若采用 D，线协议由我们定义并冻结为 `evimed-control/v1`（NDJSON over unix socket）：`session.create{preset, cwd, sessionId}`、`session.prompt`、`session.cancel`、`session.resume`、`session.fork`、`session.history`、`approval.respond`、`events.subscribe{sessionId}`；实现依赖 `ctx.agents.create/resume/get`、`ctx.agentPresets.mount`（只能在 agent factory 的 `setup()` 钩子里调用）、`ctx.approval`、`session/event`。不在 P0 实现，只在 §12 的矩阵里观察 A 的线协议变动频率。

### 6.8 本地形态 `evimed-web`（替代 Tauri）

`dsh plugin --profile evimed-web add ./evimed-dsh-socket.tgz` 后 `dsh --profile evimed-web web`：同一个插座，插在 DSH 自带的 Web 壳上；模型直连 DeepSeek（用户自己的 key 走 `$DSH_HOME/.credentials.yaml`）、MCP 直连公共源（无网关，凭据用 `.env`）、审批 `ask`。这是上位方案「桌面可选」的新实现，零前端代码。

---

## 7. 任务状态与事件


**「科研者桌面」推荐组（2026-08-25，生态一期第 3 项）**。本地面能做而托管面做不到的，不是"更快"或"更便宜"，是**连接用户自己已有的桌面软件**——托管容器里没有他的 Origin、他的 Stata、他的 Zotero 库、他的 Overleaf 项目。这是白捡的差异化，一条也不需要我们实现：

| 装什么 | 连的是用户自己的什么 | 来源 |
|---|---|---|
| `Fantasality/dsh-origin-plugin` | 本机 OriginLab（写数据、画图、导 PNG/SVG） | 医学科研用户的作图刚需 |
| `ZihaoVistonWang/Stata-AI-Skill` | 本机 Stata（回归、do 文件） | 流行病学/卫生经济常用 |
| `Hongcheng-LI/dsh-zotero` | 本地 Zotero API（检索库、读附件全文、生成引文） | 同时是 §26 分析层连接器的现成一员 |
| `fly233338/dsh-overleaf` | 用户的 Overleaf 项目 | 与 `dsh-cite` 的 GB/T 7714 配套 |
| `dsh-market` / `Dariandai/dsh-starter-pack` | 一键装上面这些 | 让"推荐组"是一条命令而不是一页文档 |

托管面**一条都不装**：它们要么需要本机软件，要么要出网到用户账号，两者托管面都给不了。这条分界本身是产品线的说明——本地面不是托管面的降级版，是它够不着的那一半。


### 7.1 状态（权威在控制面账本）与计划（权威在工作区）

```text
reserved ─► dispatched ─► running ─┬─► delivering ─┬─► accepted
                                   │               ├─► degraded   （verification: unverified | unchecked；含 partial 交付）
                                   │               └─► repairing(n ≤ deliveryAttemptLimit) ─► running
                                   ├─► failed      （runtime_* / specialist_* 错误码）
                                   └─► canceled
```

- `reserved → dispatched → running`：今天的 `reserveRun → markDispatch → progress`。
- `delivering`：终态为 `completed` 且 **`task-plan.json` 含 ≥ 1 交付物**时触发 `reconcileSession`（不再依赖 `effectiveAgentId`）。
- `repairing`：仅重派 `rejected` 的交付物（修复指令携带 `deliverableIds`），次数上限是控制面 `deliveryAttemptLimit` 这一个旋钮，经 profile patch 派生给插座。
- **计划 = `task-plan.json`，全文唯一的计划产物**（工作区文件是 §2.2 定下的权威形态）：`{ revision, clarifications[], deliverables[{ id, contractKind, capability, title, dependsOn[] }], reason? }`。`clarifications[]` 必须非空——写下问过的问题或显式假设（Apodex 的 clarify 是必经节点；托管面 `ask_user_question` 默认禁用时就写假设）；`deliverables: []` 须带 `reason`（纯问答）。DSH 的 `tool-todo` 不挂，避免第二个计划面。
- 与 Apodex 脚手架的对应：**clarify** = 题面 + `evimed_plan.clarifications`，**solve** = 委派与综合，**verify** = 插座门禁（每件产物 + 完成时）+ 服务端外部门禁，**report** = 永远产出 `delivery-summary.md`（§8.1）。

**不做的事**：不把这些状态写成 DSH 会话事件（D6）；不建任务队列。

#### 7.1.1 公开 `status` 与投影 `phase`（2026-08-24 裁决，两套词汇并存的终结）

执行中发现账本的公开 `status` 只有四值（`running / succeeded / failed / canceled`，外加 `verification` 三值、`errorCode`、`attempts`），而 domain 定义了上图九态。裁决：**不改公开 API，九态是投影**——这正是 §1.3 「状态机是事件投影，不是流程脚本」的字面含义。

- `status`（账本自有词汇，四值）继续是 `/api/runs` 与 `run/state` 帧里的 `state`，前端 `runIsSettled` 按它判终态；5 个评测 / 发布门禁脚本与 e2e 不动；历史 `runs.jsonl` 不迁移。
- 九态改名为 **`RUN_PHASES`**（`TERMINAL_RUN_PHASES` 同理），由 `@evimed/domain` 的**一个纯函数** `runPhase(record)` 从折叠结果（`status / dispatchStatus / attempts / verification / partial / errorCode / 是否有进展事件`）派生，**不存储**；`/api/runs` 条目与 `run/state` 帧增加 `phase` 字段；前端「待人工复核」分组 = `phase === 'degraded'`。
- `transition()` 的 `run` 表保留为**合法相序**：折叠时对相邻 phase 断言，非法相序落 `illegal_state_transition` 计数并写 notice，**不抛**（历史数据不能让读取崩溃）。
- 映射（唯一定义在 `runPhase` 及其穷举测试）：

| 折叠字段 | `phase` |
|---|---|
| `running` ∧ `dispatchStatus = dispatching` ∧ 无进展事件 | `reserved` |
| `running` ∧ `dispatchStatus = accepted` ∧ 无进展事件 | `dispatched` |
| `running` ∧ 有进展事件 | `running` |
| `running` ∧ 内核回合已终结 ∧ 服务端核对未折叠 | `delivering`（瞬态） |
| `running` ∧ 最近事件为交付物被退回 ∧ 修复派发未确认 | `repairing` |
| `succeeded` ∧ `verification ∈ {null, verified}` ∧ 非 `partial` | `accepted` |
| `succeeded` ∧ (`verification ∈ {unverified, unchecked}` ∨ `partial`) | `degraded` |
| `failed` | `failed` |
| `canceled` | `canceled` |

- 连带的账本语义修正（与 §3.1 的账本四件事一起做，不是改名）：插座以 `evimed_complete_run{partial: true}` 交付时，账本写 `succeeded` + `partial: true` + `verification: unchecked`（→ `degraded`），**不再写** `failed{specialist_evidence_repair_failed}`；`failed` 只留给运行时 / 专科硬失败（§7.5「次数用尽 → degraded 而非 failed」）。
- 规则 7「状态只有一个写入者」的适用范围据此明确：domain 三张表（planIndex / evidence / gateRuns）与 `phase` 投影经 `transition()`；账本的四值 `status` 是账本自己的折叠逻辑写的，不经 `transition()`。

### 7.2 运行侧镜像：`storageDomain` 域 `evimed_run@1`

```js
export const EVIMED_RUN_DOMAIN = {
  name: 'evimed-run', version: 1,
  tables: {
    runMirror:  { /* runId → {sessionId, bundleVersion, domainVersion, briefDigest, attempts, budget:{steps,tokens,children}, lastTurnEnd?} */ },
    planIndex:  { /* runId → {revision, items:[{id, status, childSessionId?, receiptDigest?}]}  ← task-plan.json 的索引，不是第二份计划 */ },
    evidence:   { /* evidenceId → {runId, tool, query, sourceId, doi?, artifactPath?, digest, status: 'queued'|'ready'|'verified'|'rejected'|'stale', recordedAt} */ },
    gateRuns:   { /* `${runId}:${n}` → {contractKind, issues:[{code, message, line?}], metrics:{citationCoverage, confidenceMix, disputedShare, unresolved}, ok, at} */ },
  },
}
```

- 没有 `claims` 表：claim ↔ 来源的绑定就是 `clinical-evidence-matrix.json`，不复制。
- 每张表的 `status` 只有一个写入者：`@evimed/domain` 的 `transition(table, from, event)`；非法转换抛错。
- `evimed-evidence-store` 监听 `domain/changed`，把三张表投影成工作区 **`.evimed-run/state.json`**；控制面与前端只读这个文件，不读 `$DSH_HOME/storages/`（DSH 存储格式无兼容承诺）。
- 后端选 `@deepseek-ai/dsh-storage-json`：可读、随项目卷备份；JSON 与 SQLite 后端都不支持多进程写，这不是选择理由。
- 运行 id 经 `.evimed-brief/index.json` 进入容器；子代理从父代理的 `runMirror` 继承。

### 7.3 证据池与异步协调

- **写入**：`evimed-evidence` 在 `tools/result`（observer，失败隔离 + 具名计数）上观察 `mcp__evimed__*` 的结构化结果：来源记为 `queued`；全文/官方页落盘 `.evimed-sources/<digest>.md` 后 `ready`；服务端门禁核对后 `verified`；`queued` 超过 `evidenceStaleMinutes` 未 `ready` → `stale`（计入未决数）；`rejected` 时给依赖它的 claims 打 `verification: unverified`（经 `state.json` 通知控制面）。
- **异步**：子代理以 `tool-subagent{backgroundMode: continuable}` 运行；`tool-subagent-report{reportDelivery}` 是**部署级策略**（模型不能按调用选择 `quiet` / `next-step`），托管取 `quiet`；子代理结算通知无条件送达并唤醒空闲父代理，所以父代理按自己的节奏综合、不会卡死。这就是 Apodex 的报告池：状态表 = `planIndex`，主 agent 经 `evimed_plan{action:'status'}` 读取。
- **图**：supports 边在 matrix（direct / synthesized / derived + `supportingSources`），`contradicts` 边由 P2 的 `evimed_review_run` 产出；「每个 Claim 至少一条 supports 边」就是现有 `evidenceClaimsTraceable`；可选结构字段 `statistic{effect, ci, n}` 启用机械一致性检查。

### 7.4 插座监听的缝（类别：observer 永不阻断；middleware 可拒绝）

| 缝 | 类别 | 插件 | 行为 |
|---|---|---|---|
| `agent/pre-step`（首次） | middleware | `run-policy` | 根/子判定（日志无 `subagent/descriptor` 即根）；根代理：一次性 `inject` `.evimed-brief/`（题面摘要 + context.md + 胶囊画像 + 工作方式包）并在 `runMirror` 建行——全文只有这一处注入；子代理：核对委派记录 |
| `agent/pre-step`（每次） | middleware | `run-policy` | 运行预算：按 `assistant/message.usage` 累计 token、步数、子代理数，超限 `reject` 并 `inject` 说明（DSH 自带 guard 只有超时与重复提醒） |
| `tools/pre-execute` | middleware | `run-policy` | 只做**策略**：`write / edit / bash` 触及 `.evimed-brief/**`、`.evimed-run/**`、`delivery-receipt.json` 一律拒绝；尝试上限用 `ctx.tools.guard`。**业务裁定不走这里**（§8.1） |
| `tools/execute` | middleware | `run-policy` | 包裹 `mcp__evimed__*`：`recoverableEvidenceSourceErrorCodes` 在运行内退避重试一次，不让一次源故障变成运行失败 |
| `tools/result` | observer | `evidence` | 写证据表；失败隔离，计数器 `evimed_evidence_ingest_failures_total` |
| `session/event: turn/end` | observer | `run-policy` | 根会话：对最终助手消息跑安全内容触发器（直接回答也过扫描），命中写 notice + `verification: unchecked`；子会话：`reason.kind !== 'completed'` → `planIndex` 项置 `failed{code}`，`next-step` 唤醒父代理；未知 kind 落 `runtime_turn_end_unknown` 并计数 |
| `agent/turn-stopping` | middleware | `run-policy` | 计划含交付物而回合内未 `complete_run` 时，**最多一次** `steer` 再推一步；`steer` 自身异常按 §14 规则 18 隔离 |

### 7.5 可靠执行保障

| 需求 | 谁管 | 机制 |
|---|---|---|
| 进程崩溃恢复 | DSH | 冷加载补记 `interrupted`，`inspect()` 只读重建 |
| 逻辑卡死 | 控制面 | 停滞阈值的「进展」信号 = 根会话消息/工具计数 **+ 子代理活动**（`events.host` 的 running-status 与 `state.json` 的子代理步数）——否则根代理委派后空闲 20 分钟会被误判停滞 |
| 业务级重试 | 控制面 + 插座 | 修复回环只重派 `rejected` 交付物；`deliveryAttemptLimit` 单旋钮；子代理结算非 `completed` 时 `evimed_delegate` 自动重派一次（带诊断），再失败标 `failed` |
| 结果质量 | §8 | — |
| 依赖关系 | `run-policy` | `evimed_delegate{dependsOn}`：依赖项未 `accepted` 时排队，不让模型写 workflow 脚本串联交付物 |
| 成本账 | `run-policy` + 控制面 | 预算终值写入账本 `finished` 事件，供配额与计费 |
| 部分交付 | `run-policy` | 次数用尽时 `evimed_complete_run{partial: true}` 仍写 `delivery-summary.md`，服务端置 `degraded` 而非 `failed` |

---

## 8. 质量守卫

### 8.1 第 0 层：运行侧硬门（`run-policy`，机械、阻断、裁定是值）

交付只有一条通道：`evimed_submit_deliverable`。它**正常返回**裁定，不经 `deny`——首次提交不通过是常态，不是异常（Ousterhout ch.10）；`evimed_preflight` 因此不存在。

```js
// plugins/run-policy.mjs — 伪代码（工具统一信封 {ok, code?, data?, issues?}）
registerTool(ctx, defineTool({
  name: 'evimed_submit_deliverable',
  parameters: { deliverableId: { type: 'string', required: true } },         // contractKind 由 task-plan.json 派生，不让调用者传
  async execute({ deliverableId }, call) {
    const item = planIndex.get(call.runId, deliverableId)
    const verdict = runGate(workspaceOf(call), item.contractKind, `deliverables/${deliverableId}/`, { brief: readBriefCopy(call) })
    recordGateRun(call.runId, verdict)                                        // 含四个 Apodex 指标（notice）
    if (!verdict.ok) return { ok: false, code: 'deliverable_rejected', issues: layered(verdict.issues) }   // 必修 / 建议 / 可选
    const receipt = writeDeliveryReceipt(call, deliverableId, item.contractKind)                          // sha256 + bundle/domain 版本；唯一写入者
    transition('planIndex', item, 'accepted')
    return { ok: true, data: receipt }
  },
}))
registerTool(ctx, defineTool({
  name: 'evimed_complete_run',
  parameters: { partial: { type: 'boolean', required: false } },             // 仅此一处允许布尔：它是终结语义而非开关
  async execute({ partial }, call) {
    const plan = readPlan(call); const issues = []
    if (!plan.clarifications.length) issues.push(code('plan_missing_clarifications'))
    for (const d of plan.deliverables) if (!planIndex.isAccepted(d.id)) issues.push(code('deliverable_not_accepted', d.id))
    issues.push(...contentTriggers(scanAllArtifactsAndFinalReply(call)))    // 安全触发器：同一份 @evimed/domain 规则以扫描模式运行
    writeDeliverySummary(call, plan, issues)                                 // 永远产出（Apodex 的 report 节点）
    if (issues.length && !partial) return { ok: false, code: 'run_incomplete', issues }
    concludeTurn(call)
    return { ok: true, data: { partial: Boolean(partial), issues } }
  },
}))
guardTools(ctx, call => call.name === 'evimed_submit_deliverable' && attemptsOf(call) > config.deliveryAttemptLimit ? 'attempt limit reached; call evimed_complete_run{partial:true}' : undefined)
```

- `runGate(workspace, contractKind, dir, …)` 按契约种类查 `@evimed/domain` 的注册表：`clinical-evidence-report` → `validateClinicalEvidencePackage`（同一份代码），其他种类各自的校验器（新增种类 = 在 domain 增加一个校验器，这是代码改动，D10 据此修正）；输入只认 `deliverables/<id>/` 下的文件 + 题面只读副本。
- **四个验证门指标**（Apodex §5.3）从 matrix / ledger 机械计算并写进 `gateRuns.metrics`：引用覆盖率、`synthesized` 置信分布、争议占比（P2 起）、未决数（含 `stale` 证据）；另加时效性 notice（引文最新年份、指南版本）。先作 notice，阈值进配置后再决定是否阻断。
- 路径守卫（§7.4）保证题面副本、回执、状态投影不可被模型改写。

### 8.2 第 1 层：服务端外部门禁（机械、阻断、独立）

`reconcileSession` 保持外部独立。改动：
1. 多交付物：一次运行产生多份包，`validateClinicalEvidencePackage` 与产物取回按 `deliverables/<id>/` 逐件运行——这是 P1 的结构性改动，不是小修。
2. 回执：每件产物的 sha256 必须与取回的文件一致；回执里的 `bundleVersion` / `domainVersion` 必须等于镜像声明。
3. 题面只认服务端那一份；工作区副本不一致即报。
4. 期望检查（分类器对题面给出期望契约种类）作为**输入**进入题面逐问核对，不再单独触发修复回合。
5. 没有计划的运行（直接回答）：对最终回复跑引文卫生 + 安全触发器扫描。
6. 语义审查只在控制面一处：`coverageJudge` 异步跑（不占请求路径）。
7. 撤稿机械检查（P1）：MCP 解析 DOI / PMID 时查 Crossref `update-to` 与 PubMed `Retracted Publication`，结果写 `citation-ledger.csv`，命中即阻断——现状只核验文本是否「提到」撤稿检查。

### 8.3 第 2 层：语义审查（模型判、代码核、不阻断）

`evimed_review_run`（P2，`evimed-review` 插件）：一个 `spawn` 子代理（**全新上下文**），`toolFilter` = 只读文件工具 + `mcp__evimed__*` 检索 + **固定附加**推理者没用过的接地工具（`web_search`、官方页），`outputSchema` 固定为裁定数组；对同一实体跨 `deliverables/*` 的 claims 做冲突审查（产出 `contradicts` 边）、抽样事实核查（只接受 MCP 解析结果）、草稿审查（复用 `coverageJudge` 的 12 条核验规则）。结果经 `inject` 作为建议，写 `qualityNotices`，**不改 `status`**（§4.2：实测精度不支持阻断）。


> **生态借鉴（2026-08-25，一期第 4 项）**：`LeslieWylie/review-workflow` 用 N 个隔离子代理**盲评**再由主席合议。我们的 rubric 是护城河、不换；可借的是**隔离**——同一份稿子分给互不可见的几路评审，比一路评审多轮自查更能撞出分歧。落到本层的做法：`evimed_review_run` 的多视角评审改为各自独立会话（互不见彼此结论），分歧本身作为一条输出，不做合议裁决（本层不阻断）。`tetckx/deep-structural-analysis` 已作为技能收进 `skills/community/`，正是"额外视角"的现成来源。

### 8.4 回环

- 回合内：`agent/turn-stopping` 最多 `steer` 一次。
- 跨回合：控制面 `repairing`，只重派 `rejected` 交付物，指令分层（必修 / 建议 / 可选）。
- 用尽：`partial` 交付 + `delivery-summary.md` + `degraded` 状态 + 进入「待人工复核」列表（RunsPage）。
- 唯一旋钮：`deliveryAttemptLimit`（控制面 `config.mjs`）。

### 8.5 单实现不变式

服务端与插座 import 同一版本的 `@evimed/domain`：回执携带 `domainVersion`，不等即 `specialist_contract_unavailable`；`clinicalEvidencePreflightAgreement.test.mjs` 改为断言两侧解析到同一入口。`preflight.py` 删除（§16 #2）。

---

## 9. 统一编排：计划 → 委派 → 按契约交付（取代 Mode Router 与产品线 preset）

### 9.1 为什么不分模式

用户的例子：「分析若干个语义问题的证据现状」——它既可以是多篇综述，也可以是 GEO 优化前的提案环节，做完还可能接一句「基于这个做临床决策辅助」。输入分类在这里必然出错；而 DSH 的 preset 不能中途换（§2.3.4），错一次就错一整个会话。

两个事实决定方向：

1. **输入只能猜，产出可以查。** 题面是一句话，产物是文件。给一句话贴标签要靠正则或分类器；给一份产物套契约只需要看它声明了什么、写了什么。我们 8 月在门禁上的所有进展都来自「检查产出」，没有一次来自「猜测输入」。
2. **组合是模型的工作，不是路由器的工作。** 上位方案已说「入口只决定绑定哪个包」；v2 连这层绑定也交给模型：看到题面，决定需要哪些交付物、委派给哪些能力、并行还是串行、要不要追问。

于是 v2 只有三条规则：

- **一个会话一个组合**：`evimed-universal`，所有会话都用它，没有第二个。
- **能力不是模式，是清单**：每项能力一份清单（由 `agent.yaml` 演化），模型在一次运行里想组合几个就组合几个；新能力 = 新清单，编排器自动看见。
- **契约绑产出，不绑输入**：交付物提交时声明契约种类，按契约种类校验；安全类内容触发器兜底；运行完成时核对计划履约。

### 9.2 统一组合 `evimed-universal`

```yaml
# presets/evimed-universal/agent.cordis.yml — 所有会话共用；托管与本地的差异只在 profile patch 与环境变量
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      你是 EviMed 的医学研究助手，基于 {{model}} 模型，工作目录 {{cwd}}。你具备广泛的医学知识。
      简单问题直接回答；需要交付物的任务，先用 evimed_plan 写下计划（含澄清或假设），把专业工作用 evimed_delegate
      委派给能力目录中的能力，综合后用 evimed_complete_run 交付。检索顺序：先查记忆与胶囊，再查文献，最后查网页。
      所有事实性主张尽量附文献依据；不编造文献；不提供具体诊疗建议。
- id: evimed-guidance
  name: '@evimed/dsh-socket/plugins/guidance'
- id: evimed-run-policy
  name: '@evimed/dsh-socket/plugins/run-policy'
  config: { hosted: !!js process.env.EVIMED_HOSTED === '1' }     # 其余上限由 profile patch 派生（§14 规则 11）
- id: evimed-evidence
  name: '@evimed/dsh-socket/plugins/evidence'
- id: evimed-capsule
  name: '@evimed/dsh-socket/plugins/capsule'
  config: { methodsDir: !!js process.env.EVIMED_CAPSULE_METHODS_DIR }   # 部署指定的只读目录，不在工作区
- id: evimed-review
  name: '@evimed/dsh-socket/plugins/review'
  disabled: !!js process.env.EVIMED_REVIEW_ENABLED !== '1'      # P2 起启用
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false                                   # 关闭项目根 .dsh/skills、.agents/skills 的自动发现：工作区可被上传文件污染
    customSkillDirs: ['./skills/core', './skills/curated-scientific', './skills/office', './skills/community']   # 随 preset 发行，相对 preset 目录解析；community = 生态技能包原样收录（§21.8）
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  disabled: !!js process.env.EVIMED_HOSTED === '1' && process.env.EVIMED_ASK_USER !== '1'   # 托管默认禁用、可开
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - { id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic' }
    - { id: tool-result-pruner, name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } }
- id: delegation
  name: cordis:group
  group: true
  isolate: { workflowEngine: true }
  config:
    - { id: tool-subagent, name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: spawn, toolName: subagent, backgroundMode: continuable } }
    - { id: tool-subagent-control, name: '@deepseek-ai/dsh-tool-subagent-control' }
    - { id: tool-subagent-report, name: '@deepseek-ai/dsh-tool-subagent-report', config: { reportDelivery: quiet } }
    - { id: workflow-worker-thread, name: '@deepseek-ai/dsh-workflow-worker-thread', config: { provider: spawn } }
    - { id: tool-workflow, name: '@deepseek-ai/dsh-tool-workflow' }
# 不挂：tool-todo（计划只有 task-plan.json 一个面）、agent-instructions（工作区文件不得成为指令）、str_replace_editor、tool-web、
#       plan-mode、tool-ralph、tool-lsp、code-runtime；能力正文不进 customSkillDirs（由 evimed_delegate 预注入子代理，避免模型绕过委派）
```

### 9.3 能力清单（capability manifest）

`agent.yaml` **改名**为 `capability.yaml`，仍是唯一的能力定义（上位方案第 5 条不变，字段增加）；构建时由生成器校验，不生成第二份文件：

| 字段 | 来源 | 用途 |
|---|---|---|
| `id`、`title`、`description`、`version` | 原有 | 目录展示；`description` 一行进编排器的能力目录 |
| `whenToUse` | 新增 | 一句「何时委派给我」 |
| `skills[]` | 原 `skill` + `companionSkills` | 委派时预注入子代理首条上下文（`skillsLoaded` 由构造保证） |
| `tools[]` | 原 `requiredTools ∪ optionalTools` | 子代理的 `toolFilter.allow`；构建时对 MCP `tools/list` 校验，不存在即失败 |
| `persona` | 新增 | 子代理 persona |
| `produces[]` | 原 `outputs` + `completionChecks`，按契约种类分组 | 契约注册表：`{contractKind, outputs[{path, required}], checks[], validator}` |
| `inputs` | 原 `requiredInputs` / `optionalInputs` | 委派参数校验；UI 模板 |
| `safetyClass` | 新增：`general / clinical / regulated` | `regulated` 的契约种类必须通过服务端外部门禁才交付 |
| `dataSources`、`starterPrompts`、`estimatedMinutes` | 原有 | 目录与 UI |

**初始目录**（现有 11 个专科包一一对应；`open-domain-answer` 并入编排器指引，不是能力）：

| 能力 | 产出的契约种类 | 阶段 |
|---|---|---|
| `clinical-evidence-synthesis` | `clinical-evidence-report`（8 件必需文件） | P0 |
| `comprehensive-drug-evaluation` / `drug-selection` / `off-label-analysis` | `drug-evaluation-report` / `drug-selection-report` / `off-label-report`（含 evidence-snapshot） | P1 |
| `meta-analysis` / `mendelian-randomization` / `bibliometric-analysis` / `peer-review` / `adr-analysis` / `research-topic-selection` | 各自的 managed-job 报告种类 | P1 |
| `dataset-research-scoping` | `dataset-scoping-package`（10 件） | P1 |
| `research-brief`（通用：证据全景、提案、备忘） | `research-brief`：文件存在 + 引文可解析 + 泄漏禁词 + 四指标 notice | P1 |
| `evidence-appraisal`（规划：RoB 2 / NOS / QUADAS-2 结构化评价） | `appraisal-table` | P2 |
| `manuscript-support`（规划：参考文献格式 Vancouver / GB/T 7714、EQUATOR / ICMJE 规范检查、SPIRIT / CONSORT / PRISMA 模板） | `manuscript-section` | P2 |
| `geo-content`（§9.11） | `geo-content-pack` | P3 |
| `patient-education`（规划，若产品要做） | `education-material`（内容触发器同样适用） | 待产品 |
| `clinical-decision-brief`（§9.9，`regulated`） | `clinical-decision-brief` | 待产品与合规 |

用户资料里「需完全自建的领域组件」（PubMed/MeSH 检索、质量评价量表、Meta 引擎、引用校验、写作规范、参考文献格式、方案模板、术语标准化）由上表的能力与现有 MCP 工具承接；伦理/合规审批流不在运行时，属控制面工作流，P4 评估。

### 9.4 契约按产出绑定

| 层 | 机制 | 阻断？ |
|---|---|---|
| 声明绑定 | `evimed_submit_deliverable{deliverableId}` → 从计划派生契约种类 → 校验器 → `{ok:false, issues}` 或写回执 | 是（机械） |
| 内容触发器（安全兜底） | `@evimed/domain` 的安全规则以扫描模式运行于**所有产物与最终回复**（正则只是第一道，不是唯一一道）；命中而未在 `clinical` 契约下通过 → `evimed_complete_run` 拒绝；直接回答在 `turn/end` 与服务端各扫一次 | 是（机械） |
| 计划履约与澄清 | `evimed_complete_run` 核对每项交付物已 `accepted`、`clarifications[]` 非空；`partial` 交付永远产出 `delivery-summary.md` | 是（机械） |
| 期望检查（控制面） | 分类器对题面给出期望契约种类（点名 = 高置信）；作为服务端题面逐问核对的输入，不单独触发修复 | 并入服务端门禁 |
| 服务端外部门禁 | §8.2；`regulated` 必须通过 | 是 |

**分类器错了，代价从「错一整个会话」降为「门禁多一条输入」。**

### 9.5 委派

`evimed_delegate{capability, deliverableId, brief, inputs}` 是确定性的复合工具（Apodex 的 component）：

1. 查能力清单；`contractKind` 由计划中的交付物派生（能力唯一产出时自动，多产出时须 ∈ `produces[]`）；校验 `inputs`；`dependsOn` 未全部 `accepted` 时排队。
2. 组装子代理首条上下文：交付物规格 + 题面相关段落 + 预注入的技能正文 + 相关胶囊方法。
3. `startSubagent(ctx, { capability, prompt, tools: manifest.tools ∪ {read, write, edit, glob, grep, bash?, skill, evimed_submit_deliverable, report}, persona, outputSchema: DELEGATION_REPORT }, parent, signal)`——`spawn` provider 支持 `outputSchema / depthLimit / toolFilter / persona`；`maxDepth = 1` 是常量不是配置。子代理继承父代理 `cwd`，交付物写在 `deliverables/<deliverableId>/`，校验器只认该目录，路径守卫保护题面与回执。
4. 结算：`completed` → 计划项 `submitted/accepted` 由提交决定；非 `completed` → 自动重派一次（带诊断），再失败标 `failed{code}` 并以 `next-step` 唤醒父代理。
5. `maxParallelChildren` 封顶（旋钮在控制面，经 profile patch 派生）。

批量（「50 个子代理筛 5000 篇」）走 `evimed_screen_batch`（§10.2）。

### 9.6 四个走法

1. **「你好」/「二甲双胍的主要副作用」**：不写计划，直接回答；`turn/end` 过安全触发器；服务端过引文卫生；**引文卫生通过且用户未纠正的回答写入第一层记忆**，下次题面相似时先注入（§19.16）。
2. **「分析这 5 个问题的证据现状」**：`evimed_plan` = 5 × `clinical-evidence-report` + 1 × `research-brief`（`dependsOn` 前五者）；5 个 `evimed_delegate` 并行；综合；`evimed_complete_run`。
3. **续问「基于这些做 GEO 提案」**：同一会话，计划追加 `geo-proposal`，委派给 `geo-content`；**没有模式可切**。若该能力尚未上线，目录里没有它，编排器如实说明——外推性的边界是能力目录，不是路由表。
4. **「这个病人能不能用 X 药」**：无 `clinical-decision-brief` 能力时按人设不给诊疗建议，可提供证据综述；若上线（§9.9），契约最严。

### 9.7 工具目录大小与渐进披露

- 根代理 ≈ 20 个工具：文件读写搜索、bash、jobs、skill、subagent/workflow、四个框架工具、少数「伞形」检索工具（`literature_search`、`web_search`、`open_access_full_text`、`term_normalize`、`data_source_catalog`）。≈ 25 个专用 MCP 工具只在委派出的子代理里可见。
- 根/子判定在**首个 `agent/pre-step`**（日志无 `subagent/descriptor` 即根；`agent/session-start.source` 只区分 `startup / resume / clear / compact`）；根代理限制经 `agent.ctx` 注册一次（此后前缀稳定），不得注册在 preset 作用域（restrict 掩码相交，会连带套住子代理）。**P0 不限制根代理**，P1 按 `tokenMeter` 实测决定。
- 技能目录由 DSH 在首个 `agent/pre-step` 注入一次（仅 `customSkillDirs` 的通用技能，能力正文与胶囊方法不在其中）。
- 30 个子代理的 `quiet` 报告与结算通知都注入父代理上下文，`tool-result-pruner` 不作用于 `user/message`——P1 用 `tokenMeter` 实测，必要时让 `report` 只回传摘要、正文落盘。

### 9.8 入口、UI 与目录重组

- `/api/agents` → `/api/capabilities`：`title / description / starterPrompts / inputs`。UI 的「科研 Agent」列表变成「能力模板」：点选 = 预填题面并点名能力 = 高置信期望（§9.4）。上位方案的入口形态保留，语义从「绑定包」变为「建议」。
- 目标目录（「重组到位」；用户称插座的包名随之改为 `@evimed/dsh-socket`）：

```text
OpenScience/
  apps/server/                 控制面（不变）
  apps/web/                    前端（原 apps/desktop，去掉 src-tauri）
  packages/domain/             @evimed/domain
  packages/harness-port/       @evimed/harness-port
  packages/socket/             @evimed/dsh-socket（本文的 dsh-bundle）：cordis.patch.yml、plugins/、presets/evimed-universal/
  capabilities/<id>/           capability.yaml + SKILL.md + scripts/ + references/（原 runtime/skills/evimed）
  skills/{core,curated-scientific,office,community}/   通用技能（原 runtime/skills/*）；community = 生态技能包（§21.8）
  tools/mcp-evimed/            MCP 服务（原 runtime/mcp/evimed-research）
  tools/mcp-geo/               P3
  tools/kernel-bridge/         原 runtime/kernel（控制面的 notebook 内核仍用）
  deploy/runtime-dsh/          运行时镜像
  evals/                       不变
删除：runtime/harness、runtime/manager、runtime/opencode-profile、packages/ui、packages/sdk、apps/desktop/src-tauri（附 B）
```

### 9.9 临床辅助决策

架构上它只是一份 `safetyClass: regulated` 的能力清单：契约最严（实践要点只允许 `direct` claim、每条建议必须有逐字引文、`derived` 不得进入建议、安全规则全开），完成时强制服务端外部门禁通过。**是否上线是产品与合规决定**，不在本文范围；架构两种结果都不需要改。合规要点（国家药监局 2021 年第 47 号《人工智能医用软件产品分类界定指导原则》）：处理对象为**医疗器械数据**且用于辅助决策（用药指导、治疗计划等）的软件按**第三类**医疗器械管理；处理对象为非医疗器械数据（患者主诉、检验检查报告结论、文献等）的原则上不作为医疗器械管理。基于文献的证据综述属后者；一旦输入个体患者的器械数据（影像、监护原始数据）并给出个体化诊疗建议，就进入前者。

### 9.10 技能与工具名迁移清单

1. MCP server 名取 `evimed`，且 MCP 原始工具名去掉 `evimed_` 前缀（§14 规则 21）⇒ 模型看到 `mcp__evimed__literature_search`（30 字符 < 64，无哈希后缀）；插座原生工具保留 `evimed_` 前缀。SKILL.md 中 `evimed_*` 的出现位置由脚本从 `@evimed/domain` 的 `toolNames` 批量改写；运行时泄漏禁词同时覆盖 `mcp__evimed__` 前缀。
2. SKILL.md frontmatter：`name` / `description` 合规，补 `whenToUse`；`allowed-tools`（4 个包，Anthropic 工具名）删除或改为 DSH 工具名；`license` / `metadata` 等非 DSH 字段是否被接受待核（§15）。
3. SKILL.md 正文里的 `$XDG_CONFIG_HOME/opencode/skills/...` 路径改为 `skill` 工具返回的 `<skill_resources>` 路径。
4. `skillsLoaded` 完成检查：委派时预注入技能正文，由构造保证；根代理自行加载的技能核对持久事件 `tool/call{name:'skill'}`。
5. 子代理：`generatedRuntimeSubagent`（为 `task` 工具生成的 `-delegate.md`）不再需要——子代理通过 `composeFrom()` 加入父代理同一组合，再由 `toolFilter` 收窄。

### 9.11 GEO 能力清单要点（P2 契约、P3 工具）

- **产出契约种类** `geo-content-pack`：每个内容块 = 「结论 + 依据 + 适用条件」三段 + ≥ 2 条可解析文献引用（与证据综述共用引用完整性检查）+ 作者资质与更新日期字段 + schema.org `MedicalWebPage` / `MedicalCondition` / `Drug` JSON-LD；整包附 `llms.txt` 片段与 FAQ 块。这些都是机械可核的，可阻断。
- **工具**（MCP server `evimed-geo`，独立进程）：`keyword_analyzer`、`structured_content_generator`、`entity_optimizer`、`ai_reference_checker`、`competitor_analyzer`、`content_audit`。其中「向 DeepSeek / 豆包 / Kimi 等引擎提问并检测引用」**必须经控制面新网关** `/internal/geo-probe/v1`（服务端持各平台 key，运行时永不指定主机）。
- **监测**：引用率按「引擎 × 查询集 × 周」记录在工作区 `geo-monitor.csv`，供续跑时对比；行业经验为 60–90 天见效，所以它是长期运行的 `goal`，不是一次性交付。
- **内容库与品牌实体**：内容块作为胶囊知识层的一个 `factKind`（`geo-content-block`）跨运行留存与复用；品牌实体档案（名称、适应证、证据、资质）是 `geo-content` 能力的固定 `inputs`；发布步骤 = 导出包（Markdown + JSON-LD + `llms.txt` 片段）供站点接入。
- **边界**：GEO 内容同样过内容触发器——含用药 / 急症指导的块必须同时满足 `clinical` 契约，营销文案不能绕过安全规则（§9.4）。

---

## 10. 并发与「蜂群」

### 10.1 三个层级，只建前两个

| 层 | 范围 | 机制 | 上限 |
|---|---|---|---|
| 1. 一次运行内 | 模型驱动的并行 | `subagent`（spawn/fork，`continuable` 后台）、`workflow`（模型写 JS 脚本，`parallel()` / `pipeline()` 在 worker 线程执行）、`job_*` | `maxDepth = 1`（常量）、`maxParallelChildren`（§10.4）、DSH `maxParallelSubCalls`（默认 10）、`maxTotalAgents` |
| 2. 跨运行 | 控制面 | `TaskManager` 全局/每项目并发、`MAX_RUNNING_RUNTIMES(_PER_USER)`（现状） | 配置 |
| 3. 团队协作（花名册 / 任务 DAG / 邮箱） | DSH experimental `agentTeams` | 配置行 `@deepseek-ai/dsh-experimental-tool-agent-team`（`dsh-base` 里禁用） | **不在本方案启用**；待其离开 `experimental/` 后以配置开启，零代码 |

不引入 BullMQ / Redis / 进程外 worker：一项目一个 Node 进程承载 30 个进程内子代理，CPU 密集的 R/Python 工作本来就是沙箱子进程。

### 10.2 确定性复合工具（Apodex 的 component）

「50 个 agent 并行筛 5000 篇文献」不交给模型即兴编排，而是一个复合工具 `evimed_screen_batch`：读取检索结果集，按 `batchSize` 切片，`ctx.subagents.start('spawn', { prompt, parent, signal, toolFilter: { allow: ['read'] }, outputSchema: SCREEN_VERDICT, maxDepth: 1 })` 并行 ≤ `maxParallelChildren` 个，收集结构化裁定，写 `screening-ledger.csv`，返回进度与统计。子代理 provider 的能力位（`outputSchema`、`toolFilter`、`depthLimit`）在 P0 对 `spawn-in-process` 核实。

### 10.3 资源边界

- 内存：每个子代理有独立上下文与压缩；`tool-result-pruner` + `spill-policy`（50,000 字节以上落盘）限制单个结果。
- LLM 限速：全部经模型网关，网关加每项目并发上限（现有 `MAX_*` 体系扩一项）。
- 共享写：子代理只写 `deliverables/<id>/`，路径守卫保护题面、回执与状态投影（§7.4）；`writeScopes` 等待 agentTeams。

### 10.4 限额总表（唯一定义处：控制面 `config.mjs`；向下派生，不另设旋钮）

| 限额 | 默认 | 定义层 | 派生到 | 性质 |
|---|---|---|---|---|
| `deliveryAttemptLimit` | 3 | 控制面 | profile patch → `run-policy` guard；控制面修复回环同一数 | 单旋钮（原 `maxSubmitAttempts` + `maxClinicalRepairAttempts` 合并） |
| `maxParallelChildren` | 30 | 控制面 | `run-policy` | 每运行并发子代理 |
| `maxDepth` | 1 | `@evimed/domain` 常量 | — | 设计不变量，不可配置 |
| 运行预算 `maxSteps / maxTokens / maxChildren` | 按能力清单 | 能力清单，控制面可调低 | `run-policy` 预算守卫 | 超限 reject + inject |
| `evidenceStaleMinutes` | 10 | 控制面 | `evidence` | 证据超时 |
| DSH `maxParallelSubCalls` | 10 | DSH 注册表默认 | — | 不改 |
| `agentRunMonitorStallMs` / `agentRunMonitorTimeoutMs` | 15 min / 4 h | 控制面（现状） | — | 进展信号含子代理活动（§7.5） |
| `MAX_RUNNING_RUNTIMES(_PER_USER)`、模型网关每项目并发 | 现状 | 控制面 | — | 跨运行 |

---

## 11. 安全与隔离不变式

| 不变式（来源：07-16 上位方案 §11、07-17 融合方案 §18.1） | DSH 下的落实 |
|---|---|
| runtime 不持真钥 | `llm-deepseek.apiKeyEnv = EVIMED_WORKLOAD_TOKEN`（HMAC 短期令牌）；`DEEPSEEK_API_KEY` 不注入；`web_search` 禁用（它需要真钥） |
| 外联只经固定内部网关 | 容器网络策略不变；`web_fetch` 保持关闭（DSH 自己也因 SSRF 默认关闭）；MCP 只认 `EVIMED_*_URL` |
| 只访问当前工作区 | DSH `workspace-write`：写限制在会话 `cwd` 与临时根；读与网络不受限 ⇒ 读靠容器文件系统只挂载项目卷、网络靠上一行 |
| 托管默认执行、无逐动作审批 | `permission-presets` 表新增 `evimed-hosted = workspace-write + never`。注意 `never` 不是自动放行而是**自动拒绝**一切 ask（`dsh:packages/interaction/user-approval/src/index.ts:88-94`）——沙箱内读写本不需要审批，需要审批的只有「突破沙箱的重试」之类，拒绝正合适；`ask_user_question` 工具不挂 |
| 本地桌面需要审批 | `evimed-web` profile 用 DSH 默认 `ask` |
| 遥测不外传 PHI | `DSH_TELEMETRY_DISABLED=1`；DSH 遥测无脱敏规则，必须硬关 |
| 特权操作只在本机 | DSH 把 `settings.*` / `credentials.*` / `host.*` 钉在 loopback；我们的方法白名单再拒一次 |
| 进程隔离 | Docker（cap-drop、pids、只读根、`no-new-privileges`）+ 容器内 **Landlock**。bwrap 需要非特权 user namespace，在 Docker 默认 seccomp 与 Ubuntu 24.04 的 AppArmor 限制下不可用，DSH 的运行链会落到 Landlock；前提：宿主内核 ≥ 5.13、Docker ≥ 23.0（默认 seccomp 自 moby#43199 起放行 `landlock_*`）、`no-new-privileges` 已开（现有启动计划 `runtimeManager.mjs:871` 已设）。三者缺一，`bash` 工具整体 fail-closed（`SANDBOX_UNAVAILABLE`）——启动自检必须经 `ctx.shell` 执行一条空命令并要求 `enforcement: 'full'` |
| MCP 在沙箱外 | 与今天相同；MCP 进程只拿工作负载令牌 |
| 会话日志可含 PHI | 落在项目卷（现状同）；不开 SQLite 全文索引（`session-query-sqlite` 保持 `:memory:`） |
| 备份与导出 | `$DSH_HOME/{sessions,attachments,storages}` 在项目数据卷上，纳入现有项目导出 tar 与备份作业；旧 OpenCode 会话不迁移，切换后只读归档 |
| 附件无 GC | DSH 附件「retained indefinitely」⇒ 项目删除时整卷删除（现状），并在配额巡检里计入 `attachments/` 体积 |
| 热重载关闭 | `hmr.disabled: true`；profile patch 0o600、只由控制面写 |
| 可观测性 | DSH 遥测硬关；运行指标（步数、token、子代理、门禁结果）经 `.evimed-run/state.json` 与账本 `finished` 事件进入控制面 metrics（`/api/ops/metrics`，现有 monitoring 栈） |

---

## 12. 版本同步工程（D4 展开）

### 12.1 钉死

- 镜像：`@deepseek-ai/dsh@<exact>`（npm integrity 校验）+ `@evimed/dsh-socket@<exact>`（tarball sha256）+ `release-manifest.json` 新增 `dsh.version`、`bundle.digest`、`domain.version`。
- 插头：`peerDependencies["@deepseek-ai/cordis"]` 精确版本（DSH 的 vendored cordis 每次随主包发布）；`seam-manifest.json.dsh` 与镜像版本必须一致（启动自检断言）。
- 子包的 `latest` dist-tag 不可信（多数仍指向 `0.0.1-rc.1`），**永远写精确版本**。
- **跟版依赖只有一套机制**（2026-08-23 收口）：`deps-version.json` 一个文件钉 `dsh / memos / openlist / mineru`；`packages/contracts/<dep>/` 各一个契约测试目录；一个夜间矩阵作业循环四个依赖；升级 = 一个 PR。不为每个依赖复制一套流程。

### 12.2 契约测试（每次 CI）

在 `packages/dsh-harness-port/test/`，对 `node_modules/@deepseek-ai/*` 的**已安装**版本断言：`seam-manifest.json` 列出的每个包可 import、每个服务键在 `cordis.yml` 最小组合里出现、`defineTool` 接受我们的 option 形状（含 `isConcurrencySafe`、`timeoutMs`）、`PreToolDecision` 的三种 `kind`、`Session.append` 签名未新增必填参数、`host.describe` 返回的方法集合 ⊇ `seam-manifest.wire.unary`。任何一项失败 = 版本不可升级，信息指明缝名。另加**金帧夹具**：每个 pin 版本录制 `session.history` 与 `events.mux` 的样例帧，断言 port 的转换函数（`toTurnEnd` 等）输出形状不变——线协议没有版本字段，方法名相同不代表帧形状相同（V21）。

### 12.3 一致性套件（keyless，每次 CI）

- 模型：不依赖 `test-support`（DSH 自述「lower compatibility expectations」），而是用**文档化的缝**——`ctx.llm.registerAdapter()` 注册一个脚本化 `LlmAdapter`，按剧本回放工具调用（`dsh:docs/cookbook/adding-an-llm-adapter.md`）。
- 场景：(1) 启动自检通过；(2) 用 `dsh-base + dsh-web-app + socket` 的测试 profile（headless bundle 没有 `agent-presets` 行）在真实 Loader 下挂载 `evimed-universal` 并委派一个 `clinical-evidence-synthesis` 子代理（DSH 要求「product-visible plugins need a REAL-composition test」）；(3) 脚本模型先提交一份缺 `question-coverage.json` 的包 → 返回 `{ok:false, issues}` 且 issue code 点名文件；补齐后 → 回执写出；随后 `evimed_complete_run` 使 `concludeTurn` 生效；(4) `tools/result` 写入证据表；(5) `--dump-config` 快照与上次一致（行 id 集合不变）；(6) HMR 安全：卸载插件后工具与监听全部消失；(7) 子代理结算非 `completed` → 计划项 `failed` 且父代理被唤醒；(8) 恶意工作方式包不改变任何门禁判定。
- 运行在宿主 CI（无 Docker）：`dsh --profile <tmp> --patch ./test.yml` 的 headless 形态即可。

### 12.4 夜间兼容矩阵

```text
nightly:
  latest = npm view @deepseek-ai/dsh versions --json | last rc
  if latest ∉ tested: 
    build runtime image with DSH=latest（其余 pin 不变；临时放宽 peerDependencies，否则 bundle 越界拒载、矩阵只能得到「拒载」）
    run 12.2 + 12.3 + 5 份 RQ 题面的内核平价（门禁 errorCode 分布 diff）
    diff docs/event-producer-consumer.md、docs/tool-catalog.md、persistence-catalog.md（从 git tag 取）
    → 结果写 compat-matrix.json（version, pass/fail, seams touched, diff summary）；失败开 issue
```

安全修复（如 0.1.1-rc.1 的 bwrap `/proc/<pid>/root` 逃逸修复）**当日**走同一套检查，不等夜间。矩阵绿 = 升级 PR 只需改 `deps-version.json`；矩阵红 = 改动被定位到 `harness-port` 的哪个函数。**我们不承诺「零改动」，承诺「改动可定位、可回滚、一个 PR」。**

### 12.5 升级 PR 清单

1. 改 `OpenScience/deps-version.json` 的 `dsh` 键（唯一定义；Dockerfile ARG、`seam-manifest.dsh`、peer、`release-manifest` 由测试断言相等；镜像 `npm i -g` 与工作区 `node_modules` 两条安装路径版本相等）；2. 跑 12.2 契约测试 + 金帧；3. 跑 12.3；4. 跑 31 份 RQ 平价；5. 更新 `release-manifest.json`；6. `PROGRESS.md` 一行。

### 12.6 对上游的三件事

- 在 DSH Discussions 登记为「downstream session event type」的消费者（`known-event-types.ts` 明说在等这样一个消费者）——拿到注册面后，任务状态镜像可以回到会话日志。
- `--host` 在容器内的用例（我们用 socat 绕过，但正式支持更干净）。
- 把插头仓库打上 `dsh-plugin` topic；MIT 许可兼容，`THIRD_PARTY_NOTICES` 同步。

---

## 13. 路线图

| 阶段 | 周期 | 交付物 | 退出标准 |
|---|---|---|---|
| **P0 换内核 spike** | 2 周 | `deploy/runtime-dsh/` 镜像；`DshRuntimeAdapter` + `OPEN_SCIENCE_RUNTIME_KERNEL` 开关；bundle 骨架（patch + MCP 行 + 统一组合 `evimed-universal` + 框架工具 `evimed_plan / evimed_delegate / evimed_submit_deliverable / evimed_complete_run` + 一份能力清单 `clinical-evidence-synthesis`）；事件归一化到浏览器 | 一份真实题面经 DSH 跑完，**不改服务端门禁**即通过交付；5 份 RQ 平价不劣化；`/api/ready` 在 DSH 内核下为 ok |
| **P1 插座成型** | 3 周 | `@evimed/domain` 抽出并被两侧 import；`run-policy` 门禁（裁定即返回值）+ 回执 + 多交付物逐件判定 + 撤稿机械检查；11 份 `capability.yaml` 校验、编排器能力目录、期望检查并入服务端核对；`harness-port` 类型化 + `seam-manifest` + 启动自检分级；契约测试 + 金帧 + 一致性套件 + 夜间矩阵；运行树 UI（F1） | 31 份 RQ 平价；55 条标注缺陷召回不降；`controlled-pilot` 默认内核切到 `dsh`；Tauri 停止维护 |
| **P2 深度能力** | 3 周 | `evidence` 摄入 + `state.json` 投影；运行预算；`evimed_review_run`（非阻断）；`evimed_screen_batch`；四指标 notice；管理作业包装为 DSH 作业（§21.7）；删除 OpenCode 路径与 `/api/opencode/*`；`evimed-web` 本地 profile；`release-manifest` 扩展；旧 OpenCode 会话只读归档；网关 `/files` 透传 | 全部 `test:web` 绿；`audit:saas-alignment` 绿；对冲方案 D 的决策点 |
| **P3 能力扩展** | 4–5 周 | `geo-content`（契约种类、技能、`evimed-geo` MCP、`/internal/geo-probe/v1` 网关、内容库与品牌实体档案）；`evidence-appraisal`、`manuscript-support`；临床决策辅助能力清单（若产品决定）；`tool-goal` 行（GEO 监测） | GEO 交付门（机械）可阻断；内容块引用可解析率指标 |
| **P4 持续** | — | agentTeams 评估、上游贡献、矩阵维护 | — |
| **F 前端轨**（与 P0–P3 并行） | 6–8 周 | F0 会话层按 `RunEvent` 重写（P0 验收用最小版）；F1 运行树 + 交付物与回执 + 能力模板 + 设置清理；F2 证据台账 + 计划视图 + 审批/提问 + 轨迹检查器 + 预算 + **胶囊基础页（资料、记忆、方法）**；F3 胶囊时间轴与分享 | 每阶段与同期后端阶段一起验收（§18.7） |
| **C 胶囊轨**（P1 起并行） | 8–10 周 | C0 MemOS 自托管部署（`deps-version.json.memos` + 契约测试 + 备份升级演练）+ `memorySubstrate` 端口 + usememos 迁移 + 会话 cube 自动写入 + 画像注入；C1 文档摄入 + 事实蒸馏 + 召回工具 + 胶囊基础页（依赖 F2）；C2 方法论蒸馏为 SKILL.md + 事后审阅 + 经 `ctx.skills.register` 注册；C3 时间轴与成长 + 反思作业；C4 分享（工作方式包、cube 导出只含 `textual_memory.json`、客体激活、导出技能根）；C5 录音/图像摄入 + 向量召回（外部 API） | §19.12 六项评估全绿 |
| **B 计量与通知轨**（P1 起，A 轨的前置） | 4 周 | B0 `usage_events` + 网关计量 + 价目 + `credit_ledger` + 手工充值 + 余额与告警（§25.1–25.2）；B1 计划卡预估 / 实时计量 / 结束对比、`/account` 页、通知表与站内 + 邮件渠道、收件箱页（§23.6、§25.3–25.4）；B2 微信渠道、保留与删除传播（§25.5） | 预估 P90 覆盖率 ≥ 90%；计量与网关日志对账误差 0 |
| **A 主动科研轨**（依赖 P1 + C1 + B0） | 10–12 周 | A0 议程 + 调度器 + 回合 = 运行 + `agenda-delta` + 简报 + 哨兵 / 信号监测（L0）；A1 数据保险库 + 画像分级 + 分区挂载 + 预注册守卫 + 探索分析 + 反驳者 + 直播页；A2 假说竞技场 + Thompson 分配 + 学习回路 + 「夜间 30 晚」评测集；A3 L2 确认分析 + 写作流水线 + 签核导出；A4 团队线程评估（§24.10） | 各阶段退出标准见 §24.10；部署级 `OPEN_SCIENCE_AUTOPILOT_ENABLED` 总闸 |
| **U 摄入与分析轨**（随 C 轨） | 8–10 周 | U0 OpenList 自托管 + 连接器契约 + 分块续传上传 + 入库（清单 / 变更检测 / 三层去重）+ `index_only` 全量索引；U1 分流级联 + 抽取器注册表第一批 + 覆盖台账 + 整理台；U2 媒体（ASR、视频分段与 PPT 对齐）+ 书（RAPTOR）+ 医案 / 病例 + 研究档案 + 本地分析代理；U3 QA 遗漏审计 + 产出量异常 + 每用户有用分类器 + 规律挖掘 + 周报；U4 抽取器升级与选择性重蒸馏 + 评估集（§26.12） | 1,000 文件入库 → 可检索 < 2 h；`deep` 遗漏率 ≤ 5%；近重复精确率 ≥ 0.98；类型判定 ≥ 0.95 |

每阶段都有 kill-switch：P0–P1 期间 `OPEN_SCIENCE_RUNTIME_KERNEL=opencode` 一行回退。

---

## 14. 代码规范：按《A Philosophy of Software Design》分章的插座规则

母本是用户的《医学科研 Agent 项目代码规范与工程原则》（十章，Ousterhout）；本节是它在本仓库的**可检查**落地，每条规则标明检查方式（lint / 测试 / 评审）与书中依据。与母本的三处差异在前：(1) 母本第八章的 DSH 白名单含不存在的 `ctx.subagent`，本节以 `seam-manifest.json` 为白名单；(2) 母本「单文件 bundle」「配置缺失降级」「禁止动态 import」三条与 DSH 现实冲突，按本节改写；(3) 母本第十章的 Conventional Commits 与仓库现行「一句话结论」式提交标题冲突，**沿用仓库风格**（书 ch.17：一致性优先于个人偏好），正文须写 why 与测试。标 **[原 n]** 的保留自 v2 §14。

适用范围：`packages/domain`、`packages/harness-port`、`packages/socket`（本文亦称 dsh-bundle）、`apps/server` 中的 `DshRuntimeAdapter` 与事件转发、前端 `lib/runStream.ts`。

### A. 复杂性与战略（ch.2、3、11、16）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 1 | 新增插件行、面向模型的工具、线协议方法或 storageDomain 表之前，PR 须附「两案对比」：备选、取舍、为何选此 | 评审（PR 模板必填） | ch.11 设计两次 |
| 2 | 禁止 `TODO` / `FIXME` / `HACK` / `临时` 类注释进入上述包；时间不够就缩范围 | lint `no-warning-comments` | ch.3 战术债会复利 |
| 3 | 依赖方向 `apps/server → domain`、`socket → {domain, harness-port}`、`harness-port → @deepseek-ai/*`、`domain → 无` 由 `dependency-cruiser` 强制并进 `ci:web`；测试断言 `@evimed/domain` 无 `dependencies` 且不 import `node:fs` / `node:child_process` / `node:net`（输入是内容，不是路径） | lint + 测试 | ch.2 复杂性 = 依赖 + 晦涩 |
| 4 | 一处知识一处代码：工具名、契约种类集合、工作区布局（`.evimed-brief/`、`.evimed-capsule/`、`.evimed-sources/`、`deliverables/<id>/`、`delivery-receipt.json`）、三套状态词汇表，只在 `@evimed/domain` 导出一次（`toolNames`、`CONTRACT_KINDS`、`workspaceLayout`、`states`）；SKILL.md 改写脚本、禁词表、控制面取回、前端都从它派生 | lint 禁 `deliverables/`、`.evimed-` 字面量出现在 domain 之外 | ch.5.3 信息泄漏 |
| 5 | 修改既有模块不得为「少改」而把旧依赖的词汇固化为内部模型：适配器归一化到 `@evimed/domain` 的 `RunTranscript` / `RunEvent`，不是 OpenCode 的 `message.info/parts`；`agentRuns.mjs` 改读新类型，顺手修掉 `REQUEST_PATH` S4–S6（读历史/状态失败 ≠ 无进展） | 适配器测试覆盖每种 DSH 事件 + 坏数据 | ch.16 「没让设计更好就是在让它更坏」 |

### B. 深模块与信息隐藏（ch.4、5、6、9）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 6 **[原 10]** | 插件只做适配：订阅缝 → 取状态 → 调 domain 纯函数 → 写状态。阈值、正则、状态转换表、拒绝文案模板、安全规则一律在 domain（函数）或 `clinical-safety-rules.json`（数据） | lint：`packages/socket/plugins/**` 禁正则字面量、`new RegExp`、直接 import 安全规则 JSON | ch.4 深模块；ch.8 复杂性下沉 |
| 7 | 每张 storageDomain 表的 `status` 只有一个写入者：domain 导出的 `transition(table, from, event) → to`，非法转换抛错；`run-policy / evidence / 控制面` 都经它写 | 测试枚举全部转换；grep 无直接赋值 | ch.5 共享可变表 = 全局变量 |
| 8 | `@evimed/harness-port` 拥有自己的类型词汇并做形状转换：导出 `ToolCall`、`GateDecision`、`SessionRef`、`SubagentRequest`、`TurnEnd` 等 typedef；插件不得读 DSH 原生对象字段，也不得在 JSDoc 里 `import('@deepseek-ai/...')` | CI grep 禁 `import('@deepseek-ai` 于 port 之外；契约测试断言转换函数 | ch.7.1 传递方法是红旗；D3 的「一处替换」必须包含形状 |
| 9 | 新增插件行或专用工具，PR 须写明它隐藏了哪项别人不知道的知识；`--dump-config` 行 id 集合与工具目录有快照测试。agent 面我们的行固定为 `guidance`、`run-policy`、`evidence`、`capsule`、`review`、`screening` 六个 | 快照测试 + 评审 | ch.9 共享知识的代码合在一起 |
| 10 | 面向模型的工具以通用「伞形」接口为主（`literature_search{source,…}`），新增专用工具须证明通用工具参数化无法覆盖 | 评审；工具目录快照 | ch.6 通用模块更深 |

### C. 分层与下沉（ch.7、8）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 11 **[原 7，改写]** | 配置字段三问同时成立才进 `Config`：两个部署会设不同值？插件推断不出？部署者比设计者更会定？每个字段的 JSDoc 写「谁会设不同值」。设计不变量（`maxDepth = 1`）是常量并有测试。同一策略只有一个旋钮：交付尝试上限、并发上限、超时各在控制面 `config.mjs` 定义一次，经生成的 profile patch 向下派生 | 字段 JSDoc 评审；测试断言 profile patch 值来自 `config.mjs` | ch.8.2 配置参数常是回避决策 |
| 12 | 浏览器与插件都不直接消费 DSH 事件词汇：控制面把 `session/event` 解码为 domain 的 `RunEvent` 联合后转发；前端 `switch` 穷尽，未知事件计数并可见；轨迹检查器用带 `raw` 的变体 | TS `never` 穷尽检查；测试 | ch.7 不同层不同抽象 |
| 13 | 模型不承担编排细节：子代理参数、交付目录、技能预注入、交付物依赖（`evimed_delegate{dependsOn}`）由复合工具计算；不让模型写 workflow 脚本串联交付物 | schema 评审；一致性套件 | ch.8 复杂性下沉到模块而非用户（此处用户 = 模型） |

### D. 接口与错误（ch.10；母本第三、六章）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 14 | 门禁裁定是值不是异常：`evimed_submit_deliverable` 正常返回 `{ok:false, issues[]}`；`tools/pre-execute` 不用于业务裁定，`deny` 只用于策略（预算、次数上限） | 一致性套件 (3) 断言返回值 | ch.10 把错误定义掉——首次提交不通过是常态 |
| 15 | 所有 `evimed_*` 工具统一返回信封 `{ok, code?, data?, issues?}`，`output.schema` 必填（含 `additionalProperties: true`），`issues[]` 每项带 domain 的 issue code | 测试遍历注册工具 | 母本第三章契约一致性；ch.17 |
| 16 | 参数不得互相矛盾：能派生的不让调用者传（能力唯一产出时 `contractKind` 自动派生）；无消费者的参数不存在；无布尔参数，用枚举或对象 | 单元测试；schema 评审 | ch.10 让非法状态不可表达 |
| 17 | 跨边界失败都带机器码：插座 → 控制面（回执、镜像表终态）、适配器 → 账本（`turn/end`、预算、解析失败）、控制面 → 浏览器统一用 domain 的错误码注册表（扩展现有 `recoverable/terminal` 两分法）；映射函数对未知输入显式落 `*_unknown` 码并计数，不得默认为成功或「无进展」 | 映射穷尽测试 + 坏数据注入测试 | 母本第六章统一格式；ch.10.5 聚合 |
| 18 **[原 12，加牙]** | 失败只有两种形态：fail-loud，或 isolated-and-visible（日志 + 具名计数器 + 出现在 `qualityNotices` 或 `/api/ready`）。例外须带 `// isolated: <counter_name>` 并登记到 `REQUEST_PATH.md` §3 | lint：`no-empty` + `no-restricted-syntax` 禁 `.catch(() => {})` 与仅含注释的空 catch | `REQUEST_PATH` 三判据（不写日志、不改返回值、不进账本） |
| 19 | 启动期失败崩溃、运行期失败隔离：`apply()` 中缝缺失、我们覆盖的**每一行**未生效（不只 preset 根）、沙箱 enforcement 低于本 profile 要求、`seam-manifest.dsh` ≠ 运行版本即抛错；要求的 enforcement 等级是 profile 配置（托管 `full`，本地可放宽） | 启动自检测试；`--dump-config` 行集合启动期断言 | ch.10.6 崩溃适用于不可恢复 |
| 20 | 子代理失败显式传播：子会话 `turn/end.reason.kind !== 'completed'` → 对应计划项置 `failed{code}` 并以 `next-step` 唤醒父代理；`steer` 自身异常按规则 18 | 一致性套件新增场景 | ch.10 异常不能在边界消失 |

### E. 命名与注释（ch.12、13、14）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 21 | 一名一义：`kind` 只用于 DSH 的判别字段；契约种类 `contractKind`、记忆种类 `factKind`；运行 / 计划 / 证据三套状态词汇表在 domain 以 `as const` 定义，同词不异义；运行侧镜像表叫 `runMirror` 不叫 `runs`；MCP 原始工具名去掉 `evimed_` 前缀（server 名已带），模型看到 `mcp__evimed__literature_search`，插件原生工具保留 `evimed_` 前缀 | typedef + grep | ch.14 精确一致 |
| 22 | 注释写代码表达不了的：插件文件头写「本模块隐藏了什么」；port 每个导出有 JSDoc 并引用 DSH 文档路径与 manifest 键；规则类代码（触发器、禁词、阈值）注释写触发它的交付或事故——沿用 `specialistRouting.mjs` 的风格 | `eslint-plugin-jsdoc` `require-jsdoc` 于导出 | ch.13 |
| 23 | 工具 `description` 是模型可见的接口注释：写能力边界、何时不用、输出契约；与能力清单 `whenToUse` 由测试比对 | 测试 | 母本第四章 |
| 24 **[原 3]** | 每个 patch 行写显式 `id`，并注释原因（无 id 的行每次读配置都被当作删除 + 新增而重挂） | yaml 测试 | 母本第八章 |

### F. 一致性与显而易见（ch.17、18）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 25 | 生成文件只写字面值：控制面生成的 profile patch 不用 `!!js`；bundle patch 不含部署路径（`/opt/`、`/runtime/`），路径由 profile patch 注入或相对包根解析 | 生成器测试；yaml 测试 | ch.18 显而易见 |
| 26 **[原 2]** | function plugin 只具名导出 `name / inject / Config / apply`，无 default export | 测试 `expect('default' in mod).toBe(false)` | DSH postmortem 0001 |
| 27 | 新包 `tsconfig` `strict: true`；JSDoc 禁 `{any}`（用 `unknown` + 收窄）；不沿用 `apps/server` 的 `strict: false` | tsconfig 测试；CI grep | ch.18 |

### G. DSH 插件专项（母本第八章）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 28 **[原 1]** | `@deepseek-ai/*` 只能在 `packages/harness-port` 出现（含 JSDoc 类型）；`/src/*` 子路径、`experimental/*`、`test-support` 任何地方禁止 | ESLint `no-restricted-imports` + JSDoc 检查 | D3；DSH「depend on Service Definitions, never providers」 |
| 29 **[原 4 + 新]** | `seam-manifest.json` 是唯一来源：port 导出、启动自检、lint 白名单、契约测试、插件 `inject` 常量都从它派生；插件 `inject` ⊆ `manifest.services`；可选服务用 `ctx.get(key)`；插件不得直接写 `ctx.on('<字面量>')`，只能调 port 的 `onXxx` | 测试（inject 子集）；lint 禁 `.on(` 字面量于 port 之外 | ch.5；自检只探 manifest 不探插件实际订阅 |
| 30 **[原 5]** | 所有注册都是 effect；有序清理放在一个 disposer 里串行 await | HMR 测试 | 多个异步 disposer 无顺序保证 |
| 31 **[原 6]** | waterfall 监听器必须 `return next()` | 启动自检全管线计数 | 忘记即短路 |
| 32 **[原 8]** | 不向会话日志追加自定义事件类型；模型可见状态用 `agent.inject()`；插件自有状态用 `storageDomain` | lint 禁 `session.append(` 于 port 之外 | D6 |
| 33 **[原 9，扩展]** | 工具名、参数 schema、`CONTRACT_KINDS`、`outputs[]` 都是日志与回执的一部分：发布后不改名、新参数必须可选、删参数先 `@deprecated` 一个版本 | schema 快照测试 | 母本第三、八章 |
| 34 **[原 11]** | 每个注册都有 HMR 安全测试 | 测试 | 一致性套件 (6) |
| 35 | 版本 pin 单点：所有跟版依赖（`dsh / memos / openlist / mineru`）只在 `OpenScience/deps-version.json` 定义，契约测试各一个目录 `packages/contracts/<dep>/`，夜间矩阵是**一个**作业循环四个依赖；`@deepseek-ai/dsh` 的 Dockerfile ARG、`seam-manifest.dsh`、`peerDependencies`、`release-manifest` 由测试断言相等；peer 越界拒载 | 一致性测试 | ch.5；「改三个 pin」实为四处 |
| 36 | 禁令清单：不改原型链、不用 `eval`、动态 `import()` 只允许字面量工作区路径、插件不 import `node:fs`（工作区 IO 经 port 的 `readWorkspaceFile / writeWorkspaceFile`，底层 `ctx.fs`）；`apply()` 内 IO 带 `AbortSignal.timeout` 且有总预算 | ESLint 规则集 | 母本第七、八章红线 |

### H. Vibe Coding、测试与 CI（母本第七、十章）

| # | 规则 | 检查 | 依据 |
|---|---|---|---|
| 37 | 每个 `defineTool` 至少三类用例：成功、参数非法、裁定不通过；每个 domain 校验器有「通过包 + 每个 blocking issue 一例」的 fixture；覆盖率阈值进 CI | CI 覆盖率门 | 母本第七章 |
| 38 | fixture 与评测语料：合成，或经 PHI / 凭据扫描脱敏；`audit:source-secrets` 扩展到 `test/fixtures/**` 与 `evals/**`；快照变更须在 PR 说明 | CI 审计 | §19.10 泄漏 = 0 |
| 39 | 复杂度阈值代替行数：ESLint `complexity ≤ 20`、`max-depth ≤ 4`、`max-params ≤ 3`（多参数用对象）；超限需 `eslint-disable` 带理由。不采用母本「30 行拆分」 | lint | ch.9.8 长度本身不是拆分理由 |
| 40 | 工程闭环：`packages/*` 纳入根 `lint` / `typecheck` / `test:web`；`pnpm pack` 产物做 `files` 白名单与体积上限；PR 模板含 AI 代码清单（DSH 内部模块、缝白名单、硬编码、静默失败、`any`、多余依赖、两案对比、测试）与「触及的缝 / 契约种类」；给 AI 的约束前言由本节生成 | CI + PR 模板 | 母本第七、十章 |

---

## 15. 待核清单（P0 第一周逐项落实）

| # | 事项 | 来源 | 影响 |
|---|---|---|---|
| V1 | **已核（文本链路）**：适配器请求体字段 `model / messages / stream:true / stream_options{include_usage} / thinking / reasoning_effort / tools / temperature / max_tokens / stop`（`dsh:packages/llm/llm-deepseek/src/types.ts:12-29`）全部在 `modelGateway.mjs:33-51` 白名单内，消息字段亦然。**仍待核**：多模态 `content` 数组（`file` / `image_url` part）能否过网关、`/files` 是否透传（P0 文本-only）、429 的 `retry-after` 头是否转发（适配器据此退避） | §2.5、§6.4 | 文本链路零改动 |
| V2 | **设计已定、P0 验证**：用 `$DSH_HOME/.credentials.yaml` 的 `refs:`（0600、热重载、每请求解析），控制面每 150 s 原子重写；进程环境启动后不可改，不用 | §6.5 | 令牌刷新无需重启 |
| V3 | **已核**：`ApprovalPolicy` 只有 `'ask' / 'never'`，`never` = 拒绝一切 ask；`permission-presets` 表可配置，新增 `evimed-hosted = workspace-write + never` | §11 | 托管无人值守 |
| V4 | `dsh-mcp-client` 的精确配置键与 `structuredContent` 在 `tools/result` 里的可见形状 | §5.2、§7.3 | MCP 行与摄入钩子 |
| V5 | SKILL.md 非 DSH frontmatter 键（`license`、`metadata`、`allowed-tools`）是否被拒绝 | §9.10 | 75 个技能包的修改范围 |
| V6 | **已核**：`spawn` 声明 `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`（`dsh:packages/subagent/subagent-spawn-in-process/README.md:15`）；子代理无独立 `cwd` | §9.5、§10.2 | 委派与复合工具可行 |
| V7 | **已核**：`session.create{workspaceId?, cwd?, sessionId?, agentPreset?}`、`session.prompt{sessionId, mode: 'queue' / 'steer', content: PromptContentPart[]}`、`cancel{sessionId}`、`fork{sessionId, atSeq?}`、`history{sessionId, beforeSeq?, maxMessages?} → HistoryEntry{event, view?}`；`events.mux({since})` 帧 = `session/event` 透传 + `approval/*` + `question/*` + `session/queue` + `session/jobs` + `session/projection` | §6.4 | 适配器可写 |
| V8 | `workflow` 脚本 API（`parallel` / `pipeline` / `agent` 的签名） | §2.6 | 提示词与技能文案 |
| V9 | `!!js` 表达式能否引用插件包自身路径（决定 preset 根写在 bundle patch 还是 profile patch） | §5.2 | 打包方式 |
| V10 | **已核并决定**：`agent-instructions` 注入 `$DSH_HOME/AGENTS.md` + 从 `cwd` 向上到项目根标记的 `AGENTS.md` / `CLAUDE.md` 链，并在触达子目录时加载嵌套文件——用户上传到工作区的同名文件会被当作指令。**托管 profile 禁用该行**，指引全部走 `evimed-guidance` 节 | §9.2、§11 | 消除一条提示词注入路径 |
| V11 | `e2b` 之外是否有按会话指定远程执行世界的途径（当前否） | §2.4 | 未来多容器方案 |
| V12 | Cordis Fiber 状态名（资料称 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，已在 `dsh:docs/user/develop/framework/index.md:11-24` 看到同一描述；未核对源码） | §2.6 | 仅文档准确性 |
| V13 | **已核并解决（2026-08-24 生产宿主实测）**：内核 6.8 给 Landlock **ABI 4**，DSH 的启动器要 `MAX_ABI 5`（内核 ≥ 6.10，新增 `IOCTL_DEV`），故自报 `partial`。**处置：宿主内核升到 7.0.0-30（Ubuntu 24.04 官方 HWE 元包），实测 `landlock: fully enforced`**，`OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT` 因此保持生产默认 `full`、无需为任何一台机器开例外。约束实效经实测：工作区外读写均 `Permission denied`，区内正常 | §11、§30 | 沙箱后端可用且满级 |
| V14 | 多模态消息过网关与 `/files` 透传；`retry-after` 转发 | §6.4、§17 G5 | 图片输入上线时点 |
| V15 | `deliverables/<id>/` 目录约定在契约校验器与回执里的落实；子代理并发写同一文件的检测 | §9.5、§17 G3 | 多子代理安全 |
| V16 | **已核**：`enforcement` 字段存在（`dsh:packages/sandbox/sandbox-local/src/index.ts:320`） | §5.6 | 自检可写 |
| V17 | `@evimed/dsh-socket` 的 `workspace:*` 依赖如何进 tarball（`pnpm deploy` vs `bundledDependencies`）并被 `dsh plugin add ./x.tgz` 正确解析 | §5.1 | 分发方式 |
| V18 | MemCube `dump / load` 在 MemOS 2.0 REST 层的暴露方式与权限模型 | §19.16 | 工作方式包传输 |
| V19 | MemOS 自托管服务的认证（云有 API key，自托管是否有）与 Neo4j / Qdrant 的备份策略 | §19.16 | 部署 |
| V20 | 一致性套件的测试 profile（`dsh-base + dsh-web-app + socket`）能否在无浏览器的 CI 上启动并 mount preset | §12.3 | 测试基建 |
| V21 | `session.history` / `events.mux` 帧的金帧录制方式（无版本字段） | §12.2 | 契约测试 |
| V22 | 30 个子代理的 `quiet` 报告与结算通知对父代理前缀的实际 token 压力 | §9.7 | 是否改为摘要回报 |
| V23 | MemOS 自托管的契约测试（`/product/*` 金样本、cube `dump → load` 往返）与升级演练（备份 → 升级 → 验证） | §19.21 | 跟版同步可行性 |
| V24 | `tools/execute` 包裹器内能否取得 `exec.agent` 并调用 `ctx.jobs.start` 把 MCP 管理作业注册为 DSH 作业 | §21.7 | 作业体验 |
| V25 | DSH `assistant/message.usage` 的字段（是否含 `prompt_cache_hit_tokens` 拆分），决定运行内预算守卫能否按缓存命中计 | §25.1 | 预算守卫精度 |
| V26 | MinerU 在运行时镜像 / 控制面旁的资源占用（CPU 模式速度、GPU 可选）与中文扫描件效果；与 `pypdf` 兜底的切换条件 | §23.4 | 摄入流水线引擎 |
| V27 | 自主项目容器连续多回合运行的内存 / 磁盘曲线；`scheduleIdleStop` 对自主运行的豁免实现点；回合间是否回收容器 | §24.7 | 容器池设计 |
| V28 | NCBI E-utilities API key 配额（10 req/s）与 `publicSourceGateway` 全局令牌桶、结果缓存的实现点；其他公共源的限速条款 | §24.7 | 夜间零封禁 |
| V29 | `session.fork{atSeq}` 做假说分支时网关侧 cache-hit 计量是否证实前缀复用（账面收益） | §24.7 | 假说分支成本（后期） |
| V30 | 模型网关从流式响应可靠取得最终 `usage` 块（含 `prompt_cache_hit_tokens / prompt_cache_miss_tokens`）；中断流的计量补记 | §25.1 | 计费权威性 |
| V31 | 《文档结构化解析 API》（`接口文档/多模态文档解析.md`）服务是否可在我们的环境部署，决定它是摄入首选还是 MinerU 为主 | §23.4 | 解析引擎选型 |
| V32 | OpenList 的 `/api/fs/{list,get,link}` 与 WebDAV 在百度 / 阿里 / 夸克驱动下的稳定性、速率与哈希字段可用性；百度开放平台应用的配额 | §26.4 | 网盘连接器 |
| V33 | MinHash 阈值（Jaccard 0.8）与语义近重复阈值（cos 0.95）在中文论文版本家族 / PPT 复用上的精确率 | §26.4 | 去重 |
| V34 | QA 遗漏审计的成本（每 `deep` 文档的问题数与 token）与它对遗漏率的实际改善 | §26.7 | 审计策略 |
| V35 | 本地分析代理在 `evimed-web` profile 内的形态（独立命令 vs DSH 作业）与派生物上传契约 | §26.4 | 媒体与限速网盘 |
| V36 | 视频幻灯片切换检测（帧差 + OCR）与库内 PPT 对齐的准确率；ASR 网关对 2 h 以上录音的切片策略 | §26.6 | 媒体抽取器 |
| V37 | DeepSeek 是否提供托管微调接口（第三方来源称无）；自托管开源权重路径的可行性与成本 | §27.2 | 参数记忆是否进入路线图 |
| V38 | CIPHER 式「从编辑推断偏好」在中文医学写作上的精确率与对编辑距离的实际改善 | §27.4 | 标准层的主要来源 |
| V39 | 我们 Node 版本的 `crypto` 对 x25519 / ed25519 / hkdf / aes-256-gcm / scrypt 的支持与性能（2 GB 包的流式加密） | §28.3 | 零依赖前提 |
| V40 | MemOS 对外部导入的 `textual_memory.json` 的 schema 约束（能否携带 provenance / valid_from 等扩展字段）与只读 cube 的加载方式 | §28.2 | 客体 cube |
| V41 | 第三方 bundle 的工具行在我们 preset 作用域下能否干净组合（真实组合测试，接首个生态 bundle 时核）；能力清单 `tools[]` 对生态原生工具的构建期校验扩展（对组合后注册表而非仅 MCP `tools/list`） | §21.8 | 生态接入 |

---

## 16. 决策记录（2026-08-22 用户拍板）

| # | 事项 | 决定 | 落点 |
|---|---|---|---|
| 1 | 换内核 | **批准**：全面换，OpenCode 清零（附 B）；上位方案出 v5 | §0、附 B |
| 2 | `preflight.py` | **删除（仅限 clinical-evidence-synthesis 的那一份）**；唯一门禁实现是 `@evimed/domain`；SKILL.md 改为「提交直到 ok」。**补注（2026-08-24）**：`dataset-research-scoping` 与 `research-topic-selection` 的同名脚本是能力自带工具（读数据集、重跑画像），不是门禁镜像，**保留**——执行时曾误删并已恢复 | §8.5 |
| 3 | Tauri 壳 | **退役**（P1 起不再维护）；本地形态 = `evimed-web` profile | §6.8 |
| 4 | MCP server 名 | **`evimed`** | §9.10 |
| 5 | 上游参与 | **是**：登记为 downstream 事件类型消费者、`--host` 用例、`dsh-plugin` topic | §12.6 |
| 6 | GEO | **不是独立模式**：契约种类与能力清单 P2 落，工具（MCP `evimed-geo` + 网关）P3 | §9、§13 |
| 7（新） | 模式与路由 | **取消 Mode Router 与产品线 preset**：统一组合 + 能力清单 + 按产出绑定契约；路由器降级为期望检查 | §9 |
| 8（新） | 「该不要的都不要」 | 附 B 的删除清单 + §9.8 的目录重组；`runtime/harness`、`runtime/manager`、`runtime/opencode-profile`、`packages/ui`、`packages/sdk`、`apps/desktop/src-tauri` 一并移除 | 附 B、§9.8 |
| 9（新） | 临床辅助决策 | 架构按 `regulated` 能力预留；**是否上线待产品与合规决定** | §9.9 |
| 10（新） | 前端 | **保留并改造现有 React 应用**；不用 TUI；DSH Web 仅本地 profile | §18 |
| 11（新） | 记忆胶囊 | **纳入方案**：五层 + 时间轴 + 溯源 + 分享；方法论 = SKILL.md；**记忆底座 = MemTensor/MemOS 自托管，两层（会话 cube / 胶囊 cube）并行，usememos 退役**；向量召回用外部 API；ASR 先云后自建；分享默认 = 工作方式包；方法事后审阅不挡路（§19.14） | §19 |
| 12（新） | 插座内部结构 | 插件按知识切分为 `guidance / run-policy / evidence / capsule / review`（agent 面）+ `seam-probe / evidence-store`（宿主面）；裁定是返回值；`task-plan.json` 唯一计划产物；控制面只读 `.evimed-run/state.json` | §5.3、§7、§8 |
| 13（新） | 命名与单点 | 包名 `@evimed/dsh-socket`；MCP 原始工具名去 `evimed_` 前缀；版本 pin 单点 `deps-version.json`；限额只在控制面 `config.mjs` 定义 | §14、§10.4 |
| 14（新） | 工程规范 | 以母本（Ousterhout）为准，§14 改写为 40 条可检查规则；提交信息沿用仓库「一句话结论」风格 | §14 |
| 15（2026-08-24 执行裁决） | 前端会话层 | **绞杀者路线**：托管默认内核暂回 `opencode`（kill-switch 本来的用途）；`LiveSessionPage` 的 DSH 渲染路径作为**新增组件**挂在 `runStream.ts` 上、按内核开关选择实现，旧 store 原样保留；带界面验收（真实 RQ 题面在新页面看完整个运行）通过后翻默认，**同一 PR** 删旧 store + `packages/sdk` + `src-tauri`（附 B 收口）。不做 2,000 行原地改写 | §18.3、附 B |
| 16（2026-08-24 执行裁决） | P0 实跑验收 | mock 线协议上的 910 项测试不等于「插排能供电」：真镜像 + 真 DSH 进程 + Landlock 探针（V13）+ 一份真实 RQ 题面过门禁 + 5 份平价，为下一轮第一项，先于前端重写 | §13 P0 退出标准 |
| 17（2026-08-24 执行裁决） | 版本更正 | cordis **4.0.1**、OpenList **4.2.5**、MinerU **3.4.5** 三处更正采纳（注册表复核无误）；dsh 0.1.1-rc.2 仍为 npm 最新（08-21 后无新版、无正式 tag），D4 姿态不变，无需升级 | `deps-version.json` |
| 18（2026-08-24 执行裁决） | 审计类 | `audit:capabilities` 的 14 天新鲜度窗口**不豁免**：安排实网探测再生成，翻默认 / 发布前必须绿；`ops.test.mjs` 挂起接受「全量跑先排除」，但登记修复项（scheduler 加可注入退出或测试加超时 kill），不允许长期排除；curated 36 技能摘要重钉**接受**（显式脚本、只动摘要、安审结论不动），要求重钉输出留档 + 测试断言 diff 仅限摘要字段 | — |
| 19（2026-08-24 执行裁决） | 工程加固 | ESM 星导出重名静默 `undefined` 的断言防回归**保留**，并建议 domain 入口禁 `export *`（lint）；ESLint 8 不识别 import attributes：`config.mjs` 用 `readFileSync`、domain 保留 import 形式的现状**接受** | §14 |
| 20（2026-08-24 执行裁决） | 运行状态词汇 | **公开 `status` 四值不变，九态改为投影 `phase`**（`RUN_PHASES`，`runPhase()` 纯函数派生、不存储；`/api/runs` 与 `run/state` 加 `phase`；折叠时相序断言只计数不抛；`partial` 交付写 `succeeded + partial` 而非 `failed`）——不动评测 / e2e / 历史账本 | §7.1.1 |
| 21（2026-08-24 执行裁决） | 装饰性配置类 | **domain `typecheck` 分段接线**：先修 clinicalEvidence 之外的 ~17 个错，`typecheck:domain` 进 `test:web`，`clinicalEvidence.mjs` 以 tsconfig `exclude` 暂缓并用**钉数测试**锁死（exclude 恰一个文件、点名），126 个错的清偿单列；`@deepseek-ai` 禁令以 **grep 测试为主承力**（全仓走查含 JSDoc `import(` 形，排除 harness-port），ESLint 配置补齐为辅并让 packages 的 lint 脚本停止报错；screening 参数经 profile patch 从 `config.mjs` 派生，`ledgerPath` 过 `isProtectedWritePath`；口令包 `maxmem` 按 header 的 N·r 推算但**设上限**（默认 1 GiB，超出拒开并给专用错误码）——header 可控的资源分配必须有界 | §29.4、§28.3、§10.4 |
| 22（2026-08-24 用户拍板） | 生态优先 | **尽可能利用 DSH 插件 / 技能生态，默认姿势是采用而不是设防**：三档取舍 直接用 > 小改 > 仅护城河（统计引擎、证据规则、契约）自建；社区技能零适配进 `skills/community` 根；「不整套挂载运行别人的 preset」只是 DSH 机制约束（一会话一组合），源码层四条融合路径照用——抄 persona、抄行配置、拎随包技能、整只映射成 capability（委派形态一次运行可组合多只，比原生 preset 更好用）；插件按 npm 依赖对待（pin + 冒烟 + 夜间矩阵），**不设审批流、不新增阻断点**（§29.3 的 6 个不变，生态接入不经过它们）；进厂检验用工具自动化（guardwall / dep-audit 类）而非流程。首扫清单：`plans/2026-08-24-dsh-ecosystem-adoption-shortlist.md` | §21.8、§9.2、V41 |
| 23（2026-09-01 用户拍板） | 窗口执行 | **①「错位的检查」按检查处理，不按门处理**：hosted e2e 是**部署门**，只该证明确定性的平台性质（就绪、内核启用、运行走完、交付物落地、回执一致、门禁执行、账本正确）。signals.csv **有没有数据行**在检索两轮都够到 openFDA 的前提下只剩模型习惯，属**内容**性质，归契约或评测——既非确定性又硬阻断，违反的是阻断点预算规则本身。裁决：e2e 里**降为 notice 并带观测值**（不是删掉）；第四道门的达标改为「全部机械判据绿 ＋ notice 如实记录」，且窗口前须在降级后的判据集上**拿到一次全绿**（降级不豁免「没全绿过」这件事）。真正的落点若要要求，是 `adr-analysis-report` 的**契约**（工作区产物机械可判），**但分布之前不加新阻断**。 **②附 B 分两步，#15「同一 PR 删」的前提已被实测推翻**：该前提是「删除＝移走死代码」，实测 `@ai4s/sdk` 缠进 10+ 个 desktop 文件含 `runtime.ts` 核心，是数小时的前端运行时层重构；更要命的是**翻默认那一刻旧栈就是回滚杆**（`OPEN_SCIENCE_RUNTIME_KERNEL=opencode` 与旧 sessionView 是仅有的两根），同 PR 删除等于在切换的同一秒拆掉全部回滚手段。改为：**PR-flip**（只翻默认 ＋ 最小胶水 ＋ 钉死「默认＝dsh」的测试；附 B 原样保留、不可达）→ **静养 72h**（旧栈冻结：不接受任何功能改动、无人维护——冻结的回滚杆不是双栈）→ **PR-delete**（附 B 五棵树 ＋ sdk 解缠，独立评审与测试，删完 grep 断言零残留）。**第二步是有日期的硬承诺**：静养满后 3 个工作日内，日期写进 STATUS 防漂移 | §16 #15 改判、§29.3、附 B |
| 24（2026-09-01 用户拍板） | 门禁归属 | **①的分界线不是主题，是「平台性质 vs 内容性质」**：部署门只断言**我们代码的**性质，模型产出的性质归契约与评测。按此把记忆两条判据切开，与 signals 的处置并不矛盾：**`evidence_invalid` 保留硬阻断**——客户端已在发送边界执行服务端自己的界（quote 1..4000 **字节**、sourceType 1..64、sourceRef 1..500），**模型产出什么都不该再触发 400**；它再响，响的就是我们客户端的真缺陷（正是这次抓到的那类跨语言边界错），降级等于把刚证明了价值的哨兵摘下来。**`extraction_missing` 一分为二**：**机械半保留硬阻断**——「抽取管线执行了并得到合法应答」，客户端可判的证据是**该运行的 run_summary 记录存在**（`recordRun` 在抽取之前写它，它在＝管线跑过且记忆服务收下了写入）；少了这半，「空」与「确实没有」就从这个口回来了。**内容半降为 notice 带观测值**——`extracted ≥ 1`；实测同栈同题面连着两轮 `proposed=6/extracted=6` 与 `proposed=0/extracted=0`（两轮 `rejected=0`，即模型没给），23 条消息里没有值得记的事实是合法输出。notice 带三个数（messages / proposed / extracted），经**运行账本的 qualityNotices** 暴露（仅在 `extracted===0` 时追加，普通运行不加噪），与 signals 进**同一份分布收集**（33 篇批测顺路）；分布出来再定要不要在哪一层（契约？技能正文？）提要求。**执行要求同①**：notice 的观测值必须打进 e2e 输出与窗口清单，不是删掉 | §16 #23、§29.3 |

---

## 17. 第二轮复审（2026-08-22，联网 + 源码）：缺口与修订

复审方法：(a) 重新检索 DSH 的发布记录、社区插件与容器内沙箱实践；(b) 用本地源码逐条验证 v2 依赖的每个假设；(c) 按「运行时 / 接线 / 编排 / 门禁 / 安全 / 运维 / 产品」七个维度过一遍 v2。结论：**架构不变，发现 9 处缺口（3 处会在 P0 就撞上），已全部写回对应章节**；另有 6 条假设由「待核」转为「已核」（§15）。

### 17.1 新核实的事实

| 事实 | 来源 | 影响 |
|---|---|---|
| 发布节奏未变：rc.7（08-17）→ rc.8（08-19，**SQLite 存储格式不兼容**、`Code mode` 改名 `PTC mode`、Claude Code/Codex 子代理改为 bundle）→ 0.1.1-rc.1/rc.2（08-21）；仍无正式 tag | GitHub Releases | D4 不变；rc.8 证明「格式不兼容、无迁移路径」是常态，交付件继续以工作区文件为权威 |
| 0.1.1-rc.1 修复了 bwrap 沙箱经 `/proc/<pid>/root` 逃逸 | GitHub Releases | 安全修复会随 rc 流出，升级不能只按夜间矩阵节奏（§12.4） |
| `spawn` 子代理 provider 声明 `{ outputSchema, depthLimit, toolFilter, persona }` 全支持；子代理继承父代理 `cwd`、模型与血统，无独立工作目录 | `dsh:packages/subagent/subagent-spawn-in-process/README.md:15,55` | §9.5 的委派可行；交付物目录需约定（缺口 G3） |
| 子代理的会话日志在首个回合内带 `subagent/descriptor` 持久事件（`foldSubagentDescriptor()`）；`agent/session-start.source` 只有 `startup / resume / clear / compact` | `dsh:packages/subagent/subagent/src/descriptor.ts:28-47`、`dsh:packages/core/agent/src/runtime-types.ts:61` | 根/子判定的机制（§9.7） |
| `turn/end.reason.kind` 枚举：`completed / aborted / blocked / error / max-tokens / interrupted` | `dsh:packages/core/session/src/types.ts:155-171` | §6.4 映射表修正 |
| `ApprovalPolicy = 'ask' / 'never'`，`never` = **自动拒绝**一切 ask 而非自动放行；`permission-presets` 表可配置，出厂两项 `workspace-write+ask`、`danger-full-access+never` | `dsh:packages/interaction/user-approval/src/index.ts:88-94`、`permission-presets/README.md:4` | 托管 = `workspace-write + never`（§11） |
| DeepSeek 适配器请求体字段与我们网关白名单逐项相符；头部 `user-agent`、`x-deepseek-harness-{user-id,session-id,compact}`；图片走 `{baseURL}/files` | `dsh:packages/llm/llm-deepseek/src/{types,adapter}.ts`、`modelGateway.mjs:33-51` | 文本链路零改动；图片链路是缺口 G5 |
| apiproxy 线协议：`session.create{workspaceId?, cwd?, sessionId?, agentPreset?}`、`session.prompt{sessionId, mode: 'queue' / 'steer', content: PromptContentPart[]}`、`cancel{sessionId}`、`fork{sessionId, atSeq?}`、`history{sessionId, beforeSeq?, maxMessages?} → HistoryEntry{event, view?}`；`events.mux({since})` 可按 seq 续订 | `dsh:packages/host/apiproxy/src/api/{sessions,events}.ts` | 适配器可写；**没有 `system` 参数**（缺口 G1） |
| 社区已有同类做法：`dsh-subagent-tools` 用 `cordis.patch.yml` 禁用出厂 `tool-subagent` 行、注入带 per-call `persona / toolFilter / model` 覆盖的版本，`@preset:` 引用只是读本地 preset 文件取 persona 文本；它以 `peerDependencies: ^0.1.0-rc.6` 在版本越界时**拒绝加载** | github.com/lynx-gt/dsh-subagent-tools | 验证了 §9.5 的可行性与 §12 的「越界拒载」做法；DSH Hub 已有 1,550 个插件，含文献 RAG（`kb-rag`、`dsh-library`）、安全门（`dsh-clawrouter`、`safety-net`）、记忆（`dsh-mneme` 等） |
| Landlock 在容器内可用的三个前提：内核 ≥ 5.13、Docker ≥ 23.0（默认 seccomp 自 moby PR #43199 起放行 `landlock_*`）、`no-new-privileges`；bwrap 需要非特权 user namespace，在 Docker 默认 seccomp 与 Ubuntu 24.04 AppArmor 限制下不可用 | moby/moby#43199；本机 `apparmor_restrict_unprivileged_userns = 1`、内核 6.8 | 缺口 G2 |
| DSH 的 guard 包只有超时与重复调用提醒，没有运行预算 | `dsh:packages/guard/` | 缺口 G6 |
| NMPA 2021 年第 47 号《人工智能医用软件产品分类界定指导原则》：处理**医疗器械数据**且用于辅助决策（用药指导、治疗计划）→ 第三类；处理非医疗器械数据（患者主诉、检验检查报告结论、文献）→ 原则上不作为医疗器械管理 | nmpa.gov.cn 2021-07-08 通告 | §9.9 补充 |
| 医学 GEO 的可核实实践：schema.org `MedicalWebPage` / `MedicalCondition`、`llms.txt`、答案块 + FAQ、作者资质与更新日期（E-E-A-T）、每篇 ≥ 5 条权威引用、直接向 AI 引擎提问以监测引用 | 多家 2026 年行业指南（Conductor 基准：48.7% 医疗类首页查询触发 AI Overview） | §9.11 |

### 17.2 缺口与修订

| # | 缺口 | 严重度 | 修订（已写回） |
|---|---|---|---|
> **生态借鉴（G1 视觉适配器，2026-08-25）**：`good-boy4069/dsh-vision-guard`、`liustack/modlens`、auto-vision 系做的正是"给纯文本模型架一座透明的视觉桥"——模型不知道自己没有视觉，工具替它看。我们的 G1 适配器要做的是同一件事，可直接借的是它们的**降级语义**：桥不可用时不是报错，而是把"这一步没有视觉"写成一条可见事实带进上下文，让模型据此调整结论强度——与 §8 的"降级要留名"同源。

| G1 | **研究上下文没有入口。** 今天每次派发把 `prepareResearchContext` 生成的知识库切片 + 记忆 + 能力目录作为 `system` 发给 OpenCode；DSH 的 `session.prompt` 只有 `content`，没有 `system` | **P0 必撞** | 控制面派发前把上下文写入工作区 `.evimed-brief/context.md`；插头在 `agent/session-start` 读取并 `agent.inject()` 成一等 `user/message`（模型可见 ⟺ 已记录）；`<evimed-knowledge>` / `<evimed-memory>` 包裹规则照旧（§6.4、§7.4） |
| G2 | **容器内沙箱未落实。** v2 写「bwrap 私有 PID 命名空间」，但容器里 bwrap 不可用；若 Landlock 也不可用，DSH `bash` 工具整体 fail-closed，运行时看似健康实则不能执行任何命令 | **P0 必撞** | 明确以 Landlock 为后端；镜像/宿主前提写进 §11 与 §15（V13）；启动自检增加「经 `ctx.shell` 执行一条空命令」并要求 `enforcement: 'full'`（§5.6、§11） |
| G3 | **子代理写权限与目录冲突。** v2 §9.5 只给子代理「只读文件工具」，但它必须写交付物；多个子代理共享父代理 `cwd`，互相覆盖无防护 | **P0 必撞** | 子代理工具集加 `write / edit / bash`；约定每个交付物写在 `deliverables/<deliverableId>/`，契约校验器只认该目录，回执摘要防事后改写；`writeScopes` 等 agentTeams 转正后再上（§9.5） |
| G4 | **托管审批语义写反的风险。** v2 说「自动放行」，而 DSH 只有 `ask / never`，`never` 是自动拒绝 | 高 | 托管 = `workspace-write + never`：沙箱内读写本不需要审批，需要审批的只有「突破沙箱的重试」，拒绝正是想要的；新增 `permission-presets` 表项 `evimed-hosted`（§11、§15 V3） |
| G5 | **图片输入链路。** 适配器把图片上传到 `{baseURL}/files`，我们的网关只有 `/chat/completions`；`/files` 404 时没有回退（inline base64 只用于配额恢复） | 中 | P0 托管文本-only（UI 暂不收图片）；P2 网关透传 `/files`（体积上限、按项目计量）或插头在 `agent/request` 改写为 `image_url`（§6.4、§15 V14） |
| G6 | **没有运行预算。** DSH 无步数/Token/子代理数上限；控制面只有 15 min 停滞与 4 h 总时限 | 中 | 预算守卫（定版并入 `run-policy`）：`agent/pre-step` 上按 `assistant/message.usage` 累计 token、步数与子代理数，超限 `reject` 并 `inject` 说明；上限来自能力清单与配置（§7.4、§7.5） |
| G7 | **根代理工具集限制的判定时机。** v2 §9.7 写在 `agent/session-start` 判定根/子，但该事件的 `source` 不含这一信息 | 中 | 改为首个 `agent/pre-step` 时看日志有无 `subagent/descriptor`；P0 不限制根代理（全目录可见），P1 按 `tokenMeter` 实测再决定（§9.7） |
| G8 | **前端没有运行树。** 统一编排后一次运行包含编排器 + N 个子代理 + 交付物回执，现有 `LiveSessionPage` 只有单会话流 | 中 | P2 交付「运行树」视图：数据来自 `events.mux` 的 `session/jobs`、`subagent/descriptor`、我们的 `plans` 表；旧 OpenCode 会话不迁移、只读归档（§13） |
| G9 | **安全修复节奏与备份范围未写。** | 低 | §12.4：安全修复当日评估、不等夜间矩阵；§11：`$DSH_HOME/{sessions,attachments,storages}` 纳入项目导出与备份 |

### 17.3 复审后未发现缺口的部分

控制面租户与项目隔离、三个内部网关（文本链路）、账本折叠与修复回环、`@evimed/domain` 单实现门禁、MCP 挂载、能力清单生成、按产出绑定契约、Agent Teams 延后、版本同步机制（pin / 缝清单 / 启动自检 / 夜间矩阵）——这些在源码与社区实践两侧都没有发现反例。`dsh-subagent-tools` 以 `peerDependencies` 越界拒载的做法与 §12 一致，可直接采用。

### 17.4 定版前第三轮复审（2026-08-22 晚）：合并进正文的修订

两位审查代理逐条对照四份资料与源码后的结论已全部写回正文；此处只记录**改了什么**，便于审阅 v2 → v3 的差异：

| 类别 | 修订 |
|---|---|
| 事实错误 | `session.status` 不存在（改用 `events.host`）；`reportDelivery` 是部署级策略不是按调用选择；headless bundle 无 `agent-presets`（一致性套件改用 web-app profile）；`.dsh/skills` 自动发现会把上传文件当技能（`includeDefaultRoots: false`，方法经 `ctx.skills.register`）；`pnpm pack` 不含 `workspace:*` 依赖（V17） |
| 前后不一致（30 处） | 产品线 preset / 专科 run / `effectiveAgentId` / preflight.py 保留 / 子代理只读 / session-start 判根子 / Memos 去留 / 运行树阶段 / Tauri 时点 / 网关数量 / 引用编号等，全部按 §9、§16、§19 统一 |
| 冗余收口 | 计划只有 `task-plan.json`（去 `tool-todo`，`plans` 表降为索引）；回执只由提交写；`claims` 表删除（matrix 即是）；上下文只在首个 `agent/pre-step` 注入一次；`evimed_preflight` 删除；语义审查只在控制面一处；插件清单只在 §5.3；限额只在 §10.4；`gate + orchestration + budget` 合并为 `run-policy` |
| 架构修正 | 裁定是返回值不是 `deny`；`harness-port` 拥有类型并做转换；控制面只读 `.evimed-run/state.json` 投影；路径守卫保护题面与回执；直接回答也过安全扫描；停滞信号含子代理活动；子代理失败显式传播并自动重派一次；自检分门禁级 / 增强级；金帧契约测试；矩阵临时放宽 peer |
| 亮点融合 | Apodex 的 clarify 必经（`clarifications[]`）、验证门四指标（notice）、report 保底（`delivery-summary.md`）、证据 `stale` 与 `rejected` 传播、审查者附加接地工具、撤稿机械检查；用户方案的「高质量回答写入记忆复用」「先查记忆再检索」、插件分级兜底、GEO 内容库与品牌实体档案；母本规范的错误码统一信封、复杂度阈值、PR 清单 |

---

## 18. 前端适配方案

### 18.1 结论

**保留并改造现有 React 应用；不用 TUI 作为产品界面；DSH 自带的 Web 客户端只用于本地 profile 与开发调试。** 后端换内核之后，前端要换的是**词汇表**（从 OpenCode 的 message/part/SSE 换成 DSH 的 session event / subagent / workflow / deliverable），不是框架。

| 选项 | 事实 | 判断 |
|---|---|---|
| A. 换成 DSH 的 TUI（社区有 `dsh-tui`、`boxeryao/deepseek-harness-tui`、`openma-ai` 等 Claude Code 风格终端） | 都是开发者终端：流式输出、工具卡片、审批对话框、斜杠命令 | 我们的用户是临床与科研人员，产品是托管 Web；TUI 只适合我们自己做运维调试。**不采用** |
| B. 嵌入 DSH 的 Web 客户端（`dsh-client-*` 38 个浏览器插件：`ui-conversation`、`ui-tool`、`ui-subagent`、`ui-workflow-run`、`ui-jobs`、`ui-trajectory`、`ui-deliverables`、`ui-goal`、`ui-plan`…，slot 注册 + conversation node 扩展） | 它是一个完整的单用户本地产品 UI：自带设置/凭据/工作区选择页，挂在 `#root` 的独立 SPA；`__DSH_TRANSPORT__` 只覆盖模块加载（`loadBundle`），**不覆盖 API 载体**（`dsh:packages/client/web/src/boot.ts:59-103`），没有受支持的页内嵌入途径；iframe 可行但要在我们的代理上屏蔽 `settings.* / credentials.* / host.*` | 设计语言、i18n、四态纪律、无障碍都是 DSH 的不是我们的；多租户、项目、文件、胶囊、证据台账这些核心面它没有。**托管面不采用**；本地 profile 原样使用（§6.8） |
| **C. 改造现有 React 应用（采用）** | 现有前端 ≈ 14.6k 行 TSX + 11.6k 行 lib；OpenCode 耦合集中在 `lib/runtime.ts`（2,027 行）与 `LiveSessionPage` + `components/thread/*`（≈ 1.5k 行）；Files / Notebooks / 16 个 inspector / 命令面板 / 设置 / 登录与内核无关 | 只重写会话层与运行视图，其余保留；设计令牌、简体中文基线、四态纪律不变 |

### 18.2 前端要呈现的新对象

| 对象 | 数据来源 | 呈现 |
|---|---|---|
| 回合与步骤 | `turn/*`、`step/*` | 按步骤分组的流；回合状态（`completed / aborted / blocked / error / max-tokens`） |
| 助手流式输出与推理 | `assistant/chunk`（text-delta / reasoning）、`assistant/message{usage}` | 流式尾部隔离；推理可折叠；每步 token 用量 |
| 工具调用树 | `tool/call` + `tool/result` + 宿主算好的 `view?: ToolEventView` | 卡片：参数、结果、耗时、沙箱拒绝标记；嵌套子调用 |
| 子代理 | `subagent/descriptor`（子会话首回合）、`events.mux` 的 `session/jobs` 帧、`.evimed-run/state.json` 投影（§7.2） | **运行树**：编排器 → 子代理（标签、能力、状态、回报）→ 交付物；点开子代理即其只读转写；「从此步分叉」（`session.fork{atSeq}`） |
| 工作流运行 | `tool-workflow/*` 事件 | 按阶段分组的嵌套折叠 |
| 计划与交付物 | `task-plan.json`、`delivery-receipt.json`、门禁判定 | 计划清单（planned / delegated / submitted / accepted / rejected）；每件交付物的回执摘要与通过/拒绝理由 |
| 证据台账 | `.evimed-run/state.json` 投影 + 工作区 matrix / ledger / question-coverage（经控制面） | claim ↔ 来源 ↔ 引文的绑定视图；缺口、矛盾、`stale` 证据 |
| 压缩与预算 | `compaction/*`、`run-policy` 的预算注入 | 压缩标记行（替换条数、估算 token）；预算进度 |
| 系统注入的上下文 | `user/message{source.kind: 'plugin'}`（题面上下文、胶囊、审查建议） | 可折叠的「系统注入」行，与用户消息区分 |
| 审批与提问 | `approval/requested`、`question/requested` 帧 | 本地 profile 才有审批；`ask_user_question` 托管可选开启 |

### 18.3 改造范围

| 文件 / 区域 | 处置 |
|---|---|
| `lib/runtime.ts`（2,027 行，OpenCode store） | **重写**为 `lib/runStream.ts`：消费控制面 SSE `GET /api/runs/:id/events`（§18.4），按 `since` seq 续订；不再知道任何内核 |
| `LiveSessionPage.tsx`、`components/thread/{Composer, ToolGroup, InteractionPrompt, WorkspaceChip, atoms}` | **重写**：按 §18.2 的对象渲染；Composer 去掉 OpenCode 审批模式 |
| `RunsPage.tsx`（1,113 行） | **扩展**：运行树 + 交付物回执 + 门禁判定 + `verification` 三值 |
| `AgentsPage.tsx` | **改名** 能力模板：`/api/capabilities`，点选 = 预填题面并点名能力（§9.8） |
| `MemoryPage.tsx`（618 行） | **替换**为胶囊页面（§19） |
| `SettingsPage.tsx`（1,150 行） | **清理**：删除 OpenCode / 审批模式 / 运行时 URL 卡片；保留账号、项目、资源、就绪 |
| Files、Notebooks、16 个 inspector、命令面板、登录、`AppShell`、设计令牌 | 不动 |
| `packages/sdk`（`OpenCodeClient`） | 删除（附 B） |

### 18.4 控制面 → 浏览器的事件契约

控制面订阅每个项目容器的 `events.mux`，归一化后经自己的 SSE 转发；浏览器永远不直连 DSH：

```text
GET /api/runs/:id/events?since=<seq>          text/event-stream，可续订
  run/state        { state, errorCode?, verification?, attempts }
  run/event        { seq, time, event: RunEvent }            ← 控制面解码为 @evimed/domain 的 RunEvent 联合（文本 / 推理 / 工具 / 子代理 / 工作流 / 压缩…）；轨迹检查器用带 raw 的变体
  subagent/update  { childSessionId, label, capability, status, report? }
  deliverable/update { id, contractKind, status, receipt?, issues? }
  evidence/update  { evidenceId, status, sourceId }
  budget/update    { steps, tokens, children, limits }
  approval/requested | question/requested                  ← 仅本地 profile / 开启提问时
```

事件在控制面解码为 `RunEvent`，浏览器不消费 DSH 词汇（§14 规则 12）；`raw` 变体只供轨迹检查器；未知事件计数并可见。

### 18.5 从 DSH 客户端借鉴的呈现模式（借模式，不借代码）

- `ui-conversation`：按步骤摘要分组的流、流式尾部隔离、压缩标记行不替换上文。
- `ui-tool`：工具调用树 + 按工具名键控的专用视图（bash 输出尾、文件 diff、检索结果表）。
- `ui-subagent`：会话头的血统面包屑与子代理数；一次性子代理的转写只读并标明「已完成的执行记录」。
- `ui-workflow-run`：按阶段分组的嵌套折叠，成员启动才建组。
- `ui-deliverables`：回合尾的「产出文件」行，以工具自己报告的路径为准而非模型散文；正文里的文件名内联引用可点击。
- `ui-trajectory`：回合/步骤分隔的事件账本 + 选中项检查器（token、耗时、输入输出）。

我们要加、DSH 没有的：交付物回执与门禁判定、证据台账（claim-来源-引文绑定）、胶囊时间轴。

### 18.6 本地 profile 的前端

`evimed-web` 用 DSH Web 客户端原样；P3 可选：把运行树 / 证据台账 / 胶囊三个组件做成 DSH 客户端插件（`register({ name, children, store, inject }, Component)` 的 slot 注册 + `ConversationNodeDefinition`），React 组件与托管面共用。

### 18.7 分阶段（与 P0–P3 并行的 F 轨）

| 阶段 | 交付 |
|---|---|
| F0（随 P0） | `runStream.ts` + 最小会话视图（文本、推理、工具卡片）——P0 验收用 |
| F1（随 P1） | 运行树、交付物与回执、能力模板页、设置清理 |
| F2（随 P2） | 证据台账、计划视图、审批/提问、轨迹检查器、预算 |
| F3（随 P3） | 胶囊页面与会话内记忆提示（§19.19）；可选的 DSH 客户端插件 |

---

## 19. 记忆胶囊（Memory Capsule）

### 19.1 一句话

> **每个用户一个胶囊：把「他的资料」（知识库）、「关于他的事实」（记忆）、「他做事的方法」（方法论）蒸馏到一起，带时间轴、可追溯、可分享、即插即用；Agent 做任何任务时都先戴上这个胶囊。**

与上位方案的关系：07-16 方案第 10 条「最小 SaaS 状态、资料库和 Memos 映射」升级为两层记忆：同一 MemOS 底座上，第一层是会话 cube（自动），第二层是胶囊 cube（蒸馏，§19.16）。

### 19.2 研究依据（取什么、不取什么）

| 来源 | 取 | 不取 |
|---|---|---|
| 《A Survey of Agent Memory in the Second Half》（Huang, Zhang, Liang 等，arXiv 2602.06052，2026-01，2026-08 修订） | 五种记忆机制 **sensory / working / episodic / semantic / procedural** 作为胶囊分层；「长期记忆把经验巩固为可复用的知识与技能，形成自我改进的回路」；「portable, shareable agent skills」生态 | — |
| Agent Workflow Memory（Wang, Mao, Fried, Neubig，ICML 2025） | **从轨迹归纳可复用流程**——我们的「方法论蒸馏」就是把用户的成功运行与 SOP 归纳成流程 | 在线即时归纳（我们离线、带审批） |
| Agent Skills 开放标准（Anthropic 2025-12-18 开放，agentskills.io；OpenCode、Codex CLI、Gemini CLI、Copilot 等约 40 个客户端采用；DSH 的 SKILL.md 即此格式） | **方法论以 SKILL.md 存储**——胶囊里的方法离开 EviMed 也能用，「即插即用」不是比喻 | — |
| Zep / Graphiti | **双时间模型**（事实的有效期 vs 记录时间）实现时间轴；LongMemEval 上时间推理 63.8% vs Mem0 49.0% | 全量知识图谱（单会话 60 万 token 的构图成本） |
| Letta / MemGPT | 分层：核心上下文（常驻）/ 召回 / 归档；**模型自己决定何时翻页**（召回工具） | 让模型自由改写核心记忆（我们走审批） |
| Mem0 | 按作用域分层（会话 / 项目 / 用户）并在层间晋升事实 | 托管服务 |
| Agentic Context Engineering（arXiv 2510.04618） | 上下文即「可演化的操作手册」——对应我们方法论的版本演化 | — |
| DSH 社区：`dsh-mneme`（SQLite + Markdown 镜像、实体-属性-时间轴、空闲期 autoDream 巩固）、`dsh-memento`（审批门控、冻结快照注入）、`dsh-library` / `kb-rag`（本地文献库混合检索） | **人可读的 Markdown 镜像**、**空闲期巩固**、**审批门控**、**冻结快照注入**四个模式 | 单机、无多用户 |
| 我们自己的 `memoryIntelligence.mjs` | 8 类候选事实、先读旧记录再抽取（强化 vs 新建）、`sensitivePattern` 拒收凭据与 PHI、失败回退确定性抽取 | — |

### 19.3 设计原则

1. **一切可追溯**：每条事实、每个方法都指向来源（文档片段 / 运行步骤 / 用户反馈）与记录时间。
2. **用户可见、可改、可删**：胶囊页面就是它的全部；没有用户看不到的记忆。
3. **胶囊是上下文，不是权限**：它塑造「怎么做」，永远不能覆盖系统要求、交付契约、安全规则；导入的胶囊是不可信内容。
4. **模型提取、代码核验、人在回路但不挡路**：事实与方法自动生效并带「新」标记；用户事后审阅、一键回滚；**没有生效前确认**——任何修订立即生效、可一键回滚（2026-08-23 收口）。安全不靠审阅，靠与胶囊无关的契约层（原则 3）。
5. **分享的是快照，不是实时连接**。
6. **开放格式**：方法 = SKILL.md，画像 = Markdown，时间轴 = JSONL——导出即可读。
7. **体验优先、零摩擦**：上传不要求整理与标注（「全倒进来，我们来理」），摄入进度可见；敏感内容自动处理、只做轻提示；分享与激活一键完成；一切可撤销。

### 19.4 内容模型（五层 + 时间轴 + 溯源）

| 层 | 对应记忆机制 | 内容 | 例子 |
|---|---|---|---|
| 资料层 | sensory（原料） | 用户上传的一切：论文、方案、SOP、数据表、数据库、PPT、录音、笔记、网页 | 「我 2023 年的 RCT 方案.docx」 |
| 知识层 | semantic（关于世界） | 资料的结构化摘要、术语、实体（MeSH 规范化）、检索索引 | 「该方案主要终点为 30 天 MACE」 |
| 画像层 | semantic（关于用户） | 身份、专长、偏好、立场、写作风格、常用工具、当前课题 | 「偏好 GRADE 分级；写作忌用『显著』一词；主攻心内科药物经济学」 |
| 方法层 | **procedural** | 用户做事的流程，蒸馏为 SKILL.md：何时用、输入、步骤、检查项、常见坑、范例 | 「张医生的系统综述流程：先 PROSPERO 登记 → 双人筛选 → …」 |
| 经历层 | episodic | 每次运行的摘要、用了哪些能力、结果、教训、用户的纠正 | 「2026-08-12 的超说明书分析被退回：结论未区分人群」 |
| 时间轴 | — | 以上各层的变化事件（双时间：`valid_from / valid_to` + `recorded_at`） | 「2026-06 起不再接受观察性研究作为主要证据」 |
| 溯源 | — | 每条记录的来源片段 / 运行步骤 / 反馈 id | — |

工作记忆（working）不在胶囊里——那是每次运行时注入上下文的那一部分（§19.7）。

### 19.5 数据模型（控制面 Postgres + 对象存储）

```text
capsules            (id, owner_user_id, name, created_at, current_version)
capsule_sources     (id, capsule_id, sourceType: upload|note|run|feedback|import, uri, sha256, mime, bytes, uploaded_at,
                     parse_status, derived_text_uri, restricted: bool)          -- 原料；restricted = 含 PHI/敏感，永不分享
capsule_chunks      (id, source_id, seq, text, tokens, embedding?)              -- 索引：pg 全文 + 可选向量
capsule_facts       (id, capsule_id, factKind, key, value, confidence, origin: explicit|inferred|system,
                     valid_from, valid_to, recorded_at, status: candidate|approved|retired,
                     provenance: [{source_id, span} | {run_id, seq} | {feedback_id}], sensitive: bool)
capsule_methods     (id, capsule_id, slug, title, version, skill_md, derived_from: [...],
                     status: draft|approved|retired, valid_from, valid_to)      -- SKILL.md 正文即存储形态
capsule_episodes    (id, capsule_id, run_id, summary, capabilities_used[], outcome, lessons[], created_at)
capsule_timeline    (id, capsule_id, at, eventType: upload|fact_added|fact_retired|method_created|method_revised|run|reflection|share, ref, summary)
capsule_versions    (id, capsule_id, version, manifest_sha256, changelog, created_at)   -- 快照
capsule_shares      (id, version_id, from_user, to_user, scope, token, expires_at, accepted_at, revoked_at, reshare: bool)
capsule_activations (user_id, own_capsule_id, guest_version_id?, mode: own|guest|blend, since)
```

`factKind` 在现有 8 类（profile / preference / behavior / project_fact / analysis / decision / correction / follow_up）上增加 `stance`（学术立场）、`expertise`、`method_preference`、`writing_style`、`tooling`。

### 19.6 摄入与蒸馏流水线（控制面异步作业，`TaskManager`）

> v3.3：摄入的完整设计（连接器、分流、抽取契约、审计、归并、整理台）在 **§26**；本节 S1–S6 保留为概要，冲突处以 §26 为准。

```text
上传/笔记/运行结束/反馈
  → S1 识别与去重（sha256、MIME、大小上限、病毒/可执行内容拒收）
  → S2 解析为文本 + 表格 + 图
       docx/pptx/xlsx/pdf：office 技能 + pypdf，或《文档结构化解析 API》（接口文档/多模态文档解析.md，/api/v1/extract/text/{file,url}）
       录音：经 /internal/asr/v1 网关；上游先接云 ASR API，后换自建 FunASR（paraformer-zh + fsmn-vad + ct-punc + cam++ 说话人），网关契约不变
       图片/图表：deepseek-v4-flash-vision-exp 生成描述与 OCR
       数据库/CSV/XLSX 数据：profile_dataset.py 只取 schema 与统计，原始行永不入库
  → S3 切片 + 索引（BM25 + 向量并用；向量经 /internal/embeddings/v1 网关调用外部 embedding API，服务端持钥、供应商可换；`restricted` 来源不外送、只做 BM25）
  → S4 蒸馏（DeepSeek V4 Flash，结构化输出；每一步代码核验）
       D1 文档层：摘要、主题、实体（evimed_term_normalize 规范化）、文档类型
       D2 事实层：关于用户的候选事实 + 溯源片段；先读旧记录再抽取（强化 vs 新建，沿用 memoryIntelligence）；**只处理文档与反馈来源**，对话来源由 MemOS `add` 抽取（§19.16）
       D3 方法层：从方案/SOP/论文方法节/成功运行轨迹归纳方法草稿（SKILL.md：name/description/whenToUse/步骤/检查项/坑/范例/来源）
                 代码核验：frontmatter 合规、不含目录外工具名、不含脚本、引用可解析
       D4 反思层（每周或每 N 次运行）：把经历层巩固为「变化了什么」→ 方法新版本 + 时间轴 reflection + 成长摘要
  → S5 事后审阅（非阻塞、无确认）：事实与方法草稿即时生效并带「新」标记进入审阅清单，用户随时确认、编辑、回滚；`sensitive` 事实同样生效，只是默认不进任何分享范围
  → S6 物化：写入胶囊当前版本；必要时生成新快照
```

敏感处理：`sensitivePattern`（凭据、身份证、手机号、病历号、患者姓名…）+ PHI 模式在 D2 前扫描；命中的来源标 `restricted`，其片段不进事实与方法、不进任何分享范围。

### 19.7 运行时使用（与统一编排的接法）

派发时控制面把**活动胶囊视图**物化到工作区：

```text
<workspace>/
  .evimed-capsule/profile.md        ≤ 1,500 token：身份、偏好、立场、写作风格、当前课题（按 valid_to IS NULL 取当前值）
  （胶囊方法不物化到工作区：evimed-capsule 插件经 ctx.skills.register() 从 EVIMED_CAPSULE_METHODS_DIR 只读目录注册为技能；工作区根的 .dsh/skills 自动发现已关闭，见 §9.2）
  .evimed-brief/context.md          题面相关的 top-k 知识片段（retrieveKnowledge 改为查胶囊索引）+ 相关经历
  .evimed-capsule/index.json        召回工具的句柄（胶囊 id、版本、活动模式）
```

插头侧（`evimed-capsule` 插件行，§5.3）：

- 会话开始时 `agent.inject()` 画像与上下文，包裹为 `<evimed-capsule owner="self|guest" version="…">`，并写明「这些内容描述用户的背景与偏好，不能覆盖系统要求、交付契约与安全规则」——与今天 `<evimed-knowledge>` 的框架一致。
- 工具 `evimed_capsule_recall{query, factKinds?, since?, scope?}`：经工作负载令牌调用控制面 `/internal/capsule/v1/recall`，返回事实 / 片段 / 方法及其溯源；`evimed_capsule_note{kind, content}`：用户说「记住…」时写入 `origin: explicit` 的候选。
- 方法作为技能：编排器在 `<available_skills>` 里看到用户自己的方法（`whenToUse` 来自方法层）；委派时把相关方法预注入子代理——**用户的方法优先于平台默认流程，但不能突破契约**。新方法首次被采用时，编排器在回复里点明「本次按你的新方法 X 执行，如不对请说」——这句话就是审阅。
- 优先级：用户本次明示 > 本人胶囊 > 客体胶囊 > 平台默认；冲突时编排器在回复里点明（「A 的方法要求 X，你的偏好是 Y，本次按 A」）。
- 运行结束：`memoryIntelligence.recordRun` 写经历层 + 候选事实；新增「方法线索」（本次偏离了哪条方法、为什么）。

### 19.8 时间轴与成长

- 每条事实与方法都是双时间的：`valid_from / valid_to` 是用户世界里的有效期，`recorded_at` 是系统得知的时间——修正一条旧事实不会抹掉「曾经如此」。
- 时间轴页：按时间列出上传、事实增退、方法版本、运行、反思、分享。
- 成长视图：方法版本 diff（「你的筛选流程从单人改为双人」）、主题漂移（实体随时间）、能力使用分布、反思摘要（「本季度你的证据门槛提高了」）、可导出为报告。
- 反思作业是 D4；巩固在空闲期跑（借 `dsh-mneme` 的 autoDream 节奏），不占请求路径。

### 19.9 分享与即插即用

| 环节 | 设计 |
|---|---|
| 快照 | `capsule_versions` 的一个版本 = 清单（每项 sha256）+ 内容；分享的永远是某个版本 |
| 范围 | 默认 **工作方式包**（§19.15）= 方法 + 方法依赖的知识与事实 + 工作标准与偏好 + 教训，可勾选背景知识主题与脱敏范例；可加 `+profile`（身份、课题、立场）/ `+knowledge`（全部知识摘要与片段）/ `+documents`（原文件，逐件勾选）；`restricted` 来源在任何范围都不分享 |
| 方式 | 平台内邀请（个人账户模型下的点对点分享，不引入组织模型）；`reshare` 默认 false；可设过期；撤回只影响未来版本（已接收的快照归接收方） |
| 激活 | 接收方把它作为**客体工作方式包**（只读、带来源标签）挂入：`guest`（默认激活模式）= A 的方法、标准与依赖知识生效，**我的身份、课题、知识与会话记忆不变**；`blend` = 只取 A 的方法与知识，标准仍用我的；`own` = 取消客体。融合语义见 §19.15；切换即时生效于下一次派发；审计日志记录每次激活 |
| 导出 | `capsule-<ver>.tgz`：`capsule.yaml`、`profile.md`、`methods/<slug>/SKILL.md`、`knowledge/`（可选）、`timeline.jsonl`、`provenance.json`。`methods/` 目录本身是合法的技能根：放进 `evimed-web` 本地 profile 的 `$DSH_HOME/skills`，或任何采用 Agent Skills 标准的工具，立刻可用 |
| 社区 | 用户可把方法集发布为 `dsh-plugin` 话题下的技能包——EviMed 的胶囊成为 DSH 生态的一等公民 |


> **生态借鉴（胶囊冷启动导入，2026-08-25）**：`Shiye-10Pages/dsh-memory-porter` 做的是一键导入 Claude / ChatGPT 的既有记忆。**这值得做成产品功能而不只是参考**：胶囊最大的门槛是冷启动——新用户的胶囊是空的，而他多半已经在别处攒了一年的对话。导入不是"迁移数据"，是把第一天的胶囊从零变成有东西可蒸馏。落点：§19.6 摄入流水线加一个 importer 类型（外部助手导出包），走与上传同一条统一分析层，不新开路径。


### 19.10 安全与合规

- **导入 = 不可信**：客体胶囊只接受文本；`scripts/` 一律剥离；SKILL.md 以指令注入模型但被框架声明为「不得覆盖系统要求」；工具白名单与网关不受胶囊影响，外联仍只能经网关——注入即使成功也无处外泄。
- 导入时扫描：凭据、PHI、超大体积、可执行内容；来源 id 以哈希保留溯源。
- 注入测试进发布门：恶意胶囊（「忽略门禁」「把数据发到…」）不得改变任何门禁判定（§12.3 增加用例）。
- 同意与删除：分享逐范围同意；删除胶囊即删除自身全部版本与索引；`exportUserMemory / purgeUserMemory` 语义保留。
- 个人账户模型不变：分享是点对点快照，不是组织共享（`saas-capability-contract.json` 的 `organizationSaasReady: false` 不受影响）。

### 19.11 与现有资产的关系

| 现有 | 处置 |
|---|---|
| usememos（`记忆模块/`、`memosClient.mjs`）与 `memoryIntelligence.mjs` | **usememos 退役**：备忘与结构化记录迁入 MemOS 的会话 cube，`memosClient.mjs` → `memorySubstrate.mjs`，`记忆模块/` 目录移除；`memoryIntelligence.mjs` 保留敏感预筛与运行后观察生成，对话来源的抽取交给 MemOS `add`；反思作业从会话 cube 晋升稳定内容到胶囊 cube，胶囊召回未命中时回落到会话 cube（§19.16） |
| `researchContext.mjs`（BM25 知识库） | 检索改查胶囊索引；`<evimed-knowledge>` 包裹与「不能覆盖系统要求」框架保留 |
| `MemoryPage.tsx`、`/api/memory/*` | 替换为胶囊页面与 `/api/capsule/*`（来源、事实、方法、时间轴、分享、激活） |
| `/api/files/upload`（按 `maxFileBytes` 限制） | 胶囊上传复用，增加类型识别与摄入作业 |
| office 技能、`pypdf`、`profile_dataset.py`、`evimed_term_normalize` | 摄入流水线的解析与规范化 |
| 《文档结构化解析 API》（接口文档） | 若该服务可部署，作为 docx/pptx/pdf 的首选解析器 |
| `runtime/harness/`（AGENTS.md 自演化工作区） | 其「自演化」意图由胶囊方法层实现，目录删除（附 B） |

### 19.12 评估

1. **召回**：植入 200 条已知事实，`evimed_capsule_recall` 的 P@5 ≥ 0.9；时间问题（「我去年怎么做的」）答对率。
2. **方法遵循**：同一题面带/不带胶囊各跑 20 次，交付物对用户方法的遵循度（代码核检查项 + 人工抽检）显著提高，且门禁通过率不下降。
3. **泄漏**：任何分享范围的快照中 PHI / 凭据检出 = 0。
4. **注入**：恶意胶囊对门禁判定与外联的影响 = 0。
5. **成长可解释**：时间轴事件 100% 可溯源到来源或运行。
6. **两层协同**：胶囊召回未命中时回落到会话记忆的命中率；会话记忆晋升条目的用户采纳率（被回滚的比例 < 10%）。

### 19.13 分阶段（C 轨，P1 起与主线并行）

| 阶段 | 交付 | 依赖 |
|---|---|---|
| C0 | MemOS 自托管部署（Compose：API + Neo4j + Qdrant）+ 控制面 `memorySubstrate` 端口 + usememos 迁移 + 会话 cube 自动写入 + 画像物化与注入（走 §17 G1 的 `.evimed-brief/` 路径） | P1 |
| C1 | 文档摄入（office / PDF / 文本 / 笔记）+ D1/D2 蒸馏 + `evimed_capsule_recall` + 胶囊基础页（资料、记忆、方法；随 F2） | C0、F2 |
| C2 | 方法论蒸馏（D3）→ SKILL.md 即时生效 + 事后审阅 → 写入部署指定的只读方法目录，`evimed-capsule` 经 `ctx.skills.register` 注册；编排器与委派接入；首次采用时在回复里点明 | C1、P2 |
| C3 | 时间轴与成长视图 + 反思作业（D4） | C2 |
| C4 | 分享：工作方式包闭包与脱敏、cube 导出（只含 `textual_memory.json`）、邀请、客体激活（guest / blend）、导出为技能根；注入测试进发布门 | C2 |
| C5 | 录音（云 ASR → 自建）与图像摄入、向量召回（外部 embedding API 经网关） | C1 |

### 19.14 决策记录（2026-08-22 用户拍板）

| # | 事项 | 决定 | 落点 |
|---|---|---|---|
| 1 | 记忆底座 | **MemTensor/MemOS 自托管**作为底座（用户指定；usememos 退役），部署在我们的服务器并跟版同步（§19.21）；第一层会话 cube 自动、第二层胶囊 cube 蒸馏；协同算法见 §19.22；托管面禁用云插件；官方本地插件留给本地 profile | §19.11、§19.16、§19.21 |
| 2 | 向量召回 | **用外部 embedding API**，经 `/internal/embeddings/v1` 网关（服务端持钥、供应商可换）；`restricted` 来源不外送、只做 BM25 | §19.6 S3 |
| 3 | 录音转写 | 先接**云 ASR API**，后换**自建**；两者都在 `/internal/asr/v1` 网关之后，契约不变 | §19.6 S2 |
| 4 | 分享默认范围 | **工作方式包**（方法 + 方法依赖的知识与事实 + 工作标准与偏好 + 脱敏范例 + 教训），即「展示我是如何干活的」；不只是方法 | §19.15 |
| 5 | 方法审阅 | **体验优先**：事后审阅、不挡路、可回滚；**没有生效前确认**（2026-08-23 收口去掉「轻量确认」） | §19.3 原则 4、§19.6 S5 |

### 19.15 工作方式包（workstyle pack）：分享的到底是什么

「A 把他的分享给我，我切换成 A 的，A 的偏好、想法和方法论就在我的使用里生效」——要让这句话成立，包里不能只有方法。一个人「如何干活」= 他的流程 + 流程依赖的知识 + 他的标准 + 他做过的样子 + 他踩过的坑。

| 成分 | 来源层 | 默认纳入 | 说明 |
|---|---|---|---|
| 方法 | 方法层 | ✅ 全部生效版本 | SKILL.md；可选附历史版本 |
| 方法依赖的知识 | 知识层 | ✅ 自动闭包 | 方法 `derived_from` / `depends_on` 指向的检查表、模板、参考标准（如 PRISMA 条目）、关键文献摘要、术语表 |
| 工作标准与偏好 | 画像层 | ✅ | `method_preference`、`writing_style`、`tooling`、与工作相关的 `preference` 与 `stance`（证据门槛、报告规范、写作禁忌） |
| 教训 | 经历层 | ✅ 规则化版本 | `lessons` 与 `correction` 类事实去掉项目细节后的「注意事项」 |
| 背景知识 | 知识层 | ◻ 按主题勾选 | 用户说的「记忆的背景知识」：方法闭包之外、但理解这套工作方式所需的主题包（如「心内科药物经济学入门」）；分享向导按主题列出供勾选 |
| 脱敏范例 | 经历层 / 产物 | ◻ 向导推荐、逐件勾选 | 过往交付物片段，经 PHI / 身份脱敏，作为写作类能力的 few-shot |
| 身份、课题、个人事实 | 画像层 | ✗ | `profile`、`expertise`（可选）、`project_fact`、个人纠正记录——「我是谁、我在做什么」不属于「我怎么干活」 |
| 原始文档、会话记忆 | 资料层 / 第一层 | ✗（原文件需 `+documents` 逐件勾选） | `restricted` 来源在任何范围都不分享 |

机制：

- **闭包计算**：分享向导从方法出发自动收集依赖项，展示计算出来的清单（每类计数、可展开、可勾掉），并说明每项为何被纳入（「被方法 X 引用」）；用户只在想改默认时才需要动手。
- **脱敏**：打包前跑 PHI / 凭据扫描与实体匿名化；命中即从包里剔除并在清单上标注，不弹窗打断。
- **接收方的融合语义**（「生效」的确切含义）：

| 包内项 | `guest`（默认激活模式） | `blend` |
|---|---|---|
| 方法 | 注册为技能（标注来源，§19.7）；编排器优先选用；与我的同名方法冲突时 A 的优先 | 同左 |
| 依赖知识、背景知识 | 进入召回优先级；题面相关时注入上下文 | 同左 |
| 工作标准与偏好 | **覆盖**我的同类条目 | 不覆盖，只作为「A 会这样做」出现在方法里 |
| 范例、教训 | 作为 few-shot 与注意事项注入 | 同左 |
| 我的身份、课题、知识、会话记忆 | **不变**——Agent 仍以我的身份、为我的课题工作，只是按 A 的方式 | 不变 |

- **冲突**：我本次明示 > A 的标准（guest）> 我的标准 > 平台默认；编排器在回复里点明「本次按 A 的方式：证据门槛取 A 的 RCT 优先」。
- **一次一个客体**：同一时间只激活一个工作方式包；多人「团队包」的合并留待后续。
- **即插即用**：包导出为 `workstyle-<user>-<ver>.tgz`，`methods/` 即合法技能根；放进本地 `evimed-web` profile 或任何采用 Agent Skills 标准的工具即刻可用；`knowledge/` 为 Markdown，任何人可读。
- **版本与撤回**：包是快照；A 更新后可「推送新版」，接收方选择是否升级；撤回只影响未来版本。

### 19.16 记忆底座：MemOS（MemTensor）+ 两层分工

> 术语澄清：本文此前出现的 Memos 指仓库里 vendored 的 usememos 笔记应用（`记忆模块/`）；用户所指的是 **MemTensor/MemOS**（记忆操作系统，MemOS 2.0「星尘」）。两者无关。定版：**usememos 退役；MemOS 自托管成为记忆底座**。

**核实的事实**（GitHub README、docs、Releases；vendor 数据以 vendor 标注）：

| 项 | 事实 |
|---|---|
| 身份 | Apache-2.0；Python；MemOS 2.0 Stardust，v2.0.30（2026-08-14）；README 自述「self-evolving memory OS：ultra-persistent memory、hybrid-retrieval、cross-task skill reuse」 |
| 核心抽象 | **MemCube**：可组合的记忆单元，「enabling isolation, controlled sharing, and dynamic composition across users, projects, and agents」；`GeneralMemCube.init_from_dir(dir)` / `init_from_remote_repo(repo, base_url)` / `load(dir)` / `dump(dir)`，落盘为 `config.json` + `textual_memory.json` + `activation_memory.pickle` + `parametric_memory.adapter`，加载/落盘强制 schema 一致；`CompositeCubeView` 可跨多个 cube 统一检索。**文档未给出跨用户共享协议、角色权限、版本与溯源元数据**——这些由我们的控制面负责，cube 只作传输形态 |
| 多用户 | `user_id` + `mem_cube_id`；REST `POST /product/create_cube{cube_name, owner_id, cube_id}`、`POST /product/add{user_id, writable_cube_ids, …}`、`POST /product/search`、get-all、feedback、chat（SSE） |
| 调度 | MemScheduler：异步摄入（「毫秒级延迟」），Redis 队列可选 |
| 后端 | Neo4j（community / enterprise / nebula / polardb）+ Qdrant；Redis 可选；LLM 走 OpenAI 兼容端点（`OPENAI_API_BASE`），embedder `universal_api` / ollama，`EMBEDDING_DIMENSION=1024`；Docker 镜像与 Compose |
| DSH 插件（2026-08-17） | **云插件** `@memtensor/memos-cloud-dsh-plugin`：首个模型步前召回、成功回合后写回、fail-open；**本地插件** `apps/memos-local-plugin`（`install.sh --agent dsh --profile <name>`）：挂在 `agent/pre-step` 上每个用户回合自动召回一次（≤ `recallTimeoutMs` 3,000 ms，只能调短），六个能力（`memos_search` + L1 trace / L2 policy / L3 world model / Skill / Episode 五层记忆），数据在 `$DSH_HOME/memos-plugin/{config.yaml, data/memos.db, skills/, logs/}`，Viewer `127.0.0.1:18801` 仅本机；**只支持本地 SQLite，没有指向自托管服务的选项** |
| 基准（vendor） | LoCoMo 88.83、LongMemEval 89.20、OmniMemEval 覆盖 14 个商业产品；Mem0 自报 92.5 / 94.4——都是 vendor 数字，不作为选型依据 |
| 出身 | 记忆张量（上海），中英双语文档，示例用阿里云百炼——与我们「向量召回走国内 API」的决定相容 |

**为什么选 MemOS 做底座**（而不是 Mem0 / 自建表）：

1. **MemCube 就是胶囊分享的原语**：隔离、受控共享、组合、dump/load——工作方式包的记忆部分可以直接是一个导出的 cube，不用我们发明快照格式。
2. **已经是 DSH 生态的一员**：官方插件走 `agent/pre-step` 前召回 + 回合后写回，与我们 §19.7 的接法同构；本地插件的六个记忆工具可作为参考实现。
3. **异步调度**与我们「记忆写入不在请求路径」的规则一致。
4. **自演化定位**（cross-task skill reuse）与 §19.17 的方向一致，但我们的方法层仍以 SKILL.md 为权威形态（开放标准、可出 EviMed）。

代价与对策：后端比 Mem0 重（Neo4j + Qdrant + Redis vs 一个 pgvector）→ 以 Compose 作为控制面旁的独立栈，纳入备份与就绪探针；项目年轻 → 控制面只经一个窄端口 `memorySubstrate`（`add / search / listCubes / createCube / dumpCube / loadCube`）访问，Mem0 作为同端口的第二 provider 留作退路；**托管面禁用云插件**（PHI 不出境），**官方本地插件只支持本机 SQLite**，所以托管面的召回与写回由我们的 `evimed-capsule` 插件经控制面 `/internal/capsule/v1` 访问自托管 MemOS（已核，原 V17）；官方本地插件在本地 `evimed-web` profile 原样可用。

**两层分工（在同一底座上）**：

| | 第一层：会话记忆 | 第二层：记忆胶囊 |
|---|---|---|
| 在 MemOS 里的形态 | 每用户一个 `conversation` cube：每次运行后异步 `add` 压缩观察与候选事实（MemOS 自带抽取 + 我们的敏感预筛） | 每用户四个受管 cube：`profile`、`knowledge`、`methods`、`episodes`，由蒸馏作业写入，元数据带 kind / valid_from / valid_to / provenance |
| 在控制面 Postgres 里的形态 | 无（MemOS 即权威） | 产品账本：`capsule_sources`（文件与解析状态）、`capsule_methods`（SKILL.md 权威文本，MemOS 只存摘要供召回）、`capsule_timeline`、`capsule_versions`、`capsule_shares`、`capsule_activations` |
| 怎么读 | `search(user_id, cubes=[conversation])`，相关性 + 时间 | 画像常驻注入；方法以技能形式可见；`evimed_capsule_recall` → `search` 跨四个 cube |
| 晋升 / 回落 | 反思作业从 `conversation` 挑稳定内容晋升到四个受管 cube | 胶囊 `search` 未命中 → 自动回落到 `conversation` cube（兜底） |
| 分享 | 不分享 | 工作方式包 = `methods` 的 SKILL.md + 依赖知识的 cube 导出（`dump`）+ 我们的清单与脱敏；**只传 `textual_memory.json`**——`activation_memory.pickle` 与 `parametric_memory.adapter` 在加载时可执行代码，一律剥离；接收方 `load` 为只读客体 cube，用 `CompositeCubeView` 与自己的 cube 统一检索 |

运行时拼装不变（§19.7）：派发前注入 = 胶囊画像 + 题面相关的会话记忆 top-k + 工作方式包（如有）。

**与本地 profile 的关系**：`evimed-web` 可直接装 MemOS 本地插件（100% 本机），胶囊导出的 cube 与技能根在本地同样可用——同一个插座，两种插排，记忆也跟着走。

### 19.17 平台级自演化：EviMed Science 自己也在学

胶囊让**用户**越用越顺；下面三个回路让**平台**越用越强。三者都遵守同一条纪律：模型提出、代码核验、人审后生效、评测不退化。

| 回路 | 输入（执行反馈，无需标注） | 机制 | 产出 |
|---|---|---|---|
| L1 用户回路 | 用户的资料、运行、纠正 | §19.6 的反思作业 | 胶囊的事实与方法版本 |
| **L2 能力手册回路**（借 Agentic Context Engineering：上下文是「不断演化的操作手册」，用**增量 delta** 而非整篇重写，避免「简洁偏置」与「上下文塌缩」；ACE 在无标注、只用执行反馈的条件下报告 agent 基准 +10.6%） | 门禁判定、修复回合、判分器 notice、用户纠正、交付物被退回 | Generator = 真实运行；Reflector = 把失败模式归纳为「坑 / 检查项 / 步骤修订」；Curator = 生成带来源（run id）的 **delta 条目**追加到能力的 SKILL.md，代码核验（frontmatter、不削弱契约、不引入目录外工具），维护者批准后发新版本；31 份 RQ 平价语料不得退化 | 能力清单与技能的版本演化——把 8 月份团队手工做的「30 份交付 → 104 条发现 → 规则」变成常态作业 |
| L3 跨用户回路（opt-in） | 匿名化的方法模式与结果统计（采纳率、通过率、回滚率） | k-匿名阈值之上聚合；只用模式不用原文 | 平台方法模板、能力建议、「工作方式包」榜单（采纳数 × 通过率）——网络效应 |

另有 L0：门禁自身的演化——被退回的交付物直接成为新的机械检查项候选（现状做法，写入发布流程）。

边界：L2/L3 不改模型权重、不做训练；它们改的是手册与模板，因此每一步都可读、可 diff、可回滚。

### 19.18 参考产品与借鉴点

| 产品 / 功能 | 成熟在哪 | 我们借什么 |
|---|---|---|
| ChatGPT Memory（Settings → Personalization → Manage memories；对话中的「Memory updated」提示） | 记忆是一张可读的清单，可逐条编辑删除、可整体关闭；更新时轻提示不打断 | 对话内的「本次学到」卡片 + 记忆清单页 |
| Claude Memory（2026-07 起由单一滚动摘要改为**可编辑条目**；团队记忆） | 条目化、可编辑、作用域（个人 / 项目 / 团队） | 画像改为条目化区块，而非一整篇 profile.md |
| Claude Projects / ChatGPT Projects | 项目指令 + 项目知识文件，范围清晰 | 第一层的项目作用域工作笔记 |
| NotebookLM（上传资料 → 有引文的回答；分享笔记本：完整访问 vs **仅聊天访问**；公开笔记本） | 「把资料倒进来」的零摩擦入口；分享粒度区分「可用」与「可下载」 | 资料面板与摄入体验；工作方式包的 `+knowledge`（可用）与 `+documents`（可下载）之分 |
| 自定义 GPT（指令 + 知识文件 + 动作，链接 / 商店分享） | 「把我怎么干活打包给别人」的最成熟形态；教训：知识文件可被对方索要下载 | 工作方式包 = 「一个关于我如何工作的 GPT」；默认不含原文件正是为了这个教训 |
| Letta ADE（核心记忆区块可视、可编辑、即时生效） | 记忆不是黑盒，是几块命名的可编辑文本 | 画像区块 UI：identity / preferences / current_focus / working_notes |
| claude-mem（按 ISO 周生成时间线章节；搜索 → 时间线 → 细节的渐进披露） | 时间轴可读、可导航 | 时间轴页与「成长回顾」 |
| MemPalace（逐字抽屉 + 摘要柜；启动只占 170 token） | 原文不丢；常驻上下文极小 | 第一层保留原文；画像区块 ≤ 1,500 token |
| Mem0（作用域与仪表盘） | 作用域即 API 参数 | `memorySubstrate` 端口的第二 provider / 退路（§19.16） |
| Elicit（结构化抽取列）、Zotero（文献库）、Consensus（证据计量） | 研究资料的结构化 | 知识层的结构化事实与证据视图 |
| Strava / Spotify 的年度回顾 | 成长感来自周期性回顾 | 「科研回顾」：季度 / 年度的方法变化与产出 |

### 19.19 交互设计：让两层记忆看得见、管得住、不打扰

**原则**：透明（每条记忆可见、可溯源）、可控（一键撤销）、轻（提示不打断）、成长感（时间轴与回顾）。

**胶囊页面结构**（替换 `MemoryPage`）：

| 区域 | 内容 | 借鉴 |
|---|---|---|
| 总览 | 画像区块（identity / preferences / current_focus / working_notes，可编辑即时生效）+ 健康度（资料 / 事实 / 方法计数、最近反思、待审阅数）+ 当前激活的工作方式包 | Letta ADE |
| 资料 | 拖拽上传区（「全倒进来」）+ 摄入进度 + 每份资料的蒸馏结果（摘要、产出的事实与方法线索、敏感标记） | NotebookLM |
| 记忆 | 事实清单：按类别 / 时间 / 来源筛选；「新」标记；一键确认 / 编辑 / 删除；点击跳到来源片段或运行步骤 | ChatGPT / Claude |
| 方法 | 方法卡片：版本、来源、`whenToUse`、使用次数、最近采用的运行；版本 diff；回滚；「导出为技能包」 | — |
| 时间轴 | 纵向时间线（上传 / 事实增退 / 方法版本 / 运行 / 反思 / 分享），按周章节折叠；「科研回顾」生成 | claude-mem、Strava |
| 分享 | 三步向导：选范围（默认工作方式包）→ 预览自动计算的清单（每项可展开、可勾掉、标注「为何纳入」与脱敏结果）→ 生成邀请；「收到的包」列表：激活开关、模式（guest / blend）、版本升级提示 | 自定义 GPT、NotebookLM |

**会话中的体现**：

- 顶部身份条：「以你的身份 · 按 A 的方式」（激活客体包时），点击可切换。
- 「系统注入的上下文」折叠行（§18.2）：展开可见本次用了哪些记忆与方法——透明。
- 选中文本 → 「记到胶囊」（`evimed_capsule_note`，origin explicit）。
- 方法首次采用：回复里一句「本次按你的新方法 X 执行，如不对请说」。
- 运行结束：「本次学到」卡片——候选事实与方法线索，一键采纳 / 忽略，默认已生效带「新」标记（ChatGPT 的 Memory updated 模式）。
- 冷启动向导（首次使用）：「导入 5 篇代表作、1 份方案、1 份 SOP」→ 十分钟内生成第一版画像与方法草稿；之后从运行中继续学。

**运行树里的记忆**：每个子代理卡片标出它带着哪些方法与知识工作（来自委派记录），让「A 的方式」在每一步都可见。

### 19.20 第三轮复审结论与残余风险

对「这套设计是不是已经完美」的诚实回答：架构是对的——五层对应认知科学的记忆分类（sensory / working / episodic / semantic / procedural），溯源与双时间取自 Graphiti，方法即技能取自 Voyager / AWM / Agent Skills，反思取自 Generative Agents，增量演化取自 ACE，审阅门控取自 dsh-memento——但有九项残余风险，已各配对策：

| # | 风险 | 对策 |
|---|---|---|
| R1 | 中文医学语境下事实 / 方法抽取的精度未知 | C1 先建评测集（LongMemEval / EvoMemBench 风格，本地化）；精度不达标前方法只出草稿 |
| R2 | 蒸馏成本随资料量线性增长 | 按胶囊设每日蒸馏预算；Flash 模型；增量只处理新资料 |
| R3 | 冷启动空胶囊 | 导入向导 + 前几次运行的第一层记忆兜底 |
| R4 | 提示词膨胀 | 画像区块 ≤ 1,500 token；方法按需经 `skill` 工具加载；知识 top-k；`tokenMeter` 监测 |
| R5 | 记忆的「效用」无人管理 | 每条事实 / 方法记 `used_count / last_used / feedback`，召回按效用排序，长期未用者自动提议退休（借 MemRL 的效用思想，不做 RL） |
| R6 | 知识片段孤立、召回靠关键词 | 摄入时建立片段之间与片段到方法的链接（借 A-MEM 的卡片盒式链接） |
| R7 | 分享的知识产权与机构 SOP | 包带 `license` 与 `attribution` 字段；机构 SOP 来源的方法默认不进包，除非用户确认 |
| R8 | 用户对「它记住了什么」的信任 | §19.19 的透明与可撤销；记忆总开关 |
| R9 | 记忆底座年轻（MemOS 2.0）、后端较重（Neo4j + Qdrant） | `memorySubstrate` 窄端口隔离；Mem0 作为同端口第二 provider 留作退路；C0 实测后确认 |

### 19.21 记忆底座的三个选项与定案：MemOS 自托管跟版；DSH 没有「记忆层」只有原语

**问题**：(a) MemOS 部署在我们自己的服务器上、每次 MemOS 更新我们同步更新，行不行？(b) 不用 MemOS、只用 DSH 自己的记忆层，行不行？

**事实（源码核实）**：DSH **没有记忆层**，只有记忆**原语**，且全部局限在一个项目容器内：

| DSH 原语 | 能做什么 | 做不了什么 |
|---|---|---|
| 会话日志（JSONL，`$DSH_HOME/sessions/`） | 一个会话内的完整历史、回放、fork | 跨会话/跨项目检索、语义检索 |
| 压缩（`compaction-basic`） | 把旧历史摘要成 ≤ 8192 token | 不是长期记忆，摘要只服务当前会话 |
| `session-query-sqlite` | 跨会话全文检索（FTS5） | 默认关闭；「一进程一路径，不支持外部写入或第二进程」；无向量、无生命周期 |
| `storageDomain` KV | 插件自有状态（我们的运行镜像） | 不是检索库 |
| 技能（SKILL.md） | 程序性记忆的载体 | 不会自己生成 |
| `agent-instructions` | AGENTS.md 注入 | 静态文本 |
| 官方生态的记忆插件（MemOS 本地、dsh-mneme、dsh-memento、plur…） | 单机 SQLite，按 `$DSH_HOME` 划分 | 多用户、跨项目、服务端治理 |

所以「只用 DSH 的记忆层」在托管多用户 SaaS 里不成立——它会退化为「把会话日志导出到控制面、自己建索引」，也就是下表的 M3。

| 选项 | 含义 | 判断 |
|---|---|---|
| **M1 MemOS 自托管 + 跟版同步（定案）** | Compose（API + Neo4j + Qdrant + Redis）部署在控制面旁；与 DSH 同一套跟版纪律（见下） | 可行。MemCube 是分享原语、异步调度、多用户作用域、DSH 生态成员；代价是三个有状态后端与一个年轻项目 |
| M2 只用 DSH 原语 | 无控制面记忆服务 | **不成立**（上表） |
| M3 自建（控制面 Postgres + pgvector + 我们的表与作业） | `memorySubstrate` 端口的第二 provider | 作为**退路**保留：MemOS 在 C0 实测不达标（召回、稳定性、升级代价）即切换，胶囊层不变 |

**定案：三级记忆栈**——

```text
L0 工作记忆（运行内，DSH 原语）     会话日志 + 压缩 + storageDomain 镜像 + spill；只活在一次运行的容器里
L1 会话记忆（MemOS conversation cube）  每用户一个，跨项目、跨会话，自动写入；兜底
L2 胶囊（MemOS 受管 cube + Postgres 产品账本）  蒸馏沉淀、可分享；产品层
```

DSH 原语只服务运行内；MemOS 在控制面旁；胶囊是我们的产品层——三者的分工与「DSH 管执行、我们管科研」同构。

**跟版同步纪律（与 DSH 完全相同的四件套）**：

1. 版本单点 `OpenScience/deps-version.json` 的 `memos` 键（与 DSH 同一个文件、同一个夜间矩阵作业，不另建机制）；Compose 镜像 tag、契约测试、`release-manifest` 由测试断言相等。
2. `memorySubstrate` 契约测试：REST `/product/{create_cube, add, search, get_all, feedback}` 的请求/响应金样本；cube `dump → load` 往返与 schema 一致性；嵌入维度与 `EMBEDDING_DIMENSION` 一致。
3. 夜间矩阵：拉最新 MemOS 镜像跑契约测试 + 召回评测（§19.12 第 1 项），失败开 issue；MemOS 生态已有先例（OpenClaw 4.26 改 `registerTool()` 造成插件破坏性变更），所以矩阵必须覆盖我们用到的每个端点。
4. 升级 = 一个 PR：改版本单点 → 跑矩阵 → 先 `dump` 全部 cube 作备份 → 升级 → `load` 验证 → 切流量。Neo4j / Qdrant 的 schema 迁移以 cube 为恢复单位（MemOS 强制 schema 一致，旧 cube 装不进新版本时矩阵会先报出来）。

**部署细节**：MemOS 的 LLM 指向模型网关（OpenAI 兼容端点），embedder（`universal_api`）指向 `/internal/embeddings/v1`（外部 API 经网关，服务端持钥）；三个后端纳入备份与 `/api/ready`；**托管面禁用云插件**（PHI 不出境）；官方本地插件只给本地 `evimed-web` profile。

### 19.22 胶囊与底座的协同算法（互补学习系统框架）

**框架**：神经科学的互补学习系统（CLS）——海马系统快速记录情景、新皮层缓慢抽象为图式与程序，两者靠「睡眠期重放」巩固。对应：L1 = 海马（快、逐字、情景），L2 胶囊 = 新皮层（慢、蒸馏、语义 + 程序），巩固作业 = 睡眠期重放（Letta 的 sleep-time compute：空闲时用已收集的数据改进记忆表示；arXiv 2606.03979「Language Models Need Sleep」的 distill + replay + dreaming；arXiv 2605.08538「Human-Inspired Memory Architecture」的六机制：睡眠期巩固、干扰遗忘、印痕成熟、检索再巩固、实体知识图、多线索检索）。下面六条是可实现的规则，每条注明出处与默认参数（参数进控制面配置，§14 规则 11 的三问对它们都成立：部署方会按语料调）。

**A1 写入（L1）**：每次运行结束异步写入一批「观察」（压缩 ≈ 500 token）与候选事实；每条带 `importance ∈ [1, 10]`（写入时由 Flash 模型评分，Generative Agents 范式）、`run_id / project_id / recorded_at`、`entities`（经 `term_normalize` 的 MeSH 规范名）、`source_kind`；敏感预筛在前；MemOS `add` 负责 ADD / UPDATE / MERGE 判定（其自带抽取，我们不重复抽）。

**A2 检索与装配**：候选来自 MemOS 混合检索（BM25 + 向量 + 图），跨 cube 用 `CompositeCubeView`；我们的重排：

```text
score = w_rel · relevance + w_imp · importance/10 + w_rec · γ^(Δhours) + w_util · utility
默认 w = (3, 2, 1, 1)，γ = 0.995/h（Generative Agents）；utility = f(使用次数, 最近使用, 用户反馈)（arXiv 2606.12945 的多因子价值模型）
```

装配预算：画像区块 ≤ 1,500 token 常驻（Letta 核心记忆）+ top-k 召回（k 由 `tokenMeter` 实测定，初值 8）+ 相关方法以技能形式按需加载。客体工作方式包在 `guest` 模式下对「标准 / 偏好」类条目加权覆盖（§19.15），去重按语义相似度。

**A3 巩固（睡眠期，空闲或每日）**：
1. 重放最近 L1 条目，按实体 / 主题聚类并生成条目间链接（A-MEM 的 Zettelkasten 式动态链接与既有条目语境更新，NeurIPS 2025）。
2. 稳定性判定：`promote ⇐ (跨 ≥ 2 次运行出现 ≥ 3 次) ∨ 用户显式记录 ∨ 用户正反馈 ≥ 1，且无未决矛盾` → 晋升为胶囊事实，写 `valid_from` 与溯源；矛盾 → 旧事实 `valid_to` 失效（Graphiti 的双时间失效），不删历史。
3. 方法归纳：≥ k（默认 3）条成功轨迹共享同一例程 → Agent Workflow Memory 式归纳为方法草稿（SKILL.md）；已有方法 → ACE 式增量 delta；全部带来源、事后审阅（§19.3 原则 4）。
4. 反思：近期条目累计重要度超过阈值（默认 150，Generative Agents 的事件驱动而非定时）→ 生成更高层洞见条目 → 时间轴 `reflection`。
5. 产物写回：胶囊 cube（MemOS）+ Postgres 产品账本（方法正文、时间轴、版本）。

**A4 遗忘与再巩固**：L1 条目强度 `S(t) = S₀ · e^(−Δt/τ)`（τ 默认 30 天，Ebbinghaus 式，MemoryBank），被检索命中即 `S ← S + r`（再巩固）；`S < θ` → MemOS 生命周期 `archived`（可召回、不删除）；近重复合并（干扰去重）；胶囊条目**不衰减**但有效用分，长期未用者自动提议退休（§19.20 R5）；治理原语：用户级保留策略、删除沿溯源图传播到派生条目（arXiv 2604.12007「When to Forget」）。

**A5 记忆操作即工具，策略不交给模型**（借 AgeMem：记忆操作作为策略内的工具动作）：编排器只有 `evimed_capsule_recall`（显式召回）与 `evimed_capsule_note`（显式记录，`origin: explicit`）；自动召回在首个 `agent/pre-step`；存什么、何时晋升、何时遗忘由 A1–A4 的代码决定，不由模型决定。

**A6 评估**：LongMemEval / LoCoMo 风格的中文医学科研本地化集（时间推理、跨会话一致性、更新后事实）；EvoMemBench 式自演化评估（同一用户连续 N 次运行，方法遵循度是否上升）；§19.12 的六项。

**数据流**：

```text
运行结束 ──观察+候选事实──► L1 add（MemOS，异步）──夜间重放/聚类/晋升──► L2 胶囊（cube + 账本）
下一次派发 ◄── 首个 pre-step 注入：画像区块 + top-k（A2 重排）+ 方法技能 + 工作方式包 ──┘
```

---

## 20. 定版声明（v3，2026-08-22）

本节把散落在 §0.2、§16、§19.14 的决定合并为一份**锁定清单**；此后改动任何一条都需要新版本号。未列入的都是实现细节，由各章约束。


> **生态对照（2026-08-25）**：`WODE25500/dsh-skillopt`（Microsoft SkillOpt-Sleep）在野实现了同一条回路——夜间收割会话、挖出重复任务、**过 held-out 门之后**才固化成技能。值得对照的是那道门：我们的 A3 巩固目前按聚类与频次晋升，它多了一步「在留出集上先证明这条技能有用」。这正是"断言结果而非断言机制"在记忆侧的形态，A3 的晋升条件应当照此补一条实证关卡（§30.2 同源）。


### 20.1 锁定的架构决策

| # | 决策 | 章节 |
|---|---|---|
| 1 | **DSH 是唯一执行内核**，部署在每项目隔离 runtime 容器内；控制面、三个内部网关、账本、交付门禁原样保留；不形成双 Harness；OpenCode 于 P2 清零（附 B） | §0、§6、附 B |
| 2 | **插座 = 一个 Bundle**（`@evimed/dsh-socket`，本文亦称 dsh-bundle），只经防腐层 `@evimed/harness-port` 接触 DSH；`seam-manifest.json` 列出全部接触面；ESLint 禁止其他包 import `@deepseek-ai/*` | §5 |
| 3 | **版本同步是机制**：精确 pin、启动自检 fail-closed、契约测试、夜间兼容矩阵、安全修复当日评估；升级 = 一个 PR | §12 |
| 4 | **没有 Mode Router、没有产品线 preset**：统一组合 `evimed-universal`；能力 = 清单（`capability.yaml`，由 `agent.yaml` 演化）；模型计划 → 委派 → 按契约交付；契约绑产出（声明 kind ∪ 安全内容触发器）；路由器降级为事后期望检查 | §9 |
| 5 | **门禁单实现**：`@evimed/domain` 被服务端与插座同时 import；`preflight.py` 删除；运行侧硬门在 `evimed_submit_deliverable` 的 `tools/pre-execute`；服务端门禁保持外部独立；LLM 判分只出 notice | §8 |
| 6 | **任务状态**：权威在控制面账本；公开 `status` 四值不变、九态是投影 `phase`（§7.1.1）；运行侧镜像在 `ctx.storageDomain`；不向 DSH 会话日志追加自定义事件类型；模型可见状态经 `agent.inject()` | §7 |
| 7 | **并发**：进程内子代理 + `workflow`，`maxDepth 1`，`maxParallelChildren 30`；不建队列 / Redis / 进程外 worker；Agent Teams 转正后按配置启用 | §10 |
| 8 | **安全不变式不降级**：运行时不持真钥、外联只经网关、`web_fetch` 关闭、Landlock 沙箱（`workspace-write + never`）、遥测硬关、`agent-instructions` 在托管禁用 | §11 |
| 9 | **前端保留并改造 React 应用**：按 DSH 事件词汇重写会话层与运行树；不用 TUI；DSH Web 客户端只用于本地 profile `evimed-web`；Tauri 退役 | §18 |
| 10 | **记忆 = 三级栈**：L0 工作记忆用 DSH 原语（运行内）；L1 会话记忆与 L2 胶囊都在 **MemOS 自托管**底座上（部署在我们的服务器，禁用云插件，与 DSH 同一套跟版纪律：版本单点、契约测试、夜间矩阵、cube 备份升级）；usememos 退役；M3 自建作为同端口退路；胶囊协同按 §19.22 的六条算法；方法论 = SKILL.md；分享默认 = 工作方式包；胶囊是上下文不是权限；体验优先、审阅不挡路 | §19.16、§19.21、§19.22 |
| 11 | **平台自演化**：用户回路、能力手册增量回路（ACE 式 delta + 代码核验 + 维护者审批 + 31 份 RQ 不退化）、opt-in 跨用户聚合；不训练模型 | §19.17 |
| 12 | **能力扩展**：GEO、临床决策辅助等 = 新能力清单（+ 契约种类、技能、工具）；临床决策辅助按 `regulated` 预留，是否上线待产品与合规决定 | §9.9、§9.11 |
| 13 | **MCP server 名 `evimed`**；向量召回走外部 API 网关；ASR 先云 API 后自建，同一网关契约 | §9.10、§19.14 |
| 14 | **工程规范**：以《医学科研 Agent 项目代码规范与工程原则》（Ousterhout）为母本，§14 为 DSH / 本仓库的可检查补充；两者冲突时以可被 lint / 测试检查的表述为准 | §14 |
| 15 | **插座的插件按知识切分**：agent 面固定为 `guidance / run-policy / evidence / capsule / review / screening` 六个（v3.7 修订：`evimed_screen_batch` 需要自己的宿主），宿主面 `seam-probe / evidence-store` 两个；门禁裁定是返回值不是 `deny`；状态转换单一写入者；`task-plan.json` 是唯一计划产物；控制面只读 `.evimed-run/state.json` 投影 | §5.3、§7、§8 |
| 16 | **命名**：MCP 原始工具名去掉 `evimed_` 前缀（模型看到 `mcp__evimed__literature_search`），插座原生工具保留 `evimed_`；`kind` 只用于 DSH 判别字段，契约种类叫 `contractKind`；三套状态词汇表在 domain 定义一次 | §14 规则 21 |
| 17 | **资产接入形式锁定**：九类资产各自的封装、DSH 接入形式、控制面接入形式与调度者按 §21.1 表执行；调度三层（模型决定做什么、`evimed_delegate` 决定怎么装、MCP 路由表决定去哪取）；护城河全部在 DSH 之外（§21.6）；OpenCode 一次性清零，不保留兼容层（附 B） | §21 |
| 18 | **主动式科研 = 系统发起的运行**：议程（世界模型）与调度在控制面；回合 = 普通运行 + `agenda-delta`；验证优先（契约门禁 → 独立反驳者 → 重跑复现）与 tier 分级（`unverified / gated / reproduced`）；简报头条只放 `reproduced` 或 direct-stands；数据分析先冻结分析计划再碰确认分区；按任务类型开关 + 日上限，没有自主等级；硬禁 `regulated` 能力、`identified` 数据、对外发送；不用 DSH `goal` / `ralph` 做跨日调度 | §24 |
| 19 | **计量在网关、额度先于功能**：`usage_events` 由网关写入；额度按资源 × 峰谷定价、夜间 5 折传导；事前预估、实时计量、日 / 周上限、无人看 7 天自动暂停、余额不足暂停主动 | §25 |
| 20 | **数据资产三件套**：保险库 + 画像与分级（默认值，无审批、无同意卡）+ 分区与计划冻结；原始行不进模型上下文、不进胶囊；合规与版权不在方案范围（用户方有管理资质） | §24.5、§23.4 |
| 21 | **前端信息架构与交互规则**：十个导航项（§23.1）、十二条全局规则（§23.2）、三种呈现面（桌面 / 手机 / 邮件）；上传为分块续传 + 逐文件状态机，没有阻塞对话框；分享的接收方流程含「试用一次」；收件箱三类（通知 / 提问 / 审阅）按优先级 | §23 |
| 22 | **统一分析层**：原始库在用户的网盘 / 本地（OpenList + 本地代理 + 上传三连接器一契约）；分析层只存派生物与指纹；分流 → 抽取 → 审计 → 归并 → 物化一条线，内外来源同走；索引完整性 100%、`deep` 遗漏 ≤ 5%；不设同意卡、不设审批，合规与版权不在方案范围 | §26 |
| 23 | **理解存在上下文里**：四个预测任务定义并度量理解度；主线蒸馏 = 抽取 + 归纳 + 校准，信号来自四个回路；平台级小模型后期降本；每用户参数记忆暂不做；立场永不改变证据规则 | §27 |
| 24 | **胶囊容器与密钥**：`.evimedcap` 规范 v1（manifest 签名 + Merkle + 版本链 + 按接收者封装的包密钥 + 明文格式开放）；用户各持 Ed25519 / X25519 密钥对，胶囊 DEK、包 PK、KEK 分层；schema 只在 `@evimed/domain` 定义；金包往返 / 篡改 / 错钥测试进 CI | §28 |
| 25 | **收口**：没有生效前确认、没有自主等级、v1 没有假说锦标赛与 Thompson 采样、不训练任何模型、没有人工抽样复核；跟版依赖一套机制（`deps-version.json`）；全系统阻断点只有 6 个（§29.3）；画像蒸馏按 Nuwa 配方（三重验证、内在张力、诚实边界、计分卡不阻断）；生成的 SKILL.md 按 Agent Skills 作者规范校验 | §29、§27.3.1 |

### 20.2 定版后仍需在 P0 第一周核实的事实

§15 的 V1–V40（V16 已核；V17 tarball 打包、V18 MemCube REST 暴露与权限、V19 MemOS 自托管认证与备份、V20 一致性套件 profile、V21 金帧录制、V22 子代理回报的 token 压力、V23 MemOS 契约测试与 cube 备份升级演练、V24 管理作业包装为 DSH 作业的可行性为 v3.1 新增；V25 运行时 usage 字段、V26 MinerU 资源、V27 自主容器曲线、V28 公共源限速、V29 fork 前缀复用、V30 网关流式 usage、V31 解析 API 可部署性为 v3.2 新增；V32–V36（OpenList 稳定性、去重阈值、QA 审计成本、本地代理形态、视频分段对齐）为 v3.3 新增；V37–V40（DeepSeek 微调接口、编辑偏好推断精度、Node crypto 能力、MemOS 外部 cube 导入）为 v3.4 新增）。这些是**事实核实**，不是设计待决；任一核实失败都有写明的退路（§6.7、§17 G5、§19.16）。

### 20.3 不再改变的原则

简单、明确、清楚、完整（上位方案）；只写核实事实；模型判、代码核、人在回路但不挡路；契约绑产出；胶囊是上下文不是权限；插座只碰文档化的缝；少门禁（阻断点只有 §29.3 的六个）；不训练模型。

## 21. 资产封装与接入总表：每一类现有资产如何封装、如何被 DSH 与控制面调用、在哪里优化

### 21.1 九类资产

| 资产类 | 现在的封装 | 定版后的封装 | 接入 DSH 的形式 | 接入控制面的形式 | 调度由谁决定 | 优化面（护城河所在） |
|---|---|---|---|---|---|---|
| 1. 能力（11 个专科包） | `agent.yaml + SKILL.md (+ scripts)` | `capability.yaml + SKILL.md + @evimed/domain 契约校验器` | `evimed_delegate` 起子代理：`toolFilter` 来自 `tools[]`，技能正文预注入，`outputSchema` 固定 | 能力目录 `/api/capabilities`（模板）；期望检查与交付判定读契约 | 编排器决定**用哪个**；`evimed_delegate` 决定**怎么装** | SKILL.md 与契约（ACE 式 L2 回路）；31 份 RQ 平价语料 |
| 2. 通用技能（core 13 / curated 38 / office 4） | SKILL.md + `scripts/`；curated 统一经 `_runtime/execute_skill.py`，`inventory.json` 交付契约（entrypoints / dependencies / artifacts / smoke / sha256） | 不变；随 preset 发行（`presets/evimed-universal/skills/*`，相对路径） | `skill-filesystem{customSkillDirs, includeDefaultRoots:false}` + `skill` 工具按需加载；脚本经 `bash` 在 Landlock 沙箱执行 | 镜像构建时烟测全部 38 个 curated 执行器（现有 Dockerfile 流程） | 模型按 `<available_skills>` 选 | 执行器与 inventory 审计；技能正文 |
| 3. MCP 工具（26 个，server `evimed`） | 纯标准库 Python stdio JSON-RPC（`server.py`，MCP 2024-11-05） | 不变；原始工具名去 `evimed_` 前缀 | `@deepseek-ai/dsh-mcp-client` 行 → `mcp__evimed__*`；`toolCallTimeoutMs` ≥ 120 s；`failOnStartupError: true` | MCP 进程由容器启动；凭据只有工作负载令牌（文件） | 子代理按 `toolFilter`；MCP 内部按路由表选源（见 §21.2） | 连接器质量、来源目录、适配器 |
| 4. 私有数据 API（「数据库接入」） | `EVIMED_*_URL` 适配器：`LITERATURE_SEARCH / GUIDELINE_SEARCH / CLINICAL_TRIAL_SEARCH / PATENT_SEARCH / PHARMACY_REFERENCE_SEARCH / DRUG_LABEL_SEARCH / ADR_CASE_QUERY / ADR_SIGNAL_ANALYSIS / OFFLABEL_EVIDENCE_PACKET / COMPREHENSIVE_DRUG_EVALUATION / DRUG_SELECTION_EVALUATION / BIOMEDICAL_SOURCE_SEARCH / EVIDENCE_SEARCH`，每个带熔断 | 不变；地址由控制面注入 MCP 环境 | 经 MCP 工具暴露（同上） | `evidence_service.py`（FastAPI）+ `publicSourceGateway` 的 7 个 EviMed POST 端点 | MCP：适配器优先，`EVIMED_PUBLIC_CONNECTORS_ENABLED` 时回落公共连接器 | 数据覆盖、响应质量、熔断阈值 |
| 5. 公共连接器（53 个 `EVIMED_*_BASE_URL`：PubMed/E-utilities、Crossref、Europe PMC、OpenAlex、S2、Unpaywall、CT.gov、openFDA、DailyMed、RxNorm、UniProt、Ensembl…；123 源目录 `source_catalog.json`） | `public_sources.py` / `science_connectors.py` 直连 | 不变 | 经 MCP 工具 | **托管面**全部经 `publicSourceGateway`（`EVIMED_PUBLIC_SOURCE_GATEWAY_URL`，主机白名单 + 服务端凭据 + SSRF 防护）；**本地面**直连 | `data_source_catalog` 暴露状态（active / blocked / credentials），模型据此选源 | 目录的 `blocked_*` 逐个解除；连接器探针（`evals/capability-audit`） |
| 6. 专科 Python 代理（`项目代码/` 6 个：Meta、MR、论文审稿、文献计量、科研选题、药物安全） | `deploy/specialist-adapter`（FastAPI + HMAC 工作负载令牌，一容器一专科；`start / status / capabilities` 三动作，`waitSeconds ≤ 60`）；Meta 可本地 `EVIMED_META_AGENT_ROOT` | 不变 | 经 MCP 管理作业工具（`meta_analysis / mendelian_randomization / bibliometric_analysis / research_topic_selection / peer_review / drug_safety_analysis`）；**P2 包装为 DSH 作业**（§21.7） | 适配器容器由 Compose 管；令牌由控制面签发 | 子代理 `start` 后轮询 `status`；P2 后由 `job_*` 工具与结算通知接管 | 各引擎（统计、检索、评审规则）——与内核完全无关的护城河 |
| 7. 内部网关族（`/internal/{model, sources, search}/v1`，新增 `asr / embeddings / capsule / geo-probe`） | 控制面 `*.mjs`，HMAC 运行时令牌 | 不变；每个新网关同一模板（令牌、超时、字段白名单、错误码） | 运行时只知道网关地址；`llm-deepseek.baseURL` 指向模型网关 | — | — | 凭据与配额；certified 模型集合 |
| 8. 插座原生工具（`evimed_plan / delegate / submit_deliverable / complete_run / capsule_recall / capsule_note / screen_batch / review_run`） | 无（新） | `defineTool` 于 `@evimed/dsh-socket`，统一信封 `{ok, code?, data?, issues?}` | 注册在 `evimed-universal` 的 agent 面 | 经 `.evimed-run/state.json` 与回执 | 编排器 | 编排指引与契约 |
| 9. Notebook 内核（`runtime/kernel` Python/R 桥）与评测（`evals/`） | 控制面 `commands.mjs` 起 Docker 内核；评测脚本 | 内核不变；评测新增内核平价、记忆、编排三套 | 运行内的数据分析直接用沙箱里的 Python/R（镜像已装科学栈） | `/api/commands`、`/api/tasks` | — | 评测语料（RQ 31 份、title-to-paper 50 篇、记忆集） |

### 21.2 MCP 26 个工具的路由表（模型看到 `mcp__evimed__<名>`）

| 子类 | 工具（去前缀后） | 托管面路由 | 本地面路由 |
|---|---|---|---|
| 检索（公共 + 私有） | `literature_search`、`guideline_search`、`clinical_trial_search`、`patent_search`、`biomedical_source_search` | 私有适配器 → 失败或未配置时公共连接器经 `publicSourceGateway` | 公共连接器直连 |
| 全文与页面 | `open_access_full_text`（Europe PMC JATS）、`official_page_fetch`（白名单官方页）、`web_search`（SearXNG 网关） | 全部经网关 | 直连 / 本地 SearXNG |
| 药学数据 | `drug_label_search`、`pharmacy_reference_search`、`adr_case_query`、`adr_signal_analysis`、`drug_term_normalize` | 适配器优先；openFDA / DailyMed / RxNorm 经网关；SIDER 本地 SQLite | 直连 |
| 确定性编译 | `offlabel_evidence_packet`、`comprehensive_drug_evaluation`、`drug_selection_evaluation`（`requirements / retrieve / compile` 三动作，`compile` 本地无网络并给输入 SHA-256） | 检索动作同上，编译动作本地 | 同 |
| 管理作业 | `meta_analysis`、`mendelian_randomization`、`bibliometric_analysis`、`research_topic_selection`、`peer_review`、`drug_safety_analysis` | 专科适配器容器（HMAC） | 本地 `EVIMED_META_AGENT_ROOT` 等 |
| 本地工具 | `data_source_catalog`、`evidence_deduplicate`、`term_normalize`、`health` | 本地 | 本地 |

能力清单的 `tools[]` 在构建时对 `tools/list` 校验（§9.3）；`@evimed/domain.toolNames` 是这 26 个名字的唯一定义，SKILL.md 改写脚本与泄漏禁词都从它派生。

### 21.3 DSH 提供的集成形式与我们各用于什么

| DSH 集成形式 | 我们用于 | 不用于 |
|---|---|---|
| Bundle + profile + patch | `@evimed/dsh-socket` 与两种 profile（托管 / 本地） | — |
| agent preset | 唯一的 `evimed-universal` | 产品线、模式 |
| `defineTool` | 8 个插座原生工具 | 领域检索（走 MCP，便于独立演进与本地复用） |
| `dsh-mcp-client` | `evimed` server（26 工具）；P3 `evimed-geo` | — |
| 技能根 | 通用技能（preset 相对路径）；胶囊方法经 `ctx.skills.register` | 能力正文（由委派预注入，避免绕过） |
| 子代理 / 工作流 | 委派（`spawn`、`toolFilter`、`outputSchema`）；`evimed_screen_batch` | `fork`（不需要父历史） |
| `ctx.jobs` | P2：管理作业包装（§21.7） | — |
| 事件缝（`tools/*`、`agent/*`、`session/event`） | 策略、预算、证据摄入、失败传播（§7.4） | 业务裁定（返回值） |
| `storageDomain` | 运行镜像（§7.2） | 长期记忆（MemOS） |
| Web 宿主 API（apiproxy + WebSocket） | 控制面 ↔ 容器接线（§6） | 浏览器直连 |
| SDK / ACP / headless | 不用（§6.2） | — |
| 官方 MemOS 本地插件 | 本地 profile | 托管面 |

### 21.4 调度的三层：模型决定「做什么」，代码决定「怎么做、去哪做」

1. **编排器（模型）**：看能力目录与题面，决定交付物、能力、并行度、是否追问。
2. **`evimed_delegate`（代码）**：按能力清单组装子代理的工具集、技能、人设、输出 schema、交付目录；依赖排队；失败重派。
3. **MCP 路由表（代码）**：按环境与熔断状态选私有适配器 / 公共连接器 / 本地编译；`data_source_catalog` 把「哪些源现在可用」暴露给模型，模型据此调整而不是猜。

灵活性来自第 1 层，可靠性来自第 2、3 层；三层各自可以独立优化，互不牵连。

### 21.5 「正确封装」检查清单（每类资产进 CI）

| 资产类 | 必须存在的契约文件 | 必须有的测试 | 超时与失败语义 |
|---|---|---|---|
| 能力 | `capability.yaml` + 契约校验器 | 校验器 fixture（通过包 + 每个 blocking issue 一例）；`tools[]` ∈ `tools/list` | 交付裁定是返回值；`deliveryAttemptLimit` |
| 通用技能 | `inventory.json` 交付契约 | 镜像构建烟测（现有） | 脚本超时由 `bash` 工具与 `timeout-policy` 管 |
| MCP 工具 | `tools/list` schema（`additionalProperties: false`） | `test_server.py` 等 8 套（现有，3,688 行）+ 名字快照 | `toolCallTimeoutMs`；`recoverable / terminal` 错误码两分法；运行内退避重试（§7.4） |
| 私有数据 API | `ADAPTER_ENV` 路由 + 熔断 | 适配器契约测试（`evimedMcp.test.mjs` 改造） | 熔断打开 → 公共回落或 `adapter_circuit_open` |
| 专科代理 | `specialist-adapter` 三动作契约 | `test_service.py` + `evals/specialist-smoke` | `waitSeconds ≤ 60`；P2 后 DSH 作业取消语义 |
| 网关 | 字段白名单 + 错误码 | 现有 `*Gateway.test.mjs` | 总时限 / 空闲时限按 `REQUEST_PATH` 表对齐 |
| 插座工具 | 统一信封 + `output.schema` | 三类用例（§14 规则 37） | 策略 `deny` 只用于预算与次数 |

### 21.6 护城河在哪里

全部在 DSH 之外：契约注册表与门禁规则（`@evimed/domain`）、123 源目录与连接器、私有数据 API、六个专科引擎、蒸馏出的方法论（胶囊）、评测语料（RQ 31 份、title-to-paper 50 篇、记忆集）。换任何 harness 这些都不变；DSH 只是当前最好的插排。

### 21.7 P2 改进：管理作业包装为 DSH 作业

今天子代理要自己轮询 `status{waitSeconds ≤ 45}`；P2 起 `run-policy` 在 `tools/execute` 上包裹六个管理作业工具的 `start` 动作：成功返回后 `ctx.jobs.start({ kind: 'evimed-job', label, owner: call.agent, run: poller })`，poller 周期调用 `status`、把进度写入输出流、结算时给出结果；模型改用 `job_list / job_output / job_kill`，父代理收到结算通知，UI 的作业面板直接可见。前提核实 V24：`tools/execute` 包裹器内能拿到 `exec.agent` 并调用 `ctx.jobs.start`（cookbook 的 `run_in_background` 范式表明可行）。

### 21.8 生态接入：三档与动作（2026-08-24，§16 #22）

社区资产（GitHub `topic:dsh-plugin` 1.1 万仓库；awesome 列表人工核验收录 2,112 项）按形态各有一条机械的接入路，全程不新增阻断点：

| 形态 | 动作 | 备注 |
|---|---|---|
| 技能包（SKILL.md） | 放进 `skills/community/`（§9.2 customSkillDirs 已含该根），记来源 URL + commit | 零适配（Agent Skills 开放标准，DSH 原生消费）；不套 curated 统一执行器——那是给自有 38 技能的，卡社区技能只会抬高采用成本 |
| 工具 bundle | preset / patch 加一行，tarball pin 进镜像；可 `disabled: true` 烘入、按部署开 | 与 socket 同层组合；新增 bundle 需镜像发布；按 npm 依赖对待（pin + 冒烟 + 夜间矩阵） |
| MCP server | `dsh-mcp-client` 行 | 托管面出网经 `publicSourceGateway`，做不到则仅本地面 |
| agent preset | 不整套运行（DSH 机制：一会话一组合、产出后不能换）；四条融合路径：persona 文本 / 行配置 / 随包技能 / 整只映射成 `capability.yaml` | 映射后一次运行可委派多只、互相接力——比原生 preset 形态更好用 |

技能收录的机械检查（2026-08-24 对 rc.2 源码核实，`dsh:packages/skill/skill-filesystem`）：发现只认**一层深**（`<root>/<name>/SKILL.md` 或平铺 `<name>.md`，嵌套树收录前先摊平）；frontmatter 必填 kebab-case `name` + `description`（开放 YAML，多余字段无害，但 `disable-model-invocation` / `user-invocable` 两键拼写或取值错误会**整技能被静默丢弃**，只留 warning——失败即关死是上游有意为之）；与四根内已有技能重名则收录时改名（注册表分层裁决：近层胜，同层按 rank / provider 次序，不报错）；bundle 自带技能（如 dsh-zotero 包内 `skills/`）随 bundle 行一并生效，不必拆出。已知 rc 期安装缺陷（`peerDependencies` 声明错致安装挂起 #4236、`plugin remove` 残留 bundle 条目、dsh-tools 重复副本致所有工具调用崩溃）都只咬**运行期活装**；托管面在镜像构建期预初始化只读 profile，天然免疫——本地面备 `dsh-fix-duplicate-loader-id` 与「删残留行重装」流程即可。

配套两件（V41）：能力清单 `tools[]` 的构建期校验从「仅对 MCP `tools/list`」扩展为对组合后工具注册表（`--dump-config` 一致性套件）；接首个第三方 bundle 时用真实组合测试核其工具行在我们 preset 作用域下干净组合。判据一句话：**裁决与数学封进引擎，通用手艺留在过程层**——留在技能 / 工具层的每个步骤，生态都在免费替我们升级；埋进黑盒作业的步骤，升级永远得自己写。首扫清单与首批动作：`plans/2026-08-24-dsh-ecosystem-adoption-shortlist.md`。

两条补充（2026-08-26，复审另一份「Cordis 总线当中台 + 业务做成运行时插件 + 服务注入」的接入方案后）：① **插座插件永不 `inject` 第三方服务**——cordis 的 `inject` 是硬依赖，服务缺失时插件静默不 `apply`（又一个「空与确实没有外观相同」）；第三方多在宿主作用域发布服务，会被容器内所有会话共享（#27 内核拒绝我们自己 preset 服务的同一理由）；规则 29（`inject ⊆ seam-manifest.services`）已蕴含此意，此处点明。社区能力只以**工具 / 技能**形态被模型消费。② **「小改」档的正确形态是换 provider 不换 consumer**：DSH 自身按 Service Definition / Provider / Consumer 分层（skills、web 缝均如此，社区已有 Metaso 作为 web 缝 search/reader provider 的先例），适配社区包时先看它是否是某个 DSH 服务的 provider——模型可见契约不动，实现层换成我们的网关或医疗专用逻辑。运行内插件协同只走 port 文档化的缝，跨运行 / 跨用户的协同走控制面（队列、收件箱、`usage_events`），不用 Cordis 事件当平台总线。可借项清单见 plans 文档第十一节。

---

### 21.9 一期执行结果（2026-08-25）：清单说的形态，有一半不是真的

`skills/community/` 根已建（`customSkillDirs` 末位——首根赢名字冲突，社区技能永远盖不掉自研），随附 `sources.json`（逐条 repo / commit / license / 为什么）与 `scripts/dev/vendor-community-skills.mjs`（按 commit 拉、跑进厂检验、写 `PROVENANCE.md`）。

**清单里「技能形态五件」中，四件其实是工具形态。** 六个候选包都带 `dsh.bundle`，但只有三个真正随包发 `SKILL.md`；`dsh-cite`、`academic-writing`、`translation` 注册的是模型可见的**工具**（`academic_writing` 等），`writing-guard` 的 SKILL.md 则在正文里调 `writing_audit()` / `writing_journal_profile()` 各若干次——**把它的正文单独收进技能根，等于让模型去调一个不存在的工具**。

这不是靠人读出来的。进厂检验里加了一条：技能正文中出现的、本编排未挂载的工具名一律拒收，并已验齿（把 writing-guard 塞进清单，当场被点名两个工具拒收）。它是这批检查里唯一一条**针对「技能是给模型看的文本」这一性质**的检查——一个技能引用了不存在的工具，不会报错，只会让模型照做、工具缺席、运行以「模型不太行」的样子降级。

一期实收两件（`dsh-ppt`、`deep-structural-analysis`），四件转入试装档（工具 bundle 要么整包 pin 进镜像，要么不要）。`deep-structural-analysis` 明写 web search 是一个阶段，仍然收——因为它自带「搜索不可用」的退路：所有框架锚定结论标注为理论推断、置低置信度、执行摘要前加可见提示，正是托管面（无直连出网）需要它做的事。


## 22. 第四轮复审（2026-08-23）：全对话缺口清单

复审方法：把用户在本轮对话里提出的全部意图逐条列出——换内核、无模式边界、前端全适配、记忆胶囊与分享、常规记忆兜底、MemOS 自托管跟版、资产封装、OpenCode 一次性清零、用户上传资料、主动式科研——对照 v3.1 正文标出「已覆盖 / 部分 / 缺失」，再按「会在哪个阶段撞上」定严重度。结论：**架构不变；发现 14 处缺口，其中 3 处是产品层的整块缺失**（计量与额度、通知与收件箱、数据资产与同意），其余是既有章节的细化。全部在本轮写回 §23–§25。

| # | 用户意图 / 场景 | v3.1 状态 | 缺口 | 严重度 | 写回 |
|---|---|---|---|---|---|
| G10 | 「人只需要充值 token」 | `saasProfile.mjs` 声明 `billingIntegrated: false`；`modelGateway.mjs` 不记录 `usage`；账本只在 `finished` 事件写预算终值（§7.5） | 没有计量点、额度、价目、事前预估、告警、余额耗尽行为 | **P1 必撞**：主动科研无法上线，交互运行也无法控成本 | §25.1–25.3 |
| G11 | 「每天有个地方等着看结果」 | 无任何通知通道（`apps/server/src` 无 notification / email 模块） | 简报、决策队列、邮件 / 微信渠道、静默时段 | P1 | §23.6、§25.4 |
| G12 | 「胶囊里有数据就可以主动做科研」 | §19.6 S2：数据文件只取 schema 与统计、**原始行永不入库**——对胶囊正确，但分析必须跑在原始数据上 | 缺数据保险库（原始数据的存放与挂载）、数据画像与分级、预注册分区 | P1 | §24.5、§23.4 |
| G13 | 「用户上传自己资料（Excel、DB、PPT、音频、Word、文本）」 | `/api/files/upload` 为 base64 JSON、`maxFileBytes` 默认 50 MB、无断点续传；解析引擎未选型（接口文档的解析 API 能否部署未知） | 传输方式、大文件、解析引擎、逐类型分支、失败态、队列与进度 | P1 | §23.4 |
| G14 | 「分享记忆胶囊的流程」 | §19.9 / 19.15 / 19.19 定义了语义与三步向导 | 缺接收方流程（预览、试用、激活、更新、停用）、撤回与过期的界面状态、审计可见性 | C4 | §23.5 |
| G15 | 「前端的设计和交互…展示细节」 | §18 只有会话层、运行树与事件契约 | 信息架构（新增胶囊 / 议程 / 收件箱 / 额度的导航位）、页面规格、全局交互规则、移动端策略、微文案 | F1 起 | §23.1–23.3 |
| G16 | 夜间长时自主运行 | `runtimeManager.scheduleIdleStop` 与 `MAX_RUNNING_RUNTIMES = 8 / 4 per user` 按交互设计 | 自主运行需要独立容器池、公平调度、空闲停止豁免、断点续跑 | A1 | §24.7 |
| G17 | 夜间集群检索公共源 | `publicSourceGateway` 按请求做 SSRF 防护与主机白名单，无全局限速 | PubMed E-utilities 无 key 3 req/s、有 key 10 req/s；N 个线程同时检索会被封；需全局令牌桶 + 结果缓存 | A1 | §24.7 |
| G18 | AI 自主产出离开平台的环节 | 未提 | 人工签核、可复现包、禁止对外动作（合规与版权由用户方资质覆盖，不在方案范围） | A1 | §24.6 |
| G19 | 自主运行把模型错误放大 N 倍 | §8 三层守卫针对一次交付 | Kosmos 综合性陈述 57.9% 准确、Sakana 42% 实验失败——无人值守时必须「验证优先 + 分级 + 预注册」 | A1 | §24.4 |
| G20 | 成本结构 | 未利用峰谷 | DeepSeek 2026-08 起峰谷计费：峰时 UTC 01–04、06–10 周一至周五（北京时间 09–12、14–18），谷时 **5 折**——夜间科研天然半价 | B0 | §24.7、§25.2 |
| G21 | 防失控 | 运行预算只到单次运行 | 用户一周不看、余额耗尽、方向连续无产出、反复失败——无停止规则 | A1 | §24.4.7 |
| G22 | 主动科研的质量 | 无评测 | 采纳率、复现率、每百额度发现数、误报率、时效 | A2 | §24.8 |
| G23 | 删除与保留 | 胶囊删除已定义（§19.10） | 运行产物、会话日志、数据集、议程、通知的保留期与删除传播 | B1 | §25.5 |
| G24 | 「资料多而杂，怎么辨别有用没用、是否抽全、能不能对接网盘让用户自己维护原始库」（2026-08-23） | §19.6 只有 S1–S6 概要 | 缺连接器形态、分流与深度策略、抽取契约、完整性度量、跨文档归并、整理台 | C1 | §26 |
| G25 | 「蒸馏模型怎么设计、模型怎么更了解我」（2026-08-23） | §19.6 D2–D4 与 §19.22 只有机制，没有「理解」的定义、信号来源与度量 | 缺理解度的定义、三种蒸馏的取舍、编辑偏好推断、冷启动访谈、过度个性化守卫 | C1 | §27 |
| G26 | 「胶囊要不要定存储格式和加解密」（2026-08-23） | §19.9 只有 tgz 导出清单 | 缺容器规范、签名、密钥体系、威胁模型、格式治理 | C4 | §28 |
| G27 | 「不要过度设计和过多门禁；不训练模型；核查算法与规范」（2026-08-23） | v3.4 累积了确认、等级、锦标赛、采样、分类器、四套跟版 | 见 §29：删 9 项、阻断点收敛到 6 个、改名 14 处、常量 vs 配置 | 定版 | §29 |

部分覆盖项：(a) 「数据库」只有文件形态（SQLite / DuckDB / CSV / Parquet / SPSS / Stata / SAS），在线库连接另立阶段（§23.4）；(b) 团队 / 组织模型仍在范围外（`organizationSaasReady: false` 不变），分享继续为点对点。

复审后仍成立、不再改动的结论：§17.3 的全部项、三级记忆栈（§19.21）、协同算法（§19.22）、资产总表（§21）。

---

## 23. 前端设计与交互细则

> §18 决定了「保留 React、换词汇表」；本节回答「每一页长什么样、每个动作怎么反馈」。原则：透明（每一步可见、可溯源）、可控（可撤销、可插话、可停止）、轻（提示不打断）、成本可见（花额度之前先看预估）。产品词表与 §9.10 的泄漏禁词一致：界面不出现 session / subagent / preset / MCP 等运行时名词，用「运行」「分工」「交付物」「来源」。

### 23.1 信息架构

| 导航项 | 路由 | 内容 | 阶段 |
|---|---|---|---|
| 新任务 | `/live/:id` | 会话流 + 运行面板（运行树 / 交付物 / 证据 / 预算） | F0–F2 |
| 今晨简报 | `/agenda` | 主动科研首页：简报卡、正在进行、议程板、预算（§24.9） | A1 |
| 知识库 | `/files` | 不变（项目文件） | — |
| 科研笔记本 | `/notebooks` | 不变 | — |
| 记忆胶囊 | `/capsule/{overview, sources, data, memory, methods, timeline, sharing}` | 替换 `/memory`；新增 **数据** 页（§23.4） | F2–F3 |
| 能力模板 | `/capabilities` | 原 `/agents`（§9.8） | F1 |
| 运行记录 | `/runs` | 扩展：运行树、回执、门禁判定、待人工复核 | F1 |
| 收件箱 | `/inbox` | 通知 / 提问 / 审阅三类（§23.6） | F2 |
| 账户与额度 | `/account` | 余额、用量、日上限、充值、告警（§25） | B1 |
| 设置 | `/settings` | 清理后保留账号、项目、资源、就绪 | F1 |

三种呈现面：**桌面工作台**（≥ 1024 px，全功能）、**手机**（< 768 px：简报、收件箱、发现、胶囊时间轴、运行状态只读、会话可追问；不渲染运行树与轨迹检查器）、**邮件简报**（纯 HTML，每卡一个深链接）。现有 `AppShell`、侧边栏、`ui/` 原语（`Button / Card / ConfirmDialog / Input / SegmentedControl / Toaster / ShortcutHelp`）、命令面板与设计令牌（`index.css` 已按 WCAG AA 调色）全部沿用。

### 23.2 全局交互规则（十二条，进评审清单）

| # | 规则 | 实现要点 |
|---|---|---|
| 1 | 状态词汇单一来源 | 运行 / 计划 / 证据 / 回合四套状态只从 `@evimed/domain.states` 取；颜色映射表唯一：`accepted → --ok`、`degraded / stale / unverified → --warn`、`failed / rejected → --error`、进行中 `--accent`、其他 `--muted` |
| 2 | 四态纪律 | 每个列表与卡片都有加载（骨架）/ 空（含一个动作）/ 错误（错误码 + 「复制诊断」）/ 成功；错误文案来自 domain 错误码注册表的中文表，不在组件里写死 |
| 3 | 可撤销优先于确认 | 删除、归档、驳回、停用用 toast 撤销（8 s）；只有不可逆动作（删除胶囊 / 数据集、撤回分享、清空议程）用 `ConfirmDialog` 并复述后果 |
| 4 | 「新」标记 | 系统产生的一切（记忆、方法、发现、简报、回执）带「新」直到用户看到；已读状态服务端持久 |
| 5 | 流式与停靠 | 流式尾部隔离渲染；自动跟随到底；用户上滚即停靠并出现「回到最新」 |
| 6 | 渐进披露 | 默认摘要 → 展开细节 → 再展开原始（轨迹检查器带 `raw`）；默认折叠推理、系统注入、压缩标记 |
| 7 | 成本可见 | 任何会消耗额度的动作执行前显示预估区间（P50–P90，§25.3）、执行中显示已用、结束显示实际；峰时显示「当前高峰 2×，改到夜间可省一半」 |
| 8 | 时间 | 相对时间 + 悬浮绝对时间；北京时间；长任务显示「开始于 / 已运行 / 预计」 |
| 9 | 键盘与命令面板 | `⌘K` 已有；新增动词：开始主动科研、分享工作方式、记到胶囊、插话、停止当前运行、改到夜间 |
| 10 | 无障碍 | `aria-label` 全覆盖（现状风格延续）、焦点顺序、`prefers-reduced-motion` 关闭流式动画与骨架闪烁 |
| 11 | 文案 | 简体中文基线；动词短句；不出现运行时名词；数字带单位；错误说「发生了什么 + 你能做什么」 |
| 12 | 令牌 | 禁止任意值（ESLint 已有）；图表只用 `--series-1..8` 与 `--chart-*` |

### 23.3 页面规格

#### 23.3.1 会话页：执行流程的呈现

三栏：左导航 / 中流 / 右「运行面板」（可折叠，记住偏好）。

- **输入框**：单一输入，没有「问 / 做」开关——模型决定（§9.6）。发送后若模型写了计划，流中插入**计划卡**：交付物清单（能力 · 契约种类 · 依赖）、预估额度区间、预计时长、两个按钮「调整」（改写计划，经 `steer`）与「改到夜间执行」（转为一次自主回合，§24）。运行中输入框自动变为「插话」（`session.prompt{mode:'steer'}`），提示「正在运行，你的话会在下一步生效」。附件：P0 文本；图片随 §17 G5 开放。
- **流**：按步骤分组；每步一行**旁白**（确定性生成，§23.3.6）；工具卡片 = 动词短句标题 + 参数摘要 + 结果摘要 + 耗时 + 状态（完成 / 出错 / 沙箱拒绝）；检索类工具用结果表（题名、年份、来源、是否已入台账）；文件写入用 diff；bash 用输出尾部。推理默认折叠；「系统注入」行折叠并说明注入了什么（题面、胶囊、审查建议）；压缩标记行不替换上文。
- **分工**（子代理）：流中一行「分工：证据综述 × 5 正在进行」，点开进入运行面板的运行树；子代理的回报以折叠卡出现在父流。
- **运行面板**：运行树 / 交付物 / 证据 / 预算四个 tab；状态条常驻：状态、步数、已用额度、「停止」。
- **回合尾**：交付物回执行（文件名可点开预览、回执摘要、门禁结论）；「本次学到」卡（§19.19）；评价（👍 / 👎 + 一句话）——评价写入账本并进入 §24.4.8 的学习回路。
- **终态**：`completed / degraded / failed / canceled / max-tokens / blocked` 各有明文解释与**可执行的下一步**（重试被退回的交付物、从某步分叉、缩小范围、改到夜间）。

#### 23.3.2 运行树

- 节点：编排器（根）、分工（能力、标签、状态、步数、额度、回报摘要）、交付物（契约种类、状态、回执）、后台作业（专科引擎，§21.7）。边：委派、依赖（`dependsOn`）、产出。
- 布局：纵向树，按能力分组；超过 12 个子节点折叠为「证据综述 × 30（28 完成 · 2 进行）」，展开虚拟滚动。
- 交互：点节点 → 右侧只读转写（标明「已完成的执行记录」）；「从此步分叉」（`session.fork{atSeq}`）→ 新会话预填；失败节点显示错误码与「重派」。
- 实时：`subagent/update`、`deliverable/update` 驱动；节点状态变化有 300 ms 过渡；无动画模式下只变色。
- 每节点标出它带着哪些方法与知识工作（§19.19）。

#### 23.3.3 交付物与回执

列表 → 预览（Markdown / 表格 / JSON 渲染，PDF 内嵌）；回执卡：sha256 前 8 位、契约种类、bundle / domain 版本、门禁结论（通过 / 通过但有提示 / 被退回 n 次后部分交付）；被退回的 issue 按「必修 / 建议 / 可选」分层显示；`verification` 三值用文案而非颜色单独承载（现有 `RunsPage` 的写法延续）。

#### 23.3.4 证据台账

claim 表：陈述、类型（direct / synthesized / derived）、来源数、核验状态、撤稿标记、时效；筛选：未核验 / 有争议 / `stale`；点击 → 来源片段与引文；导出 CSV / BibTeX。矛盾边（P2 `evimed_review_run`）以「⇄ 与 X 冲突」内联显示。

#### 23.3.5 能力模板

卡片：标题、一句 `whenToUse`、预计时长、典型额度、输入表单（`inputs`）；点选 = 预填题面并点名能力（高置信期望）；顶部说明「你也可以直接在新任务里用自然语言说，模板只是起点」。

#### 23.3.6 旁白（narration）规则

旁白是**确定性**的，不调用模型：`@evimed/domain.narration` 按工具名与参数生成动词短句模板——`mcp__evimed__literature_search{query}` → 「检索文献：『…』→ n 条」；`write{path}` → 「写入 deliverables/x/…」；`subagent{capability}` → 「分工给 证据综述」；`evimed_submit_deliverable` → 「提交交付物 x：通过 / 被退回（3 项必修）」。未知工具 → 「调用 {名}」并计数。主动科研的「直播」另加可选的模型旁白（§24.9）。

#### 23.3.7 运行记录页

现有列表扩展：运行树入口、交付物数、额度、`verification`、来源（交互 / 主动）；「待人工复核」分组（`degraded` + `partial`）置顶；批量导出。

### 23.4 上传与摄入流程（资料 + 数据）

**入口**：胶囊页「资料」「数据」两个拖放区 + 会话页附件 + 冷启动向导。口号不变：「全倒进来，我们来理」。

**传输**：改为分块可续传——`POST /api/uploads{name, bytes, sha256, uploadType}` → `PUT /api/uploads/:id/:n`（4 MB 块，乱序、可重传）→ `POST /api/uploads/:id/complete` 校验 sha256；上限：文档 200 MB、数据 2 GB、音频 1 GB（`config.mjs` 三个字段，替代单一 `maxFileBytes` 用于胶囊）；胶囊存储配额默认 10 GB（配置）。浏览器断网后重连续传；关闭页面后服务端继续解析。

**每个文件的状态机**（列表里逐行可见，失败不阻塞其他文件）：

```text
queued → uploading → scanning（病毒 / 可执行 / 加密 / 重复）→ parsing → distilling → done
                                      └─► needs_attention（加密 PDF 要密码、无法解析、疑似含个人信息、超限）→ 用户处理后回到 parsing
```

**逐类型分支**：

| 类型 | 解析 | 特殊交互 |
|---|---|---|
| PDF（含扫描件）、Word、PPT | **MinerU**（CJK 版面与公式、表格输出 HTML、公式 LaTeX；CPU 可跑、GPU 更快，V26）为主；若《文档结构化解析 API》（`接口文档/多模态文档解析.md`，`/api/v1/extract/text/{file,url}`）可部署则作首选（V31）；`pypdf` 快速兜底取纯文本 | 扫描件显示「OCR 中」；图表经 `deepseek-v4-flash-vision-exp` 生成描述 |
| Excel / CSV / Parquet | 作为**数据**而非文档：DuckDB 读取 → 画像（schema、缺失、分布、候选主键、日期范围）→ 列级分类 | 进入数据画像与分级（下文） |
| 数据库 | 文件库：SQLite / DuckDB / `.sql` 转储 / SPSS `.sav` / Stata `.dta` / SAS `.xpt` → 导入为 DuckDB；**在线连接**（Postgres / MySQL 只读账号）另立阶段：经专用出站连接器、目标地址白名单、只读事务、行数上限——不豁免 SSRF 规则 | 连接向导：测试连接 → 选表 → 抽样画像 |
| 音频 | `/internal/asr/v1`（云 → 自建 FunASR，契约不变）：分段、说话人、标点；> 2 h 自动切片 | 可选一句「这段录音是…」作为上下文；转写稿可编辑后再蒸馏 |
| 图片 | 视觉模型描述 + OCR | — |
| 文本 / Markdown / 网页剪藏 | 直接切片 | — |
| 压缩包 | 展开一层（嵌套压缩拒收）、总数与体积上限 | 展开后逐文件进入队列 |

**数据画像与分级**（G12；**不设同意卡、不设审批**——合规与版权由用户方的管理资质覆盖，2026-08-23 拍板）：列级检测身份证、手机号、姓名、病历号、精确日期与地址（`sensitivePattern` 扩展为数据列模式）→ 数据集标为 `public / patient-level`。分级只决定两个默认值：分享范围（`patient-level` 默认不进任何工作方式包，用户可改）与挂载策略（`patient-level` 数据在主动科研中同样可用，但原始行不进模型上下文、分析只在沙箱里跑——这是成本与质量的工程选择，不是门）。用户可一键生成去标识化副本（删除直接标识符列、日期偏移、年龄分箱）用于分享或外部协作，转换记录留在时间轴。

**摄入完成后用户看到什么**：每份资料一张结果卡——摘要、产出的候选事实（n）、方法线索（n）、敏感标记；批量「采纳全部 / 逐条看」；时间轴写入 `upload`；一周内首次上传超过 20 份时生成「从你的 37 份资料里我们了解到…」总结卡。解析失败的资料保留原文件并可重试；重复文件（sha256 相同）直接标「已存在」。

### 23.5 分享记忆胶囊的流程

**发送方**（胶囊页「分享我的工作方式」；方法卡「分享此方法」为快捷入口）：

1. **选范围**：默认工作方式包（§19.15）；可加 `+profile / +knowledge / +documents`；可选单个方法。
2. **预览**：右侧实时渲染**「对方会看到什么」**——以接收方视角显示方法列表、标准与偏好、范例、依赖知识计数；每项可展开、可勾掉、标注「为何纳入（被方法 X 引用）」。
3. **脱敏报告**：PHI / 凭据 / 机构 SOP 扫描结果内联列出（「已剔除 3 处、已匿名化 2 处」），不弹窗。
4. **投递**：平台内用户名 / 邮箱邀请或链接（默认 30 天过期、一次性）；`reshare` 默认关；附 `license` / `attribution`；可选「附一句话介绍」。
5. **管理**：「我分享出去的」列表：接收状态、版本、激活情况（仅计数，不看对方内容）、「推送新版」「撤回」（撤回只影响未来版本，已接收快照归对方；界面复述这一点）。

**接收方**：

1. **预览页**（未登录先注册）：谁分享、包含什么（方法名与 `whenToUse`、标准摘要、范例计数）、脱敏声明、许可。
2. **试用一次**：在一个临时会话里用对方的方式跑一个自己的小题面（`guest` 模式、不写入我的记忆、限额度上限）——「先试后用」是采纳率的关键。
3. **激活**：选择 `guest`（默认，按对方方式）或 `blend`（只取方法与知识）；激活后所有会话顶部出现身份条「以你的身份 · 按 A 的方式」，点击可切换或停用；运行树节点标注来源方法。
4. **更新**：对方推送新版 → 收件箱一条「审阅」类条目，显示版本 diff（方法级），可升级或保留旧版。
5. **停用 / 删除**：随时；删除即删除客体 cube 与技能注册；审计日志对双方可见（时间、版本、动作）。

边界与状态：过期链接 → 明确提示并提供「请求重新分享」；同名方法冲突 → 激活时展示 diff 并说明「A 的优先（guest）」；一次只激活一个客体包；`restricted` 来源在任何范围都不出现（服务端强制，非界面约定）。

### 23.6 收件箱与通知

借 LangChain「ambient agents」的三类人机回路：**通知**（只需知道）、**提问**（Agent 被卡住需要信息）、**审阅**（需要批准的动作）。收件箱按优先级而非时间排序（审阅 > 提问 > 通知），同一运行的条目聚合为一卡；每条带来源（哪次运行 / 哪个线程）、截止与默认行为（「3 天未处理将跳过该方向」）、一键动作。渠道：站内（必有）、邮件（可选，每日简报 + 即时审阅项）、微信（企业微信 webhook / 公众号模板消息，后续渠道适配器，§25.4）。静默时段默认 22:00–08:00 不推即时通知，简报固定 08:00 送达。

---
## 24. 主动式科研（Autopilot）：AI 在夜里做研究，人早上做决定

### 24.1 评估：思路成立，三处修正

用户的设想——「用户的胶囊里有数据，就用这些数据主动做科研，24 小时科研直播，人只需要充值 token、每天有个地方等着看结果」——是这套架构里**差异化最强的一步**：它把「胶囊（我是谁、我怎么干活、我有什么数据）+ 统一编排（模型计划与委派）+ 契约门禁（产出可检）+ 专科引擎（确定性统计）」四样已有的东西接成一个会自己转的回路。同类产品里最接近的是 ChatGPT Pulse（2025-09-25 发布：夜间按记忆与反馈做研究、次日早晨以卡片呈现、可「curate」与点赞点踩）与 Edison 的 Kosmos（单次运行最长 12 小时、约 200 个 agent rollout、4.2 万行代码、读 1,500 篇论文，靠一个结构化世界模型在数据分析与文献检索之间传递信息）。方向正确，但要做三处修正才能成立：

| # | 修正 | 为什么 |
|---|---|---|
| 1 | **卖点不是「直播」，是「每天早上有结果，你只做决定」**；直播是信任机制，不是消费面 | 没有人看 24 小时直播。Pulse 的形态是「夜间研究 → 早晨卡片」；Devin / Manus 的「电脑视图」解决的是「它在干什么」的信任问题。所以三个面各司其职：**简报**（消费）、**直播**（透明）、**收件箱**（控制） |
| 2 | **自主 ≠ 放任：每一晚做的是「预注册的研究回合」，不是「去发现点什么」** | Kosmos 的专家评估：数据分析陈述 85.5% 可复现、文献陈述 82.1% 有据，但**综合解释性陈述只有 57.9% 准确**，且「倾向于做出过强主张」「会发明难以解释的新指标」；Sakana AI Scientist 的独立评估：**42% 的实验因代码错误失败**、存在编造数字、引文陈旧（34 条里只有 5 条 2020 年后）。无人值守会把这些错误按晚数放大。对策：验证优先（独立反驳者 + 重跑复现）、陈述分级、数据分析先冻结分析计划再碰结果列（预注册）、综合性陈述永远带「何种证据会推翻它」 |
| 3 | **额度必须透明，且把夜间 5 折传导给用户** | Manus 的差评集中在「没有事前预估、任务结束才知道花了多少、整月额度几天用完」。DeepSeek 自 2026-08 起峰谷计费：峰时 UTC 01–04 与 06–10 周一至周五（北京时间 09–12、14–18），**谷时 5 折**——「AI 在你睡觉时干活」在账面上就是半价。对策：事前预估区间、日上限、实时计量、结束对比、夜间优先调度 |

什么是现实的、什么不是：**现实的**——文献哨兵与证据更新（确定性、便宜、每天都有新东西）、在用户数据上做预注册的探索与确认分析（沙箱里的 Python / R + 专科引擎）、假说竞技场（生成-辩论-演化）、从已采纳发现起草手稿节。**不现实的**——「AI 写完论文直接投稿」：投稿与署名是人的决定；我们的产出永远是「AI 起草、待人签核」，签核之后的事不在平台内。

### 24.2 可核实的参照系

| 来源 | 取 | 不取 |
|---|---|---|
| Kosmos（Edison Scientific，arXiv 2511.02824，2025-11） | **结构化世界模型**（实体、关系、实验结果、开放问题，每轮更新、可查询）作为跨回合记忆；每轮 ≤ 10 个任务并行；每条陈述指向文献或 notebook；专家评估按陈述类型分开报告 | 单次 12 小时连续运行（我们按回合切分，每回合独立计费与门禁）；它「无法处理 > 5 GB 数据、原始影像 / 测序」的边界我们同样承认 |
| Google AI co-scientist（Nature 2026；arXiv 2502.18864） | **generate → debate → evolve**；假说以 **Elo 锦标赛**排名；测试时算力越多质量越高；湿实验验证（AML 药物再利用、肝纤维化靶点） | 无上限的算力投入（我们按日预算） |
| Sakana AI Scientist-v2 及其独立评估（arXiv 2502.14297） | 失败模式清单：代码错误、编造数字、陈旧引文、新颖性误判；每篇 6–15 美元的成本量级 | 全自动投稿 |
| ChatGPT Pulse（2025-09） | 夜间研究 → 早晨卡片；「curate」引导明天做什么；逐卡点赞点踩 | 仅手机端 |
| Manus 额度体系 | 反面教材：无事前预估、无超支预警 | — |
| Cochrane / PRISMA 2026 | Cochrane 综述 64.3% 从未更新、更新中位间隔 57.2 个月——**living review 的空位**；PRISMA 2026 为 living SR 增加并行清单：更新频率、重跑检索的触发条件、新证据改变合并估计的处理、版本记录 | — |
| 预注册文献（arXiv 2606.27687「为下一个 LLM 预注册」、2606.11217「AI agent 实验的预注册」） | 自主分析系统会 p-hacking；对策是**先冻结分析程序再跑确认分析**、区分探索与确认、登记可审计 | — |
| LangChain ambient agents | notify / question / review 三类回路；收件箱按优先级 | — |
| Agents4Science 2025（Stanford / Together AI；315 投稿、48 接收、仅 5 篇全 AI；arXiv 2511.15534） | **问题来自人**：审稿人评价 AI 论文「技术正确但既不有趣也不重要」、「技术能力掩盖糟糕的科学判断」，获胜论文来自人类给出真实问题的上下文 → 回合只从用户议程出发，假说只作建议卡，「有趣与重要」留给用户 | 让 AI 自选课题 |
| DSH 源码 | `goal` 自述「**state, not scheduling**」：只记一个目标与回合数，不计 token、无独立评估、恢复后需人工重新武装；`ralph`：每轮全新子代理、**工作区即长期记忆**、结构化交接 `continue / complete / blocked`、在一次工具调用里前台等待；`ctx.jobs` 是进程内契约，「durable or cross-process backend must reshape identity…」 | 用 DSH 做跨日调度——调度权在控制面（§24.7） |

### 24.3 产品定义

**一句话**：用户把资料和数据倒进胶囊、设一个每日额度，EviMed 每晚按研究议程跑若干个预注册的研究回合，早晨用简报告诉用户「发现了什么、什么变了、需要你决定什么、花了多少」；用户在手机上做决定，决定又改变下一晚的议程。

**三个面**：

| 面 | 回答的问题 | 形态 |
|---|---|---|
| 今晨简报 | 「有什么结果？」 | 每日 08:00 固定送达的卡片流（站内 + 邮件 + 微信），每卡一个发现 / 变化 / 决定，带分级徽章与一键动作 |
| 科研直播 | 「它在干什么？可信吗？」 | 实时运行树 + 旁白流 + 发现墙；可插话、可停；有回放 |
| 收件箱 | 「需要我做什么？」 | 审阅 > 提问 > 通知；默认行为与截止 |

**研究线程**（thread）= 一个议程（§24.4.1）+ 一个专用的自主项目（复用每项目一个容器的全部隔离机制）+ 一个预算 + 一组数据集授权。一个用户可有多个线程（课题级）；胶囊是线程的共同上下文。

**六种自主任务**（按确定性从高到低；每种映射到已有能力，**不新增内核能力**）：

| 任务类型 | 做什么 | 用到的能力 / 引擎 | 成本级 | 默认开关 |
|---|---|---|---|---|
| 文献哨兵 | 按议程里的检索策略每日查新（PubMed / CT.gov / 指南 / 预印本）；按 PICO 筛选；撤稿与更正监测 | `literature_search`、`guideline_search`、`clinical_trial_search`、`evimed_screen_batch`、撤稿检查（§8.2 第 7 条） | 低 | 开 |
| 证据更新（living review） | 新记录进入既有综述：增量提取、重算合并估计、结论是否翻转、生成「变化了什么」 | `clinical-evidence-synthesis`、`meta-analysis` 引擎 | 中 | 开 |
| 数据探矿 | 在用户数据集上：探索分区做描述与假说生成；确认分区只在分析计划冻结后运行 | 沙箱 Python / R、`dataset-research-scoping`、`mendelian-randomization` 等引擎 | 中–高 | 开（确认分析在计划冻结后自动跑） |
| 假说建议 | 生成候选假说 + 新颖性核对（带引文）；**v1 不做锦标赛**（§24.4.6） | `research-topic-selection` 引擎、`research-brief` | 中 | 开 |
| 写作流水线 | 从已采纳发现起草手稿节（按用户方法与报告规范） | `manuscript-support`（P2 能力） | 中 | 关（用户打开） |
| 信号监测 | 药物安全用户：FAERS / ADR 不成比例信号每日监测 | `drug_safety_analysis` 引擎、`adr_signal_analysis` | 低 | 开 |

**没有自主等级**（2026-08-23 收口，去掉 L0–L2）：每个线程只有按任务类型的开关（默认见上表）+ 日上限；唯一的人工步骤是**产物离开平台前的签核**。第一晚默认只跑哨兵与信号监测（校准议程），第二晚起按开关执行。任何情况都不碰 `regulated` 能力、不对外发送任何东西。

**用户旅程**：3 分钟开启（选胶囊里的课题或数据集 → 系统建议 3 个研究问题与检索策略 → 设日上限与执行时段 → 数据集授权）→ 第一晚只跑哨兵与信号监测（校准议程）→ 次日 08:00 第一份简报 → 用户做 3 个决定（采纳 / 驳回 / 追问）→ 一周内议程校准 → 稳态：每天 5 分钟。

### 24.4 算法（算法总监视角）

#### 24.4.1 研究议程 = 世界模型

控制面 Postgres 的 `agenda_items` + 工作区投影 `agenda.md`（每回合注入模型的摘录）。借 Kosmos 的世界模型思想，但结构对准循证医学：

```text
agenda_items(id, thread_id, itemType, payload jsonb, status, score, elo, provenance jsonb, valid_from, valid_to, recorded_at)
  itemType ∈ question  { pico:{P,I,C,O}, mesh:[…], status: open|answered|parked, why:"…" }
       ∈ hypothesis    { statement, rationale, evidence_for:[claimId], evidence_against:[claimId], elo, novelty:{score, checked_at, nearest:[doi]}, tests:[…] }
       ∈ claim         { statement, tier: reproduced|gated|unverified, type: direct|synthesized|derived, sources:[…], notebook?, effect?:{estimate, ci, n}, what_would_change:"…" }
       ∈ watchlist     { strategy:{query, sources, filters}, last_run, new_since_last, seen_ids:[…] }
       ∈ dataset       { dataset_id, profile_digest, classification, consent, splits:{exploratory, confirmatory}, plans:[planId] }
       ∈ analysis_plan { hypothesis_id, variables, model, covariates, multiplicity, stopping, frozen_at, sha256, status: draft|frozen|run|reported }
       ∈ task          { type, inputs, cost_class, due, blocked_by }
       ∈ decision      { question, options, default_action, due, cost_impact }
```

- 每条 `provenance` 指向回合 / 交付物 / 用户动作；双时间（与胶囊一致）；冲突不覆盖，旧项 `valid_to` 失效。
- `agenda.md` 投影 ≤ 3,000 token：开放问题、前 5 假说、最近 10 条 claim、待办、预算余量——这是回合的「工作记忆」；完整议程经 `evimed_capsule_recall{scope:'agenda'}` 查询。
- 议程属于线程，胶囊属于用户：议程引用胶囊的知识与方法，线程结束时稳定的 claim 经 §19.22 A3 晋升到胶囊知识层。

#### 24.4.2 每日计划：候选 → 评分 → 组合分配

每个执行窗口开始时跑一次**计划回合**（Flash 模型、低成本），产出 `episode-plan` 交付物（契约机械可核：每项含类型、输入、预估成本级、依赖）；然后由**代码**做分配：

1. **候选生成**（模型 + 代码）：哨兵增量（`new_since_last > 0`）、开放问题、Elo 上升中的假说、有未执行冻结计划的数据集、用户昨日的「追问」与「curate」输入、上一回合留下的 `task`。
2. **评分**（代码，权重进配置）：

```text
priority = w_user · userSignal + w_nov · novelty + w_gap · evidenceGap + w_fresh · freshness − w_cost · costClass
默认 w = (4, 2, 2, 1, 1)；userSignal ∈ {追问 1.0, 采纳 0.6, 点赞 0.3, 驳回 −1.0}
```

3. **防锁死**（v1 用确定性规则，不上 Thompson 采样）：同一方向连续 3 回合无 `gated` 以上 claim → 优先级减半，再 3 回合 → `parked`；用户驳回 → 该方向置底；用户追问 / curate → 置顶。Thompson 采样留作后期可选（A3+）。
4. **组合分配**（代码）：按日预算（§25.2）、单回合上限、线程并发上限（默认 2）、能力清单的 `autopilot.taskTypes`（非空即可自主）、数据集开关、任务类型开关、**谷时优先**（高成本级只排谷时），按优先级贪心装入；剩余预算回滚到明天（上限一天）。
5. 分配结果写 `autopilot_episodes(queued)`，并在简报里以「今晚计划」卡预告（用户可在 22:00 前删改——这就是 Pulse 的 curate）。

#### 24.4.3 回合执行：一回合 = 一次普通运行

回合不是新内核能力，而是**系统发起的运行**：同一个 `evimed-universal`、同一套 `task-plan.json` / `evimed_delegate` / `evimed_submit_deliverable` / `evimed_complete_run`、同一份服务端门禁。差别只有四点：

1. 题面由控制面从议程生成（`.evimed-brief/brief.md` = 任务类型模板 + 议程摘录 + 冻结的分析计划 + 数据集挂载说明）。
2. 预算来自分配器（步数 / token / 子代理 / 时钟），`partial` 允许。
3. 必产出一份 **`agenda-delta`** 交付物（契约种类，domain 校验 JSON schema：新 claim 必带 `type`、`sources`、`tier: unverified`；新假说必带 `evidence_for/against`；每条必带 `provenance`）。
4. 运行结束后控制面**确定性合并** delta 到议程：同一陈述去重（语义相似度 + 实体集合）、矛盾成对进收件箱「审阅」、`tier` 只由验证回合提升（模型不能自评为 `reproduced`）。

长任务被切成回合的原因：压缩摘要是有损的（§2.6），DSH `ralph` 自己也把「工作区」而非上下文当长期记忆；按回合切分使每回合可独立计费、门禁、取消、重试，控制面重启后只需重排队（CLAUDE.md「长任务必须可断点续跑」在这里的落法：议程与账本就是 STATUS 文件）。

#### 24.4.4 验证优先与分级

每个候选 claim 经三道：

| 道 | 机制 | 通过后的 tier |
|---|---|---|
| 契约门禁 | 与交互运行相同（§8） | `gated` |
| 独立反驳者 | `evimed_review_run`（§8.3）以**反驳**为目标：全新上下文、只看陈述与来源、附加接地工具；输出 `refuted / weakened / stands` 与依据；每晚每线程 ≤ 20 条 | `stands` 才保留 `gated`；`refuted` 直接降为 `unverified` 并附理由 |
| 重跑复现（仅数据分析） | 验证回合在干净沙箱从 `reproducibility-pack`（代码 + 环境 + 数据摘要 + 随机种子）重新执行，数值在容差内（默认相对 1e−6；有随机性者比较固定种子结果） | `reproduced` |

规则：**简报头条只放 `reproduced` 或「direct 型且 stands」的 claim**；`synthesized` / `derived` 型陈述必须带 `what_would_change`（何种证据会推翻它）与置信标签，并在简报里用「解释」而非「发现」的措辞——这是针对 Kosmos 57.9% 的直接对策；模型「发明新指标」的倾向用契约限制：数据分析交付物的 `effect` 字段只接受能力清单列出的效应量与统计量名。

#### 24.4.5 预注册守卫（数据分析）

1. 数据集注册时控制面按行哈希**确定性**切出探索分区（默认 30%）与确认分区（70%）；分区 id 写入议程，回合只能看到授权分区。
2. 探索分区：允许描述统计、假说生成、模型选择；产出的是**假说与分析计划草稿**，不是结论；多重比较默认 Benjamini–Hochberg 标注。
3. 分析计划冻结：`analysis_plan` 由模型起草、代码校验（变量存在于 schema、模型在允许集合、主要终点唯一、样本量估计、停止规则）后自动 `frozen`（sha256 + 时间戳写议程与时间轴）——**冻结是记录，不是审批**；用户随时可看、可作废。
4. 确认分区只在计划 `frozen` 后挂载（控制器按分区挂载卷，`run-policy` 路径守卫拒绝越界读取）；确认回合只能跑冻结计划里的分析；偏离（新增协变量、换模型）必须作为新计划再冻结。
5. 报告：确认结果与冻结计划并排；探索性发现明确标「探索性」；`reproducibility-pack` 随附。
6. 这一整套是《预注册》文献对 LLM 自主分析的建议在产品里的直接落地；它也是 Kosmos「过强主张」问题在数据侧的对策。

#### 24.4.6 假说建议（v1）与竞技场（后期可选）

- **生成**：每个开放问题每晚生成 ≤ k（默认 5）个假说；每个假说先做**新颖性核对**——检索（MeSH 规范化查询）+ 独立裁判比对最近邻文献并给出「已知 / 部分已知 / 未见」与引文（Sakana 的新颖性误判是常见失败，所以裁判必须引用而不是打分）。
- **v1 只出建议卡，不做锦标赛**：Agents4Science 2025（315 投稿、48 接收、仅 5 篇全 AI 论文）的审稿结论是 AI 作者的论文「技术正确但既不有趣也不重要」、「技术能力会掩盖糟糕的科学判断」，而获胜论文来自人类提供真实问题的上下文。所以假说在简报里是**建议卡**（假说 + 依据 + 新颖性核对 + 可做的检验），由用户决定哪个进入议程；「有趣与重要」的判断留给人。
- **后期可选**（A3+，条件：假说卡采纳率稳定 ≥ 30%）：AI co-scientist 式成对辩论 + Elo 排名；用户投票 = 一场胜负。

#### 24.4.7 停止规则与防失控

| 规则 | 默认 | 行为 |
|---|---|---|
| 单回合上限 | 按任务类型（步数 / token / 子代理 / 时钟 2 h） | 超限 `partial` 交付 |
| 日 / 周上限 | 用户设日上限；周上限 = 日上限 × 7 | 用尽即停，简报说明 |
| 方向收益递减 | 连续 3 回合无 `gated` 以上 claim | 优先级减半，再 3 回合 `parked`；简报说明「X 方向暂停探索」 |
| 反复失败 | 同一任务类型连续 2 回合 `failed` | 暂停该类型，进收件箱「审阅」 |
| 无人看 | 简报连续 7 天未打开 | 线程自动暂停，邮件 / 微信一条「已暂停，点此继续」（信任：不烧用户的钱） |
| 余额 | 低于 1 天日上限 | 暂停自主；交互运行仍可用到硬下限 |
| 硬禁 | `regulated` 能力、对外发送、购买、目录外数据源 | 计划回合根本看不到这些选项（能力目录与数据集开关过滤） |
| 总闸 | 用户「全部暂停」 | 立即取消排队回合、`session.cancel` 运行中回合 |

#### 24.4.8 学习回路

用户的每个决定都是信号：采纳 / 驳回 / 追问 / 投票 / curate → (a) 方向臂的奖励（§24.4.2）；(b) 胶囊：采纳的 claim 晋升知识层，驳回理由成为 `lesson`，用户改过的分析计划成为方法 delta（§19.22 A3、§19.17 L2）；(c) 议程：追问直接生成明日任务。回路全部是代码与数据，不训练模型（§19.17 边界）。

### 24.5 数据资产：保险库、分级、分区、挂载

| 环节 | 设计 |
|---|---|
| 存放 | **数据保险库**（对象存储，按用户隔离，服务端加密）；胶囊只存画像（schema、统计、codebook、分级、分区 id）——§19.6 S2「原始行永不入库」对胶囊仍成立 |
| 分级 | `public / deidentified / identified`（§23.4）；`identified` 永不进入主动科研 |
| 授权 | 数据集级使用开关（交互 / 主动；可随时关闭）；关闭后排队回合取消、议程中的派生 claim 标 `dataset_disabled`（不删除，时间轴可见） |
| 分区 | 探索 / 确认分区按行哈希确定性生成（§24.4.5） |
| 挂载 | 回合启动时控制器把授权分区以**只读卷**挂到 `data/<dataset-id>/`；`run-policy` 路径守卫禁止写入该目录与读取未授权分区；工作区导出 tar 不含 `data/` |
| 体量 | 单数据集 ≤ 2 GB（Kosmos 的 5 GB 边界同量级）；超出者先在控制面做抽样或列裁剪 |
| 用户数据不外送 | 分析只在沙箱里跑；模型只看到 schema、统计与分析结果表，不看原始行（`run-policy` 对 `read` 工具在 `data/` 下只允许 `head` 级预览，行数上限配置） |

### 24.6 签核、可复现与禁止事项

> 合规、伦理与版权由用户方的管理资质覆盖，不在本方案范围（2026-08-23 拍板）；本节只留产品质量所需的三件事。

- **声明**：自主产物的 `delivery-summary.md` 与导出手稿带「AI 起草 · 已由 X 签核」字样并附可复现包——这是给读者的质量信号。
- **签核**：任何产物要离开平台（导出为手稿、投稿包）必须经用户签核，签核记录进时间轴；`tier` 低于 `gated` 的 claim 不能进入导出正文，只能进附录「待验证」。
- **禁止事项**：不对外投稿、不发邮件、不购买数据、不访问目录外来源、不生成个体诊疗建议（内容触发器照旧）。
- **可复现包**（新契约种类 `reproducibility-pack`）：代码、环境（镜像摘要）、数据摘要与分区 id、随机种子、运行 id、结果表；验证回合与用户都能从它重跑。

### 24.7 后端架构

```text
                    ┌──────────────── 控制面 apps/server ────────────────────────────────────┐
                    │ autopilotScheduler.mjs   Postgres 队列（FOR UPDATE SKIP LOCKED）+ 领导者 advisory lock │
                    │   窗口：默认谷时（北京 18:00–09:00 + 12:00–14:00 + 周末）；公平调度：按用户日上限加权轮转 │
                    │   容器池：maxAutopilotRuntimes（独立于 MAX_RUNNING_RUNTIMES）；空闲停止豁免；每回合后可回收 │
                    │ agendaService.mjs        议程 CRUD、delta 合并、投影 agenda.md、优先级状态                │
                    │ episodeRunner.mjs        = AgentRunStore.reserve/dispatch 的调用者；brief 生成；数据卷挂载请求 │
                    │ creditMeter.mjs（§25）   网关侧计量；分配器读余额                                           │
                    │ notificationService.mjs  简报生成（08:00）、即时审阅项、渠道适配器                           │
                    │ datasetVault.mjs         上传、画像、分级、分区、挂载签发                                    │
                    └──────────────┬───────────────────────────────────────────────────────────┘
                                   │ 与交互运行完全相同的 DshRuntimeAdapter / 账本 / 门禁 / 事件流
                                   ▼
                    线程的自主项目容器（deploy/runtime-dsh，同一镜像）：data/<id>/ 只读卷 + .evimed-brief/ + deliverables/
```

- **不引入 Redis / BullMQ**：队列是 Postgres 表（与 §10.1 一致）；一个进程当领导者，`SKIP LOCKED` 取回合，崩溃后由账本判断回合是否已终态，否则重排。
- **公共源限速与缓存**（G17）：`publicSourceGateway` 加全局令牌桶（E-utilities 配 API key 后 10 req/s，预留 30% 给交互）、按 `query + source + date` 的结果缓存（TTL 24 h）——100 个线程查同一策略只打一次上游；哨兵检索优先排 UTC 夜间低峰（NCBI 亦建议大批量在其低峰运行）。
- **模型网关**：全局并发上限按「交互优先」分两池；峰谷标记写进 `usage_events`（§25.1）。
- **DSH 缝的使用**：回合 = 普通会话（`session.create / prompt / cancel`）；假说变体用 `session.fork{atSeq}` 从同一前缀分叉（KV 前缀复用，V29 验证账面收益）；长统计作业走 §21.7 的 `ctx.jobs` 包装；**不用** `goal`（「state, not scheduling」）与 `ralph`（前台等待、无独立评估）做跨日调度。
- **表**：`autopilot_threads`、`agenda_items`、`autopilot_episodes(id, thread_id, type, plan jsonb, budget jsonb, run_id, state: queued|running|verifying|merged|failed|canceled, cost, started_at, finished_at, delta_digest)`、`dataset_registry`、`dataset_consents`、`analysis_plans`、`digests`。
- **API**：`/api/autopilot/threads`、`/threads/:id/{agenda, episodes, digest, pause, resume, budget}`、`/api/datasets/*`、`/api/inbox/*`、`/api/credits/*`。事件（SSE，与 §18.4 同一通道）：`episode/state`、`agenda/changed`、`digest/ready`、`decision/requested`、`budget/update`。
- **能力清单新增节** `autopilot: { taskTypes: [...], costClass: low|medium|high, unattendedInputs: [...] }`；`taskTypes` 为空即不可自主（没有布尔字段，§14 规则 16）。
- **新契约种类**：`episode-plan`、`agenda-delta`、`analysis-plan`、`reproducibility-pack`、`surveillance-diff`、`hypothesis-set`——全部在 `@evimed/domain` 注册校验器（D10：新能力 = 清单 + 契约，不改内核）。

### 24.8 评测与指标

| 指标 | 定义 | 目标（试点） |
|---|---|---|
| 采纳率 | 简报里被采纳 / 被呈现的发现 | ≥ 30% |
| 复现率 | 验证回合重跑一致 / 数据分析 claim | ≥ 95%（不一致者不得进简报） |
| 反驳率 | 独立反驳者 `refuted` / 候选 claim | 观测值（越低越好；> 40% 说明生成侧太松） |
| 每百额度发现数 | `gated` 以上 claim 数 / 100 额度 | 趋势上升 |
| 时效 | PubMed 收录 → 进入简报的小时数 | ≤ 36 h |
| 误报 | 用户驳回且理由为「错误」的比例 | ≤ 10% |
| 简报打开率 / 决策时延 | 产品留存 | 观测 |
| 语料 | 31 份 RQ 平价语料之外新增「夜间 30 晚」回放集：固定议程与数据集，每次改动算法跑同一 30 晚，比较上表 | — |

### 24.9 前端：今晨简报、直播、议程板、收件箱、发现、预算

- **今晨简报**（`/agenda`，手机优先）：顶部一行「昨晚 3 个回合 · 花费 ¥12.6（谷时省 ¥12.6）· 余额可用 11 天」；卡片流按重要度：**发现**（claim + tier 徽章 + 一句依据 + 「采纳 / 驳回 / 追问」）、**变化**（living review 的「结论未变 / 合并估计变化 / 新增 n 篇」、撤稿提醒）、**假说榜**（名次 ↑↓、投票）、**需要你决定**（来自收件箱的审阅项）、**今晚计划**（可删改）。每卡可展开到来源与运行。底部「curate」输入框：「明晚重点看…」。
- **科研直播**（`/agenda/live`，桌面）：左：正在运行的回合列表（目标、进度条、已用 / 预算、预计）；中：旁白流（§23.3.6 的确定性旁白 + 可选的模型「主持人」每 10 步一句总结，Flash 生成、可关）；右：运行树与**发现墙**（claim 实时出现，带 tier）；操作：插话、暂停此回合、全部暂停、「明早再看」（静音）。回放：按回合的时间轴拖动（`session.history{beforeSeq}`），自动生成「今晚精华」片段列表。
- **议程板**（`/agenda/board`）：问题 / 假说 / 监测 / 数据 / 待办五列看板；拖动改优先级即改 `userSignal`；每卡显示来源与时间。
- **发现**（`/agenda/findings`）：claim 表（tier、类型、来源、复现、采纳状态）；导出附 AI 声明。
- **预算**（`/agenda/budget` 与 `/account` 共用组件）：余额、日上限滑块、本周花费按任务类型 / 能力堆叠、谷时节省、预测（按近 7 天均值）、充值。
- **开启向导**：三步（课题或数据集 → 建议的问题与策略 → 日上限 / 时段 / 任务类型开关 / 数据集开关），末尾复述「今晚将以观察模式运行，明早 08:00 给你第一份简报」。
- **微文案**：发现卡用「我们发现」仅限 `reproduced`；其他用「看起来」「文献提示」；驳回后出现一句「已记住：不再按这个方向」。

### 24.10 分阶段（A 轨，依赖 P1 + C1 + B0）

| 阶段 | 交付 | 退出标准 |
|---|---|---|
| A0 | 议程模型 + 调度器 + 回合 = 运行 + `agenda-delta` 契约 + 简报（站内 + 邮件）+ 文献哨兵与信号监测 | 10 个内部线程连续 14 晚无人工干预运行；时效 ≤ 36 h；公共源零封禁 |
| A1 | 数据保险库 + 画像与分级 + 分区挂载 + 预注册守卫 + 探索分析 + 独立反驳者 + 直播页 | 复现率 ≥ 95%；注入 / 越权读取测试 0 命中 |
| A2 | 假说建议卡 + 学习回路 + 方向收益递减 + 评测集「夜间 30 晚」 | 采纳率 ≥ 30%；反驳率可观测 |
| A3 | 确认分析（计划冻结后自动）+ 写作流水线 + 签核导出 + 微信渠道；可选：假说锦标赛、Thompson 分配 | 导出物 100% 带声明与可复现包 |
| A4 | 团队线程（多人共用议程）评估；跨线程去重与共享哨兵缓存 | — |

Kill-switch：线程级「全部暂停」；部署级 `OPEN_SCIENCE_AUTOPILOT_ENABLED=0` 停调度器（排队回合保留）。

### 24.11 风险与对策

| 风险 | 对策 |
|---|---|
| 夜间产出大量「看起来像发现」的噪声，用户失去信任 | 头条只放 `reproduced` / direct-stands；反驳者与复现强制；采纳率进指标；第一晚只观察 |
| 用户数据被模型「看见」或被越界分析 | 原始行不进模型上下文；分区只读挂载 + 路径守卫；`identified` 硬禁；分析计划冻结 |
| 成本失控 | 日 / 周上限、预估、实时计量、无人看自动暂停、谷时优先 |
| 公共源封禁 | 全局令牌桶 + 缓存 + API key + 低峰 |
| 议程锁死或漂移 | 收益递减 + 驳回置底 + 用户 curate |
| 模型发明指标、过度解释 | 契约限制效应量集合；综合性陈述必带 `what_would_change` |

---
## 25. 计量、额度与通知（横切基础设施）

> 主动科研与交互运行共用这一层；它们今天都不存在（`billingIntegrated: false`）。原则：**计量在网关（服务端权威），不在运行时**；额度先于功能；通知是产品的一部分而不是运维附件。

### 25.1 计量点

| 资源 | 计量点 | 记录 |
|---|---|---|
| 模型 token | `modelGateway.mjs`：每个流式响应的最后一个 `usage` 块（`stream_options.include_usage` 已在白名单；DeepSeek 返回 `prompt_cache_hit_tokens / prompt_cache_miss_tokens / completion_tokens`，V30 核实流式下的稳定性） | `usage_events(run_id, session_id, step, model, cache_hit, cache_miss, output, peak: bool, cost, at)`；峰谷按 UTC 窗口在写入时判定 |
| 运行时上报的 usage | DSH `assistant/message.usage`（V25：字段是否含缓存拆分） | 只用于运行内预算守卫（§7.4）与 UI 进度，**不作计费依据** |
| ASR / 向量 | `/internal/asr/v1`（分钟）、`/internal/embeddings/v1`（token） | 同表，`resourceType` 区分 |
| 专科引擎作业 | 适配器 `start` 成功即计一次（按作业类型定价） | 同表 |
| 公共源 | 不计费；只计数（配额巡检） | `metrics` |
| 存储 | 每日快照：项目、胶囊、数据保险库、会话日志体积 | `storage_snapshots` |

`agentRuns` 的 `finished` 事件携带本次运行的计量汇总（§7.5 已定），前端的「预算」tab 与简报读同一数字。

### 25.2 额度模型

- **单位**：额度以人民币计价（建议；最终币种与价目是产品决定）；价目表在 `config.mjs`（`pricing.mjs` 读取）按资源 × 峰谷定义；**夜间 5 折直接传导给用户**（不吃差价是「AI 夜里干活更便宜」这个卖点的诚实版本）。
- **账户**：`credit_ledger(user_id, delta, reason: topup|run|episode|refund|adjust, ref, balance_after, at)`；余额 = 最后一行；充值先走后台手工 / 邀请码（B0），支付接入另立阶段。
- **上限**：用户日上限（主动）、线程周上限、单次交互运行**只提示不确认**（计划卡显示预估，超过 P90 时状态条变色）；唯一硬停是余额为零。
- **预估**：按能力 × 任务类型的历史分布给 P50–P90 区间（冷启动用能力清单 `estimatedMinutes` 折算）；预估误差进指标（P90 覆盖率 ≥ 90%）。
- **余额不足**：低于 1 天日上限 → 暂停主动、通知；低于硬下限（默认 ¥0）→ 交互运行拒绝派发（错误码 `credits_exhausted`，UI 直达充值）。
- **告警**：日花费达上限 80%、单回合超预估 P90、余额可用天数 < 3。

### 25.3 交互运行的成本体验

计划卡预估（§23.3.1）→ 状态条实时「已用 ¥」→ 回合尾「实际 ¥ / 预估 ¥ / 峰谷」→ 运行记录按运行汇总；峰时显示「改到夜间可省一半」按钮，点击把该计划转为今晚的一个自主回合（L1 以上）。

### 25.4 通知服务

- `notifications(id, user_id, noticeType: notify|question|review, priority, title, body, actions jsonb, source {run_id | thread_id | share_id}, due_at, default_action, read_at, resolved_at, channels_sent jsonb)`。
- 渠道适配器接口 `send(notification, channel)`：站内（必有）、邮件（SMTP，简报模板）、微信（企业微信群机器人 webhook 最简；公众号模板消息需资质，后续）。
- 偏好：每类开关、静默时段（默认 22:00–08:00）、简报时间（默认 08:00）、聚合（同一线程 5 分钟内合并）。
- 简报 = 一条 `notify` + 深链接到 `/agenda`；审阅项到期未处理执行 `default_action` 并写时间轴。

### 25.5 保留与删除

| 对象 | 保留 | 删除传播 |
|---|---|---|
| 交互运行产物与会话日志 | 随项目；项目删除整卷删除（现状） | — |
| 自主回合产物 | 线程内 90 天（配置），之后只留 `agenda-delta` 与回执 | 线程删除 → 回合、议程、简报一并删除；晋升到胶囊的 claim 保留（来源标「线程已删除」） |
| 数据集 | 用户删除即删（保险库 + 分区 + 挂载签发撤销）；派生 claim 标 `source_deleted` 不删 | 关闭使用开关 = 停止使用，不删除 |
| 通知 | 180 天 | 随用户删除 |
| 计量与账本 | 按财务要求保留（不随项目删除）；导出为 CSV | — |
| 用户删除账号 | `purgeUserMemory` 语义扩展到线程、数据集、通知、额度（余额退款流程为产品决定） | — |

---

## 26. 记忆胶囊的统一分析层：原始库在用户手里，理解在我们这里

> 用户的三个问题：(a) 上传的东西多而杂（发过的文献、书、医案、病例、队列数据、讲课 PPT、录音、视频、课程…），怎么辨别哪些有用、哪些没用？(b) 是不是都抽取全了？(c) 能不能让用户把资料放在网盘里自己维护原始库，我们对接网盘定期分析新内容进胶囊，EviMed 自己产生的数据也经同一个分析层进胶囊？本节给出定案：**(c) 采纳并成为默认形态；(a) 的答案是「不是有用/没用的二分，而是进哪一层、蒸多深」；(b) 的答案是「两种完整性，各有一套可度量的机制」。** §19.6 的 S1–S6 保留为概要，细节以本节为准。

### 26.1 结论先行

| 问题 | 定案 | 一句话理由 |
|---|---|---|
| 原始库放哪 | **用户自己的网盘 / 本地文件夹是原始库；平台上传只是兜底**。我们只保留**派生物**（解析文本、结构化抽取、索引、胶囊条目）与**原件指纹**（路径、哈希、mtime），默认不存原件副本；数据文件例外（要挂载进沙箱分析，复制进数据保险库） | 用户本来就在网盘里维护资料，「再传一遍」是最大的摩擦；胶囊是原始库的「理解」，不是它的「备份」——与「胶囊是上下文不是权限」同构 |
| 怎么接网盘 | 自托管 **OpenList**（AList 社区延续版，AGPL-3.0，聚合 40+ 网盘：百度网盘 / 阿里云盘 / 夸克 / 115 / 天翼 / OneDrive / S3 / WebDAV / 本地，统一 HTTP API + WebDAV）作为「网盘插排」；我们的连接器只讲 OpenList 一种协议；大媒体与限速网盘走**本地分析代理**（`evimed-web` 本地 profile 的一条命令，原件不出本机、只上传派生物） | 同一种「插排-插座」纪律：40 个驱动的变动被收口在一个依赖里，跟版同步用与 DSH / MemOS 相同的四件套 |
| 有用 / 没用 | **分流输出价值向量 → 决定深度**：`index_only / structured / deep`；**所有内容都进索引**（索引完整性 100%，由构造保证），只有值得的部分进结构化层；判定可解释、可覆盖、按用户反馈学习 | 「漏」有两种：找不到 vs 没蒸出来。前者靠索引先行杜绝，后者按价值分层审计 |
| 抽取全了吗 | **可度量**：覆盖台账（每个单元都有去向）+ 必填槽位 + QA 式遗漏审计 + 产出量异常检测 + 定向二次抽取 | 文献：长文档摄入的主要失败是**遗漏而非幻觉**；逐块迭代抽取显著提高召回；QA 式完整性审计对模型选择最稳健（§26.2） |
| 内部数据 | 运行、交付物、主动科研回合、用户反馈、笔记作为「来源」走**同一条线**，只是抽取器不同且便宜（已结构化，多数不需要模型） | 一个分析层、两类来源、一个胶囊；避免两套蒸馏逻辑漂移（与 preflight / 门禁漂移三次的教训同源） |

### 26.2 参照系（取什么、不取什么）

| 来源 | 取 | 不取 |
|---|---|---|
| Mirobody 自托管（docs.mirobody.ai）：**Collect → Standardize → Answer** 三段；provider 契约 `save_raw_data_to_db / is_data_already_processed / format_data → StandardPulseData`；每 provider 拉取周期 + 分布式取件锁；推送型来源走 webhook；概念归一到 LOINC / UCUM；HTTP 服务 + 后台 worker 两进程 | **先标准化再问答**的分层；provider 契约与幂等；目录驱动的扩展 | 它面向设备时序数据；我们的「标准化」对象是文档、媒体与表格 |
| MemReader（MemOS，arXiv 2604.07877）：把记忆抽取从「被动转写」改为**主动决策**——先问三个问题（是否有价值、是否有指代歧义、信息是否完整），再选动作 `add / buffer / search / ignore`；HaluMem 上抽取 F1 98.2%、召回 96.6%、更新遗漏 5.1% | 主动抽取的四个动作用于对话类 / 笔记类来源；**遗漏率**作为核心指标（目标 ≤ 5%） | 它只评估对话输入；文档类输入需要另一套（本节） |
| Comprehensiveness Metrics（arXiv 2510.07926）：长上下文摘要的主要失败模式是**遗漏**；三种度量（NLI 原子分解 / Q&A / 端到端），Q&A 变体对模型选择最稳健；**逐块迭代抽取显著提高召回** | QA 式遗漏审计；逐块迭代 | — |
| FineWeb-Edu：用大模型给样本打「教育价值」分，蒸馏成小分类器后大规模阈值过滤 | 「大模型标注 → 小模型过滤」作为**后期**选项记录；v1 不训练任何模型，用户覆盖落为确定性规则 | 单一标量（我们用五维价值向量）；现在训练 |
| MinHash / LSH 近重复 + 语义去重（NeMo Curator 等） | 文件级精确哈希 + 文本级 MinHash（版本家族）+ 语义近重复（`cos ≥ 0.95`） | — |
| PreMind（arXiv 2503.00162）与讲座视频流水线：幻灯片 OCR、语音转写、按幻灯片切换分段，三路证据对齐 | 录音 / 视频 / 课程的抽取器设计 | — |
| RAPTOR（ICLR 2024）递归摘要树；Graphiti 双时间图摄入；HippoRAG 2 / LightRAG 增量图 | 书 / 专著用 RAPTOR 树；双时间与增量更新已在 §19.22 | 自建图库（知识层的存储是 MemOS） |
| 中医医案结构化抽取文献（四诊 / 辨证 / 治法 / 方药等实体与关系抽取，近年以 LLM 微调为主） | 医案与病例的抽取 schema | 训练专用模型（先用通用模型 + schema，精度不够再议） |

### 26.3 总体架构

```text
用户的原始库                                              EviMed 内部产物
  网盘（经 OpenList）· 本地文件夹（本地代理）· 平台上传        运行 · 交付物 · 主动科研回合 · 用户反馈 · 胶囊笔记
        │ 连接器契约（§26.4）                                        │ 内部生产者（账本事件触发）
        ▼                                                            ▼
  ┌──────────────── 统一分析层 `@evimed/analysis`（控制面异步作业，Postgres 队列 + worker）────────────────┐
  │ ① 入库 intake      清单与变更检测 · 取件 · 指纹 · 精确 / 近重复 / 版本家族                                │
  │ ② 分流 triage      类型 × 价值向量 × 作者关系 × 相关性 → 深度与抽取器计划（四级级联，§26.5）              │
  │ ③ 抽取 extract     按类型的抽取契约：必填槽位 · 逐块迭代 · map-reduce · RAPTOR 树 · 多模态对齐（§26.6）     │
  │ ④ 审计 audit       覆盖台账 · 槽位核对 · QA 遗漏审计 · 产出量异常 · 定向二次抽取（§26.7）                   │
  │ ⑤ 归并 consolidate 术语归一 · 研究档案 · 方法 / 立场归纳 · 规律挖掘 · 晋升 / 失效 / 链接（§26.8，接 §19.22）│
  │ ⑥ 物化 materialize 五层 + 时间轴 + MemOS cube + 索引 · 结果卡 · 整理台（§26.9）                            │
  └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

六条原则：**索引先行**（任何内容先可检索，再谈蒸馏）、**蒸馏按价值**（深度由价值向量决定，不一刀切）、**审计按分层**（深度越高审得越严）、**一切可追溯**（每条产出指向来源单元）、**用户可纠正且系统会学**（覆盖判定即反馈）、**一条线**（内外来源同一流水线）。

### 26.4 ① 入库：连接器、变更检测、指纹

**连接器契约**（借 Mirobody 的 provider 契约，统一为五个方法）：

```text
list(cursor) → { entries: [{ path, size, mtime, providerHash?, entryType: file|dir }], nextCursor? }
fetch(entry, { range? }) → stream
capabilities() → { providerHash: 'md5'|'sha1'|'quickxor'|null, changeFeed: bool, rangeRead: bool, speedTier: 'fast'|'throttled' }
isProcessed(digest, extractorVersion) → bool            // 幂等
saveRaw?(entry, stream)                                   // 可选：托管副本（数据文件默认开）
```

| 连接器 | 实现 | 备注 |
|---|---|---|
| 网盘 | **OpenList** 自托管实例（每部署一个；每用户一个或多个 storage，用用户自己的 OAuth 授权，令牌加密存控制面）；我们只调 `/api/fs/list`、`/api/fs/get`、`/api/fs/link`（或 WebDAV） | 百度网盘经开放平台 OAuth 应用（用户方有企业资质）；非会员下载限速 → 大文件走本地代理；OpenList 作为第四个跟版依赖（`deps-version.json.openlist` + 我们用到的三个端点的契约测试，进同一个夜间矩阵作业） |
| 本地文件夹 | **本地分析代理**：`evimed-web` 本地 profile 的 `evimed analyze --watch <dir>`，在用户机器上做哈希、解析（MinerU / ffmpeg / ASR 经网关）与抽取，只上传派生物（文本、分段、结构化结果、缩略图）；抽取器与服务端同一个 Python 包、同一版本号 | 解决视频等大媒体、限速网盘与「原件不出本机」三件事 |
| 平台上传 | §23.4 的分块续传 | 兜底 |
| 内部 | 账本事件 `finished` / 交付回执 / 回合合并 / 反馈 / 笔记 → 直接入队 | 无取件步骤 |

**变更检测**：按连接器周期列清单（默认 60 分钟，用户可设「监视文件夹」与节奏）；与上次清单比对 `path + size + mtime + providerHash`；新增 / 修改 → 取件；同哈希新路径 → 移动（不重抽）；消失 → 来源标 `missing`（派生物保留，时间轴一条）；百度 md5 / 阿里 sha1 / OneDrive quickXor 直接作为预指纹，避免为判断「没变」而下载。

**指纹与去重**（三层）：文件 sha256（精确重复，零成本）→ 文本 MinHash/LSH（Jaccard ≥ 0.8 为同一**版本家族**：`v1 / v2 / 最终版 / 最终版2`，取最新为正本，其余链接不重抽）→ 语义近重复（`cos ≥ 0.95`，跨格式：同一讲座的 PPT 与 PDF 导出）；PPT 做**幻灯片级**去重（同一页在多门课里复用，抽取一次、引用多次）。

**取件策略**：≤ 50 MB 直取；≤ 2 GB 流式；> 2 GB 或 `speedTier: throttled` 的媒体只走本地代理（整理台提示「这 12 个视频建议用本地代理处理」）；每用户每日带宽预算。

### 26.5 ② 分流：类型 × 价值向量 → 深度

**类型目录**（22 类；目录在 `@evimed/analysis` 定义一次，UI 与抽取器注册表从它派生）：已发表论文（本人 / 他人）、预印本 / 手稿草稿、综述 / 指南、书 / 教材 / 专著章节、会议摘要 / 海报、标书 / 课题申请、研究方案 / SOP / 检查表、审稿意见（本人写的 / 收到的）、医案、病例 / 病历、队列数据 / 数据字典、统计输出、讲课 PPT、录音（讲课 / 会议 / 访谈 / 查房）、视频（课程 / 讲座 / 手术）、课程包（多文件）、笔记 / 备忘、邮件 / 聊天导出、行政 / 财务表格、证书 / 扫描件、图片 / 图表、其他。

**价值向量**（每个来源一条，0–1）：

| 维度 | 含义 | 对应胶囊层 |
|---|---|---|
| `profileValue` | 关于用户本人：身份、立场、偏好、写作风格 | 画像层 |
| `methodValue` | 用户怎么做事：方案、SOP、方法节、课件里的「我怎么做」、本人写的审稿意见 | 方法层 |
| `knowledgeValue` | 与用户课题相关的领域知识与新颖度 | 知识层 |
| `evidenceValue` | 可引用的一手文献、指南、有溯源的数据 | 知识层（证据子集） |
| `dataValue` | 可分析的数据：队列、病例系列、医案集 | 资料层 + 数据保险库 |
| 附加 | `authorship ∈ {self, coauthor, other, unknown}`、`relevance`（与胶囊焦点向量的相似度）、`novelty`（与已有知识的去重后新增比例）、`quality`（OCR 乱码率、完整性）、`cost`（预估 token）、`risk`（垃圾 / 重复 / 损坏） | — |

**四级级联**（便宜的先做，贵的只对值得的做）：

1. **元数据规则**（零成本）：扩展名、大小、路径词（「已发表 / 课件 / 病例 / 数据 / 财务」）、文件元数据（作者、创建程序）、重复状态 → 垃圾与重复直接判定。
2. **结构探针**（零或极低成本）：前 N 页 / 目录 / 幻灯片标题 / 表格 schema / 录音前 2 分钟转写；乱码率；语言。
3. **Flash 分类**（≈ 2–4k token）：结构化输出 `{docType, authorship, topics(MeSH), valueVector, reasons[]}`；作者关系用姓名匹配 + 写作风格向量与画像比对。
4. **用户先验**（最强信号）：连接向导里的**文件夹角色**（系统先猜「这个文件夹像课件」，用户确认或改）、显式标签、以及**用户覆盖规则**（覆盖一次 = 对该文件夹 / 类型 / 作者关系的确定性规则；不训练模型，2026-08-23 拍板）。

**深度策略**（默认表，用户可按文件夹 / 类型覆盖）：

| 深度 | 做什么 | 默认适用 |
|---|---|---|
| `skip` | 只记指纹（仍可按文件名找到） | 重复、损坏、行政 / 财务、证书 |
| `index_only` | 解析 + 切片 + BM25 与向量索引 + 一段摘要 | 低相关的他人论文、邮件 / 聊天、图片 |
| `structured` | 按类型 schema 抽取（§26.6）+ 链接 | 相关的他人论文、指南、书（RAPTOR 树）、录音 / 视频（转写 + 分段 + 要点）、统计输出、数据画像 |
| `deep` | `structured` + 原子 claim + 方法与立场线索 + 跨文档链接 + **100% QA 审计** | 本人论文、方案 / SOP、本人审稿意见、本人课件、医案 / 病例、标书、课程包里本人讲的部分 |

优先级 = `Σ 价值 × 层权重 − cost`；**批量接入时先全部 `index_only`（几小时内可检索），再按优先级蒸馏（几天内完成，整理台显示 ETA）**。每个判定带 `reasons[]`（「本人为第一作者」「与当前课题『心衰药物经济学』相似度 0.82」「与 X.pdf 为同一版本家族」），整理台可见；用户覆盖即反馈。

### 26.6 ③ 抽取：按类型的抽取契约

抽取器注册表（`@evimed/analysis`，与能力清单同一种思路：一份契约 + 一个校验器）：`{ docType, unit, slots: { required, optional }, iterate: bool, outputs → layers, version }`。共同规则：**逐块迭代**（带「已抽取状态」问「本块新增了什么」，避免重复与遗漏）、结构化输出、`unknown` 必须带理由、每条产出带 `provenance{ source_id, unit_id, span }`。

| 类型 | 单元 | 必填槽位（节选） | 特殊处理 |
|---|---|---|---|
| 论文（本人 / 他人） | 节 → 块 | DOI（解析不到须说明）、设计、人群、干预 / 暴露、终点、效应量（`statistic{effect, ci, n}`）、局限、≥ 5 条原子 claim | 本人论文的方法节 → 方法候选；审稿回复（如有）→ 立场 |
| 书 / 教材 / 专著 | 章 → 节 → 块 | 目录 100% 建节点、每章摘要与概念表、引用的标准 / 指南 | RAPTOR 树（叶块 → 聚类摘要 → 章 → 书），检索跨层级；用户标记的章节升 `deep` |
| 方案 / SOP / 检查表 / 标书 | 步骤 | 目的、适用、输入、步骤、检查项、常见坑 | 直接成为 SKILL.md 草稿（§19.6 D3） |
| 审稿意见 | 条目 | 问题、依据、严厉度、对方回应 | 本人写的 → 立场与标准（画像层）；收到的 → 教训（经历层） |
| 医案 | 案 | 基本信息、主诉、四诊（舌 / 脉）、辨证、治法、方药（药 + 剂量）、复诊 / 随访、转归；**医家按语**单列 | 跨案规律在 §26.8 挖掘；按语 → 方法 / 立场 |
| 病例 / 病历 | 例 | 人口学、病史、查体、检验、诊断、治疗、病程、结局 | 病例系列 → 数据保险库可选建表 |
| 队列数据 / 数据字典 | 列 | codebook（变量标签、类型、单位、值集、缺失）覆盖 ≥ 90% 列、候选暴露 / 结局、时间结构 | DuckDB 画像；模型只看 schema、统计与 `head(5)` 样例（行数可配）；与同一研究的论文、方案、字典互相印证 |
| 统计输出（SPSS / R / Stata 日志） | 表 | 模型、变量、估计、p、n | 与论文结果表对账 → 研究档案 |
| 讲课 PPT | 页 | 每页标题 + 要点（≥ 1）、图表描述、讲者备注、教学 claim；**页覆盖 100%** | 本人课件 → 「我怎么讲 X」= 立场与方法 |
| 录音 | 分段 | 转写（说话人、标点）、主题分段、每段要点、问答段；**任意 10 分钟内至少一个主题标签** | ASR 网关；> 2 h 切片；本人讲的 vs 提问区分 |
| 视频 / 课程 | 分段 | 同录音 + 幻灯片切换分段（帧差 + OCR）+ 与库内同名 PPT 对齐（标题相似度）后联合抽取 | 本地代理优先；抽帧只在切换点 |
| 笔记 / 备忘 / 聊天导出 | 条 | — | **MemReader 式主动抽取**：`add / buffer / ignore`，先判价值、歧义、完整性 |
| 内部：运行转写 | 运行 | 经历摘要、能力使用、结局、教训、方法偏离（现有 `memoryIntelligence.recordRun`） | 不调模型的部分直接映射 |
| 内部：交付物 / 回合 delta | 交付物 | claim（带类型与来源）、证据台账条目 | 已结构化，**零模型成本**直接导入；tier 照搬（§24.4.4） |
| 内部：反馈 / 笔记 | 条 | 纠正、偏好、显式记忆 | `origin: explicit` |

### 26.7 ④ 审计：两种完整性的度量

**索引完整性**（由构造保证）：每个来源的每个单元（页 / 幻灯片 / 分段 / 列 / 块）都进入索引；`coverage_ledger` 记录每个单元的去向：

```text
coverage_ledger(source_id, unit_id, unitType: page|slide|segment|column|chunk|row_group,
                status: extracted|indexed_only|no_content|failed, item_ids[], audited_at?, audit_result?)
```

**蒸馏完整性**（按深度审计）：

| 机制 | 做法 | 触发的动作 |
|---|---|---|
| 槽位核对 | 必填槽位缺失 → 二次抽取（更大块、更强模型）→ 仍缺 → `needs_attention`（用户一句话即可补，如「这篇的主要终点是 30 天 MACE」） | 二次抽取 |
| QA 遗漏审计 | 从来源单元生成问题（Flash）→ 用 `evimed_capsule_recall` 作答 → 与来源答案比对（Q&A 变体对模型最稳健）→ 未覆盖 → 定向二次抽取该单元；采样率 `deep` 100%、`structured` 20%（按块随机）、`index_only` 0 | 二次抽取 |
| 产出量异常 | 按类型的期望产出区间（论文 ≥ 5 claim + 设计 + 终点；PPT 每页 ≥ 1 要点；录音每 10 分钟 ≥ 1 主题；数据 codebook ≥ 90% 列）→ 低于下限自动升一档深度重跑 | 重跑 |
| 版本升级 | 抽取器版本号变化 → 按价值排队**选择性重蒸馏**（预算内） | 重蒸馏 |

指标：抽取召回（按审计）、**遗漏率**（目标 `deep` ≤ 5%、`structured` ≤ 15%）、重复率、冲突率、`needs_attention` 率、每文档成本、时效（入库 → 可检索 < 2 h / 1,000 文件；→ 蒸馏完成按 ETA）。

### 26.8 ⑤ 归并：跨文档的理解（分析层最值钱的部分）

1. **术语归一**：疾病 / 药物 / 检验 / 干预经 `term_normalize`（MeSH / ATC / ICD / LOINC）——Mirobody「先标准化」那一课；同一概念在论文、PPT、医案里是同一个节点。
2. **研究档案（study dossier）**：同一研究的论文 + 数据 + 方案 + 统计输出 + PPT + 讲座 + 审稿意见自动聚合（题名 / 变量名 / 作者 / 时间 / 效应量相似）→ 胶囊按「项目」而非「文件」组织；这是用户最能感知到的「它理解了我的工作」。
3. **方法归纳**：本人论文方法节 + SOP + 课件「我怎么做」 → AWM / ACE 式归纳与增量（§19.22 A3）。
4. **立场与标准**：反复出现的论点、本人审稿意见的严厉点、讲课中的强调 → 画像层条目（带强度 = 出现次数 × 来源权重，带溯源）。
5. **规律挖掘（医案 / 病例）**：证型—治法—方药、人群—方案—转归的关联统计（确定性，支持度 / 置信度 / 提升度）+ 模型叙述 → 知识层「经验规律候选」（标 `derived`，不进实践建议）。
6. **时间放置与演化**：文档日期 → `valid_from`；版本家族 → 「你的 X 方案从 2021 到 2024 改了什么」；与 §19.22 A3/A4 的晋升、失效、链接衔接。

### 26.9 ⑥ 物化与界面：整理台

- 物化目标不变：五层 + 时间轴（§19.4）+ MemOS cube（知识 cube 收片段与 claim、方法 cube 收摘要、画像、经历）+ 索引（BM25 + 向量）。
- **整理台**（胶囊 → 资料页的默认视图）：来源面板（网盘 / 本地代理 / 上传：连接状态、上次同步、队列与 ETA、今日花费）；文件列表：类型、价值（五维小条）、深度、覆盖 %、产出计数、成本、`reasons[]`；筛选：已蒸馏 / 仅索引 / 跳过 / 需要你看一下；批量覆盖（改深度、改类型、「这个文件夹全是课件」）；「重新蒸馏」；研究档案视图（按项目聚合）。
- **连接向导**：授权网盘（OpenList OAuth）→ 选文件夹 → 系统猜文件夹角色 → 确认 → 设每日分析预算与节奏 → 开始；末尾一句「已开始建索引，几小时后可检索；蒸馏按价值进行，预计 N 天完成，随时可以在整理台调整」。
- **周报**：本周新增 / 蒸馏 / 跳过及原因、研究档案变化、建议（「『课件』文件夹有 40 个 PPT 未深度蒸馏，预计 ¥x」）。

### 26.10 调度、预算与版本

- Postgres 队列 + worker（与主动科研同一模式）；幂等键 `(sha256, extractorVersion)`；每用户每日分析预算（§25 的额度体系）；谷时优先；首次接入「批量模式」先索引后蒸馏。
- 跟版依赖新增两项：OpenList（`deps-version.json.openlist`、三个端点的契约测试）与 MinerU（`deps-version.json.mineru`、解析金样本）——进同一个夜间矩阵作业，不另建机制；抽取器自身有版本号，升级触发选择性重蒸馏。
- 本地代理与服务端共用 `@evimed/analysis` Python 包（同一版本、同一抽取器），派生物格式一致。

### 26.11 评估

试点 3–5 位用户的真实原始库作金标集（类型、有用性、关键事实标注）：类型判定准确率 ≥ 0.95；有用性判定与用户一致率 ≥ 0.85，用户覆盖率随周数下降；`deep` 抽取召回（QA 审计）≥ 0.95；近重复判定精确率 ≥ 0.98；研究档案聚合精确率 ≥ 0.9；1,000 文件入库 → 可检索 < 2 h；蒸馏 ETA 误差 < 30%；每文档成本按类型有上限并进周报。

### 26.12 分阶段（U 轨改写，随 C 轨）

| 阶段 | 交付 |
|---|---|
| U0 | OpenList 自托管 + 连接器契约 + 平台上传（分块续传）+ 入库（清单、变更检测、指纹三层去重）+ `index_only` 全量索引 |
| U1 | 分流级联（元数据 → 探针 → Flash → 文件夹角色）+ 抽取器注册表第一批（论文、PPT、方案 / SOP、笔记、数据画像）+ 覆盖台账 + 整理台 |
| U2 | 媒体（ASR 网关、视频分段与 PPT 对齐）+ 书（RAPTOR）+ 医案 / 病例 + 研究档案 + 本地分析代理 |
| U3 | QA 遗漏审计 + 产出量异常 + 覆盖规则 + 规律挖掘 + 周报 |
| U4 | 抽取器版本升级与选择性重蒸馏 + 评估集与试点复核 |

### 26.13 风险与对策

| 风险 | 对策 |
|---|---|
| 网盘驱动变动（百度 / 阿里接口调整）、OpenList 版本破坏 | 契约测试只覆盖我们用的三个端点；本地代理与平台上传两条退路；`missing` 不丢派生物 |
| 大库成本失控 | 索引先行、深度策略、每日预算、谷时；周报给出「花多少能蒸完」 |
| 过度抽取产生噪声 | 价值阈值、主动抽取的 `ignore / buffer`、审计、用户覆盖即反馈 |
| 类型误判 | 文件夹角色是最强先验；`reasons[]` 可见；覆盖后重分流 |
| 媒体处理慢 | 本地代理；切换点抽帧；分段并行 |
| 抽取器升级导致条目漂移 | 版本号 + 选择性重蒸馏 + 旧条目 `valid_to` 而非删除 |

---

## 27. 蒸馏模型与用户模型：「更了解我」是怎么来的

> 用户的问题：蒸馏模型怎么设计？怎么蒸？模型怎么就更了解我了？本节先把「了解」定义成可测的东西，再分清三种「蒸馏」，然后给出蒸馏流水线、信号回路、装配方式与评估。结论：**理解存在上下文里，不在参数里**；它来自四个信号回路（显式、编辑、决策、反思）；它是否变深，用四个预测任务每周度量。

### 27.1 先把「更了解我」定义成可测量的东西

「了解我」= **能预测我**。给定一个情境，能说出我会怎么做、怎么说、怎么选。定义四个预测任务，每周在留出事件上打分，结果就是胶囊总览里的「理解度」：

| 任务 | 给定 | 预测 | 真值来源 |
|---|---|---|---|
| 编辑预测 | AI 草稿 | 我会改哪些地方、往哪个方向改 | 我实际的修改 diff |
| 决策预测 | 简报卡 / 交付物 | 采纳 / 驳回 / 追问 | 我的实际决定 |
| 措辞预测 | 同主题的一段话 | 我会用的表述、会避免的词 | 我的定稿 |
| 方法预测 | 新题面 | 我会先做什么、用什么流程 | 我的计划修改 / 插话 |

理解度不是虚荣指标：它驱动**提问队列**——模型不确定且影响大的地方，才去问用户（§27.4）。

### 27.2 三种「蒸馏」，分开说

| 含义 | 做不做 | 说明 |
|---|---|---|
| A. 用模型从资料与行为里蒸出**结构化理解**（文档、编辑、决定 → 事实 / 标准 / 方法 / 立场） | **做，主线** | §26 的抽取器 + 本节的归纳与校准 |
| B. 把大模型的标注**蒸馏成小模型**（降本） | **暂不做**（2026-08-23：先不训练任何模型） | 记录为后期选项（§27.7）；触发条件是分流 / 槽位抽取的成本成为主要开销 |
| C. 把用户**蒸进模型参数**（每用户 LoRA / 参数记忆） | **暂不做** | DeepSeek 无托管微调接口（待核 V37）；LaMP 七数据集上 RAG 式个性化 **+14.92%**、PEFT **+1.07%**、合并 +15.98%，且 PEFT 只在用户数据多时才更优（Salemi & Zamani, ICTIR 2025）。参数记忆作为 MemOS `parametric_memory.adapter` 的形态保留接口，等自托管开源权重路径再评估 |

所以「模型更了解我」在本方案里的确切含义是：**每次派发时注入的上下文更准、更省、更像我**——画像区块、按情境召回的偏好、作为技能的方法、我自己的范例。这与「胶囊是上下文不是权限」「开放格式」两条原则是同一件事。


> **生态对照（2026-08-25）**：`zhangyoufu-123/stylotrace` 就是本节表格第 2 行（PRELUDE / CIPHER 从编辑对学偏好）的在野实现。可对照的是它的**表示**：把偏好存成可读的一句话描述而不是向量，用户能看见、能改、能删。这与 §27.3 「理解要可展示、可纠正」同向，也是我们不训练模型时唯一能让用户信任"它更懂我了"的形式。


### 27.3 蒸馏流水线：模型分工、五层 schema、四问、核验

**模型分工**：V4 Flash 做批量（分流、槽位抽取、重要度评分、QA 审计出题）；V4 Pro 做难综合（方法归纳、立场归纳、反思、研究档案聚合、冲突裁决、编辑偏好推断）；视觉模型做图表。**当前不训练任何模型**（§27.7 只记录后期选项）。

**写入前的四问**（MemReader 的三问 + 我们的溯源问）：(1) 这条关于谁——世界、用户本人、还是用户怎么做事（决定进知识 / 画像 / 方法哪一层）；(2) 依据在哪——必须指到来源 span 或行为事件，指不到就不写；(3) 新、强化、还是矛盾——先读旧记录再写（`ADD / UPDATE / MERGE / INVALIDATE`，矛盾不覆盖、旧条目 `valid_to` 失效）；(4) 完整了吗——不完整就 `buffer` 等下一次。

**五层的蒸馏 schema 与来源**：

| 层 | 条目形态 | 主要来源（权重） | 归纳方式 |
|---|---|---|---|
| 画像·身份与课题 | `{factKind, statement, strength, confidence, evidence[], valid_from}` | 显式笔记 1.0 · 本人文献 0.8 · 标书 / 简历 0.8 · 运行题面 0.4 | 抽取 + 强化计数 |
| 画像·立场 | 同上 + `polarity`、`scope`（对什么问题） | 本人论文的论点 0.8 · 本人写的审稿意见 0.9 · 讲课强调 0.7 · 插话纠正 0.9 | 反复出现 ≥ 3 次或显式一次即成条目；与证据规则冲突时只记录不生效（§27.6） |
| 标准与偏好（证据门槛、报告规范、写作禁忌、工具习惯） | `{factKind: method_preference / writing_style / tooling, rule, examples[], strength}` | **编辑 diff** 0.7（§27.4 回路 2）· 审稿意见 0.9 · 驳回理由 0.6 | CIPHER 式：每次编辑推断「什么偏好解释了这次修改」，按情境存，生成时按情境聚合 |
| 方法 | SKILL.md（§19.6 D3） | 方案 / SOP 0.9 · 本人论文方法节 0.8 · 成功运行轨迹 0.6 · 课件「我怎么做」0.7 | AWM 式归纳（≥ 3 条轨迹共享例程）+ ACE 式增量 delta；范例取自本人交付物 |
| 经历与教训 | `{run, summary, outcome, lessons[]}` | 运行与回合 1.0 · 驳回 0.8 | 现有 `recordRun` + 规则化（去项目细节） |

`strength = Σ 来源权重 × 时效衰减`，`confidence` 单独给（抽取自信度），两者都显示在条目上（「为什么我们这么认为」）。

**代码核验**（每条写入前）：溯源可解析；frontmatter 合规；与现有条目的矛盾已标记；分享层不含 `patient-level` 内容；强度只能由事件单调改变；立场类条目不得改写契约检查项。

#### 27.3.1 画像与立场的蒸馏法：借 Nuwa（女娲 · Skill 造人术）的「认知操作系统」配方

`alchaincyf/nuwa-skill` 把「一个人怎么思考」蒸馏成可运行的 SKILL.md，已有 14 份人物 skill 与一套保真度计分卡（盲测双 agent 评分，A 级 ≥ 85）。它蒸馏的是公众人物，输入是公开资料；我们蒸馏的是用户本人，输入更好（本人文档、编辑、决定、插话）。配方直接借用，只改输入与阈值：

| Nuwa 的做法 | 我们的落法 |
|---|---|
| **五层提取**：怎么说（表达 DNA）→ 怎么想（心智模型）→ 怎么判断（决策启发式）→ 拒绝什么（反模式与价值观）→ 哪里诚实（认知边界） | 画像层的条目种类按这五层组织；§27.3 的「立场」「标准与偏好」分别对应心智模型与决策启发式 |
| **三重验证**才算心智模型：跨域复现（≥ 2 个不同话题出现）、生成力（能推断对新问题的立场）、排他性（不是所有聪明人都这样想）；三重通过 → 心智模型，1–2 重 → 降级为启发式，0 重 → 丢弃 | 替换 §19.22 A3 里「≥ 3 次出现即晋升」的粗规则：画像层的立场条目要过三重验证；显式笔记可直接通过（用户说的算数） |
| **矛盾不调和**：「发现矛盾直接记录，不要调和。矛盾本身是有价值的信号」，收进「内在张力」节 | 与双时间不覆盖一致；画像增加「内在张力」条目种类（`factKind: tension`），简报与回复可引用（「你在 A 场合偏保守、B 场合偏激进，本次按 A」） |
| **诚实边界**必填：不能预测全新问题的反应、不能替代直觉、公开表达与真实想法有差距、信息截止日期 | 本人 Skill 必含「诚实边界」节：证据不足的维度、截止日期、未覆盖的场景；模型据此在越界时表达不确定，而不是强行外推 |
| **回答工作流**（Agentic Protocol）从心智模型反推研究维度 | 本人 Skill 的「工作流」节由方法层与标准层反推：面对新题面先问哪几个问题、按什么顺序 |
| **质量闸口**是计分卡不是阻断：心智模型 3–7 个且有证据链；局限写出失效条件；表达 DNA 100 字可辨识；诚实边界 ≥ 3 条；内在张力 ≥ 2 对；一手来源 > 50%；两轮不过则在诚实边界披露薄弱维度、交付当前最优版 | 同样的计分卡，同样「不过就披露，不阻断」；与 §27.1 的四个预测任务一起构成理解度 |
| **增量更新**：只跑新增来源，强化 → 补案例、矛盾 → 更新模型、新模式 → 考虑新增；不重写整体 | 即 ACE 式 delta（§19.17 L2、§19.22 A3）；重写只在用户要求「重新蒸馏」时 |
| **档位与成本先确认**：快速 / 标准 / 深度 | 冷启动向导给两档（快速 ≈ 读 10 份代表作；深度 ≈ 全库），显示预估额度 |
| 信息源优先级：用户提供素材 > 权威来源；黑名单低质转述 | 来源权重表（§27.3）已体现；外部转述类来源权重 0.3 |

**产物形态**：胶囊方法目录里多一份 **`persona/SKILL.md`（本人 Skill）**——完整版、按 Nuwa 模板分节，经 `skill` 工具按需加载；§19.7 的 `profile.md`（≤ 1,500 token 常驻区块）是它的摘要，两者由同一份条目生成，**两级渐进披露**。工作方式包的核心就是「本人 Skill + 方法 SKILL.md」。

**每一份生成的 SKILL.md 都按 Agent Skills 作者规范校验**（代码核验，写入前）：正文 < 500 行；`description` ≤ 1,024 字、第三人称、同时写「做什么」与「何时用」；引用文件只深一层、描述性文件名、> 100 行的引用带目录；自由度与任务脆弱性匹配（流程性方法给步骤与检查表，判断性方法给原则与范例）；不含时效性信息（写「旧做法」节而非日期）；术语一致；**≥ 3 个测试场景**（从用户自己的运行里取）并在生成前测基线——评估先于文档。

### 27.4 四个信号回路：理解从哪里来

| 回路 | 信号 | 机制 | 权重 |
|---|---|---|---|
| 1 显式 | 上传、笔记、「记到胶囊」、**冷启动访谈** | 访谈不是问卷：模型先读完已蒸馏的内容，再就「不确定且影响大」的 8–12 项提问（「你审稿时最在意的三件事？」「观察性研究能不能作主要证据？」）；答案 `origin: explicit` | 1.0 |
| 2 编辑 | 交付物与回复的每次修改 diff | PRELUDE / CIPHER（NeurIPS 2024）：对每次编辑推断潜在偏好描述（「用户把『显著』改成具体效应量」→ 「报告效应量而非显著性措辞」），连同情境存入标准层；生成时检索 k 个最近情境的偏好聚合注入；度量：同类任务的编辑距离随时间下降 | 0.7 |
| 3 决策与行为 | 采纳 / 驳回 / 追问 / 投票 / curate / **插话** | 插话是最高质量的纠正（在情境里、即时）；打开 / 忽略是弱信号 | 0.5–0.9 |
| 4 反思 | 睡眠期巩固（§19.22 A3） | 聚类、晋升、方法归纳、洞见；**理解度测试**的失分项进入提问队列 | — |

提问纪律：每天最多一个「小问题」（随简报），不阻塞；同一问题被忽略两次即放弃；问题必须附「我们为什么想知道」。

### 27.5 运行时装配：理解怎么用进去

- **画像区块 ≤ 1,500 token**，固定分节与顺序（身份 / 课题 / 立场 / 标准 / 风格），便于 KV 缓存前缀稳定；只放 `strength` 高于阈值的条目。
- **按情境召回的偏好**：题面与交付物类型 → 检索 k（默认 5）个最近情境的偏好描述，聚合为一段「本次请遵守」注入（CIPHER 的检索聚合）。
- **方法作为技能**：相关方法经 `ctx.skills.register` 可见，委派时预注入子代理。
- **范例**：本人交付物片段 ≤ 2 条作为 few-shot（写作类能力）。
- **子代理只拿它需要的**：方法 + 与其交付物相关的标准，不拿整份画像。
- **冲突披露**：用户本次明示 > 胶囊标准 > 平台默认；立场与证据冲突时在回复里点明（§27.6）。

### 27.6 评估与校准：别把「像我」做成「只说我爱听的」

- 每周：四个预测任务的一致率、编辑距离趋势、覆盖 / 回滚率、校准（置信度 vs 准确率，过自信则提高写入阈值）。
- 每月：「像不像我」五题自评。
- **过度个性化守卫**：立场类条目永远不能改变证据规则与契约；当用户的立场与检索到的证据相左，回复必须写明「你一贯认为 X，但本次证据提示 Y」——胶囊让 Agent 像你一样工作，不让它替你忽视证据。
- 评测集：每用户的留出事件 + §19.12 六项 + §26.11。

### 27.7 平台级蒸馏（B）：后期选项，当前不做

当前不训练任何模型。若将来分流与槽位抽取的成本成为主要开销，配方是：跨用户（opt-in、匿名化）收集 Flash 的分流与槽位标注 + 用户覆盖 → 在我们的 GPU 上训练 0.6B–4B 级抽取 / 分流模型（MemReader 配方：SFT 热身 → GRPO，奖励 = 格式 + LLM 裁判的正确 / 完整 / 无幻觉 + 简洁）→ 以评测集为门替换 Flash 的对应步骤，失败回退 Flash。目标：分流与简单槽位成本下降一个量级；不碰用户级参数。

---

## 28. 胶囊的容器格式、密钥与加解密

> 用户的问题：胶囊要不要定存储格式和加解密方式，还是就是个 JSON 谁都能看？结论：**三种形态，各有规矩**——工作态在我们的边界内是结构化数据（可检索，所以不能是密文）；持久与备份态按胶囊加密；便携态是一个有规范的容器 `.evimedcap`：**明文格式开放（Markdown / JSONL），容器加密并签名**。「谁都能看」不成立；「谁都能读懂」（开放格式）保留。

### 28.1 三种形态

| 形态 | 在哪 | 形式 | 保护 |
|---|---|---|---|
| 工作态 | 控制面 Postgres（产品账本）、MemOS cube（检索）、对象存储（派生物） | 结构化明文——向量与全文索引不能在密文上工作 | 租户隔离（现有个人账户模型）、库与磁盘加密、对象存储按胶囊 DEK 加密、访问审计；运营方在技术上可读，方案如实声明，不假装「零知识」 |
| 持久与备份态 | 备份作业、导出快照 | 每个 blob 用胶囊 DEK（AES-256-GCM）加密；DEK 由主密钥 KEK 封装 | 备份与对象存储泄露无用；KEK 在密钥库（沿用 `.evimed-local/secrets/` 的签名密钥模式，生产可接 KMS） |
| 便携态 | 导出、分享、本地 profile、其他 Agent Skills 工具 | `.evimedcap` 容器（§28.2） | 签名（作者不可抵赖、防篡改）+ 加密（只有接收者能开）；可选明文导出（自己用） |

### 28.2 `.evimedcap` 容器规范 v1

```text
capsule-<capsuleId>-v<version>.evimedcap          zip（仅存储或 deflate）
├─ manifest.json        明文、JCS 规范化（RFC 8785）后签名
│    formatVersion "1.0" · capsuleId · version · createdAt · issuer{userId, signingKeyId}
│    scope（workstyle / +profile / +knowledge / +documents）· layers[] · license · attribution
│    entries[{path, sha256(明文), bytes, mime, layer}] · merkleRoot · prevManifestSha256（版本链）
│    encryption{scheme: "x25519-hkdf-sha256+aes-256-gcm", recipients[{encKeyId, ephemeralPub, wrappedPackKey}]}
│    signature{alg: "ed25519", keyId, value}（签在 manifest 其余字段的规范化字节上）
├─ payload/             每个 entry 一个密文文件（AES-256-GCM；AAD = path ‖ merkleRoot；随机 96 位 nonce）
│    profile.md · standards.jsonl · methods/<slug>/SKILL.md · knowledge/claims.jsonl · knowledge/chunks.jsonl?
│    exemplars/*.md · lessons.jsonl · timeline.jsonl · provenance.json · memos/textual_memory.json（MemCube 导出）
├─ keys/                口令封装副本（可选）：scrypt（Node 内建）或 Argon2id → KEK → wrappedPackKey
└─ README.txt           明文：这是什么、怎么打开、格式版本
```

- **明文格式开放**：payload 解密后就是 Markdown 与 JSONL，`methods/` 是合法的技能根（§19.9 不变）。
- **内容寻址 + Merkle 根 + 版本链**：任何一字节改动都能发现；`prevManifestSha256` 让历史可追溯、可证明「v7 确实从 v6 来」。
- **两种导出**：加密包（默认；分享一律如此）与明文包（自己导出到本地 `evimed-web` 或其他工具；仍带签名）。
- **MemOS 关系**：`memos/textual_memory.json` 是一个 entry；`activation_memory.pickle` 与 `parametric_memory.adapter` 永不进包（加载可执行代码，§19.16）；导入时先验签 → 解密 → schema 校验 → 作为只读客体 cube 加载。

### 28.3 密钥体系

| 密钥 | 算法 | 生成与存放 | 用途 |
|---|---|---|---|
| 用户签名密钥对 | Ed25519 | 注册时服务端生成；私钥在密钥库中由 KEK 加密；本地 profile 自生一对；`keyId` = 公钥指纹 | 签 manifest（作者与完整性） |
| 用户加密密钥对 | X25519 | 同上 | 接收分享包（HPKE 风格封装） |
| 胶囊 DEK | 256 位随机 | 每胶囊一把，KEK 封装 | 工作态 blob 与备份加密 |
| 包密钥 PK | 256 位随机 | 每个 `.evimedcap` 一把 | payload 加密；对每个接收者用 临时 X25519 → HKDF-SHA256 → AES-256-GCM 封装 |
| 主密钥 KEK | 256 位 | 密钥库 / KMS | 封装上面各把 |
| 口令派生密钥 | scrypt（Node 内建）或 Argon2id | 用户导出时输入 | 离线打开包 |

全部算法在 Node 核心 `crypto` 里可用（`generateKeyPair('x25519' / 'ed25519')`、`diffieHellman`、`hkdfSync`、`createCipheriv('aes-256-gcm')`、`sign / verify`、`scryptSync`）——**零新依赖**；Argon2id 如采用为一个依赖。轮换：新密钥对生成后旧私钥保留用于解密历史包，DEK 重新封装；每次密钥使用写审计（谁、何时、哪个胶囊 / 包）。

### 28.4 威胁模型：加密解决什么、不解决什么

| 场景 | 结论 |
|---|---|
| 备份 / 对象存储泄露 | **解决**：无 KEK 即无用 |
| 分享包在传输 / 第三方存储中被截获 | **解决**：只有列出的接收者能解 |
| 冒充他人分享（「这是张医生的方法」） | **解决**：Ed25519 签名 + 平台密钥目录 |
| 篡改包内容 | **解决**：Merkle 根 + AAD 绑定路径 |
| 接收者解密后转发明文 | **不解决**（密码学无法阻止）：`reshare` 标志 + 包内溯源水印（每条目带 `issuer` 与 `recipient` 指纹）只能事后追溯 |
| 运营方读取工作态 | **不解决**：客户端侧加密会让蒸馏与检索无法进行；以隔离、审计与最小权限管理 |
| 撤回已分享的包 | **不解决历史**：已交付的是快照；撤回只影响未来版本（§19.9 已声明） |

### 28.5 格式治理

- 胶囊 schema（manifest 与每种 JSONL 记录）只在 `@evimed/domain` 定义一次（JSON Schema），`formatVersion` 语义化；读者接受 N−1 版本；迁移器随版本发布。
- 契约测试：金包往返（打包 → 验签 → 解密 → 校验 → 加载）、篡改测试（改一字节必失败）、错钥测试、口令包测试、MemCube 导入测试；进 `ci:web`。
- 可选：`sensitive` 事实字段级加密（单独 DEK，只在注入时解密）——试点后按需开启。

---

## 29. 收口审查（v3.5，2026-08-23）：去过度设计、减门禁、核对算法与规范

> 用户要求：全部联网再核一遍算法是否在正确的道路上；不训练模型；不要过度设计和过多门禁；核查各模块算法架构、代码规范与架构设计原则是否满足。本节是这次审查的结果：**算法方向全部确认，两处修正；删掉 9 项过度设计；全系统阻断点收敛到 6 个；命名与单点规则的 14 处违反已改。**

### 29.1 算法复核（联网，2026-08-23）

| 模块 | 我们的选择 | 核实结果 | 结论 |
|---|---|---|---|
| 记忆协同（§19.22） | 互补学习系统框架：L1 快记、胶囊慢抽、睡眠期巩固；Generative Agents 式重排；Ebbinghaus 衰减 + 再巩固；A-MEM 链接 | 与 Letta（核心 / 召回 / 归档三层 + sleep-time）、Zep / Graphiti（双时间）、2026 年各对比评测的共识一致 | **确认** |
| 记忆底座（§19.21） | MemOS 自托管 + 窄端口 + 退路 | MemOS **不出现在** 2026 年任何西方对比评测（Mem0 / Zep / Letta / LangMem / Cognee）；其 MemReader 论文与 HaluMem 指标可核 | 用户已定 MemOS；**窄端口 + M3 退路必须保留**（R9），C0 实测为准 |
| 分析层（§26） | 索引先行、分流级联、逐块迭代抽取、QA 遗漏审计 | 长文档主要失败是遗漏；逐块迭代提高召回；QA 式度量最稳健；MemReader 的主动抽取四动作 | **确认** |
| 蒸馏与用户模型（§27） | 理解存在上下文；编辑推断偏好；四个预测任务 | LaMP：RAG 式个性化 +14.9% vs PEFT +1.1%；PRELUDE / CIPHER（NeurIPS 2024）；Nuwa 的三重验证与诚实边界配方 | **确认**；补 §27.3.1 |
| 主动科研（§24） | 系统发起的预注册回合；验证优先；问题来自议程 | Kosmos 综合陈述 57.9%；Sakana 42% 实验失败；**Agents4Science：AI 论文「技术正确但既不有趣也不重要」，有价值的问题来自人** | **修正 1**：v1 去掉假说锦标赛，假说只作建议卡；问题只从用户议程出发 |
| 分配算法（§24.4.2） | 评分 + Thompson 采样 + 背包 | 对 v1 的线程数与回合数，Thompson 的收益无法观测；确定性规则已足够防锁死 | **修正 2**：v1 用优先级 + 贪心 + 收益递减；Thompson 后期可选 |
| 去重（§26.4） | sha256 + MinHash（Jaccard 0.8）+ 语义（cos 0.95） | MinHash/LSH 仍是生产标准；语义去重作为补充 | **确认**（阈值 V33 实测） |
| 容器与密钥（§28） | X25519 + HKDF + AES-256-GCM、Ed25519、JCS、Merkle | 标准原语；Node 核心 `crypto` 全部具备（V39 核版本） | **确认** |
| 技能格式（§19、§26、§27） | 方法与本人 Skill = SKILL.md | Agent Skills 作者规范：< 500 行、description 做什么 + 何时用、引用一层、评估先于文档 | **确认**；校验规则写入 §27.3.1 |

### 29.2 删掉的过度设计（9 项）

| # | 原设计 | 处理 | 理由 |
|---|---|---|---|
| 1 | 方法修订「降低严谨度 / 触及安全步骤」需生效前轻量确认（§19.3、§19.6 S5） | **删除**：一切立即生效、可回滚 | 安全在契约层；确认是门禁 |
| 2 | 自主等级 L0 / L1 / L2（§24.3） | **删除**：按任务类型开关 + 日上限；唯一人工步骤是签核 | 三级模型增加解释成本，与开关等价 |
| 3 | 假说竞技场（成对辩论 + Elo）（§24.4.6） | **降为后期可选**：v1 只出建议卡 | Agents4Science 的证据：问题与判断来自人 |
| 4 | Thompson 采样 + 0/1 背包分配（§24.4.2） | **降为后期可选**：优先级 + 贪心 + 收益递减 | 收益不可观测；规则足够 |
| 5 | 分析计划冻结需用户审阅（§24.4.5） | **删除审阅**：自动冻结，冻结是记录 | 门禁 |
| 6 | 交互运行超预估的「继续？」确认（§25.2） | **删除**：只提示，余额为零才硬停 | 门禁 |
| 7 | 每用户有用分类器（逻辑回归重训，§26.5）与平台级小模型（§27.7） | **不做**：用户覆盖落为确定性规则；小模型只记录为后期选项 | 用户决定当前不训练任何模型 |
| 8 | 每周人工抽样复核（§26.7） | **删除** | 是流程不是产品 |
| 9 | 四个跟版依赖各一套「四件套」（DSH / MemOS / OpenList / MinerU） | **合并为一套**：`deps-version.json` + `packages/contracts/<dep>/` + 一个夜间矩阵作业 | 四份复制是机制冗余 |

另外列为「以后再说」、不在当前任何阶段：团队线程（A4）、跨用户聚合（§19.17 L3）、DSH 客户端插件（§18.6）、字段级加密（§28.5）、在线数据库连接（§23.4）、参数记忆（§27.2 C）。

### 29.3 全系统的阻断点（收敛后只有 6 个）

| # | 阻断点 | 性质 | 为什么必须保留 |
|---|---|---|---|
| 1 | `evimed_submit_deliverable` 的契约校验（返回值） | 机械 | 交付物不合契约就是没交付 |
| 2 | 服务端外部门禁 `reconcileSession` | 机械、独立进程 | 「被检查方不能提供考题」 |
| 3 | `evimed_complete_run` 的计划履约与内容触发器 | 机械 | 同上 |
| 4 | 预算守卫（步数 / token / 子代理 / 时钟；日 / 周上限；余额为零） | 机械 | 钱 |
| 5 | 路径守卫（题面、回执、状态投影、`data/` 越界） | 机械 | 防篡改与越权读取 |
| 6 | 产物离开平台前的用户签核 | 人工、一次 | 唯一需要人的地方 |

其余一切（期望检查、四指标、语义审查、记忆与方法的审阅、数据分级、分析计划冻结、理解度、保真度计分卡、质量闸口）都是**非阻断**：出 notice、打标记、可回滚。

### 29.4 规范与原则符合性

**设计原则（简单、明确、清楚、完整）**：每个新模块都能用一句话说清（§26.1、§27.2、§28.1 的表）；每个机制只定义一次（下表）；阻断点可数；路线图有退出标准。

**Ousterhout 检查**：

| 检查 | 结论 |
|---|---|
| 深模块 | 连接器契约五个方法承载 40+ 网盘；分析层对外只有「入队一个来源」与「整理台状态」；胶囊容器对外只有打包 / 验签解包 |
| 信息隐藏 | 类型目录、价值向量、tier 词汇、通知种类、容器 schema 只在 `@evimed/domain` 定义；Python 分析包从 domain 导出的 JSON 生成常量，测试断言相等（一处定义两处派生） |
| 定义错误于无形 | 分流 `skip`、来源 `missing`、抽取 `needs_attention`、回合 `partial` 都是状态不是异常 |
| 传递方法 | 连接器不是网盘 API 的改名表：它把 40 种 API 统一成五个方法与一种 entry 形状 |
| 配置参数的回避决策 | **算法参数是常量，部署参数才是配置**：权重 (4,2,2,1,1)、γ = 0.995/h、τ = 30 d、Jaccard 0.8、cos 0.95、反思阈值 150、遗漏目标 5% 在 `@evimed/domain` 以常量导出并有测试；只有预算、周期、上限、采样率进 `config.mjs`（§14 规则 11 三问） |
| 设计两次 | 记忆底座（M1–M3）、主动科研（三面）、分析层（原始库三种放法）、容器（客户端加密 vs 服务端）都写了备选与取舍 |

**§14 规则在新章节的落实（含本轮修正）**：

| 规则 | 新章节的落实 |
|---|---|
| 3 依赖方向 | `packages/analysis`（Python）只依赖 domain 导出的 JSON；控制面 worker 与本地代理同一个包 |
| 4 一处知识一处代码 | 类型目录 / 价值向量 / tier / `noticeType` / 容器 schema / 状态词汇在 domain；前端、Python、SKILL 改写脚本派生 |
| 9 agent 面五个插件固定 | 主动科研、分析层、容器**没有新增插件**：议程经 `.evimed-brief/` 注入，delta 是契约，审计在控制面 |
| 11 配置三问 | 见上「常量 vs 配置」 |
| 14 裁定是值 | 分流、审计、冻结、签核状态全是值 |
| 16 无布尔参数 | `autopilot.allowed: bool` → `taskTypes[]` 非空语义；`partial` 仍是唯一允许的布尔 |
| 17 跨边界机器码 | 分析层新增错误码族 `source_unreadable / parser_failed / extractor_slot_missing / connector_rate_limited`；连接器失败在整理台可见 |
| 18 失败可见 | 每个来源的处理记录（跑了什么、花了多少、覆盖多少）是整理台的一行 |
| 21 一名一义 | **本轮改名 14 处**：`capsule_sources.kind → sourceType`、`capsule_facts.kind → factKind`、`capsule_timeline.kind → eventType`、`agenda_items.kind → itemType`、`notifications.kind → noticeType`、`coverage_ledger.unit_kind → unitType`、连接器 `entry.kind → entryType`、上传 `kind → uploadType`、`usage_events.kind → resourceType`、`deliverable/update.kind → contractKind`、画像条目 `kind → factKind`、召回参数 `kinds → factKinds`；散文里的「契约 kind」改为「契约种类」 |
| 33 发布后不改名 | 容器 `formatVersion` 语义化、读者接受 N−1；抽取器版本号 |
| 35 版本 pin 单点 | 改为一个文件四个键（§12.1） |
| 37 三类用例 | 容器金包 / 篡改 / 错钥；抽取器每类型「通过 + 每个必填槽位缺失一例」；分流每类型一例 |

### 29.5 本轮之后仍然成立的原则

简单、明确、清楚、完整；只写核实事实；模型判、代码核、人在回路但不挡路；契约绑产出；胶囊是上下文不是权限；插座只碰文档化的缝；**少门禁**——阻断只来自机械可核的契约、预算与路径守卫，以及一次人工签核；**不训练模型**——理解存在上下文里。

---

## 30. P0 真机验收：二十二个缺陷与它们的共同形状（2026-08-24 起）

> 本节记录换内核后**第一次真正构建镜像并起容器**的结果。价值不在修了什么，而在于：这八个缺陷全部发生在 988 项服务端测试、657 项前端测试、73 项合规检查、全套契约测试**都绿**之后，且每一个都只有真机能暴露。裁决 #16 把"真机验收先于翻默认"排在第一位，本节是它的兑现。

### 30.1 八个缺陷

| # | 缺陷 | 为什么测试测不到 | 修法 | 现在由什么兜住 |
|---|---|---|---|---|
| 1 | 镜像未装 pnpm，`dsh plugin add` 退 127 | 没有任何单元测试会去构建一个镜像 | 装 pnpm | 合规审计要求 `PNPM_VERSION` pin |
| 2 | 装成工作区的 pnpm 9.4.0；DSH 的 profile 目录声明自己为 workspace 包，pnpm 9 拒绝无 `-w` 的 `add` | 版本"与工作区一致"听起来正确 | 改用 DSH 自己钉的 11.7.0，写进 `deps-version.json.dsh.pnpm` | 契约测试断言 Dockerfile / compose / 单点三处相等 |
| 3 | bundle 未钉版本 → `latest` 解析到 `0.0.1-rc.1` 并 404 | 本地无人安装 bundle | `@pkg@${DSH_VERSION}` | 审计：任一 bundle 缺版本即失败（已验齿） |
| 4 | pnpm ≥10 拦截安装脚本，`node-pty`/`koffi` 未构建 | 依赖树只在镜像里存在 | profile 随附 DSH 自己的 `allowBuilds` 策略文件 | 构建期断言存在可加载的原生绑定 |
| 5 | `dsh plugin add <裸路径>` 写**相对链接**指向 profile 之外；`cp -a` 到卷后链接失效，**bundle 静默消失而组合照样成功** | 原地测试永远成立 | 改用 `file:`（复制进 profile 自己的 store） | 构建期断言：把种子复制到另一路径再组合一次 |
| 6 | 种子 `chmod -R a-w`，`cp -a` 把只读位带上卷，而组合要写 `cordis.yml` | root 只要还有 `CAP_DAC_OVERRIDE` 就无视只读位——**宽松容器退 0/16074 字节，`--cap-drop ALL` 退 1/634 字节** | 启动脚本播种后 `chmod -R u+w` | 验收在生产同款容器参数下执行 |
| 7 | corepack shim 每次调用都联网解析版本；运行时容器无外网 → `EAI_AGAIN` | 构建期有网 | 改为真实全局安装 | 构建期把 registry 指向死地址跑一次 pnpm |
| 8 | **profile patch 够不着 preset 的行**；DSH 只在 stderr 告警。七行落空，其中 `mcp-evimed` 从未被插入 → **研究工具一个都没挂**，六个插件用默认值跑 | patch 生成器的注释写了一个错误假设，测试照着它断言"patch 里有这些行" | `mcp-evimed` 改 `insert`；preset 行改 `!!js process.env.*`，控制面注入容器环境 | 两个契约测试：patch 只能命名宿主组合的行；preset 读的每个变量都必须有人提供，反之亦然 |

### 30.1b 第二轮（2026-08-25）：容器终于能说话之后的六个

第一轮修完，容器仍然起不来，而控制面能说的只有一句「Runtime exited before it became ready」。所以这一轮的第一项修的不是缺陷，是**看不见缺陷**这件事本身。

| # | 缺陷 | 为什么测试测不到 | 修法 |
|---|---|---|---|
| 12 | `runtime_exited` 丢弃退出码、容器输出、最后一次探测错误。容器又是 `--rm` + `stdio:"ignore"`——死后没有 `docker logs`，活着时也没人在听 | 单元测试断言的是错误**码**，而这句话里本来就没有信息可断言 | 控制器改 stdio pipe + 每容器 4KB 尾巴（仅随非 running 的 status 返回）；`runtimeExitDiagnosis` 把退出码/信号 + 容器原话拼进 502 |
| 13 | `runtimeTransport` 默认 `production ? unix : tcp`，而 **DSH 的入口脚本与全部 `EVIMED_*` 只存在于 unix 分支**；tcp 分支跑裸 `dsh`，没播种、没配置 | 没有测试用非生产 + DSH 内核组合起过容器 | 不是补齐 tcp 分支——DSH 的 web host 拒绝绑非 loopback，publish 的端口没人监听，tcp 对 DSH 本就不可能。改为 kernel=dsh 时默认 unix，显式 tcp 在 `loadConfig` 即报错 |
| 14 | `.credentials.yaml` 缺 `version: 1`，被当作 pre-release 扁平布局拒绝加载，整棵插件树随之失败 | 渲染器的测试断言的是它自己的输出格式 | 补 `version: 1` |
| 15 | `@evimed/domain` / `@evimed/harness-port` **根本不在镜像里**。Dockerfile 注释断言 `bundledDependencies` 会让 `dsh plugin add` 带上它们——而 `bundledDependencies` 只是**打包**指令，`workspace:*` 在非 workspace 里无法解析 | 又一次「断言机制」：注释描述了一个机制，没有任何检查验证结果 | 把两个包复制进 `/opt/evimed/socket/node_modules/@evimed/`，让那条打包指令成立 |
| 16 | seam-probe 调 `shell.run({command})`。`run()` 只接受 `resolve()` 产出的 spec——`resolve()` 才是填 `sandboxPolicy` 的那一步，而 `run()` 无默认地解构它 | 测试替身只提供 `run`，于是探针用错的调法在替身上永远成立 | 按契约先 `resolve()` 再 `run()`；替身补 `resolve`，并在收到原始请求时像真实现一样抛错 |
| 17 | storageDomain 的**域名与表名**都必须匹配 `/^[a-z][a-z0-9_]*$/`；`evimed-run` 与 `runMirror` 一律被拒 | 规则在 DSH 的 `defineDomain` 里，我们这边没有任何地方复述过它 | 域名改 `evimed_run`、表名改 snake_case（JS 句柄仍 camelCase，只在建句柄处映射）；把这条标识符规则写成断言钉住 |

**写探针的人自己用错了接缝**（#16），是这一轮最值得记住的一条：seam-probe 存在的理由就是「DSH 改名了我们要立刻知道」，而它从写出来到这一天，**从未被一个真的 DSH 执行过**。

### 30.1c 构建期加了一道「启动冒烟」

原有的三道自证——原生绑定可加载、`--dump-config` 非空、换路径仍能 dump——**没有一道会 import 插件**。所以在一个 bundle 根本无法导入的镜像上，三道全绿。

`deploy/runtime-dsh/build-smoke.sh` 用一次性凭证文件 + 全套 `EVIMED_*` **真启动** profile，任何 entry 未 apply 即构建失败。#14–#17 中的每一个，它都会当场拦住。

另有一条同族：`.dockerignore` 的 `node_modules` 只匹配上下文根（dockerignore 按整条相对路径匹配，裸名不匹配深层），于是 `packages/socket/node_modules` 一直被打进镜像，其中一条 pnpm 工作区软链把 #15 的 COPY 悄悄重定向到了别处——**镜像是靠巧合工作的**。改 `**/node_modules`。

### 30.1d 冒烟绿了之后还剩三个：构建期与运行期不同的那部分

启动冒烟拦住了 #14–#17，然后容器还是起不来。原因很简单也很值得记：**冒烟在构建里跑，构建里没有那层 tmpfs**。

| # | 缺陷 | 为什么连冒烟也测不到 | 修法 |
|---|---|---|---|
| 19 | `node-addon-require-builtin` 是 Cordis loader 用来拿 Node 内部模块加载器的原生插件。**拿到了，bare specifier 按 profile 目录解析；拿不到，退回按 loader 自己的目录解析**——而我们的 bundle 不在全局 dsh 安装里，于是每个插件都报 "Cannot find package '@evimed/dsh-socket'"，**全程没有一个字提到那个插件加载失败**。它默认把 `.node` 复制到 `/tmp` 再 dlopen，而 docker `--tmpfs` 隐含 `noexec` | 构建期的 `/tmp` 是可执行的，所以冒烟永远不会撞上 | `NARB_DISABLE_NATIVE_CACHE=1`——不给 /tmp 开 exec（它是只读容器里少数可写路径之一，noexec 值得留着），改为直接从可执行根文件系统上的安装包加载。冒烟同步改为把 cache 指向一个不可用目录，等价复现 noexec 的后果 |
| 18 | patch 的 `- insert:` 行只有 `id` 没有 `name`，loader 没有可 import 的东西 | 契约测试断言的是"patch 能命名的行"，插入行没有被要求带名字 | 补 `name`；新增断言：任何 insert 行必须带 name |
| 20 | `dsh-mcp-client` 的配置是**扁平**的（`transport` 是判别字段，`command`/`args`/`env` 与 `serverName` 平级），我们按嵌套生成 | 冒烟不带控制面 patch，`mcp-evimed` 那一行在构建期根本不存在 | 改扁平。**冒烟的下一步是把一份代表性的控制面 patch 也带上** |
| 21 | 研究 MCP 一直从 **OpenCode 的 `opencode.json`** 里读网关令牌，DSH 内核不写这个文件 | 它不在启动路径上：运行时会**干净启动**，然后每一次取源失败 | DSH 侧另写一份只含令牌的 0600 文件 + 网关 URL/模型两个环境变量；MCP 两个读点改为"有裸令牌优先"，两条路合到同一套拒绝条件与同一个 return |

| 22 | 宿主侧控制套接字路径 129 字节，超过内核 `sockaddr_un.sun_path` 的 108 字节上限 | 容器在挂载内绑**自己的**短路径，启动完全正常，日志真的打出 `dsh web: http://127.0.0.1:<port>`；连不上的是控制面这一端，而 libuv 截断后报的是 ENOENT——看起来像"套接字还没创建" | 组装 launch plan 时即拒，named error 报出实际字节数与上限。卷支撑布局把套接字放进短哈希目录不会碰到；非卷布局的长度取决于运维把数据目录放多深 |
| 23 | 就绪超时 30s 是 OpenCode 时代的值，DSH 组合 137 行插件树实测约 62s | 没有任何测试真的等过一个容器组合完插件树 | 拆成两个超时——"这次调用卡住了吗"与"内核启动完了吗"是两个问题。`runtimeReadyTimeoutMs`（dsh 默认 180s）**只对 docker 沙箱生效**：宿主运行时要么绑上端口要么没绑，给它三分钟只会把"二进制不存在"变成三分钟的等待 |

| 24 | `agent-presets` 行的 `roots` 由 DSH 在**每次启动**用它自己的 shipped preset 根覆盖——`composeProfile` 末尾推一层 overlay，保留其余键、只换掉这一个 | 与 #8 同族：行看起来配好了、`default` 也确实生效，只有目录不可见。契约测试断言的是"patch 里有 `trust: system`"——那一行确实在文件里 | 与 #8 同解：把东西放到内核真正会看的地方。镜像把 preset 装进 DSH 自己的 `config/agent-presets/`，构建期两侧对名字；patch 删掉 `roots`，测试改为断言**不得**出现 `roots` |

| 25 | `dsh-permission-presets` 从「组合出来的沙箱模式 + 审批策略」反推默认 preset，配不上任何一个就拒绝加载并**带倒整棵插件树**。它自带的三个把"受限"绑 `ask`、把"不受限"绑 `never`，而托管运行要的是**受限且无人值守**——两者都不是 | 验收控制面不是 production，走 `ask`，恰好命中自带的 `workspace-write`，真机一路没报。**这一条是新加的构建冒烟拦下的，而且拦的正是只在生产出现的那一半** | patch 整表重列三个自带 preset + 新增 `evimed-hosted`(workspace-write, never) 并显式 `defaultPreset`；本地面仍用自带的 `workspace-write`，不多造一个 |

#19 是整轮里最贵的一条，也是最能说明问题的一条：**一个组件失败之后，报错的是另一个组件**，而且报的是一个完全说得通、完全指向错误方向的错误。会绿的构建、会过的冒烟、会读的日志，全都指着"我们的包没装上"，而真正坏的是一个谁也没提到的原生插件。这类缺陷唯一能被系统性抓住的方式，是**让验收环境与生产环境的差异清单本身成为一份要维护的东西**——目前它是：tmpfs 及其 noexec、能力掉落、只读根、网络策略、pid 上限。


### 30.2 共同形状：断言机制，而不是断言结果

八个里有三个（5、8，以及我自己在修复过程中写坏的两处断言）是同一个错误：**验证了"命令成功"而没有验证"想要的效果发生了"**。

- 断言 `node-pty/build` 目录存在 → 那是 node-gyp 的实现细节；node-pty 用预编译产物时**根本不生成该目录**，于是断言在正常镜像上失败。改为查找可加载的 `*.node`。
- 断言"搬迁后能组合" → **没有我们的 bundle 也能组合**，所以 bundle 消失时它是绿的。改为断言我们的行在场。
- 五个既有测试断言"patch 里有 `evimed-run-policy` 这一行" → 这一行确实在文件里，但 DSH 会丢弃它。测试在为一个从未发生的效果背书。

**规则**：验收条件要写成"我要的东西在不在"，不能写成"我做的动作有没有报错"。

**推论（#8 与 #24 两次之后）**：还有一类更难看见的——**配了一个上游会覆盖的位置**。patch 够不着 preset 的行、`agent-presets.roots` 每次启动被换掉，两次都是"文件里确实有这一行"，两次的契约测试也都据此为一个从未发生的效果背书。对上游配置面的断言必须落在**上游读到的值**上，而不是落在我们写出去的文本上——`--dump-config` 的快照能证明前者，grep 我们自己的输出只能证明后者。

### 30.3 第二个形状：只有掉权限才现形

缺陷 6 的性质值得单列。同一个镜像、同一条命令：

| 容器参数 | 结果 |
|---|---|
| 宽松（不掉 capability） | 退出码 0，16,074 字节 |
| `--cap-drop ALL`（生产同款） | 退出码 1，634 字节 |

差别只在 root 是否还持有 `CAP_DAC_OVERRIDE`。**开发机上永远测不出来**。因此本节的所有验收一律在生产同款参数下执行（`--cap-drop ALL --security-opt no-new-privileges --pids-limit --memory --cpus`），这条写进 §13 的 P0 退出标准。

### 30.4 V13 的答案与处置

内核 6.8 给 Landlock **ABI 4**，DSH 的启动器按 `MAX_ABI 5` 构建规则集（ABI 5 在内核 6.10，新增 `IOCTL_DEV`），故自报 `partial`。DSH 自己的 C 源码写明「report, do not refuse」。

**处置：宿主内核升到 7.0.0-30（Ubuntu 24.04 官方 HWE），实测 `landlock: fully enforced`。** 因此 `OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT` 保持生产默认 `full`，不为任何一台机器开例外——例外一旦开了，下一台机器该不该继承就说不清。

约束实效在两个内核上都实测过：工作区外读写 `Permission denied`，区内正常。

顺带补上一个真缺口：`host-preflight` 原本只检查内核 ≥ **5.13**（Landlock 存不存在），而满级 enforcement 要 **6.10**——也就是说 6.8 能通过全部预检、然后运行时拒绝启动。现已按实测分界补成门禁。

### 30.5 构建期外部依赖（部署前提，必须记进仓库）

前两次构建失败与代码无关，是国内主机的网络前提：

| 依赖 | 直连 | 必须走 |
|---|---|---|
| Debian 包 | `deb.debian.org` 极慢（13 分钟装 21 个包） | `mirrors.aliyun.com/debian` |
| GitHub（uv 二进制与 LICENSE） | **0 B/s，完全不通** | `GITHUB_DOWNLOAD_PREFIX=https://ghfast.top/`（实测 2.1 MB/s） |
| npm | 慢 | `registry.npmmirror.com` |
| PyPI | 慢 | `mirrors.aliyun.com/pypi/simple` |

这套值**本来只存在于服务器的 `.env` 里**，仓库中无处记录。Dockerfile 与 compose 的参数化早就做好了（`APT_MIRROR` / `GITHUB_DOWNLOAD_PREFIX` / …，且 compose 的转发正是 2026-07-23 那次教训的产物），缺的只是"这个部署该用哪几个源"这一事实的落点——已补入部署文档。

### 30.6 尚未验收的部分

本节走通的是**基础设施层**：镜像可构建、profile 可播种可搬迁、生产加固下可组合、pnpm 离线可用、沙箱满级约束、patch 零未匹配。**模型链路（真实题面经 DSH 跑完并过门禁）尚未执行**——它需要真实的 DeepSeek 调用与完整控制面。P0 退出标准在那一步完成前不算满足。

---

## 附：一句话回答用户的三个原始问题

- **「DSH 里很多功能用不到，要不要剥离？」** 不用剥。模型可见面由 preset 决定；不写进我们的 preset 的工具和提示词节，模型永远看不到；宿主面的注册表、沙箱、持久化、模型路由必须整套保留。唯一要**关**的是 `hmr`、`tool-web`、遥测。
- **「哪些不用自己做？」** Agent loop、压缩（80% / 16% / 8192）、会话持久化与崩溃补记、工具管线与审批缝、子代理 / 工作流 / goal / jobs、沙箱后端、技能加载、附件、凭据解析、token 计量、Web 壳与线协议。**要自己做的**：控制面已有的一切（租户、账本、网关、门禁、路由、记忆），加上插头的七个插件（§5.3）与能力清单校验器。
- **「跨模式的需求怎么路由？」** 不路由。一个会话一个统一组合，模型自己计划、委派、组合能力；契约绑在产物上，安全触发器扫描所有产物；分类器只做事后期望检查，错了最多多一轮对话。能力目录就是外推性的边界：目录里有的都能组合，没有的它会如实说没有。
- **「前端要不要换成 DSH 的 TUI 或 Web？」** 不换框架，换词汇表。TUI 是开发者终端，不是医学科研产品界面；DSH Web 客户端没有受支持的页内嵌入途径，而且是单用户产品 UI。保留 React 应用，重写会话层与运行树（约 3.5k 行耦合代码），借鉴 DSH 客户端的呈现模式而不借代码；DSH Web 只在本地 profile 原样使用。
- **「记忆怎么做？」** 两层都在 MemOS 底座上：会话 cube 自动记（兜底），胶囊 cube 蒸馏沉淀（资料 → 知识 → 画像 → 方法 → 经历五层，双时间轴，每条可溯源）；方法论蒸馏成 SKILL.md，由插座注册为技能，编排器可见；分享的是「工作方式包」快照（方法 + 依赖知识 + 标准 + 教训），接收方以 guest 模式激活后 Agent 仍以我的身份、按 A 的方式工作；胶囊永远是上下文而不是权限；体验优先，审阅不挡路。
- **「现有的技能、API、数据库接入、MCP 怎么接？」** 九类资产各有一种封装与一种接入形式（§21.1）：能力走 `capability.yaml` + 契约校验器 + 委派；通用技能走 preset 相对路径的技能根；26 个 MCP 工具走 `dsh-mcp-client` 一行；私有数据 API 与 53 个公共连接器在 MCP 里按路由表选源（托管面一律经网关）；六个专科引擎走 HMAC 适配器并在 P2 包装为 DSH 作业。模型决定做什么，代码决定怎么装、去哪取；护城河全部在 DSH 之外。
- **「30 个子代理够不够、要不要队列？」** 够；不要队列。30 在进程内子代理的设计范围内；跨运行的并发上限控制面已有；真正的「蜂群」原语（花名册 / 任务 DAG / 邮箱）DSH 已在 experimental 里，等它转正后用配置打开。
- **「用户有了胶囊和数据之后，能不能让 AI 主动做科研、人只充值看结果？」** 能，而且是这套架构里差异化最强的一步，但要三处修正：卖点是「每天早上有结果、你只做决定」而不是「直播」（直播是信任机制）；每晚做的是**预注册的研究回合**而不是「去发现点什么」（Kosmos 综合性陈述只有 57.9% 准确、Sakana 42% 实验失败，无人值守会把错误按晚数放大，所以验证优先 + 分级 + 计划冻结）；额度透明并把 DeepSeek 夜间 5 折传导给用户。机制上它只是「系统发起的运行」：议程与调度在控制面，回合用同一个组合、同一套门禁，不新增内核能力（§24）。
- **「上传资料与分享胶囊的流程怎么做？」** 上传：分块续传、逐文件状态机（排队 → 上传 → 扫描 → 解析 → 蒸馏 → 完成 / 需要你看一下）、按类型分支（MinerU 解析文档、DuckDB 画像数据、ASR 网关转写音频）、没有任何阻塞对话框，完成后每份资料一张「学到了什么」卡。分享：发送方三步（范围 → 「对方会看到什么」预览 → 脱敏报告）+ 管理；接收方预览 → **试用一次** → 激活（guest / blend）→ 身份条 → 版本更新 → 停用；撤回只影响未来版本（§23.4–23.5）。

- **「资料多而杂，怎么辨别有用没用？抽全了吗？能不能让用户把原始库放网盘？」** 原始库放用户自己的网盘 / 本地文件夹（自托管 OpenList 聚合 40+ 网盘；大媒体走本地分析代理；平台上传兜底），我们只存派生物与指纹。「有用没用」不是二分：分流给每份资料一个五维价值向量（画像 / 方法 / 知识 / 证据 / 数据）决定深度——所有内容先进索引（索引完整性 100%），值得的才蒸馏（`structured / deep`）。「抽全了吗」可度量：覆盖台账记录每个单元的去向、必填槽位核对、QA 式遗漏审计（长文档的主要失败是遗漏，QA 审计最稳健）、产出量异常检测、定向二次抽取；`deep` 遗漏 ≤ 5%。EviMed 自己的运行、交付物、回合与反馈走同一条线。整理台把每个判定的理由摆给用户，覆盖即反馈（§26）。
- **「蒸馏模型怎么设计？模型怎么就更了解我了？」** 「了解」定义成能预测你：编辑、决策、措辞、方法四个预测任务每周打分。理解存在**上下文**里而不是参数里（RAG 式个性化 +14.9% vs 微调 +1.1%，DeepSeek 也没有托管微调）：画像区块、按情境召回的偏好、作为技能的方法、你自己的范例。它变深靠四个回路——显式（上传、笔记、冷启动访谈）、**编辑**（每次修改推断一条偏好，下次按情境召回）、决策与插话、睡眠期反思；不确定且影响大的地方才问你，每天最多一个小问题。守卫：你的立场永远不能改变证据规则（§27）。
- **「胶囊是不是就是个 JSON 谁都能看？」** 不是。三种形态：工作态是边界内的结构化数据（要检索，所以是明文，靠隔离与审计）；备份按胶囊密钥加密；分享与导出用 `.evimedcap` 容器——里面的格式开放（Markdown / JSONL，方法目录就是技能根），外面 AES-256-GCM 加密、包密钥用 X25519 封装给每个接收者、Ed25519 签名、Merkle 根防篡改、版本链可追溯；全部用 Node 核心 `crypto`，零新依赖。密码学解决泄露、截获、冒充、篡改；不解决接收者解密后转发，也不解决运营方可读——方案如实写明（§28）。
- **「是不是过度设计了？门禁是不是太多？」** v3.5 收口后：全系统阻断点只有六个（交付契约校验、服务端外部门禁、完成核对、预算守卫、路径守卫、导出前签核），其余一切非阻断；删掉了生效前确认、自主等级、v1 假说锦标赛、Thompson 采样、分类器训练、人工抽样复核、四套跟版流程；不训练任何模型。算法方向联网复核全部确认，两处按 Agents4Science 的证据修正：问题来自人、假说只作建议（§29）。
---

## 附 B：OpenCode 残留清零清单（P2 退出标准）

2026-08-22 对 `OpenScience/` 的检索（排除 `node_modules`、`PROGRESS.md`、lockfile）：**216 个文件**提到 OpenCode。按处置分三类；P2 的退出标准是前两类归零，`grep -rIli opencode` 只剩第三类。

| 处置 | 范围 | 文件（数量） |
|---|---|---|
| **删除** | 运行时镜像与脚本 | `deploy/runtime-opencode/{Dockerfile, open-science-opencode-serve.sh}`、`scripts/dev/fetch-opencode.sh`、`runtime/opencode-profile/`（空占位） |
| **删除** | SDK 与桌面壳 | `packages/sdk/src/{OpenCodeClient.ts, mockServer.ts, types.ts 的 OPENCODE_VERSION / DEFAULT_OPENCODE_URL}`、`apps/desktop/src/lib/{runtime.ts, tauri.ts}` 及其测试、`apps/desktop/src-tauri/src/{runtime.rs, opencode_config.rs, science_mcp.rs, kernel.rs, lib.rs, tools.rs}`、`tauri.conf.json`（D11：桌面形态改为 `evimed-web` profile；`AgentRuntime` 接口迁入控制面） |
| **重写** | 控制面 | `apps/server/src/runtimeManager.mjs`（约 90%）、`mockRuntime.mjs`（换 DSH 假内核）、`server.mjs`（删 `/api/opencode/:projectId/*`，加 `GET /api/runs/:id/events`）、`config.mjs`（`OPEN_SCIENCE_OPENCODE_*` → `OPEN_SCIENCE_DSH_*`，旧名硬错误一个发布周期）、`releaseManifest.mjs`（`opencode` 字段 → `dsh` + `bundle`）、`runtimeControllerServer.mjs`（镜像/容器名）、`commands.mjs`、`saasProfile.mjs`、`agentRuns.mjs`（消息形状归一化后的注释） |
| **重写** | 控制面测试（18） | `runtimeManager`、`runtimeController`、`deepseekOpenCodeReleaseGate`（→ DSH 发布门）、`deepseekReceiptSecurity`、`evimedMcp`（`opencode.json` 的 MCP 配置解析 → profile patch 生成）、`hosted-web.e2e`、`host-preflight`、`releaseManifest`、`releaseFixture`、`runtimeModelProvider`、`server`、`deploy`、`config`、`saasProfile`、`branding`、`skillPacks`、`researchSessions`、`agentRuns` |
| **重写** | 运维脚本与 CI | `scripts/ops/{deepseek-opencode-release-gate, deployment-smoke, generate-release-manifest, hosted-production-e2e, host-preflight, audit-hosted-compliance}.mjs`、`.github/workflows/{build, web}.yml`、根 `package.json` 脚本、`deploy/web/{docker-compose.yml, .env.example, saas-capability-contract.json}` |
| **重写** | MCP | `runtime/mcp/evimed-research/public_sources.py` 的 `_gateway_settings()`：令牌从 `opencode.json` 的 `provider.deepseek.options.apiKey` 改为读独立的令牌文件（结构性依赖，与文件是否含 "opencode" 字样无关）；`source_catalog.py` 文案；3 个测试 |
| **脚本改写** | 技能包（48 个 `SKILL.md`） | `runtime/skills/{core×9, curated-scientific×36, evimed×3}`：`$XDG_CONFIG_HOME/opencode/skills/...` 路径与「OpenCode」字样 → `skill` 工具返回的 `<skill_resources>` 路径（§9.6） |
| **改写** | 文档（约 20 份） | `AGENTS.md`/`CLAUDE.md`（架构守则「UI 经 `packages/sdk` 调 OpenCode、pin `OPENCODE_VERSION`」→ 「UI 只调 `apps/server`、pin DSH 与 bundle 版本」）、`README.md`×2、`docs/{TECHNICAL_DESIGN, REQUEST_PATH, WEB_DEPLOYMENT, WEB_DEPLOYMENT_READINESS_REPORT, WEB_OPERATIONS_RUNBOOK, WEB_PRIVACY_AND_COMPLIANCE, REQUIREMENTS}.md`、`runtime/skills/README.md`、`packages/sdk/README.md`、`apps/server/README.md`；工作区根的 `CLAUDE.md`/`AGENTS.md` 同步 |
| **不动** | 评测历史产物（61） | `evals/title-to-paper/runs/**`、`evals/capability-audit/results/**`——它们记录的是**当时**由哪个内核产出，是溯源数据；`evals/capability-audit/{verify_release_audit, build_skill_*}.py`、`run_connector_gateway_audit.mjs`、`evals/specialist-smoke/run_managed_specialist_smoke.py` 五个脚本按新镜像改 |

控制面里**不是** OpenCode、因此不在清单内的东西：OIDC/租户/项目（`store.mjs`、`oidc.mjs`）、账本与交付判定（`agentRuns.mjs` 的 95%）、门禁（`clinicalEvidenceQuality.mjs`）、路由、三个网关、记忆底座（usememos 退役、MemOS 新建，§19.16）、Postgres、备份与运维脚本。这些是 EviMed 自己的，换内核不碰。
