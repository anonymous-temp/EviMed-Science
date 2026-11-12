#!/usr/bin/env node
/**
 * Prepare board G, Chinese robustness: the patient notes of the SIGIR topics and of the TREC 2021 and TREC 2022 development topics,
 * translated once into Simplified Chinese by the model through the control plane's own gateway call (so the usage ledger books it), then
 * frozen with a hash. The trials stay English and the candidate lists, collections and qrels are the first boards', so the one thing that
 * changes between boards A and G is the language of the note.
 *
 *   node prepare_zh.mjs --boards <inputs dir> --out <zh dir> --key-file <key> --data-dir <private dir> [--budget-cny 2] [--allow-peak]
 *
 * The translator is told to keep clinical terms accurate, to leave every number, unit and date as written, and to add, omit and explain
 * nothing. Code checks what code can: every number in the note must come back (a multiset check), and a note whose numbers do not is
 * asked again once and, failing that, kept and counted in the manifest. Whether the words are faithful is not code's to decide; the
 * translations are spot-checked by a reader. Guards: the full-price window, the balance floor (`budget.py`) and the campaign's cap, as for
 * the dev loop, and this stage's own budget (default CNY 2), tested before every call against the worst the call could cost.
 *
 * Idempotent: each translation is appended to `translations.jsonl` as it arrives and a rerun asks only for the missing ones; a board that
 * has been written is frozen and is never written again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPeak, priceUsage } from '@evimed/domain';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { callModelForControlPlane } from '../../apps/server/src/modelGateway.mjs';
import { UsageLedger } from '../../apps/server/src/usageLedger.mjs';
import { fail, loadCases, sha256 } from './board_cases.mjs';
import { dropDatabase, ensureDatabase, scratchUrl, takeRunnerLock } from './devdb.mjs';
import { DEFAULT_CAP_CNY, DEFAULT_FLOOR_CNY, GuardStop, createBalanceChecker, createSpendLedger, preflight } from './spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = 'vmdev';
const PROJECT = 'vmzh-prepare';
export const PROMPT_VERSION = 'zh-1';

/** The three translated boards: the extra board's name, the first board it translates, and the split taken. */
export const ZH_BOARDS = Object.freeze([
  Object.freeze({ name: 'sigir-zh', dir: 'A-sigir-zh', of: 'sigir', split: 'dev' }),
  Object.freeze({ name: 'trec2021-zh-dev', dir: 'A-trec2021-zh-dev', of: 'trec2021', split: 'dev' }),
  Object.freeze({ name: 'trec2022-zh-dev', dir: 'A-trec2022-zh-dev', of: 'trec2022', split: 'dev' }),
]);

export const SYSTEM = [
  'You translate synthetic patient descriptions for a medical retrieval study from English into Simplified Chinese.',
  'Rules:',
  '1. Translate every sentence faithfully. Add nothing, omit nothing, explain nothing and infer nothing.',
  '2. Use standard Chinese clinical terminology, as in Chinese medical textbooks and guidelines. Keep the usual abbreviations (CT, MRI, HIV, BMI, ECG, mg, mL and the like) in Latin letters.',
  '3. Keep every number, unit, date, ratio, percentage and symbol exactly as written. Do not convert units, round or reformat.',
  '4. Keep the paragraph and line structure of the text.',
  '5. Output only the translation, with no preface, no note and no quotation marks around it.',
].join('\n');
export const PROMPT_SHA256 = createHash('sha256').update(SYSTEM).digest('hex');

/**
 * The numbers a text holds, as a sorted list: the multiset the translation has to give back. A digit inside a name (the 1 of HbA1c, the 12 of B12)
 * is part of the name and not counted; a number next to a Chinese character or a unit is.
 * @param {string} text
 */
export function numbersOf(text) {
  return (String(text).match(/(?<![A-Za-z\d.,])\d+(?:[.,]\d+)?/gu) ?? []).map((token) => token.replace(',', '.')).sort();
}

