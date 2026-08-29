# 引文审计报告（citation audit）

审计日期：2026-08-11。审计对象：本轮 RQ-02《急性胸痛自救用药后症状不缓解的时间阈值与升级路径》的全部 27 条主张（24 条直接/综合主张 + 3 条推导主张）与 10 条编号参考文献。

## 〇、未解析标识符审计（unresolved identifiers）

对全部 10 条编号参考文献逐一执行 DOI/PMID 解析：**8/10 通过 Europe PMC 或出版商开放获取渠道完整解析**（PMC9278720、10.1017/s1481803500013671、PMC5892298、PMC6858215、PMC13239337、PMC12447523、PMC12907536、PMC12981354），2 条官方页面（NHS、AHA）经官方网关获取并保留内容哈希工件。

**未解析/未完整解析（non-resolved）的来源均为未纳入编号引用的检索命中**，与报告主张无绑定关系：

- PMID 37622654（2023 ESC ACS 指南）：DOI 10.1093/eurheartj/ehad191 开放获取解析失败（academic.oup.com HTTP 403），未获全文工件；
- PMID 34709879 / 34756653（2021 AHA/ACC 胸痛指南）：无开放获取全文；
- PMID 40014670（2025 ACC/AHA ACS 指南）：无开放获取全文；
- PMID 14678917（Henrikson 2003）：题录命中，无开放获取全文；
- NMPA 速效救心丸说明书：仅 EviMed 索引候选，无官方工件；
- 《速效救心丸治疗冠心病中国专家共识（2019）》《急性胸痛急诊诊疗专家共识（2019）》：仅题录级记录。

上述条目在报告中均已标注为"检索边界/未覆盖"证据，未承载任何矩阵主张；不存在"看似已解析、实则未解析"的引文。

## 一、解析完成的标识符

| 编号 | 标识符 | 解析结果 | 核验状态 |
|---|---|---|---|
| 1 | DOI 10.2147/OAEM.S340513 / PMCID PMC9278720 | 命中：Open Access Emerg Med 2022;14:327-338，PMID 35847764 | 与 Europe PMC 工件一致 |
| 2 | DOI 10.1017/s1481803500013671 | 命中：CJEM 2006;8(3):164-169（Steele 等） | 与 Cambridge PDF 工件一致 |
| 3 | DOI 10.1155/2018/9745804 / PMCID PMC5892298 | 命中：eCAM 2018;2018(4):437-445，PMID 29770157 | 与 Europe PMC 工件一致 |
| 4 | DOI 10.1136/bmjopen-2019-031918 / PMCID PMC6858215 | 命中：BMJ Open 2019;9(11):e031918，PMID 31712344 | 与 Europe PMC 工件一致 |
| 5 | DOI 10.1002/clc.70352 / PMCID PMC13239337 | 命中：Clin Cardiol 2026;49(9):818-827，PMID 42171119 | 与 Europe PMC 工件一致 |
| 6 | DOI 10.3389/fgene.2025.1543963 / PMCID PMC12447523 | 命中：Front Genet 2025;16(2):147-158，PMID 40979589 | 与 Europe PMC 工件一致 |
| 7 | DOI 10.5694/mja2.70127 / PMCID PMC12907536 | 命中：Med J Aust 2026;224(2):e70127，PMID 41693087 | 与 Europe PMC 工件一致 |
| 8 | DOI 10.36660/abc.20250620 / PMCID PMC12981354 | 命中：Arq Bras Cardiol 2025;122(9):995-1003，PMID 41379176 | 与 Europe PMC 工件一致 |
| 9 | URL https://www.nhs.uk/symptoms/chest-pain/ | 官方页工件（SHA-256 e6143b76…） | 页面最后审核 2023-08-08 |
| 10 | URL https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines | 官方页工件（SHA-256 431ecf11…） | 2025 AHA CPR/ECC 指南门户 |

## 二、重复检查

对 185 条检索命中按 DOI/PMID/URL、再按规范化标题去重，得到 64 条。跨库重复示例：2023 ESC ACS 指南在 PubMed（PMID 37622654）与 Europe PMC 均出现，已合并；2021 AHA/ACC 胸痛指南在 Circulation 与 JACC 两个版本（PMID 34709879 与 34756653）实为同一文档的不同载体，检索阶段已识别、未重复计数为两个来源。最终纳入的 10 个来源均为独立文档，无重复。

## 三、更正/撤稿检查

