---
name: vcr-package
description: 把一项「虚拟临床研究」写成可检查、可复现的研究包；报告里的每个数都是指向结果字段的引用，由平台渲染。
---

# 研究包与对外资料

## 模型不产生数字

**你写字，不写数。** 报告里每一个数都写成 `{{n:结果字段}}` 的引用，平台按研究已保存的结果渲染。你手打进正文的数字，平台在报告里写成「未计算」，并在 `mcp__evimed__vcr_write` 的返回值里当作问题标出来。需要一个数而结果里没有，就写清楚它没有被算出来，不要从对话记录里抄一个，也不要"大约"。

这不是一道检查，是构造：数字改了，报告跟着改；一个数在结果里找不到对应字段，说明那句话没有依据。

## 先读

- `mcp__evimed__vcr_read` `what: "study"` — 名称、问题、数据档位、预期用途、结局封存状态、过期结果，以及 `intendedUseCeiling`：这份包最高能标到哪一级（`ceiling`）、你请求的是哪一级（`requested`）、有没有超出（`withinCeiling`）和为什么（`reasons`）。
- `mcp__evimed__vcr_read` `what: "definition"` — 研究定义与估计目标。
- `mcp__evimed__vcr_read` `what: "assumptions"` — 每张假设卡的取值、分布、来源、复核状态。
- `mcp__evimed__vcr_read` `what: "results"` — 全部当前结果，每条带 `stale`（过期与否及原因）、`intendedUse`、`useDowngrade`。
- `mcp__evimed__vcr_read` `what: "population"` / `"comparator"` / `"trial"` — 定义与版本。
- `mcp__evimed__vcr_read` `what: "jobs"` — 执行记录：种子、环境、CPU 秒。
- `mcp__evimed__vcr_read` `what: "report_model"` — **可以引用的字段有哪些**：`{{n:…}}` 的路径都在这里（`counts`、`measures`、`assumptions`、`definition`、按场景 id 分开的结果等）。人数很小的格子读给你的时候已经隐去；引用照写，平台渲染时用的是完整的数。

## 包的结构

九个部分，顺序固定（HARPER / STaRT-RWE / TARGET / ADEMP）：

| 部分 | 内容 |
|---|---|
| 研究与分析概要 | 问题、人群、估计目标、预期用途、方法 |
| 输入清单 | 数据快照、可见范围、模型与方法版本、哈希 |
| 假设登记表 | 取值或分布、来源与原文位置、不确定性、复核状态 |
| 人群与对照定义 | 筛选或生成、时间零点、权重、排除 |
| 结果 | 机器可读的估计值与仿真汇总 |
| 图表 | 分布、轨迹、平衡、不确定性、方案取舍 |
| 执行记录 | 代码与配置、计算环境、随机种子、时间、算力用量 |
| 验证与局限 | 数值检查、模型与数据的适用性、未解决的问题；**结局封存的两个时间戳** |
| Decisions | Review findings, alternatives considered and intended next use |

## 封面照实写

- **Review provenance**: copy the stored clinical/statistical AI review role, actual model, configuration revision, time and referenced versions. Show pending, unavailable, stale and unresolved findings honestly. Human review is optional and must retain the actual person’s attribution. Review is advisory: disagreement or timeout never blocks export or lowers intended use by itself. Use the evidence/method applicability ceiling returned by `mcp__evimed__vcr_read`; AI agreement is not numerical verification or empirical validation. Never invent a reviewer identity.
- **过期结果**：有就写明哪几项、为什么过期、是重算了还是照原样保留。**不要把过期结果从包里删掉**。
- **预期用途降级**：结果的 `useDowngrade` 不为空时，把「本来想标什么、实际只能标到哪一级、因为哪个模型缺哪项证据」写进「验证与局限」。
- **结局封存**（确证性用途）：分析计划冻结的时间与哈希、结局字段首次读取的时间，两个时间戳并列，先后顺序一目了然。探索性用途没有封存，就照实写「探索性分析，分析计划在接触结局后制定」。

## 写法：报告走 `mcp__evimed__vcr_write` 这一条通道

研究包的正文只有一个提交口：`mcp__evimed__vcr_write` `what: "report"`：

```json
{ "what": "report", "data": { "kind": "study_package", "section": "main", "template": "<带 {{n:…}} 引用的正文>" } }
```

`kind` 还可以是 `cde_communication_pack`、`simulation_report`、`validation_pack`、`model_analysis_plan`、`model_analysis_report`；写另一份资料就换 `kind`。
平台在这里把 `{{n:…}}` 渲染成数字，放进研究者拿到的导出包的封面和正文；**你读不到渲染后的数字，也不需要**——引用写对，数就对。
返回值里的 `issues` 是平台渲染时发现的问题：找不到的引用、缺蒙特卡洛误差的仿真值、没写明种类的区间、手打的数字（报告里已写成「未计算」）、读不成引用的 `{{n:…}}`（报告里同样写成「未计算」）。照着改，再写一次：**整份正文一次写完**，再提交的会取代上一次提交的，不要分节多次提交（模型分析计划和模型分析报告除外：它们按节提交，见下）。

工作区里的 `study-package.md` 存放的是**同一份带引用的正文**（`{{n:…}}` 原样保留），它是交付物检查的对象，也是渲染前的原稿；不要在里面手工替换成数字。

