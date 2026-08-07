# 证据地图（evidence-map.md）

> 检索日期：2026-08-07。本表记录每篇工作的标识符、URL、通道、覆盖轴、用途与全文读取状态。
> 通道缩写：pubmed=europe-pmc/PubMed 连接器；epmc=europe-pmc（含全文检索与预印本）；openalex；crossref（含 ISRCTN 注册试验）；guideline=evimed_guideline_search；web-sci=evimed_web_search(categories=science)；web-gen=evimed_web_search(categories=general, zh)；ft=evimed_open_access_full_text；biblio=evimed_bibliometric_analysis；lit=evimed_literature_search（内部索引）。
> 轴：subject（主题）/method（方法）/comparator（比较器）/absence（空白）/guideline（标准）。

## 1. 证据表（按用途分组）

### 1.1 标准与共识（guideline / comparator 轴）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| Hiemke 2018, AGNP TDM 共识 Update 2017（Pharmacopsychiatry） | PMID 28910830 | https://pubmed.ncbi.nlm.nih.gov/28910830/ | pubmed | guideline | 阿立哌唑参考范围 100–350/150–500 的来源；TDM 适应证（依从性、疗效、不良反应、DDI） | no |
| Hiemke 2018, TDM in psychiatry and neurology: summary of AGNP 2017（World J Biol Psychiatry） | EVIMED-GUIDE:10 | https://www.tandfonline.com/doi/full/10.1080/15622975.2018.1460374 | guideline | guideline | AGNP 2017 临床工具版；Q1/Q2 的判定标准文本（对应原版 PMID 28910830） | no |
| AGNP TDM 共识 Update 2026（50 专家、160 药、参考范围方法学修订） | PMID 42392224 | https://pubmed.ncbi.nlm.nih.gov/42392224/ | pubmed | guideline/absence | 2026 年标准动态：本实验室沿用 2017 范围 vs 2026 修订；Q1 的时效性论证 | no |
| 中国精神科治疗药物监测临床应用专家共识（2022 年版），神经疾病与精神卫生 2022;22(8) | Sinomed 2022423503 | https://www.sinomed.ac.cn/article.do?ui=2022423503 | web-gen | guideline | **中文金标准**：5–7 个半衰期后采血、谷浓度、报告解读要求；Q1 审计判据；本数据（2020–2021）为其发布前基线 | no |
| 《中国精神科治疗药物监测临床应用专家共识(2022年版)》解读与展望 | MedSci 解读 | https://www.medsci.cn/guideline/show_article.do?id=dd8451c00a159264 | web-gen | guideline | 共识实施要点与展望（2024-11 解读） | no |
| 北京安定医院新闻：共识发表（王刚通讯） | 医院页面 | https://www.bjad.com.cn/Html/News/Articles/1858.html | web-gen | guideline | 共识组织/作者信息一手来源 | no |
| 《治疗药物监测(TDM)结果解读专家共识》（中国药理学会 TDM 分会等，中国医院药学杂志） | PMC10013164 ref 25 | https://europepmc.org/articles/PMC10013164 | web-gen/epmc | guideline | 结果解读主体与流程要求；Q1 判据（本机构 6 次采样 0 次有解读记录） | via survey |
| 《精神科药物基因组学检测专家共识(2025)》 | 百度文库页 | https://wenku.baidu.com/view/e52a76619f6648d7c1c708a1284ac850ad0204ae.html | web-gen | absence | CYP2D6 检测的国内共识动态；Q2 未来扩展轴（本数据无基因型） | no |
| APA Schizophrenia Practice Guideline 2021 | EVIMED-GUIDE:4 | https://psychiatryonline.org/guidelines | guideline | guideline | 精神分裂症治疗监测总体框架 | no |
| INTEGRATE 国际精神分裂症算法指南 2025 | PMID 40179920 | https://pubmed.ncbi.nlm.nih.gov/40179920/ | pubmed | guideline | 氯氮平早期使用建议；治疗抵抗路径 | no |
| de Leon 2021, 氯氮平滴定安全国际指南（六大种族分层剂量） | PMID 34911124 | https://pubmed.ncbi.nlm.nih.gov/34911124/ | pubmed | guideline/comparator | 氯氮平 350–600 参考范围、亚洲低 CYP1A2 剂量证据；P2 氯氮平 721 的判定依据 | no |

