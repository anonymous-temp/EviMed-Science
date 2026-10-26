import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, verify } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticateEvaluation, consumerClosure, finalizeCampaign } from '../finalize.mjs';
import { createCampaignSigner } from '../signing.mjs';
import { canonicalRsiJson, rsiDigest, verifyRsiCampaignBundle } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { finalizerEvidencePayload, procedureQualification, qualificationDigests } from '../evaluator.mjs';
import {
  STATISTICS_MODULE_PATH, STATISTICS_PYTHON, procedureReport, registeredCampaignFixture, runToVerdict, withSource,
} from '../profiles/benign_fixture.mjs';

const NOW = '2026-10-26T12:00:00Z';
const BUNDLE_EXPIRES = '2026-10-26T23:00:00Z';
const root = new URL('../../../', import.meta.url).pathname;
const closureSettings = { provider: 'deepseek', model: 'deepseek-flash' };
const workDir = await mkdtemp(join(tmpdir(), 'rsi-finalizer-'));
after(() => rm(workDir, { recursive: true, force: true }));
let counter = 0;
const nextDir = () => join(workDir, `case-${counter++}`);

const fingerprint = (key) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
const localSigner = (keyId) => { const keys = generateKeyPairSync('ed25519'); return { keyId, ...keys, sign: (bytes) => sign(null, bytes, keys.privateKey) }; };

test('unbound signer refuses before SDK loading', async () => {
  let calls = 0;
  await assert.rejects(createCampaignSigner({}, { sdkLoader: async () => { calls++; } }), /campaign_signer_unavailable/);
  await assert.rejects(createCampaignSigner(undefined, { sdkLoader: async () => { calls++; } }), /campaign_signer_unavailable/);
  await assert.rejects(createCampaignSigner({ provider: 'environment-chain', keyId: 'k' }, { sdkLoader: async () => { calls++; } }), /campaign_signer_unavailable/);
  assert.equal(calls, 0);
});

