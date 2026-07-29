# LDL cholesterol与coronary heart disease：两样本孟德尔随机化分析

## Abstract

背景：本分析评估遗传预测的LDL cholesterol与coronary heart disease之间的关联。
方法：采用两样本孟德尔随机化；暴露GWAS ieu-b-110（n=440,546）与结局GWAS ebi-a-GCST005195（n=547,261）经等位基因协调后保留144个工具变量，以IVW为主分析。
结果：IVW估计为OR=1.550, 95% CI 1.362–1.763, p=2.990e-11；平均F统计量为242.091。异质性检验显著；MR-Egger intercept p=2.275e-01；MR-PRESSO global p=N/A; candidate outliers=23。
结论：主分析提示正向关联。该估计必须结合工具变量假设、异质性、多效性与样本重叠不确定性解读，不单独等同于无条件因果证明。

## Introduction

冠心病（coronary heart disease, CHD）是全球范围内最常见的心血管疾病类型，也是导致过早死亡和伤残调整生命年的首要原因之一（Dalen, 2014；Ferreira-González, 2014）。尽管近几十年来在控制传统危险因素和治疗手段方面取得了长足进步，冠心病的疾病负担依然沉重，识别并干预其关键致病因子对于减轻公共卫生压力具有重要意义。低密度脂蛋白胆固醇（low-density lipoprotein cholesterol, LDL-C）作为脂质代谢的核心组分，早已被纳入冠心病的致病假说，然而明确其因果效应的强度与独立性仍是当代心血管流行病学的核心议题。

大量实验室、动物模型和临床研究已将LDL胆固醇锚定为动脉粥样硬化的启动与进展因子（Pedro-Botet 等， 2024）。Guijarro 和 Cosín-Sales（2021）系统回顾了长达一个世纪的脂质假说证据链，强调高浓度LDL胆固醇持续暴露与斑块负荷之间存在量效关系。与此一致，多项大规模随机对照试验证实，通过他汀类药物、PCSK9抑制剂等干预手段降低LDL胆固醇水平，可以显著减少冠心病事件的发生率（Tobert， 2022；Weitgasser 等， 2018）。然而，这些传统研究设计无法彻底排除潜在混杂和反向因果的干扰：例如，健康生活方式或社会经济状态可能同时影响LDL水平和冠心病风险，而临床前期的全身状态变化也可能反过来改变血脂水平，使得观察性关联的因果解释受到限制。

为突破上述局限，孟德尔随机化（Mendelian randomization, MR）方法应运而生。该方法以遗传变异作为工具变量，利用等位基因在配子形成过程中随机分配的孟德尔定律，在观察性数据中模拟随机对照试验的分组机制，从而有效降低混杂和反向因果偏倚（Björnson 等， 2024）。有效工具变量必须满足三个核心假设：第一，遗传变异与暴露（LDL胆固醇）稳健相关；第二，遗传变异与影响暴露-结局关联的混杂因素相互独立；第三，遗传变异仅通过暴露路径影响结局（冠心病），不存在独立于暴露之外的水平多效性路径。值得注意的是，Björnson 等（2024）近期基于载脂蛋白B的遗传分析，利用类似MR的框架揭示了LDL颗粒本身的致动脉粥样硬化能力，为MR研究LDL胆固醇与冠心病的因果效应提供了先验依据和可行性范本。

本研究旨在采用双样本孟德尔随机化设计，利用大规模全基因组关联研究（GWAS）汇总统计数据，系统评估遗传预测的LDL胆固醇水平与冠心病风险之间的因果关联。基于脂质假说和既有因果证据，我们预先指定的假设为：遗传决定的LDL胆固醇水平升高与冠心病发病风险增加之间存在正向因果关联。通过严格筛选工具变量，并整合多种灵敏度分析手段，力求在最大程度规避偏倚的前提下，量化这一核心脂质指标对冠心病的独立因果效应。

