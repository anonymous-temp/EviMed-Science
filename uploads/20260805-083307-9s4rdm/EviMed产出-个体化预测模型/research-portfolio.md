# 研究组合（research portfolio）：住院 TDM 数据能否支撑个体化用药预测模型

## 0. 结论（先行）

**这份数据（5 例、6 份 TDM 血样）不能支撑任何"自建预测模型"——群体药动学建模、机器学习剂量预测、本地药物基因组学模型、浓度-结局关联，全部不可行，且缺的是结构件而非细节：采血时刻、给药执行记录、结局量表、基因型、以及 1–2 个数量级的样本量。它能支撑的只有一条路径：借用外部群体模型做个体贝叶斯（MAP）后验估计的演示性应用，以及基于剂量校正浓度（C/D）与参考区间位置的描述性质量审计。最小可行升级只需在现有流程上补 5 项（采血时刻、频率字典、给药执行记录、采样日实际剂量、稳态随访样本），之后先做外部模型外评+本地校准（≥30–50 例），积累到 100–200 例才有自建 PopPK 的资格。**

所有数字由 `data-profile.py` 产出（保留于本工作区，可复算，见 `data-profile.json`）。患者以化名 P1–P5 指代；源数据标识符不出现在任何产物中。

---

## 1. 研究问题与范围

原始问题：住院 TDM 数据集（病案首页/医嘱/检验/诊断/体征 5 表）能否支撑"个体化用药预测模型"？本研究范围限定为：(a) 个体化给药的建模路径盘点（PopPK+贝叶斯、MIPD、ML、PGx）；(b) 其他药物/领域做法向精神科 TDM 的可迁移性；(c) 小样本/稀疏采样路径；(d) 样本量与验证/报告规范；(e) 落地障碍；(f) 对本数据的逐条判定与补齐规模。

## 2. 检索与筛选方法（可复现）

- 工具：EviMed 文献适配器（PubMed 题录）、生物医学源连接器（europe-pmc、pubmed、dailymed）、openFDA 说明书检索、指南检索、开放全文抓取（Europe PMC/PDF）。
- 检索记录（全部查询、日期、命中数、来源标识符）：见 `scoping-run.json → searchRecord`。
- 纳入标准：个体化给药/精准给药的方法学与实证研究（抗精神病药、万古霉素、氨基糖苷、他克莫司、华法林、儿科、抗肿瘤）、预测模型样本量方法学（Riley 系列）、报告规范（TRIPOD+AI）、TDM 共识（AGNP）。优先全文级证据；仅得题录/摘要者明确标注"摘要级/题录级"。
- 全文已读（落盘于 `.evimed-sources/`）：TRIPOD+AI 述评（BMJ 2024）[23]、他克莫司 ML C0/D 预测 [13]、万古霉素 DeepTDM [14]、新生儿 β-内酰胺 ML CDSS [15]。
- 摘要级：氯氮平 PopPK 外评+贝叶斯预测 [3]、万古霉素儿科 MIPD [6]、CYP2D6×阿立哌唑暴露 [17][18]、Riley 系列 [20][21][22]、AGNP [1][2]、IWPC [8]、他克莫司模型系列 [10][11][12][32][33]、华法林 RCT [9] 等。
- 局限性：AGNP 2017 全文与几篇药动学期刊全文不可开放获取，其细节（如各药 TDM 推荐等级）未逐条核验；凡涉及其内容处仅引用可核验的区间/稳态判据。

---

## 3. 文献综合：五问

### 3.1 个体化给药预测的主流做法：数据结构、样本量、采样与协变量要求

