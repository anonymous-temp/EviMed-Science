/**
 * 「虚拟临研」's model assessment record and the two documents built on it:
 * the 模型分析计划 and the 模型分析报告 of ICH M15 (Step 4, 29 January 2026).
 *
 * Hidden knowledge:
 *
 * - **Naming.** M15 abbreviates its documents MAP and MAR. In this module "MAP"
 *   already means the meta-analytic-predictive prior (`map_prior`), so nothing
 *   here is called a map: identifiers say `model_analysis_plan` and
 *   `model_analysis_report`, and a reader sees 模型分析计划 and 模型分析报告 in
 *   full.
 * - **M15 prescribes no risk matrix, and this module does not invent one.** Its
 *   whole statement is: if influence and consequence are both low the model risk
 *   is low, if both are high it is high, and when they differ the rating "may be
 *   driven by the most influential of the two items", the consideration being
 *   written into the justification. {@link vcrModelRisk} implements that
 *   sentence and nothing else — the higher of the two when they differ, the
 *   common rating when they agree — and names the rule that fired, so the record
 *   says why. Ratings are an author's judgment and are never derived; the model
 *   risk is derived and never typed, the way a twin label is.
 * - **Every rating needs its reason.** M15 says justification is "always
 *   expected and essential" for a low/medium/high rating. A missing one is a
 *   notice in the document, never a refusal: the record is the AI's work in
 *   progress and it is delivered as it stands.
 * - **One table per question of interest** (M15 §2.1.1): records are grouped by
 *   the question they answer, not by model, because one question can rest on
 *   several models and one model can serve several questions.
 * - **The documents' section names are M15's** (§4.1, Appendix 2), reproduced
 *   with ICH's attribution (the guideline's legal notice allows reuse with the
 *   copyright acknowledged and changes labelled, no endorsement implied).
 *   The plan is *not* a statistical analysis plan (ICH E9(R1)): it covers the
 *   models, the simulations and the scenarios, and says so.
 *
 * @module @evimed/domain/vcrModelAssessment
 */

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

/** The three ratings M15 uses for influence, consequence, risk and impact. */
export const VCR_RATINGS = frozen(['low', 'medium', 'high'])
export const VCR_RATING_LABELS_ZH = Object.freeze({ low: '低', medium: '中', high: '高' })

/** An assessment record's key: one per question and model, the way an assumption has its key. */
export const VCR_ASSESSMENT_KEY_PATTERN = '^[a-z][a-z0-9_]{0,63}$'
export const VCR_ASSESSMENT_KEY = new RegExp(VCR_ASSESSMENT_KEY_PATTERN)

/**
 * The rows of M15's assessment table (Appendix 1), in the guideline's order.
 * `stage` says when M15 wants the row: the key assessment elements always, the
 * planning rows at planning (and again at submission), the submission rows only
 * once the analysis is done. `rated` rows carry a low/medium/high rating and a
 * justification; `derived` is the one the platform computes.
 */
export const VCR_ASSESSMENT_ROWS = Object.freeze([
  { key: 'questionOfInterest', zh: '关注的问题', en: 'Question of interest', m15: '2.1.1', stage: 'key', rated: false, derived: false },
  { key: 'contextOfUse', zh: '使用情境', en: 'Context of use', m15: '2.1.2', stage: 'key', rated: false, derived: false },
  { key: 'influence', zh: '模型影响力', en: 'Model influence', m15: '2.1.3', stage: 'key', rated: true, derived: false },
  { key: 'consequence', zh: '错误决策的后果', en: 'Consequence of wrong decision', m15: '2.1.4', stage: 'key', rated: true, derived: false },
  { key: 'risk', zh: '模型风险', en: 'Model risk', m15: '2.1.5', stage: 'key', rated: true, derived: true },
  { key: 'impact', zh: '模型冲击', en: 'Model impact', m15: '2.1.6', stage: 'key', rated: true, derived: false },
  { key: 'technicalCriteria', zh: '技术标准', en: 'Technical criteria', m15: '2.2.1', stage: 'planning', rated: false, derived: false },
  { key: 'appropriateness', zh: '所拟用法的适当性', en: 'Appropriateness of proposed MIDD', m15: '2.2.2', stage: 'planning', rated: false, derived: false },
  { key: 'evaluation', zh: '模型与模型结果的评价', en: 'Evaluation of model(s) and model outcomes', m15: '2.2.3', stage: 'submission', rated: false, derived: false },
  { key: 'outcome', zh: '证据评估的结论', en: 'Outcome of the MIDD evidence assessment', m15: '2.2.4', stage: 'submission', rated: false, derived: false },
])

