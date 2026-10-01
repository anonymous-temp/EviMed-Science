# C2 方法学研究：虚拟患者、合成队列、数字孪生、AI 辅助方案/匹配与数据标准

> 研究片 C2 ｜ 2026-09-28 ｜ 输入：owner《EviMed Virtual Clinical Research Platform》v1.0（`../source/v1.0-original-en.md`）。
> 口径：只讨论方法与工程取舍；"隐私/披露风险"只作为合成数据的一项工程质量属性，不涉及任何法律或合规判断。方括号 [n] 对应第 5 节出处；未能在线核实的事实标「未核实」。软件版本与发表状态以 2026-09-28 检索为准。
> 与平台原则的关系：数值只来自版本化的确定性 R/Python 引擎；LLM 负责解析、提议、解释。本文所有"阈值"均为报告带（notice），不新增阻塞点。

## 1. 结论先行

1. **V1 合成队列只上"白盒"生成器。** 参数化场景队列用声明式条件分布（语义对齐 R `simstudy`[1]）；"从观测分布合成"默认 `synthpop` CART 顺序合成[2,3]，备选 Gaussian copula（经验边际 + 相关矩阵，`rvinecopulib` 仅开 Gaussian 族[4]）。CTGAN/TVAE、TabDDPM、TabSyn、GReaT、HALO、CEHR-GPT 全部后置[5,6,7,8,9,10]。→ 方案 §6.3/§18.1 的 "parametric/empirical synthetic baselines" 改写为两个具名 generator package，model card 增加 `generator_family` 字段。
2. **合成数据验证是固定的"报告套件"而非门槛。** 保真（单变量、成对、propensity pMSE/S_pMSE[11,12]）、硬约束违例、稀有组合、特定效用（目标估计量 CI 重叠[13]、TSTR/TRTR[14]）、披露风险（精确复制、DCR/NNDR 对 holdout 基线、成员推断、Anonymeter 三类风险[15]）。S_pMSE 采用 synthpop 作者的经验规则（<10 可接受，<3 更好）[16]，其余绿/黄/红报告带是产品默认值并写明"非文献阈值"。→ §6.4 落为一个 contract kind（建议名 `synthetic-cohort-validation`），指标集合固定、缺项即 issue、红带只出 notice。
3. **"合成≠匿名"要落在数据模型与界面。** 合成数据的隐私收益不可预测、离群记录仍然暴露[17]；DCR 类相似度检查可以被重建攻击绕过[18]；深度表格生成器会记忆训练行[19]。→ `synthetic` 来源标签永不与"匿名/去标识"文字同时出现；披露风险只以"测了什么、数值多少"呈现，不输出"安全"结论。
4. **差分隐私（DP）生成器后置，并在 model card 写明效用代价。** DP 条件下边际类（MST、AIM）优于 GAN 类[20,21,22]，但 DP 对少数亚组的保真损失不成比例[23]——正是临床研究关心的尾部。→ V1 不提供 DP；以后提供 AIM 时强制同时报告 ε/δ、亚组保真与特定效用。
5. **计数分离要有机制而不是口号。** 方案 §3.1 的四个数量之外，再入库"生成器训练所用观测数"与"合成副本数 m"；在合成数据上做的任何推断默认标"探索性"，正式推断回到观测数据，或用多重合成的组合规则[24]。→ AC-09 增加对这两个字段的断言。
6. **"数字孪生"标签收紧到 NASEM 定义。** 需同时具备个体条件化、随新数据更新（双向数据流）、预测能力、服务决策、VVUQ 记录[25]。只基于基线的一次性预测称"基线条件化预测"。→ §7.1 第 3 种模式改名；twin 标签由 model card 证据字段自动推导，不能手工授予。
7. **模型分三级而非徽章：参考模拟器 / 研究模型 / 在声明使用情境（COU）下外部验证。** 轨迹模型验证表必须含分时域校准（calibration-in-the-large、slope、ICI）、预测区间覆盖率、CRPS、亚组与时间外验证[26,27,28]。→ §10.1 model card 增加机器可读 `validation_table`；AC-23 扩展到覆盖率与校准。
8. **LLM 模拟患者和"硅样本"不能当人群数据。** AgentClinic、Agent Hospital、Patient-Ψ 是训练/评测对话代理的仿真环境[29,30,31]；社会科学研究显示 LLM 代答方差被压缩、群体被扁平化[32,33]。→ §7.4 的禁令扩展为"LLM persona 队列不得作为任何队列或结局来源"，只允许作为标注为虚构的测试夹具或培训脚本。
9. **机理模型（QSP/PBPK/PopPK）V1 不托管，但 model package 接口现在定。** 接口 = ODE + NONMEM 风格事件表 + 参数不确定性与个体间变异分开 + 协变量人群生成器 + vpop 选择方法（Allen 2016 接受-拒绝[34]）；宿主引擎 `mrgsolve`/`rxode2`/`nlmixr2`，PK-Sim 经 `ospsuite`[35,36,37,38]。→ §10 增加 `mechanistic` 执行接口，避免以后为 PBPK 另开代码路径。
10. **匹配 = LLM 抽取带定位的证据 + 确定性三值逻辑判定。** TrialGPT 在 1 015 个患者-判据对上的判据级准确率 87.3%（专家 88.7%–90.0%）[39]，即约每 8 条判据错 1 条；在真实肿瘤病历上，PRISM 的问题级准确率只有 63%–68%[40]。必须人审。→ §11.1 增加不变量"抽取事实必须带原文区间且区间内能找到该值，否则判据为 unknown"；判定在已审结构化判据上以 Kleene 三值逻辑 + `deferred` 执行。
11. **匹配评估以"合格者召回"和"错误排除"为主指标，并最终看运营结果。** 判据级 4×4 混淆矩阵（met/not met/unknown/deferred）并按时间/数值/否定分层；患者级合格者召回率、错误排除率、需筛查数、审阅时间；英文基准 n2c2 2018、TREC CT，中文判据基准 CHIP-CTC，外加自建双人标注的中文 EMR 评测集[41,42,43]。目前唯一的随机对照证据（RECTIFIER，JAMA 2025）衡量的正是"资格判定率与入组率"[44]。→ §20.2 的 "matching recall, false exclusion" 给出精确分母与分层。
12. **标准"对齐"而非"实现"。** ICH M11 已于 2025-11-19 达到 Step 4，CDISC USDM v4.0 于 2025-06-03 发布[45,46]：方案模型字段对齐二者，estimand 用 ICH E9(R1) 五属性[47]；有 OMOP 源时判据导出 Circe JSON[48]；统计引擎统一吃 ADaM 形状（ADSL/BDS/ADTTE）[49]；数据质量按 Kahn 框架实现 DQD 式检查目录[50,51]；数据适用性用 SPIFD[52]；ICD-10 国家临床版 2.0 / 医保版 2.0、GB/T 15657-2021 只作为知识包词表。→ §5.1 的入库产物定义为"ADaM 形状分析快照 + 质量检查 JSON"。

## 2. 正文

### 2.1 合成表格/队列生成

**方法谱系**（按"谁决定联合分布"划分）：

| 类别 | 代表方法与实现 | 联合分布由谁决定 | 可解释 / 可复现 | 典型失败 | 本方案定位 |
|---|---|---|---|---|---|
| 参数化定义 | `simstudy`：`defData` 公式与分布表、`genCorData`/`genCorGen` 相关结构、`defSurv`/`genSurv` 生存时间、`defMiss`/`genMiss` 缺失机制[1] | 分析者声明 | 每个参数可读；同规格+同种子+同版本逐字节复现 | 只声明边际不声明依赖；相关阵非正定；越界值 | **V1**：参数化场景队列 |
| 顺序条件合成 | `synthpop`：按 visit sequence 逐变量以 CART 或参数模型条件合成，`rules` 表达逻辑约束[2,3] | 观测数据 + 变量顺序 | 每一步是一个可展示的条件模型；种子复现 | 小叶节点原样复制稀有记录；变量顺序影响结果 | **V1**：默认经验合成 |
| Copula | Gaussian copula（经验边际 + 相关阵）；vine copula[53,4]；SDV `GaussianCopulaSynthesizer`[54] | 观测边际 + 依赖结构 | 相关阵/树结构可展示 | 只保单调依赖，交互项与阈值效应丢失；离散变量处理需技巧 | **V1 备选**（仅 Gaussian 族）；以后开放 vine 全族 |
| 深度生成 | CTGAN/TVAE[5]、CTAB-GAN+[55]、TabDDPM[6]、TabSyn[7]、TabDiff[56]；集成框架 `synthcity`[57] | 神经网络 | 黑箱；GPU 非确定性；超参敏感 | 模式崩塌、记忆训练行[19]、稀有类别失真 | 后续；经同一验证套件 |
| LLM 表格生成 | GReaT：行序列化为文本后微调语言模型[8] | 语言模型 | 不可解释；数值保真差、算力高 | 记忆与不合理组合 | 不用于带结局的记录 |
| 纵向/EHR | Synthea 模块化状态机[58]；HALO 层级自回归[9]；CEHR-GPT[10]；TimeGAN[59] | 规则模块 / 序列模型 | Synthea 可读但非拟合；序列模型黑箱 | Synthea 结局与真实质量指标不符[60]；序列模型记忆 | Synthea 仅作测试夹具；序列模型后续 |

**版本与许可（2026-09 核对）。** `simstudy` 0.9.2（GPL-3）[1]；`synthpop` 1.9-3（GPL-2|3，2026-09-10）[2]；`rvinecopulib` 1.0.0.1.0（GPL-3）/ `pyvinecopulib` 1.0.0（MIT）[4]；`synthcity` 0.2.12（Apache-2.0）[57]；SDV 1.38.4（BUSL-1.1）与 SDMetrics 0.32.0（MIT）[61,62]；`smartnoise-synth` 1.0.8（MIT）[63]；`anonymeter` 1.1.0（Clear BSD）[15]；Synthea 4.0.0（2026-03）[58]。

**V1 为什么是这三种。** (1) 方案 §6.3 要求"显式种子、生成器版本、分布、依赖、参数不确定性与可复现生成"——参数化定义与 CART 顺序合成都能把每个条件分布写进执行记录，Gaussian copula 可以把整张相关阵展示给统计师。(2) Yan 等对 EHR 合成模型（medGAN、medBGAN、EMR-WGAN、WGAN、DPGAN 与边际抽样基线）的多维基准结论是"没有任何方法在每个用例的所有准则上都明确最优"，且效用指标与隐私指标两两负相关——效用最好的 EMR-WGAN 隐私风险也最高[64]；V1 不应押注在需要大量调参、GPU 上难以逐字节复现的深度模型上。(3) `synthpop` 自带 `compare`、`utility.gen`/`utility.tab`（通用与特定效用）以及 `disclosure()`/`multi.disclosure()`（repU、DiSCO 等身份与属性披露度量）[2,65]，可直接复用为 §2.2 的报告套件。(4) 工程选型事实：SDV 以 BUSL-1.1 发布，其附加使用许可排除"Synthetic Data Service"（向第三方开放其数据变换、机器学习或合成功能的商业服务），各版本四年后转为 MIT[61]；`synthcity` 为 Apache-2.0。托管 SaaS 的默认引擎避开前者（这里只是选型约束，不作法律解读）。

