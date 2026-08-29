# 引用与来源审计（citation-audit）

本审计记录证据矩阵（clinical-evidence-matrix.json）、引用台账（citation-ledger.csv）与参考文献（references.bib）之间的核对结果，以及未解决（unresolved）标识符、重复（duplicate）、更正/撤稿（correction/retraction）、元数据级（metadata-only）记录与"主张—来源不匹配（claim-source mismatch）"情况。

## 核对范围与方法

- 对 21 项矩阵主张逐一核对了 supportQuote 是否逐字出现在其 artifactPath 所指的已保存来源中；核验方式为按保存的全文逐句比对。
- 对 17 条候选关键记录运行了去重，未发现重复记录。
- 逐条核对了参考文献的 DOI、PMID、PMCID 与来源索引返回的标识符是否一致。
- 已核对的矩阵来源标识符（逐字引自 clinical-evidence-matrix.json 的 identifier 字段）：PMC11451125; doi:10.1186/s12906-024-04661-5、PMC8287819; doi:10.1186/s13063-021-05448-6、PMC5892298; doi:10.1155/2018/9745804、PMC12990816; doi:10.2147/PPA.S567649、PMC5907402; doi:10.1186/s40360-018-0206-5、PMC9703419; doi:10.1186/s12872-022-02892-3、PMC7492823; doi:10.1136/bmj.m3208。

## 主张—来源对应情况

- 20 项 direct 主张均有已保存全文或官方网页来源（accessLevel 为 full_text 或 official_page），supportQuote 为来源原文，逐字核对通过。
- 1 项 derived 主张（CLM-017）无单一来源，其推导输入为 CLM-004、CLM-005，method/assumptions/sensitivity 已在矩阵中列明；正文中该主张以「〔推导〕」标记。

## 未解决（unresolved）/ 元数据级（metadata-only）来源清单（如实记录）

| 参考文献 | 标识符 | 可及层级 | 说明 |
| --- | --- | --- | --- |
| [1] NMPA 速效救心丸说明书 | 国药准字 Z12020025 | structured_record（索引件） | 官方现行文本未获核验；正文中功能主治、禁忌、注意事项、储存等表述依据索引件转述，矩阵未为这些字段提供 supportQuote。 |
| [6] Cochrane 系统评价 2008 | PMID:18254051 | abstract | 全文获取被拒（403），效应量（ECG RR 1.16、症状 RR 1.09）引自 Europe PMC 摘要，矩阵未载其 supportQuote；同方向证据由全文来源 [5] 承担。 |
| [7] J Tradit Chin Med 2020 | PMID:32744020 | abstract | 摘要级；效应量（UA RR 0.34、AMI RR 0.35）引自摘要，矩阵未载其 supportQuote。 |
| [8] 中国中西医结合杂志 2019 | CNKI 题录 | abstract | 题录级；结论"均不能改善多支病变心肌供血"引自摘要。 |
| [11] Beyene 2014 | PMID:24524496 | abstract | 摘要级；借用率 5% 至 51.9%、共享率 6% 至 22.9% 这一区间经 CLM-020 以全文来源 [10]（其引用 Beyene 之段落）逐字承载，[11] 为其原始出处、仅摘要级。 |
| [12] Cao 2010 | PMID:20938251 | abstract | 摘要级。 |
| [14] 专家共识 2019 | 指南索引 | structured_record | 仅获摘要/简介，疗程等表述未逐条核验。 |
| [15] ClinicalTrials.gov | NCT06531161; NCT05466968; NCT04814121 | structured_record | 注册记录，均未招募或状态未知，无结局数据。 |
| [17] 中国中药杂志 2020 | CNKI 题录 | bibliographic_only | 仅题录，作者与效应量未取得；正文未据此作出定量主张。 |
| [18] 中日医药信息网 | https://www.ccfdie.org/zryyxxw/ | official_page | 已保存网页，仅提供《处方药网络零售合规指南》发文线索，指南全文未取得。 |

## 未解决/失败的全文字获取（不计入证据）

- Cochrane 2008（PMID:18254051 / DOI 10.1002/14651858.CD004473.pub2）：cochranelibrary.com HTTP 403；PMC7137214 两次上游不可用。
- Beyene 2014（PMID:24524496）、Cao 2010（PMID:20938251）：无开放获取 PDF。
- Sun YL 2023 J Ethnopharmacol（DOI 10.1016/j.jep.2023.116959）：无开放获取 PDF。
- VITAL-AF（PMC8960369）、STROKESTOP（PMC7905702）、AF-SCREEN（PMC9673231）：上游临时不可用。
- 上述来源均未进入证据矩阵，正文未据其作出定量主张。

## 更正、撤稿与版本

- 检索所得题录与元数据未显示任何纳入来源存在撤稿或更正状态；本轮未对全部 18 条参考文献运行专门的撤稿登记库比对，故"无撤稿/更正"仅指检索所得元数据未标记，不构成正式撤稿核查结论。

## 结论

21 项矩阵主张中，20 项直接主张均有可逐字核对的已保存来源；1 项为推导主张（CLM-017）并已列明推导链。7 条参考文献为摘要或题录/元数据（metadata）级，正文中相应的定量或规范性表述已相应降级、并标注"索引件/题录/摘要，官方现行文本未核验"或未作定量主张；其中借用/共享现患率区间已由 CLM-020 锚定至全文来源 [10]。无重复（duplicate）记录；无主张与来源不匹配（claim-source mismatch）的直接主张；未发现更正或撤稿（correction/retraction）标记。
