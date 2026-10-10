import { createVcrCloudEgress, createVcrSessionResolver } from '../src/vcrCloudEgress.mjs';
import { AgentRunStore } from '../src/agentRuns.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr, vcrMatchingExecutor, vcrMatchingSeam, vcrMetricFamilies, vcrMetricsSnapshot } from '../src/vcrComposition.mjs';
import { projectionHash } from '../src/vcrCloudProjection.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { deleteVcrStudyRows } from '../src/vcrStoreBase.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { freezeMatchingInputs } from '../src/vcrMatchingSnapshot.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { vcrSchemaSql } from '../src/vcrPersistence.mjs';
import { MATCHING_BATCHES_SQL } from '../src/vcrMatchStore.mjs';

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
    assert.equal(await history.holdsStudy('owner','ordinary'),false);
    assert.deepEqual(await history.cloudDependencies('owner','ordinary','session'),[]);
    assert.equal((await empty.query("SELECT to_regclass('evimed_vcr.studies') AS found")).rows[0].found,null);
  }finally{await empty.close();await isolatedEmpty.drop();}
});

test('a project holds a study for the privacy hook exactly when the account can read one in it, hidden ones included', options, async () => {
  const target = await study();
  assert.equal(await vcr.store.holdsStudy('owner', target.projectId), true);
  assert.equal(await vcr.store.holdsStudy('stranger', target.projectId), false, 'another account holds none in this project');
  assert.equal(await vcr.store.holdsStudy('owner', `${target.projectId}_other`), false, 'nor does the owner in a project without one');
  await database.query("INSERT INTO evimed_vcr.members (study_id, user_id, role, invited_by) VALUES ($1,'colleague','site','owner')", [target.id]);
  assert.equal(await vcr.store.holdsStudy('colleague', target.projectId), true, 'a member reads the study, so its cached conversations are theirs to revalidate');
  await vcr.store.softDeleteStudy(target.id, 'owner');
  assert.equal(await vcr.store.holdsStudy('owner', target.projectId), true, 'a hidden study still owns cached clinical conversations');
});

