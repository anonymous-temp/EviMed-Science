/**
 * Fixtures for the question group as the spine (R19): the clusters, the actions and one group in full, in the shapes of
 * `r19-geos.md` §1 (verified live; the real captures are under `.evimed-local/acceptance/.../live/r19-geos/`). Compact on purpose:
 * three engines, four groups — one of them a control group — and five actions that between them hold every status, kind and
 * source route the page draws.
 *
 *   g_brand   P1  品牌身份、规格与厂家     thin reading 11/12, one engine misstated us; a correct_error action, proposed
 *   g_effect  P2  效果怎么样、要打多久     thin reading 0/12; a fill_gap action being written + a win_cluster one set aside
 *   g_safety  P4  说明书安全题组           reading of 36 answers (a rate exists); a fill_gap action published, at its target
 *   g_ctl     P2  对照一                   control group, one article already written for it
 *   (project) a gap that names no group; its source is the brand's own channel
 */
import type {
  GeoAction,
  GeoActionSource,
  GeoActionsView,
  GeoClusterRow,
  GeoClusterView,
  GeoClustersView,
  GeoEngine,
  GeoQuestionGroup,
  GeoQuestions,
} from "@/lib/geoClient";

export const SPINE_ENGINES: GeoEngine[] = ["doubao", "qianwen", "deepseek"];

export const G_BRAND = "ggr_brand";
export const G_EFFECT = "ggr_effect";
export const G_SAFETY = "ggr_safety";
export const G_CONTROL = "ggr_ctl";

const tally = (answered: number, mentioned: number, wrong = 0) => ({ answered, mentioned, wrong });

export function clusterRow(overrides: Partial<GeoClusterRow> & Pick<GeoClusterRow, "id" | "name">): GeoClusterRow {
  return {
    pool: "P1",
    journeyStage: "认知与选药",
    journeyStageNo: 1,
    audience: "patient",
    weight: 0.06,
    isControl: false,
    signal: null,
    questionCount: 4,
    measuredCount: 4,
    realCount: 0,
    realPhrasings: [],
    mention: null,
    byEngine: {},
    errors: { open: 0, severe: 0, total: 0 },
    actions: { total: 0, byStatus: {} },
    articles: { total: 0, byStatus: {} },
    ...overrides,
  };
}

export const clustersFilled: GeoClustersView = {
  version: 1,
  locked: true,
  floor: 30,
  round: { id: "gr_1", kind: "weekly", sampleDate: "2026-10-19" },
  engines: SPINE_ENGINES,
  groups: [
    clusterRow({
      id: G_BRAND,
      name: "P1-01 品牌身份、规格与厂家",
      mention: { k: 11, n: 12, state: "thin", metricId: "M-01", roundId: "gr_1", date: "2026-10-19" },
      byEngine: { doubao: tally(4, 4), qianwen: tally(4, 4), deepseek: tally(4, 3, 1) },
      errors: { open: 2, severe: 2, total: 2 },
      actions: { total: 1, byStatus: { proposed: 1 } },
    }),
    clusterRow({
      id: G_EFFECT,
      name: "P2-04 效果怎么样、要打多久",
      pool: "P2",
      journeyStage: "疗效评估",
      journeyStageNo: 2,
      weight: 0.08,
      realCount: 2,
      mention: { k: 0, n: 12, state: "thin", metricId: "M-01", roundId: "gr_1", date: "2026-10-19" },
      byEngine: { doubao: tally(4, 0), qianwen: tally(4, 0), deepseek: tally(4, 0) },
      actions: { total: 2, byStatus: { writing: 1, skipped: 1 } },
      articles: { total: 1, byStatus: { draft: 1 } },
    }),
    clusterRow({
      id: G_SAFETY,
      name: "P4-04 说明书安全题组",
      pool: "P4",
      journeyStage: "用药安全",
      journeyStageNo: null,
      weight: 0.1,
      questionCount: 12,
      measuredCount: 12,
      mention: { k: 21, n: 36, state: "enough", rate: 58.33, metricId: "M-01", roundId: "gr_1", date: "2026-10-19" },
      byEngine: { doubao: tally(12, 7), qianwen: tally(12, 7), deepseek: tally(12, 7) },
      actions: { total: 1, byStatus: { live: 1 } },
      articles: { total: 1, byStatus: { published: 1 } },
    }),
    clusterRow({
      id: G_CONTROL,
      name: "P2-09 对照一",
      pool: "P2",
      journeyStage: "疗效评估",
      journeyStageNo: 2,
      weight: 0.04,
      isControl: true,
      byEngine: { doubao: tally(4, 1), qianwen: tally(4, 2), deepseek: tally(4, 0) },
      articles: { total: 1, byStatus: { draft: 1 } },
    }),
  ],
};

