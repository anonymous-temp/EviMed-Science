/**
 * Fixtures for the GEO step tabs and the answer page, in the shapes of build
 * spec §3. The product, numbers and answers are illustrative (the mockups').
 */
import type {
  GeoAnswer,
  GeoArticles,
  GeoCell,
  GeoDiagnosis,
  GeoDistribution,
  GeoErrorRow,
  GeoEvidence,
  GeoJourney,
  GeoMonitoring,
  GeoProject,
  GeoQuestions,
  GeoSourceAnswer,
  GeoSourceDetail,
  GeoSourceHistoryPoint,
  GeoSourcePage,
  GeoSourceRow,
  GeoSources,
  GeoStepKey,
  GeoStepStatus,
  GeoStrategyView,
  GeoValue,
} from "@/lib/geoClient";

export function cell(value: number | null, numerator: number | null, denominator: number | null, extra: Partial<GeoCell> = {}): GeoCell {
  const status = value === null ? "not_measurable" : denominator !== null && denominator < 30 ? "insufficient" : "ok";
  return { value, numerator, denominator, ciLow: null, ciHigh: null, status, dataType: "measured", ...extra };
}

export function geoProject(steps: Partial<Record<GeoStepKey, GeoStepStatus>> = {}, overrides: Partial<GeoProject> = {}): GeoProject {
  const stepRows = Object.fromEntries(Object.entries(steps).map(([key, status]) => [key, { status, requested: true }]));
  return {
    id: "geo_1",
    projectId: "prj_geo_1",
    name: "玛仕度肽注射液",
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液", aliases: ["玛仕度肽"] },
    competitors: [],
    coverageDays: 90,
    engines: ["doubao", "deepseek", "yuanbao", "kimi", "qianwen"],
    tier: "2",
    budget: null,
    status: "active",
    steps: stepRows,
    sessionId: "ses_geo_1",
    needsYou: [],
    overview: {
      metrics: [
        { key: "gvi", cell: cell(38, null, 310), target: 55, trend: [] },
        { key: "mention", cell: cell(21, 65, 310), target: 35, trend: [] },
        { key: "accuracy", cell: cell(92, 285, 310), target: 98, trend: [{ date: "2026-10-06", value: 88 }, { date: "2026-10-13", value: 92 }] },
        { key: "citation", cell: cell(6, 2, 24), target: 20, trend: [] },
      ],
      week: [],
      // The server sends the same map in both places; so does this.
      steps: stepRows,
    },
    ...overrides,
  };
}

export const evidenceFilled: GeoEvidence = {
  product: {
    brandName: "信尔美",
    genericName: "玛仕度肽注射液",
    holder: "信达生物制药（苏州）有限公司",
    rx: "rx",
    approvalNo: "国药准字S20250001",
    indication: "用于成人肥胖或超重患者的长期体重控制。",
    identityStatus: "confirmed",
  },
  competitors: [{ brandName: "司美格鲁肽" }, { genericName: "替尔泊肽" }],
  claims: [
    {
      id: "clm_1",
      statement: "每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。",
      quote: "本品每周注射一次。",
      sourceRef: "玛仕度肽注射液说明书（国家药监局 2025）",
      sourceKind: "label",
      evidenceLevel: null,
      population: "成人",
      inLabel: true,
      verifiedAt: "2026-09-22T00:00:00Z",
      validUntil: null,
      status: "active",
    },
    {
      id: "clm_2",
      statement: "GLORY-1 随机对照试验中，48 周时体重下降幅度显著大于安慰剂组。",
      quote: "At week 48 …",
      sourceRef: "N Engl J Med 2025",
      sourceKind: "trial",
      evidenceLevel: "A",
      population: null,
      inLabel: null,
      verifiedAt: "2026-09-22T00:00:00Z",
      validUntil: null,
      status: "active",
    },
    {
      id: "clm_3",
      statement: "已撤下的旧说法。",
      quote: "旧",
      sourceRef: "旧",
      sourceKind: "other",
      evidenceLevel: null,
      population: null,
      inLabel: null,
      verifiedAt: null,
      validUntil: null,
      status: "retired",
    },
  ],
};

