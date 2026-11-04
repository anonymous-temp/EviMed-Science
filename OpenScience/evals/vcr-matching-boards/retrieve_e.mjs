#!/usr/bin/env node
/**
 * Board E, the retrieval half: the product's own trial search over a whole official TREC collection, scored later by `score_e.py`.
 *
 * For each topic of a split: one model call on `deepseek-flash` reads the patient's record and writes the search the way the
 * `vcr-matching` skill tells a conversation to (a condition, up to 32 ranked phrases, a summary of the patient, age and sex); the
 * collection's reader (`vcrTrialCorpus.mjs`, the code behind `vcr_read what: "candidates"` on a frozen collection) searches every phrase,
 * fuses the lists, applies the age and sex the record states and keeps up to 500; the same list is then reordered by DashScope's
 * reranker through `rerankCandidates`, the function the product calls. One JSONL per arm (`no-rerank`, `rerank`) holds the ids in order.
 *
 *   node retrieve_e.mjs --split split_e.json --set dev --topics <dir> --collections <dir> --out <dir> --exp r1 \
 *       --key-file <deepseek key> --dashscope-key-file <dashscope key>
 *
 * Labels are never read: this file has no qrels argument. The two collections are `<collections>/index2021/collection.json` (TREC 2021 and
 * 2022 share it) and `<collections>/index2023/collection.json`. Per topic the model's search, the reader's list and the rerank are
 * kept apart in `<out>/<exp>/topics/`, and a run again pays for nothing it already has. Guards: the peak window (the model call is full
 * price then), this stream's cap, and the shared balance floor (`budget.py`).
 *
 * Exit: 0 finished; 1 error; 2 refused before any paid call; 3 stopped by a guard with what was done kept; 4 finished with topics that failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPeak, priceUsage } from '@evimed/domain';
import { candidateRequest } from '../../apps/server/src/vcrCandidateSearch.mjs';
import { VcrCandidateRerank, rerankCandidates } from '../../apps/server/src/vcrCandidateRerank.mjs';
import { createVcrTrialCorpus } from '../../apps/server/src/vcrTrialCorpus.mjs';
import { fail } from './board_cases.mjs';
import { GuardStop, createBalanceChecker, createSpendLedger, preflight, watch } from './spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXIT = Object.freeze({ finished: 0, error: 1, refused: 2, stopped: 3, failedTopics: 4 });
const REAL_PROVIDER = 'https://api.deepseek.com';
const RERANK_BASE = 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks';
export const ARMS = Object.freeze(['no-rerank', 'rerank']);

// ---------------------------------------------------------------------------------------------------------------------------
// The topics
// ---------------------------------------------------------------------------------------------------------------------------

/** @param {string} value */
const decode = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (all, code) => {
  const named = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()];
  if (named) return named;
  const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
  return Number.isInteger(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : all;
});

/** The topic id the split files use: TREC 2021 and 2022 as `trec-20211`, TREC 2023 as `trec-2023-1`. @param {number} year @param {number} number */
export const topicId = (year, number) => (year === 2023 ? `trec-2023-${number}` : `trec-${year}${number}`);

/** The record of a questionnaire topic as plain lines: the template, then every field the topic filled in (an empty field is a fact not stated). @param {string} template @param {Array<[string, string]>} fields */
export function questionnaireNote(template, fields) {
  const lines = fields.filter(([, value]) => value.trim()).map(([name, value]) => `${name}: ${value.trim()}`);
  return [template ? `Condition questionnaire: ${template}` : 'Condition questionnaire', ...lines].join('\n');
}

/**
 * The topics of one year's official `topics<year>.xml`: free-text patient descriptions for 2021 and 2022, filled questionnaires for 2023.
 * The format is closed (`<topic number=..>`, `<field name=..>`), so this reads structure, not language.
 * @param {string} xml @param {number} year
 * @returns {Array<{ id: string, year: number, number: number, note: string }>}
 */
