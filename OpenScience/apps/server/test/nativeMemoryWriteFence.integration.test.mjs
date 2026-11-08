import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { withNativeMemoryWrite } from '../src/nativeMemoryWriteFence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativememoryfence');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  for (const id of ['fence-a', 'fence-b']) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Fence','development')", [id]);
  return { database, url: isolated.url };
}
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };

test('a writer holds no connection and no transaction while its operation runs', options, async t => {
  const { database } = await fixture(t);
  const started = gate(), finish = gate();
  const writer = withNativeMemoryWrite(database, 'fence-a', async () => { started.open(); await finish.promise; return 'done'; });
  await started.promise;
  assert.equal(database.pool.totalCount - database.pool.idleCount, 0, 'every pooled connection is back in the pool');
  const open = await database.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'");
  assert.equal(open.rows[0].n, 0);
  finish.open();
  assert.equal(await writer, 'done');
  assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases')).rows[0].n, 0, 'the lease is released');
});

test('cleanup is refused while a writer is active, and a writer while cleanup holds the account', options, async t => {
  const { database } = await fixture(t);
  const started = gate(), finish = gate();
  const writer = withNativeMemoryWrite(database, 'fence-a', async () => { started.open(); await finish.promise; });
  await started.promise;
  await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => 'x', { exclusive: true }), { status: 409, code: 'memory_source_cleanup_busy' });
  await withNativeMemoryWrite(database, 'fence-a', async () => 'second shared writer is fine');
  assert.equal(await withNativeMemoryWrite(database, 'fence-b', async () => 'other account', { exclusive: true }), 'other account');
  finish.open(); await writer;
  const cleanupStarted = gate(), cleanupDone = gate();
  const cleanup = withNativeMemoryWrite(database, 'fence-a', async () => { cleanupStarted.open(); await cleanupDone.promise; }, { exclusive: true });
  await cleanupStarted.promise;
  await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => 'x'), { status: 409, code: 'memory_source_cleanup_busy' });
  assert.equal(await withNativeMemoryWrite(database, 'fence-a', async () => 'nested', { exclusive: false }).catch(error => error.code), 'memory_source_cleanup_busy');
  cleanupDone.open(); await cleanup;
  assert.equal(await withNativeMemoryWrite(database, 'fence-a', async () => 'after'), 'after');
});

test('a write inside an active write of the same account is one holder, and an operation error passes through and releases', options, async t => {
  const { database } = await fixture(t);
  await withNativeMemoryWrite(database, 'fence-a', async () => {
    assert.equal(await withNativeMemoryWrite(database, 'fence-a', async () => 'inner'), 'inner');
  }, { exclusive: true });
  await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => { throw new Error('operation failed'); }), /operation failed/);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases')).rows[0].n, 0);
});

test('the lease of a crashed writer stops blocking once it expires', options, async t => {
  const { database } = await fixture(t);
  await withNativeMemoryWrite(database, 'fence-a', async () => 1);
  await database.query("INSERT INTO evimed_memory.native_writer_leases(user_id,lease_id,kind,expires_at) VALUES('fence-a','crashed','exclusive', clock_timestamp()+interval '1 hour')");
  await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => 1), { code: 'memory_source_cleanup_busy' });
  await database.query("UPDATE evimed_memory.native_writer_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id='crashed'");
  assert.equal(await withNativeMemoryWrite(database, 'fence-a', async () => 'ok', { exclusive: true }), 'ok');
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases WHERE lease_id='crashed'")).rows[0].n, 0, 'swept');
});
