// One executable set of patients (round 2, R23), on PostgreSQL with the real job queue and a deterministic engine double: the record of virtual
// people is asked for once and read back, a comparison that names it hands the same table to every arm with the same seed, an unknown or foreign
// record is refused before anything is frozen, a population version's covariates reach the instantiate job as its generated table, and an
// observed cohort is refused.
//
// Held: the instantiate job (scenario, kept table, deduplicated by its seed); the record's view (people, parameter set, current); the arms' jobs
// (an `analysis_table` input of shape `subject` with the record's hash and a synthetic source, `people` in the scenario, one seed, no group sizes in
// a paired run and the group sizes in a resampled one); the refusals (unknown record, people on a design comparison, an arm that states its own
// population); the comparison's view (the mode and its premise); a record made for an earlier parameter file reads as not current.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { vcrScenarioHash } from '../src/vcrJobs.mjs';
import { vcrComputedOutputHash } from '../src/vcrEngineClient.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : false, timeout: 300_000 };
const origin = { userId: 'people_owner', projectId: 'people_project', rootSessionId: 'people_session' };
let database, isolated, vcr, study, plane, experiments;
const known = new Map();

const PEOPLE_CSV = 'USUBJID,MMSE,AGE,APOE4,FEMALE,ETA,ALPHA,MEANSLOPE,TAU,OMEGA,PARAMSET_SHA256\nVP000001,21,70,0,1,-0.8,0.01,0.01,98,-0.6,x\nVP000002,19,77,1,0,-0.7,0.02,0.01,98,-0.6,x\n';
const GENERATED = { n: 3, population: { variables: [{ name: 'Mmse', family: 'normal', mean: 21, sd: 2 }] } };
const POPULATION_CSV = 'Id,Mmse,Allele,Sex\nS1,20.5,0,1\nS2,23,1,0\nS3,18,2,1\n';

function engine() {
  return {
    configured: () => true,
    async submit(/** @type {any} */ job) { known.set(job.jobId, job); return { jobId: job.jobId, accepted: true }; },
    async status() { return { state: 'succeeded', progress: { done: 1, total: 1 }, cpuSeconds: 1 }; },
    async cancel() { return { canceled: true }; },
    async result(/** @type {string} */ id) {
      const job = known.get(id);
      const instantiate = job.scenario?.instantiate !== undefined;
      const population = job.method === 'population.scenario';
      const name = population ? 'population' : 'progression-people';
      const csv = population ? POPULATION_CSV : PEOPLE_CSV;
      const location = `derived/${job.studyId}/${id}/${name}.csv`;
      if (population || instantiate) { await fs.mkdir(path.dirname(path.join(plane, location)), { recursive: true }); await fs.writeFile(path.join(plane, location), csv); }
      const progression = instantiate ? { family: 'beta_logit', instantiate: true, people: 2, uncertainty: 'new_study', covariatesFrom: job.scenario.instantiate.covariates ? 'population_table' : 'model',
        parameterSet: { id: 'camd-adas-cog-11', version: job.scenarioParameterVersion ?? 'adsim-3.0', fileSha256: 'a'.repeat(64) }, outsideFittedMmse: 0, fittedMmse: [16, 26] } : undefined;
      const result = { jobId: id, protocolVersion: 1, status: 'succeeded', method: job.method, methodVersion: job.methodVersion, scenarioHash: vcrScenarioHash(job.scenario), seed: job.seed,
        replicates: job.replicates ?? null, conclusion: 'estimable',
        counts: { realPatients: 0, generatedRecords: population || instantiate ? 2 : 1000 },
        measures: population || instantiate ? [{ name: 'generated_records', value: 2, simulated: false, source: 'synthetic' }]
          : [{ name: 'power', value: 0.8, simulated: true, mcse: 0.01, source: 'synthetic' }],
        diagnostics: progression ? { progression } : {},
        tables: population || instantiate ? [{ name, location, sha256: createHash('sha256').update(csv).digest('hex'), rows: 2 }] : [],
        manifest: { engineVersion: '1.0.0', rVersion: 'R 4.3.3', packageLockHash: 'b'.repeat(64), startedAt: '2026-11-09T00:00:00Z', finishedAt: '2026-11-09T00:00:01Z', cpuSeconds: 1 } };
      result.manifest.outputHash = vcrComputedOutputHash(result);
      return { result, signed: true, refused: false };
    },
  };
}
/** Run every queued job to its end on the double. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const claimed = await vcr.jobs.claim();
    if (!claimed.length) return;
    for (const job of claimed) { await vcr.jobs.advance(job); await vcr.jobs.advance(job); }
  }
}
const arm = (/** @type {any} */ treatment) => ({ endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 40, nControl: 40 }, timeUnit: 'weeks', visits: [0, 26, 52],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' } }, ...(treatment ? { treatment } : {}) });
const SYMPTOMATIC = { symptomatic: { pointsAt: { value: -2.5, basis: 'assumed' }, atWeek: 26, referenceAdas: 25, et50Weeks: { value: 8, basis: 'assumed' } } };
const comparison = (/** @type {string} */ question, /** @type {any} */ people, /** @type {any} */ extra = {}) => ({ question, arms: [
  { name: 'none', method: 'patients.progression', scenario: arm(null) }, { name: 'symptomatic', method: 'patients.progression', scenario: arm(SYMPTOMATIC) }],
comparison: { measures: ['power'], reference: 'none' }, ...(people ? { people } : {}), ...extra });
const jobRows = (/** @type {string} */ experimentId) => vcr.store.rows(`SELECT * FROM evimed_vcr.jobs WHERE checkpoint->'experiment'->>'id' = $1 ORDER BY created_at, id`, [experimentId]);
const experimentCount = async () => Number((await vcr.store.one('SELECT count(*) AS n FROM evimed_vcr.experiments WHERE study_id = $1', [study.id])).n);

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrpeople');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  plane = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-people-'));
  await fs.chmod(plane, 0o700);
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1, vcrDataPlaneDir: plane } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  vcr.jobs.engine = engine();
  experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
});
after(async () => { await database?.close(); await isolated?.drop(); if (plane) await fs.rm(plane, { recursive: true, force: true }); });

