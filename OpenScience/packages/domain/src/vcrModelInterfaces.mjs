/**
 * The two model-package interface shapes plan §5.2 leaves room for, and the
 * card contract of the second.
 *
 * Hidden knowledge:
 *
 * - **A shape is how a model is called, not what it models.** The plan names
 *   two: (1) a baseline in, an outcome distribution under the control condition
 *   out — the shape of Unlearn's digital-twin generators, and of every model the
 *   catalogue holds today (the reference simulators and the literature models a
 *   study fits); (2) an event history up to a time in, N future trajectories
 *   out — the shape of generative event models such as Epic CoMET. Mechanistic
 *   models (QSP, PBPK) are a third matter, a model *type* with its own package
 *   contract in the engine (`vcr_mechanistic_spec_issues`), not a call shape.
 * - **Only the first shape is hosted.** No executor for the second exists in
 *   this deployment, and this module does not add one: it fixes the card a
 *   model must arrive with so that a package adopted later is a card and an
 *   executor, not a second code path. A patient set that names a model of the
 *   second shape is refused by name rather than run through a generator that is
 *   not that model (`VCR_HOSTED_MODEL_INTERFACES`).
 * - **A card with no `interfaceShape` is the first shape.** Every card written
 *   before this module existed is one, and none is asked for anything new.
 * - **The second shape's card says what it reads, what it returns, where it
 *   holds, what it was validated on and where it fails** — the six things the
 *   plan's model card lists, made explicit for a model whose output is a set of
 *   sampled futures rather than a column of outcomes:
 *   - *inputs* — the event types and per-event fields of the history it reads,
 *     and the shortest history it accepts. A history is read as of a time and
 *     nothing after it.
 *   - *output semantics* — N trajectories are draws from a predictive
 *     distribution, exchangeable and seeded; they are not a forecast of what
 *     one person will do, and a summary over them carries its Monte-Carlo
 *     error. Events that end a trajectory are named.
 *   - *scope of applicability* — population, region, the events it can
 *     project, the longest horizon and the most trajectories per history.
 *   - *version* — immutable, like every model row.
 *   - *validation* — what was measured, on which data (calibration, interval
 *     coverage, CRPS, temporal validation).
 *   - *limitations* — what it is known not to do.
 * - **The check never withholds.** A card short of the contract is reported
 *   field by field; the applicability check then declines to answer for it
 *   (a model that does not say what it covers cannot be checked against what a
 *   study asks), and every other result of the study goes on.
 *
 * @module @evimed/domain/vcrModelInterfaces
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/** The two call shapes of plan §5.2. */
export const VCR_MODEL_INTERFACES = frozen(['baseline_to_outcome', 'event_history_to_trajectories'])
export const VCR_MODEL_INTERFACE_LABELS_ZH = Object.freeze({
  baseline_to_outcome: '基线 → 结局分布',
  event_history_to_trajectories: '事件历史 → 未来轨迹',
})
/** What a card without an `interfaceShape` is. */
export const VCR_DEFAULT_MODEL_INTERFACE = 'baseline_to_outcome'
/** The shapes this deployment has an executor for. Adding a word here is adding the executor first. */
export const VCR_HOSTED_MODEL_INTERFACES = frozen(['baseline_to_outcome'])

/** The time units a horizon is stated in, with the days each stands for (a month is the mean Gregorian month). */
export const VCR_HORIZON_UNIT_DAYS = Object.freeze({ days: 1, weeks: 7, months: 30.4375, years: 365.25 })

/**
 * The fields the second shape's card must hold, each with the reader's words
 * and where it lives on the model row. The paths are what an issue names.
 */
export const VCR_EVENT_HISTORY_CARD_FIELDS = Object.freeze([
  { path: 'card.inputs', zh: '输入（模型读取什么）' },
  { path: 'card.outputs', zh: '输出的含义（轨迹是什么、不是什么）' },
  { path: 'card.history.eventTypes', zh: '它读取的事件类型' },
  { path: 'card.history.fields', zh: '每条事件必须带的字段' },
  { path: 'card.trajectories.max', zh: '每份历史最多生成的轨迹数' },
  { path: 'card.trajectories.absorbing', zh: '会终止轨迹的事件' },
  { path: 'applicability.population', zh: '适用人群' },
  { path: 'applicability.eventTypes', zh: '它能推演的事件类型' },
  { path: 'applicability.horizon', zh: '最长推演时间（数值与单位）' },
  { path: 'validation', zh: '验证（至少一项，说明测了什么）' },
  { path: 'card.knownLimits', zh: '已知局限' },
  { path: 'version', zh: '版本' },
])

/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : [])
/** @param {unknown} value */
const words = (value) => list(value).map((entry) => String(entry ?? '').trim()).filter(Boolean)

/**
 * Which shape a model row declares: its card's `interfaceShape` when that is
 * one of the two, the default when it says nothing, `null` when it says a word
 * the vocabulary does not have (the caller names it).
 * @param {Record<string, any>} model
 * @returns {string | null}
 */
