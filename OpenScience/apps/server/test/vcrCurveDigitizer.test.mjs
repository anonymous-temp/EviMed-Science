/**
 * The control plane's half of the figure digitizer: what a run may state, what
 * the container's answer is checked against, and the record it becomes. The
 * numerical accuracy of the digitizer itself is measured in
 * `runtime/mcp/evimed-research/test/test_vcr_curve_digitize.py`; here the real
 * script runs on the same committed figures through the real launch plan's
 * arguments (`helpers/vcrIntakeLocal.mjs`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateScenario } from '@evimed/domain';
import { HttpError } from '../src/security.mjs';
import { VCR_DIGITIZER_TOOL, checkCalibration, checkDigitization, checkDigitizeRequest, createVcrCurveDigitizer } from '../src/vcrCurveDigitizer.mjs';
import { createIntakeCounters } from '../src/vcrRecordExtract.mjs';
import { MCP_DIR, localIntakeController, pythonCan } from './helpers/vcrIntakeLocal.mjs';

const HAVE = pythonCan('numpy', 'PIL', 'scipy');
const FIXTURES = path.join(MCP_DIR, 'test', 'fixtures', 'vcr_curves');
const RISK = [{ time: 0, atRisk: 220 }, { time: 24, atRisk: 90 }, { time: 48, atRisk: 20 }];
const CAL48 = { x: { min: 0, max: 48, unit: 'months' }, y: { min: 0, max: 1, scale: 'fraction' } };
const arm = (name, curve, extra = {}) => ({ name, curve, riskTable: RISK, ...extra });

// --- what a run may state ------------------------------------------------------

test('the calibration the control plane refuses is the calibration the digitizer refuses', { skip: !HAVE && 'python3 with numpy, Pillow and scipy is needed' }, () => {
  const good = CAL48;
  const cases = [
    good,
    { x: { min: 0, max: 10, unit: 'years' }, y: { min: 0, max: 100, scale: 'percent' } },
    { x: { min: 0, max: 36, unit: 'months' }, y: { min: 0.5, max: 1, scale: 'fraction' } },
    { x: { min: 0, max: 48, unit: 'months' }, y: { min: 0, max: 1.05, scale: 'fraction' } },
    { x: { min: 0, max: 0, unit: 'months' }, y: good.y }, { x: { min: 0, max: -3, unit: 'months' }, y: good.y }, { x: { min: -1, max: 48, unit: 'months' }, y: good.y },
    { x: { min: 0, max: 48, unit: '' }, y: good.y }, { x: { min: 0, max: 48, unit: 'x'.repeat(21) }, y: good.y }, { x: { min: 0, max: 48 }, y: good.y },
    { x: { min: '0', max: 48, unit: 'months' }, y: good.y }, { x: { min: 0, max: null, unit: 'months' }, y: good.y },
    { x: good.x, y: { min: 0, max: 5, scale: 'fraction' } }, { x: good.x, y: { min: 0, max: 100, scale: 'fraction' } }, { x: good.x, y: { min: 0, max: 1, scale: 'pct' } },
    { x: good.x, y: { min: -0.1, max: 1, scale: 'fraction' } }, { x: good.x, y: { min: 0.99, max: 1, scale: 'fraction' } }, { x: good.x, y: { min: 0, max: 0, scale: 'fraction' } },
    { x: good.x, y: { min: 0, max: 0.02, scale: 'fraction' } }, { x: good.x }, { y: good.y }, {}, null, 'axes', [],
  ];
  const program = `
import sys, json
sys.path.insert(0, ${JSON.stringify(MCP_DIR)})
import vcr_curve_digitize as d
out = []
for case in json.loads(sys.stdin.read()):
    try:
        d.check_calibration(case)
        out.append("ok")
    except d.Refusal as refusal:
        out.append(refusal.reason)
print(json.dumps(out))
`;
  const run = spawnSync('python3', ['-c', program], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const python = JSON.parse(run.stdout);
  const javascript = cases.map(value => { try { checkCalibration(value); return 'ok'; } catch (error) { assert.equal(/** @type {any} */ (error).code, 'vcr_curve_calibration_invalid'); return 'calibration_invalid'; } });
  assert.deepEqual(javascript.map(value => (value === 'ok' ? 'ok' : 'calibration_invalid')), python.map(value => (value === 'ok' ? 'ok' : 'calibration_invalid')));
  assert.equal(javascript.filter(value => value === 'ok').length, 4);
});

