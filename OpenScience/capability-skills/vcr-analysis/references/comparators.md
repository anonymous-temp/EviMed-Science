# Comparators

Part of the vcr-analysis skill: read it with [../SKILL.md](../SKILL.md), which holds what applies to every analysis. This part is for external and literature controls, indirect comparisons, borrowing and the robustness analyses.

## Reference: comparators

`mcp__evimed__vcr_read` `what: "comparator"` 会回来 `routes`——这个数据档位能走哪几条路线，是确定性的。路线、最低档位和引擎做的事：

| 路线 | 最低档位 | 引擎做什么 |
|---|---|---|
| `prognostic_adjustment` 预后校正 | T3 | 预后校正的样本量计算（`procova`），连续终点 |
| `external_control` 真实外部对照 | T2 | 熵平衡加权，估计目标是 ATT；换成 ATE 或 ATO 时用倾向得分加权 |
| `literature_control` 文献对照 | T0 | 先重建 KM 曲线的伪个体数据；两组曲线都给了，再对伪个体算 RMST；说明按 MAIC 做就用 MAIC（要自己的个体数据）。只重建一条曲线是基准，结论是「仅基准」 |
| `model_comparator` 模型预测比较器 | T0 | 把一个已保存的预后方程（`mcp__evimed__vcr_read` `what: "models"` 里带可执行规格的模型，`configuration` 写 `modelId` 和 `modelVersion`）按它声明的适用范围代入所选人群，给出这个人群的预测基准；结论永远是「仅基准」，不识别治疗效应。没有基线生存率的 Cox 方程只给相对评分，不给绝对风险；模型没有可执行规格、适用范围没有覆盖这个研究，平台记为不可估计并写明原因 |
| `hybrid_control` 混合对照 | T0 | 设计期的 MAP 先验：先验有效样本量与冲突情景下的运行特征 |