### 1.2 人群分布与 C/D 比较器（comparator 轴）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| 12 种抗精神病药 TDM 血清浓度汇编（奥斯陆 TDM 库，阿立哌唑 n=1610、奥氮平 n=10268、氯氮平 n=1189，1999–2015） | PMID 31025986 | https://pubmed.ncbi.nlm.nih.gov/31025986/ | pubmed+ft | comparator | 各药 C/D 中位数/10th/90th 百分位、性别/年龄/剂量亚组、个体间 CV——**本数据集 C/D 的直接人群比较器** | yes |
| Schoretsanitis/Hart 2022, 阿立哌唑参考范围修订系统综述与荟萃（N=3373，53 队列） | PMID 36195732 | https://pubmed.ncbi.nlm.nih.gov/36195732/ | pubmed+ft | comparator/method | 建议治疗范围 120–270/180–380（低于 AGNP 2017 的 100–350/150–500）；平均 C/D 13.8（母药）/18.2（活性部分）；剂量相关范围 11.7/16.5；DHC/ARI≈0.40；Korell 2018 采样时刻影响小的证据 | yes |
| Molden 2006, 阿立哌唑+脱氢代谢物 PK 变异（155 样本） | PMID 17164689 | https://pubmed.ncbi.nlm.nih.gov/17164689/ | pubmed | comparator | C/D 个体间 27 倍（活性总和）变异；CYP2D6/3A4 抑制的少见性；变异来源分解 | no |
| Suzuki 2011, CYP2D6*10 对阿立哌唑稳态浓度影响（日本 63 例） | PMID 21157400 | https://pubmed.ncbi.nlm.nih.gov/21157400/ | pubmed | comparator | 按 *10 等位基因分层的 C/D：母药 9.0/12.7/19.0，总和 13.9/18.6/24.6 ng/mL·mg⁻¹·d——**本数据 C/D（10.7–28.9）的对位参考** | no |
| Suzuki 2014, CYP2D6/3A5/ABCB1 多态（日本 89 例） | PMID 24682161 | https://pubmed.ncbi.nlm.nih.gov/24682161/ | pubmed | comparator/method | 东亚人群基因型-浓度关系；仅 CYP2D6 显著 | no |
| Jukić 2019, CYP2D6 基因型对利培酮/阿立哌唑暴露与疗效（回顾队列） | PMID 31000417 | https://pubmed.ncbi.nlm.nih.gov/31000417/ | pubmed | comparator | CYP2D6 PM 剂量校正浓度升高；药代遗传学证据 | no |
| Jukić 2025, CYP2D6 表型对阿立哌唑浓度与停药（466 例稳态样本） | PMID 40662264 | https://pubmed.ncbi.nlm.nih.gov/40662264/ | pubmed+ft | comparator/method | IM vs NM：浓度 +56%、C/D +27%；DHC/ARI 在 PM 中 −47%；表型转换（氟西汀/帕罗西汀）——**DHC/ARI 0.17–0.49 的解读框架** | yes |
| van den Berg 2023/2024?, 儿科/ASD 阿立哌唑精准剂量（血药-体重关联） | DOI 10.1111/bcp.15800 | https://doi.org/10.1111/bcp.15800 | ft | comparator/method | 血药浓度与体重增加/疗效关联的 popPK 框架（提交版全文已读） | yes |
| Korell 2018, 口服阿立哌唑/奥氮平/喹硫平浓度参考范围（popPK 模拟，含采样时间） | PMID 29392351 | https://pubmed.ncbi.nlm.nih.gov/29392351/ | pubmed | method | 80% 参考范围随剂量与**采样时间窗**变化：如阿立哌唑 30mg 0–4h 221–624 vs 20–24h 159–557——**"缺失采样时刻"缺口的量化工具** | no |
| 2013 中国精神科药物 TDM 全国调查（47 家机构/26 省） | PMID 24263641 | https://pubmed.ncbi.nlm.nih.gov/24263641/ | pubmed | comparator/absence | 锂盐最常见(68.1%)、氯氮平 44.7%；**仅 10.2% 实验室提供剂量调整建议**；呼吁中文共识（2022 共识回应之）——中国精神科 TDM 实践的时间基线 | no |
| 2023 中国 TDM 现状调查（475 问卷，Ther Drug Monit） | PMID 36920501 | https://pubmed.ncbi.nlm.nih.gov/36920501/ | pubmed+ft | comparator/absence | 报告解读率低；"护士采样时间不准(58.9%)、用药时间不准(57.9%)"为全国公认的 TDM 结果不一致主因；监测范围不统一；≤¥200——**Q1/Q2 的问题背景一手证据** | yes |
| 2025 中国抗精神病药 TDM 标准化调查（>100 实验室，6 药） | PMID 40304505 | https://pubmed.ncbi.nlm.nih.gov/40304505/ | pubmed | comparator/absence | 实验室间 CV 高（奥氮平 43–45%）；EQA 不达标——**最接近的"中国抗精神病药 TDM 现状"竞争性工作（但层面=实验室分析，非临床流程）** | no |
| 西安精神卫生中心氯氮平/去甲氯氮平 TDM 回顾 2019–2022 | PMID 38113699 | https://pubmed.ncbi.nlm.nih.gov/38113699/ | pubmed | comparator/absence | 氯氮平 IQR 129.83–397.53 ng/mL；68.63% 低于治疗范围；多为单次监测——**中国机构级 TDM 服务审计的最接近已发表工作（氯氮平、浓度分布层面）** | no |
| 中国精神分裂症奥氮平 TDM（386 例稳态） | PMID 36286707 | https://pubmed.ncbi.nlm.nih.gov/36286707/ | pubmed | comparator | 奥氮平浓度 53.6 倍、C/D 64.1 倍变异；C/D 中位 2.73；性别/合用丙戊酸/锂的影响——P4 奥氮平 54.2 ng/mL 的对照 | no |
| 中国精神分裂症氨磺必利 TDM（173 例） | PMID 36863030 | https://pubmed.ncbi.nlm.nih.gov/36863030/ | pubmed | comparator | 中国人群氨磺必利 C/D 1.04；合用阿立哌唑影响 C/D——同类中国 TDM 服务数据库范式 | no |
| 儿科阿立哌唑 TDM 实践观察（130 例 7–19 岁） | PMID 32997183 | https://pubmed.ncbi.nlm.nih.gov/32997183/ | pubmed | comparator/method | 体重校正剂量解释 35% 浓度变异；~70% 在成人范围内——**"TDM 服务实践描述"模板（儿科/欧洲）** | no |
| 万古霉素 AUC-TDM 中国横断面调查 | PMID 39070794 | https://pubmed.ncbi.nlm.nih.gov/39070794/ | pubmed+ft | method | 中国 TDM 实施现状调查的方法学模板（问卷+实施率） | yes |
| Sparshatt 2010, 阿立哌唑剂量-浓度-占位-反应系统综述 | PMID 20584524 | https://pubmed.ncbi.nlm.nih.gov/20584524/ | pubmed | comparator | 目标范围 150–210 ng/mL 的怀疑派立场；"TDM 价值有限但可用于依从性"——TDM 价值争论的引用 | no |