export const journeyFilled: GeoJourney = {
  subtypes: ["BMI≥28 的成人肥胖"],
  personas: ["35 岁上班族，想减重又怕副作用"],
  stages: [
    { stage: "症状初现", emotion: "3/10", thinking: "胖算不算病，要不要管", questions: ["BMI 28 算肥胖吗", "减肥针是什么"], infoSources: ["小红书", "抖音"] },
    { stage: "方案初选", emotion: "5", thinking: "打针还是吃药，哪个副作用小", questions: ["减重针哪种好"], infoSources: ["医生面诊"] },
    { stage: "治疗启动", emotion: "焦虑", thinking: "打了会不会一直恶心", questions: ["打完恶心想吐怎么办"], infoSources: ["药师"] },
  ],
  careNodes: [{ node: "治疗启动", redFlags: ["持续剧烈腹痛", "无法进食进水"] }],
  files: [{ path: "outputs/journey/journey-matrix.xlsx", title: "完整旅程图" }],
};

export const questionsFilled: GeoQuestions = {
  sets: [{ version: 1, lockedAt: "2026-09-20T00:00:00Z", measuredCount: 3 }, { version: 2, lockedAt: "2026-09-24T00:00:00Z", measuredCount: 2 }],
  version: 2,
  groups: [
    {
      id: "gq_1",
      pool: "P2",
      name: "恶心呕吐与胃肠反应",
      typicalQuestion: "打了减重针一直恶心，要不要停药？",
      journeyStage: "治疗启动",
      audience: "patient",
      weight: 1,
      isControl: false,
      signal: "collected",
      questions: [
        { id: "q_1", text: "打了减重针一直恶心，要不要停药？", kind: "typical", platform: null, sourceUrl: null, isMeasured: true,
          answers: [{ engine: "doubao", snapshotId: "snap_doubao" }, { engine: "deepseek", snapshotId: "snap_deepseek" }] },
        { id: "q_2", text: "打完减肥针一直吐正常吗", kind: "real", platform: "小红书", sourceUrl: "https://www.xiaohongshu.com/explore/1", isMeasured: false },
        { id: "q_3", text: "恶心是不是说明剂量太大", kind: "real", platform: "知乎", sourceUrl: null, isMeasured: false },
      ],
    },
    {
      id: "gq_2",
      pool: "P2",
      name: "停药与体重反弹",
      typicalQuestion: "停药后体重会反弹吗？",
      journeyStage: "疗效评估",
      audience: "patient",
      weight: 1,
      isControl: true,
      signal: "no_signal",
      questions: [
        { id: "q_4", text: "停药后体重会反弹吗？", kind: "typical", platform: null, sourceUrl: null, isMeasured: true, answers: [] },
      ],
    },
    {
      id: "gq_3",
      pool: "P4",
      name: "孕期、哺乳期与未成年人",
      typicalQuestion: "怀孕能打减重针吗？",
      journeyStage: null,
      audience: "patient",
      weight: 1,
      isControl: false,
      signal: "collected",
      questions: [],
    },
  ],
};

