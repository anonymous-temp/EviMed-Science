#!/usr/bin/env node
/**
 * Board E round 3: the lexical stage's variants on TREC 2023, measured on its own (no dense list, no rerank) against the official qrels
 * with an unjudged trial counted not relevant. Reads the extra tables `index_r3.mjs` built; the first-stage logic is the reader's
 * (`vcrTrialCorpus.mjs`): each phrase its own FTS5 BM25 query (top 500), lists fused by TrialGPT's weights (`fusionScore`), the age and sex
 * the saved plan states applied, the first 500 kept. Variants differ in the index and in the phrases:
 *
 *   a  the collection's own `terms` (all fields incl. exclusion text)      b  `terms_b` (no exclusion text)
 *   c  `terms_c`, one row per inclusion criterion, rows aggregated to trials per phrase (max + mean of the row scores, each over the best row)
 *   i  the saved plan's condition + ranked terms    ii  the rewrite's condition, narrative, terms and synonyms
 *   lists of several variants are fused by RRF (k = 60) before the filter.
 *
 *   node recall_r3.mjs --index <r3.sqlite> --source <collection sqlite> --plans <dir> --rewrites <dir> --topics <trec topics dir> --out <file.json>
 *        [--saved <lex-en.jsonl>]   (reproduction check of variant a+i against the saved product lists)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { ageBands, ageFit, fusionScore, sexFit, sexOf } from '../../apps/server/src/vcrCandidateSearch.mjs';

const STOP = new Set('a an and are as at be been being but by for from had has have having he her here hers herself him himself his how i if in into is it its itself me more most my myself of on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves'.split(' '));
const tokens = (q) => [...new Set(q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => !STOP.has(t)).sort();
const match = (words) => words.map((w) => `"${w}"`).join(' OR ');
const POOL = 500, ROWS = 2000, RRF_K = 60;

export function metrics(ranked, qrels, ks = [300, 500]) {
  const grade = (id) => qrels.get(id) ?? 0;
  const eligible = [...qrels.values()].filter((g) => g === 2).length, relevant = [...qrels.values()].filter((g) => g >= 1).length;
  const at = (k, min) => ranked.slice(0, k).filter((id) => grade(id) >= min).length;
  const dcg = (gains) => gains.slice(0, 10).reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  const ideal = [...qrels.values()].sort((a, b) => b - a);
  return {
    ...Object.fromEntries(ks.map((k) => [`eligR${k}`, eligible ? at(k, 2) / eligible : null])),
    relR500: relevant ? at(500, 1) / relevant : null,
    ndcg10: dcg(ideal) ? dcg(ranked.slice(0, 10).map(grade)) / dcg(ideal) : null,
  };
}
const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function openLexicon({ index, source }) {
  const idx = new DatabaseSync(index, { readOnly: true });
  const src = new DatabaseSync(source, { readOnly: true });
  const a = src.prepare('SELECT rowid AS id, bm25(terms) AS d FROM terms WHERE terms MATCH ? ORDER BY d, rowid LIMIT ?');
  const b = idx.prepare('SELECT rowid AS id, bm25(terms_b) AS d FROM terms_b WHERE terms_b MATCH ? ORDER BY d, rowid LIMIT ?');
  const c = idx.prepare('SELECT k.doc AS id, bm25(terms_c) AS d FROM terms_c JOIN criteria k ON k.id = terms_c.rowid WHERE terms_c MATCH ? ORDER BY d, k.id LIMIT ?');
  const info = src.prepare('SELECT nct_id, payload FROM documents WHERE id = ?');
  const cache = new Map(), meta = new Map();
  const run = (kind, query) => {
    const key = `${kind}\u0000${query}`;
    let got = cache.get(key);
    if (!got) {
      if (kind === 'c') {
        const best = new Map();
        let top = null;
        for (const row of c.all(query, ROWS)) {
          const s = -Number(row.d);
          top ??= s || 1;
          const e = best.get(row.id) ?? { max: 0, sum: 0, n: 0 };
          const n = s / top; e.max = Math.max(e.max, n); e.sum += n; e.n += 1; best.set(row.id, e);
        }
        got = [...best.entries()].map(([id, e]) => [id, e.max + e.sum / e.n]).sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, POOL).map(([id]) => id);
      } else got = (kind === 'a' ? a : b).all(query, POOL).map((r) => Number(r.id));
      cache.set(key, got);
    }
    return got;
  };
  const trial = (id) => {
    let m = meta.get(id);
    if (!m) {
      const row = info.get(id); const p = JSON.parse(inflateSync(row.payload).toString('utf8'));
      m = { nct: row.nct_id, bands: ageBands({ registry: 'ctgov', minimumAge: p.minimum_age, maximumAge: p.maximum_age }), sex: sexOf(p.gender) };
      meta.set(id, m);
    }
    return m;
  };
  return { run, trial, close() { idx.close(); src.close(); } };
}

/** Product fusion of one phrase set over one index: ordered doc ids (the whole pool, unfiltered). */
export function fusePhrases(lex, kind, phrases) {
  const queries = [...new Map(phrases.map((q) => { const w = tokens(q); return [match(w), w]; })).entries()].filter(([q]) => q);
  const scores = new Map();
  for (const [qi, [q]] of queries.entries()) for (const [rank, id] of lex.run(kind, q).entries()) scores.set(id, (scores.get(id) ?? 0) + fusionScore(rank, qi));
  return [...scores.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([id]) => id);
}

