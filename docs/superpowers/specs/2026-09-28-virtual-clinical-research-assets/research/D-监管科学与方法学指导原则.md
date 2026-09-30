# D — 监管科学与方法学指导原则（面向「虚拟临研」产品设计）

> 研究日期：2026-09-28 · 范围：监管科学与方法学（不含法律、隐私、伦理审查等合规内容）· 版本：v0.9（第 2.4、3 节在最后核实中）
> 读法：每条给出「状态 + 日期」→「对产品的要求」→「影响模块」。方括号数字为第 5 节出处编号；「未核实」表示未取得可靠出处。
> 核实方式：ICH/FDA/EMA 条目的状态均直接读取监管机构页面或原文 PDF（ICH 原文、FDA 指南页“Draft/Final”标记与“Content current as of”日期、EMA 文件封面的采纳日期）。

## 1. 结论先行

1. **监管口径已统一为“问题—使用情境—模型风险—可信度证据”，不存在“模型获批”这一状态。** ICH M15 于 2026-01-29 达到 Step 4，FDA 2026-06 发布定稿版，FDA MIDD 配对会议的申请材料清单已列入 M15 评估表[1][2][4][30]；FDA AI 可信度 7 步框架仍是 2025-01 草案[18]；EMA AI 反思文件 2024-09-09 采纳[36]；FDA–EMA 2026-01 联合发布 10 条良好 AI 实践原则[20]；CDRH 采纳 ASME V&V 40 的计算建模可信度指南 2023-11 定稿[32]。→ **「模型与验证」为每个模型发布建立“可信度档案”（QOI、COU、模型影响、错误决策后果、模型风险、模型偏离度、技术标准、证据、充分性结论），按第 4.7 节 R0–R3 分级；取消任何“已验证/监管级”徽章。**
2. **“先冻结、后接触结局”是所有文件的共同底线，而且要能被证明。** FDA 外部对照草案要求方案与 SAP 在试验开始前定稿、SAP 决策对外部对照结局“保持盲态”（可行性分析除外），并建议对数据源的访问与分析生成审计追踪[17]；EMA 单臂试验反思文件要求所有分析在首例入组前写入 SAP[37]；M15 要求 MAP 在“接触数据或执行分析之前”定义[2]；EMA AI 反思文件要求关键试验在揭盲前冻结数据预处理管线与全部模型，否则结果视为事后分析[36]。→ **平台记录两个不可篡改的时间戳——“分析计划冻结”与“结局字段首次被访问”，并把全部数据源检索、可行性分析与取舍理由写入审计追踪；报告首页自动显示两者先后。**
3. **外部对照：FDA 仍为 2023-02 草案**（FDA 页面 2026-09 仍标 Draft）[16]；EMA 单臂试验反思文件 2024-09-09 定稿[37]；CDE 以真实世界证据系列与 2026 年贝叶斯外部信息借用指导原则覆盖（见 2.4）。→ **「合成对照」的“外部对照”路线内置 FDA 列出的 10 个可比性维度（时期、地域、诊断、预后、治疗、其他治疗相关因素、随访、伴发事件、结局、缺失数据）的逐项评估表，外加 E10 适用情境自检，二者都是提示而非拦截。**
4. **估计目标（E9(R1)，ICH 2019-11 Step 4，FDA 2021-05 定稿）是四个研究模块的共同骨架**[5][6]；ICH M11 结构化方案（Step 4 2025-11-19）把“目标—终点—估计目标”固化为方案章节[13]。→ **统一的 Estimand 对象贯穿方案、队列、对照与模拟；外部数据必须与目标试验逐字段对齐，敏感性分析（同一估计目标、不同假设）与补充分析分开登记。**
5. **贝叶斯借用已有中美专门文件**：FDA 2026-01 草案[21]、CDE 2026 年第 6 号试行指导原则（见 2.4）。共同要求：所有相关信息构建先验并评价数据质量、预先设定决策准则、处理先验—数据冲突、以模拟评估运行特征。→ **「混合对照」的“借用计划”对象：先验来源与纳排理由、静态/动态借用方法、先验有效样本量（动态借用时标注“随数据变化，仅作参考”）、分析先验与设计先验、漂移范围内的一类错误曲线、临界点分析、收敛诊断。**
6. **模拟报告有成文清单**：FDA 复杂创新设计（2020-12 定稿）与适应性设计（2019-11 定稿）指导原则、ICH E20（2025-06 Step 2 草案）[23][24][8][9]。FDA 适应性设计指南逐项列出模拟报告内容：设计总述、示例试验、情景参数配置及其充分性论证、每个情景的迭代次数及理由（10 万次可使一类错误估计的 95% 置信区间约为 ±0.1%）、各情景运行特征、带随机种子的可读代码（最好附通用统计语言的可运行版本）、总结结论[24]。→ **「虚拟试验」的模拟报告按这一清单自动生成，并补上 CID 要求的先验敏感性、DMC 决策规则与数据访问限制计划。**
7. **PROCOVA 的监管范围很窄**：EMA 2022-09-15 资格认定意见限于“随机对照、连续终点、以独立历史数据训练的预后评分做 ANCOVA 主分析”，且不认可模型开发步骤本身[35]；FDA 2024-01 答复认为其“不偏离”协变量校正指导原则，但提醒据此缩减样本量可能过于乐观[39][29]。→ **“随机试验预后校正”路线只对连续终点给出主分析模板，二分类/生存终点标为研究性；必须比较三条路径（不校正、常规 ANCOVA、预后评分），样本量折减须含“过度乐观”折扣与敏感性分析。**
8. **药物领域没有监管机构接受“模型生成的对照组”替代同期对照作为关键证据。** FDA 仅在 AI/ML 讨论文件（2023-05，2025-02 修订）中把患者数字孪生称为“可能用于临床研究的新兴方法”[33]；已被接受的 in silico 证据集中在器械仿真、非临床毒理预测工具（ISTAND 2026-06 接受首个 in silico 药物研发工具）、PBPK/给药方案建模与 PROCOVA 式效率提升（第 3 节）[31]。→ **“模型比较器”默认 COU 为“探索/设计支持”，报告中称“模型预测比较器”，不得称“对照组”；模型输出与观察数据在图表中分层显示。**
9. **审计追踪与系统验证已有硬参照。** ICH E6(R3) 2025-01-06 Step 4（附件 2 于 2026-06-03 Step 4），FDA 2025-09 定稿；E6(R3) 4.2.2 要求记录账户/角色/访问日志、每次数据变更及原因、工作流动作，审计追踪不得关闭、时间戳用 UTC 等无歧义格式；4.3.4 要求按风险验证系统（含由他方开发的系统）并保存验证文档[10][11][12]。中国 2026 版 GCP 2026-09-01 施行、新增数据治理专章（见 2.4）。→ **执行快照不可变、全量审计追踪可导出、平台提供“系统验证文档包”（需求—测试—变更控制—数值基准结果）供客户纳入其计算机化系统验证。**
10. **中国路径的产品抓手**：CDE 真实世界证据系列与沟通交流指导原则、罕见病自然史、贝叶斯借用、中药“三结合”与人用经验、海南乐城试点（见 2.4）。→ **一键导出“CDE 沟通交流资料包”（必要性与可行性、数据适用性评价、方案与 SAP、偏倚控制与敏感性分析），并为中药人用经验提供结构化数据整理模板。**

