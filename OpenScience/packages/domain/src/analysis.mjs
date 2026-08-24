/**
 * The unified analysis layer's vocabulary: what a source is, how deeply it is
 * read, and how "did we get everything" is measured.
 *
 * Hidden knowledge: two ideas that decide the whole design.
 *
 * The first is that "useful or not" is the wrong question. A researcher's
 * library is not divided into worth-keeping and worth-discarding; it is divided
 * by how deeply each item repays reading. So triage produces a value vector, not
 * a verdict, and the vector picks a depth. Everything is indexed — findability
 * is free and its absence is unrecoverable — and only what earns it is
 * distilled.
 *
 * The second is that "did we get everything" is two questions with two answers.
 * *Index* completeness is guaranteed by construction: every unit of every source
 * enters the index, and the coverage ledger records where each one went, so the
 * answer is 100% or the ledger is wrong. *Distillation* completeness cannot be
 * guaranteed, only measured — the dominant failure of long-document extraction
 * is omission rather than fabrication — so it is audited by asking questions of
 * the source and checking whether the distilled form can answer them.
 *
 * @module @evimed/domain/analysis
 */

/**
 * The twenty-two source types.
 *
 * Defined once here; the extractor registry, the tidying bench and the Python
 * analysis package all derive from this list rather than restating it.
 */
export const SOURCE_TYPES = Object.freeze([
  'published-paper-own',
  'published-paper-other',
  'preprint-or-draft',
  'review-or-guideline',
  'book-or-chapter',
  'conference-abstract',
  'grant-application',
  'protocol-or-sop',
  'review-comments-written',
  'review-comments-received',
  'tcm-case-record',
  'clinical-case',
  'cohort-data',
  'statistical-output',
  'lecture-slides',
  'audio-recording',
  'video',
  'course-pack',
  'note',
  'email-or-chat-export',
  'administrative-or-financial',
  'image-or-figure',
])

/** How deeply a source is read. */
export const ANALYSIS_DEPTHS = Object.freeze(['skip', 'index_only', 'structured', 'deep'])

/**
 * The five value dimensions.
 *
 * Five rather than one because they pull apart: a colleague's paper can be high
 * `evidenceValue` and zero `methodValue`, while the user's own SOP is the
 * reverse. A single "importance" score would average those into the middle and
 * distil both at the same wrong depth.
 */
export const VALUE_DIMENSIONS = Object.freeze([
  'profileValue',
  'methodValue',
  'knowledgeValue',
  'evidenceValue',
  'dataValue',
])

/** Which layer each dimension feeds. */
export const VALUE_DIMENSION_LAYERS = Object.freeze({
  profileValue: 'profile',
  methodValue: 'methods',
  knowledgeValue: 'knowledge',
  evidenceValue: 'knowledge',
  dataValue: 'sources',
})

/** The author's relationship to the source; the strongest single signal. */
export const AUTHORSHIP = Object.freeze(['self', 'coauthor', 'other', 'unknown'])

/** Units a source is divided into, per type. */
export const COVERAGE_UNIT_TYPES = Object.freeze(['page', 'slide', 'segment', 'column', 'chunk', 'row_group'])

/** Where a unit ended up. Every unit has exactly one. */
export const COVERAGE_STATES = Object.freeze(['extracted', 'indexed_only', 'no_content', 'failed'])

/** A source's lifecycle in the analysis layer. */
export const SOURCE_STATES = Object.freeze([
  'queued',
  'uploading',
  'scanning',
  'parsing',
  'distilling',
  'done',
  'needs_attention',
  'missing',
])

/**
 * The connector contract: five methods, whatever the drive underneath.
 *
 * Forty drive APIs behind one shape is the point — not a rename table over
 * each, but one vocabulary they are all converted into, so a provider that
 * changes is one adapter and not forty call sites.
 */
export const CONNECTOR_METHODS = Object.freeze(['list', 'fetch', 'capabilities', 'isProcessed', 'saveRaw'])

/** What a connector can and cannot do; the planner reads it rather than assuming. */
export const CONNECTOR_CAPABILITY_FIELDS = Object.freeze(['providerHash', 'changeFeed', 'rangeRead', 'speedTier'])

