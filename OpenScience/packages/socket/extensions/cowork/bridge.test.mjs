import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {coworkToolSpecs} from './bridge.mjs';
test('thin bridge retains invoking scope and cancellation; caller cannot select a host path',async()=>{
  const calls=[],specs=coworkToolSpecs(async input=>{calls.push(input);return{ok:true,data:{format:'xlsx'}};});
  const signal=new AbortController().signal,call={agent:{id:'actual-child'},signal};
  await specs[0].execute({resourceId:'res_public',options:{rows:3}},call);
  assert.equal(calls[0].call,call);assert.equal(calls[0].request.operation,'doc_read');
  await assert.rejects(specs[0].execute({resourceId:'res_public',path:'/data-plane'},call));
  assert.deepEqual(specs.map(spec=>spec.name),['doc_read','doc_write']);
});

test('actual registry identity is projected; forged agents or foreign definitions cannot borrow authority', async()=>{
  const {nativeCoworkInvocation}=await import('./bridge.mjs');const definition={},agent={id:'session-owned',session:{header:{id:'session-owned'}}};
  const ctx={agents:{get:()=>agent},tools:{get:()=>definition}};const call={agent,callId:'tool-owned',rootCallId:'tool-owned',name:'doc_read',token:Symbol('registry'),signal:AbortSignal.timeout(1000)};
  assert.deepEqual(nativeCoworkInvocation(ctx,call,'doc_read',definition,'generation-owned'),{sessionId:agent.id,agentId:agent.id,callId:call.callId,rootCallId:call.rootCallId,toolName:call.name,runtimeGeneration:'generation-owned'});
  assert.throws(()=>nativeCoworkInvocation(ctx,{...call,agent:{...agent}},'doc_read',definition,'generation-owned'));
  assert.throws(()=>nativeCoworkInvocation(ctx,call,'doc_read',{},'generation-owned'));
});
test('native gateway sends the exact service envelope and keeps same-call status pending through result',async()=>{
  const {callCoworkGateway}=await import('./bridge.mjs');const fs=await import('node:fs/promises');const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'cowork-transport-')));const tokenFile=directory+'/token';await fs.writeFile(tokenFile,'fixture-only');
  const calls=[],invocation={sessionId:'s',agentId:'s',callId:'call-one',rootCallId:'call-one',toolName:'doc_read',runtimeGeneration:'generation'};
  try{const result=await callCoworkGateway({descriptorId:'cowork-portable',gatewayUrl:'http://localhost/internal/extensions/v1',tokenFile},invocation,{operation:'doc_read',resourceId:'opaque'},AbortSignal.timeout(3000),async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body),invocation:JSON.parse(init.headers['x-evimed-extension-invocation'])});
    return new Response(JSON.stringify(url.endsWith('/execute')?{jobId:'job-one'}:{jobId:'job-one',status:'succeeded',result:{data:{text:'公开资源'}}}),{status:200});});
    assert.deepEqual(calls[0].body,{descriptorId:'cowork-portable',idempotencyKey:'call-one',request:{operation:'doc_read',resourceId:'opaque'}});
    assert.deepEqual(calls[1].body,{jobId:'job-one'});assert.deepEqual(calls[1].invocation,invocation);assert.deepEqual(result,{text:'公开资源'});
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
