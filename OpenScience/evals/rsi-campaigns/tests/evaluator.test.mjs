import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRsiJson, rsiDigest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { runCampaign, signedEvaluatorReceipt } from '../campaign_runner.mjs';
import { evaluatorKey, evaluatorReceiptPayload, finalizerEvidencePayload, procedureQualification, qualificationDigests, signEnvelope } from '../evaluator.mjs';
import { frontierCampaignConsumerIdentity } from '../frontier_campaign.mjs';
import { generateEvaluatorKey, memoryCampaignStore, procedureReport, registeredCampaignFixture, runnerEnvironment, tickingClock, writeSignedReceipt } from '../profiles/benign_fixture.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('../../../', import.meta.url).pathname;
const evaluatorScript = new URL('../evaluator.mjs', import.meta.url).pathname;
const NOW = '2026-10-26T02:00:00.000Z';

/** A campaign run through development and confirmation to its evaluator request: what an honest evaluator is handed. */
async function awaiting(options = {}) {
  const fixture = await registeredCampaignFixture(options);
  const store = memoryCampaignStore(), now = tickingClock();
  const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store, now }) });
  assert.equal(result.status, 'awaiting-evaluation', JSON.stringify(result).slice(0, 300));
  return { ...fixture, request: result.request, checkpoint: store.state(fixture.manifest.id) };
}
const base = await awaiting();
/** A private copy of the honest inputs to tamper with. */
const copy = () => structuredClone({ manifest: base.manifest, inputs: base.inputs, request: base.request, checkpoint: base.checkpoint });
/** The honest state after a legitimate change to the campaign: the binding and the registration digest follow it. */
const rebound = (c) => {
  const binding = rsiDigest({ manifest: c.manifest, inputs: c.inputs });
  c.request.binding = binding;
  c.checkpoint.binding = binding;
  c.request.registrationDigest = rsiDigest(c.inputs.registration.statistics ?? null);
  return c;
};
async function refuses(mutate, code) {
  const c = copy();
  mutate(c);
  await assert.rejects(evaluatorReceiptPayload({ ...c, now: NOW }), { message: code });
}

test('the untouched state recomputes, so every refusal below starts from a state that signs', async () => {
  const payload = await evaluatorReceiptPayload({ ...copy(), now: NOW });
  assert.equal(payload.type, 'rsi-evaluator-receipt-v1');
  for (const [key, value] of Object.entries(base.request)) assert.deepEqual(payload[key], value, key);
  assert.equal(payload.issuedAt, NOW);
});

test('the receipt attests what the evaluator itself recomputed', async () => {
  const c = copy();
  const payload = await evaluatorReceiptPayload({ ...c, now: NOW });
  const observations = c.checkpoint.stages.confirmation.result.observations;
  const identity = await frontierCampaignConsumerIdentity();
  const statistics = c.inputs.registration.statistics;
  assert.equal(payload.observationDigest, rsiDigest(observations));
  assert.equal(payload.costs.length, observations.length);
  assert.deepEqual(payload.costs.map((row) => `${row.group}/${row.arm}/${row.form}/${row.repeat}`), observations.map((row) => `${row.group}/${row.arm}/${row.form}/${row.repeat}`));
  assert.ok(payload.costs.every((row) => row.cost === 0), 'deterministic selection makes no model call');
  assert.equal(payload.costProvenance.type, 'measured-normalized-cny');
  assert.equal(payload.costProvenance.complete, true);
  assert.match(payload.costProvenance.receiptId, /^deterministic-selection:[a-f0-9]{16}$/);
  const qualification = payload.receipt.deterministic_qualification;
  assert.deepEqual([qualification.type, qualification.externally_verified, qualification.consumer_id, qualification.corpus_digest],
    ['trusted-deterministic-consumer', true, identity.implementationSha256, statistics.corpus_digest]);
  assert.match(qualification.qualification_id, /^replayed-twice:[a-f0-9]{16}$/);
  assert.deepEqual(payload.receipt.attestations, { registration_digest: rsiDigest(statistics), confirmation_exposed: false, look: 1, complete_costs: true,
    cost_identity: 'deterministic-no-model-call', expired_budget: false });
  assert.deepEqual(payload.consumer, identity);
});

test('a receipt lapses seven days after issue, or at the campaign deadline if that comes first', async () => {
  // The default deadline (2026-10-31T16:00Z) is five days away from NOW: the deadline caps it.
  const capped = await evaluatorReceiptPayload({ ...copy(), now: NOW });
  assert.equal(capped.expiresAt, base.manifest.deadline);
  const far = await awaiting({ deadline: '2026-12-31T00:00:00Z' });
  const week = await evaluatorReceiptPayload({ manifest: far.manifest, inputs: far.inputs, request: far.request, checkpoint: far.checkpoint, now: NOW });
  assert.equal(week.expiresAt, '2026-11-02T02:00:00.000Z');
});

