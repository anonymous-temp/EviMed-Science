# EviMed Science 架构、流程与算法总览（2026-09-20，2026-09-29 更新）

- **文档性质**：当前系统的独立可读总览。它取代 `2026-08-26-evimed-architecture-overview.md`——那份写于换内核收尾期，此后记忆底座、文档解析、知识库检索、网页阅读、运行时提供方、门禁判定、前端形态全部变过，照它排障会错。**2026-09-29 按现状就地更新一次**（不另写第三份）：新增 §1.1「09-20 之后变了什么」，各层数量、流程、算法里的新机制与新数字就地替换，缺口改为指向 `2026-09-28-EviMed缺口清单.md`。
- **口径**：只写逐条核实过的事实。已上线写【线上】，main 上已提交但生产还没发的写【main 未发版】，代码里有但生产未开写【已建未开】，只有设计写【设计】。每条算法附**实测数字与它的样本量和日期**；没量过的明写"没量过"；这次没能重新核实的旧数字保留原日期——一个没有数字的机制和一个测出来无效的机制，区别正是这份文档要保住的东西。
- **上位文档**：`2026-08-22-evimed-dsh-plug-harness-design.md`（spec，决策仍以它为准）。开发纪律在仓库根 `CLAUDE.md` 的「Development principles」与「Plugin-first architecture and runtime-gate discipline」两节。
- **核实时点**：生产发布 `evimed-754013f21849-1`（DSH 0.1.7-rc.2，2026-09-28 18:35Z 切换），就绪 27/27；本地 main `f097d0f19`。main 上 09-29 的九个提交（`8361abfb2`…`f097d0f19`）**还没推送、没发版**，GitHub main 停在 `6df983afe`。
- **提交号**：公开历史 09-28 改写过，此前的提交号全部变了。本文用的都是改写后的号，发版名（`evimed-<12 位>-N`）仍是旧号。09-20 版写的 `4e009140b` 就是今天的 `f802bbf77`，`9bbdfeae` 就是今天的 `198333969`。

---

## 1. 一句话

> **EviMed Science 是一个面向医学科研的 Agent SaaS：一个 React 控制面 + 每个项目一个隔离运行时；运行时里唯一的执行内核是 DeepSeek Harness（DSH 0.1.7-rc.2），我们的全部科研能力以一个 DSH bundle（`@evimed/dsh-socket`）挂上去；控制面持有租户、账本、门禁、网关、记忆与计量，运行时只在沙箱里做 LLM 工作。**

三处与 08-26 版不同，都是既成事实：

1. **桌面端不存在了。** `apps/web` 是唯一前端，路由在 `/app/*`，`packages/sdk` 与 `src-tauri` 已删。托管会话面**就是运行时容器里那张 DSH 页面**，按项目从另一个端口代理进来（不是我们重写的页面）；「运行」页也改用内核自带的轨迹视图（09-22）。
2. **记忆只有一个形状。** 研究记忆与结构化记录是控制面 PostgreSQL `evimed_memory` 的行，胶囊在 `evimed_product`；OpenViking 是两者共用的**派生召回索引**，永不持有记录，可整体重建。MemOS、Ollama、usememos 全部删除。
3. **门禁不再扣留交付物。** 2026-09-17 裁决之后，运行结束一律交付并附核验标签与问题清单，读者在报告的「依据」里逐条看 ✓/⚠。`failed` 只留给真正没有产物的情形。

### 1.1 09-20 之后变了什么（逐条对过 git log 与 `OpenScience/PROGRESS.md`）

1. **内核换到 DSH 0.1.7-rc.2**【线上，09-28 15:35Z】。会话格式 4，0.1.5 读不了，**回退会丢掉此后写的会话**（切换前 10 个项目、296 MB 的 dsh-home 已归档）。0.1.7 连 DeepSeek 只讲 Anthropic Messages，模型网关为此加了 `/internal/model/v1/messages` 路由；控制面自己的调用仍走 chat/completions，两条路由记进同一本账。预设改成行（`evimed-universal` 是一行），不再有预设目录。新出的宿主面（插件管理、终端、DeepSeek 账号登录、默认改成开的会话日志上传）都写成禁用行，线上 135 个方法拒掉 124 个。工具参数 JSON 解析失败（`MALFORMED_RESPONSE`）加进重试（`608e05219`，线上）；子会话读完结果就释放（`6eefe345a`，main 未发版）。
2. **三个新的一级模块**：「前沿动态」（09-22，知识信源插件 + `evimed_frontier`）；「循证 GEO」（09-25，`evimed_geo` + 四个 GEO 能力，09-29 main 加了品牌自有链接登记）；分级审查（09-23，Qwen3.8-Max 做编辑者，09-24 加 Jev 做首判）。前两个只对运营账号和 cdss-access 开放（缺口 D3）。
3. **记忆胶囊按 09-21 的建设方案重建**，下列各项都在线上：一页式；分享包在导出时由已生效的做法 + 明示偏好 + 整理过的条目拼成（09-21）；签名卡片、预览、指名接收人、原地升级、审计链（09-27）；对话里说「忘掉……」就删掉那条记忆（09-27）；增长折线 `GET /api/memory/growth`（09-28）；收到的包可以只在一个项目里启用（09-28）。学到的做法改成账户级，以卡片随行（09-28）。只有一项还在 main 未发版：试用别人的胶囊时只读那个包（09-29）。
4. **学习回路 09-21 第一次在生产上转起来**，之后修掉了预算、跨项目、计数三类缺陷。09-29 停用了两条从验收运行里学来的做法，它们教运行往报告里写记账内容。
5. **文档解析换成自研接口**：09-20 删掉 MinerU；09-22 实测无需密钥，改为 `REQUIRE=true`。**东京出口节点**（09-22）负责北京被拒的搜索和三个主机。09-28 起 MR 经它读 GWAS Catalog 的公开汇总数据，不再依赖 OpenGWAS 令牌。
6. **IM 与告警**：飞书模块在线，但绑定数是 0。Alertmanager 的告警改送控制面 `POST /api/ops/alerts`，进运维收件箱（此前全被 nginx `return 204` 丢掉，09-28 上线）。
7. **与 EviMed 主站的融合接缝**（09-26）：设计令牌一张表生成六种产物（`@evimed/design-tokens`，已上线）。`evimed` 登录、灵豆扣费（`evimed_credits`，按 EviMed 原始用户号）、「转为深度研究」三处接缝已建好，生产上关着，等 Java 侧接口（缺口 B6、B15）。
8. **验收台账 21/21 accepted**（09-28；09-20 时还有 5 个公开能力从未交付）。**虚拟临研**在分支 `feature/virtual-clinical-research` 上建成，没合并（缺口 E48）。
9. **09-29 的按类修复**【main 未发版】，各条的出处见 §5、§7：
   - 引擎数字以显示字符串进正文；
   - 读者看的报告不再带平台记账；
   - 数值核对能读中文数字写法；
   - 验收与审查项目归为内部项目；
   - 发版切换遇到在跑的工作就拒绝；
   - 引擎可经模型网关调用模型（开关关着）；
   - Specialist adapters retain schema-2 unsigned worker observations; no operator signing key is required (owner decision, 2026-09-29).
   - 数据库微秒时间改在 SQL 里比较。

