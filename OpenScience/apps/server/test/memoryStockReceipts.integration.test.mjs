import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { MemoryHistoryLedger } from '../src/memoryHistoryPersistence.mjs';
import { contentHash, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { stockCounts } from '../../../scripts/ops/memory-stock-receipts.mjs';

const { options, fixture } = nativeIntegration();
test('withdrawal counts correlate the exact stock generation and the derived digest inside a read-only transaction', options, async t => {
  const f = await fixture(t);
  const ledger = new MemoryHistoryLedger({ database: f.database, overlay: f.overlay });
  await ledger.migrate();
  const uri = f.root + '/notes/stock.md', prior = '- Old measurement.\n- Other measurement.', after = '- Other measurement.';
  const item = { kind: 'native', uri, owner: f.userId, hash: contentHash(prior), fingerprint: lineFingerprint('Old measurement.') };
  const chunk = { kind: 'chunk', uri: uri + '/derived', owner: f.userId, hash: 'c'.repeat(64) };
  t.after(() => f.database.query('DELETE FROM evimed_memory.history_chunks WHERE uri=$1', [chunk.uri]));
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'notes', body: prior });
  await f.overlay.reject(f.userId, 'notes', uri, ['Old measurement.']);
  await f.database.query(`INSERT INTO evimed_memory.history_forget_scans
    (id,owner_id,owner_created_at,namespace_id,user_root,memory_type,fingerprint,cutoff,archives,state,memory_sweep)
    VALUES($1,$1,'test','','root','notes',$2,now(),'{}','complete',$3)`,
    [f.userId, item.fingerprint, { done: true, files: [{ uri, hash: item.hash, afterExactHash: contentHash(after) }] }]);
  await f.database.query(`INSERT INTO evimed_memory.history_chunks
    (uri,owner_id,owner_created_at,namespace_id,project_id,project_created_at,session_id,archive_uri,digest,state,cleaned_at)
    VALUES($1,$2,'test','','default','test','s','archive',$3,'withdrawn',now())`, [chunk.uri, f.userId, chunk.hash]);
  const inspect = items => f.database.withClient(async c => {
    await c.query('BEGIN READ ONLY');
    try { return await stockCounts(c, items); } finally { await c.query('ROLLBACK'); }
  });
  assert.equal((await inspect([item])).present, 1);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'notes', body: after });
  assert.deepEqual(await inspect([item, chunk, { ...chunk, hash: 'f'.repeat(64) }]), { status: 'unverified', cleaned: 2, unverified: 1, present: 0 });
  assert.equal((await inspect([{ ...item, owner: 'other-account' }])).unverified, 1);
});
