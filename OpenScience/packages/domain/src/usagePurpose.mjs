/**
 * What a metered model request was for.
 *
 * Hidden knowledge: until this vocabulary existed the usage ledger could say
 * who spent and on which run, never on what. Ten days of production (1,816
 * requests, 2026-09-19) could not separate memory extraction, the routing
 * classifier and run titles from the kernel's own calls, and the six
 * specialist engines never reached the ledger at all — so no auxiliary-model
 * change could be shown to save anything. Every caller of the model gateway now
 * names one of these, and `evimed_usage.model_requests.purpose` holds it under
 * a CHECK derived from this list.
 *
 * Closed on purpose: a purpose is a report column, and a free string would
 * split one cost across spellings. A caller that names none is recorded as
 * `other` — bookkeeping never fails a model call.
 */

/** @typedef {'kernel'|'memory-extraction'|'routing'|'title'|'engine'|'capsule-scan'|'channel-intent'|'source-understanding'|'learning'|'frontier'|'review'|'geo'|'other'} UsagePurpose */

/** Every purpose, in report order. `frontier` is the frontier feed reading
 *  the literature for everyone (screening, editing, the daily issue): one
 *  line of its own, charged to the operator's internal `evimed-frontier`
 *  project and governed by the module's own daily budget, so what the feed
 *  costs is never folded into a researcher's spend. `review` is the
 *  independent reviewer the control plane calls on a researcher's delivery
 *  (a model of another family, never the kernel's): charged to the run it
 *  reviewed, so a report's price includes its review. `geo` is 「循证 GEO」's
 *  own model calls outside a run — parsing and judging measured answers —
 *  held by the module's own daily budget like `frontier`, never by a
 *  researcher's caps. */
export const USAGE_PURPOSES = /** @type {readonly UsagePurpose[]} */ (Object.freeze([
  'kernel',
  'memory-extraction',
  'routing',
  'title',
  'engine',
  'capsule-scan',
  'channel-intent',
  'source-understanding',
  'learning',
  'frontier',
  'review',
  'geo',
  'other',
]))

/** Chinese row labels for the cost report. */
export const USAGE_PURPOSE_LABELS_ZH = /** @type {Readonly<Record<UsagePurpose, string>>} */ (Object.freeze({
  kernel: '研究运行',
  'memory-extraction': '记忆提取',
  routing: '路由分类',
  title: '运行标题',
  engine: '专科引擎',
  'capsule-scan': '胶囊扫描',
  'channel-intent': '渠道意图',
  'source-understanding': '资料理解',
  learning: '学习做法',
  frontier: '前沿动态',
  review: '成果审查',
  geo: '循证 GEO',
  other: '其他',
}))

/** @param {unknown} value @returns {value is UsagePurpose} */
export function isUsagePurpose(value) {
  return typeof value === 'string' && USAGE_PURPOSES.includes(/** @type {UsagePurpose} */ (value))
}

/** The purpose to record: the caller's, when it names one of the set, else
 *  `other`. Each caller's own test pins the purpose it passes, which is where
 *  a misspelling is caught, not here in the middle of a model call.
 *  @param {unknown} value @returns {UsagePurpose} */
export function usagePurpose(value) {
  return isUsagePurpose(value) ? value : 'other'
}

/**
 * The purpose of a request a runtime makes, from the run it belongs to.
 *
 * Everything the kernel does is `kernel` — a delegated review or screening
 * child, a method distillation, a compaction summary are the kernel working
 * for a run. Source understanding is the exception because it is not a
 * researcher's run: it is what ingesting a document into the knowledge base
 * costs, dispatched by the source pipeline, and a report that folded it into
 * `kernel` would hide the price of the knowledge base inside the price of
 * research.
 *
 * Learning is the second exception, for the same reason and one more: the
 * loop's own runs — distilling a method, relating methods, the paired
 * evaluation that can retire one — are not a researcher's work, and the
 * learning caps must be able to count exactly them. Until 2026-09-21 they were
 * `kernel`, so a learning cap could only be compared with everything the
 * account spent: a researcher's own day of research used the learning budget
 * up, and every lesson from that day was refused (production, 2026-09-20: three
 * of three distillations, `usage_budget_exceeded`).
 *
 * @param {{ effectiveAgentId?: string | null, dispatchId?: string | null } | null | undefined} run
 * @returns {UsagePurpose}
 */
export function usagePurposeOfRun(run) {
  const agent = run?.effectiveAgentId
  if (agent === 'source-understanding') return 'source-understanding'
  if (LEARNING_AGENT_IDS.includes(String(agent ?? ''))) return 'learning'
  // The paired evaluation dispatches ordinary capability runs; its dispatch ids
  // are the one thing that says whose they are (`learningEvaluation.mjs`).
  if (String(run?.dispatchId ?? '').startsWith(LEARNING_EVALUATION_DISPATCH_PREFIX)) return 'learning'
  return 'kernel'
}

/** The learning loop's two internal capabilities. */
export const LEARNING_AGENT_IDS = Object.freeze(['method-distillation', 'method-relations'])

/** What every paired-evaluation dispatch id starts with. */
export const LEARNING_EVALUATION_DISPATCH_PREFIX = 'methodeval_'
