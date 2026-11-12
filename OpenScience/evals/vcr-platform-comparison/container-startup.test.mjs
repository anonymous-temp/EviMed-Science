import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyContainerStartup } from './run.mjs';

test('formal runs require the current isolated, paid container and its host-mapped collection', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-container-receipt-'));
  try {
    const audit = path.join(state, 'audit');
    await fs.mkdir(audit);
    const startupPath = path.join(audit, 'startup.json');
    const hostManifest = path.join(audit, 'collection.json');
    const image = 'sha256:'+'1'.repeat(64);
    const startup = {
      paid: true, closedCorpus: true, corpusProbe: { liveAvailable: false, blockedRegistryFetches: 3, allowedFetches: 0 }, sandboxBackend: 'docker', approvalPolicy: 'never',
      image, instance: 'instance', sourceSha: 'source', kernelVersion: 'pinned',
      collectionManifestHostPath: hostManifest,
      modelCallsHostPath: path.join(state, 'audit', 'model-calls.jsonl'),
      resolvedConfig: {
        runtimeSandboxMode: 'docker', runtimeTransport: 'unix', runtimeDataVolume: 'volume',
        runtimeInternalNetworkName: 'benchmark-network', runtimeNetworkMode: 'benchmark-network',
        allowRuntimeNetworkEgress: false, webReadEnabled: false, webSearchDeepseekEnabled: false, sourceIngestionEnabled: false,
        vcrTrialCorpusManifest: '/audit/collection.json',
      },
    };
    const probe = {
      instance: startup.instance, sourceSha: startup.sourceSha, image, kernelVersion: startup.kernelVersion,
      network: 'benchmark-network', dispatchedPrompts: 0, privileged: false,
      internal: true, workspaceReadWrite: true, forbiddenPathsAbsent: true, directPublicConnectionFailed: true,
      accountDeleted: true, runtimeRemoved: true, budgetUnchanged: true, publicDnsBlocked: true, runtimeSourceBytesMatched: true, gatewayBoundaryVerified: true,
    };
    const probePath = path.join(state, 'probe.json');
    await fs.writeFile(probePath, JSON.stringify(probe));
    assert.equal(await verifyContainerStartup(startup, startupPath), hostManifest);
    await assert.rejects(verifyContainerStartup({ ...startup, sandboxBackend: 'native-seatbelt' }, startupPath), /Docker control plane/);
    await assert.rejects(verifyContainerStartup({ ...startup, paid: false }, startupPath), /Docker control plane/);
    await assert.rejects(verifyContainerStartup({ ...startup, collectionManifestHostPath: '/unrelated' }, startupPath), /host mapping/);
    await assert.rejects(verifyContainerStartup({ ...startup, modelCallsHostPath: '/unrelated' }, startupPath), /host mapping/);
    await assert.rejects(verifyContainerStartup({ ...startup, instance: 'restarted' }, startupPath), /current server instance/i);
    await fs.writeFile(probePath, JSON.stringify({ ...probe, directPublicConnectionFailed: false }));
    await assert.rejects(verifyContainerStartup(startup, startupPath), /isolation probe/);
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
});
