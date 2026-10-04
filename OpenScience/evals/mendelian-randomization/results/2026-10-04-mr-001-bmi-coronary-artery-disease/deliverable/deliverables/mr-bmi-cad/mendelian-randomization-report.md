# 体重指数与冠状动脉疾病：两样本孟德尔随机化研究

## 1 结果摘要

以 64 个与体重指数（body mass index，BMI）在全基因组水平显著相关的遗传位点作为工具变量，逆方差加权模型给出：遗传预测的 BMI 每升高 1 个来源暴露单位，冠状动脉疾病（coronary artery disease，CAD）的比值比（odds ratio，OR）为 1.53（95% 置信区间 1.35–1.74），P = 3.5×10⁻¹¹。四种替代估计与两种稳健方法结果同向。加权中位数 OR 1.47（1.26–1.71），加权众数 OR 1.46（1.20–1.77），MR-Egger OR 1.69（1.25–2.28），简单众数 OR 1.39（1.04–1.87）；污染混合模型在对数比值比尺度上的估计为 0.465（95% CI 0.365–0.605）。剔除离群位点后，逆方差加权估计略有升高（OR 1.59，95% CI 1.43–1.77）。

三项诊断限制了结论强度。工具变量之间存在超出随机波动的异质性（Cochran Q = 123，自由度 63，P = 1.0×10⁻⁵），离群值检验识别出 2 个（MR-PRESSO）至 8 个（Radial MR）可疑位点；本次分析没有可用的祖源匹配连锁不平衡参考，位点独立性仅按 10,000 kb 距离窗口近似，连锁不平衡从未被测量；暴露量的量纲在数据来源中未作声明，比值比只能读作「每 1 个来源暴露单位」，不能等同于每 1 kg/m² 或每 1 个标准差。

综合判断：在工具变量三项核心假设成立的前提下，本结果支持「遗传预测的 BMI 偏高与 CAD 风险升高存在因果关联」，把握程度为中等。主要不确定性来自工具独立性未验证、异质性显著与暴露量纲未定。它不构成个体化诊疗依据。

## 2 研究问题与估计目标

本研究问的是：终生偏高的 BMI 是否导致 CAD 风险升高。分析只取一个方向（BMI → CAD），未做反向（CAD → BMI）分析。估计目标是暴露每升高 1 个单位所对应的 CAD 对数比值比及其 95% 置信区间，由两套独立的汇总统计数据估计，方法是两样本孟德尔随机化，全部使用公开汇总统计，不使用个体水平数据。分析要求三项核心假设同时成立：工具变量与暴露强相关、与混杂因素无关、只通过暴露影响结局。

## 3 数据来源

### 3.1 暴露：体重指数

来自 NHGRI-EBI GWAS Catalog 研究 GCST002783（性状记录为「Body mass index」，对应 Locke 等 2015 年的 BMI 全基因组关联研究）[1,2]。来源记录的样本描述为「最多 104,666 名欧洲祖源男性、最多 132,115 名欧洲祖源女性、370 名非裔男性、517 名非裔女性、512 名西班牙裔男性、764 名西班牙裔女性」，研究合计样本量为 238,944。祖源构成中欧洲裔 236,781、西班牙或拉丁裔 1,276、非裔美国人或非裔加勒比 887，三者之和与合计样本量一致；欧洲裔个体约占 99.09%，其余 2,163 人为非欧洲祖源。这是一个以欧洲祖源为主的样本，并非纯欧洲祖源样本。

位点级样本量另有一层信息。来源为选中的 67 个位点给出了逐位点样本量，范围 218,359–339,205，不同位点实际参与分析的例数并不相同。该研究自身报告的分析人数为「最多 339,224 人」[1]，接近位点级样本量的上限，也高于来源标注的研究合计 238,944。这个合计既代表不了每个位点的分析样本量，也不适合当作本次分析的统一分母。协调后的汇总统计文件含 2,555,085 行记录，其中 24,237 行（0.95%）因字段不完整无法读取。

### 3.2 结局：冠状动脉疾病

