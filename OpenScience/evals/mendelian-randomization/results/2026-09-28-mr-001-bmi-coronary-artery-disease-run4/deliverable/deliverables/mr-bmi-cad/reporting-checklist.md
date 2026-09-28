# STROBE-MR — checklist for reporting a Mendelian randomisation study

Skrivankova VW, Richmond RC, Woolf BAR, et al. Strengthening the reporting of observational studies in epidemiology using mendelian randomization: the STROBE-MR statement. JAMA 2021;326(16):1614-1621. https://doi.org/10.1001/jama.2021.18236

Items and wording as published in the checklist of the explanation and elaboration (Skrivankova VW, et al. BMJ 2021;375:n2233, table 3; PMC8546498, CC BY 4.0), read on 2026-09-24. An item with lettered parts is one row per part; items 4 and 6 also keep their own opening sentence as a row.

「报告位置」一栏指向 mendelian-randomization-report.md 中读者可以打开的标题；本次分析产出的文件在此处只用文件名，不加目录前缀。报告未覆盖的条目写明原因及其后果。

| Section/topic | Item | Checklist item | 报告位置 |
| --- | --- | --- | --- |
| Title and abstract | 1 | Indicate mendelian randomisation (MR) as the study’s design in the title and/or the abstract if that is a main purpose of the study | 报告标题「体重指数与冠状动脉疾病的两样本孟德尔随机化研究」；摘要首行「研究设计：孟德尔随机化（Mendelian randomization，MR）」 |
| Introduction — Background | 2 | Explain the scientific background and rationale for the reported study. What is the exposure? Is a potential causal association between exposure and outcome plausible? Justify why MR is a helpful method to address the study question | 1 背景与目的 |
| Introduction — Objectives | 3 | State specific objectives clearly, including prespecified causal hypotheses (if any). State that MR is a method that, under specific assumptions, intends to estimate causal effects | 1 背景与目的末段；摘要「背景与目的」 |
| Methods — Study design and data sources | 4 | Present key elements of the study design early in the article. Consider including a table listing sources of data for all phases of the study. For each data source contributing to the analysis, describe the following: | 2.1 研究设计与数据来源；两侧数据来源的表格见 5 其他信息「数据与代码的可获取性」与摘要「数据来源」 |
| Methods — Study design and data sources | 4a | Setting: Describe the study design and the underlying population, if possible. Describe the setting, locations, and relevant dates, including periods of recruitment, exposure, follow-up, and data collection, when available. | 2.1.1 研究设计；2.1.2 参与者与研究人群。原始研究的招募时间、地点与随访期未随汇总统计量文件提供，报告在 2.1.2 末段写明该缺口，因此设置与时间维度无法描述，读者不能据此判断暴露与结局的时间顺序 |
| Methods — Study design and data sources | 4b | Participants: Give the eligibility criteria, and the sources and methods of selection of participants. Report the sample size, and whether any power or sample size calculations were carried out prior to the main analysis | 2.1.2 参与者与研究人群（血统构成与初始样本量）；2.1.2 末段与 2.1.1 末句（纳入排除标准见原文、未做事前样本量与效能计算） |
| Methods — Study design and data sources | 4c | Describe measurement, quality control, and selection of genetic variants | 2.1.3 遗传变异的测量、质量控制与选择；2.3.2 工具变量的处理；各阶段计数见 3.1 第 1 条 |
| Methods — Study design and data sources | 4d | For each exposure, outcome, and other relevant variables, describe methods of assessment and diagnostic criteria for diseases | 2.1.4 暴露、结局与协变量的评估 |
| Methods — Study design and data sources | 4e | Provide details of ethics committee approval and participant informed consent, if relevant | 2.1.5 伦理（本次分析不使用个体层面数据，未申请新的审批；原始研究的审批与知情同意见各原文，报告未逐项核对，因此不能据本报告确认原始研究的伦理合规细节） |
| Methods — Assumptions | 5 | Explicitly state the three core instrumental variable assumptions for the main analysis (relevance, independence, and exclusion restriction), as well assumptions for any additional or sensitivity analysis | 2.2 工具变量的三个核心假设；各替代估计量各自的附加假设见 2.3.3 主分析与估计量 |
| Methods — Statistical methods: main analysis | 6 | Describe statistical methods and statistics used | 2.3 统计方法 |
| Methods — Statistical methods: main analysis | 6a | Describe how quantitative variables were handled in the analyses (that is, scale, units, model) | 2.3.1 效应量与量纲（含暴露效应量量纲未在来源文件中说明这一限定） |
| Methods — Statistical methods: main analysis | 6b | Describe how genetic variants were handled in the analyses and, if applicable, how their weights were selected | 2.3.2 工具变量的处理；3.1 第 1 条（选择与协调的逐步计数） |
| Methods — Statistical methods: main analysis | 6c | Describe the MR estimator (eg, two stage least squares, Wald ratio) and related statistics. Detail the included covariates and, in the case of two sample MR, whether the same covariate set was used for adjustment in the two samples | 2.3.3 主分析与估计量；两侧协变量集合的核对见 2.1.4 末句（无法核对，该缺口在 4.2 未单列，但在 4.2 第 4 条的血统不一致限制中一并影响可比性判断） |
| Methods — Statistical methods: main analysis | 6d | Explain how missing data were addressed | 2.3.4 缺失数据；3.1 第 1 条 |
| Methods — Statistical methods: main analysis | 6e | If applicable, indicate how multiple testing was addressed | 2.3.5 多重比较 |
| Methods — Assessment of assumptions | 7 | Describe any methods or prior knowledge used to assess the assumptions or justify their validity | 2.4 假设的评估方法；2.2 工具变量的三个核心假设 |
| Methods — Sensitivity analyses and additional analyses | 8 | Describe any sensitivity analyses or additional analyses performed (eg, comparison of effect estimates from different approaches, independent replication, bias analytic techniques, validation of instruments, simulations) | 2.5 敏感性分析与补充分析 |
| Methods — Software and pre-registration | 9a | Name statistical software and package(s), including version and settings used | 2.6 软件与预注册（第一段） |
| Methods — Software and pre-registration | 9b | State whether the study protocol and details were pre-registered (as well as when and where) | 2.6 软件与预注册（第二段：未在任何平台预注册，并写明其后果——读者无法依据预注册核查分析集与估计量的选择是否早于结果产生） |
| Results — Descriptive data | 10a | Report the numbers of individuals at each stage of included studies and reasons for exclusion. Consider use of a flow diagram | 3.1 第 1 条（逐阶段计数与每一步的排除原因）。本次分析没有个体招募流程，故未绘流程图；两侧数据的初始样本量见 2.1.2 |
| Results — Descriptive data | 10b | Report summary statistics for phenotypic exposure(s), outcome(s), and other relevant variables (eg, means, SDs, proportions) | 未报告：汇总统计量文件不提供暴露与结局的均值、标准差或病例对照比例，本次分析也无法从汇总数据反推。后果：读者无法判断工具变量所解释的暴露变异幅度与结局的基线风险水平，效应估计因而缺少表型层面的参照 |
| Results — Descriptive data | 10c | If the data sources include meta-analyses of previous studies, provide the assessments of heterogeneity across these studies | 未报告：结局数据集为多血统 meta 分析，其纳入研究之间的异质性评估未随协调后的汇总统计量文件提供。后果：报告 3.3 第 2 条给出的 Q 统计量是跨工具变量的异质性，3.1 第 3 条已就此说明它不能被读作跨研究异质性，因此无法据此评价结局数据本身的合并是否合理 |
| Results — Descriptive data | 10d | For two sample MR: i. Provide justification of the similarity of the genetic variant-exposure associations between the exposure and outcome samples ii. Provide information on the number of individuals who overlap between the exposure and outcome studies | i. 3.1 第 4 条：无法直接核对（结局数据集不提供这些变异与 BMI 的关联），仅能以两侧血统构成为间接支持；后果见 4.2 第 4 条。ii. 3.1 第 5 条：重叠人数无法判定，报告列出两侧来源研究的规模与联盟，但不主张样本独立；该缺口列为 4.2 第 5 条限制 |
| Results — Main results | 11a | Report the associations between genetic variant and exposure, and between genetic variant and outcome, preferably on an interpretable scale | 3.2 第 1 条（暴露侧逐变异的 F 统计量与 beta 区间列于 f_statistics.csv）。结局侧逐变异关联未以表格产出，报告写明该缺口，读者只能从散点图目视判断 |
| Results — Main results | 11b | Report MR estimates of the association between exposure and outcome, and the measures of uncertainty from the MR analysis, on an interpretable scale, such as odds ratio or relative risk per SD difference | 3.2 第 2 条与表 1；估计量的可解释尺度受 2.3.1 所述量纲限定约束 |
| Results — Main results | 11c | If relevant, consider translating estimates of relative risk into absolute risk for a meaningful time period | 3.2 第 3 条：未做。两侧数据集不提供基线风险、发病密度或随访时长，无法换算绝对风险差。后果：本报告不能用于任何绝对风险层面的判断或决策 |
| Results — Main results | 11d | Consider plots to visualise results (eg, forest plot, scatterplot of associations between genetic variants and outcome v between genetic variants and exposure) | 3.2 第 4 条（散点图、森林图、漏斗图、留一法图） |
| Results — Assessment of assumptions | 12a | Report the assessment of the validity of the assumptions | 3.3 工具变量假设的评估结果（相关性、独立性、定向多效性、水平多效性与离群点、因果方向五项） |
| Results — Assessment of assumptions | 12b | Report any additional statistics (eg, assessments of heterogeneity across genetic variants, such as I², Q statistic, or E value) | 3.3 第 2 条（Cochran's Q，含 IVW 与 MR-Egger 两个模型）；I² 未计算见 2.4；E 值未计算见 4.2 第 9 条 |
| Results — Sensitivity analyses and additional analyses | 13a | Report any sensitivity analyses to assess the robustness of the main results to violations of the assumptions | 3.4 第 1 条 |
| Results — Sensitivity analyses and additional analyses | 13b | Report results from other sensitivity analyses or additional analyses | 3.3 第 4 条（MR-PRESSO、RadialMR、污染混合模型）；3.4 第 2 条（剔除离群变异后的校正估计未产出，报告写明该缺口及其后果） |
| Results — Sensitivity analyses and additional analyses | 13c | Report any assessment of direction of causal association (eg, bidirectional MR) | 3.3 第 5 条（方向性检验未产出结果）；3.4 第 3 条（本次为单向分析，未请求反向 MR） |
| Results — Sensitivity analyses and additional analyses | 13d | When relevant, report and compare with estimates from non-MR analyses | 3.4 第 4 条：报告写明本分析未纳入观察性研究的效应量做定量比较。后果：无法判断本次估计与观察性关联在数量级上的差异；4.3「与既往研究的关系」给出可据以对照的已发表 MR 研究入口，但不含该研究的效应量数值 |
| Results — Sensitivity analyses and additional analyses | 13e | Consider additional plots to visualise results (eg, leave-one-out analyses) | 3.2 第 4 条；3.4 第 5 条（留一法图已产出，未产出数值表，报告因此不陈述剔除单变异后的效应范围） |
| Discussion — Key results | 14 | Summarise key results with reference to study objectives | 4.1 主要结果；6 结论 |
| Discussion — Limitations | 15 | Discuss limitations of the study, taking into account the validity of the instrumental variable assumptions, other sources of potential bias, and imprecision. Discuss both direction and magnitude of any potential bias and any efforts to address them | 4.2 局限性（10 条，逐条给出偏倚方向及其是否已被处理） |
| Discussion — Interpretation | 16a | Meaning: Give a cautious overall interpretation of results in the context of their limitations and in comparison with other studies | 4.3 解释「与既往研究的关系」；置信度表述见 4.1 |
| Discussion — Interpretation | 16b | Mechanism: Discuss underlying biological mechanisms that could drive a potential causal association between the investigated exposure and the outcome, and whether the gene-environment equivalence assumption is reasonable. Use causal language carefully, clarifying that instrumental variable estimates may provide causal effects only under certain assumptions | 4.3 解释「可能的机制」 |
| Discussion — Interpretation | 16c | Clinical relevance: Discuss whether the results have clinical or public policy relevance, and to what extent they inform effect sizes of possible interventions | 4.3 解释「临床与公共卫生含义」 |
| Discussion — Generalisability | 17 | Discuss the generalisability of the study results (a) to other populations, (b) across other exposure periods/timings, and (c) across other levels of exposure | 4.4 外推性（(a)(b)(c) 三项分别对应人群、暴露时点与暴露水平） |
| Other information — Funding | 18 | Describe sources of funding and the role of funders in the present study and, if applicable, sources of funding for the databases and original study or studies on which the present study is based | 5 其他信息「资金来源」。本次分析未登记资金来源，因此无法说明资助方在研究设计、分析与报告中是否有角色；数据库与原始研究的资金来源见其各自原文与 GWAS Catalog 记录 |
| Other information — Data and data sharing | 19 | Provide the data used to perform all analyses or report where and how the data can be accessed, and reference these sources in the article. Provide the statistical code needed to reproduce the results in the article, or report whether the code is publicly accessible and if so, where | 5 其他信息「数据与代码的可获取性」（含两侧数据集登录号、使用文件地址、文件大小与 SHA-256 校验值，以及统计代码的公开可及性说明）；交付目录另含本次分析的输入文件与分析结果文件，清单与校验值见 mendelian-randomization-run.json |
| Other information — Conflicts of interest | 20 | All authors should declare all potential conflicts of interest | 5 其他信息「利益冲突」：本次分析由自动化分析流程完成，未登记利益冲突声明，因此本条目以「未报告」处理，读者不应把该处读作已声明无利益冲突 |

