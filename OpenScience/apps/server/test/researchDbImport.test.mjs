import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceOriginOf } from '@evimed/domain';
import { researchDbImportFacts, researchDbImportTitle, researchDbLogicalPath, researchDbSidecar, researchDbSidecarPath, researchDbSourceFacts, researchDbTableKey } from '../src/researchDbImport.mjs';
import { RESEARCH_DB_WITHHELD_CELL } from '../src/researchDbSnapshot.mjs';

const connection = { host: 'db.example.org', port: 5432, database: 'research' };
const base = {
  schema: 'public', table: 'cohort', columns: ['id', 'note'], columnTypes: [{ name: 'id', oid: 23, postgresType: 'integer' }, { name: 'note', oid: 25, postgresType: 'text' }],
  rows: [['1', 'a'], ['2', null]], truncated: false, stoppedBy: null, oversizedValuesWithheld: false, withheldCells: 0, withheldByColumn: {},
  totalRows: 2, totalRowsExact: true, droppedColumns: [],
};
const at = '2026-10-29T01:02:03.000Z';
const factsOf = (snapshot, limits) => researchDbImportFacts({ snapshot: { ...base, ...snapshot }, connection, capturedAt: at, limits });

test('one table of one database is one logical path: the schema is in the name, the capture time is not, and the host is matched in lower case', () => {
  const path = researchDbLogicalPath(connection, 'public', 'cohort');
  assert.match(path, /^knowledge-base\/databases\/public\.cohort-[a-f0-9]{8}\.csv$/);
  assert.equal(sourceOriginOf({ path }), 'database', 'a snapshot is a source of origin database, wherever its bytes are staged');
  assert.equal(path, researchDbLogicalPath({ ...connection, host: 'DB.Example.org' }, 'public', 'cohort'), 'importing again is the same path');
  assert.notEqual(path, researchDbLogicalPath(connection, 'analysis', 'cohort'), 'the schema is part of the identity');
  assert.notEqual(path, researchDbLogicalPath({ ...connection, database: 'other' }, 'public', 'cohort'), 'so is the database');
  assert.notEqual(path, researchDbLogicalPath({ ...connection, port: 5433 }, 'public', 'cohort'));
  assert.notEqual(researchDbLogicalPath(connection, 'a b', 'c'), researchDbLogicalPath(connection, 'a_b', 'c'), 'names that slug alike are still two files');
  assert.equal(researchDbTableKey(connection, 'public', 'cohort').length, 64);
  // Unsafe names stay inside the folder and keep a name a file can have.
  const odd = researchDbLogicalPath(connection, '../..', '患者 队列/../x');
  assert.match(odd, /^knowledge-base\/databases\/[^/]+-[a-f0-9]{8}\.csv$/u);
  assert(!odd.includes('..'));
  assert.match(researchDbLogicalPath(connection, 'x'.repeat(100), 'y'.repeat(100)), /^knowledge-base\/databases\/[x.y]{80}-[a-f0-9]{8}\.csv$/);
  assert.equal(researchDbSidecarPath('knowledge-base/databases/.evimed-revisions/' + 'a'.repeat(64) + '/public.cohort-1a2b3c4d.csv'),
    'knowledge-base/databases/.evimed-revisions/' + 'a'.repeat(64) + '/public.cohort-1a2b3c4d.import.json');
});

test('a complete import is titled by its table alone and says it is complete', () => {
  const facts = factsOf({});
  assert.equal(facts.partial, false); assert.equal(facts.rows.complete, true); assert.equal(researchDbImportTitle(facts), 'public.cohort');
  const compact = researchDbSourceFacts(facts, { sidecar: 'knowledge-base/databases/.evimed-revisions/x/public.cohort-1a2b3c4d.import.json' });
  assert.equal(compact.partial, false); assert.equal(compact.rowCount, 2); assert.equal(compact.totalRows, 2); assert.equal(compact.droppedColumnCount, 0);
  const sidecar = JSON.parse(researchDbSidecar(facts));
  assert.match(sidecar.howToRead.join(' '), /holds every row the table had/);
});

