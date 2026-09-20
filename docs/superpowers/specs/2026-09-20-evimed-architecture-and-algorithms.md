# EviMed Science 架构、流程与算法总览（2026-09-20）

- **文档性质**：当前系统的独立可读总览。它取代 `2026-08-26-evimed-architecture-overview.md`——那份写于换内核收尾期，此后四周里记忆底座、文档解析、知识库检索、网页阅读、运行时提供方、门禁判定、前端形态全部变过，照它排障会错。
- **口径**：只写这次逐条核实过的事实。已上线写【线上】，代码里有但生产未开写【已建未开】，只有设计写【设计】。每条算法附**实测数字与它的样本量**；没量过的明写"没量过"——一个没有数字的机制和一个测出来无效的机制，区别正是这份文档要保住的东西。
- **上位文档**：`2026-08-22-evimed-dsh-plug-harness-design.md`（spec，决策仍以它为准）。开发纪律在仓库根 `CLAUDE.md` 的「Development principles」与「Plugin-first architecture and runtime-gate discipline」两节。
- **核实时点**：生产发布 `evimed-a59ea4bf10aa-1`，就绪 24/24，main `4e009140b`。

---

## 1. 一句话

> **EviMed Science 是一个面向医学科研的 Agent SaaS：一个 React 控制面 + 每个项目一个隔离运行时；运行时里唯一的执行内核是 DeepSeek Harness（DSH 0.1.5-rc.2），我们的全部科研能力以一个 DSH bundle（`@evimed/dsh-socket`）挂上去；控制面持有租户、账本、门禁、网关、记忆与计量，运行时只在沙箱里做 LLM 工作。**

三处与 08-26 版不同，都是既成事实：

1. **桌面端不存在了。** `apps/web` 是唯一前端，路由在 `/app/*`，`packages/sdk` 与 `src-tauri` 已删。托管会话面**就是运行时容器里那张 DSH 页面**，按项目从另一个端口代理进来（不是我们重写的页面）。
2. **记忆只有一个形状。** 研究记忆与结构化记录是控制面 PostgreSQL `evimed_memory` 的行，胶囊在 `evimed_product`；OpenViking 是两者共用的**派生召回索引**，永不持有记录，可整体重建。MemOS、Ollama、usememos 全部删除。
3. **门禁不再扣留交付物。** 2026-09-17 裁决之后，运行结束一律交付并附核验标签与问题清单，读者在报告的「依据」里逐条看 ✓/⚠。`failed` 只留给真正没有产物的情形。

---

## 2. 十层，以及每层"一个插件"是什么

| # | 层 | 位置 | 插件单元 | 数量（核实） | 关掉会怎样 |
|---|---|---|---|---|---|
| 1 | 浏览器 | `apps/web` | `/app/*` 下的一页 | 聊天、运行、文件、主动科研、记忆、收件箱、能力、账户 | 子系统报关则该页隐藏；任何一页都不是发起对话的必经之路 |
| 2 | 控制面 | `apps/server` | `<x>Service.mjs` + `create<X>Routes` + 租约 worker + 一个 `OPEN_SCIENCE_<X>_ENABLED` | sources / autopilot / notifications / usage / capsules / plugins / learning / memory / im | 按名字回 503，其余照常。**这里永不做运行时代码加载**——它是租户边界 |
| 3 | 内部网关 | `*Gateway.mjs` | 一个路径常量 + 一个 handler + 一份白名单 | model · publicSource · webSearch · geoProbe · capsule · revision · connectorCredentials · kbSearch | 网关地址不配 = 该出网按具名错误码拒绝 |
| 4 | 领域 | `packages/domain` | 一个契约种类；`clinical-safety-rules.json` 的一行 | 26 个契约种类 · 18 份能力契约 | 无开关。门禁唯一实现，阻断点预算 6 个 |
| 5 | 防腐层 | `packages/harness-port` + `seam-manifest.json` | 一条缝 | 全仓唯一可 import `@deepseek-ai/*` 的包 | 无开关 |
| 6 | 插座 | `packages/socket` | 一行 cordis 插件 | **12 个**：宿主 `runtime-ui` `plugin-probe` `seam-probe` `evidence-store`；agent `guidance` `run-policy` `evidence` `capsule` `screening` `review` `citation-bridge` `compaction` | 全部关掉，会话仍须能起、能答 |
| 7 | 运行时镜像 | `deploy/runtime-dsh` | 一行工具、一个技能根、MCP server、一份能力清单 | 技能根 core/community/curated-scientific/office；社区 bundle `dsh-cite` `dsh-annotation` `dsh-mermaid` | preset 行 / 技能目录 |
| 8 | 能力 | `capabilities/<id>` | `capability.yaml` + SKILL.md + 契约 + ≥3 份真实题面 | **18**（15 公开 + 3 internal） | `visibility` |
| 9 | 专科引擎 | `项目代码/` 六个 Python 引擎 | 一个容器 + HMAC 适配器 | meta / MR / 审稿 / 文献计量 / 选题 / 药安 | 引擎停 = 该能力报 blocked，平台不受影响 |
| 10 | 外部服务 | DeepSeek · 公共源 · OpenViking · OpenList · 自研解析接口 · DashScope · PostgreSQL | `deps-version.json` 的一个 pin + `packages/contracts/<dep>` | — | 换 provider 不换 consumer |

