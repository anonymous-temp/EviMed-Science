import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRuntimeLaunchPlan, dshProfileInput, modelGatewayTokenFileName, runtimeDshHome } from '../src/runtimeManager.mjs';

// The matching port authenticates like every runtime gateway, with the model-gateway token. The first production turn
// (2026-11-10) handed the bundle the MCP workload token instead, and every host call answered 401.
test('the matching bundle reads the model-gateway token, the credential its port verifies', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'matching-profile-'));
  try {
    const project = { id: 'p1', userId: 'u1', rootDir: tmp, workspaceDir: path.join(tmp, 'workspace'), runtimeDir: path.join(tmp, 'runtime') };
    const config = {
      runtimeSandboxMode: 'docker', runtimeContainerBin: 'docker', runtimeContainerImage: 'evimed-runtime-dsh:test', runtimeTransport: 'unix', runtimeNetworkMode: 'none',
      runtimeCpuLimit: '1', runtimeMemoryLimit: '1g', runtimePidsLimit: 64, allowRuntimeHostNetwork: false, deepseekProviderEnabled: true, deepseekModel: 'deepseek-v4-pro',
      modelGatewaySigningSecret: 'model-gateway-signing-secret-with-at-least-32-bytes', runtimeSandboxEnforcement: 'full', evimedDisabledTools: '',
      modelGatewayInternalUrl: 'http://open-science-web:8787/internal/model/v1',
    };
    const plan = { ...buildRuntimeLaunchPlan(config, project, 49152), patientMatchingGeneration: { reference: { generationHash: 'g' } } };
    const input = dshProfileInput(config, project, plan, 'deepseek-v4-pro', `${runtimeDshHome}/evimed-workload.token`);
    assert.equal(input.patientMatching.tokenFile, `${runtimeDshHome}/${modelGatewayTokenFileName}`);
    assert.equal(input.patientMatching.tokenFile, input.modelGatewayTokenFile);
    assert.match(input.patientMatching.endpoint, /\/internal\/patient-matching\/v1\/port$/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
