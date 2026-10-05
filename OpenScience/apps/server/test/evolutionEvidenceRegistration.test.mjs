import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionEvidenceRegistration } from '../src/evolutionEvidenceRegistration.mjs';

function fixture({ observedUse = true, targetVerifier = true } = {}) {
  const records = new Map(), events = [], sha256 = 'a'.repeat(64);
  const service = { documents:{database:{query:async()=>({rows:[{id:'request',model:'deepseek-flash',runId:'dispatch'}]})}}, now:()=>new Date('2026-10-04T12:00:00Z'),get:async()=>({payload:{artifactDigest:'pin'}}),list:async()=>observedUse?[{payload:{projectId:'evolution-eval-proof',runId:'run',toolId:'tool',digest:'pin',result:{ok:true}}}]:[],save:async(type,id,payload)=>{const row={id,payload};records.set(id,row);return row;},ingestEvent:async event=>{events.push(event);return event;} };
  const dependency = { service,integration:{freezeProspective:async input=>({id:'registration',payload:{...input,frozenAt:service.now().toISOString()}})},store:{userById:async()=>({id:'operator'}),requireProject:async()=>({id:'evolution-eval-proof'})},agentRuns:{list:async()=>[{id:'run',dispatchId:'dispatch',status:'succeeded',sessionId:'session'}]},readTranscript:async()=>({header:{completeness:'complete'},messages:[{role:'assistant',parts:[{type:'text',text:'Actual prediction: relative risk will decrease.'}]}]}),sourceService:{get:async()=>({id:'source',projectId:'evolution-eval-proof',payload:{fingerprint:{sha256}}})},readPreservedSource:async()=>({sha256,text:'deepseek-flash Release 2026-01-01. Target has not reported its result. Question XYZ cutoff 2026-01-01 new publication 2026-10-02.'}),...(targetVerifier?{verifyTargetUnpublished:async()=>({unpublished:true,targetIdentity:'target',evidenceId:'registry',checkedAt:'2026-10-04T11:59:59Z'})}:{}) };
  const input={projectId:'evolution-eval-proof',runId:'run',toolId:'tool',artifactDigest:'pin',question:'Question XYZ',prediction:'relative risk will decrease.',targetIdentity:'target',preRegisteredProtocol:'Exact frozen independent protocol',modelReleaseEvidence:{sourceId:'source',sha256,model:'deepseek-flash',quote:'deepseek-flash Release 2026-01-01.',releasedAt:'2026-01-01'},targetAvailabilityEvidence:{sourceId:'source',sha256,quote:'Target has not reported its result.'}};
  return {api:createEvolutionEvidenceRegistration(dependency),input,records,events,dependency};
}

test('actual completed prediction text and actual pinned call are required; unavailable target proof stays pending',async()=>{
  const good=fixture();const row=await good.api.registerProspective({id:'operator'},good.input);
  assert.equal(row.payload.registrationEligible,true);assert.match(row.payload.transcriptHash,/^[a-f0-9]{64}$/);assert.equal(good.events[0].type,'prospective-registration');
  const unavailable=fixture({targetVerifier:false});assert.equal((await unavailable.api.registerProspective({id:'operator'},unavailable.input)).payload.status,'waiting-provenance');
  const unused=fixture({observedUse:false});assert.equal((await unused.api.registerProspective({id:'operator'},unused.input)).payload.registrationEligible,false);
  await assert.rejects(good.api.registerProspective({id:'operator'},{...good.input,prediction:'Invented independent prediction'}),{code:'evolution_evaluation_invalid'});
});
test('source metadata cannot substitute for preserved hash and exact quoted dates',async()=>{
  const {api,input,events}=fixture();
  await assert.rejects(api.registerProspective({id:'operator'},{...input,modelReleaseEvidence:{...input.modelReleaseEvidence,sha256:'b'.repeat(64)}}),{code:'evolution_evaluation_invalid'});
  const event=await api.registerMetaUpdate({id:'operator'},{projectId:input.projectId,question:'Question XYZ',originalMeta:{searchCutoff:'1999-01-01',evidence:{...input.modelReleaseEvidence,quote:'Question XYZ cutoff 2026-01-01'}},newEvidence:{firstPublicAt:'2026-10-02',evidence:{...input.modelReleaseEvidence,quote:'Question XYZ cutoff 2026-01-01 new publication 2026-10-02.'}}});
  assert.equal(event.originalMeta,null);assert.equal(events.at(-1).type,'meta-evidence-update');
});

test('verified model release unlocks existing temporal candidates only for the actual development pin', async () => {
  const f = fixture(), tool = { id: 'tool', revision: 1, payload: { artifactDigest: 'pin', frozenAt: '2026-10-01', lineage: { developmentRuns: ['run'], developmentProjectId: 'evolution-eval-proof' } } };
  const observation = { id: 'temporal', payload: { kind: 'temporal-evaluation-candidate', status: 'waiting', toolId: 'tool', artifactDigest: 'pin', firstPublicAt: '2026-10-03', firstPublicEvidenceId: 'official-index' } };
  f.dependency.service.get = async id => f.records.get(id) ?? (id === 'tool' ? tool : null);
  f.dependency.service.list = async type => type === 'observation' ? [observation] : [];
  f.dependency.service.withLock = async (_key, callback) => callback();
  f.dependency.service.documents = { database: { query: async () => ({ rows: [{ model: 'deepseek-flash' }] }) } };
  f.dependency.readPreservedSource = async () => ({ sha256: f.input.modelReleaseEvidence.sha256, text: 'deepseek-flash released 2026-01-01.' });
  const api = createEvolutionEvidenceRegistration(f.dependency);
  const evidence = { ...f.input.modelReleaseEvidence, model: 'deepseek-flash', quote: 'deepseek-flash released 2026-01-01.' };
  const saved = await api.registerToolProvenance({ id: 'operator' }, { projectId: f.input.projectId, toolId: 'tool', artifactDigest: 'pin', modelReleaseEvidence: evidence });
  assert.equal(saved.payload.modelReleasedAt, '2026-01-01');
  assert.equal(f.records.get('temporal').payload.status, 'awaiting-gold');
  await assert.rejects(api.registerToolProvenance({ id: 'operator' }, { projectId: f.input.projectId, toolId: 'tool', artifactDigest: 'other', modelReleaseEvidence: evidence }), { code: 'evolution_evaluation_invalid' });
});


