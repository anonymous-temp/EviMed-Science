import { createVcrCloudEgress } from '../src/vcrCloudEgress.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr, vcrMatchingExecutor, vcrMatchingSeam } from '../src/vcrComposition.mjs';
import { projectionHash } from '../src/vcrCloudProjection.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { deleteVcrStudyRows } from '../src/vcrStoreBase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { freezeMatchingInputs } from '../src/vcrMatchingSnapshot.mjs';
import { VcrStore } from '../src/vcrStore.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = 'https://api.example.org';
let database, isolated, directory, vcr;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcradopt');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-adopt-'));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: directory,
    deepseekBaseUrl: origin }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });
async function study() {
  return vcr.store.createStudy({ userId: 'owner', projectId: `prj_${Math.random().toString(16).slice(2)}`, name: 'Synthetic adoption test', question: 'q', dataTier: 'T0' });
}
function write(target, what, items) {
  return vcrRuntimeWrite({ study: target, store: vcr.store, service: vcr.service, what, items, documents: vcr.documents,
    matching: vcr.matching, matchStore: vcr.matchStore, orchestrator: null, report: () => {} });
}
const rule = text => ({ title: text, criteria: [{ kind: 'inclusion', criterionType: 'consent_capacity', sourceText: text,
  requirement: { op: 'language', key: 'consent', text } }] });

test('history permission reads work with VCR disabled and do not create a schema on a deployment that never used it',options,async()=>{
  const isolatedEmpty=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrhistory');
  const empty=new ControlPlaneDatabase({databaseUrl:isolatedEmpty.url,databasePoolMax:1,databaseConnectionTimeoutMs:2000});
  try{
    const history=new VcrStore({database:empty});
    assert.equal(await history.hasClinicalContext('owner','ordinary'),false);
    assert.deepEqual(await history.cloudDependencies('owner','ordinary','session'),[]);
    assert.equal((await empty.query("SELECT to_regclass('evimed_vcr.studies') AS found")).rows[0].found,null);
  }finally{await empty.close();await isolatedEmpty.drop();}
});