test('a run states a calibration, a curve and a risk table; a coordinate has no place in the call', () => {
  const base = { imageArtifactId: 'sources/fig2.png', calibration: CAL48, arms: [arm('control', { color: '#d62728' }), arm('treatment', { legendOrder: 2 })] };
  const checked = checkDigitizeRequest(base);
  assert.deepEqual(checked.calibration, CAL48);
  assert.deepEqual(checked.arms.map(item => item.selector), [{ color: '#d62728' }, { legendOrder: 2 }]);
  assert.equal(checkDigitizeRequest({ ...base, arms: [arm('only', { color: 'd62728' })] }).arms[0].selector.color, '#d62728', 'a hex without # is accepted');
  assert.deepEqual(checkDigitizeRequest({ ...base, arms: [{ riskTable: RISK }] }).arms[0], { name: 'control', selector: {}, riskTable: RISK, totalEvents: undefined, reportedMedian: undefined });

  const refused = (change, message) => assert.throws(() => checkDigitizeRequest({ ...base, ...change }), { code: /^(vcr_request_invalid|vcr_curve_calibration_invalid)$/, message });
  refused({ points: [{ time: 0, surv: 1 }] }, /points is not a field/);
  refused({ provenance: { kind: 'digitizer' } }, /provenance is not a field/);
  refused({ origin: 'digitizer' }, /origin is not a field/);
  refused({ arms: [{ riskTable: RISK, curve: { color: '#d62728' }, points: [] }] }, /points is not a field of an arm/);
  refused({ arms: [{ riskTable: RISK, curve: { color: '#d62728' }, surv: [1] }] }, /surv is not a field of an arm/);
  refused({ arms: [{ curve: { color: '#d62728' } }] }, /riskTable is the published numbers at risk/);
  refused({ arms: [{ curve: { color: '#d62728' }, riskTable: [{ time: 0, atRisk: 5 }] }] }, /at least two rows/);
  refused({ arms: [] }, /one or two arms/);
  refused({ arms: [arm('a', { color: '#d62728' }), arm('b', { color: '#1f77b4' }), arm('c', { color: '#2ca02c' })] }, /one or two arms/);
  refused({ arms: [arm('a', { color: '#d62728' }), arm('b', { color: '#d62728' })] }, /same curve/);
  refused({ arms: [arm('a', { color: '#d62728' }), arm('b', {})] }, /names its curve/);
  refused({ arms: [arm('a', { color: 'red' })] }, /six-digit hex/);
  refused({ arms: [arm('a', { color: '#d62728', legendOrder: 1 })] }, /not both/);
  refused({ arms: [arm('a', { legendOrder: 0 })] }, /legendOrder is a whole number/);
  refused({ arms: [arm('a', { swatch: 1 })] }, /color \(#rrggbb\) or legendOrder/);
  refused({ imageSha256: 'ABC' }, /sha256/);
  refused({ plotArea: { left: 10, top: 10, right: 20, bottom: 300 } }, /plotArea/);
  refused({ plotArea: { left: 10, top: 10, right: 200, bottom: 300, extra: 1 } }, /plotArea/);
  refused({ reportedLogHazardRatio: -0.4, arms: [arm('a', { color: '#d62728' })] }, /two reconstructed arms/);
  refused({ calibration: { ...CAL48, x: { ...CAL48.x, max: 0 } } }, /x.max/);
});

// --- what comes back is checked ---------------------------------------------------

function container({ sha = 'a'.repeat(64), calibration = { x: { max: 48, min: 0, unit: 'months' }, y: { max: 1, min: 0, scale: 'fraction' } }, curves } = {}) {
  const points = (offset = 0) => [{ time: 0, surv: 1 }, { time: 12 + offset, surv: 0.7 }, { time: 24 + offset, surv: 0.4 }, { time: 48, surv: 0.2 }];
  return {
    protocol: 1, outcome: 'digitized', algorithm: { name: 'evimed-km-digitizer', version: '1.0.0', libraries: { numpy: '2.2.6' } }, parameters: { maxPoints: 1000 },
    image: { sha256: sha, width: 640, height: 480, format: 'PNG' }, calibration, plotArea: { left: 66.5, top: 15, right: 617, bottom: 422.5, source: 'detected' },
    anchor: 'ticks', ticks: { x: 9, y: 6 }, resolution: { timePerPixel: 0.087, survivalPerPixel: 0.0026 }, palette: ['#d62728', '#1f77b4'],
    curves: curves ?? [{ color: '#d62728', colorSource: 'stated', points: points(), quality: { points: 4, monotonicityRepairs: { count: 0, largestRise: 0 }, pixelSupport: {} } },
      { color: '#1f77b4', colorSource: 'stated', points: points(3), quality: { points: 4, monotonicityRepairs: { count: 0, largestRise: 0 }, pixelSupport: {} } }],
    warnings: [],
  };
}

test('a container answer that does not hold together is not taken: hash, calibration, order, rise, count', () => {
  const expected = { calibration: CAL48, sha256: 'a'.repeat(64), arms: 2 };
  assert.equal(checkDigitization(container(), expected).outcome, 'digitized');
  assert.equal(checkDigitization({ protocol: 1, outcome: 'refused', reason: 'colour_required' }, expected).outcome, 'refused');
  const broken = change => assert.throws(() => checkDigitization(change, expected), { status: 502, code: 'vcr_intake_failed' });
  broken(null);
  broken({ ...container(), protocol: 2 });
  broken({ ...container(), outcome: 'mystery' });
  broken(container({ sha: 'b'.repeat(64) }));
  broken(container({ calibration: { x: { min: 0, max: 60, unit: 'months' }, y: { min: 0, max: 1, scale: 'fraction' } } }));
  broken({ ...container(), algorithm: { name: 'x', version: 'one' } });
  broken({ ...container(), curves: [container().curves[0]] });
  const withPoints = points => ({ ...container(), curves: [{ ...container().curves[0], points }, container().curves[1]] });
  broken(withPoints([{ time: 0, surv: 1 }, { time: 5, surv: 0.5 }]));
  broken(withPoints([{ time: 0, surv: 1 }, { time: 5, surv: 0.5 }, { time: 4, surv: 0.4 }]));
  broken(withPoints([{ time: 0, surv: 0.5 }, { time: 5, surv: 0.7 }, { time: 9, surv: 0.4 }]));
  broken(withPoints([{ time: 0, surv: 1 }, { time: 5, surv: 0 }, { time: 9, surv: 0 }]));
  broken(withPoints([{ time: 0, surv: 1.2 }, { time: 5, surv: 0.5 }, { time: 9, surv: 0.4 }]));
  broken(withPoints([{ time: -1, surv: 1 }, { time: 5, surv: 0.5 }, { time: 9, surv: 0.4 }]));
  broken(withPoints([{ time: 0, surv: Number.NaN }, { time: 5, surv: 0.5 }, { time: 9, surv: 0.4 }]));
});

// --- through the real script ----------------------------------------------------

async function world(t, name = 'km_two_colors.png') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-digitizer-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { dataDir: path.join(root, 'data'), runtimeContainerImage: 'img', runtimeContainerUser: '1000:1000', runtimeDataVolume: '',
    vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrDigitizeMaxPixels: 24_000_000 };
  await fs.mkdir(config.dataDir, { recursive: true });
  const data = await fs.readFile(path.join(FIXTURES, name));
  const sha256 = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
  const image = { sha256, bytes: data.length, mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg', data };
  const calls = [];
  const counters = createIntakeCounters();
  const digitizer = createVcrCurveDigitizer({ config, controller: localIntakeController(config, { calls }), counters });
  return { root, config, image, calls, counters, digitizer, sha256, leftovers: async () => fs.readdir(path.join(config.dataDir, 'vcr-intake', 'digitize')).catch(() => []) };
}

test('two curves are digitized into a reconstruction input the engine\'s own schema accepts, with the digitizer as its provenance', { skip: !HAVE && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const w = await world(t);
  const request = { imageArtifactId: 'sources/fig2.png', calibration: CAL48, arms: [arm('control', { color: '#ff0000' }, { totalEvents: 130, reportedMedian: 15 }), arm('treatment', { color: '#0000ff' })], reportedLogHazardRatio: -0.45 };
  const done = await w.digitizer.digitize({ request, image: w.image });
  assert.ok(!done.refused, JSON.stringify(done.refused));
  const { scenario, digitization } = done;
  assert.deepEqual(validateScenario('evidence.reconstruct_km', scenario), []);
  assert.deepEqual(scenario.provenance, { kind: 'digitizer', tool: VCR_DIGITIZER_TOOL, toolVersion: digitization.algorithm.version });
  assert.equal(scenario.riskTable.length, 3);
  assert.equal(scenario.totalEvents, 130);
  assert.equal(scenario.reportedMedian, 15);
  assert.equal(scenario.reportedLogHazardRatio, -0.45);
  assert.equal(scenario.treatmentArm.riskTable.length, 3);
  assert.ok(scenario.curve.length > 100 && scenario.treatmentArm.curve.length > 100);
  assert.equal(scenario.curve[0].surv, 1);
  assert.deepEqual(Object.keys(scenario.curve[1]).sort(), ['surv', 'time']);

  // What was stated is recorded as stated, by the run; what was measured is recorded beside it.
  assert.equal(digitization.statedBy, 'run');
  assert.deepEqual(digitization.calibration, CAL48);
  assert.equal(digitization.image.sha256, w.sha256);
  assert.equal(digitization.algorithm.name, 'evimed-km-digitizer');
  assert.equal(digitization.anchor, 'ticks');
  assert.deepEqual(digitization.curves.map(curve => [curve.name, curve.color, curve.colorSource]), [['control', '#d62728', 'stated'], ['treatment', '#1f77b4', 'stated']]);
  assert.ok(digitization.curves.every(curve => curve.quality.xCoverage > 0.9 && curve.quality.monotonicityRepairs));
  assert.equal(digitization.parameters.maxPoints, 1000);
  assert.equal(w.counters.digitized, 1);
  assert.deepEqual(w.calls[0].files.sort(), ['figure.png', 'request.json']);
  assert.deepEqual(await w.leftovers(), [], 'the scratch attempt is removed');
});

test('what the digitizer cannot attribute comes back as an answer that says what to state, and nothing is built', { skip: !HAVE && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const w = await world(t);
  const refused = await w.digitizer.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [{ riskTable: RISK }] }, image: w.image });
  assert.equal(refused.refused.reason, 'colour_required');
  assert.deepEqual(refused.refused.palette, ['#d62728', '#1f77b4']);
  const none = await w.digitizer.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [arm('a', { color: '#2ca02c' })] }, image: w.image });
  assert.equal(none.refused.reason, 'colour_not_found');
  assert.equal(w.counters.digitizeRefused, 2);
  assert.equal(w.counters.digitized, 0);

  const panels = await world(t, 'km_two_panels_black.png');
  const ambiguous = await panels.digitizer.digitize({ request: { imageArtifactId: 'p.png', calibration: { x: { min: 0, max: 36, unit: 'months' }, y: { min: 0, max: 1, scale: 'fraction' } }, arms: [arm('a', { color: '#000000' })] }, image: panels.image });
  assert.equal(ambiguous.refused.reason, 'plot_area_ambiguous');
  assert.equal(ambiguous.refused.candidates.length, 2);
  assert.ok(ambiguous.refused.candidates.every(box => Object.values(box).every(Number.isInteger)));
});

