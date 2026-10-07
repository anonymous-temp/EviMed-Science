import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionTransfer} from '../src/evolutionTransfer.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
const dependencies=f=>({service:f.service,taskPool:createEvolutionTaskPool({service:f.service}),missions:{opportunity:async input=>({id:input.id}),create:async input=>({id:input.id,payload:input}),queue:async()=>{}},adapters:{tools:{enabled:true},frontier:{enabled:true},runtime:{enabled:true}}});
test('source and second promotion need a distinct held-out third module before sharing',async()=>{
 const f=evolutionServiceFixture(),transfer=createEvolutionTransfer(dependencies(f));
 await f.service.save('archive','source',{moduleId:'tools',candidate:{proposal:{mechanisms:['denominator']},policy:{}},status:'promoted',verdictId:'source-v'});
 await f.service.save('candidate-verdict','source-v',{moduleId:'tools',candidateId:'source',promote:true,confirmatory:true,receiptValid:true});
 assert.equal((await transfer.assess({candidateId:'source'})).payload.shared,false);
 await f.service.save('mission','transfer-m',{sourceCandidateIds:['source'],moduleId:'frontier'});
 await f.service.save('candidate-verdict','transfer-v',{candidateId:'transferred',missionId:'transfer-m',moduleId:'frontier',promote:true,confirmatory:true,receiptValid:true});
 assert.deepEqual((await transfer.assess({candidateId:'source'})).payload.promotedModules,['tools']);
 await f.service.save('archive','transferred',{moduleId:'frontier',status:'promoted',verdictId:'transfer-v'});
 assert.deepEqual((await transfer.assess({candidateId:'source'})).payload.promotedModules,['tools','frontier']);
 assert.equal((await transfer.assess({candidateId:'source'})).payload.shared,false);
 await f.service.save('mission','audit-m',{sourceCandidateIds:['source'],moduleId:'runtime'});
 await f.service.save('candidate-verdict','audit-v',{missionId:'audit-m',moduleId:'runtime',promote:false,auditOnly:true,evidenceTier:'exact',confirmatory:true,receiptValid:true,score:0.79,baseline:0.8,delta:0.02});
 assert.equal((await transfer.assess({candidateId:'source'})).payload.shared,true);
});
test('tool archive identity joins its serving verdict and preserves sole confirmed coverage',async()=>{
 const f=evolutionServiceFixture(),deps=dependencies(f),created=[];
 deps.missions.create=async input=>{created.push(input);return{id:input.id,payload:input};};
 const transfer=createEvolutionTransfer(deps);
 await f.service.save('archive','tool-archive',{moduleId:'tools',candidate:{id:'serving-tool',proposal:{mechanisms:['m']}},status:'promoted',verdictId:'published'});
 await f.service.save('candidate-verdict','published',{moduleId:'tools',candidateId:'serving-tool',archiveId:'tool-archive',promote:true,confirmatory:true,receiptValid:true});
 assert.deepEqual((await transfer.assess({candidateId:'tool-archive'})).payload.promotedModules,['tools']);
 await f.service.save('supported-family','sole',{candidateId:'serving-tool',moduleId:'tools',taskFamily:{operation:'transform'},verdictId:'published'});
 for(let i=0;i<4;i++)await f.service.save('candidate-verdict',`prune-v${i}`,{candidateId:'serving-tool',archiveId:'tool-archive',mechanismContributions:{m:0},at:`2026-10-0${i+1}`});
 await transfer.monthlyPrune({month:'2026-10'});
 assert.equal(created.length,0);
});
test('generated truth and abstention separate two wrong solutions without generating medical facts',async()=>{
 const f=evolutionServiceFixture(),transfer=createEvolutionTransfer(dependencies(f));
 const task=await transfer.generateTasks({templateId:'unit-conversion',moduleId:'tools',parameters:{value:2,from:'g',to:'mg'}});
 assert.equal(task.payload.correct,2000);assert.equal(task.payload.truthProof.wrongRejected,2);assert.equal(task.payload.scope,'generated');
 const unknown=await transfer.generateTasks({templateId:'unit-conversion',moduleId:'tools',parameters:{value:2,from:'unknown',to:'mg'}});
 assert.equal(unknown.payload.correct,null);assert.equal(unknown.payload.abstentionExpected,true);
 await assert.rejects(transfer.generateTasks({templateId:'made-up-medical-truth',moduleId:'tools'}));
});
test('combination and pruning enqueue reevaluated candidates; unique coverage is protected',async()=>{
 const f=evolutionServiceFixture(),created=[],deps=dependencies(f);deps.missions.create=async input=>{created.push(input);return{id:input.id,payload:input};};
 const transfer=createEvolutionTransfer(deps);
 for(const id of ['a','b'])await f.service.save('archive',id,{moduleId:'tools',candidate:{proposal:{mechanisms:['m']}},status:'promoted',uniqueCoverage:id==='b'});
 const combined=await transfer.proposeCombination({parentIds:['a','b'],moduleId:'tools'});assert.equal(combined.payload.combinationRequiresReevaluation,true);
 for(let i=0;i<4;i++)await f.service.save('candidate-verdict',`v${i}`,{candidateId:'a',mechanismContributions:{m:0},at:`2026-10-0${i+1}`});
 await transfer.monthlyPrune({month:'2026-10'});
 assert.equal(created.filter(item=>item.kind==='prune').length,1);assert.deepEqual(created.find(item=>item.kind==='prune').sourceCandidateIds,['a']);
});
test('an improving audit remains held out, and sole independently confirmed family coverage prevents pruning',async()=>{
 const f=evolutionServiceFixture(),deps=dependencies(f),created=[];deps.missions.create=async input=>{created.push(input);return{id:input.id,payload:input};};
 const transfer=createEvolutionTransfer(deps);
 await f.service.save('archive','source',{moduleId:'tools',candidate:{proposal:{mechanisms:['m']}},status:'promoted',verdictId:'source-v'});
 await f.service.save('archive','other',{moduleId:'frontier',status:'promoted',verdictId:'other-v'});
 for(const [id,moduleId,auditOnly] of [['source-v','tools',false],['other-v','frontier',false],['audit-v','runtime',true]]){
  if(id!=='source-v')await f.service.save('mission',id+'-mission',{sourceCandidateIds:['source'],moduleId});
  await f.service.save('candidate-verdict',id,{candidateId:id==='source-v'?'source':'other',missionId:id+'-mission',moduleId,auditOnly,promote:true,confirmatory:true,receiptValid:true,evidenceTier:'exact',score:0.9,baseline:0.8,delta:0.02});
 }
 assert.equal((await transfer.assess({candidateId:'source'})).payload.shared,true);
 await f.service.save('supported-family','sole-family',{candidateId:'source',moduleId:'tools',taskFamily:{operation:'transform'},verdictId:'source-v'});
 for(let i=0;i<4;i++)await f.service.save('candidate-verdict',`prune-v${i}`,{candidateId:'source',mechanismContributions:{m:0},at:`2026-10-0${i+1}`});
 await transfer.monthlyPrune({month:'2026-10'});assert.equal(created.filter(row=>row.kind==='prune').length,0);
});
