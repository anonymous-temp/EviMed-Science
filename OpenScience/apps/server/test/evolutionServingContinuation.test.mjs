// What production keeps of the evolution module once experiments moved to the offline lab (review of the serving cutover,
// 2026-10-26): an agenda waiting on a dataset still resumes, an unanswered harm alarm still protects, the operators still get
// their digest, retirements and monthly figures, and a card stuck on an experiment can still be settled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evolutionJobQueue, evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
import { createEvolutionServing } from '../src/evolutionServing.mjs';
import { EvolutionDecisions } from '../src/evolutionDecisions.mjs';
import { EvolutionMaintenance } from '../src/evolutionMaintenance.mjs';

const SERVING = { evolutionEnabled: true, evolutionMaxJobAttempts: 3 };
const queue = evolutionJobQueue;
/** Tick until nothing is claimed. @param {any} worker */
async function drain(worker, limit = 30) { for (let index = 0; index < limit; index++) if (!await worker.tick()) return index; throw new Error('the queue did not drain'); }

test('serving housekeeping keeps the digest, retirement completion and metrics-only month, and quarantines at most hourly', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING); f.service.jobs = queue(f);
  let quarantined = 0, reconciled = 0, admitted = null;
  f.service.reconcileQueued = async () => { reconciled++; return { recovered: 0 }; };
  await f.service.save('tool', 'leaving', { track: 'M', status: 'retired', retirement: { reason: 'sequential-harm', state: 'pending' } });
  const retired = [];
  const maintenance = new EvolutionMaintenance({ service: f.service,
    callbacks: { notifyAffected: async (/** @type {any} */ input) => { retired.push(input.toolId); }, monthlyMetrics: async () => ({ funnel: 1 }) } });
  const worker = createEvolutionServingWorker({ service: f.service, integration: {}, decisions: new EvolutionDecisions({ service: f.service }), maintenance, config: f.service.config,
    quarantine: async (admission) => { quarantined++; admitted = admission; return 0; } });
  await drain(worker);
  assert.equal(quarantined, 1, 'on the first poll'); assert.equal(typeof admitted, 'function', 'inside the claim\'s admission');
  assert.ok(reconciled >= 1, 'a lost enqueue of a queued event is recovered');
  assert.deepEqual(f.jobs.map(job => [job.key, job.state]).sort(), [
    ['evolution:daily-digest:2026-10-04', 'succeeded'], ['evolution:retirement:leaving:2026-10-04', 'succeeded'], ['evolution:serving-metrics:2026-09', 'succeeded']]);
  assert.deepEqual(retired, ['leaving']);
  assert.equal((await f.service.get('leaving')).payload.retirement.state, 'complete');
  assert.deepEqual((await f.service.get('evolution-monthly-metrics-2026-09')).payload.metrics, { funnel: 1 });
  assert.equal(f.notices.filter(notice => notice.title === '进化日报').length, 1);
  f.advance(30 * 60_000); await worker.tick(); assert.equal(quarantined, 1, 'not again within the hour');
  f.advance(31 * 60_000); await worker.tick(); assert.equal(quarantined, 2);
  await worker.close();
});

test('a monthly pass queued before cutover keeps its identity and writes the metrics-only month', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING); f.service.jobs = queue(f);
  const months = [];
  await f.service.jobs.enqueue('operator', 'evolution-maintain', { month: '2026-10', metricsMonth: '2026-09' }, { idempotencyKey: 'evolution:monthly-v2:2026-10' });
  // The real maintenance: its only monthly pass reads the ledger through the figures callback, so nothing but the month's record can come of the old payload.
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks: { monthlyMetrics: async (/** @type {string} */ month) => { months.push(month); return { funnel: 1 }; } } });
  const worker = createEvolutionServingWorker({ service: f.service, integration: {}, decisions: new EvolutionDecisions({ service: f.service }), maintenance, config: f.service.config });
  await drain(worker);
  assert.equal(f.jobs.find(job => job.key === 'evolution:monthly-v2:2026-10').state, 'succeeded');
  assert.deepEqual(months, ['2026-09'], 'the month it names, once: serving\'s own catch-up of that month finds the record');
  assert.deepEqual((await f.service.get('evolution-monthly-metrics-2026-09')).payload.metrics, { funnel: 1 });
  assert.deepEqual(f.jobs.filter(job => /^evolution-(scout|build|evaluate|mission)/.test(job.kind)), []);
  await worker.close();
});