配置单点 `apps/server/src/config.mjs`，373 处 `OPEN_SCIENCE_*`。**compose 的兜底值不得低于代码默认值**，有测试挡着——生产曾因此跑了几周 pids 256 / 内存 4g，而代码写的是 1024 / 8g。

---

## 3. 数据实际落在哪

| 存储 | 内容 | 备注 |
|---|---|---|
| PostgreSQL（pgvector 0.8.6 / PG 16.15） | `evimed_control`（用户、项目、会话）· `evimed_product`（documents/revisions/jobs 账本、胶囊、反馈事件、插件状态）· `evimed_usage`（模型请求账本）· `evimed_memory`（记录与笔记）· `evimed_inbox`（通知）· `evimed_channels`（IM 绑定、聊天、投递）· `evimed_kb`（知识库文档与分块，含 `vector` 与 `pg_trgm`） | 每晚备份，恢复演练做过 |
| 项目数据卷 | 每用户每项目一棵工作区：`.evimed-brief/`、`deliverables/<id>/`、`.evimed-run/state.json`、`.openscience/runs.jsonl`、知识库原文 | **项目删除即整棵删除** |
| OpenViking | 记忆与胶囊的召回索引 | 派生，`pnpm rebuild:memory-index --all` 可重建 |
| 对象/卷 | 胶囊快照与密钥、说明书索引（140,279 条）、药学参考库 | — |

**一条刚修好的账目纪律**：用量账本过去随项目级联删除，删一个项目就把它花过的钱从账上抹掉，连带把 24 小时/7 天滚动上限的分母降下来。2026-09-20 实测：清理验收项目带走约 1,700 条已结算记录。现在外键改成 `ON DELETE SET NULL (project_id)`——租户检查保留，删除动作不再动账（`9bbdfeae`）。**这条修复尚未上生产**，在它发布前删项目仍会抹账。

---

## 4. 五条主干流程

### 4.1 一句话提问 → 回答（零工具）

```
浏览器 → POST /api/agent-runs/dispatch
  → 期望检查：正则路由（specialistRouting.mjs，258 行）未命中则 LLM 分类器（关思考），失败安全落答案线
  → 记忆召回（无条件，不由路由决定）写入 .evimed-brief/memory.md
  → reserveRun → 复用/启动项目运行时 → 生成 profile patch（0600）→ session.create(evimed-universal)
  → session.prompt → 首个 agent/pre-step：run-policy 一次性 inject 题面与上下文
  → 模型直接回答，不写计划、不强制检索
  → turn/end → 控制面折叠为账本四值 + 投影九态 → SSE /api/runs/:id/events
```
**实测**：25 秒、¥0.046（2026-09-20，新发布上）。热运行时同页新任务 0.4 s，冷启动首开 7.3 s。