/** Which rule of {@link vcrModelRisk} settled a model risk. */
export const VCR_MODEL_RISK_RULES = frozen(['both_low', 'both_medium', 'both_high', 'driven_by_influence', 'driven_by_consequence'])

/**
 * The rule's sentence, for the 模型风险 row: why this rating and not another.
 * M15 asks for the considerations to be captured in the justification; this is
 * the platform's half of it, and the author's own justification text is the other.
 */
export const VCR_MODEL_RISK_RULE_LABELS_ZH = Object.freeze({
  both_low: '模型影响力与错误决策的后果都是低，模型风险为低。',
  both_medium: '模型影响力与错误决策的后果都是中，模型风险为中。',
  both_high: '模型影响力与错误决策的后果都是高，模型风险为高。',
  driven_by_influence: '两项评级不同，模型风险随影响更大的一项——模型影响力。',
  driven_by_consequence: '两项评级不同，模型风险随影响更大的一项——错误决策的后果。',
})

/**
 * M15 §2.1.5, and only that: the model risk from the two ratings it is the
 * combination of. Both low is low, both high is high; when the ratings differ
 * the higher one drives the risk. No threshold, no weights, no matrix.
 * @param {unknown} influence @param {unknown} consequence
 * @returns {{ risk: 'low' | 'medium' | 'high', rule: string } | null} `null` when either rating is not one of the three
 */
export function vcrModelRisk(influence, consequence) {
  const a = VCR_RATINGS.indexOf(/** @type {string} */ (influence))
  const b = VCR_RATINGS.indexOf(/** @type {string} */ (consequence))
  if (a < 0 || b < 0) return null
  const risk = /** @type {'low' | 'medium' | 'high'} */ (VCR_RATINGS[Math.max(a, b)])
  if (a === b) return { risk, rule: a === 0 ? 'both_low' : a === 2 ? 'both_high' : 'both_medium' }
  return { risk, rule: a > b ? 'driven_by_influence' : 'driven_by_consequence' }
}

/**
 * @typedef {{ criterion: string, rationale: string }} VcrTechnicalCriterion
 * @typedef {{
 *   key: string, modelName: string, modelVersion: string,
 *   questionOfInterest: string, contextOfUse: string,
 *   influence: string, influenceJustification: string,
 *   consequence: string, consequenceJustification: string,
 *   riskJustification: string,
 *   impact: string, impactJustification: string,
 *   technicalCriteria: VcrTechnicalCriterion[], appropriateness: string,
 *   evaluation: string, outcome: string,
 *   risk: string | null, riskRule: string | null,
 * }} VcrModelAssessment
 */

/** Whitespace-collapsed text: the one spelling a question is grouped and compared by. @param {unknown} value */
export function vcrAssessmentText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/**
 * An assessment record in the one shape every reader takes: text trimmed, a
 * rating outside the three words dropped to empty (and reported by
 * {@link vcrAssessmentIssues}, not repaired), the model risk derived from the
 * two ratings. Pure; the stores keep exactly this plus their own bookkeeping.
 * @param {Record<string, any>} input
 * @returns {VcrModelAssessment}
 */
