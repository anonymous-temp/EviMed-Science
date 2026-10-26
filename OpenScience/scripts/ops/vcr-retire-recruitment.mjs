/** Explicit operator retirement; never imported by startup. See WEB_OPERATIONS_RUNBOOK.
 * PG* selects the database; the backup passphrase comes only from its existing env/file source.
 * Archive/re-seal write encrypted bytes only. Restore and retire require stopped writers and an offline database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encryptArchiveBuffer, decryptArchiveBuffer } from './archive-crypto.mjs';

export const RETIRED_TABLES = Object.freeze(['sites', 'referrals', 'referral_events']);
export const RETIRED_ROLES = Object.freeze(['recruiter', 'site']);
const FORMAT = 'evimed-vcr-recruitment-archive-v2';
const SETTINGS = Object.freeze({ TimeZone: 'UTC', DateStyle: 'ISO, MDY', IntervalStyle: 'postgres' });
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-v1'))";
const q = value => `"${String(value).replaceAll('"', '""')}"`;
const fail = code => Object.assign(new Error(code), { code });
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const archiveDigest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
const tableName = table => `evimed_vcr.${q(table)}`;
// SQLSTATE is diagnostic; PostgreSQL messages/detail/context can contain patient values.
export function retirementError(error) {
  if (/^vcr_retirement_[a-z_]+$/.test(error?.code ?? '')) return error;
  return Object.assign(fail('vcr_retirement_failed'), /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? { sqlState: error.code } : {});
}
async function begin(client) {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY'; SET LOCAL IntervalStyle='postgres'");
}
async function transaction(client, work) {
  await begin(client);
  try { const result = await work(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw retirementError(error); }
}
async function identity(client) {
  const { rows } = await client.query(`SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    system_identifier::text AS cluster FROM pg_control_system()`);
  return rows[0];
}
async function assertIdentity(client, archive) {
  if (archiveDigest(await identity(client)) !== archiveDigest(archive.snapshot.identity)) throw fail('vcr_retirement_database_changed');
}
async function columns(client, table) {
  return (await client.query(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [`evimed_vcr.${table}`])).rows;
}
async function constraints(client, table) {
  return (await client.query(`SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid=to_regclass($1) ORDER BY conname`, [`evimed_vcr.${table}`])).rows;
}
// Retain PostgreSQL text, never parse/re-serialize row values through JS Number.
async function rowsOf(client, table, roleOnly = false, schema = 'evimed_vcr') {
  return (await client.query(`SELECT to_jsonb(t)::text AS row FROM ${q(schema)}.${q(table)} t${roleOnly ? ' WHERE role = ANY($1::text[])' : ''} ORDER BY to_jsonb(t)::text`, roleOnly ? [[...RETIRED_ROLES]] : [])).rows.map(row => row.row);
}
async function present(client, table) {
  return Boolean((await client.query('SELECT to_regclass($1) AS relation', [`evimed_vcr.${table}`])).rows[0]?.relation);
}
async function grantRoleCounts(client) {
  return (await client.query(`SELECT role,count(*)::integer AS count FROM evimed_vcr.grants WHERE role=ANY($1::text[]) GROUP BY role ORDER BY role`, [[...RETIRED_ROLES]])).rows;
}
// Grants are preserved scientific permissions, not part of the retired/restored dataset.
// The full snapshot digest authenticates their advisory observation; only archived rows/schema prove equivalence.
const retirementProofDigest = ({ identity: databaseIdentity, settings, tables, members }) => archiveDigest({ identity: databaseIdentity, settings, tables, members });
async function capture(client) {
  const tables = {};
  for (const table of RETIRED_TABLES) {
    const exists = await present(client, table);
    tables[table] = { exists, columns: exists ? await columns(client, table) : [],
      constraints: exists ? await constraints(client, table) : [],
      indexes: exists ? (await client.query(`SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='evimed_vcr' AND tablename=$1 ORDER BY indexname`, [table])).rows : [],
      rows: exists ? await rowsOf(client, table) : [] };
  }
  return { identity: await identity(client), settings: SETTINGS, tables,
    members: { columns: await columns(client, 'members'), rows: await rowsOf(client, 'members', true) }, grantRoleCounts: await grantRoleCounts(client) };
}
/** Filter in PostgreSQL so high precision JSON numbers remain exact. Missing studies and the durable hashed
 * account ledger cover account/project deletion; subject withdrawals cover consent loss, including after retirement. */
