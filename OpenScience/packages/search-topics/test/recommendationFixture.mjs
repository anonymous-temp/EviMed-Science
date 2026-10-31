/** A test-only source-backed feed; its example.org citation is not production content. */
export function recommendationFixture() {
  /** @type {import('../src/contract.mjs').TopicFeed} */
  const feed = {
    schemaVersion: 1,
    updatedAt: '2026-10-30T10:00:00.000Z',
    source: { kind: 'provider', label: 'Test collected medical topics', isExample: false },
    recommendation: {
      algorithm: 'recent-medical-topics-v1', windowDays: 30, generatedAt: '2026-10-30T10:00:00.000Z',
      dataThrough: '2026-10-30T09:00:00.000Z', stale: false, corpusVersion: 'test-corpus-1',
    },
    categories: {
      literature: [{ id: 'tag-1', query: 'Test topic', description: 'One collected event reported by three institutions', basis: {
        eventCount: 1, sourceCount: 3, latestAt: '2026-10-30T09:00:00.000Z', sources: [{
          id: 'item-1', title: 'Test published source', url: 'https://example.org/evidence/1', source: 'Test journal',
          publishedAt: '2026-10-30T09:00:00.000Z', timelineAt: '2026-10-30T09:00:00.000Z', dateBasis: 'published',
        }],
      } }],
      guidelines: [], drugs: [], trials: [],
    },
  }
  return feed
}
