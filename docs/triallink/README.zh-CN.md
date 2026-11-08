# TrialLink 基准测试结果

**EviMed · 2026 年 11 月 · TrialLink `triallink-1`**

TrialLink 是 EviMed 的患者–临床试验匹配系统：从一份病历出发，检索并排出合适的临床试验，再对医生打开的试验逐条判断入排标准。
本文按能力逐项给出它在领域通用公开基准上的成绩，并列出每个基准上能找到可比数字的全部已发表系统。

![TrialLink 榜单](fig1-leaderboard.png)

## TrialLink 的位置

| 能力 | 基准 | TrialLink | 在所列系统中的位置 | 已发表最好系统 |
|---|---|---|---|---|
| 患者–试验排序 | SIGIR 2016 + TREC 2021/2022，183 位患者（TrialGPT 2.0 协议） | nDCG@10 **0.775**，MAP **0.617** | 两项均 **第 1（共 7）** | TrialGPT 2.0 · GPT-5.4：0.76、0.60 |
| — 分队列 | TREC 2021 / TREC 2022 / SIGIR 2016 | 0.880 / 0.815 / 0.628 | **第 1（共 5）** / **第 1（共 5）** / 第 3（共 5） | 0.84 / 0.78 / 0.66 |
| 目标试验检索 | NIH-TrialBench，126 个病例 | 前 10 召回 **96.0%** | **第 1（共 5）** | TrialGPT 2.0：70% |
| 全库检索 | TREC CT 2021 / 2022 / 2023 | nDCG@10 0.559 / 0.585 / 0.504（下限） | 第 3（共 6）/ 第 5（共 8）/ 第 6（共 6） | 0.712 / 0.693 / 0.738 |
| 逐条入排标准判断 | TrialGPT 标注集，1,015 条标准 | 一致率 76.7% | 第 2（共 2） | TrialGPT 1.0 · GPT-4：87.3% |
| 队列筛选 | n2c2 2018 Track 1 官方测试集 | micro-F1 0.894 | 第 5（共 9） | GPT-4 零样本：0.93 |

- 凡是"为患者给候选试验排序"的任务，TrialLink 都排第一：TrialGPT 2.0 基准的 nDCG@10 和 MAP、两个 TREC 队列、NIH-TrialBench。
  它在 TrialGPT 2.0 基准上的 nDCG@10 置信区间（0.743–0.806）与 TrialGPT 2.0（GPT-5.4）的 0.76 有重叠；已发表系统只给点估计，
  无法做配对检验。在开发全程未使用的 105 位患者上，nDCG@10 为 0.839。
- TREC 全库检索的官方分数是下限：TREC 只评判了参赛提交检索到的试验，TrialLink 前 10 中有 32%–48% 从未被评判、按不相关计分。
  它在 TREC 2022 上只计符合试验的 P@10 和 RR 高于官方最好提交。
- 逐条判断和 n2c2 衡量的是评估环节的临床判断，这里 TrialLink 落后于基于 GPT-4 的系统；n2c2 的 0.894 高于 47 支参赛队伍中位数
  （0.823），比挑战赛冠军（0.910）低 0.016。
- TrialLink 的任何组件都没有在任何基准数据上训练或微调。排序成本约每位患者 0.24 元人民币（约 0.03 美元），每位患者约 410 个候选试验。

## 1. 系统组成

TrialLink 分三个阶段。

![TrialLink 架构](fig0-architecture.png)

1. **检索**：用病情和从病历中写出的至多 32 个按重要性排序的英文检索词做关键词检索，与稠密语义检索（Qwen3.7 文本向量，1024
   维）按倒数排名融合；按登记记录写明的年龄、性别筛选；保留前 300 个。产品中关键词检索实时查询 ClinicalTrials.gov、欧盟 CTIS
   和 ChiCTR。