test('past the registered expiry the attestation says the budget horizon was spent', async () => {
  const c = copy();
  const payload = await evaluatorReceiptPayload({ ...c, now: '2026-11-05T00:00:00Z' });
  assert.equal(payload.receipt.attestations.expired_budget, true);
});

test('a frozen policy the development source does not yield is refused', async () => {
  await refuses((c) => { c.checkpoint.frozenPolicy.threshold = 76; }, 'campaign_evaluator_development_differs');
  await refuses((c) => { c.checkpoint.frozenPolicy.developmentResultDigest = 'f'.repeat(64); }, 'campaign_evaluator_development_differs');
  await refuses((c) => { c.request.frozenPolicyDigest = 'f'.repeat(64); }, 'campaign_evaluator_development_differs');
  await refuses((c) => { delete c.checkpoint.frozenPolicy; }, 'campaign_evaluator_development_differs');
  // A runner that froze another line than the registered rule yields, with every digest made consistent with its choice:
  // only the evaluator's own recomputation of the choice can refuse it.
  await refuses((c) => { c.checkpoint.frozenPolicy.threshold = 76; c.request.frozenPolicyDigest = rsiDigest(c.checkpoint.frozenPolicy); }, 'campaign_evaluator_development_differs');
  await refuses((c) => { c.checkpoint.frozenPolicy.developmentResultDigest = 'f'.repeat(64); c.request.frozenPolicyDigest = rsiDigest(c.checkpoint.frozenPolicy); }, 'campaign_evaluator_development_differs');
});

test('a confirmation result the evaluator cannot reproduce is refused', async () => {
  await refuses((c) => { c.request.confirmationResultDigest = 'f'.repeat(64); }, 'campaign_evaluator_recomputation_differs');
  // A runner that reports a different result than the corpus gives: the digest it asks to be bound to is of its own result.
  await refuses((c) => { c.request.confirmationResultDigest = rsiDigest({ ...c.checkpoint.stages.confirmation.result, volumeRatio: 0.5 }); }, 'campaign_evaluator_recomputation_differs');
});

test('a second look at the confirmation corpus is refused', async () => {
  await refuses((c) => { c.request.look = 2; }, 'campaign_evaluator_repeated_look');
  await refuses((c) => { c.request.look = 0; }, 'campaign_evaluator_repeated_look');
});

test('the freeze must strictly precede the confirmation opening', async () => {
  await refuses((c) => { c.checkpoint.frozenAt = c.request.confirmationOpenedAt; }, 'campaign_evaluator_chronology_invalid');
  await refuses((c) => { c.checkpoint.frozenAt = new Date(Date.parse(c.request.confirmationOpenedAt) + 1000).toISOString(); }, 'campaign_evaluator_chronology_invalid');
  await refuses((c) => { c.checkpoint.frozenAt = 'not-a-date'; }, 'campaign_evaluator_chronology_invalid');
  // A campaign whose clock never advanced between the freeze and the opening cannot be evidence either.
  const frozenClock = await registeredCampaignFixture();
  const store = memoryCampaignStore();
  const result = await runCampaign({ ...frozenClock, ...runnerEnvironment({ store, now: () => '2026-10-26T01:00:00Z' }) });
  assert.equal(result.status, 'awaiting-evaluation');
  await assert.rejects(evaluatorReceiptPayload({ manifest: frozenClock.manifest, inputs: frozenClock.inputs, request: result.request, checkpoint: store.state(frozenClock.manifest.id), now: NOW }), { message: 'campaign_evaluator_chronology_invalid' });
});

test('the request and checkpoint must be bound to the campaign the evaluator was handed', async () => {
  await refuses((c) => { c.request.binding = 'x'; }, 'campaign_evaluator_binding_changed');
  await refuses((c) => { c.checkpoint.binding = 'x'; }, 'campaign_evaluator_binding_changed');
  await refuses((c) => { c.request.corpusDigest = 'f'.repeat(64); }, 'campaign_evaluator_binding_changed');
  await refuses((c) => { c.request.registrationDigest = 'f'.repeat(64); }, 'campaign_evaluator_binding_changed');
  // Inputs edited after the run change the binding: the request that was made for the old inputs no longer fits.
  await refuses((c) => { c.inputs.registration.thresholds = [...c.inputs.registration.thresholds, 78]; }, 'campaign_evaluator_binding_changed');
});

