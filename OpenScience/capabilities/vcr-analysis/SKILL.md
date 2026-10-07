---
name: vcr-analysis
description: 「虚拟临床研究」的人群、虚拟患者、对照与试验四步：按数据档位选路，把每个对象按引擎认识的字段写下来，平台交引擎算，读回来讲清楚。
---

# 人群、虚拟患者、对照与试验

## 模型不产生数字

**这一条排在最前面，因为它是整个板块成立的前提。** 你不做统计：样本量、功效、I 类错误、偏倚、覆盖率、有效样本量、标准化差异、RMST、入组时间分布、蒙特卡洛标准误——每一个都来自 `mcp__evimed__vcr_read` 读到的已保存结果，或引擎的作业。你负责的是：说清楚要算什么、把对象写对、读回结果、判断它可信到什么程度、讲清楚它意味着什么。

心算出来的、"按经验大约"的、从记忆里搬来的数，一律不得写进交付物。需要而没有的数，写清楚缺它、缺的原因、由哪一步能补上。

## 先读

写任何对象之前，先读两样，因为下面的写法取决于它们：

- `mcp__evimed__vcr_read` `what: "definition"`——**终点类型（连续、二分类、事件时间）决定所有方法分支**，也决定场景里 `endpoint.type` 写什么。
- `mcp__evimed__vcr_read` `what: "assumptions"`——已有的假设卡。卡里有的参数，平台会直接放进场景（见「假设卡里的数」），你不要在对象里再写一遍。

要引用一个数时才读 `what: "results"`；带 `stale` 的结果过期了，平台会按新版本自动重算，你只需要读回来。

## 你写对象，平台交给引擎算

用 `mcp__evimed__vcr_write` 写人群、虚拟患者集、对照和试验方案。**写下去，平台就把这个对象冻结成一个引擎作业，算完把结果存回来**，不需要你自己排作业。直接排计算（`mcp__evimed__vcr_simulate`）只在对话里一句话问"要多少例"这类问题时用，而且每一次计算都要说它算的是哪个对象：先写一个试验方案对象，再把它的 id 作为 `subjectId`（解析、模拟、成功把握是同一份结果的几个部分，几个方案是几份结果，互不顶替）。`action: "start"` 拿到 `jobId`，`action: "status"` 轮询。作业超出研究的计算预算会停在确认处，只有研究者的确认能放行它，不要对它轮询；照实告诉用户在等什么、大概多少机时，然后继续做不依赖它的部分。

**对象里只能写引擎认识的字段。** 多写一个字段、拼错一个字段（比如脱落率没有写成 `accrual.dropoutAnnual`），这个对象不会被算，而是被拒绝并说出字段的路径——引擎从不悄悄忽略一个参数。**写之前先读，不要凭印象起名字**：用 `mcp__evimed__vcr_simulate` `{ "action": "shape", "kind": "<作业类型>" }` 读这个方法认识的全部字段（类型、单位、范围、默认值、必填还是可选、按哪种终点或设计才读）和一个有效示例；试验方案用 `design_analytic` 和 `design_simulation`，虚拟患者集用 `generate_patients*`。被拒绝时，拒绝的话里已经列出那个位置引擎读的字段，照着改，不必再猜。零效应情景写 `truth.null: true`（布尔值），脱落只有 `accrual.dropoutAnnual` 一种写法（每 12 个时间单位的比例）；`alpha` 是总 α，`sided` 写 1 或 2。**`accrual`（入组、随访、脱落）只有事件时间终点才有**：二分类和连续终点的虚拟患者集与试验方案不写 `accrual`，写了就是多写的字段，照样被拒绝。

### 步骤 3：人群

数据档位决定从哪里开始：

| 档位 | 人群 `kind` | 引擎做什么 |
|---|---|---|
| T1–T3 有患者级数据 | `real` | 按入选规则筛出真实队列 |
| 有本地数据但要外发 | `empirical_synthetic` | 经验合成人群，附保真度、可用性和泄露风险 |
| 只有文献基线表 | `literature` | 按已发表的基线表生成 |
| 什么都没有 | `scenario` | 按设定的分布生成 |

`mcp__evimed__vcr_write` `what: "population"`，`definition` 直接写引擎的字段（没有多一层）。情景人群：

