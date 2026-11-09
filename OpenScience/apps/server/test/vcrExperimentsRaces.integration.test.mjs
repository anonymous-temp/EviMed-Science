// Admission against cancel, and the comparison's one completion (round 2, F03, F03b, F04), on PostgreSQL with the real job queue and the
// real completion outbox; no engine runs (a job stays queued unless a test ends it), the conversation, the ledger and the notice are faked.
//
// The interleavings are deterministic: the job queue is wrapped so that the Nth `enqueue` is held, after the job exists and before the
// caller hears of it, until the test releases it. Whatever the test does while it is held (a cancel, a flag) is exactly the cancel that
// raced past the enqueue.
//
// Held: a campaign's candidate job that lost its link to a cancel is cancelled (and settled under its idempotency key), also across a
// failed cancel and a restart; a cancel that read the flight before the job id was written still cancels the job; a comparison records
// each arm as it is enqueued, keeps `cancelRequested`, queues no arm after a cancel and cancels the one it was queuing; a comparison with
// a conversation origin yields one aggregate completion when its arms have all ended (succeeded, partial, failed, canceled), never one
// per arm, never while an arm is open, never again after a restart, a second tick or a lost marker; a busy conversation waits; a
// comparison the originating run read after it ended wakes nobody.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrConversationCompletions } from '../src/vcrConversationCompletions.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : false, timeout: 300_000 };
const origin = { userId: 'race_owner', projectId: 'race_project', rootSessionId: 'race_session' };
const runOrigin = (/** @type {string} */ n) => ({ runId: `run_${n}`, rootSessionId: origin.rootSessionId, callId: `call_${n}` });
let database, isolated, vcr, study;

const scenario = { design: { kind: 'two_arm_fixed', nTreat: 50, nControl: 50 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5, sd: 1 },
  analysis: { method: 'ttest', alpha: 0.025, sided: 1 }, performance: ['power', 'type_one_error', 'expected_sample_size'] };
const manifest = (/** @type {string} */ question) => ({
  question,
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' }],
  space: { method: 'design.simulate', scenario, truths: [{ name: 'alternative', truth: { effect: 0.5, sd: 1 } }],
    candidates: [55, 70].map((n) => ({ set: { 'design.nTreat': n, 'design.nControl': n } })) },
  stages: { final: { count: 1 } }, budget: { maxCandidates: 2, cpuSeconds: 3000, modelCalls: 0 } });
const experiment = (/** @type {string} */ question) => ({ question, arms: ['A', 'B', 'C'].map((name, i) => ({ name, method: 'design.simulate',
  scenario: { ...scenario, design: { kind: 'two_arm_fixed', nTreat: 60 + 10 * i, nControl: 60 + 10 * i } } })),
comparison: { measures: ['power'], reference: 'A' } });

/**
 * The real queue seen through a wrapper: the `holdAt`th enqueue is held until `release()`, `cancel` is logged, and the cancel of the
 * `failCancelOf`th enqueued job fails once (a process that died before it could cancel).
 * @param {{ holdAt?: number, failCancelOf?: number }} [opts]
 */