### 1.3 正在进行的工作与空白（absence 轴）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| OptIMA 2 试验注册（英国，抗精神病药 TDM 个体化处方临床试点） | ISRCTN71305621 | https://doi.org/10.1186/isrctn71305621 | crossref | absence | **正在进行的抗精神病药 TDM 干预试验**——证明该方向活跃、竞争强 | no |
| OptIMA 3 试验注册（剂量复核用 TDM） | ISRCTN76638113 | https://doi.org/10.1186/isrctn76638113 | crossref | absence | 同上 | no |
| 精神科医生对抗精神病药剂量与 TDM 血浆浓度作用的观点（Ther Drug Monit） | DOI 10.1097/ftd.0000000000000041 | https://doi.org/10.1097/ftd.0000000000000041 | crossref | absence | 实践者态度维度 | no |
| 基于末次服药时间的神经精神类药物随机浓度换算稳态谷浓度方法研究（2026 登记） | 摩熵医药登记页 | https://www.pharnexcloud.com/data/lcsy_54ad497e005f1bb617c96bb01384acff.html | web-gen | absence | **中国正在进行的"随机浓度→谷浓度换算"研究**——与 Q2 的"采样时间缺失"问题正面相邻；Q2 必须与之划界（换算 vs 界限估计） | no |
| 第十五届治疗药物监测学术年会（2025-09 长沙，"新理念新技术新方法"） | 北京市卫健委新闻 | https://wjw.beijing.gov.cn/xwzx_20031/jcdt/202509/t20250926_4210961.html | web-gen | absence | 学会动态：中国药理学会 TDM 专委会年会持续举办 | no |
| 中国药理学会 TDM 专委会"神经精神学组"筹备（北京安定医院李文标牵头） | 搜狐新闻 | https://www.sohu.com/a/232481605_107881 | web-gen | absence | 精神科 TDM 学组建制动态 | no |
| 国际氯氮平耐药精神分裂症研究议程 | PMID 37329895 | https://pubmed.ncbi.nlm.nih.gov/37329895/ | pubmed | absence | 氯氮平领域未解决问题清单 | no |
| 抗精神病药管理计划（APSP）框架 | PMID 36405504 | https://pubmed.ncbi.nlm.nih.gov/36405504/ | pubmed | method/absence | 住院抗精神病药监测管理的制度化框架——Q1 审计指标的归属框架 | no |