---

## 2. 十层，以及每层"一个插件"是什么

| # | 层 | 位置 | 插件单元 | 数量（09-29 核实） | 关掉会怎样 |
|---|---|---|---|---|---|
| 1 | 浏览器 | `apps/web` | `/app/*` 下的一页 | 对话、运行（内核轨迹视图）、文件、知识库、主动科研、记忆胶囊、收件箱、科研工具、设置；新增前沿动态、循证 GEO、转为深度研究（关） | 子系统报关则该页隐藏；任何一页都不是发起对话的必经之路 |
| 2 | 控制面 | `apps/server` | `<x>Service.mjs` + `create<X>Routes` + 租约 worker + 一个 `OPEN_SCIENCE_<X>_ENABLED` | sources / autopilot / notifications / usage / capsules / plugins / learning / memory / im，新增 frontier / geo / review / evimed-auth / evimed-credits / agent-memory（对外接口，关） | 按名字回 404/503，其余照常。**这里永不做运行时代码加载**——它是租户边界 |
| 3 | 内部网关 | `*Gateway.mjs` | 一个路径常量 + 一个 handler + 一份白名单 | model（chat/completions + Anthropic Messages + 引擎令牌）· publicSource · webSearch · geoProbe · capsule · revision · connectorCredentials · kbSearch，新增 frontier · geo · review | 网关地址不配 = 该出网按具名错误码拒绝 |
| 4 | 领域 | `packages/domain` | 一个契约种类；`clinical-safety-rules.json` 的一行 | 29 个契约种类（09-20 为 26，新增三个 GEO 资料包）· 21 份能力契约 · 97 个门禁检查 id（09-20 为 85） | 无开关。门禁唯一实现，阻断点预算 6 个 |
| 5 | 防腐层 | `packages/harness-port` + `seam-manifest.json` | 一条缝 | 全仓唯一可 import `@deepseek-ai/*` 的包；0.1.7 挪动的缝：`agent/created`、按生产者署名的来源、子会话目录 | 无开关 |
| 6 | 插座 | `packages/socket` | 一行 cordis 插件 | **13 个**：宿主 `runtime-ui` `plugin-probe` `seam-probe` `evidence-store` `web`；agent `guidance` `run-policy` `evidence` `capsule` `screening` `review` `citation-bridge` `compaction`（每个 agent 级都有开关，全关时会话仍能起，09-27） | 全部关掉，会话仍须能起、能答 |
| 7 | 运行时镜像 | `deploy/runtime-dsh` | 一行工具、一个技能根、MCP server、一份能力清单 | 技能根 core/community/curated-scientific/office，外加构建时追加的 `geo-private`（gitignored）；社区 bundle `dsh-cite` 0.3.2、`dsh-annotation` 1.4.10、`dsh-mermaid` 0.4.0，已按 0.1.7-rc.2 登记 | preset 行 / 技能目录 |
| 8 | 能力 | `capabilities/<id>` | `capability.yaml` + SKILL.md + 契约 + ≥3 份真实题面 | **21**：18 公开（其中 4 个 GEO 为 `listed: false`，只从「循证 GEO」进）+ 3 internal | `visibility` |
| 9 | 专科引擎 | `项目代码/` 六个 Python 引擎 | 一个容器 + HMAC 适配器 | meta / MR / 审稿 / 文献计量 / 选题 / 药安；各有全钉死的 `requirements.lock`（09-28） | 引擎停 = 该能力报 blocked，平台不受影响 |
| 10 | 外部服务 | DeepSeek · 公共源 · OpenViking · OpenList · 自研解析接口 · DashScope（嵌入、重排、Qwen3.8-Max 审查）· TypeSafe Jev · PostgreSQL · 知识信源插件 · 东京出口节点 · GEO 探测主机与社媒采集机 · EviMed Java（登录/灵豆，关） | `deps-version.json` 的一个 pin + `packages/contracts/<dep>` | — | 换 provider 不换 consumer |

配置单点 `apps/server/src/config.mjs`，489 处 `OPEN_SCIENCE_*`（446 个不同的键；09-20 为 373 处）。**compose 的兜底值不得低于代码默认值**，有测试挡着——生产曾因此跑了几周 pids 256 / 内存 4g，而代码写的是 1024 / 8g。

---

## 3. 数据实际落在哪

| 存储 | 内容 | 备注 |
|---|---|---|
| PostgreSQL（pgvector 0.8.6 / PG 16.15） | `evimed_control`（用户、项目、会话）· `evimed_product`（documents/revisions/jobs 账本、胶囊、做法、反馈事件、插件状态）· `evimed_usage`（模型请求账本）· `evimed_memory`（记录与笔记）· `evimed_inbox`（通知）· `evimed_channels`（IM 绑定、聊天、投递）· `evimed_kb`（知识库文档与分块，含 `vector` 与 `pg_trgm`）；09-20 后新增 `evimed_frontier` · `evimed_geo` · `evimed_review` · `evimed_credits` · `evimed_agent`（对外记忆接口） | 每晚备份，恢复演练做过；**没有异地备份**（缺口 A4） |
| 知识信源插件自己的库 `evimed_knowledge` | 信源登记、抓取账本、条目 | 09-27 起有自己的每日备份 |
| 项目数据卷 | 每用户每项目一棵工作区：`.evimed-brief/`、`deliverables/<id>/`、`.evimed-run/state.json`、`.openscience/runs.jsonl`、知识库原文 | **项目删除即整棵删除**；学到的做法是账户级，不随项目删（09-27） |
| OpenViking | 记忆与胶囊的召回索引 | 派生，`pnpm rebuild:memory-index --all` 可重建 |
| 对象/卷 | 胶囊快照与密钥、说明书索引（140,279 条）、药学参考库、MR 的 GWAS 下载缓存卷、药安的 openFDA 缓存卷（09-29 main） | — |

