# GLP-1 受体激动剂用于肥胖与体重管理——文献计量分析报告（2015–2025）

| 项目 | 内容 |
|---|---|
| 报告标识 | bibliometric-glp1-obesity-2015-2025 |
| 运行编号 | bibliometric-20260909131933-0198338e47d1 |
| 运行终态 | succeeded（2026-09-09T13:27:17Z 确认） |
| 检索日期 | 2026-09-09 |
| 数据源 | MEDLINE（via PubMed），NCBI E-utilities API |
| 请求参数 | 主题「GLP-1 受体激动剂用于肥胖与体重管理」；2015–2025；上限 5,000 条；中文输出 |

> **先读这一节。** 本报告建立在一次真实执行且可复现的检索之上，但实际抓到的语料与题面目标范围对不上，差距的细节见第 2、5 节。本次检索所在的分析环境缺少 `httpx` 依赖，检索式自动生成、中译英、MeSH 映射三个环节失败（日志原文 `No module named 'httpx'`），实际执行的检索式只含 `("GLP-1"[Title/Abstract])` 与日期过滤，**没有任何肥胖/体重管理限定词**；PubMed 按最新优先返回并在 5,000 条上限截断，得到的记录元数据年份集中在 2023–2026，2015–2022 年几乎未进入语料。所以本报告不自称是「2015–2025 年 GLP-1 受体激动剂用于肥胖与体重管理研究的完整全景」。它如实描述本次分析实际执行并采用的语料（2026-09-09 最新约 5,000 篇题名/摘要含 "GLP-1" 的 PubMed 记录，去重后 4,961 篇），逐项标明哪些结论在这份语料上成立、哪些不能外推到题面目标范围，并在第 7 节说明要真正回答题面范围需要什么样的重跑。

---

## 1. 目标范围与交付物

题面要求：对「GLP-1 受体激动剂用于肥胖与体重管理」开展文献计量分析，时间窗 2015–2025（含两端年份），PubMed 检索记录上限 5,000 条，报告语言简体中文。本文档即分析报告本体；随附的 `bibliometric-analysis-run.json` 记录本次检索的终态、实际执行的检索式、语料计数与全部产出文件清单。

本报告只做文献计量信号层面的描述（发文量、合作、主题共现、突现、前沿评分），不对任何药物的疗效、安全性或证据等级作评价，也不构成临床建议。

## 2. 检索策略与实际执行情况

检索于 2026-09-09 通过 NCBI E-utilities 对 MEDLINE（via PubMed）执行。运行记录（`bibliometric-analysis-runs/.jobs/bibliometric-20260909131933-0198338e47d1.log`）与 `output/data/search_metadata.json` 显示：

- **执行故障**：检索式自动生成、中文→英文翻译、MeSH 映射三个环节失败，日志原因为 `LLM生成PubMed检索式失败: … No module named 'httpx'`、`MeSH API error: syntax error: line 2, column 0`。失败后果直接体现在检索式结构上。
- **实际执行的正式检索式**：

```
("GLP-1"[Title/Abstract]) AND ("2015/01/01"[Date - Publication] : "2025/12/31"[Date - Publication])
```

  概念块 1 = 自由词 `GLP-1`（MeSH 映射失败，未用主题词）；概念块 2（受体激动剂、肥胖、体重管理等限定）因翻译与映射失败为空，**未进入检索式**。检索式不含肥胖/体重管理限定，也不含各药物名（semaglutide、liraglutide、tirzepatide、exenatide、dulaglutide 等）的补充扩展；它们只作为文献自带的关键词在语料中出现，不构成检索条件。

- **截断与年份异常**：PubMed 最新优先返回并截断在 `maxRecords=5000`（search_metadata.json：total_found=5000，total_fetched=4987）。按 PMID + 标准化标题去重后纳入 **4,961 篇**（cleaned_records.csv 共 4,961 行；result.json：records=4961）。尽管检索式标注日期过滤至 2025-12-31，记录元数据年份为 2023–2026，其中 2026 年 454 条在 year_trend.csv 中标记为部分年（is_partial=True，年化约 605）。本次得到的不是 2015–2025 全时段样本，而是「最新约 5,000 条含 GLP-1 记录的截断子集」：2023 年 2 篇、2024 年 1,282 篇、2025 年 3,223 篇、2026 年 454 篇。