### 4.2 深度任务 → 交付

```
① 期望检查 → 契约种类（如 clinical-evidence-report）
② evimed_plan 写 task-plan.json（deliverables[{id, contractKind, capability, dependsOn}]）
③ evimed_delegate 起子代理：能力清单 → toolFilter + 预注入 SKILL.md + persona + outputSchema
   委派非阻塞，父代理用 evimed_await 收；maxDepth=1，maxParallelChildren=30
④ 子代理检索：MCP 工具 → tools/result 观察 → 证据表 queued→ready；全文落 .evimed-sources/
⑤ 主张级工具：evimed_claim_upsert 逐条写入并按门禁自己的规则判定；evimed_render_report
   让正文编号与参考文献与矩阵一致；evimed_package_check 给同样的裁定而不花一次提交
⑥ evimed_submit_deliverable → runGate（@evimed/domain）→ 分层 issues 或回执
⑦ evimed_complete_run：计划履约 + 安全触发器 → delivery-summary.md → concludeTurn
⑧ 控制面从卷上读取工作区（容器生死与判定无关）→ reconcileSession 逐件重跑同一份校验
⑨ 一律交付 + verification 标签 + 问题清单（SAFETY 在前，MUST FIX 在后）；报告里每条主张 ✓/⚠
```

### 4.3 上传 → 知识库 → `kb_search`

```
上传/OpenList 导入 → 内容寻址 src_<sha256> → jobs 队列（SKIP LOCKED + 租约）
  → 纯文本格式：本地逐字读取（逐字引证要的就是原始字节）
  → PDF/Office/图片/EPUB/HTML：自研解析接口（协议 v1，可选 pageMap/metadata）
  → 音视频：按名拒收（415）
  → DOI 经 Crossref 核对；index.md 带书目头与页标记
  → kbIndex 分块 → tsvector（CJK 双字）+ pg_trgm + pgvector，向量分批补
  → 内部能力 source-understanding 抽取结构化理解
运行侧：kb_search（MCP）→ /internal/kb/v1/search → 小库(<150K token)直接答"去读这几个文件"
```

### 4.4 记忆

```
派发前：召回（OpenViking 向量 → 控制面重排 → 预算装配）→ .evimed-brief/memory.md
运行中：evimed_capsule_recall / evimed_capsule_note（唯一的记忆端口）
运行后：抽取（关思考，120 s 上限）→ 记录写 evimed_memory，六分区胶囊，
        superseded_by / invalid_since，每处自动改动可撤销，无痕对话可整段不记
学习回路：三个自动触发 + 北京时间夜间窗 → distill / consolidate 作业 → 方法文档
```

### 4.5 发布

```
本机：全量 CI（test:web + 审计 + build:web）→ 打 delta 包
主机：host-delta-release.sh 播种 releases/<NEW>（运行时增量，或 EVIMED_RUNTIME_BUILD=full 走六个镜像源）
      host-engine-delta.sh 把六个引擎镜像做成运行中镜像的增量（requirements 变了就拒绝，那是全量构建）
      env 改动 → host-release-switch.sh 经 current 符号链接切换 → 就绪 24/24
      监控容器必须 restart 才会读到新规则与看板（文件绑定在容器启动时解析 current）
      retention --keep 2
```

---

## 5. 算法清单与实测效果

这一节是这份文档的重点：**每条算法做什么、参数写在哪、量过什么、数字多少、哪些没量过。**

### 5.1 路由（题面 → 能力）

- **机制**：`specialistRouting.mjs` 正则先判（只给期望契约种类，不阻断）；未命中走 LLM 分类器 `specialistClassifier.mjs`（默认开，已关思考），失败安全落答案线。会话绑定优先于两者。
- **实测**：评测配对跑必须钉能力，否则同一臂会被分到三个能力上——这正是 memory-ablation v1–v4 全部作废的原因。日常运行未做过路由准确率的系统测量。
- **没量过**：路由准确率、分类器超时率的线上分布。正则 155 个位点仍是全仓最高密度，按原则 2 不再扩张。

### 5.2 知识库检索 `kb_search`【线上】

