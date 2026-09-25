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
  GeoEvidence,
  GeoJourney,
  GeoMonitoring,
  GeoProject,
  GeoQuestions,
  GeoSources,
  GeoStepKey,
  GeoStepStatus,
} from "@/lib/geoClient";

export function cell(value: number | null, numerator: number | null, denominator: number | null, extra: Partial<GeoCell> = {}): GeoCell {
  const status = value === null ? "not_measurable" : denominator !== null && denominator < 30 ? "insufficient" : "ok";
  return { value, numerator, denominator, ciLow: null, ciHigh: null, status, dataType: "measured", ...extra };
}

export function geoProject(steps: Partial<Record<GeoStepKey, GeoStepStatus>> = {}, overrides: Partial<GeoProject> = {}): GeoProject {
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
    steps: Object.fromEntries(Object.entries(steps).map(([key, status]) => [key, { status, requested: true }])),
    sessionId: "ses_geo_1",
    overview: {
      metrics: [
        { key: "gvi", cell: cell(38, null, 310), target: 55, trend: [] },
        { key: "mention", cell: cell(21, 65, 310), target: 35, trend: [] },
      ],
      week: [],
      steps: {},
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
        { id: "q_1", text: "打了减重针一直恶心，要不要停药？", kind: "typical", platform: null, sourceUrl: null, isMeasured: true },
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
        { id: "q_4", text: "停药后体重会反弹吗？", kind: "typical", platform: null, sourceUrl: null, isMeasured: true },
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
    },
  ],
  noise: { band: 3, measuredAt: "2026-09-23" },
  more: [{ metricId: "M-02", name: "首位提及率", cell: cell(9, 28, 310) }],
};

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
    { id: "src_2", domain: "baike.baidu.com", name: "百度百科", kind: "百科", layer: null, conditions: { icp: true, newsIndexed: false, medical: null }, impostor: false, cited: { deepseek: 33 }, mentionsOurs: 2, wrongOurs: 1, market: null },
    { id: "src_3", domain: "39.net", name: "39 健康网", kind: "health_media", layer: "coverage", conditions: { icp: true, newsIndexed: true, medical: true }, impostor: false, cited: { doubao: 21 }, mentionsOurs: 0, wrongOurs: 0, market: { price: 120, resourceId: "r1" } },
    { id: "src_4", domain: "fake-times.example", name: "某某时报网", kind: "news", layer: null, conditions: { icp: false, newsIndexed: false, medical: false }, impostor: true, cited: { doubao: 4 }, mentionsOurs: 0, wrongOurs: 0, market: null },
  ],
  expectations: [
    { engine: "deepseek", retrieval: cell(96, 60, 62), promise: "进入引用：锚点层 + 覆盖层", layers: ["anchor", "coverage"] },
    { engine: "baidu", retrieval: cell(null, null, null), promise: "只承诺讲对", layers: ["owned"] },
  ],
  battlefield: { groups: ["恶心呕吐与胃肠反应"], reason: "证据最硬、竞品最弱。" },
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
    { articleId: "art_1", title: "打了减重针一直恶心，要不要停药？", engine: "doubao", firstSeen: "2026-10-13" },
    { articleId: "art_1", title: "打了减重针一直恶心，要不要停药？", engine: "yuanbao", firstSeen: "2026-10-14" },
  ],
  newErrors: [diagnosisFilled.errors[0]],
  next: { date: "2026-10-20", kind: "weekly" },
};
