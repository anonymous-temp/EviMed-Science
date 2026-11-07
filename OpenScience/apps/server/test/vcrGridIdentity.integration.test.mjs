// Live defect D1b (2026-11-07, phase 3, conversation a) on the real store: three design grids a conversation started without a subjectId
// were filed as versions of one grid, and the 83.6% the reply cited was on no page. Each set of defining inputs is its own grid, and the
// trial page draws the grid a link names (the newest without one). And the null check of the same conversation, read back through
// `vcr_read results` for the follow-up 「能不能确认一类错误不超过 2.5%？」, carries each cell's verdict (live D8).
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { resolveJobSubject, vcrConversationSubject } from '../src/vcrSubjects.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Owned local PostgreSQL is required' };
/** @type {any} */ let isolated;
/** @type {any} */ let database;
/** @type {any} */ let dir;
/** @type {any} */ let vcr;

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrgrid');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-grid-'));
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: dir, vcrProviderAgreements: true,
    vcrProviderAgreementReference: 'Local synthetic fixture', deepseekBaseUrl: 'https://model.invalid', vcrMaxConcurrentJobs: 1 } });
  await vcr.store.ready();
});
after(async () => {
  await database?.close();
  await isolated?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const base = { design: { kind: 'two_arm_fixed', nTreat: 250, nControl: 250 }, endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.75, controlMedian: 12 },
  analysis: { method: 'logrank', alpha: 0.025, sided: 1 }, performance: ['power'] };
const followed30 = { ...base, accrual: { duration: 12, followup: 30 }, designs: [{ nTreat: 250, nControl: 250 }], truths: [{ hazardRatio: 0.75 }] };
const followed240 = { ...followed30, accrual: { duration: 12, followup: 240 } };
const nullCheck = { ...followed30, performance: ['type_one_error'], designs: [{ nTreat: 250, nControl: 250 }, { nTreat: 306, nControl: 306 }], truths: [{ hazardRatio: 1, null: true }] };

test('three grids of one conversation are three grids, each keeps its cells, and the trial page draws the one a link names', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'gridowner', projectId: 'default', rootSessionId: 'grid_root', sessionId: 'grid_root', runId: 'r', callId: 'c', programme: false }, { create: true });
  const file = async (/** @type {Record<string, any>} */ scenario) => {
    const madeFor = await vcrConversationSubject({ store: vcr.store, study, userId: study.userId, kind: 'design_grid', scenario });
    return String((await resolveJobSubject({ store: vcr.store, study, kind: 'design_grid', subjectId: madeFor, scenario })).row.id);
  };
  const ids = [await file(followed30), await file(followed240), await file(nullCheck)];
  assert.equal(new Set(ids).size, 3, `three grids: ${ids}`);
  assert.equal(await file(nullCheck), ids[2], 'the null check again is that grid');
  assert.equal((await vcr.store.latestDesignGrid(study.id)).id, ids[2]);
  // What the engine's results put in each grid (the orchestrator's landing writes the cells by the grid's own id).
  await vcr.store.attachGridCells(ids[0], [{ designIndex: 1, truthIndex: 1, status: 'ok', measures: [{ name: 'power', value: 0.836, mcse: 0.005, simulated: true }] }]);
  await vcr.store.attachGridCells(ids[2], [{ designIndex: 1, truthIndex: 1, status: 'ok', measures: [{ name: 'type_one_error', value: 0.0232, mcse: 0.0011, simulated: true }] },
    { designIndex: 2, truthIndex: 1, status: 'ok', measures: [{ name: 'type_one_error', value: 0.02435, mcse: 0.0011, simulated: true }] }]);
  const user = { id: study.userId };
  const newest = await vcr.service.tab(user, study.id, 'trial', {});
  assert.deepEqual(newest.grid.rows.map((/** @type {any} */ row) => row.header), ['每组 250 例', '每组 306 例']);
  const named = await vcr.service.tab(user, study.id, 'trial', { object: ids[0] });
  assert.equal(named.grid.measure, '功效');
  assert.deepEqual(named.grid.rows.map((/** @type {any} */ row) => [row.header, row.cells[0].text]), [['每组 250 例', '83.6%']], 'the 30-month grid the reply cited is on its page');
  // A link to something that is not a grid of this study leaves the newest grid on the page.
  assert.deepEqual((await vcr.service.tab(user, study.id, 'trial', { object: 'grd_nobody' })).grid.rows.length, 2);
});

test('live D8 on the real store: a grid null check read through vcr_read results carries each cell\'s verdict at the level its job stated', options, async () => {
  const study = await vcr.store.taskContext({ userId: 'typeone', projectId: 'default', rootSessionId: 'typeone_root', sessionId: 'typeone_root', runId: 'r', callId: 'c', programme: false }, { create: true });
  const jobId = 'job_typeone_grid';
  await vcr.store.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, method_version, state, scenario_hash, seed, replicates, progress, scenario)
    VALUES ($1, $2, $3, 'design_grid', 'design.grid', '1.3.0', 'succeeded', $4, 5, 20000, '{}'::jsonb, $5::jsonb)`,
  [jobId, study.id, study.userId, 'a'.repeat(64), JSON.stringify({ ...nullCheck, analysis: { ...nullCheck.analysis, alpha: 0.025 } })]);
  const execution = await vcr.store.recordExecution({ jobId, studyId: study.id, userId: study.userId, method: 'design.grid', methodVersion: '1.3.0',
    scenarioHash: 'a'.repeat(64), seed: 5, replicates: 20000, cpuSeconds: 100 });
  await vcr.store.recordResult({ studyId: study.id, userId: study.userId, requestedUse: 'design_support', kind: 'design_grid', executionId: execution.id, conclusion: 'estimable',
    counts: {}, measures: [{ name: 'cells', value: 2, source: 'calculated' }], diagnostics: { cells: [
      { designIndex: 1, truthIndex: 1, status: 'succeeded', measures: [{ name: 'type_one_error', value: 0.0232, mcse: 0.00107 }] },
      { designIndex: 2, truthIndex: 1, status: 'succeeded', measures: [{ name: 'type_one_error', value: 0.02435, mcse: 0.0011 }] }] } });
  const read = await vcr.service.runtimeRead(study, 'results', {});
  const grid = read.results.find((/** @type {any} */ result) => result.kind === 'design_grid');
  assert.deepEqual(grid.diagnostics.cells.map((/** @type {any} */ cell) => cell.typeOneError?.text),
    ['I 类错误无法确定是否不超过 2.5%（模拟 2.32% ± 0.11%）', 'I 类错误无法确定是否不超过 2.5%（模拟 2.44% ± 0.11%）']);
});
