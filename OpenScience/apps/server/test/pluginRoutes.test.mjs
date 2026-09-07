import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createPluginRoutes} from '../src/pluginRoutes.mjs';
import {PluginService,pluginEntry,pluginRegistryFrom,pluginState,validatePluginConfig} from '../src/pluginService.mjs';
import {HttpError,sendError} from '../src/security.mjs';

// Two registered plugins, so every route is exercised against a registry that
// is a set rather than one hard-coded id. The widened apply-path set is what
// landing a second bundle looks like; the shipped registry stays capped, and
// `pluginService.test.mjs` is where that cap is asserted.
const registry=pluginRegistryFrom({communityToolBundles:[
  {name:'dsh-cite',version:'0.3.2',status:'installed',tools:['cite_lookup']},
  {name:'dsh-notes',version:'1.0.0',status:'installed'},
],},new Set(['dsh-cite','dsh-notes']));

/**
 * A real `PluginService` with only its two database operations replaced.
 *
 * Removal, admission of a plugin id, configuration validation and the state
 * projection are the shipped implementations, so what the routes are tested
 * against is the behaviour the routes will meet — a stub that agrees with the
 * route by construction would prove the route calls a stub and nothing else.
 * @param {any} t
 */
async function harness(t,{calls=[]}={}){
  const owner={id:'owner'};
  /** @type {Map<string,any>} */
  const documents=new Map();
  const state=id=>pluginState(pluginEntry(id,registry),documents.get(id)??null,{});
  const service=new PluginService({},{jobs:{},registry});
  service.list=async(user,project)=>{calls.push(['list',user.id,project.id]);return{plugins:[...registry.keys()].map(state)};};
  service.get=async(user,project,id)=>state(id);
  service.save=async(user,project,input,id)=>{
    const entry=pluginEntry(id,registry);
    const value=validatePluginConfig(input,15000,entry);
    const revision=documents.get(id)?.revision??0;
    if(input.expectedRevision!==revision)throw new HttpError(409,'product_revision_conflict','Reload first.');
    calls.push(['save',user.id,project.id,id]);
    documents.set(id,{revision:revision+1,phase:'pending',effective:null,error:null,
      payload:{schemaVersion:1,pluginId:entry.id,binaryVersion:entry.version,...value}});
    return state(id);
  };
  service.history=async(user,project,id)=>{calls.push(['history',user.id,project.id,id]);return{items:[]};};
  service.rollback=async()=>({phase:'pending'});
  service.retry=async()=>({phase:'pending'});
  const store={ensureSessionUser:async req=>{if(req.headers.cookie!=='fixture=active')throw new HttpError(401,'unauthorized','Login required.');return{user:owner};},
    assertCsrf:async req=>{if(req.method!=='GET'&&req.headers['x-open-science-csrf']!=='csrf')throw new HttpError(403,'csrf_required','CSRF required.');},
    requireProject:async(_owner,id)=>{if(id!=='owned')throw new HttpError(404,'project_not_found','Project unavailable.');return{id,userId:owner.id};}};
  const route=createPluginRoutes({store,service,maxJsonBytes:8192});
  const server=createServer((req,res)=>{route(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>sendError(res,error));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  return{base:`http://127.0.0.1:${server.address().port}/api/projects`,calls,documents,
    revision:id=>documents.get(id)?.revision??0,
    headers:{cookie:'fixture=active','x-open-science-csrf':'csrf','content-type':'application/json'}};
}

test('plugin routes require session, CSRF and owned project; reject unsupported binaries and settings',async t=>{
  const {base,headers,calls}=await harness(t);
  assert.equal((await fetch(`${base}/owned/plugins`)).status,401);
  assert.equal((await fetch(`${base}/other/plugins`,{headers})).status,404);
  for(const id of ['dsh-browse','dsh-python','other'])assert.equal((await fetch(`${base}/owned/plugins/${id}`,{headers})).status,404);
  const body=JSON.stringify({expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers:{cookie:headers.cookie},body})).status,403);
  assert.equal(calls.length,0);
  const list=await fetch(`${base}/owned/plugins`,{headers});assert.equal(list.status,200);
  assert.deepEqual((await list.json()).data.plugins.map(p=>p.id),['dsh-cite','dsh-notes']);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers,body})).status,200);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers,body:JSON.stringify({...JSON.parse(body),userId:'other'})})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite/retry`,{method:'POST',headers,body:'{"token":"override"}'})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite/retry`,{method:'POST',headers,body:'{}'})).status,200);
  assert.deepEqual(calls,[['list','owner','owned'],['save','owner','owned','dsh-cite']]);
});