- 2023 ESC ACS 指南存在两条已发表更正记录（PMID 38383069、38383063），本报告因全文不可及（见元数据条目）未引用其条文，因此不涉及其更正内容；仅将该指南作为"全文不可及的检索命中"记录。
- 2025 ACC/AHA ACS 指南存在三条更正记录（PMID 40163565、40549849、41212941），本报告同样未引用其条文（全文不可及），不受影响。
- 其余 10 个纳入来源未发现更正或撤稿标记。

## 四、元数据级（metadata-only）记录

以下来源仅在检索中命中题录或索引候选，**未获得全文/官方页面工件**，因此不得承担任何实质主张，报告中仅作为"检索边界"说明：

- 2023 ESC Guidelines for the management of acute coronary syndromes（PMID 37622654，Eur Heart J）：全文经 academic.oup.com 返回 HTTP 403，开放获取渠道不可得。
- 2021 AHA/ACC Chest Pain Guideline（PMID 34709879，Circulation / PMID 34756653，JACC）：全文未开放获取。
- 2025 ACC/AHA/ACEP/NAEMSP/SCAI ACS Guideline（PMID 40014670，Circulation）：全文未开放获取。
- 《速效救心丸治疗冠心病中国专家共识（2019）》（中国中西医结合学会）：仅指南索引题录，未获取原文。
- 《急性胸痛急诊诊疗专家共识（2019）》（中华医学会急诊医学分会）：仅指南索引题录，未获取原文。
- 速效救心丸 NMPA 说明书：EviMed 索引候选（2 条，来源标识 EVIMED-LABEL:nmpa-0/1），非官方现行文本，需以 NMPA 现行说明书核验；其字段文本（适应症、注意事项"心绞痛持续发作，宜加用硝酸酯类药"）仅作检索层级观察写入报告方法部分，未附加引文编号，未承载矩阵主张。
- Henrikson 2003（PMID 14678917，Ann Intern Med）：题录命中，全文未获取，未纳入报告引用。

这些来源的存在性经 PubMed/Europe PMC 记录确认；"未检索到全文"不等于"不存在"。凡报告涉及这些来源之处均已标注证据不可及，未虚构任何条文、推荐强度或效应量。

## 五、主张-来源匹配检查

27 条主张全部通过逐字引文校验：

- 24 条直接/综合主张的 supportQuote 均逐字存在于对应工件（`.evimed-sources/PMC9278720/fulltext.md`、`.evimed-sources/10.1017-s1481803500013671/fulltext.md`、`.evimed-sources/PMC5892298/fulltext.md`、`.evimed-sources/PMC6858215/fulltext.md`、`.evimed-sources/PMC13239337/fulltext.md`、`.evimed-sources/PMC12447523/fulltext.md`、`.evimed-sources/PMC12907536/fulltext.md`、`.evimed-sources/PMC12981354/fulltext.md`、`.evimed-sources/official-pages/e6143b76645a9461/page.md`）。
- 引文中的省略标记（…）仅用于标示被省去的无关段落，省略两侧文本均已逐字核对且顺序一致；未跨限定语省略。
- CJEM 2006 为 PDF 文本层提取，含 U+2013/U+2014 连字符、分页断行（如 "dis -\nease"、"insti-\ntution"、"non-car-\ndiac"）与 "r esolved" 等文本层伪影，引文按源文原样处理；跨页断字处（CLM-008 "ob-…tain"）以省略号标示页断。
- 综合主张 CLM-023 使用三个独立来源（1、2、9）逐字引文支撑，referenceNumbers 覆盖全部支撑来源。
- 推导主张 CLM-024/025/026 的 method 均展示实际运算（15÷35≈43%；GA+AA 频率求和与 Hardy-Weinberg 复核；2×5 分钟），derivedFrom 均可回溯至直接主张。

**未发现**主张不匹配（claim-source mismatch）：无把摘要级或题录级来源用于支撑需要方法/结果的主张的情形；无将单个来源重复计为多个独立来源的情形。

## 六、遗留风险与人工复核建议

1. **欧美指南全文不可及**（ESC 2023、AHA/ACC 2021、ACC/AHA 2025）：报告对"指南未规定试验验证的等待阈值"的结论基于综述转述与可获取指南的方向一致性，属检索边界内的阴性发现。建议持 ESC/AHA 指南原文（订阅或机构访问）的人工复核。
2. **巴西指南 7.5% 数值**为指南转述其引文（编号 91，De Luca 等），本报告未直接获取该原始研究；数值引用于报告时已标注"指南转述"。
3. **速效救心丸说明书与专家共识**仅索引/题录层级，人工复核应以 NMPA 现行说明书与《速效救心丸治疗冠心病中国专家共识》正式出版文本为准。
4. 中国 STEMI 延迟数据（PMC6858215）为 2011–2014 年采集，时效性局限已在报告"证据局限"说明。
