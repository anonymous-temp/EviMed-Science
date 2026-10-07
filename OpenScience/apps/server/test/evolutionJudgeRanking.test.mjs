import assert from 'node:assert/strict';
import test from 'node:test';
import { EvolutionIntegration, EvolutionFrontierSignals } from '../src/evolutionIntegration.mjs';

const events = Array.from({ length: 10 }, (_, index) => ({ id: `frontier:${index + 1}`, type: 'frontier-publication',
  paper: { id: String(index + 1), identity: `paper:${index + 1}`, title: `Method ${index + 1}`, excerpt: 'Public abstract' } }));
const now = new Date('2026-10-07T12:00:00Z');
function fixture(judgeService) {
  const jobs = [];
  const service = { config: { evolutionDailyBudgetCny: 10, evolutionMaxPaperScoutsPerDay: 8 }, owner: async () => 'operator', now: () => now,
    documents: { database: { query: async sql => ({ rows: sql.includes('count(*)')
      ? [{ scouts: jobs.length, admitted_until: '2026-10-07T13:00:00Z' }] : [] }) } },
    enqueue: async (kind, payload, key, runAfter) => { const job = { kind, payload, key, runAfter }; jobs.push(job); return job; } };
  return { service, jobs, integration: new EvolutionIntegration({ service, autopilot: {}, judgeService }) };
}

