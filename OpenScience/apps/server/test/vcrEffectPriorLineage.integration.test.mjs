// Plan R31 completion (stream A4): a scenario takes the drug effect of the Alzheimer simulation from a pooling the study holds through a `result`
// input. Enqueue reads the pooling through the store's guarded read, writes the tier-C distribution into the frozen scenario, and keeps the result's
// lineage on the job, so a source grant withdrawn from the pooling's own lineage makes the job's result unreadable too, like every other lineage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
let database, isolated, root, vcr, study;
const HASH = 'a'.repeat(64);

async function seedHistory(name, n) {
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: study.id, name, allowedUses: ['vcr'], valueSource: 'observed' });
  const rows = Array.from({ length: n }, (_, i) => [`P-${i},2025-12-01,2025-12-01,7`, `P-${i},2026-01-01,2026-01-01,7`]).flat();
  await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: study.id, sourceId: source.id, name: 'events.csv', stream: streamOf(['PATIENT,AT,AVAILABLE,HBA1C', ...rows].join('\n')) });
  const mapped = await vcr.dataPlane.proposeFieldMap({ actor: 'owner', studyId: study.id, sourceId: source.id, columns: [
    { table: 'events.csv', column: 'PATIENT', role: 'subject_key', identifier: true },
    { table: 'events.csv', column: 'AT', role: 'visit_date', timeKind: 'occurred_at', type: 'date' },
    { table: 'events.csv', column: 'AVAILABLE', role: 'other', timeKind: 'visible_at', type: 'date' },
    { table: 'events.csv', column: 'HBA1C', role: 'measurement', parameter: 'HBA1C', unit: '%', type: 'number' }] });
  await vcr.dataPlane.confirmFieldMap({ actor: 'owner', studyId: study.id, sourceId: source.id, hash: mapped.hash });
  const { snapshot } = await vcr.dataPlane.freezeSnapshot({ userId: 'owner', studyId: study.id, sourceId: source.id });
  const history = await vcr.longitudinal.freezeHistory(study, { snapshotId: snapshot.id, asOf: '2026-01-01', mappings: [
    { inputId: `${snapshot.id}:1`, subjectColumn: 'USUBJID', code: 'HbA1c', valueColumn: 'HBA1C', unit: '%', occurredColumn: 'AT', availableColumn: 'AVAILABLE', basis: 'dictionary_stated' }] }, 'owner');
  return { source, history };
}
/** A job that carries patient-derived lineage (a design made from two forecasts): the job a pooling of the researcher's own data would have. */
async function lineageJob(history, tag) {
  const rows = (point) => Array.from({ length: 12 }, (_, i) => ({ subjectKey: `P-${i}`, horizonDays: 30, point: point + i / 10, sd: 1, uncertainty: 'predictive' }));
  const header = { schema: 1, historyId: history.id, origin: history.summary.origin, subjectKeyMode: 'source_identifier', endpoint: { code: 'HbA1c', type: 'continuous', unit: '%' }, horizonsDays: [30] };
  const first = await vcr.longitudinal.importPrediction(study, { ...header, model: { name: 'm', version: `a${tag}` }, rows: rows(6) }, 'owner');
  const second = await vcr.longitudinal.importPrediction(study, { ...header, model: { name: 'm', version: `b${tag}` }, rows: rows(7) }, 'owner');
  const made = await vcr.longitudinal.enqueueDesign(study, { predictionId: first.id, controlPredictionId: second.id, horizonDays: 30 }, 'owner');
  assert.equal(made.available, true, JSON.stringify(made));
  return made.jobId;
}
/** The execution and result the engine would have written, with a receipt that verifies. */
async function fakeResult(jobId, { method, kind, subject, diagnostics }) {
  await vcr.store.query(`INSERT INTO evimed_vcr.executions (id,job_id,study_id,user_id,method,receipt,output_hash) VALUES ($1,$2,$3,'owner',$4,$5::jsonb,$6)`,
    [`exe_${jobId}_${subject}`, jobId, study.id, method, JSON.stringify({ signed: true, hashVerified: true, outputHash: HASH }), HASH]);
  await vcr.store.query(`INSERT INTO evimed_vcr.results (id,study_id,execution_id,user_id,kind,subject_id,measures,counts,diagnostics) VALUES ($1,$2,$3,'owner',$4,$5,'[]','{}',$6::jsonb)`,
    [`res_${jobId}_${subject}`, study.id, `exe_${jobId}_${subject}`, kind, subject, JSON.stringify(diagnostics)]);
  return `res_${jobId}_${subject}`;
}
const POOL = { scale: 'identity', k: 4, endpoint: { unit: 'points' }, distribution: { kind: 'normal', mean: -2.1, sd: 0.8, basis: 'prediction' } };
const scenario = (effectFrom, extra = {}) => ({
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 60, nControl: 60 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } },
  treatment: { symptomatic: { atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: 'assumed' }, ...extra }, effectFrom } });
const enqueue = (node, from = {}, inputs, extra) => vcr.jobs.enqueue({ studyId: study.id, userId: 'owner', kind: 'generate_progression',
  scenario: scenario({ input: node, estimand: { treatment: 'donepezil 10 mg', population: 'mild to moderate AD', endpoint: 'ADAS-cog change at 24 weeks' }, ...from }, extra),
  inputs: inputs ?? [{ kind: 'result', id: node }] });
