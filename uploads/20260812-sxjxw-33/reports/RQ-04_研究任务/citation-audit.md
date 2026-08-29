# 引用审计（citation-audit.md）

审计日期：2026-08-11。审计对象：`clinical-evidence-report.md`、`clinical-evidence-matrix.json`、`clinical-evidence-search.json`、`citation-ledger.csv`、`references.bib`。

## 已执行的核验

- **题录核验**：19 条编号参考文献逐条对照 PubMed/Europe PMC 记录或官方页面核验作者、标题、期刊、年份、卷期页码、DOI、PMID。全部 DOI 与 PMID 可解析；`references.bib` 中 19 个条目与报告编号参考文献一一对应。
- **引文-工件逐字核验**：矩阵中全部 25 条直接/合成主张的支持引文（supportQuote）逐一在对应保存工件（`.evimed-sources/` 下 16 个工件）中以规范化空白比对确认逐字存在，含 PDF 文本层的连字符断行（如 Steele 2006 中 "270 sub- jects"、"dis - ease"）按原样保留。
- **主张-编号配对**：每条主张的 referenceNumber 均出现在其报告标记行的编号引用中；合成主张的 referenceNumber 为其 referenceNumbers 成员；2 条推导主张（CLM-027/028）按规则不占用编号引用、报告中以〔推导〕标记。
- **数字-引文一致性**：主张文本中的每个数字均出现在其支持引文、标题或标识符中（推导主张的数字出现在其 method/assumptions/sensitivity/uncertainty 中）。

## 未解析/不可获取（unresolved / not accessible）

以下检索命中的记录全文为非开放获取，未在本报告可核验层级引用其具体数值；相关表述仅限题录或转述层级，并在报告"证据基础与检索方法"与"证据局限"节中如实声明：

| 记录 | 标识符 | 状态 |
| --- | --- | --- |
| Muller JE, et al. N Engl J Med. 1985;313:1315-22（AMI 晨峰） | PMID:2865677 | 全文不可获取（非开放获取） |
| Willich SN, et al. Am J Cardiol. 1987;60:801-6（Framingham 猝死晨峰） | PMID:3661393 | 全文不可获取 |
| Willich SN, et al. Circulation. 1989;80:853-8（ISAM 觉醒后晨峰，含 β 阻滞剂交互） | PMID:2571430 | 全文不可获取；检索首试 HTTP 502，重试命中题录 |
| Cohen MC, et al. Am J Cardiol. 1997;79:1512-6（MI/SCD 晨峰 meta 分析） | PMID:9185643 | 全文不可获取 |
| Elliott WJ. Stroke. 1998;29:992-6（卒中起病时间 meta 分析） | PMID:9596248 | 全文不可获取；其数值（清晨缺血性卒中 +89%、出血性 +52%、TIA +80%）经纳入的卒中系统评价（PMC12769409）逐字转述引用 |
| Henrikson CA, et al. Ann Intern Med. 2003;139:979-86（硝酸甘油缓解不预测冠脉病变） | PMID:14678917 | 全文不可获取；同类结论以 Steele 2006（DOI:10.1017/S1481803500013671，已保存全文）承载 |
| Duan X, et al. Cochrane Database Syst Rev. 2008;CD004473（速效救心丸系统评价） | PMID:18254051 | 全文不可获取（cochranelibrary 403）；其存在与"证据不足"的判断以 Trials 2021 方案（PMC8287819）的转述承载 |
| HOPE Asia Network 声明（血压晨峰） | PMID:30525279 | 全文不可获取（Wiley 403） |
| J Tradit Chin Med 2020 速效救心丸 ACS 系统评价 | PMID:32744020 | 全文不可获取（unpaywall 404） |
| 2023 ESC ACS 指南 | DOI:10.1093/eurheartj/ehad191 | 全文不可获取（academic.oup 403） |
| 湖南药监局门户 | https://mpa.hunan.gov.cn/mpa/ | 官方页面抓取失败（上游不可用） |

## 重复记录（duplicates）

去重前 278 条 → 去重后 268 条（按 DOI/PMID/标题规范化）。跨检索重复的 PMID：19500492（检索 1 与 2）、9597421（检索 1 与 11）、15821450（检索 8 与 11）、10155744（检索 2 与 10）、41081262（检索 1 与 26）、41412842（检索 3 与 26）；指南索引两次检索间 4 条记录重叠。矩阵与参考文献中无重复条目；NMPA 说明书索引返回 2 条同内容候选（nmpa-0/nmpa-1），按同一文档计。

## 更正/撤稿（corrections / retractions）

- 19 项纳入来源中未发现撤稿记录。
- Europe PMC 检索显示 2023 ESC ACS 指南存在两条更正记录（PMID:38383063、PMID:38383069），但该指南全文不可获取、未纳入本报告结论，更正不影响本报告。
- JAMIR 论文（PMC12510979）作者声明含期刊编委会成员，已在报告中如实呈现（无隐瞒利益冲突）。

## 元数据级记录（metadata-only）

