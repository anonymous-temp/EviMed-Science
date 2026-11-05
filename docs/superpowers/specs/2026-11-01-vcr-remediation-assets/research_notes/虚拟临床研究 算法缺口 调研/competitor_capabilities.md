# 竞品能力表：虚拟临床试验与 in-silico 试验产品在算法上到底提供了什么，EviMed 缺什么（截至 2026-11-02）

> 证据标签。**[一手-已读]** 监管文件、公开手册或 CRAN 页面，本轮亲自打开过。**[厂商-已读]** 厂商文件，本轮打开过，内容是厂商自述。**[厂商-摘要]** 厂商自述，只见到搜索工具返回的摘要，没开原页。**[独立-摘要]** 非厂商来源，只见摘要。**[前序]** 取自 `docs/superpowers/specs/2026-10-25-vcr-ai-native-reset-review-assets/r1-international.md` 或 `r2-china.md`，本轮未重新打开原页。**[单一来源]** 只找到一处。**[未核实]** 找不到可以确认的东西。
>
> 范围说明。PROCOVA 与 Unlearn 单臂论文的方法细节、target trial emulation、CDE 三份指导原则的章节内容已在 `comparators.md` 写过；East Horizon R 助手、Veristat、jinkō skills 的流水线已在 `agents_evidence.md` 写过。这里只引用结论，不重复。

## 试验设计与模拟：Cytel、rpact、FACTS、Veristat、Medidata 的手册列了哪些我们没有的设计方法

### Takeaway
公开文件里点名的设计方法，EviMed 缺得最多的是六类：多臂多阶段与多重性、样本量再估计与 promising zone、人群富集、MCPMod 剂量反应、剂量递增、贝叶斯自适应（RAR、预测概率决策、平台试验）。这些几乎都是公开发表的方法，一部分已有开源 R 实现，所以是本轮最容易补的缺口。FACTS 手册公开可读，是最好的一手清单；Cytel 依旧只有 data sheet，没有公开手册。

