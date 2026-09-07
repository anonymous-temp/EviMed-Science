# 2026-09-07 · 自进化回路建设方案（完整版）：EvoDS × ToolVerse × SkillPyramid 在 EviMed 的实现

> 对同日英文版《EviMed Agent Self-Evolution Implementation Plan》的修订与扩写。设计仍以 `docs/superpowers/specs/2026-08-22-evimed-dsh-plug-harness-design.md`（下称「规格」）为准；本文件是**实现方案**：三篇论文的每个机制在本平台上的对应物、已有代码、要新写的东西、文件级改动点、测试与验收。所有代码事实以 2026-09-07 的 `main`（`7d51eee8e`）加当日工作树核实，每条附文件位置（行号按会话结束时的工作树复核；并行会话仍在改 `runtimeManager.mjs` / `pluginService.mjs` / `usageLedger.mjs` / `server.mjs`，行号可能再漂，事实不变）；论文与开源代码的事实以当日联网核验为准（第 12 节）。

## 0. 执行结论

**方向成立，机制全部落地，但不建第四套子系统。** 文章讲的闭环——任务产轨迹、评估判结果、系统提炼经验、验证后回写、下一轮复用——规格早在 8 月就按同一结构设计过：§19.17 三个平台级回路（L1 用户 / L2 能力手册 / L3 跨用户）、§19.22 睡眠期巩固 A1–A6、§27 蒸馏流水线与四个信号回路。三篇论文没有推翻其中任何一条；它们把其中三处写得太粗的规则逼成可执行定义，并各自带来一件我们没有的东西：

| 论文 | 机制 | 我们已有 | 本方案落地为 | 节 |
|---|---|---|---|---|
| EvoDS · ASA | 合成 → 验证 → 缓存 → 扩展，τ=3 门槛 | 规格 A3.3「≥ k=3 条成功轨迹归纳方法」、`METHOD_INDUCTION_MIN_TRAJECTORIES = 3` 常量（零消费者） | `distill` 作业（方法文本）+ 代码技能（`scripts/`）；计数绑 `(methodId, contentDigest)`，五个计数分开记；扩展 = `approved` 即挂载 | 6.2、6.7 |
| EvoDS · ACC | 子代理局部摘要 + 管理者专属摘要工具 + 可学习的压缩策略 | DSH `compaction-basic`（零配置）、工具输出裁剪、`task-plan.json` / `state.json` | 压缩回执 → 结构化任务状态包 → `summarize()` provider 换实现 → 模型可请求压缩（探针）→ 离线策略搜索；后期 SFT 摘要器 | 6.5 |
| ToolVerse | 工具依赖图（TDG）+ 动态解锁采样（DUS）+ 模拟环境 + 逐轮信用（TARA） | 27 个 MCP 工具、16 份能力清单的 `tools[]`、14 个评测 harness、hosted e2e 的派发 API | brief 生成器（TDG + 解锁层级 + 参考解真跑验证）、录制响应网关、配对评测 runner；TARA 先做成逐轮覆盖诊断，训练阶段再做奖励 | 6.3、6.8 |
| SkillPyramid | 技能创建 → 关系分析 → 关系构建 → 增量整合 → 多层检索 | 规格 §19.15 的 `derived_from` / `depends_on` 闭包；`documents(method)` 种类；胶囊方法挂载（进行中） | `consolidate` 夜间作业实现分析器与构建器；层级由 `depends_on` 推导；按需装配带预算 | 6.4 |

**对 09-07 英文版方案的九处修订**（保留其论文核验与三条修正）。它把回路建成了平行系统：8 张新表、新队列、新 socket 插件、六个端点、Python gym、七态生命周期加发布审阅，与 §16 #22（不设审批流、不加阻断点）、§29.2 #1 / §19.14（方法修订立即生效、事后审阅不挡路）、开发原则 G（不写新 DSH 插件）冲突：

| # | 英文版 | 修订为 | 依据 |
|---|---|---|---|
| 1 | `experience_episodes` / `learning_jobs` 两张新表 + 新队列 | 零新表：episode = 运行账本 + 转录文件；学习作业 = 既有 `jobs` 账本里从不入队的 `distill` / `consolidate` 种类 | 一套租约队列已跑三个 worker |
| 2 | 方法四张表 | 方法 = `documents.kind="method"`，版本 = `revisions`，回滚 = `pluginService.rollback()` 同款 | 规格 §14 规则 4 |
| 3 | 关系 / 观察 / 评测三张表 | 关系与计数在方法文档的 `learning` 载荷；评测结果是 `evals/` 报告文件 | 表是最贵的接口 |
| 4 | 七态 + shadow / canary + 发布审阅 | 私有方法：显式来源立即 `approved`；推断来源 `candidate` → τ + 留出门 → `approved`，事后审阅、一键回滚；平台技能：普通 PR，CI 平价语料是门 | §29.2 #1、§19.14、规格 :1812 |
| 5 | 六个 `/api/evolution/*` 端点 | 复用 `PATCH /api/memory/records`、胶囊方法路由与收件箱；只加只读候选列表 | 不新增审批流 |
| 6 | 新 socket 插件 `context-policy.mjs` | `compaction` 服务换 provider（`harness-port` 子类 + preset 一行），不加 agent 面插件 | 开发原则 G；§21.8 ② |
| 7 | 六操作 gym + 四模板 | 载体 = 真实运行时容器 + 录制响应网关 + 既有探针；任务先补零 brief 能力再由生成器扩 | 开发原则 #9 |
| 8 | `EVOLUTION_*` 开关、`evolution/` 子目录 | `OPEN_SCIENCE_LEARNING_*`、平铺模块 `learningService.mjs` / `learningWorker.mjs` | 仓库命名惯例 |
| 9 | 独立十周两人程序 | 挂靠 gap-closure #6 / #12 / #13 / #14 / #18 与规格 C2 / C3 | P0 在前 |

**EvoDS 代码可复用**（用户已取得许可）：值得移植的是 ACC 摘要提示词、工具配置抽取提示词、创建工具的约束、以及 verl 的多轮 SFT / GRPO 流水线（第 6.8 节）；不移植的是进程内 `exec` + `os.chdir` 的执行方式与按名字的计数（技术原因，非许可原因）。

**三档取舍（§16 #22）**：Microsoft SkillOpt 引擎按小改档用作平台技能 delta 优化器；`dsh-run2skill` 借模式；MemOS 本地插件的技能结晶作对照随记忆底座另案；`dsh-learn`、`stylotrace` 不收；护城河（契约与证据规则、方法账本的溯源与 digest 计数、评测语料）自建。见 3.4。

**阻断点：零新增。** 学习回路的每个判定都是 notice、标记或可回滚的修订；6 个阻断点（§29.3）不动。推断来源方法的「τ + 留出门」是系统对自己产出的晋升谓词，不是对用户任务的门。

## 1. 论文与公开代码核验（2026-09-07 联网）

### 1.1 可得性

| 来源 | 核实结果 | 我们取什么 |
|---|---|---|
| EvoDS | arXiv 2606.03841（2026-06-02，KDD 2026）。仓库 `usail-hkust/EvoDS` 7 次提交，HEAD `14635a4`；根目录无 LICENSE（仅 vendored `verl/LICENSE` Apache-2.0）——**用户已取得许可，代码可复用**；权重 HF `yangzhr/EvoDS`（基座 Qwen3-8B）| 提示词、创建工具约束、SFT / RL 流水线；不取执行方式与计数方式 |
| ToolVerse | arXiv 2607.15660（2026-07-17，美团 LongCat）。HTML 与 TeX 源码包无任何 GitHub / HF 链接；GitHub 搜 "ToolVerse" 255 个无关仓库、"turn-aware advantage" 0 个；HF 无 GUST、无权重 | 方法：TDG、DUS、模拟环境构造、TARA |
| SkillPyramid | arXiv 2606.03692（2026-06-02，中科院自动化所 / 上海 AI Lab / BAAI）。无代码链接；GitHub 搜 0 结果 | 方法：技能表示、分析器 / 构建器、增量整合 |
| SkillNet | `zjunlp/SkillNet`，MIT，1,254 星，arXiv 2603.04448。与 SkillPyramid 不同团队；SkillPyramid 沿用其评测协议，标题数字几乎相同（40% / 30% vs 38.0% / 27.7%） | `creator.py` / `analyzer.py` / `evaluator.py` 作对照 |
| Microsoft SkillOpt | `microsoft/SkillOpt`，MIT，16.7k 星，arXiv 2605.23904；`skillopt-sleep` v0.2.0 | 平台技能 delta 的优化器（6.6） |

「未找到」是有界检索的结论，不排除后续发布。

### 1.2 改变工程决定的核实点

**EvoDS 的 τ=3 比文章写的粗。** `utils/util.py@14635a4`：τ 是硬编码字面量 `>= 3`（:457, :475 与四个子代理各一处）；计数按 AST 取出的裸函数名（:281, :289）；同名替换正文时代码被覆盖而计数继承（:450-455，作者注释「tool may not the same, update in the future」）；计数同时来自合成（创建脚本退出码为 0 即算，无任务级验证）与调用（`execute_tool` 裸 `except` 只返回字符串，**失败调用也计数**）；「永久加入动作空间」实际是每次重算 `top_k`（计数 ≥ 3 里取前 10）；复用时进程内 `exec` + `os.chdir`（:384-391），只有创建时走 1,800 s 超时子进程。仓库自带缓存几乎为空（3 条），279 / 925 / 69% 不可复现；「48 → 0」是 Table 3 四基准超限样本之和；ACC 的「可学习」只是 RL 奖励里的惩罚项 `R = R_outcome + αR_sub − βP_context − γP_turn`（α=0.2，β=γ=0.1）。训练是真的：SFT 36,458 行、RL 7,851 / 150 行、GRPO 8 rollouts × 300 步。

**ToolVerse 的环境是从真实工具定义生成的模拟实现。** 取 Toucan 多轮子集的工具规范，为每个工具集生成字典型 mock 数据库与可执行函数，再生成单测只保留全过的；约 20% 工具集因依赖外部服务被过滤。TARA 的逐轮奖励是对金轨迹的字典级覆盖（工具名 + 参数全匹配，缺一项即 0），局部优势按组内同轮归一，未来优势 δ=r 门控、λ=0.5、γ=0.5——它奖励「复刻一条金轨迹」，这正是我们的评分器不奖励的东西；所以 TARA 只在训练阶段用，评测阶段只做诊断（6.3.7）。

**SkillPyramid 不限于三层，也没有验证步骤。** `P = {L0, …, LK}`，层号按依赖相对推导（`ℓ(a_k) = min ℓ(s) − 1`，`ℓ(u_k) = max ℓ(s) + 1`）；「functional skill」一词全文未出现。API 推理、不训练、temperature 0 单次运行（无方差）；构建代理 Qwen3.5-35B-A3B + Qwen3-Embedding-4B，外层 ≤ 3 轮、细分析 ≤ 5 轮，构建成本 8.4K 次调用。摘要说「validate」，§2.3–2.4 没有描述任何执行测试或成功门，只有提示词里的「Live environment feedback overrides the generated skill」。**更正一处早先判断**：论文的消融确实把平面技能库与金字塔分开了——ALFWorld 75.7 → 81.4、ScienceWorld 71.6 → 76.3、GAIA-Lite 56.0 → 62.7；去掉原子抽取主要伤「原子密集」任务（−6.5），去掉抽象归纳主要伤「抽象密集」任务（−8.0）。所以层级有测得的价值，但是在游戏 / 网页环境、单次运行、无区间的条件下；在我们的医学科研任务上是否成立仍由 B vs C 配对评测裁决（第 7 节）。

### 1.3 机制细节（原文核实，供第 6 节实现引用）

**ToolVerse**

- TDG：节点 = `{name, description, input schema, output schema}`（工具规范经改写强制带 `response` 输出字段）；边由 LLM 判两类——**参数依赖**（A 的输出可作 B 的必需参数）与**语义依赖**（场景逻辑上 A 必须先于 B）——附可选置信分。DAG 清洗：从零入度节点拓扑遍历，只保留当前偏序下可达的边；遇环删最低优先级边，参数边优先于语义边，无置信分时先删语义边、再删「删掉后新解锁节点最多」的边。每个工具集生成 3 张图覆盖不同流程。
- DUS（Algorithm 1）：就绪队列 `Q = {v | d_in(v) = 0}`；每步取 `k = min(|Q|, N)` 个节点组成一个阶段 `S_t`（= 一轮任务），执行后把后继入度减一、归零者入队，直到队列空；链长由图的层数决定，唯一旋钮是 N（论文未给值）。每图采 5 个任务、每环境最多 10 个、工具集 5–20 个工具、每数据项 3–7 个任务（均 3.8）；反复采样直到覆盖环境内尽量多的工具。
- 任务合成（「逆向上下文重建」）：按拓扑序在 mock 数据库当前状态下逐个实例化调用——依赖参数从上游输出复制，情境参数从数据库取合法值，状态变更立即同步——得到可执行序列即**金轨迹**（每轮一组 `{tool, arguments, return}` JSON，轮内允许依赖相容的任意顺序）。再让 LLM 由金轨迹 + 工具定义 + 入边生成 `user_query / dialogue_history / reasoning_chain`，要求「隐含依赖」（用户说高层目标，不列步骤）、「信息缺口」（早期缺参数时代理需追问）、「一致性」（意图与最后一个工具的输出一致）。验证：金轨迹在 mock 环境真执行成功才保留，再由教师代理 Pass@8 过滤（至少一条轨迹 trace_score = 1）。
- 评测：BFCL-v3 多轮、τ²-Bench、ACEBench-Agent，average@4。消融：环境从 100 → 422 只带来 35.0 → 37.5（BFCL）；TARA 各分量见 Table 4；**没有 DUS 对随机采样的消融**。

**SkillPyramid**