test('J17 ranks retained publications before the existing eight-scout cap and admitted work', async () => {
  const calls = [];
  const f = fixture({ judge: async (site, input, context) => { calls.push({ site, input, context });
    return { outcome: 'settled', value: { relevance: Number(input.title.split(' ').at(-1)) / 10 }, model: 'pinned', promptFingerprint: 'fingerprint' }; } });
  const ranked = await f.integration.rankPublications(events);
  assert.equal(ranked.length, events.length, 'ranking never prunes publications');
  assert.deepEqual(ranked.map(event => event.paper.id), ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
  for (const event of ranked) await f.integration.scoutPublication(event);
  assert.equal(f.jobs.length, 8);
  assert.deepEqual(f.jobs.map(job => job.payload.paper.id), ['10', '9', '8', '7', '6', '5', '4', '3']);
  assert.deepEqual(f.jobs.map(job => job.runAfter.getTime()), Array.from({ length: 8 }, (_, index) => Date.parse('2026-10-07T13:00:00Z') + index));
  const leases = [...f.jobs].map((job, index) => ({ ...job, id: String(100 - index) }))
    .sort((left, right) => left.runAfter - right.runAfter || left.id.localeCompare(right.id));
  assert.deepEqual(leases.map(job => job.payload.paper.id), ['10', '9', '8', '7', '6', '5', '4', '3']);
  assert.ok(calls.every(call => call.site === 'J17' && call.context.module === 'evolution' && call.context.limits.moduleDaily === 10));
  assert.ok(ranked.every(event => event.scoutRanking.source === 'judge' && !('capabilityId' in event.scoutRanking)));
  assert.ok(events.every(event => !('scoutRanking' in event)), 'scientific inputs are unchanged');
});

test('unconfigured, uncalibrated, uncertain and failed rankings preserve exact FIFO inputs', async () => {
  for (const result of [{ outcome: 'fallback', code: 'judge_disabled' }, { outcome: 'fallback', code: 'judge_uncalibrated' },
    { outcome: 'fallback', code: 'judge_calibration_mismatch' }, { outcome: 'escalated', value: { relevance: .7 } },
    { outcome: 'settled', value: { relevance: NaN } }]) {
    let calls = 0;
    const f = fixture({ judge: async () => ++calls === 1 ? { outcome: 'settled', value: { relevance: .9 } } : result });
    assert.equal(await f.integration.rankPublications(events), events);
  }
  assert.equal(await fixture(null).integration.rankPublications(events), events);
  assert.equal(await fixture({ judge: async () => { throw new Error('unavailable'); } }).integration.rankPublications(events), events);
});

test('a ranked feed batch checkpoints only its contiguous durable prefix after a failed publication', async () => {
  const rows = events.slice(0, 3).map((event, index) => ({ seq: index + 1, id: event.paper.id, title_raw: event.paper.title, identity_key: event.paper.identity }));
  let savedCursor;
  const service = { get: async () => ({ revision: 1, payload: { sequence: 0 } }), now: () => now,
    save: async (kind, id, payload) => { savedCursor = payload; } };
  const published = [];
  const integration = { rankPublications: async input => [input[2], input[0], input[1]],
    publish: async event => { published.push(event.id); return event.id === 'frontier:1' ? null : { id: event.id }; } };
  const signals = new EvolutionFrontierSignals({ service, integration,
    database: { query: async sql => ({ rows: sql.includes('AS floor') ? [{ floor: 0 }] : rows }) } });
  assert.equal((await signals.tick()).sequence, 0);
  assert.equal(savedCursor, undefined);
  assert.deepEqual(published, ['frontier:3', 'frontier:1']);
});

test('the shared J17 policy stays uncalibrated and restores FIFO before any provider call', async () => {
  const { createJudgeService } = await import('../src/judgeService.mjs');
  const judge = createJudgeService({ config: { typesafeApiKey: 'test-only-password', reviewJevModel: 'jev-1.13.0' },
    callImpl: async () => { throw new Error('An uncalibrated policy must not contact a provider'); } });
  assert.equal(await fixture(judge).integration.rankPublications(events), events);
  assert.equal(judge.status().sites.J17.calibrated, false);
  assert.ok(judge.metrics().some(item => item.site === 'J17' && item.outcome === 'fallback'));
  await judge.close();
});

test('the real event service carries ranked millisecond slots to the queue whose lease orders by run_after and id', async () => {
  const { EvolutionService } = await import('../src/evolutionService.mjs');
  const rows = new Map(), jobs = [];
  const service = new EvolutionService({ ownerId: 'operator', now: () => now,
    documents: { get: async (_owner, _kind, id) => rows.get(id) ?? null,
      put: async (_owner, _kind, id, payload) => { const row = { id, payload, revision: (rows.get(id)?.revision ?? 0) + 1 }; rows.set(id, row); return row; } },
    jobs: { enqueue: async (owner, kind, payload, options) => { const job = { id: String(10 - jobs.length), kind, payload, ...options }; jobs.push(job); return job; } } });
  await service.save('cursor', 'evolution-frontier-cursor', { sequence: 0 });
  const integration = new EvolutionIntegration({ service, autopilot: {}, judgeService: { judge: async (_site, input) => ({ outcome: 'settled', value: { relevance: Number(input.title.split(' ').at(-1)) / 10 } }) } });
  const feed = events.slice(0, 3).map((event, index) => ({ seq: index + 1, id: event.paper.id, title_raw: event.paper.title, identity_key: event.paper.identity }));
  const signals = new EvolutionFrontierSignals({ service, integration, database: { query: async sql => ({ rows: sql.includes('AS floor') ? [{ floor: 0 }] : feed }) } });
  assert.equal((await signals.tick()).sequence, 3);
  const leased = [...jobs].sort((left, right) => left.runAfter - right.runAfter || left.id.localeCompare(right.id));
  assert.deepEqual(leased.map(job => rows.get(job.payload.eventId).payload.paper.id), ['3', '2', '1']);
  assert.deepEqual(jobs.map(job => job.runAfter.getTime()), [now.getTime(), now.getTime() + 1, now.getTime() + 2]);
  assert.ok(jobs.every(job => job.kind === 'evolution-event'));
  await service.ingestEvent({ id: 'other-module', type: 'runtime-gap' });
  assert.equal(jobs.at(-1).runAfter.getTime(), now.getTime(), 'unranked callers keep the original scheduling');
});