function wrap({ holdAt = 0, failCancelOf = 0 } = {}) {
  const log = { enqueued: /** @type {string[]} */ ([]), cancels: /** @type {string[]} */ ([]) };
  /** @type {() => void} */ let release = () => {};
  /** @type {() => void} */ let arrived = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const arrival = new Promise((resolve) => { arrived = () => resolve(undefined); });
  let failed = false;
  const jobs = {
    jobCpuSeconds: vcr.jobs.jobCpuSeconds,
    enqueue: async (/** @type {any} */ input) => {
      const out = await vcr.jobs.enqueue(input);
      if (!log.enqueued.includes(out.job.id)) log.enqueued.push(out.job.id);
      if (log.enqueued.length === holdAt) { arrived(); await gate; }
      return out;
    },
    cancel: async (/** @type {string} */ studyId, /** @type {string} */ jobId, /** @type {any} */ o) => {
      log.cancels.push(jobId);
      if (failCancelOf && !failed && log.enqueued[failCancelOf - 1] === jobId) { failed = true; throw new Error('the process died before it could cancel'); }
      return vcr.jobs.cancel(studyId, jobId, o);
    },
  };
  return { jobs, log, arrival, release };
}
const experimentsOf = (/** @type {any} */ jobs) => new VcrExperiments({ store: vcr.store, jobs });
const rowByQuestion = (/** @type {string} */ question) => vcr.store.one(`SELECT * FROM evimed_vcr.experiments WHERE study_id = $1 AND manifest->>'question' = $2`, [study.id, question]);
const jobState = async (/** @type {string} */ id) => (await vcr.store.one('SELECT state FROM evimed_vcr.jobs WHERE id = $1', [id])).state;
const openJobsOf = async (/** @type {string} */ id) => vcr.store.rows(`SELECT id FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1 AND state IN ('queued', 'running', 'awaiting_budget')`, [id]);
const jobsOf = async (/** @type {string} */ id) => vcr.store.rows(`SELECT id, state, checkpoint FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1 ORDER BY created_at, id`, [id]);

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrrace');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  vcr.jobs.engine = { configured: () => true, submit: async () => ({ accepted: true }), status: async () => ({ state: 'running', progress: { done: 0, total: 1 } }),
    result: async () => ({}), cancel: async () => ({ canceled: true }) };
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('a cancel that raced past a campaign\'s enqueue cancels the job the enqueue returned (F03)', options, async () => {
  const held = wrap({ holdAt: 1 });
  const experiments = experimentsOf(held.jobs);
  const starting = experiments.startCampaign(study, manifest('race: lost link'), { userId: origin.userId });
  await held.arrival;
  const row = await rowByQuestion('race: lost link');
  assert.equal(row.state.inFlight.jobId, null, 'the unit is decided and its job not yet attached');
  await experiments.cancel(study, row.id);
  assert.equal((await rowByQuestion('race: lost link')).status, 'stopped');
  held.release();
  await starting;
  const after = await rowByQuestion('race: lost link');
  assert.equal(after.state.inFlight, null, 'the late job was never attached');
  assert.equal(after.state.stop.reason, 'user_cancellation');
  assert.ok(held.log.cancels.includes(held.log.enqueued[0]), 'the lost job was cancelled');
  assert.equal(await jobState(held.log.enqueued[0]), 'canceled');
  assert.equal((await openJobsOf(row.id)).length, 0, 'no queued job without an owner');
});

test('a lost link whose cancel failed is cancelled by the next repair, once, from a new process (F03, restart)', options, async () => {
  const held = wrap({ holdAt: 1, failCancelOf: 1 });
  const reported = [];
  const experiments = new VcrExperiments({ store: vcr.store, jobs: held.jobs, report: (code) => reported.push(code) });
  const starting = experiments.startCampaign(study, manifest('race: restart'), { userId: origin.userId });
  await held.arrival;
  const row = await rowByQuestion('race: restart');
  await experiments.cancel(study, row.id);
  held.release();
  await starting;
  assert.equal(await jobState(held.log.enqueued[0]), 'queued', 'the cancel failed: the job is still an orphan');
  assert.equal(reported.length, 1);
  const restarted = wrap();
  const second = experimentsOf(restarted.jobs);
  await second.repair();
  assert.deepEqual(restarted.log.cancels, [held.log.enqueued[0]]);
  assert.equal(await jobState(held.log.enqueued[0]), 'canceled');
  await second.repair(); await experimentsOf(restarted.jobs).repair();
  assert.equal(restarted.log.cancels.length, 1, 'a restart repeats nothing');
  assert.equal(held.log.enqueued.length, 1, 'and queued nothing new');
});

test('a cancel asked before the job id was written down still reaches the job (F03, the other order)', options, async () => {
  const held = wrap({ holdAt: 1 });
  const experiments = experimentsOf(held.jobs);
  const starting = experiments.startCampaign(study, manifest('race: flag first'), { userId: origin.userId });
  await held.arrival;
  const row = await rowByQuestion('race: flag first');
  // the first statement of a cancel: the flag is set, and the flight it read had no job
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = jsonb_set(state, '{cancelRequested}', 'true'::jsonb) WHERE id = $1`, [row.id]);
  held.release();
  await starting;
  assert.equal(await jobState(held.log.enqueued[0]), 'canceled');
  await experiments.repair();
  const after = await rowByQuestion('race: flag first');
  assert.equal(after.status, 'stopped');
  assert.equal(after.state.stop.reason, 'user_cancellation');
});

test('two ticks that decided the same unit link one job and cancel nothing (a deduplicated enqueue is the same job)', options, async () => {
  const held = wrap();
  const experiments = experimentsOf(held.jobs);
  const started = await experiments.startCampaign(study, manifest('race: duplicate tick'), { userId: origin.userId });
  const flight = (await rowByQuestion('race: duplicate tick')).state.inFlight;
  assert.ok(flight.jobId);
  // a second process decided the same unit before the job id was there and enqueues it again: the queue returns the same job
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = jsonb_set(state, '{inFlight,jobId}', 'null'::jsonb) WHERE id = $1`, [started.id]);
  const other = wrap();
  const first = experimentsOf(other.jobs).repair();
  const second = experimentsOf(wrap().jobs).repair();
  await Promise.all([first, second]);
  assert.equal((await rowByQuestion('race: duplicate tick')).state.inFlight.jobId, flight.jobId);
  assert.equal(other.log.cancels.length, 0);
  assert.equal(await jobState(flight.jobId), 'queued');
});

