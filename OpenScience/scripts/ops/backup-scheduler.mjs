#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.join(scriptDir, "backup-data.sh");
const restoreDrillScript = path.join(scriptDir, "restore-drill.sh");
const objectBackupScript = path.join(scriptDir, "object-backup.mjs");
const archivePattern = /^open-science-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/;
const outputLimit = 64 * 1024;
let activeChild = null;
let stopping = false;

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes"].includes(raw.toLowerCase());
}

function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function compactError(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 512);
}

function operationalError(value) {
  let text = compactError(value);
  const replacements = [
    [process.env.OPEN_SCIENCE_DATA_DIR, "<data>"],
    [process.env.OPEN_SCIENCE_BACKUP_DIR, "<backups>"],
    [process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE, "<secret-file>"],
    [scriptDir, "<ops>"],
  ];
  for (const [source, replacement] of replacements) {
    if (source) text = text.split(path.resolve(source)).join(replacement);
  }
  return text.replace(/s3:\/\/[^\s]+/gi, "<object-uri>");
}

function schedulerConfig() {
  const dataDir = path.resolve(process.env.OPEN_SCIENCE_DATA_DIR ?? "/data");
  const backupDir = path.resolve(process.env.OPEN_SCIENCE_BACKUP_DIR ?? "/backups");
  return {
    dataDir,
    backupDir,
    stateFile: path.resolve(
      process.env.OPEN_SCIENCE_BACKUP_STATE_FILE ?? path.join(backupDir, ".open-science-backup-state.json"),
    ),
    intervalSeconds: integerEnv("OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS", 86_400, { min: 60, max: 31_536_000 }),
    healthGraceSeconds: integerEnv("OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS", 1_800, { min: 60, max: 604_800 }),
    retrySeconds: integerEnv("OPEN_SCIENCE_BACKUP_RETRY_SECONDS", 300, { min: 1, max: 86_400 }),
    maxFailures: integerEnv("OPEN_SCIENCE_BACKUP_MAX_FAILURES", 3, { min: 1, max: 100 }),
    drillEvery: integerEnv("OPEN_SCIENCE_BACKUP_RESTORE_DRILL_EVERY", 1, { min: 1, max: 10_000 }),
    // Empty means this deployment keeps backups on one machine and has said so.
    objectBackupUri: String(process.env.OPEN_SCIENCE_OBJECT_BACKUP_URI ?? "").trim(),
    initialDelaySeconds: integerEnv("OPEN_SCIENCE_BACKUP_INITIAL_DELAY_SECONDS", 0, { min: 0, max: 86_400 }),
    runOnce: boolEnv("OPEN_SCIENCE_BACKUP_RUN_ONCE"),
  };
}