2. **排序**：对每个候选试验的完整登记记录做两种互补的判读——相关性重排（Qwen3.7 文本重排）和五档资格匹配评分（Jev 1.14），
   两个排序按倒数排名融合（k = 60）。排序环节不调用通用推理大模型。
3. **逐条评估**：对医生选中的试验，由 DeepSeek V4.1 Flash 智能体对照病历中引用的原文，逐条判断每项入选和排除标准（符合、不符合、
   信息不足）。评估用来解释排序，不改变排序。

## 2. 评测协议

- **基准与评分脚本**：排序与 NIH-TrialBench 使用 TrialGPT 2.0 公开的数据和官方脚本（`eval_trialgpt_rankings_qrels.py`、
  `eval_nih_trialbench_target_recall_at10.py`）；TREC CT 使用官方相关性判定和赛道指标，未评判的试验按不相关计；n2c2 使用挑战赛
  原样的 `track1_eval.py`。
- **两种 P@10**：TrialGPT 2.0 基准的 P@10 是分级的（被排除或可能符合的试验计半分）；TREC CT 的 P@10 只计符合的试验。两者不可比。
- **开发集与留出集**：排序设计只在 78 位开发患者上做出（全部 58 位 SIGIR 患者和每年 TREC 的前 10 个题目），其余 105 位患者在设计
  定稿后才读取；NIH-TrialBench 只用于测试。逐条评估环节在 TrialGPT 标注集上修订过，所以该集是它的开发集；随后在冻结的系统上只跑
  一次 n2c2 官方测试集，按评分前定下的口径计分。
- **不确定性**：95% 置信区间为按患者的百分位自助法（排序和 TREC 10,000 次，n2c2 2,000 次）。
- **对比系统**：所有对比数字均摘自所列来源；TrialGPT 2.0 以柱状图给出结果，数值读自柱状图标注。图中最后一个子图是各子榜
  TrialLink 成绩除以该子榜已发表最好系统。

## 3. 分能力榜单

由 [`leaderboard.json`](leaderboard.json) 生成。TrialLink 与已发表系统参与排名；人工提交、医生、基线和赛道中位数列在旁边，不参与排名。

<!-- tables:start -->

#### 患者–试验排序 · nDCG@10

SIGIR 2016 + TREC 2021/2022，183 位患者，只排已评判试验（TrialGPT 2.0 协议与官方评分脚本）

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.775 (0.743–0.806)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · Gemini-3.1-pro | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.74 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · Gemini-3.1-pro | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.68 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### 患者–试验排序 · MAP

同一批 183 位患者，分级 MAP（官方评分脚本）

| 排名 | 系统 | MAP | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.617 (0.588–0.645)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.60 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 2.0 · Gemini-3.1-pro | 0.56 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 1.0 · Gemini-3.1-pro | 0.55 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3 |
| 6 | TrialGPT 2.0 · GPT-4.1 | 0.54 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 7 | TrialGPT 1.0 · GPT-4.1 | 0.49 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### SIGIR 2016 队列

58 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | TrialGPT 2.0 · GPT-5.4 | 0.66 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 2 | TrialGPT 2.0 · GPT-4.1 | 0.64 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 3 | **TrialLink** | **0.628 (0.567–0.686)** | 本报告 |
| 4 | TrialGPT 1.0 · GPT-5.4 | 0.62 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.58 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2021 队列

75 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.880 (0.844–0.912)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.84 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.83 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.79 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.76 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### TREC 2022 队列

50 位患者，已评判试验，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **0.815 (0.747–0.877)** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-5.4 | 0.78 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 3 | TrialGPT 1.0 · GPT-5.4 | 0.75 | TrialGPT 2.0, arXiv 2609.01202v2, Supp. Fig. 3c |
| 4 | TrialGPT 2.0 · GPT-4.1 | 0.72 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |
| 5 | TrialGPT 1.0 · GPT-4.1 | 0.70 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5d |

#### NIH-TrialBench 目标试验检索