---

## 验收项对照

验收项取自本次运行的计划。下表逐条给出读者可在交付文件中打开的位置。

| 验收项 | 读者可打开的位置 |
| --- | --- |
| 研究问题与 PICO：暴露为 BMI、结局为 CAD、人群为两侧 GWAS 所代表的成人、工具变量来自 GWAS 汇总统计量、方向为单向 | mendelian-randomization-report.md 摘要「背景与目的」；1 背景与目的；2.1.1 研究设计 |
| 两个数据来源的确切标识、人群构成与血统构成，以及与题面「欧洲人群」表述的差异 | mendelian-randomization-report.md 摘要「数据来源」；2.1.2 参与者与研究人群（含差异段）；5 其他信息的数据集表；mendelian-randomization-run.json 的 engineResults 中两份来源记录 |
| 工具变量选择方法与各阶段计数，与运行产物一致 | mendelian-randomization-report.md 2.3.2、3.1 第 1 条、4.2 第 1 条；analysis-data/1-GCST002783-GCST003116/instrument-selection.json；analysis-data/1-GCST002783-GCST003116/harmonisation.json |
| 主分析与全部敏感性分析的估计，以及未产出分析的标注 | mendelian-randomization-report.md 表 1、3.3 第 5 条、3.4 第 2 与第 3 条、3.4 第 5 条；analysis-data/1-GCST002783-GCST003116/mr_results.csv；analysis-data/1-GCST002783-GCST003116/conmix.csv |
| 三个核心假设的逐条评估与相应诊断统计量 | mendelian-randomization-report.md 2.2、3.3；analysis-data/1-GCST002783-GCST003116/heterogeneity.csv、pleiotropy.csv、mrpresso.csv、radial.csv、f_statistics.csv |
| 正文数值与运行产物一致 | mendelian-randomization-report.md 表 1 与 3.1–3.4 各数值，逐项对照 analysis-data/1-GCST002783-GCST003116/ 下的 mr_results.csv、heterogeneity.csv、pleiotropy.csv、mrpresso.csv、radial.csv、conmix.csv、f_statistics.csv 与 mendelian-randomization-run.json |
| 限制一节覆盖 LD 未测量、样本重叠不可判定、效应量量纲未说明、结局为多血统 meta 分析、无绝对风险换算、无与观察性研究的定量比较 | mendelian-randomization-report.md 4.2（第 1、3、4、5、9 条）；3.2 第 3 条；3.4 第 4 条 |
| STROBE-MR 对齐的讨论与逐条填写报告位置的清单 | mendelian-randomization-report.md 全文各节；reporting-checklist.md 本文件 |
| 验收项对照表 | mendelian-randomization-report.md 7 验收项对照；本文件本节 |
| 交付目录的完整文件集 | mendelian-randomization-run.json 的 deliveredArtefacts（逐文件字节数与 SHA-256）；mendelian-randomization-inputs.json；mendelian-randomization-open-sources.json |
