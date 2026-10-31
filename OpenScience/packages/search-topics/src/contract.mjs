/**
 * The portable public contract shared by the native plugin and its control-plane adapter.
 * Counts describe the publisher's collected corpus, never the complete medical-search index.
 */

export const CATEGORIES = Object.freeze(['literature', 'guidelines', 'drugs', 'trials'])
export const MAX_FEED_BYTES = 256 * 1024
export const RECOMMENDATION_ALGORITHM = 'recent-medical-topics-v1'
const DAY_MS = 86_400_000
const MAX_CORPUS_COUNT = 100_000
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u

/** @typedef {{ id: string, title: string, url: string, source: string, publishedAt: string | null, timelineAt: string, dateBasis: 'published' | 'observed' | 'updated' }} TopicReference */
/** @typedef {{ eventCount: number, sourceCount: number, latestAt: string, sources: TopicReference[] }} TopicBasis */
/** @typedef {{ id: string, query: string, description: string, basis?: TopicBasis }} Topic */
/** @typedef {{ kind: 'curated' | 'provider', label: string, isExample: boolean }} TopicSource */
/** @typedef {{ algorithm: 'recent-medical-topics-v1', windowDays: 30, generatedAt: string, dataThrough: string | null, stale: boolean, corpusVersion: string }} Recommendation */
/** @typedef {{ schemaVersion: 1, updatedAt: string | null, source: TopicSource, categories: Record<string, Topic[]>, recommendation?: Recommendation }} TopicFeed */

