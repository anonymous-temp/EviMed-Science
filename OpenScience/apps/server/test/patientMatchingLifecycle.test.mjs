import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { createPatientMatchingRoutes } from '../src/patientMatchingRoutes.mjs';
import { PINNED } from '../src/pinnedVersions.mjs';
import { patientMatchingConfiguration } from '../src/patientMatchingConfiguration.mjs';
import { PatientMatchingLifecycleService, PatientMatchingLifecycleWorker, PATIENT_MATCHING_LIFECYCLE_JOB } from '../src/patientMatchingLifecycle.mjs';
import { patientMatchingCatalogue, preparePatientMatchingGeneration, verifyPatientMatchingGeneration, patientMatchingGenerationRoot, PATIENT_MATCHING_TOOLS } from '../src/patientMatchingLifecycleArtifacts.mjs';
import { TOOL_MANIFEST } from '../../../packages/patient-matching-plugin/src/manifest.mjs';
import { patientMatchingWorkerIdentity } from '../src/patientMatchingLifecycleWorkerIdentity.mjs';
import { renderProfilePatch } from '../src/dshProfilePatch.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';

const project = { id: 'project-a', userId: 'owner-a' }, scope = { ownerId: project.userId, projectId: project.id, ownerAccountCreatedAt: 'account-epoch', projectCreatedAt: 'project-epoch' };
const image = `sha256:${'a'.repeat(64)}`;
async function fixture(t, releaseId = 'r1', extra = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'patient-matching-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pack = tar.pack(), chunks = [];
  pack.on('data', chunk => chunks.push(chunk));
  const completed = new Promise(resolve => pack.on('end', resolve));
  for (const [name, content] of [
    ['package/package.json', JSON.stringify({ name: '@evimed/dsh-patient-matching', version: '0.1.0', type: 'module' })],
    ['package/index.mjs', 'export const name = "synthetic-fixture";'], ['package/skills/patient-matching/SKILL.md', '# Synthetic patient matching'],
    ['package/node_modules/@evimed/harness-port/package.json', '{}'], ['package/node_modules/@evimed/patient-matching-core/package.json', '{}'],
  ]) pack.entry({ name }, content);
  for (const entry of extra) pack.entry(entry.header, entry.content ?? '');
  pack.finalize(); await completed;
  const bytes = gzipSync(Buffer.concat(chunks)), artifactPath = path.join(directory, 'plugin.tgz'); await writeFile(artifactPath, bytes);
  const entry = { releaseId, packageName: '@evimed/dsh-patient-matching', packageVersion: '0.1.0', artifactPath,
    artifactIntegrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, artifactDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    workerImageDigest: image, hostAbi: 'patient-matching.host.v1', dshVersion: PINNED.dsh.version, modelProfile: patientMatchingConfiguration({}, {}) };
  return { config: { dataDir: directory }, entry };
}

test('protected catalogue binds the actual artifact, image, ABI, DSH and Flash profile; names agree with native package', async t => {
  const { entry } = await fixture(t);
  assert.equal(patientMatchingCatalogue([entry]).size, 1);
  assert.deepEqual(PATIENT_MATCHING_TOOLS, TOOL_MANIFEST.map(item => item.name));
  for (const changed of [{ hostAbi: 'other' }, { workerImageDigest: 'latest' }, { dshVersion: 'other' }, { modelProfile: { ...entry.modelProfile, proEscalation: true } }, { tools: ['shell'] }]) {
    assert.throws(() => patientMatchingCatalogue([{ ...entry, ...changed }]), { code: 'patient_matching_release_invalid' });
  }
});

test('worker preparation verifies every installed byte, rejects scope substitution and refuses changed artifacts', async t => {
  const { config, entry } = await fixture(t);
  const first = await preparePatientMatchingGeneration(config, project, scope, entry, image);
  assert.deepEqual(await preparePatientMatchingGeneration(config, project, scope, entry, image), first);
  await assert.rejects(verifyPatientMatchingGeneration(config, { ...project, userId: 'other' }, first.reference));
  const code = path.join(patientMatchingGenerationRoot(config, first.reference), 'selected/package/index.mjs');
  await chmod(code, 0o644); await writeFile(code, 'changed'); await chmod(code, 0o444);
  await assert.rejects(verifyPatientMatchingGeneration(config, project, first.reference), { code: 'patient_matching_release_invalid' });
  await writeFile(entry.artifactPath, Buffer.from('corrupt'));
  await assert.rejects(preparePatientMatchingGeneration(config, project, scope, entry, image), { code: 'patient_matching_release_invalid' });
});