function source(overrides: Partial<GeoActionSource> & Pick<GeoActionSource, "domain">): GeoActionSource {
  return {
    channel: null,
    name: null,
    kind: null,
    layer: null,
    why: null,
    citedFor: {},
    conditions: {},
    price: null,
    available: null,
    unavailableBecause: [],
    route: "waiting_market",
    origin: "cited",
    chosen: "recommended",
    orderId: null,
    articleIds: [],
    ...overrides,
  };
}

const SOURCES_BRAND: GeoActionSource[] = [
  source({
    domain: "dxy.cn",
    name: "丁香园",
    kind: "vertical",
    layer: "anchor",
    why: "医疗垂直站，规格与厂家口径的规范文本落点",
    citedFor: { deepseek: 2 },
    conditions: { icp: true, newsIndexed: true, medical: true },
  }),
  source({ domain: "haodf.com", name: "好大夫在线", kind: "vertical", layer: "anchor", citedFor: { doubao: 1 }, conditions: { icp: null, newsIndexed: null, medical: true } }),
  source({ domain: "jiankang.cn", name: "都市健康", kind: "other", layer: "coverage", available: false, unavailableBecause: ["refuses_medical"] }),
];

export function actionFixture(overrides: Partial<GeoAction> & Pick<GeoAction, "key" | "kind">): GeoAction {
  return {
    group: null,
    questions: [],
    need: { gapId: null, gapClass: null, errorIds: [], judgment: null, evidence: [], expectedPoints: [], rank: null, consequence: null, safetyPinned: false, handoff: "content" },
    what: { layer: null, title: null, channel: null, channelNote: null },
    engines: SPINE_ENGINES,
    sources: [],
    expected: {
      metricIds: ["M-01"],
      primaryMetricId: "M-01",
      promise: "enter_mention",
      from: null,
      baseline: null,
      target: null,
      reached: null,
      dataType: "forecast",
      horizonWeeks: 12,
      tier: "2",
      basis: { tier: "2", metricId: "M-01", pool: "P2", targetsVersion: 3, source: "targets", note: null },
      closes: { errors: 0, points: 0 },
    },
    status: "proposed",
    articleIds: [],
    orderIds: [],
    ownedLinkIds: [],
    observed: { citedBy: [], series: [], arm: null },
    choice: null,
    checks: [],
    reason: null,
    rank: null,
    ...overrides,
  };
}

const groupOf = (id: string, name: string, pool: "P1" | "P2" | "P4", stage: string, stageNo: number | null, weight: number) => ({
  id, name, pool, journeyStage: stage, journeyStageNo: stageNo, weight, isControl: false as const,
});