**V1 具体配置。**
- *参数化场景队列*：平台的 JSON 队列规格（变量、分布族、公式/连接函数、依赖、截断、缺失机制、来源 = `assumed` 或带引文的 `cited`）编译为 `simstudy` 定义表。相关基线用 `genCorGen`（Gaussian copula 连接任意边际），时间事件结局用 `defSurv`（Weibull/比例风险型公式），缺失用 `defMiss`（MCAR/MAR）。参数不确定性用"外层抽参数、内层抽个体"的两层抽样，外层抽样本身入库为 scenario 的一部分。R 随机数种类（`RNGkind` 三项）与种子一起固定并记录。
- *经验合成基线*：`synthpop::syn(method = "cart", visit.sequence, rules, rvalues, smoothing, minnumlevels, m = 5, seed)`；数值变量开平滑以降低原值复制，极少水平的类别合并；m≥5 份合成数据用于推断时按合成数据组合规则[24]；拟合所用观测数与 m 分别入库。
- *Gaussian copula*：`rvinecopulib::vinecop(family_set = "gaussian", var_types = …)` 支持连续/离散混合，展示相关阵；参数不确定性用源数据 bootstrap 重拟合。以后只需放开 `family_set` 即得 vine copula，接口不变。
- *纵向*：V1 只合成"基线 + 由参考模拟器生成的结局"，不合成真实纵向病程；Synthea 只用于端到端测试夹具（FHIR/CSV 输出），来源标 `synthetic-fixture`。

**没有患者级数据时的参数来源（方案旅程 A）。** 参数来自先例库：基线表（Table 1）的均值/标准差/比例，加上声明的相关假设（来源为同类观测数据、公开调查数据或专家设定，一律进入 assumption register）。时间事件对照分布可用 Guyot 算法从已发表 Kaplan-Meier 曲线与"number at risk"重建伪个体数据（R 包 `IPDfromKM`），再拟合 Weibull/分段指数等参数分布[66,67]。重建数据来源标 `extracted` + `calculated`，永不计入观测患者数；自动对账重建的风险集与事件数和原文表格，保留原图出处与数字化误差。

**后续。** 高维混合型基线（数十个以上变量、大量类别）引入 `synthcity` 的 TVAE/TabSyn 类模型；纵向编码序列（OMOP 形状）引入 CEHR-GPT 或 HALO——前提是有足量纵向数据、GPU 预算，并且 §2.2 的记忆检查全部报告。HALO 在疾病编码概率上与真实数据 R²>0.9[9]，但这只是边际频率层面的保真，不等于病程或结局可信；CEHR-GPT 目前只有预印本[10]。

**失败模式。** 条件关系丢失（copula 只保单调依赖，交互项消失）；稀有组合被抹平或被原样复制；结构性零与逻辑约束违例（男性妊娠、日期倒序）；缺失机制被当成完全随机；时间一致性破坏；在合成数据上训练的模型迁移到真实数据变差（TSTR 差距）；生成记录数被误当证据量（方案 §3.1 已禁止，需机制化）。规则型生成器同样有结局失真：Chen 等用 120 万马萨诸塞州 Synthea 患者对照质量指标，COPD 30 天死亡率 0.7%（州/全国实际 7%/8%），髋膝置换并发症 0%（实际约 2.9%），血压控制达标 0%（实际约 70%–75%），结论是 Synthea 对人口学与服务提供概率可靠、对服务后的异质结局建模有限[60]——"人口学分布合理 ≠ 病程合理"，与方案 §6.3 的提醒一致。

**自动化验收。** 已知 DAG 回收：从声明规格生成 N=20 000，边际均值/比例、相关系数与 logit 系数落在真值 ±4 个 Monte Carlo 标准误内[68]；同规格+同种子+同引擎版本输出哈希一致；硬约束违例恒为 0；"故意过拟合"的 CART（叶节点=1、无平滑）必须在复制率与 DCR 上报红——证明指标能变红。

### 2.2 合成数据评估

**三轴定义。**
- *保真*：单变量（连续 KS/Wasserstein、类别 TVD、缺失率差）、成对（Spearman/Cramér's V 差、二维列联表 TVD）、全局可区分性。全局用 propensity 法：真实与合成记录合并后拟合区分模型，pMSE = 平均 (p̂ − c)²，c 为合成记录占比[11]；Snoke 等推导了 pMSE 的零分布期望，提出标准化 S_pMSE 与 pMSE 比值使不同数据集可比[12]；`synthpop::utility.gen` 提供 logit 与 CART 两种区分模型及置换零分布[2]。
- *效用*：通用效用即上述可区分性；特定效用是声明的分析在两份数据上的一致程度——估计量置信区间重叠[13]、标准化系数差，以及 TSTR（合成训练、真实测试）相对 TRTR（真实训练、真实测试）的性能比[14]。特定效用只对声明的任务报告，不外推。
- *披露风险*（仅当生成器拟合于受保护记录）：精确复制率；DCR（合成记录到最近真实记录的距离）与 NNDR（最近/次近距离之比）——必须与"未参与训练的 holdout 到训练集"的同名分布对比，而非用绝对阈值；成员推断（MIA）AUC 及低误报率下的真阳性率[69]，合成数据专用的密度型攻击 DOMIAS[70]；Anonymeter 的 singling-out、linkability、inference 三类风险，均以对照攻击为基线[15]；`synthpop` 的 repU（被复现的唯一记录）与 DiSCO（在合成数据中可推断且在原数据中正确）[65]。

**"合成数据不自动私密"的证据。** Stadler 等在 USENIX Security 2022 用成员与属性推断实验表明：合成数据"要么挡不住推断攻击，要么保不住效用"，相对传统匿名化没有更好的隐私-效用权衡，隐私收益难以预先判断，离群记录风险最高[17]。Ganev 与 De Cristofaro（IEEE S&P 2025）构造了能通过 DCR/NNDR 等相似度检查、却能推断乃至重建训练记录的攻击[18]。表格扩散模型的记忆已被专门测量：按"最近训练记录距离小于次近距离的 1/3"定义，TabSyn 在 Magic 数据集上的记忆率达 80.01%，且随训练轮数增加[19]；后续工作发现记忆呈重尾分布，少数样本贡献了大部分[71]。因此披露风险的正确表述是"测了哪些攻击、结果如何"，不是"安全/不安全"。

**DP 生成器与代价。** MST：NIST 2018 差分隐私合成挑战获胜方案，用最大生成树选二维边际，加噪后以 Private-PGM 推断联合分布[20]；AIM：按工作负载自适应迭代选边际[21]；PrivBayes：带噪贝叶斯网络[72]；DP-CTGAN：DP-SGD 训练的 CTGAN[73]。Tao 等的基准：边际类方法一致优于其他方法，GAN 类连一维统计都保不住，用其输出训练的分类器常常不比"多数类"分类器更准[22]。Ganev 等发现 DP 对亚组影响方向因算法而异（PrivBayes 缩小多数-少数差距，PATE-GAN 扩大差距），但少数亚组的下游准确率都受损更重[23]。结论：DP 是以后的可选生成器（`smartnoise-synth` 提供 MWEM、MST、AIM、DP-CTGAN、PATE-CTGAN 等；`private-pgm` 提供 MST/AIM 参考实现[63]），不是默认；启用时同时报告 ε/δ、亚组保真与特定效用。

**默认评估套件（报告，不门控）。** S_pMSE 采用 synthpop 作者的经验规则："所有标准化 pMSE 比值低于 10、最好低于 3 时通常无需再改进"[16]；表中其余"报告带"是本产品的默认工程约定，用于界面着色与排序，不是文献验证的阈值，不阻塞交付；首批约 20 个真实数据集后按观察分布复核（平台原则 4：新检查先以 notice/metric 上线）。SDMetrics 的 DCRBaselineProtection / DCROverfittingProtection 与本表"距离"行同构，可作交叉核对实现[62]。

| 轴 | 指标 | 计算口径 | 绿 / 黄 / 红 |
|---|---|---|---|
| 单变量保真 | KS D（连续）、TVD（类别） | 每变量；列出最差 5 个 | ≤0.05 / ≤0.10 / >0.10 |
| 缺失保真 | 缺失率绝对差；缺失模式 TVD | 每变量；前 20 种模式 | ≤0.02 / ≤0.05 / >0.05 |
| 成对保真 | \|ΔSpearman\|、\|ΔCramér's V\| | 全部变量对；报告最大值与 >0.10 的比例 | 最大值 ≤0.05 / ≤0.10 / >0.10 |
| 全局可区分 | S_pMSE（`utility.gen`，CART 与含二阶交互 logit 各一）；propensity AUC（5 折） | 两者都报 | S_pMSE <3 / 3–10 / >10；AUC ≤0.60 / ≤0.70 / >0.70 |
| 约束 | 声明硬约束违例数 | 每条规则 | 必须为 0（不变量，不是统计带） |
| 稀有组合 | 真实中频数≥5 的类别组合在合成中缺失的比例；合成中"真实不存在组合"的比例 | 至三维 | 只报告 |
| 特定效用 | 目标估计量 CI 重叠；TSTR/TRTR（AUROC 或 C-index） | 只对声明分析 | 重叠 ≥0.8 / ≥0.5 / <0.5；比值 ≥0.95 / ≥0.90 / <0.90 |
| 可行性效用 | 每条判据通过率与全部判据联合通过率的差（合成 vs 真实），及 unknown 比例差 | 用于"人群情景/入组率"时必报 | 联合通过率相对差 ≤10% / ≤20% / >20% |
| 复制 | 与训练记录全列相同的合成记录比例，对照 holdout 同名比例 | 全列 | 不高于对照 / 高于对照 / 高于对照 2 倍 |
| 距离 | 合成记录最近邻落在训练集（而非等量 holdout）的比例；5% 分位 DCR、NNDR 与 holdout 基线之比 | 标准化后 Gower 距离 | 比例 ≤0.55 / ≤0.60 / >0.60 |
| 成员推断 | DOMIAS 或影子模型 AUC；TPR@FPR=1% | holdout 作非成员 | AUC ≤0.55 / ≤0.60 / >0.60 |
| 推断风险 | Anonymeter 三风险（点估计 + 95% CI）；repU、DiSCO | 准标识与敏感列由数据管理员指定 | ≤0.05 / ≤0.10 / >0.10 |

实现分工：R 侧用 `synthpop` 的 `compare`/`utility.gen`/`utility.tab`/`disclosure`；Python 侧用 `anonymeter` 与 `synthcity` 内的 DOMIAS；DCR/NNDR 自实现（Gower 距离，数值按训练集范围标准化），保证训练集与 holdout 基线用同一口径计算。训练前先按 80/20 切出 holdout，holdout 不参与生成器拟合——这是距离、复制率与成员推断三项有基线可比的前提。"可行性效用"一行是本产品特有的：虚拟试验的"人群情景"族（方案 §9.2）直接消费判据通过率，合成队列若把联合通过率做偏，下游入组时长与样本量都会系统性偏。

使用规则：(1) 所有数值连同指标实现版本、种子、holdout 划分哈希写入结果包；(2) 报告文本只能引用存储的数值（对应 AC-20）；(3) 红带只触发"notice + 建议动作"（加大平滑、合并稀有类别、改用参数化规格、缩小变量集），不阻塞交付。

**失败模式。** 只看均值；用绝对 DCR 阈值判定"安全"；不留 holdout 导致距离与 MIA 没有基线；特定效用在未声明的任务上外推；在同一份数据上反复调生成器直到指标变绿（应记录尝试次数）。

