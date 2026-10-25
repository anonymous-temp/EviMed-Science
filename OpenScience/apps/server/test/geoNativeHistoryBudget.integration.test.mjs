import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {geoPlanDigest} from '../src/geoPlanContext.mjs';
import {fixture} from './helpers/geoNativeCompositionFixture.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required',timeout:60000};

async function setup(t) {
 const f=await fixture(t),app=f.app,manager=app.runtimeManager;
 const geo=(await f.call('owner','POST','/api/geo/projects',{})).body.data;
 // A shared GEO project: one with a member (a one-person GEO project is an owned project, owner ruling 2026-10-25).
 assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'editor',role:'editor'})).status,201);
 const primary=(await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).body.data.sessionId;
 const owner=await app.store.userById('owner'),project=await app.store.requireProject(owner,geo.projectId);
 const memory=await app.nativeMemoryContexts.forProject(project),agent=(await app.agentRegistry).get('geo-insight');
 await app.agentRuns.reserveRun(project,{sessionId:'history-template',mode:'specialist',agentId:agent.id,agentVersion:agent.version,runtimeAgent:agent.runtimeAgent},
  {baselineCursor:null,automated:true,kernelRequestIds:['history-template-request']});
 const ledger=path.join(project.metaDir,'runs.jsonl'),template=JSON.parse((await readFile(ledger,'utf8')).trim());
 let scans=0;const readRuns=app.geoNativeAuthority.runs.bind(app.geoNativeAuthority);
 app.geoNativeAuthority.runs=async(...args)=>{scans++;return readRuns(...args);};
 async function history(count,oldRoot=null) {
  const events=[];
  for(let i=0;i<count;i++) {
   const id=`history-${i}`,historical=oldRoot&&i===count-1;
   events.push({...template,id,sessionId:historical?oldRoot:`historical-auto-${i}`,automated:!historical,kernelRequestIds:[historical?'historical-bound-request':`historical-request-${i}`]});
   events.push({event:'finished',id,status:'failed',errorCode:'runtime_unavailable',artifacts:[],finishedAt:template.startedAt,durationMs:0});
  }
  await writeFile(ledger,events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  const bytes=(await stat(ledger)).size;
  assert.ok(count<=app.agentRuns.maxRuns);assert.ok(bytes<app.agentRuns.maxBytes);
  const canonical=await app.agentRuns.list(project);assert.equal(canonical.length,count);assert.ok(canonical.every(run=>run.status==='failed'));
  if(oldRoot)assert.equal(canonical.findIndex(run=>run.sessionId===oldRoot),count-1,'the bound root is at the complete history tail');
  return bytes;
 }
 const capture=sessionId=>app.nativeMemoryContexts.proveCapture(memory,`dsh-${sessionId}`);
 return {...f,app,manager,geo,owner,project,memory,primary,history,capture,scans:()=>scans,reset:()=>{scans=0;}};
}

test('proven primary and managed child use constant full-ledger scans with 750 and maximum terminal histories',options,async t=>{
 const f=await setup(t),child='primary-managed-child';
 f.manager.subagentAddressFor=async(_project,parent,requested)=>parent===f.primary&&requested===child?{kind:'subagent',parentSessionId:parent,childSessionId:requested,mode:'continuable'}:null;
 for(const count of [750,f.app.agentRuns.maxRuns]) {
  const bytes=await f.history(count);
  for(const target of [f.primary,child]) {
   f.reset();const at=performance.now(),proof=await f.capture(target),ms=Math.round(performance.now()-at);
   assert.equal(proof.rootSessionId,f.primary);
   assert.ok(f.scans()<=1,`proven primary/child must use constant ledger scans; observed ${f.scans()} at ${count} terminal runs`);
   console.log(JSON.stringify({target,terminalRuns:count,ledgerBytes:bytes,fullLedgerScans:f.scans(),captureMs:ms,gatewayTimeoutMs:f.app.config.memoryGatewayTimeoutMs}));
  }
 }
 const scope=await f.app.knowledgePages.knowledgeContext.forProject(f.project);
 f.reset();assert.equal(await scope.sourceScope(child),null);assert.ok(f.scans()<=2,'KB authorization and final re-proof each read at most one snapshot');
 const call=f.manager.callKernel,runtime=f.manager.runtimes.get(f.manager.key(f.project));
 f.manager.callKernel=async(...args)=>{const value=await call(...args);runtime.modelGatewayTokenJti='inventory-generation-race';return value;};
 await assert.rejects(f.capture(f.primary),{code:'product_state_unavailable'});
 f.manager.callKernel=call;runtime.modelGatewayTokenJti='fixture-generation';
});

