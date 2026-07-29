# aspirin — FAERS 药物安全性分析报告

**生成时间**:2026-07-22 15:36 UTC  
**分析工具**:EviMed 药品安全性专项 Agent(safety_agent)  
**数据源**:FAERS,经 openFDA live API 访问  
**分析指标**:ROR、PRR、χ²、IC/IC025(BCPNN)、EBGM/EB05(GPS)  
**信号判定规则**:a≥3 且(ROR 95%CI 下限>1 或(PRR≥2 且 χ²≥4))  

---

## 1. 分析概览

- **目标药品**:aspirin(原始输入:aspirin)
- **目标 ADR**:gastrointestinal haemorrhage
- **FAERS 报告总数(该药)**:550,567 份
- **药品角色口径**:PS、SS
- **药名/角色绑定**:report_contains_suspect_approximation
- **统计版本**:gps-v2;GPS prior=unfitted-starting-prior
- **信号筛查范围**:11 个 PT,其中 9 个满足信号判定规则

本报告基于FAERS数据库中阿司匹林相关不良事件报告进行分析。截至2026年，累计报告550567份，年报告量从2004年的9751份增长至2025年的31851份，2026年截至数据提取日共6831份，整体呈上升趋势。通过失比例分析，共检出多个信号，包括胃肠道出血、跌倒、乏力、呼吸困难等，其中胃肠道出血信号最强。

## 2. 输入归一

| 环节 | 输入 | 归一结果 | 方法 | 置信度 |
|---|---|---|---|---|
| 药品 | aspirin | aspirin | 规则+openFDA(候选:aspirin) | — |
| ADR | gastrointestinal hemorrhage | gastrointestinal haemorrhage | en-alias | 1.00 |

## 3. 病例概览(FAERS)

该药在 FAERS 中共有 **550,567** 份报告。

### 3.1 年度趋势

| 年份 | 报告数 |
|---|---|
| 2004 | 9,751 |
| 2005 | 12,092 |
| 2006 | 12,590 |
| 2007 | 10,324 |
| 2008 | 11,659 |
| 2009 | 17,637 |
| 2010 | 19,819 |
| 2011 | 23,481 |
| 2012 | 25,996 |
| 2013 | 17,337 |
| 2014 | 30,814 |
| 2015 | 32,926 |
| 2016 | 35,528 |
| 2017 | 33,931 |
| 2018 | 33,926 |
| 2019 | 29,182 |
| 2020 | 24,983 |
| 2021 | 30,244 |
| 2022 | 35,522 |
| 2023 | 31,610 |
| 2024 | 32,523 |
| 2025 | 31,851 |
| 2026 | 6,831 |

### 3.2 性别与年龄分布

**性别**:

| 性别 | 报告数 |
|---|---|
| female | 255,801 |
| male | 254,727 |
| not reported | 40,039 |

**年龄段**(live 按 patientonsetageunit 800–805 换算为年;十年代编码近似归类;冻结快照使用 age_years):

| 年龄段 | 报告数 |
|---|---|
| <18 | 4,048 |
| 18-44 | 22,590 |
| 45-64 | 118,785 |
| 65-74 | 113,149 |
| 75+ | 113,076 |
| not reported | 178,919 |

在已知性别的报告中，女性255801例，男性254727例，性别分布大致均衡。年龄分布显示，45-64岁组报告最多，为118785例，65-74岁组113149例，75岁及以上组113076例，18-44岁组22590例，18岁以下4048例，另有178919例年龄未报告。

### 3.3 结局分布(严重结局计数,同一报告可计入多类)

| 结局 | 报告数 |
|---|---|
| death (死亡) | 49,092 |
| life-threatening (危及生命) | 24,995 |
| hospitalization (住院) | 208,319 |
| disability (致残) | 16,010 |
| congenital anomaly (先天异常) | 1,113 |
| other serious (其他严重) | 228,255 |

按严重结局统计，报告死亡49092例，危及生命24995例，住院208319例，致残16010例，先天异常1113例，其他严重医学事件228255例。需注意同一报告可能包含多个结局。

### 3.4 报告国别(top 10)

| 国别代码 | 报告数 |
|---|---|
| US | 288,478 |
| CA | 19,181 |
| GB | 19,063 |
| DE | 15,160 |
| JP | 5,249 |
| IT | 4,286 |
| CN | 3,773 |
| EU | 3,709 |
| AU | 3,384 |
| FR | 3,174 |
| not reported | 158,368 |

### 3.5 合并用药(top 10,已剔除目标药本身)

| 药品 | 报告数 |
|---|---|
| ATORVASTATIN | 57,186 |
| REVLIMID | 44,750 |
| AMLODIPINE | 40,597 |
| METFORMIN | 38,624 |
| PLAVIX | 38,514 |
| VITAMIN D3 | 36,503 |
| LIPITOR | 35,308 |
| LISINOPRIL | 30,399 |
| OMEPRAZOLE | 29,297 |
| VITAMIN D | 29,185 |

### 3.6 适应症(top 10)