```json vcr:object:population
{
  "kind": "scenario",
  "name": "情景人群",
  "definition": {
    "n": 240,
    "population": {
      "variables": [
        { "name": "age", "label": "年龄", "family": "normal", "mean": 63, "sd": 9 },
        { "name": "ldh", "label": "乳酸脱氢酶", "family": "lognormal", "meanlog": 5.4, "sdlog": 0.35 }
      ],
      "constraints": [
        { "name": "成年", "rule": { "op": "compare", "column": "age", "comparator": "gte", "value": 18 } }
      ]
    }
  },
  "allowedUses": ["design", "feasibility"]
}
```

变量可以带 `label`（页面上显示的名字，只用于显示，引擎不拿它算任何东西）。人群算完，引擎会按变量描述它生成的那张表——设定的分布、生成出来的均数、标准差或各水平的占比、缺失数和一个小直方图——研究页的人群页签就用它，让研究者对照“设定的”和“生成的”；经验合成的人群里人数很少的格子引擎会隐藏，你转述时同样不要还原。这些数字你从 `mcp__evimed__vcr_read` 读，不要自己算。

文献人群写 `baselineTable`（每行一个变量，连续变量给 `mean` 和 `sd`，二分类给 `proportion`）；真实队列写 `rules`（每条 `{ name, rule }`）加 `timeZero` 和 `exit` 两个列名，并带 `snapshotId`。**规则是数据，不是代码**：`compare`、`between`、`in`、`missing`、`present`，用 `all`、`any`、`not` 组合，列名必须是这张表里真有的列；写成表达式字符串会被拒绝。

真实队列先看定义库里有没有现成的：`mcp__evimed__vcr_read` `what: "library"` 列出账号里可复用的人群定义（名称、版本、说明、规则）。要用哪一条，人群这一项写 `fromLibrary`，不再写 `definition`：`{ "what": "population", "items": [ { "fromLibrary": { "definitionId": "<库里的 id>", "version": 2 } } ] }`（`version` 不写取最新）。规则、时间零点和退出沿用库里的；列名和研究的数据对不上时，平台只在知识包的字段映射能唯一对上的地方替你改名，改了哪些、哪些没对上都在返回值里，没对上的列要换成数据里真有的列再写一次。

合成人群的 `allowedUses` 只能是 `design` / `feasibility` / `testing` / `training` / `shared_preview`——**合成人群永远不进真实外部对照**。

筛选流程每一步都要单列三个数：保留、排除、**无法判断**。把「无法判断」并进「排除」，是这一步最常见也最贵的错误。

### 步骤 4：虚拟患者

在库里选能覆盖这个人群和这个终点的**最高一级**模型（`validated` > `data` > `literature` > `scenario`）。选不到就用文献模型或情景模型，并在报告里写明是哪一级、为什么。

`mcp__evimed__vcr_write` `what: "patient_set"`：`modelId`、`modelVersion`、`scenario`，有已生成的人群就写 `populationId`（上一步写人群时返回的 id；两组人数之和要等于人群的人数：上面人群的 `n` 是 240，这里 160 + 80）。

```json vcr:object:patient_set
{
  "name": "240 名虚拟患者",
  "populationId": "pop_example",
  "modelId": "reference-time-to-event",
  "modelVersion": "1.0.0",
  "scenario": {
    "design": { "nTreat": 160, "nControl": 80 },
    "endpoint": { "type": "time_to_event" },
    "truth": { "covariateEffects": { "ldh": 0.001 } },
    "accrual": { "kind": "uniform", "duration": 12, "followup": 12 }
  }
}
```

风险比、对照组中位、脱落率这些参数由假设卡填进 `truth` 和 `accrual`，你只写卡里没有的部分（这里是协变量效应）。

连续终点要看随访轨迹（每次随访的平均变化、两组轨迹的差）时，用纵向模型 `reference-longitudinal`：`scenario` 里写 `visits`（随访时间表，从小到大，至少两个时间点），`truth.effect` 是处理使每个时间单位的变化速度多变化多少（两组起点相同），再写 `truth.intercept`、`truth.slope`、`truth.sd`（残差标准差）、`truth.randomEffects`（`sdIntercept`、`sdSlope`、`correlation`）和 `dropoutPerVisit`（每次随访前退出的概率，完全随机缺失，退出后的随访记为缺失）。没有 `visits` 的连续终点仍是单个终点值。输出是每次随访的观测值、两组的平均轨迹和 95% 范围、同一个人在两种分组下的轨迹，**是情景推演，不是对任何真实人群或个体的预测**。

