#!/usr/bin/env node
/**
 * How the feature's real job behaves at size, with no paid call: a local stand-in answers as the model would (`fake_provider.mjs`) and everything else is real, the notes staged
 * through the data plane, the job, the ledger, PostgreSQL. It measures the wall clock, the peak memory of the process that runs the job and the size of the database.
 *
 *   node scale.mjs --work <dir> --db-name <scratch db> --shape people --size 300
 *   node scale.mjs --work <dir> --db-name <scratch db> --shape people --size 5000
 *   node scale.mjs --work <dir> --db-name <scratch db> --shape candidates --size 500
 *
 * `people` is one protocol against many synthetic records, `candidates` is one person against many synthetic trials. Writes `<work>/<shape>-<size>.json`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail } from './board_cases.mjs';
import { startFakeProvider } from './fake_provider.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One synthetic record, with no real person in it. @param {number} index */
export function syntheticRecord(index) {
  const age = 30 + (index % 50);
  return [`A ${age}-year-old ${index % 2 ? 'woman' : 'man'} with type 2 diabetes mellitus for ${1 + (index % 20)} years.`, `HbA1c is ${(6 + (index % 40) / 10).toFixed(1)}%.`,
    `Creatinine is ${(0.7 + (index % 30) / 20).toFixed(2)} mg/dL.`, index % 7 ? 'There is no history of myocardial infarction.' : 'A myocardial infarction was recorded three years ago.'].join('\n');
}

/** @param {string} dir @param {number} size */
function peopleBoard(dir, size) {
  const board = path.join(dir, 'F-n2c2');
  fs.mkdirSync(board, { recursive: true });
  const lines = Array.from({ length: size }, (_, index) => {
    const patientId = `scale-${index + 1}`;
    const text = syntheticRecord(index);
    return JSON.stringify({ caseId: patientId, patientId, cohort: 'n2c2', split: 'train-dev', records: [{ date: '2020-01-01', text }], chars: text.length });
  });
  fs.writeFileSync(path.join(board, 'cases.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(board, 'manifest.json'), JSON.stringify({ board: 'F-n2c2', synthetic: true }));
  return ['--board', 'n2c2', '--n2c2-boards', dir, '--split', 'train-dev', '--mode', 'criteria', '--thinking', 'off'];
}

/** @param {string} dir @param {number} size @param {string} python */
function candidatesBoard(dir, size, python) {
  const trials = path.join(dir, 'trials');
  fs.mkdirSync(trials, { recursive: true });
  const ids = Array.from({ length: size }, (_, index) => `NCT9${String(index + 1).padStart(7, '0')}`);
  for (const nctid of ids) {
    fs.writeFileSync(path.join(trials, `${nctid}.json`), JSON.stringify({ nctid, title: `Synthetic trial ${nctid}`, brief_summary: 'A synthetic summary.',
      raw_criteria: 'Inclusion Criteria:\n\n* Type 2 diabetes mellitus\n* HbA1c above 7%\n\nExclusion Criteria:\n\n* Pregnancy\n* Dialysis', study_type: 'INTERVENTIONAL', phases: ['PHASE2'], condition: ['Type 2 Diabetes'], minimum_age: '18 Years', maximum_age: '', sex: 'ALL', overall_status: 'RECRUITING' }));
  }
  const built = spawnSync(python, ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(HERE)}); import prepare; prepare.build_collection(${JSON.stringify(trials)}, ${JSON.stringify(path.join(dir, 'collections', 'tg2-sigir'))}, 'sigir')`], { encoding: 'utf8' });
  if (built.status !== 0) throw fail(String(built.stderr).slice(0, 400), 'collection_failed');
  fs.mkdirSync(path.join(dir, 'A-sigir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'A-sigir', 'cases.jsonl'), `${JSON.stringify({ caseId: 'scale-1', patientId: 'scale-1', cohort: 'sigir', collection: 'tg2-sigir', split: 'dev', note: syntheticRecord(1), candidateIds: ids, candidateCount: ids.length })}\n`);
  return ['--board', 'sigir', '--boards', dir, '--split', 'all', '--mode', 'both', '--thinking', 'off', '--thinking-criteria', 'off', '--top-k', '20'];
}

/** The resident memory of a process in MB, or null when it has gone. @param {number} pid */
function residentMb(pid) {
  try {
    const found = /VmRSS:\s+(\d+) kB/u.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return found ? Number(found[1]) / 1024 : null;
  } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    work: { type: 'string' }, 'db-name': { type: 'string' }, shape: { type: 'string' }, size: { type: 'string' }, 'latency-ms': { type: 'string', default: '200' }, concurrency: { type: 'string', default: '16' },
    python: { type: 'string', default: process.env.VCR_BOARDS_PYTHON ?? 'python3' },
  } });
  if (!values.work || !values['db-name'] || !['people', 'candidates'].includes(String(values.shape)) || !values.size) throw fail('--work, --db-name, --shape people|candidates and --size are required.', 'option_missing');
  const size = Number(values.size);
  const name = `${values.shape}-${size}`;
  const dir = path.join(path.resolve(values.work), name);
  fs.mkdirSync(dir, { recursive: true });
  const shape = values.shape === 'people' ? peopleBoard(dir, size) : candidatesBoard(dir, size, String(values.python));
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'scale-not-a-key');
  const provider = await startFakeProvider({ latencyMs: Number(values['latency-ms']) });
  const started = Date.now();
  let peak = 0;
  const child = spawn(process.execPath, ['dev_job.mjs', ...shape, '--arm', name, '--concurrency', String(values.concurrency), '--worker-batches', '--score', 'no', '--allow-peak', '--cap-cny', '100000', '--floor-cny', '0',
    '--base-url', provider.url, '--key-file', keyFile, '--db-name', String(values['db-name']), '--data-dir', path.join(dir, 'data'), '--out', path.join(dir, 'out')], { cwd: HERE, stdio: ['ignore', 'inherit', 'inherit'] });
  const sampler = setInterval(() => { peak = Math.max(peak, residentMb(Number(child.pid)) ?? 0); }, 2000);
  const code = await new Promise((resolve) => { child.once('close', (status) => resolve(status ?? 1)); });
  clearInterval(sampler);
  const calls = provider.requests.length, violations = provider.violations.length;
  await provider.close();
  const server = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ? Object.assign(new URL(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL), { pathname: '/postgres' }).href : null;
  const database = server ? spawnSync('psql', [server, '-Atc', `select pg_size_pretty(pg_database_size('${values['db-name']}'))`], { encoding: 'utf8' }).stdout.trim() : null;
  let judged = null;
  try { judged = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'summary.json'), 'utf8')); } catch { /* the job says why in its own log */ }
  const report = { shape: values.shape, size, exitCode: code, minutes: Number(((Date.now() - started) / 60000).toFixed(1)), peakMemoryMb: Math.round(peak), modelCalls: calls, violations, database, latencyMs: Number(values['latency-ms']), concurrency: Number(values.concurrency), summary: judged && { status: judged.status ?? null, patients: judged.patients ?? null, failedPairs: judged.failedPairs ?? null } };
  fs.writeFileSync(path.join(path.resolve(values.work), `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return code === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
