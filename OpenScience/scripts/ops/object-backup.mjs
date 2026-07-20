#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const archivePattern = /^open-science-data-\d{8}T\d{6}Z\.tar\.gz(?:\.enc)?$/;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{0,61}[a-z0-9]$/;
const keySegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._+=-]{0,254}$/;
const outputLimit = 64 * 1024;

function usage() {
  console.error(
    "Usage: object-backup.mjs upload ARCHIVE S3_PREFIX | download S3_ARCHIVE OUTPUT_DIR | probe S3_PREFIX",
  );
  process.exit(2);
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes"].includes(raw.toLowerCase());
}

function parseS3Uri(value, { archiveRequired = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Object backup location must be a valid s3:// URI.");
  }
  if (
    url.protocol !== "s3:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !bucketPattern.test(url.hostname)
  ) {
    throw new Error("Object backup location must be a credential-free s3://bucket/path URI.");
  }
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new Error("Object backup key contains invalid percent encoding.");
      }
      if (!keySegmentPattern.test(decoded) || decoded === "." || decoded === "..") {
        throw new Error("Object backup key contains an unsafe segment.");
      }
      return decoded;
    });
  if (archiveRequired && !archivePattern.test(segments.at(-1) ?? "")) {
    throw new Error("Object backup URI must name an Open Science backup archive.");
  }
  return { bucket: url.hostname, segments };
}

function formatS3Uri(location) {
  const suffix = location.segments.length ? `/${location.segments.join("/")}` : "";
  return `s3://${location.bucket}${suffix}`;
}

async function assertNoSymlinkPath(file, { allowMissingTail = false } = {}) {
  const full = path.resolve(file);
  const parsed = path.parse(full);
  const parts = path.relative(parsed.root, full).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (allowMissingTail && error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Object backup paths must not contain symbolic links: ${full}`);
  }
}

async function assertRegularFile(file) {
  await assertNoSymlinkPath(file);
  const stat = await fsp.lstat(file);
  if (!stat.isFile()) throw new Error(`Object backup artifact must be a regular file: ${file}`);
  return stat;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyChecksum(archive) {
  const checksumFile = `${archive}.sha256`;
  const stat = await assertRegularFile(checksumFile);
  if (stat.size > 1024) throw new Error("Backup checksum sidecar is too large.");
  const text = (await fsp.readFile(checksumFile, "utf8")).trim();
  const match = text.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
  if (!match || match[2] !== path.basename(archive)) {
    throw new Error("Backup checksum sidecar does not match the archive name.");
  }
  const actual = await sha256File(archive);
  if (actual !== match[1]) throw new Error("Backup archive checksum mismatch.");
  return { checksumFile, digest: actual };
}

function encryptionArgs() {
  const mode = (process.env.OPEN_SCIENCE_OBJECT_BACKUP_SSE ?? "").trim();
  if (!mode) return [];
  if (mode === "AES256") return ["--sse", "AES256"];
  if (mode === "aws:kms") {
    const keyId = (process.env.OPEN_SCIENCE_OBJECT_BACKUP_KMS_KEY_ID ?? "").trim();
    if (!keyId || /[\r\n\0]/.test(keyId)) {
      throw new Error("OPEN_SCIENCE_OBJECT_BACKUP_KMS_KEY_ID is required for aws:kms.");
    }
    return ["--sse", "aws:kms", "--sse-kms-key-id", keyId];
  }
  throw new Error("OPEN_SCIENCE_OBJECT_BACKUP_SSE must be AES256 or aws:kms.");
}

function compactError(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
}

function runObjectCli(args) {
  const command = (process.env.OPEN_SCIENCE_OBJECT_BACKUP_CLI ?? "aws").trim();
  if (!command || /[\r\n\0]/.test(command)) throw new Error("Object backup CLI path is invalid.");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      reject(new Error(`Object backup CLI failed to start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && !overflow) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      const detail = overflow
        ? "command output exceeded the safety limit"
        : compactError(stderr) || `exit ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`;
      reject(new Error(`Object backup CLI failed: ${detail}`));
    });
  });
}

function assertEncryptedArchive(name) {
  if (!name.endsWith(".enc") && !boolEnv("OPEN_SCIENCE_OBJECT_BACKUP_ALLOW_PLAINTEXT")) {
    throw new Error("Object backups must be client-side encrypted; configure a backup passphrase when creating them.");
  }
}

