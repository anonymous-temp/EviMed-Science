# 基于五表 TDM 回顾性数据集（20260803TDM.xlsx）可开展的科学研究：证据约束下的可行性分析与研究方向

## 摘要

本报告回答的问题是：在"仅回顾性、不新增任何数据采集"的硬约束下，上传的五张表能支撑哪些可发表、可执行的科学性研究，哪些不能。底线结论是：**这套数据（5 例精神科住院患者、22 条 TDM 浓度结果、915 条医嘱、537 条生命体征、56 条诊断记录[1]）只能支撑描述性、质量审计与假说生成类研究，不能支撑任何依赖组间推断统计的疗效、因果关系或基因型结论。**

可落地的研究方向有四类，按证据支撑强度排序：① 抗精神病药 TDM 参考区间依从性与"医嘱—检验"完整性审计（数据完全支持，描述性设计）[1]；② 以浓度/剂量比（C/D）与脱氢阿立哌唑/阿立哌唑代谢比值推断 CYP2D6 代谢能力（文献对照的假说生成，需严格稳态筛选）[2][3][4]；③ 多药联用背景下的浓度个案系列分析[4][9]；④ 生命体征与体重轨迹的描述性监测（氯氮平患者 BMI 34.2，奥氮平起始后脉搏 105–120 次/分等时间关联仅可作描述）[1][6]。不可行方向包括：组间疗效比较、浓度—疗效关联（无 PANSS 等量表结果字段）、群体药动学（PopPK）建模（样本量不足）、基因型—表型关联（无基因数据）。

数据本身已出现需要谨慎解读的安全相关信号：氯氮平 721 ng/mL 超出检验参考区间（350–600 ng/mL）、帕利哌酮 86.4 ng/mL 超出（20–60 ng/mL）[1]；文献阈值证据显示氯氮平浓度高于 600 ng/mL 与剂量依赖性不良反应率增高相关[6]，任何回顾性报告都必须按这一浓度—效应证据解读，不得写成"已达治疗浓度"。阿立哌唑浓度—疗效关联的系统评价证据等级为低（C 级）且部分阴性[4]，因此该数据集对阿立哌唑的价值在于暴露变异性与监测质量，而非疗效证据。

需要人类复核的关键点：C/D 比值与代谢比值只能作为代谢能力的代理指标，不得写成 CYP2D6 表型诊断[2][3]；数据完整性缺口（丙戊酸钠、碳酸锂有化验医嘱无检验结果；1 例无阿立哌唑用药医嘱却有 63 ng/mL 浓度[1]）必须在分析前按数据质量规则处理，不能当作"未达标"证据。

## 临床问题与论点判定条件

**临床/科研问题**：一份含 5 例患者、22 条抗精神病药 TDM 浓度、915 条医嘱、537 条体征、56 条诊断记录的五表数据集（病案首页/医嘱记录/检验/诊断记录/体征），在仅限回顾性、禁止新增任何字段（无基因检测、无量表评分、无采血与给药时刻补充）的约束下，可以支撑哪些科学性研究？

**论点（thesis）**：该数据集足以支撑"监测质量审计 + 暴露变异性假说生成"类回顾性研究，且足以产生与现有指南和药代遗传学文献可对接的分析；但不足以支撑任何需要统计推断的组间比较或因果结论。

要让这一论点成立，必须同时满足以下条件，本报告逐条攻击：

1. **字段足以定义暴露与结局**——医嘱表须能重建采样时点的每日剂量与用药史（频率字段、起止时间），检验表须含浓度与参考区间，体征表须能提供可对齐时间窗的生理测量。
2. **存在外部参照标准**——参考区间须能与 AGNP/ASCP 共识衔接，C/D 与代谢比值须有文献参考值可比较。
3. **设计类型与样本量匹配**——n=5 决定统计边界；任何推断性检验的前提都不成立。
4. **数据完整性允许可信推断**——医嘱—检验一致性、稳态条件、采血时点缺省的影响必须被显式处理，否则结论不可解释。

其中条件 1、2、3 可以满足（部分满足），条件 4 是本论证中最薄弱的一环：数据没有采血时刻与给药时刻，也没有吸烟状态，这直接限制了个体化浓度解读的确定性。

