/**
 * The research question of a study, 「研究问题与假设」 (round-2 plan R22, C.4 part 1): what the simulation is asked, written down once in the
 * attributes of ICH E9(R1) so that every result can say which question it answers.
 *
 * Hidden knowledge:
 *
 * - **Every field is optional.** A question the person has only half said is a question: a field nobody wrote is a default the
 *   result's premises name, never a required field, a form or a gate. Nothing here refuses to compute because a field is empty.
 * - **A patch is a new version, and every field remembers who wrote it.** The agent writes a field at a time from what the person
 *   says (`person_stated`: the person's own words; `model_assembled`: the agent's reading of several turns); the person edits on the
 *   page (`person_edited`). The stronger basis wins — an edit on the page over words in the conversation over an assembly — and a
 *   write of a weaker basis over a stronger one is not applied and is reported back as kept, never overwritten silently. An
 *   identical patch is no new version, so a run retrying a write does not move the version a result was computed under.
 * - **Whether this simulation can represent an event is arithmetic on a table, not a reading of the words.** The event is free text;
 *   the strategy is one of the five E9(R1) words. `VCR_QUESTION_MODEL_CAPABILITIES` lists, per model, the strategies the engine has a
 *   generator and an estimator for; a strategy not in the list reads 「这个模拟表示不了」 in the premises. It is never a refusal and
 *   never a silent default. The table is data: round-2 R26 adds strategies to it as the engine learns them.
 * - **The calibration estimand is the model's, read-only.** What a model's source data represent (the CAMD model: mixed trial data,
 *   mostly on treatment, missing data analysed as missing at random) is a fact about the model; when the question's own strategies
 *   differ from it, the premise says so (E9(R1) A.4 on historical studies).
 *
 * @module @evimed/domain/vcrResearchQuestion
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])
/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : [])

/** The five strategies of ICH E9(R1) A.3.2 for an intercurrent event. */
export const VCR_QUESTION_STRATEGIES = frozen(['treatment_policy', 'hypothetical', 'composite', 'while_on_treatment', 'principal_stratum'])
/** @type {Readonly<Record<string, string>>} */
export const VCR_QUESTION_STRATEGY_LABELS_ZH = Object.freeze({
  treatment_policy: '不论是否发生都按原来的分组分析（治疗策略）',
  hypothetical: '假设事件没有发生（假想情境）',
  composite: '把事件本身算作结局的一部分（复合变量）',
  while_on_treatment: '只看事件发生之前（在治期间）',
  principal_stratum: '只看一类人：事件会发生（或不会发生）的人（主层）',
})

/** Who wrote a field, weakest first: the basis a later write has to match or beat. */
export const VCR_QUESTION_BASES = frozen(['model_assembled', 'person_stated', 'person_edited'])
/** @type {Readonly<Record<string, string>>} */
export const VCR_QUESTION_BASIS_LABELS_ZH = Object.freeze({
  model_assembled: '助手根据对话整理', person_stated: '你在对话里说的', person_edited: '你在页面上改的',
})

/** The decision-value tiers of an intervention model (round-2 C.1). */
export const VCR_QUESTION_MODEL_TIERS = frozen(['A', 'B', 'C'])

/** The fields of a question and their Chinese names, in the order the card shows them. */
export const VCR_QUESTION_FIELDS = frozen(['question', 'population', 'treatment', 'variable', 'intercurrentEvents', 'summary', 'decisionContext', 'assumptions'])
/** @type {Readonly<Record<string, string>>} */
export const VCR_QUESTION_FIELD_LABELS_ZH = Object.freeze({
  question: '研究问题', population: '人群', treatment: '治疗条件', variable: '观察的变量', intercurrentEvents: '中途事件及其处理',
  summary: '群体层面的汇总方式', decisionContext: '要做的决定', assumptions: '假设及其来源',
})