async function assertNoSymlinkPath(target, { allowMissingTail = false } = {}) {
  const parsed = path.parse(target);
  const parts = path.relative(parsed.root, target).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch((error) => {
      if (allowMissingTail && error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error("Backup scheduler paths must not contain symbolic links.");
  }
}

async function readState(file) {
  await assertNoSymlinkPath(file, { allowMissingTail: true });
  const stat = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Backup scheduler state file is invalid.");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const parsed = JSON.parse(await handle.readFile("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid state");
    return parsed;
  } finally {
    await handle.close();
  }
}

async function writeState(file, value) {
  const parent = path.dirname(file);
  await assertNoSymlinkPath(parent, { allowMissingTail: true });
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(parent);
  const existing = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Backup scheduler state target must be a regular file.");
  }
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle = await fsp.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } finally {
    await handle?.close();
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > outputLimit) {
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      fn(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(compactError(stderr) || `process exited with ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
    });
  });
}

function log(event, fields = {}, error = false) {
  const row = { timestamp: new Date().toISOString(), event, ...fields };
  (error ? process.stderr : process.stdout).write(`${JSON.stringify(row)}\n`);
}

async function runCycle(config, previous) {
  const attemptAt = new Date().toISOString();
  const backup = await runProcess("bash", [backupScript, config.dataDir, config.backupDir]);
  const archive = path.resolve(backup.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
  if (path.dirname(archive) !== config.backupDir || !archivePattern.test(path.basename(archive))) {
    throw new Error("Backup command returned an invalid encrypted archive path.");
  }
  const successfulBackups = Number.isSafeInteger(previous?.successfulBackups)
    ? previous.successfulBackups + 1
    : 1;
  let lastDrillAt = previous?.lastDrillAt ?? null;
  let restoreDrill = "not_due";
  if (!previous?.lastDrillAt || successfulBackups % config.drillEvery === 0) {
    await runProcess("bash", [restoreDrillScript, archive]);
    lastDrillAt = new Date().toISOString();
    restoreDrill = "completed";
  }
  // Copy it off the machine, if this deployment has somewhere to copy it to.
  //
  // Nothing here did that. The scheduler made encrypted archives, drilled the
  // restore, and reported success — while every copy stayed on one disk. On
  // 2026-08-31 that had been true for 119 backups: the readiness probe said
  // `backup_external_unconfirmed`, the operator acknowledgement was unsigned,
  // and the object-storage URI was empty. A backup that has never left the
  // machine it protects is a backup for the failures that do not take the
  // machine with them.
  //
  // Three outcomes, kept apart on purpose. "This deployment has no off-box
  // target" is a decision and reports as `not_configured`. "The upload failed"
  // is an incident and must not be reported as a completed backup — but neither
  // may it discard the local archive, which is real and was just verified.
  let offsite = "not_configured";
  if (config.objectBackupUri) {
    try {
      await runProcess("node", [objectBackupScript, "upload", archive, config.objectBackupUri]);
      offsite = "uploaded";
    } catch (error) {
      offsite = "failed";
      log("backup.offsite_failed", {
        archive: path.basename(archive),
        error: String(error?.message ?? error).slice(0, 400),
      }, true);
    }
  }

  const state = {
    schemaVersion: 1,
    // A local archive with no off-box copy is not the same health as one with
    // it. `degraded` keeps the distinction visible without discarding a backup
    // that did succeed locally.
    status: offsite === "failed" ? "degraded" : "healthy",
    lastAttemptAt: attemptAt,
    lastSuccessAt: new Date().toISOString(),
    lastDrillAt,
    lastArchive: path.basename(archive),
    lastOffsite: offsite,
    lastOffsiteAt: offsite === "uploaded" ? new Date().toISOString() : (previous?.lastOffsiteAt ?? null),
    successfulBackups,
    consecutiveFailures: 0,
  };
  await writeState(config.stateFile, state);
  log("backup.completed", {
    archive: state.lastArchive,
    successfulBackups,
    restoreDrill,
    offsite,
  });
  return state;
}

async function recordFailure(config, previous, error) {
  const state = {
    schemaVersion: 1,
    status: "failed",
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastDrillAt: previous?.lastDrillAt ?? null,
    lastArchive: previous?.lastArchive ?? null,
    successfulBackups: Number.isSafeInteger(previous?.successfulBackups) ? previous.successfulBackups : 0,
    consecutiveFailures: (Number.isSafeInteger(previous?.consecutiveFailures) ? previous.consecutiveFailures : 0) + 1,
    error: operationalError(error instanceof Error ? error.message : error),
  };
  await writeState(config.stateFile, state);
  log("backup.failed", { consecutiveFailures: state.consecutiveFailures, error: state.error }, true);
  return state;
}

function sleep(seconds) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    const poll = setInterval(() => {
      if (stopping) done();
    }, 100);
  });
}

async function health() {
  const config = schedulerConfig();
  const state = await readState(config.stateFile);
  const lastSuccess = Date.parse(state?.lastSuccessAt ?? "");
  const lastDrill = Date.parse(state?.lastDrillAt ?? "");
  const maxAgeMs = (config.intervalSeconds + config.healthGraceSeconds) * 1000;
  const now = Date.now();
  if (
    state?.status !== "healthy" ||
    !Number.isFinite(lastSuccess) ||
    !Number.isFinite(lastDrill) ||
    lastSuccess > now + 5 * 60_000 ||
    lastDrill > now + 5 * 60_000 ||
    now - lastSuccess > maxAgeMs
  ) {
    throw new Error("Backup scheduler has no recent successful backup.");
  }
  process.stdout.write("backup scheduler healthy\n");
}

async function run() {
  const config = schedulerConfig();
  if (!process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE && !process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE) {
    throw new Error("An encrypted backup passphrase source is required.");
  }
  await assertNoSymlinkPath(config.dataDir);
  const dataStat = await fsp.lstat(config.dataDir);
  if (!dataStat.isDirectory()) throw new Error("Backup data path must be a directory.");
  await assertNoSymlinkPath(config.backupDir, { allowMissingTail: true });
  await fsp.mkdir(config.backupDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(config.backupDir);
  if (config.initialDelaySeconds > 0) await sleep(config.initialDelaySeconds);

  let state = await readState(config.stateFile);
  while (!stopping) {
    try {
      state = await runCycle(config, state);
      if (config.runOnce) return;
      await sleep(config.intervalSeconds);
    } catch (error) {
      state = await recordFailure(config, state, error);
      // Throwing here exits the process, and the container restarts it — which
      // reads the failure count back, exceeds the threshold again, and takes a
      // full backup on the way. What looks like a circuit breaker became a
      // backup every two minutes: eight 403 MB archives in a quarter of an
      // hour, until the disk filled and the filling was itself the failure.
      //
      // Past the threshold the scheduler stays up and stops trying so often.
      // Health still reports failed, so the deployment is not pretending to be
      // backed up; it simply is not paying for the attempt every retry window.
      const exhausted = state.consecutiveFailures >= config.maxFailures;
      // A one-shot invocation retries inside its failure budget — that is what
      // makes `runOnce` mean "get one backup done" rather than "attempt one
      // backup" — but once the budget is gone it has to give up and say so.
      // Falling through to the circuit-breaker sleep instead left a one-shot
      // run retrying forever: an operator got a process that never exited and
      // never explained itself, and the test covering this exact path hung
      // rather than reporting. The failure is already recorded and logged, so
      // rethrowing is what turns it into a non-zero exit.
      if (config.runOnce && exhausted) throw error;
      if (exhausted) {
        log("backup.circuit_open", {
          consecutiveFailures: state.consecutiveFailures,
          sleepingSeconds: config.intervalSeconds,
        }, true);
      }
      await sleep(exhausted ? config.intervalSeconds : config.retrySeconds);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    activeChild?.kill("SIGTERM");
  });
}

const mode = process.argv[2] ?? "run";
const task = mode === "health" ? health() : mode === "run" ? run() : Promise.reject(new Error("Unknown backup scheduler mode."));
task.catch((error) => {
  log("backup.scheduler_failed", { error: operationalError(error instanceof Error ? error.message : error) }, true);
  process.exitCode = 1;
});
