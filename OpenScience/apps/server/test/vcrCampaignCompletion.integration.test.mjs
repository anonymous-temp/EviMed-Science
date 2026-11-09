// A design-search campaign wakes the conversation that started it exactly once (F4): on PostgreSQL, the real completion outbox and its
// dispositions, with the conversation, the run ledger and the notice faked. The units of a campaign carry no conversation origin, so
// the campaign's own origin is the only thing that can wake the conversation, and only when the campaign stops.
//
// Held: finished after the turn → one continuation turn that names the stop reason and the best design; finished during the turn → no turn
// (an unread result is disclosed by one notice, a read one by nothing); cancelled → no turn and no notice; a restart, a second tick and a
// lost marker never record a second completion; a running campaign records none and its units carry no origin.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrConversationCompletions, vcrCompletionDispatchId } from '../src/vcrConversationCompletions.mjs';
import { VcrExperiments, VCR_CAMPAIGN_STOP_TEXT_ZH } from '../src/vcrExperiments.mjs';
import { vcrCampaignAdvance, vcrCampaignCanonical, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord } from '@evimed/domain';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { createHash } from 'node:crypto';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : false, timeout: 300_000 };
const origin = { userId: 'lab_owner', projectId: 'lab_project', rootSessionId: 'lab_session' };
const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
let database, isolated, vcr, study;

const input = {
  question: '最小样本量',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null' }],
  space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 }, endpoint: { type: 'continuous' },
    truth: { effect: 0.4, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } },
  truths: [{ name: 'alternative', truth: { effect: 0.4, sd: 1 } }, { name: 'null', truth: { effect: 0, sd: 1 } }],
  variables: [{ path: 'design.nTreat', values: [60, 100, 140, 180] }] },
  stages: { screening: { replicates: 400 }, final: { count: 2 } },
  budget: { maxCandidates: 4, cpuSeconds: 1000 },
};

