# Populations and individual patients

Part of the vcr-analysis skill: read it with [../SKILL.md](../SKILL.md), which holds what applies to every analysis. This part is for populations, virtual patients and the assessment record of a model.

## Inspect populations and individuals

Use `mcp__evimed__vcr_read` what `generated_records`, `filter.id` equal to the saved result ID,
and optionally `filter.subjectKey` for one member. The service checks the actual
generated lineage; a synthetic label alone does not authorize model egress of
empirical/upload-derived records. Read permitted partial results instead of
reconstructing inaccessible rows in prose. A longitudinal record contains multiple
observations of one person; do not count visits as additional patients.

When pairing scenarios, retain the immutable cohort and recorded random-stream
policy. Shared random numbers reduce comparison noise; they do not identify an
individual treatment effect. Independent Monte Carlo replicates remain independent.

## Evidence before parameters

For literature populations, `definition.baselineBindings` identifies each variable
and statistic with a verified `evidenceId` and explicit `unit`; categorical
`proportions` also identify `index`. The platform verifies numeric values, source
units and reported baseline status before enqueueing. Only actually used evidence
and assumption versions belong to the result's lineage. A derived value with only
quoted inputs is not a verified reported baseline; keep it as an explicit
exploratory assumption or provide the supported computation evidence.

## Reference: populations

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

变量可以带 `label`（页面上显示的名字，只用于显示，引擎不拿它算任何东西）。人群算完，引擎会按变量描述它生成的那张表——设定的分布、生成出来的均数、标准差或各水平的占比、缺失数和一个小直方图——研究页的人群页签就用它，让研究者对照“设定的”和“生成的”；经验合成的人群里人数很少的格子引擎会隐藏，你转述时同样不要还原。这些数字你从 `mcp__evimed__vcr_read` 读，不要自己算。这张对照叫「与输入对照」：它只说生成器照着输入做了，**不是验证**，不说这群人像真人。

要拿第二份基线表去对照这份人群（另一项研究或登记的基线表，数字在引文里核对过）：`mcp__evimed__vcr_simulate` `kind: "population_check"`，场景写 `baselineTable`（形状同文献人群：变量、均数和 SD、或占比）、`baselineBindings`（和文献人群一样把每个数绑到引文）、可选 `referenceN`（写了才有标准误）；生成的那一侧由平台从这份人群自己的结果里抄，你不写。每个变量只比它自己的分布（标准化差，类别用总变差距离），变量之间的相关性、分布的形状和子群都没比，结果里的 `coverage` 写着。第二份表和这份人群用了同一批证据时，结果只叫「与输入对照」，不是独立对照；证据不重合才可以说独立对照，同时要说没比的部分不算验证。没有第二份来源就不要说「已验证」。

文献人群写 `baselineTable`（每行一个变量，连续变量给 `mean` 和 `sd`，二分类给 `proportion`）；真实队列写 `rules`（每条 `{ name, rule }`）加 `timeZero` 和 `exit` 两个列名，并带 `snapshotId`。**规则是数据，不是代码**：`compare`、`between`、`in`、`missing`、`present`，用 `all`、`any`、`not` 组合，列名必须是这张表里真有的列；写成表达式字符串会被拒绝。

真实队列先看定义库里有没有现成的：`mcp__evimed__vcr_read` `what: "library"` 列出账号里可复用的人群定义（名称、版本、说明、规则）。要用哪一条，人群这一项写 `fromLibrary`，不再写 `definition`：`{ "what": "population", "items": [ { "fromLibrary": { "definitionId": "<库里的 id>", "version": 2 } } ] }`（`version` 不写取最新）。规则、时间零点和退出沿用库里的；列名和研究的数据对不上时，平台只在知识包的字段映射能唯一对上的地方替你改名，改了哪些、哪些没对上都在返回值里，没对上的列要换成数据里真有的列再写一次。

合成人群的 `allowedUses` 只能是 `design` / `feasibility` / `testing` / `training` / `shared_preview`——**合成人群永远不进真实外部对照**。

筛选流程每一步都要单列三个数：保留、排除、**无法判断**。把「无法判断」并进「排除」，是这一步最常见也最贵的错误。

## Reference: individual patients

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

纵向轨迹还能写三样（模型版本 1.2.0，都可以不写；不写任何一样就和以前逐位相同）：`trajectory`（病程曲线的形状：`plateau` 逐渐趋平，`halfTime` 是走到一半的时间；`quadratic` 二次曲线，`curvature`），`dropoutModel`（脱落与结局有关：`mechanism: "mar"` 看上一次的值、`"mnar"` 看这次的值，`logOddsPerSd` 为正表示值越高越早退出；`dropoutPerVisit` 仍是平均水平上的退出概率，必须写且大于 0），`rescue`（救援用药这种伴发事件：`perVisit` 每次随访前开始的概率，`logOddsPerSd` 上一次的值高时更容易开始，`effect` 开始后结局整体移动多少）。问“15% 的人用了救援药，效应和样本量变成多少”就写 `rescue`：每个虚拟患者在两个组下的完整轨迹都生成了，结果的 `estimands` 里同时给出两种估计目标在末次随访的效应和各自每组要多少人——治疗策略（用了救援药的结果照算）和假想策略（假如没有救援药，等于模型自己的效应乘时间尺度）——以及两组末次随访时在用救援药的比例。回复里说清问的是哪一种，两个数都给，不要自己重算；表里多一列 `rescue`（0/1，开始用后一直是 1）。直接比较末次随访仍在研究内的人，在随机缺失和非随机缺失下都有偏，混合模型只在随机缺失下没有偏，要把这个差别告诉人，不要说“已处理脱落”。

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

An assessment's `issues` describe missing information; the record is retained and can be completed in a new version. Event-history models use the cloud forecast or external-file path described below. Do not send them through the statistical patient-set generator or substitute a different model when an API is unavailable.
