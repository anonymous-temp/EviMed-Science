// What serving does with work only an experiment could carry out. The file kept its name from the pause that once held the experiment engine back; the engine is gone, so
// these are no longer an off branch of a switch but the one behaviour: an experiment's option is refused or closed to the offline lab, and what the journal acknowledges is
// only completed work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionJobQueue, evolutionServiceFixture, seedCard, seedTool } from './helpers/evolutionServiceFixture.mjs';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
import { EvolutionIntegration } from '../src/evolutionIntegration.mjs';
import { EvolutionDecisions } from '../src/evolutionDecisions.mjs';

const DEFERRED = { status: 'deferred', code: 'evolution_offline_only' };
test('a due card whose option is an experiment closes to the lab at expiry, and an experimental answer executes nothing', async () => {
  const f = evolutionServiceFixture(); let called = 0;
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: () => { called++; } } });
  const row = await f.service.save('decision', 'pending', { status: 'pending', decisionClass: 'B', deliveredAt: '2026-10-01', dueAt: '2026-10-02', options: [{ id: 'build', operation: 'build' }], recommended: 'build', history: [] });
  const closed = await decisions.expire(row.id);
  assert.deepEqual([closed.payload.status, closed.payload.closedReason], ['closed', 'retired-to-lab']);
  assert.equal((await decisions.execute(row, 'build', 'user')).code, 'evolution_offline_only');
  assert.equal(called, 0);
});

test('a card is not expired before it was delivered or before it is due', async () => {
  const f = evolutionServiceFixture(); let called = false;
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: () => { called = true; } } });
  const options = [{ id: 'keep', operation: 'keep' }];
  const future = await f.service.save('decision', 'future', { status: 'pending', dueAt: '2026-11-01', deliveredAt: '2026-10-01', conservative: 'keep', options });
  const undelivered = await f.service.save('decision', 'undelivered', { status: 'pending', dueAt: '2026-10-01', conservative: 'keep', options });
  for (const row of [future, undelivered]) assert.deepEqual([(await decisions.expire(row.id)).revision, called], [row.revision, false], row.id);
});

test('an answer serving cannot carry out is a typed 409, an answer in words a typed 400, and the card stays pending', async () => {
  const f = evolutionServiceFixture();
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: () => assert.fail('nothing is executed') } });
  const row = await f.service.save('decision', 'public', { status: 'pending', options: [{ id: 'build', operation: 'build' }], recommended: 'build', history: [] });
  await assert.rejects(decisions.resolve(row.id, { expectedRevision: row.revision, option: 'build' }), { code: 'evolution_offline_only', status: 409 });
  await assert.rejects(decisions.resolve(row.id, { expectedRevision: row.revision, text: 'build' }), { code: 'evolution_answer_invalid', status: 400 });
  assert.equal((await f.service.get(row.id)).payload.status, 'pending');
});

test('a dataset event consumed again queues the published tool\'s self-check exactly once and ends processed', async () => {
  const f = evolutionServiceFixture(); f.service.config.evolutionEnabled = true; f.service.jobs = evolutionJobQueue(f);
  const integration = new EvolutionIntegration({ service: f.service, autopilot: {} });
  await seedTool(f.service, { id: 'wake-tool', track: 'M', artifactDigest: 'pin' });
  await f.service.waitFor({ userId: 'alice', projectId: 'a', agendaId: 'agenda', toolId: 'wake-tool', dataRequirements: { schema: { fields: [] } } });
  const event = await f.service.ingestEvent({ id: 'wake-data', type: 'dataset-ready', userId: 'alice', projectId: 'a', datasetId: 'data', dataset: { semanticsChecksPassed: true } });
  const selfChecks = () => f.jobs.filter(job => job.kind === 'evolution-self-check').length;
  const worker = createEvolutionServingWorker({ service: f.service, integration, config: f.service.config, logger: { error() {} } });
  await worker.tick();
  assert.equal((await f.service.get(event.id, 'alice')).payload.status, 'processed'); assert.equal(selfChecks(), 1);
  // A crash after the consumer ran and before the event was marked: the same event is consumed again, and the keyed enqueue holds.
  await integration.consume(event.payload); assert.equal(selfChecks(), 1);
  // And a redelivered job finds the event processed and does nothing.
  await f.service.enqueue('event', { eventId: event.id, eventOwnerId: 'alice' }, 'redelivery'); await worker.tick();
  assert.equal(selfChecks(), 1);
  await worker.close();
});

test('the decision journal acknowledges only completed work: a deferral is run again, an old completed deferral once, and a completed action never twice', async () => {
  const f = evolutionServiceFixture(); const action = { actionId: 'flip' }; let available = false;
  const work = async () => available ? f.service.enqueue('digest', { day: '2026-10-04' }, 'flip') : DEFERRED;
  const id = `evolution-action-${(await import('../src/evolutionService.mjs')).evolutionKey(action.actionId)}`;
  assert.equal((await f.service.executeDecisionAction(action, work)).status, 'deferred');
  assert.equal((await f.service.get(id)).payload.status, 'deferred');
  available = true;
  await f.service.executeDecisionAction(action, work); await f.service.executeDecisionAction(action, work);
  assert.equal(f.jobs.length, 1);
  // A deferral recorded as complete by the pause that preceded this (its result says so) is retried like any other.
  const legacyId = `evolution-action-${(await import('../src/evolutionService.mjs')).evolutionKey('legacy')}`;
  await f.service.save('action', legacyId, { actionId: 'legacy', status: 'complete', result: { status: 'deferred', code: 'evolution_search_paused' } });
  await f.service.executeDecisionAction({ actionId: 'legacy' }, () => f.service.enqueue('digest', { day: 'legacy' }, 'legacy'));
  assert.equal(f.jobs.length, 2);
});

test('a deferral during a decision\'s execution keeps its action identity, and the resumed execution runs the work once', async () => {
  const f = evolutionServiceFixture(); let attempts = 0;
  const decisions = new EvolutionDecisions({ service: f.service, callbacks: { execute: action => f.service.executeDecisionAction(action, async () => {
    attempts++; return attempts === 1 ? DEFERRED : f.service.enqueue('maintain', { decisionActionId: action.actionId }, action.actionId); }) } });
  let row = await seedCard(f.service, 'flip-record', { options: [{ id: 'keep', label: '保留', operation: 'keep' }], recommended: 'keep', conservative: 'keep' });
  assert.equal((await decisions.execute(row, 'keep', 'user')).status, 'deferred');
  row = await f.service.get(row.id);
  assert.equal(row.payload.status, 'executing'); const actionId = row.payload.execution.actionId;
  const resumed = await decisions.execute(row, 'keep', 'user');
  await f.service.executeDecisionAction({ actionId }, () => { throw new Error('completed action was replayed'); });
  assert.equal(resumed.payload.status, 'executed'); assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].payload.decisionActionId, actionId);
});
