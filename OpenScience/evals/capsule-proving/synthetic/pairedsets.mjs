#!/usr/bin/env node
/**
 * Paired evaluation sets M6, M7, M11 and G9 of the capsule proving plan, written by the generator model and checked by code.
 *
 *   node synthetic/pairedsets.mjs --set m6|m7|m11|g9 --split dev|sealed --out DIR [--count N] [--count2 N] [--per K] [--concurrency 2]
 *
 * Output `<out>/<set>-<split>/`: `input.json` (what a runtime sees), `gold.json` (what a scorer reads), `manifest.json` (counts, generator,
 * sha256); M7 also writes `cases.json` in the schema of `evals/remembered-format/cases.json`. G9 holds poisoning (`--count`) and
 * sycophancy (`--count2`) items in the same files, told apart by `kind`. Sealed prints counts only. Resumable: every batch is a
 * file; finished steps are appended to `<out>/STATUS`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR, KIMI_MODEL, callKimi } from './kimi.mjs';
import * as core from './pairedsetsCore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_FILE = resolve(here, '../../../packages/domain/src/clinical-safety-rules.json');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
const set = args.set;
const split = args.split ?? 'dev';
if (!['m6', 'm7', 'm11', 'g9'].includes(set)) throw new Error('--set must be m6, m7, m11 or g9');
if (!['dev', 'sealed'].includes(split)) throw new Error('--split must be dev or sealed');
const out = args.out ?? (() => { throw new Error('--out required'); })();
const sealed = split === 'sealed';
const root = join(out, `${set}-${split}`);
mkdirSync(root, { recursive: true });
const now = () => new Date().toISOString();
const status = (line) => appendFileSync(join(out, 'STATUS'), `${now()} ${split} DONE ${set} ${line}\n`);
const say = (line) => process.stdout.write(`${now()} ${set}-${split} ${line}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
const sha = (f) => createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
const n = (key, fallback) => Number(args[key] ?? fallback);

/** A track is one kind of item: its seeded specs, the batch size, the prompt, the validator and the builder. */
function tracks() {
  if (set === 'm6') {
    const rules = core.loadRules(RULES_FILE);
    const specs = core.m6Specs({ split, count: n('count', core.COUNTS.m6[split]), rules });
    return [{ name: 'm6', key: 'items', specs, per: n('per', 3), prompt: (s, p) => core.m6Prompt(s, rules, p), problems: (it, s) => core.m6Problems(it, s, rules), build: (it, s, id) => core.m6Build(it, s, id, rules) }];
  }
  if (set === 'm7') {
    const specs = core.m7Specs({ split, count: n('count', core.COUNTS.m7[split]) });
    return [{ name: 'm7', key: 'cases', specs, per: n('per', 2), prompt: core.m7Prompt, problems: core.m7Problems, build: core.m7Build }];
  }
  if (set === 'm11') {
    const vocab = core.medicalVocabulary(RULES_FILE);
    const specs = core.m11Specs({ split, count: n('count', core.COUNTS.m11[split]) });
    return [{ name: 'm11', key: 'items', specs, per: n('per', 2), prompt: core.m11Prompt, problems: (it, s) => core.m11Problems(it, s, vocab), build: core.m11Build }];
  }
  return [
    { name: 'poison', key: 'items', specs: core.poisonSpecs({ split, count: n('count', core.COUNTS.g9[split]) }), per: n('per', 2), prompt: core.poisonPrompt, problems: core.poisonProblems, build: core.poisonBuild },
    { name: 'syco', key: 'items', specs: core.sycoSpecs({ split, count: n('count2', core.COUNTS.g9syco[split]) }), per: n('per', 2), prompt: core.sycoPrompt, problems: core.sycoProblems, build: core.sycoBuild },
  ];
}
const trackList = tracks();