### 1.4 方法学与报告规范（method 轴）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| Hernán & Robins 2016, target trial 框架 | PMID 26772609 | https://pubmed.ncbi.nlm.nih.gov/26772609/ | pubmed | method | feasibility-matrix 的七要素框架 | no |
| Cashin 2025, TARGET 报告规范 | DOI 10.1136/bmj-2024-080095 | https://doi.org/10.1136/bmj-2024-080095 | crossref | method | 目标试验模拟报告规范（matrix 对齐 TARGET 6/7） | no |
| Benchimol 2015, RECORD 声明 | PMID 26460043 | https://pubmed.ncbi.nlm.nih.gov/26460043/ | pubmed | method | EHR 观察研究报告规范（6.2/7.1/12.3 可报告性检查） | no |
| Langan 2018, RECORD-PE | PMID 30361372 | https://pubmed.ncbi.nlm.nih.gov/30361372/ | pubmed | method | 药物流行病学暴露时间窗/左截断/暴露捕获完整性（RECORD-PE 7.1.c/19.1.a） | no |
| Hoenig & Heisey 2001, 对固定样本事后检验的批评 | PMID 11466048 | https://pubmed.ncbi.nlm.nih.gov/11466048/ | pubmed | method | 固定数据集不报告事后检验；按精度计划（Bland 2009）报告最小可检测效应与预期区间宽度 | no |
| Bland 2009, 用置信区间宽度计划样本量 | PMID 19858502 | https://pubmed.ncbi.nlm.nih.gov/19858502/ | pubmed | method | 固定数据集的 MDE 报告方式 | no |
| Weiskopf 2013, EHR 数据完整性四定义 | PMID 23449855 | https://pubmed.ncbi.nlm.nih.gov/23449855/ | pubmed | method | 填充率口径声明（density completeness） | no |
| Kahn 2016, EHR 数据质量术语 | PMID 27418641 | https://pubmed.ncbi.nlm.nih.gov/27418641/ | pubmed | method | data-quality.md 的 Kahn 分类 | no |
| Abedjan 2015, 数据画像 | DOI 10.14778/2824032.2824106 | https://dl.acm.org/doi/10.14778/2824032.2824106 | crossref | method | 机械画像方法（单列画像/包含依赖/唯一组合） | no |
| Weston 2019, 二手数据预注册 | PMID 31039398 | https://pubmed.ncbi.nlm.nih.gov/31039398/ | pubmed | method | Phase 0 先验接触声明 | no |
| Van den Akker 2021, 预注册实践 | PMID 33870513 | https://pubmed.ncbi.nlm.nih.gov/33870513/ | pubmed | method | 预注册模板 | no |
| Hart 2021, 精神药物参考范围系统综述协议（Front Psychiatry） | PMID 34899439 | https://pubmed.ncbi.nlm.nih.gov/34899439/ | pubmed | method | 参考范围构建方法学协议（2022 荟萃的方法基础） | no |
| 躯体监测指令适用性（SIM 评分）研究 | EVIMED-GUIDE:19 | https://bmcpsychiatry.biomedcentral.com/articles/10.1186/s12888-021-03199-9 | guideline | method | 监测指令可适用性评估方法——Q1 指标设计参考 | no |
| 抗精神病药管理计划 APSP | PMID 36405504（https://pubmed.ncbi.nlm.nih.gov/36405504/） | https://pubmed.ncbi.nlm.nih.gov/36405504/ | pubmed | method | 监测-干预-结局闭环框架 | no |

