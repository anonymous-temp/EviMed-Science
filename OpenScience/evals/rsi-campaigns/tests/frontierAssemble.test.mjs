import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { rsiDigest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { rsiCampaignIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { RSI_QUARTER_ALPHA } from '../campaign_runner.mjs';
import { frontierCampaignConsumerIdentity } from '../frontier_campaign.mjs';
import { replayFrontierPool } from '../frontier_selection.mjs';
import { FRONTIER_CAMPAIGN_REGISTRATION, beijingMonthEnd, buildCampaign, campaignRegistration, minimumDetectableEffect, planCampaign, readFrontierExport, replayDrift, shiftMonth, splitDays } from '../frontier_assemble.mjs';
import { BENIGN_PROCEDURE, STATISTICS_MODULE_PATH, STATISTICS_PYTHON, frontierDayPool, frontierDaysSource, runToVerdict } from '../profiles/benign_fixture.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('../../../', import.meta.url).pathname;
const assembleScript = new URL('../frontier_assemble.mjs', import.meta.url).pathname;
const NOW = '2026-10-26T00:00:00Z';
const BASELINE = 64;

/** August (development) and September (confirmation) of an export, in the `rsi-frontier-export-v1` shape. */
function exportDocument() {
  const august = frontierDaysSource({ start: '2026-08-01', days: 31, rowsPerDay: 26, seed: 11, prefix: 'aug', cutoffs: [72, 72, 74, 76] }).days;
  const september = frontierDaysSource({ start: '2026-09-01', days: 27, rowsPerDay: 26, seed: 12, prefix: 'sep', cutoffs: [72, 72, 74, 76] }).days;
  // Two thin days at the end of September (too few labelled rows to be measured) and one whose pool is not complete.
  const thin = frontierDaysSource({ start: '2026-09-28', days: 2, rowsPerDay: 10, seed: 13, prefix: 'thin', cutoffs: [72] }).days;
  const incomplete = { ...frontierDayPool('2026-09-30', []), complete: false };
  return {
    schema: 'rsi-frontier-export-v1', exportedAt: '2026-10-01T00:00:00Z', releaseId: 'release-test.1', from: '2026-08-01', to: '2026-09-30',
    settings: { threshold: BASELINE, thresholdSource: 'test', preprintPlaces: 2, preprintMinScore: 50, scoreVersion: 'current', timeZone: 'Asia/Shanghai' },
    consumer: [], days: [...august, ...september, ...thin, incomplete], texts: {}, signals: {},
  };
}
const allRows = (document) => document.days.flatMap((day) => day.rows);
/** What a labeller would say: a pick from 72 up, an alert is always a pick, every seventeenth row is left unlabelled. */
function labelsFor(ids, document) {
  const byId = new Map(allRows(document).map((row) => [String(row.id), row]));
  return { juryVersion: 'test-jury-1', model: 'test-model', labels: ids.map((id, i) => {
    const row = byId.get(id);
    return { id, worth: i % 17 === 16 ? null : row.safety_alert === true || row.score_total >= 72 ? 'pick' : row.score_total >= 68 ? 'ok' : 'no' };
  }) };
}
/** The jury's calibration file as `frontier_labels.mjs calibrate` writes it: metrics under `calibration`, the gate under `qualification`. */
const CALIBRATION = { schema: 'rsi-frontier-jury-calibration-v1', juryVersion: 'test-jury-1', calibration: { pickKappa: 0.81, abstentionRate: 0.05, pickPrecision: 0.8 }, qualification: { qualified: true, reasons: [] } };

async function withExport(fn, document = exportDocument()) {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-assemble-'));
  try {
    const gz = join(dir, 'frontier.json.gz'), plain = join(dir, 'frontier.json');
    await writeFile(gz, gzipSync(JSON.stringify(document)));
    await writeFile(plain, JSON.stringify(document));
    return await fn({ dir, gz, plain, document });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const python = (code) => execFileAsync(STATISTICS_PYTHON, ['-c', code], { cwd: tmpdir(), env: { PATH: process.env.PATH, PYTHONPATH: STATISTICS_MODULE_PATH } });

test('shiftMonth walks calendar months across year boundaries', () => {
  assert.equal(shiftMonth('2026-10', -2), '2026-08');
  assert.equal(shiftMonth('2026-10', -1), '2026-09');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-02', -2), '2025-12');
  assert.equal(shiftMonth('2026-11', 2), '2027-01');
  assert.equal(shiftMonth('2026-03', -14), '2025-01');
  assert.equal(shiftMonth('2026-10', 0), '2026-10');
});

test('a Beijing month ends sixteen hours into the last UTC day, leap years included', () => {
  assert.equal(beijingMonthEnd('2026-10'), '2026-10-31T16:00:00.000Z');
  assert.equal(beijingMonthEnd('2026-12'), '2026-12-31T16:00:00.000Z');
  assert.equal(beijingMonthEnd('2026-02'), '2026-02-28T16:00:00.000Z');
  assert.equal(beijingMonthEnd('2028-02'), '2028-02-29T16:00:00.000Z');
  assert.equal(beijingMonthEnd('2026-04'), '2026-04-30T16:00:00.000Z');
});

test('the month split reads the two months before the run and only complete days', () => {
  const document = exportDocument();
  const split = splitDays(document, '2026-10');
  assert.deepEqual([split.development, split.confirmation], ['2026-08', '2026-09']);
  assert.equal(split.devDays.length, 31);
  assert.equal(split.confirmDays.length, 29, 'the incomplete September 30th is not a day');
  assert.ok(split.confirmDays.every((day) => day.complete === true));
  assert.ok(!split.confirmDays.some((day) => day.rows.length === 0));
  assert.equal(splitDays({ days: [] }, '2026-10').devDays.length, 0);
});

test('explicit windows are inclusive, ordered and disjoint', () => {
  const document = exportDocument();
  const split = splitDays(document, '2026-10', { development: ['2026-08-01', '2026-08-10'], confirmation: ['2026-08-11', '2026-08-20'] });
  assert.deepEqual([split.development, split.confirmation], ['2026-08-01..2026-08-10', '2026-08-11..2026-08-20']);
  assert.deepEqual([split.devDays.length, split.confirmDays.length], [10, 10]);
  assert.equal(split.devDays.at(-1).day, '2026-08-10');
  assert.equal(split.confirmDays[0].day, '2026-08-11');
  assert.equal(splitDays(document, '2026-10', { development: ['2026-08-01', '2026-08-01'], confirmation: ['2026-08-02', '2026-08-02'] }).devDays.length, 1, 'a one-day window is valid');
  for (const windows of [
    { development: ['2026-08-10', '2026-08-01'], confirmation: ['2026-08-11', '2026-08-20'] }, // development runs backwards
    { development: ['2026-08-01', '2026-08-10'], confirmation: ['2026-08-10', '2026-08-20'] }, // they touch
    { development: ['2026-08-01', '2026-08-15'], confirmation: ['2026-08-10', '2026-08-20'] }, // they overlap
    { development: ['2026-08-11', '2026-08-20'], confirmation: ['2026-08-01', '2026-08-10'] }, // confirmation precedes development
    { development: ['2026-08-01', '2026-08-10'], confirmation: ['2026-08-20', '2026-08-11'] }, // confirmation runs backwards
  ]) assert.throws(() => splitDays(document, '2026-10', windows), { message: 'campaign_windows_invalid' }, JSON.stringify(windows));
});

test('the registered grid drops the baseline and floors the band at the lowest line', () => {
  const registered = campaignRegistration(64);
  assert.deepEqual(registered.thresholds, [58, 60, 62, 66, 68, 70, 72, 75, 78]);
  assert.equal(registered.floor, 58);
  assert.equal(campaignRegistration(65).thresholds.length, 10);
  assert.equal(campaignRegistration(50).floor, 50, 'a baseline under the grid lowers the floor, so its picks are labelled');
  assert.ok(Object.isFrozen(FRONTIER_CAMPAIGN_REGISTRATION) && Object.isFrozen(FRONTIER_CAMPAIGN_REGISTRATION.thresholds));
  assert.equal(FRONTIER_CAMPAIGN_REGISTRATION.campaignsPerQuarter * (RSI_QUARTER_ALPHA / FRONTIER_CAMPAIGN_REGISTRATION.campaignsPerQuarter), RSI_QUARTER_ALPHA);
});

test('the pinned procedure is the one the statistics module supports', async () => {
  const { stdout } = await python(`import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('campaign_statistics', ${JSON.stringify(new URL('../statistics.py', import.meta.url).pathname)})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(json.dumps(module.PROCEDURE))`);
  assert.deepEqual(JSON.parse(stdout), { ...FRONTIER_CAMPAIGN_REGISTRATION.procedure });
  assert.deepEqual({ ...FRONTIER_CAMPAIGN_REGISTRATION.procedure }, { ...BENIGN_PROCEDURE });
});

test('the minimum detectable effect is the one-sided normal planning figure from development day differences', () => {
  const differences = [0.1, 0.2, 0.15, 0.05, 0.25]; // mean .15, sample sd sqrt(.00625)
  const sd = Math.sqrt(0.00625);
  const planned = minimumDetectableEffect(differences, 25, 0.05);
  assert.ok(Math.abs(planned.sd - sd) < 1e-12);
  // z(0.95) + z(0.80) = 1.644854 + 0.841621
  assert.ok(Math.abs(planned.mde - (1.6448536 + 0.8416212) * sd / 5) < 1e-6, String(planned.mde));
  assert.match(planned.basis, /development day differences/);
  const strict = minimumDetectableEffect(differences, 25, 0.00833);
  assert.ok(strict.mde > planned.mde, 'a smaller test alpha needs a larger effect');
  assert.ok(Math.abs(strict.mde - (2.3941 + 0.8416212) * sd / 5) < 2e-3);
  assert.ok(minimumDetectableEffect(differences, 100, 0.05).mde < planned.mde, 'more groups see a smaller effect');
  const spread = minimumDetectableEffect(differences.map((value) => value * 2), 25, 0.05);
  assert.ok(Math.abs(spread.mde - 2 * planned.mde) < 1e-12, 'the effect scales with the spread');
  assert.deepEqual(minimumDetectableEffect([0.5, 0.5, 0.5], 25, 0.05).mde, 0, 'no spread, nothing to detect beyond zero');
  assert.equal(minimumDetectableEffect([0.1, 0.2], 25, 0.05), null, 'two days are not enough to plan on');
  assert.equal(minimumDetectableEffect(differences, 1, 0.05), null);
  assert.equal(minimumDetectableEffect([], 25, 0.05), null);
});

test('an export is read gzipped or plain, and anything else is refused', async () => {
  await withExport(async ({ gz, plain, dir }) => {
    const a = await readFrontierExport(gz), b = await readFrontierExport(plain);
    assert.equal(a.value.releaseId, 'release-test.1');
    assert.deepEqual(a.value, b.value);
    assert.notEqual(a.sha256, b.sha256, 'the digest is of the bytes on disk');
    assert.match(a.sha256, /^[a-f0-9]{64}$/);
    for (const bad of [{ ...b.value, schema: 'rsi-frontier-export-v0' }, { ...b.value, days: 'x' }]) {
      const path = join(dir, 'bad.json');
      await writeFile(path, JSON.stringify(bad));
      await assert.rejects(readFrontierExport(path), { message: 'campaign_export_invalid' });
    }
    await writeFile(join(dir, 'garbage.json'), '{not json');
    await assert.rejects(readFrontierExport(join(dir, 'garbage.json')));
  });
});

test('replay drift names the files the lab selector has that production did not run', async () => {
  const identity = await frontierCampaignConsumerIdentity();
  const labPath = (row) => row.path.replace(/^\.\.\/\.\.\//, '');
  const exported = identity.components.map((row) => ({ path: labPath(row), sha256: row.sha256 }));
  assert.deepEqual(await replayDrift({ consumer: exported }), []);
  const drifted = exported.map((row, i) => (i === 0 ? { ...row, sha256: 'f'.repeat(64) } : row));
  assert.deepEqual(await replayDrift({ consumer: drifted }), [exported[0].path]);
  assert.deepEqual(await replayDrift({ consumer: [{ path: 'apps/server/src/elsewhere.mjs', sha256: 'f'.repeat(64) }] }), [], 'a file the lab does not pin is not drift');
  assert.deepEqual(await replayDrift({}), []);
});

test('the plan lists exactly the rows a labeller must label, from replays alone', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    assert.deepEqual([plan.development, plan.confirmation, plan.month], ['2026-08', '2026-09', '2026-10']);
    assert.equal(plan.devDays.length, 31);
    assert.equal(plan.confirmDays.length, 29);
    assert.ok(!plan.confirmDays.includes('2026-09-30'), 'a day without complete pool truth is not planned');
    assert.equal(plan.releaseId, 'release-test.1');
    assert.deepEqual(plan.settings, document.settings);
    assert.deepEqual(plan.registration, campaignRegistration(BASELINE));
    assert.deepEqual(plan.drift, []);
    // The oracle: in the set when a safety alert, at or above the lowest registered line, or selected by any registered line.
    const lines = [plan.registration.baselineThreshold, ...plan.registration.thresholds];
    const expected = new Map();
    for (const day of document.days.filter((d) => d.complete && plan.devDays.concat(plan.confirmDays).includes(d.day))) {
      const selected = new Set(lines.flatMap((line) => replayFrontierPool(day, line).selectedIds));
      expected.set(day.day, day.rows.filter((row) => row.safety_alert === true || row.score_total >= plan.registration.floor || selected.has(String(row.id))).map((row) => String(row.id)).sort());
    }
    assert.deepEqual(plan.perDay, [...expected].map(([day, ids]) => ({ day, labelSet: ids.length })));
    assert.deepEqual(plan.ids, [...new Set([...expected.values()].flat())].sort());
    assert.ok(plan.ids.every((id) => !id.includes('-low')), 'rows below the band are never asked about');
    assert.equal(plan.exportSha256.length, 64);
  });
});

test('a plan refuses what cannot be a campaign', async () => {
  await withExport(async ({ gz, plain, dir, document }) => {
    await assert.rejects(planCampaign({ exportPath: gz, month: '2026-13x' }), { message: 'campaign_plan_arguments_invalid' });
    await assert.rejects(planCampaign({ exportPath: gz, month: undefined }), { message: 'campaign_plan_arguments_invalid' });
    await assert.rejects(planCampaign({ exportPath: gz, month: '2026-10', idPrefix: 'Bad_Prefix' }), { message: 'campaign_plan_arguments_invalid' });
    assert.equal((await planCampaign({ exportPath: gz, month: '2026-10', idPrefix: 'rehearsal-' })).idPrefix, 'rehearsal-');
    // Months with no export in them leave a window empty.
    await assert.rejects(planCampaign({ exportPath: gz, month: '2027-03' }), { message: 'campaign_export_window_incomplete' });
    await assert.rejects(planCampaign({ exportPath: gz, month: '2026-10', windows: { development: ['2026-08-10', '2026-08-01'], confirmation: ['2026-09-01', '2026-09-02'] } }), { message: 'campaign_windows_invalid' });
    // A day whose pool is not complete truth makes the plan refuse rather than label a partial day.
    const broken = structuredClone(document);
    delete broken.days[3].rows[0].evidence_type;
    const path = join(dir, 'broken.json');
    await writeFile(path, JSON.stringify(broken));
    await assert.rejects(planCampaign({ exportPath: path, month: '2026-10' }), { message: 'campaign_export_pool_incomplete' });
  });
});

test('an assembled campaign passes the manifest contract and registers the measured confirmation days as groups', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const labels = labelsFor(plan.ids, document);
    const built = await buildCampaign({ exportPath: gz, plan, labels, calibration: CALIBRATION, now: NOW, rootDir: root });
    assert.equal(built.status, 'assembled');
    const { manifest, inputs, supply } = built;
    assert.deepEqual(rsiCampaignIssues(manifest), []);
    assert.deepEqual([manifest.id, manifest.surface, manifest.candidateKind, manifest.claim, manifest.automated, manifest.deadline],
      ['frontier-selection-2026-10', 'frontier-selection', 'policy', 'superiority', true, '2026-10-31T16:00:00.000Z']);
    assert.deepEqual(manifest.models.improver, { provider: 'none', model: 'registered-grid' });
    assert.deepEqual([manifest.data.classification, manifest.data.sources.map((row) => [row.id, row.role, row.exposure])],
      ['public', [['development-2026-08', 'development', 'exposed'], ['confirmation-2026-09', 'confirmation', 'sealed']]]);
    // Every digest the manifest carries is the digest of what the inputs hold.
    for (const row of manifest.data.sources) assert.equal(row.digest, rsiDigest(inputs.sources[row.id]), row.id);
    assert.equal(manifest.registration.digest, rsiDigest(inputs.registration));
    assert.deepEqual(inputs.target, manifest.target);
    const closure = await computeRsiDependencyClosure({ rootDir: root, surface: 'frontier-selection', settings: { model: 'deepseek-flash', provider: 'deepseek' } });
    assert.equal(manifest.target.dependencyDigest, closure.dependencyDigest);
    assert.equal(manifest.target.baselineRevision, 'threshold-64-release-test.1');
    // Sources: only their own days, only their own labels, the band of the grid.
    const development = inputs.sources['development-2026-08'], confirmation = inputs.sources['confirmation-2026-09'];
    assert.ok(development.days.every((day) => day.day.startsWith('2026-08')) && confirmation.days.every((day) => day.day.startsWith('2026-09')));
    assert.equal(confirmation.days.length, 29);
    assert.deepEqual(development.band, { floor: 58, pickWeight: 3 });
    const ids = (source) => new Set(source.days.flatMap((day) => day.rows.map((row) => String(row.id))));
    assert.ok(development.labels.every((label) => ids(development).has(label.id)) && confirmation.labels.every((label) => ids(confirmation).has(label.id)));
    assert.ok(development.labels.some((label) => label.worth === null), 'an abstention stays in the source as null');
    // The groups are the confirmation days with at least twenty labelled rows: decided from labels, never from outcomes.
    const labelled = new Map(labels.labels.filter((label) => label.worth !== null).map((label) => [label.id, label.worth]));
    const planned = new Map(plan.perDay.map((row) => [row.day, row]));
    const expectedDays = plan.confirmDays.filter((day) => confirmation.days.find((d) => d.day === day).rows.filter((row) => labelled.has(String(row.id))).length >= 20);
    const statistics = inputs.registration.statistics;
    assert.deepEqual(statistics.groups.map((group) => group.day), expectedDays);
    assert.ok(expectedDays.length >= 25 && expectedDays.length < 29, `${expectedDays.length} groups: the thin days are left out`);
    assert.ok(!statistics.groups.some((group) => group.day >= '2026-09-28'));
    assert.deepEqual(statistics.groups[0], { id: `day-${expectedDays[0]}`, family: 'frontier-days', failure_slice: false, day: expectedDays[0] });
    assert.equal(statistics.G_target, expectedDays.length);
    assert.ok(planned.size >= expectedDays.length);
    // The statistics registration: procedure, claim alpha, identities and the corpus it will be opened against.
    const identity = await frontierCampaignConsumerIdentity();
    assert.deepEqual(statistics.procedure, BENIGN_PROCEDURE);
    assert.deepEqual([statistics.mode, statistics.deterministicConsumer, statistics.cost_identity, statistics.expires_at, statistics.consumer_id, statistics.corpus_digest],
      ['paired-t', true, 'deterministic-no-model-call', manifest.deadline, identity.implementationSha256, rsiDigest(confirmation)]);
    assert.deepEqual(statistics.claims, { superiority: RSI_QUARTER_ALPHA / 3 });
    assert.ok(statistics.families['frontier-days'].pilot_rationale.length > 40 && !('margin' in statistics.families['frontier-days']), 'superiority takes no margin');
    // The selection registration and the labelling record.
    assert.deepEqual([inputs.registration.baselineThreshold, inputs.registration.maxVolumeRatio, inputs.registration.minLabelled], [BASELINE, 1.1, 20]);
    assert.deepEqual(inputs.registration.selection, { objective: 'weighted-accuracy-difference', tieBreak: 'nearest-baseline' });
    assert.deepEqual(inputs.registration.labelling, { juryVersion: 'test-jury-1', model: 'test-model', calibrationDigest: rsiDigest({ qualification: CALIBRATION.qualification, calibration: CALIBRATION.calibration }) });
    // The supply report reads development alone.
    assert.equal(supply.development.days, 31);
    assert.equal(supply.confirmation.measuredDays, expectedDays.length);
    assert.equal(supply.alpha.allocated, RSI_QUARTER_ALPHA / 3);
    assert.equal(supply.alpha.testAlpha, RSI_QUARTER_ALPHA / 6);
    assert.equal(supply.minimumGroups, 25);
    assert.deepEqual(supply.developmentChoice.frozen, { threshold: 72 }, 'labels pick from 72 up, so the 72 line is the best of the grid');
    assert.ok(supply.power.mde > 0 && supply.power.mde < 0.1, JSON.stringify(supply.power));
    assert.equal(supply.exportSha256, plan.exportSha256);
    assert.deepEqual(supply.calibration, { qualified: true, juryVersion: 'test-jury-1', metrics: CALIBRATION.calibration });
    assert.ok(supply.development.abstained > 0 && supply.confirmation.abstained > 0);
  });
});

