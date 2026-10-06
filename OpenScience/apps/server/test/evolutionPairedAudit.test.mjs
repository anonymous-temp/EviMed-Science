import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
import {createEvolutionPairedAudit} from '../src/evolutionPairedAudit.mjs';
async function fixture(){
 const {service}=evolutionServiceFixture(),taskPool=createEvolutionTaskPool({service}),candidate={id:'c',policy:{value:1}},baseline={policy:{value:0}};
 await service.save('archive','c',{candidate});
 await service.save('mission','m',{candidate,baseline,smoke:{baseline:{units:[{id:'dev',score:0.5}]},candidate:{units:[{id:'dev',score:0.9}]}}});
 await service.save('candidate-verdict','v',{missionId:'m',candidateId:'c',moduleId:'memory',epoch:'epoch',receiptValid:true,confirmatory:true,at:'2026-10-04T00:00:00Z',candidateHash:createHash('sha256').update(canonicalJson(candidate)).digest('hex')});
 const tasks=[];for(const id of ['a','b'])tasks.push(await taskPool.add({id,moduleId:'memory',pool:'audit',scope:'generated',truthVerified:true,sourceRoot:id,sourceHash:id.repeat(64)}));
 let calls=0;
 const adapters={memory:{enabled:true,evaluate:async input=>({evidenceTier:'exact',units:await Promise.all(input.batch.map(item=>input.checkpointUnit(item.id,async()=>{calls++;return {id:item.id,sourceHash:item.sourceHash,score:input.candidate.policy.value?0.7:0.6};})))})}};
 return {service,taskPool,tasks,adapters,calls:()=>calls};
}
test('paired quarter audit writes observed gain and immutable replay reuses first answers',async()=>{
 const f=await fixture(),audit=createEvolutionPairedAudit(f),input={month:'2026-10',quarter:'q',epoch:'epoch',tasks:f.tasks,missionId:'audit-job'};
 const rows=await audit(input);assert.equal(rows[0].status,'measured');assert.ok(Math.abs(rows[0].overfitGap-0.3)<1e-9);assert.equal((await f.service.get('m')).payload.auditReceiptId,rows[0].id);
 await audit(input);assert.equal(f.calls(),4);
});
test('missing heldout material and candidate byte drift cannot produce gains',async()=>{
 const f=await fixture(),audit=createEvolutionPairedAudit(f),input={month:'2026-10',quarter:'q',epoch:'epoch',tasks:[],missionId:'audit-job'};
 assert.equal((await audit(input))[0].auditGain,null);assert.equal(f.calls(),0);
 const row=await f.service.get('c');await f.service.save('archive','c',{candidate:{id:'c',policy:{value:99}}},row);
 assert.equal((await audit({...input,tasks:f.tasks}))[0].reason,'immutable-pair-unavailable');assert.equal(f.calls(),0);
});
test('empty quarter pool waits and can fill later',async()=>{
 const {service}=evolutionServiceFixture(),pool=createEvolutionTaskPool({service});assert.equal((await pool.rotateAudit('q')).payload.status,'waiting');
 await pool.add({id:'new',moduleId:'memory',pool:'audit',scope:'generated',truthVerified:true,sourceRoot:'new',sourceHash:'a'.repeat(64)});
 assert.equal((await pool.rotateAudit('q')).payload.taskIds.length,1);
});
test('quarter reservations block confirmation reuse through a new study alias',async()=>{
 const {service}=evolutionServiceFixture(),pool=createEvolutionTaskPool({service});
 await pool.add({id:'audit',moduleId:'memory',pool:'audit',scope:'generated',truthVerified:true,sourceRoot:'paper-root',sourceAliases:['doi:10.1/x'],sourceHash:'a'.repeat(64)});
 await pool.rotateAudit('q');
 await pool.add({id:'alias',moduleId:'memory',pool:'confirmation',scope:'public',sourceRoot:'doi:10.1/x',sourceHash:'b'.repeat(64),reservedHidden:true,curatorIndependent:true,equivalentVariant:{input:{}}});
 const batch=await pool.assemble({candidateId:'candidate',lineageId:'lineage',moduleId:'memory',frozenAt:'2026-10-01',modelReleasedAt:'2026-09-01',epoch:'epoch',minimum:1});
 assert.equal(batch.payload.status,'waiting');assert.equal(batch.payload.availableGroups,0);
});
