/**
 * What a comparison says about how far it can be read (remediation plan 5.2, A5-A9, A13 and owner decision 2 of 2026-11-01).
 *
 * Everything here is a closed vocabulary or a pure function over a record a run wrote: the words a result is classed in, the seven
 * components of a target-trial record, the applicability record and the new triggers that limit a result, the weighted balance said in
 * a sentence, the role of an effect on its assumption card. The control plane reads these words in the same way for the page, the
 * notice, the use ceiling and the tool answer; nothing here refuses anything. A record that is missing is reminded to the run in the
 * tool's answer and the result is delivered; a trigger that fires makes the result `limited` with its reason and never withholds it.
 *
 * @module vcrComparability
 */

import { VCR_BALANCE_BAND_LABELS_ZH, VCR_SMD_FLOOR, VCR_SMD_SEVERE, vcrBalanceBand } from './vcrVocabulary.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])
/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value @returns {string | null} */
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

// --- the class a result is read in (A8) ---------------------------------------------------------------------------------------------

/**
 * The four classes a comparison result is read in. The engine states three conclusions (`estimable`, `limited`, `not_estimable`); a
 * result that is a benchmark and not an estimate of an effect is a fourth thing to a reader, and the class says it wherever a
 * conclusion is read. The stored conclusion is the engine's and never changes: the class is derived from it and the method.
 */
export const VCR_RESULT_CLASSES = frozen(['estimable', 'limited', 'benchmark_only', 'not_estimable'])
export const VCR_RESULT_CLASS_LABELS_ZH = Object.freeze({
  estimable: '可估计', limited: '有限制地估计', benchmark_only: '仅基准', not_estimable: '不可估计',
})
/** What makes a result a benchmark: a curve reconstructed from the literature alone, an unanchored MAIC, a model's prediction. */
export const VCR_BENCHMARK_ONLY_BASES = frozen(['literature_curve', 'unanchored_maic', 'model_prediction'])
export const VCR_BENCHMARK_ONLY_BASIS_LABELS_ZH = Object.freeze({
  literature_curve: '只重建了文献里的曲线，没有和另一组比较',
  unanchored_maic: '非锚定的间接比较，残余误差大小未知',
  model_prediction: '模型对这个人群的预测，不识别治疗效应',
})
/** The most a benchmark result can be used for: it informs a design and is not an analysis of an effect. */
export const VCR_BENCHMARK_ONLY_USE_CEILING = 'design_support'

/**
 * Why a result is a benchmark, or null when it is not. Pure: the method that made the numbers, the route when the caller has one, the
 * result's diagnostics and its measures.
 * @param {{ method?: string | null, route?: string | null, diagnostics?: Record<string, any> | null, measures?: ReadonlyArray<Record<string, any>> | null }} input
 * @returns {'literature_curve' | 'unanchored_maic' | 'model_prediction' | null}
 */
export function vcrBenchmarkBasis({ method = null, route = null, diagnostics = null, measures = null } = {}) {
  // What the result says it is itself (`recordResult` writes it when it files a benchmark): a reader that does not know the method reads this.
  const stored = object(diagnostics).benchmarkBasis
  if (/** @type {readonly string[]} */ (VCR_BENCHMARK_ONLY_BASES).includes(stored)) return /** @type {'literature_curve' | 'unanchored_maic' | 'model_prediction'} */ (stored)
  if (method === 'model.prognostic_apply' || route === 'model_comparator') return 'model_prediction'
  if ((method === 'comparator.maic' || method === 'comparator.maic_time_to_event' || method === 'comparator.stc') && object(diagnostics).anchored === false) return 'unanchored_maic'
  if (method === 'evidence.reconstruct_km' && (route === null || route === 'literature_control')
    && !(measures ?? []).some((measure) => object(measure).name === 'rmst_difference')) return 'literature_curve'
  return null
}

/**
 * The class a result is read in: the engine's conclusion, except that a result that is a benchmark says so in place of `estimable` or
 * `limited` (a result that is not estimable stays that). Null for a result with no conclusion.
 * @param {{ conclusion?: string | null, method?: string | null, route?: string | null, diagnostics?: Record<string, any> | null,
 *   measures?: ReadonlyArray<Record<string, any>> | null }} input
 * @returns {'estimable' | 'limited' | 'benchmark_only' | 'not_estimable' | null}
 */