/**
 * The default depth per source type.
 *
 * Overridable per folder and per type, because the strongest prior available is
 * the user saying "this folder is all lecture slides" — better than any
 * classifier, and free.
 */
export const DEFAULT_DEPTH_BY_TYPE = Object.freeze({
  'published-paper-own': 'deep',
  'protocol-or-sop': 'deep',
  'review-comments-written': 'deep',
  'lecture-slides': 'deep',
  'tcm-case-record': 'deep',
  'clinical-case': 'deep',
  'grant-application': 'deep',
  'course-pack': 'deep',
  'published-paper-other': 'structured',
  'review-or-guideline': 'structured',
  'book-or-chapter': 'structured',
  'preprint-or-draft': 'structured',
  'cohort-data': 'structured',
  'statistical-output': 'structured',
  'audio-recording': 'structured',
  'video': 'structured',
  'review-comments-received': 'structured',
  'conference-abstract': 'index_only',
  'note': 'index_only',
  'email-or-chat-export': 'index_only',
  'image-or-figure': 'index_only',
  'administrative-or-financial': 'skip',
})

/**
 * Chooses a depth.
 *
 * Order matters, and it is the order of how much each signal is worth: an
 * explicit override beats a duplicate check beats a value computation beats a
 * type default. Every decision carries its reasons, because the tidying bench
 * shows them and a user correcting one is the highest-quality signal available.
 *
 * @param {{
 *   sourceType: string,
 *   value: Partial<Record<string, number>>,
 *   authorship?: string,
 *   duplicateOf?: string | null,
 *   corrupt?: boolean,
 *   override?: string | null,
 * }} input
 * @returns {{ depth: string, reasons: string[] }}
 */
export function chooseDepth(input) {
  /** @type {string[]} */
  const reasons = []
  if (input.override && ANALYSIS_DEPTHS.includes(input.override)) {
    return { depth: input.override, reasons: ['用户为这个文件夹或类型设置了深度'] }
  }
  if (input.duplicateOf) {
    return { depth: 'skip', reasons: [`与 ${input.duplicateOf} 是同一份内容的另一个版本`] }
  }
  if (input.corrupt) {
    return { depth: 'skip', reasons: ['文件损坏或无法解析'] }
  }
  if (input.authorship === 'self') reasons.push('本人是作者')
  const total = VALUE_DIMENSIONS.reduce((sum, key) => sum + (Number(input.value?.[key]) || 0), 0)
  // The table is deliberately partial: an unlisted source type falls
  // through to the default rather than being an error.
  const base = /** @type {Record<string, string>} */ (DEFAULT_DEPTH_BY_TYPE)[input.sourceType] ?? 'index_only'
  reasons.push(`类型「${input.sourceType}」的默认深度是 ${base}`)

  // Authorship promotes, because the user's own work is where their method and
  // their stance actually live — the thing the capsule exists to learn.
  if (input.authorship === 'self' && base === 'structured') {
    return { depth: 'deep', reasons: [...reasons, '本人作品提升一档'] }
  }
  if (base === 'index_only' && total >= 2.5) {
    return { depth: 'structured', reasons: [...reasons, `五维价值合计 ${total.toFixed(2)}，高于结构化门槛`] }
  }
  if (base === 'structured' && total < 1) {
    return { depth: 'index_only', reasons: [...reasons, `五维价值合计 ${total.toFixed(2)}，不值得结构化`] }
  }
  return { depth: base, reasons }
}

/**
 * Index completeness, which is a construction rather than a measurement.
 *
 * A unit with no recorded destination is a hole in the ledger, not a low score:
 * the ledger's whole claim is that it accounts for everything, so an unaccounted
 * unit means the ledger is wrong and says which one.
 *
 * @param {readonly { unitId: string, status: string }[]} ledger
 * @param {number} expectedUnits
 * @returns {{ complete: boolean, accounted: number, expected: number, missing: number }}
 */
