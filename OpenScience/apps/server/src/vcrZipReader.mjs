/**
 * A zip read by its central directory, a little at a time, where a run's upload may be any shape.
 *
 * Hidden knowledge:
 *
 * - **The directory is walked, not held.** A 50 MB archive of empty files lists half a million of them, which a reader that builds every entry first holds in the server's own heap, on every batch of
 *   the job. Here the walk reads the directory in small pieces, keeps the first `maxEntries` real files and counts the rest, so what an archive costs is bounded by the limit and not by the archive.
 * - **What an entry says it holds is not believed.** Its size is a claim in a file anyone wrote: a stream counts what it really inflates and stops at the limit it was given, by name.
 * - **An entry's name never becomes a path.** It is a label and something a rule reads. A link or a directory entry is not a file; `..` means nothing here because nothing is ever extracted to disk.
 *
 * @module vcrZipReader
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';
import { HttpError } from './security.mjs';

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const END_SEARCH_BYTES = 66 * 1024;
const WALK_BYTES = 1024 * 1024;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const STORED = 0;
const DEFLATED = 8;

const unreadable = () => new HttpError(422, 'vcr_document_unreadable', 'This archive could not be read.');

/** A name as the archive wrote it: UTF-8 when it says so or when the bytes are, otherwise what a Windows archive in a Chinese locale wrote. @param {Buffer} bytes @param {number} flags */
function nameOf(bytes, flags) {
  if (flags & FLAG_UTF8) return bytes.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('gb18030').decode(bytes); }
}

/** One file of an archive. A class and not closures: an archive may hold a hundred thousand of them. */
class ZipEntry {
  /** @param {string} archive @param {string} entryPath @param {{ method: number, flags: number, compressedSize: number, uncompressedSize: number, offset: number }} place */
  constructor(archive, entryPath, { method, flags, compressedSize, uncompressedSize, offset }) {
    this.archive = archive;
    this.path = entryPath;
    this.type = 'File';
    this.method = method;
    this.flags = flags;
    this.compressedSize = compressedSize;
    this.uncompressedSize = uncompressedSize;
    this.offset = offset;
  }

  /**
   * The entry's bytes, streamed; past `maxBytes` the stream throws `vcr_data_file_too_large`, whatever the entry claimed.
   * @param {{ maxBytes?: number }} [options] @returns {AsyncGenerator<Buffer>}
   */
  async *stream({ maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
    if (this.flags & FLAG_ENCRYPTED || ![STORED, DEFLATED].includes(this.method)) throw unreadable();
    const handle = await fs.open(this.archive, 'r');
    let start;
    try {
      const head = Buffer.alloc(30);
      const { bytesRead } = await handle.read(head, 0, 30, this.offset);
      if (bytesRead < 30 || head.readUInt32LE(0) !== LOCAL_ENTRY) throw unreadable();
      start = this.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    } finally { await handle.close(); }
    if (!this.compressedSize) return;
    const raw = createReadStream(this.archive, { start, end: start + this.compressedSize - 1, highWaterMark: 256 * 1024 });
    const inflate = this.method === DEFLATED ? createInflateRaw() : null;
    if (inflate) { raw.on('error', (error) => inflate.destroy(error)); raw.pipe(inflate); }
    let total = 0;
    try {
      for await (const chunk of inflate ?? raw) {
        total += chunk.length;
        if (total > maxBytes) throw new HttpError(413, 'vcr_data_file_too_large', 'This entry holds more than one file of an import may.');
        yield chunk;
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unreadable();
    } finally {
      raw.destroy();
      inflate?.destroy();
    }
  }
}

/**
 * Where an archive's directory is, from its end record.
 * @param {import('node:fs/promises').FileHandle} handle @param {number} size
 */
async function directoryOf(handle, size) {
  const length = Math.min(size, END_SEARCH_BYTES);
  const tail = Buffer.alloc(length);
  await handle.read(tail, 0, length, size - length);
  let at = -1;
  for (let probe = length - 22; probe >= 0; probe -= 1) {
    if (tail.readUInt32LE(probe) === END_OF_DIRECTORY && probe + 22 + tail.readUInt16LE(probe + 20) <= length) { at = probe; break; }
  }
  if (at < 0) throw unreadable();
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR) {
    const end = Buffer.alloc(56);
    await handle.read(end, 0, 56, Number(tail.readBigUInt64LE(at - 12)));
    if (end.readUInt32LE(0) !== ZIP64_END) throw unreadable();
    directorySize = Number(end.readBigUInt64LE(40));
    directoryOffset = Number(end.readBigUInt64LE(48));
  }
  if (directoryOffset + directorySize > size) throw unreadable();
  return { directoryOffset, directorySize };
}

/** The real values of the fields a zip64 entry stores in its extra field. @param {Buffer} extra @param {{ compressedSize: number, uncompressedSize: number, offset: number }} place */
function zip64Of(extra, place) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at), size = extra.readUInt16LE(at + 2);
    if (id === 1) {
      let field = at + 4;
      const next = () => { const value = field + 8 <= at + 4 + size ? Number(extra.readBigUInt64LE(field)) : 0; field += 8; return value; };
      if (place.uncompressedSize === 0xffffffff) place.uncompressedSize = next();
      if (place.compressedSize === 0xffffffff) place.compressedSize = next();
      if (place.offset === 0xffffffff) place.offset = next();
      return;
    }
    at += 4 + size;
  }
}

/**
 * The first `maxEntries` real files of an archive, and how many more it holds.
 * @param {string} file @param {{ maxEntries: number, ignore?: RegExp | null }} options
 * @returns {Promise<{ entries: ZipEntry[], over: number }>}
 */
export async function openZipEntries(file, { maxEntries, ignore = null }) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw unreadable();
    const { directoryOffset, directorySize } = await directoryOf(handle, size);
    /** @type {ZipEntry[]} */
    const entries = [];
    let over = 0;
    let carried = Buffer.alloc(0);
    let position = directoryOffset;
    const end = directoryOffset + directorySize;
    while (position < end) {
      const length = Math.min(WALK_BYTES, end - position);
      const piece = Buffer.alloc(length);
      const { bytesRead } = await handle.read(piece, 0, length, position);
      if (!bytesRead) throw unreadable();
      position += bytesRead;
      const walk = carried.length ? Buffer.concat([carried, piece.subarray(0, bytesRead)]) : piece.subarray(0, bytesRead);
      let at = 0;
      for (;;) {
        if (at + 46 > walk.length) break;
        if (walk.readUInt32LE(at) !== DIRECTORY_ENTRY) throw unreadable();
        const nameLength = walk.readUInt16LE(at + 28), extraLength = walk.readUInt16LE(at + 30), commentLength = walk.readUInt16LE(at + 32);
        const whole = 46 + nameLength + extraLength + commentLength;
        if (at + whole > walk.length) break;
        const flags = walk.readUInt16LE(at + 8);
        const entryPath = nameOf(walk.subarray(at + 46, at + 46 + nameLength), flags);
        if (!entryPath.endsWith('/') && !ignore?.test(entryPath)) {
          if (entries.length >= maxEntries) over += 1;
          else {
            const place = { method: walk.readUInt16LE(at + 10), flags, compressedSize: walk.readUInt32LE(at + 20), uncompressedSize: walk.readUInt32LE(at + 24), offset: walk.readUInt32LE(at + 42) };
            if (extraLength) zip64Of(walk.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), place);
            entries.push(new ZipEntry(file, entryPath, place));
          }
        }
        at += whole;
      }
      carried = Buffer.from(walk.subarray(at));
    }
    return { entries, over };
  } finally { await handle.close(); }
}
