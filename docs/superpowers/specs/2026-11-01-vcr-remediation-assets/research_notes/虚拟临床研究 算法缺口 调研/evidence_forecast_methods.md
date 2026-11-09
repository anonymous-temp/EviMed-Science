# 证据提取、曲线重建与试验结局预测的新方法（2022 至 2026-11），对照 EviMed VCR 引擎现状

调研日期 2026-11-02。引擎事实读自 `00_context_current_methods.md` 与工作区 `项目代码/vcr-engine/R/`、`OpenScience/apps/server/src/vcrEvidence.mjs`。

标记：[PR] 同行评议；[PP] 预印本，未经评审；[CONF] 会议摘要或海报；[VEN] 厂商自述；[单一来源] 只有一处来源；[未核实] 没打开原文或无法确认。
阅读深度：「PDF 已读」= 下载后用 pdftotext 读文本；「抓取」= 网页抓取工具返回的模型摘录，数字以其返回为准；「检索摘要」= 只看到搜索工具的模型摘要，未读原文。
仓库事实由 GitHub API 与 CRAN 元数据在 2026-11-02 取得。「最后推送」不等于正式发布；API 未检出许可证时写「未声明」，这意味着没有授予商业使用权。
早期笔记 `agents_evidence.md` 已有的内容（Yun、Li、TrialMind、Gartlehner、Lagisz 的 Elicit 研究、KM-GPT 主要数字）这里不重复，只在需要时引用。

---

## Q1. Guyot 之后的 KM 重建：Guyot 还是参照吗？实测精度如何？

### Takeaway
Guyot 2012 仍是参照，且没有被实质超越：同一批曲线上，IPDfromKM（即题目中的 Liu 2021）与 Guyot 的 HR 平均偏差只差 0.08 个百分点（2.85% 对 2.93%）。真正影响精度的是有没有风险表、曲线是否重叠、数字化质量，而不是重建算法。唯一声称大幅胜出的 StochIKM 是单一预印本，胜在风险表复现，没有报告 HR 误差，代码也不公开。

