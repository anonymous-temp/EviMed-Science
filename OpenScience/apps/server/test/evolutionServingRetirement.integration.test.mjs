import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductJobs } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost test database is required' };
const owner = `serving_retired_${randomUUID().replaceAll('-', '')}`;
/** @type {any} */ let isolated, database;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evoretired');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Serving retired','development')", [owner]);
});
after(async () => { if (database) await database.close(); if (isolated) await isolated.drop(); });

test('every start cancels queued and lease-expired evolution jobs, keeps every row, and touches nothing else', options, async () => {
  const jobs = new ProductJobs(database);
  const queued = await jobs.enqueue(owner, 'evolution-event', { eventId: 'e', secret: 'kept' }, { idempotencyKey: 'queued' });
  const expired = await jobs.enqueue(owner, 'evolution-maintain', {}, { idempotencyKey: 'expired' });
  const live = await jobs.enqueue(owner, 'evolution-digest', {}, { idempotencyKey: 'live' });
  const finished = await jobs.enqueue(owner, 'evolution-mission', {}, { idempotencyKey: 'finished' });
  const other = await jobs.enqueue(owner, 'rsi-incident-export', { id: 'x' }, { idempotencyKey: 'other-kind' });
  await database.query("UPDATE evimed_product.jobs SET status='running',attempts=1,lease_token='lease',lease_expires_at=clock_timestamp()+CASE WHEN id=$1 THEN interval '-1 minute' ELSE interval '1 hour' END WHERE id=ANY($2::text[])", [expired.id, [expired.id, live.id]]);
  await database.query("UPDATE evimed_product.jobs SET status='succeeded',finished_at=clock_timestamp() WHERE id=$1", [finished.id]);
  const before = await database.query('SELECT * FROM evimed_product.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[live.id, finished.id, other.id]]);
  // The next start: a database object of its own runs the migration again.
  const again = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  try {
    await migrateProductStore(again);
    const rows = await database.query('SELECT * FROM evimed_product.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[queued.id, expired.id]]);
    assert.ok(rows.rows.every((/** @type {any} */ row) => row.status === 'canceled' && row.error.code === 'evolution_serving_retired' && row.lease_token === null));
    assert.equal(rows.rows.find((/** @type {any} */ row) => row.id === queued.id).payload.secret, 'kept');
    assert.equal(rows.rows.find((/** @type {any} */ row) => row.id === expired.id).attempts, 1);
    assert.deepEqual((await database.query('SELECT * FROM evimed_product.jobs WHERE id=ANY($1::text[]) ORDER BY id', [[live.id, finished.id, other.id]])).rows, before.rows, 'a live lease, a finished job and another kind stay as they were');
    // Every start: a job an old release queued after it, and the live lease once it has expired, go at the start after.
    const later = await jobs.enqueue(owner, 'evolution-event', {}, { idempotencyKey: 'later' });
    await database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [live.id]);
    const third = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
    try { await migrateProductStore(third); } finally { await third.close(); }
    assert.equal((await jobs.get(owner, later.id)).status, 'canceled');
    assert.equal((await jobs.get(owner, live.id)).status, 'canceled');
    assert.equal((await jobs.get(owner, finished.id)).status, 'succeeded');
  } finally { await again.close(); }
});
