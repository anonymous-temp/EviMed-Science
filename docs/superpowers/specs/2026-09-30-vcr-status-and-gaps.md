# 虚拟临研（vcr）：交付状态、验收对照与缺口清单

2026 年 9 月 30 日 · 分支 `feature/virtual-clinical-research`（工作树 `wt-vcr`）· 模块默认关闭（`OPEN_SCIENCE_VCR_ENABLED`）

这份文件回答三个问题：**做到哪一步了、方案的 38 条验收各自靠什么证明、还差什么。**
方案本身在同目录：`2026-09-28-EviMed虚拟临研平台方案.md`（v2.0，另有 PDF 与 `2026-09-28-virtual-clinical-research-assets/` 里的 14 张界面稿、研究底稿与飞书外壳补丁）。
两份契约是建造和修复时的裁定依据：`2026-09-28-vcr-build-contract.md`、`2026-09-29-vcr-integration-contract.md`。

## 一、当前状态

| 项 | 状态 |
|:--|:--|
| 代码 | 已提交在本分支，已合入 9 月 30 日的 `main`（无冲突） |
| 是否合入 `main` | **没有。** 分支已推到 GitHub，合并由你决定；合并前后都不改任何默认行为 |
| 是否上线 | **没有。** 没有发版、没有构建引擎镜像、没有真实 DSH 对话验证、没有伙伴数据 |
| 默认行为 | 关。`OPEN_SCIENCE_VCR_ENABLED` 不设就看不到入口、`/api/vcr/*` 不存在；开也先只对运营账号（`OPEN_SCIENCE_VCR_AUDIENCE=operators`） |
| 规模 | 分支比 `main` 多 344 个文件、约 13.2 万行：服务端 27 个模块（约 2.6 万行）、领域包 7 个文件、R 引擎 20 个文件（24 种方法）、前端 56 个文件、五个能力包 |

### 怎么审、怎么合

1. 合并前先读这份文件，再读集成契约（它记了每个接缝的规则）。
2. 提交按层排列，`git log --oneline main..HEAD` 可逐个看：先是 6 个基线提交（领域、控制面、引擎、能力包、前端、文档），然后是 9 月 29 日合并审查之后的三轮修复（契约 → 领域 → 引擎 → 路由与接线 → 展示层与前端 → 数据入口 → 证据与匹配 → 安全修复），最后是 9 月 30 日的收尾（领域、控制面、前端、能力包、CI，各一个提交）。
3. 合并是普通合并；`PROGRESS.md` 顶部的一行是这条分支自己加的，如果 `main` 同时有人在顶部加行，会碰到一个平凡冲突，两行都留即可。
4. 合并后，在**发版当天**做第五节的清单；清单里有一半是只有部署好的栈才能做的检查。

## 二、验证结果（9 月 30 日，合并后的树）

| 检查 | 结果 |
|:--|:--|
| `pnpm lint`（web、server、domain、harness-port、socket） | 0 错误（`LoginPage.tsx` 有一条与本模块无关的既有告警） |
| 类型检查：web、server、domain、harness-port、socket | 全部通过 |
| `@evimed/domain` 测试 | 551 / 551 |
| 服务端 vcr 测试（38 个文件，**逐个文件串行**，对本地 PostgreSQL 55433） | 全部通过（两个需要 R 的接缝测试见下面两行） |
| 前端 vitest（全量） | 1718 项：首轮 1717 通过、1 项失败（模型库对话框用了平台已退役的「采纳」，改为「引入」）；该项复跑通过 |
| MCP、port、socket 测试 | 通过 |
| `check:capabilities`（26 个清单）、`check:tool-graph`（23 张图）、`check:skill-vocabulary`、`check:skill-digests` | 都是最新 |
| `audit:source-secrets`、`audit:hosted-compliance`、`audit:saas-alignment` | 通过 |
| `test:release-audit`、`test:acceptance-ledger`、`test:eval-briefs` | 通过 |
| R 引擎数值验收（`tests/run_all.sh`，2 核） | **108 / 108** 条 `vcr_case`（覆盖 N00-N30、C2-01…、E01…、S01、Z99；参照包 rpact、gsDesign、WeightIt、survRM2、RBesT、EValue、metafor 等的对照都在内） |
| 引擎服务测试（pytest，`tests/service`） | 49 / 49 |
| 真实引擎接缝测试（`VCR_R_LIBS` 指向 R 库、`VCR_ENGINE_TESTS=required`） | `vcrEngineContract.integration` 13 / 13，`vcrIntake.integration` 21 / 21，无一跳过 |

