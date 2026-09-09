# GLP-1 受体激动剂用于肥胖与体重管理——文献计量分析报告

| 项目 | 内容 |
|---|---|
| 报告标识 | glp1-obesity-bibliometric |
| 运行编号 | bibliometric-20260909124803-01be2df9dad6 |
| 运行终态 | succeeded（2026-09-09T12:58:37Z 确认） |
| 检索日期 | 2026-09-09 |
| 数据源 | MEDLINE（via PubMed），NCBI E-utilities API |
| 请求参数 | 主题「GLP-1 受体激动剂用于肥胖与体重管理」；2015–2025；上限 5,000 条；中文输出 |

> **先读这一节。** 本报告基于一次真实执行的文献计量检索写成，但检索实际抓到的语料与题面要求对不上，差距的细节见第 2、5 节。受运行环境缺陷影响，检索式没有包含肥胖/体重管理限定词；按 5,000 条上限截断后，得到的记录又集中在 2023–2026 年。所以本报告不能自称是"2015–2025 年 GLP-1 受体激动剂用于肥胖与体重管理研究的完整全景"。它如实描述分析实际覆盖并采用的语料（最新 5,000 篇题名/摘要含 GLP-1 的 PubMed 记录，去重后 4,961 篇），并逐项标明哪些结论在这份语料上成立、哪些不能外推到题面目标范围。

---

## 1. 目标范围与交付物

题面要求：对「GLP-1 受体激动剂用于肥胖与体重管理」开展文献计量分析，时间窗 2015–2025，PubMed 检索记录上限 5,000 条，报告语言中文。本文档即分析报告本体；随附的 `bibliometric-analysis-run.json` 记录本次运行的终态、实际执行的检索式、语料计数与全部产出文件清单。

本报告只做文献计量信号层面的描述（发文量、合作、主题共现、爆发、前沿评分），不对任何药物的疗效、安全性或证据等级作评价。

## 2. 检索策略与实际执行情况

检索于 2026-09-09 通过 NCBI E-utilities 对 MEDLINE（via PubMed）执行。运行记录（`.jobs/bibliometric-20260909124803-01be2df9dad6.log`）与 `output/data/search_metadata.json` 显示：

- **执行故障（如实报告，非完成）**：检索式自动生成、中文→英文翻译、MeSH 映射三个环节在分析运行环境中失败，记录原因为 `No module named 'httpx'`（运行镜像缺少该依赖）。失败后果直接体现在检索式结构上。
- **实际执行的正式检索式**：

```
("GLP-1"[Title/Abstract]) AND ("2015/01/01"[Date - Publication] : "2025/12/31"[Date - Publication])
```

  即概念块 1 = 自由词 `GLP-1`（MeSH 映射失败，未使用主题词）；概念块 2（受体激动剂、肥胖、体重管理等限定）因翻译/映射失败**为空**，未进入检索式。检索式不含任何肥胖/体重管理限定，也不含 GLP-1 受体激动剂各药物名的扩展（如 semaglutide、liraglutide、tirzepatide 的补充检索，它们仅作为文献自带关键词在语料中出现）。

- **截断与年份异常**：PubMed 按最新优先返回并截断在 `maxRecords=5000`（`search_metadata.json`：total_found=5000，total_fetched=4987）。去重（PMID + 标准化标题）后纳入 **4,961 篇**。尽管检索式标注日期过滤至 2025-12-31，所得记录的期刊/卷期元数据年份却为 2023–2026，其中 2026 年 454 条被该次分析标记为"部分年"（表 `output/tables/year_trend.csv` 的 `is_partial` 列）。该年份异常在原始输出报告中被解释为"检索日期过滤范围与实际卷期年份是两个字段"，但更稳妥的解读是：**本次得到的不是 2015–2025 全时段样本，而是最新约 5,000 条命中记录的截断子集**（2015–2022 年记录几乎未进入语料）。

- **清洗规则（按原始报告转述）**：作者姓名规范化为「姓+名首字母」；机构用模式匹配提取；合并 MeSH 主题词与作者关键词并剔除 Humans/Male/Female 等限定词；按 PMID 与标准化标题去重。清洗伪影见第 4.2 节（作者名拆分、机构残片）。

