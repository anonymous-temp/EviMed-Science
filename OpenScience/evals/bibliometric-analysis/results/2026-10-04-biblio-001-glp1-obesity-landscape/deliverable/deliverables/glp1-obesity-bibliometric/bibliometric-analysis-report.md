# GLP-1 受体激动剂用于肥胖与体重管理的文献计量分析（2015–2025）

## 摘要与结论

本次分析以 2026-10-04 对 MEDLINE（经 PubMed）的一次可复现检索为基础，纳入 1,236 条书目记录，用共词网络、社区检测、突现词探测与综合前沿评分刻画该主题的产出趋势、知识结构与研究前沿。

- 产出集中在最近两年。样本中 2024 年 234 条、2025 年 602 条，合计 836 条，占全部记录的 67.6%；2015 至 2020 年各年都不到 30 条。这一跃升对应的是研究活动的规模变化，不构成任何疗效证据。
- 产出结构偏整合、少原始对照。1,190 条期刊论文中标注为综述的有 596 条、系统综述 80 条、Meta 分析 52 条，而标注为随机对照试验的仅 32 条、比较研究 36 条、观察性研究 15 条。综述与整合类文献密集，是扩张期的常见形态，也意味着头对头随机对照与真实世界安全性研究在文献层面可见度低。
- 主题结构弥散。关键词共现网络取频次最高的 50 个节点、构建 1,023 条边，模块度 Q 仅 0.0508、平均轮廓系数 0.0406，未形成可解释的社区分区。Obesity 的中介中心性 0.7830 明显高于其他节点，是全网的唯一枢纽；Semaglutide、Liraglutide 等药名虽频次居前，跨子域桥接作用弱。
- 作者结构高度碎片化。6,458 个作者姓名中 5,893 个（91%）只出现 1 次，产出最高者 11 条。作者合作网络在 27 个节点间仅 39 条边，密度 0.1111。Lotka 拟合指数 3.40（R² = 0.982），明显偏离常见的经验值。
- 国家产出集中于美英中。美国 388 条、英国 141 条、中国 125 条，三者合计占表中 20 个国家署名次数的 49.1%〔推算〕。丹麦以 64 条居第五，与 Novo Nordisk、哥本哈根大学的机构产出同时出现。
- 前沿信号偏弱但方向明确。综合前沿评分中仅 GLP-1 receptor agonists 同时具备突现强度（11.0）与高增长（得分 0.634）；weight regain、skeletal muscle、Alcoholism、Endometrial cancer、Reward、Mounjaro、childhood obesity、Pharmacovigilance、Craniopharyngioma 等 9 个主题并列为 0.600，突现强度均为 0，属萌芽状态。
- 引用类指标不可用于全样本。该模块只有 36 条记录取得外部引用观测（覆盖 3%），本节所有引用指标只描述这 36 条，不能外推。

本次结果描述的是一个既定检索策略下的选入文献集，不是该领域的全集。所有结论都是研究活动与主题结构的度量，不涉及药物有效性或安全性判断，也不能用于任何个体用药决策。

## 1. 范围与问题

分析对象是「GLP-1 受体激动剂用于肥胖与体重管理」这一主题在 2015 至 2025 年间的文献产出。要回答的是三类问题：产出随时间的规模变化如何，知识结构由哪些主题与主体的连接构成，以及哪些方向正在形成新的关注点。

**概念口径。** 本报告只刻画以「GLP-1 receptor agonists」这一概念检索到的记录。检索式为标题/摘要限定，因此仅以个别药物商品名或通用名（如 semaglutide、liraglutide）出现、而不出现该概念短语的肥胖相关研究不进入样本；双靶点或三靶点共激动剂（如 tirzepatide、survodutide）只有在同时出现该概念短语时才被纳入。这一口径的取舍在局限性一节展开。

## 2. 数据与方法

### 2.1 检索与检索式

检索经 NCBI E-utilities 接口对 PubMed 执行，检索完成时间 2026-10-04T07:13:55Z，排序为 relevance，配置的取回上限为 5,000 条。实际使用的完整检索式为：
```
("GLP-1 receptor agonists"[Title/Abstract]) AND ("Obesity"[MeSH Terms] OR "obesity"[Title/Abstract] OR "Overweight"[Title/Abstract] OR "Adiposity"[Title/Abstract] OR "Corpulence"[Title/Abstract]) AND ("2015/01/01"[Date - Publication] : "2025/12/31"[Date - Publication])
```

