// The deployment's provider agreements are the cloud permission (2026-10-10 owner ruling): a study document reaches the
// configured model providers with no per-document attestation, as it is or as a reviewed projection, the basis is in the audit,
// and an operator's revocation is the one thing that restricts it. The flow runs through the composed module on PostgreSQL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrCloudEgress } from '../src/vcrCloudEgress.mjs';
import { deploymentCloudPermission, projectionHash } from '../src/vcrCloudProjection.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = 'https://api.example.org';
const config = { vcrEnabled: true, vcrAudience: 'all', deepseekBaseUrl: origin, vcrProviderAgreements: true, vcrProviderAgreementReference: 'Agreement 2026-017' };
let database, isolated, directory, vcr;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcragree');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-agree-'));
  vcr = composeVcr({ config: { ...config, vcrDataPlaneDir: directory }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const study = () => vcr.store.createStudy({ userId: 'owner', projectId: `prj_${Math.random().toString(16).slice(2)}`, name: 'Synthetic agreements test', question: 'q', dataTier: 'T0' });
const write = (target, what, items) => vcrRuntimeWrite({ study: target, store: vcr.store, service: vcr.service, what, items, documents: vcr.documents,
  matching: vcr.matching, matchStore: vcr.matchStore, orchestrator: null, report: () => {} });
const chart = '患者王小明，否认心梗史。年龄 62 岁，肌酐 1.2 mg/dL。';
async function upload(target, text = chart, subject = 'CANARY-AGREEMENT-001') {
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const file = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document', subject, stream: streamOf(text) });
  return { source, file: file.file, subjectKey: file.file.detail.subjectKey };
}

test('a document nobody attested is read as it is under the agreements; the read is a dependency of the conversation and its basis is in the audit', options, async () => {
  const target = await study();
  const { source, file, subjectKey } = await upload(target);
  target.cloudContext = { runId: 'run_agree', sessionId: 'session_agree' };
  const read = await vcr.documents.subjectDocuments(target, { subjectKey, documentId: file.id });
  assert.equal(read.available, true, JSON.stringify(read));
  assert.equal(read.document.id, file.id, 'with no reviewed projection the run reads the document itself');
  assert.equal(read.document.projectionHash, null);
  assert.ok(read.document.text.includes('王小明'), 'identifiable text goes out as it stands, by the owner ruling');
  // The conversation now counts as a clinical one, which is what keeps it out of general memory and learning.
  assert.equal(await vcr.store.hasClinicalContext('owner', target.projectId, [{ sessionId: 'session_agree' }]), true);
  const audit = await vcr.store.one("SELECT detail FROM evimed_vcr.audit WHERE study_id=$1 AND action='document.cloud_read'", [target.id]);
  assert.equal(audit.detail.basis, 'deployment_agreements');
  assert.equal(audit.detail.reference, 'Agreement 2026-017');
  assert.ok(!JSON.stringify(audit).includes('王小明'), 'the audit names the basis and never the text');
  // A fact quoted from that text is written, and a run reads it back.
  const saved = await write(target, 'fact', [{ subjectKey, variable: 'age', value: 62, unit: 'year', documentId: file.id, quote: '年龄 62 岁', surface: '62' }]);
  assert.equal(saved.ids.length, 1, JSON.stringify(saved.issues));
  await write(target, 'criteria', [{ criteria: [{ kind: 'inclusion', criterionType: 'demographic', sourceText: 'Age >= 18',
    requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } }] }]);
  const visible = await vcr.matching.runtimeRead(target, { subjectKey });
  assert.equal(visible.facts.length, 1, 'a fact quoted from a document read as it is goes back to the run');
  // The privacy hook agrees, and an operator's restriction is the one thing that closes it.
  const egress = createVcrCloudEgress({ store: vcr.store, resolveSession: async caller => caller.sessionId, destinations: () => [origin], deployment: () => deploymentCloudPermission(config) });
  const caller = { userId: 'owner', projectId: target.projectId, sessionId: 'session_agree' };
  await egress(caller, { messages: ['cached quotation'] });
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  await assert.rejects(egress(caller, { messages: ['cached quotation'] }), { code: 'vcr_cloud_processing_not_authorized' });
  const closed = await vcr.documents.subjectDocuments(target, { subjectKey, documentId: file.id });
  assert.equal(closed.available, false);
  assert.equal(closed.code, 'vcr_cloud_processing_not_authorized');
  assert.equal((await vcr.matching.runtimeRead(target, { subjectKey })).facts.length, 0, 'evidence from a restricted source is not sent back out either');
  // Going back to following the deployment opens it again, with the same conversation.
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'default' } });
  await egress(caller, { messages: ['cached quotation'] });
  assert.equal((await vcr.documents.subjectDocuments(target, { subjectKey, documentId: file.id })).available, true);
  assert.equal((await vcr.dataStore.sourceInStudy(target.id, source.id)).cloudPermission, null);
});

