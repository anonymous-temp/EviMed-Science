import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationSourceDeletionService, filterDeletedConversationValue, conversationIdsInRequest } from '../src/conversationSourceDeletionService.mjs';

function fixture() {
  const rows = new Map(), calls = [], project = { userId: 'owner', id: 'p', createdAt: 'project-incarnation' };
  let busy = false, stopFails = false; const generation = 'g1';
  const ledger = {
    async scope() { return { accountCreatedAt: 'account-incarnation', projectCreatedAt: 'project-incarnation' }; },
    async get(_project, sessionId) { return [...rows.values()].find(r => r.sessionIds.includes(sessionId)) ?? null; },
    async put(value) { rows.set(value.id, value); calls.push('tombstone'); return value; },
    async pending() { return [...rows.values()].filter(r => r.cleanup !== 'complete'); },
    async update(row, change) { Object.assign(row, change); return row; },
    async exclusive(_project, work) { calls.push('lock'); return work(); },
    async assertIdentity(row) { if (row.projectCreatedAt !== project.createdAt) throw new Error('incarnation changed'); },
  };
  const runtime = {
    async captureConversationSource() { return { root: { id: 'a', createdAt: 11, cwd: '/workspace', isSeeded: false }, sessions: [{ id: 'a' }, { id: 'child' }], generation }; },
    async purgeConversationSource(_project, frozen, guard) { await guard(); calls.push('idle'); if (busy) return { sourceRemoved: false, reason: 'busy' }; if (stopFails) throw new Error('stop failed'); calls.push('purge'); assert.equal(frozen.root.id, 'a'); return { sourceRemoved: true }; },
  };
  const service = new ConversationSourceDeletionService({ ledger, runtime, resolveProject: async () => project,
    removeDerived: async () => calls.push('derived'), removeHistory: async () => calls.push('history') });
  return { rows, calls, project, service, busy: value => { busy = value; }, stopFails: value => { stopFails = value; } };
}

test('source deletion first persists an irreversible fence, then withdraws history, and reports pending until physical completion', async () => {
  const f = fixture(); f.busy(true);
  const result = await f.service.request(f.project, 'a');
  assert.equal(result.sourceRemoved, false); assert.equal(result.cleanup, 'pending');
  assert.ok(f.calls.indexOf('tombstone') < f.calls.indexOf('history'));
  await assert.rejects(f.service.assertAvailable(f.project, 'a'), { status: 404 });
  await assert.rejects(f.service.assertAvailable(f.project, 'child'), { status: 404 });
  await f.service.assertAvailable(f.project, 'independent');
  await f.service.drain(); assert.equal(f.calls.includes('purge'), false);
  f.busy(false); await f.service.drain();
  assert.equal((await f.service.status(f.project, 'a')).sourceRemoved, true);
  assert.ok(f.calls.indexOf('purge') < f.calls.indexOf('derived'));
});

test('stop and derived failures remain pending for retry, and tombstones survive later completion', async () => {
  const f = fixture(); await f.service.request(f.project, 'a'); f.stopFails(true);
  await f.service.drain(); assert.equal((await f.service.status(f.project, 'a')).cleanup, 'pending');
  f.stopFails(false); await f.service.drain(); await assert.rejects(f.service.assertAvailable(f.project, 'a'), { status: 404 });
});

test('project reincarnation refuses cleanup instead of deleting the new project', async () => {
  const f = fixture(); await f.service.request(f.project, 'a'); f.project.createdAt = 'new-project';
  await f.service.drain(); assert.equal(f.calls.includes('purge'), false);
});