其中肥胖概念经主题词查询得到 MeSH 描述符 Obesity（D009765），并纳入 Overweight、Adiposity、Corpulence 等入口词；GLP-1 受体激动剂概念的主题词查询未成功返回描述符，该概念最终以标题/摘要自由词形式进入检索式。这一回退使该概念的召回依赖作者是否在标题或摘要中使用该短语。

检索命中 1,241 条，取回 1,238 条书目记录（占命中数 99.8%），按年份归组后 1,236 条，未触及 5,000 条上限。报告中的一切计数均以这 1,236 条为分母；凡涉及引用观测等下位集合时，另行标明其自身样本量。

入选记录中包含该主题几项关键随机对照试验，例如司美格鲁肽每周一次治疗超重或肥胖的试验 [11]、替尔泊肽每周一次治疗肥胖的试验 [12] 与司美格鲁肽在无糖尿病人群中的心血管结局试验 [13]；近期的证据整合类文献同样可见，如 GLP-1 受体激动剂及其共激动剂与心房颤动风险的随机对照试验 Meta 分析 [14]、以及 GLP-1 受体激动剂治疗非糖尿病肥胖的经济学评价 Meta 分析 [15]。列出这几条只用于说明样本由哪些具体文献构成，本报告不重复其疗效或经济学结论。

### 2.2 记录清洗

记录由 PubMed XML 解析，作者姓名规范为「姓 名字首字母」，机构经模式匹配抽取，MeSH 主题词与作者关键词合并为一个关键词集合，并剔除 Humans、Male、Female 等无区分度的人口学限定词；重复记录经 PMID 与标准化标题识别，去重后 1,236 条。记录同时保留原始书目字段与检索元数据。

### 2.3 网络构建与统计

- **共现网络。** 关键词、作者、机构、国家四类实体分别构建共现矩阵，节点按频次降序选取，再剔除孤立节点。关键词网络保留 50 个节点（候选 901 个）、作者网络保留 30 个节点（候选 515 个）、国家网络保留 10 个节点（候选 41 个）。连接强度为实体的同现次数，可视化沿用 VOSviewer 的映射与聚类约定 [7]。
- **社区检测。** 采用 Louvain 算法 [2]，并以模块度 Q [6] 与平均轮廓系数评估分区质量；中心性报告度中心性、中介中心性与接近中心性。
- **突现词。** 采用 Kleinberg 突现检测 [4] 识别频率短期跃升的关键词，输出突现强度与起止年份。
- **前沿评分。** 由近期增长率（权重 35%）、突现得分（25%）、新颖性（25%）与网络中心性（15%）经最小—最大归一化合成；新颖性定义为关键词首次出现时间在研究期内的相对位置。该权重方案为本方法配置的一部分。
- **文献计量定律。** 以 log-log 最小二乘回归拟合作者产出分布（Lotka）[5]、期刊分区（Bradford，按等文献量划分三区）[3] 与关键词频率—排名分布（Zipf）[8]。上述映射流程的整体设计参照 bibliometrix 的 science mapping 框架 [1]。
- **集中度。** 国家集中度按各国署名份额的平方和计算 [9]，其输入与含义见 3.2。
- **年份字段。** 年度计数所依据的字段按其定义处理 [10]。
- **引用观测。** 引用计数来自外部引用服务，覆盖不足，处理方式见 3.6。

### 2.4 年份字段

年度计数基于记录的期刊/卷期年份，与检索式使用的出版日期过滤字段不是同一字段。检索元数据记载年份来源中 1,232 条为期刊期号年、4 条为 Medline 日期。样本中实际出现的年份跨 2015—2026，共 12 个年份。

## 3. 结果

### 3.1 年度分布

![按记录年份的文献量](figures/annual_trend_records.png)

表 1. 按记录年份的记录数（n = 1,236）

| 记录年份 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 记录数 | 17 | 18 | 14 | 27 | 21 | 28 | 42 | 63 | 75 | 234 | 602 | 95 |

2015 至 2020 年合计 125 条（10.1%），2021 至 2023 年合计 180 条（14.6%），2024 与 2025 年合计 836 条（67.6%）。三项份额由年度计数算出〔推算〕。曲线的陡升出现在 2024 年，2025 年为样本峰值。

