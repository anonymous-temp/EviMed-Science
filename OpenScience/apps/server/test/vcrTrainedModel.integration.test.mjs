// A prognostic model trained on the person's own table is a model the platform can apply (review RF2 P1-3), on the real path: the gateway
// handler, a real VcrStore on PostgreSQL, the real queue and the real R engine (`service/run_job.R`). The only stand-in is the data plane's
// resolver, which hands the engine the two tables of a snapshot the way the plane does (a location, a hash, the units of the field map).
//
// Until now training wrote no model row, `apply_prognostic_model` asked for a source-bound model, and `fitResultId` was accepted only for a
// survival fit: the notes said "in the shape model.prognostic_apply takes" and no path reached it. Here the training result is bound by
// `vcr_write what=model` and applied by `vcr_simulate`, and the predictions are the equation's, recomputed by hand.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrGatewayHandler } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const run = promisify(execFile);
const engineRequired = process.env.VCR_ENGINE_TESTS === 'required';
const hasR = spawnSync('Rscript', ['-e', 'lib <- Sys.getenv("VCR_R_LIBS", ""); if(nzchar(lib)) .libPaths(c(lib, .libPaths())); quit(status=if(all(vapply(c("jsonlite","digest","survival"),requireNamespace,logical(1),quietly=TRUE)))0 else 1)']).status === 0;
const options = { skip: !engineRequired && (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : !hasR && 'Local R with jsonlite/digest/survival is required'), timeout: 600_000 };
let database, isolated, root, vcr, study;
const origin = { userId: 'trained_owner', projectId: 'trained_project', rootSessionId: 'trained_session', sessionId: 'trained_session', runId: 'trained_run', callId: 'trained_call' };
const hash = (/** @type {string | Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const engineRoot = fileURLToPath(new URL('../../../../项目代码/vcr-engine', import.meta.url));
/** @type {Record<string, any[]>} */
const snapshots = {};

/** A deterministic stream of uniforms and standard normals. @param {number} seed */
function streams(seed) {
  let state = seed;
  const uniform = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state + 1) / 2147483649; };
  return { uniform, normal: () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()) };
}

/** A subject table in the scratch data plane, and the resolver's entry for it. @param {string} id @param {string[]} lines */
async function writeSubject(id, lines) {
  const dir = path.join(root, 'snapshots', id);
  await fs.mkdir(dir, { recursive: true });
  const text = lines.join('\n');
  await fs.writeFile(path.join(dir, 'subject.csv'), text);
  snapshots[id] = [{ kind: 'analysis_table', id: `${id}:subject`, shape: 'subject', location: `snapshots/${id}/subject.csv`, hash: hash(text), valueSource: 'observed',
    columnUnits: { x1: 'score', x2: 'score' } }];
}