/** @returns {value is Record<string, unknown>} */
function isRecord(/** @type {unknown} */ value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @returns {value is string} */
function isText(/** @type {unknown} */ value, /** @type {number} */ maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && [...value].every(character => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
}

/** An actual UTC instant, including calendar-day validation; no date is filled from the request clock. */
export function isUtcTimestamp(/** @type {unknown} */ value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace(/Z$/u, value.includes('.') ? 'Z' : '.000Z')
}

/** Citations are public links only. This validates their shape and never fetches or resolves them. */
function referenceUrl(/** @type {unknown} */ value) {
  if (!isText(value, 2048) || /[\s\\]/u.test(value)) throw new Error('Invalid source URL')
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid source URL') }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  const labels = hostname.split('.')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    || !/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/u.test(labels.at(-1) ?? '')
    || /(?:^|\.)(?:localhost|local|localdomain|internal|invalid|test|lan|corp|onion)$/u.test(hostname)
    || hostname.endsWith('.home.arpa')) throw new Error('Invalid source URL')
  return value
}

function sourceOf(/** @type {unknown} */ value) {
  if (!isRecord(value) || (value.kind !== 'curated' && value.kind !== 'provider')
    || !isText(value.label, 120) || typeof value.isExample !== 'boolean') throw new Error('Invalid source metadata')
  /** @type {TopicSource} */
  const source = { kind: /** @type {'curated' | 'provider'} */ (value.kind), label: value.label, isExample: value.isExample }
  return source
}

/** Project only documented recommendation metadata, rejecting fabricated or ambiguous time fields. */
function recommendationOf(/** @type {unknown} */ value) {
  if (!isRecord(value) || value.algorithm !== RECOMMENDATION_ALGORITHM || value.windowDays !== 30
    || !isUtcTimestamp(value.generatedAt) || (value.dataThrough !== null && !isUtcTimestamp(value.dataThrough))
    || typeof value.stale !== 'boolean' || !isText(value.corpusVersion, 160)
    || (value.dataThrough !== null && Date.parse(String(value.dataThrough)) > Date.parse(String(value.generatedAt)))) {
    throw new Error('Invalid recommendation metadata')
  }
  /** @type {Recommendation} */
  const recommendation = { algorithm: value.algorithm, windowDays: 30, generatedAt: String(value.generatedAt),
    dataThrough: /** @type {string | null} */ (value.dataThrough), stale: value.stale, corpusVersion: value.corpusVersion }
  return recommendation
}

function basisOf(/** @type {unknown} */ input, /** @type {Recommendation | undefined} */ recommendation) {
  if (!isRecord(input) || !Number.isSafeInteger(input.eventCount) || Number(input.eventCount) < 1 || Number(input.eventCount) > MAX_CORPUS_COUNT
    || !Number.isSafeInteger(input.sourceCount) || Number(input.sourceCount) < 1 || Number(input.sourceCount) > MAX_CORPUS_COUNT
    || !isUtcTimestamp(input.latestAt) || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 3) {
    throw new Error('Invalid topic basis')
  }
  const latestAt = String(input.latestAt), latest = Date.parse(latestAt)
  const ids = new Set()
  const sources = input.sources.map(reference => {
    if (!isRecord(reference) || typeof reference.id !== 'string' || !ID.test(reference.id) || ids.has(reference.id)
      || !isText(reference.title, 200) || !isText(reference.source, 120) || !isUtcTimestamp(reference.timelineAt)
      || (reference.publishedAt !== null && !isUtcTimestamp(reference.publishedAt))
      || (reference.dateBasis !== 'published' && reference.dateBasis !== 'observed' && reference.dateBasis !== 'updated')
      || (reference.dateBasis === 'published' && reference.publishedAt === null)
      || (reference.dateBasis !== 'published' && reference.publishedAt !== null)
      || Date.parse(String(reference.timelineAt)) > latest
      || (reference.publishedAt !== null && Date.parse(String(reference.publishedAt)) > latest)) {
      throw new Error('Invalid topic reference')
    }
    ids.add(reference.id)
    /** @type {TopicReference} */
    const result = { id: reference.id, title: reference.title, url: referenceUrl(reference.url), source: reference.source,
      publishedAt: /** @type {string | null} */ (reference.publishedAt), timelineAt: String(reference.timelineAt),
      dateBasis: /** @type {'published' | 'observed' | 'updated'} */ (reference.dateBasis) }
    if (recommendation && Date.parse(result.timelineAt) < Date.parse(recommendation.generatedAt) - recommendation.windowDays * DAY_MS) {
      throw new Error('Topic reference is outside the recommendation window')
    }
    return result
  })
  if (recommendation && (latest > Date.parse(recommendation.generatedAt) || recommendation.dataThrough === null
    || latest > Date.parse(recommendation.dataThrough))) throw new Error('Invalid topic basis time')
  /** @type {TopicBasis} */
  const result = { eventCount: Number(input.eventCount), sourceCount: Number(input.sourceCount), latestAt, sources }
  return result
}

function topicOf(/** @type {unknown} */ input, /** @type {Recommendation | undefined} */ recommendation) {
  if (!isRecord(input) || typeof input.id !== 'string' || !ID.test(input.id)
    || !isText(input.query, 160) || !isText(input.description, 240)) throw new Error('Invalid topic')
  if (recommendation && input.basis === undefined) throw new Error('A recommendation needs preserved source references')
  /** @type {Topic} */
  const topic = { id: input.id, query: input.query, description: input.description }
  if (input.basis !== undefined) topic.basis = basisOf(input.basis, recommendation)
  return topic
}

/** One provenance rule for complete files and the response selected from them. */
function metadataOf(/** @type {Record<string, unknown>} */ input) {
  const updatedAt = input.updatedAt
  if (updatedAt !== null && !isUtcTimestamp(updatedAt)) throw new Error('Invalid update time')
  const source = sourceOf(input.source)
  const recommendation = input.recommendation === undefined ? undefined : recommendationOf(input.recommendation)
  if (recommendation && (source.kind !== 'provider' || source.isExample || updatedAt === null
    || Date.parse(String(updatedAt)) !== Date.parse(recommendation.generatedAt))) throw new Error('Invalid recommendation source')
  return { updatedAt: /** @type {string | null} */ (updatedAt), source, recommendation }
}

/** Validate a whole snapshot; malformed, duplicate or unreferenced recommendations are never silently dropped. */
export function validateFeed(/** @type {unknown} */ input) {
  if (!isRecord(input) || input.schemaVersion !== 1 || !isRecord(input.categories)) throw new Error('Invalid topic feed')
  const { updatedAt, source, recommendation } = metadataOf(input)
  const categories = input.categories
  if (Object.keys(categories).length !== CATEGORIES.length || Object.keys(categories).some(key => !CATEGORIES.includes(key))) {
    throw new Error('All four categories are required')
  }
  /** @type {Record<string, Topic[]>} */
  const validated = {}
  for (const category of CATEGORIES) {
    const rows = categories[category]
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid topic collection')
    const ids = new Set()
    validated[category] = rows.map(row => {
      const topic = topicOf(row, recommendation)
      if (ids.has(topic.id)) throw new Error('Duplicate topic')
      ids.add(topic.id)
      return topic
    })
  }
  /** @type {TopicFeed} */
  const result = { schemaVersion: 1, updatedAt, source, categories: validated, ...(recommendation ? { recommendation } : {}) }
  return result
}

/** The public selected response uses exactly the file contract; private/unknown properties are not forwarded. */
export function projectTopicsResponse(/** @type {unknown} */ input, /** @type {{category: string, limit: number}} */ request) {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.category !== request.category || !CATEGORIES.includes(request.category)
    || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 12
    || !Array.isArray(input.topics) || input.topics.length > request.limit || input.count !== input.topics.length
    || !Number.isSafeInteger(input.total) || Number(input.total) < input.topics.length || Number(input.total) > 100
    || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(input.revision)) throw new Error('Invalid topic response')
  const { updatedAt, source, recommendation } = metadataOf(input)
  const ids = new Set()
  const topics = input.topics.map(row => {
    const topic = topicOf(row, recommendation)
    if (ids.has(topic.id)) throw new Error('Duplicate topic')
    ids.add(topic.id)
    return topic
  })
  return { schemaVersion: 1, category: request.category, topics, count: topics.length, total: Number(input.total),
    updatedAt, revision: input.revision, source, ...(recommendation ? { recommendation } : {}) }
}
