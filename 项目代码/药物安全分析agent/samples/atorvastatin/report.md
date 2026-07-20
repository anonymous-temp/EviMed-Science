# atorvastatin — FAERS 药物安全性分析报告

**生成时间**:2026-07-20 01:37 UTC
**分析工具**:EviMed 药品安全性专项 Agent(safety_agent)
**数据源**:FDA Adverse Event Reporting System (FAERS),经 openFDA API 访问
**分析指标**:ROR、PRR、χ²、IC/IC025(BCPNN)、EBGM/EB05(MGPS)
**信号判定规则**:a≥3 且(ROR 95%CI 下限>1 或(PRR≥2 且 χ²≥4))

---

## 1. 分析概览

- **目标药品**:atorvastatin(原始输入:atorvastatin)
- **目标 ADR**:myalgia、myopathy、rhabdomyolysis
- **FAERS 报告总数(该药)**:334,759 份
- **信号筛查范围**:13 个 PT,其中 11 个满足信号判定规则

阿托伐他汀在FAERS数据库中总报告数为334759份。报告数量整体呈上升趋势，2004年报告数为1955份，2025年达32169份，2026年报告数为7488份（可能为部分数据）。

## 2. 输入归一

| 环节 | 输入 | 归一结果 | 方法 | 置信度 |
|---|---|---|---|---|
| 药品 | atorvastatin | atorvastatin | 规则+openFDA(候选:atorvastatin) | — |
| ADR | myalgia | myalgia | pt-direct | 1.00 |
| ADR | myopathy | myopathy | pt-direct | 1.00 |
| ADR | rhabdomyolysis | rhabdomyolysis | pt-direct | 1.00 |

## 3. 病例概览(FAERS)

该药在 FAERS 中共有 **334,759** 份报告。

### 3.1 年度趋势

| 年份 | 报告数 |
|---|---|
| 2004 | 1,955 |
| 2005 | 2,292 |
| 2006 | 1,883 |
| 2007 | 1,630 |
| 2008 | 1,826 |
| 2009 | 1,839 |
| 2010 | 1,619 |
| 2011 | 2,757 |
| 2012 | 5,072 |
| 2013 | 6,878 |
| 2014 | 9,684 |
| 2015 | 14,862 |
| 2016 | 19,121 |
| 2017 | 21,239 |
| 2018 | 27,242 |
| 2019 | 30,626 |
| 2020 | 30,425 |
| 2021 | 27,918 |
| 2022 | 28,181 |
| 2023 | 28,589 |
| 2024 | 29,461 |
| 2025 | 32,169 |
| 2026 | 7,488 |

### 3.2 性别与年龄分布

**性别**:

| 性别 | 报告数 |
|---|---|
| male | 157,972 |
| female | 148,884 |
| not reported | 386 |

**年龄段**(按 patientonsetage 原始数值,未区分单位,为近似分布):

| 年龄段 | 报告数 |
|---|---|
| <18 | 1,185 |
| 18-44 | 9,924 |
| 45-64 | 79,879 |
| 65-74 | 77,522 |
| 75+ | 73,766 |

性别分布：男性157972例，女性148884例，未报告386例。年龄分布：<18岁1185例，18-44岁9924例，45-64岁79879例，65-74岁77522例，75岁以上73766例。国家分布：美国164492例，英国40265例，加拿大16550例，法国11936例，德国11553例。

### 3.3 结局分布(严重结局计数,同一报告可计入多类)

| 结局 | 报告数 |
|---|---|
| death (死亡) | 27,531 |
| life-threatening (危及生命) | 16,986 |
| hospitalization (住院) | 125,118 |
| disability (致残) | 12,339 |
| congenital anomaly (先天异常) | 233 |
| other serious (其他严重) | 157,525 |

结局报告数：死亡27531例，危及生命16986例，住院125118例，致残12339例，先天异常233例，其他严重157525例。

### 3.4 报告国别(top 10)

