import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/geoStore.mjs';
import { contextPolicyIdentity } from '../src/geoContextItems.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };

// This protocol fixture certifies production composition and real HTTP/DB
// identity handling. It is not a runtime launch or installed-kernel receipt.
async function fixture(t, geoEnabled = true) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'geocomposition');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-composition-'));
  let creates = 0;
  const sessions = new Map();
  const app = createWebApiApp({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', geoEnabled, geoAudience: 'all',
    runtimeMode: 'mock', devAuth: false, authMode: 'local', bootstrapUser: '', bootstrapPassword: '',
    runtimeUiProxyEnabled: true, publicUrl: 'http://127.0.0.1', runtimeUiPublicOrigin: 'http://127.0.0.1:8443', databasePoolMax: 1 }, {
    runtimeManagerFactory: (config, hooks) => {
      const manager = new RuntimeManager(config, hooks);
      manager.start = async project => {
        const key = manager.key(project);
        if (!manager.runtimes.has(key)) manager.runtimes.set(key, { kind: 'mock', project, close: async () => {}, modelGatewayTokenJti: 'fixture-generation', startedAt: new Date().toISOString() });
        return manager.runtimes.get(key);
      };
      manager.stop = async project => { manager.runtimes.delete(manager.key(project)); };
      manager.ensureContextPolicyGeneration = async () => ({ adopted: false });
      manager.assertContextPolicyGeneration = async project => {
        assert.equal(typeof project.workspaceDir,"string","proof uses the canonical full owner project");
        const policy = await manager.contextPolicies.forProject(project);
        assert.equal(policy.kind, 'geo-project');
        if (manager.runtimeGeneration(project) !== 'fixture-generation') throw Object.assign(new Error('Old generation'), {status:409});
        const identity={recordType:'geo-runtime-context-launch',version:1,state:'launched',generation:'fixture-generation',digest:'1'.repeat(64),policy:contextPolicyIdentity(policy)};
        const referenceId=`gcr_${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
        const existing=await manager.contextDocuments.get(project.userId,'geo-plan-context',referenceId);
        if(!existing)await manager.contextDocuments.put(project.userId,'geo-plan-context',referenceId,{...identity,referenceId},{projectId:project.id,expectedRevision:0});
        return {...identity,referenceId};
      };
      manager.createRuntimeSession = async project => {
        await manager.start(project); creates += 1;
        const id = `native-${creates}`;
        sessions.set(manager.key(project), [...(sessions.get(manager.key(project)) ?? []), { sessionId:id }]);
        return { id, kernel:'dsh' };
      };
      manager.subagentAddressFor = async () => null;
      manager.callKernel = async (_runtime, project, method) => {
        assert.equal(method, 'session/list');
        return { items: sessions.get(manager.key(project)) ?? [] };
      };
      return manager;
    },
  });
  t.after(async () => { await app.close(); await isolated.drop(); await rm(dataDir,{recursive:true,force:true}); });
  for (const id of ['owner','editor','viewer']) await app.store.createUser(id, 'composition-password', id);
  const address = await app.listen(0, '127.0.0.1');
  await app.geo?.worker.close();
  const base = `http://127.0.0.1:${address.port}`, cookies = {};
  for (const id of ['owner','editor','viewer']) {
    const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:id,password:'composition-password'})});
    const body=await response.json(); cookies[id]={'content-type':'application/json',cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),'x-open-science-csrf':body.data.csrfToken};
  }
  const call=async(user,method,route,body)=>{const response=await fetch(`${base}${route}`,{method,headers:cookies[user],...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  return {app,call,sessions,creates:()=>creates};
}

test('the production factory shares one context floor and all native memory/provenance readers', options, async t => {
  const {app}=await fixture(t, false);
  assert.equal(app.runtimeManager.contextPolicies,app.sharedContextPolicies);
  assert.equal(app.runtimeManager.contextItems,app.contextItems);
  assert.equal(app.nativeMemory.memoryContexts,app.nativeMemoryContexts);
  assert.equal(app.nativeMemoryWorker.memoryContexts,app.nativeMemoryContexts);
  assert.equal(app.nativeTurnCommit.memoryContexts,app.nativeMemoryContexts);
  assert.equal(app.residentProfiles.contextPolicies,app.sharedContextPolicies);
  assert.equal(app.nativeRememberJournal.contexts,app.nativeMemoryContexts);
  assert.equal(app.contextProvenance.contextItems,app.contextItems);
  await assert.rejects(app.geoNativeAuthority.identity({id:"owner"},"unknown"),error=>error.status===404);
});

test('module header is side-effect free; owner/editor exact descriptors and frame renewal retain canonical authority', options, async t => {
  const f=await fixture(t);
  const created=await f.call('owner','POST','/api/geo/projects',{brandName:'Composition fixture'});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const geo=created.body.data;
  await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'editor',role:'editor'});
  await f.call('owner','POST',`/api/geo/projects/${geo.id}/members`,{userId:'viewer',role:'viewer'});
  assert.equal(geo.sessionId,null); assert.equal(geo.bound,false);
  assert.equal(f.creates(),0,'project creation never starts a runtime');
  const before=f.creates();
  const header=await f.call('editor','GET',`/api/geo/projects/${geo.id}`);
  assert.equal(header.status,200,JSON.stringify(header.body));assert.equal(f.creates(),before); assert.equal(header.body.data.sessionId,null);
  const opened=await f.call('editor','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}});
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  const descriptor=opened.body.data;
  assert.equal(descriptor.projectId,geo.projectId); assert.equal(f.creates(),1);
  assert.equal((await f.call('editor','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).body.data.sessionId,descriptor.sessionId); assert.equal(f.creates(),1);
  assert.equal((await f.call('viewer','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).status,403);
  assert.equal((await f.call('viewer','GET',`/api/geo/projects/${geo.id}/conversation/${descriptor.sessionId}/runs`)).status,200);
  assert.equal((await f.call('editor','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'session',sessionId:'foreign'}})).status,404);
  const frame=await f.call('editor','POST','/api/runtime-ui/frames',{projectId:geo.projectId,scope:descriptor.scope});
  assert.equal(frame.status,201,JSON.stringify(frame.body));
  const ticket=frame.body.data;
  assert.equal((await f.call('editor','POST',`/api/runtime-ui/frames/${ticket.frameId}/renew`,{renewalToken:ticket.renewalToken})).status,200);
  const editor=await f.app.store.userById('editor'), ownerForInput=await f.app.store.userById('owner');
  const ownerProject=await f.app.store.requireProject(ownerForInput,geo.projectId);
  const principal=(await f.app.geoNativeAuthority.resolve(editor,descriptor.scope)).principal;
  const request={requestId:'factory-native-input',sessionId:descriptor.sessionId,mode:'queue',content:[{type:'text',text:'Keep the denominator visible.'}]};
  await f.app.geoNativeSelections.prepare(editor,ownerProject,request);
  await f.app.geoNativeInputs.prepare({user:editor,project:ownerProject,claims:{frameId:ticket.frameId,delegation:principal},request});
  const journal=f.app.geoNativeInputs;
  const result=await f.app.runtimeManager.pluginService.withAdmission(ownerProject,()=>journal.execute(request,operation=>f.app.geoNativeAuthority.withFrame(editor,principal,operation),async()=>{
    await journal.beforeForward(request);journal.observe(request,{state:'accepted',authority:'native-mux'});
  }),{prompt:true,promptDisposition:()=>journal.disposition(request)});
  assert.equal(result.error,null);
  const transcript=normalizeTranscript(descriptor.sessionId,[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}},{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}]);
  const attribution=await journal.reconcileTurn(ownerProject,transcript,{startSeq:0,inputs:transcript.messages.filter(message=>message.role==='user')},{id:'factory-run',sessionId:descriptor.sessionId,nativeTurn:{startSeq:0},kernelRequestIds:[request.requestId]});
  assert.equal(attribution.complete,true);assert.equal(attribution.inputs[0].actor.id,'editor');
  assert.equal(attribution.namespaceId,(await f.app.sharedContextPolicies.forProject(ownerProject)).namespace.id);
  await f.app.geo.store.removeMember({geoId:geo.id,userId:'editor',role:'editor'});
  assert.ok([403,404].includes((await f.call('editor','POST',`/api/runtime-ui/frames/${ticket.frameId}/renew`,{renewalToken:ticket.renewalToken})).status));
  assert.equal((await f.call('owner','GET',`/api/geo/projects/${geo.id}`)).body.data.sessionId,descriptor.sessionId);
  const owner=await f.app.store.userById('owner'),project=await f.app.store.requireProject(owner,geo.projectId);
  const memoryContext=await f.app.nativeMemoryContexts.forProject(project);
  f.app.config.geoEnabled=false;
  const proof=await f.app.nativeMemoryContexts.proveCapture(memoryContext,`dsh-${descriptor.sessionId}`);
  assert.equal(proof.rootSessionId,descriptor.sessionId);assert.ok(proof.rootProofRefs.length);
  const captured=await f.app.nativeMemoryContexts.noteCapture(memoryContext,`dsh-${descriptor.sessionId}`);
  assert.equal(captured.payload.namespaceId,memoryContext.namespaceId);
  assert.equal((await f.call('owner','POST',`/api/geo/projects/${geo.id}/conversation/open`,{target:{kind:'primary'}})).status,404);
  assert.equal(f.creates(),1,'disabled module cannot commission a session');
  assert.equal(await f.app.nativeMemoryContexts.proveCapture(memoryContext,'dsh-forged'),null);
});

/** A GEO project with an editor, and the owner's own conversations in its control project and in the kernel's inventory. */
async function geoWithEditor(f, brandName = 'Adoption fixture') {
  const created = await f.call('owner', 'POST', '/api/geo/projects', { brandName });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const geo = created.body.data;
  assert.equal((await f.call('owner', 'POST', `/api/geo/projects/${geo.id}/members`, { userId: 'editor', role: 'editor' })).status, 201);
  const project = await f.app.store.requireProject(await f.app.store.userById('owner'), geo.projectId);
  const key = f.app.runtimeManager.key(project);
  const listed = id => f.sessions.set(key, [...(f.sessions.get(key) ?? []), { sessionId: id }]);
  const conversation = id => f.app.researchSessions.put(project, id, { mode: 'open-domain' });
  const open = user => f.call(user, 'POST', `/api/geo/projects/${geo.id}/conversation/open`, { target: { kind: 'primary' } });
  return { geo, project, key, listed, conversation, open };
}

test('an editor\'s first open begins the shared conversation; only the owner\'s open keeps the owner\'s own', options, async t => {
  const f = await fixture(t);
  const first = await geoWithEditor(f);
  await first.conversation('owner-private'); first.listed('owner-private');
  const opened = await first.open('editor');
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.notEqual(opened.body.data.sessionId, 'owner-private'); assert.equal(f.creates(), 1);
  assert.equal((await f.call('editor', 'GET', `/api/geo/projects/${first.geo.id}/conversation/owner-private/history`)).status, 404);
  assert.equal((await f.call('owner', 'GET', `/api/geo/projects/${first.geo.id}`)).body.data.sessionId, opened.body.data.sessionId);
  const second = await geoWithEditor(f, 'Owner fixture');
  await second.conversation('owner-worked-in'); second.listed('owner-worked-in');
  assert.equal((await second.open('owner')).body.data.sessionId, 'owner-worked-in'); assert.equal(f.creates(), 1);
  assert.equal((await second.open('editor')).body.data.sessionId, 'owner-worked-in');
});

test('a failed read of the recorded conversation registers nothing in its place', options, async t => {
  const f = await fixture(t);
  const g = await geoWithEditor(f);
  await g.conversation('older-chat'); g.listed('older-chat');
  await g.conversation('recorded-chat'); g.listed('recorded-chat');
  assert.equal(await f.app.geo.store.setConversationSession(g.geo.id, 'recorded-chat'), 'recorded-chat');
  const read = f.app.store.getResearchSession.bind(f.app.store);
  let failing = true;
  f.app.store.getResearchSession = async (project, sessionId) => {
    if (failing && sessionId === 'recorded-chat') { failing = false; throw new Error('transient read failure'); }
    return read(project, sessionId);
  };
  const failed = await g.open('owner');
  assert.ok(failed.status >= 500, JSON.stringify(failed.body));
  const opened = await g.open('owner');
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); assert.equal(opened.body.data.sessionId, 'recorded-chat');
});

test('a conversation the kernel no longer has is never registered, and a missing primary is replaced by its owner', options, async t => {
  const f = await fixture(t);
  const g = await geoWithEditor(f);
  await g.conversation('stale-chat');
  const opened = await g.open('owner');
  assert.equal(opened.status, 200, JSON.stringify(opened.body)); assert.equal(opened.body.data.sessionId, 'native-1');
  f.sessions.set(g.key, []);
  const member = await g.open('editor');
  assert.equal(member.status, 404); assert.equal(member.body.error?.code ?? member.body.code, 'runtime_session_not_found');
  const repaired = await g.open('owner');
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body)); assert.equal(repaired.body.data.sessionId, 'native-2');
  assert.equal((await g.open('editor')).body.data.sessionId, 'native-2');
});

test('the owner\'s read registers a kept conversation only while the running kernel lists it', options, async t => {
  const f = await fixture(t);
  const g = await geoWithEditor(f);
  await g.conversation('owner-chat'); g.listed('owner-chat');
  const header = () => f.call('owner', 'GET', `/api/geo/projects/${g.geo.id}`);
  assert.equal((await header()).body.data.sessionId, null, 'a read starts no runtime and so proves nothing yet');
  await f.app.runtimeManager.start(g.project);
  assert.equal((await header()).body.data.sessionId, 'owner-chat');
  assert.equal((await g.open('editor')).body.data.sessionId, 'owner-chat'); assert.equal(f.creates(), 0);
});
