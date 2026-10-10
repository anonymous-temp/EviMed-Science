import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vcrMatchingSeam,vcrMatchingExecutor} from '../src/vcrComposition.mjs';
const study={id:'study',userId:'owner'};
function fixture(count=2){
 const snapshots=new Map();let table={available:true,snapshotId:'table1',sha256:'a'.repeat(64),header:['USUBJID','age'],columns:[{name:'age',type:'integer',unit:'year'}],rows:Array.from({length:count},(_,i)=>[`p${String(i).padStart(5,'0')}`,'44'])};
 const criteria=[{id:'adult',kind:'inclusion',criterionType:'demographic',requirement:{op:'compare',variable:'age',comparator:'gte',value:18}}];
 const matchStore={latestProtocol:async()=>({id:'protocol'}),listCriteria:async()=>criteria,listFacts:async()=>[],latestLanguageJudgments:async()=>new Map(),candidateSubjects:async()=>[],saveMatchingSnapshot:async row=>snapshots.set(row.id,row.payload),matchingSnapshot:async(_study,id)=>snapshots.get(id),matchingFactsByIds:async()=>[],languageJudgmentsByIds:async()=>[],recordMatchingOutcomes:async()=>{}};
 const subjectTable={read:async()=>table};
 const seam=vcrMatchingSeam({matchStore,store:{},subjectTable,now:()=>new Date('2026-10-10')});
 const executor=vcrMatchingExecutor({matchStore,store:{studyById:async()=>study},subjectTable});
 return{seam,snapshots,setTable:value=>table=value,table:()=>table,run:async built=>executor({job:{id:'job',studyId:study.id,scenario:built.scenario,inputs:built.inputs},onProgress:async()=>{}})};
}
test('merged matching freezes all table candidates before paginating and keeps table-only evidence private',async()=>{
 const f=fixture(5001),first=await f.seam.matchScenario(study);
 const result=await f.run(first);
 assert.equal(result.assessments.length,5000);assert.equal(result.diagnostics.requestedSubjects,5001);assert.equal(result.diagnostics.nextOffset,5000);
 assert.equal(result.assessments[0].source,'subject_table');assert.equal(result.assessments[0].summary,'eligible');
 const next=await f.seam.matchScenario(study,{snapshotId:result.diagnostics.inputSnapshotId,offset:5000});
 const second=await f.run(next);assert.equal(second.assessments.length,1);assert.equal(second.assessments[0].subjectKey,'p05000');
 assert.equal(second.diagnostics.nextOffset,null);
});
test('table cell or field-definition drift refuses a frozen result, while a refused read leaves the roster visible as unknown',async()=>{
 const f=fixture(),built=await f.seam.matchScenario(study),original=f.table();
 f.setTable({...original,sha256:'b'.repeat(64)});await assert.rejects(f.run(built),{code:'vcr_matching_input_changed'});
 f.setTable({...original,columns:[{name:'age',type:'integer',unit:'day'}]});await assert.rejects(f.run(built),{code:'vcr_matching_input_changed'});
 f.setTable({available:false,reason:'vcr_access_denied'});const result=await f.run(built);
 assert.equal(result.assessments.length,2);assert.ok(result.assessments.every(row=>row.summary==='insufficient_evidence'));
 assert.deepEqual(result.diagnostics.subjectTable,{available:false,reason:'vcr_access_denied'});
});
