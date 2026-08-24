/**
 * Evidence ingestion from observed tool results.
 *
 * Hidden knowledge: what counts as evidence and how far it got. The evidence
 * table is not a second copy of the citation ledger — it records the *retrieval*
 * side: which source was asked for, whether its text was actually preserved,
 * and whether the server-side gate later confirmed it. A claim that cites a
 * source the run only ever saw an abstract of is exactly the failure this makes
 * visible, and it is invisible in the report alone.
 *
 * It runs on `tools/result`, which is read-only: the ledger of a run may not be
 * able to alter the run it is recording.
 *
 * @module @evimed/dsh-socket/src/evidenceIngest
 */

import { mcpToolBaseName } from '@evimed/domain'

/** Tools whose results carry retrievable sources worth recording. */
export const EVIDENCE_TOOL_BASE_NAMES = Object.freeze([
  'literature_search',
  'guideline_search',
  'clinical_trial_search',
  'patent_search',
  'biomedical_source_search',
  'open_access_full_text',
  'official_page_fetch',
  'drug_label_search',
  'pharmacy_reference_search',
  'adr_case_query',
  'web_search',
])

/** Tools whose success means the full text or official page is on disk. */
const PRESERVING_TOOL_BASE_NAMES = new Set(['open_access_full_text', 'official_page_fetch'])

/**
 * @typedef {object} EvidenceRecord
 * @property {string} evidenceId
 * @property {string} runId
 * @property {string} tool
 * @property {string} query
 * @property {string} sourceId
 * @property {string} [doi]
 * @property {string} [artifactPath]
 * @property {string} digest
 * @property {string} status
 * @property {string} recordedAt
 */

/**
 * Extracts evidence records from one observed tool outcome.
 *
 * Deliberately total and forgiving: an unrecognized result shape yields no
 * records rather than an exception, because this runs inside an observer whose
 * failure must be isolated and counted, never allowed to end a turn.
 *
 * @param {{ name: string, args: Record<string, any> }} call
 * @param {{ status: string, structured: unknown, text: string }} outcome
 * @param {{ runId: string, now: string, digest: (value: string) => string }} context
 * @returns {EvidenceRecord[]}
 */
export function evidenceFromOutcome(call, outcome, context) {
  const base = mcpToolBaseName(call?.name ?? '')
  if (!base || !EVIDENCE_TOOL_BASE_NAMES.includes(base)) return []
  if (outcome?.status !== 'completed') return []
  const query = String(call.args?.query ?? call.args?.identifier ?? call.args?.url ?? call.args?.drug ?? '')
  const preserved = PRESERVING_TOOL_BASE_NAMES.has(base)
  /** @type {EvidenceRecord[]} */
  const records = []
  for (const source of sourcesOf(outcome.structured)) {
    const sourceId = String(source.id ?? source.doi ?? source.pmid ?? source.url ?? source.identifier ?? '').trim()
    if (!sourceId) continue
    const artifactPath = String(source.artifactPath ?? source.path ?? '').trim()
    records.push({
      evidenceId: context.digest(`${context.runId}:${base}:${sourceId}`),
      runId: context.runId,
      tool: base,
      query,
      sourceId,
      ...(source.doi ? { doi: String(source.doi) } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      digest: context.digest(JSON.stringify(source)),
      // A search result is a lead; only a preserved artifact is readable text.
      // Recording the difference is what lets the gate tell "cited" from "read".
      status: preserved && artifactPath ? 'ready' : 'queued',
      recordedAt: context.now,
    })
  }
  return records
}

/**
 * Finds the source list in a structured tool result without demanding one
 * shape: twenty-six tools written over a year do not share one.
 * @param {unknown} structured
 * @returns {Record<string, any>[]}
 */
export function sourcesOf(structured) {
  if (!structured || typeof structured !== 'object') return []
  const record = /** @type {Record<string, any>} */ (structured)
  for (const key of ['sources', 'results', 'records', 'items', 'entries', 'hits', 'documents']) {
    const value = record[key]
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object')
  }
  // A single-document tool answers with the document itself.
  if (record.doi || record.pmid || record.url || record.identifier) return [record]
  const data = record.data
  if (data && typeof data === 'object') return sourcesOf(data)
  return []
}

/**
 * Merges new records into the table, keeping the furthest state each source
 * reached. A source that was preserved and then searched for again must not
 * fall back to `queued`.
 * @param {readonly EvidenceRecord[]} existing
 * @param {readonly EvidenceRecord[]} incoming
 * @returns {EvidenceRecord[]}
 */
export function mergeEvidence(existing, incoming) {
  const rank = { queued: 0, stale: 1, ready: 2, rejected: 3, verified: 4 }
  const byId = new Map(existing.map((record) => [record.evidenceId, record]))
  for (const record of incoming) {
    const previous = byId.get(record.evidenceId)
    if (!previous) {
      byId.set(record.evidenceId, record)
      continue
    }
    const keep = (rank[/** @type {keyof typeof rank} */ (previous.status)] ?? 0) >= (rank[/** @type {keyof typeof rank} */ (record.status)] ?? 0)
      ? previous.status
      : record.status
    byId.set(record.evidenceId, { ...previous, ...record, status: keep })
  }
  return [...byId.values()]
}