- **可复现性核验**：同日稍早（12:48–12:57）存在一次同一请求的另一次检索运行（bibliometric-20260909124803-01be2df9dad6）。两次检索的运行记录中上述三个失败逐条一致、实际检索式逐字符一致、抓取与去重计数一致（5,000 / 4,987 / 4,961）；两份语料的全部统计表（year_trend、top_keywords、top_journals、top_countries、top_authors、top_institutions、burst_terms、pub_type_distribution）逐字节相同，仅 cluster_summary.csv 的行序与 frontier_topics.csv 尾部同分主题（score=0.60）的排列次序不同。结论：本报告的语料与结果在相同请求下可复现，差异仅为并列排序的呈现顺序。

- **清洗规则**（按输出报告 `output/report.md` 第 2.3 节转述，并已用数据文件核对）：作者姓名规范化为「姓 名字首字母」；机构按模式匹配提取；合并 MeSH 主题词与作者关键词并剔除 Humans/Male/Female 等限定词；按 PMID 与标准化标题去重。清洗伪影见 4.2（作者名拆分、机构残片）。

## 3. 语料构成

以下数字均出自本次检索的分析输出，可直接复核：

| 指标 | 数值 | 出处 |
|---|---|---|
| 检索命中（上限截断） | 5,000 | data/search_metadata.json（total_found） |
| 实际抓取 | 4,987 | data/search_metadata.json（total_fetched）/ raw_records.json 行数 |
| 去重后纳入 | 4,961 | data/cleaned_records.csv（4,961 行）/ result.json |
| 期刊数 | 1,414 种 | data/cleaned_records.csv（独立测算：journal 字段去重） |
| 国家/地区数 | 42 个 | data/cleaned_records.csv（独立测算：countries 字段按「;」拆分去重） |
| 记录元数据年份 | 2023 年 2 篇；2024 年 1,282 篇；2025 年 3,223 篇；2026 年 454 篇（部分年，年化约 605） | tables/year_trend.csv；与 cleaned_records.csv 的 year 计数一致 |

**语料主题构成（独立测算，口径如下）**：对 raw_records.json 的 4,987 条记录，以关键词集 {obesity, overweight, weight loss, weight management, bariatr, anti-obesity}（小写子串匹配）统计——题名命中 **1,042 / 4,987（20.9%）**；题名或摘要命中 **2,456 / 4,987（49.2%）**。两个口径差异大，说明「含体重管理字样」在摘要层常见（GLP-1 论文常报告体重结局），不能仅凭字样断定研究以体重管理为主旨。另一种视角来自清洗后的合并关键词表（tables/top_keywords.csv）：Obesity 一词计数 1,318、Weight Loss 576、Semaglutide 691、Tirzepatide 361、Liraglutide 330——体重管理是这份「最新 5,000 篇含 GLP-1 文献」里体量最大的主题方向之一，但它是语料自带内容的分布，不是检索限定的结果。关键词计数为合并后逐文献计数，一篇可携带多个关键词，不能与 4,961 直接相除当作「占比」。

## 4. 分析结果

以下各小节结果均由该次分析在语料上计算得出，本报告只转述能在随附数据文件中复核的部分，并标注成立边界。文件路径见第 8 节。

### 4.1 发文趋势

`tables/year_trend.csv` 显示语料窗口内发文量从 2023 年 2 篇升至 2024 年 1,282 篇、2025 年 3,223 篇（窗口内峰值），2026 年 454 篇为不完整年。图件：`output/figures/annual_trend.png`（下图）。

![年度发文趋势](../../bibliometric-analysis-runs/bibliometric-20260909131933-0198338e47d1/output/figures/annual_trend.png)

> 成立边界：这是「截断语料内的年度计数」，不是 2015–2025 全时段趋势。2023→2024 的跳变主要反映 5,000 条上限把更早年份整体切出语料，不能解读为领域在该年爆发式增长；「上升趋势」仅在该截断窗口（2023–2026）内成立。

### 4.2 主要贡献者