test('archives cannot link to host code or escape their fixed package root', async t => {
  for (const header of [{ name: 'package/escape', type: 'symlink', linkname: '/etc/passwd' }, { name: 'package/../escape' }, { name: '/tmp/escape' }]) {
    const { config, entry } = await fixture(t, 'unsafe', [{ header }]);
    await assert.rejects(preparePatientMatchingGeneration(config, project, scope, entry, image));
  }
  const { config, entry } = await fixture(t);
  const link = `${entry.artifactPath}.link`; await symlink(entry.artifactPath, link);
  await assert.rejects(preparePatientMatchingGeneration(config, project, scope, { ...entry, artifactPath: link }, image));
});

async function serviceFixture(t, postgres = null, { warm = true } = {}) {
  const { config, entry } = await fixture(t);
  const rows = new Map(), queued = [], events = [];
  const client = { query: async () => ({ rows: [{ acquired: true }] }) };
  const database = postgres ?? { query: client.query, transaction: async operation => operation(client), withTransactionClient: async (_client, operation) => operation() };
  let epoch = 'runtime-0', busy = false, stopping = false, rejectNext = false, runtimeImage = image;
  const runtime = {
    config: { ...config, runtimeSandboxMode: 'docker' }, key: () => project.id, runtimes: new Map(),
    runtimeGeneration: () => runtime.runtimes.has(project.id) ? epoch : null, currentPatientMatchingGeneration: RuntimeManager.prototype.currentPatientMatchingGeneration,
    idleVerdict: async () => 'idle', activeProxyCountForProject: () => 0,
    stopIdleRuntime: async (target, { guard }) => {
      stopping = true;
      try { return await guard() && runtime.runtimes.delete(target.id); }
      finally { stopping = false; }
    },
    inspectRuntimeImage: async () => ({ imageId: runtimeImage }), pluginRuntimeBusy: async (_project, { ignoreStopping = false } = {}) => busy || (stopping && !ignoreStopping),
    preparePatientMatchingGeneration: RuntimeManager.prototype.preparePatientMatchingGeneration,
    replacePatientMatchingGeneration: async (target, candidate) => {
      if (candidate) await runtime.preparePatientMatchingGeneration(target, candidate);
      const replacedGeneration = runtime.runtimeGeneration();
      runtime.runtimes.set(target.id, { patientMatchingGeneration: candidate, patientMatchingProven: false });
      epoch = `runtime-${events.length + 1}`; events.push(['replace', candidate?.release.releaseId ?? null]);
      return { runtimeGeneration: epoch, replacedGeneration };
    },
    patientMatchingStatus: async () => {
      const tools = rejectNext ? [] : [...PATIENT_MATCHING_TOOLS]; rejectNext = false;
      return { enabled: true, skill: 'patient-matching', tools };
    },
    probePatientMatchingGeneration: async (target, candidate) => {
      events.push(['probe', candidate?.release.releaseId ?? null]);
      return RuntimeManager.prototype.probePatientMatchingGeneration.call(runtime, target, candidate);
    },
  };
  if (warm) runtime.runtimes.set(project.id, { patientMatchingGeneration: null });
  const service = new PatientMatchingLifecycleService(database, { config, catalogue: [entry], access: async (user, id) => { if (user.id !== project.userId || id !== project.id) throw Object.assign(new Error('forbidden'), { status: 403 }); return project; }, runtime,
    workerImageIdentity: async () => image, plugins: { scope: async (_owner, _project, queryable) => { if (typeof queryable?.query !== 'function') throw new TypeError('PluginService.scope reads through a client'); return { accountCreatedAt: scope.ownerAccountCreatedAt, projectCreatedAt: scope.projectCreatedAt }; }, hasPendingPrompts: async () => false }, ledgerBusy: async () => false });
  if (!postgres) service.documents = { get: async (_owner, _kind, id) => rows.get(id) ?? null,
    put: async (_owner, _kind, id, payload, { expectedRevision }) => { const revision = rows.get(id)?.revision ?? 0; assert.equal(revision, expectedRevision); const row = { id, revision: revision + 1, payload: structuredClone(payload) }; rows.set(id, row); return row; } };
  if (!postgres) service.jobs = { get: async (_owner, id) => queued.find(job => job.id === id), enqueue: async (_owner, kind, payload, options) => { const job = { kind, payload, attempts: 1, maxAttempts: options.maxAttempts, id: String(queued.length), userId: project.userId, projectId: options.projectId, leaseToken: 'lease' }; queued.push(job); return job; },
    withLease: async (_owner, _id, _token, operation) => operation(client), renew: async () => true, finish: async (_owner, _id, _token, result) => result, finishWithLease: async (_owner, _id, _token, result, operation) => { await operation(client); return result; }, fail: async (_owner, _id, _token, error, options) => ({ error, ...options }) };
  const worker = new PatientMatchingLifecycleWorker({ service });
  const reconcile = async action => { const state = await service.current(project); return service.reconcile({ id: project.userId }, project.id, { action, releaseId: entry.releaseId, expectedRevision: state?.revision ?? 0 }); };
  return { service, worker, reconcile, queued, events, runtime, entry, setImage: value => { runtimeImage = value; }, busy: value => { busy = value; }, rejectNext: () => { rejectNext = true; } };
}

