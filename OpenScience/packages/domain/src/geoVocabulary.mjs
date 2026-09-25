/**
 * 「循证 GEO」's closed vocabularies (build spec 2026-09-25 §2, §4).
 *
 * Hidden knowledge:
 *
 * - **One list per word, read by everyone.** The control plane's schema CHECKs,
 *   the routes' validation, the runtime gateway's per-item checks, the MCP
 *   tools' schemas and the page's labels all derive from these arrays; the
 *   measurement, market and orchestration packages import them rather than
 *   restating them. A second copy is the one that drifts, and the drift shows
 *   up as a round nobody can filter or an order state the ledger refuses.
 * - **The words are the owner's geo-skills vocabulary** (P1–P4, S0–S4, the four
 *   failure modes, anchor/coverage/owned, the five data types). The metric ids
 *   `M-01` … are the owner's `metrics.yaml` ids; `GVI`, `NET` and `NOISE` are
 *   the ids this platform gives the three computed rows that yaml names but
 *   does not number (the composite index, the net effect, the noise band). The
 *   metrics package owns the computation; the ids live here so the overview,
 *   the measurement worker and the page agree on which row is which.
 * - **Engines are the probe host's tab names** (`geoProbeGateway.mjs`), plus
 *   `wenxin`, which is measured only through the vendor's inclusion channel
 *   until the probe host has a Baidu tab (spec §7.4).
 * - Labels are UI text (Simplified Chinese); ids never reach a reader.
 *
 * @module @evimed/domain/geoVocabulary
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/** The four question pools, in display order. */
export const GEO_POOLS = frozen(['P1', 'P2', 'P3', 'P4'])
export const GEO_POOL_LABELS_ZH = Object.freeze({ P1: '品牌明确类', P2: '通用名与品类类', P3: '泛症状场景类', P4: '风险监测类' })

/** Every engine the platform can measure. */
export const GEO_ENGINES = frozen(['doubao', 'qianwen', 'deepseek', 'yuanbao', 'kimi', 'wenxin'])
/** The five a new project measures unless told otherwise (`OPEN_SCIENCE_GEO_ENGINES`). */
export const GEO_DEFAULT_ENGINES = frozen(['doubao', 'qianwen', 'deepseek', 'yuanbao', 'kimi'])
export const GEO_ENGINE_LABELS_ZH = Object.freeze({
  doubao: '豆包', qianwen: '千问', deepseek: 'DeepSeek', yuanbao: '元宝', kimi: 'Kimi', wenxin: '文心',
})

/** The eight steps of a program (`projects.steps` keys), in order. */
export const GEO_STEPS = frozen(['evidence', 'journey', 'questions', 'diagnosis', 'sources', 'content', 'distribution', 'monitoring'])
export const GEO_STEP_LABELS_ZH = Object.freeze({
  evidence: '证据', journey: '旅程', questions: '问题', diagnosis: '诊断', sources: '信源', content: '内容', distribution: '投放', monitoring: '监测',
})
export const GEO_STEP_STATUSES = frozen(['none', 'queued', 'running', 'done', 'minimal', 'failed'])

export const GEO_PROJECT_STATUSES = frozen(['active', 'paused', 'archived'])
/** The three target tiers (档一 / 档二 / 档三); a project's chosen tier defaults to 2. */
export const GEO_TIERS = frozen(['1', '2', '3'])
/** The coverage periods the new-project control offers, in days (the column accepts any whole number in range). */
export const GEO_COVERAGE_DAY_OPTIONS = Object.freeze([30, 60, 90, 180])
export const GEO_COVERAGE_DAYS_MIN = 7
export const GEO_COVERAGE_DAYS_MAX = 365

/** Product identity (`projects.product`). */
export const GEO_RX_CLASSES = frozen(['rx', 'otc'])
export const GEO_IDENTITY_STATUSES = frozen(['confirmed', 'ambiguous', 'unknown'])

