import { parseFrontierItem, parseFrontierItemDetail, type FrontierItem, type FrontierItemDetail } from "@/lib/frontierClient";

/**
 * One item as `GET /api/frontier/items` sends it (build spec B.6), shared by
 * the frontier tests. It also carries fields the contract never sends — a
 * score, a model name — so a test can prove the page could not show them if a
 * server ever did.
 */
export function rawFrontierItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2c3d4e5f60718",
    title: "口服 PCSK9 抑制剂降低主要心血管事件",
    titleRaw: "Oral PCSK9 Inhibition and Cardiovascular Outcomes",
    titleZh: "口服 PCSK9 抑制剂降低主要心血管事件",
    summary: "多中心双盲试验纳入 12000 例患者。",
    reason: "首个口服 PCSK9 抑制剂的硬终点证据。",
    lang: "en",
    lane: "evidence", laneLabel: "临床证据",
    sourceType: "journal", sourceTypeLabel: "期刊",
    evidenceType: "rct", evidenceTypeLabel: "RCT", evidenceBasis: "pubmed-types",
    specialties: [{ key: "cardiology", label: "心血管" }],
    flags: [],
    entities: { drugs: ["PCSK9"], trials: [], orgs: [], diseases: [] },
    source: { id: "nejm", name: "NEJM", homepage: "https://www.nejm.org", platformProduced: false },
    url: "https://www.nejm.org/doi/full/10.1056/example",
    doi: "10.1056/example", pmid: null, registryIds: [],
    publishedAt: "2026-09-22T06:00:00.000Z", datePrecision: "instant",
    timelineAt: "2026-09-22T06:30:00.000Z", visibleAt: "2026-09-22T06:30:00.000Z",
    selected: true, selectedRule: "threshold", safetyAlert: false, verification: "passed",
    levels: { authority: "high", impact: "high", novelty: "medium", relevance: "low" },
    openAccess: null, facts: {}, alsoReportedBy: [], event: null,
    state: { starred: false, hidden: false, read: false },
    // Never on the wire by contract; here to prove they could not leak if they were.
    scoreTotal: 87, scores: { impact: 29, novelty: 17, relevance: 13 }, editorModel: "deepseek-flash",
    ...overrides,
  };
}

/** The same item, read the way the page reads it. */
export function frontierItem(overrides: Record<string, unknown> = {}): FrontierItem {
  const item = parseFrontierItem(rawFrontierItem(overrides));
  if (!item) throw new Error("fixture item did not parse");
  return item;
}

/** The same item as its reader reads it (contract B); a field not given is what an older server sends: nothing. */
export function frontierItemDetail(overrides: Record<string, unknown> = {}): FrontierItemDetail {
  const item = parseFrontierItemDetail(rawFrontierItem(overrides));
  if (!item) throw new Error("fixture item did not parse");
  return item;
}

const MEDIA = (letter: string) => letter.repeat(64);

