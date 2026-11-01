/**
 * The writing of the best medical content, distilled into one style card per genre (c2-style, 2026-10-25): the prompt data the
 * edit's title rule (`frontierEditor.mjs`), the 导读's move order and exemplars (`frontierLead.mjs`) and the shared sentence rule
 * of the 导读, the 「AI 要点」 and the 推荐理由 read. Data, not a document: the measurements behind each line are below and in the
 * c2-style hand-off; nothing here is checked against a written text (principles 5 and 13) — the eval measures it
 * (`evals/frontier-writing/style_metrics.mjs`).
 *
 * The owner, 2026-10-25: 「内容书写风格和格式等等的，都可以通过分析既往高质量公众号、高质量信源、高被引内容、高阅读内容分析得出，
 * 这也相当于蒸馏了吧，蒸馏个世界高水平医学pr专家」. No skill on GitHub does this (research note §5); the distillation is ours and
 * ends here, in prompt text and exemplars we wrote — never copied text.
 *
 * What was measured (scratch corpus, not kept in the repository):
 * - **Titles.** 913 posts of 25 HCP and industry WeChat accounts (丁香园, 医学界, 梅斯医学, 医脉通 and its channels, 中国医学论坛报,
 *   医师报, NEJM医学前沿, 柳叶刀TheLancet, BMJ医学, 中华医学杂志, 医药魔方, 研发客, E药经理人, 丁香园 Insight 数据库, 医药观澜, 健康界,
 *   健识局, 医学界智库), reads re-pulled ≥ 7 days after posting, relative to the account's median at the same push position.
 *   Against that median a question title drew 0.74× the reads (95% CI of the log difference −0.43 to −0.16), a 栏目 tag (【】丨｜)
 *   0.83×, an organisation named 1.18×, a result verb 1.2×; an exclamation or a hype word made no difference. Hypotheses induced
 *   from 600 within-account pairs by HypoGeniC's method (Zhou et al. 2024, arXiv 2404.04326; the method, not its code) and applied
 *   to 300 held-out pairs kept, at ≥ 60%: "names the organisation, regulator or company" (68% of 140), "names the drug or regimen"
 *   (65% of 96), "names the person whose view it is" (64% of 56), and the reverse of "a question" (64% of 96) and of "an
 *   exclamation" (65% of 127). The policy filter (no curiosity gap, question, exclamation, emotional hook or 标题党 — NHC 2025
 *   negative list item 8) removed "urgent words" (60% of 55) and "superlatives" (60% of 40) however they scored.
 * - **Moves.** 420 exemplar texts (81 by relative reads, 125 professional HCP and industry formats, 214 by authority: journal
 *   editions, regulators, journals, registries, preprint servers), each opening labelled one move per sentence by flash, 8-shot
 *   (Yu, Bondi & Hyland 2024); 39 of 50 labels read by hand agreed (78%). Full articles open with background (a paper's body 90%,
 *   a commentary 90%); summary formats (Medscape's TOPLINE, NEJM Journal Watch, an abstract's conclusion, AIHOT's answer-first) put
 *   the answer first — the 导读 is a summary, so each card keeps the answer first and takes the measured order of what follows.
 * - **Banned moves.** The current prompts' 导读 on 100 of those items against the same items' human openings (lieflat-less-ai-tone's
 *   admission rule, MIT, larashero3-dotcom/lieflat-less-ai-tone: ratio ≥ 2, a human rate stable across groups, a locatable trigger,
 *   20 hits read): sentences over 120 characters 38% vs 6% (6.0×), sentences with four or more numbers 45% vs 10% (4.4×), four or
 *   more commas 27% vs 9% (3.1×), 「分别」 lists 0.71 vs 0.24 per 1,000 characters (2.9×). Our model's dash, 「不是…而是」 and colon
 *   set-ups were already below the human rate (the rules taken from AIHOT and lieflat hold), so no line was added for them.
 */

import { FRONTIER_GENRES } from "@evimed/domain";

