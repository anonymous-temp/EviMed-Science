import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createRsiIncidentExports } from '../src/rsiIncidentExports.mjs';
import { PostgresStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRsiTrustRegistry } from '../src/rsiDeploymentAuthority.mjs';
import { RsiCampaignImporter } from '../src/rsiCampaignImporter.mjs';
import { canonicalRsiJson, rsiDigest, signRsiCampaignBundle } from '../src/rsiCampaignBundle.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname)); assert.match(parsed.pathname, /^\/evimed_test[a-z0-9_]*$/); }
const options = { skip: !url && 'Disposable localhost PostgreSQL required' };
async function fixture(operation) {
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 5, databaseConnectionTimeoutMs: 2000 });
  const suffix = randomUUID().replaceAll('-', '');
  const owner = `rsi_online_${suffix}`, foreign = `rsi_foreign_${suffix}`;
  try {
    await migrateProductStore(database);
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'RSI online test','development'),($2,'RSI foreign test','development')", [owner,foreign]);
    await operation({ database, owner, foreign, jobs: new ProductJobs(database), documents: new ProductDocuments(database) });
  } finally { await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])', [[owner,foreign]]); await database.close(); }
}
test('owner-filtered claim skips foreign head and leaves foreign expired/exhausted rows unchanged', options, () => fixture(async ({ database, owner, foreign, jobs }) => {
  const head = await jobs.enqueue(foreign, 'rsi-incident-export', { id: 'foreign' }, { idempotencyKey: 'foreign-head', runAfter: new Date(0) });
  const expired = await jobs.enqueue(foreign, 'rsi-bundle-poll', {}, { idempotencyKey: 'foreign-expired', maxAttempts: 1 });
  await database.query("UPDATE evimed_product.jobs SET status='running',attempts=1,lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [expired.id,randomUUID()]);
  const own = await jobs.enqueue(owner, 'rsi-incident-export', { id: 'own' }, { idempotencyKey: 'own' });
  const before = await database.query('SELECT * FROM evimed_product.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[head.id,expired.id]]);
  const result = await jobs.claim(['rsi-incident-export','rsi-bundle-poll'], 'rsi-worker', { ownerId: owner });
  assert.equal(result.id, own.id);
  const after = await database.query('SELECT * FROM evimed_product.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[head.id,expired.id]]);
  assert.deepEqual(after.rows, before.rows);
}));
test('before-project-delete journal survives source deletion while cloud is unconfigured', options, () => fixture(async ({ database, owner, foreign, jobs, documents }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-delete-'));
  const accounts = new PostgresStore(loadConfig({ dataDir: dir, databaseUrl: url, stateStore: 'postgres', devAuth: true }));
  try {
    const user = await accounts.userById(foreign);
    await accounts.createProject(user, 'source-project', 'Synthetic source');
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'journal-project','RSI journal',1048576)", [owner]);
    const exports = createRsiIncidentExports({ documents, jobs, deploymentOwnerId: owner, deploymentProjectId: 'journal-project', configured: () => false,
      readAuthorizedTranscript: () => assert.fail('read source'), extract: () => assert.fail('model'), putObject: () => assert.fail('cloud'), headObject: () => assert.fail('cloud') });
    const incident = await exports.offer({ userId: foreign, projectId: 'source-project', sourceRunId: 'run', sourceRevision: 'a'.repeat(64), authorizationId: 'agreement' });
    await documents.put(owner, 'knowledge', incident.id, { ...incident.payload, status: 'exported', exportedDigest: 'b'.repeat(64) }, { expectedRevision: incident.revision, projectId: 'journal-project' });
    await accounts.deleteProject(user, 'source-project', { beforeDelete: () => exports.invalidateSource({ userId: foreign, projectId: 'source-project' }) });
    const retained = await documents.get(owner, 'knowledge', incident.id);
    assert.equal(retained.payload.status, 'withdrawal-pending');
    assert.equal(retained.payload.invalidated, true);
    assert.equal((await database.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id='source-project'", [foreign])).rowCount, 0);
    assert.equal((await database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'id'=$2", [owner,incident.id])).rowCount, 2);
  } finally { await accounts.database.close(); await rm(dir, { recursive: true, force: true }); }
}));

test('configured signed trust registry imports new qualified campaign using deployment exposure profile', options, () => fixture(async ({ database, owner }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rsi-configured-import-'));
  try {
    const issuer = generateKeyPairSync('ed25519'), evaluator = generateKeyPairSync('ed25519');
    const publicPem = key => key.export({ type: 'spki', format: 'pem' });
    const h = rsiDigest('qualified evaluator scope'), issuerRef = path.join(dir, 'issuer.json'), evaluatorRef = path.join(dir, 'evaluator.json');
    const profile = { mode: 'shadow', afterShadow: 'global', allowGlobal: true, allowExpansion: true, minExecutions: 200, minDays: 2, maxErrors: 0 };
    await writeFile(issuerRef, JSON.stringify({ keyId: 'issuer', publicKey: publicPem(issuer.publicKey), surfaces: ['frontier-selection'], kinds: ['policy'] }), { mode: 0o600 });
    await writeFile(evaluatorRef, JSON.stringify({ schemaVersion: 1, version: 1, activationPolicies: { 'frontier-selection': profile }, evaluators: [{ keyId: 'evaluator', publicKey: publicPem(evaluator.publicKey), surfaces: ['frontier-selection'], procedureDigests: [h], consumerDigests: [h] }] }), { mode: 0o600 });
    const target = { surface: 'frontier-selection', dependencyDigest: h, baselineRevision: 'baseline' };
    const trust = await createRsiTrustRegistry({ trustedKeyRefs: [issuerRef], evaluatorRegistryRef: evaluatorRef }, { currentTarget: async () => target });
    const files = [{ path: 'policy.json', content: '{"selectionThreshold":4}' }];
    const evidence = Object.fromEntries(['registrationDigest','datasetDigest','measurementDigest','consumerDigest','evaluatorDigest','procedureDigest','qualificationDigest','corpusDigest'].map(name => [name,h]));
    const manifest = { id: 'configured-bundle', campaignId: 'configured-campaign', surface: target.surface, kind: 'policy', target,
      createdAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
      verdict: { status: 'qualified', scope: target.surface, ...evidence, candidateDigest: rsiDigest(files) } };
    const envelope = await signRsiCampaignBundle({ manifest, files, keyId: 'issuer', signer: bytes => sign(null, bytes, issuer.privateKey) });
    const payload = canonicalRsiJson({ schemaVersion: 1, bundleId: manifest.id, campaignId: manifest.campaignId, ...manifest.verdict });
    envelope.evaluatorReceipt = { keyId: 'evaluator', payload, signature: sign(null, Buffer.from(`evimed-rsi-evaluator-v1\nevaluator\n${payload}`), evaluator.privateKey).toString('base64') };
    let installed = null;
    const importer = new RsiCampaignImporter({ database, owner, isBound: trust.isBound, verificationOptions: trust.verificationOptions,
      currentTarget: async () => target, activationPolicy: trust.activationPolicy,
      adapters: { policy: { inspect: async () => installed, publish: async input => { installed = { operationId: input.operationId, candidateDigest: rsiDigest(input.files), phase: input.phase, revision: 'candidate', installed: true }; } } } });
    const imported = await importer.importBundle(envelope);
    assert.equal(imported.state, 'exposed');
    assert.equal(imported.mode, 'shadow');
    assert.equal(imported.policy.allowExpansion, true);
    assert.equal(imported.policy.minExecutions, 200);
    assert.equal(imported.policy.minDays, 2);
    assert.equal(imported.policy.maxErrors, 0);
    await writeFile(evaluatorRef, JSON.stringify({ schemaVersion: 1, version: 2, evaluators: [] }));
    assert.equal((await trust.activationPolicy(manifest)).minExecutions, 200, 'approved registry version is loaded once');
  } finally { await rm(dir, { recursive: true, force: true }); }
}));
