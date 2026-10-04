import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVcrCurveEvidence, digitizationSummary } from '../src/vcrCurveEvidence.mjs';
import { createVcrCurveDigitizer } from '../src/vcrCurveDigitizer.mjs';
import { MCP_DIR, localIntakeController, pythonCan } from './helpers/vcrIntakeLocal.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=', 'base64');
const points = { curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }] };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-curves-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'figure.png'), image);
  const receipts = new Map(); let allowed = true;
  const store = { async saveCurveExtraction(row) { receipts.set(row.id, structuredClone(row)); return row; },
    async curveExtraction(studyId, id) { const row = receipts.get(id); return row?.studyId === studyId ? structuredClone(row) : null; },
    async curveExtractions(studyId) { return [...receipts.values()].filter(row => row.studyId === studyId); } };
  const studyStore = { async studyById(id) { return id === 'study' ? { id, userId: 'owner', projectId: 'project' } : null; } };
  const access = { async require({ actor, studyId }) { if (!allowed || actor !== 'member' || studyId !== 'study') throw Object.assign(new Error('Denied'), { code: 'vcr_forbidden', status: 403 }); } };
  const service = createVcrCurveEvidence({ store, studyStore, access, resolveProject: async () => ({ workspaceDir: root }) });
  const record = () => service.recordSelection({ studyId: 'study', principal: 'member', imageArtifactId: 'figure.png', points });
  return { service, record, root, receipts, revoke: () => { allowed = false; } };
}
test('only a recorded human selection binds image bytes and exact points; caller origin strings grant nothing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'member', scenario: { ...points, provenance: { kind: 'digitizer', tool: 'Invented' } }, inputs: [] }), { code: 'vcr_curve_provenance_unavailable' });
  const receipt = await f.record();
  const verified = await f.service.curveVerifier({ studyId: 'study', principal: 'member', scenario: { provenance: { receiptId: receipt.id } }, inputs: [] });
  assert.deepEqual(verified.scenario.curve, points.curve);
  assert.equal(verified.scenario.provenance.kind, 'human_click'); assert.equal(verified.scenario.provenance.receiptId, undefined);
  assert.equal(verified.detail.curveReceiptId, receipt.id); assert.equal(verified.detail.curvePrincipal, 'member');
  assert.ok(verified.inputs.some(row => row.kind === 'evidence' && row.id.includes(receipt.id)));
  await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'member', receiptId: receipt.id, scenario: { ...points, totalEvents: 999 }, inputs: [] }), { code: 'vcr_curve_provenance_invalid' });
  const retry = await f.service.curveVerifier({ studyId: 'study', principal: 'member', receiptId: receipt.id, scenario: verified.scenario, inputs: verified.inputs });
  assert.deepEqual(retry.inputs, verified.inputs);
});
test('changed image/points, revoked membership and cross-study receipts are refused without deleting research', async t => {
  const f = await fixture(t); const receipt = await f.record();
  await fs.writeFile(path.join(f.root, 'report.md'), 'Completed research stays available.');
  await fs.writeFile(path.join(f.root, 'figure.png'), Buffer.concat([image, Buffer.from('changed')]));
  const verify = () => f.service.curveVerifier({ studyId: 'study', principal: 'member', receiptId: receipt.id, scenario: {}, inputs: [] });
  await assert.rejects(verify(), { code: 'vcr_curve_source_changed' });
  await fs.writeFile(path.join(f.root, 'figure.png'), image);
  f.receipts.get(receipt.id).scenario.curve[1].surv = 0.9;
  await assert.rejects(verify(), { code: 'vcr_curve_provenance_invalid' });
  assert.equal(await fs.readFile(path.join(f.root, 'report.md'), 'utf8'), 'Completed research stays available.');
  f.revoke(); await assert.rejects(verify(), { code: 'vcr_forbidden' });
});
test('image references reject traversal, symlinks and foreign actors before any receipt is recorded', async t => {
  const f = await fixture(t);
  await fs.symlink('figure.png', path.join(f.root, 'alias.png'));
  for (const imageArtifactId of ['../figure.png', '/etc/passwd', 'https://example.test/image.png', 'alias.png']) {
    await assert.rejects(f.service.recordSelection({ studyId: 'study', principal: 'member', imageArtifactId, points }));
  }
  await assert.rejects(f.service.recordSelection({ studyId: 'study', principal: 'owner', imageArtifactId: 'figure.png', points }), { code: 'vcr_forbidden' });
  assert.equal(f.receipts.size, 0);
});


