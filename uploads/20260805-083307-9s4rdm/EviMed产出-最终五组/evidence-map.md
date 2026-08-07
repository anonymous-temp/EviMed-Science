# 证据地图（evidence-map.md）

检索日期：2026-08-07。每个检索式、结果数、筛选决策记录于 `study-protocol.md` 的检索日志。

## 通道记录（channel record）

| 通道 | 工具 | 状态 |
|---|---|---|
| PubMed（题录+摘要） | `evimed_biomedical_source_search`(pubmed) / `evimed_literature_search` | ✅ 可用 |
| Europe PMC（含全文检索、MED 题录） | `evimed_biomedical_source_search`(europe-pmc) | ✅ 可用 |
| OpenAlex（引文图/主题规模） | `evimed_biomedical_source_search`(openalex) | ✅ 可用 |
| Crossref（新 DOI） | `evimed_biomedical_source_search`(crossref) | ✅ 可用 |
| 开放网络（360search/Baidu，中文偏斜） | `evimed_web_search` | ✅ 可用 |
| Semantic Scholar | `evimed_biomedical_source_search`(semantic-scholar) | ❌ HTTP 503（重试一次仍 503，记录为通道缺口，未改写为阴性证据） |
| 指南连接器 | `evimed_guideline_search` | ⚠️ 对"精神科 TDM 共识"检索仅返回不相关指南记录；中文共识改由开放网络发现、AGNP 经 OpenAlex 确认 |
| 文献计量 | `evimed_bibliometric_analysis` | ❌ HTTP 422（adapter 配置问题，记录为通道缺口） |
| 药物基因组学 | `evimed_biomedical_source_search`(clinpgx-pharmgkb) | ❌ HTTP 404（记录为通道缺口；改用 PubMed 检索 CPIC/PharmGKB 文献） |

## 逐行地图（来源领域列 = Field of origin，即该工作发表于/解决于哪个学科）