**（1）群体药动学（PopPK）+ 贝叶斯个体化（MAP）。** 做法：用非线性混合效应模型从人群数据估计典型参数与个体间/残差变异，再以个体观测做最大后验（MAP）收缩估计。数据结构：每例完整剂量事件史（给药时间×剂量×途径）+ 1 个或多个浓度观测（带采血时刻）+ 协变量（体重、年龄、肾功能等）。规模：建模队列从 β-内酰胺儿科每药 100–188 例/165–780 观测 [15] 到阿立哌唑 LAI 的 1,123 例/13,985 观测；最小型实证（tiapride 儿科 PopPK+MAP）也要 38 例多时间点 [27]。每人采样：1–2 个设计良好的时点即可做个体 MAP（万古霉素儿科"中点单样本/双样本策略" [6][7]）；建模则需每人 ≥2–3 点。
**（2）模型指导的精准给药（MIPD）。** 做法：把 PopPK 模型封装成床旁软件（PrecisePK、Shiny、InsightRX、mwPharm 等），输入剂量史+观测做贝叶斯预测下一剂量。它是 (1) 的临床工程化，数据结构要求相同，另需软件与工作流。精神科先例：氯氮平外部评价 7 个已发表模型、53 例/151 样本外评，仅 1 个模型达标（中位预测误差 ≤±20%、中位绝对误差 ≤30%），贝叶斯预测显著改善表现 [3]；奥氮平 PBPK 个体暴露预测 [4]；多巴胺 D2 受体占有率+浓度的 MAP 联合建模 [25]（题录级）。
**（3）机器学习/统计学习剂量预测。** 做法：以协变量（临床+遗传）直接回归目标（稳态剂量、剂量校正谷浓度、下一时点浓度）。实证规模：他克莫司 C0/D 171 例开发+30 例外部验证（GBDT，R²=0.44）[13]；万古霉素序列 TDM 深度学习 727 例内部+3,653 例外部 [14]；新生儿 β-内酰胺 CDSS 以模拟数据训练（虚拟 2,569 例）+621 例真实世界验证 [15]；他克莫司稳定剂量 ML（Sci Rep 2017，见 [13] 引用）。共性：**无一例外需要数百至数千例，且必须有独立外部验证**；ML 对时间轴事件戳（给药-采血时刻）的依赖甚至强于 PopPK（GRU/序列模型 [14]）。
**（4）药物基因组学（PGx）指导给药。** 做法：基因型→代谢表型→剂量建议，规则由 CPIC/DPWG 等发布，**不需要本地建模数据**。实证：华法林 IWPC 算法 4,043 例推导+1,009 例验证 [8]；EU-PACT RCT 455 例 [9]；阿立哌唑为 CYP2D6 底物，PM 活性成分 C/D 为 NM 的 1.59 倍（1,334 例）[17]，FDA 说明书已载明 PM 剂量减半 [28]。数据结构：基因型字段 + 剂量/浓度；样本量用于"本地效应估计"而非"规则成立"。

### 3.2 其他药物/领域怎么做，哪些可迁移到精神科 TDM

| 领域 | 代表作（n） | 做法 | 迁移性到精神科 TDM |
|---|---|---|---|
| 万古霉素 | 儿科 MIPD 80 例/226 浓度 [6]；AUC 采样时机研究 [7]；方程 vs 贝叶斯模拟 [5] | 双样本/中点单样本贝叶斯 AUC 指导；稳态目标明确（AUC/MIC、谷 15–20） | **高**：采样-贝叶斯-再给药的闭环结构完全同构；但精神科缺"生物标志物结局"（无 MIC/病原），终点只能回到浓度达标 |
| 氨基糖苷 | 庆大/妥布霉素外部模型 MAP 评价 [31] | 外部模型+MAP 个体化；D-最优采样 | 高（方法同构） |
| 他克莫司 | 起始剂量 PopPK 模型成人 [11]/儿科 [33]；前瞻外评失败教训 [12]；ML 剂量 [13] | 移植早期 TDM，CYP3A5 基因型入模；外评+更新 | 中高：同为窄窗+个体差异大的精神科药物（氯氮平）已用同一套路 [3]；他克莫司"前瞻外评失败后改模型"的教训 [12] 直接适用于阿立哌唑 |
| 华法林 | IWPC 4,043+1,009 [8]；EU-PACT [9] | PGx 算法+INR 反馈 | **部分**：PGx 规则迁移容易（CYP2D6→阿立哌唑同构）；但华法林有 INR 这个即时生物标志物做闭环，精神科无 |
| 儿科 | β-内酰胺 CDSS [15]；万古霉素儿科 [6]；tiapride 38 例 [27] | 发育药动学（PMA/体重）+模拟训练+真实世界验证；唾液替代采血 | 中：发育协变量在精神科成年人群基本不适用；但"模拟训练+真实世界验证"与"外评+校准"的小样本策略可迁移 |
| 抗肿瘤 | 大剂量甲氨蝶呤清除延迟 ML [16]；放疗剂量预测 DL [34 引] | 事件预测/剂量分布预测 | 低-中：甲氨蝶呤靠"清除率+肾功能"即时监测闭环，精神科缺此类可连续监测的暴露结局 |