test('signed evidence authority authenticates bytes, type, signer and expiry', () => {
  const keys = localSigner('evaluation');
  const profile = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: fingerprint(keys.publicKey) };
  const seal = (payload, key = keys) => ({ payload, signature: key.sign(Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(payload)}`)).toString('base64') });
  const payload = { type: 'rsi-finalizer-evidence-v1', expiresAt: '2026-10-27T00:00:00Z' };
  const envelope = seal(payload);
  assert.deepEqual(authenticateEvaluation(envelope, profile, NOW), payload);
  const untrusted = (envelopeOrProfile, at = NOW, p = profile) => assert.throws(() => authenticateEvaluation(envelopeOrProfile, p, at), { message: 'campaign_evaluator_authority_untrusted' });
  untrusted(envelope, '2026-10-28T00:00:00Z');
  untrusted(envelope, '2026-10-27T00:00:00Z'); // expiry is exclusive
  untrusted({ ...envelope, payload: { ...payload, flag: true } });
  untrusted(seal({ ...payload, type: 'rsi-evaluator-receipt-v1' }));
  untrusted(seal({ ...payload, expiresAt: 'not a time' }));
  untrusted(seal(payload, localSigner('other')));
  untrusted(envelope, NOW, { ...profile, publicKeySha256: 'a'.repeat(64) });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  untrusted(envelope, NOW, { publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: fingerprint(rsa.publicKey) });
  untrusted({ payload }, NOW);
  untrusted(null);
});

test('closure is code-bound and rejects traversal and final symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-closure-'));
  try {
    await writeFile(join(dir, 'consumer.mjs'), 'export const value=1;');
    const first = await consumerClosure(dir, ['consumer.mjs']);
    await writeFile(join(dir, 'consumer.mjs'), 'export const value=2;');
    assert.notEqual(await consumerClosure(dir, ['consumer.mjs']), first);
    await assert.rejects(consumerClosure(dir, ['../escape']), /closure_invalid/);
    await assert.rejects(consumerClosure(dir, []), /closure_invalid/);
    await assert.rejects(consumerClosure(dir, ['consumer.mjs', 'consumer.mjs']), /closure_invalid/);
    await assert.rejects(consumerClosure(dir, ['/etc/passwd']), /closure_invalid/);
    await symlink(join(dir, 'consumer.mjs'), join(dir, 'alias'));
    await assert.rejects(consumerClosure(dir, ['alias']));
  } finally { await rm(dir, { recursive: true }); }
});

test('KMS adapter pins version/key and sanitizes SDK failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-signing-'));
  try {
    const credentialRef = join(dir, 'credentials');
    await writeFile(credentialRef, JSON.stringify({ accessKeyId: 'fixture', accessKeySecret: 'MUST_NOT_ESCAPE' }), { mode: 0o600 });
    const keys = localSigner('publisher');
    let calls = 0;
    class Client { async getSecretValue(request) { calls++; assert.equal(request.versionId, 'v1'); return { body: { versionId: 'v1', secretDataType: 'text', secretData: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) } }; } }
    class Model { constructor(value) { Object.assign(this, value); } }
    const sdkLoader = async () => ({ kms: { default: Client, GetSecretValueRequest: Model }, openapi: { Config: Model } });
    const c = { provider: 'alibaba-secret-manager', keyId: 'publisher', region: 'cn-hangzhou', secretName: 'test-key', versionId: 'v1', credentialRef, publicKeySha256: fingerprint(keys.publicKey) };
    const signer = await createCampaignSigner(c, { sdkLoader });
    const message = Buffer.from('test');
    assert.equal(verify(null, message, keys.publicKey, signer.sign(message)), true);
    assert.equal(calls, 1);
    await assert.rejects(createCampaignSigner({ ...c, publicKeySha256: 'a'.repeat(64) }, { sdkLoader }), (error) => error.message === 'campaign_signer_unavailable');
    await assert.rejects(createCampaignSigner(c, { sdkLoader: async () => { throw new Error('MUST_NOT_ESCAPE'); } }), (error) => error.message === 'campaign_signer_unavailable');
  } finally { await rm(dir, { recursive: true }); }
});

test('a lab-local file signer needs an owner-only Ed25519 key it can verify, by absolute path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-file-signer-'));
  try {
    const keys = localSigner('publisher');
    const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const write = async (name, content, mode) => { const path = join(dir, name); await writeFile(path, content, { mode }); return path; };
    const config = (path, extra = {}) => ({ provider: 'file', keyId: 'publisher', publicKeySha256: fingerprint(keys.publicKey), path, ...extra });
    const unavailable = (candidate) => assert.rejects(createCampaignSigner(candidate), (error) => error.message === 'campaign_signer_unavailable' && !/\/|publisher-key|PRIVATE/.test(error.message));
    for (const [name, mode] of [['owner-only', 0o400], ['owner-read-write', 0o600], ['group-readable', 0o440]]) {
      const signer = await createCampaignSigner(config(await write(name, pem, mode)));
      assert.equal(signer.keyId, 'publisher', name);
      const message = Buffer.from('signed bytes');
      assert.equal(verify(null, message, signer.publicKey, signer.sign(message)), true, name);
      assert.equal(verify(null, message, keys.publicKey, signer.sign(message)), true, name);
    }
    // Looser modes, links, other key types, a key that is not the pinned one, and malformed configuration all refuse alike.
    await unavailable(config(await write('world-readable', pem, 0o644)));
    await unavailable(config(await write('group-writable', pem, 0o660)));
    await unavailable(config(await write('other-readable', pem, 0o404)));
    await symlink(join(dir, 'owner-only'), join(dir, 'linked'));
    await unavailable(config(join(dir, 'linked')));
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await unavailable({ ...config(await write('rsa', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o400)), publicKeySha256: fingerprint(rsa.publicKey) });
    await unavailable(config(await write('padded', `${pem}${'\n'.repeat(4096)}`, 0o400)));
    await unavailable(config(await write('not-a-key', 'hello', 0o400)));
    await unavailable(config(join(dir, 'owner-only'), { publicKeySha256: 'a'.repeat(64) }));
    await unavailable(config(join(dir, 'owner-only'), { publicKeySha256: 'xyz' }));
    await unavailable(config('owner-only'));
    await unavailable(config(join(dir, 'absent')));
    await unavailable(config(join(dir, 'owner-only'), { keyId: 'has space' }));
    await unavailable(config(join(dir, 'owner-only'), { keyId: undefined }));
    await unavailable(config(undefined));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/**
 * A campaign run through the real runner, the real statistics and a signed receipt to a qualified verdict on ≥25 measured days, with
 * the finalizer's evidence signed for it by an independent issuer. Each base is built once; a test works on a copy.
 */
const cache = new Map();
function qualifiedBase(name, options = {}, { generatedAt = '2026-10-20T00:00:00Z', mutateFixture } = {}) {
  if (!cache.has(name)) cache.set(name, (async () => {
    const closure = await computeRsiDependencyClosure({ rootDir: root, surface: 'frontier-selection', settings: closureSettings });
    assert.equal(closure.qualified, true, JSON.stringify(closure.issues));
    let fixture = await registeredCampaignFixture({ classification: 'public', ...options });
    // The consumer the campaign was made for is this tree's selector.
    fixture.manifest.target.dependencyDigest = closure.dependencyDigest;
    fixture.inputs.target = structuredClone(fixture.manifest.target);
    if (mutateFixture) fixture = await mutateFixture(fixture);
    const run = await runToVerdict(fixture, { dir: nextDir() });
    assert.equal(run.completed?.status, 'completed', JSON.stringify(run.awaiting).slice(0, 300));
    assert.equal(run.completed.qualification, 'qualified', JSON.stringify(run.completed.checkpoint?.evaluation?.reasons));
    const report = procedureReport({ generatedAt });
    const pinned = await qualificationDigests(report, { claim: 'superiority', rootDir: root });
    const { files, ...signed } = await finalizerEvidencePayload({ manifest: fixture.manifest, inputs: fixture.inputs, checkpoint: run.completed.checkpoint, report, rootDir: root, now: NOW });
    return { fixture, completed: run.completed, files, signed, pinned, closure, report, issuer: localSigner('input-evaluator') };
  })());
  return cache.get(name);
}

/** A private copy of a base, with the signers, the profile and a `finalize` that signs nothing unless every check passes. */
async function context(name, options, setup) {
  const base = await qualifiedBase(name, options, setup);
  const c = {
    manifest: structuredClone(base.fixture.manifest), inputs: structuredClone(base.fixture.inputs), completed: structuredClone(base.completed), files: structuredClone(base.files),
    signed: structuredClone(base.signed), report: base.report, closure: base.closure, issuer: base.issuer, publisher: localSigner('publisher'), evaluator: localSigner('evaluator'), signatures: { publisher: 0, evaluator: 0 },
    profile: { publicKey: base.issuer.publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: fingerprint(base.issuer.publicKey), qualificationDigests: [base.pinned.qualificationDigest], procedureDigests: [base.pinned.procedureDigest] },
    expiresAt: BUNDLE_EXPIRES, now: NOW, overrides: {},
  };
  c.seal = () => ({ payload: c.signed, signature: c.issuer.sign(Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(c.signed)}`)).toString('base64') });
  c.counted = (signer, label) => ({ ...signer, sign: (bytes) => { c.signatures[label] += 1; return signer.sign(bytes); } });
  c.signers = () => ({ publisher: c.counted(c.publisher, 'publisher'), evaluator: c.counted(c.evaluator, 'evaluator') });
  c.finalize = () => finalizeCampaign({
    completed: c.completed, manifest: c.manifest, inputs: c.inputs, files: c.files, evidenceEnvelope: c.seal(), profile: c.profile, currentTarget: c.manifest.target, root, bundleId: 'unit-bundle',
    expiresAt: c.expiresAt, now: c.now, loadSigners: async () => c.signers(), statisticsPython: STATISTICS_PYTHON, statisticsModulePath: STATISTICS_MODULE_PATH, closureSettings, ...c.overrides,
  });
  /** The checkpoint changed legitimately as a file: the digest of the record follows it. */
  c.restate = (mutate) => { mutate(c.completed.checkpoint); c.completed.reportDigest = rsiDigest(c.completed.checkpoint); };
  /** The manifest or inputs were filed differently: the binding every record carries follows them. */
  c.rebind = () => {
    const binding = rsiDigest({ manifest: c.manifest, inputs: c.inputs });
    c.completed.binding = binding;
    c.restate((state) => { state.binding = binding; });
    c.signed.binding = binding;
  };
  c.reclassify = (classification) => { c.manifest.data.classification = classification; c.rebind(); };
  return c;
}
async function refuses(c, code, label = code) {
  await assert.rejects(c.finalize(), (error) => error.message === code, label);
  assert.deepEqual(c.signatures, { publisher: 0, evaluator: 0 }, `${label}: nothing was signed`);
}

