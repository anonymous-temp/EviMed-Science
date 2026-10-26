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

test('empty release replay completes without asserting a passed certificate', async () => {
  const f = paused();
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config });
  const result = await worker.perform({ kind: 'evolution-evaluate', payload: { action: 'release-replay' } });
  assert.equal(result.status, 'complete'); assert.deepEqual(result.results, []); assert.equal(result.allPassed, null);
});
test('forced kind and canResume cannot override action-aware pause admission', async () => {
  const f = paused(); f.service.config.evolutionEnabled = true;
  let checked = false, resumed = false;
  f.service.jobs.claim = async (_kinds, _worker, options) => {
    assert.equal(options.eligibility, 'evolution-serving');
    const accepted = await options.candidateAdmission({}, { kind: 'evolution-evaluate', payload: { action: 'time-holdout' } });
    assert.equal(accepted, false); checked = true; return null;
  };
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, lane: 'heavy', callbacks: { canResume: () => { resumed = true; return true; } } });
  assert.equal(await worker.tick({ kinds: ['evolution-evaluate'] }), null);
  assert.equal(checked, true); assert.equal(resumed, false);
});
test('pause does not execute a conservative decision before delivery or its due time', async () => {
  const f = paused(); let called = false;
  const decisions = new EvolutionDecisions({ service: f.service, config: f.service.config, now: f.service.now, callbacks: { execute: () => { called = true; } } });
  const row = await f.service.save('decision', 'future', { status: 'pending', dueAt: '2026-11-01', deliveredAt: '2026-10-01', conservative: 'keep', options: [{ id: 'keep', operation: 'keep' }] });
  assert.equal((await decisions.expire(row.id)).id, row.id); assert.equal(called, false);
});
test('queued experimental event is deferred without dispatching its consumer', async () => {
  const f = paused(); let called = false;
  await f.service.save('event', 'prospective', { type: 'prospective-target-result', status: 'queued' });
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, callbacks: { onEvent: () => { called = true; } } });
  assert.equal((await worker.perform({ kind: 'evolution-event', payload: { eventId: 'prospective' } })).status, 'deferred');
  assert.equal(called, false); assert.equal((await f.service.get('prospective')).payload.status, 'queued');
});

test('deferred decision stays a retryable worker result instead of successful completion', async () => {
  const f = paused();
  const worker = new EvolutionWorker({ service: f.service, decisions: { expire: async () => ({ status: 'deferred', code: 'evolution_search_paused' }) }, maintenance: {}, config: f.service.config });
  assert.equal((await worker.perform({ kind: 'evolution-decision', payload: { decisionId: 'd' } })).status, 'deferred');
});
test('paused release replay admission requires no runtime or paid budget and bypasses no experimental action', async () => {
  const f = paused(); f.service.config.evolutionEnabled = true;
  f.service.jobs.claim = async (_kinds, _worker, options) => {
    const client = { query: async () => ({ rows: [{ count: 0 }] }) };
    assert.equal(await options.admission(client), true);
    assert.equal(await options.candidateAdmission(client, { kind: 'evolution-evaluate', payload: { action: 'release-replay' } }), true);
    return null;
  };
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, lane: 'heavy' });
  assert.equal(await worker.tick({ kinds: ['evolution-evaluate'] }), null);
});
