import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const backupScript = path.join(repoRoot, "scripts/ops/backup-data.sh");
const restoreScript = path.join(repoRoot, "scripts/ops/restore-data.sh");
const restoreDrillScript = path.join(repoRoot, "scripts/ops/restore-drill.sh");
const migrateScript = path.join(repoRoot, "scripts/ops/migrate-data-dir.sh");
const objectBackupScript = path.join(repoRoot, "scripts/ops/object-backup.mjs");
const backupSchedulerScript = path.join(repoRoot, "scripts/ops/backup-scheduler.mjs");
const configureBackupScript = path.join(repoRoot, "scripts/ops/configure-backup.mjs");
const configureLocalAuthScript = path.join(repoRoot, "scripts/ops/configure-local-auth.mjs");

// Every child here is expected to finish on its own. A bound is still set,
// because the one that did not — a scheduler that retried forever on failure —
// took the whole suite down with it and reported nothing at all. A hang that
// reports as a failed test is a bug you can read; a hang that reports as
// nothing is a suite people learn to skip.
const CHILD_TIMEOUT_MS = 120_000;

function describeChildFailure(error, command) {
  if (error?.killed) {
    error.message = `${command} did not exit within ${CHILD_TIMEOUT_MS} ms and was killed: ${error.message}`;
  }
  return error;
}