const jobs = [];
for (const t of trackList) for (let i = 0; i < t.specs.length; i += t.per) jobs.push({ t, k: Math.floor(i / t.per), specs: t.specs.slice(i, i + t.per) });
const batchFile = ({ t, k }) => join(root, `${t.name}-b${String(k).padStart(2, '0')}.json`);
const stats = { calls: 0, retries: 0, failedCalls: 0, failedBatches: 0 };
let next = 0;
await Promise.all(Array.from({ length: Math.min(2, n('concurrency', 2)) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    const file = batchFile(job);
    if (existsSync(file)) continue;
    const { t, specs } = job;
    let problems = '';
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      stats.calls++;
      if (attempt > 1) stats.retries++;
      const r = await callKimi(t.prompt(specs, problems));
      if (!r.ok || !Array.isArray(r.value?.[t.key])) { stats.failedCalls++; problems = r.ok ? `输出里没有 ${t.key} 数组` : r.error; say(`${t.name} b${job.k} attempt ${attempt}: unusable`); continue; }
      const items = r.value[t.key];
      const each = specs.map((s, i) => (items[i] ? t.problems(items[i], s) : ['missing item']));
      const bad = each.filter((x) => x.length).length;
      say(`${t.name} b${job.k} attempt ${attempt}: ${bad} of ${specs.length} items with problems (${Math.round(r.ms / 1000)} s)`);
      if (!bad) { writeJson(file, { track: t.name, batch: job.k, attempt, items: items.slice(0, specs.length) }); status(`${t.name} b${job.k}`); done = true; }
      else problems = each.map((x, i) => (x.length ? `第${i + 1}项：${x.slice(0, 6).join('；')}` : '')).filter(Boolean).join(' | ');
      if (!done && !sealed) say(`  ${problems.slice(0, 400)}`);
    }
    if (!done) { stats.failedBatches++; writeJson(join(root, `${t.name}-b${String(job.k).padStart(2, '0')}.problems.json`), { problems }); }
  }
}));

// Assemble: runtime input and gold stay in separate files; an unfinished batch leaves its items out and is counted.
const input = [];
const gold = [];
const cases = [];
const perTrack = {};
for (const t of trackList) {
  let made = 0;
  for (const job of jobs.filter((j) => j.t === t)) {
    const file = batchFile(job);
    if (!existsSync(file)) continue;
    readJson(file).items.forEach((it, i) => {
      const spec = job.specs[i];
      const id = `${set}-${split}-${t.name === 'm7' || t.name === 'm6' || t.name === 'm11' ? '' : `${t.name}-`}${String(++made).padStart(3, '0')}`;
      const built = t.build(it, spec, id);
      if (built.kase) { cases.push(built.kase); gold.push(built.gold); } else { input.push(built.input); gold.push(built.gold); }
    });
  }
  perTrack[t.name] = { planned: t.specs.length, made };
}
if (set === 'g9') {
  const bad = core.poisonInvariantProblems(input, gold.filter((g) => g.kind === 'poisoning'));
  if (bad.length) throw new Error(`poison invariant: ${bad.join('; ')}`);
}
const generator = GENERATOR;
if (set === 'm7') {
  writeJson(join(root, 'cases.json'), { schemaVersion: 1, note: `${split} paired cases for evals/remembered-format; extra fields (domain, citations) are ignored by its runner. Every name, number and date is invented.`, cases });
}
writeJson(join(root, 'input.json'), { schema: `capsule-proving-${set}-input/1`, split, items: set === 'm7' ? cases.map((c) => c.id) : input });
writeJson(join(root, 'gold.json'), { schema: `capsule-proving-${set}-gold/1`, split, items: gold });
const files = ['input.json', 'gold.json', ...(set === 'm7' ? ['cases.json'] : [])];
const questions = gold.reduce((a, g) => a + (g.questions?.length ?? 0), 0);
writeJson(join(root, 'manifest.json'), { set, split, generator, items: gold.length, perTrack, questions, stats, sha256: Object.fromEntries(files.map((f) => [f, sha(f)])) });
status(`assemble (${gold.length} items; ${Object.entries(perTrack).map(([k, v]) => `${k} ${v.made}/${v.planned}`).join(', ')}; ${stats.failedBatches} batches failed)`);
say(`assembled ${gold.length} items, ${stats.calls} calls, ${stats.retries} retries, ${stats.failedBatches} batches failed`);
if (stats.failedBatches) process.exitCode = 1;
