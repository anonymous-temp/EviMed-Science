import test from 'node:test';
import assert from 'node:assert/strict';
import { listResearchTables, researchTableCsv, researchTableFileName, snapshotResearchTable } from '../src/researchDbSnapshot.mjs';

/** A mock of the remote server: the catalogue answers, and `pages` are what successive FETCH statements return. */
function server({ pages = [[['Alice', '10', '00']]], relkind = 'r', attributes = [{ attname: 'name', atttypid: 25, type_name: 'text' }, { attname: 'age', atttypid: 23, type_name: 'integer' }] } = {}) {
  const commands = [];
  return { commands, async query(sql) {
    const text = typeof sql === 'object' ? sql.text : sql;
    commands.push(text);
    if (text.startsWith('FETCH')) return { rows: pages.shift() ?? [] };
    if (text.includes('FROM pg_catalog.pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (text.includes('FROM pg_catalog.pg_namespace')) return { rows: [{ internal: false }] };
    if (text.includes('FROM pg_catalog.pg_class')) return { rows: [{ oid: 100, relkind, relrowsecurity: false, allowed: true }] };
    if (text.includes('FROM pg_catalog.pg_attribute')) return { rows: attributes };
    return { rows: [] };
  } };
}

test('a snapshot selects only admitted columns from a normal table inside a bounded read-only transaction', async () => {
  const client = server();
  const result = await snapshotResearchTable(client, { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.deepEqual(result.rows, [['Alice', '10']]);
  assert.equal(result.truncated, false); assert.equal(result.oversizedValuesWithheld, false);
  assert.deepEqual(result.columns, ['name', 'age']);
  assert.deepEqual(result.columnTypes, [{ name: 'name', oid: 25, postgresType: 'text' }, { name: 'age', oid: 23, postgresType: 'integer' }]);
  assert(client.commands.includes('BEGIN TRANSACTION READ ONLY'));
  assert(client.commands.includes("SET LOCAL TimeZone = 'UTC'"));
  assert(client.commands.some(sql => sql.startsWith('DECLARE research_snapshot') && sql.includes('FROM ONLY "public"."cohort" LIMIT 20001')));
  assert.equal(client.commands.at(-1), 'ROLLBACK');
});

test('without columns the snapshot takes every supported column of the table, in position order', async () => {
  for (const request of [{ schema: 'public', table: 'cohort' }, { schema: 'public', table: 'cohort', columns: [] }]) {
    const client = server();
    const result = await snapshotResearchTable(client, request);
    assert.deepEqual(result.columns, ['name', 'age']);
    assert(client.commands.some(sql => sql.includes('ORDER BY attnum LIMIT 64')));
    assert(client.commands.some(sql => sql.includes('"name"::text') && sql.includes('"age"::text')));
  }
  await assert.rejects(snapshotResearchTable(server({ attributes: [] }), { schema: 'public', table: 'cohort' }), { code: 'research_db_selection_invalid' });
});

test('a withheld cell and a null are both empty, and a snapshot of more than 20,000 rows is truncated', async () => {
  const batch = Array.from({ length: 5000 }, (_, index) => [`n${index}`, null, index === 0 ? '01' : '00']);
  const result = await snapshotResearchTable(server({ pages: [batch, batch, batch, batch, batch, batch] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(result.rows.length, 20000); assert.equal(result.truncated, true);
  assert.deepEqual(result.rows[0], ['n0', null]); assert.equal(result.oversizedValuesWithheld, true);
  const exact = await snapshotResearchTable(server({ pages: [batch, batch, batch, batch] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(exact.rows.length, 20000); assert.equal(exact.truncated, false, 'a table of exactly 20,000 rows is complete');
});

test('the decoded rows stop at 12 MB and the snapshot says so', async () => {
  const page = Array.from({ length: 8 }, () => ['x'.repeat(2 * 1024 * 1024), '1', '00']);
  const result = await snapshotResearchTable(server({ pages: [page] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(result.rows.length, 5); assert.equal(result.truncated, true);
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
  await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 't', columns: Array.from({ length: 65 }, (_, index) => `c${index}`) }));
  await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 't', columns: ['a', 'a'] }));
});

test('a role that bypasses row security is refused before any table is named, for a snapshot and for a listing', async () => {
  for (const flag of ['rolsuper', 'rolbypassrls']) {
    const commands = [];
    const client = { async query(sql) {
      commands.push(typeof sql === 'object' ? sql.text : sql);
      if (String(sql).includes('pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false, [flag]: true }] };
      return { rows: [] };
    } };
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'cohort' }), { code: 'research_db_selection_invalid' });
    await assert.rejects(listResearchTables(client), { code: 'research_db_selection_invalid' });
    assert(!commands.some(sql => sql.includes('LOCK TABLE') || sql.includes('FROM pg_catalog.pg_class')));
    assert.equal(commands.at(-1), 'ROLLBACK');
  }
});

test('the table listing reads the catalogue in a read-only transaction and bounds tables and columns', async () => {
  const commands = [];
  const client = { async query(sql) {
    commands.push(sql);
    if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (sql.includes('FROM pg_catalog.pg_namespace WHERE')) return { rows: [{ internal: false }] };
    if (sql.includes('FROM pg_catalog.pg_class c')) return { rows: Array.from({ length: 201 }, (_, index) => ({ oid: index + 1, nspname: 'public', relname: `t${index}`, reltuples: index === 0 ? -1 : 12.4 })) };
    if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: [{ attrelid: 1, attname: 'id', type_name: 'integer' }, { attrelid: 1, attname: 'note', type_name: 'text' }] };
    return { rows: [] };
  } };
  const listing = await listResearchTables(client);
  assert.equal(listing.tables.length, 200); assert.equal(listing.truncated, true);
  assert.deepEqual(listing.tables[0], { schema: 'public', table: 't0', estimatedRows: null, columns: [{ name: 'id', type: 'integer' }, { name: 'note', type: 'text' }] });
  assert.equal(listing.tables[1].estimatedRows, 12); assert.deepEqual(listing.tables[1].columns, []);
  assert(commands.includes('BEGIN TRANSACTION READ ONLY')); assert.equal(commands.at(-1), 'ROLLBACK');
  const catalogue = commands.find(sql => sql.includes('FROM pg_catalog.pg_class c'));
  assert(catalogue.includes("c.relkind = 'r'") && catalogue.includes('NOT c.relrowsecurity') && catalogue.includes("has_table_privilege(c.oid, 'SELECT')") && catalogue.includes('LIMIT 201'));
  assert(commands.some(sql => sql.includes('position <= 64')));
});

test('the CSV is RFC 4180 with a header row and a byte order mark, and the file name is safe', () => {
  const bytes = researchTableCsv({ columns: ['id', 'note, with comma'], rows: [['1', 'say "hi"'], ['2', null], ['3', '第一行\n第二行'], ['4', 'plain 中文']] });
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '﻿id,"note, with comma"\r\n1,"say ""hi"""\r\n2,\r\n3,"第一行\n第二行"\r\n4,plain 中文\r\n');
  const at = '2026-10-28T09:05:07.123Z';
  assert.equal(researchTableFileName('cohort', at), 'cohort-20261028-090507.csv');
  assert.equal(researchTableFileName('../../etc/pass wd', at), 'etc_pass_wd-20261028-090507.csv');
  assert.equal(researchTableFileName('患者 队列', at), '患者_队列-20261028-090507.csv');
  assert.equal(researchTableFileName('...', at), 'table-20261028-090507.csv');
  assert.match(researchTableFileName('x'.repeat(200), at), /^x{48}-20261028-090507\.csv$/);
});