test('install, idle disable, uninstall and historical immutable identities survive without touching active turns', async t => {
  const f = await serviceFixture(t);
  await f.reconcile('install'); assert.equal(f.events.length, 0, 'HTTP action only queues preparation');
  assert.equal((await f.worker.runClaimed(f.queued.at(-1))).phase, 'effective');
  const manifest = (await f.service.current(project)).payload.effective;
  assert.equal((await f.service.resolveTool(project, 'match_assess')).generation, manifest.reference.generationHash);
  assert.equal(await f.service.resolveTool(project, 'shell'), null);
  await f.reconcile('disable'); f.busy(true);
  const before = f.events.length; assert.equal((await f.worker.runClaimed(f.queued.at(-1))).retry, true); assert.equal(f.events.length, before);
  assert.ok(await f.service.resolveTool(project, 'match_assess'), 'in-flight generation remains valid until idle');
  f.busy(false); assert.equal((await f.worker.runClaimed(f.queued.at(-1))).phase, 'disabled');
  assert.equal(await f.service.resolveTool(project, 'match_assess'), null); assert.equal(await f.service.selectForRuntime(project), null);
  // The state keeps a pointer (no file list, so two of them stay far under a product record's 256 KiB); the files are on disk.
  const { files, ...pointer } = await verifyPatientMatchingGeneration(f.service.config, project, manifest.reference);
  assert.deepEqual(pointer, manifest); assert.equal(manifest.files, undefined); assert.ok(files.length > 0);
  await f.reconcile('uninstall'); assert.equal((await f.worker.runClaimed(f.queued.at(-1))).phase, 'uninstalled');
  await assert.rejects(f.service.reconcile({ id: 'other' }, project.id, { action: 'enable', expectedRevision: 0 }));
});

test('failed candidate proves rollback; stale jobs and runtime substitution cannot publish descriptors', async t => {
  const f = await serviceFixture(t);
  await f.reconcile('install'); await f.worker.runClaimed(f.queued.at(-1));
  const original = (await f.service.current(project)).payload.effective;
  await f.reconcile('enable'); f.rejectNext();
  assert.equal((await f.worker.runClaimed(f.queued.at(-1))).phase, 'rolled-back');
  assert.deepEqual((await f.service.current(project)).payload.effective, original);
  assert.deepEqual(f.events.slice(-4).map(row => row[0]), ['replace', 'probe', 'replace', 'probe']);
  await f.reconcile('disable'); const stale = f.queued.at(-1); await f.reconcile('enable');
  assert.deepEqual(await f.worker.runClaimed(stale), { superseded: true });
  await f.runtime.replacePatientMatchingGeneration(project, null);
  assert.equal(await f.service.resolveTool(project, 'match_assess'), null);
  assert.equal(stale.kind, PATIENT_MATCHING_LIFECYCLE_JOB);
  assert.ok(await readFile(f.entry.artifactPath));
});

test('worker identity requires actual immutable image and containment, independently of catalogue claims', async t => {
  const config = { patientMatchingWorkerContainer: 'matching-worker', patientMatchingWorkerImageDigest: image };
  const observed = { Name: '/matching-worker', Image: image, Id: 'container-id', State: { Running: true }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] } };
  assert.equal(patientMatchingWorkerIdentity(config, observed).imageId, image);
  for (const change of [{ Image: 'latest' }, { State: { Running: false } }, { Name: '/other' },
    ...[{ NetworkMode: 'host' }, { ReadonlyRootfs: false }, { CapDrop: [] }, { SecurityOpt: [] }].map(value => ({ HostConfig: { ...observed.HostConfig, ...value } }))]) {
    assert.throws(() => patientMatchingWorkerIdentity(config, { ...observed, ...change }), { code: 'patient_matching_worker_unavailable' });
  }
  const f = await serviceFixture(t); f.service.workerImageIdentity = async () => `sha256:${'b'.repeat(64)}`;
  await f.reconcile('install'); const outcome = await f.worker.runClaimed(f.queued.at(-1));
  assert.equal(outcome.retry, false); assert.equal(f.events.length, 0);
});

