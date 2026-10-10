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
test('a confirmation set that cannot be curated says why: an unknown model release date is not reported as papers still to come',async()=>{
 const prepare=createModuleEvolutionPreparation({service:service(),taskPool:{},policies:{},provenance:{},discovery:null,model:null,
  dependencies:()=>({verifyTask:async()=>({})}),runners:()=>({frontier:async()=>({}),runtime:async()=>({})})});
 const input={moduleId:'frontier',phase:'confirmation',epoch:'e',candidate:{frozenAt:'2026-10-05T00:00:00Z'},freezeAt:'2026-10-05T00:00:00Z'};
 const unknown=await prepare({...input,modelReleasedAt:null});
 assert.deepEqual([unknown.status,unknown.reason],['waiting','environment_date_unknown']);
 // With the date known the curator is able to look, and what it is waiting for is the papers.
 const known=await prepare({...input,modelReleasedAt:'2026-10-01T00:00:00Z'});
 assert.deepEqual([known.status,known.reason],['waiting','fresh_confirmation_tasks_pending']);
 const other=await prepare({...input,moduleId:'runtime',modelReleasedAt:'2026-10-01T00:00:00Z'});
 assert.deepEqual([other.status,other.reason],['waiting','curator_module_unavailable'],'a module the curator does not serve is not waiting for papers either');
});
test('the mission waiting for its confirmation set shows that reason',async()=>{
 const {evolutionServiceFixture}=await import('./helpers/evolutionServiceFixture.mjs');
 const {createEvolutionMissions}=await import('../src/evolutionMissions.mjs');
 const f=evolutionServiceFixture();
 f.service.callbacks.prepareModuleTasks=createModuleEvolutionPreparation({service:f.service,taskPool:{},policies:{},provenance:{},discovery:null,model:null,dependencies:()=>({verifyTask:async()=>({})}),runners:()=>({frontier:async()=>({})})});
 await f.service.save('mission','mission',{moduleId:'frontier',kind:'research',status:'frozen',dependencies:[],epoch:'e',modelReleasedAt:null,successConditions:{slices:[]},candidate:{id:'candidate',frozenAt:'2026-10-05T00:00:00Z',policy:{},proposal:{mechanisms:['m']}}});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{frontier:{enabled:true}}});
 const waiting=await missions.run({missionId:'mission'});
 assert.deepEqual([waiting.payload.status,waiting.payload.reason],['waiting_confirmation','environment_date_unknown']);
});
