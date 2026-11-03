/**
 * The frontier jury (2026-10-26; Claude since 2026-11-03): a Claude model, an adjudicator the owner admits offline, labels
 * frontier-feed items `pick` (belongs in the daily featured selection), `ok` (relevant, not featured) or `no` (not worth showing)
 * with no human labelling. Two independent passes per item, differing only in the order of the worked examples; agreement stands as
 * the label, disagreement abstains (`worth: null`). Before its labels are used the jury is calibrated against the
 * human-adjudicated anchor (`evals/frontier-selection/gold.jsonl`): odd `n` rows are the exemplar pool, even `n` rows the
 * calibration set and never appear in a prompt as an exemplar.
 *
 * The jury reads only the source's own text (title, source, journal, publication types, date, language, abstract or page
 * excerpt). Every field the platform's own models wrote (`title_zh`, `summary_zh`, scores, genre, evidence type) is dropped
 * before a prompt is built, so a label never inherits the screener's reading.
 *
 * Where it runs: on the operator's box, never on the lab host (the lab has no Anthropic access). A call is the box's `claude` CLI
 * under the operator's subscription, so it spends no lab cash: no reservation, no price, every record says `costCny: 0` with the
 * basis `subscription` and the tokens the CLI reported. Every answer is appended to a JSONL cache the moment it arrives, so an
 * interrupted run (a spent usage window above all) resumes without asking twice.
 *
 *   lab:       node frontier_labels.mjs items --export export.json[.gz] --plan plan.json --phase development|confirmation --out label-items.json
 *   operator:  node frontier_labels.mjs calibrate --out calibration.json --cache cache.jsonl [--gold gold.jsonl] [--model claude-sonnet-5-5] [--effort medium]
 *              node frontier_labels.mjs label --items label-items.json --out labels.json --cache cache.jsonl [--model ...] [--effort ...]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { RSI_OFFLINE_ROLE_MODEL } from '../../packages/domain/src/rsiCampaign.mjs';

/** Bump on any change to the rubric's meaning; the prompt digest covers its bytes. */
export const FRONTIER_JURY_VERSION = 'frontier-jury-v2';
/** The measured default (2026-11-03, `calibrate` in safe mode on the 124 calibration rows, two passes): sonnet at medium effort, κ 0.656, precision 0.75, recall 0.667
 *  on rubric v2 (v1: 0.621 / 0.833 / 0.556; v1 at high effort 0.523, opus medium 0.349). */
export const FRONTIER_JURY_MODEL = 'claude-sonnet-5-5';
export const FRONTIER_JURY_EFFORT = 'medium';
export const FRONTIER_JURY_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const FRONTIER_WORTH = Object.freeze(['pick', 'ok', 'no']);
export const FRONTIER_LABEL_ITEMS_SCHEMA = 'rsi-frontier-label-items-v1';
export const FRONTIER_LABELS_SCHEMA = 'rsi-frontier-jury-labels-v1';
export const FRONTIER_CALIBRATION_SCHEMA = 'rsi-frontier-jury-calibration-v1';
/** A call is the operator's subscription: it is not priced, not reserved, and every record says so. */
export const FRONTIER_JURY_COST_BASIS = 'subscription';
const MAX_EXCERPT = 1200;
const MAX_CLI_OUTPUT = 4_000_000;
/** The label phases of a month: development decides whether confirmation is labelled at all. */
export const FRONTIER_LABEL_PHASES = Object.freeze(['development', 'confirmation']);

/** @typedef {{title_raw?:string|null, source_name?:string|null, source_type?:string|null, journal?:string|null, publication_types?:string[]|null, published_at?:string|null, date_precision?:string|null, lang?:string|null, excerpt?:string|null}} FrontierItemText */
/** @typedef {{n?:number, id?:string, text:FrontierItemText, worth:'pick'|'ok'|'no', why:string}} FrontierExemplar */
/** @typedef {{role:'system'|'user', content:string}} JuryMessage */
/** @typedef {{cacheHit:number, cacheMiss:number, output:number}} JuryUsage */
/** @typedef {{text:string, usage:JuryUsage|null, requestId:string|null, finishReason:string|null}} JuryReply */
/** @typedef {(messages:JuryMessage[], options?:{signal?:AbortSignal}) => Promise<JuryReply>} JuryCaller */

