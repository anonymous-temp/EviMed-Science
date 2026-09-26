/**
 * The answer-level evidence grade: A / B / C / D / U for the body of evidence
 * behind one answer, computed in code.
 *
 * Hidden knowledge: why a letter and why not the model. The fusion plan's
 * trust design (§5.8, 答案级) asks every answer — a three-second AI search
 * result and a forty-minute research package alike — to carry one grade, and
 * says it is computed 「以 GRADE 的可判定项为基础由代码计算…模型只写理由」. The
 * reason is the same one `appraisalStructure.mjs` gives for recomputing GRADE
 * from its parts: a letter two rungs away from its own evidence reads exactly
 * like a letter that follows from it, and nobody can see the difference. So
 * the four inputs this module reads are the ones a machine can decide —
 *
 *   1. the study design of each source (`sourceTypes.mjs`, already decided
 *      once for the badge every surface draws),
 *   2. how many studies and how many participants stand behind the answer,
 *   3. whether the sources point the same way,
 *   4. whether the confidence interval crosses the line of no effect
 *
 * — and nothing else. Risk of bias, indirectness, publication bias and
 * applicability are judgements; they belong to the deep-research line's own
 * appraisal (`appraisalStructure.mjs`, `appraisalContract.mjs`), which grades
 * one outcome of one package rather than one answer, and they are deliberately
 * absent here. That is what `U` is for: a body the four decidable items cannot
 * grade is ungraded, never guessed.
 *
 * The output is `{ grade, reasons }` and the reasons are facts — a code, the
 * numbers it counted, and what it did to the letter. The sentence a reader
 * sees under the badge is the model's to write from them (§5.8 「模型只写理由」);
 * each reason's `text` is the fact itself rendered from its own numbers and a
 * closed vocabulary, never an explanation.
 *
 * Shared on purpose. EviMed's quick-answer line and this platform's
 * deep-research line both call it, so an answer does not change grade by
 * changing which engine produced it, and both phrase a conclusion with the
 * same certainty words (`CERTAINTY_WORDING_ZH`, §5.8 论断级: 高「可降低」,
 * 中「很可能降低」, 低「可能降低」, 极低「是否降低尚不确定」). Nothing here
 * imports anything server-only, reads a path, or reaches a network: its input
 * is the source records a retrieval already returned.
 *
 * Build to delete: none of it. The letter is the moat's shape — a contract on
 * an output, decided by code — and the model cannot be given the pen without
 * giving up the property the badge exists to have.
 *
 * @module @evimed/domain/src/answerEvidenceGrade
 */

import { CERTAINTY_LEVELS, CERTAINTY_LEVEL_LABELS_ZH } from './appraisalStructure.mjs'
import { EVIDENCE_SOURCE_TYPE_LABELS_ZH, evidenceSourceTypeOf, isEvidenceSourceType } from './sourceTypes.mjs'

/** @typedef {import('./appraisalStructure.mjs').CertaintyLevel} CertaintyLevel */
/** @typedef {import('./sourceTypes.mjs').EvidenceSourceType} EvidenceSourceType */
/** @typedef {'A' | 'B' | 'C' | 'D' | 'U'} AnswerEvidenceGrade */
/** @typedef {'increase' | 'decrease' | 'no-difference' | 'unclear'} EffectDirection */

/** Every grade a body of evidence can carry, strongest first; `U` is not a rung. */
export const ANSWER_EVIDENCE_GRADES = /** @type {readonly AnswerEvidenceGrade[]} */ (
  Object.freeze(['A', 'B', 'C', 'D', 'U'])
)

/**
 * The four graded letters in `CERTAINTY_LEVELS` order, so the index is the
 * arithmetic and the two ladders cannot drift: D ↔ very-low, C ↔ low,
 * B ↔ moderate, A ↔ high.
 */
const GRADE_LADDER = /** @type {readonly AnswerEvidenceGrade[]} */ (Object.freeze(['D', 'C', 'B', 'A']))

/** The badge a reader sees beside the letter. */
export const ANSWER_EVIDENCE_GRADE_LABELS_ZH = /** @type {Readonly<Record<AnswerEvidenceGrade, string>>} */ (
  Object.freeze({
    A: CERTAINTY_LEVEL_LABELS_ZH.high,
    B: CERTAINTY_LEVEL_LABELS_ZH.moderate,
    C: CERTAINTY_LEVEL_LABELS_ZH.low,
    D: CERTAINTY_LEVEL_LABELS_ZH['very-low'],
    U: '未分级',
  })
)

