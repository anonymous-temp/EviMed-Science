#!/usr/bin/env node
/**
 * Does the feature read real Chinese free text? No gold exists for it, so this is no accuracy figure: each note (`--notes`, private JSONL of `{ id, text }`, never in the repository)
 * goes the product's way: the model writes the search (`searchMessages`), a frozen registry snapshot answers it, the product's reranker orders the list, the feature's real job judges
 * the first `--top` trials and reads the clauses of the first `--top-k`. Only aggregates are written and printed: completion, verdicts, clause labels, evidence, the language of the reasons.
 *
 *   node zh_usability.mjs --notes <jsonl> --collection <dir with collection.json> --work <private dir> --db-name <scratch db> --key-file <deepseek> --dashscope-key-file <dashscope>
 *
 * Exit 0 when the job finished; a note that fails is a count in the report. Paid: about CNY 0.05 a note off-peak.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VcrCandidateRerank, rerankCandidates } from '../../apps/server/src/vcrCandidateRerank.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { fail } from './board_cases.mjs';
import { chatOnce, requestFromAnswer, searchMessages } from './retrieve_e.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RERANK_BASE = 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
const HAN = /[㐀-鿿]/u;

/**
 * The aggregates of the saved judgments of one run. Pure, and it keeps no text of a note or a reason.
 * @param {Array<Record<string, any>>} records one per patient, as `judgments.jsonl` holds them
 * @param {number} notes how many notes went in
 */
