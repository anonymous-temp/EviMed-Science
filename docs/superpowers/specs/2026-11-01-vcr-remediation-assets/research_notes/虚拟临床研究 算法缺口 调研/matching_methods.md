# 患者与试验匹配、入排标准算法（2022 至 2026-11）与 EviMed 现状的差距

调研日期 2026-11-02。标记：[单一来源] 只有一处出处；[厂商] 作者或资助方有商业利益；[仅摘要] 只读了摘要；[仅检索摘要] 只见到搜索结果摘录，没有打开原文；[未核实] 没能打开或没能确认；[自算] 我从仓库结果文件算出，论文或 README 没有直接写。流水线细节、人工环节和评价设计已在 `虚拟临床研究 论文流程 整改方案/matching.md`，这里不重复，只补算法、数字和取舍。

## 最先要知道的事：62% unknown 里到底是什么，哪些算法能动它，按什么顺序做

### Takeaway
背景材料的“62% unknown，时间窗是最大失败”已经过时，而且方向有偏差。分支 `int/1102` 上的第四次运行（record header 给事实定日期）把 unknown 降到 53.8%，`undated` 只剩 26 对；此后 unknown 的 97% 是“没有可用事实”（`not_recorded` / `not_measured`：记录没写，或模型没写出能通过回读的事实），其中约三分之二的金标准本来就是“未满足”，再好的阅读算法也读不出来。能把数字动起来的第一步是一条关于“沉默”的合同规则，不是模型；算法类收益集中在假 met 控制和有限的漏读补回上。

### Cited Findings

**仓库内实测（本节数字均为 162 名留出训练患者，共 2,106 对；不是官方测试集，第三、第四次运行的患者已被看过，不是干净估计）**
- 第四次运行：unknown 0.538（0.510 至 0.566），严格准确率 0.403，决定时正确率 0.873，假 met 率 0.087，micro F1 官方评分器 (b) 0.7390 / (c) 0.8809，新鲜样本花费 CNY 3.07。第三次运行（背景材料引用的 62%）：unknown 0.615，严格 0.355，决定时 0.921，假 met 0.046，(b) 0.7226 / (c) 0.8690。— `OpenScience/evals/vcr-matching/n2c2/README.md`，commit `89a12fbcf`（在 `int/1102`，我读取时不在 `github/main`，也不在背景材料所依据的 `cde64eddc`）。
- unknown 的原因构成 [自算，来自 `results/heldout-3-2026-11-01.json` 与 `heldout-4-2026-11-02.json` 的 `unknownReasons`]：

| 原因 | 第三次（1,295 对） | 第四次（1,133 对） |
|---|---|---|
| `not_recorded` 没有事实 | 1,060（81.9%） | 1,022（90.2%） |
| `not_measured`（HBA1C 无值） | 86（6.6%） | 81（7.1%） |
| `undated` 事实定不了时间 | 146（11.3%） | 26（2.3%） |
| 单位问题 | 3（0.2%） | 4（0.4%） |

- unknown 与金标准的交叉 [自算，unknown 且金标准未满足 =（accuracyB − accuracyA）× n]：

| 第四次的 1,133 对 unknown | 对数 | 占 unknown | 含义 |
|---|---|---|---|
| 金标准 not met | 743 | 65.6% | 标注员“没写就是没有”的约定；读不出来 |
| 金标准 met，ENGLISH + MAKES-DECISIONS | 271 | 23.9% | 标注指南规定“没写默认满足”；读不出来 |
| 金标准 met，其余 11 条 | 119 | 10.5% | 真正可能被更好阅读补回的上限（2,106 对的 5.7 个百分点） |

- 同口径的第三次：830（64.1%）/ 265（20.5%）/ 200（15.4%）[自算]。其余 11 条的 119 对按标准分布：MAJOR-DIABETES 30/95、CREATININE 22/70、DIETSUPP-2MOS 15/84、ADVANCED-CAD 13/101、ASP-FOR-MI 12/135、MI-6MOS 10/13、ABDOMINAL 10/64，其余合计 7 [自算]。
- 更多事实带来更多假 met：第四次保留事实从 1,539 增到 1,762，无时间窗标准上的假 met 从 54 对增到 98 对，其中 ABDOMINAL 21 增到 49（共 98 个未满足）。README 明确说未验证原因，但判断是模型在新技能文本下多写了事实，与日期无关。— 同上 README，Fourth run。
- 时间窗的残余问题已从 unknown 变成错误：MI-6MOS 在无保护时假 met 18/149，加过去事件保护后 2/149，但 12 个正确 met 中 9 个退回 unknown；DIETSUPP-2MOS 有 16/84 个金标准 met 被明确判 not met，原因是旧记录里的补充剂按旧记录定日期，代码不做状态延续。— 同上。
- 同一模型样本间噪声约 1 个百分点（第三次的新样本与重放差 +0.008）。— 同上 README，Third run。
- 官方 86 名测试患者只跑过一次（第一条流水线，严格 0.30，unknown 0.65，(b) 0.6751，(c) 0.8293），README 写明不再重跑。— 同上。