## 3. 语料构成

以下数字来自 `output/data/cleaned_records.csv` 与 `output/data/search_metadata.json`，可直接复核：

| 指标 | 数值 | 出处 |
|---|---|---|
| 检索命中（上限截断） | 5,000 | search_metadata.json |
| 实际抓取 | 4,987 | search_metadata.json |
| 去重后纳入 | 4,961 | search_metadata.json / cleaned_records.csv（4,961 行数据） |
| 期刊数 | 1,414 种 | cleaned_records.csv（独立测算） |
| 国家/地区数 | 42 个 | cleaned_records.csv（独立测算） |
| 记录元数据年份分布 | 2023 年 2 篇；2024 年 1,282 篇；2025 年 3,223 篇；2026 年 454 篇（部分年，年化约 605） | tables/year_trend.csv |

语料主题构成（直接对 cleaned_records.csv 计数得出）：题名或摘要含 obesity / overweight / weight loss / weight management / BMI / bariatr- 等肥胖与体重管理关键词的记录 **1,158 / 4,961（23.3%）**。其余约四分之三属于更广义的 GLP-1 文献（糖尿病、药理学、其他适应证等）。肥胖与体重管理只是这份"最新 5,000 篇含 GLP-1 文献"里体量最大的主题之一，是语料自带内容的分布，不是检索限定的结果。

## 4. 分析结果

以下各小节的结果均由该次分析在语料上计算得出，本报告只转述能在随附数据文件中复核的部分，并标注成立边界。图与表的路径均相对于 `/workspace`。

### 4.1 发文趋势

`output/tables/year_trend.csv` 显示语料窗口内（2023–2026）发文量从 2 篇升至 2025 年 3,223 篇（高峰年份），2026 年不完整。图件：`output/figures/annual_trend.png`。

> 成立边界：这是"截断语料内的年度计数"，不是 2015–2025 的全时段趋势。2023→2024 的跳变（2→1,282）主要反映 5,000 条上限把更早年份整体切出语料，不能解读为领域在 2024 年爆发式增长；"上升趋势"仅在该截断窗口内成立。

### 4.2 主要贡献者

- **国家/地区**（`output/tables/top_countries.csv`，图 `top_countries.png`）：United States 1,450、China 808、United Kingdom 426、Italy 342、Canada 250、Denmark 214、Germany 198、India 170、Australia 164、Japan 155（Top10）。注意国家计数是"记录—国家"关联计数，一篇多国署名的文献会计入多个国家，故按 4,961 换算的占比（如美国 29.2%）为近似值。
- **期刊**（`output/tables/top_journals.csv`，图 `top_journals.png`）：Diabetes, Obesity & Metabolism 206、Cureus 178、Frontiers in Endocrinology 81、International Journal of Molecular Sciences 77、Journal of Clinical Medicine 70……（Top10 如上表所列）。原始报告说明语料分布于 1,414 种期刊。
- **作者**（`output/tables/top_authors.csv`，图 `top_authors.png`）：Holst Jens J 30、Holst Jens Juul 28、Hartmann Bolette 23、McIntyre Roger S 21、Drucker Daniel J 18……。清洗伪影：Holst Jens J 与 Holst Jens Juul 疑为同一作者（Jens J. Holst）因姓名规范化变体被拆为两人，产量统计应合并看待。
- **机构**（`output/tables/top_institutions.csv`，图 `top_institutions.png`）：National Health Service 139、Harvard Medical School 138、University of Copenhagen 135、University of Toronto 82、Novo Nordisk 79、Mayo Clinic 77、University of California 57……。清洗伪影："s Hospital"（55 篇，机构名残片）为机构提取噪声，不应视为真实机构。

### 4.3 知识结构（网络与聚类）

网络规模直接从随附 JSON 数据读取（节点数/边数）：

| 网络 | 节点 | 边 | 数据文件 | 图 |
|---|---|---|---|---|
| 关键词共现 | 50 | 1,220 | data/keyword_network.json | figures/keyword_network.png |
| 作者合作 | 22 | 36 | data/author_network.json | figures/author_network.png |
| 机构合作 | 20 | 75 | data/institution_network.json | figures/institution_network.png |
| 国家合作 | 10 | 45 | data/country_network.json | figures/country_network.png |

