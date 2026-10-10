import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { projectionHash } from '../src/vcrCloudProjection.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = 'https://api.example.org';
let database, isolated, directory, vcr;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrrelations');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-relations-'));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: directory, deepseekBaseUrl: origin }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const study = await vcr.store.createStudy({ userId: 'owner', projectId: `rel_${Math.random().toString(16).slice(2)}`, name: 'Authored synthetic relation test', question: 'q', dataTier: 'T0' });
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: study.id, name: 'Authored synthetic notes' });
  await vcr.dataPlane.setCloudPermission({ studyId: study.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: [origin], reference: 'Authored synthetic regression', retention: 'unknown', training: 'unknown', humanReview: 'unknown',
  } });
  async function document(text, subject = 'SYNTHETIC-A') {
    const upload = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: study.id, sourceId: source.id,
      name: 'synthetic.txt', role: 'document', subject, stream: streamOf(text) });
    const projection = await vcr.dataPlane.createDocumentProjection({ studyId: study.id, documentId: upload.file.id, actor: 'owner', sourceHash: projectionHash(text), spans: [], attestation: 'Authored synthetic text' });
    return { text, subjectKey: upload.file.detail.subjectKey, documentId: projection.id };
  }
  async function write(doc, variable, surface, quote, start = doc.text.indexOf(quote), relations = []) {
    return vcrRuntimeWrite({ study, store: vcr.store, service: vcr.service, what: 'fact', documents: vcr.documents, matchStore: vcr.matchStore,
      items: [{ subjectKey: doc.subjectKey, documentId: doc.documentId, variable, surface, quote, start, end: start + quote.length,
        clinical: { schema: 1, assertion: 'affirmed', experiencer: 'patient', relations } }] });
  }
  async function saved(result) { return (await vcr.matchStore.matchingFactsByIds(study.id, result.ids))[0]; }
  return { study, document, write, saved };
}
test('a real same-document quote instance supports both persisted fact endpoints', options, async () => {
  const f = await fixture(); const text = '阿司匹林剂量为100毫克。'; const doc = await f.document(text);
  const target = await f.write(doc, 'medication', '阿司匹林', text); assert.equal(target.ok, true);
  const result = await f.write(doc, 'dose', '100毫克', text, 0, [{ type: 'dose_of', state: 'supported', targetFactId: target.ids[0], quote: text }]);
  assert.equal(result.ok, true); assert.deepEqual(result.issues, []); assert.equal(result.results[0].warnings, undefined);
  assert.equal((await f.saved(result)).clinical.relations[0].state, 'supported');
});
test('same-name mentions in different instances cannot acquire a supported link; the valid fact is saved', options, async () => {
  const f = await fixture(); const quote = '阿司匹林剂量为100毫克。'; const doc = await f.document(quote + '另一次记录：' + quote);
  const target = await f.write(doc, 'medication', '阿司匹林', quote, 0); assert.equal(target.ok, true);
  const result = await f.write(doc, 'dose', '100毫克', quote, doc.text.lastIndexOf(quote), [{ type: 'dose_of', state: 'supported', targetFactId: target.ids[0], quote }]);
  assert.equal(result.ok, true); assert.deepEqual(result.issues, []);
  assert.equal((await f.saved(result)).clinical.relations[0].state, 'unresolved');
  assert.equal(result.results[0].warnings[0].code, 'relation_quote_endpoint_mismatch');
});
test('one quotation cannot certify a cross-document relation for the same patient', options, async () => {
  const f = await fixture(); const a = await f.document('阿司匹林记录。'); const b = await f.document('阿司匹林剂量为100毫克。');
  assert.equal(a.subjectKey, b.subjectKey);
  const target = await f.write(a, 'medication', '阿司匹林', a.text); assert.equal(target.ok, true);
  const result = await f.write(b, 'dose', '100毫克', b.text, 0, [{ type: 'dose_of', state: 'supported', targetFactId: target.ids[0], quote: b.text }]);
  assert.equal(result.ok, true); assert.equal((await f.saved(result)).clinical.relations[0].state, 'unresolved');
  assert.equal(result.results[0].warnings[0].code, 'relation_dual_document_evidence_missing');
});
test('the existing study and patient fence still refuses a foreign patient reference', options, async () => {
  const f = await fixture(); const a = await f.document('阿司匹林记录。'); const b = await f.document('阿司匹林剂量为100毫克。', 'SYNTHETIC-B');
  const target = await f.write(a, 'medication', '阿司匹林', a.text); assert.equal(target.ok, true);
  const result = await f.write(b, 'dose', '100毫克', b.text, 0, [{ type: 'dose_of', state: 'supported', targetFactId: target.ids[0], quote: b.text }]);
  assert.equal(result.ok, false); assert.equal(result.ids.length, 0); assert.ok(result.issues.some(issue => issue.field === 'clinical'));
});
test('same-document support may span sentences when the exact evidence binds both facts', options, async () => {
  const f = await fixture(); const doc = await f.document('用药为阿司匹林。该药剂量为100毫克。');
  const target = await f.write(doc, 'medication', '阿司匹林', '用药为阿司匹林。'); assert.equal(target.ok, true);
  const quote = '该药剂量为100毫克。';
  const result = await f.write(doc, 'dose', '100毫克', quote, doc.text.indexOf(quote), [{ type: 'dose_of', state: 'supported', targetFactId: target.ids[0], quote: doc.text }]);
  assert.equal(result.ok, true); assert.equal((await f.saved(result)).clinical.relations[0].state, 'supported');
  assert.equal(result.results[0].warnings, undefined);
});
