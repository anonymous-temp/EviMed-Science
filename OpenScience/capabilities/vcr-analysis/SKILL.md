---
name: vcr-analysis
description: 「虚拟临床研究」的计算：临床试验的样本量与设计比较，按基线表生成合成人群与虚拟患者，外部对照与加权比较。每个对象按引擎认识的字段写下，平台交引擎算，结果页保留版本和前提，读回来讲清楚。
---

# Population, patient, comparator and trial research

Interpret the requested analysis, invoke exact tools and explain the saved result.
Do not perform statistical estimation in prose or manually fabricate a trajectory.

## Shared operating contract

Read [../vcr-protocol/references/operating-contract.md](../vcr-protocol/references/operating-contract.md) before this workflow; reuse it when already loaded in this conversation. It defines task scope, data requirements, evidence and continuation boundaries.

## Which part to read

Read the part this task is about before writing its first object; each part holds its objects' examples and the rules that go with them. Nothing in a part you do not need changes what the others say.

| The task | Read |
|---|---|
| a trial design: sample size, power, operating characteristics, a design grid, which design to recommend | [references/trial-design.md](references/trial-design.md) |
| a comparator: an external or literature control, an indirect comparison, borrowing, robustness | [references/comparators.md](references/comparators.md) |
| a population, virtual patients, a model's assessment record | [references/populations-and-patients.md](references/populations-and-patients.md) |
| a published equation applied to a population, or a fitted baseline | [references/models.md](references/models.md) |
| longitudinal histories, forecasts and their evaluation | [references/longitudinal.md](references/longitudinal.md) |
| a report and the files that go with it (a run dispatched for a deliverable reads this part too) | [references/delivery.md](references/delivery.md) |

A delivery owes its files under fixed names — `analysis-report.md` and `results.json` every time, `comparability.md` with a comparator, `simulation.json` with a trial design; what each holds, how numbers are cited and the checks before submitting are in the delivery part.

A report ends with two steps, `traceability-review` then `manuscript-humanize`; references/delivery.md says what each does. Process notes go in `revision-notes.md`, never in the report.

The method examples in these parts are reference shapes for the requested computation.
They do not require a complete study definition or a fixed order of methods.

## 四个数永远分开

真实患者数、事件数、有效样本量、生成记录数。生成两千条轨迹不会让真实患者数变成两千；加权后的有效样本量永远不超过它加权的真实人数；重建出来的伪个体不计入真实患者数，也不画成观察到的 KM 曲线。

## 把握度用结果自己的名字

同一个数字在不同算法下是不同的量：在典型研究条件下的把握度、考虑研究之间差异后的预期把握度、再考虑模型参数不确定性后的预期把握度、在一批虚拟人所属的那一项研究里的把握度，以及按药效的不确定性平均后得到显著结果的概率。回复里用结果自己带的名字（卡片上的 `powerName`、搜索和比较里的 `label`），不要把它们都说成“功效”。

## 区间要写清是哪一种

置信区间、可信区间、预测区间、蒙特卡洛区间。**不写「区间」两个字了事。** 模型生成的分布不画成观察到的 KM 曲线。

## Clinical extraction and adoption boundary

Reuse the protected native cohort definitions, import coverage and deterministic engine outputs. Clinical extraction can contribute metadata through dataset_semantics, with model_inferred provenance and exact source hashes; it cannot overwrite confirmed meanings or export patient rows. Report FHIR/OMOP field losses, unmapped concepts and denominator differences. Missing licensed interaction/dose references yield a named evidence gap, not a no-risk conclusion. Adverse-event report ratios are signals, not incidence, causality or trial outcome rates.

## Reply and continuation

Drive the authorized research through the available tools without asking again whether to continue. If one operation is unavailable, retain its partial results and carry on with the supported parts of the requested work. A queued calculation is pending, so read its status without claiming it finished; continue independent work while it runs. Missing model access, a missing modality, unknown applicability or a low quality score does not veto a report. Existing per-operation grants apply; no additional approval or manual adjudication is needed.

Reply in the researcher's language, with the research result first and the relevant limitation stated once. Explain what the result changes for the study; keep job identifiers, validation flags and internal receipts in the recorded artifacts unless requested.
