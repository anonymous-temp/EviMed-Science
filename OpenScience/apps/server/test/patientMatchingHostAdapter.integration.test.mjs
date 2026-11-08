import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrPatientContext } from '../src/vcrPatientContext.mjs';
import { createPatientMatchingHostAdapter } from '../src/patientMatchingHostAdapter.mjs';
import { createPatientMatchingGatewayHandler } from '../src/patientMatchingGateway.mjs';
import { renderPatientMatchingReport } from '../src/patientMatchingReport.mjs';
import { installPatientMatchingLegacyBridge } from '../src/patientMatchingLegacyBridge.mjs';
import { validateToolResponse, contentDigest, validatePairDecision } from '@evimed/patient-matching-core';
import { evaluateCriterion } from '../src/vcrMatching.mjs';
import { createVcrRoutes } from '../src/vcrRoutes.mjs';
import { migrateVcr } from '../src/vcrPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'An isolated local PostgreSQL is required', timeout: 30000 };
let database, isolated, dir, vcr, documents, adapter, study, subjectKey, protocol, messageSeq = 1;
const origin = { userId: 'owner', projectId: 'project', rootSessionId: 'root', runId: 'run', callId: 'native-call', rootCallId: 'native-call', pluginGeneration: 'generation-a' };
const config = { vcrEnabled: true, vcrAudience: 'all', vcrProviderAgreements: true, deepseekBaseUrl: 'https://model.invalid' };
const messages = new Map([[1, 'Patient is 62 years old. Weight 80 kg. Height 2 m.']]);
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'nativehost');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development'),('other','Other','development'),('partner','Partner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',10000000)");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-host-'));
  vcr = composeVcr({ config: { ...config, vcrDataPlaneDir: dir }, productDatabase: database });
  await vcr.store.ready();
  vcr.patientContext = createVcrPatientContext({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, documents: vcr.documents, subjectKnown: vcr.subjectKnown,
    transcript: async () => ({ sessionId: 'root', messages: [...messages].map(([seq,text]) => ({ seq, role: 'user', source: 'user', parts: [{ type: 'text', text }] })) }), isHumanMessage: async () => true });
  documents = new ProductDocuments(database);
  adapter = createPatientMatchingHostAdapter({ vcr, documents, config });
  study = await vcr.store.taskContext(origin);
  const patient = await vcr.patientContext(study, { messageSeq }, origin);
  subjectKey = patient.subjectKey;
  protocol = await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: 'owner', title: 'Adults', criteria: [{ kind: 'inclusion', sourceText: 'Age at least 18 years.' }] });
});
after(async () => { await database?.close(); await isolated?.drop(); if (dir) await fs.rm(dir,{recursive:true,force:true}); });
const invoke = (port, operation, input, actor = origin) => adapter.dispatch({ port, operation, input, origin: actor });
function decisionOf(prepared, index = 0) {
  const pair = prepared.task.selectedPairs[index], profile = prepared.trialProfiles.find(item=>item.trialId===pair.trialId), bundle = prepared.evidenceBundles.find(item=>item.sources.some(source=>source.sourceId===profile.source.sourceId)&&item.patientPassages.some(passage=>passage.subjectKey===pair.subjectKey));
  return { schemaVersion: '1', decisionId: `decision-${prepared.executionId}-${index}`, revision: '1', scope: prepared.task.scope, ...pair,
    state: 'complete', clinicalEligibility: 'eligible', recommendation: { priority: 0.15, rationale: 'This patient meets the trial age criterion; priority remains a separate research ordering.' },
    criteria: profile.criteria.map(criterion => ({ criterionId: criterion.criterionId, kind: criterion.kind, verdict: 'satisfied', basis: 'stated', evidenceIds: [bundle.patientPassages[0].evidenceId], assumptions: [], reason: 'The preserved patient record states age 62.' })),
    sourceRefs: bundle.sources, profileDigest: prepared.profileDigest, producer: { kind: 'model', modelProfileDigest: prepared.profileDigest, executionId: prepared.executionId }, evidenceBundleId: bundle.bundleId, unresolvedFacts: [], assumptions: [] };
}
async function preparedTask() { return (await invoke('ExecutionPort','assess',{ phase:'prepare', protocolVersionId:protocol.id, subjectKeys:[subjectKey] })).data; }
async function save(prepared, decisions = [decisionOf(prepared)]) { return invoke('ResultPort','save',{phase:'commit',taskId:prepared.task.taskId,executionId:prepared.executionId,profileDigest:prepared.profileDigest,decisions,native:{childId:'native-child',messageId:'native-message',stopReason:'completed'},diagnostics:[]}); }

test('an existing two-kind database upgrades without deleting old protocol criteria', options, async () => {
  await database.query("ALTER TABLE evimed_vcr.criteria DROP CONSTRAINT criteria_kind_check; ALTER TABLE evimed_vcr.criteria ADD CONSTRAINT criteria_kind_check CHECK(kind IN ('inclusion','exclusion'))");
  const upgrade=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:2,databaseConnectionTimeoutMs:2000});
  try{await migrateVcr(upgrade);}finally{await upgrade.close();}
  assert.equal((await vcr.matchStore.listCriteria({studyId:study.id,protocolVersionId:protocol.id}))[0].kind,'inclusion');
  const saved=await vcr.matchStore.saveProtocolVersion({studyId:study.id,userId:'owner',title:'Unclassified source',criteria:[{kind:'unclassified',sourceText:'An unsectioned source clause.'}]});
  assert.equal((await vcr.matchStore.listCriteria({studyId:study.id,protocolVersionId:saved.id}))[0].kind,'unclassified');
});

