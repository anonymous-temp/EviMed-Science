import assert from 'node:assert/strict'
import test from 'node:test'
import { ATTENDANCE_RECEIPTS_KEPT, appendAttendanceReceipt, attendanceInputDigest, attendanceReceiptFor, attendanceReceiptsFileFor, runContextAuthorityPublicKey, signRunContextAuthority, verifyRunContextAuthority } from '../src/runContextAuthority.mjs'

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


test('one receipts file per session, bounded and unambiguous across sessions', () => {
  const path = attendanceReceiptsFileFor('session-one')
  assert.match(path, /^\.evimed-brief\/attendance\/[a-f0-9]{64}\.json$/)
  assert.equal(path, attendanceReceiptsFileFor('session-one'))
  assert.notEqual(path, attendanceReceiptsFileFor('session-two'))
  assert.throws(() => attendanceReceiptsFileFor(''))
  // Receipts never accumulate: the file keeps the latest inputs of its session, a repeated request replaces its own.
  /** @type {ReturnType<typeof appendAttendanceReceipt>} */
  let file = appendAttendanceReceipt(null, signed({ contextRevision: 'request-0' }))
  for (let n = 1; n < ATTENDANCE_RECEIPTS_KEPT + 10; n += 1) file = appendAttendanceReceipt(file, signed({ contextRevision: `request-${n}` }))
  assert.equal(file.receipts.length, ATTENDANCE_RECEIPTS_KEPT)
  assert.equal(attendanceReceiptFor(file, 'request-0'), null)
  assert.equal(attendanceReceiptFor(file, `request-${ATTENDANCE_RECEIPTS_KEPT + 9}`)?.contextRevision, `request-${ATTENDANCE_RECEIPTS_KEPT + 9}`)
  file = appendAttendanceReceipt(file, signed({ contextRevision: 'request-20', unattended: false }))
  assert.equal(file.receipts.filter(item => item.contextRevision === 'request-20').length, 1)
  assert.equal(attendanceReceiptFor(file, 'request-20').unattended, false)
  // Another session's file, or one that is not a receipts file, is replaced and never read as this session's.
  assert.deepEqual(appendAttendanceReceipt({ sessionId: 'session-two', receipts: [signed({ contextRevision: 'x' })] }, signed()).receipts.map(item => item.contextRevision), ['request-one'])
  assert.equal(attendanceReceiptFor('not a file', 'request-one'), null)
})

test('a receipt binds the exact input text: its digest is signed, and cannot be added, removed or changed', () => {
  const digest = attendanceInputDigest('每周一提醒我检查新文献')
  assert.match(digest, /^[a-f0-9]{64}$/)
  /** @type {Record<string, any>} */
  const value = signed({ unattended: false, inputDigest: digest })
  assert.equal(verifyRunContextAuthority(value, expected)?.inputDigest, digest)
  assert.equal(verifyRunContextAuthority({ ...value, inputDigest: attendanceInputDigest('another text') }, expected), null)
  const { inputDigest: _removed, ...stripped } = value
  assert.equal(verifyRunContextAuthority(stripped, expected), null)
  assert.equal(verifyRunContextAuthority({ ...signed({ unattended: false }), inputDigest: digest }, expected), null, 'a digest cannot be added to a receipt signed without one')
  assert.equal(verifyRunContextAuthority(signed({ unattended: false }), expected)?.inputDigest, null, 'a receipt without a digest proves no text')
  assert.throws(() => signed({ inputDigest: 'not-a-digest' }))
})
