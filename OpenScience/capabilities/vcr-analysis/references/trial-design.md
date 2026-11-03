# Trial design

Part of the vcr-analysis skill: read it with [../SKILL.md](../SKILL.md), which holds what applies to every analysis. This part is for sample size, power, operating characteristics, design grids and the choice between designs.

## Reference: trial design

先用 `mcp__evimed__vcr_simulate` `action: "shape"` 看这条路最小的模板（`design_analytic` 和 `design_simulation` 各有两臂连续、二分类、事件时间三份，模板里只有研究自己的事实，别的平台替你补）和每个键的角色：`research_fact` 是只有研究能给的，其余你自己定、在回复里说用了什么值，不要问。写好之后 `action: "validate"` 当场检查，不排队、不等，回来的 `applied` 就是平台替你补的默认值，连同值写进回复，然后同一轮就 start。

按 ADEMP 五段组织场景，`mcp__evimed__vcr_write` `what: "trial_scenario"`，通常写三个方案并排比。`design` 和 `endpointType` 是对象自己的字段，其余都在 `configuration` 里，字段名就是引擎的字段名：

```json vcr:object:trial_scenario
{
  "label": "A 2:1 随机",
  "design": "two_arm_fixed",
  "endpointType": "time_to_event",
  "assumptionIds": ["hazard_ratio", "control_median_pfs", "dropout_rate"],
  "configuration": {
    "design": { "nTreat": 120, "nControl": 60, "allocation": 0.6667 },
    "analysis": { "method": "logrank", "alpha": 0.025, "sided": 1, "power": 0.9 },
    "accrual": { "kind": "uniform", "duration": 12, "followup": 12 },
    "performance": ["power"]
  }
}
```

```json vcr:object:trial_scenario
{
  "label": "B 1:1 加一次期中分析",
  "design": "group_sequential",
  "endpointType": "time_to_event",
  "configuration": {
    "design": { "nTreat": 90, "nControl": 90, "allocation": 0.5, "informationRates": [0.5, 1], "spending": "obrien_fleming" },
    "analysis": { "method": "logrank", "alpha": 0.025, "sided": 1, "power": 0.9 },
    "accrual": { "kind": "uniform", "duration": 12, "followup": 12 },
    "truth": { "hazardRatio": 0.7, "controlMedian": 6 }
  }
}
```

Supported designs are fixed two-arm (continuous/binary/time-to-event), group-sequential (time-to-event), and the single-arm paths: `single_arm` for a binary, continuous or time-to-event endpoint, and `simon_two_stage` and `single_arm_external`, which are binary only. Unsupported combinations are refused by name; never substitute two generated arms for a single-arm design.

