import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { postgresBackupReadiness } from "../src/postgresBackupReadiness.mjs";
import { readinessBackup } from "../src/server.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "pg-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "status/state.json");
  await mkdir(path.dirname(file));
  const tables = [{ schema: "evimed_control", table: "users", rows: "2" }];
  const sha = createHash("sha256").update(JSON.stringify(tables.map(row => ({ rows: row.rows, schema: row.schema, table: row.table })))).digest("hex");
  const at = new Date().toISOString();
  const sourceIdentity = { database: "evimed_test_backup_readiness", databaseOid: "16384", systemIdentifier: "7520000000000000001" };
  const database = { query: async query => {
    assert.match(typeof query === "string" ? query : query.text, /current_database\(\)/);
    assert.match(typeof query === "string" ? query : query.text, /pg_control_system\(\)/);
    return { rows: [{ ...sourceIdentity }] };
  } };
  const healthy = { sourceIdentity, schemaVersion: 1, status: "healthy", restoreVerified: true, cleanupVerified: true,
    lastSuccessAt: at, lastDrillAt: at, snapshotStartedAt: at, snapshotFinishedAt: at,
    archive: "evimed-postgres-20260906T023000Z-01234567.dump.enc", archiveSha256: "a".repeat(64),
    expectedTablesSha256: sha, restoredTablesSha256: sha, tables };
  return { file, healthy, database, config: { production: true, stateStore: "postgres", databaseUrl: "postgresql://readonly@127.0.0.1/evimed_test_backup_readiness", postgresBackupStateFile: file, postgresBackupMaxAgeSeconds: 90000 } };
}

test("PostgreSQL backup readiness requires a fresh verified application-data restore receipt", async (t) => {
  const { file, healthy, config, database } = await fixture(t);
  await assert.rejects(() => postgresBackupReadiness(config, database), { code: "postgres_backup_state_missing" });
  await writeFile(file, JSON.stringify(healthy));
  const result = await postgresBackupReadiness(config, database);
  assert.equal(result.required, true);
  assert.equal(result.restoreVerified, true);
  assert.equal(result.atomicAcrossComponents, false);
  assert.equal(JSON.stringify(result).includes(file), false);
  assert.equal(JSON.stringify(result).includes("users"), false, "public readiness must not expose the table inventory");
});

for (const [name, patch, code] of [
  ["failed", { status: "failed" }, "postgres_backup_unhealthy"],
  ["unverified", { restoreVerified: false }, "postgres_backup_unverified"],
  ["cleanup failed", { cleanupVerified: false }, "postgres_backup_unverified"],
  ["empty inventory", { tables: [] }, "postgres_backup_unverified"],
  ["mismatched restore", { restoredTablesSha256: "b".repeat(64) }, "postgres_backup_unverified"],
  ["stale", { lastSuccessAt: "2020-01-01T00:00:00Z", lastDrillAt: "2020-01-01T00:00:00Z" }, "postgres_backup_stale"],
  ["future", { lastSuccessAt: "2099-01-01T00:00:00Z" }, "postgres_backup_state_invalid"],
]) {
  test(`PostgreSQL backup readiness rejects ${name} evidence`, async (t) => {
    const { file, healthy, config, database } = await fixture(t);
    await writeFile(file, JSON.stringify({ ...healthy, ...patch }));
    await assert.rejects(() => postgresBackupReadiness(config, database), { code });
  });
}

test("PostgreSQL backup readiness rejects linked status and preserves non-PostgreSQL local mode", async (t) => {
  const { file, healthy, config, database } = await fixture(t);
  const outside = path.join(path.dirname(file), "outside.json");
  await writeFile(outside, JSON.stringify(healthy));
  await symlink(outside, file);
  await assert.rejects(() => postgresBackupReadiness(config, database), { code: "postgres_backup_state_unsafe" });
  assert.deepEqual(await postgresBackupReadiness({ ...config, stateStore: "file" }), { required: false });
  assert.deepEqual(await postgresBackupReadiness({ ...config, production: false }), { required: false });
});

test("the actual backup readiness combines filesystem and PostgreSQL receipts without running either producer", async (t) => {
  const { file, healthy, config, database } = await fixture(t);
  const backupDir = path.join(path.dirname(path.dirname(file)), "backups");
  await mkdir(backupDir);
  const fsState = path.join(backupDir, ".open-science-backup-state.json");
  const state = { schemaVersion: 1, status: "healthy", lastSuccessAt: healthy.lastSuccessAt, lastDrillAt: healthy.lastDrillAt };
  await writeFile(fsState, JSON.stringify(state));
  const combined = { ...config, backupMode: "local", backupDir, backupStateFile: fsState,
    dataDir: path.join(path.dirname(backupDir), "data"), backupRetentionDays: 30, backupPassphraseConfigured: true,
    restoreDrillAck: true, backupIntervalSeconds: 86400, backupHealthGraceSeconds: 1800 };
  await assert.rejects(() => readinessBackup(combined, database), { code: "postgres_backup_state_missing" });
  await writeFile(file, JSON.stringify(healthy));
  const passed = await readinessBackup(combined, database);
  assert.equal(passed.schedulerHealthy, true);
  assert.equal(passed.postgres.restoreVerified, true);
  await writeFile(file, JSON.stringify({ ...healthy, status: "failed" }));
  await assert.rejects(() => readinessBackup(combined, database), { code: "postgres_backup_unhealthy" });
  await writeFile(file, JSON.stringify(healthy));
  await writeFile(fsState, JSON.stringify({ ...state, status: "failed" }));
  await assert.rejects(() => readinessBackup(combined, database), { code: "backup_scheduler_unhealthy" });
});

