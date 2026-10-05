// Candidate execution never shares the extension controller that serves tenants' document tools
// (review of 「循证进化」, 2026-10-05, S2). In production the evolution executor used to be the
// ExtensionToolController behind `doc_read`/`doc_write`: every static check, self test and
// hidden-case replicate took one of its two slots and its fail-fast admission lock, and one failed
// or timed-out `docker create` latched its sticky `blocked` flag until the controller restarted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeController } from '../src/runtimeControllerServer.mjs';
import { RuntimeControllerClient } from '../src/runtimeControllerClient.mjs';
import { EVOLUTION_EXECUTION_CODE_MAX_BYTES, createEvolutionVerificationController, verificationRequest } from '../src/evolutionVerificationController.mjs';

const image = 'sha256:' + 'a'.repeat(64);

test('the runtime controller runs candidates on an executor of its own and never touches the document tools controller', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-executor-'));
  const socketPath = path.join(dataDir, 'controller.sock');
  const touched = [];
  // The extension controller as the composition hands it over: anything evolution does to it is recorded.
  const documentTools = new Proxy({ descriptors: new Map(), handlers: () => ({}), close: async () => {} }, {
    get(target, property) { if (!(property in target)) touched.push(String(property)); return target[property]; },
  });
  // A docker daemon that fails every create: what a timed-out or refused `docker create` looks like to the executor.
  const failing = path.join(dataDir, 'docker-fails.sh');
  await fs.writeFile(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const server = createRuntimeController({ dataDir, runtimeControllerSocket: socketPath, runtimeContainerBin: failing, runtimeContainerImage: 'fixture', evolutionEnabled: true },
    { extensionTools: documentTools, evolutionVerification: { imageId: async () => image } });
  try {
    await server.listen();
    const client = new RuntimeControllerClient({ runtimeControllerSocket: socketPath });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(client.execVerify({ files: { 'scripts/x.py': 'value=1' }, code: "print('x')" }), (error) => error.status >= 500 || error.code === 'product_state_unavailable');
    }
    assert.deepEqual(touched, [], 'evolution never reaches into the document tools controller');
    const roots = await fs.readdir(path.join(dataDir, '.openscience'));
    assert.ok(roots.includes('evolution-controller'), 'the executor keeps its reservations under its own root');
    assert.equal(roots.includes('extension-controller'), false, 'and nothing under the document tools');
  } finally { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('the executor has its own slot count and timeout, from deployment settings', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-executor-limits-'));
  try {
    const defaults = createEvolutionVerificationController({ dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: 'fixture' });
    await defaults.close();
    // Out-of-range limits are refused by the executor itself, not silently clamped.
    assert.throws(() => createEvolutionVerificationController({ dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: 'fixture', evolutionExecutionMaxConcurrency: 9 }));
    assert.throws(() => createEvolutionVerificationController({ dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: 'fixture', evolutionExecutionTimeoutMs: 99 }));
    const tuned = createEvolutionVerificationController({ dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: 'fixture', evolutionExecutionMaxConcurrency: 3, evolutionExecutionTimeoutMs: 20000 });
    await tuned.close();
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('a program too large to be one argv string is refused before a container is created', () => {
  // Linux refuses one argv string over 131,072 bytes (E2BIG): a failed `docker create`, which the executor counts as uncertain.
  assert.ok(EVOLUTION_EXECUTION_CODE_MAX_BYTES < 131072 - 4096, 'the bound leaves room for the fixed preamble');
  assert.deepEqual(verificationRequest({ files: {}, code: 'x'.repeat(EVOLUTION_EXECUTION_CODE_MAX_BYTES) }).dependencyIds, []);
  assert.throws(() => verificationRequest({ files: {}, code: 'x'.repeat(EVOLUTION_EXECUTION_CODE_MAX_BYTES + 1) }), (error) => error.code === 'extension_contract_invalid');
  assert.throws(() => verificationRequest({ files: {}, code: 'é'.repeat(EVOLUTION_EXECUTION_CODE_MAX_BYTES / 2 + 1) }), { code: 'extension_contract_invalid' }, 'bytes, not characters');
});

test('the controller reports what its executor did through the admission endpoint the control plane already polls', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-executor-counters-'));
  const socketPath = path.join(dataDir, 'controller.sock');
  const tools = { run: async () => 'verified', admissionAvailable: async () => true };
  const server = createRuntimeController({ dataDir, runtimeControllerSocket: socketPath, runtimeContainerBin: 'docker', runtimeContainerImage: 'fixture', evolutionEnabled: true },
    { evolutionVerification: { tools, imageId: async () => image } });
  try {
    await server.listen();
    const client = new RuntimeControllerClient({ runtimeControllerSocket: socketPath });
    assert.equal((await client.evolutionAdmissionAvailable()).executor.ok, 0);
    await client.execVerify({ files: {}, code: "print('x')" });
    await client.execVerify({ files: {}, code: "print('y')" });
    const answer = await client.evolutionAdmissionAvailable();
    assert.equal(answer.executor.ok, 2);
    assert.deepEqual(Object.keys(answer.executor).sort(), ['canceled', 'candidateFailed', 'dependenciesPrepared', 'dependencyPreparationFailed', 'errored', 'ok', 'timedOut', 'unavailable']);
    assert.equal(typeof answer.available, 'boolean', 'the answer the worker reads is unchanged');
  } finally { await server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
