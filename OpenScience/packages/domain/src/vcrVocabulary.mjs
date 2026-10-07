/**
 * 「虚拟临研」's closed vocabularies (build plan 2026-09-28 §3.5, §3.6, §4, §8.2, §11.3).
 *
 * Hidden knowledge:
 *
 * - **One list per word, read by everyone.** The control plane's schema CHECKs,
 *   the routes' validation, the runtime gateway's per-item checks, the MCP
 *   tools' schemas, the engine's scenario validator and the page's labels all
 *   derive from these arrays. 「循证传播」 learned this the expensive way: a
 *   second copy is the one that drifts, and the drift shows up as a row the
 *   ledger refuses.
 * - **Nine value sources, not seven.** The owner's v1.0 had seven; literature
 *   parameterization adds `aggregate` (a published summary statistic) and
 *   `reconstructed` (pseudo-individual rows digitized from a published curve).
 *   They exist so the two rules that protect every number downstream can be
 *   stated in code: an aggregate never joins a weighting as if it were an
 *   individual, and a reconstructed row is never counted as an observed
 *   patient, nor drawn as a measured curve (plan §3.5, §5.3).
 * - **Three states that never substitute for each other** (§3.6): the run
 *   state is the platform's (it reuses `states.mjs`), the scientific
 *   conclusion is the method's own diagnosis, and the review state is a
 *   countersignature on one version. "Finished" is not "sound", and "sound" is
 *   not "reviewed".
 * - **`not_applicable` is not a criterion state.** A criterion that cannot
 *   apply to this patient (pregnancy for a man) is an applicability flag
 *   beside the three-valued judgment, because folding it into `unknown` is one
 *   of the two errors TrialGPT's own error analysis names (plan §7.1).
 * - **Intended use is a ceiling, not a badge.** `intendedUseCeiling` takes the
 *   model risks actually used and answers the highest use the evidence carries
 *   (§8.2). Nothing is blocked; the result is labelled down and told why.
 * - Labels are UI text (Simplified Chinese); ids never reach a reader.
 *
 * @module @evimed/domain/vcrVocabulary
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

// ---------------------------------------------------------------------------
// Provenance: where a number came from (§3.5)
// ---------------------------------------------------------------------------

/** The nine value-level source labels. Every displayed number carries one. */
export const VCR_VALUE_SOURCES = frozen([
  'observed', 'extracted', 'calculated', 'imputed', 'aggregate', 'reconstructed', 'predicted', 'assumed', 'synthetic',
])
export const VCR_VALUE_SOURCE_LABELS_ZH = Object.freeze({
  observed: '观察', extracted: '抽取', calculated: '计算', imputed: '插补', aggregate: '汇总',
  reconstructed: '重建', predicted: '预测', assumed: '假设', synthetic: '合成',
})
/** Sources that are a record of a real person: they may enter `realPatients`. */
export const VCR_REAL_PATIENT_SOURCES = frozen(['observed', 'extracted', 'calculated', 'imputed'])
/** Sources a real external-control route refuses outright (plan §5.1, §5.3). */
export const VCR_NON_INDIVIDUAL_SOURCES = frozen(['aggregate', 'synthetic', 'predicted'])

/**
 * The source of ONE COLUMN of a real person's table, most direct first. A column
 * of a real source is still a real person's value, so these are exactly the
 * real-patient sources, and their order is a judgment made once: a recorded value
 * beats a transcription of one, a transcription beats a deterministic computation
 * from others, and a computed value beats one filled in by a declared method. A
 * table is labelled with the weakest of its columns; a RESULT is labelled with
 * the weakest of the columns its method actually used (`vcrWeakestSource`), so
 * one imputed column that nothing read does not mark the result imputed.
 */
export const VCR_COLUMN_SOURCES = VCR_REAL_PATIENT_SOURCES

/**
 * The least direct of `sources` (the last in `VCR_COLUMN_SOURCES`), or `fallback`
 * for none. A source outside the real-patient four (a synthetic or aggregate
 * table has no per-column sources) is returned as it is, so a caller cannot
 * launder it by listing it beside observed ones. `R/inputs.R` mirrors this.
 * @param {Iterable<string>} sources @param {string} fallback
 */
export function vcrWeakestSource(sources, fallback) {
  const list = [...sources]
  if (!list.length) return fallback
  const outside = list.find((source) => !VCR_COLUMN_SOURCES.includes(source))
  if (outside) return outside
  return list.reduce((weakest, source) => (VCR_COLUMN_SOURCES.indexOf(source) > VCR_COLUMN_SOURCES.indexOf(weakest) ? source : weakest))
}

/**
 * How a column source is spelled in the standards an export has to meet, kept
 * here and never in the engine (the engine states a source; a deliverable states
 * how a regulator reads it). Verified against the NCI EVS terminology files
 * (2026-10-04, last modified 2026-09-25):
 *
 * - **Define-XML** carries one provenance word per variable, the Origin Type
 *   (codelist C170449, ORIGINT): `Collected` (C170548, "a value that is actually
 *   observed and recorded by a person or obtained by an instrument"), `Derived`
 *   (C170549, "a value that is calculated by an algorithm or reproducible rule,
 *   and which is dependent upon other data values") and `Other` (C17649). It has
 *   NO "imputed" and NO "extracted" term.
 * - **ADaM** words an imputed value as a derived one: the record-level
 *   Derivation Type (DTYPE, codelist C81224, extensible) names the imputation
 *   technique (LOCF, WOCF, MI ...), and the algorithm goes into the variable's
 *   method. So `imputed` exports as `Derived` plus a DTYPE whose value is the
 *   imputation method's own term (`adamDerivation.value: null` here: only the
 *   analysis knows the method).
 * - **Extracted** (read from unstructured text by a person or a model) has no
 *   CDISC term; it exports as `Other` and the variable's description says how it
 *   was extracted (`describe: true`).
 *
 * `describe` marks the entries whose export must also carry a sentence.
 */
export const VCR_COLUMN_SOURCE_EXPORT = Object.freeze({
  observed: Object.freeze({
    defineXmlOrigin: Object.freeze({ term: 'Collected', code: 'C170548' }), adamDerivation: null, describe: false,
  }),
  extracted: Object.freeze({
    defineXmlOrigin: Object.freeze({ term: 'Other', code: 'C17649' }), adamDerivation: null, describe: true,
  }),
  calculated: Object.freeze({
    defineXmlOrigin: Object.freeze({ term: 'Derived', code: 'C170549' }), adamDerivation: null, describe: false,
  }),
  imputed: Object.freeze({
    defineXmlOrigin: Object.freeze({ term: 'Derived', code: 'C170549' }),
    adamDerivation: Object.freeze({ variable: 'DTYPE', codelist: 'C81224', extensible: true, value: null }), describe: true,
  }),
})

/**
 * The four counts that must be shown apart wherever a sample size appears
 * (§3.5), plus the two that appear only when their route is used.
 */