test('release provenance matches the actual settled model with project, owner, purpose and dispatch constraints', async () => {
  const f = fixture(); let query;
  f.dependency.service.documents.database.query = async (sql, args) => {
    query = {sql,args}; return {rows:[{id:'request',model:'deepseek-flash',runId:'dispatch'}]};
  };
  await f.api.registerProspective({id:'operator'}, f.input);
  assert.match(query.sql, /run_id=ANY/); assert.match(query.sql, /purpose='evolution'/); assert.match(query.sql, /status='settled'/);
  assert.deepEqual(query.args, ['operator','evolution-eval-proof',['run','dispatch']]);
  f.dependency.readPreservedSource = async () => ({sha256:f.input.modelReleaseEvidence.sha256,text:'qwen-plus Release 2026-01-01.'});
  const mismatched = await createEvolutionEvidenceRegistration(f.dependency).registerProspective({id:'operator'}, {...f.input,modelReleaseEvidence:{...f.input.modelReleaseEvidence,model:'qwen-plus',quote:'qwen-plus Release 2026-01-01.'}});
  assert.equal(mismatched.payload.status,'waiting-provenance');
  f.dependency.service.documents.database.query = async () => ({rows:[]});
  assert.equal((await f.api.registerProspective({id:'operator'}, f.input)).payload.status,'waiting-provenance');
});

test('completed control snapshot survives live ledger retention without bypassing ownership or successful use provenance', async () => {
  const f = fixture(); const transcript = await f.dependency.readTranscript();
  const snapshot = {userId:'operator',projectId:f.input.projectId,runId:'run',runStatus:'succeeded',transcript,executionMetadata:{
    uses:[{id:'use-receipt',payload:{userId:'operator',projectId:f.input.projectId,runId:'run',toolId:'tool',digest:'pin',result:{ok:true}}}],
    modelFamily:'deepseek',modelRequests:[{id:'settled-receipt',model:'deepseek-flash',runId:'dispatch'}]}};
  const record = {userId:'operator',projectId:f.input.projectId,producerRunId:'run',toolId:'tool',artifactDigest:'pin',prediction:f.input.prediction,executionEvidence:{id:'snapshot'}};
  f.dependency.executionEvidence = {read:async()=>snapshot};
  f.dependency.agentRuns.list = async()=>{throw new Error('retained run ledger must not be required');};
  f.dependency.service.list = async()=>{throw new Error('retained use ledger must not be required');};
  f.dependency.readTranscript = async()=>{throw new Error('retained transcript must not be required');};
  let authorized = false;
  f.dependency.store.requireProject = async(user,id)=>{assert.equal(user.id,'operator');assert.equal(id,f.input.projectId);authorized=true;return{id};};
  const api = createEvolutionEvidenceRegistration(f.dependency);
  assert.equal((await api.verifyPinnedRun(record)).ok,true); assert.equal(authorized,true);
  snapshot.executionMetadata.uses[0].payload.result.ok=false;
  assert.equal((await api.verifyPinnedRun(record)).status,'waiting-provenance');
  snapshot.executionMetadata.uses[0].payload.result.ok=true;
  snapshot.executionMetadata.modelRequests=[];
  assert.equal((await api.verifyPinnedRun(record)).status,'waiting-provenance');
  f.dependency.store.requireProject=async()=>{throw new Error('unauthorized project');};
  await assert.rejects(createEvolutionEvidenceRegistration(f.dependency).verifyPinnedRun(record),/unauthorized project/);
});

test('waiting registration can admit later proof without changing frozen producer or prediction', async () => {
  const f=fixture();let snapshots=0;
  f.dependency.integration.freezeProspective=async input=>f.records.get('registration')??{id:'registration',payload:{...input,frozenAt:'2026-10-04T11:00:00Z'}};
  f.dependency.executionEvidence={preserve:async()=>++snapshots===1?null:{id:'completion-snapshot',sealedAt:'2026-10-04T10:59:00Z'}};
  f.dependency.service.documents.database.query=async()=>({rows:[]});
  const first=await createEvolutionEvidenceRegistration(f.dependency).registerProspective({id:'operator'},f.input);
  assert.equal(first.payload.status,'waiting-provenance');
  f.dependency.service.documents.database.query=async()=>({rows:[{id:'actual-request',model:'deepseek-flash',runId:'dispatch'}]});
  const second=await createEvolutionEvidenceRegistration(f.dependency).registerProspective({id:'operator'},f.input);
  assert.equal(second.payload.registrationEligible,true);assert.equal(second.payload.frozenAt,first.payload.frozenAt);
  assert.equal(second.payload.predictionHash,first.payload.predictionHash);assert.equal(second.payload.executionEvidence.id,'completion-snapshot');
  second.payload.registrationEligible=false;second.payload.producerRunId='different';
  await assert.rejects(createEvolutionEvidenceRegistration(f.dependency).registerProspective({id:'operator'},f.input),/immutable/);
});