// --- a figure digitized by the platform: the second origin a curve record can have --------------------------

const HAVE_DIGITIZER = pythonCan('numpy', 'PIL', 'scipy');
const FIGURE = path.join(MCP_DIR, 'test', 'fixtures', 'vcr_curves', 'km_two_colors.png');
const RISK = [{ time: 0, atRisk: 220 }, { time: 24, atRisk: 90 }, { time: 48, atRisk: 20 }];
const CAL48 = { x: { min: 0, max: 48, unit: 'months' }, y: { min: 0, max: 1, scale: 'fraction' } };
const REQUEST = { imageArtifactId: 'figure.png', calibration: CAL48,
  arms: [{ name: 'control', curve: { color: '#d62728' }, riskTable: RISK, totalEvents: 130 }, { name: 'treatment', curve: { color: '#1f77b4' }, riskTable: RISK }] };

async function digitizerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-curves-digitizer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(FIGURE, path.join(root, 'figure.png'));
  const config = { dataDir: path.join(root, 'data'), runtimeContainerImage: 'img', runtimeContainerUser: '1000:1000', runtimeDataVolume: '',
    vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrDigitizeMaxPixels: 24_000_000 };
  await fs.mkdir(config.dataDir, { recursive: true });
  const receipts = new Map(); let allowed = true;
  const store = { async saveCurveExtraction(row) { const kept = receipts.get(row.id) ?? structuredClone(row); receipts.set(row.id, kept); return structuredClone(kept); },
    async curveExtraction(studyId, id) { const row = receipts.get(id); return row?.studyId === studyId ? structuredClone(row) : null; },
    async curveExtractions(studyId) { return [...receipts.values()].filter(row => row.studyId === studyId).reverse(); } };
  const studyStore = { async studyById(id) { return id === 'study' ? { id, userId: 'owner', projectId: 'project' } : null; } };
  const access = { async require({ actor, studyId }) { if (!allowed || !['member', 'owner'].includes(actor) || studyId !== 'study') throw Object.assign(new Error('Denied'), { code: 'vcr_forbidden', status: 403 }); } };
  const digitizer = createVcrCurveDigitizer({ config, controller: localIntakeController(config) });
  const service = createVcrCurveEvidence({ store, studyStore, access, digitizer, resolveProject: async () => ({ workspaceDir: root }) });
  return { service, root, receipts, revoke: () => { allowed = false; } };
}