const row = (id) => vcr.store.one('SELECT scenario, inputs, checkpoint FROM evimed_vcr.jobs WHERE id = $1', [id]);

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrprior');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-effect-prior-'));
  await fs.writeFile(path.join(root, 'providers.json'), JSON.stringify({ providers: [] }));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: root, vcrForecastProvidersFile: path.join(root, 'providers.json'), vcrPublicSimulationsEnabled: true }, productDatabase: database });
  await vcr.store.ready();
  study = await vcr.store.createStudy({ userId: 'owner', projectId: 'effect-prior', name: 'Effect prior', question: 'AD', dataTier: 'T0' });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('a pooling named as a result input becomes the tier-C effect of the frozen scenario, the job carries its lineage, and a withdrawn source takes the job\'s result with it', options, async () => {
  const { source, history } = await seedHistory('Own phase-2 data', 14);
  const pooledJob = await lineageJob(history, 'p');
  const poolId = await fakeResult(pooledJob, { method: 'evidence.pool', kind: 'evidence_pool', subject: 'pool:ad', diagnostics: POOL });
  const node = `result:${poolId}@1`;

  const queued = await enqueue(node);
  const held = await row(queued.job.id);
  const distribution = held.scenario.treatment.symptomatic.pointsAt.distribution;
  assert.equal(held.scenario.treatment.effectFrom, undefined, 'the engine receives a scenario it already understands');
  assert.deepEqual(distribution.parameters, { mean: -2.1, sd: 0.8 });
  assert.equal(distribution.tier, 'C');
  assert.deepEqual([distribution.source.kind, distribution.source.objectRef], ['model_result', poolId]);
  assert.match(distribution.source.note, /donepezil 10 mg; mild to moderate AD; ADAS-cog change at 24 weeks/, 'the estimand is the researcher\'s words');
  assert.doesNotMatch(distribution.source.note, /res_/, 'no id in what a person reads');
  assert.deepEqual(held.inputs.map((input) => [input.kind, input.id]), [['result', node]], 'the result is a frozen input of the job');
  assert.deepEqual(held.checkpoint.resultLineage, [poolId]);
  assert.equal(held.checkpoint.effectPrior.basis, 'prediction');
  assert.equal(held.checkpoint.effectPrior.estimandStated, true);
  // the same pooling is the same job
  assert.equal((await enqueue(node)).job.id, queued.job.id);

  // the job's own result is judged through the pooling it was made from
  const madeId = await fakeResult(queued.job.id, { method: 'patients.progression', kind: 'trial_scenario', subject: 'ad:tier-c', diagnostics: {} });
  assert.equal((await vcr.store.result(study.id, poolId))?.id, poolId);
  assert.equal((await vcr.store.result(study.id, madeId))?.id, madeId);
  await vcr.store.query("UPDATE evimed_vcr.sources SET status='withdrawn' WHERE id=$1", [source.id]);
  assert.equal(await vcr.store.result(study.id, poolId), null, 'the pooling is unreadable once its source grant is withdrawn');
  assert.equal(await vcr.store.result(study.id, madeId), null, 'and so is everything made from it');
  assert.deepEqual((await vcr.store.resultsInLineage(study.id, [{ id: madeId }])).length, 0);
  await assert.rejects(enqueue(node, { estimand: 'another wording' }), (error) => error.code === 'vcr_effect_prior_unavailable', 'a new start cannot use a withdrawn source');
});

test('what cannot be an effect prior is refused by name and nothing else is lost', options, async () => {
  const { history } = await seedHistory('Second source', 14);
  const job = await lineageJob(history, 'q');
  const log = await fakeResult(job, { method: 'evidence.pool', kind: 'evidence_pool', subject: 'pool:log', diagnostics: { ...POOL, scale: 'log', distribution: { kind: 'lognormal', mean: -0.3, sd: 0.3, basis: 'prediction' } } });
  const other = await fakeResult(job, { method: 'design.analytic', kind: 'trial_scenario', subject: 'ts:other', diagnostics: POOL });
  const good = await fakeResult(job, { method: 'evidence.pool', kind: 'evidence_pool', subject: 'pool:good', diagnostics: POOL });
  const refused = async (call, code) => assert.rejects(call, (error) => error.code === code || error.issues?.some((issue) => issue.code === code), code);

  await refused(enqueue(`result:${log}@1`), 'effect_prior_scale_unsupported');
  await refused(enqueue(`result:${other}@1`), 'vcr_effect_prior_not_a_pooling');
  await refused(enqueue(`result:${good}@2`), 'vcr_effect_prior_version_changed');
  await refused(enqueue('result:res_nobody@1'), 'vcr_effect_prior_unavailable');
  await refused(enqueue(`result:${good}@1`, {}, []), 'effect_prior_input_missing');
  await refused(enqueue(`result:${good}@1`, { target: 'mean' }), 'effect_prior_target_unknown');
  await refused(enqueue(`result:${good}@1`, {}, undefined, { pointsAt: { value: -2, basis: 'assumed' } }), 'effect_prior_conflict');
  // the validate answer learns the same refusal before a job is queued
  const checked = await vcr.jobs.validate({ kind: 'generate_progression', studyId: study.id, scenario: scenario({ input: `result:${log}@1` }), inputs: [{ kind: 'result', id: `result:${log}@1` }] });
  assert.equal(checked.valid, false);
  assert.equal(checked.issues[0].code, 'effect_prior_scale_unsupported');
  // an effect taken from a verified pooling on the identity scale is a valid scenario
  const ok = await vcr.jobs.validate({ kind: 'generate_progression', studyId: study.id, scenario: scenario({ input: `result:${good}@1` }), inputs: [{ kind: 'result', id: `result:${good}@1` }] });
  assert.equal(ok.valid, true, JSON.stringify(ok.issues));
});
