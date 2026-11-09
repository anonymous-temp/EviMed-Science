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

纵向轨迹还能写三样（模型版本 1.2.0，都可以不写；不写任何一样就和以前逐位相同）：`trajectory`（病程曲线的形状：`plateau` 逐渐趋平，`halfTime` 是走到一半的时间；`quadratic` 二次曲线，`curvature`），`dropoutModel`（脱落与结局有关：`mechanism: "mar"` 看上一次的值、`"mnar"` 看这次的值，`logOddsPerSd` 为正表示值越高越早退出；`dropoutPerVisit` 仍是平均水平上的退出概率，必须写且大于 0），`rescue`（救援用药这种伴发事件：`perVisit` 每次随访前开始的概率，`logOddsPerSd` 上一次的值高时更容易开始，`effect` 开始后结局整体移动多少）。脱落与结局有关或有救援药时，结果第一句“到最后一个时间点两组的平均值相差多少”只是没有脱落的人的差，不是任何一种估计目标的真值，页面会这样说；真值在估计目标一栏，转述时用那一栏。问“15% 的人用了救援药，效应和样本量变成多少”就写 `rescue`：每个虚拟患者在两个组下的完整轨迹都生成了，结果的 `estimands` 里同时给出两种估计目标在末次随访的效应和各自每组要多少人——治疗策略（用了救援药的结果照算）和假想策略（假如没有救援药，等于模型自己的效应乘时间尺度）——以及两组末次随访时在用救援药的比例。回复里说清问的是哪一种，两个数都给，不要自己重算；表里多一列 `rescue`（0/1，开始用后一直是 1）。直接比较末次随访仍在研究内的人，在随机缺失和非随机缺失下都有偏，混合模型只在随机缺失下没有偏，要把这个差别告诉人，不要说“已处理脱落”。

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

## 合成数据能不能拿来做推断，以及哪些人最容易被认出来

用户问“这份合成数据跑我的 HR，假阳性率多少”或“哪些人最容易被认出来”，用 `synthesize_population`（或对已有合成表用 `population_quality`）的这几项，不要自己估：

- **声明分析**（`analyses`）：每个分析的 `name` 会原样出现在用户看的页面上，用中文写（“年龄对结局的影响”），不要写 “x2 on y” 这样的缩写。除了 `mean`、`glm`，还有 `cox`（`time`、`status`（1 是事件）、`predictors`、`target`，报对数风险比）、`logrank`（`time`、`status`、`group`，报第二组对第一组的 Peto 对数风险比和 log-rank 的 p 值）、`rmst`（再加 `tau`，报限制性平均生存时间之差）。每个分析在真实表和每一份合成表上都跑，各份按 Raab、Nowok、Dibben 的规则合并（方差里加上生成模型本身的抽样误差）；一份当真实数据直接分析会低估方差。`population_quality` 读一张带 `copy` 列的表时，就把它当作它的各份。
- **假阳性率**（`inference.nullCalibration`：`analysis` 写某个声明分析的名字，它要有 `target` 或 `group`，`replicates` 默认 100）：把真实表的臂标签打乱（这时没有真实效应），用同一个生成器再合成，跑这个分析，数它的区间排除“无效应”的次数。三个数一起报：直接在打乱后的真实表上（应该在 5% 附近）、把合成表的第 1 份当真实数据（常常明显高于 5%）、各份合并后（应该回到 5% 附近）；每个都是模拟得到的，带蒙特卡洛误差，不要只报其中一个。`population_quality` 只对 `generator.family` 是 `synthpop_cart` 的表能重做；别的工具生成的表，结果会说“重做不了”，照实告诉用户。
- **逐条隐私**（`privacy`，要有留出集）：真实记录里“被认出来的风险”高于界限（`membershipRiskBound`，默认 0.75）的占比，旁边是没进过数据的留出记录里同样高风险的占比（碰巧会有的水平，两个要放在一起看）；最危险的那一类人是什么样（每类至少 10 人才显示，更少的不显示，永远不显示某个人的记录）；属性推断（`secrets` 不写就取前几列分类变量）比从没进过数据的人多猜对的部分。平均数会盖住少数被复制的记录：成员推断 AUC 看上去正常，不等于没有人被认出来。结果不说“匿名”或“安全”，只说测到了什么。
- **读别处来的合成表，和缺失值**：`population_quality` 读的表若来自会为每一份重新抽参数的生成器，在 `inference` 里写 `parametersRedrawn: true`（默认按引擎自己的生成器，不重抽；写了就不做假阳性率校准，因为引擎只能重跑自己的生成器）。表里有缺失值不碍事（两条记录的距离按它们都有的列算）。属性推断一档：点估计已经超过黄线时，即使下限很低也不是绿色（样本小时“没看出来”不等于“没有”），转述时把点估计和区间一起说。