```json vcr:object:patient_set
{
  "name": "12 周纵向轨迹",
  "modelId": "reference-longitudinal",
  "modelVersion": "1.0.0",
  "scenario": {
    "design": { "nTreat": 100, "nControl": 100 },
    "endpoint": { "type": "continuous" },
    "visits": [0, 4, 8, 12],
    "truth": { "effect": -0.05, "intercept": 7.5, "slope": -0.01, "sd": 0.6, "randomEffects": { "sdIntercept": 0.9, "sdSlope": 0.03, "correlation": 0.2 } },
    "dropoutPerVisit": 0.05
  }
}
```

**「数字孪生」这四个字有门槛**：个体条件化、随新数据更新、校准过的不确定性、验证记录，四项齐全才是 `digital_twin`，否则是 `baseline_conditioned_prediction`（基线条件化预测）。平台自己按证据推导这个标签，你不要替它下结论。

模型不适用时（人群、终点或输入超出范围），给出「适用性问题」：哪一项超出范围，然后在「换一个合适的模型」「用文献模型或情景模型并标明」「提一个数据需求」三条里选一条，照实标注。**不要编一条轨迹顶替。**

**每个用到的模型写一条评估记录**（`mcp__evimed__vcr_write` `what: "model_assessment"`），在对照步骤之前写：平台在分析计划冻结的那一刻，把这些记录连同模型卡、假设、方法和情景一起冻结成模型分析计划，冻结之后再改只会成为新的一版。一条记录回答一个问题、对一个模型：关注的问题（`questionOfInterest`，模型要回答什么）、使用情境（`contextOfUse`，模型的角色与范围、用什么数据建的、还有什么证据一起用）、模型影响力（`influence`：模型结果在决策里的分量，只有它一个依据时是 `high`）、错误决策的后果（`consequence`：严重程度和发生可能），各自的理由、模型冲击（`impact`：这个用法偏离监管惯例多远）及理由、技术标准（`technicalCriteria`：事先写下**怎样算模型和结果可以接受**，看到结果之前写）、所拟用法的适当性（`appropriateness`）。评级只有 `low`、`medium`、`high`，**每个评级都要写理由**。

**模型风险你不写**：平台按影响力和后果推出来——两个都低就是低，都高就是高，不一样时随影响更大的一项——并把依据写进记录；你在 `riskJustification` 里写这个风险为什么是这样。同一个问题有几个模型回答，就写几条记录，问题的写法保持一致，平台按问题分表。评价（`evaluation`）和证据评估的结论（`outcome`）是分析做完之后才填的，计划阶段留空。

```json
{
  "what": "model_assessment",
  "data": {
    "key": "survival_projection",
    "modelName": "reference-time-to-event",
    "modelVersion": "1.0.0",
    "questionOfInterest": "外部对照的生存基准能否用于单臂试验的比较",
    "contextOfUse": "用情景模型生成对照臂的事件时间分布，作为单臂试验的比较基准；与文献对照一起使用",
    "influence": "medium",
    "influenceJustification": "模型结果与文献对照并列使用，不是唯一依据",
    "consequence": "high",
    "consequenceJustification": "错误的基准会让一项无效疗法进入关键试验",
    "riskJustification": "后果为高而影响力为中，风险随后果",
    "impact": "low",
    "impactJustification": "加权外部对照是监管上已经讨论过的做法",
    "technicalCriteria": [{ "criterion": "重建的曲线通过质控", "rationale": "与模型风险相称" }],
    "appropriateness": "情景模型覆盖研究的终点，用法只作设计依据"
  }
}
```

返回值里的 `issues` 是这条记录还没填的项：照着补，再写一次（新版本）。记录先存下，缺的项会在文件里写成「未填写」。模型卡写明接口是「事件历史 → 未来轨迹」的模型，这个部署还没有能执行它的模型包：写患者集会被按名拒绝，不要用别的模型顶替。

### 步骤 5：对照

`mcp__evimed__vcr_read` `what: "comparator"` 会回来 `routes`——这个数据档位能走哪几条路线，是确定性的。路线、最低档位和引擎做的事：