export function vcrResultClass({ conclusion = null, method = null, route = null, diagnostics = null, measures = null } = {}) {
  if (conclusion !== 'estimable' && conclusion !== 'limited' && conclusion !== 'not_estimable') return null
  if (conclusion === 'not_estimable') return 'not_estimable'
  return vcrBenchmarkBasis({ method, route, diagnostics, measures }) ? 'benchmark_only' : conclusion
}

/**
 * Why a result is read with care, in sentences a reader can act on: the weighted balance (the estimate is delivered with it, limited
 * above 0.10 and severe above 0.25), the reasons the comparator's own records give (A7), and what a benchmark is a benchmark of (A8). A
 * not-estimable result has its gap list instead and no sentences here. One function for the comparison page and the result record, so
 * the two never say different things of one result.
 * @param {{ conclusion?: string | null, method?: string | null, route?: string | null, diagnostics?: Record<string, any> | null,
 *   measures?: ReadonlyArray<Record<string, any>> | null }} input
 * @returns {Array<{ key: string, text: string }>}
 */
export function vcrResultLimits({ conclusion = null, method = null, route = null, diagnostics = null, measures = null } = {}) {
  if (conclusion === 'not_estimable') return []
  const found = object(diagnostics)
  /** @type {Array<{ key: string, text: string }>} */
  const limits = []
  const verdict = Object.keys(object(found.balanceVerdict)).length ? object(found.balanceVerdict)
    : vcrBalanceVerdictOf((Array.isArray(found.balance) ? found.balance : []).map(object))
  const balance = vcrBalanceSentence(verdict)
  if (balance) limits.push({ key: 'balance', text: balance })
  // A propensity trimming removed the people with no comparable counterpart: the estimate is about the people who were kept (EU HTA guideline 6.2).
  const trimmed = Number(object(found.trim).removedTotal)
  if (Number.isFinite(trimmed) && trimmed > 0) limits.push({ key: 'trim', text: '结论只适用于修剪后留下的人：没有可比对象的人已被去掉，他们的情况不在这个结果里。' })
  // Missing covariates that were imputed (algorithm round C7): what the pooled answer rests on beyond the data, when it is thinner than asked.
  const imputation = object(found.imputation)
  if (imputation.performed === true) {
    const completed = Number(imputation.completed)
    const requested = Number(imputation.requested)
    const share = Number(imputation.shareIncomplete)
    if (imputation.stoppedBy) limits.push({ key: 'imputations_stopped_early', text: `计算时间用完，只合并了 ${completed} 份补齐数据（计划 ${requested} 份），区间比计划的粗。` })
    if (Number.isFinite(share) && Number.isFinite(requested) && requested < Math.ceil(share * 100)) {
      limits.push({ key: 'few_imputations', text: `补齐的份数（${requested}）少于有缺失的人所占的百分比（${Math.ceil(share * 100)}），份数偏少，合并后的区间可能不稳。` })
    }
    const dropped = Array.isArray(imputation.droppedImputations) ? imputation.droppedImputations.length : 0
    if (dropped > 0) limits.push({ key: 'imputations_not_estimable', text: `有 ${dropped} 份补齐数据上的分析算不出结果，合并时没有用它们。` })
  }
  const labels = /** @type {Record<string, string>} */ (VCR_APPLICABILITY_LIMIT_LABELS_ZH)
  for (const entry of (Array.isArray(found.applicabilityLimits) ? found.applicabilityLimits : []).map(object)) {
    const sentence = labels[String(entry.code)] ?? text(entry.reason)
    if (sentence) limits.push({ key: String(entry.code), text: sentence })
  }
  // An unanchored comparison says what it leaves unknown in the premises (residual error of unknown size); the other two say it here.
  const basis = vcrResultClass({ conclusion, method, route, diagnostics, measures }) === 'benchmark_only' ? vcrBenchmarkBasis({ method, route, diagnostics, measures }) : null
  if (basis && basis !== 'unanchored_maic') limits.push({ key: 'benchmark', text: /** @type {Record<string, string>} */ (VCR_BENCHMARK_ONLY_BASIS_LABELS_ZH)[basis] })
  return limits
}

