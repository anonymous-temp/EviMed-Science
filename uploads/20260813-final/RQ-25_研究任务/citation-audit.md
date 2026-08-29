# 引用与来源核验审计（Citation Audit）

本审计记录本报告引用核验的实际操作与发现，包括未解决的监管事实、去重、修订/撤稿核查、仅题录记录与逐条 claim-source 匹配结果。检索日期均为 2026-08-14。

## 一、未解析（unresolved）的监管事实（无法核实项）

1. **速效救心丸的处方药/非处方药分类属性（含甲类/乙类）**：无法核实。
   - 原因一：国家药品监督管理局（NMPA）的药品登记信息、非处方药目录、处方药–非处方药转换公告页面不在可及官方网关白名单内（`evimed_official_page_fetch` 白名单仅含 Cochrane、ACC、AHA、NHS、湖南药监等指定路由，无 NMPA 国家局）。
   - 原因二：药品标签检索仅返回 EviMed 索引副本（来源标注"需与官方现行文本核对"），其字段不含分类属性、不含批准文号（国药准字），且返回 URL 指向内部索引地址，不可作为公开可引来源。
   - 原因三：中文全文数据库（CNKI、万方、维普）不可访问；以"速效救心丸 非处方药/甲类/批准文号/说明书修订"为检索式的中文文献检索命中的均为科普与专家意见题录，无分类或转换公告记录。
   - 结论：现行分类属性、不同规格/批准文号之间分类是否一致、处方药↔非处方药转换、甲类↔乙类调整，均**无法核实**；本报告相应表述一律为条件句，未断言任何具体分类。

2. **批准文号（国药准字）**：无法核实（同上，标签索引副本不含该字段）。

3. **分类沿革各次调整的文件文号与日期**：无法核实（无官方目录/公告可及）。

## 二、去重与重复（duplicate）

`evimed_evidence_deduplicate` 对 14 条候选记录去重，得 12 条唯一记录，去除 2 条重复（按 DOI 匹配）：
- `Efficacy of Suxiao Jiuxin Pill on Coronary Heart Disease: A Meta-Analysis...`（PMID 29770157）在 literature、europe-pmc、crossref 多来源命中，保留 1 条。
- `Chinese herbal medicine suxiao jiuxin wan for angina pectoris`（PMID 18254051）以 `.pub2` 与无版本两种 DOI 命中，保留 `.pub2` 版本 1 条。

## 三、修订、撤稿与更正核查

对纳入的 6 篇保留全文/官方页来源逐条核验，未发现撤稿、更正或关注声明记录。核查方式为欧洲 PMC 全文元数据与 PubMed 记录比对；未使用第三方撤稿数据库（不可及）。

## 四、仅元数据/题录（metadata-only）记录（未作为 claim 来源）

以下记录在检索中命中但全文未获，**未用于任何带引文的 claim**，仅在正文"资料与方法/局限性"中作为题录注明：

- Duan X, Zhou L, Wu T. Chinese herbal medicine suxiao jiuxin wan for angina pectoris. Cochrane Database Syst Rev. 2008;(1):CD004473. PMID 18254051.（摘要级命中，Cochrane 全文 403 不可及）
- Sun YL, et al. Evaluation of the efficacy and safety of Suxiao Jiuxin Pill in the treatment of stable angina... J Ethnopharmacol. 2024. PMID 37487965.（PubMed 题录）
- 中医诊断变量信度（膝骨关节炎，PMID 22897413，全文未获）与冠心病痰瘀互结证诊断量表方案（PMID 29721788，全文未获），仅作为"自我辨证准确性直接证据缺失"的旁证题录。
- 多篇就医延迟研究（PMID 11410572、20123674、37353965 等）仅题录级命中，具体数值未采用。

## 五、claim-source 逐条匹配

16 条 claim（CLM-001 至 CLM-016）逐条核对：每条 direct claim 的 `supportQuote` 均逐字存在于对应保留全文（full_text）或官方页（official_page）中；synthesized claim CLM-016 的两个 supporting source 引文均逐字存在；derived claim CLM-015 的 `derivedFrom` 指向 CLM-003、CLM-004 两条已测量证据链。未发现 claim-source 不匹配。

CLM-013 为紧急呼叫类 claim，其引文同时包含"行动（Call 999 straight away）"与"症状条件（sudden pain or discomfort in your chest that does not go away）"，符合紧急呼叫类 claim 的引文要求；正文按中国规范将急救号码本土化为 120。

## 六、保留来源清单（canonical artifacts 及已核验标识符）

逐条核验的来源标识符（与证据矩阵 claim 的 `identifier` 字段一致）：PMID 39367481（DOI 10.1186/s12906-024-04661-5）、PMID 34281600（DOI 10.1186/s13063-021-05448-6）、PMID 29770157（DOI 10.1155/2018/9745804）、PMID 24083004（DOI 10.5812/ircmj.2367）、PMID 31766823（DOI 10.3904/kjim.2019.123）、https://www.nhs.uk/symptoms/chest-pain/。

1. `.evimed-sources/official-pages/e6143b76645a9461/page.md` — NHS Chest pain（官方页，https://www.nhs.uk/symptoms/chest-pain/）
2. `.evimed-sources/PMC11451125/fulltext.md` — 慢性冠脉综合征硝酸酯不耐受 RCT（全文，PMID 39367481 / DOI 10.1186/s12906-024-04661-5）
3. `.evimed-sources/PMC8287819/fulltext.md` — 稳定型心绞痛 RCT 方案（全文，PMID 34281600 / DOI 10.1186/s13063-021-05448-6）
4. `.evimed-sources/PMC5892298/fulltext.md` — 疗效 meta 分析（全文，PMID 29770157 / DOI 10.1155/2018/9745804）
5. `.evimed-sources/PMC3785905/fulltext.md` — 心梗院前延迟横断面（全文，PMID 24083004 / DOI 10.5812/ircmj.2367）
6. `.evimed-sources/PMC6960059/fulltext.md` — KAMIR-NIH 院前延迟注册研究（全文，PMID 31766823 / DOI 10.3904/kjim.2019.123）
