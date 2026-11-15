import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoNativeMemoryRemember } from '../src/geoNativeMemoryRemember.mjs';

test('shared remember keeps the kernel source through its durable journal and reconciliation', async () => {
  const saved = [], commits = [];
  const context = { kind: 'geo-project', ownerId: 'u', projectId: 'named', namespaceId: 'namespace', policyRef: 'policy' };
  const journal = new GeoNativeMemoryRemember({ contexts: { withOwner: async (_user, action) => action('stamp', {}), assertLive: async () => {},
    documents: { put: async (_user, _kind, id, payload) => { const row = { id, payload }; saved.push(row); return row; } } },
    overlay: { recordCommit: async row => commits.push(row) } });
  const operation = await journal.begin(context, [{ role: 'user', content: 'My project fact.' }], 'generation', 'dsh-native');
  assert.equal(operation.payload.sourceSession, 'dsh-native');
  journal.update = async (_context, _id, changes) => ({ ...operation, payload: { ...operation.payload, ...changes } });
  await journal.recordLedger(context, { ...operation, payload: { ...operation.payload, archiveUri: 'archive', sessionId: 'mcp-store-1', taskId: 'task', ledgerState: 'pending' } });
  assert.equal(commits[0].sourceSession, 'dsh-native');
  assert.equal(saved.length, 1);
});