**自动化验收。** 指标可变红：身份"生成器"（直接返回训练集）必须得到复制率≈100%、MIA AUC≈1、全部披露项红；从真实数据生成机制独立抽样的"理想生成器"必须 MIA AUC 在 0.5±0.05、最近邻落在训练集的比例在 0.5±0.05；把某一列随机打乱的生成器必须在涉及该列的成对项上报红。

### 2.3 机理建模中的虚拟人群（QSP / PBPK / PopPK）

**QSP 虚拟人群。** Allen 等 2016 的两步法已成为事实标准：先在生理约束内从随机起点优化参数，得到输出落在可信范围内的"似然患者"（plausible patients）；再用接受-拒绝选择，使入选虚拟人群的输出分布匹配观测临床分布（接受概率与目标密度/似然患者密度之比成正比）[34]。Rieger 等 2018 在生成效率与选择上做了改进[74]；更早的"患病率加权"[75]与"备选虚拟人群"[76]用于揭示结论对人群假设的敏感性。启示：虚拟人群的"真实性"只在被选来匹配的那几个观测量上成立，其余输出是模型外推，应标 `predicted` 并附敏感性。

**PBPK 虚拟人群。** Simcyp 是基于人群的 ADME 模拟器，按年龄、性别、种族给出生理参数的联合分布，含中国人群[77]（中国人群的具体出处「未核实」）；开源 Open Systems Pharmacology Suite（PK-Sim/MoBi）[38]内置欧洲（ICRP）、北美（NHANES）、亚洲（Tanaka 1996）与日本人群[78]，可经 `ospsuite` R 包无界面批量运行。PBPK 预测常以"2 倍以内"作为成功标准，但该标准对变异小的比值过宽[79]。

**开源 PK/PD 模拟器。** `mrgsolve`（R + C++，ODE、事件表、快速人群模拟）[35]、`rxode2`（RxODE 后继，ODE 与事件表）[36]、`nlmixr2`（非线性混合效应估计，与 rxode2 共用模型语言）[37]。三者都接受 NONMEM 风格数据列（`ID/TIME/EVID/AMT/CMT/II/ADDL/RATE/DV`），这应成为 model package 的事件接口。

**model package 需要的接口（现在定，以后托管）：**
1. `model_kind: mechanistic-ode`；`engine: mrgsolve | rxode2 | ospsuite`；引擎版本与模型源文件哈希。
2. 参数表：名称、单位、典型值、不确定性（协方差矩阵或 bootstrap/后验样本）；**参数不确定性与个体间变异（Ω）、残差（Σ）分开存放**——前者产生"区间的区间"，后者产生人群离散。
3. 协变量人群生成器：年龄、体重、身高、性别、肾功能、基因型等的联合分布与来源，直接复用 §2.1 的参数化/copula 规格。
4. 事件表：给药与观测时点，含单位与时间基准。
5. vpop 选择：似然约束、目标分布、选择算法、诊断（接受率、有效样本量、目标量 KS）。
6. 输出语义：浓度/效应轨迹及派生量（AUC、Cmax、应答率），"变异"与"不确定性"分别给区间。
7. 验证：VPC/pcVPC、观测/预测比、外部数据与 COU 声明。

**失败模式。** 把 Ω 当作不确定性（区间过窄）；只匹配基线分布就宣称能预测疗效；vpop 接受率过低导致少数参数集被重复使用；单位与时间基准不一致；把"模拟器数学正确"当成"模型经验有效"（方案 §3.2 已区分）。

**小结。** V1：只落接口与 schema（上面 7 项），不托管任何机理模型；后续：先接 `mrgsolve`（单一 R 依赖、事件表语义最直接），再接 `rxode2`/`nlmixr2`（需要估计时），PBPK 经 `ospsuite` 调 PK-Sim；验收：玩具 ODE 上 Allen 接受-拒绝后目标量 KS D<0.05、接受率入库；关闭 Ω 后个体间离散消失而参数不确定区间保留（第 4 节 C2-10/11）。

### 2.4 数字孪生与轨迹预测

**定义。** 美国国家科学院（NASEM）2023 年报告把数字孪生定义为：一组模仿自然、工程或社会系统（或系统之系统）结构、情境与行为的虚拟信息构造，随其物理孪生的数据动态更新，具有预测能力，并为实现价值的决策提供信息；虚实之间的双向交互是核心，验证、确认与不确定性量化（VVUQ）贯穿全生命周期[25]。对照方案 §7.1：只基于基线的一次性预测缺"随新数据更新"与"回到决策"两环。建议把"数字孪生"做成派生标签，同时满足：(a) 个体条件化；(b) 已登记的更新机制（新观测 → 重新条件化 → 新版本）；(c) 预测带经过校准的不确定性；(d) 有 COU 与 VVUQ 记录。

**V1 虚拟患者的参考模拟器：把数据生成过程写死在 model card 里。** 连续终点：Y = β₀ + β′X + τA + ε，ε~N(0, σ²)，对应 ANCOVA 基准；二分类：logit P(Y=1) = α + γ′X + δA，对应风险差（边际标准化）与指定 logistic 回归；时间事件：Weibull 比例风险，用逆变换法生成事件时间[80]（R `simsurv` 支持任意基线风险与时变效应[81]），删失 = 行政删失（入组期 + 随访期）+ 独立指数脱落，分析对比取预设时域 τ 的 RMST[82]。一个经常被忽略的陷阱是**不可压缩性**：OR 与 HR 在调整协变量后，条件效应与边际效应数值不同，即便没有混杂[83]。因此情景参数必须声明效应是在哪个尺度、哪个层面定义的（"条件 HR=0.7"与"边际 HR=0.7"不是同一情景）；若用户给的是边际效应，引擎用大样本模拟反解条件参数，并把反解结果与 Monte Carlo 误差写入执行记录。这一条直接支撑方案 §8.2"ATT、ATE、条件 HR 与边际效应不得混用"。

**Unlearn 的公开方法。** 以条件受限玻尔兹曼机等生成模型在历史对照数据上学习疾病进展，按受试者基线生成其对照结局分布（阿尔茨海默病：Fisher 等 2019[84]；Walsh 等 2020[85]），后续提出 Neural Boltzmann Machines[86]。其监管路径 PROCOVA 只把孪生预测作为随机化试验中的预后协变量做线性调整：Schuler 等说明该调整在随机化下保持 I 类错误并提高效率[87]，EMA 2022 年给出资格意见[88]。这与方案 §8.1 第 4 条路线一致：预后调整不等于替代对照臂。

**EHR 基础模型与轨迹生成。**
- CLMBR：下一编码自回归的表示学习[89]；EHRSHOT：少样本基准与开放权重 CLMBR-T-base[90]；MOTOR：以大规模时间-事件目标预训练的基础模型[91]；ETHOS：在 MIMIC-IV 上做零样本健康轨迹预测[92]。
- Foresight（Lancet Digit Health 2024）：在 NLP 抽取的概念序列上训练 GPT，预测后续疾病并由临床医生评估模拟情景[93]。
- Delphi-2M（Nature 2025）：在 UK Biobank 上训练改造的 GPT，同时预测 1 000 余种疾病的发病率与下次事件时间，在丹麦登记数据上外部验证，并可采样长达 20 年的合成病程[94]。
- DT-GPT：微调的医学 LLM 预测化验/生命体征轨迹，并报告对未训练变量的零样本预测[95]；TWIN-GPT：用 LLM 生成试验中的个体化结局[96]；Epic Cosmos 上训练的生成式医疗事件模型 CoMET[97]。

这些模型可以作为"研究模型"提供人群轨迹与风险，但共同风险是：训练人群选择偏倚（如 UK Biobank 的健康志愿者效应）；事件序列反映"被记录"而非"已发生"，混入就医与编码行为；分布漂移；对干预没有因果识别——它们学到的是观察性共现，不是治疗效应。方案 §9.1"新药疗效不能从标准治疗预后模型推断"对它们同样适用。

**LLM 模拟患者与"硅样本"。** AgentClinic（带偏倚的多模态仿真临床环境，用于评测诊断代理）[29]、Agent Hospital（医生代理在 LLM 患者上迭代"进化"）[30]、Patient-Ψ（基于认知模型的 LLM 模拟来访者，用于心理治疗培训）[31]——目标是训练与评测对话能力，不是复现人群分布。社会科学的"硅样本"研究：Argyle 等报告 GPT-3 在部分群体上有"算法保真"[98]；Bisbee 等发现合成调查回答方差过小、对提示与时间敏感、回归关系失真[32]；Wang 等指出 LLM 替代受试者会误刻画并扁平化身份群体[33]。结论：LLM 生成的"虚拟患者档案"只可作为明确虚构的教学或测试材料。

**"研究模型"与"已验证模型"的界线（建议写入 model card）：**

| 级别 | 条件 | 允许用途 | 界面/导出标签 |
|---|---|---|---|
| 参考模拟器 | 数学过程完全由用户参数决定 | 探索、设计支持 | "数学参考情景" |
| 研究模型 | 拟合模型；只有开发数据内部验证，或他处发表但未在本 COU 外部验证 | 探索、设计支持；不得作为"指定研究分析"的对照来源 | "研究模型（未在本使用情境外部验证）" |
| COU 验证模型 | 在与 COU（人群/对照/终点/时域/数据场景）匹配的独立数据上预先指定的外部验证，含校准、覆盖、亚组、时间外验证 | 上述全部 + 指定研究分析（仍逐研究审评） | "已在〈COU〉验证（版本、数据、日期）" |

证据要求按"模型影响 × 决策后果"分级，沿用 ICH M15 与 ASME V&V 40 的可信度思路[99,100,101]：同一模型用于"设计探索"与"替代对照"所需证据不同。

**轨迹模型评估清单。** (1) 点预测：各预测时域的 MAE/RMSE（按变量尺度标准化）；(2) 概率预测：CRPS 等严格适当评分[28,102]、PIT 直方图、名义 80%/95% 预测区间的覆盖率与平均宽度；(3) 二分类/时间事件：分时域校准——总体校准、斜率、校准曲线[26,103]，生存模型用 ICI/E50/E90[27]，判别用 AUROC 与时间依赖 C；(4) 亚组：性别、年龄段、站点、数据源、日历期，报告每组 n 与事件数；(5) 时间外验证：训练截至 T0，验证只用 T0 之后首次可得的数据（对应方案"三时钟"），另做站点留出；(6) 预测登记：预测在结局可得前加时间戳（AC-23）；(7) 报告遵循 TRIPOD+AI[104]，LLM 类模型加 TRIPOD-LLM[105]，偏倚评估用 PROBAST+AI[106]。

**区间怎么来（V1 可落地的做法）。** 任何点预测或分位数模型都可以用 split conformal 包一层：在独立校准集上取非一致性得分的分位数，得到有限样本的边际覆盖保证；分位数回归用 CQR[107]，时间事件用 conformalized survival analysis 给出生存时间的下预测界并处理删失[108]。两条限制必须写进 model card：保证是**边际**的（亚组覆盖要单独报告）；依赖可交换性，人群漂移时需要加权 conformal（要求可估计的协变量似然比）[109]，否则覆盖率只是"在校准人群上"成立。这给方案 §7.2 的"prediction intervals and other correctly named uncertainty measures"一个统一、可自动检验的实现，同时把"校准数据不得复用为独立验证"（方案 §19）落到数据哈希层面：训练、conformal 校准、验证三份数据哈希互斥。