export function summarise(records, notes) {
  const verdicts = /** @type {Record<string, number>} */ ({}), labels = /** @type {Record<string, number>} */ ({}), failed = /** @type {Record<string, number>} */ ({});
  let pairs = 0, withFit = 0, clauses = 0, stated = 0, statedWithEvidence = 0, reasons = 0, reasonsInChinese = 0, complete = 0, cost = 0;
  /** @type {number[]} */ const fits = [];
  for (const record of records) {
    if (record.status === 'complete') complete += 1;
    cost += Number(record.usage?.costCny ?? 0);
    for (const item of record.failed ?? []) failed[String(item.code)] = (failed[String(item.code)] ?? 0) + 1;
    for (const entry of record.ranking ?? []) {
      pairs += 1;
      if (Number.isFinite(entry.fit)) { withFit += 1; fits.push(Number(entry.fit)); }
      verdicts[String(entry.verdict)] = (verdicts[String(entry.verdict)] ?? 0) + 1;
      for (const row of entry.criteria ?? []) {
        clauses += 1;
        labels[String(row.label)] = (labels[String(row.label)] ?? 0) + 1;
        if (row.basis === 'stated') { stated += 1; if ((row.sentenceIds ?? []).length) statedWithEvidence += 1; }
        if (row.reason) { reasons += 1; if (HAN.test(String(row.reason))) reasonsInChinese += 1; }
      }
    }
  }
  fits.sort((a, b) => a - b);
  const at = (/** @type {number} */ share) => (fits.length ? fits[Math.min(fits.length - 1, Math.floor(share * fits.length))] : null);
  return { notes, records: records.length, complete, pairs, withFit, fitQuartiles: [at(0.25), at(0.5), at(0.75)], verdicts, clauses, labels, stated, statedWithEvidence, reasons, reasonsInChinese, failed, costCny: Number(cost.toFixed(2)) };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    notes: { type: 'string' }, collection: { type: 'string' }, work: { type: 'string' }, 'db-name': { type: 'string' }, 'key-file': { type: 'string' }, 'dashscope-key-file': { type: 'string' },
    top: { type: 'string', default: '10' }, 'top-k': { type: 'string', default: '3' }, concurrency: { type: 'string', default: '4' }, 'cap-cny': { type: 'string', default: '20' },
    'base-url': { type: 'string', default: 'https://api.deepseek.com' }, model: { type: 'string', default: 'deepseek-flash' }, 'rerank-model': { type: 'string', default: 'qwen3-rerank' },
  } });
  if (!values.notes || !values.collection || !values.work || !values['db-name'] || !values['key-file'] || !values['dashscope-key-file']) throw fail('--notes, --collection, --work, --db-name, --key-file and --dashscope-key-file are required.', 'option_missing');
  const work = path.resolve(values.work);
  const planned = path.join(work, 'planned');
  fs.mkdirSync(planned, { recursive: true, mode: 0o700 });
  const notes = fs.readFileSync(values.notes, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const manifest = path.join(path.resolve(values.collection), 'collection.json');
  const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).id;
  const read = (/** @type {string} */ file) => fs.readFileSync(file, 'utf8').trim();
  const key = read(values['key-file']);
  const reranker = new VcrCandidateRerank({ apiKey: read(values['dashscope-key-file']), model: String(values['rerank-model']), apiBase: RERANK_BASE, timeoutMs: 30_000, budgetMs: 120_000, batchSize: 50, concurrency: 3 }, { fetchImpl: fetch, report: () => {} });
  const corpus = createVcrTrialCorpus(manifest, { timeoutMs: 600_000 });
  /** @type {Record<string, number>} */
  const planFailures = {};
  try {
    for (const note of notes) {
      const file = path.join(planned, `${note.id}.json`);
      if (fs.existsSync(file)) continue;
      try {
        const answered = await chatOnce({ baseUrl: String(values['base-url']), apiKey: key, model: String(values.model), thinking: 'off', messages: searchMessages(note.text, 'skill') });
        const { request } = requestFromAnswer(JSON.parse(answered.content));
        const collected = /** @type {any} */ (await corpus.collect(request));
        const outcome = await rerankCandidates({ summary: request.summary ?? '', candidates: collected.candidates.map((/** @type {any} */ row) => ({
          registryId: row.registryId, title: row.title, conditions: row.conditions, interventions: row.interventions, phase: row.phase, sexStated: row.sex, ageStated: row.age, eligibilityHead: collected.cards?.[row.registryId] ?? '' })) }, { reranker });
        fs.writeFileSync(file, JSON.stringify({ ids: outcome.ids.slice(0, Number(values.top)), found: collected.candidates.length, rerank: outcome.state }), { mode: 0o600 });
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code ?? 'failed');
        planFailures[code] = (planFailures[code] ?? 0) + 1;
      }
    }
  } finally {
    await corpus.close();
  }
  const rows = notes.flatMap((note) => {
    const file = path.join(planned, `${note.id}.json`);
    if (!fs.existsSync(file)) return [];
    const { ids } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return ids.length ? [JSON.stringify({ caseId: note.id, patientId: note.id, cohort: 'trec_2021', collection: name, split: 'dev', note: note.text, candidateIds: ids, candidateCount: ids.length })] : [];
  });
  const boards = path.join(work, 'boards');
  fs.mkdirSync(path.join(boards, 'A-trec2021'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(boards, 'collections'), { recursive: true });
  const link = path.join(boards, 'collections', name);
  if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(values.collection), link);
  fs.writeFileSync(path.join(boards, 'A-trec2021', 'cases.jsonl'), `${rows.join('\n')}\n`, { mode: 0o600 });
  const out = path.join(work, 'out');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['dev_job.mjs', '--board', 'trec2021', '--boards', boards, '--arm', 'zh-usability', '--split', 'dev', '--mode', 'both', '--thinking', 'off', '--thinking-criteria', 'high', '--top-k', String(values['top-k']),
      '--concurrency', String(values.concurrency), '--score', 'no', '--cap-cny', String(values['cap-cny']), '--db-name', String(values['db-name']), '--data-dir', path.join(work, 'data'), '--out', out, '--key-file', path.resolve(values['key-file'])], { cwd: HERE, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('close', (status) => resolve(status ?? 1));
  });
  const records = fs.existsSync(path.join(out, 'judgments.jsonl')) ? fs.readFileSync(path.join(out, 'judgments.jsonl'), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) : [];
  const report = { ...summarise(records, notes.length), planFailures, boardCases: rows.length, jobExit: code };
  fs.writeFileSync(path.join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return code === 0 || code === 4 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