test('a comparison records each arm as it is queued, keeps the cancel flag and queues no arm after a cancel (F03b)', options, async () => {
  const held = wrap({ holdAt: 2 });
  const experiments = experimentsOf(held.jobs);
  const starting = experiments.startExperiment(study, experiment('race: arms'), { userId: origin.userId });
  await held.arrival;
  const row = await rowByQuestion('race: arms');
  assert.deepEqual(Object.keys(row.state.arms), ['A'], 'the first arm is on the record while the second is being queued');
  assert.equal(row.state.arms.A.jobId, held.log.enqueued[0]);
  await experiments.cancel(study, row.id);
  assert.deepEqual(held.log.cancels, [held.log.enqueued[0]], 'the cancel found the arm already queued');
  held.release();
  const view = await starting;
  const after = await rowByQuestion('race: arms');
  assert.equal(after.state.cancelRequested, true, 'the start did not erase the cancel');
  assert.equal(held.log.enqueued.length, 2, 'the third arm was never queued');
  assert.deepEqual(Object.keys(after.state.arms), ['A', 'B']);
  assert.equal(await jobState(held.log.enqueued[0]), 'canceled');
  assert.equal(await jobState(held.log.enqueued[1]), 'canceled', 'the arm that was being queued when the cancel came is cancelled too');
  assert.equal((await openJobsOf(row.id)).length, 0);
  assert.notEqual(view.status, 'running');
});

test('an arm whose cancel failed is cancelled by repair, and the experiment stays cancelled (F03b, restart)', options, async () => {
  const held = wrap({ holdAt: 2, failCancelOf: 2 });
  const experiments = new VcrExperiments({ store: vcr.store, jobs: held.jobs, report: () => {} });
  const starting = experiments.startExperiment(study, experiment('race: arms restart'), { userId: origin.userId });
  await held.arrival;
  const row = await rowByQuestion('race: arms restart');
  await experiments.cancel(study, row.id);
  held.release();
  await starting;
  assert.equal(await jobState(held.log.enqueued[1]), 'queued');
  const restarted = wrap();
  await experimentsOf(restarted.jobs).repair();
  assert.equal(await jobState(held.log.enqueued[1]), 'canceled');
  await experimentsOf(restarted.jobs).repair();
  assert.equal(restarted.log.cancels.length, 1);
  assert.equal((await rowByQuestion('race: arms restart')).state.cancelRequested, true);
});

// --- the comparison's completion (F04) -------------------------------------------------------------------------------------------

/** The completions service over the real store, the conversation, the ledger and the notice faked. */
function service({ runs = [], inbox = { running: false, queued: 0 } } = {}) {
  const log = { dispatched: /** @type {any[]} */ ([]), notices: /** @type {any[]} */ ([]) };
  const completions = new VcrConversationCompletions({ store: vcr.store, config: {},
    readRuns: async () => runs, readOrigin: async (_project, runId) => runs.find((run) => run.id === runId) ?? null,
    resolve: async () => ({ user: { id: origin.userId }, project: { id: origin.projectId, userId: origin.userId }, session: {} }),
    inbox: async () => inbox,
    dispatch: async (_u, _p, sessionId, dispatchId, text, opts) => { log.dispatched.push({ sessionId, dispatchId, text, supplement: opts.systemSupplement, originRunId: opts.originRunId }); return { run: { id: 'continued' } }; },
    notify: async (row, reason) => { log.notices.push({ id: row.id, reason }); } });
  return { completions, log };
}
const turn = (/** @type {string} */ n, /** @type {number} */ endsInMs) => [{ id: `run_${n}`, sessionId: origin.rootSessionId, status: 'succeeded',
  startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date(Date.now() + endsInMs).toISOString() }];