test('native protocol intake binds original user text and preserves sectioned and unclassified clauses without creating patients', options, async () => {
  const count=(await vcr.documents.roster(study)).length;
  for(const [text,kinds] of [['Inclusion Criteria:\n- Age at least 18 years.\nExclusion Criteria:\n- Pregnancy.',['inclusion','exclusion']],['Adults with asthma\n\nNo prior biologics',['unclassified','unclassified']]]){
    messages.set(++messageSeq,`Please assess this protocol:\n${text}`);
    const saved=(await invoke('PatientDataPort','context',{messageSeq,protocolText:text,title:'Original eligibility'})).data;
    const again=(await invoke('PatientDataPort','context',{messageSeq,protocolText:text,title:'Original eligibility'})).data;
    assert.equal(again.protocolVersionId,saved.protocolVersionId);
    const rows=await vcr.matchStore.listCriteria({studyId:study.id,protocolVersionId:saved.protocolVersionId});
    assert.deepEqual(rows.map(row=>row.kind),kinds);
    const p=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:saved.taskId,subjectKeys:[subjectKey]})).data;
    const profile=p.trialProfiles[0];assert.deepEqual(profile.criteria.map(row=>row.kind),kinds);
    for(const criterion of profile.criteria)assert.equal(profile.preservedText.slice(criterion.span.start,criterion.span.end),criterion.text);
    const draft=(await invoke('PatientDataPort','context',{})).data;
    await invoke('PatientDataPort','context',{taskId:draft.taskId,messageSeq,protocolText:text});
    assert.equal((await adapter.repository.get(p.task.scope,draft.taskId)).payload.protocolVersionId,saved.protocolVersionId);
    await assert.rejects(invoke('PatientDataPort','context',{taskId:saved.taskId,messageSeq,protocolText:text.slice(text.indexOf('\n')+1)}),{code:'patient_matching_task_frozen'});
    if(kinds[0]==='unclassified'){
      const judged=evaluateCriterion({...rows[0],requirement:{op:'compare',variable:'age',comparator:'gte',value:18,unit:'year'}},{facts:[],asOf:'2026-11-05'});
      assert.equal(judged.kind,'unclassified');assert.equal(judged.state,'unknown');
    }
    await assert.rejects(invoke('PatientDataPort','context',{messageSeq,protocolText:'Fabricated inclusion criteria'}),{code:'patient_matching_original_mismatch'});
  }
  const frozenRegistry=(await invoke('PatientDataPort','context',{subjectKey,trialIds:['NCT00000199']})).data;
  const latestText=messages.get(messageSeq).split('Please assess this protocol:\n')[1];
  assert.equal((await adapter.repository.get({tenantId:'owner',actorId:'owner',projectId:'project',conversationId:'root'},frozenRegistry.taskId)).payload.protocolVersionId,null);
  await assert.rejects(invoke('PatientDataPort','context',{taskId:frozenRegistry.taskId,messageSeq,protocolText:latestText}),{code:'patient_matching_task_frozen'});
  assert.equal((await vcr.documents.roster(study)).length,count);
});

test('native decision output kinds agree with core while source profiles may remain unclassified', options, async()=>{
  const p=await preparedTask(),kinds=p.outputSchema.properties.decisions.items.properties.criteria.items.properties.kind.enum;
  assert.deepEqual(kinds,['inclusion','exclusion']);
  for(const kind of kinds){
    const decision=decisionOf(p);decision.criteria[0].kind=kind;
    const trialProfile={...p.trialProfiles[0],criteria:p.trialProfiles[0].criteria.map(row=>({...row,kind:'unclassified'}))};
    validatePairDecision(decision,{task:p.task,trialProfile,evidenceBundle:p.evidenceBundles[0]});
  }
  const invalid=decisionOf(p);invalid.criteria[0].kind='unclassified';
  assert.throws(()=>validatePairDecision(invalid));
});

test('trusted discovery and preserved knowledge hooks reach native tools and revalidate evidence on refresh and restart', options, async()=>{
  const text='A sourced definition for the synthetic eligibility assessment.',source={sourceId:'kb-synthetic',revision:'1',kind:'knowledge',digest:contentDigest(text)};
  const passage={evidenceId:'kb-evidence',source,text,span:{start:0,end:text.length}};let refreshed=0,discovered=0;
  const knowledge=Object.assign(async()=>({status:'complete',summary:'Preserved definition.',data:{passages:[passage],limitations:[]},artifacts:[]}),{refresh:async({passages})=>{refreshed++;assert.deepEqual(passages,[passage]);}});
  const native=createPatientMatchingHostAdapter({vcr,documents,config,knowledge,discover:async({patient,origin:acting})=>{discovered++;assert.equal(patient.context.subjectKey,subjectKey);assert.equal(acting.userId,'owner');return {status:'complete',summary:'Discovery hook.',data:{searchId:'trusted-search'},artifacts:[]};}});
  const draft=(await native.dispatch({port:'PatientDataPort',operation:'context',input:{subjectKey},origin})).data;
  await native.dispatch({port:'RegistryPort',operation:'search',input:{taskId:draft.taskId,query:'asthma'},origin});assert.equal(discovered,1);
  const p=(await native.dispatch({port:'ExecutionPort',operation:'assess',input:{phase:'prepare',protocolVersionId:protocol.id,subjectKeys:[subjectKey]},origin})).data;
  await native.dispatch({port:'KnowledgePort',operation:'search',input:{taskId:p.task.taskId,source:'knowledge',query:'definition'},origin});
  const read=(await native.dispatch({port:'ExecutionPort',operation:'assess',input:{phase:'refresh',taskId:p.task.taskId,executionId:p.executionId},origin})).data;
  assert.deepEqual(read.task,p.task);assert.deepEqual(read.evidenceBundles[0].knowledgePassages,[passage]);
  const decision=decisionOf(read);decision.criteria[0].evidenceIds.push(passage.evidenceId);
  const saved=await native.dispatch({port:'ResultPort',operation:'save',input:{phase:'commit',taskId:p.task.taskId,executionId:p.executionId,profileDigest:p.profileDigest,decisions:[decision],native:{childId:'knowledge-child',messageId:'knowledge-message',stopReason:'completed'}},origin});
  assert.equal(saved.data.state,'complete');
  const restarted=createPatientMatchingHostAdapter({vcr,documents,config,knowledge});
  assert.equal((await restarted.resultOf(origin,p.task.taskId)).state,'complete');assert.ok(refreshed>2);
});