test('launch projection inserts exactly one literal first-party code root and leaves disabled general composition alone', () => {
  const input = { modelGatewayUrl: 'http://gateway/internal/model/v1', model: 'deepseek-flash', contextWindow: 400000,
    sessionsDir: '/runtime/dsh-home/sessions', mcpServerPath: '/opt/evimed/mcp/server.py', mcpEnvironment: {},
    capabilitiesDir: '/opt/evimed/capabilities', capabilitySkillsDir: '/opt/evimed/capability-skills', capsuleMethodsDir: '', capsuleGatewayUrl: '',
    workloadTokenFile: '/runtime/workload-token', bundleVersion: 'test', dshVersion: PINNED.dsh.version,
    limits: { deliveryAttemptLimit: 3, maxSteps: 200, maxTokens: 400000, evidenceStaleMinutes: 10 },
    flags: { hosted: true, askUser: true, review: false, capsule: false, requiredEnforcement: 'full' } };
  const disabled = renderProfilePatch(input);
  assert.doesNotMatch(disabled, /evimed-patient-matching/);
  const enabled = renderProfilePatch({ ...input, patientMatching: { entrypoint: '/opt/evimed/patient-matching/package/index.mjs', endpoint: 'http://gateway/internal/patient-matching/v1/port', tokenFile: '/runtime/workload-token' } });
  assert.match(enabled, /name: '\/opt\/evimed\/patient-matching\/package\/index.mjs'/);
  assert.equal((enabled.match(/id: evimed-patient-matching/g) ?? []).length, 1);
  assert.doesNotMatch(enabled, /!!js|plugin add/);
  assert.throws(() => renderProfilePatch({ ...input, patientMatching: { entrypoint: '/workspace/upload/index.mjs', endpoint: 'http://gateway', tokenFile: '/runtime/workload-token' } }));
});

test('runtime descriptor is unavailable until native registry proof and a changed runtime epoch invalidates that proof', async () => {
  const candidate = { reference: { generationHash: 'generation-a' } }, runtime = { patientMatchingGeneration: candidate, patientMatchingProven: false };
  let epoch = 'runtime-a', observed = { enabled: true, tools: [...PATIENT_MATCHING_TOOLS], skill: 'patient-matching' };
  const fake = { runtimes: new Map([['key', runtime]]), key: () => 'key', runtimeGeneration: () => epoch,
    preparePatientMatchingGeneration: async () => candidate, callKernel: async () => observed, patientMatchingStatus: RuntimeManager.prototype.patientMatchingStatus };
  assert.equal(RuntimeManager.prototype.currentPatientMatchingGeneration.call(fake, project), null);
  assert.equal((await RuntimeManager.prototype.probePatientMatchingGeneration.call(fake, project, candidate)).runtimeGeneration, epoch);
  assert.equal(RuntimeManager.prototype.currentPatientMatchingGeneration.call(fake, project), candidate);
  runtime.patientMatchingProven = false; observed = { ...observed, tools: ['shell'] };
  await assert.rejects(RuntimeManager.prototype.probePatientMatchingGeneration.call(fake, project, candidate), { code: 'patient_matching_probe_failed' });
  assert.equal(RuntimeManager.prototype.currentPatientMatchingGeneration.call(fake, project), null);
  fake.callKernel = async () => { epoch = 'runtime-b'; return { enabled: true, tools: [...PATIENT_MATCHING_TOOLS], skill: 'patient-matching' }; };
  await assert.rejects(RuntimeManager.prototype.probePatientMatchingGeneration.call(fake, project, candidate), { code: 'patient_matching_release_invalid' });
  runtime.patientMatchingGeneration = null; fake.callKernel = async () => { throw new Error('An ordinary runtime has no matching RPC'); };
  assert.equal((await RuntimeManager.prototype.probePatientMatchingGeneration.call(fake, project, null)).reference, null);
});

test('recurring worker serializes claims and close joins its in-flight preparation', async t => {
  const f = await serviceFixture(t);
  let release, claims = 0, settled = false;
  const pending = new Promise(resolve => { release = resolve; });
  f.service.jobs.claim = async () => { claims++; await pending; settled = true; return null; };
  const first = f.worker.tick(), second = f.worker.tick();
  assert.equal(claims, 1);
  const closing = f.worker.close(); assert.equal(settled, false);
  release(); await Promise.all([first, second, closing]); assert.equal(settled, true);
});