- 技能 `s = (n, d, c)`：名字、一句话描述、正文（适用条件、执行过程、输入输出）；SKILL.md 分节 `Purpose / When to Use / Inputs / Workflow / Verification / Constraints / Output`。依赖字段 δ 存复用引用 `ρ(a_k) = (n_k, q_k, w_k, o_k)` = 被复用技能的名字、唯一标识、复用条件、提供的能力；正文里的形式是 `[reuse skill: <name> | when: <trigger> | provides: <capability>]`。
- 创建器两阶段：FRAMEWORK_CONSTRUCTION 先用高层 / 抽象技能搭结构（子目标、决策点、成功判据），DETAIL_INSTANTIATION 再用原子技能填可执行操作、输入、状态检查、验证规则、复用引用；「若既有技能完全覆盖任务则直接复用」。
- 分析器：SCREEN 只看 `name + description`（+ 嵌入相似度）筛候选组；DECIDE 用工具读组内全文，输出 `ASSIGNMENT / SKILLS / RELATION_TYPE / REASON`；向下三型——SHARED_PART（共享一个具体子能力，各自仍有实质任务逻辑；「不要用于模糊的主题相似」）、SUBSET（严格子技能，宽者多出流程 / 约束 / 情境）、MERGE（触发、输入、流程、输出近乎等价）；向上——ABSTRACT_PATTERN（同侪共享更高层解题模式，父技能只总结组合，不成为可执行合并体）。
- 构建器：SHARED_PART 抽出共享操作为更低层原子技能，源技能改为经复用引用委托该操作；SUBSET 只改宽者，把重复实现处替换为对窄者的引用；MERGE 造一个保留所有有用不冲突细节的规范技能，不保留重复变体；UPWARD 造高层指导性父技能，不合并不替换子技能。硬规则：「分析器的分配是权威，不得改 ASSIGNMENT / RELATION_TYPE」「保留源技能的流程、约束、边界情形与验证检查」「只在受影响段落附近加复用引用」「不得发明工具、脚本、文件、观察、动作、依赖」「改写后的技能必须仍可作独立 SKILL.md 阅读」。
- 增量更新：新技能作查询，嵌入检索相关技能，只对它们派发关系构建；`P_{t+1} = Update(P_t, ŝ, ΔP_t)`；无显式删除策略（MERGE 隐含退休源技能）。推理期：检索到的技能插入系统提示 `{{skill_reference}}`，ReAct 格式；top-k 与文本预算论文未给。

**EvoDS**

- ASA 的「验证」= 合成代码在当前子任务上执行成功且输出合法（脚本形状：`def tool_name(parameters)` + `if __name__ == '__main__'` 自调用）；缓存记录 `{code, tool_config}`，`tool_config` 由抽取提示词生成为 OpenAI function schema，规则：名字必须等于函数名、必需参数 = 无默认值参数、不得发明或遗漏参数；暴露方式 = 子代理工具列表里多一条 schema，管理者看不到缓存技能；创建工具要求「通用、数据集无关」。
- ACC 两级：子代理把执行结果**按全局目标**蒸馏成摘要（成功 → 关键结果，失败 → 失败原因与错误模式）；管理者有专属 `context_summarize` 工具，自主决定何时调用，摘要**整体替换**历史，下一段只剩「系统提示 + `CONTINUE_PROMPT(task, summary)`」（「把摘要当作先前上下文的权威表示」）。触发：token 超 `context_tokens`（默认 24,576）强制调用，或模型自行调用。摘要提示词要点：不复述题面（题面稍后单独给）、不调工具；纳入环境信息、数据信息、决定与结论、中间结果、工具用法与格式约定；排除客套、被取代的信息、无信息量的失败尝试；输出为编号列表，每条自足、精确、单一信息。RL 里的上下文惩罚实际是阈值规则（短于 8,192 就摘要 −0.1；超过 16,384 还调别的工具 −0.1），不是论文写的 `|C| / C_max`。
- 课程：`max_assistant_turns` 按训练步 4 / 8 / 12 / 16 / 20。SFT 行 `{data_source, messages[{role, content, tool_calls}], tools(JSON), enable_thinking(false), extra_info{index, role, split}}`，角色含 manager 34,712、tool_extraction 972（抽取步也被训练）、各子代理数百；64 行含摘要调用、58 行是摘要后的续段。评测判分：DABench 数值精确 / 容差匹配（不足时 GPT-4o 重抽取）、DA-Code 官方评测器 + 图像裁判、SAB 官方脚本、MLE-Dojo 榜位。

### 1.4 同类系统

`aiming-lab/SkillRL`（MIT，2602.08234）；`Zhang-Henry/CoEvoSkills`（Apache-2.0，2604.01687）：生产者 / 评估者协同演化，与「提出者不能是唯一裁判」同构；`Hik289/SkillOps`（MIT，2605.13716）：技能技术债，对应退休提议；综述 2607.10113；更早的 Voyager、Agent Workflow Memory（规格 A3.3 出处）、SkillWeaver、Dynamic Cheatsheet、Letta sleep-time（2504.13171，规格 A3 出处）。DSH 生态见 3.4。

## 2. 代码基线：已有、半接、缺（`main` `7d51eee8e` + 2026-09-07 工作树）

### 2.1 事实表

| 部件 | 事实（文件位置） | 状态 |
|---|---|---|
| 自进化参数词表 | `packages/domain/src/constants.mjs`：`METHOD_INDUCTION_MIN_TRAJECTORIES = 3`（:38）、`MEMORY_PROMOTION_MIN_OCCURRENCES = 3` / `MIN_RUNS = 2`（:32, :35）、`CAPSULE_SOURCE_WEIGHTS`（`editDiff 0.7 / rejectionReason 0.6 / runTrajectory 0.6`，:86-98）、`SKILL_AUTHORING_LIMITS`（:110）、`PERSONA_SCORECARD_FLOORS`（:101）、`CAPSULE_RECALL_TOP_K = 8`（:47）、重排权重与衰减（:20-29） | 全部零消费者 |
| 运行账本 | 每项目 `runs.jsonl`（`agentRuns.mjs:57`），上限 1 MiB / 1,000 条（:70-71）；记消息数、工具调用数、产物、门禁裁定、质量 notice、时长、错误码、路由原因 | 无转录、无修复回合数（修复计数是内存 `Map`，:2405） |
| 运行事件 | `RunEventHub` 内存 `Map`，500 条重放（`runEventStream.mjs:28, :113`） | 不落盘 |
| 转录 | `onRunFinished`（`server.mjs:774`）已在容器活着时调 `runtimeManager.sessionMessages(project, run.sessionId, {wake:false})`（:844）喂给 `memoryIntelligence.recordRun`（:854）；`sessionTranscript()`（`runtimeManager.mjs:3338`，单页 64 MiB :808）返回 `RunTranscript{sessionId, messages, turns, turnEnd, subagents, lastSeq}`（`packages/domain/src/runTranscript.mjs:20-70`）；容器退出即不可读（`agentRuns.mjs:4102`） | 已抓、未存 |
| 技能加载回执 | 委派回执 `skills: injected` 只有名字（`packages/socket/plugins/run-policy.mjs:568-573, :597`） | 缺 digest |
| 记忆抽取 | 三次观察生效硬编码 `evidenceCount >= 3`（`memoryIntelligence.mjs:410`），不检查 `MIN_RUNS` | 并行会话接管 |
| 作业账本 | `PRODUCT_JOB_KINDS` 九种（`productPersistence.mjs:7`，DDL CHECK 约束）；`ProductJobs.enqueue(userId, kind, payload, {idempotencyKey, projectId, maxAttempts, runAfter, rearmFailed, transactionClient})`、`claim(kinds, workerId, {leaseMs})`、`withLease`、`renew`、`finish`、`finishWithLease`、`fail(…, {retry, delayMs})`（`productJobs.mjs:24-155`） | `distill / consolidate / verify / digest / notify` 无生产者 |
| 方法文档 | `documents.kind="method"`，`source-understanding` 写 `recordType:"source-method"`，id `method:<src>:g<N>:<id>`（`sourceService.mjs:514-515`） | 永远 `draft` |
| 内部能力派发 | `SourceUnderstandingRuns({dispatch, readResult})`：`dispatch({userId, projectId, dispatchId, job, capabilityId, contractKind, input, question})` → `{runId, sessionId}`；`readResult(run)`（`sourceUnderstandingRuns.mjs:8-28`）；清单 `visibility: internal`（`capabilityManifest.mjs:112-113`；`capabilities/source-understanding/capability.yaml`） | 模板可直接复制 |
| 修订与回滚 | `revisions` 表（`productPersistence.mjs:63-73`）；`pluginService.rollback()` 向前保存（:413-425）；应用状态机 + `last_good` + `runtime_generation` 证明（`pluginApplyWorker.mjs`） | 直接复用 |
| 胶囊方法挂载 | 工作树（未提交）`capsuleMethods.mjs`：`MAX_MOUNTED_CAPSULE_METHODS = 32`、`renderCapsuleMethod`、`selectCapsuleMethods(capsules, {userId, projectId})`、`materializeCapsuleMethods({capsules, project, directory})`；docker 启动路径只读挂载（`runtimeManager.mjs:1935-1937, :1995, :2075`） | 并行会话接管，含选择与正文预算 |
| 方法注入 | `plugins/capsule.mjs:121-138` 读全部子目录、:52-60 逐个注册；`run-policy.mjs:559` 整数组传委派；`packages/socket/src/runPolicy.mjs:548-551` 全部正文内联 | 并行会话接管 |
| 压缩 | preset `compaction-basic` 行零配置（`agent.cordis.yml:187-188`）；钉版默认 `thresholdRatio 0.8`、`retainRatio 0.16`、摘要 `maxTokens 8192`（`dsh-compaction-basic/lib/index.js:15, :17, :72`）；`summarize(input, agent, signal)` 是唯一子类钩子（`lib/types/index.d.ts:39-49`），`SummarizationInput{system?, tools?, messages}` → `SummaryResult`；`compactRegion(start, end, agent)`（`dsh-compaction/lib/types/index.d.ts:130`）；`compactNow` 只在代理空闲时经 `ManualCompactAgentContext.runMaintenance` 执行（:51-59，「throws synchronously when the agent is already active」），`dsh-command-compact` 正是这样调它（`lib/index.js:54`）；seam-manifest 把 `dsh-compaction-basic` 记为 `config-row`、`compaction/start|summary|end` 记为观察缝（`packages/harness-port/seam-manifest.json:45-47, :90-91`）；`TOOL_RESULT_PRUNER` 常量手抄无绑定（`constants.mjs:119`） | 控制面声明 `contextWindow: 1_000_000`（`runtimeManager.mjs:1678`）而运行预算 `maxTokens 400000`（`agent.cordis.yml:71-74`）——压力触发在预算内不可达 |
| 用量 | `reserveModel({runLimit, dailyLimit, weeklyLimit})`（`usageLedger.mjs:128-129`）；`priceUsage` 资源类型 `model / asr / embedding / specialist-job / storage`，谷时 `OFF_PEAK_MULTIPLIER`（`metering.mjs:235-262`）；议程 `budgetCny` 未接 `runLimit` | 半接 |
| 反馈 | 无 `feedback_events`；议程 `decide()` 的 `adopt / reject / question` 已接（`autopilotService.mjs:546`，`agenda.mjs:94-95`） | 并行会话接管 |
| 评测 | 14 个 harness；确定性型（`drug-evidence-quality`）与模型裁判型（`open-domain-answer-quality/judge.py`：`JUDGE_PROMPT_VERSION`、答案与报告分文件）；`capability-audit` 产物内容寻址 `{path, bytes, sha256}`（`run_skill_execution_audit.py`）；brief 格式 `briefs.json{schemaVersion, capability, note, briefs[{id, title, why, inputs, mustDo, mustNotDo, gradedOn}]}`（`evals/research-grant-development/briefs.json`）；批测台在 `outputs/audit/scripts/`（RESUME 模式）| 已有 |
| 派发 API | hosted e2e 用 `POST /api/auth/login`、`POST /api/projects`、`POST /api/files/upload`、`GET /api/agents`、`POST /api/agent-runs/dispatch`、`GET /api/agent-runs`、`GET /api/research-sessions/:id`（`scripts/ops/hosted-production-e2e.mjs:77-296`） | 评测 runner 直接复用 |
| DSH 缝 | Cordis 服务声明合并（`Context.compaction`、`Context.skills`）+ 事件；`ctx.skills.register(SkillRegistration)`（`dsh-skill/lib/types/index.d.ts:259`），`SkillSummary{name, description, whenToUse?, invocation, source, provider, resourceBase?}`（:44-59）；`SkillProvider{name, list, get}`（:167-189） | 已核实 |
| 规格里写了没做的门 | 规格 :1812（2026-08-25）：A3 应照 SkillOpt-Sleep 补一道留出集实证关卡 | 即 `consolidate(action: evaluate)` |

### 2.2 对英文版基线表的三处更正

1. 胶囊方法挂载不是「未启用」而是「当天在做」，且并行会话已按本方案加入选择与正文预算。
2. 运行账本是 JSONL 文件不是表；运行事件不持久；转录随容器消失，但 `onRunFinished` 已经在容器活着时拿到了消息——差的只是把它写下来。
3. 不需要发明词表：阈值、权重、作者规范、召回 top-k 都在 `constants.mjs`，缺的是消费者。

## 3. 目标架构

### 3.1 回路

```mermaid
flowchart LR
    R[真实运行<br/>DSH 容器] --> L[运行账本 + 转录文件<br/>runs.jsonl · transcripts/]
    R --> F[反馈事件<br/>编辑 diff / 决定 / 纠正 / 插话]
    L --> D[distill<br/>内部能力运行]
    F --> D
    D --> M[方法文档修订<br/>documents(method) + revisions]
    M --> C[consolidate 夜间作业<br/>关系分析 · 构建 · 晋升 · 退休]
    C --> M
    C --> E[evaluate<br/>配对评测 · 留出集]
    E -. verdict / notice .-> M
    M --> A[装配<br/>capsule-methods 挂载 · 能力 SKILL.md PR]
    A --> R
    M --> B[回滚 = 上一修订]
```