test('real owned context prepares sources, commits native decisions and reads one projection on reply, page and report', options, async () => {
  const p = await preparedTask();
  assert.equal(p.reasoning.model,'deepseek-flash');
  assert.equal(p.task.scope.conversationId,'root');
  assert.equal(p.trialProfiles[0].preservedText.slice(p.trialProfiles[0].criteria[0].span.start,p.trialProfiles[0].criteria[0].span.end),'Age at least 18 years.');
  const saved = await save(p);
  assert.equal(saved.status,'complete');
  assert.equal(saved.data.rows[0].clinicalEligibility,'eligible');
  assert.equal(saved.data.rows[0].recommendation.priority,0.15);
  const read = (await invoke('ResultPort','get',{taskId:p.task.taskId})).data;
  assert.deepEqual(read,saved.data);
  const repeated=await invoke('ExecutionPort','assess',{phase:'prepare',taskId:p.task.taskId});
  assert.equal(repeated.data.kind,'saved-result');assert.deepEqual(repeated.data.result,read);
  const page = await vcr.matchResults.forProtocol(study,protocol.id,{viewer:{id:'owner'}});
  assert.equal(page.people[0].verdict,'eligible','a low recommendation must never rewrite native clinical eligibility');
  const report = await invoke('ExecutionPort','report',{taskId:p.task.taskId,resultId:read.resultId,format:'json'});
  validateToolResponse(report);assert.equal(report.artifacts[0],report.data.artifactId);assert.match(report.data.artifact,/\/reports\/pm_result_.*\.json$/);
  const rendered = renderPatientMatchingReport(await adapter.pageResult(study,'owner',p.task.taskId,read.resultId),'json');
  assert.deepEqual(JSON.parse(rendered.text).rows,read.rows);
  const meta = await adapter.repository.get(p.task.scope,p.task.taskId);
  assert.doesNotMatch(JSON.stringify(meta.payload),/Patient is 62|preserved patient record|priority remains/);
  const stored = (await vcr.matchJudgments.byIds(study.id,meta.payload.rowIds))[0];
  assert.equal(stored.model,'deepseek-flash');
  assert.equal(stored.answer.modelProfile.digest,p.profileDigest);
  await assert.rejects(invoke('ResultPort','get',{taskId:p.task.taskId},{...origin,userId:'other'}));
  await assert.rejects(invoke('ResultPort','get',{taskId:p.task.taskId},{...origin,rootSessionId:'another-root'}));
});

test('prepare refresh uses frozen identities, altered source, forged evidence and cross-task commit are denied', options, async () => {
  const p = await preparedTask();
  const fresh = await invoke('ExecutionPort','assess',{phase:'refresh',taskId:p.task.taskId,executionId:p.executionId});
  assert.deepEqual(fresh.data.task,p.task);
  const forged = decisionOf(p); forged.criteria[0].evidenceIds = ['foreign-evidence'];
  const failed=await save(p,[forged]);assert.equal(failed.data.counts.failed,1);assert.equal(failed.data.rows[0].clinicalEligibility,'not-assessed');
  const another = await preparedTask();
  await assert.rejects(invoke('ResultPort','save',{phase:'commit',taskId:another.task.taskId,executionId:p.executionId,profileDigest:p.profileDigest,decisions:[decisionOf(p)],native:{childId:'child',messageId:'message'}}));
  messages.set(++messageSeq,'Follow-up: patient age was corrected to 63 years.');
  await vcr.patientContext(study,{messageSeq,subjectKey},origin);
  await assert.rejects(invoke('ExecutionPort','assess',{phase:'refresh',taskId:another.task.taskId,executionId:another.executionId}),{code:'patient_matching_source_changed'});
  await assert.rejects(save(another),{code:'patient_matching_source_changed'});
});