关于 2026 年的 95 条记录需要单独说明：检索式的出版日期过滤区间截至 2025-12-31，而这 95 条记录的期刊年份落在 2026 年。检索记录本身不足以解释这一现象，出版日期字段与期刊期号年份不一致、索引或预出版流程都有可能是来源，本报告因此把它列为未解释现象，并同时给出含与不含这 95 条的两种份额（不含时 2024 与 2025 年合计占 67.6%，含时 2024 至 2026 三年合计 931 条、占 75.3%）〔推算〕。检索完成于 2026-10-04，2025 与 2026 两个年份的覆盖程度都未经确认，年度计数不应被读作完整年度产出。

### 3.2 主要贡献者

**作者。** 1,236 条记录涉及 6,458 个作者姓名（未做身份消歧）。产出最高者为 Holst Jens J 与 Butler Javed（各 11 条），其后为 Koufakis Theocharis、Rizzo Manfredi、Vilsbøll Tina（各 9 条），Davies Melanie J 与 Nauck Michael A（各 8 条），Karakasis Paschalis、Patoulias Dimitrios、Fragakis Nikolaos（各 7 条）。最高产者也只占样本的不足 1%。

表 2. 高产作者（前 10 位）

| 作者 | 记录数 |
|---|---|
| Holst Jens J | 11 |
| Butler Javed | 11 |
| Koufakis Theocharis | 9 |
| Rizzo Manfredi | 9 |
| Vilsbøll Tina | 9 |
| Davies Melanie J | 8 |
| Nauck Michael A | 8 |
| Karakasis Paschalis | 7 |
| Patoulias Dimitrios | 7 |
| Fragakis Nikolaos | 7 |

作者合作网络经筛选后保留 27 个节点、39 条边，密度 0.1111，含 5 个连通分量，最大分量 14 个节点。Lotka 拟合指数 3.40（R² = 0.982，p < 0.001），明显偏离约 2.0 的经验值；6,458 个作者姓名中 5,893 个（91%）只出现 1 次。合作者构成的连通分量规模都不大，稳定的高产学术共同体尚未成形。

**机构。** 产出最高的机构是国家卫生服务体系（National Health Service，53 条），其后为哈佛医学院（40 条）、哥本哈根大学（39 条）、梅奥诊所（30 条）、诺和诺德（Novo Nordisk，17 条）、加利福尼亚大学系统（15 条）与多伦多大学（15 条）、贝勒医学院（13 条）、加州大学洛杉矶分校（12 条）。

表 3. 高产机构（前 10 位）

| 机构 | 记录数 |
|---|---|
| National Health Service | 53 |
| Harvard Medical School | 40 |
| University of Copenhagen | 39 |
| Mayo Clinic | 30 |
| Novo Nordisk | 17 |
| University of California | 15 |
| University of Toronto | 15 |
| Baylor College of Medicine | 13 |
| University of California, Los Angeles | 12 |
| s Hospital（名称被截断） | 12 |

榜单中有一所机构名称在抽取阶段被截断，仅保留「s Hospital」这一片段，其排名与合并均受影响。机构层级也未统一消歧，加利福尼亚大学系统与各分校即分列两行，因此机构排名只能视为近似结果。榜单以临床与学术机构为主，产业机构可见度有限。

**期刊。** 1,236 条记录分布于 585 种期刊。载文最多的是 Cureus（52 条），其后为 Diabetes, Obesity and Metabolism（35 条）、Journal of Clinical Medicine（26 条）、Frontiers in Endocrinology 与 Biomedicines（各 19 条）、International Journal of Molecular Sciences（18 条）、The Journal of Clinical Endocrinology and Metabolism（14 条）、Obesity Surgery（11 条），以及 Frontiers in Pharmacology 与 Nutrients（各 10 条）。前三名分属两类刊物：综合性开放获取期刊与内分泌代谢专业期刊。Bradford 三区划分为 37 / 144 / 404 种期刊（每区 412 条），第二区与第一区的期刊数比为 3.89。

**国家与地区。** 记录共归属 41 个国家或地区（同一记录可含多个国家）。美国 388 条居首，其后依次为英国 141 条、中国 125 条、意大利 103 条、丹麦 64 条、德国 51 条、加拿大 49 条、西班牙 47 条、澳大利亚 43 条、印度 38 条。