## 2. ICH / FDA / EMA / NMPA-CDE

### 2.1 ICH

| 文件 | 状态与日期 | 对产品的要求 | 影响模块 |
|---|---|---|---|
| **E9(R1)** 估计目标与敏感性分析 | Step 4：2019-11-20[5]；FDA 定稿 2021-05[6]；NMPA 适用情况见 2.4 | ① Estimand 五属性结构化字段：治疗条件、人群、变量（终点）、伴发事件及处理策略、群体层面汇总指标；② 伴发事件策略枚举（治疗策略、假想、复合变量、在治疗期间、主层）并逐条说明理由；③ 缺失数据与伴发事件分开处理；④ 敏感性分析针对同一估计目标改变假设，补充分析另列；⑤ 外部对照/模型比较器须证明与目标试验同一估计目标（后续治疗、换药、死亡等处理一致） | 合成对照、虚拟试验、虚拟队列、方案 |
| **E10** 对照组选择 | Step 4：2000-07-20（现行版本）[7] | ① “无法控制偏倚是外部对照试验公认的主要局限”，因此仅限于疗效显著（dramatic）、病程高度可预测、终点客观、基线与治疗变量对终点的影响已充分认识的情形；② 其说服力依赖比同期对照更极端的统计显著性和更大的效应差异；③ 未治疗的历史对照往往结局更差（选择偏倚），外部对照常为回顾性选定；④ 应选有患者级详细数据的对照；⑤ 可与随机撤药期等设计组合以部分恢复随机与盲法 → 产品提供“E10 适用情境自检”（预期效应量相对历史变异、终点客观性、病程可预测性、预后因素可得性、是否可加随机成分），结论写入报告“局限性”，不拦截 | 合成对照、虚拟试验 |
| **M15** 模型引导药物研发一般原则 | Step 2：2024-11；**Step 4：2026-01-29**[1][2]；FDA 定稿指南（联邦公报 2026-06-03）[3][4] | ① 评估表六项关键要素：问题（QOI）、使用情境（COU）、模型影响（低/中/高）、错误决策后果（低/中/高）、模型风险（二者组合，低/中/高）、**模型偏离度（Model Impact：该策略偏离现行监管标准的程度）**，每项须给出评级理由；② 规划阶段补充“技术标准”与“适当性”，提交阶段补充“模型评估结论”与“证据评估结论”；③ 模型评估＝验证（代码无误、方程与实现一致、计算准确）+ 确认与适用性评估（数据、概念形式、假设、诊断、外部验证；适用性针对每一用途）；④ MAP 在接触数据或执行分析前预定义；MAR 记录结果、解释与评估；⑤ 评估强度与模型风险相称；⑥ 方法范围明确含疾病进展模型、基于主体的模型、AI/ML、模型化荟萃分析、QSP；⑦ 每个 QOI 单独一张评估表 | 模型与验证、虚拟患者、虚拟试验、报告 |
| **E20** 适应性设计 | Step 2：2025-06；EU 征询 2025-06-30 至 2025-11-30，意见汇总 2026-02-16 发布，EMA 页面 2026-09 仍为 Step 2b[8]；FDA 草案联邦公报 2025-09-30[9] | 仅针对确证性试验：① 适应规则、期中时点与决策准则预先规定；② 一类错误控制与估计偏倚评估（通常需模拟）；③ 期中结果访问控制与试验完整性；④ 模拟报告与方案/SAP 一并提交 | 虚拟试验 |
| **E6(R3)** GCP（仅计算机化系统与数据完整性） | 原则+附件 1：Step 4 2025-01-06，EU 2025-07-23 生效，FDA 定稿 2025-09；附件 2（去中心化、实用性要素、RWD）：Step 4 2026-06-03，EU 2027-01-15 生效；合并版 2026-06-16[10][11][12] | ① 账户创建、角色权限变更与用户访问日志（4.2.2）；② 初始录入及其后每次修改/删除可追溯并记录原因；③ 记录工作流动作；④ 审计追踪、报告和日志不得关闭，可解读、可审阅；⑤ 时间戳无歧义（如 UTC）；⑥ 数据更正可归因、有理由（4.2.4）；⑦ 数据传输/迁移经验证或对账（4.2.5）；⑧ 系统按风险验证，含标准功能、配置与计算、接口，变更受控，保存验证文档（4.3.4）；⑨ 揭盲信息的访问角色与任何非计划揭盲须记录（4.1）；⑩ 附件 2 §3.4.1：试验中使用的 RWD 须“适合目的”（相关且可靠），核查力度与数据关键性相称——支持关键疗效/安全终点时仅评估数据源可能不够，需能回到源记录确认事件是否发生、是否被评估与记录；探索性用途可做系统/流程层面评估，并在方案中写明局限；提取、链接、转换各步均须受监督 | 全平台：执行账本、快照、审计、报告；数据与证据 |
| **M11** CeSHarP 结构化方案 | Step 4：2025-11-19（指南+模板+技术规范）[13][14]；FDA 定稿（联邦公报 2026-05-22，二手来源）[15] | ① 方案对象按 M11 模板章节建模：第 3 章“试验目标及相关估计目标”、4.2.1“估计目标的理由”、第 5 章“试验人群”（入排标准）、10.4.1.2/10.4.1.3“与主要估计目标相关的数据处理/缺失数据处理”，且主要估计目标的变更被列为方案修订类别；② 修订生成新版本并保留差异与生效范围；③ 输出可交换的结构化方案（v1.0 已规划对齐 CDISC USDM）；④ 结构化入排标准同时供匹配与队列使用 | 方案与试验先例、患者匹配、虚拟队列 |

