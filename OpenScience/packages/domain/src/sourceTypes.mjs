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
 * Nothing here judges quality. A guideline badge says what the document is,
 * not that it is right; appraisal stays with the report's own GRADE prose.
 */

/** Every source type, most-authoritative evidence form first. */
export const EVIDENCE_SOURCE_TYPES = Object.freeze([
  'guideline',
  'systematic-review',
  'meta-analysis',
  'rct',
  'clinical-trial',
  'observational',
  'case-report',
  'review',
  'label',
  'regulatory',
  'trial-registration',
  'other',
])

/** @typedef {'guideline'|'systematic-review'|'meta-analysis'|'rct'|'clinical-trial'|'observational'|'case-report'|'review'|'label'|'regulatory'|'trial-registration'|'other'} EvidenceSourceType */

/** Chinese badge text. */
export const EVIDENCE_SOURCE_TYPE_LABELS_ZH = Object.freeze({
  guideline: '指南',
  'systematic-review': '系统综述',
  'meta-analysis': 'Meta 分析',
  rct: 'RCT',
  'clinical-trial': '临床试验',
  observational: '观察性研究',
  'case-report': '病例报告',
  review: '综述',
  label: '说明书',
  regulatory: '监管文件',
  'trial-registration': '试验注册',
  other: '其他',
})

/** @param {unknown} value @returns {value is EvidenceSourceType} */
export function isEvidenceSourceType(value) {
  return typeof value === 'string' && EVIDENCE_SOURCE_TYPES.includes(value)
}

// PubMed publication types (NLM's closed vocabulary), most specific form
// first: a record typed both "Meta-Analysis" and "Review" is a meta-analysis.
/** @type {ReadonlyArray<readonly [string, EvidenceSourceType]>} */
const PUBLICATION_TYPE_ORDER = Object.freeze([
  ['practice guideline', 'guideline'],
  ['guideline', 'guideline'],
  ['consensus development conference', 'guideline'],
  ['meta-analysis', 'meta-analysis'],
  ['network meta-analysis', 'meta-analysis'],
  ['systematic review', 'systematic-review'],
  ['randomized controlled trial', 'rct'],
  ['equivalence trial', 'rct'],
  ['pragmatic clinical trial', 'rct'],
  ['clinical trial, phase iii', 'clinical-trial'],
  ['clinical trial, phase iv', 'clinical-trial'],
  ['clinical trial, phase ii', 'clinical-trial'],
  ['clinical trial, phase i', 'clinical-trial'],
  ['controlled clinical trial', 'clinical-trial'],
  ['clinical trial', 'clinical-trial'],
  ['observational study', 'observational'],
  ['comparative study', 'observational'],
  ['multicenter study', 'observational'],
  ['case reports', 'case-report'],
  ['review', 'review'],
])

// Which tool found the record, where the tool's corpus is one kind.
/** @type {Readonly<Record<string, EvidenceSourceType>>} */
const TOOL_SOURCE_TYPES = Object.freeze({
  guideline_search: 'guideline',
  clinical_trial_search: 'trial-registration',
  drug_label_search: 'label',
})

// Hosts whose documents are regulatory or guideline texts by construction.
/** @type {ReadonlyArray<readonly [string, EvidenceSourceType]>} */
const HOST_SOURCE_TYPES = Object.freeze([
  ['nice.org.uk', 'guideline'],
  ['sign.ac.uk', 'guideline'],
  ['guidelines.gov', 'guideline'],
  ['iris.who.int', 'guideline'],
  ['fda.gov', 'regulatory'],
  ['ema.europa.eu', 'regulatory'],
  ['nmpa.gov.cn', 'regulatory'],
  ['cde.org.cn', 'regulatory'],
  ['pmda.go.jp', 'regulatory'],
  ['gov.uk', 'regulatory'],
  ['clinicaltrials.gov', 'trial-registration'],
  ['chictr.org.cn', 'trial-registration'],
])

/** @param {unknown} value @returns {string[]} */
function listOf(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return value.split(/[;|]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  return []
}

/** @param {unknown} url @returns {string} */
function hostOf(url) {
  if (typeof url !== 'string' || !url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The type of one source record. Reads, in order: an explicit valid
 * `sourceType`; the publication types; the tool that found it; the host of its
 * URL. Unknown is `other`, never a guess.
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
  for (const key of ['tool', 'origin', 'sourceTool']) {
    const tool = String(record[key] ?? '').replace(/^mcp__[a-z0-9-]+__/, '')
    if (TOOL_SOURCE_TYPES[tool]) return TOOL_SOURCE_TYPES[tool]
  }
  const host = hostOf(record.url ?? record.sourceUrl ?? record.link)
  if (host) {
    for (const [suffix, sourceType] of HOST_SOURCE_TYPES) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return sourceType
    }
  }
  return 'other'
}
