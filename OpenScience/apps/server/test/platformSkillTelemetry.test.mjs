import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentRunStore} from '../src/agentRuns.mjs';
import {createPlatformSkillTelemetry} from '../src/platformSkillTelemetry.mjs';
const pin={id:'linear',revision:2,digest:`sha256:${'b'.repeat(64)}`,nativeName:`platform-${'a'.repeat(24)}`,publicationKind:'skill',files:[{path:'scripts/linear.py'}]};
function call(tracker,id,tool,input,output='ok',status='completed'){
  assert.deepEqual(tracker.observe({type:'tool/call',callId:id,tool,input}),[]);
  return tracker.observe({type:'tool/result',callId:id,tool,status,output});
}
test('reading instructions is retrieval; only actual script execution is invocation',()=>{
  const tracker=createPlatformSkillTelemetry([pin]);
  const retrieval=call(tracker,'read','read',{path:`/opt/evimed/platform-skills/${pin.nativeName}/INSTRUCTIONS.md`});
  assert.equal(retrieval[0].kind,'retrieval');assert.equal(retrieval[0].result,undefined);
  assert.deepEqual(call(tracker,'echo','evimed_exec',{command:`echo python3 /opt/evimed/platform-skills/${pin.nativeName}/scripts/linear.py`}),[]);
  const events=call(tracker,'exec','evimed_exec',{command:`python3 /opt/evimed/platform-skills/${pin.nativeName}/scripts/linear.py --input input.json`});
  assert.equal(events[0].revision,2);assert.deepEqual(events[0].result,{ok:true});assert.ok(events[0].callId);
  assert.equal(JSON.stringify(events).includes('input.json'),false);
  const replay=createPlatformSkillTelemetry([pin]);assert.equal(call(replay,'exec','evimed_exec',{command:`python3 /opt/evimed/platform-skills/${pin.nativeName}/scripts/linear.py --input input.json`})[0].callId,events[0].callId);
  assert.deepEqual(tracker.observe({type:'tool/result',callId:'exec',tool:'evimed_exec',status:'completed',output:'ok'}),[]);
});
test('plain workflows count successful declared tool steps, never a partial sequence or failed read',()=>{
  const workflow={...pin,id:'workflow',files:[],executionTools:['literature_search','open_access_full_text']},tracker=createPlatformSkillTelemetry([workflow,{...pin,id:'platform-tool-search'}]);
  assert.deepEqual(call(tracker,'before','literature_search',{}),[]);
  assert.deepEqual(call(tracker,'failed-read','read',{path:`/opt/evimed/platform-skills/${pin.nativeName}/SKILL.md`},'', 'error'),[]);
  call(tracker,'read','read',{path:`/opt/evimed/platform-skills/${pin.nativeName}/SKILL.md`});
  assert.deepEqual(call(tracker,'step1','mcp__evimed__literature_search',{}),[]);
  const events=call(tracker,'step2','mcp__evimed__open_access_full_text',{});
  assert.equal(events[0].toolId,'workflow');assert.deepEqual(events[0].result,{ok:true});
});

test('the run ledger forwards observed execution through its registered maintenance callback',async()=>{
  const events=[],store=new AgentRunStore({}, {model:'deepseek/deepseek-flash',runtimePlatformSkills:()=>[pin],onPlatformSkillExecution:async event=>{events.push(event);}}),project={id:'project',userId:'owner'};
  try{
    store.noteRunEvent(project,'run',{sessionId:'session',event:{type:'tool/call',seq:1,callId:'call',tool:'evimed_exec',input:{command:`python3 /opt/evimed/platform-skills/${pin.nativeName}/scripts/linear.py`}}});
    store.noteRunEvent(project,'run',{sessionId:'session',event:{type:'tool/result',seq:2,callId:'call',tool:'evimed_exec',status:'completed',output:'ok'}});
    await store.progressTrackers.get('run').platformSkillObservations;
    assert.equal(events.length,1);assert.equal(events[0].runId,'run');assert.deepEqual(events[0].result,{ok:true});
  }finally{await store.closeAll();}
});

test('isolated instructions count retrieval while proxy execution remains gateway-owned', () => {
  const isolated = { ...pin, publicationKind: 'isolated-tool', files: [{ path: 'scripts/invoke_isolated.py' }] };
  const tracker = createPlatformSkillTelemetry([isolated]);
  const events = call(tracker, 'isolated-read', 'read', { path: `/opt/evimed/platform-skills/${pin.nativeName}/SKILL.md` });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'retrieval');
  assert.equal(events[0].toolId, pin.id);
  assert.equal(events[0].digest, pin.digest);
  assert.ok(events[0].retrievalId);
  assert.deepEqual(call(tracker, 'proxy', 'evimed_exec', { command: `python3 /opt/evimed/platform-skills/${pin.nativeName}/scripts/invoke_isolated.py` }), []);
});
