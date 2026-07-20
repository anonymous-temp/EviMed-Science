# rituximab — FAERS 药物安全性分析报告

**生成时间**:2026-07-20 01:37 UTC
**分析工具**:EviMed 药品安全性专项 Agent(safety_agent)
**数据源**:FDA Adverse Event Reporting System (FAERS),经 openFDA API 访问
**分析指标**:ROR、PRR、χ²、IC/IC025(BCPNN)、EBGM/EB05(MGPS)
**信号判定规则**:a≥3 且(ROR 95%CI 下限>1 或(PRR≥2 且 χ²≥4))

---

## 1. 分析概览

- **目标药品**:rituximab(原始输入:rituximab)
- **目标 ADR**:pneumonia
- **FAERS 报告总数(该药)**:173,358 份
- **信号筛查范围**:11 个 PT,其中 11 个满足信号判定规则

利妥昔单抗在FAERS中累计报告数为173,358例，年度报告数从2004年的356例增至2020年的21,622例，随后在2021-2025年间维持在约17,000-20,000例水平，提示关注度持续较高。

## 2. 输入归一

| 环节 | 输入 | 归一结果 | 方法 | 置信度 |
|---|---|---|---|---|
| 药品 | rituximab | rituximab | 规则+openFDA(候选:rituximab) | — |
| ADR | pneumonia | pneumonia | pt-direct | 1.00 |

## 3. 病例概览(FAERS)

该药在 FAERS 中共有 **173,358** 份报告。

### 3.1 年度趋势

| 年份 | 报告数 |
|---|---|
| 2004 | 356 |
| 2005 | 607 |
| 2006 | 804 |
| 2007 | 768 |
| 2008 | 1,102 |
| 2009 | 1,676 |
| 2010 | 2,186 |
| 2011 | 2,708 |
| 2012 | 3,026 |
| 2013 | 3,717 |
| 2014 | 4,035 |
| 2015 | 4,378 |
| 2016 | 4,510 |
| 2017 | 5,360 |
| 2018 | 8,225 |
| 2019 | 9,928 |
| 2020 | 21,622 |
| 2021 | 18,692 |
| 2022 | 19,500 |
| 2023 | 18,889 |
| 2024 | 19,946 |
| 2025 | 17,764 |
| 2026 | 3,558 |

### 3.2 性别与年龄分布

**性别**:

| 性别 | 报告数 |
|---|---|
| female | 70,286 |
| male | 55,895 |
| not reported | 1,647 |

**年龄段**(按 patientonsetage 原始数值,未区分单位,为近似分布):

| 年龄段 | 报告数 |
|---|---|
| <18 | 6,949 |
| 18-44 | 22,350 |
| 45-64 | 35,967 |
| 65-74 | 24,849 |
| 75+ | 13,993 |

性别分布中，女性70,286例（占报告性别的55.7%），男性55,895例（44.3%），未报告1,647例。年龄分布以45-64岁最多（35,967例），其次为18-44岁（22,350例）和65-74岁（24,849例），<18岁有6,949例，75岁以上13,993例。

### 3.3 结局分布(严重结局计数,同一报告可计入多类)

| 结局 | 报告数 |
|---|---|
| death (死亡) | 33,145 |
| life-threatening (危及生命) | 15,984 |
| hospitalization (住院) | 62,106 |
| disability (致残) | 10,058 |
| congenital anomaly (先天异常) | 3,278 |
| other serious (其他严重) | 117,496 |

结局统计中，其他严重类报告最多（117,496例），其次为住院（62,106例）、死亡（33,145例）、危及生命（15,984例）、致残（10,058例）和先天异常（3,278例）。注意结局可重复计数。

### 3.4 报告国别(top 10)

| 国别代码 | 报告数 |
|---|---|
| CA | 47,657 |
| US | 24,761 |
| FR | 10,258 |
| DE | 8,536 |
| GB | 6,997 |
| JP | 5,941 |
| IT | 5,725 |
| EU | 4,709 |
| AU | 3,908 |
| CN | 3,739 |

### 3.5 合并用药(top 10,已剔除目标药本身)