export const VCR_COUNT_KEYS = frozen(['realPatients', 'events', 'effectiveSampleSize', 'generatedRecords'])
export const VCR_OPTIONAL_COUNT_KEYS = frozen(['priorEffectiveSampleSize', 'reconstructedPseudoPatients'])
export const VCR_COUNT_LABELS_ZH = Object.freeze({
  realPatients: '真实患者数', events: '事件数', effectiveSampleSize: '有效样本量', generatedRecords: '生成记录数',
  priorEffectiveSampleSize: '先验有效样本量', reconstructedPseudoPatients: '重建伪个体数',
})

/** Why a value is missing (§8.1). "Unknown treatment" is never "no treatment". */
export const VCR_MISSING_REASONS = frozen([
  'not_measured', 'not_recorded', 'not_shared', 'restricted_in_trial', 'out_of_window', 'pending_result', 'not_applicable',
])
export const VCR_MISSING_REASON_LABELS_ZH = Object.freeze({
  not_measured: '未测量', not_recorded: '未记录', not_shared: '未共享', restricted_in_trial: '试验期间受限',
  out_of_window: '在观察窗外', pending_result: '待出结果', not_applicable: '不适用',
})

/** The three clocks every fact carries (§8.1). */
export const VCR_TIME_KINDS = frozen(['occurred_at', 'recorded_at', 'visible_at'])
export const VCR_TIME_KIND_LABELS_ZH = Object.freeze({ occurred_at: '发生时间', recorded_at: '记录时间', visible_at: '平台可见时间' })

// ---------------------------------------------------------------------------
// The three states (§3.6)
// ---------------------------------------------------------------------------

/** What the method itself says about the estimate. "Not estimable" is a finished result. */
export const VCR_CONCLUSIONS = frozen(['estimable', 'limited', 'not_estimable'])
export const VCR_CONCLUSION_LABELS_ZH = Object.freeze({ estimable: '可估计', limited: '有限制地估计', not_estimable: '不可估计' })

/** A countersignature on one version, never a gate (§10.2). */
export const VCR_REVIEW_STATES = frozen(['ai_set', 'reviewed', 'changed_after_review'])
export const VCR_REVIEW_STATE_LABELS_ZH = Object.freeze({ ai_set: 'AI 设定', reviewed: '已复核', changed_after_review: '复核后有变更' })
/** Who may countersign (§10.2). */
export const VCR_REVIEWER_KINDS = frozen(['ai', 'human'])
export const VCR_REVIEW_LIFECYCLE = frozen(['queued', 'running', 'done', 'failed'])
export const VCR_REVIEW_KINDS = frozen(['clinical', 'statistical', 'data'])
export const VCR_REVIEW_KIND_LABELS_ZH = Object.freeze({ clinical: '临床复核', statistical: '统计复核', data: '数据复核' })

// ---------------------------------------------------------------------------
// Use, model tier and model risk (§3.6, §8.2)
// ---------------------------------------------------------------------------

/** The four intended uses, weakest first. */
export const VCR_INTENDED_USES = frozen(['exploratory', 'design_support', 'specified_analysis', 'submission_preparation'])
export const VCR_INTENDED_USE_LABELS_ZH = Object.freeze({
  exploratory: '探索', design_support: '研究设计支持', specified_analysis: '指定研究分析', submission_preparation: '申报准备',
})

/** How much evidence a model itself carries, weakest first. */
export const VCR_MODEL_TIERS = frozen(['scenario', 'literature', 'data', 'validated'])
export const VCR_MODEL_TIER_LABELS_ZH = Object.freeze({ scenario: '情景模型', literature: '文献模型', data: '数据模型', validated: '验证模型' })

/** Model risk = the model's share of the decision × the cost of being wrong (ICH M15 / ASME V&V 40). */
export const VCR_MODEL_RISKS = frozen(['none', 'low', 'medium', 'high'])
export const VCR_MODEL_RISK_LABELS_ZH = Object.freeze({ none: '无（参考仿真）', low: '低', medium: '中', high: '高' })

/** The highest intended use a model of each tier can carry (§8.2 table). */
export const VCR_MODEL_TIER_USE_CEILING = Object.freeze({
  scenario: 'exploratory',
  literature: 'design_support',
  data: 'specified_analysis',
  validated: 'submission_preparation',
})

/** The evidence each model risk demands before a result may claim its use (§8.2). */
export const VCR_MODEL_RISK_EVIDENCE = Object.freeze({
  none: frozen(['code_verification', 'seed_reproducible']),
  low: frozen(['code_verification', 'seed_reproducible', 'input_traceable', 'sensitivity_analysis']),
  medium: frozen(['code_verification', 'seed_reproducible', 'input_traceable', 'sensitivity_analysis',
    'external_validation', 'model_locked', 'model_analysis_plan']),
  high: frozen(['code_verification', 'seed_reproducible', 'input_traceable', 'sensitivity_analysis',
    'external_validation', 'model_locked', 'model_analysis_plan', 'prospective_validation', 'independent_review',
    'regulatory_contact']),
})

/**
 * The highest use a result may be labelled with, given the tiers of every
 * model it used. The weakest model decides (§8.2); an empty list means no
 * model was involved at all, which is `submission_preparation`-capable as far
 * as models go (the study's own review state still applies).
 * @param {readonly string[]} tiers
 * @returns {string}
 */
export function intendedUseCeiling(tiers) {
  let ceiling = VCR_INTENDED_USES.length - 1
  for (const tier of tiers ?? []) {
    const use = VCR_MODEL_TIER_USE_CEILING[/** @type {keyof typeof VCR_MODEL_TIER_USE_CEILING} */ (tier)]
    const index = VCR_INTENDED_USES.indexOf(use)
    if (index >= 0 && index < ceiling) ceiling = index
  }
  return VCR_INTENDED_USES[ceiling]
}

/**
 * Is `use` within `ceiling`?
 * @param {string} use @param {string} ceiling
 */
export function useWithin(use, ceiling) {
  const a = VCR_INTENDED_USES.indexOf(use)
  const b = VCR_INTENDED_USES.indexOf(ceiling)
  return a >= 0 && b >= 0 && a <= b
}

/**
 * The use each model risk is evidence for (plan §8.2's fourth column).
 * Weakest risk first, so an index doubles as a strength.
 */
export const VCR_RISK_USE_CEILING = Object.freeze({
  none: 'exploratory',
  low: 'design_support',
  medium: 'specified_analysis',
  high: 'submission_preparation',
})

/**
 * One model's ceiling, and what set it.
 *
 * - **Tier** (§3.6): the most a model of that kind can carry, whatever evidence
 *   it holds. An unknown tier is a `scenario` model — the weakest — because a
 *   word nobody recognises has earned nothing.
 * - **Risk** (§8.2): the model's declared risk in this use. An unknown risk
 *   counts as `high`, the most demanding, so a typo cannot make a model look
 *   cheap to trust.
 * - **Evidence**: the highest risk level whose evidence set the model card
 *   actually holds (each set contains the one below), read as the use that
 *   evidence supports. A model declared `high` that holds only the `low`
 *   evidence is labelled `low`'s use, and the missing items are what the result
 *   says (AC-34). Nothing is blocked.
 *
 * The ceiling is the lowest of the three.
 * @param {{ tier?: unknown, risk?: unknown, evidence?: readonly string[] | null }} model
 */