## 证据基础与检索方法

检索于 2026-08-05 完成，覆盖两类以上来源：PubMed（经 EviMed 文献适配器，含中英文检索）、Europe PMC/PMC 开放全文（经受审计的生物医学连接器）、PubMed 指南过滤、PharmGKB 镜像连接器（clinpgx，仅返回记录级入口）、RxNorm（返回产品级标识）。共完成 17 次成功检索，识别 266 条题录，按 PMID/URL/规范化标题程序化去重后剩 135 条唯一记录，纳入并保存全文 8 篇，另有 1 项用户数据文件作为分析对象。

检索概念（每项均以论文标题惯用表述重试，避免长合取式返回空集）：(a) AGNP/ASCP 抗精神病药 TDM 共识与参考区间；(b) 阿立哌唑/脱氢阿立哌唑 CYP2D6 表型、代谢比值与浓度剂量比；(c) 阿立哌唑参考区间系统评价；(d) 氯氮平浓度剂量比、换药与代谢影响因素；(e) 奥氮平参考区间与浓度—疗效；(f) 中文"精神科 治疗药物监测 专家共识"；(g) 吸烟对奥氮平/氯氮平处置的影响。PharmGKB 连接器首次查询返回 HTTP 404，改用药品名查询后仅返回记录级条目（PA10026，aripiprazole），按连接器边界作为入口记录，不承载临床结论。

纳入标准：TDM/浓度—剂量比/参考区间/代谢比值的共识、系统评价、队列或病例数据研究；开放获取全文优先。排除：非抗精神病药 TDM、动物实验、单纯方法学（非浓度解释）文献。全文保存 8 篇：Kneller 2021[2]、Gras 2025[3]、Hart 2022[4]、Tsuda 2014[5]、Rafizadeh 2024[6]、Kyllesø 2021[7]、Yuan 2023[8]、Zhang 2024[9]。闭架文献（AGNP 2017 版共识 Hiemke 2018、ASCP/AGNP 联合共识 Schoretsanitis 2020、奥氮平参考区间系统评价 Wesner 2023、阿立哌唑 CYP2D6 荟萃 Zhang 2018、Jukic 2019、Hendset 2007、Suzuki 2011、Molden 2006、Patteet 2014）仅获题录/摘要级信息，未纳入 claim 载体，其中 AGNP 共识的参考区间数值经 Hart 2022[4]与 Kneller 2021[2]两篇开放全文转引核验。

## 逐角度论证与结果

### 4.1 直接证据：数据集字段与参考标准

检验表共 22 条结果，覆盖阿立哌唑（6 条）、脱氢阿立哌唑（6 条）、总阿立哌唑（6 条）、奥氮平（1 条）、氯氮平（1 条）、氯硝西泮（1 条）、帕利哌酮（1 条），5 例患者中 4 例为阿立哌唑用药[1] <!-- claim:CLM-002 -->。检验表自带参考区间：阿立哌唑 100.0–350.0、总阿立哌唑 150.0–500.0、奥氮平 20.0–80.0、氯氮平 350.0–600.0、氯硝西泮 4.0–80.0、帕利哌酮 20.0–60.0 ng/mL[1] <!-- claim:CLM-003 -->。该区间与 AGNP 共识及 ASCP/AGNP 联合共识一致（阿立哌唑 100–350、活性部分 150–500 ng/mL[4] <!-- claim:CLM-007 -->；该数值亦被 Kneller 2021 按"共识指南"转引[2]），说明实验室采用的是现行循证参考框架，这是审计类研究的直接参照标准。Hart 2022 系统评价另建议将区间修订为 120–270/180–380 ng/mL[4] <!-- claim:CLM-008 -->。P[REDACTED-04] 在同剂量（20 mg/d）下有两轮 TDM：阿立哌唑 317→400 ng/mL、总阿立哌唑 372→503 ng/mL，构成唯一可用的患者内前后观测[1] <!-- claim:CLM-005 -->。

