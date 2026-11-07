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
import { createRsiServingAdapters, rsiIncumbent, rsiPolicyDefaults } from '../../../apps/server/src/rsiServingAdapters.mjs';
import { rsiCampaignIssues, rsiCompatibilityIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { RSI_QUARTER_ALPHA } from '../campaign_runner.mjs';
import { chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity } from '../frontier_campaign.mjs';
import { replayFrontierPool } from '../frontier_selection.mjs';
import { FRONTIER_CAMPAIGN_REGISTRATION, UNBOUND_BASELINE_PREFIX, beijingMonthEnd, buildCampaign, campaignRegistration, decideDevelopment, mergeLabelFiles, minimumDetectableEffect, planCampaign, readFrontierExport, replayDrift, shiftMonth, splitDays, unboundBaselineRevision } from '../frontier_assemble.mjs';
import { BENIGN_PROCEDURE, STATISTICS_MODULE_PATH, STATISTICS_PYTHON, frontierDayPool, frontierDaysSource, runToVerdict } from '../profiles/benign_fixture.mjs';

const execFileAsync = promisify(execFile);
const root = new URL('../../../', import.meta.url).pathname;
const assembleScript = new URL('../frontier_assemble.mjs', import.meta.url).pathname;
const NOW = '2026-10-26T00:00:00Z';
const BASELINE = 64;
/** What production's export carries for a module that runs on the code defaults: the serving layer's own identity (`rsiIncumbent`), threshold 64. */
const INCUMBENT = { revisionId: rsiIncumbent('frontier', null, rsiPolicyDefaults('frontier', { frontierSelectThreshold: BASELINE })).revisionId, threshold: BASELINE };

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
    incumbent: INCUMBENT, consumer: [], days: [...august, ...september, ...thin, incomplete], texts: {}, signals: {},
  };
}
const allRows = (document) => document.days.flatMap((day) => day.rows);
/** The provider and model the jury's files name (frontier_labels.mjs writes both in the labels and in the calibration): the frontier jury, the one Qwen adjudicator the domain admits. */
const JURY_PROVIDER = 'dashscope';
const JURY_MODEL = 'qwen3.8-max';
/** What a labeller would say: a pick from 72 up, an alert is always a pick, every seventeenth row is left unlabelled. */
function labelsFor(ids, document) {
  const byId = new Map(allRows(document).map((row) => [String(row.id), row]));
  return { juryVersion: 'test-jury-1', provider: JURY_PROVIDER, model: JURY_MODEL, labels: ids.map((id, i) => {
    const row = byId.get(id);
    return { id, worth: i % 17 === 16 ? null : row.safety_alert === true || row.score_total >= 72 ? 'pick' : row.score_total >= 68 ? 'ok' : 'no' };
  }) };
}
/** The jury's calibration file as `frontier_labels.mjs calibrate` writes it: metrics under `calibration`, the gate under `qualification`. */
const CALIBRATION = { schema: 'rsi-frontier-jury-calibration-v1', juryVersion: 'test-jury-1', provider: JURY_PROVIDER, model: JURY_MODEL, calibration: { pickKappa: 0.81, abstentionRate: 0.05, pickPrecision: 0.8 }, qualification: { qualified: true, reasons: [] } };

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
    // No improver (the registered grid) and, as the judge, the jury the labels file names.
    assert.deepEqual(manifest.models, { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: [], judges: [{ role: 'jury', provider: JURY_PROVIDER, model: JURY_MODEL, id: 'test-jury-1' }] });
    assert.deepEqual([manifest.data.classification, manifest.data.sources.map((row) => [row.id, row.role, row.exposure])],
      ['public', [['development-2026-08', 'development', 'exposed'], ['confirmation-2026-09', 'confirmation', 'sealed']]]);
    // Every digest the manifest carries is the digest of what the inputs hold.
    for (const row of manifest.data.sources) assert.equal(row.digest, rsiDigest(inputs.sources[row.id]), row.id);
    assert.equal(manifest.registration.digest, rsiDigest(inputs.registration));
    assert.deepEqual(inputs.target, manifest.target);
    const closure = await computeRsiDependencyClosure({ rootDir: root, surface: 'frontier-selection', settings: { model: 'deepseek-flash', provider: 'deepseek' } });
    assert.equal(manifest.target.dependencyDigest, closure.dependencyDigest);
    assert.equal(manifest.target.baselineRevision, INCUMBENT.revisionId, 'the baseline is the incumbent identity the export carries, as it is');
    assert.match(manifest.target.baselineRevision, /^default:[a-f0-9]{64}$/);
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
    assert.deepEqual(inputs.registration.labelling, { juryVersion: 'test-jury-1', provider: JURY_PROVIDER, model: JURY_MODEL, calibrationDigest: rsiDigest({ qualification: CALIBRATION.qualification, calibration: CALIBRATION.calibration }) });
    // The supply report reads development alone.
    assert.equal(supply.development.days, 31);
    assert.equal(supply.confirmation.measuredDays, expectedDays.length);
    assert.equal(supply.alpha.allocated, RSI_QUARTER_ALPHA / 3);
    assert.equal(supply.alpha.testAlpha, RSI_QUARTER_ALPHA / 6);
    assert.equal(supply.minimumGroups, 25);
    assert.equal(supply.directional, false, `${expectedDays.length} measured days reach the minimum`);
    assert.deepEqual(supply.developmentChoice.frozen, { threshold: 72 }, 'labels pick from 72 up, so the 72 line is the best of the grid');
    assert.ok(supply.power.mde > 0 && supply.power.mde < 0.1, JSON.stringify(supply.power));
    assert.equal(supply.exportSha256, plan.exportSha256);
    assert.deepEqual(supply.calibration, { qualified: true, juryVersion: 'test-jury-1', model: JURY_MODEL, metrics: CALIBRATION.calibration });
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
    assert.equal(built.supply.directional, true, `${groups.length} measured days are below the procedure's 25: the runner reserves no alpha for it`);
  });
});