export const diagnosisFilled: GeoDiagnosis = {
  round: {
    id: "rnd_2",
    kind: "weekly",
    sampleDate: "2026-10-13",
    surface: { mode: "web", deep: false, newChat: true },
    planned: 310,
    done: 310,
    engines: ["doubao", "deepseek", "baidu"],
  },
  rounds: [
    { id: "rnd_2", kind: "weekly", sampleDate: "2026-10-13" },
    { id: "rnd_1", kind: "baseline", sampleDate: "2026-09-22" },
  ],
  byEngine: [
    { engine: "doubao", mention: cell(22, 14, 62, { snapshotIds: ["snap_doubao"] }), accuracy: cell(94, 47, 50), citation: cell(8, 5, 62), retrieval: cell(88, 55, 62) },
    { engine: "deepseek", mention: cell(15, 9, 62), accuracy: cell(81, 38, 47), citation: cell(0, 0, 62), retrieval: cell(96, 60, 62) },
    { engine: "baidu", mention: cell(18, 11, 62), accuracy: cell(null, null, null), citation: cell(null, null, null), retrieval: cell(null, null, null) },
    { engine: "kimi", mention: cell(12, 2, 17), accuracy: cell(null, null, null, { status: "absent" }), citation: cell(4, 1, 17), retrieval: cell(41, 7, 17) },
  ],
  byPool: [
    { pool: "P1", mention: cell(64, 40, 62), topCompetitor: null, mainIssue: "两家把用法说成每天一次" },
    { pool: "P2", mention: cell(21, 13, 62), topCompetitor: "司美格鲁肽 48%", mainIssue: "多数回答只列司美格鲁肽" },
  ],
  failureModes: {
    omitted: cell(13, 41, 310),
    correct: cell(10, 32, 310),
    wrongOurs: cell(0.6, 2, 310),
    wrongCompetitor: cell(1, 3, 310),
  },
  errors: [
    {
      id: "err_1",
      engine: "deepseek",
      statement: "它需要每天注射一次",
      severity: "S2",
      errorType: "number",
      stability: "stable",
      citedSource: { url: "https://baike.baidu.com/item/x", domain: "baike.baidu.com", attribute: "encyclopedia" },
      action: "encyclopedia_fix",
      status: "acting",
      snapshotId: "snap_deepseek",
      firstSnapshotId: "snap_deepseek",
    },
  ],
  errorCounts: { total: 1, open: 0, acting: 1, awaiting_remeasure: 0, closed: 0, severe: 0 },
  noise: { band: 3, measuredAt: "2026-09-23" },
  more: [{ metricId: "M-02", name: "首位提及率", cell: cell(9, 28, 310) }],
};

/** The diagnosis with these error rows, and the counts the server would send for them (`count(*)` over exactly these). */
export function diagnosisWith(errors: GeoErrorRow[], base: GeoDiagnosis = diagnosisFilled): GeoDiagnosis {
  const count = (status: GeoErrorRow["status"]) => errors.filter((error) => error.status === status).length;
  return {
    ...base,
    errors,
    errorCounts: {
      total: errors.length, open: count("open"), acting: count("acting"), awaiting_remeasure: count("awaiting_remeasure"), closed: count("closed"),
      severe: errors.filter((error) => error.status !== "closed" && (error.severity === "S3" || error.severity === "S4")).length,
    },
  };
}

export const answerFilled: GeoAnswer = {
  question: { id: "q_1", text: "打了减重针一直恶心，要不要停药？", pool: "P2" },
  snapshot: {
    id: "snap_deepseek",
    engine: "deepseek",
    askedAt: "2026-10-13T02:00:00Z",
    status: "valid",
    answerText: "恶心、呕吐是 GLP-1 类减重药最常见的不良反应，一般不需要因为轻度恶心就停药。\n\n以玛仕度肽为例，它需要每天注射一次，起始剂量较低，之后按医嘱逐步加量。\n\n如果呕吐频繁、无法进食进水，应及时就医。",
    citations: [
      { url: "https://dxy.com/a", domain: "dxy.com", title: "GLP-1 类药物的胃肠道反应", inBody: true },
      { url: "https://zhihu.com/b", domain: "zhihu.com", title: "打了三个月减重针", inBody: false },
      { url: "https://baike.baidu.com/item/x", domain: "baike.baidu.com", title: "玛仕度肽", inBody: true },
    ],
    surface: { mode: "web", deep: false, newChat: true },
    screenshot: true,
    screenshotSha256: "a".repeat(64),
  },
  siblings: [
    { engine: "doubao", snapshotId: "snap_doubao", status: "valid", mentionsOurs: true, wrongOurs: 0 },
    { engine: "deepseek", snapshotId: "snap_deepseek", status: "valid" },
    { engine: "yuanbao", snapshotId: "snap_yuanbao", status: "valid", mentionsOurs: true, citesOurs: true, wrongOurs: 0 },
    { engine: "kimi", snapshotId: "snap_kimi", status: "valid", mentionsOurs: false, wrongOurs: 0 },
    { engine: "qianwen", snapshotId: null, status: "absent" },
  ],
  facts: {
    brands: [{ name: "玛仕度肽", ours: true, competitor: false, position: 1, inRecommendation: false, count: 1 }],
    statements: [
      { text: "它需要每天注射一次", verdict: "wrong", claimId: "clm_1", errorType: "number", severity: "S2", evidence: "本品每周注射一次。" },
    ],
  },
  errors: [diagnosisFilled.errors[0]],
  history: [
    { sampleDate: "2026-10-13", snapshotId: "snap_deepseek" },
    { sampleDate: "2026-09-22", snapshotId: "snap_deepseek_old" },
  ],
};

