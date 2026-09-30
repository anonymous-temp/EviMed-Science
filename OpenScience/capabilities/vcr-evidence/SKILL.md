---
name: vcr-evidence
description: Evidence parameterization for a 「虚拟临研」 study — find trial precedents, extract every number with the sentence and field position it came from, pool the verified values in the platform's engine, and write the pooled value, heterogeneity and prediction interval into versioned assumption cards.
metadata:
  evimed-agent: vcr-evidence
---

# 虚拟临研 — 证据参数化

你把一项研究要用的参数**从证据里做出来**，而不是让研究者自己填。人群、虚拟患者、
对照和试验四个工作区共用你写出来的假设卡：他们读的是你的数，所以每个数都要能指回原文。

工作语言与交付文字一律简体中文。药名、终点名、登记号、原文引用照原样写，不要改写。

## 一条规矩，先读它

**数字只能来自两个地方：从原文里抽出来的，或者引擎算出来的。你自己一个数都不许写。**

- 抽出来的数，必须能在这条登记记录的保全文本里**逐字找到**：引文逐字出现在记录里，
  值、置信区间的两端、样本量和事件数**都要出现在引文里**。平台在写入前用确定性的程序逐个核对；
  核对不过的值只留一条「未通过」的记录，**永远进不了假设卡**。所以不要「凭印象补一个差不多的数」。
- 合并值、I²、τ²、预测区间由平台的统计引擎算。你不做加权、不算异质性、
  不估区间、不把置信区间当预测区间用。引擎没给回结果，就不出这张卡，并在报告里写明原因。
- 假设卡的数（`pointValue`、分布）在证据卡上**不由你写**：平台从被引用的证据行或合并结果里取，
  你写的数会被当场拒绝（`vcr_write_field_forbidden`）。只有「专家设定」和「情景假设」两种卡由你给数，
  并且卡上照实标着「假设」。

## 六步

### 1. 读研究与已有的东西

- `mcp__evimed__vcr_read` `{ "what": "study" }` 和 `{ "what": "definition" }`：PICO、估计目标、主要终点、预期用途。
- `{ "what": "assumptions" }`：已经有哪些卡、哪些还空着。**先看已有的**——这一步常常是接着上次跑的。
- `{ "what": "precedents" }`：这项研究已经收进来的先例，计划入组与实际入组并列，每个参数核对通过了多少。
- `{ "what": "evidence", "filter": { "kind": "<参数名>" } }`：已经入库的抽取值（`filter.kind` 写参数名，例如 `median_time`；不写就是全部）。
  每一项带 `verification`、`armRole`、`endpointKey` 和引文。

### 2. 找先例

按 PICO 检索：`mcp__evimed__clinical_trial_search`（ChiCTR / ClinicalTrials.gov / Cochrane Central），
`mcp__evimed__literature_search` 与 `mcp__evimed__open_access_full_text` 找已发表的对照组数据，`mcp__evimed__guideline_search` 看终点口径，
`mcp__evimed__kb_search` 看这个项目自己的知识库。

相似度**只用来排候选**。终点定义不同、人群不同、年代差很远的研究，不会因为「看起来像」
就可以合并——合并前逐项检查，见第 4 步。

### 3. 收进先例，逐项抽取

对每一条候选，先读它的结构化记录：`mcp__evimed__trial_registry_record` `{ "registryId": "NCT02296125" }`
（登记平台是 ChiCTR 时再写 `"registry": "chictr"`，下面的 `precedent` 和 `evidence_item` 也一样）。它回给你：

- `values[]`：平台已经从登记字段里抽好的值，每个都带 `quote`、`locator`、`verification`，
  以及它属于哪个终点（`detail.outcome`，终点原名）和哪个组（`arm`，组原名）。`verification` 不是 `verified` 的，就是核对没过，按「未知」处理。
- `text`：这条记录的**保全文本**——你补抽的数，引文必须能在这里逐字找到。
- `unavailable[]`：这个登记平台**根本不记录**的量。

读完之后把它收进本研究：`mcp__evimed__vcr_write`

```json
{ "what": "precedent", "items": [ {
  "registryId": "NCT02296125",
  "endpointKeys": { "Median Progression Free Survival (PFS) (Months)": "pfs-blinded" },
  "armRoles": { "SoC EGFR-TKI (Global Cohort)": "control", "Osimertinib 80 mg (Global Cohort)": "treatment" },
  "line": "first", "biomarker": "egfr_positive" } ] }
```

平台自己取回这条记录、把里面的值抽出来并逐个核对，回给你 `results[].extracted / verified / refused`。你要判断并写下的只有两件事，只有你能判断：

- **`endpointKeys`**：键是终点的原名（`values[].detail.outcome`），值是你给这个终点口径起的短标识
  （小写字母、数字和 `-`、`_`，例如 `pfs-blinded` 与 `pfs-investigator` 是两个口径）。平台按它相等与否决定能不能合并，所以务必写，也务必写准；**没有 `endpointKey` 的值不参与合并**。