**账目纪律（09-20 的缺口，已上线）**：用量账本过去随项目级联删除，删一个项目就把它花过的钱从账上抹掉，连带把 24 小时/7 天滚动上限的分母降下来（09-20 实测：清理验收项目带走约 1,700 条已结算记录）。外键改成 `ON DELETE SET NULL (project_id)`（`198333969`），09-21 起每一版都带着；完整性检查把置空的行误当孤儿的问题同日修掉（`7d72a05ad`）。

---

## 4. 五条主干流程

### 4.1 一句话提问 → 回答（零工具）

```
浏览器 → POST /api/agent-runs/dispatch
  → 路由：会话已绑定能力则照旧 → 请求点名某专科自己的交付物则去那里
          → 否则 LLM 分类器（关思考）读意图 → 委托动词规则只是它下面的网（specialistRouting.mjs，258 行）
          → 其余与分类器的每次失败都落答案线
  → 记忆召回（无条件，不由路由决定；试用他人胶囊时暂停——main 未发版）写入 .evimed-brief/memory.md
  → reserveRun → 复用/启动项目运行时（空闲保留 12 h）→ 生成 profile patch（0600）→ session.create(evimed-universal 预设行)
  → session.prompt → 首个 agent/pre-step：run-policy 一次性 inject 题面与上下文
  → 模型直接回答，不写计划、不强制检索；内核经模型网关的 Messages 路由调 DeepSeek
  → turn/end → 控制面折叠为账本四值 + 投影九态 → SSE /api/runs/:id/events
  → 带引用的回答再异步走一遍 L1 回复核对（Jev 首判，其余交 Qwen）
```
**实测**：25 秒、¥0.046（2026-09-20，n=1）；09-22 一道普通问题 2 秒答完、未调工具（n=1）。会话打开的数字见 §6。

### 4.2 深度任务 → 交付

```
① 路由 → 契约种类（如 clinical-evidence-report）；被路由的一轮直接以该能力身份工作，方法已在上下文里
② evimed_plan 写 task-plan.json（deliverables[{id, contractKind, capability, dependsOn, studyType?}]）
③ 需要分工时 evimed_delegate 起子代理：能力清单 → toolFilter + 预注入 SKILL.md + persona + outputSchema
   委派非阻塞，父代理用 evimed_await 收；maxDepth=1；一次运行最多 30 个子代理、同时最多 30 个
   子会话结果读完即释放（main 未发版）
④ 检索：MCP 工具 → tools/result 观察 → 证据表 queued→ready；全文落 .evimed-sources/
⑤ 主张级工具：evimed_claim_upsert 逐条写入并按门禁自己的规则判定；evimed_render_report
   让正文编号与参考文献与矩阵一致；evimed_package_check 给同样的裁定而不花一次提交
⑥ evimed_submit_deliverable：整理编号与参考文献 → runGate（@evimed/domain）→ 分级审查（开时）
   一次返回三者；标「需回应」的审查发现下次提交在 responses 里回 fixed/declined
⑦ 这一轮结束就是这次运行结束（evimed_complete_run 09-20 退役）；本轮结束前文件都还能改
⑧ 控制面从卷上读取工作区（容器生死与判定无关）→ reconcileSession 逐件重跑同一份校验
⑨ 一律交付 + verification 标签 + 问题清单（SAFETY 在前，MUST FIX 在后）；报告里每条主张 ✓/⚠
```

### 4.3 上传 → 知识库 → `kb_search`

```
上传/OpenList 导入 → 内容寻址 src_<sha256> → jobs 队列（SKIP LOCKED + 租约）
  → 纯文本格式：本地逐字读取（逐字引证要的就是原始字节）
  → PDF/Office/图片/EPUB/HTML：自研解析接口（协议 v1，无需密钥；解析失败即报错，没有备用解析器）
  → 音视频：按名拒收（415）
  → DOI 经 Crossref 核对；index.md 带书目头与页标记（接口还不给页码）
  → kbIndex 分块 → tsvector（CJK 双字）+ pg_trgm + pgvector，向量分批补
  → 内部能力 source-understanding 在账户的内部项目 evimed-sources 里抽取结构化理解
运行侧：kb_search（MCP）→ /internal/kb/v1/search → 小库(<150K token)直接答"去读这几个文件"
```
知识库即项目里的文件（09-24）：读完即可用，资料的事实跟着资料走，不进记忆胶囊。解析服务现在连的是对方的测试服，原文经明文 HTTP 走公网（缺口 C1）。

### 4.4 记忆

```
派发前：召回（OpenViking 向量 → 控制面重排 → 预算装配）→ .evimed-brief/memory.md
运行中：evimed_capsule_recall / evimed_capsule_note（唯一的记忆端口）；学到的做法以卡片随行，适用时再读全文
运行后：抽取（关思考，120 s 上限）→ 记录写 evimed_memory，六分区胶囊，
        superseded_by / invalid_since，每处自动改动可撤销；「忘掉……」一句即删
学习回路：交付 / 纠正（含在内核窗口里的插话）/ 同一能力每第 3 次运行 自动触发
        → 在隐藏的 evimed-learning 项目里 distill / consolidate → 做法（账户级，生效即带「新」）
        默认不设时间与金额上限（09-21）；停用靠做法自己运行结局的序贯检验，不再逐条跑离线配对评估（09-22）
分享：导出时拼包（做法 + 明示偏好 + 整理条目）→ 签名卡片 → 预览 → 指名接收 → 试用 / 按项目启用
```

### 4.5 发布

```
本机：全量 CI（test:web + 审计 + build:web，Node 22.22.0）→ 打 delta 包
主机：host-delta-release.sh 播种 releases/<NEW>（运行时增量，或 EVIMED_RUNTIME_BUILD=full 走六个镜像源）
      移动内核 pin 的发版必须全量构建，且先备份各项目 dsh-home（0.1.7 那次 296 MB）
      host-engine-delta.sh 把六个引擎镜像做成运行中镜像的增量（requirements.lock 变了就拒绝，那是全量构建）
      知识信源插件镜像单独在主机上构建，名字写进该版 .env
      env 改动 → host-release-switch.sh 经 current 符号链接切换 → 就绪 27/27 → 界面走查（09-28：46 页 0 失败）
      切换自己重启所有经 current 绑定挂载的容器，并从容器内逐个核对挂载（09-27；此前监控曾因此失明数日）
      切换前先问线上版本在跑的运行、作业与忙碌运行时，有就拒绝（--allow-active 可越过；main 未发版，下一版起生效）
      retention --keep 2
```

