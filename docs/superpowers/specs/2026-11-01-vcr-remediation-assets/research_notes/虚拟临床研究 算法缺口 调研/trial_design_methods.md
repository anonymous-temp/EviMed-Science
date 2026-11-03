# 试验设计与模拟方法：2022 至 2026-11 的现状与 VCR 引擎缺口（调研笔记，2026-11-02）

约定。来源标签：[REG-final] / [REG-draft] 监管文件；[PR] 同行评议；[PP] 预印本；[VEN] 厂商材料；[secondary] 只看到摘要、搜索结果或转述。阅读状态写在来源后：“全文”指我用 pdftotext 或页面读取读到了相应段落，“摘要级”指只看到摘要或搜索结果。

【本机实测】指我在开发机上跑的结果，没有外部链接，因此参数写在原处。环境：R 4.3.3，单进程，4 核 7 GB 的共享开发机（有其他负载），包来自 Dockerfile 使用的同一快照 `packagemanager.posit.co/cran/2026-09-28`，源码编译，装入 `<scratch>`，并叠加 CI 库 `<dev box path>`。这不是生产镜像测试，也没有测内存。1e5 次的耗时都是由 1e3 或 1e4 次线性外推，未实跑。

引擎事实读自分支 `codex/vcr-remediation-20261101`（cde64eddc）。作业限额读自 `项目代码/vcr-engine/service/app.py`：默认 600 CPU 秒，上限 3600 CPU 秒，R 在限额的 0.9 处自行停止并返回部分结果，`VCR_ENGINE_MAX_REPLICATES=200000`，内存默认不限。

不重复早先笔记 `论文流程 整改方案/trial_design.md` 已有内容（ADEMP、FDA 2019 与 CID 的报告清单、E20 5.2 的 11 项、FDA 2026 的成功标准与设计先验、输入敏感性）。

## 总问题：哪些设计与模拟方法已在实际使用或进入监管文本、引擎没有、值不值得加？

### Takeaway
最大的单项缺口是确认性设计层：引擎没有非劣效界值、没有无效性边界、没有样本量再估计、没有多臂选择和人群富集。`rpact` 一个包覆盖全部这些，LGPL-3，依赖闭包只有 8 个且都在 CI 库内，在 R 4.3.3 上实测可在作业限额内跑完。其次是早期试验层（BOIN、Keyboard、CRM、BOP2）和分层复合终点（win ratio）。平台试验、篮式试验的文本刚出且仍是草案，放到后面；联合模型和深度学习入组预测不值得做。

### Cited Findings

**引擎现状（代码核对）**
- `VCR_SIMULATED_DESIGNS` 只有 `two_arm_fixed`、`group_sequential`、`single_arm`、`single_arm_external`、`simon_two_stage`；生存分析方法为 `logrank`、`rmst`、`maxcombo`；组序贯下 MaxCombo 被拒绝（“MaxCombo is a fixed-design analysis”）。α 消耗只有 Lan-DeMets O'Brien-Fleming 和 Pocock。 — 分支 `项目代码/vcr-engine/R/design_simulate.R`（第 83、95、293 行）、`design_analytic.R`（第 35–55 行）
- 在 `design_analytic.R`、`design_simulate.R`、`single_arm.R`、`assurance.R`、`engine.R`、`protocol.R` 中检索 non-inferior、margin、equivalence、futility、conditional power、predictive probability、re-estimation、enrichment、multi-arm、adaptive：没有设计层面的实现（命中的只有积分算法的 “adaptive quadrature” 和权重重估）。 — 同一分支

**本机实测：依赖闭包（对照 2026-09-28 快照；“新增”指 CI 库之外还要装的包）**

| 包 | 快照版本 | 许可 | 闭包 | 新增 | 备注 |
|---|---|---|---|---|---|
| rpact | 4.4.0 | LGPL-3 | 8 | 0 | 已在 CI 库 |
| gsDesign2 | 1.2.0 | GPL-3 | 73 | 2 | 闭包大（gt 等），只适合 CI |
| simtrial | 1.1.0 | GPL-3 | 17 | 4 | |
| BOIN | 2.7.2 | GPL-2 | 1 | 1 | 仅依赖 Iso |
| dfcrm | 0.2-2.1 | GPL-2 | 0 | 0 | 纯 R |
| Keyboard | 0.1.3 | GPL-2 | 19 | 1 | |
| adaptr | 1.5.0 | GPL (>= 3) | 0 | 0 | 无依赖 |
| MAMS | 3.0.3 | GPL-2 | 9 | 0 | |
| hce | 0.9.4 | MIT | 0 | 0 | 无依赖 |
| powerHE | 1.0.1 | GPL (>= 2) | 0 | 0 | 无依赖 |
| winratiosim | 1.0.0 | GPL-2 | 0 | 0 | 无依赖 |
| WINS | 1.5.1 | GPL (>= 2) | 87 | 35 | 太重 |
| baskexact | 1.0.1 | GPL (>= 3) | 32 | 6 | 含 gmp |
| bhmbasket | 1.1.0 | GPL-3 | 11 | 6 | 依赖 rjags，运行时没有 JAGS |
| NCC | 1.0 | MIT | 100 | 20 | 依赖 rjags |
| TrialSimulator | 1.35.8（CRAN 最新 1.39.0） | MIT | 45 | 4 | |
| crmPack | 2.2.1（最新 2.3.0） | GPL (>= 2) | 71 | 12 | 依赖 rjags |
| DoseFinding | 1.4-1（最新 1.4-2） | GPL-3 | 19 | 0 | |
| eventPred | 0.3.1 | GPL (>= 2) | 94 | 15 | 含 shiny、plotly |

列表内所有包及其闭包都没有要求 R 高于 4.3.3。上表没有禁止商用的许可。

**本机实测：耗时（单进程，CPU 秒）**

| 任务 | 参数 | 实测 | 外推 1e5 次 |
|---|---|---|---|
| rpact SSR，均值，3 个情形 | 2 stage，inverse normal，N 200/400，条件功效 0.9，第二阶段上限 800 | 1e4 次 0.34 | 约 3.4 |
| rpact 生存 SSR，2 个情形 | HR 1 与 0.75，计划事件 150/300，第二阶段 150–450 | 1e4 次 6.3–6.5 | 约 65 |
| rpact 延迟效应组序贯生存 | 前 3 个月 HR 1，之后 0.6，事件 200/350 | 1e4 次 3.1–3.8 | 约 38 |
| rpact 富集，3 个情形 | 亚组患病率 0.4，epsilon 选择，Simes | 1e4 次 18.2 | 约 182 |
| rpact 多臂选最优，2 个情形 | 3 活性臂，N 100/200，Simes | 1e4 次 19.4 | 约 194 |
| simtrial `sim_fixed_n` | n=500，300 事件，4 个 FH 权重 | 1e3 次 29 | 约 2900（超默认 600，接近 3240 的实际上限） |
| adaptr `run_trials` | 3 臂，18 次分析，N 到 2000 | 1e3 次 33–35 | 约 3400（超过 3240，单作业跑不完） |
| BOIN `get.oc` | 6 剂量，30 人 | 1e4 次 9.4 | 约 94 |
| Keyboard `get.oc.kb` | 同上 | 1e3 次 1.9；1e4 次在 60 秒墙钟内未结束，原因未查 | 不外推 |
| dfcrm `crmsim` | 同上 | 1e3 次 20 | 约 2000 |
| hce `simHCE` + `calcWO` | n=200 | 1e3 次 6–7 | 约 650 |
| winratiosim | N=300 | 10 次 4.0（每次约 0.4） | 约 40000，不可行 |
| MAMS `mams` | K=2，J=2，含默认模拟 | 14 | 不适用 |
| baskexact `toer` | 4 篮，每篮 20 人，精确计算 | 0.69 | 不需模拟 |
| gsDesign2 固定设计 / `gs_power_combo` / `gs_design_ahr` | 解析 | 0.02–0.66 | 不需模拟 |

- 同种子可复现：simtrial 顺序后端下 `set.seed` 相同，结果 `all.equal` 为真。rpact 和其他包未测。 — 【本机实测】
- 零假设下的 1e4 次估计：SSR 均值 0.0227，富集 0.0209，多臂 0.0238，生存 SSR 0.0273（1e4 次的 MCSE 约 0.0016）。这些只说明没有离谱，不足以作为 I 类错误证据，E20 对此要 1e5 次。 — 【本机实测】

