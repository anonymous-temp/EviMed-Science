import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

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
    await client.query('CREATE TABLE research_db_snapshot_fixture (id integer, note text)'); tableCreated = true;
    await client.query("INSERT INTO research_db_snapshot_fixture SELECT i, CASE WHEN i=1 THEN repeat('x', 3000) WHEN i=2 THEN NULL ELSE 'ok' END FROM generate_series(1, 205) AS i");
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON research_db_snapshot_fixture TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const snapshot = await snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id', 'note'] });
    assert.equal(snapshot.rows.length, 200); assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.rows[0].note, { state: 'withheld' }); assert.deepEqual(snapshot.rows[1].note, { state: 'null' });
    assert.deepEqual(snapshot.rows[2].note, { state: 'value', value: 'ok' }); assert.equal(snapshot.oversizedValuesWithheld, true);
    assert.deepEqual(snapshot.columnTypes.map(column => column.postgresType), ['integer', 'text']);
    await assert.rejects(client.query("INSERT INTO research_db_snapshot_fixture VALUES (999, 'write')"));
    await client.query('RESET ROLE');
    assert.equal(Number((await client.query('SELECT count(*) AS count FROM research_db_snapshot_fixture')).rows[0].count), 205);
    await client.query('CREATE SCHEMA evimed_control'); internalSchemaCreated = true;
    await client.query(`SET ROLE ${role}`);
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'research_db_snapshot_fixture', columns: ['id'] }), { code: 'research_db_selection_invalid' });
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