export function indexCompleteness(ledger, expectedUnits) {
  const accounted = new Set(ledger.filter((row) => COVERAGE_STATES.includes(row.status)).map((row) => row.unitId)).size
  return {
    complete: accounted >= expectedUnits,
    accounted,
    expected: expectedUnits,
    missing: Math.max(0, expectedUnits - accounted),
  }
}

/**
 * Distillation completeness, which can only be measured.
 *
 * Questions are generated from the source and answered from the distilled form;
 * the miss rate is what the audit reports. Unanswerable questions are counted as
 * misses on purpose — a question the source answers and the distillation cannot
 * is exactly the omission being looked for.
 *
 * @param {readonly { unitId: string, answered: boolean }[]} audits
 * @param {string} depth
 * @returns {{ omissionRate: number, target: number, withinTarget: boolean, audited: number }}
 */
export function distillationCompleteness(audits, depth) {
  const targets = { deep: 0.05, structured: 0.15 }
  const target = /** @type {Record<string, number>} */ (targets)[depth] ?? 1
  if (!audits.length) return { omissionRate: 0, target, withinTarget: true, audited: 0 }
  const missed = audits.filter((audit) => !audit.answered).length
  const omissionRate = missed / audits.length
  return { omissionRate: Number(omissionRate.toFixed(4)), target, withinTarget: omissionRate <= target, audited: audits.length }
}

/**
 * Expected output per source type.
 *
 * Below the floor, the source is re-read one depth up rather than accepted:
 * a paper that yielded two claims was not a thin paper, it was a bad read.
 */
export const EXPECTED_OUTPUT_FLOORS = Object.freeze({
  'published-paper-own': { claims: 5, slots: ['design', 'population', 'intervention', 'outcome'] },
  'published-paper-other': { claims: 5, slots: ['design', 'population', 'outcome'] },
  'lecture-slides': { perSlide: 1 },
  'audio-recording': { perTenMinutes: 1 },
  'cohort-data': { codebookColumnFraction: 0.9 },
})

/**
 * Whether a source's output is suspiciously thin.
 * @param {{ sourceType: string, claims?: number, slidesCovered?: number, slides?: number, minutes?: number, topics?: number, columnsDocumented?: number, columns?: number }} produced
 * @returns {{ suspicious: boolean, reason: string | null }}
 */
export function outputBelowFloor(produced) {
  // Partial by design, and each source type carries only the floors that
  // apply to it — a slide count means nothing for a cohort table.
  const floor = /** @type {Record<string, { claims?: number, slots?: string[], perSlide?: number, perTenMinutes?: number, codebookColumnFraction?: number }>} */ (EXPECTED_OUTPUT_FLOORS)[produced.sourceType]
  if (!floor) return { suspicious: false, reason: null }
  if (floor.claims != null && Number(produced.claims ?? 0) < floor.claims) {
    return { suspicious: true, reason: `只抽出 ${produced.claims ?? 0} 条结论，低于该类型的 ${floor.claims} 条下限` }
  }
  if (floor.perSlide != null && Number(produced.slides ?? 0) > 0) {
    const covered = Number(produced.slidesCovered ?? 0)
    if (covered < Number(produced.slides)) {
      return { suspicious: true, reason: `${produced.slides} 页里只覆盖了 ${covered} 页` }
    }
  }
  if (floor.perTenMinutes != null && Number(produced.minutes ?? 0) > 0) {
    const expected = Math.ceil(Number(produced.minutes) / 10)
    if (Number(produced.topics ?? 0) < expected) {
      return { suspicious: true, reason: `${produced.minutes} 分钟录音只有 ${produced.topics ?? 0} 个主题，低于每 10 分钟 1 个` }
    }
  }
  if (floor.codebookColumnFraction != null && Number(produced.columns ?? 0) > 0) {
    const fraction = Number(produced.columnsDocumented ?? 0) / Number(produced.columns)
    if (fraction < floor.codebookColumnFraction) {
      return { suspicious: true, reason: `codebook 只覆盖 ${(fraction * 100).toFixed(0)}% 的列，低于 ${(floor.codebookColumnFraction * 100).toFixed(0)}%` }
    }
  }
  return { suspicious: false, reason: null }
}
