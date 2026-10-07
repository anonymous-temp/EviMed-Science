import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
const task=(id,patch={})=>({id,moduleId:'tools',sourceRoot:`paper:${id}`,sourceHash:id.repeat(64).slice(0,64),pool:'confirmation',scope:'public',reservedHidden:true,curatorIndependent:true,equivalentVariant:{input:{reordered:true}},...patch});
const request=candidateId=>({candidateId,lineageId:candidateId,moduleId:'tools',frozenAt:'2026-10-03',modelReleasedAt:'2026-10-01',epoch:'epoch',minimum:2,slices:['safety']});
test('mandatory abstention and preregistered slices selected before deterministic fill; reservations cannot race',async()=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});
 for(const id of ['a','b','c','d','e'])await pool.add(task(id));
 await pool.add(task('f',{abstentionExpected:true,slices:['safety']}));
 const batches=await Promise.all([pool.assemble(request('candidate-a')),pool.assemble(request('candidate-b'))]);
 assert.equal(batches.filter(batch=>batch.id).length,1);
 const batch=batches.find(item=>item.id),rows=await Promise.all(batch.payload.taskIds.map(id=>f.service.get(id)));
 assert.ok(rows.some(row=>row.payload.abstentionExpected));assert.ok(rows.some(row=>row.payload.slices.includes('safety')));
});
test('first answers survive a budget wait; ambiguous interrupted paid answers require reconciliation',async()=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});
 await pool.add(task('a',{abstentionExpected:true,slices:['safety']}));await pool.add(task('b'));
 const batch=await pool.assemble(request('candidate'));
 assert.equal((await pool.begin(batch)).status,'started');let calls=0;
 const first=await pool.executeUnit(batch,'candidate:1:a',async()=>{calls++;return{score:1,sourceHash:'a'.repeat(64)};});
 assert.deepEqual(await pool.executeUnit(batch,'candidate:1:a',async()=>{throw Error('a completed first answer cannot run twice');}),first);assert.equal(calls,1);
 await assert.rejects(pool.executeUnit(batch,'candidate:1:b',async()=>{throw Object.assign(Error('unpaid'),{code:'usage_budget_exceeded',status:402});}));
 assert.equal((await pool.begin(batch)).status,'resumed');
 assert.equal((await pool.executeUnit(batch,'candidate:1:b',async()=>({score:0}))).score,0);
 await assert.rejects(pool.executeUnit(batch,'baseline:0:a',async()=>{throw Error('unknown paid interruption');}));
 await assert.rejects(pool.executeUnit(batch,'baseline:0:a',async()=>({score:1})),error=>error.code==='evolution_first_answer_reconciliation');
});
test('canonical resource study exposure excludes fresh aliases and version hashes',async()=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});
 await f.service.save('resource-asset','exposed-resource',{sourceRoot:'original-study',studyFamilyId:'study-family',sourceHash:'old-hash',exposedToDevelopment:true});
 await pool.add(task('a',{sourceRoot:'new-url',studyFamilyId:'study-family',sourceHash:'new-version',abstentionExpected:true,slices:['safety']}));
 await pool.add(task('b'));await pool.add(task('c'));
 const result=await pool.assemble(request('candidate'));
 assert.equal(result.id,null);assert.match(result.payload.reason,/abstention/);
});
