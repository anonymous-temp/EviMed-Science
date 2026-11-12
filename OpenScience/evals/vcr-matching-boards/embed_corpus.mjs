#!/usr/bin/env node
/**
 * Board E dense index: every trial of a frozen TREC collection embedded with the plugin's profile (Qwen3.7 text embedding, 1024
 * dimensions, the balanced ranking view the plugin indexes), stored as float16 rows for exact cosine search.
 *
 * The product stores the same vectors in pgvector; a benchmark index of 827,118 trials does not fit this machine's database, so the
 * rows go to two flat files: <out>/ids.txt (one NCT id per line) and <out>/vectors.f16 (row i = ids line i, 1024 float16, L2-normalised).
 * Resumable: rows already written are kept, the vector file is cut to the id count on start, only missing trials are asked.
 *
 *   node embed_corpus.mjs --collection <dir with collection.json> --out <dir> --key-file <file> [--rps 2.5] [--tpm 900000] [--cap-cny 60]
 *   node embed_corpus.mjs --query --key-file <file> --texts <jsonl of {id,text}> --out <file.f16>   (query vectors, same profile)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { viewText } from './ranking_view.mjs';

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const MODEL = 'qwen3.7-text-embedding';
const DIMENSIONS = 1024;
const BATCH = 20;
const CNY_PER_MTOK = 0.5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function embed(key, texts) {
  let last = 'unknown';
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await sleep(Math.min(90000, 1500 * 2 ** attempt));
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIMENSIONS, encoding_format: 'float' }) });
      const body = await response.text();
      if (!response.ok) {
        last = `http_${response.status}`;
        // DashScope answers a transient backend fault as 400 InternalError; only other client errors are final.
        if (![408, 409, 425, 429].includes(response.status) && response.status < 500 && !/InternalError/.test(body)) throw Object.assign(new Error(`${last} ${body.slice(0, 160)}`), { fatal: true });
        continue;
      }
      const parsed = JSON.parse(body);
      const rows = [...parsed.data].sort((a, b) => a.index - b.index);
      if (rows.length !== texts.length || rows.some(row => row.embedding.length !== DIMENSIONS)) { last = 'shape'; continue; }
      return { vectors: rows.map(row => row.embedding), tokens: parsed.usage?.total_tokens ?? parsed.usage?.prompt_tokens ?? 0 };
    } catch (error) {
      if (error.fatal) throw error;
      last = error.name || 'network';
    }
  }
  throw new Error(last);
}

export function half(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Buffer.from(new Float16Array(vector.map(value => value / norm)).buffer);
}

async function corpus(o) {
  const manifest = JSON.parse(fs.readFileSync(path.join(o.collection, 'collection.json'), 'utf8'));
  const db = new DatabaseSync(path.join(o.collection, manifest.databasePath), { readOnly: true });
  fs.mkdirSync(o.out, { recursive: true });
  const idsFile = path.join(o.out, 'ids.txt'), vecFile = path.join(o.out, 'vectors.f16'), ledger = path.join(o.out, 'usage.jsonl');
  const have = fs.existsSync(idsFile) ? fs.readFileSync(idsFile, 'utf8').split('\n').filter(Boolean) : [];
  const rowBytes = DIMENSIONS * 2;
  if (fs.existsSync(vecFile) && fs.statSync(vecFile).size !== have.length * rowBytes) fs.truncateSync(vecFile, have.length * rowBytes);
  let tokens = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).reduce((sum, line) => sum + JSON.parse(line).tokens, 0) : 0;
  const done = new Set(have);
  const key = fs.readFileSync(o['key-file'], 'utf8').trim();
  const all = db.prepare('SELECT nct_id FROM documents ORDER BY id').all().map(row => row.nct_id);
  const todo = all.filter(id => !done.has(id));
  const select = db.prepare('SELECT payload FROM documents WHERE nct_id = ?');
  console.log(`[embed] ${manifest.id}: ${all.length} trials, ${done.size} held, ${todo.length} to embed`);
  const idsFd = fs.openSync(idsFile, 'a'), vecFd = fs.openSync(vecFile, 'a'), usageFd = fs.openSync(ledger, 'a');
  const window = [];
  let lastStart = 0, batches = 0, stop = null, written = done.size;
  const started = Date.now();
  const jobs = [];
  for (let at = 0; at < todo.length; at += BATCH) jobs.push(todo.slice(at, at + BATCH));
  const worker = async () => {
    for (let ids = jobs.shift(); ids && !stop; ids = jobs.shift()) {
      const texts = ids.map(id => viewText('balanced', JSON.parse(inflateSync(select.get(id).payload).toString('utf8'))).slice(0, 8000) || id);
      const estimate = Math.ceil(texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) / 3.5);
      for (;;) { // request and token pacing, shared by the workers
        const now = Date.now();
        while (window.length && window[0].at <= now - 60000) window.shift();
        const used = window.reduce((sum, row) => sum + row.tokens, 0);
        const gap = lastStart + 1000 / o.rps - now;
        if (gap <= 0 && used + estimate <= o.tpm) { lastStart = now; window.push({ at: now, tokens: estimate }); break; }
        await sleep(Math.max(gap, 50));
      }
      let answer;
      try { answer = await embed(key, texts); }
      catch (error) { stop = `embedding failed: ${error.message}`; break; }
      fs.writeSync(vecFd, Buffer.concat(answer.vectors.map(half)));
      fs.writeSync(idsFd, `${ids.join('\n')}\n`);
      fs.writeSync(usageFd, `${JSON.stringify({ n: ids.length, tokens: answer.tokens })}\n`);
      tokens += answer.tokens; written += ids.length; batches++;
      if (tokens * CNY_PER_MTOK / 1e6 > o['cap-cny']) stop = `cap ${o['cap-cny']} CNY`;
      if (batches % 250 === 0) {
        const rate = (written - done.size) / ((Date.now() - started) / 1000);
        console.log(`[embed] ${new Date().toISOString()} ${written}/${all.length} tokens ${tokens} ~CNY ${(tokens * CNY_PER_MTOK / 1e6).toFixed(2)} ${rate.toFixed(1)}/s`);
      }
    }
  };
  // Writes happen between awaits of a single-threaded loop, so a batch's ids and vectors are appended together.
  await Promise.all(Array.from({ length: o.workers }, worker));
  fs.closeSync(idsFd); fs.closeSync(vecFd); fs.closeSync(usageFd);
  console.log(`[embed] ${stop ? `stopped: ${stop}` : 'finished'} ${written}/${all.length} tokens ${tokens} ~CNY ${(tokens * CNY_PER_MTOK / 1e6).toFixed(2)}`);
  return stop ? 3 : 0;
}

async function queries(o) {
  const key = fs.readFileSync(o['key-file'], 'utf8').trim();
  const rows = fs.readFileSync(o.texts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const out = [];
  let tokens = 0;
  for (let at = 0; at < rows.length; at += BATCH) {
    const batch = rows.slice(at, at + BATCH);
    const answer = await embed(key, batch.map(row => row.text.slice(0, 8000)));
    tokens += answer.tokens;
    out.push(...answer.vectors.map(half));
  }
  fs.writeFileSync(o.out, Buffer.concat(out));
  fs.writeFileSync(`${o.out}.ids`, `${rows.map(row => row.id).join('\n')}\n`);
  console.log(`[embed] ${rows.length} query vectors, tokens ${tokens}`);
  return 0;
}

const { values: o } = parseArgs({ options: {
  collection: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, rps: { type: 'string', default: '2.5' },
  tpm: { type: 'string', default: '900000' }, 'cap-cny': { type: 'string', default: '60' }, workers: { type: 'string', default: '6' },
  query: { type: 'boolean', default: false }, texts: { type: 'string' } } });
o.rps = Number(o.rps); o.tpm = Number(o.tpm); o['cap-cny'] = Number(o['cap-cny']); o.workers = Number(o.workers);
process.exitCode = o.query ? await queries(o) : await corpus(o);