浓度—效应阈值证据：氯氮平 >350 ng/mL（1070 nmol/L）才与更高治疗反应率相关，>600 ng/mL（1850 nmol/L）与更高剂量依赖性不良反应率相关[6] <!-- claim:CLM-014 -->；氯氮平 TDM 被 AGNP 共识"强烈推荐"[7] <!-- claim:CLM-015 -->。奥氮平浓度与疗效在中国患者队列中呈正相关（Spearman R>0，P<.05；486 例住院患者）[8] <!-- claim:CLM-018 -->。阿立哌唑方面，系统评价给出的现行区间为 100–350/150–500 ng/mL，但建议修订为 120–270/180–380 ng/mL，且浓度—疗效关系证据等级为低（C）甚至缺如（D）[4] <!-- claim:CLM-029 -->——这直接限制了把"超标/达标"当作疗效判据的合理性。

### 4.2 直接证据：C/D 比值与 CYP2D6 表型的可对接性

文献给出了可直接对照的人群参考值：阿立哌唑 C/D 人口合并均值为 13.8（95%CI 12.4–15.3）ng/mL per mg/day，活性部分为 18.2（16.6–19.7）[4] <!-- claim:CLM-009 -->。CYP2D6 表型对暴露的影响在多项研究中一致：PM（基因型 19 例 + 表型转化 52 例）与 IM 的 C/D 及活性部分 C/D 显著高于 NM（P<.001）[3] <!-- claim:CLM-010 -->；仅按基因型计算，IM 的阿立哌唑浓度较 NM 高 56%，活性部分高 44%[3] <!-- claim:CLM-011 -->；脱氢阿立哌唑/阿立哌唑代谢比值在 PM 中较 NM 降低 47%，表型转化后 PM 与 IM 分别降低 46% 与 27%[3]。PBPK 模拟支持 PM 日剂量从 15 mg 降至 10 mg 的建议[2] <!-- claim:CLM-013 -->，Hart 等亦建议已知 PM 用 5 mg 即足[4]。阿立哌唑平均消除半衰期约 75 h（活性代谢物约 94 h），PM 可达 146 h[2] <!-- claim:CLM-030 -->——这决定了个体化 C/D 解读必须首先满足稳态条件。

### 4.3 直接证据：合并用药、吸烟与氯氮平/奥氮平处置的混杂源

文献表明：丙戊酸使阿立哌唑活性部分浓度降低约 23%，卡马西平降低约 65%[4] <!-- claim:CLM-012 -->；氟西汀使阿立哌唑清除率降至 0.714:1（119 例中国患者 PopPK）[9] <!-- claim:CLM-019 -->；氯氮平 C/D 的全队列均值 1.77、无氟伏沙明亚组均值 1.34（ng/mL per mg/day），女性、非吸烟、肥胖（BMI≥30）、CRP>10 mg/L、氟伏沙明均显著增高 C/D[6] <!-- claim:CLM-016 -->；吸烟使奥氮平 C/D 平均低 0.75、氯氮平低 1.11（ng/mL per mg/day），等效浓度下非吸烟者需减量约 30%（奥氮平）与 50%（氯氮平）[5] <!-- claim:CLM-017 -->。这些因素在本数据集中多数缺失（无吸烟、无 CRP、无肝肾功能指标结果），因此凡涉及氯氮平/奥氮平/阿立哌唑个体浓度解读的结论都必须把缺失混杂标为不确定性来源。

### 4.4 类比与相邻人群外推：同类回顾性 TDM 数据库研究是可发表的成熟设计

466 例阿立哌唑 CYP2D6 表型与停药风险队列[3]、1979 例氯氮平浓度与换药的挪威 TDM 服务数据库研究[7]、486 例奥氮平浓度—疗效中国队列[8]均为回顾性 TDM/病历数据库设计并发表于同行评议期刊 <!-- claim:CLM-028 -->。这证明本数据集所属的研究范式（TDM 数据库描述性/假说生成分析）本身可发表、可执行，但上述研究的最小样本量是 172–1979 例，与 n=5 之间存在两个数量级的差距，后者只能作为试点（pilot）数据。

### 4.5 反向与阴性证据：哪些研究方向被数据与文献双重否决