四个部件今天都在：运行账本与转录抓取（差落盘）、反馈的一半、作业账本、胶囊方法挂载。要新写的：转录文件与学习回执（6.1）、`method-distillation` 内部能力与 domain 校验器（6.2）、brief 生成器 / 录制网关 / 配对 runner（6.3）、`consolidate` 执行体（6.4）、压缩 provider（6.5）、平台手册回路（6.6）、代码技能（6.7）。

### 3.2 职责分工（不变量）

| 谁 | 做什么 | 不做什么 |
|---|---|---|
| 模型（Flash 批量 / Pro 归纳） | 提出方法草稿或 delta、判断适用条件、提议关系、写摘要 | 不决定生效、不改契约、不改验证器、不给自己打分 |
| 代码（`@evimed/domain`） | frontmatter 合规、工具名闭集、依赖 DAG、digest、计数、敏感内容扫描、契约不被削弱、句柄保全检查 | 不判语言质量（开发原则 #1） |
| 独立评测（`evals/`） | 冻结基线 vs 候选的配对对照，带不确定性 | 候选生成器不充当裁判 |
| 修订系统（`revisions`） | 生效与回滚 | 运行中的 Agent 无权发布或撤销方法 |

### 3.3 三类学习对象与生效路径

| 对象 | 例子 | 期 | 生效路径 |
|---|---|---|---|
| 方法文本（SKILL.md） | 检索失败后的恢复步骤、报告定点修复流程、数据画像前置检查 | 一期 | 私有：`approved` 即挂载；平台：能力 SKILL.md 的 delta PR |
| 代码技能（SKILL.md + `scripts/`） | 字段标准化、标识符归一、受限计算辅助 | 二期（6.7） | 同上，加静态检查与容器内自测 |
| 上下文策略 | 摘要模板、保留句柄、压缩预算 | 先测量（6.5） | 独立开关 `OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY` |

**医学事实不入方法。** 方法可以写「如何核对适应证与人群」，不可以把某次回答里的药物结论固化成规则；数值仍由确定性引擎算。

### 3.4 生态三档（2026-09-07 逐个核实）

| 部件 | 生态候选 | 档位与动作 |
|---|---|---|
| 平台技能 delta 优化器 | **Microsoft SkillOpt**（MIT，Python ≥ 3.10）：独立 optimizer 模型把打分的 rollout 变成对单份技能文档的有界 `append / insert_after / replace / delete` 编辑（逐字锚点），只在留出集严格改善时接受；文本学习率预算（默认 4 编辑 / 步）、被拒编辑缓冲、epoch 级慢更新与 meta-skill。`skillopt-sleep` = harvest → mine → replay → consolidate（held-out 门，可选无退步门）→ stage → adopt，任务与后端都可经 Python API 注入。DSH 包装 `WODE25500/dsh-skillopt` 的 `source` / `backend` 枚举无 DSH 会话与 DeepSeek 后端 | **小改**：`run_sleep_cycle(cfg, seed_tasks, backend=EvimedBackend)` 直接用，收割换我们的转录、重放换我们的评测（6.6）；DSH 包装不收 |
| 显式教学 → 技能草稿 | **`dsh-run2skill` 0.4.0**（MIT，101 星，唯一写明支持 rc.1）：只学明确的纠正 / 长期约束 / 有序工作流 / 「存成技能」四类；逐轮捕获 + 批次边界检测；提案收件箱；不可变版本；写 PROJECT / USER 根、注入 settings UI | **借模式**：托管面不装（工作区不是技能根，profile 只读，settings 命名空间在 `runtimeUiSurface` 禁用面）；四类范围落为 `feedback_events(correction/interjection)` → `distill` → 收件箱 |
| 会话记忆 + 技能结晶 | **`@memtensor/memos-local-plugin` 2.0.18**：进程内 SQLite、每轮 ≤ 3 s 自动召回、`memos_skill_list/get`；反思加权奖励沿轨迹回传结晶技能，candidate / active / archived；无留出门、无审批；数据在 `$DSH_HOME/memos-plugin/` | **对照，另案**（gap-closure #11）；方法权威留在 Postgres |
| 教训 curator | `dsh-plugins/dsh-learn`：`learn_promote` 模型可调用 | **不收**（模型不得自行发布）；stale 30 d / archived 90 d 节奏照借 |
| 文风偏好 | `dsh-plugin-stylotrace`：仓库 404，注入 rc.1 已删的 `dsh-client-runtime` | **不收**；可读偏好表示照借 |
| 其他 | `xskill`（SkillOpt 评测管线）、`dsh-evolution-lab`（隔离候选先评后用）、`dsh-loom`（Gate 不得自改自批）、`dsh-distillery`（纠错对 → SFT / DPO JSONL） | 借模式 |
| 上游 DSH | 无内建技能学习；技能面只读 provider registry；记忆交给 MCP | 不等上游 |

除 run2skill 外没有候选的页面提到 rc.1；凡采用，先对着跑起来的二进制探线再跑自家电池（§16 #25）。

## 4. 数据模型：零新表

### 4.1 方法 = 文档 + 修订

- `documents.kind="method"`，`recordType ∈ {"source-method", "learned-method"}`，`status ∈ {candidate, approved, retired}`；`payload = { frontmatter, body, files?: {"scripts/x.py": text, "tests/test_x.py": text}, learning, provenance }`；`files` 总量 ≤ 64 KB。
- 每次正文改动一条 `revision`；`contentDigest = sha256(frontmatter 规范化 JSON + "\n" + body + files 按路径排序拼接)`；回滚 = 向前保存旧载荷（`pluginService.rollback()` 同款）。
- 正文是 Agent Skills 标准的 `SKILL.md`。

### 4.2 方法 frontmatter（`packages/domain/src/methodSkill.mjs` 校验）

两套规范同时满足：Agent Skills 开放规范（`agentskills.io/specification`：`name` ≤ 64 字符、小写字母数字连字符、不以连字符开头结尾、无连续连字符、**等于目录名**；`description` ≤ 1,024 字符；可选 `license`、`compatibility`（≤ 500）、`metadata`（字符串到字符串的映射）、`allowed-tools`（空格分隔，实验性）；目录 `scripts/ references/ assets/`；正文建议 < 5,000 token、< 500 行、引用只深一层）与 DSH 实际解析的键（`skill-filesystem`：必填 `name` / `description`，可选 `whenToUse`（驼峰，进技能目录的路由提示）、`disable-model-invocation` / `user-invocable`（旧式驼峰键直接报错）、`metadata`（必须是对象）；**`allowed-tools` / `license` / `compatibility` 被忽略**）。所以我们的结构化字段放在两边都合法的位置：

```yaml
name: evidence-preserving-report-repair        # = 目录名
description: >-                                 # ≤ 1,024 字，第三人称，写「做什么」+「何时用」
  Repairs a source-grounded report in place ...
whenToUse: >-                                   # DSH 目录里的路由提示；= applies_when 的一句话
  When a delivered report failed the evidence gate with addressable issues.
allowed-tools: read edit evimed_submit_deliverable   # 规范字段；我们的闭集检查读它
license: internal
metadata:                                       # 字符串值，两边都合法
  role: functional                              # atomic | functional | abstract（标签；层级由依赖推导）
  applies_when: "A previously generated report and an accepted source ledger exist; the gate returned addressable issues."
  not_when: "The cited source is unavailable or does not support the requested correction."
  depends_on: "resolve-claim-to-source-span@sha256:…, enumerate-dependent-numbers@sha256:…"
  derived_from: "run:<runId>, feedback:<eventId>, method:<id>@sha256:…"
  evimed_schema: "method-skill/1"
```

校验器（`validateMethodSkill`）只做代码能判的事：`name` 同时满足规范（≤ 64、无 `--`）与 DSH 正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且等于目录名；`description` 非空且 ≤ `SKILL_AUTHORING_LIMITS.maxDescriptionChars`；`disable-model-invocation` / `user-invocable` 若出现必须是布尔，旧式驼峰键拒绝；`metadata` 是字符串映射且 `evimed_schema` 可识别；`allowed-tools ⊆` 组合注册表（`vendor-community-skills.mjs:123` 的检查抽成 domain 函数两处共用）；`depends_on` 解析为 `name@digest` 列表、无环、每条 digest 可解析；正文 < `maxBodyLines`（500）；引用只深一层；不含绝对技能根（`skillRoots.mjs` 闭集禁词）；不含凭据 / 患者标识（`memoryIntelligence.mjs:18` 的 `sensitivePattern` 抽到 domain）；`files` 只允许 `scripts/` 与 `tests/` 前缀、路径经 `safeId`。语言质量不用代码判。`skills-ref validate` 作为 CI 里的第二道规范检查。

### 4.3 学习载荷（同一文档的 `learning` 字段）

```json
{
  "digest": "sha256:...",
  "counts": { "eligible": 0, "loaded": 0, "invoked": 0, "succeeded": 0, "validated": 0 },
  "observations": [ { "runId": "...", "family": "...", "outcome": "accepted|repaired|rejected", "at": "..." } ],
  "relations": [ { "type": "shared_part|subset|merge|conflicts_with|supersedes", "target": "...", "evidence": "...", "proposedBy": "consolidate:<jobId>" } ],
  "evaluations": [ { "report": "evals/method-quality/reports/<id>.json", "baselineDigest": "...", "verdict": "better|non_inferior|inconclusive|worse" } ],
  "level": 0
}
```

规则：digest 变即计数归零；同一任务的重试、fork、重复调用按 run family 只算一次；`eligible` 在「有资格加载但没被选」时也计一次；`loaded` 来自委派回执 digest；`invoked` 来自转录里 `skill` 工具调用；`succeeded` = 加载了它的运行最终 accepted；`validated` = 独立评测 verdict ∈ {better, non_inferior}。

### 4.4 反馈事件（并行会话实现，载荷形状约定）

`evimed_product.feedback_events{ id, ownerUserId, projectId, runId?, documentId?, eventType ∈ {edit_diff, decision, correction, interjection}, payload, at }`；写入点：`PATCH /api/memory/records`、议程 `decide()`、交付物编辑保存、运行中插话。

### 4.5 一次运行留下的学习回执（`runs.jsonl` 新字段）

`transcript: {path, completeness, bytes, sha256}`、`methodsLoaded: [{name, digest}]`、`methodsInvoked: [{name, digest, seq}]`、`repairRounds: {content, structural}`、`compaction: [{at, seqStart, seqEnd, tokensBefore, tokensAfter, policy}]`。实现见 6.1。

## 5. 作业与预算

| 作业 | 触发 | 输入 | 产出 | 执行体 |
|---|---|---|---|---|
| `distill` | (a) 交付物被采纳且有编辑 diff；(b) 修复回合 ≥ 1 且最终 accepted；(c) 用户纠正 / 插话 | `{runId, feedbackEventIds[], trigger}` | `learned-method` 候选或既有方法的 delta 修订 | 内部能力运行（6.2）；生产者由并行会话先做 (a) |
| `consolidate(action: sleep)` | 每用户每夜一次（谷时），幂等键 `consolidate:<userId>:<date>` | 上次以来的观察 | 关系提议、构建修订、晋升 / 退休提议、反思 | 6.4 |
| `consolidate(action: integrate, methodId)` | 新候选落库 | 候选 + 有界邻域 | 增量整合 | 6.4 |
| `consolidate(action: evaluate, candidateDigest, baselineDigest)` | 候选过初筛；平台 delta 开 PR 前 | 留出 brief 集 | `evals/method-quality/reports/<id>.json` + `learning.evaluations[]` | 6.3.6 |
| `verify` | 回合结束，每个 `gated` claim | 只给来源 | `reproductionMatched` | 并行会话（gap #14） |

- 不加作业种类：`PRODUCT_JOB_KINDS` 是 DDL 的 CHECK 约束，`consolidate` 按 `payload.action` 分流。
- 需要模型的步骤一律以**内部能力运行**执行（`visibility: internal`，`SourceUnderstandingRuns` 同形派发）：计量、路径守卫、沙箱、回执免费适用；控制面 worker 不直连供应商。
- 幂等键 `(ownerUserId, projectId, runId, kind, action, extractorVersion)`；租约 / 尝试上限沿用 `ProductJobs`。
- 预算：作业派发的每次运行带 `runLimit` 进 `reserveModel`；日 / 周上限 `OPEN_SCIENCE_LEARNING_DAILY_LIMIT` / `_WEEKLY_LIMIT`；余额为零只停学习。谷时半价（`OFF_PEAK_MULTIPLIER`）是把学习排在夜里的经济理由。
- 单机：与生产同机（15 GB），并发 ≤ 2、谷时窗口 `OPEN_SCIENCE_LEARNING_WINDOW=22:00-09:00`、断点续跑。
- 失败可见：作业终态 + 原因码；不改已交付运行的状态。

## 6. 实现规格

每小节：目标 → 改动点 → 流程 / 算法 → 测试 → 验收 → 参考。

### 6.1 转录抓取与学习回执（WP0）

**目标**：一次完成的运行留下完整、可重放的 episode；五个计数与压缩效果能从账本算出。

**改动点**

