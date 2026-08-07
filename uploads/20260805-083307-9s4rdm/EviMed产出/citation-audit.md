# 引用审计（citation audit）

审计日期：2026-08-05。审计对象：clinical-evidence-report.md、clinical-evidence-matrix.json（21 条直接/综合 claim + 8 条推导 claim）、citation-ledger.csv、references.bib（18 条）。

## 1. 未解析标识符（unresolved）

- 8 篇全文来源的 DOI/PMID/PMCID 全部解析成功并保存在 .evimed-sources/ 下，逐条核验：PMC8613074（PMID 34125422）、PMC12996889（PMID 40662264）、PMC9584998（PMID 36195732）、PMC3948577（PMID 24595134）、PMC11179308（PMID 38520287）、PMC8408068（PMID 34417726）、PMC9997772（PMID 36897697）、PMC11217561（PMID 38957736）。
- 未解析为全文、仅以摘要/题录存在的来源（[10]–[18]）：PMID 28910830（AGNP 2017 版共识）、32433836（ASCP/AGNP 联合共识）、37471567（奥氮平参考区间系统评价）、21157400（CYP2D6*10）、31000417（Jukic 2019）、17828532（Hendset 2007）、30565279（Zhang X 2018 荟萃）、17164689（Molden 2006）、25289972（Patteet 2014）。这些条目在检索结果中均含 PMID 与公开 PubMed URL，但**本次运行未能获取开放全文**；其中 [10] 的全文拉取已尝试（PMID:28910830 与 DOI:10.1055/s-0043-116492）并返回"非开放获取"，已如实记入 failedSources。报告正文已声明这些为摘要级背景、不作为 claim 载体；[10] 的参考区间数值通过 [4][2] 两篇全文转引核验。
- references.bib 中 Wesner 2023、Suzuki 2011、Molden 2006 的卷/期/页码为检索记录所见字段，部分未逐字段复核，已在 bib 的 note 中标注"Abstract-only / not fully verified"，不以未验证元数据支撑任何 claim。

## 2. 重复（duplicates）

- 程序化去重：跨 17 次成功检索保存的全部检索输出按 PMID→URL→规范化标题去重，266 条原始题录得到 135 条唯一记录。
- 工具级去重（evimed_evidence_deduplicate）：提交 12 条代表记录返回 12 条唯一；注意该工具对同一 PMID 但标题/URL 书写不同的记录（如 "Influence of CYP2D6…" 与 "Influence of C YP2D6…"）未合并，提示跨来源同文不同写法的题录需人工复核——本报告在纳入时按 PMID 归并，未重复计为独立证据。
- 报告正文无重复引用同一文档的计数问题：sourcesIncluded=9 对应 9 个不同文档（8 篇全文 + 1 份数据文件），synth 类 claim 的 supportingSources 均为不同 artifactPath。

## 3. 更正与撤稿（corrections/retractions）

- 对 8 篇纳入全文执行了核对：截至 2026-08-05 检索范围内，未见 PubMed/PMC 标注的撤回（retraction）、更正（correction）或关注声明（expression of concern）指向这 8 篇文献。
- 参考文献 [10]–[18] 为闭架摘要级条目，未做撤回状态复核（无法获取全文记录），已在正文中限定为背景引用。

## 4. 元数据级/摘要级记录（metadata-only / abstract-level）

- 9 个 included 来源（8 篇全文 + 1 份数据集）均有可读工件：8 篇全文为 .evimed-sources/ 下 fulltext.md（含来源身份、检索时间、内容哈希），数据集为 /workspace/20260803TDM.xlsx（用户提供，分析者直接逐表读取）。
- [10]–[18] 共 9 条为摘要/题录级记录，accessLevel 记为 abstract，included=false，role 记为 background_abstract，不承载 material claim；其存在与检索语境在报告"证据基础与检索方法"一节如实说明。
- PharmGKB 连接器仅返回记录级入口（PA10026 aripiprazole），未承载任何临床结论；RxNorm 返回 8 条产品级记录（如 1998453 Sensor aripiprazole 10 MG Oral Tablet），仅用于药物身份核对。

## 5. claim-来源匹配（claim-source matching）

- 21 条直接/综合 claim 的 supportQuote 全部逐字核验存在于对应工件（用程序在 fulltext.md 中按原始字符串定位；含 "…" 省略号的引文，省略两侧片段均分别核验存在且顺序一致）。
- 数据集 claim（CLM-001–005）的 supportQuote 为 20260803TDM.xlsx 中逐行读取的原始单元格内容；该文件为二进制工作簿，无法按文本全文检索，核验方式为分析者逐表读取并与 claim 数值比对（317/400/354/79.9/100/63、372/503/433/107/127/94、54.2/721/46.6/86.4、医嘱剂量与起止时间、体征值均已逐条比对）。
- 未发现"引文支持不了主张"（claim mismatch）的情况；两处需说明的近似：① Kneller 2021 摘要中 ARI 参考区间写作 "10–350 µg/L"，正文未直接引用该句，区间引用改由 Hart 2022 全文承载（"100–350 ng/ml"），避免把原文笔误带入；② 氯硝西泮的参考区间 4–80 ng/mL 仅以数据集字段为准，正文未以文献 claim 支撑。
- 推导类 claim（CLM-020–027）不引用来源语句，其 method/assumptions/sensitivity/uncertainty 记录了完整算式与输入 claim 链，可复核。

## 6. 结论

无未解析的主要来源标识符；无重复计数的证据；未发现撤回/更正；闭架摘要条目已显式降级并在报告中标注；全部 material claim 的引文在工件中逐字可查。唯一需读者注意的偏差：数据集 claim 的工件为二进制 xlsx，核验以逐表人工读取为凭，已在第 5 节说明。