全量服务端套件（CI 模式，不接 PostgreSQL）：4815 项，4091 通过，711 项因需要 PostgreSQL 或 R 而跳过（这些在上面逐文件跑过），首轮 13 项失败全部来自第七节第 4 条，已修，重跑 `release-full-build.test.mjs`（19）与 `deploy.test.mjs`（68）通过。

**托管 CI（GitHub Actions，手动触发 `web.yml`，运行 36689642955，提交 `b82cb38bf`）：**

| 任务 | 结果 |
|:--|:--|
| `vcr-r-library`（由两份锁生成 R 库并证明与锁一致） | 通过 |
| `vcr-engine`（108 / 108 个数值用例、引擎服务 pytest、数值日志完整性检查） | 通过 |
| `vcr-seam`（真实引擎接缝测试对 PostgreSQL） | 通过 |
| `gallery` | 通过 |
| `web`：一直到「Audit production dependencies」之前的每一步（含 Node 22.22.0 下的服务端 4104 项、共享认证状态、持久化产品状态、DeepSeek 兼容闸门、契约测试、合规审计） | 通过 |
| `web`：「Audit production dependencies」 | **失败，与本分支无关**：新公布的公告 GHSA-q2hr-2g5m-vwhr（`brace-expansion`，经 `apps/web > exceljs > archiver/glob/minimatch` 引入，6 项：4 高 2 中）。本分支没有改任何 `package.json` 或锁文件；主线跑到这一步同样会红。修法是在根 `package.json` 加 pnpm 覆盖并重生成锁文件，这会动整个平台的依赖，也会在主机上引起长时间的安装占用，所以没有夹在这个分支里做 |
| `web`：审计之后的步骤（前端类型检查、前端测试、前端构建） | CI 里被这次失败挡住没跑；在本机用官方 Node 22.22.0 跑了：类型检查通过、vitest 168 个文件 / 1718 项全过、构建成功 |
| `hosted-production-e2e` | 失败，与本分支无关：只在手动触发时运行，需要 `OPEN_SCIENCE_E2E_BASE_URL` 等仓库密钥，没有密钥就报 `hosted_e2e_configuration_missing` |

说明：`pnpm test:server` 并行跑整个服务端套件时，共享 PostgreSQL 上会出现 `deadlock detected` 一类波动。这是主干本来就有的问题（不含 vcr 测试的对照跑也是 50 项失败对 35 项），所以本模块的验证一律按文件串行。

## 三、方案验收 AC-01…AC-38 对照

分类：**仓库内已证明**＝测试存在且断言的正是标题所说；**仅夹具证明**＝引擎或运行被替身顶替；**发版才能做**；**待负责人提供**。
“引擎数值”指 `项目代码/vcr-engine/tests/numeric/` 里的用例（编号 N/C2/E/S），“服务端”指 `apps/server/test/vcr*.test.mjs`。
台账测试 `vcrAcceptance.test.mjs` 保证每个 AC 编号都出现在某个测试标题里；标题是否名实相符，靠审查而不是靠台账。