export function normalizeVcrAssessment(input) {
  const row = input && typeof input === 'object' ? input : {}
  const rating = (/** @type {unknown} */ value) => (VCR_RATINGS.includes(/** @type {string} */ (value)) ? String(value) : '')
  const derived = vcrModelRisk(rating(row.influence), rating(row.consequence))
  const criteria = (Array.isArray(row.technicalCriteria) ? row.technicalCriteria : [])
    .map((/** @type {any} */ entry) => (typeof entry === 'string'
      ? { criterion: vcrAssessmentText(entry), rationale: '' }
      : { criterion: vcrAssessmentText(entry?.criterion), rationale: vcrAssessmentText(entry?.rationale) }))
    .filter((/** @type {VcrTechnicalCriterion} */ entry) => entry.criterion)
  return {
    key: String(row.key ?? ''),
    modelName: vcrAssessmentText(row.modelName),
    modelVersion: vcrAssessmentText(row.modelVersion),
    questionOfInterest: vcrAssessmentText(row.questionOfInterest),
    contextOfUse: vcrAssessmentText(row.contextOfUse),
    influence: rating(row.influence),
    influenceJustification: vcrAssessmentText(row.influenceJustification),
    consequence: rating(row.consequence),
    consequenceJustification: vcrAssessmentText(row.consequenceJustification),
    riskJustification: vcrAssessmentText(row.riskJustification),
    impact: rating(row.impact),
    impactJustification: vcrAssessmentText(row.impactJustification),
    technicalCriteria: criteria,
    appropriateness: vcrAssessmentText(row.appropriateness),
    evaluation: vcrAssessmentText(row.evaluation),
    outcome: vcrAssessmentText(row.outcome),
    risk: derived?.risk ?? null,
    riskRule: derived?.rule ?? null,
  }
}

/**
 * What an assessment record has not said yet, for the stage asked about. Every
 * finding is a notice that the document prints as 「未填写」; none refuses the
 * record (an AI's work in progress is delivered as it stands, and a plan with
 * gaps is still the plan).
 *
 * `planning` asks for the key assessment elements and the two planning rows;
 * `submission` adds the evaluation and the outcome (M15 §2.2).
 * @param {Record<string, any>} record @param {'planning' | 'submission'} [stage]
 * @returns {Array<{ code: string, field: string, text: string }>}
 */
export function vcrAssessmentIssues(record, stage = 'planning') {
  const shown = normalizeVcrAssessment(record)
  /** @type {Array<{ code: string, field: string, text: string }>} */
  const issues = []
  const raw = /** @type {Record<string, any>} */ (record ?? {})
  const missing = (/** @type {string} */ field, /** @type {string} */ zh) => issues.push({ code: 'assessment_field_missing', field, text: `${zh}还没有填写` })
  if (!shown.questionOfInterest) missing('questionOfInterest', '关注的问题')
  if (!shown.contextOfUse) missing('contextOfUse', '使用情境')
  for (const [field, justification, zh] of /** @type {const} */ ([
    ['influence', 'influenceJustification', '模型影响力'],
    ['consequence', 'consequenceJustification', '错误决策的后果'],
    ['impact', 'impactJustification', '模型冲击'],
  ])) {
    const given = raw[field]
    if (given != null && given !== '' && !shown[field]) {
      issues.push({ code: 'assessment_rating_invalid', field, text: `${zh}的评级要写 ${VCR_RATINGS.join('、')} 之一` })
    } else if (!shown[field]) {
      missing(field, `${zh}的评级`)
    } else if (!shown[justification]) {
      issues.push({ code: 'assessment_justification_missing', field, text: `${zh}的评级没有写理由（M15 要求每个评级都有理由）` })
    }
  }
  if (shown.risk && !shown.riskJustification) {
    issues.push({ code: 'assessment_justification_missing', field: 'risk', text: '模型风险没有写理由：两项评级不同时，是什么让风险随较高的一项，要写在这里' })
  }
  if (!shown.technicalCriteria.length) missing('technicalCriteria', '技术标准')
  if (!shown.appropriateness) missing('appropriateness', '所拟用法的适当性')
  if (stage === 'submission') {
    if (!shown.evaluation) missing('evaluation', '模型与模型结果的评价')
    if (!shown.outcome) missing('outcome', '证据评估的结论')
  }
  return issues
}

/**
 * One record as the rows of its assessment table, in M15's order, for the
 * stage asked about. `rating` is the low/medium/high word where the row has
 * one; `entry` is the text the row carries; `justification` is the reason.
 * @param {Record<string, any>} record @param {'planning' | 'submission'} [stage]
 * @returns {Array<{ key: string, zh: string, en: string, m15: string, rating: string | null, entry: string, justification: string }>}
 */
