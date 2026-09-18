/**
 * What kind of evidence a source is.
 *
 * Hidden knowledge: a citation is not one kind of thing. A study of 4 979
 * citations in a clinical answer engine found the interface drew a guideline, a
 * randomised trial and a regulator's notice identically, and readers weighed
 * them identically (appendix C §2.1). The kind is decidable from metadata the
 * retrieval tools already return — PubMed publication types, which tool found
 * the record, which authority's page it is — so it is decided here, in code,
 * once (principle 1), and every surface draws the same badge.
 *
 * The table itself is data, `source-types.json`, because it has two readers:
 * this module and the research server's `source_types.py`, which stamps a type
 * on every source record it returns and every capture it preserves. A second
 * copy in Python would be a second truth that drifts; both read the one file,
 * and `test/fixtures/source-type-cases.json` holds the answers both must give.
 *
 * Nothing here judges quality. A guideline badge says what the document is,
 * not that it is right; appraisal stays with the report's own GRADE prose.
 */

import sourceTypeTable from './source-types.json' with { type: 'json' }

/** @typedef {'guideline'|'systematic-review'|'meta-analysis'|'rct'|'clinical-trial'|'observational'|'case-report'|'review'|'label'|'regulatory'|'trial-registration'|'other'} EvidenceSourceType */

/** Every source type, most-authoritative evidence form first. */
export const EVIDENCE_SOURCE_TYPES = /** @type {readonly EvidenceSourceType[]} */ (
  Object.freeze([...sourceTypeTable.types])
)

/** Chinese badge text. */
export const EVIDENCE_SOURCE_TYPE_LABELS_ZH = /** @type {Readonly<Record<EvidenceSourceType, string>>} */ (
  Object.freeze({ ...sourceTypeTable.labelsZh })
)

/** @param {unknown} value @returns {value is EvidenceSourceType} */
export function isEvidenceSourceType(value) {
  return typeof value === 'string' && EVIDENCE_SOURCE_TYPES.includes(/** @type {EvidenceSourceType} */ (value))
}

/** @param {unknown} value @returns {EvidenceSourceType} */
function typed(value) {
  if (!isEvidenceSourceType(value)) throw new Error(`source-types.json names an unknown source type ${JSON.stringify(value)}`)
  return value
}

// PubMed publication types (NLM's closed vocabulary), most specific form
// first: a record typed both "Meta-Analysis" and "Review" is a meta-analysis.
/** @type {ReadonlyArray<readonly [string, EvidenceSourceType]>} */
const PUBLICATION_TYPE_ORDER = Object.freeze(
  sourceTypeTable.publicationTypes.map(([name, type]) => Object.freeze(/** @type {const} */ ([name.toLowerCase(), typed(type)]))),
)

// Article and study types from vocabularies other than NLM's: EviMed's own
// Chinese article types, and JATS `article-type` values from a full text.
/** @type {ReadonlyMap<string, EvidenceSourceType>} */
const ARTICLE_TYPES = new Map(
  Object.entries(sourceTypeTable.articleTypes).map(([name, type]) => [name.toLowerCase(), typed(type)]),
)

// Which tool found the record, where the tool's corpus is one kind.
/** @type {ReadonlyMap<string, EvidenceSourceType>} */
const TOOL_SOURCE_TYPES = new Map(Object.entries(sourceTypeTable.tools).map(([tool, type]) => [tool, typed(type)]))

// Which connector produced the record (its `source`), where the connector's
// corpus is one kind — an EviMed label collection, a trial registry.
/** @type {ReadonlyMap<string, EvidenceSourceType>} */
const CONNECTOR_SOURCE_TYPES = new Map(
  Object.entries(sourceTypeTable.connectors).map(([connector, type]) => [connector.toLowerCase(), typed(type)]),
)

// Authorities whose pages are one kind of document, by host and path prefix;
// the first matching row wins.
/** @type {ReadonlyArray<readonly [string, string, EvidenceSourceType]>} */
const URL_SOURCE_TYPES = Object.freeze(
  sourceTypeTable.urls.map(([host, prefix, type]) => Object.freeze(/** @type {const} */ ([host.toLowerCase(), prefix, typed(type)]))),
)

/** @param {unknown} value @returns {string[]} */
function listOf(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return value.split(/[;|]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  return []
}

/** @param {unknown} url @returns {{ host: string, path: string } | null} */
function locationOf(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname }
  } catch {
    return null
  }
}

/**
 * The type of one source record. Reads, in order: an explicit valid
 * `sourceType`; the publication types; the article or study type; the tool that
 * found it; the connector that produced it; the host and path of its URL.
 * Unknown is `other`, never a guess.
 *
 * @param {Record<string, any> | null | undefined} record
 * @returns {EvidenceSourceType}
 */
export function evidenceSourceTypeOf(record) {
  if (!record || typeof record !== 'object') return 'other'
  if (isEvidenceSourceType(record.sourceType)) return record.sourceType
  const publicationTypes = [
    ...listOf(record.publicationTypes),
    ...listOf(record.publication_types),
    ...listOf(record.pubTypes),
  ]
  for (const [publicationType, sourceType] of PUBLICATION_TYPE_ORDER) {
    if (publicationTypes.includes(publicationType)) return sourceType
  }
  for (const key of ['articleType', 'articleTypes', 'studyType']) {
    for (const articleType of listOf(record[key])) {
      const sourceType = ARTICLE_TYPES.get(articleType)
      if (sourceType) return sourceType
    }
  }
  for (const key of ['tool', 'origin', 'sourceTool']) {
    const tool = String(record[key] ?? '').replace(/^mcp__[a-z0-9-]+__/, '')
    const sourceType = TOOL_SOURCE_TYPES.get(tool)
    if (sourceType) return sourceType
  }
  const connector = CONNECTOR_SOURCE_TYPES.get(String(record.source ?? '').trim().toLowerCase())
  if (connector) return connector
  const location = locationOf(record.url ?? record.sourceUrl ?? record.link)
  if (location) {
    for (const [suffix, prefix, sourceType] of URL_SOURCE_TYPES) {
      if ((location.host === suffix || location.host.endsWith(`.${suffix}`)) && location.path.startsWith(prefix)) return sourceType
    }
  }
  return 'other'
}
