import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';
import { EvolutionWorker } from '../src/evolutionWorker.mjs';
import { EvolutionMaintenance } from '../src/evolutionMaintenance.mjs';
import { EvolutionDecisions } from '../src/evolutionDecisions.mjs';

const paused = () => { const f = evolutionServiceFixture(); f.service.config.evolutionSearchPaused = true; return f; };
test('paused enqueue explicitly defers experimental evaluate and forced build without queue writes', async () => {
  const f = paused();
  for (const [kind, payload] of [['evaluate', { action: 'scorer-audit' }], ['evaluate', {}], ['audit', {}], ['build', {}]]) {
    const result = await f.service.enqueue(kind, payload, `${kind}:${payload.action}`);
    assert.equal(result.code, 'evolution_search_paused'); assert.equal(result.status, 'deferred');
  }
  assert.equal(f.jobs.length, 0);
});
test('paused Monday housekeeping preserves monthly-v2 identity without weekly/quarterly experiments', async () => {
  const f = paused(); f.advance(22 * 86400000);
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config });
  await worker.housekeeping();
  assert.equal(f.jobs.some(job => job.kind === 'evolution-audit' || ['scorer-audit', 'time-holdout'].includes(job.payload.action)), false);
  assert.deepEqual(f.jobs.find(job => job.key === 'evolution:monthly-v2:2026-10').payload, { month: '2026-10', metricsMonth: '2026-09' });
});
test('direct execution cannot bypass pause with a queued evaluate action', async () => {
  const f = paused(); let called = false;
  f.service.tools = async () => [{ id: 'active', payload: { status: 'active' } }];
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, callbacks: { evaluate: () => { called = true; } } });
  const result = await worker.perform({ kind: 'evolution-evaluate', payload: { action: 'scorer-audit' } });
  assert.equal(result.code, 'evolution_search_paused'); assert.equal(called, false);
});
test('release replay is explicitly deferred while paused and never reaches model-capable evaluator', async () => {
  const f = paused(); let called = false;
  f.service.tools = async () => [{ id: 'active', payload: { status: 'active' } }];
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, callbacks: { evaluate: () => { called = true; } } });
  const result = await worker.perform({ kind: 'evolution-evaluate', payload: { action: 'release-replay' } });
  assert.equal(result.status, 'deferred'); assert.equal(result.code, 'evolution_release_replay_deferred'); assert.equal(called, false);
});
test('queued monthly maintenance becomes metrics-only and direct monthly execution cannot call judge', async () => {
  const f = paused(); let received;
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: { monthly: p => { received = p; } }, config: f.service.config });
  await worker.perform({ kind: 'evolution-maintain', payload: { month: '2026-10', metricsMonth: '2026-09' } });
  assert.equal(received.metricsOnly, true);
  const maintenance = new EvolutionMaintenance({ service: f.service, judgeService: { judge: () => { throw new Error('experimental judge called'); } } });
  f.service.tools = () => { throw new Error('experimental tool selection called'); };
  assert.equal((await maintenance.monthly({ month: '2026-10', metricsMonth: '2026-09' })).payload.month, '2026-09');
});
test('late active tool registration is fenced after pause begins', async () => {
  const f = paused();
  await assert.rejects(f.service.registerTool({ id: 'late', track: 'M', status: 'active' }), { code: 'evolution_search_paused' });
  assert.equal(await f.service.get('late'), null);
});
test('paused decision expiry does not buy refresh/review and experimental user action cannot execute', async () => {
  const f = paused(); let called = 0;
  const decisions = new EvolutionDecisions({ service: f.service, config: f.service.config, now: f.service.now, callbacks: { refresh: () => { called++; }, execute: () => { called++; } } });
  const row = await f.service.save('decision', 'pending', { status: 'pending', decisionClass: 'B', deliveredAt: '2026-10-01', dueAt: '2026-10-02', options: [{ id: 'build', operation: 'build' }], recommended: 'build', history: [] });
  assert.equal((await decisions.expire(row.id)).code, 'evolution_search_paused');
  assert.equal((await decisions.execute(row, 'build', 'user')).code, 'evolution_search_paused');
  assert.equal(called, 0);
});
