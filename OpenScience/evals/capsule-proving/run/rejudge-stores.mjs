#!/usr/bin/env node
// Paired, opt-in retention review of already captured development runs. Original scores and answer judgements stay intact.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgePackets, memoryStoreJudgePacket, mergeJudgeResults, rowKey, sha256, stableJson, STORE_JUDGE_CLIENT_SHA256 } from './judgePackets.mjs';
import { summarize } from './score.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async (read, fallback) => { try { return await read(); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const atomic = async (file, text) => { await writeFile(`${file}.tmp`, text); await rename(`${file}.tmp`, file); };

/** Reuse captured packets, not new engine writes; all model decisions are fresh and hash-bound to the store rubric. */
export async function rejudgeStores({ runs, out, keyFile, categories = null, fetchImpl, concurrency = 6 }) {
  const key = (await readFile(keyFile, 'utf8')).trim();
  const summaries = [];
  await mkdir(out, { recursive: true });
  for (const run of runs) {
    const manifest = await json(path.join(run, 'run.json'));
    if (manifest.split !== 'dev') throw new Error('store_review_requires_development_run');
    const cache = await json(path.join(run, 'scores/score-cache.json'));
    const rows = cache.rows.filter(row => row.kind === 'store' && (!categories || categories.includes(row.category)));
    const selected = new Set(rows.map(rowKey));
    const packets = cache.packets.filter(packet => selected.has(packet.rowKey)).map(memoryStoreJudgePacket);
    const directory = path.join(out, manifest.runId);
    await mkdir(directory, { recursive: true });
    const identity = { runId: manifest.runId, rubric: STORE_JUDGE_CLIENT_SHA256, categories, batchSize: 1,
      capturedStoresSha256: sha256(stableJson({ rows, packets })) };
    const previous = await optional(() => json(path.join(directory, 'review.json')), null);
    if (previous && stableJson(previous) !== stableJson(identity)) throw new Error('store_review_identity_changed');
    await atomic(path.join(directory, 'review.json'), JSON.stringify(identity, null, 2) + '\n');
    await atomic(path.join(directory, 'judge-packets.jsonl'), packets.map(packet => JSON.stringify(packet) + '\n').join(''));
    const resultFile = path.join(directory, 'judge-results.json');
    let results = await optional(() => json(resultFile), []);
    // A store packet can contain an account's complete captured memory. Keep requests independent and bounded to one packet.
    results = await judgePackets(packets, { key, results, fetchImpl, concurrency, batchSize: 1, retries: 3,
      persist: value => atomic(resultFile, JSON.stringify(value)) });
    const merged = mergeJudgeResults(rows, packets, results);
    const summary = { ...summarize(merged), ...identity, judge: { packets: packets.length, completed: results.length, pending: packets.length - results.length },
      evidence: 'Store checks only, with the original captured memory, source evidence and denominators; no engine ingestion or answer regrading.' };
    await atomic(path.join(directory, 'rows.jsonl'), merged.map(row => JSON.stringify(row) + '\n').join(''));
    await atomic(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    summaries.push(summary);
    process.stdout.write(`${manifest.runId}: store ${summary.storeRecall.pass}/${summary.storeRecall.n}; judge ${results.length}/${packets.length}\n`);
  }
  await atomic(path.join(out, 'summary.json'), JSON.stringify({ rubric: STORE_JUDGE_CLIENT_SHA256, runs: summaries }, null, 2) + '\n');
  return summaries;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? '' : args[at + 1]; };
  const runs = option('--runs'), out = option('--out'), keyFile = option('--judge-key-file'), categories = option('--categories');
  if (!runs || !out || !keyFile) throw new Error('Use --runs <before,after> --out <new directory> --judge-key-file <file>');
  rejudgeStores({ runs: runs.split(',').map(run => path.resolve(run)), out: path.resolve(out), keyFile,
    categories: categories ? categories.split(',') : null }).catch(error => {
    // Only structural error codes leave the runner, never provider responses, source text or credentials.
    process.stderr.write(`${/^[a-z][a-z0-9_]+$/.test(error?.message) ? error.message : 'store_review_failed'}\n`);
    process.exitCode = 1;
  });
}
