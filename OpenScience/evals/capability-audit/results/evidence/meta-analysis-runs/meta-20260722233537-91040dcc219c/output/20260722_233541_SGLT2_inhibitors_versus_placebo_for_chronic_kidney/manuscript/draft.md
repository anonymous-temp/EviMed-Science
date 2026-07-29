# 系统评价证据缺口报告

## 研究问题
SGLT2 inhibitors versus placebo for chronic kidney disease progression in adults

## 当前结论
本次运行被判定为 `evidence_gap`，状态为 `blocked`。系统已阻止生成投稿式 Meta 分析正文；需要先完成证据核验、全文补充或人工裁决。

## PICO
- 人群：Adults (age ≥18 years) with chronic kidney disease of any stage, with or without diabetes mellitus
- 干预：Sodium-glucose co-transporter-2 (SGLT2) inhibitors (e.g., canagliflozin, dapagliflozin, empagliflozin, ertugliflozin, sotagliflozin) at any dose, as monotherapy or as part of combination therapy
- 对照：Placebo, no pharmacological treatment, lifestyle intervention alone, active pharmacological comparator (other glucose-lowering drugs or other CKD treatments), or standard of care without an SGLT2 inhibitor
- 主要结局：Composite of kidney disease progression: sustained decline in estimated glomerular filtration rate (eGFR) of ≥50%, progression to end-stage kidney disease (requiring dialysis or transplantation), or death due to kidney disease, as defined by the trial authors

## 检索与筛选概况
- 检索/来源：PubMed, curated literature index, OpenAlex, ClinicalTrials.gov
- 识别记录：576
- 去重后记录：20
- 题名/摘要筛选：20
- 全文评估：3
- 综述层面纳入/提取：2
- 主结局可合并研究：2

## 已计算但未放行的统计结果
主结局当前可计算 2 个效应量，RR 0.7992881557729065 (95% CI 0.7272984471350266 到 0.8784035748673147)。该结果仅用于调试和人工核验，不应作为投稿结论。

## 阻断原因
- `primary_counts_not_source_verified`: Primary-effect row 39453837:1 does not source-verify all arm-level event/total counts used for pooling: total_intervention=3304, total_control=3305.

## 待复核警告
- `limited_text_sources_present`: 2 retrieved/screened record(s) use limited source text (2 abstract-only).

## 入池候选行审计
| 行 | 研究 | 结局 | 来源 | 引用验证 | 置信度 |
|---|---|---|---|---|---|

## Retrieval and Processing Notes
1 run-level warning(s) were recorded during retrieval, parsing, analysis, or output generation. Review the project run-warning log before external use.
- `retrieval/clinicaltrials_fallback_failed`: ClinicalTrials.gov fallback had 1 failed request(s); registry-first trials may be missing.
## 下一步处理建议
1. 补充或重新上传被标记为 abstract-only 的全文 PDF。
2. 在 extraction review 界面核验每个主结局数字、页码、表格和原文引用。
3. 对目标时间点不明确的行进行人工裁决，必要时改为 narrative-only。
4. 所有 blockers 清零后再生成投稿式 manuscript。

Evidence readiness warning: This run is classified as `evidence_gap` and is not cleared for quantitative synthesis because unresolved evidence blockers remain (primary_counts_not_source_verified). See `manuscript_facts.json`, `extraction/extraction_audit.json`, and `analysis/effect_selection_audit.json` before external use.