**外部论文给出的方向证据（详见后面各节）**
- 把定义写具体的收益是单项最大的：Wornow 表 2，GPT-4 micro F1 0.85 → 0.93，只用每条标准 3 名满足 + 3 名不满足的训练患者手工细化定义。— [arXiv 2402.05125](https://arxiv.org/abs/2402.05125)
- 按记录分次调用（All Criteria, Individual Notes）与一次读完（All Criteria, All Notes）比较：GPT-4 0.90 → 0.93，GPT-3.5 0.77 → 0.80，token 约 ×1.9（0.69M → 1.32M）；按标准分次（Individual Criteria）token ×9.6，GPT-4 只到 0.92。— [arXiv 2402.05125](https://arxiv.org/abs/2402.05125) 表 3。我们的 harness 是一人一次调用读全部标准和全部记录。— `README.md`，What was measured。
- 在开放模型上，top-10 RAG 比全文略好（0.8905 vs 0.8849），但 MI-6MOS 从 0.8752 掉到 0.7244，MAKES-DECISIONS 从 0.6910 掉到 0.5896；NER 过滤明显变差（Llama 3.1 8b：0.8293 vs 全文 0.8671）。— [arXiv 2604.05190](https://arxiv.org/pdf/2604.05190) [单一来源，预印本]

**候选清单与判定**（“对 62% 的作用”以第四次的 1,133 对计，除特别说明外均为我的估计，不是发表结果）

| # | 方法 | 关键论文与数据集 | 实测结果 | 开源实现、许可、最近发布 | CPU 可行性 | 对 unknown 的作用 | 判定 |
|---|---|---|---|---|---|---|---|
| 1 | 把 unknown 拆成“沉默”与“查无法定”，解析时给每条标准写 `whenSilent`（默认 met / 默认未见 / 保持 unknown） | 无专门论文；n2c2 标注约定，Ferber 规则，Massive Bio、PRISM、TrialGPT 2.0 各有处理（见前一份笔记 Q2） | 仓库实测：等于 reading (c)，严格准确率可到 0.883 附近，micro F1 0.881；代价 119 对（占其余 11 条金标准 met 的 18.9%）变假 not met；ENGLISH 与 MAKES-DECISIONS 上增加 4 对假 met [自算] | 不需要外部包，改 domain 合同与 `assessSubject` | 无算力需求 | 最多搬走 1,014 对；不是“读出来”，是把约定写明 | **现在做，需要 owner 一条合同裁定**（不是新增人工步骤） |
| 2 | 事件与状态分型，部分日期转区间，区间三值比较（代码） | Wornow 的 most-recent-in-window 规则；仓库第二、第四次运行 | Wornow：DIETSUPP-2MOS F1 0.907 / 0.907，MI-6MOS 0.857 / 0.987；仓库：DIETSUPP 16/84 假 not met 待收回；MI 事实写了部分日期被拒 36 条仅留 2 条（第二次运行计数） | 不需要外部包；日期解析是格式问题 | 无算力需求 | unknown 减 25 对左右，主要减错误 | **现在做** |
| 3 | 标准定义卡（解析一次，写清算什么、不算什么、带对比例） | Wornow 2024（n2c2），UTSW 2026 的 tips | GPT-4 0.85 → 0.93（在训练患者上调） | 不需要外部包 | 只是模型调用 | 不减 unknown，减假 met：ABDOMINAL 0.50、ASP-FOR-MI 0.41 | **现在做**，放在补读之前 |
| 4 | 按记录分次阅读 | Wornow 表 3 | 见上；日期由调用边界天然绑定，不靠最近表头 | 不需要外部包 | 只是模型调用；我估算 CNY 3.07 → 约 6 / 162 人 | 少量；同时解决 2.4% 错绑记录和 5/162 不可读 JSON 的爆炸半径 | **现在做** |
| 5 | 只对沉默的标准做第二轮定向补读（检索 + 单标准调用） | Wornow ICAN（GPT-3.5 召回 0.69 → 0.82，GPT-4 0.87 → 0.86），Chen 2026 RAG | RAG 伤时间窗标准，故只用于补读，不替代全文 | `bm25s` MIT 0.3.16（2026-10-28）；稠密向量走已有 DashScope embedder | BM25 可；嵌入走网关 | 上限 119 对；必须监控假 met | **第 3 项之后做** |
| 6 | 试验排序：LLM 关键词（中英两份）+ 现有注册库合并结果上 cross-encoder 重排 | TREC CT 2022/2023（见第二节），TrialGPT | CE 把 nDCG@10 从 0.576 提到 0.672，GPT-4 判前 20 再到 0.736（2023，CSIRO-UQ） | `BAAI/bge-reranker-v2-m3` Apache-2.0；`BAAI/bge-m3` MIT；控制面已有 DashScope reranker | 用已有网关无本机压力；本机跑 ONNX 未实测 | 不动 62%；补上“没有排序”，也决定精读哪些试验 | **现在做**（独立一条线） |
| 7 | 风险覆盖曲线 + 代码阈值（先不做保形） | Peppoloni 2026 海报；Massive Bio | 49% 覆盖下 0% 假阳性（107 人）[单一来源，海报，无代码] | `mapie` 1.6.0、`crepes` 0.9.1（BSD 式） | 可 | 增加 unknown，不减少；用来管住假 met | **以后**（有独立校准集后） |
| 8 | 保形预测判资格 | 无资格任务上的实证；MedAbstain、SCoRE 为相邻工作 | 见第七节 | 同上 | 可 | 同上 | **以后** |
| 9 | LOINC 映射 LLM 代理 | LabBridge，JMIR 2026，中英急诊检验 | DeepSeek-V3 90%；同一中文数据 BGE-M3 单独 24% | 代码未核实 [未核实] | 走模型 | 第四次单位问题只有 4 对；在 n2c2 上无作用 | **以后**（中文真实病历出现后） |
| 10 | UCUM 单位换算 | 无评测；NLM 实现 | 不适用 | `@lhncbc/ucum-lhc` npm 8.0.1（2026-10-19），自定义 LICENSE.md 未通读 [未核实] | 可 | 约 0 | **以后**，现有闭表够用 |
| 11 | 中文实体对齐 UMLS | Chen L 2023，ICD10-CN / CHPO / RealWorld | top-5 91.85% / 82.44% / 78.43%（SapBERT + TF-IDF，先翻译）[仅摘要] | 未见官方实现 | 可 | 约 0 | **以后** |
| 12 | medspaCy ConText / sectionizer | Eyre 2021；CAN-BERT 对比 2025 | 放射报告否定 F1 0.492 vs CAN-BERT 0.777 | MIT；PyPI 1.3.1（2024-11-21）；仓库 2026-06 仍有提交；**语言表没有中文** | 可（未实测） | 约 0；且与“regex 不做语言”冲突，只能离线诊断 | **不值得进运行时** |
| 13 | MedCAT | Kraljevic 2021 | 公开集 F1 0.448-0.738；伦敦三院 > 0.94（含约 6K 人工标注微调） | Apache-2.0；原仓库已归档，代码在 `CogStack/cogstack-nlp`；PyPI 2.10.1（2026-10-29）；需要 UMLS/SNOMED 概念库 | 可（未实测） | 约 0 | **不值得** |
| 14 | scispaCy | 未见 2022 后资格任务评测 | 未见 | Apache-2.0；0.6.2（2025-10-01） | 可（未实测） | 约 0；NER 过滤在 Chen 2026 上有害 | **不值得** |
| 15 | cTAKES | 未见 2022 后资格任务评测 | 未见 | Apache-2.0；仓库 2026-08 有提交；Java | 未实测 | 约 0；英文 | **不值得** |
| 16 | HeidelTime / SUTime | 相对日期归一 2015；i2b2 2012 | 规则归一 57.2%（宽松 82.09%）[仅检索摘要] | HeidelTime GPL-3.0，仓库最后提交 2023-04；SUTime 随 CoreNLP GPL-3.0 | 可 | 约 0：绝对日期是格式，相对表达交给模型，算术交给代码 | **不值得** |
| 17 | Criteria2Query 3.0 / ATLAS / CirceR | Park 2024；Lee 2025 | 概念抽取 F1 0.891，但 OMOP 队列 Jaccard 从 0.81 到 0.00 不等 | `OHDSI/Criteria2Query` Apache-2.0（2026-03）；`CirceR` CRAN 1.3.3 Apache-2.0；Atlas Apache-2.0 | 可 | 0（面向结构化库） | **以后**，仅当用户持有 OMOP 库时做导出 |
| 18 | 微调模型（OncoLLM、TrialMatchAI 的 Gemma/Phi-4、MedGemma LoRA） | PRISM、TrialMatchAI、Chen 2026 | 见第一节 | TrialMatchAI LICENSE 文件为 MIT（2026-10 有提交）；Chen 无代码 | 需要 GPU（Chen 致谢 NVIDIA；我的判断） | 不适用 | **不值得**：无 GPU；非微调的 GPT-4 在细化定义后已到 0.93，先走提示路线 |
| 19 | MatchMiner-AI | Altreuter 2024/2026 | 见前一份笔记 | `dfci/matchminer-ai-inference` 的 LICENSE 为 **CC BY-NC-ND 4.0：禁止商用且禁止演绎**；训练仓库许可未读 | 嵌入可，重排未实测 | 不适用 | **不值得**，许可不允许 |
| 20 | MedCPT 编码器 | Jin 2023/2024（TrialGPT 使用） | 见前一份笔记 | `ncbi/MedCPT` 美国政府作品公有领域声明；Hugging Face 标 `license:other`；2023-12 后未更新 | 可（未实测） | 不适用；英文 | **不值得**，中文场景不适用 |

### Inferences
- **“62%”主要是合同，不是算法。** 第四次的 1,133 对 unknown 中，至多 119 对是漏读。若按论文的二值世界去算，模型再强也只能把严格分从 0.40 提到约 0.46，差距由“沉默算不算”决定。这与 README 第 6 条一致，这里给出了可以落到决定上的数字。
- **“时间窗是最大失败”这句话需要改。** 即便第三次运行，`undated` 也只占 unknown 的 11.3%。时间窗标准的高 unknown 大多同样来自沉默，比如 KETO-1YR 的 156/157 金标准本来就是 not met。第四次之后时间问题已从“判不了”变成“判错了”。
- **建议的顺序和每步的验收口径**（每步在 40 名开发患者上调，单独冻结；门槛都是我的建议）：
  1. 把第四次运行并入背景材料，再谈 62%。
  2. `whenSilent` 与原因拆分。预期 unknown 降到 5% 左右（主要剩规定检验值的标准和 `undated`），同时显示沉默比例。报告假 not met（应约 119 对）与假 met（应只增 4 对）。
  3. 事件/状态分型与区间日期。预期 DIETSUPP 假 not met 从 16/84 大幅下降，MI-6MOS 的 `undated` 下降且假 met 不超过 2/149。
  4. 定义卡。预期 ABDOMINAL 假 met 从 0.50、ASP-FOR-MI 从 0.41 明显回落，这是最可能把 micro F1 推过噪声的一步。
  5. 按记录分次阅读。
  6. 对沉默标准做定向补读。只有当假 met 不升时才保留，因为第四次已证明多写事实会拉高假 met。
  7. 全部冻结后，官方 86 名测试集再跑一次且只跑一次。现有 288 人里已没有未看过的干净数据，这是唯一的干净终点。README 目前写的是“不再运行”，需要 owner 同意破例一次。
  8. 排序（第 6 项）与以上并行，不互相依赖。
- `whenSilent` 必须由解析时的模型提出、代码执行、页面明示“未见记载，按默认”，并保持 Kleene 组合不变。规定检验值的标准（如 HbA1c 范围）应保持 unknown，n2c2 的“没写算未满足”在真实筛选里不成立。如果 owner 不同意沉默可以产生判定，那么 unknown 的主体就是设计结果，应该把它作为“未见记载”单独展示，而不是继续当算法缺口追。
- 所有“估计”都是单数据集、英文、心血管与糖尿病记录上的推算，标注者 kappa 只有 0.54，高于 0.9 的差异可能分不开。

### Gaps
- 没有干净的第二个英文真实病历集来验证上述顺序；n2c2 已被看穿。
- 第四次运行里 `not_recorded` 中“记录确实没写”与“写了但模型没抽”的比例无法从聚合文件分开，需要对开发集抽样读原文（README 禁止打印原文，只能本地读）。

---

## LLM 流水线：任务、数据集、数字、独立复现

### Takeaway
LLM 系统的头条数字彼此不可比，而且我没有找到任何一个被独立团队复现的。TrialGPT 2.0、OncoLLM 部署、TrialMatchAI 全部来自原团队或相关方。“Trial-LLM”这个名字我没有找到对应系统。

### Cited Findings
流水线细节见前一份笔记；这里只列任务与数字，新读到的已标出。

| 系统 | 任务与数据 | 数字 | 独立复现 | 来源与标记 |
|---|---|---|---|---|
| TrialGPT 1（2024） | 检索 + 标准判断 + 排序；SIGIR / TREC 2021 / 2022 合成患者 | 标准准确率 0.873；NDCG@10 0.7275 | 未找到；一次面向独立复现的检索没有结果 | [PMC11574183](https://pmc.ncbi.nlm.nih.gov/articles/PMC11574183)；代码 [`ncbi-nlp/TrialGPT`](https://github.com/ncbi-nlp/TrialGPT) 公有领域声明，最后提交 2025-01 |
| TrialGPT 2.0（2026） | 推荐，不产出标准标签；多中心加前瞻肿瘤委员会 | 三分类一致 89.0%；前瞻 27 例 | 同团队 | [arXiv 2609.01202](https://arxiv.org/abs/2609.01202) |
| PRISM / OncoLLM（npj Digit Med 2024） | 真实肿瘤病历，720 问，50 人 | 问题准确率 GPT-4 68%，OncoLLM 63%，专家 70% | 无；期刊版摘要确认了作者公司关系 | [DOI](https://doi.org/10.1038/s41746-024-01274-7) [厂商：Triomics] [期刊版仅摘要] |
| TrialMatchAI（Nat Commun 2026） | TREC 合成 + 52 名 NKI 真实患者 | nDCG@10 约 0.75；top 20 含相关试验 92.3% | 无；新闻稿自己说还需更大规模验证 | [arXiv 2505.08508](https://arxiv.org/abs/2505.08508)，[Nature Index 条目](https://www.nature.com/nature-index/article/10.1038/s41467-026-70509-w)，[OUS 新闻](https://ous-research.no/home/ous/news/26758) [期刊正文未读] |
| RECTIFIER（NEJM AI 2024）**新读摘要** | 单试验 13 问，开发/验证/测试 100 / 282 / 1,894 人，盲法专家金标准 | 准确率 97.9%-100% vs 工作人员 91.7%-100%；总体敏感度/特异度 92.3% / 93.9% vs 90.1% / 83.6%；单问 11 美分/人，合问 2 美分/人。这解决了前一份笔记只有二手来源的问题（工作人员敏感度是 90.1%） | 同中心后续 RCT，不算独立 | [DOI](https://doi.org/10.1056/AIoa2400181)，经 PubMed 摘要 [仅摘要] |
| Criteria2Query 3.0（JBI 2024）**新读摘要** | 把标准转成 SQL；20 个试验 518 概念，5 个试验检 SQL | 概念抽取 F1 0.891；SQL 29 处错误，逻辑错 34.48%；正确性 3.97/5 | 无 | [PMID 38697494](https://pubmed.ncbi.nlm.nih.gov/38697494/) [仅摘要] |
| Lee et al.（JMIR Med Inform 2025）**新读** | 8 个模型把标准转 OMOP SQL；760 次尝试；3 个试验验证 495 万人队列 | 概念映射 GPT-4 48.5% vs Usagi 32.0%；幻觉率总 32.7%（GPT-4 33.7%，Llama3:8b 21.1%）；有效 SQL 率 Llama3:8b 75.8%，GPT-4 45.3%；队列 Jaccard：T1D 0.81、未控制高血压 0.18、T2D 0.03、妊娠 0.00 | 这是与 C2Q 同方向的独立工作，但未直接比较 | [PMC12530336](https://pmc.ncbi.nlm.nih.gov/articles/PMC12530336/) |
| Chen, Lyu, Peng, Wu（2026）**新读** | n2c2 2018；161 / 41 / 86 划分；RAG、NER 压缩、全文对比 | 见第八节 | 无 | [arXiv 2604.05190](https://arxiv.org/pdf/2604.05190) [单一来源，预印本] |
| Tai & Tannier（2025）**新读** | n2c2 2006 / 2008 / 2018，7 个小型开放模型，5-shot | 最好的 vicuna-13b：MI-6MOS 0.414、DIETSUPP 0.730、HBA1C 0.405，都远低于竞赛最佳 | 无 | [arXiv 2501.11114](https://arxiv.org/pdf/2501.11114) |
| Peppoloni（NeurIPS 2026 WiML 海报）**新读** | Llama 3.1-70B 抽取 + 知识图 + 确定性规则 + 分诊；肺癌 77 人、17 试验、1,309 对；泌尿 30 人 | top-1 55/55；假阳性 0%；49% 全自动覆盖内 0% 假阳性；消融（n=35）LLM-only top-1 0.80 → 1.00，假阳性 0.15 → 0 | 无 | [NeurIPS 页面](https://neurips.cc/virtual/2026/163744) [单一来源，单作者，海报，无代码，满分结果需谨慎] |
| den Hamer et al.（2023） | 10 名合成患者、146 试验、4,135 标准，InstructGPT | 可筛性 72%；可筛标准判断 72%；试验级召回 0.5；加医生环节召回 1.0、精确率 0.71 | 无 | [arXiv 2304.07396](https://arxiv.org/pdf/2304.07396) [厂商：myTomorrows] |
| Leach et al.（2025） | DeepSeek-R1 匹配概念验证，肯塔基大学 | 我在全文检索里没有找到准确率数字 | 无 | [arXiv 2512.08026](https://arxiv.org/pdf/2512.08026) |
| MatchMiner-AI、Massive Bio、UTSW、Inato | 见前一份笔记 | 同左 | 无 | 同左 |

- Peppoloni 摘要称有研究发现公共匹配工具回顾敏感度约 90%、前瞻约 32%；摘要未给出出处，我在两次检索中没有找到原始研究。— [NeurIPS 页面](https://neurips.cc/virtual/2026/163744) [未核实，不要引用这个 32%]

### Inferences
- 面向设计的可借鉴点只有两个，都不需要依赖他们的代码：TrialGPT 的 LLM 关键词 + 融合检索；PRISM 的“解析一次、代码组合”，我们已有。
- Peppoloni 的结构（模型抽取 → 代码判定 → 按证据完整度分诊）最接近我们，但证据最弱，只能算方向一致，不能当数字用。

### Gaps
- “Trial-LLM”：两次检索未发现这个名字的系统，GitHub 猜测路径 `microsoft/Trial-LLM` 不存在。可能是其他系统的别称，[未核实]。
- TrialMatchAI 与 PRISM 的期刊正文未读，数字来自预印本。CTKG 见第三节。

---

## 检索与排序：TREC CT 2021 至 2023，中英混合，中文基准

### Takeaway
两阶段检索加 cross-encoder 在 TREC CT 上的增益稳定且大，加 LLM 判前 20 还能再涨；零样本 LLM 重排可能反而变差。中英混合上 BM25 对跨语言几乎失效，把它和向量直接融合会拖垮向量。没有开放的中文患者—试验匹配基准。

### Cited Findings
- TREC CT 规模 [二手，来自综述表格]：2021 为 75 条患者描述、375,580 试验，最佳 NDCG@10 0.84；2022 为 50 条、最佳 0.61；2023 为 40 张问卷模板、451,538 试验，最佳 0.81。综述注明 2023 没有官方 overview，最佳值借自 Rybinski et al. 2024。— [arXiv 2506.15301](https://arxiv.org/pdf/2506.15301)。我尝试打开 NIST 上的 2023 overview 返回 404，与之相符。
- TREC 2023 官方中位数：NDCG@10 0.648，P@10 0.397，RR 0.538。— [CSIROmed](https://trec.nist.gov/pubs/trec32/papers/CSIROmed.C.pdf)，[DoSSIER](https://trec.nist.gov/pubs/trec32/papers/DoSSIER.C.pdf)
- CSIRO-UQ（ielab）逐级对比：

| 阶段 | TREC 2022 NDCG@10 | TREC 2023 NDCG@10 |
|---|---|---|
| BM25 | 0.310 | 未提交 |
| Dense / SPLADEv2 | 0.427 / 0.423 | 0.5768 / 0.5971 |
| Hybrid | 0.502 | 0.5763 |
| Cross-encoder 重排 + 融合 | 0.621 | 0.6716 |
| GPT-4 判前 20 | 0.659 | 0.7363 |

 2022 的 Recall@1000：BM25 0.366，Hybrid 0.653。作者说 2022 他们有未判文档，所以被低估。— [CSIRO-UQ-ielab](https://trec.nist.gov/pubs/trec32/papers/CSIRO-UQ-ielab.C.pdf)
- CSIROmed 2023：BM25 0.619；LLM 查询扩展 0.699；扩展 + 稠密 0.652；扩展 + **零样本提示重排 0.593**；扩展 + **微调提示重排 0.738**。— [CSIROmed](https://trec.nist.gov/pubs/trec32/papers/CSIROmed.C.pdf)
- DoSSIER 最好 0.6837（BM25/DFR + 微调 cross-encoder）；EMA3 加权相关排序 0.7246。— [DoSSIER](https://trec.nist.gov/pubs/trec32/papers/DoSSIER.C.pdf)，[EMA3](https://trec.nist.gov/pubs/trec32/papers/EMA3.C.pdf)
- 注意 2023 的 BM25 基线 0.619 与 2022 的 0.310 差很多，话题形式变成结构化问卷是可能原因（我的判断），两年不能直接比。
- 中英混合：MMed-Bench-IR 任务 3（6 种语言问 BioASQ 问题，查英文语料 80,049 篇）中文 nDCG@10：BM25 0.036，SapBERT 0.095，BioLORD 0.081，E5-large 0.499，ColBERT-XM 0.502，BGE-M3 0.620，**BM25+BGE-M3 0.330**，**BGE-M3+reranker 0.715**，微调的 MMed-Embed+reranker 0.722；英文对应 0.518 / 0.818 / 0.755 / 0.893 / 0.870 / 0.855 / 0.731 / 0.895 / 0.892。— [arXiv 2606.24200](https://arxiv.org/pdf/2606.24200) [单一来源，预印本；任务是生物医学问答，不是试验]
- 同一基准任务 2 含中英术语同义检索。— 同上。
- 模型许可与形态（Hugging Face API 读取）：`BAAI/bge-m3` MIT，含 ONNX 文件；`BAAI/bge-reranker-v2-m3` Apache-2.0，模型仓库未列 ONNX 文件；`intfloat/multilingual-e5-small` MIT，含 ONNX；`ncbi/MedCPT-*` `license:other`。— [HF API](https://huggingface.co/api/models/BAAI/bge-m3)。包：`FlagEmbedding` 1.4.2（2026-08-24），`fastembed` 0.9.1（2026-10-24），`sentence-transformers` 6.2.0（2026-10-21），`bm25s` 0.3.16（2026-10-28，MIT），`pyserini` 2.4.0（2026-08-27，Apache-2.0）。— PyPI / GitHub API 查询。
- 中文基准：CHIP-CTC（来自 ChiCTR）是把标准分类到 44 个语义类，训练/验证/测试 22,962 / 7,682 / 10,000，不是患者匹配。— [CBLUE](https://arxiv.org/pdf/2106.08087) [仅检索摘要]。2021 年有 ChiCTR 标准语义分类研究。— [PMC8050926](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8050926/) [仅检索摘要]
- 2024 年 BMC Cancer 评价了广州一家机构的肝癌试验匹配系统（规则加 NLP，两个试验），数据不开放。— [PMC10885498](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10885498/) [仅检索摘要，数字未读]
- 控制面已有 DashScope reranker 和知识库 embedder，`methodSimilarity.mjs` 已把方法文本送去嵌入；真实患者文本可由云端模型处理（owner 2026-10-10）。— 仓库 `CLAUDE.md`。

### Inferences
- **最窄适配**：不建本地索引。三个注册库的合并结果已在手上，直接用已有 DashScope reranker 排序，LLM 只负责把病情写成中英两份查询。无新进程、无 GPU、无模型文件。合并结果的召回受注册库自身检索限制，要到真的漏试验再考虑 AACT 快照。
- **不要把 BM25 与向量做等权融合用于中文查询英文**：0.620 掉到 0.330。若要 BM25，先把查询翻成英文（TrialGPT 式关键词），或只在同语种内用。
- **LLM 判前 N 只作排序信号，判定仍由代码**。零样本提示重排的 0.593 提醒：排序提示不调就可能变差，先用 cross-encoder，它不需要标注。TrialGPT 1 的组合分 0.7275 与纯 LLM 分 0.7252 几乎相同（前一份笔记），但这没有告诉我们纯代码排序能到多少，应该先测标准判定比例排序。
- 真实病历上的排序收益没有数字：TREC 全部是合成描述或问卷。

### Gaps
- TREC 2023 没有官方 overview，全榜未核实。
- BGE-M3 在四核共享主机上的 ONNX 延迟我没有实测，也没有找到可信数字（第三方表格不引）。
- 没有找到开放的中文患者—试验匹配基准，也没有 Qwen/DeepSeek 在中文病历上的筛选评测（两次检索）。要说明中文效果只能自建小样本，且不能算外部证据。

---

## 结构化标准解析：Criteria2Query、EliIE、Leaf、CTKG、OMOP 队列

### Takeaway
LLM 解析的概念抽取已相当好（C2Q 3.0 F1 0.891），但一旦要落到 OMOP 队列，概念映射和逻辑仍然崩。我们已有“解析一次、代码组合”的文法；解析质量的短板不是抽实体，而是定义不够具体。OMOP / ATLAS 只对持有 OMOP 库的用户有意义。

### Cited Findings
- C2Q 3.0：见上表；三段 GPT-4 提示，半自动。— [PMID 38697494](https://pubmed.ncbi.nlm.nih.gov/38697494/) [仅摘要]
- Lee 2025：映射 48.5%，幻觉 32.7%，Jaccard 0.81 到 0.00；时间约束和依赖上下文的条件造成遗漏或逻辑误读，没有单独的时间准确率。文中称 Criteria2Query 实体识别 60%-70%，但同一数字一处归给 C2Q 3.0，一处归给原版，**两篇互相不一致**，不要引用。— [PMC12530336](https://pmc.ncbi.nlm.nih.gov/articles/PMC12530336/)
- Leaf Clinical Trials corpus：1,000 余条人工标注的标准，粒度很细，建立在 EliIE 和 Chia 模式上，带基线抽取结果。— [Sci Data 2022](https://doi.org/10.1038/s41597-022-01521-0) [仅摘要]
- EliIE（Kang 2017）把标准转成 OMOP 查询，早于调研窗口。— [PMC6371316](https://pmc.ncbi.nlm.nih.gov/articles/PMC6371316) [仅检索摘要]
- Leaf 工具本身是拖拽式布尔队列 web 应用，与 ATLAS 并列用于教学。— [Mount Sinai 培训材料 2025](https://labs.icahn.mssm.edu/minervalab/wp-content/uploads/sites/342/2025/03/Leaf-and-Atlas-Training-03.05.25.pdf) [仅检索摘要]
- 实现：`OHDSI/Criteria2Query` Apache-2.0（最后提交 2026-03）；`ashwinn-v/Criteria2Query3.0` Apache-2.0（2024-01，个人仓库，0 星，是否官方未核实）；`OHDSI/Atlas` 与 `WebAPI` Apache-2.0；`CirceR` CRAN 1.3.3 Apache-2.0；`OHDSI/Usagi`、`CohortGenerator` 的 GitHub 未识别出 SPDX 许可。— GitHub API、[CRAN](https://cran.r-project.org/web/packages/CirceR/index.html)
- 早期 ClinicalTrials.gov 结构化字段（年龄、性别、健康志愿者）我们已用闭表过滤。— 背景材料。

### Inferences
- 借 C2Q 的不是系统，而是一个提醒：它的错误集中在逻辑（34.48%）。我们用文法加 Kleene 代码组合，逻辑错误应由解析抽检（PRISM 式 1%/2%/89%）来监视，不是引入 C2Q。
- 第 3 项“定义卡”才是解析层的主杠杆：n2c2 标准的单句定义不够，Wornow 的 0.85 → 0.93 证明了这一点。
- `CirceR` 可以把队列写成 ATLAS JSON，一旦有 OMOP 用户，可作为 `cohort.build` 的导出；不需要概念集以外的新运行时，但需要 OMOP 概念 ID，这本身又要映射（48.5% 的问题）。

### Gaps
- **CTKG**：一次 PubMed 精确检索和一次网页检索都没有找到“Clinical Trials Knowledge Graph”的可确认论文与许可。[未核实]，未列入候选。
- ClinicalTrials.gov 是否有新的结构化入排字段：我没有在调研窗口内找到官方说明。

---

## 非 LLM 临床 NLP：medspaCy、MedCAT、scispaCy、cTAKES，否定与断言，章节识别

### Takeaway
这类工具在我们这里基本不值得进运行时：没有中文、规则部分和 owner 的“regex 不做语言”相冲，而且 NER 预过滤的唯一直接实验是有害的。唯一可以考虑的用途是离线诊断，抽查假 met 里有没有否定、家族史、假设语境。

### Cited Findings
- 否定检测头对头：984 份放射报告、2,800 个术语、13.8% 被否定；medspaCy 召回 0.795、精确率 0.356、F1 0.492；CAN-BERT 召回 0.785、精确率 0.768、F1 0.777。— [PMC12092861](https://pmc.ncbi.nlm.nih.gov/articles/PMC12092861/) [仅摘要]
- 断言检测：NegEx 0.897；GPT-4o 0.901；微调 LLM 0.962；LLM 比他们的深度学习模型慢 100 倍、贵数千倍。— [arXiv 2503.17425](https://arxiv.org/abs/2503.17425v1) [厂商：John Snow Labs]
- 作为预过滤：把长记录 NER 压缩后，Llama 3.1 8b micro F1 0.8671 → 0.8293，作者解释为 NER 丢了信息；MedGemma 0.8849 → 0.8629。— [arXiv 2604.05190](https://arxiv.org/pdf/2604.05190) [单一来源]
- 规则系统并未过时的基线：n2c2 2018 第一名 0.91 是规则系统（Graz），前 10 名没有纯 ML。— [PMC6798568](https://pmc.ncbi.nlm.nih.gov/articles/PMC6798568)。但那依赖对 13 条固定标准手写规则，产品不可能对每个试验这么做（我的判断）。
- medspaCy 语言表：英语完整，法语 ConText，荷兰语 ConText，其余欧洲语言很少；**中文不在表中**。— [medspaCy README](https://github.com/medspacy/medspacy)。论文说规则方法仍有重要地位。— [AMIA 2021](https://pubmed.ncbi.nlm.nih.gov/35308962/) [仅摘要]
- MedCAT：公开集 UMLS 抽取 F1 0.448-0.738（比较方 0.429-0.650）；SNOMED CT 在伦敦三院跨院 F1 > 0.94，但用了约 17M 记录自监督和约 6K 人工标注。— [Artif Intell Med 2021](https://doi.org/10.1016/j.artmed.2021.102083) [仅摘要，且早于窗口]
- 包事实：`medspacy` 1.3.1（2024-11-21），MIT；`medcat` 2.10.1（2026-10-29），Apache-2.0，`CogStack/MedCAT` 已归档，开发转 `CogStack/cogstack-nlp`；`scispacy` 0.6.2（2025-10-01），Apache-2.0；`apache/ctakes` Apache-2.0，2026-08 有提交；`QuickUMLS` MIT，2024-08，需要本地 UMLS。— PyPI / GitHub API。
- 我们的流水线里，模型写的事实中 polarity 丢弃很少（第三次 `polarity_invalid` 1 条），真正大量丢失的是引文找不到（第四次 `quote_not_found` 80、`quote_missing` 57）。— `results/heldout-4-2026-11-02.json` `facts`。

### Inferences
- 作为“对 LLM 输出的检查”：除了仓库已有的引文回读，我没有找到一篇论文实测过“规则否定检查给 LLM 抽取减了多少错”。**这个用法缺证据**。
- 第四次的假 met 集中在 ABDOMINAL、ASP-FOR-MI，README 读过的案例看是“算什么”的分歧，不是否定错误。这更支持定义卡，而不是否定工具。
- 章节识别：没有规则的语言替代是让模型在每条记录上报“这条记录有哪些区域（用药列表、问题列表、检验）”并给出引文，代码再判定“这个区域在、这个药不在”。这可以给 `whenSilent` 提供证据基础，是否值得还要测。这是**我的设计推断，没有文献直接评测**。
- 离线诊断可用 medspaCy 跑英文 n2c2 的假 met，只用于研究，不进运行时，不符合“regex 不做语言”的部分就不进产品。

### Gaps
- 没有找到 LLM 与 ConText 在同一临床语料上的头对头对比。CAN-BERT 不是 LLM。
- CPU 上这几个工具的资源占用没有实测。

---

## 时间推理：HeidelTime、SUTime、TIMEX3、时间线抽取、文档日期锚定

### Takeaway
文档日期锚定是默认做法，证据支持，也有明确的失败方式：已有事实落进新记录的窗口（过去事件），以及状态类事实不延续。规则时间标注器对我们没有增量：绝对日期是格式，相对表达交给模型，算术交给代码。真正缺的是事件/状态分型和部分日期的区间判定。

### Cited Findings
**支持锚定**
- Wornow 给时间约束标准用“窗口内最近一条记录”规则，每条记录一次调用：MI-6MOS F1 0.857 / 0.987，DIETSUPP-2MOS 0.907 / 0.907，KETO-1YR 无阳性。每次调用天然只看一条有日期的记录。— [arXiv 2402.05125](https://arxiv.org/abs/2402.05125) 表 S1、S2
- ChemoTimelines 2025（UW-BioNLP）：把每条记录的 DOCTIME（代码按固定格式识别）作为 Timenorm 归一相对表达的锚；微调 Qwen3-14B 官方分 0.678。零样本提示在这个任务上表现差。— [arXiv 2512.04518](https://arxiv.org/pdf/2512.04518)
- CliniCIRCA 把事件抽取与时间锚定分成两段，用入院日、出院日、出生日锚定，打 EXACT / 近似标签；只有明写的日期算 EXACT。52 份出院小结上 Temporal Tag 评分 Gemini 2.5 Pro 4.83/5、Qwen 3.6 35B 4.23、MedGemma 27B 2.67。人工在 50/52 份里发现至少一处时间错，LLM 评审在 46 份。— [arXiv 2609.19585](https://arxiv.org/pdf/2609.19585) [单一来源，精神科，不是资格任务]
- 仓库第四次：`undated` 146 → 26，unknown 0.615 → 0.538；MI-6MOS 严格 0.198 → 0.401，DIETSUPP-2MOS 0.012 → 0.432。— `README.md`，Fourth run。这是目前对“资格时间窗上锚定”最直接的证据，但为已看过的患者，同一数据集。

**反对或限制**
- 过去事件：无保护时 18/149 假 met；加模型标记（`temporality: historical`）后 2/149，但 12 个正确 met 中 9 个回到 unknown。— 同上。
- 状态延续失败：16/84 的 DIETSUPP 变假 not met。— 同上。
- 错绑记录：第四次 2.8%（49/1,762），排除出生日期行后 2.4%（42/1,762）；n2c2 每条记录都有表头，其他来源未必。— 同上。**中文表头未测**。
- RAG 打断时间线：MI-6MOS 0.8752 → 0.7244。— [arXiv 2604.05190](https://arxiv.org/pdf/2604.05190) [单一来源]
- 早期 UTSW 流水线 RAG top-5 上 MI-6MOS 准确率 0.65。— 前一份笔记，[PMC11162699](https://pmc.ncbi.nlm.nih.gov/articles/PMC11162699/)
- 事件定位比排序难：O1-preview 事件召回 0.80，时间一致性 0.95，病例报告上。— [arXiv 2504.12350](https://arxiv.org/abs/2504.12350v1)
- GPT-4 抽 MMSE 分数和日期 765 份记录 83%，错误含日期错。— [PMC11713360](https://pmc.ncbi.nlm.nih.gov/articles/PMC11713360) [仅检索摘要]

**规则工具**
- 相对与不完整时间表达的规则归一：i2b2 2012 留出集 57.2%，宽松匹配 82.09%。— [arXiv 1510.04972](https://www.arxiv.org/pdf/1510.04972) [仅检索摘要，数字未在我读到的摘要片段内确认]
- HeidelTime 被 i2b2 2012 多个系统使用（Jindal & Roth、MayoTime），TempEval-2 最好的规则标注器。— [PMC4193667](https://pmc.ncbi.nlm.nih.gov/articles/PMC4193667)，[PMC3756272](https://pmc.ncbi.nlm.nih.gov/articles/PMC3756272)。时序关系最好的混合系统 F 69.3%。— [PMC3855590](https://pmc.ncbi.nlm.nih.gov/articles/PMC3855590)。均早于窗口。
- 实现：`HeidelTime/heideltime` GPL-3.0，最后提交 2023-04；`py-heideltime` 1.0.6（2023-11）；SUTime 在 `stanfordnlp/CoreNLP` 中，GPL-3.0，2026-11 仍有提交。GPL 只是事实列明；它们是 Java 依赖，HeidelTime 还要 TreeTagger（我的记忆，未在本次核实）。— GitHub / PyPI API
- 语料：MIMIC-IV-Ext-22MCTS 以入院为 t=0，说明明确写“时序抽取和推理仍是 LLM 的易错任务”。— [PhysioNet](https://physionet.org/content/mimic-iv-ext-22mcts/1.0.0/) [仅检索摘要]。PMOA-TTS 是大规模病例报告时间序列语料。— [arXiv 2505.20323](https://arxiv.org/html/2505.20323v2)。EliXR-TIME 是标准侧的时间表达框架，语义标注一致 72%。— [eScholarship](https://escholarship.org/uc/item/63f8p72f) [仅检索摘要，较旧]

### Inferences
**这里有三件可做的代码，都不用 LLM 判定，也不用规则读语言**：
1. **事件 / 状态分型。** 模型把事实标为一次性事件或持续状态（现有 `temporality` 的扩展）。代码：事件以事件日期比窗口；状态从观察日向后延续，直到后面的记录改变它，或超过上限。预期解决 DIETSUPP 16/84。需要定上限默认值，且无文献给数字，应做成解析时给定的标准属性。
2. **部分日期转区间。** `2/2087` 不是错误，是 `[2087-02-01, 2087-02-28]`。全在窗口内为真，全在窗口外为假，跨边界为 unknown，这正是 Kleene。第二次运行中模型写的 157 个日期只留 38 个，其中 MI 的 36 个只留 2 个。目前这些日期被丢弃、事实保留为 `undated` 或按表头定。
3. **相对表达。** 模型输出结构（锚点 + 偏移 + 单位 + 引文），代码做加减，符合“模型读语言、代码算”的规则。没有文献直接比较这种写法和让模型直接写日期。可在开发集上比较。

- 文档日期锚定**应作为默认**，配合过去事件保护。第四次的保护已用数字证明了取舍，是目前能见到最细的公开证据之一，建议补一个中文表头样本再固化。
- HeidelTime / SUTime 不值得：绝对日期解析靠格式；相对表达是语言判断，按规定归模型。n2c2 英文上它们也不会减少 `not_recorded`。

### Gaps
- **没有找到一篇论文在资格任务上用 LLM 专门评测“过去 6 个月”这类窗口的错误分解。** Massive Bio 的 32% 不一致来自复杂时间逻辑（前一份笔记）是最近的二手数字。
- 没有 LLM 与 HeidelTime、SUTime 在 i2b2 2012 或 Clinical TempEval 上的头对头（两次检索）。
- 没有找到反对“文档日期锚定默认”的实证研究；反证只是上面这些失败模式。
- 状态延续的合理上限没有文献依据。

---

## 检验归一与术语映射：LOINC、UMLS、SNOMED CT、RxNorm、单位、中文术语

### Takeaway
在 n2c2 上这一层几乎不影响 unknown（第四次单位类仅 4 对）。在中文真实病历上才可能重要，而那时最好的证据是 LLM 代理而不是字典或裸嵌入。现阶段不建术语服务，继续靠闭表和模型；等真实中文病历暴露问题再加。

### Cited Findings
- LabBridge（JMIR 2026）：语言归一 + 混合检索 + 受约束 LLM。两组真实急诊检验数据，中文和英文，5 个 LLM。全覆盖准确率 81%-90%，DeepSeek-V3 两种语言都是 90%，GPT-4o 88%-89%；中文上 BGE-M3 单独 24%，最佳 RAG 49%。对照集是约 1,487 个临床常用 LOINC（预印本数字；发表版下界 81% 与预印本 83% 不同）。— [JMIR e92499](https://www.jmir.org/2026/1/e92499) [摘要读过；代码是否开放未核实，单一来源]
- 这个 24% 与 MMed-Bench 的高分不矛盾：一个是短检验名对闭集编码，一个是问题对文档；同一个嵌入模型在不同任务上差很多（我的判断）。
- 其他 LOINC：LabAlignAgent（沙特）77.1% 映射（202/262）；OCL 上的 scispaCy LOINC 研究数字未读。— [检索摘要](https://www.informatica.si/index.php/informatica/article/view/14039) [仅检索摘要，对应关系未核实]。Tu et al. 2022 预训练模型 LOINC 标准化。— [PMLR v193](https://proceedings.mlr.press/v193/tu22a.html) [未读数字]
- 中文对齐 UMLS：先翻译再 SapBERT + TF-IDF 线性组合，top-5 准确率 ICD10-CN 91.85%、CHPO 82.44%、RealWorld 78.43%。— [Health Data Sci 2023](https://doi.org/10.34133/hds.0011) [仅摘要]
- SNOMED CT：SNOMED International 2019 与神州数码健康签教育合作；官方分发列表摘录含香港，我没有看到中国内地列为成员的证据。成员国内免费，其他地区需要许可。— [SNOMED](https://snomed.org/news/snomed-international-signs-education-delivery-agreement-with-digital-china-health-technologies-co)，[membership](https://www.snomed.org/membership-benefits) [仅检索摘要；中国内地成员身份未核实]
- 单位：`@lhncbc/ucum-lhc` npm 8.0.1（2026-10-19，NLM 出品）适合 Node 控制面，其 LICENSE.md 我只看到开头，未核实条款；`pint` 0.26.2（2026-10-19，Python，BSD 式许可头）。— npm、PyPI、GitHub。
- 当前现状：`clinicalUnits.mjs` 闭表，HbA1c 约定百分比；单位修复已把 HBA1C 严格分从 0.06 提到 0.38。— `README.md`

### Inferences
- 单位这条路已经摘到主要果实；`ucum-lhc` 不改变 n2c2 数字，但中国病历常见 μmol/L、mmol/L，真遇到时用一个库比手写闭表更安全，符合“复用上游”。
- 不需要自建 UMLS 服务：模型本身能处理 ASA 和 aspirin；要做“查无”校验（第 5 项）时，让解析阶段产生中英同义词列表，比依赖许可受限的术语库更窄，这是我的判断。
- LabBridge 的 DeepSeek-V3 90% 对我们意义最大，因为同模型系、同语言；但它依赖 LOINC 候选库和受约束提示，且单一来源。

### Gaps
- CHPO 官方许可与最近版本：[未核实]，两次检索没有找到 chpo 官网的确定信息。
- ICD-10 中文国家临床版与 OMOP 的映射：未找到公开、可用的映射说明。
- LOINC 中文语言变体与当前许可：loinc.org 返回 403，[未核实]。
- RxNorm 无中文这件事我没有查到明确文献，只是常识。
- UMLS 中文来源的覆盖范围未核实。

---

## 弃权与校准：选择性预测、保形预测，如何减 unknown 而不增加假 met

### Takeaway
没有找到把保形预测用在试验资格上的已发表评测。它本身不会减少 unknown，只会控制判定的风险，相当于加闸。对我们来说，减 unknown 的是 `whenSilent` 和补读，控假 met 的是定义卡和证据核验，保形要等有独立校准集才有意义。

### Cited Findings
- 明确的资格任务分诊：Peppoloni 以证据完整度和冲突分流，49% 全自动区 0% 假阳性，其余 51% 转人工（77 + 30 人）。— [NeurIPS 页面](https://neurips.cc/virtual/2026/163744) [单一来源，海报]。我们不能照抄“转人工”，owner 不接受新增人工步骤，只能表现为 unknown。
- Massive Bio：约 15% 低置信或冲突对优先人工；“Requires Clinician Judgment”不计入 F1，会抬高分数。— 前一份笔记，[PMC13091143](https://pmc.ncbi.nlm.nih.gov/articles/PMC13091143/) [厂商]
- den Hamer 把保形预测作为“最合适”的未来方向，未实现；同一患者 10 次运行，温度 0 的精确率和召回波动小于温度 1，但仍有波动。— [arXiv 2304.07396](https://arxiv.org/pdf/2304.07396) [厂商]
- MedAbstain：给医学选择题加保形预测、对抗扰动和显式弃权选项；显式弃权选项比输入扰动更能增加不确定性和安全弃权，增大模型和高级提示收益很小；数据是 CC-BY-NC 4.0。— [arXiv 2601.12471](https://arxiv.org/abs/2601.12471) [选择题，不是资格]
- SCoRE：可自定义风险的保形选择框架，药物发现、健康风险和 LLM 上评测，不是资格任务。— [arXiv 2603.24704](https://arxiv.org/pdf/2603.24704) [仅检索摘要]
- 实现：`mapie` 1.6.0（2026-10-19），`crepes` 0.9.1（2026-06-12），均为 BSD 式许可头（未全文比对）。— PyPI、GitHub。
- 仓库数字：第三次 → 第四次，决定时正确率 0.921 → 0.873，假 met 0.046 → 0.087，unknown 0.615 → 0.538。这是一条真实的覆盖—风险曲线的两点，只不过混入了技能文本和样本变化。— `README.md`
- 决定时正确率按标准差异巨大（第一次：ABDOMINAL 0.63，MAKES-DECISIONS 0.78，CREATININE 0.98）。— `README.md`，Test results。

### Inferences
- **按标准类别校准，而不是全局。** 保形的一个可用形式是 Mondrian（按类别），`crepes` 支持。但类别数 × 每类样本量很快把 162 人耗尽，所以不是现在做。
- **校准集的可交换性是死结**：n2c2 是英文糖尿病人群；用它校准中文病历和肿瘤试验，覆盖保证不成立。没有校准集之前任何“保形保证”都不能写在产品上。
- **免费的代替品**：每个判定已经带引文和来源，代码可以算“证据强度”（引文是否回读通过、日期来自本人还是表头、是否仅上界、是否按约定单位），只作排序信号，不扣留。这与 owner 的 ✓/⚠ 标记一致，也不增加闸门。没有文献评测，是推断。
- **两次采样一致性**可以当校准信号，仓库学习循环已对 `adopt` 用了同样的做法。代价是调用翻倍；先在开发集上做风险覆盖曲线，再决定。
- `whenSilent` 对“不增加假 met”这一条是结构性安全的：默认未见不产生 met；默认 met 只应用于指南或解析明确写了默认的标准，这里只有 ENGLISH、MAKES-DECISIONS，共增加 4 对假 met。

### Gaps
- 没有已发表的资格任务保形预测或校准评测（三次相关检索）。
- 没有资料给出 DeepSeek Flash 自报置信度在资格任务上的校准情况，也没有测过。
- 没有发表的“减少 unknown 同时保持假 met”的数字；最接近的是仓库自己的四次运行。

---

## n2c2 2018 Track 1：所有方法的已报告结果，以及我们 0.869 的可比性

### Takeaway
公式相同（官方评分器），但不可比。0.869 来自留出训练患者上的第三次运行，并用了事先冻结但事后映射的读法（unknown 算未满足，两条默认满足）。官方测试集上的唯一数字是更早的流水线 (c) 0.8293。分支上已有 0.8809，同样不是干净估计。可以说“读法 (c) 下处于比赛均值和榜首之间”，不能说“接近 SOTA”。

### Cited Findings

| 方法 | 划分 | Micro F1 | Macro F1 | 时间窗标准 | 备注 | 来源 |
|---|---|---|---|---|---|---|
| Graz 规则系统（2019） | 官方测试 86 | 0.91 | 0.75 | 竞赛逐项最佳 MI 0.876（Tai 表 3，不一定是 Graz） | 手写规则，用 202 名训练患者 | [PMC6798568](https://pmc.ncbi.nlm.nih.gov/articles/PMC6798568)；[Wornow](https://arxiv.org/abs/2402.05125) 列 macro |
| 109 提交均值（2019） | 同上 | 0.799 | | | 第二名 0.9075 | `README.md` 引 Stubbs 表 2 |
| Wornow GPT-4 ACIN（2024） | 同上 | 0.93（未细化定义 0.85） | 0.81 | MI 0.857 / 0.987，DIETSUPP 0.907 / 0.907 | 用训练患者手工细化定义；二值输出；成本 $133 | [arXiv 2402.05125](https://arxiv.org/abs/2402.05125) |
| Wornow 其他模型 | 同上 | GPT-3.5 0.80，Mixtral 0.79，Llama-2-70b 0.67 | 0.59 / 0.64 / 0.46 | | 零样本 | 同上 |
| Chen 2026 MedGemma LoRA + RAG | 161/41/86 官方测试 | 0.8905 | 0.7896 | MI 0.7244，DIETSUPP 0.8010，KETO 0.5 | 微调；需要 GPU | [arXiv 2604.05190](https://arxiv.org/pdf/2604.05190) |
| Chen 2026 MedGemma 全文 | 同上 | 0.8849 | 0.7782 | MI 0.8752，DIETSUPP 0.7628 | | 同上 |
| Chen 2026 BERT | 同上 | 0.7240 | 0.4859 | | | 同上 |
| Tai & Tannier 2025 | 测试集，5-shot | 文中无总分 | | vicuna-13b：MI 0.414，DIETSUPP 0.730 | 指标按“met”类，我推断 | [arXiv 2501.11114](https://arxiv.org/pdf/2501.11114) |
| Beattie 2024 | 182 留出 / 40 | GPT-3.5 0.7852；GPT-4 0.8589 | | MI 准确率 0.65 | | [PMC11162699](https://pmc.ncbi.nlm.nih.gov/articles/PMC11162699/) |
| Inato 2025 | 288 全部 | 准确率 93%，不是 F1 | | | [厂商，仅摘要] | [arXiv 2503.15374](https://arxiv.org/abs/2503.15374) |
| EviMed 第一次 | 官方测试 86，只跑一次 | (b) 0.6751，(c) 0.8293 | 0.5833 / 0.6677 | | 三值输出，提示词只调形式 | `README.md` |
| EviMed 第三次 | 162 留出训练，已看过 | (b) 0.7226，(c) 0.8690 | 0.6298 / 0.7413 | | 即 0.869 | 同上 |
| EviMed 第四次 | 同上，再次看过 | (b) 0.7390，(c) 0.8809 | 0.6532 / — | MI 严格 0.401 | `int/1102` | 同上 |
| 多数类基线 | 162 / 官方 | 0.7595 / 0.7608 | 0.426 | | 不读记录 | 同上 |

- 我们的公式与官方相同（`track1_eval.py`），README 说自算与官方到四位小数一致。— `README.md`
- Chen 表 3 的 Micro-F1 0.8905、Micro-Prec 0.8602、Micro-Rec 0.8845 不满足调和平均（后两者的调和平均约 0.872）；Wornow 的 0.93 与 P 0.91、R 0.92 同样如此 [自算]。这与官方评分器“met 与 not met 两个 F1 的平均”一致，是推断，两篇都未写明。— [Chen](https://arxiv.org/pdf/2604.05190)，[Wornow](https://arxiv.org/abs/2402.05125)
- 标注者 kappa 平均 0.54，ADVANCED-CAD 0.37，MAKES-DECISIONS 0.31，KETO-1YR -0.1。— [PMC6798568](https://pmc.ncbi.nlm.nih.gov/articles/PMC6798568)，`README.md`，Limits

### Inferences
- **四点不可比**：(1) 患者不同。162 是训练集留出，已被三次运行看过；同样的流水线在官方测试上没有数字。(2) 输出不同。其他系统被要求二值作答，unknown 映射是我们加的。(3) 学习对象不同。其他系统大多用 202 名训练患者的约定；Wornow 的定义是看过这些患者后手写的。(4) (c) 的增益大半来自两条 95% met 的标准。
- 可以说的：(c) 口径 0.869 / 0.881 高于比赛均值 0.799、高于多数类基线 0.76，低于第一名 0.91 和 Wornow 0.93。如果按 (b)，仍低于基线，这是同一事实的另一面。
- **到 0.91-0.93 差的不是 unknown，而是错判**：决定时只有 0.87 到 0.92。Wornow 的未细化定义 0.85 → 细化 0.93，与我们的差距量级相同，这是把定义卡排前面的最强依据。
- DeepSeek Flash 与 GPT-4 的差异未单独测。Wornow 的 GPT-3.5 只有 0.80，模型差异可能占一部分。

### Gaps
- 没有 n2c2 2018 上 DeepSeek 其他系统的已发表结果。
- 没有找到报告 unknown 比例并同时报告官方 F1 的外部系统，所以我们的三值口径没有同类可比。
- Tai & Tannier 总分未见；竞赛“最佳”逐项值来自它的表 3，二手。