test('the judge is the jury that produced the labels, held to the domain\'s rule: the frontier jury (Qwen, role jury) or a pinned Claude model; any other jury, or labels from another jury than the calibrated one, assemble nothing', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const labels = labelsFor(plan.ids, document);
    const build = (labelsFile, calibration = CALIBRATION) => buildCampaign({ exportPath: gz, plan, labels: labelsFile, calibration, now: NOW, rootDir: root });
    // The jury of the lab: admitted, and the manifest says so in the form the domain admits on this surface.
    const built = await build(labels);
    assert.equal(built.status, 'assembled');
    assert.deepEqual(built.manifest.models.judges, [{ role: 'jury', provider: 'dashscope', model: 'qwen3.8-max', id: 'test-jury-1' }]);
    // A pinned Claude model is still an admitted adjudicator everywhere, this surface included.
    assert.equal((await build({ ...labels, provider: 'anthropic', model: 'claude-sonnet-5-5' }, { ...CALIBRATION, provider: 'anthropic', model: 'claude-sonnet-5-5' })).status, 'assembled');
    // Anything else is refused by name, before anything is assembled: a file that names no provider, another Qwen, a DeepSeek model, a provider that does not match the model.
    for (const [provider, model] of [[undefined, JURY_MODEL], [undefined, 'claude-sonnet-5-5'], ['dashscope', 'qwen3.8-plus'], ['dashscope', 'qwen-max'], ['deepseek', 'deepseek-flash'], ['deepseek', 'deepseek-v4-pro'],
      ['anthropic', 'qwen3.8-max'], ['dashscope', 'claude-sonnet-5-5'], ['openai', 'gpt-5'], ['dashscope', undefined]]) {
      const refused = await build({ ...labels, provider, model }, { ...CALIBRATION, provider, model });
      assert.deepEqual([refused.status, refused.reason, refused.manifest], ['not-run', 'campaign_judge_refused', undefined], `${provider}/${model}`);
    }
    // Labels from another model or another provider than the calibration qualified are another jury.
    const changed = await build({ ...labels, provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.deepEqual([changed.status, changed.reason, changed.jury], ['not-run', 'campaign_labels_jury_changed', { labels: 'claude-opus-5-5', calibration: JURY_MODEL }]);
    const provider = await build({ ...labels, provider: 'anthropic' });
    assert.deepEqual([provider.status, provider.reason], ['not-run', 'campaign_labels_jury_changed']);
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

// ---- the incumbent as the baseline ----

test('an incumbent the export carries must be one of the two forms the serving layer reports, for the threshold it states; one it does not carry is recorded as none', async () => {
  const absent = exportDocument();
  delete absent.incumbent;
  for (const document of [absent, { ...exportDocument(), incumbent: null }]) await withExport(async ({ gz }) => assert.equal((await planCampaign({ exportPath: gz, month: '2026-10' })).incumbent, null), document);
  for (const incumbent of [{ revisionId: 'threshold-64-release-test.1', threshold: BASELINE }, { revisionId: 'default:abc', threshold: BASELINE }, { revisionId: 'evolution-module-policy-frontier:0', threshold: BASELINE },
    { revisionId: 'evolution-module-policy-geo:3', threshold: BASELINE }, { revisionId: INCUMBENT.revisionId, threshold: 70 }, { revisionId: INCUMBENT.revisionId }, 'default']) {
    await withExport(async ({ gz }) => assert.rejects(planCampaign({ exportPath: gz, month: '2026-10' }), { message: 'campaign_export_incumbent_invalid' }, JSON.stringify(incumbent)), { ...exportDocument(), incumbent });
  }
  await withExport(async ({ gz }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    assert.deepEqual(plan.incumbent, { revisionId: 'evolution-module-policy-frontier:12', threshold: BASELINE });
  }, { ...exportDocument(), incumbent: { revisionId: 'evolution-module-policy-frontier:12', threshold: BASELINE } });
});

test('a month whose export carries no incumbent is still planned, decided and built; its baseline is unbound and no served baseline matches it', async () => {
  const absent = exportDocument();
  delete absent.incumbent;
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    assert.equal(plan.incumbent, null);
    assert.ok(plan.ids.length > 0 && plan.idsByRole.development.length > 0, 'the plan is the same plan: the operator labels the same rows');
    const decision = await decideDevelopment({ exportPath: gz, plan, labels: phaseLabels(plan, document, 'development'), calibration: CALIBRATED });
    assert.equal(decision.status, 'confirmation-needed');
    assert.equal(decision.supply.incumbent, null);
    const merged = mergeLabelFiles([phaseLabels(plan, document, 'development'), phaseLabels(plan, document, 'confirmation')], plan);
    const built = await buildCampaign({ exportPath: gz, plan, labels: merged, calibration: CALIBRATED, now: NOW, rootDir: root });
    assert.equal(built.status, 'assembled');
    assert.equal(built.manifest.target.baselineRevision, 'unbound:release-test.1');
    assert.deepEqual(rsiCampaignIssues(built.manifest), [], 'the domain accepts the manifest');
    assert.equal(built.supply.incumbent, null);
    // The importer's compatibility check can never pass it against what production serves: a default or a module policy.
    for (const row of [null, { payload: { status: 'active', policy: { selectionThreshold: BASELINE } }, revision: 7 }]) {
      assert.deepEqual(rsiCompatibilityIssues(built.manifest.target, await servingTarget(row)), ['campaign_baseline_changed']);
    }
    // The same labels on the same export with its incumbent measure the same campaign but for the baseline's name.
    const bound = await buildCampaign({ exportPath: gz, plan: { ...plan, incumbent: INCUMBENT }, labels: merged, calibration: CALIBRATED, now: NOW, rootDir: root });
    assert.deepEqual({ ...built.manifest, target: null }, { ...bound.manifest, target: null });
    assert.deepEqual({ ...built.inputs, target: null }, { ...bound.inputs, target: null });
    assert.deepEqual({ ...built.manifest.target, baselineRevision: null }, { ...bound.manifest.target, baselineRevision: null });
    assert.equal(bound.manifest.target.baselineRevision, INCUMBENT.revisionId);
  }, absent);
});

test('the unbound baseline names the release, in the characters a baseline identifier takes, and never an empty one', () => {
  assert.equal(UNBOUND_BASELINE_PREFIX, 'unbound:');
  assert.equal(unboundBaselineRevision('release-test.1'), 'unbound:release-test.1');
  assert.equal(unboundBaselineRevision(null), 'unbound:unknown');
  assert.equal(unboundBaselineRevision(undefined), 'unbound:unknown');
  assert.equal(unboundBaselineRevision(''), 'unbound:unknown');
  assert.equal(unboundBaselineRevision('rel ease/1 中'), 'unbound:rel-ease-1--');
  assert.equal(unboundBaselineRevision('r'.repeat(500)).length, 'unbound:'.length + 150);
  for (const releaseId of [null, 'release-test.1', 'a b', 'r'.repeat(500), '中文']) assert.match(unboundBaselineRevision(releaseId), /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/, `${releaseId}: a valid baseline identifier`);
});

/** The target a serving process with this module-policy row would report for the frontier surface (the real adapter, a client that answers one row). */
async function servingTarget(policyRow) {
  const serving = createRsiServingAdapters({ config: { frontierModel: 'deepseek-flash', frontierSelectThreshold: BASELINE, rootDir: root }, service: { owner: async () => 'owner' }, database: {}, documents: {} });
  return serving.currentTarget('frontier-selection', { query: async () => ({ rows: policyRow ? [policyRow] : [] }) });
}

test('a bundle built from an export names the baseline the serving layer will compare it with: default code, or the active module policy', async () => {
  const policyRow = { payload: { status: 'active', policy: { selectionThreshold: BASELINE } }, revision: 7 };
  for (const row of [null, policyRow, { payload: { status: 'stopped', policy: { selectionThreshold: 70 } }, revision: 9 }, { payload: { status: 'active', policy: { selectionThreshold: 'high' } }, revision: 3 }]) {
    // What the export script records: the serving layer's own function over the row it read.
    const incumbent = rsiIncumbent('frontier', row, rsiPolicyDefaults('frontier', { frontierSelectThreshold: BASELINE }));
    await withExport(async ({ gz, document }) => {
      const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
      const built = await buildCampaign({ exportPath: gz, plan, labels: labelsFor(plan.ids, document), calibration: CALIBRATION, now: NOW, rootDir: root });
      const current = await servingTarget(row);
      assert.equal(current.qualified, true);
      assert.deepEqual(rsiCompatibilityIssues(built.manifest.target, current), [], `${incumbent.revisionId}: the importer's compatibility check passes`);
      assert.equal(built.manifest.target.baselineRevision, current.baselineRevision);
      assert.equal(built.manifest.target.dependencyDigest, current.dependencyDigest);
    }, { ...exportDocument(), incumbent: { revisionId: incumbent.revisionId, threshold: BASELINE } });
  }
  assert.match((await servingTarget(policyRow)).baselineRevision, /^evolution-module-policy-frontier:7$/);
  assert.match((await servingTarget(null)).baselineRevision, /^default:[a-f0-9]{64}$/);
});

test('a bundle whose baseline is not the incumbent at import is refused, whatever else matches: a policy changed since the export, or the label the lab used to write', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const { manifest } = await buildCampaign({ exportPath: gz, plan, labels: labelsFor(plan.ids, document), calibration: CALIBRATION, now: NOW, rootDir: root });
    const activated = await servingTarget({ payload: { status: 'active', policy: { selectionThreshold: 70 } }, revision: 2 });
    assert.deepEqual(rsiCompatibilityIssues(manifest.target, activated), ['campaign_baseline_changed']);
    const old = { ...manifest.target, baselineRevision: 'threshold-64-release-test.1' };
    assert.deepEqual(rsiCompatibilityIssues(old, await servingTarget(null)), ['campaign_baseline_changed']);
  });
});