/** How long the words may run and how many entries a list keeps; the page and the runtime's writer check the same numbers. */
export const VCR_QUESTION_LIMITS = Object.freeze({ text: 1_000, short: 300, events: 12, assumptions: 20, id: 60 })

/** The sub-fields of the object-shaped fields (a patch merges them one by one). */
export const VCR_QUESTION_OBJECT_FIELDS = Object.freeze({
  population: frozen(['text', 'populationRef']),
  treatment: frozen(['text', 'interventionModel']),
  variable: frozen(['endpoint', 'scale', 'timePoint']),
  decisionContext: frozen(['decision', 'thresholds']),
})

/**
 * What each model can represent of E9(R1)'s strategies today, and what its source data estimate. `default` covers a model not named
 * here. The AD model's source data are mixed trial data analysed under missing at random, which estimate the hypothetical effect
 * (what would have been seen had the person stayed); since round-2 R26 the engine also generates stopping the drug by arm, an off-treatment path and
 * a retrieved share, so it represents the treatment-policy strategy as well, with an estimator for each (`vcrEstimandAlignment`).
 */
export const VCR_QUESTION_MODEL_CAPABILITIES = Object.freeze({
  'camd-adas-cog-11': Object.freeze({
    // R26 (2026-11-09): the beta_logit family generates stopping the drug with an off-treatment path, a retrieved share and the truth of both
    strategies: frozen(['hypothetical', 'treatment_policy']),
    calibration: Object.freeze({
      data: '混合的试验数据', treatment: '大多数人在用药期间', missing: '随机缺失（MAR）', strategies: frozen(['hypothetical']),
      sentence: '这个模型的校准数据是混合的试验数据，大多数人在用药期间，缺失的数据按随机缺失处理',
    }),
  }),
  default: Object.freeze({ strategies: frozen(['hypothetical']), calibration: null }),
})

/** @param {string | null | undefined} modelId */
const capabilityOf = (modelId) => /** @type {Record<string, any>} */ (VCR_QUESTION_MODEL_CAPABILITIES)[String(modelId ?? '')] ?? VCR_QUESTION_MODEL_CAPABILITIES.default

/** @param {unknown} value @param {number} max */
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : null)

/**
 * A patch as the page or a run states it, checked and cut to the limits. A field that is not in the patch stays as it is; a field
 * stated as `null` clears. What cannot be read is returned as an issue with its field, and the rest of the patch is kept.
 * @param {unknown} raw
 * @returns {{ patch: Record<string, any>, issues: Array<{ field: string, message: string }> }}
 */
