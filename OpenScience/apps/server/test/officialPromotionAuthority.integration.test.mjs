import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { promotionAccountIdentities, promotionActivationAuthority } from '../src/officialPromotionAuthority.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !databaseUrl && 'A loopback test PostgreSQL is required.', timeout: 15000 };
if (databaseUrl) { const url = new URL(databaseUrl); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /^\/evimed_test/); }

async function fixture(t) {
  const database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  const writer = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  t.after(async () => { await writer.close(); await database.close(); });
  await database.migrate(); await migrateProductStore(database);
  await writer.migrate(); await migrateProductStore(writer);
  const prefix = randomUUID(), publisher = `publisher-${prefix}`, author = `author-${prefix}`, witness = `witness-${prefix}`;
  for (const id of [publisher, author, witness]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Synthetic promotion authority','development')", [id]);
  const documents = new ProductDocuments(database), otherDocuments = new ProductDocuments(writer);
  const candidate = await documents.put(publisher, 'preferences', 'candidate', { recordType: 'official-promoted', status: 'candidate' }, { expectedRevision: 0 });
  const peer = await documents.put(publisher, 'preferences', 'witness', { recordType: 'official-promoted', status: 'candidate' }, { expectedRevision: 0 });
  const identities = await promotionAccountIdentities(documents, [author, witness]);
  const proof = { publisherId: publisher, candidate: { id: candidate.id, revision: candidate.revision }, witnesses: [{ id: peer.id, revision: peer.revision }],
    accounts: [...identities].map(([id, createdAt]) => ({ id, createdAt })) };
  return { database, writer, documents, otherDocuments, publisher, author, witness, proof, authority: promotionActivationAuthority(documents) };
}
async function waitForBlockedWriter(database) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (result.rows[0].n > 0) return;
    await delay(10);
  }
  assert.fail('The concurrent writer never reached the held authority lock.');
}

test('a witness changed before admission refuses activation without modifying the candidate', options, async t => {
  const f = await fixture(t);
  await f.otherDocuments.put(f.publisher, 'preferences', 'witness', { status: 'rejected' }, { expectedRevision: 1 });
  await assert.rejects(f.authority(f.proof, () => f.documents.put(f.publisher, 'preferences', 'candidate', { status: 'active' }, { expectedRevision: 1 })), { code: 'official_promotion_authority_changed' });
  assert.equal((await f.documents.get(f.publisher, 'preferences', 'candidate')).payload.status, 'candidate');
});

test('the exact witness stays locked through the activation commit', options, async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const activation = f.authority(f.proof, async () => { enter(); await held; return f.documents.put(f.publisher, 'preferences', 'candidate', { status: 'active' }, { expectedRevision: 1 }); });
  await entered;
  const withdrawal = f.otherDocuments.put(f.publisher, 'preferences', 'witness', { status: 'rejected' }, { expectedRevision: 1 });
  try { await waitForBlockedWriter(f.writer); } finally { release(); }
  assert.equal((await activation).payload.status, 'active'); await withdrawal;
  assert.equal((await f.documents.get(f.publisher, 'preferences', 'witness')).payload.status, 'rejected');
});

test('a witness account cannot disappear before the activation transaction commits', options, async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const activation = f.authority(f.proof, async () => { enter(); await held; return f.documents.put(f.publisher, 'preferences', 'candidate', { status: 'active' }, { expectedRevision: 1 }); });
  await entered;
  const deletion = f.writer.query('DELETE FROM evimed_control.users WHERE id=$1', [f.witness]);
  try { await waitForBlockedWriter(f.writer); } finally { release(); }
  assert.equal((await activation).payload.status, 'active'); await deletion;
});

test('an account incarnation differing by one microsecond cannot inherit publication authority', options, async t => {
  const f = await fixture(t);
  await f.writer.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 microsecond' WHERE id=$1", [f.witness]);
  await assert.rejects(f.authority(f.proof, () => f.documents.put(f.publisher, 'preferences', 'candidate', { status: 'active' }, { expectedRevision: 1 })), { code: 'official_promotion_authority_changed' });
  assert.equal((await f.documents.get(f.publisher, 'preferences', 'candidate')).payload.status, 'candidate');
});
