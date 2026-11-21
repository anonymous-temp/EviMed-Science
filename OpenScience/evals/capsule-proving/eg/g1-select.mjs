// Freeze a category-stratified development-only sample before observing product outcomes.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { save } from './common.mjs';
const [data, out] = process.argv.slice(2);
const users = ['M01', 'P01', 'P02', 'U03'];
const selected = [];
for (const user of users) {
  const raw = await fs.readFile(`${data}/dev/${user}/gold.json`, 'utf8');
  const gold = JSON.parse(raw), categories = [...new Set(gold.questions.map(q => q.category))].sort();
  const buckets = categories.map(c => gold.questions.filter(q => q.category === c).sort((a, b) => a.checkpoint - b.checkpoint || a.qid.localeCompare(b.qid)));
  const chosen = [];
  for (let i = 0; chosen.length < 25; i++) for (const bucket of buckets) {
    if (bucket[i] && chosen.length < 25) chosen.push(bucket[i]);
  }
  selected.push(...chosen.map(q => ({ user, qid: q.qid, category: q.category, checkpoint: q.checkpoint })));
}
await save(out, { schema: 'eg-g1-selection/1', users, n: selected.length, policy: '25 questions per user; one per category before second; earliest checkpoint then qid; no outcome selection',
  categories: [...new Set(selected.map(q => q.category))].sort(), questions: selected,
  inputDigests: Object.fromEntries(await Promise.all(users.map(async u => [u, createHash('sha256').update(await fs.readFile(`${data}/dev/${u}/input.json`)).digest('hex')])))});