export function vcrModelInterfaceOf(model) {
  const declared = object(model?.card).interfaceShape
  if (declared == null || declared === '') return VCR_DEFAULT_MODEL_INTERFACE
  return VCR_MODEL_INTERFACES.includes(declared) ? String(declared) : null
}

/**
 * Whether the card of a model of the second shape holds each field of the
 * contract. A model of the first shape has no contract to be short of.
 * @param {Record<string, any>} model a row of the model library
 * @returns {Array<{ code: string, field: string, text: string }>}
 */
export function vcrModelCardIssues(model) {
  const shape = vcrModelInterfaceOf(model)
  if (shape === null) {
    return [{ code: 'interface_unknown', field: 'card.interfaceShape',
      text: `接口形状要写 ${VCR_MODEL_INTERFACES.join('、')} 之一，这张卡写的是「${String(object(model?.card).interfaceShape).slice(0, 60)}」` }]
  }
  if (shape !== 'event_history_to_trajectories') return []
  const card = object(model?.card)
  const applicability = object(model?.applicability)
  const validation = object(model?.validation)
  const horizon = object(applicability.horizon)
  /** @type {Record<string, boolean>} */
  const held = {
    'card.inputs': words(card.inputs).length > 0,
    'card.outputs': typeof card.outputs === 'string' && card.outputs.trim().length > 0,
    'card.history.eventTypes': words(object(card.history).eventTypes).length > 0,
    'card.history.fields': words(object(card.history).fields).length > 0,
    'card.trajectories.max': Number.isInteger(object(card.trajectories).max) && object(card.trajectories).max >= 1,
    'card.trajectories.absorbing': Array.isArray(object(card.trajectories).absorbing),
    'applicability.population': typeof applicability.population === 'string' && applicability.population.trim().length > 0,
    'applicability.eventTypes': words(applicability.eventTypes).length > 0,
    'applicability.horizon': Number.isFinite(horizon.max) && horizon.max > 0 && Object.hasOwn(VCR_HORIZON_UNIT_DAYS, String(horizon.unit)),
    validation: Object.keys(validation).some((key) => key !== 'declaredEvidence'),
    'card.knownLimits': words(card.knownLimits).length > 0,
    version: typeof model?.version === 'string' && model.version.trim().length > 0,
  }
  return VCR_EVENT_HISTORY_CARD_FIELDS.filter((field) => !held[field.path]).map((field) => ({
    code: 'interface_field_missing', field: field.path, text: `事件历史 → 未来轨迹接口的模型卡缺「${field.zh}」`,
  }))
}

/**
 * What a study asks of an event-history model, held against what the model
 * declares it covers: the events the study wants projected, how far ahead and
 * how many trajectories per history. Pure; the caller supplies only what the
 * study states, and a limit the study does not state is not checked.
 * @param {Record<string, any>} model a row of the model library
 * @param {{ horizon?: { value: number, unit: string } | null, eventTypes?: readonly string[], trajectories?: number | null }} [asked]
 * @returns {Array<{ code: string, field: string, text: string }>}
 */
export function vcrEventHistoryScopeIssues(model, asked = {}) {
  if (vcrModelInterfaceOf(model) !== 'event_history_to_trajectories') return []
  const applicability = object(model?.applicability)
  const card = object(model?.card)
  /** @type {Array<{ code: string, field: string, text: string }>} */
  const issues = []
  const horizon = asked.horizon
  const limit = object(applicability.horizon)
  if (horizon && Number.isFinite(horizon.value) && Number.isFinite(limit.max) && Object.hasOwn(VCR_HORIZON_UNIT_DAYS, String(limit.unit))) {
    const unit = /** @type {Record<string, number>} */ (VCR_HORIZON_UNIT_DAYS)[horizon.unit]
    if (unit === undefined) {
      issues.push({ code: 'horizon_unit_unknown', field: 'horizon', text: `推演时间的单位要写 ${Object.keys(VCR_HORIZON_UNIT_DAYS).join('、')} 之一` })
    } else if (horizon.value * unit > limit.max * /** @type {Record<string, number>} */ (VCR_HORIZON_UNIT_DAYS)[limit.unit]) {
      issues.push({ code: 'horizon_exceeded', field: 'horizon', text: `研究要推演 ${horizon.value} ${horizon.unit}，超出了它声明的最长 ${limit.max} ${limit.unit}` })
    }
  }
  const covered = new Set(words(applicability.eventTypes))
  for (const type of words(asked.eventTypes)) {
    if (covered.size && !covered.has(type)) issues.push({ code: 'event_type_not_covered', field: 'eventTypes', text: `它不推演「${type}」这类事件` })
  }
  const most = object(card.trajectories).max
  if (Number.isFinite(asked.trajectories) && Number.isFinite(most) && Number(asked.trajectories) > most) {
    issues.push({ code: 'trajectory_count_exceeded', field: 'trajectories', text: `研究要 ${asked.trajectories} 条轨迹，超出了它声明的每份历史最多 ${most} 条` })
  }
  return issues
}
