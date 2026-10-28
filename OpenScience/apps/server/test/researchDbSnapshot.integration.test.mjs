import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { listResearchTables, snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

const url = process.env.OPEN_SCIENCE_TEST_RESEARCH_DB_URL ?? '';
if (url) {
  const parsed = new URL(url);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
test('a real PostgreSQL table is read with a restricted role, bounds and no writes', { skip: !url && 'A disposable external test database is required' }, async () => {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  const role = `research_db_test_${process.pid}`;
  let internalSchemaCreated = false, roleCreated = false, tableCreated = false;
  try {
    await client.query(`CREATE ROLE ${role}`); roleCreated = true;
    await client.query('CREATE TABLE research_db_snapshot_fixture (id integer, note text, seen timestamptz, payload jsonb)'); tableCreated = true;
    await client.query(`INSERT INTO research_db_snapshot_fixture SELECT i,
      CASE WHEN i=1 THEN repeat('x', 40000) WHEN i=2 THEN NULL WHEN i=3 THEN repeat('y', 32768) WHEN i=4 THEN '第"四", 行' ELSE 'ok' END,
      timestamptz '2026-01-02 03:04:05+08', '{}' FROM generate_series(1, 20005) AS i`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON research_db_snapshot_fixture TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    // Explicit columns: the cell over 32 KB is withheld, the one at exactly 32 KB is kept, a null stays a null.
    const snapshot = await snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id', 'note', 'seen'] });
    assert.equal(snapshot.rows.length, 20000); assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.columns, ['id', 'note', 'seen']);
    assert.equal(snapshot.rows[0][1], null); assert.equal(snapshot.oversizedValuesWithheld, true);
    assert.equal(snapshot.rows[1][1], null);
    assert.equal(snapshot.rows[2][1].length, 32768);
    assert.equal(snapshot.rows[3][1], '第"四", 行'); assert.equal(snapshot.rows[4][1], 'ok');
    assert.equal(snapshot.rows[4][2], '2026-01-01 19:04:05+00', 'timestamps are rendered in UTC whatever the role default is');
    assert.deepEqual(snapshot.columnTypes.map(column => column.postgresType), ['integer', 'text', 'timestamp with time zone']);
    // No columns: every supported column in table order; the jsonb column is not supported and is left out.
    const all = await snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture' });
    assert.deepEqual(all.columns, ['id', 'note', 'seen']); assert.equal(all.rows.length, 20000);
    assert.deepEqual((await snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: [] })).columns, ['id', 'note', 'seen']);
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id', 'payload'] }), { code: 'research_db_selection_invalid' });
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id', 'missing'] }), { code: 'research_db_selection_invalid' });
    await assert.rejects(client.query("INSERT INTO research_db_snapshot_fixture(id) VALUES (999999)"));
    await client.query('RESET ROLE');
    assert.equal(Number((await client.query('SELECT count(*) AS count FROM research_db_snapshot_fixture')).rows[0].count), 20005);
    await client.query('CREATE SCHEMA evimed_control'); internalSchemaCreated = true;
    await client.query(`SET ROLE ${role}`);
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id'] }), { code: 'research_db_selection_invalid' });
    await assert.rejects(listResearchTables(client), { code: 'research_db_selection_invalid' }, 'the platform own database is never listed');
    await client.query('RESET ROLE');
    await client.query('DROP SCHEMA evimed_control'); internalSchemaCreated = false;
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    if (internalSchemaCreated) await client.query('DROP SCHEMA evimed_control');
    if (tableCreated) await client.query('DROP TABLE research_db_snapshot_fixture');
    if (roleCreated) { await client.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`); await client.query(`DROP ROLE ${role}`); }
    await client.end();
  }
});

test('the table listing offers the ordinary tables a role can read, with their supported columns', { skip: !url && 'A disposable external test database is required' }, async () => {
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const role = `research_db_list_${process.pid}`, schema = `research_list_${process.pid}`, hidden = `research_hidden_${process.pid}`;
  try {
    await admin.query(`CREATE ROLE ${role}`);
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`CREATE SCHEMA ${hidden}`);
    await admin.query(`CREATE TABLE ${schema}.visits (id integer, label varchar(20), weight numeric(6,2), seen date, extra jsonb)`);
    await admin.query(`INSERT INTO ${schema}.visits VALUES (1, 'a', 1.5, '2026-01-01', '{}')`);
    await admin.query(`ANALYZE ${schema}.visits`);
    await admin.query(`CREATE TABLE ${schema}.never_analysed (id bigint)`);
    await admin.query(`CREATE TABLE ${schema}.only_json (doc jsonb)`);
    await admin.query(`CREATE TABLE ${schema}.secured (id integer)`); await admin.query(`ALTER TABLE ${schema}.secured ENABLE ROW LEVEL SECURITY`);
    await admin.query(`CREATE TABLE ${schema}.no_grant (id integer)`);
    await admin.query(`CREATE VIEW ${schema}.visit_view AS SELECT id FROM ${schema}.visits`);
    await admin.query(`CREATE TABLE ${hidden}.in_closed_schema (id integer)`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON ${schema}.visits, ${schema}.never_analysed, ${schema}.only_json, ${schema}.secured, ${schema}.visit_view TO ${role}`);
    await admin.query(`GRANT SELECT ON ${hidden}.in_closed_schema TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    const listing = await listResearchTables(admin);
    const mine = listing.tables.filter(item => item.schema === schema || item.schema === hidden);
    assert.deepEqual(mine.map(item => item.table), ['never_analysed', 'visits'], 'no view, row-security table, table without privilege, jsonb-only table or closed schema');
    assert.deepEqual(mine[1], { schema, table: 'visits', estimatedRows: 1, columns: [
      { name: 'id', type: 'integer' }, { name: 'label', type: 'character varying(20)' }, { name: 'weight', type: 'numeric(6,2)' }, { name: 'seen', type: 'date' }] });
    assert.equal(mine[0].estimatedRows, null, 'a table PostgreSQL has not analysed has an unknown row count');
    assert(listing.tables.every(item => !item.schema.startsWith('pg_') && item.schema !== 'information_schema'));
    assert.equal(listing.truncated, false);
    const after = await admin.query('SHOW transaction_read_only'); assert.equal(after.rows[0].transaction_read_only, 'off', 'the read-only transaction ended');
    await admin.query('RESET ROLE');
    // Many tables: the listing stops at 200 and says so.
    await admin.query(`DO $$ BEGIN FOR i IN 1..205 LOOP EXECUTE format('CREATE TABLE ${schema}.bulk_%s (id integer)', i); END LOOP; END $$`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    const bounded = await listResearchTables(admin);
    assert.equal(bounded.tables.length, 200); assert.equal(bounded.truncated, true);
    await admin.query('RESET ROLE');
    // Many columns: a table lists its first 64.
    await admin.query(`CREATE TABLE ${schema}.wide (${Array.from({ length: 70 }, (_, index) => `c${index} integer`).join(', ')})`);
    await admin.query(`DROP TABLE ${schema}.secured, ${schema}.only_json`); await admin.query(`DO $$ BEGIN FOR i IN 1..205 LOOP EXECUTE format('DROP TABLE ${schema}.bulk_%s', i); END LOOP; END $$`);
    await admin.query(`GRANT SELECT ON ${schema}.wide TO ${role}`); await admin.query(`SET ROLE ${role}`);
    const wide = (await listResearchTables(admin)).tables.find(item => item.table === 'wide');
    assert.equal(wide.columns.length, 64); assert.equal(wide.columns[63].name, 'c63');
    const snapshot = await snapshotResearchTable(admin, { schema, table: 'wide' });
    assert.equal(snapshot.columns.length, 64);
  } finally {
    await admin.query('RESET ROLE').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.query(`DROP SCHEMA IF EXISTS ${hidden} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`); await admin.end();
  }
});

test('a table larger than the 12 MB byte cap ends as a truncated snapshot, not as a failed read', { skip: !url && 'A disposable external test database is required' }, async () => {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  const role = `research_db_bytes_${process.pid}`;
  try {
    await client.query(`CREATE ROLE ${role}`);
    await client.query('CREATE TABLE research_db_bytes_fixture (id integer, body text)');
    await client.query("INSERT INTO research_db_bytes_fixture SELECT i, repeat(chr(65 + i % 26), 30000) FROM generate_series(1, 700) AS i");
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`); await client.query(`GRANT SELECT ON research_db_bytes_fixture TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const snapshot = await snapshotResearchTable(client, { schema: 'public', table: 'research_db_bytes_fixture' });
    assert.equal(snapshot.truncated, true); assert.equal(snapshot.oversizedValuesWithheld, false);
    assert(snapshot.rows.length > 380 && snapshot.rows.length < 430, `kept ${snapshot.rows.length} rows of 700`);
    const bytes = snapshot.rows.reduce((sum, row) => sum + row[0].length + row[1].length + 2, 0);
    assert(bytes <= 12 * 1024 * 1024 && bytes > 12 * 1024 * 1024 - 40000);
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('DROP TABLE IF EXISTS research_db_bytes_fixture');
    await client.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`).catch(() => {}); await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
  }
});