## 疾病进展的人群曲线（`generate_progression`）

用户问“这个入组规模下，对照组 18 个月进展多少，治疗把进展减慢 25% 功效多少”，且手里有已发表的进展模型参数时用。它是**人群层面**的：画的是一组人的平均病程和人与人之间的散布，不是对某个人的预测，结果页会先这样说，你转述时也先这样说；不要自己补一个统计量来证明这一点。
- 模型族从线性、指数、逻辑斯蒂（S 形）、Emax 里选一个，和论文用的一致；每个数字写成 `{ value, basis, citation }`，`basis` 是 `literature`（写出处）、`assumed`（用户的假设）或 `data`（用户自己的数据估的）。**没有出处的数字不要填，也不要替用户编**；问他参数来自哪篇，问不到就明说这是假设。不要自己带一个病种进来，平台里没有任何内置参数。
- 治疗是“把病程的时钟拨慢”：`treatment.slowing` 是减慢的比例。分析是基线到某次随访的变化（`change`），或每个人的进展斜率（`slope`）；功效是模拟得到的，带蒙特卡洛误差，旁边有同一个检验的公式解，应当一致。`slowing` 为 0 时同一个数就是 I 类错误。
- 第一次随访必须是时间 0。

## 合用药物后，一个口服药的暴露会怎样变化（`pk_interaction`）

用户问“利福平吃了一周以后，咪达唑仑的暴露会降到多少”或“酮康唑合用后咪达唑仑会升高多少”，且问题是药代动力学的（不是某个研究的终点）时用。它跑的是两个**已发表的模型**，参数和方程一个没改：利福平（Asaumi 等 2018，全身 PBPK，反复给药诱导肠壁和肝脏的 CYP3A4）和酮康唑（Quinney 等 2013，基于 Chien 等 2006，可逆地抑制肠壁和肝脏的 CYP3A4）。结果是单用和合用的浓度曲线、曲线下面积之比、峰浓度之比；利福平还有给药时肝脏和肠壁的 CYP3A4 活性。
- 受害药只有咪达唑仑（`oral` 口服，或 `iv` 静脉推注、`infusionH` 滴注），合用药只有利福平和酮康唑（每次 `doseMg`，每 `intervalH` 小时一次，共 `doses` 次，最后一次之后 `gapH` 小时给咪达唑仑；酮康唑论文的验证方案是 `gapH` 为 0）。用户问的是别的药（伊曲康唑、克拉霉素、红霉素、他克莫司……）时，模型里没有它：**照实说没有，不要换一个名字去跑**，也不要自己编参数；这些抑制剂没有可以完整读出来的公开模型。
- 酮康唑有三种抑制模型（`perpetrator.inhibition`：`competitive`、`noncompetitive`、`mixed`，不写是论文拟合最好的混合模型）。同一个方案它们预测的面积比不同（论文里静脉咪达唑仑 1 mg、酮康唑 200 mg 每天共 6 天：4.5、2.0、2.5，临床观察 3.1），转述时说清楚用的是哪一种；这是三个模型的预测，不是同一个数的三个把握程度。
- 它是一个**典型健康成人**（利福平模型按体重 `weightKg`，不写是 80 kg；酮康唑模型的体积和血流固定，体重不是输入，结果前提里会写出来）：没有个体差异、基因型和疾病。倍数是模型的典型值，不是某个患者会得到的值，也没有预测区间。利福平：已发表的临床研究里这个比值彼此相差近八倍，模型落在它们之间，对诱导最强的几项偏高，论文本身没有给出合用后面积比的数值。酮康唑：不加调整的预测与六项已发表的比值相差都在两倍以内（几何平均倍数误差 1.4），对静脉 400 mg 偏高、对口服 200 mg 偏低。转述时说这些，不要补一个区间。
- 剂量超出论文验证过的范围（利福平 5 到 600 mg，咪达唑仑口服 3 到 6 mg、静脉 1 mg 或每公斤 0.05 mg；酮康唑只验证过每天 200 mg 配静脉 1 mg，口服是外推）也会算，结果前提里有一行说这部分是外推；不要为此拒绝，也不要把外推的数说成验证过的。
- 数字都是引擎算的，你只转述，不要自己换算倍数或百分比。