- **`armRoles`**：键是组的原名（`values[].arm`），值是 `control`、`treatment`、`contrast`、`single_arm`、`overall`、`unknown` 之一。平台会先按登记记录里的组类型猜一个，你的判断覆盖它；组的角色不明，值就不参与合并。
- 适用人群：`line`（治疗线）、`biomarker`。没写就是「未知」，而「未知」在分层里不算匹配。地区和年代平台自己从登记记录算，你不用填。

登记号找不到会回 `registry_not_found`，登记平台暂时问不到会回 `registry_unavailable`——两件事不一样，前者不代表这个试验不存在。

你自己在记录的保全文本里读到平台没有抽出来的数，用 `evidence_item` 补一项，一次一项或一批：

```json
{ "what": "evidence_item", "items": [ {
  "registryId": "NCT02296125", "parameter": "median_time", "armRole": "control",
  "arm": "SoC EGFR-TKI (Global Cohort)", "endpointKey": "pfs-blinded",
  "value": <引文里的那个数>, "unit": "月", "ciLow": <引文里的下限>, "ciHigh": <引文里的上限>, "sampleSize": <引文里的样本量>,
  "quote": "<保全文本里逐字抄下的那一句，里面要有上面每一个数>" } ] }
```

`parameter` 用平台认识的名字，合并才认得：`median_time`、`hazard_ratio`、`odds_ratio`、`risk_ratio`、`control_event_rate`、`response_rate`、`survival_at_time`、`dropout_rate`、`mean_value`、`mean_difference`、`risk_difference`、`accrual_to_primary_completion_months`。核对不过的项会记下来但值被清空，返回的 `issues` 里有原因（`quote_not_found`、`quote_missing_number` 等），**不要为了通过核对改引文**。
`historicalBaseline: true` 只在这个值确实是历史基线时写；`enrollmentKind` 用 `estimated` 或 `actual`。不写 `verification`：核对结果是平台的，你写不了。

三条硬规矩：

- **「预计」和「实际」分开。** ClinicalTrials.gov 的 `ESTIMATED` 是申办方的计划，`ACTUAL` 是真的发生了。
  计划值**不进历史基准**。对比表要把两者并排写出来——「计划入组 120 例 18 个月，实际 96 例 26 个月」
  本身就是入组预测最有用的先验。
- **登记平台没有的量写「不可得」，不要写 0。** 筛选失败率、每中心每月入组数、中心启动日期，
  四大登记平台都不记录，只能来自合作方或申办方。写 0 是编数据。
- **只有登记记录里的数能进假设卡。** 平台目前只把值对着登记记录的保全文本核对；论文正文和图表里读到的数
  核对不了，不进假设卡——可以在报告里作为背景写出来（带出处），但不参与合并。

### 4. 合并（交给引擎）

同一个参数、同一个 `endpointKey` 的核对通过值，交给 `mcp__evimed__evidence_pool`：

```json
{ "action": "start", "parameter": "median_time", "endpointKey": "pfs-blinded" }
```

可选 `method`（`random_effects_reml` 默认，还有 `random_effects_dl`、`random_effects_hksj`、`fixed_effect`、`single_study`）和 `calibres`。
平台只拿本研究里这个参数、这个终点口径、同一角色（比值类取 `contrast`，其余取 `control`）的**最新一行核对通过的值**，
按三种口径各排一个作业，`start` 回 `jobs[]`：

| 口径 | 是什么 |
|---|---|
| `closest` | 与本研究人群在地区、治疗线、年代、标志物上都对得上的子集 |
| `overall` | 全部同类研究 |
| `next_closest` | 差得最少的那一档 |

平台回 `not_started` 就是没有能合并的东西（`reason` 里有原因，例如没有核对通过的值、缺 `endpointKey`），照实写进报告，不要绕过去。`start` 的回答里 `refused` 列出被排除的每一项研究和原因（没通过核对、口径或组别不同、登记的是计划数），`refusedCount` 是总数：写报告时说清楚哪些研究没进合并、为什么。
`{ "action": "status", "jobId": "…" }` 读回来：`pooling` 里是合并值、`k`（研究数）、I²、τ² 和预测区间（自然尺度上的数，平台已换算好）。
少于三项研究时引擎给不出预测区间，`predictionAvailable` 为 `false`——这时写卡会自动成为加宽后的「专家设定·待补证」。

**默认口径由平台按写死的规则选**：`closest` 的合并值落在 `overall` 的预测区间外，
或者 `overall` 的 I² ≥ 0.5，就以 `closest` 为默认、另外两种进敏感性；否则以 `overall` 为默认。
你不用替它选，但要在报告里把规则和结论写出来。

### 5. 写假设卡

`assumption` 一张卡一项，`key` 是小写英文字母开头、只含小写字母数字和下划线的名字（例如 `control_median_pfs`），别的写法会被拒。有四种写法：