export const ACTION_BRAND = actionFixture({
  key: `correct_error:${G_BRAND}:wrong`,
  kind: "correct_error",
  group: groupOf(G_BRAND, "品牌身份、规格与厂家", "P1", "认知与选药", 1, 0.06),
  questions: [{ id: "q_brand_1", text: "信尔美是什么药？" }, { id: "q_brand_2", text: "信尔美是哪家公司生产的？" }],
  need: {
    gapId: "gap-1",
    gapClass: "wrong",
    errorIds: ["err_1", "err_2"],
    judgment: "三个引擎里有一个把用法说成每天注射一次，说明书写的是每周一次。",
    evidence: [
      { kind: "error", errorId: "err_1", engine: "deepseek", severity: "S3", statement: "把信尔美说成需要每天注射一次", status: "open" },
      { kind: "error", errorId: "err_2", engine: "doubao", severity: "S3", statement: "把信尔美说成需要每天注射一次", status: "open" },
    ],
    expectedPoints: [{ id: "pt-dosing", kind: "usage", statement: "信尔美为每周一次皮下注射给药。", claimIds: ["clm_dosing"] }],
    rank: 1,
    consequence: { band: "band1", basis: "给药频次说错会直接改变用药行为，按最高后果档处理。" },
    safetyPinned: true,
    handoff: "content",
  },
  what: { layer: "correction", title: "给药频次纠正稿：每周一次，不是每天", channel: "wechat_mp", channelNote: null },
  engines: ["deepseek", "doubao"],
  sources: SOURCES_BRAND,
  expected: {
    metricIds: ["M-06", "M-03"],
    primaryMetricId: "M-06",
    promise: "accuracy_to_target",
    from: { k: 11, n: 12, state: "thin", metricId: "M-06" },
    baseline: { k: 9, n: 12, state: "thin", metricId: "M-06" },
    target: 98,
    reached: null,
    dataType: "forecast",
    horizonWeeks: 12,
    tier: "2",
    basis: { tier: "2", metricId: "M-06", pool: "P1", targetsVersion: 3, source: "targets", note: "说明书已登记每周一次皮下注射。" },
    closes: { errors: 2, points: 1 },
  },
  rank: 1,
});

export const ACTION_EFFECT = actionFixture({
  key: `fill_gap:${G_EFFECT}:missing_evidence`,
  kind: "fill_gap",
  group: groupOf(G_EFFECT, "效果怎么样、要打多久", "P2", "疗效评估", 2, 0.08),
  questions: [{ id: "q_eff_1", text: "信尔美能减多少体重？" }],
  need: {
    gapId: "gap-2",
    gapClass: "missing_evidence",
    errorIds: [],
    judgment: "公开信源里没有一份把适应症与疗程口径写清楚的文本，引擎只能泛泛地答。",
    evidence: [],
    expectedPoints: [
      { id: "pt-indication", kind: "indication", statement: "本品适用于成人超重或肥胖的长期体重管理。", claimIds: ["clm_indication"] },
      { id: "pt-duration", kind: "duration", statement: "疗程由医生按个体情况评估。", claimIds: [] },
    ],
    rank: 2,
    consequence: { band: "band2", basis: "疗效与疗程是决策链中段最重的一问。" },
    safetyPinned: false,
    handoff: "content",
  },
  what: { layer: "deep", title: "适应症与疗程说明稿", channel: "zhihu", channelNote: null },
  engines: ["qianwen", "deepseek"],
  sources: [
    source({ domain: "dxy.cn", name: "丁香园", kind: "vertical", layer: "anchor", why: "医疗垂直站，适合作适应症口径的落点", citedFor: { deepseek: 1, qianwen: 1 } }),
    source({ domain: "xywy.com", name: "寻医问药网", kind: "vertical", layer: "coverage", citedFor: { qianwen: 1 } }),
  ],
  expected: {
    metricIds: ["M-01", "M-02"],
    primaryMetricId: "M-01",
    promise: "enter_mention",
    from: { k: 0, n: 12, state: "thin", metricId: "M-01" },
    baseline: { k: 0, n: 12, state: "thin", metricId: "M-01" },
    target: 58,
    reached: null,
    dataType: "forecast",
    horizonWeeks: 12,
    tier: "2",
    basis: { tier: "2", metricId: "M-01", pool: "P2", targetsVersion: 3, source: "targets", note: null },
    closes: { errors: 0, points: 2 },
  },
  status: "writing",
  articleIds: ["art_effect"],
  rank: 2,
});

export const ACTION_EFFECT_SKIPPED = actionFixture({
  key: `win_cluster:${G_EFFECT}:M-01`,
  kind: "win_cluster",
  group: groupOf(G_EFFECT, "效果怎么样、要打多久", "P2", "疗效评估", 2, 0.08),
  sources: [source({ domain: "baike.baidu.com", name: "百度百科", kind: "encyclopedia", layer: "coverage" })],
  status: "skipped",
  choice: { skipped: true, sourceDomain: null, updatedAt: "2026-10-19T08:00:00.000Z" },
  rank: 5,
});

