# 检索与筛选记录

对应交付物：`hfpef-sglt2-appraisal`。检索日期：**2026-09-10**（以下所有命中与检索时间均为该日）。

本文件记录的是**检索怎么做的**，供需要复核筛选流转的读者使用。评价判断本身在 `appraisal-table.md` 与 `appraisal-table.json`。

---

## 一、检索来源

| 来源 | 用途 |
|---|---|
| PubMed（经审计的生物医学文献连接器） | 定位关键随机试验与系统评价的题录、摘要、PMID |
| Europe PMC（含开放获取全文 JATS XML） | 获取开放获取全文，用于逐项核对效应量与端点定义 |
| Crossref | 核验 DOI 与题录 |
| ClinicalTrials.gov | 核验注册号与试验状态 |
| EviMed 综合文献索引（中／英文） | 中文文献与中文期刊索引的初筛 |
| 个人知识库 | 本工作区不存在 `.evimed-knowledge/` 目录，按知识库为空处理 |

## 二、检索式

```
empagliflozin heart failure preserved ejection fraction EMPEROR-Preserved
(empagliflozin) AND (heart failure) AND (preserved ejection fraction) AND (randomized controlled trial)
dapagliflozin heart failure mildly reduced preserved ejection fraction DELIVER trial
SGLT2 inhibitors heart failure preserved ejection fraction meta-analysis randomized trials
Total heart failure events empagliflozin preserved ejection fraction EMPEROR-Preserved recurrent
Jhund Claggett total heart failure events dapagliflozin DELIVER prespecified
empagliflozin versus dapagliflozin head-to-head heart failure comparison
SGLT2 inhibitors and cardiovascular outcomes in heart failure with mildly reduced and preserved ejection fraction
Empagliflozin in heart failure with mildly reduced or preserved ejection fraction meta-analysis
registry: NCT03057951, NCT03619213, NCT04157751
```

中文索引以「恩格列净／达格列净＋射血分数保留的心力衰竭」组合检索，命中以单中心小样本随机的替代终点研究（血糖、NT-proBNP、神经内分泌因子）为主，无符合本问题人群与结局口径者。

## 三、筛选流转

| 步骤 | 条数 |
|---|---|
| 题录初筛总量 | 47 |
| **纳入评价** | **13**（其中 6 篇进入 GRADE 证据体，7 篇列入排除说明） |
| 排除 | 34 |

排除理由（逐条）：

| 理由 | 条数 | 示例 |
|---|---|---|
| 非目标人群：LVEF ≤ 40% 或全射血分数谱的普通心衰人群 | 23 | DAPA-HF、EMPEROR-Reduced、SOLOIST-WHF、EMPA-REG OUTCOME、DECLARE-TIMI 58、VERTIS CV、SCORED |
| 急性心衰住院期人群且主要终点为 90 天复合分层终点 | 1 | EMPULSE（NCT04157751） |
| 同一试验同一结果的重复报告／以其他终点为主 | 6 | 肾终点分析、生活质量分析、血压分析、eGFR 分析等 |
| 机制研究、动物实验、综述、诊断／预后类文献 | 5 | 鼠 HFpEF 模型、GDF15 机制研究、HFpEF 流行病学综述 |
| HFpEF 人群中以健康状态为主要终点、不报告再住院或死亡的小样本随机试验 | 1 | PRESERVED-HF（NCT03030235，324 例，12 周，主要终点 KCCQ-CS） |

## 四、纳入标准与排除标准的逐条落地

**人群**：慢性心衰成人，LVEF ≥ 40%（本评价的问题口径）。每篇研究按**其自身**的纳入标准记录：
- EMPEROR-Preserved 与 DELIVER 正文均写作 **LVEF > 40%**，登记为 `> 40%`，未改写成 ≥ 40%。
- 未纳入任何仅以 LVEF ≥ 50% 为纳入标准并单独报告结局的随机试验（检索未发现此类专门试验）。
- 使用 HFpEF/HFmrEF 标签但无法逐条核实其射血分数口径者（间接比较、观察性研究、部分系统评价），已在 `appraisal-table.json` 的 `notes` 字段中标注。

**干预**：恩格列净与达格列净为一线关注对象。四项其他药物的资料仅作背景：
- 索格列净（SOLOIST-WHF）人群为急性心衰住院期，未列入。
- ertugliflozin（VERTIS CV）、索格列净（SCORED）人群为糖尿病，未列入。
- 坎格列净等无 HFpEF 专用结局试验，未列入。

**对照**：常规治疗背景下的安慰剂。活性对照的观察性研究（S10，对照为西格列汀）仅作一致性记录。

**结局**：心衰（再）住院分「首次事件」与「复发/总事件」两条证据体，不合并为一个效应量；心血管死亡与全因死亡各为独立证据体；仅报告复合终点者按复合终点记录，未拆写为单组分。此项在 `appraisal-table.json` 的 `B1`–`B4` 结构与本文件第五节均可核对。

## 五、复合终点与单组分的处理

| 来源 | 报告形态 | 本表如何处理 |
|---|---|---|
| EMPEROR-Preserved 主要报告 | 主要终点为复合终点；总心衰住院为独立次要终点 | 复合终点按复合终点记录；心衰住院的数字取自**独立次要终点**，不由复合终点反推 |
| DELIVER 主要报告 | 主要终点为复合终点；心衰住院、心血管死亡、全因死亡均为独立报告的终点 | 逐项按原文记录，未做任何拆分或反推 |
| DELIVER 总事件分析 | 复发事件按 LWYY 与联合脆弱模型分模型报告 | 两个模型的估计分别记录，未平均 |
| 全部来源 | 心血管死亡与全因死亡的单组分数值 | **未由任何复合终点反推**；EMPEROR-Preserved 的单试验数值因仅取得摘要而留空 |

## 六、去重

| 情形 | 处理 |
|---|---|
| 同一 PMID 被两套索引重复返回 | 保留一行，另一行以 `appraised: false` 与去重理由记录（S07） |
| 同一试验的多篇发表（EMPEROR-Preserved：主要报告／年龄亚组；DELIVER：主要报告／总事件分析） | 各自成行以保留其不同的终点与人群信息，但在注册号层面标注属同一次试验；在证据体中**不作为独立的一致性来源计数** |
| 同一试验被多个系统评价纳入 | 在证据体叙述中标明「数据不独立」，未把多篇系统评价当作多次独立验证 |

## 七、来源层级与可核对性

| studyId | 来源层级 | 可核对的效应量 |
|---|---|---|
| S01 | 摘要 | 复合终点、总心衰住院次数；单组分死亡数值未取得 |
| S02 | 全文 | 全部 |
| S03 | 全文（开放获取 XML） | 全部 |
| S04 | 全文 | 方向与交互 P 值；分层点估计未在所取得文本中给出 |
| S05 | 全文 | 全部 |
| S06 | 全文（开放获取 XML） | 全部 |
| S07 | 全文 | 与 S06 为同一记录 |
| S08 | 摘要 | 无（摘要未报告任何效应量） |
| S09 | 摘要 | 四组间接比较 |
| S10 | 摘要（会议摘要） | 复合终点 HR |
| S11 | 摘要 | MACE 与心衰亚组 |
| S12 | 未取得 | 无 |
| S13 | 摘要 | KCCQ 与 6 分钟步行试验；未报告本问题的四个结局 |

未取得全文的记录一律标注为「未取得」或「仅摘要」，其缺失的数值在本表中留空，**不以任何方式推断**，也未将其改写为阴性证据。