---

## 5. 算法清单与实测效果

这一节是这份文档的重点：**每条算法做什么、参数写在哪、量过什么、数字多少、哪些没量过。**

### 5.1 路由（题面 → 能力）

- **机制**：会话绑定优先；其次请求点名某专科自己的交付物（`routeNamedSpecialist`）；否则 LLM 分类器 `specialistClassifier.mjs`（默认开，关思考）读意图；`specialistRouting.mjs` 的委托动词规则只是分类器下面的网；其余与分类器的每次失败都落答案线。09-20 版写的"正则先判、未命中才走分类器"说错了：代码 09-20 以来没改（`specialistRouting.mjs` 零改动），是当时的说明文件过时，09-29 已随 `8361abfb2` 改正。
- **实测**：评测配对跑必须钉能力，否则同一臂会被分到三个能力上——这正是 memory-ablation v1–v4 全部作废的原因。只按词表判的时候，33 份委托临床证据综述的题面里有 6 份被错路由到别的专科（见 `specialistRouting.mjs` 注释），这是规则退成"网"的原因。日常运行没有做过路由准确率的系统测量。
- **没量过**：路由准确率、分类器超时率的线上分布。按原则 2，规则不再扩张。

### 5.2 知识库检索 `kb_search`【线上】

- **机制**（`kbIndex.mjs`，09-29 核对参数未变）：小库（< 150K token）直接回"读这些文件"，不检索；大库三条腿——tsvector（与记忆召回同一个 CJK 分词器）、pg_trgm（药名与拼写错误）、pgvector 余弦；每条腿出 50 个候选，RRF **k = 60** 融合，取前 30 给 `qwen3-rerank`，带一句针对"临床药师/医学研究者提问"的 instruct。缺了扩展或密钥的腿直接跳过并在结果里说明；重排失败保留融合序。每个命中带 UTF-16 偏移，片段就是那一段原文（700 字符）。
- **实测**：固定回归集 `apps/server/test/fixtures/kb-regression.json`（合成语料 + 六类问题：药名、剂量、缩写、拉丁名、拼写错误、无共同词的改述）——**每类问题的答案都在前三，改述题经重排排到第一**；线上一次真实上传后 `kb_search` 被模型选用并引用了正确剂量（09-20）。
- **没量过**：真实语料上的召回率/精确率，以及"小库阈值 150K"这个数（来自一条公开建议加上我们的缓存命中率，不是本地实测）。大库路径至今没在真实数据上跑过（缺口 E44）。

### 5.3 记忆：召回、抽取与学习【线上】

- **机制**：召回在每轮派发前无条件执行（不由路由开关）；候选来自 OpenViking 向量，控制面重排，按预算装配；预算对持久记忆留位，避免运行摘要把长期画像挤掉。抽取在运行后异步跑，关思考，上限 120 s，写入前过结构判断（我们自己注入的 `<evimed-brief>` 等闭合标记一律不读）。GEO 运行与主动科研一集都记下自己召回了什么（09-27）。
- **实测（这是唯一有对照的一组，值得完整读）**：

| 批次 | 门禁形态 | 计分格 | 结论 | 效率 | 证据完整性 | 任务效用 | 安全 |
|---|---|---|---|---|---|---|---|
| v9 | 阻断式 | 12 | **worse** | 0.578→0.578 | 0→0 | **0.450→0.250**（CI −0.367~−0.033） | 0.900→0.967 |
| v10 | 不阻断（现行） | 12 | inconclusive | 0.758→0.783 **better** | 0.467→0.633 | 0.800→0.767 | 0.867→0.933 |
| v11 | 不阻断 | 4 | inconclusive | 0.776→0.860 **better** | 0.600→0.900 **better** | 0.650→0.900 | 1.000→0.900 |

  读法：v9 那次"更差"是在**阻断式门禁**下测的，两臂大多数格子根本没交付（12 格交付 5 格），差异更像交付失败的噪声。门禁改成不阻断之后，两批都是**效率更好、证据完整性更好，任务效用中性偏正**。三批的样本量分别是 12、12、4 格、两个题族，**没有一批足以下结论**。
- **学习回路（09-21 起）**：
  - 09-21 第一次有效配对评估单元，评分 4/5/5/5，花费 ¥1.65（n=1）。
  - 09-22 起停用改由做法自己运行结局的序贯检验（SPRT）判定。理由：原来的小样本档永远"无结论"；按实测方差模拟，完整档在约六条无害做法里会错撤一条。
  - 「挂载 34 次、调用 0 次」查明是计数缺陷：做法全文被内联，模型从不需要打开文件。09-28 改为以卡片随行，同日 cde-001 真的读用了学到的做法（n=1）。
  - 学习花费 30 天 ¥72.19，其中 ¥62.63 是 09-21 一次 37 格的配对评估；09-22 以来只花 ¥2.30（09-28 读账本）。
- **没量过，而且是最要紧的那个**：三批操纵的都是四条通用偏好记录，**没有一批测过胶囊**。能证明胶囊成立的实验是"切换成 A 的胶囊后，输出是否可测地向 A 的方法靠拢"——从未跑过；两个账号走一遍"导出→导入→试用→启用→停用"也没在生产演示过（缺口 E35）；做法的开关对照（约 ¥10）没做（D11）。v11 的安全分 1.000→0.900 是唯一需要盯着的反向信号。

### 5.4 交付门禁【线上】

- **机制**：
  - 规则只有一份，在 `packages/domain/src/clinicalEvidence.mjs`（约 4.2k 行）。运行侧经 `evimed_submit_deliverable` 调到它，控制面经 23 行的再导出 shim 调到它，有测试钉住两侧判得一样。
  - 主张分三型：`direct / synthesized / derived`。药物与场景规则放在 `clinical-safety-rules.json`，药师可改，不动代码。
  - 报告正文禁止出现工具名、网关名、产物路径、第一人称检索日记。
  - **门禁检查 id 共 97 个（09-20 为 85）**，运行内必修的仍只有 18 条：12 条 `blocking`（包读不出来，或读者看不见缺陷）+ 6 条 `safety`（临床措辞），其余 79 条都是建议。
  - 09-28 起，引用来源检查和 `citationsResolvable` 也在运行自己的门禁里跑，运行在本轮内就能看到、能改。