test('projection filtering suppresses deleted transcripts, events and workspace references while preserving independent forks', () => {
  const gone = new Set(['a', 'child']);
  assert.equal(filterDeletedConversationValue({sessionId:'a',messages:['secret']},gone), null);
  assert.equal(filterDeletedConversationValue({type:'emit',event:'api-session/status',args:['a',false]},gone),null);
  assert.deepEqual(filterDeletedConversationValue({ sessions:[{id:'a',title:'secret'},{id:'b'},{id:'fork',parentSession:'a'}], sessionIds:['a','b'], pinned:['a','b'], archived:['child','b'] },gone),
    {sessions:[{id:'b'},{id:'fork',parentSession:'a'}],sessionIds:['b'],pinned:['b'],archived:['b']});
  assert.deepEqual(conversationIdsInRequest('session/fork',{args:{request:{sessionId:'a',id:'new'}}}), ['a','new']);
  assert.deepEqual(conversationIdsInRequest('fileUploads/upload',{args:{agentId:'a',request:{name:'file'}}}), ['a']);
});

import { RuntimeManager } from '../src/runtimeManager.mjs';

test('physical purge requires every independent idle proof and a confirmed provider stop', async () => {
  const calls = [], project = {userId:'u',id:'p'};
  let verdict = 'unknown', kernelBusy = false, pending = false, stop = true;
  const captured = { root:{id:'a'},generation:'g1' }, runtime = {};
  const manager = Object.assign(Object.create(RuntimeManager.prototype), {
    config:{runtimeProvider:'docker'},runtimes:new Map([['u:p',runtime]]),starts:new Map(),runtimeStops:new Map(),failedRuntimeStops:new Map(),
    sourceMaintenance:new Set(),key:()=> 'u:p',runtimeGeneration:()=> 'g1',
    pluginService:{hasPendingPrompts:async()=>pending},hasRunningRuns:async()=>false,
    idleVerdict:async()=>verdict,pluginRuntimeBusy:async()=>kernelBusy,
    stopIdleRuntime:async(_p,options)=>{calls.push('stop'); if(stop&&await options.guard()){manager.runtimes.clear();return true;}return false;},
    runtimeController:{purgeConversationSource:async()=>{calls.push('files');return {sourceRemoved:true};}},
  });
  const purge = () => manager.purgeConversationSource(project,captured,async()=>true);
  assert.equal((await purge()).sourceRemoved,false); assert.deepEqual(calls,[]);
  verdict='idle'; kernelBusy=true; await purge(); assert.deepEqual(calls,[]);
  kernelBusy=false; pending=true; await purge(); assert.deepEqual(calls,[]);
  pending=false; stop=false; await purge(); assert.deepEqual(calls,['stop']);
  stop=true; assert.equal((await purge()).sourceRemoved,true); assert.deepEqual(calls,['stop','stop','files']);
});

test('session control maps and native added events remove complete deleted records rather than leaving anonymous content', () => {
  const gone=new Set(['a']);
  assert.deepEqual(filterDeletedConversationValue({type:'baseline',value:{projections:{a:{values:{answer:'secret'}},b:{values:{answer:'kept'}}}}},gone),
    {type:'baseline',value:{projections:{b:{values:{answer:'kept'}}}}});
  assert.equal(filterDeletedConversationValue({type:'emit',event:'api-session/added',args:[{sessionId:'a',title:'secret'}]},gone),null);
});

