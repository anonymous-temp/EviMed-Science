import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  assert.doesNotMatch(JSON.stringify(plan), /docker\.sock|secrets|provider|gateway|--privileged/i);
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