| AC | 场景 | 靠什么证明 | 类别 |
|:--|:--|:--|:--|
| 01 | 首次使用：四个研究动作进入真实可配置的流程 | 前端首页/框架选项测试；服务端 `vcrService`、`vcrOrchestrator.integration`（运行调度为替身） | 仅夹具证明；真实对话属发版检查 |
| 02 | 无患者数据：声明参数化人群完成参考虚拟试验 | 引擎 E09、N25b、N28c；`vcrEngineContract.integration`（真实 R 引擎、T0 研究） | 仓库内已证明（需 R + PostgreSQL，CI 任务跑） |
| 03 | 队列来源：观察、合成、插补、预测值可区分 | `vcrDataPlane`（列自带值来源、插补列不能读成观察）、`vcrAccess`；引擎 C2-03、N16、N17 | 仓库内已证明 |
| 04 | 在声明容差内复现 | 引擎 N00a-l、N01、N06、N21、Z99、C2-01/04/07、E05、E10a-d | 仓库内已证明（引擎层；服务端按哈希复放存储的执行**未确认**） |
| 05 | 方案新版本：新评估引用新版本，旧的仍可看 | `vcrOrchestrator.integration`、`vcrEvidenceMatching.integration` | 仓库内已证明 |
| 06 | 试验期限制：看不到的治疗或结局不读、不推、不由模型补 | `vcrDataPlane` 五条（未知治疗不等于未治疗、空白分组按缺失原因计数） | 仓库内已证明 |
| 07 | 人群不重叠：外部对照只报局限，不报无依据的效应 | 引擎 N09/N09b/N09c、N11、N19b、N21b、S01d（熵平衡无解给 `not_estimable`） | 仓库内已证明 |
| 08 | 加权：原始 n、权重、事件、ESS 一致 | 引擎 N07-N09、N11b、N13b、N14、N15b、E04、N24b；`vcrEngineContract` T1 | 仓库内已证明 |
| 09 | 扩增样本不是新增真实患者，也不掩盖模型不确定性 | 引擎 E04、E09、N17、N25、N28c、N29、C2-05、S01b | 仓库内已证明 |
| 10 | 零假设模拟：一类错误带蒙特卡洛误差，按预设标准判断 | 引擎 N01b、N03、N20、N22、E07b、E08 | 仓库内已证明 |
| 11 | 备择模拟：把握度、偏倚、覆盖率在声明精度内 | 引擎 N02、N04、N08、N22、N28a-c、C2-02、C2-10b、E10c、S01 | 仓库内已证明 |
| 12 | 事件时间：时间零点、事件、删失、分析时间按冻结定义 | 引擎 N10、N11、N11b、N13、N13b、N24c | 仓库内已证明 |
| 13 | 模型不适用：给出适用性问题，不编造预测 | `vcrOrchestrator.test`（`vcr_model_not_applicable`：终点、必需字段、拟合范围都在作业排队前拒绝）；`vcrJobs.integration` | 仓库内已证明（台账把它记在别的测试名下，实质测试的标题没写 AC-13） |
| 14 | 入排条件未知：既不算满足也不算一定不合格 | `vcrMatching`（未知不折成不满足、洗脱期顺延）、`vcrComposition`；引擎 C2-15/16、N29 | 仓库内已证明 |
| 15 | 匹配回放：评估之后的信息不进入回放 | `vcrMatching`、`vcrDataPlane`（as-of 一直到引擎读的字节）；引擎 C2-13、N29 | 仓库内已证明 |
| 16 | 来源更正：受影响的结果标为过时并指出要重做什么 | `vcrOrchestrator.integration` 三条、`vcrRoutes` | 仓库内已证明（`source_corrected` 那条直接写入快照行，没有走上传到新快照的全程） |
| 17 | 跨租户：读、作业、缓存、下载、导出都守范围 | `vcrAccess`、`vcrMembers`、`vcrDataPlane.integration`、`vcrRoutes`、`vcrComposedApp.integration`（每条路由 × 每个角色走真实服务） | 仓库内已证明（没有缓存层可测） |
| 18 | 联系授权：未走流程不会有信息到达患者 | `vcrRecruit`、`vcrContact.integration`、`vcrComposedApp` | 仓库内已证明（本模块没有对患者的外发通道） |
| 19 | 作业失败与取消：状态、部分产出、成本、重试准确 | `vcrJobs.integration`；引擎 E03 | 仓库内已证明（“成本”是 CPU 秒，不是金额） |
| 20 | 每个数字都对应一份保存的结果 | `vcrRender`、`vcrGateway`；引擎 C2-06、C2-15、N28a | 仓库内已证明 |
| 21 | 复核完整性：版本变了，复核失效或标为被取代 | `vcrOrchestrator.integration`、`vcrViews`、`vcrRoutes` | 仓库内已证明 |
| 22 | 退出与揭盲：退出不打开原试验结局分析 | `vcrRecruit`、`vcrAccess`、`vcrDataPlane.integration`（封存字段） | 仓库内已证明 |
| 23 | 预测验证：预测早于结局有时间戳，改动产生新版本 | `vcrOrchestrator.integration`、`vcrEvidenceMatching.integration`；引擎 C2-12 | 仓库内已证明（只有入组预测有真实“实际值”，试验把握度预测要等真实试验出现） |
| 24 | ≥3 份真实简报，其中一份是伙伴漏斗的入组回测 | `vcrAcceptance`：五个能力共 18 份简报，检查数量与长度 | 仅夹具证明；发版才能做；待伙伴提供（简报没有运行器，五个能力的 `realDelivery` 都是 `not-run`） |
| 25 | 证据参数可追溯到原文 | `vcrEvidence`（数值不在引文里就拒绝并存为未知）、`vcrComposedApp`、`vcrEvidenceMatching.integration` | 仓库内已证明（用的是注册库记录夹具；从真实文献全文抽取属发版检查） |
| 26 | 行级数据不到模型；不出现小于 10 的格子 | `vcrIntake.integration`（对每条运行时读路径做指纹扫描）、`vcrDataPlane`、`vcrRuntimeBoundary`、领域 `vcrSuppression`；引擎 N23、N24、N30、E06、E10a | 仓库内已证明（真实一次运行后扫描模型网关请求日志，发版清单里要**补上**） |
| 27 | 重建的伪个体不算真实、不画成真实 KM；质控不合格排除 | 引擎 N16、N17、N17b、S01d | 仓库内已证明（仅引擎层） |
| 28 | 每个模拟指标都带蒙特卡洛标准误；重复次数够目标精度 | 引擎 N00e/g/k、N03-N05、N20、E01、E05、S01；`vcrEngineClient`、`vcrRender` | 仓库内已证明 |
| 29 | 解析与模拟在标准设计上相差不超过 3 个标准误 | 引擎 E07、E07b、E08、N02-N04、N06b、N22、S01c/e | 仓库内已证明 |
| 30 | 跨软件一致（N01–N21） | 引擎 N01–N21、N00b、Z99；参照包 rpact、gsDesign、WeightIt、survRM2、RBesT、metafor、cobalt、EValue、simsurv、flexsurv 只在测试锁里 | 仓库内已证明（IPDfromKM 不在任何锁里，重建靠往返检验 N16） |
| 31 | 同种子，1 核与 8 核逐位相同 | 引擎 N06（1、4、8 核与续跑）、N06d、N00l、N28b、E10c | 仓库内已证明（8 核在测试机内进程内验证，没有单独的 8 核硬件跑） |
| 32 | 结局封存：冻结计划前结局不可读，两个时间戳有序 | `vcrAccess`、`vcrSeal`、`vcrIntake.integration`、`vcrDataPlane` | 仓库内已证明（真实包封面属发版检查） |
| 33 | AI 设定值在复核前带标；复核指向版本 | `vcrGateway`、`vcrOrchestrator.integration`、`vcrRoutes`、`vcrViews`；引擎 C2-09/10/14 | 仓库内已证明 |
| 34 | 模型证据不足时自动降用途并给理由 | `vcrService`、`vcrOrchestrator.integration`（三种降级） | 仓库内已证明 |
| 35 | T0 从一句话到结果 ≤2 小时 | 链路在 `vcrOrchestrator.integration`（替身运行）和 `vcrEngineContract.integration`（真实引擎）里跑通，**都没有计时** | 发版才能做（真实 DSH + DeepSeek + 注册库出网 + 4 核主机上的引擎） |
| 36 | 中文匹配基线：伙伴病例、两位医生 | `vcrMatching`（16 格混淆矩阵、召回、评者一致性上限；C2-20 用随附的 7 例**合成**集） | 仅夹具证明；待伙伴提供 |
| 37 | 入组回测：伙伴漏斗、80% 区间覆盖 | `vcrRecruit`、引擎 E02（300 个合成试验）、N27a-d | 仅夹具证明；待伙伴提供 |
| 38 | 超预算作业停在确认；取消立即生效并保留已完成批次 | `vcrJobs.integration`、`vcrEngineContract.integration`（真实引擎）、引擎 E03 | 仓库内已证明（预算是 CPU 秒，没有金额预算） |