- `single_arm`: `configuration.design.n`, `truth.nullRate` and `truth.responseRate`; `analysis.method: "exact_binomial"`, explicit `alternative: "greater" | "less" | "two.sided"` and matching `sided`. A response count succeeds exactly when its binomial p-value is at most alpha. Two-sided uses probability ordering (`stats::binom.test`), not a silently doubled one-sided tail. Rates zero/one are supported. Use sourced assumption cards for the actual rates and a declared proposed sample size; do not invent defaults.
- `single_arm` with a **continuous** endpoint: a mean compared with a fixed historical value, not with a generated control arm. `design.n`, `truth.benchmark` (the historical mean), `truth.effect` (the true mean minus the benchmark; 0 is the null) and `truth.sd`; `analysis.method: "one_sample_t"`, or `"one_sample_z"` with the known SD in `analysis.sd`, and an explicit `alternative` with the matching `sided`. The benchmark is a number you take from a sourced assumption card, never a default.
- `single_arm` with a **time-to-event** endpoint: `design.n`, the benchmark survival as `truth.controlMedian` (or `truth.controlDistribution`) and the effect as `truth.hazardRatio` (the trial's hazard over the benchmark's; 1 is the null); `analysis.method: "one_sample_logrank"`; `alternative: "less"` is a benefit (a hazard below the benchmark's) and `"greater"` is harm; `accrual` as for any time-to-event design. Analytic sample size is computed for the binary single-arm only: a continuous or time-to-event single-arm design is sized by simulation and the result says so.
- `simon_two_stage`: analytical search uses sourced null/alternative rates and the declared alpha/power/maxN. The selected optimal/minimax result supplies frozen `design.n1`, `n`, `r1`, `r` to `analysis.method: "simon_boundary"`, `sided: 1`; simulation states `truth.responseRate`. First-stage responses at most r1 stop for futility; a continued trial succeeds only above r total responses. The platform binds simulation to the selected analytical result version. Do not independently search boundaries inside replicates or guess omitted thresholds. Report rejection, PET and expected N with MCSE and exact reference; stopped sample proportions are naive estimates and adjusted sequential coverage is unavailable.
- `single_arm_external`: binary **synthetic two-stratum operating-characteristic scenarios**, not real or reconstructed external patients. State `design.n`, `truth.controlRates: [p00,p01]`, `truth.treatmentRates: [p10,p11]` and `external: {kind:"stratified_beta_binomial", n, targetPrevalence, sourcePrevalence, parameterInformation, logOddsDrift, sensitivityDrifts:[...]}`. Every field is a frozen, explicitly justified assumption. `analysis: {method:"stratified_risk_difference", estimand:"ATT", sided, alpha}` standardizes both means to the fixed treatment-target mixture. Historical stratum probabilities have finite beta parameter uncertainty; the analysis includes that uncertainty in a beta-binomial Wald variance. Report actual null calibration, bias, coverage, weighted external ESS, failures and drift sensitivity. Missing target-stratum support is not estimable. Increasing generated N never removes the declared parameter uncertainty or supplies real patients. Time drift, unmeasured confounding and finite-sample inference remain limitations; simulation is not clinical validation.

For these paths, zero-effect scenarios state `responseRate == nullRate` or zero target ATT. `truth.null` is a label and must agree with that law; changing a flag cannot create a null scenario. The usual 20,000/5,000 replicate floors, immutable seeds/checkpoints and cancellation preserve completed batches. New paths use design-method version 1.1.0; prior supported 1.0.0 scenarios remain replayable. Grid overrides use these actual size/rate/boundary keys and every projected cell is validated before enqueue. Single-arm continuous and time-to-event simulation and grids run at design-method version 1.2.0. Every single-arm design compares with a stated benchmark: say in the report where the benchmark came from and that it is held fixed.

**解析优先、仿真复核**：平台对每个方案先算解析结果再仿真，两者差异超出蒙特卡洛误差时结果里带着差值，你在报告里说出来。固定设计的效应有假设卡给出预测分布时，平台还会算成功把握（按证据的不确定性平均后的功效）；成组序贯设计也算，意思是在任一次期中或最终分析越过界值的概率（设计里的 `events` 是最大事件数，`informationRates` 是各次分析的位置）。重复次数不用你定：零假设情景默认不少于 2 万次（研究用途是指定分析或以上、或设计借用外部数据时不少于 10 万次），备择不少于 5,000 次，`targetMcse` 写了目标精度就按 p(1−p)/MCSE² 自动抬高。

**基准设计和一次一项的敏感性平台在解析阶段自己算，不加仿真**：成组序贯和 Simon 方案旁边，同一假设下的固定样本设计作为一行「基准」随主结果一起交；样本量对效应、对照组水平（中位时间或事件率）、脱落、入组时长各自单独变动的敏感性按移动幅度从大到小排好。事件时间终点、效应有利于试验时，还有一行“效应按已发表的计划—实测差距折减后的把握度”（取自一份肿瘤三期试验综述简报：计划 HR 0.66、实测 0.72，原文未核对，只说明计划的效应常被高估，不预测这项试验；二分类和连续终点没有这一行，也不用提）。转述时说清这三件事各是什么、哪个输入最敏感，不要把折减后的把握度说成这项试验会得到的把握度。

**问周期用入组模型**：被问「多久能入完」「整个研究要多久」时，默认用入组预测（`kind: "accrual_forecast"`，每个中心的入组率带分散的伽马—泊松模型），不要默认匀速入组——已发表的多中心试验里每中心每月入组的中位数不到 1 人，而且中心之间差得很远（Walters 2017），匀速假设会把周期算短。匀速入组只是设计网格里为了比样本量的简化。

**零效应情景平台会自己补**：两臂设计（固定样本或成组序贯）的备择模拟结果出来之后，自动再按“没有真实效应”跑一次，I 类错误和它的蒙特卡洛误差随后补进结果——你在对话里自己排的 `design_simulation` 也一样，你不必为此另写一个设计，也不要等它。单臂、Simon 设计和设计网格不补：要它们的 I 类错误，自己排一个零效应情景的模拟（网格里放一列 `truth.null: true`）。风险比随时间变化或 MaxCombo 的设计没有解析结果（不排 `design_analytic` 和成功把握），功效和 I 类错误都来自模拟，页面上会注明。比较设计和真值的组合用设计网格，`dimensions.designs` 列出设计，`truthScenarios` 列出真值情景，每一格的数字是引擎填的：

**非劣效设计**：问“界值 −10%，要多少人才能说不比老药差”用 `design_analytic` 和 `design_simulation`，在场景里加 `hypothesis: {"kind": "non_inferiority", "margin": 界值}`。界值是临床上的选择，向对方要，不要自己编；连续终点是结局单位里的差，二分类终点是小于 1 的率差，事件时间终点是大于 1 的风险比。`truth` 写的是预期的真实效应（常常是 0 或风险比 1），不是界值；检验是单侧的。要看 I 类错误，把 `truth` 放在界值上（均值差 −界值、率差 −界值、风险比 = 界值），这正是平台补跑的零效应情形。成组序贯设计同样可以带界值。

**确认性设计 `kind: "design_confirmatory"`**：下面这些问题各用一种 `design.kind`，先 `action: "shape"` 看字段。结果在“试验”页，答案里的 `resultEntry` 给了去处；每个数都是引擎算的，不要自己重算，也不要重新排版。
- 中期发现没戏就停，能省多少人：`futility_group_sequential`（有效性和无效性边界、期望样本量、每次分析的停止概率）。无效性边界默认不具约束力，要具约束力要在 `design.futility.binding` 里写明。
- 效应没把握，中期加样：`sample_size_reestimation`（中期按条件功效重定样本量，上限 `maxSampleSizeFactor` 倍；结果把固定设计和同样分析次数的成组序贯设计并排放在每个设想的效应旁边）。`truth.plannedEffect` 是计划按它定样本量的效应，`truth.effects` 是想看的真实效应。无效应一行平台自己补，I 类错误和无效应时的平均样本量都要在回复里说，这类设计在无效应时常常加样很多。
  - 只想在“有希望”的区间加样：写 `design.promisingZone: {"lower": 0.36, "upper": 0.8}`（中期条件功效的下限和上限）。条件功效低于下限或高于上限时保持原计划样本量，落在区间里才加到目标条件功效（上限仍是 `maxSampleSizeFactor` 倍）。区间是研究者的选择，不要替人编；没写就是每次中期都重算，无效应的试验也会加样，这时把“无效应时加样的概率”在回复里说出来。
- 几个剂量加一个对照，中期只留一个：`multi_arm_selection`（连续、二分类和事件时间终点；`plannedSize` 是每组的例数）。回答比“每个剂量各做一个试验”省多少、选中真正最好的臂的概率。
- 标志物阳性只占一部分，中期收窄入组：`enrichment`（连续、二分类和事件时间终点；`plannedSize` 是全人群的总例数，`subsetPrevalence` 是阳性所占比例；检验用 `simes` 或 `bonferroni`，`dunnett` 会被拒绝）。
  - 这两种设计的事件时间版本按计划事件数直接模拟各组的对数秩统计量，假定比例风险、各组对照风险相同，不模拟入组、随访和脱落：所以不写 `truth.controlMedian` 和 `accrual`，`plannedSize` 是事件数（多臂是最后分析时留下的臂加对照的总事件数），效应写风险比；结果以事件数计，回复里说清这个模拟方式（结果的前提里已列出）。
- 每年发作次数这类计数终点：`count_endpoint`（负二项，率比 `truth.rateRatio`，过度离散 `truth.overdispersion`；不知道过度离散就问，0 表示泊松，会把样本量算少；写了 `design.informationRates` 就是成组序贯）。
结果里的 `confirmatory.assumed` 是平台没得到说明而采用的值（消耗函数、条件功效、取自成组序贯设计的计划样本量、补的零效应行等），回复里逐条说明，不要略去。

**剂量探索设计 `kind: "design_dose"`**：先 `action: "shape"` 看字段。问“这条毒性曲线下，3+3 和 BOIN 选对剂量的概率、超量人数差多少”：`design.kind` 写所问的设计（`three_plus_three`、`boin`、`keyboard`、`crm`），`design.compare` 写要并排比的其他设计，`truth.toxicity` 是各剂量的真实毒性率（按剂量从低到高，向对方要，不要编）。几种设计用同一条曲线、同一批随机数，结果并排给出，并给出各设计与所问设计的差和它自己的误差；在回复里报这些数，不要自己重算。结果在“试验”页。
- 目标毒性率（默认 0.3）、每组人数（3）、最多人数（30）、起始剂量（1）、CRM 的先验骨架、BOIN 和 Keyboard 的区间宽度，对方没说就用默认；结果里的 `doseFinding.assumed` 逐条列出，回复里逐条说，尤其是 CRM 的骨架（取自“先验认为最大耐受剂量在起始剂量”，对结果影响很大，对方有就问他要）。3+3 的人数由规则决定，不受“最多人数”限制。
- “选对”指选到真实毒性最接近目标的剂量（并列取较低的）；“超量”指给到比它更高剂量的患者数。结果里没有任何一种设计被说成“获认可”或“已认定”，你也不要这样说：BOIN 在这里只是局部（local）边界、无信息先验的版本，联合用药和迟发毒性不在其中，这一条回复里要带上。
- 两个或三个剂量随机分组、问“每个剂量各多少人，才有 90% 概率选到更低而不差的剂量”：`design.kind: "randomized_selection"`，`design.margin` 是更高剂量要比候选剂量好多少才被选中（临床上的选择，向对方要），`truth.responseScenarios` 是几组各剂量的真实缓解率（至少一组“更高剂量并不更好”，一组“更高剂量确实更好”）。不写 `design.perArm` 就搜索满足 `design.targetProbability`（默认 0.9）的人数，结果给出第一次达到的人数和此后一直达到的人数——判定是整数个数，概率会随人数上下起伏，两个数都要说。这是精确计算，没有模拟误差。

**贝叶斯设计 `kind: "design_bayesian"`**：先 `action: "shape"` 看字段，每个数都是精确算出的（没有蒙特卡洛误差）。
- 问“单臂每 10 人看一次，何时停，比 Simon 少多少人”：`design.kind: "bop2"`（或 `predictive_monitoring`），`design.maxN`、`design.lookEvery`，`truth.nullRate` 和 `truth.alternativeRate`，`analysis.alpha`（默认 0.05）和 `analysis.power`（默认 0.8）。结果给出每次分析的停止规则、两种有效率下的 I 类错误、功效、期望样本量，并把 Simon 最优和最小最大设计放在旁边，节省的人数是结果里两个数的差。问“比 Simon 少多少人”时用 `design.objective: "min_expected_n"`（在 I 类错误不超过规定水平、功效达到要求的设计里取无效应时期望样本量最少的）；默认的 `max_power` 取功效最大的，通常更大，两者节省的含义不同，回复里说用了哪一个。有效率的先验默认是均值落在零假设有效率上、信息量相当于一个人的 Beta；没说就按默认并说明。
- 预测概率监测的最终阈值不是一个数而是一个区间（区间内任一阈值得到同一条规则）；结果给的是区间，回复里照说。
- 问“用这个先验和阈值，I 类错误多少，校到 0.025 的阈值是多少”：`design.kind: "threshold_calibration"`，`endpoint.type`（连续型要 `truth.sd` 视为已知；事件时间型用 `design.events`；二分类型两组各有 Beta 先验），`design.priorEffect` 是效应的正态先验（不写就是无先验信息），`design.threshold` 是对方给的阈值，`design.margin` 是后验概率要超过的效应界值。结果有三行：对方给的阈值、常规的 1 − α、校准后的阈值（二分类是 I 类错误不超过规定水平的最小阈值，并注明实际达到的水平）。信息性的先验会让同一个阈值的 I 类错误偏离规定水平，这正是要校准的原因。动态借用和需要 MCMC 的模型不在这里。

**分层复合终点的胜率比 `kind: "design_win_ratio"`**：先 `action: "shape"` 看字段。问“死亡、住院次数、KCCQ 三层比较，要多少人，平局占多少”：`truth.death`（`hazardRatio`，加 `controlRisk`——对照组随访期内死亡的比例——或 `controlMedian`）是第一层，`truth.events`（`controlRate` 每人每个时间单位的事件数、`rateRatio`、`overdispersion`）是第二层，少者胜，`truth.score`（`shift` 试验组比对照组在期末高多少、`sd`、`threshold`：相差不超过它算平局）是第三层，高者胜；死亡必写，事件和评分至少写一个。`design.followup` 是每人随访多久，`design.dropoutAnnual` 是每年退出的比例。写 `design.nTreat`（和 `nControl`）得到功效；不写人数而写 `analysis.power` 得到每组所需人数（模拟搜出来，再按这个人数模拟一次验证功效，两个数都在结果里）：二者写一个，不要都写。结果有胜率比（赢的对数除以输的对数，旁边是同样大小的一次试验会落在什么范围）、净胜率、胜算比和平局占多少，以及每一层分出了多少胜负、到这一层还剩多少平局。回复里把平局占比和净胜率一起说，只说一个比值会盖住大量平局。三层之间用一个相关（`truth.correlation`，默认 0.3：病情重的人每一层都更差）连起来，事件层通过 `overdispersion` 接上它；这些默认值结果里都列为前提，照实说。人数是模拟得到的：不要用公式的人数替代，也不要自己把几个结果换算。预算不够时结果会标“只模拟了一部分”，照说。

**MaxCombo 旁边的 log-rank 与强零假设**：`analysis.method: "maxcombo"` 的结果同一批模拟里还给出 log-rank 的功效（`power_logrank`）；并给出强零假设（试验组从不优于对照、早期更差、之后相同，由设计推出）下 MaxCombo 与 log-rank 各自判为更优的概率。这是信息，不是拒绝的理由；回复里把两个数和名义水平一起说。

**改良加权 log-rank（折中）**：人说“既怕延迟效应，又怕假阳性，有没有折中”，才用 `analysis.method: "modestly_weighted"`（Magirr 与 Burman 的检验：晚期事件的权重是早期的 1/`sStar` 倍封顶，`sStar` 默认 0.5；固定两臂和成组序贯都可以）。按它防什么来说：偏重晚期的检验（MaxCombo、晚期加权）在效应晚起时功效好，但试验组前期更差、之后一样时，会把前期的差当成晚期的差而判成更优；改良加权给晚期权重封了顶，所以前期的损害仍然压着结论，晚期的获益也还能被看到。它不是默认，也不是“更稳妥”的选择，没人提这类担心就用 log-rank；结果同一批模拟里给出 log-rank 的功效，并和 MaxCombo 一样给出强零假设下两个检验各自判为更优的概率，回复里把几个数和名义水平一起说。

**成组序贯里用 MaxCombo 或改良加权**（`design.kind: "group_sequential"` 加 `analysis.method: "maxcombo"` 或 `"modestly_weighted"`，延迟起效下想中途看数据）：这类设计的边界没有公式，引擎在“没有效应”的情形下把这个设计（同样的入组、脱落、人数和对照）模拟一遍，每次分析都算这个统计量，按分析次数把计划的 α 逐次花掉来定边界（花多少仍由 `spending` 和各次的信息比例决定）。功效和 I 类错误来自另一轮、另一个种子的模拟，所以零效应情形报告的 I 类错误是对边界的独立核对。结果的 `groupSequentialBoundaries` 说边界依据多少次零效应试验、每次分析的边界、计划和实际花掉的 α，计划花掉的 α 不到一次试验的那次分析不可能停下，也会列出。边界这一轮就要约 20,000 次该设计的模拟，试验大时整个作业可能只跑完一部分，结果标“只模拟了一部分”，照说。log-rank 的功效并排给出（用它自己的渐近边界），强零假设也同固定设计一样报告。不是默认，也不比 log-rank 更稳妥；没人提延迟起效或曲线交叉这类担心，就用 log-rank。

```json vcr:object:design_grid
{
  "dimensions": {
    "designs": [
      { "label": "每组 100", "kind": "two_arm_fixed", "nTreat": 100, "nControl": 100 },
      { "label": "每组 200", "kind": "two_arm_fixed", "nTreat": 200, "nControl": 200 }
    ],
    "base": {
      "endpoint": { "type": "binary" },
      "analysis": { "method": "risk_difference", "alpha": 0.025, "sided": 1 },
      "performance": ["power"]
    }
  },
  "truthScenarios": [
    { "label": "零效应", "controlRate": 0.3, "treatmentRate": 0.3 },
    { "label": "有效应", "controlRate": 0.3, "treatmentRate": 0.45 }
  ],
  "comparisonGoal": { "text": "在零效应下 I 类错误不超过 2.5%，有效应下功效尽量高", "measures": [{ "name": "power", "direction": "higher" }] }
}
```

一句话问样本量：先写一个试验方案，再用它的 id 作为 `subjectId` 排一个解析作业（解析作业按效应算样本量，零效应——风险比 1、效应 0、两组率相同——没有样本量，会被拒绝并指向这一句；方案的 I 类错误对零效应情景排 `design_simulation` 来测，不要问 `design_analytic`）：

```json vcr:design_analytic
{
  "design": { "kind": "two_arm_fixed" },
  "endpoint": { "type": "time_to_event" },
  "truth": { "hazardRatio": 0.7, "controlMedian": 6 },
  "analysis": { "alpha": 0.025, "power": 0.9, "sided": 1 },
  "accrual": { "duration": 24, "followup": 12 }
}
```

**风险比随时间变（只在仿真里）**：延迟起效、曲线交叉的真值写成 `truth.treatmentHazardRatios: {"breaks": [3], "ratios": [1, 0.6]}`（`ratios` 比 `breaks` 多一个，第一段从时间 0 起），不写 `hazardRatio`；只有固定两臂和成组序贯的 `design_simulation`、`design_grid` 接受，`design_analytic` 和 `assurance` 按名拒绝并指向仿真。分析默认仍是 `logrank`，不要替人换；`maxcombo` 不是默认，也不是“更稳妥”的选择，只在人明确提出延迟起效、曲线晚分开或交叉这类假设时，才把 `analysis.method: "maxcombo"`（四个 Fleming–Harrington 加权对数秩统计量取最大，p 值按它们的联合零分布读；固定两臂和成组序贯都可以，见下）作为并排的另一个方案；人没提这类假设就不用。没有单一的真风险比，所以结果里没有偏倚、MSE、覆盖率和解析核对，别替它补。两个方案的功效并排说，不要只说 MaxCombo 更高：它在晚分开或交叉时占优，比例风险下对数秩常常不差。

**设计网格里同一设计的几个真值共用一条随机流**（design.grid 1.3.0，两臂设计）：同一批受试者在每个真值下各走一遍，所以相邻两格功效的差比两次独立仿真的差稳得多（这个引擎上实测，方差降到约 14%（连续终点）和 42%（对数秩））；不同设计之间、单臂设计各格不配对，结果的 `seedPolicy` 说是哪一种。比较相邻真值就读这个差，不必再另跑一遍。

### 几个方案并排时的建议

平台按方案自己的 α 和目标功效（或研究者写下的比较目标）画样本量对功效的权衡图，没达标的数字旁有「未达标」或「接近」的标记，平台不替人选，也不叫哪个「最佳」。你在回复最后给**一句**建议，并说明是哪一条约束决定的（I 类错误上限、目标功效、样本量还是周期），数字取自结果，选择仍然归研究者。

### 成功把握旁边的历史通过率

成功把握是引擎按你设定的效应和不确定性算出的数。想知道“这个领域、这一阶段，过去的项目通过的比例”，读 `vcr_read`（`what: "success_rates"`，`filter.kind` 写 `phase1`、`phase2` 或 `phase3`，`filter.query` 写适应症的名字或 id；都不写就给全部适应症的三个阶段）。结果里有两个来源并排：BIO 2011–2020 和 Wong 2019，各自统计的方法、年代和终点不同（一个三期统计到提交申报、一个统计到获批），不要合并，不要取平均，两个都写。它说的是过去项目的通过率，不是这个试验成功的概率：写成“历史上这一阶段的通过率”，放在成功把握旁边做对照，不要拿它改设计的数。页面上，有成功把握的方案旁边已经带着这张参照表，可以不重复抄数。

### 假设卡里的数

效应卡（key 是 `hazard_ratio`、`treatment_event_rate`、`risk_difference`、`odds_ratio`、`mean_difference` 这几个）写 `effectRole`：`important_difference`（重要差异：研究认为值得发现的最小差异）或 `realistic_expectation`（现实预期：实际预期的差异）。这是两个不同的数，效应又是最常出错的输入。不写也保存、照常计算，写入的答复会提醒你补，补上就再写一个版本。

平台把假设卡的设定值放进场景，靠的是卡的 `key`：`hazard_ratio`→`truth.hazardRatio`，`control_median…`→`truth.controlMedian`，`dropout_rate`→`accrual.dropoutAnnual`，`control_event_rate`→`truth.controlRate`，`treatment_event_rate`→`truth.treatmentRate`，`risk_difference`、`odds_ratio`，`mean_difference`→`truth.effect`，`outcome_sd`→`truth.sd`。方案里同一参数写了数，也以卡为准。**改卡就是改场景**：新版本的卡进入新的作业，旧的结果标为已过期、由新结果取代，旧结果保留可查。方案 `assumptionIds` 指名了哪几张卡，就只用那几张。

### 报告里怎么写样本量

State normal-approximation sizing separately from the checked test power. Integer group counts must sum to the reported total. Correlation declared as cited is unavailable without verified matrix bindings; retain an explicit assumed correlation and its sensitivity rather than claiming it was sourced.