/** An X post with every block of the reader: author, pictures, a quoted post, the translation, its score's parts, tags and its event's follow-ups. */
export function rawXPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawFrontierItem({
    id: "x-post-0001",
    title: "Arena：DeepSeek-V4.1-Flash 登顶 Agent Arena 开源榜首",
    titleRaw: "BREAKING: DeepSeek-V4.1-Flash is now the #1 open model in Agent Arena",
    titleZh: "Arena：DeepSeek-V4.1-Flash 登顶 Agent Arena 开源榜首",
    summary: "Arena 宣布 DeepSeek-V4.1-Flash 成为 Agent Arena 第一开源模型，总排名第 11。",
    lead: "Arena 宣布 DeepSeek-V4.1-Flash 成为 Agent Arena 第一开源模型，总排名第 11，基于超 7.5K 真实会话净提升 +5.1%；中位任务成本 $0.20。",
    reason: "用 7.5K 真实会话的数据说明该模型以约 27% 的成本拿下开源第一，读者可据此权衡 Agent 场景的性价比。",
    lang: "en", lane: "pipeline", laneLabel: "研发产业", sourceType: "media", sourceTypeLabel: "媒体",
    evidenceType: null, evidenceTypeLabel: null, doi: null,
    source: { id: "x-arena", name: "Arena.ai", homepage: "https://x.com/arena", platformProduced: false },
    url: "https://x.com/arena/status/1",
    channel: "x", platform: "x",
    author: { name: "Arena.ai", handle: "arena", url: "https://x.com/arena", role: "organisation" },
    thumb: { id: MEDIA("a"), width: 1200, height: 675, alt: "排行榜" },
    score: 74, scoreBand: "high", selected: true,
    body: {
      zh: "重大消息：由 @deepseek_ai 推出的 DeepSeek-V4.1-Flash 现已成为 Agent Arena 中排名第一的开源模型！它以综合第 11 名的成绩上榜，在超过 7.5K 个真实场景会话中实现了 +5.1% 的净提升。\n\n按信号来看，本次发布实现了：\n- 在 Confirmed Success 中排名第 8，提升 +11.5%\n- 在 Tool Hallucination 方面没有问题\n\n祝贺 @deepseek_ai 团队发布这一版本！",
      original: "BREAKING: DeepSeek-V4.1-Flash by @deepseek_ai is now the #1 open model in Agent Arena! It lands at #11 overall, with a +5.1% net lift across 7.5K+ real sessions.\n\nBy signal:\n- #8 in Confirmed Success, +11.5%\n- No issues on Tool Hallucination\n\nCongrats to the @deepseek_ai team!",
      zhKind: "translation", complete: true,
    },
    media: [
      { id: MEDIA("a"), width: 1200, height: 675, alt: "Agent Arena 排行榜" },
      { id: MEDIA("b"), width: 1200, height: 675, alt: "成本与得分的帕累托前沿" },
    ],
    quoted: {
      author: { name: "Arena.ai", handle: "arena" },
      text: "Exciting news: DeepSeek-V4.1-Flash (Max) is now the #1 open model in Code Arena: WebDev, beating Kimi K3 (Max) at 10x lower cost!",
      translation: "激动人心的消息：DeepSeek-V4.1-Flash (Max) 现已成为 Code Arena: WebDev 中排名第一的开源模型，以低 10 倍的成本超越 Kimi K3 (Max)！",
      url: "https://x.com/arena/status/0",
    },
    metrics: { likes: 1200, reposts: 300, replies: 45, views: 98000 },
    // The retired `topics` is still on this fixture: the reader must not draw it.
    topics: [{ slug: "deepseek", name: "DeepSeek", group: "organisation" }, { slug: "ai-agents", name: "Agent 智能体", group: "genre" }],
    specialties: [],
    tags: [{ slug: "benchmarks", name: "评测/基准" }, { slug: "agent", name: "Agent" }, { slug: "deepseek", name: "DeepSeek" }],
    scoreParts: { authority: 22, impact: 22, novelty: 16, relevance: 14 },
    sameEvent: null,
    followups: { eventId: "ev1", more: false, rows: [
      { itemId: "f-1", title: "DeepSeek V4.1 Flash 1017 发布，Artificial Analysis 智能指数得分 45 并列开源模型第二", sourceName: "Artificial Analysis", at: new Date(Date.now() - 2 * 86_400_000).toISOString(), relation: "follows" },
      { itemId: "f-2", title: "DeepSeek-V4.1-Flash-20261017 登顶 Code Arena: WebDev 开源模型榜首", sourceName: "Arena", at: new Date(Date.now() - 3 * 86_400_000).toISOString(), relation: "same-event" },
    ] },
    publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    ...overrides,
  });
}