/** The closed move vocabulary a 导读's sentences are labelled with (the eval's move report reads the cards by these keys). */
export const FRONTIER_LEAD_MOVES = Object.freeze({
  FINDING: "核心发现或核心事实", POPULATION: "人群或适用对象", DESIGN: "设计或方法", SIZE: "样本量和随访", EFFECT: "效应量",
  ABSOLUTE: "绝对数", HARM: "安全性", LIMIT: "局限", DECISION: "决定、措施或推荐", DEAL: "交易或经营数字", SOURCE: "出处",
  CHINA: "与国内的关系", NEXT: "下一步", BACKGROUND: "背景", OPINION: "他人观点",
});

/**
 * The sentence rule every written text shares (the admitted banned moves, said as what to do): one thing per sentence, a short
 * sentence, at most two or three numbers in it — an effect and its confidence interval are one result — and each group's result
 * beside its own number rather than a 「分别」 list.
 */
export const FRONTIER_SENTENCE_RULE = "一句只讲一件事，一般不超过 60 个字，不用一串逗号把设计、人群、结果和安全性塞进同一句；一句里最多放两三个数字（一个效应值连同它的置信区间算一个结果）；不写「A、B、C 分别为 x、y、z」这样的并列，每组的结果和它自己的数字写在一起。";

/**
 * What every title obeys, after its genre's formula (the measured rules above, and the policy filter). c4-title (2026-10-26): no
 * prefix label (a journal, congress or column name before a bar or bracket: 2,273 Chinese titles of a week had 531 with a separator
 * or a suffix and 618 with a ！ or ？), no site or media name, at most 40 characters. Said once; `frontierEditor.mjs` shows it to the
 * edit and to the standalone title call, and `FRONTIER_TITLE_VERSION` hashes it.
 */
export const FRONTIER_TITLE_RULE = "写明主体（机构、监管部门、公司、学会，或药物、方案、试验名）和结果或决定，一般 30 个字上下，最多 40 个字，原标题太长就只留主体和结果；不用问句和感叹号，不用「重磅」「刚刚」「突发」「首个」「揭秘」「竟」这类词；开头不加期刊、会议或栏目名加竖线、方括号的前缀（「Cell |」「ASN 2026｜」「【临床研究】」），期刊名写进句子里（「研究发表于《细胞》」），会议名可以放在开头加冒号（「ESMO 2026：…」）；不带网站或媒体名，也不用【】|｜丨。";

/**
 * @typedef {{ title: string, lead: string, ref: string, source: string, thin?: boolean }} FrontierStyleExemplar
 * @typedef {{ title: string, moves: readonly (keyof typeof FRONTIER_LEAD_MOVES)[], lead: string,
 *             exemplars: readonly FrontierStyleExemplar[] }} FrontierStyleCard
 */

/**
 * One card per genre: the title formula (`title`), the 导读's move order (`moves`, and `lead`, the same order said for the model),
 * and two exemplars we wrote on real public items of the feed (`ref` is the item's public id) — and, for safety and approval, a
 * third on a record with no text (`thin`: an openFDA record as the plugin recorded it, `ref` a key of it; c2-gaps G2, 2026-10-25: on
 * such records the model added advice the record does not state, and said what it lacks) — each passes the number check
 * against its source, shares no eight-character run of expression with the corpus (standard names excepted), and keeps the
 * sentence rule. The exemplars sit on topics unlike most inputs; the eval counts any of their eight-character runs in an output
 * that the output's own source does not contain (`leakage`).
 */