function modelCeiling(model) {
  const tier = VCR_MODEL_TIERS.includes(/** @type {string} */ (model?.tier)) ? /** @type {string} */ (model.tier) : 'scenario'
  const declared = VCR_MODEL_RISKS.includes(/** @type {string} */ (model?.risk)) ? /** @type {string} */ (model.risk) : 'high'
  const held = new Set(model?.evidence ?? [])
  let supported = 0
  VCR_MODEL_RISKS.forEach((risk, index) => {
    const needed = VCR_MODEL_RISK_EVIDENCE[/** @type {keyof typeof VCR_MODEL_RISK_EVIDENCE} */ (risk)]
    if (needed.every((item) => held.has(item))) supported = index
  })
  const declaredIndex = VCR_MODEL_RISKS.indexOf(declared)
  const riskIndex = Math.min(declaredIndex, supported)
  const tierUse = VCR_MODEL_TIER_USE_CEILING[/** @type {keyof typeof VCR_MODEL_TIER_USE_CEILING} */ (tier)]
  const riskUse = VCR_RISK_USE_CEILING[/** @type {keyof typeof VCR_RISK_USE_CEILING} */ (VCR_MODEL_RISKS[riskIndex])]
  const tierIndex = VCR_INTENDED_USES.indexOf(tierUse)
  const riskUseIndex = VCR_INTENDED_USES.indexOf(riskUse)
  const use = VCR_INTENDED_USES[Math.min(tierIndex, riskUseIndex)]
  /** @type {'tier' | 'evidence' | 'declared_risk'} */
  const cause = tierIndex <= riskUseIndex ? 'tier' : supported < declaredIndex ? 'evidence' : 'declared_risk'
  return {
    tier, declaredRisk: declared, supportedRisk: VCR_MODEL_RISKS[supported], use, cause,
    missing: missingModelEvidence(declared, /** @type {readonly string[]} */ ([...held])),
  }
}

/**
 * The highest use a result may be labelled with, from the models it used
 * (plan §8.2, AC-34): each model's ceiling is the lowest of its tier's, its
 * declared risk's and what its held evidence supports, and the weakest model
 * decides. `tiers` is the older, tier-only input (every entry counts as a model
 * with no evidence beyond its tier); no models at all is `submission_preparation`
 * as far as models go — the study's own review state still applies.
 * @param {{ tiers?: readonly string[], models?: readonly { tier?: unknown, risk?: unknown, evidence?: readonly string[] | null }[] }} [input]
 * @returns {{ ceiling: string, limitedBy: readonly { index: number, cause: string, tier: string, declaredRisk: string, supportedRisk: string, use: string, missing: readonly string[] }[] }}
 */
export function intendedUseCeilingDetail({ tiers = [], models = [] } = {}) {
  let ceiling = VCR_INTENDED_USES.length - 1
  /** @type {{ index: number, cause: string, tier: string, declaredRisk: string, supportedRisk: string, use: string, missing: readonly string[] }[]} */
  const limitedBy = []
  for (const tier of tiers ?? []) {
    const index = VCR_INTENDED_USES.indexOf(VCR_MODEL_TIER_USE_CEILING[/** @type {keyof typeof VCR_MODEL_TIER_USE_CEILING} */ (tier)] ?? VCR_MODEL_TIER_USE_CEILING.scenario)
    if (index < ceiling) ceiling = index
  }
  ;(models ?? []).forEach((model, index) => {
    const one = modelCeiling(model)
    const at = VCR_INTENDED_USES.indexOf(one.use)
    if (at < VCR_INTENDED_USES.length - 1) limitedBy.push({ index, cause: one.cause, tier: one.tier, declaredRisk: one.declaredRisk, supportedRisk: one.supportedRisk, use: one.use, missing: one.missing })
    if (at < ceiling) ceiling = at
  })
  return { ceiling: VCR_INTENDED_USES[ceiling], limitedBy: Object.freeze(limitedBy) }
}

/**
 * The ceiling alone: see `intendedUseCeilingDetail` for what set it.
 * @param {Parameters<typeof intendedUseCeilingDetail>[0]} [input]
 * @returns {string}
 */
export function intendedUseCeilingFor(input) {
  return intendedUseCeilingDetail(input).ceiling
}

/**
 * Which evidence items are missing for a model risk, given what a model card
 * declares. Never blocks: the caller labels the result down and says why.
 * @param {string} risk @param {readonly string[]} evidence
 */
export function missingModelEvidence(risk, evidence) {
  const required = VCR_MODEL_RISK_EVIDENCE[/** @type {keyof typeof VCR_MODEL_RISK_EVIDENCE} */ (risk)] ?? []
  const held = new Set(evidence ?? [])
  return frozen(required.filter((item) => !held.has(item)))
}

/** A model may be called 「数字孪生」 only with all four (NASEM 2023; plan §5.2). */
export const VCR_TWIN_EVIDENCE = frozen(['individual_conditioned', 'updates_with_new_data', 'calibrated_uncertainty', 'validation_record'])
/**
 * `digital_twin` when all four hold, `baseline_conditioned_prediction` otherwise.
 * The label is derived, never granted by hand (§5.2).
 * @param {readonly string[]} evidence
 */
export function twinLabel(evidence) {
  const held = new Set(evidence ?? [])
  return VCR_TWIN_EVIDENCE.every((item) => held.has(item)) ? 'digital_twin' : 'baseline_conditioned_prediction'
}
export const VCR_TWIN_LABELS_ZH = Object.freeze({ digital_twin: '数字孪生', baseline_conditioned_prediction: '基线条件化预测' })

// ---------------------------------------------------------------------------
// The study: tiers, steps, workspaces (§3.2, §4, §9.4)
// ---------------------------------------------------------------------------

/** What data the study has. Every module works at T0 (§3.2). */
export const VCR_DATA_TIERS = frozen(['T0', 'T1', 'T2', 'T3'])
export const VCR_DATA_TIER_LABELS_ZH = Object.freeze({
  T0: 'T0 公开资料', T1: 'T1 基线与招募资料', T2: 'T2 完整治疗与纵向结局', T3: 'T3 随机试验个体数据',
})

/** What each tier above T0 lets a study do that the one below it does not (§3.2) — the words an offer to move up says. */
export const VCR_DATA_TIER_UNLOCKS_ZH = Object.freeze({
  T1: '用你的数据筛真实队列、做患者匹配与招募',
  T2: '走真实外部对照，用真实结局分布做仿真',
})

/**
 * The highest data tier the analysis tables a study has frozen can claim (§3.2,
 * §8.1) — read from what the data plane derived, never from a person's word or
 * a model's, and never from a value of a sealed column:
 *
 * - **T1** — a subject table of a real source (`VCR_REAL_PATIENT_SOURCES`) with
 *   rows: baseline records of real people.
 * - **T2** — T1, and the subject table says treatment was recorded for someone
 *   (`derivedFrom.treatment`, which the plane writes from the field map's arm
 *   column and its missing reasons), and a real table carries an outcome. A
 *   partner's trial-period data, where treatment is `not_shared`, stays T1.
 * - **T3** is not derived: that the people were randomized is a fact about how
 *   the data were collected, which no column map can say. It is the lead's to
 *   declare, on data that qualifies as T2.
 *
 * Synthetic, aggregate, predicted and assumed tables are not people and never
 * count. Pure: the tables are the plane's registered rows (`shape`, `rowCount`,
 * `outcomeBearing`, `valueSource`, `derivedFrom`), not their contents.
 * @param {ReadonlyArray<unknown> | null | undefined} tables
 * @returns {{ tier: 'T0' | 'T1' | 'T2', subjects: number, treatment: boolean, outcomes: boolean }}
 */
