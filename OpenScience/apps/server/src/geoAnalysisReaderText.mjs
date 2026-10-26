/**
 * The words a person reads in an exported GEO analysis (CSV, XLSX, DOCX, PDF, HTML). The frozen analysis itself — selection
 * reference, analysis digest, data revision, method versions, every exact identity and code — stays in the export record
 * (`cover.analysis` of the frozen document, and the export's `source`); the document body carries labelled Chinese fields only
 * (2026-10-25: it printed the record's digests, raw state codes, English internal rules and canonical-JSON dumps). Codes a reader
 * has a word for are named; identifiers, digests and codes without a word are left out of the body, never shown raw.
 */
import {
  GEO_ARTICLE_CHANNEL_LABELS_ZH, GEO_ARTICLE_LAYER_LABELS_ZH, GEO_ENGINE_LABELS_ZH, GEO_ERROR_TYPE_LABELS_ZH, GEO_FAILURE_MODE_LABELS_ZH,
  GEO_METRIC_LABELS_ZH, GEO_OWNED_LINK_PLATFORM_LABELS_ZH, GEO_POOL_LABELS_ZH, GEO_ROUND_KIND_LABELS_ZH, GEO_SIGNAL_STATE_LABELS_ZH,
  GEO_SOURCE_KIND_LABELS_ZH, GEO_SOURCE_LAYER_LABELS_ZH, GEO_SOURCE_RELATIONSHIP_LABELS_ZH, GEO_STATEMENT_TOPIC_LABELS_ZH, GEO_STEP_LABELS_ZH,
} from "@evimed/domain";

/** @type {Record<string, string>} */
export const GEO_READER_STATE_ZH = Object.freeze({ known: "已知", insufficient: "样本不足", unknown: "未知", no_data: "无数据", not_applicable: "不适用",
  partial: "部分", unjudged: "未判定", absent: "未测" });

/** @type {Record<string, string>} */
const UNITS = { percent: "百分比", count: "计数", index: "指数", answers: "回答", observations: "观察", expressions: "表达", statements: "陈述", findings: "发现",
  articles: "稿件", article_formats: "稿件格式", source_pairs: "回答与页面配对", source_pages: "页面", rounds: "轮次", questions: "问题", publications: "发布",
  order_events: "订单事件", orders: "订单", ledger_entries: "账目", ledger_balance_readings: "余额读数", history_answer_refs: "样本关联",
  history_target_refs: "材料关联", frozen_metric_readings: "冻结读数", distinct_answered_questions: "取得回答的问题", claims: "结论", business_events: "业务事件",
  asks: "提问", CNY: "元", percentage_points: "百分点", rank: "排名", placements: "投放", weeks: "周", records: "记录", result_versions: "结果版本",
  error_records: "错误记录", finding_observations: "发现观察", statement_assessments: "陈述判定", target_rows: "目标", brand_mentions: "品牌提及",
  entity_mentions: "对象提及", citations: "引用", expected_flags: "预期标记", unique_domains: "网站", unique_statements: "陈述", derived_inputs: "派生读数",
  metric: "指标", context_objects: "关联记录", exact_versioned_groups: "问题群" };

/** @type {Record<string, string>} */
const REASONS = { answer_applicability_is_separate: "适用性另行判断", answer_not_returned: "没有取得回答", citations_without_links: "引用没有可测的链接",
  comparison_not_selected: "未选择对照区间", conversion_not_derivable: "不能推算转化", engine_absent: "该平台未测", event_has_no_material_of_this_kind: "该事件没有这类材料",
  event_not_metric: "事件不是指标读数", linked_not_verified: "已关联但未核实", no_red_flag_expectations: "没有设定红旗预期", no_sampling: "没有采样",
  no_snapshots: "没有回答", not_adjudicated: "尚未判定", not_mentioned: "未提及", not_planned: "未计划", not_recorded: "未记录", no_valid_answers: "没有有效回答",
  no_validated_applicability_assessment: "没有已核实的适用性判定", observed_records_are_not_a_plan: "观察记录不是计划", owned_not_registered: "未登记自有信源",
  plan_records_unavailable: "计划记录暂不可读", reading_not_event: "读数不是事件", recommendation_coverage_incomplete: "推荐覆盖不完整",
  rival_history_unknown: "竞品历史未知", sampling_plan_incomplete: "采样计划不完整", sampling_plan_unknown: "采样计划未知", sampling_scope_incomplete: "采样范围不完整",
  scheduled_context_not_observed: "计划内容未观察到", scheduled_observation_missing: "计划的观察缺失", unextracted_statement_count_unknown: "未抽取的陈述数未知",
  verification_basis_incomplete: "核实依据不完整", verification_basis_unavailable: "核实依据暂不可读", insufficient_sample: "样本不足",
  one_shot_descriptive: "一次性测量，不给置信区间", mixed_contract_descriptive: "测量约定不同，不给置信区间", metric_unavailable: "指标暂不可用",
  group_metric_unavailable: "问题群指标暂不可用", measurement_method_changed: "测量方法已变", measurement_contract_changed: "测量约定已变",
  no_common_cohort: "没有共同样本", separate_cohorts: "两段样本不同", previous_metric_absent: "对照区间没有这项指标", comparison_basis_changed: "比较依据已变",
  metric_members_changed: "指标成员已变", not_applicable: "不适用", no_selected_readings: "所选范围没有读数", source_update_needed: "来源有更新，需要复核",
  claim_expired: "结论已过有效期", claim_inactive: "结论已停用", card_withdrawn: "证据卡已撤回" };

