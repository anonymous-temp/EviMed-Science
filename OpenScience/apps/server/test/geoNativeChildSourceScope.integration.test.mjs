import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/geoNativeCompositionFixture.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required'};

async function setup(t,background,{shared=true}={}) {
 const f=await fixture(t,true,{sourceIngestionEnabled:true,sourceIngestionPollMs:3600000}),app=f.app,manager=app.runtimeManager;
 const geo=(await f.call('owner','POST','/api/geo/projects',{})).body.data;
 // A shared project's sources are its context's; a one-person project is an owned one (owner ruling 2026-10-25).
 if(shared) assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'editor',role:'editor'})).status,201);
 const primary=(await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).body.data.sessionId;
 const owner=await app.store.userById('owner'),project=await app.store.requireProject(owner,geo.projectId);
 let root=primary;
 if(background) {
  const agent=(await app.agentRegistry).get('geo-insight');
  app.residentProfiles.forDispatch=async()=>({text:'',due:false,memories:[],delivered:async()=>{}});
  app.agentRuns.captureBaseline=async()=>0;app.agentRuns.reconcileSession=async()=>null;
  app.agentRuns.scheduleMonitor=()=>{};app.agentRuns.recordRuntimePersonalSkills=async()=>{};
  manager.dispatchPrompt=async(current,sessionId,request)=>{
   await manager.start(current);await manager.callKernel(manager.runtimes.get(manager.key(current)),current,'session/create',{request:{sessionId}});
   await request.recordPromptActor({requestId:request.requestId,sessionId,mode:'queue',content:[{type:'text',text:request.text}]});
   return {accepted:true};
  };
  const dispatchId='geo-insight-source-scope-a1';
  await app.geo.store.query(`INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,dispatch_id,detail)
   VALUES($1,'run:insight','owner','run','claimed',$2,$3::jsonb)`,[geo.id,dispatchId,JSON.stringify({capabilityId:agent.id,purpose:'insight'})]);
  root=(await app.geo.orchestrator.dispatchRun({userId:'owner',projectId:project.id,geoProjectId:geo.id,capabilityId:agent.id,dispatchId,reason:'geo:evidence',brief:'Read selected sources',question:'Review selected evidence'})).sessionId;
 }
 const child='verified-source-child';
 manager.subagentAddressFor=async(_project,parent,requested)=>parent===root&&requested===child?{kind:'subagent',parentSessionId:parent,childSessionId:requested,mode:'continuable'}:null;
 const scope=async sessionId=>(await app.knowledgePages.knowledgeContext.forProject(project)).sourceScope(sessionId);
 return {...f,app,manager,geo,owner,project,root,child,scope};
}

async function selectedSource(f) {
 await f.app.sourceWorker.close();
 const response=await fetch(`${f.base}/api/files/upload`,{method:'POST',headers:{...f.cookies.owner,'x-open-science-project':f.project.id},body:JSON.stringify({root:'base',path:'knowledge-base/selected-source.md',data:'Only the selected project source.',encoding:'utf8'})});
 const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 const id=body.data.source.id;
 const source=await f.app.sourceService.get(f.owner.id,id);
 await f.app.sourceService.override(f.owner.id,id,{expectedRevision:source.revision,docType:source.payload.docType,depth:'index_only',reason:'Local source-scope fixture; no model analysis'});
 for(let n=0;n<30;n+=1) {
  await f.app.sourceWorker.tick();
  const queued=await f.app.store.database.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND kind='ingest' AND status IN ('queued','running')",[f.owner.id]);
  if(!queued.rows.length)break;
  await f.app.store.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND kind='ingest' AND status='queued'",[f.owner.id]);
 }
 const context=await f.app.knowledgePages.knowledgeContext.forProject(f.project);
 assert.ok(context.inputs.some(input=>input.receipt.sourceId===id),'available source was ingested locally');
 return id;
}

for(const background of [false,true]) test(`${background?'automatic module':'primary'} child inherits only its proved root source selection`,options,async t=>{
 const f=await setup(t,background);
 await f.app.researchSessions.setSourceScope(f.project,f.root,[`src_${'a'.repeat(32)}`]);
 assert.deepEqual(await f.scope(f.root),[]);
 assert.deepEqual(await f.scope(f.child),[],'missing root selection cannot become unrestricted in a child');
 const sourceId=await selectedSource(f);
 await f.app.researchSessions.setSourceScope(f.project,f.root,[sourceId]);
 // Even an independently saved child record cannot override the canonical root.
 await f.app.researchSessions.setSourceScope(f.project,f.child,[`src_${'f'.repeat(32)}`]);
 assert.deepEqual(await f.scope(f.root),[sourceId]);
 assert.deepEqual(await f.scope(f.child),[sourceId],'verified child keeps the available root source');
 const resolveChild=f.manager.subagentAddressFor;let selectionChanged=false;
 f.manager.subagentAddressFor=async(...args)=>{
  const address=await resolveChild(...args);
  if(address&&!selectionChanged){selectionChanged=true;await f.app.researchSessions.setSourceScope(f.project,f.root,[`src_${'b'.repeat(32)}`]);}
  return address;
 };
 assert.deepEqual(await f.scope(f.child),[],'a source choice changed during proof is read from the root again');
 f.manager.subagentAddressFor=resolveChild;
 await f.app.researchSessions.setSourceScope(f.project,f.root,[sourceId]);
 const source=await f.app.sourceService.get(f.owner.id,sourceId);
 await f.app.sourceService.remove(f.owner.id,sourceId,{expectedRevision:source.revision});
 assert.deepEqual(await f.scope(f.root),[]);
 assert.deepEqual(await f.scope(f.child),[],'deleted selected source stays empty, never unrestricted');
 await f.app.researchSessions.setSourceScope(f.project,f.root,[`src_${'a'.repeat(32)}`]);
 assert.deepEqual(await f.scope(f.root),[]);assert.deepEqual(await f.scope(f.child),[],'unavailable selected source stays empty');
 await f.app.researchSessions.setSourceScope(f.project,f.root,null);
 assert.equal(await f.scope(f.root),null);assert.equal(await f.scope(f.child),null,'only an unselected root is unrestricted');
 await assert.rejects(f.scope('unrelated-child'),{code:'knowledge_scope_denied'});
 let childProofs=0;
 f.manager.subagentAddressFor=async(_project,parent,child)=>parent===f.root&&child===f.child&&childProofs++===0?{kind:'subagent',parentSessionId:parent,childSessionId:child,mode:'continuable'}:null;
 await assert.rejects(f.scope(f.child),{code:'knowledge_scope_denied'},'proof lost between authorization and selection read must deny');
 f.manager.subagentAddressFor=async()=>null;
 await assert.rejects(f.scope(f.child),{code:'knowledge_scope_denied'});
 const runtime=f.manager.runtimes.get(f.manager.key(f.project));runtime.modelGatewayTokenJti='unproved-generation';
 await assert.rejects(f.scope(f.root));runtime.modelGatewayTokenJti='fixture-generation';
 if(background) {
  const memory=await f.app.nativeMemoryContexts.forProject(f.project);
  assert.equal(await f.app.nativeMemoryContexts.proveCapture(memory,`dsh-${f.root}`),null);
  await assert.rejects(f.app.geoNativeAuthority.resolve(f.owner,{kind:'geo',geoProjectId:f.geo.id,sessionId:f.root}),{code:'runtime_session_not_found'});
 }
});
