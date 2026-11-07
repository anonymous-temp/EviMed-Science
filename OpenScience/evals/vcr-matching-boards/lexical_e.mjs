#!/usr/bin/env node
/**
 * Board E lexical branch variants through the product's frozen-collection reader (`vcrTrialCorpus.mjs`, FTS5 BM25 with TrialGPT's
 * query fusion and the age/sex filter), from the saved model-written searches. `cond` asks the condition alone (what the V3 discovery
 * sends); `skill` asks the condition and the ranked phrases (the old skill's search, saved by retrieve_e.mjs as *.list.json).
 *
 *   node lexical_e.mjs --plans <dir> [--plans <dir>] --collections <trec dir> --variant cond --out <file.jsonl> [--limit 500]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { candidateRequest } from '../../apps/server/src/vcrCandidateSearch.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';

const { values: o } = parseArgs({ options: { plans: { type: 'string', multiple: true }, collections: { type: 'string' }, variant: { type: 'string', default: 'cond' },
  out: { type: 'string' }, limit: { type: 'string', default: '500' } } });
const done = new Set(fs.existsSync(o.out) ? fs.readFileSync(o.out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).topic) : []);
const corpora = {};
const corpus = topic => {
  const key = topic.startsWith('trec-2023-') ? 'index2023' : 'index2021';
  return (corpora[key] ??= createVcrTrialCorpus(path.join(o.collections, key, 'collection.json'), { timeoutMs: 120000 }));
};
const plans = o.plans.flatMap(dir => fs.readdirSync(dir).filter(name => name.endsWith('.plan.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))));
for (const plan of plans.sort((a, b) => a.topic.localeCompare(b.topic))) {
  if (done.has(plan.topic)) continue;
  const r = plan.request;
  const filter = { condition: r.condition, terms: o.variant === 'cond' ? [] : r.terms, summary: null, age: r.age, sex: r.sex, region: null, status: 'any', limit: Number(o.limit) };
  const asked = candidateRequest(filter, { frozen: true });
  if (!asked.ok) { console.error(plan.topic, asked.message); continue; }
  const started = Date.now();
  const got = await corpus(plan.topic).collect(asked.request);
  fs.appendFileSync(o.out, `${JSON.stringify({ topic: plan.topic, list: `lex-${o.variant}`, ids: got.candidates.map(row => row.registryId), millis: Date.now() - started })}\n`);
}
for (const c of Object.values(corpora)) await c.close();
console.log('done');