test('protected original -> approved projection -> fact -> runtime read; revoke removes outbound evidence, preserves protected replay, and deletion cascades', options, async () => {
  const target = await study();
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const original = '😀测试姓名王小明，否认心梗史。年龄 62 岁，肌酐 1.2 mg/dL。';
  const upload = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id,
    name: '王小明.txt', role: 'document', subject: 'CANARY-PATIENT-001', stream: streamOf(original) });
  const input = { subjectKey: upload.file.detail.subjectKey, documentId: upload.file.id };
  const noPermission = await vcr.documents.subjectDocuments(target, input);
  assert.equal(noPermission.available, false);
  assert.ok(!JSON.stringify(noPermission).includes('王小明'));
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: [origin], reference: 'Authored synthetic fixture',
    retention: 'unknown', training: 'unknown', humanReview: 'unknown',
  } });
  const start = original.indexOf('王小明');
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: upload.file.id, actor: 'owner',
    sourceHash: projectionHash(original), spans: [{ start, end: start + 3, kind: 'person' }], attestation: 'Reviewed synthetic canary' });
  target.cloudContext = { runId: 'run_privacy', sessionId: 'session_privacy' };
  const egress = createVcrCloudEgress({ store:vcr.store, resolveSession: async caller => caller.sessionId, destinations:()=>[origin] });
  const caller = { userId: target.userId, projectId: target.projectId, sessionId: 'session_privacy' };
  const cloud = await vcr.documents.subjectDocuments(target, input);
  assert.equal(await vcr.store.hasClinicalContext(target.userId,target.projectId,[{sessionId:'session_privacy'}]),true);
  assert.equal(await vcr.store.hasClinicalContext(target.userId,target.projectId,[{sessionId:'fresh'}]),false);
  assert.equal(await vcr.store.hasClinicalContext('stranger',target.projectId),false);
  const copied={...caller,sessionId:'copied_child'};
  await egress(copied,{messages:[projection.id]});
  assert.equal(await vcr.store.hasClinicalContext(target.userId,target.projectId,[{sessionId:'copied_child'}]),true);
  await egress(caller, { messages: ['cached projected quotation without its id'] });
  assert.equal(cloud.available, true);
  assert.equal(cloud.document.id, projection.id);
  const served = await vcr.store.one('SELECT windows FROM evimed_vcr.cloud_reads WHERE study_id=$1 AND session_id=$2',[target.id,'session_privacy']);
  assert.equal(Object.values(served.windows)[0].extraction,'unknown');
  assert.deepEqual(Object.values(served.windows)[0].served,[0,cloud.document.text.length]);
  assert.ok(!JSON.stringify(cloud).includes('王小明'));
  assert.ok(!JSON.stringify(cloud).includes('CANARY-PATIENT'));
  const saved = await write(target, 'fact', [{ subjectKey: input.subjectKey, variable: 'age', value: 62, unit: 'year',
    documentId: projection.id, quote: '年龄 62 岁', surface: '62' }]);
  assert.equal(saved.ids.length, 1, JSON.stringify(saved.issues));
  await write(target, 'criteria', [{ criteria: [{ kind: 'inclusion', criterionType: 'demographic', sourceText: 'Age >= 18',
    requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } }] }]);
  const visible = await vcr.matching.runtimeRead(target, { subjectKey: input.subjectKey });
  assert.equal(visible.facts.length, 1);
  assert.equal(visible.facts[0].source.sourceHash,projection.sourceHash);
  assert.equal(visible.facts[0].source.projectionHash,projection.projectionHash);
  const restored = await vcr.dataPlane.resolveProjectionQuote({ studyId: target.id, documentId: projection.id, principal: 'owner',
    span: { start: 0, end: cloud.document.text.length, quote: cloud.document.text } });
  assert.equal(restored.quote, original);
  await assert.rejects(vcr.dataPlane.projectionText({ studyId: (await study()).id, documentId: projection.id, principal: 'owner' }, true));
  const built = await vcr.matching.matchScenario(target);
  const result = await vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents: vcr.documents })({
    job: { id: 'job_fixture', studyId: target.id, scenario: built.scenario, inputs: built.inputs }, onProgress: async () => {} });
  assert.equal(result.assessments[0].summary, 'eligible');
  const progress=await vcr.matchStore.matchingProgress(target.id,result.diagnostics.inputSnapshotId);
  assert.equal(progress.length,1); assert.equal(progress[0].state,'evaluated');
  const retained=await vcr.dataStore.deleteSourceFile({studyId:target.id,fileId:upload.file.id,actor:'owner'});
  assert.equal(retained.frozen,true);
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  await assert.rejects(egress(caller, { messages: ['cached projected quotation without its id'] }), { code:'vcr_cloud_processing_not_authorized' });
  await assert.rejects(egress(copied, { messages: ['copied context without ids'] }), { code:'vcr_cloud_processing_not_authorized' });
  await egress({ ...caller, sessionId:'fresh_unrelated_session' }, { messages:['an unrelated research question'] });
  await assert.rejects(egress({ ...caller, sessionId:'fresh_unrelated_session' }, { messages:[projection.id] }), { code:'vcr_cloud_processing_not_authorized' });
  assert.equal((await vcr.documents.subjectDocuments(target, input)).available, false);
  assert.equal((await vcr.matching.runtimeRead(target, { subjectKey: input.subjectKey })).facts.length, 0);
  assert.equal((await vcr.dataPlane.documentText({ studyId: target.id, documentId: projection.id, principal: 'owner' })).text, cloud.document.text);
  const audits = await vcr.store.rows('SELECT detail FROM evimed_vcr.audit WHERE study_id=$1', [target.id]);
  assert.ok(!JSON.stringify(audits).includes('王小明'));
  await vcr.store.softDeleteStudy(target.id,'owner');
  assert.equal(await vcr.store.studyByControlProject(target.userId,target.projectId),null);
  await assert.rejects(egress(caller,{messages:['cached text after study is hidden']}),{code:'vcr_cloud_processing_not_authorized'});
  assert.equal(await vcr.store.hasClinicalContext(target.userId,target.projectId,[{sessionId:'session_privacy'}]),true);
  assert.equal(composeVcr({config:{vcrEnabled:false},productDatabase:database}),null);
  const disabledHistory=new VcrStore({database});
  await assert.rejects(createVcrCloudEgress({store:disabledHistory,resolveSession:async()=>caller.sessionId,destinations:()=>[origin]})(caller,{messages:['cached clinical context after disabling VCR']}),{code:'vcr_cloud_processing_not_authorized'});
  await vcr.dataPlane.deleteStudyFiles(target.id);
  await database.transaction(client => deleteVcrStudyRows(client, target.id));
  assert.equal((await database.query('SELECT * FROM evimed_vcr.document_projections WHERE study_id=$1', [target.id])).rows.length, 0);
});