test('partial native batches resume only unfinished pairs and existing controls select the native ledger', options, async () => {
  messages.set(++messageSeq,'Another synthetic patient is 62 years old.');
  const other=await vcr.patientContext(study,{messageSeq},origin);
  const scheduled=[];
  const native=createPatientMatchingHostAdapter({vcr,documents,config,onPending:async(_origin,taskId)=>{scheduled.push(taskId);}});
  const p=(await native.dispatch({port:'ExecutionPort',operation:'assess',input:{phase:'prepare',protocolVersionId:protocol.id,subjectKeys:[subjectKey,other.subjectKey]},origin})).data;
  const input={phase:'commit',taskId:p.task.taskId,executionId:p.executionId,profileDigest:p.profileDigest,decisions:[decisionOf(p)],native:{childId:'child',messageId:'message',stopReason:'completed'}};
  const forged=decisionOf(p,1);forged.criteria[0].evidenceIds=['foreign'];
  const partial=await native.dispatch({port:'ResultPort',operation:'save',input:{...input,decisions:[decisionOf(p),forged]},origin});
  assert.equal((await native.repository.get(p.task.scope,p.task.taskId)).payload.rowIds.length,2,'valid clinical and empty failed sibling records are committed together');
  assert.equal(partial.status,'partial');assert.equal(partial.data.counts.failed,1);assert.deepEqual(scheduled,[]);
  await native.dispatch({port:'JobPort',operation:'continue',input:{taskId:p.task.taskId,jobId:p.task.taskId},origin});
  assert.deepEqual(scheduled,[p.task.taskId]);
  const resumed=(await native.dispatch({port:'ExecutionPort',operation:'assess',input:{phase:'prepare',taskId:p.task.taskId},origin:{...origin,callId:'next-call'}})).data;
  assert.deepEqual(resumed.task.selectedPairs,[{subjectKey:other.subjectKey,trialId:protocol.id}]);
  const second=decisionOf(resumed);second.recommendation.priority=0.99;
  const completed=await native.dispatch({port:'ResultPort',operation:'save',input:{phase:'commit',taskId:p.task.taskId,executionId:resumed.executionId,profileDigest:resumed.profileDigest,decisions:[second],native:{childId:'child2',messageId:'message2',stopReason:'completed'}},origin:{...origin,callId:'next-call'}});
  const expected=completed.data.rows.map(row=>row.subjectKey);
  const page=await vcr.matchResults.forProtocol(study,protocol.id,{viewer:{id:'owner'},limit:1,subjectKey:other.subjectKey});
  assert.equal(page.people[0].subjectKey,expected[0],'native order precedes pagination even when the second patient has higher priority');
  assert.equal(page.selected.subjectKey,other.subjectKey);
  const file=await vcr.matchResults.exporter(study,{format:'json',kind:'pairs',direction:'trial_to_patient',protocolVersionId:protocol.id,viewer:{id:'owner'}});
  let text='';await file.run({write:async chunk=>{text+=chunk;}});assert.deepEqual(JSON.parse(text).rows.map(row=>row.subjectKey),expected);
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:other.sourceId,actor:'owner',permission:{status:'revoked'}});
  const restricted=(await native.dispatch({port:'ResultPort',operation:'get',input:{taskId:p.task.taskId},origin})).data;
  assert.equal(restricted.counts.requested,2);assert.equal(restricted.counts.complete,1);assert.equal(restricted.counts.unsupported,1);
  assert.equal(restricted.state,'partial');assert.equal(restricted.rows.find(row=>row.subjectKey===other.subjectKey).recommendation.rationale,'');
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:other.sourceId,actor:'owner',permission:{status:'default'}});
  installPatientMatchingLegacyBridge({vcr,adapter:native,documents,resolveOrigin:async()=>origin});
  const started=await vcr.matchJudge.start(study,{direction:'trial_to_patient',protocolVersionId:protocol.id,subjectKeys:[subjectKey]});
  assert.match(started.jobId,/^matchTask_/);
  assert.equal((await vcr.jobs.get(study.id,started.jobId)).native,true);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='match_judge'",[study.id])).rows[0].n,0,'native selection cannot enqueue the old direct-model loop');
  const canceled=await vcr.jobs.cancel(study.id,started.jobId,{actor:'owner'});
  assert.equal(canceled.canceled,true);assert.equal(canceled.job.state,'canceled');
  assert.equal((await native.pending(origin,started.taskId)).state,'cancelled');
});

test('five thousand selected pairs survive restart in bounded reference pages without raising the product payload limit', options, async () => {
  const p=await preparedTask(), base=(await adapter.repository.get(p.task.scope,p.task.taskId)).payload;
  const selectedPairs=Array.from({length:5000},(_,index)=>({subjectKey:`synthetic-person-${String(index).padStart(5,'0')}`,trialId:protocol.id}));
  const taskId='matchTask_reference_scale_fixture';
  await adapter.repository.put(p.task.scope,taskId,{...base,taskId,studyId:'synthetic-scale-reference-study',selectedPairs,rowIds:[],executions:[],results:[]});
  const stored=await documents.get('owner','patient-matching-task',taskId);
  assert.equal(stored.payload.selectedPairs,undefined);assert.equal(stored.payload.selectedPairPages.length,20);
  const sizes=await database.query("SELECT max(octet_length(payload::text))::int AS largest FROM evimed_product.documents WHERE kind='patient-matching-task'");
  assert.ok(sizes.rows[0].largest<256*1024);
  const restarted=createPatientMatchingHostAdapter({vcr,documents,config});
  assert.deepEqual((await restarted.repository.get(p.task.scope,taskId)).payload.selectedPairs,selectedPairs);
});

test('patient-to-trials page, explicit selection and export retain the saved native order', options, async () => {
  const original=vcr.evidence.judgmentRecord,registryIds=['NCT00000101','NCT00000102'];
  vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n* Age at least 18 years.',conditions:[],interventions:[]}});
  try{
    const p=(await invoke('ExecutionPort','assess',{phase:'prepare',subjectKey,registryIds})).data;
    const one=decisionOf(p),two=decisionOf(p,1);one.recommendation.priority=0.01;two.recommendation.priority=0.99;
    const result=(await save(p,[one,two])).data;
    const expected=result.rows.map(row=>row.trialId);
    const page=await vcr.matchResults.forPatient(study,subjectKey,{viewer:{id:'owner'},target:registryIds[1]});
    assert.deepEqual(page.trials.filter(row=>registryIds.includes(row.id)).map(row=>row.id),expected);
    assert.equal(page.selected.id,registryIds[1]);
    const file=await vcr.matchResults.exporter(study,{format:'json',kind:'pairs',direction:'patient_to_trial',subjectKey,viewer:{id:'owner'}});
    let text='';await file.run({write:async chunk=>{text+=chunk;}});
    assert.deepEqual(JSON.parse(text).rows.filter(row=>registryIds.includes(row.target.id)).map(row=>row.target.id),expected);
  }finally{vcr.evidence.judgmentRecord=original;}
});

test('real calculator operands bind to current evidence and the frozen execution refresh keeps its verified receipt', options, async () => {
  const p=await preparedTask(),passages=p.evidenceBundles[0].patientPassages;
  const weight=passages.find(passage=>passage.text.includes('Weight 80')),height=passages.find(passage=>passage.text.includes('Height 2'));
  const operands=[{name:'weight',value:80,unit:'kg',evidenceId:weight.evidenceId},{name:'height',value:2,unit:'m',evidenceId:height.evidenceId}];
  const computed=await invoke('ExecutionPort','compute',{taskId:p.task.taskId,subjectKey,calculatorId:'bmi',operands});
  assert.equal(computed.data.receipt.result.value,20);assert.equal(computed.data.receipt.exactCheck,'verified');assert.match(computed.data.receipt.calculator.digest,/^sha256:[a-f0-9]{64}$/);
  const refreshed=(await invoke('ExecutionPort','assess',{phase:'refresh',taskId:p.task.taskId,executionId:p.executionId})).data;
  assert.equal(refreshed.evidenceBundles[0].computations[0].receiptId,computed.data.receipt.receiptId);assert.deepEqual(refreshed.task,p.task);
  await assert.rejects(invoke('ExecutionPort','compute',{taskId:p.task.taskId,subjectKey,calculatorId:'bmi',operands:[{...operands[0],evidenceId:'foreign'}]}),{code:'patient_matching_operand_source_mismatch'});
  const missing=await invoke('ExecutionPort','compute',{taskId:p.task.taskId,subjectKey,calculatorId:'bmi',operands:[operands[0]]});
  assert.equal(missing.data.receipt.state,'missing');assert.equal(missing.data.receipt.result,null);
});

