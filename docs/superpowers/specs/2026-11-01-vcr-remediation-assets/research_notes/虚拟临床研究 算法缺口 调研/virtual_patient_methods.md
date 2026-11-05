# 虚拟患者、数字孪生与合成临床数据的新方法（2022 至 2026-11）：对照 EviMed 引擎现状

调研日期 2026-11-02。引擎现状读自分支 `codex/vcr-remediation-20261101`（cde64eddc）的 `项目代码/vcr-engine/R/quality.R`、`population.R`、`engine.R`。不重复 `论文流程 整改方案/virtual_patients.md` 已写的内容（QSP Vpop 流程、Azizi/El Emam、DT-GPT、TwinWeaver、Delphi-2M、Bisbee、TRIPOD+AI 细节、FDA 2023/2025 与 ICH M15 的条文）；需要时只引用其结论并写明"见前作"。

阅读标记：[FT] 读了全文（部分经 pdftotext 或抓取工具摘要）；[AB] 只读摘要或落地页；[SNIP] 只见搜索摘要，未打开，当线索看；[VEN] 作者或发布方是产品厂商；[单一来源] 只有一处来源；[本机实测] 我在本机跑的，非文献。包版本来自 [2026-09-28 快照的 PACKAGES](https://packagemanager.posit.co/cran/2026-09-28/src/contrib/PACKAGES.gz)、CRAN 页面、PyPI JSON 和 GitHub API（均未发送任何身份信息）。

## 总判定：哪些值得加，哪些不值得

### Takeaway
在四核共享、无 GPU、以 R 为主的引擎上，最值得做的三件事都不是新的生成模型：补齐 `population.quality` 的推断校准与逐记录隐私测量，新增"从用户自有历史 IPD 训练预后分"把 `design.procova` 和 `comparator.prognostic_adjustment` 的链路接通，以及用已发表参数做一两个疾病进展模拟器。深度生成模型在临床表格数据上没有被证明优于 synthpop，且推断有效性和隐私更差或未测，不值得进运行时。

### Cited Findings
候选总表（证据和细节在后面各节）。"新增包"指相对本机 `~/R/vcr-4.3` 库、按 2026-09-28 快照递归计算的依赖数（闭包里本库没有的包），是我算的；本机库包含 CI 用包，比运行时库大，运行时实际增量可能更多。

| 候选 | 关键论文 | 最佳开源实现（许可，最新发布） | 语言 | 四核 CPU | 用户新增能回答的问题 | 独立证据 | 判定 |
|---|---|---|---|---|---|---|---|
| quality 扩展：Cox/RMST 复现、m 份合并推断、零假设下 I 类错误、逐记录 MIA、属性推断 | Decruyenaere 2024；Chassat 2025；Yao 2025 | 手写 R（无新依赖）；可在 CI 对照 anonymeter（Clear BSD，1.1.0，2026-07） | R | 可行：synthpop 每份约 0.2 至 1 秒 [本机实测] | "这份合成数据跑我的 HR，假阳性率是多少？哪些人最容易被认出来？" | 多个独立组 | **现在加** |
| `model.prognostic_train`：历史 IPD 训练预后分（lm/Cox 加样条，ranger 作对照），交叉拟合，校准 | Schuler（arXiv 2012.09935）；EMA 2022；Burk 2024/26 | 手写 R，已有 survival、ranger；CI 可对照 `postcard`（MIT，1.1.0，2025-09，闭包 103 个、新增 43 个，不宜进运行时） | R | 可行（推断，未测大样本） | "我有历史对照数据，预后分在我的人群里 R 是多少，保守地能省多少样本？" | PROCOVA 增益主要是厂商数字，见第 3 节 | **现在加** |
| 已发表参数的疾病进展模拟（先 AD：CDR-SB、ADAS-Cog） | Jamalian 2023；Romero 2015；EMA 2013 | 无现成开放实现；手写 R 按论文方程，CI 用 `mrgsolve`（GPL ≥2，2.0.1，2026-05，新增 1 个）交叉核对 | R | 可行（只模拟，不估计；推断） | "在这个入组标准下，安慰剂组 18 个月进展多少？减缓 25% 时功效多少？" | 外部验证有，但个体 R²=0.16 | **现在加（限人群层面、限一两个病）** |
| `pmrm` 进展模型（重复测量，连续时间非线性混合效应） | CRAN 描述；论文未读 | `pmrm`（MIT，0.0.4，2026-04-03；新增 3 个：TMB、RTMB 需编译） | R | 未测 | "药效表述为进展减缓比例时估计多少？" | 未找到 | 以后 |
| ARF | Watson 2023 AISTATS | `arf`（GPL ≥3，0.2.5，2026-09-21；新增 3 个，纯 R）；`arfpy`（MIT，0.1.1，2023-09） | R | 很快，6524 行 5.5 秒，单线程 [本机实测] | "按年龄>65 条件生成"，无需变量顺序 | 未找到临床独立证据 | 以后（低优先；效用没赢） |
| CATE：causal forest | Athey 系列；Venkatasubramaniam 2023 | `grf`（GPL-3，2.6.1，2026-03-04；新增 3 个，需 C++17 编译） | R | 可行（推断，未测） | "RCT 数据里谁获益更多？" | 独立研究显示校准差于正则回归 | 以后（先做回归效应模型） |
| 差分隐私：AIM、MST | McKenna 系列；dpmm 2025 | `dpmm`（Apache-2.0，0.1.9，2025-08）；`smartnoise-synth`（MIT，1.0.8，2026-04） | Python，放一次性容器 | 可行（低维；SynMeter 中 MST 影子模型耗时 0.10 小时，A100 集群上） | "我要把合成数据发出去，形式化隐私上限是多少？" | 少数非同口径研究 | 以后（用户要外发时） |
| Forest-Flow | Jolicoeur-Martineau 2024 AISTATS | `ForestDiffusion`（PyPI 1.0.6，2024-06；GitHub 已归档，**未找到许可文件**，见第 1 节） | Python；仓库含 R 包，不在 CRAN | 作者称笔记本 4 至 12 核可跑，内存随 `n_noise` 倍增 | 同 synthpop | 单个小样本临床比较 | 不值得（已归档且无许可） |
| CTGAN、TVAE | Xu 2019 | **SDV 为 BSL 1.1，禁止用于 Synthetic Data Service**；`ctgan` 的 GitHub 许可也是 NOASSERTION；synthcity 带插件（Apache-2.0，0.2.12，2025-05） | Python，torch | 小样本能跑（未测），闭包大 | 无 | 对其不利 | 不值得 |
| TabDDPM、TabSyn | Kotelnikov 2023；Zhang 2024 | `tab-ddpm`（MIT，最后推送 2024-07）；`tabsyn`（Apache-2.0，最后推送 2024-07） | Python，torch | 文献都用 GPU；CPU 未见测量 | 无 | 保真好，隐私最差（TabDDPM） | 不值得 |
| SurvivalGAN、HI-VAE 生存 | Norcliffe 2023；Chassat 2025 | synthcity 含 survival_gan（未逐项核实）；`survgen-clinical-trials`（未核实许可） | Python | 同上 | 无 | I 类错误全部膨胀 | 不值得（借用其评价方法） |
| HALO、TrialSynth、TWIN-GPT 等 | Theodorou 2023；arXiv 2409.07089；arXiv 2404.01273 | 见第 2 节 | Python，GPU 或外部 API | 不可行 | 无 | 只有作者自评 | 不值得 |
| CRBM/NBM 孪生生成器 | Bertolini 2020；Lang 2023 | 厂商博客称 NBM 代码公开（未核实许可） | Python | 不可行且数据拿不到 | 同预后分 | 只有厂商 | 不值得（复现预后分即可） |
| nlmixr2 进运行时 | Fidler 2019 | `nlmixr2`（GPL ≥3，7.0.1，2026-08-05；闭包 140，新增 67） | R | 估计耗时未测 | "用我的纵向 IPD 拟合 NLME" | 成熟 | 以后（闭包太大，先不估计只模拟） |
| QSP | 见前作 | 未再调研 | — | 模型逐病定制 | — | 多为厂商 | 不值得（现阶段） |
| DeepSurv | Katzman 2018 | `pycox`（BSD，0.3.0，2024-09） | Python | 可行 | 无 | 见第 5 节 | 不值得 |
| 生存 ML（RSF、aorsf、LightGBM） | Burk 2024/26 | `ranger` 已在闭包；`aorsf`（MIT，0.1.6，2025-12，新增 2）；`randomForestSRC`（GPL ≥3，快照 3.9.0）；`lightgbm`（MIT，4.7.0，2026-07-18） | R | 可行 | 模型比较 | Cox 未被显著超过 | 只留 ranger 作对照；其余不值得 |

表中 Xu 2019（CTGAN/TVAE）、Kotelnikov 2023（TabDDPM）、Katzman 2018（DeepSurv）、Fidler 2019（nlmixr2）、McKenna（AIM/MST）、Athey（grf）这些归属来自我的已有知识，本轮没有打开这些论文，引用前应核对。

### Inferences
- 排序理由：引擎缺的不是"生成更多样的假病人"，而是"告诉用户这批假病人能不能回答他的问题"和"把预后模型的上游补上"。这两项无新依赖，也符合 owner 的"成熟上游优先、最窄适配"。
- 疾病进展模拟有真实缺口（上下文列明无疾病模型），但现有三个知识包是 NSCLC、乳腺癌、T2D，而我核实到证据最好的开放模型在 AD。先做哪个病应看用户实际在跑什么。

### Gaps
- 肿瘤（TGI-OS 联合模型）和 T2D（HbA1c 进展）的开放已发表模型本轮**没有调研**，不能断言有无可用参数。这正好是三个知识包的方向，应单独查。

## 深度生成表格模型真的赢过 synthpop CART 吗

### Takeaway
没有证据显示赢。唯一把 synthpop 和深度模型放在同一临床数据上比的独立研究（Winzell 2026）里 synthpop 效用最高、CTGAN 明显差，但 synthpop 隐私分最低。主流 ML 大基准（SynMeter、Forest-Flow、RKI）**根本没纳入 synthpop**，所以"扩散模型最好"的结论并未与 CART 对决过。我本机在三个真实生存数据上的小测里，ARF 与 synthpop 打平。

### Cited Findings
**同台比较 synthpop 的研究**
- Winzell et al. 2026，ADNI（n=2,430，18 变量）和 A4（n=4,492，23 变量），80/20 拆分，SynthEval 评价。平均效用分 synthpop 0.770（ADNI）、0.806（A4），为最高；平均隐私分 0.759、0.769，为最低；ε-identifiability 52.6%、42.3%，MIA recall 0.625 至 0.672。SVM 下游 AUC（真实 / synthpop / CTGAN）：ADNI 诊断 0.869 / 0.863 / 0.798；ADNI Aβ+ 0.868 / 0.868 / 0.764；A4 Aβ+ 0.947 / 0.942 / 0.880。TabPFN 把 A4 的 Aβ+ 比例生成为 94.4%（真实 30.0%）。168 个组合中只有 7 个不显著差于真实。作者局限：只测少数方法，无纵向，CTGAN 等需先插补，且未含 TVAE、TabDDPM。部分作者披露了与 Biogen、Lilly、Owkin 等的关系（一位是 Lilly 雇员）— [FT 经抓取摘要](https://pmc.ncbi.nlm.nih.gov/articles/PMC13457355/)
- Decruyenaere et al., UAI 2024：n=50 至 5000 模拟加 Adult 案例。95% CI 覆盖率（naive / 修正）：均值 synthpop 83.5% / 95.0%，默认 CTGAN 12.18% / 13.20%；回归系数 synthpop 70.5% / 87.0%，CTGAN 59.39% / 77.16%。修正因子 √(1+m/n)。SE 收敛指数 synthpop 0.46 至 0.59（接近 √n），CTGAN 0.19 至 0.51。作者结论：要做推断就"advise to use a parametric generation method"。注意这里的 Synthpop 用的是默认参数法配置，不等于 CART，见原文 — [FT](https://arxiv.org/html/2312.07837v2)；另见同文 [Methods Inf Med 短评](https://www.thieme-connect.com/products/ejournals/pdf/10.1055/a-2540-8284.pdf) [SNIP]
- Miletic & Sariyar, JMIR AI 2025：模拟研究称 copula 和 synthpop 在不同样本量和相关复杂度下一致优于深度方法，synthpop 最好，但会损失类别变量信息；同组 2024 Applied Sciences 称深度方法 pMSE 可以更好但 ε-identifiability 更高 — [SNIP，原文 403 未打开](https://www.sciencedirect.com/org/science/article/pii/S281717052500016X)；[ResearchGate 记录](https://www.researchgate.net/publication/382122243_Challenges_of_Using_Synthetic_Data_Generation_Methods_for_Tabular_Microdata)

**不含 synthpop 的基准**
- Du & Li, "Systematic Assessment of Tabular Data Synthesis"（SynMeter），CCS 2025：12 个数据集，无医学数据，无 CART/ARF（可见文本内）。结论原话："Diffusion models are surprisingly good"、"Statistical methods are still competitive synthesizers"、"CTGAN is not an effective tabular data synthesizer"。这里的"统计方法"指 PrivSyn、MST。Adult 上保真 TabDDPM 0.020、TabSyn 0.025、CTGAN 0.059、PrivSyn 0.024；硬件 A100 — [FT 前 10 万字符](https://arxiv.org/html/2402.06806v3)
- Forest-Flow（Jolicoeur-Martineau et al., AISTATS 2024）：27 个 UCI/sklearn 数据集，9 指标。Forest-Flow 平均秩 W_test 1.4、Pbias 2.5、覆盖率 2.5；TabDDPM 3.4、2.7、1.4；TVAE 4.1、6.5、6.0。比较集含 GaussianCopula、TVAE、CTGAN、CTAB-GAN+、STaSy、TabDDPM，无 synthpop，无 ARF（可见文本）。称 4 至 12 核笔记本可跑，但数据复制 `n_noise` 倍（默认 100，内存不够时 50），内存可能高于深度方法。作者自评，未见独立复现 — [FT 前 10 万字符](https://arxiv.org/html/2309.09968v3)
- Escudié et al.（RKI、BIH）2026：含 100 万行癌症流行病数据；TVAE、CTGAN、PGM、PrivSyn、TabDDPM、TableDiffusion、GReaT；无 CART；隐私和效用**未评估**，ε=1e8 等于没有隐私；HPO 让 TabDDPM 的 MAE2 改善约 98%（0.0891 到 0.0019）；GPU H100/A100/L40s，预算 5 至 10 小时 — [FT 经抓取摘要](https://arxiv.org/html/2604.15961v1)
- Bonazzi et al.（博洛尼亚大学，IEEE 处理稿；PDF 托管在 Aindo 网站，作者不属该公司）：ADNI 血液化验 541 人 13 列，无 synthpop。Wasserstein Forest Diffusion 1.05、TVAE 1.08、CTAB-GAN 1.12、TabDDPM 1.16、CTGAN 1.56；隐私（singling-out/linkability/inference）TabDDPM 13/30/49，CTGAN 8/2/19，TVAE 10/2/22，Forest Diffusion 11/6/31；耗时 TVAE 35.9 秒、TabDDPM 51 秒、STaSy 323 秒（RTX 6000 Ada GPU）。作者称 CTGAN 低风险可能只是保真差 — [FT 经 pdftotext](https://www.aindo.com/docs/publications/83_Benchmarking_Tabular_Generative_Models_for_Clinic.pdf)
- TabSyn（Zhang et al., ICLR 2024）自报列分布误差降 86%、成对相关误差降 67%（相对最强基线）— [AB，作者自评](https://arxiv.org/abs/2310.09656)。SynMeter 在 Adult 上 TabSyn 保真 0.025，TabDDPM 0.020，并未领先（见上）。
- Synthcity（Qian et al., NeurIPS 2023 D&B）是基准框架，不是结论 — [AB](https://papers.nips.cc/paper_files/paper/2023/hash/09723c9f291f6056fd1885081859c186-Abstract-Datasets_and_Benchmarks.html)。
- ARF（Watson et al., AISTATS 2023）作者称与深度模型相当或更好，平均快约两个数量级 — [AB](https://arxiv.org/pdf/2205.09435)，作者自评。

**本机实测（非文献；脚本在 `/tmp/vp-bench/bench.R`，临时文件，不入库）**
设置：R 4.3.3，本机 4 核 6 GB（他人进程同时在跑），`synthpop` 1.9-3 的 `method="cart"` 默认参数（**未用引擎的 `smoothing="density"`**），`arf` 0.2.5 默认 10 棵树、`parallel=FALSE`。每数据集 10 次 80/20 拆分，每次 1 份合成，指标用引擎 `quality.R` 自己的 `vcr_utility_propensity` 和 `vcr_disclosure_report`，Cox 系数 CI 重叠对训练集拟合计算。两个对照用来证明指标有检出能力：`bootstrap`（直接重抽训练行，应被隐私指标抓住）和 `independent`（各列独立打乱，应被结构指标抓住）。

| 数据（训练 n×p） | 生成器 | 秒/份 | sPMSE | 倾向 AUC | 成员 AUC | TPR@1%FPR | Cox CI 重叠 |
|---|---|---|---|---|---|---|---|
| pbc 221×19 | synthpop | 0.16 | 3.25 | 0.478 | 0.566 | 0.070 | 0.640 |
| | arf | 0.87 | 3.42 | 0.488 | 0.565 | 0.054 | 0.631 |
| | 对照 bootstrap | 0 | 4.10 | 0.313 | **0.816** | **0.638** | 0.695 |
| | 对照 independent | 0 | 3.59 | 0.600 | 0.517 | 0.028 | **0.309** |
| colon 711×12 | synthpop | 0.20 | 1.67 | 0.466 | 0.539 | 0.041 | 0.802 |
| | arf | 1.35 | 1.48 | 0.452 | 0.577 | 0.040 | 0.748 |
| | 对照 bootstrap | 0 | 3.21 | 0.419 | **0.815** | **0.634** | 0.734 |
| | 对照 independent | 0 | 8.26 | 0.682 | 0.505 | 0.010 | **0.449** |
| rotterdam 2386×12 | synthpop | 0.96 | 1.62 | 0.484 | 0.570 | 0.042 | 0.734 |
| | arf | 1.70 | 3.57 | 0.541 | 0.544 | 0.020 | 0.797 |
| | 对照 bootstrap | 0 | 1.06 | 0.460 | **0.819** | **0.637** | 0.776 |
| | 对照 independent | 0 | 47.05 | 0.869 | 0.504 | 0.012 | **0.307** |

10 次拆分的 Cox 重叠标准差约 0.05 至 0.11，成员 AUC 约 0.02 至 0.04，所以这些差异大多在噪声内。flchain 6524×10 单次：synthpop 1.1 秒，arf 5.5 秒；整段会话 R 峰值约 380 MB。耗时标准差很大（最大 1.7 秒），因为机器共享。**深度模型没有跑**：磁盘只剩 840 MB，装不下 torch，所以我没有它们的 CPU 实测。

arf 的附加核查 [本机实测]：同种子两次运行结果完全相同（`parallel=FALSE`）；宽格式条件 `data.frame(age="(65,Inf)")` 生效，年龄范围 65 至 101，条件下事件率 0.506（真实 0.532）、nodes 均值 3.69（真实 3.54）。**陷阱**：长格式 `data.frame(variable="age",relation=">",value="65")` 在本例只报 "no matching leaves" 警告，输出年龄范围 15 至 91，条件被静默忽略。适配器必须自查。缺失值：默认输出无 NA，`sample_NAs=TRUE` 时 NA 比例 0.099（输入 0.088）。

**许可事实**
- SDV 是 Business Source License 1.1，附加授权原文："provided that you do not use the Licensed Work, or derivatives of the Licensed Work, for a Synthetic Data Service"，四年后转 MIT。EviMed 是对外 SaaS，提供合成数据即落入此条 — [LICENSE](https://github.com/sdv-dev/SDV/blob/main/LICENSE)。`ctgan` 的 GitHub API 同样返回 NOASSERTION，我没有单独读它的 LICENSE。
- ForestDiffusion：GitHub 仓库 `archived=true`，API `license=null`，根目录 `LICENSE` 在 master 和 main 都 404，PyPI 许可字段为空。没找到授权声明不等于确认没有（可能在子目录），但默认不能假定可商用 — [仓库](https://github.com/SamsungSAILMontreal/ForestDiffusion)；[PyPI](https://pypi.org/project/ForestDiffusion/)
- `arf` 为 GPL ≥3，synthpop 为 GPL-2|GPL-3，同类 — [arf CRAN](https://cran.r-project.org/package=arf)

### Inferences
- 回答"经典方法是否仍然匹配或胜出"：在 n 为几百到几千、列数几十以内的临床表格上，**是的，至少在效用和推断上**。深度方法的胜利出现在大的非临床基准上，且多是 GPU 与 HPO 下的分布保真；而这些基准普遍没放 CART，所以"胜过 synthpop"是未被检验的说法，不是被证实的说法。
- synthpop 真正的短板是隐私而非效用（Winzell）。引擎已用 `smoothing="density"` 和 holdout 对照应对，但我没有测 smoothing 打开后的数值。这是接下来该做的，比换生成器更重要。
- ARF 不是因为更好才值得考虑，而是因为它不依赖变量顺序（El Emam 2021 见前作：顺序影响明显）、能做条件采样、能给似然。如果常见子人群，synthpop 生成后过滤就够；稀有子人群条件采样又是外推。所以判"以后"。
- 深度方法在四核共享 CPU 上：小样本大概能跑，但 torch 闭包大、HPO（RKI 称影响极大）基本无法在单作业预算内做。这是推断，没有测量来源。

### Gaps
- 未找到把 synthpop、ARF、TVAE、TabDDPM、TabSyn、Forest-Flow 同时放在临床数据上比效用和隐私的研究。这就是最关键的空白。
- ARF 在临床数据上的独立评价：未找到。
- CTAB-GAN+：只见其他基准的结果，猜测的仓库地址 `team-daniel/CTAB-GAN-Plus` 返回 404，未核实当前地址与许可。
- Winzell 的 ε-identifiability 本身是距离类指标，按第 6 节不可靠，它的 MIA recall 更可信，但也是单一配置。

## 纵向、生存与试验合成，以及 LLM 生成器

### Takeaway
生存合成上最有说服力的是 Chassat 2025：包括作者自家模型在内，所有生成器都有 I 类错误膨胀和功效偏差，"高保真"不保证推断有效。其余（HALO、TrialSynth、TWIN-GPT、SurvivalGAN）基本只有作者自评，且需要 GPU 或外部 API，没有一个适合进这个引擎。

### Cited Findings
- Chassat, Nguyen, Ducrot, Lanoy, Guilloux（Inria、AP-HP），ML4H 2025，含 ACTG320 和 Project Data Sphere 试验，比较 Surv-GAN、Surv-VAE、HI-VAE 系列。"all models—including ours—yielded miscalibrated survival analyses, with inflated type I error and biased power"。生成 200 份再挑"对原始对照 log-rank p 最大"的一份，可恢复多数场景的功效，但 I 类错误仍偏高；选前 20% 则全部变差。Surv-GAN "generally fails"，Surv-GAN/Surv-VAE 判别好但校准差。K-map 低于 EMA Policy 0070 的 ≥11，作者认为不足以公开发布。作者自家模型获胜这一点是自评，但"全部不校准"是对自己不利的发现，更可信 — [FT 经 pdftotext](https://arxiv.org/pdf/2511.16551v1)；代码 `aguilloux/survgen-clinical-trials`（许可未核实）
- SurvivalGAN（Norcliffe et al., 2023）：5 个医学数据集、5 个基线，作者称质量好 — [AB，作者自评](https://arxiv.org/pdf/2302.12749)。上一条是它的独立负面证据。
- HALO（Theodorou et al., Nat Commun 2023;14:5305）：高维 EHR 码序列，下游 AUROC 0.938 对真实 0.943（预印本数字）— [AB](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10471716/)；[预印本](https://arxiv.org/pdf/2304.02169)。有 [勘误](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10663491/)。TrialSynth 作者称它在少于 1000 人的试验上难以运行 — 见下。
- TrialSynth（arXiv 2409.07089，有 NeurIPS 2024 虚拟页面，轨道级别未核实）：Project Data Sphere 7 个试验，47 至 953 人。下游 AUC 真实 vs 合成：LC1 0.689/0.672，BC2 0.660/0.599，LC2 0.738/0.729。评价用 DCR，无全面再识别评估；RTX 3090 约 12 小时；事件型序列，数值被离散化；代码写"将发布" — [FT 经抓取摘要](https://arxiv.org/html/2409.07089v2)
- TWIN-GPT（2024 预印本）：用 **ChatGPT 微调 API** 训练，模型版本未写，一个乳腺癌试验 2,887 人；严重结局 AUROC 0.821 对真实 0.838；kNN 在 TOP 上保真 r=1.0 高于 TWIN-GPT ≥0.96；未见代码；NNAA 解读疑似写反 — [FT 经抓取摘要](https://arxiv.org/html/2404.01273v2)。未找到独立评价。
- 前作已记：DT-GPT、TwinWeaver、Delphi-2M、Bisbee 的硅基抽样失败，以及 Fernandes 2025 虚拟对照的风险差扭曲 76% 至 133%。本文不重复。

### Inferences
- 候选卡片结论一致：不值得。运行时要 GPU 或外部 API，与"无网络、同种子同结果、模型不做统计"三条约束正面冲突。TWIN-GPT 还要把患者数据发给外部 API 微调。
- 可借的是**评价方法**而非模型：Chassat 的 I 类错误和功效校准（M=100 重复）应进 `population.quality`。
- `patients.longitudinal` 的现实短板（线性混合模型、MCAR 单调脱落）用现有 `nlme` 加 MAR/MNAR 脱落和非线性轨迹就能改善，不需要深度模型。这是我的判断，没有直接比较文献。

### Gaps
- TimeGAN（2019，早于窗口）没有找到临床试验数据上的严肃独立评价，本轮也未专门深挖。
- synthpop 的生存专用路径（如生存树法）和删失处理的表现没有读到数据；Smith 2022 的生存合成研究未打开。我的本机测试把时间和事件当普通列合成，Cox 重叠 0.63 至 0.80，不代表最优配置。
- 未见任何生成器通过前瞻性真实试验验证。

## 数字孪生生成器：Unlearn 的证据，以及能开放复现什么

### Takeaway
可复现、可监管的部分其实是"预后分加 ANCOVA"，生成器架构不是关键。同行评议或厂商论文里的真实数字是相关 0.27 至 0.38、样本量省 5% 至 13%；营销页的 30% 至 35% 对照臂缩减没有找到同等级来源。FDA 只说它不偏离协变量指南，并提醒功效可能乐观，这不是认证。

### Cited Findings
**监管**
- EMA CHMP 2022-09 资格意见：Phase 2/3、连续结局，I 类错误和无偏性不依赖模型质量；CHMP 不认证预后模型开发流程（前作已读 [EMA 原文](https://www.ema.europa.eu/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf)，本轮未重读）。一篇贸易媒体写成 Phase I/III，与 EMA 不符，[该文](https://www.clinicaltrialsarena.com/news/ema-qualifies-unlearn-approach/)不可取。
- FDA CDER 意见经 Unlearn 博客转述（2024-01-02），**来信本身我未见到 [VEN]**："PROCOVA is in principle a special case of an Analysis of Covariance"；"If a prognostic covariate is derived using independent external data, then it is valid to adjust"；"PROCOVA may or may not lead to a more precise treatment effect estimate than more traditional ANCOVA modeling"；"A power calculation may be optimistic if the correlation between a derived covariate and an outcome of interest differs between external data and the prospective trial"；"Any future requests related to its use should be product or trial specific"。ISTAND 意向书未被接受，理由是已被协变量指南覆盖 — [Unlearn 博客](https://www.unlearn.ai/blog/us-fda-comments-on-unlearns-procova-methodology)

**数字**
- PROCOVA-MMRM（Ross, Sabbaghi, Zhuang, Bertolini，均 Unlearn，2024 预印本）[VEN]：AD 目标试验（Quinn 2010）重分析。ADAS-Cog11 18 个月治疗效应方差：未调整 1.024、加基线 0.955、PROCOVA-MMRM 0.907、两者都加 0.857；CDR-SB：0.113、0.108、0.099、0.093。时间匹配预后分与观测值相关 ADAS-Cog11 0.36/0.34/0.38，CDR-SB 0.34/0.37/0.37。历史子集相关 0.267、0.361，对应样本量缩减 7.1%、13.0% — [FT 经 pdftotext](https://arxiv.org/pdf/2404.17576)
- AWARE Phase 2（前作）：残差方差约降 11%，总样本可减 5% 至 10%，AbbVie 与 Unlearn 合著 — [PMC11712969](https://pmc.ncbi.nlm.nih.gov/articles/PMC11712969/)。
- 营销：控制臂缩减 30% 至 35% 来自二手公司简介 — [SNIP，可信度低](https://yespress.io/unlearn-ai.md)。Unlearn 博客称 AD 生成器用 3 万余名患者数据训练，已改为 NBM — [VEN](https://www.unlearn.ai/blog/modeling-alzheimers-disease-progression-whats-new-in-our-latest-dtg-update)。
- NBM（Lang et al. 2023）把 CRBM 参数换成神经网络，据称代码公开 — [VEN，未核实代码许可](https://www.unlearn.ai/resources/neural-boltzmann-machines)。未找到 NBM AD 模型的外部试验验证。

**开放替代**
- Schuler et al.：模型可以是任何学习器；增益取决于历史和当前数据生成过程的相似度；即使非最优也不差于原始协变量调整 — [AB](https://arxiv.org/pdf/2012.09935)。
- Holzhauer & Adewuyi 2023 提出本质相同的 "super-covariate"；Højbjerre-Frandsen & Schuler 指出"试验内"预后分调整就是 TMLE，可以不用历史数据 — [SNIP](https://arxiv.org/html/2507.23446v2)。
- `postcard`（MIT，1.1.0，2025-09-17）："Estimating Marginal Effects with Prognostic Covariate Adjustment"，含功效分析和影响函数推断 — [CRAN](https://cran.r-project.org/package=postcard)。闭包 103 个包，新增 43 个（含 tidymodels 系），适合 CI 对照，不适合进运行时。

**开放数据现状**
| 数据 | 规模 | 获取 | 商业使用 |
|---|---|---|---|
| [PRO-ACT](https://ncri1.partners.org/ProACT)（ALS） | 13,717 人，44 个 II/III 期试验，超 1800 万数据点 | 注册登录 | 页面未提，条款正文未读 |
| [ADNI](https://adni.loni.usc.edu/data-samples/adni-data/)（AD） | 页面未给总量；Winzell 用了 2,430 人子集 | 申请，DUA，核实科研或教育机构身份，约两周，年度更新 | 页面未明说；用途限科研、教学或规划临床研究 |
| [Project Data Sphere](https://ceoroundtableoncancer.org/project-data-sphere/faqs/)（肿瘤） | — | 免费，无需研究计划，需签平台协议；NCI 数据另签 | 未见说明 |
| [Vivli](https://vivli.org/wp-content/uploads/2018/08/Vivli-Terms-Of-Use.pdf) | — | 免费（[二手](https://casrai.org/guides/vivli-data-request-and-access-review-process)），每人一份 DUA，数月 | "educational and research purposes" 范围内 |
| CPAD/CODR-AD | 见 Unlearn 致谢 | 联盟 | 未核实 |

Unlearn 的 PRO-ACT 案例只是公司文档，未见独立外部验证 — [VEN](https://assets.website-files.com/5ef3f3eba7c8fa472d1ff536/62d1a76c7cf94e2f5d6fcac0_Unlearn_HD_ALS_Case_Study_2022.pdf)。

### Inferences
- 从上面的方差表算（我的计算）：在已调基线的 MMRM 之上，加预后分使 ADAS-Cog11 方差再降 10.3%（0.955 到 0.857），CDR-SB 再降 13.9%（0.108 到 0.093）。这是厂商单个试验的数字，且基线调整本身已拿走一部分。对用户的诚实说法是"个位数到百分之十几"，不是三成。
- CRBM/NBM 复现不值得：需要数万人的联盟数据，而监管意见明确不依赖模型质量。一个 lm/Cox 加样条的预后分就能走同一条路径，且结果可解释。
- 这些数据都要人工申请账号，无法在运行时自动获取。平台若要预置预训练预后模型，得先读各家条款；Owner 的合规不设障规则不改变这是事实待核。最现实的路径是用户自带历史 IPD（`model.prognostic_train`），配合现有 `model.prognostic_apply` 和 `design.procova`，并在 `design.procova` 默认按 EMA 公式保守折减（Unlearn 论文也写了 deflation 因子）。
- FDA 那句"功效可能乐观"应直接变成输出：相关系数对折减的敏感度表。

### Gaps
- 没有找到 PROCOVA 的独立真实试验再分析（搜索两次，结果都是厂商或无关）。
- PROCOVA-MMRM 的 ALS 部分和 TRAILBLAZER-ALZ 2 模拟未读。
- 各数据源的完整条款未读。

## 疾病进展与机制模型：能在这台机器上开放做什么

### Takeaway
开放的 NLME 工具链成熟，AD 上有带外部验证且发表了参数的模型，还有 EMA 2013 资格认可的模拟工具。可做"人群层面的安慰剂进展加假设药效"的设计模拟；**不能**做个体预测（基线预测个体变化 R²=0.16）。QSP 现阶段不值得。

### Cited Findings
- Jamalian et al.（Genentech/Roche），CPT:PSP 2023;12(7):1029：建模 N=1,093（ADNI 459；SCarlet RoAD 266；Marguerite RoAD 195；ABBY 144；BLAZE 29），外部验证 CREAD 407、CREAD2 398（安慰剂臂）。logit 域 CDR-SB，疾病起始时间 DOT、全局线性率、个体指数率，IIV 在 DOT 和 α 上，基线 CDR-SB、MMSE 为协变量。NONMEM 7.3。论文 Table 3、4 公布了参数和分布，无代码声明。VPC 称捕捉良好，但 12 个月变化多数研究高估，CREAD2 落在 95% 预测区间外；**仅用基线预测个体变化 R²=0.16** — [FT 经抓取摘要，VEN 属申办方](https://pmc.ncbi.nlm.nih.gov/articles/PMC10349194)
- C-Path/CAMD AD 试验模拟工具（Romero et al., CPT 2015）：疾病进展、安慰剂、脱落三模型，ADAS-Cog 0 至 70 S 形。EMA 资格意见 2013-09-19，轻中度 AD，最长两年 — [EMA](https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/qualification-opinion-novel-data-driven-model-disease-progression-trial-evaluation-mild-moderate_en.pdf) [SNIP]；FDA 审评 — [FDA](https://fda.gov/media/98856/download) [SNIP]；Alzforum 说是 R 写的且免费 — [Alzforum](https://alzforum.org/node/39425) [SNIP]；**C-Path 自己页面说应用访问"建设中"** — [C-Path](https://c-path.org/tools-platform/alzheimers-disease-clinical-trial-simulation-tool/) [SNIP]。来源互相矛盾，当前可得性未确认。2013 年早于窗口，但它是这类工具获监管认可的直接先例。
- AD Course Map / `leaspy`（Maheux et al., Nat Commun 2023）：训练 866，验证 3,821，五个队列。MAE ADAS-Cog13 5.98、MMSE 2.54、CDR-SB 1.86；RNN-AD 6.53、2.75、1.95。25% 疗效假设下样本量减 38% 至 50%（RNN-AD 21% 至 42%），这是模拟且看起来是选高进展者的富集，并非协变量调整（设计细节我未逐项核实）。一位作者持该模型专利 — [FT 前 10 万字符](https://pmc.ncbi.nlm.nih.gov/articles/PMC9918533/)。`leaspy` 2.1.0（2026-06-10，BSD-3-Clause-Clear，Python）— [PyPI](https://pypi.org/project/leaspy/)；[GitHub](https://github.com/aramis-lab/leaspy)；[软件论文](https://arxiv.org/pdf/2608.09365) 未读。
- 工具链（CRAN 与快照）：`nlmixr2` 7.0.1（2026-08-05）闭包 140、新增 67；`rxode2` 快照 5.1.7（CRAN 已 5.1.8，2026-10-13）闭包 46、新增 15；`mrgsolve` 2.0.1（2026-05-20，GPL ≥2）闭包 19、新增 1；`PKPDsim`（MIT）新增 3；`pmrm` 0.0.4（2026-04-03，MIT，"continuous-time nonlinear mixed-effects model for longitudinal clinical trials in progressive diseases"）新增 3 — [CRAN pmrm](https://cran.r-project.org/package=pmrm)；[mrgsolve](https://cran.r-project.org/package=mrgsolve)；[nlmixr2](https://cran.r-project.org/package=nlmixr2)。
- ICH M15：FDA 项目页称 2026 年 6 月发布最终指南；EMA Step 5 生效 2026-07-23 — [EMA Step 5](https://www.ema.europa.eu/en/documents/scientific-guideline/ich-m15-guideline-general-principles-model-informed-drug-development-step-5_en.pdf)；[FDA 配对会议项目](https://www.fda.gov/drugs/development-resources/model-informed-drug-development-paired-meeting-program?) [SNIP]。**日期冲突**：前作引用 ICH Step 4 为 2026-01-29，本轮搜索摘要写 2026 年 2 月（[RAPS](https://www.raps.org/resource/ich-adopts-m15-guideline-on-model-informed-drug-de.html) [SNIP]），未核到 ICH 原文。
- FDA MIDD 配对会议：PDUFA VII 期间每季度接受 1 至 2 个申请，需活跃 PIND/IND — [FAQ](https://www.fda.gov/drugs/development-resources/midd-paired-meeting-program-frequently-asked-questions) [SNIP]。
- QSP：前作已写。AFFIRM 重建高估疗效（>90% 对 67%），FLAURA2 前瞻性预测只是厂商摘要。本轮未增证据。

### Inferences
- 候选 `patients.disease_progression`（或挂在 `design.simulate` 下的 truth 模型）：只读论文方程和参数，模拟不估计；引擎手写 R，CI 用 `mrgsolve` 对照，沿用现有"手写加交叉核对"模式，运行时不增加编译型依赖。`mrgsolve` 和 `rxode2` 运行时编译 C++ 模型，这点是我从已知设计推断，本轮未在文档里核实；如属实，运行时镜像需带工具链，又是一个不进运行时的理由。
- 用户新答的问题："这个入组范围下安慰剂进展多少、药效减缓 X% 时功效和样本量如何"。必须输出的标签：模型来自谁（申办方）、验证人群、个体预测不可用（R²=0.16）、已知高估（12 个月）、适用范围之外的警示。按 ICH M15 的框架（前作）这属于设计用途；"模型影响低至中"是我的定级，不是文件原话。
- 把进展速率的不确定性放进现有 `design.assurance`，比给单点更诚实。
- 不应声称"机制模型"：Jamalian 和 ADAS-Cog 模型都是半经验进展模型。上下文说的"没有疾病机制模型"在 QSP 意义上仍然没有，也不建议现在补。

### Gaps
- Jamalian 表 3 的参数我没有逐项抄录和验证，也未确认协方差是否完整（参数不确定性传播可能需要假设）。
- nlmixr2 在四核上的估计耗时没有测（磁盘不足，未安装）。
- 肿瘤和 T2D 的已发表进展模型未调研（见总判定）。
- C-Path 工具当前能否取得未确认。

## 预后与治疗效应模型

### Takeaway
低维生存预测上 Cox 没有被显著超过，所以不必加 DeepSurv 或 LightGBM。causal forest 在独立研究里校准差于正则回归，跨试验重复失败也有记录。效应异质性应先做回归效应模型加校准，grf 放后面。

### Cited Findings
- Burk et al.（Bioinformatics，arXiv 2406.04098v2）：19 个模型，34 个公开右删失数据集（137 至 52,422 行），嵌套交叉验证，近 2 万次调参。"no method statistically significantly outperforms" Cox；Cox "a simple and robust method, sufficient for most practitioners"。XGBCox 校准差。**未纳入** DeepSurv、DeepHit（算力和实现不可靠），也未纳入 LightGBM。限低维、单事件、右删失 — [FT 前 10 万字符](https://arxiv.org/html/2406.04098v2)；v1 版称 AFT 在对数似然上更好，v2 未保留 — [v1](https://arxiv.org/abs/2406.04098v1)
- Yilmaz 2026 IEEE Access：六模型三数据集，低 EPV 下 DeepSurv 未进前列，惩罚 Cox 和 RSF 领先 — [SNIP](https://acikerisim.mu.edu.tr/xmlui/handle/20.500.12809/11207)。单中心研究常报 DeepSurv 小胜（如 0.8056 对 0.7917）— [SNIP](https://innoscience.ru/2500-1388/article/view/686422)，多为单数据集且无预设基准。
- Venkatasubramaniam et al., BMC Med Inform Decis Mak 2023;23:110：CANTATA-D/D2（n=1,428）开发，CPRD（18,741）外部验证，SGLT2i vs DPP4i。causal forest 预测范围过窄，未识别出受益最大层（≥10 mmol/mol）和 DPP4 受益层；"calibration was good with penalized regression but sub-optimal with causal forest"；建议勿单靠 causal forest。局限：一个结局、低维、观察性验证。原文内部数字略有不一致 — [FT 经抓取摘要](https://pmc.ncbi.nlm.nih.gov/articles/PMC10276367/)
- ACCORD 到 VADT：causal tree 亚组未能跨试验重复（2021）— [SNIP](https://www.sciencedirect.com/science/article/abs/pii/S104727972100212X)。
- 多试验模拟中 causal forest 是单研究方法里最强的之一，高于 X-、S-learner — [SNIP](https://pmc.ncbi.nlm.nih.gov/articles/PMC11086055/)。这一条与上面方向相反，属模拟研究。
- 包：`grf` 2.6.1（GPL-3，2026-03-04，C++17，新增 3）；`stochtree` 0.4.5（MIT，C++17，新增 1）；`bcf` 2.0.2（GPL-3，2024-02）；`policytree` 1.2.5（MIT）— [grf](https://cran.r-project.org/package=grf)。`rlearner` 不在 CRAN（查快照无）。
- TRIPOD+AI、PROBAST+AI、STRATOS 校准见前作，不重复。

### Inferences
- `model.prognostic_train` 默认 Cox（生存）或 lm（连续）加样条，ranger 作敏感性对照，输出校准（截距、斜率）和预期 R/样本量折减。这也符合 Burk 的结论和 STRATOS，无需新依赖。
- CATE 的第一步是"治疗×预后分"的回归效应模型加校准，只增 `survival`/`stats` 调用。如果用户明确要探索非线性异质性再加 `grf`。grf 的同种子可复现未测，不同线程数下可能不同，需要固定 `num.threads`（我未核实文档）。
- 输出必须标"探索性"。这不是审批关卡，只是标签。

### Gaps
- 未找到 2023 至 2025 跨多个 RCT 的 causal forest 系统复现综述。
- 未找到严格的 DeepSurv vs Cox 荟萃分析，上面只是单个基准和零散研究。

## 合成数据隐私：什么是成熟的

### Takeaway
边际型 DP（AIM、MST）的实现和审计相对最成熟，但 DP 会明显破坏相关结构，且 MHRA 系作者明确说保真优先。距离类指标（DCR 等）已被证明不能代表隐私风险，真正可靠的是针对记录的成员推断。引擎的成员 AUC 本身就是距离型平均指标，这是它的盲点。

### Cited Findings
- Yao, Krčo, Ganev, de Montjoye 2025（预印本）"The DCR Delusion"：Adult/Bank/Census/Berka，IndHist、Baynet、CTGAN、TabDDPM、ClavaDDPM。99 个设置中 77 个的全部 500 份数据被代理指标判为私密，但 Adult/Baynet 1000 条里 54 条 MIA AUC ≥0.8、200 条 ≥0.6；mean DCR 与 MIA AUC 无相关；扩散模型全部通过 DCR，白盒攻击在 10 个 TabDDPM 目标上都超过 20% TPR@FPR=0%。最脆弱记录是唯一 "Holland-Netherlands"，AUC 0.94。建议经典生成器用扩展 TAPAS 加 Achilles，但 Achilles 也漏掉不少 — [FT 经抓取摘要](https://arxiv.org/html/2505.01524v1)
- Ganev & De Cristofaro：通过相似度测试的数据仍可被成员和属性推断攻破 — [AB](https://arxiv.org/html/2312.05114v3)。引擎 `quality.R` 注释已引用。
- 反方：滑铁卢大学硕士论文认为 DCR 有用、DOMIAS 敏感性有限 — [SNIP，分量轻](https://uwaterloo.ca/computer-science/events/masters-thesis-presentation-AI-evaluating-privacy-metrics-for-synthetic-tabular-data)。
- MIA 对 DP 生成器：MAMA-MIA 攻击 MST、PrivBayes、Private-GSD，称边际保留型泄露比认知多 — [SNIP](https://arxiv.org/html/2402.06699v1)；另一项 — [SNIP](https://arxiv.org/html/2410.05506v1)。2026 预印本审计称 MST、AIM 标准实现下实际隐私接近形式保证 — [SNIP](https://www.emergentmind.com/papers/2604.18352)。两者不矛盾：一个针对高 ε 或实现漏洞，一个针对合规实现，我没有读全文确认。
- `dpmm`（SAS 系作者，TPDP 2025）：PrivBayes、MST、AIM，端到端 DP 和已知漏洞修复 — [AB](https://arxiv.org/abs/2506.00322)；MST、AIM 优于 PrivBayes+PGM（Wine 数据）— [SNIP](https://www.emergentmind.com/papers/2506.00322)。
- DP 对保真的影响：Adams, Prasser, Fröhlich（iScience 2025；5 模型 3 患者数据集）称 DP 严重破坏相关结构，无 DP 模型未见明显隐私泄露 — [SNIP，原文 403，机构库拒绝](https://www.medrxiv.org/content/10.1101/2024.12.06.24317239.full.pdf)。Winzell：TableDiffusion ε=1 的 ADNI 效用 0.310（隐私 0.973），SVM AUC 0.537；DataSynthesizer ε=100 的 AUC 0.741 至 0.852 — 见上节来源。LEMURS 行为健康数据：AIM 最好，5≤ε≤10 保留关键关联 — [SNIP](https://arxiv.org/abs/2507.02971)。
- 监管立场：MHRA 作者章节原话 "fidelity should be prioritized over the incorporation of privacy measures"，且"privacy assessments are undertaken to understand any disclosure risks" — [FT](https://www.intechopen.com/chapters/1231191)。

### Inferences
- 成熟度排序（我的判断）：形式化 DP 机制（AIM/MST 实现）> 针对记录的 MIA 方法（方法成熟，临床数据上算力和阈值未定）> 距离代理（不应作为结论）。引擎已说"不声称匿名"，这一点是对的。
- 引擎现有 `membershipAuc` 是全体记录平均的距离攻击。本机实测它能抓住重抽（0.82），但 Yao 显示平均数掩盖少数脆弱记录。应加：离群记录清单加影子模型逐记录 AUC。Yao 的做法每目标 500 份数据，太贵；降级为最离群的 20 至 50 条、每条 20 至 50 次影子合成，仅合成部分按每份 0.2 至 1 秒约 1.5 至 40 分钟（我的估算，未含攻击本身）。超过单作业预算时，应做成单独作业并说明抽样，不隐藏。
- `dpmm`、`smartnoise-synth` 进一次性 Python 容器是可行的适配，但只有"用户要把数据发到平台之外"时才有意义。平台内分析不需要，判"以后"。
- 我的设置下 ARF 和 synthpop 的成员 AUC 都在 0.54 至 0.58，但本测试未开 smoothing，n 小，且只是平均指标，不能据此说任何一个安全。

### Gaps
- 未找到在健康数据上用统一 MIA 比较 AIM、MST、PrivBayes 的基准。
- 引擎 `smoothing="density"` 对逐记录 MIA 的实际效果未测。
- 猜测的 `ryan112358/private-pgm` 地址已迁移，新地址和许可未确认。

## 评价：`population.quality` 还缺什么

### Takeaway
现有套件覆盖保真、声明分析的 CI 重叠、TSTR、硬约束和距离型泄露，比多数论文全。缺的是推断有效性（合并 m 份、I 类错误）、生存分析种类、逐记录隐私和属性推断。另外有一个定义了却没人用的 band。

### Cited Findings
现状（读自 `quality.R`、`engine.R`、`population.R`）：
- 有：KS、TVD、缺失率差、成对差、sPMSE、交叉验证倾向 AUC、稀有组合、硬约束、声明分析 CI 重叠、入排通过率、TSTR、精确复制率（与 holdout 比）、DCR/NNDR 5 分位、最近邻在训练集占比、距离 MIA AUC 和 TPR@1%FPR。
- `vcr_analysis_from_spec` 只接受 `mean` 和 `glm`，**没有 Cox、log-rank、RMST**，而引擎的主要终点就是生存。
- 多份合成时保真和效用只描述第 1 份（`fidelityAndUtilityOn`），其他份只逐份打分。`population.R:418` 注释写 "the combining rules need m"，但在 `R/` 目录下 grep 不到实际的合并规则实现（只这一处提及）。
- `inferenceRisk` band 定义于 `quality.R:57`，在 vcr-engine、domain、server、web 中都没有第二处引用，属死配置；属性推断风险没有计算。

文献依据：
- 只看保真和常规效用不够：Chassat（"A model that looks strong by standard ML metrics may still fail when applied to clinical inference"）— 见第 2 节；Decruyenaere：naive 推断假阳性高，修正因子 √(1+m/n) 只对统计生成器有效 — 见第 1 节。
- Alaa et al. 2022：α-precision、β-recall、authenticity 样本级指标 — [SNIP](https://alphaxiv.org/overview/2102.08921v2)。
- Nafis et al. 2025 系统综述：筛 1,766 篇读 101 篇，评价方法无共识 — [SNIP](https://arxiv.org/abs/2504.18544v2)。ELIXIR 范围综述 2026：系统评价常被忽略 — [SNIP](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12891913/)。medRxiv 范围综述：多数研究未恰当评估隐私 — [SNIP](https://medrxiv.org/content/10.1101/2023.11.28.23299124v2)。
- Escudié：HPO 和指标选择都能翻转排名，主张简明指标加领域约束 — 见第 1 节。El Emam：变量顺序影响（前作）。
- FDA 2023 器械 CM&S：人群层面验证比较均值、方差和完整分布，校准不算验证（前作）。

本机实测对现有指标的直接证据（表见第 1 节，指标是引擎自己的函数）：
- 完全破坏结构的 `independent` 对照在 pbc 上 sPMSE 3.59（黄）、colon 8.26（黄），只有 rotterdam 47 才红；倾向 AUC 0.60 至 0.87。而 Cox CI 重叠 0.31 至 0.45 三个数据集都明显偏低。**小样本时 sPMSE 不足以发现相关结构全失**。
- 直接重抽训练行的 `bootstrap` 对照 sPMSE 和倾向 AUC 全是好看的（AUC 低至 0.31），只有成员 AUC 0.82、TPR 0.63 和精确复制 0.25 发现问题。
- 生成器和对照的倾向 AUC 都常低于 0.5（0.31 至 0.49），说明它是噪声而非"更好"。band 的绿色判断在这一端不提供信息。

### Inferences
按优先级建议补（都不是门禁，只是报告项，符合"verdict 不扣留交付"）：
1. 声明分析加 `coxph`、`logrank`、`rmst`，并对全部 m 份用合并规则估计和 CI。
2. 零假设校准：把臂标签随机置换后走完整合成到检验，重复 R 次得 I 类错误和 MCSE。synthpop 每份约 1 秒以内 [本机实测]，R=100 到 200 可行。
3. 逐记录 MIA（见上节），列出最脆弱记录的属性组合但不展示记录本身。
4. 属性推断：实现或删除 `inferenceRisk`（Owner 2026-10-25 "没用的和历史的都不留"）。可用 anonymeter 思路手写，CI 对照 Clear BSD 的 `anonymeter` 1.1.0（2026-07-23）— [PyPI](https://pypi.org/project/anonymeter/)。
5. 生存专项：KM 距离、删失比例、事件时间尾部。
6. 子群保真：入排后人群和主要亚组内分别报告，而不只是全人群。
7. 变量顺序敏感性：换 2 至 3 个 `visit_sequence` 报告差异。
8. 纵向数据：自相关和个体轨迹斜率分布（现有 quality 不看时间结构）。

### Gaps
- 未打开 Alaa 2022、Nafis 2025 全文。
- 未测 smoothing 下这些指标的表现，我用的是 `synthpop` 默认配置，也不是引擎完整路径。
- 没有来自临床数据的、经证实的 band 阈值。`quality.R` 已写明除 sPMSE 外都是产品默认值；本测试显示 sPMSE 阈值在小样本也不宜单独看。

## 监管：FDA、EMA、MHRA 现状

### Takeaway
截至 2026-11，没有任何机构接受"合成患者作为临床证据"的成文标准。FDA 的 AI 信度文件仍是草案，MHRA 外部对照指南草案未定稿且排除了模拟患者，EMA 正在写外部对照反思文件，并明确说要先澄清 synthetic data 和 digital twin 这些术语。

### Cited Findings
- FDA：FDA 网站该页仍标 "Draft Level 1 Guidance"、"Not for implementation"，2025-01 发布，docket FDA-2024-D-4689，页面 "Content current as of 01/06/2025"，未提及后续 — [FDA](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological)。第三方博客称"预计 2026 Q2 定稿"未实现 — [SNIP](https://sakaradigital.com/blog/fda-ai-credibility-guidance-still-draft-what-to-do/)。
- FDA 外部对照 2023-02 草案逐案判断 — [SNIP 二手](https://www.clinicalleader.com/doc/the-pros-and-cons-of-synthetic-control-arms-in-clinical-trials-0001)。
- FDA CDRH 提出合成医学数据的多标准评价框架和记分卡；2026-04 就早期试验优化 AI 试点发 RFI — [单一来源，且作者属厂商 M47 Labs](https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2026.1833779/full)，未核到 FDA 原文。
- EMA/FDA 十条良好 AI 实践原则，文件首发 2026-01-14；EMA 反思文件 CHMP/CVMP 2024-09 通过；AI Observatory 2025 报告 2026-06-04；工作计划 2023 至 2028。该页未提及 synthetic data 和 digital twins — [EMA](https://www.ema.europa.eu/en/about-us/how-we-work/data-regulation-big-data-other-sources/artificial-intelligence)。
- EMA 概念文件 EMA/125200/2026（2026-05-21）：将编写外部对照反思文件，要点首条是 "Clarification of terminology (e.g., definition of an external control, synthetic data, digital twins, historical data, etc.)"；"specific regulatory guidance on the use of external controls ... in Europe" 目前缺失 — [FT 经 pdftotext](https://www.ema.europa.eu/is/media/73961)。
- MHRA：外部对照指南草案 2025-05-20 至 2025-07-14 征求意见，已关闭，页面写在分析反馈，无最终版 — [gov.uk](https://www.gov.uk/government/consultations/mhra-draft-guideline-on-the-use-of-external-control-arms-based-on-real-world-data-to-support-regulatory-decisions)。该草案排除 "Synthetic or virtual control arms with simulated patient data"，这句来自律所摘要，草案 PDF 未直接打开 — [Baker McKenzie](https://healthcarelifesciences.bakermckenzie.com/2025/05/21/external-control-arms-based-on-real-world-data-mhra-consultation-opens/)。
- MHRA 无正式合成数据立场文件。最接近的是 MHRA 与 PHG Foundation 2025 专家报告（AI 医疗器械用合成数据；CPRD 托管 PDF 返回 403，未打开；据搜索摘要其称非正式官方指南）— [链接](https://www.cprd.com/sites/default/files/2025-07/Synthetic%20data%20for%20development%20of%20AI%20as%20a%20medical%20device%20v3b.pdf) [SNIP]。MHRA 作者章节：许多原则也适用于临床试验；"It should not be used simply because it is seen as an easier and cheaper alternative"；风险越高论证要求越高；评价者对效用作主观判断 — [FT](https://www.intechopen.com/chapters/1231191)。Myles et al. 2022 预印本未读 — [链接](https://www.cprd.com/sites/default/files/2022-12/Myles%20et%20al.%20preprint_2022.pdf)。
- Guitart 2026 称这些文件评价数据质量，但都没说明生成的合成队列如何作为实质性临床证据被接受 — [FT，单作者，来自厂商](https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2026.1833779/full)。
- ICH M15、FDA MIDD 见第 4 节。PROCOVA 见第 3 节。

### Inferences
- 产品标签的依据足够明确：合成数据、虚拟患者只能用于设计探索和方法开发。引擎 `inferenceLabel="exploratory"` 与现状一致。唯一有监管路径的"孪生"用法是在随机试验中作协变量。
- 这些是事实边界，不是要加审批关卡。Owner 的规则不要求因此阻断任何交付。
- EMA 还在写术语定义，所以产品文案里的 "digital twin" 应继续由 `vcr_twin_label`（NASEM 四条）派生，而不是接受市场用法。

### Gaps
- EMA 2022 PROCOVA 意见之后是否有其他孪生类资格意见：未专门查。
- FDA 2026 年 RFI 和 CDRH 记分卡未核到一手文件。
- MHRA 草案 PDF 和 2025 专家报告全文未读（后者 403）。
- FDA 的 M15 页面未直接打开，只见搜索摘要。
