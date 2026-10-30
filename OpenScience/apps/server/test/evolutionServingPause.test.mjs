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

test('public paused decision choices and delegated/text choices return typed recoverable errors', async () => {
  const f = paused(); let interpreted = false;
  const decisions = new EvolutionDecisions({ service: f.service, config: f.service.config, callbacks: { interpretOverride: () => { interpreted = true; } } });
  const row = await f.service.save('decision', 'public', { status: 'pending', options: [{ id: 'build', operation: 'build' }], recommended: 'build', history: [] });
  for (const input of [{ option: 'build' }, { option: 'build', delegate: true }, { text: 'build', delegate: true }]) {
    await assert.rejects(decisions.resolve(row.id, { expectedRevision: row.revision, ...input }), { code: 'evolution_search_paused', status: 409 });
  }
  assert.equal(interpreted, false); assert.equal((await f.service.get(row.id)).payload.status, 'pending');
});
test('paused dataset wake retains its event until unpause can queue the self-check exactly once', async () => {
  const f = evolutionServiceFixture();
  await f.service.registerTool({ id: 'wake-tool', track: 'M', artifactDigest: 'pin' });
  await f.service.waitFor({ userId: 'alice', projectId: 'a', agendaId: 'agenda', toolId: 'wake-tool', dataRequirements: { schema: { fields: [] } } });
  const event = await f.service.save('event', 'wake-data', { id: 'wake-data', type: 'dataset-ready', userId: 'alice', projectId: 'a', datasetId: 'data', dataset: { semanticsChecksPassed: true }, status: 'queued' }, null, 'alice');
  f.service.config.evolutionSearchPaused = true;
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config });
  const job = { kind: 'evolution-event', payload: { eventId: event.id, eventOwnerId: 'alice' } };
  await assert.rejects(worker.perform(job), { code: 'evolution_search_paused' });
  assert.equal((await f.service.get(event.id, 'alice')).payload.status, 'queued');
  f.service.config.evolutionSearchPaused = false;
  await worker.perform(job); await worker.perform(job);
  assert.equal(f.jobs.filter(job => job.kind === 'evolution-self-check').length, 1);
  assert.equal((await f.service.get(event.id, 'alice')).payload.status, 'processed');
});
test('decision journal retries paused enqueue and old completed deferral without duplicating work', async () => {
  const f = paused(); const action = { actionId: 'flip' };
  const work = () => f.service.enqueue('build', { dossierId: 'd' }, 'flip');
  const first = await f.service.executeDecisionAction(action, work);
  assert.equal(first.status, 'deferred');
  assert.equal((await f.service.get(`evolution-action-${(await import('../src/evolutionService.mjs')).evolutionKey(action.actionId)}`)).payload.status, 'deferred');
  f.service.config.evolutionSearchPaused = false;
  await f.service.executeDecisionAction(action, work); await f.service.executeDecisionAction(action, work);
  assert.equal(f.jobs.length, 1);
  const legacyId = `evolution-action-${(await import('../src/evolutionService.mjs')).evolutionKey('legacy')}`;
  await f.service.save('action', legacyId, { actionId: 'legacy', status: 'complete', result: { status: 'deferred', code: 'evolution_search_paused' } });
  await f.service.executeDecisionAction({ actionId: 'legacy' }, () => f.service.enqueue('build', { dossierId: 'legacy' }, 'legacy'));
  assert.equal(f.jobs.length, 2);
});
test('publication rechecks pause after asynchronous tool lookup', async () => {
  const f = evolutionServiceFixture(); const get = f.service.get.bind(f.service);
  f.service.get = async (...args) => { const result = await get(...args); f.service.config.evolutionSearchPaused = true; return result; };
  await assert.rejects(f.service.registerTool({ id: 'lookup-race', track: 'M' }), { code: 'evolution_search_paused' });
  assert.equal(await get('lookup-race'), null);
});

test('pause arriving during decision record retains action identity and queues build once after resume', async () => {
  const f = evolutionServiceFixture();
  const decisions = new EvolutionDecisions({ service: f.service, config: f.service.config, callbacks: { execute: action => f.service.executeDecisionAction(action, () => f.service.enqueue('build', { dossierId: 'd', decisionActionId: action.actionId }, action.actionId)) } });
  let row = await f.service.save('decision', 'flip-record', { status: 'pending', options: [{ id: 'build', operation: 'build' }], recommended: 'build', history: [] });
  const save = f.service.save.bind(f.service);
  f.service.save = async (...args) => { const result = await save(...args); if (args[0] === 'decision' && args[2].status === 'executing') f.service.config.evolutionSearchPaused = true; return result; };
  assert.equal((await decisions.execute(row, 'build', 'user')).status, 'deferred');
  row = await f.service.get(row.id);
  assert.equal(row.payload.status, 'executing'); const actionId = row.payload.execution.actionId;
  f.service.config.evolutionSearchPaused = false;
  const resumed = await decisions.execute(row, 'build', 'user');
  await f.service.executeDecisionAction({ actionId }, () => { throw new Error('completed action was replayed'); });
  assert.equal(resumed.payload.status, 'executed'); assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].payload.decisionActionId, actionId);
});
test('paused wake failures refund worker attempts and wait an hour without closing the event', async () => {
  const f = paused(); f.service.config.evolutionEnabled = true; let failed;
  f.service.jobs.claim = async () => ({ id: 'event-job', userId: 'operator', leaseToken: 'lease', kind: 'evolution-event', payload: { eventId: 'wake' } });
  f.service.jobs.fail = async (...args) => { failed = args; return { deferred: true }; };
  f.service.jobs.renew = async () => true;
  await f.service.save('event', 'wake', { type: 'dataset-ready', status: 'queued' });
  f.service.resolveWaiters = async () => { throw Object.assign(new Error('paused'), { code: 'evolution_search_paused', status: 409 }); };
  const worker = new EvolutionWorker({ service: f.service, decisions: {}, maintenance: {}, config: f.service.config, lane: 'light' });
  await worker.tick({ kinds: ['evolution-event'] });
  assert.equal(failed[4].refundAttempt, true); assert.equal(failed[4].delayMs, 3600000);
  assert.equal((await f.service.get('wake')).payload.status, 'queued');
});
