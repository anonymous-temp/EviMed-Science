// The bound on what serving writes at a rate, on the real ledger: what a pass takes, in what order, when it refuses, and that the scan has its index.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { EVOLUTION_RETENTION_DUE_SELECT, compactEvolutionRecords } from '../src/evolutionRetention.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost test database is required' };
const owner = `retention_${randomUUID()}`;
/** @type {any} */ let isolated, database, documents, jobs;
/** @param {string} id @param {string} recordType @param {string|null} retainUntil @param {Record<string, any>} [extra] */
const row = (id, recordType, retainUntil, extra = {}) => documents.put(owner, 'knowledge', id, { recordType, ...(retainUntil ? { retainUntil } : {}), ...extra }, { expectedRevision: 0, projectId: 'research' });
const left = async () => (await database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' ORDER BY id", [owner])).rows.map((/** @type {any} */ entry) => entry.id);
const now = new Date('2026-11-05T00:00:00Z');

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evoretain');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Operator','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'research','Research',1048576)", [owner]);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
  await documents.get(owner, 'knowledge', 'migrates-the-store');
});
after(async () => { if (database) { await database.close(); await isolated.drop(); } });

test('a pass takes at most the batch, oldest first, and the next pass the rest; what carries no date or is not yet due stays', options, async () => {
  await row('signal-3', 'evolution-signal', '2026-10-03T00:00:00.000Z');
  await row('signal-1', 'evolution-signal', '2026-10-01T00:00:00.000Z');
  await row('occurrence-2', 'evolution-lead-occurrence', '2026-10-02T00:00:00.000Z');
  await row('signal-future', 'evolution-signal', '2026-12-01T00:00:00.000Z');
  await row('signal-history', 'evolution-signal', null);
  await row('other-kind', 'evolution-tool', '2026-10-01T00:00:00.000Z');
  await row('event-queued', 'evolution-event', '2026-10-01T00:00:00.000Z', { status: 'queued' });
  assert.equal(await compactEvolutionRecords(database, owner, { config: { evolutionRetentionBatchRows: 2 }, now }), 2);
  assert.deepEqual(await left(), ['event-queued', 'other-kind', 'signal-3', 'signal-future', 'signal-history'], 'the two oldest went');
  assert.equal(await compactEvolutionRecords(database, owner, { config: { evolutionRetentionBatchRows: 2 }, now }), 1);
  assert.deepEqual(await left(), ['event-queued', 'other-kind', 'signal-future', 'signal-history'], 'and the next pass took the rest');
});

test('a processed event goes with its finished job and its revisions; a job still queued stays', options, async () => {
  await row('event-done', 'evolution-event', '2026-10-01T00:00:00.000Z', { status: 'processed' });
  await row('event-live', 'evolution-event', '2026-10-01T00:00:00.000Z', { status: 'processed' });
  const done = await jobs.enqueue(owner, 'evolution-event', { eventId: 'event-done' }, { idempotencyKey: 'evolution:event-done' });
  await jobs.enqueue(owner, 'evolution-event', { eventId: 'event-live' }, { idempotencyKey: 'evolution:event-live' });
  await database.query("UPDATE evimed_product.jobs SET status='succeeded',finished_at=clock_timestamp() WHERE id=$1", [done.id]);
  assert.ok((await compactEvolutionRecords(database, owner, { now })) >= 2);
  const keys = (await database.query('SELECT idempotency_key FROM evimed_product.jobs WHERE user_id=$1 ORDER BY 1', [owner])).rows.map((/** @type {any} */ entry) => entry.idempotency_key);
  assert.deepEqual(keys, ['evolution:event-live']);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.revisions WHERE user_id=$1 AND id='event-done'", [owner])).rows[0].n, 0);
});

test('a pass refuses during maintenance and on its caller\'s admission, and deletes nothing', options, async () => {
  await row('signal-maintenance', 'evolution-signal', '2026-10-01T00:00:00.000Z');
  assert.equal(await compactEvolutionRecords(database, owner, { now, admission: () => false }), 0);
  await database.query("INSERT INTO evimed_product.maintenance_lease(singleton,request_id,requested_at,expires_at,durable_hold) VALUES (true,$1,clock_timestamp(),clock_timestamp()+interval '1 hour',false)", [randomUUID()]);
  try { assert.equal(await compactEvolutionRecords(database, owner, { now }), 0); }
  finally { await database.query('DELETE FROM evimed_product.maintenance_lease'); }
  assert.ok((await left()).includes('signal-maintenance'));
  assert.equal(await compactEvolutionRecords(database, owner, { now }), 1);
});

test('the scan is served by its partial index, in the order the pass takes', options, async () => {
  const index = (await database.query("SELECT indexdef FROM pg_indexes WHERE schemaname='evimed_product' AND indexname='product_documents_retain_until_idx'")).rows[0];
  assert.ok(index, 'the migration creates it');
  assert.match(index.indexdef, /WHERE/, 'partial, so it costs only the rows that carry a date');
  const plan = await database.transaction(async (/** @type {any} */ client) => {
    await client.query('SET LOCAL enable_seqscan=off');
    return (await client.query(`EXPLAIN ${EVOLUTION_RETENTION_DUE_SELECT.replace('$1', "'2026-11-05T00:00:00.000Z'").replace('$2', '10')}`)).rows.map((/** @type {any} */ entry) => entry['QUERY PLAN']).join('\n');
  });
  assert.match(plan, /product_documents_retain_until_idx/);
  assert.doesNotMatch(plan, /Sort\b/, 'the index gives the order, so a limit stops early');
});