async function withoutErased(client, snapshot) {
  const copy = structuredClone(snapshot);
  if (!await present(client, 'retirement_erased_accounts') || !await present(client, 'retired_recruitment_subjects')) throw fail('vcr_retirement_erasure_schema_required');
  for (const [table, data] of [...RETIRED_TABLES.map(table => [table, copy.tables[table]]), ['members', copy.members]]) {
    if (!data.rows.length) continue;
    const conditions = [
      `(r->>'study_id' IS NULL OR EXISTS (SELECT 1 FROM evimed_vcr.studies s WHERE s.id=r->>'study_id'))`,
      `NOT EXISTS (SELECT 1 FROM evimed_vcr.retirement_erased_accounts e, unnest(ARRAY[r->>'user_id',r->>'invited_by',r->>'contact_approved_by',r->>'actor']) AS account_id
        WHERE e.user_hash=encode(sha256(convert_to(account_id,'UTF8')),'hex'))`,
    ];
    if (table === 'referrals') conditions.push(`NOT EXISTS (SELECT 1 FROM evimed_vcr.subject_withdrawals w WHERE w.study_id=r->>'study_id' AND w.subject_key=r->>'subject_key')`);
    if (table === 'referral_events') conditions.push(`r->>'referral_id' IN (SELECT f->>'id' FROM jsonb_array_elements($2::jsonb) f)`);
    const params = [`[${data.rows.join(',')}]`];
    // Match the real nullable FK's ON DELETE SET NULL semantics after erasure removes a site.
    // Retain the other account's referral/event; transform JSONB inside PostgreSQL to preserve exact numeric values.
    const value = table === 'referrals' ? `CASE WHEN r->>'site_id' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) s WHERE s->>'id'=r->>'site_id')
      THEN jsonb_set(r,'{site_id}','null'::jsonb) ELSE r END` : 'r';
    if (table === 'referrals') params.push(`[${copy.tables.sites.rows.join(',')}]`);
    if (table === 'referral_events') params.push(`[${copy.tables.referrals.rows.join(',')}]`);
    data.rows = (await client.query(`SELECT (${value})::text AS row FROM jsonb_array_elements($1::jsonb) r WHERE ${conditions.join(' AND ')} ORDER BY 1`, params)).rows.map(row => row.row);
  }
  return copy;
}
async function assertNotErased(client, archive) {
  if (archiveDigest(await withoutErased(client, archive.snapshot)) !== archive.snapshotDigest) throw fail('vcr_retirement_forget_erased_required');
}
function validateArchive(archive) {
  if (archive?.format === FORMAT && (!archive.snapshot?.settings || archiveDigest(archive.snapshot.settings) !== archiveDigest(SETTINGS))) throw fail('vcr_retirement_settings_mismatch');
  try {
    if (archive?.format !== FORMAT || !archive.snapshot?.identity || !archive.snapshot?.members
      || archiveDigest(archive.snapshot.settings) !== archiveDigest(SETTINGS)
      || JSON.stringify(Object.keys(archive.snapshot.tables).sort()) !== JSON.stringify([...RETIRED_TABLES].sort())) throw new Error();
    for (const table of Object.values(archive.snapshot.tables)) {
      if (!Array.isArray(table.rows) || table.rows.some(row => typeof row !== 'string') || !Array.isArray(table.columns) || !Array.isArray(table.constraints) || !Array.isArray(table.indexes)) throw new Error();
    }
    if (!Array.isArray(archive.snapshot.members.rows) || archive.snapshot.members.rows.some(row => typeof row !== 'string' || !RETIRED_ROLES.includes(JSON.parse(row).role))) throw new Error();
    if (archive.snapshotDigest !== archiveDigest(archive.snapshot)) throw new Error();
  } catch { throw fail('vcr_retirement_archive_invalid'); }
}
function metadata(archive, sha256, plaintextSha256) {
  return { format: FORMAT, createdAt: archive.createdAt, sha256, plaintextSha256, snapshotDigest: archive.snapshotDigest,
    databaseIdentity: archiveDigest(archive.snapshot.identity), settings: SETTINGS,
    counts: Object.fromEntries(RETIRED_TABLES.map(table => [table, archive.snapshot.tables[table].rows.length])),
    retiredMembers: archive.snapshot.members.rows.length, grantRoleCounts: archive.snapshot.grantRoleCounts,
    grantRoleCountsScope: 'advisory_live_database_observation',
    readbackVerified: archive.readbackVerified === true };
}
function rewritten(definition, schema) {
  return definition.replace(/\bevimed_vcr\.(?:"(sites|referrals|referral_events)"|(sites|referrals|referral_events))\b/g,
    (_match, quoted, plain) => `${q(schema)}.${q(quoted ?? plain)}`);
}
async function createTables(client, archive, schema, includeMembers = false) {
  const datasets = RETIRED_TABLES.filter(table => archive.snapshot.tables[table].exists).map(table => [table, archive.snapshot.tables[table]]);
  if (includeMembers) datasets.push(['members', archive.snapshot.members]);
  for (const [table, data] of datasets) {
    await client.query(`CREATE TABLE ${q(schema)}.${q(table)} (${data.columns.map(column => `${q(column.name)} ${column.type}${column.default == null ? '' : ` DEFAULT ${rewritten(column.default, schema)}`}${column.required ? ' NOT NULL' : ''}`).join(',')})`);
    if (data.rows.length) await client.query(`INSERT INTO ${q(schema)}.${q(table)} SELECT * FROM jsonb_populate_recordset(NULL::${q(schema)}.${q(table)},$1::jsonb)`, [`[${data.rows.join(',')}]`]);
  }
  // Add keys before foreign keys. NOT VALID remains NOT VALID, preserving legacy rows and future-write checks.
  const all = RETIRED_TABLES.flatMap(table => (archive.snapshot.tables[table].constraints ?? []).map(constraint => ({ table, ...constraint })));
  for (const constraint of [...all.filter(c => !c.definition.startsWith('FOREIGN KEY')), ...all.filter(c => c.definition.startsWith('FOREIGN KEY'))]) {
    await client.query(`ALTER TABLE ${q(schema)}.${q(constraint.table)} ADD CONSTRAINT ${q(constraint.name)} ${rewritten(constraint.definition, schema)}`);
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
    if (archiveDigest(await rowsOf(client, table, false, schema)) !== archiveDigest(data.rows)) throw fail('vcr_retirement_restore_mismatch');
    // Verify defaults, types and requiredness in the reconstructed catalogue as well as values.
    const restoredColumns = (await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [`${schema}.${table}`])).rows;
    if (archiveDigest(restoredColumns) !== archiveDigest(data.columns)) throw fail('vcr_retirement_restore_schema_mismatch');
  }
}
/** Caller owns a transaction; live-reference FK locks are acquired only AFTER capture committed. */
export async function verifyArchiveReadback(client, archive) {
  validateArchive(archive);
  await client.query("SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, MDY'; SET LOCAL IntervalStyle='postgres'");
  await assertIdentity(client, archive);
  await assertNotErased(client, archive);
  const schema = `vcr_retirement_verify_${randomUUID().replaceAll('-', '')}`;
  await client.query('SAVEPOINT vcr_retirement_readback');
  try {
    await client.query(`CREATE SCHEMA ${q(schema)}`);
    await createTables(client, archive, schema, true);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT vcr_retirement_readback');
    await client.query('RELEASE SAVEPOINT vcr_retirement_readback');
  }
  return true;
}
async function writePrivate(file, bytes) {
  if (!path.isAbsolute(file)) throw fail('vcr_retirement_absolute_archive_required');
  // Refuse symlinks at every directory component, not only the immediate parent.
  let current = path.parse(file).root;
  for (const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('vcr_retirement_private_directory_required');
  }
  const directory = await fs.lstat(path.dirname(file));
  if (directory.mode & 0o077) throw fail('vcr_retirement_private_directory_required');
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
  let plaintext, archive, meta;
  try {
    plaintext = await decryptArchiveBuffer(bytes);
    archive = JSON.parse(plaintext.toString('utf8'));
    meta = JSON.parse((await readPrivate(`${file}.meta.json`)).toString('utf8'));
  } catch { throw fail('vcr_retirement_archive_authentication_failed'); }
  validateArchive(archive);
  if (archiveDigest(meta) !== archiveDigest(metadata(archive, expectedSha256, archiveDigest(plaintext))) || !archive.readbackVerified) throw fail('vcr_retirement_metadata_mismatch');
  return archive;
}
async function saveArchive(file, archive) {
  const plaintext = Buffer.from(`${JSON.stringify(archive)}\n`);
  const bytes = await encryptArchiveBuffer(plaintext);
  if (archiveDigest(await decryptArchiveBuffer(bytes)) !== archiveDigest(plaintext)) throw fail('vcr_retirement_decrypt_mismatch');
  const meta = metadata(archive, archiveDigest(bytes), archiveDigest(plaintext));
  await writePrivate(file, bytes);
  await writePrivate(`${file}.meta.json`, `${JSON.stringify(meta)}\n`);
  await loadArchive(file, meta.sha256);
  return meta;
}
function makeArchive(snapshot) {
  return { format: FORMAT, createdAt: new Date().toISOString(), snapshot, snapshotDigest: archiveDigest(snapshot), readbackVerified: true };
}
/** Capture locks are released before readback acquires FK locks or encryption/fsync begins. */
export async function archiveRecruitment(client, file) {
  const snapshot = await transaction(client, async () => {
    await client.query(LOCK);
    // Parent first: a first-task writer inserts studies before members. No lock-order inversion.
    await client.query('LOCK TABLE evimed_vcr.studies IN SHARE MODE');
    // Withdrawal writes its ledger before its terminal legacy-referral update. Match that order.
    await client.query('LOCK TABLE evimed_vcr.subject_withdrawals, evimed_vcr.retirement_erased_accounts IN SHARE MODE');
    for (const table of RETIRED_TABLES) if (await present(client, table)) await client.query(`LOCK TABLE ${tableName(table)} IN SHARE MODE`);
    await client.query('LOCK TABLE evimed_vcr.members, evimed_vcr.grants IN SHARE MODE');
    return withoutErased(client, await capture(client));
  });
  const archive = makeArchive(snapshot);
  await transaction(client, () => verifyArchiveReadback(client, archive));
  return saveArchive(file, archive);
}
async function assertOffline(client) {
  await client.query('SELECT pg_stat_clear_snapshot()');
  const others = (await client.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows[0]?.count;
  if (Number(others) !== 0) throw fail('vcr_retirement_other_database_clients');
}
function destructiveFlags(archive, options, restore = false) {
  validateArchive(archive);
  if (!options.workersStopped || (restore ? !options.allowRestoreApprovedTables : !options.allowDropApprovedTables || !options.allowDeleteRetiredMembers)) throw fail('vcr_retirement_destructive_flags_required');
  if (options.expectedDatabase !== archiveDigest(archive.snapshot.identity)) throw fail('vcr_retirement_database_confirmation_required');
}
export async function forgetErased(client, archive, outputFile) {
  validateArchive(archive);
  const snapshot = await transaction(client, async () => {
    await assertIdentity(client, archive);
    const retained = await withoutErased(client, archive.snapshot);
    retained.grantRoleCounts = await grantRoleCounts(client);
    return retained;
  });
  const resealed = makeArchive(snapshot);
  await transaction(client, () => verifyArchiveReadback(client, resealed));
  // A new immutable encrypted generation; the operator securely retires superseded copies everywhere.
  return saveArchive(outputFile, resealed);
}
export async function retireRecruitment(client, archive, options = {}) {
  destructiveFlags(archive, options);
  return transaction(client, async () => {
    await client.query(LOCK); await assertOffline(client); await assertIdentity(client, archive);
    await client.query('LOCK TABLE evimed_vcr.studies IN SHARE ROW EXCLUSIVE MODE');
    for (const table of RETIRED_TABLES) if (await present(client, table)) await client.query(`LOCK TABLE ${tableName(table)} IN ACCESS EXCLUSIVE MODE`);
    await client.query('LOCK TABLE evimed_vcr.members, evimed_vcr.grants, evimed_vcr.subject_withdrawals, evimed_vcr.retirement_erased_accounts IN SHARE ROW EXCLUSIVE MODE');
    const current = await withoutErased(client, await capture(client));
    if (RETIRED_TABLES.every(table => !current.tables[table].exists) && !current.members.rows.length) return { retired: true, alreadyRetired: true, databaseIdentity: options.expectedDatabase };
    await assertNotErased(client, archive);
    if (retirementProofDigest(current) !== retirementProofDigest(archive.snapshot)) throw fail('vcr_retirement_data_changed');
    // A hash-only footprint lets a referral-only subject withdraw after the tables are gone.
    if (await present(client, 'referrals')) await client.query(`INSERT INTO evimed_vcr.retired_recruitment_subjects(study_id,subject_hash)
      SELECT study_id,encode(sha256(convert_to(subject_key,'UTF8')),'hex') FROM evimed_vcr.referrals ON CONFLICT DO NOTHING`);
    const removed = await client.query('DELETE FROM evimed_vcr.members WHERE role=ANY($1::text[])', [[...RETIRED_ROLES]]);
    for (const table of [...RETIRED_TABLES].reverse()) if (archive.snapshot.tables[table].exists) await client.query(`DROP TABLE ${tableName(table)} RESTRICT`);
    await client.query('ALTER TABLE evimed_vcr.members VALIDATE CONSTRAINT vcr_members_active_roles');
    await assertOffline(client);
    return { retired: true, alreadyRetired: false, databaseIdentity: options.expectedDatabase,
      counts: Object.fromEntries(RETIRED_TABLES.map(table => [table, archive.snapshot.tables[table].rows.length])), retiredMembers: removed.rowCount };
  });
}
/** Real restore is offline and transactional. It restores archival data only; the application exposes no CRM routes. */
export async function restoreRecruitment(client, archive, options = {}) {
  destructiveFlags(archive, options, true);
  return transaction(client, async () => {
    await client.query(LOCK); await assertOffline(client); await assertIdentity(client, archive);
    await client.query('LOCK TABLE evimed_vcr.studies, evimed_vcr.members, evimed_vcr.subject_withdrawals, evimed_vcr.retirement_erased_accounts IN ACCESS EXCLUSIVE MODE');
    await assertNotErased(client, archive);
    for (const table of RETIRED_TABLES) if (await present(client, table)) throw fail('vcr_retirement_restore_conflict');
    // A single conflicting historical member aborts instead of silently merging or overwriting current rows.
    if ((await rowsOf(client, 'members', true)).length) throw fail('vcr_retirement_restore_conflict');
    await createTables(client, archive, 'evimed_vcr');
    const checks = (await constraints(client, 'members')).filter(c => /\brole\b/.test(c.definition) && c.definition.startsWith('CHECK'));
    if (!checks.some(c => c.name === 'vcr_members_active_roles')) throw fail('vcr_retirement_active_role_check_required');
    for (const check of checks) await client.query(`ALTER TABLE evimed_vcr.members DROP CONSTRAINT ${q(check.name)}`);
    if (archive.snapshot.members.rows.length) await client.query(`INSERT INTO evimed_vcr.members SELECT * FROM jsonb_populate_recordset(NULL::evimed_vcr.members,$1::jsonb)`, [`[${archive.snapshot.members.rows.join(',')}]`]);
    // Existing archived roles are readable history. Every later INSERT/UPDATE still meets current active-role checks.
    for (const check of checks) await client.query(`ALTER TABLE evimed_vcr.members ADD CONSTRAINT ${q(check.name)} ${check.definition.replace(/ NOT VALID$/, '')} NOT VALID`);
    if (archiveDigest(await rowsOf(client, 'members', true)) !== archiveDigest(archive.snapshot.members.rows)) throw fail('vcr_retirement_restore_mismatch');
    await assertOffline(client);
    return { restored: true, databaseIdentity: options.expectedDatabase, retiredMembers: archive.snapshot.members.rows.length };
  });
}
async function main(argv) {
  const value = flag => argv[argv.indexOf(flag) + 1];
  const mode = ['--archive', '--retire', '--restore-readback', '--restore', '--forget-erased'].filter(flag => argv.includes(flag));
  const allowed = new Set([...mode, '--output', '--sha256', '--expected-database', '--workers-stopped', '--allow-drop-approved-tables', '--allow-delete-retired-members', '--allow-restore-approved-tables']);
  if (mode.length !== 1 || argv.some(arg => arg.startsWith('--') && !allowed.has(arg)) || !value(mode[0]) || value(mode[0]).startsWith('--')) throw fail('vcr_retirement_arguments_invalid');
  if (mode[0] === '--forget-erased' && (!argv.includes('--output') || value('--output').startsWith('--'))) throw fail('vcr_retirement_arguments_invalid');
  const file = path.resolve(value(mode[0]));
  const archive = mode[0] === '--archive' ? null : await loadArchive(file, value('--sha256'));
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ application_name: 'vcr-retire-recruitment', connectionTimeoutMillis: 10_000, statement_timeout: 120_000, lock_timeout: 10_000 });
  await client.connect();
  try {
    let result;
    const options = { workersStopped: argv.includes('--workers-stopped'), allowDropApprovedTables: argv.includes('--allow-drop-approved-tables'),
      allowDeleteRetiredMembers: argv.includes('--allow-delete-retired-members'), allowRestoreApprovedTables: argv.includes('--allow-restore-approved-tables'), expectedDatabase: value('--expected-database') };
    if (mode[0] === '--archive') result = await archiveRecruitment(client, file);
    else if (mode[0] === '--forget-erased') result = await forgetErased(client, archive, path.resolve(value('--output')));
    else if (mode[0] === '--retire') result = await retireRecruitment(client, archive, options);
    else if (mode[0] === '--restore') result = await restoreRecruitment(client, archive, options);
    else result = await transaction(client, async () => {
      await assertIdentity(client, archive); await assertNotErased(client, archive); await verifyArchiveReadback(client, archive);
      return { readbackVerified: true, databaseIdentity: archiveDigest(archive.snapshot.identity) };
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await client.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { const safe = retirementError(error); process.stderr.write(`${JSON.stringify({ code: safe.code, ...(safe.sqlState ? { sqlState: safe.sqlState } : {}) })}\n`); process.exitCode = 1; });
}