export function vcrTierSupportedBy(tables) {
  /** @type {Array<Record<string, any>>} */
  const real = (Array.isArray(tables) ? tables : []).filter((/** @type {any} */ table) => (
    table && typeof table === 'object' && VCR_REAL_PATIENT_SOURCES.includes(table.valueSource) && Number(table.rowCount) > 0))
  const subjects = real.filter((table) => table.shape === 'subject')
  if (!subjects.length) return { tier: 'T0', subjects: 0, treatment: false, outcomes: false }
  const treatment = subjects.some((table) => Object.values(table.derivedFrom?.treatment ?? {}).some((entry) => Number(entry?.recorded) > 0))
  const outcomes = real.some((table) => table.outcomeBearing === true)
  return {
    tier: treatment && outcomes ? 'T2' : 'T1',
    subjects: Math.max(...subjects.map((table) => Number(table.rowCount))),
    treatment, outcomes,
  }
}

/**
 * The data a claim to a tier needs: T3 is the lead's declaration over data that
 * qualifies as T2, every other tier needs its own.
 * @param {string} tier
 */
export function vcrTierNeedsSupport(tier) {
  return tier === 'T3' ? 'T2' : tier
}

/**
 * Whether the data can support a study claiming `tier`.
 * @param {string} tier @param {string} supported what `vcrTierSupportedBy` answered
 */
export function vcrTierIsSupported(tier, supported) {
  const need = VCR_DATA_TIERS.indexOf(vcrTierNeedsSupport(tier))
  return need >= 0 && VCR_DATA_TIERS.indexOf(supported) >= need
}

/**
 * The move a study's frozen data offers: the highest tier it supports when that
 * is above where the study stands, with what each tier on the way unlocks.
 * Null when the data supports nothing more. It only ever offers a rise: lowering
 * a tier is the lead's explicit act and never the platform's.
 * @param {string} current the study's tier @param {{ tier?: string } | null | undefined} support what `vcrTierSupportedBy` answered
 * @returns {{ tier: string, unlocks: string[] } | null}
 */
export function vcrTierOffer(current, support) {
  const from = VCR_DATA_TIERS.indexOf(current)
  const to = VCR_DATA_TIERS.indexOf(String(support?.tier ?? ''))
  if (from < 0 || to <= from) return null
  const unlocks = VCR_DATA_TIERS.slice(from + 1, to + 1)
    .map((tier) => /** @type {Record<string, string>} */ (VCR_DATA_TIER_UNLOCKS_ZH)[tier]).filter(Boolean)
  return { tier: VCR_DATA_TIERS[to], unlocks }
}

/** The seven steps, in order (§4). A study page's progress rail is this list. */
export const VCR_STEPS = frozen(['definition', 'evidence', 'population', 'patients', 'comparator', 'trial', 'matching'])
export const VCR_STEP_LABELS_ZH = Object.freeze({
  definition: '定义', evidence: '证据', population: '人群', patients: '患者', comparator: '对照', trial: '试验', matching: '匹配',
})
/** A step's state, on the study record (`studies.steps`). */
export const VCR_STEP_STATUSES = frozen(['none', 'queued', 'running', 'done', 'minimal', 'stale', 'failed'])
export const VCR_STEP_STATUS_LABELS_ZH = Object.freeze({
  none: '未开始', queued: '排队中', running: '进行中', done: '已完成', minimal: 'AI 最小版本', stale: '已过期', failed: '未完成',
})
/** What each step needs before it can run (the orchestrator's `NEEDS`). */
export const VCR_STEP_NEEDS = Object.freeze({
  definition: frozen([]),
  evidence: frozen(['definition']),
  population: frozen(['definition']),
  patients: frozen(['population']),
  comparator: frozen(['definition']),
  trial: frozen(['definition']),
  matching: frozen(['definition']),
})

/** The seven tabs of a study page, in order (§9.4). The design spec caps this at seven. */
export const VCR_TABS = frozen(['overview', 'population', 'patients', 'comparator', 'trial', 'matching', 'data'])
export const VCR_TAB_LABELS_ZH = Object.freeze({
  overview: '总览', population: '人群', patients: '虚拟患者', comparator: '对照', trial: '试验',
  matching: '匹配与招募', data: '数据与证据',
})

/** The four action cards on the module's home page (§9.2), and where each starts. */
export const VCR_ACTIONS = frozen(['cohort', 'patients', 'comparator', 'trial'])
export const VCR_ACTION_LABELS_ZH = Object.freeze({
  cohort: '创建虚拟队列', patients: '创建虚拟患者', comparator: '构建合成对照', trial: '模拟临床试验',
})

/** A study's lifecycle on the list page. */
export const VCR_STUDY_STATUSES = frozen(['active', 'paused', 'archived'])
export const VCR_STUDY_STATUS_LABELS_ZH = Object.freeze({ active: '进行中', paused: '已暂停', archived: '已归档' })

// ---------------------------------------------------------------------------
// Members and access (§11.1 conclusion 4, §11.2 layer 2)
// ---------------------------------------------------------------------------

/** Study-level roles. Deliberately not an organization model (§11.1). */
export const VCR_MEMBER_ROLES = frozen(['lead', 'clinical_reviewer', 'statistical_reviewer', 'data_manager', 'recruiter', 'site', 'viewer'])
export const VCR_MEMBER_ROLE_LABELS_ZH = Object.freeze({
  lead: '研究负责人', clinical_reviewer: '临床复核', statistical_reviewer: '统计复核', data_manager: '数据管理',
  recruiter: '招募协调员', site: '中心', viewer: '只读查看者',
})
/** What a role may do. Checked in code, per operation (platform principle 14). */
export const VCR_ROLE_ABILITIES = Object.freeze({
  lead: frozen(['read', 'write', 'run', 'export', 'manage_members', 'manage_study', 'manage_data', 'review_any', 'contact_patients', 'read_patient_level']),
  clinical_reviewer: frozen(['read', 'review_clinical', 'export']),
  statistical_reviewer: frozen(['read', 'review_statistical', 'export']),
  data_manager: frozen(['read', 'write', 'run', 'manage_data', 'read_patient_level']),
  recruiter: frozen(['read', 'write_referrals', 'contact_patients']),
  site: frozen(['read_referrals', 'write_referrals']),
  viewer: frozen(['read']),
})
/**
 * @param {string} role @param {string} ability
 */
export function roleAllows(role, ability) {
  return (VCR_ROLE_ABILITIES[/** @type {keyof typeof VCR_ROLE_ABILITIES} */ (role)] ?? []).includes(ability)
}

// ---------------------------------------------------------------------------
// Populations, patients, comparators, trials (§5)
// ---------------------------------------------------------------------------