| 国别代码 | 报告数 |
|---|---|
| US | 164,492 |
| GB | 40,265 |
| CA | 16,550 |
| FR | 11,936 |
| DE | 11,553 |
| IT | 6,273 |
| EU | 4,593 |
| ES | 4,506 |
| JP | 4,341 |
| AU | 3,078 |

### 3.5 合并用药(top 10,已剔除目标药本身)

| 药品 | 报告数 |
|---|---|
| ASPIRIN | 46,262 |
| AMLODIPINE | 41,982 |
| METFORMIN | 41,732 |
| PANTOPRAZOLE | 27,423 |
| ASPIRIN. | 25,997 |
| CLOPIDOGREL | 24,844 |
| BISOPROLOL | 22,659 |
| VITAMIN D3 | 21,126 |
| LISINOPRIL. | 21,009 |
| OMEPRAZOLE. | 20,461 |

### 3.6 适应症(top 10)

| 适应症 | 报告数 |
|---|---|
| PRODUCT USED FOR UNKNOWN INDICATION | 81,928 |
| Product used for unknown indication | 72,467 |
| HYPERTENSION | 25,087 |
| Hypertension | 15,060 |
| BLOOD CHOLESTEROL INCREASED | 13,958 |
| DIABETES MELLITUS | 10,431 |
| PLASMA CELL MYELOMA | 9,731 |
| GASTROOESOPHAGEAL REFLUX DISEASE | 8,753 |
| PAIN | 8,748 |
| RHEUMATOID ARTHRITIS | 8,433 |

## 4. 失比例信号分析

2×2 列联表定义:a=目标药且目标 ADR 的报告数,b=目标药其他 ADR,c=其他药目标 ADR,d=其他药其他 ADR(d=N−a−b−c,N 为 FAERS 全库)。任一单元格为 0 时按 Haldane-Anscombe 法(+0.5)校正并在 CSV 中标记。

| ADR (PT) | 来源 | a | ROR [95%CI] | PRR [95%CI] | χ² | IC (IC025) | EBGM (EB05) | 信号 |
|---|---|---|---|---|---|---|---|---|
| myalgia | 指定 | 9,448 | 3.697 [3.620, 3.775] | 3.620 [3.547, 3.695] | 17034.021 | 1.795 (1.765) | 3.471 (3.412) | **是** |
| rhabdomyolysis | 指定 | 4,215 | 7.020 [6.799, 7.249] | 6.945 [6.728, 7.168] | 19252.290 | 2.661 (2.615) | 6.325 (6.165) | **是** |
| myopathy | 指定 | 1,980 | 14.859 [14.144, 15.610] | 14.777 [14.069, 15.520] | 20397.705 | 3.590 (3.521) | 12.038 (11.597) | **是** |
| fatigue | top | 19,833 | 1.641 [1.617, 1.665] | 1.603 [1.581, 1.625] | 4549.900 | 0.666 (0.646) | 1.587 (1.568) | **是** |
| dyspnoea | top | 17,799 | 1.948 [1.918, 1.978] | 1.897 [1.870, 1.925] | 7537.257 | 0.903 (0.881) | 1.870 (1.847) | **是** |
| diarrhoea | top | 17,796 | 1.776 [1.749, 1.803] | 1.734 [1.709, 1.760] | 5550.892 | 0.777 (0.755) | 1.713 (1.692) | **是** |
| nausea | top | 16,424 | 1.327 [1.306, 1.348] | 1.311 [1.291, 1.331] | 1232.457 | 0.383 (0.361) | 1.304 (1.287) | **是** |
| drug ineffective | top | 15,858 | 0.706 [0.695, 0.717] | 0.720 [0.709, 0.731] | 1827.600 | -0.467 (-0.490) | 0.723 (0.714) | 否 |
| dizziness | top | 13,986 | 1.783 [1.752, 1.813] | 1.750 [1.721, 1.779] | 4474.082 | 0.790 (0.765) | 1.728 (1.704) | **是** |
| off label use | top | 13,157 | 0.952 [0.936, 0.969] | 0.954 [0.938, 0.970] | 29.703 | -0.067 (-0.092) | 0.955 (0.941) | 否 |
| headache | top | 12,324 | 1.221 [1.199, 1.244] | 1.213 [1.192, 1.234] | 465.917 | 0.274 (0.247) | 1.209 (1.191) | **是** |
| fall | top | 11,131 | 2.171 [2.130, 2.213] | 2.132 [2.093, 2.172] | 6565.428 | 1.066 (1.038) | 2.093 (2.060) | **是** |
| asthenia | top | 11,090 | 1.899 [1.863, 1.936] | 1.870 [1.835, 1.905] | 4428.446 | 0.882 (0.855) | 1.843 (1.814) | **是** |