/** A campaign driven to its stop on a deterministic fake engine, and its stored form. */
function stoppedRow(id, { cancel = false } = {}) {
  const { manifest } = vcrCampaignManifest(input);
  const identity = sha(vcrCampaignCanonical(manifest));
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 80 && !cancel; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, n = unit.scenario.design.nTreat, reps = unit.stage === 'screening' ? 400 : unit.truth === 'null' ? 20000 : 5000;
    const p = unit.truth === 'null' ? 0.02 : Math.round((1 - Math.exp(-n / 70)) * reps) / reps;
    const label = unit.stage === 'screening' ? { precision: 'screening' } : {};
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `job_${id}_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: reps,
      measures: [{ name: unit.truth === 'null' ? 'type_one_error' : 'power', value: p, mcse: Math.sqrt(p * (1 - p) / reps), simulated: true, source: 'synthetic', ...label },
        { name: 'expected_sample_size', value: n * 2, mcse: 0, simulated: true, source: 'synthetic', ...label }], cpuSeconds: 1 });
  }
  if (cancel) state = { ...state, stop: { reason: 'user_cancellation', verdict: null } };
  state = { ...state, stop: { ...state.stop, at: new Date().toISOString() } };
  return { id, manifest, identity: sha(`${identity}:${id}`), state };
}

async function store(/** @type {ReturnType<typeof stoppedRow>} */ row, runOrigin = { runId: 'run1', rootSessionId: origin.rootSessionId, callId: 'call1' }) {
  await vcr.store.query(`INSERT INTO evimed_vcr.experiments (id, study_id, user_id, kind, identity, manifest, state, status, origin)
    VALUES ($1, $2, $3, 'campaign', $4, $5::jsonb, $6::jsonb, 'stopped', $7::jsonb)`,
  [row.id, study.id, origin.userId, row.identity, JSON.stringify(row.manifest), JSON.stringify(row.state), JSON.stringify(runOrigin)]);
}

/** The completions service over the real store, with the conversation, the ledger and the notice faked. */
function service({ runs = [], inbox = { running: false, queued: 0 } } = {}) {
  const log = { dispatched: /** @type {any[]} */ ([]), notices: /** @type {any[]} */ ([]) };
  const completions = new VcrConversationCompletions({ store: vcr.store, config: {},
    readRuns: async () => runs, readOrigin: async (_project, runId) => runs.find((run) => run.id === runId) ?? null,
    resolve: async () => ({ user: { id: origin.userId }, project: { id: origin.projectId, userId: origin.userId }, session: {} }),
    inbox: async () => inbox,
    dispatch: async (_user, _project, sessionId, dispatchId, text, opts) => { log.dispatched.push({ sessionId, dispatchId, text, supplement: opts.systemSupplement, originRunId: opts.originRunId }); return { run: { id: 'continued' } }; },
    notify: async (row, reason) => { log.notices.push({ id: row.id, reason }); } });
  return { completions, log };
}
const finishedBefore = (/** @type {Date} */ at) => [{ id: 'run1', sessionId: origin.rootSessionId, status: 'succeeded', startedAt: new Date(at.getTime() - 60_000).toISOString(), finishedAt: new Date(at.getTime() - 30_000).toISOString() }];
const rowsOf = (/** @type {string} */ id) => vcr.store.rows(`SELECT * FROM evimed_vcr.conversation_completions WHERE payload->>'campaignId' = $1`, [id]);

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrcc');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('a campaign that stopped after the turn wakes the conversation once, with its stop reason and best design, and never again', options, async () => {
  const row = stoppedRow('cmp_after'); await store(row);
  const { completions, log } = service({ runs: finishedBefore(new Date(Date.now() + 5_000)) });
  await completions.tick();
  assert.equal(log.dispatched.length, 1, 'one continuation turn');
  const sent = log.dispatched[0];
  assert.equal(sent.sessionId, origin.rootSessionId);
  assert.equal(sent.originRunId, 'run1');
  assert.match(sent.text, new RegExp(VCR_CAMPAIGN_STOP_TEXT_ZH.acceptable_precision.slice(0, 12)));
  assert.match(sent.text, /在这些假设下，满足约束且最省的方案是第 \d+ 个/);
  assert.match(sent.supplement, /Campaign=cmp_after; tool=vcr_simulate action=search_status; stop=acceptable_precision; best=/);
  const best = JSON.parse(/best=(\{.*\})\. This is/.exec(sent.supplement)?.[1] ?? 'null');
  assert.deepEqual([best.source, typeof best.index, best.objective.value, Object.keys(best.set)], ['feasible', 'number', 280, ['design.nTreat']], 'the engine\'s own number, not a retyped one');
  assert.equal(log.notices.length, 0);
  const rows = await rowsOf('cmp_after');
  assert.deepEqual(rows.map((r) => r.state), ['delivered']);
  assert.equal(rows[0].study_id, study.id);
  // a second tick, a new process over the same database, and a lost marker record and send nothing more
  await completions.tick();
  const second = service({ runs: finishedBefore(new Date(Date.now() + 5_000)) });
  await second.completions.tick();
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = state - 'completionRecorded' WHERE id = 'cmp_after'`);
  await second.completions.tick();
  assert.equal((await rowsOf('cmp_after')).length, 1);
  assert.equal(log.dispatched.length + second.log.dispatched.length, 1, 'exactly one notice');
});

