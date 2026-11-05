import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationSourceDeletionService, filterDeletedConversationValue, conversationIdsInRequest } from '../src/conversationSourceDeletionService.mjs';

function fixture() {
  const rows = new Map(), calls = [], project = { userId: 'owner', id: 'p', createdAt: 'project-incarnation' };
  let busy = false, stopFails = false, generation = 'g1';
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