126 个病例，病例对应的试验进入前 10 的比例，按 11 个研究所宏平均（与 TrialGPT 2.0 口径一致）

| 排名 | 系统 | Recall@10 (%) | 来源 |
|---|---|---|---|
| 1 | **TrialLink** | **96.0** | 本报告 |
| 2 | TrialGPT 2.0 · GPT-4.1 | 70.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 3 | TrialGPT 1.0 · GPT-4.1 | 54.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 4 | ChatGPT-5.5 Thinking (web) | 43.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |
| 5 | Gemini-3.5 Flash Ext. Thinking (web) | 21.0 | TrialGPT 2.0, arXiv 2609.01202v2, Fig. 5c |

TrialLink 按全部 126 例计算为 89.7%（84.1–94.4）。

#### TREC CT 2021 全库检索

375,580 个试验，75 个题目，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| – | TDMINER (manual run) (人工提交) | 0.715 | TDMINER, TREC 2021 notebook |
| 1 | h2oloo monoT5 | 0.712 | Pradeep et al., SIGIR 2022, Table 3 |
| 2 | Alibaba DAMO | 0.595 | Pradeep et al., SIGIR 2022, Table 3 |
| 3 | **TrialLink** | **0.559 (0.491–0.624)** | 本报告 |
| 4 | CSIROmed | 0.532 | Pradeep et al., SIGIR 2022, Table 3 |
| 5 | Kusa et al. (BM25+) | 0.513 | Kusa et al., JBI 2023, Table 4 |
| 6 | Peikos et al. (ChatGPT+RM3) | 0.512 | Peikos et al., arXiv 2306.02077, Table 15 |
| – | BM25 on the note (基线) | 0.469 | Peikos et al., arXiv 2306.02077 |
| – | Track median (参考线) | 0.304 | Pradeep et al., SIGIR 2022 |

TrialLink 前 10 中 60% 被评判过；未评判的试验按不相关计分，所以这是下限。

#### TREC CT 2022 全库检索