**小结。** V1：参考模拟器（上述三族，`simsurv`/自研 R 代码）+ 研究模型挂载接口 + split conformal 区间 + 三级标签；后续：CLMBR/MOTOR 类表示接校准的时间事件头、DT-GPT 类轨迹模型、带更新环的真正"数字孪生"；失败模式：把观察性共现当治疗效应、边际覆盖当亚组覆盖、人群漂移下沿用旧校准、不可压缩尺度混用、LLM 叙事冒充轨迹；验收：以已知模拟器为"真"构造系统偏倚模型，评估工具必须测出总体校准偏离和覆盖不足，正确模型的 95% 区间覆盖率落在二项 99% 区间内（C2-12）；缺更新机制或 VVUQ 记录时孪生标签自动降级（C2-09）。

### 2.5 患者—试验匹配

**代表工作与报告粒度。**
- TrialGPT（Nat Commun 2024）：检索（关键词生成 + 混合检索）→ 判据级判定（给出解释与证据句位置）→ 排序。在 183 名合成患者上评估：判据级准确率 87.3%（1 015 个患者-判据对），人类专家 88.7%–90.0%；检索只用 5.5% 的试验集合即召回 90% 以上相关试验；排序 NDCG@10 0.7275 对最佳基线 0.4797（提升 43.8%）；2 名医生、36 个患者-试验对的用户研究中筛查时间减少 42.6%[39]。注意其患者输入是 TREC/SIGIR 的短病例摘要，不是纵向病历；NIH 的 FAQ 明确其为辅助预筛工具[110]。2026-09 的 TrialGPT 2.0 预印本报告在 288 例上 top-10 含临床医生推荐试验约 91%、筛查时间减少 55.0%，并有 6 个月前瞻阶段[111]（预印本，未经同行评审）。
- Wornow 等（NEJM AI 2025，零样本）：在 n2c2 2018 上 GPT-4 micro-F1 0.93、macro-F1 0.81，高于既往最优 0.91/0.75；两阶段检索把输入 token 最多减少三分之一；临床医生认为其推理说明在正确判定中 97% 连贯、在错误判定中 75% 连贯——**错误判定也常带着"看起来合理"的解释**，这是必须强制证据区间校验的直接理由[112]（数值取自预印本 v2）。n2c2 2018 Track 1：288 名糖尿病患者（202 训练/86 测试）、每人 2–5 份纵向病历、13 条判据（多条带时间窗，如近 6 个月心梗），47 队 109 个提交，最优 micro-F1 0.91 来自规则系统[41]。
- PRISM（npj Digit Med 2024）与其内置的 14B 微调模型 OncoLLM：真实肿瘤 EHR 上 720 个问答对，问题级准确率 OncoLLM 63%、GPT-4 68%、GPT-3.5 53%；98 名患者中真实入组试验进入 top-3 的比例 65.3%[40]。与 TrialGPT 的 87.3% 对比说明：**合成短摘要上的准确率不能外推到真实纵向病历**。
- RECTIFIER（NEJM AI 2024）：GPT-4 + 检索增强做心衰试验（COPILOT-HF）筛查，单判据准确率 97.9%–100%（研究人员 91.7%–100%），总体资格灵敏度 92.3% 对 90.1%、特异度 93.9% 对 83.6%[113]（数值取自预印本）；随后的随机对照试验纳入 4 476 名患者，AI 辅助组资格判定率 20.4% 对人工 12.7%（HR 1.78），入组率 1.6% 对 0.9%（HR 1.79）[44]。
- 中文：肝细胞癌住院患者的 NLP/机器学习预筛（1 053 例、2 个试验）准确率 92.9%–98.0%，但灵敏度仅 51.9%–83.5%[114]——高准确率掩盖了合格者漏筛；院内部署开源 LLM（Qwen、Baichuan2-13B、ChatGLM3-6B）在 4 000 份中文入院记录、6 个肝病试验的 58 条判据上判据级精确率 0.921、召回约 0.82[115]；把中文判据转 SQL 的 EC2Seq2Sql 执行准确率 0.91、临床匹配准确率 0.88[116]。
- 判据表示的前身：EliIE 把入排标准抽取为实体-属性-值-时间结构[117]；Criteria2Query 把自然语言判据转成 OMOP 上可执行的 ATLAS 队列定义[118]；Criteria2Query 3.0 改用 GPT-4，概念抽取 F1 0.891，但生成的 SQL 仍有错误，其中 34.48% 是逻辑错误[119]。MatchMiner：开源，以结构化判据匹配基因组与临床条件，354 个试验上线后使用该工具的知情同意平均提前 55 天[120]；其 LLM 扩展 MatchMiner-AI 仍为预印本[121]。
- 语料：TREC Clinical Trials 2021/2022（主题为 5–10 句的合成入院病例，2021 年 75 个、2022 年 50 个；试验库 375 581 个；标注 2=eligible、1=excluded、0=not relevant；NDCG 评分）[42]；Chia（1 000 个 IV 期试验、12 409 条判据、41 487 个实体与 25 017 个关系）[122]；中文 CHIP-CTC（CBLUE 中来自 ChiCTR 的判据句 44 类语义分类，训练/验证/测试 22 962/7 682/10 000，最佳基线 macro-F1 70.9，人类 78.0）[43]——它评的是"判据句分类"，不是患者匹配。

**典型失败模式。** (1) 时间判据：窗口计算（"入组前 6 个月内"）、事件时间与记录时间混淆，跨病历复制的过期用药/化验被当作当前值（Wornow 等的定性错误类型之一）[112]；(2) 否定与假设：否认史、家族史、"拟行"；(3) **缺失当满足**：方案 §11.1 点名的设计风险（洗脱期）。检索范围内未见直接量化该错误的文献；TrialGPT 的 26 个判据级错误中，30.7% 反而是"本可推断却判为信息不足"，15.4% 是医学知识缺失（同义词、亚型），26.9% 是"信息不足"与"不适用"标签混淆[39]——两个方向的错误都要在混淆矩阵中单列；(4) 数值与单位：阈值、单位换算、"最近一次"还是"任意一次"；(5) 析取与嵌套逻辑（C2Q 3.0 的 SQL 错误中三分之一是逻辑错误）；(6) 适用性（仅女性、仅某队列）；(7) 证据张冠李戴：引用句不支持结论；(8) "高准确率、低灵敏度"：合格者稀少时准确率被大量不合格者撑高（上述中文 HCC 研究）。

**V1 设计。**
- *判据结构化*：LLM 起草 → 人审 → 保存为方案版本的一部分。每条判据含极性、实体（带编码）、属性、比较符、数值与单位、相对锚点的时间窗、适用性、原文。
- *事实抽取*：结构化字段直接映射；非结构化文本由 LLM 抽取候选事实，每个事实必须带来源文档、字符区间与可得时间；**区间内找不到对应值（数值或规范化概念的匹配）→ 事实作废 → 判据 unknown**。
- *判定*：确定性引擎在已审判据与 as-of 快照上以 Kleene 三值逻辑（met / not met / unknown）计算，另有 `deferred`（证据将在已知时间出现）；任一排除标准为 unknown 时总体不得为"符合"。
- *排序*：只按"未决 unknown 数、补证成本、站点状态"排序，不输出"获益概率"。

**评估。** 判据级：金标准为双人独立标注 + 裁决（报告 κ）；4×4 混淆矩阵，单列"unknown→met"（虚假满足）与"met→not met"（错误排除）；按判据类型（时间/数值/否定/逻辑/适用性）分层。患者级：合格者召回率（预筛主指标）、错误排除率（真实合格而被判不合格 / 真实合格数）、阳性预测值与需筛查数（工作量）。证据级：引用片段支持率。运营：每位患者审阅时间（有/无辅助）、候选到正式筛查转化率。并区分方案 §19 的三层：给定当时信息的正确性、最终资格、实际入组。

**小结。** V1：判据结构化草案 + 带区间的证据抽取 + Kleene 确定性判定 + 人审，评测集 = n2c2 2018 + CHIP-CTC + 自建中文 EMR 集；后续：检索式试验召回（TrialGPT 式）、Criteria2Query 式 SQL 草案、前瞻"影子模式"运行（只记录不推送，与协调员实际结果比对）；验收：三值真值表、"删证据 → unknown"、伪造数值被区间校验拦下、as-of 时间穿越、最小编辑扰动集（C2-15～C2-20）。

### 2.6 试验设计与证据的 LLM 代理

- TrialMind（npj Digit Med 2025）：检索式生成 → 筛选 → 数据抽取 → 证据合成的流水线；检索召回 0.711–0.834（对照基线 0.138–0.232），试点中筛选时间减少 44.2%、抽取时间减少 63.4%[123]——与 EviMed 既有的证据合成能力同类，价值在"带定位的抽取 + 人审"。
- ClinicalAgent（ACM BCB 2024）：多代理 + 外部工具预测试验结局，PR-AUC 0.7908[124]；AutoTrial（EMNLP 2023）：带检索与指令的语言模型生成入排标准，人评中对 GPT-3.5 约 60% 胜率[125]；Panacea：试验检索、摘要、设计与招募的基础模型，8 项任务中 7 项最好（预印本）[126]；TrialBench（Sci Data 2025）：23 个数据集、8 类预测任务（时长、脱落、不良事件、死亡、批准、失败原因、剂量、设计）[127]。
- 结局预测：HINT 的 PR-AUC 按阶段为 I 期 0.567、II 期 0.629、III 期 0.811[128]；inClinico 报告 II→III 期转化的准前瞻 ROC-AUC 0.88，公开的前瞻 II 期预测在已读出试验中 79% 正确[129]。这类模型的标签来自登记与发表结果，存在泄漏和发表偏倚；I/II 期 PR-AUC 约 0.6 意味着对单个试验的判别很弱，数值不应进入设计决策。
- Virtual Lab（Nature 2025）：一个"PI"代理组织免疫学、机器学习、计算生物学等专家代理和一名批评者代理，调用 ESM、AlphaFold-Multimer、Rosetta 等工具设计了 92 个纳米抗体，湿实验中 2 个对 JN.1 或 KP.3 变异株结合改善[130]。可借鉴的是"角色分工 + 批评者 + 工具计算 + 人类把关 + 实验验证"的组织方式；成功率本身（92 中 2）也提醒：代理产出的是待验证候选，不是结论。

**可靠性边界**（对应平台原则"语言判断交给模型，可判定属性交给代码"）：
- 可靠（仍需人审）：判据解析为结构；变量映射候选（给出候选编码列表与理由）；方案/SAP 草稿的结构化填充；文献检索与带定位的证据抽取；对已存数值结果的解释。
- 不可靠：试验成功概率或效应量作为决策依据；个体结局生成；统计计算；在多个情景中"挑最有利"的设计；把模型解释当作因果结论。
→ 方案 §15.2 的 AI 职责表建议增加一列"由确定性代码复核的部分"（例：映射提议的编码必须存在于词表版本中；抽取数值必须能在原文区间找到）。

**小结。** V1：沿用平台已有的 DSH 能力包形态，新增的 AI 能力只有三类——方案/判据解析、变量映射提议、对已存结果的解释与报告起草；先例库抽取同样要求"原文定位 + 保留原措辞"（方案 §5.4）。后续：Virtual Lab 式"多角色 + 批评者"只用于方案审阅清单与假设挑战（产出问题，不产出数字）；试验结局预测模型不进路线图。失败模式：代理把检索到的效应量当作情景默认值直接填入；多代理互相"说服"后放大同一错误；把排序分数解释为成功概率。验收：映射提议中不存在于词表版本的编码 100% 被拦下；报告中每个数字能回溯到存储结果或带出处的输入（AC-20）。