// ---- two phases of labelling: development decides whether confirmation is labelled ----

const PROMPT_DIGEST = 'f'.repeat(64);
/** A labels file as `frontier_labels.mjs label` writes it for one phase of a plan (the calibration it was qualified by names the same jury). */
function phaseLabels(plan, document, phase, over = {}) {
  const ids = plan.idsByRole[phase], file = labelsFor(ids, document);
  return { schema: 'rsi-frontier-jury-labels-v1', phase, month: plan.month, idPrefix: '', exportSha256: plan.exportSha256, juryVersion: file.juryVersion, provider: JURY_PROVIDER, model: JURY_MODEL, promptDigest: PROMPT_DIGEST,
    items: ids.length, missing: 0, labelled: file.labels.length, incomplete: 0, labelCounts: { pick: 1, ok: 2, no: 3, abstained: 4, refused: 5 }, calls: 2 * ids.length, cachedCalls: 0,
    costCny: phase === 'development' ? 1.25 : 0.5, stopped: null, labels: file.labels, ...over };
}
const CALIBRATED = { ...CALIBRATION, promptDigest: PROMPT_DIGEST };
/** Labels that make the baseline perfect on every day: a row is a pick exactly when the baseline selects it, so no threshold can beat it. */
function baselineIsPerfect(plan, document, phase) {
  const selected = new Set(document.days.filter((day) => day.complete).flatMap((day) => replayFrontierPool(day, plan.registration.baselineThreshold).selectedIds.map(String)));
  const file = phaseLabels(plan, document, phase);
  return { ...file, labels: file.labels.map((label) => ({ ...label, worth: selected.has(label.id) ? 'pick' : 'ok' })) };
}

