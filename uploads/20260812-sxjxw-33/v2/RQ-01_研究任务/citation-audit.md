# 引文审计

审计日期：2026-08-12。审计范围：报告 `clinical-evidence-report.md` 的 30 条编号参考文献、证据矩阵 `clinical-evidence-matrix.json` 的 40 条主张（38 条引证主张 + 2 条推导主张）及引文台账 `citation-ledger.csv`。

## 已核验项

- 证据矩阵中直接与综合主张的标识符均经逐条核验：PMID:17320010（Steele 2006，CJEM）、PMID:35847764（Twiner 2022，Open Access Emerg Med）、PMID:25591559（Xia 2015，Chin Med J）、PMID:29770157（Suxiao 2018 Meta，Evid Based Complement Alternat Med）、PMID:33963080（Alrawashdeh 2021，Open Heart）、PMID:41440853（Dziewierz 2025，J Cardiovasc Dev Dis）、PMID:34770988（Molecules 2021）及 NHS 官方页面（https://www.nhs.uk/symptoms/chest-pain/），其支持引文均逐字核验存在于对应的 8 个保存工件中。
- 全部 30 条参考文献均具有可核验标识：19 条含 PMID，其中 8 条同时为本文保存的全文证据；指南与共识以正式名称、发布机构与年份著录；注册试验以 NCT 编号著录。
- 去重：核心 16 条 PMID/DOI 记录经去重工具核验为 16 条唯一记录（`duplicates: []`）；全检索集 258 条记录按 DOI、PMID、规范化标题去重后余 81 条，最终纳入 30 条，去重流程无冲突。
- 引文-来源匹配：矩阵中直接主张的 `supportQuote` 均逐字核验存在于对应保存全文/官方页面（含空白归一化与省略号省略规则核验）；综合主张（CLM-035、CLM-036、CLM-040）各含 2 个独立保存来源的独立引文。未发现引文不匹配（claim-source mismatch）。
- 撤回与更正：逐条核对 PMID 记录，未发现撤回（retraction）、更正声明（correction）或表达关切；Cochrane 系统评价 CD004473.pub2 为现行版本（未见更新版本替代）。

## 未解析或未能验证的标识符（unresolved）

- 以下来源的全文不可获取，仅以摘要或记录层面引用，其定量表述只在摘要可支撑的范围内作出，且已在报告局限性中声明：Li 2006（J Clin Invest，Europe PMC 全文上游暂不可用，两次尝试失败，仅获摘要）；Duan 2008（Cochrane，cochranelibrary.com 403）；Miura 2017（Chem Biol Interact，无开放获取）；Smida 2026（Prehosp Emerg Care，无开放获取）；Gulati 2021（AHA/ACC 胸痛指南，仅摘要）；Byrne 2023（ESC ACS 指南，academic.oup.com 403）；Li H 2009、Zahn 2001、Mackenzie 2005、JACC 2008 CGRP、Zhang 2007（摘要/题录层面）。
- gnomAD 连接器对 rs671 的查询返回“Gene not found”，人群等位基因频率改用已发表的文献数据（Xia 2015 队列测量、Li H 2009 地理分布综述、Molecules 2021 综述），未使用未经核验的数据库字段。
- 速效救心丸与硝酸甘油片的 NMPA 说明书文本经药品说明书索引工具获取（非证据检索通道，故未计入检索日志），为索引记录，未取得当前官方文本的修订日期核验；报告中仅引用其适应症、禁忌与注意事项文本，标注“官方现行版本需核验”。
- 来源内部一致性备注：Xia 2015（PMID:25591559）原文同时报告的 G/A 等位基因频率（82.8%–17.2%、81.4%–18.6%）与其基因型计数（如非冠心病组 GG 196、GA 130、AA 30）按等位基因频率公式换算的结果（A 频率约 26.7%）存在出入；本报告与矩阵按原文逐字引用该频率值，携带者比例（GA+AA）仅取决于基因型计数加和，不受该出入影响；此问题已记录于此并在推导主张 CLM-039 的方法中说明。

## 元数据受限（metadata-only）

- Shry 2002（Am J Cardiol）：仅获题录（Europe PMC 元数据），其结论在正文中经由 Steele 2006 全文的明确转述（“corroborates recent work done by Shry and colleagues”）间接引用，未直接引用其数字。
- Zhang 2007（中华内科杂志，PMID 17967228）：仅题录；其 5 分钟缓解率数据经 Molecules 2021 保存全文的逐字转述引用。
- 林泉 2021（天津中医药，CNKI 记录）：以摘要层面引用其结论（联合用药组临床终点事件发生率更低），具体效应量与试验计数未纳入报告定量表述（摘要层面不可核验，未建立矩阵主张）。
- 刘盛力 2010（中国实用内科杂志，SinoMed 记录）：以摘要层面引用其农村心梗救治现状结论，具体数值（平均治疗时间、6 小时治疗比例、中药使用率）未纳入报告定量表述。
- Smida 2026（Prehosp Emerg Care）：以摘要层面引用其定性结论（院前含服硝酸甘油与复合结局下降无关），数值未纳入报告定量表述。
- Molecules 2021、Suxiao 2018 Meta、JACC 2008 CGRP 三篇文献的完整作者名单未能经本环境可用连接器取得，参考文献中以期刊/DOI/PMID 著录并省略作者列表（不补造缺失元数据）。

## 重复（duplicate）

- 检索阶段出现跨来源重复（如 PMID 12450614 在三次检索中返回、PMID 16440063 与 18254051 各在两次检索中返回），已在筛选计数中计入并在去重后排除；最终参考文献列表无重复条目。

## 更正/撤稿检查（correction/retraction）

- 未发现所引文献存在更正、撤稿或表达关切。2021 年 AHA/ACC 胸痛指南与 2023 年 ESC ACS 指南均为现行有效版本（截至检索日期）。

## 引文不匹配（claim-source mismatch）

- 未发现。设计约束：矩阵引文仅取自 8 个已保存工件；报告正文中对摘要层面来源（Li 2006、Cochrane、Miura、Smida 等）的归属均与其记录标识一致，未把题录包装为已读全文，未虚构未报告的研究设计、样本量或效应量。