### 2.7 方案数字化与数据标准

**ICH M11（CeSHarP）与 CDISC USDM。** M11 由指南、结构化方案模板与技术规范三部分组成，2025-11-19 达到 Step 4；EMA 于 2025-12-11 采纳、2026-06-11 生效，FDA 于 2026-05-22 发布最终指南公告；技术规范规定 M11 受控术语由 CDISC 维护[45]。CDISC 与 TransCelerate 的 Digital Data Flow 用统一研究定义模型（USDM）承载方案内容，USDM v4.0 于 2025-06-03 发布，开发阶段明确以对齐 M11 为目标，参考实现是 TransCelerate 的 Study Definitions Repository（Apache-2.0）[46]。USDM 实体覆盖 Study / StudyVersion / StudyDesign、Population / EligibilityCriterion、Objective / Endpoint、Estimand、Arm / Epoch / Encounter / Activity、ScheduleTimeline。Estimand 采用 ICH E9(R1) 五属性：治疗、人群、变量、伴发事件及其策略、人群层面汇总[47]。建议：`@evimed/domain` 中的方案 schema 字段与 USDM 实体一一对应（映射表随包发布），不追求一致性认证；estimand 五属性为必填结构，直接服务方案 §8.2。

**OMOP CDM 与 Circe。** OMOP CDM 最新为 v5.5.0（2026-08-25 发布），v6.0 仍是 OHDSI 工具"不完全支持"的预发布版[131]；ATLAS 队列定义以 Circe JSON 保存（入组事件、纳入规则、退出条件、观察窗），circe-be 1.14.1 / `CirceR` 1.3.3 可渲染为 SQL[48]。注意版本错位：DQD 当前文档写明支持到 CDM v5.4[51]，客户若已升级 v5.5，质量检查需确认兼容后再用。建议：客户有 OMOP 源时，判据可执行形式导出为 Circe JSON，并在 OHDSI 的 Eunomia 测试库上做回归[132]；没有 OMOP 时，用平台自有判据 JSON 在 ADaM 形状快照上执行。

**FHIR。** 当前正式版是 R5（5.0.0，2023-03-26），R6 仍在投票（2026-07-17 发布了标注 "R6 Stable (Sept 2026)" 的快照）。R5 中 ResearchStudy、ResearchSubject 的成熟度为 FMM 0、EvidenceVariable 为 FMM 1（均为 Trial Use），R6 投票稿拟将三者列为 Normative[133]。成熟度低意味着字段仍可能变化——建议只做导入/导出适配器，不作为内部模型，适配器按 FHIR 版本分别测试。

**CDISC ADaM 作为分析输入形状。** ADaMIG 最新为 v1.3（2021-11-29）；ADSL：每受试者一行（人群标志、分组、基线协变量）；BDS：每受试者 × 参数 × 分析时间点一行（PARAMCD/AVAL/AVISIT/ADT）；ADTTE：BDS 的时间事件变体（AVAL 为时间，CNSR 为删失指示，STARTDT/ADT 为起止）[49,134]。三种终点族（连续/二分类/时间事件）的参考包和观测对照估计器都只接受这三种形状，"疾病无关"就在数据契约层落地。使用其形状不等于提交级 ADaM 一致性。

**数据质量与数据适用性。** Kahn 等的统一框架把数据质量分为一致性（conformance：值、关系、计算）、完整性（completeness）、合理性（plausibility：唯一性、非时间、时间），并区分内部核查（verification）与外部确认（validation）[50]；OHDSI Data Quality Dashboard 按此框架实现（论文报告 3 300 余条检查，当前文档为 24 类检查、约 4 000 条），在表/字段/概念级运行并输出 JSON[51]。建议方案 §5.1 第 5 步直接用"三类别 × 两情境"作为检查目录的维度，结果写入快照。SPIFD 把研究设计要素转为最小数据要求，再逐个数据源评估可靠性与相关性[52]；SPIFD2 把 SPACE 框架与 SPIFD 合并并引入目标试验（target trial）[135]——对应方案 §8.3 的可比性评估与"不可估计"结论，也可直接做成外部对照可行性评估的表单。

**中文编码（仅作词表）。** GB/T 15657-2021《中医病证分类与代码》2021-10-11 发布并实施；中医临床诊疗术语 GB/T 16751.1-2023（疾病）与 16751.3-2023（治法）2023-03-17 发布实施，16751.2（证候）为 2021 版[136]；ICD-10 国家临床版 2.0 与医保版 2.0 是国内病案与医保两条编码线（发布机构与年份「未核实」）[137]；ICD-11 在国内仍处试点阶段，2022 年华西地区的 ICD-10/ICD-11 双编码试点中 ICD-10 侧使用的是国家临床版 2.0[138]。知识包以"代码系统 URI + 版本 + 映射表"发布，映射双向可追溯。

**小结。** V1：USDM 对齐的方案 JSON schema（含 estimand 五属性与结构化判据）、ADSL/BDS/ADTTE 形状的分析快照、Kahn 分类的质量检查目录、SPIFD 式可行性表单、ICD-10 两个中国版本与 GB/T 15657-2021 词表；后续：M11 模板渲染与 USDM JSON 导出、Circe 导出与 ATLAS 同步、FHIR 适配器、在 OMOP 源上直接运行 DQD、ICD-11/SNOMED CT/LOINC 映射。失败模式：把"映射"说成"符合标准"；同名字段不同语义（如 ADT 与事件日期、"可得时间"丢失）；词表版本漂移导致历史判定不可复现；单位未规范化。验收：USDM 往返、Circe→SQL 在 Eunomia 上计数一致、坏 ADTTE 被具名拒绝、注入缺陷被对应 Kahn 类别捕获、未知/跨版本编码报 issue（C2-21～C2-25）。

## 3. 按模块的方法清单

| 模块 | 功能 | V1（方法 + 包） | 后续 | 明确不做 |
|---|---|---|---|---|
| 虚拟队列 | 观测队列选择 | 判据 JSON 在 ADaM 形状快照上确定性执行；有 OMOP 源时导出 Circe（`CirceR`） | ATLAS 双向同步、联邦查询 | —— |
| 虚拟队列 | 参数化场景队列 | `simstudy`（`defData`/`genCorGen`/`defSurv`/`defMiss`），两层抽样表达参数不确定性 | 纵向 `addPeriods` 等 | —— |
| 虚拟队列 | 经验合成基线 | `synthpop` CART（m≥5）；`rvinecopulib` Gaussian 族 | vine 全族；`synthcity` TVAE/TabSyn；AIM/MST（`smartnoise-synth`/`private-pgm`） | 用 LLM 生成带结局记录 |
| 虚拟队列 | 合成验证 | §2.2 套件：`synthpop` `utility.gen`/`compare`/披露度量；`anonymeter`；DOMIAS（`synthcity`）；自实现 DCR/NNDR | 自动建议平滑与合并 | 输出"安全/匿名"结论 |
| 虚拟患者 | 原型 / 队列抽样 | 参考模拟器：连续（线性模型 + 残差）、二分类（logit）、时间事件（Weibull/分段指数 + 独立删失），R 实现、种子与版本入库 | 多状态、竞争风险、纵向混合模型 | LLM 叙事病程 |
| 虚拟患者 | 基线条件化预测 | 只接受 model card 中 COU 匹配的模型；V1 不默认提供临床模型 | CLMBR/MOTOR 类表示 + 校准 TTE 头；DT-GPT 类轨迹模型作研究模型 | 手工授予"数字孪生" |
| 虚拟患者 | 机理模型 | 接口先定（事件表、Ω/Σ/参数不确定性、vpop 选择） | `mrgsolve`/`rxode2`/`nlmixr2`；PK-Sim 经 `ospsuite` | —— |
| 模型与验证 | model card | 必填：kind、COU、输入范围与单位、缺失行为、训练/校准/验证数据哈希、`validation_table`、不确定性方法、分布外行为、许可 | 漂移监测 | 通用"已验证"徽章 |
| 模型与验证 | 评估工具 | 校准：`rms::val.prob`、`CalibrationCurves`；生存 ICI 按 Austin 2020；CRPS：`scoringRules`；区间覆盖率 | 在线监测 | —— |
| 患者匹配 | 判据结构化 | LLM 草案 + 人审；schema 对齐 USDM EligibilityCriterion | Criteria2Query 式 SQL 草案 | 未审判据直接执行 |
| 患者匹配 | 证据抽取 | LLM 抽取 + 字符区间 + 可得时间；无区间 → unknown | 本地中文医学抽取模型 | —— |
| 患者匹配 | 判定与排序 | Kleene 三值 + `deferred` 确定性引擎；按未决项排序 | —— | LLM 直接给总体资格或获益概率 |
| 患者匹配 | 评估 | n2c2 2018、TREC CT 2021/22、CHIP-CTC、自建中文 EMR 集 | 前瞻"影子模式"评估 | —— |
| 方案与数据标准 | 方案模型 | USDM v4 对齐 schema + E9(R1) estimand | M11 模板渲染、USDM JSON 导出 | 宣称一致性 |
| 方案与数据标准 | 交换 | —— | FHIR R5 ResearchStudy/ResearchSubject/EvidenceVariable 适配器 | —— |
| 方案与数据标准 | 分析形状与质量 | ADSL/BDS/ADTTE；Kahn 分类检查目录（DQD 风格）；SPIFD 表单 | OCCDS；在 OMOP 源上直接跑 DQD | —— |
| 方案与数据标准 | 词表 | ICD-10 国家临床版 2.0 / 医保版 2.0、GB/T 15657-2021 | ICD-11、SNOMED CT、LOINC 映射 | —— |

## 4. 可自动化的验收用例

