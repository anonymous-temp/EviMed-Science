#!/usr/bin/env node
/**
 * Board E round 4: a whole-topic lexical channel on TREC 2023. The topic's whole template text is one FTS5 BM25 query (OR of its
 * stop-filtered tokens) over `terms` (w-a) or `terms_b` (w-b), fused by RRF (k = 60) with the round-3 chosen variant (b)+(c)+(ii).
 * Measured exactly as recall_r3.mjs does (eligible recall@300/500, all-relevant recall@500, lexical nDCG@10, age/sex filter, 500 kept).
 * Also writes the kept lists (`--lists-out`, jsonl: topic, variant, ids) that the end-to-end scorer takes candidates from.
 *
 *   node recall_r4.mjs --index <r3.sqlite> --source <collection sqlite> --plans <dir> --rewrites <dir> --topics <trec topics dir>
 *        --notes <notes.jsonl> --out <file.json> --lists-out <file.jsonl>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fusePhrases, keep, metrics, openLexicon, rrf } from './recall_r3.mjs';

const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
// kind, phrase set; `w` is the topic's whole text as the one phrase
export const VARIANTS = [
  ['b+c+ii', [['b', 'ii'], ['c', 'ii']]],
  ['w-a', [['a', 'w']]],
  ['w-b', [['b', 'w']]],
  ['b+c+ii+w-a', [['b', 'ii'], ['c', 'ii'], ['a', 'w']]],
  ['b+c+ii+w-b', [['b', 'ii'], ['c', 'ii'], ['b', 'w']]],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: o } = parseArgs({ options: { index: { type: 'string' }, source: { type: 'string' }, plans: { type: 'string' }, rewrites: { type: 'string' }, topics: { type: 'string' }, notes: { type: 'string' }, out: { type: 'string' }, 'lists-out': { type: 'string' } } });
  const split = JSON.parse(fs.readFileSync(new URL('./split_e.json', import.meta.url), 'utf8'));
  const dev = new Set(split.dev.trec_2023);
  const notes = new Map(fs.readFileSync(o.notes, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r.note]));
  const qrels = new Map();
  for (const line of fs.readFileSync(path.join(o.topics, 'qrels2023.txt'), 'utf8').split('\n').filter(Boolean)) {
    const [t, , nct, g] = line.trim().split(/\s+/);
    const id = `trec-2023-${t}`; if (!qrels.has(id)) qrels.set(id, new Map()); qrels.get(id).set(nct, Number(g));
  }
  const topics = [...qrels.keys()].filter((id) => [...qrels.get(id).values()].some((g) => g === 2)).sort((x, y) => Number(x.split('-')[2]) - Number(y.split('-')[2]));
  const lex = openLexicon({ index: o.index, source: o.source });
  const per = {}; const lines = [];
  for (const [name, parts] of VARIANTS) {
    per[name] = {};
    for (const topic of topics) {
      const plan = JSON.parse(fs.readFileSync(path.join(o.plans, `${topic}.plan.json`), 'utf8')).request;
      const rw = JSON.parse(fs.readFileSync(path.join(o.rewrites, `${topic}.rewrite.json`), 'utf8'));
      const phrases = { ii: [rw.condition, rw.narrative, ...rw.terms, ...rw.synonyms], w: [notes.get(topic)] };
      const merged = rrf(parts.map(([kind, set]) => fusePhrases(lex, kind, phrases[set])));
      const ranked = keep(lex, merged, { age: plan.age, sex: plan.sex });
      lines.push(JSON.stringify({ topic, variant: name, ids: ranked }));
      per[name][topic] = metrics(ranked, qrels.get(topic));
    }
    console.error(`[recall_r4] ${name} done`);
  }
  const agg = (name, set) => { const ts = topics.filter((t) => set(t)); return { topics: ts.length, ...Object.fromEntries(['eligR300', 'eligR500', 'relR500', 'ndcg10'].map((k) => [k, mean(ts.map((t) => per[name][t][k]))])) }; };
  const summary = {};
  for (const name of Object.keys(per)) summary[name] = { dev: agg(name, (t) => dev.has(t)), test: agg(name, (t) => !dev.has(t)), all: agg(name, () => true) };
  fs.writeFileSync(o.out, JSON.stringify({ topics: topics.length, summary, per }, null, 1));
  fs.writeFileSync(o['lists-out'], `${lines.join('\n')}\n`);
  console.log(JSON.stringify(summary, null, 1));
  lex.close();
}
