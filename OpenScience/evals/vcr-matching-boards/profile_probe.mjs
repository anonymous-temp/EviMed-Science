#!/usr/bin/env node
/**
 * What the ranking text keeps of a long record. Discovery ranks with `patientRankingText`: the whole record when it fits in 6,000
 * characters, else a profile summary (one Flash call), else the newest whole sentences; before round 3 it was the first 8,000
 * characters (the oldest records). Ranking has no criterion-level gold, so this board asks how much eligibility information each text
 * still carries: one Flash call per text answers the n2c2 cohort-selection criteria met / not met from that text alone, scored against
 * the n2c2 gold. The whole record is the ceiling.
 *
 *   node profile_probe.mjs --cases <n2c2 cases.jsonl> --labels <labels.jsonl> --guide <guide.txt> --out <dir> --key-file <deepseek> [--cap 4]
 *
 * Off-peak only; a stop at --cap CNY. Writes only aggregates and the model's labels (no record text) to <out>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isPeak, priceUsage } from '@evimed/domain';
import { chatOnce } from './retrieve_e.mjs';
import { newestWindow } from '../../apps/server/src/patientMatchingProfile.mjs';
import { profileAnswer, profileMessages } from '../../apps/server/src/patientMatchingModels.mjs';

const CRITERIA = ['ABDOMINAL', 'ADVANCED-CAD', 'ALCOHOL-ABUSE', 'ASP-FOR-MI', 'CREATININE', 'DIETSUPP-2MOS', 'DRUG-ABUSE', 'ENGLISH', 'HBA1C', 'KETO-1YR', 'MAJOR-DIABETES', 'MAKES-DECISIONS', 'MI-6MOS'];
const VARIANTS = ['whole', 'oldest-8000', 'newest-6000', 'profile'];
const jsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const append = (file, row) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`);

function probeMessages(guide, text) {
  return [
    { role: 'system', content: [
      'You decide, for one patient, whether each cohort-selection criterion is met, using only the patient text given. The annotation guidelines below define each criterion.',
      'A criterion the text does not establish is "not met". Answer one JSON object whose keys are exactly these criterion names and whose values are "met" or "not met":',
      CRITERIA.join(', '), '', 'ANNOTATION GUIDELINES', guide].join('\n') },
    { role: 'user', content: `PATIENT TEXT\n${text}` },
  ];
}

async function main() {
  const { values: o } = parseArgs({ options: { cases: { type: 'string' }, labels: { type: 'string' }, guide: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, cap: { type: 'string', default: '4' } } });
  const now = new Date(), weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5, hour = now.getUTCHours();
  if (isPeak(now) || (weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)))) { console.log('peak window: refused'); process.exit(2); }
  fs.mkdirSync(o.out, { recursive: true });
  const key = fs.readFileSync(o['key-file'], 'utf8').trim(), guide = fs.readFileSync(o.guide, 'utf8').trim(), cap = Number(o.cap);
  const gold = new Map(jsonl(o.labels).map((row) => [row.patientId, row.tags]));
  const answersFile = path.join(o.out, 'answers.jsonl'), usageFile = path.join(o.out, 'usage.jsonl');
  const done = new Set(jsonl(answersFile).map((row) => `${row.patientId}|${row.variant}`));
  let spent = jsonl(usageFile).reduce((sum, row) => sum + row.costCny, 0);
  const call = async (messages, thinking = 'off') => {
    if (spent >= cap) throw new Error('cap reached');
    const answer = await chatOnce({ baseUrl: 'https://api.deepseek.com', apiKey: key, model: 'deepseek-flash', thinking, messages });
    const costCny = priceUsage({ resourceType: 'model', model: 'deepseek-flash', ...answer.usage, peak: false }).cost ?? 0;
    spent += costCny; append(usageFile, { at: new Date().toISOString(), ...answer.usage, costCny });
    return answer.content;
  };
  const cases = jsonl(o.cases);
  const work = async (row) => {
    const passages = row.records.map((record) => `Record date: ${record.date}\n${record.text}`);
    const whole = passages.join('\n');
    const texts = { whole, 'oldest-8000': `\n${whole}`.slice(0, 8000), 'newest-6000': newestWindow(passages.map((text) => ({ text })), 5999) };
    for (const variant of VARIANTS) {
      if (done.has(`${row.patientId}|${variant}`)) continue;
      let text = texts[variant];
      if (variant === 'profile') {
        const messages = profileMessages(passages);
        const profile = messages ? profileAnswer(await call(messages)) : null;
        text = profile ? `\n${profile.text}` : texts['newest-6000'];
      }
      let labels = null;
      try { labels = JSON.parse(await call(probeMessages(guide, text))); } catch { labels = null; }
      append(answersFile, { patientId: row.patientId, variant, chars: text.length, labels });
    }
  };
  const queue = [...cases];
  await Promise.all(Array.from({ length: 6 }, async () => { for (let row = queue.shift(); row; row = queue.shift()) await work(row); }));
  // Scores: accuracy over criteria and micro-F1 of "met" per variant.
  const rows = jsonl(answersFile), report = {};
  for (const variant of VARIANTS) {
    let correct = 0, total = 0, tp = 0, fp = 0, fn = 0; const chars = [];
    for (const row of rows.filter((item) => item.variant === variant)) {
      const tags = gold.get(row.patientId); if (!tags) continue;
      chars.push(row.chars);
      for (const name of CRITERIA) {
        const want = tags[name] === 'met', got = row.labels?.[name] === 'met';
        total += 1; correct += want === got ? 1 : 0; tp += want && got ? 1 : 0; fp += !want && got ? 1 : 0; fn += want && !got ? 1 : 0;
      }
    }
    chars.sort((a, b) => a - b);
    report[variant] = { patients: chars.length, medianChars: chars[Math.floor((chars.length - 1) / 2)] ?? null, accuracy: total ? correct / total : null, metF1: tp ? (2 * tp) / (2 * tp + fp + fn) : 0 };
  }
  fs.writeFileSync(path.join(o.out, 'report.json'), `${JSON.stringify({ report, spentCny: spent }, null, 2)}\n`);
  console.log(JSON.stringify({ report, spentCny: Number(spent.toFixed(3)) }, null, 2));
}

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
