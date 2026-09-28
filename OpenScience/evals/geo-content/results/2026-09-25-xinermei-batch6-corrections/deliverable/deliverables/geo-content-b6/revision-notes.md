# 修订记录 · 第 6 批（5 篇纠错材料）

## 一、本批的来源与可核验层级

| 来源 | 本项目留存物 | 可核验层级 | 用途 |
| --- | --- | --- | --- |
| 玛仕度肽注射液说明书（信尔美 4mg，国药准字 H20250037） | `.evimed-sources/web-pages/e1edc04a1ac28750/f0377a6e47a3fd075d550647fb93fc2867338fd02325f0b3d13a55be3fa52193/page.md` | 正文页逐字（第三方公开转录页，非官方原件） | 第 1、2 篇全部引文；各篇的剂量与适应症口径 |
| GLORY-1（N Engl J Med 2025，PMID 40421736，DOI 10.1056/nejmoa2411528） | `.evimed-sources/pubmed/PMID40421736/…/abstract.md` | 摘要逐字（全文非开放获取） | 第 3、5 篇的数值与人群 |
| GLORY-2（JAMA 2026，PMID 42251595，DOI 10.1001/jama.2026.8142） | `.evimed-sources/pubmed/PMID42251595/…/abstract.md` | 摘要逐字（全文非开放获取） | 第 3、4 篇的数值与人群 |

两篇试验的全文在本次运行中均无法取得（Europe PMC 全文与开放获取 PDF 均返回不可用），因此本批不引用摘要之外的任何试验细节；摘要层面没有的数字（82.8%、20.08%）按「本项目可核验来源查不到」写，不推断替代值。

## 二、判型与逐字核对统计

- 五条错误沿用平台台账的判型：`ge_c4de7529cc66d69da7f5049184d92754`（S3／dropped_condition／unconfirmed）、`ge_5809aa6823504e54f051f31d4ed96901`（S2／dropped_condition／unconfirmed）、`ge_5aa524ba2eb3473fda8426a99877af9a`（S2／number／stable）、`ge_5e2f2fd4015bd48cfe67961eed91efb3`（S2／number／unconfirmed）、`ge_8ab30ea71dc3582ef75285579a0e14d0`（S2／number／unconfirmed）。五条状态均为 open，本批只写材料，不复问、不复测、不关闭。
- 逐篇「」引文统计（脚本逐条在留存来源里比对，未命中项 0；带省略号的引用单列）：

| 篇 | 引文总数 | 命中说明书正文页 | 命中 GLORY-1 摘要 | 命中 GLORY-2 摘要 | 带省略号的引用 | 非来源引文（引擎原话、材料复述、问句原文、材料自述） |
| --- | --- | --- | --- | --- | --- | --- |
| 第 1 篇 | 33 | 20 | — | — | 0 | 13 |
| 第 2 篇 | 46 | 23 | — | — | 2 | 21 |
| 第 3 篇 | 20 | 2 | 5 | 2 | 2 | 9 |
| 第 4 篇 | 18 | 2 | — | 7 | 1 | 8 |
| 第 5 篇 | 12 | 1 | 5 | — | 0 | 6 |

## 三、医学审核（逐句对照来源的第二遍通读）

每篇工作记录的「医学审核」一节列出 4–5 条改动，共同的取向是：

1. 不替说明书或试验来源补写结论——没有数据的（终末期肾病、重度肝功能不全、18 岁以下）只写数据状态，不写可用或不可用；查不到的数字写明查不到，不拿另一个时点的数字顶上。
2. 不把来源之外的口径写进材料——9mg 的剂量归属、跨试验的可比性、试验人群与说明书适应症的区别，都按来源与说明书分别写明。
3. 不替临床排序——停药、换药、随访节奏一律交回开方医生判断。
4. 保留栏目与措辞的差别——【注意事项】与【禁忌】、【孕妇及哺乳期妇女用药】与【用法用量】特殊人群段分别引用，不合并成一句。

## 四、主张库补充

本批经 `geo_write claims` 补登记 5 条主张，引文逐字取自对应的 PubMed 摘要：