import { AgentRunStore } from '../src/agentRuns.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('source cleanup erases target ledger words and preserved transcripts while keeping independent work and file inventory', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'source-ledger-'));
  const project={userId:'u',id:'p',rootDir:root,workspaceDir:path.join(root,'workspace'),metaDir:path.join(root,'.openscience')};
  await mkdir(project.workspaceDir,{recursive:true});await mkdir(project.metaDir,{recursive:true});
  const store=new AgentRunStore({get:async(_p,id)=>({sessionId:id,mode:'open-domain',agentId:null,agentVersion:null,runtimeAgent:null})},{model:'deepseek/fixture',readSessionHistory:async()=>[],monitorIntervalMs:60000});
  t.after(async()=>{await store.closeProject(project);await rm(root,{recursive:true,force:true});});
  const a=await store.start(project,{sessionId:'a'}), b=await store.start(project,{sessionId:'b'});
  await store.recordRunLabels(project,a.id,{question:'Source A secret'});await store.recordRunLabels(project,b.id,{question:'Independent B question'});
  await store.closeProject(project);
  const ledger=path.join(project.metaDir,'runs.jsonl');
  const events=(await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
  for(const event of events)if(event.id===a.id&&event.event==='finished')event.outputFiles=['report.txt'];
  await writeFile(ledger,events.map(JSON.stringify).join('\n')+'\n');
  await mkdir(path.join(project.metaDir,'transcripts'),{recursive:true});
  await writeFile(path.join(project.metaDir,'transcripts',a.id+'.jsonl'),'Source A secret');
  await writeFile(path.join(project.metaDir,'transcripts',b.id+'.jsonl'),'Independent B transcript');
  await writeFile(path.join(project.workspaceDir,'report.txt'),'Useful deliverable');
  await store.removeConversationSource(project,['a']);
  assert.doesNotMatch(await readFile(ledger,'utf8'),/Source A secret/);
  await assert.rejects(readFile(path.join(project.metaDir,'transcripts',a.id+'.jsonl')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(project.metaDir,'transcripts',b.id+'.jsonl'),'utf8'),'Independent B transcript');
  assert.equal(await readFile(path.join(project.workspaceDir,'report.txt'),'utf8'),'Useful deliverable');
  const once=await readFile(ledger,'utf8');
  await store.removeConversationSource(project,['a']);
  assert.equal(await readFile(ledger,'utf8'),once,'periodic source cleanup is byte idempotent');
  const list=await store.list(project);assert.equal(list.find(run=>run.id===b.id).question,'Independent B question');
  assert.deepEqual(list.find(run=>run.id===a.id).outputFiles,['report.txt']);
});

test('reading an independent transcript preserves literal objects that happen to name the deleted id', async () => {
  const service=new ConversationSourceDeletionService({ledger:{get:async(_p,id)=>id==='a'?{}:null,deletedIds:async()=>['a']},runtime:{},resolveProject:async()=>{},removeHistory:async()=>{},removeDerived:async()=>{}});
  const transcript={sessionId:'b',messages:[{role:'user',parts:[{type:'text',data:{id:'a',content:'An independent literal example'}}]}]};
  assert.deepEqual(await service.projectValue({},'session/page',{args:{request:{sessionId:'b'}}},transcript),{forward:true,value:transcript});
});

test('pending deletion refreshes the trusted transitive managed closure before late child disclosure or input',async()=>{
  const row={id:'deletion',rootSessionId:'a',sessionIds:['a'],frozen:{root:{id:'a',createdAt:1,cwd:'/workspace',isSeeded:false}},cleanup:'pending',sourceRemoved:false};
  const root=row.frozen.root;
  const service=new ConversationSourceDeletionService({ledger:{pendingForProject:async()=>[row],get:async(_p,id)=>row.sessionIds.includes(id)?row:null,deletedIds:async()=>row.sessionIds,extendSessions:async(_r,ids)=>row.sessionIds=[...new Set([...row.sessionIds,...ids])]},runtime:{captureConversationSource:async()=>({root,sessions:[root,{id:'late',origin:'subagent',parentSession:'a'},{id:'grand',origin:'subagent',parentSession:'late'}]})},resolveProject:async()=>{},removeHistory:async()=>{},removeDerived:async()=>{}});
  await assert.rejects(service.authorize({},'session/page',{args:{request:{sessionId:'grand'}}}),{status:404});
  assert.equal((await service.projectValue({},'$events',{args:{}},{type:'emit',event:'api-session/added',args:[{sessionId:'late',origin:'subagent',parentSessionId:'a'}]})).forward,false);
  const kept=await service.projectValue({},'session/list',{args:{}},{items:[{sessionId:'late',origin:'subagent',parentSessionId:'a'},{sessionId:'fork',isSeeded:true,parentSessionId:'a'}]});
  assert.deepEqual(kept.value.items,[{sessionId:'fork',isSeeded:true,parentSessionId:'a'}]);
});