| 适应症 | 报告数 |
|---|---|
| PRODUCT USED FOR UNKNOWN INDICATION | 136,021 |
| Product used for unknown indication | 88,590 |
| HYPERTENSION | 39,394 |
| PLASMA CELL MYELOMA | 36,273 |
| DIABETES MELLITUS | 24,180 |
| ATRIAL FIBRILLATION | 20,237 |
| PAIN | 19,518 |
| BLOOD CHOLESTEROL INCREASED | 18,108 |
| Plasma cell myeloma | 15,704 |
| GASTROOESOPHAGEAL REFLUX DISEASE | 15,380 |

## 4. 失比例信号分析

2×2 列联表定义:a=目标药且目标 ADR 的报告数,b=目标药其他 ADR,c=其他药目标 ADR,d=其他药其他 ADR(d=N−a−b−c,N 为 FAERS 全库)。任一单元格为 0 时按 Haldane-Anscombe 法(+0.5)校正并在 CSV 中标记。

| ADR (PT) | 来源 | a | ROR [95%CI] | PRR [95%CI] | χ² | IC (IC025) | EBGM (EB05) | 信号 |
|---|---|---|---|---|---|---|---|---|
| gastrointestinal haemorrhage | 指定 | 18,195 | 7.726 [7.602, 7.852] | 7.504 [7.386, 7.623] | 85282.229 | 2.674 (2.651) | 6.379 (6.302) | **是** |
| fatigue | top | 33,713 | 1.714 [1.695, 1.733] | 1.670 [1.653, 1.688] | 8999.328 | 0.714 (0.698) | 1.640 (1.626) | **是** |
| dyspnoea | top | 30,527 | 2.062 [2.037, 2.086] | 2.003 [1.981, 2.025] | 14945.273 | 0.963 (0.946) | 1.950 (1.932) | **是** |
| nausea | top | 28,375 | 1.405 [1.388, 1.423] | 1.384 [1.369, 1.401] | 3031.254 | 0.454 (0.437) | 1.370 (1.357) | **是** |
| diarrhoea | top | 27,911 | 1.699 [1.678, 1.720] | 1.664 [1.644, 1.683] | 7287.773 | 0.709 (0.691) | 1.634 (1.618) | **是** |
| drug ineffective | top | 27,715 | 0.751 [0.742, 0.760] | 0.764 [0.755, 0.773] | 2125.200 | -0.380 (-0.397) | 0.768 (0.761) | 否 |
| dizziness | top | 24,112 | 1.893 [1.868, 1.918] | 1.854 [1.830, 1.877] | 9239.789 | 0.858 (0.839) | 1.812 (1.793) | **是** |
| headache | top | 21,918 | 1.332 [1.313, 1.350] | 1.318 [1.301, 1.336] | 1676.663 | 0.386 (0.367) | 1.307 (1.292) | **是** |
| off label use | top | 19,894 | 0.870 [0.858, 0.883] | 0.875 [0.863, 0.887] | 362.083 | -0.188 (-0.208) | 0.878 (0.868) | 否 |
| asthenia | top | 19,514 | 2.064 [2.034, 2.095] | 2.027 [1.998, 2.056] | 9783.220 | 0.980 (0.959) | 1.972 (1.949) | **是** |
| fall | top | 19,275 | 2.327 [2.293, 2.362] | 2.280 [2.248, 2.313] | 13239.554 | 1.140 (1.119) | 2.204 (2.178) | **是** |

全精度数值见同目录 signals.csv(与本表同源)。信号≠因果,详见第 8 节局限性声明。

### 4.1 信号解读

采用频数法与贝叶斯法进行失比例信号筛查。胃肠道出血信号最为突出，报告数18195例，ROR=7.726（95%CI 7.602-7.852），PRR=7.504，IC=2.674，EBGM=6.379。跌倒信号报告19275例，ROR=2.327（2.293-2.362），PRR=2.280，IC=1.140，EBGM=2.204。乏力信号报告19514例，ROR=2.064（2.034-2.095），PRR=2.027，IC=0.980，EBGM=1.972。呼吸困难信号报告30527例，ROR=2.062（2.037-2.086），PRR=2.003，IC=0.963，EBGM=1.950。头晕信号报告24112例，ROR=1.893（1.868-1.918），PRR=1.854，IC=0.858，EBGM=1.812。疲劳信号报告33713例，ROR=1.714（1.695-1.733），PRR=1.670，IC=0.714，EBGM=1.640。以上信号均满足信号检测标准。

## 5. 重点 ADR 解读

### 5.1 gastrointestinal haemorrhage

胃肠道出血报告18195例，ROR 7.726（95%CI 7.602-7.852），PRR 7.504，IC 2.674，EBGM 6.379，信号强度在所有信号中最高。

### 5.2 fall

跌倒报告19275例，ROR 2.327（95%CI 2.293-2.362），PRR 2.280，IC 1.140，EBGM 2.204。

### 5.3 asthenia

乏力（asthenia）报告19514例，ROR 2.064（95%CI 2.034-2.095），PRR 2.027，IC 0.980，EBGM 1.972。

### 5.4 dyspnoea