- **机制**（`kbIndex.mjs`）：小库（< 150K token）直接回"读这些文件"，不检索；大库三条腿——tsvector（与记忆召回同一个 CJK 分词器）、pg_trgm（药名与拼写错误）、pgvector 余弦；每条腿出 50 个候选，RRF **k = 60** 融合，取前 30 给 `qwen3-rerank`，带一句针对"临床药师/医学研究者提问"的 instruct。缺了扩展或密钥的腿直接跳过并在结果里说明；重排失败保留融合序。每个命中带 UTF-16 偏移，片段就是那一段原文（700 字符）。
- **实测**：固定回归集 `apps/server/test/fixtures/kb-regression.json`（合成语料 + 六类问题：药名、剂量、缩写、拉丁名、拼写错误、无共同词的改述）——**每类问题的答案都在前三，改述题经重排排到第一**；线上一次真实上传后 `kb_search` 被模型选用并引用了正确剂量。
- **没量过**：真实语料上的召回率/精确率，以及"小库阈值 150K"这个数。它来自一条公开建议（约 200K token 以下不做检索）加上我们 98% 的缓存命中率，不是本地实测。

### 5.3 记忆：召回与抽取【线上】

- **机制**：召回在每轮派发前无条件执行（不由路由开关）；候选来自 OpenViking 向量，控制面重排，按预算装配；预算对持久记忆留位，避免运行摘要把长期画像挤掉。抽取在运行后异步跑，关思考，上限 120 s，写入前过结构判断（我们自己注入的 `<evimed-brief>` 等闭合标记一律不读）。
- **实测（这是唯一有对照的一组，值得完整读）**：

| 批次 | 门禁形态 | 计分格 | 结论 | 效率 | 证据完整性 | 任务效用 | 安全 |
|---|---|---|---|---|---|---|---|
| v9 | 阻断式 | 12 | **worse** | 0.578→0.578 | 0→0 | **0.450→0.250**（CI −0.367~−0.033） | 0.900→0.967 |
| v10 | 不阻断（现行） | 12 | inconclusive | 0.758→0.783 **better** | 0.467→0.633 | 0.800→0.767 | 0.867→0.933 |
| v11 | 不阻断 | 4 | inconclusive | 0.776→0.860 **better** | 0.600→0.900 **better** | 0.650→0.900 | 1.000→0.900 |

  读法：v9 那次"更差"是在**阻断式门禁**下测的，两臂大多数格子根本没交付（12 格交付 5 格），差异更像交付失败的噪声。门禁改成不阻断之后，两批都是**效率更好、证据完整性更好，任务效用中性偏正**。三批的样本量分别是 12、12、4 格、两个题族，**没有一批足以下结论**。
- **没量过，而且是最要紧的那个**：三批操纵的都是四条通用偏好记录，**没有一批测过胶囊**。能证明胶囊成立的实验是"切换成 A 的胶囊后，输出是否可测地向 A 的方法靠拢"——从未跑过。v11 的安全分 1.000→0.900 是唯一需要盯着的反向信号。

### 5.4 交付门禁【线上】

- **机制**：规则只有一份，在 `packages/domain/src/clinicalEvidence.mjs`（约 3.8k 行），运行侧经 `evimed_submit_deliverable` 抵达、控制面经 31 行再导出 shim 抵达，有测试钉住两侧同判。主张三型 `direct / synthesized / derived`；药物与场景规则在 `clinical-safety-rules.json`（药师可改，不动代码）；报告正文禁工具名、网关名、产物路径、第一人称检索日记。**共 85 条检查，其中运行内必修的只有 18 条**——12 条 `blocking`（包读不出来，或读者看不见缺陷）与 6 条 `safety`（临床措辞），其余 67 条一律是建议。
- **实测（2026-09-17，12 次线上运行）**：运行时间的 **63%** 花在提交/修复回环；**0/12** 包一次通过；扣留它们的 52 条问题里 **65%** 是包自己的记账（覆盖台账行号、运行回执统计、自评质量检查），15% 是有可见误报的措辞模式，约 **10%** 是门禁真正存在的理由——引语不在它所声称的来源里。
- **据此做的**：`CLINICAL_CHECK_TIERS` 只保留完整性与安全两类为运行内必修，其余降为建议；包自述的六个文件连同读它们的检查一起删除；服务端修复轮默认 0。**效果**：v10/v11 两批的任务效用从 v9 的 0.45/0.25 抬到 0.80/0.77 与 0.65/0.90。