// --- the weighted balance, said (owner decision 2 of 2026-11-01) --------------------------------------------------------------------

/**
 * What the worst weighted standardized difference says, in one sentence a reader can act on, or null when the covariates are
 * balanced. The estimate is delivered in every band: this is the reason beside it. The engine states the verdict
 * (`diagnostics.balanceVerdict`); a result written before it did is read from its balance table.
 * @param {{ band?: string | null, worst?: unknown, variable?: unknown } | null | undefined} verdict
 * @returns {string | null}
 */
export function vcrBalanceSentence(verdict) {
  const worst = Number(object(verdict).worst)
  const variable = text(object(verdict).variable)
  const band = Number.isFinite(worst) ? vcrBalanceBand(worst) : null
  if (!band || band === 'balanced') return null
  const value = (Math.round(Math.abs(worst) * 1000) / 1000).toFixed(2)
  const where = variable ? `加权后“${variable}”的标准化差异` : '加权后最大的标准化差异'
  return band === 'severe'
    ? `${VCR_BALANCE_BAND_LABELS_ZH.severe}：${where}为 ${value}，超过 ${VCR_SMD_SEVERE}。`
    : `${where}仍为 ${value}，超过界值 ${VCR_SMD_FLOOR}。`
}

/**
 * The verdict of a result's balance table, for a result that predates `diagnostics.balanceVerdict`.
 * @param {ReadonlyArray<Record<string, any>> | null | undefined} balance rows with `covariate` and `smdAdjusted`
 * @returns {{ band: 'balanced' | 'moderate' | 'severe', worst: number, variable: string | null } | null}
 */
export function vcrBalanceVerdictOf(balance) {
  let worst = Number.NaN
  let variable = null
  for (const row of balance ?? []) {
    const value = Math.abs(Number(object(row).smdAdjusted))
    if (Number.isFinite(value) && !(value <= worst)) { worst = value; variable = text(object(row).covariate) }
  }
  const band = vcrBalanceBand(worst)
  return band ? { band, worst, variable } : null
}

// --- the target-trial record (A6) ---------------------------------------------------------------------------------------------------

/** The seven components of a target trial (Hernán & Robins), closed. A record states each with how far the comparison can emulate it. */
export const VCR_TARGET_TRIAL_COMPONENTS = frozen(['eligibility', 'strategies', 'assignment', 'timeZero', 'outcome', 'contrast', 'analysis'])
export const VCR_TARGET_TRIAL_COMPONENT_LABELS_ZH = Object.freeze({
  eligibility: '入选标准', strategies: '处理策略', assignment: '分配方式', timeZero: '随访起点（时间零点）',
  outcome: '结局', contrast: '对比', analysis: '分析方法',
})
export const VCR_TARGET_TRIAL_STATUSES = frozen(['exact', 'approximate', 'not_possible'])
export const VCR_TARGET_TRIAL_STATUS_LABELS_ZH = Object.freeze({ exact: '可精确复现', approximate: '只能近似', not_possible: '无法复现' })

/** The longest a component's text is. */
export const VCR_TARGET_TRIAL_TEXT_MAX = 300

/** Spellings of the closed words that older records and other languages wrote: `cannot` is the engine's own word for `not_possible`. */
const STATUS_ALIASES = Object.freeze(/** @type {Record<string, string>} */ ({ cannot: 'not_possible', not_simulable: 'not_possible' }))
/** @param {unknown} value @returns {'exact' | 'approximate' | 'not_possible' | null} */
function statusOf(value) {
  const word = typeof value === 'string' ? (STATUS_ALIASES[value.trim()] ?? value.trim()) : ''
  return /** @type {readonly string[]} */ (VCR_TARGET_TRIAL_STATUSES).includes(word) ? /** @type {'exact' | 'approximate' | 'not_possible'} */ (word) : null
}
/** The component a closed word names: its key, its snake-case spelling or its Chinese label. @param {unknown} value */
function componentOf(value) {
  const word = typeof value === 'string' ? value.trim() : ''
  if (!word) return null
  const labels = /** @type {Record<string, string>} */ (VCR_TARGET_TRIAL_COMPONENT_LABELS_ZH)
  return VCR_TARGET_TRIAL_COMPONENTS.find((key) => key === word || key === word.replace(/_([a-z])/g, (_all, letter) => letter.toUpperCase()) || labels[key] === word) ?? null
}