test('the plan asks about development first and confirmation only for ids development did not ask', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const { development, confirmation } = plan.idsByRole;
    assert.ok(development.length > 0 && confirmation.length > 0);
    assert.equal(new Set([...development, ...confirmation]).size, development.length + confirmation.length, 'an id is asked once');
    assert.deepEqual([...new Set([...development, ...confirmation])].sort(), plan.ids);
    const rowsOf = (days) => new Set(document.days.filter((day) => days.includes(day.day)).flatMap((day) => day.rows.map((row) => String(row.id))));
    assert.ok(development.every((id) => rowsOf(plan.devDays).has(id)) && confirmation.every((id) => rowsOf(plan.confirmDays).has(id)));
    // The rehearsal windows split the same way.
    const windowed = await planCampaign({ exportPath: gz, month: '2026-09', windows: { development: ['2026-08-01', '2026-08-20'], confirmation: ['2026-08-21', '2026-08-31'] }, idPrefix: 'rehearsal-' });
    assert.ok(windowed.idsByRole.development.every((id) => rowsOf(windowed.devDays).has(id)));
  });
});

test('decide: development labels alone freeze a candidate, so confirmation is worth labelling, and it is the choice the build and the runner reach', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const decision = await decideDevelopment({ exportPath: gz, plan, labels: phaseLabels(plan, document, 'development'), calibration: CALIBRATED });
    assert.deepEqual([decision.status, decision.reason, decision.frozen], ['confirmation-needed', null, { threshold: 72 }]);
    assert.equal(decision.supply.development.days, 31);
    assert.equal(decision.supply.confirmation.days, 29);
    assert.deepEqual([decision.supply.confirmation.measuredDays, decision.supply.confirmation.labelled], [null, null], 'what confirmation labels would make of its days is not known yet');
    assert.deepEqual(decision.supply.calibration, { qualified: true, juryVersion: 'test-jury-1', model: JURY_MODEL, metrics: CALIBRATION.calibration });
    assert.deepEqual(decision.supply.incumbent, INCUMBENT);
    // The same labels, both phases merged, build the same development choice.
    const merged = mergeLabelFiles([phaseLabels(plan, document, 'development'), phaseLabels(plan, document, 'confirmation')], plan);
    const built = await buildCampaign({ exportPath: gz, plan, labels: merged, calibration: CALIBRATED, now: NOW, rootDir: root });
    assert.equal(built.status, 'assembled');
    assert.deepEqual(built.supply.developmentChoice, decision.supply.developmentChoice);
    assert.deepEqual(built.inputs.registration.labelling, { juryVersion: 'test-jury-1', provider: JURY_PROVIDER, model: JURY_MODEL, calibrationDigest: rsiDigest({ qualification: CALIBRATION.qualification, calibration: CALIBRATION.calibration }) });
    assert.deepEqual(built.manifest.models.judges, [{ role: 'jury', provider: JURY_PROVIDER, model: JURY_MODEL, id: 'test-jury-1' }]);
    assert.equal(decision.supply.replayFidelity, built.supply.replayFidelity);
  });
});

