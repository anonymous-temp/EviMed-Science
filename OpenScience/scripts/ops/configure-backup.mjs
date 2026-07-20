#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const secretFile = path.resolve(
  process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE ??
    path.join(repoRoot, "deploy/web/secrets/backup-passphrase.txt"),
);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
    if (stat.isSymbolicLink()) {
      throw failure("backup_secret_symlink", "Backup secret paths must not contain symbolic links.");
    }
  }
}

async function validateSecret() {
  await assertNoSymlinkPath(secretFile);
  const stat = await fsp.lstat(secretFile);
  if (!stat.isFile()) throw failure("backup_secret_not_regular", "Backup passphrase must be a regular file.");
  if ((stat.mode & 0o077) !== 0) {
    throw failure("backup_secret_permissions", "Backup passphrase must not be accessible by group or other users.");
  }
  if (stat.size <= 0 || stat.size > 8192) {
    throw failure("backup_secret_size", "Backup passphrase file size is invalid.");
  }
  const handle = await fsp.open(secretFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 32 || /[\r\n\0]/.test(value)) {
      throw failure("backup_secret_weak", "Backup passphrase must contain at least 32 characters without control newlines.");
    }
  } finally {
    await handle.close();
  }
}

async function createSecret() {
  await assertNoSymlinkPath(secretFile, { allowMissingTail: true });
  const parent = path.dirname(secretFile);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(parent);
  await fsp.chmod(parent, 0o700);
  const handle = await fsp.open(secretFile, "wx", 0o600);
  try {
    await handle.writeFile(`${randomBytes(48).toString("base64url")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(secretFile, 0o600);
}

async function main() {
  const existing = await fsp.lstat(secretFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    if (checkOnly) throw failure("backup_secret_missing", "Backup passphrase file is missing.");
    await createSecret();
  }
  await validateSecret();
  process.stdout.write(`backup secret ${checkOnly ? "check" : "configuration"} ok: ${secretFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "backup_secret_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
