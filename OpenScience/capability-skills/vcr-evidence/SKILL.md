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

- 抽出来的数，必须能在给定的来源文本里**逐字找到**，并且带上位置（文档 id + 字段路径或页码/表号）。
  平台在写入前会用确定性的核对程序检查这一条；核对不过的值会被作废并记成 `unknown`，
  **永远进不了假设卡**（验收项 AC-25）。所以不要「凭印象补一个差不多的数」——那只会变成一条 `unknown`。
- 合并值、I²、τ²、预测区间由平台的统计引擎（`evidence.pool`）算。你不做加权、不算异质性、
  不估区间、不把置信区间当预测区间用。引擎没给回结果，就不出这张卡，并在报告里写明原因。
- 由别的数算出来的量（入组时长、中心数）标「计算」，并写清楚用了哪两个字段；
  它不必出现在原文里，但它用到的每个输入都必须出现在原文里。

## 六步

### 1. 读研究定义

`vcr_read` `{ what: "study" }` 拿到 PICO、估计目标、主要终点和预期用途；
`{ what: "assumptions" }` 看已经有哪些卡、哪些还空着。**先看已有的**——这一步常常是接着上次跑的。

### 2. 找先例

按 PICO 检索：`clinical_trial_search`（ChiCTR / ClinicalTrials.gov / Cochrane Central），
`literature_search` 与 `open_access_full_text` 找已发表的对照组数据，`guideline_search` 看终点口径，
`kb_search` 看这个项目自己的知识库。

相似度**只用来排候选**。终点定义不同、人群不同、年代差很远的研究，不会因为「看起来像」
就可以合并——合并前逐项检查，见第 4 步。

### 3. 逐项抽取

对每一条候选，用 `vcr_read` `{ what: "trial_registry_record", registry, registryId }`
（或工具 `trial_registry_record`）拿结构化记录。它回给你：

- `record.values[]`：平台已经从登记字段里抽好的值，每个都带 `quote`、`locator` 和
  `verification`。`verification` 不是 `verified` 的，就是核对没过，按「未知」处理。
- `record.text`：这条记录的**保全文本**。你自己再补抽的数（例如从全文 PDF 或图表里读到的），
  引文必须能在对应来源里逐字找到；用 `locate_quote` 确认位置再写。
- `record.unavailable[]`：这个登记平台**根本不记录**的量。

写回用 `vcr_write`，一次一项，每项带 `parameter`、`arm`、`value`、`unit`、`quote`、`locator`。
另外要标两件事：

- **`endpointKey`**：这个值量的是哪个终点口径（例如 `pfs-blinded` 与 `pfs-investigator` 是两个口径）。
  这是只有你能判断的事，平台按它相等与否决定能不能合并，所以务必写，也务必写准。
- **适用人群**：`line`（治疗线）、`biomarker`。没写就是「未知」，而「未知」在分层里不算匹配。
  地区和年代平台自己从登记记录算，你不用填。

三条硬规矩：

- **「预计」和「实际」分开。** ClinicalTrials.gov 的 `ESTIMATED` 是申办方的计划，`ACTUAL` 是真的发生了。
  计划值**不进历史基准**。对比表要把两者并排写出来——「计划入组 120 例 18 个月，实际 96 例 26 个月」
  本身就是入组预测最有用的先验。
- **登记平台没有的量写「不可得」，不要写 0。** 筛选失败率、每中心每月入组数、中心启动日期，
  四大登记平台都不记录，只能来自合作方或申办方。写 0 是编数据。
- **原文保留。** 标准化的同时把原始写法留着，报告里并排显示。

### 4. 合并（交给引擎）

同一个参数、同一个 `endpointKey` 的核对通过值，交给 `vcr_simulate`
`{ action: "start", kind: "pool_evidence", scenario: { parameter, endpointKey, calibre } }`。
平台会按三种口径各排一个作业：

| 口径 | 是什么 |
|---|---|
| `closest` | 与本研究人群在地区、治疗线、年代、标志物上都对得上的子集 |
| `overall` | 全部同类研究 |
| `next_closest` | 差得最少的那一档 |

`{ action: "status" }` 读回来。引擎给的是：合并值、I²、τ² 和**预测区间**。

**默认口径由平台按写死的规则选**：`closest` 的合并值落在 `overall` 的预测区间外，
或者 `overall` 的 I² ≥ 0.5，就以 `closest` 为默认、另外两种进敏感性；否则以 `overall` 为默认。
你不用替它选，但要在报告里把规则和结论写出来。

### 5. 写假设卡

平台把合并值和预测区间转成仿真能用的分布（比例→Beta，时间与风险比→对数正态），
你负责把卡的**文字**写对：参数名、终点与时点、单位、适用人群差异、理由。

- 卡的取值范围用**预测区间**，不是置信区间：仿真问的是「下一个同类研究会落在哪」。
- 每张卡都有版本；改一个数是新版本，不是改写旧版本。
- 新卡的状态是「AI 设定」。复核是签注，不是关卡——不要等人复核才继续。
- 卡的 `evidence_ids` 指回抽取值，只能指默认口径用到的那些。

**找不到证据的参数不要留空**：用最接近的证据加宽范围，标「专家设定·待补证」，
并写清楚缺的是什么、从哪里能补上。空着会让整条仿真跑不起来，而一个标注清楚的宽区间不会。

### 6. 交付

两份必需文件，名字就是这两个：

- **`evidence-parameters.md`** —— 报告。按参数分节，每节写：默认值与分布、预测区间、
  用了哪几项研究（登记号 + 原文位置）、三种口径的对比与默认口径的理由、
  来源人群与本研究人群的差异（中国人群研究单独标出）、以及这张卡还缺什么。
- **`results.json`** —— 机器可读的结果，报告里的每个数都从它渲染。形状：
  `{ conclusion, counts, measures[], assumptions[], precedents[], unavailable[] }`；
  `assumptions[].sources[]` 里每一项都带 `quote` 与 `locator`。

可选：`precedents.md`（先例对比表，计划与实际并列）、`applicability.md`（适用性逐项评估）、
`revision-notes.md`（改了什么、为什么——修订说明只写在这里，不写进报告正文）。

交付前先用 `evimed_package_check{deliverableId}` 看一次提交会给出的判定（它不消耗一次提交），把提示读完、改完，再 `evimed_submit_deliverable`。

## 报告里不要出现的东西

- 工具名、网关名、作业 id、运行目录、第一人称的检索过程（「我先搜了……」）。写结论和来源，不写过程。
- 「合并后效果显著优于……」这类把统计结论写成临床建议的话。这份包是设计参数，不是疗效结论。
- 没有来源的数。一个数写不出它的出处，就把它删掉，或者改成「不可得」。

## 交付之前的两步

1. **`traceability-review`** —— 交付物里的每一个数和每一句引文都要回得去：数回到 `results.json` 的某个字段（即 `{{n:…}}` 的引用目标）或回到一条带原文位置的抽取值，引文回到它声明的那份来源。回不去的，删掉或改成「不可得」；**不要为了让它闭嘴改数据**。
2. **`manuscript-humanize`** —— 语气与用词的最