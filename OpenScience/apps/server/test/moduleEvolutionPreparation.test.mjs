import test from 'node:test';
import assert from 'node:assert/strict';
import {createModuleEvolutionPreparation,MODULE_TASK_EXTRACTION_INSTRUCTIONS} from '../src/moduleEvolutionPreparation.mjs';
import {createModuleEvolutionOfflineEvaluators} from '../src/moduleEvolutionOfflineEvaluators.mjs';
import {calibrateModuleSourceJudge} from '../src/moduleEvolutionCalibration.mjs';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {evolutionRecordPin} from '../src/evolutionRecordPins.mjs';

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

test('curation pins the real preserved public abstract and overrides model-supplied source references', async () => {
 const {service:store}=evolutionServiceFixture(),tasks=[];
 const sourceText='Preserved public abstract with a bounded finding.';
 const prepare=createModuleEvolutionPreparation({service:store,taskPool:{add:async task=>tasks.push(task)},policies:{},
  provenance:{resolvePaper:async()=>({provenanceResolved:true,firstPublicAt:'2026-10-03T00:00:00Z',firstPublicEvidenceId:'chronology',sourceRoot:'doi:10.1234/public',aliases:['doi:10.1234/public']})},
  discovery:{discover:async()=>[{sourceText,doi:'10.1234/public',sourceUrl:'https://doi.org/10.1234/public'}]},model:null,
  dependencies:()=>({extractTask:async()=>({id:'task',sourceQuotes:[sourceText],sourceAssetRef:{id:'forged',revision:1,payloadHash:'forged'},sourceIdentifiers:['private-project'],reservedHidden:true,baselineKnownCorrect:true,truthVerified:true}),verifyTask:async()=>({passed:true,independent:true,reviewerModel:'qwen-review'})}),runners:()=>({geo:async()=>({})})});
 await prepare({moduleId:'geo',phase:'confirmation',epoch:'e',candidate:{frozenAt:'2026-10-02T00:00:00Z'},modelReleasedAt:'2026-10-01T00:00:00Z'});
 assert.equal(tasks.length,1);
 const asset=(await store.list('resource-asset'))[0];
 assert.deepEqual(tasks[0].sourceAssetRef,evolutionRecordPin(asset));
 assert.deepEqual(tasks[0].sourceIdentifiers,['doi:10.1234/public']);
 assert.equal(asset.payload.text,sourceText);
 assert.equal(tasks[0].reservedHidden,undefined); assert.equal(tasks[0].baselineKnownCorrect,undefined); assert.equal(tasks[0].truthVerified,undefined);
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
test('the extraction prompt says when a task is an abstention, which a confirmation batch cannot be sealed without',()=>{
 // evolutionTaskPool.assemble() waits unless the batch holds an `abstentionExpected` item; an extractor that is never told what one is will not make any.
 assert.match(MODULE_TASK_EXTRACTION_INSTRUCTIONS,/abstentionExpected true/);
 assert.match(MODULE_TASK_EXTRACTION_INSTRUCTIONS,/cannot answer/);
 assert.match(MODULE_TASK_EXTRACTION_INSTRUCTIONS,/abstain/);
 assert.match(MODULE_TASK_EXTRACTION_INSTRUCTIONS,/insufficient/);
});