test('a reviewed projection is used when one exists, needs no permission to be made, and is not bound to the destinations list', options, async () => {
  const target = await study();
  const { file, subjectKey } = await upload(target, chart, 'CANARY-AGREEMENT-002');
  const start = chart.indexOf('王小明');
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: file.id, actor: 'owner',
    sourceHash: projectionHash(chart), spans: [{ start, end: start + 3, kind: 'person' }], attestation: 'Reviewed synthetic canary' });
  const row = await vcr.store.one('SELECT permission_hash FROM evimed_vcr.document_projections WHERE id=$1', [projection.id]);
  assert.equal(row.permission_hash, 'deployment_agreements');
  target.cloudContext = { runId: 'run_projection', sessionId: 'session_projection' };
  const read = await vcr.documents.subjectDocuments(target, { subjectKey, documentId: file.id });
  assert.equal(read.available, true);
  assert.equal(read.document.id, projection.id, 'the reviewed text takes precedence over the document');
  assert.ok(!read.document.text.includes('王小明'));
  const cloudRead = await vcr.store.one("SELECT detail FROM evimed_vcr.audit WHERE study_id=$1 AND action='document.cloud_read'", [target.id]);
  assert.equal(cloudRead.detail.basis, 'deployment_agreements');
  // A deployment that changes its list of destinations does not retire what was reviewed.
  const widened = composeVcr({ config: { ...config, vcrDataPlaneDir: directory, reviewApiBase: 'https://review.example/v1' }, productDatabase: database });
  assert.equal((await widened.documents.subjectDocuments(target, { subjectKey, documentId: file.id })).document.id, projection.id);
});

test('the agreements are not the only basis: a recorded permission still stands, identifiable records are a class of it, and without them nothing changes', options, async () => {
  const target = await study();
  const { source, file, subjectKey } = await upload(target, chart, 'CANARY-AGREEMENT-003');
  // Without the agreements the old rule holds: no record, no read.
  const without = composeVcr({ config: { ...config, vcrProviderAgreements: false, vcrDataPlaneDir: directory }, productDatabase: database });
  target.cloudContext = { runId: 'run_without', sessionId: 'session_without' };
  assert.equal((await without.documents.subjectDocuments(target, { subjectKey, documentId: file.id })).available, false);
  // A recorded permission for identifiable records is accepted, with the private terms, and opens the source there too.
  await without.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'clinical', purpose: 'vcr', destinations: [origin], reference: 'Partner agreement 7',
    retention: 'none', training: 'disabled', humanReview: 'disabled' } });
  assert.equal((await without.documents.subjectDocuments(target, { subjectKey, documentId: file.id })).available, true);
  const audit = await vcr.store.rows("SELECT detail FROM evimed_vcr.audit WHERE study_id=$1 AND action='document.cloud_read'", [target.id]);
  assert.deepEqual(audit.map(row => [row.detail.basis, row.detail.dataClass]), [['source_permission', 'clinical']]);
  // The page is told where the source stands, not the terms: restricted is its own word.
  const tab = await vcr.dataPlane.tabFor(target, { id: 'owner' });
  assert.deepEqual(tab.sources.find(entry => entry.id === source.id).cloud, { state: 'allowed', basis: 'source_permission' });
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  assert.deepEqual((await vcr.dataPlane.tabFor(target, { id: 'owner' })).sources.find(entry => entry.id === source.id).cloud, { state: 'restricted', basis: null });
  assert.deepEqual((await without.dataPlane.tabFor(target, { id: 'owner' })).sources.find(entry => entry.id === source.id).cloud, { state: 'restricted', basis: null });
});
