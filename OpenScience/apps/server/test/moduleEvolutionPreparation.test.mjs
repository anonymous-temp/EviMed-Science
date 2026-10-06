import test from 'node:test';
import assert from 'node:assert/strict';
import {createModuleEvolutionPreparation} from '../src/moduleEvolutionPreparation.mjs';
import {createModuleEvolutionOfflineEvaluators} from '../src/moduleEvolutionOfflineEvaluators.mjs';
import {calibrateModuleSourceJudge} from '../src/moduleEvolutionCalibration.mjs';

function service(){const rows=new Map();return {rows,now:()=>new Date('2026-10-06'),owner:async()=> 'owner',get:async id=>rows.get(id),list:async()=>[],save:async(type,id,payload)=>{const row={id,payload};rows.set(id,row);return row;}};}
test('development known-correct marks come only from measured baseline and receipt prevents repeated paid calls',async()=>{
 const store=service(),tasks=[];let calls=0;
 const prepare=createModuleEvolutionPreparation({service:store,taskPool:{add:async task=>tasks.push(task)},policies:{resolve:async()=>({policy:{}})},provenance:{},discovery:null,model:null,
 dependencies:()=>({readDevelopmentTasks:async()=>[{id:'a'},{id:'b'},{id:'c'}]}),runners:()=>({frontier:async()=>{calls++;return {units:[{id:'a',score:1},{id:'b',score:1},{id:'c',score:0}],evaluatorVersion:'checked'};}})});
 assert.equal((await prepare({moduleId:'frontier',phase:'development',epoch:'e'})).status,'ready');
 assert.deepEqual(tasks.map(item=>item.baselineKnownCorrect),[true,true,false]);
 assert.equal((await prepare({moduleId:'frontier',phase:'development',epoch:'e'})).status,'ready');assert.equal(calls,1);
});
test('curation waits without independently configured reviewer',async()=>{
 const prepare=createModuleEvolutionPreparation({service:service(),taskPool:{},policies:{},provenance:{},discovery:null,model:null,dependencies:()=>({}),runners:()=>({geo:async()=>({})})});
 assert.equal((await prepare({moduleId:'geo',phase:'confirmation'})).reason,'independent_curator_review_unavailable');
});
test('source evaluator executes existing cell parser and independently rejects incorrect absolute reference',async()=>{
 const runner=createModuleEvolutionOfflineEvaluators().sources;
 const batch=[{id:'csv',format:'csv',sourceText:'dose,unit\n5,mg',expectedCells:[{address:'2:1',text:'5'},{address:'2:2',text:'mg'}]}];
 const good=await runner({pool:'development',batch});assert.equal(good.units[0].score,1);
 const wrong=await runner({pool:'development',batch:[{...batch[0],expectedCells:[{address:'2:1',text:'10'}]}]});assert.equal(wrong.units[0].score,0);
 assert.equal(createModuleEvolutionOfflineEvaluators().runtime,undefined);
});
test('fidelity calibration requires measured agreement on both positive and wrong absolute dose anchors',async()=>{
 const calibrated=await calibrateModuleSourceJudge({moduleId:'frontier',input:{},judgeFrontier:async input=>({supported:!input.output.text.includes('25 mg')})});
 assert.equal(calibrated.anchorCalibrated,true);assert.equal(calibrated.units.length,2);
 assert.equal((await calibrateModuleSourceJudge({moduleId:'frontier',input:{},judgeFrontier:async()=>({supported:true})})).anchorCalibrated,false);
});
