#!/usr/bin/env node
// Stream the inventoried customer files through verified open descriptors.
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { openScopedDirectoryNoFollow, openScopedFileNoFollow } from "../../apps/server/src/security.mjs";

const [rootArgument, manifestPath, outputPath] = process.argv.slice(2);
const root = path.resolve(rootArgument);
const octalMaximum = 0o77777777777;
let outputCreated = false;

function validateEntry(entry) {
  const parts = String(entry?.path ?? "").split("/");
  if (!entry || !["file", "directory"].includes(entry.type) || !entry.path || entry.path.includes("\0")
    || path.isAbsolute(entry.path) || (entry.path !== "." && parts.some(part => !part || part === "." || part === ".."))
    || ![entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.mode, entry.uid, entry.gid]
      .every(value => typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("Invalid backup inventory entry.");
  }
}

async function openEntry(entry) {
  const full = path.join(root, entry.path);
  const opened = entry.type === "directory"
    ? await openScopedDirectoryNoFollow(root, full) : await openScopedFileNoFollow(root, full);
  try {
    const metadata = await opened.handle.stat({ bigint: true });
    if (String(metadata.dev) !== entry.dev || String(metadata.ino) !== entry.ino
      || String(metadata.mode) !== entry.mode || String(metadata.uid) !== entry.uid || String(metadata.gid) !== entry.gid
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
  const directories = entries.filter(entry => entry.type === "directory");
  const verifyDirectories = async () => {
    for (const entry of directories) {
      const opened = await openEntry(entry);
      await opened.handle.close();
    }
  };
  let changed = 0;
  async function* chunks() {
    await verifyDirectories();
    for (const [index, entry] of entries.entries()) {
      const { handle, metadata } = await openEntry(entry);
      try {
        yield* headers(entry, metadata, index);
        if (entry.type === "directory") continue;
        const size = Number(metadata.size);
        let written = 0;
        if (size > 0) {
          for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
            written += chunk.length;
            yield chunk;
          }
        }
        if (written !== size) throw new Error("Backup source changed during its bounded read.");
        const after = await handle.stat({ bigint: true });
        if (after.nlink > 1n) throw new Error("Backup source became hard-linked while being read.");
        if (String(metadata.size) !== entry.size || String(metadata.mtimeNs) !== entry.mtimeNs
          || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.nlink === 0n) changed++;
        yield padding(size);
      } finally {
        await handle.close();
      }
    }
    // No archive is accepted after a directory substitution, even if a file
    // descriptor safely retained the original bytes while its name moved.
    await verifyDirectories();
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

createArchive().catch(async (error) => {
  if (outputCreated) await rm(outputPath, { force: true }).catch(() => {});
  process.stderr.write(`${error.code ?? "backup_archive_failed"}: ${error.message}\n`);
  process.exitCode = 2;
});