/** Where a population came from (§5.1: five starting points → four kinds). */
export const VCR_POPULATION_KINDS = frozen(['real', 'scenario', 'literature', 'empirical_synthetic'])
export const VCR_POPULATION_KIND_LABELS_ZH = Object.freeze({
  real: '真实队列', scenario: '情景人群', literature: '文献人群', empirical_synthetic: '经验合成人群',
})
/** What a synthetic population may be used for (§5.1). It never enters a real external control. */
export const VCR_SYNTHETIC_USES = frozen(['design', 'feasibility', 'testing', 'training', 'shared_preview'])
export const VCR_SYNTHETIC_USE_LABELS_ZH = Object.freeze({
  design: '设计', feasibility: '可行性', testing: '测试', training: '培训', shared_preview: '共享预览',
})

/** The three endpoint families every engine method is organized by (§5.2, §5.3). */
export const VCR_ENDPOINT_TYPES = frozen(['continuous', 'binary', 'time_to_event'])
export const VCR_ENDPOINT_TYPE_LABELS_ZH = Object.freeze({ continuous: '连续', binary: '二分类', time_to_event: '事件时间' })

/** The five comparator routes, ordered by precedent and data demand (§5.3). */
export const VCR_COMPARATOR_ROUTES = frozen(['prognostic_adjustment', 'external_control', 'literature_control', 'model_comparator', 'hybrid_control'])
export const VCR_COMPARATOR_ROUTE_LABELS_ZH = Object.freeze({
  prognostic_adjustment: '预后校正', external_control: '真实外部对照', literature_control: '文献对照',
  model_comparator: '模型预测比较器', hybrid_control: '混合对照',
})
/** The data tier each route needs at minimum. */
export const VCR_ROUTE_MIN_TIER = Object.freeze({
  prognostic_adjustment: 'T3', external_control: 'T2', literature_control: 'T0', model_comparator: 'T0', hybrid_control: 'T0',
})
/** The estimand a weighted external control answers unless told otherwise (§5.3). */
export const VCR_ESTIMANDS = frozen(['ATT', 'ATE', 'ATO'])
export const VCR_ESTIMAND_LABELS_ZH = Object.freeze({ ATT: '对试验人群（ATT）', ATE: '对合并人群（ATE）', ATO: '对重叠人群（ATO）' })
export const VCR_DEFAULT_ESTIMAND = 'ATT'

/** The deterministic rules that make a comparison `not_estimable` (§5.3). */
export const VCR_NOT_ESTIMABLE_RULES = frozen([
  'entropy_balance_infeasible', 'outside_common_support', 'effective_sample_size_below_floor',
  'standardized_difference_above_floor', 'tau_beyond_followup', 'reconstruction_failed_qc', 'map_prior_conflict',
  // A Cox model has no estimate when an arm has no event (the hazard ratio is infinite or zero) or the fit
  // does not converge; fewer events than `VCR_COX_FEW_EVENTS` is a notice, never a refusal.
  'too_few_events',
  // A doubly robust estimate needs both of its working models: the propensity model of who is in the trial and the outcome
  // model fitted on the external controls. When either cannot be fitted (collinear covariates, fewer controls than the
  // model has coefficients) there is no estimate.
  'nuisance_model_not_estimable',
  // --- robustness methods (2026-10-04): negative controls, tipping point, prognostic adjustment ---
  // No negative control produced an estimate (every one has an arm with no event, or none was supplied in a usable form).
  'negative_controls_not_estimable',
  // The analysis's own primary estimate does not exist: an arm with no event or no person, a model that does not converge,
  // a score with no spread. Nothing downstream of it (a tipping point, a marginal effect) is reported.
  'primary_analysis_not_estimable',
  // --- end robustness methods ---
  // Two the control plane derives before any job runs: the study's data tier
  // cannot reach the route (§3.2 table), or the route has no method in this
  // version (the model-predicted comparator) — a verdict in code, never a job.
  'data_tier_insufficient', 'route_unavailable_in_version',
])
export const VCR_NOT_ESTIMABLE_RULE_LABELS_ZH = Object.freeze({
  entropy_balance_infeasible: '熵平衡无解（试验人群的协变量均值落在对照人群范围之外）',
  outside_common_support: '共同支持域外的比例越过界限',
  effective_sample_size_below_floor: '加权后有效样本量低于下限',
  standardized_difference_above_floor: '加权后关键协变量标准化差异 ≥ 0.1',
  tau_beyond_followup: 'RMST 的 τ 超过任一组的最长随访',
  reconstruction_failed_qc: '重建 KM 未过质控',
  map_prior_conflict: 'MAP 先验与当前数据冲突检验越界',
  too_few_events: '某一组没有事件，或 Cox 模型没有收敛（事件太少，风险比不存在）',
  nuisance_model_not_estimable: '倾向性模型或结局模型拟合不出来（协变量共线，或外部对照的人数不足以拟合结局模型）',
  negative_controls_not_estimable: '没有一个阴性对照结局能得出估计（每个都有一组没有事件，或没有提供可用的数据）',
  primary_analysis_not_estimable: '这项分析本身的主要估计不存在（某一组没有事件或没有人、模型没有收敛、预后评分没有变异）',
  data_tier_insufficient: '现有数据档位不足以走这条对照路线',
  route_unavailable_in_version: '这条对照路线在当前版本还没有可用的方法',
})

/** The ten comparability dimensions of the FDA externally-controlled-trials draft (§5.3). */
export const VCR_COMPARABILITY_DIMENSIONS = frozen([
  'time_period', 'geography', 'diagnosis', 'prognostic_factors', 'treatment', 'other_treatment_related',
  'follow_up', 'intercurrent_events', 'outcome_definition', 'missing_data',
])
export const VCR_COMPARABILITY_DIMENSION_LABELS_ZH = Object.freeze({
  time_period: '时期', geography: '地域', diagnosis: '诊断', prognostic_factors: '预后因素', treatment: '治疗',
  other_treatment_related: '其他与治疗相关的因素', follow_up: '随访', intercurrent_events: '伴随事件',
  outcome_definition: '结局定义与评估', missing_data: '缺失数据',
})
/** ICH E10's four conditions for an external control to be appropriate at all. */
export const VCR_E10_CONDITIONS = frozen(['effect_large', 'objective_endpoint', 'predictable_course', 'prognostic_factors_known'])
export const VCR_E10_CONDITION_LABELS_ZH = Object.freeze({
  effect_large: '效应远大于自然变异', objective_endpoint: '终点客观', predictable_course: '病程可预测',
  prognostic_factors_known: '预后因素已知可得',
})