- **实测（2026-09-17，12 次线上运行）**：运行时间的 **63%** 花在提交/修复回环；**0/12** 包一次通过；扣留它们的 52 条问题里 **65%** 是包自己的记账（覆盖台账行号、运行回执统计、自评质量检查），15% 是有可见误报的措辞模式，约 **10%** 是门禁真正存在的理由——引语不在它所声称的来源里。
- **据此做的**：`CLINICAL_CHECK_TIERS` 只保留完整性与安全两类为运行内必修，其余降为建议；包自述的六个文件连同读它们的检查一起删除；服务端修复轮默认 0。**效果**：v10/v11 两批的任务效用从 v9 的 0.45/0.25 抬到 0.80/0.77 与 0.65/0.90。
- **09-29 的按类修复**【main 未发版，`51bb0f477`】：
  - 通读 19 个能力已验收的交付，8 个的报告里带着给平台看的记账内容（验收项对照、可核对项索引、字段名、AI 自拟的利益冲突声明）。根因是一条链：计划 → 审查 → 学到的做法。三处都已改掉，14 个能力技能加了同一段「读者得到什么」。另加一条仅作提示的 `report_package_vocabulary`（闭合词表取自包自己的 JSON）。
  - 数值核对能读「至」区间、中点小数、a×10⁻ⁿ 和年龄段标签。在 09-28 EMPA-KIDNEY 那份包上，数字提示从 16 条降到 10 条，真正读错的那条（74%）仍会报（n=1 份包）。

### 5.5 主张核对与分级审查【线上】

- **主张核对**：`claim_verification` 命令 → domain 的 `claimVerification`；报告里每条主张带 ✓/⚠，读者在「依据」浮层看到引语与来源。**实测**：09-18 两件交付物 74/74 与 65/66；09-19 69/71；09-20 106/106 条核对可见；09-21 基准复跑 69/69 条逐字核对；09-28 临床证据综述 review-001 共 66 条结论，其中 19 条带「数字不在所引原文里」提示。
- **分级审查**（`reviewTier.mjs`，09-23 起，开关 `OPEN_SCIENCE_REVIEW_ENABLED`，代码默认关、生产开）：
  - **分级**：按可判定属性分 L0–L3。L0 什么都不查。L1 是带引用的对话回复，做异步 ✓/⚠：Jev 先判，置信度 ≥ 0.8 且句子不提药名才算"支持"，其余交 Qwen3.8-Max（关思考）。L2 是文字交付物：全覆盖的确定性检查，加一遍 Qwen3.8-Max 编辑者，再在原处修一轮。L3 在 L2 之上，把正文里的数字追溯到引擎输出。
  - **报告规范清单**：计划声明 `studyType` 时挂上对应清单（CONSORT 2025、TRIPOD+AI）。
  - **定级**：新检查一律只作建议。审查发现的编号跨轮不变（09-29 main）。
  - **为什么不用运行时里的审查器**：09-22 前内核里的同模型审查器，在 29 件交付上报了 129 条发现，真的只有 3 条，已退役。
- **实测**：
  - 真实交付的两遍审查每遍 ¥0.49–0.83、2.5–6 min，作者逐条回应（09-23）；带引用的回答 8.5 s 出判定、¥0.03（09-23）。
  - Jev 在 101 对主张/引文上 100/101 判对，阈值 0.8 下 40 条真支持里放行 37 条，0 条误放行（09-24）。上线后第一条回复 4 句里 1 句由 Jev 放行，¥0.0007，对照 Qwen ¥0.039。
- **没量过**：约 900 条审查发现从没按类别统计过，L1 ⚠ 的误报率没测过；"来源打不开"这类基础设施噪声也以 ⚠ 显示给读者（缺口 E32）。

### 5.6 成本与缓存【线上】

- **机制**：
  - **账本**：网关处预留 → 结算 → 释放/不确定，四态。
  - **用途**：`purpose` 列 09-20 是 9 个值，现在 14 个——`kernel / memory-extraction / routing / title / engine / capsule-scan / channel-intent / source-understanding / learning / frontier / review / geo / web-search / other`。
  - **计价**：Jev 按美元计价，按 CFETS 6.7489 折算。
  - **引擎用量**：六个 Python 引擎的 DeepSeek 用量经签名 `POST /internal/usage/v1/engine` 事后回传。
  - **清扫**：过期预留有清扫作业。
  - **`uncertain` 行**：09-26 审计时生产上有 649 条，其中 479 条来自 09-23 DeepSeek 余额耗尽那次。每条都按整笔预留压在滚动窗口里，而预留按缓存未命中定价，约是结算额的 70 倍。09-27 起改为按"它最多可能花了多少"计入，不超过预留。
- **实测**：缓存命中 97.7–98.3%（09-19/20）；09-21 基准复跑 96.6%。深度任务成本见 §6。
- **引擎经模型网关**【main 未发版，开关 `OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED` 默认关，`b059e5864`】：
  - **做法**：适配器接作业时凭工作负载令牌 + 请求体 HMAC 换一张按作业签发的凭证。引擎用它调网关，每次调用预留、结算，花费记在这次运行名下，`docker-compose.engine-keyless.yml` 可把 DeepSeek 密钥从五个适配器容器里拿掉。
  - **为什么不开**：网关只放行一个经认证的模型，而且强制开思考。引擎的 flash/pro 两档和不思考的小调用都会变样：实测一次 200 token 的小调用变成 1,879 token、9.5 s（n=1）。
- **注意**：`purpose` 无回填——这个列之前的行一律是 `other`，猜一个用途在报表里和记下来的用途长得一模一样。

### 5.7 专科引擎（确定性）【线上】

六个 Python 引擎做统计与检索：Meta（numpy/scipy）、MR（R；09-28 起可只用 GWAS Catalog 公开数据，OpenGWAS 变成可选）、药安信号（ROR/PRR/χ²/IC/EBGM）、文献计量、选题、审稿（15 份报告规范 YAML）。**LLM 永不做统计**。