for (const [label, patch] of [
  ["wrong database", { database: "another_database" }],
  ["same-name database in another cluster", { systemIdentifier: "7520000000000000002" }],
  ["recreated database", { databaseOid: "16385" }],
]) {
  test(`PostgreSQL backup identity rejects ${label}`, async t => {
    const { file, healthy, config, database } = await fixture(t);
    await writeFile(file, JSON.stringify({ ...healthy, sourceIdentity: { ...healthy.sourceIdentity, ...patch } }));
    await assert.rejects(postgresBackupReadiness(config, database), { code: "postgres_backup_database_mismatch" });
  });
}

test("PostgreSQL backup identity also binds the configured URL database without exposing it", async t => {
  const { file, healthy, config, database } = await fixture(t);
  await writeFile(file, JSON.stringify(healthy));
  await assert.rejects(postgresBackupReadiness({ ...config, databaseUrl: "postgresql://user:test-only-secret@127.0.0.1/wrong_database" }, database),
    error => error.code === "postgres_backup_database_mismatch" && !String(error.stack).includes("test-only-secret"));
  assert.equal((await postgresBackupReadiness({ ...config, databaseUrl: "postgresql://readonly@127.0.0.1/evimed%5Ftest_backup_readiness" }, database)).sourceIdentityVerified, true);
});

test("PostgreSQL backup identity refuses missing receipts or unavailable database evidence", async t => {
  const { file, healthy, config, database } = await fixture(t);
  await writeFile(file, JSON.stringify({ ...healthy, sourceIdentity: undefined }));
  await assert.rejects(postgresBackupReadiness(config, database), { code: "postgres_backup_identity_invalid" });
  await writeFile(file, JSON.stringify(healthy));
  for (const connection of [null, { query: async () => ({ rows: [] }) }, { query: async () => { throw new Error("synthetic-sensitive-driver-error"); } }]) {
    await assert.rejects(postgresBackupReadiness(config, connection), error => error.code === "postgres_backup_identity_unavailable"
      && !String(error.stack).includes("synthetic-sensitive-driver-error"));
  }
});

test("backup Compose has an existing optional local status directory and preserves explicit host mounts", async () => {
  const { readFile, stat } = await import("node:fs/promises");
  const compose = await readFile(new URL("../../../deploy/web/docker-compose.backup.yml", import.meta.url), "utf8");
  assert.match(compose, /source: \$\{OPEN_SCIENCE_POSTGRES_BACKUP_STATUS_DIR:-\.\/postgres-backup-status\}/);
  assert.match(compose, /target: \/run\/postgres-backup-status\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/);
  assert.ok((await stat(new URL("../../../deploy/web/postgres-backup-status/.gitkeep", import.meta.url))).isFile());
});

test("a real non-superuser PostgreSQL connection verifies the receipt's database and rejects an old database OID", {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 10000,
}, async t => {
  const connection = new URL(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(connection.hostname));
  assert.match(connection.pathname, /evimed_test/);
  const { file, healthy, config } = await fixture(t);
  const admin = new pg.Client({ connectionString: connection.href });
  const role = `evimed_backup_readiness_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let database;
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const identity = (await admin.query(`SELECT current_database() AS database,d.oid::text AS "databaseOid",c.system_identifier::text AS "systemIdentifier"
      FROM pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=current_database()`)).rows[0];
    const readonly = new URL(connection.href); readonly.username = role; readonly.password = "";
    database = new pg.Client({ connectionString: readonly.href });
    await database.connect();
    await writeFile(file, JSON.stringify({ ...healthy, sourceIdentity: identity }));
    const realConfig = { ...config, databaseUrl: connection.href };
    assert.equal((await postgresBackupReadiness(realConfig, database)).sourceIdentityVerified, true);
    await writeFile(file, JSON.stringify({ ...healthy, sourceIdentity: { ...identity, databaseOid: String(BigInt(identity.databaseOid) + 1n) } }));
    await assert.rejects(postgresBackupReadiness(realConfig, database), { code: "postgres_backup_database_mismatch" });
  } finally {
    await database?.end();
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
