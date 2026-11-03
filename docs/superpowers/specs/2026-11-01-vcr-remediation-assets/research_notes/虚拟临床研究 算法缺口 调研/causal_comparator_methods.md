# 对照研究方法缺口:外部对照、因果推断与证据借用(2022 至 2026-11)

## Q1. 总判断:哪些值得加,哪些不值得,引擎能不能跑

### Takeaway
没有一个现有方法被取代。真正的缺口有两类:一是监管和 HTA 文件明确要求、而引擎没有的整段流程(目标试验模拟、网络 Meta 分析、针对未测混杂的定量偏倚分析、协变量多重插补);二是几个几乎零成本的补位(偏倚平移检验、生存结局的双稳健估计、STC 的 G-computation 形式、闭式 power prior 与 SAM)。ML 估计量、因果森林、邻近因果推断目前没有找到监管或 HTA 接受的证据,不值得现在加。

引擎适配上有三个实测硬约束,比方法选择更先决定成本:`multinma` 在 R 4.3.3 上被 `gsl` 挡住;`rstan` 在 V8 存在时无法在 3 GiB 地址空间限制下加载;`episensr` 直接依赖 V8,不能进运行时。

### Cited Findings

**阅读深度。** 全文自行提取(pdftotext/curl):[FDA 2023 外部对照草案](https://www.fda.gov/media/164960/download)、[FDA 2026 Bayesian 草案](https://www.fda.gov/media/190505/download)、[FDA 2024 非干预研究草案](https://www.fda.gov/media/177128/download)、[EU HTA 方法学指南](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf)、[EU HTA 实践指南](https://health.ec.europa.eu/document/download/1f6b8a70-5ce0-404e-9066-120dc9a8df75_en?filename=hta_practical-guideline_direct-and-indirect-comparisons_en.pdf)、[EMA 2025 RWD 反思文件](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf)、[MHRA 2025 外部对照草案](https://assets.publishing.service.gov.uk/media/6825bab1a4c1a40fde4e63e5/Draft_MHRA_Guideline_on_Studies_with_RWD_ECA_May2025.pdf)、[NICE RWE 框架方法章](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects)、[arXiv 2605.03282 综述](https://arxiv.org/abs/2605.03282)(后者只读了相关小节)。其余论文多为摘要或搜索摘要,逐条标注。WebSearch 和 WebFetch 返回的是小模型摘要,凡只经过它们的内容都标 [摘要级]。

**逐项判定(按优先顺序)。** 依据和字段详情在 Q3 到 Q12。

| 判定 | 候选 | 一句话理由 |
|---|---|---|
| 现在加 | 偏倚平移检验与偏倚尺度 tipping point | EU 指南点名,手写几行,现有 `comparator.tipping_point` 只管缺失结局 |
| 现在加 | 概率型 QBA(未测混杂)+ tipr 式闭式 | FDA、NICE、TARGET 都点名;手写,`episensr` 只做 CI 交叉核对 |
| 现在加 | 目标试验模拟:序贯试验(TrialEmulation 或 SEQTaRget)和 clone-censor-weight(手写) | EMA、NICE、FDA 2024 非干预草案都以它为设计框架;引擎没有 |
| 现在加 | 频率学 NMA(netmeta)和剂量反应 Meta(dosresmeta) | JCA 的基本方法;`evidence.pool` 只能两两合并 |
| 现在加 | 协变量多重插补(mice,配 Rubin 合并) | MHRA 明说剔除缺失者可能引入偏倚,NICE 评审也批评缺失协变量 |
| 现在加 | 生存结局 AIPW(RMST 或定点生存率) | `comparator.aipw` 只有连续和二分类;已发表的肿瘤外部对照实证多用生存终点(Gupta 2025、FoCR 试点,见前次笔记) |
| 现在加 | STC 的 G-computation 形式 | EU 指出常规 STC 在非恒等连接下有偏;可复用现有 copula |
| 现在加 | 闭式 power prior、SAM、elastic | FDA 草案点名;共轭形式手写,接在 `map_prior` 同一族 |
| 现在加 | flexsurv 样条(Royston-Parmar) | TSD 21 方法;`survival_fit` 只有四个参数分布 |
| 现在加 | PS 修剪(trimming)并重述目标人群 | EU 要求说明修剪后的人群;引擎只有截断敏感性,无修剪 |
| 以后 | ML-NMR(multinma) | HTA 认可但依赖最重;NICE 肿瘤提交到 2024-05 未见使用 |
| 以后 | TMLE、SuperLearner 辅助的 AIPW | 模拟有优势,监管文件未点名;外部对照样本小,收益有限 |
| 以后 | gfoRmula、LTMLE、lmtp | NICE 偏好 g-methods,但需要纵向数据,先有 TTE 再说 |
| 以后 | psrwe、PS-SAM、commensurate(手写) | 需要 rstan 或尚无稳定实现 |
| 以后 | rbmi、IPD Meta、survextrap、flexsurvcure、sensemakr、增广 MAIC、重叠加权 ATT | 见各节 |
| 不值得 | DoubleML、因果森林(grf)用于对照研究 | 未找到外部对照场景的监管或 HTA 使用证据 |
| 不值得 | psborrow2、hdbayes、NCC | 需要 CmdStan 工具链(psborrow2 在建分析对象时现场编译模型),或只解决平台试验问题(NCC) |
| 不值得 | 邻近因果推断、ML-UMR | 无成熟包,证据为预印本 |
| 不值得 | survHE、cuRe、gemtc、crossnma、pcnetmeta | 被 `rms` 挡在 R 4.3.3 外,或依赖 JAGS |

**引擎约束(读自分支 cde64eddc,不是 main)。**
- 作业默认 600 CPU 秒,上限 3600;R 在 `min(两者)` 的 0.9 处自停;`VCR_ENGINE_MEMORY_BYTES` 通过 `RLIMIT_AS` 生效;compose 默认 3221225472 字节(3 GiB),容器限 2 CPU、4 GB,根文件系统只读,`/tmp` 是 512 MB tmpfs;`VCR_ENGINE_CORES` 默认 1(`项目代码/vcr-engine/service/app.py`、`README.md`,`OpenScience/deploy/web/docker-compose.yml` 第 1676 到 1734 行)。
- 运行时锁文件 62 个包,不含 rstan、V8、flexsurv、data.table(`项目代码/vcr-engine/R/package-lock.json`)。CI 库(本机 `~/R/vcr-4.3`,158 个包)才有 rstan、RBesT、flexsurv、rstpm2、WeightIt、cobalt、metafor、MatchIt、EValue。
- 版本来自 `packagemanager.posit.co/cran/2026-09-28`,Dockerfile 以 `type="source"` 编译,`R_BUILD_NCPUS=1`,改日期等于数值变更,要重跑 `tests/run_all.sh`(`项目代码/vcr-engine/Dockerfile`)。

**R 4.3.3 上的硬阻塞(本机实测,`available.packages()` 过滤 + 实际安装)。**
- `gsl` 当前版 2.1-9 要求 [R ≥ 4.5.0](https://cloud.r-project.org/web/packages/gsl/index.html),而 [copula](https://cloud.r-project.org/web/packages/copula/index.html) 依赖 gsl,所以 multinma、outstandR、rdborrow 在快照里装不上。绕过办法经验证可行:从 [CRAN 归档](https://cloud.r-project.org/src/contrib/Archive/gsl/)钉 `gsl_2.1-8`(归档日期 2023-01-24),配 libgsl-dev 2.7.1,在 R 4.3.3 上编译通过,copula 随后安装成功。
- `rms` 要求 R ≥ 4.4.0,挡住 survHE、cuRe、riskRegression。[ccwr](https://cloud.r-project.org/web/packages/ccwr/index.html) 自身要求 R ≥ 4.4.0。`Deriv` 要求 [R ≥ 4.5](https://cloud.r-project.org/web/packages/Deriv/index.html),挡住 postcard,也在 gfoRmula 的闭包路径上(doBy → Deriv;本机 gfoRmula 能跑,但 `requireNamespace("doBy")` 为 FALSE,按 Dockerfile 的源码安装是否通过未测)。
- 过滤结果里的 Matrix、MASS、mgcv(R ≥ 4.7)是 R 自带的推荐包,旧版已随 4.3.3 提供,不算阻塞;但没有逐一核对版本下限。

**V8 与 3 GiB 限制(本机实测)。**
- rstan 2.32.7 的 Imports 不含 V8,但只要库里有 V8,加载 rstan 就会加载它。在 `ulimit -v` 3、4、6、8 GiB 下进程都因 `Failed to reserve virtual memory for process-wide V8 pointer compression cage` 崩溃(SIGTRAP),16 GiB 通过。
- 把 V8 从库路径移除后,rstan 改走 QuickJSR,在 3 GiB 下加载成功,`psrwe`(预编译 Stan 模型)也在 3 GiB 下跑完。
- 所以 rstan 进运行时的条件是:闭包里不能有 V8。CI 库里 V8 来自 juicyjuice、reactable 这条链。[episensr](https://cloud.r-project.org/web/packages/episensr/index.html) 经 dagitty 直接依赖 V8,3 GiB 下无法加载,只能进 CI。

**运行实测。** 环境:本开发机,4 核、约 7 GB(空闲 2 到 3 GB),R 4.3.3,2026-09-28 快照的 noble 二进制,单线程,`ulimit -v 3145728`(模拟 3 GiB)。不是生产主机,也不是运行时镜像,只说明量级。脚本在 `/tmp/cc-research/bench/`(临时目录)。

| 任务 | 数据 | 墙钟 | 峰值 RSS | 结果 |
|---|---|---|---|---|
| TrialEmulation 0.0.5 `initiators`,PP | 包内 `trial_example`,503 人,48,400 行 | 11.8 s | 1.26 GB | 成功 |
| 同上放大 5 倍 | 242,000 行 | 13.4 s | 2.82 GB | **失败**:`cannot allocate vector of size 377.0 Mb` |
| SEQTaRget 1.4.4(快照版),ITT | 包内 `SEQdata`,300 人,12,180 行 | 5.0 s | 438 MB | 成功 |
| gfoRmula,生存,两策略,`nsimul=10000`,20 次 bootstrap | 2,500 人,13,170 行 | 42.7 s | 310 MB | 成功 |
| tmle,glm+glmnet+ranger,5 折 | 模拟 n=1000,8 协变量 | 22.8 s | 312 MB | 成功 |
| ltmle,glm,3 时点 | 模拟 n=1000 | 0.65 s | 103 MB | 成功 |
| lmtp `lmtp_sdr`,生存,τ=5,3 折 | 模拟 n=1000 | 3.7 s | 168 MB | 成功 |
| grf `causal_survival_forest`,2000 棵树 | 模拟 n=1000 | 8.1 s | 328 MB | 成功 |
| netmeta(smokingcessation)+ dosresmeta(alcohol_cvd) | 包内数据 | 6.0 s | 366 MB | 成功 |
| flexsurvspline + flexsurvcure | `bc`,n=686 | 2.5 s | 278 MB | 成功 |
| rbmi,condmean 刀切,jump-to-reference | 172 人 | 29.1 s | 300 MB | 成功 |
| mice,m=20,maxit=5 | 模拟 n=2000,11 变量 | 4.3 s | 261 MB | 成功 |
| sensemakr + tipr(无 V8 库) | darfur | 2.3 s | 138 MB | 成功 |
| SAMprior(无 V8 库) | 单次权重 | 6.3 s | 265 MB | 成功 |
| psrwe power prior,2 链 2000 迭代(无 V8 库) | 1031 RWD + 200 当前 | 3.6 s(采样 0.71 s) | 400 MB | 成功 |
| episensr `probsens_conf`,10 万次 | 2×2 表 | 1.9 s | 293 MB | 只在 16 GiB 下成功 |
| multinma 0.9.1 编译 | 全部 8 个 Stan 模型;再试只保留 `binomial_2par`,`-O1` | 270 到 340 s 后失败 | cc1plus 1.9 到 2.6 GB | **失败**:`cc1plus` 被 Killed |

闭包规模(快照元数据;"新增"相对 CI 库,进运行时的实际新增更多):TrialEmulation 41/+6,SEQTaRget 50/+10,gfoRmula 87/+35,tmle 21/+12,ltmle 2/0,lmtp 32/+14,DoubleML 37/+17,grf 8/+2,multinma 96/+21,netmeta 70/+21,dosresmeta 1/+1,flexsurvcure 52/0,tipr 12/+1,sensemakr 0/0,mice 61/+25,rbmi 47/+11,psrwe 54/+1,SAMprior 72/+1,psborrow2 28/0(另需 cmdstan),PSweight 52/+18,NCC 100/+20,BayesPPD 4/+1。

**许可。** 候选中没有发现禁止商用的许可。需要知道的事实:[lmtp](https://cloud.r-project.org/web/packages/lmtp/index.html) 是 AGPL-3,[stdReg2](https://cloud.r-project.org/web/packages/stdReg2/index.html) 是 AGPL ≥ 3;[tmle](https://cloud.r-project.org/web/packages/tmle/index.html) 和 [netmeta](https://cloud.r-project.org/web/packages/netmeta/index.html) 带 `file LICENSE`,内容未读。

### Inferences
- 判定为"现在加"的十项里,偏倚平移、闭式 tipr、闭式 power prior、SAM、生存 AIPW、STC、修剪、CCW 可以只用现有运行时库手写,CI 对照上游,符合引擎"手写并交叉核对"的既有做法。真正要扩运行时锁文件的只有序贯 TTE、netmeta、dosresmeta、mice、flexsurv。
- "ML-NMR 现在就加"的代价被低估了:要钉归档 gsl、把 rstan 放进运行时并保证无 V8、镜像构建能承受单文件 2 GB 以上的编译内存。
- 所有新方法的产出都应当是标签和限定语,不是门槛,与业主"裁决不扣交付"一致。

### Gaps
- 没有在运行时镜像或生产主机上测过,也没有测 2 CPU、4 GB 的 cgroup 下的表现。
- multinma 的采样时间没能测到,因为本机编译不下来。[CRAN 检查表](https://cloud.r-project.org/web/checks/check_results_multinma.html)显示 0.9.1 在 r-devel Linux 上安装耗时 1440 到 1740 秒,这是唯一的构建成本数字。
- Python 实现没有逐项调研。引擎的 Python 包装只有 pyarrow,候选全部以 R 为准。

---

## Q2. 现有方法是否仍是现行做法

### Takeaway
全部仍是现行做法,没有一个被取代。变化在于适用范围:无锚定 MAIC 在 EU 被明确称为"highly problematic",但仍是 NICE 提交里最常见的方法;E-value 只能算底线,不能算完整的偏倚分析;引擎的 tipping point 只覆盖缺失结局,不覆盖未测混杂。

### Cited Findings

| 现有方法 | 判断 | 依据 |
|---|---|---|
| 熵平衡 | **仍是标准** | 2025 预印本仍称熵平衡式 MAIC 为"popular"权重法 [摘要级,[Campbell & Remiro-Azócar](https://arxiv.org/abs/2505.00113)];WeightIt 2026-09-30 仍有发布([CRAN](https://cloud.r-project.org/web/packages/WeightIt/index.html)) |
| 倾向评分加权(IPW) | **仍是标准** | EU 方法学指南称,IPD 全有的非随机比较"mostly"用倾向评分,并把匹配、分层、IPTW 列为常用([EU 第 6 章](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf));FDA 不背书单一方法(见前次笔记 comparators.md Q2) |
| 加权 Cox | **仍是标准,解读需限定** | 对数风险比不可塌缩,条件估计量不能跨研究比较 [摘要级,[arXiv 2108.12208](https://arxiv.org/pdf/2108.12208)];EU 实践指南设专节要求评估比例风险(4.3.1 节);引擎已同时给 PH 检验和 RMST,不需要替换 |
| AIPW | **现行,未被 TMLE 取代** | ATT 模拟:双稳健法偏倚通常更小,但没有哪种方法在 MSE 上始终最好 [摘要级,[Wang et al., NEJSDS 2025](https://arxiv.org/abs/2408.07193)]。缺口是没有生存结局 |
| MAIC | **最常用,地位下降,未被取代** | 见 Q5 |
| 稳健 MAP | **仍是标准** | [FDA 2026 Bayesian 草案](https://www.fda.gov/media/190505/download)点名 mixture prior 和层次模型;[RBesT](https://cloud.r-project.org/web/packages/RBesT/index.html) 2026-09-18 仍在更新;[CDE 2026 第 6 号](https://www.cnpharm.com/upload/resources/file/2026/01/21/183608.pdf)(前次笔记已读) |
| E-value | **仍在用,但只是最简单的一档** | NICE 把它列为较简单的方法,"most useful when exploring a single unmeasured source of bias",并要求预设合理偏倚水平([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects));Ioannidis 等 2019 批评易被误读 [摘要级,[综述线索](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7746396/)] |
| 负对照 | **仍是标准,地位上升** | EMA 2025:因果研究"should be considered"纳入对照暴露或对照结局,同时提到阳性对照([EMA 5.5 节](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf));NICE 敏感性分析表也列入 |
| tipping point | **仍是标准,引擎只覆盖一半** | 引擎的是缺失结局(README 第 211 行)。外部对照综述里的 tipping point 是因果差距 δ:τ(δ) = τ̂ − δ([arXiv 2605.03282](https://arxiv.org/abs/2605.03282) 3.6 节),这半边引擎没有 |

**文件状态(2026-11-02 核对)。**
- FDA 外部对照指南:仍是 Draft,2023 年 2 月,docket FDA-2022-D-2983,页面无定稿说明 [摘要级但来自 FDA 页面,[FDA](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-design-and-conduct-externally-controlled-trials-drug-and-biological-products)]。有第三方文章称 2024 年已定稿,与 FDA 页面矛盾,不采信 [[IntuitionLabs](https://intuitionlabs.ai/articles/virtual-control-arms-clinical-trials)]。
- FDA Bayesian 指南:草案,2026 年 1 月([FDA](https://www.fda.gov/media/190505/download))。
- FDA 非干预研究 RWE 指南:草案,2024 年 3 月,把目标试验模拟列为支持因果推断的例子([FDA](https://www.fda.gov/media/177128/download))。
- EMA:RWD 反思文件 EMA/99865/2025,CHMP 2025-03-17 采纳([EMA](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf));外部对照反思文件的概念文件 EMA/125200/2026,2026-06-03 发布,反思文件草案页面上尚未出现([EMA](https://www.ema.europa.eu/en/development-reflection-paper-use-external-controls-evidence-generation-regulatory-decision-making-scientific-guideline));RAPS 报道草案计划 2026 Q4 [单一二手来源,[RAPS](https://www.raps.org/resource/ema-proposes-reflection-paper-on-using-external-co.html)]。
- MHRA 外部对照草案:咨询 2025-05-20 至 07-14 已结束,仍在分析反馈,未定稿([gov.uk](https://www.gov.uk/government/consultations/mhra-draft-guideline-on-the-use-of-external-control-arms-based-on-real-world-data-to-support-regulatory-decisions))。
- NICE RWE 框架:2022-06-23 发布,2025-09 最近一次小更新,新增目标试验报告工具的引用([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/update-information))。
- ICH M14:2025-09 达到 Step 4 [摘要级,[RAPS](https://www.raps.org/resource/ich-adopts-the-m14-guideline-on-observational-stud.html)],范围是安全性研究。

### Inferences
- 不应做任何"替换"型改造。合理动作是给无锚定 MAIC 和 E-value 配上文件要求的附加输出:偏倚范围、平移检验、合理偏倚水平。
- 引擎"tipping point"这个名字容易让模型和读者以为覆盖了未测混杂,新增偏倚尺度版本时要在结果里把两者分开。

### Gaps
- Ioannidis 2019 和 Blum 的实证评估原文未打开,只看到搜索摘要。
- ICH M14 终稿未读,不确定是否提及目标试验。
- 未找到 FDA 批准案例按方法统计的系统综述。IntuitionLabs 引用的 FDA 财年外部对照计数未核对,没有采用。

---

## Q3. 目标试验模拟:TARGET、clone-censor-weight、永恒时间、序贯模拟与软件

### Takeaway
目标试验模拟已是 EMA、NICE 和 FDA 2024 非干预草案里的设计框架,TARGET(2025)给了报告标准,引擎缺整段流程。序贯 ITT 和 PP 有 R 包可用,但都是早期版本且内存要关注;CCW 在 R 4.3.3 上没有可用的包,要手写,逻辑不复杂。

### Cited Findings
- TARGET:Cashin AG, Hansford HJ, Hernán MA 等,JAMA 2025;334(12):1084-1093,doi:10.1001/jama.2025.13350,同步刊于 BMJ 2025;390:e087179;21 条,适用于平行组、个体随机目标试验并调整基线混杂 [摘要级,[RTI 记录](https://www.rti.org/publication/transparent-reporting-of-observational-studies-emulating-a-target);[EQUATOR](https://www.equator-network.org/reporting-guidelines/22462/)]。条目细节见前次笔记 comparators.md Q1。
- EMA 2025:"The target trial emulation (TTE) framework should be considered",并说明可减少 prevalent user 和 immortal-time 偏倚,但不能替代对混杂的处理([EMA](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf))。
- NICE:非随机研究"should be designed to mimic the randomised trial";要避免资格、分配、随访起点不一致造成的时间相关偏倚;提到 cloning 会引入需要处理的信息性删失([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects))。NICE 2025 年加入了目标试验工具的引用([NICE 更新记录](https://www.nice.org.uk/corporate/ecd9/chapter/update-information))。
- 一篇 2024 年的博客称 NICE 回顾发现提交中尚未有明确使用 TTE 框架的评估 [单一来源,可能已过时,[Becaris](https://becarispublishing.com/digital-content/blog-post/target-trial-emulation-hta-rwd-submissions-methodological-evolution-industry-revolution)]。
- MHRA 草案把永恒时间偏倚作为时间相关偏倚的一种,并偏好同期数据([MHRA](https://assets.publishing.service.gov.uk/media/6825bab1a4c1a40fde4e63e5/Draft_MHRA_Guideline_on_Studies_with_RWD_ECA_May2025.pdf))。
- CCW 的应用比较:同一数据集上 CCW 与时变 Cox、IPTW 给出不同 HR,CCW 区间更宽 [单一数据集,摘要级,[Frontiers in Medicine 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC10991758/table/tab1)]。永恒时间方法综述:序贯法每个子试验要匹配或加权,克隆法需要人工删失 [摘要级,[arXiv 2202.02369](https://arxiv.org/pdf/2202.02369)]。

| 字段 | 序贯模拟:TrialEmulation | 序贯模拟:SEQTaRget | CCW |
|---|---|---|---|
| 关键文献 | Danaei 2013([CRAN 引用](https://cloud.r-project.org/web/packages/TrialEmulation/index.html));Su 等 2024 [预印本,[arXiv 2402.12083](https://arxiv.org/abs/2402.12083)] | [CRAN 描述](https://cloud.r-project.org/web/packages/SEQTaRget/index.html) | Hernán & Robins 2016;Gaber 2024(经 [ccwr vignette](https://ftp.fau.de/cran/web/packages/ccwr/vignettes/ccwr.html),摘要级) |
| 实现 | Apache ≥ 2,0.0.5,2026-08-25,Roche 和 MRC 资助 | MIT,1.4.5,2026-10-12(快照 1.4.4) | [ccwr](https://cloud.r-project.org/web/packages/ccwr/index.html) MIT,0.0.2,2026-09-03 |
| R 4.3.3 与限制 | 可装;依赖 duckdb(构建重);48,400 行 11.8 s、1.26 GB;242,000 行超 3 GiB 失败;分块和 case-control 抽样路径未测 | 可装;ITT 5 s、438 MB;PP 未测 | **ccwr 不能**(要求 R ≥ 4.4.0);手写只需 `survival` + `glm` |
| 新问题 | "治疗起始时间各不相同的队列里,开始用药和不用药的 ITT 与 PP 效应是多少,且没有永恒时间偏倚?" | 同左,含动态策略 | "确诊后 30 天内开始 vs 不开始"这类有宽限期的策略 |
| 使用证据 | EMA、NICE、FDA 2024 非干预草案认框架(FDA 2023 外部对照草案全文未出现 target trial),不认具体包;未见包的监管使用记录 | 同左 | NICE 提及 cloning |
| 判定 | **现在加**(两者择一) | 同左 | **现在加**,手写,结果标明人数与克隆数分开(TARGET 要求) |

引擎现状:`cohort.build` 已产出时间零和退出点(README 第 172 行),`comparator.*` 都以单行基线表为输入,没有人-时间展开。

### Inferences
- 选包建议:先在同一数据上比较 TrialEmulation 和 SEQTaRget 的 PP 结果和内存,再定。TrialEmulation 依赖 duckdb,而容器根文件系统只读、`/tmp` 仅 512 MB,落盘路径要专门验证。
- 这是所列缺口里用户价值最高的一项:持真实世界登记数据的人,最常见的问题就是治疗起始时间不齐。
- 最小设计是把 TTE 做成展开步骤,后接现有加权和 Cox,而不是另起一套估计器。

### Gaps
- TrialEmulation 的分块和抽样路径、SEQTaRget 的 PP 和宽限期支持未验证(CRAN 描述被截断)。
- 没有找到 CCW 与序贯软件在生存结局上的直接模拟比较。
- 未核实数据平面能否按人-期存储,也未核实 OMOP、FHIR 映射产出是否含时变字段。

---

## Q4. 机器学习因果估计量:TMLE、LTMLE、SuperLearner、DML、因果森林及其生存版本

### Takeaway
没有找到任何监管文件点名接受 TMLE、DML 或因果森林作为外部对照的估计方法,也没有找到使用了它们的监管提交。FDA 外部对照草案反而提醒复杂度要付出假设代价。TMLE 值得以后加;DML 和因果森林对这类小样本对照研究不值得。

### Cited Findings
- 全文检索:[FDA 2023 外部对照草案](https://www.fda.gov/media/164960/download)无 "machine learning"、"doubly" 字样;它说的是"adding complexity"通常需要更多难以证实的假设。[FDA 2024 非干预草案](https://www.fda.gov/media/177128/download)和 [EMA 2025 反思文件](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf)同样未提 doubly robust 或 machine learning。检索词命中为零不等于文件反对。
- EU 方法学指南说倾向评分模型"from logistic regression to machine learning models"都可以用,强调预设和透明,这是找到的最明确的官方开口([EU](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf))。
- NICE:可用 ML 在协变量很多时帮助选择充分协变量集,但要说明理由([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects))。
- 2605.03282 综述(三位作者来自 FDA CDER,声明不代表机构立场;预印本)写道,TMLE 与 AIPW 不同,属于 g-computation 类并保持参数空间,"better finite-sample performance";也点名 EScvtmle、atmle 等混合设计工具([arXiv](https://arxiv.org/abs/2605.03282));其中 [EScvtmle](https://cloud.r-project.org/web/packages/EScvtmle/index.html) 已从 CRAN 移除,atmle 不在 CRAN(本机查询 404)。这是学术判断,不是监管立场。
- Wang、Wu、Chen,NEJSDS 2025:外部对照 ATT,比较 AIPW、AIPW+SL、TMLE+SL 等;双稳健法偏倚通常更小;没有方法在 MSE 上始终最优;阳性违反可明显抬高 I 类错误;不混杂违反时所有方法都有大偏倚 [摘要级,[arXiv 2408.07193](https://arxiv.org/abs/2408.07193)]。
- Gruber、Phillips、Lee、Ho、Concato、van der Laan:主张靶向学习路线图用于真实世界证据,含两个案例 [摘要级,[arXiv 2205.08643](https://arxiv.org/abs/2205.08643)]。John Concato 的 FDA 身份未在该页核实。
- [Tempus 案例](https://www.tempus.com/content/case-study/utilizing-real-world-external-controls-for-regulatory-decision-making/)描述了为监管提交构建外部对照,但摘要未说明用了 TMLE [供应商来源]。

| 方法 | 实现(许可,最后发布) | R 4.3.3 与限制 | 新问题 | 判定 |
|---|---|---|---|---|
| TMLE(二分类、连续) | [tmle](https://cloud.r-project.org/web/packages/tmle/index.html) BSD-3 + file LICENSE 或 GPL-2,2.1.1,2025-08-30 | 可行;n=1000 用 SL 22.8 s、312 MB;闭包 21/+12 | 与 AIPW 相同,区间和有界结局更好 | **以后**:对 AIPW 的增量小,可先手写靶向步骤,tmle 只做 CI 核对 |
| SuperLearner 作 AIPW 辅助模型 | [SuperLearner](https://cloud.r-project.org/web/packages/SuperLearner/index.html) GPL-3,2.0-42,2026-09-14 | 可行;ranger 已在运行时 | 协变量多、函数形式不明时 | **以后**:外部对照常只有一两百人;需要交叉拟合 |
| 生存 TMLE | [survtmle](https://cloud.r-project.org/web/packages/survtmle/index.html)、[concrete](https://cloud.r-project.org/web/packages/concrete/index.html) 已从 CRAN 移除;[adjustedCurves](https://cloud.r-project.org/web/packages/adjustedCurves/index.html) GPL ≥ 3,0.12.0 含 AIPTW 和 TMLE 选项 | 专用包已离开 CRAN;adjustedCurves 未安装测试(闭包 27/+8) | 调整后生存曲线 | **以后**;先做 Q1 里手写的生存 AIPW |
| LTMLE | [ltmle](https://cloud.r-project.org/web/packages/ltmle/index.html) GPL-2,1.3-0,2023-04-15(三年未更新) | 可行;0.65 s;闭包 2/0 | 时变治疗 | **以后**,见 Q11 |
| lmtp | [lmtp](https://cloud.r-project.org/web/packages/lmtp/index.html) **AGPL-3**,1.5.4,2026-05-07 | 可行;3.7 s | 修饰治疗策略,含删失生存 | **以后** |
| DML | [DoubleML](https://cloud.r-project.org/web/packages/DoubleML/index.html) MIT,1.0.2,2025-04-11 | 可行;闭包 37/+17,依赖 mlr3 全家 | 与交叉拟合 AIPW 基本同一问题 | **不值得** |
| 因果森林 | [grf](https://cloud.r-project.org/web/packages/grf/index.html) GPL-3,2.6.1,2026-03-04 | 可行;生存版 8.1 s;`average_treatment_effect` 对生存森林只支持 `target.sample="all"`,给不了 ATT(本机报错确认) | 异质性探索 | **不值得**:外部对照要 ATT,样本小 |

### Inferences
- "ML 估计量更现代"不能作为加入理由。外部对照的主要风险是未测混杂和结局漂移,双稳健估计解决不了这个([NEJSDS 摘要](https://arxiv.org/abs/2408.07193)也这么说),而 FDA 又提醒复杂度的代价。
- 现有 AIPW 加一条生存结局路线,比增加任何 ML 估计器都更值。

### Gaps
- Chernozhukov 2018(DML)、Cui 2023(生存因果森林)、van der Laan & Rose 原著未打开,故未列为关键文献。
- 没有找到 TMLE 用于实际注册提交的公开记录,搜索两次,但 FDA 审评文件未系统检索,不能断言不存在。
- 一篇比较外部对照方法的 ISPOR 综述摘要已被撤回 [[ISPOR](https://www.ispor.org/publications/journals/value-in-health/abstract/Volume-25--Supplemental-Issue-12S/MSR60-Literature-Review-of-Statistical-Methods-Comparisons-Through-Simulations-When-Using-External-Control-Arm-for-Regulatory-or-HTA-Submissions)],未使用。

---

## Q5. 人群调整间接比较:ML-NMR、STC、MAIC 与 NICE、EU JCA

### Takeaway
EU 接受锚定的 MAIC、STC、ML-NMR,但要求预设效应修饰因子,并用偏移零假设检验应对未测修饰因子;无锚定 MAIC 和 STC 被称为"highly problematic",有全部 IPD 时应改用 PS 方法。MAIC 在实务中仍最常用。引擎最该补的是 STC 的 G-computation 形式和偏移检验;ML-NMR 排在后面。

### Cited Findings
**EU HTA 方法学指南(2024-03-08 通过)原文要点**([EU](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf)):
- 优先锚定;无锚定时用非随机证据方法。"STC and MAIC without a common comparator are highly problematic";只有聚合数据的非随机证据"no adequate method"。
- 常规 STC 在非恒等连接函数下混合条件与边际效应,"leading to bias for both estimands";边际化的做法"do not appear to have gained widespread adoption"。
- MAIC 只有在两试验人群充分重叠时才有效,且只给出聚合数据试验人群的结果。
- ML-NMR 可混合 IPD 和聚合数据,可估计任意目标人群,但需要每种治疗至少一个 IPD 研究、足够多的聚合研究、共享效应修饰因子假设或交互作用的信息先验;原文说"as currently proposed cannot be applied to time-to-event data"。
- 平移假设:只有效应大到不可能单由缺失修饰因子造成,才能明确下结论,可用"shifted null hypothesis"正式检验。

**EU 实践指南**([EU](https://health.ec.europa.eu/document/download/1f6b8a70-5ce0-404e-9066-120dc9a8df75_en?filename=hta_practical-guideline_direct-and-indirect-comparisons_en.pdf)):MAIC 要报告平衡(不用假设检验)、权重分布和 ESS,以及稳健 SE 或 bootstrap;平移假设要预设并说明幅度,决策阈值留给成员国;无锚定时要定量给出缺失预后变量可能带来的偏倚方向和幅度。

**EU 文本已被后续工作部分超越。** Phillippo 等的 ML-NMR 一般似然扩展支持生存结局,M 样条基线风险,用 multinma 实现(arXiv 2401.12640,2024;DOI 10.1093/jrsssa/qnaf169,期刊据 DOI 前缀推断为 JRSS-A)[摘要级,[arXiv](https://arxiv.org/abs/2401.12640);[布里斯托记录](https://research-information.bris.ac.uk/en/publications/multilevel-network-meta-regression-for-general-likelihoods-synthe/)]。

**MAIC 的批评与反批评。**
- Phillippo 等,Stat Med 2020;39(30):4885-4911:STC 和 ML-NMR 在假设成立时消除偏倚;MAIC 在几乎所有情景下表现差,有时比标准间接比较偏倚更大 [摘要级,[PMC8690023](https://pmc.ncbi.nlm.nih.gov/articles/PMC8690023/)]。
- Remiro-Azócar 等反驳:这种比较混淆了边际与条件效应,MAIC 的"偏倚"部分来自估计目标不一致 [摘要级,[arXiv 2011.06334](https://arxiv.org/pdf/2011.06334)];G-computation 在模型正确时 MSE 低于加权,尤其重叠差时 [摘要级,[arXiv 2108.12208 / PMC9790405](https://pmc.ncbi.nlm.nih.gov/articles/PMC9790405)]。
- 另一方偏向加权,认为 G-computation 的模型错误和隐性外推难以从数据验证 [摘要级,[arXiv 2305.08651](https://arxiv.org/pdf/2305.08651v1)]。两派没有定论。
- 实务:NICE 110 项检索、去除后 102 项中 40 项含人群调整法,MAIC 29 项(其中无锚定 26、锚定 3,数字读自版式错乱的海报);到 2024-05 NICE 肿瘤提交未使用 ML-NMR;评审批评集中于适用性、ESS、锚定臂可比性、缺失协变量、数据不成熟 [会议海报,作者属咨询公司,[Broadstreet HEOR 海报](https://www.ispor.org/docs/default-source/euro2024/isporeurope24lozano-ortegasa33poster143939-pdf.pdf?sfvrsn=ad11455e_0)]。另一海报(只含生存结局的 TA)称超过 80% 报告无锚定结果,其中 23 项含单臂试验,ML-NMR 大多用不上 [会议海报,作者属 OPEN Health,[ISPOR Europe 2024](https://www.ispor.org/docs/default-source/euro2024/solb124posterlb145372-pdf.pdf?sfvrsn=aff651a5_0)]。
- NICE DSU 的 TSD 18 仍是参考文件,未找到 2025 到 2026 的新 TSD [搜索一次,[DSU](https://sheffield.ac.uk/nice-dsu/tsds/population-adjusted)]。

| 方法 | 关键文献 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|---|
| STC(G-computation 形式) | [Remiro-Azócar 等,arXiv 2108.12208](https://arxiv.org/pdf/2108.12208),Res Synth Methods(年份未核) | 手写 `glm` + bootstrap + 现有 copula;[outstandR](https://cloud.r-project.org/web/packages/outstandR/index.html) GPL ≥ 3,2.0.0,2026-06-10 被 gsl 挡住且依赖 rstanarm | 手写无障碍 | 只有一方 IPD 时,除 MAIC 外的第二个估计,含效应修饰 | EU、TSD 18 都列入 | **现在加**:可作 MAIC 的对照估计 |
| 偏移零假设 | [EU 指南](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf) | 手写 | 无障碍 | "效应要多大才不怕未调整的修饰因子?" | EU 点名 | **现在加**,见 Q8 |
| ML-NMR | Phillippo 2020 JRSS-A 183(3):1189-1210(据 Broadstreet 海报的参考文献);2024 生存扩展(见上) | [multinma](https://cloud.r-project.org/web/packages/multinma/index.html) GPL-3,0.9.1,2026-04-16 | 被 gsl 挡(可钉归档);需 rstan;闭包 96/+21;本机编译失败,采样时间未知 | 多治疗网络、任意目标人群 | EU 认;NICE 肿瘤到 2024-05 未用 | **以后** |
| 增广 MAIC(双稳健) | Campbell & Remiro-Azócar 2025 [[预印本](https://arxiv.org/abs/2505.00113)] | 未见包;可用现有熵平衡 + `glm` 手写 | 无障碍 | MAIC 对结局模型错误更稳 | 尚无 | **以后**:等同行评议 |
| ML-UMR | Chandler & Ishak 2026 [[预印本](https://arxiv.org/abs/2606.20341)] | 无包 | 需 Stan | 无锚定网络 | 无,作者也强调假设难验证 | **不值得** |
| maicplus | [CRAN](https://cloud.r-project.org/web/packages/maicplus/index.html) Apache 2.0,0.1.2 | 引擎已对其 vignette 核对 | | | | 已作交叉核对,不重复 |

### Inferences
- 无锚定 MAIC 的处理方式应当是"照常给结果,同时给偏倚范围和'有全部 IPD 时应改用 PS'的说明",这与业主"裁决不扣交付"相容,也满足 EU 报告要求。
- EU 对 ML-NMR 生存结局的那句话已过时,引用时要带日期,否则会误判它不能处理生存。
- 肿瘤单臂场景大多是无锚定,而 ML-NMR 不适用于无锚定:这是把它放到"以后"的主要原因,不只是依赖重。

### Gaps
- Phillippo 2025 期刊版本的正文未读(eprints 下载超时),期刊名为推断。
- NICE 海报数字来自错乱版式,且是咨询公司作品,只覆盖到 2024-05;未找到更新的统计。
- 未搜到 2025 到 2026 年 NICE 对 ML-NMR 的明确立场。
- 中国药物经济学指南关于 MAIC 的要求:一次搜索无结果,未解决。

---

## Q6. Bayesian 借用:power prior、commensurate、SAM、elastic、PS 整合、test-then-pool 与 FDA 立场

### Takeaway
FDA 2026 草案把 power prior、commensurate、supervised power prior、mixture、层次模型、elastic 都列为可讨论的折扣方法,不推荐具体一种,且接受不校准 I 类错误的设计,条件是先验有充分依据。引擎现有的稳健 MAP 仍合适;值得补的是闭式 power prior、SAM、elastic,PS 整合版放到以后。

### Cited Findings
**FDA Bayesian 草案原文要点**([FDA](https://www.fda.gov/media/190505/download)):
- 明确讨论用外部或非同期对照增强随机对照(第 98 到 109 行),举 GBM AGILE、Precision Promise。
- 借外部信息推断主要估计目标的先验要有"strong justification",涵盖替代设计的可行性、信息相关性、先验影响、前瞻数据是否足够、运行特性。
- 系统识别全部相关外部信息;通常应来自患者层数据(第 526 行起)。
- 区分校准到 I 类错误的设计和不校准的设计;后者的结论强烈依赖先验,"it is critical that the prior be specified in a way that accurately and comprehensively reflects the external data"(第 245 到 248 行)。
- 折扣分静态和动态:power prior 静态,简单,但不能随冲突调整;commensurate 和 supervised power prior 是其动态扩展;mixture prior "simple";层次模型;elastic priors"flexible",但"may make it harder to justify a particular choice of function"(第 664 到 710 行)。
- 用 ESS 作为先验影响的度量(第 723 行起)。适用性"case-by-case",并非穷举。

**其他。**
- 2605.03282 综述 Table 4:power、commensurate、elastic、rMAP/SAM 只有整合 PS 才处理协变量偏移;Table 3 列 19 个 R 包([arXiv](https://arxiv.org/abs/2605.03282))。
- CDE 2026 第 6 号见前次笔记 comparators.md Q5,不重复。
- PS 整合方法在某些偏倚下 I 类错误和偏倚控制不佳 [单一模拟,摘要级,[JEBM 2025](https://journal.hep.com.cn/jebm/EN/10.1111/jebm.70022)];PS-SAM 用 PS 加 SAM [摘要级,[MD Anderson](https://mdanderson.elsevierpure.com/en/publications/ps-sam-propensity-score-integrated-self-adapting-mixture-prior-to/)]。
- test-then-pool:综述把它归为"selection consistency"类,点到 Viele、Li 2020 和 test-twice(Yi 2023)([arXiv](https://arxiv.org/abs/2605.03282));FDA 草案全文检索 "test-then-pool" 和 "pretest" 均无命中。

| 方法 | 关键文献 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|---|
| Power prior(固定折扣,闭式) | FDA 草案;[BayesPPD](https://cloud.r-project.org/web/packages/BayesPPD/index.html) GPL ≥ 3,1.1.3,2025-01-13;[NPP](https://cloud.r-project.org/web/packages/NPP/index.html) 0.7.0 | 正态、Beta 共轭手写;包做 CI 核对 | 无障碍 | "外部每人只算 0.3 人时结论如何?" | FDA 点名,CDE 也提 | **现在加** |
| SAM prior | Yang 2023 doi:10.1111/biom.13927([CRAN](https://cloud.r-project.org/web/packages/SAMprior/index.html)) | SAMprior GPL ≥ 3,3.0.0,2026-04-27,依赖 RBesT 和 rstan;权重公式可手写 | 无 V8 库下跑通;手写更轻 | 数据驱动而不是预设的混合权重 | FDA 未点名 SAM,但点 mixture;综述列入 | **现在加**(手写,接现有 robustify) |
| Elastic | Jiang、Nie、Yuan 2023(FDA 引) | 无稳定 CRAN 包;闭式可写 | 无障碍 | 冲突如何映射成借用程度 | FDA 点名,也提醒函数难辩护 | **现在加**,优先级低于前两项 |
| Commensurate | Hobbs 2011([psborrow2 CRAN](https://cloud.r-project.org/web/packages/psborrow2/index.html)) | [psborrow2](https://cloud.r-project.org/web/packages/psborrow2/index.html) Apache 2.0,0.0.5.1,2026-05-14,需 cmdstan | 运行时不合适:现场编译,容器只读 | 结局、协变量同时动态借用,含生存 | FDA 点名 | **psborrow2 不值得**;手写正态近似**以后** |
| PS 整合(psrwe) | [psrwe](https://cloud.r-project.org/web/packages/psrwe/index.html) GPL ≥ 3,3.2-2,2026-08-21 | 预编译 Stan,需 rstan 进运行时(无 V8) | 3 GiB 下跑通,采样 0.71 s | 单臂或混合设计 PS 分层后 power prior | 综述 Table 3 标为适合 SAT+EC | **以后** |
| hdbayes、beastt、NCC | [hdbayes](https://cloud.r-project.org/web/packages/hdbayes/index.html) 需 CmdStan;[beastt](https://cloud.r-project.org/web/packages/beastt/index.html) 闭包 99;[NCC](https://cloud.r-project.org/web/packages/NCC/index.html) MIT,1.0,2023-03-03,依赖 rjags、magick | 重 | 否 | NCC 针对平台试验非同期对照,不是 PS 方法 | | **不值得** |
| Test-then-pool | Viele 等(综述引) | 手写几行 | 无障碍 | 粗筛 | 综述列入;综述也说比较可能很嘈杂 | **以后**,只作敏感性分析 |

### Inferences
- 引擎 `map_prior` 已有正态-正态、混合、ESS、冲突度和混合设计运行特性。新增方法接在同一结果结构上,可以直接比较不同借用方式,这比增加依赖重要。
- 引擎"每个模拟数都有 Monte Carlo 误差"的规则,闭式方法自然满足;MCMC 路线要额外定义这一项。
- CDE 要求至少 10 万次模拟评估假阳性(前次笔记),rstan 路线在 600 CPU 秒内很难做到这种规模,闭式路线可以。

### Gaps
- Yang 2023、Jiang 2023、Viele 原文未打开。JEBM 2025 只读摘要。
- 未找到 SAM 与 psborrow2 的直接比较。
- FDA 草案是否对协变量偏移有专门段落:全文检索 "propensity" 无命中,但"相关性"段落未逐字读完。

---

## Q7. 重叠权重、修剪与阳性诊断

### Takeaway
重叠权重(ATO)引擎已经有,不要重复建议。真正缺的是修剪:EU 指南明确说修剪后结论只适用于修剪后的人群,而引擎目前只有截断敏感性分析。

### Cited Findings
- 引擎现状:`vcr_propensity_weights` 含 `ATO = ifelse(treat == 1L, 1 - ps, ps)`,domain snapshot 的 estimand 枚举有 ATT、ATE、ATO;`vcr_common_support` 输出重叠系数、处理组落在对照范围外的比例,`trim` 参数只用于诊断分位数;`comparator.aipw` 含 0.99 分位截断敏感性;`outside_common_support` 不可估规则(`项目代码/vcr-engine/R/weighting.R` 第 165、302 到 310 行,`aipw.R` 第 38、185、228 行)。全代码库检索未见按 PS 排除人再估计的修剪流程。
- EU:阳性、重叠和平衡"must be demonstrated before conclusions";"trimming" 后的平衡人群"is ultimately the target population",要详细描述并判断是否仍代表原问题;重叠不足时改用多元回归不是办法,那是外推([EU 6.2 节](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf))。
- NICE:目标人群在分析样本里代表不足时调整方法表现不佳([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects))。
- Liu、Li、Zhou、Matsouaka,预印本 2023、修订 2024-05;期刊信息 Stat Methods Med Res 2024;33(10):1689-1717 只来自搜索摘要,arXiv 页面未列:重叠加权 ATT,作为修剪和截断的替代,不需要预选阈值 [摘要级,[arXiv 2309.01334](https://arxiv.org/abs/2309.01334)]。Matsouaka 等比较 overlap、matching、entropy 权重 [摘要级,[arXiv 2210.12968](https://arxiv.org/abs/2210.12968v3)]。Liu 等 2025 教程配 R 包 ChiPS [预印本,摘要级,[arXiv 2511.10077](https://arxiv.org/abs/2511.10077)]。
- 没有找到任何监管文件给出阳性、修剪或 ESS 的数值阈值;前次笔记也如此。

| 方法 | 实现 | 限制 | 新问题 | 判定 |
|---|---|---|---|---|
| PS 修剪,并输出修剪后人群的基线和丢失比例 | 手写;[PSweight](https://cloud.r-project.org/web/packages/PSweight/index.html) GPL ≥ 2,2.1.2,2025-07-22 可作 CI 核对(闭包 52/+18,不进运行时) | 无障碍 | "去掉没有可比对象的人后,结果还成立吗?这些人是谁?" | **现在加** |
| ATO | 已有 | | | 不重复 |
| 重叠加权 ATT | 公式可手写 | 无障碍 | 外部对照保持接近 ATT 的目标,且不用设阈值 | **以后**:同行评议少,目标人群解释要谨慎 |

### Inferences
- 外部对照通常要 ATT,ATO 的目标人群已不再是试验人群,所以引擎不应把 ATO 当默认。修剪也一样会换人群,都要在结果里写明目标人群。
- 修剪阈值不应该成为门槛:按业主规则给标注,由模型向用户解释。

### Gaps
- Liu 2024 和教程的模拟数字未读。
- ChiPS 未查 CRAN 状态。

---

## Q8. E-value 之外的定量偏倚分析

### Takeaway
QBA 已被 FDA、NICE、TARGET 和 CDE 点名,有一项肿瘤实证显示它能进一步缩小与 RCT 的差距。引擎现在只有 E-value 和负对照。值得现在手写两档:基于偏倚参数的闭式和蒙特卡洛。`episensr` 因 V8 不能进运行时。邻近因果推断不值得。

### Cited Findings
- NICE 原文:QBA 可用于"examine the extent to which bias would have to be present to change results"或"estimate the direction, magnitude and uncertainty of bias";简单方法包括 e-value,更复杂的方法对偏倚建模;要预设合理偏倚水平;多个偏倚可能交互([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects));另一章引 Lash 2014([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/conduct-of-quantitative-real-world-evidence-studies))。
- FDA 外部对照草案:"quantitative or qualitative bias analyses"([FDA](https://www.fda.gov/media/164960/download))。TARGET 7h(ii) 和 CDE 2020 第 1 号也提及(前次笔记)。EMA 2025 文件未出现 "bias analysis"(全文检索),但要求敏感性分析预设且回答同一问题([EMA](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf))。
- 实证:Gupta 等 JAMA Netw Open 2025,晚期 NSCLC,与 RCT 对照臂的平均 log HR 差 0.247 → 0.139(测得混杂调整)→ 0.098(再做 QBA)([记录](https://pure.eur.nl/en/publications/quantitative-bias-analysis-for-single-arm-trials-with-external-co/),前次笔记已读页面摘要,试验数 14 与 15 不一致)。
- 外部对照综述:偏倚尺度的 tipping point 定义为使区间覆盖 0 的最小 |δ|([arXiv 2605.03282](https://arxiv.org/abs/2605.03282))。
- 邻近因果推断:Song 等 2026 在 HIV 预防外部对照中用 STI 和地区作负对照结局和暴露 [预印本,摘要级,[arXiv 2603.04544](https://arxiv.org/abs/2603.04544)];构造既有效又强的负对照很难,排除条件不可从数据检验 [摘要级,搜索摘要未能对应到具体页面;[Sentinel 讲稿](https://sentinelinitiative.org/sites/default/files/documents/AddressingUnmeasuredConfoundinginObservationalStudiesInsights_0.pdf)的 PDF 提取不出文字,未核对]。CRAN 上查不到 `proximalCI`(404)。

| 方法 | 关键文献 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|---|
| 偏倚平移 / 偏倚尺度 tipping point | EU 指南;2605.03282 §3.6 | 手写;估计值和 SE 即可,适用于所有比较方法 | 无障碍 | "未测混杂要造成多大的 HR 偏移,结论才翻转?" | EU 点名 | **现在加**,最便宜 |
| tipr 式闭式 | [tipr](https://cloud.r-project.org/web/packages/tipr/index.html) MIT,1.0.2,2024-02-06 | 手写或进运行时(闭包 12,+1) | 2.3 s | "未测混杂需要多不均衡、多强?"(含 HR 尺度 `tip_hr`) | 无专门监管引用 | **现在加** |
| 概率型 QBA | Fox、MacLehose、Lash 2021([episensr CRAN](https://cloud.r-project.org/web/packages/episensr/index.html));Lash 2014(NICE 引) | 蒙特卡洛手写;[episensr](https://cloud.r-project.org/web/packages/episensr/index.html) GPL-2,2.2.0,2026-08-28 只做 CI | episensr 3 GiB 下崩溃(V8);手写无障碍 | "给定偏倚参数的合理分布,调整后的效应和区间是多少?" | NICE、FDA、Gupta 2025 | **现在加**,手写;MC 误差按引擎规则报告 |
| sensemakr | Cinelli & Hazlett 2020([CRAN](https://cloud.r-project.org/web/packages/sensemakr/index.html)),GPL-3,0.1.6,2024-07-22 | 零依赖 | 2.3 s(含 tipr);只针对 `lm` | 连续结局以观测协变量为基准 | 未见监管引用 | **以后**:对引擎的加权和 Cox 主路线用处有限 |
| 邻近因果推断 | Song 2026 等 | 无成熟 CRAN 包 | 需要有效的双重负对照 | | 预印本 | **不值得** |

### Inferences
- E-value 保留。新增的 QBA 要让用户或模型给出偏倚参数,模型读文献给先验范围、代码做计算,这符合"模型不做统计"。
- 引擎 `comparator.negative_control` 的单个负对照结局可以为 QBA 提供经验偏倚范围,但这是我的推断,没有找到直接文献。

### Gaps
- Gupta 2025 原文未读。
- tipr 的 JOSS 论文未打开;`tip_hr` 的稀有事件近似条件未核实。
- `sensemakr` 对加权回归的适用性未测。

---

## Q9. 网络 Meta 分析、剂量反应 Meta 分析和 IPD Meta 分析

### Takeaway
`evidence.pool` 只做两两随机效应合并,这是 JCA 基本要求之外的明显缺口。netmeta 和 dosresmeta 都能在限制内快速运行,值得现在加。Bayesian NMA 依赖 JAGS 或 Stan,不值得现在引入。

### Cited Findings
- EU 方法学指南:5.1 节 Bucher,5.2 节 NMA,分频率学(5.2.1)和 Bayesian(5.2.2)两节,"Both frequentist and Bayesian approaches may be used"([EU](https://health.ec.europa.eu/document/download/4ec8288e-6d15-49c5-a490-d8ad7748578f_en?filename=hta_methodological-guideline_direct-indirect-comparisons_en.pdf));实践指南 3.2 节用相似性、同质性、一致性评估可交换性([EU](https://health.ec.europa.eu/document/download/1f6b8a70-5ce0-404e-9066-120dc9a8df75_en?filename=hta_practical-guideline_direct-and-indirect-comparisons_en.pdf))。
- 引擎现状:`evidence.pool` 为 DL、REML、HKSJ 加预测区间(README 第 180 行);Bucher 只见于 MAIC 的锚定路线(第 189 行),没有独立的网络方法。
- [netmeta](https://cloud.r-project.org/web/packages/netmeta/index.html):Balduzzi 2023 JSS、Rücker 2012;GPL-2 或 GPL-3 + file LICENSE,3.7-0,2026-09-17;不需编译,但闭包经 igraph 需系统库 libglpk(本机缺失时加载失败,已验证)。
- [dosresmeta](https://cloud.r-project.org/web/packages/dosresmeta/index.html):GPL-2,2.2.0,2025-04-19,只依赖 mixmeta;支持摘要数据的多元随机效应剂量反应。
- 实务:NICE 回顾说标准 NMA 很常用,但需要效应修饰因子无重要差异 [海报,[Broadstreet](https://www.ispor.org/docs/default-source/euro2024/isporeurope24lozano-ortegasa33poster143939-pdf.pdf?sfvrsn=ad11455e_0)]。

| 方法 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|
| 频率学 NMA | netmeta | 6.0 s(含 dosresmeta),366 MB;闭包 70/+21,需 libglpk | "多个药物之间互相比较如何?一致性如何?排序如何?" | EU 点名 | **现在加** |
| 剂量反应 Meta | dosresmeta | 闭包 1/+1,无编译 | "多大剂量开始有效,是否非线性?" | 未查到 HTA 专门要求 | **现在加**:成本几乎为零 |
| Bayesian NMA | [gemtc](https://cloud.r-project.org/web/packages/gemtc/index.html)、[pcnetmeta](https://cloud.r-project.org/web/packages/pcnetmeta/index.html)、[crossnma](https://cloud.r-project.org/web/packages/crossnma/index.html) 依赖 rjags;multinma 见 Q5 | 引擎无 JAGS | 与频率学多有重合 | EU 接受 | **不值得**(JAGS 路线);以后走 multinma |
| IPD Meta | 两阶段用现有 `evidence.pool`;一阶段需混合模型;[ipdmeta](https://cloud.r-project.org/web/packages/ipdmeta/index.html) 已从 CRAN 移除 | 两阶段无障碍 | 试验内交互作用的合并 | EU 实践指南:全 IPD 时不应用 MAIC、STC,"IPD network meta-regression is generally the appropriate method" | **以后** |

### Inferences
- 与 ML-NMR 不同,netmeta 只需要已发表的效应,大多数用户手上就有,这一项的受众比 ML-NMR 广得多。
- 上游成熟,按"先用上游"的业主规则直接用,而不是手写;手写也可以但图论和一致性检验不值得复制。

### Gaps
- netmeta 的 `file LICENSE` 未读。
- netmeta 从源码编译依赖(igraph)的镜像构建时长未测。
- dosresmeta 的关键文献(Crippa & Orsini 2016)未打开。HTA 对剂量反应 Meta 的要求没有找到。

---

## Q10. 生存外推:flexsurv 样条、survHE、治愈和混合治愈模型、NICE TSD 21

### Takeaway
样条值得现在加,flexsurv 已在 CI 库,运行时只需移入。治愈模型风险高,以后再说。survHE 被 `rms` 挡住且只是封装,不值得。

### Cited Findings
- NICE DSU TSD 21,2020 年 1 月:灵活方法包括样条、分数多项式、强制治愈比例和混合模型,已在 NICE TA 中使用;未找到 2024 到 2025 的更新 [摘要级,[TSD 21](https://sheffield.ac.uk/media/34188/download)]。
- 治愈模型:TSD 21 评论说,相对于纳入背景死亡的灵活参数模型,治愈模型优势不大,"cure" 不合理时表现差 [二手,[Healthcare Economist](https://www.healthcare-economist.com/2024/08/05/should-we-extrapolate-survival-using-cure-models/)];2024 PharmacoEconomics 教程称,无治愈或随访很短时可显著高估,治愈真实且随访成熟时外推不错 [摘要级,[Springer](https://link.springer.com/doi/10.1007/s40273-024-01406-7);页面需登录,未读全文]。
- 实务:一项 ISPOR 摘要称 3 项纳入治愈比例的 TA 全被否决 [摘要级,数量很小,[ISPOR 2022](https://www.ispor.org/heor-resources/presentations-database/presentation/intl2022-3463/114609)];84 项 NICE 肿瘤评估多数遵循 TSD 14 和 21 [摘要级,[ISPOR 2023](https://www.ispor.org/heor-resources/presentations-database/presentation/euro2023-3788/132607)]。NICE 评审批评包括外推模型选择和数据不成熟 [海报,见 Q5]。
- 引擎现状:`model.survival_fit` 只有 exponential、Weibull、lognormal、loglogistic(`项目代码/vcr-engine/R/model_survival.R`);只有前两者能接到设计和模拟(README 第 726 行)。
- 外部数据外推:[survextrap](https://cloud.r-project.org/web/packages/survextrap/index.html) 用 M 样条结合个体数据和外部计数;一项 2025 预印本评估了结合真实世界数据的外推 [摘要级,[arXiv 2505.16835](https://arxiv.org/pdf/2505.16835)]。

| 方法 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|
| Royston-Parmar 样条 | [flexsurv](https://cloud.r-project.org/web/packages/flexsurv/index.html) GPL ≥ 2,2.3.2,2024-08-17 | 2.5 s(含治愈);278 MB;已在 CI 库,闭包约 50,含 rstpm2 编译 | "风险曲线不单调时,长期生存和 RMST 是多少?" | TSD 21 | **现在加** |
| 混合治愈 | [flexsurvcure](https://cloud.r-project.org/web/packages/flexsurvcure/index.html) GPL ≥ 2,1.3.3,2025-02-15 | 同上,闭包 +0 | "多少人长期存活?" | TSD 21 谨慎 | **以后**:加时必须附成熟度和背景死亡说明 |
| survHE | [CRAN](https://cloud.r-project.org/web/packages/survHE/index.html) GPL ≥ 3,2.0.51 | **被 rms 挡住**;还依赖 xlsx | 封装 | HTA 圈常用 | **不值得** |
| survextrap | GPL ≥ 3,1.0.1,2026-01-13 | 需 rstan,无 V8 | 用登记数据稳定长期尾部 | 预印本 | **以后** |
| cuRe | [CRAN](https://cloud.r-project.org/web/packages/cuRe/index.html) GPL ≥ 2,1.1.1,2023-07-03 | 被 rms 挡住,闭包 117 | | | **不值得** |

### Inferences
- 这一项对"对照研究"是次要的,主要受益的是虚拟试验和经济学用途。排在现在加的最后是合理的。
- 样条上线后,外推不确定性要用设定之间的范围表达,不能只给单一曲线。这是我的判断,TSD 21 的具体要求未读全文。

### Gaps
- TSD 21 原文这次下载不到有效 PDF(返回 HTML),以上来自搜索摘要;Latimer 教程作者与全文未核实。
- 未查是否有 2026 年更新的 NICE 生存 TSD;只搜索一次。

---

## Q11. 时变混杂:g-methods、g-formula、MSM

### Takeaway
NICE 明说时变混杂应优先用 g-methods,包括 MSM 加权。但这要求高质量纵向数据,而引擎目前没有人-时间输入。TTE 的 PP 分析已经包含 MSM 权重,所以先做 TTE,g-formula 放到以后。

### Cited Findings
- NICE:"G-methods including marginal structural models with weighting are preferred",且需要整个随访期的高质量数据;除非使用恰当方法,时变混杂应记录在索引日期之前([NICE](https://www.nice.org.uk/corporate/ecd9/chapter/methods-for-real-world-studies-of-comparative-effects))。
- TrialEmulation 提供处理和删失的逆概率权重及 MSM,估计 ITT 和 PP 的边际风险差 [摘要级,[arXiv 2402.12083](https://arxiv.org/abs/2402.12083)]。
- 前次笔记:Hernán 2016 指出 PP 要用 g-methods。FDA 2023 外部对照草案全文检索 "g-method"、"g-formula"、"marginal structural"、"time-varying" 均无命中。

| 方法 | 实现 | R 4.3.3 与限制 | 新问题 | 判定 |
|---|---|---|---|---|
| MSM + IPTW | [ipw](https://cloud.r-project.org/web/packages/ipw/index.html) MIT,1.3.2,2026-11-01(快照 1.3.0);或 TrialEmulation 内含 | 闭包 27/+2;手写用 `glm` 也可 | 时变治疗和混杂下的策略效应 | **以后**,先经 TTE 的 PP 路线获得 |
| g-formula | [gfoRmula](https://cloud.r-project.org/web/packages/gfoRmula/index.html) GPL-3,1.1.1,2025-03-24;Robins 1986 | 2,500 人 20 次 bootstrap 42.7 s、310 MB,线性外推 500 次约 1000 s,超默认 600 CPU 秒但在 3600 内(推断);闭包 87/+35,路径上有 Deriv(R ≥ 4.5) | "如果所有人都一直用药 vs 一直不用,风险如何?" | **以后** |
| LTMLE、lmtp | 见 Q4 | 见 Q4 | 带 ML 的纵向估计 | **以后** |

### Inferences
- g-formula 需要为每个时变协变量建模,模型选择面很广。这正是模型可以读语言、代码做计算的地方,但这要求用户有足够好的纵向数据。考虑到本产品的用户多为上传基线表或公开数据的 to-C 用户,时变方法的受众比 TTE 和 NMA 窄。这是推断,没有产品数据支持。

### Gaps
- 未测 gfoRmula 的源码安装(Deriv 阻塞)。
- 未查到 HTA 对 g-formula 的使用统计。
- 未核实数据平面是否支持纵向协变量。

---

## Q12. 缺失数据:多重插补、参照基础插补、估计目标策略

### Takeaway
MHRA 明确说剔除缺失者可能引入偏倚,NICE 评审也批评缺失协变量。引擎有针对缺失结局的 tipping point,但没有看到协变量多重插补。mice 值得现在加;rbmi 针对连续纵向终点,以后再说。

### Cited Findings
- MHRA 草案第 50 条:广泛缺失可能使外部对照不可用;"Missing data imputation should be performed in alignment with the chosen estimand(s). Exclusion of participants with missing data from the ECA is likely to introduce bias"([MHRA](https://assets.publishing.service.gov.uk/media/6825bab1a4c1a40fde4e63e5/Draft_MHRA_Guideline_on_Studies_with_RWD_ECA_May2025.pdf))。
- FDA 外部对照草案:要有缺失数据策略和敏感性分析(前次笔记 Q2)。EMA:主要分析可以与估计目标框架对齐,包括缺失数据处理和敏感性分析([EMA](https://www.ema.europa.eu/system/files/documents/other/rwe-reflection-paper-en.pdf))。
- NICE 评审批评"缺失协变量削弱估计可靠性" [海报,[Broadstreet](https://www.ispor.org/docs/default-source/euro2024/isporeurope24lozano-ortegasa33poster143939-pdf.pdf?sfvrsn=ad11455e_0)]。
- FoCR 多伙伴试点:HR 分歧随缺失增加而增大 [海报,前次笔记 Q2]。
- rbmi:Gower-Page 2022 JOSS,Wolbers 2022 Pharm Stat,Carpenter 2013;针对连续纵向终点,支持标准和参照基础 MI([CRAN](https://cloud.r-project.org/web/packages/rbmi/index.html));文档说,缺失结局若与伴发事件无关,常可在 MAR 下用 MMRM 插补,参照基础用于处理如停药这类伴发事件 [摘要级,[rbmi 规格](https://cran.r-universe.dev/rbmi/doc/stat_specs.html)]。

| 方法 | 实现 | R 4.3.3 与限制 | 新问题 | 证据 | 判定 |
|---|---|---|---|---|---|
| 协变量多重插补,全流程配 Rubin | [mice](https://cloud.r-project.org/web/packages/mice/index.html) GPL ≥ 2,3.19.0,2025-12-10 | n=2000、m=20 用 4.3 s、261 MB;闭包 61/+25,14 个需编译(含 glmnet 等);bootstrap 嵌套要控制总 CPU | "协变量有缺失时,不剔除的结果是否一致?" | MHRA、FDA | **现在加** |
| 参照基础 MI | [rbmi](https://cloud.r-project.org/web/packages/rbmi/index.html) Apache ≥ 2,1.7.0,2026-10-15(快照 1.6.1) | 172 人 jackknife 29.1 s、300 MB;闭包 47/+11,含 TMB | "停药者按对照臂走势时效应如何?"(jump-to-reference) | 与 ICH E9(R1) 对齐;未找到监管对 rbmi 的直接评价 | **以后**:是随机试验语境,对现有对照路线增量有限 |
| MatchThem | [CRAN](https://cloud.r-project.org/web/packages/MatchThem/index.html) GPL ≥ 2,1.2.1,2024-04-02 | 闭包 83/+29 | 插补后匹配或加权 | | **不值得**:手写嵌套就够 |

### Inferences
- 按"模型不做统计",插补模型的变量选择可以由模型提议,计算由代码执行。
- 插补和现有"全流程 stratified bootstrap"结合时,CPU 成本是相乘的,需要选定 MI-then-bootstrap 或 bootstrap-then-MI,按 CPU 预算限制。文献上的正确嵌套顺序这次没有查。
- `patients.longitudinal` 目前只模拟 MCAR 单调脱落(context 文件)。rbmi 加入之前,可以先把 MAR、MNAR 脱落机制加入模拟器,这是单独的事。

### Gaps
- 未核实引擎比较方法如何处理协变量缺失:`weighting.R`、`aipw.R`、`inputs.R` 中 `complete.cases` 等检索未命中,README 也未写。可能在别处拒绝或沿用已有规则,加之前要先读代码。
- MI 与加权、bootstrap 的嵌套规范未调研。
- rbmi 没有查到 FDA 或 EMA 的直接立场。