- **组间推断统计**：n=5 无法满足任何检验功效前提（详见 6.6 推导）；文献可检出的 C/D 组间差异（如 IM 较 NM 高 56%[3]）需要每组十至数十例。
- **浓度—疗效关联**：需要结构化疗效结局（PANSS 减分率等）。医嘱表中虽出现"阳性症状评定量表(SAPS)"等医嘱名称，但无任何量表结果字段[1]，不能新增评分（约束条件），因此该方向被数据结构直接否决；文献侧阿立哌唑浓度—疗效证据本身为低级别且不一致[4]。
- **PopPK 建模**：需要每例多时点浓度—时间曲线与可靠的给药—采样记录；本数据集每样本仅一条浓度、无采血时刻[1]，不具备输入条件。
- **基因型—表型关联**：无基因数据，且约束禁止新增基因检测；只能做代谢比值/ C/D 的"表型推断假说"，不能做基因型验证[2][3]。

## 三角互证与冲突处理

对"参考区间可对接"这一判断，实验室区间（数据集[1]）、Hart 2022 系统评价转引的 AGNP 区间[4]、Kneller 2021 按共识引用的区间[2]三方一致（100–350/150–500 ng/mL），互证成立。对"CYP2D6 表型影响暴露"这一判断，PBPK 模拟[2]、466 例队列[3]、系统评价汇总的多项基因型研究[4]方向一致，冲突点仅在 IM 的效应量（高 4%[4 转引 van der Weide]至高 56%[3]），本报告取保守表述（IM 暴露增加但幅度不确定）。对"氯氮平浓度阈值"，AGNP 参考区间（350–600）[1]与两篇全文文献（>350 反应、>600 不良反应[6][7]）一致。对"修订区间"，Hart 2022 建议的 120–270/180–380 ng/mL 与现行 100–350/150–500 ng/mL 冲突——冲突不影响本研究方向的可行性（依从性审计可按两种区间分别报告），但必须在方法中预先声明采用哪一套。

## 推导与外推

〔推导〕 逐样本浓度/剂量比（C/D，ng/mL per mg/day）：以采样时点有效医嘱换算每日剂量——P[REDACTED-04] 阿立哌唑 20 mg/d（10 mg BID4，医嘱 12/17–1/16），C/D=317/20=15.85（12/21）、400/20=20.0（1/4），活性部分 372/20=18.6、503/20=25.15；P[REDACTED-03] 阿立哌唑 15 mg/d（15 mg QN，12/25–1/9），C/D=354/15=23.6、活性部分 433/15=28.87；P216359 阿立哌唑 10 mg/d（10 mg QN，2/28–3/8），C/D=79.9/10=7.99、活性部分 107/10=10.7，奥氮平 20 mg/d（10 mg BID），C/D=54.2/20=2.71；P[REDACTED-05] 阿立哌唑 10 mg/d（10 mg QD，3/11–3/19），C/D=100/10=10.0、活性部分 127/10=12.7；P6851332 氯氮平 400 mg/d（100 mg QD11+300 mg QN），C/D=721/400=1.80，帕利哌酮 12 mg/d（6 mg BID4），C/D=86.4/12=7.2，氯硝西泮 4 mg/d，C/D=46.6/4=11.65；该患者阿立哌唑 63 ng/mL 无对应用药医嘱，不计 C/D。 <!-- claim:CLM-020 -->

〔推导〕 脱氢阿立哌唑/阿立哌唑代谢比值逐样本：P[REDACTED-04] 为 55/317=0.17（12/21）与 103/400=0.26（1/4）；P[REDACTED-03] 为 79/354=0.22；P216359 为 27.4/79.9=0.34；P[REDACTED-05] 为 26.6/100=0.27；P6851332 为 31/63=0.49（母体浓度无医嘱支持，可靠性低）。与 Gras 2025 报告的 PM 较 NM 降低 47%、表型转化后 PM/IM 降低 46%/27% 相比，P[REDACTED-04] 与 P[REDACTED-03] 的比值（0.17–0.26）处于偏低区间，提示 CYP2D6 代谢能力降低的假说方向。 <!-- claim:CLM-021 -->

