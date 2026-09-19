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

/** @typedef {'kernel'|'memory-extraction'|'routing'|'title'|'engine'|'capsule-scan'|'channel-intent'|'source-understanding'|'other'} UsagePurpose */

/** Every purpose, in report order. */
export const USAGE_PURPOSES = /** @type {readonly UsagePurpose[]} */ (Object.freeze([
  'kernel',
  'memory-extraction',
  'routing',
  'title',
  'engine',
  'capsule-scan',
  'channel-intent',
  'source-understanding',
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
 * @param {{ effectiveAgentId?: string | null } | null | undefined} run
 * @returns {UsagePurpose}
 */
export function usagePurposeOfRun(run) {
  return run?.effectiveAgentId === 'source-understanding' ? 'source-understanding' : 'kernel'
}