test('all historical bound roots and exact children remain provable using one canonical snapshot per operation',options,async t=>{
 const f=await setup(t),oldRoot='historical-bound-root',child='historical-managed-child';
 const staged=await f.call('owner','POST',`/api/geo/projects/${f.geo.id}/strategy/context`,{requestKey:'historical-fixture',sessionId:f.primary,mode:'strategy'});
 assert.equal(staged.status,200,JSON.stringify(staged.body));
 const documents=f.app.geo.service.planContexts.documents,row=await documents.get('owner','geo-plan-context',staged.body.data.referenceId);
 const id=`gpc_${geoPlanDigest(['historical-bound',f.geo.id])}`,requestId='historical-bound-request',requestDigest='historical-request-digest';
 await documents.put('owner','geo-plan-context',id,{...row.payload,id,sessionId:oldRoot,state:'bound',requestId,requestDigest},{projectId:f.project.id,expectedRevision:0});
 const bindingId=`gpcbind_${geoPlanDigest(['owner',f.project.id,requestId])}`;
 const binding=await documents.put('owner','geo-plan-context',bindingId,{recordType:'geo-plan-request',geoId:f.geo.id,actorId:'owner',sessionId:oldRoot,requestId,requestDigest,referenceId:id},{projectId:f.project.id,expectedRevision:0});
 await f.manager.callKernel(f.manager.runtimes.get(f.manager.key(f.project)),f.project,'session/create',{request:{sessionId:oldRoot}});
 f.manager.subagentAddressFor=async(_project,parent,requested)=>parent===oldRoot&&requested===child?{kind:'subagent',parentSessionId:parent,childSessionId:requested,mode:'continuable'}:null;
 await f.history(f.app.agentRuns.maxRuns,oldRoot);
 for(const target of [oldRoot,child]) {
  f.reset();const proof=await f.capture(target);assert.equal(proof.rootSessionId,oldRoot);assert.deepEqual(proof.rootProofRefs,[id]);
  assert.equal(f.scans(),1,'historical GPC and proof references share one real canonical ledger read');
 }
 await f.app.researchSessions.setSourceScope(f.project,oldRoot,[`src_${'a'.repeat(32)}`]);
 const context=await f.app.knowledgePages.knowledgeContext.forProject(f.project);
 f.reset();assert.deepEqual(await context.sourceScope(child),[]);assert.equal(f.scans(),2,'final source re-proof uses its own fresh snapshot');
 const authority=f.app.geoNativeAuthority,identity=await authority.retainedIdentity(f.project,f.memory.policy);
 await assert.rejects(authority.proveSession(identity,oldRoot,{runs:[{sessionId:oldRoot}]}),{code:'geo_member_forbidden'},'caller-supplied snapshots are not authority');
 let expired;
 await authority.withRunSnapshot(identity,async snapshot=>{
  expired=snapshot;
  assert.equal(await authority.proveSession(identity,oldRoot,snapshot),oldRoot);
  await assert.rejects(authority.proveSession({...identity,principal:{...identity.principal,ownerId:'other-owner'}},oldRoot,snapshot),{code:'geo_member_forbidden'});
  // The canonical ledger is reusable; positive document proofs are not cached.
  await documents.put('owner','geo-plan-context',bindingId,{...binding.payload,requestId:'withdrawn-request'},{projectId:f.project.id,expectedRevision:binding.revision});
  await assert.rejects(authority.proveSession(identity,oldRoot,snapshot),{code:'runtime_session_not_found'});
 });
 await assert.rejects(authority.proveSession(identity,f.primary,expired),{code:'geo_member_forbidden'},'an internal token expires at the operation boundary');
 assert.equal(await f.capture(oldRoot),null);
 await assert.rejects(context.sourceScope(child),{code:'knowledge_scope_denied'});
});