### 5.5 主张核对【线上】

- **机制**：`claim_verification` 命令 → domain 的 `claimVerification`；报告里每条主张带 ✓/⚠，读者在「依据」浮层看到引语与来源。
- **实测**：09-18 两件交付物 74/74 与 65/66；09-19 69/71；09-20 106/106。

### 5.6 成本与缓存【线上】

- **机制**：网关处预留→结算→释放/不确定四态账本；`purpose` 列分 `kernel / memory-extraction / routing / title / engine / capsule-scan / channel-intent / source-understanding / other`；六个 Python 引擎的 DeepSeek 用量经签名 `POST /internal/usage/v1/engine` 回传；过期预留有清扫作业。
- **实测**：缓存命中 97.7–98.3%；深度任务成本见下表。
- **注意**：`purpose` 无回填——这个列之前的行一律是 `other`，猜一个用途在报表里和记下来的用途长得一模一样。

### 5.7 专科引擎（确定性）【线上】

六个 Python 引擎做统计与检索：Meta（numpy/scipy）、MR（R + OpenGWAS）、药安信号（ROR/PRR/χ²/IC/EBGM）、文献计量、选题、审稿（15 份报告规范 YAML）。**LLM 永不做统计**。引擎自身套件在各自 venv 下全绿（文献计量 50、MR 145、meta 1389…）。

### 5.8 重排（记忆与知识库共用）

`memoryRerank.mjs`：构造函数的 `instruct` 是实例默认值，每次调用可覆盖；失败一律 fail-open 到向量序。模型经 DashScope 钉在 `deps-version.json`。

---

## 6. 目标与今天的实测

2026-09-18 核查定下的目标，逐条对当天实测：

| 指标 | 09-18 起点 | 目标 | 今天（核实） |
|---|---|---|---|
| 深度任务用时 | 17–60 min（基线 79） | ≤ 15 min | **09-18 24–27 min · 09-19 22.9 min · 09-20 33 min 与 59.5 min** |
| 每次运行成本 | ¥3.31（无归因） | 可归因、≤ ¥1.5 | 可归因已做到；**¥2.64 → ¥4.22 / ¥7.78** |
| 工具调用中文件/shell 占比 | 77% | ≤ 30% | 09-19 实测 47% |
| 工具调用总数 | 505 | — | 09-19 实测 363 |
| 提交次数 / 交付物 | 最多 6 | ≤ 2 | 09-19 首提即过；09-20 一次被既有规则拒两次 |
| 主张核对可见 | 未显示 | ≥ 90% 行上可见 | 100%（见 5.5） |
| 会话打开（热/冷） | 10–11 s | ≤ 3 s | 热 0.4 s · 冷 7.3 s |
| 收件箱英文原句 | 每条 | 0 | 0 |

**一件必须说明白的事**：09-19 的 22.9 分钟 / ¥2.64 之后，09-20 两次同题跑出 33 分钟 / ¥4.22 与 59.5 分钟 / ¥7.78。四次里最新的两次都高于更早的两次，**把它叫"波动"是偏乐观的读法**；更可能是 09-20 这一版带进来的代价（网页阅读面向全部公开站点、`kb_search` 进了 14 份能力工具表）。当天两次运行的账本行已随测试项目删除，无法事后分解——所以下一步不是再解释，是**在同一版上重跑一次并保留项目**。

---

## 7. 安全与隔离不变式【线上，生产宿主实测】