/** Claims (主张库). */
export const GEO_CLAIM_SOURCE_KINDS = frozen(['label', 'guideline', 'trial', 'review', 'literature', 'regulator', 'other'])
export const GEO_CLAIM_STATUSES = frozen(['active', 'expired', 'retired'])

/** Question map. */
export const GEO_QUESTION_KINDS = frozen(['typical', 'real', 'label_safety', 'client'])
export const GEO_AUDIENCES = frozen(['patient', 'physician'])
export const GEO_GROUP_SIGNALS = frozen(['collected', 'partial', 'no_signal', 'client'])

/** Where a real phrasing was heard: a social platform, the open web, the client's own list. */
export const GEO_QUESTION_PLATFORMS = frozen(['xhs', 'douyin', 'zhihu', 'weibo', 'bilibili', 'wechat_channels', 'web', 'client', 'other'])

/** The seven gap classes of 预期匹配 (plan §3.5, after HealthGEO's answer-gap classes). */
export const GEO_GAP_CLASSES = frozen(['missing_evidence', 'dropped_condition', 'outdated', 'weak_source', 'benefit_only', 'wrong', 'audience_mismatch'])
export const GEO_GAP_CLASS_LABELS_ZH = Object.freeze({
  missing_evidence: '缺证据', dropped_condition: '丢条件', outdated: '过时', weak_source: '信源弱', benefit_only: '只讲获益不讲安全',
  wrong: '讲错', audience_mismatch: '受众看不懂',
})

/** Measurement. */
export const GEO_ROUND_KINDS = frozen(['baseline', 'weekly', 'sentinel', 'post_publication', 'confirm', 'noise', 'single_step'])
export const GEO_ROUND_KIND_LABELS_ZH = Object.freeze({
  baseline: '基线测量', weekly: '每周复测', sentinel: '哨兵测量', post_publication: '投后加测', confirm: '错误确认', noise: '噪声测定', single_step: '单项测量',
})
export const GEO_ROUND_STATUSES = frozen(['queued', 'running', 'done', 'partial', 'cancelled'])
export const GEO_PROBE_JOB_STATUSES = frozen(['queued', 'leased', 'done', 'failed', 'skipped'])
export const GEO_SNAPSHOT_STATUSES = frozen(['valid', 'suspect', 'refusal', 'failed'])
export const GEO_STATEMENT_VERDICTS = frozen(['correct', 'wrong', 'unverifiable'])
/** The four failure modes (漏提我方 / 讲对我方 / 讲错我方 / 讲错竞品), and `none` for an answer with nothing about us. */
export const GEO_FAILURE_MODES = frozen(['omitted', 'correct', 'wrong_ours', 'wrong_competitor', 'none'])
export const GEO_FAILURE_MODE_LABELS_ZH = Object.freeze({
  omitted: '漏提我方', correct: '讲对我方', wrong_ours: '讲错我方', wrong_competitor: '讲错竞品', none: '未涉及',
})

/** Errors (讲错我方) and their trace. */
export const GEO_ERROR_TYPES = frozen(['label_conflict', 'number', 'dropped_condition', 'unfounded', 'attribute_swap'])
export const GEO_ERROR_TYPE_LABELS_ZH = Object.freeze({
  label_conflict: '与说明书冲突', number: '数字不符', dropped_condition: '丢了限定条件', unfounded: '无据', attribute_swap: '张冠李戴',
})
/** Severity, after medication-error grading: S2 needs monitoring or intervention, S3 temporary harm, S4 permanent harm or life-threatening. */
export const GEO_SEVERITIES = frozen(['S0', 'S1', 'S2', 'S3', 'S4'])
/** Severities that notify at once. */
export const GEO_URGENT_SEVERITIES = frozen(['S3', 'S4'])
export const GEO_ERROR_STABILITIES = frozen(['stable', 'sporadic', 'unconfirmed'])
export const GEO_ERROR_ACTIONS = frozen(['own_edit', 'correction_letter', 'encyclopedia_fix', 'report_and_cover', 'no_contact', 'continuous_supply'])
export const GEO_ERROR_STATUSES = frozen(['open', 'acting', 'awaiting_remeasure', 'closed'])
/** What the source an error was cited from is to us. */
export const GEO_SOURCE_ATTRIBUTES = frozen(['owned', 'partner', 'encyclopedia', 'farm', 'impostor', 'none'])

