import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvolutionToolWakeAcceptance, assertEvolutionWakeEpisode } from '../../../scripts/ops/evolution-tool-wake-acceptance.mjs';
test('terminal wake episodes without actual tool success fail immediately rather than waiting', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) assert.throws(() => assertEvolutionWakeEpisode([{ status }], false), /no successful substantive/);
  assert.doesNotThrow(() => assertEvolutionWakeEpisode([{ status: 'running' }], false));
  assert.doesNotThrow(() => assertEvolutionWakeEpisode([{ status: 'succeeded' }], true));
});
test('tool wake fixture cannot execute by import/default flag or against ordinary deployments', async () => {
  await assert.rejects(runEvolutionToolWakeAcceptance({ app: {} }), /Explicit isolated/);
  await assert.rejects(runEvolutionToolWakeAcceptance({ app: { config: { dataDir: '/production', databaseUrl: 'ordinary' } }, execute: true }));
  await assert.rejects(runEvolutionToolWakeAcceptance({ app: { config: { dataDir: '/acceptance', databaseUrl: 'ordinary' } }, execute: true }));
});

test('completed checkpoint resumes without agenda creation, evaluation, publication or worker calls', async () => {
  const completed = { kind: 'tool-publication-wake-engineering-fixture', runId: 'actual-recorded', newlyDevelopedTool: false };
  const app = { config: { dataDir: '/acceptance', databaseUrl: 'evimed_test_evolution' }, evolution: { service: { get: async id => id === 'source' ? { id, payload: { methodId: 'decision-net-benefit', validationLevel: 'V2', capabilityIds: ['dataset-research-scoping'], artifactDigest: 'digest', revision: 1 } } : { payload: { completed } } }, supply: { candidateForEvaluation: async () => ({}) } }, store: { userById: async () => ({ id: 'owner' }), projectFor: async () => ({ id: 'project' }) } };
  assert.deepEqual(await runEvolutionToolWakeAcceptance({ app, sourceToolId: 'source', ownerId: 'owner', publicInput: {}, execute: true }), completed);
  app.evolution.service.get = async () => ({ id: 'source', payload: { methodId: 'diagnostic-posterior', validationLevel: 'V2', capabilityIds: ['statistical-analysis'] } });
  await assert.rejects(runEvolutionToolWakeAcceptance({ app, sourceToolId: 'source', execute: true }), /episode capability/);
});
