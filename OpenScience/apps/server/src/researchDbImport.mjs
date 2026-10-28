import { createHash } from 'node:crypto';
import path from 'node:path';
import { SOURCE_FOLDERS } from '@evimed/domain';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';
import { researchDbHostName } from './researchDbNetwork.mjs';
import { RESEARCH_DB_WITHHELD_CELL } from './researchDbSnapshot.mjs';

/**
 * What an imported table is, said where a person and a run read it (2026-10-29).
 *
 * A snapshot is bounded: rows past the row cap, the byte cap or the read time are not in it; a cell over the cell limit is
 * withheld; a column of a type the snapshot does not read, or past the column cap, is not in the file. None of that may be
 * invisible, because a CSV that looks like the whole table is read as the whole table. So the same facts are written four
 * times from one object:
 *
 * - the source's TITLE, as a suffix a person reads in the knowledge base (`public.cohort（前 20,000 行，共 52,340 行）`);
 * - the source's payload (`payload.snapshot`, the compact form), which the page and the study's material entry read;
 * - a SIDECAR file `<name>.import.json` beside the CSV, which a run opens (the study's material entry names its path);
 * - the connector's result, which the dialog shows once.
 *
 * And the source keeps ONE identity per connection + schema + table: the logical path is derived from the database's
 * address and the table, not from the capture time, so importing a table again is a new version of the same source (the
 * registry retires the old version and tells what rests on it), not a second source that piles up.
 *
 * @module researchDbImport
 */

/** The longest list of dropped columns or withheld-cell columns the payload and the result carry (the sidecar carries all). */
const LISTED = 50;
/** @typedef {import('./researchDbConfig.mjs').ResearchDbLimits} Limits */

/** @param {number} value */
const count = value => value.toLocaleString('en-US');

/** A name a file can keep: letters and digits of any script, `_`, `-` and `.`; everything else becomes one underscore.
 * @param {string} value @param {number} max */
function slug(value, max) {
  return [...String(value).replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/\.{2,}/g, '.').replace(/^[_.]+|[_.]+$/g, '')].slice(0, max).join('');
}

/** The identity of the remote table: the database by its address as the allowlist spells it, then the schema and the table.
 * @param {{host:string,port:number,database:string}} connection @param {string} schema @param {string} table */
export function researchDbTableKey(connection, schema, table) {
  return createHash('sha256').update(JSON.stringify([researchDbHostName(connection.host), connection.port, connection.database, schema, table])).digest('hex');
}

/**
 * The logical path of a table's CSV: `knowledge-base/databases/<schema>.<table>-<8 hex>.csv`. The schema is in the name, and
 * the eight hex digits are the table key's, so two tables that slug to one name, or the same name in two databases, are two
 * files; the same table imported again is the same path. The registry stages the bytes under
 * `knowledge-base/databases/.evimed-revisions/<sha256>/` and keeps this path as the source's logical path.
 * @param {{host:string,port:number,database:string}} connection @param {string} schema @param {string} table */
export function researchDbLogicalPath(connection, schema, table) {
  const name = slug(`${schema}.${table}`, 80) || 'table';
  return `${SOURCE_FOLDERS.databases}/${name}-${researchDbTableKey(connection, schema, table).slice(0, 8)}.csv`;
}

/** The sidecar's path for a CSV path: the same directory, `<stem>.import.json`. @param {string} csvPath */
export function researchDbSidecarPath(csvPath) {
  const base = path.posix.basename(csvPath);
  return path.posix.join(path.posix.dirname(csvPath), `${base.replace(/\.csv$/i, '')}.import.json`);
}

/**
 * Everything a snapshot left out, from the snapshot the reader returned.
 * @param {{snapshot: any, connection: {host:string,port:number,database:string}, capturedAt: string, limits?: Limits}} input
 */
export function researchDbImportFacts({ snapshot, connection, capturedAt, limits = RESEARCH_DB_LIMIT_DEFAULTS }) {
  const dropped = Array.isArray(snapshot.droppedColumns) ? snapshot.droppedColumns : [];
  const withheldCells = Number(snapshot.withheldCells) || 0;
  const truncated = snapshot.truncated === true;
  const unsupported = dropped.filter((/** @type {any} */ item) => item.reason === 'unsupported_type').length;
  const overLimit = dropped.filter((/** @type {any} */ item) => item.reason === 'over_column_limit').length;
  return {
    schemaVersion: 1,
    kind: 'research-database-snapshot',
    capturedAt,
    database: { host: researchDbHostName(connection.host), port: connection.port, name: connection.database },
    table: { schema: snapshot.schema, name: snapshot.table },
    // `total` is null when the remote database would not count and the catalogue had no estimate; `totalExact` false means an estimate.
    rows: { exported: snapshot.rows.length, total: snapshot.totalRows ?? null, totalExact: snapshot.totalRowsExact !== false, complete: !truncated,
      stoppedBy: snapshot.stoppedBy ?? null, order: 'physical' },
    columns: snapshot.columnTypes.map((/** @type {any} */ column) => ({ name: column.name, type: column.postgresType })),
    droppedColumns: dropped.map((/** @type {any} */ item) => ({ name: item.name, type: item.type, reason: item.reason })),
    droppedColumnCount: dropped.length,
    droppedForType: unsupported,
    droppedForLimit: overLimit,
    withheldCells: { count: withheldCells, byColumn: snapshot.withheldByColumn ?? {}, token: RESEARCH_DB_WITHHELD_CELL, limitBytes: limits.cellBytes },
    limits: { rows: limits.rows, columns: limits.columns, bytes: limits.bytes, cellBytes: limits.cellBytes },
    partial: truncated || withheldCells > 0 || dropped.length > 0,
  };
}

