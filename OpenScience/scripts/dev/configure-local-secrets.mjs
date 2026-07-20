#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const secretsDir = path.resolve(rootDir, "..", ".evimed-local", "secrets");

async function ensureRandomSecret(name) {
  const file = path.join(secretsDir, name);
  try {
    const existing = await stat(file);
    if (!existing.isFile()) throw new Error(`${file} is not a regular file`);
    if (process.platform !== "win32" && (existing.mode & 0o077) !== 0) {
      throw new Error(`${file} must use mode 600`);
    }
    return { file, created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${randomBytes(48).toString("base64url")}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { file, created: true };
}

await mkdir(secretsDir, { recursive: true, mode: 0o700 });
const generated = await Promise.all([
  ensureRandomSecret("model-gateway.signing"),
  ensureRandomSecret("evimed-workload.signing"),
  ensureRandomSecret("bootstrap-password"),
]);
for (const item of generated) {
  process.stdout.write(`${item.created ? "Created" : "Ready"}: ${item.file}\n`);
}
const deepseekFile = path.join(secretsDir, "deepseek.api-key");
try {
  const current = await stat(deepseekFile);
  if (!current.isFile() || (process.platform !== "win32" && (current.mode & 0o077) !== 0)) {
    throw new Error("not a mode-600 regular file");
  }
  process.stdout.write(`Ready: ${deepseekFile}\n`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write(`Required: create ${deepseekFile} as a mode-600 file containing only the DeepSeek API key.\n`);
}

const evimedFile = path.join(secretsDir, "evimed.api-key");
try {
  const current = await stat(evimedFile);
  if (!current.isFile() || (process.platform !== "win32" && (current.mode & 0o077) !== 0)) {
    throw new Error("not a mode-600 regular file");
  }
  process.stdout.write(`Ready: ${evimedFile}\n`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write(`Required: create ${evimedFile} as a mode-600 file containing only the EviMed evidence API key.\n`);
}
