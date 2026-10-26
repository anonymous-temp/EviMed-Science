/** Explicit, offline operator retirement. Never imported by application startup.
 * Usage (PG* environment; no connection string in argv):
 *   node scripts/ops/vcr-retire-recruitment.mjs --archive /private/archive.json
 *   node scripts/ops/vcr-retire-recruitment.mjs --restore-readback /private/archive.json --sha256 HASH
 *   node scripts/ops/vcr-retire-recruitment.mjs --retire /private/archive.json --sha256 HASH --expected-database IDENTITY_HASH
 *     --workers-stopped --allow-drop-approved-tables --allow-delete-retired-members
 * Stop ALL old application/worker clients first and prevent their restart. The destructive command additionally refuses any other
 * client connection to this database. Archives contain sensitive historical rows and must be retained in private backup storage.
 * Only the three approved tables and recruiter/site MEMBER rows are retired. Follow-up, research, grants and audit stay intact.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const RETIRED_TABLES = Object.freeze(['sites', 'referrals', 'referral_events']);
export const RETIRED_ROLES = Object.freeze(['recruiter', 'site']);
const FORMAT = 'evimed-vcr-recruitment-archive-v2';
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-v1'))";
const q = value => `"${String(value).replaceAll('"', '""')}"`;
const fail = code => Object.assign(new Error(code), { code });
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const archiveDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
const tableName = table => `evimed_vcr.${q(table)}`;

async function identity(client) {
  // Cluster identity survives restarts and database names are not enough to identify a database. Operator privileges are needed.
  const { rows } = await client.query(`SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    system_identifier::text AS cluster FROM pg_control_system()`);
  return rows[0];
}
async function columns(client, table) {
  return (await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [`evimed_vcr.${table}`])).rows;
}
// Keep PostgreSQL JSON text intact: JS Number cannot round-trip arbitrary numeric/JSONB values.
async function rowsOf(client, table, roleOnly = false, schema = 'evimed_vcr') {
  return (await client.query(`SELECT to_jsonb(t)::text AS row FROM ${q(schema)}.${q(table)} t${roleOnly ? ' WHERE role = ANY($1::text[])' : ''} ORDER BY to_jsonb(t)::text`, roleOnly ? [[...RETIRED_ROLES]] : [])).rows.map(row => row.row);
}
async function present(client, table) {
  return Boolean((await client.query('SELECT to_regclass($1) AS relation', [`evimed_vcr.${table}`])).rows[0]?.relation);
}
async function capture(client) {
  const tables = {};
  for (const table of RETIRED_TABLES) {
    const exists = await present(client, table);
    tables[table] = { exists, columns: exists ? await columns(client, table) : [],
      constraints: exists ? (await client.query(`SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=to_regclass($1) ORDER BY conname`, [`evimed_vcr.${table}`])).rows : [],
      indexes: exists ? (await client.query(`SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='evimed_vcr' AND tablename=$1 ORDER BY indexname`, [table])).rows : [],
      rows: exists ? await rowsOf(client, table) : [] };
  }
  const memberColumns = await columns(client, 'members');
  const members = await rowsOf(client, 'members', true);
  // Role selectors in grants are preserved, not deleted: they are scientific data permissions, not study membership rows.
  const grantRoleCounts = (await client.query(`SELECT role,count(*)::integer AS count FROM evimed_vcr.grants WHERE role=ANY($1::text[]) GROUP BY role ORDER BY role`, [[...RETIRED_ROLES]])).rows;
  return { identity: await identity(client), tables, members: { columns: memberColumns, rows: members }, grantRoleCounts };
}
function validateArchive(archive) {
  if (archive?.format !== FORMAT || !archive.snapshot?.identity || !archive.snapshot?.members
    || JSON.stringify(Object.keys(archive.snapshot.tables).sort()) !== JSON.stringify([...RETIRED_TABLES].sort())) throw fail('vcr_retirement_archive_invalid');
  for (const table of Object.values(archive.snapshot.tables)) {
    if (!Array.isArray(table.rows) || table.rows.some(row => typeof row !== 'string') || !Array.isArray(table.columns) || !Array.isArray(table.constraints) || !Array.isArray(table.indexes)) throw fail('vcr_retirement_archive_invalid');
  }
  if (!Array.isArray(archive.snapshot.members.rows) || archive.snapshot.members.rows.some(row => typeof row !== 'string' || !RETIRED_ROLES.includes(JSON.parse(row).role))) throw fail('vcr_retirement_archive_invalid');
  if (archive.snapshotDigest !== archiveDigest(archive.snapshot)) throw fail('vcr_retirement_archive_invalid');
}
function metadata(archive, sha256) {
  return { format: FORMAT, createdAt: archive.createdAt, sha256, snapshotDigest: archive.snapshotDigest,
    databaseIdentity: archiveDigest(archive.snapshot.identity),
    counts: Object.fromEntries(RETIRED_TABLES.map(table => [table, archive.snapshot.tables[table].rows.length])),
    retiredMembers: archive.snapshot.members.rows.length, grantRoleCounts: archive.snapshot.grantRoleCounts,
    readbackVerified: archive.readbackVerified === true };
}
/** Restore the archived typed rows in a disposable schema, compare every value, then roll the schema back. No source row changes. */
export async function verifyArchiveReadback(client, archive) {
  validateArchive(archive);
  const schema = `vcr_retirement_verify_${randomUUID().replaceAll('-', '')}`;
  await client.query('SAVEPOINT vcr_retirement_readback');
  try {
    await client.query(`CREATE SCHEMA ${q(schema)}`);
    const datasets = [...RETIRED_TABLES.filter(table => archive.snapshot.tables[table].exists).map(table => [table, archive.snapshot.tables[table]]), ['members', archive.snapshot.members]];
    for (const [table, data] of datasets) {
      // Column types, not inferred JSON types. Member constraints intentionally stay in the live schema: legacy roles are retired.
      await client.query(`CREATE TABLE ${q(schema)}.${q(table)} (${data.columns.map(column => `${q(column.name)} ${column.type}${column.required ? ' NOT NULL' : ''}`).join(',')})`);
      if (data.rows.length) await client.query(`INSERT INTO ${q(schema)}.${q(table)} SELECT * FROM jsonb_populate_recordset(NULL::${q(schema)}.${q(table)},$1::jsonb)`, [`[${data.rows.join(',')}]`]);
    }
    // Validate the original table constraints, including relationships among the three archived tables.
    for (const table of RETIRED_TABLES) for (const constraint of archive.snapshot.tables[table].constraints) {
      let definition = constraint.definition;
      for (const retired of RETIRED_TABLES) definition = definition.replaceAll(`REFERENCES evimed_vcr.${retired}`, `REFERENCES ${q(schema)}.${q(retired)}`);
      await client.query(`ALTER TABLE ${q(schema)}.${q(table)} ADD CONSTRAINT ${q(constraint.name)} ${definition}`);
    }
    for (const table of RETIRED_TABLES) {
      const data = archive.snapshot.tables[table];
      for (const index of data.indexes) {
        if (data.constraints.some(constraint => constraint.name === index.name)) continue;
        const definition = index.definition.replace(` ON evimed_vcr.${table} `, ` ON ${q(schema)}.${q(table)} `);
        if (definition === index.definition) throw fail('vcr_retirement_index_schema_invalid');
        await client.query(definition);
      }
    }
    for (const [table, data] of datasets) {
      const restored = await rowsOf(client, table, false, schema);
      if (archiveDigest(restored) !== archiveDigest(data.rows)) throw fail('vcr_retirement_restore_mismatch');
    }
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT vcr_retirement_readback');
    await client.query('RELEASE SAVEPOINT vcr_retirement_readback');
  }
  return true;
}
async function writePrivate(file, bytes) {
  if (!path.isAbsolute(file)) throw fail('vcr_retirement_absolute_archive_required');
  const directory = await fs.lstat(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) throw fail('vcr_retirement_private_directory_required');
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readPrivate(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 512 * 1024 * 1024) throw fail('vcr_retirement_archive_permissions');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function loadArchive(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw fail('vcr_retirement_hash_required');
  const bytes = await readPrivate(file);
  if (archiveDigest(bytes) !== expectedSha256) throw fail('vcr_retirement_archive_hash_mismatch');
  const archive = JSON.parse(bytes.toString('utf8'));
  validateArchive(archive);
  const meta = JSON.parse((await readPrivate(`${file}.meta.json`)).toString('utf8'));
  if (archiveDigest(meta) !== archiveDigest(metadata(archive, expectedSha256)) || !archive.readbackVerified) throw fail('vcr_retirement_metadata_mismatch');
  return archive;
}
/** Counts and hashes are safe for operator stdout; archive rows never are. */
export async function archiveRecruitment(client, file) {
  // Read the source only after all write-blocking locks: a pre-lock snapshot could miss a short-lived writer.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query(LOCK);
    for (const table of RETIRED_TABLES) if (await present(client, table)) await client.query(`LOCK TABLE ${tableName(table)} IN SHARE MODE`);
    await client.query('LOCK TABLE evimed_vcr.members, evimed_vcr.grants IN SHARE MODE');
    const snapshot = await capture(client);
    const archive = { format: FORMAT, createdAt: new Date().toISOString(), snapshot, snapshotDigest: archiveDigest(snapshot), readbackVerified: true };
    await verifyArchiveReadback(client, archive);
    const bytes = `${JSON.stringify(archive)}\n`;
    const meta = metadata(archive, archiveDigest(bytes));
    await writePrivate(file, bytes);
    await writePrivate(`${file}.meta.json`, `${JSON.stringify(meta)}\n`);
    // Read back the on-disk bytes and metadata, not the in-memory object, before declaring the archive usable.
    await loadArchive(file, meta.sha256);
    await client.query('COMMIT');
    return meta;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function assertOffline(client) {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const others = (await client.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows[0]?.count;
  if (Number(others) !== 0) throw fail('vcr_retirement_other_database_clients');
}
/** All refusal checks precede mutation. Locks and recheck protect against changes since the archive was made. */
export async function retireRecruitment(client, archive, options = {}) {
  validateArchive(archive);
  if (!options.workersStopped || !options.allowDropApprovedTables || !options.allowDeleteRetiredMembers) throw fail('vcr_retirement_destructive_flags_required');
  if (options.expectedDatabase !== archiveDigest(archive.snapshot.identity)) throw fail('vcr_retirement_database_confirmation_required');
  // Read the source only after all write-blocking locks: a pre-lock snapshot could miss a short-lived writer.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query(LOCK);
    await assertOffline(client);
    for (const table of RETIRED_TABLES) if (await present(client, table)) await client.query(`LOCK TABLE ${tableName(table)} IN ACCESS EXCLUSIVE MODE`);
    await client.query('LOCK TABLE evimed_vcr.members, evimed_vcr.grants IN SHARE ROW EXCLUSIVE MODE');
    const current = await capture(client);
    if (archiveDigest(current) !== archive.snapshotDigest) throw fail('vcr_retirement_data_changed');
    await verifyArchiveReadback(client, archive);
    const removed = await client.query('DELETE FROM evimed_vcr.members WHERE role=ANY($1::text[]) RETURNING study_id,user_id,role', [[...RETIRED_ROLES]]);
    if (removed.rowCount !== archive.snapshot.members.rows.length) throw fail('vcr_retirement_member_count_changed');
    // Restrict (never CASCADE): an unapproved dependency blocks the retirement and rolls it all back.
    for (const table of [...RETIRED_TABLES].reverse()) if (archive.snapshot.tables[table].exists) await client.query(`DROP TABLE ${tableName(table)} RESTRICT`);
    await client.query('ALTER TABLE evimed_vcr.members VALIDATE CONSTRAINT vcr_members_active_roles');
    await assertOffline(client);
    await client.query('COMMIT');
    return { retired: true, databaseIdentity: options.expectedDatabase,
      counts: Object.fromEntries(RETIRED_TABLES.map(table => [table, archive.snapshot.tables[table].rows.length])), retiredMembers: removed.rowCount };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function main(argv) {
  const value = flag => argv[argv.indexOf(flag) + 1];
  const mode = ['--archive', '--retire', '--restore-readback'].filter(flag => argv.includes(flag));
  const allowed = new Set([...mode, '--sha256', '--expected-database', '--workers-stopped', '--allow-drop-approved-tables', '--allow-delete-retired-members']);
  if (mode.length !== 1 || argv.some(arg => arg.startsWith('--') && !allowed.has(arg)) || !value(mode[0]) || value(mode[0]).startsWith('--')) throw fail('vcr_retirement_arguments_invalid');
  const file = path.resolve(value(mode[0]));
  // Read and authenticate any destructive input before opening a database connection.
  const archive = mode[0] === '--archive' ? null : await loadArchive(file, value('--sha256'));
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ application_name: 'vcr-retire-recruitment', connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000, lock_timeout: 10_000 });
  await client.connect();
  try {
    let result;
    if (mode[0] === '--archive') result = await archiveRecruitment(client, file);
    else if (mode[0] === '--retire') result = await retireRecruitment(client, archive, {
      workersStopped: argv.includes('--workers-stopped'), allowDropApprovedTables: argv.includes('--allow-drop-approved-tables'),
      allowDeleteRetiredMembers: argv.includes('--allow-delete-retired-members'), expectedDatabase: value('--expected-database') });
    else {
      await client.query('BEGIN');
      try {
        if (archiveDigest(await identity(client)) !== archiveDigest(archive.snapshot.identity)) throw fail('vcr_retirement_database_changed');
        await verifyArchiveReadback(client, archive);
        result = { readbackVerified: true, databaseIdentity: archiveDigest(archive.snapshot.identity) };
      } finally { await client.query('ROLLBACK'); }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await client.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${/^vcr_retirement_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'vcr_retirement_failed'}\n`); process.exitCode = 1; });
}