export const ACTION_SAFETY = actionFixture({
  key: `fill_gap:${G_SAFETY}:benefit_only`,
  kind: "fill_gap",
  group: groupOf(G_SAFETY, "说明书安全题组", "P4", "用药安全", null, 0.1),
  questions: [{ id: "q_safe_1", text: "哪些人不能用信尔美？" }],
  need: {
    gapId: "gap-3",
    gapClass: "benefit_only",
    errorIds: ["err_3"],
    judgment: "回答只讲获益不讲禁忌和必须就医的情形。",
    evidence: [{ kind: "error", errorId: "err_3", engine: "qianwen", severity: "S3", statement: "没有提到哺乳期不能用", status: "open" }],
    expectedPoints: [{ id: "pt-contra", kind: "contraindication", statement: "哺乳期不得使用；计划妊娠前停用。", claimIds: ["clm_contra"] }],
    rank: 3,
    consequence: null,
    safetyPinned: true,
    handoff: "content",
  },
  what: { layer: "popular", title: "禁忌与必须就医的情形", channel: "wechat_mp", channelNote: null },
  engines: ["qianwen"],
  sources: [
    source({
      domain: "kepuchina.cn",
      name: "科普中国",
      kind: "official",
      layer: "anchor",
      why: "官方科普平台",
      conditions: { icp: true, newsIndexed: true, medical: true },
      route: "market",
      available: true,
      price: 1200,
      chosen: "swapped",
    }),
    source({ domain: "dayi.org.cn", name: "大医", kind: "vertical", layer: "coverage", route: "market", available: true, price: 800 }),
  ],
  expected: {
    metricIds: ["M-11"],
    primaryMetricId: "M-11",
    promise: "coverage_complete",
    from: { k: 21, n: 36, state: "enough", rate: 58.33, metricId: "M-11" },
    baseline: { k: 12, n: 36, state: "enough", rate: 33.33, metricId: "M-11" },
    target: 58,
    reached: true,
    dataType: "forecast",
    horizonWeeks: 12,
    tier: "2",
    basis: { tier: "2", metricId: "M-11", pool: "P4", targetsVersion: 3, source: "targets", note: null },
    closes: { errors: 1, points: 1 },
  },
  status: "live",
  articleIds: ["art_safety"],
  orderIds: [],
  ownedLinkIds: ["lnk_1"],
  choice: { skipped: false, sourceDomain: "kepuchina.cn", updatedAt: "2026-10-19T08:00:00.000Z" },
  observed: {
    citedBy: [{ engine: "qianwen", questionId: "q_safe_1", askedAt: "2026-10-19T02:00:00.000Z", articleId: "art_safety" }],
    series: [
      { round: "gr_0", date: "2026-10-05", kind: "baseline", k: 12, n: 36, state: "enough", rate: 33.33 },
      { round: "gr_1", date: "2026-10-19", kind: "weekly", k: 21, n: 36, state: "enough", rate: 58.33 },
    ],
    arm: { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true, scope: "pool", pool: "P4" },
  },
  rank: 3,
});

export const ACTION_PROJECT = actionFixture({
  key: "fill_gap:-:gap-9",
  kind: "fill_gap",
  group: null,
  need: {
    gapId: "gap-9",
    gapClass: "weak_source",
    errorIds: [],
    judgment: "没有一个权威页面同时写清适应症、用法和禁忌。",
    evidence: [],
    expectedPoints: [],
    rank: 4,
    consequence: null,
    safetyPinned: false,
    handoff: "content",
  },
  what: { layer: "deep", title: "产品说明总稿", channel: "wechat_mp", channelNote: null },
  articleIds: ["art_project"],
  sources: [
    source({ domain: null, channel: "wechat_mp", name: "微信公众号", layer: "owned", route: "own", origin: "own_channel", available: true, articleIds: ["art_project"] }),
  ],
  expected: {
    metricIds: ["M-19", "M-01S"],
    primaryMetricId: "M-19",
    promise: "raise_mention",
    from: null,
    baseline: null,
    target: 55,
    reached: null,
    dataType: "forecast",
    horizonWeeks: 12,
    tier: "2",
    basis: { tier: "2", metricId: "M-19", pool: "all", targetsVersion: 3, source: "targets", note: null },
    closes: { errors: 0, points: 0 },
  },
  checks: [{ code: "group_unknown", group: "全项目" }],
  rank: 4,
});

