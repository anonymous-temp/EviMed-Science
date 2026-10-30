import assert from 'node:assert/strict'
import test from 'node:test'
import { isUtcTimestamp, projectTopicsResponse, validateFeed } from '../src/contract.mjs'
import { recommendationFixture } from './recommendationFixture.mjs'

test('validates source-backed corpus facts independently from medical-search result counts', () => {
  const feed = recommendationFixture()
  const validated = validateFeed(feed)
  assert.deepEqual(validated, feed)
  assert.equal(validated.categories.literature[0].basis?.eventCount, 1)
  assert.equal(validated.categories.literature[0].basis?.sourceCount, 3, 'one event may be reported by multiple institutions')
  assert.deepEqual(validated.categories.guidelines, [], 'no source data means no fabricated replacement topic')
  const input = { ...validated, category: 'literature', topics: validated.categories.literature, count: 1, total: 1,
    revision: 'a'.repeat(64), internalFile: '/private/feed', providerToken: 'private-token' }
  const response = projectTopicsResponse(input, { category: 'literature', limit: 3 })
  assert.deepEqual(response.recommendation, feed.recommendation)
  assert.deepEqual(response.topics[0].basis, feed.categories.literature[0].basis)
  assert.ok(!JSON.stringify(response).includes('private-token'))
  assert.ok(!JSON.stringify(response).includes('/private/feed'))
})

test('observed dates remain explicit and a missing publication date is never manufactured', () => {
  const feed = recommendationFixture()
  const reference = feed.categories.literature[0].basis?.sources[0]
  assert.ok(reference)
  reference.publishedAt = null
  reference.dateBasis = 'observed'
  assert.equal(validateFeed(feed).categories.literature[0].basis?.sources[0].publishedAt, null)
  reference.dateBasis = 'published'
  assert.throws(() => validateFeed(feed))
  reference.publishedAt = reference.timelineAt
  reference.dateBasis = 'observed'
  assert.throws(() => validateFeed(feed))
})

test('a registry update date remains distinct from publication and our observation time', () => {
  const feed = recommendationFixture(), reference = feed.categories.literature[0].basis?.sources[0]
  assert.ok(reference)
  reference.publishedAt = null
  reference.dateBasis = 'updated'
  reference.timelineAt = '2026-10-30T00:00:00.000Z'
  const preserved = validateFeed(feed).categories.literature[0].basis?.sources[0]
  assert.equal(preserved?.dateBasis, 'updated')
  assert.equal(preserved?.timelineAt, '2026-10-30T00:00:00.000Z')
  assert.equal(preserved?.publishedAt, null)
  reference.publishedAt = reference.timelineAt
  assert.throws(() => validateFeed(feed), 'a registry update must not manufacture a publication date')
})

