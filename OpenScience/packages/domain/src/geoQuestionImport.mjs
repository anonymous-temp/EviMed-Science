/** Original customer questions and their measurement agreement. Classification is supplied by the person or geo-insight; never guessed here. */
import { GEO_AUDIENCES, GEO_ENGINES, GEO_POOLS, GEO_QUESTION_KINDS } from './geoVocabulary.mjs'
import { GEO_METRIC_IDS } from './geoMetrics.mjs'

/** @param {unknown} value @param {string[]} keys @param {string} field @returns {Record<string, any>} */
function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object.`)
  const row = /** @type {Record<string, any>} */ (value)
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new TypeError(`${field} contains unknown fields.`)
  return row
}
/** @param {unknown} value @param {number} max @param {boolean} [required] */
function text(value, max, required = false) {
  if (value == null && !required) return null
  // eslint-disable-next-line no-control-regex -- Reject invisible controls while preserving original whitespace and line breaks.
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new TypeError(`Text must be ${required ? 'nonempty and ' : ''}at most ${max} characters.`)
  return value
}
/** @param {unknown} value @param {readonly string[]} allowed @param {boolean} [required] */
function word(value, allowed, required = false) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || !allowed.includes(value)) throw new TypeError(`Expected one of ${allowed.join(', ')}.`)
  return value
}
/** @param {unknown} input */
export function validateGeoMeasurementContract(input) {
  const data = object(input, ['samplingMode', 'engines', 'repeats', 'metricIds', 'reportPresentation', 'sourceBasis'], 'contract')
  const samplingMode = word(data.samplingMode, ['one_shot', 'recurring'], true)
  const list = (/** @type {unknown} */ value, /** @type {readonly string[]} */ allowed) => {
    if (!Array.isArray(value) || !value.length || value.length > allowed.length || new Set(value).size !== value.length) throw new TypeError('Choose a nonempty unique list.')
    return value.map((item) => /** @type {string} */ (word(item, allowed, true)))
  }
  if (!Number.isSafeInteger(data.repeats) || data.repeats < 1 || data.repeats > 20 || samplingMode === 'one_shot' && data.repeats !== 1) throw new TypeError('One-shot sampling makes exactly one call per question and engine; recurring repeats must be 1 to 20.')
  return { samplingMode, engines: list(data.engines, GEO_ENGINES), repeats: Number(data.repeats), metricIds: list(data.metricIds, GEO_METRIC_IDS),
    reportPresentation: word(data.reportPresentation, ['summary', 'detailed'], true), sourceBasis: word(data.sourceBasis, ['answers', 'answers_and_project_sources'], true) }
}

/** A preview is deterministic and lossless: duplicates are candidates, never removed. @param {unknown} input */
export function previewGeoQuestionImport(input) {
  const data = object(input, ['rows', 'contract', 'requestKey', 'note'], 'import')
  const contract = validateGeoMeasurementContract(data.contract)
  const requestKey = text(data.requestKey, 120)
  if (requestKey != null && !/^[A-Za-z0-9._:-]{1,120}$/.test(requestKey)) throw new TypeError('requestKey must be an opaque identifier.')
  const note = text(data.note, 500)
  if (!Array.isArray(data.rows) || !data.rows.length || data.rows.length > 400) throw new TypeError('Import 1 to 400 original rows.')
  const rows = data.rows.map((/** @type {unknown} */ value, /** @type {number} */ index) => {
    const row = object(value, ['text', 'originalRowIndex', 'originalId', 'originalGroup', 'clientTags', 'kind', 'sourceUrl', 'collectedAt', 'pool', 'journeyStage', 'audience', 'isMeasured', 'classificationStatus'], `rows[${index}]`)
    const kind = word(row.kind ?? 'client', GEO_QUESTION_KINDS, true)
    const sourceUrl = text(row.sourceUrl, 2000)
    if (sourceUrl != null) { const url = new URL(sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('sourceUrl must be public HTTP(S).') }
    const collectedAt = text(row.collectedAt, 40)
    if (collectedAt != null && !Number.isFinite(Date.parse(collectedAt))) throw new TypeError('collectedAt must be an actual source date.')
    if (kind === 'real' && (!sourceUrl || !collectedAt)) throw new TypeError('Real phrasings require their source URL and collection date; use typical for model suggestions.')
    const tags = row.clientTags ?? []
    if (!Array.isArray(tags) || tags.length > 40) throw new TypeError('clientTags must hold at most 40 labels.')
    const pool = word(row.pool, GEO_POOLS)
    const audience = word(row.audience, GEO_AUDIENCES)
    const journeyStage = text(row.journeyStage, 60)
    if (row.isMeasured != null && typeof row.isMeasured !== 'boolean') throw new TypeError('isMeasured must be boolean.')
    const classificationStatus = word(row.classificationStatus ?? (pool || audience || journeyStage ? 'suggested' : 'unclassified'), ['unclassified', 'suggested', 'confirmed'], true)
    return { originalRowIndex: index, text: /** @type {string} */ (text(row.text, 4000, true)), originalId: text(row.originalId, 300), originalGroup: text(row.originalGroup, 300),
      clientTags: tags.map((tag) => /** @type {string} */ (text(tag, 100, true))), kind, sourceUrl, collectedAt, pool, journeyStage, audience,
      isMeasured: row.isMeasured ?? true, classificationStatus }
  })
  /** @type {Map<string, number[]>} */
  const duplicates = new Map()
  rows.forEach((row, index) => { const key = row.text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en'); duplicates.set(key, [...(duplicates.get(key) ?? []), index]) })
  const measuredRows = rows.filter((row) => row.isMeasured).length
  return { rows, contract, requestKey, note, actualRows: rows.length, measuredRows, plannedCalls: measuredRows * contract.engines.length * contract.repeats,
    duplicateCandidates: [...duplicates.values()].filter((indexes) => indexes.length > 1).map((rowIndexes) => ({ rowIndexes })) }
}