test('decide, build and the runner choose under the registered volume ratio, whatever it is: a ratio below the frozen candidate\'s volume refuses it in all three', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const development = phaseLabels(plan, document, 'development');
    const usual = await decideDevelopment({ exportPath: gz, plan, labels: development, calibration: CALIBRATED });
    const frozen = usual.supply.developmentChoice.candidates.find((c) => c.threshold === usual.frozen.threshold);
    assert.ok(frozen.volumeRatio < 1.1, `the usual choice selects ${frozen.volumeRatio} of the baseline's volume`);
    const registered = { ...FRONTIER_CAMPAIGN_REGISTRATION, maxVolumeRatio: Math.round(frozen.volumeRatio * 0.9 * 1000) / 1000 };
    const tight = await decideDevelopment({ exportPath: gz, plan, labels: development, calibration: CALIBRATED, registered });
    assert.notDeepEqual(tight.frozen, usual.frozen, 'the registered ratio refuses the threshold the default ratio would freeze');
    assert.ok(tight.supply.developmentChoice.candidates.filter((c) => c.eligible).every((c) => c.volumeRatio <= registered.maxVolumeRatio));
    const merged = mergeLabelFiles([development, phaseLabels(plan, document, 'confirmation')], plan);
    const built = await buildCampaign({ exportPath: gz, plan, labels: merged, calibration: CALIBRATED, now: NOW, rootDir: root, registered });
    assert.equal(built.inputs.registration.maxVolumeRatio, registered.maxVolumeRatio);
    assert.deepEqual(built.supply.developmentChoice, tight.supply.developmentChoice);
    // The runner's own development stage over the built inputs (campaign_runner.mjs `develop`): the same functions, the same registration.
    const source = built.inputs.sources[built.manifest.data.sources.find((row) => row.role === 'development').id];
    const runner = chooseFrontierCandidate(evaluateFrontierDays(source, built.inputs.registration), built.inputs.registration);
    assert.deepEqual(runner.frozen, tight.frozen);
    assert.deepEqual(runner.candidates, tight.supply.developmentChoice.candidates);
  });
});

