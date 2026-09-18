# C · 产品与 UX 对标研究(2024–2026)

> 研究对象:EviMed(循证医学 AI 研究工作台,中文界面,面向临床医生 / 临床药师 / 医学研究者)。
> 本文只做外部对标与模式提炼,不改任何代码。
> 日期:2026-09-18。凡是无法从一手资料核实的描述,均标 **未核实**。
> 引用一律给 URL;产品名与链接保持原文。

## 目录

1. [长任务 / Deep Research 的过程 UX](#1-长任务--deep-research-的过程-ux)
2. [科研与临床工具的证据 / 引用 UX](#2-科研与临床工具的证据--引用-ux)
3. [工作台信息架构(项目 / 线程 / 任务 / 产物)](#3-工作台信息架构项目--线程--任务--产物)
4. [医疗级信任与安全 UX](#4-医疗级信任与安全-ux)
5. [Top 20:EviMed 应当采纳的模式](#5-top-20evimed-应当采纳的模式)
6. [反模式](#6-反模式)
7. [给设计团队的 10 条最佳链接](#7-给设计团队的-10-条最佳链接)

---

## 0. EviMed 当前的七个问题(编号供后文引用)

| 编号 | 问题 |
|---|---|
| (a) | 8–28 分钟长跑期间只有转圈 + 计时器:无计划、无步骤进度、无已找到来源、无 ETA |
| (b) | 右侧面板空白 |
| (c) | 能力发现 = 输入框上方 15 个等权胶囊 |
| (d) | 任务列表显示能力名而非问题 |
| (e) | 「Default Project」对用户无意义;项目 / 线程 / 任务层级混乱 |
| (f) | 自动化运行堆积未读通知,且携带原始校验器文本 |
| (g) | 视觉语言不统一(暖中性外壳 + 冷蓝对话框) |

---

## 1. 长任务 / Deep Research 的过程 UX

对应 EviMed 问题 **(a)** 为主,兼及 (b)(f)。

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| ChatGPT Deep Research | **先澄清再开工**:提交问题后先问澄清问题,然后才开始跑;跑起来后侧边栏显示「已执行的步骤摘要 + 已用来源」,可实时追踪进度,可中途插入后续 prompt 或新来源来调整方向;可在开跑前编辑研究计划,并配置来源范围(公开网页 / 上传文件 / 已启用 app / 指定站点) | 长任务最大的成本是「跑错方向 30 分钟」。澄清 + 计划编辑把纠错成本从 30 分钟压到 30 秒;侧边栏把「不可见的等待」变成「可读的工作日志」 | https://help.openai.com/en/articles/10500283-deep-research-faq |
| ChatGPT Deep Research | 屏幕上的**进度条本身可点击**,点开是一个面板,说明「正在做什么动作 + 为什么做这个动作」 | 进度条从装饰变成入口;「为什么」比「是什么」更能建立信任 | https://help.openai.com/en/articles/10500283-deep-research-faq |
| ChatGPT Deep Research | 报告带引用与来源链接;官方定位是「把几小时到几天的活压成 30 分钟报告」,并明确长任务可离开页面 | 明确的时长心智契约("这是 30 分钟的事,不是 30 秒的事")比任何 spinner 都有效 | https://openai.com/index/introducing-deep-research/ · https://chatgpt.com/features/deep-research/ |
| Gemini Deep Research | **计划先行且可编辑**:输入问题 → 生成多步研究计划 → 「Edit plan」修改 → 「Start research」开跑。用户可加必答问题、删无关任务、设定日期范围、指定对比字段、要求一手来源 | 计划是用户唯一能在花钱/花时间之前施加影响的杠杆;也顺带教会用户这个 agent 会怎么思考 | https://support.google.com/gemini/answer/15719111?hl=en |
| Gemini Deep Research | 报告生成期间有**「思考面板」(thinking panel)**,可追踪「模型当前学到了什么」以及「预计执行的下一个动作」 | 「已学到什么 / 下一步做什么」是两个最小充分的进度维度——比百分比进度条诚实,比原始日志可读 | https://gemini.google/overview/deep-research/ |
| Gemini Deep Research | **后台完成 + 通知**:文档明说「通常 5–10 分钟」,可以离开对话;报告就绪后 web 端在对话线程旁提示、移动端发系统通知,用户点「Open」打开 | 长任务不应绑架用户的注意力;通知是长任务产品的基础设施,不是附加功能 | https://support.google.com/gemini/answer/15719111?hl=en |
| Gemini Deep Research | 结果落在 **Canvas 面板**(右侧),带「Export to Docs」「Share Canvas」「Copy Contents」,还能生成 Audio Overview | 报告是「产物」不是「聊天消息」:产物要有自己的容器、自己的导出动作 | https://support.google.com/gemini/answer/15719111?hl=en |
| Perplexity Deep Research | 进度侧栏按**三个阶段**推进(查询理解 → 检索执行 → 综合起草),并显示实时检索统计 | 阶段化让「26 分钟」有了结构:用户知道现在处于哪个阶段、还剩哪几个阶段 | https://www.perplexity.ai/help-center/en/articles/13600190-what-s-new-in-advanced-deep-research |
| Perplexity Deep Research | 新进度显示会讲明**「正在读哪些来源、学到了什么、报告成型到什么程度」**;关键发现在过程中就先冒出来,用户不必等最终报告;研究还在跑时就能追加后续问题 | 流式的部分结果把「等待」变成「边读边等」,是把 8–28 分钟从损失变成价值的唯一办法 | https://www.perplexity.ai/help-center/en/articles/13600190-what-s-new-in-advanced-deep-research |
| Manus | 侧面板 **"Manus's computer"** 实时展示 agent 的每一个动作(打开了哪个页面、在表单里输入了什么、复制了什么) | 「实况计算机视图」把黑箱变玻璃箱;对需要复核的专业用户,这就是审计线索 | https://workos.com/blog/introducing-manus-the-general-ai-agent |
| Manus | **`todo.md` 作为活的任务清单**:计划步骤写成文件,每完成一步就勾掉一项,是「做完了什么 / 还剩什么」的单一事实来源,即使会话中断也在 | 计划作为**文件**而不是 UI 状态:可断点续跑、可分享、可审计。EviMed 的多 deliverable 委派天然是这个形状 | https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f |
| Manus | **每个会话可回放(replay)**,任务结束后可重看整个过程、看清每段结论来自哪里;会话可分享给同事,分享时自动隐藏 connector 输出、脱敏 API key | 回放 = 事后可验证性 + 培训素材 + 协作。医疗场景里「这个结论当时是怎么得出来的」是刚需 | https://cybernews.com/ai-tools/manus-ai-review/ |
| Devin | 右侧**工作区分四个 Tab:Planner / Shell / Editor / Browser**,Planner 就是一份待办清单,用于规划和追踪进度;打开「Following」开关,工作区会跟着 agent 实时切 Tab | 右侧面板 = agent 的工作台,不是聊天的附属品;「Following」把「盯着看」做成一个可开关的模式,而不是强制 | https://docs.devin.ai/work-with-devin/devin-session-tools · https://fast.io/resources/devin-session-tools-guide/ |
| Devin | 有 **planning mode**:先列出要改哪些文件、提出需要澄清的问题,用户批准计划(或让它自动跑)后才执行 | 「批准计划」是把控制权交还用户的最低成本方式 | https://fast.io/resources/devin-ai-agent-guide/ |
| Devin | 会话中的**任一步骤可点击**,Progress 标签把 shell / 代码编辑 / 浏览器交互统一成一条时间线;终端可从只读切成可写,用户随时接管 | 「统一时间线 + 可点开每一步」正是 EviMed 缺的东西;接管开关则是 steer 的终局形态 | https://docs.devin.ai/work-with-devin/devin-session-tools |
| Cursor | Agent 用**结构化 to-do 列表**先规划,长任务的清单在对话里可见并随进展更新;2.x 起「计划本身是文件,可用普通工具编辑」 | 计划即文件(同 Manus todo.md)。清单流式更新解决了「长时程任务不可理解」 | https://cursor.com/changelog/1-2 · https://cursor.com/changelog/2-2 |
| Cursor | **原生 OS 通知**:agent 跑完时、或需要用户输入时(例如批准一条不在允许清单里的命令)发系统通知,在 Settings 里开启 | 通知只在两种时刻发:**完成** 和 **需要你**。这是通知设计的黄金二分法,直接对应 EviMed 的 (f) | https://cursor.com/changelog/1-5 |
| Cursor | 后台 agent 会「以评论和 todos 的形式持续汇报状态」 | 后台任务也要有进度面,否则后台 = 失联 | https://cursor.com/changelog/0-50 |
| Kimi-Researcher | 展示**思考轨迹**:平均 23 个推理步、74 个关键词、访问 206 个 URL、筛到最优的 3.2%;过程中会写出「为确认这一点,我需要再搜…」「我之前假设 X,但需要进一步证据」;对来源会标注权威性,对来源不清或可能有偏倚的信息给出特别说明 | 「找了 206 个、留下 3.2%」这种**漏斗数字**比进度条更能表达工作量;对来源标注可靠性,正是循证医学要的 | https://finance.sina.cn/tech/2025-06-21/detail-infausvv2107594.d.html?vt=4 · https://zhuanlan.zhihu.com/p/1921119537757140195 |
| 秘塔AI搜索 DeepResearch | 深度研究界面**左上角常驻三个数字:占用 token 数、找到的信源数量、调研花费时间**;界面最下方滚动显示正在进行的任务;并用「具象化的证据链」展示探索脉络 | 三个数字 = 成本 / 产出 / 时间,一眼可读;中文用户已被教育过这套表达 | https://zhuanlan.zhihu.com/p/1928563690308871248 |
| 秘塔AI搜索 | 侧边栏同时给**大纲与脑图**,并自动生成相关事件/组织/人物表格;三档搜索模式(简洁 / 深入 / 研究)对应不同的检索广度 | 「深度档位」让用户自己选时间预算,而不是产品替他决定 8 分钟还是 28 分钟 | https://www.53ai.com/news/LargeLanguageModel/2024070273026.html |
| Genspark Super Agent | 把请求拆成步骤、选工具、跑到成品;产物是 **Sparkpage** —— 一个动态生成的页面,分节、带引用、内置 copilot 可就地追问「展开这一节」「加一个对比」 | 产物页面自带追问入口,避免用户为了一个小追问再开一轮长任务 | https://www.genspark.ai/helpcenter/super-agent · https://cybernews.com/ai-tools/genspark-ai-review/ |
| ChatGPT agent(已于 2026-08 下线,**未核实**该下线说法的一手来源) | 遇到登录、支付等敏感步骤会**暂停并把浏览器交还用户**("takeover mode"),用户手工完成后 agent 继续 | 「暂停 → 请人接手 → 继续」是长任务里处理不可自动化步骤的标准解法;EviMed 的「需要澄清」可以复用这个形状 | https://help.openai.com/en/articles/11752874-chatgpt-agent · https://www.atwix.com/news/openai-agent-mode/ |

### 本节提炼的复现模式

1. **计划先行、可编辑、需批准**(Gemini / Devin / Cursor / ChatGPT)——四家独立收敛到同一形状。
2. **步骤时间线 + 当前步高亮**,且每一步可点开看细节(Devin / ChatGPT / Manus)。
3. **「已找到来源」实时计数与列表**(秘塔 / Perplexity / ChatGPT / Kimi)。
4. **流式部分结果**:关键发现先冒出来,不必等最终报告(Perplexity)。
5. **后台完成 + 通知**,且通知只在「完成」与「需要你」两种时刻发(Gemini / Cursor)。
6. **时长心智契约**:官方文档直接写「通常 5–10 分钟 / 30 分钟报告」(Gemini / OpenAI)。
7. **中途可插话 steer**,不必取消重来(ChatGPT / Perplexity / Devin)。
8. **计划即文件**(Manus todo.md / Cursor plan file)——可续跑、可分享、可审计。
9. **回放**(Manus)——事后复盘每段结论的来路。
10. **成本/工作量可视化**:token、信源数、耗时、筛选漏斗(秘塔 / Kimi)。

## 2. 科研与临床工具的证据 / 引用 UX

对应 EviMed 的**证据阅读体验**(「依据」popover、证据矩阵、✓/⚠ 标记)为主,兼及 (b)。

### 2.1 临床决策支持(面向医生的答案型产品)

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| OpenEvidence | 答案是带**行内编号引用**的短文;点任一行内引用直接打开一手文献;展开 details 可读每条参考的摘要、给回答打分、复制可分享链接、看自动生成的后续问题 | 「点引用→原文」是最低成本的可验证性;自动生成的后续问题降低了第二轮提问的启动成本 | https://libguides.mssm.edu/blogs/ai/blog/OpenEvidence-as-Learning-Tool · https://research.contrary.com/company/openevidence |
| OpenEvidence | **「这条来源为什么被引用?」**:References 区给来源打标签——`Highly Relevant`(算法判定可直接回答该问题)、`Top Journal`/`Leading Journal`(影响因子 ≥ 90 分位,如 Lancet、NEJM)、`New Research`(近一年发表) | 三个标签把「检索相关性 / 期刊层级 / 时效」三个独立维度拆开显示,读者能自己决定信谁——而不是被一个黑箱排名说服 | https://www.openevidence.com/announcements/new-feature-why-was-this-source-cited |
| OpenEvidence(第三方实证) | 4,979 条引用、五个专科、150 条标准 prompt:**零条捏造引用**,仅 3 条会议摘要归属错误(0.06%);69.8% 发表于 2020 年后。但论文直接批评界面:「**OE 界面不在生成文本中标注来源类型;所有引用都表现为完全相同的编号引用**」,而底层其实混着 RCT、指南、监管文件、Cochrane 综述 | 这是对 EviMed 最直接的一条教训:**引用不是一种东西**。把指南、RCT、说明书、监管文件画成一模一样的上标,等于让读者失去判断力 | https://pmc.ncbi.nlm.nih.gov/articles/PMC13538487/ · https://www.nature.com/articles/s44401-026-00142-8 |
| UpToDate Expert AI | 自然语言提问 → 综合答案 + **回链到 UpToDate 原文的行内引用**,并可在 AI 界面内直接展开支撑内容而不跳走;每条回答含**透明的推理与明确写出的假设**,并有 inline nudge 引导用户把问题问得更好;底层内容带**分级推荐(graded recommendations)** | 「写出假设」是医疗 AI 最被低估的一招:临床问题永远缺参数,把 agent 的默认假设摆到台面上,读者一眼就知道这条答案适不适用于他的病人 | https://www.wolterskluwer.com/en/solutions/uptodate/uptodate-expert-ai · https://www.wolterskluwer.com/en/solutions/uptodate/about/editorial-process |
| DynaMed Dyna AI(2026-02 上线) | 每条回答**高亮指出用到了 DynaMed 哪几个主题子章节**,一键跳转;DynaMed 每条推荐本身自带**明确的证据等级与推荐强度**;官方口径是让临床医生「完整看到:问了什么、用了什么推理、底层证据在哪」 | 引用粒度到**子章节**而不是到文档,是可验证性的分水岭;等级 + 强度是中国临床医生同样熟悉的语言 | https://about.ebsco.com/news-center/press-releases/ebsco-clinical-decisions-launches-dyna-ai-mode · https://more.ebsco.com/Dyna-AI.html |
| ClinicalKey AI | 回答**追溯到被引用的那一个段落**,不止到论文或教科书;实时引用校验,官方说法是从 "black box" 变 "glass box";答案用要点式呈现并附引用 | 与 EviMed 的「逐句绑定原文摘录」是同一条路线;「实时引用校验」正是 EviMed 服务端复核 quote 的对外说法 | https://www.elsevier.com/products/clinicalkey/clinicalkey-ai · https://www.elsevier.com/about/press-releases/elsevier-expands-clinicalkey-ai-with-unrivaled-full-text-knowledge-base-and |
| Pathway | 助手**逐步展示推理**,每条推荐链接到专家审核过的指南与药物参考;可让它**用表格对比不同指南的异同**;结构化**药物卡片**(剂量、调整、相互作用)供开方前复核 | 「指南冲突对比表」是循证医学最高频的真实需求之一,EviMed 15 个能力里没有一个把它做成一等产物 | https://www.pathway.md/ · https://www.aafp.org/fpm/2025/0700/ai-enhanced-apps |
| Glass Health | 鉴别诊断分成 **Most Likely / Expanded Differential / Can't Miss** 三类;A&P 每个 problem 带「基于本次就诊数据的评估」+「附指南与文献引用的管理计划」;可在同一界面追问、要更深的证据 | **「Can't Miss」是一个安全设计,不是一个信息分类**:把「漏了会出人命的」单列一栏,比任何免责声明都有效 | https://glass.health/resources/ai-diagnosis · https://glass.health/resources/ai-evidence-based-medicine |
| 医脉通 MedSeeker 2.0 | 权威来源**一键溯源**:点击可定位到指南/说明书**原文的具体位置**;明确标示引用来源**与适用条件**;案例:对比 2026 ACC/AHA 与 2019 ESC 肺栓塞指南差异并直链原文;做「证据分层治理、动态管理」,输出层按**相关性 / 级别 / 时效**三因素动态重排 | 中文临床用户已经在用的心智模型:溯源到原文位置 + 标注适用条件 + 按时效重排。EviMed 的中文界面应该向它对齐而不是向英文产品对齐 | https://www.sohu.com/a/999005689_377321 · https://news.qq.com/rain/a/20250327A07OPW00 |
| 讯飞晓医 / 星火医疗大模型 X1 | 回答复杂问题时**逐步解释循证过程**,整合最新临床指南与权威文献构建「循证思维链」,官方把可解释性与降低医疗幻觉并列为目标 | 中文语境里,「循证过程可见」已经是产品宣传语,说明用户预期已经建立 | https://news.qq.com/rain/a/20250304A06LBE00 · http://ah.news.cn/20251107/85e6a0f29fe6453ab716710bb8c10fab/c.html |
| 夸克健康大模型 | 知识库口径公开可查:6 万册教材指南、5000 余万中英文文献、20 余万药品说明书;与 200+ 权威专家、60+ 三甲医院共建;千人医师标注团队(400+ 副主任及以上) | **把知识库边界讲清楚**本身就是一种信任设计:用户知道它能答什么、不能答什么 | https://www.53ai.com/news/LargeLanguageModel/2025072324137.html · https://finance.sina.com.cn/roll/2025-07-23/doc-infhmxpq1182838.shtml |
| 丁香园用药助手 | 药品 / 疾病 / 指南 / 医学工具四大模块;7 万+ 中外说明书、覆盖国内 99% 药品、按药监局信息实时更新;4000+ 疾病决策专题、3 万+ 临床指南;数据由三甲医生参与生产与审核 | 「**说明书是一个独立的来源类型**」在中国临床是硬需求,EviMed 的来源类型标签体系必须把它单列 | https://drugs.dxy.cn/pc · https://app.mi.com/details?id=cn.dxy.medicinehelper |

### 2.2 科研文献工具(面向研究者的产物型产品)

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| Elicit | **论文表格**:一行一篇论文,一列一个自定义抽取字段;**点任一单元格即可看到该结论在原文中的支撑引文**,用于核对 AI 抽取是否正确 | 「每个抽取值离原文引文只有一次点击」——这正是 EviMed 证据矩阵应该有的交互,而不是一张静态表 | https://support.elicit.com/en/articles/14759154-systematic-reviews-in-elicit · https://elicit.com/blog/systematic-review/ |
| Elicit 系统综述 | 六步工作流 Setup → Gather → Screening → Extraction → Report;筛选阶段**自动生成纳排标准**,用户可编辑/停用/新增;被排除的论文显示**支撑该排除决定的原文引文**;点任一篇可看**逐条标准的判定、排除理由与来源引文**,可人工 Include/Exclude 覆盖并 "Save & next";筛完给一个**阈值滑块**调整纳入宽严 | 这是把「不可解释的 AI 判断」变成「可复核的人机协作」的完整范式:每个自动决定都附带它的理由和原文,且可被推翻 | https://support.elicit.com/en/articles/14759154-systematic-reviews-in-elicit |
| Elicit | 明确对齐 **PRISMA 2020**;任一步骤可 **CSV 导出**;全档位支持只读分享链接 | 学术产物必须能出 PRISMA 流程图和可交付的表格,否则它进不了论文 | https://elicit.com/blog/systematic-review-for-prisma-2020 |
| Consensus | **Consensus Meter**:把论文按 `yes` / `no` / `mixed` / `possibly` 分类并可视化分布 | 一个问题的文献结论是否一致,是读者最先想知道的事;分歧可视化比「综合结论」更诚实 | https://consensus.app/home/blog/introducing-the-consensus-meter/ · https://help.consensus.app/en/articles/10069920-the-consensus-meter |
| Consensus | **Meter Snapshot 四个质量指标**:Recency(各立场论文平均发表年份)、Methods(各立场中 Meta 分析 / 系统综述 / RCT 的篇数)、Journals(期刊 SJR 均分)、Citations(引用总数);**indicator badge 标出各指标由哪一方「胜出」** | 把「谁更可信」拆成四个可独立核对的指标,而不是一个合成分。EviMed 的 synthesized claim 完全可以这样展示 | https://consensus.app/home/blog/new-consensus-meter/ |
| Consensus | **Study Snapshot**:从摘要抽取最多 7 类信息(人群、样本量、地点、结果、结局、时长、方法) | 结构化「一眼读懂这篇研究」≈ PICO 卡片,免去读摘要 | https://libguides.lmu.edu/c.php?g=1426515&p=10582325 |
| Undermind | **发现曲线(discovery curve)**:用统计模型估计某主题相关论文总数,并报告本次检索**覆盖了其中约百分之多少**(示例:分析 180 篇,估计相关 12–16 篇,约为全部相关文献的 89.7%) | 唯一一个把「我搜全了吗」做成可读数字的产品。对系统综述与循证评价,**召回率的自我报告比任何排版都值钱** | https://www.undermind.ai/whitepaper.pdf · https://casrai.org/guides/undermind-ai |
| scite | **Smart Citations**:用模型把引用语句分成 `supporting` / `contrasting` / `mentioning` 三类,并展示引用语句的上下文原文;徽章把「被引 N 次 / 支持 X / 提及 Y / 反驳 Z」做成一眼可读的条 | 「被引多」不等于「被支持」。对药物评价与安全性信号,**反驳性引用是最该被看见的那一类** | https://scite.ai/badge · https://direct.mit.edu/qss/article/2/3/882/102990/scite-A-smart-citation-index-that-displays-the |
| NotebookLM | 答案只用选定来源;**行内引用 chip** 可悬停预览被引原文,点击跳到来源中的那一段 | 悬停预览 + 点击定位是「依据 popover」的成熟形态:轻量确认用悬停,深度核对才跳转 | https://www.semanticscholar.org/product/semantic-reader (对照) · https://learnprompting.org/blog/notebooklm-guide |
| SciSpace | **左论文 / 右 AI 对话**的分屏;答案带「引自 PDF 哪一节」的引用;可在阅读中高亮并留注 | 「原文—答案」并排是核对证据的最省力布局,右侧面板天然适合放它 | https://scispace.com/chat-pdf · https://scispace.com/help/en/articles/10750976-how-to-highlight-text-in-chat-with-pdf |
| Cochrane / GRADE | **Summary of Findings 表**:每个重要结局一行(最多 7 行),给出效应量与证据确定性等级;确定性按 5 个域(偏倚风险、不一致性、间接性、不精确性、发表偏倚)**分级升降,每一步降级都有具名理由**;表下有图例解释符号 | GRADE 的精髓是「**等级必须附带它为什么是这个等级**」。EviMed 的 synthesized claim 的 confidence label 应该照搬这个要求 | https://training.cochrane.org/handbook/current/chapter-14 · https://gradepro.org/handbook/ |

### 本节提炼的复现模式

1. **来源类型必须可见**(OpenEvidence 的反面教材 + DynaMed / 用药助手的正面):指南 / RCT / 说明书 / 监管文件 / 综述要有不同的视觉身份。
2. **引用粒度到段落或子章节**,不是到文档(ClinicalKey AI / DynaMed / NotebookLM)。
3. **悬停预览 + 点击定位原文**两级交互(NotebookLM)。
4. **每个自动判定都附带它的理由与原文引文,并且可被人工推翻**(Elicit screening)。
5. **分歧可视化**而非强行综合(Consensus Meter / scite contrasting)。
6. **质量维度拆开显示**,不合成单一分数(Consensus 四指标 / OpenEvidence 三标签)。
7. **召回率自我报告**(Undermind discovery curve)。
8. **明确写出假设与适用条件**(UpToDate Expert AI / MedSeeker)。
9. **等级必须附带具名的升降理由**(GRADE)。
10. **指南冲突对比表**作为一等产物(Pathway / MedSeeker)。
11. **安全兜底分类**(Glass Health 的 Can't Miss)。

## 3. 工作台信息架构(项目 / 线程 / 任务 / 产物)

对应 EviMed 问题 **(b)(c)(d)(e)(f)**。

### 3.1 容器层级:项目 / 线程 / 产物

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| ChatGPT Projects | 项目 = **对话 + 参考文件 + 自定义指令**三者同处一地;可把已有对话拖进项目,拖入后该对话**继承项目的指令与文件上下文** | 「容器」只有在它**改变里面对话的行为**时才有意义。EviMed 的 Default Project 什么都不改变,所以它对用户就是噪音 | https://help.openai.com/en/articles/10169521-projects-in-chatgpt |
| ChatGPT Projects | 可选 **project-only memory**:开启后本项目内对话只引用本项目内的其他对话,不引用项目外;项目一旦被分享,project-only memory 自动开启 | 记忆边界 = 项目边界,是最好懂的心智模型。对 EviMed 的 memory 能力尤其重要:哪些记忆属于这个课题,应该由项目决定 | https://help.openai.com/en/articles/10169521-projects-in-chatgpt |
| Claude Projects | 项目 = 「自带聊天历史与知识库的自包含工作区」;**知识库面板在项目主页右侧**;项目指令可定制语气/视角;共享权限只有 `Can view` / `Can edit` 两档 | 权限只有两档 = 不让用户做设计决定。EviMed 面向科室协作时值得照抄 | https://support.claude.com/en/articles/9517075-what-are-projects · https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects |
| Claude Projects | **归档(archive)** 用于把已完成/暂不活跃的项目收起来,而不是删除 | 「归档」是长期研究工具的必需品:课题会停,不会死 | https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects |
| Claude Artifacts | 产物是**独立于任一次对话、住在侧边栏里**的东西,可继续打磨复用 | 报告/证据矩阵不应该是某条消息的附件,而应该是有独立生命周期的对象——这正是 EviMed 的报告该有的位置 | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them |
| Perplexity Spaces | Space 按主题/项目组织 **Threads 和文件**;可设置自动应用于该 Space 内每个新 thread 的自定义指令;可邀请协作者并区分 viewer / contributor;可选模型 | 「自定义指令自动套用到该容器内每个新会话」是容器存在的第二个理由 | https://www.perplexity.ai/help-center/en/articles/10352961-what-are-spaces · https://www.threads.com/@perplexity/post/DBO2n5FPURf |
| NotebookLM | **三栏定式:左 Sources / 中 Chat / 右 Studio**。左栏是上传的来源且**每个来源有勾选框**,决定本轮对话与产物用哪些来源;中栏是带引用的问答;右栏是**基于来源生成的各类产物**;左栏可折叠让中栏更宽 | 这就是 EviMed 应该走的三栏骨架,而且它证明了右栏的正确定位是「**产物区**」而不是「附加信息区」 | https://support.google.com/notebooklm/answer/16206563?hl=en · https://idt.camden.rutgers.edu/getting-started-with-notebooklm/ |
| Elicit Notebooks | Notebook 把跨查询/跨来源的论文合并到一处;可加列抽数据,也可**打开 Notebook 直接与结果对话**;可加步骤细化检索;支持**无需注册即可打开的分享链接** | 「表格 ↔ 对话」同容器双视图,正是证据矩阵该有的形态 | https://elicit.com/blog/notebooks · https://support.elicit.com/en/articles/14823097-changelog |

### 3.2 命名、右栏、空状态

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| Claude Artifacts | **侧栏自动打开的判据被写清楚了**:内容「重要且自包含」(通常 >15 行)、「本身能独立成立」、「你多半会想在对话之外编辑、迭代或复用」才成为 artifact;短回复不会生成 artifact;由 Claude 决定放侧栏还是行内 | 右栏不能永远开着也不能永远空着——必须有**明确的自动打开判据**。EviMed 的判据应该是:一次运行产出了报告或证据矩阵 | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them |
| Claude Artifacts | artifact 窗口右下角固定三个动作:查看底层代码 / 复制内容 / 下载文件;顶部有**版本选择器**;Markdown 文档可直接选中文字 → "Edit with Claude" 就地改 | 产物面板需要一组稳定的动作栏 + 版本历史。EviMed 的报告修复循环天然产生版本,现在完全没有暴露给用户 | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them |
| ChatGPT(反面) | 对话标题自动生成,但**自动改名会覆盖用户手动改的标题**,社区长期要求「手动命名后即锁定」 | 教训:自动标题是对的,**覆盖用户的手动标题是错的**。EviMed 做自动标题时必须加锁 | https://community.openai.com/t/stop-auto-renaming-chats-once-theyve-been-manually-renamed/1397577 · https://community.openai.com/t/bug-chats-auto-rename-themselves-please-enable-locking-of-chat-title-after-manual-rename/1397903 |
| Gemini Deep Research | 结果落在 **Canvas** 面板并带导出动作;报告就绪前对话线程旁给提示 | 同上:产物有自己的面板与导出 | https://support.google.com/gemini/answer/15719111?hl=en |

### 3.3 能力 / 工具的发现

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| ChatGPT GPTs | 发现走**侧栏的 "Explore GPTs" 目录 + 搜索 + 排行榜**,而不是把所有 GPT 平铺在输入框上方;曾支持在对话中打 `@` 唤起自定义 GPT(2026-06-24 界面更新后该菜单不再列出自定义 GPT,**未核实**是否已恢复) | 能力多于 7 个时,**目录 + 搜索**优于平铺;`@`/斜杠唤起是给老手的加速器,不是给新手的发现入口 | https://help.openai.com/en/articles/8554407-gpts-in-chatgpt · https://community.openai.com/t/custom-gpts-no-longer-appear-when-using-after-today-s-interface-update/1384672 |
| ChatGPT GPTs | OpenAI 计划**退役自定义 GPTs**,把工作流迁到 Plugins(企业版退役日期 2026-12-11) | 对 EviMed 的意义:能力目录会演化,不要把 15 个能力硬编码进输入框上方的一行胶囊 | https://help.openai.com/en/articles/8554407-gpts-in-chatgpt |
| Manus | 提供 **Agent Skills** 作为构建自定义工作流的单元 | 能力包作为一等对象(与 EviMed 的 `capabilities/` 同构),需要一个能被浏览/搜索/收藏的目录页 | https://manus.im/features/agent-skills |
| Genspark | 产物 Sparkpage 内置 copilot,可就地「展开这一节 / 加一个对比 / 深挖某个数据点」 | 把追问入口放在产物里,等于把「第二个能力」在正确的时刻推荐给用户,而不是在开始时让他从 15 个里挑 | https://www.genspark.ai/helpcenter/super-agent |

### 3.4 后台任务的通知设计

| 产品 | 观察到的模式 | 为什么有效 | URL |
|---|---|---|---|
| ChatGPT Scheduled Tasks | 通知偏好在 **Settings > Notifications**;可选「后台静默」(只在你打开应用时才看到)或推送 / 邮件;任务无论你在不在线都会跑完并在完成时通知 | **静默 = 一等选项**。自动化跑批的默认应该是静默入栏,而不是每条都打断 | https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt · https://learn.chatgpt.com/docs/notifications |
| ChatGPT Scheduled Tasks | **监控型任务只在「发生了有意义的变化」时才通知**(例:机票低于阈值才提醒) | 这是解决 (f) 的核心原则:自动化运行的通知阈值应该是「结论变了」而不是「任务跑完了」 | https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt |
| Cursor | 系统通知只在两种时刻发:**跑完** / **需要你的输入**;在 Settings 里开关 | 通知的黄金二分法 | https://cursor.com/changelog/1-5 |
| Cursor Background Agent | 后台 agent 用**评论 + todos 持续汇报状态**,而不是只在结束时冒一条 | 后台不等于失联;但汇报要落在任务对象上,不是落在通知中心 | https://cursor.com/changelog/0-50 |
| NN/g | 「Still checking」「I'm still working on that」这类**周期性状态消息**与进度指示器起同样作用,告诉用户 agent 没跑掉 | 对 8–28 分钟的任务,心跳文案是最低成本的补救 | https://www.nngroup.com/articles/chat-ux/ |

### 本节提炼的复现模式

1. **容器必须改变里面对话的行为**(指令 / 知识库 / 记忆边界),否则不要有容器。
2. **三栏定式:来源 / 对话 / 产物**,且来源可勾选参与本轮。
3. **产物独立于对话存在**,有自己的面板、动作栏、版本选择器与导出。
4. **右栏自动打开需要明确判据**,并写进帮助文档。
5. **自动标题 + 手动改名后锁定**。
6. **归档而非删除**。
7. **能力发现靠目录 + 搜索**,`@`/斜杠是老手加速器。
8. **追问入口放在产物里**,按时机推荐下一个能力。
9. **通知只在「完成」「需要你」「结论变了」三种时刻发**,且静默是一等选项。
10. **后台任务的进度落在任务对象上**,不是堆在通知中心。

## 4. 医疗级信任与安全 UX

只谈设计,不谈法务合规(用户已有资质,合规与版权不在本次范围内)。

| 来源 | 观察到的模式 / 条款 | 对 EviMed 的意义 | URL |
|---|---|---|---|
| Microsoft《Guidelines for Human-AI Interaction》(CHI 2019,18 条,经 49 名设计从业者对 20 个产品验证) | **INITIALLY**:G1「Make clear what the system can do」、G2「**Make clear how well** the system can do what it can do」 | G2 是 EviMed 最缺的一条:15 个能力从没告诉用户「它做得有多好」。能力卡片上应写清 eval 通过率 / 典型耗时 / 已知短板 | https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/ · https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/ |
| 同上 | **WHEN WRONG**:G7 高效唤起、G8 高效撤销、G9「Support efficient **correction**」、G10「**Scope services when in doubt**」、G11「Make clear **why** the system did what it did」 | G10 = 「拿不准时缩小服务范围」:当证据不足,正确做法是**缩小结论范围并说明**,而不是给一个自信的完整报告。G9 = 用户必须能就地纠正一条 claim,而不是重跑 | https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/ |
| 同上 | **OVER TIME**:G14「Update and adapt **cautiously**」、G15「Encourage **granular** feedback」、G16「Convey the consequences of user actions」、G17「Provide global controls」、G18「Notify users about **changes**」 | G15 直指 EviMed 的反馈缺口:反馈应落在**单条 claim / 单条来源**上,不是给整份报告点赞踩 | https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/ |
| Google PAIR《Mental Models》 | **「Onboard in stages」**,建议文案模板:"This is *{ your product }*, and it'll help you by *{ core benefits }*. Right now, it's **not able to** *{ primary limitations }*." 明确反对强调底层技术(「Explain the benefit, not the technology」),反对制造「AI magic」预期 | EviMed 的首屏应该说「我能做什么 / 现在还做不到什么」,而不是列 15 个能力名 | https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/ |
| Google PAIR《Explainability + Trust》 | 「Help users **calibrate** their trust」:说明数据的 **Scope / Reach / Removal**;把解释绑到用户的具体动作上;**高风险场景给更详细的解释**。「Optimize for understanding」:给**局部解释**(只解释最有影响的因素),而不是完整技术细节 | 「高风险更详细」= EviMed 的安全类 claim 应当默认展开依据,而非折叠在 popover 里 | https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/ |
| Google PAIR《Explainability + Trust》 | **先测再显示置信度**;若确需显示,四种可视化各有适用面:**Categorical**(高/中/低 + 明确的行动指引)、**N-best**(给多个候选,促使用户自己判断)、**Numeric**(百分比,要求用户有概率素养)、**Data visualization**(误差条/区间,面向领域专家) | EviMed 的 ✓/⚠ 是 Categorical;但目前**没有「明确的行动指引」**——⚠ 应该直接告诉读者「该去核对哪一句」 | https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/ |
| NN/g《A Concrete Definition of an AI Agent》 | agent 的定义是「**迭代地采取行动、评估进展、自行决定下一步**」;要让用户看见 agent 的迭代过程:「每一步都是 agent 基于此前发生的事所做的一个决定」;可接受的监督水平**随场景而变**,「医疗记录比创意写作要求更高的准确度」;目标不明确时应**先要澄清再动手** | 直接支持 (a):进度面板不是装饰,它是让用户判断「这是不是一个真在工作的 agent」的唯一依据 | https://www.nngroup.com/articles/definition-ai-agent/ |
| NN/g 聊天 UX | **周期性状态消息**(「Still checking」)与进度指示器功能等同,告诉用户 agent 没跑掉;同时警告:**流式输出会加剧信息过载**,尤其当答案本身已经密不可读(受访者原话:「信息哗啦啦涌进来,让我觉得压不住」) | EviMed 的深度报告非常密——**不要整篇流式吐出**,而应流式吐「发现/进度」,最终报告一次性成型进右栏 | https://www.nngroup.com/articles/chat-ux/ · https://www.nngroup.com/articles/less-chat-more-answer/ |
| UpToDate(几十年沿用) | 每个主题页顶部固定显示两个日期:**"Literature review current through: <月 年>"** 与 **"This topic last updated: <日期>"** | 「**最后检索日期**」是循证产品的身份证。EviMed 的每份报告和证据矩阵都应该在首屏显示检索截止日 | https://www.wolterskluwer.com/en/solutions/uptodate/resources/user-academy/searching-and-navigating · https://www.uptodate.com/contents/systematic-review-and-meta-analysis |
| UpToDate Expert AI | 每条回答带**透明的推理和明确写出的假设**;inline nudge 引导用户改进提问 | 「写出假设」是把不可判定的临床情境显性化的最佳手段 | https://www.wolterskluwer.com/en/solutions/uptodate/uptodate-expert-ai |
| OpenEvidence(第三方批评) | 一位医生的原话:「我不信任它,因为**它错的时候错得特别自信**」;并有对信息量过大的担忧。工具本身只对已验证身份的医疗专业人员开放 | **过度自信比不确定更危险**。EviMed 的 ⚠ 标记和「证据不足」态度必须做得比 ✓ 更显眼,而不是更弱 | https://ashooreview.com/p/7-things-not-to-do-on-openevidence · https://www.sermo.com/resources/openevidence-ai/ |
| Glass Health | 鉴别诊断中单列 **"Can't Miss"** 一类 | 安全兜底做成信息结构的一部分,而不是一句免责声明 | https://glass.health/resources/ai-diagnosis |
| FDA《AI-Enabled Device Software Functions》草案(2025-01-07) | 透明度分三块:(1) 模型与逻辑的信息、(2) **用户体验与工作流**、(3) 标签与其他披露;2024 年起把「透明度」细化到器械性能、模型与数据集特征、底层技术;并给出 **Model Card** 示例(附录 F) | 监管文件把「用户体验与工作流」与模型信息并列为透明度的一部分——这是把 EviMed 的**能力卡片做成 Model Card** 的现成理由 | https://www.hoganlovells.com/en/publications/new-guidance-on-aienabled-device-software-functions-clarifies- · https://www.wcgclinical.com/insights/fda-guidance-on-ai-enabled-devices-transparency-bias-lifecycle-oversight/ |
| 实证(npj Digital Medicine / PMC) | FDA 已授权的 AI/ML 器械里,只有 **16.7% 报告了 PCCP**,**不足五分之一**披露了完整的灵敏度/特异度 | 行业普遍做不到的透明度,恰恰是 EviMed 可以做成差异点的地方 | https://www.nature.com/articles/s41746-025-02052-9 · https://pmc.ncbi.nlm.nih.gov/articles/PMC12730494/ |
| WHO《Ethics and governance of AI for health: LMMs》(2024-01-18) | 40+ 条建议;共识伦理原则含「ensure **transparency, explainability, and intelligibility**」;强调透明信息与文档、全生命周期管理、多学科评估 | 界面层面可落地的只有一条:**让产物自带它的生成条件**(模型、检索日期、来源范围、已知局限) | https://www.who.int/publications/b/70584 · https://iris.who.int/server/api/core/bitstreams/e9e62c65-6045-481e-bd04-20e206bc5039/content |
| 临床 AI 去技能化研究(2025) | 保护临床技能的设计原则:**推理透明、明确的不确定性估计、带引用的 "provenance-first" 输出**;AI 必须能在脆弱情形下**主动提示需要人类专家介入** | 「provenance-first」正是 EviMed 的核心资产;缺的是「主动提示需要人介入」的那一步 | https://www.iatrox.com/blog/clinical-ai-deskilling-evidence-and-strategies-for-uk-doctors-2025 |

### 本节提炼的复现模式

1. **说清「能做什么」之外还要说清「做得有多好」**(HAX G2)。
2. **拿不准时缩小范围并说明**,而不是给完整而自信的答案(HAX G10)。
3. **就地纠正单条结论**,而不是重跑整个任务(HAX G9)。
4. **反馈要细粒度到单条 claim / 单条来源**(HAX G15)。
5. **分阶段 onboarding,明说当前做不到什么**(PAIR)。
6. **高风险场景给更详细的解释**,低风险折叠(PAIR)。
7. **置信度用分档 + 明确行动指引**,不用裸百分比(PAIR)。
8. **最后检索日期常驻**(UpToDate)。
9. **明确写出假设**(UpToDate Expert AI)。
10. **过度自信比不确定更危险**——⚠ 要比 ✓ 更显眼(OpenEvidence 的用户批评)。
11. **安全兜底做进信息结构**(Can't Miss),而不是免责声明。
12. **产物自带生成条件**(模型、检索日期、来源范围、已知局限)= 界面层的 Model Card(FDA / WHO)。
13. **不要把密集报告整篇流式吐出**(NN/g 信息过载)。

## 5. Top 20:EviMed 应当采纳的模式

> 三栏 = 左导航 / 中对话 / 右面板。以下每条都写明:**对应问题** → **在我们三栏里长什么样** → **医疗语境下要小心什么**。

**1. 计划先行、可编辑、需批准(Plan → Edit plan → Start research)** — 对应 **(a)(c)**
参考 Gemini Deep Research、Devin planning mode、Cursor plan mode。用户提问后不要立即 dispatch:中栏先出一张**研究计划卡**,列出「将产出的 deliverable(逐条)/ 每条派给哪个能力 / 检索哪些库 / 时间与年份范围 / 预计耗时区间」,底部两个按钮「修改计划」「开始研究」。改计划就是继续对话。这一步顺带解决 (c):用户第一次看见 15 个能力,是在**它们被用到的上下文里**,而不是输入框上方一排陌生胶囊。
⚠️ 医疗语境:计划卡里**不要预先承诺结论**(例如「将证明 A 优于 B」),只承诺**要回答的问题**;否则计划会变成确认偏倚的锚。
URL: https://support.google.com/gemini/answer/15719111?hl=en · https://fast.io/resources/devin-ai-agent-guide/

**2. 右栏 = 运行工作台(Run Workspace),三个 Tab:计划 / 时间线 / 来源** — 对应 **(a)(b)**
参考 Devin 的四 Tab 工作区、NotebookLM 的三栏、Manus's computer。运行一开始右栏自动打开,Tab 1「计划」= 勾选式 deliverable 清单(即 todo.md 形态,当前项高亮);Tab 2「时间线」= 每个步骤一行、可点开看该步做了什么与为什么;Tab 3「来源」= 已保存来源的实时列表。运行结束后同一个右栏切换成「产物」Tab(报告 / 证据矩阵)。
⚠️ 医疗语境:时间线里**不要暴露原始工具名、网关名、文件路径**(这正是交付门禁禁止的泄漏),要翻译成「检索 PubMed(命中 128 篇,保留 14 篇)」这类临床语言。
URL: https://docs.devin.ai/work-with-devin/devin-session-tools · https://support.google.com/notebooklm/answer/16206563?hl=en

**3. 「已找到来源」实时计数 + 漏斗数字** — 对应 **(a)**
参考 秘塔(左上角常驻 token / 信源数 / 耗时)、Kimi-Researcher(74 关键词 → 206 URL → 保留 3.2%)、Undermind。中栏运行卡的一行摘要固定显示:**「已检索 N 条 · 已保留 M 条 · 已引用 K 处 · 用时 T」**,点击展开右栏来源 Tab。
⚠️ 医疗语境:数字必须是**真实计数**,不能是估算或动画;把「保留率」误读成「证据质量」很危险,标签要写「已保存原文的来源数」而非「高质量文献数」。
URL: https://zhuanlan.zhihu.com/p/1928563690308871248 · https://www.undermind.ai/whitepaper.pdf

**4. 流式的「当前发现」,但报告不流式** — 对应 **(a)**
参考 Perplexity(关键发现在过程中先冒出来)、NN/g(流式会加剧信息过载)。运行中每完成一个 deliverable,中栏追加一条**发现卡**(两三句 + 该结论依据的 1–2 条来源),用户可以边等边读;最终报告一次性成型进右栏。
⚠️ 医疗语境:过程中的发现卡必须**明确标注「未经复核」**,并与最终报告的 ✓/⚠ 视觉上区分,否则用户会拿一个中途结论去用药。
URL: https://www.perplexity.ai/help-center/en/articles/13600190-what-s-new-in-advanced-deep-research · https://www.nngroup.com/articles/chat-ux/

**5. 时长心智契约 + 可选深度档** — 对应 **(a)(c)**
参考 Gemini「通常 5–10 分钟」、秘塔三档(简洁/深入/研究)。计划卡上写「预计 12–20 分钟」,并给用户一个**深度档位**(快速核查 ≈3 分钟 / 标准 ≈10 分钟 / 深度 ≈25 分钟),不同档位明说差异(检索库数量、是否做质量评价、是否出证据矩阵)。
⚠️ 医疗语境:快速档的产物必须在文首标明「未做系统检索,不可用于指南/处方决策」。
URL: https://support.google.com/gemini/answer/15719111?hl=en · https://www.53ai.com/news/LargeLanguageModel/2024070273026.html

**6. 中途可插话 steer,不必取消重来** — 对应 **(a)**
参考 ChatGPT Deep Research(中断以调整焦点、追加来源)、Perplexity(研究中可加追问)。运行中的输入框保持可用,提示语改成「补充条件或调整方向(会在当前步骤之后生效)」;补充内容作为一条**用户消息**进入运行,而不是新开一轮。
⚠️ 医疗语境:插话若改变了纳排标准或人群,**必须在报告里留痕**(「检索中途追加限定:仅成人」),否则事后无法复现。
URL: https://help.openai.com/en/articles/10500283-deep-research-faq

**7. 后台完成 + 只在三种时刻通知** — 对应 **(a)(f)**
参考 Cursor(完成 / 需要输入)、ChatGPT Scheduled Tasks(可选静默;监控型任务只在有意义的变化时通知)。EviMed 的通知规则收敛为三条:**运行完成**、**需要你决定**(澄清问题 / 预算耗尽)、**结论变了**(proactive research 的议程发现了与上次不同的结果)。除此之外一律静默入栏。自动化运行默认静默。
⚠️ 医疗语境:安全类发现(如新增的黑框警告、撤市信号)应当是唯一允许**打断**的通知类别,并且单独成一个可订阅的类别。
URL: https://cursor.com/changelog/1-5 · https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

**8. 通知摘要化,原始校验文本不外泄** — 对应 **(f)**
参考 CDS 告警疲劳研究:医生会覆盖 49–96% 的弹窗告警;把打断式告警换成**被动式/行内提示**可显著降低负担。EviMed 的通知正文应是一句人话(「《XX 的临床证据综合》已完成,含 14 条来源、3 条标记待核」),原始 validator 文本只在点进去后的产物页里、且折叠在「质量检查明细」下。收件箱按项目分组、支持按类别静音、支持「每日摘要」聚合。
⚠️ 医疗语境:**SAFETY 类发现永远不参与聚合折叠**,它必须单条可见。
URL: https://psnet.ahrq.gov/primer/alert-fatigue · https://pubmed.ncbi.nlm.nih.gov/38086417/

**9. 任务列表显示问题,不显示能力名** — 对应 **(d)**
参考 ChatGPT/Claude 的自动标题。左栏「最近任务」每行是**自动生成的问题标题**(从用户第一句问题压缩而来,中文 ≤20 字),能力名降级成标题右侧的小标签,第二行放状态 + 时间 + 来源数。
⚠️ 医疗语境:自动标题**不得改写临床含义**(不要把「二甲双胍能否用于 eGFR 30–45」压成「二甲双胍禁忌」)。安全做法:截断原句而不是概括,概括必须保留药名、人群、结局三要素。
URL: https://help.openai.com/en/articles/10169521-projects-in-chatgpt

**10. 自动标题 + 手动改名后锁定** — 对应 **(d)(e)**
参考 ChatGPT 的反面教训:自动改名会覆盖用户手动设的标题,社区长期申诉。EviMed 一旦用户手动改过标题,自动命名永久失效,并在列表项 hover 时露出「重命名 / 归档 / 移动到项目」。
⚠️ 医疗语境:无。
URL: https://community.openai.com/t/stop-auto-renaming-chats-once-theyve-been-manually-renamed/1397577

**11. 容器必须改变里面的行为,否则删掉它** — 对应 **(e)**
参考 ChatGPT Projects(指令 + 文件 + project-only memory)、Perplexity Spaces(自定义指令自动套用到该 Space 的每个新 thread)、Claude Projects(知识库 + 指令 + 归档)。把「Default Project」改造成**课题(研究课题)**:课题持有 ①课题说明(自动作为每次运行的背景)、②知识库来源子集、③记忆边界、④默认能力偏好。若这四样都空,则界面**根本不显示课题切换器**,用户就当它不存在;当用户第二次问同主题的问题时,再提示「要不要把这两个任务归进一个课题?」。
⚠️ 医疗语境:课题说明会进每次运行的上下文,必须**显式提示这一点**并可一键查看/关闭,否则一句陈旧的课题背景会静默污染所有后续结论。
URL: https://help.openai.com/en/articles/10169521-projects-in-chatgpt · https://www.perplexity.ai/help-center/en/articles/10352961-what-are-spaces

**12. 三层收敛为两层:课题 → 任务;产物独立于对话** — 对应 **(e)(b)**
参考 Claude Artifacts(产物住在侧边栏,独立于任何单次对话)、NotebookLM(Studio 面板 = 产物区)。EviMed 现在的「项目/线程/任务」三层里,线程没有独立价值。收敛成:**课题**(可选容器)→ **任务**(一次提问 = 一次运行 = 一个可命名对象)→ **产物**(报告 / 证据矩阵 / 来源集,住在右栏与「文件」页,有自己的版本与导出)。
⚠️ 医疗语境:产物一旦被引用/导出,必须冻结一个版本号与检索截止日;修复循环产生的新版本不能悄悄替换旧版本。
URL: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them

**13. 右栏自动打开需要成文的判据** — 对应 **(b)**
参考 Claude 对 artifact 的公开判据(自包含、通常 >15 行、你会想在对话外编辑复用;短回复不生成)。EviMed 的判据写死为:**运行开始 → 自动打开「运行工作台」;运行产出报告或证据矩阵 → 自动切到「产物」;普通问答(open-domain-answer)不打开右栏**。判据写进帮助文档,并给一个持久化的折叠开关。
⚠️ 医疗语境:无,但要保证右栏折叠状态**不影响** ✓/⚠ 标记与「依据」popover 的可用性。
URL: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them

**14. 来源类型必须有视觉身份** — 对应 **证据阅读**
参考 OpenEvidence 被 npj/PMC 论文点名批评的那一点:「界面不在生成文本中标注来源类型,所有引用都表现为完全相同的编号引用」,而底层混着 RCT、指南、监管文件、Cochrane 综述。EviMed 的「依据」popover 与证据矩阵必须给每条来源一个**类型徽章**:`指南` / `RCT` / `系统综述/Meta` / `观察性研究` / `药品说明书` / `监管文件(NMPA/FDA)` / `病例报告`,并在证据矩阵里可按类型筛选。
⚠️ 医疗语境:类型判定错误比不标更糟(把观察性研究标成 RCT)。类型必须来自**元数据(出版类型字段)**,不确定时标「未分类」,绝不猜。
URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC13538487/ · https://www.openevidence.com/announcements/new-feature-why-was-this-source-cited

**15. 三个正交的来源标签,而不是一个合成分** — 对应 **证据阅读**
参考 OpenEvidence 的 `Highly Relevant` / `Leading Journal` / `New Research`,以及 Consensus Meter Snapshot 的四个独立指标(Recency / Methods / Journals / Citations)+ 指标徽章。EviMed 在来源卡上给三个可独立核对的标签:**`直接回答本问题`**(检索相关性)、**`高影响期刊`**(期刊分位,标出口径)、**`近 N 年`**(时效)。不要合成一个「可信度 87 分」。
⚠️ 医疗语境:期刊影响因子**不是**证据等级,标签文案必须避免暗示「高影响 = 结论更可信」;中文语境下还要为国内指南与 NMPA 文件设计不依赖 SJR/IF 的标签。
URL: https://www.openevidence.com/announcements/new-feature-why-was-this-source-cited · https://consensus.app/home/blog/new-consensus-meter/

**16. 引用粒度到段落,并做「悬停预览 / 点击定位」两级** — 对应 **证据阅读(b)**
参考 ClinicalKey AI(追溯到被引用的那一个段落)、DynaMed(指到主题子章节)、NotebookLM(hover 预览 + click 跳转)、SciSpace(左原文 / 右对话分屏)。EviMed 的 ✓ 标记:**悬停**出小卡片显示那句 verbatim quote + 来源标题 + 类型徽章;**点击**在右栏打开原文阅读器并把该句高亮定位,中栏报告与右栏原文并排。
⚠️ 医疗语境:高亮必须是**服务端复核过的那一段字节**,不能是前端模糊匹配出来的近似位置——近似定位会让读者以为自己核对过了。
URL: https://www.elsevier.com/products/clinicalkey/clinicalkey-ai · https://scispace.com/chat-pdf

**17. 证据矩阵是可交互的抽取表,每格一键到原文引文** — 对应 **证据阅读**
参考 Elicit(一行一篇、一列一个字段,**点任一单元格看支撑引文**)、Consensus Study Snapshot(人群/样本量/地点/结果/结局/时长/方法 7 类)。EviMed 的证据矩阵从静态表升级为:列可增删(PICO 字段 + 结局 + 效应量 + 偏倚风险),**点任一单元格弹出该值在原文中的引文**,支持 CSV 导出。
⚠️ 医疗语境:效应量/置信区间这类数字必须是**渲染出来的产物而非手打**(平台原则 10c),单元格里要显示单位与口径;不允许在表里出现无引文支撑的空值填充。
URL: https://support.elicit.com/en/articles/14759154-systematic-reviews-in-elicit · https://libguides.lmu.edu/c.php?g=1426515&p=10582325

**18. 分歧要可见:一致 / 分歧 / 证据不足** — 对应 **证据阅读**
参考 Consensus Meter(yes / no / mixed / possibly 的分布可视化)、scite(supporting / contrasting / mentioning)、Pathway 与 MedSeeker 的**指南冲突对比表**。EviMed 在报告开头给一个**结论一致性条**:支持 X 篇 / 反对 Y 篇 / 结论混杂 Z 篇;涉及多部指南时自动生成「指南对照表」(指南名 · 年份 · 推荐等级 · 推荐原文 · 差异点)。
⚠️ 医疗语境:**不要把票数当证据强度**(10 篇小样本观察性 ≠ 1 篇大型 RCT)。一致性条必须与 GRADE 式的确定性分级并列展示,并注明「篇数不代表证据等级」。
URL: https://consensus.app/home/blog/introducing-the-consensus-meter/ · https://scite.ai/badge · https://www.pathway.md/

**19. 检索覆盖度与检索截止日常驻** — 对应 **证据阅读 / (a)**
参考 Undermind 的 discovery curve(估计相关文献总数并报告本次覆盖约 89.7%)、UpToDate 顶部固定的 "Literature review current through: <月 年>" 与 "This topic last updated: <日期>"。EviMed 每份报告首屏固定一行:**「检索截止:2026-09-18 · 检索库:PubMed / Europe PMC / 指南库 · 命中 128 · 保留 14 · 估计覆盖率 未核实」**。覆盖率若没有可信估计方法,就**不要显示**,显示检索式与库清单即可。
⚠️ 医疗语境:覆盖率是个强主张,估不准就是误导。宁可给「本次检索式」的可复现文本,也不要给一个假的百分比。
URL: https://www.undermind.ai/whitepaper.pdf · https://www.wolterskluwer.com/en/solutions/uptodate/resources/user-academy/searching-and-navigating

**20. ⚠ 必须带明确的行动指引,且比 ✓ 更显眼** — 对应 **证据阅读 / 安全**
参考 PAIR(分档置信度必须配「明确的行动指引」)、HAX G10「Scope services when in doubt」、OpenEvidence 用户批评(「它错的时候错得特别自信」)、Glass Health 的 "Can't Miss"。EviMed 的 ⚠ 不能只是一个灰色图标:悬停即给出**这一条为什么存疑 + 读者该做什么**(「引文与来源原文不完全一致,请点此比对第 3 段」)。报告顶部给一个「待核 3 条」的锚点导航,SAFETY 类发现单独置顶成块,不折叠。
⚠️ 医疗语境:这是全表最重要的一条。**证据不足时的正确产物是缩小范围的结论 + 明确的缺口清单**,不是一份完整但自信的报告。derived claim 永远不得携带实操安全建议(这已是域规则,界面要让它可见)。
URL: https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/ · https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/ · https://ashooreview.com/p/7-things-not-to-do-on-openevidence

### 额外三条(未进 Top 20,但成本极低)

- **能力目录页 + 搜索,取代 15 个等权胶囊**(对应 (c)):参考 ChatGPT 的 "Explore GPTs" 侧栏目录与搜索。输入框上方只留「常用 3 个 + 更多」,完整目录进左栏「能力」页,每个能力是一张 **Model Card 式卡片**(能做什么 / 做得有多好 / 典型耗时 / 需要什么输入 / 3 个示例问题)。URL: https://help.openai.com/en/articles/8554407-gpts-in-chatgpt · https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
- **产物内追问**(对应 (b)(c)):参考 Genspark Sparkpage 内置 copilot。在报告某一节右侧给「就这一节追问 / 扩写 / 加对比」的按钮,顺势把下一个能力推荐到位。URL: https://www.genspark.ai/helpcenter/super-agent
- **运行回放**(对应 (a) 与审计):参考 Manus replay。运行结束后保留一个可重放的时间线,用于科室内部复核与培训。URL: https://cybernews.com/ai-tools/manus-ai-review/

## 6. 反模式

| # | 反模式 | 证据 / 来源 | 对 EviMed 的具体告诫 |
|---|---|---|---|
| A1 | **所有引用长得一模一样** —— 把指南、RCT、说明书、监管文件都画成同样的编号上标 | npj Health Systems / PMC 对 OpenEvidence 4,979 条引用的研究直接点名:「OE 界面不在生成文本中标注来源类型;所有引用都表现为完全相同的编号引用」 https://pmc.ncbi.nlm.nih.gov/articles/PMC13538487/ | 我们已经有 ✓/⚠ 两态,千万别止步于两态;**类型徽章**必须和 ✓/⚠ 一起出现 |
| A2 | **自信的错误** —— 错的时候语气比对的时候还笃定 | 医生受访原话:「我不信任它,因为它错的时候错得特别自信」 https://ashooreview.com/p/7-things-not-to-do-on-openevidence | ⚠ 不能比 ✓ 弱;「证据不足」必须是一个**一等结论形态**,不是缺省失败 |
| A3 | **自动改名覆盖用户手动标题** | OpenAI 社区长期申诉:自动重命名会覆盖人工命名,要求「手改后即锁定」 https://community.openai.com/t/stop-auto-renaming-chats-once-theyve-been-manually-renamed/1397577 | 自动标题一定要做,但手改即锁 |
| A4 | **把长报告整篇流式吐进对话** | NN/g 用户研究:流式输出会加剧信息过载,受访者称「信息哗啦啦涌进来,让我觉得压不住」;并批评冗长与套话 https://www.nngroup.com/articles/less-chat-more-answer/ | 流式只给「发现卡」,报告一次性进右栏;回答先给结论(answer-first),细节点开 |
| A5 | **打断式告警堆积** | 医生覆盖 49–96% 的 CDS 弹窗告警;改为行内/被动提示可显著降低负担 https://psnet.ahrq.gov/primer/alert-fatigue · https://pubmed.ncbi.nlm.nih.gov/38086417/ | 自动化运行的通知默认静默;只有 SAFETY 类允许打断 |
| A6 | **把原始校验器文本直接当通知正文** | 同上(告警疲劳)+ 平台原则 16(错误码与引擎内部不进正文) | 通知正文是人话;validator 明细折叠在产物页里 |
| A7 | **「AI magic」式宣传与空洞的能力名** | PAIR《Mental Models》:避免强调底层技术,「Explain the benefit, not the technology」;并要求分阶段说明**当前做不到什么** https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/ | 15 个能力胶囊只有名字,没有「能做什么/做得多好」——正是 HAX G2 缺失 |
| A8 | **裸百分比置信度** | PAIR:显示置信度前先测;Numeric 形式要求用户具备概率素养,Categorical 需配「明确的行动指引」 https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/ | 不要给「可信度 87%」;给分档 + 该做什么 |
| A9 | **把「被引次数多」当「被支持」** | scite 的前提就是:引用分 supporting / contrasting / mentioning,计数不区分方向是失真的 https://scite.ai/badge | 证据矩阵不要只放引用数;反驳性引用对药物安全尤其关键 |
| A10 | **把票数当证据强度** | GRADE 的确定性来自 5 个域的具名升降,而非篇数 https://training.cochrane.org/handbook/current/chapter-14 | 一致性条必须与确定性分级并列,并注明「篇数不代表证据等级」 |
| A11 | **没有「最后检索日期」的循证产物** | UpToDate 几十年固定显示 "Literature review current through" 与 "This topic last updated" https://www.wolterskluwer.com/en/solutions/uptodate/resources/user-academy/searching-and-navigating | 报告首屏必须有检索截止日;导出物也要带 |
| A12 | **空容器**(Default Project / 空右栏) | ChatGPT Projects、Perplexity Spaces、Claude Projects 的容器都携带指令、文件与记忆边界,**改变里面的行为** https://help.openai.com/en/articles/10169521-projects-in-chatgpt | 不改变行为的容器就不要显示;右栏没内容时不要留一块空白,而是收起 |
| A13 | **视觉语言不统一** —— 暖中性外壳 + 冷蓝对话框 | NN/g 可用性启发式 #4(一致性与标准);「几次发版之后界面不再浑然一体,用户会注意到这种不一致——这会损害信任」 https://www.nngroup.com/articles/consistency-and-standards/ · https://www.nngroup.com/articles/design-systems-101/ | 对应 **(g)**:token 是唯一事实来源(仓库已有 ESLint 禁止新的 arbitrary value),对话框必须并入外壳的中性色系;在医疗产品里,**视觉不一致直接折损可信度** |
| A14 | **把工作流做成强制阶段闸门** | 与本仓库原则 12/13 一致;`dsh-routing-suite` 的四段式 `phase_advance` + `delivery_check` 正是被判定为不采纳的东西 | 计划卡是**可编辑的建议**,不是必须逐段解锁的关卡 |
| A15 | **用免责声明代替设计** | Glass Health 把「Can't Miss」做进信息结构;PAIR 要求高风险场景给**更详细的解释**而不是更多警告 https://glass.health/resources/ai-diagnosis · https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/ | 安全性通过结构表达(缺口清单、待核锚点、SAFETY 置顶),不是靠每页一条灰色小字 |
| A16 | **假进度**(动画式百分比、估算出来的计数) | NN/g:周期性状态消息的作用等同进度指示器,前提是它反映真实状态 https://www.nngroup.com/articles/chat-ux/ | 三个数字必须是真实计数;没有可信 ETA 时给区间或不给,不要编 |

## 7. 给设计团队的 10 条最佳链接

1. **Elicit 系统综述工作流帮助文档** —— 全网对「AI 判定 + 原文引文 + 人工推翻」这套人机协作写得最细的一份,证据矩阵与筛选界面直接照着做
 https://support.elicit.com/en/articles/14759154-systematic-reviews-in-elicit
2. **OpenEvidence 引用质量研究(PMC / npj Health Systems)** —— 4,979 条引用的实证 + 对「所有引用长得一样」的直接批评,是我们做来源类型徽章的最硬论据
 https://pmc.ncbi.nlm.nih.gov/articles/PMC13538487/
3. **Google PAIR《Explainability + Trust》** —— 置信度的四种可视化、局部解释、高风险场景更详细解释;直接决定 ✓/⚠ 的设计
 https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/
4. **Microsoft HAX《Guidelines for Human-AI Interaction》(18 条)** —— G2「说清做得有多好」、G9「支持高效纠正」、G10「拿不准时缩小范围」、G15「细粒度反馈」四条几乎是我们的待办清单
 https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
5. **Gemini Deep Research 帮助文档** —— 计划先行 / Edit plan / Start research / 后台完成 + 通知 / Canvas 产物面板的完整一手描述
 https://support.google.com/gemini/answer/15719111?hl=en
6. **Devin Session Tools 文档** —— 右栏作为 agent 工作台(Planner / Shell / Editor / Browser + 可点开的每一步)的最完整一手说明
 https://docs.devin.ai/work-with-devin/devin-session-tools
7. **Claude Artifacts 帮助文档** —— 侧栏何时自动打开的**成文判据**、版本选择器、固定动作栏
 https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
8. **NN/g《Less Chat, More Answer》** —— 结论先行、截断金字塔、流式过载,针对我们「深度报告太密」的问题
 https://www.nngroup.com/articles/less-chat-more-answer/
9. **Cochrane Handbook 第 14 章(Summary of Findings 与 GRADE)** —— 「等级必须附带具名的升降理由」,是 confidence label 的规范来源
 https://training.cochrane.org/handbook/current/chapter-14
10. **医脉通 MedSeeker 2.0 发布稿 + 秘塔 DeepResearch 界面拆解** —— 两份中文一手/近一手材料,给我们中文用户已有的心智模型:一键溯源到原文位置、指南差异对比、左上角常驻「信源数 / 耗时」
 https://www.sohu.com/a/999005689_377321 · https://zhuanlan.zhihu.com/p/1928563690308871248

---

## 附:核实状态说明

- 标 **未核实** 的三处:① ChatGPT agent mode 于 2026-08 下线(仅见二手报道,help.openai.com 对本次抓取返回 403);② ChatGPT 中 `@` 唤起自定义 GPT 的菜单在 2026-06-24 更新后是否已恢复;③ EviMed 若要显示「检索覆盖率」,目前**没有**可信的估计方法(Undermind 的 discovery curve 是其自有统计模型,不能直接套用)。
- `help.openai.com`、`openai.com/index/*`、`chatgpt.com/*`、`perplexity.ai/help-center/*`、`help.consensus.app/*` 对本次抓取均返回 **403**;这些条目的内容取自搜索引擎返回的页面摘要(含其中的直接引语),URL 仍指向一手页面,设计团队可自行打开复核。
- 其余条目均由一手页面(产品帮助中心、官方文档、发布稿、期刊论文)抓取正文核实。