| 文件 | 改动 |
|---|---|
| `apps/server/src/server.mjs:844-854` | `sessionMessages` 改为 `sessionTranscript`（含 `subagents`、`lastSeq`）；对 `transcript.subagents[]` 逐个再取子会话转录；交给新模块落盘；`recordRun` 继续吃 `messages` |
| 新 `apps/server/src/runTranscripts.mjs` | `persistRunTranscript({project, run, transcripts}) → {path, completeness, bytes, sha256, missing[]}`：写 `project.metaDir/transcripts/<runId>.jsonl`（第一行 header，其后每条 `TranscriptMessage` 加 `sessionId`）；`readRunTranscript(project, runId)`；保留策略 `OPEN_SCIENCE_TRANSCRIPT_RETENTION_DAYS`（默认 90，项目删除级联） |
| `apps/server/src/agentRuns.mjs` | 新事件 `learning`（fold 进 `transcript` / `methodsLoaded` / `methodsInvoked` / `compaction`）；修复循环在增加 `clinicalRepairAttempts` / structural 处追加 `repair` 事件 `{round, kind, issues}`，fold 为 `repairRounds` |
| `packages/socket/plugins/run-policy.mjs:568-598` | 委派回执除 `skills: injected` 外增 `skillDigests: [{name, digest}]`（注入时对正文求 sha256）；胶囊方法同样 `methods: [{name, digest}]` |
| `packages/socket/plugins/capsule.mjs:121-138` | `loadMethods` 为每份 SKILL.md 计算 digest，随 `evimedCapsuleMethods` 一起提供 |
| `packages/domain/src/runMirror*.mjs`（`evimed_run@1` 投影） | 子代理条目加可选 `skillDigests` / `methods`（加字段不升版本） |
| `apps/server/src/dshEventPump.mjs` | 把 `compaction/start|summary|end`（seam-manifest 已列为观察缝）解码为 `learning` 事件写账本；token 数取事件用量，缺则由转录 `usage` 差分补算 |
| `apps/server/src/memoryIntelligence.mjs:410` | 硬编码 3 改引 `MEMORY_PROMOTION_MIN_OCCURRENCES` 并补 `MIN_RUNS`（并行会话已认领） |

**转录文件格式**（`transcripts/<runId>.jsonl`）

```json
{"schemaVersion":1,"runId":"…","capturedAt":"…","completeness":"complete|partial|unavailable",
 "sessions":[{"sessionId":"…","parentSessionId":null,"label":"root","capability":null,"lastSeq":4210,"throughSeq":4210,"pages":3,"truncated":false}],
 "missing":[{"sessionId":"…","fromSeq":1200,"reason":"page_bound|history_unavailable|child_unreadable"}]}
{"sessionId":"…","role":"assistant","source":"user","seq":12,"time":…,"turn":1,"step":3,"parts":[…],"usage":{…},"interrupted":false}
```

`complete` 当且仅当每个会话 `throughSeq === lastSeq` 且无页触到 64 MiB 界；单文件上限 64 MiB，超出即 `partial(size_bound)`；历史取不到即 `unavailable` 并保留 `historyError`。`partial` / `unavailable` 的运行**不得**进入评测正样本。

翻页协议（上游 `session/page`）：请求 `{address: {kind:'session', sessionId} | {kind:'subagent', parentSessionId, childSessionId}, throughSeq, beforeSeq?, maxMessages?}`，`maxMessages` 默认 50，按消息数向前切页、保持每条消息的 `sourceEventSeqs` 组完整，返回 `{records, hasMore}`；上游**没有字节上界**，64 MiB 是我们自己的守卫。`throughSeq` 取自 follow 流的开场帧——这正是 `sessionTranscript()` 今天的做法，抓取只是把它落盘。兜底：DSH 的会话日志本身在 `$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v2.jsonl[.zstd]`（首行 header，其后逐事件；默认 zstd 帧），位于每项目的 `/runtime` 挂载上、容器退出后仍在；若将来要从磁盘恢复，须把该格式登记进 `seam-manifest.json` 并配契约测试，本期不做。

**`methodsInvoked` 归因**：转录里 `tool === "skill"` 的调用，`input.name` 映射到加载表的 digest；预注入正文（委派）不会产生调用，故 `loaded` 与 `invoked` 分开记，不互相推断。

**测试**（`apps/server/test/runTranscripts.test.mjs`）：父 + 两子完整；子会话取失败 → `partial(child_unreadable)`；页界 → `partial(page_bound)`；容器已死 → `unavailable`；账本回执存在且 sha256 与文件一致；项目删除后文件消失；变异对照：删掉子会话循环即红。回执测试：注入两份技能 → 回执含两条 digest；同名不同正文 → 不同 digest。

**验收**：一次真实运行导出完整 episode 或精确的 partial 诊断；`counts` 五项可由账本 + 转录算出。

### 6.2 `method-distillation` 内部能力与 domain 校验器（WP1）

**目标**：EvoDS ASA 的「合成」与 SkillPyramid 的「技能创建」：从一次运行与反馈里提出**一条**方法候选或对既有方法的 delta，先检索后提议，代码核验后落库为 `candidate`。

**改动点**

| 文件 | 改动 |
|---|---|
| 新 `capabilities/method-distillation/capability.yaml` + `SKILL.md`（四处副本按既有机制） | `visibility: internal`；`skills: [method-distillation]`；`tools: []`；`produces: [{contractKind: method-candidate, outputs: [SKILL.md(required), method-candidate.json(required), distillation-notes.md(optional)], checks: [requiredOutputsExist, skillsLoaded]}]`；`inputs.required: [distillationInput]` |
| 新 `packages/domain/src/methodSkill.mjs` | `parseSkillFrontmatter(text)`、`validateMethodSkill({frontmatter, body, files, mountedTools, resolveDigest}) → {ok, issues[]}`、`methodContentDigest(payload)`、`methodLevel(method, resolve)` |
| `packages/domain/src/contractRegistry.mjs` | 注册契约种类 `method-candidate`：校验 `method-candidate.json` schema + 用 `validateMethodSkill` 校验 `SKILL.md`——**运行侧 `evimed_submit_deliverable` 与控制面同一实现**（`clinicalEvidenceSingleImplementation.test.mjs` 同款单实现测试） |
| 新 `apps/server/src/methodDistillationRuns.mjs` | `MethodDistillationRuns({dispatch, readResult})`，`execute({job})`：组装 `distillation-input.json` → dispatch（`dispatchId = sha256(runId + trigger + extractorVersion)`）→ `readResult` → 校验 → 写 `documents(method)`（create：新 id、revision 1；amend / merge：目标方法新 revision，`status` 回到 `candidate` 并计数归零）→ 收件箱通知 → `consolidate(action: integrate)` 入队 |
| `apps/server/src/learningWorker.mjs`（新） | 认领 `distill` 与 `consolidate`；谷时窗口；并发 ≤ 2 |

**`distillation-input.json`（冻结输入，写进运行工作区）**

```json
{"schemaVersion":1,"trigger":"edit_diff|repair_accepted|correction","capabilityId":"…","runId":"…",
 "transcriptExcerpts":[{"sessionId":"…","seqRange":[…],"messages":[…]}],
 "feedback":[{"eventType":"edit_diff","payload":{"before":"…","after":"…","path":"…"}}],
 "repairIssues":[{"round":1,"code":"…","message":"…"}],
 "relatedMethods":[{"id":"…","digest":"…","frontmatter":{…},"body":"…"}],
 "authoringLimits":{"maxBodyLines":500,"maxDescriptionChars":1024,"minTestScenarios":3},
 "mountedTools":["read","edit","…"]}
```

清洗规则：工具输出按 `TOOL_RESULT_PRUNER` 取头尾；凭据 / 患者标识经 `sensitivePattern` 剔除；`restricted` 来源正文一律不入；只放与触发相关的 seq 区间（编辑 diff 对应的交付物写作区间、修复回合区间、纠正前后各 N 条）。

**SKILL.md（`method-distillation`）的流程要点**

1. 按触发类型归纳：编辑 diff → 「什么偏好 / 方法解释了这次修改」（PRELUDE / CIPHER 式，规格 §27.4 回路 2）；修复回合 → 把失败模式归纳为坑 / 检查项 / 步骤修订（ACE 的 Reflector：`error_identification / root_cause_analysis / correct_approach / key_insight`）；纠正 / 插话 → 抽取显式规则（run2skill 的四类范围）；跨 ≥ 3 条成功轨迹的例程归纳 → AWM 的归纳指令原样移植：「找出多条任务共有的重复动作子集，各抽成一个工作流；每个工作流 ≥ 2 步；不生成相似或重叠的工作流；把非固定元素（输入文本、按钮字串）换成描述性变量名，保留跨任务不变的元素（如工具名、字段 id）」，步骤按 AWM 的三件套写（当前状态描述、推理、动作）。
2. 先读 `relatedMethods`，决定 `operation ∈ {create, amend, merge, no_change}` 与 `baseDigest`；重复观察只强化既有版本，不造近重复。
3. 写 SKILL.md：Agent Skills 作者规范（第三人称 description、做什么 + 何时用、正文 < 500 行、引用只深一层），frontmatter 按 4.2；≥ 3 个测试场景取自本人运行；`applies_when` / `not_when` 必填。
4. 写 `method-candidate.json`：`{operation, baseDigest, targetMethodId?, evidence:[{runId, seqRange, quote}], applicability, counterexamples, risk:{touchesSafety, widensTools}, testScenarios:[…]}`。
5. `evimed_submit_deliverable` 直到 ok（契约即校验器）；不写医学结论，不写工具名之外的能力。

**初筛（进入 `evaluate` 的条件，不是生成条件）**：触发 (a)/(c) 有用户显式信号，一次即可生成候选并进入评测队列；触发 (b) 的候选需 `observations ≥ METHOD_INDUCTION_MIN_TRAJECTORIES` 且跨 `≥ MEMORY_PROMOTION_MIN_RUNS` 个 run family 才排评测（EvoDS 的 τ 用在这里：**花评测预算的门槛**，不是有效性证明）。

**测试**：domain 校验器每个 issue 码一正一负；契约单实现测试；runner 用假 dispatch：create / amend / merge / no_change 四路、候选校验失败 → 作业 `failed(method_candidate_invalid)` 且不落库、同一 run 重复入队幂等；生成永远不能置 `approved`（断言）。

**验收**：一个真实事故族（如 9/7 五次临床综述失败）产出一个候选 delta，带来源 run id，代码核验全过。

### 6.3 评测扩建：brief 生成器、录制网关、配对 runner（WP2）

**目标**：ToolVerse 的训练场——可批量生成、可重置、可独立评分的长程工具任务——建在既有评测资产之上。

#### 6.3.1 工具依赖图（TDG）

新 `scripts/dev/build-tool-graph.mjs` → `evals/tool-graph/tdg.<capability>.json`（每能力一张图，可按 ToolVerse 的做法为不同流程再生成 2–3 张）：

- 节点：`capabilities/*/capability.yaml` 的 `tools[]` ∪ MCP `tools/list`（`runtime/mcp/evimed-research`）的 27 个工具 ∪ 内核工具（read / edit / bash …）；每个节点 `{name, description, inputSchema, outputSchema, typeTags}`，`outputSchema` 从 MCP 工具的返回结构与 domain 的产物契约推导（ToolVerse 靠改写工具规范强制 `response` 字段；我们的 MCP 工具已返回结构化 JSON），`typeTags` 从参数名 / 描述归一：`pmid`、`doi`、`nct_id`、`drug_name`、`mesh_term`、`file_path`、`dataset_path`、`source_id`。
- 边：两类（沿用 ToolVerse 定义），三种来源逐条记：`type ∈ {parameter, semantic}`——参数依赖 = A 的输出可作 B 的必需参数；语义依赖 = 场景逻辑上 A 先于 B；`via ∈ {schema, model, executed}`——(i) `schema`：输出字段类型 = 输入参数类型（只能给参数边）；(ii) `model`：Flash 读两份 schema 提议边、类型与置信分；(iii) `executed`：录制模式真跑一次代表性链证实。**只有 `executed` 证实的边参与采样**；其余保留为 `unverified`。
- DAG 清洗（ToolVerse B.2 的规则）：从零入度节点拓扑遍历，只保留当前偏序可达的边；遇环删最低优先级边——参数边优先于语义边；同级按置信分；无置信分先删语义边，再删「删后新解锁节点最多」的边。
- 边属性：`{from, to, type, via, confidence?, validatedBy: runId|null, stateEffect: none|writes_workspace|writes_ledger}`。

#### 6.3.2 解锁采样（DUS 的落法）

ToolVerse 的 Algorithm 1 原样实现（`packages/domain/src/toolGraphSampling.mjs`，纯函数，可测）：

```text
D[v] ← 入度(v)；Q ← {v | D[v] = 0}；T ← []
while Q ≠ ∅:
  k ← min(|Q|, N)；S_t ← Sample(Q, k, seed)；Q ← Q \ S_t；T.push(S_t)
  for u in S_t: for v in 后继(u): D[v] -= 1；if D[v] = 0: Q ← Q ∪ {v}
return T          # 每个 S_t 是一轮任务；T 是任务链
```

- 阶段数由图的层数决定，唯一旋钮是 `N`（初值 2，实测后调）；`Sample` 均匀采样、带 seed；反复采样直到覆盖能力子图内尽量多的工具（覆盖率写进生成报告）。
- 一个「数据项」= 一个环境（fixture 集 + 工具子图）+ 3–7 个递进任务（同一 fixture 上由短到长；目标均值 ≈ 4，对应 GUST 的 3.8）；每图采 5 个任务，每环境最多 10 个。
- 课程：生成器按阶段数输出，评测集与后期训练集共用同一课程（EvoDS 的 4 → 20 轮在本平台对应任务链长与修复回合）。

#### 6.3.3 任务合成与验证（「逆向上下文重建」的落法）

新 `scripts/dev/generate-briefs.mjs`：