表 4. 国家/地区分布（前 10 位）

| 国家/地区 | 记录数 |
|---|---|
| United States | 388 |
| United Kingdom | 141 |
| China | 125 |
| Italy | 103 |
| Denmark | 64 |
| Germany | 51 |
| Canada | 49 |
| Spain | 47 |
| Australia | 43 |
| India | 38 |

表中所列 20 个国家/地区合计出现 1,332 次，超出 1,236 条记录数，说明多国合作署名普遍；全部国家节点在合作数据中共 41 个，合计 1,534 次，表中 20 个占其中的 86.8%。

以表内 1,332 次为分母〔推算〕，美国占 29.1%，英国 10.6%，中国 9.4%，前三名合计 49.1%，前五名合计 61.6%；按各国份额平方和计算的集中度为 0.124。若改以全部 41 个国家的 1,534 次为分母，同一口径下的前三名合计为 42.6%、前五名 53.5%、集中度 0.0943。两组数并列给出是因为分母取表内还是取全部国家会明显改变结论强度，而两种取法都说得通。份额的输入是各国出现频次，算法是份额及其平方和，没有模型拟合；分母为署名次数而非记录数，所以这里的百分数读作署名份额，不是论文份额。丹麦以 64 条进入前五，同时出现的高产出机构包括 Novo Nordisk（17 条）与哥本哈根大学（39 条），小国在特定治疗领域形成超比例产出聚集的迹象在此可见。

### 3.3 知识结构

![关键词共现网络](figures/keyword_network.png)

关键词网络由频次最高的 50 个节点（候选 901 个）与 1,023 条边构成。频次最高的主题词为 Obesity（717）、Glucagon-Like Peptide-1 Receptor Agonists（564）、Diabetes Mellitus, Type 2（408）、Hypoglycemic Agents（383）、Weight Loss（285）、GLP-1 receptor agonists（284）、Glucagon-Like Peptide 1（251）、Semaglutide（204）。药名类关键词中，Semaglutide 204 次、Liraglutide 130 次、Tirzepatide 104 次、Exenatide 57 次。

网络的连接看似密集，社区结构却不成立：模块度 Q 为 0.0508，平均轮廓系数 0.0406，两者都远低于可解释的阈值，Louvain 检出的分区不能当作研究群落的划分来读。网络结构更接近主题之间的连续过渡。中心性方面，Obesity 的中介中心性为 0.7830，是该网络中唯一的高枢纽，它连接的是代谢机制、心血管结局与行为干预这几片区域；Glucagon-Like Peptide-1 Receptor Agonists 次之（0.1847）。Semaglutide 与 Liraglutide 词频居前而中介中心性偏低，这些药名更多以标签形式出现，尚未承担跨子域桥接的角色。

![关键词词云](figures/keyword_wordcloud.png)

时间演化聚类给出的同样是宽泛标签，不是精确分区。三个聚类的标签分别为 Research: Glucagon, Peptide, Receptor、Mechanisms: Glucagon, Peptide, Receptor 与 Mechanisms: Obesity, Glucagon, Receptor，活动区间均为 2015—2026 年，峰值年均为 2025 年。三者在标签上高度重叠，更像是同一主题的不同表述被算法分开；鉴于模块度偏低，本节聚类结果只作时间背景使用。

![聚类时间演化](figures/timeline_clusters.png)

关键词频率—排名回归的观测指数为 0.79（R² = 0.9081，p < 0.001）。这一指数低于 Zipf 定律的经典取值 1，回归拟合虽好，却不能读作定律得到验证；可以确认的只是关键词使用呈头部集中形态，即少数关键词覆盖了大部分记录。

### 3.4 研究热点与突现

![突现词时间演化](figures/burst_terms.png)

突现检测共识别出一批频率短期跃升的关键词，最强的几个为：

表 5. 突现强度居前的关键词

| 关键词 | 突现强度 | 突现区间 | 持续年数 |
|---|---|---|---|
| Diabetes Mellitus, Type 2 | 80.0 | 2022–2023 | 2 |
| Glucagon-Like Peptide 1 | 53.0 | 2022–2023 | 2 |
| Glucagon-Like Peptide-1 Receptor | 52.0 | 2015–2021 | 7 |
| Blood Glucose | 35.0 | 2018–2022 | 5 |
| Liraglutide | 31.0 | 2015–2020 | 6 |
| Cardiovascular Diseases | 30.0 | 2019–2023 | 5 |
| Insulin | 28.0 | 2015–2023 | 9 |
| Exenatide | 26.0 | 2015–2021 | 7 |
| Body Weight | 25.0 | 2016–2023 | 8 |
| glucagon-like peptide-1 | 23.0 | 2018–2023 | 6 |