汇总：**仓库内已证明 33 条；AC-01 只有替身运行；AC-35 只能在部署后计时；AC-24、36、37 要伙伴数据（36、37 现在只有合成夹具，24 的简报还没有运行器）。** AC-01、AC-26 的“真实那一半”也在发版清单里。

## 四、缺口清单（方案承诺、分支没有做到的）

按“谁来补”分。编号沿用审查时的编号，方便对照；审查里的 G13（金额预算）并入 4.2 的 P5，G15（引擎自己实现算法）并入 4.4。

### 4.1 工程缺口（我们自己补）

| # | 缺口 | 位置 | 影响 |
|:--|:--|:--|:--|
| G1 | 单臂、单臂加外部对照的**试验设计仿真**被按名拒绝（Simon 二阶段只有解析计算；单臂精确二项分布没有解析路径） | `vcrScenarioSchemas.mjs`、`vcrOrchestrator.mjs`、`vcr-analysis/SKILL.md`、`R/design_simulate.R` | 方案 §5.4 把它们列在首版范围。外部对照的**对照臂**分析（加权、MAIC）是有的，缺的是设计仿真 |
| G2 | 交付物是 Markdown + `results.json`，没有 Word/PDF/HTML 渲染，CDE 沟通包是 `.md`；引擎结果表是 CSV（已裁定，见 4.4） | `capabilities/vcr-package/capability.yaml`、`vcr-package/SKILL.md` | 方案 §8.3 承诺 Word/PDF/HTML；申办方期待 Word 与 PDF |
| G3 | 方法库不显示数值测试结果与前提假设（`validation_pack` 由模型写，没有按方法版本存储的要求、测试与变更记录）；顶部菜单只提供 4 种导出里的 2 种 | `vcrService.mjs`、`vcrViews.mjs`、`VcrStudyPage.tsx` | 方案 §8.2/§8.3 卖的“系统验证包”没有数据来源。修法：发版时把 CI 的数值结果写进 `methods` 行 |
| G4 | `VCR_SOURCE_FORMATS` 仍含 `parquet`，来源可以登记成 parquet 却永远读不进来 | `vcrDataPlane.mjs`、`vcrVocabulary.mjs`、`intakeState.ts` | 已裁定的偏差（见 4.4），但词表与实现不一致 |
| G5 | 病历文档只收 `.txt`/`.md`（1 MB）；数据文件上限 50 MB、500 列、200 万行 | `vcrDataPlane.mjs` | 医院病历多是 PDF、Word、扫描件；没有用平台的文档解析。真实病历做匹配前要先转文本 |
| G6 | 没有医院平台、专病库、FHIR、OMOP、ADaM 导入适配 | 方案 §8.1“第二阶段” | 伙伴数据来的格式要等拿到样本才能做 |
| G7 | 没有 KM 曲线数字化工具；曲线点由运行或人给出，来源声明是 `digitizer\|human_click`，没有检查模型是否自己填了 | `R/reconstruct.R`、`vcrScenarioSchemas.mjs` | 方案 §6.2、§11.4 要求确定性数字化，使“读图”不可能由模型完成 |
| G8 | 注册库覆盖：ClinicalTrials.gov（结构化）+ ChiCTR 仅列表（经 EviMed 证据 API），后者没有臂、结局、计划对实际；缺少 EviMed 证据 API 凭据时静默关闭。CDE、EU CTIS、WHO ICTRP 没建 | `trialRegistryClient.mjs`、`vcrComposition.mjs` | 中国先例除 CT.gov 的多国记录外无法量化 |
| G9 | 对照引擎缺：AIPW、加权 Cox 风险比与比例风险诊断、协变量集替换、阴性对照结局、缺失结局临界分析（现有：E 值与权重 99 分位截断）；事件时间 MAIC 未实现；二分类/事件时间的 PROCOVA 被拒 | `R/engine.R` | 方案 §5.3 的敏感性分析清单 |
| G10 | `soa_items`（访视日程）和 `regulatory_contacts` 只有建表，没有读写；`vcr-protocol` 没有日程步骤 | `vcrPersistence.mjs` | 方案 §11.2 第 8 层与 §5.3 都承诺；空表会误导读者 |
| G11 | 没有病种知识包与“AI 草拟”的最小包；没有人群定义库（复用、创作、使用计数）；版本比较只显示数量与存档的画像行，没有版本间 SMD | 无 | 方案 §3.3、§5.1；“跨病种通用”的说法靠病种知识包 |
| G12 | 模型分析计划与报告（ICH M15）只有证据键字符串，没有冻结和生成；方案 §5.2 的两种模型包接口只定义了机理模型一种 | `vcrVocabulary.mjs`、`R/population.R` | 只发场景/文献两类模型时无碍；阻挡“中风险”用途上限 |
| G14 | 引擎每张表只收一个 `valueSource`（该表里最弱的列来源）；`columnSources` 没进 R 验证器 | 集成契约 §6 | 有一个插补列的表，在引擎里整体标为“插补” |
| G16 | 预测的 `public` 标志能存能设，但没有任何路由、页面或导出去公开一份预测 | `vcrGateway.mjs`、`vcrPersistence.mjs` | 方案 §5.4 的“可选对外公开”没有出口 |
| G17 | 复核者的修改不会变成评测用例（方案 §10.2、原则 6）；协调员改判存成了评价集但没有导出 | `vcrMatchStore.mjs` | §7.5 的自我改进闭环只有数据 |
| G18 | 招募材料（问卷、患者说明、话术）是运行写的可选文件 `recruitment-drafts.md`，没有审阅与发布流程，也没有患者自填通道 | `vcr-matching/SKILL.md` | 方案 §7.2 要求草稿须经团队审阅；目前没有强制也没有记录（首版没有面向患者的一侧，影响低） |
| G19 | 方案附件 C2 里没有测试的用例：C2-08（引擎里的适用性副本）、C2-11（虚拟人群选择）、C2-17（合成副本的合并规则）——被测代码因没有任何调用者而在收尾中删除，用例随之删除（适用性检查在控制面的 `vcrModelApplicabilityIssues`，在那边测；后两者没有替代实现）；C2-21（USDM 往返；`usdm` 只是 jsonb 列）、C2-22（Circe 回归）、C2-25（词表版本固定）、C2-26（LLM 人群请求边界）从未有测试；C2-20 跑的是 7 例合成集，不是 n2c2/CHIP-CTC；C2-19 只测规则求值器，不测 LLM 抽取 | 附件 C2；`R/quality.R`、`R/population.R`、`vcrMatching.test.mjs` | 方案 §13.1 G 包承诺 C2-01…C2-26；虚拟人群选择与合成副本合并规则是方案里有、分支里现在没有的功能 |
| G20 | 文档与代码的小出入：引擎 README 说真实患者方法需要 `observed` 行而代码接受观察/抽取/计算/插补；README 用例族只列到 N29 而 N30 已存在；`/api/me` 用 `features.vcr`，方案写 `features.virtualResearch` | `vcr-engine/README.md`、`R/inputs.R`、`server.mjs` | 文档与代码冲突，改文档即可 |
| G21 | 平台常驻接入审查登记表里**没有** vcr 条目（GEO 有 `worker.geo`、`cap.geo-*`、`source.geo-probe-host`） | `outputs/audit/integration/registry/`（主工作区，不在本分支） | 方案 §13.3：登记表里不绿，模块就不算做完 |
| G22 | 界面上复核者、改判者显示的是账号 ID（如 `u_stat`），不是姓名；表现层没有接用户目录 | `vcrViewsKit.mjs`、`vcrViewsTabs.mjs`、`DataTab.tsx` | 真实账号下会显示 `usr_…` 一类内部编号，发版前应接上姓名解析 |