test('a qualified day-group campaign signs a bundle whose publisher and evaluator are independent', async () => {
  const c = await context('qualified');
  assert.equal(c.manifest.data.classification, 'public');
  assert.equal(c.manifest.data.sources[1].exposure, 'sealed');
  assert.equal(c.signed.sourceGroupProof.length, 30, 'one proof per measured confirmation day');
  assert.deepEqual(c.signed.sourceGroupProof[0], { id: 'day-2026-09-01', day: '2026-09-01', exposure: 'sealed' });
  assert.ok(c.completed.checkpoint.evaluation.quantities.superiority.quality_superiority.n_groups >= 25);
  const envelope = await c.finalize();
  assert.deepEqual(c.signatures.publisher, 1);
  assert.equal(c.signatures.evaluator, 1);
  const proof = JSON.parse(envelope.evaluatorReceipt.payload);
  assert.equal(proof.status, 'qualified');
  assert.equal(proof.candidateDigest, rsiDigest(c.files));
  assert.equal(proof.measurementDigest, rsiDigest(c.signed.statistics));
  assert.equal(proof.corpusDigest, c.manifest.data.sources[1].digest);
  assert.equal(proof.procedureDigest, c.signed.qualification.procedureDigest);
  assert.equal(proof.consumerDigest, c.closure.dependencyDigest);
  assert.equal(proof.bundleId, 'unit-bundle');
  assert.deepEqual(JSON.parse(c.files[0].content), { selectionThreshold: 72 });
  assert.equal(envelope.evaluatorReceipt.keyId, 'evaluator');
  assert.equal(verify(null, Buffer.from(`evimed-rsi-evaluator-v1\nevaluator\n${envelope.evaluatorReceipt.payload}`), c.evaluator.publicKey, Buffer.from(envelope.evaluatorReceipt.signature, 'base64')), true);
  assert.equal(verify(null, Buffer.from(`evimed-rsi-evaluator-v1\npublisher\n${envelope.evaluatorReceipt.payload}`), c.publisher.publicKey, Buffer.from(envelope.evaluatorReceipt.signature, 'base64')), false, 'the receipt is not the publisher\'s');
  const result = await verifyRsiCampaignBundle(envelope, { now: NOW, trustStore: { publisher: { publicKey: c.publisher.publicKey, surfaces: ['frontier-selection'], kinds: ['policy'] } },
    expectedIdentity: { id: 'unit-bundle', campaignId: c.manifest.id }, currentTarget: c.manifest.target, qualification: { ...proof, verifyReceipt: async () => true } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.files, c.files);
});

test('signers loaded from owner-only key files finalize the same campaign', async () => {
  const c = await context('qualified');
  const dir = await mkdtemp(join(workDir, 'keys-'));
  const configure = async (keyId, keys) => {
    const path = join(dir, `${keyId}.pem`);
    await writeFile(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o400 });
    return { provider: 'file', keyId, publicKeySha256: fingerprint(keys.publicKey), path };
  };
  const publisher = await configure('publisher', c.publisher), evaluator = await configure('evaluator', c.evaluator);
  c.overrides.loadSigners = async () => ({ publisher: await createCampaignSigner(publisher), evaluator: await createCampaignSigner(evaluator) });
  const envelope = await c.finalize();
  assert.equal(envelope.keyId, 'publisher');
  assert.equal(JSON.parse(envelope.evaluatorReceipt.payload).status, 'qualified');
  // The same key under two names is one party, and it is refused with the same closed reason.
  c.overrides.loadSigners = async () => ({ publisher: await createCampaignSigner(publisher), evaluator: await createCampaignSigner({ ...publisher, keyId: 'evaluator' }) });
  await assert.rejects(c.finalize(), { message: 'campaign_evaluator_not_independent' });
});