### 2.2 FDA

| 文件 | 状态与日期 | 对产品的要求 | 影响模块 |
|---|---|---|---|
| **外部对照试验设计与实施考虑**（ECT） | **草案**，2023-02；FDA 页面截至 2026-09 仍为 Draft（内容日期 2023-01-31）[16] | ① 试验开始前定稿方案，含外部对照选择与分析方法，而非单臂结束后再挑外部对照；② SAP 在入组前提交，且设计与 SAP 决策须对已观察到的外部对照数据保持盲态（可行性分析除外），分析期间不鼓励修改 SAP；③ 记录设计时访问过的全部数据源、可行性与探索性分析结果、取舍理由，证明最终数据集“不是为了有利结果而选”，并建议生成数据访问与分析的审计追踪；④ 可比性 10 维度（时期、地域、诊断、预后、治疗、其他治疗相关因素、随访、伴发事件、结局、缺失数据）；⑤ 索引日期（时间零点）两组一致，避免不朽时间偏倚；⑥ 必要时对外部数据结局做盲态再评估；⑦ 上市申请须提交患者级数据并保证 FDA 可访问源数据；⑧ 自然史理解不足或病程变异大时不适合[17] | 合成对照、数据与证据、虚拟队列 |
| **AI 支持监管决策的考虑** | **草案**，2025-01（FDA-2024-D-4689）；页面截至 2026-09 仍为 Draft[18] | 7 步：①定义问题；②定义 AI 模型 COU；③评估模型风险＝模型影响×决策后果；④制定可信度评估计划（模型与开发过程、开发数据、训练、评估含测试数据独立性、性能指标、不确定性、局限），早期沟通至少含第 1–3 步；⑤执行；⑥记录结果与偏差；⑦判定对 COU 是否充分；另设生命周期维护（性能监测、变更管理）。**范围不含药物发现和不影响患者安全、药品质量或研究结果可靠性的“运营效率”用途（如起草申报文件）**[19] → 产品中 LLM 起草类功能在范围外；预后模型、资格判定模型若影响研究结果则在范围内 | 模型与验证、患者匹配、虚拟患者 |
| **FDA–EMA 药物研发良好 AI 实践指导原则** | 2026-01 联合发布，10 条原则（非正式指南）[20] | 10 条：以人为本、风险为本（按 COU 与模型风险相称地验证与监督）、遵循标准（含 GxP）、明确 COU、多学科、数据治理与文档（数据来源、处理步骤与分析决策可追溯可验证）、模型设计与开发规范、风险为本的性能评估（**评估完整系统，包括人机交互**）、生命周期管理（定期监测与再评估，应对数据漂移）、清晰的关键信息 → AI 组件（LLM 提取、ML 预测）与确定性统计引擎分开登记；匹配等“AI 建议 + 人工裁定”流程按整体系统评估性能 | 模型与验证、患者匹配 |
| **贝叶斯方法用于药物/生物制品临床试验** | **草案**，2026-01（联邦公报 2026-01-12，征询至 2026-03-13）[21] | ① 支持关键试验的主推断；② 三类成功准则：校准到一类错误、直接解读后验概率、决策分析/损失函数，均须预先规定；③ 先验须纳入全部相关信息（避免挑选），论证并量化影响；④ 静态/动态折扣，动态借用下先验有效样本量随数据变化，属启发式指标；⑤ 在合理漂移范围内计算一类错误，或给出贝叶斯运行特征（期望把握度、正确决策概率、偏倚、MSE）；⑥ 分析先验与设计先验分开，做替代先验与临界点敏感性分析；⑦ 报告含收敛诊断与软件[21][22] | 合成对照（混合对照）、虚拟试验 |
| **复杂创新试验设计（CID）互动** | 定稿 2020-12[23] | 提交材料：借用先验信息的来源、相关性及“已纳入全部相关先验信息”的说明；运行特征（错误结论概率、效应估计可靠性；一类错误不适用时给替代指标）；先验对运行特征的敏感性；模拟报告；DMC 决策规则；数据访问限制与完整性计划；建议在 2 期末会议讨论模拟情景与假设（入组速度、对照组结局） | 虚拟试验 |
| **适应性设计** | 定稿 2019-11[24] | ① 预先规定适应规则与分析软件；② 以模拟评估一类错误、把握度、期望样本量、期望时长与估计偏倚；③ 模拟精度取决于迭代次数，10 万次/情景可使一类错误 95% CI 约 ±0.1%，不同情景宜用不同随机种子；④ 模拟报告须含：设计总述、示例试验、情景参数配置及充分性论证、迭代次数及理由、各情景运行特征、模拟代码（可读、有注释、含随机种子，必要时附通用统计语言可运行版本）、总结结论；⑤ 期中数据保密（CID 指南明确沿用此清单） | 虚拟试验 |
| **RWD/RWE 系列** | 使用 RWD/RWE 支持监管决策的考虑：定稿 2023-08[26]；非干预性研究：草案 2024-03[27]；含 RWD 申报的数据标准：定稿 2023-12[64]；另有 EHR 与理赔数据、登记数据、提交文件、融入常规诊疗的 RCT 等文件，FDA RWE 页（内容日期 2026-06-03）逐一列出[25] | ① 数据适用性＝相关性+可靠性；② 暴露、结局、协变量的操作性定义与验证；③ FDA 须能确信“数据源不是为有利结论而选、分析不是为有利结论而做”：方案与 SAP 在执行预设分析前定稿并提交，方案修订须加日期戳并逐条说明理由，超出 SAP 的分析标为探索性；④ 从 RWD 提取到数据集保存全程维护审计追踪，记录用户访问、数据变更、方案变更与已执行的分析；⑤ 能提交患者级数据，且申报数据采用 FDA 支持的数据标准[26][64] → 导出数据集附“源数据→分析数据”映射说明 | 数据与证据、虚拟队列、合成对照 |
| **罕见病：药物研发中的自然史研究** | **草案**，2019-03（页面内容日期 2020-04-15）[28]；配套的《罕见病：药物与生物制品研发考虑》定稿 2023-12[63] | 自然史数据用作外部对照的前提：病例定义清晰、测量方法与试验一致、访视频率足够、数据标准化；v1.0 引用时须写明“草案” | 虚拟队列、合成对照 |
| **随机试验协变量校正** | 定稿 2023-05[29] | 协变量与模型预先规定；预后基线协变量用于提高效率 → PROCOVA 路线依据 | 合成对照（预后校正） |
| **MIDD 配对会议项目** | PDUFA VII（FY2023–2027），每季度受理 1–2 项；优先主题含剂量选择、药物—试验—疾病模型的临床试验模拟、机制性安全性评价；会议材料须含 **ICH M15 评估表**（页面日期 2026-07-07）[30] | 产品导出 M15 评估表 + MAP，可直接作为配对会议材料 | 模型与验证、虚拟试验 |
| **ISTAND** | 已由“试点”更名为项目（页面日期 2026-09-22）；2026-06-03 接受首个 in silico 药物研发工具（药物性肝损伤预测）进入项目[31] | 平台化工具可走“工具资格”路径；产品保留工具级验证档案（按 COU） | 模型与验证 |
| **CDRH：计算建模与仿真可信度评估**（采纳 ASME V&V 40） | 定稿 2023-11-17（草案 2021-12-23）[32] | ① 9 步：问题→COU→模型风险（影响×后果）→拟收集的可信度证据→可信度因子与目标梯度→前瞻性充分性评估（可征询 FDA）→产生证据→事后充分性评估→可信度评估报告；② 8 类证据：代码验证、模型校准、台架验证、体内验证、基于人群的验证、涌现行为、模型合理性、COU 模拟的计算验证/不确定性量化；③ **范围仅限第一性原理/机制模型，明确不适用于独立的统计或数据驱动（ML/AI）模型** → 用作机制型模拟器的证据清单，ML 模型改用 FDA AI 草案 | 模型与验证、虚拟患者 |
| FDA 关于数字孪生/in silico | AI/ML 讨论文件 2023-05（2025-02 修订）称 in silico 临床试验用“模拟参与者的虚拟队列”、患者数字孪生是“可能用于临床研究的新兴方法”[33]；2025-04-10 减少动物试验路线图鼓励用计算模型与 AI 预测毒性（非临床）[34] | 产品不得宣称任何监管机构已认可数字孪生对照；非临床/安全性预测与临床对照替代分开描述 | 虚拟患者、模型与验证 |