export const sourcesFilled: GeoSources = {
  sources: [
    { id: "src_1", domain: "dxy.com", name: "丁香医生", kind: "health_media", layer: "coverage", conditions: { icp: true, newsIndexed: true, medical: true }, impostor: false, cited: { doubao: 30, deepseek: 18 }, mentionsOurs: 0, wrongOurs: 0, market: null },
    { id: "src_2", domain: "baike.baidu.com", name: "百度百科", kind: "百科", layer: null, conditions: { icp: true, newsIndexed: false, medical: null }, impostor: false, cited: { deepseek: 33 }, mentionsOurs: 2, wrongOurs: 1, mentionsOursByEngine: { deepseek: 2 }, wrongOursByEngine: { deepseek: 1 }, market: null },
    { id: "src_3", domain: "39.net", name: "39 健康网", kind: "health_media", layer: "coverage", conditions: { icp: true, newsIndexed: true, medical: true }, impostor: false, cited: { doubao: 21 }, mentionsOurs: 0, wrongOurs: 0, market: { price: 120, resourceId: "r1" } },
    { id: "src_4", domain: "fake-times.example", name: "某某时报网", kind: "news", layer: null, conditions: { icp: false, newsIndexed: false, medical: false }, impostor: true, cited: { doubao: 4 }, mentionsOurs: 0, wrongOurs: 0, market: null },
  ],
  expectations: [
    { engine: "deepseek", retrieval: cell(96, 60, 62), promise: "进入引用：锚点层 + 覆盖层", layers: ["anchor", "coverage"] },
    { engine: "baidu", retrieval: cell(null, null, null), promise: "只承诺讲对", layers: ["owned"] },
  ],
  battlefield: { groups: ["ggr_1"], groupNames: ["恶心呕吐与胃肠反应"], reason: "证据最硬、竞品最弱。" },
  tiers: [
    { tier: "1", targets: [{ metricId: "M-19", pool: null, baseline: 38, target: 48 }, { metricId: "M-01", pool: "P2", baseline: 21, target: 28 }], placements: 12, budgetCny: 3000 },
    { tier: "2", targets: [{ metricId: "M-19", pool: null, baseline: 38, target: 55 }, { metricId: "M-01", pool: "P2", baseline: 21, target: 35 }], placements: 24, budgetCny: 8000 },
    { tier: "3", targets: [{ metricId: "M-19", pool: null, baseline: 38, target: 62 }, { metricId: "M-01", pool: "P2", baseline: 21, target: 40 }], placements: 40, budgetCny: 15000 },
  ],
  chosenTier: "2",
};

export const articlesFilled: GeoArticles = {
  articles: [
    { id: "art_1", layer: "popular", title: "打了减重针一直恶心，要不要停药？", groupId: "gq_1", question: null, status: "published", gate: "passed", safety: "clear", path: "articles/art_1.md", runId: "run_1", claimCount: 4, placements: 1, cited: true },
    { id: "art_2", layer: "card", title: "合并 2 型糖尿病的人能不能用？", groupId: "gq_1", question: null, status: "draft", gate: "passed", safety: "open", path: "articles/art_2.md", runId: "run_1", claimCount: 3, placements: 0, cited: false },
    { id: "art_3", layer: "qa", title: "停药后体重会反弹吗？", groupId: "gq_2", question: null, status: "withdrawn", gate: "passed", safety: "clear", path: null, runId: null, claimCount: 2, placements: 0, cited: false },
  ],
};