/** A Chinese news article: its text is Chinese already, so there is nothing to translate and no switch. */
export function rawChineseNews(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawFrontierItem({
    id: "cn-news-0001",
    title: "国家药监局批准首个口服 GLP-1 受体激动剂上市",
    titleRaw: "国家药监局批准首个口服 GLP-1 受体激动剂上市",
    titleZh: "国家药监局批准首个口服 GLP-1 受体激动剂上市",
    lang: "zh", lane: "regulatory", laneLabel: "审批监管", sourceType: "media", sourceTypeLabel: "媒体",
    evidenceType: null, evidenceTypeLabel: null, doi: null,
    source: { id: "yimaitong", name: "医脉通", homepage: "https://www.medlive.cn", platformProduced: false },
    url: "https://news.medlive.cn/article/1",
    channel: "news", platform: "web",
    author: { name: "王编辑", handle: null, url: null, role: "person" },
    lead: "国家药监局批准口服司美格鲁肽片用于成人 2 型糖尿病，为国内首个口服 GLP-1 受体激动剂。",
    reason: null, score: 58, scoreBand: "low", selected: false,
    body: { zh: "国家药品监督管理局近日批准口服司美格鲁肽片上市。\n\n该药用于在饮食控制和运动基础上改善成人 2 型糖尿病患者的血糖控制。", original: null, zhKind: "original-zh", complete: true },
    media: [{ id: MEDIA("c"), width: 800, height: 600, alt: "药品包装" }],
    specialties: [{ key: "endocrinology", label: "内分泌代谢" }],
    tags: [],
    followups: null,
    ...overrides,
  });
}

/**
 * An open-access paper whose whole text the plugin kept (rt-contract): the 速读 as one paragraph and a full text with `## ` section
 * headings in both languages.
 */
export function rawOpenAccessPaper(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawFrontierItem({
    id: "oa-paper-1",
    lead: "这项纳入 12000 例高危患者的多中心双盲试验发现，口服 PCSK9 抑制剂使主要心血管事件风险降低 18%。LDL-C 平均下降 52%，且不良事件与安慰剂相当。研究为不能耐受注射剂的患者提供了新的选择，但随访仅 2.1 年，长期安全性仍待观察。",
    body: {
      zh: "## 引言\n\n低密度脂蛋白胆固醇（LDL-C）是动脉粥样硬化性心血管病的主要致病因素。\n\n## 方法\n\n我们在 32 个国家开展了一项双盲、安慰剂对照试验。\n\n## 结果\n\n治疗组主要终点事件发生率为 7.2%，安慰剂组为 8.8%（风险比 0.82）。\n\n## 讨论\n\n口服 PCSK9 抑制剂降低了主要心血管事件的风险。",
      original: "## Introduction\n\nLow-density lipoprotein cholesterol (LDL-C) is a major cause of atherosclerotic cardiovascular disease.\n\n## Methods\n\nWe conducted a double-blind, placebo-controlled trial in 32 countries.\n\n## Results\n\nThe primary end point occurred in 7.2% of the active group and 8.8% of the placebo group (hazard ratio, 0.82).\n\n## Discussion\n\nOral PCSK9 inhibition reduced the risk of major cardiovascular events.",
      zhKind: "translation", complete: true, source: "body",
    },
    openAccess: { status: "gold", pdfUrl: "https://europepmc.org/articles/PMC1/pdf" },
    ...overrides,
  });
}

/** A paper whose text is its structured abstract (`body.source === "abstract"`): each paragraph runs in with its own heading. */
export function rawStructuredAbstract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawFrontierItem({
    id: "abstract-1",
    lead: "口服 PCSK9 抑制剂使高危患者主要心血管事件风险降低 18%，LDL-C 平均下降 52%。",
    body: {
      zh: "背景：口服 PCSK9 抑制可降低 LDL 胆固醇。\n\n方法：在一项双盲试验中，12000 例患者被随机分配接受口服抑制剂或安慰剂。\n\n结果：主要终点事件在治疗组发生率为 7.2%，安慰剂组为 8.8%（风险比 0.82；95% CI：0.75–0.90）。",
      original: "Background: Oral PCSK9 inhibition lowers LDL cholesterol.\n\nMethods: In a double-blind trial, 12,000 patients were randomly assigned to the oral inhibitor or placebo.\n\nResults: The primary end point occurred in 7.2% of the active group and 8.8% of the placebo group (hazard ratio, 0.82; 95% CI: 0.75 to 0.90).",
      zhKind: "translation", complete: true, source: "abstract",
    },
    ...overrides,
  });
}

