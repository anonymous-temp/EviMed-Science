# 系统评价证据缺口报告

## 研究问题
SGLT2 inhibitors versus placebo for chronic kidney disease progression in adults

## 当前结论
本次运行被判定为 `evidence_gap`，状态为 `blocked`。系统已阻止生成投稿式 Meta 分析正文；需要先完成证据核验、全文补充或人工裁决。

## PICO
- 人群：Adults (≥18 years) with chronic kidney disease (CKD), defined by an estimated glomerular filtration rate (eGFR) <60 ml/min/1.73m2 and/or urine albumin-to-creatinine ratio (UACR) ≥30 mg/g, including both diabetic and non-diabetic etiologies.
- 干预：SGLT2 inhibitors (e.g., dapagliflozin, empagliflozin, canagliflozin, ertugliflozin, sotagliflozin) at any dose and frequency, with or without background standard of care (including other glucose-lowering or antihypertensive medications).
- 对照：Placebo, with or without identical background standard of care.
- 主要结局：Kidney disease progression, defined as a composite of sustained ≥40% decline in eGFR, end-stage kidney disease (ESKD) [need for dialysis, kidney transplant, or sustained eGFR <15 ml/min/1.73m2], or death due to kidney disease.

## 检索与筛选概况
- 检索/来源：PubMed, curated literature index, OpenAlex, ClinicalTrials.gov
- 识别记录：571
- 去重后记录：555
- 题名/摘要筛选：20
- 全文评估：2
- 综述层面纳入/提取：0
- 主结局可合并研究：0

## 阻断原因
- `insufficient_primary_effects`: Primary meta-analysis has 0 computable effect(s); at least 2 are required.
- `evidence_gate_evidence_gap`: EvidenceGate classified this run as an evidence gap (eligible=0, meta eligible=0).

## 待复核警告
- `limited_text_sources_present`: 1 retrieved/screened record(s) use limited source text (1 abstract-only).

## 入池候选行审计
- 未选择主结局候选行。

## Retrieval and Processing Notes
1 run-level warning(s) were recorded during retrieval, parsing, analysis, or output generation. Review the project run-warning log before external use.
- `retrieval/clinicaltrials_fallback_failed`: ClinicalTrials.gov fallback had 1 failed request(s); registry-first trials may be missing.
## 下一步处理建议
1. 补充或重新上传被标记为 abstract-only 的全文 PDF。
2. 在 extraction review 界面核验每个主结局数字、页码、表格和原文引用。
3. 对目标时间点不明确的行进行人工裁决，必要时改为 narrative-only。
4. 所有 blockers 清零后再生成投稿式 manuscript。

Evidence readiness warning: This run is classified as `evidence_gap` and is not cleared for quantitative synthesis because unresolved evidence blockers remain (insufficient_primary_effects, evidence_gate_evidence_gap). See `manuscript_facts.json`, `extraction/extraction_audit.json`, and `analysis/effect_selection_audit.json` before external use.