export function normalizeQuestionPatch(raw) {
  const body = object(raw)
  /** @type {Record<string, any>} */
  const patch = {}
  /** @type {Array<{ field: string, message: string }>} */
  const issues = []
  const bad = (/** @type {string} */ field, /** @type {string} */ message) => issues.push({ field, message })
  for (const field of Object.keys(body)) {
    if (!(/** @type {readonly string[]} */ (VCR_QUESTION_FIELDS)).includes(field) && !['id', 'basis'].includes(field)) bad(field, `没有这个字段；可写的是：${VCR_QUESTION_FIELDS.join('、')}。`)
  }
  if ('question' in body) {
    if (body.question === null) patch.question = null
    else if (typeof body.question === 'string') patch.question = clip(body.question, VCR_QUESTION_LIMITS.text)
    else bad('question', 'question 是一段话。')
  }
  if ('summary' in body) {
    if (body.summary === null) patch.summary = null
    else if (typeof body.summary === 'string') patch.summary = clip(body.summary, VCR_QUESTION_LIMITS.short)
    else bad('summary', 'summary 是一句话，例如“第 78 周的平均变化之差”。')
  }
  for (const [field, subs] of Object.entries(VCR_QUESTION_OBJECT_FIELDS)) {
    if (!(field in body)) continue
    if (body[field] === null) { patch[field] = null; continue }
    if (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field])) { bad(field, `${field} 是一个对象，可含：${subs.join('、')}。`); continue }
    /** @type {Record<string, any>} */
    const out = {}
    for (const [sub, value] of Object.entries(body[field])) {
      if (!subs.includes(sub)) { bad(`${field}.${sub}`, `${field} 里没有 ${sub}；可写的是：${subs.join('、')}。`); continue }
      if (value === null) { out[sub] = null; continue }
      if (sub === 'populationRef') {
        const ref = object(value)
        if (typeof ref.id === 'string' && ref.id && (ref.version == null || Number.isInteger(ref.version))) out[sub] = { id: ref.id.slice(0, VCR_QUESTION_LIMITS.id), ...(ref.version == null ? {} : { version: ref.version }) }
        else bad(`${field}.${sub}`, 'populationRef 是 { id, version }，version 是整数。')
      } else if (sub === 'interventionModel') {
        const model = object(value)
        const tier = model.tier == null ? null : String(model.tier)
        if (typeof model.id === 'string' && model.id && (tier === null || (/** @type {readonly string[]} */ (VCR_QUESTION_MODEL_TIERS)).includes(tier))) {
          out[sub] = { id: model.id.slice(0, VCR_QUESTION_LIMITS.id), ...(tier ? { tier } : {}) }
        } else bad(`${field}.${sub}`, `interventionModel 是 { id, tier }，tier 是 ${VCR_QUESTION_MODEL_TIERS.join(' / ')} 之一或不写。`)
      } else if (typeof value === 'string') out[sub] = value.trim().slice(0, VCR_QUESTION_LIMITS.short)
      else bad(`${field}.${sub}`, `${field}.${sub} 是一段文字。`)
    }
    if (Object.keys(out).length) patch[field] = out
  }
  if ('intercurrentEvents' in body) {
    if (body.intercurrentEvents === null) patch.intercurrentEvents = null
    else if (!Array.isArray(body.intercurrentEvents)) bad('intercurrentEvents', 'intercurrentEvents 是列表，每项 { event, strategy, mechanism }。')
    else {
      const events = body.intercurrentEvents.slice(0, VCR_QUESTION_LIMITS.events).map((entry, at) => {
        const row = object(entry)
        const event = clip(row.event, VCR_QUESTION_LIMITS.short)
        const strategy = row.strategy == null || row.strategy === '' ? null : String(row.strategy)
        if (!event) { bad(`intercurrentEvents[${at}]`, '每个中途事件要写明是什么事件（event）。'); return null }
        if (strategy !== null && !(/** @type {readonly string[]} */ (VCR_QUESTION_STRATEGIES)).includes(strategy)) {
          bad(`intercurrentEvents[${at}].strategy`, `strategy 是 ${VCR_QUESTION_STRATEGIES.join(' / ')} 之一，或先不写。`); return null
        }
        return { event, strategy, mechanism: clip(row.mechanism, VCR_QUESTION_LIMITS.short) ?? '' }
      })
      if (events.every(Boolean)) patch.intercurrentEvents = events
      if (body.intercurrentEvents.length > VCR_QUESTION_LIMITS.events) bad('intercurrentEvents', `一个问题最多写 ${VCR_QUESTION_LIMITS.events} 个中途事件。`)
    }
  }
  if ('assumptions' in body) {
    if (body.assumptions === null) patch.assumptions = null
    else if (!Array.isArray(body.assumptions)) bad('assumptions', 'assumptions 是列表，每项 { text, source }。')
    else {
      const rows = body.assumptions.slice(0, VCR_QUESTION_LIMITS.assumptions).map((entry, at) => {
        const row = object(entry)
        const text = clip(row.text, VCR_QUESTION_LIMITS.short)
        if (!text) { bad(`assumptions[${at}]`, '每条假设要写明内容（text）；来源（source）可以先空着。'); return null }
        return { text, source: clip(row.source, VCR_QUESTION_LIMITS.short) ?? '' }
      })
      if (rows.every(Boolean)) patch.assumptions = rows
      if (body.assumptions.length > VCR_QUESTION_LIMITS.assumptions) bad('assumptions', `一个问题最多写 ${VCR_QUESTION_LIMITS.assumptions} 条假设。`)
    }
  }
  return { patch, issues }
}

