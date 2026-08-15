#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";

const ARCHIVE_RE = /^open-science-data-\d{8}T\d{6}Z\.tar\.gz(?:\.enc)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
  console.error("Usage: backup-retention.mjs prune BACKUP_DIR RETENTION_DAYS");
  process.exit(2);
}

function parseRetentionDays(value) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new Error("RETENTION_DAYS must be a positive integer.");
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error("RETENTION_DAYS must be a positive integer.");
  }
  return days;
}

async function assertBackupDir(dir) {
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink()) throw new Error(`Backup directory must not be a symbolic link: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Backup path is not a directory: ${dir}`);
}

async function removeRegularFile(file, { optional = false } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (err) {
    if (optional && err?.code === "ENOENT") return false;
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error(`Refusing to delete symbolic link: ${file}`);
  if (!stat.isFile()) throw new Error(`Refusing to delete non-file backup artifact: ${file}`);
  await fsp.rm(file);
  return true;
}

// Age alone does not bound a directory. A scheduler retrying a failure wrote
// eight 403 MB archives inside fifteen minutes, and every one of them was
// younger than the retention window, so nothing was eligible for deletion while
// the disk filled. A count is the bound that holds however often backups run.
const DEFAULT_MAX_ARCHIVES = 14;

async function prune(backupDir, retentionDays, maxArchives = DEFAULT_MAX_ARCHIVES) {
  await assertBackupDir(backupDir);
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const deleted = [];
  const archives = [];

  for (const entry of entries) {
    if (!ARCHIVE_RE.test(entry.name)) continue;
    const archive = path.join(backupDir, entry.name);
    const stat = await fsp.lstat(archive);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to prune symbolic-link backup archive: ${archive}`);
    if (!stat.isFile()) continue;
    archives.push({ name: entry.name, path: archive, mtimeMs: stat.mtimeMs });
  }

  // Newest first, so "keep the most recent N" is the same decision as "the rest
  // are surplus" — and an archive older than the window goes whichever rank it
  // holds.
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, archive] of archives.entries()) {
    const tooOld = archive.mtimeMs < cutoff;
    const surplus = Number.isSafeInteger(maxArchives) && maxArchives > 0 && index >= maxArchives;
    if (!tooOld && !surplus) continue;

    await removeRegularFile(archive.path);
    deleted.push(archive.name);
    if (await removeRegularFile(`${archive.path}.sha256`, { optional: true })) {
      deleted.push(`${archive.name}.sha256`);
    }
  }

  return { backupDir, retentionDays, maxArchives, deleted };
}

const [, , mode, backupDir, daysArg] = process.argv;
if (mode !== "prune" || !backupDir || !daysArg) usage();

try {
  const result = await prune(path.resolve(backupDir), parseRetentionDays(daysArg));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
