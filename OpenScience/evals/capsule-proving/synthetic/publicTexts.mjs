#!/usr/bin/env node
/**
 * User turns of the public sets as `{ source, text }` lines, the input of `scaleCorpus.mjs` (G13). Real people's or the
 * benchmarks' own words, so the scale corpus needs no generated text. Reads `.jsonl` and `.jsonl.gz` line by line and a
 * `.json` file whole (at most 64 MB); a turn is user-spoken when it carries `role: "user"` or a speaker named `user`, or a
 * LoCoMo-style `speaker` + `text` pair (both LoCoMo speakers are people). WildChat rows flagged toxic are skipped.
 *
 *   node synthetic/publicTexts.mjs --out texts.jsonl name=path[,path…] [name=path…]
 * @module capsule-proving/synthetic/publicTexts
 */
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** Every user-spoken string in a parsed value, depth first. */
export function* userTurns(value) {
  if (Array.isArray(value)) { for (const v of value) yield* userTurns(v); return; }
  if (!value || typeof value !== 'object') return;
  if (value.toxic === true) return;
  const said = typeof value.content === 'string' ? value.content : typeof value.text === 'string' ? value.text : null;
  const role = typeof value.role === 'string' ? value.role.toLowerCase() : null;
  const speaker = typeof value.speaker === 'string' ? value.speaker.toLowerCase() : null;
  if (said != null && (role === 'user' || speaker === 'user' || (role == null && speaker != null && speaker !== 'assistant' && typeof value.text === 'string'))) {
    yield said;
    return;
  }
  for (const v of Object.values(value)) if (v && typeof v === 'object') yield* userTurns(v);
}

/** One JSONL line. U+2028 and U+2029 are escaped: JSON allows them raw, but Node's readline splits lines on them. */
export const jsonLine = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

async function* linesOf(path) {
  const stream = path.endsWith('.gz') ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line.trim()) yield line;
}

/** @param {string} source @param {string} path */
export async function* textsOfFile(source, path) {
  if (/\.jsonl(\.gz)?$/.test(path)) {
    for await (const line of linesOf(path)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      for (const text of userTurns(row)) yield { source, text };
    }
    return;
  }
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`${path}: a .json file over ${MAX_JSON_BYTES} bytes; convert it to .jsonl first`);
  for (const text of userTurns(JSON.parse(readFileSync(path, 'utf8')))) yield { source, text };
}

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  if (outAt < 0) throw new Error('--out required');
  const out = createWriteStream(argv[outAt + 1]);
  const specs = argv.filter((a, i) => i !== outAt && i !== outAt + 1);
  const counts = {};
  for (const spec of specs) {
    const [source, list] = spec.split('=');
    for (const path of list.split(',')) {
      for await (const row of textsOfFile(source, path)) {
        if (!out.write(`${jsonLine(row)}\n`)) await new Promise((r) => out.once('drain', r));
        counts[source] = (counts[source] ?? 0) + 1;
      }
    }
  }
  await new Promise((r) => out.end(r));
  console.log(JSON.stringify(counts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
