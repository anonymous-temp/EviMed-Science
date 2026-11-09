#!/usr/bin/env node
/**
 * Plan L3 (with/without methods, seven arms): learning tasks and exam tasks kept apart. The exam is 14 general and 6 medical
 * cases of `evals/general-tasks`; within each general family with more than one case, a seeded draw sends some to the exam
 * and holds the rest out for learning, so the exam measures families the account practised and families it never saw.
 * The repeated-task families (Kimi-written, `synthetic/tasks.mjs`) are learning material only.
 *
 *   node l3-split.mjs [--cases ../general-tasks/cases.json] [--out pools/l3-split-20261109.json]
 * @module capsule-proving/l3-split
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { rng } from './synthetic/spec.mjs';

export const L3_SEED = 'capsule-proving-20261109-v1:l3';
/** How many cases of each multi-case general family go to the exam; every single-case family goes to the exam whole. */
export const EXAM_PER_FAMILY = { writing: 2, data: 2, code: 1, 'office-docx': 1, 'office-pptx': 1, 'web-lookup': 1, 'web-report': 1 };
export const ARMS = [
  { id: 'A', label: 'no methods' }, { id: 'B', label: 'official, flat' }, { id: 'C', label: 'official, pyramid' },
  { id: 'D', label: 'pyramid + account learning' }, { id: 'E', label: 'flat + account learning (current)' },
  { id: 'F', label: 'append only, no consolidation' }, { id: 'G', label: 'OpenViking Agent Evolution' },
  { id: 'C+frame', label: 'official pyramid + framework instruction (small extra group)' },
];

/** @param {{ cases: { id: string, kind: string, family: string }[] }} doc */
export function splitL3(doc, seed = L3_SEED) {
  const r = rng(seed);
  const byFamily = new Map();
  for (const c of doc.cases) {
    const key = `${c.kind}:${c.family}`;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(c.id);
  }
  const exam = [];
  const learning = [];
  for (const [key, ids] of [...byFamily].sort(([a], [b]) => a.localeCompare(b))) {
    const [kind, family] = key.split(':');
    const sorted = [...ids].sort();
    if (kind === 'medical') { exam.push(...sorted); continue; }
    const take = EXAM_PER_FAMILY[family] ?? sorted.length;
    // Seeded Fisher–Yates over the family, then the first `take` are exam.
    for (let i = sorted.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sorted[i], sorted[j]] = [sorted[j], sorted[i]]; }
    exam.push(...sorted.slice(0, take));
    learning.push(...sorted.slice(take));
  }
  return { exam: exam.sort(), learning: learning.sort() };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
  const casesPath = args.cases ?? new URL('../general-tasks/cases.json', import.meta.url).pathname;
  const out = args.out ?? new URL('./pools/l3-split-20261109.json', import.meta.url).pathname;
  const raw = readFileSync(casesPath);
  const doc = JSON.parse(raw);
  const { exam, learning } = splitL3(doc);
  const kindOf = new Map(doc.cases.map((c) => [c.id, c.kind]));
  const examGeneral = exam.filter((id) => kindOf.get(id) === 'general').length;
  const examMedical = exam.filter((id) => kindOf.get(id) === 'medical').length;
  if (examGeneral !== 14 || examMedical !== 6) throw new Error(`exam must be 14 general + 6 medical, got ${examGeneral} + ${examMedical}`);
  const document = {
    schema: 'capsule-proving-l3-split/1', seed: L3_SEED, source: 'evals/general-tasks/cases.json',
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    exam, learning, learningFamilies: ['tasks-dev/families.json', 'tasks-sealed/families.json'],
    arms: ARMS, repeats: 2, runs: exam.length * 7 * 2,
    note: 'Learning material never includes an exam case. An arm that cannot be wired within one day is dropped and named (plan §5.5 L3).',
  };
  writeFileSync(out, `${JSON.stringify(document, null, 1)}\n`);
  console.log(`exam ${exam.length} (${examGeneral} general, ${examMedical} medical); learning ${learning.length}; runs ${document.runs}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