/** @type {Record<string, string>} */
const PERIODS = { selected: "所选区间", comparison: "对照区间", comparison_current: "当前区间（用于对照）", interval: "区间", round: "轮次", day: "日", week: "周",
  month: "月", target: "目标" };

/** @type {Record<string, string>} */
const STATUSES = { open: "未处理", acting: "处理中", awaiting_remeasure: "待复测", closed: "已关闭", active: "有效", withdrawn: "已撤回", superseded: "已被取代",
  done: "完成", partial: "部分完成", failed: "失败", queued: "排队中", running: "进行中", cancelled: "已取消", skipped: "已跳过", published: "已发布",
  verified: "已核实", settled: "已结算", problem: "有问题", pending: "待处理", completed: "已完成", draft: "草稿", publishable: "可发布", changed: "有变化",
  unchanged: "无变化", retracted: "已撤稿", present: "已观察引用", absent: "可观测未引用", valid: "有效回答", refusal: "拒答", suspect: "可疑",
  verified_preserved_quote: "原文已核实", correct: "正确", wrong: "错误", unverifiable: "无法核实",
  retraction: "撤稿", correction: "更正", new_version: "新版本", error_observed: "发现错误", source_changed: "来源变更", group_changed: "问题群变化",
  business_reopened: "错误再次出现", assessment_correction: "判定更正", task_attempt: "处理任务", reserve: "预留", release: "释放预留", settle: "结算",
  refund: "退款", budget_set: "预算设置", first: "首次出现", last: "最近出现", recurrence: "再次出现",
  recommended: "推荐", conditional: "有条件推荐", not_recommended: "不推荐", reasonable_nonrecommendation: "合理不推荐", mentioned: "提及" };