### 2.3 EMA

| 文件 | 状态与日期 | 对产品的要求 | 影响模块 |
|---|---|---|---|
| **PROCOVA 资格认定意见** | CHMP 2022-09-15 采纳[35] | ① 随机对照、连续终点：以独立于试验数据的历史数据训练预后评分，在 ANCOVA 中作协变量，可用于主分析；② 一类错误控制与无偏性不依赖预后模型好坏；③ 可据残差方差下降缩减样本量，但须考虑假设的不确定性并满足试验其他目的；④ 须预先规定评分及其尺度因子，并用独立数据评估相关性，以“折减因子”应对过度乐观；⑤ **CHMP 不认可模型开发步骤本身的通用程序**；⑥ 与额外协变量/分层因素同用时注意共线性 | 合成对照（预后校正）、模型与验证 |
| **AI 用于药品生命周期反思文件** | CHMP 2024-09-09 采纳（EMA/CHMP/CVMP/83833/2023）[36] | ① 区分“高患者风险”与“高监管影响”；② 关键试验须防过拟合与数据泄漏，涉及主要终点等高影响用途前以“未来日历时间”前瞻数据检验性能；③ 不接受增量学习，试验中修改模型须经监管互动修订 SAP；④ 揭盲前冻结预处理管线与全部模型并写入 SAP，否则视为事后分析；⑤ 未经 EMA 资格认定的高影响用途，模型架构、开发/验证/测试日志、训练数据与处理管线可能被视为试验数据并被要求提交；⑥ 用于适应症或用法用量的 AI 属高患者风险兼高监管影响 | 模型与验证、合成对照、虚拟患者 |
| **单臂试验作为关键证据的反思文件** | 草案 2023-04；**CHMP 2024-09-09 采纳定稿**（EMA/CHMP/458061/2024）[37] | ① 所有分析在首例入组前写入 SAP，含分析人群与伴发事件处理；② 成功准则常以预先设定的阈值表达，阈值须反映外部信息的不确定性并偏保守；③ 估计目标受“只观察到试验治疗”所限，须说明与监管问题的关系；④ 列出选择偏倚等偏倚来源及缓解措施，要求敏感性分析；⑤ 事后另建外部对照不在本文范围，但本文对该单臂部分完全适用 | 合成对照、虚拟试验 |
| DARWIN EU 与 RWE | 2022 年建立，已全面运行；截至 2026 年约 40 个数据合作方、交付约 110 项研究，方案与结果在 HMA-EMA RWD 目录公开（页面日期 2026-09-21）[38] | 研究方案预先公开、通用数据模型分析可复现 → 产品支持导出可公开登记的方案与分析代码 | 数据与证据 |
| in silico/AI 方法资格认定（2022 年后） | 见第 3 节 | — | 模型与验证 |

### 2.4 NMPA / CDE

（本节最终核实中；以下为已核实部分）

| 文件 | 状态与日期 | 关键方法学要求 → 产品 | 影响模块 |
|---|---|---|---|
| 真实世界证据支持药物注册申请的沟通交流指导原则（试行） | 2023-02（2023 年第 6 号）[43] | 三个时点沟通（实施前、实施中、申报前）；讨论必要性、可行性、设计要素（目的、设计类型、人群、样本量、数据源）、数据适用性与研究透明度 → “CDE 沟通交流资料包” | 报告、合成对照 |
| 药物真实世界研究设计与方案框架指导原则（试行） | 2023-02（2023 年第 5 号）[42] | 方案框架与偏倚控制、敏感性分析 → 方案模板 | 合成对照、方案 |
| 罕见疾病药物开发中疾病自然史研究指导原则 | 2023-07（2023 年第 43 号）[47] | 自然史研究设计与数据标准化 → 自然史队列模板 | 虚拟队列 |
| 药物临床试验中应用贝叶斯外部信息借用方法的指导原则（试行） | 2026-01（2026 年第 6 号）[48] | 借用信息须有明确来源，构建先验前评价数据质量并说明选择依据；关注先验构建、决策标准、样本量设计；预见先验—数据冲突并预设处理方案 | 合成对照（混合对照）、虚拟试验 |
| 2026 版 GCP / 适用 E6(R3) | 2026 年第 50 号公告，2026-09-01 施行，新增数据治理章；2026-03-31 后启动的试验适用 E6(R3)[49][50] | 同 E6(R3) | 全平台 |
| “人工智能+药品监管”实施意见 | 国药监综〔2026〕6 号，2026-04-02[51] | 监管侧推进结构化、标准化电子申报 → 结构化方案与结果导出有价值 | 报告 |
| 海南博鳌乐城真实世界数据应用试点 | 截至 2025-03 已有 21 个产品经试点路径获批上市，3 个经真实世界研究支持纳入医保[52] | 境内 RWD 可支持注册 → 数据适用性档案 | 数据与证据 |

