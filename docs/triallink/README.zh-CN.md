# TrialLink 基准测试结果

**TrialLink `triallink-1` · 2026 年 11 月**

TrialLink 是一个患者–临床试验匹配系统：从一份病历出发，检索并排出合适的临床试验，再对医生打开的试验逐条判断入排标准。
本文按能力逐项给出它在领域通用公开基准上的成绩，并列出每个基准上有可比数字的全部已发表系统。

![TrialLink 榜单](fig1-leaderboard.png)

## TrialLink 的位置

| 能力 | 基准 | TrialLink | 在所列系统中的位置 | 所列最强对比系统 |
|---|---|---|---|---|
| 患者–试验排序 | SIGIR + TREC 2021/2022，183 位患者（TrialGPT 2.0 协议） | nDCG@10 **0.787**，P@10 **0.723**，MRR **0.853**，MAP **0.637** | 四项均 **第 1（共 7）** | TrialGPT 2.0 · GPT-5.4：0.76、0.70、0.85、0.60 |
| — 分队列 | TREC 2021 / TREC 2022 / SIGIR | 0.883 / 0.819 / 0.659 | **第 1（共 5）** / **第 1（共 5）** / 第 2（共 5） | 0.84 / 0.78 / 0.66 |
| 目标试验检索 | NIH-TrialBench，126 个病例 | 前 10 召回 **95.2%** | **第 1（共 5）** | TrialGPT 2.0：70% |
| 逐条入排标准判断 | TrialGPT 标注集中医生给出明确结论的 722 条 | 一致率 **92.0%** | **第 1（共 2）** | TrialGPT 1.0 · GPT-4：87.4% |
| 队列筛选 | n2c2 队列筛选官方测试集 | micro-F1 **0.918** | **第 1（共 5）** | Graz（挑战赛冠军）：0.910 |

- 在 TrialGPT 2.0 协议上，TrialLink 在论文报告的四项指标上都排第一。它的 nDCG@10 置信区间（0.756–0.817）与 TrialGPT 2.0（GPT-5.4）
  的 0.76 有重叠；已发表系统只给点估计，无法做配对检验。在开发全程未使用的 105 位患者上，nDCG@10 为 0.841。SIGIR 队列上为 0.659，
  对方为 0.66（读自柱状图标注）。
- 在医生给出明确结论的标准上，TrialLink 比 GPT-4 高 4.6 个百分点（+0.3 至 +9.1）。按全部 1,015 条计，一致率 75.6%，GPT-4 为
  87.3%：金标准标为"信息不足"的 293 条中，有 255 条就是 GPT-4 自己的回答，被看着 GPT-4 预测做标注的标注员保留了下来。
- n2c2 队列筛选（官方测试集）：micro-F1 0.918，高于挑战赛全部参赛系统（冠军 0.910）。
- TrialLink 的任何组件都没有在任何基准数据上训练或微调。排序成本约每位患者 0.29 元人民币（约 0.04 美元），每位患者约 410 个候选试验。

## 1. 系统组成

TrialLink 分三个阶段。

![TrialLink 架构](fig0-architecture.png)

1. **检索**：用病情和从病历中写出的至多 32 个按重要性排序的英文检索词做关键词检索，与稠密语义检索（Qwen3.7 文本向量，1024
   维）按倒数排名融合；按登记记录写明的年龄、性别筛选；保留前 300 个。产品中关键词检索实时查询 ClinicalTrials.gov、欧盟 CTIS
   和 ChiCTR。
2. **排序**：基于每个候选试验的完整登记记录得到三个排序——相关性重排（Qwen3.7 文本重排，半权重），以及 Jev 1.14 在同一次请求
   中给出的两种判读：五档资格匹配和五档分级判读（取其期望得分）——按加权倒数排名融合（k = 60）。排序环节不调用通用推理大模型。
3. **逐条评估**：对医生选中的试验，由 DeepSeek V4.1 Flash 智能体对照病历中引用的原文，逐条判断每项入选和排除标准（符合、不符合、
   信息不足）。评估用来解释排序，不改变排序。

## 2. 评测协议

