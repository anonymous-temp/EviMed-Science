// Review eng round 2, P1-1 (probe review-eng-probes/resume-after-stop.test.mjs as a regression test): the study's stop reaches a comparison
// whose start was interrupted, the resume never queues an arm after a stop, only a comparison a new start wrote and no older than the
// completion window is resumed, and a row that keeps failing goes to the back instead of starving the rest.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = { userId: 'stop_owner', projectId: 'stop_project', rootSessionId: 'stop_session' };
let database, isolated, vcr, study;
const scenario = { design: { kind: 'two_arm_fixed', nTreat: 50, nControl: 50 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5, sd: 1 },
  analysis: { method: 'ttest', alpha: 0.025, sided: 1 }, performance: ['power', 'type_one_error', 'expected_sample_size'] };
const experiment = (question) => ({ question, arms: ['A', 'B', 'C'].map((name, i) => ({ name, method: 'design.simulate',
  scenario: { ...scenario, design: { kind: 'two_arm_fixed', nTreat: 60 + 10 * i, nControl: 60 + 10 * i } } })), comparison: { measures: ['power'], reference: 'A' } });
/** A queue that fails its `dieAt`-th enqueue with an infrastructure error (0: never). */
function dying(dieAt) {
  let calls = 0;
  return { jobCpuSeconds: vcr.jobs.jobCpuSeconds,
    enqueue: async (input) => { if (++calls === dieAt) throw Object.assign(new Error('database unavailable'), { status: 503, code: 'database_unavailable' }); return vcr.jobs.enqueue(input); },
    cancel: (s, j, o) => vcr.jobs.cancel(s, j, o) };
}
const experimentsOf = (jobs, config = {}) => new VcrExperiments({ store: vcr.store, jobs, config: { vcrExperimentResumeAfterMs: 0, ...config }, report: () => {} });
const rowByQuestion = (q) => vcr.store.one(`SELECT * FROM evimed_vcr.experiments WHERE study_id = $1 AND manifest->>'question' = $2`, [study.id, q]);
const openJobs = () => vcr.store.rows(`SELECT id, checkpoint->'experiment'->>'arm' AS arm FROM evimed_vcr.jobs WHERE study_id = $1 AND state IN ('queued','running','awaiting_budget')`, [study.id]);
const stopStudy = async (experiments) => { await experiments.cancelStudy(study); for (const job of await openJobs()) await vcr.jobs.cancel(study.id, job.id, { actor: 'person' }); };

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrstop');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  vcr.jobs.engine = { configured: () => true, submit: async () => ({ accepted: true }), status: async () => ({ state: 'running', progress: { done: 0, total: 1 } }),
    result: async () => ({}), cancel: async () => ({ canceled: true }) };
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('the study stop reaches an interrupted comparison, and the next repair queues no arm after it', options, async () => {
  await assert.rejects(experimentsOf(dying(2)).startExperiment(study, experiment('stop: interrupted'), { userId: origin.userId }), /database unavailable/);
  const experiments = experimentsOf(dying(0));
  assert.ok(await experiments.cancelStudy(study) >= 1, 'the stop asked the comparison to stop');
  for (const job of await openJobs()) await vcr.jobs.cancel(study.id, job.id, { actor: 'person' });
  const row = await rowByQuestion('stop: interrupted');
  assert.equal(row.state.cancelRequested, true);
  const report = await experiments.repair();
  assert.equal(report.resumed, 0);
  assert.deepEqual(await openJobs(), [], 'no arm was queued after the stop');
  assert.equal(Object.keys((await rowByQuestion('stop: interrupted')).state.arms).length, 1, 'the arms recorded before the stop are all there is');
});

test('a comparison with every arm recorded is not marked by a stop, and one with an open arm job is', options, async () => {
  const experiments = experimentsOf(dying(0));
  const done = await experiments.startExperiment(study, experiment('stop: whole'), { userId: origin.userId });
  assert.equal((await rowByQuestion('stop: whole')).state.cancelRequested ?? null, null);
  await experiments.cancelStudy(study);
  assert.equal((await rowByQuestion('stop: whole')).state.cancelRequested, true, 'its arm jobs are open');
  await stopStudy(experiments);
  assert.ok(done.id);
});

test('a comparison older than the completion window, or written by a release without the resume marker, is not resumed', options, async () => {
  await stopStudy(experimentsOf(dying(0)));
  await assert.rejects(experimentsOf(dying(2)).startExperiment(study, experiment('stop: old'), { userId: origin.userId }), /database unavailable/);
  const row = await rowByQuestion('stop: old');
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = $1`, [row.id]);
  await assert.rejects(experimentsOf(dying(2)).startExperiment(study, experiment('stop: marker'), { userId: origin.userId }), /database unavailable/);
  const marked = await rowByQuestion('stop: marker');
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = state - 'resumable' WHERE id = $1`, [marked.id]);
  const report = await experimentsOf(dying(0)).repair();
  assert.equal(report.resumed, 0);
  for (const question of ['stop: old', 'stop: marker']) assert.equal(Object.keys((await rowByQuestion(question)).state.arms).length, 1, `${question}: only the arm its start queued`);
  // a fresh interrupted start with the marker is still resumed
  await assert.rejects(experimentsOf(dying(2)).startExperiment(study, experiment('stop: fresh'), { userId: origin.userId }), /database unavailable/);
  assert.equal((await experimentsOf(dying(0)).repair()).resumed, 1);
  await stopStudy(experimentsOf(dying(0)));
});

test('rows that keep failing do not starve a later resume', options, async () => {
  await stopStudy(experimentsOf(dying(0)));
  for (const question of ['stop: sick 1', 'stop: sick 2']) await assert.rejects(experimentsOf(dying(2)).startExperiment(study, experiment(question), { userId: origin.userId }), /database unavailable/);
  const healthy = experiment('stop: healthy');
  await assert.rejects(experimentsOf(dying(2)).startExperiment(study, healthy, { userId: origin.userId }), /database unavailable/);
  // the two sick rows fail at every resume (the queue is down); the batch holds one row, and the failing ones go to the back
  const down = { jobCpuSeconds: vcr.jobs.jobCpuSeconds, enqueue: async () => { throw Object.assign(new Error('down'), { status: 503, code: 'database_unavailable' }); }, cancel: vcr.jobs.cancel.bind(vcr.jobs) };
  await experimentsOf(down, { vcrCompletionReconcileBatch: 2 }).repair();
  // with the queue back, a batch of one reaches the healthy row because the two that failed were moved behind it
  const report = await experimentsOf(dying(0), { vcrCompletionReconcileBatch: 1 }).repair();
  assert.equal(report.resumed, 1);
  assert.ok((await rowByQuestion('stop: healthy')).state.arms.A, 'the healthy comparison was resumed first');
  await stopStudy(experimentsOf(dying(0)));
});
