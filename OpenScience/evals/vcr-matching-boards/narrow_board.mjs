/**
 * A ranking board narrowed the way the product narrows a list: the model writes the patient's summary from the note (`searchMessages`, the words of the
 * skill and the tool), the product's reranker (`rerankCandidates`) reads the board's candidates against it, and the first N of each patient are what the
 * feature then judges. Used for board B: judging all 101,682 pairs is what the paper did and what a person never waits for, so the report says which it is.
 *
 *   node narrow_board.mjs --boards <prepared inputs> --board nih --out <dir> --top 100 --key-file <deepseek> --dashscope-key-file <dashscope>
 *
 * Writes `<out>/<board dir>/cases.jsonl` in the shape `prepare.py` writes, `<out>/collections` as a link to the original collections, and one file per
 * patient under `<out>/patients` so that an interrupted run continues. The kept ids stay in the prepared order, so what a runner names first says nothing
 * about the reranker's opinion. No label file is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { isPeak, priceUsage } from '@evimed/domain';
import { VcrCandidateRerank, rerankCandidates } from '../../apps/server/src/vcrCandidateRerank.mjs';
import { BOARDS, collectionManifestOf, fail, loadCases } from './board_cases.mjs';
import { chatOnce, requestFromAnswer, searchMessages } from './retrieve_e.mjs';
import { createSpendLedger } from './spend.mjs';

const RERANK_BASE = 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
/** What the corpus hands a reranker of a trial's eligibility text (`vcrTrialCorpus.mjs`, `collect`). */
const ELIGIBILITY_HEAD = 1_500;

/**
 * The fields a reranker reads, from a collection's own payloads.
 * @param {string} manifestFile
 * @returns {{ candidate: (id: string) => Record<string, any> | null, close: () => void }}
 */
export function openPayloads(manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const db = new DatabaseSync(path.join(path.dirname(manifestFile), manifest.databasePath), { readOnly: true });
  const read = db.prepare('SELECT payload FROM documents WHERE nct_id = ?');
  const lines = (/** @type {unknown} */ value) => String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    candidate(id) {
      const row = /** @type {any} */ (read.get(id));
      if (!row) return null;
      const payload = JSON.parse(inflateSync(row.payload).toString('utf8'));
      return {
        registryId: id, title: String(payload.title ?? ''), conditions: lines(payload.condition), interventions: lines(payload.interventions), phase: String(payload.phase ?? ''),
        eligibilityHead: String(payload.eligibility ?? '').replace(/\s+/g, ' ').slice(0, ELIGIBILITY_HEAD),
      };
    },
    close: () => db.close(),
  };
}

/** The first `top` ids the reranker gave, back in the prepared order. @param {string[]} prepared @param {string[]} ranked @param {number} top */
export function keptInPreparedOrder(prepared, ranked, top) {
  const kept = new Set(ranked.slice(0, top));
  return prepared.filter((id) => kept.has(id));
}

/**
 * @param {{ boards: string, board: keyof typeof BOARDS, out: string, top: number, split: string, keyFile: string, dashscopeKeyFile: string, model: string, rerankModel: string,
 *   baseUrl: string, rerankUrl: string, concurrency: number, spendLedger: string | null }} o
 * @param {{ fetchImpl?: typeof fetch, rerankFetch?: typeof fetch, log?: (line: string) => void, now?: () => Date }} [deps]
 */
