#!/usr/bin/env node
// Stream the inventoried customer files through verified open descriptors.
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { openScopedDirectoryNoFollow, openScopedFileNoFollow } from "../../apps/server/src/security.mjs";

const arguments_ = process.argv.slice(2);
const inventoryMode = arguments_[0] === "inventory";
const [rootArgument, manifestPath, outputPath, strictArgument = "false"] = inventoryMode
  ? [arguments_[1], arguments_[2], undefined, "true"] : arguments_;
const root = path.resolve(rootArgument);
const strict = strictArgument === "true";
const octalMaximum = 0o77777777777;
// The reader in backup_integrity.py shares this bounded, versioned contract.
const integrityManifestName = ".open-science-backup-manifest.json";
const integrityManifestPrefix = '{"format":"open-science-backup-inventory","version":1,"entries":[';
const maximumManifestBytes = 64 * 1024 * 1024;
const maximumManifestEntries = 1_000_000;
let outputCreated = false;

const managedRuntimePrefix = ["users", null, "projects", null, "runtime", "container-runtime"];
const managedRuntimeIncludedTree = ["dsh-home", "sessions"];

function managedRuntimeDecision(parts) {
  const managed = parts.length >= managedRuntimePrefix.length
    && managedRuntimePrefix.every((part, index) => part === null || parts[index] === part);
  if (!managed) return { managed: false, included: true };
  const suffix = parts.slice(managedRuntimePrefix.length);
  const included = suffix.slice(0, managedRuntimeIncludedTree.length)
    .every((part, index) => managedRuntimeIncludedTree[index] === part);
  return { managed: true, included };
}

function metadataFields(metadata) {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    mode: String(metadata.mode),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    nlink: String(metadata.nlink),
  };
}

function completeIdentityMatches(metadata, entry) {
  const fields = metadataFields(metadata);
  return Object.entries(fields).every(([key, value]) => entry[key] === value);
}

async function digestHandle(handle, size) {
  const digest = createHash("sha256");
  let read = 0;
  if (size > 0) {
    for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
      read += chunk.length;
      digest.update(chunk);
    }
  }
  if (read !== size) throw new Error("Backup source changed during its bounded read.");
  return digest.digest("hex");
}

