#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const secretFile = path.resolve(
  process.env.OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE ??
    path.join(repoRoot, "deploy/web/secrets/bootstrap-password.txt"),
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
      throw failure("local_auth_secret_symlink", "Local authentication secret paths must not contain symbolic links.");
    }
  }
}

function validateValue(value) {
  if (value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw failure("local_auth_secret_invalid", "Bootstrap password must not contain surrounding whitespace, newlines, or NUL bytes.");
  }
  if (/^(?:replace(?:-with)?|change-?me|example|placeholder|test)(?:[-_ ]|$)/i.test(value)) {
    throw failure("local_auth_secret_placeholder", "Bootstrap password must not use a placeholder value.");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 16 || bytes > 8192) {
    throw failure("local_auth_secret_size", "Bootstrap password must contain between 16 and 8192 UTF-8 bytes.");
  }
}

async function validateSecret() {
  await assertNoSymlinkPath(secretFile);
  const handle = await fsp.open(secretFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure("local_auth_secret_not_regular", "Bootstrap password must be a regular file.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw failure("local_auth_secret_permissions", "Bootstrap password must not be accessible by group or other users.");
    }
    if (stat.size <= 0 || stat.size > 8193) {
      throw failure("local_auth_secret_size", "Bootstrap password file size is invalid.");
    }
    validateValue((await handle.readFile("utf8")).replace(/\r?\n$/, ""));
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
    await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
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
    if (checkOnly) throw failure("local_auth_secret_missing", "Bootstrap password file is missing.");
    await createSecret();
  }
  await validateSecret();
  process.stdout.write(`local auth secret ${checkOnly ? "check" : "configuration"} ok: ${secretFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "local_auth_secret_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