〔推导〕 稳态合规审计：阿立哌唑 t1/2≈75 h，5 个半衰期≈15.6 天。P[REDACTED-04] 的 1/4 样本距最近一次剂量调整（12/10 起 20 mg/d）25 天，≥15.6 天，判定为明确稳态；12/21 样本距调量仅 11 天，未达稳态。P[REDACTED-03] 的 1/4 样本距起始（12/25）10 天，未达稳态。P216359 的 3/1 样本距用药起始（2/28）仅 2 天，远未达稳态。P[REDACTED-05] 的 3/19 样本距 10 mg/d 恒定（3/9）10 天，约达稳态的 65%。P6851332 的 12/30 样本距氯氮平/帕利哌酮起始（12/25）5 天，氯氮平 t1/2 约 14–16 h，约 8 个半衰期，判定近似稳态。结论：22 条浓度中仅约半数可安全进入 C/D 解读。 <!-- claim:CLM-022 -->

〔推导〕 参考区间依从性统计：阿立哌唑（100–350）6 条中 2 条高于（400、354）、2 条低于（79.9、63）、2 条范围内（317、100 恰在下限）；总阿立哌唑（150–500）6 条中 1 条高于（503）、3 条低于（107、127、94）、2 条范围内（372、433）；奥氮平 54.2 与氯硝西泮 46.6 在范围内；氯氮平 721 与帕利哌酮 86.4 高于上限。按 Hart 2022 修订区间（120–270/180–380）重算时，"高于/范围内"的归类会改变，需在方法中声明区间版本。 <!-- claim:CLM-023 -->

〔推导〕 表型推断假说（无基因型，仅为假说生成）：P[REDACTED-03] 的 C/D=23.6 为文献人群均值 13.8 的 1.71 倍，接近 IM 较 NM 暴露增高 56% 的幅度，且代谢比值 0.22 偏低，提示 CYP2D6 慢代谢（IM 或 *10 等位基因相关）假说；P[REDACTED-04] 的稳态 C/D=20.0（1/4）为均值的 1.45 倍，代谢比值 0.17–0.26，同样提示代谢能力降低，但该患者合并肝功能不全与慢性乙肝，肝病本身可解释部分暴露升高，故不能唯一归因 CYP2D6；P216359 的 C/D=8.0 偏低但样本非稳态，不作判读。P6851332 的代谢比值 0.49 偏高，但其母体浓度缺乏医嘱支持，判读价值有限。 <!-- claim:CLM-024 -->

〔推导〕 氯氮平浓度安全边界评估：P6851332 氯氮平 721 ng/mL 高于 600 ng/mL 阈值，且该患者为女性（C/D 增高因素）、BMI 34.2（肥胖，C/D 增高因素），实测 C/D=1.80 高于无氟伏沙明亚组均值 1.34，属代谢偏慢的暴露特征；帕利哌酮 C/D=7.2 亦高于常规预期。由于数据无 ADR 结局字段，只能表述为"处于剂量依赖性不良反应风险增高的浓度带"，不能断言已发生不良反应。 <!-- claim:CLM-025 -->

〔推导〕 统计功效边界：观测单元为 5 例患者、22 条浓度；按文献中 IM 与 NM 的 C/D 差异约 50–56% 及浓度变异约 30–40% 估算，α=0.05、功效 80% 的组间比较需要每组约 10–20 例，本数据集的任何组间检验均无功效；可行的统计仅限描述性（计数、中位数、极差）与单患者重复测量描述（仅 P[REDACTED-04] 有两轮）。 <!-- claim:CLM-026 -->

〔推导〕 生命体征时间关联观察：P216359 样本日期（3/1）±3 天窗口内脉搏记录为 105、112、120、94、78、90 次/分，其中 5 条≥90，时间上与奥氮平 20 mg/d（2/28 起始）及阿立哌唑起始重合。该观察仅为描述性时间关联（奥氮平/氯氮平类药物的自主神经效应在文献中有据），无因果归因价值，且未排除激动、焦虑等精神科原因。 <!-- claim:CLM-027 -->

以上推导全部以数据集观察与已保存全文为输入，方法与假设可复核；推导结果一律不进入"安全优先的实际处置"。

## 讨论

