import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalRsiJson, signRsiCampaignBundle, verifyRsiCampaignBundle, rsiDigest } from '../src/rsiCampaignBundle.mjs'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const hash = rsiDigest('test')
const qualification = { registrationDigest: hash, datasetDigest: hash, measurementDigest: hash, evaluatorDigest: hash, procedureDigest: hash, qualificationDigest: hash, consumerDigest: hash, scope: 'frontier-selection', corpusDigest: hash }
const manifest = { id: 'bundle-1', campaignId: 'campaign-1', surface: 'frontier-selection', kind: 'policy', createdAt: '2026-10-26T00:00:00Z', expiresAt: '2026-10-27T00:00:00Z', target: { surface: 'frontier-selection', dependencyDigest: hash, baselineRevision: 'base-1' }, verdict: { status: 'qualified', candidateDigest: hash, registrationDigest: hash, datasetDigest: hash, measurementDigest: hash, ...qualification } }
const options = { trustStore: { publisher: { publicKey, surfaces: ['frontier-selection'], kinds: ['policy'] } }, currentTarget: manifest.target, expectedIdentity: { id: 'bundle-1', campaignId: 'campaign-1' }, qualification: { ...qualification, verifyReceipt: () => true }, now: '2026-10-26T12:00:00Z' }
async function fixture() { const files = [{ path: 'policy.json', content: '{"limit":2}' }]; const candidateDigest = rsiDigest(files); return signRsiCampaignBundle({ manifest: { ...manifest, verdict: { ...manifest.verdict, candidateDigest } }, files, keyId: 'publisher', signer: bytes => sign(null, bytes, privateKey) }) }
test('signed content is validated and bound to current target', async () => { const bundle = await fixture(); assert.equal((await verifyRsiCampaignBundle(bundle, options)).ok, true); assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, currentTarget: { ...manifest.target, baselineRevision: 'new' } })).ok, false) })
test('tampering, unknown key, expiry, unknown qualification fail closed', async () => { const bundle = await fixture(); for (const candidate of [{ ...bundle, payload: bundle.payload + ' ' }, { ...bundle, keyId: 'unknown' }]) assert.equal((await verifyRsiCampaignBundle(candidate, options)).ok, false); assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, now: '2027-01-01T00:00:00Z' })).ok, false); assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, qualification: null })).ok, false) })
test('rejects duplicate paths, escape paths, null manifest and prototype fields', async () => { for (const files of [[{ path: '../escape', content: 'x' }], [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }]]) await assert.rejects(signRsiCampaignBundle({ manifest, files, keyId: 'publisher', signer: bytes => sign(null, bytes, privateKey) })); await assert.rejects(signRsiCampaignBundle({ manifest: null, files: [], keyId: 'publisher', signer: () => Buffer.alloc(64) })); assert.throws(() => rsiDigest(JSON.parse('{"__proto__":1}'))) })
test('trusted evaluator receipt and every evidence identity are mandatory', async () => {
  const bundle = await fixture()
  for (const qualification of [{ ...options.qualification, verifyReceipt: () => false }, { ...options.qualification, datasetDigest: '0'.repeat(64) }, { ...options.qualification, consumerDigest: '0'.repeat(64) }]) assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, qualification })).ok, false)
  assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, seenIds: new Set(['bundle-1']) })).ok, false)
  assert.equal((await verifyRsiCampaignBundle(bundle, { ...options, currentTarget: { ...manifest.target, dependencyDigest: '0'.repeat(64) } })).ok, false)
  const forged = JSON.parse(bundle.payload); forged.files[0].content = '{"limit":999}'
  assert.equal((await verifyRsiCampaignBundle({ ...bundle, payload: JSON.stringify(forged) }, options)).ok, false)
})
test('canonical JSON is RFC 8785 and byte-identical to Python rfc8785 0.1.4', () => {
  const c = String.fromCodePoint
  // Expected bytes produced by rfc8785.dumps (0.1.4) on the same values; hex keeps escapes out of this source.
  const vectors = [
    [{ [c(0x20ac)]: 'Euro Sign', [c(13)]: 'Carriage Return', [c(0xfb33)]: 'Hebrew Letter Dalet With Dagesh', '1': 'One', [c(0x1F600)]: 'Emoji: Grinning Face', [c(0x80)]: 'Control', [c(0xf6)]: 'Latin Small Letter O With Diaeresis' },
      '7b225c72223a2243617272696167652052657475726e222c2231223a224f6e65222c22c280223a22436f6e74726f6c222c22c3b6223a224c6174696e20536d616c6c204c6574746572204f205769746820446961657265736973222c22e282ac223a224575726f205369676e222c22f09f9880223a22456d6f6a693a204772696e6e696e672046616365222c22efacb3223a22486562726577204c65747465722044616c6574205769746820446167657368227d'],
    [{ string: c(0x20ac) + '$' + c(0x0f) + c(0x0a) + "A'" + c(0x42) + c(0x22) + c(0x5c) + c(0x5c) + c(0x22) + '/', literals: [null, true, false] },
      '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d'],
    [[Number('333333333.33333329'), 4.50, 2e-3, 1e-27, 1e-7, -1.5, 0, -0, 9007199254740991, -9007199254740991, 123.456, 5e-324, 0.1],
      '5b3333333333333333332e333333333333332c342e352c302e3030322c31652d32372c31652d372c2d312e352c302c302c393030373139393235343734303939312c2d393030373139393235343734303939312c3132332e3435362c35652d3332342c302e315d'],
    [[56, { d: true, '10': null, '1': [] }], '5b35362c7b2231223a5b5d2c223130223a6e756c6c2c2264223a747275657d5d'],
    [{ k: c(0) + c(1) + c(0x1f) + c(0x7f) + c(0x2028) + c(0x2029) + c(8) + c(12) + c(9) }, '7b226b223a225c75303030305c75303030315c75303031667fe280a8e280a95c625c665c74227d'],
  ]
  for (const [value, hex] of vectors) assert.equal(Buffer.from(canonicalRsiJson(value)).toString('hex'), hex)
  // rfc8785 refuses these (IntegerDomainError, FloatDomainError, CanonicalizationError, UnicodeEncodeError).
  for (const value of [9007199254740992, -9007199254740992, 2 ** 64, NaN, Infinity, -Infinity, String.fromCharCode(0xd800), `a${String.fromCharCode(0xdfff)}`, [String.fromCharCode(0xdc00)], { [String.fromCharCode(0xdc00)]: 1 }]) {
    assert.throws(() => canonicalRsiJson(value), TypeError)
  }
})