test('a digitized figure becomes a curve record the reconstruction accepts exactly like a person\'s selection', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  const done = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: REQUEST });
  assert.match(done.id, /^crv_[a-f0-9]{32}$/);
  assert.equal(done.origin, 'digitizer');
  const stored = f.receipts.get(done.id);
  assert.equal(stored.origin, 'digitizer');
  assert.equal(stored.scenario.provenance.kind, 'digitizer');
  assert.equal(stored.digitization.statedBy, 'run');
  assert.deepEqual(stored.digitization.calibration, CAL48, 'the calibration is recorded as stated');
  assert.equal(stored.digitization.pointsHash, stored.pointsHash);
  assert.equal(stored.image.artifactId, 'figure.png');
  assert.ok(!('data' in stored.image), 'the figure\'s bytes are not part of the record');
  assert.equal(done.digitization.curves.length, 2);
  assert.ok(done.digitization.curves.every(curve => curve.xCoverage > 0.9));

  // The verifier answers as it does for a human click: the whole recorded scenario, and the lineage of the record.
  const verified = await f.service.curveVerifier({ studyId: 'study', principal: 'owner', scenario: { provenance: { receiptId: done.id } }, inputs: [] });
  assert.deepEqual(verified.scenario, stored.scenario);
  assert.equal(verified.scenario.provenance.receiptId, undefined);
  assert.equal(verified.detail.curveReceiptId, done.id);
  assert.equal(verified.detail.curveImageHash, stored.image.sha256);
  assert.ok(verified.inputs.some(row => row.kind === 'evidence' && row.id.includes(done.id)));
  // It rechecks: the same request again, from the lineage it produced, still verifies.
  const retry = await f.service.curveVerifier({ studyId: 'study', principal: 'owner', receiptId: done.id, scenario: verified.scenario, inputs: verified.inputs });
  assert.deepEqual(retry.inputs, verified.inputs);
  // A caller that restates a recorded key must restate it exactly.
  await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'owner', receiptId: done.id, scenario: { totalEvents: 999 }, inputs: [] }), { code: 'vcr_curve_provenance_invalid' });
  await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'owner', receiptId: done.id, scenario: { curve: [{ time: 0, surv: 1 }, { time: 5, surv: 0.9 }, { time: 9, surv: 0.5 }] }, inputs: [] }), { code: 'vcr_curve_provenance_invalid' });

  // The same figure and calibration is the same record.
  const again = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: REQUEST });
  assert.equal(again.id, done.id);
  assert.equal(f.receipts.size, 1);
  // A different calibration is a different record.
  const other = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: { ...REQUEST, calibration: { ...CAL48, y: { min: 0, max: 1.05, scale: 'fraction' } } } });
  assert.notEqual(other.id, done.id);
});

test('a digitizer record is only as good as what it attests: a changed figure, points, version or hash is refused', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  const { id } = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: REQUEST });
  const verify = () => f.service.curveVerifier({ studyId: 'study', principal: 'owner', receiptId: id, scenario: {}, inputs: [] });
  await verify();
  const row = f.receipts.get(id);
  const tamper = async (change, code) => {
    const saved = structuredClone(row);
    change(row);
    await assert.rejects(verify(), { code });
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, saved);
    await verify();
  };
  await tamper(r => { r.scenario.curve[3].surv = 0.01; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.digitization.algorithm.version = '9.9.9'; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.digitization.pointsHash = 'f'.repeat(64); }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.digitization.image.sha256 = 'f'.repeat(64); }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.digitization.statedBy = 'platform'; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { delete r.digitization; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.scenario.provenance.tool = 'Invented'; r.pointsHash = r.digitization.pointsHash; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.origin = 'human_click'; }, 'vcr_curve_provenance_invalid');
  await tamper(r => { r.origin = 'model'; }, 'vcr_curve_provenance_invalid');
  // The figure: changed bytes are refused, the study's other work is untouched.
  await fs.writeFile(path.join(f.root, 'report.md'), 'Completed research stays available.');
  await fs.appendFile(path.join(f.root, 'figure.png'), Buffer.from('changed'));
  await assert.rejects(verify(), { code: 'vcr_curve_source_changed' });
  assert.equal(await fs.readFile(path.join(f.root, 'report.md'), 'utf8'), 'Completed research stays available.');
});

test('a human click remains an optional correction, and a list of points with neither record stays refused', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  const points = { curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }] };
  const click = await f.service.recordSelection({ studyId: 'study', principal: 'member', imageArtifactId: 'figure.png', points });
  assert.equal(f.receipts.get(click.id).origin, 'human_click');
  assert.equal(f.receipts.get(click.id).digitization ?? null, null);
  const verified = await f.service.curveVerifier({ studyId: 'study', principal: 'member', scenario: { provenance: { receiptId: click.id } }, inputs: [] });
  assert.equal(verified.scenario.provenance.kind, 'human_click');
  // A click record that grows a digitization is not a click record any more.
  f.receipts.get(click.id).digitization = { statedBy: 'run', algorithm: { version: '1.0.0' }, pointsHash: f.receipts.get(click.id).pointsHash, image: f.receipts.get(click.id).image };
  await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'member', receiptId: click.id, scenario: {}, inputs: [] }), { code: 'vcr_curve_provenance_invalid' });
  // Coordinates a model supplies are refused whatever origin they name.
  for (const provenance of [{ kind: 'digitizer', tool: VCR_TOOL }, { kind: 'human_click', tool: 'EviMed authenticated curve input', toolVersion: '1' }, { kind: 'digitizer', tool: VCR_TOOL, receiptId: 'crv_' + '0'.repeat(32) }]) {
    await assert.rejects(f.service.curveVerifier({ studyId: 'study', principal: 'member', scenario: { ...points, provenance }, inputs: [] }), { code: /^vcr_curve_provenance_(unavailable|invalid)$/ });
  }
});
const VCR_TOOL = 'EviMed curve digitizer';