本论证整体确立的结论是：这份 n=5 的 TDM 数据集在约束下存在真实但有限的研究空间。它能做的，是与现有 AGNP/ASCP 共识框架[4]和 CYP2D6 药代遗传学证据[2][3]对接的"暴露变异与监测质量"分析；它不能做的，是任何疗效与因果推断。最能立即产出的是第一类方向——TDM 参考区间依从性、采样稳态合规率、医嘱—检验一致性（丙戊酸钠/碳酸锂有医嘱无结果[1]）三项指标组成的质量审计报告，这类研究在同类期刊上有先例（如 1979 例氯氮平 TDM 服务研究[7]、486 例奥氮平浓度—疗效研究[8]），且完全由现有字段支撑。第二类方向（C/D 与代谢比值推断 CYP2D6 代谢能力）科学价值更高，但被两个数据缺口约束：无采血/给药时刻（谷浓度假设不可验证）与无基因型（推断止于假说）[2][3]。

能够一锤定音、把假说变成结论的研究形态，不在当前约束内：需要扩大至 20–50 例以上的同源回顾性 TDM 数据库（记录采血时刻、给药时刻、吸烟状态），或对同一队列补充基因分型。换句话说，本数据集的最佳定位是"立项前的可行性试点"，其产出应作为更大回顾性研究的预试验与数据质量基线，而不是独立支撑一篇推断性论文。

## 证据局限

- **精密度与间接性（最关键）**：n=5、每种药物 1–6 条浓度，任何比例与均值的置信区间极宽；无采血时刻与给药时刻，稳态与谷浓度假设不可验证[1]；无吸烟、CRP、肝肾功能等混杂字段，个体化浓度解读（尤其氯氮平/奥氮平/阿立哌唑）的确定性受限[5][6]。
- **数据结构性缺口**：丙戊酸钠、碳酸锂的 TDM 医嘱无结果；1 例无阿立哌唑医嘱却有 63 ng/mL 浓度；体征表存在"126/7"类不完整血压记录与重复 CASE_NO 尾列[1]，必须先清洗。
- **证据形式与时点**：阿立哌唑浓度—疗效关联本身证据等级低且不一致[4]；本数据集数据时点为 2020–2021 年，参考框架为 AGNP 2017 版区间（2024 版共识已更新，但原文闭架未及核验，仅以摘要级记录存在）。
- **外部效度**：5 例均为单一中心住院患者，女性 4 例、年龄 21–56 岁，诊断覆盖精神分裂症谱系与双相障碍，结果不可外推。
- **发表偏倚与检索边界**：闭架全文（AGNP 2018、ASCP/AGNP 2020、Wesner 2023 等）未纳入 claim 载体，仅作背景；本报告的检索边界不构成"某方向无研究"的证明。

## 结论

1. **可以做（推荐优先级）**：①TDM 质量审计（参考区间依从性、稳态合规率、医嘱—检验完整性）；②C/D 与代谢比值的 CYP2D6 代谢能力假说生成（限稳态样本）；③多药联用浓度个案系列；④生命体征/体重轨迹描述性监测。前三项可作为同一篇回顾性论文的三个并列目标。
2. **不能做（必须向审稿人/伦理说明）**：组间疗效比较、浓度—疗效关联、PopPK 建模、基因型结论。
3. **安全性解释义务**：报告中凡出现氯氮平 >600 ng/mL、帕利哌酮超上限等数值，必须按浓度—效应阈值证据[6]解释为风险信号，而非疗效成就。

## 安全优先的实际处置