const rowsOf = (/** @type {string} */ id) => vcr.store.rows(`SELECT * FROM evimed_vcr.conversation_completions WHERE payload->>'experimentId' = $1`, [id]);
const end = (/** @type {string} */ id, /** @type {string} */ state) => vcr.store.query(`UPDATE evimed_vcr.jobs SET state = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [id, state]);

/** A comparison started by a conversation's run, its three arms queued; the arms' job ids in order. @param {string} n @param {string} question */
async function started(n, question) {
  const experiments = experimentsOf(wrap().jobs);
  const created = await experiments.startExperiment(study, experiment(question), { userId: origin.userId, origin: runOrigin(n) });
  const jobs = await jobsOf(created.id);
  assert.equal(jobs.length, 3);
  return { id: created.id, jobs: jobs.map((job) => job.id), experiments };
}

test('a comparison started by a conversation wakes it once when every arm has ended, never per arm and never while one is open (F04)', options, async () => {
  const cmp = await started('after', 'done: after the turn');
  const arms = await jobsOf(cmp.id);
  assert.ok(arms.every((job) => !('conversationOrigin' in job.checkpoint)), 'the arms carry no conversation: the comparison speaks once');
  const idle = service({ runs: turn('after', -30_000) });
  await end(cmp.jobs[0], 'succeeded'); await end(cmp.jobs[1], 'succeeded');
  await idle.completions.tick();
  assert.equal((await rowsOf(cmp.id)).length, 0, 'an arm is still open: no completion');
  assert.equal(idle.log.dispatched.length, 0);
  await end(cmp.jobs[2], 'succeeded');
  const done = service({ runs: turn('after', -1) });
  await vcr.store.query(`UPDATE evimed_vcr.jobs SET finished_at = now() + interval '5 seconds' WHERE id = $1`, [cmp.jobs[2]]);
  await done.completions.tick();
  assert.equal(done.log.dispatched.length, 1, 'one continuation for three arms');
  const sent = done.log.dispatched[0];
  assert.equal(sent.sessionId, origin.rootSessionId);
  assert.equal(sent.originRunId, 'run_after');
  assert.match(sent.supplement, new RegExp(`Experiment=${cmp.id}; tool=vcr_simulate action=compare_status; outcome=succeeded;`));
  assert.match(sent.text, /每一组都有结果/);
  const rows = await rowsOf(cmp.id);
  assert.deepEqual(rows.map((row) => row.state), ['delivered']);
  assert.equal(rows[0].job_id, null);
  assert.equal(rows[0].result_key, 'experiment');
  // a second tick, a new process, and a lost marker record and send nothing more
  await done.completions.tick();
  const again = service({ runs: turn('after', -1) });
  await again.completions.tick();
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = state - 'completionRecorded' WHERE id = $1`, [cmp.id]);
  await again.completions.tick();
  assert.equal((await rowsOf(cmp.id)).length, 1);
  assert.equal(done.log.dispatched.length + again.log.dispatched.length, 1, 'exactly one turn');
  // and the job path never saw an arm
  assert.equal(Number((await vcr.store.one(`SELECT count(*) AS n FROM evimed_vcr.conversation_completions WHERE job_id = ANY($1::text[])`, [cmp.jobs])).n), 0);
});

test('a comparison with a failed arm is one partial completion, and one with no result is a failed one', options, async () => {
  const partial = await started('partial', 'done: partial');
  await end(partial.jobs[0], 'succeeded'); await end(partial.jobs[1], 'failed'); await end(partial.jobs[2], 'succeeded');
  const a = service({ runs: turn('partial', -1) });
  await vcr.store.query(`UPDATE evimed_vcr.jobs SET finished_at = now() + interval '5 seconds' WHERE id = $1`, [partial.jobs[2]]);
  await a.completions.tick();
  assert.equal(a.log.dispatched.length, 1);
  assert.match(a.log.dispatched[0].supplement, /outcome=partial;/);
  assert.deepEqual((await rowsOf(partial.id))[0].payload.arms, { total: 3, complete: 2, failed: 1, canceled: 0, refused: 0, pending: 0 });
  assert.match(a.log.dispatched[0].text, /2 组有结果，1 组没有结果/);
  assert.equal((await rowsOf(partial.id))[0].payload.partial, true);

  const failed = await started('failed', 'done: failed');
  for (const id of failed.jobs) await end(id, 'failed');
  await vcr.store.query(`UPDATE evimed_vcr.jobs SET finished_at = now() + interval '5 seconds' WHERE id = $1`, [failed.jobs[2]]);
  const b = service({ runs: turn('failed', -1) });
  await b.completions.tick();
  assert.equal(b.log.dispatched.length, 1);
  assert.match(b.log.dispatched[0].supplement, /outcome=failed;/);
  assert.equal((await rowsOf(failed.id))[0].payload.state, 'failed');
});

