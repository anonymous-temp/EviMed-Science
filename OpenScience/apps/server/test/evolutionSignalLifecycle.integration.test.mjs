import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { EvolutionService } from '../src/evolutionService.mjs';
import { createEvolutionSignals } from '../src/evolutionSignals.mjs';
import { createEvolutionGrowth, evolutionRecordedFailures } from '../src/evolutionGrowth.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, service, signals;
const owner = 'lifecycle_operator';
const researchers = Array.from({ length: 5 }, (_, i) => `lifecycle_researcher_${i}`);
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'signallifecycle');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  await database.migrate(); await migrateProductStore(database);
  for (const user of [owner, ...researchers]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Lifecycle','development')", [user]);
    for (const project of ['research', 'evimed-evolution']) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Lifecycle',1048576)", [user, project]);
  }
  service = new EvolutionService({ documents: new ProductDocuments(database), jobs: new ProductJobs(database), ownerId: owner });
  signals = createEvolutionSignals({ service, capabilityIds: async () => ['geo-content'], operatorIds: () => [owner] });
});
after(async () => { await database?.close(); await isolated?.drop(); });
const input = (eventId, extra = {}) => ({ userId: owner, projectId: 'research', eventId, kind: 'geo-misconception', moduleId: 'geo', capability: 'geo-content', operation: 'synthesize', dataShape: 'text', reason: 'unsupported', version: 'private-assessment-v1', sourceRevision: 1, ...extra });

test('versioned contributions preserve history, reject stale replay and cannot reactivate a withdrawn assessment', options, async () => {
  const first = await signals.record(input('private-snapshot-1'));
  const newer = await signals.record(input('private-snapshot-1', { version: 'private-assessment-v2', sourceRevision: 2 }));
  assert.equal(newer.id, first.id); assert.equal(newer.revision, 2);
  assert.equal((await signals.record(input('private-snapshot-1'))).revision, 2);
  const withdrawn = await signals.transition({ ...input('private-snapshot-1'), expectedVersion: 'private-assessment-v2', expectedRevision: newer.revision, state: 'invalidated' });
  assert.equal(withdrawn.payload.state, 'invalidated');
  assert.equal((await signals.record(input('private-snapshot-1', { version: 'private-assessment-v2', sourceRevision: 2 }))).payload.state, 'invalidated');
  assert.equal(await signals.transition({ ...input('private-snapshot-1'), expectedVersion: 'private-assessment-v1', state: 'active' }), null);
  const historical = await database.query("SELECT payload FROM evimed_product.revisions WHERE user_id=$1 AND kind='knowledge' AND id=$2 ORDER BY revision", [owner, first.id]);
  assert.ok(historical.rows.some(row => row.payload.sourceVersion === 'private-assessment-v1'));
});

test('same-size membership changes create a fresh opaque generation; disappearing groups retire without publishing private identifiers', options, async () => {
  const original = await signals.record(input('private-snapshot-2'));
  const summary = (await signals.aggregate()).find(row => row.payload.accountClass === 'operator');
  assert.ok(summary.payload.generation);
  assert.equal((await signals.aggregate()).find(row => row.id === summary.id).revision, summary.revision);
  await signals.record(input('private-snapshot-2', { version: 'private-assessment-v2', sourceRevision: 2 }));
  const next = (await signals.aggregate()).find(row => row.id === summary.id);
  assert.equal(next.payload.occurrences, summary.payload.occurrences);
  assert.notEqual(next.payload.generation, summary.payload.generation);
  const current = await service.get(original.id, owner);
  await signals.transition({ ...input('private-snapshot-2'), expectedVersion: current.payload.sourceVersion, expectedRevision: current.revision, state: 'suspended' });
  assert.equal((await signals.aggregate()).length, 0);
  const retired = await service.get(summary.id);
  assert.equal(retired.payload.state, 'inactive');
  assert.equal(retired.payload.occurrences, undefined);
  assert.equal(retired.payload.distinctAccounts, undefined);
  assert.equal(evolutionRecordedFailures(retired.payload), 0);
  const publicRows = await service.list('signal-summary');
  for (const forbidden of ['private-snapshot', 'private-assessment', owner, ...researchers]) assert.ok(!JSON.stringify(publicRows).includes(forbidden));
});

test('withdrawing researcher signals one by one keeps the summary while any account remains, then retires it and keeps growth from using it', options, async () => {
  for (const userId of researchers) await signals.record(input('researcher-private-snapshot', { userId }));
  const summary = (await signals.aggregate()).find(row => row.payload.accountClass === 'user');
  assert.equal(summary.payload.distinctAccounts, 5);
  const withdraw = userId => signals.transition({ ...input('researcher-private-snapshot', { userId }), expectedVersion: 'private-assessment-v1', state: 'invalidated' });
  await withdraw(researchers[0]);
  const fewer = await signals.aggregate();
  assert.equal(fewer.length, 1, 'the researcher floor is one account: four remaining accounts still make a summary');
  assert.equal(fewer[0].id, summary.id); assert.equal(fewer[0].payload.state, 'active'); assert.equal(fewer[0].payload.distinctAccounts, 4); assert.equal(fewer[0].payload.occurrences, 4);
  const offered = [];
  const growth = createEvolutionGrowth({ service, database, opportunity: async value => offered.push(value) });
  await growth.collect();
  assert.equal(offered.length, 1, 'growth reads the live summary'); assert.equal(offered[0].features.distinctAccounts, 4);
  for (const userId of researchers.slice(1, -1)) await withdraw(userId);
  const last = await signals.aggregate();
  assert.equal(last.length, 1); assert.equal(last[0].payload.distinctAccounts, 1, 'one remaining researcher is still enough');
  await withdraw(researchers.at(-1));
  assert.equal((await signals.aggregate()).length, 0, 'no account left, no summary');
  const retired = await service.get(summary.id);
  assert.equal(retired.payload.state, 'inactive'); assert.equal(retired.payload.distinctAccounts, undefined); assert.equal(retired.payload.occurrences, undefined);
  offered.length = 0;
  await growth.collect();
  assert.deepEqual(offered, [], 'a retired summary is not offered to growth');
});