### Cited Findings
**Cytel East Horizon**
- data sheet（© 2025，本轮全文读过）列的模块是 Fixed Sample、Group Sequential、Multiplicity、Adaptive、Dose Escalation、Dose Finding；关键能力另列 Exact Designs、Bayesian Designs、Multiple Endpoints、Crossover、Program Simulations、Custom R Code Integration — [Cytel data sheet](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]
- Multiplicity 模块点名：MAMS、把成组序贯扩到两臂以上、基于 p 值合并的两阶段 treatment selection（data sheet 写 "Poschet. al., Statistics in Medicine, 2005"，应为 Posch 等）、Dunnett、Bonferroni、Sidak、Holm、Hochberg、Hommel、Fixed Sequence、Fallback、serial 与 parallel gatekeeping、gMCP、混合终点、非比例风险模拟；power 分 global、disjunctive、conjunctive、marginal — [同上](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]
- Adaptive 模块点名：全人群或亚组的样本量增加规则、生存终点的样本量和事件数自适应、基于非盲期中数据的 Promising Zone、时间事件终点的人群富集、"Adjusted unbiased point estimates, confidence intervals, and p-values"、方法 "CHW, CDL, Müller-Schäfer" — [同上](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]
- Dose Escalation 点名：3+3、CRM、BLRM、mTPI；双药组合 BLRM、PIPE、mTPI-2。Dose Finding 点名：MCPMod 的设计与分析（continuous、binary、count） — [同上](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]
- Fixed 与 GS 模块点名：Simon 两阶段、小样本精确单阶段（binary）、Bayesian probability of success、条件与预测 power、基于替代终点的 go/no-go、分层与亚组分析、按样本量/时长/成本优化设计 — [同上](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]
- MAMS 的两种做法：stage-wise（合并独立 p 值，normal、binomial、time-to-event，两阶段）和 cumulative（Cytel 称优于 stage-wise） — [Cytel 检索摘要](https://www.cytel.com/blog/new-horizons-webinar-series-adaptive-multi-arm-multi-stage-clinical-trials) [厂商-摘要]
- Solara 的公开材料只见到 "trial design selection platform" 和一个 simulation-based assurance 网络研讨会 — [Cytel software](https://www.cytel.com/software)；[Solara assurance webinar](https://www.cytel.com/webinar-cytel-bayesian-assurance?hsLang=en) [厂商-摘要]

**nQuery 不是 Cytel 的产品**
- 任务书把 nQuery 列在 Cytel 下，公开页面显示它属于 Statsols。nQuery Bayes 列出 Bayesian Assurance、Bayesian Testing、Predictive Power、CRM、贝叶斯样本量、credible interval、Bayes factor，并自称 "1000+ validated statistical procedures" — [Statsols nQuery Bayes](https://www.statsols.com/nquery-bayes) [厂商-摘要]

**rpact 与 RPACT Cloud**
- CRAN：`rpact` 4.4.0，2026-03-04 发布，**LGPL-3**，覆盖连续、二分类、生存终点的成组序贯和合并检验多阶段设计，方法依据 Wassmer and Brannath (2025) — [CRAN rpact](https://cran.r-project.org/package=rpact) [一手-已读]
- 31 篇官方 vignette 中点名：多臂多阶段（二分类的规划与分析、连续终点模拟）、富集设计（rates）、count data、inverse normal 合并检验下的样本量再评估、非盲样本量再计算模拟、Promising Zone、期中边界重算、delayed response、模拟法生存成组序贯 — [rpact vignettes](https://www.rpact.org/vignettes) [一手-已读]
- 该 vignette 清单没有贝叶斯设计。RPACT Cloud 是 rpact 的 validated web GUI，公开版功能受限，私有版定制 — [rpact products](https://www.rpact.com/products) [厂商-已读]。同家另有开源 `crmPack` 做剂量递增 — [同上](https://www.rpact.com/products) [厂商-已读]

**FACTS（Berry Consultants）：手册是公开的**
- 引擎类型：Dose Escalation、Dose Finding、Adaptive Phase 3、Seamless Phase 2/3、Platform、Multiple Endpoint、Enrichment、Staged。终点：连续、二分类、时间事件，自 8.0 起加 ordinal；每受试者最多 4 个连续或二分类终点，用 utility function 决策 — [FACTS Summary Features](https://www.berryconsultants.com/wp-content/uploads/2023/04/FACTS-Summary-Features.pdf) [厂商-已读]
- 决策量：后验概率、预测概率、条件 power、p 值、非劣效概率、super superiority 概率、成为 ED90 的概率、成为最小有效剂量的概率。还有模型内多重插补、控制臂的历史借用 hierarchical prior、按 site 的 accrual ramp — [同上](https://www.berryconsultants.com/wp-content/uploads/2023/04/FACTS-Summary-Features.pdf) [厂商-已读]
- 终点模型（v7.2 手册）：Independent Dose、Independent Beta-Binomial、Simple / Monotonic / Second Order NDLM、3-Parameter Logistic、Hierarchical Logistic、Sigmoid (Emax)、U-Shaped、Plateau、3 Parameter Exponential Logistic、Hierarchical、Linear、Hierarchical Linear；二维剂量有 2D Continuous Factorial、2D Discrete Factorial、2D NDLM。历史对照按充分统计量录入，可下调有效样本量，手册带 Bayesian Augmented Control 示例 — [FACTS dose response v7.2](https://docs.berryconsultants.com/documentation/v72/userguides/core/design/doseresponse.html) [一手-已读]
- FACTS 8.0.0 新增：ordinal 的 cumulative logistic 与 Dirichlet 两种模型；Fixed 与 Group Sequential Quick Start（Hwang-Shih-DeCani、O'Brien-Fleming、Pocock）；Core、Staged、Platform 的 AND/OR 决策规则（支持 Bayesian Goldilocks）；CRM 的 backfill 与 run-in 规则；rule-based 的 BOIN 与 3+3 修正；手册另有 3+3、mTPI、mTPI-2、i3+3、BOIN 专章 — [FACTS 8.0.0 release notes](https://docs.berryconsultants.com/documentation/versions/v8/facts800.html) [一手-已读]
- 平台试验引擎（v8.2 手册，读了前 10 万字符，全文 15.3 万）：只支持连续和二分类；按臂独立决策；分析用 MCMC；可用全部对照或 concurrent controls only；RAR 按臂做 burn-in；臂到达有时间窗，受最大并行臂数限制；**未实现纵向模型，未实现试验内预测概率，p 值无 Bonferroni 或 Dunnett 调整** — [FACTS Platform v8.2](https://docs.berryconsultants.com/documentation/v82/userguides/platform.html) [一手-已读]
- 文档路径已到 v8.2，说明 8.0 之后还有发布；r1 称未找到 2026 年版本，我这边也没确认 v8.1 和 v8.2 的日期 — [FACTS docs](https://docs.berryconsultants.com/documentation/v82/userguides/crm.html) [未核实]
- FACTS 7.1 发布说明的旧 PDF 地址返回 404，未能读取 — [404 地址](https://berryconsultants.com/wp-content/uploads/2024/12/FACTS-7.1-Release-Notes.pdf)

**Veristat 与 Medidata 的设计类**
- Veristat 未公开设计方法手册。InStat（2026-05）的公开形态是 AI 把统计师描述转成 specification，再由 validated engine 执行；首位 sponsor 是 Clene Nanomedicine，五周到五天的数字带有条件说明 — [Bioxconomy](https://www.bioxconomy.com/clinical-and-research/veristat-launches-ai-platform-for-faster-trials)；[Clinical Trials Arena](https://www.clinicaltrialsarena.com/features/clinical-trial-statistics-gets-an-ai-era-overhaul/) [厂商-摘要]
- Medidata Protocol Optimization 公开说法是预测患者负担、中心表现和成本，属于运营模拟，不是统计 power 模拟 — r1 §2.2 所引 [Medidata 新闻](https://medidata.com/en/about-us/news-and-press/medidatas-ai-powered-protocol-optimization-secures-4th-consecutive-best-of-show-award-at-scope-2026) [前序]

### Inferences
- 对照 EviMed 的 `design.analytic`、`design.simulate`、`design.grid`、`design.assurance`、`design.procova`、`accrual.poisson_gamma`：已有固定设计、成组序贯、Simon、单臂、MaxCombo、assurance、PROCOVA。未见上述多臂、再估计、富集、MCPMod、任何剂量递增、RAR、平台、ordinal、count、crossover、精确二分类、多终点 utility。这个判断只依据 `00_context_current_methods.md` 的方法清单，没有读引擎代码。
- East Horizon 与 FACTS 的差别是流派差别：East 偏频率学派加多重性控制，FACTS 偏贝叶斯模型加决策量。如果只补一个，rpact 能覆盖 East 的大部分自适应内容，贝叶斯决策量需要另写。
- FACTS 平台手册写明未实现的内容（无纵向模型、无试验内预测概率、无多重性调整）说明行业标杆也不是全功能，补缺时不必追求一次到位。

### Gaps
- East Horizon 的用户手册不公开，这一点仍然成立。data sheet 只给方法名，没有边界族的完整列表、模拟参数或验证报告。哪些模块属于收费 add-on，data sheet 只写 "Ask about East Horizon Add-On Products"，未列明。
- Solara 没有找到方法文档。与 East Horizon 的现行关系（并存还是被吸收）未确认。
- Veristat 无公开设计方法清单。
- FACTS Enrichment、Multiple Endpoint、Longitudinal 专章本轮未读。

## 数字孪生与虚拟患者：Unlearn、Aitia、Certara、Medidata Simulants、InSilicoTrials、Nova、PhaseV、Sanofi 型披露

### Takeaway
被监管文件背书的只有两件，都很窄：Unlearn 的 PROCOVA（RCT 内协变量调整，且有效性不依赖模型好坏）和 Simcyp V19（白人成年健康受试者中 CYP 介导 DDI 的平均幅度）。其余数字孪生都停留在厂商自述或内部决策层面。缺口的本质是训练数据和机理模型库，不是算法写法。

### Cited Findings
**Unlearn**
- 公开页面仍把 EMA qualification 写成核心背书，对 FDA 的措辞弱得多，只说 "positive feedback"。FDA 无 qualification；CDER 的回复是 PROCOVA 看起来未偏离指南，后续请求须针对具体产品或试验；另一篇 Unlearn 帖子称 FDA 因现有协变量指南已覆盖而婉拒其 ISTAND 申请 — [Unlearn 首页](https://www.unlearn.ai/)；[Unlearn FDA 博客](https://www.unlearn.ai/blog/us-fda-comments-on-unlearns-procova-methodology) [厂商-摘要] [单一来源：全部来自 Unlearn 自述]
- Evidence 页列 4 项：设计阶段样本量减 20%、Phase 3 再分析约省 18% 成本、控制臂小 33% 省 4 个多月、单臂再分析比 PSM 更接近随机结果（TFC power 从 70% 到 86%）。页面**没有任何监管陈述**，也不标同行评议，第 4 项链到 arXiv 预印本 — [Unlearn Evidence](https://www.unlearn.ai/evidence) [厂商-已读]
- 2026 ALS Summit 海报：比较 PSM 与数字孪生法（outcome model plug-in、AIPW），约 30–60% 方差缩减，偏倚都低。页面**不说明数据集、样本量、终点名称和模型架构** — [Unlearn ALS poster](https://www.unlearn.ai/evidence/als-summit-2026-synthetic-control-arms) [厂商-已读]
- 能查到的架构披露是 2020 年的 CRBM：用 2,395 名 MS 受试者的安慰剂臂数据训练，称生成的孪生与真实受试者在多项指标上统计上不可区分；Renew NCP-5 的 SAP 也写到 CRBM — [arXiv 2002.02779](https://arxiv.org/pdf/2002.02779)；[NCT03721705 SAP](https://cdn.clinicaltrials.gov/large-docs/05/NCT03721705/SAP_001.pdf) [独立-摘要，前者为厂商作者预印本]
- VectorY PIONEER-ALS 的合作（2026-02-12）明确定位是 Phase 1/2 探索性外部对照，没有注册用途 — [Newswire](https://www.newswire.com/news/unlearn-to-apply-ai-generated-digital-twins-to-the-vectory-22726468) [厂商-摘要]
- **需要警惕的说法**：一篇博客称 FDA 已在多个申报中接受 TwinRCT 合成对照，没有任何一手支持，不应引用 — [aimagicx 博客](https://www.aimagicx.com/blog/ai-clinical-trials-digital-twins-fda-2026) [未核实]

**Certara Simcyp 与 QSP**
- EMA qualification opinion，CHMP 2025-07-24 通过：Simcyp v19 用于预测 CYP1A2、2C8、2C9、2C19、2D6、3A4/5 介导相互作用的**平均幅度**，三个 CoU 都要求已有相应临床 DDI 研究来验证参数 — [EMA Simcyp opinion](https://www.ema.europa.eu/en/documents/other/qualification-opinion-simcyp-simulator_en.pdf) [一手-已读]。这也补上了 r1 中“contexts 未核实”的空白。
- 依据是 220 个临床研究的 qualification matrix 加基于模型的贝叶斯 meta 分析：GMR-AUC 偏倚 +5.8%（95% CrI +1.9 到 +10，竞争性抑制）、+4.2%（−3.6 到 +13，MBI）；不精确度 18% 与 25%；**个体间变异低估 2.0 倍（0.53 到 7.5）** — [同上](https://www.ema.europa.eu/en/documents/other/qualification-opinion-simcyp-simulator_en.pdf) [一手-已读]
- 明确不在范围内：平台技术验证、非 CYP 酶、转运体与诱导 DDI、没有临床 DDI 研究的预测、个体间变异、**非白人人群** — [同上](https://www.ema.europa.eu/en/documents/other/qualification-opinion-simcyp-simulator_en.pdf) [一手-已读]
- 厂商数字：120 余个 FDA 批准新药用过 Simcyp 替代临床研究；29 个人群库、100 多个化合物模型。这些是用过的药物数，不是说明书引用数，未见独立核实 — [Certara Simcyp](https://www.certara.com/software/simcyp-pbpk/) [厂商-摘要]
- 2026-03 Certara 称转运体 DDI 仍在扩展支持，与 EMA opinion 把转运体列为范围外一致。摘要未指明具体页面，链接为 Certara 的 PBPK 列表页 — [Certara PBPK 标签页](https://www.certara.com/tag/pbpk/) [厂商-摘要]
- QSP 监管先例本轮未找到。r1 记录了 MSK 的 CAR-T 虚拟患者和 Pompe 虚拟人群，均来自财报电话转述 — r1 §6 [前序]

**Medidata Simulants**
- 公开材料只写 "Medidata's patented algorithm" 和 ">30,000 cross-sponsor trials and 9 million patients"（2023-10）。**不披露架构、保真度指标或隐私指标**，"regulatory-grade" 只是形容词，没有点名任何监管机构 — [Simulants fact sheet](https://www.medidata.com/wp-content/uploads/2023/10/FACT-SHEET-Simulants.pdf)；[Clinical Leader e-book 页](https://www.clinicalleader.com/doc/simulants-medidata-s-generative-ai-algorithm-for-generating-synthetic-clinical-data-0001) [厂商-已读]
- Medidata 博客称 2023 年获专利并有 "best paper award at ICML"。我没有定位到该论文或专利号，不能确认 — [Medidata 博客](https://www.medidata.com/en/life-science-resources/medidata-blog/generative-ai-2023-revolutionizes-industries-healthcare/) [厂商-摘要] [未核实]
- Simulants Explorer 是面向选定用户的受限版本，可看样例数据和保真度图 — [Medidata 博客](https://medidata.com/en/life-science-resources/medidata-blog/enhancing-clinical-trials-with-ai-augmentation) [厂商-摘要]

**Nova In Silico（原 Novadiscovery）jinkō**
- 称用 NSCLC QSP 模型和 5,900 名数字患者预测 MARIPOSA，HR 0.60（CI 0.50–0.70），与实际区间重叠；同样披露 FLAURA2。**未确认是在读出前锁定的前瞻预测**，也未找到同行评议的预测验证论文 — [Biospace](https://www.biospace.com/novadiscovery-announces-success-of-first-of-its-kind-clinical-trial-simulation-to-accurately-predict-findings-of-phase-iii-clinical-study)；[Nova](https://www.novadiscovery.com/?p=1493) [厂商-摘要]
- 称参加过 FDA MIDD pilot。未见 FDA 或 EMA 接受 jinkō 模拟用于决策的记录 — [Nova 介绍](https://www.novadiscovery.com/?p=279) [厂商-摘要]

**其他**
- Sanofi（内部披露）：用 QSP 和活体患者试验数据构建哮喘虚拟患者，在 Phase 1b 数据出来之前盲预测，结果吻合，并用于决定是否推进（后续报道称 lunsekimig 走向 Phase 3）。Sanofi 自己写明模型在单基因病和机制清楚的病种最强 — [Sanofi magazine](https://www.sanofi.com/en/magazine/our-science/digital-twinning-clinical-trials-ai)；[Healthcare Brew](https://www.healthcare-brew.com/stories/2024/12/09/sanofi-digital-twins-modern-clinical-trials) [厂商-摘要，无数值，无同行评议]
- PhaseV：强化学习与 causal ML 用于自适应设计和闭环执行，公开预印本涉及 Causal Responder Detection 和 CATE；未见监管记录 — [PhaseV 博客](https://www.phasevtrials.com/post/advancing-adaptive-clinical-trials-with-causal-ml-with-raviv-pryluk-from-phasev)；[Outsourcing-Pharma](https://www.outsourcing-pharma.com/Article/2023/10/25/advanced-tech-company-phasev-has-raised-15-million-in-funding) [厂商-摘要]
- Aitia（Gemini Digital Twins）：多组学因果 AI，用于靶点和疗法发现，未见试验设计、匹配或合成对照产品 — r1 §10 所引 [Servier 2024](https://insights.servier.com/wp-content/uploads/2024/03/insights-servier-science-calling_EN.pdf) [前序]
- InSilicoTrials：按次付费的云平台，托管 PK/PD、agent-based、有限元、CFD 与 AI 模型；"FDA-supported in silico methodologies" 未核实 — r1 §9 [前序]
- Bioptimus M-Optimus：多模态模型，early access；关于试验设计和数字孪生的说法目前是愿景 — [Tirto PR](https://tirto.id/bioptimus-unveils-m-optimus-a-world-model-for-biology-hn1z) [厂商-摘要]
- Twin Health 是代谢病的直接照护产品，按任务说明不相关，未调查。

### Inferences
- “数字孪生”在这里至少是三种东西：统计预后预测（Unlearn）、机理虚拟患者（Certara、Nova、Sanofi）、生成式合成数据（Medidata Simulants）。EviMed 现有的 `population.synthpop` 和 `patients.*` 属于第三种的简化版，加上用户自带方程的 `model.prognostic_apply`，不能叫孪生。
- Simcyp 的 opinion 是好模板：先说 context of use，再给基于大量临床研究的偏倚和不精确度，再列不适用范围。EviMed 不需要监管认证也能照这个格式报告自己的方法。
- PROCOVA 的 opinion 说有效性不依赖模型质量，这意味着“RCT 内预后调整”这一路对 EviMed 影响最小：用户自带模型就能得到统计有效的结果，模型越好只是越省样本。这一点 `design.procova` 和 `comparator.prognostic_adjustment` 已经覆盖。

### Gaps
- Medidata Simulants 的算法**仍没有公开文档**，这一点依旧成立。
- Unlearn 现行 DTG 架构（是否仍为 CRBM，是否有 "neural Boltzmann machine"）未找到公开依据。
- 未找到非 Unlearn 作者对其孪生的独立验证。
- 没有专门检索 Sanofi 与 BCG 的联合披露，也未找到相关材料。
- QSP 的监管受理案例未找到。

## 外部对照与 RWE：Aetion、Medidata SCA、ConcertAI、Flatiron、TriNetX、OHDSI、IQVIA、Komodo、Datavant

### Takeaway
这一类的护城河是数据，不是方法。文件里能点名的方法都很常规（PSM、IPTW、hdPS、大规模回归、经验校准），OHDSI 还全部开源。FDA 自己公开的 CDER 批准清单里，外部对照案例用的是病历和自然史注册库，没有点名任何商业数据厂商。

### Cited Findings
**Medidata SCA**
- 2026-06 fact sheet：>38,000 个试验、1,200 万患者的历史试验数据，100 多个标准化协变量，PSM 或加权，由 Medidata 研究团队构建，案例含 Imunon、Arcus、Medicenna、Kite — r1 §2.1 所引 [SCA fact sheet](https://www.medidata.com/wp-content/uploads/2026/08/Synthetic-Control-Arm-SCA-Fact-Sheet-June-2026_CN_compressed.pdf) [前序]
- 监管证明点：2020-10 Medicenna 的 MDNA55 Phase 3（复发 GBM）混合外部对照得到 FDA “supported”，厂商称可减少约三分之二、即 100 名前瞻对照。来源全是 Medidata 和 Medicenna 的新闻稿 — [3DS 新闻稿](https://www.3ds.com/newsroom/press-releases/medidata-synthetic-control-arm-supported-us-food-and-drug-administration-use-medicenna-therapeutics-corp-phase-3-registrational-trial-recurrent-glioblastoma)；[Medidata 案例](https://medidata.com/en/medicenna-synthetic-control-arm-case-study) [厂商-摘要] [单一来源类型]
- 该 Phase 3 现状本轮未查到；“supported”也不等于批准依据 — 见 Gaps。

**Aetion（已并入 Datavant）**
- Datavant 2025-05 宣布收购，后已完成，Aetion 归入其 Life Sciences 部门 — [Business Wire](https://www.businesswire.com/news/home/20250515882812/en/Datavant-to-Acquire-Aetion-Empowering-Healthcare-and-Life-Sciences-Organizations-to-Generate-High-Quality-Scalable-Real-World-Evidence-from-Connected-Privacy-Protected-Data)；[Pulse2](https://pulse2.com/datavant-acquisition-of-aetion-completed/amp/) [厂商-摘要]
- Substantiate 支持多种 PS 方法（匹配和加权）并集成 hdPS，这来自 2025-04 Aetion evidence-hub 文章的摘要。**该地址现在 301 跳转到一个完全不提 Aetion 的 Datavant 页面**，我无法读原文 — [原地址](https://evidence-hub.aetion.com/feature-spotlight-streamlining-propensity-score-adjustment-with-substantiate)；[跳转页](https://www.datavant.com/real-world-data-rwd) [厂商-摘要] [单一来源]
- Datavant 自述：350+ 真实世界数据伙伴、触达 8 万多家医院诊所、约四分之三 top 100 医疗系统 — [Datavant](https://www.datavant.com/real-world-data-rwd) [厂商-已读]
- RCT-DUPLICATE（JAMA 2023）：32 个 RCT 的数据库模拟，Pearson r 0.82（0.64–0.91）；显著性一致性 75% 经 JAMA 更正为 72%；post hoc 的 16 个紧密模拟 r 0.93。Duke 托管的 FDA 网络研讨会幻灯片写 0.80 和 0.94，与论文不同，来源之间有出入 — [PMC10130954](https://pmc.ncbi.nlm.nih.gov/articles/PMC10130954)；[Duke 幻灯片](https://healthpolicy.duke.edu/sites/default/files/2026-05/Slide%20Deck_FDA%20Webinar%20on%20the%20RCT-DUPLICATE%20Initiative.pdf) [独立-摘要]
- 2023 年 FDA OCE 用过 Aetion 平台分析 RWD 来源 — [Mobihealthnews](https://www.mobihealthnews.com/news/datavant-acquires-aetion-expand-rwe-platform) [厂商-摘要]

**Flatiron、ConcertAI、IQVIA、Komodo**
- Flatiron 与 FDA INFORMED 自 2016 年合作，2019 年续约，覆盖数据质量、真实世界终点验证、真实世界对照 — [Flatiron 新闻稿](https://resources.flatiron.com/press/press-release/the-fda-and-flatiron-health-expand-real-world-data-cancer-research-collaboration) [厂商-摘要]
- Flatiron 称 RWE 完全满足一项上市后承诺，并支持 Erbitux 每两周给药的批准。摘要未指明这两点各出自哪一页，这里给的是同次检索中最接近的页面，未逐页核对 — [GeneOnline](https://www.geneonline.com/as-real-world-evidence-gains-ground-in-oncology-where-does-flatiron-health-fit-in/) [厂商-摘要] [未核实]。未找到 Flatiron 数据支持外部对照申报的具体案例。
- ConcertAI：只找到低可信度的第三方对比页，没有可用的技术文档或监管记录 — [rfp.wiki](https://www.rfp.wiki/specialty-industries/healthcare-life-sciences/pharmaceutical-companies/health-tech-ai-pharma-partners/concertai/komodo-health) [未核实]
- Komodo：自述 330M+ 去标识患者旅程、1 万亿以上链接记录，定位偏商业化 — [Contrary Research](https://research.contrary.com/company/komodo-health) [厂商-摘要]。未找到 Komodo 或 IQVIA 的外部对照 FDA 申报。IQVIA 有一篇肿瘤外部对照博客，本轮未打开 — [IQVIA 博客](https://www.iqvia.com/locations/united-states/blogs/2023/07/success-factors-how-to-get-external-comparators-right-in-oncology)

**TriNetX**
- 2026-06-23 称突破 3 亿患者（美国 1.86 亿、EMEA 7,200 万、拉美 2,300 万、亚太 2,100 万）；另一页写 318M+、9,200+ 站点，两处不一致 — [PR Newswire Asia](https://en.prnasia.com/story/538259-0.shtml)；[TriNetX 博客](https://trinetx.com/blog/what-300-million-patients-makes-possible-across-healthcare-not-just-the-drug-lifecycle/) [厂商-摘要]
- 2025 年一篇批评性综述：联邦架构，每日更新，数据多来自有保险人群和学术、急症机构；唯一点名的方法是 PSM；EHR 数据“未经独立验证”；并指出对平台的系统性方法评价尚属缺失。这篇自称 systematic review，但 Methods 没有检索策略 — [PMC12282508](https://pmc.ncbi.nlm.nih.gov/articles/PMC12282508/) [独立，已读前 10 万字符]
- 另有综述称 PSM 只能在两个队列之间进行 — [Biochemia Medica](https://mail.biochemia-medica.com/en/journal/35/3/10.11613/BM.2025.030502/fullArticle) [独立-摘要]。研究诚信方面，有评论称有论文写了平台界面做不到的分析步骤，这是二手说法，我未核实 — [CASRAI](https://casrai.org/guides/trinetx-study-surge-research-integrity) [未核实]
- 2026-01 自然语言界面 beta 只返回患者数、可行性指标和站点信息，不做个体级输出 — r1 §12 [前序]

**OHDSI 和 ATLAS**
- HADES 公开清单：CohortMethod（大规模回归的新用户队列）、SelfControlledCaseSeries、SelfControlledCohort、EvidenceSynthesis、PatientLevelPrediction、DeepPatientLevelPrediction、EnsemblePatientLevelPrediction、EmpiricalCalibration、MethodEvaluation、Characterization、CohortIncidence、TreatmentPatterns — [HADES packages](https://ohdsi.github.io/Hades/packages.html) [一手-已读]
- CRAN 上 CohortMethod 6.0.3（2026-06-22）与 EmpiricalCalibration 3.1.4（2025-02-14）可取 — [CohortMethod](https://cran.r-project.org/package=CohortMethod)；[EmpiricalCalibration](https://cran.r-project.org/package=EmpiricalCalibration) [一手，版本和日期已抓取，licence 未抓到]
- DARWIN EU 采用 OMOP 与 OHDSI 方法，这一说法来自一篇较弱的二手文章；EMA catalogue 中多数条目是进行中或计划中 — [noze.it](https://www.noze.it/en/insights/darwin-eu-real-world-evidence/)；[EMA catalogue 示例](https://catalogues.ema.europa.eu/print/pdf/node/4782) [独立-摘要]

### Inferences
- EviMed 的 comparator 组已经覆盖熵平衡、IPW、MAIC、AIPW、E-value、tipping point、负对照校准、covariate sets。按上述文件对照，明显缺的是**1:1 PS matching**（Medidata、TriNetX、Aetion 都以它为基本操作）、hdPS 或大规模正则化 PS、self-controlled 设计、target trial emulation 的成套规约、QBA。
- OHDSI 的工具依赖 OMOP 数据库连接，直接搬进“每个作业一个 R 进程、无网络、无数据库”的引擎不一定合适，这是我的推断，未试装。
- 数据规模的对比说明了问题：Medidata 12M、TriNetX 3 亿、Komodo 3.3 亿、Datavant 350+ 数据伙伴。算法再好，EviMed 的外部对照也只能建立在用户自带数据和公开汇总数据上。

### Gaps
- **Aetion 的方法手册仍不公开**，这一点依旧成立。旧 evidence-hub 内容现已跳转，公开可查的材料比以前更少。Aetion 在 RCT-DUPLICATE 中的具体角色本轮只见到新闻标题。
- Medidata SCA 的具体 PS 配方、协变量表和偏倚校正不公开。Medicenna Phase 3 是否真正启动、结果如何，未查到。
- ConcertAI 的方法与监管记录未能取得。

## 试验匹配与招募分析：Tempus、Massive Bio、TrialX、Paradigm、Triomics、ConcertAI、Deep 6、Mendel、Pi Health 与中国同行

### Takeaway
披露的共同结构是 LLM 抽取，加结构化或符号化规则判断，再加人工复核，这与 EviMed 的 Kleene 路线同型。EviMed 真正落后的是检索排序、抽取语料和评测规模，而招募网络不在业主允许的范围内。厂商数字几乎都没有独立复现。

### Cited Findings
- Tempus：ASCO 2025 摘要（Rich 等）用 RAG 取片段喂 GPT-4o，打分为 1 的患者匹配率 67%，平均 13% — [Tempus publication](https://www.tempus.com/publications/impact-of-large-language-models-on-trial-to-patient-matching-efficiency/) [厂商-摘要]
- Tempus Patient Query agent：196 个查询内部验证，总体准确率 94.39%，单查询 84.62%–100%；护士复核使每试验潜在匹配多 27.31% — [Tempus 文章](https://www.tempus.com/resources/content/articles/improving-patient-matching-efficiency-with-an-ai-powered-platform-2/) [厂商-摘要]
- Tempus 的漏斗：TApp 两年筛 244,986 名患者对 189 个试验；TriHealth 海报 15 个月筛 18,800+ 名，匹配 284，同意 28 — [Exigent 论文页](https://www.tempus.com/publications/optimizing-clinical-trial-subject-selection-insights-from-exigent-research-network-and-the-tempus-ai-time-program-collaboration/)；[TriHealth poster](https://tempus.com/wp-content/uploads/2024/05/Cooney_TriHealth_ASCO-2024-1.pdf) [厂商-摘要]
- Deep 6 AI：Tempus 2025-03-11 收购，750+ 站点、3,000 万以上患者，价格未披露；"25% 更多合格患者、最快 3 倍招募"是自述 — [Tempus 公告](https://www.tempus.com/news/pr/tempus-announces-acquisition-of-deep-6-ai/)；[GenomeWeb](https://www.genomeweb.com/cancer/tempus-ai-acquires-clinical-trial-patient-matching-firm-deep-6-ai) [厂商-摘要]
- Massive Bio：ESMO Real World Data and Digital Oncology，前瞻，3,804 名转移性癌症患者，F1 0.82，敏感度和特异度均 0.84，宣称优于 zero-shot GPT-4、chain-of-thought 和 GPT-4o（**页面不给基线分数**），三 agent 神经符号架构（抽取、归一化、推理）加肿瘤知识图谱和人工层。作者包括公司联合创始人，无独立评估者 — [Massive Bio 新闻](https://massivebio.com/massive-bio-publishes-landmark-prospective-study-demonstrating-ai-driven-clinical-trial-matching-at-scale-in-3804-cancer-patients/) [厂商-已读]。r1 另记 157,367 页文档和双肿瘤医师金标（κ 0.92）— r1 §24 [前序]
- Triomics：OncoLLM，Medical College of Wisconsin 研究称优于 GPT-3.5、与合格医师水平相当；GPT-4 每小时 6,055 美元对 OncoLLM 170 美元；"95% 准确率、匹配增加 40%"是公司自述；Mount Sinai 2026-01 系统级部署 PRISM。未读到论文本身 — [Fierce Healthcare](https://www.fiercehealthcare.com/ai-and-machine-learning/where-participation-clinical-trials-cancer-lacks-triomics-could-step)；[Mount Sinai](https://www.mountsinai.org/about/newsroom/2026/mount-sinai-launches-ai-powered-clinical-trial-matching-platform-to-expand-access-to-cancer-research)；[MCW](https://cancer.mcw.edu/stories/trailblazers-in-innovation) [厂商-摘要]
- Mendel：Hypercube 把 LLM 和专有 hypergraph 推理引擎结合。与 Cornell 的 ACR benchmark（1,400 份记录）F1 62.9 对 GPT-4 20.8。另一项肿瘤预筛研究：人加 AI 78.7%，人 76.7%，**AI 单独 63.5%**。同行评议状况未确认 — [Clinical Trials Arena](https://www.clinicaltrialsarena.com/news/mendel-sees-positive-results-in-ai-cohort-matching-trial/)；[Meta 博客](https://ai.meta.com/blog/mendel-ai-accelerating-clinical-trials-with-llama/) [厂商-摘要]
- Paradigm Health：Ochsner 联合新闻稿称持续比对病历与入排标准，并标记尚未合格但可能转为合格的患者，自称可及性增 41%、人工减 75% — r1 §17.3 [前序]
- 学术参照 TrialGPT 2.0（arXiv 2026-09，NIH 牵头，不是厂商）：288 个多中心回顾病例，约 91% 在前 10 中至少含一个医师推荐试验；筛选时间减 55.0%；嵌入肿瘤板 6 个月前瞻评估，至少有一个最终推荐的病例增 90.9%。同时公开 NIH-TrialBench（126 个临床医生撰写的合成案例，来自 11 个 NIH 研究所）。只读了摘要页，且是预印本 — [arXiv 2609.01202](https://arxiv.org/abs/2609.01202) [独立，已读摘要]
- TrialMatchAI 是另一个端到端推荐系统的学术预印本，本轮只见到标题 — [arXiv 2505.08508](https://arxiv.org/pdf/2505.08508) [未读内容]

**中国同行（均转引 r2-china.md，本轮两次检索没有新增可靠内容）**
- 零氪/厚普：400 名专职招募、近千家中心、"算法匹配叠加人工复核"，本质是运营 — [第一财经 2024-12-20](https://www.yicai.com/news/102411456.html) [前序]；2026-04 宣传文称筛选压到“秒级”、入组效率增 40%，无验证方法 — [china.com 宣传文](https://m.tech.china.com/hea/articles/20260417/202604171849594.html) [厂商-摘要]
- 水滴/翼帆：专利加 ">92%" — [财联社](https://www.cls.cn/detail/2294585) [前序]
- 太美（HK:02576）：AI Agent 矩阵偏数据管理、药物警戒和 TMF — [36Kr 软文](https://www.36kr.com/p/3913366926431368) [前序]
- 医渡：自称处理约 90 亿份授权真实世界记录，有“医渡智循”临床证据 agent — [同花顺](https://stock.10jqka.com.cn/20260630/c677826086.shtml) [前序]
- 智募云：CCTi2026 议题“AI自适应临床试验动态设计”，只是会议题目 — [新浪](https://finance.sina.com.cn/stock/med/2026-10-05/doc-iniuerix2655229.shtml) [前序]
- r2 的判断是这些声明都没有协议和可复现的评估，也未见中文入排加中文 EHR 的准确率研究 — `r2-china.md` 第 17 行和 N8 节 [前序]

### Inferences
- 与 EviMed 的 n2c2 2018 结果（62% unknown，严格准确率 0.355，判定时约 0.87）相比，厂商的 F1 0.82 或 94% 不可比：语料、金标和算分口径都不同，后者还是自评。真正能借鉴的是 Tempus 和 TrialGPT 的排序指标（打分分层、top-10 命中率）。这恰好是 EviMed 没有的：现在“合并后过滤，不排序”。
- Mendel 的 AI 单独 63.5% 而人机协同仅比人多 2 个百分点，这是少有的、对纯 AI 不利的厂商披露，引用时比 95% 这类数字更有价值。
- TriHealth 的 18,800 到 284 到 28 说明匹配准确率和入组是两回事，也支持业主把招募运营排除在外。
- NIH-TrialBench 如果公开可取，可作为继 n2c2 之后的第二把尺子，且成本很低。公开程度本轮未确认。

### Gaps
- TrialX、Pi Health、ConcertAI 的匹配：只做过合并检索，没有结果，不能当作它们没有披露。
- Triomics 的 OncoLLM 论文、Massive Bio 的期刊原文（Business Wire 403）未读，基线分数未知。
- 药明系 AI CRO：未找到可用材料。

## 结局预测：QuantHealth、Insilico inClinico、BenevolentAI 型、Formation Bio、Lindus、Bioptimus

### Takeaway
所有高准确率数字都是厂商自报，没有找到一项独立的、时间上向前的验证。学术基准在 Phase 2 上的区分度相当有限（约 0.57–0.76，口径不一）。这一方向不值得 EviMed 现在追。

### Cited Findings
- QuantHealth：2024 年称 100+ 模拟 85%、Phase 2 88% 对全国 28.9%；2025 年称 350+ 模拟最高 90%（168 个 Phase II）；2026-08 称 600+ 模拟最高 90%。2025 年新闻稿明说第三方验证“正在进行”，未找到发表结果 — [BW 2024](https://www.businesswire.com/news/home/20240820324274/en/QuantHealth-Releases-Outcomes-Showing-%24215M-in-Financial-Returns-and-85-Accuracy-for-Pharmaceutical-Organizations)；[BW 2025](https://www.businesswire.com/news/home/20250722764714/en/QuantHealth-Successfully-Simulates-350-Clinical-Trials-with-90-Accuracy-Delivering-%2431.4M-in-Savings-for-a-Top-10-Pharma-Company)；[QuantHealth about，见 r1 §3](https://quanthealth.ai/about-us) [厂商-摘要]
- Insilico inClinico：Clin Pharmacol Ther 论文（DOI 10.1002/cpt.3008）。摘要报道把 0.88 ROC AUC 写成 quasi-prospective，另一篇写成“前瞻 88%”；前瞻部分 79% 准确率，有一条摘要称基于 17 个试验。**二手来源互相混淆，须核对原文**。CEO 是共同作者，无第三方复现 — [Newswise](https://www.newswise.com/articles/7-yr-generative-ai-predicts-clinical-trial-outcomes)；[Clinical Research News](https://www.clinicalresearchnewsonline.com/news/2023/08/24/ai-powered-inclinico-aims-to-solve-the-phase-2-to-3-transition-problem) [厂商-摘要] [未核实]
- 学术基线：HINT 论文自报 Phase II ROC-AUC 0.761；一篇竞争论文报 TrialBench 的 Phase 2 ROC-AUC 0.569±0.010；ISPOR Europe 2025 海报报 HINT F1 Phase I/II/III 为 0.66、0.62、0.84，并称 TrialBench 多任务 F1<0.50。**数据集版本和指标都不同，不可直接比较** — [HINT](https://arxiv.org/pdf/2102.04252)；[ClinicalReTrial](https://arxiv.org/pdf/2601.00290)；[ISPOR 海报](https://www.ispor.org/heor-resources/presentations-database/presentation-cti/ispor-europe-2025/poster-session-1-2/ai-models-for-predicting-clinical-trial-success-capabilities-and-risks-of-pattern-driven-approaches) [独立-摘要]
- Formation Bio：公开的 Muse（与 Sanofi、OpenAI）是招募内容生成，不是结局预测；未见统计或预测产品 — r1 §18 [前序]
- Bioptimus：H-Optimus 的独立基准是公司转述（HEST、Leeds、PathBench），M-Optimus 未见临床试验验证；与 FFCD 合作取得 3,000 多名消化道肿瘤患者数据（来源被截断）— [Sofinnova](https://sofinnovapartners.com/news/bioptimus-hits-usd76m-funding-milestone-and-prepares-to-launch-groundbreaking-foundation-model-for-biology)；[Tirto PR](https://tirto.id/bioptimus-unveils-m-optimus-a-world-model-for-biology-hn1z) [厂商-摘要]

### Inferences
- "88% 对 28.9%" 是把模型准确率和行业成功率放在一起比，两个数不是同一量。任何这类产品的数字都要问：阳性预测值还是总体准确率，基准率多少，是否在读出前锁定。
- 厂商的预测准确率目前不构成 EviMed 的可比缺口，因为它们本身未被证实。如果想建立差异，EviMed 已有 `predictionRegistry.mjs`，公开登记、事后对账的向前预测记录恰好是这些厂商都没有发表的东西。这只是方向判断，未评估该模块现状。

### Gaps
- 没有找到带时间留出的、独立的 Phase 2 预测评估。
- BenevolentAI 型和 Lindus Health 没有检索到可用材料（合并查询中被 Bioptimus 结果占满），不能当作结论；Lindus 按公开定位是 CRO，这一点也未核实。

## Agent 与 LLM 原生同行：如何把 agent 和确定性方法混合

### Takeaway
通用科学 agent 都走“模型写代码、沙箱执行”，没有任何一家披露受验证的试验设计或因果引擎。把 LLM 接到已验证引擎上的是专业厂商（Cytel、Veristat、Certara、Nova），这已写入 `agents_evidence.md`。EviMed 的架构在这条线上是领先姿态，它缺的是引擎背后的方法数量。

### Cited Findings
- Manus：通用 agent，在沙箱容器里运行 Python 做回归；医学用途多是推测，一篇 2026 年评测称其缺少领域深度。没有发现临床试验统计专门能力或评测 — [arXiv 2505.02024](https://arxiv.org/html/2505.02024v3)；[fast.io](https://fast.io/resources/manus-ai-vs-question-ai-research/)；[aiagentrank](https://aiagentrank.io/blog/manus-ai-review-2026) [独立-摘要，质量低]
- Apodex：材料提到 Drug Research Computing Center、Apodex Model、TRACES 评估框架、FrontierAgent 工作台和 Apodex 1.1。**不同来源的域名和定位不一致**，未发现临床研究产品 — [Newswise](https://www.newswise.com/articles/apodex-opens-free-ai-computing-services-to-accelerate-drug-research)；[stork.ai](https://www.stork.ai/en/apodex-ai) [未核实]
- Biomni：环境打包 150 个工具、105 个软件、59 个数据库。AACR 博客转述 2026-07 Science 论文时提到其演示属案例而非系统基准，这一转述本轮未对原文 — [bioRxiv](https://www.biorxiv.org/content/10.1101/2025.05.30.656746.full.pdf)；[AACR](https://www.aacr.org/blog/2026/06/18/eye-on-ai-agentic-ai-brings-bots-to-the-bench/) [独立-摘要] [未核实]
- Kosmos（Edison，FutureHouse 分拆）：LLM、数据分析 agent、文献 agent 加 world model 迭代；自报 79.4% 结论准确 — [arXiv 2511.02824](https://arxiv.org/pdf/2511.02824)；[Edison](https://edisonscientific.com/articles/announcing-kosmos) [厂商-摘要]
- FutureHouse Robin：干性 AMD 候选药物假说；FutureHouse 自己说 Robin 还不能生成足够精确的可执行实验方案。Google co-scientist 按 Kosmos 论文的描述只生成假说，不做实验分析 — [AACR](https://www.aacr.org/blog/2026/06/18/eye-on-ai-agentic-ai-brings-bots-to-the-bench/)；[Kosmos HTML](https://arxiv.org/html/2511.02824v2) [独立-摘要，后者为竞品描述]
- OpenAI GPT-Rosalind：2026-04 研究预览，面向合格客户，LABBench2 上 11 项有 6 项胜 GPT-5.4（OpenAI 自报）；未见临床试验功能 — [IT Brief](https://itbrief.com.au/story/openai-launches-gpt-rosalind-for-life-sciences-research)；[Pulse2](https://pulse2.com/openai-gpt-rosalind-life-sciences-model-introduced-to-accelerate-drug-discovery-and-research-workflows/) [厂商-摘要]
- Anthropic Claude for Life Sciences（2025-10）：connector 模式；Medidata connector 只有 Platform Help 和 Predictive Site Ranking 两个工具，不暴露 SCA 或 Simulants — [Anthropic](https://www.anthropic.com/news/claude-for-life-sciences)；[Claude Medidata connector](https://claude.com/connectors/medidata) [厂商-摘要]
- Causaly：2025-09 发布 Agentic Research；自家 5-Dimensional Benchmarking 白皮书，未见独立准确率研究 — [Causaly](https://www.causaly.com/news/causaly-introduces-first-agentic-ai-platform-built-for-life-sciences-research-and-development)；[白皮书](https://www.causaly.com/downloads/benchmarking-agentic-ai-for-life-sciences) [厂商-摘要]
- Elicit：这一组里独立证据最好。Cochrane Evidence Synthesis and Methods 2025 比较 20 个 RCT，结论是仍需人工复核，干预效应等变量需要人工补；2026 medRxiv 随机研究称 AI 辅助抽取非劣、更快、更便宜（预印本）；99.4% 和 94% 是厂商数字 — [PMC12462964](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12462964/)；[medRxiv](https://www.medrxiv.org/content/10.64898/2026.02.25.26347053)；[Elicit 博客](https://elicit.com/blog/how-we-evaluated-elicit-systematic-review) [独立-摘要]

### Inferences
- Medidata connector 的范围很说明问题：哪怕是开放了 agent 入口的数据巨头，也不把合成对照和合成数据交给通用模型。
- EviMed 已知的问题“普通请求绕开模块、模型自己写脚本”正是通用 agent 的默认形态。能让 EviMed 区别于 Manus 型产品的，是确定性引擎真正被调用，以及每个数字带 Monte Carlo 标准误。这一点比再加几种方法更决定差异。

### Gaps
- 未发现任何通用 agent 在试验设计或外部对照任务上的受控评测。
- Apodex 的官方站点本轮未打开。Manus 的医疗用途证据质量低。

## 监管证明点：FDA、EMA 对合成对照与数字孪生的接受情况，以及 2024–2026 年 CDE 指导原则

### Takeaway
没有找到任何监管机构把模型生成的数字孪生作为单臂试验主要证据接受的记录。被接受的是病历和自然史注册库做的外部对照（罕见病为主）、RCT 内的预后协变量调整、窄范围的 PBPK。中国没有针对数字孪生、虚拟患者、合成对照或 AI 生成证据的专门指导原则，对外部对照态度谨慎。

### Cited Findings
**FDA**
- CDER 公开清单（本轮打开）共 13 条。明确是外部对照的：**Gamifant 2025**（AMETHYST 回顾队列，9 个北美和欧洲中心的病历）、**Voxzogo 2021**（AchNH 自然史注册库，两个单臂试验）、**Nulibry 2021**（两个单臂试验和扩展用药的病历）。**Kygevvi 2025** 是单臂加回顾病历加扩展用药的整合研究，配文献和病历的匹配未治疗对照。列确证证据的：Isturisa 2025、Aurlumyn 2024。其余角色有 Acetadote 2024、Onapgo 2025（安全性）、Vimpat 2023、Actemra 2022、Vijoice 2022、Orencia 2021、Prograf 2021。**清单未点名任何商业数据厂商，也没有数字孪生或合成数据** — [FDA CDER RWE approvals](https://www.fda.gov/science-research/real-world-evidence/cder-drug-approvals-used-real-world-evidence) [一手-已读，由抓取工具转成表格，单元细节未逐字核对]
- 同一入口另列 CDER 上市后研究、CDRH、CBER 清单，本轮未打开 — [FDA 索引](https://www.fda.gov/science-research/real-world-evidence/fda-use-real-world-evidence-regulatory-decision-making) [一手-已读]。转述称 Skysona 的 RWE 被认定构成实质证据 — [Becaris](https://becarispublishing.com/digital-content/blog-post/fda-expands-real-world-evidence-examples-used-regulatory-decision-making) [独立-摘要]
- 转述：CDER 的 RWE 方案提交从 FY2024 的 11 增至 FY2025 的 31，NDA/BLA 含 RWE 从 1 增至 10（不论是否影响结论）— [Becaris](https://becarispublishing.com/digital-content/blog-post/fda-releases-latest-figures-real-world-evidence-use-regulatory-submissions) [独立-摘要] [单一来源]
- 外部对照指南 2023-02 草案，未见定稿，FDA 罕见病指南页和 2026 年文件都仍称其为 draft — [FDA 草案](https://www.fda.gov/media/164960/download)；[FDA 罕见病指南页](https://www.fda.gov/drugs/guidances-drugs/guidance-documents-rare-disease-drug-development) [独立-摘要]
- 贝叶斯草案《Use of Bayesian Methodology in Clinical Trials of Drug and Biological Products》：联邦公报 2026-01-12，评论期至 2026-03-13；要求预设并论证先验、记录外部信息来源及排除、量化先验影响，并提交覆盖悲观假设的模拟报告 — [Applied Clinical Trials](https://appliedclinicaltrialsonline.com/view/fda-issues-draft-guidance-advance-bayesian-methods-clinical-trials)；[Hogan Lovells](https://insights.hoganlovells.com/report/lshc-horizons-2026/fda-signals-long-awaited-embrace-of-bayesian-methods-in-drug-and-biologic-trials) [独立-摘要]
- 2026-02 政策转向（NEJM 2026-02-19）：一个充分良好对照试验加确证证据成为默认批准依据 — [Premier Research](https://premier-research.com/perspectives/the-fdas-shift-to-one-pivotal-trial-what-it-means-for-modern-development-programs/) [独立-摘要] [单一来源，未读原文]
- AI 可信度草案（2025-01）和 FDA-EMA 十条 good AI practice（2026-01-14）— r1 §19.3 [前序]

**EMA 和 ICH**
- 两项 qualification：PROCOVA（CHMP 2022-09-15）与 Simcyp（CHMP 2025-07-24，见上）— [EMA PROCOVA](https://www.ema.europa.eu/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf) [前序]；[EMA Simcyp](https://www.ema.europa.eu/en/documents/other/qualification-opinion-simcyp-simulator_en.pdf) [一手-已读]
- EMA 另有机理模型评估与报告指南，涵盖 PBPK、PBBM、QSP — [EMA 指南页](https://www.ema.europa.eu/en/guideline-assessment-reporting-mechanistic-models-used-context-model-informed-drug-development) [独立-摘要，版本状态未确认]
- ICH E20（适应性设计）：Step 2 在 2025-06，2026-07-10 版工作计划写 2026-12 完成区域意见审议、2027-01 做 Step 3 的 PWP 咨询，2027-02 签署 Step 3 与 Step 4。**尚未定稿** — [ICH E20 workplan](https://database.ich.org/sites/default/files/ICH53_E20_EWG_Workplan_2026_0812.pdf) [一手，已读相关行]
- ICH M15（MIDD）：2024-11 草案，有摘要称目标 2026 完成，定稿状态未确认 — [RAPS](https://www.raps.org/resource/ema-proposes-new-guideline-on-model-informed-drug.html) [未核实]

**中国（CDE、NMPA）**
- 现有官方文件（编号和日期转引 r2-china.md，方法细节见 comparators.md）：通告 2026 年第 6 号（贝叶斯外部信息借用，试行，2026-01-20）；2025 年第 54 号（单臂支持抗肿瘤常规上市，2025-12-29）；2026 年第 27 号（临床试验申请临床评价，2026-03-25，外部或历史对照“多数情况下不建议使用”）；2026 年第 44 号（计算机化系统和电子数据，2026-09-22）；2026 年第 48 号（后线数据支持前线，2026-10-23）；公告 2026 年第 50 号（GCP，2026-09-01 施行，未提 AI、模拟、虚拟患者、外部对照）；公告 2026 年第 16 号（适用 ICH M14）；RWE 系列 2020 年第 1 号、第 22 号，2021 年第 27 号，2023-02 设计框架，2024 疾病登记 — `r2-china.md` 第 12–15、43–50、92–94 行；[第 6 号 PDF](https://www.cnpharm.com/upload/resources/file/2026/01/21/183608.pdf) [前序]
- r2 的结论：六份官方文本没有数字孪生、虚拟患者、合成对照的字样；国药监综〔2026〕6 号管的是监管机构自身用 AI，不是给申办方的指南。本轮两次新检索未找到新的 CDE AI 或 QSP 专门指导原则，也未找到 E20 转化公告 — `r2-china.md` 第 12、50、84、138、143 行 [前序]；我的检索未直接打开 cde.org.cn。
- 一条二手线索称 2025 年第 26 号临床药理学指导原则涉及罕见病 MIDD，未核实 — [Cisema](https://cisema.com/news/rare-disease-drug-development-guideline) [未核实]

### Inferences
- 监管上最有含金量的案例（Gamifant、Voxzogo、Nulibry）都是罕见病、效应明显、用病历或自然史注册库，算法本身很朴素。这意味着监管成功更多靠适用场景和数据来源，而不是高级方法。
- 对 to-C 平台：用户多半不是拿 EviMed 结果申报，所以监管记录的直接价值较低。间接价值在于可借用其报告格式，比如 CDE 第 6 号的模拟清单、FDA 贝叶斯草案的先验影响量化。这些都可以作为普通输出内容，不需要门禁。
- 如果不提“被监管接受”，EviMed 就不必背这一项。用词应该跟随文件：外部对照写外部对照，不写合成对照被接受。

### Gaps
- 没有确认 FDA 外部对照指南在 2026-11 的最新状态（FDA 指南搜索页未查）。
- “无监管机构接受孪生作单臂主要证据”是检索未见，不是证明不存在。
- CBER、CDRH 清单未读，可能有更多外部对照案例。
- PMDA、MHRA 未覆盖。

## EviMed 的长期缺口在哪里：算法、专有数据、验证模型、监管记录还是分发，算法能补哪些

### Takeaway
能靠算法补的是方法清单和匹配排序，工作量可控，且很多有现成上游。补不了的是专有患者级数据、用这些数据训练和验证过的模型、监管记录、机构网络。EviMed 不应宣称接近后者，应该把优势放在面向个人、对话式、数字确定可复现上；这一定位目前在竞品表里基本没有同类。

### Cited Findings

#### 能力总表
说明：“EviMed 缺什么”对照 `00_context_current_methods.md` 的方法清单，非代码审计。标签含义见文首。来源链接见前面各节，表内只放关键一条。

| 厂商 | 产品 | 文档中点名的算法 | 数据资产 | 证明点与来源 | EviMed 缺什么 |
|---|---|---|---|---|---|
| Cytel | East Horizon，Solara | MAMS，Posch 两阶段选择，Dunnett/Holm/Hochberg/Hommel，gatekeeping，gMCP，CHW/CDL/Müller-Schäfer，Promising Zone，富集，MCPMod，3+3/CRM/BLRM/mTPI，PIPE/mTPI-2，crossover，program simulation | 无患者数据；Azure 算力 | [data sheet](https://cytel.com/wp-content/uploads/2024/05/Cytel-Data-Sheet-East-Horizon-Platform.pdf) [厂商-已读]；无监管记录；手册不公开 | 多臂、多重性、再估计、富集、MCPMod、全部剂量递增、crossover、校正估计 |
| Statsols（不是 Cytel） | nQuery | assurance，predictive power，CRM，贝叶斯样本量，Bayes factor | 无 | [nQuery Bayes](https://www.statsols.com/nquery-bayes) [厂商-摘要] | CRM，贝叶斯检验样本量；assurance 已有 |
| RPACT | rpact，RPACT Cloud | 成组序贯，合并检验，多臂，富集，count，再评估，Promising Zone，delayed response | 无 | [CRAN，LGPL-3](https://cran.r-project.org/package=rpact) [一手]；validated 框架 | 运行时未挂载（现仅 CI 校验）；其方法面大部分未暴露 |
| Berry | FACTS 8.x | NDLM，Emax，3PL，hierarchical，U 型，plateau，2D，BAC，RAR，平台（concurrent），seamless，富集，ordinal（累积 logistic，Dirichlet），BOIN/i3+3/mTPI-2/N-CRM | 无 | [公开手册](https://docs.berryconsultants.com/documentation/v72/userguides/core/design/doseresponse.html) [一手-已读] | 贝叶斯决策量、RAR、平台、ordinal、借用入模拟 |
| Veristat | InStat | 未公开方法清单 | CRO 项目 | [Bioxconomy](https://www.bioxconomy.com/clinical-and-research/veristat-launches-ai-platform-for-faster-trials) [厂商-摘要] | 无法对比；架构同型 |
| Medidata | Protocol Optimization | “AI 预测建模”，未点名 | 历史试验库 | r1 §2.2 [前序] | 运营模拟（负担、中心、成本）。业主未要求 |
| Unlearn | TwinRCT，TrialPioneer | PROCOVA，AIPW，plug-in；CRBM（2020 年披露） | 历史试验数据，规模未披露；CHDI 等 | EMA 2022（RCT、连续终点）[前序]；FDA 无 qualification；[Evidence 无监管陈述](https://www.unlearn.ai/evidence) [厂商-已读] | 训练好的孪生生成器；可用历史数据；AIPW 的生存终点 |
| Medidata | Simulants | "patented algorithm"，未披露 | >30,000 试验，900 万患者 | [fact sheet](https://www.medidata.com/wp-content/uploads/2023/10/FACT-SHEET-Simulants.pdf) [厂商-已读]；无监管记录；保真度不公开 | 真实跨申办方试验数据；synthpop 算法本身已有 |
| Certara | Simcyp，QSP | PBPK（机理），贝叶斯 meta 评估 | 29 人群库，100+ 化合物模型 | [EMA 2025-07-24](https://www.ema.europa.eu/en/documents/other/qualification-opinion-simcyp-simulator_en.pdf) [一手-已读]，范围窄 | PBPK、QSP、ODE 求解，尤其是生理库和 220 研究的验证矩阵 |
| Nova In Silico | jinkō | 机理模型，虚拟人群，校准（见 agents_evidence） | 文献构建的模型库 | [MARIPOSA 预测](https://www.biospace.com/novadiscovery-announces-success-of-first-of-its-kind-clinical-trial-simulation-to-accurately-predict-findings-of-phase-iii-clinical-study) [厂商-摘要]，未确认事前锁定 | 疾病机理模型和其校准流程 |
| InSilicoTrials | 云平台 | PK/PD，agent-based，有限元，CFD | 托管第三方模型 | r1 §9 [前序] | 此类模型托管，方向不同 |
| Aitia | Gemini | 因果 AI，多组学 | 多组学患者数据 | r1 §10 [前序] | 不同赛道（靶点发现） |
| PhaseV | ML 自适应 | RL，causal ML，CATE | 未披露 | [PhaseV](https://www.phasevtrials.com/post/advancing-adaptive-clinical-trials-with-causal-ml-with-raviv-pryluk-from-phasev) [厂商-摘要]，无监管记录 | 无证据显示值得对标 |
| Sanofi | 内部 QSP | QSP 虚拟患者 | 自有试验数据 | [Sanofi](https://www.sanofi.com/en/magazine/our-science/digital-twinning-clinical-trials-ai) [厂商-摘要]，无数值 | 不是可购买产品 |
| Medidata | SCA | PSM 或加权，100+ 协变量 | >38,000 试验，1,200 万患者 | [Medicenna 2020](https://www.3ds.com/newsroom/press-releases/medidata-synthetic-control-arm-supported-us-food-and-drug-administration-use-medicenna-therapeutics-corp-phase-3-registrational-trial-recurrent-glioblastoma) [厂商-摘要] | 1:1 PSM（算法）；数据库（不可补） |
| Aetion / Datavant | Substantiate，Activate | PS 匹配和加权，hdPS（仅摘要）；手册不公开 | 经 Datavant 的 350+ 数据伙伴 | [RCT-DUPLICATE](https://pmc.ncbi.nlm.nih.gov/articles/PMC10130954) [独立-摘要]；FDA OCE 使用 [厂商-摘要] | hdPS，TTE 规约；数据网络 |
| Flatiron | 肿瘤 EHR 数据 | 未查到方法文档 | 肿瘤 EHR | [INFORMED 合作](https://resources.flatiron.com/press/press-release/the-fda-and-flatiron-health-expand-real-world-data-cancer-research-collaboration) [厂商-摘要] | 数据（不可补） |
| ConcertAI | 肿瘤 RWD | 未取得 | 未取得 | 未取得 [未核实] | 无法判断 |
| TriNetX | LIVE | PSM（两队列），NL 查询 | 3 亿+ 患者（186M 美国） | [综述：未独立验证](https://pmc.ncbi.nlm.nih.gov/articles/PMC12282508/) [独立]；[规模](https://en.prnasia.com/story/538259-0.shtml) [厂商-摘要] | 1:1 PSM；数据网络（不可补） |
| OHDSI | HADES，ATLAS | 大规模 PS，SCCS，SCC，PLP，经验校准，MethodEvaluation | 无集中数据；联邦网络 | [HADES](https://ohdsi.github.io/Hades/packages.html) [一手]；DARWIN EU [独立-摘要，弱] | SCCS，大规模 PS，PLP；方法评估集 |
| IQVIA，Komodo | 数据平台 | 未取得 | Komodo 330M+ 自述 | [Contrary](https://research.contrary.com/company/komodo-health) [厂商-摘要]；申报记录未找到 | 数据（不可补） |
| Tempus | TIME，Deep 6 | RAG + GPT-4o，打分排序，护士复核 | 750+ 站点，3,000 万患者（Deep 6） | [67% 对 13%](https://www.tempus.com/publications/impact-of-large-language-models-on-trial-to-patient-matching-efficiency/) [厂商-摘要] | 排序，RAG 取证；站点网络（业主排除） |
| Massive Bio | RNex | 三 agent 神经符号，知识图谱 | 17,000+ 确认匹配 | [F1 0.82，n=3,804](https://massivebio.com/massive-bio-publishes-landmark-prospective-study-demonstrating-ai-driven-clinical-trial-matching-at-scale-in-3804-cancer-patients/) [厂商-已读]；无独立 | 归一化知识图谱，真实世界语料 |
| Triomics | OncoLLM，PRISM | 肿瘤专用微调 LLM | 合作医院 EHR | [Mount Sinai 部署](https://www.mountsinai.org/about/newsroom/2026/mount-sinai-launches-ai-powered-clinical-trial-matching-platform-to-expand-access-to-cancer-research)；95% 自述 | 专用模型（无训练数据，且与只用 DeepSeek 的路线不同） |
| Mendel | Hypercube | LLM + hypergraph | 临床记录 | [ACR F1 62.9 对 20.8](https://www.clinicaltrialsarena.com/news/mendel-sees-positive-results-in-ai-cohort-matching-trial/) [厂商-摘要] | 队列检索（EviMed 面向单患者匹配） |
| Paradigm | 平台 | 持续比对，提前标记 | 健康系统 EHR | r1 §17.3 [前序] | 时间维度判断（date-window） |
| TrialX，Pi Health | 招募，试验运营 | 未取得 | 未取得 | 未取得 [未核实] | 无法判断 |
| 学术参照 | TrialGPT 2.0 | 排序，结构化解释 | NIH-TrialBench | [arXiv 2609.01202](https://arxiv.org/abs/2609.01202) [独立，已读摘要] | 排序和第二把评测尺 |
| 零氪，太美，医渡，水滴 | 招募和数据 | 未公开算法；“算法加人工复核” | 医渡自称约 90 亿记录 | [第一财经](https://www.yicai.com/news/102411456.html) [前序] | 运营和院内数据（不可补，业主排除） |
| QuantHealth | Katina | 未公开 | 自述每患者 1 万数据点 | [BW 2025](https://www.businesswire.com/news/home/20250722764714/en/QuantHealth-Successfully-Simulates-350-Clinical-Trials-with-90-Accuracy-Delivering-%2431.4M-in-Savings-for-a-Top-10-Pharma-Company) [厂商-摘要]，第三方验证未发表 | 不算可信缺口 |
| Insilico | inClinico | 多模态 AI（靶点和设计） | 未核实 | [CPT 论文报道](https://www.newswise.com/articles/7-yr-generative-ai-predicts-clinical-trial-outcomes) [厂商-摘要]，公司作者 | 不算可信缺口 |
| Formation Bio，Bioptimus | Muse，M-Optimus | 招募内容；多模态模型 | Bioptimus 与 FFCD 合作 | r1 §18 [前序]；[Tirto](https://tirto.id/bioptimus-unveils-m-optimus-a-world-model-for-biology-hn1z) [厂商-摘要] | 不相关或尚未验证 |
| Manus，Apodex | 通用 agent | 模型写码、沙箱执行 | 无 | [fast.io](https://fast.io/resources/manus-ai-vs-question-ai-research/) [低质量] | EviMed 在确定性引擎上更强 |
| Biomni，Kosmos，co-scientist | 科学 agent | 工具环境，world model | 公共库 | [Kosmos](https://arxiv.org/pdf/2511.02824) [厂商-摘要] | 不在试验统计赛道 |
| OpenAI，Anthropic | GPT-Rosalind，Claude for Life Sciences | connector 模式 | 经第三方 connector | [Medidata connector](https://claude.com/connectors/medidata) [厂商-摘要] | 模型层，不是对标对象 |
| Causaly，Elicit | 文献和抽取 | 未公开 | 文献库 | [Cochrane ESM 2025](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12462964/) [独立-摘要] | 非算法缺口；可借其评测设计 |

#### 算法可以补的缺口（按证据和成本排序）
下列排序是我的判断。licence 只列已确认的；未确认的写明。没有发现阻止商用的 licence，但多数包的 licence 本轮未抓到。

1. **自适应与多臂设计** — 再估计（CHW、CDL、Müller-Schäfer）、Promising Zone、inverse normal、MAMS、人群富集、count 终点。上游 [rpact](https://cran.r-project.org/package=rpact)（LGPL-3，已在 CI 库）。最窄适配是把它搬到运行时。`MAMS` 3.0.3 可作旁证（[CRAN](https://cran.r-project.org/package=MAMS)，licence 未抓到）。
2. **多重性** — Dunnett、Holm、Hochberg、Hommel、gatekeeping。多为闭式公式，`stats::p.adjust` 和已有的 `mvtnorm` 可覆盖一部分，gMCP 未评估。
3. **剂量递增** — 规则型 3+3、mTPI、mTPI-2、i3+3、BOIN 是决策表，可手写并对 `BOIN`（[CRAN](https://cran.r-project.org/package=BOIN)，GPL-2，最后发布 2021-01-19，较旧）交叉校验。CRM 和单药 BLRM 在低维可用数值积分，不需要运行时 Stan（推断，未实测）；双药组合更重。
4. **MCPMod** — 上游 [DoseFinding](https://cran.r-project.org/package=DoseFinding) 1.4-2（2026-10-16 发布，晚于 2026-09-28 的快照，须用快照内版本；licence 未抓到）。
5. **贝叶斯决策模拟** — 后验和预测概率决策、RAR、BAC，并把 `comparator.map_prior` 接到设计模拟（CDE 第 6 号和 FDA 贝叶斯草案都要算操作特性）。共轭情形可不用 MCMC；FACTS 的 NDLM 等模型在单作业四核限制下须实测耗时。
6. **平台试验、seamless、ordinal、crossover、精确二分类、多终点 utility** — 均可模拟实现，优先级看需求。FACTS 平台手册本身也有限制，不必追全。
7. **外部对照的基础操作** — 1:1 PSM（目前只有加权）、hdPS 或正则化 PS、QBA、SCCS、AIPW 生存版。`psBayesborrow`（[CRAN](https://cran.r-project.org/package=psBayesborrow)，MIT，2024-03-04）可参考 PS 加动态借用；HADES 的 CohortMethod 依赖 OMOP 数据库，是否适配未验证。
8. **匹配的排序层和时间判断** — 检索排序或重排（Tempus、TrialGPT 的指标）、date-window 条件（Paradigm 的“尚未合格”标记）、术语归一化（Massive Bio 的知识图谱，三个疾病包是起点）。评测增加 NIH-TrialBench。**不涉及招募流程。**
9. **报告格式** — Simcyp 式的 context of use 加偏倚加范围外清单，作为输出文本，不是门禁。
10. **方法自检** — MaxCombo 与 `simtrial` 或 `gsDesign2`（[CRAN](https://cran.r-project.org/package=gsDesign2) 1.2.0，2026-07-30）比对，属于已知缺口。

#### 算法补不了的缺口
1. **专有患者级数据。** Medidata 1,200 万（历史试验患者级数据）、TriNetX 3 亿、Komodo 3.3 亿、Datavant 网络、Tempus 3,000 万（Deep 6）、医渡。这是最持久的差距，也决定了 2 和 3。用户自带数据和公开汇总（包括 `evidence.reconstruct_km`）只能部分替代。
2. **在真实数据上训练并验证过的模型。** Unlearn 的孪生生成器、Simcyp 的 220 研究验证矩阵、jinkō 的校准模型。算法可以写，但没有训练和验证数据就只是空架子。运行时 CPU 限制是次要原因。
3. **监管记录。** PROCOVA、Simcyp、Medicenna、FDA 清单上的申报。这要靠申办方的真实申报累积，EviMed 也没有这个业务。
4. **机构网络和分发。** Tempus 750+ 站点、Medidata 的 EDC 位置、Cytel 和 Berry 的统计师客户、TriNetX 的医院网络。业主已排除招募和联系流程，to-C 也不走这条路。
5. **临床正确性背书。** 方法写得再对，也不等于临床判断正确。已知缺口“临床正确性未验证”需要人和真实案例，不是再加算法。

半可补：
- **QSP 或 PBPK** — ODE 求解可加（运行时需新增依赖，未核实），但疾病模型、生理参数和校准是资产。可以先走“用户提供模型，引擎求解”，与 `model.prognostic_apply` 同形。
- **结局预测** — 用公开注册数据能做基线模型，但 Phase 2 上区分度有限，且业主有“模型不做统计”的规则约束其用法，不建议作为产品主张。
- **平台级知识** — 三个疾病包可以扩展，但没有经验证的预后模型，属于长期积累。

### Inferences
- **长期缺口排序**：专有数据 > 验证模型 > 监管记录 > 分发 > 算法。算法是唯一可以短期移动的项，但它也是竞品最不靠它吃饭的项。East、rpact、FACTS 卖的是验证和习惯，方法本身大多是公开文献。
- **对 EviMed 的含义**：补方法能把“能回答的设计问题”扩大很多，而且成本低、风险可控，尤其第 1、3、4 项。但它不会让 EviMed 变成 Medidata 或 Unlearn，也不应该以这个口径对外。
- **可能的差异点**（推断，无用户研究支持）：竞品表中，能让个人在对话中得到确定性、可复现、带 MCSE 的设计或对照计算的产品几乎没有。商业产品要么面向统计师（East、FACTS），要么是服务型（SCA、Unlearn），要么是不跑确定性引擎的通用 agent（Manus）。最接近的是 Nova 的 headless jinkō，但它是机理模型路线。
- **先修底座**：已知问题“普通请求绕开模块”若不解决，新加的方法用户也用不到，这比表中任何单项都重要。
- **不要追的项**：QuantHealth 式准确率宣称、Simulants 式 "regulatory-grade" 形容词、把合成对照说成已被接受。证据都不支撑。

### Gaps
- 上述 R 包是否真能装进 2026-09-28 快照并在单作业限制下跑完，未实测。crmPack、simtrial、Cyclops 的 CRAN 页本轮未取到结果，不能据此判断它们是否在 CRAN 上；多数包的 licence 也未抓到。
- 无价格信息；r1 已记录几乎所有厂商不公开价格。
- 没有用户研究说明 to-C 用户是否需要 MAMS 或 BLRM 这类方法。按需求排序还需要真实使用数据。
- 表中“缺什么”基于方法清单，不是代码审计，与其他调研员的发现可能有重叠。