1. **合并结果做的卡**（最常用）：
   ```json
   { "what": "assumption", "items": [ { "key": "control_median_pfs", "name": "对照组中位 PFS", "unit": "月",
     "parameter": "median_time", "fromPooling": { "jobIds": { "closest": "<closest 作业的 id>", "overall": "<overall 作业的 id>" } },
     "note": "…" } ] }
   ```
   `jobIds` 写你刚才 `start` 回来的作业 id（三种口径里成功的几项）。平台把合并值和预测区间转成仿真能用的分布
   （比例 → Beta，时间与风险比 → 对数正态），并按上面的规则选默认口径，其余口径进敏感性。**这种卡不带 `pointValue`、`distribution`、`evidenceIds`**——都是平台填的。
2. **单项研究直接取值**：
   ```json
   { "what": "assumption", "items": [ { "key": "single_trial_median", "name": "唯一一项先例的中位 PFS", "unit": "月",
     "parameter": "median_time", "sourceKind": "external_evidence", "evidenceIds": ["<证据行的 id>"] } ] }
   ```
   只引用一条核对通过的证据行（用 `mcp__evimed__vcr_read` `what: "evidence"` 读到的 `id`），数由平台从那一行取。这一行的组要和参数对得上：比值类参数取 `contrast` 的行，其余取 `control` 的行，别的组的行会被拒，回的话里写着它属于哪一组。引用不是本研究的、或者没通过核对的证据，回 `vcr_evidence_unverified`。
3. **找不到证据的参数不要留空**：
   ```json
   { "what": "assumption", "items": [ { "key": "dropout_rate", "name": "脱落率", "parameter": "dropout_rate",
     "expertFrom": { "evidenceId": "<证据行的 id>", "reason": "只有一项中国人群研究，样本量小" } } ] }
   ```
   `expertFrom` 也可以写 `{ "jobId": "<合并作业的 id>", "parameter": "dropout_rate", "reason": "…" }`。平台以最接近的证据为中心把范围加宽，标「专家设定·待补证」，
   并写清楚缺的是什么。空着会让整条仿真跑不起来，而一个标注清楚的宽区间不会。
4. **你自己设定的值**（专家设定或情景假设）：
   ```json
   { "what": "assumption", "items": [ { "key": "hazard_ratio_scenario", "name": "情景：风险比", "sourceKind": "scenario", "pointValue": 0.7,
     "distribution": { "family": "lognormal", "params": { "meanlog": -0.36, "sdlog": 0.15 }, "range": { "low": 0.5, "high": 0.95 } },
     "note": "为什么这样设" } ] }
   ```
   `sourceKind` 用 `expert_set` 或 `scenario`；`distribution.family` 是 `point`、`normal`、`lognormal`、`beta`、`gamma`、`empirical` 之一，参数是有限的数
   （`normal` 用 `mean`、`sd`，`lognormal` 用 `meanlog`、`sdlog`，`beta` 用 `alpha`、`beta`），`range` 是 `{ low, high }`。
   这种卡不引用证据，卡上标的是「假设」，不冒充证据。

- 卡的取值范围用**预测区间**，不是置信区间：仿真问的是「下一个同类研究会落在哪」。
- 每张卡都有版本；改一个数是新版本，不是改写旧版本；同一个 `key` 同时写两次也不会撞版本。
- New assumptions remain labelled AI-set. The platform requests independent clinical and statistical AI reviews against frozen versions; a relevant edit requests a new review. Preserve findings and disagreements, continue supported work, and never wait for a human signature. Optional human review remains separately attributable.

### 6. 交付

两份必需文件，名字就是这两个：

- **`evidence-parameters.md`** —— 报告。按参数分节，每节写：默认值与分布、预测区间、
  用了哪几项研究（登记号 + 原文位置）、三种口径的对比与默认口径的理由、
  来源人群与本研究人群的差异（中国人群研究单独标出）、以及这张卡还缺什么。
- **`results.json`** —— 机器可读的结果，报告里的每个数都在这里有同样的字段。形状：
  `{ conclusion, counts, measures[], assumptions[], precedents[], unavailable[] }`；
  `assumptions[]` 抄自 `mcp__evimed__vcr_read` `what: "assumptions"` 读回的卡，`assumptions[].sources[]` 里每一项都带 `quote` 与 `locator`。

可选：`precedents.md`（先例对比表，计划与实际并列）、`applicability.md`（适用性逐项评估）、
`revision-notes.md`（改了什么、为什么——修订说明只写在这里，不写进报告正文）。

交付前先用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（它不消耗一次提交），把提示读完、改完，再 `evimed_submit_deliverable`。

## 报告里不要出现的东西

- 工具名、网关名、作业 id、运行目录、第一人称的检索过程（「我先搜了……」）。写结论和来源，不写过程。
- 「合并后效果显著优于……」这类把统计结论写成临床建议的话。这份包是设计参数，不是疗效结论。
- 没有来源的数。一个数写不出它的出处，就把它删掉，或者改成「不可得」。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最后一遍（载入 `manuscript-humanize` 的做法），放在最后跑，跑完之后数字、引文、来源标签和判定标记必须逐字节不变。

过程记述、改稿说明、自查记录写进 `revision-notes.md`，不要写进报告正文——报告正文里不写过程，正是因为过程有它自己的去处。

然后 `evimed_submit_deliverable{deliverableId}`。它应用的规则只有一份实现，和服务端应用的是同一份。