本文以下各部分组织如下：方法部分详细描述了研究设计、数据来源、工具变量筛选流程与统计分析策略；结果部分呈现孟德尔随机化主要发现及敏感性分析结果；讨论部分对结果进行阐释，并评价研究的优势、局限性及转化意义。

## Methods

### 1. 研究设计与数据源
本分析采用两样本孟德尔随机化设计，评估LDL cholesterol对coronary heart disease的效应。暴露GWAS为ieu-b-110（性状：LDL cholesterol；样本量：440,546；人群：European；年份：2020；SNP总数：12,321,875）。结局GWAS为ebi-a-GCST005195（性状：Coronary artery disease；样本量：547,261；人群：N/A；年份：2017；SNP总数：7,934,254）。源元数据未提供足以验证样本是否重叠的队列级信息，故不作无重叠声明。

### 2. 工具变量与统计分析
暴露相关SNP的筛选阈值为p < 5.0e-08，执行LD clumping（r² < 0.001，窗口10,000 kb）及等位基因协调；最终进入分析的工具变量为144个。当前结构化结果仅记录平均F统计量242.091，不据此虚构逐SNP的F值。实际估计方法为：MR Egger, Weighted median, Inverse variance weighted, Simple mode, Weighted mode。实际产生的敏感性分析为：Cochran's Q, MR-Egger intercept, MR-PRESSO, leave-one-out plot。统计由R/TwoSampleMR流程执行；未由运行时记录的软件版本报告为N/A。本次未提供正式功效或最小可检测效应计算，故不作相关推断。

## Results

### 1. LDL cholesterol → coronary heart disease
GWAS ID：ieu-b-110 → ebi-a-GCST005195；工具变量：144个；平均F统计量：242.091。
- MR Egger：beta=0.5026，SE=0.0847，p=2.125e-08，OR=1.653，95% CI 1.400–1.951
- Weighted median：beta=0.3047，SE=0.0273，p=7.680e-29，OR=1.356，95% CI 1.285–1.431
- Inverse variance weighted：beta=0.4381，SE=0.0659，p=2.990e-11，OR=1.550，95% CI 1.362–1.763
- Simple mode：beta=0.5412，SE=0.1181，p=9.880e-06，OR=1.718，95% CI 1.363–2.166
- Weighted mode：beta=0.3648，SE=0.0304，p=1.972e-23，OR=1.440，95% CI 1.357–1.529
主分析效应为正向且统计学显著；该结果提示关联方向，不单独等同于无条件因果证明。
异质性：
- MR Egger：Q=2109.10，df=142，p=0.000e+00
- Inverse variance weighted：Q=2130.92，df=143，p=0.000e+00
MR-Egger截距=-0.0044，SE=0.0036，p=2.275e-01；未检出显著方向性多效性，但不能排除平衡多效性。
MR-PRESSO运行记录了23个候选离群值，但全局检验p值未被解析；不据此声称全局检验阴性。

## Discussion

主分析显示遗传预测的LDL cholesterol与coronary heart disease呈正向关联，IVW估计达统计学显著（beta=0.4381，p=2.990e-11）。其他4种已实际运行的估计方法方向一致。这种方法间的一致性可作为稳健性信号，但不能修复共享偏倚或无效工具变量。

异质性检验显著。MR-Egger截距未检出显著方向性多效性，但不显著截距不排除平衡多效性。MR-PRESSO记录23个候选离群值，但全局p值不可用，因此不作阴性结论。

源元数据不足以证明队列完全无重叠。由于本次未运行反向MR、多变量MR、非线性MR或正式功效分析，不对方向反转、独立性、剂量阈值或最小可检测效应作额外声称。该结果适合作为可追溯的因果推断证据，不直接生成个体诊疗建议或具体干预阈值。

## Limitations

本分析仅记录平均F统计量242.091；平均值不能替代每个SNP的强度判断。暴露与结局人群元数据分别为European和N/A；对未报告的结局人群不作欧洲血统推断，跨人群外推性需另行验证。

