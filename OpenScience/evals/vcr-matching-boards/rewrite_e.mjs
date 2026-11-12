#!/usr/bin/env node
/**
 * Board E round 3, eval side only: rewrites a templated questionnaire topic as a short clinical narrative plus synonyms, one Flash call
 * per topic (DoSSIER / IELAB at TREC 2023 lifted nDCG@10 from 0.27 to 0.62 this way). Writes <out>/<topic>.rewrite.json and appends the
 * token usage of every call to <out>/usage.jsonl. A topic already written is not asked again; the run stops at --cap CNY.
 *
 *   node rewrite_e.mjs --notes <notes.jsonl> --year 2023 --out <dir> --key-file <deepseek key> [--cap 3]
 *
 * The product's own query writing is the conversation model's, through the skill; this prompt belongs to the board's plan writer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isPeak, priceUsage } from '@evimed/domain';
import { chatOnce } from './retrieve_e.mjs';

export const REWRITE_SYSTEM = [
  'You prepare the text search a patient-to-trial matching tool runs over ClinicalTrials.gov, from a filled condition questionnaire.',
  'The registry is written in English, in the words trial sponsors use for titles, conditions and eligibility criteria.',
  'Answer with one JSON object and nothing else: {"narrative": string, "condition": string, "terms": string[], "synonyms": string[]}.',
  '`narrative`: two or three plain sentences, as a clinician would write the patient into a note, saying the diagnosis, the findings and the history the questionnaire states (leave out every field that is empty or says nothing).',
  '`condition`: the main diagnosis in the registry\'s usual wording.',
  '`terms`: up to 32 further search phrases ranked by importance (comorbidities, findings, treatments, staging, the trial wording for them).',
  '`synonyms`: alternative names, abbreviations and the registry\'s wording for the main diagnosis and the most important comorbidities.',
  'Do not invent findings the questionnaire does not state.',
].join('\n');

export const rewriteMessages = (note) => [{ role: 'system', content: REWRITE_SYSTEM }, { role: 'user', content: `Questionnaire:\n\n${note}` }];

/** The answer's fields, cleaned to the shapes the search reads. @param {any} parsed */
export function rewriteFromAnswer(parsed) {
  const words = (v) => String(v ?? '').replace(/\s+/gu, ' ').trim();
  const list = (v, max) => (Array.isArray(v) ? v.map(words).filter(Boolean).slice(0, max) : []);
  return { narrative: words(parsed?.narrative), condition: words(parsed?.condition), terms: list(parsed?.terms, 32), synonyms: list(parsed?.synonyms, 40) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: o } = parseArgs({ options: { notes: { type: 'string' }, year: { type: 'string', default: '2023' }, out: { type: 'string' }, 'key-file': { type: 'string' }, cap: { type: 'string', default: '3' } } });
  const now = new Date();
  const hour = now.getUTCHours(), weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  if (isPeak(now) || (weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)))) { console.log('peak window: refused'); process.exit(2); }
  fs.mkdirSync(o.out, { recursive: true });
  const key = fs.readFileSync(o['key-file'], 'utf8').trim();
  const notes = fs.readFileSync(o.notes, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((n) => n.year === Number(o.year));
  const cap = Number(o.cap);
  let cost = 0, asked = 0;
  const work = notes.filter((n) => !fs.existsSync(path.join(o.out, `${n.id}.rewrite.json`)));
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let n = work.shift(); n; n = work.shift()) {
      if (cost >= cap) { console.log('cap reached'); return; }
      const answer = await chatOnce({ baseUrl: 'https://api.deepseek.com', apiKey: key, model: 'deepseek-flash', thinking: 'off', messages: rewriteMessages(n.note) });
      const c = priceUsage({ resourceType: 'model', model: 'deepseek-flash', ...answer.usage, peak: false }).cost ?? 0;
      cost += c; asked += 1;
      fs.appendFileSync(path.join(o.out, 'usage.jsonl'), `${JSON.stringify({ topic: n.id, ...answer.usage, costCny: c, at: new Date().toISOString() })}\n`);
      fs.writeFileSync(path.join(o.out, `${n.id}.rewrite.json`), JSON.stringify({ topic: n.id, ...rewriteFromAnswer(JSON.parse(answer.content)) }));
    }
  }));
  console.log(`[rewrite_e] ${asked} topics asked, CNY ${cost.toFixed(4)}`);
}