来自 GWAS Catalog 研究 GCST003116（性状记录为「Coronary artery disease」，对应 Nikpay 等 2015 年的 CAD 关联研究）[3,4]，为病例对照设计。来源记录的样本描述为「42,096 名欧洲祖源病例、361 名非裔病例、758 名西班牙裔美国病例、12,658 名南亚祖源病例、1,802 名黎巴嫩祖源病例、3,614 名东亚祖源病例、99,121 名欧洲祖源对照、2,778 名非裔对照、3,337 名西班牙裔美国对照、12,899 名南亚祖源对照、466 名黎巴嫩祖源对照、7,709 名东亚祖源对照」，合计 187,599。祖源构成为欧洲裔 141,217（75.28%）、南亚 25,557、东亚 11,323、西班牙或拉丁裔 4,095、非裔 3,139、大中东 2,268。

结局侧没有位点级的样本量信息：66 个选中位点中报告数为 0，这 66 个位点全部沿用了研究合计 187,599。从来源记录无法判断各位点是否在相同样本量下被分析，187,599 更像是目录填充值，而不是逐位点的实测值。协调后的汇总统计文件含 8,623,797 行记录，其中 26,558 行（0.31%）因字段不完整无法读取。

### 3.3 两个来源之间是否共享参与者

两个来源的记录只给出祖源分层与人数，未列出具体队列名单，因此无法逐一比对参与者是否重叠。重叠状态记为未知，偏倚方向无法从现有记录判定。本报告不声称这两个样本相互独立（见第 10 节）。

## 4 工具变量选择与强度

工具变量的显著性阈值设为 P < 5×10⁻⁸，暴露汇总统计中达到该阈值的变异共 2,042 个。

位点独立性只能近似处理。本次分析未能完成祖源匹配的连锁不平衡计算（暴露样本的祖源类别无法确定），改用距离近似：每个 10,000 kb 窗口内保留最显著的一个变异，得到 67 个候选工具变量。连锁不平衡从未被测量，这 67 个位点彼此是否独立也未得到验证。若相邻位点实际处于连锁不平衡，逆方差加权的方差会被低估，置信区间偏窄。

工具强度不构成问题。67 个候选位点的 F 统计量均值为 70.6、中位数 42.1、最小 29.9（rs3800229）、最大 716（rs1421085），无一低于 10。F 值大于 10 只是弱工具偏倚的经验性提示，不是工具有效性的证明 [18]。此外，该诊断基于 67 个候选位点，而全部因果估计基于位点协调后的 64 个位点（见第 5 节）。

## 5 位点协调

| 步骤 | 位点数 |
|---|---|
| 暴露侧工具变量 | 67 |
| 结局数据中缺失 | 1（rs4438957，未使用替代位点） |
| 可配对 | 66 |
| 回文且链向不明 | 2 |
| 因回文链向不明剔除 | 2 |
| 因其他原因剔除 | 0 |
| 最终纳入分析 | 64 |

协调过程中未使用代理位点。所有因果估计、异质性检验、多效性检验与方向性检验均基于这 64 个位点。

## 6 主要估计与敏感性分析

| 方法 | 位点数 | β（标准误） | P 值 | OR（95% CI） |
|---|---|---|---|---|
| 逆方差加权（主分析） | 64 | 0.427（0.0645） | 3.5×10⁻¹¹ | 1.53（1.35–1.74） |
| MR-Egger | 64 | 0.524（0.153） | 0.001 | 1.69（1.25–2.28） |
| 加权中位数 | 64 | 0.384（0.0783） | 9.5×10⁻⁷ | 1.47（1.26–1.71） |
| 加权众数 | 64 | 0.379（0.0987） | 2.9×10⁻⁴ | 1.46（1.20–1.77） |
| 简单众数 | 64 | 0.330（0.151） | 0.03 | 1.39（1.04–1.87） |

β 为对数比值比尺度上的效应量。五种方法方向一致，均提示正相关；点估计在 1.39 至 1.69 之间，各方法的置信区间互有重叠。加权中位数与众数允许部分工具变量无效，MR-Egger 允许存在方向性多效性但精度较低，两者结论未与主分析冲突 [9,10,11,12]。

剔除 2 个离群位点（rs6713510、rs7903146）后，逆方差加权 β 0.465（标准误 0.0543），P = 4.6×10⁻¹²，OR 1.59（1.43–1.77）。该值高于未校正的 1.53，说明被识别为离群的位点使主分析结果偏低，也说明主分析对工具子集的选择部分敏感 [13]。失真检验 P = 0.52，未提示校正前后估计存在统计学差异。污染混合模型给出 β 0.465（95% CI 0.365–0.605），1 个一致性区间，P = 3.0×10⁻¹⁰，与离群值校正后的逆方差加权结果量级一致 [15]。