test('an impossible calibration, a figure that changed and a digitizer that is not there are errors, not answers', { skip: !HAVE && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const w = await world(t);
  const call = (request, image = w.image) => w.digitizer.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [arm('a', { color: '#d62728' })], ...request }, image });
  await assert.rejects(call({ calibration: { ...CAL48, x: { ...CAL48.x, max: 0 } } }), { status: 400, code: 'vcr_curve_calibration_invalid' });
  assert.equal(w.calls.length, 0, 'no container for a call that cannot be right');
  await assert.rejects(call({ imageSha256: 'f'.repeat(64) }), { status: 409, code: 'vcr_curve_source_changed' });
  await assert.rejects(call({ points: [] }), { code: 'vcr_request_invalid' });
  const none = createVcrCurveDigitizer({ config: w.config });
  assert.equal(none.available, false);
  await assert.rejects(none.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [arm('a', { color: '#d62728' })] }, image: w.image }), { status: 503, code: 'vcr_curve_digitizer_unavailable' });
  const down = createVcrCurveDigitizer({ config: w.config, counters: w.counters, controller: { runVcrIntake: async () => { throw new HttpError(503, 'runtime_controller_unavailable', 'x'); } } });
  await assert.rejects(down.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [arm('a', { color: '#d62728' })] }, image: w.image }), { status: 503, code: 'vcr_curve_digitizer_unavailable' });
  // A figure that is not an image is the figure's refusal, not a trace's.
  const bad = { ...w.image, data: Buffer.from('plain text'), sha256: (await import('node:crypto')).createHash('sha256').update('plain text').digest('hex') };
  await assert.rejects(call({}, bad), { status: 400, code: 'vcr_curve_provenance_invalid' });
  assert.deepEqual(await w.leftovers(), []);
});

test('the figure is read, never fetched: no outbound request is part of digitizing', { skip: !HAVE && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const w = await world(t);
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error('no network is part of this path'); };
  t.after(() => { globalThis.fetch = real; });
  const done = await w.digitizer.digitize({ request: { imageArtifactId: 'f.png', calibration: CAL48, arms: [arm('a', { color: '#d62728' })] }, image: w.image });
  assert.ok(!done.refused);
  assert.deepEqual(requests, []);
});
