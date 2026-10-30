import { HttpError } from './security.mjs';
import { RESEARCH_DB_LIMIT_DEFAULTS } from './researchDbConfig.mjs';

const invalid = () => new HttpError(400, 'research_db_selection_invalid', 'The selected database table or columns are not supported.');
/** The remote role may read anything, or bypass row security: the platform will not read with it. */
const tooPrivileged = () => new HttpError(400, 'research_db_login_too_privileged', 'The database login is a superuser or bypasses row security; use a read-only login.');
/** Built-in column types a snapshot reads (bool, int8, int2, int4, text, float4, float8, bpchar, varchar, date, timestamp, timestamptz, numeric, uuid). */
const types = new Set([16, 20, 21, 23, 25, 700, 701, 1042, 1043, 1082, 1114, 1184, 1700, 2950]);
const typeOids = [...types];
/** What stands in a CSV cell whose value was longer than the cell limit and was withheld in the remote database. It is not
 * empty, because an empty cell is a null; the sidecar of the import names it (`researchDbImport.mjs`). */
export const RESEARCH_DB_WITHHELD_CELL = '__evimed_withheld__';
/** How many unsupported columns a table's listing names (the rest are counted): the dialog shows a few, a table has up to 1,600. */
export const RESEARCH_DB_UNSUPPORTED_LISTED = 50;
/** @typedef {import('./researchDbConfig.mjs').ResearchDbLimits} Limits */

/** @param {unknown} value */
function identifier(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 63 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  return `"${value.replaceAll('"', '""')}"`;
}

/** Run `work` in a bounded read-only transaction on an admissible session, then roll back. The role may not
 * bypass row security, and the target must not be this platform's own control-plane database.
 * @template T @param {any} client @param {() => Promise<T>} work @returns {Promise<T>} */
async function readOnly(client, work) {
  let opened = false;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY'); opened = true;
    // The limits apply to each statement; a snapshot is read as a series of short FETCH statements.
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await client.query('SET LOCAL search_path = pg_catalog');
    // Dates and timestamps render the same whatever the remote role or database default is.
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    const role = await client.query('SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user');
    // A role that can read past row security is refused for what it is, in a sentence that says so, and not as a
    // table the person should change: the same login fails for every table.
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw tooPrivileged();
    const internal = await client.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('evimed_control', 'evimed_product', 'evimed_usage')) AS internal");
    if (internal.rows[0]?.internal !== false) throw invalid();
    return await work();
  } finally { if (opened) await client.query('ROLLBACK').catch(() => {}); }
}

/** Ordinary tables the connected role can read, with their columns of a supported type and the ones that are left out:
 * no views, no row security, no system or platform schemas. Never accepts SQL or names; the catalogue is the only input.
 * Per table: `columns` (the supported ones, first `limits.columns` by position), `omittedColumnCount` (supported ones
 * past that), `unsupportedColumns` (up to 50 `{name,type}` of a type the snapshot does not read -- enum, domain, jsonb,
 * array, time, interval, ...) and `unsupportedColumnCount`.
 * @param {any} client @param {{limits?: Limits}} [options]
 * @returns {Promise<{tables: {schema:string,table:string,estimatedRows:number|null,columns:{name:string,type:string}[],omittedColumnCount:number,unsupportedColumns:{name:string,type:string}[],unsupportedColumnCount:number}[], truncated:boolean}>} */
export async function listResearchTables(client, { limits = RESEARCH_DB_LIMIT_DEFAULTS } = {}) {
  return readOnly(client, async () => {
    const found = await client.query(`SELECT c.oid, n.nspname, c.relname, c.reltuples
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND NOT c.relrowsecurity AND left(n.nspname, 3) <> 'pg_' AND n.nspname <> 'information_schema'
        AND n.nspname NOT IN ('evimed_control', 'evimed_product', 'evimed_usage')
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = ANY($1::oid[]))
      ORDER BY n.nspname, c.relname LIMIT ${limits.tables + 1}`, [typeOids]);
    const kept = found.rows.slice(0, limits.tables);
    if (!kept.length) return { tables: [], truncated: false };
    // Both kinds of column in one read: the supported ones up to the column limit, the unsupported ones up to the number the
    // dialog names, and each kind's total, so what is left out is counted and not only cut.
    const attributes = await client.query(`SELECT attrelid, attname, type_name, supported, total FROM (
        SELECT attrelid, attname, attnum, pg_catalog.format_type(atttypid, atttypmod) AS type_name, supported,
          row_number() OVER (PARTITION BY attrelid, supported ORDER BY attnum) AS position,
          count(*) OVER (PARTITION BY attrelid, supported) AS total
        FROM (SELECT attrelid, attname, attnum, atttypid, atttypmod, (atttypid = ANY($2::oid[])) AS supported
          FROM pg_catalog.pg_attribute WHERE attrelid = ANY($1::oid[]) AND attnum > 0 AND NOT attisdropped) base) a
      WHERE (supported AND position <= ${limits.columns}) OR (NOT supported AND position <= ${RESEARCH_DB_UNSUPPORTED_LISTED}) ORDER BY attrelid, attnum`, [kept.map(row => Number(row.oid)), typeOids]);
    /** @type {Map<number, {columns:{name:string,type:string}[],unsupported:{name:string,type:string}[],supportedTotal:number,unsupportedTotal:number}>} */
    const byRelation = new Map();
    for (const row of attributes.rows) {
      const id = Number(row.attrelid);
      const entry = byRelation.get(id) ?? { columns: [], unsupported: [], supportedTotal: 0, unsupportedTotal: 0 };
      const item = { name: row.attname, type: row.type_name };
      // A mock that does not say which kind a row is lists it as a supported column, as the listing always did.
      if (row.supported === false) { entry.unsupported.push(item); entry.unsupportedTotal = Number(row.total) || entry.unsupported.length; }
      else { entry.columns.push(item); entry.supportedTotal = Number(row.total) || entry.columns.length; }
      byRelation.set(id, entry);
    }
    return {
      // `reltuples` is -1 for a table PostgreSQL has not analysed yet: that is "unknown", not zero.
      tables: kept.map(row => {
        const entry = byRelation.get(Number(row.oid));
        return { schema: row.nspname, table: row.relname, estimatedRows: Number(row.reltuples) >= 0 ? Math.round(Number(row.reltuples)) : null,
          columns: entry?.columns ?? [], omittedColumnCount: Math.max(0, (entry?.supportedTotal ?? 0) - (entry?.columns.length ?? 0)),
          unsupportedColumns: entry?.unsupported ?? [], unsupportedColumnCount: entry?.unsupportedTotal ?? 0 };
      }),
      truncated: found.rows.length > limits.tables,
    };
  });
}

