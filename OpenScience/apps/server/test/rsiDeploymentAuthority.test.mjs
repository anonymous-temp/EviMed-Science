import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRsiDeploymentAuthority, createRsiTrustRegistry } from '../src/rsiDeploymentAuthority.mjs';
import { canonicalRsiJson, rsiDigest } from '../src/rsiCampaignBundle.mjs';

test('deployment agreement binds version, owned source and current private record', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-authority-'));
  try {
    const file = path.join(dir, 'agreement.json');
    const record = { id: 'quality', version: 1, purpose: 'platform-quality', providers: ['deepseek', 'dashscope'], scope: 'authorized-incident' };
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    const authority = await createRsiDeploymentAuthority({ agreementRef: file });
    const input = { agreementId: authority.agreementId, user: { id: 'a' }, project: { userId: 'a' }, run: { id: 'run' } };
    assert.equal(await authority.authorizeIncident(input), true);
    assert.equal(await authority.authorizeIncident({ ...input, project: { userId: 'b' } }), false);
    await writeFile(file, JSON.stringify({ ...record, version: 2 }));
    assert.equal(await authority.authorizeIncident(input), false);
    await chmod(file, 0o644);
    await assert.rejects(createRsiDeploymentAuthority({ agreementRef: file }), /record_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('independent signed evaluator receipt admits new campaign evidence only in registered consumer/procedure scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-trust-'));
  try {
    const issuer = generateKeyPairSync('ed25519'), evaluator = generateKeyPairSync('ed25519');
    const publicPem = key => key.export({ type: 'spki', format: 'pem' });
    const issuerRef = path.join(dir, 'issuer.json'), evaluatorRef = path.join(dir, 'evaluator.json');
    const h = rsiDigest('qualified');
    await writeFile(issuerRef, JSON.stringify({ keyId: 'issuer', publicKey: publicPem(issuer.publicKey), surfaces: ['frontier-selection'], kinds: ['policy'] }), { mode: 0o600 });
    await writeFile(evaluatorRef, JSON.stringify({ schemaVersion: 1, evaluators: [{ keyId: 'independent', publicKey: publicPem(evaluator.publicKey), surfaces: ['frontier-selection'], procedureDigests: [h], consumerDigests: [h] }] }), { mode: 0o600 });
    const trust = await createRsiTrustRegistry({ trustedKeyRefs: [issuerRef], evaluatorRegistryRef: evaluatorRef }, { currentTarget: async () => ({ surface: 'frontier-selection' }) });
    const proof = { schemaVersion: 1, bundleId: 'bundle-1', campaignId: 'campaign-1', scope: 'frontier-selection', status: 'qualified', ...Object.fromEntries(['candidateDigest','registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','qualificationDigest','corpusDigest'].map(name => [name,h])) };
    const signed = value => { const payload = canonicalRsiJson(value); return { keyId: 'independent', payload, signature: sign(null, Buffer.from(`evimed-rsi-evaluator-v1\nindependent\n${payload}`), evaluator.privateKey).toString('base64') }; };
    const envelope = { keyId: 'issuer', evaluatorReceipt: signed(proof) };
    const result = await trust.verificationOptions(envelope);
    assert.deepEqual(result.expectedIdentity, { id: 'bundle-1', campaignId: 'campaign-1' });
    assert.equal(await result.qualification.verifyReceipt({ verdict: proof, manifest: { id: proof.bundleId, campaignId: proof.campaignId }, candidateDigest: h }), true);
    assert.equal((await trust.verificationOptions({ ...envelope, evaluatorReceipt: signed({ ...proof, campaignId: 'new-campaign', datasetDigest: rsiDigest('new dataset') }) })).expectedIdentity.campaignId, 'new-campaign');
    await assert.rejects(trust.verificationOptions({ ...envelope, evaluatorReceipt: signed({ ...proof, procedureDigest: rsiDigest('unapproved procedure') }) }), /scope_forbidden/);
    await assert.rejects(trust.verificationOptions({ ...envelope, evaluatorReceipt: { ...envelope.evaluatorReceipt, payload: envelope.evaluatorReceipt.payload + ' ' } }), /receipt_untrusted/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