/**
 * How a conclusion is phrased at each certainty, so the two engines say the
 * same thing (fusion plan §5.8, 论断级: 「措辞与确定性一致」). `{verb}` is the
 * verb the conclusion is about — 降低, 增加, 改善 — and `example` is the
 * plan's own wording, kept verbatim so a change to the table is visible.
 *
 * A certainty has one wording and one only. The reason the table is here
 * rather than in each engine is that the plan's failure mode is two engines
 * hedging the same body of evidence differently, which reads to a clinician as
 * two different findings.
 */
export const CERTAINTY_WORDING_ZH = /** @type {Readonly<Record<CertaintyLevel, Readonly<{ level: CertaintyLevel, label: string, template: string, example: string }>>>} */ (
  Object.freeze({
    high: Object.freeze({ level: 'high', label: CERTAINTY_LEVEL_LABELS_ZH.high, template: '可{verb}', example: '可降低' }),
    moderate: Object.freeze({ level: 'moderate', label: CERTAINTY_LEVEL_LABELS_ZH.moderate, template: '很可能{verb}', example: '很可能降低' }),
    low: Object.freeze({ level: 'low', label: CERTAINTY_LEVEL_LABELS_ZH.low, template: '可能{verb}', example: '可能降低' }),
    'very-low': Object.freeze({ level: 'very-low', label: CERTAINTY_LEVEL_LABELS_ZH['very-low'], template: '是否{verb}尚不确定', example: '是否降低尚不确定' }),
  })
)

/**
 * The numbers the letter turns on, in one place because they are the thing a
 * methodologist will argue with.
 *
 * - `minGradableSources` — below this the body is `U`. Two of the four
 *   decidable inputs (direction consistency across sources, and how many
 *   studies there are) are undefined for a single source, so one citation is a
 *   citation and not a body of evidence.
 * - `minParticipants` — GRADE's optimal-information-size rule of thumb
 *   (GRADE guidelines 6, Guyatt et al., J Clin Epidemiol 2011;64:1283–1293:
 *   rate down for imprecision when the total is below what a single adequately
 *   powered trial would need, conventionally ~400 participants). Below it the
 *   body loses a rung; with no size decidable at all the letter is capped
 *   rather than dropped, because unknown is not the same as small.
 * - `crossingFraction` — with no pooled estimate, the body's precision is only
 *   as good as its studies: half or more of the intervals admitting no effect
 *   is a body that cannot claim a precise one. A pooled estimate, when given,
 *   answers the question by itself and this fraction is not consulted.
 */
export const ANSWER_EVIDENCE_THRESHOLDS = Object.freeze({
  minGradableSources: 2,
  minParticipants: 400,
  crossingFraction: 0.5,
})

/**
 * What each evidence source type is worth as a design, highest first.
 *
 * Written out rather than derived from the order of `source-types.json`,
 * which is a display order: a badge reordered for the shell must not silently
 * change a grade.
 *
 *   4 — a guideline, a systematic review or a meta-analysis: a body of
 *       evidence already assembled and appraised by someone.
 *   3 — a randomised controlled trial. GRADE starts a randomised body at high.
 *   2 — a non-randomised trial, a drug label, a regulator's document. A label
 *       is a regulator's approved summary and authoritative for what it
 *       states, but it is not a study with a design, so it cannot carry an
 *       answer to the top rung on its own. GRADE starts a non-randomised body
 *       at low.
 *   1 — an observational study (cohort, case-control, cross-sectional).
 *   0 — a case report.
 *
 * A type absent from this table is not gradable and is counted, not graded: a
 * narrative review is secondary prose, a trial registration has no results,
 * and `other` is the table saying it does not know (`sourceTypes.mjs` returns
 * `other` rather than guessing).
 * @type {Readonly<Record<string, number>>}
 */
const DESIGN_RANKS = Object.freeze({
  guideline: 4,
  'systematic-review': 4,
  'meta-analysis': 4,
  rct: 3,
  'clinical-trial': 2,
  label: 2,
  regulatory: 2,
  observational: 1,
  'case-report': 0,
})

/** Where a body starts, by the best design in it. The index is the rank. */
const START_BY_RANK = /** @type {readonly AnswerEvidenceGrade[]} */ (Object.freeze(['D', 'C', 'C', 'A', 'A']))

/** The line of no effect on each scale. */
const NULL_BY_SCALE = Object.freeze({ ratio: 1, difference: 0 })

/**
 * Which scale an effect measure is on, so a caller may name the measure
 * instead of the null line. A closed list: a measure not on it makes the
 * effect undecidable rather than assumed to be a ratio, because assuming is
 * how an interval around a risk difference gets checked against 1.
 * @type {Readonly<Record<string, 'ratio' | 'difference'>>}
 */
