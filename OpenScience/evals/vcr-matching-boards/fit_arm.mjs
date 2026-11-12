#!/usr/bin/env node
/**
 * The Flash trial-level fit for named (patient, trial) pairs: the product's fit prompt (`fitMessages`, TrialGPT 2.0's trial-level
 * judgment with the silence rule and the assume-at-screening policy), DeepSeek V4.1 Flash with thinking off, JSON out.
 *
 * Answers are appended to <out>/pairs.jsonl; a run again asks only what is missing, and `--cache` files (earlier runs of the same prompt
 * and model, in this file's row shape or the judgments.jsonl shape) are read first so a pair is never paid twice. Paid calls run only
 * off-peak (`isPeak` of @evimed/domain: DeepSeek's discount window, weekends whole days) and stop at the cap or the shared balance floor. No patient text is written.
 *
 *   node fit_arm.mjs --cases <cases.jsonl> [--cases ...] --collections <dir> --pairs <pairs.jsonl> --out <dir> --key-file <file>
 *       [--cache <file>]... [--concurrency 12] [--cap-cny 30] [--floor-cny 200]
 *   <pairs.jsonl>: {"p": patientId, "t": registryId} per line. <cases.jsonl>: {patientId, note, collection}.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { isPeak, priceUsage } from '@evimed/domain';
import { fitMessages, parseFitAnswer } from '../../packages/domain/src/vcrTrialJudgment.mjs';

const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const readJsonl = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const items = value => (value ? String(value).split(/;\s*|\n+/).map(part => part.trim()).filter(Boolean) : []);

/** The registry's age and sex line, as the product's fit stage wrote it. */
export function takes(doc) {
  const clean = value => (/^n\/?a$/i.test(String(value ?? '').trim()) ? '' : String(value ?? '').trim());
  const low = clean(doc.minimum_age), high = clean(doc.maximum_age), who = clean(doc.gender);
  const ages = low && high ? `${low} to ${high}` : low ? `${low} and older` : high ? `up to ${high}` : '';
  return [ages && `ages ${ages}`, who && `sex ${who}`].filter(Boolean).join('; ');
}

export const messagesFor = (note, doc) => fitMessages({ title: doc.title, summary: doc.summary, eligibility: doc.eligibility, takes: takes(doc), note,
  conditions: items(doc.condition), interventions: items(doc.interventions) });