1. 输入：TDG、能力清单、链规格、fixture 目录（录制响应 + 工作区种子文件）。
2. **先执行、后写题**：按拓扑序在录制环境里逐个实例化调用——依赖参数从上游输出复制，情境参数从 fixture 里取合法值（真实 PMID / DOI / 数据集字段），状态变更（工作区文件、来源台账）立即同步——得到可执行序列即金轨迹 `goldenTrace: [{turn, tool, args, returnDigest, outputKeys}]`（轮内允许依赖相容的任意顺序）。
3. Pro 由金轨迹 + 工具定义 + 入边生成 brief（既有 schema `{id, title, why, inputs, mustDo, mustNotDo, gradedOn}` + `generated: {tdgVersion, chain, stages, seed}`），要求：**隐含依赖**（题面说高层目标，不列步骤）、**信息缺口**（早期缺参数时代理需说明假设——托管面不追问，写进 clarifications）、**一致性**（题面意图与最后一个工具的产出一致）。
4. **可解性验证**：(a) 金轨迹在录制环境重放成功；(b) 教师通过率过滤——用生产模型在录制模式经 `POST /api/agent-runs/dispatch` 跑 3 次（ToolVerse 用 Pass@8），至少一次契约通过且确定性检查通过才收；否则重生成最多 2 次后丢弃。
5. 隐藏产物 `evals/<capability>/hidden/<id>.reference.json`：`{goldenTrace, expectedArtifacts:[{path, sha256?|schema}], deterministicChecks:[…]}`；`grader.json`：`{contractKind, checks, judgeRubricVersion}`。`hidden/` 不进运行时镜像、不进 `distillation-input`、不进任何提示（测试断言）。
6. 难度变体（对合法 brief 的确定性变换）：缺字段（期望：报告缺失而非编造）、来源不可用（fixture 返回 503，期望：`recoverable` 错误码处理与说明）、标识符冲突、并行前置、晚到纠正（第 k 轮再发一次 `session/prompt`；托管面运行中追加提示是否受支持需核，**V-1**）。
7. 评分：只看终态与可核产物；等价的不同调用顺序都算过；不奖励更多工具调用、不奖励自述成功、不奖励复刻金轨迹。

先补 7 个零 brief 能力（adr-analysis、bibliometric-analysis、dataset-research-scoping、mendelian-randomization、meta-analysis、off-label-analysis、peer-review）各 ≥ 3 份人工审过的 brief，再由生成器扩到 100–200 份、8–12 个任务族。

#### 6.3.4 录制响应网关（三档保真的第二档）

- 控制面网关（`publicSourceGateway.mjs`、证据网关）：`OPEN_SCIENCE_GATEWAY_FIXTURES=<dir>` → 以 `sha256(method + url + body)` 取 fixture；缺失即 `599 fixture_missing`，**绝不回退到真网**；`OPEN_SCIENCE_GATEWAY_RECORD=<dir>` 在真跑时录制。
- MCP 直连的 keyless 工具（27 个里 16 个直连公共源）：`EVIMED_MCP_FIXTURES` 环境变量 → MCP 服务器的 HTTP 会话包装同一键法；两处同一目录布局。
- 第一档 = MCP Python 单测与 domain 验证器测试（已有）；第三档 = `audit:capabilities` 的在线探针（已有，14 天新鲜度）。

#### 6.3.5 配对评测 runner

新 `evals/method-quality/run_paired.py`（与 `outputs/audit/scripts/` 的批测台同一 RESUME 习惯）：

- 配置：`{baseline:{methodSnapshot, compactionPolicy}, candidate:{…}, briefs:[…], repeats:3, seed, concurrency:2}`。
- 每例：登录 → 建项目 → 上传 fixture → 设定方法快照（私有方法经 `PATCH /api/memory/records` 置 `approved` / `retired`；平台技能经镜像内的技能根，测试用 `EVIMED_CAPABILITY_SKILLS_DIR` 指向候选树）→ `POST /api/agent-runs/dispatch` → 轮询 `GET /api/agent-runs` → 取产物、账本回执（`methodsLoaded` digest、`repairRounds`、token、成本、`compaction`）→ 评分 → 每例一文件落盘（重跑跳过）。
- 评分器：契约裁定（账本里已有）+ `hidden/*.reference.json` 的确定性检查 + 裁判（`open-domain-answer-quality/judge.py` 形态：`JUDGE_PROMPT_VERSION`、全新上下文、隐藏参考不给被测运行、越界分数拒收）。
- 报告 `reports/<id>.json`：七维向量的配对差、按任务族聚类的 bootstrap 区间、预注册边际、verdict ∈ {better, non_inferior, inconclusive, worse}、成本与时延、`turnCoverage` 诊断。
- 留出登记 `evals/method-quality/splits.json{dev, holdout, regression, chronological}`；测试断言 `distillation-input` 里出现的 brief id 不在 holdout。

#### 6.3.6 `evaluate` 作业

`consolidate(action: evaluate)` 调 `run_paired.py`（子进程，预算由作业 `runLimit` 约束），把报告路径与 verdict 写回候选的 `learning.evaluations[]`，并向收件箱发一条 `notify`。

#### 6.3.7 TARA 的数据侧

评测报告里的 `turnCoverage`：按金轨迹逐轮做工具名 + 参数字典级匹配，只作诊断列（哪一轮开始走偏）；不做奖励。训练阶段（6.8）再用同一数据做 TARA。

**测试**：TDG 构建（schema 边、模型边不参与采样、executed 边参与）；生成器（参考解失败即丢弃；hidden 不泄漏）；录制网关（缺 fixture 即 599、不出网）；runner（RESUME、并发隔离、环境错误与代理失败分开计）。

**验收**：A vs B 一次配对评测报告含不确定性；重复重置得到相同确定性评分。

### 6.4 `consolidate`：睡眠期巩固与技能金字塔（WP4）

**目标**：规格 A3–A4 的巩固作业 + SkillPyramid 的分析器 / 构建器 / 增量整合，作用于 `documents(method)`；平台技能的同一分析产出 PR 提案（6.6）。

**改动点**：`learningWorker.mjs` 的 `consolidate` 分支；新 `apps/server/src/methodConsolidation.mjs`（步骤编排，纯函数尽量进 domain：`packages/domain/src/methodGraph.mjs` 的 `validateMethodGraph`、`methodLevel`、`promotionVerdict`、`retirementProposal`）；关系分析与构建的模型步骤各是一次内部能力运行（`capabilities/method-relations/`，`visibility: internal`，产出契约 `method-relations`）。

**方法正文模板**（SkillPyramid 的分节，与 Agent Skills 兼容；`method-distillation` 与构建器都按它写）：`## Purpose` / `## When to Use` / `## Inputs` / `## Workflow` / `## Verification` / `## Constraints` / `## Output`；复用引用写在受影响段落附近：`[reuse method: <name> | when: <trigger> | provides: <capability>]`，并在 frontmatter `depends_on` 钉 digest（论文的 `ρ(a_k) = (n_k, q_k, w_k, o_k)`：名字、标识、复用条件、提供的能力——`q_k` 在我们这里就是 digest）。

**`sleep` 流程**

1. 收集：上次以来的运行回执、反馈事件、候选与已生效方法、`learning.counts` 增量（从转录归因 `invoked` / `succeeded`）。
2. SCREEN（粗筛，Flash）：只看 `name + description`（+ 可选 `embedding` 相似度，`DEDUP_SEMANTIC_COSINE`）把方法分成候选组，输出 `{selected: [...], rejected: [...]}`；每组 2–8 条。
3. DECIDE（细分析，每组一次 Pro 内部运行，工具 = 读组内全文）：输出 `ASSIGNMENT / SKILLS / RELATION_TYPE / REASON`；关系类型沿用论文定义并加两条我们需要的：`shared_part`（共享一个具体子能力、各自仍有实质任务逻辑；不得用于模糊主题相似）、`subset`（严格子方法，宽者多出流程 / 约束 / 情境）、`merge`（触发、输入、流程、输出近乎等价）、`abstract_pattern`（同侪共享更高层解题模式）、**`conflicts_with`**（同情境给出相反做法）、**`supersedes`**（新版本在同情境下更完整）。分析器的分配对构建器是权威。
4. 构建（每个分配一次 Pro 内部运行 + 代码后处理）：`shared_part` → 抽出共享操作为原子候选（必须比每个源方法都窄），每个源方法提议一条 amend 修订——共享段改为复用引用、`depends_on` 加原子 digest；`subset` → 只改宽者，把重复实现处替换为对窄者的引用；`merge` → 一个保留所有有用不冲突细节的规范候选，源方法提议 `retired` 并记 `supersedes`；`abstract_pattern`（≥ 3 个 functional）→ 抽象候选（`role: abstract`，`derived_from` 指向组内方法，不进 `depends_on`，「只总结组合，不成为可执行合并体」）；`conflicts_with` → 只写关系与 notice，不改任何一方，等用户裁决（收件箱 `question`）。硬规则进校验器：保留源方法的流程、约束、边界情形与验证检查（改写前后 `## Verification` / `## Constraints` 条目集合只增不减）；只在受影响段落附近加引用；不得发明工具（闭集）、脚本、文件、依赖；改写后仍是可独立阅读的 SKILL.md。所有构建产物都是**新 revision 的 `candidate`**，原修订不动。
5. 层级：`level = 0` 无依赖，否则 `1 + max(level(dep))`；`role` 只是标签；UI 的金字塔 = 按 level 分层显示。
6. 晋升（domain 纯函数 `promotionVerdict`）：显式来源（用户确认 / 用户 SOP）→ `approved`；推断来源需同时满足 `observations ≥ METHOD_INDUCTION_MIN_TRAJECTORIES` 跨 `≥ MEMORY_PROMOTION_MIN_RUNS` runs、最近一次 `evaluate` verdict ∈ {better, non_inferior} 且 `baselineDigest` 仍为当前基线、无未决 `conflicts_with`；满足即 `approved` + 收件箱 notice（可一键回滚），不满足则留 `candidate` 并写明缺哪一条。
7. 退休提议（A4）：`utility = f(invoked, lastInvokedAt, feedback)`，强度按 `MEMORY_STRENGTH_TAU_DAYS` 衰减；低效用且有已验证替代 → 提议 `retired`（notice），低频但安全相关不提议；牵涉已确认事故 → 立即 `retired`。
8. 反思（A3.4）：近期观察累计重要度超 `MEMORY_REFLECTION_IMPORTANCE_THRESHOLD` → 一条更高层洞见进胶囊时间轴 `reflection`。
9. 写回：修订 + `learning.relations` + notices；不删任何历史。

**`integrate` 流程**（新候选落库时，论文 §2.4）：以候选为查询，取有界邻域（名称 / 描述相似 top-20），只对邻域跑步骤 2–5；`P_{t+1} = Update(P_t, ŝ, ΔP_t)` 在我们这里就是「一批新 revision + 关系」，既有层级不重算。

**创建器的两阶段在本平台的位置**：SkillPyramid 的 FRAMEWORK_CONSTRUCTION（先用抽象技能搭结构）→ DETAIL_INSTANTIATION（再用原子技能填操作）正是 `method-distillation` 写 SKILL.md 的顺序（6.2 第 3 步），也是装配器的选择顺序（≤ 1 个 abstract 给结构，≤ 3 个 functional 给流程，所需 atomic 给操作）。

**测试**：`validateMethodGraph`（成环、digest 不可解析、多父合法）；`promotionVerdict` 真值表（τ 未满、runs 未跨、digest 变更归零、verdict 过期、冲突未决、显式来源直通）；构建器改写只动引用行、其余字节不变；退休不删安全相关；B vs C 配对评测。

**验收**：层级的检索 / 组合收益被测出；不能合并不兼容的医学或统计情境；一条推断方法从候选到生效的每一步都有 notice 与回滚目标。

### 6.5 上下文策略：EvoDS ACC 的落法（WP5）

**目标**：从「超 N token 就截」变成有目标、有反馈、有评估的压缩；管理者与子代理各有摘要机制；策略可迭代。

**第一步 · 测量**（随 WP0）：`compaction` 回执 + `evals/context-fidelity/report.py`：每周统计压缩次数 / 运行、`tokensBefore → tokensAfter`、压缩后续做成功率（压缩过的运行 accepted 比例）、context-overflow 错误数、摘要调用成本与缓存命中变化。没有分布不改策略。

**第二步 · 结构化任务状态包**：摘要器不复述内容，先保住**句柄**——`task-plan.json`（计划权威）、`.evimed-run/state.json`（投影）、`.evimed-sources/` 台账（源 id / 引用位置 / 访问等级）、`deliverables/` 路径与 digest、当前修复问题、`methodsLoaded` digest、预算余量——固定成一段「STATE HANDLES」，再对被压缩区间写自由摘要。自由摘要的指令直接移植 EvoDS 的摘要提示词（许可已有）：不复述题面（DSH 的压缩本来就保留系统提示与题面，只替换区间）、不调工具；纳入环境信息、数据信息、决定与结论、中间结果、工具用法与格式约定；排除客套、被取代的信息、无信息量的失败尝试（但保留揭示约束的失败）；输出编号列表，每条自足、精确、单一信息。与 EvoDS 的差别：它的摘要**整体替换**历史，DSH 是**区间替换为一个摘要节点**并保留工具调用配对——我们沿用 DSH 的方式，不另写整体替换。保不住的句柄返回具名压缩失败（`compaction_handle_lost`），不编造；旧摘要是导航，不是来源，不能变成新引用。

**子代理摘要按全局目标蒸馏**（EvoDS `õ_t = φ(o_t | G)`）：委派子代理返回父代理的文本必须是「按父任务目标的摘要」——成功 → 关键结果与产物路径，失败 → 失败原因与错误模式——细节写文件；这条写进 `evimed_delegate` 的子代理指令与 `buildDelegation` 的结果上限（≤ 1,500 token，超出改为「已写入 <路径>」）。

**第三步 · provider 换实现**

| 文件 | 改动 |
|---|---|
| 新 `packages/harness-port/src/compaction.mjs` | `class EvimedCompactionEngine extends BasicCompactionEngine`：只覆写 `summarize(input, agent, signal)`：组装状态包（经 `evimed_run` 存储域读投影，不直接读文件）→ `summarizeWithLlm(ctx, config, {system, tools, messages: [...input.messages, packet]}, agent, signal)` → 确定性检查每个句柄是否仍在摘要中 → 缺则带更严格指令重试一次 → 仍缺则回退 `super.summarize` 并发 `compaction/policy-degraded` 观察事件。港口只 import 钉版包；`seam-manifest.json` 把 `dsh-compaction-basic` 从 `config-row` 改为 `provider-base`，加一条 seam probe：`summarize` 仍是受保护钩子、`summarizeWithLlm` 仍导出 |
| `packages/socket/presets/evimed-universal/agent.cordis.yml:187-188` | `compaction` isolate 组内把 `compaction-basic` 行换成挂 `EvimedCompactionEngine` 的行；配置 `thresholdRatio` / `retainRatio` / `modelPolicies` 全部 `!!js process.env.EVIMED_COMPACTION_*`，由控制面 `config.mjs` 单点派生（§10.4）；不挂两套引擎（一致性套件断言） |
| `apps/server/src/config.mjs` / `runtimeManager.mjs` | `OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY=basic|structured`、阈值与保留值；`contextWindow` 改为按模型声明真实值（今天的 1,000,000 是压力触发永不发生的原因之一） |

