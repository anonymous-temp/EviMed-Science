// The exported package against the real block (R14): on PostgreSQL, the report model's `lab` (a finished search and a comparison with an
// arm that has no result) renders to the laboratory section with every reference resolved, so the section's reading of the block cannot
// drift from what `VcrExperiments.reportBlock` writes. The files themselves are read in `vcrLabDocument.test.mjs`.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { VcrExperiments } from '../src/vcrExperiments.mjs';
import { vcrCampaignAdvance, vcrCampaignCanonical, vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord } from '@evimed/domain';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { renderLabSection } from '../src/vcrLabReport.mjs';

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
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrlabdoc');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  vcr.experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  vcr.service.attach({ experiments: vcr.experiments });
});
after(async () => { await database?.close(); await isolated?.drop(); });


test('the real block of a finished search and an unfinished comparison renders with every reference resolved and the finalists\' own numbers', options, async () => {
  const run = stopped();
  await vcr.store.query(`INSERT INTO evimed_vcr.experiments (id, study_id, user_id, kind, identity, manifest, state, status, origin)
    VALUES ('cmp_doc', $1, $2, 'campaign', $3, $4::jsonb, $5::jsonb, 'stopped', '{}'::jsonb)`, [study.id, origin.userId, run.identity, JSON.stringify(run.manifest), JSON.stringify(run.state)]);
  const arms = [{ name: '每组 100', method: 'design.simulate', version: run.manifest.space.version, scenario: input.space.scenario },
    { name: '每组 140', method: 'design.simulate', version: run.manifest.space.version, scenario: { ...input.space.scenario, design: { kind: 'two_arm_fixed', nTreat: 140, nControl: 140 } } }];
  await vcr.store.query(`INSERT INTO evimed_vcr.experiments (id, study_id, user_id, kind, identity, manifest, state, status, origin)
    VALUES ('exp_doc', $1, $2, 'experiment', $3, $4::jsonb, '{"arms":{}}'::jsonb, 'running', '{}'::jsonb)`,
  [study.id, origin.userId, sha('exp_doc'), JSON.stringify({ kind: 'design', question: '两个样本量', purpose: 'compare', arms, comparison: { measures: ['power'], reference: '每组 100' } })]);
  const model = await vcr.service.reportModel(study);
  const section = renderLabSection(model);
  assert.deepEqual(section.issues, [], JSON.stringify(section.issues));
  const campaign = model.lab.find((entry) => entry.id === 'cmp_doc');
  assert.ok(campaign.finalists.length > 0);
  for (const finalist of campaign.finalists) {
    assert.ok(section.markdown.includes(`试验组人数 ${finalist.design['design.nTreat']}`), 'each finalist\'s own setting is printed');
    assert.ok(section.markdown.includes(String(finalist.objective.value)), 'and its own objective value');
  }
  assert.match(section.markdown, /### 方案比较：两个样本量/);
  assert.match(section.markdown, /没有可比较的结果/, 'an arm with no result is said to be missing in the premises, never printed as a number');
  assert.ok(!section.markdown.includes('design.nTreat') && !section.markdown.includes('job_'), 'no back-office word');
});