function run(script, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile("bash", [script, ...args], { cwd: repoRoot, timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL", ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(describeChildFailure(error, `bash ${script}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoRoot, timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL", ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(describeChildFailure(error, `${command} ${args.join(" ")}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("restore extraction does not require archived ownership privileges", async () => {
  const source = await readFile(restoreScript, "utf8");
  assert.match(source, /tar --no-same-owner -xzf/);
});

test("local auth secret tooling creates and validates an owner-only password file", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-local-auth-secret-")));
  const secretFile = path.join(tmp, "secrets", "bootstrap-password.txt");
  const env = { ...process.env, OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE: secretFile };
  try {
    const configured = await runCommand(process.execPath, [configureLocalAuthScript], { env });
    const password = (await readFile(secretFile, "utf8")).trim();
    assert.ok(Buffer.byteLength(password, "utf8") >= 16);
    assert.equal(configured.stdout.includes(password), false);
    assert.equal((await stat(secretFile)).mode & 0o077, 0);

    const checked = await runCommand(process.execPath, [configureLocalAuthScript, "--check"], { env });
    assert.match(checked.stdout, /local auth secret check ok/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("local auth secret tooling rejects permissive files and symbolic links", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-local-auth-policy-")));
  const secretFile = path.join(tmp, "bootstrap-password.txt");
  const target = path.join(tmp, "target.txt");
  const env = { ...process.env, OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE: secretFile };
  try {
    await writeFile(secretFile, "file-backed-correct-horse-battery-staple\n", { mode: 0o644 });
    await assert.rejects(
      runCommand(process.execPath, [configureLocalAuthScript, "--check"], { env }),
      (error) => {
        assert.match(error.stderr, /local_auth_secret_permissions/);
        return true;
      },
    );
    await rm(secretFile);
    await writeFile(target, "file-backed-correct-horse-battery-staple\n", { mode: 0o600 });
    await symlink(target, secretFile);
    await assert.rejects(
      runCommand(process.execPath, [configureLocalAuthScript, "--check"], { env }),
      (error) => {
        assert.match(error.stderr, /local_auth_secret_symlink/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

async function fakeObjectCli(root, objectRoot, logFile) {
  const cli = path.join(root, "fake-aws.mjs");
  await writeFile(
    cli,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] !== "s3" || !["cp", "rm"].includes(args[1])) process.exit(2);
if (args[1] === "rm") {
  const parsed = new URL(args[2]);
  const target = path.join(${JSON.stringify(objectRoot)}, parsed.hostname, ...parsed.pathname.split("/").filter(Boolean));
  fs.rmSync(target, { force: true });
  process.exit(0);
}
const source = args[2];
const target = args[3];
const objectPath = (uri) => {
  const parsed = new URL(uri);
  return path.join(${JSON.stringify(objectRoot)}, parsed.hostname, ...parsed.pathname.split("/").filter(Boolean));
};
if (source.startsWith("s3://")) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(objectPath(source), target);
} else {
  const destination = objectPath(target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

`,
    "utf8",
  );
  await chmod(cli, 0o700);
  return cli;
}

test("backup secret tooling creates and validates an owner-only file", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-backup-secret-")));
  const secretFile = path.join(tmp, "secrets", "backup-passphrase.txt");
  const env = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: secretFile };
  try {
    const configured = await runCommand(process.execPath, [configureBackupScript], { env });
    const secret = (await readFile(secretFile, "utf8")).trim();
    assert.ok(secret.length >= 32);
    assert.equal(configured.stdout.includes(secret), false);
    assert.equal((await stat(secretFile)).mode & 0o077, 0);

    const checked = await runCommand(process.execPath, [configureBackupScript, "--check"], { env });
    assert.match(checked.stdout, /backup secret check ok/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("backup secret tooling rejects permissive files and symbolic links", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-backup-secret-")));
  const secretFile = path.join(tmp, "backup-passphrase.txt");
  const target = path.join(tmp, "target.txt");
  const env = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: secretFile };
  try {
    await writeFile(secretFile, "correct horse battery staple for scheduler\n", { mode: 0o644 });
    await assert.rejects(
      runCommand(process.execPath, [configureBackupScript, "--check"], { env }),
      (error) => {
        assert.match(error.stderr, /backup_secret_permissions/);
        return true;
      },
    );
    await rm(secretFile);
    await writeFile(target, "correct horse battery staple for scheduler\n", { mode: 0o600 });
    await symlink(target, secretFile);
    await assert.rejects(
      runCommand(process.execPath, [configureBackupScript, "--check"], { env }),
      (error) => {
        assert.match(error.stderr, /backup_secret_symlink/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("backup scheduler creates an encrypted archive, runs a restore drill, and reports health", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-backup-scheduler-")));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const secretFile = path.join(tmp, "backup-passphrase.txt");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  await writeFile(secretFile, "correct horse battery staple for scheduler\n", { mode: 0o600 });
  const env = {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_BACKUP_DIR: backupDir,
    OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: secretFile,
    OPEN_SCIENCE_BACKUP_RUN_ONCE: "true",
    OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: "60",
    OPEN_SCIENCE_BACKUP_RETRY_SECONDS: "10",
    OPEN_SCIENCE_BACKUP_RESTORE_DRILL_EVERY: "1",
    OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "7",
  };
  try {
    const scheduled = await runCommand(process.execPath, [backupSchedulerScript, "run"], { env });
    assert.match(scheduled.stdout, /"event":"backup.completed"/);
    const entries = await readdir(backupDir);
    const archive = entries.find((name) => name.endsWith(".tar.gz.enc"));
    assert.ok(archive);
    await readFile(path.join(backupDir, `${archive}.sha256`), "utf8");
    const state = JSON.parse(await readFile(path.join(backupDir, ".open-science-backup-state.json"), "utf8"));
    assert.equal(state.status, "healthy");
    assert.equal(state.successfulBackups, 1);
    assert.ok(state.lastDrillAt);
    assert.equal(state.lastArchive, archive);

    const health = await runCommand(process.execPath, [backupSchedulerScript, "health"], { env });
    assert.match(health.stdout, /backup scheduler healthy/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("backup scheduler records object-upload failures and fails health closed", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-backup-scheduler-")));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const secretFile = path.join(tmp, "backup-passphrase.txt");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  await writeFile(secretFile, "correct horse battery staple for scheduler\n", { mode: 0o600 });
  const env = {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_BACKUP_DIR: backupDir,
    OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: secretFile,
    OPEN_SCIENCE_BACKUP_RUN_ONCE: "true",
    OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: "60",
    OPEN_SCIENCE_BACKUP_RETRY_SECONDS: "10",
    OPEN_SCIENCE_BACKUP_MAX_FAILURES: "1",
    OPEN_SCIENCE_OBJECT_BACKUP_URI: "s3://research-backups/open-science/prod",
    OPEN_SCIENCE_OBJECT_BACKUP_CLI: "/bin/false",
  };
  try {
    await assert.rejects(
      runCommand(process.execPath, [backupSchedulerScript, "run"], { env }),
      (error) => {
        assert.match(error.stderr, /"event":"backup.failed"/);
        assert.equal(error.stderr.includes("correct horse battery staple"), false);
        return true;
      },
    );
    const state = JSON.parse(await readFile(path.join(backupDir, ".open-science-backup-state.json"), "utf8"));
    assert.equal(state.status, "failed");
    assert.equal(state.consecutiveFailures, 1);
    await assert.rejects(
      runCommand(process.execPath, [backupSchedulerScript, "health"], { env }),
      (error) => {
        assert.match(error.stderr, /no recent successful backup/);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("backup scheduler retries a failed object upload until one cycle succeeds", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-backup-retry-")));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const secretFile = path.join(tmp, "backup-passphrase.txt");
  const countFile = path.join(tmp, "attempts.txt");
  const objectCli = path.join(tmp, "flaky-object-cli.mjs");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  await writeFile(secretFile, "correct horse battery staple for scheduler\n", { mode: 0o600 });
  await writeFile(
    objectCli,
    `#!/usr/bin/env node
import fs from "node:fs";
const file = ${JSON.stringify(countFile)};
let count = 0;
try { count = Number(fs.readFileSync(file, "utf8")); } catch {}
count += 1;
fs.writeFileSync(file, String(count));
process.exit(count === 1 ? 1 : 0);
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    OPEN_SCIENCE_DATA_DIR: dataDir,
    OPEN_SCIENCE_BACKUP_DIR: backupDir,
    OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: secretFile,
    OPEN_SCIENCE_BACKUP_RUN_ONCE: "true",
    OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: "60",
    OPEN_SCIENCE_BACKUP_RETRY_SECONDS: "1",
    OPEN_SCIENCE_BACKUP_MAX_FAILURES: "3",
    OPEN_SCIENCE_OBJECT_BACKUP_URI: "s3://research-backups/open-science/prod",
    OPEN_SCIENCE_OBJECT_BACKUP_CLI: objectCli,
  };
  try {
    const result = await runCommand(process.execPath, [backupSchedulerScript, "run"], { env });
    assert.match(result.stderr, /"event":"backup.failed"/);
    assert.match(result.stdout, /"event":"backup.completed"/);
    assert.ok(Number(await readFile(countFile, "utf8")) >= 3);
    const state = JSON.parse(await readFile(path.join(backupDir, ".open-science-backup-state.json"), "utf8"));
    assert.equal(state.status, "healthy");
    assert.equal(state.consecutiveFailures, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ops backup and restore round-trip OPEN_SCIENCE_DATA_DIR contents", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const restoreDir = path.join(tmp, "restored");
  await mkdir(path.join(dataDir, "users", "alice", "projects", "paper1", "workspace"), { recursive: true });
  await mkdir(path.join(dataDir, ".openscience"), { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  await writeFile(path.join(dataDir, ".openscience", "security.jsonl"), '{"event":"login"}\n');
  await writeFile(path.join(dataDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "# Report\n");

  const backup = await run(backupScript, [dataDir, backupDir]);
  const archive = backup.stdout.trim();
  assert.match(archive, /open-science-data-\d{8}T\d{6}Z\.tar\.gz$/);
  await readFile(`${archive}.sha256`, "utf8");

  const restore = await run(restoreScript, [archive, restoreDir]);
  assert.equal(restore.stdout.trim(), restoreDir);
  assert.equal(await readFile(path.join(restoreDir, "users.json"), "utf8"), '{"version":1}\n');
  assert.equal(
    await readFile(path.join(restoreDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "utf8"),
    "# Report\n",
  );
});

test("ops encrypted backup and restore round-trip OPEN_SCIENCE_DATA_DIR contents", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const restoreDir = path.join(tmp, "restored");
  const env = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "correct horse battery staple" };
  await mkdir(path.join(dataDir, "users", "alice", "projects", "paper1", "workspace"), { recursive: true });
  await writeFile(path.join(dataDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "# Secret Report\n");

  const backup = await run(backupScript, [dataDir, backupDir], { env });
  const archive = backup.stdout.trim();
  assert.match(archive, /open-science-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/);
  assert.match(await readFile(archive, "utf8"), /^OPEN_SCIENCE_BACKUP_ENCRYPTED_V1\n/);
  await readFile(`${archive}.sha256`, "utf8");

  await assert.rejects(
    () => run(restoreScript, [archive, restoreDir]),
    (err) => {
      assert.match(err.stderr, /OPEN_SCIENCE_BACKUP_PASSPHRASE is required/);
      return true;
    },
  );

  const restore = await run(restoreScript, [archive, restoreDir], { env });
  assert.equal(restore.stdout.trim(), restoreDir);
  assert.equal(
    await readFile(path.join(restoreDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "utf8"),
    "# Secret Report\n",
  );
});

test("ops encrypted backups round-trip through an S3-compatible object store", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-object-backup-")));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const objectRoot = path.join(tmp, "objects");
  const downloadDir = path.join(tmp, "downloads");
  const restoreDir = path.join(tmp, "restored");
  const cliLog = path.join(tmp, "object-cli.jsonl");
  await mkdir(path.join(dataDir, "users", "alice", "projects", "paper1", "workspace"), { recursive: true });
  await writeFile(
    path.join(dataDir, "users", "alice", "projects", "paper1", "workspace", "report.md"),
    "# Off-host Report\n",
  );
  const objectCli = await fakeObjectCli(tmp, objectRoot, cliLog);
  const env = {
    ...process.env,
    OPEN_SCIENCE_BACKUP_PASSPHRASE: "correct horse battery staple",
    OPEN_SCIENCE_OBJECT_BACKUP_CLI: objectCli,
    OPEN_SCIENCE_OBJECT_BACKUP_URI: "s3://research-backups/open-science/prod",
    OPEN_SCIENCE_OBJECT_BACKUP_SSE: "AES256",
  };

  const backup = await run(backupScript, [dataDir, backupDir], { env });
  const archive = backup.stdout.trim();
  const name = path.basename(archive);
  const objectArchive = path.join(objectRoot, "research-backups", "open-science", "prod", name);
  assert.equal(await readFile(objectArchive, "utf8"), await readFile(archive, "utf8"));
  await readFile(`${objectArchive}.sha256`, "utf8");

  const objectUri = `s3://research-backups/open-science/prod/${name}`;
  const downloaded = await runCommand(process.execPath, [objectBackupScript, "download", objectUri, downloadDir], { env });
  assert.equal(downloaded.stdout.trim(), path.join(downloadDir, name));
  const restored = await run(restoreScript, [downloaded.stdout.trim(), restoreDir], { env });
  assert.equal(restored.stdout.trim(), restoreDir);
  assert.equal(
    await readFile(path.join(restoreDir, "users", "alice", "projects", "paper1", "workspace", "report.md"), "utf8"),
    "# Off-host Report\n",
  );

  const cliRows = (await readFile(cliLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(cliRows.length, 4);
  assert.ok(cliRows.slice(0, 2).every((args) => args.includes("--sse") && args.includes("AES256")));
  assert.equal(JSON.stringify(cliRows).includes("correct horse battery staple"), false);
});

test("object storage preflight probes write, read-back, integrity, and delete access", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-object-probe-")));
  const objectRoot = path.join(tmp, "objects");
  const cliLog = path.join(tmp, "object-cli.jsonl");
  const objectCli = await fakeObjectCli(tmp, objectRoot, cliLog);
  const env = {
    ...process.env,
    OPEN_SCIENCE_OBJECT_BACKUP_CLI: objectCli,
    OPEN_SCIENCE_OBJECT_BACKUP_SSE: "AES256",
  };
  try {
    const result = await runCommand(
      process.execPath,
      [objectBackupScript, "probe", "s3://research-backups/open-science/prod"],
      { env },
    );
    assert.equal(result.stdout.trim(), "object storage probe ok");
    const rows = (await readFile(cliLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((args) => args.slice(0, 2)), [["s3", "cp"], ["s3", "cp"], ["s3", "rm"]]);
    assert.ok(rows[0].includes("--sse") && rows[0].includes("AES256"));
    const remaining = await readdir(path.join(objectRoot, "research-backups", "open-science", "prod", "open-science-preflight"));
    assert.deepEqual(remaining, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("object backup upload rejects plaintext, unsafe locations, and checksum drift", async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-science-object-backup-")));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  const backup = await run(backupScript, [dataDir, backupDir]);
  const archive = backup.stdout.trim();

  await assert.rejects(
    () => runCommand(process.execPath, [objectBackupScript, "upload", archive, "s3://research-backups/prod"]),
    (error) => {
      assert.match(error.stderr, /must be client-side encrypted/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      runCommand(process.execPath, [objectBackupScript, "upload", archive, "https://example.com/backups"], {
        env: { ...process.env, OPEN_SCIENCE_OBJECT_BACKUP_ALLOW_PLAINTEXT: "true" },
      }),
    (error) => {
      assert.match(error.stderr, /valid s3:\/\/ URI|credential-free s3:\/\/bucket/);
      return true;
    },
  );

  await writeFile(`${archive}.sha256`, `${"0".repeat(64)}  ${path.basename(archive)}\n`, "utf8");
  await assert.rejects(
    () =>
      runCommand(process.execPath, [objectBackupScript, "upload", archive, "s3://research-backups/prod"], {
        env: { ...process.env, OPEN_SCIENCE_OBJECT_BACKUP_ALLOW_PLAINTEXT: "true" },
      }),
    (error) => {
      assert.match(error.stderr, /checksum mismatch/);
      return true;
    },
  );
});

test("ops restore drill validates a backup in a disposable directory", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const drillDir = path.join(tmp, "drills");
  await mkdir(dataDir, { recursive: true });
  await mkdir(drillDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');

  const backup = await run(backupScript, [dataDir, backupDir]);
  const archive = backup.stdout.trim();
  const drill = await run(restoreDrillScript, [archive], {
    env: { ...process.env, OPEN_SCIENCE_RESTORE_DRILL_DIR: drillDir },
  });

  assert.match(drill.stdout.trim(), /^restore drill ok:/);
  assert.deepEqual(await readdir(drillDir), []);
});

test("ops backup retention prunes old matching archives and checksum sidecars", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  await mkdir(dataDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  const oldArchive = path.join(backupDir, "open-science-data-20000101T000000Z.tar.gz");
  await writeFile(oldArchive, "old archive\n");
  await writeFile(`${oldArchive}.sha256`, "old checksum\n");
  await writeFile(path.join(backupDir, "notes.txt"), "keep\n");
  const oldDate = new Date("2000-01-01T00:00:00.000Z");
  await utimes(oldArchive, oldDate, oldDate);
  await utimes(`${oldArchive}.sha256`, oldDate, oldDate);

  const backup = await run(backupScript, [dataDir, backupDir], {
    env: { ...process.env, OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "7" },
  });
  const archive = backup.stdout.trim();

  await readFile(archive, "utf8");
  await readFile(`${archive}.sha256`, "utf8");
  await assert.rejects(() => readFile(oldArchive, "utf8"), (err) => err?.code === "ENOENT");
  await assert.rejects(() => readFile(`${oldArchive}.sha256`, "utf8"), (err) => err?.code === "ENOENT");
  assert.equal(await readFile(path.join(backupDir, "notes.txt"), "utf8"), "keep\n");
});

test("ops restore refuses to replace a non-empty data directory unless explicitly enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const restoreDir = path.join(tmp, "restored");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "users.json"), '{"version":1}\n');
  const backup = await run(backupScript, [dataDir, backupDir]);
  const archive = backup.stdout.trim();
  await mkdir(restoreDir, { recursive: true });
  await writeFile(path.join(restoreDir, "existing.txt"), "keep\n");

  await assert.rejects(
    () => run(restoreScript, [archive, restoreDir]),
    (err) => {
      assert.match(err.stderr, /Target data directory is not empty/);
      return true;
    },
  );

  await run(restoreScript, [archive, restoreDir], {
    env: { ...process.env, OPEN_SCIENCE_RESTORE_REPLACE: "true" },
  });
  assert.equal(await readFile(path.join(restoreDir, "users.json"), "utf8"), '{"version":1}\n');
});

test("ops backup refuses data directories containing symbolic links", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const dataDir = path.join(tmp, "data");
  const backupDir = path.join(tmp, "backups");
  const outside = path.join(tmp, "outside.txt");
  await mkdir(dataDir, { recursive: true });
  await writeFile(outside, "secret\n");
  await symlink(outside, path.join(dataDir, "leak"));

  await assert.rejects(
    () => run(backupScript, [dataDir, backupDir]),
    (err) => {
      assert.match(err.stderr, /Refusing to back up data directory containing symbolic links/);
      return true;
    },
  );
});

test("ops restore refuses archives containing symbolic links", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const src = path.join(tmp, "src");
  const outside = path.join(tmp, "outside.txt");
  const archive = path.join(tmp, "bad.tar.gz");
  await mkdir(src, { recursive: true });
  await writeFile(outside, "secret\n");
  await symlink(outside, path.join(src, "leak"));
  await runCommand("tar", ["-czf", archive, "-C", src, "."], { cwd: tmp });

  await assert.rejects(
    () => run(restoreScript, [archive, path.join(tmp, "restored")]),
    (err) => {
      assert.match(err.stderr, /Refusing to restore archive containing symbolic links/);
      return true;
    },
  );
});

test("ops data-dir migration copies data into an empty target after verification", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const source = path.join(tmp, "source-data");
  const target = path.join(tmp, "target-data");
  await mkdir(path.join(source, "users", "alice", "projects", "paper1", "workspace"), { recursive: true });
  await mkdir(path.join(source, ".openscience"), { recursive: true });
  await writeFile(path.join(source, "users.json"), '{"version":1}\n');
  await writeFile(path.join(source, ".openscience", "sessions.json"), '{"sessions":[]}\n');
  await writeFile(path.join(source, "users", "alice", "projects", "paper1", "workspace", "report.md"), "# Report\n");

  const migrated = await run(migrateScript, [source, target]);
  assert.equal(migrated.stdout.trim(), target);
  assert.equal(await readFile(path.join(target, "users.json"), "utf8"), '{"version":1}\n');
  assert.equal(
    await readFile(path.join(target, "users", "alice", "projects", "paper1", "workspace", "report.md"), "utf8"),
    "# Report\n",
  );
});

test("ops data-dir migration refuses non-empty targets unless explicitly enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const source = path.join(tmp, "source-data");
  const target = path.join(tmp, "target-data");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "users.json"), '{"version":1}\n');
  await writeFile(path.join(target, "existing.txt"), "keep\n");

  await assert.rejects(
    () => run(migrateScript, [source, target]),
    (err) => {
      assert.match(err.stderr, /Target data directory is not empty/);
      return true;
    },
  );

  await run(migrateScript, [source, target], {
    env: { ...process.env, OPEN_SCIENCE_MIGRATE_REPLACE: "true" },
  });
  assert.equal(await readFile(path.join(target, "users.json"), "utf8"), '{"version":1}\n');
  await assert.rejects(() => readFile(path.join(target, "existing.txt"), "utf8"), (err) => err?.code === "ENOENT");
});

test("ops data-dir migration refuses symbolic links and overlapping targets", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-science-ops-"));
  const source = path.join(tmp, "source-data");
  const outside = path.join(tmp, "outside.txt");
  await mkdir(source, { recursive: true });
  await writeFile(outside, "secret\n");
  await symlink(outside, path.join(source, "leak"));

  await assert.rejects(
    () => run(migrateScript, [source, path.join(tmp, "target-data")]),
    (err) => {
      assert.match(err.stderr, /Refusing to migrate data directory containing symbolic links/);
      return true;
    },
  );

  await rm(path.join(source, "leak"));
  await writeFile(path.join(source, "users.json"), '{"version":1}\n');

  await assert.rejects(
    () => run(migrateScript, [source, path.join(source, "nested-target")]),
    (err) => {
      assert.match(err.stderr, /Target data directory must not be inside the source directory/);
      return true;
    },
  );
});
