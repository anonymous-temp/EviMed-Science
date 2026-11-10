// The virtual lab on the real path (plan T09, T10; acceptance A07, A08, A09, A12, A18, A19): a VcrStore on PostgreSQL, the real job
// queue and its durable finish hook, the worker's loops, and the real R engine (`service/run_job.R`). Nothing is a stand-in but the
// engine's transport, which runs the job file in a local R process the way the trained-model test does.
//
// What is held: a campaign screens, re-checks finalists at the floor on new streams, and stops with one reason; screening results are
// labelled and never decide a constraint; a duplicate submission is the same campaign; a crash between deciding and enqueueing, and a
// restart of the process, neither reruns a unit nor charges it twice; a cancel stops after the unit in flight; a spent budget stops
// with what ran; a candidate the method cannot compute is set aside and the search goes on; a design experiment compares named arms
// with a saved result attached and not rerun.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { createVcrWorkerLoops } from '../src/vcrWorker.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const run = promisify(execFile);
const engineRequired = process.env.VCR_ENGINE_TESTS === 'required';
const hasR = spawnSync('Rscript', ['-e', 'lib <- Sys.getenv("VCR_R_LIBS", ""); if(nzchar(lib)) .libPaths(c(lib, .libPaths())); quit(status=if(all(vapply(c("jsonlite","digest"),requireNamespace,logical(1),quietly=TRUE)))0 else 1)']).status === 0;
const options = { skip: !engineRequired && (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : !hasR && 'Local R with jsonlite/digest is required'), timeout: 900_000 };
const engineRoot = fileURLToPath(new URL('../../../../项目代码/vcr-engine', import.meta.url));
let database, isolated, root, vcr, study, experiments, loops;
let submitted = 0;
const origin = { userId: 'lab_owner', projectId: 'lab_project', rootSessionId: 'lab_session' };

/** Two-arm t-test designs: power at four sizes, type I error under the null. */
const manifest = (over = {}) => ({
  question: '最小的每组例数，使功效至少 80%，第一类错误不超过 2.5%',
  objective: { measure: 'expected_sample_size', direction: 'minimize', truth: 'alternative' },
  constraints: [
    { measure: 'power', op: '>=', bound: 0.8, kind: 'design', truth: 'alternative' },
    { measure: 'type_one_error', op: '<=', bound: 0.025, kind: 'error_control', truth: 'null', analyticSupport: true },
  ],
  space: { method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 50, nControl: 50 }, endpoint: { type: 'continuous' },
    truth: { effect: 0.5, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 }, performance: ['power', 'type_one_error', 'expected_sample_size'] },
  truths: [{ name: 'alternative', truth: { effect: 0.5, sd: 1 } }, { name: 'null', truth: { effect: 0, sd: 1 } }],
  candidates: [40, 55, 70, 85].map((n) => ({ set: { 'design.nTreat': n, 'design.nControl': n } })) },
  stages: { screening: { replicates: 300 }, final: { count: 2 } },
  budget: { maxCandidates: 4, cpuSeconds: 3000, modelCalls: 0 },
  ...over,
});

