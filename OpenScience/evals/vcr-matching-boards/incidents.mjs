#!/usr/bin/env node
/**
 * The incidents as cases (principle 6): `incidents.json` holds synthetic records and trials built from customer feedback, red-team ideas and the defects the first
 * real runs found, each with what the saved judgment must say. They run through the feature's own job (`dev_job.mjs`, fit then clauses for every pair), each case
 * `--repeat` times under its own patient id, and what is checked is the saved fit, verdict, clause labels and whether a clause names the sentences behind it.
 *
 *   node incidents.mjs --work <dir> --db-name <scratch db> --key-file <deepseek> [--repeat 3]
 *
 * Paid: 17 pairs, each read twice; about CNY 0.03 a pair off-peak. Exit 0 when every repeat of every case holds; a case that fails is a finding to read, not a reason
 * to edit its expectation.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail } from './board_cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @param {any} row @param {string} words */
const clauseMatches = (row, words) => String(row.clause ?? '').toLowerCase().includes(words.toLowerCase());

/**
 * What is wrong with one saved judgment against one case's expectations. Pure.
 * @param {any} expect @param {any} entry the ranking entry of the pair, with `criteria`
 * @returns {string[]}
 */
export function findings(expect, entry) {
  if (!entry) return ['no judgment saved'];
  const out = [];
  const { fit, verdict, verdictNot, clauses } = expect;
  if (fit?.min != null && !(Number(entry.fit) >= fit.min)) out.push(`fit ${entry.fit} is below ${fit.min}`);
  if (fit?.max != null && !(Number(entry.fit) <= fit.max)) out.push(`fit ${entry.fit} is above ${fit.max}`);
  if (verdict && !verdict.includes(entry.verdict)) out.push(`verdict ${entry.verdict}, wanted ${verdict.join(' or ')}`);
  if (verdictNot?.includes(entry.verdict)) out.push(`verdict ${entry.verdict}`);
  for (const want of clauses ?? []) {
    const row = (entry.criteria ?? []).find((candidate) => clauseMatches(candidate, want.contains));
    if (!row) { out.push(`no clause holds "${want.contains}"`); continue; }
    const label = String(row.label ?? '').replaceAll('_', ' ');
    if (!want.labels.includes(label)) out.push(`"${want.contains}": ${label}, wanted ${want.labels.join(' or ')}`);
    if (want.evidence && !(row.sentenceIds ?? []).length) out.push(`"${want.contains}": no sentence behind it`);
  }
  return out;
}

/**
 * The cases as a small board in the prepared shape: one collection of their trials, one patient per case and repeat.
 * @param {Array<Record<string, any>>} cases @param {string} dir @param {number} repeat @param {string} python
 */
export function buildBoard(cases, dir, repeat, python) {
  const trials = path.join(dir, 'trials');
  fs.mkdirSync(trials, { recursive: true });
  /** @type {string[]} */
  const rows = [];
  cases.forEach((one, index) => {
    const nctid = `NCT9${String(index + 1).padStart(7, '0')}`;
    fs.writeFileSync(path.join(trials, `${nctid}.json`), JSON.stringify({ nctid, study_type: 'INTERVENTIONAL', phases: ['PHASE2'], overall_status: 'RECRUITING', ...one.trial }));
    for (let turn = 1; turn <= repeat; turn += 1) {
      const patientId = `inc-${one.id}-${turn}`;
      rows.push(JSON.stringify({ caseId: patientId, patientId, cohort: 'sigir', collection: 'tg2-sigir', split: 'dev', note: one.note, candidateIds: [nctid], candidateCount: 1 }));
    }
  });
  const built = spawnSync(python, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import prepare; prepare.build_collection(${JSON.stringify(trials)}, ${JSON.stringify(path.join(dir, 'boards', 'collections', 'tg2-sigir'))}, 'sigir')`], { encoding: 'utf8' });
  if (built.status !== 0) throw fail(String(built.stderr).slice(0, 400), 'collection_failed');
  fs.mkdirSync(path.join(dir, 'boards', 'A-sigir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'boards', 'A-sigir', 'cases.jsonl'), `${rows.join('\n')}\n`);
  return path.join(dir, 'boards');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    work: { type: 'string' }, 'db-name': { type: 'string' }, 'key-file': { type: 'string' }, repeat: { type: 'string', default: '3' }, arm: { type: 'string', default: 'incidents' },
    python: { type: 'string', default: process.env.VCR_BOARDS_PYTHON ?? 'python3' }, 'cap-cny': { type: 'string', default: '20' }, 'allow-peak': { type: 'boolean', default: false },
  } });
  if (!values.work || !values['db-name'] || !values['key-file']) throw fail('--work, --db-name and --key-file are required.', 'option_missing');
  const work = path.resolve(values.work);
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'incidents.json'), 'utf8'));
  const repeat = Number(values.repeat);
  const boards = buildBoard(cases, work, repeat, String(values.python));
  const out = path.join(work, values.arm);
  const args = ['dev_job.mjs', '--board', 'sigir', '--boards', boards, '--arm', values.arm, '--split', 'all', '--mode', 'both', '--thinking', 'off', '--thinking-criteria', 'high', '--top-k', '1',
    '--concurrency', '6', '--score', 'no', '--cap-cny', String(values['cap-cny']), '--db-name', values['db-name'], '--data-dir', path.join(work, 'data'), '--out', out, '--key-file', path.resolve(values['key-file']),
    ...(values['allow-peak'] ? ['--allow-peak'] : [])];
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (code !== 0) { process.stderr.write(`[incidents] the job ended ${code}\n`); return 1; }
  const records = new Map(fs.readFileSync(path.join(out, 'judgments.jsonl'), 'utf8').split('\n').filter((line) => line.trim()).map((line) => { const row = JSON.parse(line); return [row.patientId, row]; }));
  const report = cases.map((/** @type {any} */ one) => {
    const turns = Array.from({ length: repeat }, (_, index) => {
      const entry = records.get(`inc-${one.id}-${index + 1}`)?.ranking?.[0];
      return { fit: entry?.fit ?? null, verdict: entry?.verdict ?? null, findings: findings(one.expect, entry) };
    });
    return { id: one.id, source: one.source, held: turns.filter((turn) => !turn.findings.length).length, of: repeat, turns };
  });
  fs.writeFileSync(path.join(work, `${values.arm}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  for (const row of report) process.stdout.write(`${row.held === row.of ? 'held ' : 'FAIL '} ${row.held}/${row.of} ${row.id}${row.held === row.of ? '' : `: ${[...new Set(row.turns.flatMap((turn) => turn.findings))].join('; ')}`}\n`);
  return report.every((row) => row.held === row.of) ? 0 : 4;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
