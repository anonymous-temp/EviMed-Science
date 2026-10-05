// A published tool with dependencies keeps working after the runtime image changes (review of
// 「循证进化」, 2026-10-05, S6). The prepared set is keyed by the image's identity, so every release
// that changes the image leaves it unprepared; only the build path ever prepared, and the tenant
// gateway's execute failed with a raw ENOENT (a 500) until something else prepared again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEvolutionVerificationController } from '../src/evolutionVerificationController.mjs';

const wheel = Buffer.from('wheel-bytes');
const entry = { id: 'numpy', version: '1', digest: `sha256:${createHash('sha256').update(wheel).digest('hex')}`, filename: 'numpy-1.whl', url: 'https://files.pythonhosted.org/packages/numpy-1.whl' };
const request = { id: entry.id, version: entry.version, digest: entry.digest };

async function fixture(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-reprepare-'));
  const state = { image: 'sha256:' + 'a'.repeat(64), acquisitions: 0, executions: [], failAcquisition: false };
  const tools = {
    reconcileEvolutionAttempts: async () => {},
    async run(_descriptor, _identity, plan) {
      if (plan.network === 'bridge') {
        state.acquisitions += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (state.failAcquisition) throw new Error('network down');
        return JSON.stringify([{ filename: entry.filename, content: wheel.toString('base64') }]);
      }
      state.executions.push(Object.keys(plan.dependencyFiles ?? {}));
      return 'ok';
    },
  };
  const controller = createEvolutionVerificationController({ dataDir, evolutionEnabled: true, evolutionDependencyAllowlist: [entry] }, { tools, imageId: async () => state.image });
  try { await run({ controller, state }); } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
}
const execute = (controller) => controller.execute({ files: { 'scripts/x.py': 'value=1' }, code: 'print(1)', dependencyIds: [request] });

test('after a runtime image change the first call prepares the dependencies again, once, and then runs', async () => {
  await fixture(async ({ controller, state }) => {
    await controller.prepareDependencies({ requests: [request] });
    assert.equal((await execute(controller)).ok, true);
    assert.equal(state.acquisitions, 1, 'nothing is fetched again while the image is unchanged');
    state.image = 'sha256:' + 'b'.repeat(64);
    assert.equal((await execute(controller)).ok, true, 'a release changed the image identity: the call still runs');
    assert.equal(state.acquisitions, 2);
    assert.deepEqual(state.executions.at(-1), ['numpy-1.whl'], 'with exactly the admitted wheel');
    assert.equal((await execute(controller)).ok, true);
    assert.equal(state.acquisitions, 2, 'prepared once per image');
  });
});

test('concurrent callers after an image change join one acquisition', async () => {
  await fixture(async ({ controller, state }) => {
    state.image = 'sha256:' + 'c'.repeat(64);
    const results = await Promise.all([execute(controller), execute(controller), execute(controller)]);
    assert.ok(results.every((result) => result.ok === true));
    assert.equal(state.acquisitions, 1);
  });
});

test('an acquisition that cannot be done is a named retryable refusal, never a raw ENOENT', async () => {
  await fixture(async ({ controller, state }) => {
    state.failAcquisition = true;
    state.image = 'sha256:' + 'd'.repeat(64);
    await assert.rejects(execute(controller), (error) => error.status === 503 && error.code === 'evolution_execution_unavailable');
    state.failAcquisition = false;
    assert.equal((await execute(controller)).ok, true, 'and the next call prepares');
  });
});

test('a dependency outside the deployment allowlist is still refused, and nothing is fetched', async () => {
  await fixture(async ({ controller, state }) => {
    await assert.rejects(controller.execute({ files: {}, code: '', dependencyIds: [{ ...request, id: 'unlisted' }] }), (error) => error.code === 'extension_contract_invalid');
    assert.equal(state.acquisitions, 0);
  });
});
