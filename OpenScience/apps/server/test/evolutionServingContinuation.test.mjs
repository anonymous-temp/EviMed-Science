// What production keeps of the evolution module once experiments moved to the offline lab (review of the serving cutover,
// 2026-10-26): an agenda waiting on a dataset still resumes, an unanswered harm alarm still protects, the operators still get
// their digest, retirements and monthly figures, and a card stuck on an experiment can still be settled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evolutionServiceFixture } from './helpers/evolutionServiceFixture.mjs';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
import { createEvolutionServing } from '../src/evolutionServing.mjs';
import { EvolutionIntegration } from '../src/evolutionIntegration.mjs';
import { EvolutionDecisions } from '../src/evolutionDecisions.mjs';
import { EvolutionMaintenance } from '../src/evolutionMaintenance.mjs';

const SERVING = { evolutionEnabled: true, evolutionSearchPaused: true, evolutionServingOnly: true, evolutionMaxJobAttempts: 3 };
/** The fixture's keyed queue with the lease operations a worker uses; a job is due at its `runAfter`. @param {any} f */
function queue(f, now = () => f.service.now()) {
  const enqueue = f.service.jobs.enqueue.bind(f.service.jobs);
  let sequence = 0;
  const jobs = {
    enqueue: async (/** @type {any[]} */ ...args) => { const job = await enqueue(...args); job.runAfter ??= args[3]?.runAfter ?? null; job.state ??= 'queued'; return job; },
    claim: async (/** @type {string[]} */ kinds) => {
      const job = f.jobs.find((/** @type {any} */ item) => kinds.includes(item.kind) && (item.state ?? 'queued') === 'queued' && (!item.runAfter || new Date(item.runAfter) <= now()));
      if (!job) return null;
      job.state = 'running'; job.attempts = (job.attempts ?? 0) + 1; job.id ??= `job-${++sequence}`;
      return { ...job, userId: job.owner, leaseToken: 'lease', maxAttempts: 3 };
    },
    renew: async () => true,
    finish: async (/** @type {string} */ _owner, /** @type {string} */ id, /** @type {string} */ _lease, /** @type {any} */ result) => { const job = f.jobs.find((/** @type {any} */ item) => item.id === id); Object.assign(job, { state: 'succeeded', result }); return job; },
    fail: async (/** @type {string} */ _owner, /** @type {string} */ id, /** @type {string} */ _lease, /** @type {any} */ error, /** @type {any} */ options) => { const job = f.jobs.find((/** @type {any} */ item) => item.id === id); Object.assign(job, { state: options.retry ? 'queued' : 'failed', error, options }); return job; },
  };
  return jobs;
}
/** Tick until nothing is claimed. @param {any} worker */
async function drain(worker, limit = 30) { for (let index = 0; index < limit; index++) if (!await worker.tick()) return index; throw new Error('the queue did not drain'); }

test('a dataset for a waiting agenda runs the published tool\'s self-check in serving and the agenda resumes', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING); f.service.jobs = queue(f);
  const woken = [], ran = [];
  const integration = new EvolutionIntegration({ service: f.service, autopilot: { wakeForEvolution: async (/** @type {any} */ input) => { woken.push(input); return { resumed: true }; } } });
  f.service.callbacks.wakeAgenda = (/** @type {any} */ input) => integration.wakeAgenda(input);
  await f.service.save('tool', 'published-tool', { track: 'M', status: 'active', validationLevel: 'V1', artifactDigest: 'pin' });
  const waiter = await f.service.waitFor({ userId: 'alice', projectId: 'study', agendaId: 'agenda', toolId: 'published-tool', dataRequirements: { schema: { fields: [] } } });
  const selfCheck = { run: async (/** @type {any} */ input) => { ran.push(input); return f.service.save('self-check', 'check-1', { projectId: input.projectId, toolId: input.toolId, status: 'passed', measurementCompleted: true }, null, input.userId); } };
  const worker = createEvolutionServingWorker({ service: f.service, integration, decisions: new EvolutionDecisions({ service: f.service }), maintenance: new EvolutionMaintenance({ service: f.service }), selfCheck, config: f.service.config });
  await integration.publish({ id: 'dataset:study:data:1', type: 'dataset-ready', userId: 'alice', projectId: 'study', datasetId: 'data', dataset: { semanticsChecksPassed: true } });
  await drain(worker);
  assert.deepEqual(ran.map(input => [input.toolId, input.datasetId, input.waiterId]), [['published-tool', 'data', waiter.id]]);
  assert.deepEqual(woken.map(input => [input.agendaId, input.event.selfCheckStatus]), [['agenda', 'passed']]);
  const resolved = await f.service.get(waiter.id, 'alice');
  assert.equal(resolved.payload.status, 'resolved'); assert.equal(resolved.payload.selfCheckId, 'check-1');
  assert.equal(f.jobs.find(job => job.kind === 'evolution-self-check').state, 'succeeded');
  assert.equal(f.jobs.some(job => job.state === 'canceled' || /scout|build|mission|evaluate/.test(job.kind)), false);
  await worker.close();
});

test('serving housekeeping keeps the digest, retirement completion and metrics-only month, and quarantines at most hourly', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING); f.service.jobs = queue(f);
  let quarantined = 0, reconciled = 0, admitted = null;
  f.service.reconcileQueued = async () => { reconciled++; return { recovered: 0 }; };
  await f.service.save('tool', 'leaving', { track: 'M', status: 'retired', retirement: { reason: 'sequential-harm', state: 'pending' } });
  const retired = [];
  const maintenance = new EvolutionMaintenance({ service: f.service, judgeService: { judge: () => { throw new Error('serving called the judge'); } },
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

test('a monthly pass queued before cutover keeps its identity and runs metrics-only', async () => {
  const f = evolutionServiceFixture(); Object.assign(f.service.config, SERVING); f.service.jobs = queue(f);
  const received = [];
  await f.service.jobs.enqueue('operator', 'evolution-maintain', { month: '2026-10', metricsMonth: '2026-09' }, { idempotencyKey: 'evolution:monthly-v2:2026-10' });
  const worker = createEvolutionServingWorker({ service: f.service, integration: {}, decisions: new EvolutionDecisions({ service: f.service }),
    maintenance: { monthly: async (/** @type {any} */ input) => { received.push(input); return { id: `metrics-${received.length}` }; }, retire: async () => null }, config: f.service.config });
  await drain(worker);
  assert.ok(received.length >= 1); assert.ok(received.every(input => input.metricsOnly === true));
  assert.equal(f.jobs.find(job => job.key === 'evolution:monthly-v2:2026-10').state, 'succeeded');
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
      registry: Promise.resolve({ list: () => [] }), runtimeManager: {}, controller: {}, agentRuns: { list: async () => [] }, notifications: f.service.notifications, autopilot: {} });
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
