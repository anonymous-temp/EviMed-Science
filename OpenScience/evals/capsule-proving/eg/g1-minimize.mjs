// Metadata-only resource amendment: minimize ordered source history while preserving observed probes and all categories.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { read, save } from './common.mjs';
const [data, original, output] = process.argv.slice(2);
const sample = await read(original), progress = {}, pools = {};
for (const user of sample.users) {
  const run = user === 'U03' ? 'g1pp-eg-3' : 'g1pp-eg-2';
  progress[user] = await read(`/srv/evimed/runs/${run}/cases/${user}/progress.json`, { sessions: 0, answered: [] });
  const gold = await read(`${data}/dev/${user}/gold.json`);
  pools[user] = gold.questions.map(q => ({ user, qid: q.qid, category: q.category, checkpoint: q.checkpoint }))
    .filter(q => q.checkpoint >= progress[user].sessions || progress[user].answered.includes(q.qid));
}
const observed = sample.users.flatMap(u => progress[u].answered);
const categories = new Set(sample.categories);
let best = null;
function search(i, limits) {
  if (i < sample.users.length) {
    const user = sample.users[i];
    for (const checkpoint of [...new Set(pools[user].map(q => q.checkpoint))].sort((a, b) => a - b)) {
      if (checkpoint < progress[user].sessions || checkpoint > sample.allocation[user].sessions) continue;
      search(i + 1, { ...limits, [user]: checkpoint });
    }
    return;
  }
  const pool = sample.users.flatMap(u => pools[u].filter(q => q.checkpoint <= limits[u]));
  if (pool.length < 100 || observed.some(id => !pool.some(q => q.qid === id)) || [...categories].some(c => !pool.some(q => q.category === c))) return;
  const sessions = Object.values(limits).reduce((n, v) => n + v, 0);
  if (!best || sessions < best.sessions) best = { sessions, limits, pool };
}
search(0, {});
if (!best) throw new Error('No metadata-only feasible amendment');
const questions = best.pool.filter(q => observed.includes(q.qid));
while (questions.length < 100) {
  const count = (key, value) => questions.filter(q => q[key] === value).length;
  const candidates = best.pool.filter(q => !questions.some(s => s.qid === q.qid)).sort((a, b) =>
    count('category', a.category) - count('category', b.category) || count('user', a.user) - count('user', b.user)
    || a.checkpoint - b.checkpoint || a.qid.localeCompare(b.qid));
  questions.push(candidates[0]);
}
if ([...categories].some(c => !questions.some(q => q.category === c))) throw new Error('Category coverage lost');
await save(output, { ...sample, questions,
  policy: 'Category-stratified metadata-only resource amendment: minimize total ordered source sessions for 100 probes, retain all observed probes and all 24 categories, no new question from a passed checkpoint.',
  amendment: { at: new Date().toISOString(), source: original, sourceSha256: createHash('sha256').update(await fs.readFile(original)).digest('hex'),
    reason: 'Shared-host queue and multi-minute live source work threaten the twelve-hour limit. Optimize checkpoint/category metadata only; no answers, verdicts, expected values or score contents used.',
    retainedObserved: observed, removed: sample.questions.filter(q => !questions.some(s => s.qid === q.qid)).map(q => q.qid),
    added: questions.filter(q => !sample.questions.some(s => s.qid === q.qid)).map(q => q.qid), progress,
    objective: 'minimum sum of source-session checkpoints over the existing four users, bounded by the previous sample; lexicographic user/checkpoint tie order',
    minimumSessions: best.sessions },
  allocation: Object.fromEntries(sample.users.map(u => [u, { questions: questions.filter(q => q.user === u).length, sessions: Math.max(...questions.filter(q => q.user === u).map(q => q.checkpoint)) }])) });
console.log(JSON.stringify((await read(output)).allocation));