- **国家/地区**（tables/top_countries.csv，图 top_countries.png）：United States 1,450、China 808、United Kingdom 426、Italy 342、Canada 250、Denmark 214、Germany 198、India 170、Australia 164、Japan 155（Top10）。国家计数是「记录—国家」关联计数：一篇多国署名的文献会计入多个国家，不能直接换算成国家级发文占比，精确归属需逐篇判定通讯/第一作者，本报告不作该换算。
- **期刊**（tables/top_journals.csv，图 top_journals.png）：Diabetes, Obesity & Metabolism 206、Cureus 178、Frontiers in Endocrinology 81、International Journal of Molecular Sciences 77、Journal of Clinical Medicine 70、Nutrients 65、Frontiers in Pharmacology 49、Biomedicines 49、Diabetes Therapy 42、JAMA 41（Top10）。语料分布于 1,414 种期刊。
- **作者**（tables/top_authors.csv，图 top_authors.png）：Holst Jens J 30、Holst Jens Juul 28、Hartmann Bolette 23、McIntyre Roger S 21、Drucker Daniel J 18、Patoulias Dimitrios 17、Wong Sabrina 17、le Roux Carel W 17、Karakasis Paschalis 16、Butler Javed 16、Le Gia Han 16、Teopiz Kayla M 15……。清洗伪影：Holst Jens J 与 Holst Jens Juul 应为同一作者（Jens J. Holst）的姓名规范化变体，产量统计需合并看待；作者级计数宜在二次合并后再引用。
- **机构**（tables/top_institutions.csv，图 top_institutions.png）：National Health Service 139、Harvard Medical School 138、University of Copenhagen 135、University of Toronto 82、Novo Nordisk 79、Mayo Clinic 77、University of California 57、Yale School of Medicine 38、Baylor College of Medicine 38、Eli Lilly and Company 34……（Top10）。清洗伪影：「s Hospital」（55 篇）是机构名残片，不应视为真实机构；「University of California」与「University of California, Los Angeles」等为粒度不一致的变体。

### 4.3 知识结构（网络与聚类）

网络规模直接读自随附 JSON（节点数/边数，均为达到阈值的头部子集，非语料内全部关系）：

| 网络 | 节点 | 边 | 聚类数 | 数据文件 | 图 |
|---|---|---|---|---|---|
| 关键词共现 | 50 | 1,220 | 3 | data/keyword_network.json | keyword_network.png |
| 作者合作 | 22 | 36 | 5 | data/author_network.json | author_network.png |
| 机构合作 | 20 | 75 | 5 | data/institution_network.json | institution_network.png |
| 国家合作 | 10 | 45 | 1 | data/country_network.json | country_network.png |

![关键词共现网络](../../bibliometric-analysis-runs/bibliometric-20260909131933-0198338e47d1/output/figures/keyword_network.png)

- 高频关键词（tables/top_keywords.csv，图 top_keywords.png，MeSH 词与作者词合并计数，一篇可携带多个）：drug therapy 2,090、therapeutic use 1,696、Glucagon-Like Peptide-1 Receptor Agonists 1,538、metabolism 1,391、Obesity 1,318、Hypoglycemic Agents 1,283、drug effects 1,270、Diabetes Mellitus, Type 2 1,221、Glucagon-Like Peptide 1 1,105、pharmacology 851、complications 736、adverse effects 717、Semaglutide 691、Weight Loss 576、epidemiology 525、GLP-1 505……（前列 30 词见数据表）。
- 聚类（tables/cluster_summary.csv、data/keyword_network.json，图 timeline_clusters.png）：Louvain 识别 3 个关键词聚类。按各聚类内节点权重合计与 cluster_summary.csv 的 total_activity 对账（12,562 / 5,591 / 9,659 完全吻合），标签与规模为——「Therapeutics: Drug, Glucagon, Receptor」（activity 12,562，17 节点）、「Mechanisms: Glucagon, Drug, Peptide」（activity 9,659，20 节点）、「Mechanisms: Obesity, Glucagon, Drug」（activity 5,591，13 节点，其代表性关键词含 Obesity、Semaglutide、Weight Loss、Tirzepatide、Liraglutide）。三个聚类的 start/end/peak 年均为 2024–2026/2025（tables/cluster_summary.csv）。
- 聚类质量（仅见于输出报告 `output/report.md` 文字部分，无独立数据文件）：模块度 Q = 0.1004、平均轮廓系数 S = 0.3396。Q 低于 0.3 属弱社区结构，聚类边界与标签的解读应保持谨慎；弱结构部分源于语料本身是单一药物家族的近期文献，主题边界天然模糊。

![主题演化时间线](../../bibliometric-analysis-runs/bibliometric-20260909131933-0198338e47d1/output/figures/timeline_clusters.png)

### 4.4 突现词与研究前沿