/**
 * Items of each genre as their reader reads them (ct-write 2026-10-24): what the server sends for a paper, a 公众号 reading, a policy,
 * a short industry report, a long news report and a safety alert — each with its genre, its 速读 and its 「AI 要点」.
 */
export function rawBriefedPaper(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawStructuredAbstract({
    id: "briefed-paper-1", genre: "paper", genreLabel: "研究论文",
    lead: "口服 PCSK9 抑制剂使高危患者主要心血管事件风险降低 18%（风险比 0.82），这项 12000 例的双盲试验中不良事件与安慰剂相当。",
    brief: {
      genre: "paper",
      points: [
        { key: "question", label: "研究问题", text: "口服 PCSK9 抑制剂能否降低高危患者的主要心血管事件。" },
        { key: "design", label: "设计与对象", text: "双盲、安慰剂对照随机试验，12000 例患者。" },
        { key: "results", label: "主要结果", items: ["主要终点事件 7.2% 对 8.8%（风险比 0.82；95% CI：0.75–0.90）。", "LDL-C 平均下降 52%。"] },
      ],
      quote: { key: "conclusion", label: "作者结论", text: "Oral PCSK9 inhibition reduced the risk of major cardiovascular events.", zh: "口服 PCSK9 抑制降低了主要心血管事件的风险。" },
    },
    ...overrides,
  });
}

export function rawWechatCommentary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const paragraph = "这篇解读回顾了两项试验的设计和背景治疗的差别，并讨论了复合终点事件数较少时风险比的解读。".repeat(4);
  return rawChineseNews({
    id: "wx-commentary-1", genre: "commentary", genreLabel: "解读评论",
    title: "IgA 肾病新药两篇 NEJM 同日发表", titleRaw: "IgA 肾病新药两篇 NEJM 同日发表", titleZh: "IgA 肾病新药两篇 NEJM 同日发表",
    lane: "evidence", laneLabel: "临床证据",
    source: { id: "wx-nejm-front", name: "NEJM医学前沿", homepage: null, platformProduced: false },
    url: "https://mp.weixin.qq.com/s/example", channel: "wechat", platform: "wechat",
    author: { name: "NEJM医学前沿", handle: null, url: null, role: "organisation" },
    lead: "两项 IgA 肾病 3 期试验显示，atacicept 与 sibeprenlimab 均延缓了 eGFR 下降；解读认为两者非头对头比较，尚不能判断孰优孰劣。",
    body: { zh: Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段。${paragraph}`).join("\n\n"), original: null, zhKind: "original-zh", complete: true, source: "body" },
    brief: {
      genre: "commentary",
      points: [
        { key: "subject", label: "解读的研究", text: "NEJM 同日发表的 ORIGIN 3 与 VISIONARY 两项 3 期试验。" },
        { key: "analysis", label: "解读要点", items: ["疗效证据从蛋白尿下降延伸到肾功能保护。", "两项试验非头对头比较，背景治疗不同。"] },
      ],
      quote: { key: "remark", label: "原文观点", text: "现有结果能够支持两种治疗策略均具有临床价值。" },
      about: { publicId: "nejm-origin3", title: "Atacicept in IgA Nephropathy" },
    },
    media: [],
    ...overrides,
  });
}

export function rawPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawChineseNews({
    id: "policy-1", genre: "policy", genreLabel: "政策法规",
    title: "国家医保局：新技术可在临床研究阶段申报价格预立项", titleRaw: "国家医保局：新技术可在临床研究阶段申报价格预立项", titleZh: "国家医保局：新技术可在临床研究阶段申报价格预立项",
    source: { id: "nhsa", name: "国家医疗保障局", homepage: "https://www.nhsa.gov.cn", platformProduced: false },
    url: "https://www.nhsa.gov.cn/art/1.html", channel: "regulator", platform: "web", sourceType: "regulator", author: null,
    lead: "国家医保局允许新技术在获准进入临床研究时即申报医疗服务价格预立项，只需 1 家三级医院牵头直接向省级医保部门申报。",
    body: { zh: "一、为什么要开展价格预立项？\n\n为支持医疗技术创新，……\n\n二、谁可以申报？\n\n只需 1 家三级医院牵头直接向省级医保部门申报。", original: null, zhKind: "original-zh", complete: true, source: "body" },
    brief: { genre: "policy", points: [
      { key: "document", label: "发文机关与文号", text: "国家医疗保障局，医保发〔2026〕23号。" },
      { key: "audience", label: "适用对象", text: "开展新技术临床研究的三级医院。" },
    ] },
    media: [],
    ...overrides,
  });
}

export function rawIndustryShort(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawChineseNews({
    id: "industry-1", genre: "industry", genreLabel: "行业动态",
    title: "12.75 亿美元首付！吉利德买断瀚辰星泰环肽", titleRaw: "12.75 亿美元首付！吉利德买断瀚辰星泰环肽", titleZh: "12.75 亿美元首付！吉利德买断瀚辰星泰环肽",
    source: { id: "wx-yaoshidai", name: "药时代", homepage: null, platformProduced: false }, url: "https://news.example.com/deal",
    lead: "吉利德以 12.75 亿美元现金首付款收购瀚辰星泰的口服 IL-23R 抑制剂项目，核心资产 HCXT-2001 处于 I 期。",
    body: { zh: "吉利德科学宣布以 12.75 亿美元现金首付款收购瀚辰星泰的口服 IL-23R 抑制剂项目。\n\n交易预计 2026 年第四季度完成。", original: null, zhKind: "original-zh", complete: true, source: "body" },
    brief: { genre: "industry", points: [
      { key: "event", label: "事件", text: "吉利德收购瀚辰星泰的口服 IL-23R 抑制剂项目，获得全球权益。" },
      { key: "terms", label: "交易条款", text: "现金首付款 12.75 亿美元，预计 2026 年第四季度完成。" },
    ] },
    media: [],
    ...overrides,
  });
}

export function rawNewsLong(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const paragraph = "研究人员在小细胞肺癌中发现了一种干细胞样状态，它与化学免疫治疗后的不良预后相关。".repeat(6);
  return rawChineseNews({
    id: "news-long-1", genre: "news", genreLabel: "医学新闻",
    body: { zh: Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段。${paragraph}`).join("\n\n"), original: null, zhKind: "original-zh", complete: true, source: "body" },
    ...overrides,
  });
}

