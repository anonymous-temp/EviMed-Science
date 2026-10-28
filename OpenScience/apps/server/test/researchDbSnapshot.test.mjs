import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

test('a snapshot selects only admitted columns from a normal table inside a bounded read-only transaction', async () => {
  const commands = [];
  const client = {
    async query(sql) {
      if (typeof sql === 'object') { commands.push(sql.text); return { rows: [['Alice', '10', false, false]] }; }
      commands.push(sql);
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
      if (sql.includes('FROM pg_catalog.pg_namespace')) return { rows: [{ internal: false }] };
      if (sql.includes('FROM pg_catalog.pg_class')) return { rows: [{ oid: 100, relkind: 'r', relrowsecurity: false, allowed: true }] };
      if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: [{ attname: 'name', atttypid: 25, type_name: 'text' }, { attname: 'age', atttypid: 23, type_name: 'integer' }] };
      return { rows: [] };
    },
  };
  const result = await snapshotResearchTable(client, { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.columnTypes, [{ name: 'name', oid: 25, postgresType: 'text' }, { name: 'age', oid: 23, postgresType: 'integer' }]);
  assert(commands.includes('BEGIN TRANSACTION READ ONLY'));
  assert(commands.some(sql => sql.includes('ONLY "public"."cohort" LIMIT 201')));
  assert.equal(commands.at(-1), 'ROLLBACK');
});

test('untrusted identifiers and unapproved tables or columns are rejected', async () => {
  const client = { async query(sql) {
    if (sql.includes('pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (sql.includes('FROM pg_catalog.pg_namespace')) return { rows: [{ internal: false }] };
    if (sql.includes('pg_class')) return { rows: [{ oid: 1, relkind: 'v', relrowsecurity: false, allowed: true }] };
    return { rows: [] };
  } };
  await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'view', columns: ['id'] }));
  await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'bad\u0000name', columns: ['id'] }));
});
