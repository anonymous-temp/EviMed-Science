# 回顾性约束下本院 TDM 数据集与公开数据库、文献数据库结合的研究方向分析报告

## 摘要

在"只做回顾性研究、本院数据不再新增任何字段"的约束下，这份小样本精神专科住院患者治疗药物监测（TDM）数据集的增量研究价值不来自"再补什么检验"，而来自把现有字段（药名、剂量、频次、血药浓度、代谢物、诊断、日期）映射到外部公开资源上。本报告逐类给出连接键、连接粒度、可行统计方法与发表定位，并明确哪些方向接上外部数据也仍然做不了；全部增量均来自外部公开资源，不依赖本院新增任何字段。

本院检验表同时报告母药、脱氢代谢物与活性部分浓度，而文献综述显示脱氢阿立哌唑约为母药稳态浓度的 40%（CYP2D6 依赖），使代谢物比值成为无基因型条件下唯一可用的"表型指纹"字段。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-007 -->

结论一（最可行）：做"外部基准对照"。本院浓度、剂量归一化浓度（C/D）与代谢物比值，对照挪威大型 TDM 登记库的人群分布——其"低/正常剂量校正浓度"按该药人群 C/D 的第 25/75 百分位界定，是可直接复用的方法学模板。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-002 -->

对照标尺为 AGNP 共识参考范围（阿立哌唑 100 至 350、活性部分 150 至 500 ng/mL，与本院检验参考范围逐项吻合），并按档位（低于下限/范围内/高于上限/高于警戒）报告本院比例与个例。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-012 -->[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-023 -->

结论二：以 FAERS/OpenFDA 不成比例分析信号、药物相互作用知识与本院医嘱合并用药做"安全性三角互证"，可生成个案级假设（如 P2 氯氮平 721 ng/mL 超 350–600 参考范围上限），但证据层级止于描述性与假设生成，超限归因保持开放。[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-031 -->[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-026 -->〔推导〕 <!-- claim:CLM-104 -->

FAERS 不成比例分析显示阿立哌唑与帕金森样事件显著关联（ROR 7.43，95%CI 7.06–7.81），可与本院锥体外系相关诊断做平行对照，但信号仅提示统计关联而非因果。[9](https://europepmc.org/articles/PMC11739097) <!-- claim:CLM-029 -->

结论三：药物基因组学方向只能做"间接表型推断"。CPIC（2009 年由 PGRN 与 PharmGKB 共建）与 DPWG 提供表型-剂量注释体系，但本院无基因型字段，比值-表型联系仅能用于假设生成，不能做基因型-浓度关联。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-009 -->

结论四：即便接上全部外部资源，以下仍不可行——个体药代动力学参数估计（无采血时刻、无多点采样）、暴露-疗效关联（无量表评分）、基因型-浓度关联（无基因型）、前瞻验证（约束禁止），以及任何"以本院即总体"的推断（n=5）。〔推导〕 <!-- claim:CLM-108 -->

结论五（发表定位）：外部资源支撑的最高发表形态为论著级"小样本 TDM 描述性分析+外部基准对照"、短篇/letter（单药浓度谱与文献对照）、质量改进报告（检验-医嘱-诊断联动核查）与病例系列（多药合并下的浓度异常归因），不适合声称系统评价或 meta 分析。

## 临床问题与论点（判定条件）

### 研究问题

给定唯一输入（工作区数据集，5 例、5 张工作表：病案首页、医嘱记录、检验、诊断记录、体征）与 3 项硬约束（仅回顾性；本院不再新增基因型、量表、采血/给药时刻、化验等任何字段；一切增量必须来自外部公开资源），可开展哪些有发表价值的研究方向？每个方向的外部资源接法（连接键、粒度）、统计方法、偏倚与发表定位是什么？〔推导〕 <!-- claim:CLM-108 -->

### 数据集本体（事实底座，供后续推导使用）

数据集覆盖 2020-11 至 2021-03 的 5 例精神科住院患者（化名 P1–P5，按数据文件行序稳定编号，正文不出现任何住院号/病案号）：〔推导〕 <!-- claim:CLM-108 -->

- P1：女，56 岁，精神分裂症后抑郁，合并迟发性运动障碍、肝功能不全、高泌乳素血症、慢性乙肝；住院 49 天；阿立哌唑口崩片 10 mg bid。2 次 TDM：总阿立哌唑 372、503 ng/mL（母药 317、400；脱氢 55、103）。〔推导〕 <!-- claim:CLM-108 -->
- P2：女，29 岁，双相情感障碍（轻躁狂）；氯氮平 400 mg/d、帕利哌酮 12 mg/d、氯硝西泮 2 mg qn、碳酸锂 0.6–0.9 g/d。1 次 TDM：氯氮平 721、氯硝西泮 46.6、帕利哌酮 86.4 ng/mL；另测阿立哌唑 63 ng/mL（本住院期间无阿立哌唑医嘱）。〔推导〕 <!-- claim:CLM-108 -->
- P3：女，23 岁，可疑精神和行为障碍观察（中医诊断：郁病/癫病）；阿立哌唑 15 mg/d（后 10 mg/d）、碳酸锂 0.3 g bid。TDM：总阿立哌唑 433（母药 354、脱氢 79）。〔推导〕 <!-- claim:CLM-108 -->
- P4：男，21 岁，未分化型精神分裂症，合并肌张力障碍；阿立哌唑 10 mg/d（后换安律凡 15 mg/d）、奥氮平 10 mg bid。TDM：奥氮平 54.2、阿立哌唑 79.9、脱氢 27.4、总 107 ng/mL。〔推导〕 <!-- claim:CLM-108 -->
- P5：女，26 岁，双相障碍重度抑郁伴精神病性症状，合并低钾血症；阿立哌唑 10 mg/d、碳酸锂 0.3 g/d、喹硫平 25 mg。TDM：阿立哌唑 100、脱氢 26.6、总 127 ng/mL。〔推导〕 <!-- claim:CLM-108 -->

本院检验参考范围（检验表 REFFR_SCOPE 字段）为：阿立哌唑 100–350、总阿立哌唑 150–500、奥氮平 20–80、氯氮平 350–600、氯硝西泮 4–80、帕利哌酮 20–60 ng/mL。数据缺失清单：无基因型、无量表评分、无采血时刻（仅申请/检测日期）、无吸烟史、无炎症指标、无肝肾功能实测值（P1 有"肝功能不全"诊断词条）、体重仅入院时 6 次记录、测定方法（LC-MS/MS 或免疫法）未记录。〔推导〕 <!-- claim:CLM-108 -->

### 论点

外部资源能补的增量 = 外部"参考分布/参考值/表型-剂量注释/信号" × 本院"浓度、剂量、代谢物比值"中已存在的量。因此增量大小由三组判定条件决定：

- 条件 A（连接键可解析）：本院 DRUG_NAME（中文商品名，如阿立哌唑口崩片（国产）、安律凡、芮达、*氯氮平片）能解析到成分级标识（RxNorm RXCUI、ATC、成分名），进而映射到说明书、PharmGKB/CPIC/DPWG 注释、FAERS 信号与文献；若解析失败（如中药汤剂复方），该药退出一切外部连接。RxNorm 体系存在性已经公开接口检索确认。[21](https://rxnav.nlm.nih.gov/)（结构化记录）
- 条件 B（浓度可比性）：本院浓度测定方法必须与外部参考分布的方法学对等或在报告中进行方法偏倚声明；免疫法对活性部分存在系统偏高（斜率约 1.12）且 15% 病例可致不同临床决策。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-014 -->[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-041 -->
- 条件 C（人群可移植性）：文献汇总统计的人群（种族、吸烟、合并用药、采血时机）需与本院可比；东亚 CYP2D6 表型分布与欧美差异显著，直接套用欧美 C/D 参考值存在系统性偏倚。

任一条件不成立，该方向降级为"描述性报告"而非"对照分析"。本报告后续各角度均按此三条件检验。

## 证据基础与检索方法

### 检索方法

检索于 2026-08-05 执行，覆盖多类来源：文献索引（PubMed、Europe PMC）、指南与共识文献、结构化药物与安全数据库（DailyMed、RxNorm、临床试验注册库、NMPA 说明书索引）、开放获取全文。检索式共 17 条（含中文式；完整清单与命中数见检索日志 clinical-evidence-search.json），共识别 286 条题录，去重后 269 条，经标题-题录筛选后纳入 8 篇开放获取全文作为可引用证据文献。关键检索式包括："AGNP consensus guidelines therapeutic drug monitoring neuropsychopharmacology"、"aripiprazole dehydro-aripiprazole metabolic ratio CYP2D6"、"clozapine olanzapine concentration dose ratio therapeutic drug monitoring"、"抗精神病药物 治疗药物监测 专家共识"、europe-pmc "aripiprazole CYP2D6 therapeutic drug monitoring"、europe-pmc "clozapine concentration dose ratio smoking therapeutic drug monitoring"、europe-pmc "CPIC guideline aripiprazole CYP2D6 dosing"、europe-pmc "OpenFDA FAERS antipsychotic adverse event reporting" 等。

纳入 8 篇开放获取全文：Lenk 2024（挪威 TDM 登记库 C/D 百分位方法学）[3]、Soria-Chacartegui 2021（奥氮平/阿立哌唑/利培酮药物基因组学综述）[4]、Toja-Camba 2024（阿立哌唑两种测定方法比对）[5]、Yin 2023（中国 TDM 现状调查）[6]、Tveit 2020（挪威抗抑郁药十年 TDM 比较）[7]、Moschny 2021（吸烟与炎症对二代/三代抗精神病药 PK 影响）[8]、Wang 2024（FAERS 帕金森样事件真实世界研究）[9]、Zhu 2022（中国精神专科医院回顾性机器学习+开放数据药物警戒）[10]。

### 证据可及性说明

- AGNP 2017 共识与 ASCP-AGNP 2020 联合共识的全文不开放获取；本报告关于其参考范围与活性部分定义的引文均取自引用该共识的开放获取文献，并已逐条核对（转引情况见引文审计文件）。[2](https://pubmed.ncbi.nlm.nih.gov/28910830/)（题录级）[11](https://pubmed.ncbi.nlm.nih.gov/32433836/)（题录级）
- PharmGKB 与 SIDER 的结构化数据本轮无法公开核验；本报告不引用其原始内容，仅依据开放获取综述对其功能的记载作描述。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-009 -->
- 中文精神科 TDM 共识原文未检索到开放获取版本；其存在性依据 Yin 2023 正文对《治疗药物监测结果解读专家共识》的引用确认。[6](https://europepmc.org/articles/PMC10013164) <!-- claim:CLM-018 -->
- 单药文献（Suzuki 2011、Jukic 2019、Zhang 2019、Molden 2006、SPC 研究等）仅取得题录与摘要，正文中凡涉及其具体数值处均标注"题录级证据"或转以已保存综述表述，未将其数值作为受支持声明使用。

## 逐角度论证与结果

### 角度一：文献与指南（PubMed/Europe PMC、系统评价、AGNP 及中国共识）——解释框架层

**能做什么**：提供本院数据缺失的解释框架与标尺。其一，治疗参考范围与实验室警戒水平（AGNP 体系）：阿立哌唑 100 至 350、活性部分 150 至 500 ng/mL；奥氮平 20–80、警戒 100；氯氮平 350–600；这些范围与本院检验参考范围逐项吻合，说明本院参考范围源于 AGNP 体系，可直接作为对照标尺。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-012 -->[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-032 -->[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-026 -->其二，亚治疗下限的公认定义（阿立哌唑活性部分 150 µg/L、奥氮平 20 µg/L）。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-003 -->其三，活性部分（母药+活性代谢物）定义：参考范围针对的是活性部分而非单个化合物。[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-042 -->其四，中国 TDM 现状背景：早年调查显示中国精神专科 TDM 以锂盐、氯氮平为主且当时"急需中文 TDM 指南"（题录级）；近年调查显示精神药物监测范围在机构间不一致——本院数据可作为中国背景下的一则描述性样本。[13](https://pubmed.ncbi.nlm.nih.gov/24263641/)（题录级）[6](https://europepmc.org/articles/PMC10013164) <!-- claim:CLM-016 -->其五，中国 TDM 常用项目以万古霉素、丙戊酸、甲氨蝶呤、卡马西平、环孢素、伏立康唑为主，抗精神病药尚未进入主流监测清单。[6](https://europepmc.org/articles/PMC10013164) <!-- claim:CLM-017 -->其六，国家临床检验中心已启动覆盖 33 种药物的精神药物/抗抑郁药外部质量评估计划，为跨机构浓度可比性提供了质量基础设施。[6](https://europepmc.org/articles/PMC10013164) <!-- claim:CLM-019 -->

**接法与粒度**：连接键为成分名与 ATC（阿立哌唑 N05AX12 等）→ PubMed/Europe PMC 检索式；粒度为药物级（每药一份参考范围/共识条款）与人群级（每篇队列的汇总统计）。文献全文通过 DOI/PMCID 拉取（Europe PMC JATS）。

**统计/比对方法**：把本院每个浓度按档位归类（低于下限/范围内/高于上限/高于警戒），报告档位比例（精确置信区间），并与文献报道的"亚治疗比例"（如挪威队列中阿立哌唑在低 C/D 组的亚治疗比例 30.0% vs 正常组 5.7%）作非正式对照；不做参数检验。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-006 -->

**主要偏倚与应对**：文献档位边界基于谷浓度与稳态假设，本院无采血时刻 → 应对：方法学部分声明"以临床常规 TDM 标本为限，不区分谷/峰"，所有档位结论限定为"相对参考范围的位置"，不称"达到/未达到治疗浓度"。

**发表定位**：短篇/letter（本院抗精神病药浓度谱与 AGNP 范围对照）或作为论著的方法学部分；不能单独支撑论著。

### 角度二：药品说明书与药典（国内说明书、DailyMed、中国药典）——标尺校准层，能做的比直觉少

**能做什么**：其一，用说明书完成"药品-成分-适应症-剂量"核查（本院 DRUG_NAME → 成分 → DailyMed 结构标签；如安律凡/博思清=阿立哌唑、芮达=帕利哌酮），把 140 种医嘱项归并到约 10 个精神科成分，这是所有外部连接的前置清洗步骤；DailyMed 收录阿立哌唑标签（检索日期 2026-08-05）。[22](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=7bf7d35e-46a1-4e8f-aeb5-8a93223a4abc)（结构化记录）其二，用说明书警示/不良反应列表做"预期 vs 实际"核查：阿立哌唑最常见不良反应（>10%）以锥体外系效应、静坐不能、恶心呕吐等为主。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-011 -->〔推导〕 <!-- claim:CLM-108 -->

**不能做什么（负性发现，本身即是结论）**：说明书与药典不含血药浓度参考范围——德国与法国研究分别显示，即使对氯氮平等研究充分的药物，说明书/SPC 中的 TDM 相关信息也明显不足（题录级）；因此说明书不能替代共识作为浓度标尺，本院检验参考范围的唯一权威来源是 AGNP 体系（见角度一）。[17](https://pubmed.ncbi.nlm.nih.gov/17541888/)（题录级）[18](https://pubmed.ncbi.nlm.nih.gov/20199581/)（题录级）这一"说明书对 TDM 沉默"现象可构成一篇方法学短篇的素材：以本院 7 种监测药物为清单，系统核对国内外说明书/药典是否给出浓度范围（负性结果本身有发表价值）。〔推导〕 <!-- claim:CLM-108 -->

**接法与粒度**：连接键为成分名/商品名 → DailyMed setid（US 标签，经 NLM 公开接口）与 NMPA 说明书索引（候选记录需经官方核实后方可引用其正文数值）；粒度为药物级。

**偏倚与应对**：DailyMed 为美国标签，与中国适应症/剂量有差异 → 应对：中国说明书仅作"存在性"核查，不作数值引用；被引说明书版本注明检索日期。

**发表定位**：质量改进/方法学短篇（"说明书是否支持 TDM"核查 + 本院检验-医嘱-说明书一致性核查），或作为主报告的附件分析。

### 角度三：药物基因组学知识库（CPIC/DPWG/PharmGKB 表型-剂量建议）——只能做"间接表型推断"

**能做什么**：CPIC（2009 年由 PGRN 与 PharmGKB 共建）与 DPWG 提供基因型→代谢表型→剂量建议的注释体系；对阿立哌唑，DPWG 与 FDA 建议 CYP2D6 慢代谢者（PM）减量，合并强 CYP3A4 抑制剂建议减至 1/4 剂量；奥氮平无基于基因型的剂量推荐（其浓度主要由 CYP1A2 与吸烟驱动）。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-008 -->[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-010 -->在无基因型的约束下，知识库的用途转为"给代谢物比值提供表型解释框架"：脱氢阿立哌唑约为阿立哌唑稳态浓度的 40%（CYP2D6 依赖），故脱氢/母药比值可作为 CYP2D6 活性的内源探针。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-007 -->

**接法与粒度**：连接键为成分-基因对（aripiprazole–CYP2D6）→ PharmGKB 注释/CPIC-DPWG 指南；粒度为药物级-表型级。本院无基因型字段，连接止步于"用文献表型分层分布解释本院比值"，不进入患者级基因型判定。

**统计/比对方法**：将本院脱氢/母药比值与文献按 CYP2D6 表型分层的比值分布对照（题录级证据：日本患者中 CYP2D6 减功能等位基因携带者阿立哌唑浓度显著更高 [16]；CYP2D6 表型荟萃分析显示中间代谢者浓度高于正常代谢者 [14]）；输出"本院比值落在文献中间代谢表型区间"的位置判断，明确标注为假设生成（详见推导部分）。[16](https://pubmed.ncbi.nlm.nih.gov/21157400/)（题录级）[14](https://pubmed.ncbi.nlm.nih.gov/30565279/)（题录级）

**偏倚与应对**：代谢物比值受采血时刻、稳态与否、合并用药（表型转化）影响；东亚人群 CYP2D6 减功能等位基因高频、PM 罕见意味着"按欧美 PM 比例解读本院异常浓度"是错误的 → 应对：只报告比值分布位置，绝不报告"该患者为 PM/IM"；合并 CYP2D6 抑制剂时单独标注。[4](https://europepmc.org/articles/PMC8316766) <!-- claim:CLM-009 -->与氯氮平/奥氮平不同，阿立哌唑浓度不受吸烟影响，故阿立哌唑相关对照无需吸烟校正，这是本院可放心对照的一种药物。[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-025 -->

**发表定位**：论著中的分析模块，或短篇（"无基因型条件下用代谢物比值定位 CYP2D6 表型的可行性——中国住院患者小样本"）；投稿时须在题目/摘要中写明"假设生成"。

### 角度四：药物相互作用与代谢通路资源（DrugBank/文献 DDI 知识）——多药合并浓度异常的解释层

**能做什么**：把医嘱中的合并用药对映射到已知 CYP/转运体相互作用知识（DrugBank 相互作用字段、Spina/de Leon 系统综述体系、AGNP 共识的 DDI-浓度章节），生成"浓度-合并用药"对照表。本数据集的直接目标：P2 的氯氮平 721 ng/mL（400 mg/d，C/D=1.80）高于 350–600 参考范围上限，其合并帕利哌酮、氯硝西泮、碳酸锂；逐一检查已知相互作用知识，上述药物均非 CYP1A2 抑制剂，故无明确 DDI 可解释超限，解释须转向"吸烟未知、炎症未知、依从性未知"的排除法（详见推导部分）。[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-027 -->[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-026 -->〔推导〕 <!-- claim:CLM-104 -->

**接法与粒度**：连接键为成分名对（A→B 的相互作用记录）；粒度为药物级-组合级；DrugBank 以 RXCUI/InChI 为键，本院药名需先经 RxNorm 解析。[21](https://rxnav.nlm.nih.gov/)（结构化记录）

**统计/比对方法**：描述性——列出每例的合并用药谱（精神科+中药），标记"已知可改变该药浓度的相互作用对"；对每个超范围浓度给出"可归因 DDI / 不可归因"判定；因样本量过小不做回归。

**偏倚与应对**：无吸烟史与炎症指标使氯氮平/奥氮平类浓度解释存在大缺口（吸烟经 CYP1A2 诱导可使氯氮平浓度低 20–40%，炎症可使浓度成倍上升）→ 应对：把"吸烟/炎症未知"写成明确的解释边界，不把超范围归因于任何单一 DDI。[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-024 -->

**发表定位**：病例系列（多药合并下氯氮平超限浓度的归因讨论，对照已发表 DDI 综述）；本院医嘱中的中药（石菖蒲、刺五加等）与 CYP 相互作用的证据极弱，只能作为"待研究"列出，不能作为解释变量。

### 角度五：公开药品安全监测/不良事件数据（FAERS/OpenFDA、SIDER）——信号三角互证层

**能做什么**：FAERS（2004 至 2024 年，共 21,161,817 份报告）支持按 MedDRA SMQ/PT 做不成比例分析（ROR/PRR）；OpenVigil FDA 等公开查询接口经 openFDA API 提供 RRR 不成比例分析能力；已发表证据显示阿立哌唑与帕金森样事件显著关联（ROR 7.43，95%CI 7.06–7.81）。[9](https://europepmc.org/articles/PMC11739097) <!-- claim:CLM-028 -->[9](https://europepmc.org/articles/PMC11739097) <!-- claim:CLM-029 -->[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-031 -->与本院数据的结合点：其一，P4 肌张力障碍、P1 迟发性运动障碍/高泌乳素血症诊断可与 FAERS 的 EPS/催乳素信号对照——阿立哌唑在 FAERS 中 EPS 类信号强而催乳素相关信号弱（催乳素升高关联最强的是利培酮/帕利哌酮/氨磺必利，阿立哌唑是催乳素降低关联最强的药物之一），本院 P1"阿立哌唑+高泌乳素血症"构成一个有悖于常见模式的反例，适合做病例报告式讨论；[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-033 -->其二，把 FAERS 信号列表与本院 7 种监测药逐一核对，输出"信号-本院可观察字段"覆盖矩阵。〔推导〕 <!-- claim:CLM-108 -->

**接法与粒度**：连接键为成分名（FAERS 以标准化药品名为键）；粒度为人群级（信号）而非患者级——FAERS 无患者级浓度数据，不能与本院浓度直接对接，只能做"本院观察 vs 外部信号"的平行对照。

**偏倚与应对**：FAERS 为自愿报告，信号仅提示统计关联，不能建立因果；SIDER 类结构化副作用标注数据本轮无法核验 → 应对：只引用已发表论文中的 FAERS 分析结果与 openFDA API 的公开性，不自行声称本院"检出"任何信号。[9](https://europepmc.org/articles/PMC11739097) <!-- claim:CLM-030 -->

**发表定位**：病例系列/letter（"本院阿立哌唑相关高泌乳素血症个案与 FAERS 信号模式的对照"）；若未来扩样，可做"本院真实世界 ADR 观察与 FAERS 信号一致性"质量改进报告。

### 角度六：临床试验注册库（CT.gov/ICTRP）——研究空白定位层

**能做什么**：注册库检索显示，TDM 类注册研究高度集中在抗菌药（利奈唑胺、抗结核药）、免疫抑制剂与抗肿瘤药，抗精神病药 TDM 的干预性注册研究稀缺；这为"本院回顾性小样本研究仍有发表空间"提供注册库层面的证据，并可定位可借鉴的外部队列（如挪威 TDM 服务数据库、日本氯氮平 TDM 预测研究）。[20](https://clinicaltrials.gov/search?term=aripiprazole%20therapeutic%20drug%20monitoring)（结构化记录）

**接法与粒度**：连接键为成分名+疾病名；粒度为研究级（NCT/注册号），用于 (a) 撰写"研究空白"段落时引用注册库检索事实；(b) 寻找可对照的已发表/进行中队列。

**统计/比对方法**：无统计，仅引用注册记录做领域分布陈述（时间窗内注册数、领域分布）。

**偏倚与应对**：注册库记录滞后/遗漏（阴性或未发表研究不上库）→ 应对：把"未注册"写成"未在检索到的注册库中出现"，不写"不存在"。

**发表定位**：主报告"研究空白"段落的支撑材料；不宜单独成文。

### 角度七：已发表同类 TDM 队列的汇总统计（外部基准/对照）——唯一能撑起论著级推演的方向

**能做什么**：文献中存在三类可直接作外部基准的汇总统计：(1) 人群级 C/D 分布——挪威 TDM 登记库 147,964 次抗精神病药测量构建的各药 C/D 百分位。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-001 -->（低/正常剂量校正浓度按该药人群 C/D 的第 25/75 百分位界定）[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-002 -->；(2) 代谢物比值分布（如阿立哌唑/脱氢阿立哌唑）；(3) "超参考范围比例"——如挪威抗抑郁药队列以"血清浓度高于参考范围上限"为结局（老年组 10.6% vs 年轻组 6.0%），这是可在小样本复制的结局定义。[7](https://europepmc.org/articles/PMC7473958) <!-- claim:CLM-021 -->[7](https://europepmc.org/articles/PMC7473958) <!-- claim:CLM-020 -->文献基准锚点：挪威队列 272 例中 40.4%（110 例）在起始氯氮平前呈低 C/D 状态。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-004 -->

**能否对照本院浓度：能，但有若干前提**（对应用户要求的专项展开）：

- 测定方法对等：本院方法须为 LC-MS/MS（与挪威/德国登记库一致）或披露方法偏倚；免疫法对活性部分系统偏高（Passing–Bablok 斜率 1.12），若本院为免疫法则定量对照需加修正或放弃。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-041 -->
- 活性部分定义一致：总阿立哌唑（母药+脱氢）才与 AGNP/登记库的"活性部分"可比，本院两份单独浓度需先求和；免疫法只报活性部分、不拆分母药与代谢物，故基于拆分比值的分析要求本院方法为色谱法。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-015 -->
- 采血时机与稳态：登记库方法学以临床常规 TDM 标本（含撤药时间记录）为准；本院无采血时刻 → 只能对照"相对位置"，并报告该不确定性。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-005 -->
- 人群匹配：文献基准以高加索人群为主，东亚人群 CYP2D6 表型分布不同（减功能等位基因高频、PM 罕见），直接套用欧美 C/D 百分位会有系统性位置偏移 → 应同时报告与东亚单药研究分布的对照（题录级）。[14](https://pubmed.ncbi.nlm.nih.gov/30565279/)（题录级）
- 不得把文献均值当金标准：参考范围是"关联概率"而非个体靶值；超范围≠过量用药，本院报告须写"相对参考范围的位置"而非"异常"。[7](https://europepmc.org/articles/PMC7473958) <!-- claim:CLM-022 -->

**统计方法**：本院数据可计算 (a) 每药 C/D 中位数/区间；(b) 档位归类比例及精确置信区间；(c) 脱氢/母药比值分布位置；(d) 与文献百分位基准的"点对分布"图示对照（不做假设检验）。全部输出标注为描述性。

**偏倚与应对**：选择偏倚（送检标本非随机，临床多在疑疗效不佳/ADR 时送检——挪威作者亦指出此偏倚）、小样本、多重药物混杂 → 应对：题目与摘要限定"小样本描述性"；每例同时给出合并用药谱。

**发表定位**：论著（"单中心小样本抗精神病药 TDM 浓度分布与文献人群基准对照"）或质量改进报告（"TDM 送检与报告规范核查"）；若仅报告单药浓度谱，以短篇/letter 更合适。

### 角度八（负向）：即便接入外部数据也做不了的方向

- 个体药代动力学建模/贝叶斯预测：缺采血时刻与多点采样（检验表只有日期），C/D 只能做人群层面对照，不能做个体 PK 参数推断。
- 暴露-疗效/暴露-安全性关联：无量表评分、无系统 ADR 记录字段，不能把浓度与临床结局挂钩；只能做"浓度档位-诊断词条"的粗对应（如 P1 高泌乳素血症与阿立哌唑）。
- 基因型-浓度关联及基于基因型的剂量预测：无基因型字段；代谢物比值推断的表型必须标注为假设，不能用于临床决策。
- 前瞻验证/干预对照：约束明文禁止。
- 以本院样本估计人群参考区间：样本量过小不可行；参考区间只能引用外部基准。
- 依从性判定：无采血时刻无法区分"漏服 vs 快代谢"（文献用撤药时间区分）；本院最低浓度（P5 总 127 ng/mL）低于下限也不能归因于依从性。〔推导〕 <!-- claim:CLM-108 -->
- 中药-西药相互作用的量化评估：医嘱中 30 余种中药颗粒，但中药 CYP 相互作用证据多为体外/弱证据，外部资源无法提供可靠定量参数。〔推导〕 <!-- claim:CLM-108 -->
- 长结局（再入院 31 天标志存在但样本量过小无意义）、儿童/老年特殊人群（本院 21–56 岁成人）。〔推导〕 <!-- claim:CLM-108 -->

## 三角互证与冲突处理

三组独立证据在本问题上的一致性值得专门说明。

其一，**本院参考范围与 AGNP 参考范围一致**（数据文件 vs 多个独立文献源）：阿立哌唑 100 至 350、活性部分 150 至 500（Toja-Camba 转引 AGNP）[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-012 -->、奥氮平 20–80、警戒 100（Zhu 转引 AGNP）[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-032 -->、氯氮平 350–600（Moschny 引用）[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-026 -->——多处独立转引与本院 LIS 逐项吻合，形成"本院参考范围源于 AGNP 体系"的一致判断；[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-200 -->但同一体系存在版本冲突：Hart 2022 荟萃分析提出修订范围 120–270/180–380 ng/mL，与 AGNP 2017 版不同——冲突裁决：采用版本并行报告，因为新旧版本范围在文献中并行存在，且本院参考范围目前沿用 AGNP 2017 版。[5](https://europepmc.org/articles/PMC10820753) <!-- claim:CLM-013 -->

其二，**代谢物比值方向与基因型结论方向一致**：文献综述给出的脱氢/母药稳态参考约 0.4（正常代谢者人群均值）与东亚人群 CYP2D6 减功能等位基因携带者浓度升高的题录证据指向同一方向（本院比值普遍低于 0.4，见上文推导）——这些角度相互印证，但均为间接证据，故只作假设生成；若某例出现"比值高而浓度低"的冲突，以方法/采血问题优先解释，不引入基因型假设。〔推导〕 <!-- claim:CLM-102 -->

其三，**FAERS 信号与本院诊断的对照**：阿立哌唑在 FAERS 中 EPS 信号强、催乳素相关信号弱（利培酮、帕利哌酮、氨磺必利为催乳素升高关联最强，阿立哌唑为催乳素降低关联最强）——本院 P1"阿立哌唑+高泌乳素血症"与这一信号格局不一致，构成"个案级反例"，比一致案例更有报告价值；冲突处置：反例优先写，并给出"基线催乳素未测/既往抗精神病药史未知"的解释路径。[10](https://europepmc.org/articles/PMC9606398) <!-- claim:CLM-033 -->

## 推导与外推

以下为本报告根据数据集与已保存证据的自行计算，均标记〔推导〕，不构成任何来源的直接陈述。

〔推导〕CLM-101（本院 5 例剂量归一化浓度与代谢物比值）〔推导〕 <!-- claim:CLM-101 -->
方法：按 Lenk 定义计算 C/D = 浓度(ng/mL)÷日剂量(mg/d)，脱氢/母药比值 = 脱氢浓度÷母药浓度；日剂量取 TDM 检测日前最近一条持续医嘱的每日总剂量（检验表 TEST_DATE 与医嘱 START/END 重叠确认）。结果：P1 总 C/D=18.6（372÷20）与 25.2（503÷20），比值=0.17 与 0.26；P2 氯氮平 C/D=1.80（721÷400），帕利哌酮 C/D=7.2（86.4÷12），氯硝西泮 C/D=23.3（46.6÷2）；P3 总 C/D=28.9（433÷15），比值=0.22；P4 总 C/D=10.7（107÷10），奥氮平 C/D=2.71（54.2÷20），比值=0.34；P5 总 C/D=12.7（127÷10），比值=0.27。〔推导〕 <!-- claim:CLM-101 -->
假设：医嘱剂量在检测前已稳定 ≥5 个半衰期（阿立哌唑 t½ 58–78 h，5×t½≈12–16 天）；P1 首测在 10 mg bid 医嘱开始后 11 天、P4/P5 在开始后 ≤4 天——后者不满足稳态假设，敏感性高；P2 阿立哌唑 63 ng/mL 在住院期间无对应医嘱，判为既往用药残留，不纳入阿立哌唑分析。〔推导〕 <!-- claim:CLM-101 -->
敏感性：若 P4/P5 未达稳态，其 C/D 与比值被低估（方向：向 0 偏），故 P4/P5 的档位判断只作下限性解读；若本院测定为免疫法（只报活性部分），则 P1/P3/P5 的母药/脱氢拆分与比值不可用，只能使用总浓度。〔推导〕 <!-- claim:CLM-101 -->

〔推导〕CLM-102（本院脱氢/母药比值全部低于文献稳态参考 0.4）〔推导〕 <!-- claim:CLM-102 -->
方法：CLM-101 的 4 例阿立哌唑可用比值（0.17、0.22、0.26、0.27、0.34；P1 两次）与文献综述"脱氢阿立哌唑约为母药稳态浓度 40%（≈0.4）"逐例相除比较，4 例 5 人次全部低于 0.4（幅度为参考值的 0.43–0.85 倍）。〔推导〕 <!-- claim:CLM-102 -->
假设：该 0.4 参考来自欧美正常代谢者为主人群的稳态样本；本院为汉族住院患者，东亚人群 CYP2D6 减功能等位基因携带率高（题录级证据：日本患者、中国健康人研究均报告减功能等位基因影响阿立哌唑浓度）[16](https://pubmed.ncbi.nlm.nih.gov/21157400/)（题录级）[14](https://pubmed.ncbi.nlm.nih.gov/30565279/)（题录级）；采血时刻/稳态与否影响比值。〔推导〕 <!-- claim:CLM-102 -->
敏感性：若个别病例未达稳态（P4/P5），比值偏低方向与观察一致，结论方向不变但幅度不可靠；若有 CYP2D6 抑制剂合并用药，比值会进一步走低（本院 4 例均无氟西汀/帕罗西汀类医嘱）。结论：本院比值分布位置与"东亚人群 CYP2D6 活性偏低"的文献预期一致——仅假设生成，不可用于表型判定。〔推导〕 <!-- claim:CLM-102 -->

〔推导〕CLM-103（本院总阿立哌唑亚治疗档位比例 2/5 例）〔推导〕 <!-- claim:CLM-103 -->
方法：以 AGNP 活性部分下限 150 ng/mL 为界，5 例阿立哌唑相关测量中 P4（107）与 P5（127）低于下限，P1（372、503）、P3（433）高于下限；比例 2/5=40%，精确置信区间约 5.3%–85.3%。与文献基准对照：Lenk 队列中"低 C/D 组"的阿立哌唑亚治疗比例 30.0%、正常组 5.7%，本院 40% 落在低 C/D 组一侧；P4 母药 79.9 ng/mL 亦低于 100 下限。〔推导〕 <!-- claim:CLM-103 -->
假设：本院标本为临床常规 TDM 标本（可能非稳态、非谷浓度）；亚治疗=低于活性部分下限，不等同"无效治疗"。
敏感性：若排除未达稳态的 P4/P5，比例降为 0/3；若计入 P2 的残留浓度（63 ng/mL）则 3/6。结论：仅作为"描述性档位分布"报告，禁止外推为"40% 患者亚治疗"。〔推导〕 <!-- claim:CLM-103 -->

〔推导〕CLM-104（P2 氯氮平 721 ng/mL 超上限的归因边界）〔推导〕 <!-- claim:CLM-104 -->
方法：721÷600=1.20 倍于氯氮平参考上限（350–600）；其 C/D=1.80；合并帕利哌酮（C/D=7.2，86.4 ng/mL，超出本院 20–60 范围 1.44 倍）、氯硝西泮 46.6（范围内）、碳酸锂 0.6–0.9 g/d。逐项检查已知相互作用知识：帕利哌酮/氯硝西泮/锂盐均非 CYP1A2 抑制剂（依据已保存综述的 CYP 底物-抑制剂框架），故无明确 DDI 可解释氯氮平超限；吸烟（诱导 CYP1A2）与炎症（抑制 CYP1A2、升高 α1-酸性糖蛋白结合）两项最强解释变量本院均无记录。〔推导〕 <!-- claim:CLM-104 -->
假设：登记医嘱反映实际给药；无漏服；检测前稳态（氯氮平 t½ 约 12–66 h，400 mg/d 方案维持 ≥28 天，满足稳态）。〔推导〕 <!-- claim:CLM-104 -->
敏感性：若患者吸烟（精神病住院人群吸烟率可达 35–54% 甚至更高），戒烟后浓度可再升 20–40%，721 ng/mL 的含义完全不同；若有亚临床感染，浓度可成倍升高。结论：P2 氯氮平超限的归因保持"开放"，报告按排除法列出已知/未知因素，并提示临床关注氯氮平相关毒性（依据已保存综述的毒性清单）。〔推导〕 <!-- claim:CLM-104 -->

〔推导〕CLM-105（本院总阿立哌唑 C/D 全部落在剂量-范围推导的理论区间内）〔推导〕 <!-- claim:CLM-105 -->
方法：以活性部分参考范围 150–500（即 150 至 500）ng/mL 与说明书常见日剂量区间 15–30 mg 相除，得到理论 C/D 区间下限 150÷30=5.0、上限 500÷15=33.3 (ng/mL)/(mg/d)；CLM-101 的 4 例总 C/D（10.7、12.7、18.6、25.2、28.9）全部落在此区间内。〔推导〕 <!-- claim:CLM-105 -->
假设：浓度-剂量在治疗剂量范围内近似线性（阿立哌唑线性 PK，文献综述确认）；日剂量取实际处方而非说明书最大/最小。
敏感性：若按 10 mg/d 计算，区间变为 15–50，仍覆盖全部观察；若按 Hart 2022 修订范围 180–380 计算，区间为 12–25.3，P3（28.9）越界——说明本院观察对"采用哪版参考范围"敏感，进一步支持版本并行报告。结论：本院 C/D 分布与公开文献的剂量-浓度框架整体相容，未见系统性异常，方法学层面可以放心做外部对照（不构成对个体值的判断）。〔推导〕 <!-- claim:CLM-105 -->

## 讨论

把以上各角度合起来看，本报告确立的论点是：这份数据集的"外部增量空间"集中在若干可执行的接口上——外部参考分布做"位置对照"（浓度档位、C/D、代谢物比值）；外部表型知识库做"间接表型推断"（仅假设）；外部信号库、说明书与文献做"安全性三角互证"（个案级）；外部注册库做"研究空白定位"。这些接口都只消耗本院已有字段，不需要任何新增数据，因此与约束条件完全相容。

各接口的证据强度差异明显：外部基准接口有最完整的证据链（挪威大型登记库的百分位方法学、AGNP 范围、超范围比例结局定义均可引用已保存全文）；外部表型知识库接口证据链完整但语义降级（比值-表型联系是间接的）；外部信号库接口证据链完整但只能产出一致/反例个案；外部注册库接口只提供背景。相应地，发表形态也应分层：外部基准接口可支撑论著或质量改进报告；表型推断与信号互证接口支撑短篇/病例系列；注册库接口只作为引言素材。

能定案本问题的研究（无论由本院或他人做）需要：多中心回顾性 TDM 库 + 统一采血时刻（谷浓度）+ 基因型、吸烟与 CRP 字段 + 量表结局——这正是"本院不再新增字段"约束下做不到、但应写进讨论作为未来方向的内容。在此之前，本院能以该小样本数据产出的最高证据形态就是"标注清楚的小样本描述性分析"。

## 证据局限

- 转引局限：AGNP 2017 与 ASCP-AGNP 2020 共识全文不开放获取，所有关于其内容的引文均取自四篇引用它们的开放获取综述/研究（Toja-Camba、Zhu、Moschny、Lenk），存在"二次转引"失真风险；已逐条核对，任何引文在其直接来源中均能定位。
- 题录级证据：东亚 CYP2D6 人群分布、中国早年 TDM 调查、SPC 评价等关键背景仅取得题录与摘要，其具体数值（如减功能等位基因携带率、SPC 评分）未在本报告中作为受支持声明使用，仅用于方向性表述。
- 数据层面：本院测定方法（LC-MS/MS vs 免疫）、采血时刻、稳态状态、吸烟与炎症均未知，直接限制 C/D 与比值的可比性；这是本报告反复声明的最大不确定源，也是所有对照结论必须降级为"相对位置"的原因。
- 样本量：仅 5 例使一切比例估计的置信区间极宽（推导部分的 40% 比例，其区间达 5.3%–85.3%），任何比例表述不得脱离区间单独引用。〔推导〕 <!-- claim:CLM-103 -->
- 证据可及性：AGNP 2017 与 ASCP-AGNP 2020 共识全文不开放获取，其数值经引用该共识的开放获取文献转引；PharmGKB 与 SIDER 的结构化数据本轮无法公开核验，相关描述仅依据开放获取综述的记载；中文精神科 TDM 共识全文未能取得，其存在性经已保存文献转引确认。
- 发表偏倚：外部基准（尤其 C/D 分布）多来自有 TDM 服务的北欧/德国中心，其人群与送检习惯与中国精神专科医院存在系统性差异，可移植性有限。

## 结论

在全部约束下，本院这份小样本 TDM 数据集仍具明确的、可发表的增量研究价值，但价值形态是"描述性小样本对照与分析框架"，而非"因果或人群推断"。推荐排序：

- 首选（论著/质量改进）：以 AGNP/ASCP-AGNP 范围与挪威登记库 C/D 百分位为外部基准，报告本院浓度档位分布、C/D 与脱氢/母药比值位置——方法论最完整、发表障碍最低。
- 次选（短篇/病例系列）：氯氮平超限（P2）与多药合并的归因边界分析；阿立哌唑+高泌乳素血症（P1）与 FAERS 信号格局的反例报告。
- 可做（假设生成）：无基因型条件下的代谢物比值表型推断，必须限定"假设生成"并采用版本并行报告。
- 明确不做：个体 PK 建模、暴露-疗效关联、基因型-浓度关联、任何前瞻设计与人群参考区间估计。

## 安全优先的实际处置

本报告是研究规划分析，不构成患者个体用药建议；以下为开展研究时的安全边界与必要动作，每条均有直接证据支撑。

- 开展回顾性分析前完成伦理审查与知情豁免/去标识化流程：本数据集内患者一律以化名 P1–P5 引用，禁止携带住院号、病案号、姓名与出生日期；挪威同类回顾性 TDM 数据库研究有"仅含历史常规检测数据、免知情同意"的伦理先例可借鉴，且其十年 TDM 比较研究均经区域伦理委员会批准。[3](https://europepmc.org/articles/PMC11098931) <!-- claim:CLM-034 -->[7](https://europepmc.org/articles/PMC7473958) <!-- claim:CLM-035 -->

- 对超参考范围上限的氯氮平浓度（如本数据集 P2 的检测值）不单独作为任何结论的证据：吸烟者氯氮平平均浓度较非吸烟者低 20–40%，戒烟后建议剂量下调 30–50%，浓度波动可致中毒表现，临床应对此类浓度保持警惕并向主管医师核实吸烟与感染状态；研究报告中把该值表述为"相对参考范围的位置"而非"中毒"。[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-036 -->[8](https://europepmc.org/articles/PMC8230242) <!-- claim:CLM-037 -->

- 对阿立哌唑相关锥体外系/帕金森样事件保持临床警惕：FAERS 不成比例分析显示阿立哌唑与帕金森样事件存在显著统计关联（ROR 7.43，95%CI 7.06–7.81），本数据集 P4 有肌张力障碍、P1 有迟发性运动障碍诊断，报告中应把文献信号与临床观察并列呈现，但不得据此断言因果关系。[9](https://europepmc.org/articles/PMC11739097) <!-- claim:CLM-038 -->

- 报告任何浓度档位时一律注明参考范围版本与适用人群，不得把文献参考范围当成本院个体的"治疗靶值"：浓度高于参考范围上限不等于过量用药，参考范围不是绝对治疗范围。[7](https://europepmc.org/articles/PMC7473958) <!-- claim:CLM-039 -->

- 若未来引用中国说明书或药典信息，须以官方当前版本核实后再引用（本报告对 NMPA 标签仅作"存在性"确认，未引用其正文数值）；中文共识（如中国药理学会治疗药物监测研究专业委员会发布的《治疗药物监测结果解读专家共识》）可作为解读框架，但原文未在本轮取得，引用前需取得原文。[6](https://europepmc.org/articles/PMC10013164) <!-- claim:CLM-040 -->

## 参考文献

1. 本院治疗药物监测数据集（20260803TDM.xlsx）：5 例精神专科住院患者，2020-11 至 2021-03。工作区数据文件（病案首页/医嘱记录/检验/诊断记录/体征五张工作表）。
2. Hiemke C, Bergemann N, Clement HW, et al. Consensus guidelines for therapeutic drug monitoring in neuropsychopharmacology: update 2017. Pharmacopsychiatry. 2018;51(1-02):9-62. doi:10.1055/s-0043-116492. PMID:28910830. URL:https://pubmed.ncbi.nlm.nih.gov/28910830/（付费墙，正文未直接获取，经开放获取二次文献转引）
3. Lenk HÇ, Smith RL, O'Connell KS, Andreassen OA, Molden E. Rapid metabolism underlying subtherapeutic serum levels of atypical antipsychotics preceding clozapine treatment: a retrospective analysis of real-world data. CNS Drugs. 2024;38(6):473. doi:10.1007/s40263-024-01079-y. PMCID:PMC11098931. URL:https://europepmc.org/articles/PMC11098931
4. Soria-Chacartegui P, Villapalos-García G, Zubiaur P, Abad-Santos F, Koller D. Genetic polymorphisms associated with the pharmacokinetics, pharmacodynamics and adverse effects of olanzapine, aripiprazole and risperidone. Front Pharmacol. 2021;12:711940. doi:10.3389/fphar.2021.711940. PMCID:PMC8316766. URL:https://europepmc.org/articles/PMC8316766
5. Toja-Camba FJ, Bandín-Vilar E, Hermelo-Vidal G, et al. Towards precision medicine in clinical practice: Alinity C vs. UHPLC-MS/MS in plasma aripiprazole determination. Pharmaceutics. 2024;16(1):104. doi:10.3390/pharmaceutics16010104. PMCID:PMC10820753. URL:https://europepmc.org/articles/PMC10820753
6. Yin T, Liang H, Huang Q, et al. A survey of therapeutic drug monitoring status in China. Ther Drug Monit. 2023;45(2):151. doi:10.1097/FTD.0000000000001060. PMCID:PMC10013164. URL:https://europepmc.org/articles/PMC10013164
7. Tveit K, Hermann M, Waade RB, Nilsen RM, Wallerstedt SM, Molden E. Use of antidepressants in older people during a 10-year period: an observational study on prescribed doses and serum levels. Drugs Aging. 2020;37(9):691. doi:10.1007/s40266-020-00784-9. PMCID:PMC7473958. URL:https://europepmc.org/articles/PMC7473958
8. Moschny N, Hefner G, Grohmann R, et al. Therapeutic drug monitoring of second- and third-generation antipsychotic drugs—influence of smoking behavior and inflammation on pharmacokinetics. Pharmaceuticals. 2021;14(6):514. doi:10.3390/ph14060514. PMCID:PMC8230242. URL:https://europepmc.org/articles/PMC8230242
9. Wang K, Chen J, Huang M, et al. Drug-induced Parkinson-like events: a real-world study from 2004 to the first quarter of 2024 based on FAERS. Front Pharmacol. 2024;15:1529260. doi:10.3389/fphar.2024.1529260. PMCID:PMC11739097. URL:https://europepmc.org/articles/PMC11739097
10. Zhu X, Hu J, Xiao T, Huang S, Shang D, Wen Y. Integrating machine learning with electronic health record data to facilitate detection of prolactin level and pharmacovigilance signals in olanzapine-treated patients. Front Endocrinol. 2022;13:1011492. doi:10.3389/fendo.2022.1011492. PMCID:PMC9606398. URL:https://europepmc.org/articles/PMC9606398
11. Schoretsanitis G, Kane JM, Correll CU, et al. Blood levels to optimize antipsychotic treatment in clinical practice: a joint consensus statement of the American Society of Clinical Psychopharmacology and the Therapeutic Drug Monitoring Task Force of the Arbeitsgemeinschaft für Neuropsychopharmakologie und Pharmakopsychiatrie. J Clin Psychiatry. 2020;81(3):19cs13169. doi:10.4088/JCP.19cs13169. PMID:32433836. URL:https://pubmed.ncbi.nlm.nih.gov/32433836/（付费墙，正文未直接获取）
12. Hart XM, Hiemke C, Eichentopf L, et al. Therapeutic reference range for aripiprazole in schizophrenia revised: a systematic review and meta-analysis. Psychopharmacology. 2022;239(11):3377-3391. doi:10.1007/s00213-022-06233-2.（经 Toja-Camba 2024 转引）
13. Guo W, Guo GX, Sun C, et al. Therapeutic drug monitoring of psychotropic drugs in China: a nationwide survey. Ther Drug Monit. 2013;35(6):816-822. PMID:24263641. URL:https://pubmed.ncbi.nlm.nih.gov/24263641/（题录级）
14. Zhang X, Xiang Q, Zhao X, Ma L, Cui Y. Association between aripiprazole pharmacokinetics and CYP2D6 phenotypes: a systematic review and meta-analysis. J Clin Pharm Ther. 2019;44(2):163-173. PMID:30565279. URL:https://pubmed.ncbi.nlm.nih.gov/30565279/（题录级）
15. Jukic MM, Smith RL, Haslemo T, Molden E, Ingelman-Sundberg M. Effect of CYP2D6 genotype on exposure and efficacy of risperidone and aripiprazole: a retrospective, cohort study. Lancet Psychiatry. 2019;6(5):418-426. PMID:31000417. URL:https://pubmed.ncbi.nlm.nih.gov/31000417/（题录级）
16. Suzuki T, Mihara K, Nakamura A, et al. Effects of the CYP2D6*10 allele on the steady-state plasma concentrations of aripiprazole and its active metabolite, dehydroaripiprazole, in Japanese patients with schizophrenia. Ther Drug Monit. 2011;33(1):21-24. PMID:21157400. URL:https://pubmed.ncbi.nlm.nih.gov/21157400/（题录级）
17. Ulrich S, Hiemke C, Laux G, et al. Value and actuality of the prescription information for therapeutic drug monitoring of psychopharmaceuticals: a comparison with the medico-scientific evidence. Pharmacopsychiatry. 2007;40(3):121-127. PMID:17541888. URL:https://pubmed.ncbi.nlm.nih.gov/17541888/（题录级）
18. Rougemont M, Ulrich S, Hiemke C, Corruble E, Baumann P. French summaries of product characteristics: content in relation to therapeutic monitoring of psychotropic drugs. Fundam Clin Pharmacol. 2010;24(5):563-576. PMID:20199581. URL:https://pubmed.ncbi.nlm.nih.gov/20199581/（题录级）
19. Molden E, Lunde H, Lunder N, Refsum H. Pharmacokinetic variability of aripiprazole and the active metabolite dehydroaripiprazole in psychiatric patients. Ther Drug Monit. 2006;28(6):744-749. PMID:17164689. URL:https://pubmed.ncbi.nlm.nih.gov/17164689/（题录级）
20. ClinicalTrials.gov（美国国立医学图书馆）. Aripiprazole + therapeutic drug monitoring 注册研究检索结果（共 427 条，检索日期 2026-08-05）. URL:https://clinicaltrials.gov/search?term=aripiprazole%20therapeutic%20drug%20monitoring（结构化记录）
21. RxNorm（美国国立医学图书馆）. Aripiprazole 药物概念（RXCUI）记录（检索日期 2026-08-05）. URL:https://rxnav.nlm.nih.gov/（结构化记录）
22. DailyMed（美国国立医学图书馆）. ARIPIPRAZOLE TABLET [AUROBINDO PHARMA LIMITED]. Updated 2026-08-03. URL:https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=7bf7d35e-46a1-4e8f-aeb5-8a93223a4abc（结构化记录）