早期突现由具体药物主导（Exenatide 2015–2021、Liraglutide 2015–2020），2022 年之后重心转向 Diabetes Mellitus, Type 2 与 Glucagon-Like Peptide 1；这两项的突现窗口都只有两年，更像阶段性峰值，而不是长期趋势。Blood Glucose、Insulin、Body Weight 的窗口跨越六至九年，属于持续存在的基础关注点。Cardiovascular Diseases 自 2019 年起持续突现，时间上与减重药物结局试验的集中报道方向一致。

### 3.5 研究前沿

按综合评分排序的前沿主题如下，评分由增长、突现、新颖度与中心性四项归一化后加权得到，权重分别为 35%、25%、25%、15%：

表 6. 前沿主题（按评分排序，前 10 位）

| 主题 | 前沿得分 | 增长率 | 突现得分 | 网络中心性 |
|---|---|---|---|---|
| GLP‐1 receptor agonists | 0.634 | 1.00 | 11.0 | 0.0 |
| weight regain | 0.600 | 1.00 | 0 | 0.0 |
| skeletal muscle | 0.600 | 1.00 | 0 | 0.0 |
| Alcoholism | 0.600 | 1.00 | 0 | 0.0 |
| Endometrial cancer | 0.600 | 1.00 | 0 | 0.0 |
| Reward | 0.600 | 1.00 | 0 | 0.0 |
| Mounjaro | 0.600 | 1.00 | 0 | 0.0 |
| childhood obesity | 0.600 | 1.00 | 0 | 0.0 |
| Pharmacovigilance | 0.600 | 1.00 | 0 | 0.0 |
| Craniopharyngioma | 0.600 | 1.00 | 0 | 0.0 |

评分中只有 GLP‐1 receptor agonists 同时具备非零突现强度（11.0）与高增长，其余九项并列 0.600，突现得分为 0。这些主题的增长率同为 1.00，在低基数下即可取得，所以这一列不能读作研究规模已经扩大。它们的定位是「新近出现、值得跟踪」，而不是已形成的研究方向。

同一排序的后续条目包括 muscle loss、GIP receptor agonist、Survodutide、endoscopic sleeve gastroplasty、Substance-Related Disorders、Elective Surgical Procedures、Optic Neuropathy, Ischemic、Osteoarthritis, Hip、nutrition、glucagon-like peptide 1 receptor agonist 等，情况与上述一致：新颖度高、突现强度为零。

把这些条目放在一起看，方向性是可辨识的。体重反弹与骨骼肌指向停药后的体成分变化；酒精使用障碍与奖赏机制指向中枢通路；儿童肥胖、颅咽管瘤与子宫内膜癌指向特殊人群与相关肿瘤风险；药物警戒与「术前管理/择期手术」指向用药人群扩大后的安全性监测与围手术期管理。这些只是提示应当跟踪的主题，不构成任何优先级建议。

### 3.6 引用观测

引用计数由外部引用服务提供，该模块未能完整获取数据：本次仅 36 条记录取得引用观测，覆盖 1,236 条记录的 3%。以下指标只描述这 36 条，未取得引用观测的 1,200 条不计入任何指标，也不作为零引用处理。

- h 指数 24
- 总被引次数 1,610
- 篇均被引次数 44.7
- 被引次数中位数 32.0

篇均高于中位数，这 36 条内部存在右偏，但偏度有限，样本又过小，不宜据此讨论引用分布形态。被引最高的单条记录为 166 次（2015 年）。

引用关系的两项衍生分析同样受覆盖率限制：文献耦合共得到 219 对记录，共被引共得到 59 对。它们的观测来源与上述 36 条相同，只能视为局部示例，不能用于绘制领域引用结构。

### 3.7 两项被报道的分布特征