### 4.2 需要负责人或伙伴提供

| # | 缺什么 | 用在哪 |
|:--|:--|:--|
| P1 | 伙伴的样本数据与历史转诊记录 | AC-24（入组回测简报）、AC-36、AC-37；G5、G6 的适配格式也要靠它定 |
| P2 | 一台独立算力节点（方案建议 16 核） | 设计网格和大规模合成；当前主机是 4 核 |
| P3 | EviMed 证据 API 的凭据 | ChiCTR 列表接入（G8）；没有它，中国先例一栏静默为空 |
| P4 | 统计复核者、临床复核者的人选 | 复核角色、AC-21/33 的真实使用；方案第三阶段 |
| P5 | 裁定：要不要给模块加金额预算 | 现在预算单位是 CPU 秒；自动派发的七类运行没有模块级金额上限（`OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY` 因无人读取已删除；生产平台限额本来也是 0） |
| P6 | 裁定：首版要不要补 Word/PDF 交付（G2） | 申办方的期待与工程量的取舍 |

### 4.3 发版当天的清单（只有部署好的栈才能做）

完整版在 `OpenScience/docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md` 末节「虚拟临研：只有部署后才能做的检查」，包含记录表。这里列要点，并标出审查发现清单里**没有**、我们补上的项：