呼吸困难报告30527例，ROR 2.062（95%CI 2.037-2.086），PRR 2.003，IC 0.963，EBGM 1.950。

### 5.5 dizziness

头晕报告24112例，ROR 1.893（95%CI 1.868-1.918），PRR 1.854，IC 0.858，EBGM 1.812。

### 5.6 fatigue

疲劳报告33713例，ROR 1.714（95%CI 1.695-1.733），PRR 1.670，IC 0.714，EBGM 1.640。

## 6. 说明书对照(FDA label)

| ADR (PT) | 标注状态 | 证据(原文引用,章节) |
|---|---|---|
| gastrointestinal haemorrhage | 已标注 | “Stomach bleeding warning: This product contains an NSAID, which may cause severe stomach bleeding.”(warnings) |

对照用说明书记录:0058175f-3474-40c3-a046-6cfaec86d84b (Low Dose Aspirin);00d9ab0d-ff25-784f-e063-6294a90a8497 (Rapidol Aspirin)

对照说明:说明书原文过长,对照基于各章节开头+目标 ADR 命中窗口的节选文本,「未标注」结论可能受截断影响。

对胃肠道出血进行说明书对照，在该产品警告章节中查见“胃出血警告：本品含有非甾体抗炎药，可能导致严重胃出血”的描述，提示该反应已标注。其余信号未进行说明书对照。

## 7. 循证证据检索(EviMed)

| 标题 | 机构 | 年份 | 链接 |
|---|---|---|---|
| 阿司匹林抗栓治疗临床手册 | 中国老年学学会心脑血管病专业委员会 | — | — |
| 阿司匹林在川崎病治疗中的儿科专家共识 | 陕西省川崎病诊疗中心/陕西省人民医院儿童病院 | — | — |
| 规范应用阿司匹林治疗缺血性脑血管病的专家共识 | 缺血性脑血管病阿司匹林规范应用共识专家组 | — | — |
| 2006 中国规范应用阿司匹林治疗缺血性脑血管病的专家共识 | 中华内科杂志编委会 | — | — |
| 2019 阿司匹林在心血管疾病一级预防中的应用中国专家共识 | 2019 阿司匹林在心血管疾病一级预防中的应用中国专家共识写作组 | — | — |

检索到 5 条指南/证据记录。

## 8. 局限性声明

1. 本报告为自发报告数据库(FAERS)的失比例信号**筛查**结果;信号不等于因果关系,不能据此判定该药导致某不良反应。
2. FAERS 报告数**不能用于推算不良反应发生率**;数据库存在漏报、重复报告、适应证偏倚(protopathic bias)与媒体驱动报告(Weber 效应)等已知偏倚。
3. FAERS 由美国 FDA 管理但包含全球来源的自发报告;本分析不含 WHO VigiBase 与中国国家药品不良反应监测数据库。
4. live 年龄分布按 patientonsetageunit(800–805)统一换算为年;其中十年代编码只能近似归类。冻结快照使用已规范化的 age_years。
5. LLM 仅用于文字解读与说明书对照,不参与任何数值计算。
6. openFDA live 聚合无法把目标药名与 suspect 角色绑定到同一 patient.drug[] 元素;当前队列是报告级近似,不得解释为 PS-only。
7. 2×2 单元格来自可变的 live count 查询;数据库更新后数值可能漂移。
8. EBGM/EB05 使用未拟合的 GPS 优化起始先验(α1=0.2,β1=0.1,α2=2,β2=4,w=1/3);数值仅供探索,不能标作已完成全矩阵经验贝叶斯拟合。

**本次运行的降级与未启用项**:

- openFDA live 聚合仅表示报告同时含目标药和 suspect 药,无法保证二者属于同一 drug 对象;该口径为报告级近似,不是 PS-only。

## 附录:数据来源与可追溯查询

| 用途 | URL |
|---|---|
| 目标药报告总数 | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.openfda.generic_name%3A%22aspirin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29` |
| FAERS 全库总数(N) | `https://api.fda.gov/drug/event.json?limit=1` |
| 目标药 PT 频数(top 筛查) | `https://api.fda.gov/drug/event.json?limit=100&count=patient.reaction.reactionmeddrapt.exact&search=%28patient.drug.openfda.generic_name%3A%22aspirin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29` |
| 说明书检索 | `https://api.fda.gov/drug/label.json?limit=2&search=%28openfda.generic_name%3A%22aspirin%22%20OR%20openfda.brand_name%3A%22aspirin%22%29` |
| 2×2·联合计数[gastrointestinal haemorrhage] | `https://api.fda.gov/drug/event.json?limit=1&search=%28%28patient.drug.openfda.generic_name%3A%22aspirin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22gastrointestinal%20haemorrhage%22%29` |
| 2×2·事件计数[gastrointestinal haemorrhage] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22gastrointestinal%20haemorrhage%22` |

检索日期:2026-07-22

---

*本报告由 EviMed 药品安全性专项 Agent(safety_agent) 自动生成。定量结果由确定性统计路径产生;live 结果按附录查询复核,冻结结果按快照来源与哈希复核;LLM 不参与数值计算。*