不动的：上游的压缩锁、工具调用配对、取消、token 计量、替换节点写法。

**管理者的摘要工具（EvoDS 的 Manager 专属工具）**：上游文档与源码都写死了——`compactNow` 经 `agent.runMaintenance` 只在真正空闲阶段运行，代理活动中同步抛错并转成 `ManualCompactionError('busy')`；工具在 `step/start → tool/call → step/end` 之内执行，所以**模型不能在步内直接压缩**。压力压缩的位置是 `agent/pre-step` waterfall（可拒绝一步或替换进入该步的消息）。落法：`run-policy` 插件加工具 `evimed_compact_request{reason}`，只置运行状态里的请求标记；`EvimedCompactionEngine` 在 `agent/pre-step`（基础引擎自己的压力检查点）看到标记即对 `[首个可压 seq, 最近平衡 seq]` 调 `compactRegion(start, end, agent, signal)` 并清标记（该方法「拒绝活动中、缺失、倒序或不平衡的区间」，边界用 `toolPairingBalancedBefore / After` 取）。**探针 V-2**：`compactRegion` 在 pre-step 内可否调用需活线核实；核实前此工具不启用，模型的请求只作 notice 记录。

**触发点的起点**：EvoDS 的操作点是 24,576 token 强制摘要、20 步上限；我们今天的等效阈值是 800K（永不触发）。候选网格 `{32K, 64K, 128K}` × `retainRatio ∈ {0.16, 0.3}`，由第一步的测量与费用曲线定，不照抄。

**「可学习」的含义**：不训练触发策略。`evals/context-fidelity/` 长上下文用例（9/7 五次 41–61 分钟失败运行的工作区已保留，直接作种）+ 对 `{阈值, retainRatio, 模板变体, 句柄集}` 的离线网格搜索 → 按能力选默认 → 作为策略版本发布。后期（6.8）用 EvoDS 的 SFT 流水线训练摘要器时，训练目标就是「句柄保全 + 续做成功」；EvoDS 的 SFT 数据里 64 行摘要调用 + 58 行续段就是这类样本的形状。

**测试**：假 llm 的摘要器单测（句柄全保 / 缺一个 → 重试 / 仍缺 → 回退 + 降级事件）；preset 一致性（只挂一个引擎）；seam probe；录制模式下的长上下文 e2e；`TOOL_RESULT_PRUNER` 常量与 preset 行绑定测试（顺手把无绑定镜像修掉）。

**验收**：续做成功率或总费用改善且保真非劣；无第二套引擎、无 port 之外的上游 import。

### 6.6 平台手册回路：L2 + SkillOpt（WP6）

**目标**：把 8 月「30 份交付 → 104 条发现 → 规则」的手工流程做成常态作业：真实运行是 Generator，模型是 Reflector，代码是 Curator，SkillOpt 是优化器，PR 是发布。

**输入**：每能力每周的门禁裁定（`verification`）、修复回合与 issue 码、裁判 notice（`qualityNotices`）、被退回交付物、用户纠正。

**经验条目格式（ACE 的落法，文法照抄 ACE 参考实现）**：能力 SKILL.md 尾部一节 `## 经验条目（自动维护）`，子节按 ACE 分为 `### 策略与洞见 / ### 常见错误 / ### 情境线索 / ### 其他`，每条一行：`- [E-<capability>-<n>] helpful=0 harmful=0 :: <内容>`（ACE 的行文法 `[id] helpful=X harmful=Y :: content`，正则可解析）。三个角色：Generator = 真实运行（回执里记本次在场的条目 id）；Reflector = 一次 Pro 内部运行，按 ACE 的输出结构给出 `error_identification / root_cause_analysis / correct_approach / key_insight` 与 `bullet_tags: [{id, tag: helpful|harmful|neutral}]`；Curator = **代码**：按 id 去重、计数器原地更新、新条目分配新 id 追加（ACE 参考实现只做 ADD，我们加 MERGE：嵌入相似度 ≥ `DEDUP_SEMANTIC_COSINE` 的条目由模型合并、保留首条 id、计数相加，与 ACE 的 `BulletpointAnalyzer` 同法）；只在该节内增删改。契约节与「必须」句在自动 PR 里**不可修改**（校验器拒绝自动 PR 触碰自动维护节之外的内容）。这一段就是 Dynamic Cheatsheet 式「整篇重写」被 ACE 替换掉的原因：整篇重写会丢掉未被显式复制的内容（上下文塌缩），条目化 delta 不会。

**优化器（SkillOpt 的落法，接口已核）**：SkillOpt 的核心是 `EnvAdapter` + `ReflACTTrainer`——任务集与打分都是**Python 回调**（`rollout(env_manager, skill_content, out_dir) → [{id, hard: 0|1, soft: [0,1]}]`，反思读 `<rollout_dir>/predictions/<id>/conversation.json`），优化目标是一份 Markdown（`env.skill_init` → `best_skill.md`）；编辑是有界操作列表 `Edit{op ∈ append|insert_after|replace|delete, target: 逐字锚点子串, content}`（不是行号、不是 JSON Patch；`replace` / `delete` 要求 `target` 在文中唯一出现），落在 `<!-- SLOW_UPDATE_START/END -->` 与 `<!-- APPENDIX_START/END -->` 保护区内的编辑一律 `skipped_protected_region`；「文本学习率」= 每步最多编辑数（默认 `learning_rate: 4`，`min 2`，cosine 衰减，超预算时由优化器 `rank_and_select`）；门是纯函数 `cand_score > current_score → accept | accept_new_best`，否则 `reject`（`gate_metric hard|soft|mixed`）；被拒编辑随 `score_before / score_after` 进「step buffer」喂回下一步提示；epoch 末做纵向对比（上一 epoch 技能 vs 当前，逐项 improved / regressed / persistent-fail / stable-success）生成慢更新指导，另有跨 epoch 的 meta-skill 记忆。后端支持 `openai_compatible`（`model.optimizer_backend=openai_compatible model.optimizer=deepseek-chat`，端点可指向我们的模型网关）。

两条接入路，都不用它的 DSH 插件（那是交互式会话里经 `ctx.shell` 起 Python 的 7 个工具，且 `source` / `backend` 枚举不含 DSH）：

- **夜间小步（默认）**：`skillopt_sleep` 的 Python API `run_sleep_cycle(cfg, seed_tasks=[TaskRecord…], backend=EvimedBackend())`——收割换成我们的转录（`TaskRecord{id, project, intent, context_excerpt, attempted_solution, outcome ∈ success|fail|mixed, reference_kind ∈ exact|rubric|rule|none, reference, judge, tags, source_sessions, split, origin}`，或写成 `skillopt_sleep.tasks.v1` 任务文件），重放换成我们的评测：`Backend` 契约只有五个方法——`attempt(task, skill, memory)` = 在录制模式派发一次运行、`judge(task, response) → (hard, soft, note)` = 契约 + 确定性检查 + 裁判、`reflect(failures, successes, skill, memory, edit_budget) → [EditRecord{target: skill|memory, op: add|delete|replace, content, anchor, rationale}]` = 一次 Pro 内部运行、`tokens_used`。`handoff` 后端是给交互式代理会话逐轮答题用的，不是我们的形态。配置沿用其默认：`val_fraction 0.34`（留出集按 `sha256(seed + task.id) % 100` 切，≥ 2 个真实任务才开门，否则 `holdout_leaked → reject_unverified`）、`edit_budget 4`、`gate_metric mixed`、`gate_no_regression true`（任一留出任务退步即拒，缺结果按退步算）、`max_tasks_per_night 40`、`max_tokens_per_night 400_000`、`redact_secrets true`。产物：`.skillopt-sleep/staging/<夜>/{manifest.json, proposed_SKILL.md, report.json, diagnostics.json, evidence.jsonl}`；`report.json` 含 `baseline_score / candidate_score / accepted / gate_action / edits / rejected_edits / gate_trials`，`evidence.jsonl` 逐事件（`gate/baseline`、`gate/trial`、`gate/decision`、`reflect/edits_returned`…）——直接作 PR 附件。`auto_adopt` 保持 false：采纳在我们这里就是开 PR。
- **能力大修（按需）**：`skillopt-train` + 自定义 `EnvAdapter`（`rollout` 调 6.3.5 的配对 runner，`conversation.json` 由转录导出），多 epoch、慢更新、meta-skill 全开；契约节包进 `<!-- APPENDIX_START/END -->` 让引擎自己跳过，外加我们的校验器。

`consolidate(action: optimize, capabilityId)` 就是上面第一条路的作业封装；引擎的 Python 与我们的 Python 评测 harness 同一解释器（`requires-python >= 3.10`，睡眠模块零依赖）。

**发布**：`scripts/dev/open-method-pr.mjs`：从 staging 生成分支 + 提交（四处副本由既有拷贝机制同步，`capabilityPreflightCopiesAgree` / `skillTreesAreOneTree` 测试守着）+ PR 正文（来源 run id、配对评测报告、回滚目标 = 上一提交）；CI = 31 份 RQ 平价 + 契约测试；合入 → 镜像发布；回滚 = revert。

**测试**：Curator 只改自动维护节（变异：改契约节即拒）；计数器更新规则；PR 生成器的副本一致性。

**验收**：一个能力的一次 delta 经 PR 合入并在下一次批测中不劣化。

### 6.7 代码技能：EvoDS ASA 的代码形态（WP7，二期）

**目标**：把模型在运行里反复临时写的辅助函数沉淀为可复用、可验证的脚本技能，执行只在运行时容器内。

- **表示**：方法文档 `files: {"scripts/<name>.py", "tests/test_<name>.py"}`；`capsuleMethods.mjs` 的渲染器扩展为写 `methods/<id>/scripts/`（`safeId`、无符号链接）；正文按 Agent Skills 写「何时用、怎么调」，路径按 `skillRootGuidance` 的相对引用约定。
- **合成**：`distill` 在转录里发现同构的 Python 代码块（AST 规范化后 sha256 相同或近似）出现 ≥ τ 次 → 提议脚本候选。EvoDS 创建工具的约束原样移植进 `method-distillation` 的 SKILL.md：脚本必须「通用、数据集无关」，形状固定为 `def <tool_name>(parameters)` + `if __name__ == '__main__':` 自调用（这就是它的自测入口）；随脚本生成 `scripts/<name>.tool.json`（OpenAI function schema，仍在 `scripts/` 前缀内），规则可由代码核验：`name` 等于函数名、`required` = 无默认值参数、`properties` 与函数签名一一对应（不得发明或遗漏）、每个参数有 `type` 与 `description`——`validateMethodSkill` 对该文件与脚本的 AST 签名做这条比对。
- **执行边界**：脚本只由模型经 bash 在容器内运行，与 curated 技能的 `_runtime/execute_skill.py` 同一路径；工具权限不变（脚本做不了模型用 bash 做不了的事）；无出网。
- **验证**：(i) 静态：AST 可解析、import 闭集禁词（`socket / requests / urllib / http.client / subprocess` 出网形态）、无绝对路径；(ii) 动态：运行时控制器新增 `runtime.exec-verify` 操作（协议版本升级）在一次性容器里跑 `tests/`，产物内容寻址（`run_skill_execution_audit.py` 同款）；(iii) 与文本方法同一 `evaluate`。
- **晋升**：同一谓词；一般 `role: atomic`。

**测试**：静态检查一正一负；控制器操作的协议版本测试；材料化后目录结构；脚本在容器内可执行的 build-smoke。

### 6.8 SFT / RL 阶段（WP8，条件触发）

文本技能更新与摘要模板不是训练。另立训练项目只在（§14 五条件）：稳定任务族有足够合法可用的独立轨迹（含失败与恢复）；留出评测与重置环境可信且训练不可见；测得检索、方法质量、工具可靠性、上下文工程都解决不了的持续策略瓶颈；已选定可部署开源权重、许可、GPU、推理运维与回滚；预期收益覆盖成本。

到那时的流水线（EvoDS 代码可用）：数据 = `complete` 转录 + 生成器的金轨迹（GUST 形态的数据项：环境 + 3–7 个递进任务 + 每轮金工具集）→ SFT 行按 EvoDS 的 parquet 列 `{data_source, messages[{role, content, tool_calls}], tools(JSON), enable_thinking, extra_info{index, role, split}}`，角色分 manager / 各子代理 / tool_extraction / 摘要段（摘要调用与续段各成样本）→ verl 多轮 SFT（`data.multiturn.enable=true`，`max_length 16384`）→ GRPO，课程按训练步把轮数上限 4 / 8 / 12 / 16 / 20 逐级放开；奖励 = 契约通过 + 确定性检查 + TARA 逐轮覆盖（6.3.7 的同一数据；λ、γ 初值 0.5）− 上下文与轮数惩罚（EvoDS 实际实现是阈值规则，不是论文的 `|C| / C_max`，训练时二选一并写明）；环境 = 录制模式的运行时容器；基座按当时评估（EvoDS 用 Qwen3-8B，ToolVerse 用 Qwen3-4B / 8B 与 Qwen2.5-14B）；服务经模型网关的角色槽位（L8 ②），回滚 = 切槽位。先窄策略 SFT（工具规划或结构化摘要）对照 API 基线，再谈 RL；不只优化契约通过率（会学会空产物与弃权）。

