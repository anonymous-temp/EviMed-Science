import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentMemoryRoutes } from '../src/agentMemoryRoutes.mjs';
import { AGENT_KEY_SCOPES } from '../src/agentApiKeys.mjs';
import { MemoryHistory } from '../src/memoryHistory.mjs';
import { createMemoryHistorySources } from '../src/memoryHistorySources.mjs';

async function status() {
  const routes = createAgentMemoryRoutes({ config: { agentMemoryApiInternalUsers: ['u'] }, capsules: {},
    apiKeys: { resolve: async () => ({ userId: 'u', scopes: [...AGENT_KEY_SCOPES], keyId: 'k' }) }, store: { userById: async () => ({ id: 'u' }) } });
  const res = { data: null, writeHead() {}, end(text) { this.data = JSON.parse(text).data; } };
  await routes({ method: 'GET', url: '/api/agent-memory/v1', headers: { authorization: 'Bearer test' } }, res);
  return res.data.capabilities;
}

test('conversation ingestion discloses its missing history authority instead of offering a partial importer', async () => {
  const capability = (await status()).conversationIngest;
  assert.equal(capability.available, false);
  assert.equal(capability.reason, 'external_conversation_history_authority_unavailable');
  assert.deepEqual(capability.requiredScopes, ['memory.ingest']);
  assert.equal(capability.internalOnly, true);
  assert.equal(AGENT_KEY_SCOPES.includes('memory.ingest'), false, 'an unimplemented host scope is not mintable');
});

test('the current history producer refuses an external session before reading an archive', async () => {
  let reads = 0;
  const context = { kind: 'owned', ownerId: 'u', userRoot: 'viking://user/u-test', sessions: { read: async () => { reads++; return ''; } } };
  const history = new MemoryHistory({ config: {}, ledger: {}, contexts: {}, resolveSource: async () => null, eligible: async () => true, admitMessage: async () => true });
  const result = await history.indexArchive({ userId: 'u', engineSession: 'external-one', archiveUri: `${context.userRoot}/sessions/external-one/history/archive_001` }, context);
  assert.deepEqual(result, { state: 'excluded', reason: 'not_original_conversation' }); assert.equal(reads, 0);
  const source = createMemoryHistorySources({ config: {}, store: { userById: async () => ({ id: 'u' }), requireProject: async () => ({ id: 'p', userId: 'u' }) },
    productDatabase: { query: async () => ({ rows: [{ stamp: '2026-01-01' }] }) }, nativeMemoryContexts: { assertLive: async () => {} },
    nativeMemoryOverlay: { projectOfSession: async () => 'p' }, agentRuns: { conversationRuns: async () => [{ id: 'r', question: 'Keep green folders.' }] } });
  assert.equal(await source.resolveSource({ projectId: 'p', engineSession: 'external-one' }, context), null);
  const native = await source.resolveSource({ projectId: 'p', engineSession: 'dsh-one' }, context);
  assert.equal(native.sessionId, 'one'); assert.equal(native.conversationTitle, 'Keep green folders.');
});