| 路线 | 最低档位 | 引擎做什么 |
|---|---|---|
| `prognostic_adjustment` 预后校正 | T3 | 预后校正的样本量计算（`procova`），连续终点 |
| `external_control` 真实外部对照 | T2 | 熵平衡加权，估计目标是 ATT；换成 ATE 或 ATO 时用倾向得分加权 |
| `literature_control` 文献对照 | T0 | 先重建 KM 曲线的伪个体数据；两组曲线都给了，再对伪个体算 RMST；说明按 MAIC 做就用 MAIC（要自己的个体数据） |
| `model_comparator` 模型预测比较器 | T0 | 当前版本没有实现：引擎里只有按情景参数生成的参考仿真器，给不出"对该人群的预测"。平台如实记为不可估计并写明原因 |
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

真实外部对照读的是患者级数据，`configuration` 写用哪些协变量、分析时点和哪个参数，并带数据快照：

```json vcr:object:comparator
{
  "route": "external_control",
  "estimand": "ATT",
  "configuration": {
    "covariates": ["age", "ecog", "ldh"],
    "tau": 12,
    "timeUnit": "months",
    "parameterCode": "OS",
    "targetTrial": [
      { "item": "入选标准", "emulation": "approximate" },
      { "item": "处理策略", "emulation": "exact" },
      { "item": "同期治疗", "emulation": "cannot" }
    ],
    "snapshotId": "snp_example"
  }
}
```

先按 ICH E10 的四个条件判断外部对照是否适宜（效应远大于自然变异、终点客观、病程可预测、预后因素已知可得），再逐项过 FDA 外部对照草案的十个可比性维度。估计目标默认 `ATT`；换成 `ATE` 或 `ATO` 必须写明理由——加权改变的是"这个效应是对谁说的"。

外部对照按设计里写明的 `method` 走，平台不替你换：`weighted_cox`（事件时间终点）出加权风险比，自助法与稳健区间并列，附等比例风险检验，不成比例时 RMST 差并排；`aipw`（连续或二分类，只估 `ATT`）出双重稳健效应差；`covariateSets` 写 2–8 组事先声明的协变量集（不再写 `covariates`），逐组重算，给出范围，不可估计的组照实列出。文献对照 `maic` 遇事件时间终点，比较臂由平台重建的伪个体数据提供：非锚定写一条 `curve`，锚定写 `curve` 加 `treatmentArm`，或写已发表的风险比对数 `aggregateEstimate` 与 `aggregateSe`；非锚定的结论永远是"有限制"。

设计里还可以声明三种稳健性分析，平台按声明规划，不按文字猜。`negativeControls` 列出"治疗不可能影响的结局"：每项写 `name` 和 `column`（研究数据表里的 0/1 事件列；自己写的估计值或计数不进研究计划，结果里的数字只来自引擎对授权数据的计算）。每个对照走与主分析同一套加权（可选 `effectScale`：`log_risk_ratio` 或 `log_odds_ratio`），出逐项的偏倚筛查与经验零分布；二分类主终点写了 `outcomeColumn` 时它就是要校准的主要效应；可估计的对照不足 30 个就只列筛查、不校准，也从不给"校准区间"。`tippingPoint` 压力测试缺失结局：二分类写 `design`、`outcomeColumn`、`analysis`，事件时间写 `horizon` 与 `deltas`，报告使结论翻转的最近缺失组合或偏移倍数，翻不翻都照实说。路线 `prognostic_adjustment` 遇二分类或事件时间终点，写 `prognosticScoreColumn`（事先定好的预后评分，连续终点仍是 PROCOVA 的设计期计算），出边际效应；目前没有监管机构认可这种校正用于二分类或事件时间终点，页面会写明这一句，你转述时也要说，不要把它说成已认可的主分析。

**「不可估计」是一份完成的结果，而且不由你宣布。** 一条路线数据档位够不着，或引擎判定熵平衡无解、共同支持域外比例越界、加权后有效样本量低于下限、关键协变量标准化差异 ≥ 0.1、τ 超过随访、重建未过质控、MAP 先验冲突，平台都会把它存成「不可估计」，带触发的规则和缺口清单，照常交付。你不要在对象里自己写结论。你要做的是读回来，把缺什么、缺到什么程度、补上之后能回答什么讲清楚。

### 步骤 6：试验

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