test('the default release reaches a project whose owner never chose, once; an owner\'s uninstall and an internal project stand', async t => {
  const f = await serviceFixture(t);
  assert.equal(f.service.defaultReleaseId, f.entry.releaseId, 'unset names the catalogue\'s only release');
  assert.equal(await f.service.ensureDefault(project, { internal: () => true }), false, 'an internal project gets nothing');
  assert.equal(f.queued.length, 0);
  assert.equal(await f.service.ensureDefault(project), true);
  assert.equal(f.queued.length, 1, 'queued as an install, applied by the worker like a chosen one');
  assert.deepEqual((await f.service.current(project)).payload.selected, { releaseId: f.entry.releaseId, enabled: true });
  assert.equal(await f.service.ensureDefault(project), false, 'a second start queues nothing');
  assert.equal((await f.worker.runClaimed(f.queued.at(-1))).phase, 'effective');
  assert.ok(await f.service.selectForRuntime(project), 'the next runtime mounts the proven release');
  await f.reconcile('uninstall'); await f.worker.runClaimed(f.queued.at(-1));
  assert.equal(await f.service.ensureDefault(project), false, 'the owner\'s uninstall stands');
  assert.equal(await f.service.selectForRuntime(project), null);
});

test('the default release can be named or turned off by the deployment', async t => {
  const f = await serviceFixture(t);
  const make = (patientMatchingDefaultRelease) => new PatientMatchingLifecycleService(null, { config: { ...f.service.config, patientMatchingDefaultRelease },
    catalogue: [f.entry], access: f.service.access, runtime: f.runtime, plugins: f.service.plugins, ledgerBusy: f.service.ledgerBusy, workerImageIdentity: f.service.workerImageIdentity });
  assert.equal(make('none').defaultReleaseId, null);
  assert.equal(await make('none').ensureDefault(project), false);
  assert.equal(make(f.entry.releaseId).defaultReleaseId, f.entry.releaseId);
  assert.equal(await make('not-in-catalogue').ensureDefault(project), false, 'a name the catalogue does not hold installs nothing');
});

const nextImage = `sha256:${'b'.repeat(64)}`;
async function statusFromRoute(service) {
  const route = createPatientMatchingRoutes({ store: { ensureSessionUser: async () => ({ user: { id: project.userId } }), assertCsrf: async () => {} },
    access: service.access, lifecycle: service });
  let body;
  await route({ method: 'GET', url: `/api/patient-matching?projectId=${project.id}` },
    { writeHead(code) { assert.equal(code, 200); }, end(value) { body = JSON.parse(value).data; } });
  return body;
}

test('cold starts queue one refresh, wait for idle, and admit only the newly proved tools', async t => {
  const f = await serviceFixture(t);
  await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
  const old = await f.service.selectForRuntime(project);
  f.setImage(nextImage);
  const stale = await statusFromRoute(f.service);
  assert.equal(stale.state, 'stale'); assert.equal(stale.reason, 'patient_matching_runtime_image_changed');
  assert.equal(stale.effective, null);
  assert.equal(f.queued.length, 1, 'reading status has no side effect');
  for (const input of [{ action: 'refresh' }, { action: 'enable', runtimeImageDigest: nextImage }, { action: 'enable', reference: old.reference }]) {
    await assert.rejects(f.service.reconcile({ id: project.userId }, project.id, { ...input, expectedRevision: stale.revision }),
      { code: 'patient_matching_action_invalid' });
  }
  for (let n = 0; n < 3; n++) assert.equal(await f.service.selectForRuntime(project), null);
  assert.equal(f.queued.length, 2);
  assert.equal((await statusFromRoute(f.service)).state, 'refreshing');
  assert.equal(await f.service.ensureDefault(project, { internal: () => true }), false);
  f.busy(true);
  assert.equal((await f.worker.runClaimed(f.queued[1])).refundAttempt, true);
  assert.equal(f.events.length, 2);
  f.busy(false); await f.worker.runClaimed(f.queued[1]);
  const selected = await f.service.selectForRuntime(project);
  assert.equal(selected.runtimeImageDigest, nextImage);
  assert.notEqual(selected.reference.generationHash, old.reference.generationHash);
  assert.deepEqual(selected.tools, PATIENT_MATCHING_TOOLS);
  assert.equal((await statusFromRoute(f.service)).effective.generation, selected.reference.generationHash);
  for (const tool of selected.tools) assert.equal((await f.service.resolveTool(project, tool)).generation, selected.reference.generationHash);
  f.runtime.inspectRuntimeImage = async () => { throw new Error('image unavailable'); };
  assert.equal((await statusFromRoute(f.service)).state, 'unconfirmed');
  assert.equal((await statusFromRoute(f.service)).effective, null);
});

