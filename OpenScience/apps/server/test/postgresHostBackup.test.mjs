import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { postgresBackupReadiness } from "../src/postgresBackupReadiness.mjs";

const execute = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const container = process.env.OPEN_SCIENCE_TEST_POSTGRES_CONTAINER ?? "";
const options = { timeout: 45_000, skip: !container && "OPEN_SCIENCE_TEST_POSTGRES_CONTAINER is not configured" };
if (container) assert.match(container, /^evimed-.*test.*postgres/);

async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "host-pg-"));
  const realDocker = (await execute("bash", ["-c", "command -v docker"])).stdout.trim();
  const inspected = JSON.parse((await execute(realDocker, ["inspect", container])).stdout)[0];
  const role = (inspected.Config.Env.find(value => value.startsWith("POSTGRES_USER=")) ?? "POSTGRES_USER=postgres").slice(14);
  assert.match(role, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const database = `evimed_test_backup_${randomUUID().replaceAll("-", "")}`;
  await execute(realDocker, ["exec", container, "createdb", "-U", role, database]);
  const query = async (sql, db = database) => (await execute(realDocker,
    ["exec", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", db, "-c", sql])).stdout.trim();
  await query("CREATE SCHEMA evimed_control; CREATE TABLE evimed_control.users(id text primary key, name text); INSERT INTO evimed_control.users VALUES ('one','Synthetic tenant'),('two','Synthetic tenant two'); CREATE TABLE public.memo(id integer primary key, content text); INSERT INTO public.memo VALUES (1,'Synthetic memo');");
  const backupDir = path.join(root, "backups");
  const scratch = path.join(root, "tmp");
  await mkdir(scratch);
  const passphrase = path.join(root, "passphrase");
  await writeFile(passphrase, "Synthetic host backup passphrase only.\n", { mode: 0o400 });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const trace = path.join(root, "commands.jsonl");
  await writeFile(path.join(bin, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const tool = args.find(value => ['pg_dump','pg_restore','createdb','dropdb','psql'].includes(value));
const db = args[args.indexOf('-d') + 1];
fs.appendFileSync(process.env.EVIMED_TEST_PG_TRACE, JSON.stringify({ tool, db, args: ['createdb','dropdb'].includes(tool) ? args : undefined }) + '\\n');
if (tool === 'pg_restore' && !args.includes('--list') && !args.includes('--version') && process.env.EVIMED_TEST_SKIP_RESTORE === 'true') process.exit(0);
if (process.env.EVIMED_TEST_FAIL_TOOL && tool === process.env.EVIMED_TEST_FAIL_TOOL && !args.includes('--version') && !args.includes('--list')) {
  process.stderr.write('Synthetic sensitive diagnostic must not enter structured status\\n'); process.exit(7);
}
if (tool === 'pg_dump' && !args.includes('--version') && process.env.EVIMED_TEST_INSERT_DURING_DUMP === 'true') {
  const inserted = spawnSync(process.env.EVIMED_TEST_REAL_DOCKER, ['exec', process.env.EVIMED_POSTGRES_CONTAINER, 'psql', '-U', process.env.EVIMED_POSTGRES_USER, '-d', process.env.EVIMED_POSTGRES_DATABASE, '-c', "INSERT INTO evimed_control.users VALUES ('late','Committed after the exported snapshot');"], { stdio: 'ignore' });
  if (inserted.status !== 0) process.exit(9);
}
const child = spawn(process.env.EVIMED_TEST_REAL_DOCKER, args, { stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', () => process.exit(8));
child.on('exit', (code) => process.exit(code === 0 && tool === 'createdb' && process.env.EVIMED_TEST_LOSE_CREATE_ACK === 'true' ? 7 : (code ?? 1)));
`);
  await chmod(path.join(bin, "docker"), 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch,
    EVIMED_POSTGRES_CONTAINER: container, EVIMED_POSTGRES_DATABASE: database, EVIMED_POSTGRES_USER: role,
    EVIMED_POSTGRES_BACKUP_DIR: backupDir, EVIMED_POSTGRES_PASSPHRASE_FILE: passphrase,
    EVIMED_TEST_REAL_DOCKER: realDocker, EVIMED_TEST_PG_TRACE: trace, ...extra };
  let runner = path.join(repo, "scripts/ops/postgres-backup.py");
  let command = "python3";
  if (process.env.EVIMED_TEST_LEGACY_POSTGRES_BACKUP_SCRIPT) {
    const original = await readFile(process.env.EVIMED_TEST_LEGACY_POSTGRES_BACKUP_SCRIPT, "utf8");
    assert.ok(original.includes('container="web-evimed-postgres-1"'));
    let body = original.replace('container="web-evimed-postgres-1"', `container="${container}"`)
      .replace('backup_dir="/srv/evimed-science/shared/backups/postgres"', `backup_dir="${backupDir}"`)
      .replace('passphrase_file="/srv/evimed-science/shared/secrets/backup-passphrase.txt"', `passphrase_file="${passphrase}"`)
      .replaceAll("-U evimed", `-U ${role}`).replaceAll("-d evimed", `-d ${database}`).replaceAll("mktemp /tmp/", `mktemp ${scratch}/`);
    if (process.platform === "darwin") body = body.replace("set -euo pipefail", "set -euo pipefail\nstat() { if [ \"$1\" = -c ]; then /usr/bin/stat -f '%Lp' \"$3\"; else command stat \"$@\"; fi; }");
    runner = path.join(root, "legacy-backup.sh");
    await writeFile(runner, body);
    command = "bash";
  }
  t.after(async () => {
    const rows = await readFile(trace, "utf8").catch(() => "");
    for (const row of rows.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) {
      for (const value of row.args ?? []) if (/^evimed_restore_[A-Za-z0-9_]+$/.test(value)) {
        await execute(realDocker, ["exec", container, "dropdb", "--if-exists", "--force", "-U", role, value]).catch(() => {});
      }
    }
    await execute(realDocker, ["exec", container, "dropdb", "--if-exists", "--force", "-U", role, database]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, backupDir, scratch, env, query, run: () => execute(command, [runner], { env, timeout: 35_000 }) };
}

test("a successful CREATE with a lost acknowledgement still cleans its unique drill database", options, async (t) => {
  const { run, query, backupDir, root } = await fixture(t, { EVIMED_TEST_LOSE_CREATE_ACK: "true" });
  await assert.rejects(run());
  const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const target = commands.find(item => item.tool === "createdb").args.at(-1);
  assert.match(target, /^evimed_restore_[A-Za-z0-9_]+$/);
  assert.equal(await query(`SELECT count(*) FROM pg_database WHERE datname='${target}'`), "0");
  const state = JSON.parse(await readFile(path.join(backupDir, "status/state.json"), "utf8"));
  assert.equal(state.status, "failed");
  assert.equal(state.cleanupFailed, false);
  assert.equal(state.drillDatabase, null);
  assert.equal((await readdir(backupDir)).some(name => name.includes(".dump.enc")), false);
});

test("a later successful backup first clears the exact prior failed drill", options, async (t) => {
  const { run, query, backupDir, env } = await fixture(t, { EVIMED_TEST_FAIL_TOOL: "dropdb" });
  await assert.rejects(run());
  const file = path.join(backupDir, "status/state.json");
  const previous = JSON.parse(await readFile(file, "utf8"));
  assert.match(previous.drillDatabase, /^evimed_restore_[A-Za-z0-9_]+$/);
  assert.equal(await query(`SELECT count(*) FROM pg_database WHERE datname='${previous.drillDatabase}'`), "1");
  delete env.EVIMED_TEST_FAIL_TOOL;
  await run();
  const current = JSON.parse(await readFile(file, "utf8"));
  assert.equal(current.status, "healthy");
  assert.equal(current.cleanupVerified, true);
  assert.equal(await query(`SELECT count(*) FROM pg_database WHERE datname='${previous.drillDatabase}'`), "0");
  assert.deepEqual(current.sourceIdentity, previous.sourceIdentity);
});

test("padding after an empty OpenSSL passphrase line cannot produce a backup", options, async (t) => {
  const { run, backupDir, env } = await fixture(t);
  await chmod(env.EVIMED_POSTGRES_PASSPHRASE_FILE, 0o600);
  await writeFile(env.EVIMED_POSTGRES_PASSPHRASE_FILE, "\nSynthetic padding that is not the encryption passphrase.");
  await chmod(env.EVIMED_POSTGRES_PASSPHRASE_FILE, 0o400);
  await assert.rejects(run());
  const state = JSON.parse(await readFile(path.join(backupDir, "status/state.json"), "utf8"));
  assert.equal(state.errorCode, "postgres_backup_passphrase_invalid");
  assert.equal((await readdir(backupDir)).some(name => name.includes(".dump.enc")), false);
});

test("host PostgreSQL backup rejects a no-op restore even though the empty database has catalog tables", options, async (t) => {
  const { run, query } = await fixture(t, { EVIMED_TEST_SKIP_RESTORE: "true" });
  const failure = await run().then(() => null, error => error);
  assert.ok(failure, "an empty restore must not be certified from pg_catalog.pg_class");
  assert.match(failure.stderr, /restore_application_mismatch/, "the rejection must come from the missing application data, not fixture setup");
  assert.equal(await query("SELECT count(*) FROM evimed_control.users"), "2", "the source database must remain untouched");
});

test("host PostgreSQL backup verifies application rows from the same snapshot and publishes structured state", options, async (t) => {
  const { run, backupDir, query, scratch } = await fixture(t, { EVIMED_TEST_INSERT_DURING_DUMP: "true" });
  await run();
  const state = JSON.parse(await readFile(path.join(backupDir, "status/state.json"), "utf8"));
  assert.equal(state.status, "healthy");
  assert.equal(state.restoreVerified, true);
  assert.equal(state.expectedTablesSha256, state.restoredTablesSha256);
  assert.deepEqual(state.tables, [{ schema: "evimed_control", table: "users", rows: "2" }, { schema: "public", table: "memo", rows: "1" }]);
  // Execute the consumer's actual SQL on the same real source, without
  // substituting a hand-written identity receipt for the Python producer.
  const database = { query: async ({ text }) => ({
    rows: JSON.parse(await query(`SELECT coalesce(json_agg(row_to_json(verified)), '[]'::json)::text FROM (${text}) verified`)),
  }) };
  const readiness = await postgresBackupReadiness({ production: true, stateStore: "postgres",
    databaseUrl: `postgresql://localhost/${state.database}`,
    postgresBackupStateFile: path.join(backupDir, "status/state.json"),
  }, database);
  assert.equal(readiness.restoreVerified, true);
  assert.equal(readiness.sourceIdentityVerified, true);
  assert.equal(await query("SELECT count(*) FROM evimed_control.users"), "3", "a post-snapshot commit must stay out of the certified snapshot");
  assert.deepEqual(await readdir(scratch), []);
});

for (const tool of ["pg_dump", "pg_restore", "dropdb"]) {
  test(`host PostgreSQL backup records ${tool} failure and cleans plaintext without exposing diagnostics`, options, async (t) => {
    const { run, backupDir, scratch, query } = await fixture(t, { EVIMED_TEST_FAIL_TOOL: tool });
    let failure;
    try { await run(); } catch (error) { failure = error; }
    assert.ok(failure);
    const stateText = await readFile(path.join(backupDir, "status/state.json"), "utf8");
    const state = JSON.parse(stateText);
    assert.equal(state.status, "failed");
    assert.equal(state.restoreVerified, false);
    assert.doesNotMatch(stateText + failure.stderr, /Synthetic sensitive diagnostic/);
    assert.deepEqual(await readdir(scratch), []);
    assert.equal(await query("SELECT count(*) FROM evimed_control.users"), "2");
  });
}

test("host PostgreSQL backup holds one persistent lock and never overwrites a running job's status", options, async (t) => {
  const { root, backupDir, run } = await fixture(t);
  await mkdir(path.join(backupDir, "status"), { recursive: true });
  const stateFile = path.join(backupDir, "status/state.json");
  const previous = '{"status":"healthy","marker":"preserve previous receipt"}\n';
  await writeFile(stateFile, previous);
  const locker = spawn("python3", ["-c", "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", path.join(backupDir, ".backup.lock")], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { locker.once("error", reject); locker.stdout.once("data", resolve); });
  try {
    await assert.rejects(run(), error => /postgres_backup_already_running/.test(error.stderr));
    assert.equal(await readFile(stateFile, "utf8"), previous);
    assert.equal(await readFile(path.join(root, "commands.jsonl"), "utf8").catch(() => ""), "", "no database command may run without the lock");
  } finally {
    const exited = new Promise(resolve => locker.once("exit", resolve));
    locker.stdin.end();
    await exited;
  }
});

test("a failed host backup preserves the preceding verified archive and success timestamp", options, async (t) => {
  const { run, env, backupDir } = await fixture(t);
  await run();
  const before = JSON.parse(await readFile(path.join(backupDir, "status/state.json"), "utf8"));
  env.EVIMED_TEST_FAIL_TOOL = "pg_dump";
  await assert.rejects(run());
  const failed = JSON.parse(await readFile(path.join(backupDir, "status/state.json"), "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastSuccessAt, before.lastSuccessAt);
  assert.equal(failed.archive, before.archive);
  assert.ok((await readFile(path.join(backupDir, before.archive))).length > 0);
});
