#!/usr/bin/env node
/**
 * Plan L6: real Chinese follow-ups for the learning loop's follow-up judge. From WildChat's Chinese conversations, every
 * user message that answers an assistant reply is a candidate — the situation the judge reads in production (the person's
 * next message after a run). A seeded reservoir sample keeps the draw unbiased by wording: no keyword decides what is a
 * correction; the labels come later, from people and from Claude, in the judge's own label set.
 *
 *   node l6-candidates.mjs --out DIR --count 1000 shard.zh.jsonl.gz[,…]
 * → DIR/candidates.jsonl ({ id, request, reply, followUp, turnIndex, source }), DIR/manifest.json
 * @module capsule-proving/l6-candidates
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rng } from './synthetic/spec.mjs';

const REPLY_CHARS = 1200;
const REQUEST_CHARS = 600;
const HAN = /\p{Script=Han}/u;

/** The follow-ups of one conversation: each user turn after an assistant turn, with the request and reply it follows. */
export function followUps(turns) {
  const out = [];
  for (let i = 2; i < (turns?.length ?? 0); i++) {
    const [req, rep, next] = [turns[i - 2], turns[i - 1], turns[i]];
    if (req?.role !== 'user' || rep?.role !== 'assistant' || next?.role !== 'user') continue;
    const followUp = String(next.text ?? '').trim();
    if (!followUp || !HAN.test(followUp) || followUp.length > 400) continue;
    out.push({ request: String(req.text ?? '').slice(0, REQUEST_CHARS), reply: String(rep.text ?? '').slice(0, REPLY_CHARS), followUp, turnIndex: i });
  }
  return out;
}

/** Reservoir sampling (algorithm R) over an async iterable, seeded. */
export async function reservoir(items, k, seed) {
  const r = rng(seed);
  const kept = [];
  let n = 0;
  for await (const item of items) {
    n++;
    if (kept.length < k) kept.push(item);
    else { const j = Math.floor(r() * n); if (j < k) kept[j] = item; }
  }
  return { kept, seen: n };
}

async function* candidatesOf(paths) {
  for (const path of paths) {
    const input = createReadStream(path).pipe(createGunzip());
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.toxic === true) continue;
      for (const f of followUps(row.turns)) yield { source: `${basename(path)}#${row.hash ?? ''}`, ...f };
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
  const out = opt('out');
  if (!out) throw new Error('--out required');
  const count = Number(opt('count', 1000));
  const seed = opt('seed', 'capsule-proving-20261109-v1:l6');
  const paths = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).flatMap((a) => a.split(','));
  const { kept, seen } = await reservoir(candidatesOf(paths), count, seed);
  const rows = kept.map((x, i) => ({ id: `l6-${String(i + 1).padStart(4, '0')}`, ...x }));
  mkdirSync(out, { recursive: true });
  const body = rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
  writeFileSync(join(out, 'candidates.jsonl'), body);
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ schema: 'capsule-proving-l6-candidates/1', seed, count: rows.length, followUpsSeen: seen, shards: paths.map((p) => basename(p)), sha256: { 'candidates.jsonl': createHash('sha256').update(body).digest('hex') } }, null, 1)}\n`);
  console.log(`${rows.length} candidates from ${seen} follow-ups`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
