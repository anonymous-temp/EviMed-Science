// The Alzheimer disease-response trial in the lab (plan T09, second half): three drug hypotheses as arms of one experiment and a design
// search over enrolment, both on the real R engine and the real job queue. Skipped without an owned PostgreSQL and R.
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

/** The Alzheimer trial: the CAMD model over 78 weeks, with the drug hypothesis a world or an arm states. */
const trial = (treatment = {}, over = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 100, nControl: 100 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
  treatment, analysis: { kind: 'change', visit: 78, alpha: 0.05 }, ...over,
});
const SYMPTOMATIC = { symptomatic: { pointsAt: { value: -2.5, basis: 'assumed' }, atWeek: 24, referenceAdas: 25, et50Weeks: { value: 1, basis: 'assumed' } } };
const MODIFYING = { diseaseModifying: { fraction: { value: 0.3, basis: 'assumed' } } };

/** Run the worker's job loop until the campaign stops. @param {string} id */
async function drain(id, { limit = 60 } = {}) {
  for (let i = 0; i < limit; i++) {
    const row = await vcr.store.one('SELECT status FROM evimed_vcr.experiments WHERE id = $1', [id]);
    if (row.status === 'stopped') return;
    const done = await loops.jobs();
    if (!done.claimed && !done.advanced) await experiments.repair();
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


test('three Alzheimer hypotheses run as arms of one experiment on the real engine and read back in the one premises block', options, async () => {
  const arms = [{ name: '安慰剂', method: 'patients.progression', scenario: trial({}) }, { name: '对症假设', method: 'patients.progression', scenario: trial(SYMPTOMATIC) },
    { name: '改病假设', method: 'patients.progression', scenario: trial(MODIFYING) }];
  const input = { question: '三种药物效果假设下，同一个试验会看到什么', arms, comparison: { measures: ['power', 'type_one_error', 'expected_difference'], reference: '安慰剂' } };
  const created = await experiments.startExperiment(study, input, { userId: origin.userId });
  assert.equal(created.experimentKind, 'disease');
  for (let i = 0; i < 12 && (await experiments.view(study, created.id)).status === 'running'; i++) await loops.jobs();
  const view = await experiments.view(study, created.id);
  assert.equal(view.status, 'complete', JSON.stringify(view.arms.map((a) => a.refused)));
  assert.deepEqual(view.arms.map((a) => [a.name, a.status, a.hypothesis.kind, a.refused]), [['安慰剂', 'complete', 'none', null], ['对症假设', 'complete', 'symptomatic', null], ['改病假设', 'complete', 'disease_modifying', null]]);
  const power = view.comparison.find((row) => row.measure === 'power');
  assert.equal(power.arms.find((a) => a.name === '安慰剂').value, null, 'the arm with no drug has a type I error, not a power');
  assert.ok(power.arms.find((a) => a.name === '对症假设').value.value > 0.05);
  assert.ok(view.comparison.find((row) => row.measure === 'type_one_error').arms.find((a) => a.name === '安慰剂').value);
  const difference = view.comparison.find((row) => row.measure === 'expected_difference');
  assert.equal(difference.contrasts.find((c) => c.arm === '对症假设').coupling, 'exact');
  assert.ok(difference.contrasts.find((c) => c.arm === '对症假设').difference.value < 0, 'the symptomatic hypothesis lowers the score against no drug');
  assert.ok(view.arms.every((a) => a.trajectory.length === 4 && a.trajectory[0].visit === 0));
  // Each arm's difference from the reference arm at every visit is said by code from the two calculated courses (live D6, 2026-11-07: a reply
  // compared three Alzheimer arms by subtracting the means itself), and the reference arm has none.
  const placebo = view.arms.find((a) => a.name === '安慰剂');
  assert.ok(placebo.trajectory.every((/** @type {any} */ point) => !('againstReference' in point)));
  for (const arm of view.arms.filter((a) => a !== placebo)) {
    arm.trajectory.forEach((/** @type {any} */ point, /** @type {number} */ at) => assert.equal(point.againstReference, point.treated - placebo.trajectory[at].treated, `${arm.name} week ${point.visit}`));
    assert.ok(Math.abs(arm.trajectory[0].againstReference) < 1e-9, 'the arms start alike');
  }
  assert.ok(view.arms.find((a) => a.name === '对症假设').trajectory[1].againstReference < 0, 'the symptomatic hypothesis is below no drug at week 26');
  assert.ok(view.alignment.every((row) => row.aligned), JSON.stringify(view.alignment));
  const keys = view.premises.map((row) => row.key);
  for (const key of ['lab:aligned', 'progression:ad:effect', 'progression:ad:parameters', 'progression:ad:scope', 'progression:ad:regulatory']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.includes('lab:conditional'));
  assert.ok(view.premises.filter((row) => row.decisive).length <= 5);
  assert.ok(!view.premises.find((row) => row.key === 'progression:ad:regulatory').decisive);
  const again = await experiments.startExperiment(study, input, { userId: origin.userId });
  assert.equal(again.id, created.id, 'the same hypotheses again are the same experiment');
  // an edited hypothesis is a new experiment; the first one reads back unchanged
  const edited = await experiments.startExperiment(study, { ...input, arms: [arms[0], { ...arms[1], scenario: trial({ symptomatic: { ...SYMPTOMATIC.symptomatic, pointsAt: { value: -4, basis: 'assumed' } } }) }, arms[2]] }, { userId: origin.userId });
  assert.notEqual(edited.id, created.id);
  assert.deepEqual((await experiments.view(study, created.id)).arms.map((a) => a.resultId), view.arms.map((a) => a.resultId));
});

test('a design search over enrolment under the Alzheimer model runs every candidate at the engine floor and stops with one reason', options, async () => {
  const campaign = {
    question: '功效至少 30% 的最小入组',
    objective: { measure: 'total_sample_size', direction: 'minimize', truth: 'drug' },
    constraints: [{ measure: 'power', op: '>=', bound: 0.3, kind: 'design', truth: 'drug' }],
    space: { method: 'patients.progression', scenario: (({ treatment: _t, ...rest }) => rest)(trial()),
      truths: [{ name: 'drug', truth: { ...SYMPTOMATIC, ...MODIFYING } }],
      candidates: [30, 60, 120].map((n) => ({ name: `${n}/arm`, set: { 'design.nTreat': n, 'design.nControl': n } })) },
    stages: { final: { count: 3 } }, budget: { maxCandidates: 3, cpuSeconds: 3000, modelCalls: 0 },
  };
  const started = await experiments.startCampaign(study, campaign, { userId: origin.userId });
  await drain(started.id);
  const view = await experiments.view(study, started.id);
  assert.equal(view.stop.reason, 'acceptable_precision');
  assert.equal(view.method, 'patients.progression');
  assert.equal(view.candidates.length, 3);
  assert.ok(view.candidates.every((c) => c.stage === 'final' && c.objective.final.value === ['30', '60', '120'].map(Number).map((n) => 2 * n)[c.index]), 'the enrolment is the scenario\'s own arithmetic');
  const power = view.candidates.map((c) => c.constraints[0].final);
  assert.ok(power.every((verdict) => verdict.status === 'pass' || verdict.status === 'fail' || verdict.status === 'inconclusive'));
  assert.ok(view.best, 'a 30% power bound is met by some candidate');
  assert.ok(['c000', 'c001', 'c002'].includes(view.best));
  const keys = view.premises.map((row) => row.key);
  for (const key of ['campaign:bound', 'progression:ad:effect', 'progression:ad:parameters', 'progression:ad:scope']) assert.ok(keys.includes(key), key);
  assert.ok(view.premises.filter((row) => row.decisive).length <= 5);
  const submittedBefore = submitted;
  await experiments.startCampaign(study, campaign, { userId: origin.userId });
  assert.equal(submitted, submittedBefore, 'the same search again queues nothing new');
});