/**
 * @typedef {{ key: string, label: string, status: 'exact' | 'approximate' | 'not_possible' | null, statusLabel: string | null, text: string | null }} VcrTargetTrialComponent
 * @typedef {{ components: VcrTargetTrialComponent[], other: Array<{ item: string, status: 'exact' | 'approximate' | 'not_possible' | null }>,
 *   note: string | null, present: boolean, missing: string[], shape: 'components' | 'items' | 'legacy' | 'empty' }} VcrTargetTrial
 */

/**
 * One stored shape into component entries. Three shapes are read, because three were written: the closed seven components (this
 * version), a list of `{ item, emulation }` (what the engine reads and what the skill used to teach), and the page's old
 * `{ population, treatment, note }`. A list item whose name is not one of the seven stays an item of its own; it is never guessed
 * into a component.
 * @param {unknown} raw
 */
function readTargetTrial(raw) {
  /** @type {Map<string, { status: 'exact' | 'approximate' | 'not_possible' | null, text: string | null }>} */
  const byKey = new Map()
  /** @type {Array<{ item: string, status: 'exact' | 'approximate' | 'not_possible' | null }>} */
  const other = []
  let note = null
  /** @type {VcrTargetTrial["shape"]} */
  let shape = 'empty'
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const row = object(entry)
      const status = statusOf(row.status ?? row.emulation)
      const key = componentOf(row.item ?? row.component)
      if (key) byKey.set(key, { status, text: text(row.text) })
      else if (text(row.item)) other.push({ item: String(row.item).trim().slice(0, 80), status })
      if (text(row.item)) shape = 'items'
    }
  } else if (raw !== null && typeof raw === 'object') {
    const row = object(raw)
    for (const key of VCR_TARGET_TRIAL_COMPONENTS) {
      const value = row[key] ?? (key === 'timeZero' ? row.time_zero : undefined)
      if (value === undefined || value === null) continue
      shape = 'components'
      if (typeof value === 'string') byKey.set(key, { status: null, text: text(value) })
      else byKey.set(key, { status: statusOf(object(value).status ?? object(value).emulation), text: text(object(value).text) })
    }
    // The page's old record: who the target trial studies and what it gives, as two free sentences and a note.
    if (!byKey.has('eligibility') && text(row.population)) { byKey.set('eligibility', { status: null, text: text(row.population) }); if (shape === 'empty') shape = 'legacy' }
    if (!byKey.has('strategies') && text(row.treatment)) { byKey.set('strategies', { status: null, text: text(row.treatment) }); if (shape === 'empty') shape = 'legacy' }
    note = text(row.note)
    if (note && shape === 'empty') shape = 'legacy'
  }
  return { byKey, other, note, shape }
}

/**
 * The target-trial record of a comparator as one shape, whichever shapes it was written in. The row's own record is read first and the
 * configuration's (the engine's list) fills what the row does not say; a component is read once.
 * @param {unknown} record the comparator row's `targetTrial`
 * @param {unknown} [configured] the configuration's `targetTrial`, the engine's `{ item, emulation }` list or a record of this shape
 * @returns {VcrTargetTrial}
 */
export function vcrTargetTrial(record, configured = undefined) {
  const first = readTargetTrial(record)
  const second = readTargetTrial(configured)
  /** @type {VcrTargetTrialComponent[]} */
  const components = VCR_TARGET_TRIAL_COMPONENTS.flatMap((key) => {
    const entry = first.byKey.get(key) ?? second.byKey.get(key)
    if (!entry) return []
    const status = entry.status ?? second.byKey.get(key)?.status ?? null
    return [{ key, label: /** @type {Record<string, string>} */ (VCR_TARGET_TRIAL_COMPONENT_LABELS_ZH)[key], status,
      statusLabel: status ? /** @type {Record<string, string>} */ (VCR_TARGET_TRIAL_STATUS_LABELS_ZH)[status] : null, text: entry.text ?? second.byKey.get(key)?.text ?? null }]
  })
  const other = [...first.other, ...second.other.filter((one) => !first.other.some((two) => two.item === one.item))]
  const present = components.length > 0 || other.length > 0
  // What the run has yet to say: a component with no status is as good as missing for the reader, and the run is told which.
  const missing = VCR_TARGET_TRIAL_COMPONENTS.filter((key) => !components.some((entry) => entry.key === key && entry.status !== null))
  return { components, other, note: first.note ?? second.note, present, missing: [...missing],
    shape: first.shape !== 'empty' ? first.shape : second.shape }
}