/** The table's number of rows, counted in a savepoint so that a count the remote database will not finish in its statement
 * timeout costs nothing but the answer. `null` when it could not be counted.
 * @param {any} client @param {string} schema @param {string} table @returns {Promise<number | null>} */
async function countRows(client, schema, table) {
  try {
    await client.query('SAVEPOINT research_count');
    const counted = await client.query(`SELECT count(*)::text AS n FROM ONLY ${schema}.${table}`);
    await client.query('RELEASE SAVEPOINT research_count');
    const n = Number(counted.rows[0]?.n);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT research_count').catch(() => {});
    return null;
  }
}

/** Export a bounded snapshot of selected built-in typed columns of one ordinary table, read as a cursor in short
 * batches so a table larger than the caps ends as a truncated snapshot and not as a failed read. `columns` empty or
 * omitted selects every supported column (first `limits.columns` by position). Rows are arrays of cell text in column
 * order; a null is `null`, and a cell over the cell limit is `RESEARCH_DB_WITHHELD_CELL` (it is withheld in the remote
 * database, never transferred whole, and counted).
 * This function does not accept SQL, expressions, views, RLS policies, custom types or arbitrary functions.
 * Rows come in the table's physical order: a truncated snapshot is a subset, not a sample.
 *
 * Everything the snapshot leaves out is reported, so the import can say it:
 * `truncated` and `stoppedBy` (`rows`, `bytes` or `time`), `totalRows` with `totalRowsExact` (counted when the snapshot is
 * cut, else the rows read; an estimate from the catalogue when the count does not finish), `withheldCells` with
 * `withheldByColumn`, and `droppedColumns` -- `{name,type,reason}` with reason `unsupported_type` or `over_column_limit`.
 * @param {any} client @param {{schema:string,table:string,columns?:string[]}} request @param {{limits?: Limits}} [options] */