export const actionsFilled: GeoActionsView = {
  version: 4,
  tier: "2",
  round: { id: "gr_1", kind: "weekly", sampleDate: "2026-10-19" },
  floor: 30,
  headline: {
    actedGroups: 1,
    gapGroupsNotActedOn: 2,
    arm: { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true },
    sentence: "已行动的问句群比对照多涨 4.2 个点（波动 ±3）；另有 2 个群的缺口还没有行动",
  },
  counts: {
    total: 5,
    byKind: { correct_error: 1, fill_gap: 3, win_cluster: 1 },
    byStatus: { proposed: 2, writing: 1, live: 1, skipped: 1 },
    gapsWithoutEntry: 0,
  },
  actions: [ACTION_BRAND, ACTION_EFFECT, ACTION_SAFETY, ACTION_PROJECT, ACTION_EFFECT_SKIPPED],
  control: [{ id: G_CONTROL, name: "对照一", pool: "P2", articles: 1 }],
  noAction: [],
  unmatched: [],
};

/** One group in full (`GET …/clusters/:groupId`): the questions each engine answered, the sites cited most, what is done, what came of it. */
export function clusterViewFixture(id: string = G_BRAND): GeoClusterView {
  const group = clustersFilled.groups.find((row) => row.id === id) ?? clustersFilled.groups[0];
  const answer = (engine: GeoEngine, snapshotId: string, mentionsOurs: boolean | null, wrongOurs: boolean | null = false) => ({
    engine, snapshotId, status: "valid", askedAt: "2026-10-19T02:00:00.000Z", mentionsOurs, wrongOurs, citesOurs: false,
  });
  return {
    group,
    questions: [
      {
        id: "q_brand_1", text: "信尔美是什么药？", kind: "typical", isMeasured: true, platform: null, sourceUrl: null, collectedAt: null,
        answers: [answer("doubao", "s_1", true), answer("qianwen", "s_2", true), answer("deepseek", "s_3", true, true)],
      },
      {
        id: "q_brand_2", text: "信尔美是哪家公司生产的？", kind: "real", isMeasured: true, platform: "zhihu", sourceUrl: null, collectedAt: null,
        answers: [answer("doubao", "s_4", true), answer("qianwen", "s_5", false)],
      },
      {
        id: "q_brand_phrase", text: "玛仕度肽和信尔美是一个药吗", kind: "real", isMeasured: false, platform: "xhs", sourceUrl: "https://example.org/p/1", collectedAt: null, answers: [],
      },
    ],
    sources: [
      {
        domain: "dxy.cn", name: "丁香园", kind: "vertical", layer: "anchor", cited: { total: 5, byEngine: { deepseek: 3, doubao: 2 } }, mentionsOurs: 4, wrongOurs: 1,
        conditions: { icp: true, newsIndexed: true, medical: true }, impostor: false, price: null,
      },
      {
        domain: "baike.baidu.com", name: "百度百科", kind: "encyclopedia", layer: "coverage", cited: { total: 2, byEngine: { qianwen: 2 } }, mentionsOurs: 1, wrongOurs: 0,
        conditions: null, impostor: false, price: null,
      },
    ],
    gaps: [
      {
        gapId: "gap-1", class: "wrong", judgment: "三个引擎里有一个把用法说成每天注射一次。", rank: 1, consequence: { band: "band1", basis: null }, evidence: null,
        expectedPoints: [{ pointId: "pt-dosing", kind: "usage", statement: "信尔美为每周一次皮下注射给药。", refs: [{ type: "claim", id: "clm_dosing" }] }],
        handoff: "content", safetyPinned: true,
      },
    ],
    claims: { clm_dosing: { id: "clm_dosing", statement: "每周一次皮下注射。", sourceLabel: "玛仕度肽注射液说明书", sourceKind: "label", status: "active" } },
    actions: id === G_BRAND ? [ACTION_BRAND] : id === G_EFFECT ? [ACTION_EFFECT, ACTION_EFFECT_SKIPPED] : id === G_SAFETY ? [ACTION_SAFETY] : [],
    articles: id === G_SAFETY
      ? [{ id: "art_safety", layer: "popular", title: "禁忌与必须就医的情形", status: "published", gate: "passed", safety: "clear", channel: "wechat_mp", channelNote: null, audience: null, audienceNote: null, path: "articles/safety.md", runId: "run_1" }]
      : [],
    orders: [],
    ownedLinks: id === G_SAFETY
      ? [{ id: "lnk_1", articleId: "art_safety", platform: "wechat_mp", url: "https://mp.weixin.qq.com/s/abc", title: "哪些人不能用信尔美", publishedAt: "2026-10-12T02:00:00.000Z", status: "active", citedBy: [{ engine: "qianwen", firstSeen: "2026-10-19T02:00:00.000Z" }] }]
      : [],
    errors: [],
    effect: {
      metricId: "M-01",
      series: [
        { round: "gr_0", date: "2026-10-05", kind: "baseline", k: 3, n: 12, state: "thin" },
        { round: "gr_1", date: "2026-10-12", kind: "weekly", k: 5, n: 12, state: "thin" },
        { round: "gr_2", date: "2026-10-19", kind: "weekly", k: 8, n: 12, state: "thin" },
      ],
      events: [
        { kind: "published", at: "2026-10-12T02:00:00.000Z", articleId: "art_safety" },
        { kind: "cited", at: "2026-10-19T02:00:00.000Z", articleId: "art_safety", engine: "qianwen" },
      ],
      arm: { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true, scope: "pool", pool: "P2" },
    },
  };
}