1. 提交已合并的树后，让 CI 的 `vcr-r-library`、`vcr-engine`、`vcr-seam` 三个任务在合并提交上跑绿；再跑 `pnpm ci:web`、`check:capabilities`、`audit:source-secrets`、发布清单校验。`audit:capabilities` 需要活的运行时，开发机上不会过。
2. **环境键到达 web 容器**：新一版的 `.env` 是从上一版复制来的，缺新键；只比对键名，不比对值；确认 `/api/ready` 的 `vcr` 为 `ok`、`engine: wired`。
3. **引擎镜像**：`docker compose --profile vcr build evimed-vcr-engine`（走 apt/pip/CRAN 镜像，CRAN 快照日期与 Dockerfile 一致）。首次构建要编译约 62 个 R 包，会把 4 核主机压满，建议错峰或另找机器；日志里要有 `package lock verified` 与 `engine 1.0.0 R 4.3.3 with 24 methods`。以后改引擎走 `scripts/ops/host-engine-delta.sh`，改 `requirements.txt` 或 R 锁则必须全量构建。
4. **权限与密钥**：数据面目录属主 web 用户、组 10001、权限 0750；两个密钥文件 0440、组 10001、不少于 32 字节；`evimed-vcr-jobs-init` 退出 0；没有任何运行时容器挂载 `/data-plane`；用一个 T0 `design.analytic` 作业验证签名回执。
5. **迁移排练**：`postgres-backup.py restore-clone` 之后 `node scripts/vcr/migrate-check.mjs <clone>`，记 `firstRunMs`；生产上没有违规行后 `VALIDATE` 那条 `NOT VALID` 的联系批准人外键。
6. **（补）重建运行时镜像与内核框架**：镜像要带 `vcr_platform.py`（五个工具）、五个能力的清单与技能、框架里的「虚拟临研」选项；框架资源只来自组合它的运行时，旧镜像不会出现入口。这一步在第 7 步之前。
7. **五次真实 DSH + DeepSeek 运行**（一次性项目，每个能力一份简报），含“停掉引擎”的工具失败检查；结果记入五个 `vcr-*` 的 `realDelivery` 行（`pnpm check:acceptance-ledger`）。**（补）** 在一次带合成患者文件的 T1 运行后，对模型网关的真实请求日志做行值指纹扫描——这是 AC-26 的字面要求，清单里原先没有。
8. **AC-35 计时跑**，用秒表。**（补）** 先从生产主机确认 clinicaltrials.gov 与 EviMed 证据 API 可达；北京出口受限，东京节点是后备。出不去，T0 的证据一步就跑不了。
9. **最后再打开**：`OPEN_SCIENCE_VCR_ENABLED=true`，`OPEN_SCIENCE_VCR_AUDIENCE=operators`，验收账号走 `_PREVIEW_USERS`；不要开 `all`。发版切换会杀掉在跑的运行，等没有运行再切。
10. **登记与交接**：在平台常驻审查登记表加 vcr 条目（工作者、五个能力、引擎服务、CT.gov 信源、`vcr_platform` MCP）；把四个 `vue-patch/*.patch` 交给 EviMed 的 Vue 团队。

