#!/usr/bin/env node
/**
 * Board E, the end-to-end half: from the top N of a retrieval to the judged and ranked list the feature saves, scored against the full official qrels.
 *
 * It does not judge anything itself. It writes, for each year, a board of the dev_job kind (one case per topic: the patient's record and the first N
 * ids of the retrieval, in retrieval order; the collection is the whole official snapshot), then runs `dev_job.mjs`'s loop on it, which starts the
 * platform's own `match_judge` job per patient, reads the saved judgments back through the pages' reader and writes the ranking. `score_e.py end2end`
 * then scores that ranking. Labels are read only by the scorer, in its own process.
 *
 *   node e2e_e.mjs --retrieved <retrieved-rerank.jsonl> --exp e1 --top-n 100 --topics <dir> --collections <dir> --data-dir <dir> \
 *       --key-file <deepseek key> --qrels-dir <dir> [--mode fit] [--thinking off] [--years 2021,2022,2023] [--plan-only]
 *
 * One scratch PostgreSQL database is used (OPEN_SCIENCE_TEST_POSTGRES_URL or the local default of dev_job.mjs); one runner at a time. The spend ledger is
 * `<data-dir>/spend-ledger.jsonl`, the cap `--cap-cny`. A run again continues from the platform's judgment ledger and pays nothing twice.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fail } from './board_cases.mjs';
import { EXIT as DEV_EXIT, parseOptions as parseDevOptions, runDevJob } from './dev_job.mjs';
import { parseTopics } from './retrieve_e.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXIT = Object.freeze({ finished: 0, error: 1, refused: 2, stopped: 3, failedPairs: 4 });

/** The collection manifest of a year: TREC 2021 and 2022 share the 2021-04-27 snapshot. @param {string} collectionsDir @param {number} year */
export const manifestFor = (collectionsDir, year) => path.join(collectionsDir, year === 2023 ? 'index2023' : 'index2021', 'collection.json');

/**
 * The boards of a run, one directory per year in dev_job's layout. A case is a topic: its record, the first `topN` ids of the retrieval in the order
 * the retrieval gave them. The board key is `trec2021` for every year (the loader only needs the directory); the manifest copy names the sealed
 * index by absolute path, so the revision the platform computes is the one the retrieval searched.
 * @param {{ records: Array<Record<string, any>>, notes: Map<string, string>, collectionsDir: string, topN: number, outDir: string, years: number[] }} input
 * @returns {Record<number, { boardsDir: string, topics: string[] }>}
 */
export function buildBoards({ records, notes, collectionsDir, topN, outDir, years }) {
  /** @type {Record<number, { boardsDir: string, topics: string[] }>} */
  const made = {};
  for (const year of years) {
    const mine = records.filter((record) => record.year === year);
    if (!mine.length) continue;
    const manifestPath = manifestFor(collectionsDir, year);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const boardsDir = path.join(outDir, String(year));
    fs.mkdirSync(path.join(boardsDir, 'A-trec2021'), { recursive: true });
    fs.mkdirSync(path.join(boardsDir, 'collections', manifest.id), { recursive: true });
    fs.writeFileSync(path.join(boardsDir, 'collections', manifest.id, 'collection.json'),
      `${JSON.stringify({ ...manifest, databasePath: path.resolve(path.dirname(manifestPath), manifest.databasePath) }, null, 2)}\n`);
    const lines = mine.map((record) => {
      const note = notes.get(record.topic);
      if (!note) throw fail(`No record text for ${record.topic}.`, 'topic_missing');
      const ids = [...new Set(/** @type {string[]} */ (record.retrieved))].slice(0, topN);
      return JSON.stringify({ caseId: record.topic, patientId: record.topic, cohort: `trec_${year}`, collection: manifest.id, split: 'dev', note, candidateIds: ids, candidateCount: ids.length });
    });
    fs.writeFileSync(path.join(boardsDir, 'A-trec2021', 'cases.jsonl'), `${lines.join('\n')}\n`);
    made[year] = { boardsDir, topics: mine.map((record) => record.topic) };
  }
  return made;
}