/** Metrics rows. */
export const GEO_METRIC_SCOPES = frozen(['project', 'pool', 'engine', 'pool_engine', 'group', 'arm'])
export const GEO_ARMS = frozen(['pilot', 'control'])
/** A number cell's state: `insufficient` under 30 valid answers (「样本不足」), `absent` not measured (「未测」), never zero. */
export const GEO_CELL_STATUSES = frozen(['ok', 'insufficient', 'not_measurable', 'absent'])
/** The five data types, never mixed. */
export const GEO_DATA_TYPES = frozen(['measured', 'client_provided', 'derived', 'forecast', 'commercial'])
/** What a target row may be: a target is never a measurement. */
export const GEO_TARGET_DATA_TYPES = frozen(['forecast', 'commercial'])

/**
 * The metric ids the platform's own views read. `M-*` are the owner's
 * `metrics.yaml` ids; the three others number what that yaml defines without an
 * id. `mentionHeadline` is M-01S — mention over P2 and P3 only, the home row's
 * and the overview's 品牌提及率 (a branded question naming us is no signal).
 */
export const GEO_METRIC_IDS = Object.freeze({
  gvi: 'GVI',
  mention: 'M-01',
  mentionHeadline: 'M-01S',
  accuracy: 'M-06',
  citation: 'M-08',
  retrieval: 'M-10',
  netEffect: 'NET',
  noiseBand: 'NOISE',
})
/** The overview's four blocks, in order, and the metric each reads. */
export const GEO_OVERVIEW_METRICS = Object.freeze([
  Object.freeze({ key: 'gvi', metricId: GEO_METRIC_IDS.gvi }),
  Object.freeze({ key: 'mention', metricId: GEO_METRIC_IDS.mentionHeadline }),
  Object.freeze({ key: 'accuracy', metricId: GEO_METRIC_IDS.accuracy }),
  Object.freeze({ key: 'citation', metricId: GEO_METRIC_IDS.citation }),
])
/** The metric the pilot and control lines of 监测 are drawn with. */
export const GEO_ARM_METRIC_ID = GEO_METRIC_IDS.mention
/** The minimum valid answers behind a rate (团体标准: every smallest cell ≥ 30). */
export const GEO_MIN_CELL_SAMPLES = 30
export const GEO_METRIC_LABELS_ZH = Object.freeze({
  GVI: '综合可见度指数', 'M-01': '品牌提及率', 'M-01S': '品牌提及率', 'M-06': '事实准确率', 'M-08': '引用命中率', 'M-10': '检索触发率',
  NET: '净效应', NOISE: '噪声区间',
})

/** Sources (信源). `kind` is checked in code, not by CHECK, so a kind is added without a migration. */
export const GEO_SOURCE_KINDS = frozen(['news', 'vertical', 'wemedia', 'brand', 'government', 'encyclopedia', 'academic', 'qa', 'video', 'ecommerce', 'other'])
export const GEO_SOURCE_KIND_LABELS_ZH = Object.freeze({
  news: '新闻', vertical: '垂直门户', wemedia: '自媒体', brand: '品牌官网', government: '政府', encyclopedia: '百科',
  academic: '学会与期刊', qa: '问答社区', video: '视频平台', ecommerce: '电商', other: '其他',
})
export const GEO_SOURCE_LAYERS = frozen(['anchor', 'coverage', 'owned'])
export const GEO_SOURCE_LAYER_LABELS_ZH = Object.freeze({ anchor: '锚点层', coverage: '覆盖层', owned: '自有层' })

