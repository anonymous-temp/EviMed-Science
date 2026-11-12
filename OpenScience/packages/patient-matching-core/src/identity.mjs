import { createHash } from 'node:crypto'
import { array, check, digest, identifier, object, oneOf, text, unique } from './validation.mjs'

/** Canonical JSON rejects lossy values instead of assigning them the same cache identity. */
export function canonicalJson(value) {
  const ancestors = new Set()
  function canonical(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      check(Number.isFinite(item), 'identity', 'nonfinite number')
      return item
    }
    check(typeof item === 'object' && item !== null, 'identity', 'expected JSON data')
    check(!ancestors.has(item), 'identity', 'cyclic data')
    ancestors.add(item)
    let result
    if (Array.isArray(item)) {
      check(Object.keys(item).length === item.length, 'identity', 'sparse or decorated array')
      result = item.map(canonical)
    } else {
      object(item, 'identity')
      check(Object.getOwnPropertySymbols(item).length === 0, 'identity', 'symbol keys are not JSON data')
      result = Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]))
    }
    ancestors.delete(item)
    return result
  }
  return JSON.stringify(canonical(value))
}

export function contentDigest(value) {
  check(typeof value === 'string' || value instanceof Uint8Array, 'content', 'expected original bytes or text')
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function profileIdentity(profile) { return contentDigest(canonicalJson(profile)) }

export function validateScope(scope, path = 'scope') {
  object(scope, path, ['tenantId', 'projectId', 'actorId', 'conversationId'])
  for (const field of ['tenantId', 'projectId', 'actorId', 'conversationId']) identifier(scope[field], `${path}.${field}`)
  return scope
}

export function sameScope(left, right) {
  validateScope(left)
  validateScope(right)
  return canonicalJson(left) === canonicalJson(right)
}

export function assertScope(expected, actual, path = 'scope') {
  check(sameScope(expected, actual), path, 'scope does not match invocation', 'scope_mismatch')
}

export function validateSourceRef(source, path = 'source') {
  object(source, path, ['sourceId', 'revision', 'digest', 'kind'])
  identifier(source.sourceId, `${path}.sourceId`)
  text(source.revision, `${path}.revision`)
  digest(source.digest, `${path}.digest`)
  oneOf(source.kind, ['patient', 'protocol', 'registry', 'knowledge'], `${path}.kind`)
  return source
}

export function sourceIdentity(source) {
  validateSourceRef(source)
  return profileIdentity(source)
}

export function validateSourceRefs(sources, path = 'sources') {
  array(sources, path, validateSourceRef)
  unique(sources, path, (source) => source.sourceId)
  return sources
}

/** Source removal, changed kind/revision, and changed bytes all invalidate the saved decision. */
export function compareSourceRefs(saved, current) {
  validateSourceRefs(saved)
  validateSourceRefs(current)
  const currentById = new Map(current.map((source) => [source.sourceId, source]))
  return saved.flatMap((source) => {
    const next = currentById.get(source.sourceId)
    if (!next) return [{ sourceId: source.sourceId, reason: 'source-unavailable' }]
    return sourceIdentity(source) === sourceIdentity(next) ? [] : [{ sourceId: source.sourceId, reason: 'source-changed' }]
  })
}

export function cacheIdentity({ scope, sources, profile }) {
  validateScope(scope)
  validateSourceRefs(sources)
  return profileIdentity({ scope, sources: [...sources].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0), profile })
}

/** An optional bounded cache. Host authorization must still run before each read. */
export function createSourceProfileCache({ maxEntries = 100 } = {}) {
  check(Number.isSafeInteger(maxEntries) && maxEntries > 0, 'maxEntries', 'expected a positive integer')
  const entries = new Map()
  return Object.freeze({
    get(identity) {
      const key = cacheIdentity(identity)
      if (!entries.has(key)) return undefined
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return structuredClone(value)
    },
    set(identity, value) {
      canonicalJson(value)
      const key = cacheIdentity(identity)
      entries.delete(key)
      entries.set(key, structuredClone(value))
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
      return key
    },
    clear() { entries.clear() },
    get size() { return entries.size },
  })
}