- **09-28 生产验收**：
  - MR mr-001：IVW OR 1.533（95% CI 1.351–1.740），64 个工具变量，五种估计量方向一致，数字与引擎记录逐字一致。
  - Meta ma-001：2 项多臂 RCT、3 个对比，总失血量 MD −251.06 mL（−345.34 至 −156.77），τ²=0，GRADE 极低。纳入 5 项只有 2 项进了合并，这个问题还在缺口清单上。
- **下载吞吐**（09-28 生产实测）：北京直连 EBI 约 19 KB/s；经东京单流 345–358 KB/s，晚间丢包时会塌到约 30 KB/s；改成 6 路 × 8 MiB 并行分段后约 1.5 MB/s。
- **引擎作业心跳**：运行中每 30 s 写一次心跳，慢作业不再被当成死作业（09-27）。
- **09-29【main 未发版】**：
  - **显示规则**：MR、药安、选题、文献计量四个引擎按同一份规则（AMA 手册 §19.4、STROBE-MR、READUS-PV）在原值旁写显示字符串，技能只抄显示值。此前 mr-001 报告里印的是 `OR 1.53311316166586`。
  - **MR 两项诊断**：Steiger 改从 GWAS-SSF 元数据读样本量，mr-001 输入离线复跑为 p=1.9×10⁻¹⁹²、方向支持 BMI→CAD；MR-PRESSO 写出校正估计，去掉 2 个离群位点后 OR 1.59（1.43–1.77）。
  - **药安**：按 FAERS 季度版本缓存，结果写明数据日期。
  - **Specialist job evidence**: shared adapters stage jobs privately and retain request/input/artifact hashes as unsigned worker observations. D14 is cancelled by the owner: no Ed25519 private key or UID switch is an admission prerequisite. Historical signatures remain readable; tenant request authentication and the separate DeepSeek compatibility HMAC remain unchanged.
- **自身测试**：meta 引擎 pytest 2795 通过 / 4 跳过、test_deep 155/155（09-28）；文献计量 50、MR 145（09-20，这次没重跑）。

### 5.8 重排（记忆与知识库共用）

`memoryRerank.mjs`：构造函数的 `instruct` 是实例默认值，每次调用可覆盖；失败一律 fail-open 到向量序。模型经 DashScope 钉在 `deps-version.json`（嵌入 `qwen3.7-text-embedding` 1024 维，重排 `qwen3-rerank`）。**实测**：记忆召回评测 12 题上的 recall@5，词项匹配 0.667 → 加嵌入 0.933 → 再加重排 1.000（09-14，n=12，`evals/memory-recall`）。09-27 起重排的成败计入运维指标，连续失败会告警。

---

## 6. 目标与实测

2026-09-18 核查定下的目标，逐条对到 09-29 能指认出处的最新实测（没有更新的保留原日期）：

| 指标 | 09-18 起点 | 目标 | 最新实测（日期、样本） |
|---|---|---|---|
| 深度任务用时 | 17–60 min（基线 79） | ≤ 15 min | 基准题：09-20 30.2 min · 09-21 26 min。能力验收（不同题目）：09-28 cde-001 20 min、geo-strategy 17 min、geo-proposal 14 min、临床证据综述 27 min |
| 每次运行成本 | ¥3.31（无归因） | 可归因、≤ ¥1.5 | 可归因已做到；基准题 09-20 ¥3.44（周日半价时段）· 09-21 ¥5.53（工作日全价，token 少约 1/3） |
| 工具调用中文件/shell 占比 | 77% | ≤ 30% | 47%（09-19，之后没重测） |
| 工具调用总数 | 505 | — | 363（09-19）；09-21 基准复跑 177 次模型请求 |
| 提交次数 / 交付物 | 最多 6 | ≤ 2 | 09-20、09-21 基准复跑两件都是第 1 次提交即过 |
| 主张核对可见 | 未显示 | ≥ 90% 行上可见 | 100%（见 5.5） |
| 会话打开（热/冷） | 10–11 s | ≤ 3 s | 同项目热 0.4 s（09-20）；新浏览器热开 3.2–3.4 s（09-22）；跨项目热切换 0.17–0.2 s、冷切换 11.5 s（09-24，0.1.5 内核）；**0.1.7 上没重测**（E16） |
| 收件箱英文原句 | 每条 | 0 | 0；后台作业不再进收件箱（09-22） |
| 能力有真实交付且通过 | 5 个公开能力从未交付（09-20） | 21/21 | **21/21 accepted**（台账 09-28；其中 19 项是在 0.1.5 上验收的，09-29 在新版本上整套复跑，结果未出） |
| 常驻接入审查 | 111/149（09-26 基线） | 全绿 | 131/149（09-29 00:00Z）；18 项异常中 13 项等负责人给账号或密钥 |
| 前沿·信源健康率 | — | ≥ 95% | 按 6 天抓取账本（12,016 次轮询）逐小时回放 0.970 → 0.988（09-28） |
| 前沿·工作日精选条数 | — | 15–30 | 阈值 82 回放 2,259 条，四个工作日估 14/26/29/24（09-28）；还没在真实的一天里观察过 |
| 前沿·事件错并率 | — | ≤ 5% | 13.3%，没复测（E40） |

**基准复跑（2026-09-20 15:55，项目 `0920c`，同版同题，项目保留）**：**30.2 分钟 / ¥3.44 / 274 次请求 / 缓存命中 97.7%**；两件交付物都是第一次提交就通过（`delivered:1:pass`），主张 106 条其中 91 条 ✓，12 条全部是 `advice` 级提示（9 条「数值未出现在引文中」、3 条「综合结论的多源支撑不完整」），同会话追问 1.9 秒答完，控制台 0 错误。**09-21 再跑同一题（项目 `0921a`）**：26 分钟、177 次请求、输入 30.1M（缓存 96.6%）、¥5.53、两件都第 1 次提交即过、69/69 条逐字核对、追问 12 秒。贵出来的部分是计价时段（09-20 是周日半价），按 token 算约少三分之一。0.1.7 上还没跑过这道基准题。

09-20 那次按 `purpose` 分解（账本修复后第一次能回答的问题）：

| purpose | 请求数 | 花费 | 占比 |
|---|---|---|---|
| kernel | 266 | ¥3.363 | 96.3% |
| engine（药物安全，4 次作业） | 4 | ¥0.094 | 2.7% |
| memory-extraction | 2 | ¥0.035 | 1.0% |
| routing | 2 | ¥0.002 | ~0 |
| title | 2 | ¥0.000 | ~0 |

