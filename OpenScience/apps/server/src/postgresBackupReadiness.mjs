import { createHash } from "node:crypto";
import path from "node:path";
import { assertNoSymlinkPath, HttpError, openScopedFileNoFollow } from "./security.mjs";

function fail(code) { throw new HttpError(503, code, "PostgreSQL backup verification is unavailable."); }
const sha256 = /^[a-f0-9]{64}$/;
const identityFields = ["database", "databaseOid", "systemIdentifier"];
function validIdentity(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === identityFields.join(",")
    && typeof value.database === "string" && value.database.length > 0 && value.database.length <= 128 && !/[\r\n\0]/.test(value.database)
    && typeof value.databaseOid === "string" && /^[1-9]\d{0,9}$/.test(value.databaseOid)
    && typeof value.systemIdentifier === "string" && /^[1-9]\d{0,19}$/.test(value.systemIdentifier);
}

async function verifySourceIdentity(config, database, receipt) {
  if (!validIdentity(receipt.sourceIdentity)) fail("postgres_backup_identity_invalid");
  let actual;
  try {
    if (!database || typeof database.query !== "function") throw new Error("No database client");
    const result = await database.query({
      text: `SELECT current_database() AS database,d.oid::text AS "databaseOid",c.system_identifier::text AS "systemIdentifier"
        FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() c WHERE d.datname=current_database()`,
      query_timeout: 5000,
    });
    if (result.rows?.length !== 1 || !validIdentity(result.rows[0])) throw new Error("Invalid database identity");
    actual = result.rows[0];
  } catch { fail("postgres_backup_identity_unavailable"); }
  if (identityFields.some(field => actual[field] !== receipt.sourceIdentity[field])) fail("postgres_backup_database_mismatch");
  if (config.databaseUrl) {
    let name;
    try {
      const url = new URL(config.databaseUrl);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database URL");
      name = url.pathname.length > 1 ? decodeURIComponent(url.pathname.slice(1)) : null;
    } catch { fail("postgres_backup_identity_unavailable"); }
    if (name != null && name !== actual.database) fail("postgres_backup_database_mismatch");
  }
}

/** Verify the host receipt against the connected database; never run a backup.
 * @param {Record<string,any>} config @param {any} database */
export async function postgresBackupReadiness(config, database = null) {
  if (!config.production || config.stateStore !== "postgres") return { required: false };
  const file = String(config.postgresBackupStateFile ?? "").trim();
  if (!file) fail("postgres_backup_state_missing");
  if (!path.isAbsolute(file)) fail("postgres_backup_state_invalid");
  const maxAge = Number(config.postgresBackupMaxAgeSeconds ?? 90000);
  if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 31_536_000) fail("postgres_backup_state_invalid");
  let opened;
  let receipt;
  try {
    const filesystemRoot = path.parse(file).root;
    const firstDirectory = path.join(filesystemRoot, file.slice(filesystemRoot.length).split(path.sep)[0]);
    await assertNoSymlinkPath(firstDirectory, file, { missingCode: "postgres_backup_state_missing" });
    opened = await openScopedFileNoFollow(path.dirname(file), file);
    if (opened.stat.size <= 0 || opened.stat.size > 64 * 1024) fail("postgres_backup_state_invalid");
    receipt = JSON.parse(await opened.handle.readFile("utf8"));
  } catch (error) {
    if (String(error?.code ?? "").startsWith("postgres_backup_")) throw error;
    if (error?.code === "ENOENT") fail("postgres_backup_state_missing");
    if (error?.code === "path_forbidden") fail("postgres_backup_state_unsafe");
    fail("postgres_backup_state_invalid");
  } finally {
    await opened?.handle.close();
  }
  if (!receipt || receipt.schemaVersion !== 1) fail("postgres_backup_state_invalid");
  if (receipt.status !== "healthy") fail("postgres_backup_unhealthy");
  const tables = receipt.tables;
  if (receipt.restoreVerified !== true || receipt.cleanupVerified !== true || !Array.isArray(tables) || !tables.length
    || !sha256.test(receipt.archiveSha256 ?? "") || !sha256.test(receipt.expectedTablesSha256 ?? "")
    || receipt.expectedTablesSha256 !== receipt.restoredTablesSha256
    || !/^evimed-postgres-\d{8}T\d{6}Z(?:-[a-f0-9]{8})?\.dump\.enc$/.test(receipt.archive ?? "")) fail("postgres_backup_unverified");
  const keys = new Set();
  const canonical = tables.map(row => {
    if (!row || typeof row.schema !== "string" || !row.schema || row.schema.startsWith("pg_") || row.schema === "information_schema"
      || typeof row.table !== "string" || !row.table || typeof row.rows !== "string" || !/^\d+$/.test(row.rows)) fail("postgres_backup_unverified");
    const key = JSON.stringify([row.schema, row.table]);
    if (keys.has(key)) fail("postgres_backup_unverified");
    keys.add(key);
    return { rows: row.rows, schema: row.schema, table: row.table };
  });
  if (createHash("sha256").update(JSON.stringify(canonical)).digest("hex") !== receipt.expectedTablesSha256) fail("postgres_backup_unverified");
  const [success, drill, start, finish] = [receipt.lastSuccessAt, receipt.lastDrillAt, receipt.snapshotStartedAt, receipt.snapshotFinishedAt].map(Date.parse);
  const now = Date.now();
  if ([success, drill, start, finish].some(value => !Number.isFinite(value) || value > now + 300_000)) fail("postgres_backup_state_invalid");
  if (now - success > maxAge * 1000 || now - drill > maxAge * 1000) fail("postgres_backup_stale");
  if (start > finish || finish > drill || drill > success) fail("postgres_backup_state_invalid");
  await verifySourceIdentity(config, database, receipt);
  return { required: true, restoreVerified: true, sourceIdentityVerified: true, lastSuccessAt: receipt.lastSuccessAt, lastDrillAt: receipt.lastDrillAt,
    snapshotStartedAt: receipt.snapshotStartedAt, snapshotFinishedAt: receipt.snapshotFinishedAt, atomicAcrossComponents: false };
}