## 7. 评测与发布判据

**七维向量，不互抵**：任务效用、证据完整性、可靠性、效率、上下文保真、复用（五计数 + 反事实对照）、安全。成本下降不能抵消新增的医学或权限问题。

**四组对照**：A 现状；B = A + 审过的平面方法库；C = B + 层级与按需选择；D = 最优方法配置 + 新上下文策略。小开发集筛候选，决赛集定结论；冻结基线 / 候选 digest、fixture、供应商路由、裁判版本、预算；配对随机顺序；重复跑并报告按任务族聚类的区间。

**发布判据（预注册）**：冻结回归集零新增确定性完整性 / 安全失败；目标「任务成功率上升或成本下降且质量非劣」，非劣边际初值 2 个百分点；区间跨边际即 inconclusive；20 例用于找问题不用于宣称；三次成功不构成可靠性声明。

**三条生效路径的门（无新增）**：私有方法——显式来源无门，推断来源 τ + 留出门，都可回滚、事后审阅；平台 delta——PR + CI 平价；上下文策略——独立开关 + 自己的配对评测。

## 8. 安全边界：文章四层护栏的对应物

| 文章的护栏 | 我们已有的 | 本方案新增 |
|---|---|---|
| 任务与轨迹评测 | 14 个 harness、hosted e2e、`audit:capabilities` | brief 生成器、配对评测、上下文保真集 |
| 候选能力沙箱 | 运行时容器：工作区限定、无直连出网、只读技能根、Landlock | 文本方法只能被读；脚本只在容器内跑、静态禁出网、一次性容器自测 |
| 高风险动作人工确认 | 阻断点 #6 签核；DSH 手动审批模式 | 无新增 |
| 版本回滚 | `revisions` + `pluginService` 回滚形状 | 方法修订同款；平台 = git revert |

技能正文是不可信文本：进厂检验对学出的方法、脚本与社区技能一视同仁；方法不得削弱契约或安全规则——胶囊是上下文不是权限。`hidden/` 参考解与裁判提示永远不进运行时。

## 9. 工作包总表与分工

| WP | 内容 | 节 | 挂靠 | 认领（2026-09-07） | 量 |
|---|---|---|---|---|---|
| WP0 观测先行 | 转录文件、学习回执、委派 digest、修复回合、压缩回执、常量接线 | 6.1 | gap #13a/#13d | 常量接线与 `feedback_events`：并行会话；其余未认领 | 1 周 |
| WP1 蒸馏 | `method-distillation` 能力、`methodSkill.mjs`、`method-candidate` 契约、runner | 6.2 | gap #13c、规格 C2 | `distill` 生产者 (a)：并行会话；执行体未认领 | 1–2 周 |
| WP2 评测扩建 | TDG、生成器、录制网关、配对 runner、留出登记、7 能力 brief | 6.3 | gap #6/#18 | 未认领 | 2 周 ∥ WP1 |
| WP3 装配 | 挂载 + 选择 + 预算 + 回执 | 2.1 | gap #12 | 并行会话 | 1 周 |
| WP4 巩固与层级 | `consolidate` sleep / integrate / evaluate、`methodGraph.mjs`、晋升退休 | 6.4 | 规格 A3–A4、C3 | 未认领 | 2 周 |
| WP5 上下文策略 | 测量 → 状态包 → provider → 请求压缩探针 → 策略搜索 | 6.5 | §21.8 ② | 未认领 | 2 周 |
| WP6 平台手册回路 | 经验条目、SkillOpt 优化、PR 生成 | 6.6 | §19.17 L2、:1812 | 未认领 | 随 WP1 |
| WP7 代码技能 | 脚本表示、静态检查、容器自测、控制器操作 | 6.7 | ASA 代码形态 | 未认领（二期） | 2 周 |
| WP8 SFT / RL | 条件触发；数据与流水线 | 6.8 | §14 | 未认领（条件触发） | — |

顺序：WP0 → WP1 ∥ WP2 → WP3 → WP4 → WP5 → WP6 → WP7 →（条件）WP8。P0 上线阻塞项优先于全部 WP。**明确不做（本期）**：跨用户 L3 聚合、假说竞技场、100 环境 gym、新 agent 面插件、审批流、百分比灰度。

## 10. 进度、成本、人

- 总量约 10–12 周·人（含 WP7），可单人串行；WP8 另立预算。
- 成本：只用 CPU 容器 + API 推理；每作业预占再结算；报告每成功任务成本与低频技能摊销；量级：100 例 × 2 组 × 3 重复 = 600 次运行，评测比蒸馏贵得多，所以初筛与小开发集在前。
- 单机：谷时窗口、并发 ≤ 2、断点续跑。

## 11. 首次 go / no-go（WP0–WP2 之后）

1. 一次完成的运行能否完整导出（含子会话），或被明确标为 partial？
2. 它的工具能否在录制模式下重放而不触真网、不留副作用？
3. 一个候选能否在未见过的变体上打平或胜过基线，且没有改任何验证器？
4. 一条方法能否追溯到来源 run 与 digest；digest 变了计数是否归零？
5. 回滚一条已生效的方法，下一次运行是否真的不再加载它（回执为证）？
6. 学习作业失败时，已交付的运行是否毫发无损？

六问任一为否，不扩大范围。

## 12. 来源与核验记录（2026-09-07）

论文：EvoDS https://arxiv.org/abs/2606.03841 · ToolVerse https://arxiv.org/abs/2607.15660 · SkillPyramid https://arxiv.org/abs/2606.03692 · SkillNet https://arxiv.org/abs/2603.04448 · SkillOpt https://arxiv.org/abs/2605.23904 · 同类：SkillRL 2602.08234、CoEvoSkills 2604.01687、SkillOps 2605.13716、综述 2607.10113、Letta sleep-time 2504.13171。

代码：`usail-hkust/EvoDS@14635a4a71f81c980a8b984880214115e22b56b0`（`utils/util.py` :281-295, :373-408, :411-478；`agents/data_cleaner.py` :65-72；`verl/data/sft/train_sft.parquet` 36,458 行；`verl/data/rl/{train,test}_rl.parquet` 7,851 / 150 行）· `zjunlp/SkillNet@dba86d5`（MIT）· `microsoft/SkillOpt`（README、`docs/sleep/README.md`、`plugins/dsh/`）· `WODE25500/dsh-skillopt@654f6eb3` · `qkycir-123/dsh-run2skill@d653aaf7`（npm 0.4.0）· `kouyichi/dsh-plugins/dsh-learn` · npm `dsh-plugin-stylotrace@0.1.15` · `MemTensor/MemOS` releases v2.0.32 / v2.0.33 / memos-local-plugin-v2.0.16–18、PR #2254 · `deepseek-ai/deepseek-harness`（`docs/subsystems/{skills,compaction}.md`、`docs/user/guide/mcp-memory.md`）· GitHub / HF 搜索 API：ToolVerse、GUST、TARA、SkillPyramid 均无官方产物。

论文机制细节（1.3 节）的原文位置：ToolVerse §3.2.1–3.2.2、§3.3、§4.2、§5.1、附录 B.1–B.5、D（Algorithm 1）、F（任务合成与工具改写提示词）、Table 2 / 4 / 6 / 7；SkillPyramid §2.1–2.4、附录 A.2–A.5（分析器 SCREEN / DECIDE、构建器两分支、创建器两阶段提示词）、Table 1–4；EvoDS §4.2–4.4、§6.1.3、Table 1–4，以及仓库文件 `utils/context_summarize.py`、`utils/prompt.py`（`Tool_Configuration_Extraction_PROMPT`、`CONTINUE_PROMPT`）、`utils/data_cleaning.py:524-535, :753-775`、`agents/EvoDS.py:186-257`、`agents/manager.py`、`agents/context_summarizer.py`、`verl/verl/experimental/agent_loop/data_science_agent_loop.py:205-214, :288-302, :434-437`、`verl/verl/workers/reward_manager/datascience.py:157-163`、两份 parquet 的列与行数（pyarrow 实读）。

工程参考（第 4.2、6.1、6.5、6.6 节）：`microsoft/SkillOpt@main`（`docs/reference/{api,cli,config}.md`、`docs/guide/{training-loop,new-benchmark,skill-document}.md`、`docs/sleep/{README,multi-skill-staging,openai-compatible-endpoints}.md`、`configs/_base_/default.yaml`、`skillopt/types.py`、`skillopt/evaluation/gate.py`、`skillopt/engine/trainer.py`、`skillopt/optimizer/{clip,skill,scheduler}.py`、`skillopt_sleep/{config,backend,handoff_backend,gate,consolidate,cycle,staging,evidence,types,tasks_file,mine}.py`、`plugins/dsh/src/index.js`）· ACE：arXiv 2510.04618 §3.1–3.2、§4.2、A.6 与参考实现 `ace-agent/ace`（`playbook_utils.py` 行文法与 id 分配、`ace/prompts/{curator,reflector,generator}.py`、`ace/core/bulletpoint_analyzer.py`）· AWM：arXiv 2409.07429 §2.2–2.3 与 `zorazrw/agent-workflow-memory`（`webarena/prompt/instruction.txt`、`mind2web/prompt/one_shot_abstract.txt`、`webarena/agents/legacy/agent.py:116`、`mind2web/memory.py`）· Agent Skills 规范：`agentskills/agentskills` `docs/specification.mdx`（agentskills.io/specification）· DSH `deepseek-ai/deepseek-harness@master`：`docs/subsystems/{compaction,skills,session,core}.md`、`docs/agent-lifecycle.md`、`docs/persistence-catalog.md`、`docs/config-catalog.md`、`packages/compaction/{command-compact,compaction,compaction-basic}/src/index.ts`、`packages/skill/{skill,skill-filesystem,tool-skill}/src/index.ts`、`packages/core/agent/src/runtime-types.ts:140-148`、`packages/session/session-persistence-jsonl/src/format.ts`、`packages/api/session-controller/src/{history,types}.ts`、`packages/bundle/base/cordis.patch.yml` · Letta sleep-time：arXiv 2504.13171（`rethink_memory`）· Dynamic Cheatsheet：arXiv 2504.07952 与 `suzgunmirac/dynamic-cheatsheet` 的 curator 提示词。

本地：`@deepseek-ai/dsh-compaction-basic@0.1.2-rc.1`、`dsh-compaction`、`dsh-command-compact`、`dsh-skill`（`/home/coder/tmp/dsh-closure-rc.1/node_modules/@deepseek-ai/…`）。仓库文件位置见第 2 节。

## 13. 实施记录（2026-09-07，分支 `feat/self-evolution`）

本节是**实施改变了方案的地方**，不是完成度清单。每条都是写代码时撞到的事实，前面各节按它们更正。

### 13.1 上游与仓库事实的六处更正

1. **`summarizeWithLlm` 上游没有导出**（更正 §6.5 的改动点表）。`dsh-compaction-basic@0.1.2-rc.1` 的 `lib/types/summarizer.d.ts` 声明了它，但 `lib/index.js` 结尾只 `export { BasicCompactionEngine, BasicCompactionEngine as default }`，且 `files` 不发 `src/`。所以增强调用只能走基类自己的 `summarize()` 钩子，而基类会在我们追加的指令**之后**再追加它自己的九段式指令——我们的摘要指令因此写成「内容取舍规则 + 段内条目形式」，而不是与上游竞争的顶层输出格式。上游哪天导出了，指令就能整体替换；已记进 `seam-manifest.json` 的 `notes`。
2. **不需要 `runtime.exec-verify`，也不需要升协议版本**（更正 §6.7）。运行时控制器已有 `/v1/kernel/run`，在同一沙箱、同一工作区界、同一输出上限里执行代码——代码技能的自测就是这个。新增第二条特权执行路径意味着两条要同步的路径，而新的那条没人审。实现改成组合：静态检查（domain）+ 既有 `runKernel`。
3. **新能力包只进两棵手写树 + 两棵生成树**（更正 §6.2 括注）。`runtime/skills/evimed/` 是 `capabilities/` 之前那十一个包的历史位置，唯一的既有内部能力 `source-understanding` 也不在里面。实际强制的是：`capabilities/<id>/`、`capability-skills/<id>/`（`skillTreesAreOneTree` held byte-identical）、`deploy/runtime-dsh/capabilities/<id>.json`（`check:capabilities` 生成并校验）、`packages/socket/{capabilities,capability-skills}/`（gitignored，prepack 生成，`bundleShipsItsCatalogue` 跑 prepack 校验）。
4. **`method-relations` 的动作词表是 `screen | decide | build`**，写在能力清单里，`METHOD_RELATIONS_ACTIONS` 从 domain 导出；控制面在加载时断言这三个仍在，改名会变成加载期失败而不是提交一个没人接受的动作。
5. **压力压缩此前不可达，原因写死在两处**：控制面声明 `contextWindow: 1_000_000`，运行预算 `maxTokens 400000`，触发点 `0.8 × 1M = 800K` 在预算外。改为默认取运行预算（`0.8 × 400K = 320K`），而不是在代码里断言一个无法核实的厂商上下文长度——知道真实值的部署显式配置。
6. **`TOOL_RESULT_PRUNER` 与 preset 行现在有绑定测试**；此前是手抄副本，漂了不会失败，只会让控制面对「这次运行看到了多少」的判断悄悄变错。

### 13.2 实施中发现并修掉的两个缺陷

1. **转录一次也写不成功。** `persistRunTranscript` 把项目相对路径交给 `writeFileAtomicNoFollow`，而 `security.mjs` 的 `scopedParts` 用 `path.resolve` 解析——相对路径解到 `process.cwd()`，永远不以 `project.rootDir` 开头，于是每次调用都抛 `HttpError(403, path_forbidden)`，被 `onRunFinished` 的 `securityAudit` 吞掉。**整个学习回路会一条记录都没有，且看起来就像「没有值得学的运行」**。修法是写入用绝对路径、回执仍存相对路径。变异对照：还原成修复前的形式，16 条测试里 6 条转红。
2. **终态钩子的写入能活过 `close()`。** `onRunFinished` 由运行账本自己的监视器触发，转录写入因此可能落在关停之后——测试里是和临时目录删除赛跑（`ENOTEMPTY`），生产里是和它依赖的运行时拆除赛跑。改为把在飞的终态写入登记在一个集合里，`close()` 在关运行时之前 `allSettled` 它们。

