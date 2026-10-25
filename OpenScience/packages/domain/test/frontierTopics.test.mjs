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