test('a record of people is asked for once, kept in the data plane and read back with the model it was made for', options, async () => {
  const first = await experiments.instantiatePeople(study, { n: 2 }, { userId: origin.userId });
  assert.equal(first.created, true);
  const job = await vcr.store.one('SELECT * FROM evimed_vcr.jobs WHERE id = $1', [first.jobId]);
  assert.equal(job.method, 'patients.progression');
  assert.deepEqual(job.scenario.instantiate, { n: 2 });
  assert.deepEqual(job.checkpoint.keepTables, ['progression-people']);
  assert.match(String(job.checkpoint.subjectId ?? ''), /^people:[0-9a-f]{24}$/);
  // asking again with the same request is the same job: one sample, not two
  const again = await experiments.instantiatePeople(study, { n: 2 }, { userId: origin.userId });
  assert.equal(again.jobId, first.jobId);
  assert.equal(again.created, false);
  assert.deepEqual(await experiments.peopleRecords(study), [], 'a record is a result: none exists before the job has run');
  await drain();
  const [record] = await experiments.peopleRecords(study);
  assert.ok(record);
  assert.equal(record.people, 2);
  assert.deepEqual(record.parameterSet, { id: 'camd-adas-cog-11', version: 'adsim-3.0' });
  assert.equal(record.current, true);
  assert.equal(record.covariatesFrom, 'model');
  assert.match(record.tableSha256, /^[0-9a-f]{64}$/);
});

test('refused by name: an observed cohort, an unknown column key, a bad n, a seed out of range, nothing to make it from', options, async () => {
  const cohort = await vcr.store.savePopulation({ studyId: study.id, userId: origin.userId, name: 'Real cohort', kind: 'real', definition: {} });
  await assert.rejects(experiments.instantiatePeople(study, { populationId: cohort.id, columns: { mmse: 'MMSE' } }, { userId: origin.userId }),
    (/** @type {any} */ error) => error.code === 'vcr_people_invalid' && error.issues.some((/** @type {any} */ issue) => issue.code === 'people_population_unusable'));
  await assert.rejects(experiments.instantiatePeople(study, { populationId: 'pop_missing', columns: { mmse: 'x' } }, { userId: origin.userId }), { code: 'vcr_population_not_found' });
  for (const [bad, code] of [[{ n: 1 }, 'people_value_invalid'], [{ n: 10, seed: -1 }, 'people_value_invalid'], [{}, 'people_field_missing'], [{ n: 10, columns: { mmse: 'x' } }, 'people_field_unknown'],
    [{ n: 10, uncertainty: 'posterior_draws' }, 'people_value_invalid'], [{ n: 10, extra: 1 }, 'people_field_unknown']]) {
    await assert.rejects(experiments.instantiatePeople(study, bad, { userId: origin.userId }), (/** @type {any} */ error) => error.code === 'vcr_people_invalid' && error.issues.some((/** @type {any} */ issue) => issue.code === code), JSON.stringify(bad));
  }
});