test('an unknown plugin id is refused on every verb, including removal',async t=>{
  const {base,headers,calls}=await harness(t);
  for(const [method,body] of [['GET',undefined],['PUT','{"expectedRevision":0,"enabled":true,"settings":{}}'],['DELETE','{"expectedRevision":0}']]){
    const response=await fetch(`${base}/owned/plugins/dsh-writing-guard`,{method,headers,body});
    assert.equal(response.status,404,`${method} on an unregistered plugin must 404`);
    assert.equal((await response.json()).code,'plugin_not_supported');
  }
  for(const suffix of ['/revisions','/rollback','/retry']){
    const method=suffix==='/revisions'?'GET':'POST';
    assert.equal((await fetch(`${base}/owned/plugins/dsh-writing-guard${suffix}`,{method,headers,body:method==='GET'?undefined:'{}'})).status,404);
  }
  assert.deepEqual(calls,[]);
});

test('a second registered plugin is configurable through the same routes without touching dsh-cite',async t=>{
  const {base,headers,calls,revision}=await harness(t);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-notes`,{method:'PUT',headers,body:'{"expectedRevision":0,"enabled":false,"settings":{}}'})).status,200);
  // dsh-notes declares no settings, so dsh-cite's settings are not its schema.
  assert.equal((await fetch(`${base}/owned/plugins/dsh-notes`,{method:'PUT',headers,body:'{"expectedRevision":1,"enabled":false,"settings":{"timeoutMs":4000}}'})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-notes/revisions`,{headers})).status,200);
  assert.equal(revision('dsh-notes'),1);
  assert.equal(revision('dsh-cite'),0,'configuring another plugin must not move dsh-cite');
  assert.deepEqual(calls,[['save','owner','owned','dsh-notes'],['history','owner','owned','dsh-notes']]);
});

test('removal is authenticated, CSRF-guarded, revision-checked and idempotent',async t=>{
  const {base,headers,calls,revision}=await harness(t);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',body:'{"expectedRevision":0}'})).status,401);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers:{cookie:headers.cookie},body:'{"expectedRevision":0}'})).status,403);
  const first=await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers,body:'{"expectedRevision":0}'});
  assert.equal(first.status,200);
  const removed=(await first.json()).data;
  assert.equal(removed.removed,true);
  assert.equal(removed.desired.enabled,false);
  assert.equal(revision('dsh-cite'),1,'removal is a recorded configuration revision, not a deletion');
  // Idempotent at the revision it produced; stale expectations are refused.
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers,body:'{"expectedRevision":1}'})).status,200);
  assert.equal(revision('dsh-cite'),1,'a repeated removal must not append another revision');
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers,body:'{"expectedRevision":0}'})).status,409);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers,body:'{"expectedRevision":1,"purge":true}'})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'DELETE',headers,body:''})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite/revisions`,{method:'DELETE',headers,body:'{"expectedRevision":1}'})).status,404);
  assert.equal(revision('dsh-cite'),1);
  // Removal reaches storage exactly once: the repeat recognised the state it
  // was asked for and wrote nothing, rather than saving the same thing again.
  assert.deepEqual(calls,[['save','owner','owned','dsh-cite']]);
});