## 3. 先例案例

（最终核实中；以下为已核实部分）

| 年份 | 机构 | 产品/工具 | 外部/合成/in silico 证据 | 结果 | 教训 |
|---|---|---|---|---|---|
| 2020-10 | FDA | Medicenna MDNA55（复发胶质母细胞瘤） | Medidata 合成对照臂（历史试验数据）用于解读 2 期，并获 FDA 支持在 3 期注册试验中采用混合外部对照，前瞻对照约减 2/3[60] | 设计获支持（非上市批准） | 混合设计（保留部分随机对照）更易被接受 |
| 2022-09 | EMA | PROCOVA | 数字孪生预后评分做协变量校正[35] | 资格认定，范围窄 | 效率提升不等于替代对照 |
| 2022-10/12 | FDA | 131I-omburtamab（神经母细胞瘤 CNS/软脑膜转移） | 单臂研究对照德国神经母细胞瘤试验登记（1990–2015）外部对照[61] | ODAC 2022-10-28 以 16:0 认为证据不足；随后 CRL | 外部对照“不适合目的”：人群差异与跨越 25 年的诊疗演变无法靠统计校正 |
| 2023-12-13 | FDA | 依氟鸟氨酸（Iwilfin，高危神经母细胞瘤维持） | 单臂 Study 3b 对照 COG 试验 ANBL0032 外部对照，倾向评分 1:3 匹配（90 vs 270），EFS HR 0.48（95% CI 0.27–0.85）[62] | ODAC 14:6 支持；批准 | 外部对照来自高质量试验、方案预先规定、多重敏感性分析并有确证性证据 |
| 2024-01 | FDA | PROCOVA | FDA 答复 ISTAND 意向书：不偏离协变量校正指导原则，无需另入项目；提醒功效计算可能乐观[39] | 未进入 ISTAND（因已有指南覆盖） | 统计方法创新先对照现有指南定位 |

## 4. 对产品的具体要求清单

### 4.1 跨模块（数据与证据、方案与试验先例、报告与项目决策）

| 编号 | 要求 | 依据 |
|---|---|---|
| X-01 | **Estimand 对象**：五属性 + 伴发事件策略枚举 + 版本随方案版本；敏感性分析与补充分析分开登记 | E9(R1)[5]、EMA 单臂[37] |
| X-02 | **双时钟冻结证明**：“分析计划冻结”（内容哈希、签署人、UTC 时间）与“结局字段首次访问”由平台自动记录；冻结后的修订须写理由并标注“事后”，报告首页显示时间线 | FDA ECT[17]、FDA RWD/RWE 考虑[26]、EMA 单臂[37]、M15 MAP[2]、EMA AI[36] |
| X-03 | **数据源检索与取舍台账**：设计阶段访问过的所有候选数据源、可行性分析结果、纳入/排除理由；每个数据源的访问、数据变更、方案变更与已执行分析的审计追踪；方案修订自动加日期戳并要求填写理由；SAP 之外的分析自动标“探索性” | FDA ECT 脚注 18[17]、FDA RWD/RWE 考虑[26] |
| X-04 | **数据适用性档案**：相关性（关键变量可得性、人群覆盖）与可靠性（完整性、准确性、一致性、可追溯）；结局判定方法与测量时点；按数据关键性分级——用于关键终点的事实须带“源记录核查状态”（已核对/抽样核对/仅系统层评估），提取、链接、转换步骤留痕 | FDA RWD 系列[26]、E6(R3) 附件 2 §3.4.1[10]、CDE RWD 指导原则 |
| X-05 | **审计追踪**：账户与权限变更、每次数据/配置修改（含原因）、工作流动作；不可关闭；UTC；可导出供审阅 | E6(R3) 4.2.2[10] |
| X-06 | **系统验证文档包**：需求与规格、关键功能测试（估计量、随机数、借用算法的数值基准）、配置验证、接口验证、变更控制、版本发布说明、周期性复核 | E6(R3) 4.3.4[10] |
| X-07 | **盲态与期中信息隔离**：定义可访问结局/期中数据的角色；任何非计划访问自动记录并要求影响评估 | E6(R3) 4.1[10]、E20[8]、FDA 适应性设计[24] |
| X-08 | **结构化方案**：按 M11 章节建模、修订差异与生效范围、结构化入排标准、可交换导出 | M11[13] |
| X-09 | **可重现执行包**：输入快照哈希、代码与环境、模型/方法版本、种子、蒙特卡洛误差、一键重放 | CID[23]、贝叶斯草案[21]、M15 MAR[2] |
| X-10 | **监管沟通资料导出**：FDA（M15 评估表 + MAP/MAR；Type C/配对会议背景材料）、EMA（资格认定/科学建议要点）、CDE（沟通交流资料包） | [2][30][43] |

### 4.2 虚拟队列

- 自然史/外部对照候选队列模板：病例定义、疾病分期、测量方法与访视频率、与目标试验的测量一致性说明[28]。
- 目标试验模拟要素：时间零点规则（与试验组一致，自动检测不朽时间）、合格性在时间零点评估、随访起止[17]。
- 自动生成 FDA 10 维度可比性报告与 E10 适用情境自检[17][7]。
- 合成队列（生成数据）一律标注来源，不得作为对照证据输入“外部对照”路线；作为“设计情景”时在导出物中加水印。

### 4.3 虚拟患者

- 每条预测携带：模型发布号、COU、可信度等级（R0–R3）、适用性检查结果（输入是否在训练分布内）、预测区间及其校准证据[2][18]。
- “数字孪生”标签仅用于以真实个体基线为条件的预测，且模型等级 ≥ R2；否则显示“虚拟患者（参考情景）”。
- 用于剂量、适应症或治疗分配的预测一律按“高患者风险 + 高监管影响”处理（至少 R3 证据要求），平台只输出“监管沟通准备稿”[36]。

### 4.4 合成对照（四条路线分别对应）

