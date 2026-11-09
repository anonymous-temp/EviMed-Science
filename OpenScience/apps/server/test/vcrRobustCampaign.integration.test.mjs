// The robust design search end to end (plan R34): a campaign over three effect scenarios and the null on the real R engine and the real job
// queue. Every design runs in every scenario on one stream; the read model carries the per-scenario table, the maximin and regret numbers and
// the sets, and the exported lab section prints them. Skipped without an owned PostgreSQL and R.
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
import { renderLabSection } from '../src/vcrLabReport.mjs';
import { vcrReportModel } from '../src/vcrRender.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const run = promisify(execFile);
const engineRequired = process.env.VCR_ENGINE_TESTS === 'required';
const hasR = spawnSync('Rscript', ['-e', 'lib <- Sys.getenv("VCR_R_LIBS", ""); if(nzchar(lib)) .libPaths(c(lib, .libPaths())); quit(status=if(all(vapply(c("jsonlite","digest"),requireNamespace,logical(1),quietly=TRUE)))0 else 1)']).status === 0;
const options = { skip: !engineRequired && (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? 'Owned local PostgreSQL is required' : !hasR && 'Local R with jsonlite/digest is required'), timeout: 1_800_000 };
const engineRoot = fileURLToPath(new URL('../../../../项目代码/vcr-engine', import.meta.url));
let database, isolated, root, vcr, study, experiments, loops;
let submitted = 0;
const origin = { userId: 'robust_owner', projectId: 'robust_project', rootSessionId: 'robust_session' };

/** The Alzheimer trial (CAMD model, 78 weeks); the drug hypothesis is each scenario's own. */
const base = {
  endpoint: { type: 'continuous', unit: 'points' }, design: { nTreat: 100, nControl: 100 }, timeUnit: 'weeks', visits: [0, 26, 52, 78],
  model: { family: 'beta_logit', parameterSet: { id: 'camd-adas-cog-11', version: 'adsim-3.0' }, uncertainty: 'new_study' },
  analysis: { kind: 'change', visit: 78, alpha: 0.05 },
};
const symptomatic = (points) => ({ symptomatic: { pointsAt: { value: points, basis: 'assumed' }, atWeek: 24, referenceAdas: 25, et50Weeks: { value: 1, basis: 'assumed' } } });

