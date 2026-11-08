import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { withNativeMemoryWrite, NATIVE_WRITER_LEASE_MS } from '../src/nativeMemoryWriteFence.mjs';
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

test('a nested exclusive inside a shared write is refused, and work detached from a released lease takes a fence of its own', options, async t => {
  const { database } = await fixture(t);
  await withNativeMemoryWrite(database, 'fence-a', async () => {
    await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => 'x', { exclusive: true }), { code: 'memory_source_cleanup_busy' }, 'never silently run shared');
  });
  const gateOpen = gate(); let detached;
  await withNativeMemoryWrite(database, 'fence-a', async () => {
    detached = (async () => { await gateOpen.promise; return withNativeMemoryWrite(database, 'fence-a', async () => (await database.query("SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases WHERE user_id='fence-a'")).rows[0].n); })();
  });
  gateOpen.open();
  assert.equal(await detached, 1, 'the detached call holds a lease of its own');
  assert.equal((await database.query('SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases')).rows[0].n, 0);
  assert.equal(NATIVE_WRITER_LEASE_MS, 120_000);
});

test('a lease that was swept while its operation runs is taken again by the renewal', options, async t => {
  const { database } = await fixture(t);
  const finish = gate(), started = gate();
  const writer = withNativeMemoryWrite(database, 'fence-a', async () => { started.open(); await finish.promise; }, { leaseMs: 4000 });
  await started.promise;
  await database.query("DELETE FROM evimed_memory.native_writer_leases WHERE user_id='fence-a'");
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_memory.native_writer_leases WHERE user_id='fence-a'")).rows[0].n, 1, 'renewal found no row and re-admitted it');
  finish.open(); await writer;
});

test('admission never waits on a lock another transaction holds: a held lease mutex answers the retry code within the lock timeout', options, async t => {
  const { database } = await fixture(t);
  await withNativeMemoryWrite(database, 'fence-a', async () => 1);
  const held = gate(), inside = gate();
  const holder = database.transaction(async client => { await client.query("SELECT pg_advisory_xact_lock(hashtextextended('native-memory-lease:fence-a',0))"); inside.open(); await held.promise; });
  await inside.promise;
  const started = Date.now();
  await assert.rejects(withNativeMemoryWrite(database, 'fence-a', async () => 1), { status: 409, code: 'memory_source_cleanup_busy' });
  assert.ok(Date.now() - started < 6000, 'bounded by lock_timeout, not by the holder');
  held.open(); await holder;
});

test('the native migration runs outside a caller\'s transaction and the stamp backfill leaves a marker', options, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'nativememorymigr');
  let database;
  t.after(async () => { await database?.close(); await isolated.drop(); });
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  const { migrateNativeMemory } = await import('../src/nativeMemoryPersistence.mjs');
  const { migrateMemorySettings } = await import('../src/memorySettingsPersistence.mjs');
  await migrateMemorySettings(database);
  await assert.rejects(database.transaction(async () => { await migrateNativeMemory(database); throw new Error('caller rolls back'); }), /caller rolls back/);
  const present = await database.query("SELECT to_regclass('evimed_memory.native_markers') IS NOT NULL AS ok, to_regclass('evimed_memory.native_writer_leases') IS NOT NULL AS leases");
  assert.deepEqual(present.rows[0], { ok: true, leases: true }, 'the memoised DDL survives the caller\'s rollback');
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_memory.native_markers WHERE name='project-stamps-v1'")).rows[0].n, 1);
});