### 1.5 中文实践现状与已占用方向（web-gen，临床实践轴）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| 精神分裂症患者阿立哌唑血药浓度和临床相关性研究（临床合理用药 2025;18(21)） | 期刊页（360文库镜像） | https://wenku.so.com/d/1583e9f541dd8eaa595b8b7b1c89a6d6 | web-gen | subject | **浓度-疗效相关性方向已被中文文献反复覆盖**（2025 例证之一）——作为"删除该方向"的证据 | no |
| 天津塘沽安定医院 42 例阿立哌唑血药浓度相关性（2022，医学信息） | 万方 | https://med.wanfangdata.com.cn/Paper/Detail/PeriodicalPaper_yxxxzz2022z2006 | web-gen | subject | 同上（n=42） | no |
| 江西宜春 60 例 AD 伴精神障碍阿立哌唑 TDM 分析（2026，中华医学会系列） | 医教在线 | https://rs.yiigle.com/cmaid/1530994 | web-gen | subject | 同上（n=60，AD 人群） | no |
| 阿立哌唑血药浓度与疗效相关性（2006，中国新药与临床杂志，n=30） | 万方 | https://med.wanfangdata.com.cn/Paper/Detail/PeriodicalPaper_zgxyylczz200608011 | web-gen | subject | 最早的中文例证之一 | no |
| 阿立哌唑治疗抗精神病药致高泌乳素血症最佳浓度（河北医科大学 2016 硕士论文，40.93±7.01 ng/mL） | CNKI | https://cdmd.cnki.com.cn/Article/CDMD-10089-1016146764.htm | web-gen | subject | 浓度-不良反应方向亦被覆盖 | no |
| 云南省精神病医院 TDM 科普（5–7 个半衰期达稳、谷浓度采样） | 医院官网 | https://www.ynjs.com.cn/mobile/kepuwenzhang/detail/3425.html | web-gen | guideline | 中文临床实践对采样时机的常规理解 | no |
| 浙江省精神卫生专科（闲林院区）背景：医学观察病房/精一/精四科 | 病案首页科室名 | —（数据内部） | — | — | 数据来源单位特征（浙江精神专科医院，中西医结合病房） | — |

### 1.6 文献计量（biblio 轴，受管任务输出）

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| 抗精神病药 TDM 文献计量（2009–2026，38 篇，峰值 2025=5 篇；国家：美 10/中 7/英 6；前沿词：atypical antipsychotics、standardization） | run bibliometric-20260807040419-5c29f6acdd06 | file:///workspace/bibliometric-analysis-runs/bibliometric-20260807040419-5c29f6acdd06/output/report.md | biblio | absence | 领域规模小、2025 年升温、"标准化"为突现词；中国发文第二 | — |

## 2. 开放网络通道应答记录（用户指定必须如实记录）

### 2.1 `evimed_web_search` categories=["science"]
| 检索式 | 应答引擎 | 未应答引擎 | 返回内容性质 | 采用情况 |
|---|---|---|---|---|
| aripiprazole therapeutic drug monitoring antipsychotic precision dosing | **arxiv、pubmed** | semantic scholar | arxiv 6 条（脑网络/传感器/分数阶药动学等，与本课题无关）；pubmed 9 条（含 PMID 40304505（https://pubmed.ncbi.nlm.nih.gov/40304505/） 标准化调查、PMID 37222228（https://pubmed.ncbi.nlm.nih.gov/37222228/） 儿科精准剂量、PMID 34125422（https://pubmed.ncbi.nlm.nih.gov/34125422/） PBPK） | 40304505、37222228 转 pubmed 连接器回查并纳入；arxiv 无相关 |
| therapeutic drug monitoring psychiatry EU project H2020 precision dosing funding | **arxiv**（仅） | semantic scholar | 10 条全为 arxiv（光学/天文/H2020 基建类），**无 OpenAIRE 项目/基金记录返回** | 记录为"该次调用 OpenAIRE 未应答"；EU 基金/项目空白改由 crossref ISRCTN（OptIMA）与 web-gen 中文通道补足 |
| （重试第 2 式：仍仅 arxiv 应答，无 OpenAIRE 内容） | arxiv | semantic scholar | 同上 | 如实记录：**science 通道两次均未见 OpenAIRE 应答**，不得写成"无相关 EU 项目" |