/** Run the worker's job loop until the campaign stops or nothing is left to do. @param {string} id */
async function drain(id, { limit = 60, instance = experiments } = {}) {
  for (let i = 0; i < limit; i++) {
    const row = await vcr.store.one('SELECT status FROM evimed_vcr.experiments WHERE id = $1', [id]);
    if (row.status === 'stopped') return;
    const done = await loops.jobs();
    if (!done.claimed && !done.advanced) await instance.repair();
  }
  throw new Error('the campaign did not stop');
}

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrlab');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-lab-'));
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: root, vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  const outputs = new Map();
  vcr.jobs.engine = { configured: () => true, submit: async (/** @type {any} */ job) => {
    submitted += 1;
    const out = path.join(root, 'engine', job.jobId); await fs.mkdir(out, { recursive: true });
    const file = path.join(out, 'job.json'); await fs.writeFile(file, JSON.stringify(job));
    await run('Rscript', [path.join(engineRoot, 'service/run_job.R'), file, out], { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_DATA_ROOT: root, VCR_ENGINE_CORES: '2' }, timeout: 300000 });
    outputs.set(job.jobId, { out, result: JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8')) });
    return { accepted: true, jobId: job.jobId };
  }, status: async (/** @type {string} */ id) => ({ state: outputs.get(id).result.status, progress: { done: 1, total: 1 } }),
  result: async (/** @type {string} */ id) => ({ result: outputs.get(id).result, signed: true }),
  cancel: async () => ({ canceled: true }) };
  experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  loops = createVcrWorkerLoops({ jobs: vcr.jobs, orchestrator: vcr.orchestrator ?? null, store: vcr.store, experiments });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('a campaign screens, re-checks its finalists at the floor on new streams and stops with one reason', options, async () => {
  const started = await experiments.startCampaign(study, manifest(), { userId: origin.userId });
  assert.equal(started.created, true);
  assert.equal(started.status, 'running');
  assert.ok(started.inFlight, 'the first unit is queued at once');
  await drain(started.id);
  const view = await experiments.view(study, started.id);
  assert.equal(view.status, 'stopped');
  assert.equal(view.stop.reason, 'acceptable_precision', JSON.stringify(view.candidates.map((c) => [c.key, c.status, c.reason])));
  // 40 per arm (power about 0.46) is set aside at screening; the two smallest designs that look powered are re-checked
  assert.equal(view.candidates.find((c) => c.key === 'c000').status, 'eliminated');
  assert.equal(view.finalists.length, 2);
  assert.ok(view.best && view.feasible.includes(view.best));
  const best = view.candidates.find((c) => c.key === view.best);
  assert.deepEqual(best.constraints.map((c) => c.final.status), ['pass', 'pass']);
  assert.equal(best.objective.final.stage, 'final');
  // every unit ran once, as an engine job filed under the campaign and out of every card's way
  const jobs = await vcr.store.rows("SELECT id, seed, replicates, scenario, checkpoint FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1", [started.id]);
  assert.equal(jobs.length, 4 + 2 * 2);
  assert.equal(new Set(jobs.map((job) => job.checkpoint.experiment.unitKey)).size, jobs.length);
  const screening = jobs.filter((job) => job.scenario.evaluation?.screeningReplicates);
  const finals = jobs.filter((job) => !job.scenario.evaluation?.screeningReplicates);
  assert.ok(screening.every((job) => Number(job.replicates) === 300));
  assert.ok(finals.every((job) => !screening.some((s) => Number(s.seed) === Number(job.seed))), 'no final unit reused a screening stream');
  const results = await vcr.store.rows("SELECT kind, subject_id, measures FROM evimed_vcr.results WHERE subject_id LIKE $1", [`${started.id}:%`]);
  assert.equal(results.length, jobs.length);
  assert.ok(results.every((row) => row.kind === 'experiment_candidate'));
  // candidates are filed out of the study's own result lists (review P1: a campaign pushed the real results out of the newest 200)
  assert.ok(!(await vcr.store.results(study.id)).some((row) => row.kind === 'experiment_candidate'));
  assert.ok(!(await vcr.store.allResults(study.id)).some((row) => row.kind === 'experiment_candidate'));
  assert.equal((await vcr.store.results(study.id, 'experiment_candidate')).length, results.length);
  const screenRows = results.filter((row) => row.subject_id.includes(':screening:'));
  assert.ok(screenRows.every((row) => row.measures.every((m) => m.precision === 'screening')), 'a screening number is labelled');
  assert.ok(results.filter((row) => row.subject_id.includes(':final:')).every((row) => row.measures.every((m) => m.precision === undefined)));
  // the null finals ran at the null floor
  const nullFinal = await vcr.store.rows("SELECT e.replicates FROM evimed_vcr.executions e JOIN evimed_vcr.jobs j ON j.id = e.job_id WHERE j.checkpoint->'experiment'->>'unitKey' LIKE '%:final:null'");
  assert.ok(nullFinal.length === 2 && nullFinal.every((row) => Number(row.replicates) === 20000));
  assert.ok(view.budget.used.cpuSeconds > 0 && view.budget.used.queueSeconds >= 0 && view.budget.used.units === 8);
  assert.ok(view.premises.some((row) => row.key === 'alpha' && row.decisive));
  assert.ok(view.premises.some((row) => row.key === 'campaign:precision' && /300/.test(row.value)));

  // the same manifest again is the same campaign, and nothing new is queued
  const again = await experiments.startCampaign(study, manifest(), { userId: origin.userId });
  assert.equal(again.id, started.id);
  assert.equal(again.created, false);
  assert.equal(Number((await vcr.store.one("SELECT count(*) AS n FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1", [started.id])).n), 8);
});

test('a crash between deciding and queueing, and a restart, rerun nothing and charge nothing twice', options, async () => {
  const started = await experiments.startCampaign(study, manifest({ question: 'restart', stages: { screening: { replicates: 250 }, final: { count: 1 } } }), { userId: origin.userId });
  // the process died after the decision and before the job id was written down
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = jsonb_set(state, '{inFlight,jobId}', 'null'::jsonb) WHERE id = $1`, [started.id]);
  // a new process: its own instance, the same database
  const restarted = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  await restarted.repair();
  const first = await vcr.store.rows("SELECT id FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1", [started.id]);
  assert.equal(first.length, 1, 'the decided unit is queued under the same key, not a second time');
  const before = submitted;
  await drain(started.id, { instance: restarted });
  const jobs = await vcr.store.rows("SELECT checkpoint->'experiment'->>'unitKey' AS unit, cpu_seconds_used FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1", [started.id]);
  assert.equal(new Set(jobs.map((job) => job.unit)).size, jobs.length, 'one job per unit');
  assert.equal(submitted - before, jobs.length, 'the engine ran each unit once');
  const view = await restarted.view(study, started.id);
  assert.equal(view.budget.used.units, jobs.length);
  const receipts = await vcr.store.rows("SELECT e.cpu_seconds FROM evimed_vcr.executions e JOIN evimed_vcr.jobs j ON j.id = e.job_id WHERE j.checkpoint->'experiment'->>'id' = $1", [started.id]);
  const charged = receipts.reduce((total, row) => total + Number(row.cpu_seconds ?? 0), 0);
  assert.equal(receipts.length, jobs.length, 'one receipt per unit');
  assert.ok(charged > 0 && Math.abs(view.budget.used.cpuSeconds - charged) < 1e-9, 'usage is the sum of the engine receipts, counted once');
});

test('a cancel stops after the unit in flight; a spent budget stops with what ran; an unsupported candidate is set aside', options, async () => {
  const cancelled = await experiments.startCampaign(study, manifest({ question: 'cancel' }), { userId: origin.userId });
  const stopped = await experiments.cancel(study, cancelled.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stop.reason, 'user_cancellation');
  assert.equal(Number((await vcr.store.one("SELECT count(*) AS n FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1 AND state = 'canceled'", [cancelled.id])).n), 1);

  const spent = await experiments.startCampaign(study, manifest({ question: 'budget', budget: { maxCandidates: 4, cpuSeconds: 0.01, modelCalls: 0 } }), { userId: origin.userId });
  await drain(spent.id);
  const poor = await experiments.view(study, spent.id);
  assert.equal(poor.stop.reason, 'budget_exhausted');
  assert.ok(poor.budget.used.units >= 1 && poor.budget.used.replicatesCompleted >= 1, 'what ran is counted');

  const odd = manifest({ question: 'unsupported', space: { ...manifest().space, candidates: [
    { set: { 'design.nTreat': 70, 'design.nControl': 70 } }, { set: { 'design.kind': 'simon_two_stage' } }] }, budget: { maxCandidates: 2, cpuSeconds: 3000 }, stages: { screening: { replicates: 300 }, final: { count: 1 } } });
  const mixed = await experiments.startCampaign(study, odd, { userId: origin.userId });
  await drain(mixed.id);
  const view = await experiments.view(study, mixed.id);
  assert.equal(view.candidates.find((c) => c.key === 'c001').status, 'unsupported');
  assert.equal(view.candidates.find((c) => c.key === 'c000').status, 'evaluated');
  assert.ok(view.stop.reason, 'the search went on past the refusal and stopped by its rules');
});

test('a screening precision block is refused from any caller but a campaign', options, async () => {
  await assert.rejects(vcr.jobs.enqueue({ studyId: study.id, userId: origin.userId, kind: 'design_simulation', inputs: [],
    scenario: { ...manifest().space.scenario, evaluation: { version: 1, screeningReplicates: 300 } } }), { code: 'vcr_job_scenario_invalid' });
  // the programme enqueues internally too: the permission is the campaign's, not the platform's (review eng P1-1)
  await assert.rejects(vcr.jobs.enqueue({ studyId: study.id, userId: origin.userId, kind: 'design_simulation', inputs: [], internal: true,
    scenario: { ...manifest().space.scenario, evaluation: { version: 1, screeningReplicates: 300 } } }), { code: 'vcr_job_scenario_invalid' });
  const checked = await vcr.jobs.validate({ kind: 'design_simulation', studyId: study.id, inputs: [], scenario: { ...manifest().space.scenario, evaluation: { version: 1 } } });
  assert.equal(checked.valid, false);
});

test('a design experiment compares named arms with a saved result attached and not rerun', options, async () => {
  const saved = await vcr.store.one("SELECT r.id FROM evimed_vcr.results r WHERE r.study_id = $1 AND r.subject_id LIKE '%:final:alternative' LIMIT 1", [study.id]);
  assert.ok(saved, 'the first campaign left final results');
  const arm = (n) => ({ ...manifest().space.scenario, design: { kind: 'two_arm_fixed', nTreat: n, nControl: n } });
  const before = submitted;
  const created = await experiments.startExperiment(study, { question: '三种每组例数的功效', arms: [
    { name: '每组 60', method: 'design.simulate', scenario: arm(60) }, { name: '每组 75', method: 'design.simulate', scenario: arm(75) },
    { name: '已复核的方案', resultId: saved.id }], comparison: { measures: ['power', 'expected_sample_size'], reference: '每组 60' } }, { userId: origin.userId });
  assert.equal(created.arms.find((a) => a.name === '已复核的方案').status, 'complete', 'an attached result is read at once');
  for (let i = 0; i < 10 && (await experiments.view(study, created.id)).status === 'running'; i++) await loops.jobs();
  const view = await experiments.view(study, created.id);
  assert.equal(submitted - before, 2, 'the two runnable arms ran; the attached one did not');
  assert.equal(view.status, 'complete');
  const power = view.comparison.find((row) => row.measure === 'power');
  assert.equal(power.arms.length, 3);
  assert.ok(power.arms.every((a) => a.value && a.value.value > 0));
  const pairedArm = power.contrasts.find((c) => c.arm === '每组 75');
  assert.equal(pairedArm.coupling, 'independent', 'two sizes draw differently, so their seeds differ and the errors add');
  assert.ok(view.alignment.every((row) => row.aligned), JSON.stringify(view.alignment));
  assert.ok(view.premises.some((row) => row.key === 'lab:aligned'));
  assert.ok(!view.premises.some((row) => row.key === 'lab:conditional'), 'no generic disclaimer: the alignment sentence and each arm\'s scenario say what the comparison rests on');
  const again = await experiments.startExperiment(study, { question: '三种每组例数的功效', arms: [
    { name: '每组 60', method: 'design.simulate', scenario: arm(60) }, { name: '每组 75', method: 'design.simulate', scenario: arm(75) },
    { name: '已复核的方案', resultId: saved.id }], comparison: { measures: ['power', 'expected_sample_size'], reference: '每组 60' } }, { userId: origin.userId });
  assert.equal(again.id, created.id);
  assert.equal(submitted - before, 2, 'the same experiment again queues nothing new');
});

test('an experiment attaches designs at their normal precision, never people or a screening run (review eng P0-1, stats P2-5)', options, async () => {
  const screened = await vcr.store.one("SELECT id FROM evimed_vcr.results WHERE study_id = $1 AND subject_id LIKE '%:screening:%' LIMIT 1", [study.id]);
  const final = await vcr.store.one("SELECT id FROM evimed_vcr.results WHERE study_id = $1 AND subject_id LIKE '%:final:alternative' LIMIT 1", [study.id]);
  assert.ok(screened && final);
  // a population result of the same study, as a cohort run files it
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id, study_id, execution_id, user_id, kind, subject_id, version, conclusion, counts, measures, diagnostics, tables)
    SELECT 'res_population_small', study_id, execution_id, user_id, 'population', 'pop_small', 1, conclusion, '{"realPatients":3}'::jsonb,
      '[{"name":"cohort_size","value":3}]'::jsonb, '{}'::jsonb, '[]'::jsonb FROM evimed_vcr.results WHERE id = $1`, [final.id]);
  const attach = (/** @type {string} */ id) => experiments.startExperiment(study, { question: 'attach', arms: [{ name: 'A', resultId: final.id }, { name: 'B', resultId: id }],
    comparison: { measures: ['power'], reference: 'A' } }, { userId: origin.userId });
  await assert.rejects(attach('res_population_small'), (error) => /** @type {any} */ (error).issues?.[0]?.code === 'experiment_result_kind_unsupported');
  await assert.rejects(attach(screened.id), (error) => /** @type {any} */ (error).issues?.[0]?.code === 'experiment_result_screening');
  await assert.rejects(experiments.startExperiment(study, { question: 'count', arms: [{ name: 'A', resultId: final.id }, { name: 'B', resultId: final.id }],
    comparison: { measures: ['cohort_size'], reference: 'A' } }, { userId: origin.userId }), (error) => /** @type {any} */ (error).issues?.[0]?.code === 'experiment_measure_unsupported');
});