| ID | 模块 | 用例 | 夹具 | 自动判定 | 对应方案 AC |
|---|---|---|---|---|---|
| C2-01 | 队列 | 参数化规格复现 | 固定规格 + 种子 | 输出 Parquet 哈希一致；换种子哈希不同；换引擎版本产生新版本号 | AC-04 |
| C2-02 | 队列 | 已知 DAG 回收 | N=20 000；已知边际、相关、logit 系数 | 估计量落在真值 ±4 MCSE 内 | AC-11 |
| C2-03 | 队列 | 硬约束不变量 | 性别-妊娠、日期顺序、取值范围规则 | 违例数 = 0 | AC-03 |
| C2-04 | 队列 | 指标能变红 | 身份生成器；过拟合 CART；理想生成器 | 前两者复制率/MIA/DCR 报红，理想生成器报绿 | —— |
| C2-05 | 队列 | 计数分离 | 生成 10× 记录 | 观测患者数、事件数不变；训练观测数与 m 入库；合成数据上的推断标"探索性" | AC-09 |
| C2-06 | 队列 | 报告数字对账 | 验证报告 | 报告中每个数字都能在指标 JSON 中找到（值、版本、种子） | AC-20 |
| C2-07 | 队列 | 离群记录 | 植入 5 条唯一离群记录 | 这些记录的近邻距离与 repU 在报告中被单列 | —— |
| C2-08 | 患者 | 适用性拒绝 | 输入越界或缺必需特征 | 返回 applicability issue，无预测输出 | AC-13 |
| C2-09 | 患者 | 孪生标签推导 | 缺更新机制或 VVUQ 记录的模型 | 标签降为"基线条件化预测" | —— |
| C2-10 | 患者 | 变异与不确定性分离 | PK 模型关闭 Ω | 个体间离散消失，参数不确定区间保留 | —— |
| C2-11 | 患者 | vpop 选择 | 玩具 ODE + 目标分布 | 入选人群目标量 KS D<0.05；接受率入库 | —— |
| C2-12 | 模型 | 校准能被发现 | 以已知模拟器为真，构造 +10% 系统偏倚模型 | 总体校准偏离、区间覆盖低于名义；正确模型覆盖落在二项 99% 区间内 | AC-23 |
| C2-13 | 模型 | 时间外验证无泄漏 | 植入验证期后才可得的事实 | 训练与特征构造中不出现 | AC-15 |
| C2-14 | 模型 | model card 完整性 | 缺 COU 或验证数据哈希 | schema issue 列出缺项 | —— |
| C2-15 | 匹配 | 三值逻辑真值表 | AND/OR/NOT × {met, not met, unknown} | 与 Kleene 表一致；排除标准 unknown 时总体非"符合" | AC-14 |
| C2-16 | 匹配 | 缺失不满足 | 删除洗脱期证据 | 判据变 unknown，不为 met | AC-14 |
| C2-17 | 匹配 | 证据区间校验 | LLM 输出原文中不存在的数值 | 事实作废，判据 unknown | —— |
| C2-18 | 匹配 | 时间穿越 | as-of 之后才可得的化验 | 历史回放中不可见 | AC-15 |
| C2-19 | 匹配 | 最小编辑扰动 | 判据"近 6 个月无心梗"；文本"否认心梗史 / 3 个月前心梗 / 7 个月前心梗" | 依次为 met / not met / met | —— |
| C2-20 | 匹配 | 基准报告 | n2c2 2018、CHIP-CTC、自建中文集 | 输出判据级混淆矩阵、合格者召回、错误排除；版本间差异入报告（不门控） | —— |
| C2-21 | 标准 | USDM 往返 | 示例方案 | 导出 JSON 通过 USDM schema；再导入后映射字段相等 | —— |
| C2-22 | 标准 | Circe 回归 | Eunomia 库 | 判据 JSON → Circe → SQL 的计数等于预期 | —— |
| C2-23 | 标准 | ADaM 形状契约 | 坏 ADTTE（CNSR 非法、AVAL<0、ADT<STARTDT）、ADSL 重复 | 引擎拒绝并返回具名 issue | AC-12 |
| C2-24 | 标准 | 质量缺陷注入 | 越界值、未来日期、重复 ID、单位错 | 各被对应 Kahn 类别的检查捕获 | —— |
| C2-25 | 标准 | 词表版本 | 未知码、跨版本码 | 返回 issue；版本固定于知识包 | —— |
| C2-26 | 边界 | LLM 人群请求 | "用 LLM 生成 500 名患者及结局" | 返回可选路径（参考情景 / 合适模型 / 数据请求），不生成 | §7.4 |

## 5. 出处