test('a truncated import puts the rows kept and the rows there are into the title, the facts and the sidecar', () => {
  const facts = factsOf({ rows: Array.from({ length: 20000 }, (_, index) => [String(index), 'x']), truncated: true, stoppedBy: 'rows', totalRows: 52340 });
  assert.equal(researchDbImportTitle(facts), 'public.cohort（前 20,000 行，共 52,340 行）');
  assert.equal(facts.partial, true); assert.equal(facts.rows.complete, false);
  const estimated = factsOf({ rows: base.rows, truncated: true, stoppedBy: 'time', totalRows: 48000, totalRowsExact: false });
  assert.equal(researchDbImportTitle(estimated), 'public.cohort（前 2 行，共约 48,000 行）');
  const unknown = factsOf({ rows: base.rows, truncated: true, stoppedBy: 'bytes', totalRows: null, totalRowsExact: false });
  assert.equal(researchDbImportTitle(unknown), 'public.cohort（前 2 行）');
  const text = JSON.parse(researchDbSidecar(facts)).howToRead.join(' ');
  assert.match(text, /NOT the whole table/); assert.match(text, /rows limit/); assert.match(text, /table has 52340 rows/);
  assert.match(text, /not a random sample/);
});

test('withheld cells and dropped columns are in the title and the sidecar, and the token is the one the CSV carries', () => {
  const facts = factsOf({ withheldCells: 12, withheldByColumn: { note: 12 }, oversizedValuesWithheld: true,
    droppedColumns: [{ name: 'doc', type: 'jsonb', reason: 'unsupported_type' }, { name: 'state', type: 'visit_state', reason: 'unsupported_type' }, { name: 'c70', type: 'integer', reason: 'over_column_limit' }] });
  assert.equal(researchDbImportTitle(facts), 'public.cohort（2 列类型不支持未导入；1 列超出列数上限未导入；12 个超长单元格已省略）');
  assert.equal(facts.withheldCells.token, RESEARCH_DB_WITHHELD_CELL);
  const sidecar = JSON.parse(researchDbSidecar(facts));
  assert.equal(sidecar.withheldCells.count, 12); assert.deepEqual(sidecar.withheldCells.byColumn, { note: 12 });
  assert.deepEqual(sidecar.droppedColumns.map(item => item.name), ['doc', 'state', 'c70']);
  assert.match(sidecar.howToRead.join(' '), new RegExp(`${RESEARCH_DB_WITHHELD_CELL}, which is neither empty nor a value`));
  assert.match(sidecar.howToRead.join(' '), /unsupported_type/); assert.match(sidecar.howToRead.join(' '), /An empty cell is a NULL/);
  assert.equal(sidecar.table.name, 'cohort'); assert.equal(sidecar.database.name, 'research');
  assert(!JSON.stringify(sidecar).match(/password|username/i), 'no credential, no user name');
});

test('the facts kept on the source are bounded: fifty columns named, the rest counted', () => {
  const dropped = Array.from({ length: 200 }, (_, index) => ({ name: `j${index}`, type: 'jsonb', reason: 'unsupported_type' }));
  const facts = factsOf({ droppedColumns: dropped, withheldCells: 3, withheldByColumn: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`w${index}`, 1])) });
  const compact = researchDbSourceFacts(facts, { sidecar: 'knowledge-base/databases/.evimed-revisions/x/y.import.json' });
  assert.equal(compact.droppedColumnCount, 200); assert.equal(compact.droppedColumns.length, 50); assert.equal(compact.withheldColumns.length, 50);
  assert(Buffer.byteLength(JSON.stringify(compact)) < 16_384, 'a source record accepts it');
  assert.equal(JSON.parse(researchDbSidecar(facts)).droppedColumns.length, 200, 'the sidecar has them all');
  assert.equal(compact.kind, 'research-database-snapshot');
});