/** Trial designs the first version simulates (§5.4). */
export const VCR_TRIAL_DESIGNS = frozen(['single_arm', 'single_arm_external', 'two_arm_fixed', 'group_sequential', 'simon_two_stage'])
export const VCR_TRIAL_DESIGN_LABELS_ZH = Object.freeze({
  single_arm: '单臂试验', single_arm_external: '单臂 + 外部对照', two_arm_fixed: '固定样本两组比较',
  group_sequential: '成组序贯', simon_two_stage: 'Simon 两阶段',
})
/** Performance measures a simulation reports, all on by default (ADEMP, §5.4). */
export const VCR_PERFORMANCE_MEASURES = frozen(['power', 'type_one_error', 'bias', 'coverage', 'expected_sample_size', 'duration_months', 'cost'])
export const VCR_PERFORMANCE_MEASURE_LABELS_ZH = Object.freeze({
  power: '功效', type_one_error: 'I 类错误', bias: '偏倚', coverage: '区间覆盖率',
  expected_sample_size: '期望样本量', duration_months: '周期（月）', cost: '成本',
})
/** Alpha-spending functions available for a group-sequential design. */
export const VCR_SPENDING_FUNCTIONS = frozen(['obrien_fleming', 'pocock'])
export const VCR_SPENDING_FUNCTION_LABELS_ZH = Object.freeze({ obrien_fleming: "O'Brien-Fleming", pocock: 'Pocock' })

/** Named interval kinds. A report never writes a bare 「区间」 (§8.3). */
export const VCR_INTERVAL_KINDS = frozen(['confidence', 'credible', 'prediction', 'monte_carlo'])
export const VCR_INTERVAL_KIND_LABELS_ZH = Object.freeze({
  confidence: '置信区间', credible: '可信区间', prediction: '预测区间', monte_carlo: '蒙特卡洛区间',
})

// ---------------------------------------------------------------------------
// Assumptions and evidence (§6)
// ---------------------------------------------------------------------------

/** Where an assumption's value came from (v1.0's five kinds). */
export const VCR_ASSUMPTION_SOURCE_KINDS = frozen(['local_observation', 'external_evidence', 'expert_set', 'model_prediction', 'scenario'])
export const VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH = Object.freeze({
  local_observation: '本地观察', external_evidence: '外部证据', expert_set: '专家设定',
  model_prediction: '模型预测', scenario: '情景假设',
})
/** How several studies became one number (§6.1). */
export const VCR_POOLING_METHODS = frozen(['single_study', 'random_effects_dl', 'random_effects_reml', 'random_effects_hksj', 'fixed_effect'])
export const VCR_POOLING_METHOD_LABELS_ZH = Object.freeze({
  single_study: '单项研究直接取值', random_effects_dl: '随机效应（DL）', random_effects_reml: '随机效应（REML）',
  random_effects_hksj: '随机效应（HKSJ）', fixed_effect: '固定效应',
})
/** Distribution families an assumption may carry into a simulation (§6.1). */
export const VCR_DISTRIBUTIONS = frozen(['point', 'normal', 'lognormal', 'beta', 'gamma', 'empirical'])

/** A registry record's planned vs actual, kept apart (§6.2: CT.gov ESTIMATED vs ACTUAL). */
export const VCR_ENROLLMENT_KINDS = frozen(['estimated', 'actual'])

// ---------------------------------------------------------------------------
// Matching, referral, follow-up (§7)
// ---------------------------------------------------------------------------

/** Kleene three-valued logic, plus one deferral. `not_applicable` is a separate flag (§7.1). */
export const VCR_CRITERION_STATES = frozen(['satisfied', 'not_satisfied', 'unknown', 'pending_recheck'])
export const VCR_CRITERION_STATE_LABELS_ZH = Object.freeze({
  satisfied: '满足', not_satisfied: '不满足', unknown: '未知', pending_recheck: '待复评',
})
/** What kind of thing a structured criterion tests (§7.1; CHIP-CTC's 44 classes fold into these). */
export const VCR_CRITERION_TYPES = frozen([
  'demographic', 'diagnosis', 'biomarker', 'lab', 'prior_treatment', 'time_window', 'performance_status',
  'comorbidity', 'concomitant_medication', 'pregnancy', 'consent_capacity', 'other',
])
export const VCR_CRITERION_TYPE_LABELS_ZH = Object.freeze({
  demographic: '人口学', diagnosis: '诊断', biomarker: '分子标志物', lab: '检验', prior_treatment: '既往治疗',
  time_window: '时间窗', performance_status: '体能状态', comorbidity: '合并症', concomitant_medication: '合并用药',
  pregnancy: '妊娠', consent_capacity: '知情能力', other: '其他',
})
/** A patient's overall eligibility summary, computed from the criterion states only. */
export const VCR_ELIGIBILITY_SUMMARIES = frozen(['eligible', 'ineligible', 'insufficient_evidence', 'pending'])
export const VCR_ELIGIBILITY_SUMMARY_LABELS_ZH = Object.freeze({
  eligible: '符合', ineligible: '不符合', insufficient_evidence: '证据不足', pending: '待复评',
})

/** The referral ledger, in order (§7.2). */
export const VCR_REFERRAL_STATES = frozen([
  'candidate', 'needs_evidence', 'contactable', 'contacted', 'interested', 'referred', 'site_responded',
  'screening', 'enrolled', 'screen_failed', 'withdrawn',
])
export const VCR_REFERRAL_STATE_LABELS_ZH = Object.freeze({
  candidate: '候选', needs_evidence: '待补证', contactable: '可联系', contacted: '已联系', interested: '有意向',
  referred: '已转诊', site_responded: '中心已响应', screening: '筛选中', enrolled: '已入组',
  screen_failed: '筛选失败', withdrawn: '退出',
})
/** The states a referral may never reach without a coordinator's per-person confirmation (§10.1). */
export const VCR_CONTACT_STATES = frozen(['contacted', 'interested', 'referred'])

/** What a follow-up episode records (§7.3). */
export const VCR_FOLLOWUP_KINDS = frozen(['routine_care', 'study_specific', 'post_exit'])
export const VCR_FOLLOWUP_KIND_LABELS_ZH = Object.freeze({ routine_care: '常规诊疗观察', study_specific: '研究专属随访', post_exit: '出组后观察' })

// ---------------------------------------------------------------------------
// Jobs, engine, notifications (§10, §11.4)
// ---------------------------------------------------------------------------

/** Every deterministic computation the engine can be asked for. */
export const VCR_JOB_KINDS = frozen([
  'profile_snapshot', 'build_cohort', 'generate_population', 'literature_population', 'synthesize_population',
  'population_quality', 'generate_patients', 'generate_patients_continuous', 'generate_patients_binary',
  'reconstruct_km', 'pool_evidence', 'weight_comparator', 'propensity_weight_comparator', 'maic_comparator',
  'evalue', 'rmst', 'design_analytic', 'design_simulation', 'design_grid', 'assurance', 'procova',
  'accrual_forecast', 'map_prior', 'match_criteria',
  // appended (2026-10-04): the comparator-effect methods
  'weighted_cox_comparator', 'maic_time_to_event_comparator', 'aipw_comparator', 'covariate_set_comparator',
  // --- appended (2026-10-04): the robustness methods ---
  'negative_control_comparator', 'tipping_point', 'prognostic_adjustment_comparator',
  // --- end robustness methods ---
  // --- appended (2026-10-07): longitudinal virtual patients (plan 5.2) ---
  'generate_patients_longitudinal',
  // --- end longitudinal ---
])
export const VCR_JOB_STATES = frozen(['queued', 'running', 'succeeded', 'failed', 'canceled', 'awaiting_budget'])
export const VCR_JOB_STATE_LABELS_ZH = Object.freeze({
  queued: '排队中', running: '进行中', succeeded: '已完成', failed: '未完成', canceled: '已取消', awaiting_budget: '待确认预算',
})