test('the privacy hook with the production session resolver: a project with no study never reads its ledger, one with a recorded clinical read always does', options, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-egress-chain-'));
  try {
    const projectFor = async id => {
      const base = path.join(root, id);
      const project = { id, userId: 'owner', rootDir: base, baseDir: base, metaDir: path.join(base, '.openscience'), workspaceDir: path.join(base, 'workspace') };
      await fs.mkdir(project.metaDir, { recursive: true });
      await fs.mkdir(project.workspaceDir, { recursive: true });
      return project;
    };
    const plain = await projectFor('plain-project');
    const clinical = await projectFor('clinical-project');
    const damage = project => fs.writeFile(path.join(project.metaDir, 'runs.jsonl'), 'this is not a run ledger\n');
    const runs = new AgentRunStore({ get: async () => null }, { model: 'deepseek/deepseek-v4-pro', monitorIntervalMs: 60_000 });
    const resolveSession = createVcrSessionResolver({ agentRuns: runs, sourceProject: async job => {
      assert.equal(job.userId, 'owner');
      return job.projectId === plain.id ? plain : clinical;
    } });
    const egress = createVcrCloudEgress({ store: vcr.store, resolveSession, destinations: () => [origin] });
    const callerIn = (project, sessionId) => ({ userId: 'owner', projectId: project.id, sessionId });

    // A project without a study: the call is answered whatever state its ledger is in.
    await egress(callerIn(plain, 'session_plain'), { messages: ['an ordinary question'] });
    await damage(plain);
    await egress(callerIn(plain, 'session_plain'), { messages: ['an ordinary question'] });

    // A project with a study whose conversation read a projection that no permission covers: checked, then refused...
    const held = await vcr.store.createStudy({ userId: 'owner', projectId: clinical.id, name: 'Synthetic privacy chain', question: 'q', dataTier: 'T0' });
    await vcr.store.inheritCloudDependency(held.id, 'session_clinical', 'run_clinical', `prj_${'b'.repeat(48)}`);
    await assert.rejects(egress(callerIn(clinical, 'session_clinical'), { messages: ['cached clinical context'] }), { code: 'vcr_cloud_processing_not_authorized' });
    // ...a conversation of the same project that read nothing goes through...
    await egress(callerIn(clinical, 'session_unrelated'), { messages: ['an unrelated question'] });
    // ...and a ledger it cannot read refuses the call: for this project nobody can say which conversation it is.
    await damage(clinical);
    await assert.rejects(egress(callerIn(clinical, 'session_unrelated'), { messages: ['an unrelated question'] }), { code: 'agent_runs_corrupt' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
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
  // The referral ledger follows the study's current protocol (the later one, age >= 65), for which this person is ineligible:
  // the earlier protocol's panel verdict of eligible is recorded above and makes no referral (E-05).
  assert.deepEqual(await vcr.matchStore.listReferrals({ studyId: target.id }), []);
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

test('the batches of one candidate denominator are found by a stored, indexed digest of the manifest without its offset, which the migration fills for older rows (E-23)', options, async () => {
  const target = await study();
  const base = { studyId: target.id, protocolVersionId: 'p-digest', asOf: '2026-10-01', criteria: [], facts: [], languages: new Map(), subjects: ['a', 'b', 'c'], limit: 1 };
  const first = freezeMatchingInputs(base), second = freezeMatchingInputs({ ...base, offset: 1 }), changed = freezeMatchingInputs({ ...base, asOf: '2026-10-02' });
  for (const snapshot of [first, second, changed]) await vcr.matchStore.saveMatchingSnapshot(snapshot);
  const digests = async () => Object.fromEntries((await database.query('SELECT id, manifest_digest FROM evimed_vcr.matching_inputs WHERE study_id=$1', [target.id])).rows
    .map(row => [row.id, row.manifest_digest]));
  const stored = await digests();
  assert.match(stored[first.id], /^[a-f0-9]{64}$/);
  assert.equal(stored[first.id], stored[second.id], 'two batches that differ only by offset are one denominator');
  assert.notEqual(stored[first.id], stored[changed.id], 'any other difference is another');
  // The progress read asks for the digest, and the index answers it: with sequential scans forbidden the plan still exists, and names the index.
  const plan = await database.transaction(async client => {
    await client.query('SET LOCAL enable_seqscan = off');
    return JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${MATCHING_BATCHES_SQL}`, [target.id, stored[first.id]])).rows[0]['QUERY PLAN']);
  });
  assert.match(plan, /vcr_matching_inputs_digest_idx/);
  // A row written before the digest existed is filled by the migration, and filling again changes nothing.
  await database.query('UPDATE evimed_vcr.matching_inputs SET manifest_digest = NULL WHERE study_id=$1', [target.id]);
  for (let pass = 0; pass < 2; pass += 1) {
    await database.transaction(async client => { await client.query(vcrSchemaSql()); });
    assert.deepEqual(await digests(), stored, `migration pass ${pass + 1}`);
  }
  await vcr.matchStore.recordMatchingOutcomes(target.id, first.id, { a: { state: 'evaluated' } });
  await vcr.matchStore.recordMatchingOutcomes(target.id, second.id, { b: { state: 'unavailable', reason: 'source_unavailable' } });
  assert.deepEqual((await vcr.matchStore.matchingProgress(target.id, second.id)).map(row => row.state), ['evaluated', 'unavailable', 'pending']);
  assert.deepEqual((await vcr.matchStore.latestMatchingProgress(target.id, 'p-digest')).requested, 3, 'the latest batch of a protocol is still found');
});

test('the data tab says how much of each reviewed document a run was shown and how much it never was (E-06)', options, async () => {
  const target = await study();
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const text = '随访记录：'.repeat(14);
  const stored = (body, subject) => vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document', subject, stream: streamOf(body) });
  const [first, second] = [await stored(text, 'CANARY-READ'), await stored('另一份未审阅的记录。', 'CANARY-UNREVIEWED')];
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: [origin], reference: 'Authored synthetic fixture', retention: 'unknown', training: 'unknown', humanReview: 'unknown' } });
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: first.file.id, actor: 'owner',
    sourceHash: projectionHash(text), spans: [], attestation: 'Reviewed synthetic note' });
  const reading = async (file) => (await vcr.dataPlane.tabFor(target, { id: 'owner' })).sources[0].files.find((entry) => entry.id === file.file.id).reading;

  // Reviewed and never read: nothing was shown. Not reviewed: there is nothing to have shown, and no line about it.
  assert.deepEqual(await reading(first), { chars: text.length, read: 0, skipped: text.length, complete: false, windows: 0 });
  assert.equal(await reading(second), null);

  // A run reads two windows of it, ten characters from the start and ten from further on, with a stretch between them nobody saw.
  target.cloudContext = { runId: 'run_reading', sessionId: 'session_reading' };
  const reader = vcr.documents;
  const windowChars = reader.windowChars;
  const input = { subjectKey: first.file.detail.subjectKey, documentId: projection.id };
  reader.windowChars = 10;
  try {
    assert.equal((await reader.subjectDocuments(target, { ...input, offset: 0 })).available, true);
    assert.equal((await reader.subjectDocuments(target, { ...input, offset: 40 })).available, true);
  } finally { reader.windowChars = windowChars; }
  assert.deepEqual(await reading(first), { chars: text.length, read: 20, skipped: text.length - 20, complete: false, windows: 2 });

  // Another conversation reads the first fifty: the ranges are one union, and what both saw counts once.
  target.cloudContext = { runId: 'run_reading_2', sessionId: 'session_reading_2' };
  reader.windowChars = 50;
  try { await reader.subjectDocuments(target, { ...input, offset: 0 }); } finally { reader.windowChars = windowChars; }
  assert.deepEqual(await reading(first), { chars: text.length, read: 50, skipped: text.length - 50, complete: false, windows: 3 });
  const tab = JSON.stringify((await vcr.dataPlane.tabFor(target, { id: 'owner' })).sources);
  assert.equal(tab.includes('run_reading') || tab.includes('session_reading'), false, 'which conversation read it is not the tab\'s to say');
});

test('the matching tab names the document each citation is in by the name the data tab lists it under, whichever id the citation carries (E-06)', options, async () => {
  const target = await study();
  await write(target, 'criteria', [{ criteria: [{ kind: 'exclusion', criterionType: 'prior_treatment', sourceText: '距上次多西他赛满 28 天',
    requirement: { op: 'elapsed_since', variable: 'docetaxel', days: 28 } }] }]);
  const protocol = await vcr.matchStore.latestProtocol(target.id);
  const [criterion] = await vcr.matchStore.listCriteria({ studyId: target.id, protocolVersionId: protocol.id });
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const [note, older] = ['2026-09-26 处方多西他赛。', '2026-06-01 给予多西他赛。'];
  const stored = (body, subject) => vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document', subject, stream: streamOf(body) });
  const [recent, old] = [await stored(note, 'CANARY-CITE'), await stored(older, 'CANARY-CITE')];
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: {
    status: 'approved', dataClass: 'synthetic', purpose: 'vcr', destinations: [origin], reference: 'Authored synthetic fixture', retention: 'unknown', training: 'unknown', humanReview: 'unknown' } });
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: recent.file.id, actor: 'owner', sourceHash: projectionHash(note), spans: [], attestation: 'Reviewed synthetic note' });
  const subjectKey = recent.file.detail.subjectKey;
  const cited = (quote, documentId, occurredAt) => ({ factId: 'fac_x', variable: 'docetaxel', quote, quoteKind: 'verbatim', locator: { documentId, start: 0, end: quote.length }, occurredAt, visibleAt: null, polarity: 'affirmed' });
  await vcr.matchStore.saveAssessment({ userId: 'owner', assessment: { studyId: target.id, protocolVersionId: protocol.id, subjectKey, asOf: '2026-10-01T00:00:00.000Z',
    summary: 'insufficient_evidence', counts: { satisfied: 0, unknown: 1, pending_recheck: 0 }, evidenceGaps: [{ variable: 'docetaxel', reason: 'unresolved_exposure', criterionIds: [criterion.id] }], provenance: {},
    judgments: [{ criterionId: criterion.id, state: 'unknown', applicable: true, decidedBy: 'code', evidence: [
      cited('2026-09-26 处方多西他赛', projection.id, '2026-09-26T00:00:00.000Z'), cited('2026-06-01 给予多西他赛', old.file.id, '2026-06-01T00:00:00.000Z')] }] } });
  const shown = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', new URLSearchParams(`candidate=${subjectKey}`));
  const row = shown.selected.criteria[0];
  const names = Object.fromEntries((await vcr.dataPlane.tabFor(target, { id: 'owner' })).sources[0].files.map((file) => [file.id, file.name]));
  assert.deepEqual(row.evidenceItems.map((item) => item.source), [names[recent.file.id], names[old.file.id]], 'the reviewed text and the original are the same document the data tab lists, by one name');
  assert.ok(row.evidenceItems.every((item) => /^document-[0-9a-f]{8}\.txt$/.test(item.source)), 'a name derived from content, never from what was uploaded');
});

test('the receipts of the model calls behind stored facts are read back for operators, split by the model that answered, and by nothing a person is (E-06)', options, async () => {
  const target = await study();
  const producer = (model, requestedModel = 'deepseek-v4-flash') => ({ schema: 1, status: 'recorded', runId: `run_${model}`, association: 'run_requests_before_write', requests: [
    { id: `req_${model}`, requestedModel, observedModel: model, requestHash: 'a'.repeat(64), providerRequestId: 'prov_1', status: 'settled' }] });
  await vcr.store.transaction(async client => {
    await vcr.matchStore.saveProducer(client, target.id, 'fac_one', producer('deepseek-v4-flash'));
    await vcr.matchStore.saveProducer(client, target.id, 'fac_two', producer('deepseek-v4-flash'));
    await vcr.matchStore.saveProducer(client, target.id, 'fac_three', producer('deepseek-v4-pro'));
    await vcr.matchStore.saveProducer(client, target.id, 'fac_none', { schema: 1, status: 'unknown', runId: null, requests: [] });
  });
  const snapshot = await vcrMetricsSnapshot(vcr);
  const split = Object.fromEntries(snapshot.matchingProducers.map(entry => [entry.model, entry.receipts]));
  assert.ok(split['deepseek-v4-flash'] >= 2 && split['deepseek-v4-pro'] >= 1 && split.unrecorded >= 1, JSON.stringify(split));
  const family = vcrMetricFamilies(true, snapshot).find(entry => entry.name === 'open_science_vcr_matching_producers');
  assert.ok(family, 'the split is a metric of its own');
  assert.deepEqual(family.series.map(entry => Object.keys(entry.labels ?? {})).flat().filter((key, index, all) => all.indexOf(key) === index), ['model']);
  assert.equal(/run_|req_|prov_|a{64}/.test(JSON.stringify(family)), false, 'no run, request or hash is a label or a value');
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
