import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {persistRunTranscript} from '../src/runTranscripts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveEvolutionCapabilityMap} from '../src/evolutionCapabilityMap.mjs';
import {createModuleEvolutionOfflineEvaluators} from '../src/moduleEvolutionOfflineEvaluators.mjs';
import {MODULE_MEMORY_SNAPSHOT_TASKS} from '../src/moduleEvolutionMemorySnapshot.mjs';
import {EVOLUTION_TRUSTED_TASK_TEMPLATES} from '../src/evolutionTransfer.mjs';

test('map projects supported families only from matching sealed confirmation and flags current month',()=>{
 const support={id:'support',payload:{moduleId:'tools',capabilityIds:['scientific-tool'],taskFamily:{operation:'extract',inputShape:'table'},candidateId:'candidate',verdictId:'verdict',confirmedAt:'2026-10-03'}};
 const verdict={id:'verdict',payload:{promote:true,receiptValid:true,confirmatory:true,candidateId:'candidate'}};
 const input={registry:[{id:'scientific-tool'}],supportedFamilies:[support],evaluations:[verdict],methods:{},now:new Date('2026-10-06')};
 const map=deriveEvolutionCapabilityMap(input);assert.equal(map.counts.supported,1);assert.equal(map.cells.find(cell=>cell.status==='supported').newThisMonth,true);
 assert.equal(deriveEvolutionCapabilityMap({...input,evaluations:[{...verdict,payload:{...verdict.payload,candidateId:'another'}}]}).counts.supported,0);
 assert.equal(deriveEvolutionCapabilityMap({...input,evaluations:[{...verdict,payload:{...verdict.payload,auditOnly:true}}]}).counts.supported,0);
});
test('memory runs the production recall port against fixed nonclinical scope/time snapshots',async()=>{
 const result=await createModuleEvolutionOfflineEvaluators().memory({pool:'development',batch:MODULE_MEMORY_SNAPSHOT_TASKS});
 assert.deepEqual(result.units.map(unit=>unit.score),[1,1,1]);assert.equal(result.evidenceTier,'exact');
 const wrong=await createModuleEvolutionOfflineEvaluators().memory({pool:'development',batch:[{...MODULE_MEMORY_SNAPSHOT_TASKS[0],expected:['record:private-other']}]});
 assert.equal(wrong.units[0].score,0);
});
test('trusted cell generator independently accepts truth and rejects malformed locations',()=>{
 const template=EVOLUTION_TRUSTED_TASK_TEMPLATES['source-delimited-cells'];
 const task=template.generate({value:43,label:'fixture'});assert.equal(template.verify(task.input,task.correct),true);assert.ok(task.wrong.every(answer=>template.verify(task.input,answer)===false));
});

test('native probe dispatches checked-in prompts through the actual runs boundary and hashes preserved replies',async t=>{
 const {createModuleEvolutionNativeProbe}=await import('../src/moduleEvolutionNativeProbe.mjs');
 const rootDir=await mkdtemp(path.join(tmpdir(),'evolution-native-'));t.after(()=>rm(rootDir,{recursive:true,force:true}));
 const project={id:'native-project',rootDir,metaDir:path.join(rootDir,'.openscience')};await mkdir(project.metaDir);
 const dispatched=[];let turn=0;
 const probe=createModuleEvolutionNativeProbe({runs:{dispatch:async request=>{dispatched.push(request);turn++;const run={id:`run-${turn}`,sessionId:'native-existing'};await persistRunTranscript({project,run,sessions:[{sessionId:run.sessionId,parentSessionId:null,label:'root',capability:'open-domain-answer',transcript:{lastSeq:turn,exhausted:true,messages:[{seq:turn,role:'assistant',parts:[{type:'text',text:turn===1?'OK':'3'}]}]}}]});return run;}},store:{userById:async()=>({id:'owner'}),requireProject:async()=>project},agentRuns:{list:async()=>[{id:`run-${turn}`,status:'succeeded'}],readSessionHistory:async()=>[{role:'assistant',parts:[{type:'text',text:turn===1?'OK':'3'}]}]},config:{evolutionEvaluationTimeoutMs:1000},readKernelProof:async()=>({kernelVersion:'observed',baselineVersion:'deployment'})});
 const result=await probe({missionId:'mission',userId:'owner',arm:'baseline',repeat:0,item:{id:'evolution-task-persisted-native',nativeReferenceId:'native-context-0'}});
 assert.equal(dispatched.length,2);assert.equal(dispatched[0].sessionId,null);assert.equal(dispatched[1].sessionId,'native-existing');
 assert.equal(result.passed,true);assert.equal(result.turns[0].replyHash.length,64);
 await assert.rejects(()=>probe({item:{id:'model-created-untrusted-prompt'}}),/not a trusted code template/);
});