test('a cancelled comparison is settled once and sends neither a turn nor a notice', options, async () => {
  const cmp = await started('cancel', 'done: cancelled');
  await cmp.experiments.cancel(study, cmp.id);
  const run = service({ runs: turn('cancel', -1) });
  await run.completions.tick(); await run.completions.tick();
  const rows = await rowsOf(cmp.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.outcome, 'canceled');
  assert.equal(run.log.dispatched.length + run.log.notices.length, 0);
  assert.equal(run.completions.status().canceled, 1);
  assert.deepEqual(rows.map((row) => row.state), ['delivered']);
});

test('a busy conversation holds the completion, and the finished turn that never read it gets one notice and no paid turn', options, async () => {
  const cmp = await started('busy', 'done: busy root');
  for (const id of cmp.jobs) await end(id, 'succeeded');
  const turnEnds = new Date(Date.now() + 20_000).toISOString();
  const runs = [{ id: 'run_busy', sessionId: origin.rootSessionId, status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString() }];
  const busy = service({ runs, inbox: { running: true, queued: 0 } });
  await busy.completions.tick();
  assert.equal(busy.log.dispatched.length, 0);
  assert.deepEqual((await rowsOf(cmp.id)).map((row) => row.state), ['pending']);
  runs[0] = { ...runs[0], status: 'succeeded', finishedAt: turnEnds };
  await vcr.store.query(`UPDATE evimed_vcr.conversation_completions SET run_after = now(), lease_until = NULL WHERE payload->>'experimentId' = $1`, [cmp.id]);
  const idle = service({ runs, inbox: { running: false, queued: 0 } });
  await idle.completions.tick();
  assert.equal(idle.log.dispatched.length, 0, 'the turn ended after the comparison did: it is disclosed, not answered again');
  assert.equal(idle.log.notices.length, 1);
  assert.deepEqual((await rowsOf(cmp.id)).map((row) => row.state), ['delivered']);
});

test('a comparison the originating run read after it ended wakes nobody', options, async () => {
  const cmp = await started('read', 'done: read in turn');
  for (const id of cmp.jobs) await end(id, 'succeeded');
  const ended = await cmp.experiments.completionOf(study.id, cmp.id);
  assert.deepEqual([ended.terminal, ended.outcome, ended.state], [true, 'succeeded', 'succeeded']);
  // what the gateway writes when the run reads the comparison
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = state || jsonb_build_object('originTerminalObservation', $2::jsonb) WHERE id = $1`,
    [cmp.id, JSON.stringify({ ...runOrigin('read'), state: ended.state, resultKey: 'experiment' })]);
  const run = service({ runs: turn('read', 20_000) });
  await run.completions.tick();
  assert.equal(run.log.dispatched.length + run.log.notices.length, 0);
  assert.equal(run.completions.status().observed, 1);
  assert.deepEqual((await rowsOf(cmp.id)).map((row) => row.state), ['delivered']);
});

test('a comparison started with no conversation, or whose arms are still being queued, is never recorded', options, async () => {
  const page = await experimentsOf(wrap().jobs).startExperiment(study, experiment('done: from the page'), { userId: origin.userId });
  for (const job of await jobsOf(page.id)) await end(job.id, 'succeeded');
  // a start that has queued one arm of three: the unrecorded arms are not "ended"
  const half = wrap({ holdAt: 2 });
  const experiments = experimentsOf(half.jobs);
  const starting = experiments.startExperiment(study, experiment('done: half queued'), { userId: origin.userId, origin: runOrigin('half') });
  await half.arrival;
  const halfRow = await rowByQuestion('done: half queued');
  await end(half.log.enqueued[0], 'succeeded'); await end(half.log.enqueued[1], 'succeeded');
  const run = service({ runs: turn('half', -1) });
  await run.completions.tick();
  assert.equal((await rowsOf(page.id)).length + (await rowsOf(halfRow.id)).length, 0);
  half.release();
  await starting;
  await end((await jobsOf(halfRow.id)).at(-1).id, 'succeeded');
  await run.completions.tick();
  assert.equal((await rowsOf(halfRow.id)).length, 1, 'once the last arm has ended and been queued, the one completion is recorded');
});
