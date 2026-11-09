#!/usr/bin/env node
/**
 * Check a prepared data directory before a run: every manifest's recorded sha256 against the file beside it, and, for the
 * synthetic users, that no question shown at run time already contains the answer its gold expects. Prints counts only, so
 * it is safe over sealed data.
 *
 *   node verify-data.mjs --data /path/to/memdata-data [--json out.json]
 * Exit 1 when a hash differs, a manifest names a missing file, or a question leaks its answer.
 * @module capsule-proving/verify-data
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP = new Set(['public', 'claims', 'node_modules', '_old', 'work']);

function* manifests(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* manifests(p);
    else if (name === 'manifest.json') yield p;
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The `{ file: sha256 }` map a manifest records, wherever it keeps it. */
export function hashMap(manifest) {
  for (const key of ['sha256', 'hashes', 'files']) {
    const v = manifest?.[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) return v;
  }
  return null;
}

/** Every object under `value` that `pred` accepts, depth first. */
function collect(value, pred, out = []) {
  if (Array.isArray(value)) for (const v of value) collect(v, pred, out);
  else if (value && typeof value === 'object') { if (pred(value)) out.push(value); for (const v of Object.values(value)) collect(v, pred, out); }
  return out;
}

/**
 * Questions whose runtime text already holds an anchor the gold expects in the answer: echoing the question would pass the
 * check. Questions are found by `qid` wherever a set keeps them (a user's `questions`, a scenario's or an item's own list).
 */
export function leaks(input, gold) {
  const text = new Map(collect(input, (o) => typeof o.qid === 'string' && typeof (o.text ?? o.question) === 'string').map((q) => [q.qid, String(q.text ?? q.question)]));
  const out = [];
  for (const q of collect(gold, (o) => typeof o.qid === 'string' && o.expect && typeof o.expect === 'object')) {
    const t = text.get(q.qid);
    if (t == null) continue;
    for (const a of q.expect?.mustContain ?? []) if (a && t.includes(a)) out.push(q.qid);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : argv[i + 1]; };
  const root = opt('data') ?? (() => { throw new Error('--data required'); })();
  const rows = [];
  let bad = 0;
  for (const m of manifests(root)) {
    const dir = dirname(m);
    const rel = relative(root, dir);
    let manifest;
    try { manifest = JSON.parse(readFileSync(m, 'utf8')); } catch { rows.push({ set: rel, problem: 'manifest unreadable' }); bad++; continue; }
    const map = hashMap(manifest);
    const row = { set: rel, files: 0, mismatched: [], missing: [], leaks: 0 };
    if (map) {
      for (const [file, want] of Object.entries(map)) {
        const p = join(dir, file);
        if (!existsSync(p)) { row.missing.push(file); continue; }
        row.files++;
        if (sha(p) !== want) row.mismatched.push(file);
      }
    } else row.note = 'no per-file hash map';
    if (existsSync(join(dir, 'input.json')) && existsSync(join(dir, 'gold.json'))) {
      try { row.leaks = leaks(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')), JSON.parse(readFileSync(join(dir, 'gold.json'), 'utf8'))).length; } catch { row.note = 'input/gold unreadable'; }
    }
    for (const k of ['questions', 'items', 'count', 'sessions', 'codeDecidable', 'storeChecks', 'corruptions']) if (typeof manifest[k] === 'number') row[k] = manifest[k];
    if (row.mismatched.length || row.missing.length || row.leaks) bad++;
    rows.push(row);
  }
  for (const r of rows) {
    const flags = [r.mismatched?.length ? `MISMATCH ${r.mismatched.join(',')}` : '', r.missing?.length ? `MISSING ${r.missing.join(',')}` : '', r.leaks ? `LEAKS ${r.leaks}` : '', r.problem ?? '', r.note ?? ''].filter(Boolean).join(' ');
    const counts = ['questions', 'items', 'count', 'sessions'].filter((k) => r[k] != null).map((k) => `${k}=${r[k]}`).join(' ');
    console.log(`${flags ? '✗' : '✓'} ${r.set}  files=${r.files ?? 0} ${counts} ${flags}`);
  }
  console.log(`${rows.length} manifests, ${bad} with problems`);
  if (opt('json')) writeFileSync(opt('json'), `${JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 1)}\n`);
  process.exitCode = bad ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