| 药品 | 报告数 |
|---|---|
| PREDNISONE | 40,076 |
| CYCLOPHOSPHAMIDE | 32,813 |
| VINCRISTINE | 31,148 |
| METHOTREXATE | 25,911 |
| DOXORUBICIN | 24,763 |
| PREDNISONE. | 20,798 |
| ORENCIA | 19,916 |
| ENBREL | 19,531 |
| ACTEMRA | 18,908 |
| HUMIRA | 18,604 |

### 3.6 适应症(top 10)

| 适应症 | 报告数 |
|---|---|
| Product used for unknown indication | 31,615 |
| PRODUCT USED FOR UNKNOWN INDICATION | 21,766 |
| Rheumatoid arthritis | 21,283 |
| RHEUMATOID ARTHRITIS | 17,491 |
| Diffuse large B-cell lymphoma | 13,604 |
| DIFFUSE LARGE B-CELL LYMPHOMA | 10,678 |
| B-CELL LYMPHOMA | 6,278 |
| CHRONIC LYMPHOCYTIC LEUKAEMIA | 5,992 |
| Psoriatic arthropathy | 5,910 |
| Premedication | 5,125 |

## 4. 失比例信号分析

2×2 列联表定义:a=目标药且目标 ADR 的报告数,b=目标药其他 ADR,c=其他药目标 ADR,d=其他药其他 ADR(d=N−a−b−c,N 为 FAERS 全库)。任一单元格为 0 时按 Haldane-Anscombe 法(+0.5)校正并在 CSV 中标记。

| ADR (PT) | 来源 | a | ROR [95%CI] | PRR [95%CI] | χ² | IC (IC025) | EBGM (EB05) | 信号 |
|---|---|---|---|---|---|---|---|---|
| pneumonia | 指定 | 16,885 | 5.551 [5.462, 5.641] | 5.108 [5.033, 5.183] | 54505.185 | 2.303 (2.280) | 4.935 (4.872) | **是** |
| off label use | top | 35,141 | 6.139 [6.066, 6.212] | 5.097 [5.049, 5.146] | 115628.064 | 2.300 (2.283) | 4.925 (4.882) | **是** |
| drug ineffective | top | 29,570 | 2.978 [2.941, 3.016] | 2.641 [2.613, 2.668] | 31535.925 | 1.381 (1.363) | 2.604 (2.579) | **是** |
| pain | top | 24,737 | 1.392 [1.373, 1.411] | 1.336 [1.321, 1.352] | 2314.877 | 0.414 (0.395) | 1.332 (1.318) | **是** |
| rheumatoid arthritis | top | 16,340 | 22.333 [21.949, 22.723] | 20.322 [20.001, 20.648] | 256908.153 | 4.125 (4.100) | 17.445 (17.222) | **是** |
| fatigue | top | 13,797 | 2.253 [2.214, 2.293] | 2.153 [2.119, 2.188] | 8689.090 | 1.092 (1.067) | 2.132 (2.102) | **是** |
| rash | top | 12,494 | 2.427 [2.383, 2.472] | 2.324 [2.285, 2.364] | 9539.177 | 1.200 (1.174) | 2.298 (2.264) | **是** |
| arthralgia | top | 10,950 | 3.418 [3.351, 3.486] | 3.265 [3.206, 3.326] | 17073.472 | 1.680 (1.651) | 3.203 (3.153) | **是** |
| drug intolerance | top | 10,439 | 15.541 [15.219, 15.869] | 14.665 [14.377, 14.958] | 118577.126 | 3.715 (3.685) | 13.133 (12.922) | **是** |
| infusion related reaction | top | 10,424 | 24.014 [23.502, 24.537] | 22.630 [22.172, 23.097] | 180965.077 | 4.256 (4.225) | 19.103 (18.796) | **是** |
| pyrexia | top | 10,236 | 3.808 [3.731, 3.886] | 3.642 [3.573, 3.712] | 19343.525 | 1.833 (1.804) | 3.562 (3.504) | **是** |

全精度数值见同目录 signals.csv(与本表同源)。信号≠因果,详见第 8 节局限性声明。

### 4.1 信号解读