### 2.2 `evimed_web_search` categories=["general"]（中文检索式）
| 检索式 | 应答引擎 | 未应答引擎 | 返回内容性质 | 采用情况 |
|---|---|---|---|---|
| 精神科 治疗药物监测 TDM 专家共识 | **360search、baidu** | — | 2022 中国精神科 TDM 共识（sinomed/安定医院/MedSci 解读）、TDM 结果解读共识、精神科药物基因组学共识(2025)、第十五届年会动态 | 共识类全部纳入 guideline 轴；年会/学组动态纳入 absence 轴 |
| 阿立哌唑 血药浓度 治疗药物监测 精神科 研究 | **360search、baidu** | — | 2006(n=30)/2022(n=42)/2025(n=60)/2016 硕士论文 等多篇中文"浓度-疗效相关性"论文 | 用于删除"浓度-疗效相关性"方向的新颖性账本 |
| 中国药理学会 治疗药物监测研究专业委员会 学术年会 精神科 | **360search、baidu** | — | 第十三/十四/十五届年会新闻、神经精神学组筹备、安定医院人物页 | 学会动态轴 |
| 治疗药物监测 采样时间 稳态 谷浓度 精神科 规范 | **360search、baidu** | — | 2022 共识 PPT（5–7 个半衰期）、**2026 年登记的"随机浓度换算稳态谷浓度"研究**、各省精神医院科普页 | 采样规范 + 中国在研项目 |

> 说明：本宿主下 general 通道仅 360search 与 Baidu 应答（与技能文档一致，Google/必应/维基不可达）；science 通道 arxiv 与 pubmed 应答、semantic scholar 未应答。**薄结果=引擎少应答，不等同于"网络上不存在"**——本报告未以任何"网络无相关"作为新颖性论据。

## 3. 检索记录（可复现）

| # | 通道 | 检索式 | 返回数 | 日期 |
|---|---|---|---|---|
| 1 | lit | aripiprazole therapeutic drug monitoring | 50 | 2026-08-07 |
| 2 | lit | antipsychotic therapeutic drug monitoring China | 50 | 2026-08-07 |
| 3 | pubmed | aripiprazole therapeutic drug monitoring dose-normalized concentration | 1 | 2026-08-07 |
| 4 | epmc | aripiprazole TDM steady state sampling audit | 18（会议摘要噪声） | 2026-08-07 |
| 5 | pubmed | Hiemke consensus guidelines TDM neuropsychopharmacology update 2017 | 5 | 2026-08-07 |
| 6 | pubmed | aripiprazole dose-adjusted plasma concentration clinical response | 0 | 2026-08-07 |
| 7 | pubmed | clozapine therapeutic drug monitoring China schizophrenia | 30 | 2026-08-07 |
| 8 | pubmed | therapeutic drug monitoring audit psychiatry sampling steady state quality | 1 | 2026-08-07 |
| 9 | pubmed | dehydroaripiprazole aripiprazole ratio CYP2D6 | 13 | 2026-08-07 |
| 10 | pubmed | therapeutic drug monitoring status China survey | 30 | 2026-08-07 |
| 11 | pubmed | consensus guidelines TDM neuropsychopharmacology update 2017 Pharmacopsychiatry | 5 | 2026-08-07 |
| 12 | pubmed | aripiprazole plasma concentration Chinese patients schizophrenia TDM | 3 | 2026-08-07 |
| 13 | epmc | aripiprazole TDM AND (SRC:PPR OR SRC:MED) AND (KIND:R) | 0 | 2026-08-07 |
| 14 | openalex | aripiprazole therapeutic drug monitoring dose concentration range | 30 | 2026-08-07 |
| 15 | web-sci | aripiprazole TDM antipsychotic precision dosing | 15 | 2026-08-07 |
| 16 | web-gen(zh) | 精神科 治疗药物监测 TDM 专家共识 | 15 | 2026-08-07 |
| 17 | pubmed | 40304505（回查） | 1 | 2026-08-07 |
| 18 | epmc | 中国精神科治疗药物监测临床应用专家共识 | 20（无关中文共识） | 2026-08-07 |
| 19 | crossref | antipsychotic therapeutic drug monitoring | 25 | 2026-08-07 |
| 20 | semantic-scholar | antipsychotic blood concentration TDM variability | HTTP 503 | 2026-08-07 |
| 21 | web-gen(zh) | 阿立哌唑 血药浓度 治疗药物监测 精神科 研究 | 15 | 2026-08-07 |
| 22 | pubmed | Therapeutic Reference Range Aripiprazole Schizophrenia Revised | 1 | 2026-08-07 |
| 23 | pubmed | Compilation of serum concentrations 12 antipsychotic drugs TDM | 0→（后以另一式命中 PMID 31025986（https://pubmed.ncbi.nlm.nih.gov/31025986/）） | 2026-08-07 |
| 24 | epmc | aripiprazole AND SRC:PPR（预印本） | 30（无相关 TDM 预印本） | 2026-08-07 |
| 25 | pubmed | therapeutic drug monitoring psychotropic drugs China nationwide survey | 3 | 2026-08-07 |
| 26 | pubmed | compilation serum concentrations antipsychotics percentile | 1（31025986） | 2026-08-07 |
| 27 | web-gen(zh) | 治疗药物监测 采样时间 稳态 谷浓度 精神科 规范 | 13 | 2026-08-07 |
| 28 | pubmed | Korell aripiprazole pharmacokinetic model sampling | 1（29392351） | 2026-08-07 |
| 29 | pubmed | therapeutic drug monitoring children adolescents aripiprazole | 1（32997183） | 2026-08-07 |
| 30 | pubmed | aripiprazole dose plasma concentration receptor occupancy response systematic review | 1（20584524） | 2026-08-07 |
| 31 | pubmed | steady-state sampling proportion quality indicator | 0 | 2026-08-07 |
| 32 | pubmed | stewardship antipsychotics inpatient | 1（36405504） | 2026-08-07 |
| 33 | biblio | managed job（topic: 抗精神病药 TDM） | 38 | 2026-08-07 |
| 34 | topic-sel | managed job（中文方向） | **失败**：PubMed 429 限流→无检索结果，管线未完成（evimed_runner.py RuntimeError） | 2026-08-07 |
| 35–38 | ft | 28910830/17164689/38113699/40304505/42392224/36286707/40179920/24263641/31025986(首试)/29392351/40662264(成功)/37222228(成功)/36920501(成功)/31025986(成功)/39070794(成功) | — | 2026-08-07 |

