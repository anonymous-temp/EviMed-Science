// The virtual lab in the study's report and export model (F4): on PostgreSQL, `reportModel` carries every experiment and campaign of the
// study with the one premises block it is read under and each result next to the design it was computed for; a study with none has no
// `lab` key, so no other report changes. No new document: the block is read like any other part of the model, including by a run.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { vcrCampaignAdvance, vcrCampaignCanonical, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord } from '@evimed/domain';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : false, timeout: 300_000 };
const origin = { userId: 'rep_owner', projectId: 'rep_project', rootSessionId: 'rep_session' };
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
  variables: [{ path: 'design.nTreat', values: [60, 100, 140, 180] }, { path: 'analysis.alpha', values: [0.02, 0.025] }] },
  stages: { screening: { replicates: 400 }, final: { count: 2 } },
  budget: { maxCandidates: 8, cpuSeconds: 1000 },
};

/** A campaign run to its stop on a fake engine whose type I error sits at the analysis level. */
function stopped() {
  const { manifest, issues } = vcrCampaignManifest(input);
  assert.deepEqual(issues, []);
  const identity = sha(vcrCampaignCanonical(manifest));
  let state = vcrCampaignInitialState(manifest);
  for (let i = 0; i < 120; i++) {
    const { state: next, action } = vcrCampaignAdvance(manifest, state, { identity });
    state = next;
    if (action.type !== 'evaluate') break;
    const unit = action.unit, n = unit.scenario.design.nTreat, reps = unit.stage === 'screening' ? 400 : unit.truth === 'null' ? 20000 : 5000;
    const p = unit.truth === 'null' ? Number(unit.scenario.analysis?.alpha ?? 0.025) : Math.round((1 - Math.exp(-n / 70)) * reps) / reps;
    const label = unit.stage === 'screening' ? { precision: 'screening' } : {};
    state = vcrCampaignRecord(manifest, { ...state, inFlight: { unitKey: unit.key, unit } }, unit, { jobId: `job_${unit.key}`, resultId: `res_${unit.key}`, state: 'succeeded', seed: unit.seed, replicates: reps,
      measures: [{ name: unit.truth === 'null' ? 'type_one_error' : 'power', value: p, mcse: Math.sqrt(p * (1 - p) / reps), simulated: true, source: 'synthetic', ...label },
        { name: 'expected_sample_size', value: n * 2, mcse: 0, simulated: true, source: 'synthetic', ...label }], cpuSeconds: 1 });
  }
  return { manifest, identity, state: { ...state, stop: { ...state.stop, at: new Date().toISOString() } } };
}

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrrep');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  vcr.experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  vcr.service.attach({ experiments: vcr.experiments });
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('a study with no experiment has no lab block, so no other report changes', options, async () => {
  const model = await vcr.service.reportModel(study);
  assert.equal(Object.hasOwn(model, 'lab'), false);
});

test('the report model carries each campaign and experiment with its premises and every result beside its own design', options, async () => {
  const run = stopped();
  await vcr.store.query(`INSERT INTO evimed_vcr.experiments (id, study_id, user_id, kind, identity, manifest, state, status, origin)
    VALUES ('cmp_rep', $1, $2, 'campaign', $3, $4::jsonb, $5::jsonb, 'stopped', '{}'::jsonb)`, [study.id, origin.userId, run.identity, JSON.stringify(run.manifest), JSON.stringify(run.state)]);
  const arms = [{ name: '每组 100', method: 'design.simulate', version: run.manifest.space.version, scenario: { ...input.space.scenario, design: { kind: 'two_arm_fixed', nTreat: 100, nControl: 100 } } },
    { name: '每组 140', method: 'design.simulate', version: run.manifest.space.version, scenario: { ...input.space.scenario, design: { kind: 'two_arm_fixed', nTreat: 140, nControl: 140 } } }];
  await vcr.store.query(`INSERT INTO evimed_vcr.experiments (id, study_id, user_id, kind, identity, manifest, state, status, origin)
    VALUES ('exp_rep', $1, $2, 'experiment', $3, $4::jsonb, '{"arms":{}}'::jsonb, 'running', '{}'::jsonb)`,
  [study.id, origin.userId, sha('exp_rep'), JSON.stringify({ kind: 'design', question: '两个样本量', purpose: 'compare', arms, comparison: { measures: ['power'], reference: '每组 100' } })]);

  const model = await vcr.service.reportModel(study);
  assert.deepEqual(model.lab.map((entry) => entry.id).sort(), ['cmp_rep', 'exp_rep']);
  const campaign = model.lab.find((entry) => entry.id === 'cmp_rep');
  assert.equal(campaign.stop.reason, run.state.stop.reason);
  assert.ok(campaign.stop.text);
  assert.ok(campaign.finalists.length > 0 && campaign.finalists.length <= 2);
  for (const finalist of campaign.finalists) {
    // a result beside the design it was computed for: the candidate's own setting, its objective and the judged constraints
    assert.ok(finalist.design['design.nTreat'] > 0);
    assert.equal(finalist.objective.value, finalist.design['design.nTreat'] * 2);
    assert.equal(finalist.constraints.length, 2);
    assert.ok(finalist.resultIds.length > 0);
  }
  const alpha = campaign.premises.find((premise) => premise.key === 'alpha');
  assert.match(alpha.value, /约束固定为 2\.5%.*检验水准也在搜索范围内/, 'the searched analysis level is in the premises of the exported campaign');
  assert.equal(campaign.constraints.find((constraint) => constraint.kind === 'error_control').bound, 0.025);
  const experiment = model.lab.find((entry) => entry.id === 'exp_rep');
  assert.deepEqual(experiment.arms.map((arm) => [arm.name, arm.design.design.nTreat]), [['每组 100', 100], ['每组 140', 140]], 'each arm keeps its own design');
  assert.ok(experiment.premises.some((premise) => premise.key === 'lab:incomplete'), 'an arm with no result is said to be missing, not zero');
  assert.ok(experiment.premises.filter((premise) => premise.decisive).length <= 5);
  // the model a run reads of it passes the same boundary as every other read, and keeps the block
  const forRun = await vcr.service.forModel({ model }, { projection: 'report_model' });
  assert.equal(forRun.model.lab.length, 2);
  const text = JSON.stringify(model.lab.map((entry) => entry.premises));
  for (const banned of ['design.simulate', 'job_', 'experiment_candidate', 'checkpoint']) assert.ok(!text.includes(banned), banned);
});
