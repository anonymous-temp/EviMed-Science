import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { EvolutionLedger } from '../src/evolutionLedger.mjs';
import { createEvolutionRetentionRunner } from '../src/evolutionRetentionRunner.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost test database is required' };
const owner = `retention_${randomUUID().replaceAll('-', '')}`;
/** @type {any} */ let isolated, database, documents, clock;
const ledgerOf = () => new EvolutionLedger({ documents, ownerId: owner, now: () => clock });
const quiet = { error() {} };
const dueSignal = async (id) => {
  const ledger = ledgerOf();
  await ledger.save('signal', id, { kind: 'unmet-demand', moduleId: 'tools', projectId: 'research', retainUntil: '2026-01-01T00:00:00.000Z', scope: 'owner' }, null, owner);
};
const exists = async (id) => Boolean(await documents.get(owner, 'knowledge', id));

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evoretain');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Retention','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($1,'research','Research',1048576)", [owner]);
  documents = new ProductDocuments(database);
});
after(async () => { if (database) await database.close(); if (isolated) await isolated.drop(); });

test('a pass runs once a UTC day across restarts and processes, and a failed day is not asked again until the next', options, async () => {
  clock = new Date('2026-10-04T10:00:00Z');
  await dueSignal('evolution-signal-a');
  const first = createEvolutionRetentionRunner({ database, ledger: ledgerOf(), logger: quiet }), second = createEvolutionRetentionRunner({ database, ledger: ledgerOf(), logger: quiet });
  await Promise.all([first.tick(), second.tick()]);
  assert.equal(first.counters.passes + second.counters.passes, 1, 'two processes, one pass');
  assert.equal(await exists('evolution-signal-a'), false);
  await dueSignal('evolution-signal-b');
  const restarted = createEvolutionRetentionRunner({ database, ledger: ledgerOf(), logger: quiet });
  await restarted.tick();
  assert.equal(restarted.counters.passes, 0, 'a restart the same day does not repeat it');
  assert.equal(await exists('evolution-signal-b'), true);
  clock = new Date('2026-10-05T01:00:00Z');
  await restarted.tick();
  assert.equal(await exists('evolution-signal-b'), false, 'the next day it runs');
  assert.equal(restarted.counters.recordsDeleted, 1);
  // A failing pass is counted, said, and not repeated the same day; the day after is tried again.
  await dueSignal('evolution-signal-c');
  clock = new Date('2026-10-06T01:00:00Z');
  let errors = 0;
  const broken = createEvolutionRetentionRunner({ database: { transaction: async () => { throw Object.assign(new Error('statement timeout'), { code: '57014' }); } }, ledger: ledgerOf(), logger: { error() { errors += 1; } } });
  await broken.tick(); await broken.tick();
  assert.deepEqual([broken.counters.failed, errors], [1, 1]);
  clock = new Date('2026-10-07T01:00:00Z');
  await broken.tick();
  assert.equal(broken.counters.failed, 2, 'the next day it is tried again');
  const healthy = createEvolutionRetentionRunner({ database, ledger: ledgerOf(), logger: quiet });
  clock = new Date('2026-10-08T01:00:00Z');
  await healthy.tick();
  assert.equal(await exists('evolution-signal-c'), false);
});

test('maintenance or the caller\'s own admission holds the pass and does not spend the day', options, async () => {
  clock = new Date('2026-11-01T10:00:00Z');
  await dueSignal('evolution-signal-d');
  let allowed = false;
  const runner = createEvolutionRetentionRunner({ database, ledger: ledgerOf(), canRun: async () => allowed, logger: quiet });
  await runner.tick();
  assert.equal(await exists('evolution-signal-d'), true);
  allowed = true;
  await runner.tick();
  assert.equal(await exists('evolution-signal-d'), false);
});