- 爆发词检测采用 Kleinberg 自动机（tables/burst_terms.csv，图 burst_terms.png）。窗口内主要爆发词（term / 区间 / 强度 / 持续年数）：epidemiology（2026，91.0，1 年）、Receptors, G-Protein-Coupled（2024，24.0，1 年）、Glucagon-Like Peptide-2 Receptor（2024，24.0，1 年）、mortality（2026，23.0，1 年）、Postoperative Complications（2026，17.0，1 年）、Incidence（2026，16.0，1 年）、Propensity Score（2026，15.0，1 年）、Aged, 80 and over（2026，15.0，1 年）、GLP‐1 receptor agonists（2026，14.0，1 年）、GLP‐1 analogue（2026，12.0，1 年）。
- 前沿评分（tables/frontier_topics.csv）居前者：epidemiology（0.85）、drug therapy（0.75）、Receptors, G-Protein-Coupled / Glucagon-Like Peptide-2 Receptor（0.666）、mortality（0.663）、metabolism（0.653）、Postoperative Complications（0.647）、Incidence（0.644）、Propensity Score（0.641）等。输出报告说明的综合前沿评分权重为近期增长率 35%、爆发强度 25%、新颖性 25%、网络中心性 15%，其中「新颖性」定义为关键词在研究窗口内首次出现的相对位置（越靠后越新）（`output/report.md` 第 2.5 节）。
- **成立边界**：爆发与前沿指标完全基于 2023–2026 截断窗口，爆发区间多为 2024 或 2026 的**单年**事件；「近期增长率 100%、新颖性 1.0」式打分是短窗口与逐年首现算法的产物，**不应外推为 2015–2025 的真实研究前沿**。epidemiology、mortality、Postoperative Complications、Incidence、Propensity Score 等突现词更宜读作：该时段内 GLP-1 相关的人群研究（含术后并发症、全因结局、倾向评分比较）明显增多这一信号。可复现性上，两份并列 0.60 分主题的排布在两次运行间有次序差异（见第 2 节），说明 0.60 附近名次不稳定，解读应停留在词集与量级层面。

### 4.5 引用分析与文献计量定律

- 图件 `output/figures/citation_overview.png` 存在，但语料内没有可复核的被引计数表；且运行日志显示 `Semantic Scholar rate limit hit, using simulation for remaining articles`，引用数据含模拟成分。本报告**不转述任何引用量数字**。
- 输出报告声称检验了洛特卡、布拉德福、齐普夫定律并给出若干指数（如「洛特卡指数 = 3.15」，见 output/report.md 文字），但这些数值没有对应的分布数据可供复核，**本报告不予转述**。如需使用，应回到 output/report.md 并在获得分布数据后核验。

## 5. 语料与目标范围的差距（本报告最重要的结论）

| 题面要求 | 实际执行 | 差距 |
|---|---|---|
| 限定「肥胖与体重管理」 | 检索式仅 `GLP-1`[Title/Abstract]，无适应证限定（MeSH/翻译模块失败，概念块 2 为空） | 语料为广义 GLP-1 文献；按题名口径仅约 20.9% 命中体重管理关键词，不能当作肥胖领域专用语料 |
| 时间窗 2015–2025 | 记录元数据年份 2023–2026（2026 为部分年） | 2015–2022 无覆盖，无法做全时段趋势、演化路径与前沿分析 |
| 覆盖目标主题全部相关文献（上限 5,000） | 命中在 5,000 条处按最新优先截断 | 语料是最新子集而非代表性样本；早期高被引与奠基性文献缺失 |
| GLP-1 RA 药物名扩展 | 无药物名补充检索 | 只收录题名/摘要含 "GLP-1" 缩写的记录，可能漏掉只用药名的文献 |

综上，第 4 节全部结果的有效范围是「2026-09-09 检索得到的、2023–2026 年最新约 5,000 篇题名/摘要含 GLP-1 的 PubMed 文献（去重后 4,961 篇）」。它们对理解近两年 GLP-1 文献格局有用（体重管理是该截断语料内体量最大的主题方向之一），但把第 4 节的数字讲成「2015–2025 年 GLP-1 受体激动剂肥胖/体重管理领域全景」就是越界解读，本报告不那样表述。

## 6. 局限

