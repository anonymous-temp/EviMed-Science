import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createEvolutionConfiguration } from '../../../scripts/ops/evolution-acceptance-config.mjs';
import { validateEvolutionConfiguration } from '../src/evolutionConfiguration.mjs';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

test('operator Compose deployments forward trusted peers to every API and controller evolution process', async () => {
  const root=new URL('../../../',import.meta.url);
  for(const file of ['deploy/web/docker-compose.yml','deploy/web/docker-compose.api-only.yml']){
    const document=YAML.parse(await readFile(new URL(file,root),'utf8'));
    const services=Object.values(document.services).filter(service=>service.environment?.OPEN_SCIENCE_EVOLUTION_ENABLED);
    assert.ok(services.length>0);
    for(const service of services){
      assert.equal(service.environment.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS,'${OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS:-[]}');
      assert.equal(service.environment.OPEN_SCIENCE_EVOLUTION_EVALUATION_NETWORK,'${OPEN_SCIENCE_EVOLUTION_EVALUATION_NETWORK:-}');
    }
  }
  assert.match(await readFile(new URL('deploy/web/.env.example',root),'utf8'),/^OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS=\[\]$/m);
});

test('dedicated evaluation network is explicit, optional and validated without changing the ordinary network', () => {
  const name='OPEN_SCIENCE_EVOLUTION_EVALUATION_NETWORK',previous=process.env[name];delete process.env[name];
  try{
    const baseline=loadConfig({localAutoConfig:false});assert.equal(baseline.evolutionEvaluationNetwork,'');
    const overrides=createEvolutionConfiguration({network:'ordinary-network',evolutionEvaluationNetwork:'isolated-evaluation'},{ });
    const configured=loadConfig(overrides);assert.equal(configured.evolutionEvaluationNetwork,'isolated-evaluation');assert.equal(configured.runtimeNetworkMode,'ordinary-network');
    process.env[name]='operator-isolated';assert.equal(loadConfig({localAutoConfig:false}).evolutionEvaluationNetwork,'operator-isolated');
    for(const value of ['../network','network with spaces','',null,42]){
      const issues=validateEvolutionConfiguration({evolutionEvaluationNetwork:value});
      assert.equal(issues.some(issue=>issue.key==='evolutionEvaluationNetwork'),value!=='');
    }
  }finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
});

test('isolated nonproduction acceptance explicitly enables the actual upload and tool-wake episode worker', () => {
  const overrides = createEvolutionConfiguration({ dataDir: '/acceptance', databaseUrl: 'postgresql://localhost/evimed_test_evolution', runtimeImage: 'acceptance-fixture', volume: 'acceptance-fixture', network: 'acceptance-fixture', evaluationDataDir: '/control-eval' }, { password: 'test-only-password', modelSecret: 'test-only-model-secret', workloadSecret: 'test-only-workload-secret' });
  const config = loadConfig(overrides);
  assert.equal(config.production, false);
  assert.equal(config.autopilotEnabled, true);
  assert.equal(config.evolutionEnabled, true);
  assert.equal(config.sourceIngestionEnabled, true);
  assert.equal(config.dataSemanticsEnabled, true);
  assert.equal(overrides.sourceUnderstandingEnabled, false);
  assert.equal(config.learningEnabled, false);
});

test('egress peers require explicit immutable Docker identities and remain unconfigured by default', () => {
  const original = process.env.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS;
  delete process.env.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS;
  try {
    assert.deepEqual(loadConfig({ production: false, localAutoConfig: false }).runtimeEgressAllowedPeers, []);
    const peer = { containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` };
    const overrides = createEvolutionConfiguration({ egressAllowedPeers: [peer] }, {});
    assert.deepEqual(loadConfig(overrides).runtimeEgressAllowedPeers, [peer]);
    process.env.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS = JSON.stringify([peer]);
    assert.deepEqual(loadConfig({ localAutoConfig: false }).runtimeEgressAllowedPeers, [peer]);
    for (const invalid of [{}, [peer, peer], [{ ...peer, containerId: 'web-name' }], [{ ...peer, imageId: 'image:latest' }], [{ ...peer, privileged: false }]]) {
      assert.throws(() => loadConfig({ runtimeEgressAllowedPeers: invalid, localAutoConfig: false }), /EGRESS_ALLOWED_PEERS/);
    }
  } finally {
    if (original === undefined) delete process.env.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS;
    else process.env.OPEN_SCIENCE_RUNTIME_EGRESS_ALLOWED_PEERS = original;
  }
});