test('mixed readable and revoked partner documents never disclose saved clinical wording through results or reports', options, async()=>{
  await vcr.dataStore.addMember({studyId:study.id,userId:'partner',role:'data_manager',invitedBy:'owner'});
  const ownerSource=await vcr.dataPlane.registerSource({userId:'owner',studyId:study.id,name:'Owned mixed record',allowedUses:['vcr','matching']});
  const ownerFile=(await vcr.dataPlane.storeUpload({actor:'owner',studyId:study.id,sourceId:ownerSource.id,name:'owned.txt',role:'document',subject:'mixed-private-source',stream:Readable.from([Buffer.from('Age 62 years. Public synthetic context remains readable.')])})).file;
  const mixedKey=ownerFile.detail.subjectKey,sentinel='PARTNERCONFIDENTIAL_MARKER_91';
  const partnerSource=await vcr.dataPlane.registerSource({userId:'partner',studyId:study.id,name:'Partner record',allowedUses:['vcr','matching']});
  await vcr.dataPlane.storeUpload({actor:'partner',studyId:study.id,sourceId:partnerSource.id,name:'partner.txt',role:'document',subjectKey:mixedKey,stream:Readable.from([Buffer.from(`The partner record states ${sentinel}.`)])});
  const grant=await vcr.dataPlane.createGrant({actor:'partner',studyId:study.id,sourceId:partnerSource.id,grantee:'owner',purposes:['vcr']});
  const p=(await invoke('ExecutionPort','assess',{phase:'prepare',protocolVersionId:protocol.id,subjectKeys:[mixedKey]})).data;
  const decision=decisionOf(p);decision.recommendation.rationale=sentinel;decision.criteria[0].reason=sentinel;
  decision.criteria[0].evidenceIds.push(p.evidenceBundles[0].patientPassages.find(passage=>passage.text.includes(sentinel)).evidenceId);
  const saved=await save(p,[decision]);assert.match(JSON.stringify(saved),new RegExp(sentinel));
  const meta=(await adapter.repository.get(p.task.scope,p.task.taskId)).payload,row=(await vcr.matchJudgments.byIds(study.id,meta.rowIds))[0];
  await vcr.dataPlane.revokeGrant({actor:'partner',studyId:study.id,grantId:grant.id});
  assert.equal(await vcr.documents.recordStands(study,{subjectKey:mixedKey,documentIds:row.documentIds,snapshotIds:[]}),null,'cloud permission and bytes alone do not judge the partner grant');
  const judged=await vcr.documents.judgeReads(study,{id:'owner'},[{documentIds:row.documentIds,snapshots:row.answer.readFrom.snapshots}]);
  assert.equal(judged.permitted[0],false);
  const result=(await invoke('ResultPort','get',{taskId:p.task.taskId})).data;
  assert.equal(result.counts.requested,1);assert.equal(result.counts.unsupported,1);assert.equal(result.counts.complete,0);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(sentinel));
  for(const format of ['json','csv','markdown'])assert.doesNotMatch(renderPatientMatchingReport(await adapter.pageResult(study,'owner',p.task.taskId,saved.data.resultId),format).text,new RegExp(sentinel));
  const refreshed=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:p.task.taskId}, {...origin,callId:'mixed-recheck'})).data;
  assert.equal(refreshed.context[0].coverage.state,'partial','the remaining owner document is still readable, so this is the mixed-source failure class');
});

test('context-only model requests recheck current sources and cloud grants before any provider send', options, async()=>{
  messages.set(++messageSeq,'A separate synthetic patient has asthma and age 62 years.');
  let captured;
  const native=createPatientMatchingHostAdapter({vcr,documents,config,discover:async({scope,origin:acting,meta,patient})=>{captured={scope,origin:acting,input:{taskId:meta.taskId,query:'asthma',patientSources:patient.sources}};return {status:'complete',summary:'Captured authorized discovery scope.',data:{},artifacts:[]};}});
  const context=(await native.dispatch({port:'PatientDataPort',operation:'context',input:{messageSeq},origin})).data;
  await native.dispatch({port:'RegistryPort',operation:'search',input:{taskId:context.taskId,query:'asthma'},origin});
  const meta=(await native.repository.get(captured.scope,context.taskId)).payload;assert.deepEqual(meta.selectedPairs,[]);
  assert.equal((await native.authorizeModel(captured)).userId,'owner');
  await assert.rejects(native.authorizeModel({...captured,input:{...captured.input,patientSources:[]}}),{code:'patient_matching_model_sources_changed'});
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:context.sourceId,actor:'owner',permission:{status:'revoked'}});
  let sent=0;const send=async()=>{await native.authorizeModel(captured);sent++;};
  await assert.rejects(send());assert.equal(sent,0);
  await vcr.dataPlane.setCloudPermission({studyId:study.id,sourceId:context.sourceId,actor:'owner',permission:{status:'default'}});
  messages.set(++messageSeq,'The synthetic follow-up adds a new asthma observation.');
  await vcr.patientContext(study,{messageSeq,subjectKey:context.subjectKey},origin);
  await assert.rejects(send(),{code:'patient_matching_model_sources_changed'});assert.equal(sent,0,'a retry cannot use cached passages from an older source revision');
});

