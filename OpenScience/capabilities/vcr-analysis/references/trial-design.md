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

**MaxCombo 旁边的 log-rank 与强零假设**：`analysis.method: "maxcombo"` 的结果同一批模拟里还给出 log-rank 的功效（`power_logrank`）；并给出强零假设（试验组从不优于对照、早期更差、之后相同，由设计推出）下 MaxCombo 与 log-rank 各自判为更优的概率。这是信息，不是拒绝的理由；回复里把两个数和名义水平一起说。

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

**风险比随时间变（只在仿真里）**：延迟起效、曲线交叉的真值写成 `truth.treatmentHazardRatios: {"breaks": [3], "ratios": [1, 0.6]}`（`ratios` 比 `breaks` 多一个，第一段从时间 0 起），不写 `hazardRatio`；只有固定两臂和成组序贯的 `design_simulation`、`design_grid` 接受，`design_analytic` 和 `assurance` 按名拒绝并指向仿真。分析默认仍是 `logrank`，不要替人换；`maxcombo` 不是默认，也不是“更稳妥”的选择，只在人明确提出延迟起效、曲线晚分开或交叉这类假设时，才把 `analysis.method: "maxcombo"`（四个 Fleming–Harrington 加权对数秩统计量取最大，p 值按它们的联合零分布读，只用于固定两臂）作为并排的另一个方案；人没提这类假设就不用。没有单一的真风险比，所以结果里没有偏倚、MSE、覆盖率和解析核对，别替它补。两个方案的功效并排说，不要只说 MaxCombo 更高：它在晚分开或交叉时占优，比例风险下对数秩常常不差。

**设计网格里同一设计的几个真值共用一条随机流**（design.grid 1.3.0，两臂设计）：同一批受试者在每个真值下各走一遍，所以相邻两格功效的差比两次独立仿真的差稳得多（这个引擎上实测，方差降到约 14%（连续终点）和 42%（对数秩））；不同设计之间、单臂设计各格不配对，结果的 `seedPolicy` 说是哪一种。比较相邻真值就读这个差，不必再另跑一遍。

### 几个方案并排时的建议

平台按方案自己的 α 和目标功效（或研究者写下的比较目标）画样本量对功效的权衡图，没达标的数字旁有「未达标」或「接近」的标记，平台不替人选，也不叫哪个「最佳」。你在回复最后给**一句**建议，并说明是哪一条约束决定的（I 类错误上限、目标功效、样本量还是周期），数字取自结果，选择仍然归研究者。

### 假设卡里的数

效应卡（key 是 `hazard_ratio`、`treatment_event_rate`、`risk_difference`、`odds_ratio`、`mean_difference` 这几个）写 `effectRole`：`important_difference`（重要差异：研究认为值得发现的最小差异）或 `realistic_expectation`（现实预期：实际预期的差异）。这是两个不同的数，效应又是最常出错的输入。不写也保存、照常计算，写入的答复会提醒你补，补上就再写一个版本。

平台把假设卡的设定值放进场景，靠的是卡的 `key`：`hazard_ratio`→`truth.hazardRatio`，`control_median…`→`truth.controlMedian`，`dropout_rate`→`accrual.dropoutAnnual`，`control_event_rate`→`truth.controlRate`，`treatment_event_rate`→`truth.treatmentRate`，`risk_difference`、`odds_ratio`，`mean_difference`→`truth.effect`，`outcome_sd`→`truth.sd`。方案里同一参数写了数，也以卡为准。**改卡就是改场景**：新版本的卡进入新的作业，旧的结果标为已过期、由新结果取代，旧结果保留可查。方案 `assumptionIds` 指名了哪几张卡，就只用那几张。

### 报告里怎么写样本量

State normal-approximation sizing separately from the checked test power. Integer group counts must sum to the reported total. Correlation declared as cited is unavailable without verified matrix bindings; retain an explicit assumed correlation and its sensitivity rather than claiming it was sourced.
