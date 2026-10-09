/**
 * Optional research context shared by GEO's existing capabilities.
 * A profile is working knowledge, not a form or a delivery condition. Unknown
 * fields survive, partial records are useful, and no score measures completeness.
 * Language judgements belong to the researcher/model; these helpers only merge,
 * link and count what was actually recorded.
 */

export const GEO_VALUE_DOMAINS = Object.freeze({
  effectiveness: '有效性', safety: '安全性', economics: '经济性',
  suitability: '适宜性', accessibility: '可及性', innovation: '创新性',
})

export const GEO_RESEARCH_CAPABILITIES = Object.freeze([
  'comprehensive-drug-evaluation', 'clinical-evidence-synthesis', 'evidence-appraisal',
  'meta-analysis', 'adr-analysis', 'drug-selection', 'off-label-analysis',
  'bibliometric-analysis', 'research-topic-selection', 'statistical-analysis',
])

export const GEO_VALUE_COLLECTIONS = Object.freeze([
  'findings', 'landscape', 'audiences', 'decisions', 'opportunities',
  'researchResults', 'sourceChanges', 'lessons',
])

/** @param {unknown} value @returns {value is Record<string, any>} */
export function geoValueObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Stable content equality, not a clinical interpretation. @param {any} value @returns {string} */
export function geoValueCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(geoValueCanonical).join(',')}]`
  if (geoValueObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${geoValueCanonical(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** @param {any} item */
function recordKey(item) {
  return geoValueObject(item) && (item.id || item.key)
    ? `key:${String(item.id || item.key)}` : `content:${geoValueCanonical(item)}`
}

/**
 * Collections merge by optional id/key; unkeyed observations deduplicate by
 * content. Omission and an empty collection preserve earlier work. Explicit
 * null clears a field; an item can be retired without deleting its history.
 * @param {unknown} before @param {unknown} patch @returns {Record<string, any>}
 */
export function mergeGeoValue(before, patch) {
  const result = { ...(geoValueObject(before) ? before : {}) }
  if (!geoValueObject(patch)) return result
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (GEO_VALUE_COLLECTIONS.includes(key) && Array.isArray(value)) {
      const items = Array.isArray(result[key]) ? [...result[key]] : []
      for (const item of value) {
        const index = items.findIndex((old) => recordKey(old) === recordKey(item))
        if (index < 0) items.push(item)
        else items[index] = geoValueObject(item) ? mergeGeoValue(items[index], item) : item
      }
      result[key] = items
    } else if (geoValueObject(value)) result[key] = mergeGeoValue(result[key], value)
    else result[key] = value
  }
  return result
}

/** @param {unknown} value @returns {any[]} */
export const geoValueList = (value) => Array.isArray(value) ? value : []

/** The prose is usable even when the author supplied only a sentence. @param {any} value */
export function geoValueText(value) {
  if (typeof value === 'string') return value
  if (!geoValueObject(value)) return ''
  return [value.statement, value.summary, value.text, value.title, value.question, value.name, value.label, value.finding, value.rationale]
    .find((entry) => typeof entry === 'string' && entry.trim()) ?? ''
}

/** @param {any} entry */
export const geoValueActive = (entry) => !['retired', 'superseded'].includes(entry?.status)

/**
 * Associations are optional. Unlinked findings remain available as background;
 * a link narrows the working context, never makes an unrelated clinical claim.
 * @param {Record<string, any> | null} profile @param {{ groupId?: string, audience?: string }} [filter]
 */
export function geoValueContext(profile, filter = {}) {
  const data = profile ?? {}
  const relevant = (/** @type {any} */ entry) => geoValueActive(entry)
    && (!filter.groupId || !geoValueList(entry?.groupIds).length || entry.groupIds.includes(filter.groupId))
    && (!filter.audience || !entry?.audience || entry.audience === filter.audience)
  return {
    scope: data.scope ?? null, summary: geoValueText(data.summary),
    findings: geoValueList(data.findings).filter(relevant),
    landscape: geoValueList(data.landscape).filter(relevant),
    audiences: geoValueList(data.audiences).filter(relevant),
    decisions: geoValueList(data.decisions).filter(relevant),
    opportunities: geoValueList(data.opportunities).filter(relevant),
    researchResults: geoValueList(data.researchResults).filter(relevant),
    sourceChanges: geoValueList(data.sourceChanges), lessons: geoValueList(data.lessons).filter(relevant),
  }
}

/**
 * Only explicit links establish an impact. A changed source calls for a look;
 * it does not make every result wrong or prevent further work.
 * @param {Record<string, any>} profile @param {Array<Record<string, any>>} [articles]
 */
export function geoValueImpacts(profile, articles = []) {
  return geoValueList(profile.sourceChanges).filter(geoValueObject).filter(geoValueActive).map((change) => {
    const refs = new Set([change.sourceRef, change.sourceId, ...geoValueList(change.sourceRefs)].filter(Boolean))
    const findings = geoValueList(profile.findings).filter(geoValueObject).filter((finding) =>
      geoValueList(change.findingIds).includes(finding?.id)
      || [finding?.sourceRef, finding?.sourceId, ...geoValueList(finding?.sourceRefs), ...geoValueList(finding?.sources).map((source) =>
        typeof source === 'string' ? source : source?.sourceRef ?? source?.sourceId ?? source?.url)]
        .some((ref) => refs.has(ref)))
    const ids = new Set(findings.map((finding) => finding.id).filter(Boolean))
    const groups = new Set(findings.flatMap((finding) => geoValueList(finding.groupIds)))
    const claims = new Set(findings.flatMap((finding) => geoValueList(finding.claimIds)))
    return { change, findingIds: [...ids], groupIds: [...groups], articleIds: articles.filter((article) =>
      geoValueList(article.valueContext?.findingIds).some((id) => ids.has(id))
      || groups.has(article.groupId) || geoValueList(article.claimIds).some((id) => claims.has(id))).map((article) => article.id) }
  })
}

export const GEO_VALUE_COVERAGE_STATUSES = Object.freeze(['represented', 'partial', 'contradicted', 'not_addressed', 'not_applicable', 'uncertain'])

/**
 * Supplementary observations, deliberately outside GVI and clinical scoring.
 * Each measure exposes its actual denominator and leaves unjudged cases unknown.
 * @param {any[]} observations
 */
export function summarizeGeoValueCoverage(observations) {
  const rows = observations.filter((row) => GEO_VALUE_COVERAGE_STATUSES.includes(row?.status))
  const assessed = rows.filter((row) => !['uncertain', 'not_applicable'].includes(row.status))
  return {
    assessed: assessed.length, represented: rows.filter((row) => row.status === 'represented').length,
    partial: rows.filter((row) => row.status === 'partial').length,
    contradicted: rows.filter((row) => row.status === 'contradicted').length,
    notAddressed: rows.filter((row) => row.status === 'not_addressed').length,
    uncertain: rows.filter((row) => row.status === 'uncertain').length,
    notApplicable: rows.filter((row) => row.status === 'not_applicable').length,
    value: assessed.length ? rows.filter((row) => row.status === 'represented').length / assessed.length * 100 : null,
  }
}
