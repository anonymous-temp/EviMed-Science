import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareContextGeneration } from '../src/runtimeContextGeneration.mjs';

const load = () => import('../src/runtimeSourceStorageController.mjs');
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-controller-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const project = { userId: 'owner', id: 'project', runtimeDir: path.join(dataDir, 'users/owner/projects/project/runtime') };
  await fs.mkdir(path.join(project.runtimeDir, 'container-runtime/dsh-home/sessions'), { recursive: true });
  await fs.mkdir(path.join(project.runtimeDir, 'container-runtime/dsh-home/storages'));
  return { config: { dataDir, dshVersion: 'test-pin', runtimeContainerBin: 'docker', runtimeContainerImage: 'pinned:test' }, project };
}
const incarnation = { ownerCreatedAt: '2026-11-05 00:00:00.123456+00', projectCreatedAt: '2026-11-05 00:00:01.654321+00' };
const root = { id: 'a', version: 4, createdAt: 1, cwd: '/workspace', isSeeded: false, delegationDepth: 0 };

test('capture freezes path-free identity; purge refuses any extant kernel and a changed storage proof', async t => {
  const { createSourceStorageController } = await load(); const f = await fixture(t); let state = 'running'; const calls = [];
  const service = createSourceStorageController(f.config, {
    inspectImage: async () => ({ imageId: 'sha256:pinned', kernelVersion: 'test-pin', kernel: 'dsh' }),
    runtimeStatus: async () => ({ state }),
    execute: async input => { calls.push(input); return input.operation === 'capture' ? { root, sessions: [root] } : { sourceRemoved: true, removedSessionIds: ['a'] }; },
  });
  const frozen = await service.capture(f.project, { sessionId: 'a', contextReference: null, incarnation });
  assert.equal(frozen.schema, 'native-source-storage/1'); assert.doesNotMatch(JSON.stringify(frozen), new RegExp(f.config.dataDir));
  await assert.rejects(service.purge(f.project, frozen), { code: 'runtime_source_busy' });
  state = 'exited'; await assert.rejects(service.purge(f.project, frozen), { code: 'runtime_source_busy' });
  state = 'missing'; await assert.rejects(service.purge(f.project, { ...frozen, storageIdentity: 'forged' }), { code: 'runtime_source_identity_changed' });
  assert.equal((await service.purge(f.project, frozen)).sourceRemoved, true);
  assert.equal(calls.filter(call => call.operation === 'purge').length, 1);
});

test('helper mounts only source/cache roots, has no network or provider settings, and uses the inspected immutable image', async t => {
  const { sourceStorageHelperPlan } = await load(); const f = await fixture(t);
  const sessions = path.join(f.project.runtimeDir, 'container-runtime/dsh-home/sessions'); const storages = path.join(f.project.runtimeDir, 'container-runtime/dsh-home/storages');
  const plan = sourceStorageHelperPlan(f.config, { imageId: 'sha256:immutable' }, { sessions, storages }, 'purge');
  assert.deepEqual(plan.args.slice(0, 2), ['run', '--rm']);
  assert.ok(plan.args.includes('--read-only')); assert.ok(plan.args.includes('--network=none')); assert.ok(plan.args.includes('--cap-drop=ALL'));
  assert.ok(plan.args.includes('sha256:immutable')); assert.equal(plan.args.filter(value => value.startsWith('type=bind,')).length, 2);
  assert.doesNotMatch(JSON.stringify({...plan,args:plan.args.slice(0,plan.args.indexOf('--eval'))}), /docker\.sock|secrets|provider|gateway|--privileged/i);
  const capture = sourceStorageHelperPlan(f.config, { imageId: 'sha256:immutable' }, { sessions, storages }, 'capture');
  assert.ok(capture.args.filter(value => value.startsWith('type=bind,')).every(value => value.endsWith(',readonly')));
});

