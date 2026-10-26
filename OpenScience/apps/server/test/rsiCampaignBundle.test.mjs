import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { signRsiCampaignBundle, verifyRsiCampaignBundle, rsiDigest } from '../src/rsiCampaignBundle.mjs'
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