async function upload(archiveArg, prefixArg) {
  const archive = path.resolve(archiveArg);
  const name = path.basename(archive);
  if (!archivePattern.test(name)) throw new Error("Archive name is not an Open Science backup artifact.");
  assertEncryptedArchive(name);
  await assertRegularFile(archive);
  const { checksumFile } = await verifyChecksum(archive);
  const prefix = parseS3Uri(prefixArg);
  const archiveUri = formatS3Uri({ ...prefix, segments: [...prefix.segments, name] });
  const checksumUri = `${archiveUri}.sha256`;
  const common = ["--only-show-errors", ...encryptionArgs()];
  await runObjectCli(["s3", "cp", archive, archiveUri, ...common]);
  try {
    await runObjectCli(["s3", "cp", checksumFile, checksumUri, ...common]);
  } catch (error) {
    throw new Error(`${error.message} The archive object was uploaded without its checksum sidecar and must not be used.`);
  }
  process.stdout.write(`${archiveUri}\n`);
}

async function assertReplaceable(file, replace) {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to replace non-regular object backup target: ${file}`);
  }
  if (!replace) throw new Error(`Object backup target already exists: ${file}`);
  return true;
}

async function download(uriArg, outputArg) {
  const source = parseS3Uri(uriArg, { archiveRequired: true });
  const name = source.segments.at(-1);
  assertEncryptedArchive(name);
  const outputDir = path.resolve(outputArg);
  await assertNoSymlinkPath(outputDir, { allowMissingTail: true });
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(outputDir);
  const outputStat = await fsp.lstat(outputDir);
  if (!outputStat.isDirectory()) throw new Error("Object backup output path must be a directory.");

  const archive = path.join(outputDir, name);
  const checksumFile = `${archive}.sha256`;
  const replace = boolEnv("OPEN_SCIENCE_OBJECT_BACKUP_REPLACE");
  const archiveExists = await assertReplaceable(archive, replace);
  const checksumExists = await assertReplaceable(checksumFile, replace);

  const tmpDir = await fsp.mkdtemp(path.join(outputDir, ".object-backup-"));
  const tmpArchive = path.join(tmpDir, name);
  const tmpChecksum = `${tmpArchive}.sha256`;
  try {
    const uri = formatS3Uri(source);
    await runObjectCli(["s3", "cp", uri, tmpArchive, "--only-show-errors"]);
    await runObjectCli(["s3", "cp", `${uri}.sha256`, tmpChecksum, "--only-show-errors"]);
    await assertRegularFile(tmpArchive);
    await verifyChecksum(tmpArchive);
    const previousArchive = path.join(tmpDir, ".previous-archive");
    const previousChecksum = path.join(tmpDir, ".previous-checksum");
    if (archiveExists) await fsp.rename(archive, previousArchive);
    try {
      if (checksumExists) await fsp.rename(checksumFile, previousChecksum);
    } catch (error) {
      if (archiveExists) await fsp.rename(previousArchive, archive);
      throw error;
    }
    try {
      await fsp.rename(tmpChecksum, checksumFile);
      await fsp.rename(tmpArchive, archive);
    } catch (error) {
      await fsp.rm(archive, { force: true });
      await fsp.rm(checksumFile, { force: true });
      if (archiveExists) await fsp.rename(previousArchive, archive);
      if (checksumExists) await fsp.rename(previousChecksum, checksumFile);
      throw error;
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  process.stdout.write(`${archive}\n`);
}

async function probe(prefixArg) {
  const prefix = parseS3Uri(prefixArg);
  const token = randomBytes(16).toString("hex");
  const objectUri = formatS3Uri({
    ...prefix,
    segments: [...prefix.segments, "open-science-preflight", `probe-${token}.bin`],
  });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "open-science-object-probe-"));
  const source = path.join(tmpDir, "source.bin");
  const downloaded = path.join(tmpDir, "downloaded.bin");
  const payload = randomBytes(128);
  let uploaded = false;
  try {
    await fsp.writeFile(source, payload, { mode: 0o600 });
    await runObjectCli(["s3", "cp", source, objectUri, "--only-show-errors", ...encryptionArgs()]);
    uploaded = true;
    await runObjectCli(["s3", "cp", objectUri, downloaded, "--only-show-errors"]);
    const readBack = await fsp.readFile(downloaded);
    if (readBack.length !== payload.length || !readBack.equals(payload)) {
      throw new Error("Object storage probe read-back did not match the uploaded payload.");
    }
    await runObjectCli(["s3", "rm", objectUri, "--only-show-errors"]);
    uploaded = false;
  } finally {
    if (uploaded) {
      await runObjectCli(["s3", "rm", objectUri, "--only-show-errors"]).catch(() => {});
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  process.stdout.write("object storage probe ok\n");
}

const [, , command, first, second] = process.argv;
if (
  !command ||
  !first ||
  !["upload", "download", "probe"].includes(command) ||
  (["upload", "download"].includes(command) && !second) ||
  (command === "probe" && second)
) usage();

try {
  if (command === "upload") await upload(first, second);
  else if (command === "download") await download(first, second);
  else await probe(first);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