| 路线 | 必备要素 | 依据 |
|---|---|---|
| 观察性外部对照 | X-02/X-03 双时钟与数据源台账；10 维度可比性表；时间零点一致；混杂因素预先指定与排序；缺失数据策略；敏感性分析与定量偏倚分析（未测混杂的临界点/E 值类方法）；必要时结局盲态再评估；单臂部分按 EMA 单臂要求预设阈值 | [17][37][7] |
| 模型比较器 | 模型可信度档案（≥R2 才可用于“指定研究分析”）；模型不确定性与估计不确定性合并传递；报告中称“模型预测比较器”；声明“尚无监管机构接受其替代同期对照” | [2][18][36] |
| 混合对照（贝叶斯借用） | 借用计划：先验数据源质量评价与纳排理由、借用方法（静态/动态，如幂先验、稳健混合先验、层次模型）、分析先验与设计先验、先验有效样本量、先验—数据冲突处理、漂移范围内一类错误曲线或贝叶斯运行特征、临界点分析、收敛诊断 | [21][23][48] |
| 随机试验预后校正 | 仅随机对照；连续终点主分析模板；预后模型独立数据训练并锁定版本、尺度因子预先规定；三路径比较；样本量折减含乐观折扣与敏感性分析；明确“不产生对照组” | [35][39][29] |

### 4.5 虚拟试验

- 模拟报告模板（必填，按 FDA 适应性设计指南[24]与 CID[23]、E20[8]）：①设计总述与分析方法；②示例试验（如按原样本量阳性、首次期中因无效停止、扩样后阳性）；③情景矩阵（零假设、备择、讨厌参数与漂移范围、入组速度、对照组结局）及其充分性论证；④数据生成模型与参数来源；⑤每个情景的迭代次数及理由、蒙特卡洛误差；⑥运行特征（一类错误、把握度、偏倚、覆盖率、期望样本量与时长分布）；⑦代码与软件版本、每个情景的随机种子、可在通用统计语言中重跑的版本；⑧先验敏感性（贝叶斯设计）；⑨期中决策规则与 DMC 职责、数据访问限制计划；⑩总结结论。
- 选优规则透明：平台不自动选择“效应最有利”的情景（v1.0 已规定），选择目标与理由写入决策记录。
- 基于药物—试验—疾病模型的模拟另附 M15 评估表与 MAP，可用于 FDA 配对会议[30]。

### 4.6 患者匹配与招募（仅监管科学相关部分）

- 资格判定绑定方案版本（M11 结构化入排标准）；逐条标准的证据、判定与人工裁定留痕[13]。
- 若 AI 判定结果影响受试者安全或试验结果可靠性（例如作为正式筛选依据），按 FDA AI 草案进入可信度评估（通常 R1–R2）；仅用于起草材料等运营效率用途不在该草案范围[19]。
- 用于试验的预筛系统满足 E6(R3) 的适用性与审计追踪要求[10]。

### 4.7 「模型与验证」：模型可信度分级（合并 ICH M15 / FDA AI 7 步 / ASME V&V 40）

**统一流程（产品字段）**

| 统一步骤 | ICH M15 | FDA AI 草案 | ASME V&V 40 / CDRH | 产品字段 |
|---|---|---|---|---|
| 1 问题 | QOI | 第 1 步 | 问题 | question_of_interest |
| 2 使用情境 | COU（角色、范围、建模数据、其他证据） | 第 2 步 | COU | context_of_use |
| 3 风险 | 模型影响 × 错误决策后果 → 模型风险；另评模型偏离度 | 第 3 步 | 模型影响 × 决策后果 | influence / consequence / risk / impact（低中高 + 理由） |
| 4 计划 | 技术标准、适当性、MAP | 第 4 步可信度评估计划 | 各可信度因子的目标 | credibility_plan（每项验收标准） |
| 5 证据 | 验证；确认与适用性评估 | 第 5 步执行 | 可信度因子（代码验证、计算验证、确认、适用性）；CDRH 8 类证据 | evidence[]（含数据与代码哈希） |
| 6 记录 | MAR | 第 6 步（含偏差） | 报告 | MAR + deviations |
| 7 结论 | 证据评估结论 | 第 7 步充分性 | 充分性判定 | adequacy（具名评审人，非开发者） |
| 8 生命周期 | — | 生命周期维护 | — | 监测指标、漂移阈值、变更控制与再验证触发 |

**分级（模型风险由影响与后果组合得出。平台约定——非监管规定：两者均低→低；任一为高且另一不低→高；其余→中。“模型偏离度”为高时，无论等级都提示先做监管沟通）**

| 等级 | 典型 COU | 最低可信度证据 | 允许的意图标签 |
|---|---|---|---|
| R0 参考模拟 | 数学参考情景、流程演示 | 代码验证（解析解/基准对照）、种子可复现；导出加“数学参考情景”水印 | 探索 |
| R1 低风险 | 招募预测、样本量情景、可行性评估 | R0 + 输入溯源 + 关键参数敏感性分析 + 临床表面效度评审 + 局限说明 | 探索、设计支持 |
| R2 中风险 | 预后评分用于随机试验校正；模型比较器作背景/支持性证据；影响研究结果的资格判定模型 | R1 + 独立数据（时间/地域分离）外部验证（校准、区分度、亚组）+ 不确定性量化与覆盖率 + 逐次适用性检查 + 版本锁定 + MAP 先于数据访问 + MAR + 非开发者复核 | 设计支持、指定研究分析 |
| R3 高风险 | 模型输出构成主要疗效/安全证据，或用于剂量、适应症、治疗分配 | R2 + 未来日历时间的前瞻验证 + 揭盲前冻结管线、禁止增量学习 + 完整开发/验证日志与训练数据说明可供提交 + 机制模型的 V&V 40 全部因子 + 监管沟通记录 + 变更再验证 | 监管申报准备（仅准备稿） |

说明：① 机制型模拟器（PK/PD、QSP、疾病进展的微分方程模型）用 V&V 40 可信度因子（代码验证、计算验证、确认、适用性）与 CDRH 的 8 类证据组织证据[32]；数据驱动模型（ML/深度学习、LLM 提取器）用 FDA AI 草案第 4 步的内容组织证据（开发数据、训练、测试数据独立性、性能指标、不确定性）；二者都填 M15 评估表，因此一个 UI、两套证据模板。② 等级是“该模型在该 COU 下”的属性，同一模型换 COU 必须重新评级（M15：模型风险“不是 M&S 的固有风险”[2]）。③ 等级只决定“证据是否齐备”的提示与导出标签，不新增交付拦截点，与平台“门禁预算”规则一致。