const OPTIONS = {
  retrieved: { type: 'string' }, exp: { type: 'string' }, 'top-n': { type: 'string', default: '100' }, topics: { type: 'string' }, collections: { type: 'string' },
  'data-dir': { type: 'string' }, 'key-file': { type: 'string' }, 'qrels-dir': { type: 'string' }, mode: { type: 'string', default: 'fit' }, thinking: { type: 'string', default: 'off' },
  'top-k': { type: 'string' }, years: { type: 'string', default: '2021,2022,2023' }, concurrency: { type: 'string', default: '8' }, 'db-name': { type: 'string', default: 'evimed_test_s8e' },
  'db-url': { type: 'string' }, 'base-url': { type: 'string', default: 'https://api.deepseek.com' }, model: { type: 'string', default: 'deepseek-flash' }, 'cap-cny': { type: 'string', default: '8' },
  'floor-cny': { type: 'string', default: '200' }, 'allow-peak': { type: 'boolean', default: false }, 'plan-only': { type: 'boolean', default: false }, 'no-score': { type: 'boolean', default: false },
  'eval-python': { type: 'string' }, 'trec-eval': { type: 'string' }, resamples: { type: 'string', default: '10000' }, 'limit-patients': { type: 'string' }, help: { type: 'boolean', default: false },
};

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values.help) return { help: true };
  for (const name of ['retrieved', 'exp', 'topics', 'collections', 'data-dir']) if (!values[name]) throw fail(`--${name} is required.`, 'option_missing');
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/u.test(String(values.exp))) throw fail('--exp names the experiment: lowercase letters, digits, - and _.', 'option_invalid');
  const topN = Number(values['top-n']);
  if (!Number.isInteger(topN) || topN < 1 || topN > 500) throw fail('--top-n is a whole number from 1 to 500.', 'option_invalid');
  const years = String(values.years).split(',').map(Number);
  if (!years.length || years.some((year) => ![2021, 2022, 2023].includes(year))) throw fail('--years lists 2021, 2022 and 2023.', 'option_invalid');
  if (!values['no-score'] && !values['qrels-dir']) throw fail('--qrels-dir names the official qrels (read only by the scorer); or pass --no-score.', 'option_missing');
  return {
    help: false, retrieved: path.resolve(String(values.retrieved)), exp: String(values.exp), topN, years, topicsDir: path.resolve(String(values.topics)), collectionsDir: path.resolve(String(values.collections)),
    dataDir: path.resolve(String(values['data-dir'])), keyFile: values['key-file'] ?? env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE ?? null, qrelsDir: values['qrels-dir'] ? path.resolve(String(values['qrels-dir'])) : null,
    mode: String(values.mode), thinking: String(values.thinking), topK: values['top-k'] ?? null, concurrency: String(values.concurrency), dbName: String(values['db-name']), dbUrl: values['db-url'] ?? env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? null,
    baseUrl: String(values['base-url']), model: String(values.model), capCny: String(values['cap-cny']), floorCny: String(values['floor-cny']), allowPeak: Boolean(values['allow-peak']),
    planOnly: Boolean(values['plan-only']), score: !values['no-score'], evalPython: values['eval-python'] ?? env.VCR_BOARDS_PYTHON ?? 'python3', trecEval: values['trec-eval'] ?? env.VCR_BOARDS_TREC_EVAL ?? null,
    resamples: String(values.resamples), limitPatients: values['limit-patients'] ?? null,
  };
}

/** @param {string} python @param {string[]} args */
const run = (python, args) => new Promise((resolve) => {
  const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('error', () => resolve(127));
  child.once('close', (status) => resolve(status ?? 1));
});

/**
 * @param {Record<string, any>} o parsed options
 * @param {{ log?: (line: string) => void, devDeps?: Record<string, any> }} [deps]
 */
