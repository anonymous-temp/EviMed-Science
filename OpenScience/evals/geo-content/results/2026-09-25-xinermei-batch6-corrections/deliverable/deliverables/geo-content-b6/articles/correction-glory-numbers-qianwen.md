# 更正请求：GLORY-1 第 48 周写的是 14.01% 与 11.00%，GLORY-2 第 60 周写的是 16.65%——不是 14.84%、12.05% 与 18.55%

## 一、被更正的原文与出处

2026-09-25，千问在回答问句「玛仕度肽是什么？」时给出如下表述（逐字）：

> 减重效果：在48周的GLORY-1研究中，6mg剂量组平均体重降幅达14.84%，82.8%的患者减重≥5%；在60周的GLORY-2研究中，9mg剂量组平均体重降幅达18.55%。

出处：千问对该问句的回答，快照日期 2026-09-25（本项目诊断台账错误编号 `ge_5aa524ba2eb3473fda8426a99877af9a`，级别 S2，错误类型 number，状态 open，在本项目复问中为稳定复现）。这句话里有三处需要处理：GLORY-1 第 48 周 6mg 组的降幅、GLORY-1 的「减重≥5%」比例、GLORY-2 第 60 周 9mg 组的降幅。前两处与第三处的来源是两篇不同的试验报告，两个试验的人群门槛与剂量也不相同，原句把它们并列在一起叙述。

## 二、来源原文（逐字）

**GLORY-1（玛仕度肽 4mg 或 6mg，48 周，中国超重或肥胖成人；N Engl J Med 2025，PMID 40421736，DOI 10.1056/nejmoa2411528）**

- 「At week 48, the mean percentage change in body weight from baseline was -11.00% (95% CI, -12.27 to -9.73) in the 4-mg mazdutide group, -14.01% (95% CI, -15.36 to -12.66) in the 6-mg mazdutide group, and 0.30% (95% CI, -0.98 to 1.58) in the placebo group」
- 「73.9%, 82.0%, and 10.5% of the participants, respectively, had a weight reduction of at least 5% (P<0.001 for all comparisons with placebo)」（该组数字为第 32 周）
- 「35.7%, 49.5%, and 2.0% of the participants, respectively, had a weight reduction of at least 15% (P<0.001 for all comparisons with placebo)」（该组数字为第 48 周）
- 设计与人群：「we randomly assigned, in a 1:1:1 ratio, adults 18 to 75 years of age who had a body-mass index (BMI…) of at least 28 or had a BMI of 24 to less than 28 plus at least one weight-related coexisting condition to receive 4 mg of mazdutide, 6 mg of mazdutide, or placebo for 48 weeks」「Among 610 participants, the mean body weight was 87.2 kg and the mean BMI was 31.1 at baseline.」
- 主要终点与估计目标：「The two primary end points were the percentage change in body weight from baseline and a weight reduction of at least 5% at week 32, as assessed in a treatment-policy estimand analysis」

**GLORY-2（玛仕度肽 9mg，60 周，中国 BMI≥30 的成人肥胖患者；JAMA 2026，PMID 42251595，DOI 10.1001/jama.2026.8142）**

- 「OBJECTIVE: To evaluate the efficacy and safety of mazdutide … in Chinese adults with obesity (defined as a body mass index of ≥30)」
- 「INTERVENTIONS: Participants were randomized in a 2:1 ratio to receive a once weekly, 9-mg dose of mazdutide administered subcutaneously (n = 308) or placebo (n = 154) as an adjunct to a reduced calorie diet and increased physical activity for 60 weeks.」
- 「At week 60, the mean percentage change in body weight from baseline was -16.65% (95% CI, -18.19% to -15.12%) in the mazdutide group compared with -1.50% (95% CI, -3.43% to 0.43%) in the placebo group」

来源：两项试验的 PubMed 摘要（GLORY-1 https://pubmed.ncbi.nlm.nih.gov/40421736/ ；GLORY-2 https://pubmed.ncbi.nlm.nih.gov/42251595/ ），本项目留存日期 2026-09-25。两篇论文全文均非开放获取，本项目可核验的层级为摘要。

**说明书剂量栏（对照）**：「玛仕度肽的推荐维持剂量为4mg或6mg，每周一次，皮下注射。」（玛仕度肽注射液说明书，信尔美，国药准字 H20250037，信达生物制药(苏州)有限公司，【用法用量】栏，逐字核对日期 2026-09-25）