test('a synthetic campaign never finalizes, even when everything else about it is in order', async () => {
  // Run as a rehearsal (the confirmation corpus sealed so only the classification differs from the qualified campaign).
  const c = await context('synthetic', { classification: 'synthetic', confirmationExposure: 'sealed' });
  assert.equal(c.manifest.data.classification, 'synthetic');
  assert.equal(c.completed.checkpoint.evaluation.scope, 'synthetic-finite-corpus-only');
  assert.equal(c.completed.checkpoint.evaluation.decision, 'qualified');
  await refuses(c, 'campaign_evidence_scope_not_release_eligible', 'synthetic classification');
  // The very same record filed as a public campaign is what the finalizer signs.
  c.reclassify('public');
  const envelope = await c.finalize();
  assert.equal(JSON.parse(envelope.evaluatorReceipt.payload).status, 'qualified');
});

test('the finalizer re-checks day independence itself, whatever the runner recorded', async () => {
  // Confirmation days that start inside development's: a rehearsal run accepted them, a release must not.
  const overlapping = await context('overlapping-days', { classification: 'synthetic', confirmationExposure: 'sealed', confirmation: { start: '2026-07-20' } });
  const devDays = overlapping.inputs.sources.development.days.map((day) => day.day), confirmDays = overlapping.inputs.sources.confirmation.days.map((day) => day.day);
  assert.ok(devDays.some((day) => confirmDays.includes(day)), 'the fixture really overlaps');
  const devIds = new Set(overlapping.inputs.sources.development.days.flatMap((day) => day.rows.map((row) => row.id)));
  assert.ok(!overlapping.inputs.sources.confirmation.days.some((day) => day.rows.some((row) => devIds.has(row.id))), 'but shares no row');
  overlapping.reclassify('public');
  await refuses(overlapping, 'campaign_confirmation_not_independent', 'overlapping days');
  // Confirmation days all later than development's, one row id shared.
  const shared = await context('shared-row', { classification: 'synthetic', confirmationExposure: 'sealed' }, { mutateFixture: (fixture) => withSource(fixture, 'confirmation', (source) => {
    source.labels.find((label) => label.id === source.days[0].rows[0].id).id = 'dev-2026-07-01-00';
    source.days[0].rows[0].id = 'dev-2026-07-01-00';
  }) });
  const sharedDev = new Set(shared.inputs.sources.development.days.flatMap((day) => day.rows.map((row) => row.id)));
  assert.ok(shared.inputs.sources.confirmation.days.some((day) => day.rows.some((row) => sharedDev.has(row.id))), 'the fixture really shares a row');
  assert.ok(Math.max(...shared.inputs.sources.development.days.map((d) => Date.parse(d.day))) < Math.min(...shared.inputs.sources.confirmation.days.map((d) => Date.parse(d.day))), 'days are ordered');
  shared.reclassify('public');
  await refuses(shared, 'campaign_confirmation_not_independent', 'a shared row id');
  // The sealed-exposure rule: a confirmation corpus that was exposed is refused outright.
  const exposed = await context('qualified');
  exposed.manifest.data.sources[1].exposure = 'exposed';
  exposed.reclassify('public');
  await refuses(exposed, 'campaign_confirmation_not_independent', 'an exposed confirmation corpus');
});