test('decide: a month whose development finds no candidate ends there, with the reason the runner gives, and confirmation is never asked for', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const decision = await decideDevelopment({ exportPath: gz, plan, labels: baselineIsPerfect(plan, document, 'development'), calibration: CALIBRATED });
    assert.deepEqual([decision.status, decision.reason, decision.frozen], ['development-ended', 'campaign_no_improving_candidate', null]);
    assert.equal(decision.supply.developmentChoice.frozen, null);
    assert.equal(decision.supply.confirmation.measuredDays, null);
    assert.ok(decision.supply.development.labelled > 0);
  });
});

test('decide refuses what is not the development labels of this plan, and an unqualified or changed jury ends the month before anything is read', async () => {
  await withExport(async ({ gz, plain, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const labels = phaseLabels(plan, document, 'development');
    const decide = (over = {}, calibration = CALIBRATED, file = labels) => decideDevelopment({ exportPath: gz, plan, labels: { ...file, ...over }, calibration });
    assert.deepEqual(Object.values(await decide({}, { ...CALIBRATED, qualification: { qualified: false, reasons: ['kappa_below_minimum'] } })).slice(0, 2), ['not-run', 'campaign_labels_unqualified']);
    for (const [over, calibration, reason] of [[{ model: 'claude-opus-5-5' }, CALIBRATED, 'campaign_labels_jury_changed'], [{ provider: 'anthropic' }, CALIBRATED, 'campaign_labels_jury_changed'],
      [{ promptDigest: 'e'.repeat(64) }, CALIBRATED, 'campaign_labels_jury_changed'], [{}, { ...CALIBRATED, juryVersion: 'other' }, 'campaign_labels_jury_changed'],
      [{ model: 'qwen3.8-plus' }, { ...CALIBRATED, model: 'qwen3.8-plus' }, 'campaign_judge_refused'], [{ provider: 'deepseek', model: 'deepseek-flash' }, { ...CALIBRATED, provider: 'deepseek', model: 'deepseek-flash' }, 'campaign_judge_refused']]) {
      const refused = await decide(over, calibration);
      assert.deepEqual([refused.status, refused.reason, refused.frozen], ['not-run', reason, undefined], JSON.stringify(over));
    }
    for (const [over, message] of [[{ phase: 'confirmation' }, 'campaign_labels_phase_invalid'], [{ phase: 'all' }, 'campaign_labels_phase_invalid'], [{ schema: 'rsi-frontier-jury-calibration-v1' }, 'campaign_labels_phase_invalid'],
      [{ exportSha256: 'e'.repeat(64) }, 'campaign_labels_phase_invalid'], [{ stopped: 'jury_quota' }, 'campaign_labels_incomplete'], [{ incomplete: 3 }, 'campaign_labels_incomplete'],
      [{ labels: [...labels.labels, { id: plan.idsByRole.confirmation[0], worth: 'pick', basis: 'jury-agree', passes: [] }] }, 'campaign_labels_outside_plan']]) {
      await assert.rejects(decide(over), { message }, JSON.stringify(Object.keys(over)));
    }
    await assert.rejects(decideDevelopment({ exportPath: plain, plan, labels, calibration: CALIBRATED }), { message: 'campaign_export_changed' });
  });
});

test('merge-labels takes exactly the two phases of one jury, one export and one finished run each, and sums what they cost', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const dev = phaseLabels(plan, document, 'development'), conf = phaseLabels(plan, document, 'confirmation');
    const merged = mergeLabelFiles([dev, conf], plan);
    assert.deepEqual([merged.schema, merged.phase, merged.provider, merged.model, merged.juryVersion, merged.promptDigest, merged.exportSha256, merged.stopped, merged.incomplete, merged.costCny],
      ['rsi-frontier-jury-labels-v1', 'all', JURY_PROVIDER, JURY_MODEL, 'test-jury-1', PROMPT_DIGEST, plan.exportSha256, null, 0, 1.75]);
    assert.ok(!('effort' in merged) && !('tokens' in merged) && !('costBasis' in merged), 'nothing of the retired Claude-CLI form');
    assert.equal(merged.labels.length, plan.ids.length);
    assert.deepEqual(merged.labelCounts, { pick: 2, ok: 4, no: 6, abstained: 8, refused: 10 });
    assert.deepEqual([merged.calls, merged.labelled], [dev.calls + conf.calls, plan.ids.length]);
    // The merge is a labels file: the build takes it and sees one jury.
    assert.equal((await buildCampaign({ exportPath: gz, plan, labels: merged, calibration: CALIBRATED, now: NOW, rootDir: root })).status, 'assembled');
    for (const [files, message] of [
      [[dev], 'campaign_labels_phase_invalid'], [[dev, dev], 'campaign_labels_phase_invalid'], [[dev, conf, conf], 'campaign_labels_phase_invalid'], [[dev, { ...conf, phase: undefined }], 'campaign_labels_phase_invalid'],
      [[dev, { ...conf, model: 'claude-opus-5-5' }], 'campaign_labels_jury_changed'], [[dev, { ...conf, provider: 'anthropic' }], 'campaign_labels_jury_changed'], [[dev, { ...conf, juryVersion: 'v2' }], 'campaign_labels_jury_changed'],
      [[dev, { ...conf, exportSha256: 'e'.repeat(64) }], 'campaign_labels_export_mismatch'], [[{ ...dev, stopped: 'jury_quota' }, conf], 'campaign_labels_incomplete'], [[dev, { ...conf, incomplete: 1 }], 'campaign_labels_incomplete'],
      [[dev, { ...conf, labels: [dev.labels[0], ...conf.labels] }], 'campaign_labels_outside_plan'], [[{ ...dev, labels: [...dev.labels, dev.labels[0]] }, conf], 'campaign_labels_outside_plan'],
    ]) assert.throws(() => mergeLabelFiles(files, plan), { message }, message);
  });
});

