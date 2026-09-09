# Citation audit

核查时间：2026-09-09。核查范围：本次证据综述的全部 5 条编号参考文献、29 条矩阵主张、检索日志与保留原文。

## 标识符解析

- 5 条编号参考文献均完成标识符核验：DOI 经 Crossref 元数据核验（题名、刊名、年份一致）；PMID/PMCID 经 Europe PMC/PubMed 记录交叉核验。逐条结果：DELIVER（PMID 36027570，DOI 10.1056/NEJMoa2206286）；ESC 2023 聚焦更新（PMID 37622666，DOI 10.1093/eurheartj/ehad195）；EMPEROR-Preserved EHJ 分析（PMID 36478225，PMC9890225，DOI 10.1093/eurheartj/ehac693）；Yang 2022（PMID 36158789，PMC9492916）；Hamid 2024（PMID 39400108，PMC11483696）。无未解析标识符。更正记录：初稿曾将 ESC 2023 聚焦更新误记为 PMID 37622657（该编号实为 2023 ESC 心肌病指南），经 PubMed/Europe PMC 复核更正为 37622666，references.bib、matrix、ledger、run 与检索日志已同步。
- 未编号为参考文献的检索命中（注册库 NCT03057951/NCT03619213、欧洲 PMC 题录、EMPEROR-Preserved 主文 NEJM 2021 等）在 `clinical-evidence-search.json` 中列为 `included:false` 并记录原因，不承载正文主张。

## 重复与合并

- DELIVER 与 EMPEROR-Preserved 的记录在多个数据库检索中重复出现，按 PMID/DOI 去重；EMPEROR-Preserved 主文（Anker NEJM 2021）全文未开放（HTTP 403），其结论由保留全文的 ESC 2023 聚焦更新与 Böhm 2023（EHJ）共同承载，二者是对同一试验的独立保留文本，不构成独立复制证据，正文按"同一试验"处理。
- 系统综述 Yang 2022 与 Hamid 2024 为不同团队、不同文献集的独立研究，正文未将其同质化为独立试验。

## 更正、撤稿与关切声明

- 截至核查日，5 条参考文献均未检出撤稿、更正或关切声明；检索返回的题录元数据未标记 retracted/correction 状态。

## 元数据层级记录

- 仅题录/摘要层级（`metadata_only`）的命中已排除：EMPEROR-Preserved 血镁亚组（JACC Heart Fail 2026）、DELIVER 年龄亚组（Peikert 2022）、DELIVER 近期住院汇总（Front Cardiovasc Med 2026）、Long-term prognosis SR/MA（2026）等；Europe PMC 连接器返回的摘要文本未当作已读全文。
- ESC 2023 聚焦更新经 HAL 开放镜像（submitted version）获取全文；发布版本（Eur Heart J 2023;44(37):3627–3639）经 Crossref 核验题名、作者、卷期页一致。DELIVER 经格拉斯哥大学仓储开放 PDF（对应 NEJM 发布版）获取全文。
- 2022 AHA/ACC/HFSA 指南的指南库保留文本经检查为节选，未能在其中定位到 SGLT2 抑制剂用于 HFpEF 的推荐条文原文（COR/LOE）；因此正文对"2a 类推荐"的表述经 Yang 2022 正文（保留全文，原文陈述该指南给予 2a 类推荐）承载并限界为指南语境，另由 DELIVER 论文讨论中记载的 class IIA/level B 交叉印证。

## 主张-来源一致性

- 每条 direct 主张的 `supportQuote` 均与保留原文做了存在性校验（精确匹配或空白归一化匹配），结果全部通过；矩阵装配校验输出无警告。
- 每条主张中的数字均可在其引文（quote）、来源标题或标识符中找到；derived 主张（CLM-023）的数字均出现在其 method/assumptions/sensitivity 中，可复核。
- synthesized 主张均挂靠 ≥2 个不同文档的保留原文（如 CLM-009 挂靠 ESC 2023 与 DELIVER；CLM-013/014/015 挂靠 ESC 2023 与 DELIVER）。
- 经交叉审查修正的主张保真度问题：CLM-010 原引 Yang 摘要值（HR 0.78，0.69–0.88），而该综述正文 Figure 3A 报告的分析结果与此不同，已删除该数字、保留方向性表述并注明"仅作方向佐证"；CLM-012 原把 Hamid 综述框定为"以射血分数较高人群随机试验为对象"，其实际纳入研究含他类 SGLT2 抑制剂的心血管结局试验，已改述为方向佐证并写明局限；CLM-018 原主张将"eGFR 斜率与安全性监测"归于两项试验而支持引语仅覆盖 EMPEROR 一侧，已将主张收窄至 EMPEROR-Preserved 分析并有引文支持（Böhm 全文 "rate of decline in estimated glomerular filtration rate was studied"），正文同步改写。
- 未发现主张与其来源相冲突的条目；负面结论（心血管死亡、全因死亡未达显著）由 picoMatch 全部为 same 的主张承载，未将"未检索到"写成"无效"。