/** Whether a translation holds exactly the numbers of its source. @param {string} source @param {string} translation */
export function numbersMatch(source, translation) {
  const a = numbersOf(source), b = numbersOf(translation);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** Does the text read as Chinese: a good share of its letters are Han characters. @param {string} text */
export function readsAsChinese(text) {
  const han = (String(text).match(/\p{Script=Han}/gu) ?? []).length;
  const letters = (String(text).match(/\p{L}/gu) ?? []).length;
  return letters > 0 && han / letters >= 0.4;
}

/**
 * Ask for one translation, with its retries. `ask` is the gateway call (a function of the user text and an optional reminder).
 * @param {{ ask: (text: string, reminder?: string) => Promise<{ content: string, cost: number, inputTokens: number, outputTokens: number }>, source: string }} input
 */
export async function translateOne({ ask, source }) {
  let spent = 0, inputTokens = 0, outputTokens = 0;
  let last = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answered = await ask(source, attempt ? 'Your previous translation did not keep every number exactly as written, or was not Chinese. Translate again, keeping every number, unit and date exactly as in the original.' : undefined);
    spent += answered.cost; inputTokens += answered.inputTokens; outputTokens += answered.outputTokens;
    last = String(answered.content ?? '').trim();
    if (last && readsAsChinese(last) && numbersMatch(source, last)) return { translation: last, numbersOk: true, attempts: attempt + 1, cost: spent, inputTokens, outputTokens };
  }
  return { translation: last, numbersOk: last ? numbersMatch(source, last) : false, attempts: 2, cost: spent, inputTokens, outputTokens };
}

/**
 * @param {Record<string, any>} o
 * @param {{ log?: (line: string) => void, now?: () => Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null, dropDatabaseAfter?: boolean }} [deps]
 */