test('an owner disable or uninstall supersedes an image refresh, including one already queued', async t => {
  for (const action of ['disable', 'uninstall']) {
    const f = await serviceFixture(t);
    await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
    f.setImage(nextImage); await f.service.selectForRuntime(project);
    const pending = f.queued[1];
    await f.reconcile(action);
    assert.equal(await f.service.selectForRuntime(project), null);
    assert.deepEqual(await f.worker.runClaimed(pending), { superseded: true });
    await f.worker.runClaimed(f.queued[2]);
    assert.equal(await f.service.selectForRuntime(project), null);
    assert.equal(f.queued.length, 3);
  }
});

test('a failed refresh restores ordinary work and retries the same job with a bounded backoff', async t => {
  const f = await serviceFixture(t);
  await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
  f.setImage(nextImage); await f.service.selectForRuntime(project);
  const job = f.queued.at(-1);
  for (const [index, delay] of [30000, 60000, 0].entries()) {
    job.attempts = index + 1;
    f.rejectNext();
    const outcome = await f.worker.runClaimed(job);
    assert.equal(outcome.delayMs, delay); assert.equal(outcome.retry, delay !== 0);
    const status = await statusFromRoute(f.service);
    assert.equal(status.state, delay ? 'retrying' : 'refresh-failed');
    assert.equal(status.failure, 'patient_matching_probe_failed'); assert.equal(status.effective, null);
    assert.equal(f.runtime.runtimes.get(project.id).patientMatchingGeneration, null);
    assert.equal(f.runtime.runtimes.get(project.id).patientMatchingProven, true, 'ordinary runtime is up');
    assert.equal(await f.service.selectForRuntime(project), null);
    assert.equal(f.queued.length, 2);
  }
  f.setImage(`sha256:${'c'.repeat(64)}`);
  await f.service.selectForRuntime(project);
  assert.equal(f.queued.length, 3, 'a later release gets a fresh retry budget even after rollback to ordinary work');
});

test('preparation failures keep the selected release and ordinary startup available through backoff', async t => {
  const f = await serviceFixture(t);
  await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
  f.setImage(nextImage); await f.service.selectForRuntime(project);
  await f.runtime.replacePatientMatchingGeneration(project, null);
  await writeFile(f.entry.artifactPath, Buffer.from('corrupt'));
  const job = f.queued[1];
  const failure = await f.worker.runClaimed(job);
  assert.equal(failure.retry, true); assert.equal(failure.delayMs, 30000);
  const status = await statusFromRoute(f.service);
  assert.equal(status.selected.releaseId, 'r1'); assert.equal(status.reason, 'patient_matching_release_invalid');
  assert.equal(status.effective, null); assert.equal(status.state, 'retrying');
  assert.equal(await f.service.selectForRuntime(project), null);
  assert.equal(f.queued.length, 2);
});

const pgUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
async function postgresFixture(t, options) {
  const isolated = await createGeoTestDatabase(pgUrl, 'matchingrefresh');
  const db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5000 });
  t.after(async () => { await db.close(); await isolated.drop(); });
  await migrateProductStore(db);
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Owner','development')", [project.userId]);
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Project',10000000)", [project.userId, project.id]);
  return { db, f: await serviceFixture(t, db, options) };
}
test('startup refreshes dormant projects and races cold admission idempotently on PostgreSQL', { skip: !pgUrl && 'An isolated local PostgreSQL is required' }, async t => {
  const { db, f } = await postgresFixture(t);
  await f.reconcile('enable'); await f.worker.tick();
  f.setImage(nextImage); f.busy(true);
  f.worker.start();
  await f.worker.running;
  const queued = (await f.service.current(project)).payload.refresh;
  assert.equal(queued.imageId, nextImage, 'the service starts recovery without a runtime start or a status read');
  await f.worker.close();
  const count = async () => Number((await db.query("SELECT count(*) FROM evimed_product.jobs WHERE payload->>'action'='refresh'")).rows[0].count);
  assert.equal(await count(), 1);
  f.setImage(`sha256:${'c'.repeat(64)}`);
  await Promise.all([f.service.refreshAfterStartup(), f.service.selectForRuntime(project), f.service.selectForRuntime(project)]);
  assert.equal(await count(), 2, 'three concurrent discoveries of a second image queue one job');
  f.busy(false);
  const jobId = (await f.service.current(project)).payload.refresh.jobId;
  f.rejectNext(); await f.worker.tick();
  const retry = await f.service.jobs.get(project.userId, jobId);
  assert.equal(retry.status, 'queued'); assert.equal(retry.attempts, 1);
  assert.ok(Date.parse(retry.runAfter) > Date.now() + 25000);
  assert.equal((await statusFromRoute(f.service)).state, 'retrying');
  await f.worker.tick();
  assert.equal((await f.service.jobs.get(project.userId, jobId)).attempts, 1);
  await db.query('UPDATE evimed_product.jobs SET run_after=now() WHERE id=$1', [jobId]);
  await f.worker.tick();
  assert.equal((await statusFromRoute(f.service)).state, 'effective');
  assert.ok(await f.service.resolveTool(project, 'match_assess'));
  await f.service.refreshAfterStartup(); assert.equal(await count(), 2);
});