/** @param {unknown} value */
const empty = (value) => value == null || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && !Array.isArray(value) && Object.keys(object(value)).length === 0)
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The next state of a question under a patch written on one basis. A field written on a weaker basis than the one it holds is
 * left as it is and returned in `kept`; a field whose value does not change is not rewritten (its basis stays), and when nothing
 * changes there is no new version.
 * @param {{ version: number, fields: Record<string, any>, bases: Record<string, string> } | null} current
 * @param {Record<string, any>} patch what `normalizeQuestionPatch` returned
 * @param {string} basis one of `VCR_QUESTION_BASES`
 * @returns {{ changed: boolean, version: number, fields: Record<string, any>, bases: Record<string, string>, written: string[], kept: Array<{ field: string, basis: string }> }}
 */
export function applyQuestionPatch(current, patch, basis) {
  const rank = (/** @type {string | undefined} */ name) => VCR_QUESTION_BASES.indexOf(/** @type {string} */ (name))
  if (rank(basis) < 0) throw new TypeError(`unknown question basis: ${basis}`)
  const fields = { ...object(current?.fields) }
  const bases = { ...object(current?.bases) }
  /** @type {string[]} */
  const written = []
  /** @type {Array<{ field: string, basis: string }>} */
  const kept = []
  for (const field of Object.keys(patch)) {
    const held = bases[field]
    const incoming = patch[field]
    let next
    if (incoming === null) next = null
    else if (field in VCR_QUESTION_OBJECT_FIELDS) {
      next = { ...object(fields[field]) }
      for (const [sub, value] of Object.entries(incoming)) { if (value === null) delete next[sub]; else next[sub] = value }
    } else next = incoming
    if (empty(next)) next = null
    if (same(next, fields[field] ?? null)) continue
    if (held && rank(held) > rank(basis)) { kept.push({ field, basis: held }); continue }
    if (next === null) { delete fields[field]; delete bases[field] } else { fields[field] = next; bases[field] = basis }
    written.push(field)
  }
  const changed = written.length > 0
  return { changed, version: (current?.version ?? 0) + (changed ? 1 : 0), fields, bases, written, kept }
}

/**
 * Which of a question's intercurrent events this simulation can represent. An event whose strategy has no generator and estimator
 * in the model's capabilities is `not_representable`; one with no strategy stated is `strategy_not_stated` (the default is then the
 * model's own handling, which the premises say); both are states to read, never a refusal.
 * @param {{ fields?: Record<string, any> } | null | undefined} question
 * @param {string | null | undefined} modelId the model the result was computed with, when it has one
 * @returns {Array<{ event: string, strategy: string | null, state: 'representable' | 'not_representable' | 'strategy_not_stated' }>}
 */
export function questionRepresentability(question, modelId) {
  const strategies = /** @type {readonly string[]} */ (capabilityOf(modelId).strategies)
  return list(question?.fields?.intercurrentEvents).map(object).map((entry) => {
    const strategy = typeof entry.strategy === 'string' && entry.strategy ? entry.strategy : null
    return { event: String(entry.event ?? ''), strategy, state: strategy === null ? 'strategy_not_stated' : strategies.includes(strategy) ? 'representable' : 'not_representable' }
  })
}

/**
 * What the model's source data estimate, and whether the question asks for something else. `differs` is true when a stated event
 * uses a strategy the calibration data do not estimate (a treatment-policy question on data analysed as if the event had not
 * happened). A model with no known calibration estimand says nothing: nothing is claimed about what its data represent.
 * @param {{ fields?: Record<string, any> } | null | undefined} question @param {string | null | undefined} modelId
 * @returns {{ sentence: string, differs: boolean, strategies: string[] } | null}
 */
