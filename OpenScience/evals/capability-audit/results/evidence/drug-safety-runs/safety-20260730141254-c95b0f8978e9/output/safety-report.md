# atorvastatin — FAERS 药物安全性分析报告

**生成时间**:2026-07-30 14:14 UTC  
**分析工具**:EviMed 药品安全性专项 Agent(safety_agent)  
**数据源**:FAERS,经 openFDA live API 访问  
**分析指标**:ROR、PRR、χ²、IC/IC025(BCPNN)、EBGM/EB05(GPS)  
**信号判定规则**:a≥3 且(ROR 95%CI 下限>1 或(PRR≥2 且 χ²≥4))  

---

## 1. 分析概览

- **目标药品**:atorvastatin(原始输入:atorvastatin)
- **目标 ADR**:rhabdomyolysis
- **FAERS 报告总数(该药)**:246,352 份
- **药品角色口径**:PS、SS
- **药名/角色绑定**:report_contains_suspect_approximation
- **统计版本**:gps-v2;GPS prior=unfitted-starting-prior
- **信号筛查范围**:11 个 PT,其中 10 个满足信号判定规则

阿托伐他汀在 FAERS 数据库中累计报告 246,352 例（2004 年 - 2026 年）。对其中报告的不良事件进行失比例分析，共检出多个信号，重点关注横纹肌溶解、2 型糖尿病、肌痛、疲劳、呼吸困难、头晕等术语。

## 2. 输入归一

| 环节 | 输入 | 归一结果 | 方法 | 置信度 |
|---|---|---|---|---|
| 药品 | atorvastatin | atorvastatin | 规则+openFDA(候选:atorvastatin) | — |
| ADR | rhabdomyolysis | rhabdomyolysis | pt-direct | 1.00 |

## 3. 病例概览(FAERS)

该药在 FAERS 中共有 **246,352** 份报告。

### 3.1 年度趋势

| 年份 | 报告数 |
|---|---|
| 2004 | 5,713 |
| 2005 | 7,623 |
| 2006 | 8,235 |
| 2007 | 7,142 |
| 2008 | 6,684 |
| 2009 | 7,552 |
| 2010 | 15,179 |
| 2011 | 11,824 |
| 2012 | 14,144 |
| 2013 | 10,848 |
| 2014 | 15,573 |
| 2015 | 15,543 |
| 2016 | 14,887 |
| 2017 | 12,897 |
| 2018 | 12,966 |
| 2019 | 13,304 |
| 2020 | 12,336 |
| 2021 | 10,589 |
| 2022 | 10,492 |
| 2023 | 9,479 |
| 2024 | 9,994 |
| 2025 | 10,917 |
| 2026 | 2,425 |

### 3.2 性别与年龄分布

**性别**:

| 性别 | 报告数 |
|---|---|
| female | 124,263 |
| male | 105,113 |
| not reported | 16,976 |

**年龄段**(live 按 patientonsetageunit 800–805 换算为年;十年代编码近似归类;冻结快照使用 age_years):

| 年龄段 | 报告数 |
|---|---|
| <18 | 213 |
| 18-44 | 7,762 |
| 45-64 | 59,462 |
| 65-74 | 46,528 |
| 75+ | 40,172 |
| not reported | 92,215 |

在报告人群中，女性 124,263 例，男性 105,113 例，未报告性别 16,976 例。年龄分布以 45-64 岁组最突出（59,462 例），65-74 岁组 46,528 例，75 岁以上 40,172 例，18-44 岁 7,762 例，<18 岁 213 例，另有 92,215 例未报告年龄。报告主要来自美国（124,298 例），其次为加拿大（11,455 例）、日本（3,837 例）、中国（3,013 例）和英国（2,470 例）。报告中最常合并使用的药物除阿托伐他汀自身商品名 LIPITOR（177,785 例）外，还包括阿司匹林（34,362 例）、氯吡格雷（16,367 例）、再次出现的阿司匹林（14,893 例）和呋塞米（14,662 例）。最常见适应证为 PRODUCT USED FOR UNKNOWN INDICATION（42,513 例），血胆固醇升高（27,791 例）、未指明用途的产品使用（25,980 例）、高血压（20,854 例）和糖尿病（9,754 例）。

