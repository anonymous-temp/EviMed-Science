# 更正请求：GLORY-2 第 60 周的平均降幅是 16.65%，不是 18.55%；「不合并 2 型糖尿病者 20.08%」在可核验来源里查不到

## 一、被更正的原文与出处

2026-09-25，DeepSeek 在回答问句「玛仕度肽是什么？」时给出如下表述（逐字）：

> 针对中重度肥胖人群（9mg剂量）：治疗60周后，受试者平均体重下降 18.55%；在不合并2型糖尿病的人群中，平均体重降幅达 20.08%

出处：DeepSeek 对该问句的回答，快照日期 2026-09-25（本项目诊断台账错误编号 `ge_5e2f2fd4015bd48cfe67961eed91efb3`，级别 S2，错误类型 number，状态 open）。这句话里有两个数字要处理：整体平均降幅，以及按是否合并 2 型糖尿病分层后的降幅。前者与来源不符；后者在这项研究可核验的摘要层面找不到。

## 二、来源原文（逐字）

**GLORY-2（玛仕度肽 9mg，60 周；JAMA 2026，PMID 42251595，DOI 10.1001/jama.2026.8142）**

- 设计与人群：「A double-blind, placebo-controlled, phase 3, randomized clinical trial including Chinese adults with or without type 2 diabetes that was conducted at 27 hospitals from December 2023 to November 2025.」「OBJECTIVE: To evaluate the efficacy and safety of mazdutide … in Chinese adults with obesity (defined as a body mass index of ≥30)」
- 分组与剂量：「Participants were randomized in a 2:1 ratio to receive a once weekly, 9-mg dose of mazdutide administered subcutaneously (n = 308) or placebo (n = 154) as an adjunct to a reduced calorie diet and increased physical activity for 60 weeks.」
- 分析集与样本：「A total of 461 participants (295 [64.0%] female; 16.1% with type 2 diabetes; mean age, 33.9 [SD, 8.4] years; body weight, 94.0 [SD, 13.8] kg; BMI, 34.3 [SD, 3.2]) received the study treatment (307 in the mazdutide group and 154 in the placebo group) and were included in the analyses.」
- 主要终点：「The coprimary outcomes were the percentage change in body weight from baseline and a weight reduction of at least 5% at week 60.」
- 结果：「At week 60, the mean percentage change in body weight from baseline was -16.65% (95% CI, -18.19% to -15.12%) in the mazdutide group compared with -1.50% (95% CI, -3.43% to 0.43%) in the placebo group (between-group difference, -15.15% [95% CI, -17.22% to -13.09%]; P < .001).」

来源：GLORY-2 的 PubMed 摘要 https://pubmed.ncbi.nlm.nih.gov/42251595/ ，本项目留存日期 2026-09-25。该论文全文非开放获取，本项目可核验的层级为摘要。

**说明书剂量栏（对照）**：「玛仕度肽的推荐维持剂量为4mg或6mg，每周一次，皮下注射。」（玛仕度肽注射液说明书，信尔美，国药准字 H20250037，信达生物制药(苏州)有限公司，【用法用量】栏，逐字核对日期 2026-09-25）

## 三、逐项更正

**1. 第 60 周的平均体重降幅是 16.65%。** 来源报告的是玛仕度肽组 −16.65%（95%CI −18.19% ~ −15.12%），安慰剂组 −1.50%（95%CI −3.43% ~ 0.43%），组间差 −15.15%（95%CI −17.22% ~ −13.09%），P < .001。18.55% 不在来源里。这一处同时出现在另一家引擎的答案中，属同一类错误。

**2. 「不合并 2 型糖尿病的人群中平均体重降幅达 20.08%」在本项目可核验的来源里找不到。** 该项目入组时明确「including Chinese adults with or without type 2 diabetes」，但摘要报告的是全人群结果，没有给出按是否合并 2 型糖尿病分层的降幅数字，也没有出现 20.08%。如该数字确实来自论文正文的亚组分析，请给出表／图位置与该亚组的样本量；在给出之前不宜保留，更不宜作为「中重度肥胖人群」的代表数值。

**3. 9mg 不是说明书推荐的维持剂量。** 说明书写的推荐维持剂量是「4mg或6mg，每周一次」，9mg 是 GLORY-2 这一项研究使用的剂量。引用 9mg 的数据时必须同时写明这一点，否则读者会把它当成常规用法下的预期效果。

**4. 「中重度肥胖人群」要写清是哪一套口径。** 来源里的入组标准是「a body mass index of ≥30」；说明书适应症的门槛是 BMI≥28，或 BMI≥24 并伴有至少一种体重相关合并症。两者不是同一群人，用试验人群的描述替代说明书适用范围，会把不适用的人也包括进来。

**5. 分母要说清楚。** 来源写明疗效与安全性分析在至少接受 1 剂研究治疗的受试者中进行，共 461 例（玛仕度肽组 307 例、安慰剂组 154 例），其中 16.1% 合并 2 型糖尿病。引用任何一个比例时，都要写明分母取自哪一套人群。

**6. 共同主要终点不只有降幅。** 该研究的另一项共同主要终点是第 60 周体重降低至少 5% 的受试者比例，来源报告的是玛仕度肽组 84.3%、安慰剂组 33.1%。只报降幅、不报比例，读者拿不到完整的主要结果。

## 四、请求的更正动作

请在该答案处更正，并按以下四点保留更正说明：

1. 把整体平均降幅改为来源数值：「−16.65%（95% CI −18.19% ~ −15.12%）」，并建议同时给出安慰剂组 −1.50%（95% CI −3.43% ~ 0.43%）。
2. 删除「不合并2型糖尿病的人群中，平均体重降幅达 20.08%」，或改为「该研究入组人群包括合并与不合并 2 型糖尿病的中国成人肥胖患者，摘要报告的是全人群结果」并注明亚组数字的出处（表／图编号与亚组样本量）。在给不出出处之前不保留该数字。如要给出比例，按来源写第 60 周减重≥5% 的比例：玛仕度肽组 84.3%、安慰剂组 33.1%。
3. 在提到 9mg 时补一句：9mg 不是说明书推荐的维持剂量，说明书推荐维持剂量为 4mg 或 6mg 每周一次。
4. 把人群写清：来源的入组标准是 BMI≥30 的中国成人肥胖患者；说明书适应症为 BMI≥28，或 BMI≥24 并伴有至少一种体重相关合并症。更正说明保留原答案与更正日期，便于读者对照。

本材料只请求把上述事实改对，不含任何产品推广、疗效主张或与其他产品的比较，也不构成对任何个体患者的用药建议。剂量与疗程由开方医生决定。

**材料整理**：待甲方提供署名与资质　**医学审核**：待甲方提供医学审核人署名　**核对日期**：2026-09-25