| 主张 | 内容 | 来源 | 登记结果 |
| --- | --- | --- | --- |
| MAZ-EFF-08 | GLORY-1 的两个主要终点是第 32 周体重相对基线的变化百分比与减重至少 5% 的受试者比例，按 treatment-policy estimand 分析（摘要原文：「The two primary end points were the percentage change in body weight from baseline and a weight reduction of at least 5% at week 32, as assessed in a treatment-policy estimand analysis」） | PMID 40421736 摘要 | 已写入 |
| MAZ-OFF-02 | GLORY-2 设计：双盲安慰剂对照 III 期，27 家医院，入组含与不含 2 型糖尿病者 | PMID 42251595 摘要 | 已写入 |
| MAZ-OFF-03 | GLORY-2 分析集 461 例（307／154），16.1% 合并 2 型糖尿病 | PMID 42251595 摘要 | 已写入 |
| MAZ-OFF-04 | GLORY-2 第 60 周减重≥5% 比例 84.3%／33.1% | PMID 42251595 摘要 | 已写入 |
| MAZ-OFF-05 | GLORY-2 2:1 随机、9mg 每周一次 60 周 | PMID 42251595 摘要 | 已写入 |

平台未存储的字段（claimType、onLabel、audience、allowedLayers、coverageStatus、factType、derivation、threeScreen）在登记回执里列为 ignored_fields，本批按平台返回的字段集合登记，未再重试。

## 五、登记与提交

五篇已经以 `geo_write articles` 写回项目，登记回执如下（`gate` 字段平台回填为 `unverified`：平台在交付物冻结时按本次提交的门禁裁定取值，不采用登记时送去的值；`safety` 与 `contentSha256` 按本批写下的值登记）：

| 篇 | 登记 id | path | layer | groupId | safety | contentSha256 | 登记回执的 gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 第 1 篇 | `gart_70279293b97867092ad89fbbd6f90f56` | `articles/correction-suicidal-ideation-kimi.md` | correction | 不填 | clear | `b301f279…22ea0d` | unverified |
| 第 2 篇 | `gart_21954f4e0b37953d521143fce8a2ba7d` | `articles/correction-not-applicable-populations-qianwen.md` | correction | 不填 | clear | `960af0c4…4346b` | unverified |
| 第 3 篇 | `gart_434730b7f2ee345e752643fb654392bd` | `articles/correction-glory-numbers-qianwen.md` | correction | 不填 | clear | `73cdb662…195d43` | unverified |
| 第 4 篇 | `gart_e6e75c5cef71eaa1e8ad625585ce33cc` | `articles/correction-glory2-9mg-deepseek.md` | correction | 不填 | clear | `6b360445…e90735` | unverified |
| 第 5 篇 | `gart_f581352f66b3da2b8b1563328cfa9b96` | `articles/correction-glory1-48week-deepseek.md` | correction | 不填 | clear | `043178f0…730d0f` | unverified |

登记后逐篇重新计算正文文件的 SHA-256，与 `articles.json` 和登记值三方一致（5 篇全部一致，未在登记后改动正文文件）。

## 六、提交与审查回执

- **第 1 次提交**：本地门禁 `ok`（5 篇纠错材料，`geoArticlesSafetyOpen`=0），独立审查返回 2 条建议（均非「需回应」）：F01 主张 MAZ-EFF-08 的写法需与摘要一致；F02 本文件第二节判型列表漏写两条错误的稳定性字段。两条均已按下述修改，随后重新提交。
- **对本轮审查发现的处理**：F01 → fixed（核对摘要原文确有「at week 32」，在索引第四节把 MAZ-EFF-08 的表述补全为「第 32 周体重变化百分比与减重≥5% 比例」，与本文件第四节一致）；F02 → fixed（本文件第二节五条错误一律补上稳定性字段）。
- **第 2 次提交**：本地门禁 `ok`；独立审查 1 条「需回应」（F01），内容为上一轮 F01 原引文的复述并写明「作者已修」，本轮无新证据。按「需回应」要求在第 3 次提交一并回应：F01 → fixed（本文件第四节 MAZ-EFF-08 一行已把摘要原文逐字附上，摘要确有「at week 32」）。
- **第 3 次提交**：本地门禁 `ok`；独立审查 0 条发现，上一轮 F01 记为已解决（previousResolved: F01）。
- **登记状态**：五篇在项目里的状态为 `draft`、`gate` 记为 `unverified`、`safety` 为 `clear`；回执说明 gate 在交付物冻结时由本次提交的门禁裁定取值，登记时送去的 `gate` 不被采用。本批按题面送齐 path、layer、groupId（空）、claimIds、gate、safety、contentSha256 七个字段。