test('a source that no longer matches its registered digest is refused even when the binding follows it', async () => {
  await refuses((c) => { c.inputs.sources.confirmation.labels[0].worth = c.inputs.sources.confirmation.labels[0].worth === 'pick' ? 'no' : 'pick'; rebound(c); }, 'campaign_source_changed');
  await refuses((c) => { c.inputs.sources.development.band.pickWeight = 5; rebound(c); }, 'campaign_source_changed');
});

test('the registered consumer, corpus and cost identity are checked against what is running', async () => {
  await refuses((c) => { c.inputs.registration.statistics.consumer_id = 'f'.repeat(64); rebound(c); }, 'campaign_evaluation_consumer_or_corpus_changed');
  await refuses((c) => { c.inputs.registration.statistics.corpus_digest = 'f'.repeat(64); rebound(c); }, 'campaign_evaluation_consumer_or_corpus_changed');
  await refuses((c) => { c.inputs.registration.statistics.cost_identity = 'all paid attempts'; rebound(c); }, 'campaign_cost_identity_unsupported');
  await refuses((c) => { c.manifest.surface = 'frontier-screen'; }, 'campaign_consumer_not_qualified');
});

test('the signed envelope verifies through the runner\'s trust profile and nothing else does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-evaluator-'));
  try {
    const c = copy();
    const key = generateEvaluatorKey();
    const { profile, payload } = await writeSignedReceipt({ ...c, dir, now: NOW, key });
    const attest = await signedEvaluatorReceipt(profile, () => NOW);
    const answered = await attest(c.request);
    assert.deepEqual({ ...answered, signatureDigest: undefined }, { ...payload, signatureDigest: undefined });
    assert.match(answered.signatureDigest, /^[a-f0-9]{64}$/);
    // The receipt is bound to the request: any field it was not made for is refused.
    for (const field of Object.keys(c.request)) {
      await assert.rejects(attest({ ...c.request, [field]: field === 'look' ? 2 : 'changed' }), { message: 'campaign_evaluator_receipt_binding_changed' }, field);
    }
    // After its expiry the receipt cannot be used, and a fresh load refuses it.
    let clock = NOW;
    const aging = await signedEvaluatorReceipt(profile, () => clock);
    assert.equal((await aging(c.request)).type, 'rsi-evaluator-receipt-v1');
    clock = new Date(Date.parse(payload.expiresAt) + 1000).toISOString();
    await assert.rejects(aging(c.request), { message: 'campaign_evaluator_receipt_expired' });
    await assert.rejects(signedEvaluatorReceipt(profile, () => payload.expiresAt), { message: 'campaign_evaluator_receipt_expired' });
    // Tampered payload, a different signer and a profile pinned to another key.
    const envelope = JSON.parse(await readFile(profile.receiptPath, 'utf8'));
    await writeFile(profile.receiptPath, JSON.stringify({ ...envelope, payload: { ...envelope.payload, observationDigest: 'f'.repeat(64) } }));
    await assert.rejects(signedEvaluatorReceipt(profile, () => NOW), { message: 'campaign_evaluator_signature_invalid' });
    const attacker = generateEvaluatorKey();
    await writeFile(profile.receiptPath, JSON.stringify(signEnvelope(envelope.payload, attacker.privateKey)));
    await assert.rejects(signedEvaluatorReceipt(profile, () => NOW), { message: 'campaign_evaluator_signature_invalid' });
    await assert.rejects(signedEvaluatorReceipt({ ...profile, publicKeySha256: attacker.publicKeySha256 }, () => NOW), { message: 'campaign_evaluator_key_untrusted' });
    await assert.rejects(signedEvaluatorReceipt({ ...profile, publicKeySha256: 'nothex' }, () => NOW), { message: 'campaign_evaluator_profile_invalid' });
    await assert.rejects(signedEvaluatorReceipt({ ...profile, privateKeyPath: '/etc/key' }, () => NOW), { message: 'campaign_evaluator_profile_invalid' });
    await assert.rejects(signedEvaluatorReceipt(null, () => NOW), { message: 'campaign_evaluator_profile_invalid' });
    await writeFile(profile.receiptPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await assert.rejects(signedEvaluatorReceipt(profile, () => NOW), { message: 'campaign_evaluator_receipt_oversized' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the evaluator key is an Ed25519 key identified by its public SPKI digest, and an envelope signs the canonical payload', () => {
  const { privateKey, publicKey, publicKeySha256 } = generateEvaluatorKey();
  const loaded = evaluatorKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(loaded.publicKeySha256, publicKeySha256);
  assert.equal(createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), publicKeySha256);
  const payload = { b: 2, a: 1, nested: { z: [1, 2], y: null } };
  const envelope = signEnvelope(payload, loaded.key);
  assert.equal(verify(null, Buffer.from(canonicalRsiJson({ a: 1, b: 2, nested: { y: null, z: [1, 2] } })), publicKey, Buffer.from(envelope.signature, 'base64')), true, 'key order does not matter');
  assert.equal(verify(null, Buffer.from(canonicalRsiJson({ ...payload, a: 9 })), publicKey, Buffer.from(envelope.signature, 'base64')), false);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => evaluatorKey(rsa), { message: 'campaign_evaluator_key_invalid' });
  assert.throws(() => evaluatorKey('not a key'));
});

