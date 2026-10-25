import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FRONTIER_HIDE_REASONS,
  FRONTIER_TOPIC_DOMAIN_LABELS_ZH,
  FRONTIER_TOPIC_DOMAINS,
  FRONTIER_TOPIC_ITEM_ROLES,
  FRONTIER_TOPIC_PROGRAMME_STATES,
  isFrontierTopicDomain,
} from '../index.mjs'

test('every topic domain has a Chinese label and nothing else does', () => {
  assert.deepEqual(Object.keys(FRONTIER_TOPIC_DOMAIN_LABELS_ZH).sort(), [...FRONTIER_TOPIC_DOMAINS].sort())
  assert.ok(FRONTIER_TOPIC_DOMAINS.includes('conflict') && FRONTIER_TOPIC_DOMAINS.includes('economy') && FRONTIER_TOPIC_DOMAINS.includes('entertainment'))
  assert.equal(isFrontierTopicDomain('conflict'), true)
  assert.equal(isFrontierTopicDomain('war'), false)
})

test('the schema closes the same words the domain names', () => {
  const source = readFileSync(new URL('../../../apps/server/src/frontierPersistence.mjs', import.meta.url), 'utf8')
  // The topic block (its role column, not another table's), from the topics table to the end of the schema.
  const ddl = source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS evimed_frontier.topics ('))
  const closed = (/** @type {string} */ column) => {
    const match = ddl.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`))
    assert.ok(match, `no CHECK for ${column}`)
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  }
  assert.deepEqual(closed('role'), [...FRONTIER_TOPIC_ITEM_ROLES].sort())
  assert.deepEqual(closed('programme_state'), [...FRONTIER_TOPIC_PROGRAMME_STATES].sort())
  assert.deepEqual(closed('hidden_reason'), [...FRONTIER_HIDE_REASONS].sort())
})

// c2-leads 2026-10-25: the outside-event trigger's pure decisions.
test('a hot title is keyed by its characters alone: hashtags, spaces, punctuation and width do not make a new entry', async () => {
  const { frontierHotTitleKey } = await import('../index.mjs')
  assert.equal(frontierHotTitleKey('#张雪峰 去世#'), frontierHotTitleKey('张雪峰去世'))
  assert.equal(frontierHotTitleKey('“中国桂花第一村”5天收花7万斤'), frontierHotTitleKey('中国桂花第一村5天收花7万斤'))
  assert.equal(frontierHotTitleKey('ＵＦＣ　333'), frontierHotTitleKey('ufc 333'))
  assert.notEqual(frontierHotTitleKey('心源性猝死'), frontierHotTitleKey('心源性猝死抢救'))
  assert.equal(frontierHotTitleKey(null), '')
})

test('an item is evidence by its genre, a report otherwise, and background when it is a month older than the topic', async () => {
  const { frontierTopicItemRole, FRONTIER_TOPIC_EVIDENCE_GENRES, FRONTIER_GENRES } = await import('../index.mjs')
  for (const genre of FRONTIER_TOPIC_EVIDENCE_GENRES) assert.ok(FRONTIER_GENRES.includes(genre), genre)
  const firstSeenAt = '2026-03-24T14:00:00Z'
  assert.equal(frontierTopicItemRole({ genre: 'paper', publishedAt: '2026-03-20T00:00:00Z', firstSeenAt }), 'evidence')
  assert.equal(frontierTopicItemRole({ genre: 'guideline', publishedAt: null, firstSeenAt }), 'evidence')
  for (const genre of ['news', 'commentary', 'social', 'industry', 'policy', 'roundup']) {
    assert.equal(frontierTopicItemRole({ genre, publishedAt: '2026-03-25T00:00:00Z', firstSeenAt }), 'report', genre)
  }
  assert.equal(frontierTopicItemRole({ genre: 'paper', publishedAt: '2025-03-25T00:00:00Z', firstSeenAt }), 'background', 'the 2025 marathon cohort')
  assert.equal(frontierTopicItemRole({ genre: 'news', publishedAt: '2026-02-20T00:00:00Z', firstSeenAt }), 'background')
})

test('the names a text holds: NFKC and case folded, a one-character name never matched', async () => {
  const { frontierTopicNamesIn } = await import('../index.mjs')
  assert.deepEqual(frontierTopicNamesIn('张雪峰 心源性猝死 跑步', ['张雪峰']), ['张雪峰'])
  assert.deepEqual(frontierTopicNamesIn('cardiac arrest during races', ['Damar Hamlin', 'X']), [])
  assert.deepEqual(frontierTopicNamesIn('What DAMAR HAMLIN had', ['Damar Hamlin']), ['Damar Hamlin'])
  assert.deepEqual(frontierTopicNamesIn('运动与心源性猝死', []), [])
})

test('a surge: the top ten of two boards at once and three medical entries in the group, counted in code', async () => {
  const { frontierTopicSurge, FRONTIER_TOPIC_SURGE, FRONTIER_TOPIC_CANDIDATE, FRONTIER_TOPIC_MIN_CONFIDENCE } = await import('../index.mjs')
  assert.deepEqual(FRONTIER_TOPIC_SURGE, { topRank: 10, boards: 2, medicalEntries: 3 })
  assert.deepEqual([FRONTIER_TOPIC_CANDIDATE.maxRank, FRONTIER_TOPIC_CANDIDATE.minStreak, FRONTIER_TOPIC_CANDIDATE.unseenHours], [30, 2, 48])
  assert.equal(FRONTIER_TOPIC_MIN_CONFIDENCE, 0.7)
  const members = [{ board: 'weibo', rank: 1 }, { board: 'baidu', rank: 4 }, { board: 'weibo', rank: 25 }]
  assert.deepEqual(frontierTopicSurge({ members, medicalEntries: 3 }), { surge: true, topBoards: 2 })
  assert.equal(frontierTopicSurge({ members, medicalEntries: 2 }).surge, false)
  assert.equal(frontierTopicSurge({ members: [{ board: 'weibo', rank: 1 }, { board: 'baidu', rank: 11 }], medicalEntries: 5 }).surge, false)
})
