import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPatientMatchingDiscovery} from '../src/patientMatchingDiscovery.mjs';
const scope={tenantId:'owner',actorId:'owner',projectId:'project',conversationId:'root'},origin={userId:'owner',projectId:'project',rootSessionId:'root'};
test('fused retrieval is reranked once and saves exactly the candidate order returned to the caller',async()=>{
 let saved,calls=0,authorizationSources;
 const discover=createPatientMatchingDiscovery({vcr:{service:{runtimeRead:async(_study,kind,input)=>kind==='candidates'?{collection:{id:'frozen-collection',revision:'frozen-revision'},candidates:[{registryId:'NCT00000001'},{registryId:'NCT00000002'}],registries:[{status:'ok'}]}:(()=>{assert.equal(input.collection,'frozen-collection');assert.equal(input.collectionRevision,'frozen-revision');return {record:{title:input.registryId,eligibilityText:'Adults'}};})()},candidateSearches:{save:async(_study,r)=>{saved=r;return 'search';}}},index:{query:async()=>({status:'complete',data:{generation:'dense-one',candidates:[{registryId:'NCT00000002'},{registryId:'NCT00000003'}]}})},models:{embeddingProfileDigest:'profile',rerank:async e=>{calls++;authorizationSources=e.input.patientSources;return {status:'complete',data:{model:'qwen3.7-text-rerank',order:['NCT00000003','NCT00000002','NCT00000001']}};}}});
 const data=(await discover({scope,origin,study:{id:'study'},meta:{taskId:'task',contextSubjectKey:'person',selectedPairs:[]},input:{query:'lung cancer',limit:2},patient:{sources:[{sourceId:'original'}],passages:[{text:'preserved private record'}]}})).data;
 assert.equal(calls,1);assert.deepEqual(authorizationSources,[{sourceId:'original'}]);assert.deepEqual(data.candidates.map(r=>r.registryId),saved.items.slice(0,2).map(r=>r.registryId));assert.deepEqual(saved.rerank.finalOrder,saved.items.map(r=>r.registryId));assert.doesNotMatch(JSON.stringify(saved.request),/preserved private record/);assert.equal(data.retrieved,3);
});
test('optional index failure retains usable registry candidates and protocol discovery uses the owned roster',async()=>{
 let retrieval=0;
 const vcr={documents:{roster:async()=>[{subjectKey:'person'},{subjectKey:'person'},{subjectKey:'other'}]},service:{runtimeRead:async()=>{retrieval++;return {candidates:[{registryId:'NCT00000001'}]};}},candidateSearches:{save:async()=> 'search'}};
 const discover=createPatientMatchingDiscovery({vcr,index:{query:async()=>{throw new Error('outage');}},models:{embeddingProfileDigest:'profile'}});
 const trial=await discover({scope,origin,study:{id:'study'},meta:{taskId:'task',selectedPairs:[]},input:{query:'condition'}});assert.equal(trial.data.candidates.length,1);assert.equal(trial.data.coverage.dense.status,'unsupported');
 const people=await discover({scope,origin,study:{id:'study'},meta:{protocolVersionId:'protocol'},input:{}});assert.deepEqual(people.data.people,[{subjectKey:'person',label:'person'},{subjectKey:'other',label:'other'}]);assert.equal(people.data.available,2);assert.equal(retrieval,2,'one candidate retrieval and one full-source read; protocol discovery adds none');
});
test('long or blank discovery questions stop before source/model work and preserve the task context',async()=>{
 let reads=0,models=0;
 const discover=createPatientMatchingDiscovery({vcr:{service:{runtimeRead:async()=>{reads++;throw new Error('must not read');}}},models:{rerank:async()=>{models++;}}});
 for(const query of [' '.repeat(20),'a'.repeat(201),'病'.repeat(201)]){
  const answer=await discover({scope,origin,study:{id:'study'},meta:{taskId:'preserved-task',selectedPairs:[]},input:{query}});assert.equal(answer.status,'unsupported');assert.equal(answer.data.maxQueryCharacters,200);
 }
 assert.equal(reads,0);assert.equal(models,0);
});
