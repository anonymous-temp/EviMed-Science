// The individualized forecast computed inside the deployment (plan R32, compute path), on the real path: the real job queue on PostgreSQL, the real
// longitudinal module and the local forecast provider, and the real R engine (`service/run_job.R`). The only stand-in is the engine's transport:
// `submit` runs `Rscript service/run_job.R` on the frozen job and `downloadTable` copies the kept table, as the engine service does.
//
// What is held here: a batch through the local provider gives one row per person and horizon, the batch accounting adds up (people the engine could
// not forecast are rejected with its reason, people with no event at all too), the claim sentence follows the frozen R33 evaluation for the method
// and endpoint that ran, no record after the origin reaches the engine's table, a cancel reaches the engine job, a withdrawn source makes both the
// prediction and the engine job's result unreadable, and the Alzheimer family runs the same way with its own premise.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { VcrOrchestrator } from '../src/vcrOrchestrator.mjs';

const run = promisify(execFile);
const engineRequired = process.env.VCR_ENGINE_TESTS === 'required';
const hasR = spawnSync('Rscript', ['-e', 'lib <- Sys.getenv("VCR_R_LIBS", ""); if(nzchar(lib)) .libPaths(c(lib, .libPaths())); quit(status=if(all(vapply(c("jsonlite","digest","survival"),requireNamespace,logical(1),quietly=TRUE))) 0 else 1)'], { stdio: 'ignore' }).status === 0;
const options = { skip: !engineRequired && (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'An isolated test PostgreSQL is required' : !hasR && 'Local R with jsonlite/digest/survival is required'), timeout: 600_000 };
const engineRoot = fileURLToPath(new URL('../../../../项目代码/vcr-engine', import.meta.url));
const id = n => `P${String(n).padStart(3, '0')}`;
const PEOPLE = 40;
let database, isolated, root, vcr, study, source, snapshot, history;
/** @type {Map<string,{out:string,result:any}>} */ const outputs = new Map();
let held = null;   // a promise the fake transport waits for before it runs (the cancel test)