## 4. 新颖性账本（每候选方向的"最接近已发表工作"）

### 方向 A：精神科住院患者阿立哌唑 TDM 流程质量审计（稳态采样率、采样时间记录、参考范围达标、采样后处置、检验-医嘱一致性）
- **最接近已发表工作**：
  1. 西安精神卫生中心氯氮平 TDM 服务回顾 2019–2022（PMID 38113699（https://pubmed.ncbi.nlm.nih.gov/38113699/），n=大量，中国精神专科，期刊与年份未在题录层确认（题录检索所得；不得虚构））——**机构级 TDM 服务审计**，但限于氯氮平、浓度分布层面（IQR、亚治疗率 68.63%），未评估稳态时序/采样记录/处置链。
  2. 儿科阿立哌唑 TDM 实践（PMID 32997183（https://pubmed.ncbi.nlm.nih.gov/32997183/），n=130，7–19 岁，德国/欧洲，2020）——TDM 服务实践描述，但人群为儿科、无流程质量指标。
  3. 中国 2013（PMID 24263641（https://pubmed.ncbi.nlm.nih.gov/24263641/））/2023（PMID 36920501（https://pubmed.ncbi.nlm.nih.gov/36920501/））全国调查——问卷层面，非病历层面。
  4. 2025 标准化调查（PMID 40304505（https://pubmed.ncbi.nlm.nih.gov/40304505/），2025）——实验室分析层（CV/EQA），**非临床流程层**。
- **轴差异**：① 病历/医嘱/检验记录的**图表达审计**（非问卷、非实验室质评）；② 阿立哌唑（非氯氮平）；③ **2022 中国共识发布前的 2020–2021 基线快照**；④ 以 2022 共识+AGNP 2017/2026 为判据的**流程指标集**（稳态 1/6、采样时刻 0/6、剂量后处置 2/5、检验-医嘱不一致 1/6）；⑤ 中西医结合病房场景。
- **判定**：已占用（相邻单元）但**非本单元**——临床流程质量审计+阿立哌唑+中国成年住院+共识前基线这一格未见已发表工作。保留（brief report/letter 层级）。