const SCALE_BY_MEASURE = Object.freeze({
  rr: 'ratio', or: 'ratio', hr: 'ratio', irr: 'ratio', sir: 'ratio', smr: 'ratio', ratio: 'ratio',
  md: 'difference', wmd: 'difference', smd: 'difference', rd: 'difference', ard: 'difference', beta: 'difference', difference: 'difference',
})

/** How a caller may spell a direction. Closed, like every other vocabulary here. */
const DIRECTION_WORDS = Object.freeze({
  increase: 'increase', increased: 'increase', up: 'increase', higher: 'increase',
  decrease: 'decrease', decreased: 'decrease', down: 'decrease', lower: 'decrease', reduced: 'decrease', reduction: 'decrease',
  'no-difference': 'no-difference', 'no-effect': 'no-difference', none: 'no-difference', null: 'no-difference', neutral: 'no-difference',
  unclear: 'unclear', unknown: 'unclear',
})

/** The reader's word for each direction. */
const DIRECTION_LABELS_ZH = Object.freeze({
  increase: '升高', decrease: '降低', 'no-difference': '无差异', unclear: '方向不明',
})

/** @param {unknown} value @returns {number | null} */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** @param {unknown} value @returns {number | null} a count, or null when it is not one */
function countOf(value) {
  const number = numberOf(value)
  return number != null && Number.isInteger(number) && number >= 0 ? number : null
}

/** @param {unknown} value @returns {string} */
function word(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * The design of one source: what the caller declared, else what the shared
 * source-type table decides from the record's own metadata.
 * @param {Record<string, any>} source @returns {EvidenceSourceType}
 */
function designOf(source) {
  if (isEvidenceSourceType(source?.design)) return source.design
  return evidenceSourceTypeOf(source)
}

/**
 * The line of no effect an effect is measured against: an explicit
 * `nullValue`, else the scale, else the measure. Null when none of the three
 * says, which makes the interval undecidable.
 * @param {Record<string, any>} effect @returns {number | null}
 */
function nullLineOf(effect) {
  const explicit = numberOf(effect.nullValue)
  if (explicit != null) return explicit
  const scale = NULL_BY_SCALE[/** @type {keyof typeof NULL_BY_SCALE} */ (word(effect.scale))]
  if (scale != null) return scale
  const measure = SCALE_BY_MEASURE[/** @type {keyof typeof SCALE_BY_MEASURE} */ (word(effect.measure))]
  return measure ? NULL_BY_SCALE[measure] : null
}

/**
 * One effect estimate, read down to the two facts this module grades on:
 * whether its interval crosses the line of no effect, and which way it points.
 * Null when the interval or the null line is not decidable — never a guess.
 * @param {unknown} value
 * @returns {{ nullValue: number, low: number, high: number, crossesNull: boolean, direction: EffectDirection } | null}
 */
function readEffect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const effect = /** @type {Record<string, any>} */ (value)
  const first = numberOf(effect.ciLow ?? effect.ciLower ?? effect.lower ?? effect.low)
  const second = numberOf(effect.ciHigh ?? effect.ciUpper ?? effect.upper ?? effect.high)
  if (first == null || second == null) return null
  const nullValue = nullLineOf(effect)
  if (nullValue == null) return null
  const low = Math.min(first, second)
  const high = Math.max(first, second)
  const crossesNull = low <= nullValue && nullValue <= high
  const estimate = numberOf(effect.estimate ?? effect.point ?? effect.value)
  // The point estimate says which way the body points. With none given the
  // interval still does whenever it excludes the null line; when it does not,
  // the direction is exactly what the data leaves open.
  const direction = estimate != null
    ? (estimate > nullValue ? 'increase' : estimate < nullValue ? 'decrease' : 'no-difference')
    : crossesNull ? 'unclear' : low > nullValue ? 'increase' : 'decrease'
  return { nullValue, low, high, crossesNull, direction }
}

/**
 * Which way one source points: what it declared, else what its own effect
 * estimate shows, else `unclear`.
 * @param {Record<string, any>} source
 * @param {ReturnType<typeof readEffect>} effect
 * @returns {EffectDirection}
 */
function directionOf(source, effect) {
  const declared = DIRECTION_WORDS[/** @type {keyof typeof DIRECTION_WORDS} */ (word(source?.direction))]
  if (declared) return /** @type {EffectDirection} */ (declared)
  return effect ? effect.direction : 'unclear'
}