- 回顾性报告中解释氯氮平浓度时，须同时给出检验参考区间与浓度—效应阈值：>350 ng/mL 才与更高反应率相关，>600 ng/mL 与剂量依赖性不良反应率增高相关，本数据集 721 ng/mL 属后者区间[6] <!-- claim:CLM-014 -->。
- 在没有基因分型数据的条件下，不得将 C/D 比值或脱氢阿立哌唑/阿立哌唑代谢比值表述为"CYP2D6 表型"或"基因型结论"，只能描述为代谢能力代理指标的假说生成[3] <!-- claim:CLM-010 -->。
- 阿立哌唑平均消除半衰期约 75 h[2]；解读浓度前须确认样本距最近一次剂量调整≥约 5 个半衰期，未达稳态的样本（如 P216359 用药第 2 天采样）不得用于剂量—浓度关系解读[2] <!-- claim:CLM-030 -->。
- 解释氯氮平与奥氮平浓度必须声明吸烟状态缺失的影响——吸烟者 C/D 显著更低（奥氮平均值差 −0.75、氯氮平 −1.11 ng/mL per mg/day），无吸烟字段时个体化解读需加不确定性标注[5] <!-- claim:CLM-017 -->。
- 本数据集仅 5 例患者、22 条浓度[1]；任何报告必须把统计分析限于描述性统计与个案水平，并声明不适用于组间推断与因果结论[1] <!-- claim:CLM-001 -->。
- 丙戊酸钠、碳酸锂有化验医嘱而无检验结果，以及 1 例无阿立哌唑医嘱却有浓度的记录，必须作为数据完整性缺口处理并列入数据质量附录，不得改写为"浓度未达治疗范围"[1] <!-- claim:CLM-004 -->。

## 参考文献