### Cited Findings
- 同批曲线的直接比较 [PR，抓取]：46 条 KM 曲线、14 个免疫肿瘤 RCT、58 个 HR，单一分析员用 CurveSnap 数字化；IPDfromKM 的 HR 绝对百分比差均值 2.85%（SD 3.42），中位 2.14%，范围 0–23.25%，49/58（84.5%）低于 5%；CI 不重叠均值 4.35%；同样曲线上 Guyot 原始代码 HR 差 2.93%（SD 3.34），CI 不重叠 5.74% — [Kim 2025, Contemp Clin Trials Commun](https://pmc.ncbi.nlm.nih.gov/articles/PMC12409465/)
- 同一研究中输入的影响：15 条曲线上去掉风险表后 HR 差升至 6.62%，CI 不重叠升至 21.50%；不做预处理为 6.15%，做了为 4.08%；最差一例（23.25%）是四条重叠曲线的 POPLAR 亚组；只验证了 HR，未量化中位数，无评分者间比较 — [Kim 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12409465/)
- IPDfromKM：修改版迭代 KM 算法，开发者报告生存概率和中位数精度极好，而 HR「只有在至少报告风险人数或总事件数时才能达到合理精度」 — [Liu 2021, BMC MRM](https://link.springer.com/article/10.1186/s12874-021-01308-8)（检索摘要）。一项硕士论文让三名统计师独立操作，生存时间 ICC 0.967（0.946–0.981）— [UNMC 论文](https://digitalcommons.unmc.edu/etd/737)（检索摘要，[单一来源]）
- 对 Guyot 的独立验证：中位生存和生存概率的可重复性和准确性极好，HR 在信息少时较差 — [J Stat Health Decis 上的验证](https://proa.ua.pt/index.php/jshd/article/view/20372)（检索摘要）
- Rogula 2022 [PR，抓取]：利用标注的删失时间的贪心算法，模拟 n=20、50、100、200；HR 和分位数无系统偏差，部分 HR 比 Guyot 更近（指数 n=200：原值 3.55，新法 3.55，Guyot 3.46），n=20 时拟合更好，大样本相近；前提是删失标记可见，密集曲线上失效，未测 n>200；R 包 `KMtoIPD` 在 GitHub — [Rogula 2022, MDM Policy Pract](https://pmc.ncbi.nlm.nih.gov/articles/PMC8808036/)
- StochIKM [PP，v2，抓取，[单一来源]]：Yale；GPT-5 读图后生成同时满足风险表、曲线、印刷摘要三类约束的多套 IPD，每臂至多 50 套；28 个试验 53 张 OS 图 108 臂；风险表完全复现 97/97 对 LLM 改进版 IPDfromKM 的 44/97；中位数绝对误差中位 0.00 对 0.10 月，最大 0.91 对 1.32 月；CI 重叠 0.94 对 0.94；42/97 臂需要放松约束；不用删失标记（作者说现有视觉模型读不可靠）；未报告 HR 误差；未与 Guyot、KM-GPT、SurvdigitizeR 定量比较；代码「合理请求」时提供，未声明许可证；文中臂数在 101、104、108 之间不一致 — [StochIKM arXiv 2610.29122](https://arxiv.org/html/2610.29122)
- SurvdigitizeR [PR，抓取]：60 张模拟图 120 条曲线，自动 RMSE 0.012 对手工 0.014；无删失标记 0.009 对 0.015，有删失标记 0.016 对 0.013（此时反而差）；8 张真实图 Kendall's τ 0.982–0.998；依赖 tesseract OCR；文中未报告失败率 — [Zhang 2024, BMC MRM 24:147](https://pmc.ncbi.nlm.nih.gov/articles/PMC11245803/)。外部测试中 540 张合成图失败 178 张（33.0%），且需要先手工去掉风险表 — [KM-GPT arXiv](https://arxiv.org/html/2509.18141v1)（对手的自测，不算中立）
- KMGen [PP/PMLR 340，抓取]：32 张图的平均 IAE 0.0151，无与其他工具同图比较的细节；另生成合成患者数据 — [KMGen arXiv 2608.22618](https://arxiv.org/abs/2608.22618)
- 包的事实：IPDfromKM CRAN 0.1.10，发布于 2020-11-11，CRAN 记 GPL-2，依赖 ggplot2、dplyr、survival、gridExtra、readbitmap — [CRAN](https://cloud.r-project.org/web/packages/IPDfromKM/index.html)；一份检索摘要说 GitHub 版为 GPL-3（[未核实]），GitHub NaLiuStat/IPDfromKM 最后推送 2019-09-27。reconstructKM CRAN 0.4.0（2025-12-03，GPL-3），未读到评估。SurvdigitizeR：GitHub API 报 `NOASSERTION`，根目录 LICENSE 取不到，最后推送 2025-12-08，许可证 [未核实] — [仓库](https://github.com/Pechli-Lab/SurvdigitizeR)。KMGen：MIT，最后推送 2026-04-18，0 星 — [仓库](https://github.com/chufangao/kmgen)
- 引擎现状：`reconstruct.R` 已有 Guyot 与 QC（风险人数 max(2, 5%)、总事件 5%、中位数 5%、|log HR 差| ≤ 0.05），不通过记为 `reconstruction_failed_qc`；无风险表时标为低可信；曲线坐标不接受语言模型直接给出 — 本仓库 `项目代码/vcr-engine/R/reconstruct.R`

### Inferences
- 引擎的 |log HR 差| ≤ 0.05 约等于 HR 差 5%。按 Kim 2025 的 84.5%，大约七分之一的真实曲线（尤其重叠或亚组）会过不了这条。这是我的换算，没有在本引擎上测过。

#### 候选卡片

**A. IPDfromKM 作为 CI 交叉校验**
- 方法与论文：modified-iKM，Liu 2021。数据：模拟与真实应用；Kim 2025 独立用于 46 条曲线。结果见上。
- 实现：CRAN 0.1.10，2020-11-11，GPL-2；只在 CI 库，不进运行库。CPU：可忽略。
- 用户新问题：没有新问题，但让「KM 重建已被校验」这句话成立。已知缺口：registry 把它标为交叉校验却没有跑。
- 独立证据：Kim 2025（非开发者）。
- **判定：现在加（只进 CI）。** 不要替换 Guyot，差异小到不值得换。

**B. 约束下的多套可行 IPD（StochIKM 思路），把重建不确定性传到下游**
- 方法：不生成一套 IPD，而是抽多套都满足风险表、事件数和曲线的 IPD，报告 HR 等的跨套分布。结果与实现事实见上；代码不公开，需按论文手写 R。
- CPU：50 次 Cox 拟合可忽略；约束搜索的耗时未报告（[未核实]），按单臂数百人估计可接受（我的推断）。
- 用户新问题：「我的 MAIC 或加权 Cox 的区间里，有多少来自重建本身？」今天只有一套 IPD，这部分不确定性看不见。
- 独立证据：无，[单一来源] 预印本，且未测 HR。论文只对比了 IPDfromKM，对 Guyot 的优势是推测。
- **判定：以后加。** 先用引擎自己的模拟器做已知真值实验（模拟 IPD、算 KM、重建、比较 HR），测出单套 Guyot 的真实误差，再决定。

**C. Rogula `KMtoIPD`（利用删失标记）**：n 大时失效，视觉模型读不准标记（StochIKM 作者语），GitHub 许可证未查。用户没有新问题。**判定：不值得。**

**D. SurvdigitizeR 替换现有数字化器**：有删失标记时比手工差，无风险表处理；外测失败 33%；R + tesseract 可在 CPU 跑，但许可证未确认。**判定：不值得。** 它与现有数字化器同属经典方法，看不出优势。

**E. KMGen（智能体写代码提取曲线）**：无中立比较；MIT 但几乎无人使用；运行模型写的代码需要隔离容器。与「曲线坐标不来自语言模型」的现行规则也要再议。**判定：以后再看。**

### Gaps
- `kmtracker`：两次检索和一次 GitHub 仓库搜索都没有找到 KM 相关工具；同名仓库是 Linux 内存跟踪器和 GPS 应用。无法确认这个工具存在，不报告任何数字。
- 没有任何研究把 Guyot、IPDfromKM、KM-GPT、StochIKM 放在同一批已知真值曲线上比较。
- KM-GPT 的公开代码：bioRxiv 版可读部分没有代码地址，GitHub 搜索也没有找到，但 PDF 其余部分我没读，不能断言没有。一个第三方比较仓库 `ethanrasmussen/kmgpt_vs_llm` 存在，其 README 取不到。
- 一份检索摘要提到 Guyot 在四法比较中平均误差最低（0.0094），我未定位到原文，未采用。

---

## Q2. 图形提取：视觉 LLM 与专用模型读图的精度；有没有被测出与经典数字化器相当的？

### Takeaway
没有。我没有找到纯视觉 LLM 与经典数字化器在同一批图上比较并打平的研究。现有数字表明直接读 KM 图比「LLM 读轴 + 代码追曲线」差约 6 倍（RMSE 0.087–0.090 对 0.014）。引擎现在的结构（模型说校准、经典代码追线）正好属于测得最好的那一类，不需要换。

### Cited Findings
- 直接比较 [CONF，抓取，[单一来源]]：GPT-4o 读元数据 + 计算机视觉追线，对直接用 GPT-4o、Claude 3.5 读图；150 条合成单臂曲线（有删失）RMSE 0.014、0.090、0.087，中位生存偏差 ±0.7、±1.64、±1.68 月；10 条已发表曲线中位偏差 ±0.6、±1.9、±1.8 月；只有单臂 — [ISPOR 2025 海报](https://www.ispor.org/heor-resources/presentations-database/presentation-cti/ispor-2025/poster-session-1/automated-extraction-of-kaplan-meier-survival-curves-using-generative-artificial-intelligence-and-computer-vision)。引擎注释中的 0.087 对 0.014 与这组数字吻合 — `reconstruct.R`
- ExChart-Bench [PR，CHI '26，PDF 已读]：3,600 张图（744 真实 + 2,856 合成），33,757 个数值，折线图以基本与分组折线为主，不含阶梯生存曲线；Adaptive MAPE（总体／折线）：GLM-4.5V 5.94／5.56，Gemini 2.5 Flash 6.72／4.35，GPT-4.1 7.49／6.43，GPT-4o 13.38／9.53，Qwen2.5-VL 72B 9.10／6.57，作者的 7B 训练模型 4.87／7.93；作者结论「None of these MLLMs are ready」，且真实误差高于 Adaptive MAPE 显示的值；真实图的金标准是用 WebPlotDigitizer 标的，所以经典工具被当作参照而不是被比较的一方 — [He 2026](https://arxiv.org/pdf/2606.29808)
- 同文专用模型的结果（RNSS／RMS）：MatCha 74.79／19.52，UniChart 56.60／43.58，TinyChart 41.75／41.18，均低于 GLM-4.5V 71.45／73.47 — [He 2026](https://arxiv.org/pdf/2606.29808)
- 可重复性：TinyChart 重复运行时 99.4% 的图至少有一处不同，49.0% 表格尺寸不同；自集成最多相对提升 23% — [arXiv 2605.27298](https://arxiv.org/html/2605.27298)（检索摘要）
- 图像压力：ISPOR Europe 2026 的合成已知真值海报说常见图像压力可造成曲线分离的突然失败（早期笔记已引，此处不再展开）— [海报](https://www.ispor.org/heor-resources/presentations-database/presentation-cti/ispor-europe-2026/poster-session-3-4/impact-of-image-quality-on-automated-kaplan-meier-curve-digitisation-using-synthetic-known-truth-survival-curves)
- 经典工具的许可证：WebPlotDigitizer 为 AGPL-3.0，最后推送 2026-07-27 — [仓库](https://github.com/automeris-io/WebPlotDigitizer)。AGPL 要求网络服务方公开修改，这是事实陈述。

### Inferences

#### 候选卡片

**F. 视觉 LLM 直接读图**：无匹配证据，误差约 6 倍，结果不可重复；与现行规则冲突。**判定：不值得。**

**G. 专用读图模型（DePlot 系、MatCha、TinyChart 等）**：在通用图表上低于通用大模型，都要 GPU 才实用（我的推断），不针对 KM。**判定：不值得。** LineFormer 仓库存在（未声明许可证，最后推送 2025-11-26），论文未读，不作判断。

**H. 数字化器的已知真值测试台（不是新方法）**
- 用引擎模拟器生成已知真值 KM，按多种风格、分辨率、重叠程度渲染，跑现有数字化器和 `reconstruct_km`，报告 IAE、HR 差和失败率。
- CPU：可忽略。实现：现有模拟器 + Python 绘图。
- 用户新问题：「这张图这种风格，重建结果的误差大概多少？」今天说不出来。
- 独立证据：测试设计来自 KM-GPT、KMGen、ISPOR 的共同做法。
- **判定：现在加。** 这是后面所有 KM 决策的前提；先测出自己的误差量级，才能与已发表数字对照。

**I. 校准的刻度 OCR 交叉核对**
- 现状是模型陈述校准。可在一次性容器里用代码检测刻度位置，并用 OCR 读刻度值，与模型所说不一致时标 ⚠，不拦截。
- 证据：KM-GPT 报告 540 张合成图上轴范围和刻度 100% 正确（早期笔记），但都是合成图；SurvdigitizeR 用 tesseract，作者说 OCR 精度依赖图像质量。没有研究直接衡量这种核对的价值。
- **判定：以后加**，等 H 测出校准错误确实常见。

### Gaps
- 没有 KM 专用的视觉模型与经典数字化器的同图比较；ExChart-Bench 不含生存曲线。
- 所有 KM 读图的 LLM 数字都来自 GPT-4o、GPT-5、Claude 3.5，我没找到 DeepSeek 视觉能力在 KM 图上的实测，不能假定可移植。
- 自集成是否能把 KM 读图误差降到经典水平：未找到。

---

## Q3. LLM 从试验论文提取参数：实测精度（早期笔记之外的新增）

### Takeaway
数值字段仍明显弱于文本字段，单独读取的数值准确率在严格的外部验证中约 50–75%（Kataoka 60–74%，早期笔记中 Yun 0.487–0.655）；声称 90% 以上的研究都依赖带裁决的金标准或是预印本。对引擎有用的不是某个新工具，而是一个可照搬的机制：两次独立读取，代码比对，不一致就打 ⚠。现有的逐字引文检查已经覆盖了归因这一半。

### Cited Findings
- Kataoka 2025 [PR，Research Synthesis Methods，抓取]：58 个数值、9 个字符串变量；开发集 290 个 RCT 十折交叉，GPT-4o 数值 72.3%、字符串 74.0%；外部 5 个 RCT：GPT-4o 数值 60.4%、字符串 68.8%，o3 数值 74.2%、字符串 81.7%；另一个 10 RCT 银屑病集上批处理法 96.3%（变量少）、all-in-one 84.4%；作者说数值提取「cannot yet replace humans」 — [PMC12823200](https://pmc.ncbi.nlm.nih.gov/articles/PMC12823200/)
- otto-SR [PP，检索摘要，medRxiv 全文返回 403]：7 篇综述 495 项研究 4,495 个数据点，o3-mini-high，准确率 93.1% 对人工 79.7%；分歧时盲法审查组 69.3% 站在工具一边；这个结果高度依赖金标准的定义；另有论文指出它用 LLM 作判定且未报告成本（抓取到的是第三方转述）；含 Elicit 比较，具体数字未读到 — [medRxiv](https://www.medrxiv.org/content/10.1101/2025.06.13.25329541v1)，[第三方评论](https://link.springer.com/article/10.1007/s10916-025-02305-w)
- EviSearch [PP，v3，摘要页抓取]：三个访问范围不同的智能体各提一遍，值须通过页面归因校验器；自主准确率 91.70%，审核 15.6% 的单元格后 95.22%，在相同审核量下比随机审核最强单智能体高 1.75 个点；全程离线、开放权重模型 — [arXiv 2604.14165](https://arxiv.org/abs/2604.14165)。另一份检索摘要称前列腺癌 RCT，单次基线 89.01%，并说用 LLM 判定；摘要页则说按临床标注核对，**这两种描述有冲突，未解决** — [PDF](https://arxiv.org/pdf/2604.14165)。代码 CoRAL-ASU/EviSearch 未声明许可证，最后推送 2026-09-24，1 星
- PaperQA2 [PP，厂商团队自评，检索摘要]：LitQA2 上精度 85.2%、准确率 66.0%，人类博士 73.8% 和 67.7%；「超人」只在精度一项；基准和系统同出 FutureHouse，未找到第三方复现 — [arXiv 2409.13740](https://arxiv.org/abs/2409.13740v2)。Apache-2.0，最后推送 2026-10-26 — [仓库](https://github.com/Future-House/paper-qa)
- RobotReviewer：GPL-3.0，最后推送 2022-07-18 — [仓库](https://github.com/ijmarshall/robotreviewer)；本轮检索未读到 2022 年后的评估。

### Inferences
- 各研究的数字差距（Kataoka 60–74%，otto-SR 93%）主要来自字段组合和金标准定义，不能放在一起排名。不要向用户引用单一「提取准确率」。

#### 候选卡片

**J. 两次独立读取 + 代码比对（只借 EviSearch 的机制，不引入其代码）**
- 用 DeepSeek 对同一参数以不同上下文（整篇、仅表格区）各提一遍，代码比较数值和单位，不一致标 ⚠ 并同时保留两个值；不增加人工步骤，也不拦截交付。
- CPU：无；成本为提取调用翻倍。
- 用户新问题：「哪些参数两次读得不一样，应该先看？」今天每个提取值看上去同样可信。
- 独立证据：无，EviSearch 是 [单一来源] 预印本，增益约 2–3 个点。Lagisz 的引文一致率低（早期笔记）说明模型自报引文不够，但我们已有代码查引文。
- **判定：现在加。** 成本低，符合「模型读语言，代码比对」，但应在 `evals` 上测增益，不要只凭论文。

**K. 提取值的确定性内部一致性检查**
- 例：HR 与 CI 在对数尺度是否对称，能否反推 SE；事件数与率、人数是否相符；p 值与 CI 是否矛盾。不一致标 ⚠。
- 证据：**没有研究实测这种检查能抓到多少 LLM 错误**，这是我基于 Yun 等报告的错误类型（早期笔记）做的推断。
- **判定：现在加，但先作为通知和指标**（原则 4）。工作量小，不依赖模型。

**L. PaperQA2**：解决问答综合，不解决参数提取；平台已有 `kb_search`、逐字引文检查。**判定：不值得。**

**M. RobotReviewer**：针对偏倚风险和 RCT 分类，不针对参数；四年多没更新；GPL-3。**判定：不值得。**

**N. otto-SR、Elicit 等整合系统**：闭源或服务形态，且依赖外部模型。**判定：不值得**，但其公开的评估设计可参考。

### Gaps
- 未读到 Konet 等人的 RSM 研究全文（检索未命中，无法确认其数字）。
- 基线表和效应量提取未见分开的数字；SD、事件率这类模拟输入的提取精度仍未找到专门研究（早期笔记已指出）。
- 未找到 DeepSeek 模型在 RCT 数值提取上的专门评估。

---

## Q4. 表格提取：从 PDF 解析基线表

### Takeaway
通用基准中 Docling、MonkeyOCR、Mathpix 的表结构分数在 PubMed 来源的 PubTables 上达到 0.86–0.88（TEDS），GROBID 0.47，pdfplumber 0.22，通用视觉 LLM 0.36–0.74，而且会幻觉。平台 office 技能用的 pdfplumber 不适合读基线表。没有研究针对临床基线表比较这些工具，也没有人测过平台在用的内部解析 API。

### Cited Findings
- 基准 [PP，arXiv HTML，抓取前 100k 字符]：约 86k 页，四个数据集；F1 检测／TEDS，PubTables 列：Docling 0.99／0.86，MonkeyOCR 0.99／0.87，Mathpix 0.99／0.88，GROBID 0.67／0.47，PDFPlumber 0.41／0.22，PyMuPDF 0.42／0.27，Camelot 0.25／0.20，Qwen2.5-VL 32B 0.65／0.54，GPT-4.1 0.46／0.36（子集），Gemini 2.5 Pro 0.85／0.74（子集）；作者说最好的工具 TEDS 也低于 0.90，GPT-4.1 会幻觉，视觉模型在无表页面上也几乎总输出预测；API 成本 GPT-4.1 约 $320、Gemini 约 $1,200、Mathpix 约 $310；未给出合并单元格的逐方法分析 — [arXiv 2511.16134](https://arxiv.org/html/2511.16134v2)
- GROBID 在生物医学表上：100 张金标准表只检出 19 张 — [ResearchGate 记录](https://www.researchgate.net/publication/390032007_Automatic_detection_and_extraction_of_key_resources_from_tables_in_biomedical_papers)（检索摘要）
- Docling：MIT，最后推送 2026-11-01，约 7 万星 — [仓库](https://github.com/docling-project/docling)。table-transformer：MIT，已归档，最后推送 2024-06 — [仓库](https://github.com/microsoft/table-transformer)
- 一份检索摘要说，Eckmann 等比较了两个随机试验基线表提取工具，其中「baseline」工具更好，样本小；我打开摘要页没有看到这部分内容，**[未核实]** — [arXiv 2507.17991](https://arxiv.org/abs/2507.17991)
- 平台现状：PDF、Office、图片走内部解析 API，结构化材料由 `sourceMaterials.mjs` 带单元格地址入账；PDF 每行的页码在一次性容器里读原始字节 — 本仓库 `AGENTS.md`

### Inferences

#### 候选卡片

**O. 基线表的小型实测（不是新方法）**
- 找 20–30 篇 RCT 的基线表人工录入金标准，比较内部解析 API 与 Docling，分行变量、分臂数值、N、单位四项打分。
- 用户新问题：`population.literature` 里的边际分布有多可靠？今天不知道。
- **判定：现在加。** 没有这个测量，是否换解析器都无从判断。

**P. Docling 作为一次性容器内的第二读者**
- 方法：布局模型 + TableFormer 类结构识别（方法细节未在基准页中读到）。结果见上。MIT。
- CPU：基准中有 CPU 成本估算但在我未读到的图和附录里，**单页耗时 [未核实]**；模型依赖 PyTorch，只能放在一次性容器，不能进引擎。
- 用户新问题：解析器与 Docling 对同一基线表给出不同值时，哪些单元格要先看。
- 独立证据：上述基准（独立于 Docling 团队），但不是临床基线表。
- **判定：以后加**，取决于 O 的结果。注意内部解析是 owner 既定选择，这里只作第二读者。

**Q. 通用视觉 LLM 读表**：基准中 TEDS 低且幻觉，成本高。**判定：不值得**。

### Gaps
- 没有临床基线表上工具比较的研究；合并单元格、分组行、「n (%)」「mean (SD)」混排这些基线表的典型问题无专门数字。
- 内部解析 API 的表格精度无任何公开或内部测量可供我读。

---

## Q5. 试验结局和失败预测：样本外证据如何？应该提供吗？

### Takeaway
不应提供「这个试验的成功概率」。样本外证据显示：在 TOP 基准上，只用疾病编码和药物历史的两列基率查表（ROC-AUC 0.700）不输任何深度模型，文献中的模型间增益低于基准可分辨的最小差异；在严格时间切分下，排序能力约 0.67–0.75，逻辑回归能达到同样水平，而概率校准差，Phase 1、2 的 Brier skill 为负。厂商数字都没有独立验证。引擎已有的 assurance 加上有出处的历史基率，回答的是更诚实的问题。

### Cited Findings
- TOP 基准再评估 [未发表手稿，代码和逐试验预测公开；读了摘要和部分正文，**未重跑**；0 星；格式为投 Artificial Intelligence in Medicine，未见发表记录；[单一来源]]：修复 HINT 和 MEXA-CTP 公开代码中的十处缺陷，两处严重：MEXA-CTP 的 mode-experts 存在普通 Python `dict` 里，从未被训练；HINT 附带的嵌入缓存是空的，把入排标准替换成零向量；修复后 MEXA 对 HINT 的优势消失，恢复入排标准也没用（ΔROC-AUC −0.0001，p=0.93）；两者都不胜过同输入的梯度提升；Phase III 上疾病编码 + 药物历史的查表 ROC-AUC 0.700，高于全部深度和基础模型（调优 XGB 0.691，零训练 TabFM 0.668）；80% 功效下能检出的最小差异为 0.035–0.067，文献报告的模型间增益都低于它；46% 的 Phase III 测试试验共用同一分子图 — [top-benchmark-reeval](https://github.com/azizcetinerr/top-benchmark-reeval)（MIT，最后推送 2026-10-13，[手稿](https://github.com/azizcetinerr/top-benchmark-reeval/blob/main/paper/submission/paper-last.tex)）
- MEXA-CTP 的原始声明：相比 HINT，F1 +11.3%，PR-AUC +12.2%，ROC-AUC +2.5% — [arXiv 2501.06823](https://arxiv.org/abs/2501.06823v1)（检索摘要；发表于 SDM 2025）
- 泄漏审计的时间验证 [PP，Research Square，单一作者，PDF 已读]：2019 年前全适应症训练，2020–2024 神经科学人工标注测试（939 Phase 1、1,047 Phase 2、681 Phase 3）；BioBERT ROC-AUC 0.669（0.626–0.712）、0.708（0.675–0.741）、0.719（0.678–0.758）；Phase 3 软标签逻辑回归 0.744，BiomedBERT 0.745；Phase 1 经典模型的点估计都高于 BioBERT；BioBERT Brier skill −0.710、−0.098、+0.066；校准差，作者说原始输出只能当排序用；因用了当前注册记录，残余泄漏仍有可能，建议按预设日期取历史版本；Phase 2 属开发集；3.5 小时，GPU，$1.19 — [Doane 2026](https://assets-eu.researchsquare.com/files/rs-10964251/v1_covered_55875151-c588-4eb3-8fc3-cd679f6bb03e.pdf)
- ClinicalReTrial 的复跑 [PP，PDF 已读，表头未完整解析]：TrialBench 四分类任务上 HINT ROC-AUC 0.540、0.535、0.474、0.548，逻辑回归 0.606、0.583、0.621、0.550；一份检索摘要把 0.474 与 0.621 归为 Phase 3；任务定义与 HINT 原任务不同，不能直接对比原始数字 — [arXiv 2601.00290](https://arxiv.org/pdf/2601.00290)。同文用预测模型当模拟器评价方案修改，增益只被另一个预测模型确认，没有真实结局。
- 2026-10 新预印本：BioBERT、BioMistral 在 TOP 上 ROC-AUC 0.613–0.772，PR-AUC 高于 HINT 10–20%，但「没有任何模型（含 HINT）明显超过预测全部成功的平凡分类器的 F1」 — [arXiv 2610.41710](https://arxiv.org/abs/2610.41710)（只读摘要）
- CTO [arXiv v3，PDF 已读]：约 12.5 万药物和生物制品试验；标签来自 LLM 读论文、阶段推进、新闻情绪、申办方股价等弱监督；与 TOP 测试集 F1 0.909（Phase 1、2、3 为 0.913、0.878、0.941）；与 2020–2024 人工标注 F1 97.1，难例 72.7；存在分布漂移 — [CTO](https://arxiv.org/pdf/2406.10292)。仓库 MIT，**已归档**，最后推送 2026-02-06 — [chufangao/CTOD](https://github.com/chufangao/CTOD)
- 其他方法的实现事实：HINT、TOP 未声明许可证，最后推送 2025-06-24 — [仓库](https://github.com/futianfan/clinical-trial-outcome-prediction)；TrialBench MIT，最后推送 2025-08-06 — [仓库](https://github.com/ML2Health/ML2ClinicalTrials)；LINT 仓库 MIT，最后推送 2024-12-02（README 题为 LLAMIN）— [仓库](https://github.com/chufangao/LINT)，[论文](https://arxiv.org/abs/2405.06662)；MEXA-CTP 未声明许可证 — [仓库](https://github.com/murai-lab/MEXA-CTP)；SPOT 报告 PR-AUC 相对提升 21.5%、8.9%、5.5%，均为作者自报 — [arXiv 2304.05352](https://arxiv.org/pdf/2304.05352)（检索摘要），`RyanWangZf/SPOT` 查询返回 404。
- Xuanwu-TrialMind：在 150 个较晚试验上报告时间外部验证 — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2666675826003218)（检索摘要，全文 403，[未核实]）
- inClinico [VEN，PR，论文原文未读]：准前瞻验证 ROC-AUC 0.88（1995–2017 训练，2018–2021 验证），前瞻集 79%；作者自述「用时间戳模拟前瞻」；全由 Insilico 主导 — [行业报道](https://www.clinicalresearchnewsonline.com/news/2023/08/24/ai-powered-inclinico-aims-to-solve-the-phase-2-to-3-transition-problem)，[新闻稿](https://www.newswise.com/articles/7-yr-generative-ai-predicts-clinical-trial-outcomes)
- QuantHealth [VEN，仅新闻稿类来源]：Phase 2 88%（对比实际成功率 28.9%）、100 个试验 85%、350 个试验 90%；其材料称第三方验证「正在进行」；我未找到任何独立的、同行评议的前瞻验证 — [DDD 报道](https://www.drugdiscoverytrends.com/quanthealths-ai-simulates-100-clinical-trials-with-85-accuracy/)，[新闻稿](https://www.01net.it/quanthealth-successfully-simulates-350-clinical-trials-with-90-accuracy-delivering-31-4m-in-savings-for-a-top-10-pharma-company)，[访谈](https://www.clinicaltrialvanguard.com/executiveinterviews/how-to-benchmark-and-predict-clinical-trials/)
- 引擎立场：`assurance.R` 注释已写明 assurance 不是「trial success prediction score」 — 本仓库 `项目代码/vcr-engine/R/assurance.R`

### Inferences
- 「成功」在这些数据集里定义不一：TOP 是专家标注，CTO 混合阶段推进、新闻和股价。阶段推进受商业决定影响，和科学成功不是一回事。
- 平均 0.7 的 ROC-AUC 看上去不错，但基率表就能达到；对单个用户的单个试验，它不能给出可信概率（Brier skill 为负）。一旦平台显示「成功概率 63%」，用户会把排序分数当概率读。

#### 候选卡片

**R. HINT、TrialBench、LINT、MEXA-CTP、SPOT 等深度模型**
- 数据和结果见上。多数需 GPU 训练；HINT、MEXA 未声明许可证。
- 用户新问题：表面上是「我的试验会成功吗」，实际得到的是一个校准差的排序分。
- 独立证据：唯一的独立再评估是否定性的（未发表）。
- **判定：不值得。**

**S. 注册文本 + 逻辑回归的基线预测**（Doane 的对照臂）：能在 CPU 上训练（推断），但同样校准差，且会把用户的方案文本变成一个无法解释的分数。**判定：不值得。** 只有在有人明确要做方案组合的相对排序时才重新考虑，并须按预设日期取注册历史。

**T. 商业 inClinico、QuantHealth**：闭源，厂商自评。**判定：不值得。** 也不要在产品中引用其精度数字。

**U. 历史基率表（见 Q8 卡片 Z）**：**判定：现在加。** 这是这部分唯一有证据支持、也诚实的产品形态。

### Gaps
- `CT-BERT`：检索没有命中，无法确认其存在或结果。
- 没有找到任何方法的真正前瞻、独立、预注册验证。
- 再评估手稿未经评审，我未重跑；其披露文件中上游作者的回应未读。TrialBench 的 Scientific Data 论文未读，只见第三方评论。

---

## Q6. 入组、中心与筛败预测：超出 Poisson-Gamma 的 ML 和 LLM 方法

### Takeaway
没有可用于本引擎的方法值得现在加。ML 的增益要靠私有的中心级数据（IQVIA DQS、申办方历史）才拿得到，公开注册信息给不出；LLM 特征的增量极小（PR-AUC +0.0047），最好的模型不用文本也差不多。引擎已经支持错开开放的中心和筛败。筛败预测未找到任何专门模型。

### Cited Findings
- Do 2025 [PP，Pfizer 与 Merck 作者，PDF 已读]：IQVIA DQS，训练 9,410、开发 1,000、测试 1,000；预测入组数 R²／MAE：计划目标数 0.39／71.42，LightGBM（无文本）0.76／56.84，加文本嵌入的 LightGBM 0.71／62.61，BioBERT 0.77／69.36，Llama2 0.07／110.98，作者确定性模型 0.76／51.99，概率模型 0.77／55.92；名义 90% 区间实际只覆盖 78.73%，中位宽度 99.35；作者原话，简单拼接文本嵌入并不普遍改善；Deep Poisson-Gamma 预测时长 MAE 7.85 对 filtering-and-fitting 9.99 月，6 个月窗口覆盖 26.23% 对 22.95%，测试 n=61 — [arXiv 2507.23607](https://www.arxiv.org/pdf/2507.23607)
- TrialEnroll [PR，ACM BCB 2024，抓取]：31,094 个 ClinicalTrials.gov 试验，2015-01-01 时间切分，二分类；ROC-AUC 0.7352 对 MLP 0.7146，PR-AUC 0.7002 对 0.6773，增益 0.0229；消融：原始 0.6497，加 LLM 特征 0.6544，加手工特征 0.6773；最重要的特征是入选标准条数和最大年龄；代码放在匿名链接 — [arXiv 2407.13115](https://arxiv.org/html/2407.13115v1)
- 贝叶斯非齐次 Poisson 过程：25 项研究、4 个治疗领域，声称精度优于公司旧系统且覆盖率符合名义水平，公司内部数据 — [Zhong, arXiv 2301.01351](https://arxiv.org/pdf/2301.01351)（检索摘要，Pharm Stat 2024 依 EBSCO 条目）。准 Poisson 两段模型：7 项研究 — [arXiv 2303.08065](https://web3.arxiv.org/abs/2303.08065)（检索摘要）
- 时变 Poisson-Gamma：数据申请摘要中声称优于标准模型，内容很薄 — [Vivli](https://vivli.org/?p=12295)（检索摘要，[单一来源]）；时间齐次模型预测区间过窄的主张 — [arXiv 1910.07965](https://ar5iv.arxiv.org/html/1910.07965)（早于 2022，检索摘要）
- 中心风险 SVM 报告 98.91% 准确率（ATTR-CM）— [PubMed 41741318](https://pubmed.ncbi.nlm.nih.gov/41741318/)（检索摘要，未读全文，这一数字需谨慎）；筛败率是输入特征，不是预测目标。
- 厂商：PPD、Axtria 的页面无验证数据 — [PPD](https://www.ppd.com/our-solutions/digital-drug-development-solutions/clinical-trial-forecasting-suite/)，[Axtria](https://www.axtria.com/customer-success-stories/accelerating-clinical-trial-enrollment-achieving-real-time-predictive-intelligence-with-advanced-scenario-modeling)
- 引擎现状：`accrual.R` 已有闭式解、错开中心开放的模拟、筛败稀释、Bayesian 更新（Gamma(alpha+k, beta+tau)），并写明 ClinicalTrials.gov 没有中心级入组和中心开放日期，由它得到的先验「偏低」且会告知 — 本仓库 `项目代码/vcr-engine/R/accrual.R`

### Inferences
- Do 2025 里最值得记住的是基线：用计划入组数预测实际入组 R² 只有 0.39，也就是用户填的目标数字本身很不可靠。无需任何模型，这可以作为 `accrual.poisson_gamma` 页面的一句提示（但数字来自 IQVIA 私有数据，[单一来源]）。
- 中心选择工作与 owner「不做招募或患者联系流程」的边界很近，不应加。

#### 候选卡片

**V. Deep Poisson-Gamma、TrialEnroll 类模型**：依赖私有中心级数据（Do）或增益微小（TrialEnroll）；训练需要 GPU；to-C 用户没有这些数据；Do 的区间校准不足。用户没有实质新问题。**判定：不值得。**

**W. 时变率的 Poisson-Gamma（中期已有入组数据时）**
- 用户新问题：「已入组 5 个月且速度变慢，按现在的走势何时完成？」现有模型支持更新但把率当常数。
- 实现：手写 R（模拟已有分段常数总率的代码基础）。CPU 可忽略。开源包：未找到可直接复用的、经审查的包。
- 独立证据：薄，时变模型只见数据申请摘要；1910.07965 支持「区间过窄」这一问题存在。
- **判定：以后加**，等真有用户带中期数据来问。

**X. 中心选择或筛败的 ML 模型**：没有证据，又碰到 owner 边界。**判定：不值得。**

### Gaps
- 没有多申办方、独立、前瞻的 Poisson-Gamma 变体比较。
- 未找到经验证的筛败预测模型；LLM 从入排标准估筛败率的研究也没找到。
- TrialEnroll 代码匿名链接未打开，许可证未知。

---

## Q7. 先例检索：试验相似度嵌入比词重叠好吗？哪些能在 CPU 上运行？

### Takeaway
学习型嵌入在专门的试验相似度标注集上优于 BM25 和 TF-IDF（同一测试集内 nDCG@5 比 BM25 高约 0.10–0.34），但数字随测试集变化很大（Trial2Vec 的 P@1 在自家集 0.881，在 SECRET 的集上 0.422）。没人测过我们这种加权词重叠，也没人在这些集上测过通用嵌入模型。最窄的做法是不引入新模型：先 BM25，再用平台已有的 DashScope 嵌入器，用公开标注对测一次。

### Cited Findings
- Trial2Vec [PR，EMNLP Findings 2022，抓取]：BioBERT 起步的 TrialBERT；1,600 个标注对（160 个查询，候选由 TF-IDF 取前 10，这本身有池化偏差）；P@1、nDCG@5：Trial2Vec 0.881、0.8825，BM25 0.7015、0.7312，TF-IDF 0.5132、0.5480；128 维损失很小；实验用 GPU，推理硬件未说 — [arXiv 2206.14719](https://arxiv.org/html/2206.14719v1)
- SECRET [PP，Medidata 与 UIUC，抓取]：约 1 万标注 + 6 万未标注；测试 1,420 对；P@1、nDCG@5、MAP：SECRET 0.647、0.796、0.754，Trial2Vec 0.422、0.553、0.539，TF-IDF 0.363、0.522、0.501，BM25 0.334、0.454、0.471；用 Llama 3.1 8B 生成问答、BioBERT 微调、2 块 GPU；页面未提及代码 — [arXiv 2505.10780](https://arxiv.org/html/2505.10780)
- Trial2Vec 实现：MIT，最后推送 2024-04-11，27 星，`pip install trial2vec`，提供 `download_embedding` 只下载预计算嵌入（README 称省 GPU/CPU 内存）— [仓库](https://github.com/RyanWangZf/Trial2Vec)；PyTrial BSD-2-Clause，最后推送 2024-01 — [仓库](https://github.com/RyanWangZf/PyTrial)
- TrialMatchAI [PR，Nat Commun 2026]：词法 + BGE-M3 向量 + LLM 重排，但任务是患者匹配，不是试验相似度 — [Nature](https://www.nature.com/articles/s41467-026-70509-w)（检索摘要）
- 引擎现状：`precedentSimilarity` = 0.35 condition + 0.30 intervention + 0.10 phase + 0.10 design + 0.15 hasResults — 本仓库 `OpenScience/apps/server/src/vcrEvidence.mjs:425`。其中 hasResults 是数据可得性，不是相似度。
- 平台已有：`methodSimilarity.mjs` 用知识库的 DashScope 嵌入器和内存向量缓存，带词法回退 — 本仓库 `AGENTS.md`

### Inferences
- 两篇论文都显示 BM25、TF-IDF 这类词法方法是较弱基线，但差距大小不可外推，也都是开发者自报。词重叠大致属于这一类，这是推断，没有测过。
- BERT 单条查询在 CPU 上可行（我的推断，未实测）；对 50 万条全库重算嵌入在共享四核上不可行，所以只能用预计算或外部嵌入。

#### 候选卡片

**Y. 混合先例检索（BM25 + 现有 DashScope 嵌入器）+ 公开标注对评估**
- 用现有嵌入器和向量缓存；BM25 在 Node 中手写或用成熟库；把 hasResults 从相似度中拿出来，作为单独的显示标签。
- 数据：3 个注册库已有的结果集，查询时现场嵌入。CPU：BM25 可忽略，嵌入走外部调用。成本：每次查询的候选数量 × DashScope 价格。
- 用户新问题：「和我这个方案真正相似的试验是哪些？」词重叠会漏掉同义词和不同药名的同类方案。
- 独立证据：无直接证据，通用嵌入在这些集上没被测过；Trial2Vec 的 1,600 对标注是否公开 [未核实]，需先确认。
- **判定：现在加。** 符合「用现有上游、最窄适配」，且能当场测量是否优于现状。

**AA. Trial2Vec 预计算嵌入**
- MIT；预计算嵌入快照较旧（截止日期 [未核实]），新试验需要跑 BERT；要带 PyTorch，只能放进控制面或一次性容器，不能进 R 引擎。
- **判定：以后加**，仅当 Y 的测量明显不够时。

**AB. SECRET**：页面没有代码，要重新训练，要 GPU。**判定：不值得。**

### Gaps
- `PanCTR`：检索和 GitHub 搜索都未命中（只有无关仓库），无法确认其存在。
- 无中立的比较研究；无针对中文试验（ChiCTR）的相似度基准。

---

## Q8. 先验：历史成功率、效应量分布、Cochrane 经验先验

### Takeaway
最值得加的是两件很小的事：把经验异质性先验作为数据交给已有的贝叶斯路径，使两项研究也能给出预测分布（现在 k=2 时预测区间返回 NA）；以及加入 van Zwet 的经验收缩，回答「单个已发表结果被夸大了多少」。历史成功率只作为有出处的参照表。注意所有 Cochrane 先验都来自混合的干预类型，不是药物 III 期专用；RoBMA 依赖 JAGS，不进运行库。

### Cited Findings
- van Zwet 2024 [PR，NEJM Evidence，PDF 副本已读（来自 errorstatistics.com 转存）]：23,551 个 Cochrane RCT；z 统计量的零均值正态混合：比例 0.32、0.31、0.30、0.07，SD 1.17、1.74、2.38、5.73；SNR 的 SD 0.61、1.42、2.16、5.64；中位功效只有 13%，只有 12% 达到 80% 功效；在 P<0.05 条件下中位夸大因子 1.3；可算覆盖率和精确重复的概率 — [van Zwet et al.](https://errorstatistics.com/wp-content/uploads/2026/02/van-zwet-et-al-2023-corrected.evidoa2300003.pdf)；2021 年版数据量不同（预印本 23,747）— [ar5iv](https://ar5iv.arxiv.org/html/2011.15004)
- Bartoš 2023 [arXiv v1，PDF 已读，发表状态未查]：Cochrane，约 48.4 万二分类结果（97,500 比较）、8,149 个生存结果（1,515 比较）；完整数据的层次先验：log OR µ ~ Student-t(0, 0.58, 4)，τ ~ Inv-Gamma(1.77, 0.55)；log RR µ ~ Student-t(0, 0.32, 3)，τ ~ Inv-Gamma(1.51, 0.23)；RD µ ~ Student-t(0, 0.03, 1)，τ ~ Normal+(0, 0.10)；log HR 最大似然 µ ~ Student-t(0, 0.13, 2)，τ ~ Inv-Gamma(2.42, 0.30)；log HR 只有 225 个比较，所以没有分亚专科版本；二分类有亚专科表（如急性呼吸道感染 Student-t(0, 0.48, 3)，Inv-Gamma(1.67, 0.45)）；用 50% 数据估计、50% 选择 — [arXiv 2306.11468](https://arxiv.org/pdf/2306.11468)
- Bartoš 2021 [PR，Stat Med]：连续结局，46 个亚专科 — [PMC9298250](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9298250/)（检索摘要）
- Turner 2015 [PR，Stat Med，早于 2022，因题目点名列入]：14,886 个二分类 meta 分析，80 种情形的 τ² 预测分布，有 R 代码 — [UCL](https://discovery.ucl.ac.uk/id/eprint/10050236/)（检索摘要）。Rhodes 2015：6,492 个连续结局 meta 分析，SMD 尺度 — [Plymouth](https://researchportal.plymouth.ac.uk/en/publications/predictive-distributions-for-betweenstudy-heterogeneity-and-simpl/)（检索摘要）
- 期望和观察效应：2023 年发表于 10 本顶刊的 111 个 III 期肿瘤试验，143 个生存终点，期望 HR 均值 0.66，观察 0.72（P=.0035）；57.3% 弱于期望，OS 63.0%，PFS 50.8%；期刊选择影响很大（高影响因子 39.0%，其余 70.2%）— [Lamp & Mazza 2025, JNCI](https://pmc.ncbi.nlm.nih.gov/articles/PMC12415963/)。II 期 PFS 效应平均比配对 III 期大 26% — [EJC](https://www.sciencedirect.com/science/article/abs/pii/S0959804919304666)（检索摘要）
- 成功率：BIO/QLS/Informa 2011–2020，12,728 次阶段转换，9,704 个项目，1,779 家公司，Phase 1 到批准 7.9%（2006–2015 版 9.6%），生物制品 9.1%，NME 5.7% — [BIO](https://www.bio.org/clinical-development-success-rates-and-contributing-factors-2011-2020)，[PharmTech](https://www.pharmtech.com/view/clinical-development-success-rates-examined-new-bio-report-0)；II 期通过 28.9%，血液学 23.9%，泌尿 3.6%（来自中文二手摘要）— [cn-healthcare](https://www.cn-healthcare.com/articlewm/20210508/content-1217774.html)。未找到 2021 年以后的 BIO 更新。
- Wong、Siah、Lo 2019 [PR，抓取]：2000-01 到 2015-10，406,038 条，185,994 个试验；路径法 Phase 1→批准 13.8%，2→3 48.6%，3→批准 59.0%；肿瘤 3.4%，非肿瘤 20.9%；数据来自商业 Citeline — [Biostatistics](https://academic.oup.com/biostatistics/article/20/2/273/4817524)。与 BIO 的差距主要来自方法（路径法对阶段法）和数据集，不能混用。
- 824 个肿瘤 III 期成功 43.4% — [PMC13244666](https://pmc.ncbi.nlm.nih.gov/articles/PMC13244666/)（检索摘要）
- 包的事实：bayesmeta CRAN 3.5（2025-08-29，GPL ≥2）；RoBMA CRAN 4.0.0（2026-05-07，GPL-3，依赖 JAGS，见 Bartoš 2023）；metafor 5.2-1（2026-09-15，GPL ≥2）— 通过 crandb 查询。
- 引擎现状：`vcr_map_prior` 已在网格上做 normal-normal，τ 先验只支持 half_normal、half_cauchy、uniform，默认 half_normal(0.5) — `map_prior.R`；`evidence_pool.R` 有 DL、REML、HKSJ 和预测区间，k=2 时预测区间返回 NA；`assurance.R` 以该预测分布作为设计先验，用 64 点 Gauss-Hermite 积分。

### Inferences
- 这些先验的 µ 都以 0 为中心，描述「Cochrane 里的比较总体」，不是某个药的效应。直接当设计先验会把 assurance 压低，只适合标注为「怀疑基准」，放在用户先验旁边。这是我的推断。
- log HR 的 τ 先验只基于 225 个比较，比二分类的弱得多，要写明。

#### 候选卡片

**Z. 历史成功率参照表（BIO 2011–2020 + Wong 2019，分阶段、领域）**
- 实现：`packages/domain` 里的一张带出处的数据表，加在 assurance 结果旁边。CPU 无。公开报告的聚合数字，底层数据商业。
- 用户新问题：「我的 assurance 是 62%，这个领域这一阶段历史通过率是多少？」今天没有参照。
- 独立证据：两个独立团队的数据，方法不同，所以两个都显示。TOP 再评估也说明基率本身已有不小的预测力。
- **判定：现在加。** 表是参照，不是这个试验的概率，界面要这样说。

**AC. 经验 τ 先验 + k=2 的贝叶斯预测分布**
- 方法：Turner 2015、Bartoš 2023 的 τ 先验，手写网格积分（现有 `vcr_map_prior` 加一个 `inv_gamma` 种类）；CI 对照 bayesmeta。
- CPU：网格积分，毫秒级；确定性。
- 用户新问题：「只有两项研究，设计先验应该多宽？」今天预测区间返回 NA，只能手写一个数。
- 独立证据：先验在留出的 Cochrane 数据上由开发者自己选择（Bartoš）；Turner 的独立使用未在本轮确认。
- **判定：现在加。** 改动很窄，是 k 很小时的实际缺口。结果要标明先验来源。

**AD. 经验收缩（van Zwet 混合）**
- 方法：用已发表的混合参数算条件夸大因子、收缩估计、精确重复概率，公式闭式或确定性数值积分；手写 R。
- CPU：可忽略。无许可证问题（使用公开发表的参数）。
- 用户新问题：「这个 II 期 HR 0.66、z=2.2，III 期设计时应打多少折？重复成功的概率是多少？」今天只能用原值或主观折扣。
- 独立证据：NEJM Evidence 发表；Lamp & Mazza、EJC 的数字方向一致，但不是专门验证。混合来自全 Cochrane，包括非药物和小试验，对申办方 III 期可能过度收缩。
- **判定：现在加。** 输出标为「基于 Cochrane 总体的经验估计」，只作为对照，不改用户的值。

**AE. Student-t 设计先验（Bartoš µ）用于 assurance**：assurance 现用正态 Gauss-Hermite，要换积分。价值是「怀疑基准」。**判定：以后加。**

**AF. RoBMA（贝叶斯模型平均 + 发表偏倚）**
- 用户新问题：「考虑发表偏倚后，效应还剩多少？」现有 `evidence.pool` 不回答这个。
- 问题：依赖 JAGS 和 MCMC，不在运行库；单任务并发下耗时不小（未实测）。GPL-3。
- **判定：以后加。** 真要加时先进 CI，单独评估能否放入运行库或容器。

### Gaps
- 没有找到按 ClinicalTrials.gov 结果刻画效应量分布并用于 assurance 的已发表研究。
- 未找到经验先验用于 assurance 的实测（是否改善决策）。
- Bartoš 2023 的正式发表状态未查；Lilienthal 2024 未找到；Turner、Rhodes 只读到摘要层。

---

## Q9. 试验结果数据：AACT 与 ClinicalTrials.gov 结果部分的获取、用途与局限

### Takeaway
单个试验的结果平台已能取到（v2 API 的 `resultsSection`），AACT 的增量只在跨试验的批量分布。它可以离线抽取成带版本的小表用于参数参照，比如对照组事件率和脱落率。但结果部分的覆盖和结构都差：到期试验约 64% 有结果，有效疗效分析约 55%，臂未标注干预或对照，也没有变更历史。不应在运行时依赖它，也不能把它当无偏的效应分布。

### Cited Findings
- AACT 访问：40 多张关联表，每日从注册库刷新，可 SQL 查询或下载快照，需要注册账户；首页未给出价格、许可证或数据局限 — [AACT 首页](https://aact.ctti-clinicaltrials.org/)（抓取）
- 局限（第三方 Wiki，未声称官方）：是下载当日的快照，变更历史不在单个版本中；缺失和 N/A 须说明处理方式；只有一小部分研究被要求报告结果；结果未必经过同行评议式审查；工作人员无法始终验证所提交数据 — [Points to consider](https://github.com/SturdyCo/aact2/wiki/Points-to-consider-when-using-AACT)
- 报告率：4,209 个到期试验中 40.9% 按时报告，63.8% 曾提交；只查了是否发布，没查质量 — [DeVito 2020, Lancet](https://www.bennett.ox.ac.uk/papers/172/)（检索摘要；早于 2022）
- 结构 [PR，Sci Data 2024，抓取]：结果基本只有网页或原始 XML；不良事件结构最好；P 值和 CI 格式不一；分析部分的臂未标注干预或对照；结局标题是自由文本；11,729 项研究中 6,429（54.8%）有有效疗效分析（分母定义不清）；得到 119,968 个比较，43.61% 阳性、56.39% 阴性（由 p 值和 CI 规则判定）；100 条人工核对中，干预臂标注正确 84%，对照臂 80%；未校正多重检验；只保留严格两臂；2022 快照 — [Shi & Du 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC10771511/)
- 其他：100 个样本中 61% 的结局指标未写明计划分析所用的度量 — [NEJM 2011](https://www.nejm.org/doi/full/10.1056/NEJMsa1012065)（检索摘要，较旧）；同一份检索摘要还说某样本中 24% 的试验报告了不超过 90% 的受试者结果，出处未定位，[未核实]。基线指标格式需要统一才能二次使用 — [PMC5673198](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5673198/)（检索摘要）
- 平台现状：`trial_snapshots.py` 读取完整 v2 记录（含 `resultsSection`），保存内容寻址快照，并按标题对齐注册结局和报告结局 — 本仓库 `OpenScience/runtime/mcp/evimed-research/trial_snapshots.py`。我 2026-11-02 实测 v2 API 可达，`hasResults` 字段可用。
- 引擎的相关判断：注册库给的入组率先验「偏低」，无中心级数据 — `accrual.R`

### Inferences

#### 候选卡片

**AG. AACT 离线抽取的参数参照表（先做已有的三个疾病包）**
- 方法：离线定期取快照，抽取对照组事件率、脱落率、基线人数、入组数和时长，按疾病包归类；输出带快照日期和哈希的表，放在数据层供模型引用；引擎运行时无网络的约束不受影响。
- 数据局限见上；用量大时可参考 Shi & Du 的清洗规则。
- CPU：SQL 与 pandas，离线跑；数据库全量快照的体积未查（[未核实]），需要关注本机磁盘。
- 用户新问题：「NSCLC 二线 OS 试验的对照组，事件率和脱落率一般是多少？」今天要由模型逐个读先例，结果不成分布。
- 独立证据：无直接评估这种用法的研究。
- **判定：以后加。** 排在 Y（检索）之后：可以先用逐个读取加代码汇总得到小样本分布，满足多数请求；只有当请求覆盖面明显超过逐个读取的能力时，才做批量。给出分布时要写明覆盖率和选择偏差，不称为「效应量先验」。

**AH. 用 AACT 结果构建通用效应量先验**：选择偏差大（到期试验中约 36% 到数据截止仍未提交），结局异质，无方向标注，P 值格式乱。**判定：不值得。** Cochrane 派先验已有发表基础。

#### 全部候选的判定汇总

现在加：
- A IPDfromKM 只进 CI
- H 数字化器和重建的已知真值测试台
- J 两次独立读取 + 代码比对
- K 确定性内部一致性检查（先作通知）
- O 基线表的小型实测
- Y 混合先例检索 + 评估
- Z 历史成功率参照表
- AC 经验 τ 先验与 k=2 预测分布
- AD van Zwet 经验收缩

以后加：
- B 多套可行 IPD（等 H 的结果）
- E KMGen
- I 刻度 OCR 核对（等 H 的结果）
- P Docling 第二读者（等 O 的结果）
- W 时变率 Poisson-Gamma
- AA Trial2Vec 预计算嵌入（等 Y 的结果）
- AE Student-t 设计先验
- AF RoBMA
- AG AACT 离线参照表

不值得：
- C `KMtoIPD`、D SurvdigitizeR 替换
- F 视觉 LLM 直接读图、G 专用读图模型
- L PaperQA2、M RobotReviewer、N 整合系统
- Q 通用视觉 LLM 读表
- R 深度结局预测、S 注册文本回归、T 商业预测产品
- V 深度入组模型、X 中心或筛败 ML
- AB SECRET、AH AACT 通用效应量先验

商业使用需明确的事实：HINT、MEXA-CTP、EviSearch、LineFormer 未声明许可证（无授权）；RoBMA、reconstructKM、RobotReviewer 为 GPL-3，IPDfromKM 在 CRAN 记 GPL-2，WebPlotDigitizer 为 AGPL-3.0；SurvdigitizeR 的许可证未确认。

### Gaps
- AACT 官方数据字典和文档页在我试过的地址上返回 404（`/data_dictionary`、`/documentation`、`/points_to_consider`），`/schema` 返回 302 未跟进。所以结果表的确切表名（如 outcome_analyses、baseline_measurements）是凭记忆，未经本轮核实；AACT 的使用条款也未读到。
- 结果部分与期刊发表的效应值差异：一次检索没有拿到数字。
- 找不到比较 AACT 与逐个 API 读取在参数参照上效果的研究。