**不可迁移的根因**：抗菌/免疫抑制/抗凝领域都有**可即时、客观、连续测量的生物标志物终点**（MIC/AUC、INR、移植排斥生物标志物）支撑"暴露-靶点-结局"闭环；精神科 TDM 的终点是量表（主观、低频）或缺乏终点。因此这些领域的"贝叶斯闭环+CDSS"工程可迁移，其"结局驱动效果评价"不可迁移。

### 3.3 小样本/稀疏采样下成立的路径

- **外部模型作先验 + 个体贝叶斯拟合（MAP）**：成立，且是精神科先例——氯氮平外评中贝叶斯预测显著改善模型表现 [3]；万古霉素儿科用外部模型+1–2 个浓度做 AUC 指导 [6][7]；氨基糖苷外部模型 MAP 评价 [31]。**最低要求：每例 ≥1 个带时刻的稳态浓度 + 确定的剂量史（剂量事件时间）**；2 个观测显著收紧后验。
- **外评 → 本地校准/模型更新（Bayesian updating、metamodeling）**：氯氮平研究明确建议"用更新或元建模改善模型" [3]；他克莫司儿科"外评失败→模型改良"是同一循环 [12]；DeepTDM 用目标域 10% 数据微调即可跨人群提升 [14]。**最低要求：外部模型外评约需 30–50 例/100–200 观测**（氯氮平用了 53 例/151 观测 [3]）。
- **迁移学习/微调**：深度学习可行（10% 目标域数据 [14]），但 ML 路径总体需要千级基础数据，对精神科 TDM 短期不现实。
- **模拟训练+真实世界验证**（β-内酰胺 CDSS 模式 [15]）：把已发表 PopPK 模型当数据生成器，训练 ML 后再用少量真实数据验证——**这是当前数据规模下最值得借鉴的模板**，但需要院内真实数据 ≥100 例级验证集。

### 3.4 预测模型样本量与验证规范（Riley、TRIPOD+AI）

- **开发样本量**：Riley 连续结局判据（收缩 ≥0.9、表观 R² 与校正 R² 差 ≤0.05、残差 SD 与截距精度）——工作例：25 参数需 ≥918 例（36.7 例/参数）[20]；二分类/时间-事件结局有对应判据 [21]。本报告按此锚点给出：3 参数 ≥111 例、4 参数 ≥147 例、6 参数 ≥221 例、8 参数 ≥294 例（`planningQuantities`）。
- **外部验证**：二分类结局 ≥100 事件+100 非事件（面向校准精度）[22]；连续结局量级为数 百例。
- **报告规范**：TRIPOD+AI（2024）27 项/52 子项+12 项摘要清单 [23]；随访研究有 TRIPOD-AI/PROBAST-AI 工具与依从性评估 [29]。建模前需预先备好：数据来源与缺失处理、样本量计算依据（Riley 判据）、内部验证方案（交叉验证/自助法）、校准曲线与指标（如 ICI/E50）、外部验证计划、模型公式/代码与公平性说明。**本数据在任何一条上都不满足模型开发类申报**。
- **STROBE item 10**：固定数据集如实写"样本量由现有数据决定"，并附 MDE 与预期区间宽度（见 5.1），**不做基于观测数据的效能回算**。

### 3.5 这类模型落地时真正卡在哪

证据综合（外评文献 + 实施研究）：
1. **采血时刻缺失/不精确**：万古霉素 AUC 估算对采样时机极敏感，专门的"最优采样时间"研究说明其代价 [7]；本数据连时刻都没有。
2. **给药执行 vs 医嘱**：医嘱≠执行。本数据无执行记录；氨溴索/万古霉素定性评价亦见"数据采集负担"障碍 [30]。
3. **依从性**：精神科口服药依从性差是浓度不确定性的主源之一；无依从性变量则浓度被系统性误读。
4. **结局定义**：精神科无即时生物标志物；缺结局使 MIPD 只能停在"浓度达标"。
5. **部署与再校准**：模型发布后需持续外评与更新（氯氮平外评结论 [3]、他克莫司前瞻外评失败 [12]）；院内 IT 接口、药师工作流、软件成本（万古霉素儿科 MIPD 明确把"软件成本"列为中低收入国家障碍 [6]）。

---

## 4. 本数据能支撑什么（逐条判定）