test('a build refuses labels made from another export or from a run that did not finish', async () => {
  await withExport(async ({ gz, document }) => {
    const plan = await planCampaign({ exportPath: gz, month: '2026-10' });
    const labels = { ...labelsFor(plan.ids, document), promptDigest: PROMPT_DIGEST };
    const build = (over) => buildCampaign({ exportPath: gz, plan, labels: { ...labels, ...over }, calibration: CALIBRATED, now: NOW, rootDir: root });
    assert.equal((await build({})).status, 'assembled');
    await assert.rejects(build({ exportSha256: 'e'.repeat(64) }), { message: 'campaign_labels_export_mismatch' });
    await assert.rejects(build({ stopped: 'jury_quota' }), { message: 'campaign_labels_incomplete' });
    await assert.rejects(build({ incomplete: 2 }), { message: 'campaign_labels_incomplete' });
    assert.equal((await build({ provider: 'anthropic' })).reason, 'campaign_labels_jury_changed');
  });
});

test('the decide and merge-labels commands write what the lab script reads', async () => {
  await withExport(async ({ gz, dir, document }) => {
    const run = (args) => execFileAsync(process.execPath, [assembleScript, ...args], { cwd: dir, env: { PATH: process.env.PATH } });
    const planPath = join(dir, 'plan.json');
    await run(['plan', '--export', gz, '--month', '2026-10', '--out', planPath]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
    await write('dev.json', phaseLabels(plan, document, 'development')); await write('conf.json', phaseLabels(plan, document, 'confirmation')); await write('calibration.json', CALIBRATED);
    const decided = JSON.parse((await run(['decide', '--export', gz, '--plan', planPath, '--labels', join(dir, 'dev.json'), '--calibration', join(dir, 'calibration.json'), '--out', join(dir, 'decision.json')])).stdout);
    assert.deepEqual(decided, { status: 'confirmation-needed', reason: null, frozen: { threshold: 72 } });
    assert.equal(JSON.parse(await readFile(join(dir, 'decision.json'), 'utf8')).supply.development.days, 31);
    const merged = JSON.parse((await run(['merge-labels', '--plan', planPath, '--labels', join(dir, 'dev.json'), '--labels', join(dir, 'conf.json'), '--out', join(dir, 'labels.json')])).stdout);
    assert.equal(merged.status, 'merged');
    const built = JSON.parse((await run(['build', '--export', gz, '--plan', planPath, '--labels', join(dir, 'labels.json'), '--calibration', join(dir, 'calibration.json'), '--out-dir', join(dir, 'campaign'), '--now', NOW])).stdout);
    assert.equal(built.status, 'assembled');
    // Closed refusals.
    const phase = await run(['decide', '--export', gz, '--plan', planPath, '--labels', join(dir, 'conf.json'), '--calibration', join(dir, 'calibration.json'), '--out', join(dir, 'x.json')]).catch((error) => error);
    assert.deepEqual(JSON.parse(phase.stderr), { status: 'refused', reason: 'campaign_labels_phase_invalid' });
    const two = await run(['build', '--export', gz, '--plan', planPath, '--labels', join(dir, 'dev.json'), '--labels', join(dir, 'conf.json'), '--calibration', join(dir, 'calibration.json'), '--out-dir', join(dir, 'campaign2')]).catch((error) => error);
    assert.equal(JSON.parse(two.stderr).reason, 'campaign_labels_phase_invalid');
  });
});