/** Articles (内容). */
export const GEO_ARTICLE_LAYERS = frozen(['deep', 'card', 'popular', 'qa', 'correction'])
export const GEO_ARTICLE_LAYER_LABELS_ZH = Object.freeze({ deep: '深度分析', card: '证据卡片', popular: '科普稿件', qa: '问答', correction: '纠错材料' })
export const GEO_ARTICLE_GATES = frozen(['passed', 'unverified', 'failed'])
/** `open` is the safety stop: an unresolved clinical-safety finding; `released` is a person having looked (「放行」). */
export const GEO_ARTICLE_SAFETY = frozen(['clear', 'open', 'released'])
export const GEO_ARTICLE_STATUSES = frozen(['draft', 'publishable', 'placed', 'published', 'withdrawn'])

/** Media marketplace. */
export const GEO_MEDIA_TYPES = frozen(['website', 'wemedia'])
export const GEO_ORDER_STATES = frozen(['planned', 'reserved', 'submitted', 'accepted', 'published', 'verified', 'settled', 'unknown',
  'rejected', 'cancelled', 'refunded', 'problem', 'lost'])
/** States an order may still be cancelled from (撤单 is offered only before the outlet accepts). */
export const GEO_ORDER_CANCELLABLE_STATES = frozen(['planned', 'reserved', 'submitted'])
/** States that hold money reserved against a budget. */
export const GEO_ORDER_OPEN_STATES = frozen(['reserved', 'submitted', 'accepted', 'published', 'verified', 'unknown', 'problem'])
export const GEO_LEDGER_KINDS = frozen(['budget_set', 'reserve', 'release', 'settle', 'refund', 'topup_request', 'topup_confirmed', 'adjustment'])
export const GEO_TOPUP_STATUSES = frozen(['requested', 'confirmed', 'cancelled'])
export const GEO_RECONCILIATION_STATUSES = frozen(['ok', 'mismatch'])

/** The social channel (six platforms, two sorts, four collection states). */
export const GEO_SOCIAL_PLATFORMS = frozen(['xhs', 'douyin', 'zhihu', 'weibo', 'bilibili', 'wechat_channels'])
export const GEO_SOCIAL_PLATFORM_LABELS_ZH = Object.freeze({
  xhs: '小红书', douyin: '抖音', zhihu: '知乎', weibo: '微博', bilibili: '哔哩哔哩', wechat_channels: '微信视频号',
})
export const GEO_SOCIAL_SORTS = frozen(['hot', 'latest'])
/** `request_failed` is 「没采到」, `no_results` is 「采了，确实没有」 — opposite instructions downstream, never merged. */
export const GEO_SOCIAL_STATUSES = frozen(['collected', 'partial_collected', 'no_results', 'request_failed'])
/** UGC minimisation: the longest excerpt kept of a title, a body or a comment. */
export const GEO_SOCIAL_EXCERPT_MAX_CHARS = 200

/** The runtime tools' words (`geo_read` / `geo_write`, spec §4). */
export const GEO_READ_WHATS = frozen(['project', 'claims', 'questions', 'journey', 'diagnosis', 'metrics', 'snapshots', 'errors', 'sources',
  'strategy', 'targets', 'articles', 'orders', 'monitoring'])
export const GEO_WRITE_WHATS = frozen(['product', 'claims', 'questions', 'lock_questions', 'journey', 'strategy', 'sources', 'targets',
  'articles', 'placement_plan', 'step'])
/** How a read or a write narrates in the conversation (`narration.mjs`). */
export const GEO_READ_WHAT_LABELS_ZH = Object.freeze({
  project: '项目概况', claims: '主张库', questions: '问题地图', journey: '旅程', diagnosis: '诊断', metrics: '指标', snapshots: '回答快照',
  errors: '讲错记录', sources: '信源', strategy: '信源布局', targets: '三档目标', articles: '稿件', orders: '投放订单', monitoring: '监测',
})
export const GEO_WRITE_WHAT_LABELS_ZH = Object.freeze({
  product: '产品身份', claims: '主张库', questions: '问题地图', lock_questions: '锁定测量问句', journey: '旅程', strategy: '信源分析',
  sources: '信源表', targets: '三档目标', articles: '稿件', placement_plan: '投放偏好', step: '进度',
})
/** The export runs 「⋯」 offers. */
export const GEO_EXPORT_KINDS = frozen(['weekly', 'proposal'])