### 4.1 可行（描述性审计）：C/D 分布 + 参考区间位置 + 稳态达标审计（问题 F/G）

- 科学问题：本机构阿立哌唑 TDM 的剂量校正浓度分布、参考区间位置、稳态采样达标率如何，相对文献/共识是否异常。
- 变量构建：C/D = 浓度（总阿立哌唑/母药，ng/mL）÷ 采样日日剂量（mg/日，解码区间化，见预处理清单 1–2）；区间位置按 `REFFR_SCOPE`（已对照 AGNP 一致）；稳态按"同剂量 ≥14 天"（阿立哌唑 ~5×t½≈2 周；FDA 说明书同剂量调整间隔 ≥2 周 [28]）。
- 设计：描述性、单中心、回顾性；不做因果声明；全部统计量由脚本产出（`data-profile.json → domainQuantities`）。
- **MDE/精度（脚本规划量）**：个体 C/D 的 95% 预测区间宽度受人群 CV 支配——CV=0.4 时约 4.5–4.9 倍（n 再大也不收窄，`predictionIntervalForCdAudit`）。因此本审计只报告分布与区间位置，**明确不报告个体预测值**。样本量如实写"6 份样本、5 例（P1–P5）、4 例可归一化"。
- 偏倚与处理：频率解码歧义 → 剂量与 C/D 以区间呈现并做敏感性分析；非稳态样本 → 单独分层；P2 无剂量 → 排除于 C/D 分析并说明。
- 外部对照：AGNP 参考区间 [1]、阿立哌唑 100–350 [26]、CYP2D6 效应锚点 1.59 倍 [17]、代谢物/母药比参照 [19]。
- 发表定位：科室 TDM 质量报告/方法学演示（不做模型开发声明）；可投稿对象：TDM/药学服务类期刊的短报或会议摘要。

### 4.2 有条件可行（演示性应用，非开发/验证）：外部模型 + 个体 MAP 后验（问题 A）

- 做法：选用已发表且**先外评达标**的阿立哌唑/氯氮平 PopPK 模型（外评达标是前提，氯氮平 7 个模型仅 1 个达标 [3]），对每例输入剂量史+1–2 个浓度，输出个体清除率后验与下一剂量建议。
- 现数据可跑通 4 例（P1 两样本、P3/P4/P5 各一样本）；P2 因面板-医嘱不一致剔除；P1 4/1 为唯一稳态样本。
- **限制**：无采血时刻 → 观测时间轴只能按日期近似，后验区间宽；必须输出后验区间而非点值；不得自称验证或临床决策依据。
- 需要先完成预处理清单 1–9；外部模型适用性（吸烟、合并用药如 CYP2D6 抑制剂）需个案说明。

### 4.3 不可行（具名缺失字段 + 补齐规模）

| 路径 | 判定 | 缺失字段（具名） | 需补到的规模 |
|---|---|---|---|
| 自建 PopPK 模型（问题 B） | 不可行 | 患者数、每人 ≥2–3 次带时刻采样、稳态采样保证、给药执行时间戳、采血时刻 | ≥100–200 例 × 2–3 稳态样本/例（对照 [15] 每药 100–188 例；[27] 38 例为下限）；协变量：体重、吸烟、合并用药、基因型 |
| ML/统计学习剂量预测（问题 C） | 不可行 | 开发队列规模、独立外部验证队列、事件时间戳（给药-采血网格） | 开发 ≥数百例（对照 [13] 171+30、[14] 727+3,653、[15] 虚拟 2,569+真实 621）；Riley 锚点 3–6 参数 ≥111–221 例 [20]；外部验证 ≥100 例级 [22] |
| PGx 本地建模（问题 D） | 不可行（规则可外部套用） | CYP2D6/CYP3A4 基因型字段 | 本地效应估计 ≥25–50 例/基因型组（MDE 1.36–1.24 倍，CI 宽度 1.53–1.35，见规划量表）；套用 CPIC/DPWG/FDA 规则则**零样本需求**，只需基因型检测 |
| 浓度-结局关联（问题 E） | 不可行 | 结局量表（疗效如 PANSS/CGI、ADR 如 UKU-SERS）、事件时间戳、执行剂量 | 每结局 ≥10 事件/参数；前端需前瞻结局采集 |
| 依从性-浓度（问题 H） | 不可行 | 给药执行/依从性记录、采血时刻 | 依从性数据随执行记录一并补 |

---