export function parseTopics(xml, year) {
  /** @type {Array<{ id: string, year: number, number: number, note: string }>} */
  const topics = [];
  for (const match of xml.matchAll(/<topic\b([^>]*)>([\s\S]*?)<\/topic>/gu)) {
    const number = Number(/\bnumber="(\d+)"/u.exec(match[1])?.[1]);
    if (!Number.isInteger(number) || number < 1) throw fail('A topic has no number.', 'topic_invalid');
    let note;
    if (year === 2023) {
      const template = decode(/\btemplate="([^"]*)"/u.exec(match[1])?.[1] ?? '');
      /** @type {Array<[string, string]>} */
      const fields = [...match[2].matchAll(/<field\s+name="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/field>)/gu)].map((field) => [decode(field[1]), decode(field[2] ?? '')]);
      note = questionnaireNote(template, fields);
    } else {
      note = decode(match[2]).trim();
    }
    if (!note) throw fail(`Topic ${number} of ${year} has no text.`, 'topic_invalid');
    topics.push({ id: topicId(year, number), year, number, note });
  }
  if (!topics.length) throw fail(`No topics were read for ${year}.`, 'topic_invalid');
  return topics;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The search the model writes: one function, so the harness and the skill say the same thing
// ---------------------------------------------------------------------------------------------------------------------------

/** The sentence of `capability-skills/vcr-matching/SKILL.md` that tells a conversation what to put in the search, word for word (a test holds it equal). */
export const SKILL_SEARCH_SENTENCE = '`condition` and up to 32 `terms` ranked by importance (the person\'s problems, in English and Chinese both when the record is Chinese), a `summary` of their problems, stage and treatments so far in your own words (no name or ID number), and the age, sex and region you read in the record.';
/** The tool description's sentence about the summary (`runtime/mcp/evimed-research/vcr_platform.py`, `candidates`), word for word (a test holds it equal). */
export const TOOL_SUMMARY_SENTENCE = 'a filter.summary of the patient\'s problems, stage and treatments so far (your own words, no name or ID number, never the note) to put the list in the order of how it reads against the patient';
export const TOOL_TERMS_SENTENCE = 'write filter.condition and up to 32 filter.terms ranked by priority (the patient\'s problems in order of importance, English and Chinese both when the note is Chinese; earlier phrases weigh more';

/** The one sentence the `english` prompt variant adds: the registry is searched in the language its records are written in. */
export const ENGLISH_REGISTRY_SENTENCE = 'The registry\'s records are written in English: write every phrase in English.';
export const PROMPT_VARIANTS = Object.freeze(['skill', 'english']);

/**
 * What the model is asked, as messages. The `skill` variant gives the model exactly the skill's and the tool's words; `english` adds one sentence
 * saying the frozen registry is English (the skill does not say, and a model reads 「English and Chinese both」 as both, always). In the product the conversation model writes these arguments itself after reading the skill and the
 * tool's description; here one call is given the same two passages and the record, and answers with the arguments as JSON.
 * @param {string} note @param {string} [variant]
 */
export function searchMessages(note, variant = 'skill') {
  const system = [
    'You prepare the search a patient-to-trial matching tool runs over a registry of clinical trials, from one patient\'s record.',
    `The tool takes: ${SKILL_SEARCH_SENTENCE}`,
    `The tool\'s description says: ${TOOL_TERMS_SENTENCE}) ... ${TOOL_SUMMARY_SENTENCE}.`,
    'Answer with one JSON object and nothing else: {"condition": string, "terms": string[], "summary": string, "age": number | null, "sex": "male" | "female" | null, "region": string | null}.',
    '`age` is in years and `sex` is male or female, only when the record says; `region` is a country in the registry\'s English spelling, only when the record says; each is null otherwise.',
    ...(variant === 'english' ? [ENGLISH_REGISTRY_SENTENCE] : []),
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Patient record:\n\n${note}` }];
}

/**
 * The model's JSON turned into the product's own request (validated by `candidateRequest`, the check the tool gateway runs). An argument the model
 * wrote outside the tool's limits is cut to them and counted, as a conversation would have been told to; a missing condition is a failure.
 * @param {any} parsed
 * @returns {{ request: import('../../apps/server/src/vcrCandidateSearch.mjs').CandidateRequest, adjusted: string[] }}
 */
export function requestFromAnswer(parsed) {
  /** @type {string[]} */
  const adjusted = [];
  const words = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  let terms = Array.isArray(parsed?.terms) ? parsed.terms.map(words).filter(Boolean) : [];
  const cut = terms.filter((term) => [...term].length <= 200);
  if (cut.length !== terms.length) adjusted.push('terms_too_long_dropped');
  terms = cut;
  if (terms.length > 32) { terms = terms.slice(0, 32); adjusted.push('terms_cut_to_32'); }
  let condition = words(parsed?.condition);
  if ([...condition].length > 200) { condition = [...condition].slice(0, 200).join(''); adjusted.push('condition_cut'); }
  let summary = words(parsed?.summary);
  if ([...summary].length > 2000) { summary = [...summary].slice(0, 2000).join(''); adjusted.push('summary_cut'); }
  const age = Number.isFinite(Number(parsed?.age)) && parsed?.age !== null && Number(parsed.age) >= 0 && Number(parsed.age) <= 130 ? Number(parsed.age) : null;
  const sex = ['male', 'female'].includes(String(parsed?.sex ?? '').toLowerCase()) ? String(parsed.sex).toLowerCase() : null;
  const region = words(parsed?.region);
  const asked = candidateRequest({ condition, terms, summary: summary || null, age, sex, region: region && [...region].length <= 80 ? region : null, status: 'any' }, { frozen: true });
  if (asked.ok === false) throw fail(asked.message, 'search_invalid');
  return { request: asked.request, adjusted };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Paid calls
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * One chat call to the model, through the provider's chat/completions with the key from a file. Returns the content and the usage; a
 * transient failure (network, 5xx, 429) is asked again twice, anything else is the caller's.
 * @param {{ baseUrl: string, apiKey: string, model: string, thinking: string, messages: Array<{ role: string, content: string }>, fetchImpl?: typeof fetch, signal?: AbortSignal }} input
 */
export async function chatOnce({ baseUrl, apiKey, model, thinking, messages, fetchImpl = fetch, signal }) {
  const body = {
    model, messages, max_tokens: thinking === 'off' ? 3000 : 16000, response_format: { type: 'json_object' }, stream: false,
    ...(thinking === 'off' ? { thinking: { type: 'disabled' }, temperature: 0 } : { thinking: { type: 'enabled' }, reasoning_effort: 'high' }),
  };
  let last = 'unknown';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => { setTimeout(resolve, 1500 * attempt); });
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(180_000),
      });
      if (response.status === 429 || response.status >= 500) { last = `http_${response.status}`; continue; }
      if (!response.ok) throw fail(`The model endpoint answered ${response.status}.`, `model_http_${response.status}`);
      const data = JSON.parse(await response.text());
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') { last = 'no_content'; continue; }
      const usage = data.usage ?? {};
      const hit = Number(usage.prompt_cache_hit_tokens ?? 0), miss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, Number(usage.prompt_tokens ?? 0) - hit));
      return { content, usage: { cacheHit: hit, cacheMiss: miss, output: Number(usage.completion_tokens ?? 0) }, finish: String(data?.choices?.[0]?.finish_reason ?? '') };
    } catch (error) {
      if (/** @type {any} */ (error)?.code?.startsWith?.('model_http_')) throw error;
      last = /** @type {any} */ (error)?.name === 'TimeoutError' ? 'timeout' : 'network';
    }
  }
  throw fail(`The model call did not complete (${last}).`, `model_${last}`);
}

/** @param {string} file */
function readKey(file) {
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw fail('A key file is empty.', 'key_empty');
  return key;
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** @param {string} file */
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

// ---------------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------------

const OPTIONS = {
  split: { type: 'string' }, set: { type: 'string', default: 'dev' }, years: { type: 'string', default: '2021,2022,2023' }, topics: { type: 'string' }, collections: { type: 'string' },
  out: { type: 'string' }, exp: { type: 'string' }, 'key-file': { type: 'string' }, 'dashscope-key-file': { type: 'string' }, 'base-url': { type: 'string', default: REAL_PROVIDER },
  'rerank-url': { type: 'string', default: RERANK_BASE }, 'rerank-model': { type: 'string', default: 'qwen3-rerank' }, model: { type: 'string', default: 'deepseek-flash' },
  thinking: { type: 'string', default: 'off' }, 'limit-topics': { type: 'string' }, concurrency: { type: 'string', default: '3' },
  'cap-cny': { type: 'string', default: '10' }, 'floor-cny': { type: 'string', default: '200' }, 'allow-peak': { type: 'boolean', default: false }, 'no-rerank': { type: 'boolean', default: false },
  'plan-only': { type: 'boolean', default: false }, 'rerank-timeout-ms': { type: 'string', default: '30000' }, 'rerank-budget-ms': { type: 'string', default: '120000' },
  prompt: { type: 'string', default: 'skill' }, 'spend-ledger': { type: 'string' }, 'eval-python': { type: 'string' }, help: { type: 'boolean', default: false },
};

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseOptions(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (values.help) return { help: true };
  for (const name of ['split', 'topics', 'collections', 'out', 'exp']) if (!values[name]) throw fail(`--${name} is required.`, 'option_missing');
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/u.test(String(values.exp))) throw fail('--exp names the experiment: lowercase letters, digits, - and _.', 'option_invalid');
  if (!['off', 'high'].includes(String(values.thinking))) throw fail('--thinking is off or high.', 'option_invalid');
  if (!PROMPT_VARIANTS.includes(String(values.prompt))) throw fail(`--prompt is one of ${PROMPT_VARIANTS.join(', ')}.`, 'option_invalid');
  const years = String(values.years).split(',').map(Number);
  if (!years.length || years.some((year) => ![2021, 2022, 2023].includes(year))) throw fail('--years lists 2021, 2022 and 2023.', 'option_invalid');
  const keyFile = values['key-file'] ?? env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE ?? null;
  const dashscopeKeyFile = values['dashscope-key-file'] ?? env.OPEN_SCIENCE_DASHSCOPE_API_KEY_FILE ?? null;
  const planOnly = Boolean(values['plan-only']);
  if (!planOnly && !keyFile) throw fail('--key-file names the DeepSeek key file; the key is never printed.', 'option_missing');
  const number = (/** @type {string} */ name, /** @type {number} */ min, /** @type {number} */ max) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw fail(`--${name} is a number from ${min} to ${max}.`, 'option_invalid');
    return value;
  };
  return {
    help: false, split: path.resolve(String(values.split)), set: String(values.set), years, topicsDir: path.resolve(String(values.topics)), collectionsDir: path.resolve(String(values.collections)),
    out: path.resolve(String(values.out)), exp: String(values.exp), keyFile: keyFile ? path.resolve(keyFile) : null, dashscopeKeyFile: dashscopeKeyFile ? path.resolve(dashscopeKeyFile) : null,
    baseUrl: String(values['base-url']), rerankUrl: String(values['rerank-url']), rerankModel: String(values['rerank-model']), model: String(values.model), thinking: String(values.thinking), prompt: String(values.prompt),
    limitTopics: values['limit-topics'] == null ? null : number('limit-topics', 1, 1000), concurrency: number('concurrency', 1, 16),
    capCny: number('cap-cny', 0, 100_000), floorCny: number('floor-cny', 0, 100_000), allowPeak: Boolean(values['allow-peak']), rerank: !values['no-rerank'], planOnly,
    rerankTimeoutMs: number('rerank-timeout-ms', 1000, 60_000), rerankBudgetMs: number('rerank-budget-ms', 2000, 120_000),
    spendLedger: values['spend-ledger'] ? path.resolve(String(values['spend-ledger'])) : null, evalPython: values['eval-python'] ?? env.VCR_BOARDS_PYTHON ?? 'python3',
  };
}

/**
 * The topics of the split's set, in the order of the split file, with their notes read from the official topic files.
 * @param {Record<string, any>} o
 */
export function selectedTopics(o) {
  const split = JSON.parse(fs.readFileSync(o.split, 'utf8'));
  const wanted = split[o.set];
  if (!wanted || typeof wanted !== 'object') throw fail(`The split has no set ${o.set}.`, 'split_unknown');
  /** Topics the official qrels do not judge: nothing can be scored on them, so no paid call is made for them. */
  const skipped = new Set(Object.values(split.unscorable ?? {}).flat());
  /** @type {Array<{ id: string, year: number, number: number, note: string }>} */
  const chosen = [];
  for (const year of o.years) {
    const ids = wanted[`trec_${year}`];
    if (!Array.isArray(ids)) continue;
    const byId = new Map(parseTopics(fs.readFileSync(path.join(o.topicsDir, `topics${year}.xml`), 'utf8'), year).map((topic) => [topic.id, topic]));
    for (const id of ids) {
      if (skipped.has(id)) continue;
      const topic = byId.get(id);
      if (!topic) throw fail(`The split names ${id}, which the ${year} topics do not have.`, 'topic_missing');
      chosen.push(topic);
    }
  }
  return o.limitTopics == null ? chosen : chosen.slice(0, o.limitTopics);
}

/** @param {number} year */
const collectionDir = (year) => (year === 2023 ? 'index2023' : 'index2021');

/**
 * @param {Record<string, any>} o parsed options
 * @param {{ log?: (line: string) => void, now?: () => Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null,
 *   fetchImpl?: typeof fetch, rerankFetch?: typeof fetch }} [deps]
 */
export async function runRetrieval(o, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const topics = selectedTopics(o);
  if (!topics.length) throw fail('No topics were selected.', 'no_topics');
  const root = path.join(o.out, o.exp);
  const dirs = { topics: path.join(root, 'topics') };
  fs.mkdirSync(dirs.topics, { recursive: true });
  const ledger = createSpendLedger(o.spendLedger ?? path.join(o.out, 'spend-ledger-e.jsonl'));
  const settingsFile = path.join(root, 'exp.json');
  const settings = { model: o.model, thinking: o.thinking, prompt: o.prompt ?? 'skill', rerankModel: o.rerankModel, split: path.basename(o.split), set: o.set };
  const held = readJson(settingsFile);
  if (held && JSON.stringify(held.settings) !== JSON.stringify(settings)) throw fail(`Experiment ${o.exp} was started with other settings; give this one a new --exp.`, 'exp_settings_differ');
  writeJson(settingsFile, { settings, startedAt: held?.startedAt ?? now().toISOString() });

  const file = (/** @type {string} */ id, /** @type {string} */ kind) => path.join(dirs.topics, `${id}.${kind}.json`);
  const needPlan = topics.filter((topic) => !readJson(file(topic.id, 'plan')));
  const peakNow = isPeak(now());
  const key = o.keyFile ? readKey(o.keyFile) : '';
  const balance = deps.balance !== undefined ? deps.balance
    : (o.keyFile && new URL(o.baseUrl).origin === REAL_PROVIDER ? createBalanceChecker({ python: o.evalPython, script: path.join(HERE, 'budget.py'), keyFile: o.keyFile, floor: o.floorCny }) : null);
  const recordedBefore = ledger.recorded();
  // The model call is one short exchange: about 1,500 tokens in and 700 out. The guard counts a generous 3,000 in and 1,500 out.
  const estimate = needPlan.length * (priceUsage({ resourceType: 'model', model: o.model, cacheHit: 0, cacheMiss: 3000, output: 1500, peak: peakNow }).cost ?? 0);
  log(`[retrieve_e] exp=${o.exp} topics=${topics.length} (${needPlan.length} without a search yet) model=${o.model} thinking=${o.thinking} rerank=${o.rerank ? o.rerankModel : 'off'}${peakNow ? '; PEAK window (full price)' : ''}; estimate CNY ${estimate.toFixed(3)} for the model calls; recorded so far CNY ${recordedBefore.toFixed(3)} of cap ${o.capCny}`);
  if (o.planOnly) return { exitCode: EXIT.finished, planned: topics.map((topic) => topic.id), estimateCny: estimate };
  /** @type {GuardStop | null} */
  let stop = null;
  if (needPlan.length) {
    try { const read = await preflight({ estimateCny: estimate, capCny: o.capCny, recordedCny: recordedBefore, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance }); if (read != null) log(`[retrieve_e] balance CNY ${read.toFixed(2)}`); } catch (error) {
      if (error instanceof GuardStop) { log(`[retrieve_e] refused: ${error.message}`); return { exitCode: EXIT.refused }; }
      throw error;
    }
  }

  // --- A. the search the model writes, topic by topic (several at once) ---------------------------------------------------
  const failures = /** @type {Record<string, string>} */ ({});
  let spentRun = 0;
  const askOne = async (/** @type {typeof topics[number]} */ topic) => {
    if (stop) return;
    try {
      const answered = await chatOnce({ baseUrl: o.baseUrl, apiKey: key, model: o.model, thinking: o.thinking, messages: searchMessages(topic.note, o.prompt ?? 'skill'), fetchImpl: deps.fetchImpl });
      const cost = priceUsage({ resourceType: 'model', model: o.model, cacheHit: answered.usage.cacheHit, cacheMiss: answered.usage.cacheMiss, output: answered.usage.output, peak: isPeak(now()) });
      ledger.append({ kind: 'job', arm: o.exp, board: 'retrieve-e', jobId: `retrieve:${o.exp}:${topic.id}:plan`, costCny: cost.priced ? cost.cost : 0, calls: 1 });
      spentRun += cost.priced ? cost.cost : 0;
      let parsed;
      try { parsed = JSON.parse(answered.content); } catch { throw fail('The answer was not JSON.', 'search_unreadable'); }
      const { request, adjusted } = requestFromAnswer(parsed);
      writeJson(file(topic.id, 'plan'), { topic: topic.id, request, adjusted, usage: answered.usage, costCny: cost.priced ? cost.cost : null, finish: answered.finish, at: now().toISOString() });
    } catch (error) {
      failures[topic.id] = String(/** @type {any} */ (error)?.code ?? 'failed');
      log(`[retrieve_e] ${topic.id}: the search was not written (${failures[topic.id]})`);
    }
  };
  let next = 0;
  const lanes = Array.from({ length: Math.min(o.concurrency, needPlan.length) }, async () => {
    while (next < needPlan.length && !stop) {
      const topic = needPlan[next]; next += 1;
      await askOne(topic);
      const verdict = await watch({ spentThisRunCny: spentRun, recordedBeforeCny: recordedBefore, capCny: o.capCny, floor: o.floorCny, allowPeak: o.allowPeak, now: now(), balance: null });
      if (verdict.stop) stop = stop ?? verdict.stop;
    }
  });
  await Promise.all(lanes);

  // --- B. the reader's list for each search, and the rerank of it ---------------------------------------------------------
  /** @type {Map<number, ReturnType<typeof createVcrTrialCorpus>>} */
  const corpora = new Map();
  const corpusOf = (/** @type {number} */ year) => {
    const dir = collectionDir(year);
    if (!corpora.has(dir === 'index2023' ? 2023 : 2021)) {
      corpora.set(dir === 'index2023' ? 2023 : 2021, createVcrTrialCorpus(path.join(o.collectionsDir, dir, 'collection.json'), { timeoutMs: 120_000 }));
    }
    return /** @type {NonNullable<ReturnType<typeof createVcrTrialCorpus>>} */ (corpora.get(dir === 'index2023' ? 2023 : 2021));
  };
  const rerankKey = o.rerank && o.dashscopeKeyFile ? readKey(o.dashscopeKeyFile) : '';
  let rerankTokensRun = 0;
  const reranker = o.rerank ? new VcrCandidateRerank({
    apiKey: rerankKey, model: o.rerankModel, apiBase: o.rerankUrl, timeoutMs: o.rerankTimeoutMs, budgetMs: o.rerankBudgetMs, batchSize: 50, concurrency: 3,
  }, { fetchImpl: deps.rerankFetch ?? fetch, report: () => {} }) : null;
  try {
    for (const topic of topics) {
      const plan = readJson(file(topic.id, 'plan'));
      if (!plan) continue;
      let retrieval = readJson(file(topic.id, 'list'));
      /** @type {any} */ let collected = null;
      const needList = !retrieval || (o.rerank && !readJson(file(topic.id, 'rerank')));
      if (needList) {
        const started = Date.now();
        try { collected = await corpusOf(topic.year).collect(plan.request); } catch (error) {
          failures[topic.id] = String(/** @type {any} */ (error)?.code ?? 'collect_failed');
          log(`[retrieve_e] ${topic.id}: the collection could not be searched (${failures[topic.id]})`);
          continue;
        }
        retrieval = {
          topic: topic.id, collection: collected.collection, ids: collected.candidates.map((/** @type {any} */ row) => row.registryId), found: collected.found, leftOut: collected.leftOut,
          retrieval: { ...collected.retrieval, retrievedIds: undefined }, millis: Date.now() - started,
        };
        writeJson(file(topic.id, 'list'), retrieval);
      }
      if (o.rerank && !readJson(file(topic.id, 'rerank'))) {
        if (!collected) continue;
        const stopNow = await watch({ spentThisRunCny: spentRun, recordedBeforeCny: recordedBefore, capCny: o.capCny, floor: o.floorCny, allowPeak: true, now: now(), balance: null });
        if (stopNow.stop) { stop = stop ?? stopNow.stop; continue; }
        let tokens = 0;
        const started = Date.now();
        const outcome = await rerankCandidates({ summary: plan.request.summary ?? '', candidates: collected.candidates.map((/** @type {any} */ row) => ({
          registryId: row.registryId, title: row.title, conditions: row.conditions, interventions: row.interventions, phase: row.phase,
          sexStated: row.sex, ageStated: row.age, eligibilityHead: collected.cards?.[row.registryId] ?? '' })) },
        { reranker, bill: async (spend) => { tokens += spend.tokens; } });
        const cost = priceUsage({ resourceType: 'model', model: o.rerankModel, cacheHit: 0, cacheMiss: tokens, output: 0, peak: true });
        if (outcome.batches) ledger.append({ kind: 'job', arm: o.exp, board: 'retrieve-e', jobId: `retrieve:${o.exp}:${topic.id}:rerank`, costCny: cost.priced ? cost.cost : 0, calls: outcome.batches });
        spentRun += cost.priced ? cost.cost : 0;
        rerankTokensRun += tokens;
        writeJson(file(topic.id, 'rerank'), { topic: topic.id, ids: outcome.ids, state: outcome.state, applied: outcome.applied, batches: outcome.batches, failedBatches: outcome.failedBatches,
          reasons: outcome.reasons, model: outcome.model, tokens, costCny: cost.priced ? cost.cost : null, millis: Date.now() - started });
        log(`[retrieve_e] ${topic.id}: ${retrieval.ids.length} retrieved, rerank ${outcome.state} (${outcome.batches} batches, ${tokens} tokens, ${Date.now() - started} ms)`);
      }
    }
  } finally {
    for (const corpus of corpora.values()) await corpus?.close();
  }

  // --- C. one JSONL per arm ----------------------------------------------------------------------------------------------
  const counts = /** @type {Record<string, number>} */ ({});
  for (const arm of ARMS) {
    if (arm === 'rerank' && !o.rerank) continue;
    const lines = [];
    for (const topic of topics) {
      const plan = readJson(file(topic.id, 'plan')), list = readJson(file(topic.id, 'list')), rerank = arm === 'rerank' ? readJson(file(topic.id, 'rerank')) : null;
      if (!plan || !list || (arm === 'rerank' && !rerank)) continue;
      lines.push(JSON.stringify({
        topic: topic.id, year: topic.year, number: topic.number, arm, exp: o.exp, collection: list.collection,
        request: { condition: plan.request.condition, terms: plan.request.terms, age: plan.request.age, sex: plan.request.sex, region: plan.request.region, summary: plan.request.summary },
        adjusted: plan.adjusted, found: list.found, leftOut: list.leftOut, retrieval: list.retrieval, listMillis: list.millis,
        ...(arm === 'rerank' ? { rerank: { state: rerank.state, applied: rerank.applied, batches: rerank.batches, failedBatches: rerank.failedBatches, reasons: rerank.reasons, model: rerank.model, tokens: rerank.tokens, millis: rerank.millis } } : {}),
        searchCostCny: plan.costCny, rerankCostCny: rerank?.costCny ?? null,
        retrieved: arm === 'rerank' ? rerank.ids : list.ids,
      }));
    }
    const target = path.join(root, `retrieved-${arm}.jsonl`);
    fs.writeFileSync(`${target}.tmp`, lines.length ? `${lines.join('\n')}\n` : '');
    fs.renameSync(`${target}.tmp`, target);
    counts[arm] = lines.length;
  }
  const failed = topics.filter((topic) => !readJson(file(topic.id, 'plan')) || !readJson(file(topic.id, 'list')) || (o.rerank && !readJson(file(topic.id, 'rerank')))).map((topic) => topic.id);
  const summary = { exp: o.exp, topics: topics.length, written: counts, failed, failures, spentThisRunCny: Number(spentRun.toFixed(4)), rerankTokens: rerankTokensRun, campaignCnyAfter: Number(ledger.recorded().toFixed(4)), stopped: stop ? { code: /** @type {GuardStop} */ (stop).code, message: /** @type {GuardStop} */ (stop).message } : null };
  writeJson(path.join(root, 'summary.json'), summary);
  log(`[retrieve_e] ${stop ? `stopped (${/** @type {GuardStop} */ (stop).code}), partial results kept` : 'finished'} | written ${JSON.stringify(counts)} | failed ${failed.length} | cost this run CNY ${spentRun.toFixed(4)}`);
  return { exitCode: stop ? EXIT.stopped : failed.length ? EXIT.failedTopics : EXIT.finished, summary };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseOptions(argv, env); } catch (error) {
    process.stderr.write(`retrieve_e: ${/** @type {any} */ (error)?.message ?? error}\n`);
    return EXIT.error;
  }
  if (options.help) { process.stdout.write(`${fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^[^]*?\/\*\*\n/u, '').replace(/^ \* ?/gmu, '')}\n`); return EXIT.finished; }
  try { return (await runRetrieval(options)).exitCode; } catch (error) {
    process.stderr.write(`retrieve_e: ${/** @type {any} */ (error)?.code ?? 'error'}: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 400)}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
