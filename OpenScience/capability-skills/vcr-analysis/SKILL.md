---
name: vcr-analysis
description: 「虚拟临研」的人群、虚拟患者、对照与试验四步：按数据档位选路、配置、交引擎算、读回来讲清楚。
---

# 人群、虚拟患者、对照与试验

## 模型不产生数字

**这一条排在最前面，因为它是整个板块成立的前提。** 你不做统计：样本量、功效、I 类错误、偏倚、覆盖率、有效样本量、标准化差异、RMST、入组时间分布、蒙特卡洛标准误——每一个都来自 `mcp__evimed__vcr_read` 读到的已保存结果，或 `mcp__evimed__vcr_simulate` 排出去的引擎作业。你负责的是：说清楚要算什么、把场景配对、读回结果、判断它可信到什么程度、讲清楚它意味着什么。

心算出来的、"按经验大约"的、从记忆里搬来的数，一律不得写进交付物。需要而没有的数，写清楚缺它、缺的原因、由哪一步能补上。

## 先读

- `mcp__evimed__vcr_read` `what: "study"` — 数据档位（T0/T1/T2/T3）、预期用途、七步进度、结局封存状态。
- `mcp__evimed__vcr_read` `what: "definition"` — 估计目标与终点类型。**终点类型决定所有方法分支。**
- `mcp__evimed__vcr_read` `what: "assumptions"` — 已有的假设卡及其版本。
- `mcp__evimed__vcr_read` `what: "results"` — 已经算过什么。**算过的不重算**；过期的（带 `stale`）要重算。
- `mcp__evimed__vcr_read` `what: "models"` — 模型与方法库：能用哪些模型、每个模型的层级与缺什么证据。

## 步骤 3：人群

数据档位决定从哪里开始：

| 档位 | 人群 `kind` | 作业 |
|---|---|---|
| T1–T3 有患者级数据 | `real` | `build_cohort` |
| 有本地数据但要外发 | `empirical_synthetic` | `synthesize_population` |
| 只有文献基线表 | `literature` | `generate_population` |
| 什么都没有 | `scenario` | `generate_population` |

`mcp__evimed__vcr_write` `what: "population"`，写 `kind`、`definition`（筛选条件或分布设定）、`allowedUses`。合成人群的 `allowedUses` 只能是 `design` / `feasibility` / `testing` / `training` / `shared_preview`——**合成人群永远不进真实外部对照**（§5.1）。

筛选流程每一步都要单列三个数：保留、排除、**无法判断**。把「无法判断」并进「排除」，是这一步最常见也最贵的错误。

## 步骤 4：虚拟患者

在库里选能覆盖这个人群和这个终点的**最高一级**模型（`validated` > `data` > `literature` > `scenario`）。选不到就用文献模型或情景模型，并在报告里写明是哪一级、为什么。

`mcp__evimed__vcr_write` `what: "patient_set"`：`modelId`、`modelVersion`、`scenario`。

**「数字孪生」这四个字有门槛**：个体条件化、随新数据更新、校准过的不确定性、验证记录，四项齐全才是 `digital_twin`，否则是 `baseline_conditioned_prediction`（基线条件化预测）。平台自己按证据推导这个标签，你不要替它下结论。

模型不适用时（人群、终点或输入超出范围），给出「适用性问题」：哪一项超出范围，然后在「换一个合适的模型」「用文献模型或情景模型并标明」「提一个数据需求」三条里选一条，照实标注。**不要编一条轨迹顶替**（AC-13）。

## 步骤 5：对照

`mcp__evimed__vcr_read` `what: "comparator"` 会回来 `routes`——这个数据档位能走哪几条路线，是确定性的：

| 路线 | 最低档位 | 作业 |
|---|---|---|
| `prognostic_adjustment` 预后校正 | T3 | `weight_comparator` |
| `external_control` 真实外部对照 | T2 | `weight_comparator` |
| `literature_control` 文献对照 | T0 | `rmst` |
| `model_comparator` 模型预测比较器 | T0 | `rmst` |
| `hybrid_control` 混合对照 | T0 | `map_prior` |