test('frozen production task identities survive source execution and equivalent variants into the selector',async()=>{
 const {validateEvolutionMeasurements}=await import('../src/evolutionMissions.mjs');
 const {createEvolutionTaskPool}=await import('../src/evolutionTaskPool.mjs');
 const {evolutionServiceFixture}=await import('./helpers/evolutionServiceFixture.mjs');
 const fixture=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:fixture.service});
 const original={id:'upstream-task-id',moduleId:'sources',pool:'confirmation',scope:'public',sourceRoot:'preserved-source-fixture',sourceHash:createHash('sha256').update('n,unit\n120,mg').digest('hex'),format:'csv',sourceText:'n,unit\n120,mg',expectedCells:[{address:'2:1',text:'120'},{address:'2:2',text:'mg'}],equivalentVariant:{sourceText:'unit,n\nmg,120',expectedCells:[{address:'2:1',text:'mg'},{address:'2:2',text:'120'}],sourceHash:'untrusted-variant-hash'}};
 const frozen=await pool.add(original);
 const task={...frozen.payload,id:frozen.id};
 assert.notEqual(task.id,original.id);
 const result=await createModuleEvolutionOfflineEvaluators().sources({pool:'confirmation',batch:[task]});
 assert.deepEqual(validateEvolutionMeasurements([task],result),[]);
 assert.equal(result.units.length,2);assert.ok(result.units.every(unit=>unit.score===1&&unit.sourceHash===task.sourceHash&&unit.groupId===task.id));
 assert.notEqual(result.units[0].executionInputHash,result.units[1].executionInputHash);
 assert.deepEqual(validateEvolutionMeasurements([task],{...result,units:result.units.map(unit=>({...unit,sourceHash:unit.executionInputHash}))}),['source-or-group-mismatch']);
});


test('installed failure reproduction callback replays a pinned public task twice and reuses the durable receipt',async()=>{
 const {createEvolutionLoops}=await import('../src/evolutionLoops.mjs');
 const {evolutionServiceFixture}=await import('./helpers/evolutionServiceFixture.mjs');
 const {deriveDelimitedStructure}=await import('@evimed/domain');
 const {service}=evolutionServiceFixture();
 const sourceText='name,value\nfixture,7',sourceHash=createHash('sha256').update(sourceText).digest('hex');
 await service.save('mission','replay-mission',{epoch:'epoch'});
 await service.save('task','pinned-public-task',{moduleId:'sources',pool:'development',scope:'public',baselineKnownCorrect:false,referenceVerified:true,sourceRoot:'public:fixture',sourceHash,sourceText,format:'csv',expectedCells:[{text:'7',address:'2:2'}]});
 const loops=createEvolutionLoops({service,config:{},database:{query:async()=>({rows:[{cost:0,count:0}]})},registry:{list:()=>[]},model:async()=>({})});
 let calls=0;
 loops.configureModules({readDevelopmentTasks:async()=>[],sourceExecute:async item=>{calls++;const output=deriveDelimitedStructure({text:item.sourceText,delimiter:','});return {...output,tables:output.tables.map(table=>({...table,cells:table.cells.filter(cell=>cell.t!=='7')}))};}});
 const input={missionId:'replay-mission',moduleId:'sources',baseline:{}};
 const result=await service.callbacks.reproduceEvolutionFailure(input,{});
 assert.equal(result.status,'reproduced');assert.equal(calls,2);
 const receipt=await service.get(result.receiptId);assert.equal(receipt.payload.sourceHash,sourceHash);assert.equal(receipt.payload.taskId,'pinned-public-task');
 assert.deepEqual(await service.callbacks.reproduceEvolutionFailure(input,{}),result);assert.equal(calls,2);
});

test('native cancellation after admission releases only its captured runtime generation',async()=>{
 const {createModuleEvolutionNativeProbe}=await import('../src/moduleEvolutionNativeProbe.mjs');
 const controller=new AbortController(),scope={runId:'runtime-probe-owned',generation:'captured'},closed=[];
 const project={id:'eval-paper-runtime-cancel'};
 const probe=createModuleEvolutionNativeProbe({runs:{dispatch:async()=>{controller.abort();return {id:'owned-run',sessionId:'owned-session',nativeScope:scope};},closeNativeProbe:async(...args)=>closed.push(args)},store:{userById:async()=>({id:'owner'}),requireProject:async()=>project},agentRuns:{list:async()=>assert.fail('Cancelled probes cannot continue polling.')},config:{evolutionEvaluationTimeoutMs:1000},readKernelProof:async()=>assert.fail('Cancelled probes cannot certify a runtime.')});
 await assert.rejects(()=>probe({missionId:'mission',userId:'owner',arm:'baseline',repeat:0,item:{id:'native-context-0'},signal:controller.signal}),{name:'AbortError'});
 assert.deepEqual(closed,[[project,scope]]);
});