## 5. 最小可行升级路径（在现有采集流程上）

**结论先行：只需补 5 项，其中 2 项零成本。**

1. **采血时刻**：检验表 `TEST_DATE` 补时间（LIS 本就有，导出时带出）——零成本；否则一切 MIPD/贝叶斯分析不可做。
2. **频率字典化**：把 `FREQUENCY` 30 个取值（含 `BID4`/`QD16`/`W4D8`）与 HIS 字典对照落表；否则日剂量是区间，C/D 差 2 倍。
3. **给药执行记录**：导出护理给药勾选/发药记录（每次实际服药时间与剂量）——需 HIS 配合；否则"医嘱≠执行"，浓度无法解释。
4. **采样日剂量快照**：TDM 申请单增加"当日实际剂量 + 上次给药时刻 + 是否稳态（同剂量≥14天）"三字段——零成本表单项。
5. **稳态随访采样**：对达到稳态的患者加采 1 次（3–5 天后），使每人 ≥2 个观测——流程成本低，收益（后验收缩）大。

**升级后的路线图**：
- 第 0 阶段（现在，5 例）：描述性审计（4.1）+ 外部模型 MAP 演示（4.2）。
- 第 1 阶段（≥30–50 例、含 ≥2 次采样者）：外部模型**外评 + 本地校准**（氯氮平外评规模 53 例/151 观测 [3]；万古霉素儿科 80 例/226 浓度 [6]）——这是"外部先验 + 少量本地数据"路径的最低可信规模。
- 第 2 阶段（≥100–200 例、每人 2–3 个稳态样本）：可尝试自建 PopPK（仍须外部验证）；ML 路径建议用"模拟训练+真实世界验证"模板 [15] 而非直接自建。
- PGx（路径 D）：独立于上述规模，随时可在流程中加 CYP2D6 检测并按 FDA/CPIC 规则减量（PM 减半 [28]）。

---

## 6. 不可报告性检查（发布前必须满足）

- **RECORD 6.2**（诊断/暴露代码需引用验证研究）：本数据 `MAIN_DIAGNOSIS_CODE` 为 ICD-10 风格但无编码验证引用；`OUTP_DIAGNOSIS_CODE` 含本地码（BNG/BNX）无映射——以"数据库队列研究"申报不可行。
- **RECORD 7.1**（暴露/结局/混杂完整代码清单）：暴露（用药）无执行记录，无法提供完整暴露清单。
- **RECORD-PE 7.1.c / 19.1.a**（暴露时间窗与数据库暴露捕获完整性）：时间窗无法对齐（无时刻），暴露捕获不完整——不满足。
- **TRIPOD+AI 27 项** [23]：模型开发类研究（B/C）在"样本量（Riley 判据）""缺失处理""外部验证"等条目上直接不达标，**不可按预测模型研究报告**。
- 审计类研究（F/G）按 STROBE 报告：item 10 写"样本量由现有数据决定"，附 MDE 与预期区间宽度（见 4.1），不做基于观测数据的效能回算。

---

## 7. 不确定性、证据层级与仍需人工复核之处

- **证据层级**：本报告的方法学判据（Riley、TRIPOD+AI）为高确定性；跨领域实证（万古霉素/他克莫司/华法林/儿科）为中等确定性（多为单中心回顾）；精神科 MIPD 的直接证据较薄（氯氮平外评 [3] 为唯一精神科贝叶斯外评实证，摘要级）。AGNP 全文未开放，各药 TDM 推荐等级未逐条核验。
- **仍需人工复核**：① `FREQUENCY` 各编码的院内真义（HIS 字典）；② 浓度单位（推断 ng/mL）与 `REFFR_SCOPE` 口径；③ P2 样本的检验面板-医嘱不一致原因（LIS 追溯）；④ 脱氢阿立哌唑无参考区间的解读；⑤ 检验表 3 个空列名与 1 个未命名数值列的来源；⑥ `OUTP_DIAGNOSIS_CODE` 本地码映射。
- **数据侧的硬约束**：即使补到 100–200 例，阿立哌唑的 CYP2D6 多态性 [17][18]、CYP2D6 抑制剂性合并用药（如本数据中帕利哌酮）[19] 造成的个体间差异，只有在基因型与合并用药字段齐备后才能被模型吸收——缺这两类字段，再大的样本也只能得到"人群平均"模型。

---

## 8. 参考文献