test('same language key across protocols is isolated, queued inputs ignore later answers, empty charts remain in the denominator', options, async () => {
  const target = await study();
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic empty charts' });
  const chart = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document',
    subject: 'subject-empty', stream: streamOf('Insufficient information.') });
  const subjectKey = chart.file.detail.subjectKey;
  const first = await write(target, 'criteria', [rule('Can understand this protocol')]);
  const p1 = first.ids[0];
  await vcr.matchStore.saveLanguageJudgment({ studyId: target.id, userId: 'owner', subjectKey,
    protocolVersionId: p1, criterionKey: 'consent', state: 'unknown', evidence: [] });
  const second = await write(target, 'criteria', [rule('Can consent to mandatory genomic storage')]);
  const p2 = second.ids[0];
  assert.equal((await vcr.matchStore.latestLanguageJudgments({ studyId: target.id, protocolVersionId: p2 })).size, 0);
  assert.equal((await vcr.matchStore.latestLanguageJudgments({ studyId: target.id, protocolVersionId: p1 })).size, 1);
  const frozen = await vcr.matching.matchScenario(target, { protocolVersionId: p1, direction: 'patient_to_trial', subjectKeys: [subjectKey] });
  const ref = frozen.inputs.find(v => v.id.startsWith('matching:snapshot:')).id.slice('matching:snapshot:'.length);
  const before = await vcr.matchStore.matchingSnapshot(target.id, ref);
  await vcr.matchStore.saveLanguageJudgment({ studyId: target.id, userId: 'owner', subjectKey,
    protocolVersionId: p1, criterionKey: 'consent', state: 'satisfied', evidence: [] });
  assert.deepEqual(await vcr.matchStore.matchingSnapshot(target.id, ref), before);
  const result = await vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store })({
    job: { id: 'job_replay', studyId: target.id, scenario: frozen.scenario, inputs: frozen.inputs }, onProgress: async () => {} });
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].summary, 'insufficient_evidence');
  assert.equal(result.assessments[0].direction, 'patient_to_trial');
  assert.equal(result.diagnostics.requestedSubjects, 1);
  assert.equal(result.diagnostics.subjectsNotEvaluated, 0);
});

test('a changed frozen input at the same clinical as-of time creates a separate historical assessment', options, async () => {
  const target = await study();
  const p = (await write(target, 'criteria', [rule('Consent text')])).ids[0];
  const base = { studyId:target.id, protocolVersionId:p, subjectKey:'p1', asOf:'2026-10-01', summary:'insufficient_evidence', judgments:[] };
  const first = await vcr.matchStore.saveAssessment({ userId:'owner', assessment:{...base,provenance:{inputSnapshotId:'a'.repeat(64)}} });
  const second = await vcr.matchStore.saveAssessment({ userId:'owner', assessment:{...base,summary:'eligible',provenance:{inputSnapshotId:'b'.repeat(64)}} });
  assert.notEqual(first.id, second.id);
  assert.equal((await vcr.matchStore.getAssessment(first.id,target.id)).summary,'insufficient_evidence');
});

