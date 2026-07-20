#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const secretsDir = path.resolve(
  process.env.OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR ?? path.join(repoRoot, "deploy/web/secrets"),
);
const postgresPasswordFile = path.resolve(
  process.env.OPEN_SCIENCE_POSTGRES_PASSWORD_HOST_FILE ?? path.join(secretsDir, "postgres-password.txt"),
);
const databaseUrlFile = path.resolve(
  process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE ?? path.join(secretsDir, "database-url.txt"),
);
const memosDsnFile = path.resolve(
  process.env.OPEN_SCIENCE_MEMOS_DSN_HOST_FILE ?? path.join(secretsDir, "memos-dsn.txt"),
);
const memosAdminPasswordFile = path.resolve(
  process.env.OPEN_SCIENCE_MEMOS_ADMIN_PASSWORD_HOST_FILE ?? path.join(secretsDir, "memos-admin-password.txt"),
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
      throw failure("production_state_secret_symlink", "Production state secret paths must not contain symbolic links.");
    }
  }
}

function validateSecretValue(value, label) {
  if (value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw failure("production_state_secret_invalid", `${label} contains invalid whitespace or NUL bytes.`);
  }
  if (Buffer.byteLength(value, "utf8") < 24 || Buffer.byteLength(value, "utf8") > 512) {
    throw failure("production_state_secret_size", `${label} must contain between 24 and 512 UTF-8 bytes.`);
  }
}

async function readOwnerOnly(file, label, { maxBytes = 4096 } = {}) {
  await assertNoSymlinkPath(file);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure("production_state_secret_not_regular", `${label} must be a regular file.`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw failure("production_state_secret_permissions", `${label} must not be accessible by group or other users.`);
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw failure("production_state_secret_size", `${label} has an invalid size.`);
    }
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
}

async function createOwnerOnly(file, value) {
  await assertNoSymlinkPath(file, { allowMissingTail: true });
  const parent = path.dirname(file);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(parent);
  await fsp.chmod(parent, 0o700);
  const handle = await fsp.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(file, 0o600);
}

async function ensureSecret(file, label) {
  const existing = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    if (checkOnly) throw failure("production_state_secret_missing", `${label} is missing.`);
    await createOwnerOnly(file, randomBytes(36).toString("base64url"));
  }
  const value = await readOwnerOnly(file, label);
  validateSecretValue(value, label);
  return value;
}

function expectedDatabaseUrl(password) {
  return `postgresql://evimed:${encodeURIComponent(password)}@evimed-postgres:5432/evimed?sslmode=disable`;
}

async function ensureDsn(file, label, expected) {
  const existing = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    if (checkOnly) throw failure("production_state_secret_missing", `${label} is missing.`);
    await createOwnerOnly(file, expected);
  }
  const value = await readOwnerOnly(file, label);
  if (value !== expected) {
    throw failure("production_state_dsn_mismatch", `${label} does not match the configured PostgreSQL credential.`);
  }
  return value;
}

async function main() {
  const postgresPassword = await ensureSecret(postgresPasswordFile, "PostgreSQL password");
  await ensureSecret(memosAdminPasswordFile, "Memos administrator password");
  const dsn = expectedDatabaseUrl(postgresPassword);
  await ensureDsn(databaseUrlFile, "EviMed database URL", dsn);
  await ensureDsn(memosDsnFile, "Memos database DSN", dsn);
  process.stdout.write(`production state ${checkOnly ? "check" : "configuration"} ok: ${secretsDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "production_state_configuration_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