export const FRONTIER_STYLE_CARDS = /** @type {Readonly<Record<import("@evimed/domain").FrontierGenre, FrontierStyleCard>>} */ (Object.freeze({
  paper: card("干预或暴露＋人群＋主要结果的方向，放得下时带上主要数字；试验名缩写保留，期刊名不进标题",
    ["FINDING", "DESIGN", "SIZE", "ABSOLUTE", "HARM", "LIMIT"],
    "按这个顺序写，原文没有的一步跳过。先写发现：在什么人群中，什么干预或暴露与什么对照相比，主要终点的方向和数字；原文给出事件数或两组各自的发生率时，优先写这些绝对数。再用一句写设计、样本量和随访。最后写原文写明的最重要的一条安全性结果或局限。",
    [
      { title: "脓毒症休克手术中加用多巴酚丁胺，术后急性肾损伤减少",
        lead: "脓毒症休克患者接受感染源控制手术时，术中在去甲肾上腺素之外加用多巴酚丁胺，术后7天内急性肾损伤从34.7%降到22.8%。这是在中国39家医院开展的开放标签随机试验，共584例。调整风险比为0.64（95% CI 0.49-0.83）。",
        ref: "4682d4a32984a454", source: "美国医学会杂志 JAMA" },
      { title: "普纳替尼联合贝林妥欧单抗一线治疗Ph阳性ALL，无事件生存优于伊马替尼联合化疗",
        lead: "成人Ph阳性急性淋巴细胞白血病一线治疗中，普纳替尼联合贝林妥欧单抗组的无事件生存率在第24个月为86%，伊马替尼联合化疗组为67%。这项III期试验随机分配236例，中位随访23.7个月。不含化疗的方案组累积复发率为5%，对照组为13%。",
        ref: "d3b8c6f61c92a859", source: "新英格兰医学杂志 NEJM" },
    ]),
  preprint: card("研究对象＋发现，写成关联或估计，不写成定论",
    ["FINDING", "DESIGN", "SIZE", "LIMIT"],
    "先写发现，写成关联或估计而不是定论，并在句中点明这是尚未经同行评议的预印本。再写设计、数据来源和样本量。最后一句写原文写明的局限，或原文写明的企业资助、作者企业任职。",
    [
      { title: "炎症性肠病患者体重越高，合并MASLD越常见",
        lead: "这项尚未经同行评议的预印本显示，炎症性肠病患者体重越高，合并MASLD越常见。研究回顾了一家医院的400份病历，45.3%符合MASLD诊断。与体重正常者相比，肥胖者的未校正比值比为7.62（95% CI 4.17-13.91）。作者提示这只是关联，模型没有纳入治疗暴露和病程。",
        ref: "af3a09a507c2677f", source: "medRxiv Details API（按日期窗口全量拉取）" },
      { title: "杜氏肌营养不良患者脊柱融合术后约2年，肺功能继续下降",
        lead: "这项尚未经同行评议的预印本发现，不能行走的杜氏肌营养不良患者做脊柱后路融合术后，用力肺活量占预计值从术前41.0%降到约2年时的34.4%。研究回顾了16例男性患者，术后早期肺功能基本不变。侧弯矫正幅度越大，用力肺活量下降越多（ρ=−0.65，P=0.012）。",
        ref: "42fc2ddb723684f0", source: "Research Square 预印本（经 Europe PMC）" },
    ]),
  guideline: card("发布机构＋指南或共识名称＋改变最大的那条推荐；原文没有具体推荐时只写机构和文件",
    ["DECISION", "POPULATION", "DESIGN", "SOURCE"],
    "先写哪个学会或机构的什么指南、共识，改变最大的那一条推荐：由什么调整为什么，照抄原文的推荐等级和证据级别；没有对比时写最主要的推荐及其等级。再写适用人群和这条推荐依据的研究，最后用一句带过其他重要更新。来源是会议解读或二次解读时，写明是据谁的解读。原文只有文件名和简介时，一句话写清是什么文件、由谁发布。",
    [
      { title: "KDIGO 2027版CKD指南药物管理部分发布征求意见稿",
        lead: "KDIGO 2027版CKD指南药物管理部分发布征求意见稿，更新集中在SGLT2i、nsMRA和GLP-1RA三类药。成人CKD伴有2型糖尿病或心衰者，无论尿白蛋白多少，都推荐用SGLT2i（1A）。用药后eGFR即使低于20 ml/min/1.73m²，也可以继续用。",
        ref: "4872aa17dfa6cd58", source: "医脉通临床指南" },
      { title: "欧洲新版结直肠癌筛查建议：50至69岁一般风险人群首选每两年一次FIT",
        lead: "欧洲结直肠癌倡议工作组在UEGW 2026上介绍新版筛查建议，对50至69岁一般风险人群强推荐有组织筛查，首选每两年做一次FIT。证据确定性较低时，FIT可有条件延长到74岁。对50岁以下一般风险人群，指南有条件地不推荐筛查。",
        ref: "983e70462df121e3", source: "医学界消化肝病频道" },
    ]),
  policy: card("发文机关＋对谁＋改了什么或要求什么",
    ["DECISION", "POPULATION", "NEXT", "FINDING"],
    "先写这份文件或这项措施对谁、改了什么或要求什么，由哪个机关发布。再写施行或截止时间、文号和原文给出的关键数字。官方对容易误解之处的澄清，最后用一句写出来。",
    [
      { title: "香港增设猴痘疫苗接种点，10月前15天确诊较上月同期降逾六成",
        lead: "香港卫生防护中心为遏制8月以来增多的猴痘病例，增设疫苗接种点并与3家非政府组织合作外展接种。10月前15天，确诊数比上月同期下降超过60%。同一时期的接种剂次增加超过60%。高风险接触者可预约在油麻地加开的周六时段接种。",
        ref: "fafdcda56403bdea", source: "香港特区政府 新闻公报（含卫生署）" },
      { title: "俄罗斯一名实验室人员因病因未明的肺炎去世，香港加强机场健康监测",
        lead: "俄罗斯伊尔库茨克州一名实验室人员因病因未明的重症肺炎去世后，香港卫生防护中心评估对本地的即时影响较低，但已加强对相关航班旅客的体温检测和健康评估。病人发病前14天到过该州并患上原因不明的肺炎时，医生须立即通报。",
        ref: "7b646d0a3dc2f193", source: "香港特区政府 新闻公报（含卫生署）" },
    ]),
  approval: card("监管机构＋决定的类型＋药品或器械（通用名）＋适应症",
    ["DECISION", "POPULATION", "FINDING", "HARM", "CHINA"],
    "先写哪个监管机构对哪个药品或器械（通用名，原文有商品名和企业时带上）做了什么决定，用于什么适应症和人群；写清决定的类型：常规批准、加速批准、附条件批准、优先审评，欧洲 CHMP 的积极意见不等于批准，卫生技术评估机构接纳使用也不等于上市批准。再写关键研究的设计、样本量和主要结果，原文写明的剂量和附加条件。原文提到国内上市或在审情况时，最后写一句。原文只是一条审批记录时，写清是哪家企业的什么申请、批准的是哪类事项（新适应症、说明书修订、生产工艺等）即可；原文没有给出的适应症、研究和剂量整个不写，也不写原文没有给出。",
    [
      { title: "苏格兰SMC接纳deuruxolitinib用于成人重度斑秃",
        lead: "苏格兰药物联盟（SMC）经简化审评，接纳JAK抑制剂deuruxolitinib（Leqselvi）在NHS苏格兰用于成人重度斑秃。药品由Sun Pharmaceuticals提供，这一建议以患者用药可及方案的价格为前提。",
        ref: "9e9b7ea6dd2a4f5b", source: "苏格兰SMC 用药建议 Medicines advice" },
      { title: "Perjeta的生物类似药Poherdy获欧盟批准，用于HER2阳性乳腺癌",
        lead: "Poherdy已在欧盟获批，它与已上市的Perjeta（帕妥珠单抗）高度相似，属于生物类似药，适用人群是成人HER2阳性乳腺癌。转移或局部复发且无法手术的患者，与曲妥珠单抗、多西他赛合用。复发风险高的早期患者，在手术前后与曲妥珠单抗及化疗合用。",
        ref: "8150652e44ddacc5", source: "欧洲药品管理局 全站更新 EMA What's New" },
      { title: "FDA批准Micro Labs氯巴占片仿制药的一项生产工艺补充申请",
        lead: "据FDA审批数据库，Micro Labs的氯巴占片（ANDA211711）有一项生产与质量控制类补充申请获批。涉及10 mg和20 mg片剂。",
        ref: "4f5aa15bcb21608d", source: "openFDA Drugs@FDA 审批数据库", thin: true },
    ]),
  safety: card("机构＋产品＋风险＋措施",
    ["DECISION", "HARM", "POPULATION", "ABSOLUTE"],
    "先写哪个机构就什么产品采取了什么措施（黑框警告、禁忌、说明书修订、召回、停用、短缺），风险或原因是什么。再写原文写明的、医务人员或患者要做的事，以及涉及的产品、批号或人群；原文没写要做什么，就不写这一步，不替原文出主意。最后写依据的病例数或数据来源。原文只是一条召回或短缺记录时，一两句写清是谁的什么产品、原因、范围和状态即可。",
    [
      { title: "英国MHRA提示：CRRT更换PAN滤器后，卡泊芬净等棘白菌素宜推迟给药",
        lead: "英国MHRA提醒，卡泊芬净等棘白菌素可吸附在连续肾脏替代治疗所用的聚丙烯腈（PAN）膜上，可能导致抗真菌治疗无效，危重患者有生命危险。新滤器或新管路刚开始使用时风险最高。条件允许时，应在启用PAN滤器或更换管路至少6小时后再给药。",
        ref: "cfc840f3387730b1", source: "英国MHRA 全部发布 MHRA on GOV.UK" },
      { title: "FDA早期警示：Edwards经导管二尖瓣输送系统球囊破裂，已致1例死亡",
        lead: "FDA发布早期警示，Edwards Lifesciences撤回用于SAPIEN M3经导管二尖瓣置换的部分批号Commander M输送系统。企业已收到3份球囊充气时破裂的报告，相关1例死亡、1例严重伤害。医疗机构应停用并退回受影响批号，其他批号可继续使用。",
        ref: "16dcd226384dd57e", source: "美国FDA MedWatch 安全警示 MedWatch Safety Alerts" },
      { title: "Supernus召回托吡酯缓释胶囊Trokendi XR，溶出度不合格",
        lead: "Supernus Pharmaceuticals在美国全国召回50 mg托吡酯缓释胶囊Trokendi XR，原因是溶出度不符合规格。这是企业自愿发起的三类召回，仍在进行。",
        ref: "1d6e10fa1e242cb4", source: "美国FDA 药品召回（openFDA enforcement）", thin: true },
    ]),
  industry: card("公司＋事件＋金额或研发阶段",
    ["FINDING", "DEAL", "BACKGROUND", "NEXT"],
    "先写哪家公司做了什么：交易各方和交易类型、金额，或研发读出的结果；原文给出前期数据、竞品或市场预期时，写明这次高于还是低于。再写交易条款或关键数据，涉及的药物、靶点、适应症和研发阶段。最后写原文写明的下一步。不写股价判断和宣传语。",
    [
      { title: "翰森制药与罗氏签下第二份ADC合作，首付4亿美元",
        lead: "翰森制药和罗氏签下第二份ADC合作协议，覆盖翰森的2个临床前项目和多个由罗氏选定靶点的项目。翰森拿到4亿美元首付和1.1亿美元周年款，里程碑付款最高可超150亿美元，另有销售分成。翰森负责做到全球1a期，并保留大中华区权益。",
        ref: "69fd9a4cd86933f5", source: "医药观澜" },
      { title: "GSK欧洲重组一个多月涉及约2300个岗位，省下的钱投向研发",
        lead: "葛兰素史克为削减成本，一个多月里在欧洲三国披露的岗位调整合计约2300个。规模最大的一笔在比利时，三处基地最多裁去1217人。目标是2029年时每年省下19亿英镑，省出的钱大多转投研发。",
        ref: "40236b77ded0335b", source: "赛柏蓝" },
    ]),
  conference: card("会议＋研究或药物＋主要结果",
    ["FINDING", "DESIGN", "SIZE", "HARM", "LIMIT"],
    "先写在哪个学术会议上公布的什么研究，主要终点与对照相比的结果，有摘要号时带上；原文给出两组事件数或各自的发生率时优先写。再写设计：是否随机、样本量、地区、是否期中分析。最后写原文写明的严重不良事件、局限或是否同步发表。会前预告只有题目、尚无结果时，只写一句将在哪个会议报告什么研究。",
    [
      { title: "古塞奇尤单抗维持治疗3年，克罗恩病临床缓解率91%至94%",
        lead: "强生在今年ACG年会上公布了GALAXI 2/3研究的3年长期延伸结果。中重度克罗恩病患者用古塞奇尤单抗维持3年，临床缓解率为91%至94%。内镜缓解率为52%至61%，74%的患者仍在用药。安全性与此前一致。",
        ref: "3dfb4cf7f19ae3da", source: "PR Newswire 健康类新闻稿总汇" },
      { title: "VIVA 2026：西罗莫司药物球囊治疗股腘动脉病变，通畅率更高",
        lead: "在VIVA 2026的最新突破性临床试验专场，SELUTION4SFA研究显示，股腘动脉病变用西罗莫司药物洗脱球囊治疗，疗效优于普通球囊。12个月一期通畅率为78.6%，普通球囊为65.2%。这项研究按2:1随机纳入300例，主要安全终点达到非劣效。",
        ref: "e098745e6ce6bfeb", source: "PR Newswire 健康类新闻稿总汇" },
    ]),
  trial: card("干预＋人群＋期别＋试验已登记或启动",
    ["DESIGN", "POPULATION", "SIZE", "NEXT"],
    "先写在什么人群中、用什么干预与什么对照、第几期的试验，由谁登记。再写计划样本量、主要终点、研究地点和状态。登记记录没有结果时不写疗效；已登记结果时，写主要结果。",
    [
      { title: "新辅助后未达pCR的NSCLC，术后用阿得贝利单抗联合法米替尼（II期登记）",
        lead: "这项单臂、多中心II期试验拟入组64例新辅助化疗免疫治疗后仍未达病理完全缓解、已做根治手术的II期到IIIB期NSCLC。术后用阿得贝利单抗1200 mg每3周静注一次，联合法米替尼每日口服20 mg。主要终点为2年无病生存率。",
        ref: "018c4d471e9c1f49", source: "ClinicalTrials.gov · 中国研究中心的干预性试验" },
      { title: "III期试验比较enicepatide与替尔泊肽治疗2型糖尿病",
        lead: "新登记的一项III期试验，在口服降糖药后血糖仍不达标的2型糖尿病患者中，比较GLP-1/GIP受体激动剂enicepatide与替尔泊肽，看两药的疗效和安全。",
        ref: "9dfa0848c5376be7", source: "ClinicalTrials.gov · 新登记的 3 期试验" },
    ]),
  commentary: card("被解读的研究＋它的核心结果；观点文章写明是谁的观点",
    ["FINDING", "SOURCE", "OPINION", "LIMIT"],
    "先写被解读的那项研究、指南或政策本身的核心结果，不跟着评论者的说法走。再写这篇解读出自谁、在原始研究之外补充了什么（背景、争议、对国内的意义），作者自己的观点写明是作者的看法。",
    [
      { title: "POET-II：左心感染性心内膜炎达临床稳定后提早停抗生素，复发更多",
        lead: "POET-II随机试验发现，左心感染性心内膜炎达到临床稳定后随即停药，安全复合终点不劣于把4~6周标准疗程用完。代价是原致病菌复发达5.1%，标准疗程组是1.6%。这篇解读提醒，粪肠球菌感染者仍宜走标准疗程。",
        ref: "fdb5e5c21b33fa3b", source: "中国循环杂志" },
      { title: "复方甲氧那明含氨茶碱，与茶碱类药同用需防剂量叠加",
        lead: "医学界的用药提示指出，复方甲氧那明一粒里有25mg氨茶碱，过量可引起茶碱毒性，和茶碱类制剂同用要算叠加剂量。8岁以下儿童禁用。和感冒药、止咳化痰药、抗组胺药或镇静药一起用也要小心。",
        ref: "e4c10037dc1f9cb5", source: "医学界血液频道" },
    ]),
  news: card("主体＋核心事实；转述研究时写主要终点是否达到",
    ["FINDING", "SOURCE", "ABSOLUTE", "LIMIT"],
    "先写核心事实；转述研究的报道，先写主要终点是否达到、发现了什么，不沿用新闻稿的角度和夸张说法。再写出处（期刊、会议或机构）、研究设计和关键数字，原文给出绝对风险或事件数时优先写。原文写明的限定（例如只是关联、不证明因果），最后一句保留。",
    [
      { title: "CKD合并代谢性酸中毒：果蔬减酸10年，住院和透析少于常规照护",
        lead: "一项将在ASN肾脏周2026报告的随机试验显示，3期CKD合并代谢性酸中毒的成人改吃果蔬减少膳食酸，10年里住院和进展到透析都少于常规照护。果蔬组住院14次，常规照护组64次。进入透析的为4例对16例。口服碳酸氢钠与常规照护相比没有差别。",
        ref: "0231e070f64a9b46", source: "News-Medical.net" },
      { title: "法国和瑞典数据：癫痫与65岁前发生痴呆相关",
        lead: "一项发表在Neurology上的研究用法国和瑞典的全国数据库发现，癫痫与65岁前发病的痴呆相关，但不能证明因果。法国新诊断癫痫者10年内2.2%发生这类痴呆，无癫痫者为0.2%。校正卒中等因素后，新诊断者的风险约为无癫痫者的6倍。",
        ref: "b81410d7ee727233", source: "Medical Xpress 医学研究速递" },
    ]),
  social: card("发帖账号＋帖子指向的研究或文件＋它的主要说法",
    ["FINDING"],
    "用一两句话写帖子讲的事和它的一个主要说法：帖子指向一篇论文、一份指南或一个会议的，写它是什么；有发帖账号的归到账号名下，没有的写「发帖者称」「帖中称」，不把帖子的说法当作事实；不写帖子本身（标题、话题标签、长短），不扩写，不补充帖子以外的内容；帖子很短时一句即可。",
    [
      { title: "Diabetologia：HRS-7535治疗2型糖尿病的II期试验",
        lead: "Diabetologia在X上推介一项II期试验。HRS-7535属于GLP-1RA，可口服，用于二甲双胍加SGLT2i后仍不达标的中国患者，初步结果看好。",
        ref: "c93527824d53d4e2", source: "Diabetologia（X @DiabetologiaJnl）" },
      { title: "JAMA Dermatology：多数黑色素瘤风险模型低估绝对风险",
        lead: "JAMA Dermatology在X上介绍，几种黑色素瘤风险预测模型在一个澳大利亚独立队列中区分度尚可，但多数低估了绝对风险。",
        ref: "bf05e198f52fd0c6", source: "JAMA Dermatology（X @JAMADerm）" },
    ]),
  roundup: card("合集里对临床读者最相关的那一条",
    ["FINDING"],
    "这是一篇把多条互不相关的消息放在一起的合集：先写其中对临床读者最相关的一条，再用短句依次带过其余主要几条，每条一句，写清是谁的什么事；不写条数，不硬找共同主线，不写开场白。",
    [
      { title: "一篇新冠疫苗小鼠研究论文因数据造假被撤稿",
        lead: "《科学·转化医学》撤回了一篇2022年的论文，该文报告新冠疫苗在小鼠中诱导广谱中和抗体，原因是部分数据造假。FDA发布4个帮助临床医生治疗阿片类物质使用障碍的视频。美国医保部门称削减部分重复参保者的补贴，一年约省15亿美元。",
        ref: "25ed94e8e2c7b73f", source: "MedPage Today 医学新闻" },
      { title: "FDA完全批准帕博利珠单抗用于TMB高的实体瘤",
        lead: "FDA完全批准帕博利珠单抗用于经治、肿瘤突变负荷高、无法切除或已转移的实体瘤。刚果埃博拉疫情的确诊病例已达9,704例。堪萨斯州一所小学暴发诺如病毒感染，近100名师生发病。",
        ref: "2ad37e403328ba69", source: "MedPage Today 医学新闻" },
    ]),
}));

/** One card, frozen. @param {string} title @param {string[]} moves @param {string} lead @param {FrontierStyleExemplar[]} exemplars @returns {FrontierStyleCard} */
function card(title, moves, lead, exemplars) {
  return Object.freeze({ title, moves: /** @type {any} */ (Object.freeze(moves)), lead, exemplars: Object.freeze(exemplars.map((exemplar) => Object.freeze(exemplar))) });
}

/** Every exemplar's words (titles and 导读), for the eval's leakage count. */
export function frontierStyleExemplarTexts() {
  return Object.values(FRONTIER_STYLE_CARDS).flatMap((entry) => entry.exemplars.flatMap((exemplar) => [exemplar.title, exemplar.lead]));
}

/** Every genre has a card, and every card's moves are of the vocabulary (a genre added without one fails here, at import). */
for (const genre of FRONTIER_GENRES) {
  const entry = FRONTIER_STYLE_CARDS[genre];
  if (!entry) throw new Error(`frontierStyle: no card for genre ${genre}`);
  for (const move of entry.moves) if (!(move in FRONTIER_LEAD_MOVES)) throw new Error(`frontierStyle: unknown move ${move} in ${genre}`);
}
