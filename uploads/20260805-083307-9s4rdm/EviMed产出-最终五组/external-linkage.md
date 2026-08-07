# 外部链接图（external-linkage.md）

原则：每个外部资源说明——用什么字段连接、什么粒度、解决了本院数据单独回答不了的问题；标准词表是基础设施：ATC/RxNorm 管药、ICD-10/SNOMED 管诊断、LOINC 管检验（**LOINC 不带单位，必须配 UCUM**，同一 LOINC 码可能同时收 mg/dL 与 mmol/L）。

| 资源 | 连接键（join key） | 粒度 | 它补充了什么（本院数据单独答不了的） |
|---|---|---|---|
| LOINC（loinc.org） | `检验.PROJECT_NAME`（阿立哌唑/脱氢阿立哌唑/总阿立哌唑/奥氮平/氯氮平/帕利哌酮/氯硝西泮）→ LOINC 术语 | 检验项目 | 把本院项目名映射为标准术语，跨院可比；**必须与 UCUM 单位绑定**（本院浓度单位 ng/mL，需显式记录，防 LOINC 同码异单位陷阱）。成本：项目名-代码映射表需人工核对 1 次（7 个项目，低）。 |
| UCUM（ucum.org） | LOINC 码 + `REFFR_SCOPE` 单位 | 检验值单位 | 防"同码不同单位"；G1/G6 跨机构比较的基础 |
| RxNorm / ATC（rxnorm.nlm.nih.gov / whocc.no） | `医嘱记录.DRUG_NAME`+`DRUG_CODE`（品牌别名归一后） | 药品分子/ATC 类 | 把 博思清/安律凡/口崩片 归一到 RxCUI（阿立哌唑）；ATC 类（N05A 抗精神病药、N06AB SSRI）支撑 G2 的"酶抑制/诱导剂类"协变量构造。成本：120 个有值药品名归一，中。 |
| ICD-10（WHO 版/国家版） | `病案首页.MAIN_DIAGNOSIS_CODE`、`诊断记录.DIAGNOSIS_CODE` | 诊断 | 诊断已含 F20/F31/Z03 码；`OTHER_DIAGNOSIS_CODE` 竖线分隔需拆分。成本：拆分+映射，低。 |
| AGNP 参考范围（Hiemke 2018，经 DOI 10.1055/s-0043-116492 ） | `检验.PROJECT_NAME` | 药品-浓度窗 | G6 判定"样本在/下/超范围"的行业基准；本院 `REFFR_SCOPE` 与 AGNP 一致（validation 已确认） |
| 中国精神科 TDM 专家共识（2022/2025 版） | `检验.PROJECT_NAME`+诊断 | 药品-浓度窗（中国人群） | G6 用中国基准复核 AGNP 范围对本院人群的适用性 |
| 群体 C/D 注册库百分位（PMID 39996570：19,926 例；PMID 31025986：12 药汇编） | `检验`×`医嘱` 重建的 C/D | 药品-C/D 百分位 | 回答"本院的 C/D 分布落在注册库的哪个百分位"——不用把文献均值当金标准；G1/G6 的对照 |
| PharmGKB / CPIC（pharmgkb.org） | 分子（阿立哌唑）+ CYP2D6 表型（由 DHA/ARI 代谢比代理） | 基因-药对 | 把"代谢比代理表型"对照到 CPIC/DPWG 的基因型-剂量建议（PM 减量 25%、上限 10 mg/d）；本院无基因型字段，代谢比是表型代理（G2） |
| FAERS / openFDA（open.fda.gov） | `DRUG_NAME`（归一分子）+ ADR 概念（高泌乳素血症/肌张力障碍等 MedDRA PT） | 药-事件 | G5 用不均衡分析（ROR/PRR/IC）做外部信号，与本院的暴露-诊断关联互相印证（三角互证）；成本：openFDA API 开放、需按季度重建去重 |
| OMOP CDM / Athena（athena.ohdsi.org） | 全表概念映射 | 全库 | 若未来要跨院合并或参与 OHDSI 网络研究；**映射有语义损失成本**：OMOP 官方文档自己的例子是 ICD-9"被鹅咬"映射成 SNOMED"被鸟啄"——本院的中医证型（心脾两虚证等）与中医诊断（癫病/郁病）在 OMOP 概念集中覆盖差，属"上坡映射"，建议中医字段保留原文不映射 |

**链接成本与风险**：除 openFDA 外均为公开开放资源；主要成本在药品名归一（约 120 个去重后分子）与 LOINC 映射（7 项）；风险最高的是 LOINC 单位歧义（必须带 UCUM）与中医诊断的 OMOP 映射失真（保留原文）。