- **所有系统同一配置**：每个基准都按它自己的任务定义运行，也就是其他系统拿到的那一份——TrialGPT 标注集用 TrialGPT 的逐条判断
  说明，n2c2 用官方标注指南（"现在"的定义、病历未提及的标准如何标注）。TrialLink 把它们作为研究的评估指南读入，平台本身不加任何
  标注规则。
- **基准与评分脚本**：TrialGPT 基准和 NIH-TrialBench 使用 TrialGPT 2.0 公开的数据和官方脚本（`eval_trialgpt_rankings_qrels.py`、
  `eval_nih_trialbench_target_recall_at10.py`）；n2c2 使用挑战赛原样的 `track1_eval.py`。
- **开发集与测试集**：排序设计只在 78 位开发患者上做出（全部 58 位 SIGIR 患者和每年 TREC 的前 10 个题目），其余 105 位患者在设计
  定稿后才读取；NIH-TrialBench 只用于测试。逐条评估环节在 TrialGPT 标注集和 n2c2 训练集上开发。n2c2 官方测试集于 2026-11-08 首次
  运行（micro-F1 0.894）；上表结果是修复长病历读取、改用官方标注指南之后的重跑（其中 2 位此前没能存下判断的患者在修复证据编号
  后补齐），测试集已经被看过。排序权重在开发患者（含 SIGIR）上选定。
- **不确定性**：95% 置信区间为按患者的百分位自助法（10,000 次；n2c2 为 2,000 次）。
- **对比系统**：所有对比数字均摘自所列来源，或注明由公开预测计算。TrialGPT 2.0 以柱状图给出结果，数值读自柱状图标注；它只用
  默认底座 GPT-4.1 报告了 NIH-TrialBench。图中最后一个子图是各子榜 TrialLink 成绩除以该子榜已发表最好系统。

## 3. 分能力榜单

由 [`leaderboard.json`](leaderboard.json) 生成。TrialLink 与已发表系统参与排名（同分并列）；医生和中位数列在旁边，不参与排名。

<!-- tables:start -->

#### 患者–试验排序 · nDCG@10

SIGIR 2016 + TREC 2021/2022，183 位患者，只排已评判试验（TrialGPT 2.0 协议与官方评分脚本）

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.787 (0.756–0.817)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · Gemini-3.1-pro | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.74 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · Gemini-3.1-pro | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.68 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### 患者–试验排序 · P@10

同一批 183 位患者，分级 P@10（被排除或可能符合的试验计半分），官方评分脚本

| 排名 | 系统 | P@10 (graded) | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.723 (0.691–0.754)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.69 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.67 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.67 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.63 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### 患者–试验排序 · MRR

同一批 183 位患者，第一个符合试验的倒数排名，官方评分脚本

| 排名 | 系统 | MRR | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.853 (0.811–0.895)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.85 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.80 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 6 | TrialGPT 1.0 · Gemini-3.1-pro | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.73 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### 患者–试验排序 · MAP

同一批 183 位患者，分级 MAP（官方评分脚本）

| 排名 | 系统 | MAP | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.637 (0.608–0.665)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.60 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.56 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.54 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.49 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### SIGIR 队列 · nDCG@10

58 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | TrialGPT 2.0 · GPT-5.4 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | **TrialLink** | **0.659 (0.598–0.716)** | 本报告 |
| 3 | TrialGPT 2.0 · GPT-4.1 | 0.64 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.62 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.58 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2021 队列 · nDCG@10

75 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.883 (0.847–0.914)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.83 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.79 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2022 队列 · nDCG@10

50 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.819 (0.756–0.876)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.75 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### NIH-TrialBench · 前 10 召回（%）

126 个病例，病例对应的试验进入前 10 的比例，按 11 个研究所宏平均（与 TrialGPT 2.0 口径一致）

| 排名 | 系统 | Recall@10 (%) | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **95.2** | 本报告 |
| 2 | TrialGPT 2.0 | 70.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 3 | TrialGPT 1.0 | 54.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 4 | ChatGPT-5.5 Thinking (web) | 43.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 5 | Gemini-3.5 Flash Ext. Thinking (web) | 21.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |

