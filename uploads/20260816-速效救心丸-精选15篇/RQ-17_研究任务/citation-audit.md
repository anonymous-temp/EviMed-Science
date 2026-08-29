# 引用完整性审计（Citation Audit）

本文件记录本运行对引用来源实际执行的核验及其发现。审计范围覆盖临床证据矩阵（`clinical-evidence-matrix.json`）中的全部声明、编号参考文献（`references.bib` / 报告参考文献表）以及检索命中的候选记录。

## 1. 未解析标识符（unresolved）

- **NMPA 速效救心丸说明书逐字原文（参考文献 10）**：无法解析到可经批准网关直接抓取的官方现行原文。NMPA 数据查询端点不在官方页面抓取工具的白名单内；`evimed_drug_label_search` 返回的是 EviMed 药品标签索引件，其来源状态标注为“EviMed indexed label candidate; official-current verification required”。因此说明书适应症的逐字中文表述（“行气活血，祛瘀止痛，增加冠脉血流量，缓解心绞痛。用于气滞血瘀型冠心病，心绞痛”）、禁忌（孕妇禁用）、注意事项（寒凝血瘀、阴虚血瘀胸痹心痛不宜单用）与不良反应罗列取自该索引件，**官方现行文本与历次修订信息未能核验**。这些逐字表述仅作为报告正文的引述（参考文献 10），未作为矩阵声明的 supportQuote；矩阵中关于适应症、功效、成分与批准文号的声明（CLM-001、CLM-002、CLM-003）改由已落盘的开放获取临床试验方案（PMC8287819，参考文献 16）支持。

- **Cochrane 系统评价 Duan 2008（参考文献 13，PMID 18254051，CD004473）**：全文未获（cochranelibrary.com HTTP 403；PMC7137214 Europe PMC 全文上游不可用）。报告中仅以“证据强度弱、方法学质量低”定性转述，未引用其具体数字（原“15 项试验、1776 例”已从正文移除），也未纳入矩阵声明。

- **Kim 2021、CRAVE（NEJM 2023）、DECAF 2025、Shirlow & Mathers 1985**：原始全文均未获（jamanetwork.com / nejm.org / PMC8290332 返回 HTTP 403 或上游不可用）。Kim 与 CRAVE 的效应量经已落盘综述（PMC10508080）逐字转述并据此建立声明（CLM-005、CLM-006）；DECAF 试验结果（房颤复发降低 39%）经其开放获取评述（PMC12997235，参考文献 17）逐字转述并据此建立声明（CLM-026），DECAF 原始论文（参考文献 14）仍为 abstract 层级；Shirlow（参考文献 15）仅作定性转述（原具体数字 4558 例等已从正文移除），标注 abstract/metadata 层级，未纳入矩阵声明。

## 2. 重复记录（duplicate）

- 跨检索式存在重复题录（Kim 2021、CRAVE、咖啡因心律失常综述等在 PubMed / Europe PMC / PMC 多次命中），已按 PMID、PMCID、DOI、规范化标题去重：原始命中 209 条，去重后 121 条，纳入 17 条。
- 报告引用按“一篇文献一个编号”处理；同一文献的 `.fulltext.md` 与 `.fulltext.xml` 未重复计数（矩阵与 run receipt 仅计一个规范工件路径）。
- 两个 NMPA 标签索引件内容一致，按同一文献处理，仅编号一次（参考文献 10）。

## 3. 更正与撤稿（correction / retraction）

- 对本运行引用的 16 条来源逐一核对，未发现更正、关注表达或撤稿记录。
- 未对检索命中的其余非纳入题录逐条执行撤稿核查；凡未纳入的来源不进入报告结论。

## 4. 仅元数据 / 仅摘要来源（metadata-only）

- 参考文献 10（NMPA 说明书索引件）、13（Duan 2008 Cochrane）、14（DECAF 2025）、15（Shirlow & Mathers 1985）为 **structured_record 或 abstract/metadata 层级**，全文未落盘。其内容仅在报告正文作定性或逐字（标签）引述，未据此构建矩阵 supportQuote。
- 检索命中的其他题录（如 Voskoboinik 2018、Lemery 2015、Newby 1996 等）为 metadata 层级，仅用于定向，未进入引用列表。

## 5. 声明—来源不匹配（claim mismatch）

- 全部直接声明的 `supportQuote` 均逐字取自已落盘全文工件（`fulltext.md`）或官方页面工件（`page.md`），以连续引用为默认，省略处以 `…` 标注且两侧分别在原文中出现、顺序与原文一致；声明中的阿拉伯数字均出现于引文或来源标题/标识符中。
- 本运行执行了逐条侧片顺序核对（省略号两侧按原文出现顺序定位）与数字—引文核对，结果为零问题。
- CLM-013 的 supportQuote 为论文标题（原文工件首行含该标题），构成对该来源的逐字引用。
- CLM-018（急救）的连续引文同时包含“Call 999”动作与胸痛警示症状条件，满足急救类声明的引文要求。
- CLM-023 为推导声明（derived），无自身来源，其输入 CLM-025 在矩阵中存在。

## 6. 结论

- 矩阵中所有以全文/官方页面为支撑的声明，其逐字引文均可在对应落盘工件中定位，顺序与数字均已核对。
- 说明书逐字表述、Cochrane 评价、DECAF 与 Shirlow 等无法经可用工具落盘全文的来源，已如实降级为 structured_record / abstract 层级，其具体数字已从正文移除或仅作定性转述，未将题录包装为已读全文。
- 未发现撤稿、更正或重复计数问题。
