#!/usr/bin/env node
/**
 * Build and load the frontier editor's glossary (「前沿动态」 术语表, plan §10.3.6).
 *
 *   node scripts/ops/seed-frontier-glossary.mjs                              # hand-kept rows only: a summary
 *   node scripts/ops/seed-frontier-glossary.mjs --data-dir <药学基础数据> --out glossary.json
 *   node scripts/ops/seed-frontier-glossary.mjs --from glossary.json --apply
 *   node scripts/ops/seed-frontier-glossary.mjs --data-dir <药学基础数据> --apply
 *
 * Two sources, merged:
 *
 * - the hand-kept rows committed at `apps/server/src/frontierGlossarySeed.json`
 *   (agencies, societies, trials kept as written, a few method and disease
 *   names), origin `hand`;
 * - drug generic names from the pharmacy base data (`药学基础数据/`, local and
 *   gitignored, read-only here): the NMPA drug list's level-5 classification,
 *   whose English and Chinese columns name the active substance (semaglutide →
 *   司美格鲁肽) — about four thousand pairs, origin `nmpa-drug-list`. When one
 *   English name carries several Chinese ones, the one most products use wins.
 *   Combination products ("X and Y", "Compound X") are skipped: a glossary row
 *   names one substance.
 *
 * The base data lives on a workstation, not on the deployment host; so the
 * build and the load are separable: `--out` writes the merged rows to a JSON
 * file, `--from` loads such a file instead of reading the data again. A
 * hand-kept row wins over a generated one, in the file and in the database —
 * `--apply` never overwrites a row whose origin is `hand` with a generated one.
 *
 * The workbook is read with a small streaming reader of its own (zip central
 * directory, raw inflate, shared strings, rows): the sheet is 174 MB of XML and
 * the platform ships no spreadsheet library on the server side.
 *
 * `--apply` writes into `evimed_frontier.glossary`, which the server creates
 * when the frontier module first starts. The database comes from `DATABASE_URL`, or the sources
 * `usage-by-purpose.mjs` reads (`OPEN_SCIENCE_DATABASE_URL`, then the
 * owner-only file named by `OPEN_SCIENCE_DATABASE_URL_FILE` or
 * `OPEN_SCIENCE_DATABASE_URL_HOST_FILE`, then `deploy/web/secrets/database-url.txt`).
 * The URL is never printed.
 */
import fs from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HAND_SEED = path.join(repoRoot, "apps/server/src/frontierGlossarySeed.json");
/** Where the NMPA drug list sits inside the pharmacy base data. */
const NMPA_DRUG_LIST = /^截至\d{8}药监局全部药品列表.*\.xlsx$/;
const KINDS = new Set(["drug", "disease", "org", "trial", "method", "other"]);

/**
 * @typedef {{ kind: string, en: string, zh: string, keep?: boolean, origin: string }} SeedRow
 */

// ───────────────────────── a streaming xlsx reader ─────────────────────────

/**
 * The entries of a zip file, read from its central directory.
 * @param {import("node:fs/promises").FileHandle} handle
 * @returns {Promise<Map<string, { method: number, compressedSize: number, offset: number }>>}
 */
export async function zipDirectory(handle) {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, 65_557);
  const tail = Buffer.alloc(tailLength);
  await handle.read(tail, 0, tailLength, size - tailLength);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file (no end of central directory)");
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (directoryOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  const directory = Buffer.alloc(directorySize);
  await handle.read(directory, 0, directorySize, directoryOffset);
  /** @type {Map<string, { method: number, compressedSize: number, offset: number }>} */
  const entries = new Map();
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = directory.readUInt16LE(at + 10);
    const compressedSize = directory.readUInt32LE(at + 20);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const offset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    entries.set(name, { method, compressedSize, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes, decompressed, as a stream.
 * @param {string} file @param {import("node:fs/promises").FileHandle} handle
 * @param {{ method: number, compressedSize: number, offset: number }} entry
 * @returns {Promise<NodeJS.ReadableStream>}
 */
async function zipEntryStream(file, handle, entry) {
  const header = Buffer.alloc(30);
  await handle.read(header, 0, 30, entry.offset);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("corrupt zip local header");
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`zip method ${entry.method} is not supported`);
  return raw.pipe(zlib.createInflateRaw());
}

/** @param {NodeJS.ReadableStream} stream @returns {Promise<string>} */
async function streamText(stream) {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of stream) text += decoder.write(/** @type {Buffer} */ (chunk));
  return text + decoder.end();
}

/** @param {string} text */
export function xmlText(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_all, hex, decimal, name) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number(decimal));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[String(name).toLowerCase()] ?? "";
  });
}

/**
 * The shared-string table: each `<si>`'s text runs joined, phonetic runs
 * (`<rPh>`) left out.
 * @param {string} xml @returns {string[]}
 */