全精度数值见同目录 signals.csv(与本表同源)。信号≠因果,详见第 8 节局限性声明。

### 4.1 信号解读

信号筛查显示，肌肉相关不良反应信号强度突出：肌痛报告数9448，ROR 3.697，PRR 3.620，EBGM 3.471；横纹肌溶解报告数4215，ROR 7.020，PRR 6.945，EBGM 6.325；肌病报告数1980，ROR 14.859，PRR 14.777，EBGM 12.038。其他产生信号的反应包括疲劳、呼吸困难、腹泻、恶心、头晕、跌倒、无力、头痛等，其中跌倒报告数11131，ROR 2.171；呼吸困难报告数17799，ROR 1.948。未发现信号的为药物无效和超说明书使用。

## 5. 重点 ADR 解读

### 5.1 myalgia

肌痛报告数为9448，ROR为3.697，PRR为3.620，EBGM为3.471，IC为1.795，信号阳性。

### 5.2 myopathy

肌病报告数为1980，ROR为14.859，PRR为14.777，EBGM为12.038，IC为3.590，信号阳性。

### 5.3 rhabdomyolysis

横纹肌溶解报告数为4215，ROR为7.020，PRR为6.945，EBGM为6.325，IC为2.661，信号阳性。

### 5.4 fall

跌倒报告数为11131，ROR为2.171，PRR为2.132，EBGM为2.093，IC为1.066，信号阳性。

### 5.5 dyspnoea

呼吸困难报告数为17799，ROR为1.948，PRR为1.897，EBGM为1.870，IC为0.903，信号阳性。

### 5.6 asthenia

无力报告数为11090，ROR为1.899，PRR为1.870，EBGM为1.843，IC为0.882，信号阳性。

### 5.7 dizziness

头晕报告数为13986，ROR为1.783，PRR为1.750，EBGM为1.728，IC为0.790，信号阳性。

### 5.8 diarrhoea

腹泻报告数为17796，ROR为1.776，PRR为1.734，EBGM为1.713，IC为0.777，信号阳性。

## 6. 说明书对照(FDA label)