test('the procedure qualification is the statistics report for the claim, lapsing 180 days after it was generated', async () => {
  const report = procedureReport({ generatedAt: '2026-10-20T00:00:00Z' });
  const procedure = report.development.procedure;
  const q = procedureQualification(report, { claim: 'superiority', procedure, consumerDigest: 'c'.repeat(64) });
  assert.deepEqual([q.status, q.claims, q.evidenceScope, q.consumerDigest], ['qualified', ['superiority'], 'population-task-family', 'c'.repeat(64)]);
  assert.equal(q.procedureDigest, rsiDigest(procedure));
  assert.equal(q.expiresAt, '2027-04-18T00:00:00.000Z');
  assert.equal(q.qualificationId, `statistics-qualification:${rsiDigest(report).slice(0, 16)}`);
  assert.deepEqual(procedureQualification(report, { claim: 'superiority', procedure, consumerDigest: 'c'.repeat(64) }), q, 'deterministic, so an owner can pin its digest');
  const refuse = (mutate, options = {}) => {
    const r = procedureReport({ generatedAt: '2026-10-20T00:00:00Z' });
    mutate(r);
    assert.throws(() => procedureQualification(r, { claim: 'superiority', procedure, consumerDigest: 'c', ...options }), { message: 'campaign_procedure_not_qualified' });
  };
  refuse((r) => { r.qualification_passed = false; });
  refuse((r) => { delete r.generatedAt; });
  refuse((r) => { r.generatedAt = 'yesterday'; });
  refuse((r) => { r.development.scenarios = [{ claim: 'efficiency' }]; });
  refuse((r) => { r.development.procedure = { ...r.development.procedure, minimum_slice_groups: 5 }; });
  refuse(() => {}, { claim: 'efficiency' });
  refuse(() => {}, { procedure: { ...procedure, test_alpha_fraction: 0.9 } });
  assert.throws(() => procedureQualification(null, { claim: 'superiority', procedure, consumerDigest: 'c' }), { message: 'campaign_procedure_not_qualified' });
  // A scenario in the held-back set counts as well.
  const held = procedureReport({ generatedAt: '2026-10-20T00:00:00Z' });
  held.held_back.scenarios = held.development.scenarios;
  held.development.scenarios = [];
  assert.equal(procedureQualification(held, { claim: 'superiority', procedure, consumerDigest: 'c' }).status, 'qualified');
});

test('the digests an owner pins are those the finalizer evidence will carry', async () => {
  const report = procedureReport({ generatedAt: '2026-10-20T00:00:00Z' });
  const closure = await computeRsiDependencyClosure({ rootDir: root, surface: 'frontier-selection', settings: { model: 'deepseek-flash', provider: 'deepseek' } });
  assert.equal(closure.qualified, true);
  const pinned = await qualificationDigests(report, { claim: 'superiority', rootDir: root });
  const q = procedureQualification(report, { claim: 'superiority', procedure: report.development.procedure, consumerDigest: closure.dependencyDigest });
  assert.deepEqual(pinned, { procedureDigest: rsiDigest(report.development.procedure), qualificationDigest: rsiDigest(q), consumerDigest: closure.dependencyDigest, expiresAt: q.expiresAt });
  await assert.rejects(qualificationDigests({ ...report, qualification_passed: false }, { claim: 'superiority', rootDir: root }), { message: 'campaign_procedure_not_qualified' });
  await assert.rejects(qualificationDigests(report, { claim: 'superiority', rootDir: '/nonexistent-root' }), (error) => error instanceof Error);
});

