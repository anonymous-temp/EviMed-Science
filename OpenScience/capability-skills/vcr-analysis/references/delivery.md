# Delivering an analysis

Part of the vcr-analysis skill: read it with [../SKILL.md](../SKILL.md), which holds what applies to every analysis. This part is for the report and the files that go with it.

## 交付

**每次交付都是一份报告加一份机器可读结果**，名字固定：

| 文件 | 何时交 | 内容 |
|---|---|---|
| `analysis-report.md` | 每次 | 这一步做了什么、结果是什么、可信到什么程度、有什么局限 |
| `results.json` | 每次 | 机器可读的结果：结论、四个数、指标、诊断 |
| `comparability.md` | 做对照时 | 十个可比性维度逐项、ICH E10 四条件、重叠与平衡 |
| `simulation.json` | 做试验时 | 模拟报告的结构化版本 |

`results.json` 至少要有 `conclusion`、`counts`（四个数，没有的写 `null` 不写 `0`）、`measures`（每个仿真指标带 `mcse`）、`diagnostics`；人群还要 `waterfall`（每步带 `unknown`）与 `populationKind`，经验合成人群另加 `qualityReport`（保真度、可用性、泄露风险）；对照还要 `estimand` 与 `diagnostics`。

`simulation.json` 按 FDA 复杂创新设计指导原则的清单：`designSummary`、`exampleTrial`（取自仿真结果的 `diagnostics.exampleTrial`，引擎用种子算的第一次重复，不自己编）、`scenarios`（含 `null: true` 的零效应情景）、`replicates`、`operatingCharacteristics`（每行带 `mcse`）、`sensitivity`、`code`（种子与软件版本）、`summary`。

**报告里的每个数写成 `{{n:…}}` 引用**，用 `mcp__evimed__vcr_read` `what: "report_model"` 看能引用哪些路径。例如 `{{n:measure(power).value|pct1}}`、`{{n:counts.realPatients|thousands}}`、`{{n:measure(power)|pm}}`、`{{n:measure(hazard_ratio)|ci}}`；同一份报告里比较几个方案时按方案的 id 指名：`{{n:measure(power, scenario=<方案 id>).value|pct1}}`。平台在交付时按研究已保存的结果渲染这些引用，渲染不出来的写成「未计算」，不会写成 0；手打的数字（年份、12 以内的序号、日期、页码图表编号和「」里引的方案原文除外）平台也写成「未计算」，并在返回值 `issues` 里告诉你；读不成引用的 `{{n:…}}`（格式要小写，如 `pct1`）同样。

**要一份短记录时**（有人要把某个结果交给别人看，不是每次交付都要）：`mcp__evimed__vcr_write` `what: "result_record"`，`data: {"resultId": "<结果 id>"}`。平台从已保存的结果生成：它是什么结果、运行时的假设、种子和版本、一个示例试验（仿真结果里引擎用种子算的第一次重复）、回到结果和输入的链接。不用你写正文，也不要在没人要的时候做。

## 运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（不消耗提交）：文件在不在、四个数有没有分开、仿真指标有没有蒙特卡洛误差、零效应情景在不在、区间有没有写明种类、「不可估计」有没有带规则与缺口。它的发现全部是提示级——照它说的修，修不了的写进报告。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