/** A deterministic stream of uniforms and standard normals. @param {number} seed */
function streams(seed) {
  let state = seed;
  const uniform = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state + 1) / 2147483649; };
  return { uniform, normal: () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()) };
}
const mapping = () => ({ inputId: `${snapshot.id}:1`, subjectColumn: 'PATIENT', codeColumn: 'CODE', valueColumn: 'VALUE', unitColumn: 'UNIT', occurredColumn: 'AT', availableColumn: 'AVAILABLE', basis: 'dictionary_stated' });

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrindiv');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-individualize-'));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: root, vcrStudyCpuBudget: 12000, vcrJobCpuSeconds: 120, vcrMaxConcurrentJobs: 1 }, productDatabase: database });
  vcr.orchestrator = new VcrOrchestrator({ store: vcr.store, jobs: vcr.jobs, config: {}, dispatchRun: null });
  await vcr.store.ready();
  vcr.jobs.engine = { configured: () => true,
    submit: async (/** @type {any} */ job) => {
      if (held) await held;
      const out = path.join(root, 'engine', job.jobId); await fs.mkdir(out, { recursive: true });
      const file = path.join(out, 'job.json'); await fs.writeFile(file, JSON.stringify(job));
      await run('Rscript', [path.join(engineRoot, 'service/run_job.R'), file, out], { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_DATA_ROOT: root, VCR_ENGINE_CORES: '1' }, timeout: 120000 });
      outputs.set(job.jobId, { out, result: JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8')) });
      return { accepted: true, jobId: job.jobId };
    },
    status: async (/** @type {string} */ jobId) => ({ state: outputs.get(jobId)?.result.status ?? 'running', progress: { done: 1, total: 1 } }),
    result: async (/** @type {string} */ jobId) => ({ result: outputs.get(jobId)?.result, signed: true }),
    cancel: async () => ({}),
    downloadTable: async (/** @type {string} */ jobId, /** @type {string} */ name, /** @type {any} */ { destination }) => { await fs.writeFile(destination, await fs.readFile(path.join(/** @type {any} */ (outputs.get(jobId)).out, `${name}.csv`))); } };
  study = await vcr.store.createStudy({ userId: 'owner', projectId: 'synthetic-individualize', name: 'Individualized forecasts', question: 'CD4 forecast per person', dataTier: 'T0' });
  source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: study.id, name: 'Authored synthetic CD4 history', allowedUses: ['vcr'], valueSource: 'synthetic' });
  // PEOPLE people with four CD4 visits before the origin (a straight line each, with noise) and four bilirubin values, a lab value of 9999 after the origin
  // for the first five, three people with only a weight, and one whose only CD4 is after the origin
  const { normal } = streams(515);
  const rows = ['PATIENT,AT,AVAILABLE,CODE,VALUE,UNIT'];
  const visits = ['2025-07-01', '2025-09-01', '2025-11-01', '2025-12-15'];
  for (let i = 0; i < PEOPLE; i++) {
    const b0 = 420 + 60 * normal(), b1 = 20 * normal();
    visits.forEach((at, k) => {
      const t = (Date.parse(at) - Date.parse('2026-01-01')) / (365.25 * 86_400_000);
      rows.push(`${id(i)},${at},${at},cd4,${(b0 + b1 * t + 25 * normal()).toFixed(2)},cells/uL`);
      rows.push(`${id(i)},${at},${at},bilirubin,${(1.2 + 0.3 * normal() + 0.1 * k).toFixed(3)},mg/dL`);
    });
    if (i < 5) rows.push(`${id(i)},2026-02-01,2026-02-01,cd4,9999,cells/uL`);
  }
  for (let i = PEOPLE; i < PEOPLE + 3; i++) rows.push(`${id(i)},2025-12-01,2025-12-02,weight,70,kg`);
  rows.push(`${id(PEOPLE + 3)},2026-03-01,2026-03-01,cd4,500,cells/uL`);
  await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: study.id, sourceId: source.id, name: 'events.csv', stream: streamOf(rows.join('\n')) });
  const mapped = await vcr.dataPlane.proposeFieldMap({ actor: 'owner', studyId: study.id, sourceId: source.id, columns: [
    { table: 'events.csv', column: 'PATIENT', role: 'subject_key', identifier: true },
    { table: 'events.csv', column: 'AT', role: 'visit_date', timeKind: 'occurred_at', type: 'date' },
    { table: 'events.csv', column: 'AVAILABLE', role: 'other', timeKind: 'visible_at', type: 'date' },
    { table: 'events.csv', column: 'CODE', role: 'other', type: 'text' },
    { table: 'events.csv', column: 'VALUE', role: 'other', type: 'number' },
    { table: 'events.csv', column: 'UNIT', role: 'other', type: 'text' },
  ] });
  await vcr.dataPlane.confirmFieldMap({ actor: 'owner', studyId: study.id, sourceId: source.id, hash: mapped.hash });
  snapshot = (await vcr.dataPlane.freezeSnapshot({ userId: 'owner', studyId: study.id, sourceId: source.id })).snapshot;
  history = await vcr.longitudinal.freezeHistory(study, { snapshotId: snapshot.id, asOf: '2026-01-01', mappings: [mapping()] }, 'owner');
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