引用的写法：

| 写 | 渲染成 |
|---|---|
| `{{n:counts.realPatients\|thousands}}` | `1,284` |
| `{{n:measure(power).value\|pct1}}` | `71.2%` |
| `{{n:measure(power)\|pm}}` | `0.712（蒙特卡洛标准误 0.0031）` |
| `{{n:measure(hazard_ratio)\|ci}}` | `置信区间 0.520～0.910` |
| `{{n:results.comparator.counts.effectiveSampleSize\|int}}` | `186` |
| `{{n:assumptions[0].value\|f1}}` | `4.1` |

年份、12 以内的序号和月份、日期、页码和图表编号（第 35 页、图 3）、用「」引起来的方案原文（「年龄 ≥ 18 岁」）里的数不算手写数字，不用写成引用；其余的数，包括方案里的阈值，在正文里要么写成引用，要么放进「」里照抄原文。

## 模型分析计划与模型分析报告

这两份文件（`kind: model_analysis_plan` 和 `model_analysis_report`，结构依据 ICH M15）**表格、登记项和数字都是平台写的**：模型与模型卡、假设与证据、方法与情景、评估表、冻结的版本与哈希、与计划的偏离、结果表。你只写各节的文字，每节提交一次，`section` 只能是下面这些，别的会被拒绝：

| 文件 | 你写的节（`section`） |
|---|---|
| 模型分析计划 | `introduction` 引言、`objectives` 目的、`data` 数据、`methods` 方法 |
| 模型分析报告 | `executive_summary` 摘要、`introduction` 引言、`objectives` 目的、`data_methods` 数据与方法、`results` 结果、`discussion` 讨论、`conclusions` 结论 |

```json
{ "what": "report", "data": { "kind": "model_analysis_report", "section": "discussion", "template": "<讨论的文字，数字用 {{n:…}} 引用>" } }
```

先用 `mcp__evimed__vcr_read` `what: "report_model"`、`filter: { "kind": "model_analysis_report" }` 读平台已经写了什么：`modelAnalysis.plan`（冻结的版本、时间、冻结者、哈希）、`modelAnalysis.deviations`（报告相对冻结计划的每一处偏离）、`modelAnalysis.results`（每个结果的结论、指标与区间，路径 `modelAnalysis.results[i].measures[j]` 可以引用）、`modelAnalysis.current.assessments`（评估记录）。文字里的数一律写成引用，手打的数字照旧被写成「未计算」。

- **计划的文字写在冻结之后，不改计划本身**：计划的内容已经冻结，你写的是对它的说明；不要在文字里改写评估表、版本或哈希，也不要写任何结果。
- **报告的偏离要逐项说明**：平台列出的每一处偏离，在「讨论」里说明为什么变、对结果有什么影响；没有冻结的计划就照实写「分析是在没有事先冻结计划的情况下做的」，不要编一个计划。
- **「不可估计」是完成的结果**：平台在结果表里已经写成「不可估计」和触发的规则，你在「结果」「讨论」里说明缺什么、补上之后能做什么，不要补数。
- **评估表的最后两行**（模型与模型结果的评价、证据评估的结论）是分析做完之后用 `what: "model_assessment"` 补的：写一次新版本，把 `evaluation`（技术标准满足得怎样）和 `outcome`（这些结果能不能作为模型证据）填上，计划阶段的各项原样保留。

## 规矩

1. **「不可估计」是一份完成的结果**，照常写进包里：触发了哪条确定性规则、缺什么、补上之后能做什么。不要把它写成失败，也不要绕开它谈别的。
2. **四个数分开写**：真实患者数、事件数、有效样本量、生成记录数。重建的伪个体单列，不并入真实患者数。
3. **区间写清种类**：置信、可信、预测、蒙特卡洛。模型生成的分布不画成观察到的 KM 曲线。
4. **引用能打开**：每条外部证据带 `.evimed-sources` 下的路径或可解析的标识符。
5. **不写后台**：工具名、网关名、作业号、"我检索了…"这类过程叙述不进正文；过程该写的地方是执行记录。

## 交付

| 文件 | 必需 | 内容 |
|---|---|---|
| `study-package.md` | 是 | 上面九个部分的正文，数字全部是引用 |
| `results.json` | 是 | 这份包渲染所依据的结果文档（`mcp__evimed__vcr_read` 回来的结果整理成一份） |
| `assumption-register.md` | 是 | 假设登记表：每张卡的取值或分布、来源与原文位置、不确定性、复核状态 |
| `execution-record.md` | 是 | 每次执行的方法与版本、随机种子、计算环境、时间、CPU 秒、输出哈希 |
| `cde-communication-pack.md` | 否 | 按《真实世界证据支持药物注册申请的沟通交流指导原则》组织的必要性与可行性、数据适用性、方案与统计分析计划、偏倚控制与敏感性分析 |

## 运行完成前

用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（不消耗提交）：文件在不在、`results.json` 能不能读、正文里的数是不是都能在结果里找到、四个数有没有分开、封面有没有写复核状态与过期结果、确证性用途下两个封存时间戳在不在。它的发现全部是提示级——照它说的修，修不了的写进「验证与局限」。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