### 4.8 对 v1.0 方案的逐节修订建议

| v1.0 章节 | 现状 | 建议 |
|---|---|---|
| §1.2 / §22 出处表 | 引 ICH M15 “as adopted by FDA”；FDA 外部对照指南“draft” | 状态正确，补充日期：M15 Step 4 2026-01-29、FDA 定稿 2026-06；外部对照仍为 2023-02 草案；新增 FDA 2026-01 贝叶斯草案、CDE 2026 贝叶斯借用指导原则、EMA 单臂反思文件 2024-09 定稿 |
| §3.2 意图标签 | 四个标签，未与模型证据挂钩 | 标签与 R0–R3 对应（探索→R0/R1；设计支持→R1/R2；指定研究分析→R2；监管申报准备→R2/R3 + 监管沟通记录），导出时自动检查并提示缺口 |
| §8.2 研究设置 | “确证性使用前冻结分析计划；保留修订与既往数据接触” | 升级为 X-02 双时钟 + X-03 数据源台账；增加“SAP 决策对外部对照结局保持盲态”的平台级证明（FDA ECT） |
| §8.3 借用 | 报告先验信息贡献、冲突、上限与运行特征 | 按 FDA 2026 草案与 CDE 2026 补足：分析先验/设计先验、动态借用 ESS 的启发式标注、漂移范围一类错误曲线、临界点分析、收敛诊断 |
| §9.4 虚拟试验输出 | 列出配置、种子、代码等 | 直接采用 4.5 的模拟报告模板；增加“讨厌参数范围”和“DMC 决策规则”两节 |
| §10.1 模型卡 | 已含范围、验证、漂移、退役 | 增加 M15 评估表字段、MAP/MAR 链接、可信度等级与 COU 绑定、训练/验证日志与数据处理管线归档（EMA AI）、变更控制与再验证触发 |
| §16 交付物 | 九类工件 | 增加“审计追踪导出”“系统验证文档包”“监管沟通资料包（M15 表、CDE 资料包）” |
| §18.1 V1 方法矩阵 | 连续均值差、二分类风险差、预设时点 RMST | 保留；外部对照 RMST 增加时间零点一致性与删失机制可比性诊断；预后校正仅连续终点给主分析模板 |
| §19.2 验收场景 | AC-01–AC-24 | 增加 4.9 的 AC-25–AC-30 |

### 4.9 建议新增的验收场景（均为提示/记录类，不新增拦截）

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-25 | 冻结后才首次访问结局字段 | 报告时间线正确显示冻结与首次访问的 UTC 时间；冻结后修改自动标“事后” |
| AC-26 | 外部对照时间零点与试验组定义不一致 | 可比性表标出索引日期差异并提示不朽时间偏倚，不给出“无偏”结论 |
| AC-27 | 动态借用 | 报告先验有效样本量并注明“随数据变化、仅作参考”，给出漂移范围内一类错误曲线与临界点分析 |
| AC-28 | 模型在 R3 用途下缺少监管沟通记录 | 导出物标为“监管申报准备稿”并列出缺失证据，不阻断导出 |
| AC-29 | 尝试关闭或修改审计追踪 | 无此入口；任何配置变更都留下可归因记录与原因 |
| AC-30 | 预后校正用于二分类或生存终点 | 方法标“研究性”，报告写明超出 EMA PROCOVA 资格认定范围 |

## 5. 出处