test('the group proof must name a registered confirmation day once each, sealed', async () => {
  const mutations = {
    'a development day': (proof) => { proof[0].day = '2026-07-01'; },
    'a day outside every source': (proof) => { proof[0].day = '2030-01-01'; },
    'a day registered under another group': (proof) => { proof[0].id = proof[1].id; },
    'a repeated day': (proof) => { proof[1].day = proof[0].day; },
    'an exposed day': (proof) => { proof[0].exposure = 'exposed'; },
    'a missing group': (proof) => { proof.pop(); },
    'an extra group': (proof) => { proof.push({ id: 'day-extra', day: '2026-09-03', exposure: 'sealed' }); },
    'no proof': (proof, signed) => { delete signed.sourceGroupProof; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const c = await context('qualified');
    mutate(c.signed.sourceGroupProof, c.signed);
    await refuses(c, 'campaign_source_group_proof_invalid', name);
  }
});

test('a record that does not match its own digest, source, policy or measurement never signs', async () => {
  const cases = [
    ['campaign_checkpoint_changed', 'a tampered report digest', (c) => { c.completed.reportDigest = 'a'.repeat(64); }],
    ['campaign_checkpoint_changed', 'a checkpoint edited without its digest', (c) => { c.completed.checkpoint.confirmationLooks = 2; }],
    ['campaign_checkpoint_changed', 'another campaign\'s checkpoint', (c) => { c.restate((state) => { state.campaignId = 'another'; }); }],
    ['campaign_checkpoint_changed', 'inputs that are not the checkpoint\'s', (c) => { c.inputs.registration.maxVolumeRatio = 2; }],
    ['campaign_finalization_input_invalid', 'a run that is not completed', (c) => { c.completed.status = 'awaiting-evaluation'; }],
    ['campaign_finalization_input_invalid', 'a manifest that fails its contract', (c) => { c.manifest.automated = false; }],
    ['campaign_stage_uncertain', 'a stage that did not finish', (c) => { c.restate((state) => { state.stages.confirmation.status = 'running'; }); }],
    ['campaign_stage_uncertain', 'a stage result edited in place', (c) => { c.restate((state) => { state.stages.development.result = {}; }); }],
    ['campaign_frozen_policy_changed', 'a frozen policy edited after the fact', (c) => { c.restate((state) => { state.frozenPolicy.threshold = 76; }); }],
    ['campaign_frozen_policy_changed', 'a freeze before the campaign existed', (c) => { c.restate((state) => { state.frozenAt = '2026-10-01T00:00:00Z'; }); }],
    ['campaign_confirmation_time_changed', 'another opening time in the evidence', (c) => { c.signed.confirmationOpenedAt = '2026-10-26T01:59:59.000Z'; }],
    ['campaign_evidence_binding_changed', 'a confirmation opened no later than the freeze', (c) => {
      const frozen = c.completed.checkpoint.frozenAt;
      c.restate((state) => { state.confirmationOpenedAt = frozen; });
      c.signed.confirmationOpenedAt = frozen;
    }],
    ['campaign_evidence_binding_changed', 'a corpus other than the sealed one', (c) => { c.signed.corpusDigest = 'f'.repeat(64); }],
    ['campaign_evidence_binding_changed', 'a dataset other than the inputs', (c) => { c.signed.datasetDigest = 'f'.repeat(64); }],
    ['campaign_evidence_binding_changed', 'a registration other than the manifest\'s', (c) => { c.signed.registrationDigest = 'f'.repeat(64); }],
    ['campaign_evidence_binding_changed', 'another frozen policy', (c) => { c.signed.frozenPolicyDigest = 'f'.repeat(64); }],
    ['campaign_consumer_proof_untrusted', 'a proof for another result', (c) => { c.signed.consumerProof.resultDigest = 'f'.repeat(64); }],
    ['campaign_consumer_proof_untrusted', 'a proof that the consumer did not run', (c) => { c.signed.consumerProof.executed = false; }],
    ['campaign_consumer_proof_untrusted', 'a proof for another baseline', (c) => { c.signed.consumerProof.baselineRevision = 'another-baseline'; }],
    ['campaign_measured_evidence_changed', 'a measurement edited in the evidence', (c) => { c.signed.statistics.observations[0].quality = 0.99; }],
    ['campaign_measured_evidence_changed', 'a measurement edited in the record', (c) => { c.restate((state) => { state.evaluation.observationDigest = 'f'.repeat(64); }); }],
    ['campaign_statistics_binding_changed', 'a second look recorded in the measurement', (c) => {
      c.restate((state) => { state.evaluation.statisticsInput.receipt.look = 2; });
      c.signed.statistics.receipt.look = 2;
    }],
    ['campaign_statistics_binding_changed', 'a confirmation recorded as exposed', (c) => {
      c.restate((state) => { state.evaluation.statisticsInput.receipt.confirmation_exposed = true; });
      c.signed.statistics.receipt.confirmation_exposed = true;
    }],
    ['campaign_statistics_binding_changed', 'a registered procedure other than the manifest\'s', (c) => { c.manifest.registration.procedure = 'rsi-paired-group-v4'; c.rebind(); }],
  ];
  for (const [code, label, mutate] of cases) {
    const c = await context('qualified');
    mutate(c);
    await refuses(c, code, label);
  }
});

test('the candidate is exactly the frozen policy file', async () => {
  const policy = (threshold) => canonicalRsiJson({ selectionThreshold: threshold });
  for (const [label, mutate] of [
    ['another threshold', (files) => { files[0].content = policy(76); }],
    ['an empty policy', (files) => { files[0].content = '{}'; }],
    ['non-canonical bytes', (files) => { files[0].content = JSON.stringify({ selectionThreshold: 72 }, null, 1); }],
    ['another file name', (files) => { files[0].path = 'policy.yaml'; }],
    ['an extra file', (files) => { files.push({ path: 'extra.json', content: '{}' }); }],
    ['no file', (files) => { files.length = 0; }],
  ]) {
    const c = await context('qualified');
    mutate(c.files);
    await refuses(c, 'campaign_frozen_candidate_changed', label);
  }
});

test('evidence is refused once expired, unsigned by the pinned issuer, edited or not for this qualification', async () => {
  const expiredEvidence = await context('qualified');
  expiredEvidence.signed.expiresAt = '2020-01-01T00:00:00Z';
  await refuses(expiredEvidence, 'campaign_evaluator_authority_untrusted', 'expired evidence');
  const edited = await context('qualified');
  const sealed = edited.seal();
  edited.seal = () => ({ ...sealed, payload: { ...sealed.payload, candidateDigest: 'f'.repeat(64) } });
  await refuses(edited, 'campaign_evaluator_authority_untrusted', 'evidence edited after signing');
  const foreign = await context('qualified');
  foreign.issuer = localSigner('someone-else');
  await refuses(foreign, 'campaign_evaluator_authority_untrusted', 'evidence from an issuer the profile does not pin');
  const unlisted = await context('qualified');
  unlisted.profile.qualificationDigests = [];
  await refuses(unlisted, 'campaign_procedure_not_qualified', 'a qualification the owner did not pin');
  const otherProcedure = await context('qualified');
  otherProcedure.profile.procedureDigests = ['f'.repeat(64)];
  await refuses(otherProcedure, 'campaign_procedure_not_qualified', 'a procedure the owner did not pin');
  // A qualification that lapsed: the statistics report is older than its 180 days. Pinned by the owner, so only the expiry fails.
  const lapsed = await context('qualified');
  const old = procedureQualification(procedureReport({ generatedAt: '2026-01-01T00:00:00Z' }), { claim: 'superiority', procedure: lapsed.signed.statistics.registration.procedure, consumerDigest: lapsed.closure.dependencyDigest });
  assert.ok(Date.parse(old.expiresAt) < Date.parse(NOW));
  lapsed.signed.qualification = old;
  lapsed.profile.qualificationDigests = [rsiDigest(old)];
  await refuses(lapsed, 'campaign_procedure_not_qualified', 'a lapsed qualification');
  // A qualification of another consumer or another claim, pinned all the same.
  for (const [label, change] of [['another consumer', { consumerDigest: 'f'.repeat(64) }], ['another claim', { claims: ['efficiency'] }], ['a test-only qualification', { testOnly: true }], ['a finite-corpus scope', { evidenceScope: 'finite-corpus-diagnostic' }]]) {
    const c = await context('qualified');
    c.signed.qualification = { ...c.signed.qualification, ...change };
    c.profile.qualificationDigests = [rsiDigest(c.signed.qualification)];
    await refuses(c, change.testOnly || change.evidenceScope ? 'campaign_evidence_scope_not_release_eligible' : 'campaign_procedure_not_qualified', label);
  }
});

test('the bundle must lapse before the campaign deadline and after now', async () => {
  for (const [label, change] of [
    ['expiring after the deadline', { expiresAt: '2026-11-01T00:00:00Z' }],
    ['already expired', { expiresAt: '2026-10-26T11:00:00Z' }],
    ['expiring now', { expiresAt: NOW }],
    ['no expiry', { expiresAt: undefined }],
    ['finalized at the deadline', { now: '2026-10-31T16:00:00.000Z', expiresAt: '2026-10-31T17:00:00Z' }],
    ['finalized with an unreadable time', { now: 'noon' }],
  ]) {
    const c = await context('qualified');
    Object.assign(c, change);
    await refuses(c, 'campaign_bundle_expired', label);
  }
});

test('the consumer must be the one the campaign was registered against', async () => {
  const wrongSettings = await context('qualified');
  wrongSettings.overrides.closureSettings = { provider: 'deepseek', model: 'another-model' };
  await refuses(wrongSettings, 'campaign_consumer_changed', 'a consumer built with other settings');
  const wrongTarget = await context('qualified');
  wrongTarget.signed.consumerDigest = 'f'.repeat(64);
  await refuses(wrongTarget, 'campaign_evidence_binding_changed', 'evidence for another consumer');
  const moved = await context('qualified');
  moved.overrides.currentTarget = { ...moved.manifest.target, baselineRevision: 'a-newer-baseline' };
  await refuses(moved, 'campaign_finalization_input_invalid', 'a serving baseline that moved');
  const other = await context('qualified');
  other.overrides.currentTarget = { ...other.manifest.target, dependencyDigest: 'f'.repeat(64) };
  await refuses(other, 'campaign_finalization_input_invalid', 'a serving dependency that changed');
});

test('a statistics process that fails or a registration that lapsed before finalization signs nothing', async () => {
  const broken = await context('qualified');
  broken.overrides.statisticsPython = '/nonexistent/python3';
  await refuses(broken, 'campaign_statistics_digest_mismatch', 'a statistics process that is not there');
  // The registration expired at 11:00, an hour before this finalization; it qualified at 01:00 when it was run.
  const lapsed = await context('expired-registration', { statistics: { expiresAt: '2026-10-26T11:00:00Z' } });
  assert.equal(lapsed.completed.checkpoint.evaluation.decision, 'qualified');
  await refuses(lapsed, 'campaign_statistics_not_qualified', 'a registration past its horizon');
  const early = await context('expired-registration');
  early.now = '2026-10-26T10:00:00Z';
  early.expiresAt = '2026-10-26T10:30:00Z';
  const envelope = await early.finalize();
  assert.equal(JSON.parse(envelope.evaluatorReceipt.payload).status, 'qualified', 'inside its horizon the same campaign signs');
});

test('the publisher and the evaluator must be different keys, by id or by material', async () => {
  const same = await context('qualified');
  same.signers = () => { const p = same.counted(same.publisher, 'publisher'); return { publisher: p, evaluator: { ...p } }; };
  await refuses(same, 'campaign_evaluator_not_independent', 'one signer used twice');
  const renamed = await context('qualified');
  renamed.signers = () => ({ publisher: renamed.counted(renamed.publisher, 'publisher'), evaluator: renamed.counted({ ...renamed.publisher, keyId: 'evaluator' }, 'evaluator') });
  await refuses(renamed, 'campaign_evaluator_not_independent', 'one key under two ids');
  const unsigned = await context('qualified');
  unsigned.signers = () => ({ publisher: unsigned.counted(unsigned.publisher, 'publisher') });
  await refuses(unsigned, 'campaign_evaluator_not_independent', 'no evaluator signer');
  const idOnly = await context('qualified');
  idOnly.signers = () => ({ publisher: idOnly.counted(idOnly.publisher, 'publisher'), evaluator: idOnly.counted({ ...idOnly.evaluator, keyId: 'publisher' }, 'evaluator') });
  await refuses(idOnly, 'campaign_evaluator_not_independent', 'two keys under one id');
});

test('an incident campaign finalizes only while its authorization is current', async () => {
  const c = await context('qualified');
  c.manifest.data.classification = 'authorized-incident';
  c.manifest.data.authorization = { id: 'authorization-test', incidentId: 'incident-test', incidentDigest: 'a'.repeat(64), sourceRunId: 'source-run', sourceRevision: 'source-rev', purpose: 'platform-quality', minimized: true };
  c.reclassify('authorized-incident');
  await refuses(c, 'campaign_incident_authority_unavailable', 'no transport');
  c.overrides.incidentTransport = { assertIncidentCurrent: async () => { throw new Error('revoked'); } };
  await assert.rejects(c.finalize(), { message: 'revoked' });
  assert.deepEqual(c.signatures, { publisher: 0, evaluator: 0 });
  let checks = 0;
  c.overrides.incidentTransport = { assertIncidentCurrent: async (authorization) => { checks += 1; assert.equal(authorization.id, 'authorization-test'); } };
  assert.equal(JSON.parse((await c.finalize()).evaluatorReceipt.payload).status, 'qualified');
  assert.ok(checks >= 3, `checked at entry, before signing the receipt and before signing the bundle (${checks})`);
  // Withdrawn between the receipt and the bundle: the receipt was signed, the bundle was not.
  const late = await context('qualified');
  late.manifest.data.classification = 'authorized-incident';
  late.manifest.data.authorization = c.manifest.data.authorization;
  late.reclassify('authorized-incident');
  let count = 0;
  late.overrides.incidentTransport = { assertIncidentCurrent: async () => { if (++count >= 3) throw new Error('revoked late'); } };
  await assert.rejects(late.finalize(), { message: 'revoked late' });
  assert.deepEqual(late.signatures, { publisher: 0, evaluator: 1 });
});