test('a generated population version\'s covariates reach the instantiate job as its generated table, by the columns named', options, async () => {
  const population = await vcr.store.savePopulation({ studyId: study.id, userId: origin.userId, name: 'Generated', kind: 'scenario',
    definition: GENERATED });
  const queued = await vcr.jobs.enqueue({ studyId: study.id, userId: origin.userId, kind: 'generate_population', scenario: GENERATED,
    inputs: [], detail: { subjectId: population.id, resultKind: 'population', keepTables: ['population'] } });
  assert.ok(queued.job.id);
  await drain();
  const made = await experiments.instantiatePeople(study, { populationId: population.id, columns: { mmse: 'Mmse', apoe4: 'Allele', female: 'Sex' } }, { userId: origin.userId });
  const job = await vcr.store.one('SELECT * FROM evimed_vcr.jobs WHERE id = $1', [made.jobId]);
  const [input] = job.inputs;
  assert.equal(input.kind, 'snapshot_file');
  assert.equal(input.valueSource, 'synthetic');
  assert.equal(input.hash, createHash('sha256').update(POPULATION_CSV).digest('hex'));
  assert.equal(job.scenario.instantiate.covariates.inputId, input.id);
  assert.deepEqual(job.scenario.instantiate.covariates.columns, { mmse: 'Mmse', apoe4: 'Allele', female: 'Sex' });
  assert.equal(job.scenario.instantiate.n, undefined);
});

test('every arm of a paired comparison reads the same record: one input with the record\'s hash, one seed, no group sizes', options, async () => {
  const [record] = await experiments.peopleRecords(study);
  const started = await experiments.startExperiment(study, comparison('paired on a record', { recordId: record.id, mode: 'paired_counterfactual' }), { userId: origin.userId });
  assert.equal(started.created, true);
  assert.deepEqual({ recordId: started.people.recordId, mode: started.people.mode }, { recordId: record.id, mode: 'paired_counterfactual' });
  assert.match(started.people.modeText, /同一批虚拟患者/);
  assert.ok(started.premises.some((/** @type {any} */ row) => row.key === 'lab:people' && /不是任何试验观察到的个体疗效/.test(row.value)));
  const jobs = await jobRows(started.id);
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((job) => String(job.seed))).size, 1, 'the arms share one seed by construction');
  for (const job of jobs) {
    assert.equal(job.inputs.length, 1);
    const [input] = job.inputs;
    assert.deepEqual({ kind: input.kind, shape: input.shape, valueSource: input.valueSource, id: input.id, hash: input.hash },
      { kind: 'analysis_table', shape: 'subject', valueSource: 'synthetic', id: `${record.id}:progression-people`, hash: record.tableSha256 });
    assert.deepEqual(job.scenario.people, { inputId: input.id, mode: 'paired_counterfactual' });
    assert.equal(job.scenario.design, undefined, 'a paired run is on everyone in the record');
    assert.equal(job.method_version, '1.2.0');
  }
  // the same comparison is the same experiment
  assert.equal((await experiments.startExperiment(study, comparison('paired on a record', { recordId: record.id, mode: 'paired_counterfactual' }), { userId: origin.userId })).created, false);
});

test('a resampled comparison keeps the group sizes and the same seed; a record made for another parameter file reads as not current', options, async () => {
  const [record] = await experiments.peopleRecords(study);
  const started = await experiments.startExperiment(study, comparison('resampled on a record', { recordId: record.id, mode: 'resampled_trials' }), { userId: origin.userId });
  const jobs = await jobRows(started.id);
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((job) => String(job.seed))).size, 1);
  for (const job of jobs) { assert.deepEqual(job.scenario.design, { nTreat: 40, nControl: 40 }); assert.equal(job.scenario.people.mode, 'resampled_trials'); }
  assert.match(started.premises.find((/** @type {any} */ row) => row.key === 'lab:people').value, /同一份虚拟患者记录/);
  // the pair of paired and resampled seeds differ: another mode is another draw
  const paired = await jobRows((await vcr.store.one(`SELECT id FROM evimed_vcr.experiments WHERE study_id = $1 AND manifest->>'question' = 'paired on a record'`, [study.id])).id);
  assert.notEqual(String(paired[0].seed), String(jobs[0].seed));
  // an earlier parameter file
  await vcr.store.query(`UPDATE evimed_vcr.results SET diagnostics = jsonb_set(diagnostics, '{progression,parameterSet,version}', '"adsim-2.0"') WHERE id = $1`, [record.id]);
  const stale = (await experiments.peopleRecords(study)).find((entry) => entry.id === record.id);
  assert.equal(stale.current, false);
  await vcr.store.query(`UPDATE evimed_vcr.results SET diagnostics = jsonb_set(diagnostics, '{progression,parameterSet,version}', '"adsim-3.0"') WHERE id = $1`, [record.id]);
});