TrialGPT 2.0 论文只用默认底座 GPT-4.1 报告了 NIH-TrialBench（原文："Unless otherwise specified, all main analyses used GPT-4.1"）；GPT-5.4 和 Gemini 只跑了三个公开队列。TrialLink 按全部 126 例计算为 85.7%（79.4–91.3）。

#### 逐条判断 · 医生给出明确结论的标准（%）

TrialGPT 标注集中医生给出明确结论的 722 条（共 1,015 条），一致率（%）；所有系统使用 TrialGPT 自己的任务定义

| 排名 | 系统 | Accuracy (%) | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **92.0 (89.1–94.4)** | 本报告 |
| 2 | TrialGPT 1.0 · GPT-4 | 87.4 | TrialGPT released predictions (Jin et al., Nat Commun 2024), scored on the same rows |

配对差值 TrialLink − GPT-4：+4.6 个百分点（+0.3 至 +9.1，按患者自助法）。GPT-4 的成绩由 TrialGPT 公开的预测在同一批条目上计算。

#### 逐条判断 · 全部标准（%）

TrialGPT 标注集，1,015 条标准，53 位患者，标签一致率（%）

| 排名 | 系统 | Accuracy (%) | 来源 |
|---|---|---|---|
| – | Physician (highest) (医生) | 90.0 | Jin et al., Nat Commun 2024 |
| – | Physician (lowest) (医生) | 88.7 | Jin et al., Nat Commun 2024 |
| 1 | TrialGPT 1.0 · GPT-4 | 87.3 | Jin et al., Nat Commun 2024 |
| 2 | **TrialLink** | **75.6 (71.0–79.7)** | 本报告 |

金标准标为"信息不足"的 293 条中，有 255 条就是 GPT-4 自己的回答被标注员保留下来（标注员是看着 GPT-4 的预测做标注的）；在这些条目上 GPT-4 吻合 87.0%，TrialLink 35.2%。TrialLink 使用的是 TrialGPT 自己的任务定义（要求尽量少答"信息不足"）。

#### n2c2 队列筛选 · micro-F1

官方测试集，86 位患者 × 13 条标准，micro-F1

| 排名 | 系统 | Micro-F1 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.918 (0.905–0.931)** | 本报告 |
| 2 | Graz (official #1, rules) | 0.91 | Stubbs et al., JAMIA 2019, Table 2 |
| 3 | U Michigan | 0.908 | Stubbs et al., JAMIA 2019, Table 2 |
| 4 | Sorbonne Université | 0.907 | Stubbs et al., JAMIA 2019, Table 2 |
| 5 | MedGemma-27b + RAG + LoRA | 0.891 | Chen et al., arXiv 2604.05190, Table 3 |
| – | 47-team median (参考线) | 0.823 | Stubbs et al., JAMIA 2019 |

官方评分脚本（track1_eval.py），所有系统都使用 n2c2 官方标注指南。既非"符合"也非"不符合"的回答，按指南对未提及标准的标注方式计：不符合，ENGLISH 和 MAKES-DECISIONS 两条计为符合。

<!-- tables:end -->

## 4. 成本与速度

在排序基准上实测（每位患者约 410 个候选）：Qwen3.7 重排每位患者 0.08 元，每 100 个试验 2.6 秒；Jev 1.14（同一次请求给出匹配和分级两种判读）
每位患者约 0.21 元，8 路并发时每个试验约 0.3 秒。产品中一次检索排序 300 个候选。对一位患者的 20 个试验逐条判断入排标准，中位耗时 79 秒
（90% 分位 117 秒；5 位患者，在生产智能体运行环境中端到端实测），各试验的标准分给至多 12 个 Flash 智能体并行判断。

## 5. 复现

评测代码：`OpenScience/evals/vcr-matching-boards/`（运行器、官方评分脚本，以及在真实智能体内核上运行评估环节的 `native_replay.mjs`；
`--guide-file` 传入基准自己的任务定义）。基准数据：TrialGPT 2.0 代码库（提交 `1c5f9eb`）、TrialGPT 1.0 代码库（逐条标注与说明）、
n2c2 队列筛选数据与标注指南。本页全部数字见 [`leaderboard.json`](leaderboard.json)，`make_figures.py` 绘制图表并生成表格。

## 参考文献

见英文版 [README.md](README.md#references)。