- 关键词共现（表 `output/tables/top_keywords.csv`）：高频关键词依次为 drug therapy 2,090、therapeutic use 1,696、Glucagon-Like Peptide-1 Receptor Agonists 1,538、metabolism 1,391、**Obesity 1,318（约占语料 26.6%）**、Hypoglycemic Agents 1,283、Diabetes Mellitus, Type 2 1,221、Semaglutide 691、**Weight Loss 576**、Tirzepatide 361、Liraglutide 330 等（关键词为 MeSH 词与作者词合并计数，一篇文献可携带多个）。
- 聚类（`output/tables/cluster_summary.csv`，图 `timeline_clusters.png`）：Louvain 识别 3 个聚类，输出数据给出的标签与规模为「Therapeutics: Drug, Glucagon, Receptor」（17 节点）、「Mechanisms: Obesity, Glucagon, Drug」（13 节点）、「Mechanisms: Glucagon, Drug, Peptide」（20 节点）；输出报告给出模块度 Q≈0.10、平均轮廓系数≈0.34。Q 低于 0.3 属弱社区结构，**聚类边界解读应保持谨慎**（弱结构部分源于语料本身是单一药物的近期文献，主题边界天然模糊）。
- 合作网络：作者网络 22 节点 36 边，输出报告描述为碎片化、无强连接枢纽；国家网络 10 节点 45 边（完全连通的 10 国子网）。两网络的节点都只是"达到阈值的头部子集"，不等同于语料内全部合作关系。

### 4.4 研究热点与前沿

- 高频词与爆发词见 `output/tables/burst_terms.csv`（图 `burst_terms.png`）与 `output/tables/frontier_topics.csv`。分析采用 Kleinberg 自动机检测到的主要爆发词包括 epidemiology（2026，强度 91）、Receptors, G-Protein-Coupled（2024，24）、Glucagon-Like Peptide-2 Receptor（2024，24）、mortality（2026，23）、Postoperative Complications（2026，17）、Incidence（2026，16）、Propensity Score（2026，15）等；前沿评分居前的主题为 epidemiology（0.85）、drug therapy（0.75）、Receptors, G-Protein-Coupled / Glucagon-Like Peptide-2 Receptor（0.67）、mortality（0.66）等。
- 成立边界：爆发与"前沿"指标完全基于 2023–2026 截断窗口，爆发区间多为 2024 或 2026 的**单年**事件，"近期增长率 100%、新颖性 1.0"式的打分是短窗口与逐年首现算法的产物（原始报告对新颖性的定义是"关键词在研究期内首次出现的相对位置"），**不应外推为 2015–2025 的真实研究前沿**。epidemiology、mortality、Postoperative Complications 等突现词反映的是该时段内"GLP-1 相关人群研究、结局研究增多"这一信号。

### 4.5 引用分析与文献计量定律

- 图件 `output/figures/citation_overview.png` 存在，但语料表件中没有可复核的被引计数表，本报告不转述任何引用量数字。
- 原始报告称对洛特卡、布拉德福、齐普夫定律做了检验并给出若干指数（如"洛特卡指数 3.15"），但这些数值没有对应的分布数据可供复核，**本报告不予转述**，只保留"原始报告声称已检验"这一事实，读者如需使用应回到原始输出报告核对。

## 5. 语料与目标范围的差距（本报告的最重要结论）

| 题面要求 | 实际执行 | 差距 |
|---|---|---|
| 限定"肥胖与体重管理" | 检索式仅 `GLP-1`[Title/Abstract]，无任何适应证限定 | 语料约 76.7% 为非肥胖/体重管理主题（题名测算），不能当作肥胖领域语料 |
| 时间窗 2015–2025 | 记录元数据年份 2023–2026（2026 为部分年） | 2015–2022 完全无覆盖，无法做全时段趋势/演化分析 |
| 覆盖全部相关文献（上限 5,000） | 命中即截断在 5,000，取最新记录 | 语料是最新子集而非代表性样本，早期高被引文献缺失 |
| GLP-1 RA 药物名扩展 | 无药物名补充检索 | 只收录题名/摘要含 "GLP-1" 字样的记录，可能漏掉部分以药名为主、未写 "GLP-1" 缩写的文献 |

