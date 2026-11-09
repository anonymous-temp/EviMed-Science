#!/usr/bin/env node
/**
 * A scale corpus for latency and cost checks: statements streamed out of public chat datasets, deduplicated and sampled
 * with a fixed seed, so the same run at 1k, 10k and 100k memories is reproducible without holding the input in memory.
 *
 *   node synthetic/scaleCorpus.mjs --texts a.jsonl,b.jsonl --seed X --out DIR [--sizes 1000,10000,100000]
 *
 * The input files are read line by line; only the reservoir and the deduplication keys are retained. Output files are
 * named `scale-<size>.jsonl`; `manifest.json` records the seed, input and output sha256 values, and the build stats.
 *
 * @module capsule-proving/synthetic/scaleCorpus
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { rng } from './spec.mjs';

/** The sizes a scale run is reported at when `--sizes` is omitted. */
export const DEFAULT_SIZES = [1000, 10000, 100000];

/** Statement types and their sampling weights, in the order the seeded generator walks the cumulative weights. */
export const TYPE_WEIGHTS = [
  ['profile', 0.10],
  ['preferences', 0.20],
  ['entities', 0.30],
  ['events', 0.30],
  ['cases', 0.10],
];

const DEFAULT_SEED = 'scale-corpus-v1';
const MIN_CHARS = 8;
const MAX_CHARS = 200;

// A statement ends at one of the listed CJK/ASCII marks, at a newline, or at a period followed by whitespace.
const STATEMENT_SEPARATOR = /[。！？!?；;\r\n]|\.\s/u;
// Any Unicode letter covers ASCII and the CJK ideographs; punctuation-only fragments are dropped.
const LETTER_OR_CJK = /\p{L}/u;

/** Split one message into raw statement fragments; trimming and filtering happen in `buildScaleCorpus`. */
function splitStatements(text) {
  return String(text ?? '').split(STATEMENT_SEPARATOR);
}

/** The deduplication key: lower-case, every Unicode punctuation mark removed, then whitespace collapsed. */
function normalizeKey(statement) {
  return statement
    .toLowerCase()
    .replace(/\p{P}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Draw a type from the seeded generator using `TYPE_WEIGHTS`; the last bucket catches floating-point residue. */
function drawType(random) {
  const x = random();
  let cumulative = 0;
  for (const [type, weight] of TYPE_WEIGHTS) {
    cumulative += weight;
    if (x < cumulative) return type;
  }
  return TYPE_WEIGHTS.at(-1)[0];
}

/** The canonical size list: positive integers, ascending, without duplicates. */
function normalizeSizes(sizes) {
  const wanted = [...new Set((sizes ?? DEFAULT_SIZES).map(Number))].sort((a, b) => a - b);
  if (!wanted.length || wanted.some((size) => !Number.isInteger(size) || size <= 0)) {
    throw new TypeError('sizes must be a non-empty list of positive integers');
  }
  return wanted;
}

/**
 * Build the nested scale corpora from an async line stream. The reservoir is capped at `max(sizes)`, so a long input is
 * never materialized; each requested size is then a prefix of the sampled list. A size shorter than the number of unique
 * statements holds what exists, is never padded, and is reported in `stats.shortSizes` (and `stats.short`).
 * @param {{ seed?: string, sizes?: number[], lines: AsyncIterable<{ source?: string, text?: string }> | Iterable<{ source?: string, text?: string }> }} options
 * @returns {Promise<{ sizes: Record<number, { id: string, type: string, text: string, source: string }[]>, stats: { linesRead: number, statements: number, kept: number, duplicates: number, bySource: Record<string, number>, short: boolean, shortSizes: number[] } }>}
 */
export async function buildScaleCorpus({ seed, sizes = DEFAULT_SIZES, lines } = {}) {
  if (!lines || typeof lines[Symbol.asyncIterator] !== 'function' && typeof lines[Symbol.iterator] !== 'function') {
    throw new TypeError('lines must be an async iterable of { source, text }');
  }
  const wanted = normalizeSizes(sizes);
  const capacity = wanted.at(-1);
  const random = rng(seed == null ? DEFAULT_SEED : String(seed));

  let linesRead = 0;
  let statements = 0;
  let duplicates = 0;
  let kept = 0;
  const bySource = {};
  const seen = new Set();
  const reservoir = [];

  for await (const line of lines) {
    linesRead++;
    const source = typeof line?.source === 'string' && line.source.length ? line.source : 'unknown';
    for (const fragment of splitStatements(line?.text)) {
      const statement = fragment.trim();
      if (statement.length < MIN_CHARS || statement.length > MAX_CHARS) continue;
      if (!LETTER_OR_CJK.test(statement)) continue;
      statements++;

      const key = normalizeKey(statement);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      kept++;
      bySource[source] = (bySource[source] ?? 0) + 1;

      // Reservoir sampling: item `kept` replaces a random slot only while a slot is available.
      if (reservoir.length < capacity) reservoir.push({ text: statement, source });
      else {
        const slot = Math.floor(random() * kept);
        if (slot < capacity) reservoir[slot] = { text: statement, source };
      }
    }
  }

  const sampled = reservoir.map((item, index) => ({
    id: `m${String(index + 1).padStart(6, '0')}`,
    type: drawType(random),
    text: item.text,
    source: item.source,
  }));

  const out = {};
  for (const size of wanted) out[size] = sampled.slice(0, size);

  const shortSizes = wanted.filter((size) => kept < size);
  return {
    sizes: out,
    stats: { linesRead, statements, kept, duplicates, bySource, short: shortSizes.length > 0, shortSizes },
  };
}

/** Stream a file through sha256 without reading it whole. */
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Yield `{ source, text }` for every non-empty JSONL line, one readline interface per file. */
async function* readTexts(files) {
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const raw of rl) {
        const line = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch (error) {
          throw new Error(`${file}: not valid JSON: ${error.message}`);
        }
        yield { source: row?.source, text: row?.text };
      }
    } finally {
      rl.close();
    }
  }
}

/** Parse `--key value` pairs; a flag without a value becomes the string `true`. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[arg.slice(2)] = 'true';
    else { out[arg.slice(2)] = next; i++; }
  }
  return out;
}

/** CLI entry: stream the inputs, write the size files and the manifest, then print only the stats. */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.texts) throw new Error('--texts a.jsonl,b.jsonl is required');
  if (!args.out) throw new Error('--out dir is required');
  const files = String(args.texts).split(',').map((file) => file.trim()).filter(Boolean);
  if (!files.length) throw new Error('--texts has no file names');
  const seed = args.seed ?? DEFAULT_SEED;
  const sizes = args.sizes
    ? String(args.sizes).split(',').map((size) => Number(size.trim())).filter((size) => Number.isFinite(size))
    : DEFAULT_SIZES;

  const outDir = args.out;
  mkdirSync(outDir, { recursive: true });

  const corpus = await buildScaleCorpus({ seed, sizes, lines: readTexts(files) });

  const sha256 = {};
  for (const size of Object.keys(corpus.sizes).map(Number)) {
    const name = `scale-${size}.jsonl`;
    const items = corpus.sizes[size];
    const body = items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
    writeFileSync(join(outDir, name), body);
    sha256[name] = createHash('sha256').update(body).digest('hex');
  }

  const inputs = [];
  for (const file of files) inputs.push({ file, sha256: await hashFile(file) });

  const manifest = { seed, sizes: Object.keys(corpus.sizes).map(Number), inputs, stats: corpus.stats, sha256 };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify(corpus.stats)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
