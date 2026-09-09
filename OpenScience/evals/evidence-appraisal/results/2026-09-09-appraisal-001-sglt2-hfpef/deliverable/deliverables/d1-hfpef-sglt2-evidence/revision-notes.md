# Revision notes（过程记录，非报告正文）

## 能力路由的澄清

会话上下文将本任务路由标记为 evidence-appraisal（evimed-evidence-appraisal），并要求按其 SKILL.md 执行。读该能力注册文件后确认：evidence-appraisal 的处理边界是"研究者已持有文献、仅作质量评价"，其 SKILL.md 明确写道「If the request is 'what does the evidence say about X', that is synthesis, not appraisal — it belongs to clinical-evidence-synthesis, which searches. The line between the two is whether the studies arrived with the request」。本次问题没有随问题附上任何研究，属于开放临床问题的证据综合；workspace 的 task-plan.json（本运行计划，contractKind=clinical-evidence-report、capability=clinical-evidence-synthesis）与 evidence-appraisal 能力自身划线一致。因此本包按 clinical-evidence-synthesis 契约（clinical-evidence-report 交付物及其九件产物）执行；evidence-appraisal 的 SKILL.md 也已读入并作为"逐结局确定性评级"的参照。

## 检索与来源决策

- 检索遵循"记忆/胶囊 → 文献/指南 → 网页"顺序；个人记忆检索仅命中一条抗菌药物相关验收记忆，与本题无关，未作来源。网页检索未执行（文献与指南已足以覆盖；监管文本未单独抓取，正文不声称读取说明书）。记录于检索日志的 12 条查询为实际执行的查询（含 1 条 0 命中与 1 条注册库查询）。
- 保留原文 5 份：DELIVER 全文（NEJM）、ESC 2023 聚焦更新全文、EMPEROR-Preserved 的 EHJ 分析全文、Yang 2022 与 Hamid 2024 系统综述全文。EMPEROR-Preserved 主文（NEJM）无开放获取副本，未编为参考文献；其试验结果由 ESC 2023 聚焦更新与 Böhm 2023 两处保留全文承载，并在 audit 中注明。
- 2022 AHA/ACC/HFSA 指南的指南库保留文本为节选，无法定位 SGLT2i 推荐条文；指南"2a 类"表述经 Yang 2022 保留全文承载并限界，未把节选文本当原文引用。

## 方法与表述

- 按结局作 GRADE 领域结构化分级，报告已在方法与局限性中声明这不是 GRADE 工作组的正式认证；每处"降级"均写明原因（不精确），确定性等级与降级步骤在段落内一致。
- 心衰住院、心血管死亡与全因死亡按"证据显示有效 / 未检索到直接证据 / 未达显著（区间含无效值）"三类状态区分表述，未把阴性界值结果写成"证实无效"。
- 绝对获益量级（2.8 个百分点、需治数约 36）为推导结果，在结果与讨论中以〔推导〕标记并给出方法、假设与敏感性；未进入临床实践要点。推导初稿曾写"6.5 次/人年"，属单位错误（原文为每 100 患者-年口径）；终稿在推导敏感性、报告讨论句与矩阵中统一为"每百患者-年口径"，不再给出按人年换算的数值。
- 摘要方法句的检索计数（12 条、112 条记录、去重 21、纳入 5）与检索日志严格一致。