test('finalizer evidence is only written for a campaign whose statistics qualified', async () => {
  const c = copy();
  await assert.rejects(finalizerEvidencePayload({ manifest: c.manifest, inputs: c.inputs, checkpoint: c.checkpoint, report: procedureReport(), rootDir: root }), { message: 'campaign_statistics_not_qualified' });
  c.checkpoint.evaluation = { decision: 'not-qualified' };
  await assert.rejects(finalizerEvidencePayload({ manifest: c.manifest, inputs: c.inputs, checkpoint: c.checkpoint, report: procedureReport(), rootDir: root }), { message: 'campaign_statistics_not_qualified' });
});

test('the receipt command signs a receipt the runner accepts, and refuses by closed code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-evaluator-cli-'));
  try {
    const c = copy();
    const key = generateEvaluatorKey();
    const files = { manifest: join(dir, 'manifest.json'), inputs: join(dir, 'inputs.json'), request: join(dir, 'request.json'), checkpoint: join(dir, 'checkpoint.json'), key: join(dir, 'key.pem'), out: join(dir, 'receipt.json') };
    await writeFile(files.manifest, JSON.stringify(c.manifest));
    await writeFile(files.inputs, JSON.stringify(c.inputs));
    await writeFile(files.request, JSON.stringify(c.request));
    await writeFile(files.checkpoint, JSON.stringify({ checkpoint: c.checkpoint }), 'utf8');
    await writeFile(files.key, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const run = (args) => execFileAsync(process.execPath, [evaluatorScript, ...args], { cwd: dir, env: { PATH: process.env.PATH } });
    const { stdout } = await run(['receipt', files.manifest, files.inputs, files.request, files.checkpoint, files.key, files.out]);
    const summary = JSON.parse(stdout);
    assert.deepEqual([summary.status, summary.type, summary.publicKeySha256], ['signed', 'rsi-evaluator-receipt-v1', key.publicKeySha256]);
    const profile = { publicKeyPath: join(dir, 'public.pem'), publicKeySha256: key.publicKeySha256, receiptPath: files.out };
    await writeFile(profile.publicKeyPath, key.publicKey.export({ type: 'spki', format: 'pem' }));
    const attest = await signedEvaluatorReceipt(profile, () => new Date().toISOString());
    const answered = await attest(c.request);
    assert.equal(answered.observationDigest, rsiDigest(c.checkpoint.stages.confirmation.result.observations));
    // A bare checkpoint (not wrapped in the runner's result) is read the same way.
    await writeFile(files.checkpoint, JSON.stringify(c.checkpoint));
    assert.equal(JSON.parse((await run(['receipt', files.manifest, files.inputs, files.request, files.checkpoint, files.key, files.out])).stdout).status, 'signed');
    // Refusals exit non-zero with one closed reason on stderr and sign nothing.
    await writeFile(files.request, JSON.stringify({ ...c.request, look: 2 }));
    await writeFile(files.out, '');
    const refused = await run(['receipt', files.manifest, files.inputs, files.request, files.checkpoint, files.key, files.out]).catch((error) => error);
    assert.equal(refused.code, 1);
    assert.deepEqual(JSON.parse(refused.stderr), { status: 'refused', reason: 'campaign_evaluator_repeated_look' });
    assert.equal(await readFile(files.out, 'utf8'), '');
    const missing = await run(['receipt', join(dir, 'absent.json'), files.inputs, files.request, files.checkpoint, files.key, files.out]).catch((error) => error);
    assert.deepEqual(JSON.parse(missing.stderr), { status: 'refused', reason: 'campaign_evaluator_failed' }, 'an unexpected failure names no path');
    const usage = await run(['bogus']).catch((error) => error);
    assert.equal(usage.code, 1);
    assert.equal(JSON.parse(usage.stderr).reason, 'campaign_evaluator_failed');
    // The month's report is signed whatever the verdict, over its own digest.
    const reportPath = join(dir, 'report.json'), signedPath = join(dir, 'signed-report.json');
    const report = { campaign: c.manifest.id, status: 'not-qualified', reason: 'campaign_no_improving_candidate' };
    await writeFile(reportPath, JSON.stringify(report));
    assert.equal(JSON.parse((await run(['report', reportPath, files.key, signedPath])).stdout).reportDigest, rsiDigest(report));
    const signedReport = JSON.parse(await readFile(signedPath, 'utf8'));
    assert.equal(signedReport.payload.type, 'rsi-campaign-report-v1');
    assert.deepEqual(signedReport.payload.report, report);
    assert.equal(verify(null, Buffer.from(canonicalRsiJson(signedReport.payload)), key.publicKey, Buffer.from(signedReport.signature, 'base64')), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