A literature comparator needs a curve record, and there are two ways to hold one. Find one with `mcp__evimed__vcr_read` with `what: "evidence"` (`curveReceipts`: each says whether a person's selection or the digitizer made it, and a digitizer record carries the calibration as it was stated, the algorithm version and the quality of each curve). Or make one with `mcp__evimed__curve_digitize` from a Kaplan–Meier figure already preserved in this study's workspace: you state what you read off the figure — the value at the first and last tick of each axis, the time unit, whether survival is a fraction or a percentage, which curve each arm is (its colour, or its place in the legend) and the risk table the paper prints — and never a coordinate: the points are measured from the pixels, deterministically. For a literature comparator, write the returned identifier as `configuration.provenance.receiptId`; do not invent coordinates, risk-table values, an origin label, or a tool name. The platform resolves the recorded points and verifies the current source-image hash before reconstruction.

The identifier below is a placeholder for the exact receipt returned by that read:

```json vcr:curve_receipt
{
  "what": "comparator",
  "data": {
    "route": "literature_control",
    "estimand": "ATT",
    "configuration": {
      "provenance": { "receiptId": "crv_example_from_evidence_read" }
    }
  }
}
```

A person's own selection through the browser stays an optional correction, never a prerequisite and never an approval. If `mcp__evimed__curve_digitize` refuses, it says why and what it needs (two panels with an axis each: name the one with the curve; a colour that is not in the figure; no legend to order by; a curve that rises, which is not survival) — state that and call again. Give the calibration in your report as your reading of the axis labels, with the digitizer's warnings and quality indicators. If a receipt, source image or risk table is missing or changed, or the figure is not a Kaplan–Meier curve, report reconstruction as unavailable and continue other supported research. Never treat an LLM-written `digitizer` or `human_click` string as proof.

A single recorded arm is a benchmark, not a comparison. For a receipt containing both arms, RMST additionally needs an explicitly supported `tau` and `timeUnit`; do not invent these or claim that an unavailable comparison was computed.

真实外部对照读的是患者级数据，`configuration` 写用哪些协变量、分析时点和哪个参数，并带数据快照。对象自己的 `targetTrial` 写目标试验的七个要素，每项 `{ status, text }`：`status` 是 `exact`（可精确复现）、`approximate`（只能近似）或 `not_possible`（无法复现），`text` 一句话说明。七项是 `eligibility`（入选标准）、`strategies`（处理策略）、`assignment`（分配方式）、`timeZero`（随访起点，两组各从什么时刻算起）、`outcome`（结局）、`contrast`（对比）、`analysis`（分析方法）。适用性判断写在 `configuration.applicability`：`state` 取 `suitable` / `partly_suitable` / `doubtful`，`claim` 是这项比较要支持的结论（`superiority` / `non_inferiority` / `equivalence` / `descriptive`），`note` 一两句话说依据：

```json vcr:object:comparator
{
  "route": "external_control",
  "estimand": "ATT",
  "targetTrial": {
    "eligibility": { "status": "approximate", "text": "外部对照的入排条件比试验宽，已按年龄和 ECOG 限制" },
    "strategies": { "status": "exact", "text": "试验药物对标准治疗" },
    "assignment": { "status": "approximate", "text": "外部对照不是随机分配，靠协变量加权" },
    "timeZero": { "status": "approximate", "text": "两组都从开始治疗之日起算" },
    "outcome": { "status": "exact", "text": "总生存期，同一定义" },
    "contrast": { "status": "exact", "text": "风险比" },
    "analysis": { "status": "exact", "text": "熵平衡加权后的加权 Cox" }
  },
  "configuration": {
    "covariates": ["age", "ecog", "ldh"],
    "tau": 12,
    "timeUnit": "months",
    "parameterCode": "OS",
    "applicability": { "state": "partly_suitable", "claim": "superiority", "note": "外部对照来自另一年代的登记库，时期不同；预后因素大多可得" },
    "snapshotId": "snp_example"
  }
}
```

这两条记录不是关卡：没写，平台照常计算，写入的答复提醒你补，补上就再写一个版本。只有两件事代码看得出来，结果因此标「有限制」并写明原因，仍然给出：这项比较要支持非劣效（外部对照不适合这样用），和真实数据的外部对照没有写明时间零点。`not_possible` 写在确实无法复现的项上，有一项是 `not_possible`，结果同样标「有限制」。

先按 ICH E10 的四个条件判断外部对照是否适宜（效应远大于自然变异、终点客观、病程可预测、预后因素已知可得），再逐项过 FDA 外部对照草案的十个可比性维度。估计目标默认 `ATT`；换成 `ATE` 或 `ATO` 必须写明理由——加权改变的是"这个效应是对谁说的"。

外部对照按设计里写明的 `method` 走，平台不替你换：`weighted_cox`（事件时间终点）出加权风险比，自助法与稳健区间并列，附等比例风险检验，不成比例时 RMST 差并排；`aipw`（连续、二分类或事件时间终点，只估 `ATT`）出双重稳健效应差；`covariateSets` 写 2–8 组事先声明的协变量集（不再写 `covariates`），逐组重算，给出范围，不可估计的组照实列出。文献对照 `maic` 遇事件时间终点，比较臂由平台重建的伪个体数据提供：非锚定写一条 `curve`，锚定写 `curve` 加 `treatmentArm`，或写已发表的风险比对数 `aggregateEstimate` 与 `aggregateSe`；非锚定的结论永远是"有限制"。

设计里还可以声明三种稳健性分析，平台按声明规划，不按文字猜。`negativeControls` 列出"治疗不可能影响的结局"：每项写 `name` 和 `column`（研究数据表里的 0/1 事件列；自己写的估计值或计数不进研究计划，结果里的数字只来自引擎对授权数据的计算）。每个对照走与主分析同一套加权（可选 `effectScale`：`log_risk_ratio` 或 `log_odds_ratio`），出逐项的偏倚筛查与经验零分布；二分类主终点写了 `outcomeColumn` 时它就是要校准的主要效应；可估计的对照不足 30 个就只列筛查、不校准，也从不给"校准区间"。`tippingPoint` 压力测试缺失结局：二分类写 `design`、`outcomeColumn`、`analysis`，事件时间写 `horizon` 与 `deltas`，报告使结论翻转的最近缺失组合或偏移倍数，翻不翻都照实说。路线 `prognostic_adjustment` 遇二分类或事件时间终点，写 `prognosticScoreColumn`（事先定好的预后评分，连续终点仍是 PROCOVA 的设计期计算），出边际效应；目前没有监管机构认可这种校正用于二分类或事件时间终点，页面会写明这一句，你转述时也要说，不要把它说成已认可的主分析。

**「不可估计」是一份完成的结果，而且不由你宣布。** 一条路线数据档位够不着，或引擎判定熵平衡无解、共同支持域外比例越界、加权后有效样本量低于下限、τ 超过随访、重建未过质控、MAP 先验冲突，平台都会把它存成「不可估计」，带触发的规则和缺口清单，照常交付。你不要在对象里自己写结论。你要做的是读回来，把缺什么、缺到什么程度、补上之后能回答什么讲清楚。

**加权后还有差异不是拒绝的理由，估计照给，差异摆在旁边。** 加权后最大的标准化差异不超过 0.10 是正常；在 0.10 和 0.25 之间，结论标「有限制」，页面写出数值和最差的那个变量；超过 0.25 同样标「有限制」，原因写「严重失衡」。你转述时把这两个事实说出来（哪个变量、差多少），不要把它说成「已平衡」，也不要说成「不可比」。

字段映射里有时间零点的日期列时，平衡表旁多一行**入组年份**：试验臂和外部对照各自的年份、加权前后的标准化差、外部对照落在试验入组年份以外的有多少。它是结局随时间漂移的线索，不进平衡判定，也**没有被加权**，转述时说出这一点；没有日期列就没有这一行，不要说成「没有漂移」。

**结果有四类：可估计、有限制地估计、仅基准、不可估计。** 只重建了一条文献曲线、非锚定的 MAIC 和模型的预测给出的是基准，不是治疗效应的估计，平台标「仅基准」，用途最高到研究设计支持；你转述时不要把它说成疗效。MAIC 的页面会列出目标人群（对方试验已发表的汇总人群）和你没有调整的效应修饰因子，所以 `unadjustedEffectModifiers` 要如实列全；非锚定的页面固定写一句「残余误差大小未知」。

**加权 Cox、二分类的加权风险比和 AIPW 的风险比出来之后，平台自动再算 E 值和它的置信限**，页面列在「未测量的混杂」里。已经有估计值和置信限、只想问「要多强的未测量混杂才能解释掉它」时，直接 `vcr_simulate` start、kind `evalue`，场景里写 `riskRatio`、`confidenceLimit`、`scale`（不必先写对照设计）。转述时说成「未测量的混杂要和处理、结局各有这么强的关联，才能解释掉这个结果」，不要说「没有偏倚」；阴性对照结局为零也只是「未发现偏倚迹象」，不是没有偏倚。凡是有治疗和结局个体数据的估计，在交付里提议加阴性对照结局：这要真实的列，所以问研究者一句有没有「治疗不可能影响」的结局列；没有也照交，E 值照给。

**重叠不足时的修剪（`trim`），和事件时间的双重稳健估计。** 事件时间的双重稳健估计里，某一组到所选时点之前一个事件都没有（全部删失，或对照组从不发生事件）时，估计照给，但标准误和区间不给，结果标“有限”（`arm_without_events_before_tau`）：这一组的影响函数恒为零，区间只反映另一组，不是知识；把这个原因在回复里说，不要自己补区间。 加权、倾向评分加权的加权 Cox 和 `aipw` 都可以在场景里写 `trim`：`{ rule: "crump" }` 用 Crump 的最优规则，不需要你给数；`{ rule: "fixed", lower: 0.1 }` 是研究者自己定的倾向评分界值（上界默认 1 − lower）。修剪换掉的是“结论是对谁说的”：去掉的是没有可比对象的人，结果列出每组去掉多少人、他们和留下的人有什么不同，并标「有限制」。你转述时要说“结论只适用于留下的人”，不要为了让结果显著去挑界值。`aipw` 也接事件时间终点：写 `endpoint.type` 为 `time_to_event`、`tau`（视野）和 `summary`（`rmst` 是到 tau 的限制平均生存时间，`survival` 是 tau 时点的生存率），事件时间照常来自事件表；它假定每组内删失与协变量无关，页面写出这个前提，你转述时也要说。

**偏倚分析（kind `bias_analysis`）回答“未测混杂要造成多大的偏移，结论才翻”。** 已经有一个对照的结果时，`vcr_simulate` start、kind `bias_analysis`，`subjectId` 写这个对照，场景里不写估计值：平台从它的结果里取效应和区间，你不要把数字抄进场景。只有一个已发表的估计时，场景里写 `scale`（`hazard_ratio`、`risk_ratio`、`odds_ratio` 或 `difference`）、`estimate` 和 `lower`、`upper`（或 `se`），它自成一份对照。什么都不加，就得到使区间碰到无效线的偏倚倍数；再按对方想知道的加：`shiftedNull { biases }`（偏倚真有这么大，效应还站得住吗），`confounderTipping`（多不均衡、多强的混杂才能翻；强度默认取 1.5、2、3、5），`probabilistic`（对方给出偏倚或混杂的范围，算校正后的估计和区间，含模拟误差）。偏倚的范围是研究者的或文献里的：向他要，或去读，不要自己编；这里的偏倚一律是“把效应夸大的偏倚”。转述时说“要多大的偏倚才翻”，不说“没有偏倚”。E 值只回答“要多强”，这里是再往上的两层，页面把它们分开写，也和缺失结局的临界点分析分开。

**只有一方有个体数据时，除了 MAIC，还可以做模拟治疗比较（kind `stc_comparator`，G 计算形式）。** 个体数据是一个试验（锚定时是它的两个臂），对方只有汇总：`aggregateCovariates` 每个协变量一行（连续的写 `mean`、`sd`，0/1 的写 `proportion`），`aggregateEstimate`（锚定：对方试验的活性臂对共同对照的对比，在链接尺度上）或 `aggregateOutcome`（非锚定：对方那一臂的结局，原尺度），加上 `aggregateSe`。已知的效应修饰因子写进 `effectModifiers`，没法调整的列进 `unadjustedEffectModifiers`。结果是对方试验人群里的边际效应，常规（条件）STC 并排列出；非锚定的和非锚定的 MAIC 一样是基准，前提是“假定所有预后因子和效应修饰因子都已调整”。结果页有一张卡：间接比较估计（对数比值比、相对危险度的话旁边有比值形式）及区间，边际效应、对方给的汇总效应和常规回归的条件效应并排（条件效应不能直接和汇总数相减，卡上已注明），以及对方人群里超出你数据范围的比例；转述时按这张卡说。

**外部对照要借多少，不止 MAP 一种说法（kind `borrowing_prior`）。** 一项历史对照（二分类写 `responders` 和 `n`，连续写 `mean`、`sd`、`n`，标准差按已知处理），加上要不要把当前对照组的数据（`current`，有试验组数据再写 `treatment`）算进去，或者想看对照组真实水平偏离历史时的 I 类错误和功效（`operatingCharacteristics`：`nControl`、`nTreatment`、`drifts`、`effect`）。`prior.kind` 三选一，按用户问的话选：`power`（“外部每人只算 0.3 人时结论如何”，`a0` 就是 0.3，不随数据改变）；`sam`（“借用多少由数据决定时结果如何”，写 `delta`：差到这么多就不再借，这是临床上的选择，要问清再填，不要替用户编）；`elastic`（“数据冲突怎样换算成借用程度”，也写 `delta`；`q0`、`q1` 不写就取 0.5，平台把它列在假设里，弹性函数的形状没有数据能证明，对用户说清这是一个选择）。结果是对照组后验、试验组更好的概率，各与不借用、全部借用并排，冲突与借用程度的对照表，偏离历史时的 I 类错误和功效（有借用和不借用两列）；这些数都是穷举算出的精确值，没有模拟误差，你照读，不要重算。试验组始终按不借用的均匀先验读；多项历史研究先合并，或者用 `map_prior`。弹性先验遇到“当前患者太少，看不出 delta 这么大的差异”会按名字拒绝，告诉用户要么加大 delta 要么增加当前例数。

**`stc_comparator`、`target_trial_emulation`、`borrowing_prior` 各自就是一个对照，不是某个已有对照的一步。** 在对话里直接开始：平台按你写的场景找到或新建这个对照设计，同样的场景再算还是它，换了场景就是另一个，不用先 `vcr_write` 一个对照；它们不会算进你已经用加权方法算过的那个对照里（那会替换掉它的结果）。要算进某个已有对照，写那个对照的 id（`subjectId`）。同一个对照再算一次，页面只留这一次的数、限制和说明，不带着上一次的。

**协变量有缺失时，在场景里写 `imputation: { m }`，不要自己删行，也不要自己补值。** 熵平衡、倾向评分加权、加权 Cox 和 `aipw` 遇到有缺失的协变量会按名字拒绝；写上 `imputation: { m: 20 }`，平台用链式方程把缺失补 m 次（数值用预测均值匹配，0/1 用逻辑回归抽样，要当多分类处理的列写进 `categorical`；其他协变量、治疗分组和结局都在每个补齐模型里），在每份补齐的数据上重做同样的分析，再按 Rubin 规则合并，只用完整病例的结果摆在旁边。`m` 至少取有缺失的人所占的百分比，不够结果会说；多类别的协变量写成一列编码，不要拆成几个指示列。前提是随机缺失（缺失只取决于已经看到的协变量、分组和结局），页面把它写成前提；区间是 Rubin 的，平衡表和曲线取自第一份补齐的数据。计算时间不够时只合并完成的几份，结果标“有限制”。不要为了让补齐前后的结果一致去改 `m` 或协变量。

**治疗起始时间各不相同的队列，用目标试验模拟（kind `target_trial_emulation`）。** 数据是一个人每一期一行的纵向表（映射时把“期”那一列标成测量日期，治疗、结局、是否符合条件和协变量标成测量值，结局那一列同时标上 `outcome: true`：研究封存了结局时，这张表要等分析方案冻结后才交给引擎，第一次读取也会记录；不标，结局就在方案冻结前被读了，还没有记录）；`parameters` 写治疗、结局、符合条件三个参数代码（默认 treatment、outcome、eligible），`covariates` 写协变量。`strategy.kind` 选 `sequential`：每一期符合条件的人开一个模拟试验，`estimand` 写 `itt`、`per_protocol` 或 `both`（默认两个都给），`weights.numerator` 是稳定化用的协变量（默认没有）；或选 `clone_censor_weight`：回答“符合条件后 g 期内开始治疗，对比不开始”这类有宽限期的问题，`gracePeriod` 写 g，时间零点是第一次符合条件的那一期。`horizon` 是读风险差的随访期数（`timeUnit` 说一期多长）。结果写明算的是意向治疗、按方案还是“宽限期内开始治疗”（clone_censor_weight 只看治疗开始了没有，开始之后停不停都不管，所以它不叫按方案，结果里的数叫 `risk_difference_start`）、第几期末的累积风险差，两组的风险在旁边；协变量按它在每一期的取值进入“是否开始治疗”的模型（随时间变化的也可以，假设它不受开始治疗的影响）；宽限期和随访期数不要看过结果再改。表太大会按名字拒绝（`too_many_person_periods`）：一串模拟试验按提示用 `lastPeriod`、`followUpLimit` 缩小，clone_censor_weight 只能缩短 `horizon` 或用更少的人。有一组一例事件也没有时，那组的风险只有上限、没有区间，风险差和风险比也不给区间（结果标成有限制，照实转述）；所问的那一期没有人在方案上待到时，按方案那一栏不给，意向治疗照常给；随访终点落在宽限期之内、或有人在时间零点前已经用过药，结果也标成有限制。结果里“只按有没有用过药分组”的朴素风险差只用来看等待时间造成的偏差，不是结果。
