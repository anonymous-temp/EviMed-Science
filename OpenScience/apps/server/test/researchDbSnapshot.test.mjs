import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_DB_WITHHELD_CELL, listResearchTables, researchTableCsv, snapshotResearchTable } from '../src/researchDbSnapshot.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from '../src/researchDbConfig.mjs';

const ATTRIBUTES = [{ attname: 'name', atttypid: 25, type_name: 'text' }, { attname: 'age', atttypid: 23, type_name: 'integer' }];

/** A mock of the remote server: the catalogue answers, and `pages` are what successive FETCH statements return. */
function server({ pages = [[['Alice', '10', '00']]], relkind = 'r', attributes = ATTRIBUTES, count = undefined, reltuples = undefined } = {}) {
  const commands = [];
  return { commands, async query(sql) {
    const text = typeof sql === 'object' ? sql.text : sql;
    commands.push(text);
    if (text.startsWith('FETCH')) return { rows: pages.shift() ?? [] };
    if (text.includes('FROM pg_catalog.pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
    if (text.includes('FROM pg_catalog.pg_namespace')) return { rows: [{ internal: false }] };
    if (text.includes('FROM pg_catalog.pg_class')) return { rows: [{ oid: 100, relkind, relrowsecurity: false, allowed: true, reltuples }] };
    if (text.includes('FROM pg_catalog.pg_attribute')) return { rows: attributes };
    if (text.startsWith('SELECT count(*)')) { if (count instanceof Error) throw count; return { rows: count === undefined ? [] : [{ n: String(count) }] }; }
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
  assert(!client.commands.some(sql => sql.startsWith('SELECT count(*)')), 'a complete snapshot needs no count: it read every row');
});

test('without columns the snapshot takes every supported column of the table, in position order', async () => {
  for (const request of [{ schema: 'public', table: 'cohort' }, { schema: 'public', table: 'cohort', columns: [] }]) {
    const client = server();
    const result = await snapshotResearchTable(client, request);
    assert.deepEqual(result.columns, ['name', 'age']);
    assert(client.commands.some(sql => sql.includes('"name"::text') && sql.includes('"age"::text')));
  }
  await assert.rejects(snapshotResearchTable(server({ attributes: [] }), { schema: 'public', table: 'cohort' }), { code: 'research_db_selection_invalid' });
});

test('a withheld cell carries a token and is counted, a null stays empty, and a snapshot of more than 20,000 rows is truncated at the cap', async () => {
  const batch = Array.from({ length: 5000 }, (_, index) => [`n${index}`, null, index === 0 ? '01' : '00']);
  const result = await snapshotResearchTable(server({ pages: [batch, batch, batch, batch, batch, batch], count: 52340 }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(result.rows.length, 20000); assert.equal(result.truncated, true); assert.equal(result.stoppedBy, 'rows');
  assert.deepEqual(result.rows[0], ['n0', RESEARCH_DB_WITHHELD_CELL]); assert.deepEqual(result.rows[1], ['n1', null]);
  assert.equal(result.oversizedValuesWithheld, true); assert.equal(result.withheldCells, 4, 'the first row of each of the four batches'); assert.deepEqual(result.withheldByColumn, { age: 4 });
  assert.equal(result.totalRows, 52340); assert.equal(result.totalRowsExact, true, 'a cut snapshot says how large the table is');
  const exact = await snapshotResearchTable(server({ pages: [batch, batch, batch, batch] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(exact.rows.length, 20000); assert.equal(exact.truncated, false, 'a table of exactly 20,000 rows is complete'); assert.equal(exact.stoppedBy, null);
  assert.equal(exact.totalRows, 20000); assert.equal(exact.totalRowsExact, true);
});

test('the CSV writes a withheld cell as its token, never as an empty cell, and a null as an empty cell', async () => {
  const result = await snapshotResearchTable(server({ pages: [[['a', '1', '01'], ['b', null, '00']]] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  const csv = researchTableCsv(result).toString('utf8');
  assert.equal(csv, `\uFEFFname,age\r\na,${RESEARCH_DB_WITHHELD_CELL}\r\nb,\r\n`);
  assert.notEqual(RESEARCH_DB_WITHHELD_CELL, '', 'a withheld cell is distinguishable from a null');
});

test('when the remote database will not count, the total is the catalogue\'s estimate and says it is one; with neither it is unknown', async () => {
  const batch = Array.from({ length: 5000 }, (_, index) => [`n${index}`, '1', '00']);
  const pages = () => [batch, batch, batch, batch, batch, batch];
  const request = { schema: 'public', table: 'cohort', columns: ['name', 'age'] };
  const estimated = await snapshotResearchTable(server({ pages: pages(), count: new Error('canceling statement due to statement timeout'), reltuples: 48000.4 }), request);
  assert.equal(estimated.totalRows, 48000); assert.equal(estimated.totalRowsExact, false);
  const commands = [];
  const failing = server({ pages: pages(), count: new Error('statement timeout'), reltuples: -1 });
  const unknown = await snapshotResearchTable({ query: sql => { commands.push(typeof sql === 'object' ? sql.text : sql); return failing.query(sql); } }, request);
  assert.equal(unknown.totalRows, null); assert.equal(unknown.totalRowsExact, false);
  assert(commands.includes('SAVEPOINT research_count') && commands.includes('ROLLBACK TO SAVEPOINT research_count'), 'a count that fails costs nothing but its answer');
  assert.equal(commands.at(-1), 'ROLLBACK');
});

test('a snapshot names every column it left out: an unsupported type, and a supported one past the column cap', async () => {
  const attributes = [
    { attname: 'id', atttypid: 23, type_name: 'integer' }, { attname: 'doc', atttypid: 3802, type_name: 'jsonb' }, { attname: 'state', atttypid: 99999, type_name: 'visit_state' },
    { attname: 'name', atttypid: 25, type_name: 'text' }, { attname: 'tags', atttypid: 1009, type_name: 'text[]' }, { attname: 'age', atttypid: 23, type_name: 'integer' },
  ];
  const whole = await snapshotResearchTable(server({ attributes, pages: [[['1', 'a', '3', '000']]] }), { schema: 'public', table: 'cohort' });
  assert.deepEqual(whole.columns, ['id', 'name', 'age']);
  assert.deepEqual(whole.droppedColumns, [{ name: 'doc', type: 'jsonb', reason: 'unsupported_type' }, { name: 'state', type: 'visit_state', reason: 'unsupported_type' }, { name: 'tags', type: 'text[]', reason: 'unsupported_type' }]);
  const narrow = { ...RESEARCH_DB_LIMIT_DEFAULTS, columns: 2 };
  const cut = await snapshotResearchTable(server({ attributes, pages: [[['1', 'a', '00']]] }), { schema: 'public', table: 'cohort' }, { limits: narrow });
  assert.deepEqual(cut.columns, ['id', 'name']);
  assert.deepEqual(cut.droppedColumns.map(item => [item.name, item.reason]), [['doc', 'unsupported_type'], ['state', 'unsupported_type'], ['tags', 'unsupported_type'], ['age', 'over_column_limit']]);
  // An explicit selection of an unsupported column is refused; one that avoids them still names what the table has that is not in the file.
  await assert.rejects(snapshotResearchTable(server({ attributes }), { schema: 'public', table: 'cohort', columns: ['id', 'doc'] }), { code: 'research_db_selection_invalid' });
  const chosen = await snapshotResearchTable(server({ attributes, pages: [[['1', '00']]] }), { schema: 'public', table: 'cohort', columns: ['id', 'age'] });
  assert.deepEqual(chosen.columns, ['id', 'age']); assert.deepEqual(chosen.droppedColumns.map(item => item.name), ['doc', 'state', 'tags']);
});

test('the limits are the ones the caller passes: rows, bytes and the cell cap', async () => {
  const small = { ...RESEARCH_DB_LIMIT_DEFAULTS, rows: 3, bytes: 30, cellBytes: 100 };
  const rows = Array.from({ length: 5 }, (_, index) => [`name${index}`, String(index), '00']);
  const byRows = await snapshotResearchTable(server({ pages: [rows], count: 9 }), { schema: 'public', table: 'cohort' }, { limits: { ...small, bytes: 10_000 } });
  assert.equal(byRows.rows.length, 3); assert.equal(byRows.stoppedBy, 'rows'); assert.equal(byRows.totalRows, 9);
  const byBytes = await snapshotResearchTable(server({ pages: [rows] }), { schema: 'public', table: 'cohort' }, { limits: { ...small, rows: 100 } });
  assert.equal(byBytes.stoppedBy, 'bytes'); assert(byBytes.rows.length < 5);
  const client = server();
  await snapshotResearchTable(client, { schema: 'public', table: 'cohort' }, { limits: small });
  assert(client.commands.some(sql => sql.includes('octet_length("name"::text) <= 100') && sql.includes('LIMIT 4')), 'the cell cap and the row cap reach the remote statement');
});

test('the decoded rows stop at 12 MB and the snapshot says so', async () => {
  const page = Array.from({ length: 8 }, () => ['x'.repeat(2 * 1024 * 1024), '1', '00']);
  const result = await snapshotResearchTable(server({ pages: [page] }), { schema: 'public', table: 'cohort', columns: ['name', 'age'] });
  assert.equal(result.rows.length, 5); assert.equal(result.truncated, true); assert.equal(result.stoppedBy, 'bytes');
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

test('a role that bypasses row security is refused for what it is, before any table is named, for a snapshot and for a listing', async () => {
  for (const flag of ['rolsuper', 'rolbypassrls']) {
    const commands = [];
    const client = { async query(sql) {
      commands.push(typeof sql === 'object' ? sql.text : sql);
      if (String(sql).includes('pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false, [flag]: true }] };
      return { rows: [] };
    } };
    // Not `research_db_selection_invalid`: the same login fails for every table, and the person is not asked to change tables.
    await assert.rejects(snapshotResearchTable(client, { schema: 'public', table: 'cohort' }), { code: 'research_db_login_too_privileged' });
    await assert.rejects(listResearchTables(client), { code: 'research_db_login_too_privileged' });
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
    if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: [
      { attrelid: 1, attname: 'id', type_name: 'integer', supported: true, total: '70' }, { attrelid: 1, attname: 'note', type_name: 'text', supported: true, total: '70' },
      { attrelid: 1, attname: 'doc', type_name: 'jsonb', supported: false, total: '3' }] };
    return { rows: [] };
  } };
  const listing = await listResearchTables(client);
  assert.equal(listing.tables.length, 200); assert.equal(listing.truncated, true);
  assert.deepEqual(listing.tables[0], { schema: 'public', table: 't0', estimatedRows: null, columns: [{ name: 'id', type: 'integer' }, { name: 'note', type: 'text' }],
    omittedColumnCount: 68, unsupportedColumns: [{ name: 'doc', type: 'jsonb' }], unsupportedColumnCount: 3 });
  assert.equal(listing.tables[1].estimatedRows, 12); assert.deepEqual(listing.tables[1].columns, []); assert.deepEqual(listing.tables[1].unsupportedColumns, []);
  assert(commands.includes('BEGIN TRANSACTION READ ONLY')); assert.equal(commands.at(-1), 'ROLLBACK');
  const catalogue = commands.find(sql => sql.includes('FROM pg_catalog.pg_class c'));
  assert(catalogue.includes("c.relkind = 'r'") && catalogue.includes('NOT c.relrowsecurity') && catalogue.includes("has_table_privilege(c.oid, 'SELECT')") && catalogue.includes('LIMIT 201'));
  assert(commands.some(sql => sql.includes('position <= 64') && sql.includes('position <= 50')));
  const narrow = await listResearchTables(client, { limits: { ...RESEARCH_DB_LIMIT_DEFAULTS, tables: 5, columns: 8 } });
  assert.equal(narrow.tables.length, 5);
  assert(commands.some(sql => sql.includes('LIMIT 6')) && commands.some(sql => sql.includes('position <= 8')), 'the listing follows the configured limits');
});

test('the CSV is RFC 4180 with a header row and a byte order mark', () => {
  const bytes = researchTableCsv({ columns: ['id', 'note, with comma'], rows: [['1', 'say "hi"'], ['2', null], ['3', '第一行\n第二行'], ['4', 'plain 中文']] });
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '\uFEFFid,"note, with comma"\r\n1,"say ""hi"""\r\n2,\r\n3,"第一行\n第二行"\r\n4,plain 中文\r\n');
});
