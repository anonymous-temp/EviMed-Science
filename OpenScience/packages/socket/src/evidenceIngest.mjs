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

import { evidenceSourceTypeOf, mcpToolBaseName } from '@evimed/domain'

/** Tools whose results carry retrievable sources worth recording. */
export const EVIDENCE_TOOL_BASE_NAMES = Object.freeze([
  'literature_search',
  // A reference list names works a run may then fetch; recorded as retrieval
  // leads like any search result (2026-09-23).
  'reference_list',
  // Linked identifiers, a trial's preserved record and a US label by version
  // (2026-10-04): each result names the sources it read, and the last two
  // preserve a quotable record.md / label.md.
  'identifier_resolve',
  'clinical_trial_snapshot',
  'dailymed_label',
  'guideline_search',
  'clinical_trial_search',
  'patent_search',
  'biomedical_source_search',
  'open_access_full_text',
  'web_read',
  'drug_label_search',
  'pharmacy_reference_search',
  'adr_case_query',
  'web_search',
])

/** Tools whose success means the full text or official page is on disk. */
const PRESERVING_TOOL_BASE_NAMES = new Set(['open_access_full_text', 'web_read', 'clinical_trial_snapshot', 'dailymed_label'])

/**
 * The three assessment tools. Their `retrieve` action (the default) asks the
 * EviMed evidence service and answers with what it found — retrieval like any
 * search. `compile` answers with the `sourceInventory` the run itself handed
 * in, and recording that as retrieved would turn the run's own list into the
 * platform's record of it, which is the one thing the record is for not being.
 */
const ASSESSMENT_TOOL_BASE_NAMES = new Set(['comprehensive_drug_evaluation', 'drug_selection_evaluation', 'offlabel_evidence_packet'])

/** Characters of a title kept on a record: enough to recognise the work. */
const TITLE_LIMIT = 300

/**
 * Whether a call is a retrieval whose result names sources: one of the search
 * and read tools, or an assessment tool asked to retrieve.
 * @param {{ name?: string, args?: Record<string, any> }} call @returns {boolean}
 */
export function isEvidenceCall(call) {
  const base = mcpToolBaseName(call?.name ?? '')
  if (!base) return false
  if (EVIDENCE_TOOL_BASE_NAMES.includes(base)) return true
  const action = call?.args?.action
  return ASSESSMENT_TOOL_BASE_NAMES.has(base) && (action === undefined || action === null || action === '' || action === 'retrieve')
}

/**
 * What the call asked for, as one line: the query, or the identifier, address,
 * medicine, label or PMIDs a lookup names. A `pmids` lookup and a `labelId`
 * read used to record an empty query.
 * @param {Record<string, any> | undefined} args @returns {string}
 */