test('runtime replacement identifies its own boot even when another start can be joined', async () => {
  const manager = {
    key: () => project.id, runtimes: new Map([[project.id, 'previous']]), patientMatchingGenerationOverrides: new Map(),
    stop: async () => manager.runtimes.delete(project.id), runtimeGeneration: () => manager.runtimes.get(project.id) ?? null, pluginRuntimeBusy: async () => false,
    startAdmitted: async (_project, options) => {
      await options.replaceRuntime();
      return { modelGatewayTokenJti: 'booted' };
    },
  };
  const replace = () => RuntimeManager.prototype.replacePatientMatchingGeneration.call(manager, project, null);
  const created = await replace();
  assert.equal(created.replacedGeneration, 'previous');
  assert.equal(created.runtimeGeneration, 'booted');
  manager.startAdmitted = async () => ({ modelGatewayTokenJti: 'joined' });
  assert.equal((await replace()).runtimeGeneration, null);
  assert.equal(manager.patientMatchingGenerationOverrides.size, 0);
});

test('proof releases a cold project on success, rollback or failure and preserves a warm project', async t => {
  for (const [warm, outcome] of [[false, 'effective'], [false, 'rolled-back'], [false, 'failed'], [true, 'effective']]) {
    const f = await serviceFixture(t, null, { warm });
    await f.reconcile('install');
    if (outcome === 'rolled-back') f.rejectNext();
    if (outcome === 'failed') f.runtime.probePatientMatchingGeneration = async () => { throw new Error('probe unavailable'); };
    await f.worker.runClaimed(f.queued[0]);
    assert.equal((await statusFromRoute(f.service)).state, outcome);
    assert.equal(f.runtime.runtimes.has(project.id), warm, outcome);
    if (outcome === 'effective') assert.equal((await f.service.selectForRuntime(project)).release.releaseId, f.entry.releaseId);
  }
});

test('work arriving during proof or a changed runtime keeps the project running', async t => {
  for (const fact of ['running', 'native', 'ledger', 'prompt', 'connection', 'replacement', 'prompt-at-stop']) {
    const f = await serviceFixture(t, null, { warm: false });
    const probe = f.runtime.probePatientMatchingGeneration;
    f.runtime.probePatientMatchingGeneration = async (...args) => {
      const result = await probe(...args);
      if (fact === 'running') f.runtime.idleVerdict = async () => 'working';
      if (fact === 'native') f.busy(true);
      if (fact === 'ledger') f.service.ledgerBusy = async () => true;
      if (fact === 'prompt') f.service.plugins.hasPendingPrompts = async () => true;
      if (fact === 'connection') f.runtime.activeProxyCountForProject = () => 1;
      return result;
    };
    if (fact === 'prompt-at-stop') {
      const stop = f.runtime.stopIdleRuntime;
      f.runtime.stopIdleRuntime = (...args) => {
        f.service.plugins.hasPendingPrompts = async () => true;
        return stop(...args);
      };
    }
    if (fact === 'replacement') {
      const finish = f.worker.jobs.finishWithLease;
      f.worker.jobs.finishWithLease = async (...args) => {
        const result = await finish(...args);
        await f.runtime.replacePatientMatchingGeneration(project, null);
        return result;
      };
    }
    await f.reconcile('enable');
    assert.equal((await f.worker.runClaimed(f.queued[0])).phase, 'effective', fact);
    assert.ok(f.runtime.runtimeGeneration(project), fact);
  }
});

test('a failed proof-runtime stop leaves the proved selection and successful job intact', async t => {
  const f = await serviceFixture(t, null, { warm: false });
  let stops = 0;
  f.runtime.stopIdleRuntime = async () => { stops++; throw new Error('stop failed'); };
  await f.reconcile('install');
  assert.equal((await f.worker.runClaimed(f.queued[0])).phase, 'effective');
  assert.equal(stops, 1);
  assert.equal((await statusFromRoute(f.service)).failure, null);
  assert.ok(await f.service.selectForRuntime(project));
});

function withdrawRelease(f, defaultReleaseId = 'r2') {
  f.service.catalogue.delete(f.entry.releaseId);
  f.service.catalogue.set('r2', { ...f.entry, releaseId: 'r2' });
  f.service.defaultReleaseId = defaultReleaseId;
}