/**
 * The record in the engine's own words: a list of `{ item, emulation }` the weighting methods read for `cannot`. The component keys are
 * the items; a component with no status is not stated. Items that are not components go through as they were.
 * @param {VcrTargetTrial} record
 * @returns {Array<{ item: string, emulation: 'exact' | 'approximate' | 'cannot' }>}
 */
export function vcrTargetTrialEngineItems(record) {
  /** @param {string | null} status @returns {'exact' | 'approximate' | 'cannot' | null} */
  const emulation = (status) => (status === 'not_possible' ? 'cannot' : status === 'exact' || status === 'approximate' ? status : null)
  return [
    ...record.components.flatMap((entry) => { const word = emulation(entry.status); return word ? [{ item: entry.key, emulation: word }] : [] }),
    ...record.other.flatMap((entry) => { const word = emulation(entry.status); return word ? [{ item: entry.item, emulation: word }] : [] }),
  ]
}

/** The record stored for a write: the seven components in the closed shape, items that are no component kept beside them. @param {VcrTargetTrial} record */
export function vcrTargetTrialStored(record) {
  /** @type {Record<string, any>} */
  const stored = {}
  for (const entry of record.components) {
    stored[entry.key] = { ...(entry.status ? { status: entry.status } : {}), ...(entry.text ? { text: entry.text.slice(0, VCR_TARGET_TRIAL_TEXT_MAX) } : {}) }
  }
  if (record.other.length) stored.other = record.other.map((entry) => ({ item: entry.item, ...(entry.status ? { status: entry.status } : {}) }))
  if (record.note) stored.note = record.note
  return stored
}

// --- the applicability record (A7) --------------------------------------------------------------------------------------------------

/**
 * How suitable the comparison is for the question, in the run's own judgement (FDA's external-control draft puts it first; EMA and
 * the CDE agree). A record, not a gate: the result is delivered whatever it says, and what it says is on the page with its note.
 */
export const VCR_APPLICABILITY_STATES = frozen(['suitable', 'partly_suitable', 'doubtful'])
export const VCR_APPLICABILITY_STATE_LABELS_ZH = Object.freeze({ suitable: '适用', partly_suitable: '部分适用', doubtful: '存疑' })
/** What the comparison is to support. A non-inferiority claim rests on an external control worst of all. */
export const VCR_COMPARISON_CLAIMS = frozen(['superiority', 'non_inferiority', 'equivalence', 'descriptive'])
export const VCR_COMPARISON_CLAIM_LABELS_ZH = Object.freeze({ superiority: '优效', non_inferiority: '非劣效', equivalence: '等效', descriptive: '描述性' })
export const VCR_APPLICABILITY_NOTE_MAX = 400

/**
 * The applicability record a comparator configuration holds (`configuration.applicability`), as the page reads it.
 * @param {unknown} configuration
 * @returns {{ present: boolean, state: string | null, stateLabel: string | null, claim: string | null, claimLabel: string | null, note: string | null }}
 */
export function vcrApplicability(configuration) {
  const record = object(object(configuration).applicability)
  const state = /** @type {readonly string[]} */ (VCR_APPLICABILITY_STATES).includes(String(record.state)) ? String(record.state) : null
  const claim = /** @type {readonly string[]} */ (VCR_COMPARISON_CLAIMS).includes(String(record.claim)) ? String(record.claim) : null
  const note = text(record.note)
  return {
    present: state !== null, state, stateLabel: state ? /** @type {Record<string, string>} */ (VCR_APPLICABILITY_STATE_LABELS_ZH)[state] : null,
    claim, claimLabel: claim ? /** @type {Record<string, string>} */ (VCR_COMPARISON_CLAIM_LABELS_ZH)[claim] : null, note: note ? note.slice(0, VCR_APPLICABILITY_NOTE_MAX) : null,
  }
}

