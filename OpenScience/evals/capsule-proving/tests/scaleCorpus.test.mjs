import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TYPE_WEIGHTS, buildScaleCorpus } from '../synthetic/scaleCorpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'synthetic', 'scaleCorpus.mjs');

/** A fresh temp dir that is removed when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scale-corpus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An async line stream, the shape the CLI hands to `buildScaleCorpus`. */
async function* linesOf(rows) {
  for (const row of rows) yield row;
}

/** N unique statements, each comfortably inside the length filter. */
function uniqueRows(n, source = 'generated') {
  return Array.from({ length: n }, (_, i) => ({ source, text: `Generated statement number ${i} for the reservoir check.` }));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('splitting uses every listed mark and newlines; trimming and the 8–200 character filter are applied', async () => {
  const exactly200 = 'y'.repeat(200);
  const tooLong = 'z'.repeat(201);
  const text = [
    'Alpha beta gamma. Delta epsilon zeta! Eta theta iota? Iota kappa lambda; Mu nu xi。',
    'Omicron pi rho\nSigma tau upsilon',
    'short',
    exactly200,
    tooLong,
    '12345678 !!!',
  ].join('\n');

  const corpus = await buildScaleCorpus({
    seed: 'split',
    sizes: [100],
    lines: linesOf([{ source: 'fixture', text }]),
  });

  assert.deepEqual(corpus.sizes[100].map((item) => item.text), [
    'Alpha beta gamma',
    'Delta epsilon zeta',
    'Eta theta iota',
    'Iota kappa lambda',
    'Mu nu xi',
    'Omicron pi rho',
    'Sigma tau upsilon',
    exactly200,
  ]);
  assert.equal(corpus.stats.linesRead, 1);
  assert.equal(corpus.stats.statements, 8);
  assert.equal(corpus.stats.kept, 8);
  assert.equal(corpus.stats.duplicates, 0);
  assert.equal(corpus.stats.short, true);
});

test('deduplication ignores case, whitespace and punctuation but not different words', async () => {
  const corpus = await buildScaleCorpus({
    seed: 'dedupe',
    sizes: [10],
    lines: linesOf([
      { source: 'a', text: 'Alpha beta gamma delta.' },
      { source: 'b', text: 'alpha   BETA gamma delta!' },
      { source: 'a', text: 'Another completely different line.' },
    ]),
  });

  assert.equal(corpus.sizes[10].length, 2);
  assert.deepEqual(corpus.sizes[10].map((item) => item.text), [
    'Alpha beta gamma delta.',
    'Another completely different line.',
  ]);
  assert.equal(corpus.stats.statements, 3);
  assert.equal(corpus.stats.kept, 2);
  assert.equal(corpus.stats.duplicates, 1);
  assert.deepEqual(corpus.stats.bySource, { a: 2 });
});

test('the 1k corpus is a prefix of the 10k corpus and ids are assigned once in sample order', async () => {
  const lines = uniqueRows(12_000);
  const corpus = await buildScaleCorpus({ seed: 'nested', sizes: [1000, 10_000], lines: linesOf(lines) });

  assert.equal(corpus.sizes[1000].length, 1000);
  assert.equal(corpus.sizes[10_000].length, 10_000);
  assert.deepEqual(corpus.sizes[1000], corpus.sizes[10_000].slice(0, 1000));
  assert.deepEqual(corpus.sizes[1000].map((item) => item.id), Array.from({ length: 1000 }, (_, i) => `m${String(i + 1).padStart(6, '0')}`));
  assert.equal(corpus.stats.kept, 12_000);
  assert.equal(corpus.stats.short, false);
});

test('the same seed is identical and a different seed changes the sample and types', async () => {
  const rows = uniqueRows(500);
  const a = await buildScaleCorpus({ seed: 'same', sizes: [100], lines: linesOf(rows) });
  const b = await buildScaleCorpus({ seed: 'same', sizes: [100], lines: linesOf(rows) });
  const c = await buildScaleCorpus({ seed: 'other', sizes: [100], lines: linesOf(rows) });

  assert.deepEqual(a, b);
  assert.notDeepEqual(a.sizes[100], c.sizes[100]);
  assert.equal(a.sizes[100].length, 100);
});

test('short sizes hold every unique statement once, are never padded, and are named in the stats', async () => {
  const rows = [
    { source: 'x', text: 'First statement is long enough.' },
    { source: 'x', text: 'Second statement is long enough.' },
    { source: 'y', text: 'Third statement is long enough.' },
  ];
  const short = await buildScaleCorpus({ seed: 'short', sizes: [2, 5, 10], lines: linesOf(rows) });
  assert.equal(short.sizes[2].length, 2);
  assert.equal(short.sizes[5].length, 3);
  assert.equal(short.sizes[10].length, 3);
  assert.equal(short.stats.kept, 3);
  assert.equal(short.stats.short, true);
  assert.deepEqual(short.stats.shortSizes, [5, 10]);
  assert.equal(new Set(short.sizes[10].map((item) => item.text)).size, 3);

  const complete = await buildScaleCorpus({ seed: 'short', sizes: [2], lines: linesOf(rows) });
  assert.equal(complete.stats.short, false);
  assert.deepEqual(complete.stats.shortSizes, []);
});

test('a 50,000-line input keeps only the requested reservoir, not the input', async () => {
  const corpus = await buildScaleCorpus({ seed: 'bounded', sizes: [1000], lines: linesOf(uniqueRows(50_000)) });

  assert.equal(corpus.stats.linesRead, 50_000);
  assert.equal(corpus.stats.kept, 50_000);
  assert.equal(corpus.stats.duplicates, 0);
  assert.equal(corpus.sizes[1000].length, 1000);
  assert.equal(new Set(corpus.sizes[1000].map((item) => item.text)).size, 1000);
});

test('the type distribution is within 5 percentage points of the weights on 10,000 items', async () => {
  const corpus = await buildScaleCorpus({ seed: 'types', sizes: [10_000], lines: linesOf(uniqueRows(10_000)) });
  const items = corpus.sizes[10_000];
  assert.equal(items.length, 10_000);

  const counts = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  for (const [type, weight] of TYPE_WEIGHTS) {
    const share = (counts[type] ?? 0) / items.length;
    assert.ok(Math.abs(share - weight) <= 0.05, `${type}: ${share} is not within 0.05 of ${weight}`);
  }
  assert.deepEqual(new Set(items.map((item) => item.type)), new Set(TYPE_WEIGHTS.map(([type]) => type)));
});

test('the CLI writes size files and a manifest with streamed input and output hashes, printing only stats', async (t) => {
  const dir = tempDir(t);
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  const body = (source, start, n) => Array.from(
    { length: n },
    (_, i) => JSON.stringify({ source, text: `CLI statement number ${start + i} from ${source}.` }),
  ).join('\n') + '\n';
  writeFileSync(a, body('alpha', 0, 15));
  writeFileSync(b, body('beta', 100, 15));
  const out = join(dir, 'out');

  const run = spawnSync(process.execPath, [
    CLI, '--texts', `${a},${b}`, '--seed', 'cli-seed', '--out', out, '--sizes', '10,20',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');

  const stdout = run.stdout.trim();
  assert.equal(stdout.split('\n').length, 1);
  const printed = JSON.parse(stdout);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));

  assert.deepEqual(printed, manifest.stats);
  assert.equal(manifest.seed, 'cli-seed');
  assert.deepEqual(manifest.sizes, [10, 20]);
  assert.equal(manifest.stats.linesRead, 30);
  assert.equal(manifest.stats.kept, 30);
  assert.equal(manifest.stats.short, false);
  assert.deepEqual(manifest.stats.shortSizes, []);
  assert.equal(manifest.inputs.length, 2);
  for (const [input, file] of [[manifest.inputs[0], a], [manifest.inputs[1], b]]) {
    assert.equal(input.file, file);
    assert.equal(input.sha256, sha256(readFileSync(file)));
  }

  const ten = readJsonl(join(out, 'scale-10.jsonl'));
  const twenty = readJsonl(join(out, 'scale-20.jsonl'));
  assert.equal(ten.length, 10);
  assert.equal(twenty.length, 20);
  assert.deepEqual(ten, twenty.slice(0, 10));
  for (const item of twenty) {
    assert.deepEqual(Object.keys(item), ['id', 'type', 'text', 'source']);
    assert.match(item.id, /^m\d{6}$/);
  }
  assert.deepEqual(Object.keys(manifest.sha256).sort(), ['scale-10.jsonl', 'scale-20.jsonl']);
  for (const name of Object.keys(manifest.sha256)) {
    assert.equal(manifest.sha256[name], sha256(readFileSync(join(out, name))));
  }
});