/** Field labels of dimensions and kept records; a field with no label is left out of the body. @type {Record<string, string>} */
const LABELS = { engine: "平台", engines: "平台", pool: "问句池", groupName: "问题群", setVersion: "问题版本", questionVersion: "问题版本",
  selectedQuestionVersion: "所选问题版本", roundLabel: "轮次", roundKind: "轮次类型", date: "日期", scheduledDate: "计划日期", askedAt: "提问时间",
  observedFrom: "最早观察", observedTo: "最近观察", firstObserved: "首次观察", lastObserved: "最近观察", unknownTimes: "时间未知的回答",
  sourceType: "来源类型", sourceKind: "来源类型", domain: "网站", domains: "网站", sourceKey: "页面", url: "地址", urls: "地址", originalUrls: "原始地址",
  publishedUrl: "发布地址", relationship: "信源关系", relation: "信源关系", audience: "人群", channel: "渠道", journeyStage: "旅程阶段", journeyStageNo: "旅程序号",
  category: "类别", topic: "主题", entityName: "对象", entityLabel: "对象", name: "名称", label: "名称", tier: "档位", currency: "币种", status: "状态",
  currentStatus: "当前状态", state: "状态", stateLabel: "状态", fromStateLabel: "原状态", toStateLabel: "新状态", eventLabel: "事件", title: "标题",
  articleTitle: "稿件", statement: "陈述", assessedStatement: "判定的陈述", errorStatement: "错误陈述", claimStatement: "结论", quote: "原文",
  statementQuote: "陈述原文", evidenceQuote: "证据原文", conditionQuote: "适用条件原文", evidenceConditionQuote: "证据中的适用条件", positionQuote: "立场原文",
  text: "内容", content: "内容", rationale: "理由", assessmentReason: "判定理由", clinicalQuestion: "临床问题", population: "适用人群", dose: "剂量",
  inLabel: "说明书内", evidenceLevel: "证据级别", identifier: "来源标识", sourceLabel: "来源", platform: "平台", publishedAt: "发布时间", amountCny: "金额（元）",
  budgetCny: "预算（元）", priceCny: "价格（元）", availableCny: "可用（元）", reservedCny: "预留（元）", settledCny: "结算（元）", refundedCny: "退款（元）",
  spentCny: "支出（元）", dailyCny: "日预算（元）", placements: "投放数", at: "时间", observedAt: "观察时间", detectedAt: "发现时间", createdAt: "创建时间",
  updatedAt: "更新时间", recordedAt: "记录时间", notifiedAt: "通知时间", startedAt: "开始时间", finishedAt: "结束时间", submittedAt: "提交时间",
  acceptedAt: "接受时间", sentAt: "发出时间", checkedAt: "检查时间", lastCheckedAt: "最近检查", changedAt: "变更时间", judgedAt: "判定时间",
  verifiedAt: "核实时间", reviewedAt: "复核时间", validUntil: "有效期至", completedAt: "完成时间", severity: "严重程度", errorType: "错误类型",
  failureMode: "回答情况", mentionsOurs: "提及我方", format: "格式", layer: "层级", media: "媒体", step: "步骤", phase: "阶段", claimVersion: "结论版本",
  version: "版本", targetVersion: "目标版本", strategyVersion: "方案版本", value: "数值", numerator: "分子", denominator: "分母", memberCount: "成员数",
  count: "数量", horizonWeeks: "周期（周）", repeats: "重复次数", repeatIndex: "重复序号", reason: "原因", verification: "核实情况",
  verificationState: "核实状态", judgmentState: "判定状态", currentJudgmentState: "当前判定状态", executionState: "执行状态", currentExecutionState: "当前执行状态",
  disposition: "处置", currentDisposition: "当前处置", verdict: "判定", applicability: "适用条件", conditions: "适用条件", currentClaim: "当前结论",
  claim: "结论", finding: "发现", preservedAnswer: "保留的回答", preservedQuestion: "保留的问题", question: "问题", answer: "回答", sourceChanges: "来源变更",
  changes: "变更", originalAssessment: "首次保存的判定", originalErrorAssessment: "首次保存的错误判定", preservedQuoteVerification: "原文核实",
  kind: "类型", originalId: "原始编号", originalGroup: "原始分组", clientTags: "客户标签", recordedStatus: "记录的状态", brands: "品牌", observedBrands: "提及的品牌",
  baseline: "基线", target: "目标", balance: "余额", period: "区间", transition: "可比变化", observation: "观察状态", known: "已核实", expired: "已过期",
  entity: "对象", nonrecommendationBasis: "不推荐依据", explicitPosition: "明确推荐次序", positionToken: "次序用语", positionKind: "次序类型" };

/** @type {Record<string, Record<string, string>>} */
const VALUES = { engine: GEO_ENGINE_LABELS_ZH, engines: GEO_ENGINE_LABELS_ZH, pool: GEO_POOL_LABELS_ZH, sourceType: GEO_SOURCE_KIND_LABELS_ZH,
  sourceKind: GEO_SOURCE_KIND_LABELS_ZH, relationship: GEO_SOURCE_RELATIONSHIP_LABELS_ZH, relation: { ...GEO_SOURCE_RELATIONSHIP_LABELS_ZH, supports_nonrecommendation: "支持不推荐" },
  positionKind: { explicit_recommendation_order: "明确的推荐次序" },
  roundKind: GEO_ROUND_KIND_LABELS_ZH, failureMode: GEO_FAILURE_MODE_LABELS_ZH, errorType: GEO_ERROR_TYPE_LABELS_ZH, layer: { ...GEO_ARTICLE_LAYER_LABELS_ZH, ...GEO_SOURCE_LAYER_LABELS_ZH },
  channel: GEO_ARTICLE_CHANNEL_LABELS_ZH, platform: { ...GEO_ENGINE_LABELS_ZH, ...GEO_OWNED_LINK_PLATFORM_LABELS_ZH }, step: GEO_STEP_LABELS_ZH,
  topic: GEO_STATEMENT_TOPIC_LABELS_ZH, period: PERIODS, reason: REASONS, observation: STATUSES, transition: { first_observed_in_scope: "所选范围内首次",
    new_appearance: "新出现", no_longer_observed: "同一可比范围内未再观察到" }, executionState: GEO_SIGNAL_STATE_LABELS_ZH, currentExecutionState: GEO_SIGNAL_STATE_LABELS_ZH };