信号筛查显示，所有目标ADR均检测到失比例信号。其中infusion related reaction的ROR最高（24.014），rheumatoid arthritis的chi2最大（256,908.153），pneumonia的ROR为5.551。其余信号如off label use、drug ineffective、pain等ROR均大于1，95%CI下限均>1。

## 5. 重点 ADR 解读

### 5.1 pneumonia

肺炎报告数为16,885例，在利妥昔单抗全部报告中占比9.7%。失比例信号显著，ROR为5.551（95%CI 5.462-5.641），PRR为5.108，EBGM为4.935。统计学筛查表明肺炎与利妥昔单抗的关联性远高于背景频率。

### 5.2 infusion related reaction

输液相关反应报告数为10,424例，ROR高达24.014（95%CI 23.502-24.537），PRR为22.630，EBGM为19.103，是信号强度最高的ADR之一。该反应在说明书中有明确描述，临床需重点关注。

### 5.3 rheumatoid arthritis

类风湿关节炎作为可疑不良反应报告16,340例，ROR为22.333（95%CI 21.949-22.723），PRR为20.322，chi2为256,908.153，信号极强。注意该反应也可能是基础疾病或适应证报告，解读需结合临床背景。

### 5.4 drug intolerance

药物不耐受报告10,439例，ROR为15.541（95%CI 15.219-15.869），PRR为14.665，EBGM为13.133。筛查提示利妥昔单抗使用中不耐受相关报告显著高于预期。

### 5.5 off label use

超说明书用药报告35,141例，为数量最多的重点ADR。ROR为6.139（95%CI 6.066-6.212），PRR为5.097，信号强度中等。该现象可能反映利妥昔单抗在临床实践中广泛用于未获批适应证。

### 5.6 pyrexia

发热报告10,236例，ROR为3.808（95%CI 3.731-3.886），PRR为3.642，EBGM为3.562。信号提示发热与利妥昔单抗使用存在统计学关联，但需注意发热为非特异性表现。

## 6. 说明书对照(FDA label)

| ADR (PT) | 标注状态 | 证据(原文引用,章节) |
|---|---|---|
| pneumonia | 已标注 | “Pneumonia (4 patients RITUXAN HYCELA vs. 1 patient rituximab), septic shock (2 patients RITUXAN HYCELA vs. 3 patients rituximab), and cardiac arrest (1 patient RITUXAN HYCELA vs. 3 patients rituximab) were the most common adverse reactions leading to death.”(adverse_reactions) |

对照用说明书记录:3e5b7e82-f018-4eaf-ae78-d6145a906b20 (Rituxan Hycela);9af3ddc7-4217-417a-ac89-8704edc5bc44 (Truxima)

对照说明:说明书原文过长,对照基于各章节开头+目标 ADR 命中窗口的节选文本,「未标注」结论可能受截断影响。

说明书对照显示，pneumonia在说明书中被标注为不良反应（引用自RITUXAN HYCELA死亡不良事件描述）。其他目标ADR的标注状态未在提供的对照数据中明确，需进一步查阅完整说明书。

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
| 目标药报告总数 | `https://api.fda.gov/drug/event.json?limit=1&search=patient.drug.medicinalproduct%3A%22rituximab%22` |
| FAERS 全库总数(N) | `https://api.fda.gov/drug/event.json?limit=1` |
| 目标药 PT 频数(top 筛查) | `https://api.fda.gov/drug/event.json?limit=100&count=patient.reaction.reactionmeddrapt.exact&search=patient.drug.medicinalproduct%3A%22rituximab%22` |
| 说明书检索 | `https://api.fda.gov/drug/label.json?limit=2&search=%28openfda.generic_name%3A%22rituximab%22%20OR%20openfda.brand_name%3A%22rituximab%22%29` |
| 2×2·联合计数[pneumonia] | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.medicinalproduct%3A%22rituximab%22%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22pneumonia%22%29` |
| 2×2·事件计数[pneumonia] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22pneumonia%22` |

检索日期:2026-07-20

---

*本报告由 EviMed 药品安全性专项 Agent(safety_agent) 自动生成。所有定量结果可经附录中的 openFDA 查询复现;LLM 不参与任何数值计算。*