### 3.3 结局分布(严重结局计数,同一报告可计入多类)

| 结局 | 报告数 |
|---|---|
| death (死亡) | 18,864 |
| life-threatening (危及生命) | 7,367 |
| hospitalization (住院) | 70,177 |
| disability (致残) | 7,779 |
| congenital anomaly (先天异常) | 116 |
| other serious (其他严重) | 106,803 |

严重结局分布中，住院报告 70,177 例，其他严重情况 106,803 例，死亡 18,864 例，致残 7,779 例，危及生命 7,367 例，先天异常 116 例。

### 3.4 报告国别(top 10)

| 国别代码 | 报告数 |
|---|---|
| US | 124,298 |
| CA | 11,455 |
| JP | 3,837 |
| CN | 3,013 |
| GB | 2,470 |
| BR | 1,666 |
| AU | 1,496 |
| FR | 1,116 |
| DE | 808 |
| VE | 676 |
| not reported | 86,333 |

### 3.5 合并用药(top 10,已剔除目标药本身)

| 药品 | 报告数 |
|---|---|
| LIPITOR | 177,785 |
| ASPIRIN | 34,362 |
| PLAVIX | 16,367 |
| ASPIRIN. | 14,893 |
| LASIX | 14,662 |
| METFORMIN | 14,263 |
| SYNTHROID | 14,211 |
| VITAMIN D3 | 13,964 |
| LISINOPRIL | 12,833 |
| NEXIUM | 11,454 |

### 3.6 适应症(top 10)

| 适应症 | 报告数 |
|---|---|
| PRODUCT USED FOR UNKNOWN INDICATION | 42,513 |
| BLOOD CHOLESTEROL INCREASED | 27,791 |
| Product used for unknown indication | 25,980 |
| HYPERTENSION | 20,854 |
| DIABETES MELLITUS | 9,754 |
| PAIN | 7,356 |
| LOW DENSITY LIPOPROTEIN INCREASED | 7,171 |
| PLASMA CELL MYELOMA | 7,104 |
| RHEUMATOID ARTHRITIS | 7,060 |
| GASTROOESOPHAGEAL REFLUX DISEASE | 7,005 |

## 4. 失比例信号分析

2×2 列联表定义:a=目标药且目标 ADR 的报告数,b=目标药其他 ADR,c=其他药目标 ADR,d=其他药其他 ADR(d=N−a−b−c,N 为 FAERS 全库)。任一单元格为 0 时按 Haldane-Anscombe 法(+0.5)校正并在 CSV 中标记。

| ADR (PT) | 来源 | a | ROR [95%CI] | PRR [95%CI] | χ² | IC (IC025) | EBGM (EB05) | 信号 |
|---|---|---|---|---|---|---|---|---|
| rhabdomyolysis | 指定 | 2,200 | 4.720 [4.520, 4.928] | 4.687 [4.490, 4.891] | 6045.045 | 2.165 (2.104) | 4.485 (4.329) | **是** |
| pain | top | 37,853 | 1.523 [1.506, 1.539] | 1.442 [1.429, 1.456] | 5648.923 | 0.521 (0.505) | 1.434 (1.422) | **是** |
| fatigue | top | 14,341 | 1.606 [1.578, 1.633] | 1.570 [1.545, 1.596] | 3027.113 | 0.641 (0.617) | 1.559 (1.538) | **是** |
| drug ineffective | top | 13,458 | 0.823 [0.808, 0.837] | 0.832 [0.819, 0.846] | 481.495 | -0.262 (-0.287) | 0.834 (0.822) | 否 |
| nausea | top | 12,755 | 1.404 [1.379, 1.429] | 1.383 [1.360, 1.407] | 1381.940 | 0.461 (0.435) | 1.376 (1.356) | **是** |
| dyspnoea | top | 12,219 | 1.800 [1.767, 1.833] | 1.760 [1.730, 1.791] | 4043.330 | 0.803 (0.776) | 1.744 (1.718) | **是** |
| diarrhoea | top | 11,407 | 1.526 [1.497, 1.555] | 1.502 [1.475, 1.529] | 1938.003 | 0.578 (0.551) | 1.492 (1.469) | **是** |
| type 2 diabetes mellitus | top | 11,290 | 44.124 [43.118, 45.155] | 42.148 [41.216, 43.101] | 299451.402 | 4.814 (4.782) | 28.116 (27.684) | **是** |
| dizziness | top | 10,255 | 1.770 [1.735, 1.805] | 1.738 [1.705, 1.771] | 3221.837 | 0.784 (0.756) | 1.722 (1.694) | **是** |
| headache | top | 10,121 | 1.370 [1.343, 1.398] | 1.355 [1.329, 1.381] | 953.700 | 0.432 (0.403) | 1.349 (1.327) | **是** |
| myalgia | top | 9,953 | 5.400 [5.290, 5.513] | 5.223 [5.120, 5.327] | 32196.816 | 2.313 (2.283) | 4.968 (4.887) | **是** |