### 13.3 已建成但还不会自己动的三处（诚实的空态）

1. **`executed` 边今天是零。** `build-tool-graph.mjs` 只**转录**执行回执（`evals/tool-graph/executed-edges.jsonl`，缺 `validatedBy` 就构建失败），自己永远不写 `via: "executed"`；15 张图目前 100% 是 schema 边、0 条可采样，生成器因此产出 0 份 brief 并打印它拒绝了多少条——这时候失败才是错的，那会让「诚实的空态」看起来像坏掉的流水线。写回执的是录制网关与配对 runner，形状 `{capability, from, to, type, validatedBy: <runId>, at}`。
2. **配对评测是显式开关。** `consolidate(action: evaluate)` 需要 `OPEN_SCIENCE_LEARNING_EVALUATION_COMMAND`；没配就按名字失败（`method_evaluation_unavailable`），不会「没评测却成功」。默认不配，因为一次评测是 100 briefs × 2 臂 × 3 重复 = 600 次真实运行，定时器不是发起它的地方。
3. **`hidden/<id>.reference.json` 还没有生成器。** runner 已按约定形状读取，缺失时报 `referenceAvailable: false` 并退回门禁自己的裁定，而不是盲评。

### 13.4 两个新的测量缺口（§6.5 第一步会撞上）

- **每次运行的成本没有 HTTP 出口。** `usageLedger.summaryRun` 在服务端存在但没有路由，配对 runner 只能从账号导出按 runId 关联；效率维度因此在没有导出时丢掉成本项并说明，而不是猜一个数。
- **上下文溢出不可归因。** `turnEndErrorCode('max-tokens')` 映射到 `runtime_session_error`，其 `model_max_tokens` 子码在进 `runs.jsonl` 前被丢掉，所以溢出和普通会话错误在账本里是同一个字符串。把子码保留下来，是让溢出计数从「不可区分」变成「可归因」的那一改。

### 13.5 仍然阻塞的一件事

代码技能的**材料化**（把 `files` 写成 `methods/<id>/scripts/`）要改 `capsuleMethods.mjs`，那是并行会话尚未提交的文件，不在本分支的基线上。域侧的全部规则（脚本形状、`tool.json` 与函数签名的逐条比对、导入禁集、绝对路径、三件套完整性）与容器内自测（§13.1 #2 的组合实现）都已完成并有测试；只差渲染器那一步，等它们合入后接上。

## 14. P0/P1 收尾（2026-09-07 下午，同分支）

首轮实现之后做了一次"谁在生产路径上真的被调用"的清点，结论是**回路没有闭合**。以下是补上的部分，以及过程中发现的三个真问题。§13 的空态记录对照本节读。

### 14.1 计数器此前没有任何生产者

`recordObservation` / `recordEligible` 在生产代码里零调用方，于是 `learning.counts` 恒为零 → `evaluationEligible` 恒 false → 推断来源的方法永远停在 `candidate`。这个失败没有症状：一个每晚蒸馏候选却从不晋升的循环，与一个确实没什么值得晋升的循环，从外面完全一样。§13 写的 `learningComposition.test.mjs` 断言了每个服务都被构造、启动、纳入排空与关闭清单——**"接线"不等于"喂数据"**，它看不见这个。

补法是 `apps/server/src/methodObservations.mjs` + 组合根里的 `recordMethodUse`：

- 归因按**交付项**而非按运行，因为委派回执本来就是这个粒度（`recordSubagent` 以 `runId:deliverableId` 为键，重投递覆盖首次）。一次产出四份包的运行是对方法的四次独立读数，每份有自己的门禁判定；把它们塌成一个运行级结论，就丢掉了"到底帮到了哪一份"这唯一的信号。
- 三种拒绝归因的情形各自明确：没拿到判定的交付项不是任何方向的证据；挂载摘要与账本当前摘要不符说明期间改过正文，把新文本的账算给旧文本正是 `(method, digest)` 键要防的混淆；回执里解析不到已批准方法的名字属于共享同一挂载目录的另一个来源，只入账本回执、不计入任何计数。

### 14.2 学习方法此前没有挂载点

并行会话的 `capsuleMethods.mjs` 物化的是**记忆胶囊的工作方式条目**，根本不读 `documents.kind="method"` 账本。两半各缺一块。本分支补 `learnedMethodMount.mjs`（选择 + 渲染 + 摘要 + 独立的条数与字节预算），合流时在其物化函数里加一次调用即可。

渲染必须与 `mountedMethodDigest` 哈希的字节完全一致，否则每条观察都会被当作过期丢弃，而现象是"一切正常但什么也没记下"——这条由 `learnedMethodMount.test.mjs` 的第一条测试钉住，它把三方（写文件的、读文件哈希进回执的、按摘要记账的）算出的数字直接比对。

### 14.3 晋升本来是个死锁，解法在方案自己的评测台里

只有 `approved` 会被挂载，`approved` 需要观察，观察只来自挂载。§6.3.6 里评测台自行设定方法快照，就是出口：`selectLearnedMethods` 增加 `trialMethodIds`，是候选进入运行的**唯一**口子，只有配对评测台会传，研究者的真实运行没有任何路径拿到未经证明的方法。试用的方法排序在最前且不参与截断——一次静默测到了基线两次的评测会永远报告"无差异"。

### 14.4 一个真缺陷：生成可以给自己盖章

`methodDistillationRuns.mjs` 原本写 `origin: candidate?.origin === "explicit" ? "explicit" : "inferred"`，而 `candidate` 是蒸馏运行自己的模型输出，显式来源又免配对评测直接生效——整套设计声称"结构上不可能自我批准"的那条性质，有一个一个词的旁路。`applyCandidate` 此前**一个测试都没有**，这就是它能活下来的原因。

现强制 inferred。纠正触发不是例外：触发是外部的、已记在 `feedbackEventIds` 里，但文本仍是模型写的，仍要过门。新增 `methodDistillationApply.test.mjs`，把洞放回去两条测试立刻变红，修好即绿。

### 14.5 显式来源此前也没有生产者

新增 `POST /api/methods`：研究者自己写的方法，`createCandidate` 用同一条 `promotionVerdict` 规则在创建时判定（显式立即生效，推断永远不会）。这不是审批路由——它不置状态，只交来源，规则仍在唯一那处。

这条路优先级排在推断路之前，依据是公开评测：[SkillsBench](https://arxiv.org/abs/2602.12670) 人工整编技能 +16.2pp、模型自生成 ≈0.0pp；[SkillLearnBench](https://arxiv.org/html/2604.20087v1) 进一步指出仅靠自我反馈会诱发递归漂移，真实改进来自外部反馈。

### 14.6 两条阈值原本读同一个数

`evaluationEligible` 里 `MEMORY_PROMOTION_MIN_RUNS` 与 `METHOD_INDUCTION_MIN_TRAJECTORIES` 都在比较去重后的族数，于是前者形同虚设。现在分别校验轨迹数与**独立运行数**：一次运行里的三个交付项是同一份简报、同一位研究者、同一批来源的三次相关读数，不是三份独立证据。

### 14.7 贡献度与库容上限

[Library Drift](https://arxiv.org/abs/2605.19576) 的 Ratchet 配方，按我们的计数器改写：`contribution = (succeeded − (loaded − succeeded)) / loaded`，20 条轨迹起判（低于其 100，因为我们准入要过配对评测）、≤ −0.10 提议退休，账号级活跃上限 50。

关键在于这条子句放在**衰减判断之前**。一个天天被挂载、包却总被门禁打回的方法，强度很高而贡献为负，是库里最坏的东西——它不是闲置，是活跃且有害——而只读强度的规则永远提不出它。上限产出提议而非删除，不占阻断预算（原则 4）。

### 14.8 转录保留策略第一次有了调用方

`pruneRunTranscripts` 此前零调用，`TRANSCRIPT_RETENTION_DAYS` 读起来像政策、实际是注释。挂到 learning worker 的 reconcile 定时器上，且不受 `enabled` 与消费窗口约束——删旧文件不花模型钱，而试用后又关掉循环的部署，恰恰是最不会有人去清理转录的那种。

### 14.9 顺带撞到的既有规则

我在复合键里写了裸 NUL 字节，`harness-port` 的边界测试当场抓住：这类文件会被 grep / ripgrep 归类为二进制而整体跳过，症状不是"没有匹配"而是"从没被看过"。

### 14.10 门禁

服务端 2005 项（1860 通过 / 0 失败 / 145 跳过，基线 1823 通过）、domain 135、socket 88、harness-port 77；lint 与 typecheck 全绿。

## 15. 探针 V-1 / V-2 的答案（2026-09-07，腾讯云主机，实跑）

两个探针都做了两段核实：先读**生产镜像里那份内核二进制**（`evimed-runtime-dsh:evimed-20260907-fd5657b`，即线上正在跑的那个），再在生产上**实跑**。两段结论不同——这正是方案当初坚持要活线核实的理由。

### 15.1 V-1：内核支持，**我们自己的托管面拒绝**

**源码侧**（`@deepseek-ai/dsh-api-session-controller/lib/index.js`）：

- **757 行** `if (request.mode === "steer") agent.steer(message); else agent.followup(message);`
- **762 行** 只有底层抛错才转 `RemoteError("session/agent-busy", "prompt rejected")`
- **815 行** 队列改写 API；`steer` 在 `agent.status !== "running"` 时报 `session/steer-unavailable`
- 客户端词表（`dsh-client-ui-conversation`）：`BUSY_ENTER_BEHAVIORS = ["queue", "steer"]`，默认 `queue`

**实跑**（`scripts/ops/probe-session-append.mjs`，同一会话连发两次派发）：

```
first  dispatch: 202  run_d6e026c0… running
second dispatch: 409  agent_run_active
```

**只读源码会得出"V-1 支持"，而那在要紧的层面是错的。** 拒绝来自我们自己：`apps/server/src/agentRuns.mjs:2674`——会话已有 `running` 运行即 409，只对"被领养的占位运行"与 `nativeTurn` 开口。

**但机制在生产里天天在用**：修复回路的 `clinicalRepairSenders`（`agentRuns.mjs:2784`）通过 `recordKernelRequest` + `sendPrompt` 在 `running` 的运行上追加提示。

**结论**：§6.3.3 第 6 条的"晚到纠正"变体可以做，路径是修复式内部通道，或给评测派发在 2674 行开一个具名口子——**不是**公开的 `/api/agent-runs/dispatch`。两种语义各值一个变体：`queue`（下一轮才看到的纠正）与 `steer`（打断当前轮的纠正）。

### 15.2 V-2：`compactRegion` 确实在 `agent/pre-step` 内执行——实跑观测到

**源码侧**（`@deepseek-ai/dsh-compaction-basic/lib/index.js`）：**782** 注册 `agent/pre-step` → **784** `compactIfNeeded` → **877/899** `compactRegion` → **914** `compactSurfaceRegion(..., owner: "current-turn")`。方案担心的"拒绝活动中"是反的：**430 行**要求**必须有打开的 turn**，pre-step 里正好有。唯一冲突点是 **881 行** `assertNoActiveCompaction`。

**实跑**：把该项目运行时的 `contextWindow` 临时从 1,000,000 降到 8,000（阈值比 `DEFAULT_THRESHOLD_RATIO = .8` → 触发点 6,400），重启运行时使内核重读，派发一次普通提问。会话日志（`sessions/--workspace--/ses_probe_v2_mtrab757/session.jsonl.zstd`，129 个 zstd 帧、182 条事件）：

```
seq 766  step/end
seq 768  compaction/start          ← 两个 step 之间，即 agent/pre-step 的位置
seq 769  compaction/end
seq 770  step/start
seq 871  compaction/start
seq 872  compaction/summary        range 8→771, 9960 tokens, 5 nodes shadowed
seq 875  compaction/start          ← compactIfNeeded 的重试循环（压完仍超阈值）
seq 876  compaction/summary        range 873→873, 1215 tokens, 1 node
seq 878  compaction/end
seq 879  step/start
```

压缩三次、跨真实区间、运行**成功结束**。这是 `compactRegion` 在 `agent/pre-step` 内真实执行的直接观测。

**结论**：V-2 为真。`evimed_compact_request` 的落法（标记 → pre-step 读标记 → `compactRegion([首个可压 seq, 最近平衡 seq])` → 清标记）在这份二进制上成立，实现时必须尊重 881 行的 `assertNoActiveCompaction`，并注意引擎自己的压力压缩可能在同一 hook 内已经跑过。

### 15.3 顺带查实的一件事：生产里压缩从未触发过

生产 `/runtime/dsh-home/control-plane-patch.yml:20` 是 `contextWindow: 1000000`（部署版 `runtimeManager.mjs:1673` 硬编码），阈值比 0.8 → **触发点 800,000 token**。容器 `EVIMED_MAX_TOKENS=0`（未设运行上限），所以不是数学上不可达，而是**实际从未接近**——探针前的日志与会话里 `compaction/*` 事件为零。

本分支 SE5 把它改为 `runtimeContextWindow || runMaxTokens || 400_000`，触发点降到 320,000。更正 SE5 记录里的措辞：当时写"1,000,000 对 400,000 预算 = 触发不可达"，准确说法是**理论可达、实际从未发生**。

### 15.4 这次实跑的成本与痕迹

三次派发（V-1 两次，其中第二次被 409 挡在模型之前；V-2 一次），一个测试账号项目 `c1-x7w0sn` 下留下三个会话与两条运行记录，未删——探针不该抹掉自己产生的证据。`contextWindow` 已复原为 1,000,000 并重启核验；生产栈其余部分未改动。