before(async () => {
  if (options.skip) return;
  assert.ok(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'Owned local PostgreSQL is required');
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrtrained');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-trained-'));
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: root, vcrStudyCpuBudget: 12000, vcrJobCpuSeconds: 120, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  // The person's own historical table (a binary outcome that depends on two scores) and a table of other people to predict.
  const { uniform, normal } = streams(4242);
  const rows = ['USUBJID,x1,x2,y'];
  for (let i = 0; i < 400; i += 1) {
    const x1 = Math.round(normal() * 1000) / 1000; const x2 = Math.round(normal() * 1000) / 1000;
    const p = 1 / (1 + Math.exp(-(-0.3 + 0.9 * x1 - 0.5 * x2)));
    rows.push(`H${i},${x1},${x2},${uniform() < p ? 1 : 0}`);
  }
  await writeSubject('snp_hist', rows);
  const fresh = streams(777).normal;
  await writeSubject('snp_new', ['USUBJID,x1,x2', ...Array.from({ length: 60 }, (_, i) => `N${i},${Math.round(fresh() * 1000) / 1000},${Math.round(fresh() * 1000) / 1000}`)]);
  vcr.jobs.dataPlane = { resolveEngineInputs: async (/** @type {any} */ request) => {
    assert.ok(snapshots[request.snapshotId], `an unknown snapshot ${request.snapshotId}`);
    return snapshots[request.snapshotId];
  } };
  // The actual local R numerical process, as the model-science test runs it.
  const outputs = new Map();
  vcr.jobs.engine = { configured: () => true, submit: async (/** @type {any} */ job) => {
    const out = path.join(root, 'engine', job.jobId); await fs.mkdir(out, { recursive: true });
    const file = path.join(out, 'job.json'); await fs.writeFile(file, JSON.stringify(job));
    await run('Rscript', [path.join(engineRoot, 'service/run_job.R'), file, out], { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_DATA_ROOT: root, VCR_ENGINE_CORES: '1' }, timeout: 120000 });
    outputs.set(job.jobId, { out, result: JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8')) });
    return { accepted: true, jobId: job.jobId };
  }, status: async (/** @type {string} */ id) => ({ state: outputs.get(id).result.status, progress: { done: 1, total: 1 } }),
  result: async (/** @type {string} */ id) => ({ result: outputs.get(id).result, signed: true }),
  downloadTable: async (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ { destination, sha256 }) => {
    const data = await fs.readFile(path.join(outputs.get(id).out, `${name}.csv`)); assert.equal(hash(data), sha256); await fs.writeFile(destination, data);
  } };
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

/** @param {string} operation @param {Record<string, any>} body */
async function invoke(operation, body) {
  const handler = createVcrGatewayHandler({ vcrEnabled: true }, { assertActiveModelGatewayToken: () => ({ userId: origin.userId, projectId: origin.projectId }) }, { vcr, resolveInvocation: async () => origin });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url: `/internal/vcr/v1/${operation}`, headers: { authorization: 'Bearer owned-test', 'x-evimed-execution-context': 'owned-test' } });
  /** @type {number | undefined} */ let status; /** @type {any} */ let answer;
  await handler(req, { writeHead: (/** @type {number} */ code) => { status = code; }, end: (/** @type {any} */ bytes) => { answer = JSON.parse(bytes); } });
  return { status, answer };
}
/** @param {string} jobId */
async function finish(jobId) {
  const [job] = await vcr.jobs.claim(); assert.equal(job.id, jobId); await vcr.jobs.advance(job); await vcr.jobs.advance(job);
  const saved = await vcr.jobs.get(study.id, jobId); assert.equal(saved.state, 'succeeded', JSON.stringify(saved.error));
  return vcr.jobs.resultOf(study.id, jobId);
}

const training = {
  inputId: 'snp_hist:subject', idColumn: 'USUBJID', sourceCondition: 'control',
  endpoint: { type: 'binary', outcomeColumn: 'y', horizon: 12, timeUnit: 'months' },
  predictors: [{ column: 'x1', unit: 'score' }, { column: 'x2', unit: 'score' }], folds: 5, comparison: { ranger: false },
};