反向孟德尔随机化未做，本次只要求正向方向。用于评估回归稀释（测量误差）的诊断统计量也未做 [20]。多种敏感性方法之间未作多重比较校正，它们是对同一参数的重复估计，而非相互独立的假设检验。

## 7 异质性与多效性诊断

异质性检验给出 Cochran Q（逆方差加权）= 123（自由度 63），P = 1.0×10⁻⁵；MR-Egger 框架下 Q = 122（自由度 62），P = 8.9×10⁻⁶。位点间效应量的离散程度超出随机波动可以解释的范围。多效性方面，MR-Egger 截距为 −0.00309（标准误 0.00443），P = 0.49，未见方向性多效性的证据。离群值检验则给出不一致的计数：MR-PRESSO 全局检验 P < 0.001，经 1,280 次分布模拟识别出 2 个离群位点（rs6713510、rs7903146），离群判定分辨率为 0.05，未超过提示离群集不稳定的水平；Radial MR 全局 Q 检验 P = 1.7×10⁻⁵，识别出 8 个离群位点 [13,14]。

两条线索并不矛盾。MR-Egger 截距只对平均方向性多效性敏感，位点间异质性却可以由少数几个离群位点造成。据此可以读作：没有证据表明多效性在整体上朝同一方向作用，但少数位点很可能违反了排他性假设，且这些位点使主分析的估计偏低。

## 8 方向性检验

方向性检验已计算：纳入 64 个位点，判定因果方向为暴露指向结局，暴露侧解释方差（r² 0.0140）高于结局侧（r² 0.00111），P = 1.9×10⁻¹⁹² [16]。该检验按每个位点的 P 值与样本量近似其解释方差，并把两个性状都当作连续变量处理。结局是病例对照设计，所以这里得到的只是观察尺度上的近似，它既不能排除双向作用，也不构成方向性的独立证据。

## 9 因果推断的三项核心假设逐条评估

相关性这一环最稳固。64 个位点的 F 统计量均远高于 10（候选位点最小 29.9）。但位点独立性未经连锁不平衡验证（第 4 节），估计的精度可能因此被高估。

独立性无法从本次分析输出中直接检验。暴露数据来自以欧洲祖源为主的多种群联合分析，结局数据仅 75.28% 为欧洲裔，人群分层可同时影响 BMI 与 CAD 相关等位基因的频率；缺少祖源匹配的连锁不平衡参考使分层控制更不充分。这是本设计最薄弱的一环。

排他性同样不能直接检验。MR-Egger 截距与离群值失真检验均未提示系统性违反，但离群值检验识别出 2 至 8 个可疑位点，提示至少部分位点可能通过 BMI 以外的通路影响 CAD，「全部工具变量均满足排他性」这一前提因而不能成立。

此外，连续暴露下的回归稀释（测量误差）诊断未提供，与暴露相关的基因—环境交互也未被评估。

## 10 人群构成与样本重叠

暴露研究的人群以欧洲祖源为主（约 99.09%），含小规模非裔与西班牙或拉丁裔分层；结局研究包含欧洲、南亚、东亚、西班牙或拉丁裔、非裔与大中东六类祖源分层，欧洲裔占 75.28%。两个来源的人群并不重合，这是两样本设计可以成立的前提之一，也意味着工具变量在暴露侧主要由欧洲祖源样本驱动。

参与者重叠则无法判定。来源记录未列出具体队列名单，重叠人数、偏倚方向与幅度均无法从现有记录确定。在两样本设计中，若两侧共享参与者，估计会朝混杂的观察性关联方向偏移 [17]。因此本报告的估计不能被表述为「来自完全独立样本」。

结果主要适用于欧洲祖源人群。对非欧洲人群的外推非常有限，也不适用于评估个体干预效果。

## 11 量纲与结果解释

暴露与结局的量纲在两个来源的记录中均未作声明，本次分析也未做单位换算。因此表中的比值比表示「每 1 个来源暴露单位」。已发表的另一项 BMI 与 CAD 的孟德尔随机化研究以每 1 个标准差（约 4.6 kg/m²）为单位报告效应 [5]，本研究不据此换算：把单位假定为 kg/m² 或标准差都会改变效应的绝对尺度，而来源记录没有提供支持这一假定的依据。

## 12 与既有证据的关系