**读法**：钱几乎全花在任务自己的推理上，辅助模型（路由、标题、记忆抽取）合计 ¥0.037，占 1%，所以"关掉某个辅助模型来省钱"不是一条有意义的路。同一题四次跑出 59.5 / 33 / 30.2 / 26 分钟，¥7.78 / ¥4.22 / ¥3.44 / ¥5.53，落在 09-18 的 24–27 分钟附近，59.5 分钟那次是外点。离 ≤15 分钟 / ≤¥1.5 的目标仍有约一倍的距离。下一步仍是按阶段拆开 kernel 那两三百次请求，而不是再跑一次。审查（`review`）、联网搜索（`web-search`）、GEO、前沿这些新用途在基准题上的占比，还没有同样的分解。

---

## 7. 安全与隔离不变式【线上，生产宿主实测】

| 不变式 | 落实 | 状态 |
|---|---|---|
| 运行时不持真钥 | 模型网关 + HMAC 短期工作负载令牌；`DEEPSEEK_API_KEY` 三处不注入；审查（DashScope）与 Jev 的钥都只在控制面 | 测试断言。**专科引擎容器仍持 DeepSeek 钥**，拿掉它要开 5.6 那个开关 |
| 外联只经内部网关 | 容器网络只到 `/internal/*`；公共源经 `publicSourceGateway`（主机白名单、私网/链路本地地址拒绝）；北京被拒的三个主机与重试页面经东京节点（只放行北京源 IP，squid 带认证） | ✔ |
| 网页读取 | `web_read` 面向全部公开站点：robots 线性时间匹配、诚实 UA、按站限速、HTML 在工作线程里解析且到期被杀、每个项目最多三个并发读；脚本绘制的页面由本机 frontier-browser 渲染，每次渲染配一个只放行已核公网地址的前向代理（09-28） | ✔ |
| DNS 重绑定 | `web_read` 与开放获取 PDF 都把 socket 钉在已核地址（`pinnedPublicLookup`；PDF 那条 `ab23d48e0`，09-28 上线） | ✔（09-20 的缺口已关） |
| 内核界面面 | 0.1.7 新出的宿主面写成禁用行，线上 135 个方法拒 124 个；会话日志上传是禁用行，网关也拒 | ✔（09-28） |
| 凭据网关 | 只发放作业所需的连接器凭据（`JOB_SCOPED_CONNECTORS`），其余 403 | ✔ |
| 公共运行时网关入口 | `/runtime-gateway/` 只在 AgentBay 部署应答，拒绝编码穿越（`%2e/%2f/%5c`、反斜杠、点段） | ✔ |
| 收到的胶囊 | 整包信任 + 自动扫描（09-27 起含有毒中药与剂量上限）；推断条目永不被洗成挂载方法；扫描失败则只作上下文不挂 SKILL.md | ✔ |
| GEO 与临床回答之间的防火墙 | 每次 GEO 派发都带平台标记，循证 GEO 与临床回答之间的隔离有测试钉住（09-27） | ✔ |
| 进程隔离 | Docker `--cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 8g` + 容器内 Landlock（`fully enforced`） | ✔；生产的核验运行仍是 `isolated:false`（控制器协议 6，缺口 E30） |
| 遥测不外传 | `DSH_TELEMETRY_DISABLED=1` | ✔ |
| 热重载关闭 | `hmr.disabled: true`；profile patch 0600 只由控制面写 | ✔ |
| 告警送达 | Alertmanager → `POST /api/ops/alerts` → 运维收件箱（绑了飞书的同时推送） | ✔（09-28；此前全部被丢弃） |
| 公开仓库 | 09-28 改写 GitHub 全部历史：五个 Java 目录和描述宿主平台安全问题的文字已删；09-29 起密钥扫描覆盖 `docs/`（main 未发版） | 旧密钥仍须轮换（A1），gitee 旧镜像未处理（A19） |

---

## 8. 现状

**【线上】**：
- 控制面十五个特性模块（evimed-auth、evimed-credits、agent-memory 三个在生产上关着）；十一个内部网关；13 个插座插件；21 个能力（18 公开，4 个只在 GEO 里出现）。
- MCP 工具注册 41 个，生产提供 40 个，`patent_search` 按 09-03 的裁定不提供。
- 六个专科引擎（MR 可以不用令牌）。
- 知识库检索与个人文库；自研解析接口。
- 记忆胶囊（分享、签名、增长折线、按项目启用）与学习回路；分级审查（L1 Jev + Qwen）。
- `web_read`（含本机渲染）；联网搜索（百炼千问 + 东京 SearXNG，1.7–2.4 s、4–8 条相关，09-22）。
- 前沿动态与循证 GEO，都只对运营账号 + cdss-access 开放。
- 飞书模块；告警进收件箱；用量按 14 个用途分列；主张逐条核对；pgvector；设计令牌 2.x。

**【main 未发版】**：09-29 的九个提交（§1.1 第 9 条）。它们要推送、过 CI、发一次版，再在新版本上把 21 个能力整套复跑一次。

**【已建未开】**：
- **AgentBay 运行时提供方**：整条已建（镜像构建脚本、会话内桥、wss 传输、Context 同步、令牌续期、443 网关入口、生命周期与出网策略），**缺一把 Pro 密钥**（A12）；网页渲染已不再依赖它。
- **Engine model gateway** (5.6); specialist job observations need deployment verification, not an owner signing key (D14 cancelled).
- **融合接缝**：`evimed` 登录、灵豆扣费（汇率 `CREDITS_PER_CNY` 未定，D1）、「转为深度研究」、对外记忆接口（给中医 CDSS）。
- **渠道**：自有 App 的推送与 Bearer，以及六个预留渠道，全部默认关。
- **自助注册**：默认关。
- **虚拟临研**：在工作树 `wt-vcr` 的分支上，文件还没提交；含 39 张表的 `evimed_vcr`、R 引擎 24 种方法、五个能力；引擎数值用例 51/51（09-29 00:53Z）；没合并，也没构建镜像。

**【按决定延后】**：to C 的底座与结算整块——手机号登录、自助注册、免费额度、余额充值、运行前估价、失败不收费、按人存储额度、报告分享链接、节假日计价表。融合方案改由灵豆在 EviMed 侧统一计费，接口就绪前仍不开。三项花费上限按负责人 09-21 的要求为 0（不限，D2）。

