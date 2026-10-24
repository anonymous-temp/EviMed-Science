import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeSeededMemory, collectIndependentCells, fatalCollectionError } from '../protocol.mjs';
test('native seeding settles completely before learning freezes and recall stays enabled',async()=>{
 const calls=[];let polls=0;
 const call=async(method,url,body)=>{calls.push({method,url,body});if(url==='/api/memory/profile')return ++polls===1?{engine:'native',pending:[{id:'seed-1'}],records:[]}:{engine:'native',pending:[],records:[{id:'viking://user/owned/memories/preferences/format.md',value:'Use EUR for forecasts'}]};return {engine:'native',learningPaused:true,recallPaused:false};};
 const frozen=await freezeSeededMemory(call,{judge:async()=>({ok:true,score:1,points:[{verdict:'covered',contradicted:false}]}),seedIds:['seed-1'],requiredSeeds:[{id:'currency',kind:'user-authored',statement:'Use EUR for forecasts',requiredValues:['EUR']}],sleep:async()=>{},timeoutMs:1000});
 assert.equal(frozen.settings.learningPaused,true);assert.equal(frozen.settings.recallPaused,false);
 assert.equal(calls.findIndex(c=>c.method==='PUT'),2);
});
test('ordinary failed cell is recorded and independent cells continue; budget/auth/identity stops all',async()=>{
 const rows=[];let calls=0;
 await collectIndependentCells([1,2,3],async i=>{calls++;if(i===2)throw new Error('DSH run timed out');return {i};},r=>rows.push(r));
 assert.equal(calls,3);assert.equal(rows[1].status,'inconclusive');
 for(const e of [new Error('Aggregate budget exhausted'),new Error('HTTP 401'),new Error('identity mismatch')])assert.equal(fatalCollectionError(e),true);
 let attempted=0;await assert.rejects(()=>collectIndependentCells([1,2],async()=>{attempted++;throw new Error('Budget wiring missing');},()=>{}));assert.equal(attempted,1);
});
