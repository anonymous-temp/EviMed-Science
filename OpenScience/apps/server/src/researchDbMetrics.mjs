// The operator's counters for the research-database connector (`researchDb*.mjs`).
//
// Principle 15: every limit has a counter, and a limit nobody can see biting is a limit nobody can tune. Two series:
//
//   open_science_research_db_imports_total{outcome}    complete | partial | replayed | refused
//       one per import request that reached a result. `partial` is an import that succeeded and left something out
//       (a row cap, a cell, a column), `replayed` is a retry answered with the first result, `refused` is a request
//       that produced no source.
//   open_science_research_db_refusals_total{reason}    why: a request refused, or a limit that bit
//       truncated | cells_withheld | columns_dropped   a limit that cut a snapshot that was still imported
//       busy | network_denied | tls_failed | login_failed | too_privileged | unreachable | materials_full | selection_invalid | failed
//                                                      an operation (an import or a table listing) that gave nothing
//
// Module-level like `geneExpressionMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series exists
// from the start at zero, so the first refusal is an increase that `increase()` can see. Counting never fails a request.

export const RESEARCH_DB_IMPORT_OUTCOMES = Object.freeze(['complete', 'partial', 'replayed', 'refused'])
export const RESEARCH_DB_REFUSAL_REASONS = Object.freeze([
  'truncated', 'cells_withheld', 'columns_dropped',
  'busy', 'network_denied', 'tls_failed', 'login_failed', 'too_privileged', 'unreachable', 'materials_full', 'selection_invalid', 'failed',
])

/** The refusal reason of an error code a route answered with; anything this table does not name is `failed`.
 * @type {Readonly<Record<string, string>>} */
const REASON_OF_CODE = Object.freeze({
  research_db_busy: 'busy',
  research_db_network_denied: 'network_denied',
  research_db_tls_failed: 'tls_failed',
  research_db_login_failed: 'login_failed',
  research_db_login_too_privileged: 'too_privileged',
  research_db_unreachable: 'unreachable',
  autopilot_materials_full: 'materials_full',
  research_db_selection_invalid: 'selection_invalid',
})

/** @param {unknown} code */
export function researchDbRefusalReason(code) {
  return Object.hasOwn(REASON_OF_CODE, String(code)) ? REASON_OF_CODE[/** @type {string} */ (code)] : 'failed'
}

/** @type {Map<string, number>} */ const imports = new Map(RESEARCH_DB_IMPORT_OUTCOMES.map(outcome => [outcome, 0]))
/** @type {Map<string, number>} */ const refusals = new Map(RESEARCH_DB_REFUSAL_REASONS.map(reason => [reason, 0]))

/** One import result. An unknown outcome is ignored, never counted under a made-up label. @param {string} outcome */
export function recordResearchDbImport(outcome) {
  if (imports.has(outcome)) imports.set(outcome, (imports.get(outcome) ?? 0) + 1)
}

/** One refusal or one limit that bit. An unknown reason is ignored. @param {string} reason */
export function recordResearchDbRefusal(reason) {
  if (refusals.has(reason)) refusals.set(reason, (refusals.get(reason) ?? 0) + 1)
}

/** The test hook: counters are process state. */
export function resetResearchDbMetrics() {
  for (const key of imports.keys()) imports.set(key, 0)
  for (const key of refusals.keys()) refusals.set(key, 0)
}

/** @returns {Record<string, Record<string, number>>} */
export function researchDbMetricSnapshot() {
  return { imports: Object.fromEntries(imports), refusals: Object.fromEntries(refusals) }
}

/** @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }>} */
export function researchDbMetricFamilies() {
  return [
    {
      name: 'open_science_research_db_imports_total',
      help: 'Research-database table imports by outcome: complete, partial (a row cap, a withheld cell or an unsupported column left something out), replayed (a retry answered with the first result) or refused.',
      type: 'counter',
      series: [...imports].map(([outcome, value]) => ({ value, labels: { outcome } })),
    },
    {
      name: 'open_science_research_db_refusals_total',
      help: 'Research-database operations refused, and limits that bit, by reason: truncated, cells_withheld and columns_dropped are limits that cut an import that was still made; busy, network_denied, tls_failed, login_failed, too_privileged, unreachable, materials_full, selection_invalid and failed gave nothing.',
      type: 'counter',
      series: [...refusals].map(([reason, value]) => ({ value, labels: { reason } })),
    },
  ]
}