test('a patient panel queues both protocols, persists distinct outcomes and accounts for an unavailable protocol', options, async () => {
  const target = await study();
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic panel note' });
  const text = '年龄 44 岁。';
  const chart = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id,
    name: 'panel.txt', role: 'document', subject: 'panel-subject', stream: streamOf(text) });
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: [origin], reference: 'Authored synthetic panel',
    retention: 'unknown', training: 'unknown', humanReview: 'unknown',
  } });
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: chart.file.id,
    actor: 'owner', sourceHash: projectionHash(text), spans: [], attestation: 'Reviewed synthetic note' });
  const subjectKey = chart.file.detail.subjectKey;
  const saved = await write(target, 'fact', [{ subjectKey, variable: 'age', value: 44, unit: 'year',
    documentId: projection.id, quote: '年龄 44 岁', surface: '44' }]);
  assert.equal(saved.ids.length, 1, JSON.stringify(saved.issues));
  const protocols = [];
  for (const age of [18, 65]) {
    const result = await write(target, 'criteria', [{ title: `Age ${age} panel`, criteria: [{ kind: 'inclusion',
      criterionType: 'demographic', sourceText: `Age >= ${age}`,
      requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: age } }] }]);
    protocols.push(result.ids[0]);
  }
  const other = await study();
  const foreign = (await write(other, 'criteria', [rule('Another study protocol')])).ids[0];
  const selection = { protocolVersionIds: [...protocols, foreign], direction: 'patient_to_trial', subjectKeys: [subjectKey] };
  const panel = await vcr.matching.enqueuePanel(target, selection, 'owner');
  assert.equal(panel.requested, 3);
  assert.equal(panel.jobs.length, 2);
  assert.deepEqual(panel.unavailable, [{ protocolVersionId: foreign, code: 'vcr_criteria_missing' }]);
  const again = await vcr.matching.enqueuePanel(target, { ...selection, asOf: panel.asOf }, 'owner');
  assert.deepEqual(again.jobs.map(job => job.jobId), panel.jobs.map(job => job.jobId));
  const completed = [];
  for (let step = 0; step < 2; step += 1) {
    const claimed = await vcr.jobs.claim({ limit: 1 });
    assert.equal(claimed.length, 1);
    assert.equal((await vcr.jobs.advance(claimed[0])).state, 'succeeded');
    completed.push(claimed[0].id);
  }
  assert.deepEqual(completed.sort(), panel.jobs.map(job => job.jobId).sort());
  const assessments = await vcr.matchStore.listAssessments({ studyId: target.id, subjectKey });
  assert.equal(assessments.length, 2);
  assert.deepEqual(Object.fromEntries(assessments.map(item => [item.protocolVersionId, item.summary])),
    { [protocols[0]]: 'eligible', [protocols[1]]: 'ineligible' });
  assert.equal(new Set(assessments.map(item => item.provenance.inputSnapshotId)).size, 2);
  for (const assessment of assessments) {
    assert.equal(assessment.direction, 'patient_to_trial');
    assert.equal(new Date(assessment.asOf).toISOString(), panel.asOf);
    const progress = await vcr.matchStore.matchingProgress(target.id, assessment.provenance.inputSnapshotId);
    assert.deepEqual(progress.map(item => item.state), ['evaluated']);
  }
  const view = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', { candidate: subjectKey });
  assert.deepEqual(Object.fromEntries(view.comparisons.map(item => [item.protocol.id, item.summary])),
    { [protocols[0]]: 'eligible', [protocols[1]]: 'ineligible' });
  assert.deepEqual(await vcr.matchStore.listAssessments({ studyId: other.id }), []);
});

test('registry refresh preserves immutable source versions and isolates the account library', options, async () => {
  const target = await study();
  const saved = await vcr.evidenceStore.savePrecedent({userId:'owner',studyId:target.id,
    precedent:{registry:'clinicaltrials.gov',registryId:'NCT00000001',eligibilityText:'Age >= 18',fetchedAt:'2026-09-01'}, recordText:'Age >= 18',recordHash:'a'.repeat(64)});
  await vcr.evidenceStore.savePrecedent({userId:'owner',studyId:target.id,
    precedent:{registry:'clinicaltrials.gov',registryId:'NCT00000001',eligibilityText:'Age >= 21',fetchedAt:'2026-10-01'},recordText:'Age >= 21',recordHash:'b'.repeat(64)});
  assert.equal((await vcr.evidenceStore.registryVersions('owner',target.id,saved.id)).length,2);
  assert.equal((await vcr.evidenceStore.registryVersions('stranger',target.id,saved.id)).length,0);
  assert.equal((await vcr.evidenceStore.registryVersions('owner',(await study()).id,saved.id)).length,0);
  const historical = await vcr.evidenceStore.precedentOfStudy({ userId:'owner',studyId:target.id,registry:'clinicaltrials.gov',registryId:'NCT00000001',recordHash:'a'.repeat(64) });
  assert.equal(historical.record_text,'Age >= 18');
  assert.equal(await vcr.evidenceStore.precedentOfStudy({ userId:'stranger',studyId:target.id,registry:'clinicaltrials.gov',registryId:'NCT00000001',recordHash:'a'.repeat(64) }),null);
});

