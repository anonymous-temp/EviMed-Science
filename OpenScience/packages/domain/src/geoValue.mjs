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
 * An item that names itself by `key` alone is known by that key as its id: the judge is shown findings by id, a source change
 * reaches them by id, and the page keys them by it, so a keyed finding without one was written and never seen (D-10). An item with an
 * id, or with neither, is as it was written.
 * @param {any} item
 */
function identified(item) {
  return geoValueObject(item) && !item.id && item.key ? { ...item, id: String(item.key) } : item
}

/**
 * Collections merge by optional id/key; unkeyed observations deduplicate by
 * content. Omission and an empty collection preserve earlier work. Explicit
 * null clears a field; an item can be retired without deleting its history.
 * Any other list is replaced by a list, but never by an empty one: an empty
 * list preserves prior work wherever it is written (a finding's groupIds, a
 * scope's regions), and where there is nothing to preserve it adds nothing
 * (D-09; the skill tells the run so).
 * @param {unknown} before @param {unknown} patch @returns {Record<string, any>}
 */
export function mergeGeoValue(before, patch) {
  const result = { ...(geoValueObject(before) ? before : {}) }
  if (!geoValueObject(patch)) return result
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (GEO_VALUE_COLLECTIONS.includes(key) && Array.isArray(value)) {
      const items = Array.isArray(result[key]) ? [...result[key]] : []
      for (const raw of value) {
        const item = identified(raw)
        const index = items.findIndex((old) => recordKey(old) === recordKey(item))
        if (index < 0) items.push(item)
        else items[index] = geoValueObject(item) ? mergeGeoValue(items[index], item) : item
      }
      result[key] = items
    } else if (Array.isArray(value) && value.length === 0) {
      // preserved: the earlier value stands, and where there was none there is still none
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
    // An audience is a word or a list of them; a finding for none is for all.
    && (!filter.audience || !entry?.audience || [entry.audience].flat().includes(filter.audience))
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

/** The findings a measurement judge is shown, and a round freezes, at most. */
export const GEO_VALUE_JUDGED_FINDINGS = 60

/**
 * What the measurement judge is shown of a profile, and what a round freezes of it:
 * the scope, the summary and the findings it can answer for by id. The rest of a
 * profile (research reports with their excerpts, landscape, decisions, lessons,
 * source changes) is the researcher's working material: it grows with every run,
 * the judge does not read it, and a prompt prefix and a frozen basis that carry it
 * grow without bound (D-02: four imported runs made a 76 KB prefix of 42 findings).
 * @param {Record<string, any> | null} profile
 */
export function geoValueJudged(profile) {
  const { scope, summary, findings } = geoValueContext(profile)
  return { scope, summary, findings: findings.filter((entry) => entry?.id).slice(0, GEO_VALUE_JUDGED_FINDINGS) }
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
 * The summary of coverage counts, by status: the same arithmetic as {@link summarizeGeoValueCoverage}, for a
 * reader that counted the observations where they are stored instead of loading them.
 * @param {Record<string, number> | null | undefined} counts observations per status; a status outside GEO_VALUE_COVERAGE_STATUSES is not counted
 */
export function summarizeGeoValueCoverageCounts(counts) {
  const count = (/** @type {string} */ status) => Number(counts?.[status] ?? 0)
  const assessed = count('represented') + count('partial') + count('contradicted') + count('not_addressed')
  return {
    assessed, represented: count('represented'), partial: count('partial'), contradicted: count('contradicted'),
    notAddressed: count('not_addressed'), uncertain: count('uncertain'), notApplicable: count('not_applicable'),
    value: assessed ? count('represented') / assessed * 100 : null,
  }
}

/**
 * Supplementary observations, deliberately outside GVI and clinical scoring.
 * Each measure exposes its actual denominator and leaves unjudged cases unknown.
 * @param {any[]} observations
 */
export function summarizeGeoValueCoverage(observations) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const row of observations) {
    if (GEO_VALUE_COVERAGE_STATUSES.includes(row?.status)) counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return summarizeGeoValueCoverageCounts(counts)
}
