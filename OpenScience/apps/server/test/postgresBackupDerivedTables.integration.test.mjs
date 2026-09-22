// The PostgreSQL backup with a derived table left out, run for real: the host
// script's own pg_dump, openssl, createdb and pg_restore against a real
// database holding the real frontier schema, and the readiness check reading
// the receipt that run wrote.
//
// Plan §10.4.6 and review item 1 are why this exists. The frontier feed's
// vectors (`evimed_frontier.item_vectors`) are rebuilt after a restore instead
// of being carried in thirty retained archives, and the backup verifies every
// restore by counting rows on both sides. A unit test with faked tools shows
// the counting logic; only a real dump shows that `--exclude-table-data`
// leaves the table (and its HNSW index) in the archive with no rows, that the
// restore of the extension and the index succeeds, and that the producer's
// receipt is one the consumer accepts — without substituting a hand-written
// receipt for either side.
//
// The script reaches PostgreSQL through `docker exec`; here a shim on PATH runs
// the same tools from a local PostgreSQL 16 client installation instead
// (`OPEN_SCIENCE_TEST_POSTGRES_BIN`, else PATH). The script refuses any other
// major version, so without 16 client tools this file is skipped with that
// reason, which is not the same as passing.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { postgresBackupReadiness } from "../src/postgresBackupReadiness.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const execute = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}

