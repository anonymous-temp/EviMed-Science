import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/geoNativeCompositionFixture.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required'};

test('actual owner and same-id personal editor stage first actions only after exact module opening',options,async t=>{
 const f=await fixture(t),geo=(await f.call('owner','POST','/api/geo/projects',{})).body.data;
 await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'editor',role:'editor'});
 const editor=await f.app.store.userById('editor');await f.app.store.createProject(editor,geo.projectId,'Personal collision');
 assert.equal((await f.call('editor','GET',`/api/geo/projects/${geo.id}`)).body.data.sessionId,null);assert.equal(f.creates(),0);
 const generic=await fetch(`${f.base}/api/runtime/sessions`,{method:'POST',headers:{...f.cookies.editor,'x-open-science-project':geo.projectId},body:'{}'});
 assert.equal(generic.status,200);const wrong=(await generic.json()).data.id;
 assert.equal((await f.call('editor','POST',`/api/geo/projects/${geo.id}/strategy/context`,{requestKey:'wrong-actor-plan',sessionId:wrong,mode:'strategy'})).status,404);
 for(const actor of ['owner','editor']) {
  const opened=await f.call(actor,'POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}});assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.notEqual(opened.body.data.sessionId,wrong);
  assert.equal((await f.call(actor,'POST',`/api/geo/projects/${geo.id}/strategy/context`,{requestKey:`first-${actor}-plan`,sessionId:opened.body.data.sessionId,mode:'strategy'})).status,200);
  assert.equal((await f.call(actor,'POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'session',sessionId:'absent-historical'}})).status,404);
 }
});

test('explicit GEO create, ensure and start reuse opening admission without yielding active work',options,async t=>{
 const f=await fixture(t),manager=f.app.runtimeManager,geo=(await f.call('owner','POST','/api/geo/projects',{})).body.data;
 const owner=await f.app.store.userById('owner'),old=await f.app.store.requireProject(owner,'default');
 manager.config.maxRunningRuntimesPerUser=1;manager.config.maxRunningRuntimes=10;
 manager.runtimes.set(manager.key(old),{kind:'mock',project:old,startedAt:new Date().toISOString(),close:async()=>{}});
 manager.runtimeActivity.set(manager.key(old),{activeProxies:1,lastUseAt:Date.now()});
 let active=true;
 manager.runtimeBusy=async()=>active;manager.hasRunningRuns=async()=>active;
 manager.stopIdleRuntime=async project=>{manager.runtimes.delete(manager.key(project));return true;};
 const start=manager.start,openings=[];
 manager.start=async(project,settings={})=>{
  openings.push(settings.opening===true);
  if(!manager.runtimes.has(manager.key(project))){await manager.makeRoomFor(project,settings);manager.enforceRuntimeCapacity(project);}
  return start(project,settings);
 };
 assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).status,429);
 assert.equal(manager.runtimes.has(manager.key(old)),true,'active runtime retained');assert.equal(f.creates(),0);
 active=false;
 const opened=await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}});
 assert.equal(opened.status,200,JSON.stringify(opened.body));assert.equal(manager.runtimes.has(manager.key(old)),false);
 const sessionId=opened.body.data.sessionId;
 assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/${sessionId}/start`,{})).status,200);
 assert.ok(openings.every(Boolean),'all explicit module starts retain opening:true');
 const target=await f.app.store.requireProject(owner,geo.projectId);openings.length=0;await manager.createRuntimeSession(target);
 assert.deepEqual(openings,[false],'ordinary session creation retains ordinary admission');
});

test('actual automatic module dispatch reads scoped KB with captured launch proof, never memory or delegated authority',options,async t=>{
 const f=await fixture(t),app=f.app,manager=app.runtimeManager,geo=(await f.call('owner','POST','/api/geo/projects',{})).body.data;
 // A shared GEO project: one with a member (a one-person GEO project is an owned project, owner ruling 2026-10-25).
 assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'editor',role:'editor'})).status,201);
 const primary=(await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).body.data.sessionId;
 const owner=await app.store.userById('owner'),project=await app.store.requireProject(owner,geo.projectId);
 const registry=await app.agentRegistry,agent=registry.get('geo-insight');
 app.residentProfiles.forDispatch=async()=>({text:'',due:false,memories:[],delivered:async()=>{}});
 app.agentRuns.captureBaseline=async()=>0;app.agentRuns.reconcileSession=async()=>null;
 app.agentRuns.scheduleMonitor=()=>{};app.agentRuns.recordRuntimePersonalSkills=async()=>{};
 manager.dispatchPrompt=async(current,sessionId,request)=>{
  await manager.start(current);await manager.callKernel(manager.runtimes.get(manager.key(current)),current,'session/create',{request:{sessionId}});
  await request.recordPromptActor({requestId:request.requestId,sessionId,mode:'queue',content:[{type:'text',text:request.text}]});
  return {accepted:true};
 };
 const dispatchId='geo-insight-background-a1';
 await app.geo.store.query(`INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,dispatch_id,detail)
  VALUES($1,'run:insight','owner','run','claimed',$2,$3::jsonb)`,[geo.id,dispatchId,JSON.stringify({capabilityId:agent.id,purpose:'insight'})]);
 const dispatched=await app.geo.orchestrator.dispatchRun({userId:'owner',projectId:project.id,geoProjectId:geo.id,capabilityId:agent.id,dispatchId,reason:'geo:evidence',brief:'Read project sources',question:'Review project evidence'});
 const run=(await app.agentRuns.list(project)).find(item=>item.id===dispatched.runId);assert.equal(run.automated,true);
 const context=await app.knowledgePages.knowledgeContext.forProject(project);
 assert.equal(await context.sourceScope(primary),null);assert.equal(await context.sourceScope(dispatched.sessionId),null);
 manager.subagentAddressFor=async(_project,parent,child)=>parent===dispatched.sessionId&&child==='managed-child'?{kind:'subagent',parentSessionId:parent,childSessionId:child,mode:'continuable'}:null;
 assert.equal(await context.sourceScope('managed-child'),null);
 await assert.rejects(context.sourceScope('unrelated-child'),{code:'knowledge_scope_denied'});
 const memory=await app.nativeMemoryContexts.forProject(project);
 assert.equal(await app.nativeMemoryContexts.proveCapture(memory,`dsh-${dispatched.sessionId}`),null);
 assert.equal(await app.nativeMemoryContexts.proveCapture(memory,'dsh-managed-child'),null);
 await assert.rejects(app.geoNativeAuthority.resolve(owner,{kind:'geo',geoProjectId:geo.id,sessionId:dispatched.sessionId}),{code:'runtime_session_not_found'});
 const unknown=await manager.createRuntimeSession(project);
 await app.researchSessions.put(project,unknown.id,{mode:'specialist',agentId:agent.id,agentVersion:agent.version});
 const session=await app.researchSessions.get(project,unknown.id);
 await app.agentRuns.reserveRun(project,session,{baselineCursor:0,dispatchId:'geo-forged-a1',automated:true,effectiveRouteReason:'geo:evidence',kernelRequestIds:['forged-request']});
 await assert.rejects(context.sourceScope(unknown.id),{code:'knowledge_scope_denied'});
 const row=(await app.geo.store.query('SELECT detail FROM evimed_geo.schedule_marks WHERE geo_project_id=$1 AND dispatch_id=$2',[geo.id,dispatchId])).rows[0];
 const original=row.detail.nativeKnowledgeDispatch;
 for(const changes of [{requestId:'not-a-run-request'},{capabilityVersion:'foreign-version'},{policy:{...original.policy,namespaceId:'old-namespace'}}]) {
  await app.geo.store.query(`UPDATE evimed_geo.schedule_marks SET detail=jsonb_set(detail,'{nativeKnowledgeDispatch}',$3::jsonb,true) WHERE geo_project_id=$1 AND dispatch_id=$2`,[geo.id,dispatchId,JSON.stringify({...original,...changes})]);
  await assert.rejects(context.sourceScope(dispatched.sessionId),{code:'knowledge_scope_denied'});
 }
 await app.geo.store.query(`UPDATE evimed_geo.schedule_marks SET detail=jsonb_set(detail,'{nativeKnowledgeDispatch}',$3::jsonb,true) WHERE geo_project_id=$1 AND dispatch_id=$2`,[geo.id,dispatchId,JSON.stringify(original)]);
 const runtime=manager.runtimes.get(manager.key(project));runtime.modelGatewayTokenJti='wrong-generation';
 await assert.rejects(context.sourceScope(dispatched.sessionId));runtime.modelGatewayTokenJti='fixture-generation';
});

test('unselected authenticated GEO primary freezes ordinary native routing with module tools scope', options, async t => {
  const f = await fixture(t, true, { llmRoutingEnabled: false });
  const geo = (await f.call('owner', 'POST', '/api/geo/projects', { brandName: 'Scoped product' })).body.data;
  const opened = (await f.call('owner', 'POST', `/api/geo/projects/${geo.id}/conversation/open`, { target: { kind: 'primary' } })).body.data;
  const frameResponse = await fetch(`${f.base}/api/runtime-ui/frames`, { method: 'POST', headers: f.cookies.owner,
    body: JSON.stringify({ projectId: geo.projectId, scope: opened.scope }) });
  assert.equal(frameResponse.status, 201);
  const frame = (await frameResponse.json()).data;
  const frameCookie = `${f.cookies.owner.cookie}; ${frameResponse.headers.get('set-cookie').split(';')[0]}`;
  const address = f.app.runtimeUi.address() ?? await f.app.runtimeUi.listen(0, '127.0.0.1');
  const owner = await f.app.store.userById('owner'), project = await f.app.store.requireProject(owner, geo.projectId);
  const kernel = f.app.runtimeManager.callKernel.bind(f.app.runtimeManager);
  f.app.runtimeManager.callKernel = async (...args) => {
    if (args[2] === 'session/page') return { items: [], hasMore: false };
    if (args[2] === 'session/projections') return { kind: 'sequenced', asOfSeq: 0, values: {} };
    return kernel(...args);
  };
  f.app.runtimeManager.proxy = async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'module-http', result: { ok: true, value: { accepted: true } } }));
  };
  const request = { requestId: 'module-product-only', sessionId: opened.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Only save product basics in this project. Do not start other steps.' }] };
  const response = await fetch(`http://127.0.0.1:${address.port}${new URL(frame.frameUrl).pathname}api/session/prompt`, {
    method: 'POST', headers: { ...f.cookies.owner, cookie: frameCookie, origin: 'http://127.0.0.1:8443' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'module-http', method: 'session/prompt', payload: { args: { request } } }),
  });
  assert.equal(response.status, 200, await response.text());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const directory = join(project.metaDir, 'native-routes');
  const records = await Promise.all((await readdir(directory)).map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))));
  const frozen = records.find(record => record.requestId === request.requestId);
  assert.equal(frozen.route.effectiveAgentId, 'open-domain-answer');
  assert.deepEqual(frozen.route.geoModuleScope, { version: 1, geoProjectId: geo.id, rootSessionId: opened.sessionId });
  assert.equal(frozen.route.geoContextRef, undefined);
  assert.equal((await f.app.geo.store.getProject('owner', geo.id)).steps.diagnosis.requested, false);
});