**Python**
- GitHub 检索 `clinical trial simulation adaptive language:Python` 按星标排序，前列是 BATS（3 星，2019 年后无推送）和 refua-clinical（1 星，MIT，2026-09 有推送）。没有发现可比 rpact、gsDesign2 的 Python 实现。只检索了一次，之后 GitHub 限流。 — [GitHub search API](https://api.github.com/search/repositories?q=clinical+trial+simulation+adaptive+language:Python&sort=stars)

**商业软件（对照，不可复用）**
- Cytel East Horizon 2024-09-30 发布，云端模拟，含 multiplicity 和 adaptive 模块，可接 R 代码。 [VEN；摘要级] — [Cytel](https://cytel.com/news-and-events/cytel-launches-east-horizon/)
- FACTS 7 新增平台试验模块，支持臂进出和 RAR。 [VEN；摘要级；Berry 的对比对象是 EAST 6.5，不是 East Horizon] — [Berry](https://docs.berryconsultants.com/introduction/facts-comparison.html)

**提示中点名但没能确认的包**
- `multiarm`、`BuildingBlocks`：CRAN 元数据库查无此包；GitHub 核实时遇到限流，没有确认。 `RCTdesign`：GitHub 上 `maryryan/RCTdesign` 最后推送 2018-01-30，未显示许可，CRAN 无此包；这是否就是你指的 RCTdesign 未确认。 — [crandb](https://crandb.r-pkg.org/multiarm)；[GitHub](https://github.com/maryryan/RCTdesign)

### Inferences

**建议清单（按做法分组，同组内按收益排序）**

| 判定 | 候选 | 做法 |
|---|---|---|
| 现在加 | 确认性设计：NI 界值、β 消耗与无效性、SSR、多臂选择（含无缝）、人群富集、计数终点 | 运行时引入 `rpact`，一个窄适配器 |
| 现在加 | I 期：3+3、BOIN、Keyboard/mTPI-2、CRM | 规则确定，手写，CI 对照 BOIN、Keyboard、dfcrm |
| 现在加 | II 期贝叶斯监测：后验与预测概率、BOP2 | 共轭精确计算，手写，复用 Simon 的枚举 |
| 现在加 | 分层复合终点模拟 | 手写多层 DGP 与秩计算，CI 对照 hce、powerHE |
| 现在加 | 贝叶斯成功标准校准（共轭/正态） | 手写，CI 对照 RBesT |
| 现在加 | 伴发事件与非 MCAR 脱落的数据生成 | 扩展 `patients.longitudinal`，手写 |
| 现在加 | Modestly weighted 检验，MaxCombo 组序贯，强零假设情形 | 手写，CI 加入 gsDesign2、simtrial |
| 现在加 | 随机化剂量优化的选择概率 | 手写二项精确计算 |
| 以后 | 平台试验、篮式试验、RAR、MCP-Mod、illness-death/竞争风险、入组衰减检验、事件预测、参考法多重插补、NPH 下的 assurance | 见各节 |
| 不值得 | 联合模型做设计；单独的 umbrella 模块；深度学习入组预测；为 RMST 新增方法 | 见各节 |

- 按业主规则“先复用成熟上游”，rpact 是最明显的一步：它现在只是交叉核对对象，提到运行时就能换来一整层能力，而闭包代价很小。这也改变核对关系：rpact 进入运行时后不能再自己核对自己，独立核对要靠 gsDesign、gsDesign2、simtrial 和手写公式。
- 适配器要自己处理两点。第一，rpact 的模拟函数一次跑完，不会在 0.9 CPU 限额处返回部分结果，需要分批用不同种子调用再合并，否则违反“部分结果保留”。第二，MCSE 要由适配器按比例计算。两点都是我读耗时后的判断，没有实现验证。
- 对 1e5 次 I 类错误，rpact 全部在默认 600 秒内；simtrial、adaptr 不行。所以 simtrial 适合 CI 核对，不适合运行时。

### Gaps
- 没有测内存峰值，也没有在实际容器和 RLIMIT 下跑。Keyboard 1e4 次未在 60 秒内结束的现象未查明，说明线性外推并不总成立。
- 未核实 rpact 同种子跨版本的可复现性，这对“同种子同结果”的引擎约定很关键。

## 旧方法：Lachin-Foulkes、Simon 1989、α 消耗组序贯、O'Hagan assurance、Anisimov-Fedorov、MaxCombo 是否过时？

### Takeaway
前五个仍是标准，没有被取代：现行工具和文本仍在用，新工作都是在其上扩展。MaxCombo 不同：它没有被取代，但也没有成为标准，有已发表的反例，也没有找到监管机构的认可。引擎的真正问题不是这些方法旧，而是它们周围缺东西（无效性边界、其他消耗函数、NPH 警示）。

### Cited Findings

**Lachin-Foulkes 1986：比例风险下仍是标准**
- gsDesign2 1.2.0（2026-07-30）仍提供 `fixed_design_lf`；gsDesign 3.11.0（2026-08-29）的 `nSurv` 同样在用。 — [crandb gsDesign2](https://crandb.r-pkg.org/gsDesign2)；[crandb gsDesign](https://crandb.r-pkg.org/gsDesign)
- 相同输入（HR 0.7，对照中位 12 月，入组 24 月，研究 36 月，月脱落 0.001，单侧 0.025，功效 0.9）：gsDesign2 LF N=498.5、事件 329.6；gsDesign `nSurv` N=498.5、事件 329.6；rpact N=499.6、事件 330.4；gsDesign2 AHR N=501.4、事件 331.5。差异不到 1%。 — 【本机实测】
- 非比例风险下的扩展是分段 AHR 与加权检验的 n-d 工作流，见早先笔记的 Zhao et al. 与本笔记 NPH 一节。

**Simon 1989：仍是单臂 II 期最常见的参照，但有替代趋势，比例未知**
- Grayling & Mander：5 年窗口内 425 篇单臂文章使用 Simon 设计；只有 47.5% 给齐复现设计所需的五项，55.3% 报告了终阶段拒绝界，1.2% 报告校正点估计，2.1% 报告校正置信区间。 [PP；摘要级] — [arXiv 2007.04168](https://arxiv.org/abs/2007.04168)
- 2025 年的预印本仍把 Simon 当作文献中常见的参照点。 [PP；摘要级] — [arXiv 2511.14714](https://arxiv.org/html/2511.14714v1)
- 另有一份 2025 年比较称 BOP2 与 TS 设计在 II 期“广泛使用”，但未给数字。 [PP；摘要级] — [arXiv 2501.08410](https://arxiv.org/html/2501.08410v1)
- ICON 称 Simon 等假设检验设计“目前被 FDA 不鼓励”。 [VEN；单一来源、未注明日期，我读到的 FDA 文本中没有这句话，不应采信为事实] — [ICON](https://www.iconplc.com/solutions/all-case-studies/improving-early-phase-oncology-clinical-trial-design)
- clinfun 1.1.6 的 `ph2simon(.2,.4,.05,.2)` 给出 minimax 4/18、10/33，与引擎做法可对照。 — 【本机实测】

**α 消耗组序贯：仍是标准**
- E20 草案 4.1 直接以组序贯作为早停的基本形式（第 319–322 行）；对无效性“generally recommended to use nonbinding futility rules”，指出 binding 规则要求严格遵守，否则 I 类错误失控（第 360–369 行）。 [REG-draft；全文] — [E20](https://www.fda.gov/media/188961/download)
- FDA 2026 贝叶斯草案也说，含早停的试验可用成功标准保证跨分析的 FWER 控制（第 268–270 行）。 [REG-draft；全文] — [FDA Bayesian](https://www.fda.gov/media/190505/download)
- rpact 4.4.0（2026-03-04）与 gsDesign 3.11.0 都持续发布。 — [crandb rpact](https://crandb.r-pkg.org/rpact)
- 引擎只有 Lan-DeMets OBF 和 Pocock，且没有无效性或 β 消耗。这是真实缺口。 — 分支 `design_analytic.R`

**O'Hagan 2005 assurance：仍是标准**
- 早先笔记的 EFSPI/PSI 调查显示项目层决策 89–94% 用 assurance；FDA 2026 草案把设计先验下的 “Bayesian power” 列为未校准设计的操作特征。这里不重复。
- 新工作是扩展，不是替代：Salsbury, Oakley, Julious, Hampson，Stat Med 2024;43(19):3595–3612，对延迟效应参数做先验启发再算 assurance；配套 R 包 DTEAssurance 在作者的 r-universe。 [PR；只读了预印本与包文档的摘要] — [arXiv 2310.06673](https://arxiv.org/abs/2310.06673v2)；[DTEAssurance](https://jamesalsbury.r-universe.dev/DTEAssurance/doc/manual.html)

**Anisimov-Fedorov 2007：仍是参考模型；没有找到它被真实试验比较击败的证据**
- 详见入组一节。

**MaxCombo：未被取代，也不是标准，有争议**
- Mukhopadhyay et al.，JAMA Oncol 2022;8(9):1294–1300：63 个抗 PD-(L)1 RCT，35,902 例，150 次比较。log-rank 与 MaxCombo 2 一致 135/150（90%），15 个不一致都是只有 MaxCombo 显著，其中 12 个违反 PH。dRMST 与 log-rank 一致 137/150，且没有增加敏感性。作者认为不一致病例获益往往不大。 [PR；全文；作者含 straw-man guidance 的 Anderson、Roychoudhury，并非独立方] — [PMC9305601](https://pmc.ncbi.nlm.nih.gov/articles/PMC9305601)
- Freidlin & Korn，JCO 2019;37(35):3455–3459：加权检验可能在实验组一致更差时宣称优效，建议此类方法多用于次要分析。 [PR；我只读到转述，未读原文] — [FastSurvival vignette](https://ftp.fau.de/cran/web/packages/FastSurvival/vignettes/investigate-freidlin-and-korn.html)
- 复现（HR 16 持续 0.1 年，之后 0.76，2000 次）：单侧拒绝率在等效零假设下 2.4%，在强零假设下 MaxCombo 51.6%、FH(0,1) 61.0%，log-rank 和 modestly weighted 接近 0。 [包文档；作者未署名；单一来源] — [同上](https://ftp.fau.de/cran/web/packages/FastSurvival/vignettes/investigate-freidlin-and-korn.html)
- Magirr & Öhrn（2024-12）称 MaxCombo 采用缓慢，提出 robust modestly weighted（log-rank 与 MW(s*=0.5) 取最大）；早期有害情形下 I 类错误 MaxCombo 0.044/0.127（高/低事件率），rMW 0.012/0.009；assurance 约 0.78–0.79 对 log-rank 0.77。 [PP；全文读取经摘要工具；作者提出的方法，自带立场] — [arXiv 2412.14942](https://arxiv.org/html/2412.14942v1)
- Klinglmüller et al. 2025 的中立比较（早先笔记）称 MaxCombo “robust”，但完整研究中 log-rank 常在最有功效之列。

### Inferences
- 建议给每个旧方法写明判定：Lachin-Foulkes、α 消耗、assurance、Anisimov-Fedorov 保留且无须标注过时；Simon 保留，同时加入 BOP2 和校正估计；MaxCombo 保留，但输出时同时报告强零假设情形下的拒绝率和 log-rank 结果。
- 不要把 MaxCombo 当作 NPH 下的默认推荐。

### Gaps
- 没有找到 FDA 或 EMA 关于 MaxCombo 或加权 log-rank 作为主要分析的明确文件。检索了两轮，无结果不等于没有。没有找到已发表的 MaxCombo 主要分析的 III 期试验清单。
- Simon 与 BOP2 的实际使用比例没有找到任何统计。

## 适应性设计与 ICH E20：SSR、无缝 II/III、富集、MAMS、RAR

### Takeaway
ICH E20 仍是草案：2025-06 到 Step 2，最新工作计划把 Step 3/4 签署排在 2027-02，所以今天不能把它当作已生效的指南。现行有效的是 FDA 2019 终稿。E20 对 SSR、人群选择、处理选择都建议用允许偏离预设规则的方法（即组合检验类），对 RAR 则明显谨慎。除 RAR 外，rpact 都能直接实现。

### Cited Findings

**E20 状态**
- 2026 年工作计划（文件名 0812）：2025-06 Step 1 与 Step 2a/b；2027-01 Step 3 PWP 咨询；2027-02 Step 3、Step 4 签署。 [全文] — [ICH work plan](https://database.ich.org/sites/default/files/ICH53_E20_EWG_Workplan_2026_0812.pdf)
- 时间曾多次后移：2024 年的计划目标是 2026-04 的 Step 4。 [摘要级] — [2024 work plan](https://database.ich.org/sites/default/files/ICH_E20_EWG_WorkPlan_2024_0308.pdf)
- E20 尚未定稿，FDA 2019 适应性设计指南仍是现行终稿（这是由两份文件的状态得出的判断）。 — [FDA 2019](https://www.fda.gov/media/78495/download)
- E20 草案提取文本中没有出现 seamless、platform、enrich 这些词（grep，大小写不敏感）。它用 Population Selection（4.3）、Treatment Selection（4.4）、Adaptation to Participant Allocation（4.5）。所以“无缝”“平台”的具体要求不能引用 E20。 — [E20](https://www.fda.gov/media/188961/download)

**E20 各节要点（FDA 托管的草案，全文）** — [E20](https://www.fda.gov/media/188961/download)
- 4.2 SSR：冗余参数的调整“should be carried out using blinded data”；基于效应估计的调整要用 IDMC。“generally recommended to use sample size adaptation methods that do not require adherence to the anticipated adaptation rule, such as hypothesis testing based on pre-specified weights for combining the information across trial stages”。常规点估计可能有偏，要在计划阶段评估。盲态 SSR 下，两臂非劣效连续终点用常规方法可能抬高 I 类错误（第 398–403 行）。
- 4.3 人群选择：要预设候选人群、决策和预期规则；一般建议方法允许偏离预期规则；常规估计可能有偏，应考虑校正；连续标记要说明阈值的依据。
- 4.4 处理选择：同样要求；分析是合并两阶段数据，这在实质上就是推断上无缝的 II/III 期设计（这句是我的解读，E20 不用这个词）。
- 4.5 RAR：“susceptible to bias and inflation of the Type I error probability in the presence of overall time trends”。给出的一种控制方法是只在一次或少数几次期中调整比例，并配合预设权重的组合检验；重随机化检验可能比固定随机化功效更低；确定性分配“discouraged”。
- 5.3（贝叶斯一节）：可用后验或预测概率做非约束性无效规则，主要分析仍用频率检验，此时操作特征要求与其他适应性设计相同（第 736–746 行）。

**实现**
- rpact 4.4.0，LGPL-3，2026-03-04。官方 vignette 覆盖 unblinded SSR、Promising Zone、inverse normal、enrichment、multi-arm、MAMS、count data、delayed response（Hampson & Jennison 2013）、futility bounds。 [页面已读] — [rpact vignettes](https://www.rpact.org/vignettes/)；[crandb](https://crandb.r-pkg.org/rpact)
- MAMS 3.0.3，GPL-2，2025-08-26；Jaki, Pallmann, Magirr，J Stat Softw 2019；函数 `mams`、`new.bounds`、`mams.sim`。 [PR；摘要级] — [JSS](https://jstatsoft.org/article/view/v088i04)；[crandb](https://crandb.r-pkg.org/MAMS)
- gsMAMS 0.7.2，GPL-3，2024-05-10；JOSS 论文称某些设计比 MAMS 快得多。 [PR；摘要级；作者自述] — [JOSS](https://theoj.org/joss-papers/joss.06322/10.21105.joss.06322.pdf)
- asd 2.2，GPL-3，最后发布 2016-05-23，已不活跃。 — [crandb](https://crandb.r-pkg.org/asd)
- adaptr 1.5.0，GPL (>= 3)，2026-03-30，模拟适应性多臂试验（早停、丢臂、适应性随机化），来自 INCEPT 项目。 — [CRAN](https://cran.r-project.org/web/packages/adaptr/index.html)
- TrialSimulator 1.39.0，MIT，2026-10-09，单一作者 Han Zhang；vignette 含适应性设计、富集、条件功效、RAR、剂量探索、相关 PFS/OS、交叉。我装上了快照版但未运行；未发现监管或业界使用证据。 — [CRAN](https://cran.r-project.org/web/packages/TrialSimulator/index.html)
- Robertson, Lee, López-Kolkovska, Villar，Statistical Science 2023;38(2):185–208 综述 RAR；同期 Giovagnoli 评论认为现有论据“inconclusive”。 [PR；摘要级] — [Project Euclid](https://projecteuclid.org/journals/statistical-science/volume-38/issue-2/Response-Adaptive-Randomization-in-Clinical-Trials--From-Myths-to/10.1214/22-STS865.pdf)；[评论](https://projecteuclid.org/journals/statistical-science/volume-38/issue-2/Comment--Is-Response-Adaptive-Randomization-a-Good-Thing-or/10.1214/23-STS865E.full)
- RARtrials 0.0.2，GPL (>= 3)，2025-04-03，要求 R >= 4.3，闭包含 pins、httr。 — [crandb](https://crandb.r-pkg.org/RARtrials)

### Inferences

**候选：SSR（盲态与非盲态，promising zone）**
- 关键文献：Mehta & Pocock 2011（未打开）；E20 4.2。实现：rpact（LGPL-3，2026-03）；R。R 4.3.3 CPU：可，1e5 次低于 65 秒。
- 新能回答：“这个 HR 把握不大，如果中期按条件功效追加事件，功效和期望事件数是多少？”实测一例：HR 0.75，计划事件 150/300，第二阶段可在 150–450 之间调整（总上限 600），功效 0.885，期望事件约 428。
- 使用证据：E20 4.2，FDA 2019，Pocock 2024 提到可用 promising zone。业界比例未找到。
- 判定：**现在加**。理由：监管文本明确，rpact 现成，代价最低。

**候选：推断上无缝的 II/III 期与处理选择**
- 实现：rpact `getSimulationMultiArmMeans/Rates/Survival`；asd 已停更。可在限额内跑（1e5 次约 194 秒）。
- 新能回答：“两个剂量加对照，中期选一个，比两个独立试验省多少、错选概率多少？”
- 证据：E20 4.4。判定：**现在加**，随 rpact 适配器一起。

**候选：人群富集**
- 实现：rpact `getSimulationEnrichmentMeans/Rates/Survival`；可在限额内跑。
- 新能回答：“标记阳性占 40%，中期收窄入组，比全人群设计功效如何？”
- 证据：E20 4.3。实际使用频率未找到。判定：**现在加**，同一适配器，边际成本小。

**候选：MAMS**
- 实现：rpact（有 MAMS vignette）；MAMS 3.0.3 作 CI 对照。
- 证据：Meyer 2021 的综述列举了 nstage、rpact、MAMS、FACTS（经 [Sheffield PANDA](https://panda.shef.ac.uk/techniques/multi-arm-multi-stage-mams/categories/34) 转述）；STAMPEDE 本轮未检索到一手来源。判定：**随 rpact 现在加**；不单独引入 MAMS 到运行时。

**候选：RAR**
- 实现：adaptr（无依赖，GPL）；R。可跑到 1e4，1e5 超限（约 3400 秒超过 3240），需要分作业或手写。
- 新能回答：“多臂试验按贝叶斯概率调整分配后，期望失败人数和 I 类错误如何？”
- 证据：E20 4.5 的谨慎态度；Robertson 2023 称争论未决。判定：**以后**。理由：监管立场最谨慎，必须带时间趋势情形才诚实，而我没有确认 adaptr 能模拟时间趋势。

### Gaps
- E20 的最终内容可能变化。我没有看到 2025-11 之后的修订文本。
- 适应性设计在真实提交中的占比，这轮没有找到可靠统计。

## 主方案：平台、篮式、伞式模拟

### Takeaway
2026 年文本密集出现但都是草案：FDA 2026-06 修订稿（首次加入篮式试验）、EMA 2026-10 平台试验反思文件（咨询到 2027-01-31）。EMA 的要求比较具体，可以直接成为模拟输出项。开源工具分散且偏旧，没有一个能作为主干。建议以后手写一个有限范围的平台模拟器。篮式试验已知会抬高 I 类错误，模拟的价值在于显示这一点。

### Cited Findings
- FDA 《Master Protocols for Drug and Biological Product Development》：2026-06，Draft，“Not for implementation”，docket FDA-2023-D-5259，页面日期 2026-06-25。我没有读 PDF 正文。 [REG-draft；页面已读] — [FDA](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/master-protocols-drug-and-biological-product-development)
- 据厂商评论：修订稿新增篮式内容，默认仍是同期对照，且限定为可被随机到该臂的患者；要求说明借用假设，并评估假设不成立时的表现；大量引用 FDA 贝叶斯草案。 [VEN；Cytel 和 Berry 两家转述，Berry 自称基于文档比对可能有遗漏] — [Cytel](https://cytel.com/perspectives/the-fda-revises-master-protocol-guidance-what-drug-developers-should-know/)；[Berry](https://www.berryconsultants.com/resource/the-revised-fda-draft-guidance-on-master-protocols)
- EMA/217509/2026《Reflection paper on methodological aspects in confirmatory platform trials》：MWP 2026-08-20 同意，CHMP 2026-10-05 通过，咨询 2026-10-19 至 2027-01-31。 [REG-draft；全文] — [EMA](https://www.ema.europa.eu/en/documents/scientific-guideline/reflection-paper-methodological-aspects-confirmatory-platform-trials_en.pdf)
- 该文件 3.3.2：“A strong preference is given to concurrent controls”；非同期对照“usually not acceptable for the primary analysis of the primary endpoint”。 — 同上
- 该文件 3.6.1：样本量论证“should explicitly define which power is targeted”，区分 marginal、disjunctive、conjunctive power，并说明是否考虑统计量相关。 — 同上
- 该文件 3.6.2：还应考虑可信的平台轨迹（臂的进出）、任一时间开放的臂数、入组率随时间变化、共享对照的影响、每臂和总体的期望样本量和时长；“simulations may be required and should be included in the protocol as appropriate”。 — 同上
- EMA 这份文件的范围是确认性平台试验，早前 EMA 幻灯片称贝叶斯方法另行处理。 [secondary] — [RAPS](https://www.raps.org/resource/euro-roundup-ema-seeks-feedback-on-platform-trials-mhra-to-recognize-ce-marked-devices-indefinitely.html)
- 平台相关 R 包：PlatformDesign 2.1.4，GPL (>= 3)，2022-12-15（两阶段加臂的最优设计，只依赖 mvtnorm，闭包 1）；NCC 1.0，MIT，2023-03-03（非同期对照的模拟与分析，依赖 rjags）；CohortPlat 1.0.5，MIT，2022-02-14；BayesianPlatformDesignTimeTrend 1.2.3，MIT，2023-12-07（闭包 108）。 — [PlatformDesign](https://crandb.r-pkg.org/PlatformDesign)；[NCC](https://crandb.r-pkg.org/NCC)；[CohortPlat](https://crandb.r-pkg.org/CohortPlat)；[BayesianPlatformDesignTimeTrend](https://crandb.r-pkg.org/BayesianPlatformDesignTimeTrend)
- 非同期对照范围综述。 [PR；摘要级] — [PMC10268466](https://pmc.ncbi.nlm.nih.gov/articles/PMC10268466/)
- 篮式：Daniells et al.，Stat Med 2023，比较 BHM、CBHM、EXNEX、贝叶斯模型平均，主要看 I 类错误，并提出基于 Hellinger 距离的改进 EXNEX；异质时其他方法不能把 I 类错误保持在名义水平。 [PR；摘要级；提出新方法者的结论] — [PMC10962580](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10962580/)
- 篮式：Jin et al. 称常规 BHM 可能严重抬高不敏感适应症的 I 类错误。 [PP；摘要级] — [arXiv 2002.03007](https://arxiv.org/abs/2002.03007v1)
- FDA 2026 贝叶斯草案 III.D 提到篮式试验可用贝叶斯借用，并举了 EMAS 用 BHM 的 CID 例子；III.E 提到亚组收缩估计。 [REG-draft；全文] — [FDA](https://www.fda.gov/media/190505/download)
- 篮式 R 包：baskexact 1.0.1，GPL (>= 3)，2024-04-09（精确计算操作特征）；bhmbasket 1.1.0，GPL-3，2026-04-15（要 JAGS）；basket 0.10.11，LGPL-2，2021-10-16；BasketTrial 0.1.0，GPL-3，2025-06-18。 — [baskexact](https://crandb.r-pkg.org/baskexact)；[bhmbasket](https://crandb.r-pkg.org/bhmbasket)；[basket](https://crandb.r-pkg.org/basket)；[BasketTrial](https://crandb.r-pkg.org/BasketTrial)
- baskexact：4 篮，每篮 20 人，p0=0.2，lambda=0.99，Fujikawa 权重（epsilon=2，tau=0），FWER=0.0742，0.69 CPU 秒。 — 【本机实测】

### Inferences

**候选：平台试验模拟（有限范围）**
- 关键文本：EMA 2026 草案。实现：没有合适的主干，手写；R。R 4.3.3 CPU：若用二项和正态共轭可行，未实测。
- 新能回答：“每年新增一个臂，共享对照，同期对照分析下，每臂功效和总时长如何？”
- 证据：EMA、FDA 草案；FACTS 7 有此模块（厂商）。判定：**以后**，排在 rpact 适配器之后。理由：文本还是草案，手写量最大，范围先限于同期对照。输出项可直接取 EMA 3.6 的清单。

**候选：篮式设计模拟**
- 实现：baskexact（精确、无 MCMC）或手写共轭。bhmbasket 的 JAGS 依赖与运行时不符。
- 新能回答：“这几个瘤种合并借用，一个不敏感瘤种的假阳性会被抬多高？”
- 证据：FDA 两份草案，方法学文献。判定：**以后**，放在 BOP2 之后。理由：单篮 BOP2 是其前置；FDA 文本新出、未定稿。

**候选：伞式**
- 判定：**不值得单独做**。按我的理解，它在模拟上是按生物标志物分层的多个独立比较或共享对照的多臂设计，可由多臂和平台能力覆盖。这条没有找到专门文献支持，是判断。

### Gaps
- FDA 2026-06 修订稿正文未读，内容来自两家厂商评论。
- `adaptr` 是否支持臂的中途加入，CRAN 页面没有说明。

## 贝叶斯设计：FDA 指南、预测概率监测、BOP2、分层篮式

### Takeaway
FDA 贝叶斯指南日期是 2026 年 1 月，目前仍是草案，主要针对支持主要推断的用法；它只用一句话提到贝叶斯计算可用于期中规则，文本里没有 predictive probability 这一提法，E20 草案反而明确提到。欧洲进度更慢，EMA 的反思文件计划到 2028-06。适合引擎的是不用 MCMC 的共轭设计：BOP2 类监测和阈值校准都可以手写，代价低。

### Cited Findings
- FDA 《Use of Bayesian Methodology in Clinical Trials of Drug and Biological Products》：2026-01，Draft，docket FDA-2025-D-3217，FR 通告 2026-01-12。今天打开页面仍标 “Not for implementation”，未找到终稿。 [REG-draft；全文] — [FDA 页面](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/use-bayesian-methodology-clinical-trials-drug-and-biological-products)；[PDF](https://www.fda.gov/media/190505/download)
- 评论期据称 2026-03-13 结束。 [secondary；单一来源] — [CASRAI](https://casrai.org/news/fda-draft-guidance-bayesian-methodology-clinical-trials-2026)
- 范围（第 18–24 行）：贝叶斯计算可用于“govern the timing and adaptation rules for an interim analysis”、设计要素，或支持主要推断；“The primary focus of this guidance is on the use of Bayesian methods to support primary inference”。 — [PDF](https://www.fda.gov/media/190505/download)
- 我 grep 了 “predictive”：除诊断试验 PPV 类比和一篇参考文献外，没有预测概率监测的内容。 — 同上
- 校准到 I 类错误的设计，主要操作特征与频率设计相同（第 306–310 行）；简单情形下阈值可代数推出，复杂情形靠模拟（早先笔记已有）。 — 同上
- E20 5.3 可用后验或预测概率做非约束性无效规则（第 736–746 行）；该节标记为未完全协调（早先笔记）。 [REG-draft；全文] — [E20](https://www.fda.gov/media/188961/download)
- EMA 概念文件 EMA/CHMP/1813/2026：咨询截至 2026-04-30；计划 2027-09 发布反思文件草案，2028-06 定稿；问题包括应提供哪些分析和模拟结果、除错误控制和偏倚外还要哪些操作特征。 [全文] — [EMA](https://www.ema.europa.eu/system/files/documents/scientific-guideline/concept-paper-development-reflection-paper-use-bayesian-methods-en.pdf)
- 预测概率监测文献：Lee & Liu 2008 是原始设计（通过书章转述，未打开）。 [secondary] — [Springer](https://link.springer.com/chapter/10.1007/978-981-19-8176-0_6)
- 有预印本认为用预测概率替代后验概率监测可减少过早停止；另一篇提醒阈值规则不自动控制 I 类错误，需校准。 [PP；摘要级] — [arXiv 2601.10590](https://arxiv.org/pdf/2601.10590)；[arXiv 2311.16506](https://arxiv.org/abs/2311.16506v2)
- BOP2 系列实现：BOP2 本身未上 CRAN（查无此包），主要通过 MD Anderson 网页工具 [trialdesign.org]；BOP2FE 1.0.3，MIT，2025-09-29；GBOP2 0.1.4，GPL-2，2025-12-22；DTEBOP2 1.0.3，GPL-3，2025-05-09（延迟结局）。 — [BOP2FE](https://crandb.r-pkg.org/BOP2FE)；[GBOP2](https://crandb.r-pkg.org/GBOP2)；[DTEBOP2](https://crandb.r-pkg.org/DTEBOP2)；[MD Anderson](https://biostatistics.mdanderson.org/shinyapps/rBOP2/)
- ph2bayes 0.0.2，GPL-3，2018；BayesPPD 1.1.3，GPL (>= 3)，2025-01-13；gsbDesign 1.0-3，GPL-3（正态贝叶斯组序贯）。发布日期之外未深入核对。 — [ph2bayes](https://crandb.r-pkg.org/ph2bayes)；[BayesPPD](https://crandb.r-pkg.org/BayesPPD)

### Inferences

**候选：II 期后验与预测概率监测，BOP2 边界**
- 关键文献：Zhou, Lee, Yuan 2017（未打开，引用自记忆，使用前应核对）；Lee & Liu 2008。
- 实现：BOP2FE（MIT，2025）作 CI 对照；手写。R。R 4.3.3 CPU：beta-binomial 精确枚举，与现有 Simon 代码同类，应在秒级（推断，未实测）。
- 新能回答：“单臂 II 期每 10 人看一次，何时停，比 Simon 少多少期望人数？”
- 证据：E20 提到预测概率；有预印本称 BOP2 广泛使用但无数字；CDE 和 FDA 文本未专门规定。判定：**现在加**。理由：代价低，且与 Simon 形成自然对照。

**候选：贝叶斯成功标准校准 Pr(d>a)>c（共轭/正态）**
- 文本：FDA 2026 草案 IV。实现：手写；RBesT 已在 CI 库可作对照，但其闭包含 rstan，不进运行时。
- 新能回答：“用这个先验和阈值，I 类错误和贝叶斯功效分别是多少？阈值校准到 0.025 要多少？”这与已有 `comparator.map_prior`、`design.assurance` 衔接。
- 判定：**现在加**，只做共轭情形。动态借用、MCMC 不做，因运行时无 Stan。

### Gaps
- Zhou 2017 未打开。
- CDE 2026 第 6 号终稿仍未读（早先笔记已记）。
- BOP2 被 FDA 接受的直接证据没有找到。

## 剂量探索：BOIN、Keyboard、mTPI-2、CRM、Project Optimus

### Takeaway
实际使用中 3+3 仍占大多数（2020–2022 年已发表 I 期约 74%），BOIN 和 CRM 比例还很低，但 FDA 已将 BOIN 指定为 fit-for-purpose，贝叶斯草案也点名了这些设计。Project Optimus 的指南已是终稿（2024-08），推荐随机平行剂量比较，且明确不要求注册级的功效。引擎没有任何剂量探索能力，这是明显的空白，且规则确定、不需要 MCMC。

### Cited Findings
- Li, Zhou, Yan，J Clin Transl Sci 2024：PubMed 2020-01 至 2022-12，256 篇 I 期肿瘤试验；剂量递增方法表 218 例：3+3 161（73.85%），CRM 14，BOIN 7，titration 6，其他 30（含 mTPI）。BLRM、Keyboard 未单列。无学界和业界的设计拆分。 [PR；全文经摘要工具] — [PMC11428115](https://pmc.ncbi.nlm.nih.gov/articles/PMC11428115/)
- FDA 关于 BOIN 的 Fit-for-Purpose 决定函（给 MD Anderson 的 Ying Yuan；提交 2020-03-09，最后修订 2021-03-28）：“fit-for-purpose in the context outlined in this letter”。决定只适用于修订后的、非信息先验下的 local BOIN；评审发现 Liu & Yuan 2015 推导有技术问题，建议提交勘误，并让软件与修订一致；假设不成立时（联合用药、迟发毒性）可能不准；“does not preclude the availability and use of other methods”。 [REG-final 类；全文] — [FDA letter](https://www.fda.gov/media/155363/download)
- FDA 2026 贝叶斯草案 III.F 点名 CRM、BLRM、BOIN、mTPI、mTPI2，并称靶向药等“identifying optimized dosage(s)… may be more appropriate than selecting the MTD”。 [REG-draft；全文] — [PDF](https://www.fda.gov/media/190505/download)
- FDA 《Optimizing the Dosage of Human Prescription Drugs and Biological Products for the Treatment of Oncologic Diseases》：Final，2024-08。 [REG-final；全文] — [FDA 页面](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/optimizing-dosage-human-prescription-drugs-and-biological-products-treatment-oncologic-diseases)；[PDF](https://www.fda.gov/media/164555/download)
- 该指南 B 节：“A recommended trial design to compare multiple dosages is a randomized, parallel dose-response trial”；试验“does not need to be powered to demonstrate statistical superiority of a dosage or statistical non-inferiority among the dosages using Type I error rates which would be used in registrational trials”；提到 backfill 和模型辅助。 — [PDF](https://www.fda.gov/media/164555/download)
- 随机化剂量优化设计：ROSE（Wang, Yuan, Liu，arXiv 2505.03898，按正确选择概率定样本量，软件在 trialdesign.org）；MERIT（Yang et al. 2024，arXiv 2302.09612，预先算好决策边界）；U-MET（D'Angelo 2024）；DoseOptDesign（arXiv 2603.15884，效用分框架，称 ROSE 是其特例，声明有 R 包和 Shiny，CRAN 查无）；无缝 II/III 剂量优化（Jiang & Yuan，作者承认操作上更难）。 [PP；摘要级] — [ROSE](https://arxiv.org/abs/2505.03898v4)；[MERIT](https://arxiv.org/abs/2302.09612v1)；[DoseOptDesign](https://arxiv.org/abs/2603.15884)
- MCP-Mod：EMA 2014-01-23 的资格认定意见（EMA/CHMP/SAWP/757052/2013），用于 II 期剂量探索。 [REG-final；摘要级] — [EMA](https://www.ema.europa.eu/documents/regulatory-procedural-guideline/qualification-opinion-mcp-mod-efficient-statistical-methodology-model-based-design-analysis-phase-ii_en.pdf)
- 软件：BOIN 2.7.2，GPL-2，最后发布 **2021-01-19**；Keyboard 0.1.3，GPL-2，2022-08-11（有 `get.oc.obd.kb`）；dfcrm 0.2-2.1，GPL-2，2019；bcrm 0.5.4，GPL (>= 2)，2019；crmPack 2.3.0，GPL (>= 2)，2026-10-11（要 rjags）；trialr 0.1.6，GPL (>= 3)，2023（要 rstan）；escalation 0.2.3，GPL (>= 3)，2025-10-08（闭包 114）；UnifiedDoseFinding 0.1.10，GPL-2，2022；DoseFinding 1.4-2，GPL-3，2026-10-16；MCPModPack 0.5，GPL-3，2023。mTPI-2 在 CRAN 上没有以 `tpiDesign` 为名的包。 — [BOIN](https://crandb.r-pkg.org/BOIN)；[Keyboard](https://crandb.r-pkg.org/Keyboard)；[dfcrm](https://crandb.r-pkg.org/dfcrm)；[crmPack](https://crandb.r-pkg.org/crmPack)；[escalation](https://crandb.r-pkg.org/escalation)；[DoseFinding](https://crandb.r-pkg.org/DoseFinding)
- BOIN `get.boundary(target=.3, ncohort=10, cohortsize=3)` 得 λe=0.236，λd=0.359；`get.oc` 真实 MTD 为第 4 剂量时选中率 46.1%。Keyboard 同情形 44.2%（1000 次），dfcrm 50.6%（1000 次）。 — 【本机实测，一个情形，不能作比较结论】

### Inferences

**候选：I 期 3+3、BOIN、Keyboard/mTPI-2、CRM 模拟**
- 关键文献：Liu & Yuan 2015；Zhou, Yuan, Nie 2018 Clin Cancer Res（FDA 决定函引用）。
- 实现：BOIN、dfcrm 纯 R，Keyboard 依赖略多；R。CPU：可行，1e4 次均在几十到两百秒内。建议手写规则（确定性算法），包作 CI 对照。Keyboard 1e4 次未在 60 秒内结束需查明。mTPI-2 与 Keyboard 的等价关系我记得文献有述但本轮未核对。
- 新能回答：“3+3 和 BOIN 在这条毒性曲线下，选对 MTD 的概率、超量给药人数、总样本量差多少？”
- 证据：FDA 决定函和草案；Li 2024 显示实际仍以 3+3 为主，因此要把 3+3 作为基准一起算（也符合 E20 的基准要求）。判定：**现在加**。
- 注意：CRAN 的 BOIN 2.7.2 发布于 2021-01-19，早于 FDA 的最后一次修订（2021-03-28），而决定函要求软件与修订对齐。我没有核实这个版本是否一致，手写实现时应按决定函引用的 Biostatistics Review 核对，不要把“用 BOIN 包”等同于“FDA 认定的版本”。同样，输出应写明 FFP 只限 local、非信息先验，并提示联合用药和迟发毒性不在其中。

**候选：Project Optimus 的随机化剂量比较**
- 实现：手写二项精确计算（ROSE 类）；Keyboard OBD 可参照。ROSE、MERIT 的公开实现主要是网页。
- 新能回答：“两个剂量各多少人，才能以 90% 概率选到更低且不差的剂量？”这是 FDA 指南说的选择问题，不是功效问题。
- 判定：**现在加**（仅两到三剂量的选择）。理由：终稿指南；计算简单。I/II 期联合模型类（BOIN12、U-BOIN）**以后**。

**候选：MCP-Mod**
- 实现：DoseFinding（`powMCT`、`sampSizeMCT` 为解析）；闭包全在 CI 库。新能回答：非肿瘤 II 期多少剂量、功效如何。
- 判定：**以后**。理由：有资格认定，确实在用；但 2014 年的方法不是这一轮最紧的缺口，且本轮未核实使用情况和 FDA 的相应决定。

**候选：BLRM**
- 判定：**以后或不做**。需 MCMC 或专门近似，本轮未评估实现。

### Gaps
- BOIN 决定函的落款日期未能从 PDF 文本提取；EFSPI 的一份幻灯片说是 2021 年。 — [EFSPI](https://www.efspi.org/wp-content/uploads/2026/03/2026-02-10_Huttunen_BOIN-presentation.pdf)
- BOIN、CRM 在 2023 年以后的使用比例没有数据。
- FDA 2016 对 MCP-Mod 的 fit-for-purpose 决定未核到。

## 非比例风险：加权 log-rank、MaxCombo、RMST、simtrial 与 gsDesign2 的状态

### Takeaway
没有共识，也没有监管立场文件。引擎已有 MaxCombo 和 RMST 的固定设计模拟，所以缺的不是这两个方法，而是三样：modestly weighted 检验、组序贯 MaxCombo（现在直接拒绝）、强零假设情形。gsDesign2 和 simtrial 都在活跃维护，能在 R 4.3.3 上编译，应加入 CI 库以补上已知的交叉核对缺口，不必进运行时。

### Cited Findings
- gsDesign2 1.2.0，GPL-3，2026-07-30；simtrial 1.1.0，GPL-3，2026-09-09；两者都要求 R >= 4.1。simtrial 反向依赖含 gsDesignNB，反向建议含 FastSurvival、gsDesign2。 — [simtrial](https://cran.r-project.org/web/packages/simtrial/index.html)；[gsDesign2](https://crandb.r-pkg.org/gsDesign2)
- 两者在 R 4.3.3 上从快照源码安装，连同 Keyboard 和 6 个依赖（iterators、doFuture、foreach、lt、corpcor、npsurvSS）共 0.73 分钟。 — 【本机实测】
- simtrial 提供 Magirr-Burman 权重 vignette。 — [vignette](https://archive.linux.duke.edu/cran/web/packages/simtrial/vignettes/modest-wlrt.html)
- gsDesign2 提供 `gs_power_combo`、`gs_design_combo`（组序贯 MaxCombo）及 `fixed_design_lf/ahr/fh/mb/maxcombo/rmst`。 — [gs_design_combo](https://search.r-project.org/CRAN/refmans/gsDesign2/html/gs_design_combo.html)；【本机实测】
- 延迟效应（入组 500/12 每月共 12 月，对照中位 15，前 4 月 HR 1，之后 0.6，研究 36 月，单侧 0.025，功效 0.9）所需 N：AHR（log-rank）440，MaxCombo(FH 0,0; 0,1; 1,0) 396，MW(tau=12) 381，FH(0,0.5) 351，RMST(tau=24) 886。 — 【本机实测，解析近似，一个情形】
- Mukhopadhyay 2022、Freidlin & Korn 2019、Magirr & Öhrn 2024 见“旧方法”一节。Klinglmüller 2025 与 Zhao et al. 见早先笔记。
- Zhang, Greene, Blaha, Wei 比较 log-rank、MaxCombo、dRMST 和广义 Gamma/F 模型，并按 NPH 情形给建议；我只读了摘要页。 [PP，相关 DOI 指向 SMMR；摘要级] — [arXiv 2406.11043](https://arxiv.org/abs/2406.11043)
- 另一篇预印本称 MaxCombo “overly sensitive to local effects”。 [PP；摘要级] — [arXiv 2007.04767](https://arxiv.org/pdf/2007.04767)
- RMST 相关包：survRM2 1.0-4（CI 已有）；SSRMST 0.1.1，2017；RMSTpowerBoost 1.0.3，GPL-3，2026-04-28。 — [RMSTpowerBoost](https://crandb.r-pkg.org/RMSTpowerBoost)
- nph 2.1，GPL-3，2022；nphRCT 0.1.1，GPL (>= 3)，2024；npsurvSS 1.1.0，GPL-2，2024；lrstat 0.3.4，GPL (>= 2)，2026-09-15（闭包 72，含 shiny、plotly，未测）；FastSurvival 1.2.0，MIT，2026-10-15（快照仍是 0.2.0；速度未核实）。 — [crandb lrstat](https://crandb.r-pkg.org/lrstat)；[crandb FastSurvival](https://crandb.r-pkg.org/FastSurvival)

### Inferences

**候选：Modestly weighted log-rank（Magirr & Burman 2019）及 rMW**
- 实现：simtrial、gsDesign2 `fixed_design_mb`；引擎可手写权重（已有 FH 计算）。R。CPU：与 MaxCombo 同量级或更快。
- 新能回答：“既担心延迟效应，又担心强零假设下的假阳性，有没有折中？”
- 证据：Klinglmüller 2025 称其可行；rMW 尚是预印本。判定：**现在加 MW**；rMW 待发表。

**候选：MaxCombo 组序贯**
- 实现：gsDesign2 `gs_power_combo` 可用，闭包大，放 CI；运行时手写或只用模拟确定边界。
- 新能回答：解除“group-sequential MaxCombo 被拒绝”。判定：**现在加**，优先级低于 MW。

**候选：强零假设情形**
- 引擎已支持分段 HR，只要加一个预设情形和输出。判定：**现在加**。这是诚实输出的代价最低的一步。

**候选：把 gsDesign2 和 simtrial 加入 CI 库**
- 判定：**现在加**。直接解决“MaxCombo 未与 simtrial 或 gsDesign2 核对”。运行时不加。

**RMST**
- 判定：**不值得新增方法**。引擎已有 RMST 分析和模拟；实测和 Zhao 都显示 τ 选择不当时功效差很多，Mukhopadhyay 称其不增加敏感性。可在输出里提示 τ 的影响。

### Gaps
- 没有找到 FDA/EMA 的 NPH 立场文件。FDA 2019 适应性指南和 E20 都未涉及（E20 中未检出相关词）。
- 引擎手写 MaxCombo 与 simtrial 的数值对比这次没有做，只是确认了 simtrial 可用。

## 终点：win ratio 与分层复合、复发事件、竞争风险、估计目标驱动的模拟、联合模型、非劣效

### Takeaway
非劣效是引擎最不该缺的基础能力，FDA 2016 终稿在用，rpact 秒算。分层复合终点在心血管已有多个关键试验，公开公式不可靠、模拟又慢，所以手写高效模拟有价值。复发事件中的计数设计 rpact 已有。估计目标驱动的模拟缺少标准做法，但引擎现在只有 MCAR 脱落，这个差距值得补。联合模型做设计未发现监管用例，不值得。

### Cited Findings

**非劣效**
- FDA 《Non-Inferiority Clinical Trials》：Final，2016-11，docket FDA-2010-D-0075。 [REG-final；页面已读，正文未读] — [FDA](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/non-inferiority-clinical-trials)
- E20 4.2 指出 NI 下盲态 SSR 的常规方法可能抬高 I 类错误；FDA 贝叶斯草案举儿科 MS 的 NI 例子借用活性对照历史数据（第 107–109 行）。 — [E20](https://www.fda.gov/media/188961/download)；[FDA](https://www.fda.gov/media/190505/download)
- rpact：`getSampleSizeMeans(alternative=0, stDev=1, thetaH0=-.3)` 总 N=468.9；`getSampleSizeRates(pi1=.8, pi2=.8, thetaH0=-.1)` 总 N=679.5（单侧 0.025，功效 0.9，均约 0.01 CPU 秒）。 — 【本机实测】
- dani 0.1-1，GPL-2。 — [crandb](https://crandb.r-pkg.org/dani)

**Win ratio 与分层复合**
- Pocock, Gregson, Collier, Ferreira，Eur Heart J 2024（ehae647）：列举 PARTNER、COAPT、ATTR-ACT、EMPULSE、TRILUMINATE、ATTRibute-CM、DAPA-MI 等；功效计算“often require simulations”；“ties”从 11.7%（PARTNER）到 75.6%（EMPEROR-Preserved），建议总要同时报告 win difference；不推荐 win odds；SOS-AMI 中“regulators encouraged the win ratio approach”；采用增长的说法是轶事，系统综述在进行中。 [PR；全文经摘要工具] — [PMC11578645](https://pmc.ncbi.nlm.nih.gov/articles/PMC11578645/)
- FDA 《Multiple Endpoints in Clinical Trials》：Final，2022-10（搜索结果中另有来源写 2017-01，应是草案日期，我未核对）。FDA 页面未提及 win ratio；我也没有读正文。一篇 JACC 论文和一篇 2025 年文章称 FDA 认可此法，均是转述。 [REG-final；页面已读] — [FDA](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/multiple-endpoints-clinical-trials)；[PMC10322884](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10322884/)
- EMA：未找到关于分层复合的新指南；旧的心衰指南讨论复合终点。 [摘要级] — [EMA CHF](https://www.ema.europa.eu/en/documents/scientific-guideline/guideline-clinical-investigation-medicinal-products-treatment-chronic-heart-failure-revision-2_en.pdf)
- Kronthaler et al.（2025-07）：Yu & Ganju 公式在 IPHAK 给出功效 0.764，模拟 0.872（1000 次，MCSE 0.0106），作者称现有实现“unreliable”。 [PP；全文经摘要工具；单一案例] — [arXiv 2507.15685](https://arxiv.org/html/2507.15685v1)
- FORSS（Zhang, Barnhart, Wu, Matsouaka，Duke，2026-05）：转述 Barnhart et al. 称评估 5000 次、单一样本量的功效曾需约 14 天，计算量随 N 约呈平方增长；用 super-sample 加公式替代，代码在 GitHub（BaoshanZZ/WinSampleSize）。 [PP；全文；自有方法] — [arXiv 2605.17240](https://arxiv.org/abs/2605.17240)
- 软件：hce 0.9.4，MIT，2026-06-26（`simHCE`、`calcWO`、`sizeWR`、`sizeWO`，以 win odds 为主，与 Pocock 的立场不同）；powerHE 1.0.1，GPL (>= 2)，2025-03-24（Barnhart 2024 SBR；按边际分布算）；winratiosim 1.0.0，GPL-2，2026-07-06（Lee 2025 Stat Med e70165；死亡、复发计数、连续 QoL 三层）；WINS 1.5.1，GPL (>= 2)，2025-07-02；WinRatio 1.0，2020。 — [hce](https://crandb.r-pkg.org/hce)；[powerHE](https://cran.ms.unimelb.edu.au/web/packages/powerHE/index.html)；[winratiosim](https://rdrr.io/cran/winratiosim/f/inst/doc/winratiosim.Rmd)；[WINS](https://crandb.r-pkg.org/WINS)
- `hce::sizeWR(WR=1.3, power=.9, Pties=.2)` 样本量 1222；`sizeWO(WO=1.2, power=.9)` 1696。 — 【本机实测，未与模拟对照】

**复发事件与计数**
- rpact `getSampleSizeCounts(lambda1=.4, lambda2=.6, overdispersion=.5, fixedExposureTime=1)` 总 N=662，0.02 CPU 秒。 — 【本机实测】
- gsDesignNB 0.4.0，GPL (>= 3)，2026-10-22（快照 0.3.2）：负二项样本量、组序贯、盲态重估计（Zhu & Lakkis 2014；Friede & Schmidli 2010）。 [摘要级] — [CRAN](https://cran.r-project.org/web/packages/gsDesignNB/index.html)
- gscounts 0.1-4，GPL (>= 2)，2021。reReg 1.4.7，GPL (>= 3)，要求 R >= 4.2。mets 1.3.12，Apache-2.0，2026-07-30（多变量事件时间）。 — [gscounts](https://crandb.r-pkg.org/gscounts)；[reReg](https://crandb.r-pkg.org/reReg)；[mets](https://crandb.r-pkg.org/mets)
- Pocock 2024 称复发事件在心衰试验中不一定增加功效，RELIEVE-HF 是例外。 — [PMC11578645](https://pmc.ncbi.nlm.nih.gov/articles/PMC11578645/)

**竞争风险与多状态**
- powerCompRisk 1.0.1，GPL-2，2018；cmprsk 2.2-12，GPL (>= 2)。 — [powerCompRisk](https://crandb.r-pkg.org/powerCompRisk)
- simIDM 0.1.1，Apache-2.0，2026-07-08（肿瘤 illness-death 模拟）；TrialSimulator 含相关 PFS/OS vignette。 — [simIDM](https://crandb.r-pkg.org/simIDM)；[TrialSimulator](https://cran.r-project.org/web/packages/TrialSimulator/index.html)

**估计目标驱动的模拟（ICH E9(R1)）**
- ICH E9(R1) 是定义框架；我读到的 EMA 平台文件要求每臂估计目标要说明伴发事件差异。 [REG-draft；全文] — [EMA](https://www.ema.europa.eu/en/documents/scientific-guideline/reflection-paper-methodological-aspects-confirmatory-platform-trials_en.pdf)
- Utrecht 研究提出四种候选模型（选择模型、模式混合等），同时模拟纵向连续结局和伴发事件，并用抑郁试验作案例。 [PR 待确认；摘要级] — [Utrecht](https://researchinformation.umcutrecht.nl/en/publications/possible-data-generating-models-of-longitudinal-continuous-outcom/)
- Olarte Parra, Daniel, Bartlett（2025-02）：同时对一种伴发事件用治疗策略、另一种用假设策略。 [PP；摘要级] — [arXiv 2502.03329](https://www.arxiv.org/abs/2502.03329)
- 阿尔茨海默病模拟中，利用事件后数据的 g-估计效率明显更高。 [PP；摘要级] — [arXiv 2409.10943](https://export.arxiv.org/abs/2409.10943)
- cities 0.1.3，GPL (>= 3)，2023-08-08（伴发事件模拟）；rbmi 1.7.0，Apache-2.0，2026-10-15（参考法多重插补，闭包 47 含 mmrm/TMB）。 — [cities](https://crandb.r-pkg.org/cities)；[rbmi](https://crandb.r-pkg.org/rbmi)
- EMA 招标（EMA/2020/46/TDA Lot 3）计划做模拟研究比较估计目标的因果方法，状态标为进行中。 [摘要级] — [EMA catalogue](https://catalogues.ema.europa.eu/print/pdf/node/4623)
- 引擎 `patients.longitudinal`：线性混合模型加 MCAR 单调脱落。 — `00_context_current_methods.md`

**联合模型**
- 方法学：组序贯（arXiv 2211.16138）、适应性富集（arXiv 2301.10640，代码在 GitHub）、BU 2023 博士论文给出非劣效和等效公式。 [PP；摘要级] — [arXiv 2211.16138](https://arxiv.org/pdf/2211.16138)；[arXiv 2301.10640](https://arxiv.org/pdf/2301.10640)；[BU](https://open.bu.edu/items/3ea0993d-b735-449b-abe4-65f6163fbd3b)
- 软件：JMbayes2 0.6-5，GPL (>= 3)，2026-10-15（快照 0.6-0，MCMC）；joineRML 0.4.8，GPL-3，2026-06-14；JMDesign 是 2012 年的。 [摘要级] — [JMbayes2](https://crandb.r-pkg.org/JMbayes2)；[joineRML](https://crandb.r-pkg.org/joineRML)；[JMDesign](https://impact.unc.edu/impact7/node/478)

### Inferences

**候选：非劣效设计（连续、二分类、生存）**
- 实现：rpact，LGPL-3；R；秒级。
- 新能回答：“界值 -10%，要多少人？”并可把 `evidence.pool` 的历史效应接到界值论证（这一接法是我的建议，FDA 正文本轮未读，需按指南核对 M1/M2 口径）。
- 判定：**现在加，最优先**。

**候选：分层复合终点**
- 关键文献：Pocock 2012、2024；Barnhart 2024；Kronthaler 2025。实现：手写 DGP 加基于秩的成对统计（n×n 比较可用排序降到近线性，推断），hce、powerHE 作 CI 对照。winratiosim 每次 0.4 CPU 秒太慢，不进运行时。
- 新能回答：“死亡、住院次数、KCCQ 三层，HR 和差值如此，样本量多少，平局比例多少？”
- 证据：多个关键心血管试验（ATTR-ACT、EMPULSE、ATTRibute-CM）。判定：**现在加**。输出同时给 win ratio、win difference、平局比例，win odds 可选（两派分歧，都要写明）。

**候选：计数和负二项**
- 判定：**现在加**，随 rpact。LWYY 模拟**以后**。

**候选：竞争风险、illness-death**
- 实现：手写 cause-specific hazards 和三状态 DGP；simIDM 作 CI。判定：**以后**。理由：本轮未找到它改变设计结论的一手证据；E9(R1) 下有用，但排在 ICE 之后。

**候选：伴发事件和非 MCAR 脱落的 DGP**
- 实现：扩展现有 `patients.longitudinal` 和 `design.simulate`，手写；`nlme` 已在运行时。参考法插补（rbmi）**以后**，因闭包和 TMB 编译。
- 新能回答：“15% 受试者用救援药，按治疗策略和假设策略，效应和样本量分别变成多少？”
- 证据：无监管文件规定具体的模拟法，但 E20 5.2 要求脱落情形，EMA 要求各臂估计目标。判定：**现在加（小范围）**。

**候选：联合模型做设计**
- 判定：**不值得**。理由：未见监管或业界设计用例；MCMC 和拟合成本高；引擎当前层次无法消化。

### Gaps
- FDA NI 指南和 Multiple Endpoints 指南的正文本轮未读。
- 复发事件和负二项在哪些适应症是监管主流，我没有找到一手来源，不作断言。
- 联合模型只检索了一轮，无结果不代表没有。
- `hce` 与 `powerHE` 数值互相比对没有做。

## 模拟报告：ADEMP 之后有什么新要求？

### Takeaway
早先笔记的结论仍成立，这轮只有三点增量：EMA 平台文件新增的功效定义和轨迹指标；E20 仍未定稿，所以 11 项报告清单还是草案；引擎的 CPU 上限对 1e5 次的约束因方法不同差别很大。

### Cited Findings
- EMA 2026 平台文件 3.6.1、3.6.2：marginal、disjunctive、conjunctive power；轨迹、开放臂数、共享对照等；模拟“should be included in the protocol as appropriate”。 — [EMA](https://www.ema.europa.eu/en/documents/scientific-guideline/reflection-paper-methodological-aspects-confirmatory-platform-trials_en.pdf)
- EMA 贝叶斯概念文件的问题：应提供哪些分析和模拟结果、除错误控制和偏倚外的操作特征。 — [EMA](https://www.ema.europa.eu/system/files/documents/scientific-guideline/concept-paper-development-reflection-paper-use-bayesian-methods-en.pdf)
- E20 5.3：要在不同先验-数据冲突情形下模拟假阳性，讨论借用上限，并评估不借用的结果（第 777–785 行）。 — [E20](https://www.fda.gov/media/188961/download)
- rsimsum 0.13.1，GPL (>= 3)，2026-04-21（MCSE 分析），闭包全在 CI 库；SimDesign 2.28，GPL (>= 2)，2026-10-06。 — [rsimsum](https://crandb.r-pkg.org/rsimsum)；[SimDesign](https://crandb.r-pkg.org/SimDesign)

### Inferences
- 判定：**rsimsum 现在加入 CI**，核对引擎 MCSE，零新增依赖。运行时不需要它。
- 新方法的 MCSE 和基准设计要一起落地：E20 要求基准，所以每个适应性设计要配一个组序贯对照。
- 对可模拟的 I 类错误，要在结果中说明实际次数；若因 CPU 限额拿到部分结果，就按实际次数算 MCSE（已有部分结果机制，新方法要沿用）。

### Gaps
- 没有发现 FDA 在 2019、2020 和 2026 文本之外的模拟报告新要求。
- 没有找到提交中实际报告质量的统计。

## 入组与运营预测：有什么被证明比 Poisson-Gamma 好？

### Takeaway
没有找到任何证据表明某个新模型在真实试验的前瞻预测上稳定打败 Poisson-Gamma。最接近的 Pfizer/Merck 工作是把 Poisson-Gamma 嵌进深度模型，依赖专有数据且对照很弱。时间依赖的 Poisson-Gamma 扩展有道理，但证据主要是模拟或单个队列。保持现有方法，以后加一个入组衰减检验即可。

### Cited Findings
- Do, Masquelier, Lee（Pfizer）, Crowther（Merck），arXiv 2507.23607v2（2025-10）：用 Citeline、DQS 数据，训练 9410、测试 1000 个试验，预测入组数；基线（目标人数）R² 0.39、MAE 71.42，LightGBM R² 0.76、MAE 56.84，确定性模型 R² 0.76、MAE 51.99，概率模型 R² 0.77、MAE 55.92。时长预测用 Deep Poisson-Gamma，子集 635/53/61 个试验，相比 “Filtering-and-Fitting” MAE 9.99 降到 7.85 个月，6 个月窗口覆盖 22.95% 到 26.23%。 [PP；全文；业界作者；测试集只有 61 个；覆盖率低] — [arXiv 2507.23607](https://arxiv.org/abs/2507.23607v2)
- Urbas, Sherlock, Metcalfe，Biostatistics：给出两个衰减检测和衰减强度模型，用肿瘤试验数据做期中预测。 [PR；摘要级] — [PMC9007446](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9007446/)
- Mountain & Sherlock，Biometrics 2022;78(2):636–648：预测区间的校准，主要是模拟。 [PR；摘要级] — [IDEAS](https://ideas.repec.org/a/bla/biomet/v78y2022i2p636-648.html)
- Anisimov & Oliver（arXiv 2411.17393）时间依赖 Poisson-Gamma 和同质性检验，用模拟数据；他们也指出若衰减持续，预测可能很差。 [PP；摘要级] — [arXiv 2411.17393](https://arxiv.org/pdf/2411.17393)
- Turchetta, Savy, Stephens, Moodie, Klein（arXiv 2301.03710，2023）：时间依赖 PG，应用于加拿大合并感染队列（CCC），不是试验。Vivli 项目页称它比标准 PG 显著改善，并计划在四个试验上检验，结果我没有找到。 [PP；摘要级] — [arXiv 2301.03710](https://arxiv.org/abs/2301.03710)；[Vivli](https://vivli.org/?p=12295)
- arXiv 2303.08065 建议用研究级历史数据改进计划阶段预测。 [PP；摘要级] — [arXiv 2303.08065](https://web3.arxiv.org/abs/2303.08065)
- 软件：RCTRecruit 0.2.0，MIT，2025-04-21（非参数，CRAN 页面未引用验证研究）；eventPred 0.3.1，GPL (>= 2)，2026-08-01（事件预测，闭包 94）；accrual 1.4，GPL-2，2023。 — [RCTRecruit](https://cran.r-project.org/web/packages/RCTRecruit/index.html)；[eventPred](https://crandb.r-pkg.org/eventPred)；[accrual](https://crandb.r-pkg.org/accrual)
- 引擎的 `accrual.R` 已有闭式解、分批开中心的模拟和“registry 给不了先验”的说明。 — 分支 `项目代码/vcr-engine/R/accrual.R`

### Inferences

**候选：深度学习入组预测**
- 判定：**不值得**。理由：专有数据和预训练语言模型，与“无 GPU、无专有数据”不符；61 个试验的覆盖率只有 26%；未与 Anisimov-Fedorov 直接比较。

**候选：衰减检验与时间依赖 PG**
- 实现：手写（Urbas 的检验），解析或简单模拟。R。
- 新能回答：“当前入组速度在下降吗？按常数率预测是否过于乐观？”
- 判定：**以后**。这需要试验进行中的逐中心数据，当前用户未必有；不涉及招募流程，与业主规则不冲突。

**候选：事件预测（eventPred 类）**
- 新能回答：“按当前进度，何时达到 300 个事件？”判定：**以后**。理由：要用中数据，闭包太重，需要时手写。

**候选：RCTRecruit**
- 判定：**不值得**。未见验证研究。

### Gaps
- 没有找到 Poisson-Gamma 与竞争模型在多个真实试验上的前瞻性、预先注册比较。
- Vivli 项目结果未找到。
- 真实预测区间覆盖率的独立评估未找到。