| ADR (PT) | 标注状态 | 证据(原文引用,章节) |
|---|---|---|
| myalgia | 已标注 | “The most common adverse reactions in patients treated with atorvastatin calcium that led to treatment discontinuation and occurred at a rate greater than placebo were: myalgia (0.7%), diarrhea (0.5%), nausea (0.4%), alanine aminotransferase increase (0.4%), and hepatic enzyme increase (0.4%).”(adverse_reactions)<br>“Myalgia 3.1 3.6 5.9 8.4 2.7 3.5”(adverse_reactions) |
| myopathy | 已标注 | “Atorvastatin calcium may cause myopathy (muscle pain, tenderness, or weakness associated with elevated creatine kinase [CK]) and rhabdomyolysis.”(warnings_and_cautions)<br>“Risk factors for myopathy include age 65 years or greater, uncontrolled hypothyroidism, renal impairment, concomitant use with certain other drugs (including other lipid-lowering therapies), and higher atorvastatin dosage [see Drug Interactions (7.”(warnings_and_cautions) |
| rhabdomyolysis | 已标注 | “Atorvastatin calcium may cause myopathy (muscle pain, tenderness, or weakness associated with elevated creatine kinase [CK]) and rhabdomyolysis.”(warnings_and_cautions)<br>“Acute kidney injury secondary to myoglobinuria and rare fatalities have occurred as a result of rhabdomyolysis in patients treated with statins, including atorvastatin.”(warnings_and_cautions) |

对照用说明书记录:00afce9b-48c9-487a-a738-e359c005c707 (Atorvastatin calcium);01eadde8-37f3-4474-995f-22c1a65adf12 (Atorvastatin calcium)

对照说明:说明书原文过长,对照基于各章节开头+目标 ADR 命中窗口的节选文本,「未标注」结论可能受截断影响。

说明书对照显示，肌痛、肌病、横纹肌溶解已在说明书中标注。其他关注反应在对照数据中未直接标注（注：说明书原文过长，对照基于节选文本，可能受截断影响）。

## 7. 循证证据检索(EviMed)

未配置 EVIMED_EVIDENCE_SEARCH_URL/EVIMED_EVIDENCE_SEARCH_KEY,循证证据检索层未启用。

## 8. 局限性声明

1. 本报告为自发报告数据库(FAERS)的失比例信号**筛查**结果;信号不等于因果关系,不能据此判定该药导致某不良反应。
2. FAERS 报告数**不能用于推算不良反应发生率**;数据库存在漏报、重复报告、适应证偏倚(protopathic bias)与媒体驱动报告(Weber 效应)等已知偏倚。
3. openFDA 仅覆盖美国 FAERS 数据,不含 WHO VigiBase 与中国国家药品不良反应监测数据;结论的外推性有限。
4. 2×2 单元格计数来自 openFDA count 查询,与逐例病例清单口径不同;年龄分布按 patientonsetage 原始数值分桶,未区分年龄单位,仅为近似。
5. EBGM/EB05 采用 DuMouchel(1999)双伽马混合先验的文献通用默认超参(α1=0.2, β1=0.1, α2=2.0, β2=4.0, w=0.2),未对全库做 MLE 重估。
6. LLM 仅用于文字解读与说明书对照,不参与任何数值计算;报告中的全部数字均可经附录中的 openFDA 查询复现。

**本次运行的降级与未启用项**:

- 未配置 EVIMED_EVIDENCE_SEARCH_URL/EVIMED_EVIDENCE_SEARCH_KEY,循证证据检索层未启用。

## 附录:数据来源与可追溯查询

| 用途 | URL |
|---|---|
| 目标药报告总数 | `https://api.fda.gov/drug/event.json?limit=1&search=patient.drug.medicinalproduct%3A%22atorvastatin%22` |
| FAERS 全库总数(N) | `https://api.fda.gov/drug/event.json?limit=1` |
| 目标药 PT 频数(top 筛查) | `https://api.fda.gov/drug/event.json?limit=100&count=patient.reaction.reactionmeddrapt.exact&search=patient.drug.medicinalproduct%3A%22atorvastatin%22` |
| 说明书检索 | `https://api.fda.gov/drug/label.json?limit=2&search=%28openfda.generic_name%3A%22atorvastatin%22%20OR%20openfda.brand_name%3A%22atorvastatin%22%29` |
| 2×2·联合计数[myalgia] | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.medicinalproduct%3A%22atorvastatin%22%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22myalgia%22%29` |
| 2×2·事件计数[myalgia] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22myalgia%22` |
| 2×2·联合计数[myopathy] | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.medicinalproduct%3A%22atorvastatin%22%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22myopathy%22%29` |
| 2×2·事件计数[myopathy] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22myopathy%22` |
| 2×2·联合计数[rhabdomyolysis] | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.medicinalproduct%3A%22atorvastatin%22%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22rhabdomyolysis%22%29` |
| 2×2·事件计数[rhabdomyolysis] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22rhabdomyolysis%22` |

检索日期:2026-07-20

---

*本报告由 EviMed 药品安全性专项 Agent(safety_agent) 自动生成。所有定量结果可经附录中的 openFDA 查询复现;LLM 不参与任何数值计算。*