1. ICH, “ICH M15 guideline on Model-Informed Drug Development adopted”: https://www.ich.org/news/harmonised-ich-m15-guideline-general-principles-model-informed-drug-development-adopted
2. ICH, M15 Step 4 presentation (signed off 29 January 2026): https://database.ich.org/sites/default/files/ICH_Step_4_Presentation_M15_2026_0316_0.pdf
3. FDA, M15 General Principles for Model-Informed Drug Development: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/m15-general-principles-model-informed-drug-development
4. Federal Register, M15 guidance for industry, 2026-06-03: https://www.federalregister.gov/documents/2026/06/03/2026-11112/m15-general-principles-for-model-informed-drug-development-international-council-for-harmonisation
5. ICH E9(R1) Step 4 (2019-11-20): https://database.ich.org/sites/default/files/E9-R1_Step4_Guideline_2019_1203.pdf
6. FDA, E9(R1) (final, May 2021): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/e9r1-statistical-principles-clinical-trials-addendum-estimands-and-sensitivity-analysis-clinical
7. ICH E10 (2000-07-20): https://database.ich.org/sites/default/files/E10_Guideline.pdf
8. EMA, ICH E20 adaptive designs (Step 2b): https://www.ema.europa.eu/en/ich-e20-adaptive-designs-clinical-trials-scientific-guideline
9. Federal Register, E20 draft guidance, 2025-09-30: https://www.federalregister.gov/documents/2025/09/30/2025-18897/e20-adaptive-designs-for-clinical-trials-international-council-for-harmonisation-draft-guidance-for
10. ICH E6(R3) consolidated Step 4 (adopted 16 June 2026): https://database.ich.org/sites/default/files/ICH%20E6(R3)_Step4_FinalConsolidatedGuideline_2026_0616_.pdf
11. EMA, ICH E6 good clinical practice: https://www.ema.europa.eu/en/ich-e6-good-clinical-practice-scientific-guideline
12. FDA, E6(R3) Good Clinical Practice (final, September 2025): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/e6r3-good-clinical-practice-gcp
13. ICH M11 Step 4 template (2025-11-19): https://database.ich.org/sites/default/files/ICH_Step4_M11_Final_Template_2025_1119.pdf
14. EMA, ICH M11: https://www.ema.europa.eu/en/ich-m11-guideline-clinical-study-protocol-template-technical-specifications-scientific-guideline
15. Pharmuni, FDA finalizes ICH M11 (2026-05-22): https://pharmuni.com/news/fda-finalizes-3-part-ich-m11-digital-protocol-standard-can-structured-protocols-transform-trial-submissions/
16. FDA, Externally Controlled Trials (draft page): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-design-and-conduct-externally-controlled-trials-drug-and-biological-products
17. FDA, Externally Controlled Trials draft guidance PDF: https://www.fda.gov/media/164960/download
18. FDA, AI to Support Regulatory Decision-Making (draft page): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological
19. FDA, AI draft guidance PDF: https://www.fda.gov/media/184830/download
20. EMA/FDA, Guiding principles of good AI practice in drug development (2026-01): https://www.ema.europa.eu/en/documents/other/guiding-principles-good-ai-practice-drug-development_en.pdf
21. Federal Register, Use of Bayesian Methodology draft guidance, 2026-01-12: https://www.federalregister.gov/documents/2026/01/12/2026-00325/use-of-bayesian-methodology-in-clinical-trials-of-drug-and-biological-products-draft-guidance-for
22. Berry Consultants, Guide to the FDA’s 2026 draft Bayesian guidance: https://www.berryconsultants.com/resource/guide-to-the-draft-fda-bayesian-guidance-2026
23. FDA, Interacting with the FDA on Complex Innovative Trial Designs (Dec 2020): https://www.fda.gov/media/130897/download
24. FDA, Adaptive Design Clinical Trials for Drugs and Biologics (Nov 2019): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/adaptive-design-clinical-trials-drugs-and-biologics-guidance-industry
25. FDA, Real-World Evidence: https://www.fda.gov/science-research/science-and-research-special-topics/real-world-evidence
26. FDA, Considerations for the Use of RWD and RWE (final, Aug 2023): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-use-real-world-data-and-real-world-evidence-support-regulatory-decision-making-drug
27. FDA, RWE: Non-Interventional Studies (draft, Mar 2024): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/real-world-evidence-considerations-regarding-non-interventional-studies-drug-and-biological-products
28. FDA, Rare Diseases: Natural History Studies (draft, Mar 2019): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/rare-diseases-natural-history-studies-drug-development
29. FDA, Adjusting for Covariates in Randomized Clinical Trials (final, May 2023): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/adjusting-covariates-randomized-clinical-trials-drugs-and-biological-products
30. FDA, MIDD Paired Meeting Program: https://www.fda.gov/drugs/development-resources/model-informed-drug-development-paired-meeting-program
31. FDA, ISTAND Program: https://www.fda.gov/drugs/drug-development-tool-ddt-qualification-programs/innovative-science-and-technology-approaches-new-drugs-istand-program
32. FDA CDRH, Assessing the Credibility of CM&S in Medical Device Submissions (final, Nov 2023): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/assessing-credibility-computational-modeling-and-simulation-medical-device-submissions
33. FDA, Using AI & ML in the Development of Drug & Biological Products, discussion paper (May 2023, rev. Feb 2025): https://www.fda.gov/media/167973/download
34. FDA, plan to phase out animal testing requirement (2025-04-10): https://www.fda.gov/news-events/press-announcements/fda-announces-plan-phase-out-animal-testing-requirement-monoclonal-antibodies-and-other-drugs
35. EMA, Qualification opinion for PROCOVA (CHMP 2022-09-15): https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf
36. EMA, Reflection paper on AI in the medicinal product lifecycle (CHMP 2024-09-09): https://www.ema.europa.eu/en/documents/scientific-guideline/reflection-paper-use-artificial-intelligence-ai-medicinal-product-lifecycle_en.pdf
37. EMA, Reflection paper on single-arm trials (CHMP 2024-09-09): https://www.ema.europa.eu/en/documents/scientific-guideline/reflection-paper-establishing-efficacy-based-single-arm-trials-submitted-pivotal-evidence-marketing-authorisation-application_en.pdf
38. EMA, DARWIN EU: https://www.ema.europa.eu/en/about-us/how-we-work/big-data/data-analysis-real-world-interrogation-network-darwin-eu
39. Unlearn, “US FDA comments on Unlearn’s PROCOVA methodology” (2024-01-02): https://www.unlearn.ai/blog/us-fda-comments-on-unlearns-procova-methodology
40. （预留：CDE 2020 真实世界证据指导原则）
41. （预留：CDE 2021 真实世界数据指导原则）
42. CDE 2023 年第 5 号（转载）: https://www.waizi.org.cn/doc/140068.html
43. CDE 2023 年第 6 号（转载）: https://www.ccfdie.org/zryyxxw/cfdazsjg/ypspzx/webinfo/2023/02/1668883407723946.htm
44. （预留：CDE 模型引导的药物研发技术指导原则）
45. （预留：CDE 适应性设计指导原则）
46. （预留：CDE 罕见病与单臂试验系列）
47. CDE 2023 年第 43 号（转载）: https://www.ciopharma.com/supervise/31201
48. 中国食品药品网，CDE 发布《药物临床试验中应用贝叶斯外部信息借用方法的指导原则（试行）》，2026-01-21: https://cs.cnpharm.com/c/2026-01-21/1089278.shtml
49. NMPA 等四部门 2026 年第 50 号公告（GCP 2026）: https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260608103856150.html
50. NMPA 关于适用 E6(R3) 的公告（转载，2025-12）: https://www.cncsdr.org/ggtz/ggzz/202512/t20251226_429161.html
51. NMPA《关于“人工智能+药品监管”的实施意见》，2026-04-02: https://www.nmpaic.org.cn/yjzxyw/202604/t20260402_429649.html
52. 海南省政府网，乐城真实世界试点产品获批，2025-03: https://www.hainan.gov.cn/hainan/sxian/202503/36b731fa4a734d929187cfc9d1762e1c.shtml
53. （预留）
54. （预留）
55. （预留）
56. （预留）
57. （预留）
58. （预留）
59. （预留）
60. Business Wire, Medidata SCA supported by FDA for Medicenna Phase 3 (2020-10-28): https://www.businesswire.com/news/home/20201028005277/en/Medidata-Synthetic-Control-Arm-Supported-by-the-US-Food-and-Drug-Administration-FDA-for-Use-in-Medicenna-Therapeutics-Corp.-Phase-3-Registrational-Trial-in-Recurrent-Glioblastoma
61. The Cancer Letter, ODAC on omburtamab (2022-11-04): https://cancerletter.com/regulatory-news/20221104_2/
62. FDA Approval Summary: Eflornithine for High-Risk Neuroblastoma (JCO 2024; PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC11365752/
63. FDA, Rare Diseases: Considerations for the Development of Drugs and Biological Products (final, Dec 2023): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/rare-diseases-considerations-development-drugs-and-biological-products
64. FDA, Data Standards for Drug and Biological Product Submissions Containing Real-World Data (final, Dec 2023): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/data-standards-drug-and-biological-product-submissions-containing-real-world-data
