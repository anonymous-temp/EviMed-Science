import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { apply } from '../index.mjs'
import { CATEGORIES, createTopicsHandler, MAX_FEED_BYTES, TOPICS_PATH, validateConfig, validateFeed } from '../src/topics.mjs'
import { recommendationFixture } from './recommendationFixture.mjs'

const example = JSON.parse(await readFile(new URL('../examples/topics.example.json', import.meta.url), 'utf8'))

/** Parse a test response whose fields each case asserts explicitly. */
async function body(/** @type {Response} */ response) {
  return JSON.parse(await response.text())
}

async function fixture(/** @type {import('node:test').TestContext} */ t) {
  const dir = await mkdtemp(join(tmpdir(), 'search-topics-test-'))
  const topicsFile = join(dir, 'topics.json'), tokenFile = join(dir, 'token')
  const token = randomBytes(32).toString('hex')
  await writeFile(topicsFile, JSON.stringify(example))
  await writeFile(tokenFile, token, { mode: 0o600 })
  const handler = createTopicsHandler({ topicsFile, tokenFile })
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  const origin = `http://127.0.0.1:${address.port}`
  /** @param {string} [query] @param {RequestInit} [options] */
  async function request(query = '?category=literature', options = {}) {
    return fetch(`${origin}${TOPICS_PATH}${query}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    })
  }
  return { dir, topicsFile, tokenFile, request }
}

test('validates configuration and the complete four-category feed', () => {
  assert.deepEqual(validateConfig({ topicsFile: '/feed.json', tokenFile: '/token' }), { topicsFile: '/feed.json', tokenFile: '/token' })
  for (const config of [null, {}, { topicsFile: 'relative', tokenFile: '/token' }, { topicsFile: '/same', tokenFile: '/same' }]) {
    assert.throws(() => validateConfig(config))
  }
  assert.equal(validateFeed(example).source.isExample, true)
  const valid = structuredClone(example)
  valid.updatedAt = '2026-10-30T08:00:00Z'
  assert.equal(validateFeed(valid).updatedAt, valid.updatedAt)
  for (const change of [
    (/** @type {typeof example} */ feed) => { feed.schemaVersion = 2 },
    (/** @type {typeof example} */ feed) => { delete feed.categories.trials },
    (/** @type {typeof example} */ feed) => { feed.categories.literature.push(feed.categories.literature[0]) },
    (/** @type {typeof example} */ feed) => { feed.categories.drugs[0].query = ' untrimmed' },
    (/** @type {typeof example} */ feed) => { feed.categories.drugs[0].description = 'bad\ntext' },
    (/** @type {typeof example} */ feed) => { feed.categories.drugs[0].query = 'x'.repeat(161) },
    (/** @type {typeof example} */ feed) => { feed.categories.drugs[0].id = '../path' },
    (/** @type {typeof example} */ feed) => { feed.updatedAt = '2026-02-30T00:00:00Z' },
    (/** @type {typeof example} */ feed) => { feed.updatedAt = 'unknown' },
    (/** @type {typeof example} */ feed) => { feed.source.kind = 'hot' },
    (/** @type {typeof example} */ feed) => { feed.categories.drugs = Array.from({ length: 101 }, (_, index) => ({ id: `item-${index}`, query: 'q', description: 'd' })) },
  ]) {
    const feed = structuredClone(example)
    change(feed)
    assert.throws(() => validateFeed(feed))
  }
})

test('returns each category with bounded counts, honest metadata and a stable revision', async t => {
  const { request } = await fixture(t)
  for (const category of CATEGORIES) {
    const res = await request(`?category=${category}&limit=2`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    const result = await body(res)
    assert.deepEqual(result.topics, example.categories[category].slice(0, 2))
    assert.equal(result.count, 2)
    assert.equal(result.total, 3)
    assert.equal(result.updatedAt, null)
    assert.equal(result.source.isExample, true)
    assert.match(result.revision, /^[a-f0-9]{64}$/u)
  }
  const first = await body(await request())
  const second = await body(await request())
  assert.equal(first.revision, second.revision)
})

test('rereads atomic replacements and empty categories without a process restart', async t => {
  const { request, topicsFile } = await fixture(t)
  const before = await body(await request())
  const updated = structuredClone(example)
  updated.categories.literature = [{ id: 'new-topic', query: '新主题', description: '新描述' }]
  updated.categories.guidelines = []
  updated.source.isExample = false
  updated.source.label = 'Editorial topics'
  updated.updatedAt = '2026-10-30T09:10:11.123Z'
  await writeFile(`${topicsFile}.next`, JSON.stringify(updated))
  await rename(`${topicsFile}.next`, topicsFile)
  const after = await body(await request())
  assert.notEqual(after.revision, before.revision)
  assert.deepEqual(after.topics, updated.categories.literature)
  assert.equal(after.source.isExample, false)
  assert.equal(after.updatedAt, updated.updatedAt)
  const emptyResponse = await request('?category=guidelines')
  assert.equal(emptyResponse.status, 200)
  const empty = await body(emptyResponse)
  assert.deepEqual(empty.topics, [])
  assert.equal(empty.count, 0)
  assert.equal(empty.total, 0)
})

test('the native response preserves actual recommendation facts and rejects unreferenced replacements', async t => {
  const { request, topicsFile } = await fixture(t)
  const feed = recommendationFixture()
  await writeFile(`${topicsFile}.next`, JSON.stringify(feed))
  await rename(`${topicsFile}.next`, topicsFile)
  const response = await request()
  assert.equal(response.status, 200)
  const result = await body(response)
  assert.deepEqual(result.topics, feed.categories.literature)
  assert.deepEqual(result.recommendation, feed.recommendation)
  assert.equal(result.updatedAt, feed.updatedAt)
  delete feed.categories.literature[0].basis
  await writeFile(topicsFile, JSON.stringify(feed))
  assert.equal((await request()).status, 503, 'a provider cannot pass example-only cards as source-backed recommendations')
})

test('rejects ambiguous, excessive and unknown request parameters', async t => {
  const { request } = await fixture(t)
  for (const query of ['', '?category=unknown', '?category=literature&limit=0', '?category=literature&limit=13',
    '?category=literature&limit=1.2', '?category=literature&limit=03', '?category=literature&limit=NaN',
    '?category=literature&limit=', '?category=literature&category=drugs', '?category=literature&limit=2&limit=3',
    '?category=literature&file=/etc/passwd']) {
    const res = await request(query)
    assert.equal(res.status, 400, query)
    assert.equal((await body(res)).code, 'invalid_request')
  }
  const res = await request('?category=literature', { method: 'POST' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET')
})

test('authenticates requests and observes service-token rotation', async t => {
  const { request, tokenFile } = await fixture(t)
  for (const authorization of ['', 'Bearer invalid', 'Basic invalid']) {
    const res = await request(undefined, { headers: { Authorization: authorization } })
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/u)
  }
  const next = randomBytes(32).toString('hex')
  await writeFile(`${tokenFile}.next`, next, { mode: 0o600 })
  await rename(`${tokenFile}.next`, tokenFile)
  assert.equal((await request()).status, 401)
  assert.equal((await request(undefined, { headers: { Authorization: `Bearer ${next}` } })).status, 200)
  await writeFile(tokenFile, '')
  const unavailable = await request()
  assert.equal(unavailable.status, 503)
  assert.equal((await body(unavailable)).code, 'topics_auth_unavailable')
})

test('source failures never leak paths, serve stale results or fall back to examples', async t => {
  const { request, topicsFile, dir } = await fixture(t)
  assert.equal((await request()).status, 200)
  for (const text of ['{broken', JSON.stringify({ schemaVersion: 1 }), 'x'.repeat(MAX_FEED_BYTES + 1)]) {
    await writeFile(topicsFile, text)
    const res = await request()
    assert.equal(res.status, 503)
    const payload = await res.text()
    assert.ok(!payload.includes(dir))
    assert.deepEqual(JSON.parse(payload), { code: 'topics_unavailable', error: 'The topic source is unavailable or invalid.' })
  }
  await rm(topicsFile)
  assert.equal((await request()).status, 503)
  await mkdir(topicsFile)
  assert.equal((await request()).status, 503)
})

test('registers one exact native route and retains its disposer in the plugin scope', () => {
  let disposed = false
  /** @type {(() => void) | undefined} */
  let dispose
  apply({
    webServer: { register(route) {
      assert.equal(route.kind, 'exact')
      assert.equal(route.path, TOPICS_PATH)
      return () => { disposed = true }
    } },
    effect(acquire) { dispose = acquire() },
  }, { topicsFile: '/feed.json', tokenFile: '/token' })
  assert.equal(disposed, false)
  assert.ok(dispose)
  dispose()
  assert.equal(disposed, true)
})

test('the published empty feed and OpenAPI contract agree with the service', async () => {
  const empty = JSON.parse(await readFile(new URL('../examples/topics.empty.json', import.meta.url), 'utf8'))
  assert.equal(validateFeed(empty).source.isExample, false)
  for (const category of CATEGORIES) assert.deepEqual(empty.categories[category], [])
  const api = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(api.info.version, manifest.version)
  const get = api.paths[TOPICS_PATH].get
  assert.deepEqual(get.parameters.find((/** @type {{name: string}} */ parameter) => parameter.name === 'category').schema.enum, CATEGORIES)
  assert.deepEqual(api.security, [{ serviceToken: [] }])
  assert.equal(api.components.securitySchemes.serviceToken.scheme, 'bearer')
  assert.deepEqual(Object.keys(get.responses).sort(), ['200', '400', '401', '405', '503'])
  assert.equal(api.components.schemas.TopicBasis.properties.sourceCount.maximum, 100_000)
  assert.equal(api.components.schemas.TopicBasis.properties.sources.maxItems, 3)
  assert.equal(api.components.schemas.Recommendation.properties.algorithm.const, 'recent-medical-topics-v1')
  assert.equal(api.components.schemas.Recommendation.properties.windowDays.const, 30)
  assert.equal(api.components.schemas.TopicsResponse.properties.recommendation.$ref, '#/components/schemas/Recommendation')
  assert.deepEqual(api.components.schemas.TopicReference.properties.dateBasis.enum, ['published', 'observed', 'updated'])
})
