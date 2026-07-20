#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.resolve(
  process.env.OPEN_SCIENCE_OIDC_SECRETS_DIR ?? path.join(repoRoot, "deploy/web/secrets"),
);
const checkOnly = process.argv.includes("--check");
const rotate = process.argv.includes("--rotate") || /^(?:1|true|yes)$/i.test(process.env.OPEN_SCIENCE_OIDC_ROTATE_SECRETS ?? "");
const jsonOutput = process.argv.includes("--json");
const files = {
  clientSecret: path.join(outputDir, "oidc-client-secret.txt"),
  flowSecret: path.join(outputDir, "oidc-flow-secret.txt"),
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateSecret(value, label, minimumBytes) {
  if (typeof value !== "string" || value !== value.trim() || /[\r\n\0]/.test(value)) {
    fail("oidc_secret_invalid", `${label} must not contain surrounding whitespace, newlines, or NUL bytes.`);
  }
  if (/^(?:replace(?:-with)?|change-?me|example|placeholder|secret|test)(?:[-_ ]|$)/i.test(value)) {
    fail("oidc_secret_placeholder", `${label} must not use a placeholder value.`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > 8192) {
    fail("oidc_secret_size", `${label} must contain between ${minimumBytes} and 8192 UTF-8 bytes.`);
  }
  return value;
}

async function assertNoSymlinkPath(target, { allowMissingTail = false } = {}) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  const parts = path.relative(parsed.root, full).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingTail) return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail("oidc_secret_path_symlink", "OIDC secret paths must not contain symbolic links.");
  }
}

async function readPrivateFile(file) {
  await assertNoSymlinkPath(file);
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail("oidc_secret_not_regular", `${path.basename(file)} must be a regular file.`);
    if (stat.size > 8193) fail("oidc_secret_size", `${path.basename(file)} is too large.`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      fail("oidc_secret_permissions", `${path.basename(file)} must not be group- or world-accessible.`);
    }
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle?.close();
  }
}

async function assertWritableTarget(file) {
  const existing = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) fail("oidc_secret_path_symlink", "Refusing to replace a symbolic-link secret file.");
  if (existing && !existing.isFile()) fail("oidc_secret_not_regular", "OIDC secret targets must be regular files.");
  if (existing && !rotate) fail("oidc_secrets_exist", "OIDC secret files already exist; use --check or explicit --rotate.");
}

async function writePrivateFile(file, value) {
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temp, "wx", 0o600);
    await handle.writeFile(`${value}\n`, "utf8");
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

async function generate() {
  const clientSecret = validateSecret(
    process.env.OPEN_SCIENCE_OIDC_CLIENT_SECRET,
    "OIDC client secret",
    8,
  );
  const flowSecret = validateSecret(
    process.env.OPEN_SCIENCE_OIDC_FLOW_SECRET ?? randomBytes(48).toString("base64url"),
    "OIDC flow secret",
    32,
  );
  if (clientSecret === flowSecret) fail("oidc_secret_reuse", "OIDC client and flow secrets must be different.");

  await assertNoSymlinkPath(outputDir, { allowMissingTail: true });
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(outputDir);
  await fsp.chmod(outputDir, 0o700);
  await Promise.all(Object.values(files).map(assertWritableTarget));
  await writePrivateFile(files.clientSecret, clientSecret);
  await writePrivateFile(files.flowSecret, flowSecret);
}

async function check() {
  await assertNoSymlinkPath(outputDir);
  const clientSecret = validateSecret(await readPrivateFile(files.clientSecret), "OIDC client secret", 8);
  const flowSecret = validateSecret(await readPrivateFile(files.flowSecret), "OIDC flow secret", 32);
  if (clientSecret === flowSecret) fail("oidc_secret_reuse", "OIDC client and flow secrets must be different.");
}

async function main() {
  if (checkOnly) await check();
  else {
    await generate();
    await check();
  }
  const result = {
    ok: true,
    mode: checkOnly ? "check" : rotate ? "rotate" : "generate",
    directory: outputDir,
    files: Object.values(files).map((file) => path.basename(file)),
  };
  process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `OIDC secrets ${result.mode} ok: ${outputDir}\n`);
}

main().catch((error) => {
  const code = error?.code ?? "oidc_secret_configuration_failed";
  const message = error instanceof Error ? error.message : String(error);
  if (jsonOutput) process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