export const distributionFilled: GeoDistribution = {
  budget: { totalCny: 8000, dailyCny: 800 },
  spentCny: 2460,
  reservedCny: 1041,
  suggestedBudgetCny: 8000,
  market: { configured: true },
  orders: [
    { id: "ord_1", articleTitle: "打了减重针一直恶心，要不要停药？", media: "39 健康网", domain: "39.net", layer: "popular", state: "verified", priceCny: 120, publishedUrl: "https://39.net/a", checks: [], updatedAt: "2026-10-09T00:00:00Z" },
    { id: "ord_2", articleTitle: "BMI 多少需要考虑药物减重？", media: "生命时报", domain: "lifetimes.cn", layer: "popular", state: "accepted", priceCny: 946, publishedUrl: null, checks: [], updatedAt: "2026-10-12T00:00:00Z" },
    { id: "ord_3", articleTitle: "减重针打完吃什么，胃肠更舒服", media: "家庭医生在线", domain: "familydoctor.com.cn", layer: "popular", state: "submitted", priceCny: 95, publishedUrl: null, checks: [], updatedAt: "2026-10-11T00:00:00Z" },
  ],
  ownedLinks: [
    { id: "gol_1", url: "https://baijiahao.baidu.com/s?id=1", platform: "baijiahao", title: "减重针常见问题 10 问", publishedAt: "2026-10-03T00:00:00Z",
      articleId: null, groupId: "gq_1", status: "active", retiredAt: null,
      citedBy: [{ engine: "deepseek", firstSeen: "2026-10-05T00:00:00Z" }, { engine: "kimi", firstSeen: "2026-10-08T00:00:00Z" }] },
    { id: "gol_2", url: "https://mp.weixin.qq.com/s/abc", platform: "wechat_mp", title: "停药后体重会反弹吗？", publishedAt: "2026-09-20T00:00:00Z",
      articleId: "art_3", groupId: "gq_2", status: "retired", retiredAt: "2026-10-10T00:00:00Z", citedBy: [] },
  ],
};

export const monitoringFilled: GeoMonitoring = {
  series: [
    {
      key: "gvi",
      points: [
        { date: "2026-09-22", value: 24, n: 310, k: null },
        { date: "2026-09-29", value: 29, n: 310, k: null },
        { date: "2026-10-13", value: 38, n: 310, k: null },
      ],
    },
    {
      key: "mention",
      points: [
        { date: "2026-09-22", value: 15, n: 20, k: 3 },
        { date: "2026-10-13", value: 21, n: 22, k: 5 },
      ],
    },
  ],
  arms: {
    pilot: [{ date: "2026-09-22", value: 24 }, { date: "2026-10-13", value: 38 }],
    control: [{ date: "2026-09-22", value: 23 }, { date: "2026-10-13", value: 25 }],
    netEffect: { ...cell(12, null, 310), noiseBand: 3 },
  },
  byEngine: [
    { engine: "doubao", points: [{ date: "2026-09-22", value: 30, n: 62, k: null }, { date: "2026-10-13", value: 44, n: 62, k: null }] },
    { engine: "kimi", points: [{ date: "2026-09-22", value: 20, n: 12, k: null }, { date: "2026-10-13", value: 29, n: 12, k: null }] },
  ],
  cited: [
    { articleId: "art_1", title: "打了减重针一直恶心，要不要停药？", engine: "doubao", firstSeen: "2026-10-13T02:11:45.123Z" },
    { articleId: "art_1", title: "打了减重针一直恶心，要不要停药？", engine: "yuanbao", firstSeen: "2026-10-14T03:40:12.456Z" },
  ],
  newErrors: [diagnosisFilled.errors[0]],
  next: { date: "2026-10-20", kind: "weekly" },
};

