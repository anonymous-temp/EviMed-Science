/**
 * The frontier jury (2026-10-26): Qwen 3.8 Max, a model of a different family from production's screener (DeepSeek), labels frontier-feed
 * items `pick` (belongs in the daily featured selection), `ok` (relevant, not featured) or `no` (not worth showing) with no
 * human labelling. Two independent passes per item, differing only in the order of the worked examples; agreement stands as
 * the label, disagreement abstains (`worth: null`). Before its labels are used the jury is calibrated against the
 * human-adjudicated anchor (`evals/frontier-selection/gold.jsonl`): odd `n` rows are the exemplar pool, even `n` rows the
 * calibration set and never appear in a prompt as an exemplar.
 *
 * It is the one adjudicator that is not Claude (owner 2026-11-03, after a measurement, `RSI_FRONTIER_JURY` in the domain package): on the same
 * 124 anchor rows it scored pick kappa 0.875 against the best Claude setting's 0.686, and it runs on the lab, unattended, with the one provider
 * credential the lab holds.
 *
 * The jury reads only the source's own text (title, source, journal, publication types, date, language, abstract or page
 * excerpt). Every field the platform's own models wrote (`title_zh`, `summary_zh`, scores, genre, evidence type) is dropped
 * before a prompt is built, so a label never inherits the screener's reading.
 *
 * Money goes through the lab's budget ledger one batch at a time: reserve an upper bound, begin the spend, make the calls,
 * settle the priced actual (a model with no price refuses the run before any money moves). Every answer is appended to a JSONL cache the
 * moment it arrives, stamped with the campaign that paid for it, so an interrupted run resumes without paying twice and a file's `costCny` is what its
 * campaign paid for its items over every start. The labelling shares one cache across months; a calibration has a cache per month, so that it measures
 * the jury every month instead of replaying the first answers. The key is read from its file once and appears nowhere else.
 *
 * A month is labelled in two phases (`plan.idsByRole`): development first, and confirmation only when `frontier_assemble.mjs decide` finds a
 * candidate from the development labels alone. Each labels file names its phase, month, export and jury.
 *
 *   node frontier_labels.mjs calibrate --gold gold.jsonl --credential key --out calibration.json --cache calibration-cache.jsonl --campaign id --config lab.json
 *   node frontier_labels.mjs label --export export.json[.gz] --plan plan.json --phase development|confirmation --credential key --out labels.json --cache cache.jsonl --campaign id --config lab.json
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { priceListAt, priceUsage } from '../../packages/domain/src/metering.mjs';
import { RSI_FRONTIER_JURY } from '../../packages/domain/src/rsiCampaign.mjs';

/** Bump on any change to the rubric's meaning; the prompt digest covers its bytes. v1 is the rubric the lab's answer cache is keyed on. */
export const FRONTIER_JURY_VERSION = 'frontier-jury-v1';
export const FRONTIER_JURY_PROVIDER = RSI_FRONTIER_JURY.provider;
export const FRONTIER_JURY_MODEL = RSI_FRONTIER_JURY.model;
export const FRONTIER_WORTH = Object.freeze(['pick', 'ok', 'no']);
export const FRONTIER_LABELS_SCHEMA = 'rsi-frontier-jury-labels-v1';
export const FRONTIER_CALIBRATION_SCHEMA = 'rsi-frontier-jury-calibration-v1';
/** The label phases of a month: development decides whether confirmation is labelled at all. */
export const FRONTIER_LABEL_PHASES = Object.freeze(['development', 'confirmation']);
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MAX_OUTPUT_TOKENS = 200;
const MAX_EXCERPT = 1200;
/** DashScope's codes for "the content inspection refused this text" (compatible mode, native): the one 400 that is about the item. Arrears are a 400 too (`Arrearage`, `providerRefusals.mjs`). */
const CONTENT_REFUSAL_CODES = new Set(['data_inspection_failed', 'DataInspectionFailed']);
/** Why the ledger will not give a stage key again: begun or settled, held from an earlier month, or reserved under limits since changed. The next key is a new record, admitted against the ceilings like any other. */
const STAGE_KEY_TAKEN = new Set(['campaign_budget_already_dispatched', 'campaign_budget_month_expired', 'campaign_budget_idempotency_conflict']);
/** A bound on one batch's search for a free key, not a limit on starts: every start that failed outright used one. Past it the run stops by name. */
const MAX_STAGE_KEYS = 1000;

/** @typedef {{title_raw?:string|null, source_name?:string|null, source_type?:string|null, journal?:string|null, publication_types?:string[]|null, published_at?:string|null, date_precision?:string|null, lang?:string|null, excerpt?:string|null}} FrontierItemText */
/** @typedef {{n?:number, id?:string, text:FrontierItemText, worth:'pick'|'ok'|'no', why:string}} FrontierExemplar */
/** @typedef {{role:'system'|'user', content:string}} JuryMessage */
/** @typedef {{cacheHit:number, cacheMiss:number, output:number}} JuryUsage */
/** @typedef {{text:string, usage:JuryUsage|null, requestId:string|null, finishReason:string|null, possiblyBilled?:number}} JuryReply `possiblyBilled`: the earlier attempts behind this answer that may have been charged. */
/** @typedef {(messages:JuryMessage[], options?:{signal?:AbortSignal}) => Promise<JuryReply>} JuryCaller */