export function rrf(lists) {
  if (lists.length === 1) return lists[0];
  const s = new Map();
  for (const list of lists) for (const [rank, id] of list.entries()) s.set(id, (s.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  return [...s.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([id]) => id);
}

export function keep(lex, ordered, { age, sex }, limit = POOL) {
  const out = [];
  for (const id of ordered) {
    const t = lex.trial(id);
    if (age !== null && ageFit(t.bands, age) === 'outside') continue;
    if (sex && sexFit(t.sex, sex) === 'outside') continue;
    out.push(t.nct);
    if (out.length >= limit) break;
  }
  return out;
}

export const VARIANTS = [
  ['a+i', [['a', 'i']]], ['b+i', [['b', 'i']]], ['b+c+i', [['b', 'i'], ['c', 'i']]], ['a+ii', [['a', 'ii']]], ['b+ii', [['b', 'ii']]],
  ['b+c+ii', [['b', 'ii'], ['c', 'ii']]], ['b+c+i+ii', [['b', 'i'], ['c', 'i'], ['b', 'ii'], ['c', 'ii']]],
  // not asked for, kept for the reading: the single-index pieces
  ['c+i', [['c', 'i']]], ['c+ii', [['c', 'ii']]],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: o } = parseArgs({ options: { index: { type: 'string' }, source: { type: 'string' }, plans: { type: 'string' }, rewrites: { type: 'string' }, topics: { type: 'string' }, out: { type: 'string' }, saved: { type: 'string' }, only: { type: 'string' } } });
  const split = JSON.parse(fs.readFileSync(new URL('./split_e.json', import.meta.url), 'utf8'));
  const dev = new Set(split.dev.trec_2023);
  const qrels = new Map();
  for (const line of fs.readFileSync(path.join(o.topics, 'qrels2023.txt'), 'utf8').split('\n').filter(Boolean)) {
    const [t, , nct, g] = line.trim().split(/\s+/);
    const id = `trec-2023-${t}`; if (!qrels.has(id)) qrels.set(id, new Map()); qrels.get(id).set(nct, Number(g));
  }
  const topics = [...qrels.keys()].filter((id) => [...qrels.get(id).values()].some((g) => g === 2)).sort((x, y) => Number(x.split('-')[2]) - Number(y.split('-')[2]));
  const lex = openLexicon({ index: o.index, source: o.source });
  const only = o.only ? o.only.split(',') : null;
  const per = {}; const lists = {};
  for (const [name, parts] of VARIANTS) {
    if (only && !only.includes(name)) continue;
    per[name] = {};
    for (const topic of topics) {
      const plan = JSON.parse(fs.readFileSync(path.join(o.plans, `${topic}.plan.json`), 'utf8')).request;
      const rw = JSON.parse(fs.readFileSync(path.join(o.rewrites, `${topic}.rewrite.json`), 'utf8'));
      const phrases = { i: [plan.condition, ...plan.terms], ii: [rw.condition, rw.narrative, ...rw.terms, ...rw.synonyms] };
      const merged = rrf(parts.map(([kind, set]) => fusePhrases(lex, kind, phrases[set])));
      const ranked = keep(lex, merged, { age: plan.age, sex: plan.sex });
      lists[`${name}\t${topic}`] = ranked;
      per[name][topic] = metrics(ranked, qrels.get(topic));
    }
    console.error(`[recall_r3] ${name} done`);
  }
  const agg = (name, set) => { const ts = topics.filter((t) => set(t)); const keys = ['eligR300', 'eligR500', 'relR500', 'ndcg10']; return { topics: ts.length, ...Object.fromEntries(keys.map((k) => [k, mean(ts.map((t) => per[name][t][k]))])) }; };
  const summary = {};
  for (const name of Object.keys(per)) summary[name] = { dev: agg(name, (t) => dev.has(t)), test: agg(name, (t) => !dev.has(t)), all: agg(name, () => true) };
  let reproduction = null;
  if (o.saved && lists['a+i\ttrec-2023-1']) {
    const saved = new Map(fs.readFileSync(o.saved, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.topic.startsWith('trec-2023-')).map((r) => [r.topic, r.ids]));
    const same = topics.filter((t) => saved.has(t)).map((t) => { const s = saved.get(t), m = lists[`a+i\t${t}`]; return m.filter((id, i) => id === s[i]).length / Math.max(1, s.length); });
    reproduction = { topics: same.length, meanPositionalAgreement: mean(same) };
  }
  fs.writeFileSync(o.out, JSON.stringify({ topics: topics.length, devTopics: topics.filter((t) => dev.has(t)).length, summary, reproduction, per }, null, 1));
  console.log(JSON.stringify({ topics: topics.length, reproduction, summary }, null, 1));
  lex.close();
}
