import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CATEGORIES, MAX_FEED_BYTES, validateFeed } from './contract.mjs'

export { CATEGORIES, MAX_FEED_BYTES, validateFeed } from './contract.mjs'

export const TOPICS_PATH = '/api/evimed-search/topics'

/** @typedef {{ topicsFile: string, tokenFile: string }} TopicsConfig */

/** Reject missing configuration at activation, without exposing file content. */
export function validateConfig(/** @type {unknown} */ input) {
  if (!isRecord(input)) throw new Error('search-topics: configuration is required')
  const { topicsFile, tokenFile } = input
  if (typeof topicsFile !== 'string' || !isAbsolute(topicsFile)) {
    throw new Error('search-topics: topicsFile must be an absolute path')
  }
  if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile) || tokenFile === topicsFile) {
    throw new Error('search-topics: tokenFile must be a separate absolute path')
  }
  return { topicsFile, tokenFile }
}

/** Bound reads even when a file grows after stat; refuse directories and named pipes. */
async function readBounded(/** @type {string} */ file, /** @type {number} */ maxBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid source file')
    const buffer = Buffer.alloc(maxBytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > maxBytes) throw new Error('Source exceeds the byte limit')
    return buffer.subarray(0, used)
  } finally {
    await handle.close()
  }
}

/** @returns {value is Record<string, unknown>} */
function isRecord(/** @type {unknown} */ value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function digest(/** @type {string | Buffer} */ text) {
  return createHash('sha256').update(text).digest()
}

/** Each read observes current data and token files; there is no process-wide content cache. */
export function createTopicsHandler(/** @type {TopicsConfig} */ config) {
  return async (/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) => {
    /** @param {number} status @param {unknown} body */
    function reply(status, body) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="evimed-search-topics"' } : {}),
      })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'GET') {
      reply(405, { code: 'method_not_allowed', error: 'Use GET.' })
      return
    }
    let token
    try {
      token = (await readBounded(config.tokenFile, 1024)).toString('utf8').trim()
      if (!/^[A-Za-z0-9_-]{32,512}$/u.test(token)) throw new Error('Invalid service token')
    } catch {
      reply(503, { code: 'topics_auth_unavailable', error: 'Topic service authentication is unavailable.' })
      return
    }
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string' || authorization.length > 520
      || !timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) {
      reply(401, { code: 'unauthorized', error: 'A valid service token is required.' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://topics.invalid')
    const category = url.searchParams.get('category')
    const rawLimit = url.searchParams.get('limit') ?? '3'
    if (!category || !CATEGORIES.includes(category) || !/^(?:[1-9]|1[0-2])$/u.test(rawLimit)
      || [...url.searchParams.keys()].some(key => !['category', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1)) {
      reply(400, { code: 'invalid_request', error: 'Use one category (literature, guidelines, drugs, trials) and limit 1–12.' })
      return
    }
    try {
      const bytes = await readBounded(config.topicsFile, MAX_FEED_BYTES)
      const feed = validateFeed(JSON.parse(bytes.toString('utf8')))
      const topics = feed.categories[category].slice(0, Number(rawLimit))
      reply(200, {
        schemaVersion: 1, category, topics, count: topics.length, total: feed.categories[category].length,
        updatedAt: feed.updatedAt, revision: digest(bytes).toString('hex'), source: feed.source,
        ...(feed.recommendation ? { recommendation: feed.recommendation } : {}),
      })
    } catch {
      reply(503, { code: 'topics_unavailable', error: 'The topic source is unavailable or invalid.' })
    }
  }
}