/** The reasons a result is `limited` that code can decide from the records, with their sentences. */
export const VCR_APPLICABILITY_LIMITS = frozen(['non_inferiority_purpose', 'no_time_zero_rule'])
export const VCR_APPLICABILITY_LIMIT_LABELS_ZH = Object.freeze({
  non_inferiority_purpose: '这项比较要支持的是非劣效结论：外部对照不适合这样用，只能当作参考。',
  no_time_zero_rule: '没有写明两组各从什么时刻开始随访（时间零点），起点不一致会带来偏倚。',
})

/** The routes that borrow a control from outside the trial. */
const BORROWING_ROUTES = frozen(['external_control', 'literature_control', 'hybrid_control'])

/**
 * The reasons code can see for limiting a comparison, from the records a run wrote. Never a refusal: the comparison is computed and
 * delivered, and a result the engine called `estimable` is called `limited` with these reasons beside it.
 *
 * - **A non-inferiority claim** on a route that borrows its control from outside the trial.
 * - **No time-zero rule** on a real-data external control: neither the target-trial record nor the configuration says when follow-up
 *   starts in each arm. (A study with no target-trial record at all has none either; the run is reminded of the record, and the
 *   result says why it is limited meanwhile.)
 * @param {{ route?: string | null, configuration?: unknown, targetTrial?: unknown }} input
 * @returns {Array<{ code: 'non_inferiority_purpose' | 'no_time_zero_rule', reason: string }>}
 */
export function vcrApplicabilityLimits({ route = null, configuration = null, targetTrial = null } = {}) {
  /** @type {Array<{ code: 'non_inferiority_purpose' | 'no_time_zero_rule', reason: string }>} */
  const found = []
  const labels = /** @type {Record<string, string>} */ (VCR_APPLICABILITY_LIMIT_LABELS_ZH)
  const config = object(configuration)
  if (route !== null && /** @type {readonly string[]} */ (BORROWING_ROUTES).includes(route) && vcrApplicability(config).claim === 'non_inferiority') {
    found.push({ code: 'non_inferiority_purpose', reason: labels.non_inferiority_purpose })
  }
  if (route === 'external_control') {
    const record = vcrTargetTrial(targetTrial, config.targetTrial)
    const stated = record.components.some((entry) => entry.key === 'timeZero' && (entry.text !== null || entry.status !== null))
    const column = text(object(config.timeZero).column) !== null
    if (!stated && !column) found.push({ code: 'no_time_zero_rule', reason: labels.no_time_zero_rule })
  }
  return found
}

// --- the role of an effect on its card (A13) ----------------------------------------------------------------------------------------

/**
 * What an effect is on its assumption card (DELTA2): the difference the study cares about (the smallest worth finding) or the
 * difference it realistically expects. They are different numbers for different questions, and the effect is the input that is most
 * often wrong. Optional in the write; a card of an effect without a role is reminded to the run, never refused.
 */
export const VCR_EFFECT_ROLES = frozen(['important_difference', 'realistic_expectation'])
export const VCR_EFFECT_ROLE_LABELS_ZH = Object.freeze({ important_difference: '重要差异', realistic_expectation: '现实预期' })

/**
 * The keys of the cards that state the effect of a treatment. Machine names, closed: the same keys `VCR_ASSUMPTION_BINDINGS` binds into
 * the truth of a scenario as the effect (a hazard ratio, the treatment's event rate, a risk difference, an odds ratio, a mean
 * difference).
 */
export const VCR_EFFECT_CARD_KEY_PATTERNS = Object.freeze([
  /^hazard_ratio(?:_|$)/,
  /^(?:treatment_event_rate|treatment_rate|treatment_response_rate)$/,
  /^risk_difference$/,
  /^odds_ratio$/,
  /^(?:mean_difference|treatment_effect|effect_size|effect)$/,
])
/** @param {unknown} key */
export function vcrIsEffectCardKey(key) {
  return VCR_EFFECT_CARD_KEY_PATTERNS.some((pattern) => pattern.test(String(key)))
}
