import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createEvolutionGatewayHandler } from '../src/evolutionGateway.mjs';
import { HttpError } from '../src/security.mjs';

async function fixture(t,{fail=false,allowed=true,rejected=false,joined=true,started=true,binding=null}={}) {
  const events=[],pin={id:'method',digest:`sha256:${'a'.repeat(64)}`,revision:2,publicationKind:'isolated-tool',capabilityIds:['statistical-analysis']};
  let calls=0;
  const handler=createEvolutionGatewayHandler({config:{evolutionEnabled:true},
    authenticateWorkload:async token=>token==='token'?{userId:'owner',projectId:'project',runtimeGeneration:'generation'}:null,
    resolveRun:async()=>({project:{id:'project',userId:'owner'},runId:'run',capabilityId:allowed?'statistical-analysis':'other'}),
    runtimeManager:{runtimePlatformSkills:()=>[pin]},controller:{execVerify:async()=>({ok:!fail,joined,executionStarted:started})},
    supply:{executeIsolated:async(_project,_input,execute)=>{calls++;await execute({});if(fail){const error=new HttpError(422,'extension_contract_invalid','Failed.');if(binding)Object.assign(error,{argumentBinding:binding});throw error;}return {estimate:1};}},
    admit:async(_scope,execute)=>{if(rejected)throw new HttpError(429,'runtime_limit_exceeded','Capacity unavailable.');return execute();},onExecution:async event=>events.push(event)});
  const server=http.createServer((req,res)=>{handler(req,res).catch(error=>res.destroy(error));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address();assert.ok(address&&typeof address==='object');
  return {events,get calls(){return calls;},post:async()=>fetch(`http://127.0.0.1:${address.port}/internal/evolution/v1/execute`,{method:'POST',headers:{authorization:'Bearer token','content-type':'application/json'},body:JSON.stringify({toolId:pin.id,digest:pin.digest,args:{x:1}})})};
}
test('gateway returns only bounded binding keys while preserving failed actual execution telemetry',async t=>{
  const binding={code:'argument-binding-invalid',expectedParameters:['specification'],receivedKeys:['n'],inputValue:'private-value'};
  const runtime=await fixture(t,{fail:true,binding}),response=await runtime.post(),body=await response.json();
  assert.equal(response.status,422);
  assert.equal(response.statusText,'Argument binding: expected (specification); received (n)');
  assert.deepEqual(body.argumentBinding,{code:binding.code,expectedParameters:['specification'],receivedKeys:['n']});
  assert.equal(JSON.stringify(body).includes('private-value'),false);
  assert.equal(runtime.events[0].result.ok,false);
  const malformed=await fixture(t,{fail:true,binding:{...binding,receivedKeys:['unsafe\nsecret']}}),rejected=await malformed.post();
  assert.equal((await rejected.json()).argumentBinding,undefined);
});
test('immutable scoped executions record their actual revision on success and failure',async t=>{
  for(const fail of [false,true]) {
    const runtime=await fixture(t,{fail}),response=await runtime.post();
    assert.equal(response.status,fail?422:200);assert.equal(runtime.calls,1);
    assert.deepEqual(runtime.events.map(event=>({revision:event.revision,result:event.result})),[{revision:2,result:fail?{ok:false,code:'extension_contract_invalid'}:{ok:true}}]);
    assert.equal(runtime.events[0].inputSha256,createHash('sha256').update('{"x":1}').digest('hex'));
    assert.equal(Object.hasOwn(runtime.events[0],'args'),false);
  }
});
test('a different capability cannot execute or emit execution telemetry',async t=>{
  const runtime=await fixture(t,{allowed:false}),response=await runtime.post();
  assert.equal(response.status,403);assert.equal(runtime.calls,0);assert.deepEqual(runtime.events,[]);
});

test('admission and pre-start validation refusals emit no actual invocation',async t=>{
  for(const options of [{rejected:true},{joined:false,fail:true},{started:false,fail:true}]) {
    const runtime=await fixture(t,options); await runtime.post(); assert.deepEqual(runtime.events,[]);
  }
});