test('an unknown or foreign record, people on a design comparison and an arm that states its own people are refused before anything is frozen', options, async () => {
  const [record] = await experiments.peopleRecords(study);
  const before = await experimentCount();
  const refuse = async (/** @type {any} */ input, /** @type {string} */ code) => {
    await assert.rejects(experiments.startExperiment(study, input, { userId: origin.userId }),
      (/** @type {any} */ error) => error.code === 'vcr_experiment_invalid' && error.issues.some((/** @type {any} */ issue) => issue.code === code), code);
  };
  await refuse(comparison('unknown record', { recordId: 'res_nope', mode: 'paired_counterfactual' }), 'experiment_people_unknown');
  // a result of this study that is not a record
  const other = await vcr.store.one(`SELECT id FROM evimed_vcr.results WHERE study_id = $1 AND subject_id NOT LIKE 'people:%' LIMIT 1`, [study.id]);
  if (other) await refuse(comparison('not a record', { recordId: other.id, mode: 'paired_counterfactual' }), 'experiment_people_unknown');
  await refuse(comparison('bad mode', { recordId: record.id, mode: 'both' }), 'experiment_value_invalid');
  await refuse(comparison('own population', { recordId: record.id, mode: 'resampled_trials' }, {
    arms: [{ name: 'a', method: 'patients.progression', scenario: { ...arm(null), population: { mmseRange: { value: [16, 26], basis: 'assumed' } } } },
      { name: 'b', method: 'patients.progression', scenario: arm(SYMPTOMATIC) }] }), 'experiment_people_conflict');
  await refuse(comparison('own uncertainty', { recordId: record.id, mode: 'resampled_trials' }, {
    arms: [{ name: 'a', method: 'patients.progression', scenario: { ...arm(null), model: { ...arm(null).model, uncertainty: 'new_study' } } },
      { name: 'b', method: 'patients.progression', scenario: arm(SYMPTOMATIC) }] }), 'experiment_people_conflict');
  await refuse({ question: 'designs have no people', arms: [
    { name: 'a', method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 50, nControl: 50 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } } },
    { name: 'b', method: 'design.simulate', scenario: { design: { kind: 'two_arm_fixed', nTreat: 60, nControl: 60 }, endpoint: { type: 'continuous' }, truth: { effect: 0.5, sd: 1 }, analysis: { method: 'ttest', alpha: 0.025, sided: 1 } } }],
  comparison: { measures: ['power'], reference: 'a' }, people: { recordId: record.id, mode: 'paired_counterfactual' } }, 'experiment_people_unsupported');
  assert.equal(await experimentCount(), before, 'nothing was frozen by a refused comparison');
});

test('a search refuses a record of people and an effect distribution by name', options, async () => {
  const { campaignScenarioIssues } = await import('../src/vcrExperiments.mjs');
  const space = (/** @type {any} */ scenario) => ({ space: { method: 'patients.progression', scenario, variables: [{ path: 'design.nTreat', values: [40, 80] }] } });
  assert.deepEqual(campaignScenarioIssues(space(arm(SYMPTOMATIC))), []);
  assert.equal(campaignScenarioIssues(space({ ...arm(SYMPTOMATIC), people: { inputId: 'x:y', mode: 'resampled_trials' } }))[0].code, 'campaign_people_unsupported');
  const distributed = { symptomatic: { ...SYMPTOMATIC.symptomatic, pointsAt: { distribution: { family: 'normal', parameters: { mean: -2, sd: 1 }, source: { kind: 'stated', note: 'x' }, tier: 'stated' } } } };
  assert.equal(campaignScenarioIssues(space(arm(distributed)))[0].code, 'campaign_effect_distribution_unsupported');
  assert.deepEqual(campaignScenarioIssues({ space: { method: 'design.simulate', scenario: { people: 1 } } }), []);
});