test('an assembled campaign runs through the real runner, the real statistics and a signed receipt to a verdict', async () => {
  await withExport(async ({ gz, document, dir }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const built = await buildCampaign({ exportPath: gz, plan, labels: labelsFor(plan.ids, document), calibration: CALIBRATION, now: NOW, rootDir: root });
    const run = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: join(dir, 'receipt') });
    assert.equal(run.awaiting.status, 'awaiting-evaluation');
    assert.equal(run.completed.status, 'completed');
    const evaluation = run.completed.checkpoint.evaluation;
    assert.equal(run.completed.checkpoint.frozenPolicy.threshold, 72);
    assert.equal(evaluation.scope, 'registered-population-task-family');
    assert.equal(run.completed.purpose, 'offline-evaluation');
    assert.equal(evaluation.quantities.superiority.quality_superiority.n_groups, built.inputs.registration.statistics.G_target);
    assert.equal(run.completed.qualification, 'qualified', JSON.stringify(evaluation.reasons));
    assert.ok(evaluation.quantities.superiority.quality_superiority.lower > 0);
    assert.equal(run.completed.releaseEligible, false, 'a verdict is never a release');
  });
});

test('labels that are not qualified assemble nothing', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const labels = labelsFor(plan.ids, document);
    const cases = [
      { calibration: { ...CALIBRATION, qualification: { qualified: false, reasons: ['pick kappa below the floor'] } }, shown: { qualification: { qualified: false, reasons: ['pick kappa below the floor'] }, metrics: CALIBRATION.calibration } },
      { calibration: { ...CALIBRATION, qualification: { qualified: 'yes' } }, shown: { qualification: { qualified: 'yes' }, metrics: CALIBRATION.calibration } },
      // The flat shape an earlier tool wrote is not a qualification.
      { calibration: { qualified: true, metrics: { kappa: 0.9 } }, shown: { qualification: null, metrics: null } },
      { calibration: { calibration: CALIBRATION.calibration }, shown: { qualification: null, metrics: CALIBRATION.calibration } },
      { calibration: null, shown: { qualification: null, metrics: null } },
      { calibration: undefined, shown: { qualification: null, metrics: null } },
      { calibration: {}, shown: { qualification: null, metrics: null } },
    ];
    for (const { calibration, shown } of cases) {
      const result = await buildCampaign({ exportPath: gz, plan, labels, calibration, now: NOW, rootDir: root });
      assert.deepEqual([result.status, result.reason], ['not-run', 'campaign_labels_unqualified'], JSON.stringify(calibration));
      assert.equal(result.manifest, undefined);
      assert.deepEqual(result.calibration, shown);
    }
  });
});

