import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVcrCurveEvidence } from '../src/vcrCurveEvidence.mjs';

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