export function questionCalibration(question, modelId) {
  const calibration = capabilityOf(modelId).calibration
  if (!calibration) return null
  const asked = list(question?.fields?.intercurrentEvents).map(object).map((entry) => entry.strategy).filter((value) => typeof value === 'string' && value)
  return { sentence: String(calibration.sentence), differs: asked.some((strategy) => !calibration.strategies.includes(strategy)), strategies: asked }
}

/**
 * Whether a result answered an earlier version of the study's question. A result with no recorded reference, or a study with no
 * question, is not marked: nothing is said about what was never recorded.
 * @param {{ id?: string, version?: number } | null | undefined} ref the job's `questionRef`
 * @param {{ id?: string, version?: number } | null | undefined} current the question as it stands
 * @returns {{ answeredVersion: number, currentVersion: number } | null}
 */
export function questionAnswersEarlier(ref, current) {
  if (!ref || !current || ref.id !== current.id || !Number.isInteger(ref.version) || !Number.isInteger(current.version)) return null
  return /** @type {number} */ (ref.version) < /** @type {number} */ (current.version) ? { answeredVersion: /** @type {number} */ (ref.version), currentVersion: /** @type {number} */ (current.version) } : null
}

/**
 * Whether an analysis answers the effect a strategy asks for, from what each estimator uses and assumes (round-2 R26; held to the engine's
 * known-truth bias and coverage cases N110g*). Never a refusal: `conditional` names what has to hold, `not_aligned` says the analysis answers
 * another question (the engine's result carries the bias against each truth), `not_computed` is a strategy the engine has no truth for.
 * @param {{ strategy: string | null | undefined, estimator: string | null | undefined, data?: string | null }} input
 * @returns {{ state: 'conditional' | 'not_aligned' | 'not_computed', sentence: string }}
 */
export function vcrEstimandAlignment(input) {
  const strategy = String(input?.strategy ?? '')
  const estimator = String(input?.estimator ?? '')
  const reference = estimator === 'cmi_jump_to_reference' || estimator === 'cmi_copy_reference'
  const onTreatment = input?.data === 'on_treatment' || reference
  if (strategy !== 'treatment_policy' && strategy !== 'hypothetical') {
    return { state: 'not_computed', sentence: '这种处理方式这个模拟算不出真实值，所以没有按它给出偏差和覆盖率。' }
  }
  if (strategy === 'treatment_policy') {
    if (reference) return { state: 'conditional', sentence: '参照组插补假定停药后效果就消失：对只靠对症起效、停药后很快消失的药接近治疗策略的答案，对停药后仍保留的效果会低估。' }
    if (onTreatment) return { state: 'not_aligned', sentence: '这个分析只用了停药之前的数据，回答的是“假如没有人停药”的问题，不是“不论是否停药”的问题。' }
    return { state: 'conditional', sentence: '这个分析用了停药后随访到的数据；只有没随访到的人和随访到的人差不多时，它回答的才是“不论是否停药”的问题。' }
  }
  if (reference) return { state: 'not_aligned', sentence: '参照组插补让停药的人从停药起按对照组的病程走，回答的不是“假如没有人停药”的问题。' }
  if (!onTreatment) return { state: 'not_aligned', sentence: '这个分析把停药之后的数据也用了进去，回答的是“不论是否停药”的问题，不是“假如没有人停药”的问题。' }
  return { state: 'conditional', sentence: estimator === 'mmrm'
    ? '这个分析只用了停药之前的数据；停药的人与继续用药的人在前面几次随访里表现相近时，它回答的是“假如没有人停药”的问题。'
    : '这个分析只用了停药之前的数据；只有停药与病情无关时，它回答的才是“假如没有人停药”的问题。' }
}