const EXEMPLAR_EXCERPT = 500;
const RUBRIC = `你是「循证医学前沿动态」的内容审核员。You are a reviewer for a medical frontier feed.

读者 / Reader
读者是临床医生或医学研究者，每天只花几分钟浏览。判断标准只有一个：这位读者今天是否应该看到这条内容。
The reader is a clinician or medical researcher who scans the feed for a few minutes a day. The only question is whether such a reader should see this item today.

任务 / Task
只根据给出的来源文本（标题、来源、期刊、文献类型、日期、正文摘录）给这条内容打标签。不要补充文本里没有的事实：不要凭记忆写结果、数字、批准情况或样本量。标题听起来重要、但正文里看不到结果时，不能给 pick。
Judge only from the source text you are given. Do not assume facts it does not state: no results, numbers, approvals or sample sizes from memory. An important-sounding title whose text shows no result is not a pick.

标签 / Labels
pick（精选）：这位读者今天应该看到的内容。
- 改变或指导临床实践的原始结果：大型或设计严谨的随机对照试验、有定论意义的队列研究。Practice-changing or practice-informing primary results: large or rigorous RCTs, definitive cohorts.
- 重要的指南与共识，尤其是首次发布、多学会联合或适用面广的。Major guidelines and consensus statements, especially first, joint or broad ones.
- 监管批准或撤销、药品与器械安全警示、召回。Regulatory approvals or withdrawals, safety alerts and recalls.
- 顶级期刊上影响力大的发现。High-impact findings in leading journals.
- 重大公共卫生事件：暴发、风险评估、疫情通报。Major public-health events: outbreaks, threat assessments, epidemic reports.

ok：与医学相关且可靠，但不必精选。专科面窄、增量式、初步的研究；机制研究、动物或体外研究；小样本或范围很窄的研究；对已知内容的综述、盘点、访谈、评论；日常行业新闻；只对狭小人群或单一产品有意义的通知。
Medically relevant and sound, but niche, incremental, preliminary, mechanistic, animal or in-vitro, small or narrow, routine news, commentary or roundups.

no：不值得展示。与医学无关（财报、商业、专利或法务公关稿）；不是新闻（常青科普指南、早已过期又重新出现的清单、同一稿件的译文或重复稿）；广告、融资或企业宣传；文本为空或无法阅读，且标题也看不出医学内容。
Not worth showing: not medical, not news (evergreen guides, stale lists resurfacing, translated or duplicate copies of one release), advertising or press-release fluff, unreadable or empty with no medical content in the title.

判断要点 / Guidance
1. pick 是少数；多数医学相关内容是 ok。Most medically relevant items are ok; pick is the minority.
2. 实践意义比刊物名气重要：刊物名望本身不使一项窄研究成为 pick，仅涉及狭小范围的监管通知通常是 ok。Practical weight outranks venue prestige.
3. 给出了「今天」的日期。按该日期看明显过时、文本里又没有新内容的条目不是新闻。An item that is old by the given date and shows nothing new is not news.
4. 语言和来源类型不决定标签，内容决定：外文或非期刊来源也可能是 pick，期刊论文也可能是 ok 或 no。Content decides, not language or source type.
5. 正文为空时只能依据标题和来源，结果通常是 ok 或 no，很少是 pick。With no text, judge from title and source; rarely a pick.

输出 / Output
只输出一个 JSON 对象：{"worth":"pick|ok|no","why":"一句简短的依据，不超过 200 个字符"}。Output a single JSON object and nothing else.

以下是已由人工裁定的示例，用来示范如何使用上述标准；请阅读新条目本身，不要照抄示例的标签。
Adjudicated examples follow. They show how the rubric is applied; read the new item itself and do not copy an example's label.`;

/** sha256 of the system prompt template (rubric and examples header, before any exemplar); a prompt change is a new version.
 * @returns {string} */
export function frontierJuryPromptDigest() { return sha(RUBRIC); }

/** The version stamped on cached answers: the label, the template digest and the exemplar set (order-free, so both passes share it).
 * @param {FrontierExemplar[]} exemplars @returns {string} */
export function frontierJuryVersion(exemplars) {
  const set = exemplars.map((exemplar) => JSON.stringify([exemplar.id ?? null, exemplar.worth, exemplar.why, normalizeText(exemplar.text)])).sort();
  return `${FRONTIER_JURY_VERSION}:${sha(JSON.stringify([frontierJuryPromptDigest(), set])).slice(0, 12)}`;
}

/** @param {string} value */
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param {unknown} value */
const str = (value) => (typeof value === 'string' ? value.trim() : '');
/** @param {string|number} instant @returns {string} the Asia/Shanghai calendar day */
export function shanghaiDay(instant) { return new Date(Date.parse(String(instant)) + 8 * 3600_000).toISOString().slice(0, 10); }