async function createInventory() {
  const entries = [];
  async function collect(relative) {
    if (relative === integrityManifestName) throw new Error("Refusing a reserved backup manifest path in customer data.");
    const parts = relative ? relative.split("/") : [];
    const decision = managedRuntimeDecision(parts);
    if (!decision.included) return false;
    const name = parts.at(-1) ?? "";
    if (name === ".runtime-sockets" || name.endsWith(".sock")) return false;
    const full = path.join(root, relative);
    const pathMetadata = await lstat(full, { bigint: true });
    if (pathMetadata.isSymbolicLink()) throw new Error(`Refusing to back up data directory containing symbolic links: ${full}`);
    if (pathMetadata.isSocket()) return false;
    if (pathMetadata.isDirectory()) {
      const opened = await openScopedDirectoryNoFollow(root, full);
      try {
        const before = await opened.handle.stat({ bigint: true });
        let retained = false;
        for (const child of (await readdir(full)).sort()) {
          if (await collect(relative ? `${relative}/${child}` : child)) retained = true;
        }
        const after = await opened.handle.stat({ bigint: true });
        if (!completeIdentityMatches(after, { ...metadataFields(before) })) {
          throw new Error("Backup source identity changed during inventory.");
        }
        if (decision.managed && parts.length < managedRuntimePrefix.length + managedRuntimeIncludedTree.length && !retained) {
          return false;
        }
        entries.push({ path: relative || ".", type: "directory", ...metadataFields(before) });
        return true;
      } finally {
        await opened.handle.close();
      }
    }
    if (!pathMetadata.isFile()) throw new Error(`Refusing to back up a non-file data entry: ${full}`);
    const opened = await openScopedFileNoFollow(root, full);
    try {
      const before = await opened.handle.stat({ bigint: true });
      const size = Number(before.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Backup source is too large for an exact size.");
      const sha256 = await digestHandle(opened.handle, size);
      const after = await opened.handle.stat({ bigint: true });
      if (!completeIdentityMatches(after, { ...metadataFields(before) })) {
        throw new Error("Backup source identity changed during inventory.");
      }
      entries.push({ path: relative, type: "file", ...metadataFields(before), sha256 });
      return true;
    } finally {
      await opened.handle.close();
    }
  }
  await collect("");
  await writeFile(manifestPath, JSON.stringify(entries), { mode: 0o600 });
}

function validateEntry(entry) {
  const parts = String(entry?.path ?? "").split("/");
  if (!entry || !["file", "directory"].includes(entry.type) || !entry.path || entry.path.includes("\0")
    || path.isAbsolute(entry.path) || (entry.path !== "." && parts.some(part => !part || part === "." || part === ".."))
    || ![entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.mode, entry.uid, entry.gid]
      .every(value => typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("Invalid backup inventory entry.");
  }
  if (parts[0] === integrityManifestName) throw new Error("Refusing a reserved backup manifest path in customer data.");
  if (strict && (!(typeof entry.ctimeNs === "string" && /^\d+$/.test(entry.ctimeNs))
    || !(typeof entry.nlink === "string" && /^\d+$/.test(entry.nlink))
    || (entry.type === "file" && !(typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))))) {
    throw new Error("Invalid strict backup inventory entry.");
  }
}

async function openEntry(entry) {
  const full = path.join(root, entry.path);
  const opened = entry.type === "directory"
    ? await openScopedDirectoryNoFollow(root, full) : await openScopedFileNoFollow(root, full);
  try {
    const metadata = await opened.handle.stat({ bigint: true });
    if ((strict ? !completeIdentityMatches(metadata, entry)
      : String(metadata.dev) !== entry.dev || String(metadata.ino) !== entry.ino
        || String(metadata.mode) !== entry.mode || String(metadata.uid) !== entry.uid || String(metadata.gid) !== entry.gid)
      || (entry.type === "directory" ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error("Backup source identity changed after inventory.");
    }
    return { handle: opened.handle, metadata };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

function stringField(header, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) throw new Error("Backup tar header field overflow.");
  bytes.copy(header, offset);
}

function octalField(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid backup tar metadata.");
  stringField(header, offset, length - 1, value.toString(8).padStart(length - 1, "0"));
}

function tarHeader(name, { gid = 0, mode = 0o600, mtime = 0, size = 0, type = "0", uid = 0 }) {
  const header = Buffer.alloc(512);
  stringField(header, 0, 100, name);
  octalField(header, 100, 8, mode);
  octalField(header, 108, 8, uid);
  octalField(header, 116, 8, gid);
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  stringField(header, 257, 6, "ustar");
  stringField(header, 263, 2, "00");
  stringField(header, 148, 6, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"));
  header[155] = 0x20;
  return header;
}

function padding(size) { return Buffer.alloc((512 - (size % 512)) % 512); }

// POSIX extended headers preserve valid deep paths and Unicode names beyond
// USTAR's 100-byte name field without truncating customer paths.
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (length !== Buffer.byteLength(`${length} ${body}`)) length = Buffer.byteLength(`${length} ${body}`);
  return Buffer.from(`${length} ${body}`, "utf8");
}

function* headers(entry, metadata, index) {
  const name = entry.type === "directory" && entry.path !== "." ? `${entry.path}/` : entry.path;
  const size = entry.type === "file" ? Number(metadata.size) : 0;
  const mtime = Number(metadata.mtimeNs / 1_000_000_000n);
  const uid = Number(metadata.uid);
  const gid = Number(metadata.gid);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Backup source is too large for an exact size.");
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid backup owner metadata.");
  const extended = [];
  if (Buffer.byteLength(name) > 100) extended.push(paxRecord("path", name));
  if (size > octalMaximum) extended.push(paxRecord("size", size));
  if (mtime < 0 || mtime > octalMaximum) extended.push(paxRecord("mtime", mtime));
  if (uid > 0o7777777) extended.push(paxRecord("uid", uid));
  if (gid > 0o7777777) extended.push(paxRecord("gid", gid));
  if (extended.length) {
    const data = Buffer.concat(extended);
    yield tarHeader(`PaxHeaders/${index}`, { size: data.length, type: "x" });
    yield data;
    yield padding(data.length);
  }
  yield tarHeader(Buffer.byteLength(name) <= 100 ? name : `entry-${index}`, {
    gid: gid <= 0o7777777 ? gid : 0, mode: Number(metadata.mode & 0o7777n),
    mtime: mtime >= 0 && mtime <= octalMaximum ? mtime : 0,
    size: size <= octalMaximum ? size : 0, type: entry.type === "directory" ? "5" : "0",
    uid: uid <= 0o7777777 ? uid : 0,
  });
}

async function createArchive() {
  const entries = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(entries) || !entries.length) throw new Error("Backup inventory is empty.");
  entries.forEach(validateEntry);
  const rootEntry = entries.find(entry => entry.path === "." && entry.type === "directory");
  if (!rootEntry || entries.length > maximumManifestEntries || new Set(entries.map(entry => entry.path)).size !== entries.length) {
    throw new Error("Invalid or oversized backup inventory.");
  }
  const archivedEntries = [];
  let manifestBytes = Buffer.byteLength(integrityManifestPrefix) + 2;
  const recordArchived = (entry) => {
    const serialized = JSON.stringify(entry);
    manifestBytes += Buffer.byteLength(serialized) + (archivedEntries.length ? 1 : 0);
    if (manifestBytes > maximumManifestBytes) throw new Error("Backup integrity manifest exceeds its size limit.");
    archivedEntries.push(serialized);
  };
  const directories = entries.filter(entry => entry.type === "directory");
  const verifyEntries = async (items) => {
    for (const entry of items) {
      const opened = await openEntry(entry);
      await opened.handle.close();
    }
  };
  let changed = 0;
  async function* chunks() {
    await verifyEntries(directories);
    for (const [index, entry] of entries.entries()) {
      const { handle, metadata } = await openEntry(entry);
      try {
        yield* headers(entry, metadata, index);
        if (entry.type === "directory") {
          recordArchived({ path: entry.path, type: "directory", size: 0 });
          continue;
        }
        const size = Number(metadata.size);
        let written = 0;
        const contentDigest = createHash("sha256");
        if (size > 0) {
          for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
            written += chunk.length;
            contentDigest.update(chunk);
            yield chunk;
          }
        }
        if (written !== size) throw new Error("Backup source changed during its bounded read.");
        const sha256 = contentDigest.digest("hex");
        const after = await handle.stat({ bigint: true });
        if (after.nlink > 1n) throw new Error("Backup source became hard-linked while being read.");
        if (String(metadata.size) !== entry.size || String(metadata.mtimeNs) !== entry.mtimeNs
          || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.nlink === 0n
          || (strict && (sha256 !== entry.sha256 || !completeIdentityMatches(after, entry)))) changed++;
        recordArchived({ path: entry.path, type: "file", size, sha256 });
        yield padding(size);
      } finally {
        await handle.close();
      }
    }
    // No archive is accepted after a directory substitution, even if a file
    // descriptor safely retained the original bytes while its name moved.
    await verifyEntries(strict ? entries : directories);
    const integrityManifest = Buffer.from(`${integrityManifestPrefix}${archivedEntries.join(",")}]}`, "utf8");
    yield* headers({ path: integrityManifestName, type: "file" }, {
      size: BigInt(integrityManifest.length), mode: 0o600n, mtimeNs: 0n,
      uid: BigInt(rootEntry.uid), gid: BigInt(rootEntry.gid),
    }, entries.length);
    yield integrityManifest;
    yield padding(integrityManifest.length);
    yield Buffer.alloc(1024);
  }
  const output = await open(outputPath, "wx", 0o600);
  outputCreated = true;
  try {
    await pipeline(Readable.from(chunks()), createGzip(), output.createWriteStream());
  } finally {
    await output.close();
  }
  for (let index = 0; index < changed; index++) process.stderr.write("backup archive: file changed as we read it\n");
  process.exitCode = changed ? 1 : 0;
}

const operation = inventoryMode ? createInventory() : createArchive();
operation.catch(async (error) => {
  if (outputCreated) await rm(outputPath, { force: true }).catch(() => {});
  process.stderr.write(`${error.code ?? (inventoryMode ? "backup_inventory_failed" : "backup_archive_failed")}: ${error.message}\n`);
  process.exitCode = 2;
});