const IDENTIFIER = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-f0-9]{24,}|[A-Za-z]{1,6}_[A-Za-z0-9-]{8,}|ggi_.*|gsel_.*|gpc_.*)$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** @param {string} value @param {string} timeZone */
function readerTime(value, timeZone) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * A field's value in reader words, or null when it has none (an identifier, a code without a word, an empty value).
 * @param {string} key @param {unknown} value @param {string} timeZone
 * @returns {string | null}
 */
function readerScalar(key, value, timeZone) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const words = VALUES[key] ?? (["status", "currentStatus", "state", "recordedStatus", "verification", "verificationState", "judgmentState", "currentJudgmentState",
    "disposition", "currentDisposition", "verdict", "kind"].includes(key) ? STATUSES : null);
  if (words && Object.hasOwn(words, value)) return words[value];
  if (ISO_TIME.test(value)) return readerTime(value, timeZone);
  if (IDENTIFIER.test(value) || words) return null;
  return value;
}

/**
 * The readable lines of a record: `标签：值` for every labelled field that has reader words, nested records indented beneath their
 * label. Identifiers, digests and unlabelled fields stay in the export record.
 * @param {unknown} value @param {{ timeZone?: string, depth?: number }} [options]
 * @returns {string[]}
 */
export function geoReaderLines(value, { timeZone = "Asia/Shanghai", depth = 0 } = {}) {
  if (!value || typeof value !== "object" || depth > 4) return [];
  const indent = "  ".repeat(depth);
  /** @type {string[]} */ const lines = [];
  for (const [key, field] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const label = LABELS[key];
    if (!label) continue;
    if (Array.isArray(field)) {
      const scalars = field.map((item) => readerScalar(key, item, timeZone)).filter(Boolean);
      if (scalars.length) lines.push(`${indent}${label}：${[...new Set(scalars)].join("、")}`);
      const nested = field.filter((item) => item && typeof item === "object").map((item) => geoReaderLines(item, { timeZone, depth: depth + 1 })).filter((entry) => entry.length);
      if (nested.length) { lines.push(`${indent}${label}：`); for (const entry of nested) lines.push(...entry, ""); lines.pop(); }
    } else if (field && typeof field === "object") {
      const nested = geoReaderLines(field, { timeZone, depth: depth + 1 });
      if (nested.length) lines.push(`${indent}${label}：`, ...nested);
    } else {
      const text = readerScalar(key, field, timeZone);
      if (text != null) lines.push(`${indent}${label}：${text}`);
    }
  }
  return lines;
}

/**
 * One line of a record's readable fields, `；`-joined, a nested record in brackets (a typed-table cell, a row's conditions).
 * @param {unknown} value @param {string} [timeZone] @param {number} [depth]
 * @returns {string}
 */
export function geoReaderInline(value, timeZone = "Asia/Shanghai", depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return "";
  /** @type {string[]} */ const parts = [];
  for (const [key, field] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const label = LABELS[key];
    if (!label) continue;
    const items = Array.isArray(field) ? field : [field];
    const scalars = [...new Set(items.map((item) => item && typeof item === "object" ? null : readerScalar(key, item, timeZone)).filter(Boolean))];
    const nested = items.filter((item) => item && typeof item === "object").map((item) => geoReaderInline(item, timeZone, depth + 1)).filter(Boolean);
    if (scalars.length) parts.push(`${label}：${scalars.join("、")}`);
    if (nested.length) parts.push(`${label}（${nested.join("；")}）`);
  }
  return parts.join(depth ? "，" : "；");
}

/**
 * A text cell's value in words (an observation state, a comparable change); numbers and free text are returned as they are.
 * @param {string} key @param {unknown} value
 */
export function geoReaderCellValue(key, value) {
  if (typeof value !== "string") return value;
  const words = { ...STATUSES, ...VALUES.transition, ...(VALUES[key] ?? {}) };
  return Object.hasOwn(words, value) ? words[value] : value;
}

/** @param {string | null | undefined} state */
export const geoReaderState = (state) => state == null ? null : GEO_READER_STATE_ZH[state] ?? "需核对";
/** @param {string | null | undefined} reason */
export const geoReaderReason = (reason) => reason == null ? null : REASONS[reason] ?? null;
/** @param {string | null | undefined} unit */
export const geoReaderUnit = (unit) => unit == null ? null : UNITS[unit] ?? null;
/** @param {string | null | undefined} period */
export const geoReaderPeriod = (period) => period == null ? null : PERIODS[period] ?? null;