test('a run cannot hand a digitization a point, an origin or a provenance, and writing one needs the write ability', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  for (const field of ['points', 'curve', 'provenance', 'origin']) {
    await assert.rejects(f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: { ...REQUEST, [field]: field === 'curve' ? [] : { kind: 'digitizer' } } }), { status: 400, code: 'vcr_curve_provenance_invalid' }, field);
  }
  for (const imageArtifactId of ['../figure.png', '/etc/passwd', 'https://example.test/figure.png', 'figure.txt']) {
    await assert.rejects(f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: { ...REQUEST, imageArtifactId } }), { code: 'vcr_curve_provenance_invalid' });
  }
  await assert.rejects(f.service.recordDigitization({ studyId: 'study', principal: 'stranger', request: REQUEST }), { code: 'vcr_forbidden' });
  await assert.rejects(f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: { ...REQUEST, imageSha256: '0'.repeat(64) } }), { code: 'vcr_curve_source_changed' });
  assert.equal(f.receipts.size, 0, 'nothing was recorded');
  const without = createVcrCurveEvidence({ store: {}, studyStore: { async studyById() { return { id: 'study', userId: 'owner', projectId: 'p' }; } }, access: { async require() {} }, resolveProject: async () => ({ workspaceDir: f.root }) });
  await assert.rejects(without.recordDigitization({ studyId: 'study', principal: 'owner', request: REQUEST }), { status: 503, code: 'vcr_curve_digitizer_unavailable' });
});

test('a refusal to trace records nothing; the answer says what would settle it', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  const answer = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: { ...REQUEST, arms: [{ riskTable: RISK }] } });
  assert.equal(answer.refused.reason, 'colour_required');
  assert.deepEqual(answer.refused.palette, ['#d62728', '#1f77b4']);
  assert.equal(f.receipts.size, 0);
});

test('receipts list what a reader needs: the origin of each, and for a digitization the calibration as stated and the quality', { skip: !HAVE_DIGITIZER && 'python3 with numpy, Pillow and scipy is needed' }, async t => {
  const f = await digitizerFixture(t);
  const points = { curve: [{ time: 0, surv: 1 }, { time: 12, surv: 0.5 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }] };
  const click = await f.service.recordSelection({ studyId: 'study', principal: 'member', imageArtifactId: 'figure.png', points });
  const digitized = await f.service.recordDigitization({ studyId: 'study', principal: 'owner', request: REQUEST });
  const listed = await f.service.receipts({ studyId: 'study', principal: 'owner' });
  assert.deepEqual(listed.map(row => row.id).sort(), [click.id, digitized.id].sort());
  const row = listed.find(item => item.id === digitized.id);
  assert.equal(row.origin, 'digitizer');
  assert.deepEqual(row.digitization.calibration, CAL48);
  assert.equal(row.digitization.statedBy, 'run');
  assert.equal(row.digitization.algorithm.name, 'evimed-km-digitizer');
  assert.deepEqual(Object.keys(row.digitization.curves[0]).sort(), ['bridgedColumns', 'color', 'monotonicityRepairs', 'name', 'points', 'startSurvival', 'xCoverage']);
  assert.deepEqual(listed.find(item => item.id === click.id), { id: click.id, origin: 'human_click', createdAt: listed.find(item => item.id === click.id).createdAt });
  // No path, no figure byte and no parameter list rides the summary.
  const text = JSON.stringify(row);
  assert.ok(!text.includes('figure.png') && !text.includes('parameters') && !text.includes('data'));
  assert.equal(digitizationSummary({ algorithm: { name: 'a', version: '1' }, curves: [] }).curves.length, 0);
});