test('continued batches share one denominator without mixing later facts or other studies', options, async () => {
  const target=await study();
  const base={studyId:target.id,protocolVersionId:'p1',asOf:'2026-10-01',criteria:[],facts:[],languages:new Map(),subjects:['a','b','c'],limit:1};
  const first=freezeMatchingInputs(base),second=freezeMatchingInputs({...base,offset:1});
  await vcr.matchStore.saveMatchingSnapshot(first); await vcr.matchStore.saveMatchingSnapshot(second);
  await vcr.matchStore.recordMatchingOutcomes(target.id,first.id,{a:{state:'evaluated'}});
  await vcr.matchStore.recordMatchingOutcomes(target.id,second.id,{b:{state:'unavailable',reason:'source_unavailable'}});
  assert.deepEqual((await vcr.matchStore.matchingProgress(target.id,second.id)).map(row=>row.state),['evaluated','unavailable','pending']);
  assert.deepEqual(await vcr.matchStore.matchingProgress((await study()).id,second.id),[]);
  const changed=freezeMatchingInputs({...base,asOf:'2026-10-02'});
  await vcr.matchStore.saveMatchingSnapshot(changed);
  assert.ok((await vcr.matchStore.matchingProgress(target.id,changed.id)).every(row=>row.state==='pending'));
});

test('study-scoped enrichment can be removed without deleting prior facts or changing another study', options, async () => {
  const enabled=await study(), native=await study();
  await write(enabled,'criteria',[rule('Consent')]); await write(native,'criteria',[rule('Consent')]);
  const selected=new Set([enabled.id]);
  const seam=vcrMatchingSeam({matchStore:vcr.matchStore,store:vcr.store,clinicalEnabled:target=>selected.has(target.id)});
  assert.equal((await seam.runtimeRead(enabled,{})).factContract.schema,1);
  assert.equal((await seam.runtimeRead(native,{})).factContract,null);
  selected.clear();
  assert.equal((await seam.runtimeRead(enabled,{})).factContract,null);
});

test('binding a disease pack preserves its selected body across later catalogue changes', options, async t => {
  const target=await study();
  const previous=vcr.knowledge.shipped.get('nsclc');
  await vcr.knowledge.bindPack(target,'nsclc','owner');
  vcr.knowledge.shipped.set('nsclc',{...previous,version:99,terms:[]});
  t.after(()=>vcr.knowledge.shipped.set('nsclc',previous));
  const held=await vcr.knowledge.studyPack(target);
  assert.equal(held.pack.version,previous.version);
  assert.deepEqual(held.pack.terms,previous.terms);
});


test('deleting an unfrozen source removes derived facts and projection files while cached sessions stay denied', options, async () => {
  const target=await study();
  const source=await vcr.dataPlane.registerSource({userId:'owner',studyId:target.id,name:'Disposable synthetic chart'});
  const original='年龄 44 岁';
  const upload=await vcr.dataPlane.storeUpload({actor:'owner',studyId:target.id,sourceId:source.id,name:'synthetic.txt',role:'document',subject:'disposable',stream:streamOf(original)});
  await vcr.dataPlane.setCloudPermission({studyId:target.id,sourceId:source.id,actor:'owner',permission:{status:'approved',dataClass:'synthetic',purpose:'vcr',destinations:[origin],reference:'Synthetic deletion test',retention:'unknown',training:'unknown',humanReview:'unknown'}});
  const projection=await vcr.dataPlane.createDocumentProjection({studyId:target.id,documentId:upload.file.id,actor:'owner',sourceHash:projectionHash(original),spans:[],attestation:'Synthetic'});
  target.cloudContext={sessionId:'deleted_cache',runId:'deleted_run'};
  await vcr.documents.subjectDocuments(target,{subjectKey:upload.file.detail.subjectKey,documentId:projection.id});
  const result=await write(target,'fact',[{subjectKey:upload.file.detail.subjectKey,variable:'age',value:44,unit:'year',documentId:projection.id,quote:original,surface:'44'}]);
  assert.equal(result.ids.length,1);
  const record=await vcr.store.one('SELECT location FROM evimed_vcr.document_projections WHERE id=$1',[projection.id]);
  await vcr.dataPlane.removeUpload({studyId:target.id,fileId:upload.file.id,actor:'owner'});
  assert.equal((await vcr.matchStore.listFacts({studyId:target.id})).length,0);
  await assert.rejects(fs.stat(path.join(directory,record.location)),{code:'ENOENT'});
  const egress=createVcrCloudEgress({store:vcr.store,resolveSession:async()=> 'deleted_cache',destinations:()=>[origin]});
  await assert.rejects(egress({userId:'owner',projectId:target.projectId},{messages:['cached quotation']}),{code:'vcr_cloud_processing_not_authorized'});
});