/**
 * @typedef {object} AnswerEvidenceReason
 * @property {string} code   one of a closed set: `design`, `studies`, `participants`, `direction`, `interval`, `cap`, `insufficient`
 * @property {number} steps  what this fact did to the letter: `0`, or `-1` for a rung lost
 * @property {string} text   the numbers in this object rendered in Chinese; a fact, not an explanation
 */

/**
 * @typedef {object} AnswerEvidenceResult
 * @property {AnswerEvidenceGrade} grade
 * @property {readonly AnswerEvidenceReason[]} reasons the decidable facts the letter was computed from
 */

/** @param {string} code @param {number} steps @param {string} text @param {Record<string, any>} facts @returns {any} */
function reason(code, steps, text, facts) {
  return Object.freeze({ code, steps, text, ...facts })
}

/** @param {Record<string, number>} counts @param {Readonly<Record<string, string>>} labels @returns {string} */
function tally(counts, labels) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${labels[key] ?? key} ${count}`)
    .join(' · ')
}

/**
 * The grade of the body of evidence behind one answer.
 *
 * Every source is read for four things and nothing else: its design, how many
 * studies and participants it brings, which way it points, and whether its
 * interval crosses the line of no effect. A source may be a retrieval record
 * as the tools return it — the design is then decided by the shared
 * source-type table — or may declare `design` itself.
 *
 * Per source (all optional beyond the record itself):
 *   `design`        an evidence source type, when the caller already knows it
 *   `studies`       how many studies it pools; a primary study is 1
 *   `participants`  how many people are in it (`sampleSize` / `n` also read)
 *   `direction`     `increase` / `decrease` / `no-difference` / `unclear`
 *   `effect`        `{ estimate, ciLow, ciHigh }` plus `nullValue`, `scale`
 *                   (`ratio` / `difference`) or `measure` (`rr`, `md`, …)
 *
 * `pooledEffect` is the body's own estimate when one exists — a meta-analysis
 * of the sources, or the single estimate the answer rests on. Given one, it
 * decides the interval question outright.
 *
 * @param {{ sources?: unknown, pooledEffect?: unknown }} input
 * @returns {AnswerEvidenceResult}
 */
export function gradeAnswerEvidence(input) {
  const sources = Array.isArray(input?.sources) ? input.sources : []
  /** @type {Record<string, number>} */
  const designs = {}
  /** @type {Record<EffectDirection, number>} */
  const directions = { increase: 0, decrease: 0, 'no-difference': 0, unclear: 0 }
  let gradable = 0
  let ungradable = 0
  let topRank = -1
  /** @type {EvidenceSourceType | null} the first source that reached `topRank`, so ties break on the caller's own order */
  let topDesign = null
  let studies = 0
  let participants = 0
  let sized = 0
  let intervals = 0
  let crossing = 0

  for (const entry of sources) {
    const source = entry && typeof entry === 'object' ? /** @type {Record<string, any>} */ (entry) : {}
    const design = designOf(source)
    designs[design] = (designs[design] ?? 0) + 1
    const rank = DESIGN_RANKS[design]
    if (rank == null) {
      ungradable += 1
      continue
    }
    gradable += 1
    if (rank > topRank) {
      topRank = rank
      topDesign = design
    }
    studies += countOf(source.studies) ?? 1
    const size = countOf(source.participants ?? source.sampleSize ?? source.n)
    if (size != null) {
      participants += size
      sized += 1
    }
    const effect = readEffect(source.effect)
    if (effect) {
      intervals += 1
      if (effect.crossesNull) crossing += 1
    }
    directions[directionOf(source, effect)] += 1
  }

  const designText = gradable > 0
    ? `可判定来源 ${gradable} 份（${tally(designs, EVIDENCE_SOURCE_TYPE_LABELS_ZH)}）`
    : `可判定来源 0 份（共 ${sources.length} 份）`
  const designFact = { sources: sources.length, gradable, ungradable, designs: Object.freeze({ ...designs }), topDesign }

  if (gradable < ANSWER_EVIDENCE_THRESHOLDS.minGradableSources) {
    return Object.freeze({
      grade: /** @type {AnswerEvidenceGrade} */ ('U'),
      reasons: Object.freeze([
        reason('design', 0, designText, designFact),
        reason('insufficient', 0, `可判定来源不足 ${ANSWER_EVIDENCE_THRESHOLDS.minGradableSources} 份，不评级`, {
          gradable,
          required: ANSWER_EVIDENCE_THRESHOLDS.minGradableSources,
        }),
      ]),
    })
  }

  const start = START_BY_RANK[topRank]
  /** @type {AnswerEvidenceReason[]} */
  const reasons = [reason('design', 0, `${designText}，最高设计等级：${topDesign == null ? '未知' : EVIDENCE_SOURCE_TYPE_LABELS_ZH[topDesign]}`, designFact)]
  let index = GRADE_LADDER.indexOf(start)

  reasons.push(reason('studies', 0, `共 ${studies} 项研究`, { studies }))

  // Size. Known and short of the optimal information size costs a rung;
  // nothing decidable at all caps the letter later instead, because a body
  // whose size nobody reported is not thereby a small one.
  const knownParticipants = sized > 0 ? participants : null
  const shortOfSize = knownParticipants != null && knownParticipants < ANSWER_EVIDENCE_THRESHOLDS.minParticipants
  if (shortOfSize) index -= 1
  reasons.push(reason(
    'participants',
    shortOfSize ? -1 : 0,
    knownParticipants == null
      ? '样本量不可判定'
      : `共 ${knownParticipants} 名受试者${shortOfSize ? `（少于 ${ANSWER_EVIDENCE_THRESHOLDS.minParticipants}）` : ''}${sized < gradable ? `，${gradable - sized} 份来源未报告样本量` : ''}`,
    { participants: knownParticipants, sized, unsized: gradable - sized, threshold: ANSWER_EVIDENCE_THRESHOLDS.minParticipants },
  ))

  // Consistency. Opposite directions in one body is the decidable case, and
  // the one §5.8 asks the conclusion to open with 「证据不一致：」. A source
  // showing no difference beside one showing an effect is imprecision, which
  // the interval below already answers, so it is recorded and does not move
  // the letter twice.
  const conflict = directions.increase > 0 && directions.decrease > 0
  if (conflict) index -= 1
  reasons.push(reason(
    'direction',
    conflict ? -1 : 0,
    `${conflict ? '方向不一致' : '方向一致'}：${tally(directions, DIRECTION_LABELS_ZH) || '无可判定方向'}`,
    { directions: Object.freeze({ ...directions }), conflict },
  ))

  // Precision.
  const pooled = readEffect(input?.pooledEffect)
  const crossesNull = pooled
    ? pooled.crossesNull
    : intervals > 0 ? crossing / intervals >= ANSWER_EVIDENCE_THRESHOLDS.crossingFraction : null
  if (crossesNull === true) index -= 1
  reasons.push(reason(
    'interval',
    crossesNull === true ? -1 : 0,
    crossesNull == null
      ? '置信区间不可判定'
      : pooled
        ? `合并效应的置信区间${crossesNull ? '跨过' : '未跨过'}无效线`
        : `${intervals} 份来源报告了置信区间，其中 ${crossing} 份跨过无效线`,
    { pooled: Boolean(pooled), crossesNull, intervals, crossing },
  ))

  let grade = GRADE_LADDER[Math.min(GRADE_LADDER.length - 1, Math.max(0, index))]

  // The one cap. The top letter is a statement that the body is big enough,
  // and a body whose size nobody reported has not made it — so the answer is
  // B, on the facts, rather than an A nothing checked.
  if (grade === 'A' && knownParticipants == null) {
    reasons.push(reason('cap', 0, '样本量不可判定，最高给到 B', { from: 'A', to: 'B', because: 'participants-unknown' }))
    grade = 'B'
  }

  return Object.freeze({ grade, reasons: Object.freeze(reasons) })
}

/**
 * The GRADE certainty a letter stands for, or null for `U`.
 * @param {unknown} grade @returns {CertaintyLevel | null}
 */
export function answerGradeCertainty(grade) {
  const index = GRADE_LADDER.indexOf(/** @type {AnswerEvidenceGrade} */ (grade))
  return index < 0 ? null : CERTAINTY_LEVELS[index]
}

/**
 * A conclusion phrased at a certainty: `certaintyWording('moderate', '降低')`
 * is 「很可能降低」. Null for a level this table does not have.
 * @param {unknown} level @param {string} verb @returns {string | null}
 */
export function certaintyWording(level, verb) {
  const row = CERTAINTY_WORDING_ZH[/** @type {CertaintyLevel} */ (level)]
  const written = String(verb ?? '').trim()
  return row && written ? row.template.replace('{verb}', written) : null
}

/**
 * The same, from the letter: `answerGradeWording('B', '降低')` is 「很可能降低」.
 * Null for `U`, which says nothing about the effect and must not be phrased as
 * if it did.
 * @param {unknown} grade @param {string} verb @returns {string | null}
 */
export function answerGradeWording(grade, verb) {
  return certaintyWording(answerGradeCertainty(grade), verb)
}