1. **检索式限定缺失（环境所致，且可复现）**：检索所在运行环境缺少 `httpx`，检索式生成、中译英、MeSH 映射三环节失败；同一请求在当日两次检索中逐条复现相同失败与相同检索式。这不是检索策略选择，修复依赖前重跑不会得到含肥胖限定的检索式。
2. **年份截断**：5,000 条上限配合 PubMed 最新优先返回，把 2015–2022 年记录几乎全部切出语料；2026 年记录出现说明日期上限未按预期在返回集上生效。年份分布边界见 4.1、4.4。
3. **实体清洗伪影**：作者名拆分（Holst Jens J / Holst Jens Juul）、机构残片（「s Hospital」）与机构粒度不一致说明作者/机构维度计数有合并与噪声问题。
4. **弱聚类结构**：模块度 Q = 0.1004（输出报告给出），聚类标签解读需谨慎；网络均为阈值截断后的头部子集（关键词网络仅 50 节点）。
5. **引用数据不可用**：引用计数无数据文件支撑且运行记录明示部分引用来自模拟（Semantic Scholar 限流回退），本报告不使用任何引用量数字；三大文献计量定律指数仅存在于输出报告文字中，未转述。
6. **排除标准与实际表不一致**：输出报告方法部分称排除述评/评论/信件等，但 tables/pub_type_distribution.csv 仍含 Letter 173、Comment 47、Editorial 109、News 21、Preprint 50 等（类别可重叠），说明「排除」未在计数中体现；本报告未用该表支撑任何结论。
7. 检索与两次运行均发生于 2026-09-09；PubMed 数据截至该日。本报告不含任何药物疗效或安全性结论，不构成临床建议。

## 7. 要真正回答题面范围，需要什么

要得到「2015–2025 年 GLP-1 受体激动剂用于肥胖与体重管理」的文献计量全景，需要在依赖完整（含 httpx、可访问 MeSH/翻译服务）的运行环境中重跑，并使用受控检索式，例如 MeSH 词 `Glucagon-Like Peptide-1 Receptor Agonists` 与适应证 `Obesity`/`Overweight`（含获批与在研药物名自由词 semaglutide、liraglutide、tirzepatide、exenatide、dulaglutide 等）组合，按 2015–2025 逐年或更高上限抓取以避免「最新优先截断」，从而获得覆盖全时段的目标语料；在此之上再重做趋势、演化、前沿分析。当前运行环境不满足该条件，本报告于是把实际语料及其边界原样写明，而不是拿「最新 5,000 篇 GLP-1 记录」去凑题面要求的全景结论。

## 8. 数据与图件索引

- 随附运行记录：`deliverables/bibliometric-glp1-obesity-2015-2025/bibliometric-analysis-run.json`
- 本次分析产出目录（下称 `<out>`）：`bibliometric-analysis-runs/bibliometric-20260909131933-0198338e47d1/output/`。本报告正文图件内嵌路径与下表文件路径均相对于本文件所在目录（`deliverables/bibliometric-glp1-obesity-2015-2025/`，两级上行即工作区根），也可按 `<out>` 前缀在工作区根直接定位。
  - 检索台账与原始/清洗数据：`data/search_metadata.json`（total_found=5000、total_fetched=4987、实际检索式）、`data/raw_records.json`（4,987 条）、`data/cleaned_records.csv`（4,961 条）、`output/request.json`、`output/result.json`（records=4961）
  - 网络数据：`data/keyword_network.json`、`data/author_network.json`、`data/institution_network.json`、`data/country_network.json` 及 `data/*_collaboration.csv`；VOSviewer 导出：`vosviewer/`
  - 表件：`tables/year_trend.csv`、`top_keywords.csv`、`top_journals.csv`、`top_countries.csv`、`top_authors.csv`、`top_institutions.csv`、`cluster_summary.csv`、`burst_terms.csv`、`frontier_topics.csv`、`pub_type_distribution.csv`
  - 图件：`figures/annual_trend.png`（图内嵌 1）、`keyword_network.png`（图内嵌 2）、`timeline_clusters.png`（图内嵌 3）、`top_keywords.png`、`top_journals.png`、`top_countries.png`、`top_authors.png`、`top_institutions.png`、`country_network.png`、`author_network.png`、`institution_network.png`、`burst_terms.png`、`keyword_wordcloud.png`、`citation_overview.png`
  - 原始分析报告（输出报告，含其自述方法学与未复核数字，供对照）：`output/report.md`
- 运行日志（环境失败取证与复现记录）：`bibliometric-analysis-runs/.jobs/bibliometric-20260909131933-0198338e47d1.log`；同日同请求的首次运行（复现对照）：`bibliometric-analysis-runs/bibliometric-20260909124803-01be2df9dad6/output/` 与 `.jobs/bibliometric-20260909124803-01be2df9dad6.log`

本报告正文未引用任何外部文献：所引数字均可追溯到上述文件，或在正文注明为「独立测算」并给出精确口径；无法复核的数字一律不转述或仅注明其出处为输出报告自述。
