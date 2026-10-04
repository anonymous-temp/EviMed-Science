// What updating an edited copy of a skill toward a newer upstream changes, and what it must leave alone. The
// three-way comparison is against the digests the package had when it came in: without them a difference cannot be
// told to be the researcher's edit or the upstream's change, so it is a conflict and never an overwrite.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import * as domain from '../index.mjs'

const { SKILL_UPDATE_PARTS, normalizeSkillBaseline, planSkillUpdate, skillContentDigests } = domain
const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex')
const digests = (/** @type {Record<string, any>} */ content) => skillContentDigests(/** @type {any} */ ({ description: 'd', instructions: 'i', whenToUse: null, invocation: { userInvocable: true, modelInvocable: true }, metadata: {}, resources: [], ...content }), sha)
const resource = (/** @type {string} */ path, /** @type {string} */ body) => ({ path, digest: `sha256:${sha(body)}` })
const plan = (/** @type {any} */ input) => /** @type {any} */ (planSkillUpdate(input))
const decisionOf = (/** @type {any} */ result, /** @type {string} */ name) => result.entries.find((/** @type {any} */ entry) => entry.name === name)

const base = digests({ instructions: 'v1', resources: [resource('scripts/a.py', 'a1'), resource('references/r.md', 'r1')] })

test('the researcher\'s edit stays when upstream did not move, and upstream\'s change comes when the researcher did not edit', () => {
  const local = digests({ instructions: 'v1 edited', resources: [resource('scripts/a.py', 'a1'), resource('references/r.md', 'r1')] })
  const upstream = digests({ instructions: 'v1', resources: [resource('scripts/a.py', 'a2'), resource('references/r.md', 'r1')] })
  const result = plan({ base, local, upstream })
  assert.equal(decisionOf(result, 'instructions').decision, 'keep-local')
  assert.equal(decisionOf(result, 'scripts/a.py').decision, 'take-upstream')
  assert.equal(decisionOf(result, 'scripts/a.py').side, 'upstream')
  assert.equal(decisionOf(result, 'references/r.md').decision, 'unchanged')
  assert.equal(result.conflicts, 0)
  assert.equal(result.changes, 1)
  assert.equal(result.baseKnown, true)
})

test('both sides moved to different content is a conflict that keeps the local text, and to the same content is nothing to do', () => {
  const local = digests({ instructions: 'mine', resources: [resource('scripts/a.py', 'same'), resource('references/r.md', 'r1')] })
  const upstream = digests({ instructions: 'theirs', resources: [resource('scripts/a.py', 'same'), resource('references/r.md', 'r1')] })
  const result = plan({ base, local, upstream })
  assert.equal(decisionOf(result, 'instructions').decision, 'conflict')
  assert.equal(decisionOf(result, 'instructions').side, 'local')
  assert.equal(decisionOf(result, 'scripts/a.py').decision, 'same')
  assert.equal(result.conflicts, 1)
  assert.equal(result.changes, 0, 'a conflict is not a change the update makes')
})

test('files are added, replaced and removed against the baseline, and a file the researcher added stays', () => {
  const local = digests({ instructions: 'v1', resources: [resource('scripts/a.py', 'a1'), resource('references/r.md', 'r1'), resource('scripts/mine.py', 'mine')] })
  const upstream = digests({ instructions: 'v1', resources: [resource('scripts/b.py', 'new'), resource('scripts/a.py', 'a1')] })
  const result = plan({ base, local, upstream })
  assert.equal(decisionOf(result, 'scripts/b.py').decision, 'add')
  assert.equal(decisionOf(result, 'references/r.md').decision, 'remove')
  assert.equal(decisionOf(result, 'references/r.md').side, 'removed')
  assert.equal(decisionOf(result, 'scripts/mine.py').decision, 'keep-local')
  assert.equal(decisionOf(result, 'scripts/mine.py').side, 'local')
  assert.equal(result.counts.add, 1)
  assert.equal(result.counts.remove, 1)
})

test('a file the researcher edited that upstream deleted is a conflict, not a deletion', () => {
  const local = digests({ resources: [resource('scripts/a.py', 'edited'), resource('references/r.md', 'r1')], instructions: 'v1' })
  const upstream = digests({ resources: [resource('references/r.md', 'r1')], instructions: 'v1' })
  assert.equal(decisionOf(plan({ base, local, upstream }), 'scripts/a.py').decision, 'conflict')
})

test('with no baseline every difference is a conflict: an unknown origin is never an overwrite', () => {
  const local = digests({ instructions: 'a' })
  const upstream = digests({ instructions: 'b', resources: [resource('scripts/new.py', 'n')] })
  const result = plan({ base: null, local, upstream })
  assert.equal(result.baseKnown, false)
  assert.equal(decisionOf(result, 'instructions').decision, 'conflict')
  assert.equal(decisionOf(result, 'scripts/new.py').decision, 'conflict')
  assert.equal(decisionOf(result, 'description').decision, 'unchanged')
  assert.equal(result.changes, 0)
})

test('every part is compared, and a baseline that does not read as one is absent', () => {
  assert.deepEqual([...SKILL_UPDATE_PARTS], ['description', 'instructions', 'whenToUse', 'invocation', 'metadata'])
  const result = plan({ base, local: base, upstream: digests({ invocation: { userInvocable: false, modelInvocable: true }, metadata: { k: 1 } }) })
  assert.equal(decisionOf(result, 'invocation').decision, 'take-upstream')
  assert.equal(decisionOf(result, 'metadata').decision, 'take-upstream')
  assert.deepEqual(normalizeSkillBaseline(base), base)
  assert.equal(normalizeSkillBaseline({ parts: { description: 'x' }, resources: {} }), null)
  assert.equal(normalizeSkillBaseline({ parts: base.parts, resources: { a: 'not-a-digest' } }), null)
  assert.equal(normalizeSkillBaseline(null), null)
})

test('the digests of a skill depend only on its content, in any key order', () => {
  const left = digests({ metadata: { a: 1, b: 2 } })
  const right = digests({ metadata: { b: 2, a: 1 } })
  assert.deepEqual(left, right)
  assert.notDeepEqual(left, digests({ metadata: { a: 1, b: 3 } }))
})
