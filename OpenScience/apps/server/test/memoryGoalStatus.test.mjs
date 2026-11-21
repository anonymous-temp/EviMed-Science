import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAllowsEgress } from '@evimed/domain';
import { createGoalStatusReader } from '../src/memoryGoalStatus.mjs';

test('business state and recent work reopen only the current owned goal and its automatic round', async () => {
  const goal = {id:'goal-session',projectId:'p',payload:{sessionId:'session',status:'active',progress:{processed:2,total:5},reason:'SECRET'}};
  const source = {id:'round', sessionId:'session',automated:true,effectiveRouteReason:'loopx-continuation',status:'succeeded',
    startedAt:'2026-11-01T12:00Z',finishedAt:'2026-11-01T12:01Z',outputFiles:['PRIVATE-FILE'],question:'PRIVATE-PROMPT'};
  const state = {allowed:true,context:'owned',reset:null}, config = {memoryGoalStatusEnabled:true};
  const read = createGoalStatusReader({config,contexts:{forProject:async()=>({kind:state.context}),assertLive:async()=>{}},
    projectFor:async(userId,id)=>({userId,id}),documents:{list:async()=>({items:[goal]})},runsOf:async()=>new Map([['session',[source]]]),
    permitted:async(_p,id)=>id!=='session'||state.allowed,resetInstant:async()=>state.reset});
  const query = term => read('u','p','destination',term);
  const [{row,record}] = await query('研究进展');
  assert.equal(record.runId,source.id); assert.equal(record.hasOutput,true);assert.equal(record.sourceId,goal.id);
  assert.equal(sourceAllowsEgress(row,{purpose:'method'}),false); assert.equal(row.slot,'recent_work');assert.match(row.text,/2\/5/);assert.doesNotMatch(JSON.stringify([row,record]),/PRIVATE|SECRET/);
  assert.equal((await query(source.id)).length,1); assert.deepEqual(await query('unrelated'),[]);
  goal.payload.status='finished'; assert.equal((await query('目标状态'))[0].record.status,'finished');
  for (const [key,value] of [['allowed',false],['context','geo-project'],['reset','2026-12-01']]) {
    const held=state[key];state[key]=value;assert.deepEqual(await query('目标状态'),[]);state[key]=held;
  }
  for (const [key,value] of [['deleted',true],['automated',false],['effectiveRouteReason','scheduled-task']]) {
    const held=source[key];source[key]=value;assert.deepEqual(await query('目标状态'),[]);source[key]=held;
  }
  config.memoryGoalStatusEnabled=false;assert.deepEqual(await query('目标状态'),[]);
});