/** The only fields a prompt may carry. @param {FrontierItemText|null|undefined} text */
function normalizeText(text) {
  const t = text && typeof text === 'object' ? text : {};
  const at = str(t.published_at);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : Number.isFinite(Date.parse(at)) ? shanghaiDay(at) : at;
  const precision = str(t.date_precision);
  return {
    title: str(t.title_raw), source: str(t.source_name), sourceType: str(t.source_type), journal: str(t.journal),
    types: Array.isArray(t.publication_types) ? t.publication_types.map(str).filter(Boolean) : [],
    published: day && precision && precision !== 'day' ? `${day} (${precision})` : day,
    lang: str(t.lang), excerpt: str(t.excerpt).slice(0, MAX_EXCERPT),
  };
}

/** @param {FrontierItemText} text */
function renderItem(text) {
  const t = normalizeText(text), unknown = '(unknown)';
  return [
    `标题 Title: ${t.title || unknown}`,
    `来源 Source: ${t.source || unknown}${t.sourceType ? ` [${t.sourceType}]` : ''}`,
    `期刊 Journal: ${t.journal || '-'}`,
    `文献类型 Publication types: ${t.types.join('; ') || '-'}`,
    `发布 Published: ${t.published || unknown}`,
    `语言 Language: ${t.lang || unknown}`,
    `正文摘录 Source text: ${t.excerpt || '(empty)'}`,
  ].join('\n');
}

/** The anchor's row in the export's text shape: nothing the platform's models wrote.
 * @param {any} row @returns {FrontierItemText} */
export function goldItemText(row) {
  return { title_raw: row.title_raw, source_name: row.source?.name ?? null, source_type: row.source?.type ?? null, journal: row.journal ?? null,
    publication_types: row.publication_types ?? [], published_at: row.published ?? null, date_precision: null, lang: row.lang ?? null, excerpt: row.text_excerpt ?? '' };
}

/** @param {string|URL} path @returns {Promise<any[]>} */
export async function loadGoldRows(path) {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Ten exemplars from the odd-`n` pool, the lowest `n` per class that has a readable excerpt, interleaved by class so no run of
 * one label ends the prompt.
 * @param {any[]} goldRows @param {{counts?:Record<string,number>, minExcerpt?:number}} [options] @returns {FrontierExemplar[]} */
export function selectFrontierExemplars(goldRows, { counts = { pick: 4, ok: 4, no: 2 }, minExcerpt = 200 } = {}) {
  const queues = FRONTIER_WORTH.map((worth) => goldRows.filter((row) => row.n % 2 === 1 && row.label?.worth === worth && str(row.text_excerpt).length >= minExcerpt)
    .sort((a, b) => a.n - b.n).slice(0, counts[worth] ?? 0));
  /** @type {FrontierExemplar[]} */
  const out = [];
  for (let at = 0; queues.some((queue) => at < queue.length); at++) {
    // An exemplar shows how the rubric applies; 500 characters of its text do that, and keep every call's cached prefix small.
    for (const queue of queues) if (at < queue.length) out.push({ n: queue[at].n, id: queue[at].id, text: { ...goldItemText(queue[at]), excerpt: str(queue[at].text_excerpt).slice(0, EXEMPLAR_EXCERPT) }, worth: queue[at].label.worth, why: str(queue[at].label.why) });
  }
  return out;
}

/** The two messages of one jury call. The system message is the rubric then the exemplars, byte-stable for a given exemplar order
 * so the provider's prefix cache applies; the user message is the date and the one item.
 * @param {FrontierItemText} item @param {{exemplars:FrontierExemplar[], today:string}} options @returns {JuryMessage[]} */
export function frontierJuryMessages(item, { exemplars, today }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) throw new Error('jury_today_invalid');
  for (const exemplar of exemplars ?? []) {
    if (Number.isInteger(exemplar.n) && /** @type {number} */ (exemplar.n) % 2 === 0) throw new Error('jury_exemplar_calibration_row');
    if (!FRONTIER_WORTH.includes(exemplar.worth)) throw new Error('jury_exemplar_invalid');
  }
  const shown = (exemplars ?? []).map((exemplar, at) => `### 示例 ${at + 1} / Example ${at + 1}\n${renderItem(exemplar.text)}\n答案 Answer: ${JSON.stringify({ worth: exemplar.worth, why: exemplar.why })}`);
  return [
    { role: 'system', content: [RUBRIC, ...shown].join('\n\n') },
    { role: 'user', content: `今天是 ${today}（Asia/Shanghai）\n\n请给下面这条内容打标签 / Label this item:\n\n${renderItem(item)}` },
  ];
}

/** @param {unknown} text @returns {{worth:'pick'|'ok'|'no', why:string}|null} */
export function parseJuryAnswer(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const worth = typeof value.worth === 'string' ? value.worth.trim().toLowerCase() : '';
  if (!FRONTIER_WORTH.includes(worth)) return null;
  return { worth: /** @type {'pick'|'ok'|'no'} */ (worth), why: typeof value.why === 'string' ? value.why.trim().slice(0, 200) : '' };
}

/** A closed-code failure: never carries a vendor message, which is known to echo credentials. `billed` is false when the provider
 * answered with an error status (nothing generated) and null when a charge cannot be ruled out; `possiblyBilled` counts the attempts behind the failure that may have been charged. */