test('a unit cancelled from outside, or the study stopped, stops the campaign and starts nothing new (review eng P1-2, P2-2)', options, async () => {
  const outside = await experiments.startCampaign(study, manifest({ question: 'outside cancel' }), { userId: origin.userId });
  const flight = (await vcr.store.one('SELECT state FROM evimed_vcr.experiments WHERE id = $1', [outside.id])).state.inFlight;
  assert.ok(flight?.jobId, 'the first unit is queued');
  const before = submitted;
  // a run or the page cancels the unit's job, not the campaign
  await vcr.jobs.cancel(study.id, flight.jobId, { actor: origin.userId });
  for (let i = 0; i < 5; i++) { await loops.jobs(); await experiments.repair(); }
  const view = await experiments.view(study, outside.id);
  assert.equal(view.status, 'stopped');
  assert.equal(view.stop.reason, 'user_cancellation');
  assert.equal(submitted - before, 0, 'no next candidate was started');
  assert.equal(Number((await vcr.store.one("SELECT count(*) AS n FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1", [outside.id])).n), 1);

  // the study's stop arrives while a unit is decided and not yet queued: it is never started
  const decided = await experiments.startCampaign(study, manifest({ question: 'study stop' }), { userId: origin.userId });
  const queued = (await vcr.store.one('SELECT state FROM evimed_vcr.experiments WHERE id = $1', [decided.id])).state.inFlight.jobId;
  // the process died after the decision and before the job was queued: no job runs it, and the campaign's flight has no job id
  await vcr.store.query(`UPDATE evimed_vcr.jobs SET state = 'canceled', finished_at = now() WHERE id = $1`, [queued]);
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = jsonb_set(state, '{inFlight,jobId}', 'null'::jsonb) WHERE id = $1`, [decided.id]);
  const asked = await experiments.cancelStudy(study);
  assert.ok(asked >= 1);
  await experiments.repair();
  const stopped = await experiments.view(study, decided.id);
  assert.equal(stopped.stop?.reason, 'user_cancellation');
  assert.equal(submitted - before, 0, 'the decided unit was never started');
});

test('a campaign whose study was paused under it stops with its own reason instead of retrying the unit forever', options, async () => {
  const held = await experiments.startCampaign(study, manifest({ question: 'paused under it' }), { userId: origin.userId });
  const queued = (await vcr.store.one('SELECT state FROM evimed_vcr.experiments WHERE id = $1', [held.id])).state.inFlight.jobId;
  // the unit was decided and its job lost; the study is paused before the campaign queues it again
  await vcr.store.query(`UPDATE evimed_vcr.jobs SET state = 'canceled', finished_at = now() WHERE id = $1`, [queued]);
  await vcr.store.query(`UPDATE evimed_vcr.experiments SET state = jsonb_set(state, '{inFlight,jobId}', 'null'::jsonb) WHERE id = $1`, [held.id]);
  const status = (await vcr.store.one('SELECT status FROM evimed_vcr.studies WHERE id = $1', [study.id])).status;
  await vcr.store.query(`UPDATE evimed_vcr.studies SET status = 'paused' WHERE id = $1`, [study.id]);
  try {
    await experiments.repair();
    const view = await experiments.view(study, held.id);
    assert.equal(view.status, 'stopped');
    assert.equal(view.stop?.reason, 'study_unavailable');
    assert.match(view.stop?.text ?? '', /暂停/);
  } finally {
    await vcr.store.query(`UPDATE evimed_vcr.studies SET status = $2 WHERE id = $1`, [study.id, status]);
  }
});

test('a comparison asked for a measure the designs do not carry says so, keeps the others, and the list reads the experiment\'s own status (D13, D12)', options, async () => {
  const saved = await vcr.store.one("SELECT r.id FROM evimed_vcr.results r WHERE r.study_id = $1 AND r.subject_id LIKE '%:final:alternative' LIMIT 1", [study.id]);
  const created = await experiments.startExperiment(study, { question: 'missing measure', arms: [{ name: 'X', resultId: saved.id }, { name: 'Y', resultId: saved.id }],
    comparison: { measures: ['power', 'no_such_measure'], reference: 'X' } }, { userId: origin.userId });
  const issue = created.measureIssues.find((entry) => entry.measure === 'no_such_measure');
  assert.ok(issue, 'the measure the arms do not carry is named');
  assert.deepEqual(issue.arms, ['X', 'Y']);
  assert.ok(issue.carried.includes('power'), 'the measures they carry are listed');
  assert.ok(!created.measureIssues.some((entry) => entry.measure === 'power'), 'the measure that exists is not an issue');
  assert.ok(created.premises.some((p) => p.key === 'lab:measure_missing' && p.value.includes(issue.text)), 'the page reads the same sentence');
  const listed = (await experiments.list(study)).find((entry) => entry.id === created.id);
  assert.equal(listed.status, created.status, 'the list says what the experiment says');
  assert.equal(listed.status, 'complete');
});