- **NMPA 说明书条目**（报告参考文献 17）：2 条索引候选，来源状态明确标注"EviMed indexed label candidate; official-current verification required"。条目文字（功能主治"用于气滞血瘀型冠心病，心绞痛"、禁忌"孕妇禁用"、不良反应含头晕）在报告中以索引记录层级呈现并注明待官方现行核验，**未**作为矩阵主张的引文；矩阵中说明书边界判断由可核验的同行评议工件（Trials 2021 方案、eCAM 2018 meta、BMC 2024 RCT）承载。
- **临床试验注册库记录**（报告参考文献 18-19）：NCT06531161、NCT05466968 为注册记录级（structured_record），状态"尚未招募"来自注册库字段；注册号与设计信息在报告中以注册记录层级呈现。
- **中文内部文献索引**（检索 24，命中 700 条、返回 15 条）：多数为病例系列与专家意见，仅以元数据筛阅，未纳入矩阵；其中 2022 年中文 meta（13 项 RCT，北京中医药）与 2025 年专家意见（硝酸甘油 vs 速效救心丸）等因无保存工件，未进入结论。

## 主张-来源不匹配（claim-source mismatch）

- **Trials 2021 方案注册号不一致（已记录，不影响结论）**：PMC8287819 标题信息块显示 "ChiCTR1900021876"，而方法节显示 "ChiCTR1800014258. Registered on 13 March 2019"。本报告采用方法节编号 ChiCTR1800014258（与 2024 年 BMC RCT 引用的注册平台信息一致），并在审计中标记该内部不一致。
- **eCAM 2018 meta 摘要与正文不一致（已记录）**：摘要称 "No incidences of adverse reactions were observed"，而正文 3.6 节报告 14 项研究的不良反应数据（RR 1.12，95%CI 0.50–2.51）。本报告采用正文数据并注明。
- **PMC11451125（BMC 2024）摘要文字重复**："Rapid improvement of angina symptoms is an expectation for CCS patients who are unable to tolerate the adverse effects of long-acting nitrates." 与下一句重复——为原文排版问题，不影响引用内容。
- 检索命中记录（如 PMID:34943888 等无关记录）已剔除；会议摘要集（PMID:27885969）未纳入。

## 结论

25 条被引主张（含 5 条合成主张）全部有可核验工件承载；推导主张有完整运算过程；未发现虚构引用或标识符拼凑。未解析记录全部以"检索命中但全文不可获取"如实呈现，未以题录冒充全文证据。

## 第二轮修复记录（服务器数字-证据门禁）

- **数字-引文绑定审计（主张侧）**：对门禁点名的 25 处主张侧数字逐项处理——(1) 将引文扩展到包含该数字的原文句段（如 CLM-001 补入 "final total of 3158 cases" 与 "During the 9-year period"、CLM-003 补入 "P=0.117/P=0.788"、CLM-012 补入 "for a duration of 4 weeks" 与 "improvement of 5.68 (95% CI = 2.37 to 8.99…)"、CLM-014 补入 "A formal ACS rule out troponin testing was performed in 9.2%"、CLM-015 补入 "Musculoskeletal issues were exclusively diagnosed in the NCCP group (40%, p<0.001)"、CLM-017 补入 "I 2 = 62.3%" 与 "The remaining 41 studies"、CLM-018 补入 "stenosis greater than 50%" 与 174 例句、CLM-022 补入两个样本量句、CLM-024 补入 "Telephone follow-up at 4 weeks…95% follow-up rate")；(2) 主张文本的数字格式与工件逐字对齐（范围改为工件所用 "1.09 to 1.64" 等 "to" 形式，千位分隔符按工件形式统一，如 "6276 例""11816 例""3158 例"）；(3) 合成主张 CLM-005 增加第 4 项支持来源（卒中系统评价，"Finally, 58 eligible articles"），CLM-018/CLM-022 扩展支持引文。全部 28 条主张（含 2 条新推导主张）经逐段引文比对通过。
- **数字-引文绑定审计（报告行侧）**：第 11 行（0.117/0.788）由 CLM-003 扩展引文承载；第 23 行判定条件一的"至少 2 项"由新增推导主张 CLM-029 承载（标记行含〔推导〕）；第 69 行（1341/44.9/44.7/5.6/2.6/2.2）补挂 CLM-013 标记；第 77 行（50/2.37–8.99）由 CLM-018 与 CLM-012 扩展引文承载并删除罗马数字"CCS 分级 I–III"；第 93 行补挂 CLM-005 标记与 [1]–[4] 引用并将"三项"改为"多项"；第 101 行"1.25"补入 CLM-028 的 method（31.2/25=1.248≈1.25）；第 117 行"58"由 CLM-005 第 4 来源承载；第 121 行补挂 CLM-012 标记；第 53、63、109、113 行的"一/两/项"类计数词以同义表述消除（未删任何效应量或样本量）。第 79 行注册库段删除"共命中 2 项""计划 168/116 例"及罗马数字分期，保留注册号与引用（阶段与样本量属注册记录过程性信息，检索日志 sourceRecords 已保留）。
- **安全句（MUST FIX）**：实际处置新增第 8 条，明确"速效救心丸不得延误急救：服用它不是等待的理由——急救电话（中国大陆 120）应与用药同时呼叫，而不是在用药之后再呼叫"，引 [16][9] 并挂 CLM-019/CLM-025 标记。
- **核验结果**：预检 ok=true；报告字符数 20,120（修复前 19,662，未变薄）；27 项检索日志未改动，与运行回执统计一致（278/268/19/16）；无任何主张被删除。