test('image mismatch and arbitrary context/path fields never reach a storage helper', async t => {
  const { createSourceStorageController } = await load(); const f = await fixture(t); let calls = 0;
  const service = createSourceStorageController(f.config, { inspectImage: async () => ({ imageId: 'sha256:x', kernelVersion: 'different' }), runtimeStatus: async () => ({ state: 'missing' }), execute: async () => { calls++; } });
  await assert.rejects(service.capture(f.project, { sessionId: 'a', incarnation, contextReference: null }), { code: 'runtime_source_kernel_mismatch' });
  await assert.rejects(service.capture(f.project, { sessionId: 'a', incarnation, contextReference: { path: '/tmp/foreign' } }));
  assert.equal(calls, 0);
});

async function shared(f, revision = 1, createdAt = incarnation.ownerCreatedAt) {
  const policy = { kind: 'geo-project', ownerId: f.project.userId, controlProjectId: f.project.id, ownerCreatedAt: createdAt,
    projectCreatedAt: incarnation.projectCreatedAt, policyVersion: 1, revision, referenceId: `policy-${revision}`, namespace: { id: `namespace-${revision}` } };
  const generation = await prepareContextGeneration(f.config, f.project, policy, async () => ({ identities: [] }));
  await fs.mkdir(path.join(generation.stateDirectory, 'dsh-home/sessions'), { recursive: true });
  await fs.mkdir(path.join(generation.stateDirectory, 'dsh-home/storages'));
  return generation;
}

test('a copy materialized after capture keeps its original identity and late IDs after an interrupted purge', async t => {
  const { createSourceStorageController } = await load(), f = await fixture(t), generation = await shared(f);
  let ordinaryPresent = true, sharedPresent = false, interrupted = false;
  const late = { ...root, id: 'late', origin: 'subagent', parentSession: root.id };
  const service = createSourceStorageController(f.config, {
    inspectImage: async () => ({ imageId: 'sha256:pinned', kernelVersion: 'test-pin', kernel: 'dsh' }), runtimeStatus: async () => ({ state: 'missing' }),
    execute: async input => {
      const historical = input.paths.sessions?.startsWith(generation.stateDirectory);
      if (input.operation === 'capture') return historical ? sharedPresent ? { root, sessions: [root, late] } : { root: { id: 'a', absent: true }, sessions: [{ id: 'a', absent: true }] }
        : ordinaryPresent ? { root, sessions: [root] } : { root: { id: 'a', absent: true }, sessions: [{ id: 'a', absent: true }] };
      assert.equal(input.frozen.root.absent, undefined);
      if (!historical) { ordinaryPresent = false; return { sourceRemoved: true, removedSessionIds: ['a'] }; }
      sharedPresent = false;
      if (!interrupted) { interrupted = true; throw new Error('injected half-cache failure'); }
      return { sourceRemoved: true, removedSessionIds: ['a', 'late'] };
    },
  });
  const frozen = await service.capture(f.project, { sessionId: 'a', contextReference: null, incarnation });
  assert.equal(frozen.sessions.find(row => row.id === 'a').absent, undefined);
  assert.equal(frozen.copies.find(copy => copy.contextReference)?.memoryNamespaceId, 'namespace-1');
  sharedPresent = true;
  await assert.rejects(service.purge(f.project, frozen), /injected/);
  assert.deepEqual((await service.purge(f.project, frozen)).removedSessionIds, ['a', 'late']);
  await fs.rm(generation.directory, { recursive: true });
  await assert.rejects(service.purge(f.project, frozen), { code: 'runtime_context_unverified' });
});

test('a supplied context from another owner incarnation is refused at microsecond precision', async t => {
  const { createSourceStorageController } = await load(), f = await fixture(t);
  const generation = await shared(f, 1, '2026-11-05 00:00:00.123457+00'); let calls = 0;
  const service = createSourceStorageController(f.config, { inspectImage: async () => ({ imageId: 'sha256:pinned', kernelVersion: 'test-pin' }), runtimeStatus: async () => ({ state: 'missing' }), execute: async () => { calls++; return { root, sessions: [root] }; } });
  await assert.rejects(service.capture(f.project, { sessionId: 'a', contextReference: generation.reference, incarnation }), { code: 'runtime_source_identity_changed' });
  assert.equal(calls, 0);
});