1. Goldfeld K, Wujciak-Jens J. simstudy: Illuminating research methods through data generation. J Open Source Softw 2020;5(54):2763. doi:10.21105/joss.02763；CRAN 0.9.2（2026-02-09，GPL-3）：https://CRAN.R-project.org/package=simstudy
2. Nowok B, Raab GM, Dibben C. synthpop: Bespoke Creation of Synthetic Data in R. J Stat Softw 2016;74(11):1–26. doi:10.18637/jss.v074.i11；CRAN 1.9-3（2026-09-10，GPL-2|GPL-3）：https://CRAN.R-project.org/package=synthpop
3. Reiter JP. Using CART to generate partially synthetic public use microdata. J Off Stat 2005;21(3):441–462.
4. Nagler T, Vatter T. rvinecopulib: High Performance Algorithms for Vine Copula Modeling. R package 1.0.0.1.0（2026-09-20，GPL-3）. https://CRAN.R-project.org/package=rvinecopulib ；pyvinecopulib 1.0.0（MIT）
5. Xu L, Skoularidou M, Cuesta-Infante A, Veeramachaneni K. Modeling Tabular Data using Conditional GAN. NeurIPS 2019. arXiv:1907.00503
6. Kotelnikov A, Baranchuk D, Rubachev I, Babenko A. TabDDPM: Modelling Tabular Data with Diffusion Models. ICML 2023, PMLR 202:17564–17579. arXiv:2209.15421
7. Zhang H, Zhang J, Srinivasan B, Shen Z, Qin X, Faloutsos C, Rangwala H, Karypis G. Mixed-Type Tabular Data Synthesis with Score-based Diffusion in Latent Space (TabSyn). ICLR 2024 (Oral). arXiv:2310.09656
8. Borisov V, Seßler K, Leemann T, Pawelczyk M, Kasneci G. Language Models are Realistic Tabular Data Generators (GReaT). ICLR 2023. arXiv:2210.06280
9. Theodorou B, Xiao C, Sun J. Synthesize high-dimensional longitudinal electronic health records via hierarchical autoregressive language model. Nat Commun 2023;14:5305. doi:10.1038/s41467-023-41093-0
10. Pang C, Jiang X, Pavinkurve NP, et al. CEHR-GPT: Generating Electronic Health Records with Chronological Patient Timelines. arXiv:2402.04400（2024；未见同行评审版本）
11. Woo MJ, Reiter JP, Oganian A, Karr AF. Global Measures of Data Utility for Microdata Masked for Disclosure Limitation. J Priv Confid 2009;1(1):111–124. doi:10.29012/jpc.v1i1.568
12. Snoke J, Raab GM, Nowok B, Dibben C, Slavkovic A. General and specific utility measures for synthetic data. J R Stat Soc Ser A 2018;181(3):663–688. doi:10.1111/rssa.12358
13. Karr AF, Kohnen CN, Oganian A, Reiter JP, Sanil AP. A framework for evaluating the utility of data altered to protect confidentiality. Am Stat 2006;60(3):224–232. doi:10.1198/000313006X124640
14. Esteban C, Hyland SL, Rätsch G. Real-valued (Medical) Time Series Generation with Recurrent Conditional GANs. arXiv:1706.02633 (2017).
15. Giomi M, Boenisch F, Wehmeyer C, Tasnádi B. A Unified Framework for Quantifying Privacy Risk in Synthetic Data. Proc Priv Enhancing Technol 2023(2):312–328. doi:10.56553/popets-2023-0055；anonymeter 1.1.0（Clear BSD）：https://github.com/statice/anonymeter
16. Raab GM, Nowok B, Dibben C. Assessing, Visualizing and Improving the Utility of Synthetic Data（synthpop vignette，CRAN，2026-09-10）. https://cran.r-project.org/web/packages/synthpop/vignettes/utility.pdf
17. Stadler T, Oprisanu B, Troncoso C. Synthetic Data – Anonymisation Groundhog Day. USENIX Security 2022:1451–1468. arXiv:2011.07018
18. Ganev G, De Cristofaro E. The Inadequacy of Similarity-Based Privacy Metrics: Privacy Attacks Against "Truly Anonymous" Synthetic Datasets. IEEE S&P 2025:4007–4025. doi:10.1109/SP61157.2025.00218（预印本 arXiv:2312.05114）
19. Fang Z, Jiang Z, Chen H, Li X, Li J. Understanding and Mitigating Memorization in Diffusion Models for Tabular Data. ICML 2025, PMLR 267:15976–16005. arXiv:2412.11044
20. McKenna R, Miklau G, Sheldon D. Winning the NIST Contest: A scalable and general approach to differentially private synthetic data. J Priv Confid 2021;11(3). doi:10.29012/jpc.778
21. McKenna R, Mullins B, Sheldon D, Miklau G. AIM: An Adaptive and Iterative Mechanism for Differentially Private Synthetic Data. Proc VLDB Endow 2022;15(11):2599–2612. doi:10.14778/3551793.3551817
22. Tao Y, McKenna R, Hay M, Machanavajjhala A, Miklau G. Benchmarking Differentially Private Synthetic Data Generation Algorithms. arXiv:2112.09238（v2 2022）
23. Ganev G, Oprisanu B, De Cristofaro E. Robin Hood and Matthew Effects: Differential Privacy Has Disparate Impact on Synthetic Data. ICML 2022, PMLR 162:6944–6959.
24. Raghunathan TE, Reiter JP, Rubin DB. Multiple imputation for statistical disclosure limitation. J Off Stat 2003;19(1):1–16.
25. National Academies of Sciences, Engineering, and Medicine. Foundational Research Gaps and Future Directions for Digital Twins. Washington, DC: The National Academies Press; 2024 (released Dec 2023). doi:10.17226/26894
26. Van Calster B, Nieboer D, Vergouwe Y, De Cock B, Pencina MJ, Steyerberg EW. A calibration hierarchy for risk models was defined: from utopia to empirical data. J Clin Epidemiol 2016;74:167–176. doi:10.1016/j.jclinepi.2015.12.005
27. Austin PC, Harrell FE Jr, van Klaveren D. Graphical calibration curves and the integrated calibration index (ICI) for survival models. Stat Med 2020;39(21):2714–2742. doi:10.1002/sim.8570
28. Gneiting T, Raftery AE. Strictly Proper Scoring Rules, Prediction, and Estimation. J Am Stat Assoc 2007;102(477):359–378. doi:10.1198/016214506000001437
29. Schmidgall S, Ziaei R, Harris C, Reis E, Jopling J, Moor M. AgentClinic: a multimodal agent benchmark to evaluate AI in simulated clinical environments. arXiv:2405.07960（2024）
30. Li J, Wang S, Zhang M, et al. Agent Hospital: A Simulacrum of Hospital with Evolvable Medical Agents. arXiv:2405.02957（2024）
31. Wang R, Milani S, Chiu JC, et al. PATIENT-Ψ: Using Large Language Models to Simulate Patients for Training Mental Health Professionals. EMNLP 2024. arXiv:2405.19660
32. Bisbee J, Clinton JD, Dorff C, Kenkel B, Larson JM. Synthetic Replacements for Human Survey Data? The Perils of Large Language Models. Political Analysis 2024;32(4):401–416. doi:10.1017/pan.2024.5
33. Wang A, Morgenstern J, Dickerson JP. Large language models that replace human participants can harmfully misportray and flatten identity groups. Nat Mach Intell 2025;7:400–411. doi:10.1038/s42256-025-00986-z
34. Allen RJ, Rieger TR, Musante CJ. Efficient Generation and Selection of Virtual Populations in Quantitative Systems Pharmacology Models. CPT Pharmacometrics Syst Pharmacol 2016;5(3):140–146. doi:10.1002/psp4.12063
35. Baron KT. mrgsolve: Simulate from ODE-Based Models. R package. https://CRAN.R-project.org/package=mrgsolve
36. Wang W, Hallow KM, James DA. A Tutorial on RxODE: Simulating Differential Equation Pharmacometric Models in R. CPT Pharmacometrics Syst Pharmacol 2016;5(1):3–10. doi:10.1002/psp4.12052；rxode2: https://CRAN.R-project.org/package=rxode2
37. Fidler M, Wilkins JJ, Hooijmaijers R, et al. Nonlinear Mixed-Effects Model Development and Simulation Using nlmixr and Related R Open-Source Packages. CPT Pharmacometrics Syst Pharmacol 2019;8(9):621–633. doi:10.1002/psp4.12445；nlmixr2: https://CRAN.R-project.org/package=nlmixr2
38. Lippert J, Burghaus R, Edginton A, et al. Open Systems Pharmacology Community—An Open Access, Open Source, Open Science Approach to Modeling and Simulation in Pharmaceutical Sciences. CPT Pharmacometrics Syst Pharmacol 2019;8(12):878–882. doi:10.1002/psp4.12473
39. Jin Q, Wang Z, Floudas CS, et al. Matching patients to clinical trials with large language models. Nat Commun 2024;15:9074. doi:10.1038/s41467-024-53081-z
40. Gupta S, Basu A, Nievas M, et al. PRISM: Patient Records Interpretation for Semantic clinical trial Matching system using large language models. npj Digit Med 2024;7:305. doi:10.1038/s41746-024-01274-7（OncoLLM 为该研究内的 14B 微调模型；预印本 arXiv:2404.15549）
41. Stubbs A, Filannino M, Soysal E, Henry S, Uzuner Ö. Cohort selection for clinical trials: n2c2 2018 shared task track 1. J Am Med Inform Assoc 2019;26(11):1163–1171. doi:10.1093/jamia/ocz163
42. Roberts K, Demner-Fushman D, Voorhees EM, Bedrick S, Hersh WR. Overview of the TREC 2022 Clinical Trials Track. TREC 2022. https://trec.nist.gov/pubs/trec31/papers/Overview_trials.pdf （2021 版见 TREC 30 论文集）
43. Zhang N, Chen M, Bi Z, et al. CBLUE: A Chinese Biomedical Language Understanding Evaluation Benchmark. ACL 2022:7888–7915. doi:10.18653/v1/2022.acl-long.544（CHIP-CTC 规模与基线见 arXiv:2106.08087 v6）
44. Unlu O, et al. Manual vs AI-Assisted Prescreening for Trial Eligibility Using Large Language Models—A Randomized Clinical Trial. JAMA 2025;333(12):1084–1087. doi:10.1001/jama.2024.28047
45. ICH M11 Guideline, Clinical Study Protocol Template and Technical Specification（CeSHarP），Step 4 2025-11-19；EMA 采纳与生效信息：https://www.ema.europa.eu/en/ich-m11-guideline-clinical-study-protocol-template-technical-specifications-scientific-guideline ；FDA 最终指南公告 2026-05-22（docket FDA-2022-D-3054）
46. CDISC / TransCelerate. Digital Data Flow & Unified Study Definitions Model（USDM）v4.0，2025-06-03. https://www.cdisc.org/ddf ；https://github.com/cdisc-org/DDF-RA
47. ICH E9(R1) Addendum on Estimands and Sensitivity Analysis in Clinical Trials. Step 4, 20 Nov 2019. https://database.ich.org/sites/default/files/E9-R1_Step4_Guideline_2019_1203.pdf
48. OHDSI. circe-be v1.14.1（2026-09-24）与 CirceR v1.3.3. https://github.com/OHDSI/circe-be ；https://github.com/OHDSI/CirceR
49. CDISC. ADaM Implementation Guide v1.3（2021-11-29）. https://www.cdisc.org/standards/foundational/adam
50. Kahn MG, Callahan TJ, Barnard J, et al. A Harmonized Data Quality Assessment Terminology and Framework for the Secondary Use of Electronic Health Record Data. eGEMs 2016;4(1):18. doi:10.13063/2327-9214.1244
51. Blacketer C, Defalco FJ, Ryan PB, Rijnbeek PR. Increasing trust in real-world evidence through evaluation of observational data quality. J Am Med Inform Assoc 2021;28(10):2251–2257. doi:10.1093/jamia/ocab132；README: https://github.com/OHDSI/DataQualityDashboard
52. Gatto NM, Campbell UB, Rubinstein E, et al. The Structured Process to Identify Fit-For-Purpose Data: A Data Feasibility Assessment Framework. Clin Pharmacol Ther 2022;111(1):122–134. doi:10.1002/cpt.2466
53. Czado C. Analyzing Dependent Data with Vine Copulas. Springer, 2019. doi:10.1007/978-3-030-13785-4
54. Patki N, Wedge R, Veeramachaneni K. The Synthetic Data Vault. IEEE DSAA 2016:399–410. doi:10.1109/DSAA.2016.49
55. Zhao Z, Kunar A, Birke R, Van der Scheer H, Chen LY. CTAB-GAN+: enhancing tabular data synthesis. Front Big Data 2023;6:1296508（online 2024-01-08）. doi:10.3389/fdata.2023.1296508
56. Shi J, Xu M, Hua H, Zhang H, Ermon S, Leskovec J. TabDiff: a Mixed-type Diffusion Model for Tabular Data Generation. ICLR 2025. arXiv:2410.20626
57. Qian Z, Davis R, van der Schaar M. Synthcity: a benchmark framework for diverse use cases of tabular synthetic data. NeurIPS 2023 Datasets & Benchmarks. doi:10.52202/075280-0140；预印本 Qian Z, Cebere BC, van der Schaar M. arXiv:2301.07573；PyPI 0.2.12（Apache-2.0）
58. Walonoski J, Kramer M, Nichols J, et al. Synthea: An approach, method, and software mechanism for generating synthetic patients and the synthetic electronic health care record. J Am Med Inform Assoc 2018;25(3):230–238. doi:10.1093/jamia/ocx079；Synthea v4.0.0（2026-03-05）；Generic Module Framework: https://github.com/synthetichealth/synthea/wiki/Generic-Module-Framework
59. Yoon J, Jarrett D, van der Schaar M. Time-series Generative Adversarial Networks. NeurIPS 2019.
60. Chen J, Chun D, Patel M, Chiang E, James J. The validity of synthetic clinical data: a validation study of a leading synthetic data generator (Synthea) using clinical quality measures. BMC Med Inform Decis Mak 2019;19:44. doi:10.1186/s12911-019-0793-0
61. DataCebo. SDV（Synthetic Data Vault）1.38.4，PyPI 2026-09-25；LICENSE: Business Source License 1.1 with Additional Use Grant（excludes a "Synthetic Data Service"；每版本四年后转 MIT）. https://pypi.org/project/sdv/ ；https://github.com/sdv-dev/SDV/blob/main/LICENSE
62. DataCebo. SDMetrics 0.32.0（MIT）：Privacy metrics — DCRBaselineProtection, DCROverfittingProtection, DisclosureProtection. https://docs.sdv.dev/sdmetrics/data-metrics/privacy
63. OpenDP. smartnoise-synth 1.0.8（MIT；MWEM、MST、AIM、DP-CTGAN、PATE-CTGAN、PATE-GAN、QUAIL）：https://github.com/opendp/smartnoise-sdk ；McKenna R. private-pgm（mbi 2.0.0，Apache-2.0）：https://github.com/ryan112358/private-pgm
64. Yan C, Yan Y, Wan Z, et al. A multifaceted benchmarking of synthetic electronic health record generation models. Nat Commun 2022;13:7609. doi:10.1038/s41467-022-35295-1
65. Raab GM, Nowok B, Dibben C. Practical privacy metrics for synthetic data. arXiv:2406.16826（2024；v6 2026-09-01；亦作为 synthpop vignette）. https://arxiv.org/abs/2406.16826
66. Guyot P, Ades AE, Ouwens MJ, Welton NJ. Enhanced secondary analysis of survival data: reconstructing the data from published Kaplan-Meier survival curves. BMC Med Res Methodol 2012;12:9. doi:10.1186/1471-2288-12-9
67. Liu N, Zhou Y, Lee JJ. IPDfromKM: reconstruct individual patient data from published Kaplan-Meier survival curves. BMC Med Res Methodol 2021;21:111. doi:10.1186/s12874-021-01308-8
68. Morris TP, White IR, Crowther MJ. Using simulation studies to evaluate statistical methods. Stat Med 2019;38(11):2074–2102. doi:10.1002/sim.8086
69. Carlini N, Chien S, Nasr M, Song S, Terzis A, Tramèr F. Membership Inference Attacks From First Principles. IEEE S&P 2022:1897–1914. doi:10.1109/SP46214.2022.9833649
70. van Breugel B, Sun H, Qian Z, van der Schaar M. Membership Inference Attacks against Synthetic Data through Overfitting Detection (DOMIAS). AISTATS 2023, PMLR 206:3493–3514. arXiv:2302.12580
71. Fang Z, et al. A Closer Look on Memorization in Tabular Diffusion Model: A Data-Centric Perspective. TMLR 2026. arXiv:2505.22322
72. Zhang J, Cormode G, Procopiuc CM, Srivastava D, Xiao X. PrivBayes: Private Data Release via Bayesian Networks. SIGMOD 2014:1423–1434, doi:10.1145/2588555.2588573；ACM Trans Database Syst 2017;42(4):1–41, doi:10.1145/3134428
73. Fang ML, Dhami DS, Kersting K. DP-CTGAN: Differentially Private Medical Data Generation Using CTGANs. AIME 2022, LNCS:178–188. doi:10.1007/978-3-031-09342-5_17
74. Rieger TR, Allen RJ, Bystricky L, et al. Improving the generation and selection of virtual populations in quantitative systems pharmacology models. Prog Biophys Mol Biol 2018;139:15–22. doi:10.1016/j.pbiomolbio.2018.06.002
75. Klinke DJ. Integrating epidemiological data into a mechanistic model of type 2 diabetes: validating the prevalence of virtual patients. Ann Biomed Eng 2008;36(2):321–334. doi:10.1007/s10439-007-9410-y
76. Schmidt BJ, Casey FP, Paterson T, Chan JR. Alternate virtual populations elucidate the type I interferon signature predictive of the response to rituximab in rheumatoid arthritis. BMC Bioinformatics 2013;14:221. doi:10.1186/1471-2105-14-221
77. Jamei M, Marciniak S, Feng K, Barnett A, Tucker G, Rostami-Hodjegan A. The Simcyp population-based ADME simulator. Expert Opin Drug Metab Toxicol 2009;5(2):211–223. doi:10.1517/17425250802691074
78. Open Systems Pharmacology. PK-Sim documentation: Creating individuals / populations (built-in population databases). https://docs.open-systems-pharmacology.org （未核实）
79. Guest EJ, Aarons L, Houston JB, Rostami-Hodjegan A, Galetin A. Critique of the two-fold measure of prediction success for ratios: application for the assessment of drug-drug interactions. Drug Metab Dispos 2011;39(2):170–173. doi:10.1124/dmd.110.036103
80. Bender R, Augustin T, Blettner M. Generating survival times to simulate Cox proportional hazards models. Stat Med 2005;24(11):1713–1723. doi:10.1002/sim.2059
81. Brilleman SL, Wolfe R, Moreno-Betancur M, Crowther MJ. Simulating Survival Data Using the simsurv R Package. J Stat Softw 2021;97(3). doi:10.18637/jss.v097.i03
82. Royston P, Parmar MKB. Restricted mean survival time: an alternative to the hazard ratio for the design and analysis of randomized trials with a time-to-event outcome. BMC Med Res Methodol 2013;13:152. doi:10.1186/1471-2288-13-152
83. Daniel R, Zhang J, Farewell D. Making apples from oranges: Comparing noncollapsible effect estimators and their standard errors after adjustment for different covariate sets. Biom J 2021;63(3):528–557. doi:10.1002/bimj.201900297
84. Fisher CK, Smith AM, Walsh JR; Coalition Against Major Diseases. Machine learning for comprehensive forecasting of Alzheimer's Disease progression. Sci Rep 2019;9:13622. doi:10.1038/s41598-019-49656-2
85. Walsh JR, Smith AM, Pouliot Y, et al. Generating Digital Twins with Conditional Restricted Boltzmann Machines. arXiv (2020). （未核实）
86. Lang A, et al. Neural Boltzmann Machines. arXiv (2023). （未核实）
87. Schuler A, Walsh D, Hall D, et al. Increasing the efficiency of randomized trial estimates via linear adjustment for a prognostic score. Int J Biostat 2022;18(2):329–356. doi:10.1515/ijb-2021-0072
88. European Medicines Agency. Qualification opinion for Prognostic Covariate Adjustment (PROCOVA™). 2022. https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf
89. Steinberg E, Jung K, Fries JA, Corbin CK, Pfohl SR, Shah NH. Language models are an effective representation learning technique for electronic health record data. J Biomed Inform 2021;113:103637. doi:10.1016/j.jbi.2020.103637
90. Wornow M, Thapa R, Steinberg E, Fries JA, Shah NH. EHRSHOT: An EHR Benchmark for Few-Shot Evaluation of Foundation Models. NeurIPS 2023 Datasets & Benchmarks. arXiv:2307.02028
91. Steinberg E, Fries JA, Xu Y, Shah NH. MOTOR: A Time-To-Event Foundation Model For Structured Medical Records. ICLR 2024. arXiv:2301.03150
92. Renc P, Jia Y, Samir AE, et al. Zero shot health trajectory prediction using transformer. npj Digit Med 2024;7:256. doi:10.1038/s41746-024-01235-0
93. Kraljevic Z, Bean D, Shek A, et al. Foresight—a generative pretrained transformer for modelling of patient timelines using electronic health records: a retrospective modelling study. Lancet Digit Health 2024;6(4):e281–e290. doi:10.1016/S2589-7500(24)00025-6
94. Shmatko A, Jung AW, Gaurav K, et al. Learning the natural history of human disease with generative transformers. Nature 2025;647:248–256（online 2025-09-17）. doi:10.1038/s41586-025-09529-3
95. Makarov N, Bordukova M, et al. Large language models forecast patient health trajectories enabling digital twins. （期刊与 DOI 未核实）
96. Wang Y, Fu T, Xu Y, et al. TWIN-GPT: Digital Twins for Clinical Trials via Large Language Model. arXiv:2404.01273（2024）
97. Epic / Microsoft. Generative Medical Event Models (CoMET) trained on Epic Cosmos. arXiv (2025). （未核实）
98. Argyle LP, Busby EC, Fulda N, Gubler JR, Rytting C, Wingate D. Out of One, Many: Using Language Models to Simulate Human Samples. Political Analysis 2023;31(3):337–351. doi:10.1017/pan.2023.2
99. ICH M15: General Principles for Model-Informed Drug Development; FDA page: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/m15-general-principles-model-informed-drug-development
100. ASME V&V 40-2018. Assessing Credibility of Computational Modeling through Verification and Validation: Application to Medical Devices. ASME, 2018.
101. U.S. FDA. Assessing the Credibility of Computational Modeling and Simulation in Medical Device Submissions. Final guidance, November 2023.
102. Jordan A, Krüger F, Lerch S. Evaluating Probabilistic Forecasts with scoringRules. J Stat Softw 2019;90(12):1–37. doi:10.18637/jss.v090.i12
103. Van Calster B, McLernon DJ, van Smeden M, Wynants L, Steyerberg EW. Calibration: the Achilles heel of predictive analytics. BMC Med 2019;17:230. doi:10.1186/s12916-019-1466-7
104. Collins GS, Moons KGM, Dhiman P, et al. TRIPOD+AI statement: updated guidance for reporting clinical prediction models that use regression or machine learning methods. BMJ 2024;385:e078378. doi:10.1136/bmj-2023-078378
105. Gallifant J, Afshar M, Ameen S, et al. The TRIPOD-LLM reporting guideline for studies using large language models. Nat Med 2025;31:60–69. doi:10.1038/s41591-024-03425-5
106. Moons KGM, Damen JAA, Kaul T, et al. PROBAST+AI: an updated quality, risk of bias, and applicability assessment tool for prediction models using regression or artificial intelligence methods. BMJ 2025;388:e082505. doi:10.1136/bmj-2024-082505
107. Romano Y, Patterson E, Candès EJ. Conformalized Quantile Regression. NeurIPS 2019. arXiv:1905.03222
108. Candès E, Lei L, Ren Z. Conformalized survival analysis. J R Stat Soc Series B 2023;85(1):24–45. doi:10.1093/jrsssb/qkac004
109. Tibshirani RJ, Barber RF, Candès EJ, Ramdas A. Conformal Prediction Under Covariate Shift. NeurIPS 2019. arXiv:1904.06019
110. NIH/NLM. TrialGPT FAQ. https://www.ncbi.nlm.nih.gov/research/trialgpt/faq/
111. Fang Y, et al. Towards AI-Assisted Clinical Trial Matching: Practical Considerations, Multicenter Evaluation, and Real-World Deployment（TrialGPT 2.0）. arXiv:2609.01202（2026-09-01，预印本）
112. Wornow M, Lozano A, Dash D, Jindal J, Mahaffey KW, Shah NH. Zero-shot clinical trial patient matching with LLMs. NEJM AI 2025;2(1):AIcs2400360. doi:10.1056/AIcs2400360（文中数值取自预印本 arXiv:2402.05125v2）
113. Unlu O, Shin J, Mailly CJ, et al. Retrieval-Augmented Generation–Enabled GPT-4 for Clinical Trial Screening. NEJM AI 2024;1(7). doi:10.1056/AIoa2400181（文中数值取自 medRxiv 预印本 doi:10.1101/2024.02.08.24302376）
114. Wang K, et al. Evaluation of an artificial intelligence-based clinical trial matching system in Chinese patients with hepatocellular carcinoma. BMC Cancer 2024;24:246. doi:10.1186/s12885-024-11959-7
115. Gui X, et al. Enhancing hepatopathy clinical trial efficiency: a secure, large language model-powered pre-screening pipeline. BioData Min 2025;18:42. doi:10.1186/s13040-025-00458-5
116. Yang L, et al. EC2Seq2Sql: Patient-trial matching with LLM agents. PLoS One 2026;21(2):e0341827. doi:10.1371/journal.pone.0341827
117. Kang T, Zhang S, Tang Y, et al. EliIE: An open-source information extraction system for clinical trial eligibility criteria. J Am Med Inform Assoc 2017;24(6):1062–1071. doi:10.1093/jamia/ocx019
118. Yuan C, Ryan PB, Ta C, et al. Criteria2Query: a natural language interface to clinical databases for cohort definition. J Am Med Inform Assoc 2019;26(4):294–305. doi:10.1093/jamia/ocy178
119. Park J, Fang Y, Ta C, et al. Criteria2Query 3.0: Leveraging generative large language models for clinical trial eligibility query generation. J Biomed Inform 2024;154:104649. doi:10.1016/j.jbi.2024.104649
120. Klein H, Mazor T, Siegel E, et al. MatchMiner: an open-source platform for cancer precision medicine. npj Precis Oncol 2022;6:69. doi:10.1038/s41698-022-00312-5
121. Altreuter J, et al. MatchMiner-AI: Open-source, Privacy-preserving Cancer Clinical Trial Matching using Artificial Intelligence. arXiv:2412.17228（v4 2026-08-12，预印本）
122. Kury F, Butler A, Yuan C, et al. Chia, a large annotated corpus of clinical trial eligibility criteria. Sci Data 2020;7:281. doi:10.1038/s41597-020-00620-0
123. Wang Z, Cao L, Danek B, et al. Accelerating clinical evidence synthesis with large language models. npj Digit Med 2025;8:509. doi:10.1038/s41746-025-01840-7
124. Yue L, Xing S, Chen J, Fu T. ClinicalAgent: Clinical Trial Multi-Agent System with Large Language Model-based Reasoning. ACM BCB 2024:1–10. doi:10.1145/3698587.3701359
125. Wang Z, Xiao C, Sun J. AutoTrial: Prompting Language Models for Clinical Trial Design. EMNLP 2023:12461–12472. doi:10.18653/v1/2023.emnlp-main.766
126. Lin J, Xu H, Wang Z, Wang S, Sun J. Panacea: A foundation model for clinical trial search, summarization, design, and recruitment. arXiv:2407.11007 / medRxiv doi:10.1101/2024.06.26.24309548（预印本）
127. Chen J, Hu Y, Cai M, et al. TrialBench: Multi-Modal AI-Ready Datasets for Clinical Trial Prediction. Sci Data 2025;12:1564. doi:10.1038/s41597-025-05680-8
128. Fu T, Huang K, Xiao C, Glass LM, Sun J. HINT: Hierarchical interaction network for clinical-trial-outcome predictions. Patterns 2022;3(4):100445. doi:10.1016/j.patter.2022.100445
129. Aliper A, Kudrin R, Polykovskiy D, et al. Prediction of Clinical Trials Outcomes Based on Target Choice and Clinical Trial Design with Multi-Modal Artificial Intelligence. Clin Pharmacol Ther 2023;114(5):972–980. doi:10.1002/cpt.3008
130. Swanson K, Wu W, Bulaong NL, Pak JE, Zou J. The Virtual Lab of AI agents designs new SARS-CoV-2 nanobodies. Nature 2025;646:716–723. doi:10.1038/s41586-025-09442-9
131. OHDSI. OMOP Common Data Model v5.5.0（2026-08-25）；v5.4 文档 https://ohdsi.github.io/CommonDataModel/ ；releases: https://github.com/OHDSI/CommonDataModel/releases
132. OHDSI. Eunomia: a standard dataset in the OMOP CDM for testing. https://github.com/OHDSI/Eunomia
133. HL7 FHIR R5（5.0.0，2023-03-26）：ResearchStudy / ResearchSubject / EvidenceVariable / Group. https://hl7.org/fhir/R5/researchstudy.html ；版本目录与 R6 投票：https://hl7.org/fhir/directory.html
134. CDISC. ADaM Basic Data Structure for Time-to-Event Analyses v1.0（CDISC 页面发布日期 2016-02-12）. https://www.cdisc.org/standards/foundational/adam
135. Gatto NM, Vititoe SE, Rubinstein E, et al. A Structured Process to Identify Fit-for-Purpose Study Design and Data to Generate Valid and Transparent Real-World Evidence for Regulatory Uses (SPIFD2). Clin Pharmacol Ther 2023;113(6):1235–1239. doi:10.1002/cpt.2883
136. 国家市场监督管理总局 / 国家标准化管理委员会. GB/T 15657-2021《中医病证分类与代码》（2021-10-11 发布并实施）；GB/T 16751.1-2023、16751.3-2023（2023-03-17）与 GB/T 16751.2-2021（2021-11-26）《中医临床诊疗术语》. https://std.samr.gov.cn
137. 《疾病分类与代码（国家临床版 2.0）》与《医疗保障疾病诊断分类与代码（医保版 2.0）》（发布机构文号与年份未核实）
138. Ming X, et al. ICD-11 pilot in West China: feasibility evaluation and implications for future implementation. Sci Rep 2026;16:25328. doi:10.1038/s41598-026-56119-y