Lotka 检验给出观测指数 3.40（R² = 0.982，p < 0.001），分布偏离经典洛特卡定律（指数约 2.0），与作者层面的碎片化观察一致。Bradford 分区的期刊数比为 3.89。两项拟合的 p 值都小于 0.001，但 R² 只说明回归对样本点在双对数坐标下的贴合程度，不构成对定律的验证性检验，这里按描述性结果使用。

## 4. 讨论

样本的形态可以概括为「总量快速扩张、结构尚未定型」。2024 与 2025 两年贡献了 67.6% 的记录，同期综述、系统综述与 Meta 分析分别标注 596、80 与 52 条，合计 728 条〔推算，为三项标注数之和〕，远多于标注为随机对照试验的 32 条。文献类型字段可以同时给出多个值，全部 1,236 条记录的类型标注合计 2,379 次，所以这些数字是标注次数，不是互斥的篇数，两者只能作方向性对比。快速扩张的主题里这种形态并不罕见：新制剂与新适应症密集出现时，汇总既有证据的文献会先于新的原始试验积累起来。反过来，若整合类文献长期远多于原始试验，整合能带来的增量会递减。

主题网络的高度弥散与作者结构的碎片化互相印证。Q 值偏低意味着关键词之间没有形成稳定分区，Obesity 单独承担枢纽功能，当前文献的连接方式更接近一切围绕肥胖这一主概念展开，而不是若干子领域各自生长。作者一侧是 91% 的姓名只出现一次、产出上限 11 条，进入这一主题的研究者数量在快速增加，持续投入的团队还没有成形。

地理分布上，美英中三国合计占表内 20 个国家署名次数的 49.1%（若以全部 41 个国家的署名次数为分母则为 42.6%）。丹麦以 64 条进入前五，同时出现诺和诺德与哥本哈根大学两个高产出机构，产业与学术的地理聚集效应在此可见。合作数据中权重最高的几条边都以美国为一端：英美 34 次、美德 22 次、美意 21 次；在 1,236 条记录归属 41 个国家的情况下，高产国家的产出里有相当一部分来自跨国合作，而非单一国家的独立研究。

前沿信号的整体强度偏弱。除主概念外，所有候选主题的突现强度为零，仅凭低基数下的增长率进入榜单。因此可以说的只是：体重反弹、骨骼肌、酒精使用障碍、围手术期与药物警戒等方向有新的文献出现。这些方向是否已成为主流、其临床重要性如何，文献量本身回答不了。

## 5. 局限性

- 单一数据库与单一检索式。分析仅覆盖 PubMed 收录文献，未检索 Scopus、Web of Science、Embase 等来源。
- 概念口径收窄。GLP-1 受体激动剂概念以标题/摘要自由词进入检索式（主题词查询未返回描述符），因此仅在正文提及其他 GLP-1 药物名称、标题与摘要不含该短语的研究被系统性遗漏；以个别药物名为主题的研究同样可能漏检。
- 主题界定。肥胖概念由 MeSH 描述符与入口词覆盖，但未纳入体重管理、减重手术结局等相关但不含肥胖词根的研究。
- 记录集非全集。本次运行取回 1,241 条命中中的 1,238 条，按相关性排序，未触及配置上限；1,236 条入选记录是该检索策略下的样本，代表性未经验证，不能外推为领域全集或完整年度产出。
- 年份字段。年度计数基于期刊/卷期年份，与检索使用的出版日期过滤不是同一字段；样本包含 2026 年的 95 条记录，其成因未被确证，本报告将其作为未解释现象处理，并且不对 2025 与 2026 年作全年推断。
- 引用类证据不完整。引用观测只覆盖 36 条记录（3%），引用指标、文献耦合与共被引分析都不能代表全样本；缺失观测不当作零引用。
- 名称消歧不足。作者与机构名称经启发式规范化，未使用持久标识符去重，同名异人与异名同人都会引入误差；机构榜单中存在名称被截断的条目（「s Hospital」）。
- 索引质量。关键词分析依赖 MeSH 标引与作者关键词，近期文献的主题词标引可能尚不完整，直接影响共现与突现结果。
- 度量边界。文献计量结果刻画的是研究活动与主题结构。文献量、突现强度与前沿评分都不能作为疗效、安全性或治疗优先级的证据，也不能用于个体用药决策。
- 马太效应。高频作者、机构与期刊在共现与中心性度量中天然占优，新兴研究者与小型团队的贡献可能被系统性低估。

