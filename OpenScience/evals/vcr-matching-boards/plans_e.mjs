#!/usr/bin/env node
/**
 * Board E: the model-written search for every topic with the `english` prompt variant (the registry is English, so every phrase is English),
 * one Flash call per topic, thinking off. Writes <out>/<topic>.plan.json in retrieve_e.mjs's shape; a topic already written is not asked again.
 *
 *   node plans_e.mjs --notes <notes.jsonl> --out <dir> --key-file <deepseek key>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isPeak, priceUsage } from '@evimed/domain';
import { chatOnce, requestFromAnswer, searchMessages } from './retrieve_e.mjs';

const { values: o } = parseArgs({ options: { notes: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, only: { type: 'string' } } });
if (isPeak(new Date())) { console.log('peak window: refused'); process.exit(2); }
fs.mkdirSync(o.out, { recursive: true });
const key = fs.readFileSync(o['key-file'], 'utf8').trim();
const notes = fs.readFileSync(o.notes, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(n => !o.only || o.only.split(',').includes(n.id));
let cost = 0, asked = 0;
const work = notes.filter(n => !fs.existsSync(path.join(o.out, `${n.id}.plan.json`)));
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let n = work.shift(); n; n = work.shift()) {
    const answer = await chatOnce({ baseUrl: 'https://api.deepseek.com', apiKey: key, model: 'deepseek-flash', thinking: 'off', messages: searchMessages(n.note, 'english') });
    const { request, adjusted } = requestFromAnswer(JSON.parse(answer.content));
    const c = priceUsage({ resourceType: 'model', model: 'deepseek-flash', ...answer.usage, peak: false }).cost ?? 0; cost += c; asked++;
    fs.writeFileSync(path.join(o.out, `${n.id}.plan.json`), JSON.stringify({ topic: n.id, request, adjusted, usage: answer.usage, costCny: c, variant: 'english', at: new Date().toISOString() }));
  }
}));
console.log(`[plans_e] ${asked} topics asked, CNY ${cost.toFixed(4)}`);