全精度数值见同目录 signals.csv(与本表同源)。信号≠因果,详见第 8 节局限性声明。

### 4.1 信号解读

失比例分析共检出 10 个阳性信号。其中横纹肌溶解（ROR=4.720, PRR=4.687, IC=2.165）和肌痛（ROR=5.400, PRR=5.223, IC=2.313）显示较强的肌肉系统信号；2 型糖尿病信号强度极高（ROR=44.124, PRR=42.148, IC=4.814）。此外，呼吸困难（ROR=1.800, IC=0.803）、头晕（ROR=1.770, IC=0.784）、疲劳（ROR=1.606, IC=0.641）、疼痛（ROR=1.523, IC=0.521）、腹泻（ROR=1.526, IC=0.578）、恶心（ROR=1.404, IC=0.461）和头痛（ROR=1.370, IC=0.432）等常见症状亦呈现统计学失衡。药物无效（drug ineffective）未达到信号标准（ROR=0.823, PRR=0.832, IC=-0.262）。

## 5. 重点 ADR 解读

### 5.1 rhabdomyolysis

横纹肌溶解：共报告 2,200 例，预期报告 490.400 例。ROR 为 4.720（95%CI 4.520-4.928），PRR 为 4.687（95%CI 4.490-4.891），IC 为 2.165（IC025=2.104），EBGM 为 4.485（EB05=4.329）。该信号提示横纹肌溶解在阿托伐他汀相关报告中的比例明显高于背景，信号强度较高。

### 5.2 type 2 diabetes mellitus

2 型糖尿病：共报告 11,290 例，预期报告 401.438 例。ROR 为 44.124（95%CI 43.118-45.155），PRR 为 42.148（95%CI 41.216-43.101），IC 为 4.814（IC025=4.782），EBGM 为 28.116（EB05=27.684）。该信号提示 2 型糖尿病的报告比例远超预期，信号强度特别显著。

### 5.3 myalgia

肌痛：共报告 9,953 例，预期报告 2,003.250 例。ROR 为 5.400（95%CI 5.290-5.513），PRR 为 5.223（95%CI 5.120-5.327），IC 为 2.313（IC025=2.283），EBGM 为 4.968（EB05=4.887）。该信号提示肌痛报告比例显著增高，与横纹肌溶解同属肌肉骨骼系统信号。

### 5.4 dyspnoea

呼吸困难：共报告 12,219 例，预期报告 7,005.079 例。ROR 为 1.800（95%CI 1.767-1.833），PRR 为 1.760（95%CI 1.730-1.791），IC 为 0.803（IC025=0.776），EBGM 为 1.744（EB05=1.718）。该信号提示呼吸困难的报告比例略高于背景，但信号强度相对较低。

### 5.5 dizziness

头晕：共报告 10,255 例，预期报告 5,954.538 例。ROR 为 1.770（95%CI 1.735-1.805），PRR 为 1.738（95%CI 1.705-1.771），IC 为 0.784（IC025=0.756），EBGM 为 1.722（EB05=1.694）。类似呼吸困难的信号强度。