/** Drive both lanes the way the worker's two loops do, until `done()` says the forecast is over. @param {() => boolean} done */
async function pump(done) {
  const methods = Object.keys(vcr.jobs.localExecutors);
  const lane = async (/** @type {string} */ name) => {
    while (!done()) {
      // what the worker's job loop does: the jobs this lane newly claimed and the ones it already holds, each pushed one step
      const claimed = await vcr.jobs.claim({ lane: name });
      const running = await vcr.store.rows("SELECT id,method,kind FROM evimed_vcr.jobs WHERE state='running' AND lease_owner=$1 LIMIT 20", [vcr.jobs.owner]);
      const selected = [...claimed, ...running.filter((/** @type {any} */ row) => !claimed.some((/** @type {any} */ job) => job.id === String(row.id)) && (methods.includes(String(row.method)) ? 'local' : 'engine') === name)];
      await Promise.allSettled(selected.map(job => vcr.jobs.advance(job)));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await Promise.all([lane('local'), lane('engine')]);
}
const request = (extra = {}) => ({ kind: 'forecast_trajectories', scenario: { historyId: history.id, providerId: 'evimed-individualize-linear-mixed', endpoint: { code: 'cd4', type: 'continuous', unit: 'cells/uL' }, horizonsDays: [30, 90], ...extra } });
async function forecast(req = request()) {
  const queued = await vcr.longitudinal.prepare(study, req, 'owner');
  let finished = false;
  const driving = pump(() => finished);
  // the forecast job is a local job that waits for the engine job: wait for ITS end
  for (let waited = 0; waited < 600; waited++) {
    const job = await vcr.jobs.get(study.id, queued.job.id);
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  finished = true; await driving;
  return { queued, job: await vcr.jobs.get(study.id, queued.job.id) };
}

test('the local providers are listed as local, with no destination, and declare that they use the person\'s own history', options, async () => {
  const listed = (await vcr.longitudinal.providers.list()).filter((/** @type {any} */ p) => p.availability === 'local_engine');
  assert.deepEqual(listed.map((/** @type {any} */ p) => p.id).sort(), ['evimed-individualize-beta-logit', 'evimed-individualize-linear-mixed']);
  assert.ok(listed.every((/** @type {any} */ p) => p.destination === null && p.conditioning === 'history' && p.individualizationMethod));
});

test('a batch through the local provider: one row per person and horizon, every person accounted for, the claim sentence follows the evaluation of the method and the endpoint', options, async () => {
  const { queued, job } = await forecast();
  assert.equal(job.state, 'succeeded', JSON.stringify(job));
  const result = await vcr.jobs.resultOf(study.id, queued.job.id);
  const summary = result.diagnostics.longitudinal.summary;
  // 43 people in the history: 40 with CD4 of their own and three with a weight only (the one whose only CD4 is after the origin is not in a history cut there)
  assert.deepEqual(summary.accounting, { submitted: PEOPLE + 3, admitted: PEOPLE + 3, completed: PEOPLE, rejected: 3, failed: 0, unprocessed: 0, partial: 0 });
  assert.equal(summary.accounting.submitted, summary.accounting.completed + summary.accounting.rejected + summary.accounting.failed + summary.accounting.unprocessed, 'the identity');
  assert.deepEqual(summary.accountingReasons, { no_own_history: 3 });
  const page = await vcr.longitudinal.subjectPage(study, result.diagnostics.longitudinal.id, 'owner', { status: 'completed', limit: 200 });
  assert.equal(page.lines.length, PEOPLE);
  for (const line of page.lines) {
    const rows = page.trajectories[line.subjectKey];
    assert.deepEqual(rows.map((/** @type {any} */ r) => r.horizonDays), [30, 90]);
    assert.ok(rows.every((/** @type {any} */ r) => Number.isFinite(r.point) && r.sd > 0 && r.quantiles.length === 5 && r.uncertainty === 'predictive'));
    assert.ok(rows.every((/** @type {any} */ r) => r.point > 100 && r.point < 800), 'a CD4 forecast in the range of the people (not the 9999 after the origin)');
  }
  assert.ok(!JSON.stringify(summary).includes('P0'), 'a summary never holds a person key');
  // the claim: this method on CD4 is the one the frozen evaluation found helpful, and the sentence names the endpoint
  const claim = summary.premises.find((/** @type {any} */ p) => p.key === 'claim:individualized_forecast');
  assert.ok(claim && claim.decisive && claim.value.includes('小于') && claim.value.includes('CD4 计数'), JSON.stringify(summary.premises));
  assert.equal(summary.usesOwnHistory, true);
  assert.equal(summary.individualEvaluation.method, 'lmm_empirical_bayes');
  assert.equal(summary.individualEvaluation.helped, true);
  assert.ok(summary.premises.some((/** @type {any} */ p) => p.key === 'use:individual_fit_on_batch'), 'the batch-fit premise is said');
  const receipt = result.diagnostics.longitudinal.summary.actualProvider[0];
  assert.equal(receipt.provider, 'evimed-individualize-linear-mixed');
  // nothing after the origin reached the engine's table, and no person identifier of the source is in it
  const views = path.join(root, 'studies', study.id, 'views', 'individualize');
  const files = await fs.readdir(views);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const text = await fs.readFile(path.join(views, file), 'utf8');
    assert.ok(!text.includes('9999') && !/\bP0\d\d\b/.test(text), 'no record after the origin and no source identifier');
    assert.match(text.split('\n')[0], /^subject,code,value,day$/);
    assert.ok(text.split('\n').slice(1).filter(Boolean).every(line => Number(line.split(',')[3]) <= 0), 'every day is at or before the origin');
  }
});

test('the claim names the endpoint the evaluation found no help on, and a second request is a new version the first does not hide', options, async () => {
  const first = (await vcr.longitudinal.view(study, { kind: 'prediction', limit: 50 })).records;
  const { queued, job } = await forecast(request({ endpoint: { code: 'bilirubin', type: 'continuous', unit: 'mg/dL' } }));
  assert.equal(job.state, 'succeeded', JSON.stringify(job));
  const summary = (await vcr.jobs.resultOf(study.id, queued.job.id)).diagnostics.longitudinal.summary;
  assert.equal(summary.individualEvaluation.family, 'serum_bilirubin');
  assert.equal(summary.individualEvaluation.helped, false);
  const claim = summary.premises.find((/** @type {any} */ p) => p.key === 'claim:individualized_forecast');
  assert.ok(claim && claim.decisive && claim.value.includes('不'), claim?.value);
  assert.ok((await vcr.longitudinal.view(study, { kind: 'prediction', limit: 50 })).records.length > first.length);
});

test('the Alzheimer family runs the same way: its own premise, no finding behind its claim, a person without covariates is rejected with the reason', options, async () => {
  const ad = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: study.id, name: 'Authored synthetic ADAS-cog history', allowedUses: ['vcr'], valueSource: 'synthetic' });
  const { normal, uniform } = streams(77);
  const rows = ['PATIENT,AT,AVAILABLE,CODE,VALUE,UNIT'];
  for (let i = 0; i < 12; i++) {
    const at = ['2025-07-01', '2025-10-01', '2025-12-30'];
    at.forEach((day, k) => rows.push(`${id(i)},${day},${day},adas_cog_11,${Math.max(2, Math.min(60, 22 + 4 * k + 3 * normal())).toFixed(1)},points`));
    if (i !== 3) { for (const [code, value] of [['mmse', 16 + Math.floor(uniform() * 10)], ['age', 65 + Math.floor(uniform() * 20)], ['apoe4', Math.floor(uniform() * 3)], ['female', uniform() < 0.5 ? 1 : 0]]) rows.push(`${id(i)},2025-07-01,2025-07-01,${code},${value},unit`); }
  }
  await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: study.id, sourceId: ad.id, name: 'ad.csv', stream: streamOf(rows.join('\n')) });
  const mapped = await vcr.dataPlane.proposeFieldMap({ actor: 'owner', studyId: study.id, sourceId: ad.id, columns: [
    { table: 'ad.csv', column: 'PATIENT', role: 'subject_key', identifier: true },
    { table: 'ad.csv', column: 'AT', role: 'visit_date', timeKind: 'occurred_at', type: 'date' },
    { table: 'ad.csv', column: 'AVAILABLE', role: 'other', timeKind: 'visible_at', type: 'date' },
    { table: 'ad.csv', column: 'CODE', role: 'other', type: 'text' },
    { table: 'ad.csv', column: 'VALUE', role: 'other', type: 'number' },
    { table: 'ad.csv', column: 'UNIT', role: 'other', type: 'text' },
  ] });
  await vcr.dataPlane.confirmFieldMap({ actor: 'owner', studyId: study.id, sourceId: ad.id, hash: mapped.hash });
  const adSnapshot = (await vcr.dataPlane.freezeSnapshot({ userId: 'owner', studyId: study.id, sourceId: ad.id })).snapshot;
  const adHistory = await vcr.longitudinal.freezeHistory(study, { snapshotId: adSnapshot.id, asOf: '2026-01-01', mappings: [{ ...mapping(), inputId: `${adSnapshot.id}:1` }] }, 'owner');
  const { queued, job } = await forecast({ kind: 'forecast_trajectories', scenario: { historyId: adHistory.id, providerId: 'evimed-individualize-beta-logit', endpoint: { code: 'adas_cog_11', type: 'continuous', unit: 'points' }, horizonsDays: [91, 182], samples: 200 } });
  assert.equal(job.state, 'succeeded', JSON.stringify(job));
  const summary = (await vcr.jobs.resultOf(study.id, queued.job.id)).diagnostics.longitudinal.summary;
  assert.deepEqual(summary.accounting, { submitted: 12, admitted: 12, completed: 11, rejected: 1, failed: 0, unprocessed: 0, partial: 0 });
  assert.deepEqual(summary.accountingReasons, { covariates_missing: 1 });
  assert.equal(summary.individualEvaluation.helped, null, 'no real-data finding exists for this model');
  assert.ok(summary.premises.some((/** @type {any} */ p) => p.key === 'use:individual_week_zero'));
  const claim = summary.premises.find((/** @type {any} */ p) => p.key === 'claim:individualized_forecast');
  assert.ok(claim && claim.decisive && claim.value.includes('没有做过个体化预测的对照评估'), JSON.stringify(summary.premises));
});

