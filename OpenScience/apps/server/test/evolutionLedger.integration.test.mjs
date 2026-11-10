import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { EvolutionLedger } from '../src/evolutionLedger.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost test database is required' };
const owner = `ledger_${randomUUID().replaceAll('-', '')}`, researcher = `ledger_${randomUUID().replaceAll('-', '')}`;
/** @type {any} */ let isolated, database, documents, ledger;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'evoledger');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Ledger operator','development'),($2,'Ledger researcher','development')", [owner, researcher]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($1,'research','Research',1048576),($2,'research','Research',1048576)", [owner, researcher]);
  documents = new ProductDocuments(database);
  ledger = new EvolutionLedger({ documents, ownerId: owner, config: { operatorUsers: [owner] } });
});
after(async () => { if (database) await database.close(); if (isolated) await isolated.drop(); });

test('PostgreSQL lead races deduplicate, a lead keeps closed codes only, and the occurrence stays the researcher\'s own', options, async () => {
  const input = { track: 'M', source: 'runtime-failure', gapCode: 'method-missing', code: 'private_identifier', method: 'private prose', userId: researcher, projectId: 'research' };
  const rows = await Promise.all(Array.from({ length: 5 }, (_, index) => ledger.addLead({ ...input, sourceEventId: `race-${index}` })));
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  assert.equal((await documents.history(owner, 'knowledge', rows[0].id)).length, 1, 'a repeat is use, not a version of the lead');
  assert.equal(rows[0].payload.method, undefined); assert.equal(rows[0].payload.code, 'method-missing');
  const lead = await ledger.get(rows[0].id);
  assert.deepEqual([lead.payload.occurrences, lead.payload.distinctAccounts], [5, 1]);
  assert.equal((await ledger.addLead({ ...input, sourceEventId: 'race-0' })).payload.occurrences, 5, 'one event is one occurrence');
  assert.equal((await ledger.list('lead-occurrence', researcher)).length, 5);
  assert.equal((await ledger.list('lead-occurrence')).length, 0);
  assert.doesNotMatch(JSON.stringify([lead, ...(await ledger.list('lead-occurrence', researcher))]), /private (identifier|prose)/);
  assert.ok((await ledger.list('lead-occurrence', researcher)).every(row => typeof row.payload.retainUntil === 'string'), 'dated for retention');
});

test('a lead outside the closed vocabulary is refused by name', options, async () => {
  for (const patch of [{ track: 'Z' }, { source: 'tool-gateway' }, { gapCode: 'free text' }])
    await assert.rejects(ledger.addLead({ track: 'M', source: 'runtime-failure', gapCode: 'connector', userId: researcher, sourceEventId: 'bad', ...patch }), /evolution_lead_invalid|Unknown evolution lead/);
});