export function rawSafetyAlert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawChineseNews({
    id: "safety-1", genre: "safety", genreLabel: "安全警示", safetyAlert: true, score: null, scoreBand: null,
    title: "FDA 将 Philips Lumify 超声系统召回定为最严重级别", titleRaw: "Philips Lumify Diagnostic Ultrasound System Correction", titleZh: "FDA 将 Philips Lumify 超声系统召回定为最严重级别",
    lang: "en", lane: "safety", laneLabel: "药物安全", sourceType: "regulator", evidenceType: "safety-notice", evidenceTypeLabel: "安全通告",
    source: { id: "fda-medwatch", name: "FDA", homepage: "https://www.fda.gov", platformProduced: false }, url: "https://www.fda.gov/recall/1", author: null,
    lead: "FDA 将 Philips Lumify 诊断超声系统的软件问题定为最严重级别的召回，要求更新使用说明；已报告 8 例严重伤害和 4 例死亡。",
    body: { zh: "本次召回涉及更新设备使用说明，不涉及将设备移除。", original: "This recall involves updating instructions for use, not removing devices.", zhKind: "translation", complete: true, source: "body" },
    brief: { genre: "safety", points: [
      { key: "action", label: "监管措施", text: "FDA 将召回定为最严重级别，要求更新使用说明。" },
      { key: "professionals", label: "医务人员须知", items: ["仅在有 Wi-Fi 或蜂窝信号的区域使用。", "随时备好备用超声设备。"] },
    ], quote: { key: "warning", label: "警示原文", text: "Use of affected devices may cause serious injuries or death.", zh: "使用受影响的设备可能导致严重伤害或死亡。" } },
    media: [],
    ...overrides,
  });
}
