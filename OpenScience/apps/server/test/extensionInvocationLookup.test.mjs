import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionInvocationLookup } from '../src/extensionInvocationLookup.mjs';
import { createExtensionInvocationResolver } from '../src/extensionGateway.mjs';

function fixture() {
  const auth = { userId: 'u', projectId: 'p', runtimeGeneration: 'generation-1' };
  const invocation = { sessionId: 'session-1', agentId: 'session-1', callId: 'call-1', rootCallId: 'call-1', toolName: 'doc_read', runtimeGeneration: 'generation-1' };
  const state = { running: true, origin: 'root', turn: { startSeq: 1, end: null }, toolTurnStartSeq: 1, tools: ['doc_read'], generation: 'generation-1',
    parts: [{ type: 'tool', callId: 'call-1', tool: 'doc_read', status: 'pending', input: { resourceId: 'resource-1', options: { limit: 1 } } }] };
  const lookup = createExtensionInvocationLookup({
    resolveActor: async () => state.actor === false ? null : auth,
    store: { userById: async id => id === 'u' ? { id } : null, requireProject: async (_user, id) => ({ id, userId: 'u' }) },
    runtimeManager: {
      extensionInvocationFacts: async () => ({ sessionId: 'session-1', agentId: 'session-1', runtimeGeneration: state.generation, tools: state.tools, running: state.running, origin: state.origin }),
      sessionTranscript: async (_project, _id, options) => { assert.deepEqual(options, { wake: false }); state.historyReads=(state.historyReads??0)+1;state.beforeHistory?.(state.historyReads);return { sessionId: 'session-1', turns: [{...state.turn}], messages: [{ parts: structuredClone(state.parts), turnStartSeq: state.toolTurnStartSeq, seq: 4 }] }; },
    },
  });
  return { auth, invocation, state, lookup, resolve: createExtensionInvocationResolver({ lookup }) };
}

test('native pending call arguments bind the gateway request, with current direct owned session and registry', async () => {
  const f = fixture();
  const request = { operation: 'doc_read', resourceId: 'resource-1', options: { limit: 1 } };
  assert.equal((await f.resolve(f.auth, f.invocation, request)).invocationId, 'call-1');
  await assert.rejects(f.resolve(f.auth, f.invocation, { ...request, resourceId: 'foreign-resource' }), { code: 'extension_access_denied' });
});

test('completed, duplicate, foreign, child, PTC, removed tool and replaced runtime calls carry no authority', async () => {
  for (const mutate of [
    f => { f.state.parts[0].status = 'completed'; },
    f => { f.state.parts.push({ ...f.state.parts[0] }); },
    f => { f.state.running = false; },
    f => { f.state.origin = 'subagent'; },
    f => { f.state.turn.end = { kind: 'completed' }; },
    f => { f.state.toolTurnStartSeq = 0; },
    f => { f.invocation.sessionId = f.invocation.agentId = 'child-1'; },
    f => { f.invocation.rootCallId = 'parent-1'; },
    f => { f.state.tools = []; },
    f => { f.state.generation = 'generation-2'; },
    f => { f.state.parts[0].input.operation = 'doc_read'; },
    f => { f.state.actor = false; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(await f.lookup(f.auth, f.invocation), null);
  }
});

test('a registry revocation or stopped native turn during history lookup refuses dispatch', async () => {
  const f = fixture();
  let reads = 0;
  const lookup = createExtensionInvocationLookup({ store: { userById: async () => ({ id: 'u' }), requireProject: async () => ({ id: 'p' }) },
    resolveActor: async () => f.auth,
    runtimeManager: { extensionInvocationFacts: async () => ({ ...f.invocation, tools: ['doc_read'], running: ++reads === 1, origin: 'root' }),
      sessionTranscript: async () => ({ sessionId: 'session-1', turns: [{ startSeq: 1, end: null }], messages: [{ parts: f.state.parts, turnStartSeq: 1 }] }) } });
  assert.equal(await lookup(f.auth, f.invocation), null);
});

test('an accepted current native call remains available before asynchronous run-ledger adoption', async () => {
  const f=fixture();assert.equal((await f.lookup(f.auth,f.invocation)).pending,true);
});

test('a new turn, settled tool or changed input between independent history reads refuses late execution', async () => {
  for(const change of [
    state=>{state.turn.startSeq=5;},
    state=>{state.turn.end={kind:'completed'};},
    state=>{state.parts[0].status='completed';},
    state=>{state.parts[0].input.resourceId='different';},
  ]){const f=fixture();f.state.beforeHistory=n=>{if(n===2)change(f.state);};assert.equal(await f.lookup(f.auth,f.invocation),null);}
});