test('a model trained on the person\'s own table is bound once, labelled, and applied to other people with its own equation (review RF2 P1-3)', options, async () => {
  const started = await invoke('simulate', { action: 'start', kind: 'train_prognostic_model', scenario: training, inputs: [{ kind: 'snapshot', id: 'snp_hist' }] });
  assert.equal(started.status, 200, JSON.stringify(started.answer));
  const trained = await finish(started.answer.data.jobId);
  assert.equal(trained.kind, 'prognostic_training');
  assert.notEqual(trained.conclusion, 'not_estimable', JSON.stringify(trained.diagnostics).slice(0, 400));
  const equation = trained.diagnostics.model.equation;
  assert.equal(equation.family, 'logistic');

  // Training wrote no model row; the run binds the result by `vcr_write what=model`, and nothing it sends is the model.
  assert.equal((await vcr.store.models(origin.userId)).length, 0, 'training alone registers nothing');
  const refused = await invoke('write', { what: 'model', data: { name: '没有这个结果', endpointType: 'binary', card: { trainedResultId: 'res_nothing' } } });
  assert.match(JSON.stringify(refused.answer), /vcr_model_invalid|Select a verified/);
  const written = await invoke('write', { what: 'model', data: { name: '自己训练的 logistic', endpointType: 'binary', card: { trainedResultId: trained.id, equation: { model: { family: 'logistic', intercept: 99, terms: [] } } } } });
  assert.equal(written.status, 200, JSON.stringify(written.answer));
  const [model] = await vcr.store.models(origin.userId);
  assert.equal(model.card.trainedResultId, trained.id);
  assert.equal(model.card.type, 'trained_prognostic_equation');
  assert.equal(model.card.registrationState, 'trained_on_own_data');
  assert.equal(model.card.trainedLabel, '用你自己的历史数据训练，未经外部验证');
  assert.deepEqual(model.card.executionSpec.scenario.model, equation, 'the bound equation is the engine\'s, not the one the call carried');
  assert.ok(model.card.knownLimits.includes('用你自己的历史数据训练，未经外部验证'));
  assert.ok(model.applicability.sources.includes('用你自己的历史数据训练，未经外部验证'));

  // The application: the call names the model and the table; the equation, endpoint, condition and units are filled in by code.
  const apply = { action: 'start', kind: 'apply_prognostic_model', modelId: model.id, modelVersion: model.version, scenario: { inputId: 'snp_new:subject', idColumn: 'USUBJID' }, inputs: [{ kind: 'snapshot', id: 'snp_new' }] };
  assert.equal((await invoke('simulate', { ...apply, modelVersion: 'stale' })).status, 409);
  const applied = await invoke('simulate', apply);
  assert.equal(applied.status, 200, JSON.stringify(applied.answer));
  const prediction = await finish(applied.answer.data.jobId);
  assert.equal(prediction.kind, 'model_prediction');
  assert.equal(prediction.counts.realPatients, 60);
  assert.equal(prediction.diagnostics.sourceModel.id, model.id);
  assert.equal(prediction.diagnostics.sourceModel.source.kind, 'trained_result', 'the result says where its model came from');

  // The predictions are the saved equation's: the mean of the logistic probabilities recomputed by hand over the 60 people.
  const people = (await fs.readFile(path.join(root, 'snapshots', 'snp_new', 'subject.csv'), 'utf8')).split('\n').slice(1).map((line) => line.split(',').map(Number));
  const probability = (/** @type {number[]} */ [, x1, x2]) => {
    const values = { x1, x2 };
    const lp = equation.intercept + equation.terms.reduce((/** @type {number} */ sum, /** @type {any} */ term) => sum + term.coefficient * ((/** @type {Record<string, number>} */ (values))[term.column] - term.center) / term.scale, 0);
    return 1 / (1 + Math.exp(-lp));
  };
  const byHand = people.reduce((sum, row) => sum + probability(row), 0) / people.length;
  const mean = prediction.measures.find((/** @type {any} */ measure) => measure.name === 'predicted_population_mean');
  assert.ok(Math.abs(mean.value - byHand) < 1e-9, `the engine's mean ${mean.value} against the equation's ${byHand}`);

  // A scenario that carries another equation is refused: the bound model is the model, and a changed equation is a new version.
  const changed = { ...apply.scenario, model: { ...equation, intercept: equation.intercept + 1 }, endpoint: trained.diagnostics.model.endpoint, sourceCondition: 'control', inputUnits: { x1: 'score', x2: 'score' } };
  const swapped = await invoke('simulate', { ...apply, scenario: changed });
  assert.equal(swapped.status, 400, JSON.stringify(swapped.answer));
  assert.match(JSON.stringify(swapped.answer), /vcr_model_invalid|changed/);

  // The model is immutable: the result it is bound to stays the model after the person trains again.
  const again = await invoke('simulate', { action: 'start', kind: 'train_prognostic_model', scenario: { ...training, folds: 4 }, inputs: [{ kind: 'snapshot', id: 'snp_hist' }] });
  assert.equal(again.status, 200, JSON.stringify(again.answer));
  await finish(again.answer.data.jobId);
  const stillApplies = await invoke('simulate', { ...apply, scenario: { ...apply.scenario, idColumn: 'USUBJID' } });
  assert.equal(stillApplies.status, 200, JSON.stringify(stillApplies.answer));
  assert.equal((await vcr.store.models(origin.userId)).length, 1);
});

test('a training that was refused is not a model, and a result that is not a training is not one either (review RF2 P1-3)', options, async () => {
  const sparse = ['USUBJID,x1,x2,y', ...Array.from({ length: 200 }, (_, i) => `S${i},${(i % 17) / 10},${(i % 13) / 10},${i < 3 ? 1 : 0}`)];
  await writeSubject('snp_sparse', sparse);
  const started = await invoke('simulate', { action: 'start', kind: 'train_prognostic_model', scenario: { ...training, inputId: 'snp_sparse:subject' }, inputs: [{ kind: 'snapshot', id: 'snp_sparse' }] });
  assert.equal(started.status, 200, JSON.stringify(started.answer));
  const refused = await finish(started.answer.data.jobId);
  assert.equal(refused.conclusion, 'not_estimable');
  const model = await invoke('write', { what: 'model', data: { name: '没有训练出来', endpointType: 'binary', card: { trainedResultId: refused.id } } });
  assert.match(JSON.stringify(model.answer), /vcr_model_invalid|Select a verified/);
});
