import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
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

async function serviceFixture(t) {
  const { config, entry } = await fixture(t);
  const rows = new Map(), queued = [], events = [];
  const client = { query: async () => ({ rows: [{ acquired: true }] }) };
  const database = { transaction: async operation => operation(client), withTransactionClient: async (_client, operation) => operation() };
  let active = null, epoch = 'runtime-0', busy = false, rejectNext = false;
  const runtime = {
    runtimeGeneration: () => epoch, currentPatientMatchingGeneration: () => active, inspectRuntimeImage: async () => ({ imageId: image }), pluginRuntimeBusy: async () => busy,
    replacePatientMatchingGeneration: async (_project, candidate) => { active = candidate; epoch = `runtime-${events.length + 1}`; events.push(['replace', candidate?.release.releaseId ?? null]); },
    probePatientMatchingGeneration: async (_project, candidate) => { events.push(['probe', candidate?.release.releaseId ?? null]); if (rejectNext) { rejectNext = false; throw Object.assign(new Error('probe'), { code: 'synthetic_probe_failed' }); } return { runtimeGeneration: epoch, reference: candidate?.reference ?? null }; },
  };
  const service = new PatientMatchingLifecycleService(database, { config, catalogue: [entry], access: async (user, id) => { if (user.id !== project.userId || id !== project.id) throw Object.assign(new Error('forbidden'), { status: 403 }); return project; }, runtime,
    workerImageIdentity: async () => image, plugins: { scope: async () => ({ accountCreatedAt: scope.ownerAccountCreatedAt, projectCreatedAt: scope.projectCreatedAt }), hasPendingPrompts: async () => false }, ledgerBusy: async () => false });
  service.documents = { get: async (_owner, _kind, id) => rows.get(id) ?? null,
    put: async (_owner, _kind, id, payload, { expectedRevision }) => { const revision = rows.get(id)?.revision ?? 0; assert.equal(revision, expectedRevision); const row = { id, revision: revision + 1, payload: structuredClone(payload) }; rows.set(id, row); return row; } };
  service.jobs = { enqueue: async (_owner, kind, payload, options) => { const job = { kind, payload, id: String(queued.length), userId: project.userId, projectId: options.projectId, leaseToken: 'lease' }; queued.push(job); return job; },
    withLease: async (_owner, _id, _token, operation) => operation(client), renew: async () => true, finish: async (_owner, _id, _token, result) => result, finishWithLease: async (_owner, _id, _token, result, operation) => { await operation(client); return result; }, fail: async (_owner, _id, _token, error, options) => ({ error, ...options }) };
  const worker = new PatientMatchingLifecycleWorker({ service });
  const reconcile = async action => { const state = await service.current(project); return service.reconcile({ id: project.userId }, project.id, { action, releaseId: entry.releaseId, expectedRevision: state?.revision ?? 0 }); };
  return { service, worker, reconcile, queued, events, runtime, entry, busy: value => { busy = value; }, rejectNext: () => { rejectNext = true; } };
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
  assert.deepEqual(await verifyPatientMatchingGeneration(f.service.config, project, manifest.reference), manifest);
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
    preparePatientMatchingGeneration: async () => candidate, callKernel: async () => observed };
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