test('recommendations must have an honest provider, bounded corpus facts and valid preserved sources', () => {
  /** @type {Array<(feed: any) => void>} */
  const corruptions = [
    feed => { feed.source.isExample = true },
    feed => { feed.source.kind = 'curated' },
    feed => { feed.source.kind = ['provider'] },
    feed => { feed.updatedAt = null },
    feed => { feed.updatedAt = '2026-10-29T10:00:00.000Z' },
    feed => { delete feed.categories.literature[0].basis },
    feed => { feed.categories.literature[0].basis.eventCount = 0 },
    feed => { feed.categories.literature[0].basis.sourceCount = -1 },
    feed => { feed.categories.literature[0].basis.eventCount = 100_001 },
    feed => { feed.categories.literature[0].basis.sourceCount = 100_001 },
    feed => { feed.categories.literature[0].basis.sourceCount = 1.5 },
    feed => { feed.categories.literature[0].basis.sources = [] },
    feed => { const source = feed.categories.literature[0].basis.sources[0]; feed.categories.literature[0].basis.sources = Array(4).fill(source) },
    feed => { feed.categories.literature[0].basis.sources.push(feed.categories.literature[0].basis.sources[0]) },
    feed => { feed.categories.literature[0].basis.sources[0].id = '../private' },
    feed => { feed.categories.literature[0].basis.sources[0].title = 'x'.repeat(201) },
    feed => { feed.categories.literature[0].basis.sources[0].source = ' Source' },
    feed => { feed.categories.literature[0].basis.sources[0].dateBasis = ['published'] },
    feed => { feed.categories.literature[0].basis.sources[0].title = 'line\nbreak' },
    feed => { feed.categories.literature[0].basis.sources[0].publishedAt = '2026-02-30T09:00:00.000Z' },
    feed => { feed.categories.literature[0].basis.sources[0].timelineAt = '2026-10-30T11:00:00.000Z' },
    feed => { feed.categories.literature[0].basis.sources[0].publishedAt = '2026-10-30T11:00:00.000Z' },
    feed => { feed.categories.literature[0].basis.sources[0].timelineAt = '2026-09-01T09:00:00.000Z' },
    feed => { feed.categories.literature[0].basis.latestAt = '2026-10-31T09:00:00.000Z' },
    feed => { feed.recommendation.algorithm = 'imaginary-popularity' },
    feed => { feed.recommendation.windowDays = 90 },
    feed => { feed.recommendation.generatedAt = '2026-02-30T10:00:00.000Z' },
    feed => { feed.recommendation.dataThrough = null },
    feed => { feed.recommendation.dataThrough = '2026-10-31T10:00:00.000Z' },
    feed => { feed.recommendation.dataThrough = '2026-10-29T10:00:00.000Z' },
    feed => { feed.recommendation.corpusVersion = ' ' },
    feed => { feed.recommendation.stale = 'false' },
  ]
  for (const corrupt of corruptions) {
    const feed = recommendationFixture()
    corrupt(feed)
    assert.throws(() => validateFeed(feed), corrupt.toString())
    const selected = { ...feed, category: 'literature', topics: feed.categories.literature, count: feed.categories.literature.length,
      total: feed.categories.literature.length, revision: 'a'.repeat(64) }
    assert.throws(() => projectTopicsResponse(selected, { category: 'literature', limit: 3 }), corrupt.toString())
  }
})

test('citation URLs cannot open local services or carry credentials and unsafe protocols', () => {
  for (const url of [
    'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.org/path',
    'https://user:password@example.org/evidence', 'http://localhost/private', 'http://localhost./private',
    'http://service.local/private', 'http://service.internal/private', 'http://service/private',
    'http://127.0.0.1/private', 'http://2130706433/private', 'http://0x7f000001/private',
    'http://10.0.0.1/private', 'http://169.254.169.254/private', 'http://[::1]/private', 'http://[::ffff:127.0.0.1]/private',
    'https://example.org\\@localhost/private', 'https://example.org/has space', 'https://example.org/' + 'x'.repeat(2048),
  ]) {
    const feed = recommendationFixture(), reference = feed.categories.literature[0].basis?.sources[0]
    assert.ok(reference)
    reference.url = url
    assert.throws(() => validateFeed(feed), url)
  }
  for (const url of ['https://pubmed.ncbi.nlm.nih.gov/123456/', 'https://www.fda.gov/drugs', 'https://clinicaltrials.gov/study/NCT00000000']) {
    const feed = recommendationFixture(), reference = feed.categories.literature[0].basis?.sources[0]
    assert.ok(reference)
    reference.url = url
    assert.equal(validateFeed(feed).categories.literature[0].basis?.sources[0].url, url)
  }
})

test('timestamps preserve known UTC instants and reject impossible or guessed dates', () => {
  for (const value of ['2026-10-30T08:00:00Z', '2026-10-30T08:00:00.123Z', '2024-02-29T00:00:00Z']) assert.equal(isUtcTimestamp(value), true)
  for (const value of [null, '', '2026-10-30', '2026-10-30T08:00:00+00:00', '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z']) {
    assert.equal(isUtcTimestamp(value), false, String(value))
  }
})

test('a stale snapshot keeps its actual generation time and every unknown nested property is discarded', () => {
  const feed = recommendationFixture()
  assert.ok(feed.recommendation)
  feed.recommendation.stale = true
  const input = JSON.parse(JSON.stringify(feed))
  input.recommendation.operatorPath = '/private'
  input.categories.literature[0].basis.serviceToken = 'private-token'
  input.categories.literature[0].basis.sources[0].privateAccount = 'researcher'
  const output = validateFeed(input)
  assert.equal(output.recommendation?.stale, true)
  assert.equal(output.recommendation?.generatedAt, feed.recommendation.generatedAt)
  assert.ok(!JSON.stringify(output).includes('private'))
  assert.ok(!JSON.stringify(output).includes('researcher'))
})