test('a cancel of the forecast reaches the engine job, and what is saved holds no forecast', options, async () => {
  const before = (await vcr.longitudinal.view(study, { kind: 'prediction', limit: 100 })).records.length;
  let release = () => {};
  held = new Promise(resolve => { release = () => resolve(undefined); });
  const queued = await vcr.longitudinal.prepare(study, request({ horizonsDays: [14, 28] }), 'owner');
  let finished = false;
  const driving = pump(() => finished);
  // wait until the engine job exists, then cancel the forecast job
  let engineJob = null;
  for (let waited = 0; waited < 100 && !engineJob; waited++) {
    engineJob = (await vcr.store.rows(`SELECT id,state FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='individualize_forecast' ORDER BY created_at DESC LIMIT 1`, [study.id]))[0]
      ?? null;
    if (engineJob && engineJob.id && (await vcr.jobs.get(study.id, queued.job.id)).state === 'running') break;
    engineJob = null;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(engineJob, 'the forecast queued an engine job');
  await vcr.jobs.cancel(study.id, queued.job.id, { actor: 'owner' });
  for (let waited = 0; waited < 100; waited++) {
    if ((await vcr.jobs.get(study.id, engineJob.id)).state === 'canceled') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  release(); held = null; finished = true; await driving;
  assert.equal((await vcr.jobs.get(study.id, queued.job.id)).state, 'canceled');
  assert.equal((await vcr.jobs.get(study.id, engineJob.id)).state, 'canceled');
  // a stopped forecast keeps its accounting, as a cloud one does: whatever was saved holds no forecast row and every person is still counted
  const after = (await vcr.longitudinal.view(study, { kind: 'prediction', limit: 100 })).records;
  const added = after.filter((/** @type {any} */ r) => r.summary?.jobId === queued.job.id);
  assert.ok(after.length - before === added.length && added.length <= 1);
  for (const record of added) assert.deepEqual([record.summary.accepted, record.summary.accounting.completed, record.summary.accounting.unprocessed], [0, 0, record.summary.accounting.submitted]);
});

test('a withdrawn source makes the prediction and the engine job\'s result unreadable (lineage), and a new forecast of it is refused', options, async () => {
  const records = (await vcr.longitudinal.view(study, { kind: 'prediction', limit: 100 })).records.filter((/** @type {any} */ r) => r.summary?.usesOwnHistory === true);
  assert.ok(records.length >= 2);
  const prediction = records.find((/** @type {any} */ r) => r.summary.historyId === history.id) ?? records[0];
  const engineJobs = await vcr.store.rows(`SELECT j.id FROM evimed_vcr.jobs j WHERE j.study_id=$1 AND j.kind='individualize_forecast' AND j.state='succeeded' ORDER BY created_at LIMIT 1`, [study.id]);
  const engineJob = engineJobs[0];
  assert.ok(engineJob);
  assert.ok(await vcr.store.resultOfJob(study.id, engineJob.id), 'readable before');
  await vcr.longitudinal.artifacts.read(study, prediction.id, 'owner');
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1", [source.id]);
  assert.equal(await vcr.store.resultOfJob(study.id, engineJob.id), null, 'the engine job\'s result is unreadable');
  await assert.rejects(() => vcr.longitudinal.artifacts.read(study, prediction.id, 'owner'), (/** @type {any} */ error) => /withdrawn/.test(String(error.code)) && error.status === 403);
  await assert.rejects(() => vcr.longitudinal.prepare(study, request({ horizonsDays: [45] }), 'owner'), (/** @type {any} */ error) => /withdrawn/.test(String(error.code)));
});