| 不变式 | 落实 | 状态 |
|---|---|---|
| 运行时不持真钥 | 模型网关 + HMAC 短期工作负载令牌；`DEEPSEEK_API_KEY` 三处不注入 | 测试断言 |
| 外联只经内部网关 | 容器网络只到 `/internal/*`；公共源经 `publicSourceGateway`（主机白名单、私网/链路本地地址拒绝） | ✔ |
| 网页读取 | `web_read` 面向全部公开站点：robots 线性时间匹配、诚实 UA、按站限速、HTML 在工作线程里解析且到期被杀、每个项目最多三个并发读 | 2026-09-20 修复；一次请求曾能冻结整个控制面 16–18 s |
| DNS 重绑定 | `web_read` 把 socket 钉在已核地址（`pinnedPublicLookup`） | ✔；**开放获取 PDF 那条路仍只核不钉**，见 §9 |
| 凭据网关 | 只发放作业所需的连接器凭据（`JOB_SCOPED_CONNECTORS`），其余 403 | 2026-09-20 修复 |
| 公共运行时网关入口 | `/runtime-gateway/` 只在 AgentBay 部署应答，拒绝编码穿越（`%2e/%2f/%5c`、反斜杠、点段） | 2026-09-20 修复 |
| 收到的胶囊 | 整包信任 + 自动扫描；推断条目永不被洗成挂载方法；扫描失败则只作上下文不挂 SKILL.md | 2026-09-20 修复 |
| 进程隔离 | Docker `--cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 8g` + 容器内 Landlock（`fully enforced`） | ✔ |
| 遥测不外传 | `DSH_TELEMETRY_DISABLED=1` | ✔ |
| 热重载关闭 | `hmr.disabled: true`；profile patch 0600 只由控制面写 | ✔ |

---

## 8. 现状

**【线上】**：控制面九个特性模块 · 八个内部网关 · 12 个插座插件 · 18 个能力 · 36 个 MCP 工具 · 六个专科引擎 · 知识库检索与个人文库 · 六分区记忆胶囊与学习回路 · `web_read` · 飞书模块 · 用量按用途分列与运行指标 · 主张逐条核对 · pgvector。

**【已建未开】**：AgentBay 运行时提供方（整条：镜像构建脚本、会话内桥、wss 传输、Context 同步、令牌续期、443 网关入口、生命周期与出网策略）——**缺一把 Pro 密钥**；`web_read` 渲染层（走 AgentBay 云浏览器）默认关；自有 App 的推送与 Bearer、六个预留渠道全部默认关；自研解析接口已接但 `OPEN_SCIENCE_REQUIRE_DOCUMENT_PARSER=false`，**缺一把 `sk-` 密钥**。

**【按决定延后】**：to C 的底座与结算整块——手机号登录、自助注册、免费额度、余额充值、运行前估价、失败不收费、按人存储额度、报告分享链接、节假日计价表。等上线推广时再做。

---

## 9. 缺口（按优先级，全部这次核实）