### 4.4 有意与方案不同的地方（已裁定，写在集成契约里）

| 偏差 | 理由 |
|:--|:--|
| 入口收 CSV、TSV、JSON 记录和 XLSX，**Parquet 在上传时按名拒绝**（提示导出 CSV） | 控制面自己读字节做校验和派生，没有 Parquet 读取器；医院导出是 CSV/XLSX；引擎镜像里的 pyarrow 只用于把 Parquet 作业输入转 CSV。需要时在入口处转换，而不是让控制面多一个解析器 |
| 引擎结果表是 CSV，不是 Parquet | 固定的 R 库里没有 Parquet 写入器（没有 `arrow`）；表很小；清单按 sha256 固定每张表，与格式无关 |
| 引擎自己实现加权、RMST、设计计算；rpact、WeightIt、survRM2 等只在测试镜像里做交叉验证（测试锁 96 个包，运行时 62 个） | 方案 §11.4 列的是生产包清单；这里刻意不同，交叉验证由数值用例担保，运行时的分歧提示只有 `design.simulate` 的 `analyticCheck` |
| 汇总（pooling）在 `vcr-engine` 的 `evidence.pool`，`项目代码/meta` 不动 | 2026-09-28 的裁定，避免给 meta 引擎添出口 |
| 输入框第三个控件「数据」不是控件；不加“预计 1～2 小时”一行 | 前者是数据面的入口在数据页；后者是 2026-09-22 的界面裁定 |
| 报告里模板自带的数字被替换成「未计算」并报告，而不是拦下交付 | 原则 4：闸门的判定不扣留交付；数字全部应是引用 |
| 一切 vcr 的闸口都是“通知”，没有新增阻断点 | 平台阻断点预算是 6，本模块没有占用 |

## 五、这一轮为什么会有这些修复

9 月 29 日的合并前审查（六位独立审查者，三个维度：方案对照、代码、交付）的核心结论：**各部件各自严谨，接缝没有接上**。浏览器读的形状服务端从不发送；编排器造的引擎作业引擎读不了；引擎会对作业里的字符串求值；快照输入取自调用方；小格子抑制只覆盖了没有任何存储会产生的形状。

修复分三轮，由子代理按简报做、主控合并并逐项验证：

