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

外部对照按设计里写明的 `method` 走，平台不替你换：`weighted_cox`（事件时间终点）出加权风险比，自助法与稳健区间并列，附等比例风险检验，不成比例时 RMST 差并排；`aipw`（连续或二分类，只估 `ATT`）出双重稳健效应差；`covariateSets` 写 2–8 组事先声明的协变量集（不再写 `covariates`），逐组重算，给出范围，不可估计的组照实列出。文献对照 `maic` 遇事件时间终点，比较臂由平台重建的伪个体数据提供：非锚定写一条 `curve`，锚定写 `curve` 加 `treatmentArm`，或写已发表的风险比对数 `aggregateEstimate` 与 `aggregateSe`；非锚定的结论永远是"有限制"。

设计里还可以声明三种稳健性分析，平台按声明规划，不按文字猜。`negativeControls` 列出"治疗不可能影响的结局"：每项写 `name` 和 `column`（研究数据表里的 0/1 事件列；自己写的估计值或计数不进研究计划，结果里的数字只来自引擎对授权数据的计算）。每个对照走与主分析同一套加权（可选 `effectScale`：`log_risk_ratio` 或 `log_odds_ratio`），出逐项的偏倚筛查与经验零分布；二分类主终点写了 `outcomeColumn` 时它就是要校准的主要效应；可估计的对照不足 30 个就只列筛查、不校准，也从不给"校准区间"。`tippingPoint` 压力测试缺失结局：二分类写 `design`、`outcomeColumn`、`analysis`，事件时间写 `horizon` 与 `deltas`，报告使结论翻转的最近缺失组合或偏移倍数，翻不翻都照实说。路线 `prognostic_adjustment` 遇二分类或事件时间终点，写 `prognosticScoreColumn`（事先定好的预后评分，连续终点仍是 PROCOVA 的设计期计算），出边际效应；目前没有监管机构认可这种校正用于二分类或事件时间终点，页面会写明这一句，你转述时也要说，不要把它说成已认可的主分析。

**「不可估计」是一份完成的结果，而且不由你宣布。** 一条路线数据档位够不着，或引擎判定熵平衡无解、共同支持域外比例越界、加权后有效样本量低于下限、τ 超过随访、重建未过质控、MAP 先验冲突，平台都会把它存成「不可估计」，带触发的规则和缺口清单，照常交付。你不要在对象里自己写结论。你要做的是读回来，把缺什么、缺到什么程度、补上之后能回答什么讲清楚。

**加权后还有差异不是拒绝的理由，估计照给，差异摆在旁边。** 加权后最大的标准化差异不超过 0.10 是正常；在 0.10 和 0.25 之间，结论标「有限制」，页面写出数值和最差的那个变量；超过 0.25 同样标「有限制」，原因写「严重失衡」。你转述时把这两个事实说出来（哪个变量、差多少），不要把它说成「已平衡」，也不要说成「不可比」。

字段映射里有时间零点的日期列时，平衡表旁多一行**入组年份**：试验臂和外部对照各自的年份、加权前后的标准化差、外部对照落在试验入组年份以外的有多少。它是结局随时间漂移的线索，不进平衡判定，也**没有被加权**，转述时说出这一点；没有日期列就没有这一行，不要说成「没有漂移」。

**结果有四类：可估计、有限制地估计、仅基准、不可估计。** 只重建了一条文献曲线、非锚定的 MAIC 和模型的预测给出的是基准，不是治疗效应的估计，平台标「仅基准」，用途最高到研究设计支持；你转述时不要把它说成疗效。MAIC 的页面会列出目标人群（对方试验已发表的汇总人群）和你没有调整的效应修饰因子，所以 `unadjustedEffectModifiers` 要如实列全；非锚定的页面固定写一句「残余误差大小未知」。

**加权 Cox、二分类的加权风险比和 AIPW 的风险比出来之后，平台自动再算 E 值和它的置信限**，页面列在「未测量的混杂」里。转述时说成「未测量的混杂要和处理、结局各有这么强的关联，才能解释掉这个结果」，不要说「没有偏倚」；阴性对照结局为零也只是「未发现偏倚迹象」，不是没有偏倚。凡是有治疗和结局个体数据的估计，在交付里提议加阴性对照结局：这要真实的列，所以问研究者一句有没有「治疗不可能影响」的结局列；没有也照交，E 值照给。