Holmes 等（2014）以 14 个 BMI 位点构成遗传评分，在 6,073 例冠心病病例中未发现每 1 kg/m² 遗传预测 BMI 升高对应冠心病风险增加（OR 1.01，95% CI 0.94–1.08），与已发表研究合并后为 OR 1.04（0.97–1.12）[6]。Dale 等（2017）使用 97 个 BMI 位点，以 CARDIoGRAMplusC4D 作为冠心病结局来源，报告每 1 个标准差 BMI 升高对应冠心病 OR 1.36（1.22–1.52）[5]。还有一项系统评价汇总了多个危险因素与冠状动脉疾病、卒中的孟德尔随机化研究，认为人类学测量指标（含 BMI）、血脂与脂蛋白、2 型糖尿病是其中相对稳健的关联，所纳入的大量关联并不稳健 [7]。

本次逆方差加权结果（OR 1.53，1.35–1.74）与 Dale 等的方向一致。两者都以 Locke 等 2015 年的 BMI 汇总统计作为工具来源，工具集高度重叠，因此本结果对该关联不构成独立复制。Holmes 等的早期零结果基于远少的位点与小得多的病例数，与本次结果不直接可比。

与观察性证据相比，本设计在工具变量假设成立时不受反向因果与常见混杂的影响；但它估计的是终生暴露差异的效应，不等于成年期减重干预的效果 [19]。

## 13 局限

1. 位点独立性未经验证：没有祖源匹配的连锁不平衡参考，只按距离窗口近似，连锁不平衡从未被测量，相关的方差低估风险始终存在。
2. 暴露样本并非纯欧洲祖源（含 2,163 名非欧洲祖源个体），结局样本欧洲裔仅占 75.28%；跨祖源汇总可能引入分层偏倚。
3. 暴露量纲未声明，效应量的绝对尺度不可与其他研究直接比较。
4. 位点级样本量信息不对称：暴露侧有位点级样本量（218,359–339,205）且与来源合计 238,944 不一致；结局侧没有位点级样本量，全部分析按 187,599 这一单一数值处理，因此无法核实各结局位点是否在相同样本量下被分析。
5. 异质性显著且存在离群位点：校正离群位点后估计升高（1.53 → 1.59），说明结果对工具子集的选择部分敏感。
6. 参与者重叠未知：两个来源是否共享参与者无法判定，偏倚方向与幅度未确定。
7. 方向性检验为观察尺度上的近似，不能作为方向性的独立证据。
8. 未做反向分析、未提供回归稀释诊断；多种稳健方法针对同一参数，未作多重比较校正。
9. 分析全部基于汇总统计，未使用个体水平数据，也无法对队列名单逐一核对。
10. 结果不适用于个体临床决策，不构成剂量或用药建议。
11. 本报告按孟德尔随机化研究报告规范（STROBE-MR）[8] 组织；其中研究方案注册、预设分析计划等条目在本次基于公开汇总统计的两样本分析中无法提供，已在正文中逐项说明相应限制。

## 14 结论

在工具变量三项核心假设成立的前提下，遗传预测的 BMI 偏高与 CAD 风险升高方向一致，且量级不小：逆方差加权 OR 1.53（95% CI 1.35–1.74），P = 3.5×10⁻¹¹，四种替代估计与两种稳健方法结果同向。支持这一判断的是多个方法一致的结果；削弱它的因素更多：工具独立性未被验证，工具间异质性显著，离群位点使估计在 1.53 与 1.59 之间变动，暴露量纲未定。综合把握程度因此记为中等。有三种结果会推翻或明显削弱这一判断：在祖源匹配的连锁不平衡参考下重新选择工具变量后估计消失；参与者重叠可量化并校正后估计向无效值移动；结局位点级样本量显示各工具所分析的样本存在系统性差异。无论出现哪一种，本结果都不能转化为针对个体的诊疗建议。

## 参考文献

