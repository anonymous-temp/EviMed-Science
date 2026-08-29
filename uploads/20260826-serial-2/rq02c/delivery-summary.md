# 交付摘要

- 运行 id：run_1722cd121ef9d88ad706a73256a10250
- 完成时间：2026-08-26T13:06:35.653Z
- 交付方式：部分交付（尝试次数或预算已用尽）

## 澄清与假设

- 假设：中文全文数据库（CNKI、万方、维普）在本环境不可访问，中文文献仅能通过 PubMed/Europe PMC/Crossref 等国际数据库的收录部分获取；此检索缺口按题面要求写入论文局限性。
- 假设：任务要求面向临床医师与药师的学术论文，但本系统不提供具体个体诊疗建议，最终以证据综述与一致性评价呈现，临床实践要点仅陈述证据层面结论，并保留'任何自救用药不得作为延迟呼叫急救的理由'的安全底线。
- 假设：速效救心丸的国家药监局核准说明书若在可检索范围内无法获取全文或原文时间界限，将以'未检索到直接证据'表述，不以药理/中医病机机制推断替代缺失的临床证据。
- 假设：指南推荐的'推荐类别与证据等级'以指南原文表述为准；检索不到原文分级时明确标注'未获取原文分级/未检索到直接证据'，不以本文措辞替换。
- 假设：本任务不开展新临床试验、不使用个体患者层面数据，遵循题面声明。
- 假设：时间阈值证据体按 GRADE 陈述确定性并写明升降级理由；指南方法学质量可用 AGREE II 说明；随机对照试验用 RoB 2、非随机干预性研究用 ROBINS-I；药物与不良事件因果关系归因采用 Naranjo 量表或 WHO-UMC 并写明评定依据。

## 交付物

| 交付物 | 契约种类 | 能力 | 状态 | 提交次数 |
| --- | --- | --- | --- | --- |
| 舌下含服硝酸甘油或速效救心丸后胸痛不缓解的时间阈值与院外升级路径：指南推荐的证据基础与一致性评价 | clinical-evidence-report | clinical-evidence-synthesis | rejected | 3 |

## 未决问题

- （required）deliverable_not_accepted：交付物「舌下含服硝酸甘油或速效救心丸后胸痛不缓解的时间阈值与院外升级路径：指南推荐的证据基础与一致性评价」当前状态是 rejected，尚未通过契约校验。
- （required）clinical_content_without_clinical_contract：/workspace/clinical-evidence-search.json 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/references.bib 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/citation-audit.md 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/clinical-evidence-run.json 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/question-coverage.json 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （advisory）clinical_content_in_reply：最终回复提到 速效救心丸，服务端会对它再跑一次安全扫描。