- **A 波（契约与部件）**：领域包放下所有接缝（两种封闭规则语法、每种方法一份场景模式、结果、抑制、错误码）；引擎不再对数据求值、输入只来自数据面、服务带认证；路由落在模块自己的存储上、角色按操作、联系停止在同一事务里；展示层成为浏览器与服务端之间的唯一页面契约，共享 JSON 夹具两边同读。
- **B 波（接缝）**：引擎作业端到端、T0 链在真实引擎上；数据面入口（上传、字段映射、快照、授权）；证据与匹配经运行时接线；输入框、界面。
- **C 波与收尾（安全与真实）**：关掉三个安全洞（`locationX` 一类键夹带输入、列名进公式造成代码执行、平面地址与哈希漏给运行）；数据面的 as-of 一直到引擎读的字节；值来源逐列；报告里的手打数字；复核只认当前版本；CI 三个任务、R 库由锁生成、迁移排练；这份文件所在的这一提交。

其中 C 波最后两个子代理被中断（主机内存不足，其中一个的命令以 137 退出），改动还在工作树里；主控接手后补齐了它们未完成的几处：R 测试运行器里写死的机器路径、两个错误码的登记、共享夹具重生成与一条前端断言，并把三处契约补充写进集成契约。

## 六、给下一位维护者的三个坑

- **R 里的 `$` 会按前缀匹配**：对来自数据或调用方的 JSON，一律用 `[["key"]]` 加按种类的键白名单；公式只能由 `as.name` 造出的符号拼，绝不能用粘贴或解析出的列名拼字符串。
- **主机有两个文件系统**：`/` 是 30 GB，`/home` 是另一块 79 GB，工作树、缓存、仓库都在 `/home`。看 `df /` 说明不了问题；`/home` 写满会把共享的本地 PostgreSQL（55433）打死。
- **服务端全量并行套件不可信**：见第二节；改 vcr 后请逐文件串行跑。

## 七、收尾时的七处修补

C 波子代理被中断后，主控接手时发现并补上的：

1. 引擎测试运行器（`run_all.sh`、`run_all.R`、`test_service.py`）和 README 里写死了这台机器的 R 库路径——换一台机器测试就什么也检查不到。现在 `VCR_R_LIBS` 是唯一的指定方式，没有默认值；`vcrCiWorkflow.test.mjs` 会扫描这些文件，出现机器路径就失败。
2. 展示层新增的复核者信息让一条前端断言过时（旧夹具里复核者为空）；夹具重生成，断言改为期望复核者。
3. 模型库对话框的文案用了「采纳」，被 `retiredWords.test.ts` 拦下；改为「引入」。

4. 网页镜像的 Dockerfile 为「虚拟临研」多了一行 `COPY scripts/vcr`（数据面把快照画像脚本当子进程跑，镜像里没有它，第一次遇到真实数据时每个快照画像都会因缺文件而失败）。`scripts/ops/release-full-build.mjs` 把“唯一被接受的网页配方”钉成了哈希，所以全量服务端套件里 `release-full-build.test.mjs` 有 13 项失败——这是本分支自己造成的回归，不是既有波动。已按该文件里的惯例重新钉哈希并写明原因，19 / 19 通过。

5. **Node 22 会取消“只剩一个 unref 定时器”的测试**：托管 CI 钉 Node 22.22.0，本机是 Node 24。`vcrEngineClient` 和 `trialRegistryClient` 的截止时间定时器是有意 unref 的；等这个截止时间的测试在 Node 22 上被判“事件循环已空”而取消，一个文件里 8 项连带取消，`web` 任务在这一步就停了，后面的步骤都没跑。测试里挂起的替身现在自己持有事件循环（像真实套接字那样），在官方 22.22.0 下复现并验证。（同一类问题的旧记录：CI 曾因此红了 11 天。）
6. **一个测试靠了随机 ID 的排序**：`vcrEvidenceMatching.integration` 的 AC-25 取“第一行”当对照臂，而两个臂的行写在同一时刻、按随机 ID 排序，换一个数据库排序就取到试验臂被拒。改为按 `arm_role === "control"` 取，连跑 8 次全过。
7. **N24d 在托管 CI 上一直失败（107 / 108）**：R 会在 `LD_LIBRARY_PATH` 前面加上自己的库目录，setup-python 的解释器于是加载系统的 libpython，起来时没有它自己的 site-packages，同一个 `python3` 在 shell 里能导入 pyarrow、在 R 里不能。先让用例失败时说清原因（哪个 python、解析到哪、退出码、末两行输出），在 CI 上量到后，改为给 Parquet 桥用的系统解释器安装钉住版本的 pyarrow 并用 `VCR_PYTHON` 指向它——和镜像里的做法一致。

另外把 `vcr_model_not_applicable` 登记进错误码表（`vcrErrorCodesRegistered` 要求模块发出的每个码都有登记和中文说明）。