/** The latest question set (`GET …/questions`) of the same groups: what turns a question id into its group. */
export function questionSetFixture(): GeoQuestions {
  const group = (row: GeoClusterRow, questions: Array<{ id: string; text: string; kind?: "typical" | "real" | "label_safety" | "client"; platform?: string | null; measured?: boolean; answers?: Array<{ engine: GeoEngine; snapshotId: string }> }>): GeoQuestionGroup => ({
    id: row.id,
    pool: row.pool ?? "P1",
    name: row.name,
    typicalQuestion: questions[0]?.text ?? "",
    journeyStage: row.journeyStage,
    journeyStageNo: row.journeyStageNo,
    audience: "patient",
    weight: row.weight,
    isControl: row.isControl,
    signal: null,
    questions: questions.map((question) => ({
      id: question.id,
      text: question.text,
      kind: question.kind ?? "typical",
      platform: question.platform ?? null,
      sourceUrl: null,
      isMeasured: question.measured !== false,
      answers: question.answers,
    })),
  });
  const [brand, effect, safety, control] = clustersFilled.groups;
  return {
    sets: [{ version: 1, lockedAt: "2026-09-25T00:00:00.000Z", measuredCount: 8 }],
    version: 1,
    groups: [
      group(brand, [
        { id: "q_brand_1", text: "信尔美是什么药？", answers: [{ engine: "doubao", snapshotId: "s_1" }] },
        { id: "q_brand_2", text: "信尔美是哪家公司生产的？", kind: "real", platform: "zhihu", answers: [{ engine: "doubao", snapshotId: "s_4" }] },
        { id: "q_brand_phrase", text: "玛仕度肽和信尔美是一个药吗", kind: "real", platform: "xhs", measured: false },
      ]),
      group(effect, [
        { id: "q_eff_1", text: "信尔美能减多少体重？", answers: [{ engine: "doubao", snapshotId: "s_6" }] },
        { id: "q_eff_2", text: "信尔美要打多久才有效果？" },
      ]),
      group(safety, [{ id: "q_safe_1", text: "哪些人不能用信尔美？", answers: [{ engine: "qianwen", snapshotId: "s_7" }] }]),
      group(control, [{ id: "q_ctl_1", text: "肥胖的诊断标准是什么？" }]),
    ],
  };
}