/** A selection's scope in a sentence. @param {any} scope */
export function geoReaderScope(scope = {}) {
  const parts = [];
  if (scope.round) parts.push("指定的一轮测量");
  if (scope.from || scope.to) parts.push(`${scope.from ?? "不限开始日期"} 至 ${scope.to ?? "不限结束日期"}`);
  if (!scope.round && !scope.from && !scope.to) parts.push(scope.selectionRef ? "保存的选择" : "最近一轮测量");
  if (scope.engines?.length) parts.push(`平台 ${scope.engines.map((/** @type {string} */ engine) => GEO_ENGINE_LABELS_ZH[engine] ?? engine).join("、")}`);
  if (scope.pools?.length) parts.push(`问句池 ${scope.pools.map((/** @type {string} */ pool) => GEO_POOL_LABELS_ZH[pool] ?? pool).join("、")}`);
  if (scope.questionVersion) parts.push(`问题版本 ${scope.questionVersion}`);
  if (scope.groupIds?.length) parts.push(`${scope.groupIds.length} 个问题群`);
  if (scope.clientTags?.length) parts.push(`客户标签 ${scope.clientTags.join("、")}`);
  if (scope.compareFrom || scope.compareTo) parts.push(`对照 ${scope.compareFrom ?? "不限"} 至 ${scope.compareTo ?? "不限"}`);
  parts.push(`时区 ${scope.timeZone ?? "Asia/Shanghai"}`);
  return parts.join("；");
}

/** @type {Record<string, string>} */
const COUNTS = { planned: "计划提问", snapshots: "保存的回答", returned: "有效或拒答的回答", questions: "问题", observations: "观察", balancedObservations: "平衡后的观察",
  balancedOut: "为平衡而未计入", duplicateAnswers: "重复回答", failed: "失败", partial: "部分判定", refused: "拒答", suspect: "可疑回答", unjudged: "尚未判定",
  skippedEngineAnswers: "暂停平台未取得的回答" };

/** A selection's sample in a sentence. @param {Record<string, unknown> | null | undefined} counts */
export function geoReaderCounts(counts) {
  return Object.entries(counts ?? {}).filter(([key, value]) => COUNTS[key] && typeof value === "number").map(([key, value]) => `${COUNTS[key]} ${value}`).join("；") || "无";
}

/** @type {Record<string, string>} */
const AVAILABILITY = { available: "可用", ready: "可用", partial: "部分可用", empty: "没有数据", unavailable: "暂不可用" };

/** An analysis's availability in a sentence. @param {any} availability */
export function geoReaderAvailability(availability) {
  if (!availability) return "可用";
  const reasons = (availability.reasons ?? []).map((/** @type {string} */ reason) => REASONS[reason]).filter(Boolean);
  return [AVAILABILITY[availability.status] ?? "需核对", ...reasons].join("；");
}

/** A selection's time coverage in a sentence. @param {any} time */
export function geoReaderTimeCoverage(time) {
  if (!time) return "未知";
  return [`观察日期 ${time.observedFrom ?? "未知"} 至 ${time.observedTo ?? "未知"}`, `采样时间未知的回答 ${time.unknownTime ?? 0}`,
    time.plannedRounds != null ? `计划轮次 ${time.plannedRounds}` : null].filter(Boolean).join("；");
}

/** A rule written for the reader (Chinese), or null when it is an internal English note kept in the record. @param {unknown} text */
export const geoReaderRule = (text) => typeof text === "string" && /[一-鿿]/u.test(text) ? text : null;

/** What a context the analysis read is, in a reader's words. @type {Record<string, string>} */
export const GEO_READER_CONTEXT_ZH = Object.freeze({ journey: "旅程", journey_links: "旅程标注", journey_need: "旅程需求", source_annotations: "信源注释",
  source_catalogue: "来源目录", source_history: "来源历史", registered_entities: "已登记品牌", registered_owned_and_explicit_links: "登记的自有信源与关联",
  business_history: "业务历史", project_finance: "项目收支", project_ledger: "项目账目", frozen_plan: "冻结方案", frozen_plan_target: "冻结目标",
  frozen_plan_targets: "冻结目标", targets: "目标表", evidence: "证据与结论", clinical_source_support: "临床来源依据", content_publication_coverage: "内容与发布",
  publication_execution: "投放执行", publication_records: "发布记录", error_records: "错误记录", error_distribution: "错误记录", opportunities: "机会",
  recommendations: "推荐", group_labels: "问题群名称", questions: "问题", collection_context: "采集计划", finding_expression: "发现表达" });

/** A metric's reader name. @param {string | null | undefined} metricId */
export const geoReaderMetric = (metricId) => metricId ? GEO_METRIC_LABELS_ZH[metricId] ?? null : null;
