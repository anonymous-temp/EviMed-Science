## 16. 附件与主要出处

**附件**（`2026-09-28-virtual-clinical-research-assets/`）

| 文件 | 内容 |
|---|---|
| `research/A1-海外虚拟队列与数字孪生与合成对照产品.md` | Unlearn、Medidata、Phesi、Nova、Certara、Flatiron、TriNetX、ATLAS、MDClone、Synthea 等 |
| `research/A2-海外试验设计仿真与匹配招募产品.md` | Cytel、Berry FACTS、Faro、Citeline、TrialGPT、Tempus、Paradigm、Antidote 等 |
| `research/B-国内同类产品与生态.md` | 医渡、零氪、森亿、太美、SMO 与招募平台、医药魔方、CDE 登记平台、国内买家与价格 |
| `research/C1-方法学-对照设计仿真与招募.md` | 目标试验模拟、外部对照、文献对照、贝叶斯借用、PROCOVA、ADEMP、入组预测，数值验收用例 N01～N21 |
| `research/C2-方法学-虚拟患者合成数据与AI.md` | 合成数据与评估、机制模型接口、数字孪生、LLM 匹配、数据标准，验收用例 C2-01～C2-26 |
| `research/D-监管科学与方法学指导原则.md` | ICH、FDA、EMA、CDE 的现行文件与先例案例，模型可信度分级 |
| `research/E-现有代码盘点.md` | 可复用的代码、缺口与按层落点（带文件与行号） |
| `mockups/` | 效果图 HTML 源文件与渲染规格（`SPEC.md`，`node render.cjs` 重新渲染） |
| `source/v1.0-original-en.md` | 你的 v1.0 英文原稿 |

**主要出处**（完整列表见各附件）

监管与方法学文件：
1. ICH M15 Step 4（2026-01-29）：https://www.ich.org/news/harmonised-ich-m15-guideline-general-principles-model-informed-drug-development-adopted
2. ICH E9(R1)：https://database.ich.org/sites/default/files/E9-R1_Step4_Guideline_2019_1203.pdf
3. ICH M11 Step 4 模板（2025-11-19）：https://database.ich.org/sites/default/files/ICH_Step4_M11_Final_Template_2025_1119.pdf
4. FDA 外部对照试验指导原则（草案）：https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-design-and-conduct-externally-controlled-trials-drug-and-biological-products
5. FDA AI 支持监管决策（草案，2025-01）：https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological
6. FDA 贝叶斯方法指导原则（草案，2026-01）：https://www.federalregister.gov/documents/2026/01/12/2026-00325/use-of-bayesian-methodology-in-clinical-trials-of-drug-and-biological-products-draft-guidance-for
7. FDA 复杂创新试验设计：https://www.fda.gov/regulatory-information/search-fda-guidance-documents/interacting-fda-complex-innovative-trial-designs-drugs-and-biological-products
8. EMA PROCOVA 资格意见（2022）：https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf
9. CDE《药物临床试验中应用贝叶斯外部信息借用方法的指导原则（试行）》（2026）：https://cs.cnpharm.com/c/2026-01-21/1089278.shtml
10. FDA 依氟鸟氨酸批准综述（外部对照先例）：https://pmc.ncbi.nlm.nih.gov/articles/PMC11365752/

方法学文献：
11. Hernán & Robins, Am J Epidemiol 2016（目标试验模拟）：doi:10.1093/aje/kwv254
12. Wang 等, JAMA 2023（RCT-DUPLICATE）：doi:10.1001/jama.2023.4221
13. Liu 等, Nature 2021（Trial Pathfinder）：doi:10.1038/s41586-021-03430-5
14. Guyot 等, BMC Med Res Methodol 2012（KM 重建）：doi:10.1186/1471-2288-12-9
15. Schmidli 等, Biometrics 2014（稳健 MAP 先验）：doi:10.1111/biom.12242
16. Kopp-Schneider 等, Biom J 2020（借用与 I 类错误）：doi:10.1002/bimj.201800395
17. Schuler 等, Int J Biostat 2022（PROCOVA）：doi:10.1515/ijb-2021-0072
18. Morris, White & Crowther, Stat Med 2019（ADEMP）：doi:10.1002/sim.8086
19. O'Hagan 等, Pharm Stat 2005（assurance）：doi:10.1002/pst.175
20. Anisimov & Fedorov, Stat Med 2007（Poisson–Gamma 入组）：doi:10.1002/sim.2956
21. Nowok 等, J Stat Softw 2016（synthpop）：doi:10.18637/jss.v074.i11
22. Stadler 等, USENIX Security 2022（合成数据不等于匿名）：arXiv:2011.07018
23. 美国国家科学院, Foundational Research Gaps and Future Directions for Digital Twins（2023）：doi:10.17226/26894
24. Jin 等, Nat Commun 2024（TrialGPT）：https://www.nature.com/articles/s41467-024-53081-z
25. CBLUE（含 CHIP-CTC）：arXiv:2106.08087

产品与市场：
26. Unlearn 数字孪生生成器目录：https://www.unlearn.ai/digital-twin-generators ；TrialPioneer（2026-01-28）：https://www.newswire.com/news/unlearn-introduces-trialpioneer-an-ai-powered-workspace-to-strengthen-upstream
27. Cytel East Horizon：https://cytel.com/east-horizon/ ；Enforesys：https://cytel.com/solutions/trial-implementation-software/enforesys/
28. OHDSI（ATLAS 与 Book of OHDSI）：https://ohdsi.github.io/TheBookOfOhdsi/
29. Chen 等, BMC Med Inform Decis Mak 2019（Synthea 质量指标）：https://pmc.ncbi.nlm.nih.gov/articles/PMC6416981/
30. 第一财经（2026-09-28，齐鲁医院"数字孪生虚拟临床试验体系"采购）：https://finance.sina.com.cn/jjxw/2026-09-28/doc-initiwim9689170.shtml
31. 虎嗅（2025-03-26，国内患者招募的单位经济）：https://www.huxiu.com/article/4163794.html
32. ClinicalTrials.gov API v2：https://clinicaltrials.gov/data-api/api