export class JuryError extends Error {
  /** @param {string} code @param {{retryable?:boolean, billed?:boolean|null}} [options] */
  constructor(code, { retryable = false, billed = null } = {}) {
    super(code); this.name = 'JuryError'; this.code = code; this.retryable = retryable; this.billed = billed; this.possiblyBilled = billed === false ? 0 : 1;
  }
}

/** The provider's own code in an error body, `{error:{code}}` in compatible mode and `{code}` natively. Only the code: the message is known to echo the key. @param {{json:()=>Promise<any>}} response */
async function refusalCode(response) {
  try { const body = await response.json(); return String(body?.error?.code ?? body?.code ?? ''); } catch { return ''; }
}

/** The jury's DashScope caller. The key is read from its file once and appears nowhere else.
 * @param {{credentialPath:string, baseUrl?:string, model?:string, timeoutMs?:number, retries?:number, fetchImpl?:typeof fetch, sleep?:(ms:number)=>Promise<void>}} options
 * @returns {JuryCaller} */
export function dashscopeCaller({ credentialPath, baseUrl = DASHSCOPE_BASE_URL, model = FRONTIER_JURY_MODEL, timeoutMs = 60_000, retries = 3,
  fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  /** @type {string|null} */
  let key = null;
  const credential = async () => {
    if (key) return key;
    let raw;
    // No request is made without a key, so a missing one is never billed.
    try { raw = await readFile(credentialPath, 'utf8'); } catch { throw new JuryError('jury_credential_unreadable', { billed: false }); }
    if (!raw.trim()) throw new JuryError('jury_credential_missing', { billed: false });
    return (key = raw.trim());
  };
  const body = (/** @type {JuryMessage[]} */ messages) => JSON.stringify({
    model, messages, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, enable_thinking: false,
    response_format: { type: 'json_schema', json_schema: { name: 'frontier_label', strict: true, schema: { type: 'object',
      properties: { worth: { type: 'string', enum: [...FRONTIER_WORTH] }, why: { type: 'string', maxLength: 200 } }, required: ['worth', 'why'], additionalProperties: false } } },
  });
  /** @param {JuryMessage[]} messages @param {AbortSignal|undefined} signal @returns {Promise<JuryReply>} */
  const once = async (messages, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${await credential()}`, 'content-type': 'application/json' }, body: body(messages),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        if (response.status === 400 && CONTENT_REFUSAL_CODES.has(await refusalCode(response))) throw new JuryError('jury_content_refused', { billed: false });
        throw new JuryError(`jury_http_${response.status}`, { retryable: response.status === 429 || response.status >= 500, billed: false });
      }
      const data = await response.json();
      const choice = data?.choices?.[0];
      if (typeof choice?.message?.content !== 'string') throw new JuryError('jury_bad_response');
      const u = data.usage, prompt = Number(u?.prompt_tokens), output = Number(u?.completion_tokens);
      const cached = Math.min(Math.max(Number(u?.prompt_tokens_details?.cached_tokens) || 0, 0), prompt);
      const usage = Number.isFinite(prompt) && Number.isFinite(output) && prompt >= 0 && output >= 0 ? { cacheHit: cached, cacheMiss: prompt - cached, output } : null;
      return { text: choice.message.content, usage, requestId: response.headers?.get?.('x-request-id') ?? (typeof data.id === 'string' ? data.id : null), finishReason: choice.finish_reason ?? null };
    } catch (error) {
      if (error instanceof JuryError) throw error;
      if (signal?.aborted) throw new JuryError('jury_aborted');
      if (timeout.aborted || /** @type {any} */ (error)?.name === 'TimeoutError') throw new JuryError('jury_timeout', { retryable: true });
      throw new JuryError('jury_network', { retryable: true });
    }
  };
  // Retries share their caller's one reservation, so the attempts that may have been charged go back with the result and are priced there.
  return async (messages, { signal } = {}) => {
    let possiblyBilled = 0;
    for (let attempt = 0; ; attempt++) {
      try { return { ...(await once(messages, signal)), possiblyBilled }; } catch (error) {
        const failure = /** @type {JuryError} */ (error);
        possiblyBilled += failure.possiblyBilled;
        if (!failure.retryable || attempt >= retries) { failure.possiblyBilled = possiblyBilled; throw failure; }
        await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }
  };
}

/** @param {number} value CNY rounded up to the ledger's 1e-8 precision */
const ceilCny = (value) => Math.ceil(value * 1e8 - 1e-6) / 1e8;
const roundCny = (/** @type {number} */ value) => Math.round(value * 1e8) / 1e8;

/** The jury's priced usage at the list in force; an unpriced model refuses the run before any money moves.
 * @param {string} model @param {string} instant */
function pricing(model, instant) {
  const list = priceListAt(instant);
  /** @param {Partial<JuryUsage>} usage */
  const price = (usage) => {
    const priced = priceUsage({ resourceType: 'model', model, cacheHit: usage.cacheHit ?? 0, cacheMiss: usage.cacheMiss ?? 0, output: usage.output ?? 0, peak: true }, list);
    if (!priced.priced) throw new Error('jury_unpriced');
    return priced.cost;
  };
  price({ output: 1 });
  return price;
}

/** Every record of a cache file: the answers, and the charges of calls that left none. A line that does not parse is no record.
 * @param {string} cachePath @returns {Promise<any[]>} */
async function readCacheRecords(cachePath) {
  let text = '';
  try { text = await readFile(cachePath, 'utf8'); } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error; }
  /** @type {any[]} */
  const records = [];
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record === 'object') records.push(record);
  }
  return records;
}
const isAnswer = (/** @type {any} */ record) => typeof record.id === 'string' && (record.pass === 'A' || record.pass === 'B') && typeof record.juryVersion === 'string' && typeof record.model === 'string';
const cacheKey = (/** @type {any} */ { id, pass, juryVersion, model }) => JSON.stringify([id, pass, juryVersion, model]);

/** Run `worker` over `tasks` with at most `limit` in flight; results keep their order. */
async function runLimited(/** @type {any[]} */ tasks, /** @type {number} */ limit, /** @type {(task:any)=>Promise<any>} */ worker) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) { const at = next++; results[at] = await worker(tasks[at]); }
  }));
  return results;
}

/**
 * Label items with two passes each. The first pass reads the exemplars in their order, the second in reverse. Each batch of calls
 * reserves an upper bound (every prompt character as an uncached token, plus the output cap), begins its spend, calls the model,
 * and settles the priced actual; a refusal stops the run and returns what was done. Every attempt that may have billed (a timeout, a lost connection, an
 * unreadable answer) is charged at the upper bound beside what the answer cost, retries included, and one the provider rejected by status is not charged. A charge that leaves
 * no answer is its own cache record (`pass: null`), so the campaign's figure is the ledger's. A pass the content inspection refused is an abstention (`jury-refused`), cached: it
 * says the same next month. Any other refusal is about the account or the request, so it is a failed call, and nothing of it is kept.
 * @param {{items:{id:string, text:FrontierItemText, today?:string}[], exemplars:FrontierExemplar[], callModel:JuryCaller,
 *   budget:{reserve:Function, beginSpend:Function, settle:Function}, campaignId:string, stagePrefix?:string, now?:()=>string,
 *   concurrency?:number, batchSize?:number, cachePath?:string, signal?:AbortSignal, model?:string}} options
 * @returns {Promise<{labels:{id:string, worth:'pick'|'ok'|'no'|null, basis:'jury-agree'|'jury-disagree'|'jury-invalid'|'jury-refused', passes:{pass:string, worth:string|null, why:string}[]}[],
 *   costCny:number, campaignCostCny:number, calls:number, cachedCalls:number, incomplete:number, stopped:string|null}>} `costCny` is this start's spend; `campaignCostCny` what the cache says
 *   this campaign paid for these items over all its starts (a record of another campaign, or from before the stamp, was paid by that one)
 */
export async function labelFrontierItems({ items, exemplars, callModel, budget, campaignId, stagePrefix = 'frontier-jury', now = () => new Date().toISOString(),
  concurrency = 6, batchSize = 40, cachePath, signal, model = FRONTIER_JURY_MODEL }) {
  if (typeof callModel !== 'function' || !budget) throw new Error('jury_unconfigured');
  const price = pricing(model, now());
  const juryVersion = frontierJuryVersion(exemplars);
  const orders = { A: exemplars, B: [...exemplars].reverse() };
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const records = cachePath ? await readCacheRecords(cachePath) : [];
  const cache = new Map(records.filter(isAnswer).map((record) => [cacheKey(record), record]));
  if (cachePath) await mkdir(dirname(cachePath), { recursive: true });
  const pending = [];
  let cachedCalls = 0;
  for (const item of unique) {
    for (const pass of /** @type {('A'|'B')[]} */ (['A', 'B'])) {
      if (cache.has(cacheKey({ id: item.id, pass, juryVersion, model }))) cachedCalls++; else pending.push({ item, pass });
    }
  }
  const dayOf = (/** @type {{today?:string}} */ item) => item.today ?? shanghaiDay(now());
  /** @type {Promise<void>} */
  let writing = Promise.resolve();
  const append = (/** @type {any} */ record) => {
    records.push(record);
    if (isAnswer(record)) cache.set(cacheKey(record), record);
    if (cachePath) writing = writing.then(() => appendFile(cachePath, `${JSON.stringify(record)}\n`));
    return writing;
  };
  let costCny = 0, calls = 0, stopped = /** @type {string|null} */ (null);

  for (let start = 0; start < pending.length && !stopped; start += batchSize) {
    if (signal?.aborted) { stopped = 'aborted'; break; }
    const batch = pending.slice(start, start + batchSize).map((call) => ({ ...call,
      messages: frontierJuryMessages(call.item.text, { exemplars: orders[call.pass], today: dayOf(call.item) }) }));
    const upper = batch.map((call) => price({ cacheMiss: call.messages.reduce((sum, message) => sum + message.content.length + 8, 0), output: MAX_OUTPUT_TOKENS }));
    const reserveCny = ceilCny(upper.reduce((sum, value) => sum + value, 0));
    const base = `${stagePrefix}:${sha(JSON.stringify([batch.map((call) => [call.item.id, call.pass]), juryVersion, model, reserveCny])).slice(0, 16)}`;
    let stageKey = base, begun = false;
    for (let attempt = 0; !begun && !stopped; attempt++) {
      if (attempt >= MAX_STAGE_KEYS) { stopped = 'campaign_budget_stage_keys_exhausted'; break; }
      stageKey = attempt ? `${base}:a${attempt}` : base;
      const grant = await budget.reserve({ campaignId, stageKey, amountCny: reserveCny }).catch((/** @type {any} */ error) => {
        if (error?.code === 'campaign_budget_idempotency_conflict') return { authorized: false, reason: error.code };
        throw error;
      });
      if (!grant?.authorized) {
        // A held record from an interrupted run keeps its reservation against the ceiling, which still stops this run; the key is simply not free.
        if (STAGE_KEY_TAKEN.has(grant?.reason)) continue;
        stopped = grant?.reason ?? 'campaign_budget_refused'; break;
      }
      const spend = await budget.beginSpend({ campaignId, stageKey });
      if (!spend?.authorized) {
        // No call will be made under this hold: released, or it would stand against the ceiling for the rest of the month.
        await budget.settle({ campaignId, stageKey, outcome: 'failed', actualCny: 0 });
        stopped = spend?.reason ?? 'campaign_budget_refused'; break;
      }
      begun = true;
    }
    if (!begun) break;

    const outcomes = await runLimited(batch.map((call, at) => ({ call, ceiling: upper[at] })), concurrency, async ({ call, ceiling }) => {
      if (signal?.aborted) return { skipped: true, cost: 0 };
      /** @type {JuryReply} */
      let reply;
      try { reply = await callModel(call.messages, { signal }); } catch (error) {
        const failure = /** @type {any} */ (error), cost = ceiling * (failure?.possiblyBilled ?? 1);
        // The content inspection's answer about this text, not an outage: it will say the same next month, so the pass is kept as an abstention instead of
        // failing the item on every rerun and holding the unattended month back. A day short of labels is simply not measured.
        if (failure?.code === 'jury_content_refused') {
          await append({ id: call.item.id, pass: call.pass, worth: null, why: '', basis: 'jury-refused', juryVersion, model, campaignId, usage: null, costCny: cost, requestId: null, finishReason: null, today: dayOf(call.item) });
          return { cost };
        }
        if (cost > 0) await append({ id: call.item.id, pass: null, unanswered: call.pass, failure: failure instanceof JuryError ? failure.code : 'jury_call_failed', juryVersion, model, campaignId, costCny: cost, today: dayOf(call.item) });
        return { failed: true, cost };
      }
      const answer = parseJuryAnswer(reply?.text);
      const usage = reply?.usage && Object.values(reply.usage).every((value) => Number.isFinite(value) && value >= 0) ? reply.usage : null;
      const cost = (usage ? price(usage) : ceiling) + ceiling * (reply?.possiblyBilled ?? 0);
      await append({ id: call.item.id, pass: call.pass, worth: answer?.worth ?? null, why: answer?.why ?? '', juryVersion, model, campaignId, usage, costCny: cost,
        requestId: reply?.requestId ?? null, finishReason: reply?.finishReason ?? null, today: dayOf(call.item) });
      return { cost };
    });
    await writing;
    const executed = outcomes.filter((outcome) => !outcome.skipped), failed = outcomes.filter((outcome) => outcome.failed);
    const spent = roundCny(outcomes.reduce((sum, outcome) => sum + outcome.cost, 0));
    await budget.settle({ campaignId, stageKey, outcome: failed.length || executed.length < outcomes.length ? 'failed' : 'success', actualCny: spent });
    costCny = roundCny(costCny + spent); calls += executed.length;
    if (executed.length < outcomes.length) stopped = 'aborted';
    else if (failed.length && failed.length * 2 >= executed.length) stopped = 'jury_unavailable';
  }

  /** @type {any[]} */
  const labels = [];
  let incomplete = 0;
  for (const item of unique) {
    const passes = ['A', 'B'].map((pass) => cache.get(cacheKey({ id: item.id, pass, juryVersion, model })));
    if (passes.some((record) => !record)) { incomplete++; continue; }
    const [a, b] = passes, invalid = !a.worth || !b.worth, refused = a.basis === 'jury-refused' || b.basis === 'jury-refused';
    labels.push({ id: item.id, worth: invalid || a.worth !== b.worth ? null : a.worth, basis: refused ? 'jury-refused' : invalid ? 'jury-invalid' : a.worth === b.worth ? 'jury-agree' : 'jury-disagree',
      passes: passes.map((record) => ({ pass: record.pass, worth: record.worth, why: record.why })) });
  }
  const paidFor = new Set(unique.map((item) => item.id));
  const campaignCostCny = roundCny(records.reduce((sum, record) => sum + (record.campaignId === campaignId && paidFor.has(record.id) && Number.isFinite(record.costCny) ? record.costCny : 0), 0));
  return { labels, costCny, campaignCostCny, calls, cachedCalls, incomplete, stopped };
}

/** @param {number} numerator @param {number} denominator */
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);

/**
 * The jury against the human anchor, on the even-`n` rows only. Abstentions are counted and left out of the agreement figures;
 * a calibration row the jury never labelled is `unlabelled`.
 * @param {{gold:any[], labels:{id:string, worth:string|null}[]}} input
 */
export function calibrateJury({ gold, labels }) {
  const byId = new Map(labels.map((label) => [label.id, label.worth]));
  const rows = gold.filter((row) => row.n % 2 === 0);
  const confusion = Object.fromEntries(FRONTIER_WORTH.map((truth) => [truth, Object.fromEntries(FRONTIER_WORTH.map((jury) => [jury, 0]))]));
  const abstained = { pick: 0, ok: 0, no: 0 };
  let labelled = 0, scored = 0;
  for (const row of rows) {
    if (!byId.has(row.id)) continue;
    labelled++;
    const jury = byId.get(row.id), truth = row.label.worth;
    if (jury == null) { abstained[/** @type {'pick'|'ok'|'no'} */ (truth)]++; continue; }
    scored++; confusion[truth][jury]++;
  }
  const tp = confusion.pick.pick, fn = confusion.pick.ok + confusion.pick.no, fp = confusion.ok.pick + confusion.no.pick, tn = scored - tp - fn - fp;
  const po = ratio(tp + tn, scored);
  const pe = scored ? ((tp + fn) * (tp + fp) + (fp + tn) * (fn + tn)) / (scored * scored) : null;
  const kappa = po === null || pe === null || pe === 1 ? null : (po - pe) / (1 - pe);
  const goldPicks = rows.filter((row) => row.label.worth === 'pick' && byId.has(row.id)).length;
  return {
    calibrationRows: rows.length, labelled, unlabelled: rows.length - labelled, scored, abstained: labelled - scored, abstainedByGold: abstained,
    abstentionRate: ratio(labelled - scored, labelled), confusion, pickKappa: kappa, pickPrecision: ratio(tp, tp + fp), pickRecall: ratio(tp, tp + fn),
    pickRecallWithAbstentions: ratio(tp, goldPicks), accuracy: ratio(confusion.pick.pick + confusion.ok.ok + confusion.no.no, scored),
  };
}

/** @param {ReturnType<typeof calibrateJury>} calibration @param {{minKappa?:number, maxAbstention?:number, minPickPrecision?:number, minCoverage?:number}} [thresholds]
 * @returns {{qualified:boolean, reasons:string[]}} */
export function juryQualified(calibration, { minKappa = 0.4, maxAbstention = 0.35, minPickPrecision = 0.5, minCoverage = 0.9 } = {}) {
  /** @type {string[]} */
  const reasons = [];
  if (!calibration.calibrationRows || calibration.labelled / calibration.calibrationRows < minCoverage) reasons.push('calibration_incomplete');
  if (calibration.pickKappa === null) reasons.push('kappa_unavailable'); else if (calibration.pickKappa < minKappa) reasons.push('kappa_below_minimum');
  if (calibration.abstentionRate === null || calibration.abstentionRate > maxAbstention) reasons.push('abstention_above_maximum');
  if (calibration.pickPrecision === null) reasons.push('pick_precision_unavailable'); else if (calibration.pickPrecision < minPickPrecision) reasons.push('pick_precision_below_minimum');
  return { qualified: reasons.length === 0, reasons };
}

// --- command line -----------------------------------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const args = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at]?.startsWith('--') || argv[at + 1] === undefined) throw new Error('usage_invalid');
    args[argv[at].slice(2)] = argv[at + 1];
  }
  return args;
}
/** @param {Record<string,string>} args @param {string[]} names */
function required(args, names) { for (const name of names) if (!args[name]) throw new Error(`usage_missing_${name}`); }

/** @param {string} path */
async function readJsonMaybeGzip(path) {
  const bytes = await readFile(path);
  return { value: JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8')), sha256: sha(bytes) };
}
/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

/** The calibration set as items: even-`n` anchor rows, each judged on the day it was published. @param {any[]} gold */
export function calibrationItems(gold) {
  return gold.filter((row) => row.n % 2 === 0).map((row) => ({ id: row.id, text: goldItemText(row), today: row.published ?? undefined }));
}

/** The lab's labelled set from an export (`texts`, `days`) and an id list; an id with no text is counted as missing. An item is judged on
 * the feed day it first appeared, else on its publication day, else on the run's clock.
 * @param {{exportPath:string, ids:string[]}} input
 * @returns {Promise<{items:{id:string, text:FrontierItemText, today?:string}[], missing:number, exportSha256:string}>} */
export async function loadLabelItems({ exportPath, ids }) {
  const { value: exported, sha256: exportSha256 } = await readJsonMaybeGzip(exportPath);
  if (!Array.isArray(ids) || !exported?.texts || typeof exported.texts !== 'object') throw new Error('input_invalid');
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const day of exported.days ?? []) for (const row of day.rows ?? []) if (!seen.has(String(row.id))) seen.set(String(row.id), day.day);
  /** @type {{id:string, text:FrontierItemText, today?:string}[]} */
  const items = [];
  let missing = 0;
  for (const id of ids.map(String)) {
    const text = exported.texts[id];
    if (!text) { missing++; continue; }
    items.push({ id, text, today: seen.get(id) ?? (Number.isFinite(Date.parse(text.published_at)) ? shanghaiDay(text.published_at) : undefined) });
  }
  return { items, missing, exportSha256 };
}

/**
 * One phase of a month: the ids the plan fixed for it, with the source text the jury may read. It names the export it came from, which must be
 * the plan's, so labels made from it cannot be applied to another.
 * @param {{exportPath:string, plan:any, phase:string}} input
 */
export async function phaseItems({ exportPath, plan, phase }) {
  const ids = plan?.idsByRole?.[phase];
  if (!FRONTIER_LABEL_PHASES.includes(phase) || !Array.isArray(ids)) throw new Error('usage_phase');
  const { items, missing, exportSha256 } = await loadLabelItems({ exportPath, ids });
  if (exportSha256 !== plan.exportSha256) throw new Error('campaign_export_changed');
  return { month: plan.month, idPrefix: plan.idPrefix ?? '', phase, exportSha256, items, missing };
}

/** The lab's budget ledger, over its own database. @param {string} configPath */
async function openLabBudget(configPath) {
  const url = process.env.RSI_LAB_DATABASE_URL;
  if (!url) throw new Error('lab_database_url_missing');
  const configuration = JSON.parse(await readFile(configPath, 'utf8'));
  const { ControlPlaneDatabase } = await import('../../apps/server/src/controlPlaneDatabase.mjs');
  const { RsiCampaignBudget } = await import('../../apps/server/src/rsiCampaignBudget.mjs');
  const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5000 });
  return { budget: new RsiCampaignBudget({ database, configuration }), close: () => database.close(), model: configuration.providers?.qwenMax?.model ?? FRONTIER_JURY_MODEL };
}

/**
 * The command line. `deps` are the two seams a test stands in for: the budget ledger (the lab's database) and the transport.
 * A run that stopped (budget, quota, an unavailable provider) or left an item without both passes exits 2 with its file written; the
 * cache holds every answer, so the same command asks only for what is missing.
 * @param {string[]} argv @param {{openBudget?:typeof openLabBudget, fetchImpl?:typeof fetch}} [deps]
 */
export async function main(argv, { openBudget = openLabBudget, fetchImpl = globalThis.fetch } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'calibrate' && command !== 'label') throw new Error('usage_command');
  const args = parseArgs(rest);
  required(args, ['credential', 'out', 'cache', 'campaign', 'config']);
  const gold = await loadGoldRows(args.gold ?? new URL('../frontier-selection/gold.jsonl', import.meta.url).pathname);
  const exemplars = selectFrontierExemplars(gold);
  /** @type {{id:string, text:FrontierItemText, today?:string}[]} */
  let items;
  let missing = 0;
  /** @type {Record<string, unknown>} */
  let bound = {};
  if (command === 'calibrate') items = calibrationItems(gold);
  else {
    required(args, ['export', 'plan', 'phase']);
    const phase = await phaseItems({ exportPath: args.export, plan: JSON.parse(await readFile(args.plan, 'utf8')), phase: args.phase });
    items = phase.items; missing = phase.missing;
    bound = { phase: phase.phase, month: phase.month, idPrefix: phase.idPrefix, exportSha256: phase.exportSha256 };
  }

  const lab = await openBudget(args.config);
  try {
    const result = await labelFrontierItems({ items, exemplars, callModel: dashscopeCaller({ credentialPath: args.credential, model: lab.model, fetchImpl }),
      budget: lab.budget, campaignId: args.campaign, cachePath: args.cache, model: lab.model });
    const labelCounts = { pick: 0, ok: 0, no: 0, abstained: 0, refused: 0 };
    for (const label of result.labels) labelCounts[label.basis === 'jury-refused' ? 'refused' : label.worth ?? 'abstained']++;
    const summary = { command, ...bound, juryVersion: frontierJuryVersion(exemplars), provider: FRONTIER_JURY_PROVIDER, model: lab.model, promptDigest: frontierJuryPromptDigest(), items: items.length, missing,
      labelled: result.labels.length, incomplete: result.incomplete, labelCounts, calls: result.calls, cachedCalls: result.cachedCalls, costCny: result.campaignCostCny, stopped: result.stopped, out: args.out };
    if (command === 'calibrate') {
      const calibration = calibrateJury({ gold, labels: result.labels });
      const qualification = juryQualified(calibration);
      await writeJson(args.out, { schema: FRONTIER_CALIBRATION_SCHEMA, ...summary, calibration, qualification, labels: result.labels });
      console.log(JSON.stringify({ ...summary, qualified: qualification.qualified, reasons: qualification.reasons, pickKappa: calibration.pickKappa, abstentionRate: calibration.abstentionRate, pickPrecision: calibration.pickPrecision }));
    } else {
      await writeJson(args.out, { schema: FRONTIER_LABELS_SCHEMA, ...summary, labels: result.labels });
      console.log(JSON.stringify(summary));
    }
    if (result.stopped || result.incomplete) process.exitCode = 2;
  } finally { await lab.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ error: error?.code ?? error?.message ?? 'jury_cli_failed' }));
    process.exitCode = 1;
  });
}
