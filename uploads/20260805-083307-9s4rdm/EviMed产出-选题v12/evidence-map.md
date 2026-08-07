# 证据地图（evidence-map）

检索窗口：2026-08-07。通道：pubmed（EviMed 文献适配器 + 生物医学源）、europe-pmc（含全文检索与全文落盘）、openalex、crossref、guideline（EviMed 指南索引）、trial-registry（CT.gov / ISRCTN）、drug-label（DailyMed / NMPA / RxNorm）、bibliometrics（本 run 的文献计量作业）。
preprint 通道（medrxiv / biorxiv）连接器要求精确 DOI、不支持文本检索，本次无记录（已如实记录于 scoping-run.json；不将服务不可用当作阴性证据）。
Full text = 已通过 `evimed_open_access_full_text` 落盘并逐段阅读（5/5，见 `.evimed-sources/`）。

| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| Hiemke 2018, AGNP consensus TDM update 2017 | PMID 29325852 | https://pubmed.ncbi.nlm.nih.gov/29325852/ | guideline; openalex | comparator | 阿立哌唑 100–350、活性部分 150–500、氯氮平 350–600 等参考范围；本数据 REFFR_SCOPE 的来源；Q1/Q2 达标判定标准 | no（付费墙；摘要层） |
| Hart 2022, aripiprazole reference range revised (meta, N=3,373) | PMID 36195732 | https://europepmc.org/articles/PMC9584998 | europe-pmc | comparator; absence | 修订范围 120–270 / 活性部分 180–380；浓度-疗效证据等级 C/D；Q1 的第二种归类口径 | **yes** |
| Sparshatt 2010, systematic review aripiprazole dose-conc-occupancy-response | PMID 20584524 | https://pubmed.ncbi.nlm.nih.gov/20584524/ | pubmed | subject(answered) | Q5 判"已答"的直接依据：TDM 对阿立哌唑价值有限、建议目标 150–210 | no（摘要层已读） |
| Zhang et al 2021, SGA comedication effects on ARI/DARI, Chinese inpatients n=299 | PMID 33851072 | https://europepmc.org/articles/PMC8009217 | europe-pmc | comparator; subject | 中国住院患者 C:D 中位数：单药 ARI 12.2(7.4–19.7)、ARI+DARI 17.5(10.8–28.4)；Q1 的 C/D 比较基准与 Q3 的合并用药背景 | **yes** |
| Lin et al 2022, dose-response aripiprazole Taiwan n=64 | PMID 35923249 | https://europepmc.org/articles/PMC9340887 | europe-pmc | comparator; absence | 中国人 C/D 20.4±9.4（住院组 26.2）；>300 ng/mL 反应更高；作者呼吁中国人群更多研究（Q1 的"尚未回答部分"） | **yes** |
| Zuo 2006, Han Chinese aripiprazole steady-state PK pilot n=12 | PMID 24678101 | https://pubmed.ncbi.nlm.nih.gov/24678101/ | europe-pmc | comparator | 汉族 t½≈62h、Css_max 557.3±135.5（20mg/d）；Q1/Q2 稳态判定的动力学常数来源 | no（ScienceDirect 403） |
| Zhang X 2019, CYP2D6 phenotypes & aripiprazole PK meta | PMID 30565279 | https://pubmed.ncbi.nlm.nih.gov/30565279/ | europe-pmc | subject(answered) | Q6 判"已答"：CYP2D6 表型-浓度关联系统评价已存在 | no（题录层） |
| Jukić 2019, CYP2D6 genotype exposure/efficacy cohort (Lancet Psychiatry) | DOI 10.1016/S2215-0366(19)30088-4 | https://doi.org/10.1016/S2215-0366(19)30088-4 | openalex | subject(answered) | Q6 判"已答"：大样本回顾队列已量化基因型对阿立哌唑暴露的影响 | no |
| Kakinuma/Hikida 2022 (Gao), pediatric tic PPK n=84, CYP2D6, DARI/ARI MR | PMID 36532742 | https://europepmc.org/articles/PMC9755210 | europe-pmc | method; subject(answered) | DARI/ARI 代谢比区分 UM/NM/IM 的方法；Q6 的"已答"补充 | **yes** |
| Yang 2024, antipsychotic concentrations after COVID-19, Beijing n=329 | PMID 39077630 | https://europepmc.org/articles/PMC11284031 | europe-pmc | subject; absence | 中国住院患者 TDM 队列；中药/抗生素与浓度升高及减量相关（OR 2.06/7.53）；Q3 的中药联用背景 | **yes** |
| Kirschbaum 2006, PK variability aripiprazole + dehydroaripiprazole | DOI 10.1097/01.ftd.0000249944.42859.bf | https://doi.org/10.1097/01.ftd.0000249944.42859.bf | crossref | comparator | C/D 个体间变异与 146–254 目标范围；Q1 变异度比较 | no |
| Urban & Cubała 2017, TDM of atypical antipsychotics review | PMID 29432503 | https://pubmed.ncbi.nlm.nih.gov/29432503/ | pubmed | subject | 阿立哌唑推荐等级与 150–210 范围综述背景 | no（摘要层已读） |
| Mauri 2018, clinical PK of atypical antipsychotics update | PMID 29915922 | https://pubmed.ncbi.nlm.nih.gov/29915922/ | pubmed | method | 非典型抗精神病药 PK/TDM 综述（方法背景） | no |
| Grundmann 2014, TDM of atypical antipsychotic drugs | DOI 10.2478/acph-2014-0036 | https://doi.org/10.2478/acph-2014-0036 | openalex | method | TDM 实践综述（方法背景） | no |
| Yang 2022, olanzapine concentrations Chinese TDM age/sex/comedication | PMID 36286707 | https://pubmed.ncbi.nlm.nih.gov/36286707/ | pubmed | method | 中国 TDM 数据"年龄/性别/合并用药→浓度"分析范式；Q1 方法模板 | no |
| Zhu 2023, amisulpride concentrations Chinese TDM | PMID 36863030 | https://pubmed.ncbi.nlm.nih.gov/36863030/ | pubmed | method | 同范式第二例（同团队）；Q1 方法模板 | no |
| Compilation of serum concentrations of 12 antipsychotic drugs (registry setting) | PMID 31025986 | https://pubmed.ncbi.nlm.nih.gov/31025986/ | pubmed | comparator | 12 种抗精神病药人群浓度汇编（注册表级比较基准） | no |
| Age effect on antipsychotic concentration, 19,926 patients | PMID 39996570 | https://pubmed.ncbi.nlm.nih.gov/39996570/ | pubmed | comparator | 大规模 TDM 注册表年龄×性别分层；Q1 外部比较 | no |
| Waade 2007/2009, comedication effects on aripiprazole levels | PMID 17541885 | https://pubmed.ncbi.nlm.nih.gov/17541885/ | pubmed | subject | 合并用药对阿立哌唑浓度影响（Q3 背景） | no |
| Molden 2009, influence of comedication on ARI and DARI | DOI 10.1097/ftd.0b013e3181956726 | https://doi.org/10.1097/ftd.0b013e3181956726 | openalex | subject | 同上（C/D 差异） | no |
| Kirschbaum 2008, TDM of aripiprazole in clinical practice | DOI 10.1055/s-0028-1088279 | https://doi.org/10.1055/s-0028-1088279 | crossref | subject | 临床实践中阿立哌唑 TDM（Q1 背景） | no |
| Bachmann 2008, serum aripiprazole & DARI, response and side effects | DOI 10.1080/15622970701361255 | https://doi.org/10.1080/15622970701361255 | openalex | subject(answered) | 浓度-疗效/副作用证据（Q5 已答的组成部分） | no |
| TDM of children and adolescents treated with aripiprazole | PMID 32997183 | https://pubmed.ncbi.nlm.nih.gov/32997183/ | pubmed | subject | 儿科人群（与本研究人群不同轴） | no |
| TDM-VIGIL study, aripiprazole children/adolescents | PMID 39487894 | https://pubmed.ncbi.nlm.nih.gov/39487894/ | pubmed | absence | 儿童人群药警戒队列正在产出（不占用成人住院人群空位） | no |
| TDM as diagnostic tool for CYP2D6 PM phenotype | PMID 33560096 | https://pubmed.ncbi.nlm.nih.gov/33560096/ | pubmed | method | 用浓度/代谢比识别 PM 表型的方法（Q6 降级方案的依据） | no |
| AGNP task force, how to determine therapeutic reference range | PMID 39950917 | https://pubmed.ncbi.nlm.nih.gov/39950917/ | pubmed | method | 参考范围系统推导方法学（Q1 归类口径依据） | no |
| Huhn 2019, 32 antipsychotics network meta-analysis (Lancet) | PMID 31303314 | https://pubmed.ncbi.nlm.nih.gov/31303314/ | europe-pmc | comparator | 抗精神病药疗效排序（Q3 病例背景） | no |
| Schoretsanitis 2018, TDM in psychiatry summary (WFSBP) | (EVIMED-GUIDE:10 记录；无公开稳定 URL，经 EviMed 指南索引识别) | https://pubmed.ncbi.nlm.nih.gov/29325852/ | guideline | comparator | AGNP 2017 的临床摘要版本 | no |
| 中国精神科治疗药物监测临床应用专家共识（2022 年版），中国药理学会TDM研究专业委员会 | (指南索引记录；无已验证公开 URL) | https://www.nmpa.gov.cn/ | guideline | comparator | 中国国家标准：精神科 TDM 实施/解释/决策；Q2 审计的国内基准 | no |
| 浙江省临床药学实验室开展治疗药物监测管理专家共识（2025） | (指南索引记录；无已验证公开 URL) | https://www.nmpa.gov.cn/ | guideline | comparator | 本省 TDM 实验室质控基准（机构位于浙江省） | no |
| AGNP 2011 consensus (中文译本 2016) | DOI 10.1055/s-0031-1286287 | https://doi.org/10.1055/s-0031-1286287 | openalex | comparator | 历史版本范围（150–300 等旧口径） | no |
| 中国 UPLC-MS/MS TDM 方法学与参考范围讨论 | DOI 10.1002/bmc.3928 | https://doi.org/10.1002/bmc.3928 | crossref | method | 中国检验科 TDM 方法学与范围设定先例 | no |
| Clozapine C/D by dosing frequency, Xi'an 2019–2022 | PMID 39613021 | https://pubmed.ncbi.nlm.nih.gov/39613021/ | pubmed | comparator | 氯氮平 C/D 1.6–2.8（中国）；P2 氯氮平 C/D=2.4 的区间判定 | no（摘要层已读） |
| Clozapine C/D predictors, BC n=172 | PMID 38520287 | https://pubmed.ncbi.nlm.nih.gov/38520287/ | pubmed | method | 用多元回归解释 C/D 变异的方法模板 | no（摘要层已读） |
| Clozapine polypharmacy & ADR burden n=360 | PMID 41546851 | https://pubmed.ncbi.nlm.nih.gov/41546851/ | pubmed | subject | 联用与不良反应负担（Q3 的临床相关性） | no（摘要层已读） |
| Rostami-Hodjegan 2004, clozapine nomogram | PMID 14709950 | https://pubmed.ncbi.nlm.nih.gov/14709950/ | pubmed | method | C/D 列线图方法（Q8 降级的比较基准） | no |
| Risperidone C/D & efficacy, Chinese n=252 | PMID 37551602 | https://pubmed.ncbi.nlm.nih.gov/37551602/ | pubmed | comparator | 同类"浓度-疗效"分析范式（中国人群） | no（摘要层已读） |
| Therapeutic drug level monitoring of antipsychotics at an inpatient psychiatric hospital | DOI 10.1097/ftd.0000000000001156 | https://doi.org/10.1097/ftd.0000000000001156 | crossref | method(audit) | Q2 最接近的已发表审计工作（住院精神科 TDM 监测实践） | no |
| Appropriateness of TDM for antidepressants in inpatient care | DOI 10.1097/01.ftd.0000189897.16307.65 | https://doi.org/10.1097/01.ftd.0000189897.16307.65 | crossref | method(audit) | 恰当性审计指标设计模板（Q2） | no |
| Prescribing patterns & TDM in psychiatric high-security unit | DOI 10.1097/ftd.0b013e31818622c4 | https://doi.org/10.1097/ftd.0b013e31818622c4 | crossref | method(audit) | 处方-监测模式审计（Q2 模板） | no |
| Current status of TDM in mental health: review | PMID 36559168 | https://pubmed.ncbi.nlm.nih.gov/36559168/ | europe-pmc | absence | 综述结论"TDM 在精神科应用不足，需更多实施研究"（Q2 的缺口论据） | no（摘要层已读） |
| TDM in psychiatry: enhancing treatment precision (2024 review) | PMID 38794212 | https://pubmed.ncbi.nlm.nih.gov/38794212/ | europe-pmc | absence | 2024 综述；TDM 价值与实施差距（Q2 背景） | no（摘要层已读） |
| ISRCTN16840270, TDM of linezolid in Chinese patients (registered) | ISRCTN16840270 | https://www.isrctn.com/ISRCTN16840270 | trial-registry | absence | 已注册的中国 TDM 试验集中在抗菌药领域（反证精神科空缺） | no |
| NCT06590428, linezolid TDM in RR-TB | NCT06590428 | https://www.clinicaltrials.gov/ct2/show/NCT06590428 | trial-registry | absence | 同上：注册 TDM 试验无精神科抗精神病药项 | no |
| NCT06969755, biomarkers early schizophrenia (aripiprazole arm) | NCT06969755 | https://www.clinicaltrials.gov/ct2/show/NCT06969755 | trial-registry | absence | 含阿立哌唑臂的注册研究但不做 TDM | no |
| NMPA 阿立哌唑片/博思清 说明书（10mg） | NMPA 数据查询（EviMed 索引候选，须以官方现行版核验） | https://www.nmpa.gov.cn/datasearch/ | drug-label | comparator | 中国说明书适应症（精神分裂症）与剂量（10mg/d 起） | no |
| DailyMed ARIPIPRAZOLE TABLET | DailyMed SPL setid 50214c47-2ea3-b373-e063-6394a90aad23 | https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=50214c47-2ea3-b373-e063-6394a90aad23 | drug-label | comparator | 美国说明书（未推荐常规 TDM） | no |
| RxNorm aripiprazole | RXCUI 1602604 / 1998453-1998463 | https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=1602604 | drug-label | linkage | 药品名规范化（external-linkage 的连接键） | no |
| 本 run 文献计量作业（70 篇、2001–2026、峰值 2008、研究前沿：东亚人群/药物基因组学） | bibliometric-20260807031907-2c8783a016b9 | （工作区产物：bibliometric-analysis-runs/…/output/report.md） | bibliometrics | absence | 领域规模与前沿判断：阿立哌唑 TDM 文献量中等、增长平缓、东亚人群为活跃前沿 | no |

**通道清单（≥5 达标）**：pubmed、europe-pmc、openalex、crossref、guideline、trial-registry、drug-label、bibliometrics（8 个）。
**全文（≥5 达标）**：5 篇已通过 `evimed_open_access_full_text` 落盘并逐段阅读，对应行在表中标记 Full text=**yes**，工件存于 `.evimed-sources/` 目录。
**来源层级说明**：本表"no"行中标注"摘要层已读"者，其结论只引用摘要原文可见的内容（如研究设计、样本量、主要数值），不推测未见于摘要的细节；"题录层"仅引用题名级事实（存在性、期刊、年份）。中国共识两条经 EviMed 指南索引识别（无已验证公开 URL），仅在叙述中作为国内标准引用，不参与计数。