1. 数据集. 20260803TDM.xlsx（病案首页/医嘱记录/检验/诊断记录/体征，5 张表；5 例患者、22 条 TDM 浓度、915 条医嘱、537 条体征、56 条诊断）. 用户提供，工作区文件 /workspace/20260803TDM.xlsx，2026-08-05 读取。
2. Kneller LA, Zubiaur P, Koller D, Abad-Santos F, Hempel G. Influence of CYP2D6 Phenotypes on the Pharmacokinetics of Aripiprazole and Dehydro-Aripiprazole Using a Physiologically Based Pharmacokinetic Approach. Clin Pharmacokinet. 2021;60(12):1569-1584. doi:10.1007/s40262-021-01041-x. PMID:34125422. URL:https://europepmc.org/articles/PMC8613074
3. Gras C, Piras M, Ranjbar S, Grosu C, Girardin FR, Vandenberghe F, Ansermot N, Grandjean C, Kaiser S, Gamma F, Plessen KJ, von Gunten A, Conus P, Crettol S, Eap CB. Influence of CYP2D6 Genotypes and Phenotypes on the Plasma Levels and Clinical Response to Aripiprazole. Schizophr Bull. 2025;52(2):sbaf076. doi:10.1093/schbul/sbaf076. PMID:40662264. URL:https://europepmc.org/articles/PMC12996889
4. Hart XM, Hiemke C, Eichentopf L, Lense XM, Clement HW, Conca A, Faltraco F, Florio V, Grüner J, Havemann-Reinecke U, Molden E, Paulzen M, Schoretsanitis G, Riemer TG, Gründer G. Therapeutic Reference Range for Aripiprazole in Schizophrenia Revised: a Systematic Review and Metaanalysis. Psychopharmacology (Berl). 2022;239(11):3377-3391. doi:10.1007/s00213-022-06233-2. PMID:36195732. URL:https://europepmc.org/articles/PMC9584998
5. Tsuda Y, Saruwatari J, Yasui-Furukori N. Meta-analysis: the effects of smoking on the disposition of two commonly used antipsychotic agents, olanzapine and clozapine. BMJ Open. 2014;4(3):e004216. doi:10.1136/bmjopen-2013-004216. PMID:24595134. URL:https://europepmc.org/articles/PMC3948577
6. Rafizadeh R, Sooch A, Risi A, Bihelek N, Kanegawa K, Barr AM, White RF, Schütz CG, Bousman CA. Impact of patient-specific factors on clozapine metabolism in individuals with treatment-resistant schizophrenia or schizoaffective disorder. J Psychopharmacol. 2024;38(6):526-535. doi:10.1177/02698811241241394. PMID:38520287. URL:https://europepmc.org/articles/PMC11179308
7. Kyllesø L, Smith RL, Karlstad Ø, Andreassen OA, Molden E. Absolute and Dose-Adjusted Serum Concentrations of Clozapine in Patients Switching vs. Maintaining Treatment: An Observational Study of 1979 Patients. CNS Drugs. 2021;35(9):999-1008. doi:10.1007/s40263-021-00847-4. PMID:34417726. URL:https://europepmc.org/articles/PMC8408068
8. Yuan M, Yuan BZ, Wu J. Analysis of the correlation between clinical efficacy and blood concentration of olanzapine in schizophrenia patients. Medicine (Baltimore). 2023;102(10):e32912. doi:10.1097/MD.0000000000032912. PMID:36897697. URL:https://europepmc.org/articles/PMC9997772
9. Zhang C, Jiang L, Hu K, Zhang YJ, Han J, Chen J, Dong B, Shi HZ, He SM, Yu TT, Chen X, Wang DD. Drug–drug interaction and initial dosage optimization of aripiprazole in patients with schizophrenia based on population pharmacokinetics. Front Psychiatry. 2024;15:1377268. doi:10.3389/fpsyt.2024.1377268. PMID:38957736. URL:https://europepmc.org/articles/PMC11217561
10. Hiemke C, et al. Consensus Guidelines for Therapeutic Drug Monitoring in Neuropsychopharmacology: Update 2017. Pharmacopsychiatry. 2018;51(1-02):9-62. PMID:28910830. URL:https://pubmed.ncbi.nlm.nih.gov/28910830/（摘要级，闭架）
11. Schoretsanitis G, et al. Blood Levels to Optimize Antipsychotic Treatment in Clinical Practice: A Joint Consensus Statement of the ASCP and the TDM Task Force of the AGNP. J Clin Psychiatry. 2020;81(3):19cs13169. PMID:32433836. URL:https://pubmed.ncbi.nlm.nih.gov/32433836/（摘要级，闭架）
12. Wesner K, Hiemke C, Bergemann N, et al. Therapeutic Reference Range for Olanzapine in Schizophrenia: Systematic Review on Blood Concentrations, Clinical Effects, and Dopamine Receptor Occupancy. J Clin Psychiatry. 2023;84(5). PMID:37471567. URL:https://pubmed.ncbi.nlm.nih.gov/37471567/（摘要级，闭架）
13. Suzuki T, Mihara K, Nakamura A, et al. Effects of the CYP2D6*10 allele on the steady-state plasma concentrations of aripiprazole and its active metabolite, dehydroaripiprazole, in Japanese patients with schizophrenia. Ther Drug Monit. 2011;33(2):256-258. PMID:21157400. URL:https://pubmed.ncbi.nlm.nih.gov/21157400/（摘要级，闭架）
14. Jukic MM, Smith RL, Haslemo T, et al. Effect of CYP2D6 genotype on exposure and efficacy of risperidone and aripiprazole: a retrospective, cohort study. Lancet Psychiatry. 2019;6(5):418-426. PMID:31000417. URL:https://pubmed.ncbi.nlm.nih.gov/31000417/（摘要级，闭架）
15. Hendset M, Hermann M, Lunde H, et al. Impact of the CYP2D6 genotype on steady-state serum concentrations of aripiprazole and dehydroaripiprazole. Eur J Clin Pharmacol. 2007;63(12):1147-1151. PMID:17828532. URL:https://pubmed.ncbi.nlm.nih.gov/17828532/（摘要级，闭架）
16. Zhang X, Xiang Q, Zhao X, et al. Association between aripiprazole pharmacokinetics and CYP2D6 phenotypes: A systematic review and meta-analysis. J Clin Pharm Ther. 2018;44(2):163-173. PMID:30565279. URL:https://pubmed.ncbi.nlm.nih.gov/30565279/（摘要级，闭架）
17. Molden E, Lunde H, Lunder N, et al. Pharmacokinetic variability of aripiprazole and the active metabolite dehydroaripiprazole in psychiatric patients. Ther Drug Monit. 2006;28(6):744-749. PMID:17164689. URL:https://pubmed.ncbi.nlm.nih.gov/17164689/（摘要级，闭架）
18. Patteet L, Maudens KE, Vermeulen Z, et al. Retrospective evaluation of therapeutic drug monitoring of clozapine and norclozapine in Belgium using a multidrug UHPLC-MS/MS method. Clin Biochem. 2014;47(15):60-64. PMID:25289972. URL:https://pubmed.ncbi.nlm.nih.gov/25289972/（摘要级，闭架）