1. Locke AE, Kahali B, Berndt SI, et al. Genetic studies of body mass index yield new insights for obesity biology. Nature. 2015;518(7538):197-206. https://doi.org/10.1038/nature14177
2. NHGRI-EBI GWAS Catalog. Body mass index, study GCST002783. https://www.ebi.ac.uk/gwas/studies/GCST002783
3. Nikpay M, Goel A, Won HH, et al. A comprehensive 1000 Genomes-based genome-wide association meta-analysis of coronary artery disease. Nature Genetics. 2015;47(10):1121-1130. https://doi.org/10.1038/ng.3396
4. NHGRI-EBI GWAS Catalog. Coronary artery disease, study GCST003116. https://www.ebi.ac.uk/gwas/studies/GCST003116
5. Dale CE, Fatemifar G, Palmer TM, et al. Causal associations of adiposity and body fat distribution with coronary heart disease, stroke subtypes, and type 2 diabetes mellitus: a Mendelian randomization analysis. Circulation. 2017;135(24):2373-2388. https://doi.org/10.1161/CIRCULATIONAHA.116.026560
6. Holmes MV, Lange LA, Palmer T, et al. Causal effects of body mass index on cardiometabolic traits and events: a Mendelian randomization analysis. American Journal of Human Genetics. 2014;94(2):198-208. https://doi.org/10.1016/j.ajhg.2013.12.014
7. Georgiou AN, Zagkos L, Markozannes G, et al. Appraising the causal role of risk factors in coronary artery disease and stroke: a systematic review of Mendelian randomization studies. Journal of the American Heart Association. 2023;12(20). https://doi.org/10.1161/JAHA.122.029040
8. Skrivankova VW, Richmond RC, Woolf BAR, et al. Strengthening the reporting of observational studies in epidemiology using Mendelian randomization: the STROBE-MR statement. JAMA. 2021;326(16):1614-1621. https://doi.org/10.1001/jama.2021.18236
9. Burgess S, Butterworth A, Thompson SG. Mendelian randomization analysis with multiple genetic variants using summarized data. Genetic Epidemiology. 2013;37(7):658-665. https://doi.org/10.1002/gepi.21758
10. Bowden J, Davey Smith G, Burgess S. Mendelian randomization with invalid instruments: effect estimation and bias detection through Egger regression. International Journal of Epidemiology. 2015;44(2):512-525. https://doi.org/10.1093/ije/dyv080
11. Bowden J, Davey Smith G, Haycock PC, Burgess S. Consistent estimation in Mendelian randomization with some invalid instruments using a weighted median estimator. Genetic Epidemiology. 2016;40(4):304-314. https://doi.org/10.1002/gepi.21965
12. Hartwig FP, Davey Smith G, Bowden J. Robust inference in summary data Mendelian randomization via the zero modal pleiotropy assumption. International Journal of Epidemiology. 2017;46(6):1985-1998. https://doi.org/10.1093/ije/dyx102
13. Verbanck M, Chen CY, Neale B, Do R. Detection of widespread horizontal pleiotropy in causal relationships inferred from Mendelian randomization between complex traits and diseases. Nature Genetics. 2018;50(5):693-698. https://doi.org/10.1038/s41588-018-0099-7
14. Bowden J, Del Greco M F, Minelli C, et al. Improving the accuracy of two-sample summary-data Mendelian randomization: moving beyond the NOME assumption. International Journal of Epidemiology. 2019;48(3):728-742. https://doi.org/10.1093/ije/dyy258
15. Burgess S, Foley CN, Zuber V. A robust and efficient method for Mendelian randomization with hundreds of genetic variants. Nature Communications. 2020;11:376. https://doi.org/10.1038/s41467-019-14156-4
16. Hemani G, Tilling K, Davey Smith G. Orienting the causal relationship between imprecisely measured traits using GWAS summary data. PLoS Genetics. 2017;13(11):e1007081. https://doi.org/10.1371/journal.pgen.1007081
17. Burgess S, Davies NM, Thompson SG. Bias due to participant overlap in two-sample Mendelian randomization. Genetic Epidemiology. 2016;40(7):597-608. https://doi.org/10.1002/gepi.21998
18. Burgess S, Thompson SG. Avoiding bias from weak instruments in Mendelian randomization studies. International Journal of Epidemiology. 2011;40(3):755-764. https://doi.org/10.1093/ije/dyr036
19. Davies NM, Holmes MV, Davey Smith G. Reading Mendelian randomisation studies: a guide, glossary, and checklist for clinicians. BMJ. 2018;362:k601. https://doi.org/10.1136/bmj.k601
20. Bowden J, Del Greco M F, Minelli C, Davey Smith G, Sheehan NA, Thompson JR. Assessing the suitability of summary data for two-sample Mendelian randomization analyses using MR-Egger regression: the role of the I2 statistic. International Journal of Epidemiology. 2016;45(6):1961-1974. https://doi.org/10.1093/ije/dyw220