test('a build refuses an export that is not the one that was planned', async () => {
  await withExport(async ({ gz, plain, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    await assert.rejects(buildCampaign({ exportPath: plain, plan, labels: labelsFor(plan.ids, document), calibration: CALIBRATION, now: NOW, rootDir: root }), { message: 'campaign_export_changed' });
  });
});

test('windows and an id prefix make a rehearsal campaign with its own ids and deadline month', async () => {
  await withExport(async ({ gz, document }) => {
    const windows = { development: ['2026-08-01', '2026-08-20'], confirmation: ['2026-08-21', '2026-08-31'] };
    const plan = await planCampaign({ exportPath: gz, month: '2026-09', windows, idPrefix: 'rehearsal-' });
    assert.deepEqual([plan.development, plan.confirmation, plan.devDays.length, plan.confirmDays.length], ['2026-08-01..2026-08-20', '2026-08-21..2026-08-31', 20, 11]);
    const built = await buildCampaign({ exportPath: gz, plan, labels: labelsFor(plan.ids, document), calibration: CALIBRATION, now: '2026-09-01T00:00:00Z', rootDir: root });
    assert.equal(built.manifest.id, 'rehearsal-frontier-selection-2026-09');
    assert.equal(built.manifest.deadline, '2026-09-30T16:00:00.000Z');
    assert.deepEqual(rsiCampaignIssues(built.manifest), []);
    assert.deepEqual(built.manifest.data.sources.map((row) => row.id), ['development-2026-08-01..2026-08-20', 'confirmation-2026-08-21..2026-08-31']);
    const groups = built.inputs.registration.statistics.groups;
    assert.ok(groups.length > 0 && groups.every((group) => group.day >= '2026-08-21' && group.day <= '2026-08-31'), 'groups come from the confirmation window only');
    assert.equal(built.inputs.registration.statistics.G_target, groups.length);
  });
});

test('the plan and build commands write what the runner reads and refuse by closed code', async () => {
  await withExport(async ({ gz, dir, document }) => {
    const run = (args) => execFileAsync(process.execPath, [assembleScript, ...args], { cwd: dir, env: { PATH: process.env.PATH } });
    const planPath = join(dir, 'plan.json');
    const planned = JSON.parse((await run(['plan', '--export', gz, '--month', '2026-10', '--out', planPath])).stdout);
    assert.deepEqual([planned.status, planned.month, planned.devDays, planned.confirmDays, planned.drift], ['planned', '2026-10', 31, 29, []]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert.equal(planned.toLabel, plan.ids.length);
    await writeFile(join(dir, 'labels.json'), JSON.stringify(labelsFor(plan.ids, document)));
    await writeFile(join(dir, 'calibration.json'), JSON.stringify(CALIBRATION));
    const outDir = join(dir, 'campaign');
    const common = ['--export', gz, '--plan', planPath, '--labels', join(dir, 'labels.json'), '--out-dir', outDir, '--now', NOW];
    const built = JSON.parse((await run(['build', ...common, '--calibration', join(dir, 'calibration.json')])).stdout);
    assert.deepEqual([built.status, built.reason, built.campaignId], ['assembled', null, 'frontier-selection-2026-10']);
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')), inputs = JSON.parse(await readFile(join(outDir, 'inputs.json'), 'utf8'));
    assert.deepEqual(rsiCampaignIssues(manifest), []);
    assert.equal(manifest.registration.digest, rsiDigest(inputs.registration));
    assert.equal(built.groups, inputs.registration.statistics.G_target);
    assert.ok(built.mde > 0);
    assert.equal(JSON.parse(await readFile(join(outDir, 'supply.json'), 'utf8')).confirmation.measuredDays, built.groups);
    // Unqualified labels write the supply report only: no manifest, no inputs.
    const refusedDir = join(dir, 'unqualified');
    await writeFile(join(dir, 'bad-calibration.json'), JSON.stringify({ ...CALIBRATION, qualification: { qualified: false, reasons: ['pick kappa below the floor'] } }));
    const notRun = JSON.parse((await run(['build', ...common.map((x) => (x === outDir ? refusedDir : x)), '--calibration', join(dir, 'bad-calibration.json')])).stdout);
    assert.deepEqual([notRun.status, notRun.reason, notRun.campaignId], ['not-run', 'campaign_labels_unqualified', null]);
    await assert.rejects(readFile(join(refusedDir, 'manifest.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(refusedDir, 'supply.json'), 'utf8')).reason, 'campaign_labels_unqualified');
    // Refusals: one closed reason on stderr, a non-zero exit, no detail for a closed code.
    const bad = await run(['plan', '--export', gz, '--month', 'October', '--out', planPath]).catch((error) => error);
    assert.equal(bad.code, 1);
    assert.deepEqual(JSON.parse(bad.stderr), { status: 'refused', reason: 'campaign_plan_arguments_invalid' });
    const missing = await run(['plan', '--export', join(dir, 'absent.json'), '--month', '2026-10', '--out', planPath]).catch((error) => error);
    assert.equal(JSON.parse(missing.stderr).reason, 'campaign_assembly_failed');
    assert.equal((await run(['bogus']).catch((error) => error)).code, 1);
  });
});