**解析优先、仿真复核**：平台对每个方案先算解析结果再仿真，两者差异超出蒙特卡洛误差时结果里带着差值，你在报告里说出来。固定设计的效应有假设卡给出预测分布时，平台还会算成功把握（按证据的不确定性平均后的功效）；成组序贯设计也算，意思是在任一次期中或最终分析越过界值的概率（设计里的 `events` 是最大事件数，`informationRates` 是各次分析的位置）。重复次数不用你定：零假设情景默认不少于 2 万次，备择不少于 5,000 次，`targetMcse` 写了目标精度就按 p(1−p)/MCSE² 自动抬高。

**必须有一个零效应情景**（`truth.null: true`，或在设计网格的真值列表里放一列），否则 I 类错误无从谈起。比较设计和真值的组合用设计网格，`dimensions.designs` 列出设计，`truthScenarios` 列出真值情景，每一格的数字是引擎填的：

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

### 假设卡里的数

平台把假设卡的设定值放进场景，靠的是卡的 `key`：`hazard_ratio`→`truth.hazardRatio`，`control_median…`→`truth.controlMedian`，`dropout_rate`→`accrual.dropoutAnnual`，`control_event_rate`→`truth.controlRate`，`treatment_event_rate`→`truth.treatmentRate`，`risk_difference`、`odds_ratio`，`mean_difference`→`truth.effect`，`outcome_sd`→`truth.sd`。方案里同一参数写了数，也以卡为准。**改卡就是改场景**：新版本的卡进入新的作业，旧的结果标为已过期、由新结果取代，旧结果保留可查。方案 `assumptionIds` 指名了哪几张卡，就只用那几张。

## 四个数永远分开

真实患者数、事件数、有效样本量、生成记录数。生成两千条轨迹不会让真实患者数变成两千；加权后的有效样本量永远不超过它加权的真实人数；重建出来的伪个体不计入真实患者数，也不画成观察到的 KM 曲线。

## 区间要写清是哪一种

置信区间、可信区间、预测区间、蒙特卡洛区间。**不写「区间」两个字了事。** 模型生成的分布不画成观察到的 KM 曲线。

## 交付

**每次交付都是一份报告加一份机器可读结果**，名字固定：

| 文件 | 何时交 | 内容 |
|---|---|---|
| `analysis-report.md` | 每次 | 这一步做了什么、结果是什么、可信到什么程度、有什么局限 |
| `results.json` | 每次 | 机器可读的结果：结论、四个数、指标、诊断 |
| `comparability.md` | 做对照时 | 十个可比性维度逐项、ICH E10 四条件、重叠与平衡 |
| `simulation.json` | 做试验时 | 模拟报告的结构化版本 |

`results.json` 至少要有 `conclusion`、`counts`（四个数，没有的写 `null` 不写 `0`）、`measures`（每个仿真指标带 `mcse`）、`diagnostics`；人群还要 `waterfall`（每步带 `unknown`）与 `populationKind`，经验合成人群另加 `qualityReport`（保真度、可用性、泄露风险）；对照还要 `estimand` 与 `diagnostics`。

`simulation.json` 按 FDA 复杂创新设计指导原则的清单：`designSummary`、`exampleTrial`、`scenarios`（含 `null: true` 的零效应情景）、`replicates`、`operatingCharacteristics`（每行带 `mcse`）、`sensitivity`、`code`（种子与软件版本）、`summary`。

**报告里的每个数写成 `{{n:…}}` 引用**，用 `mcp__evimed__vcr_read` `what: "report_model"` 看能引用哪些路径。例如 `{{n:measure(power).value|pct1}}`、`{{n:counts.realPatients|thousands}}`、`{{n:measure(power)|pm}}`、`{{n:measure(hazard_ratio)|ci}}`；同一份报告里比较几个方案时按方案的 id 指名：`{{n:measure(power, scenario=<方案 id>).value|pct1}}`。平台在交付时按研究已保存的结果渲染这些引用，渲染不出来的写成「未计算」，不会写成 0；手打的数字（年份、12 以内的序号、日期、页码图表编号和「」里引的方案原文除外）平台也写成「未计算」，并在返回值 `issues` 里告诉你；读不成引用的 `{{n:…}}`（格式要小写，如 `pct1`）同样。

## 运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（不消耗提交）：文件在不在、四个数有没有分开、仿真指标有没有蒙特卡洛误差、零效应情景在不在、区间有没有写明种类、「不可估计」有没有带规则与缺口。它的发现全部是提示级——照它说的修，修不了的写进报告。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
