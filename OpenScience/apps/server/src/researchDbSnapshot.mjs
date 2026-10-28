import { HttpError } from './security.mjs';

const invalid = () => new HttpError(400, 'research_db_selection_invalid', 'The selected database table or columns are not supported.');
const types = new Set([16, 20, 21, 23, 25, 700, 701, 1042, 1043, 1082, 1114, 1184, 1700, 2950]);
/** @param {unknown} value */
function identifier(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 63 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  return `"${value.replaceAll('"', '""')}"`;
}

/** Export a bounded snapshot of explicitly selected built-in typed columns of one ordinary table.
 * This function does not accept SQL, expressions, views, RLS policies, custom types or arbitrary functions.
 * @param {any} client @param {{schema:string,table:string,columns:string[]}} request */
export async function snapshotResearchTable(client, request) {
  if (!request || !Array.isArray(request.columns) || !request.columns.length || request.columns.length > 24
    || new Set(request.columns).size !== request.columns.length) throw invalid();
  const schema = identifier(request.schema), table = identifier(request.table), columns = request.columns.map(identifier);
  if (request.schema === 'pg_catalog' || request.schema === 'information_schema' || request.schema.startsWith('pg_')) throw invalid();
  let opened = false;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY'); opened = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    await client.query('SET LOCAL search_path = pg_catalog');
    const role = await client.query('SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user');
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw invalid();
    const internal = await client.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('evimed_control', 'evimed_product', 'evimed_usage')) AS internal");
    if (internal.rows[0]?.internal !== false) throw invalid();
    // Hold the selected relation stable while checking its identity and reading it.
    await client.query(`LOCK TABLE ONLY ${schema}.${table} IN ACCESS SHARE MODE`);
    const relation = await client.query(`SELECT c.oid, c.relkind, c.relrowsecurity, pg_catalog.has_table_privilege(c.oid, 'SELECT') AS allowed
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [request.schema, request.table]);
    const rel = relation.rows[0];
    if (relation.rows.length !== 1 || rel.relkind !== 'r' || rel.relrowsecurity || !rel.allowed) throw invalid();
    const metadata = await client.query(`SELECT attname, atttypid, pg_catalog.format_type(atttypid, atttypmod) AS type_name FROM pg_catalog.pg_attribute
      WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped AND attname = ANY($2::text[])`, [rel.oid, request.columns]);
    if (metadata.rows.length !== columns.length || metadata.rows.some(row => !types.has(Number(row.atttypid)))) throw invalid();
    // Values over the cell limit are withheld, not transferred to the server process.
    const fields = columns.map(column => `CASE WHEN pg_catalog.octet_length(${column}::text) <= 2048 THEN ${column}::text ELSE NULL END AS ${column}`);
    const oversized = columns.map(column => `COALESCE(pg_catalog.octet_length(${column}::text) > 2048, false)`);
    const result = await client.query({ text: `SELECT ${fields.join(', ')}, ${oversized.join(', ')} FROM ONLY ${schema}.${table} LIMIT 201`, rowMode: 'array' });
    const rows = []; let bytes = 0; let truncated = result.rows.length > 200; let oversizedValuesWithheld = false;
    for (const values of result.rows.slice(0, 200)) {
      const row = Object.fromEntries(request.columns.map((name, index) => {
        const withheld = values[columns.length + index] === true;
        return [name, withheld ? { state: 'withheld' } : values[index] === null ? { state: 'null' } : { state: 'value', value: values[index] }];
      }));
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 512 * 1024) { truncated = true; break; }
      bytes += size; rows.push(row); oversizedValuesWithheld ||= values.slice(columns.length).some(value => value === true);
    }
    const byName = new Map(metadata.rows.map(item => [item.attname, item]));
    const columnTypes = request.columns.map(name => ({ name, oid: Number(byName.get(name).atttypid), postgresType: byName.get(name).type_name }));
    return { schema: request.schema, table: request.table, columns: request.columns, columnTypes, rows, truncated, oversizedValuesWithheld };
  } finally { if (opened) await client.query('ROLLBACK').catch(() => {}); }
}
