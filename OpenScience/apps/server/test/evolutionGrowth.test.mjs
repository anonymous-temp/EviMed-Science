import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvolutionGrowth,evolutionOpportunitySource} from '../src/evolutionGrowth.mjs';
import {evolutionReplayHeldOut,evolutionPriorityFeatures} from '../src/evolutionMissions.mjs';
function memory(){const rows=new Map();return {rows,now:()=>new Date('2026-10-06'),get:async id=>rows.get(id),save:async(type,id,payload)=>{const row={id,payload,type};rows.set(id,row);return row;},list:async type=>[...rows.values()].filter(row=>row.type===type),tools:async()=>[],withLock:async(id,fn)=>fn()};}
test('opportunity classification preserves data and contradiction instead of collapsing to repair',()=>{
 assert.equal(evolutionOpportunitySource('availability'),'data');assert.equal(evolutionOpportunitySource('semantics-contested'),'contradiction');assert.equal(evolutionOpportunitySource('workflow-success'),'success');assert.equal(evolutionOpportunitySource('unmet-demand'),'demand');assert.equal(evolutionOpportunitySource('classifier-failure'),'repair');
});
test('first confirmed family counts once and never credits unconfirmed or audit outcomes',async()=>{
 const service=memory(),growth=createEvolutionGrowth({service,opportunity:async()=>{},database:{}});
 const mission={id:'mission',payload:{moduleId:'tools',taskFamily:{operation:'extract',inputShape:'table'}}},candidate={id:'candidate'},verdict={id:'verdict',payload:{promote:true,confirmatory:true,receiptValid:true,score:1}};
 assert.equal(await growth.recordConfirmedFamilies({mission,candidate,verdict}),1);assert.equal(await growth.recordConfirmedFamilies({mission,candidate,verdict}),1);
 assert.equal(await growth.recordConfirmedFamilies({mission:{...mission,id:'another-mission'},candidate,verdict}),0);
 assert.equal(await growth.recordConfirmedFamilies({mission:{...mission,payload:{...mission.payload,taskFamily:{operation:'plan',inputShape:'text'}}},candidate,verdict:{...verdict,payload:{...verdict.payload,auditOnly:true}}}),0);
});
test('public module failures become repair opportunities but suppressed tenant summaries stay private',async()=>{
 const service=memory(),offered=[];
 await service.save('module-observation','failed',{moduleId:'frontier',kind:'editor-failed',counts:{failed:2}});
 await service.save('signal-summary','private',{moduleId:'sources',kind:'availability',distinctAccounts:4,codes:{dataShape:'table'}});
 const growth=createEvolutionGrowth({service,opportunity:async item=>offered.push(item),database:{}});await growth.collect();
 assert.equal(offered.length,1);assert.deepEqual(offered[0].sources,['repair']);assert.equal(offered[0].features.runtimeFailures,2);
});
test('replay split is stable before outcomes and frozen features exclude prose and outcome claims',()=>{
 assert.equal(evolutionReplayHeldOut('same'),evolutionReplayHeldOut('same'));
 const features=evolutionPriorityFeatures({id:'o',payload:{features:{distinctAccounts:5,coverageGap:true,estimatedCostCny:2,tenantText:'secret',confirmedGain:99}}});
 assert.equal(features.accountCount,5);assert.equal(features.unlockedFamilies,1);assert.equal(features.tenantText,undefined);assert.equal(features.confirmedGain,undefined);
});
test('confirmed success becomes a growth opportunity after the matching candidate activates',async()=>{
 const service=memory(),offered=[];
 await service.save('candidate-verdict','verdict',{candidateId:'tool',archiveId:'archive',moduleId:'tools',promote:true,confirmatory:true,receiptValid:true});
 const growth=createEvolutionGrowth({service,opportunity:async item=>offered.push(item),database:{}});
 await growth.collect();assert.equal(offered.length,0);
 await service.save('archive','archive',{verdictId:'verdict',status:'promoted'});
 await growth.collect();assert.equal(offered.length,1);assert.deepEqual(offered[0].sources,['success']);
});