export function vcrAssessmentRows(record, stage = 'planning') {
  const shown = normalizeVcrAssessment(record)
  return VCR_ASSESSMENT_ROWS.filter((row) => stage === 'submission' || row.stage !== 'submission').map((row) => {
    const entry = row.key === 'technicalCriteria'
      ? shown.technicalCriteria.map((item) => (item.rationale ? `${item.criterion}（${item.rationale}）` : item.criterion)).join('；')
      : row.rated ? '' : String(shown[/** @type {'questionOfInterest'} */ (row.key)] ?? '')
    const rating = row.rated ? (shown[/** @type {'influence'} */ (row.key)] || null) : null
    const reasons = /** @type {Record<string, string>} */ ({
      influence: shown.influenceJustification, consequence: shown.consequenceJustification, impact: shown.impactJustification,
      risk: [shown.riskRule ? VCR_MODEL_RISK_RULE_LABELS_ZH[/** @type {keyof typeof VCR_MODEL_RISK_RULE_LABELS_ZH} */ (shown.riskRule)] : '', shown.riskJustification].filter(Boolean).join(' '),
    })
    const justification = row.rated ? reasons[row.key] ?? '' : ''
    return { key: row.key, zh: row.zh, en: row.en, m15: row.m15, rating, entry, justification }
  })
}

/**
 * The records grouped by the question of interest they answer — one assessment
 * table per question (M15 §2.1.1) — in the order the questions first appear.
 * @param {ReadonlyArray<Record<string, any>>} records
 * @returns {Array<{ question: string, records: VcrModelAssessment[] }>}
 */
export function vcrAssessmentGroups(records) {
  /** @type {Map<string, VcrModelAssessment[]>} */
  const groups = new Map()
  for (const record of records ?? []) {
    const shown = normalizeVcrAssessment(record)
    const found = groups.get(shown.questionOfInterest) ?? []
    found.push(shown)
    groups.set(shown.questionOfInterest, found)
  }
  return [...groups.entries()].map(([question, items]) => ({ question, records: items }))
}

// ---------------------------------------------------------------------------
// The two documents
// ---------------------------------------------------------------------------

/** The two documents this module writes, by the export kind each is delivered as. */
export const VCR_MODEL_DOCUMENT_KINDS = frozen(['model_analysis_plan', 'model_analysis_report'])

/**
 * Each document's sections in M15's order (§4.1 for the plan, Appendix 2 for
 * the report), with the sections a run may write prose for. The platform writes
 * the rest — tables, registers, results — and a prose section is the words
 * between them. `appendices` is the platform's alone: references, the frozen
 * plan, the assessment tables.
 */
export const VCR_MODEL_DOCUMENT_SECTIONS = Object.freeze({
  model_analysis_plan: Object.freeze({
    sections: frozen(['introduction', 'objectives', 'data', 'methods']),
    prose: frozen(['introduction', 'objectives', 'data', 'methods']),
  }),
  model_analysis_report: Object.freeze({
    sections: frozen(['executive_summary', 'introduction', 'objectives', 'data_methods', 'results', 'discussion', 'conclusions', 'appendices']),
    prose: frozen(['executive_summary', 'introduction', 'objectives', 'data_methods', 'results', 'discussion', 'conclusions']),
  }),
})

export const VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH = Object.freeze({
  executive_summary: '摘要', introduction: '引言', objectives: '目的', data: '数据', methods: '方法',
  data_methods: '数据与方法', results: '结果', discussion: '讨论', conclusions: '结论', appendices: '附录',
})

/** Both documents' names, in full: the abbreviations stay out of anything a reader sees. */
export const VCR_MODEL_DOCUMENT_TITLES_ZH = Object.freeze({
  model_analysis_plan: '模型分析计划', model_analysis_report: '模型分析报告',
})

/**
 * The line every document carries: whose structure it follows and what it is
 * not. ICH's legal notice allows reuse and adaptation with its copyright
 * acknowledged and changes labelled, and no endorsement implied.
 */
export const VCR_MODEL_DOCUMENT_ATTRIBUTION_ZH =
  '本文件的结构依据 ICH M15《模型引导的药物研发的一般原则》（2026 年 1 月 Step 4），ICH 保留该指导原则的版权；'
  + '内容由平台按研究记录生成，并非 ICH 或任何监管机构的文件，不代表其认可。它说明模型、模拟和情景，不是统计分析计划。'

/**
 * Whether `section` is one a run may write prose for in this document kind.
 * @param {string} kind @param {string} section
 */
export function vcrModelDocumentTakesProse(kind, section) {
  const entry = /** @type {Record<string, { prose: readonly string[] }>} */ (VCR_MODEL_DOCUMENT_SECTIONS)[kind]
  return Boolean(entry && entry.prose.includes(section))
}