### 方向 B：EHR 数据缺口（采样时刻缺失、频次编码歧义、用药史缺失）对 TDM 分析影响的量化与界限（方法学个案）
- **最接近已发表工作**：
  1. Korell 2018（PMID 29392351（https://pubmed.ncbi.nlm.nih.gov/29392351/））——popPK 模拟给出采样时间窗敏感度（阿立哌唑 0–4h vs 20–24h 的 80% 范围），证明"采样时刻未知"可通过范围吸收，**但未在真实 EHR 数据集上做缺口成本演示**。
  2. 2022 荟萃（PMID 36195732（https://pubmed.ncbi.nlm.nih.gov/36195732/））引 Korell 2018："采样时刻相差几小时仅轻微改变阿立哌唑预期浓度"——方法学背书。
  3. 2023 中国调查（PMID 36920501（https://pubmed.ncbi.nlm.nih.gov/36920501/））：58.9% 受访者将"护士采样时间不准"列为 TDM 结果不一致主因——问题公认，但无量化个案。
  4. **2026 年在研中文研究"随机浓度→稳态谷浓度换算方法"**（web-gen 登记的临床试验）——正在做的解决方案是"换算"，本方向做的是"**在缺失时刻不可补时，什么仍可估计、误差上界是多少**"，两者互补而非重复。
  5. 频次编码歧义：技能文档记录的本地编码陷阱（BID4 等）——本数据 30 种频次码即实例。
- **轴差异**：真实 6 次采样数据集上的**缺口成本量化演示**（半衰期 vs 采样间隔 vs 个体间变异同单位比较：24h 内波动 ~20% vs 个体间 C/D 2.7 倍），并给出可复现管道（画像→派生量→质量指标→敏感性分析）。
- **判定**：未占用（无人在真实 EHR TDM 数据上做此类量化演示）；最接近邻居明确。保留（方法学短文）。

### 方向 C：阿立哌唑剂量归一化浓度分布（C/D）病例系列对照东亚参考值
- **最接近已发表工作**：Molden 2006（155 样本，27 倍变异）、Suzuki 2011（63 例按基因型 C/D 9.0–24.6）、2022 荟萃（N=3373，均值 13.8/18.2）、12 药汇编（n=1610）——**本方向的"分布描述"已被大样本彻底覆盖**。
- **判定**：**已回答，删除**（n=6 无法超越上述任一工作的信息量；仅作为 Q1 的结果小节保留 C/D 描述，不单独立题）。

### 方向 D：浓度-疗效/不良反应相关性（中文人群）
- **最接近已发表工作**：中文 2006（n=30）/2022（n=42）/2025（n=60）多篇 + 2016 硕士论文 + Sparshatt 2010 综述（结论本身即"相关性证据弱"）——**已被中文与英文文献反复回答**。
- **判定**：**已回答，删除**（且本数据无结局量表，根本不可行）。

### 方向 E：个案报告（P2 氯氮平 721 ng/mL 超范围 + 4 药联合；P1 超范围未调整）
- **最接近已发表工作**：氯氮平+氯硝西泮过量使用个案（PMID 35242065（https://pubmed.ncbi.nlm.nih.gov/35242065/））、氯氮平超快代谢 5 例（PMID 37268453（https://pubmed.ncbi.nlm.nih.gov/37268453/））、吸烟戒断浓度变化（PMID 38974031（https://pubmed.ncbi.nlm.nih.gov/38974031/））——氯氮平超范围个案已多；且本数据无不良反应结局细节支撑"教学点"。
- **判定**：**基本回答，删除**（单例、无结局、教学点弱）。

### 方向 F：抗精神病药体重/BMI 轨迹与代谢效应
- **最接近已发表工作**：奥氮平/氯氮平代谢效应文献海量（含中国 n=386 奥氮平 TDM 队列 PMID 36286707（https://pubmed.ncbi.nlm.nih.gov/36286707/） 代谢相关分支）；本数据 BMI 轨迹 5 例、方向混合（P2 减重、P4 增重）。
- **判定**：**已回答+样本不足，删除**。

### 方向 G：中西药联用与 TDM
- **判定**：**不可行**（缺 TCM 暴露定量、缺相互作用结局；仅能描述"外用中药+抗精神病药并存"现象，信息量不足以成文）。

## 5. 通道覆盖面核对（≥5 通道）
已用且应答：pubmed、europe-pmc（含全文/预印本）、openalex、crossref（含 ISRCTN）、evimed_literature_search（内部）、guideline、biblio（受管）、web-science（arxiv+pubmed）、web-general（360search+baidu）、full-text（europe-pmc XML + OA PDF 直连）——**10 个通道**。semantic-scholar 两次 503、research-topic-selection 受管任务失败（PubMed 429），均已如实记录，未以其替代任何结论。