---

## 9. 缺口

**唯一的缺口清单是 `docs/superpowers/specs/2026-09-28-EviMed缺口清单.md`**（按"谁来补"分组：A 负责人、B EviMed 团队、C 其他团队、D 待拍板、E/Q 工程；每行写着怎么确认补上了，能用常驻审查核的写了 `run.py --id` 编号）。这里不再重复，只交代 09-20 版列的十二条各自去了哪里：

| 09-20 的缺口 | 09-29 状态 |
|---|---|
| 1 用量账本修复没上生产 | **已关**：`198333969` 09-21 起随版上线（§3） |
| 2 深度任务两倍时间和成本 | 仍在：基准题 09-21 26 min / ¥5.53（§6）；0.1.7 上没重测 |
| 3 `audit:capabilities` 红 | 仍红：09-28 按生产重录，工具注册 41 / 提供 40 / 认证 32；6 specialist tools need current hosted execution evidence (E9; D14 signing-key prerequisite cancelled)；连接器 63/64（GtoPdb 要密钥，A17） |
| 4 花费上限全是 0 | 仍是 0，负责人 09-21 的要求（D2）；`uncertain` 行虚高已按估计值计（§5.6） |
| 5 托管凭据连接器空 | 部分仍空：NCBI/openFDA（A7）、Semantic Scholar/OpenAlex（A13）、GtoPdb（A17）；OpenGWAS 已变可选（A8） |
| 6 五个公开能力从未交付 | **已关**：台账 21/21 accepted |
| 7 开放获取 PDF 的 DNS 重绑定 | **已关**：`ab23d48e0`，09-28 上线 |
| 8 自迭代没转过 | 09-21 起在转；计数缺陷 09-28 修掉；插话纠正计数待真实对话确认（E7）；能力手册那半边没有生产者（D16） |
| 9 三个社区 bundle 没走过真实会话 | `dsh-cite` 09-27 在生产上第一次 `effective`；annotation/mermaid 的开关对照没做（E44） |
| 10 语料级覆盖台账与遗漏审计 | 单份资料的遗漏抽检以提示形式存在（`sourceUnderstandingOmissionNotice`，5%/15% 目标没经真实分布校准）；交付级的阅读台账这次没复核 |
| 11 飞书未验证 | 仍是 0 绑定（A6） |
| 12 公开仓库里的 Java 密钥 | GitHub 历史 09-28 已改写；密钥仍须轮换（A1）；gitee 旧镜像（A19） |

---

## 10. 附录

### 10.1 关键文件索引（2026-09-29 核实）

`apps/server/src/`：`agentRuns.mjs`（约 6.8k 行，运行账本与交付判定）· `runtimeManager.mjs`（约 6.4k 行，容器生命周期）· `dshMux.mjs` / `dshEventPump.mjs` / `dshBrowserAuth.mjs` / `dshProfilePatch.mjs`（内核线）· `runtimeControllerServer.mjs`（协议 6）· `modelGateway.mjs` / `modelGatewayEngineTokens.mjs` · `publicSourceGateway.mjs` · `edgeProxy.mjs` · `kbIndex.mjs` / `kbSearchGateway.mjs` / `kbChunker.mjs` / `kbEmbedding.mjs` · `documentParserClient.mjs` · `memoryIntelligence.mjs` / `researchMemory.mjs` / `memoryRerank.mjs` · `capsuleService.mjs` / `capsuleTransferService.mjs` / `capsuleMethods.mjs` · `learningService.mjs` · `review*.mjs` / `replyCheckJev.mjs` · `frontier*.mjs` / `knowledgePluginClient.mjs` · `geo*.mjs` / `mediaMarketClient.mjs` / `socialCrawlClient.mjs` · `evimedAuthService.mjs` / `evimedCreditsService.mjs` · `agentMemory*.mjs` · `alertReceiver.mjs` · `usageLedger.mjs` / `usagePersistence.mjs` · `imService.mjs` / `channels/` · `agentbay/` · `webRead*.mjs` · `specialistRouting.mjs` / `specialistClassifier.mjs` · `config.mjs`

`packages/domain/src/`：`clinicalEvidence.mjs`（约 4.2k 行，门禁唯一实现）· `clinical-safety-rules.json` · `contractKinds.mjs` / `contractRegistry.mjs`（29 种、97 个检查 id）· `capability-contracts.json`（21）· `toolNames.mjs`（MCP 41、插座工具 13）· `usagePurpose.mjs`（14）· `reviewTier.mjs` / `reviewFindings.mjs` · `geo/` / `geoMetrics.mjs` · `frontierVocabulary.mjs` · `errorCodes.mjs` · `states.mjs` · `capsule.mjs` · `agenda.mjs`

`packages/socket/plugins/`：12 个文件 + `index.mjs` 里的 `runtime-ui`，共 13 行 · `packages/socket/src/subagentRun.mjs` · `packages/harness-port/seam-manifest.json` · `capabilities/<id>/` · `runtime/mcp/evimed-research/`（41 工具）· `deploy/runtime-dsh/Dockerfile` · `deploy/web/`（含 09-29 入库的 `nginx/`）· `deps-version.json` · `项目代码/knowledge-plugin/`

验收与审查：`OpenScience/evals/acceptance-ledger.json`（21 行）· `outputs/audit/integration/`（常驻接入审查，149 项、307 条只读检查；gitignored）。

过程记录：工作区根 `STATUS`（一步一行）· `OpenScience/PROGRESS.md`（一个里程碑一行，新的在上）。

### 10.2 作废的说法

**08-26 版**的 §9.1（MemOS 三级栈）、§10（MinerU 与 `pypdf` 回退）、§13（计量为【设计】）、§14（托管前端自己重写会话面）、§6.3 的限额值（pids 256 / 内存 4g）、§8.1 的"26 工具 / 11 能力"、§16.1 的 pin 列表——全部已被此后的事实取代，不要照它实现或排障。

**本文 09-20 版**里 09-29 改掉的说法：
- DSH 0.1.5-rc.2；
- "正则先判、未命中才走分类器"；
- `evimed_complete_run`（09-20 当天已退役）；
- 学习回路的"北京时间夜间窗"；
- 12 个插座插件、18 个能力、36 个 MCP 工具、26 种契约、85 条检查、373 处配置；
- 就绪 24/24；
- 缺口清单十二条（去向见 §9）。