test('cold admission migrates a withdrawn release on the same image and proves the default at idle', async t => {
  const f = await serviceFixture(t, null, { warm: false });
  await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
  withdrawRelease(f);
  const stale = await statusFromRoute(f.service);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.effective, null);
  assert.equal(stale.reason, 'patient_matching_release_unavailable');
  assert.equal(await f.service.selectForRuntime(project), null);
  const pending = await statusFromRoute(f.service);
  assert.deepEqual(pending.selected, { releaseId: 'r2', enabled: true, upgradedFrom: 'r1' });
  assert.equal(pending.state, 'refreshing');
  assert.equal(pending.effective, null);
  f.busy(true);
  assert.equal((await f.worker.runClaimed(f.queued[1])).refundAttempt, true);
  f.busy(false); f.rejectNext();
  assert.equal((await f.worker.runClaimed(f.queued[1])).delayMs, 30000);
  assert.equal((await statusFromRoute(f.service)).state, 'retrying');
  assert.equal(f.runtime.runtimeGeneration(project), null, 'ordinary rollback also releases the proof slot');
  f.queued[1].attempts++;
  await f.worker.runClaimed(f.queued[1]);
  const status = await statusFromRoute(f.service);
  assert.equal(status.state, 'effective');
  assert.equal(status.effective.releaseId, 'r2');
  assert.equal(status.selected.upgradedFrom, 'r1');
  assert.equal(f.runtime.runtimeGeneration(project), null);
  assert.equal((await f.service.selectForRuntime(project)).release.releaseId, 'r2');
  assert.equal(f.queued.length, 2);
});

test('a withdrawn release without an available default stays failed across images without requeueing', async t => {
  for (const catalogueEmpty of [true, false]) {
    const f = await serviceFixture(t);
    await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
    f.setImage(nextImage); await f.service.selectForRuntime(project);
    withdrawRelease(f, null);
    if (catalogueEmpty) f.service.catalogue.clear();
    assert.equal((await f.worker.runClaimed(f.queued[1])).retry, false);
    f.setImage(image);
    for (let i = 0; i < 2; i++) assert.equal(await f.service.selectForRuntime(project), null);
    const status = await statusFromRoute(f.service);
    assert.equal(status.state, 'refresh-failed');
    assert.equal(status.reason, 'patient_matching_release_unavailable');
    assert.equal(status.effective, null);
    assert.equal(f.queued.length, 2);
  }
});

test('withdrawal preserves explicit disable and uninstall', async t => {
  for (const action of ['disable', 'uninstall']) {
    const f = await serviceFixture(t);
    await f.reconcile('enable'); await f.worker.runClaimed(f.queued[0]);
    await f.reconcile(action); await f.worker.runClaimed(f.queued[1]);
    const before = await f.service.current(project);
    withdrawRelease(f);
    assert.equal(await f.service.selectForRuntime(project), null);
    assert.deepEqual(await f.service.current(project), before);
    assert.equal(f.queued.length, 2);
  }
});

test('startup migrates an exhausted withdrawn selection once, including concurrent discovery', { skip: !pgUrl }, async t => {
  const { db, f } = await postgresFixture(t, { warm: false });
  await f.reconcile('enable'); await f.worker.tick();
  const row = await f.service.current(project);
  withdrawRelease(f);
  const failed = { ...row.payload, phase: 'refresh-failed', effective: null,
    refresh: { imageId: image, jobId: 'exhausted' }, failure: 'patient_matching_release_unavailable' };
  const seed = revision => f.service.documents.put(project.userId, 'patient-matching-lifecycle', row.id, failed,
    { projectId: project.id, expectedRevision: revision });
  await seed(row.revision);
  await f.service.refreshAfterStartup();
  assert.equal((await statusFromRoute(f.service)).selected.upgradedFrom, 'r1');
  await f.worker.tick();
  const restored = await statusFromRoute(f.service);
  assert.equal(restored.state, 'effective');
  assert.equal(f.runtime.runtimeGeneration(project), null);
  await seed(restored.revision);
  await Promise.all([f.service.refreshAfterStartup(), f.service.selectForRuntime(project), f.service.selectForRuntime(project)]);
  assert.equal((await db.query("SELECT count(*) FROM evimed_product.jobs WHERE payload->>'action'='refresh'")).rows[0].count, '2');
  await f.worker.tick();
  const effective = await statusFromRoute(f.service);
  assert.equal(effective.effective.releaseId, 'r2');
  await seed(effective.revision);
  f.service.defaultReleaseId = null;
  f.setImage(nextImage);
  await Promise.all([f.service.refreshAfterStartup(), f.service.selectForRuntime(project)]);
  assert.equal((await statusFromRoute(f.service)).state, 'refresh-failed');
  assert.equal((await f.service.current(project)).revision, effective.revision + 1);
});
