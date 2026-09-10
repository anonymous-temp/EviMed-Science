# 交付摘要

- 运行 id：run_2b99e6f6294c35fb1aaa04340e972143
- 完成时间：2026-09-10T04:09:17.707Z
- 交付方式：部分交付（尝试次数或预算已用尽）

## 澄清与假设

- 未反问（本部署不接受运行中追问），以下为直接采用的假设。
- 交付物：1 份 geo-content-pack，交付给 geo-content 能力；本轮不另出临床证据综述。
- 问题集完全按用户给定原文使用，不做改写或合并；有品牌 5 问与无品牌 5 问各自独立测量，无品牌问题不植入品牌词。
- 平台范围按用户给定 5 个：deepseek、doubao、kimi、qianwen、yuanbao；deepMode=0（默认深度）；若某平台未登录或调用失败，按『未被询问』记录，不计入未提及。
- 地域与语言口径假设为中国大陆、简体中文消费者场景；面向的答案引擎为上述 5 个消费者前端。
- 品牌事实（名称、批准文号国药准字Z12020025、说明书功能主治文字）为用户提供，视为待核验线索：在正文落笔前须以可解析的官方/公开来源核对；核对不到的字段写『未核实』，不得据用户输入当作证据引用。
- 合规边界：内容块不得给出个体化诊疗建议（具体含服粒数、加量、是否停药、能否替代硝酸甘油或急诊）；说明书载明的用法用量可作为说明书事实转述，并标明来源与适用范围。
- 安全优先假设：所有涉及急性胸痛的内容块必须写明立即就医/呼叫急救的条件，且该条件不依赖于任何药物是否起效；不得把中成药表述为急性心肌梗死急救用药。
- 证据层级假设：答案引擎回答为『测量结果』而非证据；事实性主张须另附可解析的公开文献、指南或监管/说明书来源。
- 如实测发现某平台输出与说明书或指南相冲突的安全性问题，须在测量记录与内容包中如实标注，不得隐去。

## 交付物

| 交付物 | 契约种类 | 能力 | 状态 | 提交次数 |
| --- | --- | --- | --- | --- |
| 速效救心丸答案引擎可见性实测与证据绑定内容包（含品牌 5 问与无品牌 5 问） | geo-content-pack | geo-content | delegated | 3 |

## 未决问题

- （advisory）deliverable_not_accepted：交付物「速效救心丸答案引擎可见性实测与证据绑定内容包（含品牌 5 问与无品牌 5 问）」当前状态是 delegated，尚未通过契约校验。（partial 交付下不阻断，将如实记录在交付摘要中。）
- （required）clinical_content_without_clinical_contract：/workspace/deliverables/geo-pack/geo-probe-log.jsonl 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/build_monitor.py 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/deliverables/geo-pack/citation-ledger.csv 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
- （required）clinical_content_without_clinical_contract：/workspace/deliverables/geo-pack/geo-content-pack.md 提到 速效救心丸，但它不在临床契约下。请把它作为临床类交付物提交，或移除临床内容。