export async function prepareZh(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const out = path.resolve(o.out);
  const todo = ZH_BOARDS.filter((board) => !fs.existsSync(path.join(out, board.dir, 'cases.jsonl')));
  if (!todo.length) { log('[prepare_zh] every board is already frozen'); return { frozen: true, boards: [] }; }
  const sources = Object.fromEntries(todo.map((board) => [board.name, loadCases(o.boardsDir, board.of, { split: board.split })]));
  const notes = todo.flatMap((board) => sources[board.name].map((row) => ({ board, row })));
  fs.mkdirSync(out, { recursive: true });
  const cacheFile = path.join(out, 'translations.jsonl');
  /** @type {Map<string, any>} */
  const cache = new Map();
  if (fs.existsSync(cacheFile)) for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n').filter(Boolean)) { const entry = JSON.parse(line); cache.set(entry.key, entry); }
  const keyOf = (/** @type {string} */ board, /** @type {Record<string, any>} */ row) => `${PROMPT_VERSION}|${board}|${row.patientId}|${sha256(row.note)}`;
  const missing = notes.filter(({ board, row }) => !cache.has(keyOf(board.name, row)));

  const spendLedger = createSpendLedger(path.join(o.dataDir, 'spend-ledger.jsonl'));
  const recordedBefore = spendLedger.recorded();
  const stageSpent = [...cache.values()].reduce((sum, entry) => sum + (entry.cost ?? 0), 0);
  const peak = isPeak(now());
  // The worst a call can cost: its input at the full price and its whole output allowance, priced as the gateway prices it.
  const worstOf = (/** @type {string} */ text) => {
    const priced = priceUsage({ resourceType: 'model', model: o.model, cacheHit: 0, cacheMiss: Math.ceil((SYSTEM.length + text.length) / 1.5), output: o.maxTokens, peak: true });
    return priced.priced ? priced.cost : 0;
  };
  const expectedOf = (/** @type {string} */ text) => {
    const priced = priceUsage({ resourceType: 'model', model: o.model, cacheHit: 0, cacheMiss: Math.ceil((SYSTEM.length + text.length) / 3), output: Math.ceil(text.length / 1.5), peak });
    return priced.priced ? priced.cost : 0;
  };
  const expected = missing.reduce((sum, { row }) => sum + expectedOf(row.note) * 1.2, 0);
  log(`[prepare_zh] ${notes.length} notes in ${todo.length} board(s), ${missing.length} still to translate; about CNY ${expected.toFixed(3)} expected, stage budget CNY ${o.budgetCny}, spent on this stage so far CNY ${stageSpent.toFixed(3)}${peak ? '; PEAK window (full price)' : ''}`);
  if (o.planOnly || !missing.length) {
    if (o.planOnly) return { planOnly: true, notes: notes.length, missing: missing.length, expectedCny: expected };
  } else {
    if (stageSpent + expected > o.budgetCny) throw new GuardStop('stage_budget', `The expected cost (CNY ${expected.toFixed(2)}) and the stage's spend so far pass its budget of CNY ${o.budgetCny}.`);
    const balance = deps.balance !== undefined ? deps.balance : (o.keyFile && new URL(o.baseUrl).origin === 'https://api.deepseek.com' ? createBalanceChecker({ python: o.evalPython, script: path.join(HERE, 'budget.py'), keyFile: o.keyFile, floor: o.floorCny }) : null);
    await preflight({ estimateCny: expected, capCny: o.capCny, recordedCny: recordedBefore, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance });

    const dbUrl = scratchUrl({ serverUrl: o.dbUrl, name: o.dbName });
    await ensureDatabase(dbUrl);
    const lock = await takeRunnerLock(dbUrl);
    const database = new ControlPlaneDatabase({ databaseUrl: dbUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
    try {
      const config = loadConfig({ databaseUrl: dbUrl, stateStore: 'postgres', deepseekBaseUrl: o.baseUrl, deepseekModel: o.model, deepseekApiKeyFile: o.keyFile });
      const usageLedger = new UsageLedger(database);
      await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'VCR boards dev loop','development') ON CONFLICT (id) DO NOTHING", [OWNER]);
      await database.query('INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,$3,1000000000) ON CONFLICT DO NOTHING', [OWNER, PROJECT, 'zh prepare']);
      let spent = stageSpent;
      let stopped = /** @type {GuardStop | null} */ (null);
      let next = 0;
      const runId = `zh-${sha256(`${out}|${Date.now()}`).slice(0, 12)}`;
      const ask = async (/** @type {string} */ text, /** @type {string | undefined} */ reminder) => {
        const worst = worstOf(text);
        if (spent + worst > o.budgetCny) throw new GuardStop('stage_budget', `The stage budget of CNY ${o.budgetCny} would be passed.`);
        const body = await callModelForControlPlane({ config, usageLedger, fetchImpl: globalThis.fetch }, {
          userId: OWNER, projectId: PROJECT, runId, purpose: 'vcr',
          body: { model: o.model, max_tokens: o.maxTokens, thinking: { type: 'disabled' }, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: reminder ? `${text}\n\n${reminder}` : text }] },
        });
        const usage = body?.usage ?? {};
        const input = Number(usage.prompt_tokens) || 0, output = Number(usage.completion_tokens) || 0, hit = Number(usage.prompt_cache_hit_tokens) || 0;
        const priced = priceUsage({ resourceType: 'model', model: o.model, cacheHit: hit, cacheMiss: Math.max(0, input - hit), output, peak: isPeak(now()) });
        const cost = priced.priced ? priced.cost : worst;
        spent += cost;
        return { content: String(body?.choices?.[0]?.message?.content ?? ''), cost, inputTokens: input, outputTokens: output };
      };
      const lane = async () => {
        while (next < missing.length && !stopped) {
          const { board, row } = missing[next++];
          try {
            if (!o.allowPeak && isPeak(now())) { stopped = new GuardStop('peak_window', 'The full-price window began: the run stops and resumes from its cache.'); break; }
            const result = await translateOne({ ask, source: row.note });
            const entry = { key: keyOf(board.name, row), board: board.name, patientId: row.patientId, sourceSha256: sha256(row.note), translation: result.translation, translationSha256: sha256(result.translation),
              numbersOk: result.numbersOk, attempts: result.attempts, cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: o.model, promptVersion: PROMPT_VERSION };
            fs.appendFileSync(cacheFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
            cache.set(entry.key, entry);
            spendLedger.append({ kind: 'job', arm: 'zh-prepare', board: board.name, jobId: `zh:${board.name}:${row.patientId}:${Date.now()}`, costCny: result.cost, calls: result.attempts });
          } catch (error) {
            if (error instanceof GuardStop) { stopped = stopped ?? error; break; }
            const code = String(/** @type {any} */ (error)?.code ?? 'error');
            log(`[prepare_zh] ${board.name} ${row.patientId}: not translated (${code})`);
            if (['model_gateway_payment_required', 'insufficient_quota', 'usage_budget_exceeded'].includes(code)) { stopped = new GuardStop(code, 'The budget or balance of the provider is spent.'); break; }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, missing.length)) }, lane));
      log(`[prepare_zh] translated ${cache.size - (notes.length - missing.length)} of ${missing.length}; spent CNY ${(spent - stageSpent).toFixed(4)} (stage total ${spent.toFixed(4)})${stopped ? `; stopped: ${stopped.code}` : ''}`);
      if (stopped) throw stopped;
    } finally {
      await database.close().catch(() => {});
      await lock.release().catch(() => {});
      if (deps.dropDatabaseAfter) await dropDatabase(dbUrl).catch(() => {});
    }
  }

  // --- freeze: every note of a board is in the cache, then the board is written once, with its hashes ---------------------------------
  const frozen = [];
  for (const board of todo) {
    const rows = sources[board.name];
    const lines = [];
    let mismatches = 0, notChinese = 0;
    for (const row of rows) {
      const entry = cache.get(keyOf(board.name, row));
      if (!entry) throw fail(`${board.name} ${row.patientId} has no translation yet: run again.`, 'translations_missing');
      if (!entry.numbersOk) mismatches += 1;
      if (!readsAsChinese(entry.translation)) notChinese += 1;
      lines.push(JSON.stringify({ ...row, note: entry.translation, language: 'zh-Hans', translatedFrom: entry.sourceSha256 }));
    }
    const casesText = `${lines.join('\n')}\n`;
    const dir = path.join(out, board.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cases.jsonl'), casesText, { flag: 'wx', mode: 0o600 });
    const entries = rows.map((row) => cache.get(keyOf(board.name, row)));
    const manifest = { board: board.name, of: board.of, split: board.split, language: 'zh-Hans', model: o.model, thinking: 'off', temperature: 0, promptVersion: PROMPT_VERSION, promptSha256: PROMPT_SHA256,
      sourceCasesSha256: sha256(rows.map((row) => `${row.patientId}:${sha256(row.note)}`).join('\n')), casesSha256: sha256(casesText), cases: rows.length, numberMismatches: mismatches, notChinese,
      attempts: entries.reduce((sum, entry) => sum + entry.attempts, 0), costCny: Number(entries.reduce((sum, entry) => sum + entry.cost, 0).toFixed(4)),
      inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0), outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0), frozen: true, note: 'trials, candidates, collections and qrels are the first boards\''};
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    frozen.push(manifest);
    log(`[prepare_zh] froze ${board.name}: ${rows.length} notes, ${mismatches} with differing numbers, ${notChinese} not Chinese, cases sha256 ${manifest.casesSha256.slice(0, 12)}`);
  }
  return { frozen: true, boards: frozen };
}