export async function runEndToEnd(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const records = fs.readFileSync(o.retrieved, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (!records.length) throw fail('The retrieval file holds no topic.', 'no_topics');
  const notes = new Map();
  for (const year of o.years) {
    const file = path.join(o.topicsDir, `topics${year}.xml`);
    if (records.some((record) => record.year === year)) for (const topic of parseTopics(fs.readFileSync(file, 'utf8'), year)) notes.set(topic.id, topic.note);
  }
  const root = path.join(o.dataDir, 'e2e', o.exp);
  const limited = o.limitPatients == null ? records : records.filter((record) => {
    const same = records.filter((other) => other.year === record.year);
    return same.indexOf(record) < Number(o.limitPatients);
  });
  const boards = buildBoards({ records: limited, notes, collectionsDir: o.collectionsDir, topN: o.topN, outDir: path.join(root, 'boards'), years: o.years });
  log(`[e2e_e] exp=${o.exp} top ${o.topN} of ${path.basename(o.retrieved)}; years ${Object.keys(boards).join(', ')}; mode=${o.mode} thinking=${o.thinking}`);
  let worst = EXIT.finished;
  /** @type {Record<string, string>} */
  const judgments = {};
  for (const [yearText, board] of Object.entries(boards)) {
    const year = Number(yearText);
    const argv = ['--board', 'trec2021', '--boards', board.boardsDir, '--arm', `e-${o.exp}-${year}`.slice(0, 40), '--split', 'dev', '--mode', o.mode, '--thinking', o.thinking,
      '--concurrency', o.concurrency, '--data-dir', o.dataDir, '--out', path.join(root, 'dev-job', String(year)), '--db-name', o.dbName, '--base-url', o.baseUrl, '--model', o.model,
      '--cap-cny', o.capCny, '--floor-cny', o.floorCny, '--score', 'no', ...(o.topK != null ? ['--top-k', o.topK] : []), ...(o.keyFile ? ['--key-file', o.keyFile] : []),
      ...(o.dbUrl ? ['--db-url', o.dbUrl] : []), ...(o.allowPeak ? ['--allow-peak'] : []), ...(o.planOnly ? ['--plan-only'] : [])];
    const outcome = await runDevJob(parseDevOptions(argv, {}), { log, ...(deps.devDeps ?? {}) });
    worst = Math.max(worst, outcome.exitCode);
    if (!o.planOnly && fs.existsSync(path.join(outcome.outDir, 'judgments.jsonl'))) judgments[String(year)] = path.join(outcome.outDir, 'judgments.jsonl');
    if (outcome.exitCode === DEV_EXIT.refused || outcome.exitCode === DEV_EXIT.stopped) { log(`[e2e_e] ${year}: dev_job ended ${outcome.exitCode}; the later years are not started`); break; }
  }
  if (o.score && !o.planOnly && Object.keys(judgments).length) {
    const args = ['-I', '-B', path.join(HERE, 'score_e.py'), 'end2end', '--qrels-dir', o.qrelsDir, '--judgments', ...Object.entries(judgments).map(([year, file]) => `${year}=${file}`),
      '--retrieved', o.retrieved, '--out', path.join(root, 'score'), '--resamples', o.resamples, ...(o.trecEval ? ['--trec-eval', o.trecEval] : [])];
    const code = await run(o.evalPython, args);
    if (code !== 0) { log(`[e2e_e] score_e.py exited ${code}`); worst = Math.max(worst, EXIT.error); }
  }
  return { exitCode: worst, root, judgments };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseOptions(argv, env); } catch (error) {
    process.stderr.write(`e2e_e: ${/** @type {any} */ (error)?.message ?? error}\n`);
    return EXIT.error;
  }
  if (options.help) { process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^[^]*?\/\*\*\n/u, '').replace(/^ \* ?/gmu, '')}\n`); return EXIT.finished; }
  try { return (await runEndToEnd(options)).exitCode; } catch (error) {
    process.stderr.write(`e2e_e: ${/** @type {any} */ (error)?.code ?? 'error'}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 400)}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