综上，第 4 节全部结果的有效范围是"2023–2026 年最新约 5,000 篇题名/摘要含 GLP-1 的 PubMed 文献"。它们有助于理解近两年 GLP-1 相关文献的格局（肥胖与体重管理是其中的主导主题之一），但谁要是把第 4 节的数字讲成"2015–2025 年 GLP-1 受体激动剂肥胖与体重管理领域全景"，那就是越界解读，本报告不那样表述。

## 6. 局限

1. **检索式限定缺失（环境所致）**：分析运行镜像缺少 `httpx`，导致检索式生成、中译英、MeSH 映射三个环节失败（记录原文 `No module named 'httpx'`）。这不是检索策略选择，而是运行环境缺陷，重跑不修复依赖则结果相同。
2. **年份截断**：5,000 条上限配合 PubMed 最新优先返回，把 2015–2022 年记录几乎全部切出语料；2026 年记录的出现说明检索式的日期上限未按预期在返回集上生效。年份分布的解读边界见 4.1、4.4。
3. **实体清洗伪影**：作者名拆分（Holst Jens J / Holst Jens Juul）、机构残片（"s Hospital"）等说明作者级、机构级计数有合并与噪声问题，宜在机构/作者维度做二次合并后再引用。
4. **弱聚类结构**：关键词网络模块度约 0.10，聚类标签解读需谨慎；网络均为阈值截断后的头部子集。
5. **自述数字未复核**：原始报告中的引用分析、三大文献计量定律指数没有独立数据支撑，本报告不转述。
6. **排除标准的说明与实际表不一致**：方法部分声称排除述评/评论/信件等，但 `pub_type_distribution.csv` 仍含 Letter 173、Comment 47、Editorial 109 等类别（类别可重叠），说明"排除"未在计数中体现；本报告未用该表做任何结论。
7. 检索与运行发生于 2026-09-09；PubMed 数据截至该日。本报告不包含任何药物疗效或安全性结论，也不构成临床建议。

## 7. 要得到题面所要求的分析，需要什么

要真正回答"2015–2025 年 GLP-1 受体激动剂用于肥胖与体重管理"的文献计量全景，需要：在一个依赖完整的运行镜像中重跑该分析（恢复检索式生成与 MeSH 映射），并使用受控检索式，例如 MeSH 词 `Glucagon-Like Peptide-1 Receptor Agonists` 与适应证词 `Obesity`/`Overweight` 组合（含各获批药物名自由词），对 2015–2025 分年或按更高上限抓取以避免最新优先截断；否则 4,961 篇"最新 GLP-1 记录"支撑不了任何全景性结论。本次环境满足不了这个条件，本报告于是选择把实际语料及其边界原样写明，而不是拿这批数据去凑题面要求的全景结论。

## 8. 数据与图件索引

- 随附运行记录：`deliverables/glp1-obesity-bibliometric/bibliometric-analysis-run.json`
- 产出目录：`bibliometric-analysis-runs/bibliometric-20260909124803-01be2df9dad6/output/`
  - 原始与清洗数据：`data/raw_records.json`、`data/cleaned_records.csv`、`data/search_metadata.json`
  - 网络数据：`data/*_network.json`、`data/*_collaboration.csv`；VOSviewer 导出：`vosviewer/`
  - 表件：`tables/`（year_trend、top_keywords、top_journals、top_countries、top_authors、top_institutions、cluster_summary、burst_terms、frontier_topics、pub_type_distribution）
  - 图件：`figures/`（annual_trend、top_keywords、top_journals、top_countries、top_authors、top_institutions、keyword_network、author_network、institution_network、country_network、timeline_clusters、burst_terms、keyword_wordcloud、citation_overview）
  - 原始分析报告（供对照，含其自述方法学与未复核数字）：`output/report.md`

本报告正文未引用任何外部文献：所引数字均可在上述数据与图件中逐一核对；不可复核的数字一律未转述或已注明出处仅为原始报告。