const OPTIONS = {
  boards: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, 'data-dir': { type: 'string' }, 'base-url': { type: 'string', default: 'https://api.deepseek.com' }, model: { type: 'string', default: 'deepseek-flash' },
  'db-url': { type: 'string' }, 'db-name': { type: 'string', default: 'evimed_test_vmzh' }, 'budget-cny': { type: 'string', default: '2' }, 'cap-cny': { type: 'string', default: String(DEFAULT_CAP_CNY) },
  'floor-cny': { type: 'string', default: String(DEFAULT_FLOOR_CNY) }, 'allow-peak': { type: 'boolean', default: false }, 'plan-only': { type: 'boolean', default: false },
  concurrency: { type: 'string', default: '4' }, 'max-tokens': { type: 'string', default: '4000' }, 'eval-python': { type: 'string' },
};

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  const boards = values.boards ?? env.VCR_BOARDS_INPUTS, out = values.out ?? env.VCR_BOARDS_ZH, dataDir = values['data-dir'] ?? env.VCR_BOARDS_DATA, keyFile = values['key-file'] ?? env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE;
  if (!boards || !out || !dataDir) throw fail('--boards, --out and --data-dir (or VCR_BOARDS_INPUTS, VCR_BOARDS_ZH, VCR_BOARDS_DATA) are needed.', 'option_missing');
  if (!keyFile && !values['plan-only']) throw fail('--key-file names the DeepSeek key file; the key is never printed.', 'option_missing');
  const budgetCny = Number(values['budget-cny']);
  if (!(budgetCny > 0 && budgetCny <= 50)) throw fail('--budget-cny is a positive amount, at most 50.', 'option_invalid');
  return { boardsDir: path.resolve(boards), out: path.resolve(out), dataDir: path.resolve(dataDir), keyFile: keyFile ? path.resolve(keyFile) : null, baseUrl: String(values['base-url']), model: String(values.model),
    dbUrl: values['db-url'] ?? env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? null, dbName: String(values['db-name']), budgetCny, capCny: Number(values['cap-cny']), floorCny: Number(values['floor-cny']),
    allowPeak: Boolean(values['allow-peak']), planOnly: Boolean(values['plan-only']), concurrency: Math.max(1, Math.min(16, Number(values.concurrency) || 4)), maxTokens: Math.max(500, Math.min(8000, Number(values['max-tokens']) || 4000)),
    evalPython: values['eval-python'] ?? env.VCR_BOARDS_PYTHON ?? 'python3' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await prepareZh(parseOptions(process.argv.slice(2)));
    process.exit(result.frozen || result.planOnly ? 0 : 1);
  } catch (error) {
    process.stderr.write(`prepare_zh: ${/** @type {any} */ (error)?.code ?? 'error'}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 300)}\n`);
    process.exit(error instanceof GuardStop ? 2 : 1);
  }
}