/**
 * What `GET …/sources/:sourceId` answers for a row, built from the row's own numbers as the server builds them: the answers that
 * cite the site, as many as it was cited, of which `wrongOurs` misstate us (the first of them with the sentence this site's marker
 * is beside) and `mentionsOurs` name us — the misstating ones first, as they are counted. A fixture that agrees with its row by
 * construction: what a test asserts is that the page shows the row's numbers as the list it opens, and nothing cut off.
 */
export function sourceDetailOf(row: GeoSourceRow, { engine = null }: { engine?: string | null } = {}): GeoSourceDetail {
  const cited = engine ? row.cited[engine] ?? 0 : Object.values(row.cited).reduce((sum, count) => sum + count, 0);
  const wrong = engine ? row.wrongOursByEngine?.[engine] ?? 0 : row.wrongOurs;
  const mentions = engine ? row.mentionsOursByEngine?.[engine] ?? 0 : row.mentionsOurs;
  const engines = Object.keys(row.cited);
  const answers: GeoSourceAnswer[] = Array.from({ length: cited }, (_, index) => ({
    snapshotId: `snap_${row.id}_${index}`,
    engine: engine ?? engines[index % Math.max(1, engines.length)] ?? "deepseek",
    questionId: `q_${index}`,
    question: `第 ${index + 1} 个问题`,
    askedAt: "2026-10-13T08:00:00Z",
    // The misstating answers are the first ones; they name us too, then the rest up to the count.
    mentionsOurs: index < mentions,
    misstated: index < wrong,
    wrong: index < wrong ? [{ text: `第 ${index + 1} 句讲错的话`, fromThisSite: index === 0 }] : [],
  }));
  return {
    source: { id: row.id, domain: row.domain, name: row.name, kind: row.kind, layer: row.layer, conditions: row.conditions, impostor: row.impostor, market: row.market },
    round: { id: "round_1", kind: "weekly", sampleDate: "2026-10-13" },
    engine,
    counts: { cited, wrongOurs: wrong, mentionsOurs: mentions },
    answers,
  };
}

/** The pages a source row's answers cited: `count` pages, the first the most cited, with a title (the third has none). */
export function sourcePagesOf(domain: string, count: number): GeoSourcePage[] {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://www.${domain}/p/${index + 1}`,
    title: index === 2 ? null : `第 ${index + 1} 个页面`,
    cited: Math.max(1, count - index),
    wrongOurs: index === 0 ? 2 : 0,
  }));
}

/** A source's counts for the last rounds, oldest first: `[date, cited, wrongOurs, coverage]` each. */
export function sourceHistoryOf(rows: ReadonlyArray<readonly [string, number, number, string | null]>): GeoSourceHistoryPoint[] {
  return rows.map(([day, cited, wrongOurs, coverage]) => ({ roundId: `round_${day}`, kind: "weekly", sampleDate: `2026-09-${day}`, coverage, cited, wrongOurs, mentionsOurs: 0 }));
}

/** A project with a drug-value analysis: a summary, findings of three dimensions, a decision, opportunities, a changed source, a research task that failed and one judged round. */
export const valueFilled: GeoValue = {
  version: 3,
  updatedAt: "2026-10-08T08:00:00.000Z",
  data: {
    scope: { genericName: "玛仕度肽注射液", indication: "成人肥胖或超重伴体重相关合并症" },
    summary: "减重获益证据较充分，长期安全性数据仍有限。",
    findings: [
      { id: "f_eff", statement: "12 周体重下降幅度明显大于安慰剂", dimension: "effectiveness" },
      { id: "f_saf", statement: "胃肠道反应多为轻中度，随用药时间减轻", dimension: "safety" },
      { id: "f_eco", statement: "年治疗费用高于同类药", dimension: "economics" },
    ],
    decisions: [{ id: "d_1", statement: "患者是否愿意长期每周注射" }],
    opportunities: [
      { id: "o_1", statement: "补写停药后体重反弹的科普稿" },
      { id: "o_2", statement: "核对说明书里的胃肠道反应表述" },
    ],
    sourceChanges: [{ id: "c_1", summary: "知识库资料已更新，可检查引用它的结论与内容。", status: "needs_review" }],
  },
  research: [{ id: "r_1", question: "这个安全信号说明什么？", status: "failed", runId: "run_1" }],
  impacts: [{ change: { id: "c_1" }, findingIds: ["f_saf"], groupIds: [], articleIds: [] }],
  coverage: { assessed: 4, represented: 3, partial: 1, contradicted: 0, notAddressed: 0, uncertain: 0, notApplicable: 0, value: 75, basisVersion: 3 },
  observations: [
    { findingId: "f_eff", status: "represented", quote: "疗效明显优于安慰剂", reason: "", engine: "deepseek", basisVersion: 3, rubricVersion: "1", askedAt: "2026-10-07T08:00:00.000Z" },
  ],
};