function queryOf(args) {
  for (const key of ['query', 'identifier', 'url', 'drug', 'labelId']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const pmids = args?.pmids
  if (Array.isArray(pmids) && pmids.length) return `pmids: ${pmids.map(String).join(', ')}`
  if (typeof pmids === 'string' && pmids.trim()) return `pmids: ${pmids.trim()}`
  return ''
}

/**
 * @typedef {object} EvidenceRecord
 * @property {string} evidenceId
 * @property {string} runId
 * @property {string} tool
 * @property {string} query
 * @property {string} sourceId
 * @property {string} [doi]
 * @property {string} [pmid]
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [artifactPath]
 * @property {string[]} [artifactPaths]  further preserved text files of the same source
 * @property {string} [sourceType]
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
  if (!base || !isEvidenceCall(call)) return []
  if (outcome?.status !== 'completed') return []
  const query = queryOf(call.args)
  const preserved = PRESERVING_TOOL_BASE_NAMES.has(base)
  const sources = sourcesOf(outcome.structured)
  // Where the preserving tools actually put the path. The MCP contract returns
  // `data.markdownPath` and a top-level `artifacts` list; the per-source
  // entries carry id/title/url/retrievedAt and nothing else. This function
  // looked for `source.artifactPath`, found nothing, and recorded every
  // full-text fetch as `queued` -- so the stale sweep flipped the entire
  // evidence table, preserved artifacts included: two real runs showed 91/91
  // and 126/126 stale with the fulltext files sitting on disk.
  //
  // Applied only when the result carries exactly one source: with several,
  // attributing the outcome's single artifact to each of them would invent
  // readability the run does not have.
  const structured = /** @type {Record<string, any>} */ (
    outcome.structured && typeof outcome.structured === 'object' ? outcome.structured : {}
  )
  const outcomeArtifact = sources.length === 1
    ? String(
        structured?.data?.markdownPath
          ?? (Array.isArray(structured?.artifacts)
            ? structured.artifacts.find((entry) => typeof entry === 'string' && entry.endsWith('.md'))
            : undefined)
          ?? '',
      ).trim()
    : ''
  // Every preserved text file a single-source result names, beyond the one
  // above. A label read preserves the whole label, one file per section
  // (`drug-labels/<digest>/<version>/<section>.md`), and names them in
  // `artifacts` and `data.artifactSha256s` — never on its one source. Recorded
  // with no path, the label reached no quote check: 33 of 55 claims of the
  // 2026-09-28 clopidogrel insight pack were 「could not be checked」, each
  // quoting a section file the run had read.
  const preservedTexts = sources.length === 1 ? preservedTextPaths(structured) : []
  /** @type {EvidenceRecord[]} */
  const records = []
  for (const source of sources) {
    const sourceId = String(source.id ?? source.doi ?? source.pmid ?? source.url ?? source.identifier ?? '').trim()
    if (!sourceId) continue
    const artifactPath = String(source.artifactPath ?? source.path ?? '').trim()
      || (preserved ? outcomeArtifact : '')
    // What a reader and the snapshot need to recognise the source: its
    // address, its PMID and its title. The table used to keep an identifier
    // and a hash of the rest, so nothing downstream could say which work a
    // row was without the tool result, which only the transcript holds.
    const url = typeof source.url === 'string' && /^https?:\/\//i.test(source.url.trim()) ? source.url.trim() : ''
    const pmid = /^\d{1,9}$/.test(String(source.pmid ?? '').trim()) ? String(source.pmid).trim() : ''
    const title = typeof source.title === 'string' ? source.title.trim().slice(0, TITLE_LIMIT) : ''
    const artifactPaths = preservedTexts.filter((path) => path !== artifactPath)
    records.push({
      evidenceId: context.digest(`${context.runId}:${base}:${sourceId}`),
      runId: context.runId,
      tool: base,
      query,
      sourceId,
      ...(source.doi ? { doi: String(source.doi) } : {}),
      ...(pmid ? { pmid } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      ...(artifactPaths.length ? { artifactPaths } : {}),
      // The evidence badge (C8): the research server stamps it; a record from
      // anywhere else is typed from the same table here.
      sourceType: evidenceSourceTypeOf({ ...source, tool: base }),
      digest: context.digest(JSON.stringify(source)),
      // A search result is a lead; only a preserved artifact is readable text.
      // Recording the difference is what lets the gate tell "cited" from "read".
      status: preserved && artifactPath ? 'ready' : 'queued',
      recordedAt: context.now,
    })
  }
  return records
}

/** Preserved files a result may name before the rest are ignored; a label has about twenty sections. */
const PRESERVED_TEXT_LIMIT = 64

/**
 * The preserved text files a result names: the `.md` files under
 * `.evimed-sources/` in its `artifacts` list and its `data.artifactSha256s`,
 * each once, in the order named.
 * @param {Record<string, any>} structured @returns {string[]}
 */
function preservedTextPaths(structured) {
  const named = [
    ...(Array.isArray(structured?.artifacts) ? structured.artifacts : []),
    ...(structured?.data?.artifactSha256s && typeof structured.data.artifactSha256s === 'object' ? Object.keys(structured.data.artifactSha256s) : []),
  ]
  const paths = named
    .filter((path) => typeof path === 'string')
    .map((path) => path.trim())
    .filter((path) => path.startsWith('.evimed-sources/') && path.endsWith('.md') && !path.split('/').includes('..'))
  return [...new Set(paths)].slice(0, PRESERVED_TEXT_LIMIT)
}

/**
 * Finds the source list in a structured tool result without demanding one
 * shape: twenty-six tools written over a year do not share one.
 * @param {unknown} structured
 * @returns {Record<string, any>[]}
 */
export function sourcesOf(structured) {
  return sourceProbe(structured).sources
}

/** Container keys a retrieval tool may answer under. */
const SOURCE_KEYS = ['sources', 'results', 'records', 'items', 'entries', 'hits', 'documents']

/**
 * `sourcesOf` plus the reason it found what it found.
 *
 * Two very different things produce an empty list, and reporting them with one
 * sentence is the defect this whole area keeps repeating: a search that
 * honestly returned nothing looks exactly like a payload whose shape we cannot
 * read. The first is a fact about the literature; the second is a bug that
 * empties the evidence ledger for every run.
 *
 * @param {unknown} structured
 * @returns {{ sources: Record<string, any>[], reason: 'found'|'empty-container'|'no-container'|'not-an-object' }}
 */
export function sourceProbe(structured) {
  if (!structured || typeof structured !== 'object') return { sources: [], reason: 'not-an-object' }
  const record = /** @type {Record<string, any>} */ (structured)
  for (const key of SOURCE_KEYS) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    const sources = value.filter((item) => item && typeof item === 'object')
    // The container was there and it was empty: the tool answered "nothing
    // found", which is an answer.
    return { sources, reason: sources.length ? 'found' : 'empty-container' }
  }
  // A single-document tool answers with the document itself.
  if (record.doi || record.pmid || record.url || record.identifier) return { sources: [record], reason: 'found' }
  const data = record.data
  if (data && typeof data === 'object') {
    const nested = sourceProbe(data)
    return nested.reason === 'no-container' ? { sources: [], reason: 'no-container' } : nested
  }
  return { sources: [], reason: 'no-container' }
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