export async function narrowBoard(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const cases = loadCases(o.boards, o.board, { split: o.split });
  const patients = path.join(o.out, 'patients');
  fs.mkdirSync(patients, { recursive: true });
  const payloads = openPayloads(collectionManifestOf(o.boards, cases));
  const ledger = createSpendLedger(o.spendLedger ?? path.join(o.out, 'spend-ledger.jsonl'));
  const read = (/** @type {string} */ file) => fs.readFileSync(file, 'utf8').trim();
  const key = read(o.keyFile);
  const reranker = new VcrCandidateRerank({ apiKey: read(o.dashscopeKeyFile), model: o.rerankModel, apiBase: o.rerankUrl, timeoutMs: 30_000, budgetMs: 120_000, batchSize: 50, concurrency: 3 },
    { fetchImpl: deps.rerankFetch ?? fetch, report: () => {} });
  /** @type {string[]} */
  const failed = [];
  const fileOf = (/** @type {Record<string, any>} */ row) => path.join(patients, `${row.patientId}.json`);
  const one = async (/** @type {Record<string, any>} */ row) => {
    if (fs.existsSync(fileOf(row))) return;
    try {
      const answered = await chatOnce({ baseUrl: o.baseUrl, apiKey: key, model: o.model, thinking: 'off', messages: searchMessages(row.note, 'english'), fetchImpl: deps.fetchImpl });
      const { request } = requestFromAnswer(JSON.parse(answered.content));
      const cost = priceUsage({ resourceType: 'model', model: o.model, cacheHit: answered.usage.cacheHit, cacheMiss: answered.usage.cacheMiss, output: answered.usage.output, peak: isPeak(now()) });
      ledger.append({ kind: 'job', arm: 'narrow', board: o.board, jobId: `narrow:${o.board}:${row.patientId}`, costCny: cost.priced ? cost.cost : 0, calls: 1 });
      const candidates = row.candidateIds.map((/** @type {unknown} */ id) => payloads.candidate(String(id))).filter(Boolean);
      let tokens = 0;
      const outcome = await rerankCandidates({ summary: request.summary ?? '', candidates }, { reranker, bill: async (spend) => { tokens += spend.tokens; } });
      if (outcome.state !== 'ranked') throw fail(`rerank ${outcome.state}`, 'rerank_incomplete');
      const rerankCost = priceUsage({ resourceType: 'model', model: o.rerankModel, cacheHit: 0, cacheMiss: tokens, output: 0, peak: true });
      ledger.append({ kind: 'job', arm: 'narrow', board: o.board, jobId: `narrow:${o.board}:${row.patientId}:rerank`, costCny: rerankCost.priced ? rerankCost.cost : 0, calls: outcome.batches });
      fs.writeFileSync(fileOf(row), JSON.stringify({ patientId: row.patientId, ids: outcome.ids, state: outcome.state, batches: outcome.batches, tokens, model: outcome.model }));
    } catch (error) {
      failed.push(String(row.patientId));
      log(`[narrow] ${row.patientId}: ${String(/** @type {any} */ (error)?.code ?? 'failed')}`);
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency, cases.length) }, async () => {
    while (next < cases.length) { const row = cases[next]; next += 1; await one(row); }
  }));
  payloads.close();
  if (failed.length) return { written: false, failed };
  const spec = BOARDS[o.board];
  const dir = path.join(o.out, spec.dir);
  fs.mkdirSync(dir, { recursive: true });
  const rows = cases.map((row) => {
    const ranked = JSON.parse(fs.readFileSync(fileOf(row), 'utf8')).ids;
    const candidateIds = keptInPreparedOrder(row.candidateIds.map(String), ranked, o.top);
    return { ...row, candidateIds, candidateCount: candidateIds.length };
  });
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const link = path.join(o.out, 'collections');
  if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(o.boards, 'collections'), link);
  const pairs = rows.reduce((sum, row) => sum + row.candidateCount, 0);
  log(`[narrow] ${rows.length} patients, ${pairs} pairs kept, ${path.join(dir, 'cases.jsonl')}`);
  return { written: true, patients: rows.length, pairs, failed };
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    boards: { type: 'string' }, board: { type: 'string', default: 'nih' }, out: { type: 'string' }, top: { type: 'string', default: '100' }, split: { type: 'string', default: 'all' },
    'key-file': { type: 'string' }, 'dashscope-key-file': { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' }, 'rerank-model': { type: 'string', default: 'qwen3-rerank' },
    'base-url': { type: 'string', default: 'https://api.deepseek.com' }, 'rerank-url': { type: 'string', default: RERANK_BASE }, concurrency: { type: 'string', default: '4' }, 'spend-ledger': { type: 'string' },
  } });
  if (!values.boards || !values.out || !values['key-file'] || !values['dashscope-key-file']) throw fail('--boards, --out, --key-file and --dashscope-key-file are required.', 'option_missing');
  const outcome = await narrowBoard({
    boards: path.resolve(values.boards), board: /** @type {keyof typeof BOARDS} */ (values.board), out: path.resolve(values.out), top: Number(values.top), split: String(values.split),
    keyFile: values['key-file'], dashscopeKeyFile: values['dashscope-key-file'], model: String(values.model), rerankModel: String(values['rerank-model']),
    baseUrl: String(values['base-url']), rerankUrl: String(values['rerank-url']), concurrency: Number(values.concurrency), spendLedger: values['spend-ledger'] ?? null,
  });
  return outcome.written ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