/** The headings the drug-value analysis can draw, one for each tab it appears on. */
export const VALUE_TITLES = ["药品价值分析", "AI 如何表达药品价值", "问题背后的决策", "依据与传播", "下一步研究与内容"] as const;

/** The plan page's one read: three tiers, the battlefield with a secondary one, five engines, a client to-do and a few assumptions. */
export const strategyFilled: GeoStrategyView = {
  version: 13,
  createdAt: "2026-10-12T02:00:00.000Z",
  runId: "run_strategy_1",
  summary: "先把说错的按住，再谈被提到。",
  chosenTier: "2",
  targets: {
    tier: "2",
    baselineRound: { id: "round_b", kind: "baseline", sampleDate: "2026-09-25" },
    latestRound: { id: "round_w", kind: "weekly", sampleDate: "2026-10-12" },
    targetsVersion: 4,
    rows: [
      {
        metricId: "M-19", name: "综合可见度指数", unit: "index", pool: "all",
        tiers: { "1": { target: 48, written: 42, horizonWeeks: 8, placements: 12, budgetCny: 3000, dataType: "forecast" }, "2": { target: 55, written: 42, horizonWeeks: 12, placements: 24, budgetCny: 8000, dataType: "forecast" }, "3": { target: 62, written: 42, horizonWeeks: 12, placements: 40, budgetCny: 15000, dataType: "forecast" } },
        target: 55, horizonWeeks: 12, dueAt: "2026-12-18",
        baseline: { ...cell(38, null, 310), date: "2026-09-25", roundId: "round_b" }, latest: { ...cell(44, null, 310), date: "2026-10-12", roundId: "round_w" },
      },
      {
        metricId: "M-01S", name: "品类问题可见率", unit: "percent", pool: "all",
        tiers: { "1": { target: 9, written: 7, horizonWeeks: 8, placements: null, budgetCny: null, dataType: "forecast" }, "2": { target: 12, written: 7, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" }, "3": { target: 20, written: 7, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" } },
        target: 12, horizonWeeks: 12, dueAt: "2026-12-18",
        baseline: { ...cell(7, 12, 164), date: "2026-09-25", roundId: "round_b" }, latest: { ...cell(21, 65, 310), date: "2026-10-12", roundId: "round_w" },
      },
      {
        metricId: "M-06", name: "事实准确率", unit: "percent", pool: "all",
        tiers: { "1": { target: 98, written: 62, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" }, "2": { target: 98, written: 62, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" }, "3": { target: 98, written: 62, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" } },
        target: 98, horizonWeeks: 12, dueAt: "2026-12-18",
        baseline: { ...cell(62, 34, 55), date: "2026-09-25", roundId: "round_b" }, latest: { ...cell(88, 270, 310), date: "2026-10-12", roundId: "round_w" },
      },
      {
        metricId: "M-01", name: "品牌提及率", unit: "percent", pool: "P2",
        tiers: { "1": { target: 28, written: 21, horizonWeeks: 8, placements: null, budgetCny: null, dataType: "forecast" }, "2": { target: 35, written: 21, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" }, "3": { target: 40, written: 21, horizonWeeks: 12, placements: null, budgetCny: null, dataType: "forecast" } },
        target: 35, horizonWeeks: 12, dueAt: "2026-12-18",
        baseline: { ...cell(21, 20, 96), date: "2026-09-25", roundId: "round_b" }, latest: null,
      },
    ],
  },
  tiers: [
    { tier: "1", chosen: false, name: "档一：讲准为先", summary: "先把说错的按住，再谈被提到。", buys: "6 个覆盖位次 + 8 篇稿件", notPromised: ["不承诺 Kimi 提及上升"], contentUnits: 8, placements: 12, budgetCny: 3000, targetCount: 2 },
    { tier: "2", chosen: true, name: "讲准 + 进入被提及", summary: "主战场四组一起推。", buys: "12 个位次 + 16 篇稿件", notPromised: ["不承诺 P3 泛症状池被提及", "不承诺豆包任何变化（未测）"], contentUnits: 16, placements: 24, budgetCny: 8000, targetCount: 4 },
    { tier: "3", chosen: false, name: "全面铺开", summary: "覆盖次要战场。", buys: "25 个位次 + 30 篇稿件", notPromised: [], contentUnits: 30, placements: 40, budgetCny: 15000, targetCount: 2 },
  ],
  battlefield: {
    id: "bf_1",
    name: "说明书级事实讲准",
    why: ["证据最硬、竞品最弱：品牌身份组事实准确率 36%（4/11）。", "检索触发率的 Wilson 下限都在 71% 以上，内容位能改变回答。"],
    action: "先写事实与安全稿，再补纠错稿。",
    reason: "证据最硬、竞品最弱。",
    groups: [{ id: "gq_1", name: "恶心呕吐与胃肠反应" }, { id: null, name: "说明书安全题组" }],
    secondary: [{ id: "bf_2", name: "停药与反弹", why: ["提及率 6%（1/16），可动但证据偏弱。"], action: null, groups: [{ id: "gq_2", name: "停药后体重反弹" }] }],
  },
  noGo: [{ item: "泛症状池的抢排名", reason: "品牌不在检索结果里，写了也不会被引" }],
  engines: [
    { engine: "deepseek", retrieval: { ...cell(96, 60, 62), reason: null }, promise: "进入引用：锚点层 + 覆盖层", ceiling: "mention_and_accuracy", ceilingBasis: "Wilson 下限 85%", evidence: "检索触发率 96%（60/62）", layers: ["anchor", "coverage"], cites: [], leverage: "重点投入", clusterLeverage: [], layout: { account: "认证自有公众号", state: "还没有", evidence: "元宝把公众号当第一信源" } },
    { engine: "kimi", retrieval: { ...cell(10, 6, 60), reason: null }, promise: "只承诺讲对", ceiling: "accuracy_only", ceilingBasis: "Wilson 下限 2%", evidence: null, layers: ["owned"], cites: [], leverage: "维持", clusterLeverage: [], layout: null },
    { engine: "baidu", retrieval: { ...cell(null, null, null), status: "absent", reason: null }, promise: "只承诺收录", ceiling: null, ceilingBasis: null, evidence: null, layers: [], cites: [], leverage: null, clusterLeverage: [], layout: null },
  ],
  layout: {
    layers: { anchor: ["dxy.com"], coverage: ["39.net"], owned: ["mp.weixin.qq.com"] },
    constraints: [],
    clientActions: [
      { key: "client:0a1b2c3d", text: "开通并认证自有微信公众号", done: false },
      { key: "client:4e5f6a7b", text: "提供说明书最新版 PDF", done: true },
    ],
  },
  assumptions: [
    { field: "tier", value: 2, basis: "default", reason: "没有指定档位，三档都给出，默认按档二执行", howToChange: "在方案里选一档" },
    { field: "engine_scope", value: ["deepseek", "kimi"], basis: "upstream", reason: "豆包没有有效回答，本周期只写“未测”", howToChange: "补测豆包后并回目标" },
  ],
  gaps: { total: 20, withoutAction: 2 },
  actions: { total: 18, byStatus: { proposed: 10, writing: 4, live: 2, cited: 2 } },
};