async function drain(id, { limit = 120 } = {}) {
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
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrrobust');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-robust-'));
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: root, vcrStudyCpuBudget: 100000, vcrJobCpuSeconds: 300, vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
  study = await vcr.store.taskContext(origin);
  const outputs = new Map();
  vcr.jobs.engine = { configured: () => true, submit: async (/** @type {any} */ job) => {
    submitted += 1;
    const out = path.join(root, 'engine', job.jobId); await fs.mkdir(out, { recursive: true });
    const file = path.join(out, 'job.json'); await fs.writeFile(file, JSON.stringify(job));
    await run('Rscript', [path.join(engineRoot, 'service/run_job.R'), file, out], { env: { ...process.env, VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_DATA_ROOT: root, VCR_ENGINE_CORES: '2' }, timeout: 600000 });
    outputs.set(job.jobId, { out, result: JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8')) });
    return { accepted: true, jobId: job.jobId };
  }, status: async (/** @type {string} */ id) => ({ state: outputs.get(id).result.status, progress: { done: 1, total: 1 } }),
  result: async (/** @type {string} */ id) => ({ result: outputs.get(id).result, signed: true }),
  cancel: async () => ({ canceled: true }) };
  experiments = new VcrExperiments({ store: vcr.store, jobs: vcr.jobs });
  loops = createVcrWorkerLoops({ jobs: vcr.jobs, orchestrator: vcr.orchestrator ?? null, store: vcr.store, experiments });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

const campaign = {
  question: '三种疗效假设下都够用的最小入组',
  objective: { measure: 'total_sample_size', direction: 'minimize', truth: 'base' },
  constraints: [{ measure: 'power', op: '>=', bound: 0.3, kind: 'design', truth: 'base' }],
  space: { method: 'patients.progression', scenario: base,
    truths: [{ name: 'optimistic', truth: symptomatic(-3.5) }, { name: 'base', truth: symptomatic(-2.5) }, { name: 'pessimistic', truth: symptomatic(-1.5) }, { name: 'null', truth: {} }],
    candidates: [60, 150, 400].map((n) => ({ name: `${n}/arm`, set: { 'design.nTreat': n, 'design.nControl': n } })) },
  stages: { final: { count: 3 } }, budget: { maxCandidates: 3, cpuSeconds: 6000, modelCalls: 0 },
};

test('three effect scenarios and the null run for every design on one stream, and the read model carries the robust reading', options, async () => {
  const started = await experiments.startCampaign(study, campaign, { userId: origin.userId });
  await drain(started.id);
  const view = await experiments.view(study, started.id);
  assert.ok(['acceptable_precision', 'inconclusive_at_precision', 'no_feasible_beneficial_candidate'].includes(view.stop.reason), view.stop.reason);
  assert.equal(submitted, 12, 'three designs in four scenarios');
  const robust = view.robust;
  assert.ok(robust, 'two or more effect scenarios make the reading robust');
  assert.deepEqual(robust.scenarios.map((s) => s.name), ['optimistic', 'base', 'pessimistic']);
  assert.equal(robust.floor, 0.3, 'the floor is the base-case power constraint');
  assert.equal(robust.rows.length, 3);
  assert.ok(robust.rows.every((row) => row.complete && row.scenarios.length === 4), 'every design has a result in every scenario');
  // one stream: the engine's own record of the seed is the same in every scenario of a design
  const seeds = await vcr.store.rows(`SELECT detail->'experiment'->>'unitKey' AS unit, seed FROM evimed_vcr.jobs WHERE detail->'experiment'->>'id' = $1`, [started.id]).catch(() => []);
  if (seeds.length) for (const key of ['c000', 'c001', 'c002']) assert.equal(new Set(seeds.filter((s) => String(s.unit).startsWith(`${key}:final:`)).map((s) => s.seed)).size, 1, `${key} draws on one stream`);
  // power rises with the effect and with the design size; the worst case is the pessimistic scenario
  for (const row of robust.rows) {
    const power = Object.fromEntries(row.scenarios.filter((s) => s.power).map((s) => [s.name, s.power.value]));
    assert.ok(power.optimistic >= power.base && power.base >= power.pessimistic, `${row.key}: ${JSON.stringify(power)}`);
    assert.equal(row.worstCase.scenario, 'pessimistic');
    assert.ok(row.worstCase.mcse > 0 && row.maxRegret.value >= 0);
    assert.ok(row.scenarios.every((s) => s.power === null || s.power.mcse > 0), 'every power carries its MCSE');
    assert.equal(row.n.value, 2 * [60, 150, 400][row.index]);
  }
  const worst = robust.rows.map((row) => row.worstCase.value);
  assert.ok(worst[0] <= worst[1] && worst[1] <= worst[2], 'a larger design is never worse in the worst case');
  assert.equal(robust.rows[2].maxRegret.value, 0, 'the largest design is the best in every scenario');
  assert.ok(robust.sets.pareto.length >= 1 && robust.sets.nearOptimal.length >= robust.sets.pareto.length);
  assert.ok(robust.cheapestUnderBase, `a design reaches 30% power at the base case: ${JSON.stringify(robust.rows.map((row) => row.scenarios.map((s) => [s.name, s.power?.value, s.power?.status])))}`);
  assert.match(robust.statement, /^在这些假设下（“optimistic”、“base”、“pessimistic”）：/);
  assert.doesNotMatch(JSON.stringify(robust), /最优(的|设计|方案)|最佳/);
  // the same campaign again queues nothing
  const before = submitted;
  await experiments.startCampaign(study, campaign, { userId: origin.userId });
  assert.equal(submitted, before);
  // the lab block and the exported section carry the same table
  const lab = await experiments.reportBlock(study);
  const model = { ...vcrReportModel({ study: { id: study.id, name: 'EV-R', question: '', dataTier: 'T0', intendedUse: 'exploratory' }, results: [] }), lab };
  const section = renderLabSection(model);
  assert.deepEqual(section.issues, []);
  assert.match(section.markdown, /#### 稳健性比较/);
  assert.match(section.markdown, /“pessimistic”下的“考虑研究之间差异后的预期把握度”/);
  assert.doesNotMatch(section.markdown, /未计算/);
});