375,580 个试验，50 个题目，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | Jullien et al. (GPT-4-turbo) | 0.693 | Jullien et al., arXiv 2409.18998, Table 2 |
| 2 | IELAB (GPT-4) | 0.659 | IELAB, TREC 2023 notebook, Table 1 |
| 3 | h2oloo (official #1) | 0.613 | TREC 2022 overview, Table 4 |
| 4 | Kusa et al. (TCRR-Bio) | 0.604 | Kusa et al., JBI 2023, Table 5 |
| 5 | **TrialLink** | **0.585 (0.508–0.660)** | 本报告 |
| 6 | DoSSIER (official #2) | 0.556 | TREC 2022 overview, Table 4 |
| 7 | Peikos et al. (ChatGPT+RM3) | 0.509 | Peikos et al., arXiv 2306.02077, Table 15 |
| 8 | CSIROmed | 0.491 | TREC 2022 overview |
| – | Track median (参考线) | 0.392 | Kusa et al., JBI 2023, Table 5 |

TrialLink 前 10 中 68% 被评判过（下限）。它的 P@10 0.526 和 RR 0.809 高于官方最好提交（0.508、0.726）。

#### TREC CT 2023 全库检索

451,538 个试验，37 个有评判的题目，nDCG@10

| 排名 | 系统 | nDCG@10 | 来源 |
|---|---|---|---|
| 1 | CSIROmed (fine-tuned GPT-3.5) | 0.738 | CSIROmed, TREC 2023 notebook, Table 1 |
| 2 | IELAB (GPT-4) | 0.736 | IELAB, TREC 2023 notebook, Table 2 |
| 3 | DoSSIER | 0.684 | DoSSIER, TREC 2023 notebook, Table 2 |
| 4 | IELAB cross-encoder | 0.672 | IELAB, TREC 2023 notebook |
| – | Track median (参考线) | 0.648 | DoSSIER and CSIROmed, TREC 2023 notebooks |
| – | CSIROmed BM25 (基线) | 0.619 | CSIROmed, TREC 2023 notebook |
| 5 | IELAB dense | 0.577 | IELAB, TREC 2023 notebook |
| 6 | **TrialLink** | **0.504 (0.433–0.573)** | 本报告 |

TrialLink 前 10 中 52% 被评判过（下限）。它的 P@10 0.451 高于赛道中位数 0.394，RR 0.778 为所列最高。

#### 逐条入排标准判断

TrialGPT 标注集，1,015 条标准，53 位患者，标签一致率（%）

| 排名 | 系统 | Accuracy (%) | 来源 |
|---|---|---|---|
| – | Physician (highest) (医生) | 90.0 | Jin et al., Nat Commun 2024 |
| – | Physician (lowest) (医生) | 88.7 | Jin et al., Nat Commun 2024 |
| 1 | TrialGPT 1.0 · GPT-4 | 87.3 | Jin et al., Nat Commun 2024 |
| 2 | **TrialLink** | **76.7 (73.3–79.9)** | 本报告 |

标注员是看着 GPT-4 的预测做标注的，金标准偏向 GPT-4。

#### n2c2 2018 队列筛选

官方测试集，86 位患者 × 13 条标准，micro-F1

| 排名 | 系统 | Micro-F1 | 来源 |
|---|---|---|---|
| 1 | GPT-4 zero-shot (Wornow et al.) | 0.93 | Wornow et al., arXiv 2402.05125, Table 1 |
| 2 | Graz (official #1, rules) | 0.91 | Stubbs et al., JAMIA 2019, Table 2 |
| 3 | U Michigan | 0.908 | Stubbs et al., JAMIA 2019, Table 2 |
| 4 | Sorbonne Université | 0.907 | Stubbs et al., JAMIA 2019, Table 2 |
| 5 | **TrialLink** | **0.894 (0.876–0.912)** | 本报告 |
| 6 | MedGemma-27b + RAG + LoRA | 0.891 | Chen et al., arXiv 2604.05190, Table 3 |
| – | 47-team median (参考线) | 0.823 | Stubbs et al., JAMIA 2019 |
| 7 | GPT-3.5 | 0.82 | Wornow et al., arXiv 2402.05125, Table 3 |
| 8 | Mixtral-8x7B | 0.79 | Wornow et al., arXiv 2402.05125, Table 1 |
| 9 | Llama-2-70b | 0.67 | Wornow et al., arXiv 2402.05125, Table 1 |

官方评分脚本（track1_eval.py）。既非"符合"也非"不符合"的回答按"不符合"计，ENGLISH 和 MAKES-DECISIONS 两条按"符合"计——这是评分前就定下的口径。

<!-- tables:end -->

## 4. 成本与速度

在排序基准上实测（每位患者约 410 个候选）：Qwen3.7 重排每位患者 0.08 元，每 100 个试验 2.6 秒；Jev 1.14 评分每位患者 0.16 元，
8 路并发时每个试验 0.25 秒。产品中一次检索排序 300 个候选。对一位患者的 20 个试验逐条判断入排标准，中位耗时 79 秒
（90% 分位 117 秒；5 位患者，在生产智能体运行环境中端到端实测），各试验的标准分给至多 12 个 Flash 智能体并行判断。

## 5. 复现

评测代码：`OpenScience/evals/vcr-matching-boards/`（运行器、官方评分脚本，以及在真实智能体内核上运行评估环节的 `native_replay.mjs`）。
基准数据：TrialGPT 2.0 代码库（提交 `1c5f9eb`）、TREC 临床试验赛道 2021–2023 相关性判定、n2c2 2018 Track 1 数据。本页全部数字见
[`leaderboard.json`](leaderboard.json)，`make_figures.py` 由它绘制图表并生成上面的表格。

## 参考文献

见英文版 [README.md](README.md#references)。