const EXEMPLAR_EXCERPT = 500;
const RUBRIC = `你是「循证医学前沿动态」的内容审核员。You are a reviewer for a medical frontier feed.

读者 / Reader
读者是临床医生或医学研究者，每天只花几分钟浏览。判断标准只有一个：这位读者今天是否应该看到这条内容。
The reader is a clinician or medical researcher who scans the feed for a few minutes a day. The only question is whether such a reader should see this item today.

任务 / Task
只根据给出的来源文本（标题、来源、期刊、文献类型、日期、正文摘录）给这条内容打标签。不要补充文本里没有的事实：不要凭记忆写结果、数字、批准情况或样本量。新闻稿、媒体报道和社交帖子标题听起来重要、但正文里看不到结果时，不能给 pick。
Judge only from the source text you are given. Do not assume facts it does not state: no results, numbers, approvals or sample sizes from memory. A press release, news story or social post with an important-sounding title and no visible result is not a pick.

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
2. 实践意义比刊物名气重要：刊物名望本身不使一项窄研究成为 pick。Practical weight outranks venue prestige.
3. 给出了「今天」的日期。按该日期看明显过时、文本里又没有新内容的条目不是新闻。An item that is old by the given date and shows nothing new is not news.
4. 语言和来源类型不决定标签，内容决定：外文或非期刊来源也可能是 pick，期刊论文也可能是 ok 或 no。Content decides, not language or source type.
5. 正文摘录最多只有 1200 个字符，论文摘要的结果部分常常被截掉。期刊论文或注册研究的摘录没显示结果时，不要只因此判 ok：按研究设计、规模、期刊和题目写明的终点判断，但不要编造结果。The excerpt is cut at 1200 characters, so a journal abstract often loses its results. Do not mark a journal paper or registered trial down for that alone: judge its design, size, venue and the endpoint its title names, without inventing results.
6. 监管决定按决定本身判断：批准（包括新适应症的效力补充申请、创新器械、国内首个）、撤市和说明书安全性修订是 pick，即使只涉及一款产品或正文为空。只影响个别批次或延续已有召回的跟进通知、没有临床后果的消费品召回是 ok。Judge a regulatory decision by the decision: approvals (efficacy supplements for a new indication, innovative devices, national firsts), withdrawals and safety label revisions are picks even for one product or with no text; follow-ups limited to some lots or an existing recall, and consumer recalls with no clinical consequence, are ok.
7. 正文为空且不是监管决定时只能依据标题和来源，结果通常是 ok 或 no，很少是 pick。With no text and no regulatory decision, judge from title and source; rarely a pick.

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

/** A closed-code failure: never carries the CLI's text (a vendor message can echo anything). `retryable` is true for a transport hiccup or
 * a timeout; a spent usage window (`jury_quota`) or a refused login (`jury_auth`) is not retried and stops the run. */
export class JuryError extends Error {
  /** @param {string} code @param {{retryable?:boolean}} [options] */
  constructor(code, { retryable = false } = {}) {
    super(code); this.name = 'JuryError'; this.code = code; this.retryable = retryable;
  }
}
/** What stops a run at once: nothing a retry would change. */
const HALTING_CODES = new Set(['jury_quota', 'jury_auth', 'jury_cli_unavailable']);

// Variables a parent shell may carry that would change which account, endpoint or session the CLI uses (the improver channels scrub the same
// list, evals/harness-adaptation/evimed_h2/channels.py), and the keys of the platform's own model providers, which the jury must never see.
const SCRUB_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_', 'CLAUDE_CONFIG', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'AWS_BEARER', 'GOOGLE_CLOUD_', 'VERTEX', 'DEEPSEEK_', 'DASHSCOPE_'];
const SCRUB_EXACT = new Set(['CLAUDECODE', 'AI_AGENT', 'CLOUD_ML_REGION']);
const QUOTA_TEXT = /usage limit|rate limit|limit reached|quota|credit balance|too many requests|resets? at/i;
const AUTH_TEXT = /invalid api key|please run \/login|not logged in|unauthori[sz]ed|authentication|oauth/i;

/** The CLI's environment: the parent's, without anything that would point it at another account, endpoint or provider.
 * @param {Record<string, string|undefined>} parent @returns {Record<string, string>} */
export function claudeCliEnvironment(parent) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(parent)) if (typeof value === 'string' && !SCRUB_EXACT.has(key) && !SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  return env;
}

/** @param {any} payload @param {string} text @returns {JuryError} */
function cliFailure(payload, text) {
  const status = Number(payload?.api_error_status);
  if (status === 429 || QUOTA_TEXT.test(text)) return new JuryError('jury_quota');
  if (status === 401 || status === 403 || AUTH_TEXT.test(text)) return new JuryError('jury_auth');
  if (status >= 500 || /overloaded/i.test(text)) return new JuryError('jury_transport', { retryable: true });
  // A CLI that failed without a JSON result never reached the model (a dropped connection, a crash); one that said it failed is an error of its own.
  return new JuryError(payload ? 'jury_cli_error' : 'jury_transport', { retryable: true });
}

/**
 * The jury's caller: the operator box's `claude` CLI, one print-mode call per message pair, no tools and no session. The system message goes
 * to a temporary file (`--system-prompt-file`), the user message to stdin; the answer is the JSON result's text and its `usage` is mapped
 * to the cache-aware token counts. The model must be a pinned `claude-*` id. Nothing the CLI prints reaches an error.
 * @param {{model?:string, effort?:string, cli?:string, cliArgs?:string[], timeoutMs?:number, retries?:number, env?:Record<string, string|undefined>, scratchRoot?:string,
 *   spawnImpl?:typeof spawn, sleep?:(ms:number)=>Promise<void>}} [options]
 * @returns {JuryCaller & {close:()=>Promise<void>}} */
export function claudeCliCaller({ model = FRONTIER_JURY_MODEL, effort = FRONTIER_JURY_EFFORT, cli = 'claude', cliArgs = [], timeoutMs = 180_000, retries = 2,
  env = process.env, scratchRoot = tmpdir(), spawnImpl = spawn, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!RSI_OFFLINE_ROLE_MODEL.test(model) || !FRONTIER_JURY_EFFORTS.includes(effort)) throw new JuryError('jury_model_invalid');
  const childEnv = claudeCliEnvironment(env);
  /** @type {Promise<string>|null} */
  let scratch = null;
  let counter = 0;
  // The CLI runs in an empty directory of its own: no project file of the operator's checkout is its working context.
  const scratchDir = () => (scratch ??= mkdtemp(join(scratchRoot, 'frontier-jury-')));
  /** @param {string} systemFile @param {string} user @param {AbortSignal|undefined} signal @returns {Promise<JuryReply>} */
  const once = async (systemFile, user, signal) => {
    const cwd = await scratchDir();
    const argv = [...cliArgs, '-p', '--safe-mode', '--model', model, '--effort', effort, '--output-format', 'json', '--system-prompt-file', systemFile, '--tools', '', '--no-session-persistence'];
    const { code, stdout, failure } = await new Promise((resolve) => {
      let out = '', overflow = false, settled = false;
      /** @type {import('node:child_process').ChildProcess} */
      let child;
      const finish = (/** @type {any} */ value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); };
      const stop = () => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } };
      const onAbort = () => { stop(); finish({ failure: new JuryError('jury_aborted') }); };
      const timer = setTimeout(() => { stop(); finish({ failure: new JuryError('jury_timeout', { retryable: true }) }); }, timeoutMs);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      try { child = spawnImpl(cli, argv, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { finish({ failure: new JuryError('jury_cli_unavailable') }); return; }
      child.on('error', () => finish({ failure: new JuryError('jury_cli_unavailable') }));
      child.stdout?.on('data', (/** @type {Buffer} */ chunk) => { if (out.length < MAX_CLI_OUTPUT) out += chunk; else overflow = true; });
      child.on('close', (exitCode) => finish(overflow ? { failure: new JuryError('jury_bad_response') } : { code: exitCode, stdout: out }));
      child.stdin?.on('error', () => {});
      child.stdin?.end(user);
    });
    if (failure) throw failure;
    /** @type {any} */
    let payload = null;
    try { payload = JSON.parse(stdout); } catch { /* a plain-text failure is classified below */ }
    const text = typeof payload?.result === 'string' ? payload.result : String(stdout ?? '').slice(0, 2000);
    if (payload?.is_error === true || (typeof payload?.subtype === 'string' && payload.subtype !== 'success')) throw cliFailure(payload, text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw code === 0 ? new JuryError('jury_bad_response') : cliFailure(null, text);
    if (code !== 0 && !text.trim()) throw new JuryError('jury_transport', { retryable: true });
    if (!text.trim()) throw new JuryError('jury_bad_response');
    const u = payload.usage, count = (/** @type {unknown} */ value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
    const input = count(u?.input_tokens), output = count(u?.output_tokens);
    return {
      text, usage: input !== null && output !== null ? { cacheHit: count(u.cache_read_input_tokens) ?? 0, cacheMiss: input + (count(u.cache_creation_input_tokens) ?? 0), output } : null,
      requestId: typeof payload.session_id === 'string' ? payload.session_id : null, finishReason: typeof payload.stop_reason === 'string' ? payload.stop_reason : (payload.subtype ?? null),
    };
  };
  /** @type {JuryCaller & {close:()=>Promise<void>}} */
  const call = async (messages, { signal } = {}) => {
    const system = messages.find((message) => message.role === 'system'), user = messages.find((message) => message.role === 'user');
    if (!system || !user) throw new JuryError('jury_messages_invalid');
    const file = join(await scratchDir(), `system-${++counter}.txt`);
    await writeFile(file, system.content, { mode: 0o600 });
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await once(file, user.content, signal); } catch (error) {
          if (!(error instanceof JuryError) || !error.retryable || attempt >= retries) throw error;
          await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
        }
      }
    } finally { await rm(file, { force: true }); }
  };
  call.close = async () => { if (scratch) await rm(await scratch, { recursive: true, force: true }); scratch = null; };
  return call;
}

/** @param {string} cachePath @returns {Promise<Map<string, any>>} */
async function readCache(cachePath) {
  /** @type {Map<string, any>} */
  const cache = new Map();
  let text = '';
  try { text = await readFile(cachePath, 'utf8'); } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error; }
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record.id === 'string' && (record.pass === 'A' || record.pass === 'B') && typeof record.juryVersion === 'string' && typeof record.model === 'string' && typeof record.effort === 'string') cache.set(cacheKey(record), record);
  }
  return cache;
}
/** The model and its effort are both part of what answered: another effort is another jury. */
const cacheKey = (/** @type {any} */ { id, pass, juryVersion, model, effort }) => JSON.stringify([id, pass, juryVersion, model, effort]);

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
 * Label items with two passes each. The first pass reads the exemplars in their order, the second in reverse. A batch of calls runs with
 * bounded concurrency and every answer is cached as it arrives. A spent usage window or a refused login stops the run at once (what was
 * answered stays cached); a batch in which half the calls failed stops it as `jury_unavailable`. Nothing is priced or reserved: the model
 * is a subscription Claude, so `costCny` is 0 with its basis, and the tokens the CLI reported are summed.
 * @param {{items:{id:string, text:FrontierItemText, today?:string|null}[], exemplars:FrontierExemplar[], callModel:JuryCaller, now?:()=>string,
 *   concurrency?:number, batchSize?:number, cachePath?:string, signal?:AbortSignal, model?:string, effort?:string}} options
 * @returns {Promise<{labels:{id:string, worth:'pick'|'ok'|'no'|null, basis:'jury-agree'|'jury-disagree'|'jury-invalid', passes:{pass:string, worth:string|null, why:string}[]}[],
 *   tokens:JuryUsage, costCny:0, costBasis:'subscription', calls:number, cachedCalls:number, incomplete:number, stopped:string|null}>}
 */
export async function labelFrontierItems({ items, exemplars, callModel, now = () => new Date().toISOString(), concurrency = 3, batchSize = 40, cachePath, signal,
  model = FRONTIER_JURY_MODEL, effort = FRONTIER_JURY_EFFORT }) {
  if (typeof callModel !== 'function') throw new Error('jury_unconfigured');
  if (!RSI_OFFLINE_ROLE_MODEL.test(model) || !FRONTIER_JURY_EFFORTS.includes(effort)) throw new Error('jury_model_invalid');
  const juryVersion = frontierJuryVersion(exemplars);
  const orders = { A: exemplars, B: [...exemplars].reverse() };
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const cache = cachePath ? await readCache(cachePath) : new Map();
  if (cachePath) await mkdir(dirname(cachePath), { recursive: true });
  const pending = [];
  let cachedCalls = 0;
  for (const item of unique) {
    for (const pass of /** @type {('A'|'B')[]} */ (['A', 'B'])) {
      if (cache.has(cacheKey({ id: item.id, pass, juryVersion, model, effort }))) cachedCalls++; else pending.push({ item, pass });
    }
  }
  const dayOf = (/** @type {{today?:string|null}} */ item) => item.today ?? shanghaiDay(now());
  /** @type {Promise<void>} */
  let writing = Promise.resolve();
  const append = (/** @type {any} */ record) => {
    cache.set(cacheKey(record), record);
    if (cachePath) writing = writing.then(() => appendFile(cachePath, `${JSON.stringify(record)}\n`));
    return writing;
  };
  const tokens = { cacheHit: 0, cacheMiss: 0, output: 0 };
  let calls = 0, stopped = /** @type {string|null} */ (null), halted = /** @type {string|null} */ (null);

  for (let start = 0; start < pending.length && !stopped; start += batchSize) {
    if (signal?.aborted) { stopped = 'aborted'; break; }
    const batch = pending.slice(start, start + batchSize).map((call) => ({ ...call,
      messages: frontierJuryMessages(call.item.text, { exemplars: orders[call.pass], today: dayOf(call.item) }) }));
    const outcomes = await runLimited(batch, concurrency, async (call) => {
      if (halted || signal?.aborted) return { skipped: true };
      /** @type {JuryReply} */
      let reply;
      try { reply = await callModel(call.messages, { signal }); } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (HALTING_CODES.has(code)) halted ??= code;
        return { failed: true };
      }
      const answer = parseJuryAnswer(reply?.text);
      const usage = reply?.usage && Object.values(reply.usage).every((value) => Number.isFinite(value) && value >= 0) ? reply.usage : null;
      if (usage) { tokens.cacheHit += usage.cacheHit; tokens.cacheMiss += usage.cacheMiss; tokens.output += usage.output; }
      await append({ id: call.item.id, pass: call.pass, worth: answer?.worth ?? null, why: answer?.why ?? '', juryVersion, model, effort, usage,
        costCny: 0, costBasis: FRONTIER_JURY_COST_BASIS, requestId: reply?.requestId ?? null, finishReason: reply?.finishReason ?? null, today: dayOf(call.item) });
      return {};
    });
    await writing;
    const executed = outcomes.filter((outcome) => !outcome.skipped), failed = outcomes.filter((outcome) => outcome.failed);
    calls += executed.length;
    if (halted) stopped = halted;
    else if (executed.length < outcomes.length) stopped = 'aborted';
    else if (failed.length && failed.length * 2 >= executed.length) stopped = 'jury_unavailable';
  }

  /** @type {any[]} */
  const labels = [];
  let incomplete = 0;
  for (const item of unique) {
    const passes = ['A', 'B'].map((pass) => cache.get(cacheKey({ id: item.id, pass, juryVersion, model, effort })));
    if (passes.some((record) => !record)) { incomplete++; continue; }
    const [a, b] = passes, invalid = !a.worth || !b.worth;
    labels.push({ id: item.id, worth: invalid || a.worth !== b.worth ? null : a.worth, basis: invalid ? 'jury-invalid' : a.worth === b.worth ? 'jury-agree' : 'jury-disagree',
      passes: passes.map((record) => ({ pass: record.pass, worth: record.worth, why: record.why })) });
  }
  return { labels, tokens, costCny: 0, costBasis: FRONTIER_JURY_COST_BASIS, calls, cachedCalls, incomplete, stopped };
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

// --- the files a label flow moves -----------------------------------------------------------------------------------------

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

/** The only fields of a source's text a labeller is ever sent: the export keeps the source's own text under these names, and whatever
 * else a row might carry stays behind. @param {any} text @returns {FrontierItemText} */
export function labelItemText(text) {
  const t = text && typeof text === 'object' ? text : {};
  return { title_raw: t.title_raw ?? null, source_name: t.source_name ?? null, source_type: t.source_type ?? null, journal: t.journal ?? null,
    publication_types: Array.isArray(t.publication_types) ? t.publication_types : [], published_at: t.published_at ?? null, date_precision: t.date_precision ?? null,
    lang: t.lang ?? null, excerpt: t.excerpt ?? null };
}

/** The lab's labelled set from an export (`texts`, `days`) and an id list (`ids`, or a JSON file of them); an id with no text is counted as missing. An item
 * is judged on the feed day it first appeared, else on its publication day, else on the run's clock.
 * @param {{exportPath:string, idsPath?:string, ids?:string[]}} input
 * @returns {Promise<{items:{id:string, text:FrontierItemText, today?:string}[], missing:number, exportSha256:string}>} */
export async function loadLabelItems({ exportPath, idsPath, ids: given }) {
  const { value: exported, sha256: exportSha256 } = await readJsonMaybeGzip(exportPath);
  const ids = given ?? JSON.parse(await readFile(/** @type {string} */ (idsPath), 'utf8'));
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
    items.push({ id, text: labelItemText(text), today: seen.get(id) ?? (Number.isFinite(Date.parse(text.published_at)) ? shanghaiDay(text.published_at) : undefined) });
  }
  return { items, missing, exportSha256 };
}

/**
 * The file the lab hands the operator for one phase of a month: the ids the plan fixed for it and the source text the jury may read, nothing
 * the platform's models wrote. It names the export it came from, so labels made from it cannot be applied to another.
 * @param {{exportPath:string, plan:any, phase:string}} input
 */
export async function buildLabelItemsFile({ exportPath, plan, phase }) {
  const ids = plan?.idsByRole?.[phase];
  if (!FRONTIER_LABEL_PHASES.includes(phase) || !Array.isArray(ids)) throw new Error('usage_phase');
  const { items, missing, exportSha256 } = await loadLabelItems({ exportPath, ids });
  if (exportSha256 !== plan.exportSha256) throw new Error('campaign_export_changed');
  return { schema: FRONTIER_LABEL_ITEMS_SCHEMA, month: plan.month, idPrefix: plan.idPrefix ?? '', phase, exportSha256,
    items: items.map((item) => ({ id: item.id, text: item.text, today: item.today ?? null })), missing };
}

/** @param {string} path */
async function readLabelItemsFile(path) {
  const file = JSON.parse(await readFile(path, 'utf8'));
  if (file?.schema !== FRONTIER_LABEL_ITEMS_SCHEMA || !FRONTIER_LABEL_PHASES.includes(file.phase) || !/^[a-f0-9]{64}$/.test(file.exportSha256 ?? '') || !Array.isArray(file.items)
    || file.items.some((item) => typeof item?.id !== 'string' || !(item.today === null || /^\d{4}-\d{2}-\d{2}$/.test(item.today)))) throw new Error('label_items_invalid');
  return { ...file, items: file.items.map((item) => ({ id: item.id, text: labelItemText(item.text), today: item.today ?? undefined })) };
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

/** @param {string[]} argv */
export async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === 'items') {
    required(args, ['export', 'plan', 'phase', 'out']);
    const file = await buildLabelItemsFile({ exportPath: args.export, plan: JSON.parse(await readFile(args.plan, 'utf8')), phase: args.phase });
    await writeJson(args.out, file);
    console.log(JSON.stringify({ command, phase: file.phase, month: file.month, items: file.items.length, missing: file.missing, out: args.out }));
    return;
  }
  if (command !== 'calibrate' && command !== 'label') throw new Error('usage_command');
  required(args, ['out', 'cache']);
  const model = args.model ?? FRONTIER_JURY_MODEL, effort = args.effort ?? FRONTIER_JURY_EFFORT, concurrency = args.concurrency ? Number(args.concurrency) : 3;
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8)) throw new Error('usage_invalid');
  const gold = await loadGoldRows(args.gold ?? new URL('../frontier-selection/gold.jsonl', import.meta.url).pathname);
  const exemplars = selectFrontierExemplars(gold);
  /** @type {{id:string, text:FrontierItemText, today?:string}[]} */
  let items;
  let missing = 0;
  /** @type {Record<string, unknown>} */
  let bound = {};
  if (command === 'calibrate') items = calibrationItems(gold);
  else {
    required(args, ['items']);
    const file = await readLabelItemsFile(args.items);
    items = file.items; missing = file.missing ?? 0;
    bound = { phase: file.phase, month: file.month, idPrefix: file.idPrefix, exportSha256: file.exportSha256 };
  }
  const caller = claudeCliCaller({ model, effort, cli: args.cli ?? 'claude' });
  try {
    const result = await labelFrontierItems({ items, exemplars, callModel: caller, cachePath: args.cache, model, effort, concurrency });
    const labelCounts = { pick: 0, ok: 0, no: 0, abstained: 0 };
    for (const label of result.labels) labelCounts[label.worth ?? 'abstained']++;
    const summary = { command, ...bound, juryVersion: frontierJuryVersion(exemplars), model, effort, promptDigest: frontierJuryPromptDigest(), items: items.length, missing, labelled: result.labels.length,
      incomplete: result.incomplete, labelCounts, calls: result.calls, cachedCalls: result.cachedCalls, tokens: result.tokens, costCny: result.costCny, costBasis: result.costBasis,
      stopped: result.stopped, out: args.out };
    if (command === 'calibrate') {
      const calibration = calibrateJury({ gold, labels: result.labels });
      const qualification = juryQualified(calibration);
      await writeJson(args.out, { schema: FRONTIER_CALIBRATION_SCHEMA, ...summary, calibration, qualification, labels: result.labels });
      console.log(JSON.stringify({ ...summary, qualified: qualification.qualified, reasons: qualification.reasons, pickKappa: calibration.pickKappa, abstentionRate: calibration.abstentionRate,
        pickPrecision: calibration.pickPrecision, pickRecall: calibration.pickRecall }));
    } else {
      await writeJson(args.out, { schema: FRONTIER_LABELS_SCHEMA, ...summary, labels: result.labels });
      console.log(JSON.stringify(summary));
    }
    if (result.stopped) process.exitCode = 2;
  } finally { await caller.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ error: error?.code ?? error?.message ?? 'jury_cli_failed' }));
    process.exitCode = 1;
  });
}