## 6. 结论

2015 至 2025 年间，以本检索口径纳入的 GLP-1 受体激动剂与肥胖/体重管理相关文献在 2024 年后出现数量跃升，2024 与 2025 两年合计占样本的 67.6%。同期产出以综述与证据整合类文献为主，随机对照试验的标注数明显偏少。关键词网络未形成可解释的社区分区，Obesity 是唯一的高中介中心性节点；作者层面高度碎片化，91% 的作者只出现一次。国家产出集中在美英中，丹麦凭产业与学术机构聚集进入前五。除主概念外，前沿主题普遍处于萌芽状态，体重反弹、骨骼肌、酒精使用障碍、围手术期管理与药物警戒等方向值得继续跟踪。

上述结论全部来自文献计量度量，说明的是研究活动的规模、分布与主题连接方式。它们既不证明任何药物在肥胖或体重管理中的有效性或安全性，也不能作为处方、剂量或治疗选择的依据。个体用药决定需要依据药品说明书、现行临床指南与个体情况，由有资质的医师或药师判断。

## 参考文献

1. Aria M, Cuccurullo C. bibliometrix: An R-tool for comprehensive science mapping analysis. Journal of Informetrics, 2017, 11(4): 959–975. https://doi.org/10.1016/j.joi.2017.08.007
2. Blondel VD, Guillaume JL, Lambiotte R, Lefebvre E. Fast unfolding of communities in large networks. Journal of Statistical Mechanics: Theory and Experiment, 2008, 2008(10): P10008. https://doi.org/10.1088/1742-5468/2008/10/p10008
3. Bradford SC. Sources of information on specific subjects. Engineering, 1934, 137: 85–86. https://en.wikipedia.org/wiki/Bradford%27s_law
4. Kleinberg J. Bursty and hierarchical structure in streams. Data Mining and Knowledge Discovery, 2003, 7(4): 373–397. https://doi.org/10.1023/A:1024940629314
5. Lotka AJ. The frequency distribution of scientific productivity. Journal of the Washington Academy of Sciences, 1926, 16(12): 317–323. https://www.jstor.org/stable/24529203
6. Newman MEJ. Modularity and community structure in networks. Proceedings of the National Academy of Sciences, 2006, 103(23): 8577–8582. https://doi.org/10.1073/pnas.0601602103
7. van Eck NJ, Waltman L. Software survey: VOSviewer, a computer program for bibliometric mapping. Scientometrics, 2010, 84(2): 523–538. https://doi.org/10.1007/s11192-009-0146-3
8. Zipf GK. Human Behavior and the Principle of Least Effort. Cambridge, MA: Addison-Wesley, 1949. https://archive.org/details/humanbehaviorpri0000zipf
9. US Department of Justice, Federal Trade Commission. Horizontal Merger Guidelines. 2010. https://www.justice.gov/atr/horizontal-merger-guidelines-08192010
10. National Library of Medicine. MEDLINE Data Element (Field) Descriptions: Date of Publication. https://www.nlm.nih.gov/bsd/mms/medlineelements.html
11. Wilding JPH, Batterham RL, Calanna S, et al. Once-Weekly Semaglutide in Adults with Overweight or Obesity. New England Journal of Medicine, 2021, 384(11): 989–1002. https://doi.org/10.1056/NEJMoa2032183
12. Jastreboff AM, Aronne LJ, Ahmad NN, et al. Tirzepatide Once Weekly for the Treatment of Obesity. New England Journal of Medicine, 2022, 387(3): 205–216. https://doi.org/10.1056/NEJMoa2206038
13. Lincoff AM, Brown-Frandsen K, Colhoun HM, et al. Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes. New England Journal of Medicine, 2023, 389(24): 2221–2232. https://doi.org/10.1056/NEJMoa2307563
14. Effect of GLP-1 receptor agonists and co-agonists on atrial fibrillation risk in overweight or obesity: systematic review and meta-analysis of randomized controlled trials. Metabolism: Clinical and Experimental, 2026, 174: 156463. PMID: 41349790. https://doi.org/10.1016/j.metabol.2025.156463
15. GLP-1 receptor agonists for treating obesity without diabetes: A systematic review and meta-analysis of economic evaluations. Diabetes, Obesity and Metabolism, 2026. PMID: 41365841. https://doi.org/10.1111/dom.70322