test('a campaign that stopped during the turn sends no second turn: an unread result is disclosed by one notice, a read one by none', options, async () => {
  // unread: the turn is still running at first, then ends after the campaign stopped
  const unread = stoppedRow('cmp_during_unread'); await store(unread, { runId: 'run2', rootSessionId: origin.rootSessionId, callId: 'call2' });
  const stoppedAt = new Date(unread.state.stop.at);
  const runs = [{ id: 'run2', sessionId: origin.rootSessionId, status: 'running', startedAt: new Date(stoppedAt.getTime() - 60_000).toISOString() }];
  const a = service({ runs, inbox: { running: true, queued: 0 } });
  await a.completions.tick();
  assert.equal(a.log.dispatched.length, 0, 'the conversation is busy: nothing is sent into a running turn');
  assert.deepEqual((await rowsOf('cmp_during_unread')).map((r) => r.state), ['pending']);
  runs[0] = { ...runs[0], status: 'succeeded', finishedAt: new Date(stoppedAt.getTime() + 20_000).toISOString() };
  await vcr.store.query(`UPDATE evimed_vcr.conversation_completions SET run_after = now() WHERE payload->>'campaignId' = 'cmp_during_unread'`);
  const b = service({ runs, inbox: { running: false, queued: 0 } });
  await b.completions.tick();
  assert.equal(b.log.dispatched.length, 0);
  assert.equal(b.log.notices.length, 1, 'the result the turn never read is disclosed once, without a paid turn');
  assert.deepEqual((await rowsOf('cmp_during_unread')).map((r) => r.state), ['delivered']);
  // read: the run read the stopped campaign before its turn ended
  const read = stoppedRow('cmp_during_read'); await store(read, { runId: 'run3', rootSessionId: origin.rootSessionId, callId: 'call3' });
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = state || jsonb_build_object('originTerminalObservation', $2::jsonb) WHERE id = $1`,
    ['cmp_during_read', JSON.stringify({ runId: 'run3', rootSessionId: origin.rootSessionId, callId: 'call3', state: 'succeeded', resultKey: 'campaign' })]);
  const c = service({ runs: [{ id: 'run3', sessionId: origin.rootSessionId, status: 'succeeded', startedAt: new Date(stoppedAt.getTime() - 60_000).toISOString(), finishedAt: new Date(stoppedAt.getTime() + 20_000).toISOString() }] });
  await c.completions.tick();
  assert.equal(c.log.dispatched.length + c.log.notices.length, 0);
  assert.equal(c.completions.status().observed, 1);
  assert.deepEqual((await rowsOf('cmp_during_read')).map((r) => r.state), ['delivered']);
});

test('a cancelled campaign is settled once and sends neither a turn nor a notice', options, async () => {
  const row = stoppedRow('cmp_cancel', { cancel: true }); await store(row, { runId: 'run4', rootSessionId: origin.rootSessionId, callId: 'call4' });
  const { completions, log } = service({ runs: finishedBefore(new Date(Date.now() + 5_000)).map((run) => ({ ...run, id: 'run4' })) });
  await completions.tick(); await completions.tick();
  assert.equal(log.dispatched.length + log.notices.length, 0);
  assert.equal(completions.status().canceled, 1);
  assert.deepEqual((await rowsOf('cmp_cancel')).map((r) => r.state), ['delivered']);
});

test('a restart between recording and sending keeps the one identity: the same dispatch id, one turn', options, async () => {
  const row = stoppedRow('cmp_restart'); await store(row, { runId: 'run5', rootSessionId: origin.rootSessionId, callId: 'call5' });
  const runs = finishedBefore(new Date(Date.now() + 5_000)).map((run) => ({ ...run, id: 'run5' }));
  // the first process records the completion and dies while the conversation is busy
  const first = service({ runs, inbox: { running: true, queued: 0 } });
  await first.completions.tick();
  const [recorded] = await rowsOf('cmp_restart');
  assert.equal(recorded.state, 'pending');
  await vcr.store.query(`UPDATE evimed_vcr.conversation_completions SET run_after = now(), lease_until = NULL WHERE id = $1`, [recorded.id]);
  const second = service({ runs });
  await second.completions.tick();
  assert.equal(second.log.dispatched.length, 1);
  assert.equal(second.log.dispatched[0].dispatchId, vcrCompletionDispatchId(recorded.fingerprint), 'the identity is the campaign\'s, not the process\'s');
  assert.equal((await rowsOf('cmp_restart')).length, 1);
});

test('a running campaign records nothing, and its units never carry the conversation: never one notice per unit', options, async () => {
  const experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  vcr.jobs.engine = { configured: () => true, submit: async () => ({ accepted: true }), status: async () => ({ state: 'running', progress: { done: 0, total: 1 } }), result: async () => ({}), cancel: async () => ({ canceled: true }) };
  const started = await experiments.startCampaign(study, { ...input, constraints: input.constraints.slice(0, 1) }, { userId: origin.userId, origin: { runId: 'run6', rootSessionId: origin.rootSessionId, callId: 'call6' } });
  assert.equal(started.status, 'running');
  const units = await vcr.store.rows(`SELECT checkpoint FROM evimed_vcr.jobs WHERE study_id = $1`, [study.id]);
  assert.ok(units.length > 0, 'a unit was queued');
  assert.ok(units.every((unit) => !('conversationOrigin' in unit.checkpoint)), 'no unit carries the conversation');
  const { completions, log } = service();
  await completions.tick();
  assert.equal((await rowsOf(started.id)).length, 0);
  assert.equal(log.dispatched.length + log.notices.length, 0);
  // a campaign started with no conversation (the page) is never recorded when it stops
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET origin = '{"runId":null,"rootSessionId":null,"callId":null}'::jsonb, status = 'stopped',
    state = state || '{"stop":{"reason":"budget_exhausted"}}'::jsonb WHERE id = $1`, [started.id]);
  await completions.tick();
  assert.equal((await rowsOf(started.id)).length, 0);
});
