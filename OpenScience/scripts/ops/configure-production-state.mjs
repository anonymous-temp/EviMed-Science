#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedOpenVikingConfiguration } from "./openviking-configuration.mjs";

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
const openListAdminPasswordFile = path.resolve(
  process.env.OPEN_SCIENCE_OPENLIST_ADMIN_PASSWORD_HOST_FILE ?? path.join(secretsDir, "openlist-admin-password.txt"),
);
const openVikingApiKeyFile = path.resolve(
  process.env.OPEN_SCIENCE_OPENVIKING_API_KEY_HOST_FILE ?? path.join(secretsDir, "openviking-api-key.txt"),
);
const openVikingConfFile = path.resolve(
  process.env.OPEN_SCIENCE_OPENVIKING_CONF_HOST_FILE ?? path.join(secretsDir, "openviking-ov.conf"),
);
// The bearer the engine's own model calls carry to the control plane's model
// gateway (v0.5.0). Random bytes like the root key: it buys nothing outside
// this deployment, and it is rendered into ov.conf below.
const openVikingModelKeyFile = path.resolve(
  process.env.OPEN_SCIENCE_OPENVIKING_MODEL_KEY_HOST_FILE ?? path.join(secretsDir, "openviking-model-key.txt"),
);
// The one secret here nobody generates: it is bought, not minted. Everything
// else in this directory is random bytes this script can produce again.
const dashScopeApiKeyFile = path.resolve(
  process.env.OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE ?? path.join(secretsDir, "dashscope.api-key"),
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

function validateSecretValue(value, label, { minBytes = 24 } = {}) {
  if (value !== value.trim() || /[\r\n\u0000]/.test(value)) {
    throw failure("production_state_secret_invalid", `${label} contains invalid whitespace or NUL bytes.`);
  }
  if (Buffer.byteLength(value, "utf8") < minBytes || Buffer.byteLength(value, "utf8") > 512) {
    throw failure("production_state_secret_size", `${label} must contain between ${minBytes} and 512 UTF-8 bytes.`);
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

/**
 * The engine's configuration file: what `openviking-configuration.mjs` renders, stored once and compared byte for
 * byte afterwards. A deployment that last ran this before v0.5.0 holds the earlier rendering (no model path, no
 * extraction, no Compile): it is refused by name, and deleting the file and running again writes the current one.
 */
async function ensureOpenVikingConfiguration(rootApiKey, embeddingApiKey, modelKey) {
  const pin = JSON.parse(await fsp.readFile(path.join(repoRoot, "deps-version.json"), "utf8")).openviking;
  const expected = JSON.stringify(expectedOpenVikingConfiguration({ rootApiKey, embeddingApiKey, modelKey, pin }), null, 2);
  const existing = await fsp.lstat(openVikingConfFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    if (checkOnly) throw failure("production_state_secret_missing", "OpenViking configuration is missing.");
    await createOwnerOnly(openVikingConfFile, expected);
  }
  const value = await readOwnerOnly(openVikingConfFile, "OpenViking configuration", { maxBytes: 16_384 });
  if (value !== expected) {
    // Named without its content: this file carries four credentials, and the
    // difference between the rendered and the stored one would show them.
    throw failure(
      "production_state_openviking_conf_mismatch",
      "OpenViking configuration does not match what this deployment renders; delete it and re-run to regenerate.",
    );
  }
}

/** The one secret an operator supplies. Never generated, never printed. */
async function readDashScopeApiKey() {
  const existing = await fsp.lstat(dashScopeApiKeyFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    throw failure(
      "production_state_dashscope_key_missing",
      `The DashScope API key is not at ${dashScopeApiKeyFile}. Place the key there (chmod 0600); this script never creates one.`,
    );
  }
  const value = await readOwnerOnly(dashScopeApiKeyFile, "DashScope API key");
  // A shorter floor than the generated secrets': this length is the vendor's
  // to choose, and refusing a key the vendor issued would be our defect.
  validateSecretValue(value, "DashScope API key", { minBytes: 16 });
  return value;
}

async function main() {
  // First, because it is the one thing this script cannot produce: a run that
  // generated half the directory and then asked for a key looks like a failure
  // of the generation rather than a missing purchase.
  const dashScopeApiKey = await readDashScopeApiKey();
  const postgresPassword = await ensureSecret(postgresPasswordFile, "PostgreSQL password");
  await ensureSecret(openListAdminPasswordFile, "OpenList administrator password");
  const openVikingApiKey = await ensureSecret(openVikingApiKeyFile, "OpenViking API key");
  const openVikingModelKey = await ensureSecret(openVikingModelKeyFile, "OpenViking model key");
  await ensureOpenVikingConfiguration(openVikingApiKey, dashScopeApiKey, openVikingModelKey);
  const dsn = expectedDatabaseUrl(postgresPassword);
  await ensureDsn(databaseUrlFile, "EviMed database URL", dsn);
  process.stdout.write(`production state ${checkOnly ? "check" : "configuration"} ok: ${secretsDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "production_state_configuration_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
