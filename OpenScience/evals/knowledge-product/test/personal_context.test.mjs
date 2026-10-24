import test from 'node:test';
import assert from 'node:assert/strict';
import benchmark from '../cases.json' with {type:'json'};
import superseded from '../superseded/cases-v1-invalid-document-memory.json' with {type:'json'};
import {judgedObservation} from '../automatic_judge.mjs';
import {validatePersonalContexts,contextMaterials,seedMemoryProof,preparationCounts,seedAuthoredMemory,personalRetrievalProof,collectNativeMemoryContext} from '../personal_context.mjs';
test('main benchmark separates authored personal memory from documents and requires both combined components',()=>{
 assert.equal(validatePersonalContexts(benchmark),true);
 assert.throws(()=>validatePersonalContexts(superseded),/authored/);
 assert.equal(preparationCounts(benchmark).bothArms.memorySeeds,76);
 for(const c of benchmark.cases.filter(c=>c.stratum!=='lifecycle'&&c.evaluation.substrate==='memory')){
  assert.deepEqual(c.sources,[]);assert.ok(c.memorySeeds.length);assert.equal(contextMaterials(benchmark,[c]).originals.length,0);
 }
 const combined=benchmark.cases.find(c=>c.evaluation?.substrate==='combined'&&c.stratum!=='lifecycle');
 assert.ok(combined.sources.length&&combined.memorySeeds.length);
 assert.ok(combined.memoryDependency.criterion.includes('neither component alone'));
 const bad=structuredClone(benchmark);const c=bad.cases.find(c=>c.memorySeeds?.length);c.memorySeeds[0].kind='document';assert.throws(()=>validatePersonalContexts(bad),/authored/);
});
test('freeze provenance requires every authored value in actual native memory, permits merged files and paraphrases',()=>{
 const seeds=[{id:'one',kind:'user-authored',statement:'My standing heading is Decision brief.',requiredValues:['Decision brief']},{id:'two',kind:'user-authored',statement:'Use EUR for my forecasts.',requiredValues:['EUR'],valueVariants:[['euros']]}];
 assert.throws(()=>seedMemoryProof(seeds,{records:[{id:'unrelated',value:'something else'}]}),/represented/);
 assert.throws(()=>seedMemoryProof(seeds,{records:[{id:'fake',value:'Decision brief; EUR'}]}),/native/);
 const proof=seedMemoryProof(seeds,{records:[{id:'viking://user/owned/memories/preferences/report.md',value:'Forecast currency: euros. Preferred report title: Decision brief.'}]});
 assert.equal(proof.length,2);assert.equal(proof[0].uri,proof[1].uri);
});

test('the actual seeding adapter sends only authored statements, never material or distractors',async()=>{
 const cases=benchmark.cases.filter(c=>c.evaluation?.substrate==='memory'&&c.evaluation.size==='small');
 const plan=contextMaterials(benchmark,cases),calls=[];
 await seedAuthoredMemory(async(method,route,body)=>{calls.push({method,route,body});return {pending:{id:'archive-'+calls.length}};},{projectId:'owned',seeds:plan.seeds});
 assert.equal(calls.length,plan.seeds.length);
 assert.ok(calls.every(c=>c.route==='/api/memory/remember'&&!c.body.text.includes('Original source')&&!c.body.text.includes('Warehouse inventory')));
 await assert.rejects(seedAuthoredMemory(async()=>{throw Error('must not send');},{projectId:'owned',seeds:[{kind:'document',statement:'Trial result'}]}),/authored/);
});
test('memory evidence must expose the expected native URI and values, not an unrelated successful recall',()=>{
 const c={memorySeeds:[{id:'currency',requiredValues:['EUR']}]},e={memoryFreeze:{provenance:[{seedId:'currency',uri:'viking://user/owned/memories/preferences/currency.md'}]},retrieval:[{name:'mcp__openviking__search',status:'completed',output:{text:'EUR',uri:'viking://user/other/memories/preferences/currency.md'}}]};
 assert.throws(()=>personalRetrievalProof(c,e),/provenance/);
 e.retrieval[0].output.uri=e.memoryFreeze.provenance[0].uri;assert.equal(personalRetrievalProof(c,e).length,1);
});

