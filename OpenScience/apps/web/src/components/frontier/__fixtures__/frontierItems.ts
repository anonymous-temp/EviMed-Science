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
 * An open-access paper whose whole text the plugin kept (rt-contract): the 导读 as one paragraph, an 「AI 解读」 citing two related
 * reports and naming a third it has no report for, and a full text with `## ` section headings in both languages.
 */
export function rawOpenAccessPaper(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawFrontierItem({
    id: "oa-paper-1",
    lead: "这项纳入 12000 例高危患者的多中心双盲试验发现，口服 PCSK9 抑制剂使主要心血管事件风险降低 18%。LDL-C 平均下降 52%，且不良事件与安慰剂相当。研究为不能耐受注射剂的患者提供了新的选择，但随访仅 2.1 年，长期安全性仍待观察。",
    insight: {
      text: "这是口服 PCSK9 抑制剂的首个硬终点证据，与此前注射剂的结局试验方向一致[1]；FDA 已受理其上市申请[2]。真实世界依从性能否维持试验中的降脂幅度，还要看后续数据[3]。",
      refs: [
        { n: 1, publicId: "f-2", title: "MedPage Today：口服 PCSK9 抑制剂降低心血管事件 18%", source: "MedPage Today", at: new Date(Date.now() - 4 * 3_600_000).toISOString() },
        { n: 2, publicId: "f-1", title: "FDA 受理口服 PCSK9 抑制剂的上市申请", source: "FDA", at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      ],
    },
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
