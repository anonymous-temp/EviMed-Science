# 引文审计（Citation Audit）

本审计记录本轮证据处理中对引用完整性所做的检查与实际发现，含未解析标识符、重复、更正/撤稿、仅元数据记录、以及主张与来源不匹配五类。证据矩阵中经逐条核对来源工件（supportQuote 与落盘全文/官方页面逐字比对）的标识符包括：PMC5550987（PMID:28793910）、PMC3808760（PMID:24163208）、PMC7257246（PMID:32471451）、PMC6951081（PMID:31830875）、DOI:10.1136/heartjnl-2016-310905、DOI:10.1017/s1481803500013671、DOI:10.3389/fpsyt.2026.1858764，以及官方页面 AHA 2021 Chest Pain Guideline 与 NHS Chest pain page。

## 未解析标识符（unresolved identifiers）

- 速效救心丸说明书（参考文献 [1]）：药品说明书索引返回两条 NMPA 索引候选记录，为索引化的监管记录而非现行官方原文；NMPA 数据查询页面与本省药监镜像在本次环境中无法直接调取，故说明书正文、批准文号（国药准字 Z12020025）与修订日期未获现行官方核验。正文中凡依据说明书所作的陈述均按索引化监管记录转述，需以国家药监局数据查询核实后方可作为法规依据。
- 参考文献 [5]（Hoorweg 2017）为仓储库中的提交版（submittedVersion）文本层，与正式出版版（version of record）在个别排版上可能略有出入；所引数字均在文本层中逐项核对。
- 参考文献 [6]（Steele 2006）为 PDF 文本层，行间断字（如"speci-ficity"）已避开，引用改用摘要中连续文本。

## 重复（duplicate / deduplication）

- 官方页面 2021 年 AHA 胸痛评估指南在历史工作区存在两条内容相同的抓取件（哈希 1991d92ed3d90b85 与 3f9e2ebb850bd07f），本轮仅保留本轮重新抓取的 d7f13b48a8ccf3c4 一条作为可引工件，其余不计为独立来源。
- 精神应激诱导心肌缺血相关的综述与原始研究在检索中多次出现（如 Vaccarino、Jiang 等），均未作为独立证据计入；最终只保留 meta 分析（PMC7257246）一条定量来源。
- 中日医药信息网首页（0420df80271693fc）经抓取后发现不含药品说明书内容，未作为证据来源，未计入来源数。

## 更正 / 撤稿（correction / retraction）

- 对纳入的 9 个证据来源，均未在其出版记录中检索到更正（correction）、撤稿（retraction）或关注声明（expression of concern）。本检查基于各来源的 PubMed/Europe PMC 记录与出版商页面所见，未发现撤稿或更正标记。

## 仅元数据 / 仅题录记录（metadata-only records）

以下记录只有题录或摘要，未获得可引用的完整文本，未进入定量结论，正文仅在相应处按题录/摘要转述并标注其局限：

- Duan 等. Chinese herbal medicine suxiao jiuxin wan for angina pectoris. Cochrane Database Syst Rev. 2008（参考文献 [11]）：全文在 Cochrane Library 返回 HTTP 403，仅据 PubMed 题录与摘要转述"证据不足以判断疗效"。
- Tully PJ 等. Generalized anxiety disorder prevalence and comorbidity with depression in coronary heart disease: a meta-analysis（PMID:23300050）：仅题录，共病人群比例未定量。
- Greenslade JH 等. Panic Disorder in Patients Presenting to the Emergency Department With Chest Pain（PMID:28256404）：仅题录，惊恐患病率未引用其具体数值。
- Vaccarino V 等. Association of Mental Stress-Induced Myocardial Ischemia With Cardiovascular Events（JAMA 2021，PMID:34751708）：仅题录，预后关联数值未引用。
- 两项中文动物实验（动脉粥样硬化大鼠、心肌缺血再灌注小鼠）：题录级，仅作机制线索，不作临床证据。

上述记录不因"仅元数据"而被当作不存在；它们只是本轮无法按可引用层级取证。

## 主张与来源不匹配（claim-source mismatch）

- 说明书主张（适应症"气滞血瘀型冠心病，心绞痛"、孕妇禁用、注意事项等）：来源为药品说明书索引的结构化记录，未落盘为可校验原文，故未进入证据矩阵的引文校验路径；正文以行内短引号引用适应症原文，并在局限性中说明须以官方现行文本核实。此属来源可及层级限制，而非主张与来源内容冲突。
- 甲状腺功能亢进、贫血在心悸主诉中的占比：正文未给出具体数字，因检索未得到以心悸主诉为分母的报告相应占比的研究；正文明确记为缺口，未以其他场所的比例冒充。
- 各矩阵主张的 supportQuote 均逐条与对应落盘工件核对，所引数字均出现在引文、标题或标识符中；未发现引文与工件内容冲突。
