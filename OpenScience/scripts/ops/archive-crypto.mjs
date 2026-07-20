#!/usr/bin/env node
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const MAGIC = "OPEN_SCIENCE_BACKUP_ENCRYPTED_V1";
const scryptAsync = promisify(scrypt);

function usage() {
  console.error("Usage: archive-crypto.mjs encrypt|decrypt INPUT OUTPUT");
  process.exit(2);
}

function passphrase() {
  const value = process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE ?? "";
  const secretFile = process.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE ?? "";
  if (value && secretFile) {
    throw new Error("Configure only one backup passphrase source.");
  }
  let secret = value;
  if (secretFile) {
    const full = path.resolve(secretFile);
    const parsed = path.parse(full);
    const parts = path.relative(parsed.root, full).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Backup passphrase path must not contain symbolic links.");
    }
    const handle = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 8192) {
        throw new Error("Backup passphrase file must be a small regular file.");
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("Backup passphrase file must not be accessible by group or other users.");
      }
      secret = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    } finally {
      fs.closeSync(handle);
    }
  }
  if (!secret) {
    throw new Error("OPEN_SCIENCE_BACKUP_PASSPHRASE is required for encrypted backups.");
  }
  if (secret.length < 16 || /[\r\n\0]/.test(secret)) {
    throw new Error("Backup passphrase must contain at least 16 characters without control newlines.");
  }
  return secret;
}

async function deriveKey(secret, salt) {
  return scryptAsync(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function encrypt(input, output) {
  const stat = await fsp.lstat(input);
  if (!stat.isFile()) throw new Error(`Input is not a regular file: ${input}`);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase(), salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const dir = path.dirname(output);
  const ciphertextTmp = path.join(dir, `.${path.basename(output)}.${process.pid}.${Date.now()}.cipher.tmp`);
  const outputTmp = path.join(dir, `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);

  try {
    await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(ciphertextTmp, { mode: 0o600 }));
    const header = {
      version: 1,
      cipher: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    await fsp.writeFile(outputTmp, `${MAGIC}\n${JSON.stringify(header)}\n`, { mode: 0o600 });
    await pipeline(fs.createReadStream(ciphertextTmp), fs.createWriteStream(outputTmp, { flags: "a" }));
    await fsp.rename(outputTmp, output);
    await fsp.chmod(output, 0o600);
  } finally {
    await fsp.rm(ciphertextTmp, { force: true }).catch(() => {});
    await fsp.rm(outputTmp, { force: true }).catch(() => {});
  }
}

async function readEncryptedHeader(input) {
  const handle = await fsp.open(input, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead);
    const firstNewline = chunk.indexOf(0x0a);
    const secondNewline = firstNewline >= 0 ? chunk.indexOf(0x0a, firstNewline + 1) : -1;
    if (firstNewline < 0 || secondNewline < 0) {
      throw new Error("Encrypted backup header is missing or truncated.");
    }
    const magic = chunk.subarray(0, firstNewline).toString("utf8");
    if (magic !== MAGIC) throw new Error("Backup archive is not an Open Science encrypted backup.");
    const header = JSON.parse(chunk.subarray(firstNewline + 1, secondNewline).toString("utf8"));
    return { header, offset: secondNewline + 1 };
  } finally {
    await handle.close();
  }
}

function decodeBase64(value, label, expectedLength) {
  if (typeof value !== "string") throw new Error(`Encrypted backup header is missing ${label}.`);
  const out = Buffer.from(value, "base64");
  if (out.length !== expectedLength) throw new Error(`Encrypted backup header has an invalid ${label}.`);
  return out;
}

async function decrypt(input, output) {
  const stat = await fsp.lstat(input);
  if (!stat.isFile()) throw new Error(`Input is not a regular file: ${input}`);
  const { header, offset } = await readEncryptedHeader(input);
  if (header.version !== 1 || header.cipher !== "aes-256-gcm" || header.kdf !== "scrypt") {
    throw new Error("Unsupported encrypted backup format.");
  }
  const salt = decodeBase64(header.salt, "salt", 16);
  const iv = decodeBase64(header.iv, "iv", 12);
  const tag = decodeBase64(header.tag, "tag", 16);
  const key = await deriveKey(passphrase(), salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const outputTmp = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await pipeline(fs.createReadStream(input, { start: offset }), decipher, fs.createWriteStream(outputTmp, { mode: 0o600 }));
    await fsp.rename(outputTmp, output);
    await fsp.chmod(output, 0o600);
  } finally {
    await fsp.rm(outputTmp, { force: true }).catch(() => {});
  }
}

const [, , mode, input, output] = process.argv;
if (!["encrypt", "decrypt"].includes(mode) || !input || !output) usage();

try {
  if (mode === "encrypt") await encrypt(input, output);
  else await decrypt(input, output);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