先按 ICH E10 的四个条件判断外部对照是否适宜（效应远大于自然变异、终点客观、病程可预测、预后因素已知可得），再逐项过 FDA 外部对照草案的十个可比性维度。

估计目标默认 `ATT`（对试验人群）。换成 `ATE` 或 `ATO` 必须写明理由——加权改变的是"这个效应是对谁说的"。

**「不可估计」是一份完成的结果。** 熵平衡无解、共同支持域外比例越界、加权后有效样本量低于下限、关键协变量标准化差异 ≥ 0.1、τ 超过随访、重建未过质控、MAP 先验冲突——这七条是确定性规则，由引擎判定。触发了就 `mcp__evimed__vcr_write` `what: "comparator"` 带 `conclusion: "not_estimable"` 和 `gapList`（缺什么、缺到什么程度、补上之后能做什么），照常交付。

## 步骤 6：试验

按 ADEMP 五段组织场景，`mcp__evimed__vcr_write` `what: "trial_scenario"`，通常写三个方案并排比。每个方案：

- `design`：`single_arm` / `single_arm_external` / `two_arm_fixed` / `group_sequential` / `simon_two_stage`。
- `endpointType`：与研究定义一致。
- `configuration.truth`：真值情景。**必须有一个零效应情景**（`{"isNull": true}`），否则 I 类错误无从谈起。
- `configuration.accrual`：入组节奏。
- `configuration.performance`：默认全开（功效、I 类错误、偏倚、覆盖率、期望样本量、周期、成本）。
- `assumptionIds`：这个方案用到的假设卡。

**解析优先、仿真复核**：固定设计和成组序贯的边界、样本量、事件数先用 `design_analytic` 算，再用 `design_simulation` 核对；两者差异超出蒙特卡洛误差就在报告里说出来（AC-29）。

重复次数不用你定：零假设情景默认不少于 2 万次，备择不少于 5,000 次，`configuration.targetMcse` 写了目标精度就按 p(1−p)/MCSE² 自动抬高。

排作业：`mcp__evimed__vcr_simulate` `action: "start"`，拿到 `jobId`，`action: "status"` 轮询。**作业超出研究计算预算会停在确认处**——这是平台三个人工停点之一。停了就照实告诉用户在等什么、大概多少机时，然后继续做不依赖它的部分。

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
| `simulation.json` | 做试验时 | FDA 复杂创新设计清单的结构化版本 |

`results.json` 至少要有 `conclusion`、`counts`（四个数，没有的写 `null` 不写 `0`）、`measures`（每个仿真指标带 `mcse`）、`diagnostics`；人群还要 `waterfall`（每步带 `unknown`）与 `populationKind`，经验合成人群另加 `qualityReport`（保真度、可用性、泄露风险）；对照还要 `estimand` 与 `diagnostics`。

`simulation.json` 按 FDA 复杂创新设计指导原则的清单：`designSummary`、`exampleTrial`、`scenarios`（含 `isNull: true` 的零效应情景）、`replicates`、`operatingCharacteristics`（每行带 `mcse`）、`sensitivity`、`code`（种子与软件版本）、`summary`。

**报告里的每个数写成 `{{n:…}}` 引用**，例如 `{{n:measure(power).value|pct1}}`、`{{n:counts.realPatients|thousands}}`、`{{n:measure(power)|pm}}`、`{{n:measure(hazard_ratio)|ci}}`。平台按 `results.json` 渲染（§8.3、AC-20）。手打的数字会被标出来。

## 运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（不消耗提交）：文件在不在、四个数有没有分开、仿真指标有没有蒙特卡洛误差、零效应情景在不在、区间有没有写明种类、「不可估计」有没有带规则与缺口。它的发现全部是提示级——照它说的修，修不了的写进报告。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