/** The PostgreSQL 16 client tools, or the reason there are none. */
function clientTools() {
  const candidates = [process.env.OPEN_SCIENCE_TEST_POSTGRES_BIN,
    ...String(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean);
  for (const directory of candidates) {
    try {
      const version = execFileSync(path.join(directory, "pg_dump"), ["--version"], { encoding: "utf8", timeout: 5_000 });
      if (/\(PostgreSQL\) 16\./.test(version)) return { bin: directory, reason: null };
    } catch { /* not here */ }
  }
  return { bin: null, reason: "no PostgreSQL 16 client tools (set OPEN_SCIENCE_TEST_POSTGRES_BIN); the backup script refuses any other major" };
}

const tools = databaseUrl ? clientTools() : { bin: null, reason: null };
const options = {
  timeout: 120_000,
  skip: (!databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured") || tools.reason || false,
};

/** Every database a test created, dropped at the end whatever happened. */
const created = new Set();
after(async () => {
  if (!databaseUrl || created.size === 0) return;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const drills = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'evimed\\_restore\\_%'");
    for (const name of [...created, ...drills.rows.map((row) => row.datname)]) {
      if (!/^evimed_(test_backup|restore)_[a-zA-Z0-9_]+$/.test(name)) continue;
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

/**
 * A fresh database with the control-plane schema and, when asked, the frontier
 * schema holding three published items and their vectors. Returns its URL.
 * @param {{ frontier: boolean }} options
 */
async function sourceDatabase({ frontier }) {
  const name = `evimed_test_backup_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  created.add(name);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const database = new ControlPlaneDatabase({ databaseUrl: url.href, databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    // The control-plane schema alone is a database worth backing up: its
    // migration ledger has rows and every other table is counted at zero.
    await database.migrate();
    if (frontier) {
      const capabilities = await migrateFrontier(database, { dimension: 1024 });
      assert.equal(capabilities.vector, true, "this test needs pgvector: the table it excludes exists only with it");
      await insertSource(database, "nejm");
      for (let index = 0; index < 3; index += 1) {
        const { id } = await insertItem(database, { title: `Synthetic item ${index}` });
        const vector = Array.from({ length: 1024 }, (_, position) => (position === index ? 1 : 0));
        await database.query("INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding) VALUES ($1, 'synthetic', $2)",
          [id, `[${vector.join(",")}]`]);
      }
    }
  } finally {
    await database.close();
  }
  return { name, url: url.href };
}

/**
 * Run the host script once against `name`, through a `docker` shim that runs
 * the local client tools; `damage` is SQL run in the drill database right
 * after its restore, standing in for a restore that lost or gained rows.
 * @param {import("node:test").TestContext} t @param {string} name @param {{ damage?: string }} [options]
 */
async function runBackup(t, name, { damage = "" } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "pg-derived-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const trace = path.join(root, "commands.jsonl");
  await writeFile(path.join(bin, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
// docker exec -i <container> <tool> <arguments...>
if (args[0] !== "exec") process.exit(64);
let index = args[1] === "-i" ? 3 : 2;
const tool = args[index];
const rest = args.slice(index + 1);
if (!["pg_dump", "pg_restore", "createdb", "dropdb", "psql"].includes(tool)) process.exit(64);
fs.appendFileSync(process.env.EVIMED_TEST_PG_TRACE, JSON.stringify({ tool, args: rest }) + "\\n");
const child = spawn(path.join(process.env.EVIMED_TEST_PG_BIN, tool), rest, { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", () => process.exit(8));
child.on("exit", (code) => {
  const restore = tool === "pg_restore" && !rest.includes("--list") && !rest.includes("--version");
  if (code === 0 && restore && process.env.EVIMED_TEST_DAMAGE_SQL) {
    const drill = rest[rest.indexOf("-d") + 1];
    const damaged = spawnSync(path.join(process.env.EVIMED_TEST_PG_BIN, "psql"),
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.EVIMED_POSTGRES_USER, "-d", drill, "-c", process.env.EVIMED_TEST_DAMAGE_SQL],
      { stdio: "ignore" });
    process.exit(damaged.status === 0 ? 0 : 9);
  }
  process.exit(code ?? 1);
});
`);
  await chmod(path.join(bin, "docker"), 0o700);
  const passphrase = path.join(root, "passphrase");
  await writeFile(passphrase, "Synthetic derived-table backup passphrase.\n", { mode: 0o400 });
  const scratch = path.join(root, "tmp");
  await mkdir(scratch);
  const backups = path.join(root, "backups");
  const url = new URL(databaseUrl);
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: scratch,
    PGHOST: url.hostname, PGPORT: url.port || "5432",
    EVIMED_POSTGRES_CONTAINER: "evimed-test-local-postgres", EVIMED_POSTGRES_DATABASE: name,
    EVIMED_POSTGRES_USER: decodeURIComponent(url.username || "postgres"),
    EVIMED_POSTGRES_BACKUP_DIR: backups, EVIMED_POSTGRES_PASSPHRASE_FILE: passphrase,
    EVIMED_TEST_PG_BIN: String(tools.bin), EVIMED_TEST_PG_TRACE: trace, EVIMED_TEST_DAMAGE_SQL: damage,
  };
  let result;
  try {
    result = { ok: true, ...(await execute("python3", ["-B", path.join(repo, "scripts/ops/postgres-backup.py")], { env, timeout: 90_000 })) };
  } catch (error) {
    result = { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
  const commands = (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const stateFile = path.join(backups, "status/state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  return { ...result, commands, state, stateFile, backups, scratch };
}

/** The readiness check, run the way the server runs it, against the source. @param {string} url @param {string} stateFile */
async function readiness(url, stateFile) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await postgresBackupReadiness({ production: true, stateStore: "postgres", databaseUrl: url,
      postgresBackupStateFile: stateFile, postgresBackupMaxAgeSeconds: 90_000 }, client);
  } finally {
    await client.end();
  }
}

/** @param {string} url @param {string} sql */
async function scalar(url, sql) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return String(Object.values((await client.query(sql)).rows[0])[0]); } finally { await client.end(); }
}

test("a real drill with the frontier vectors left out of the dump passes, and readiness accepts its receipt", options, async (t) => {
  const source = await sourceDatabase({ frontier: true });
  const run = await runBackup(t, source.name);
  assert.equal(run.ok, true, run.stderr);
  const dump = run.commands.find((entry) => entry.tool === "pg_dump" && !entry.args.includes("--version"));
  assert.ok(dump.args.includes("--exclude-table-data=evimed_frontier.item_vectors"), JSON.stringify(dump.args));
  assert.equal(run.state.status, "healthy");
  assert.equal(run.state.restoreVerified, true);
  // Three vectors in the source, zero in the archive — the drill counted the
  // restored table and found exactly the zero the inventory expects.
  assert.deepEqual(run.state.tables.find((row) => row.table === "item_vectors"), { schema: "evimed_frontier", table: "item_vectors", rows: "0" });
  assert.deepEqual(run.state.tables.find((row) => row.schema === "evimed_frontier" && row.table === "items"),
    { schema: "evimed_frontier", table: "items", rows: "3" }, "the items the vectors are rebuilt from are in the archive");
  assert.deepEqual(run.state.excludedTableData, [{ schema: "evimed_frontier", table: "item_vectors", sourceRows: "3", rebuild: "pnpm rebuild:frontier-index" }]);
  assert.deepEqual(JSON.parse(run.stdout).rebuildAfterRestore, ["pnpm rebuild:frontier-index"]);

  const verified = await readiness(source.url, run.stateFile);
  assert.equal(verified.restoreVerified, true);
  assert.equal(verified.sourceIdentityVerified, true);
  assert.deepEqual(verified.rebuildAfterRestore, ["pnpm rebuild:frontier-index"]);

  assert.equal(await scalar(source.url, "SELECT count(*) FROM evimed_frontier.item_vectors"), "3", "the source keeps its vectors");
  assert.equal(await scalar(databaseUrl, "SELECT count(*) FROM pg_database WHERE datname LIKE 'evimed\\_restore\\_%'"), "0", "the drill database is gone");
  assert.deepEqual(await readdir(run.scratch), [], "no plaintext dump is left behind");
});

for (const [label, damage] of [
  ["an application table that lost a row", "DELETE FROM evimed_frontier.item_texts WHERE item_id = (SELECT min(item_id) FROM evimed_frontier.item_texts)"],
  ["rows in the excluded table after the restore",
    `INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding)
       SELECT min(id), 'synthetic', array_fill(0.5::real, ARRAY[1024])::vector FROM evimed_frontier.items`],
]) {
  test(`a real drill still fails on ${label}, beside the excluded table`, options, async (t) => {
    const source = await sourceDatabase({ frontier: true });
    const run = await runBackup(t, source.name, { damage });
    assert.equal(run.ok, false, "the backup must not succeed");
    assert.match(run.stderr, /restore_application_mismatch/, "the failure is the count comparison, not the fixture");
    assert.equal(run.state.status, "failed");
    assert.equal(run.state.errorCode, "restore_application_mismatch");
    assert.equal((await readdir(run.backups)).some((file) => file.endsWith(".dump.enc")), false, "no archive is published");
    await assert.rejects(readiness(source.url, run.stateFile), { code: "postgres_backup_unhealthy" });
  });
}

test("a database without the frontier schema is dumped exactly as before", options, async (t) => {
  const source = await sourceDatabase({ frontier: false });
  const run = await runBackup(t, source.name);
  assert.equal(run.ok, true, run.stderr);
  const dump = run.commands.find((entry) => entry.tool === "pg_dump" && !entry.args.includes("--version"));
  assert.equal(dump.args.some((value) => value.startsWith("--exclude-table-data")), false, JSON.stringify(dump.args));
  assert.deepEqual(run.state.excludedTableData, []);
  assert.equal("rebuildAfterRestore" in JSON.parse(run.stdout), false);
  const verified = await readiness(source.url, run.stateFile);
  assert.equal(verified.restoreVerified, true);
  assert.equal("rebuildAfterRestore" in verified, false);
});