async function chat(key, messages) {
  const body = { model: MODEL, messages, max_tokens: 3000, response_format: { type: 'json_object' }, stream: false, thinking: { type: 'disabled' }, temperature: 0 };
  let last = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    try {
      const response = await fetch(`${BASE}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(180000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 429 || response.status >= 500) { last = `http_${response.status}`; continue; }
      if (!response.ok) throw Object.assign(new Error(`http_${response.status}`), { fatal: true });
      const data = JSON.parse(await response.text());
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') { last = 'no_content'; continue; }
      const u = data.usage ?? {};
      const hit = Number(u.prompt_cache_hit_tokens ?? 0), miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, Number(u.prompt_tokens ?? 0) - hit));
      return { content, usage: { cacheHit: hit, cacheMiss: miss, output: Number(u.completion_tokens ?? 0) }, model: data.model };
    } catch (error) {
      if (error.fatal) throw error;
      last = error.name === 'TimeoutError' ? 'timeout' : 'network';
    }
  }
  throw new Error(last);
}

async function balance(key) {
  const response = await fetch(`${BASE}/user/balance`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const data = await response.json();
  return Number((data.balance_infos ?? []).find(row => row.currency === 'CNY')?.total_balance ?? NaN);
}

function collection(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'collection.json'), 'utf8'));
  const db = new DatabaseSync(path.join(dir, manifest.databasePath), { readOnly: true });
  const select = db.prepare('SELECT payload FROM documents WHERE nct_id = ?');
  return nct => JSON.parse(inflateSync(select.get(nct).payload).toString('utf8'));
}

const { values: o } = parseArgs({ options: {
  cases: { type: 'string', multiple: true }, collections: { type: 'string' }, pairs: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' },
  cache: { type: 'string', multiple: true, default: [] }, concurrency: { type: 'string', default: '12' }, 'cap-cny': { type: 'string', default: '30' },
  'floor-cny': { type: 'string', default: '200' }, 'allow-peak': { type: 'boolean', default: false } } });
fs.mkdirSync(o.out, { recursive: true });
const sink = path.join(o.out, 'pairs.jsonl');
const have = new Map();
for (const file of [...o.cache, sink]) {
  for (const row of readJsonl(file)) {
    if (row.ranking) for (const entry of row.ranking) have.set(`${row.patientId}|${entry.registryId}`, { fit: entry.fit, confidence: entry.confidence ?? null });
    else if (!row.error && row.fit != null) have.set(`${row.p}|${row.t}`, row);
  }
}
const cases = new Map(o.cases.flatMap(file => readJsonl(file)).map(row => [row.patientId, row]));
const wanted = readJsonl(o.pairs);
const todo = wanted.filter(row => !have.has(`${row.p}|${row.t}`));
console.log(`[fit_arm] ${wanted.length} pairs wanted, ${wanted.length - todo.length} already answered, ${todo.length} to ask`);
const key = fs.readFileSync(o['key-file'], 'utf8').trim();
if (todo.length) {
  if (!o['allow-peak'] && isPeak(new Date())) { console.log('[fit_arm] peak window: refused before any paid call'); process.exit(2); }
  const funds = await balance(key);
  if (!(funds > Number(o['floor-cny']))) { console.log(`[fit_arm] balance ${funds} at or under the floor`); process.exit(2); }
}
const readers = {};
const docOf = (collectionId, nct) => (readers[collectionId] ??= collection(path.join(o.collections, collectionId)))(nct);
let spent = 0, asked = 0, failed = 0, stop = null;
const fd = fs.openSync(sink, 'a');
const worker = async () => {
  for (let job = todo.shift(); job && !stop; job = todo.shift()) {
    if (!o['allow-peak'] && isPeak(new Date())) { stop = 'peak window began'; break; }
    const item = cases.get(job.p);
    const started = Date.now();
    let row;
    try {
      const answer = await chat(key, messagesFor(item.note, docOf(item.collection, job.t)));
      const parsed = parseFitAnswer(answer.content);
      const cost = priceUsage({ resourceType: 'model', model: MODEL, ...answer.usage, peak: isPeak(new Date()) }).cost ?? 0;
      spent += cost;
      row = { p: job.p, t: job.t, fit: parsed.fit, confidence: parsed.confidence, issues: parsed.issues.map(issue => issue.code),
        nReasons: { eligible: parsed.reasons.eligible.length, ineligible: parsed.reasons.ineligible.length, missing: parsed.reasons.missing.length },
        usage: answer.usage, costCny: cost, model: answer.model, ms: Date.now() - started };
      if (parsed.fit == null) row.error = 'fit_missing';
    } catch (error) { row = { p: job.p, t: job.t, error: String(error.message).slice(0, 80) }; }
    fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    asked++; failed += row.error ? 1 : 0;
    if (spent > Number(o['cap-cny'])) stop = `cap ${o['cap-cny']} CNY`;
    if (failed > 50 && failed > asked * 0.2) stop = 'too many failures';
    if (asked % 500 === 0) console.log(`[fit_arm] ${new Date().toISOString()} asked ${asked} failed ${failed} ~CNY ${spent.toFixed(2)}`);
  }
};
await Promise.all(Array.from({ length: Number(o.concurrency) }, worker));
fs.closeSync(fd);
console.log(`[fit_arm] ${stop ? `stopped: ${stop}` : 'finished'} asked ${asked} failed ${failed} ~CNY ${spent.toFixed(2)}`);
process.exitCode = stop ? 3 : 0;
