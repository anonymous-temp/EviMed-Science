/** Unit tests verify refusal and evidence handling; they are NOT measured SaaS outcomes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWebApiApp } from '../../../apps/server/src/server.mjs';
import { createGeoTestDatabase } from '../../../apps/server/test/helpers/geoTestDatabase.mjs';
import { ProductJobs } from '../../../apps/server/src/productJobs.mjs';
import { assertCompletionFixture, assertQueuedRevocationRetention, assertCompletionPreparationFixture, countStudyRoleJobs, prepareCompletionStudy, scanBoundedCanaryFiles, summarizeAttributedUsage, COMPLETION_REMAINING, COMPLETION_FIXTURE_OVERRIDES } from '../extension-saas-acceptance-completion.mjs';

test('supplemental controls refuse substitute app/state before any mutation and retain explicit unmeasured controls', async () => {
  await assert.rejects(assertCompletionFixture({ app: { config: { runtimeMode: 'kernel', dataDir: '/tmp/fake' } }, state: { root: '/tmp/fake' } }), /completion_real_app_required/);
  assert.deepEqual(COMPLETION_FIXTURE_OVERRIDES, { vcrEnabled: true, vcrAudience: 'all' });
  assert.equal(Object.isFrozen(COMPLETION_FIXTURE_OVERRIDES), true);
  assert.equal(Object.isFrozen(COMPLETION_REMAINING), true);
  assert.ok(COMPLETION_REMAINING.some(item => item.startsWith('SAAS-19')));
  assert.ok(COMPLETION_REMAINING.some(item => item.startsWith('SAAS-21')));
});

async function scanFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'completion-scan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'library'); await fs.mkdir(library, { mode: 0o700 });
  return { root, library, canary: 'synthetic-only-canary-' + 'a'.repeat(16) };
}

test('bounded actual file scan detects plaintext but emits only relative names and digests', async t => {
  const fixture = await scanFixture(t);
  await fs.writeFile(path.join(fixture.library, 'metadata.json'), JSON.stringify({ value: fixture.canary }));
  const scan = await scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library] });
  assert.equal(scan.files, 1); assert.equal(scan.matches.length, 1);
  assert.equal(scan.matches[0].path, path.join('library', 'metadata.json'));
  assert.match(scan.matches[0].contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(scan).includes(fixture.canary), false);
});

test('overlapping scan roots do not duplicate evidence and symlinks are recorded without reading foreign bytes', async t => {
  const fixture = await scanFixture(t);
  await fs.writeFile(path.join(fixture.library, 'one.txt'), 'allowed');
  await fs.symlink('/etc/passwd', path.join(fixture.library, 'foreign'));
  const scan = await scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, fixture.library] });
  assert.equal(scan.files, 1); assert.equal(scan.matches.length, 0); assert.equal(scan.skippedSymlinks.length, 1);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: ['/etc'] }), /completion_scan_scope_refused/);
});

test('scan bounds are shared across roots and reject invalid canaries or limits instead of declaring a partial success', async t => {
  const fixture = await scanFixture(t), second = path.join(fixture.root, 'cache');
  await fs.mkdir(second); await fs.writeFile(path.join(fixture.library, 'one.txt'), '12345'); await fs.writeFile(path.join(second, 'two.txt'), '12345');
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, second], maxBytes: 9 }), /completion_scan_unbounded/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, second], maxFiles: 1 }), /completion_scan_unbounded/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], canary: 'short' }), /completion_canary_refused/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], maxBytes: Infinity }), /completion_scan_limit_refused/);
});

test('empty directories and foreign symlinks consume the entry budget; deep empty trees refuse before unbounded recursion', async t => {
  const fixture = await scanFixture(t);
  await fs.mkdir(path.join(fixture.library, 'one'));
  await fs.mkdir(path.join(fixture.library, 'two'));
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], maxEntries: 2 }), /completion_scan_unbounded/);
  const deep = path.join(fixture.root, 'deep'); await fs.mkdir(path.join(deep, 'a', 'b'), { recursive: true });
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [deep], maxDepth: 2 }), /completion_scan_unbounded/);
  const links = path.join(fixture.root, 'links'); await fs.mkdir(links);
  await fs.symlink('/etc/passwd', path.join(links, 'one')); await fs.symlink('/etc/passwd', path.join(links, 'two'));
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: 2 }), /completion_scan_unbounded/);
  const result = await scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: 3 });
  assert.equal(result.entries, 3); assert.equal(result.files, 0); assert.equal(result.bytes, 0); assert.equal(result.skippedSymlinks.length, 2);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: Infinity }), /completion_scan_limit_refused/);
});

const scopes = [
  { userId: 'alice', projectId: 'default', runId: 'run-a', runKeys: ['run-a', 'dispatch-a'] },
  { userId: 'bob', projectId: 'default', runId: 'run-b', runKeys: ['run-b'] },
];
const row = (id, userId, runId) => ({ id, user_id: userId, project_id: 'default', run_id: runId, status: 'settled', revision: 2,
  request_fingerprint: 'a'.repeat(64), provider_request_id: 'controlled-provider-id', settled_at: '2026-10-03T00:00:00Z' });

test('usage summarizer scopes owner-local duplicate project names by actual caller and accepts native dispatch aliases', () => {
  const result = summarizeAttributedUsage([row('one', 'alice', 'run-a'), row('two', 'alice', 'dispatch-a'), row('three', 'bob', 'run-b')], scopes);
  assert.equal(result[0].requests, 2); assert.equal(result[1].requests, 1);
  assert.equal(result[0].userId, 'alice'); assert.equal(result[1].userId, 'bob');
  assert.equal(JSON.stringify(result).includes('controlled-provider-id'), false);
  assert.equal(Object.hasOwn(result[0], 'status'), false); assert.equal(Object.hasOwn(result[0], 'qualified'), false);
});

test('usage refuses wrong caller, unsettled requests, duplicate request IDs and unrelated scopes', () => {
  const valid = [row('one', 'alice', 'run-a'), row('two', 'bob', 'run-b')];
  for (const bad of [
    [{ ...valid[0], user_id: 'bob' }, valid[1]],
    [{ ...valid[0], status: 'reserved' }, valid[1]],
    [valid[0], { ...valid[1], id: 'one' }],
    [valid[0], valid[1], row('extra', 'outsider', 'foreign-run')],
    [{ ...valid[0], request_fingerprint: 'fake' }, valid[1]],
  ]) assert.throws(() => summarizeAttributedUsage(bad, scopes), /completion_/);
  assert.throws(() => summarizeAttributedUsage(valid, [scopes[0], scopes[0]]), /completion_two_usage_actors_required/);
});


test('real mock pre-sign preparation seeds actual study roles while measurements refuse mock and counters include null-project viewer jobs',
  { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, timeout: 30000 }, async () => {
    const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'completionprep');
    const repository = fileURLToPath(new URL('../../../../', import.meta.url));
    const parent = path.join(repository, '.evimed-local/extensions/build/fixtures'); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const root = path.join(parent, 'extension-saas-' + randomUUID()); await fs.mkdir(root, { mode: 0o700 });
    const descriptor = { id: 'completion-fixture', title: 'Synthetic fixture', coordinate: { kind: 'npm', name: 'completion-fixture', version: '1.0.0' },
      executionClass: 'isolated-tool', integrity: 'sha256:' + 'a'.repeat(64), artifactDigest: 'sha256:' + 'b'.repeat(64) };
    const image = 'sha256:' + 'c'.repeat(64); let app;
    try {
      app = createWebApiApp({ dataDir: root, stateStore: 'postgres', databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 1000,
        runtimeMode: 'mock', runtimeContainerImage: image, port: 0, devAuth: false, localAutoConfig: false, selfRegistrationEnabled: true,
        bootstrapUser: 'completion-bootstrap', bootstrapPassword: 'synthetic fixture password only', deepseekProviderEnabled: false,
        learningEnabled: false, reviewEnabled: false, frontierEnabled: false, geoEnabled: false, vcrEnabled: true, vcrAudience: 'all', extensionCatalogue: [descriptor] });
      const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
      const actors = [];
      for (const name of ['owner', 'lead', 'viewer', 'data', 'site']) {
        const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'completion-' + name, name, password: 'synthetic fixture password only', warm: false }) });
        assert.equal(response.status, 201); actors.push({ user: (await response.json()).data.user });
      }
      const state = { root, databaseName: isolated.name, descriptor, overrides: { runtimeContainerImage: image } }, context = { app, state };
      assert.equal(app.hostedExtensions, null);
      assert.equal(await assertCompletionPreparationFixture(context), isolated.name);
      await assert.rejects(assertCompletionFixture(context), /completion_real_app_required/);
      await assert.rejects(assertCompletionPreparationFixture({ app, state: { ...state, databaseName: 'evimed_test_foreign' } }), /completion_database_refused/);
      await assert.rejects(assertCompletionPreparationFixture({ app, state: { ...state, root: root + '-foreign' } }), /completion_real_preparation_app_required/);
      await assert.rejects(assertCompletionPreparationFixture({ app, state: { ...state, descriptor: { ...descriptor, integrity: 'sha256:' + 'd'.repeat(64) } } }), /completion_artifact_refused/);
      const [owner, lead, viewer, dataManager, site] = actors;
      const fixture = await prepareCompletionStudy({ app, state, owner, lead, viewer, dataManager, site });
      const project = await app.store.requireProject(await app.store.userById(owner.user.id), fixture.projectId);
      const users = await Promise.all(actors.map(actor => app.store.userById(actor.user.id)));
      assert.equal((await app.vcr.store.getStudy(owner.user.id, fixture.studyId)).projectId, project.id);
      assert.deepEqual((await app.vcr.dataStore.membershipAuthority(fixture.studyId, lead.user.id)).roles, ['lead']);
      assert.deepEqual((await app.vcr.dataStore.membershipAuthority(fixture.studyId, viewer.user.id)).roles, ['viewer']);
      assert.equal(await countStudyRoleJobs(app.store.database, project, users), 0);
      const jobs = new ProductJobs(app.store.database);
      await jobs.enqueue(viewer.user.id, 'extension-prepare', { projectTarget: { ownerId: owner.user.id, projectId: project.id } }, { idempotencyKey: 'counter-viewer-null-project' });
      const oldCount = (await app.store.database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE project_id=$1 AND user_id=$2 AND kind IN ('extension-prepare','plugin-apply')", [project.id, project.userId])).rows[0].n;
      assert.equal(oldCount, 0, 'The old owner/project counter misses the actual actor-owned preparation job');
      assert.equal(await countStudyRoleJobs(app.store.database, project, users), 1);
      await jobs.enqueue(owner.user.id, 'plugin-apply', {}, { idempotencyKey: 'counter-owner-apply', projectId: project.id });
      assert.equal(await countStudyRoleJobs(app.store.database, project, users), 2);
      await app.store.createProject(users[2], 'another-project', 'Synthetic separate project');
      await jobs.enqueue(viewer.user.id, 'plugin-apply', {}, { idempotencyKey: 'counter-foreign-project', projectId: 'another-project' });
      assert.equal(await countStudyRoleJobs(app.store.database, project, users), 2);
      await assert.rejects(countStudyRoleJobs(app.store.database, project, [users[0], users[0], ...users.slice(2)]), /completion_distinct_actors_required/);
    } finally { await app?.close(); await isolated.drop(); await fs.rm(root, { recursive: true, force: true }); }
  });


test('queued revocation accepts only the same verified effective or an exact stale-epoch private-admission discard witness', () => {
  const previous = { reference: { generationHash: 'old' } }, queued = { id: 'queued', payload: { reference: { generationHash: 'rejected' } } };
  const payload = { phase: 'failed', effective: null, terminalApplyFailure: { jobId: queued.id, reference: queued.payload.reference, preservedRuntime: false } };
  const stale = { code: 'extension_access_denied', beforeEpoch: 'old-member', afterEpoch: 'new-member', previousEpoch: 'old-member' };
  assert.equal(assertQueuedRevocationRetention(previous, { payload: { effective: previous } }, queued, null), 'retained-currently-verifiable');
  assert.equal(assertQueuedRevocationRetention(previous, { payload }, queued, stale), 'discarded-stale-private-admission');
  for (const changed of [
    { ...payload, terminalApplyFailure: null }, { ...payload, phase: 'waiting' },
    { ...payload, terminalApplyFailure: { ...payload.terminalApplyFailure, jobId: 'foreign' } },
    { ...payload, effective: { reference: queued.payload.reference } },
  ]) assert.throws(() => assertQueuedRevocationRetention(previous, { payload: changed }, queued, stale), /completion_/);
  for (const changed of [null, { ...stale, code: 'unrelated' }, { ...stale, previousEpoch: 'foreign' }, { ...stale, afterEpoch: 'old-member' }]) {
    assert.throws(() => assertQueuedRevocationRetention(previous, { payload }, queued, changed), /completion_/);
  }
});