### 5.6 fatigue

疲劳：共报告 14,341 例，预期报告 9,195.815 例。ROR 为 1.606（95%CI 1.578-1.633），PRR 为 1.570（95%CI 1.545-1.596），IC 为 0.641（IC025=0.617），EBGM 为 1.559（EB05=1.538）。该信号提示疲劳的报告比例轻度升高。

## 6. 说明书对照(FDA label)

| ADR (PT) | 标注状态 | 证据(原文引用,章节) |
|---|---|---|
| rhabdomyolysis | 已标注 | “Musculoskeletal and connective tissue disorders: rhabdomyolysis, myositis.”(adverse_reactions)<br>“Atorvastatin calcium may cause myopathy (muscle pain, tenderness, or weakness associated with elevated creatine kinase [CK]) and rhabdomyolysis.”(warnings_and_cautions) |

对照用说明书记录:00afce9b-48c9-487a-a738-e359c005c707 (Atorvastatin calcium);01eadde8-37f3-4474-995f-22c1a65adf12 (Atorvastatin calcium)

对照说明:说明书原文过长,对照基于各章节开头+目标 ADR 命中窗口的节选文本,「未标注」结论可能受截断影响。

本次说明书对照仅针对横纹肌溶解进行检索，结果显示该反应在说明书的“不良反应”和“警告与注意事项”章节中均有记载，属于已标注的信号。其余关注的不良反应未进行说明书对照或对照无结果；由于说明书原文过长，对照基于节选窗口，“未标注”的结论可能受截断影响。

## 7. 循证证据检索(EviMed)

| 标题 | 机构 | 年份 | 链接 |
|---|---|---|---|
| 江西省他汀类药物综合评价与遴选标准专家共识 | 江西省保健学会 | — | — |
| 降脂新指南亮点：摒弃LDL-C目标值，更新他汀可治疗细则 | 河北省人民医院老年心脏科 郭艺芳 | — | — |
| 2015年欧洲动脉粥样硬化学会关于他汀相关肌肉症状对他汀用药影响的专家共识 | 首都医科大学大兴医院心内科 梁峰，北京大学人民医院心脏中心  胡大一， 北京协和医院心内科  沈珠军  方全 | — | — |
| 老年人心血管疾病合并神经精神疾病多重用药风险防控专家共识 | 中华医学会临床药学分会 | — | — |
| 降胆固醇单片复方制剂临床应用中国专家共识 | 中国医师协会心血管内科医师分会 | — | — |

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
| 目标药报告总数 | `https://api.fda.gov/drug/event.json?limit=1&search=%28patient.drug.openfda.generic_name%3A%22atorvastatin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29` |
| FAERS 全库总数(N) | `https://api.fda.gov/drug/event.json?limit=1` |
| 目标药 PT 频数(top 筛查) | `https://api.fda.gov/drug/event.json?limit=100&count=patient.reaction.reactionmeddrapt.exact&search=%28patient.drug.openfda.generic_name%3A%22atorvastatin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29` |
| 说明书检索 | `https://api.fda.gov/drug/label.json?limit=2&search=%28openfda.generic_name%3A%22atorvastatin%22%20OR%20openfda.brand_name%3A%22atorvastatin%22%29` |
| 2×2·联合计数[rhabdomyolysis] | `https://api.fda.gov/drug/event.json?limit=1&search=%28%28patient.drug.openfda.generic_name%3A%22atorvastatin%22%29%20AND%20%28patient.drug.drugcharacterization%3A1%29%29%20AND%20%28patient.reaction.reactionmeddrapt%3A%22rhabdomyolysis%22%29` |
| 2×2·事件计数[rhabdomyolysis] | `https://api.fda.gov/drug/event.json?limit=1&search=patient.reaction.reactionmeddrapt%3A%22rhabdomyolysis%22` |

检索日期:2026-07-30

---

*本报告由 EviMed 药品安全性专项 Agent(safety_agent) 自动生成。定量结果由确定性统计路径产生;live 结果按附录查询复核,冻结结果按快照来源与哈希复核;LLM 不参与数值计算。*
