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
 * Where the preserving tool wrote what a capture is: `source.json`, beside the
 * preserved text in the same content-addressed capture directory
 * (`runtime/mcp/evimed-research/source_types.py`, `sidecar`). A reader holding
 * only the artifact path a claim cites finds the type there without re-running
 * a search — the control plane's `claim_verification` for its badge, the gate
 * and the claim tool for the design a GRADE upgrade depends on. Null for a
 * path that is not a preserved source.
 * @param {unknown} artifactPath @returns {string | null}
 */
export function sourceTypeSidecarPath(artifactPath) {
  if (typeof artifactPath !== 'string' || !artifactPath.startsWith('.evimed-sources/') || artifactPath.includes('\\')) return null
  const segments = artifactPath.split('/')
  if (segments.length < 3 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return [...segments.slice(0, -1), 'source.json'].join('/')
}

/**
 * The evidence type a capture's `source.json` declares, or null when it
 * declares none this table knows — an absent sidecar (a capture older than
 * C8), an unreadable one, or a value from a newer table.
 * @param {unknown} text @returns {EvidenceSourceType | null}
 */
export function sourceTypeOfSidecar(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    const declared = JSON.parse(text)?.sourceType
    return isEvidenceSourceType(declared) ? declared : null
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

/**
 * Which badge colour a source type wears.
 *
 * The palette carries five pairs (`STUDY_TYPE_BADGES` in `@evimed/design-tokens`:
 * `--study-<kind>-fg/bg`) and this vocabulary carries twelve types, so the two
 * need a stated mapping and had none — the badge tokens shipped with no
 * consumer while every claim in the product carried one of the twelve. The
 * mapping is here, beside the types, because it is a fact about evidence and
 * not about colour: a systematic review and a meta-analysis are one family to
 * a reader, and a regulator's notice reads as the label it accompanies.
 *
 * `other` is the honest ground: a narrative review, a trial registration and
 * an unrecognised record are not a study design, and giving any of them a
 * study colour would say something the table does not know.
 *
 * @type {Readonly<Record<EvidenceSourceType, 'synthesis' | 'rct' | 'guideline' | 'label' | 'other'>>}
 */
export const STUDY_BADGE_KINDS = Object.freeze({
  guideline: 'guideline',
  'systematic-review': 'synthesis',
  'meta-analysis': 'synthesis',
  rct: 'rct',
  'clinical-trial': 'rct',
  observational: 'other',
  'case-report': 'other',
  review: 'other',
  label: 'label',
  regulatory: 'label',
  'trial-registration': 'other',
  other: 'other',
})

/**
 * The badge kind of a source type, `other` for anything this build does not
 * know — never a thrown error: a badge is presentation, and a record from a
 * newer table must still draw.
 * @param {unknown} value @returns {'synthesis' | 'rct' | 'guideline' | 'label' | 'other'}
 */
export function studyBadgeKind(value) {
  const type = String(value ?? '')
  return Object.hasOwn(STUDY_BADGE_KINDS, type) ? STUDY_BADGE_KINDS[/** @type {EvidenceSourceType} */ (type)] : 'other'
}
