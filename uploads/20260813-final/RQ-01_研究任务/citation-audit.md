# 引文审计（citation-audit）

本审计记录对全部纳入引用所执行的核验与实际发现，逐类列出。核验手段：以 DOI/PMID/PMCID 对照 PubMed 与 Europe PMC 题录，以 `evimed_evidence_deduplicate` 逻辑（DOI、PMID、稳定 URL、规范化题名）去重，并对保留全文的 6 份文献逐句核对支撑引文是否出现在原文中。

## 1. 未解析标识符（unresolved）

- 无未解析的 DOI/PMID/PMCID。全部 12 条参考文献均带 DOI 或可打开的官方页面 URL。
- 下列来源的**官方现行全文**未能获取（不构成“文献不存在”），仅按摘要或结构化记录引用，已在正文与“局限性”中说明：
  - Henrikson 2003（PMID 14678917）：Annals of Internal Medicine，非开放获取，仅摘要可核验。
  - Li Y 2006（PMID 16440063，J Clin Invest）：开放获取全文的自动获取多次失败，其关键结论经 Pearson/Butler 2021 综述（保留全文）转述，原文献本身仅摘要可核验。
  - Duan 2008 Cochrane 系统评价（PMID 18254051）：Cochrane Library 返回 HTTP 403，仅摘要可核验。
  - Byrne 2023 ESC 指南（PMID 37622654）：全文未获取，仅题录级引用其存在与年份，未据其原文引用具体推荐条款。
- 硝酸甘油片与速效救心丸说明书（参考文献 10、11）：经 NMPA 说明书索引检索获取的索引副本，官方现行文本核验待完成；正文据此表述适应症与禁忌时已注明“说明书索引副本”。

## 2. 重复（duplicate）

- 跨检索命中的重复题录已合并：PMID 6401374、PMID 19851218、PMID 17765117 等在多个检索式中重复出现，仅各计一次纳入。
- 同一文献的不同格式（Markdown 与 XML）视为同一文献，仅以 fulltext.md 为唯一可读工件。
- 保留全文的 6 份文献经 DOI/PMID 去重确认互不重复：Steele 2006、Henrikson 2003、NHS 2023、Chowdhury 2021、Pearson 2021、Sakata 2011、Ren 2018 中，Henrikson 2003 为摘要级，其余 6 份为全文级。

## 3. 更正与撤稿（correction/retraction）

- 已核查 ESC 2023 急性冠脉综合征指南存在两处勘误（Eur Heart J 2024 与 Eur Heart J Acute Cardiovasc Care 2024 各刊载 Correction to: 2023 ESC Guidelines），正文按原始版本（PMID 37622654）引用其存在，未引用勘误后的具体条款；如需引用具体推荐应核对最新勘误版。
- 其余 11 条文献未检索到撤稿、勘误或关注性声明（expression of concern）记录。

## 4. 仅题录／元数据（metadata-only）

- 仅题录级引用：Byrne 2023 ESC 指南（参考文献 12），仅用于说明“现行指南存在并强调早期再灌注”，不承载任何具体数值或推荐级别。
- 摘要级引用：Henrikson 2003（参考文献 2）、Li Y 2006（参考文献 7）、Duan 2008（参考文献 8）。正文对这三者仅按摘要可支撑的范围陈述，不据此推断研究设计、效应量之外的结论；Li 2006 与 Zhang 2007 的量化结果经保留全文的 Pearson 2021 综述转述。
- 结构化记录引用：NMPA 说明书（参考文献 10、11），标注为“索引副本”，不冒充官方现行文本。
- 以上访问层级不等于“未读到任何内容”：摘要级与结构化记录级来源均有可核验的摘要或记录文本作为依据。

## 5. 主张—来源不匹配（claim-source mismatch）

- 逐条核对：矩阵中 CLM-001 至 CLM-022 的直接主张，其支撑引文均逐字存在于对应保留工件（`supportQuote` 列）。核对的工件标识为 PMID:17320010（Steele）、PMID:34818360（Chowdhury）、PMID:34770988（Pearson）、PMID:21540305（Sakata）、PMID:29770157（Ren）与 official-page:e6143b76645a9461（NHS）。核对为逐句比对，非关键词检索。
- 特别核对的数值：Steele 2006 的 270、66%、72%、37%、1.1；Chowdhury 2021 转述的 7.5%、44% 与 20%；Pearson 2021 转述的 40%、6%、10 倍、57.5%、11.1%、67.1%、20.4%、559；Sakata 2011 的 20%、299.7 s、254.7 s、0.3 mg；Ren 2018 的 41、6276、1.32、1.35、1.12——均与工件原文一致。
- 两处主张为综述的二次转述（De Luca 的 7.5% 与溶栓 44%/20%、Zhang 2007 的缓解率），已在正文与“局限性”中明确标注为“经综述转述”，未伪装成对原始文献的直接引用。
- 合成主张 CLM-020 依赖两个独立保留工件（Pearson 2021 转述 Miura 2017 与 Sakata 2011 原文），已核对二者为不同文献、不同研究。
- 推导主张 CLM-021 不引用任何来源、仅以 CLM-008 与 CLM-011 为输入，计算过程、假设与敏感性已在 `method`/`assumptions`/`sensitivity` 字段完整展示，正文以〔推导〕标记。
