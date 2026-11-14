import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryForgetReader, forgetAuthorityView, forgetDependencies } from '../src/memoryForgetPropagation.mjs';

function fixture() {
  let removed = true;
  const runs = new Map([['r1', { sessionId: 'source', question: 'A harmless title' }]]);
  const methods = new Map([['m1', { payload: { body: 'A paraphrased derived procedure', provenance: { runId: 'r1' } } }]]);
  const allowed = createMemoryForgetReader({
    context: async (_user, projectId) => projectId ?? 'owned', // null now means "no authority can exist"
    rejected: async (scope, texts) => scope !== 'shared' && removed && texts.some(text => text.includes('M-41633')),
    sourcesRejected: async (scope, refs) => scope !== 'shared' && removed && refs.sessions.includes('source'),
    // The removal here stands for a deleted source conversation too, so a source that no longer resolves can be from it.
    conversationsDeleted: async scope => scope !== 'shared' && removed,
    resolveRun: async (_user, _project, id) => runs.get(id), resolveMethod: async (_user, id) => methods.get(id),
  });
  return { allowed, undo: () => { removed = false; }, runs, methods };
}

test('literal copies in every payload field and attachment are withheld, including projected metadata', async () => {
  const f = fixture();
  for (const payload of [{content:'M-41633'}, {body:'A method', files:[{path:'reference.md',content:'M-41633'}]},
    {title:'M-41633'}, {provenance:{evidence:[{quote:'M-41633'}]}}]) assert.equal(await f.allowed('u', {payload}), false);
  assert.equal(await f.allowed('u', {payload:{content:'Independent preference'}}), true);
});

test('a paraphrased method and a merge inherit source withdrawal; undo restores without changing stored records', async () => {
  const f = fixture(), merged = {payload:{body:'No original words', provenance:{mergedFrom:[{methodId:'m1'}]}}};
  assert.equal(await f.allowed('u', merged), false);
  f.undo();
  assert.equal(await f.allowed('u', merged), true);
});

test('shared scope and other accounts are resolved structurally, never inferred from a prose id', async () => {
  const f = fixture();
  assert.equal(await f.allowed('u', {projectId:'shared',payload:{content:'M-41633'}}), true);
  assert.equal(await f.allowed('u', {payload:{content:'The string source is prose.'}}), true);
  assert.deepEqual(forgetDependencies({provenance:[{type:'run',id:'r1'}],sourceRunIds:['r2'],body:'runId r3'}).runs, ['r1','r2']);
});

test('cyclic merges terminate and still inspect each dependency', async () => {
  const f = fixture();
  f.methods.set('m2', {payload:{provenance:{mergedFrom:[{methodId:'m3'}]}}});
  f.methods.set('m3', {payload:{files:{'notes.md':'M-41633'},provenance:{mergedFrom:[{methodId:'m2'}]}}});
  assert.equal(await f.allowed('u', {payload:{provenance:{mergedFrom:[{methodId:'m2'}]}}}), false);
});

test('a missing declared source cannot silently lift withdrawal after source-conversation cleanup', async () => {
  const f = fixture();
  f.runs.delete('r1');
  assert.equal(await f.allowed('u',{payload:{provenance:{runId:'r1'},body:'A paraphrased method'}}),false);
});

test('a source run inherits its recorded shared namespace instead of falling back to personal memory', async () => {
  const allowed = createMemoryForgetReader({
    context:async(_user,_project,value)=>value.payload?.provenance?.contextPolicy?.kind === 'geo-project' ? 'shared' : 'owned',
    rejected:async()=>false,sourcesRejected:async(scope,refs)=>scope === 'shared' && refs.sessions.includes('shared-source'),
    resolveRun:async()=>({sessionId:'shared-source'}),resolveMethod:async()=>null,
  });
  assert.equal(await allowed('u',{payload:{provenance:{contextPolicy:{kind:'geo-project'},sourceProjectId:'p',runId:'r'}}}),false);
});

test('FT12 an unresolvable source is no evidence after a project deletion; after a conversation deletion it still withholds', async () => {
  let conversationDeleted = false;
  const allowed = createMemoryForgetReader({ context: async (_user, projectId) => projectId ?? 'owned', hasWithdrawals: async () => true,
    rejected: async () => false, sourcesRejected: async () => false, conversationsDeleted: async () => conversationDeleted,
    resolveRun: async () => null, resolveMethod: async () => null });
  const method = { payload: { body: 'Align every citation marker.', provenance: { sourceProjectId: 'project-gone', runId: 'run_1', mergedFrom: [{ methodId: 'gone' }] } } };
  assert.equal(await allowed('u', method), true, 'the deleted project took its runs; the method follows its own lifecycle');
  conversationDeleted = true;
  assert.equal(await allowed('u', method), false, 'a deleted source conversation of that scope may have been its source');
});

test('FT12 an unavailable memory context answers from the authority still readable and never fails the reader', async () => {
  const denied = async () => { throw Object.assign(new Error('The project memory context is unavailable or changed.'), { code: 'memory_scope_denied' }); };
  const owned = { kind: 'owned', id: 'personal' }, shared = { kind: 'geo-project', id: 'shared' };
  assert.equal(await forgetAuthorityView(denied, denied), null, 'no owner row: no authority can exist');
  assert.equal(await forgetAuthorityView(denied, async () => [owned]), owned, 'an inconsistent shared policy still leaves personal authority');
  assert.equal(await forgetAuthorityView(async () => [owned], denied, view => view.kind === 'geo-project'), owned, 'an unavailable shared binding falls back to personal');
  assert.equal(await forgetAuthorityView(async () => [owned, shared], denied, view => view.id === 'shared'), shared);
  await assert.rejects(forgetAuthorityView(async () => { throw new Error('database down'); }, denied), /database down/, 'an unreadable ledger is not "nothing forgotten"');
  const rejected = async (/** @type {any} */ scope, /** @type {string[]} */ texts) => scope !== null && texts.some(text => text.includes('M-41633'));
  const reader = (/** @type {() => Promise<any[]>} */ views) => createMemoryForgetReader({ context: () => forgetAuthorityView(views, denied),
    rejected, sourcesRejected: async () => false, resolveRun: async () => null, resolveMethod: async () => null });
  assert.equal(await reader(denied)('u', { payload: { body: 'Align citations.', provenance: { runId: 'r1' } } }), true);
  assert.equal(await reader(async () => [owned])('u', { payload: { content: 'My old project is M-41633.' } }), false, 'an available context still withholds');
  assert.equal(await reader(async () => [owned])('u', { payload: { content: 'Independent preference.' } }), true);
});
