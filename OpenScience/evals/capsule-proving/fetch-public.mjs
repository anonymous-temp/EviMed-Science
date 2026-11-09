#!/usr/bin/env node
/**
 * Download every file pinned in sources.json and verify its sha256. Files that
 * are already present and verified are skipped, so a rerun resumes.
 *
 *   node evals/capsule-proving/fetch-public.mjs --out DIR [--only locomo,realmem,...] [--large] [--list]
 *
 * Layout: DIR/<set>/<pinned path>. Sets: longmemeval, medmemorybench-github
 * (the two older pins) and every key of sources.json `public` and `learning`. Without --large
 * the large files are left out: LongMemEval-S (277 MB), MedMemoryBench
 * dialogues, HaluMem Long and the WildChat parquet files. Nothing is trusted
 * before its digest matches; a mismatch deletes the partial file and fails.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'evimed-eval-intake';
const HERE = dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).reduce((out, arg, i, all) => (arg.startsWith('--') ? [...out, [arg.slice(2), all[i + 1] == null || all[i + 1].startsWith('--') ? 'true' : all[i + 1]]] : out), []));

/** [{ set, path, url, sha256, bytes, large }] for every pinned file. */
export function plan(manifest) {
  const entries = [];
  const lm = manifest.longmemeval;
  entries.push({ set: 'longmemeval', path: 'longmemeval_s_cleaned.json', url: lm.url, sha256: lm.sha256, bytes: lm.bytes, large: true });
  for (const file of manifest.medical.files) {
    entries.push({ set: 'medmemorybench-github', path: file.path, url: file.url, sha256: file.sha256, bytes: file.bytes, large: file.path.endsWith('generated_dialogues.json') });
  }
  // `learning` sets (2026-11-09): large files that were pinned and never downloaded carry only the git blob sha1 of their commit or revision.
  for (const [set, info] of [...Object.entries(manifest.public ?? {}), ...Object.entries(manifest.learning ?? {})]) {
    for (const file of info.files) entries.push({ set, path: file.path, url: file.url, sha256: file.sha256, gitBlobSha1: file.gitBlobSha1, bytes: file.bytes, large: file.large === true });
  }
  const seen = new Set();
  for (let i = entries.length - 1; i >= 0; i -= 1) { // a `learning` entry supersedes a `public` one with the same set and path (cl-bench)
    const key = `${entries[i].set}\0${entries[i].path}`;
    if (seen.has(key)) entries.splice(i, 1); else seen.add(key);
  }
  for (const entry of entries) {
    const hasSha = /^[a-f0-9]{64}$/.test(entry.sha256 ?? '');
    if (!hasSha && !(entry.large && /^[a-f0-9]{40}$/.test(entry.gitBlobSha1 ?? ''))) throw new Error(`${entry.set}/${entry.path} has no pinned sha256`);
  }
  return entries;
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function gitBlobSha1Of(path) {
  const hash = createHash('sha1');
  hash.update(`blob ${statSync(path).size}\0`);
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function matches(path, entry) {
  if (statSync(path).size !== entry.bytes) return false;
  return entry.sha256 ? await sha256Of(path) === entry.sha256 : await gitBlobSha1Of(path) === entry.gitBlobSha1;
}

async function verified(path, entry) {
  return existsSync(path) && await matches(path, entry);
}

async function download(entry, path) {
  const part = `${path}.part`;
  mkdirSync(dirname(path), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(entry.url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      if (!await matches(part, entry)) throw new Error('size or digest does not match the pin');
      renameSync(part, path);
      return;
    } catch (error) {
      lastError = error;
      rmSync(part, { force: true });
      if (attempt < 4) await new Promise(done => setTimeout(done, 2000 * attempt));
    }
  }
  throw new Error(`${entry.set}/${entry.path}: ${lastError.message}`);
}

async function main() {
  if (!args.out) { console.error('usage: fetch-public.mjs --out DIR [--only set,set] [--large] [--list]'); process.exit(2); }
  const out = resolve(args.out);
  const known = new Set(plan(sources).map(entry => entry.set));
  const only = args.only ? args.only.split(',') : null;
  for (const set of only ?? []) if (!known.has(set)) { console.error(`unknown set ${set}; known: ${[...known].join(', ')}`); process.exit(2); }
  const chosen = plan(sources).filter(entry => (!only || only.includes(entry.set)) && (args.large === 'true' || !entry.large));
  const total = chosen.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`${chosen.length} files, ${(total / 1e6).toFixed(1)} MB${args.large === 'true' ? ' (large included)' : ''}`);
  if (args.list === 'true') { for (const entry of chosen) console.log(entry.set, entry.path, entry.bytes); return; }
  let fetched = 0; let skipped = 0;
  for (const entry of chosen) {
    const path = join(out, entry.set, entry.path);
    if (await verified(path, entry)) { skipped += 1; continue; }
    await download(entry, path);
    fetched += 1;
    console.log(`fetched ${entry.set}/${entry.path} ${entry.bytes}`);
  }
  console.log(`done: ${fetched} fetched, ${skipped} already verified`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(1); });
