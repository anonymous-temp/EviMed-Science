import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';
import { createEvolutionMissions, evolutionFailureReproductionHash } from '../src/evolutionMissions.mjs';
import { createEvolutionLoops } from '../src/evolutionLoops.mjs';
import { createEvolutionGrowth } from '../src/evolutionGrowth.mjs';
import { evolutionTriggersCurrent, evolutionSignalTrigger } from '../src/evolutionSignalTriggers.mjs';

test('a frozen trigger stops matching when its summary retires or changes membership at the same count', async () => {
  const { service } = evolutionServiceFixture();
  let summary = await service.save('signal-summary', 'summary', { moduleId: 'geo', kind: 'geo-misconception', generation: 'generation-1', state: 'active', occurrences: 5, distinctAccounts: 5 });
  const payload = { evidenceRoots: [summary.id], triggerRefs: [evolutionSignalTrigger(summary)] };
  assert.equal(await evolutionTriggersCurrent(service, payload), true);
  summary = await service.save('signal-summary', summary.id, { ...summary.payload, generation: 'generation-2' }, summary);
  assert.equal(await evolutionTriggersCurrent(service, payload), false);
  assert.equal(await evolutionTriggersCurrent(service, { evidenceRoots: [summary.id] }), true);
  await service.save('signal-summary', summary.id, { ...summary.payload, state: 'inactive' }, summary);
  assert.equal(await evolutionTriggersCurrent(service, { evidenceRoots: [summary.id] }), false);
});

test('growth pins the public trigger generation without private provenance', async () => {
  const { service } = evolutionServiceFixture(); const offered = [];
  await service.save('signal-summary', 'summary', { moduleId: 'geo', kind: 'geo-misconception', generation: 'opaque', state: 'active', occurrences: 5, distinctAccounts: 5, codes: { capability: 'geo-content' } });
  await createEvolutionGrowth({ service, database: {}, opportunity: async input => offered.push(input) }).collect();
  assert.deepEqual(offered[0].triggerRefs, [{ id: 'summary', generation: 'opaque' }]);
});

test('a resumed mission cannot spend on a withdrawn private trigger before independent public reproduction', async () => {
  const { service } = evolutionServiceFixture(); let calls = 0;
  await service.save('signal-summary', 'summary', { moduleId: 'geo', state: 'inactive', generation: 'new' });
  await service.save('dossier', 'dossier', { evidenceRoots: ['summary'], triggerRefs: [{ id: 'summary', generation: 'old' }] });
  await service.save('mission', 'mission', { moduleId: 'geo', sources: ['repair'], opportunityId: 'dossier', status: 'ready', dependencies: [] });
  const missions = createEvolutionMissions({ service, policy: {}, map: {}, taskPool: {}, signals: {}, config: {}, adapters: {
    geo: { enabled: true, propose: async () => { calls++; return { status: 'unavailable' }; } },
  } });
  const result = await missions.run({ missionId: 'mission' });
  assert.equal(result.payload.status, 'waiting_resource');
  assert.equal(result.payload.reason, 'source-trigger-withdrawn');
  assert.equal(calls, 0);
});

test('withdrawal of a private trigger retains independently reproduced public repair eligibility, but not another baseline', async () => {
  const { service } = evolutionServiceFixture(); let calls = 0;
  const loops = createEvolutionLoops({ service, config: { geoEnabled: true, operatorUsers: [] }, database: { query: async () => ({ rows: [{ cost: 0 }] }) },
    registry: Promise.resolve({ list: () => [] }), model: async () => { calls++; return {
      policy: { supplements: [{ capabilityId: 'geo-content', text: 'Preserve population qualifiers.' }] },
      proposal: { components: ['supplements'], mechanisms: ['population-qualifier'], change: 'Keep qualifiers.', reason: 'Avoid overgeneralization.', predictedBenefits: [], possibleHarms: [], costChange: 0 },
    }; } });
  const baseline = await loops.policies.resolve('geo', { supplements: [] });
  const proof = { basis: 'executed-baseline', missionId: 'public-mission', moduleId: 'geo', baselineHash: createHash('sha256').update(canonicalJson(baseline)).digest('hex'),
    scope: 'public', independent: true, executed: true, baselineFailed: true, referenceVerified: true, taskId: 'public-task', sourceRoot: 'public-source', sourceHash: 'a'.repeat(64), executionReceiptHash: 'b'.repeat(64) };
  await service.save('failure-reproduction', 'receipt', { ...proof, receiptHash: evolutionFailureReproductionHash(proof) });
  await service.save('signal-summary', 'summary', { moduleId: 'geo', kind: 'geo-misconception', state: 'inactive', generation: 'new' });
  await service.save('dossier', 'dossier', { evidenceRoots: ['summary'], triggerRefs: [{ id: 'summary', generation: 'old' }] });
  await service.save('mission', 'public-mission', { moduleId: 'geo', sources: ['repair'], opportunityId: 'dossier', status: 'ready', dependencies: [], baseline,
    failureReproductionReceiptId: 'receipt', round: 2, maxRounds: 10, successConditions: {}, triggerRefs: [{ id: 'summary', generation: 'old' }] });
  const result = await loops.missions.run({ missionId: 'public-mission' });
  assert.equal(result.payload.proposalFeedback.reason, 'candidate-screen', 'the independently executed repair advances to screening, which is still required');
  assert.equal(calls, 2);
  const current = await service.get('public-mission');
  await service.save('mission', current.id, { ...current.payload, baseline: { ...baseline, revisionId: 'different-baseline' } }, current);
  const blocked = await loops.missions.run({ missionId: 'public-mission' });
  assert.equal(blocked.payload.reason, 'source-trigger-withdrawn'); assert.equal(calls, 2);
});