异质性检验显著，虽然MR-Egger截距未显著，仍不能排除平衡性或非相关多效性。MR-PRESSO记录了23个候选离群值，但全局p值不可用，因此不将其解读为“无多效性”。

队列级样本重叠信息不足，不能宣称完全无重叠。其他限制包括GWAS数据库选择偏倚、赢家诅咒、水平多效性、线性平均效应无法刻画阈值/非线性关系，以及未完成反向或多变量MR。

## Conclusion

在144个协调后工具变量的两样本MR中，LDL cholesterol与coronary heart disease的IVW估计呈正向关联（beta=0.4381，p=2.990e-11）。该结果在遗传工具假设成立时支持相应方向的因果解释，但必须保留对异质性、多效性、样本重叠和未运行扩展分析的限制；不由此推导具体剂量、阈值或个体化治疗决策。

## Data Availability

本次运行使用的GWAS标识符与仓库链接为：ieu-b-110 (https://gwas.mrcieu.ac.uk/datasets/ieu-b-110/)；ebi-a-GCST005195 (https://gwas.mrcieu.ac.uk/datasets/ebi-a-GCST005195/)。实际可用性、访问条件和版本以源仓库为准。EviMed运行包保留请求、结构化结果、数据表、图形和报告供本地复核；本运行未声称另有公开GitHub代码仓库。

## Ethics Statement

本次运行仅处理公开的去识别GWAS汇总统计量，未访问个体级数据。原始研究的伦理审批和知情同意状态应以各数据集原始出版物为准；EviMed运行时没有独立验证这些文件。在稿件提交或机构使用前，作者仍需按所在机构和期刊要求确认二次分析是否需额外审查。

## Table1

| Characteristic | Exposure | Outcome |
|---|---:|---:|
| Trait | LDL cholesterol | Coronary artery disease |
| GWAS ID | ieu-b-110 | ebi-a-GCST005195 |
| Sample size | 440,546 | 547,261 |
| Population | European | N/A |
| Year | 2020 | 2017 |
| Total SNPs | 12,321,875 | 7,934,254 |
| Selected instruments | 144 | 144 |
| Mean F-statistic | 242.091 | N/A |

## Table2

| Exposure GWAS | Outcome GWAS | Method | nSNP | beta | SE | OR | 95% CI | p-value |
|---|---|---|---:|---:|---:|---:|---|---:|
| ieu-b-110 | ebi-a-GCST005195 | MR Egger | 144 | 0.5026 | 0.0847 | 1.653 | 1.400–1.951 | 2.125e-08 |
| ieu-b-110 | ebi-a-GCST005195 | Weighted median | 144 | 0.3047 | 0.0273 | 1.356 | 1.285–1.431 | 7.680e-29 |
| ieu-b-110 | ebi-a-GCST005195 | Inverse variance weighted | 144 | 0.4381 | 0.0659 | 1.550 | 1.362–1.763 | 2.990e-11 |
| ieu-b-110 | ebi-a-GCST005195 | Simple mode | 144 | 0.5412 | 0.1181 | 1.718 | 1.363–2.166 | 9.880e-06 |
| ieu-b-110 | ebi-a-GCST005195 | Weighted mode | 144 | 0.3648 | 0.0304 | 1.440 | 1.357–1.529 | 1.972e-23 |

## References

[1] Pedro-Botet Juan, Climent Elisenda, Benaiges David. LDL cholesterol as a causal agent of atherosclerosis. Clinica e investigacion en arteriosclerosis : publicacion oficial de la Sociedad Espanola de Arteriosclerosis. 2024. https://doi.org/10.1016/j.arteri.2024.07.001

[2] Guijarro Carlos, Cosín-Sales Juan. LDL cholesterol and atherosclerosis: The evidence. Clinica e investigacion en arteriosclerosis : publicacion oficial de la Sociedad Espanola de Arteriosclerosis. 2021. https://doi.org/10.1016/j.arteri.2020.12.004

[3] Tobert Jonathan A. LDL Cholesterol-How Low Can We Go?. Endocrinology and metabolism clinics of North America. 2022. https://doi.org/10.1016/j.ecl.2022.01.005

[4] Hooper Amanda J, Tang Xuan L, Burnett John R. VERVE-101, a CRISPR base-editing therapy designed to permanently inactivate hepatic PCSK9 and reduce LDL-cholesterol. Expert opinion on investigational drugs. 2024. https://doi.org/10.1080/13543784.2024.2369747

[5] Wiklund Olov. [Elderly benefit from lower LDL-cholesterol]. Lakartidningen. 2021.

[6] Hartz Jacob, Hegele Robert A, Wilson Don P. Low LDL cholesterol-Friend or foe?. Journal of clinical lipidology. 2019. https://doi.org/10.1016/j.jacl.2019.05.006

[7] Duprez Daniel, Jacobs David R. LDL-cholesterol lowering: to be or not to be too low. European journal of preventive cardiology. 2023. https://doi.org/10.1093/eurjpc/zwad143

[8] Superko H R. Beyond LDL cholesterol reduction. Circulation. 1996.

[9] Weingärtner Oliver, Marx Nikolaus, Klose Gerald, Laufs Ulrich. [Therapeutic options to reduce LDL-cholesterol beyond statins]. Deutsche medizinische Wochenschrift (1946). 2022. https://doi.org/10.1055/a-1516-2631

[10] Weitgasser Raimund, Ratzinger Michaela, Hemetsberger Margit, Siostrzonek Peter. [LDL-cholesterol and cardiovascular events: the lower the better?]. Wiener medizinische Wochenschrift (1946). 2018. https://doi.org/10.1007/s10354-016-0518-2

[11] Ulbricht T L, Southgate D A. Coronary heart disease: seven dietary factors. Lancet (London, England). 1991.

[12] Khamis Ramzi Y, Ammari Tareq, Mikhail Ghada W. Gender differences in coronary heart disease. Heart (British Cardiac Society). 2016. https://doi.org/10.1136/heartjnl-2014-306463

[13] Dalen James E, Alpert Joseph S, Goldberg Robert J, Weinstein Ronald S. The epidemic of the 20(th) century: coronary heart disease. The American journal of medicine. 2014. https://doi.org/10.1016/j.amjmed.2014.04.015

[14] Shuttleworth A L. Coronary heart disease. Professional nurse (London, England). 1996.

[15] Liu Huagang, Zhuang Junli, Tang Peng, Li Jie, Xiong Xiaoxing et al.. The Role of the Gut Microbiota in Coronary Heart Disease. Current atherosclerosis reports. 2020. https://doi.org/10.1007/s11883-020-00892-2

[16] Wang Jia-Jie. Risk of Coronary Heart Disease in People with Chronic Obstructive Pulmonary Disease: A Meta-Analysis. International journal of chronic obstructive pulmonary disease. 2021. https://doi.org/10.2147/COPD.S331505

[17] Ferreira-González Ignacio. The epidemiology of coronary heart disease. Revista espanola de cardiologia (English ed.). 2014. https://doi.org/10.1016/j.rec.2013.10.002

[18] Schwinger Robert H G. [Secondary prevention for coronary heart disease]. MMW Fortschritte der Medizin. 2023. https://doi.org/10.1007/s15006-023-2355-8

[19] Zhang Honghong, Jing Lele, Zhai Changlin, Xiang Qiannan, Tian Hongen et al.. Intestinal Flora Metabolite Trimethylamine Oxide Is Inextricably Linked to Coronary Heart Disease. Journal of cardiovascular pharmacology. 2023. https://doi.org/10.1097/FJC.0000000000001387

[20] Björnson Elias, Adiels Martin, Taskinen Marja-Riitta, Burgess Stephen, Chapman M John et al.. Lipoprotein(a) Is Markedly More Atherogenic Than LDL: An Apolipoprotein B-Based Genetic Analysis. Journal of the American College of Cardiology. 2024. https://doi.org/10.1016/j.jacc.2023.10.039

[21] Björnson Elias, Adiels Martin, Taskinen Marja-Riitta, Burgess Stephen, Rawshani Aidin et al.. Triglyceride-rich lipoprotein remnants, low-density lipoproteins, and risk of coronary heart disease: a UK Biobank study. European heart journal. 2023. https://doi.org/10.1093/eurheartj/ehad337

[22] Li Zhixi, Ren Yuhan, Jiang Feng, Zhang Kai, Meng Xuan et al.. Unveiling biomarkers via plasma metabolome profiling for diabetic macrovascular and microvascular complications. Cardiovascular diabetology. 2025. https://doi.org/10.1186/s12933-025-02899-y

[23] Holmes Michael V, Ala-Korpela Mika, Smith George Davey. Mendelian randomization in cardiometabolic disease: challenges in evaluating causality. Nature reviews. Cardiology. 2017. https://doi.org/10.1038/nrcardio.2017.78

[24] Doi Takahito, Langsted Anne, Nordestgaard Børge Grønne. Remnant Cholesterol: Should it be a Target for Prevention of ASCVD?. Current atherosclerosis reports. 2025. https://doi.org/10.1007/s11883-025-01288-w

[25] Orho-Melander M. Genetics of coronary heart disease: towards causal mechanisms, novel drug targets and more personalized prevention. Journal of internal medicine. 2015. https://doi.org/10.1111/joim.12407

[26] Yang Bo, Yao Bo, Zou Qu, Li Sicheng, Yang Shun et al.. Causal Association Between Cholesterol-Lowering Drugs and Diabetic Microvascular Complications: A Drug-Target Mendelian Randomization Study. Journal of diabetes research. 2025. https://doi.org/10.1155/jdr/3661739

[27] Therond Patrice, Chapman M John. Sphingosine-1-phosphate: metabolism, transport, atheroprotection and effect of statin treatment. Current opinion in lipidology. 2022. https://doi.org/10.1097/MOL.0000000000000825

[28] Tragante Vinicius, Asselbergs Folkert W, Swerdlow Daniel I, Palmer Tom M, Moore Jason H et al.. Harnessing publicly available genetic data to prioritize lipid modifying therapeutic targets for prevention of coronary heart disease based on dysglycemic risk. Human genetics. 2016. https://doi.org/10.1007/s00439-016-1647-9

[29] Hopewell Jemma C, Malik Rainer, Valdés-Márquez Elsa, Worrall Bradford B, Collins Rory et al.. Differential effects of PCSK9 variants on risk of coronary disease and ischaemic stroke. European heart journal. 2018. https://doi.org/10.1093/eurheartj/ehx373

[30] Burgess Stephen, Butterworth Adam, Thompson Simon G. Mendelian randomization analysis with multiple genetic variants using summarized data. Genetic epidemiology. 2013. https://doi.org/10.1002/gepi.21758

[31] Bowden Jack, Davey Smith George, Haycock Philip C, Burgess Stephen. Consistent Estimation in Mendelian Randomization with Some Invalid Instruments Using a Weighted Median Estimator. Genetic epidemiology. 2016. https://doi.org/10.1002/gepi.21965

[32] Bowden Jack, Davey Smith George, Burgess Stephen. Mendelian randomization with invalid instruments: effect estimation and bias detection through Egger regression. International journal of epidemiology. 2015. https://doi.org/10.1093/ije/dyv080

[33] Hartwig Fernando Pires, Davey Smith George, Bowden Jack. Robust inference in summary data Mendelian randomization via the zero modal pleiotropy assumption. International journal of epidemiology. 2017. https://doi.org/10.1093/ije/dyx102

[34] Verbanck Marie, Chen Chia-Yen, Neale Benjamin, Do Ron. Detection of widespread horizontal pleiotropy in causal relationships inferred from Mendelian randomization between complex traits and diseases. Nature genetics. 2018. https://doi.org/10.1038/s41588-018-0099-7