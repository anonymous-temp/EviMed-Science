import assert from 'node:assert/strict'
import test from 'node:test'
import { runContextAuthorityFileFor, runContextAuthorityPublicKey, signRunContextAuthority, verifyRunContextAuthority } from '../src/runContextAuthority.mjs'

const secret = 'server-only-attendance-signing-secret'
const index = { protocol: 2, runId: 'run-one', sessionId: 'session-one', contextRevision: 'request-one', unattended: true }
const expected = { publicKey: runContextAuthorityPublicKey(secret), userId: 'owner', projectId: 'project-one', sessionId: index.sessionId }
const signed = (extra = {}) => { const value = { ...index, ...extra }; return { ...value, attendanceAuthority: signRunContextAuthority(value, { signingSecret: secret, userId: expected.userId, projectId: expected.projectId }) } }

test('the control-plane secret derives a stable Ed25519 public verifier and signs attended and unattended context', () => {
  assert.equal(runContextAuthorityPublicKey(secret), expected.publicKey)
  assert.notEqual(runContextAuthorityPublicKey('another-server-secret'), expected.publicKey)
  for (const unattended of [true, false]) {
    const value = signed({ unattended })
    const authority = verifyRunContextAuthority(value, expected)
    assert.equal(authority?.unattended, unattended)
    assert.equal(authority?.contextRevision, index.contextRevision)
    assert.equal(authority?.userId, expected.userId)
    assert.equal(authority?.projectId, expected.projectId)
    assert.doesNotMatch(JSON.stringify(value), /server-only-attendance-signing-secret/)
  }
})

test('changing or removing any attendance identity or using another key or scope refuses authority', () => {
  const value = signed()
  for (const patch of [{ protocol: 3 }, { runId: 'other-run' }, { sessionId: 'other-session' }, { contextRevision: 'other-request' }, { unattended: false }, { attendanceAuthority: undefined }]) {
    assert.equal(verifyRunContextAuthority({ ...value, ...patch }, expected), null, JSON.stringify(patch))
  }
  for (const patch of [{ userId: 'another-owner' }, { projectId: 'another-project' }, { issuedAtMs: value.attendanceAuthority.issuedAtMs + 1 }, { signature: 'A'.repeat(86) }]) {
    assert.equal(verifyRunContextAuthority({ ...value, attendanceAuthority: { ...value.attendanceAuthority, ...patch } }, expected), null)
  }
  for (const patch of [{ userId: 'another-owner' }, { projectId: 'another-project' }, { sessionId: 'another-session' }, { publicKey: runContextAuthorityPublicKey('another-server-secret') }, { publicKey: '' }]) {
    assert.equal(verifyRunContextAuthority(value, { ...expected, ...patch }), null)
  }
})

test('malformed signatures and claims fail closed while sequential signatures have increasing issuance', () => {
  const one = signed(), two = signed({ contextRevision: 'request-two' })
  assert.ok(two.attendanceAuthority.issuedAtMs > one.attendanceAuthority.issuedAtMs)
  for (const malformed of [null, {}, [], 'index', { ...one, attendanceAuthority: {} }, { ...one, attendanceAuthority: { ...one.attendanceAuthority, version: 2 } }]) {
    assert.equal(verifyRunContextAuthority(malformed, expected), null)
  }
  assert.throws(() => signRunContextAuthority({ ...index, contextRevision: '' }, { signingSecret: secret, userId: 'owner', projectId: 'project-one' }))
})


test('request receipt paths are bounded, deterministic and unambiguous across sessions and opaque request IDs', () => {
  const path = runContextAuthorityFileFor('session-one', '../opaque-request')
  assert.match(path, /^\.evimed-brief\/attendance\/[a-f0-9]{64}\.json$/)
  assert.equal(path, runContextAuthorityFileFor('session-one', '../opaque-request'))
  assert.notEqual(path, runContextAuthorityFileFor('session-two', '../opaque-request'))
  assert.notEqual(runContextAuthorityFileFor('a/b', 'c'), runContextAuthorityFileFor('a', 'b/c'))
  assert.throws(() => runContextAuthorityFileFor('', 'request'))
})