| Work | Identifier | URL | Channel | Axis | Field（来源领域） | Used for | Full text |
|---|---|---|---|---|---|---|---|
| Hiemke 2018, AGNP TDM 共识指南（Update 2017） | DOI 10.1055/s-0043-116492 | https://doi.org/10.1055/s-0043-116492 | openalex | guideline | 神经精神药理学 | G1/G6 参考范围基准（阿立哌唑 100–350、总 150–500） | no（非开放获取，经 OpenAlex 摘要核实） |
| 12 种抗精神病药血清浓度汇编（阿立哌唑 n=1610） | PMID 31025986 / DOI 10.1097/ftd.0000000000000585 | https://pubmed.ncbi.nlm.nih.gov/31025986/ | openalex | comparator | 精神科 TDM | G1/G6 C/D 群体百分位对照 | no |
| 抗精神病药常规实践 TDM 研究 | PMID 37315254 | https://pubmed.ncbi.nlm.nih.gov/37315254/ | pubmed | subject | 精神科 TDM | G6 出/在/超范围比例对照（48/30/22%） | no |
| TDM 作 CYP2D6 PM 表型诊断工具（MR 阈值） | PMID 33560096 | https://pubmed.ncbi.nlm.nih.gov/33560096/ | pubmed | method | 药物基因组学 | G2/G6 代谢比阈值法（阿立哌唑 log MR≥1.5） | no（403 非开放） |
| 年龄/性别对 6 药 C:D 影响（19,926 患者/74,194 样本） | PMID 39996570 | https://pubmed.ncbi.nlm.nih.gov/39996570/ | pubmed | comparator | 精神科 TDM（国家注册库） | G1/G6 大样本 C:D 注册对照（阿立哌唑年龄效应最小） | no |
| CYP 分型精神病学临床应用综述 | PMID 25200585 | https://pubmed.ncbi.nlm.nih.gov/25200585/ | pubmed | subject | 药物基因组学/精神科 | G2 背景（CYP2D6 PM→阿立哌唑减量 25%） | no |
| 奥氮平 TDM 中国患者（n=386） | PMID 36286707 | https://pubmed.ncbi.nlm.nih.gov/36286707/ | pubmed | subject | 精神科 TDM（中国） | G2/G6 合并用药-浓度方法先例、C/D 64 倍变异 | no |
| 氨磺必利 TDM 中国患者 | PMID 36863030 | https://pubmed.ncbi.nlm.nih.gov/36863030/ | pubmed | subject | 精神科 TDM（中国） | G2 协变量（年龄/性别/合并用药）方法先例 | no |
| 合并用药对阿立哌唑与脱氢阿立哌唑浓度的影响 | PMID 19142178 | https://pubmed.ncbi.nlm.nih.gov/19142178/ | pubmed | subject | 精神科 TDM | G2 最接近工作之一（DDI→C/D） | no |
| 阿立哌唑及其代谢物药动学变异 | PMID 17164689 | https://pubmed.ncbi.nlm.nih.gov/17164689/ | pubmed | subject | 精神科 TDM | G1/G2 变异背景 | no |
| SGA 联用对中国人阿立哌唑浓度影响 | PMID 33851072 | https://pubmed.ncbi.nlm.nih.gov/33851072/ | pubmed | subject | 精神科 TDM（中国） | G2 最接近工作之一（同族人群 DDI） | no |
| CYP2D6 基因型对利培酮/阿立哌唑暴露与疗效（回顾队列） | PMID 31000417 | https://pubmed.ncbi.nlm.nih.gov/31000417/ | pubmed | subject | 精神科 TDM 注册 | G1/G6 C/D 分层方法先例 | no |
| CYP2D6 基因型+合并用药代谢活性（n=82，表型转换） | PMID 26514968 | https://pubmed.ncbi.nlm.nih.gov/26514968/ | pubmed | method | 药物基因组学 | G2 表型代理+表型转换（phenoconversion）处理 | no |
| CYP2D6*10 对日本患者稳态浓度影响 | PMID 21157400 | https://pubmed.ncbi.nlm.nih.gov/21157400/ | pubmed | subject | 药物基因组学（东亚人群） | G2 东亚 CYP2D6*10 背景（本院人群适用性） | no |
| CYP2D6/3A5/ABCB1 对日本患者浓度影响 | PMID 24682161 | https://pubmed.ncbi.nlm.nih.gov/24682161/ | pubmed | subject | 药物基因组学 | G2 东亚基因背景 | no |
| 阿立哌唑/脱氢阿立哌唑群体药动学（NONMEM，n=80，141 稳态样本） | PMID 19032724 | https://pubmed.ncbi.nlm.nih.gov/19032724/ | pubmed | method | 群体药动学（精神科） | G1 模型结构先例；MR 0.20–0.34 表型基准 | no |
| GARMED 试验（血清浓度指导减药 RCT） | PMID 39324399 | https://pubmed.ncbi.nlm.nih.gov/39324399/ | pubmed | absence | 精神科临床试验 | G6 TDM 效用之争（RCT 证据存在性） | no |
| 次治疗浓度快速代谢→氯氮平序贯（真实世界） | PMID 38635089 | https://pubmed.ncbi.nlm.nih.gov/38635089/ | pubmed | subject | 精神科 TDM | G1 亚治疗浓度解释背景 | no |
| CYP2D6 表型对阿立哌唑水平与治疗持续（n=466，NNT=15） | PMID 40662264 | https://pubmed.ncbi.nlm.nih.gov/40662264/ | pubmed | subject | 药物基因组学+精神科 | G2/G6 表型-暴露-持续治疗三联证据；基因分型 NNT | no |
| CYP2D6/ABCB1 与阿立哌唑（抽动障碍儿童） | PMID 40598106 | https://pubmed.ncbi.nlm.nih.gov/40598106/ | pubmed | subject | 药物基因组学 | G2 MR 与基因型关联证据 | no |
| 儿童抽动障碍阿立哌唑 PPK（MR 区分 UM/IM，谷浓度切点 101.6） | PMID 36532742 | https://pubmed.ncbi.nlm.nih.gov/36532742/ | pubmed | method | 群体药动学 | G1/G2 MR 判型先例、谷浓度-疗效切点 | no |
| CYP2D6 表型 PBPK（PM 上限 10 mg/d） | PMID 34125422 | https://pubmed.ncbi.nlm.nih.gov/34125422/ | pubmed | method | 药物基因组学/建模 | G2 PM 剂量推论 | no |
| 日本健康人 CYP2D6 多态性（*10/*41，IM t½ 75.2h） | PMID 17965519 | https://pubmed.ncbi.nlm.nih.gov/17965519/ | pubmed | subject | 药物基因组学（东亚） | G2 东亚 PK 参数背景 | no |
| 白消安 TDM AUC 指导（儿科移植，11 例） | PMID 39625679 | https://pubmed.ncbi.nlm.nih.gov/39625679/ | pubmed | another-field | 移植/肿瘤学 | G3 浓度指导给药制度性先例（AUC 目标） | no |
| 他克莫司个体内变异+快速代谢者联合影响（n=1080，TWCV>30% 高变异） | PMID 36466843 | https://pubmed.ncbi.nlm.nih.gov/36466843/ | pubmed | another-field | 移植（肾移植） | G1 个体内变异（IPV）估计量直接借源（C/D 时间加权 CV） | no |
| 他克莫司 IPV 与 1 年结局（n=102，首月 C/D 的 CV 分层） | PMID 40913864 | https://pubmed.ncbi.nlm.nih.gov/40913864/ | pubmed | another-field | 移植 | G1 首月 C/D-CV 分层方法 | no |
| 5-FU PK 指导 vs BSA 剂量 Meta（OR 2.04） | PMID 26309030 | https://pubmed.ncbi.nlm.nih.gov/26309030/ | pubmed | another-field | 肿瘤学 | G3/G6 浓度指导获益的 Meta 证据（RCT 级） | no |
| 5-FU TDM：37% 低于、16% 高于目标窗 | PMID 30699067 | https://pubmed.ncbi.nlm.nih.gov/30699067/ | pubmed | another-field | 肿瘤学 | G6 跨域"多数患者不在目标窗"对照 | no |
| 5-FU TDM 前瞻多中心真实世界研究 | PMID 27256667 | https://pubmed.ncbi.nlm.nih.gov/27256667/ | pubmed | another-field | 肿瘤学 | G3 浓度指导流程落地先例 | no |
| 万古霉素中点浓度贝叶斯监测（80 儿童，226 样本） | PMID 40152654 | https://pubmed.ncbi.nlm.nih.gov/40152654/ | pubmed | another-field | 感染（儿科 MIPD） | G1 采血时刻未知的解法：区间中点采样即够（方法借源） | no |
| 儿科机会性采样 MIPD（23 例） | PMID 37436522 | https://pubmed.ncbi.nlm.nih.gov/37436522/ | pubmed | another-field | 感染（儿科 MIPD） | G1 机会性采样/非常规采血时刻先例 | no |
| 贝叶斯 MIPD 常规临床应用聚焦系统综述 | PMID 42194799 | https://pubmed.ncbi.nlm.nih.gov/42194799/ | pubmed | method | 药物计量学 | G1/G3 MIPD 落地证据综合 | no |
| 儿科抗生素 MIPD 叙述性综述 | PMID 33708753 | https://pubmed.ncbi.nlm.nih.gov/33708753/ | pubmed | method | 感染/药物计量学 | G1 模型-床旁整合背景 | no |
| 利奈唑胺 TDM 剂量优化综述 | PMID 31652190 | https://pubmed.ncbi.nlm.nih.gov/31652190/ | pubmed | method | 感染 | G1 稀疏数据 TDM 阈值方法 | no |
| 万古霉素 popPK 模型外部评价（23 模型，169 例，923 样本） | PMID 35341931 | https://pubmed.ncbi.nlm.nih.gov/35341931/ | pubmed | method | 药物计量学 | G1 模型选择/平均法（MAA/MSA）借源 | no |
| GRU-D：含缺失多变量时间序列循环网络 | PMC5904216 / DOI 10.1038/s41598-018-24271-9 | https://europepmc.org/articles/PMC5904216 | europe-pmc | another-field | 重症信息学（MIMIC-III） | G4 不规则纵向+信息性缺失的估计器借源（masking+时间间隔衰减） | **yes** |
| 肝炎处方关联规则挖掘（33,900 患者） | PMID 41092780 | https://pubmed.ncbi.nlm.nih.gov/41092780/ | pubmed | another-field | 卫生信息学 | G2 共处方关联挖掘（Apriori）方法借源 | no |
| 阿立哌唑 popPK-DDI（氟西汀 CL 0.714，n=119 中国） | PMC11217561 / DOI 10.3389/fpsyt.2024.1377268 | https://europepmc.org/articles/PMC11217561 | europe-pmc | subject+method | 精神科 TDM/群体药动学（中国） | G1/G2 直接模型先例；治疗窗 120–270 vs AGNP 100–350 之争（G6）；稀疏谷浓度局限声明（G1） | **yes** |
| 氯氮平 DDI-MIPD（双相，n=51；佐匹克隆 −44.9% CL） | PMC12626042 / DOI 10.2147/dddt.s557624 | https://europepmc.org/articles/PMC12626042 | europe-pmc | method | 精神科 MIPD | G2 小样本（n=51）PPK-DDI 充分性论证的直接先例；350–800/1000 窗（G5/G6） | **yes** |
| 奥氮平 MIPD 双相（n=39 真实世界） | PMC11371603 / DOI 10.3389/fphar.2024.1444169 | https://europepmc.org/articles/PMC11371603 | europe-pmc | method | 精神科 MIPD | G2 协变量筛选流程（OFV 逐步法） | **yes** |
| 喹硫平 popPK-DDI（氟伏沙明/度洛西汀，n=96） | PMC11614649 / DOI 10.3389/fphar.2024.1496043 | https://europepmc.org/articles/PMC11614649 | europe-pmc | method | 精神科 MIPD | G2 合并用药 CL 比（0.464/0.463/0.215）方法对照 | **yes** |
| 阿立哌唑一月一次 popPK+暴露-反应（Cmin≥95 → 复发 HR 4.41） | PMC10026531 / DOI 10.1002/cpdd.1022 | https://europepmc.org/articles/PMC10026531 | europe-pmc | comparator | 精神科药动学 | G6 暴露-反应锚点（谷浓度阈值-复发） | **yes** |
| 硫必利血浆-唾液联合 popPK-MIPD（38 儿童） | PMID 42052103 | https://europepmc.org/article/MED/42052103 | europe-pmc | method | 儿科神经精神药动学 | G1 非侵入基质/稀疏采样联合模型先例 | no |
| SGA 经 TDM 评估 DDI 综述 | DOI 10.1517/17425255.2016.1154043 | https://doi.org/10.1517/17425255.2016.1154043 | openalex | method | 精神科临床药理学 | G2 用 TDM 数据库做 DDI 的总体框架 | no |
| 第 1 周母药+代谢物浓度预测阿立哌唑最优剂量 | DOI 10.1097/ftd.0000000000000358 | https://doi.org/10.1097/ftd.0000000000000358 | crossref | subject | 精神科 TDM | G1 最接近工作：早浓度→稳态剂量预测 | no |
| 住院精神科医院抗精神病药 TDM 实践 | DOI 10.1097/ftd.0000000000001156 | https://doi.org/10.1097/ftd.0000000000001156 | crossref | subject | 精神科 TDM（住院） | G3/G6 最接近工作（住院 TDM 实践审计） | no |
| 常规住院抗抑郁药 TDM 适宜性 | DOI 10.1097/01.ftd.0000189897.16307.65 | https://doi.org/10.1097/01.ftd.0000189897.16307.65 | crossref | subject | 精神科 TDM | G6 采样适宜性评估框架借源 | no |
| 催乳素与阿立哌唑稳态浓度关系 | DOI 10.1097/ftd.0000000000000843 | https://doi.org/10.1097/ftd.0000000000000843 | crossref | subject | 精神科 TDM | G5 最接近工作（暴露-催乳素） | no |
| 青少年精神分裂症阿立哌唑大变异 | DOI 10.1097/ftd.0b013e318178e18d | https://doi.org/10.1097/ftd.0b013e318178e18d | crossref | subject | 精神科 TDM | G1 变异跨人群对照 | no |
| 个体化药物基因组学综述（CPIC/DPWG 基因型-剂量建议现状） | PMID 42442668 | https://pubmed.ncbi.nlm.nih.gov/42442668/ | pubmed | guideline | 药物基因组学 | G2 背景（CYP2D6/2C19 可操作性、CYP3A4 局限） | no |
| 卡马西平-阿立哌唑药动学相互作用 | DOI 10.1097/ftd.0b013e3181b6326a | https://doi.org/10.1097/ftd.0b013e3181b6326a | crossref | subject | 精神科 TDM | G2 诱导剂 DDI 对照 | no |
| 依贝沙坦 FAERS/JADER 信号（ROR/PRR/BCPNN/EBGM+Weibull TTO） | PMID 39635439 | https://pubmed.ncbi.nlm.nih.gov/39635439/ | pubmed | method | 药物警戒 | G5 信号方法全套+敏感性（剔合并用药）模板 | no |
| 阿奇霉素年龄分层 FAERS 信号 | PMID 40636562 | https://pubmed.ncbi.nlm.nih.gov/40636562/ | pubmed | method | 药物警戒 | G5 分层信号方法 | no |
| 羧基麦芽糖铁 FAERS/VigiBase（ROR/PRR/IC，剔合并用药精修） | PMID 40402208 | https://pubmed.ncbi.nlm.nih.gov/40402208/ | pubmed | method | 药物警戒 | G5 并发用药校正方法 | no |
| 贝特类 JADER/FAERS（含 RADAR 报告规范） | PMID 41368577 | https://pubmed.ncbi.nlm.nih.gov/41368577/ | pubmed | method | 药物警戒 | G5 报告规范（不均衡分析指南） | no |
| 仑卡奈单抗 FAERS 时间模式 | PMID 40242445 | https://pubmed.ncbi.nlm.nih.gov/40242445/ | pubmed | method | 药物警戒 | G5 时间-事件模式方法 | no |
| 11 种抗精神病药体重剂量-反应 Meta（52 RCT，22,588 例） | PMID 36752753 | https://pubmed.ncbi.nlm.nih.gov/36752753/ | pubmed | comparator | 精神神经内分泌学 | G4 体重-剂量对照（阿立哌唑例外无剂量反应） | no |
| 换药减重 Meta（阿立哌唑 −5.52 kg） | PMID 33547471 | https://pubmed.ncbi.nlm.nih.gov/33547471/ | pubmed | comparator | 精神科 | G4 7% 体重阈值/换药对照 | no |
| 抗精神病药多药联用 Meta（517 研究，445 万人；住院 31.4%） | PMID 39547246 | https://pubmed.ncbi.nlm.nih.gov/39547246/ | pubmed | comparator | 精神科流行病学 | G2/G3 多药联用基线（EPS RR 1.63、肌张力障碍 5.91） | no |
| 抗抑郁/抗精神病副作用数据库与 TOPSIS 工具 | PMID 37774723 | https://pubmed.ncbi.nlm.nih.gov/37774723/ | pubmed | subject | 精神科 | G5 副作用维度库 | no |
| 中国精神科 TDM 临床应用专家共识（2022 年版） | 中文期刊（中华精神科杂志 2022;55(4)） | https://max.book118.com/html/2022/1020/8002065073005004.shtm | open-web | guideline | 精神科 TDM（中国） | G6 中国共识基准（存在性与参考范围来源） | no（开放网络未审页，仅作存在性；正文引用以期刊原文为准） |
| 精神科药物血药浓度监测专家共识（2025 版） | 中华医学会精神医学分会等 | https://word.baidu.com/spider/doc/view?doc_id=15e5453f6fd97f192279168884868762cbaebb40&is_external=1 | open-web | guideline | 精神科 TDM（中国） | G6 中国共识更新（2025 版存在性） | no（同上） |

## 领域分布小结（回答"是否每行都是精神科"）

- 精神科/精神科 TDM：约 30 行（subject/comparator/guideline 轴为主）
- **非临床交集的借域行**：移植（3 行：白消安、他克莫司×2）、肿瘤（3 行：5-FU×3）、感染/儿科 MIPD（4 行：万古霉素中点、机会采样、综述、利奈唑胺）、药物计量学（3 行：模型评价、MIPD 综述、PBPK）、重症信息学（1 行：GRU-D）、卫生信息学（1 行：关联规则）、药物基因组学（6 行：MR 阈值、表型转换、CYP2D6 东亚、PBPK、CPIC）、药物警戒（5 行：FAERS/JADER 方法）
- 每道存活性问题均有 ≥2 条方法学引用（见 research-portfolio.md 与 study-protocol.md）。

## 检索日志（摘要）

| # | 查询（通道） | 结果 | 保留 |
|---|---|---|---|
| S1 | aripiprazole TDM concentration dose ratio（pubmed） | 19 | 12 |
| S2 | antipsychotic TDM consensus guideline（pubmed） | 0（换用 openalex 指南确认） | 0 |
| S3 | aripiprazole popPK sparse sampling（europe-pmc） | 15 | 8 |
| S4 | busulfan TDM AUC transplant（pubmed） | 1 | 1 |
| S5 | popPK unknown sampling time（europe-pmc） | 15（噪声，会议摘要） | 0（改借万古霉素中点/机会采样） |
| S6 | vancomycin Bayesian MIPD（pubmed） | 12 | 5 |
| S7 | GRU-D irregular longitudinal（pubmed） | 0 →（europe-pmc DOI 直取全文） | 1（全文） |
| S8 | tacrolimus IPV C/D（pubmed） | 2 | 2 |
| S9 | 5-FU TDM（pubmed） | 12 | 4 |
| S10 | FAERS disproportionality（pubmed） | 12 | 5 |
| S11 | antipsychotic weight gain trajectory（pubmed，首次 502 重试后） | 12 | 4 |
| S12 | association rule mining prescriptions（pubmed） | 1 | 1 |
| S13 | antipsychotic TDM（openalex） | 10 | 5 |
| S14 | aripiprazole TDM inpatient（crossref） | 10 | 5 |
| S15 | clozapine concentration threshold（pubmed ×2 式） | 0（改由 OpenAlex 综述与氯氮平 MIPD 全文覆盖） | 0 |
| S16 | TDM utility RCT（pubmed） | 0（GARMED 已于 S1 捕获） | 0 |
| S17 | CPIC/PharmGKB antipsychotic（pubmed） | 2 | 2 |
| S18 | aripiprazole steady state MR CYP2D6（evimed_literature_search） | 10/34 | 6 |
| S19 | herb-drug interaction（pubmed） | 0（中药方向删除理由由数据与用户决策支撑） | 0 |
| S20 | 精神科 TDM 共识（open-web 中文） | 10 | 2 |
| S21 | 精神科 TDM 共识（guideline connector） | 20 条均不相关 | 0 |

## 不可用通道的诚实记录
- semantic-scholar（503 两次）、clinpgx-pharmgkb（404）、evimed_bibliometric_analysis（422）：均已尝试并记录，未以"无文献"改写；相关主题由其他通道覆盖（GRU-D 经 europe-pmc；CPIC 经 pubmed；趋势轴未覆盖，在不确定项中说明）。