1. Hiemke C, et al. Consensus Guidelines for Therapeutic Drug Monitoring in Neuropsychopharmacology: Update 2017. Pharmacopsychiatry 2018;51:9–62. PMID:28910830. https://pubmed.ncbi.nlm.nih.gov/28910830/
2. Hart XM, et al. Consensus Guidelines for TDM in Neuropsychopharmacology: Update 2026. Pharmacopsychiatry 2026. PMID:42392224. https://pubmed.ncbi.nlm.nih.gov/42392224/
3. Lereclus A, et al. Towards Precision Dosing of Clozapine in Schizophrenia: External Evaluation of Population Pharmacokinetic Models and Bayesian Forecasting. Ther Drug Monit 2022. PMID:35385439. https://pubmed.ncbi.nlm.nih.gov/35385439/
4. Polasek TM, et al. Prediction of olanzapine exposure in individual patients using physiologically based pharmacokinetic modelling and simulation. Br J Clin Pharmacol 2018. PMID:29194718. https://pubmed.ncbi.nlm.nih.gov/29194718/
5. Aljutayli A, et al. Pharmacokinetic equations versus Bayesian guided vancomycin monitoring. Clin Transl Sci 2022. PMID:35170243. https://pubmed.ncbi.nlm.nih.gov/35170243/
6. Hai Le B, et al. Model-Informed Precision Dosing of Vancomycin in Vietnamese Children: Innovative Midpoint Concentration Monitoring Using 2 Bayesian Programs. Ther Drug Monit 2025. PMID:40152654. https://pubmed.ncbi.nlm.nih.gov/40152654/
7. Yamamoto T, et al. Optimal Blood Sampling Time for Area under the Concentration-Time Curve Estimation of Vancomycin. Biol Pharm Bull 2024. PMID:39647905. https://pubmed.ncbi.nlm.nih.gov/39647905/
8. International Warfarin Pharmacogenetics Consortium. Estimation of the warfarin dose with clinical and pharmacogenetic data. N Engl J Med 2009;360:753–64. PMID:19228618. https://pubmed.ncbi.nlm.nih.gov/19228618/
9. Pirmohamed M, et al. A randomized trial of genotype-guided dosing of warfarin (EU-PACT). N Engl J Med 2013;369:2294–303. PMID:24251363. https://pubmed.ncbi.nlm.nih.gov/24251363/
10. Francke MI, et al. A Population Pharmacokinetic Model and Dosing Algorithm to Guide the Tacrolimus Starting and Follow-Up Dose. Clin Pharmacokinet 2025. PMID:40588615. https://pubmed.ncbi.nlm.nih.gov/40588615/
11. Andrews LM, et al. A population pharmacokinetic model to predict the individual starting dose of tacrolimus in adult renal transplant recipients. Br J Clin Pharmacol 2019. PMID:30552703. https://pubmed.ncbi.nlm.nih.gov/30552703/
12. Andrews LM, et al. A Population Pharmacokinetic Model Does Not Predict the Optimal Starting Dose of Tacrolimus in Pediatric Renal Transplant Recipients in a Prospective Study: Lessons Learned. Clin Pharmacokinet 2020. PMID:31654367. https://pubmed.ncbi.nlm.nih.gov/31654367/
13. Mo X, et al. Prediction of Tacrolimus Dose/Weight-Adjusted Trough Concentration in Pediatric Refractory Nephrotic Syndrome: A Machine Learning Approach. Pharmgenomics Pers Med 2022;15:249–61. PMC8881964. https://europepmc.org/articles/PMC8881964
14. Park J, et al. DeepTDM: Deep Learning-Based Prediction of Sequential Therapeutic Drug Monitoring Levels of Vancomycin. IEEE J Transl Eng Health Med 2025;13. PMC12599904. https://europepmc.org/articles/PMC12599904
15. Tang BH, et al. Optimal use of β-lactams in neonates: machine learning-based clinical decision support system. EBioMedicine 2024;105:105221. PMC467072. https://europepmc.org/articles/PMC467072
16. Zhan M, et al. Risk prediction for delayed clearance of high-dose methotrexate in pediatric hematological malignancies by machine learning. Int J Hematol 2021. PMID:34170480. https://pubmed.ncbi.nlm.nih.gov/34170480/
17. Jukic MM, et al. Effect of CYP2D6 genotype on exposure and efficacy of risperidone and aripiprazole: a retrospective, cohort study. Lancet Psychiatry 2019;6:418–26. PMID:31000417. https://pubmed.ncbi.nlm.nih.gov/31000417/
18. Tveito M, et al. Impact of age and CYP2D6 genetics on exposure of aripiprazole and dehydroaripiprazole. Eur J Clin Pharmacol 2020;76:73–83. PMID:31637453. https://pubmed.ncbi.nlm.nih.gov/31637453/
19. Phenoconversion of CYP2D6 by inhibitors modifies aripiprazole exposure. Eur J Clin Pharmacol 2019. PMID:30604050. https://pubmed.ncbi.nlm.nih.gov/30604050/
20. Riley RD, et al. Minimum sample size for developing a multivariable prediction model: Part I – Continuous outcomes. Stat Med 2019;38:1262–75. PMID:30347470. https://pubmed.ncbi.nlm.nih.gov/30347470/
21. Riley RD, et al. Minimum sample size for developing a multivariable prediction model: Part II – binary and time-to-event outcomes. Stat Med 2019;38:1276–96. PMID:30357870. https://pubmed.ncbi.nlm.nih.gov/30357870/
22. Riley RD, et al. Minimum sample size for external validation of a clinical prediction model with a binary outcome. Stat Med 2021;40:4230–51. PMID:34031906. https://pubmed.ncbi.nlm.nih.gov/34031906/
23. Cohen JF, Bossuyt PMM. TRIPOD+AI: an updated reporting guideline for clinical prediction models. BMJ 2024;385:q824.（并见主文 Collins GS, et al. BMJ 2024;385:e078378）PMID:38626949. https://pubmed.ncbi.nlm.nih.gov/38626949/
24. Collins GS, et al. Protocol for development of a reporting guideline (TRIPOD-AI) and risk of bias tool (PROBAST-AI). BMJ Open 2021;11:e048008. PMID:34244270. https://pubmed.ncbi.nlm.nih.gov/34244270/
25. Ismail M, et al. MAP Bayesian modelling combining striatal dopamine receptor occupancy and plasma concentrations to optimize antipsychotic dose regimens. Br J Clin Pharmacol 2022. PMID:35112390. https://pubmed.ncbi.nlm.nih.gov/35112390/
26. TDM-VIGIL: Therapeutic drug monitoring in children and adolescents … treated with aripiprazole. J Neural Transm 2025. PMID:39487894. https://europepmc.org/article/MED/39487894
27. Population Pharmacokinetics of Tiapride in Children and Adolescents with Tic Disorders. Drug Des Devel Ther 2026. PMID:42052103. https://europepmc.org/article/MED/42052103
28. FDA Aripiprazole tablet label（DailyMed，2026-03-05 版）. https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=02a4af27-c83c-4166-950c-7a1cb12d198d
29. de Kanter E, et al. Adherence to TRIPOD+AI guideline: an updated reporting assessment tool. J Clin Epidemiol 2026. PMID:41448505. https://pubmed.ncbi.nlm.nih.gov/41448505/
30. Kinnaer LM, et al. A qualitative process evaluation of a clinical trial on bedside model-informed precision dosing of vancomycin in critically ill children. Int J Clin Pharm 2026. PMID:41854777. https://pubmed.ncbi.nlm.nih.gov/41854777/
31. Duong A, Marsot A. Nlmixr2 Versus NONMEM: MAP Bayesian Estimates Following External Evaluation of Gentamicin and Tobramycin Population Pharmacokinetic Models. Clin Pharmacol Drug Dev 2024. PMID:38465725. https://pubmed.ncbi.nlm.nih.gov/38465725/
32. Schagen MR, et al. Individualized dosing algorithms for tacrolimus in kidney transplant recipients: current status and unmet needs. Expert Opin Drug Metab Toxicol 2023. PMID:37642358. https://pubmed.ncbi.nlm.nih.gov/37642358/
33. Khamlek K, et al. Population pharmacokinetic models of tacrolimus in paediatric solid organ transplant recipients: a systematic review. Br J Clin Pharmacol 2024. PMID:37714740. https://pubmed.ncbi.nlm.nih.gov/37714740/
34. Altynova S, et al. Artificial Intelligence and Predictive Modelling for Precision Dosing of Immunosuppressants in Kidney Transplantation. Pharmaceuticals 2026;19:165. PMID:41599762. https://pubmed.ncbi.nlm.nih.gov/41599762/