1. **用量账本的修复还没上生产。** 在它发布前，删项目仍会抹掉该项目花过的钱，并把当天的滚动上限分母降下来。修复已在 main（`9bbdfeae`），随下次发布生效。
2. **深度任务的用时与成本在 09-20 这一版上升了，原因未定。** 见 §6。需要：同一版、同一题、保留项目地重跑一次，对着账本按 `purpose` 分解。
3. **`pnpm audit:capabilities` 红着，它是 `ci:web` 里唯一红的一关。** 工具探针证据停在 2026-07-31（51 天，窗口 14 天），且记录的还是已退役的 `evimed_` 前缀工具名。探针夹具已在这次补齐到 36 个工具（`4e009140b`），但要转绿还需要：跑一次真探针（生产可达，能跑），以及六个专科作业各一份 14 天内的签名回执——其中 MR 需要 **OpenGWAS JWT**（14 天有效期，只有账号主能签，生产上从未配置过）。
4. **八个托管凭据连接器在生产上全是空的**：UMLS、OMIM、Addgene、BioGRID、CORE、OpenGWAS、evimed-evidence、以及 NCBI / openFDA / Semantic Scholar / OpenAlex 的限速密钥。只有 Unpaywall 邮箱配了。后果是术语规范化、遗传病、相互作用这些连接器一律 fail-closed，公共源走匿名限速档。大半是免费注册，十几分钟的事。
5. **五个公开能力从未端到端交付过**：综合药物评价、药品遴选、孟德尔随机化、论文审稿、科研选题。验收台账 `evals/acceptance-ledger.json` 停在 2026-09-10，此后门禁改过判定，台账没更新——**它自己也是缺口**。
6. **开放获取 PDF 那条路仍有 DNS 重绑定窗口。** `publicSourceGateway` 只核地址不钉 socket（注释里写明了）；`web_read` 已经有 `pinnedPublicLookup`，把那条路换成钉 socket 的传输即可，属于一次独立改动。
7. **自迭代回路在生产上从未转过。** 反馈事件只有 20 条，全部是消融留下的记忆接受/拒绝；`distill` / `consolidate` / `episode` / `verify` / `digest` 作业一条都没成功过；方法文档 0 份。不是缺陷，是没有真实使用——这正是接下来要变的。
8. **三个社区 bundle 进了镜像但没在真实会话里各走一遍**：`dsh-cite`（它的 `plugin-support.json` 明写"装上不等于可用：`cite_health` 与一次成功的 DOI 查询要过"）、`dsh-annotation`、`dsh-mermaid`。
9. **语料级覆盖台账与遗漏审计仍缺**：`distillationCompleteness` 契约强制 `not_run`；一次交付读过哪些资料、到哪一层，没有记录。
10. **飞书未验证**：`evimed_channels` 全部 0 行，需要手机扫一次码。
11. **公开仓库里的 Java 密钥**：`anonymous-temp/EviMed-Science` 仍是 public，`ca3fb79b9` 可读到三处硬编码密钥。两件事都要做才算解决——轮换那些密钥，以及仓库转私有或重写历史；只转私有不会让已经被抓走的密钥失效。

---

## 10. 附录

### 10.1 关键文件索引（2026-09-20 核实）

`apps/server/src/`：`agentRuns.mjs`（约 5.3k 行，运行账本与交付判定）· `runtimeManager.mjs`（约 4.1k 行，容器生命周期）· `dshMux.mjs` / `dshEventPump.mjs` / `dshBrowserAuth.mjs` / `dshProfilePatch.mjs`（内核线）· `runtimeControllerServer.mjs` · `modelGateway.mjs` · `publicSourceGateway.mjs` · `kbIndex.mjs` / `kbSearchGateway.mjs` / `kbChunker.mjs` / `kbEmbedding.mjs` · `documentParserClient.mjs` · `memoryIntelligence.mjs` / `researchMemory.mjs` / `memoryRerank.mjs` · `capsuleService.mjs` / `capsuleTransferService.mjs` / `capsuleMethods.mjs` · `usageLedger.mjs` / `usagePersistence.mjs` / `metering.mjs` · `imService.mjs` · `agentbay/` · `webRead*.mjs` · `config.mjs`

`packages/domain/src/`：`clinicalEvidence.mjs`（约 3.8k 行，门禁唯一实现）· `clinical-safety-rules.json` · `contractRegistry.mjs`（26 种）· `capability-contracts.json`（18）· `toolNames.mjs` · `errorCodes.mjs` · `states.mjs` · `capsule.mjs` · `agenda.mjs`

`packages/socket/plugins/`：12 个 · `packages/harness-port/seam-manifest.json` · `capabilities/<id>/` · `runtime/mcp/evimed-research/`（36 工具）· `deploy/runtime-dsh/Dockerfile` · `deploy/web/` · `deps-version.json`

过程记录：工作区根 `STATUS`（一步一行）· `OpenScience/PROGRESS.md`（一个里程碑一行，新的在上）。

### 10.2 与 08-26 版相比作废的段落

08-26 版的 §9.1（MemOS 三级栈）、§10（MinerU 与 `pypdf` 回退）、§13（计量为【设计】）、§14（托管前端自己重写会话面）、§6.3 的限额值（pids 256 / 内存 4g）、§8.1 的"26 工具 / 11 能力"、§16.1 的 pin 列表——全部已被此后的事实取代，不要照它实现或排障。