test('an unanswered harm review retires the tool restorably in serving and records no override', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'evolution-serving-harm-'));
  try {
    const f = evolutionServiceFixture(); const jobs = queue(f, () => new Date());
    const user = { id: 'operator' };
    const facade = createEvolutionServing({ config: { evolutionEnabled: true, operatorUsers: ['operator'], dataDir, evolutionDecisionTimeoutMs: 0 }, documents: f.documents, jobs,
      database: { query: async () => ({ rows: [] }), transaction: async (/** @type {any} */ fn) => fn({ query: async () => ({ rows: [] }) }) },
      store: { userById: async () => user, projectFor: async () => ({ id: 'evolution' }), requireProject: async () => ({ id: 'p', userId: user.id }) },
      registry: Promise.resolve({ list: () => [] }), runtimeManager: {}, controller: {}, agentRuns: { list: async () => [] }, notifications: f.service.notifications });
    assert.ok(facade);
    const s = facade.service;
    const tool = await s.save('tool', 'flagged', { track: 'M', status: 'active', artifactDigest: 'sha256:'.padEnd(71, 'a'), validationLevel: 'V1',
      usage: { invoked: 4, harm: { state: 'harm', runs: 4, bad: 4, llr: 3, trials: [] }, harmState: 'harm' } });
    await facade.maintenance.proposeHarmReview(tool);
    const [decision] = await s.list('decision');
    assert.equal(decision.payload.decisionClass, 'C'); assert.ok(decision.payload.deliveredAt, 'the card reached the operator');
    await drain(facade.worker);
    const after = await s.get('flagged');
    assert.deepEqual([after.payload.status, after.payload.retirement?.reason, after.payload.retirement?.state], ['retired', 'sequential-harm', 'complete']);
    assert.equal(after.payload.usage.harm.overriddenAt, undefined, 'nobody decided to keep it, so the alarm is not silenced');
    const settled = await s.get(decision.id);
    assert.deepEqual([settled.payload.status, settled.payload.selected, settled.payload.source], ['executed', 'retire', 'conservative']);
    await facade.worker.close();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('a card written with keep as its conservative option still takes the protective one unanswered, and only an operator\'s keep is an override', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING);
  const restored = [];
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks: { notifyAffected: async () => {}, restorePin: async (/** @type {any} */ pin) => { restored.push(pin.id); } } });
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: (/** @type {any} */ action) => maintenance.executeReview(action) } });
  await f.service.save('tool', 'flagged', { track: 'M', status: 'active', artifactDigest: 'digest', usage: { harm: { state: 'harm', reviewId: 'review' }, harmState: 'harm' } });
  await f.service.save('maintenance-review', 'review', { kind: 'sequential-harm', parentToolIds: ['flagged'], status: 'pending' });
  const card = await f.service.save('decision', 'card', { category: 'tool-retire', subjectId: 'review', decisionClass: 'C', status: 'pending', deliveredAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-02T00:00:00Z',
    options: [{ id: 'retire', operation: 'maintenance-retire' }, { id: 'keep', operation: 'keep' }], recommended: 'retire', conservative: 'keep', history: [] });
  const expired = await decisions.expire(card.id);
  assert.equal(expired.payload.selected, 'retire');
  assert.equal((await f.service.get('flagged')).payload.status, 'retired');
  // A keep nobody chose (here a default of the legacy path) restores nothing it was not asked to and silences nothing.
  await maintenance.executeReview({ id: 'card', subjectId: 'review', option: 'keep', source: 'conservative', actionId: 'default-keep' });
  assert.equal((await f.service.get('flagged')).payload.usage.harm.overriddenAt, undefined);
  // The operator's own later answer reverses the retirement and is the override.
  const answered = await decisions.resolve(card.id, { expectedRevision: (await f.service.get(card.id)).revision, option: 'keep' });
  assert.equal(answered.payload.source, 'user');
  const kept = await f.service.get('flagged');
  assert.equal(kept.payload.usage.harmState, 'overridden'); assert.ok(kept.payload.usage.harm.overriddenByActionId);
});

test('a card stuck executing an experiment at cutover is settled by an operator\'s serving answer, closed by request, or closed at expiry', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING);
  const executed = [];
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: async (/** @type {any} */ action) => { executed.push(action.option); return { state: 'waiting' }; } } });
  const stuck = (/** @type {string} */ id) => f.service.save('decision', id, { category: 'implementation', subjectId: id, decisionClass: 'B', status: 'executing',
    execution: { actionId: `${id}:1:go`, option: 'go', source: 'conservative', evidence: {} }, deliveredAt: '2026-10-01T00:00:00Z', dueAt: '2026-10-02T00:00:00Z',
    options: [{ id: 'go', operation: 'build' }, { id: 'hold', operation: 'wait' }], recommended: 'go', conservative: 'hold', history: [] });
  let row = await stuck('answered');
  await assert.rejects(decisions.resolve(row.id, { expectedRevision: row.revision, option: 'go' }), { code: 'evolution_decision_executing' }, 'an experiment is still not carried out');
  const answered = await decisions.resolve(row.id, { expectedRevision: row.revision, option: 'hold' });
  assert.deepEqual([answered.payload.status, answered.payload.selected, answered.payload.source], ['executed', 'hold', 'user']);
  assert.ok(answered.payload.history.some((/** @type {any} */ entry) => entry.closed === 'retired-to-lab' && entry.option === 'go'), 'the stranded execution stays on the record');
  assert.deepEqual(executed, ['hold']);
  row = await stuck('closed-by-operator');
  await assert.rejects(decisions.resolve(row.id, { expectedRevision: row.revision, close: 'abandoned' }), { code: 'evolution_close_invalid' });
  const closed = await decisions.resolve(row.id, { expectedRevision: row.revision, close: 'retired-to-lab' });
  assert.deepEqual([closed.payload.status, closed.payload.closedReason, closed.payload.execution], ['closed', 'retired-to-lab', undefined]);
  row = await stuck('closed-at-expiry');
  const expired = await decisions.expire(row.id);
  assert.deepEqual([expired.payload.status, expired.payload.closedReason], ['closed', 'retired-to-lab']);
  assert.equal((await decisions.expire(row.id)).payload.status, 'closed', 'closed once: the next expiry has nothing to do');
  assert.deepEqual(executed, ['hold']);
});