export async function snapshotResearchTable(client, request, { limits = RESEARCH_DB_LIMIT_DEFAULTS } = {}) {
  const requested = request?.columns ?? [];
  if (!request || !Array.isArray(requested) || requested.length > limits.columns || new Set(requested).size !== requested.length) throw invalid();
  const schema = identifier(request.schema), table = identifier(request.table), explicit = requested.map(identifier);
  if (request.schema === 'pg_catalog' || request.schema === 'information_schema' || request.schema.startsWith('pg_')) throw invalid();
  return readOnly(client, async () => {
    // Hold the selected relation stable while checking its identity and reading it.
    await client.query(`LOCK TABLE ONLY ${schema}.${table} IN ACCESS SHARE MODE`);
    const relation = await client.query(`SELECT c.oid, c.relkind, c.relrowsecurity, c.reltuples, pg_catalog.has_table_privilege(c.oid, 'SELECT') AS allowed
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [request.schema, request.table]);
    const rel = relation.rows[0];
    if (relation.rows.length !== 1 || rel.relkind !== 'r' || rel.relrowsecurity || !rel.allowed) throw invalid();
    // Every live column of the table, so the ones that are not in the file can be named.
    const attributes = await client.query(`SELECT attname, atttypid, pg_catalog.format_type(atttypid, atttypmod) AS type_name FROM pg_catalog.pg_attribute
      WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [rel.oid]);
    const all = attributes.rows;
    const supported = all.filter(row => types.has(Number(row.atttypid)));
    /** @type {{attname:string,atttypid:number,type_name:string}[]} */ let chosen;
    if (requested.length) {
      chosen = requested.map(name => supported.find(row => row.attname === name)).filter(row => row !== undefined);
      if (chosen.length !== requested.length) throw invalid();
    } else {
      chosen = supported.slice(0, limits.columns);
      if (!chosen.length) throw invalid();
    }
    const names = chosen.map(row => String(row.attname));
    /** @type {{name:string,type:string,reason:'unsupported_type'|'over_column_limit'}[]} */
    const droppedColumns = [
      ...all.filter(row => !types.has(Number(row.atttypid))).map(row => ({ name: String(row.attname), type: String(row.type_name), reason: /** @type {const} */ ('unsupported_type') })),
      ...(requested.length ? [] : supported.slice(limits.columns).map(row => ({ name: String(row.attname), type: String(row.type_name), reason: /** @type {const} */ ('over_column_limit') }))),
    ];
    const columns = requested.length ? explicit : names.map(identifier);
    // Values over the cell limit are withheld, not transferred to the server process; a per-row string of 0/1
    // marks them, so a null stays distinguishable without doubling the width of the result.
    const cap = limits.cellBytes;
    const fields = columns.map(column => `CASE WHEN pg_catalog.octet_length(${column}::text) <= ${cap} THEN ${column}::text ELSE NULL END`);
    const flags = columns.map(column => `CASE WHEN pg_catalog.octet_length(${column}::text) > ${cap} THEN '1' ELSE '0' END`);
    await client.query(`DECLARE research_snapshot NO SCROLL CURSOR FOR SELECT ${fields.join(', ')}, pg_catalog.concat(${flags.join(', ')}) FROM ONLY ${schema}.${table} LIMIT ${limits.rows + 1}`);
    /** @type {(string|null)[][]} */ const rows = []; let bytes = 0, batch = 50, withheldCells = 0;
    /** @type {null | 'rows' | 'bytes' | 'time'} */ let stoppedBy = null;
    const withheldCounts = names.map(() => 0);
    const deadline = Date.now() + limits.readMs;
    read: for (;;) {
      const page = await client.query({ text: `FETCH FORWARD ${batch} FROM research_snapshot`, rowMode: 'array' });
      if (!page.rows.length) break;
      let pageBytes = 0;
      for (const values of page.rows) {
        if (rows.length === limits.rows) { stoppedBy = 'rows'; break read; }
        const withheld = String(values[names.length] ?? '');
        /** @type {(string|null)[]} */
        const row = names.map((_, index) => withheld[index] === '1' ? RESEARCH_DB_WITHHELD_CELL : values[index] ?? null);
        const size = row.reduce((/** @type {number} */ sum, cell) => sum + (cell === null ? 1 : Buffer.byteLength(cell) + 1), 0);
        if (bytes + size > limits.bytes) { stoppedBy = 'bytes'; break read; }
        bytes += size; pageBytes += size; rows.push(row);
        for (let index = 0; index < names.length; index += 1) if (withheld[index] === '1') { withheldCounts[index] += 1; withheldCells += 1; }
      }
      // About a megabyte a batch, so no single response outgrows what the transport admits.
      batch = Math.max(1, Math.min(2000, Math.floor(1048576 / Math.max(1, pageBytes / page.rows.length))));
      if (Date.now() > deadline) { stoppedBy = 'time'; break; }
    }
    const truncated = stoppedBy !== null;
    // A cut snapshot says how much there was: counted if the remote database will count it, else the catalogue's estimate.
    let totalRows = rows.length, totalRowsExact = true;
    if (truncated) {
      const counted = await countRows(client, schema, table);
      if (counted !== null) totalRows = Math.max(counted, rows.length);
      else {
        const estimate = Number(rel.reltuples);
        totalRows = Number.isFinite(estimate) && estimate >= rows.length ? Math.round(estimate) : /** @type {any} */ (null);
        totalRowsExact = false;
      }
    }
    const columnTypes = chosen.map(row => ({ name: String(row.attname), oid: Number(row.atttypid), postgresType: String(row.type_name) }));
    return { schema: request.schema, table: request.table, columns: names, columnTypes, rows, truncated, stoppedBy, oversizedValuesWithheld: withheldCells > 0,
      withheldCells, withheldByColumn: Object.fromEntries(names.flatMap((name, index) => (withheldCounts[index] > 0 ? [[name, withheldCounts[index]]] : []))),
      totalRows, totalRowsExact, droppedColumns };
  });
}

/** RFC 4180 CSV with a header row, CRLF line ends and a UTF-8 byte order mark so Excel reads Chinese text correctly.
 * Nulls are empty cells; a withheld cell is `RESEARCH_DB_WITHHELD_CELL`, never empty. Cells are written as they are in the table.
 * @param {{columns:string[], rows:(string|null)[][]}} snapshot */
export function researchTableCsv(snapshot) {
  /** @param {string|null} value */
  const cell = value => value === null ? '' : /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = [snapshot.columns.map(cell).join(','), ...snapshot.rows.map(row => row.map(cell).join(','))];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}
