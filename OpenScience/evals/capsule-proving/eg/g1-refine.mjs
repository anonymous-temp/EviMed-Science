// Resource amendment only: preserve all observed probes and all categories; remove redundant late U03 probes.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { read, save } from './common.mjs';
const [data, original, output] = process.argv.slice(2);
const sample = await read(original);
const progress = {};
for (const user of sample.users) {
  const run = user === 'U03' ? 'g1pp-eg-3' : 'g1pp-eg-2';
  progress[user] = await read(`/srv/evimed/runs/${run}/cases/${user}/progress.json`, { sessions: 0, answered: [] });
}
const observed = sample.users.flatMap(u => progress[u].answered);
const removed = sample.questions.filter(q => q.user === 'U03' && q.checkpoint > 100);
if (removed.some(q => observed.includes(q.qid))) throw new Error('Cannot exclude an observed outcome');
const questions = sample.questions.filter(q => !removed.includes(q));
const pool = [];
for (const user of sample.users.filter(u => u !== 'U03')) {
  const gold = await read(`${data}/dev/${user}/gold.json`);
  pool.push(...gold.questions.filter(q => q.checkpoint > progress[user].sessions + 1).map(q => ({ user, qid: q.qid, category: q.category, checkpoint: q.checkpoint })));
}
while (questions.length < 100) {
  const counts = key => value => questions.filter(q => q[key] === value).length;
  const candidates = pool.filter(q => !questions.some(s => s.qid === q.qid)).sort((a, b) => counts('category')(a.category) - counts('category')(b.category)
    || counts('user')(a.user) - counts('user')(b.user) || a.checkpoint - b.checkpoint || a.qid.localeCompare(b.qid));
  if (!candidates.length) throw new Error('Insufficient future-checkpoint replacement questions');
  questions.push(candidates[0]);
}
if (new Set(questions.map(q => q.category)).size !== sample.categories.length || observed.some(q => !questions.some(s => s.qid === q))) throw new Error('Coverage/observed-question invariant failed');
await save(output, { ...sample, questions, policy: 'Category-stratified resource amendment: preserve observed probes; U03 through session 100; replace its unasked later probes by underrepresented categories in shorter users at future checkpoints.',
  amendment: { at: new Date().toISOString(), source: original, sourceSha256: createHash('sha256').update(await fs.readFile(original)).digest('hex'),
    reason: 'Ordinary source tasks take minutes on the real product path; redundant late strata need not force U03 to session 200. No answer or score content used.',
    retainedObserved: observed, removed: removed.map(q => q.qid), added: questions.filter(q => !sample.questions.some(s => s.qid === q.qid)).map(q => q.qid), progress },
  allocation: Object.fromEntries(sample.users.map(u => [u, { questions: questions.filter(q => q.user === u).length, sessions: Math.max(...questions.filter(q => q.user === u).map(q => q.checkpoint)) }])) });
console.log(JSON.stringify((await read(output)).allocation));