test('native job result routes and actual report downloads require the reader and patient-level authority', options, async()=>{
  const p=await preparedTask(),saved=await save(p);
  installPatientMatchingLegacyBridge({vcr,adapter,documents,resolveOrigin:async()=>origin});
  await vcr.dataStore.addMember({studyId:study.id,userId:'other',role:'viewer',invitedBy:'owner'});
  await assert.rejects(vcr.jobs.resultOf(study.id,p.task.taskId),{code:'vcr_forbidden'});
  const routes=createVcrRoutes({store:{ensureSessionUser:async req=>({user:{id:req.headers['x-test-user']}}),assertCsrf:async()=>{}},service:vcr.service,vcrStore:vcr.store,jobs:vcr.jobs,config,maxJsonBytes:65536});
  const server=createServer((req,res)=>{void routes(req,res).catch(error=>{res.writeHead(error.status??500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:error.code}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const endpoint=`http://127.0.0.1:${server.address().port}/api/vcr/studies/${study.id}/jobs/${p.task.taskId}/result`;
    const viewer=await fetch(endpoint,{headers:{'x-test-user':'other'}});assert.equal(viewer.status,403);assert.doesNotMatch(await viewer.text(),/priority remains/);
    const owner=await fetch(endpoint,{headers:{'x-test-user':'owner'}});assert.equal(owner.status,200);assert.equal((await owner.json()).data.result.rows[0].clinicalEligibility,'eligible');
    for(const format of ['markdown','json','csv']){
      const report=await invoke('ExecutionPort','report',{taskId:p.task.taskId,resultId:saved.data.resultId,format});
      const address=`http://127.0.0.1:${server.address().port}${report.data.artifact}`;
      const downloaded=await fetch(address,{headers:{'x-test-user':'owner'}});assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.match(await downloaded.text(),/priority remains/);
      const denied=await fetch(address,{headers:{'x-test-user':'other'}});assert.equal(denied.status,403);assert.doesNotMatch(await denied.text(),/priority remains/);
    }
    await assert.rejects(vcr.jobs.resultOf(study.id,p.task.taskId,{actorId:'other'}));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('cancellation invokes the task runtime hook after durable state and reports an unconfirmed stop without undoing cancellation', options, async()=>{
  let called=0;
  const native=createPatientMatchingHostAdapter({vcr,documents,config,onCancel:async(acting,taskId)=>{called++;const stored=await native.repository.get({tenantId:acting.userId,actorId:acting.userId,projectId:acting.projectId,conversationId:acting.rootSessionId},taskId);assert.equal(stored.payload.state,'cancelled');throw new Error('Synthetic runtime has gone away.');}});
  const p=(await native.dispatch({port:'ExecutionPort',operation:'assess',input:{phase:'prepare',protocolVersionId:protocol.id,subjectKeys:[subjectKey]},origin})).data;
  const stopped=await native.dispatch({port:'JobPort',operation:'cancel',input:{taskId:p.task.taskId,jobId:p.task.taskId},origin});
  assert.equal(called,1);assert.equal(stopped.status,'cancelled');assert.equal(stopped.data.notices[0].code,'patient_matching_runtime_cancel_unconfirmed');assert.equal((await native.pending(origin,p.task.taskId)).state,'cancelled');
});

test('cancel preserves partial data, explicit continuation resumes, and withdrawal removes all persisted clinical text', options, async () => {
  const p = await preparedTask();
  await invoke('JobPort','cancel',{taskId:p.task.taskId,jobId:p.task.taskId});
  assert.equal((await save(p)).status,'cancelled');
  assert.equal((await adapter.pending(origin,p.task.taskId)).pending,false);
  await invoke('JobPort','continue',{taskId:p.task.taskId,jobId:p.task.taskId});
  assert.equal((await adapter.pending(origin,p.task.taskId)).pending,true);
  assert.equal((await adapter.pending(origin,p.task.taskId)).continuationEpoch,1);
  await assert.rejects(save(p),{code:'patient_matching_execution_superseded'});
  const resumed=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:p.task.taskId})).data;await save(resumed);
  await vcr.dataPlane.withdrawSubject({studyId:study.id,actor:'owner',subjectKey,reason:'synthetic consent withdrawal'});
  const result = (await invoke('ResultPort','get',{taskId:p.task.taskId})).data;
  assert.deepEqual(result.rows,[]);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_vcr.match_judgments WHERE study_id=$1 AND subject_key=$2',[study.id,subjectKey])).rows[0].n,0);
  assert.doesNotMatch(JSON.stringify((await adapter.repository.get(p.task.scope,p.task.taskId)).payload),/priority remains|age was corrected/);
});

test('real HTTP host returns direct ABI JSON and refuses cross-operation transport projections', options, async () => {
  const handler = createPatientMatchingGatewayHandler(config,{assertActiveModelGatewayToken:()=>({userId:'owner',projectId:'project'})},{vcr,adapter,resolveInvocation:async(_identity,body)=>({...origin,tool:'match_results',args:{taskId:'missing'},callId:body.invocation.callId})});
  async function call(body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req,{method:'POST',url:'/internal/patient-matching/v1/port',headers:{authorization:'Bearer test'}});
    let status,json;await handler(req,{writeHead:code=>{status=code;},end:text=>{json=JSON.parse(text);}});return {status,json};
  }
  const identity=await call({abi:'patient-matching.host.v1',port:'IdentityPort',operation:'resolve',input:{},invocation:{callId:'c'}});
  assert.equal(identity.status,200);assert.equal(identity.json.actorId,'owner');assert.equal(identity.json.data,undefined);
  const denied=await call({abi:'patient-matching.host.v1',port:'PatientDataPort',operation:'read',input:{taskId:'other'},invocation:{callId:'c'}});
  assert.equal(denied.status,403);
});

test('frozen profile and saved ranker stages bind a context draft without replacing relevance by fit',options,async()=>{
 assert.throws(()=>createPatientMatchingHostAdapter({vcr,documents,config:{patientMatchingProfile:{reasoningModel:'deepseek-v4-pro',proEscalation:true}}}),{code:'patient_matching_flash_required'});
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000901','NCT00000902'];
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n* Age at least 18 years.',conditions:[],interventions:[]}});
 try{
  messages.set(++messageSeq,'A new public synthetic patient is 62 years old. Weight 80 kg. Height 2 m.');
  const context=(await invoke('PatientDataPort','context',{messageSeq})).data,newSubject=context.subjectKey;
  const searchId=await vcr.candidateSearches.save(study,{subjectKey:newSubject,request:{condition:'synthetic'},registries:[],rerank:{incomingOrder:ids,finalOrder:[...ids].reverse()},found:2,items:[...ids].reverse().map(registryId=>({registryId}))});
  const p=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,searchId})).data;
  assert.equal(p.task.selectedPairs[0].subjectKey,newSubject);assert.equal(p.task.selectedPairs[0].trialId,ids[1]);
  const first=decisionOf(p),second=decisionOf(p,1);first.recommendation.priority=0.01;second.recommendation.priority=0.99;
  const result=(await save(p,[first,second])).data;
  assert.deepEqual(result.rows.map(row=>row.trialId),[...ids].reverse(),'the ranker owns relevance despite an independent high fit');
  assert.deepEqual(result.stageOrders.incoming.map(value=>JSON.parse(value)[1]),ids);assert.deepEqual(result.stageOrders.rerank,result.finalOrder);
 }finally{vcr.evidence.judgmentRecord=original;}
});
test('native output capacity partitions by24sourceclauses while preserving the whole requested trial scope',options,async()=>{
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000801','NCT00000802','NCT00000803'];
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n'+Array.from({length:10},(_,index)=>`* Age at least18years; clause${index+1}.`).join('\n'),conditions:[],interventions:[]}});
 try{
  messages.set(++messageSeq,'A fresh public synthetic patient is62years old.');const context=(await invoke('PatientDataPort','context',{messageSeq})).data;
  const p=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,registryIds:ids})).data;
  assert.equal(p.task.selectedPairs.length,2);assert.equal(p.trialProfiles.reduce((sum,profile)=>sum+profile.criteria.length,0),20);assert.equal(p.remaining,3);
  const result=(await save(p,[decisionOf(p),decisionOf(p,1)])).data;assert.equal(result.counts.requested,3);assert.equal(result.counts.complete,2);assert.equal(result.counts.pending,1);
  const next=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:p.task.taskId})).data;assert.deepEqual(next.task.selectedPairs,[{subjectKey:context.subjectKey,trialId:ids[2]}]);
 }finally{vcr.evidence.judgmentRecord=original;}
});
test('concurrent lanes of one call hold disjoint pairs, and a lane names only a task its own call opened',options,async()=>{
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000901','NCT00000902','NCT00000903'];
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n'+Array.from({length:20},(_,index)=>`* Age at least18years; clause${index+1}.`).join('\n'),conditions:[],interventions:[]}});
 try{
  messages.set(++messageSeq,'Another public synthetic patient is58years old.');const context=(await invoke('PatientDataPort','context',{messageSeq})).data;
  const call={...origin,callId:'lanes-call',rootCallId:'lanes-call'};
  const first=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,registryIds:ids},call)).data;
  assert.equal(first.kind,'prepared');
  const second=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:1},call)).data;
  const third=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:2},call)).data;
  const held=[first,second,third].map(item=>item.task.selectedPairs.map(pair=>pair.trialId));
  assert.deepEqual(held.flat().sort(),ids,'every pair is held by exactly one lane');
  assert.equal(new Set([first,second,third].map(item=>item.executionId)).size,3);
  assert.equal((await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:3},call)).data.kind,'busy');
  assert.equal((await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:1},call)).data.executionId,second.executionId,'a lane keeps its own prepared execution');
  await assert.rejects(invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:1}),{code:'patient_matching_lane_invalid'},'another call cannot open a lane on this task');
  await assert.rejects(invoke('ExecutionPort','assess',{phase:'prepare',lane:1},call),{code:'patient_matching_lane_invalid'});
  await assert.rejects(invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:99},call),{code:'patient_matching_lane_invalid'});
  const commit=prepared=>invoke('ResultPort','save',{phase:'commit',taskId:prepared.task.taskId,executionId:prepared.executionId,profileDigest:prepared.profileDigest,decisions:[decisionOf(prepared)],native:{childId:'lane-child',messageId:'lane-message',stopReason:'completed'},diagnostics:[]},call);
  for(const prepared of [third,first,second])await commit(prepared);
  const done=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:0},call)).data;
  assert.equal(done.kind,'saved-result');assert.equal(done.result.counts.complete,3);
 }finally{vcr.evidence.judgmentRecord=original;}
});
test('the transport admits a lane preparation naming only its task and a bounded lane, and nothing else beside the original arguments', options, async () => {
  const handler = createPatientMatchingGatewayHandler(config,{assertActiveModelGatewayToken:()=>({userId:'owner',projectId:'project'})},{vcr,adapter:{dispatch:async()=>({status:'complete',summary:'stub',data:{kind:'busy'},artifacts:[]})},resolveInvocation:async(_identity,body)=>({...origin,tool:'match_assess',args:{taskId:'task-x'},callId:body.invocation.callId})});
  async function call(input) {
    const body={abi:'patient-matching.host.v1',port:'ExecutionPort',operation:'assess',input,invocation:{callId:'c'}};
    const req=Readable.from([Buffer.from(JSON.stringify(body))]); Object.assign(req,{method:'POST',url:'/internal/patient-matching/v1/port',headers:{authorization:'Bearer test'}});
    let status;await handler(req,{writeHead:code=>{status=code;},end:()=>{}});return status;
  }
  assert.equal(await call({phase:'prepare',taskId:'task-x'}),200,'the original arguments');
  assert.equal(await call({phase:'prepare',taskId:'task-x',lane:3}),200,'a lane of the same task');
  for(const input of [{phase:'prepare',taskId:'task-y',lane:1},{phase:'prepare',taskId:'task-x',lane:16},{phase:'prepare',taskId:'task-x',lane:-1},{phase:'prepare',taskId:'task-x',lane:'1'},
    {phase:'prepare',taskId:'task-x',lane:1,registryIds:['NCT00000001']},{phase:'prepare',lane:1}])assert.equal(await call(input),403,JSON.stringify(input));
});
test('a lane that still holds an unsaved execution is handed it again, never a wider selection beside it',options,async()=>{
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000911','NCT00000912','NCT00000913','NCT00000914'],clauses={NCT00000913:21,NCT00000914:4};
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n'+Array.from({length:clauses[registryId]??20},(_,index)=>`* Age at least18years; clause${index+1}.`).join('\n'),conditions:[],interventions:[]}});
 try{
  messages.set(++messageSeq,'A third public synthetic patient is49years old.');const context=(await invoke('PatientDataPort','context',{messageSeq})).data;
  const call={...origin,callId:'held-lane-call',rootCallId:'held-lane-call'};
  const first=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,registryIds:ids},call)).data;
  const second=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:1},call)).data;
  const third=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:2},call)).data;
  assert.deepEqual([first,second,third].map(item=>item.task.selectedPairs.map(pair=>pair.trialId)),[[ids[0]],[ids[1]],[ids[2]]]);
  const commit=prepared=>invoke('ResultPort','save',{phase:'commit',taskId:prepared.task.taskId,executionId:prepared.executionId,profileDigest:prepared.profileDigest,decisions:prepared.task.selectedPairs.map((_,index)=>decisionOf(prepared,index)),native:{childId:'lane-child',messageId:'lane-message',stopReason:'completed'},diagnostics:[]},call);
  await commit(first);await commit(third);
  const again=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:first.task.taskId,lane:1},call)).data;
  assert.equal(again.executionId,second.executionId);
  assert.deepEqual(again.task.selectedPairs,second.task.selectedPairs,'the held pairs, not the held pair plus the small trial now free');
 }finally{vcr.evidence.judgmentRecord=original;}
});
test('a long record starts its execution from its newest passages, and a study\'s own assessment guide reaches the task',options,async()=>{
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000921'];
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n* Age at least18years.',conditions:[],interventions:[]}});
 const originalContext=vcr.store.taskContext.bind(vcr.store);
 vcr.store.taskContext=async(...args)=>{const study=await originalContext(...args);return study&&{...study,settings:{matchingGuide:'Label each criterion with the benchmark\'s four labels.',matchingGuideTitle:'Benchmark labels'}};};
 try{
  const lines=Array.from({length:2600},(_,index)=>`Synthetic observation number ${index+1} is recorded here.`);
  messages.set(++messageSeq,`A long public synthetic patient is57years old. ${lines.join(' ')} The newest observation closes the record.`);
  const context=(await invoke('PatientDataPort','context',{messageSeq})).data;
  const call={...origin,callId:'long-record-call',rootCallId:'long-record-call'};
  const prepared=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,registryIds:ids},call)).data;
  const texts=prepared.evidenceBundles[0].patientPassages.map(passage=>passage.text).join(' ');
  assert.match(texts,/The newest observation closes the record/,'the newest passage is in the window');
  assert.ok(prepared.evidenceBundles[0].patientPassages.every(passage=>/^e:\d+\.\d+$/.test(passage.evidenceId)),'short record.sentence evidence ids');
  assert.doesNotMatch(texts,/Synthetic observation number 1 is recorded/,'the oldest passages give way first');
  assert.ok(prepared.evidenceBundles[0].patientPassages.reduce((sum,passage)=>sum+passage.text.length,0)<=80_000);
  assert.deepEqual(prepared.task.guide,{title:'Benchmark labels',text:'Label each criterion with the benchmark\'s four labels.'});
 }finally{vcr.evidence.judgmentRecord=original;vcr.store.taskContext=originalContext;}
});
test('older records outside the window are retrieved per criterion and found by match_evidence phrasings',options,async()=>{
 const original=vcr.evidence.judgmentRecord,ids=['NCT00000922'];
 vcr.evidence.judgmentRecord=async({registryId})=>({status:'ok',trial:{registryId,registry:'clinicaltrials.gov',title:registryId,summary:'Synthetic registration',eligibility:'Inclusion Criteria:\n* Prior myocardial infarction.',conditions:[],interventions:[]}});
 try{
  const filler=Array.from({length:2600},(_,index)=>`Routine observation number ${index+1} is recorded here.`).join(' ');
  messages.set(++messageSeq,`Record date: 2080-02-03\nPAST HISTORY:\nPrior myocardial infarction treated with a stent.\n${filler}\nRecord date: 2093-04-07\nThe newest observation closes the record.`);
  const context=(await invoke('PatientDataPort','context',{messageSeq})).data;
  const call={...origin,callId:'old-record-call',rootCallId:'old-record-call'};
  const prepared=(await invoke('ExecutionPort','assess',{phase:'prepare',taskId:context.taskId,registryIds:ids},call)).data;
  const passages=prepared.evidenceBundles[0].patientPassages;
  assert.ok(passages.some(passage=>/Prior myocardial infarction treated/.test(passage.text)),'the criterion text retrieves the old chunk');
  assert.ok(passages.some(passage=>passage.section==='PAST HISTORY'&&passage.recordDate==='2080-02-03'&&passage.recordIndex===1));
  assert.deepEqual(passages.map(passage=>passage.evidenceId),[...passages.map(passage=>passage.evidenceId)].sort((a,b)=>{const[x,y]=[a,b].map(id=>id.slice(2).split('.').map(Number));return x[0]-y[0]||x[1]-y[1];}),'chronological order');
  const search=queries=>invoke('PatientDataPort','read',{taskId:context.taskId,source:'patient',action:'search',...queries},call);
  const found=(await search({query:'MI',queries:['myocardial infarction','heart attack']})).data.passages;
  assert.ok(found.length>=1&&/myocardial infarction/.test(found[0].text));
  assert.equal(found[0].recordIndex,1);assert.equal(found[0].recordDate,'2080-02-03');
  assert.deepEqual((await search({query:'quantum chromodynamics'})).data.passages,[],'no filler when nothing matches');
 }finally{vcr.evidence.judgmentRecord=original;}
});