export function parseSharedStrings(xml) {
  const strings = [];
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const body = match[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    strings.push([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((run) => xmlText(run[1])).join(""));
  }
  return strings;
}

/** `AM` → 38 (zero-based). @param {string} letters */
export function columnIndex(letters) {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * One `<row>`'s cells as text, by zero-based column.
 * @param {string} rowXml @param {string[]} shared @returns {string[]}
 */
export function parseRow(rowXml, shared) {
  /** @type {string[]} */
  const cells = [];
  let next = 0;
  for (const match of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attributes = match[1];
    const body = match[2] ?? "";
    const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
    const column = reference ? columnIndex(reference) : next;
    next = column + 1;
    const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? "n";
    let value = "";
    if (type === "inlineStr") value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((run) => xmlText(run[1])).join("");
    else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (raw !== undefined) value = type === "s" ? (shared[Number(raw)] ?? "") : xmlText(raw);
    }
    cells[column] = value;
  }
  return cells;
}

/**
 * The rows of a workbook's first sheet, streamed.
 * @param {string} file
 * @returns {AsyncGenerator<string[]>}
 */
export async function* xlsxRows(file) {
  const handle = await open(file, "r");
  try {
    const entries = await zipDirectory(handle);
    const read = async (/** @type {string} */ name) => {
      const entry = entries.get(name);
      return entry ? streamText(await zipEntryStream(file, handle, entry)) : "";
    };
    const workbook = await read("xl/workbook.xml");
    const relations = await read("xl/_rels/workbook.xml.rels");
    const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
    const target = firstSheet ? new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet}"[^>]*\\bTarget="([^"]+)"`).exec(relations)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheet}"`).exec(relations)?.[1] : null;
    const sheetName = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
    const shared = parseSharedStrings(await read("xl/sharedStrings.xml"));
    const sheet = entries.get(sheetName);
    if (!sheet) throw new Error(`the workbook has no ${sheetName}`);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    for await (const chunk of await zipEntryStream(file, handle, sheet)) {
      buffer += decoder.write(/** @type {Buffer} */ (chunk));
      let close = buffer.indexOf("</row>");
      while (close >= 0) {
        const open = buffer.lastIndexOf("<row", close);
        yield parseRow(buffer.slice(open, close), shared);
        buffer = buffer.slice(close + 6);
        close = buffer.indexOf("</row>");
      }
    }
  } finally {
    await handle.close();
  }
}

// ───────────────────────── the rows ─────────────────────────

/**
 * Substance pairs from the NMPA drug list's rows: the level-5 English and
 * Chinese names of every chemical or biological product (「西药」). One row
 * per English name, lower-cased; the Chinese name most products carry wins
 * (ties: the shorter, then the first in code-point order).
 * @param {AsyncIterable<string[]> | Iterable<string[]>} rows the sheet's rows, header first
 * @returns {Promise<SeedRow[]>}
 */
export async function drugRowsFromNmpaList(rows) {
  /** @type {Map<string, Map<string, number>>} */
  const counts = new Map();
  /** @type {Record<string, number> | null} */
  let columns = null;
  for await (const cells of rows) {
    if (!columns) {
      const at = (/** @type {string} */ name) => cells.findIndex((cell) => String(cell ?? "").trim() === name);
      columns = { en: at("五级英文"), zh: at("五级中文"), type: at("药品类型") };
      if (columns.en < 0 || columns.zh < 0) throw new Error("the NMPA drug list has no 五级英文 / 五级中文 columns");
      continue;
    }
    if (columns.type >= 0 && String(cells[columns.type] ?? "").trim() !== "西药") continue;
    const en = String(cells[columns.en] ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const zh = String(cells[columns.zh] ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
    if (!/^[a-z][a-z0-9 ,'()/-]{2,119}$/.test(en) || !/[\u4e00-\u9fff]/.test(zh) || [...zh].length < 2 || zh.length > 60) continue;
    if (/\band\b|^compound\b|,/.test(en)) continue;
    const byZh = counts.get(en) ?? new Map();
    byZh.set(zh, (byZh.get(zh) ?? 0) + 1);
    counts.set(en, byZh);
  }
  return [...counts].map(([en, byZh]) => {
    const [zh] = [...byZh].sort((left, right) => right[1] - left[1] || [...left[0]].length - [...right[0]].length
      || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))[0];
    return { kind: "drug", en, zh, origin: "nmpa-drug-list" };
  }).sort((left, right) => (left.en < right.en ? -1 : left.en > right.en ? 1 : 0));
}

/**
 * The committed hand-kept rows, checked.
 * @param {string} [file]
 * @returns {Promise<SeedRow[]>}
 */
export async function handRows(file = HAND_SEED) {
  const seed = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(seed?.entries)) throw new Error("the hand-kept glossary has no entries array");
  return seed.entries.map((/** @type {any} */ entry, /** @type {number} */ index) => {
    const keep = entry.keep === true;
    const row = { kind: String(entry.kind), en: String(entry.en ?? "").trim(), zh: keep ? String(entry.en ?? "").trim() : String(entry.zh ?? "").trim(), keep, origin: "hand" };
    if (!KINDS.has(row.kind) || row.en.length < 2 || row.en.length > 200 || !row.zh) {
      throw new Error(`hand-kept glossary entry ${index} is invalid`);
    }
    return row;
  });
}

/**
 * Hand-kept and generated rows as one list: one row per (kind, lower-cased
 * English), the hand-kept row first and winning.
 * @param {SeedRow[]} hand @param {SeedRow[]} generated @returns {SeedRow[]}
 */
export function mergeRows(hand, generated) {
  /** @type {Map<string, SeedRow>} */
  const rows = new Map();
  for (const row of [...hand, ...generated]) {
    const id = `${row.kind}\u0000${row.en.toLowerCase()}`;
    if (!rows.has(id)) rows.set(id, row);
  }
  return [...rows.values()];
}

/**
 * Write the rows into `evimed_frontier.glossary`. A generated row never
 * replaces a hand-kept one; a hand-kept row replaces anything.
 * @param {any} database a ControlPlaneDatabase
 * @param {SeedRow[]} rows
 * @returns {Promise<{ written: number }>}
 */
export async function applyRows(database, rows) {
  let written = 0;
  for (let at = 0; at < rows.length; at += 500) {
    const batch = rows.slice(at, at + 500);
    const result = await database.query(`INSERT INTO evimed_frontier.glossary (kind, term_en, term_zh, keep_original, origin, updated_at)
      SELECT * , clock_timestamp() FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $5::text[])
      ON CONFLICT (kind, term_en) DO UPDATE SET term_zh = excluded.term_zh, keep_original = excluded.keep_original,
        origin = excluded.origin, updated_at = excluded.updated_at
      WHERE (evimed_frontier.glossary.origin <> 'hand' OR excluded.origin = 'hand')
        AND (evimed_frontier.glossary.term_zh, evimed_frontier.glossary.keep_original, evimed_frontier.glossary.origin)
          IS DISTINCT FROM (excluded.term_zh, excluded.keep_original, excluded.origin)`,
    [batch.map((row) => row.kind), batch.map((row) => row.en), batch.map((row) => row.zh),
      batch.map((row) => row.keep === true), batch.map((row) => row.origin)]);
    written += result.rowCount ?? 0;
  }
  return { written };
}

// ───────────────────────── the command ─────────────────────────

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{ dataDir: string | null, from: string | null, out: string | null, apply: boolean }} */
  const options = { dataDir: null, from: null, out: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} needs a path`);
      index += 1;
      return next;
    };
    if (argument === "--data-dir") options.dataDir = value();
    else if (argument === "--from") options.from = value();
    else if (argument === "--out") options.out = value();
    else if (argument === "--apply") options.apply = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (options.dataDir && options.from) throw new Error("give --data-dir or --from, not both");
  return options;
}

/** @param {string} dataDir @returns {string} */
function nmpaDrugList(dataDir) {
  const folder = path.join(dataDir, "药学相关资料");
  const names = fs.readdirSync(folder).filter((name) => NMPA_DRUG_LIST.test(name)).sort();
  if (!names.length) throw new Error(`no NMPA drug list (${NMPA_DRUG_LIST}) under ${folder}`);
  return path.join(folder, names.at(-1) ?? "");
}

function databaseUrl() {
  const named = process.env.DATABASE_URL || process.env.OPEN_SCIENCE_DATABASE_URL;
  if (named) return named;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

/** @param {SeedRow[]} rows */
function summary(rows) {
  /** @type {Record<string, number>} */
  const byKind = {};
  /** @type {Record<string, number>} */
  const byOrigin = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byOrigin[row.origin] = (byOrigin[row.origin] ?? 0) + 1;
  }
  return { rows: rows.length, byKind, byOrigin };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let rows;
  if (options.from) {
    const saved = JSON.parse(await readFile(options.from, "utf8"));
    rows = mergeRows(await handRows(), Array.isArray(saved?.rows) ? saved.rows.filter((/** @type {any} */ row) => row?.origin !== "hand") : []);
  } else {
    const generated = options.dataDir ? await drugRowsFromNmpaList(xlsxRows(nmpaDrugList(options.dataDir))) : [];
    rows = mergeRows(await handRows(), generated);
  }
  if (options.out) await writeFile(options.out, `${JSON.stringify({ builtAt: new Date().toISOString(), rows }, null, 1)}\n`);
  let applied = null;
  if (options.apply) {
    const { ControlPlaneDatabase } = await import("../../apps/server/src/controlPlaneDatabase.mjs");
    const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
    try {
      // The schema is the server's to create (with the embedding width it runs
      // with); migrating it from here with a guessed width would empty the
      // vectors. A deployment that never enabled the module has no table yet.
      const table = await database.query("SELECT to_regclass('evimed_frontier.glossary') AS name");
      if (!table.rows[0]?.name) throw new Error("evimed_frontier.glossary does not exist yet: enable the frontier module and start the server once");
      applied = await applyRows(database, rows);
    } finally {
      await database.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary(rows), out: options.out, applied })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`seed_frontier_glossary_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
