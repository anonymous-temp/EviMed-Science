#!/usr/bin/env node
/** Export MedMemoryBench multiple-choice gold for human review and recompute valid-only scores from the labels. */
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGold, caseEvidence } from './score.mjs';
import { findRuns } from './rejudge-history.mjs';

const REVIEW_VALUES = new Set(['对', '错', '有歧义']);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const readLines = async file => (await readFile(file, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const optional = async (fn, fallback = null) => { try { return await fn(); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const atomic = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, text, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
};
const cell = value => {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const csvText = (columns, rows) => `${[columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(cell).join(',')).join('\n')}\n`;

export function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') {
      if (value) throw new Error('review_csv_quote_invalid');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(value); value = '';
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      if (char !== ',') { rows.push(row); row = []; }
    } else value += char;
  }
  if (quoted) throw new Error('review_csv_quote_invalid');
  if (value || row.length) { row.push(value); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  if (new Set(header).size !== header.length) throw new Error('review_csv_header_invalid');
  return rows.slice(1).filter(values => values.some(Boolean)).map(values => {
    if (values.length !== header.length) throw new Error('review_csv_row_width_invalid');
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

const languageOf = manifest => manifest.options?.variant ?? manifest.options?.language ?? 'zh';
const optionLabel = index => {
  let value = index + 1, label = '';
  while (value) { value -= 1; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
};
const markdownText = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
const scoreDirectory = (runDir, variant) => path.join(runDir, variant ? `scores.${variant}` : 'scores');

async function runRecords({ input, runs, data, variant, sources, pools }) {
  const directories = runs?.length ? runs.map(run => path.resolve(run)) : await findRuns(input);
  if (!directories.length) throw new Error('historical_runs_not_found');
  const records = [];
  for (const runDir of directories) {
    const manifest = await readJson(path.join(runDir, 'run.json'));
    if (manifest.set !== 'medmemorybench') throw new Error('medmemorybench_run_required');
    if (!manifest.runId || records.some(record => record.manifest.runId === manifest.runId)) throw new Error('duplicate_run_id');
    const entries = await loadGold(data, manifest, { sources, pools });
    const rows = await optional(() => readLines(path.join(scoreDirectory(runDir, variant), 'rows.jsonl')), []);
    const evidence = new Map();
    for (const entry of entries) evidence.set(entry.caseId, await caseEvidence(runDir, entry.caseId, variant));
    records.push({ runDir, manifest, entries, rows, evidence, language: languageOf(manifest) });
  }
  return records;
}

export async function exportMultipleChoiceReview({ input, runs, data, out, variant, sources, pools } = {}) {
  if (!data || !out || (!input && !runs?.length) || (input && runs?.length)) throw new Error('input_or_runs_data_and_out_required');
  const records = await runRecords({ input, runs, data, variant, sources, pools });
  const questions = new Map();
  for (const record of records) {
    for (const entry of record.entries) for (const question of entry.gold.questions ?? []) {
      if (question.category !== 'multiple_choice') continue;
      const gold = question.official;
      if (!Array.isArray(gold?.answers) || !gold.answers.length) throw new Error('multiple_choice_options_missing');
      const id = question.qid;
      if (!questions.has(id)) {
        const options = gold.answers.map((answer, index) => ({ option: optionLabel(index), content: answer.content, is_correct: answer.is_correct, explanation: answer.explanation ?? null }));
        questions.set(id, { question_id: id, case_id: entry.caseId, language: record.language, split: record.manifest.split,
          question: question.question, options_json: options,
          gold_option_ids: options.filter(option => option.is_correct === true).map(option => option.option),
          gold_contents: options.filter(option => option.is_correct === true).map(option => option.content),
          source_key_points_json: gold.source_key_points ?? [], review_status: '', review_note: '', answers: {} });
      }
      const target = questions.get(id);
      if (target.case_id !== entry.caseId || target.question !== question.question) throw new Error('review_question_identity_conflict');
      const answers = record.evidence.get(entry.caseId).answers.filter(answer => answer.qid === id);
      if (answers.length > 1) throw new Error('ambiguous_answer');
      const answer = answers[0] ?? null;
      const old = record.rows.find(row => row.kind === 'answer' && row.id === id);
      target.answers[record.manifest.runId] = { answer: answer?.answer ?? '', error: answer?.error ?? null,
        answerStatus: answer ? answer.error ? 'error' : 'answered' : 'missing', oldVerdict: old?.verdict ?? null };
    }
  }
  if (!questions.size) throw new Error('multiple_choice_questions_not_found');
  await mkdir(out, { mode: 0o700 });
  const runColumns = records.map(record => record.manifest.runId);
  const columns = ['question_id', 'case_id', 'language', 'split', 'question', 'options_json', 'gold_option_ids', 'gold_contents', 'source_key_points_json', 'review_status', 'review_note',
    ...runColumns.flatMap(runId => [`answer:${runId}`, `answer_status:${runId}`, `old_verdict:${runId}`])];
  const rows = [...questions.values()].sort((a, b) => a.question_id.localeCompare(b.question_id)).map(question => ({
    ...Object.fromEntries(Object.entries(question).filter(([key]) => key !== 'answers')),
    ...Object.fromEntries(runColumns.flatMap(runId => {
      const answer = question.answers[runId];
      return [[`answer:${runId}`, answer?.answer ?? ''], [`answer_status:${runId}`, answer?.answerStatus ?? 'not_in_run'], [`old_verdict:${runId}`, answer?.oldVerdict ?? '']];
    })),
  }));
  const manifest = { schema: 'capsule-proving-medmemory-multiple-review/1', variant: variant ?? null,
    columns, runs: records.map(record => ({ runId: record.manifest.runId, arm: record.manifest.arm ?? 'unknown', runDir: record.runDir,
      scoreDirectory: scoreDirectory(record.runDir, variant) })) };
  await atomic(path.join(out, 'review.csv'), csvText(columns, rows));
  const answerHeaders = records.map(record => `${record.manifest.arm} (${record.manifest.runId})`);
  const mdHeader = ['Question id', 'Question', 'Options', 'Gold', ...answerHeaders, 'Review', 'Note'];
  const mdRows = rows.map(row => [row.question_id, row.question,
    row.options_json.map(option => `${option.option}. ${option.content}${option.is_correct ? ' [correct]' : ''}`).join('<br>'),
    `${row.gold_option_ids.join(', ')}: ${row.gold_contents.join('; ')}`,
    ...runColumns.map(runId => row[`answer:${runId}`]), '', ''].map(markdownText));
  await atomic(path.join(out, 'review.md'), `| ${mdHeader.join(' | ')} |\n| ${mdHeader.map(() => '---').join(' | ')} |\n${mdRows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`);
  await atomic(path.join(out, 'runs.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { questions: rows.length, runs: records.length, columns };
}

function stats(rows) {
  const originalPass = rows.filter(row => row.originalVerdict === 'pass').length;
  const valid = rows.filter(row => row.reviewStatus === '对');
  const reviewedPass = valid.filter(row => row.verdict === 'pass').length;
  return { n: rows.length, originalPass, originalAccuracy: rows.length ? originalPass / rows.length : null,
    nValid: valid.length, reviewedPass, accuracyValid: valid.length ? reviewedPass / valid.length : null,
    goldCorrect: valid.length, goldIncorrect: rows.filter(row => row.reviewStatus === '错').length,
    goldAmbiguous: rows.filter(row => row.reviewStatus === '有歧义').length,
    reviewPending: rows.filter(row => row.reviewStatus === '').length };
}

export async function rescoreMultipleChoiceReview({ reviewDir, out, allowPartial = false } = {}) {
  if (!reviewDir || !out) throw new Error('review_dir_and_out_required');
  const manifest = await readJson(path.join(path.resolve(reviewDir), 'runs.json'));
  const reviewed = await parseCsv(await readFile(path.join(path.resolve(reviewDir), 'review.csv'), 'utf8'));
  if (!reviewed.length) throw new Error('review_rows_empty');
  const byId = new Map();
  for (const row of reviewed) {
    if (!row.question_id || byId.has(row.question_id)) throw new Error('review_question_id_invalid');
    if (!REVIEW_VALUES.has(row.review_status) && row.review_status !== '') throw new Error('review_status_invalid');
    if (!row.review_status && !allowPartial) throw new Error(`review_pending:${row.question_id}`);
    byId.set(row.question_id, row);
  }
  await mkdir(out, { mode: 0o700 });
  const runSummaries = [];
  for (const run of manifest.runs) {
    const rows = await readLines(path.join(run.scoreDirectory, 'rows.jsonl'));
    const selected = rows.filter(row => row.kind === 'answer' && byId.has(row.id));
    const present = new Set(selected.map(row => row.id));
    for (const row of reviewed) if (row[`answer_status:${run.runId}`] !== 'not_in_run' && !present.has(row.question_id)) throw new Error(`score_row_missing:${run.runId}:${row.question_id}`);
    const output = selected.map(row => {
      const annotation = byId.get(row.id);
      const reviewedRow = { ...row, originalVerdict: row.verdict, reviewStatus: annotation.review_status, reviewNote: annotation.review_note };
      if (['错', '有歧义'].includes(annotation.review_status)) reviewedRow.verdict = 'invalid-item';
      return reviewedRow;
    });
    const directory = path.join(out, 'runs', run.runId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await atomic(path.join(directory, 'rows.jsonl'), output.map(row => `${JSON.stringify(row)}\n`).join(''));
    const summary = { runId: run.runId, arm: run.arm, ...stats(output) };
    await atomic(path.join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    runSummaries.push(summary);
  }
  const arms = Object.values(runSummaries.reduce((groups, row) => {
    const group = groups[row.arm] ??= { arm: row.arm, n: 0, originalPass: 0, nValid: 0, reviewedPass: 0, goldCorrect: 0, goldIncorrect: 0, goldAmbiguous: 0, reviewPending: 0 };
    for (const key of ['n', 'originalPass', 'nValid', 'reviewedPass', 'goldCorrect', 'goldIncorrect', 'goldAmbiguous', 'reviewPending']) group[key] += row[key];
    return groups;
  }, {})).map(group => ({ ...group, originalAccuracy: group.n ? group.originalPass / group.n : null,
    accuracyValid: group.nValid ? group.reviewedPass / group.nValid : null }));
  const columns = ['arm', 'runId', 'n', 'originalPass', 'originalAccuracy', 'nValid', 'reviewedPass', 'accuracyValid', 'goldCorrect', 'goldIncorrect', 'goldAmbiguous', 'reviewPending'];
  const summary = { schema: 'capsule-proving-medmemory-multiple-rescore/1', complete: runSummaries.every(row => row.reviewPending === 0),
    note: 'Original n and accuracy are retained. Only annotations marked 对 enter the valid-only denominator; 错 and 有歧义 remain visible and are not converted into passes.', runs: runSummaries, arms };
  await atomic(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await atomic(path.join(out, 'scores.csv'), csvText(columns, runSummaries));
  await atomic(path.join(out, 'scores.md'), `| Arm | Run | Original n / accuracy | Valid n / accuracy | Gold wrong | Ambiguous | Pending |\n|---|---|---:|---:|---:|---:|---:|\n${runSummaries.map(row => `| ${markdownText(row.arm)} | ${markdownText(row.runId)} | ${row.n} / ${row.originalAccuracy} | ${row.nValid} / ${row.accuracyValid} | ${row.goldIncorrect} | ${row.goldAmbiguous} | ${row.reviewPending} |`).join('\n')}\n`);
  return summary;
}

export function parseArgs(args) {
  const command = args[0];
  if (!['export', 'rescore'].includes(command)) throw new Error('command_required');
  const options = { command }, names = { '--input': 'input', '--data': 'data', '--out': 'out', '--review-dir': 'reviewDir', '--variant': 'variant' };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--allow-partial') { options.allowPartial = true; continue; }
    if (args[i] === '--runs') {
      const value = args[++i];
      if (!value) throw new Error('runs_invalid');
      options.runs = value.split(',').map(item => item.trim()).filter(Boolean);
      continue;
    }
    const name = names[args[i]], value = args[++i];
    if (!name || !value || value.startsWith('--') || options[name] !== undefined) throw new Error('Usage: review-medmemory-multiple.mjs export (--input ROOT | --runs DIR1,DIR2) --data DATA --out NEW_DIR [--variant NAME]; or rescore --review-dir DIR --out NEW_DIR [--allow-partial]');
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.command === 'export' ? await exportMultipleChoiceReview(options) : await rescoreMultipleChoiceReview(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`review-medmemory-multiple: ${error.message}\n`);
    process.exitCode = 1;
  }
}