/**
 * Whether an article may be placed: its gate passed and no clinical-safety
 * finding is open on it (a released one has been looked at by a person). The
 * one rule the content store, the orchestrator and the market all apply.
 * @param {{ gate?: string | null, safety?: string | null }} article
 */
export function geoArticlePublishable(article) {
  return article?.gate === 'passed' && (article?.safety === 'clear' || article?.safety === 'released')
}

/** @param {string} vocabulary @param {unknown} value */
export function isGeoValue(vocabulary, value) {
  const list = /** @type {Record<string, readonly string[]>} */ (GEO_VOCABULARIES)[vocabulary]
  return Array.isArray(list) && typeof value === 'string' && list.includes(value)
}

/** Every closed vocabulary by name, for a caller that validates generically. */
export const GEO_VOCABULARIES = Object.freeze({
  pool: GEO_POOLS,
  engine: GEO_ENGINES,
  step: GEO_STEPS,
  stepStatus: GEO_STEP_STATUSES,
  projectStatus: GEO_PROJECT_STATUSES,
  tier: GEO_TIERS,
  rx: GEO_RX_CLASSES,
  identityStatus: GEO_IDENTITY_STATUSES,
  claimSourceKind: GEO_CLAIM_SOURCE_KINDS,
  claimStatus: GEO_CLAIM_STATUSES,
  questionKind: GEO_QUESTION_KINDS,
  questionPlatform: GEO_QUESTION_PLATFORMS,
  gapClass: GEO_GAP_CLASSES,
  audience: GEO_AUDIENCES,
  groupSignal: GEO_GROUP_SIGNALS,
  roundKind: GEO_ROUND_KINDS,
  roundStatus: GEO_ROUND_STATUSES,
  probeJobStatus: GEO_PROBE_JOB_STATUSES,
  snapshotStatus: GEO_SNAPSHOT_STATUSES,
  statementVerdict: GEO_STATEMENT_VERDICTS,
  failureMode: GEO_FAILURE_MODES,
  errorType: GEO_ERROR_TYPES,
  severity: GEO_SEVERITIES,
  errorStability: GEO_ERROR_STABILITIES,
  errorAction: GEO_ERROR_ACTIONS,
  errorStatus: GEO_ERROR_STATUSES,
  sourceAttribute: GEO_SOURCE_ATTRIBUTES,
  metricScope: GEO_METRIC_SCOPES,
  arm: GEO_ARMS,
  cellStatus: GEO_CELL_STATUSES,
  dataType: GEO_DATA_TYPES,
  targetDataType: GEO_TARGET_DATA_TYPES,
  sourceKind: GEO_SOURCE_KINDS,
  sourceLayer: GEO_SOURCE_LAYERS,
  articleLayer: GEO_ARTICLE_LAYERS,
  articleGate: GEO_ARTICLE_GATES,
  articleSafety: GEO_ARTICLE_SAFETY,
  articleStatus: GEO_ARTICLE_STATUSES,
  mediaType: GEO_MEDIA_TYPES,
  orderState: GEO_ORDER_STATES,
  ledgerKind: GEO_LEDGER_KINDS,
  topupStatus: GEO_TOPUP_STATUSES,
  reconciliationStatus: GEO_RECONCILIATION_STATUSES,
  socialPlatform: GEO_SOCIAL_PLATFORMS,
  socialSort: GEO_SOCIAL_SORTS,
  socialStatus: GEO_SOCIAL_STATUSES,
  readWhat: GEO_READ_WHATS,
  writeWhat: GEO_WRITE_WHATS,
  exportKind: GEO_EXPORT_KINDS,
})