## 三、逐项更正

**1. GLORY-1 第 48 周的平均体重降幅是 14.01% 与 11.00%。** 来源报告的是 4mg 组 −11.00%（95%CI −12.27% ~ −9.73%）、6mg 组 −14.01%（95%CI −15.36% ~ −12.66%）、安慰剂组 +0.30%（95%CI −0.98% ~ 1.58%）。原句的 14.84% 不在来源里，且高于来源报告的同组数值；原句只写了 6mg 组，把 4mg 组与安慰剂组一起省掉了。

**2. 「82.8%的患者减重≥5%」在本项目可核验的来源里找不到。** GLORY-1 摘要报告带时间的「减重≥5%」比例只有第 32 周一组：73.9%（4mg）、82.0%（6mg）、10.5%（安慰剂）；第 48 周报告的是「减重≥15%」的比例 35.7%、49.5%、2.0%。摘要层面没有第 48 周的 ≥5% 数字。请把该比例改回来源里实际有的口径（并写明时点），或注明它出自正文哪一张表／哪一幅图；在给不出出处之前不宜保留。

**3. GLORY-2 第 60 周的平均体重降幅是 16.65%。** 来源报告的是玛仕度肽组 −16.65%（95%CI −18.19% ~ −15.12%），安慰剂组 −1.50%（95%CI −3.43% ~ 0.43%）。原句的 18.55% 不在来源里。

**4. 9mg 不是说明书推荐的维持剂量。** 说明书写的推荐维持剂量是「4mg或6mg，每周一次」，9mg 是 GLORY-2 这一项研究使用的剂量。用 9mg 的减重幅度叙述本品疗效，需要同时写明这一点；把它与 4mg／6mg 的结果并列而不作说明，会让读者以为 9mg 是常规用法。

**5. 两个试验的人群门槛不同，结果不能互相替代。** GLORY-1 入组的是 BMI≥28，或 BMI 24~<28 且至少伴一种体重相关合并症的 18~75 岁成人；GLORY-2 入组的是 BMI≥30 的中国成人肥胖患者。这与说明书适应症的门槛（BMI≥28，或 BMI≥24 并伴有至少一种体重相关合并症）又是第三套口径，三者要分别写明。

**6. 主要终点的时点要说清楚。** GLORY-1 的两个主要终点是第 32 周的体重变化百分比与减重≥5% 比例，并按 treatment-policy estimand 分析；第 48 周的结果是同一试验的随访时点数据，不是主要终点。引用第 48 周数字时写明时点，避免与第 32 周的数字混用。

## 四、请求的更正动作

请在该答案处更正，并按以下四点保留更正说明：

1. 把三个数字改为来源数值：GLORY-1 第 48 周「−11.00%（4mg 组）」「−14.01%（6mg 组）」，GLORY-2 第 60 周「−16.65%」；建议同时带上置信区间与安慰剂组数值（GLORY-1 安慰剂组 +0.30%，GLORY-2 安慰剂组 −1.50%）。
2. 「82.8%的患者减重≥5%」：改为来源里实际有的口径并写明时点（第 32 周 4mg 组 73.9%、6mg 组 82.0%、安慰剂组 10.5%；第 48 周为减重≥15% 的 35.7%、49.5%、2.0%），或给出该数字在原文中的表／图位置；给不出出处前不保留该数字。
3. 在提到 9mg 时补一句：9mg 不是说明书推荐的维持剂量，说明书推荐维持剂量为 4mg 或 6mg 每周一次。
4. 分别写明两个试验的人群（GLORY-1 为 BMI≥28 或 BMI 24~<28 伴至少一种体重相关合并症；GLORY-2 为 BMI≥30）与终点时点（GLORY-1 主要终点为第 32 周，第 48 周为随访数据）。更正说明保留原答案与更正日期，便于读者对照。

本材料只请求把上述事实改对，不含任何产品推广、疗效主张或与其他产品的比较，也不构成对任何个体患者的用药建议。疗程与剂量调整由开方医生决定。

**材料整理**：待甲方提供署名与资质　**医学审核**：待甲方提供医学审核人署名　**核对日期**：2026-09-25