/**
 * Why a job that is live is not moving, when the reason is not the researcher's to
 * act on: the page says it in one line under the job and asks for nothing. Closed on
 * purpose — a reason joins this table when the job's own row can state it (the queue
 * records `engine` when the engine did not answer; `vcrJobs.mjs`, `jobView`).
 */
export const VCR_JOB_WAIT_LABELS_ZH = Object.freeze({
  engine: '计算引擎暂时没有回应，它恢复后这项计算会自动继续，无需操作。',
})

/** The three places a human is required to stop (§10.1). Nothing else stops. */
export const VCR_HUMAN_STOPS = frozen(['contact_patient', 'compute_over_budget', 'clinical_safety'])
export const VCR_HUMAN_STOP_LABELS_ZH = Object.freeze({
  contact_patient: '联系真实患者之前', compute_over_budget: '计算超出研究预算', clinical_safety: '出现临床安全问题',
})

/** The only six notifications this module sends: the five of §10.4 and, since the evidence flywheel (F24, 2026-10-06), new evidence for a card. */
export const VCR_NOTIFICATION_KINDS = frozen(['package_ready', 'not_estimable', 'budget_confirm', 'new_candidates', 'accrual_off_forecast', 'new_evidence'])
export const VCR_NOTIFICATION_LABELS_ZH = Object.freeze({
  package_ready: '研究包完成', not_estimable: '结论为不可估计或假设冲突', budget_confirm: '计算预算需要确认',
  new_candidates: '有新的匹配候选', accrual_off_forecast: '实际入组偏离预测', new_evidence: '假设卡有了新证据',
})

/**
 * The one sentence every public 「模拟研究」 publication and every page that offers to publish says about itself (flywheel ruling 10,
 * 2026-10-06): a simulated result is the model's output under stated assumptions, and it is not evidence.
 */
export const VCR_SIMULATION_NOT_EVIDENCE_ZH = '模拟研究的结果是模型按假设算出来的，不是证据：不能当作临床结论，也不能当作循证依据引用。'

/** Why a result went stale (§6.3). Stale results are never deleted or hidden. */
export const VCR_STALE_REASONS = frozen(['assumption_changed', 'criterion_changed', 'source_corrected', 'protocol_revised', 'method_version_changed'])
export const VCR_STALE_REASON_LABELS_ZH = Object.freeze({
  assumption_changed: '假设卡已变更', criterion_changed: '入排条件已变更', source_corrected: '源数据已更正',
  protocol_revised: '方案已修订', method_version_changed: '方法版本已变更',
})

/** The objects a lineage edge can join (§3.4). */
export const VCR_LINEAGE_NODE_KINDS = frozen([
  'study_definition', 'assumption', 'snapshot', 'population', 'patient_set', 'comparator_design',
  'trial_scenario', 'design_grid', 'execution', 'result', 'matching_assessment', 'protocol_version', 'criterion',
])

/** Deliverables this module exports (§8.3). */
export const VCR_EXPORT_KINDS = frozen([
  'study_package', 'cde_communication_pack', 'simulation_report', 'validation_pack', 'model_analysis_plan', 'model_analysis_report',
])
export const VCR_EXPORT_KIND_LABELS_ZH = Object.freeze({
  study_package: '研究包', cde_communication_pack: 'CDE 沟通交流资料包', simulation_report: '模拟报告', validation_pack: '系统验证文档包',
  model_analysis_plan: '模型分析计划', model_analysis_report: '模型分析报告',
})

/** The module's own capability packages (§11.2 layer 8). */
export const VCR_CAPABILITIES = frozen(['vcr-protocol', 'vcr-evidence', 'vcr-analysis', 'vcr-matching', 'vcr-package'])
/** Which capability a step dispatches to (the orchestrator's map). */
export const VCR_STEP_CAPABILITIES = Object.freeze({
  definition: 'vcr-protocol',
  evidence: 'vcr-evidence',
  population: 'vcr-analysis',
  patients: 'vcr-analysis',
  comparator: 'vcr-analysis',
  trial: 'vcr-analysis',
  matching: 'vcr-matching',
})

/**
 * The contract kind a run delivers for a step, where its capability produces
 * more than one (`vcr-analysis`: the cohort snapshot, the comparator analysis,
 * the simulation report — one `produces` entry each). A run dispatched for
 * some of those steps is held to the files of those products and no others, so
 * a retry for the patients alone does not owe a comparability table or a
 * simulation report (the live acceptance of 2026-10-03). Steps whose
 * capability produces one kind are not listed: there is nothing to narrow.
 */
export const VCR_STEP_PRODUCTS = Object.freeze({
  population: 'vcr-cohort-snapshot',
  patients: 'vcr-cohort-snapshot',
  comparator: 'vcr-comparator-analysis',
  trial: 'vcr-simulation-report',
})

/**
 * What a column of a source is *for* in the study — the one thing the analysis
 * tables are derived from (plan §8.1 step 2). `subject_key` is the person's key
 * in the source (it becomes a per-study pseudonym and never leaves the data
 * plane); `arm` and `covariate` are baseline attributes (the subject table);
 * `outcome_time` / `outcome_event` are one time-to-event outcome, paired by
 * their `parameter` (the events table); `measurement` is one longitudinal
 * parameter (the longitudinal table); `time_zero` is the index date; `visit_date`
 * dates a measurement row; `other` is kept in the snapshot and never derived.
 * Spliced into the control plane's CHECK on `field_maps.role`.
 */
export const VCR_FIELD_ROLES = frozen([
  'subject_key', 'arm', 'covariate', 'outcome_time', 'outcome_event', 'time_zero', 'measurement', 'visit_date', 'other',
])

/** Data-source formats the data plane accepts in the first version (§8.1). */
export const VCR_SOURCE_FORMATS = frozen(['csv', 'tsv', 'xlsx', 'json'])
/** The three analysis tables every snapshot derives (ADaM shapes, §8.1). */
export const VCR_ANALYSIS_TABLES = frozen(['subject', 'longitudinal', 'events'])
export const VCR_ANALYSIS_TABLE_LABELS_ZH = Object.freeze({ subject: '受试者级表', longitudinal: '长表', events: '事件表' })
/** Kahn 2016's data-quality categories (§8.1). */
export const VCR_QUALITY_CATEGORIES = frozen(['conformance', 'completeness', 'plausibility', 'duplication', 'linkage'])
export const VCR_QUALITY_CATEGORY_LABELS_ZH = Object.freeze({
  conformance: '一致性', completeness: '完整性', plausibility: '合理性', duplication: '重复', linkage: '关联质量',
})

