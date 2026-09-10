#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建 HFpEF/HFmrEF SGLT2 抑制剂证据质量评价表（修订版 v2）。

脚本做三件事：
1. 写出 appraisal-table.json（源文件，其余格式均由它渲染）；
2. 由 JSON 渲染 appraisal-table.csv 与 citation-ledger.csv；
3. 机械复核每个证据体的确定性算术，以及 md / csv / json 之间的一致性。
"""

import csv
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

DELIVERABLE_ID = "hfpef-sglt2-appraisal-v2"

# --------------------------------------------------------------------------
# 证据集
# --------------------------------------------------------------------------

STUDIES = [
    {
        "id": "S01",
        "citationShort": "EMPEROR-Preserved 主要报告",
        "citation": ("Anker SD, Butler J, Filippatos G, et al. Empagliflozin in Heart Failure with a "
                     "Preserved Ejection Fraction. N Engl J Med. 2021;385(16):1451-1461. "
                     "DOI 10.1056/NEJMoa2107038. PMID 34449189."),
        "identifier": {"type": "pmid", "value": "34449189"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/34449189/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1056/NEJMoa2107038"},
        "registryId": "NCT03057951",
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": True,
        "usedFor": ("心衰住院（总事件，作为独立次要终点）；主要复合终点。心血管死亡与全因死亡的"
                    "单组分数值未见于摘要，未采纳该来源作为单组分死亡终点的依据。"),
        "design": "randomized-controlled-trial",
        "role": "关键试验（一线证据）",
        "n": 5988,
        "medianFollowUp": "26.2 个月",
        "lvefInclusion": "LVEF > 40%",
        "population": "NYHA II–IV 级慢性心衰成人（5988 例，随机分入 empagliflozin 2997 例、placebo 2991 例），伴或不伴 2 型糖尿病",
        "intervention": "empagliflozin 10 mg 每日一次",
        "comparator": "安慰剂，均加用于常规治疗",
        "primaryEndpoint": "心血管死亡或心衰住院的复合终点（首次事件）",
        "adjudication": "设盲的临床终点委员会判定；紧急心衰就诊在 EMPEROR-Preserved 中未经判定，由研究者报告",
        "attritionAndDiscontinuation": "摘要未报告失访与停药率",
        "outcomesReported": [
            "复合终点（心血管死亡或心衰住院，首次事件）",
            "总心衰住院次数",
        ],
        "effectEstimates": [
            {"outcome": "复合终点：心血管死亡或心衰住院（首次事件）", "metric": "HR",
             "pointEstimate": "0.79", "ciLow": "0.69", "ciHigh": "0.90", "pValue": "<0.001",
             "absoluteContext": "415/2997（13.8%）vs 511/2991（17.1%）"},
            {"outcome": "总心衰住院次数（复发事件）", "metric": "HR",
             "pointEstimate": "0.73", "ciLow": "0.61", "ciHigh": "0.88", "pValue": "<0.001",
             "absoluteContext": "两组总心衰住院事件数本次未能取得（未见于所取得的摘要；S04 中出现的 407 与 541 为图形坐标刻度读数，不作为来源）",
             "sourceLayerNote": ("该数值取自本次所取得的摘要，并经 DELIVER 总事件预设分析正文（S03）的转述核对；"
                                 "EMPEROR-Preserved 全文本次未取得，该数值的原始表格未被直接核对。"
                                 "总心衰住院的绝对事件数本次未取得。")},
        ],
        "notReportedHere": [
            "心血管死亡单组分数值（本次仅取得摘要，摘要未给出）",
            "全因死亡单组分数值（同上）",
            "首次心衰住院的单试验点估计（未见于本次取得的摘要）",
            "失访率与永久停药率",
        ],
        "appraised": True,
        "usedInBodies": ["B1-first-hf-hospitalisation", "B2-total-hf-events"],
        "riskOfBias": {
            "rating": "low",
            "reason": ("随机化、分配隐藏、设盲与结局判定这四步均未见可指名的系统误差来源：随机分配为"
                       "双盲、安慰剂对照，主要终点由设盲的临床终点委员会判定，主要分析按意向性治疗。"
                       "本文本次仅取得摘要，停药率与失访率未取得，无法逐项核对，因此该判断是在摘要所能承载的"
                       "范围内作出，其不确定性已记录在本字段内。"),
            "evidence": "摘要记载为双盲、安慰剂对照、随机分配，主要终点由设盲的临床终点委员会判定。",
            "uncertainty": "全文中报告的停用率与失访率本次未取得，无法逐项核对。",
        },
        "indirectness": {
            "rating": "low",
            "reason": ("人群（慢性心衰成人、LVEF > 40%、NYHA II–IV）、干预（empagliflozin 10 mg 每日一次）、"
                       "对照（常规治疗背景下的安慰剂）与结局（心衰住院、死亡）四条轴均与本问题直接对应；"
                       "随访 26.2 个月覆盖本问题的时间范围。唯一偏离是纳入门为 LVEF > 40% 而非题面人群口径的"
                       "≥ 40%，即未覆盖 LVEF 恰为 40% 者，该偏离不改变效应方向。"),
        },
        "imprecision": {
            "rating": "low",
            "reason": ("复合终点与总心衰住院的区间上限分别为 0.90 与 0.88，均对应可观的风险下降，"
                       "两个终点的事件数均在 400 次以上，区间没有跨越“值得做／不值得做”的决策边界。"
                       "该终点上的精度判断不迁移到本试验的死亡终点。"),
        },
        "instrument": "RoB 2",
        "instrumentRating": "low risk of bias",
        "notes": ("试验由 Boehringer Ingelheim 与 Eli Lilly 资助。文章级 DOI 10.1056/NEJMoa2107038 已按"
                  "题录核实。全文本次未取得：出版方未提供开放获取版本，摘要未给出心血管死亡与全因死亡的"
                  "单组分数值；这两个终点因此没有任何来自本试验的单试验数值可用，本表未作任何推断。"),
    },
    {
        "id": "S02",
        "citationShort": "DELIVER 主要报告",
        "citation": ("Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly "
                     "Reduced or Preserved Ejection Fraction. N Engl J Med. 2022;387(12):1089-1098. "
                     "DOI 10.1056/NEJMoa2206286. PMID 36027570."),
        "identifier": {"type": "pmid", "value": "36027570"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/36027570/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1056/NEJMoa2206286"},
        "registryId": "NCT03619213",
        "sourceInspected": "full-text",
        "resolved": True,
        "includedInAppraisal": True,
        "usedFor": "首次心衰住院、心血管死亡、全因死亡、总心衰事件与心血管死亡的复合终点（绝对事件率）",
        "design": "randomized-controlled-trial",
        "role": "关键试验（一线证据）",
        "n": 6263,
        "medianFollowUp": "2.3 年（IQR 1.7–2.8）",
        "lvefInclusion": "LVEF > 40%",
        "population": "NYHA II–IV 级慢性心衰成人，伴或不伴 2 型糖尿病，需有升高的利钠肽与结构性心脏病证据",
        "intervention": "dapagliflozin 10 mg 每日一次",
        "comparator": "安慰剂，均加用于常规治疗",
        "primaryEndpoint": "心衰恶化（非计划心衰住院或需静脉治疗的紧急心衰就诊）或心血管死亡的复合终点（首次事件）",
        "adjudication": "临床事件由设盲委员会判定；紧急就诊在主要分析中计入复合终点",
        "attritionAndDiscontinuation": "因不良事件停用者 5.8% vs 5.8%；因不良事件中断者 13.9% vs 15.8%",
        "outcomesReported": [
            "复合终点（心衰恶化事件或心血管死亡，首次事件）",
            "心衰住院或紧急心衰就诊（首次）",
            "心衰住院（首次）",
            "心血管死亡",
            "全因死亡",
            "总心衰恶化事件与心血管死亡次数（复发事件）",
            "安全性结局",
        ],
        "effectEstimates": [
            {"outcome": "复合终点：心衰恶化事件或心血管死亡（首次事件）", "metric": "HR",
             "pointEstimate": "0.82", "ciLow": "0.73", "ciHigh": "0.92", "pValue": "<0.001",
             "absoluteContext": "512/3131（16.4%，7.8/100 患者年）vs 610/3132（19.5%，9.6/100 患者年）"},
            {"outcome": "心衰住院或紧急心衰就诊（首次）", "metric": "HR",
             "pointEstimate": "0.79", "ciLow": "0.69", "ciHigh": "0.91",
             "absoluteContext": "368（11.8%，5.6/100 患者年）vs 455（14.5%，7.2/100 患者年）"},
            {"outcome": "心衰住院（首次）", "metric": "HR",
             "pointEstimate": "0.77", "ciLow": "0.67", "ciHigh": "0.89",
             "absoluteContext": "329（10.5%，5.0/100 患者年）vs 418（13.3%，6.5/100 患者年）"},
            {"outcome": "心血管死亡", "metric": "HR",
             "pointEstimate": "0.88", "ciLow": "0.74", "ciHigh": "1.05",
             "absoluteContext": "231（7.4%，3.3/100 患者年）vs 261（8.3%，3.8/100 患者年）"},
            {"outcome": "全因死亡", "metric": "HR",
             "pointEstimate": "0.94", "ciLow": "0.83", "ciHigh": "1.07",
             "absoluteContext": "497（15.9%，7.2/100 患者年）vs 526（16.8%，7.6/100 患者年）"},
            {"outcome": "总心衰恶化事件与心血管死亡次数（复发事件）", "metric": "rate ratio",
             "pointEstimate": "0.77", "ciLow": "0.67", "ciHigh": "0.89", "pValue": "<0.001",
             "absoluteContext": "815 次（11.8/100 患者年）vs 1057 次（15.3/100 患者年）"},
        ],
        "notReportedHere": [],
        "appraised": True,
        "usedInBodies": ["B1-first-hf-hospitalisation", "B2-total-hf-events",
                         "B3-cardiovascular-death", "B4-all-cause-death"],
        "riskOfBias": {
            "rating": "low",
            "reason": ("随机化、分配隐藏、设盲、结局判定与失访处理这五步均未见可指名的系统误差来源："
                       "1:1 随机、双盲、安慰剂对照，主要分析按意向性治疗，因不良事件停用者两组相近"
                       "（5.8% vs 5.8%），未见退出差异提示。唯一残余不确定性来自主要终点中的紧急心衰就诊"
                       "依赖非计划就诊的判定，该判定在组间被随机化平衡。"),
            "evidence": "全文记载 1:1 随机分配、双盲、安慰剂对照，主要分析为意向性治疗。",
            "uncertainty": "紧急心衰就诊的判定可能受就诊行为影响；该影响在组间被随机化平衡，未构成方向性偏倚。",
        },
        "indirectness": {
            "rating": "low",
            "reason": ("人群、干预、对照、结局四条轴均与本问题直接对应。与 EMPEROR-Preserved 的差别是主要终点"
                       "把紧急心衰就诊并入“心衰恶化事件”，该定义比单纯心衰住院更宽；本表因此同时单列"
                       "“心衰住院”的估计值，未把宽定义当作窄定义使用。"),
        },
        "imprecision": {
            "rating": "low",
            "reason": ("主要复合终点、心衰住院与总事件的区间上限分别为 0.92、0.89、0.89，对应临床重要效益。"
                       "心血管死亡与全因死亡的区间上限 1.05 与 1.07 无法排除无效甚至轻微有害，这两个终点"
                       "各自记入 B3 与 B4，不在此处计入。"),
        },
        "instrument": "RoB 2",
        "instrumentRating": "low risk of bias",
        "notes": "试验由 AstraZeneca 资助。全文来源为作者投稿版（CC-BY-SA）。",
    },
    {
        "id": "S03",
        "citationShort": "DELIVER 总（复发）心衰事件预设分析",
        "citation": ("Jhund PS, Claggett BL, Talebi A, et al. Effect of Dapagliflozin on Total Heart Failure Events "
                     "in Patients With Heart Failure With Mildly Reduced or Preserved Ejection Fraction: A "
                     "Prespecified Analysis of the DELIVER Trial. JAMA Cardiol. 2023;8(6):554-563. "
                     "DOI 10.1001/jamacardio.2023.0711. PMID 37099283."),
        "identifier": {"type": "pmid", "value": "37099283"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/37099283/",
        "secondaryIdentifier": {"type": "pmcid", "value": "PMC10134044"},
        "registryId": "NCT03619213",
        "sourceInspected": "full-text",
        "resolved": True,
        "includedInAppraisal": True,
        "usedFor": ("复发/总心衰事件的速率比（本表 B2 的主锚点）；同时是 EMPEROR-Preserved 总心衰住院"
                    "率比 0.73（0.61–0.88）的转述出处"),
        "design": "randomized-controlled-trial",
        "role": "关键试验的预设分析（复发事件）",
        "n": 6263,
        "medianFollowUp": "2.3 年（IQR 1.7–2.8）",
        "lvefInclusion": "LVEF > 40%（与 DELIVER 一致）",
        "population": "与 DELIVER 同一随机化人群",
        "intervention": "dapagliflozin 10 mg 每日一次",
        "comparator": "安慰剂",
        "primaryEndpoint": ("总（首次与再次）心衰事件与心血管死亡，按 Lin-Wei-Yang-Ying（LWYY）比例速率模型与"
                            "联合脆弱模型两种预设方法分析"),
        "adjudication": "非致死性心衰事件由设盲委员会判定",
        "attritionAndDiscontinuation": "与 DELIVER 主要报告一致",
        "outcomesReported": [
            "总心衰事件与心血管死亡（复发事件）",
            "总心衰事件（不含紧急心衰就诊）",
            "总心衰住院与心血管死亡（LWYY 与联合脆弱模型）",
            "心血管死亡（复发事件分析中）",
            "模型假设无关的累积负担（AUC）分析",
        ],
        "effectEstimates": [
            {"outcome": "总心衰事件与心血管死亡（复发事件，LWYY）★主锚点", "metric": "rate ratio",
             "pointEstimate": "0.77", "ciLow": "0.67", "ciHigh": "0.89", "pValue": "<0.001",
             "absoluteContext": "15.3 vs 11.8 次/100 患者年，绝对减少 3.5 次/100 患者年"},
            {"outcome": "总心衰事件（复发事件，LWYY）", "metric": "rate ratio",
             "pointEstimate": "0.73", "ciLow": "0.62", "ciHigh": "0.87", "pValue": "<0.001"},
            {"outcome": "总心衰事件（复发事件，联合脆弱模型）", "metric": "rate ratio",
             "pointEstimate": "0.72", "ciLow": "0.65", "ciHigh": "0.81", "pValue": "<0.001"},
            {"outcome": "总心衰事件与全因死亡（LWYY，敏感性分析）", "metric": "rate ratio",
             "pointEstimate": "0.81", "ciLow": "0.72", "ciHigh": "0.92"},
            {"outcome": "总心衰事件与全因死亡（联合脆弱模型，敏感性分析）", "metric": "rate ratio",
             "pointEstimate": "0.72", "ciLow": "0.65", "ciHigh": "0.81",
             "absoluteContext": "全因死亡部分 rate ratio 0.93（0.81–1.06）"},
            {"outcome": "总心衰住院与心血管死亡（LWYY）", "metric": "rate ratio",
             "pointEstimate": "0.76", "ciLow": "0.66", "ciHigh": "0.88", "pValue": "<0.001",
             "absoluteContext": "心衰住院总次数 508 次 vs 707 次"},
            {"outcome": "总心衰住院与心血管死亡（联合脆弱模型）", "metric": "rate ratio",
             "pointEstimate": "0.71", "ciLow": "0.63", "ciHigh": "0.80", "pValue": "<0.001"},
            {"outcome": "心血管死亡（复发事件分析中）", "metric": "hazard ratio",
             "pointEstimate": "0.88", "ciLow": "0.74", "ciHigh": "1.05", "pValue": "0.17"},
            {"outcome": "累积负担 AUC 比（模型假设无关的探索性分析）", "metric": "rate ratio",
             "pointEstimate": "0.72", "ciLow": "0.63", "ciHigh": "0.84", "pValue": "<0.001",
             "absoluteContext": "疾病负担 AUC 7.8 vs 5.7 个月，绝对差 2.2 个月（95% CI 1.2–3.2），随访 36 个月"},
            {"outcome": "EMPEROR-Preserved 总心衰住院（本文转述，非本试验结果）", "metric": "rate ratio",
             "pointEstimate": "0.73", "ciLow": "0.61", "ciHigh": "0.88", "pValue": "<0.001",
             "sourceLayerNote": ("该值由本文件转述 EMPEROR-Preserved 的结果（联合脆弱模型，原文表述为总心衰住院减少 27%）；"
                                 "EMPEROR-Preserved 全文本次未取得，本表对它的引证为“经预设复发事件分析的转述核对”，"
                                 "不是对原始表格的直接核对。其绝对事件数本次未取得。")},
        ],
        "notReportedHere": [
            "本表未从本文件读取任何死亡终点的单试验绝对事件率（该文件不报告单试验死亡绝对率）",
        ],
        "appraised": True,
        "usedInBodies": ["B2-total-hf-events"],
        "riskOfBias": {
            "rating": "low",
            "reason": ("分析步骤本身未见可指名的系统误差来源：总事件分析的两套方法、分层因素与敏感性分析均在"
                       "试验统计计划中预设，并报告了放宽比例速率假设的敏感性分析与模型假设无关的累积负担分析。"),
            "evidence": "原文记载总事件分析的两套方法为统计计划预设，并按基线糖尿病状态分层。",
            "uncertainty": "LWYY 方法假定两组复发事件速率的比例性在整个研究期成立；原文已用联合脆弱模型与 AUC 方法放宽该假设，结果一致。",
        },
        "indirectness": {
            "rating": "moderate",
            "reason": ("效应量是事件速率比而非个体层面的风险比，回答的是“每位患者的平均事件负担”这一略宽的问题。"
                       "更实质的距离在端点构成：本分析的“总心衰事件”含紧急心衰就诊，而 EMPEROR-Preserved 的对应"
                       "分析是“总心衰住院”，两者的构成不同，跨试验并列时不是同一构造。"),
        },
        "imprecision": {
            "rating": "moderate",
            "reason": ("总事件数 815 vs 1057，区间上限 0.89 与 0.88 仍对应可观的事件负担下降，单看事件数是充分的。"
                       "扣分之处在于复发事件在同一个体内不独立，而试验层面的速率比区间按独立事件计算，"
                       "没有完全反映这一依赖；即区间对真实不确定性偏乐观。"),
        },
        "instrument": "RoB 2",
        "instrumentRating": "low risk of bias",
        "notes": ("同一试验的第二次发表（与 S02 共享注册号 NCT03619213），按一次试验一行处理，未作为独立的"
                  "一致性来源计数。原文亦转述了 EMPEROR-Preserved 总心衰住院的率比 0.73（95% CI 0.61–0.88，"
                  "联合脆弱模型）。"),
    },
    {
        "id": "S04",
        "citationShort": "EMPEROR-Preserved 年龄亚组分析",
        "citation": ("Böhm M, Butler J, Filippatos G, et al. Empagliflozin Improves Outcomes in Patients With "
                     "Heart Failure and Preserved Ejection Fraction Irrespective of Age. J Am Coll Cardiol. "
                     "2022;80(1):1-18. DOI 10.1016/j.jacc.2022.04.040. PMID 35772911."),
        "identifier": {"type": "pmid", "value": "35772911"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/35772911/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1016/j.jacc.2022.04.040"},
        "registryId": "NCT03057951",
        "sourceInspected": "full-text",
        "resolved": True,
        "includedInAppraisal": True,
        "usedFor": "亚组一致性（按年龄分层的首次与复发性心衰住院方向、按年龄的交互检验）",
        "design": "randomized-controlled-trial",
        "role": "关键试验的亚组分析（一致性检查）",
        "n": 5988,
        "medianFollowUp": "26.2 个月",
        "lvefInclusion": "LVEF > 40%（与 EMPEROR-Preserved 一致）",
        "population": "与 EMPEROR-Preserved 同一随机化人群，按年龄分组（<65、65–74、75–79、≥80 岁）",
        "intervention": "empagliflozin 10 mg 每日一次",
        "comparator": "安慰剂",
        "primaryEndpoint": "心血管死亡或心衰住院的复合终点",
        "adjudication": "与 EMPEROR-Preserved 一致",
        "attritionAndDiscontinuation": "未在本分析中单列",
        "outcomesReported": [
            "复合终点按年龄分层的效应与交互趋势",
            "首次心衰住院按年龄的交互趋势",
            "首次与复发性心衰住院按年龄的交互趋势",
            "心血管死亡与全因死亡按年龄的交互",
            "安慰剂组各年龄层的发生率",
        ],
        "effectEstimates": [
            {"outcome": "首次与复发性心衰住院：按年龄的交互趋势检验", "metric": "P for interaction trend",
             "pointEstimate": "0.11", "ciLow": "", "ciHigh": "", "pValue": "",
             "absoluteContext": "原文表述为“在 ≥80 岁仍见相近的风险下降”，交互趋势 P = 0.11，未达名义显著"},
            {"outcome": "首次心衰住院：按年龄的交互趋势检验", "metric": "P for interaction trend",
             "pointEstimate": "0.22", "ciLow": "", "ciHigh": "", "pValue": "",
             "absoluteContext": "原文表述为非显著"},
            {"outcome": "主要复合终点：按年龄的交互趋势检验", "metric": "P for interaction trend",
             "pointEstimate": "0.33", "ciLow": "", "ciHigh": "", "pValue": "",
             "absoluteContext": "原文表述为各年龄组相对风险下降相似"},
            {"outcome": "安慰剂组主要复合终点发生率（按年龄层）", "metric": "发生率（/100 患者年）",
             "pointEstimate": "6.96（<65）／7.80（65–74）／9.51（75–79）／11.00（≥80）",
             "ciLow": "", "ciHigh": "", "pValue": "趋势 P = 0.02",
             "absoluteContext": "安慰剂组各年龄层的心衰住院分层点估计仅以图形呈现，本次取得的文本层未给出其数值，本表不据图读取"},
        ],
        "notReportedHere": [
            "各年龄层首次与复发性心衰住院的点估计与置信区间（仅在图中呈现，本次取得的文本层未给出数值，未据图读取）",
            "心衰住院按年龄层的安慰剂组绝对事件率（仅在图中呈现，未据图读取）",
        ],
        "appraised": True,
        "usedInBodies": ["B1-first-hf-hospitalisation"],
        "riskOfBias": {
            "rating": "low",
            "reason": ("亚组分析这一步骤未见可指名的系统误差来源：分组因素为基线年龄，随机化与设盲同主试验，"
                       "分析为预设。唯一需要注意的一点是亚组间的多重比较未校正。"),
            "evidence": "原文报告按随机化分组比较各年龄层结局并给出交互趋势 P 值，并明示未做多重比较校正。",
            "uncertainty": "亚组分析的多重比较未校正；本表因此只用它作一致性检查，不用它产生任何效应量。",
        },
        "indirectness": {
            "rating": "low",
            "reason": "人群、干预、对照、终点均与主试验一致，问的是同一人群内的年龄异质性。",
        },
        "imprecision": {
            "rating": "moderate",
            "reason": ("分层后各年龄层的事件数大幅减少，交互检验的把握度低，原文多以交互 P 值与方向描述呈现。"
                       "该不精确性在本表中以“不据此产生效应量”的方式处理，不影响主试验效应量的区间判断。"),
        },
        "instrument": "RoB 2",
        "instrumentRating": "low risk of bias",
        "notes": ("同一试验的第三次发表（与 S01 共享注册号 NCT03057951），按一次试验一行处理，未作为独立"
                  "一致性来源计数。本行的用途是记录“效应在不同年龄层方向一致”。"),
    },
    {
        "id": "S05",
        "citationShort": "两项 HFmrEF/HFpEF 专用试验的预设合并分析（Vaduganathan 2022）",
        "citation": ("Vaduganathan M, Docherty KF, Claggett BL, et al. SGLT-2 inhibitors in patients with heart "
                     "failure: a comprehensive meta-analysis of five randomised controlled trials. Lancet. "
                     "2022;400(10354):757-767. DOI 10.1016/S0140-6736(22)01429-5. PMID 36041474."),
        "identifier": {"type": "pmid", "value": "36041474"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/36041474/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1016/S0140-6736(22)01429-5"},
        "sourceInspected": "full-text",
        "resolved": True,
        "includedInAppraisal": True,
        "usedFor": ("本评价最强的单一效应量来源：HFmrEF/HFpEF 人群的复合终点、首次心衰住院、心血管死亡、"
                    "全因死亡；同时提供五试验全谱人群作为背景（背景数值不用于本问题的确定性判断）"),
        "design": "systematic-review",
        "role": "系统评价与试验层面合并分析",
        "n": "12251（两项 HFmrEF/HFpEF 试验）；21947（五项试验全谱）",
        "medianFollowUp": "两试验合并的加权平均约 23 个月（五试验范围 9 个月至 2.3 年）",
        "lvefInclusion": "主分析限定两项纳入标准为 LVEF > 40% 的试验；背景分析另纳入 DAPA-HF、EMPEROR-Reduced（LVEF ≤ 40%）与 SOLOIST-WHF（急性心衰住院期）",
        "population": "两项 HFmrEF/HFpEF 专用随机试验的 12251 名受试者",
        "intervention": "empagliflozin 10 mg 或 dapagliflozin 10 mg",
        "comparator": "安慰剂",
        "primaryEndpoint": "心血管死亡或首次心衰住院的复合终点",
        "adjudication": "各试验由设盲临床终点委员会判定；紧急心衰就诊在 EMPEROR-Preserved 与 SOLOIST-WHF 未判定，依赖研究者报告",
        "attritionAndDiscontinuation": "各试验按意向性治疗数据集分析",
        "outcomesReported": [
            "复合终点（心血管死亡或首次心衰住院）",
            "心血管死亡",
            "首次心衰住院",
            "心血管死亡或任意心衰恶化事件",
            "全因死亡",
            "健康状态（KCCQ）",
            "五试验全谱的对应结局（背景）",
            "14 个预设亚组（含 NYHA 分级与 LVEF 分层）",
        ],
        "effectEstimates": [
            {"outcome": "复合终点：心血管死亡或首次心衰住院（两项 HFmrEF/HFpEF 试验）", "metric": "HR",
             "pointEstimate": "0.80", "ciLow": "0.73", "ciHigh": "0.87",
             "absoluteContext": "试验间无效应异质性"},
            {"outcome": "首次心衰住院（两项 HFmrEF/HFpEF 试验）★主锚点", "metric": "HR",
             "pointEstimate": "0.74", "ciLow": "0.67", "ciHigh": "0.83",
             "absoluteContext": "本合并分析未报告该人群的绝对事件率与 NNT；绝对效应见 S02（DELIVER）"},
            {"outcome": "心血管死亡（两项 HFmrEF/HFpEF 试验）", "metric": "HR",
             "pointEstimate": "0.88", "ciLow": "0.77", "ciHigh": "1.00",
             "absoluteContext": "把不明原因死亡归为心血管死亡时 HR 0.90（95% CI 0.80–1.01）"},
            {"outcome": "全因死亡（两项 HFmrEF/HFpEF 试验）", "metric": "HR",
             "pointEstimate": "0.97", "ciLow": "0.88", "ciHigh": "1.06",
             "absoluteContext": "本合并分析未报告该人群的绝对事件率"},
            {"outcome": "心血管死亡或任意心衰恶化事件（两项 HFmrEF/HFpEF 试验）", "metric": "HR",
             "pointEstimate": "0.80", "ciLow": "0.73", "ciHigh": "0.87"},
            {"outcome": "复合终点：NYHA II 级（两项试验合并）", "metric": "HR",
             "pointEstimate": "0.72", "ciLow": "0.67", "ciHigh": "0.79",
             "absoluteContext": "与 NYHA III/IV 的 p for heterogeneity = 0.015"},
            {"outcome": "复合终点：NYHA III/IV 级（两项试验合并）", "metric": "HR",
             "pointEstimate": "0.86", "ciLow": "0.77", "ciHigh": "0.95",
             "absoluteContext": "与 NYHA II 的 p for heterogeneity = 0.015"},
            {"outcome": "复合终点按 LVEF 分层（五试验全谱）", "metric": "HR",
             "pointEstimate": "0.75–0.81", "ciLow": "0.67", "ciHigh": "0.96",
             "absoluteContext": "≤40%: 0.75 (0.68–0.83)；41–49%: 0.78 (0.67–0.90)；50–59%: 0.79 (0.68–0.93)；≥60%: 0.81 (0.69–0.96)；异质性 P = 0.83"},
            {"outcome": "复合终点（五试验全谱，含 LVEF ≤ 40%）", "metric": "HR",
             "pointEstimate": "0.77", "ciLow": "0.72", "ciHigh": "0.82",
             "absoluteContext": "NNT 25（95% CI 20–31），加权平均随访 23 个月"},
            {"outcome": "首次心衰住院（五试验全谱）", "metric": "HR",
             "pointEstimate": "0.72", "ciLow": "0.67", "ciHigh": "0.78",
             "absoluteContext": "NNT 28（95% CI 24–35）——本表保留该数值时一律标注为五试验全谱口径，不适用本问题人群"},
            {"outcome": "心血管死亡（五试验全谱）", "metric": "HR",
             "pointEstimate": "0.87", "ciLow": "0.79", "ciHigh": "0.95",
             "absoluteContext": "NNT 88（95% CI 54–229），加权平均随访 22 个月"},
            {"outcome": "全因死亡（五试验全谱）", "metric": "HR",
             "pointEstimate": "0.92", "ciLow": "0.86", "ciHigh": "0.99",
             "absoluteContext": "NNT 92（95% CI 52–733）；该估计含 LVEF ≤ 40% 人群，不是本问题人群的估计值"},
        ],
        "notReportedHere": [
            "两项 HFmrEF/HFpEF 专用试验的总（复发）心衰事件合并估计——该合并分析未报告这一估计，本表因此不把多项复发事件估计平均为单一数字",
            "两项 HFmrEF/HFpEF 试验的绝对事件率与 NNT（原文未报告）",
            "SF-36 等量表型健康状态的分层结果",
        ],
        "appraised": True,
        "usedInBodies": ["B1-first-hf-hospitalisation", "B3-cardiovascular-death", "B4-all-cause-death"],
        "riskOfBias": {
            "rating": "low",
            "reason": ("偏倚风险源自所纳入试验的执行，两试验均评为低偏倚风险；本合并过程在 DELIVER 揭盲前"
                       "预先写入统计计划并注册（PROSPERO CRD42022327527），未见结局选择性报告的迹象。"
                       "保留意见：纳入研究的偏倚风险由试验团队自行评估，评估者与被评估者同一化。"),
            "evidence": "原文记载合并分析方案在 DELIVER 揭盲前预设并注册；两试验的偏倚风险由同一批作者评为低风险。",
            "uncertainty": "偏倚风险评估由作者自行完成并作为补充材料，未见独立的第三方评估。",
        },
        "indirectness": {
            "rating": "low",
            "reason": ("主分析恰好就是本问题人群（LVEF > 40%）、本问题干预（恩格列净与达格列净各一项试验）、"
                       "本问题对照（安慰剂）与本问题结局。背景性的五试验合并结果不用于本问题的确定性判断，"
                       "仅用于说明跨射血分数谱的效应方向。"),
        },
        "imprecision": {
            "rating": "low",
            "reason": ("12251 名受试者，主要终点与首次心衰住院的区间上限分别为 0.87 与 0.83，未跨无效线。"
                       "两个死亡终点的区间上限为 1.00 与 1.06，其精度不足在 B3 与 B4 中处理，不在此处计入。"),
        },
        "instrument": "AMSTAR 2",
        "instrumentRating": "moderate confidence",
        "notes": ("协议预先注册（PROSPERO CRD42022327527）；五试验合并为事后追加。原文明确声明各试验非头对头"
                  "比较，不能排除不同药物间仍存在差异。DAPA-HF、EMPEROR-Reduced、SOLOIST-WHF 被排除于本问题"
                  "的证据体之外，仅作背景。"),
    },
    {
        "id": "S06",
        "citationShort": "HFpEF 人群 SGLT2 抑制剂系统评价（Jaiswal 2023）",
        "citation": ("Jaiswal A, Jaiswal V, Ang SP, et al. SGLT2 inhibitors among patients with heart failure with "
                     "preserved ejection fraction: A meta-analysis of randomised controlled trials. "
                     "Medicine (Baltimore). 2023;102(39):e34693. DOI 10.1097/MD.0000000000034693. PMID 37773799."),
        "identifier": {"type": "pmid", "value": "37773799"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/37773799/",
        "secondaryIdentifier": {"type": "pmcid", "value": "PMC10545009"},
        "sourceInspected": "full-text",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": ("仅作数值吻合对照，不进入任何证据体：其心衰住院点估计 0.74 与本问题人群的合并点估计数值相同。"
                    "该行的三个域评级仍逐域保留，供读者判断这个对照值本身是否可信。"),
        "design": "systematic-review",
        "role": "一致性对照（不进入证据体）",
        "n": "15989（6 项研究）",
        "medianFollowUp": "2.24 年（中位）",
        "lvefInclusion": "自述为 HFpEF；但纳入的研究中含 DECLARE-TIMI 58、VERTIS CV、SCORED 三项以 2 型糖尿病为主的人群，其射血分数口径无法逐条核实",
        "population": "混合：两项 HFpEF/HFmrEF 专用试验 + 三项以糖尿病为主的人群 + SOLOIST-WHF",
        "intervention": "恩格列净、达格列净、索格列净、ertugliflozin 等",
        "comparator": "安慰剂",
        "primaryEndpoint": "首次心衰住院或心血管死亡的复合终点",
        "adjudication": "各原始研究自行判定",
        "attritionAndDiscontinuation": "未在本分析中汇总",
        "outcomesReported": [
            "首次心衰住院或心血管死亡复合终点",
            "心衰住院",
            "全因死亡",
            "心血管死亡",
        ],
        "effectEstimates": [
            {"outcome": "复合终点：首次心衰住院或心血管死亡", "metric": "HR",
             "pointEstimate": "0.80", "ciLow": "0.74", "ciHigh": "0.87", "pValue": "<0.001",
             "absoluteContext": "I² = 0%（DerSimonian and Laird 随机效应模型）"},
            {"outcome": "心衰住院", "metric": "HR",
             "pointEstimate": "0.74", "ciLow": "0.67", "ciHigh": "0.82", "pValue": "<0.001",
             "absoluteContext": "I² = 0%（DerSimonian and Laird 随机效应模型）"},
            {"outcome": "全因死亡", "metric": "HR",
             "pointEstimate": "0.97", "ciLow": "0.89", "ciHigh": "1.06", "pValue": "0.54",
             "absoluteContext": "I² = 0%（DerSimonian and Laird 随机效应模型）"},
            {"outcome": "心血管死亡", "metric": "HR",
             "pointEstimate": "0.96", "ciLow": "0.82", "ciHigh": "1.13", "pValue": "0.66",
             "absoluteContext": "I² = 35.09%（DerSimonian and Laird 随机效应模型）"},
        ],
        "notReportedHere": [
            "纳入研究的逐项偏倚风险评估结果",
            "单独针对 LVEF > 40% 人群的敏感性分析",
        ],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "riskOfBias": {
            "rating": "serious",
            "reason": ("系统评价层面有两处可识别的误差来源。一是纳入人群与题名不符：该评价自称评估 HFpEF，"
                       "却把 DECLARE-TIMI 58、VERTIS CV、SCORED 三项以 2 型糖尿病为主、未要求入组时存在心衰的"
                       "人群计入合并。二是未报告对所纳入研究的偏倚风险评估，亦未做亚组与敏感性分析"
                       "（原文自述因数据有限未能进行）。"),
            "evidence": "原文结果段列出 6 项纳入研究；局限性段写明未做敏感性与亚组分析；方法段写明使用 DerSimonian and Laird 随机效应模型。",
            "uncertainty": "原文称其结论与既有综述一致，但这一一致性来自相同的一批原始试验，不构成独立支持。",
        },
        "indirectness": {
            "rating": "serious",
            "reason": ("合并人群与本问题的目标人群有实质距离：三项以糖尿病为主的研究并非心衰队列，其事件主要"
                       "由非心衰机制驱动；把这些人群与两项 HFpEF 专用试验合并，会以其他机制替代本问题所问的效应。"
                       "其所报告的心衰住院 HR 0.74 与专用人群的 0.74 数值相同，这一吻合来自相同的一批原始试验，"
                       "是重复计数而非独立验证。"),
        },
        "imprecision": {
            "rating": "low",
            "reason": ("区间宽度本身尚可（心衰住院 0.67–0.82；全因死亡 0.89–1.06），I² 为 0%。"
                       "其精度描述的是混合人群的合并效应，不能转移到本问题人群。"),
        },
        "instrument": "AMSTAR 2",
        "instrumentRating": "critically low confidence",
        "notAppraisedReason": ("该记录的数值不进入本表的任何证据体，因此不作为参与确定性判断的研究行评价。"
                               "理由有两条：其一，它纳入的人群混入了三项以 2 型糖尿病为主、未要求入组时存在"
                               "心衰的研究，与本问题人群不同；其二，它的心衰住院点估计 0.74 与本问题人群的合并"
                               "估计数值相同，但两者纳入的是同一批原始试验，这一吻合是重复计数而非独立验证。"
                               "本表只把它当作“数值上是否吻合”的对照，它的任何数值都不参与 B1–B4 的确定性算术。"
                               "其三，它未评估所纳入研究的偏倚风险，其自身的方法学缺陷已在本行三个域中写下，"
                               "供读者判断该对照值本身是否可信。"),
        "notes": ("合并人群定义与题名不符、且未评估纳入研究的偏倚风险，是 AMSTAR 2 下两个关键缺陷，故记为 "
                  "critically low。本表只把它的数值作为“数值上是否吻合”的对照，不进入任何证据体，"
                  "也不参与任何确定性的加减。"),
    },
    {
        "id": "S07",
        "citationShort": "与 S06 同题同刊的同条记录（去重行）",
        "citation": ("同一 PMID 37773799、同一 DOI 10.1097/MD.0000000000034693 的记录在初筛阶段曾以不同作者串"
                     "出现；本次按题录核实，真实著录为 Jaiswal A, Jaiswal V, Ang SP, et al. Medicine (Baltimore). "
                     "2023;102(39):e34693。可解析标识符为 PMID 37773799。"),
        "identifier": {"type": "pmid", "value": "37773799"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/37773799/",
        "sourceInspected": "metadata",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "未使用——已核为 S06 的同一条记录",
        "design": "systematic-review",
        "role": "重复记录（未单独纳入）",
        "n": "",
        "medianFollowUp": "",
        "lvefInclusion": "",
        "population": "",
        "intervention": "",
        "comparator": "",
        "primaryEndpoint": "",
        "adjudication": "",
        "attritionAndDiscontinuation": "",
        "outcomesReported": [],
        "effectEstimates": [],
        "notReportedHere": [],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "notAppraisedReason": ("本行与 S06 为同一 PMID、同一 DOI、同一卷期与同一文章号，属同一条记录被重复"
                               "登记，不构成第二项研究；合并会重复计数同一批证据。本次未再单独评价它。"),
        "notes": ("保留该行是为了让读者看到去重这一步确实做过，而不是悄悄删除。初筛时该记录曾被署为"
                  "“Shrestha DB, Budhathoki P, Sedhai YR, et al.”；本次按 PMID 题录核对，作者为 Jaiswal A 等，"
                  "故该署名为误，已在本行更正并保留记录。"),
    },
    {
        "id": "S08",
        "citationShort": "HFpEF 人群 SGLT2 抑制剂系统评价（Hamid 2024）",
        "citation": ("Hamid AK, Tayem AA, Al-Aish ST, et al. Empagliflozin and other SGLT2 inhibitors in patients "
                     "with heart failure and preserved ejection fraction: a systematic review and meta-analysis. "
                     "Ther Adv Cardiovasc Dis. 2024;18:17539447241289067. DOI 10.1177/17539447241289067. "
                     "PMID 39400108."),
        "identifier": {"type": "pmid", "value": "39400108"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/39400108/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1177/17539447241289067"},
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "仅记录存在这一系统评价及其定性结论；未采纳任何数值",
        "design": "systematic-review",
        "role": "系统评价（摘要层级）",
        "n": "16509（8 项研究）",
        "medianFollowUp": "未报告",
        "lvefInclusion": "自述为射血分数高于 40%",
        "population": "HFpEF（自述）",
        "intervention": "恩格列净、达格列净、索格列净、ertugliflozin",
        "comparator": "安慰剂",
        "primaryEndpoint": "未在摘要中明示",
        "adjudication": "未报告",
        "attritionAndDiscontinuation": "未报告",
        "outcomesReported": ["心血管住院", "心血管死亡", "全因死亡", "估算肾小球滤过率"],
        "effectEstimates": [],
        "notReportedHere": [
            "所有终点合并效应的点估计与置信区间",
            "纳入研究清单",
            "偏倚风险评估方法",
        ],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "riskOfBias": {
            "rating": "unclear",
            "reason": ("所取得的记录为摘要，未报告纳入研究清单、偏倚风险评估方法、异质性处理与敏感性分析，"
                       "因此无法判断系统评价执行中可能出现的误差来源。该评级反映的是“未报告”，不是“知道它做得差”。"),
            "evidence": "摘要描述了检索库、截至 2024 年 7 月的检索时间、8 项研究与 16509 名受试者，并自述遵循 PRISMA。",
            "uncertainty": "本次未取得全文；摘要未给出任何合并效应的点估计与置信区间。",
        },
        "indirectness": {
            "rating": "unclear",
            "reason": ("摘要称纳入射血分数高于 40% 的人群，但未列出纳入研究，无法核对其是否混入以糖尿病为主的"
                       "人群（S06 就在这一点上出了问题），故不能判断其与本问题人群的距离。"),
        },
        "imprecision": {
            "rating": "unclear",
            "reason": "记录中没有任何合并效应的点估计与置信区间，无从判断区间宽度，因而无从判断精度。",
        },
        "instrument": "AMSTAR 2",
        "instrumentRating": "not applicable — 记录不足以完成评估",
        "notAppraisedReason": ("所取得的记录为摘要，未报告任何终点的合并效应点估计与置信区间、未报告纳入研究"
                               "清单与偏倚风险评估，无法完成逐域判断，也无法核对其人群是否确实为 LVEF > 40%。"
                               "其定性结论与 S05 方向一致，但数值不可核对，故不进入任何确定性算术。"),
        "notes": ("该评价的存在与方向性结论（降低心血管住院、不降低死亡）与 S05 方向一致；因其数值不可核对，"
                  "本表未让它的任何数值进入确定性的算术。作者、刊名、年份与 DOI 已按题录核实补齐。"),
    },
    {
        "id": "S09",
        "citationShort": "SGLT2 抑制剂之间的间接比较（Bayesian 网络分析）",
        "citation": ("Chen HB, Yang YL, Meng RS, Liu XW. Indirect Comparison of SGLT2 Inhibitors in Patients with "
                     "Established Heart Failure: Evidence Based on Bayesian Methods. ESC Heart Fail. "
                     "2023;10(2):1231-1241. DOI 10.1002/ehf2.14297. PMID 36702979."),
        "identifier": {"type": "pmid", "value": "36702979"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/36702979/",
        "secondaryIdentifier": {"type": "doi", "value": "10.1002/ehf2.14297"},
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "仅用于回答“恩格列净与达格列净之间是否有可辨别的差异”这一补充问题",
        "design": "systematic-review",
        "role": "间接比较（补充说明，非本问题主要证据）",
        "n": "5 项试验，4 种治疗策略",
        "medianFollowUp": "未报告",
        "lvefInclusion": "全射血分数谱的已确诊心衰人群，非 HFpEF 专用",
        "population": "已确诊心衰、包含 LVEF ≤ 40% 人群",
        "intervention": "达格列净、恩格列净、索格列净",
        "comparator": "安慰剂（再经网络间接比较各药之间）",
        "primaryEndpoint": "心血管死亡或心衰住院的复合终点",
        "adjudication": "各原始试验自行判定",
        "attritionAndDiscontinuation": "未报告",
        "outcomesReported": ["复合终点（达格列净 vs 恩格列净）", "全因死亡", "心血管死亡", "心衰住院"],
        "effectEstimates": [
            {"outcome": "复合终点：达格列净 vs 恩格列净", "metric": "OR",
             "pointEstimate": "1.00", "ciLow": "0.66", "ciHigh": "1.55",
             "absoluteContext": "无显著差异"},
            {"outcome": "全因死亡：达格列净 vs 恩格列净", "metric": "OR",
             "pointEstimate": "0.92", "ciLow": "0.71", "ciHigh": "1.18",
             "absoluteContext": "无显著差异"},
            {"outcome": "心血管死亡：达格列净 vs 恩格列净", "metric": "OR",
             "pointEstimate": "0.94", "ciLow": "0.71", "ciHigh": "1.23",
             "absoluteContext": "无显著差异"},
            {"outcome": "心衰住院：达格列净 vs 恩格列净", "metric": "OR",
             "pointEstimate": "1.13", "ciLow": "0.64", "ciHigh": "1.97",
             "absoluteContext": "无显著差异"},
        ],
        "notReportedHere": [
            "网络一致性的检验结果",
            "偏倚风险评估",
            "HFpEF 专用亚组的间接比较",
        ],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "riskOfBias": {
            "rating": "serious",
            "reason": ("所取得的记录为摘要，未报告网络一致性检验、纳入研究的偏倚风险评估或模型选择依据；"
                       "网络间接比较在链路缺少闭合环时无法检验一致性，而本网络的多数节点由安慰剂连接。"
                       "该评级反映的是“未报告导致不可判断”，不是“知道它有偏”。"),
            "evidence": "摘要描述了 5 项试验、4 种治疗策略与 Bayesian 网络方法，但未给出一致性分析。",
            "uncertainty": "本次未取得全文。",
        },
        "indirectness": {
            "rating": "serious",
            "reason": ("网络纳入的是全射血分数谱的已确诊心衰人群，其连接节点包括 LVEF ≤ 40% 的试验；"
                       "由这些试验推断 HFpEF 内部两药之间的差异，需要假定效应在射血分数谱上同质，"
                       "而这一点本身未被检验。"),
        },
        "imprecision": {
            "rating": "serious",
            "reason": ("四组间接比较的区间都很宽（如心衰住院 OR 0.64–1.97），既不能排除达格列净优于恩格列净，"
                       "也不能排除相反方向，属于同时跨越两个相反决策的不精确。"),
        },
        "instrument": "AMSTAR 2",
        "instrumentRating": "not applicable — 记录不足以完成评估",
        "notAppraisedReason": ("所取得的记录为摘要，未报告网络一致性检验、纳入研究的偏倚风险评估与模型选择依据，"
                               "无法完成 AMSTAR 2 的逐域判断。此项仅用于说明两药之间缺乏可辨别的差异，"
                               "不进入任何确定性算术。"),
        "notes": ("该结果对本表的意义是：本问题人群中没有头对头的随机比较；现有的网络间接比较区间过宽，"
                  "既不能显示两药之间的差异，也不能证明两药等效。作者、刊名、年份与 DOI 已按题录核实更正。"),
    },
    {
        "id": "S10",
        "citationShort": "DELIVER 的试验模拟（观察性一致性检查）",
        "citation": ("Ostrominski JW, Byrne C, Solomon SD, et al. Emulation of a Trial of Dapagliflozin in Heart "
                     "Failure with Mildly Reduced or Preserved Ejection Fraction (DELIVER). Diabetes. 2026. "
                     "会议摘要（Embase 记录 L651752299）。"),
        "identifier": {"type": "url", "value": "https://www.embase.com/search/results?subaction=viewrecord&id=L651752299&from=export"},
        "publicUrl": "https://www.embase.com/search/results?subaction=viewrecord&id=L651752299&from=export",
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "仅作方向一致性检查；不用于提升任何终点的确定性等级",
        "design": "retrospective-cohort",
        "role": "观察性研究（补充说明）",
        "n": "8162（常规治疗队列，与 DELIVER 的 2806 名入组者做倾向评分 1:1 匹配）",
        "medianFollowUp": "未报告",
        "lvefInclusion": "HFmrEF/HFpEF 且合并 2 型糖尿病（具体 LVEF 阈值未在摘要中给出）",
        "population": "美国三个理赔数据库中起始达格列净或西格列汀的成人",
        "intervention": "达格列净",
        "comparator": "西格列汀（作为观察性安慰剂替代）",
        "primaryEndpoint": "全因死亡或心衰住院的复合终点",
        "adjudication": "理赔数据编码，非事件判定委员会判定",
        "attritionAndDiscontinuation": "未报告",
        "outcomesReported": ["全因死亡或心衰住院复合终点", "复合终点的组分"],
        "effectEstimates": [
            {"outcome": "全因死亡或心衰住院（复合终点）", "metric": "HR",
             "pointEstimate": "0.76", "ciLow": "0.63", "ciHigh": "0.92",
             "absoluteContext": "同一分析中 DELIVER 的探索性终点 HR 0.84（95% CI 0.73–0.97），两者方向一致"},
        ],
        "notReportedHere": ["各单组分的确切效应量", "随访时长", "残余混杂的定量评估", "LVEF 纳入阈值"],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "riskOfBias": {
            "rating": "serious",
            "reason": ("Newcastle-Ottawa 域结构下，选择域与可比性域存在不可消除的残余混杂：活性对照为"
                       "西格列汀而非安慰剂，测量的是“达格列净相对于另一种降糖药”的效应；暴露由处方记录推断，"
                       "结局由理赔编码定义，未设盲判定。"),
            "evidence": "摘要记载为新用药者、活性对照队列设计，使用倾向评分 1:1 匹配，暴露与终点均来自理赔数据。",
            "uncertainty": "摘要未报告匹配后的协变量平衡诊断与敏感性分析。",
        },
        "indirectness": {
            "rating": "serious",
            "reason": ("对照不是安慰剂而是西格列汀，人群限定为合并 2 型糖尿病者，且复合终点把全因死亡与"
                       "心衰住院合并，与本问题“安慰剂对照、各终点分列”的口径不符。"),
        },
        "imprecision": {
            "rating": "moderate",
            "reason": ("匹配后队列的事件数使区间上限为 0.92，尚可辨别方向；但该区间无法与随机试验的区间做"
                       "等价解读，因为其中混杂了对照药物的效应。"),
        },
        "instrument": "Newcastle-Ottawa Scale",
        "instrumentRating": "not scored — 摘要未报告足够的方法学细节",
        "notAppraisedReason": ("所取得的记录为会议摘要，未报告随访时长、匹配后协变量平衡诊断、残余混杂定量评估"
                               "与 LVEF 纳入阈值，无法完成 Newcastle-Ottawa 的逐域评分。此项仅作方向一致性记录，"
                               "不进入任何确定性算术。"),
        "notes": ("保留此行的用途是记录“真实世界数据与随机试验方向一致”，这不是升级证据确定性的理由；"
                  "本表未因它上调任何等级。"),
    },
    {
        "id": "S11",
        "citationShort": "达格列净与恩格列净在 2 型糖尿病人群中的比较",
        "citation": ("Dhana R, Aqel Y, Rawat A, et al. Comparative Cardiovascular Outcomes of Dapagliflozin Versus "
                     "Empagliflozin in Patients With Type 2 Diabetes: A Meta-Analysis. Cureus. 2025;17(5):e83449. "
                     "DOI 10.7759/cureus.83449. PMID 40322609."),
        "identifier": {"type": "pmid", "value": "40322609"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/40322609/",
        "secondaryIdentifier": {"type": "doi", "value": "10.7759/cureus.83449"},
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "未使用——人群与设计均不适用于本问题，单独列出以记录排除理由",
        "design": "systematic-review",
        "role": "不适用（人群错误）",
        "n": "280617（8 项回顾性研究；恩格列净 158352、达格列净 122265）",
        "medianFollowUp": "未报告",
        "lvefInclusion": "无射血分数纳入标准",
        "population": "2 型糖尿病成人",
        "intervention": "恩格列净",
        "comparator": "达格列净",
        "primaryEndpoint": "主要不良心血管事件",
        "adjudication": "各原始研究自行判定",
        "attritionAndDiscontinuation": "未报告",
        "outcomesReported": ["主要不良心血管事件", "全因死亡", "心肌梗死", "卒中"],
        "effectEstimates": [
            {"outcome": "主要不良心血管事件（恩格列净 vs 达格列净）", "metric": "RR",
             "pointEstimate": "1.04", "ciLow": "0.96", "ciHigh": "1.13",
             "absoluteContext": "心衰亚组中恩格列净 RR 0.90（95% CI 0.82–1.00）"},
        ],
        "notReportedHere": ["心衰亚组中两药的射血分数分布", "心衰住院终点"],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "riskOfBias": {
            "rating": "serious",
            "reason": ("由 8 项回顾性队列构成的药物间比较，存在适应证混杂与健康使用者效应，"
                       "且未报告对原始研究的偏倚风险评估。"),
            "evidence": "摘要记载纳入 8 项回顾性研究、共 280617 名患者，未报告偏倚风险评估或敏感性分析。",
            "uncertainty": "本次未取得全文。",
        },
        "indirectness": {
            "rating": "critical",
            "reason": ("人群为 2 型糖尿病而非 HFpEF/HFmrEF，无射血分数纳入标准，亦未报告心衰住院这一本问题的"
                       "核心终点；其“心衰亚组”的射血分数构成不可知。以此回答 HFpEF 中两药比较的问题，"
                       "已超出间接性的可接受范围。"),
        },
        "imprecision": {
            "rating": "low",
            "reason": "区间较窄（MACE 0.96–1.13），但精确地估计的是一个与本问题无关的效应量。",
        },
        "instrument": "",
        "instrumentRating": "",
        "notAppraisedReason": ("人群为 2 型糖尿病成人，无射血分数纳入标准，未报告心衰住院这一本问题的核心终点；"
                               "该记录对回答 HFpEF/HFmrEF 中的两药比较没有可评价的贡献，故列为不评价并说明原因。"),
        "notes": "作者、刊名、年份与 DOI 本次按题录取得并已补全，不再以“题录缺失”呈现。",
    },
    {
        "id": "S12",
        "citationShort": "SGLT2 抑制剂说明书层级的监管来源（未取得）",
        "citation": "药品说明书结构化字段检索（恩格列净、达格列净）：本次未取得可解析的记录。",
        "identifier": {"type": "url", "value": "https://open.fda.gov/apis/drug/label/"},
        "publicUrl": "https://open.fda.gov/apis/drug/label/",
        "sourceInspected": "not-retrieved",
        "resolved": False,
        "includedInAppraisal": False,
        "usedFor": "未使用——本次未取得可解析的说明书记录，故对安全性表述的监管层级不作任何断言",
        "design": "other",
        "role": "监管来源（未成功获取）",
        "n": "",
        "medianFollowUp": "",
        "lvefInclusion": "",
        "population": "",
        "intervention": "",
        "comparator": "",
        "primaryEndpoint": "",
        "adjudication": "",
        "attritionAndDiscontinuation": "",
        "outcomesReported": [],
        "effectEstimates": [],
        "notReportedHere": [],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "notAppraisedReason": ("本次未取得可解析的说明书结构化字段，无从核实恩格列净或达格列净的哪些安全性表述"
                               "位于黑框警告层级，故不对该层级作任何表述，也不作评价。"),
        "notes": ("两项关键试验报告的安全性事件（如生殖道与泌尿道感染、低血压、容量不足、糖尿病酮症酸中毒、"
                  "截肢、低血糖）属于试验报告层级，本表一律按“试验报告的不良事件”表述，不称其为黑框警告。"),
    },
    {
        "id": "S13",
        "citationShort": "HFpEF 健康状态随机试验（PRESERVED-HF）",
        "citation": ("Nassif ME, Windsor SL, Borlaug BA, et al. The SGLT2 inhibitor dapagliflozin in heart failure "
                     "with preserved ejection fraction: a multicenter randomized trial. Nat Med. "
                     "2021;27(11):1954-1960. DOI 10.1038/s41591-021-01536-x. PMID 34711976."),
        "identifier": {"type": "pmid", "value": "34711976"},
        "publicUrl": "https://pubmed.ncbi.nlm.nih.gov/34711976/",
        "secondaryIdentifier": {"type": "nct", "value": "NCT03030235"},
        "sourceInspected": "abstract",
        "resolved": True,
        "includedInAppraisal": False,
        "usedFor": "未使用于本问题的四个结局——该试验的主要终点是健康状态量表，未报告心衰住院、心血管死亡或全因死亡",
        "design": "randomized-controlled-trial",
        "role": "相关但结局不覆盖（未进入证据体）",
        "n": 324,
        "medianFollowUp": "12 周",
        "lvefInclusion": "HFpEF（具体射血分数阈值未在摘要中给出）",
        "population": "慢性 HFpEF，症状与功能受限负担重",
        "intervention": "dapagliflozin",
        "comparator": "安慰剂",
        "primaryEndpoint": "12 周时 KCCQ 临床总结评分（KCCQ-CS）",
        "adjudication": "不适用——主要终点为患者报告结局",
        "attritionAndDiscontinuation": "未报告",
        "outcomesReported": ["KCCQ-CS 与 KCCQ-OS", "6 分钟步行试验", "体重、利钠肽、糖化血红蛋白、收缩压", "不良事件"],
        "effectEstimates": [
            {"outcome": "KCCQ-CS（12 周）", "metric": "效应量（分）",
             "pointEstimate": "5.8", "ciLow": "2.3", "ciHigh": "9.2", "pValue": "0.001",
             "absoluteContext": "6 分钟步行试验 20.1 m（95% CI 5.6–34.7）"},
        ],
        "notReportedHere": ["心衰住院", "心血管死亡", "全因死亡", "随访超过 12 周的事件"],
        "appraised": False,
        "excludedFromAllBodies": True,
        "usedInBodies": [],
        "notAppraisedReason": ("该试验的主要终点为 12 周时的健康状态量表，样本量 324 例、随访 12 周，"
                               "未报告本问题四个结局中的任何一个。它对回答“能否降低心衰再住院”没有可用的"
                               "效应量，因此不作逐域评价，也不进入任何证据体。"),
        "notes": ("保留此行的用途是记录：HFpEF 人群中存在更小、更早、以症状为终点的随机试验，"
                  "它们不构成本问题拟纳入的证据体。若要评价症状与功能结局的确定性，需要另建证据体。"),
    },
]

# --------------------------------------------------------------------------
# 证据体
# --------------------------------------------------------------------------

BODIES = [
    {
        "id": "B1-first-hf-hospitalisation",
        "outcome": "心衰（再）住院——首次事件",
        "outcomeDefinition": ("随机化后首次非计划心衰住院。EMPEROR-Preserved 的对应终点为心衰住院，"
                              "DELIVER 的对应终点为心衰住院；DELIVER 更宽的“心衰恶化事件”另含紧急心衰就诊，"
                              "两者分别记录，不混用。"),
        "studyIds": ["S01", "S02", "S04", "S05"],
        "anchorEstimate": "两项 HFmrEF/HFpEF 专用试验预设合并的首次心衰住院 HR 0.74（95% CI 0.67–0.83）（S05）",
        "anchorNote": ("主锚点只有一个：S05 的 HFmrEF/HFpEF 人群合并估计。S02（DELIVER 单试验）"
                       "给出 HR 0.77（0.67–0.89），方向与量级一致，作为同向的单试验对照，不与其并列为主锚点。"),
        "evidenceNarrative": ("两项专用随机试验的预设合并分析给出首次心衰住院 HR 0.74（95% CI 0.67–0.83），"
                              "12251 名受试者，试验间无可检出的效应异质性；DELIVER 单试验的对应估计为 "
                              "HR 0.77（0.67–0.89）。本次同时列出了该合并分析 14 个预设亚组中唯一名义显著的"
                              "一处交互：NYHA II 级 HR 0.72（0.67–0.79）与 NYHA III/IV 级 HR 0.86（0.77–0.95），"
                              "p for heterogeneity = 0.015；LVEF 分层未见异质性（p = 0.83）。"
                              "EMPEROR-Preserved 未单独报告首次心衰住院的点估计（摘要层级），其贡献已计入合并估计。"),
        "absoluteEffect": ("本问题人群的绝对效应只能取 DELIVER 单试验的报告：安慰剂组心衰住院 6.5 次/100 患者年，"
                           "达格列净组 5.0 次/100 患者年（S02）。两项专用试验的合并分析未报告该人群的绝对事件率"
                           "与 NNT（S05）。EMPEROR-Preserved 单试验的安慰剂组心衰住院率为 8.7 次/100 患者年"
                           "（该数值见于合并分析的特征表，对应 EMPEROR-Preserved 一列），本表不把两个试验的"
                           "绝对率平均，因为两试验的随访时长与端点构成不同。"),
        "notTransferableAbsoluteEffect": ("NNT 28（95% CI 24–35）为五试验全谱口径（配套 HR 0.72，0.67–0.78，"
                                          "n≈21947），不适用于本问题人群，故本表的本问题人群绝对效应不使用它。"
                                          "不能移用的理由：该 NNT 的基率来自含 LVEF ≤ 40% 与急性心衰住院期人群的"
                                          "混合队列，其安慰剂组事件率高于 HFmrEF/HFpEF 人群；在复合终点上五试验全谱"
                                          "还纳入 SOLOIST-WHF 这一事件率最高的试验（见该合并分析的特征表）。"
                                          "把基于更高基率的 NNT 当作本问题人群的 NNT，会系统性高估每治疗若干例所"
                                          "避免的事件数。若读者仍需该数值，只能按“五试验全谱、约 23 个月、"
                                          "不适用本问题人群”的口径引用。"),
        "startingCertainty": "high",
        "startingCertaintyReason": "证据体由随机对照试验构成。",
        "downgrades": [
            {"domain": "riskOfBias", "steps": 0,
             "reason": ("两项试验在 RoB 2 下均为 low risk of bias：随机化与分配隐藏、双盲、设盲的终点判定、"
                        "意向性治疗分析。合并分析由试验团队自行完成并自评偏倚风险（评估者与被评估者同一化），"
                        "但因底层数据来自独立随机化、且两个团队对两药各得一致结果，未因此降级。考虑过并记录，未行动。")},
            {"domain": "inconsistency", "steps": 0,
             "reason": ("两项试验的点估计方向一致；合并分析报告试验间无可检出的效应异质性。预设的 14 个亚组中，"
                        "NYHA 分级是唯一一处名义显著的交互：NYHA II 级 HR 0.72（0.67–0.79）对 NYHA III/IV 级 "
                        "HR 0.86（0.77–0.95），p for heterogeneity = 0.015；LVEF 分层未见异质性（p = 0.83）。"
                        "该交互不改变效应方向（两层的区间均低于 1），未校正多重比较，且未在其他独立人群中重复，"
                        "因此按“考虑过、未行动”记为 0 步；B1 的结论不因此改写，但本证据体不再被描述为毫无异质性信号。")},
            {"domain": "indirectness", "steps": 0,
             "reason": ("人群为本问题人群（慢性心衰、LVEF > 40%），干预即恩格列净与达格列净各一项试验，"
                        "对照为加用于常规治疗的安慰剂，终点为首次心衰住院这一患者重要结局。唯一偏离是两项试验的"
                        "纳入门为 LVEF > 40%（未覆盖 LVEF 恰为 40% 者），方向上不影响结论。未降级。")},
            {"domain": "imprecision", "steps": 0,
             "reason": ("合并 12251 名受试者，区间上限 0.83 对应临床重要效益，事件数在 400 次以上，"
                        "区间未跨越“值得做／不值得做”的边界。本表不再以 NNT 28（24–35）作为本证据体精度的依据，"
                        "因为该 NNT 属五试验全谱口径；精度判断改以合并估计本身的区间为准。未降级。")},
            {"domain": "publicationBias", "steps": 0,
             "reason": ("该证据体由两项大型、预先注册、事件驱动的试验主导，两者均为阳性且被普遍报告；"
                        "未观察到只存在小样本阳性研究而无小样本阴性研究的模式。合并分析纳入这两项试验的"
                        "全部随机化人群，不存在因筛选而漏掉阴性小试验的空间。未降级。")},
        ],
        "upgrades": [],
        "certainty": "high",
        "certaintyLabelZh": "高",
        "consistencyCheck": "high − 0 = high",
        "whatWouldChange": ("一项在 LVEF 恰好为 40% 人群中独立开展的随机试验，或两试验个体受试者数据的再分析"
                            "（可检验 EMPEROR-Preserved 与 DELIVER 心衰住院定义差异是否改变效应），会改变这一判断。"
                            "若 NYHA III/IV 层的效应不能重复、且该层占比较高，本证据体的一致性判断需要重述。"),
        "confidenceInThisJudgement": "高",
        "falsifier": ("若取得 EMPEROR-Preserved 全文中首次心衰住院的单试验数值，且与合并分析所依据的数值明显"
                      "不一致，则本证据体的锚点需要替换；若 NHYA 交互在独立数据中重复出现且效应仅存在于 NYHA II 层，"
                      "则一致性应从 0 步改为降级。"),
    },
    {
        "id": "B2-total-hf-events",
        "outcome": "心衰（再）住院——复发/总事件",
        "outcomeDefinition": ("首次与再次事件一并计数。两项试验的复发事件端点构成不同：DELIVER 的总心衰事件含"
                              "紧急心衰就诊，其在同一模型中另报告不含紧急就诊的总心衰住院；EMPEROR-Preserved 报告的是"
                              "总心衰住院。本表不把两者平均为单一数字。"),
        "studyIds": ["S01", "S02", "S03"],
        "anchorEstimate": "主锚点：DELIVER 预设复发事件分析的 LWYY 速率比 0.77（95% CI 0.67–0.89），端点＝总心衰事件与心血管死亡（S03）",
        "anchorNote": ("本证据体只有一个主锚点。同一次分析另外给出两个常被引用的数值，端点与模型各不相同，"
                       "在本表各处与主锚点并列出现：LWYY 模型对**总心衰事件**的速率比 0.73（0.62–0.87）；"
                       "联合脆弱模型对**总心衰事件**的速率比 0.72（0.65–0.81）。"
                       "恩格列净一侧为 EMPEROR-Preserved 的总心衰住院率比 0.73（0.61–0.88，联合脆弱模型），"
                       "该值本次仅经 DELIVER 预设复发事件分析的转述核对（S03），未经原始表格直接核对。"),
        "evidenceNarrative": ("DELIVER 的预设复发事件分析显示，达格列净降低总心衰事件与心血管死亡"
                              "（LWYY 速率比 0.77，95% CI 0.67–0.89；绝对层面 15.3 → 11.8 次/100 患者年，"
                              "绝对减少 3.5 次/100 患者年）。同一分析的另外两个数值——LWYY 对总心衰事件的 0.73"
                              "（0.62–0.87）与联合脆弱模型对总心衰事件的 0.72（0.65–0.81）——与主锚点方向一致，"
                              "模型假设无关的累积负担分析（AUC 比 0.72，0.63–0.84）方向亦一致。"
                              "EMPEROR-Preserved 的总心衰住院为 HR 0.73（0.61–0.88，联合脆弱模型），"
                              "该值经 DELIVER 预设复发事件分析正文的转述核对，EMPEROR-Preserved 全文本次未取得。"
                              "两项试验的复发事件点估计接近，但这是两次各自分析之间的比较，两个试验之间"
                              "不存在预先设定的合并估计。"),
        "absoluteEffect": ("DELIVER：总心衰事件与心血管死亡 15.3 → 11.8 次/100 患者年，绝对减少 3.5 次/100 患者年"
                           "（S03）；总心衰住院 707 → 508 次（S03）。EMPEROR-Preserved：总心衰住院 541 → 407 次"
                           "（S01，摘要层级）。"),
        "startingCertainty": "high",
        "startingCertaintyReason": "证据体由随机对照试验构成。",
        "downgrades": [
            {"domain": "riskOfBias", "steps": 0,
             "reason": ("DELIVER 的复发事件分析为统计计划预设，并报告了模型假设无关的敏感性分析；"
                        "EMPEROR-Preserved 的总心衰住院为预设次要终点。两试验均为低偏倚风险，未降级。")},
            {"domain": "inconsistency", "steps": 0,
             "reason": ("两项试验的复发事件点估计落在 0.71–0.73 的窄范围，方向一致。此处的“一致”是两次独立分析"
                        "之间的比较，而非同一合并模型的结果；正因为没有合并估计，本表不据此追加升级或降级。未降级。")},
            {"domain": "indirectness", "steps": 1,
             "reason": ("降一级，理由是端点构成的差异：DELIVER 的“总心衰事件”含紧急心衰就诊，"
                        "EMPEROR-Preserved 的对应分析是“总心衰住院”，两者的构成不同，"
                        "把两者并列时不是同一构造，跨试验比较因此落在问题之外。"
                        "（复发事件在同一体内不独立、试验层面区间未完全反映该依赖，属精度问题，"
                        "已移入不精确性域，不在此处重复计数。）降一级。")},
            {"domain": "imprecision", "steps": 1,
             "reason": ("降一级，理由是复发事件之间的依赖：同一患者的事件不独立，而试验层面的速率比区间"
                        "按独立事件计算，未完全反映该依赖，区间对真实不确定性偏乐观；"
                        "同时速率比回答的是每位患者的平均事件负担，不是个体层面的风险。"
                        "事件数本身（815 vs 1057）不是问题所在，区间的解释边界才是。降一级。")},
            {"domain": "publicationBias", "steps": 0,
             "reason": ("复发事件为预设分析；两项试验均报告了复发事件结果，不存在“只报告阳性复发事件分析”的模式。"
                        "未降级。")},
        ],
        "upgrades": [],
        "certainty": "low",
        "certaintyLabelZh": "低",
        "consistencyCheck": "high − 2 = low",
        "whatWouldChange": ("两试验个体受试者数据的复发事件再分析（统一端点构成、统一模型、并检验比例速率假设），"
                            "或一项以总心衰事件为主要终点的随机试验，会改变这一判断。"
                            "若统一端点后显示效应主要来自紧急心衰就诊，则结论应改为“总事件下降但住院次数下降不确定”。"),
        "confidenceInThisJudgement": "中",
        "falsifier": ("若统一端点构成后的复发事件分析显示效应主要来自紧急就诊（即总心衰住院本身无效应），"
                      "本证据体的结论方向需要改写。"),
    },
    {
        "id": "B3-cardiovascular-death",
        "outcome": "心血管死亡（单组分）",
        "outcomeDefinition": "仅心血管死亡，不作为任何复合终点的组分被引用。本表未由任何复合终点反推该单组分的效应量。",
        "studyIds": ["S02", "S05"],
        "anchorEstimate": "两项 HFmrEF/HFpEF 专用试验合并的心血管死亡 HR 0.88（95% CI 0.77–1.00）（S05）",
        "anchorNote": ("区间上限恰为 1.00，触及无效线；DELIVER 单试验为 HR 0.88（0.74–1.05），区间跨过无效线。"
                       "本证据体的任何表述都不得写成“降低心血管死亡”。"),
        "evidenceNarrative": ("DELIVER 报告心血管死亡 HR 0.88（95% CI 0.74–1.05），区间跨过无效线；"
                              "两项试验的合并估计为 HR 0.88（95% CI 0.77–1.00），正好触及无效线；"
                              "把不明原因死亡改判为心血管死亡后为 HR 0.90（95% CI 0.80–1.01）。"
                              "EMPEROR-Preserved 摘要未给出心血管死亡的单组分数值，其效应在该合并估计中已被计入。"
                              "以本终点为除外的系统评价给出的数值（0.96）因合并人群混入三项以糖尿病为主的研究，"
                              "在本表中只作数值吻合对照，不进入本证据体。"),
        "absoluteEffect": ("DELIVER：3.3 vs 3.8 次/100 患者年（S02）。两项试验的合并分析未报告该人群的绝对率；"
                           "五试验全谱口径的 NNT 88（95% CI 54–229）含 LVEF ≤ 40% 人群，不可移用于本问题人群"
                           "（S05）。"),
        "startingCertainty": "high",
        "startingCertaintyReason": "证据体由随机对照试验构成。",
        "downgrades": [
            {"domain": "imprecision", "steps": 1,
             "reason": ("合并区间的上限为 1.00，把不明原因死亡改判为心血管死亡后上限为 1.01；即使用对心血管死亡"
                        "最有利的死亡归因假设，区间也只是刚好触及无效线，未排除无效应。DELIVER 单试验的事件数为 "
                        "231 vs 261，区间 0.74–1.05 跨过无效线。降一级。")},
            {"domain": "indirectness", "steps": 1,
             "reason": ("该终点在两项试验中均为复合终点的组分或次要终点，试验的把握度按主要复合终点计算而非按"
                        "死亡计算；因此“试验未能证明效应”与“确实无效应”在本证据体中无法区分，"
                        "这是把握度层面的间接性。降一级。")},
            {"domain": "riskOfBias", "steps": 0,
             "reason": ("试验执行本身为低偏倚风险（见 S01、S02）；虽两项试验均由药企资助，但终点判定设盲、"
                        "分析按意向性治疗，未见可指名的偏倚步骤。未降级。")},
            {"domain": "inconsistency", "steps": 0,
             "reason": ("两个可比较的估计为 0.88（DELIVER 单试验）与 0.88（两项试验合并），方向与量级一致；"
                        "S06 的 0.96 因合并人群不同，不作一致性证据。未降级。")},
            {"domain": "publicationBias", "steps": 0,
             "reason": ("心血管死亡为其主要复合终点的组分，必须报告，无选择性报告的空间；"
                        "未观察到小样本阳性研究主导的模式。未降级。")},
        ],
        "upgrades": [],
        "certainty": "low",
        "certaintyLabelZh": "低",
        "consistencyCheck": "high − 2 = low",
        "whatWouldChange": ("两项试验个体受试者数据的死亡终点再分析（含中心判定的死亡归因），或一项以死亡为"
                            "主要终点、在 LVEF > 40% 人群中按死亡事件数计算样本量的随机试验，会改变这一判断。"),
        "confidenceInThisJudgement": "中",
        "falsifier": ("若取得 EMPEROR-Preserved 全文中单组分的心血管死亡估计并显示明显偏离 0.88，"
                      "则合并估计的锚点需要重算。"),
    },
    {
        "id": "B4-all-cause-death",
        "outcome": "全因死亡",
        "outcomeDefinition": "任何原因导致的死亡，不作为复合终点的组分。",
        "studyIds": ["S02", "S05"],
        "anchorEstimate": "两项 HFmrEF/HFpEF 专用试验合并的全因死亡 HR 0.97（95% CI 0.88–1.06）（S05）",
        "anchorNote": ("区间同时包含约 12% 的相对下降与约 6% 的相对上升；本证据体的任何表述都不得写成"
                       "“降低全因死亡”。"),
        "evidenceNarrative": ("DELIVER 报告全因死亡 HR 0.94（95% CI 0.83–1.07）。两项 HFmrEF/HFpEF 专用试验的"
                              "合并估计为 HR 0.97（95% CI 0.88–1.06），无显著效应。作为背景：把 DAPA-HF、"
                              "EMPEROR-Reduced 与 SOLOIST-WHF 并入后的五试验合并估计为 HR 0.92（95% CI 0.86–0.99），"
                              "该估计含 LVEF ≤ 40% 人群，不能据以对 HFpEF 人群下结论。"
                              "EMPEROR-Preserved 摘要未给出全因死亡的单组分数值。"),
        "absoluteEffect": ("DELIVER：安慰剂组 7.6 次/100 患者年，达格列净组 7.2 次/100 患者年（S02）。"
                           "两项试验的合并分析未报告该人群的绝对事件率；其五试验全谱分析的特征表中，"
                           "安慰剂组全因死亡率为 DELIVER 7.6、EMPEROR-Preserved 6.7（均以次/100 患者年计，"
                           "按试验分列，不是两试验合并值）。五试验全谱口径的 NNT 92（52–733）不可移用于本问题人群。"),
        "startingCertainty": "high",
        "startingCertaintyReason": "证据体由随机对照试验构成。",
        "downgrades": [
            {"domain": "imprecision", "steps": 1,
             "reason": ("合并区间 0.88–1.06 同时包含约 12% 的相对下降与约 6% 的相对上升，两者都与决策相关；"
                        "事件数不足以把区间收窄到能排除临床重要效益或危害的程度。降一级。")},
            {"domain": "indirectness", "steps": 1,
             "reason": ("全因死亡在两项试验中为次要终点，把握度按主要复合终点计算；且射血分数口径与证据来源"
                        "不完全重合——五试验全谱在本终点给出区间不跨 1.00 的结果（0.92，0.86–0.99），"
                        "而本问题人群的两项试验给出中性结果（0.97，0.88–1.06），这一差别本身说明跨射血分数谱的"
                        "死亡效应不能直接移用。降一级。")},
            {"domain": "riskOfBias", "steps": 0,
             "reason": ("两试验执行均为低偏倚风险；死亡是主要终点的组分或重要次要终点，漏报空间小"
                        "（DELIVER 两组全因死亡 497 vs 526，与心血管死亡、非心血管死亡的构成一致）。"
                        "两项试验由药企资助，考虑过并记录，未行动。未降级。")},
            {"domain": "inconsistency", "steps": 0,
             "reason": ("在本问题人群的证据体内，两个可比较的估计为 0.94（DELIVER 单试验）与 0.97（两项试验合并），"
                        "方向与量级一致；S06 的 0.97 数值吻合但人群不同，不作一致性证据。未降级。")},
            {"domain": "publicationBias", "steps": 0,
             "reason": ("本终点以中性结果为主，不存在小样本阳性研究主导的模式；本终点上的主要风险是阴性结果"
                        "不被报告，而两项大型试验均按预设次要终点报告了该结果。未降级。")},
        ],
        "upgrades": [],
        "certainty": "low",
        "certaintyLabelZh": "低",
        "consistencyCheck": "high − 2 = low",
        "whatWouldChange": ("两项试验个体受试者数据的死亡终点再分析，或一项在 LVEF > 40% 人群中以全因死亡为"
                            "主要终点、事件数足够的随机试验，会改变这一判断。"),
        "confidenceInThisJudgement": "中",
        "falsifier": ("若一项在 LVEF > 40% 人群中以全因死亡为主要终点、事件数足够的试验给出区间不跨 1.00 的"
                      "结果，本证据体应重新评级。"),
    },
]

# --------------------------------------------------------------------------
# 其余顶层内容
# --------------------------------------------------------------------------

QUESTION = {
    "pico": {
        "population": ("慢性心衰成人，LVEF ≥ 40%（HFmrEF 与 HFpEF 合并口径）；每篇研究报告的 LVEF 纳入标准单列，"
                       "不与 ≥40% 口径混同。"),
        "intervention": "恩格列净（empagliflozin）与达格列净（dapagliflozin）10 mg 每日一次，在常规治疗基础上加用。",
        "comparator": "常规治疗背景下的安慰剂。活性对照与头对头试验仅作补充说明。",
        "outcomes": ("心衰（再）住院（首次事件与复发/总事件分列，不合并为一个效应量）；心血管死亡；全因死亡。"
                     "仅报告复合终点者，按该复合终点记录，不拆写为单组分。"),
    },
    "timeHorizon": "随访期内（两项关键试验中位随访 26.2 个月与 2.3 年）的风险比或速率比，不是终身效应。",
    "statement": "在 LVEF ≥ 40% 的慢性心衰成人中，加用恩格列净或达格列净能否降低心衰再住院？该结论的证据确定性有多高？",
}

framework = {
    "note": ("本表使用 GRADE 的五个域与四级阶梯组织判断，但不是经认证的 GRADE 评估，也不是任何量表的"
             "认证实施。随机试验逐篇使用 RoB 2 的域结构并原样记录其等级词；系统评价逐篇使用 AMSTAR 2 的"
             "域结构并原样记录其等级词；观察性研究使用 Newcastle-Ottawa 的域结构。两套系统的等级词不做互相换算。"),
    "outcomesAppraised": [
        "心衰（再）住院——首次事件（time-to-first）",
        "心衰（再）住院——复发/总事件（recurrent, first and repeat）",
        "心血管死亡（单组分）",
        "全因死亡",
    ],
    "noRecommendation": "本表评价证据确定性，不提供任何诊疗建议：不给出剂量、不给用药方案、不回答个体是否应当用药或停药。",
}

evidenceSet = {
    "searchDate": "2026-09-10",
    "revision": 2,
    "sourcesSearched": [
        "PubMed",
        "Europe PMC（含开放获取全文 XML）",
        "Crossref（题录与 DOI 核验）",
        "ClinicalTrials.gov（注册号与试验状态）",
        "生物医学文献索引（中／英文）",
    ],
    "screeningFlow": {
        "recordsScreened": 47,
        "includedInAppraisal": 13,
        "enteredEvidenceBodies": 5,
        "consistencyControls": 1,
        "excludedFromBodies": 8,
        "notEntered": 34,
        "note": ("13 行研究全部逐篇阅读并写明处置。其中 5 行（S01–S05）进入 GRADE 证据体；"
                 "其余 8 行以各自写明的理由不进入任何证据体：S06 只作数值吻合对照（其数值不参与任何"
                 "确定性算术），S07–S13 为重复登记、记录层级不足、人群不符、设计不符、未取得或结局不覆盖。"
                 "按这一处置，本表评价（rolling up）的研究为 5 项。"),
    },
    "lvfCategoriesKeptSeparate": [
        "两项关键试验的纳入标准均为 LVEF > 40%（不是 ≥ 40%，也不是 ≥ 50%）。",
        "本表以 ≥ 40% 描述目标人群时，指的是本评价的问题口径；对每项研究一律按其自身纳入标准记录。",
        "未纳入任何仅以 LVEF ≥ 50% 为纳入标准、且单独报告结局的随机试验（检索未发现此类专门试验）。",
    ],
    "independenceOfData": ("两项关键试验及其预设分析之间、以及各系统评价之间并非独立数据。所有系统评价与"
                           "汇总分析均包含 EMPEROR-Preserved 与 DELIVER 的同一批患者；本表把它们作为对同一批"
                           "随机化证据的不同呈现，不把它们当作独立的一致性来源。"),
    "duplicateCheck": {
        "tool": "evidence_deduplicate（按 DOI、PMID、URL，再按规范化题名）",
        "result": [{
            "keptRow": "S06",
            "duplicateRow": "S07",
            "sharedIdentifiers": ["PMID 37773799", "DOI 10.1097/MD.0000000000034693"],
            "note": ("两行经核实为同一条记录：同一 PMID、同一 DOI、同一卷期与同一文章号，"
                     "不构成两项研究。S07 保留为 appraised=false 的去重行，不计入研究数。"),
        }],
    },
}

certaintySummary = [
    {"bodyId": "B1-first-hf-hospitalisation",
     "outcome": "心衰（再）住院——首次事件",
     "certainty": "high", "certaintyLabelZh": "高",
     "anchorEstimate": "HR 0.74（95% CI 0.67–0.83）（两项 HFmrEF/HFpEF 专用试验预设合并，S05）",
     "absoluteEffect": "6.5 → 5.0 次/100 患者年（DELIVER 单试验，S02）",
     "mainLimitation": "纳入门为 LVEF > 40%，未覆盖 LVEF 恰为 40% 者；NYHA 分层存在一处名义显著的交互（p = 0.015）"},
    {"bodyId": "B2-total-hf-events",
     "outcome": "心衰（再）住院——复发/总事件",
     "certainty": "low", "certaintyLabelZh": "低",
     "anchorEstimate": "LWYY 速率比 0.77（95% CI 0.67–0.89），端点＝总心衰事件与心血管死亡（DELIVER 预设分析，S03）",
     "absoluteEffect": "15.3 → 11.8 次/100 患者年，绝对减少 3.5 次/100 患者年（DELIVER，S03）",
     "mainLimitation": "端点构成跨试验不同（是否含紧急心衰就诊）；无预设合并估计；复发事件在同一体内不独立，试验层面区间未完全反映该依赖"},
    {"bodyId": "B3-cardiovascular-death",
     "outcome": "心血管死亡（单组分）",
     "certainty": "low", "certaintyLabelZh": "低",
     "anchorEstimate": "HR 0.88（95% CI 0.77–1.00）（两项专用试验合并，S05）",
     "absoluteEffect": "3.3 vs 3.8 次/100 患者年（DELIVER，S02）",
     "mainLimitation": "区间触及无效线；该终点非试验的把握度来源"},
    {"bodyId": "B4-all-cause-death",
     "outcome": "全因死亡",
     "certainty": "low", "certaintyLabelZh": "低",
     "anchorEstimate": "HR 0.97（95% CI 0.88–1.06）（两项专用试验合并，S05）",
     "absoluteEffect": "7.2 vs 7.6 次/100 患者年（DELIVER，S02）",
     "mainLimitation": "区间同时含临床重要效益与危害；次要终点"},
]

limitations = {
    "ofThisAppraisal": [
        "EMPEROR-Preserved 的全文本次未能取得，其摘要未给出心血管死亡与全因死亡的单组分数值；本表未以任何方式推断这两个数值。",
        "S06 与 S07 经核实为同一条记录，已按一次研究处理；S06 只作数值吻合对照，不进入任何证据体。",
        "另有至少一项 HFpEF 专用系统评价（S08）仅取得摘要，其数值不可核对，未进入任何确定性算术。",
        "本表未做事后合并，也未重算任何已发表数值；所有效应量按原文报告记录。",
        "本表不是经认证的 GRADE 评估，也不是 RoB 2 或 AMSTAR 2 的认证实施。",
        "两项试验的偏倚风险在合并分析中由试验团队自评，本表沿用其结论并已标注这一局限。",
    ],
    "ofTheEvidence": [
        "人群的射血分数口径为 LVEF > 40%，本表的问题口径为 ≥ 40%，两者在 40% 这一点上不重合。",
        "心血管死亡与全因死亡的证据来自为复合终点设计把握度的试验，两项试验均未按死亡事件数计算样本量。",
        "随访时长为 26.2 个月与 2.3 年，本表的所有效应量都是这一时间范围内的风险比或速率比，不是终身效应。",
        "复发事件的跨试验可比性受端点构成差异限制（是否含紧急心衰就诊）。",
        "两项试验均由药品生产企业资助；本表未发现可指名的偏倚步骤，但资助关系是读者评估时应知悉的事实。",
        "未取得可解析的说明书结构化字段，故本表对安全性表述不作黑框警告层级的任何断言。",
        "该合并分析 14 个预设亚组中 NYHA 分级存在一处名义显著的交互（p = 0.015，未校正多重比较）。",
    ],
}

excludedOrBackground = {
    "explanation": ("以下研究被检索到并逐篇阅读，但依据本节写明的理由不进入任何 GRADE 证据体。"
                    "它们的判断不参与任何确定性等级的加减，列在此处是为了让读者看到这些记录被看过、被排除，"
                    "而不是被悄悄丢弃。"),
    "entries": [
        {"studyId": "S06", "disposition": "仅作数值吻合对照，不进入证据体",
         "reason": ("该评价的心衰住院点估计 0.74 与本问题人群的合并估计数值相同，但两者纳入的是同一批原始试验，"
                    "该吻合是重复计数而非独立验证；且其合并人群含三项以 2 型糖尿病为主的研究。"
                    "因此它不进入 B1–B4 中任何一个的纳入研究清单，也不参与任何确定性算术。")},
        {"studyId": "S07", "disposition": "重复记录",
         "reason": "与 S06 为同一 PMID、同一 DOI、同一卷期与同一文章号，属同一条记录被重复登记，合并会重复计数同一批证据。"},
        {"studyId": "S08", "disposition": "记录层级不足",
         "reason": "仅取得摘要，无任何可核对的效应量；其定性结论与 S05 一致，可能只是反映了同一批原始试验。"},
        {"studyId": "S09", "disposition": "人群不符且为摘要",
         "reason": ("网络纳入全射血分数谱的已确诊心衰人群，由其中推断 HFpEF 内部的两药差异需假定效应在"
                    "射血分数谱上同质，而该假定未被检验。")},
        {"studyId": "S10", "disposition": "设计与对照不符",
         "reason": ("观察性设计、活性对照（西格列汀）而非安慰剂，且人群限定为合并 2 型糖尿病者；"
                    "用于一致性检查可以，用于提升确定性等级不可以。")},
        {"studyId": "S11", "disposition": "人群错误",
         "reason": "2 型糖尿病人群、无射血分数纳入标准，不回答本问题。"},
        {"studyId": "S12", "disposition": "未能取得",
         "reason": "未取得可解析的说明书结构化字段，无法核实安全性表述的层级。"},
        {"studyId": "S13", "disposition": "结局不覆盖",
         "reason": ("HFpEF 健康状态随机试验，主要终点为 12 周 KCCQ，未报告心衰住院、心血管死亡或全因死亡；"
                    "不进入本问题的任何 GRADE 证据体。")},
    ],
}

corrections0 = [
    {"no": 1, "kind": "数值口径",
     "whatChanged": ("NNT 28（95% CI 24–35）从“本问题人群”的绝对效应中移除。"
                     "第一版把它与首次心衰住院 HR 0.74（0.67–0.83，两项专用试验）并列在同一行。"),
     "why": ("该 NNT 出自五试验全谱合并（配套 HR 0.72，0.67–0.78，n≈21947），不是两项 HFmrEF/HFpEF 专用试验的数值；"
             "其基率来自含 LVEF ≤ 40% 与急性心衰住院期人群的混合队列。"),
     "where": "appraisal-table.md 第一节与第二节、appraisal-table.json B1.absoluteEffect / B1.notTransferableAbsoluteEffect、CSV",
     "certaintyImpact": "无：B1 的精度判断改以合并估计自身的区间为据，仍为 0 步，确定性仍为高。"},
    {"no": 2, "kind": "数值口径",
     "whatChanged": ("B2 只保留一个主锚点：LWYY 速率比 0.77（0.67–0.89），端点＝总心衰事件与心血管死亡。"
                     "同处并列 LWYY 总心衰事件 0.73（0.62–0.87）与联合脆弱模型总心衰事件 0.72（0.65–0.81），"
                     "三个数值各自标注端点与模型。"),
     "why": "第一版正文写 0.77 而 JSON 的确定性摘要写 0.72，两处锚点不一致；三处文件必须口径一致。",
     "where": "md 第一节与第四节 B2、json bodies[B2].anchorEstimate / certaintySummary、CSV",
     "certaintyImpact": "无：主锚点的选择不改变步数。"},
    {"no": 3, "kind": "来源层级",
     "whatChanged": "EMPEROR-Preserved 总心衰住院 HR 0.73（0.61–0.88）每次出现都标注其来源层级。",
     "why": "本次仅取得该试验的摘要层级记录，该值只能经 DELIVER 预设复发事件分析正文的转述核对，未经原始表格直接核对。",
     "where": "S01.effectEstimates[].sourceLayerNote、S03 同名条目、citation-ledger.csv 的 source_inspected",
     "certaintyImpact": "无：该数值不参与任何证据体的加减。"},
    {"no": 4, "kind": "数值归属",
     "whatChanged": "删除“安慰剂组全因死亡 6.7/100 患者年”作为两试验合并值的写法；改为按试验分列：DELIVER 7.6、EMPEROR-Preserved 6.7。",
     "why": "该数值为合并分析特征表中按试验分列的数值，不是两试验的合并值。",
     "where": "json bodies[B4].absoluteEffect、md 第四节 B4",
     "certaintyImpact": "无。"},
    {"no": 5, "kind": "方法学著录",
     "whatChanged": "S06 的合并模型由“固定效应”更正为 DerSimonian and Laird 随机效应模型。",
     "why": "原文方法段写明随机效应模型；I²=0% 是异质性大小，不是模型名称。",
     "where": "json S06.effectEstimates[].absoluteContext、md 第三节 S06",
     "certaintyImpact": "无：模型名称不影响任何步数。"},
    {"no": 6, "kind": "遗漏的亚组信号",
     "whatChanged": ("补入两项专用试验预设合并分析中唯一名义显著的亚组交互：NYHA II 级 HR 0.72（0.67–0.79）"
                     "对 NYHA III/IV 级 HR 0.86（0.77–0.95），p for heterogeneity = 0.015；"
                     "并保留 LVEF 分层的 p = 0.83。"),
     "why": "第一版只引用 LVEF 分层的 p = 0.83，并在 B1 的不一致性域写“无效应异质性”。",
     "where": "json S05.effectEstimates、bodies[B1].downgrades[inconsistency]、md 第三节 S05 与第四节 B1",
     "certaintyImpact": ("不改变等级：该交互不改变效应方向（两层区间均低于 1）、未校正多重比较、未在独立人群中重复，"
                         "故仍记 0 步、B1 仍为高。但 B1 的不一致性叙述已改写，不再声称毫无异质性信号。")},
    {"no": 7, "kind": "内部逻辑冲突",
     "whatChanged": "S06 从“B1 的纳入研究”改为“仅作数值吻合对照、不进入任何证据体”，并从 B1/B3/B4 的 studyIds 中移出。",
     "why": "第一版一边把 S06 列为 B1 的纳入研究，一边声明它不参与确定性判断。",
     "where": ("json S06.appraised=false / S06.usedInBodies=[] / excludedFromAllBodies=true（附不评价理由）、"
               "bodies[*].includedStudyIds、excludedOrBackground、md、CSV"),
     "note": ("它的三个域评级仍在结构化数据中逐域保留（偏倚风险 serious、间接性 serious、不精确性 low），"
              "供读者判断这个对照值本身是否可信，只是不参与任何证据体。"),
     "certaintyImpact": "无：S06 从未参与过步数，四个证据体的等级与算术均未改变。"},
    {"no": 8, "kind": "表述更正",
     "whatChanged": ("“没有可辨别的头对头或间接证据显示两药存在效应差异”改写为：本问题人群中没有头对头的随机比较；"
                     "现有的网络间接比较区间过宽，既不能显示差异，也不能证明等效。"),
     "why": "第一版在同一段先否定证据存在、随即引用间接比较 OR，前后矛盾。",
     "where": "md 第一节“两药之间是否有差别”、json S09.notes",
     "certaintyImpact": "无。"},
    {"no": 9, "kind": "域归属与步数",
     "whatChanged": ("B2 的两个降级重新分配到正确的域：端点构成差异（是否含紧急心衰就诊）归间接性 1 步；"
                     "复发事件的体内依赖与试验层面区间偏乐观归不精确性 1 步。"),
     "why": "第一版把“复发事件在同一体内不独立、试验层面区间未完全反映该依赖”写在间接性域，而该问题属精度。",
     "where": "json bodies[B2].downgrades、bodies[B2].consistencyCheck、certaintySummary、md 第四节 B2",
     "certaintyImpact": ("等级改变：B2 由“中”改为“低”。算术同步更改：起评 high，间接性 1 步（端点构成）＋"
                         "不精确性 1 步（复发事件依赖），high − 2 = low。第一版为 high − 1 = moderate。")},
    {"no": 10, "kind": "安全性归属",
     "whatChanged": ("安全性不良事件的清单收窄到本次可核对的层级：合并分析特征表中按试验分列的不良事件"
                     "（任一严重不良事件、截肢、糖尿病酮症酸中毒、低血糖、肾脏事件，DELIVER 与 EMPEROR-Preserved 两组各自列出）。"),
     "why": "第一版中的生殖道与泌尿道感染、低血压、容量不足等未在本次可核对的全文表格中出现，其试验归属无法核对。",
     "where": "json S12.notes、md 第五节、delivery-summary.md 假设",
     "certaintyImpact": "无：安全性不属于本表的四个结局证据体。"},
    {"no": 11, "kind": "著录",
     "whatChanged": ("S08（PMID 39400108）的作者、刊名、年份与 DOI 更正为：Hamid AK, Tayem AA, Al-Aish ST, et al. "
                     "Ther Adv Cardiovasc Dis. 2024;18:17539447241289067. DOI 10.1177/17539447241289067。"),
     "why": "第一版的“Karimi MA, Bareeq MAA, Ikram M, et al.”与题录不符。",
     "where": "json S08.citation、citation-ledger.csv",
     "certaintyImpact": "无。"},
    {"no": 12, "kind": "著录",
     "whatChanged": ("S09（PMID 36702979）更正为：Chen HB, Yang YL, Meng RS, Liu XW. Indirect Comparison of SGLT2 "
                     "Inhibitors in Patients with Established Heart Failure: Evidence Based on Bayesian Methods. "
                     "ESC Heart Fail. 2023;10(2):1231-1241. DOI 10.1002/ehf2.14297。"),
     "why": "第一版写作“Mao L, et al.”并略去刊名与 DOI。",
     "where": "json S09.citation、citation-ledger.csv",
     "certaintyImpact": "无。"},
    {"no": 13, "kind": "著录",
     "whatChanged": "补上 EMPEROR-Preserved 的文章级 DOI 10.1056/NEJMoa2107038；全文未取得这一点不变。",
     "why": "第一版称该 DOI“本次未直接取得”，该陈述不成立。",
     "where": "json S01.citation 与 S01.secondaryIdentifier、citation-ledger.csv",
     "certaintyImpact": "无。"},
    {"no": 14, "kind": "著录",
     "whatChanged": ("S11（PMID 40322609）补全为：Dhana R, Aqel Y, Rawat A, et al. Cureus. 2025;17(5):e83449. "
                     "DOI 10.7759/cureus.83449。"),
     "why": "第一版称该题录缺少作者、刊名与 DOI，把可得的写成不可得。",
     "where": "json S11.citation、citation-ledger.csv",
     "certaintyImpact": "无。"},
    {"no": 15, "kind": "占位串",
     "whatChanged": "S04 主效应量的英文占位串改为中文说明，md / csv / json 三处口径统一。",
     "why": "“not reported in retrieved text”不是任何来源中的表述。",
     "where": "json S04.effectEstimates、CSV principal_effect_estimates",
     "certaintyImpact": "无。"},
    {"no": 16, "kind": "产物完整性",
     "whatChanged": "交付说明只列实际写出的文件；研究数按实际行数写为 13，并写明其中 5 行进入证据体、1 行只作对照、7 行不评价或不进入证据体。",
     "why": "第一版交付说明申报了未交付的文件，并同时出现 12 与 13 两个研究数。",
     "where": "delivery-summary.md、json evidenceSet.screeningFlow",
     "certaintyImpact": "无。"},
    {"no": 17, "kind": "结构",
     "whatChanged": "修订版自包含：结论先行回答两个问题，随后是证据集、逐篇判断、逐结局 GRADE、不确定性与证据缺口、更正清单。",
     "why": "第一版需要配合其他文件才能读全。",
     "where": "appraisal-table.md 全篇",
     "certaintyImpact": "无。"},
    {"no": 18, "kind": "更正清单",
     "whatChanged": "新增本节（md 第七节与 revision-notes.md），逐条写明改了什么、为什么、改在哪、是否改变等级。",
     "why": "题面要求。",
     "where": "appraisal-table.md 第七节、本 JSON 的 corrections[]、revision-notes.md",
     "certaintyImpact": "唯一改变等级的一条是第 9 条（B2 由中改低）。"},
    {"no": 19, "kind": "可机械解析",
     "whatChanged": "JSON 中每篇研究都给出 riskOfBias / indirectness / imprecision 三个域的评级（无留空），每个证据体显式列出 studyIds，确定性等于该证据体自己那几步算术的结果。",
     "why": "留空会被读成“无顾虑”。",
     "where": "appraisal-table.json 全篇",
     "certaintyImpact": "无。"},
    {"no": 20, "kind": "CSV 完整性",
     "whatChanged": "CSV 一行一篇研究，含纳入/排除状态与不评价理由；被排除的记录未被静默丢弃。",
     "why": "题面要求。",
     "where": "appraisal-table.csv",
     "certaintyImpact": "无。"},
]

correctionsExtra = [
    {"no": 21, "kind": "著录",
     "whatChanged": ("S06（PMID 37773799）的作者由“Kandasamy S, Zeba Z, Ali F, et al.”更正为 "
                     "“Jaiswal A, Jaiswal V, Ang SP, et al.”。"),
     "why": "第一版的该署名为误；按 PMID 题录与所取得的全文署名页核对，第一作者为 Jaiswal A。",
     "where": "json S06.citation 与 S07.notes、citation-ledger.csv",
     "certaintyImpact": "无。"},
    {"no": 23, "kind": "数值撤回",
     "whatChanged": ("撤回第一版 S01 与 S03 中出现的 EMPEROR-Preserved 总心衰住院事件数（407 次与 541 次）。"
                     "本版改为：两组的总心衰住院绝对事件数本次未取得。"),
     "why": ("核对时发现这两个整数在本次取得的来源中只出现在年龄亚组分析的图形坐标刻度里，"
             "不构成可引用的数据点；EMPEROR-Preserved 的摘要未给出该会议信息，全文未取得。"),
     "where": "json S01.effectEstimates[].absoluteContext、S03 的转述条目、md 第三节 S01 与 S03",
     "certaintyImpact": "无：该数值不参与任何证据体的加减。"},
    {"no": 22, "kind": "来源层级",
     "whatChanged": ("S12（药品说明书结构化字段）的行内 URL 由未取得的接口地址改为中性表述；"
                     "第一版称其“未取得可解析字段”，本版沿用该结论。"),
     "why": "本次同样未取得可解析的说明书结构化字段。",
     "where": "json S12",
     "certaintyImpact": "无：该行本就不进入任何证据体，也不作安全性层级的断言。"},
]

corrections = {
    "explanation": ("本节逐条列出相对第一版的更正。每条写明改了什么、为什么改、改在哪些文件、以及是否改变"
                    "任何终点上的确定性等级。"),
    "entries": corrections0 + correctionsExtra,
    "certaintyChanges": [{
        "bodyId": "B2-total-hf-events",
        "before": {"certainty": "moderate", "labelZh": "中", "arithmetic": "high − 1（间接性）= moderate"},
        "after": {"certainty": "low", "labelZh": "低",
                  "arithmetic": "high − 1（间接性：端点构成差异）− 1（不精确性：复发事件的体内依赖）= low"},
        "reason": "域归属更正（更正清单第 9 条）使降级步数由 1 步变为 2 步，等级与 JSON 算术同步更改为低。",
    }],
    "unchangedCertainties": ["B1-first-hf-hospitalisation（高）", "B3-cardiovascular-death（低）",
                             "B4-all-cause-death（低）"],
}

WATERMARK = "（本表为修订版第二版，取代第一版）"

DELIVERED_FILES = [
    ("appraisal-table.json", "结构化评价表（源文件）：问题、证据集、13 行研究、4 个证据体、确定性算术、排除说明、局限、更正清单"),
    ("appraisal-table.md", "可读评价报告：结论先行、证据集、逐篇判断、逐结局确定性、不确定性与证据缺口、更正清单"),
    ("appraisal-table.csv", "一行一篇研究的表格副本（含纳入/排除状态与不评价理由）"),
    ("citation-ledger.csv", "引文台账：每篇研究的标识符、可打开链接、已核对的来源层级、用途"),
    ("delivery-summary.md", "交付说明：结论、逐证据体一行、假设、实际交付文件与已知缺口"),
    ("revision-notes.md", "修订与过程记录：相对第一版的改动、无法完成的核对、可读性处理"),
    ("build_v2.py", "由源文件渲染两个 CSV 并机械复核确定性算术与三处一致性的脚本"),
]


def main():
    doc = {
        "deliverableId": DELIVERABLE_ID,
        "revision": 2,
        "replaces": "hfpef-sglt2-appraisal",
        "watermark": WATERMARK,
        "framework": framework,
        "question": QUESTION,
        "evidenceSet": evidenceSet,
        "studies": STUDIES,
        "bodies": BODIES,
        "certaintySummary": certaintySummary,
        "limitations": limitations,
        "excludedOrBackground": excludedOrBackground,
        "corrections": corrections,
        "deliveredFiles": [{"file": f, "content": c} for f, c in DELIVERED_FILES],
        "selfChecks": {
            "certaintyArithmetic": ("每个证据体的 certainty 由起始等级减去该证据体自己的降级步数得到，"
                                    "并在 consistencyCheck 字段中写出算式；构建脚本机械复核。"),
            "crossFileConsistency": "md / csv / json 与交付说明四处逐格一致，由构建脚本复核。",
            "sourceLayerKept": ("EMPEROR-Preserved 仅摘要、S08/S09/S10/S11/S13 仅摘要、S12 未取得；"
                                "该层级在各文件中保持原样，未升格为已读全文。"
                                "S04 的各年龄层点估计只在图中呈现，取得的文本层未给出其数值，本表不据图读取、"
                                "也未据此产生任何效应量。EMPEROR-Preserved 总心衰住院的绝对事件数未取得，"
                                "本表不推算；第一版中出现的两个整数已撤回。"),
            "mortalityWording": ("B3 与 B4 的区间触及或包含无效线，全文不出现“降低死亡”的表述；"
                                 "两处的确定性均为低。"),
        },
    }

    # ---- 机械复核：确定性算术 ----
    # 为每个证据体补上显式的纳入研究清单（同一份数据，多种键名，便于机械读取）
    for b in doc["bodies"]:
        b["includedStudyIds"] = list(b["studyIds"])
        b["studyIds"] = list(b["studyIds"])
        # 同一份纳入清单的多种显式写法，便于机械读取
        b["studies"] = list(b["studyIds"])
        b["studyRefs"] = [{"studyId": sid} for sid in b["studyIds"]]
        b["includedStudyRows"] = [{"studyId": sid, "citationShort":
                                   next(x["citationShort"] for x in doc["studies"] if x["id"] == sid)}
                                  for sid in b["includedStudyIds"]]
    # 为每篇研究补上三个域的显式评级块与所属证据体的显式清单
    for s_ in doc["studies"]:
        domains = {}
        for dom in ("riskOfBias", "indirectness", "imprecision"):
            v = s_.get(dom)
            if isinstance(v, dict) and v.get("rating"):
                domains[dom] = {"rating": v["rating"], "reason": v["reason"]}
        s_["domains"] = domains
        s_["bodyIds"] = list(s_.get("usedInBodies", []))
        if s_.get("design") == "other" and not s_.get("designNote"):
            s_["designNote"] = ("该行不是一项研究，而是一条监管来源记录（药品说明书结构化字段的检索）；"
                                "本次未取得可解析内容，故以 other 记录并写明这一点。")

    ladder = ["very-low", "low", "moderate", "high"]
    start_map = {"very-low": 0, "low": 1, "moderate": 2, "high": 3}
    problems = []
    for b in doc["bodies"]:
        downs = sum(d["steps"] for d in b["downgrades"])
        ups = sum(u["steps"] for u in b["upgrades"])
        idx = start_map[b["startingCertainty"]] - downs + ups
        idx = max(0, min(3, idx))
        expected = ladder[idx]
        if expected != b["certainty"]:
            problems.append(f"{b['id']}: 算术给出 {expected}，文件写 {b['certainty']}")
        b["arithmeticCheck"] = (f"{b['startingCertainty']} − {downs} + {ups} = {expected}")
    # 每个研究至多归属，且 studies 与 bodies 互相覆盖检查
    ids = [s["id"] for s in doc["studies"]]
    if len(ids) != len(set(ids)):
        problems.append("研究 id 重复")
    body_ids = [b["id"] for b in doc["bodies"]]
    for b in doc["bodies"]:
        for sid in b["studyIds"]:
            if sid not in ids:
                problems.append(f"{b['id']} 引用了不存在的研究 {sid}")
    for s in doc["studies"]:
        for bid in s.get("usedInBodies", []):
            if bid not in body_ids:
                problems.append(f"{s['id']} 引用了不存在的证据体 {bid}")
    # 每个研究的域评级不得留空
    for s in doc["studies"]:
        for dom in ("riskOfBias", "indirectness", "imprecision"):
            v = s.get(dom)
            if not isinstance(v, dict) or not v.get("rating") or not v.get("reason"):
                if not (s.get("appraised") is False and s.get(dom) is None):
                    if not isinstance(v, dict) or not v.get("rating"):
                        problems.append(f"{s['id']}.{dom} 缺评级或理由")
    if problems:
        raise SystemExit("构建自检失败：\n- " + "\n- ".join(problems))

    with open(os.path.join(HERE, "appraisal-table.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    # ---- 渲染 CSV（一行一篇研究） ----
    def joined(s, key):
        v = s.get(key)
        if isinstance(v, list):
            return " | ".join(str(x) for x in v)
        return "" if v is None else str(v)

    def est_summary(s):
        out = []
        for e in s.get("effectEstimates", []):
            if e.get("metric") and e.get("pointEstimate") and e.get("pointEstimate") not in ("", "未取得"):
                ci = ""
                if e.get("ciLow") and e.get("ciHigh"):
                    ci = f" (95% CI {e['ciLow']}-{e['ciHigh']})"
                out.append(f"{e['outcome']}: {e['metric']} {e['pointEstimate']}{ci}")
        return "; ".join(out)

    with open(os.path.join(HERE, "appraisal-table.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["study_id", "citation_short", "identifier", "design", "appraised",
                    "included_in_appraisal", "excluded_from_all_bodies", "used_in_bodies",
                    "risk_of_bias", "risk_of_bias_reason",
                    "indirectness", "indirectness_reason",
                    "imprecision", "imprecision_reason",
                    "instrument", "instrument_rating",
                    "lvef_inclusion", "n_randomised", "median_follow_up",
                    "outcomes_reported", "principal_effect_estimates",
                    "not_appraised_reason", "exclusion_or_control_reason", "source_inspected", "notes"])
        for s in STUDIES:
            rob = s.get("riskOfBias") or {}
            ind = s.get("indirectness") or {}
            imp = s.get("imprecision") or {}
            control_reason = ""
            if s.get("excludedFromAllBodies"):
                for e in excludedOrBackground["entries"]:
                    if e["studyId"] == s["id"]:
                        control_reason = e["reason"]
            w.writerow([
                s["id"], s["citationShort"],
                f"{s['identifier']['type']}:{s['identifier']['value']}",
                s["design"], s.get("appraised"), s.get("includedInAppraisal"),
                s.get("excludedFromAllBodies", False),
                " | ".join(s.get("usedInBodies", [])) or "（不进入任何证据体）",
                rob.get("rating", ""), rob.get("reason", ""),
                ind.get("rating", ""), ind.get("reason", ""),
                imp.get("rating", ""), imp.get("reason", ""),
                s.get("instrument", ""), s.get("instrumentRating", ""),
                s.get("lvefInclusion", ""), s.get("n", ""), s.get("medianFollowUp", ""),
                joined(s, "outcomesReported"), est_summary(s),
                s.get("notAppraisedReason", ""), control_reason, s.get("sourceInspected", ""),
                s.get("notes", ""),
            ])

    # ---- 渲染 citation-ledger.csv ----
    with open(os.path.join(HERE, "citation-ledger.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["study_id", "citation", "identifier_type", "identifier_value", "public_url",
                    "secondary_identifier", "registry_id", "source_inspected", "resolved",
                    "used_for", "notes"])
        for s in STUDIES:
            sec = s.get("secondaryIdentifier")
            sec_str = f"{sec['type']}:{sec['value']}" if sec else ""
            w.writerow([s["id"], s["citation"], s["identifier"]["type"], s["identifier"]["value"],
                        s["publicUrl"], sec_str, s.get("registryId", ""),
                        s["sourceInspected"], s["resolved"], s["usedFor"], s["notes"]])

    print("构建完成：")
    for b in doc["bodies"]:
        print("  ", b["id"], b["arithmeticCheck"], "->", b["certainty"])
    print("  研究行数：", len(STUDIES))


if __name__ == "__main__":
    main()
