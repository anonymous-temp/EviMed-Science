#!/usr/bin/env node
/** Re-score archived answers with the current scorer; only judge requests may leave the process. */
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreRun, SCORER_VERSION } from './score.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async (fn, fallback = null) => { try { return await fn(); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const atomic = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, text, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};
const csvCell = value => {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = (columns, rows) => `${[columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export async function findRuns(root) {
  const found = [];
  const visit = async directory => {
    if (await optional(() => readJson(path.join(directory, 'run.json')))) {
      found.push(directory);
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  };
  await visit(path.resolve(root));
  return found.sort();
}

export function boundedJudgeFetch(fetchImpl, budget) {
  return async (...args) => {
    if (budget.used >= budget.limit) throw new Error('judge_call_limit_exceeded');
    budget.used += 1;
    return fetchImpl(...args);
  };
}

function oldScore(runDir, variant, rubric) {
  const directory = `${variant ? `scores.${variant}` : 'scores'}${rubric === 'official' ? '.official' : ''}`;
  return optional(() => readJson(path.join(runDir, directory, 'summary.json')));
}

function comparisonRow(manifest, old, current, scoreDirectory, judgeCalls) {
  const before = old?.answers ?? null, after = current?.answers ?? null;
  return {
    set: manifest.set,
    split: manifest.split,
    arm: manifest.arm ?? 'unknown',
    runId: manifest.runId,
    oldN: before?.n ?? null,
    oldPass: before?.pass ?? null,
    oldFail: before?.fail ?? null,
    oldUnknown: before?.unknown ?? null,
    oldAccuracy: before?.accuracy ?? null,
    newN: after?.n ?? null,
    newPass: after?.pass ?? null,
    newFail: after?.fail ?? null,
    newUnknown: after?.unknown ?? null,
    newError: after?.error ?? null,
    newUnobserved: after?.unobserved ?? null,
    newNotIngestedYet: after?.not_ingested_yet ?? null,
    newAccuracy: after?.accuracy ?? null,
    accuracyDelta: before?.accuracy == null || after?.accuracy == null ? null : after.accuracy - before.accuracy,
    oldScoreStatus: old ? 'read' : 'missing',
    scoreDirectory,
    judgePackets: current?.judge?.packets ?? null,
    judgeCompleted: current?.judge?.completed ?? null,
    judgePending: current?.judge?.pending ?? null,
    judgeCalls,
  };
}

const COLUMNS = ['set', 'split', 'arm', 'runId', 'oldN', 'oldPass', 'oldFail', 'oldUnknown', 'oldAccuracy',
  'newN', 'newPass', 'newFail', 'newUnknown', 'newError', 'newUnobserved', 'newNotIngestedYet', 'newAccuracy',
  'accuracyDelta', 'oldScoreStatus', 'scoreDirectory', 'judgePackets', 'judgeCompleted', 'judgePending', 'judgeCalls'];
const number = value => value == null ? '' : String(value);

export function comparisonMarkdown(rows) {
  const header = '| Dataset | Split | Arm | Run | Old n / accuracy | New n / accuracy | Delta | Judge calls |\n|---|---|---|---|---:|---:|---:|---:|';
  const lines = rows.map(row => `| ${row.set} | ${row.split} | ${row.arm} | ${row.runId} | ${number(row.oldN)} / ${number(row.oldAccuracy)} | ${number(row.newN)} / ${number(row.newAccuracy)} | ${number(row.accuracyDelta)} | ${row.judgeCalls} |`);
  return `${header}${lines.length ? `\n${lines.join('\n')}` : ''}\n`;
}

export async function rejudgeHistory({ input, runs, data, out, judgeKeyFile, maxJudgeCalls = 0,
  judgeConcurrency = 6, judgeBatchSize = 6, variant, rubric = 'approximate', fetchImpl = globalThis.fetch } = {}) {
  if (!data || !out || (!input && !runs?.length) || (input && runs?.length)) throw new Error('input_or_runs_data_and_out_required');
  if (!Number.isSafeInteger(maxJudgeCalls) || maxJudgeCalls < 0) throw new Error('judge_call_limit_invalid');
  if (maxJudgeCalls > 0 && !judgeKeyFile) throw new Error('judge_key_required_for_judging');
  data = path.resolve(data); out = path.resolve(out);
  const directories = runs?.length ? runs.map(run => path.resolve(run)) : await findRuns(input);
  if (!directories.length) throw new Error('historical_runs_not_found');
  if (directories.some(directory => inside(out, directory) || inside(directory, out))) throw new Error('output_must_be_separate_from_input');
  if (inside(out, data) || inside(data, out)) throw new Error('output_must_be_separate_from_data');
  // A new directory prevents an accidental overwrite of a previous final rescoring.
  await mkdir(out, { mode: 0o700 });
  const budget = { used: 0, limit: maxJudgeCalls };
  const limitedFetch = boundedJudgeFetch(fetchImpl, budget);
  const comparisons = [];
  for (const [index, runDir] of directories.entries()) {
    const manifest = await readJson(path.join(runDir, 'run.json'));
    const old = await oldScore(runDir, variant, rubric);
    const relative = `${String(index + 1).padStart(4, '0')}-${String(manifest.runId).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const scoreDirectory = path.join(out, 'runs', relative);
    const beforeCalls = budget.used;
    const scored = await scoreRun({ run: runDir, data, out: scoreDirectory, variant, rubric,
      noJudge: maxJudgeCalls === 0, judgeKeyFile, fetchImpl: limitedFetch, judgeConcurrency, judgeBatchSize });
    comparisons.push(comparisonRow(manifest, old, scored.summary, path.relative(out, scoreDirectory), budget.used - beforeCalls));
  }
  const summary = { schema: 'capsule-proving-history-rejudge/1', scorerVersion: SCORER_VERSION,
    maxJudgeCalls, judgeCalls: budget.used, judgeCallLimitReached: budget.used >= maxJudgeCalls && comparisons.some(row => row.judgePending > 0), runs: comparisons };
  await atomic(path.join(out, 'comparison.csv'), csv(COLUMNS, comparisons));
  await atomic(path.join(out, 'comparison.md'), comparisonMarkdown(comparisons));
  await atomic(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function parseArgs(args) {
  const options = {}, names = { '--input': 'input', '--data': 'data', '--out': 'out', '--judge-key-file': 'judgeKeyFile',
    '--max-judge-calls': 'maxJudgeCalls', '--judge-concurrency': 'judgeConcurrency', '--judge-batch-size': 'judgeBatchSize', '--variant': 'variant', '--rubric': 'rubric' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') {
      if (options.runs || !args[i + 1]) throw new Error('runs_invalid');
      options.runs = args[++i].split(',').map(value => value.trim()).filter(Boolean);
      if (!options.runs.length) throw new Error('runs_invalid');
      continue;
    }
    const name = names[args[i]], value = args[++i];
    if (!name || !value || value.startsWith('--') || options[name] !== undefined) throw new Error('Usage: rejudge-history.mjs (--input ARCHIVE_ROOT | --runs DIR1,DIR2) --data DATA --out NEW_DIR [--judge-key-file FILE --max-judge-calls N] [--variant NAME] [--rubric approximate|official]');
    options[name] = ['maxJudgeCalls', 'judgeConcurrency', 'judgeBatchSize'].includes(name) ? Number(value) : value;
  }
  options.maxJudgeCalls ??= 0;
  if (!Number.isSafeInteger(options.maxJudgeCalls) || options.maxJudgeCalls < 0) throw new Error('judge_call_limit_invalid');
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const summary = await rejudgeHistory(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Rejudged ${summary.runs.length} runs with ${summary.judgeCalls}/${summary.maxJudgeCalls} judge calls.\n`);
    if (summary.runs.some(row => row.judgePending > 0)) {
      process.stderr.write('Some judge packets remain pending; rerun to another new directory with a larger call limit.\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`rejudge-history: ${error.message}\n`);
    process.exitCode = 1;
  }
}