test('producer-owned native profile context qualifies; assistant-authored lookalike does not',()=>{
 const c={memorySeeds:[{id:'s',requiredValues:['EUR']}]},e={memoryFreeze:{provenance:[{seedId:'s',uri:'viking://user/owned/memories/preferences/currency.md'}]},retrieval:[]};
 e.nativeMemoryContext=collectNativeMemoryContext([{role:'assistant',source:{kind:'plugin:openviking-memory'},parts:[{type:'text',text:'EUR'}]}]);assert.throws(()=>personalRetrievalProof(c,e),/provenance/);
 e.nativeMemoryContext=collectNativeMemoryContext([{role:'user',source:{kind:'plugin:openviking-memory',form:'instructions'},parts:[{type:'text',text:'Currency EUR'}]}]);assert.equal(personalRetrievalProof(c,e)[0].via,'native-profile-context');
});

test('combined scoring cannot pass on knowledge alone and memory-only has no fabricated source citation',async()=>{
 const c=benchmark.cases.find(c=>c.evaluation?.substrate==='combined'&&!c.unanswerable),seed=c.memorySeeds[0],uri='viking://user/owned/memories/preferences/heading.md';
 const evidence={arm:'candidate',repetition:1,run:{id:'real-fixture-run'},digest:{reply:'External knowledge answer only'},runtime:{model:'fixture'},memoryFreeze:{provenance:[{seedId:seed.id,uri}]},retrieval:[{name:'mcp__openviking__read',status:'completed',input:{uri},output:{text:seed.statement}}]};
 const judge=async input=>({ok:true,malformed:false,score:input.component==='personal-memory'&&!input.answer.includes(seed.answerValues[0])?0:1,points:[]});
 const without=await judgedObservation(c,evidence,{judge});assert.equal(without.components.knowledge,1);assert.equal(without.components.memory,0);assert.equal(without.score,0);
 evidence.digest.reply+=' '+seed.answerValues[0];assert.equal((await judgedObservation(c,evidence,{judge})).score,1);
 const m=benchmark.cases.find(c=>c.evaluation?.substrate==='memory'),s=m.memorySeeds[0];evidence.digest.reply=s.answerValues[0];evidence.memoryFreeze.provenance=[{seedId:s.id,uri}];evidence.retrieval[0].output.text=s.statement;
 const row=await judgedObservation(m,evidence,{judge});assert.deepEqual(row.citedSources,[]);assert.equal(row.citationReview.unresolved,false);assert.equal(row.memoryProvenance[0].uri,uri);
 evidence.retrieval[0].output.code='memory_index_unavailable';await assert.rejects(judgedObservation(m,evidence,{judge}),/provenance/);
});

test('memory-only uses the existing semantic judge for Chinese paraphrases and rejects unrelated answers',async()=>{
 const c=benchmark.cases.find(c=>c.id==='general-handoff'),seed=c.memorySeeds[0],uri='viking://user/owned/memories/preferences/handoff.md';
 const e={arm:'candidate',repetition:1,run:{id:'semantic-fixture'},digest:{reply:'把负责人放在截止日期前面'},runtime:{model:'fixture'},memoryFreeze:{provenance:[{seedId:seed.id,uri}]},retrieval:[{name:'mcp__openviking__read',status:'completed',input:{uri},output:{text:seed.statement}}]};
 const judge=async input=>({ok:true,malformed:false,score:input.answer==='把负责人放在截止日期前面'?1:0,points:[]});
 assert.equal((await judgedObservation(c,e,{judge})).score,1);
 e.digest.reply='The weather is pleasant.';assert.equal((await judgedObservation(c,e,{judge})).score,0);
});

test('real runtime normalizer retains the exact native plugin producer as a string',async()=>{
 const {normalizeTranscript}=await import('../../../apps/server/src/dshRuntimeAdapter.mjs');
 const transcript=normalizeTranscript('owned',[{type:'user/message',seq:1,time:1,data:{role:'user',source:{kind:'plugin:openviking-memory',plugin:'openviking-memory',form:'instructions'},content:[{type:'text',text:'Saved forecast currency: EUR'}]}}]);
 assert.equal(transcript.messages[0].source,'plugin:openviking-memory');
 const context=collectNativeMemoryContext(transcript.messages);assert.equal(context.length,1);
 const c={memorySeeds:[{id:'currency',requiredValues:['EUR']}]};
 assert.equal(personalRetrievalProof(c,{memoryFreeze:{provenance:[{seedId:'currency',uri:'viking://user/owned/memories/preferences/currency.md'}]},nativeMemoryContext:context})[0].via,'native-profile-context');
 for(const source of ['user','runtime-context','plugin:evimed-capsule'])assert.deepEqual(collectNativeMemoryContext([{...transcript.messages[0],source}]),[]);
});