/** Below this cell count an aggregate handed to a model is suppressed (§8.1). */
export const VCR_MIN_CELL_SIZE = 10
/** Bootstrap draws for an interval that includes weight estimation (§5.3). */
export const VCR_BOOTSTRAP_MIN = 2_000
/** Default replicate floors (§5.4); the job's own target precision may raise them. */
export const VCR_REPLICATES_NULL_MIN = 20_000
export const VCR_REPLICATES_ALT_MIN = 5_000
/** A weighted covariate above this standardized difference is not balanced (§5.3). */
export const VCR_SMD_FLOOR = 0.1
/**
 * The other deterministic 「不可估计」 presets (§5.3: 「越过预设界限」). They are
 * deployment presets the engine reads from its snapshot, never scenario keys: a
 * scenario a model wrote must not be able to loosen the rule that stops a
 * comparison from being reported. The plan fixes the standardized-difference
 * floor (0.1); the values below are the build's, to be confirmed by the owner.
 *
 * - `VCR_ESS_FLOOR`: a weighted control arm with fewer effective patients than
 *   this carries no estimate.
 * - `VCR_SUPPORT_CEILING`: the largest share of the trial population that may
 *   fall outside the control score range.
 * - `VCR_MAP_CONFLICT_BOUND`: the prior-data conflict p-value below which a MAP
 *   prior is refused.
 * - `VCR_RECONSTRUCTION_TOLERANCE`: how far a reconstructed KM may sit from the
 *   published numbers (at risk: max of the absolute count and the relative
 *   share; events, median and log hazard ratio: relative, and absolute for the
 *   log ratio).
 */
export const VCR_ESS_FLOOR = 10
/**
 * A Cox comparison with fewer events than this in an arm is reported but labelled
 * `limited` and says why (a notice, not a refusal): the hazard ratio of an arm
 * with a handful of events is estimable and very imprecise, and the robust
 * variance is biased low there. An arm with NO event is the one case that is not
 * estimable at all (`too_few_events`).
 */
export const VCR_COX_FEW_EVENTS = 10
export const VCR_SUPPORT_CEILING = 0.1
// --- robustness methods (2026-10-04) ---
/**
 * The fewest estimable negative-control outcomes an empirical null is fitted on.
 * The null has two parameters (a mean and a spread) and the spread is estimated
 * from the controls themselves: the relative standard error of a standard
 * deviation from k independent values is about 1 / sqrt(2 (k - 1)), 13% at 30
 * and 20% at 13, and the literature's own guidance for empirical calibration is
 * about 30 to 50 controls (Schuemie et al. 2014, 2018). Below this the result
 * reports each control and a bias screen and says the set is too small to
 * calibrate; it never reports a calibrated interval, which needs positive
 * controls the engine does not have.
 */
export const VCR_NEGATIVE_CONTROL_CALIBRATION_MIN = 30
/** What the bias screen says about one negative-control outcome (deterministic, from its interval). */
export const VCR_NEGATIVE_CONTROL_VERDICTS = frozen(['signals_bias', 'consistent_with_null', 'uninformative'])
export const VCR_NEGATIVE_CONTROL_VERDICT_LABELS_ZH = Object.freeze({
  signals_bias: '提示残余偏倚（区间不含无效值）',
  consistent_with_null: '与无效值一致',
  uninformative: '信息不足（区间宽到容得下主要结局的效应大小）',
})
/**
 * What regulators have qualified of prognostic covariate adjustment: continuous
 * outcomes only (the EMA qualification opinion on PROCOVA, CHMP 15 September 2022).
 * Every result of `comparator.prognostic_adjustment` carries this word in
 * `diagnostics.regulatoryStatus.qualification` so the page can say it; the engine
 * reads it from its snapshot, and a test holds the two equal.
 */
export const VCR_PROGNOSTIC_QUALIFICATION = 'none_beyond_continuous'
export const VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH = '二分类和事件时间终点的预后协变量调整，目前没有监管机构认可：EMA 2022 年的资格认定意见只覆盖连续终点。'
/**
 * The stages of a comparison that stress it rather than make it: a bias screen with negative controls and a tipping-point analysis of
 * the missing outcomes. A stress test that cannot be computed (no control has an estimate) leaves the comparison as estimable as it was
 * but limited, and says which analysis is missing; the stage's own result stays whole under `diagnostics.stageResults`.
 */
export const VCR_ROBUSTNESS_STAGES = frozen(['negative_control', 'tipping_point'])
export const VCR_ROBUSTNESS_STAGE_LABELS_ZH = Object.freeze({ negative_control: '阴性对照结局', tipping_point: '缺失结局的临界点分析' })
// --- end robustness methods ---
export const VCR_MAP_CONFLICT_BOUND = 0.01
export const VCR_RECONSTRUCTION_TOLERANCE = Object.freeze({
  atRiskAbsolute: 2, atRiskRelative: 0.05, events: 0.05, median: 0.05, logHazardRatio: 0.05,
})

/**
 * The keys that count people. A value under one of these names is a head count
 * of real or generated persons and is what small-cell suppression reads
 * (`suppressForModel`): extend the list here and nowhere else.
 */
export const VCR_PEOPLE_COUNT_FIELDS = frozen([
  'n', 'count', 'patients', 'realPatients', 'subjects', 'events', 'kept', 'excluded', 'indeterminate',
  'cohortSize', 'screened', 'eligible', 'enrolled', 'referred', 'contacted', 'candidates',
])
/**
 * Keys under which an object maps a category to a head count
 * (`{ "A": 12, "B": 3 }`): its entries are sibling cells.
 */
export const VCR_PEOPLE_COUNT_MAP_KEYS = frozen(['levels'])
/**
 * Keys that count people but are never one of a list's sibling cells: a table's
 * row total, the rows a cohort started from and kept, the rows a synthetic
 * model was trained on, the effective sample size a weighted estimate rests on
 * (an unweighted one is exactly the head count). Small-cell suppression reads
 * them alone — one of them under ten becomes null — and never as a cell whose
 * neighbours are topped up around it, because two tables' row totals or two
 * diagnostics blocks are not the parts of one whole.
 */
export const VCR_PEOPLE_COUNT_SCALAR_FIELDS = frozen([
  'rows', 'startingRows', 'keptRows', 'trainingObservations', 'effectiveSampleSize',
])
/**
 * Names of measures — `{ name, value }` — whose value is a head count of the
 * study's own people. The engine reports a cohort's size this way, not as a
 * `counts` key, so a boundary that reads only keys lets a small cohort out as
 * `cohort_size`. Closed: a measure of a published trial's figure (a
 * reconstructed curve's events) or of a design (`expected_sample_size`,
 * `required_total_*`) is not this study's people and is not listed.
 */
export const VCR_PEOPLE_COUNT_MEASURES = frozen([
  'rows', 'cohort_size', 'cohort_size_strict', 'cohort_size_lenient', 'training_observations', 'effective_sample_size',
])

/**
 * An assumption's key — the name a lineage node and an engine input id carry
 * (`assumption:<key>@<version>`), so it has to be a name both can spell and
 * read back: lowercase ASCII, digits and underscores.
 */
export const VCR_ASSUMPTION_KEY_PATTERN = '^[a-z][a-z0-9_]{0,63}$'
export const VCR_ASSUMPTION_KEY = new RegExp(VCR_ASSUMPTION_KEY_PATTERN)

/**
 * Is this word in this vocabulary? Used by the schema builder before splicing
 * a literal into a CHECK, and by every per-item validator.
 * @param {readonly string[]} vocabulary @param {unknown} value
 */
export function vcrKnown(vocabulary, value) {
  return typeof value === 'string' && vocabulary.includes(value)
}