/** @typedef {ReturnType<typeof researchDbImportFacts>} ResearchDbImportFacts */

/**
 * The source's title: the table, then what was left out, in the words a researcher reads in the knowledge base.
 * @param {ResearchDbImportFacts} facts
 */
export function researchDbImportTitle(facts) {
  const notes = [];
  if (!facts.rows.complete) {
    const total = facts.rows.total;
    notes.push(total === null ? `前 ${count(facts.rows.exported)} 行`
      : `前 ${count(facts.rows.exported)} 行，共${facts.rows.totalExact ? '' : '约'} ${count(total)} 行`);
  }
  if (facts.droppedForType) notes.push(`${count(facts.droppedForType)} 列类型不支持未导入`);
  if (facts.droppedForLimit) notes.push(`${count(facts.droppedForLimit)} 列超出列数上限未导入`);
  if (facts.withheldCells.count) notes.push(`${count(facts.withheldCells.count)} 个超长单元格已省略`);
  const base = `${facts.table.schema}.${facts.table.name}`;
  return notes.length ? `${base}（${notes.join('；')}）` : base;
}

/**
 * The compact form kept on the source (`payload.snapshot`) and returned to the dialog: the same facts, with the lists of
 * columns cut at fifty and counted. The sidecar has them whole.
 * @param {ResearchDbImportFacts} facts @param {{sidecar: string}} where
 */
export function researchDbSourceFacts(facts, where) {
  return {
    kind: facts.kind, capturedAt: facts.capturedAt, database: facts.database, schema: facts.table.schema, table: facts.table.name,
    rowCount: facts.rows.exported, totalRows: facts.rows.total, totalRowsExact: facts.rows.totalExact, truncated: !facts.rows.complete, stoppedBy: facts.rows.stoppedBy,
    columnCount: facts.columns.length, droppedColumnCount: facts.droppedColumnCount, droppedColumns: facts.droppedColumns.slice(0, LISTED),
    withheldCells: facts.withheldCells.count, withheldColumns: Object.keys(facts.withheldCells.byColumn).slice(0, LISTED),
    partial: facts.partial, sidecar: where.sidecar,
  };
}

/** The sidecar a run opens next to the CSV: the facts whole, and the sentences that say how to read the file.
 * @param {ResearchDbImportFacts} facts */
export function researchDbSidecar(facts) {
  const lines = [
    'This CSV is a snapshot of one table in the researcher\'s own PostgreSQL database, read at the time above. Read this file before relying on the CSV.',
    facts.rows.complete
      ? 'The snapshot holds every row the table had when it was read.'
      : `The snapshot is NOT the whole table: it holds the first ${facts.rows.exported} rows in the table's physical order (no ORDER BY), stopped by the ${facts.rows.stoppedBy} limit${facts.rows.total === null ? '' : `; the table has ${facts.rows.totalExact ? '' : 'about '}${facts.rows.total} rows`}. A subset in physical order is not a random sample; do not estimate prevalences, means or trends for the whole table from it.`,
    'An empty cell is a NULL in the table.',
    facts.withheldCells.count
      ? `${facts.withheldCells.count} cells longer than ${facts.withheldCells.limitBytes} bytes were not transferred. Each is written as ${facts.withheldCells.token}, which is neither empty nor a value: treat it as missing. The columns and counts are in withheldCells.byColumn.`
      : `A cell longer than ${facts.withheldCells.limitBytes} bytes would be written as ${facts.withheldCells.token}; none was.`,
    facts.droppedColumnCount
      ? `${facts.droppedColumnCount} columns of the table are not in the CSV (droppedColumns): "unsupported_type" is a type the snapshot does not read (enum, domain, jsonb, array, time, interval, ...); "over_column_limit" is a column past the first ${facts.limits.columns}.`
      : 'Every column of the table that the person selected is in the CSV.',
    'Timestamps are in UTC; dates are ISO. The values are the table\'s own text, unchanged.',
  ];
  return Buffer.from(`${JSON.stringify({ ...facts, howToRead: lines }, null, 2)}\n`, 'utf8');
}
