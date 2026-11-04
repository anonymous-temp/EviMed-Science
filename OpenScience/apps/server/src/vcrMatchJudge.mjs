/**
 * Judging patients against trials on the control plane (owner decisions of 2026-11-04): one job, two directions, the model reads and code
 * keeps the books. Direction patient to trial is one person and a list of registry records; direction trial to patient is one protocol
 * version and a roster. The unit of work is a pair.
 *
 * Stage one asks the trial-level question of every pair (`fit`); stage two asks clause by clause for each person's top K by rank (`criteria`).
 * Either is an option of the selection, so a benchmark can ask for each arm. The prompts, the parsers, the verdict and the order are the
 * domain's (`vcrTrialJudgment.mjs`); what is here is the job around them.
 *
 * Hidden knowledge:
 *
 * - **Resume is the ledger, not the job.** A pair judged for these inputs has a `done` row keyed by the words on both sides (by hash), the mode,
 *   the prompt and the settings; a later job, a re-claimed one or a start after a cancel finds it and pays nothing. A failed pair is tried again.
 * - **One pair failing is one row.** Its code is on it and the job goes on. A transient upstream failure is retried at most twice here; a spent
 *   budget, an exhausted balance or a run of upstream failures stops the job, which ends `limited` with the reason, and what was done stands.
 *   A job that finished nothing does not report success.
 * - **Cut-off output is a failed pair, never an empty answer.** Reasoning counts towards `max_tokens`, so the default is generous and a
 *   `finish_reason` of `length` is its own failure code.
 * - **A record over the cap is split at its own boundaries** and judged per part (`splitNoteParts`): whole documents first, blank lines next,
 *   sentences last. The parts' answers are merged by taking the most specific (`mergeFitAnswers`, `mergeCriteriaAnswers`), so a conflict stated
 *   in one part is not averaged away by another that never mentions it. Sentence ids run across the whole record, so evidence resolves wherever
 *   it was found.
 * - **Patient text reaches a model only through the cloud reader**: documents by `runtimeRead`, table cells by `runtimeEvidence`, the same judged
 *   and audited paths a conversation uses. A person whose documents the cloud may not have is one failed pair.
 * - **The estimate is stated before the work, and it is an estimate.** It counts a character as a token and the whole output allowance of every
 *   call, and it assumes a size for a trial not yet fetched. Nothing stops at it: the usage ledger holds the spend, and the result says what was used.
 *
 * @module vcrMatchJudge
 */

import { createHash } from 'node:crypto';
import {
  VCR_ENGINE_PROTOCOL_VERSION, VCR_JUDGMENT_PROMPT_VERSIONS, VCR_MATCH_BATCH_DEFAULT_MODEL, VCR_MATCH_BATCH_METHODS, VCR_MATCH_JUDGE_LIMITS, VCR_TRIAL_VERDICT_LABELS_ZH,
  canonicalScenarioJson, criteriaMessages, criterionDisplay, fitMessages, isPeak, mergeCriteriaAnswers, mergeFitAnswers, parseCriteriaAnswer, parseFitAnswer, priceUsage, rankJudgments,
  segmentCriteria, segmentSentences, splitNoteParts, trialVerdict, vcrResultOutputPayload,
} from '@evimed/domain';
import { HttpError } from './security.mjs';
import { callModelForControlPlane } from './modelGateway.mjs';
import { pool, resultOutcome } from './vcrMatchBatch.mjs';
import { LONG_LIMITS, acceptLongShapes, acceptRelevance, longRelevanceMessages, longShapeMessages } from './vcrLongTables.mjs';
import { REGISTRY_RECORD_BASIS, judgmentKey } from './vcrMatchJudgmentStore.mjs';

const LOCK_HASH = createHash('sha256').update(`evimed-control-plane:matching.judge:${VCR_MATCH_BATCH_METHODS['matching.judge'].version}`).digest('hex');

const object = (/** @type {unknown} */ value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
const sha256 = (/** @type {string} */ text) => createHash('sha256').update(text, 'utf8').digest('hex');
const failure = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const REGISTRIES = Object.freeze(['clinicaltrials.gov', 'chictr', 'ctis']);

/** What stops a job: more of the same call cannot succeed. */
const BUDGET_CODES = Object.freeze(['usage_budget_exceeded', 'insufficient_quota', 'model_gateway_payment_required', 'usage_ledger_unavailable']);
/** What a provider that is down looks like. A long run of these stops the job too, where a retry at the next pair would only pay for waiting. */
const UPSTREAM_CODES = Object.freeze(['model_gateway_upstream_error', 'vcr_match_judge_timeout', 'vcr_match_judge_network']);
const RETRY_BACKOFF_MS = Object.freeze([1_000, 3_000]);
/** A call that may well go through a moment later. A provider's 400 will not, however often it is asked. @param {any} error */
const transientFailure = (error) => {
  if (!UPSTREAM_CODES.includes(String(error?.code ?? ''))) return false;
  const status = Number(error?.upstreamStatus);
  return !Number.isInteger(status) || status >= 500 || status === 408 || status === 429;
};
/** How many registry reads run at once: a frozen collection's worker queues eight, and a live registry is shared. */
const REGISTRY_READS = 4;
/** How long progress may go unsaid, so a slow provider does not read as a dead worker. */
const PROGRESS_EVERY_MS = 60_000;

/** The people whose records are held in memory at once. A roster of thousands is read a few at a time, and stage two reads again. */
const NOTES_HELD = 32;
/** The criteria a choice of relevant concepts is made from: a job against hundreds of trials is asked about a sample of them, and the rows are cut on dates past that. */
const LONG_CRITERIA_TARGETS = 8;
const LONG_CRITERIA_CHARS = 4_000;

/** What the job counts, for the operator's metric family (principle 15). */
export function createMatchJudgeCounters() {
  return { started: 0, pairsDone: 0, pairsFailed: 0, callsRetried: 0, stopped: 0, canceled: 0 };
}

/** @param {Record<string, any>} config */
const effectiveThinking = (config) => (config?.vcrMatchJudgeThinking === 'off' ? 'off' : 'high');
/** @param {Record<string, any>} config */
const effectiveModel = (config) => String(config?.deepseekModel || VCR_MATCH_BATCH_DEFAULT_MODEL);
/** @param {Record<string, any>} config */
const effectiveTopK = (config) => (config?.vcrMatchJudgeTopK === 'all' ? 'all' : Number.isInteger(config?.vcrMatchJudgeTopK) ? config.vcrMatchJudgeTopK : 20);
/** @param {Record<string, any>} config */
const effectiveOutputTokens = (config) => Math.max(1_000, Math.min(384_000, Number(config?.vcrMatchJudgeOutputTokens ?? 16_000) || 16_000));

/** The registry a registration number belongs to, where its shape says. @param {string} registryId */
const registryOfId = (registryId) => (/^ChiCTR/iu.test(registryId) ? 'chictr' : /^\d{4}-\d{6}-\d{2}(?:-\d{2})?$/u.test(registryId) ? 'ctis' : 'clinicaltrials.gov');

/**
 * The selection of a judging job. Nothing else is accepted: the pairs' text, the settings of the model and the estimate are the platform's.
 *
 * - patient to trial: `subjectKey` and `registryIds`, with `registry` when the ids' shape does not say and `collection` + `collectionRevision` for a frozen collection;
 * - trial to patient: `protocolVersionId` (the latest when absent) and `subjectKeys` (the study's roster when absent);
 * - `fit` (stage one, default true), `topK` (stage two: 0 none, `all` every pair, a number per person; the deployment's when absent), `thinking` (`high` or `off`).
 *
 * @param {unknown} raw @returns {Record<string, any>}
 */
export function judgeSelection(raw = {}) {
  const fields = ['direction', 'subjectKey', 'registryIds', 'registry', 'collection', 'collectionRevision', 'protocolVersionId', 'subjectKeys', 'fit', 'topK', 'thinking'];
  const row = object(raw);
  const bad = (/** @type {string} */ message) => new HttpError(400, 'vcr_matching_selection_invalid', message);
  const unknown = Object.keys(row).find((key) => !fields.includes(key));
  if (unknown) throw bad(`selection 不接受 ${unknown}：可写 ${fields.join('、')}。`);
  const direction = row.direction ?? (row.registryIds != null || row.subjectKey != null ? 'patient_to_trial' : 'trial_to_patient');
  if (!['patient_to_trial', 'trial_to_patient'].includes(direction)) throw bad('direction 是 patient_to_trial 或 trial_to_patient。');
  if (direction === 'patient_to_trial') {
    if (typeof row.subjectKey !== 'string' || !ID.test(row.subjectKey)) throw bad('给一位患者判定试验，要写 subjectKey。');
    if (!Array.isArray(row.registryIds) || !row.registryIds.length || row.registryIds.length > VCR_MATCH_JUDGE_LIMITS.trials
      || row.registryIds.some((/** @type {unknown} */ id) => typeof id !== 'string' || !REGISTRY_ID.test(id))) throw bad(`registryIds 是 1 到 ${VCR_MATCH_JUDGE_LIMITS.trials} 个登记号。`);
    if (row.protocolVersionId != null || row.subjectKeys != null) throw bad('一位患者对一组试验：protocolVersionId 和 subjectKeys 属于另一个方向。');
  } else {
    if (row.subjectKey != null || row.registryIds != null) throw bad('一份方案对一批患者：subjectKey 和 registryIds 属于另一个方向。');
    if (row.protocolVersionId != null && (typeof row.protocolVersionId !== 'string' || !ID.test(row.protocolVersionId))) throw bad('protocolVersionId 是本研究的方案版本。');
    if (row.subjectKeys != null && (!Array.isArray(row.subjectKeys) || !row.subjectKeys.length || row.subjectKeys.length > VCR_MATCH_JUDGE_LIMITS.subjects
      || row.subjectKeys.some((/** @type {unknown} */ key) => typeof key !== 'string' || !ID.test(key)))) throw bad(`subjectKeys 是 1 到 ${VCR_MATCH_JUDGE_LIMITS.subjects} 个受试者假名。`);
  }
  if (row.registry != null && !REGISTRIES.includes(row.registry)) throw bad(`registry 是 ${REGISTRIES.join('、')} 之一。`);
  if ((row.collection == null) !== (row.collectionRevision == null) || (row.collection != null && (typeof row.collection !== 'string' || !ID.test(row.collection) || typeof row.collectionRevision !== 'string' || !SHA.test(row.collectionRevision)))) {
    throw bad('冻结集合要同时写 collection 和 collectionRevision。');
  }
  if (row.fit != null && typeof row.fit !== 'boolean') throw bad('fit 是 true 或 false。');
  if (row.topK != null && row.topK !== 'all' && !(Number.isInteger(row.topK) && row.topK >= 0 && row.topK <= VCR_MATCH_JUDGE_LIMITS.trials)) throw bad(`topK 是 0 到 ${VCR_MATCH_JUDGE_LIMITS.trials} 的整数，或 all。`);
  if (row.fit === false && row.topK === 0) throw bad('fit 为 false 时只有逐条判定一步，topK 不能为 0。');
  if (row.thinking != null && !['high', 'off'].includes(row.thinking)) throw bad('thinking 是 high 或 off。');
  return { ...row, direction, ...(row.registryIds ? { registryIds: [...new Set(/** @type {string[]} */ (row.registryIds))] } : {}), ...(row.subjectKeys ? { subjectKeys: [...new Set(/** @type {string[]} */ (row.subjectKeys))] } : {}) };
}

// ---------------------------------------------------------------------------
// The model's part
// ---------------------------------------------------------------------------

/**
 * The one model call of a pair's part, with its bounded retries: an upstream failure and a timeout are tried at most twice more, with a backoff;
 * anything else is the pair's own failure, or the job's when it is a budget. `finish_reason` other than `stop` fails the call, because an answer cut
 * off by `max_tokens` (reasoning counts towards it) is not a short answer.
 *
 * @param {{ config: Record<string, any>, usageLedger?: any, callModel?: typeof callModelForControlPlane, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<unknown>, counters?: ReturnType<typeof createMatchJudgeCounters>, now?: () => Date }} deps
 */
export function createPairJudge({ config, usageLedger = null, callModel = callModelForControlPlane, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), counters = createMatchJudgeCounters(), now = () => new Date() }) {
  const model = effectiveModel(config);
  const timeoutMs = Math.max(5_000, Math.min(1_200_000, Number(config.vcrMatchJudgeTimeoutMs ?? 180_000) || 180_000));
  const maxTokens = effectiveOutputTokens(config);
  /** @param {{ study: any, jobId: string, messages: Array<{ role: string, content: string }>, thinking: string }} input */
  const once = async ({ study, jobId, messages, thinking }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = await callModel({ config, usageLedger, fetchImpl }, {
        userId: String(study.userId), projectId: String(study.projectId ?? ''), runId: jobId, purpose: 'vcr', signal: controller.signal,
        body: {
          model, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages,
          ...(thinking === 'off' ? { thinking: { type: 'disabled' }, temperature: 0 } : { thinking: { type: 'enabled' }, reasoning_effort: 'high' }),
        },
      });
      const choice = body?.choices?.[0];
      const usage = object(body?.usage);
      const counted = {
        inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
        outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
        cacheHitTokens: Number.isFinite(usage.prompt_cache_hit_tokens) ? usage.prompt_cache_hit_tokens : 0,
        reasoningTokens: Number.isFinite(usage.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : 0,
      };
      if (choice?.finish_reason === 'length') throw Object.assign(failure('vcr_match_judge_cut_off', 'The answer was cut off by the output allowance.'), { usage: counted });
      if (choice && Object.hasOwn(choice, 'finish_reason') && choice.finish_reason !== 'stop') throw Object.assign(failure('vcr_match_judge_incomplete', 'The model did not finish its answer.'), { usage: counted });
      return { content: String(choice?.message?.content ?? ''), usage: counted };
    } catch (error) {
      const name = /** @type {any} */ (error)?.name;
      if (name === 'AbortError' || controller.signal.aborted) throw failure('vcr_match_judge_timeout', 'The model call timed out.');
      const network = String(/** @type {any} */ (error)?.cause?.code ?? /** @type {any} */ (error)?.code ?? '');
      if ((name === 'TypeError' && !/** @type {any} */ (error)?.code) || /^(?:E[A-Z]{3,}|UND_ERR)/u.test(network)) throw failure('vcr_match_judge_network', 'The model provider could not be reached.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    model,
    maxTokens,
    timeoutMs,
    /** @param {{ study: any, jobId: string, messages: Array<{ role: string, content: string }>, thinking: string }} input */
    async call(input) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const answered = await once(input);
          const priced = priceUsage({ resourceType: 'model', model, cacheHit: answered.usage.cacheHitTokens, cacheMiss: Math.max(0, answered.usage.inputTokens - answered.usage.cacheHitTokens), output: answered.usage.outputTokens, peak: isPeak(now()) });
          return { ...answered, cost: priced.priced ? priced.cost : null, currency: priced.currency || 'CNY' };
        } catch (error) {
          if (!transientFailure(error) || attempt >= RETRY_BACKOFF_MS.length) throw error;
          counters.callsRetried += 1;
          await sleep(RETRY_BACKOFF_MS[attempt]);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// What is judged: a person's record, a trial's text
// ---------------------------------------------------------------------------

/**
 * The columns of the study's subject table a judgment reads, or null. Only the names: the cells are read per person through the cloud path.
 * @param {any} subjectTable @param {any} study
 */
export async function tableFieldsOf(subjectTable, study) {
  if (!subjectTable?.read) return null;
  let table;
  try { table = await subjectTable.read(study); } catch { return null; }
  if (!table?.available || !table.snapshotId) return null;
  // A table of keys alone still says who the people are, when their record is in long tables.
  const fields = list(table.columns).map((column) => String(column.name)).filter((name) => name && name !== 'USUBJID');
  const keyAt = list(table.header).indexOf('USUBJID');
  return { snapshotId: String(table.snapshotId), fields, subjects: keyAt < 0 ? [] : [...new Set(list(table.rows).map((row) => String(row?.[keyAt] ?? '').trim()).filter(Boolean))] };
}

/**
 * One person's record as a judgment reads it: their documents, oldest first, then their table cells as readable lines, sentence-numbered across all of
 * them. The hash names what was read, so a changed document is a new judgment and an unchanged one is not.
 *
 * @param {{ study: any, subjectKey: string, documents: any, roster: ReadonlyArray<{ id: string, visibleAt?: string | null }>, table?: { snapshotId: string, fields: string[] } | null, long?: any, ahead?: readonly string[] }} input
 * @returns {Promise<{ hash: string, documentIds: string[], records: any[], sentences: any[], unreadable: number, chars: number, leftOut?: { rows: number, earliest: string | null } }>}
 */
export async function readSubjectNote({ study, subjectKey, documents, roster, table = null, long = null, ahead = [] }) {
  const ordered = [...roster].sort((a, b) => String(a.visibleAt ?? '').localeCompare(String(b.visibleAt ?? '')) || String(a.id).localeCompare(String(b.id)));
  /** @type {any[]} */ const records = [];
  /** @type {any[]} */ const sentences = [];
  /** @type {string[]} */ const documentIds = [];
  /** @type {Array<[string, string]>} */ const identity = [];
  let unreadable = 0;
  /** @type {string | null} */
  let firstFailure = null;
  for (const entry of ordered) {
    documentIds.push(String(entry.id));
    /** @type {any} */
    let record = null;
    try { record = await documents.runtimeRead(study, { subjectKey, documentId: String(entry.id) }); }
    catch (error) { firstFailure = firstFailure ?? String(/** @type {any} */ (error)?.code ?? 'vcr_projection_unavailable'); }
    if (!record?.text) { unreadable += 1; continue; }
    const text = String(record.text);
    const id = String(record.id ?? entry.id);
    if (!documentIds.includes(id)) documentIds.push(id);
    const pageOf = (/** @type {{ start: number }} */ sentence) => list(record.pageMap).find((page) => sentence.start >= page.start && sentence.start < page.end)?.page;
    const numbered = segmentSentences(text).map((sentence) => { const page = pageOf(sentence); return { ...sentence, id: sentences.length + sentence.id, documentId: id, ...(page ? { page } : {}) }; });
    sentences.push(...numbered);
    records.push({ documentId: id, text, sentences: numbered });
    identity.push([id, String(record.projectionHash ?? record.sourceHash ?? sha256(text))]);
  }
  if (table?.fields?.length && documents.runtimeEvidence) {
    const cells = await documents.runtimeEvidence(study, table.fields.map((field) => ({ source: { snapshotId: table.snapshotId, field } })), subjectKey).catch(() => []);
    const lines = list(cells).filter((cell) => typeof cell?.quote === 'string' && cell.quote);
    if (lines.length) {
      let at = 0;
      const numbered = lines.map((cell) => {
        const sentence = { id: sentences.length, text: String(cell.quote), start: at, end: at + String(cell.quote).length, documentId: null, source: { snapshotId: table.snapshotId, field: String(cell.source?.field ?? cell.locator?.field ?? '') } };
        at += sentence.text.length + 1;
        sentences.push(sentence);
        return sentence;
      });
      const text = lines.map((cell) => String(cell.quote)).join('\n');
      records.push({ documentId: null, text, sentences: numbered });
      identity.push(['table', sha256(text)]);
    }
  }
  // The long tables: conditions, labs and medications as dated lines, within a bounded size, and what was left out said in the record itself.
  /** @type {{ rows: number, earliest: string | null } | null} */
  let leftOut = null;
  const held = long ? await long.linesFor(subjectKey, ahead).catch(() => null) : null;
  if (held?.lines?.length) {
    leftOut = held.leftOut ?? null;
    const lines = [...held.lines, ...(leftOut ? [{ text: `（结构化数据中另有 ${leftOut.rows} 行较早或与条件关系较小的记录没有列出${leftOut.earliest ? `，最早 ${leftOut.earliest}` : ''}。）`, snapshotId: held.lines[0].snapshotId }] : [])];
    let at = 0;
    const numbered = lines.map((line) => {
      const sentence = { id: sentences.length, text: line.text, start: at, end: at + line.text.length, documentId: null, source: { snapshotId: line.snapshotId, long: true } };
      at += line.text.length + 1;
      sentences.push(sentence);
      return sentence;
    });
    const text = lines.map((line) => line.text).join('\n');
    records.push({ documentId: null, text, sentences: numbered });
    identity.push(['long', sha256(text)]);
  }
  if (!records.length) throw failure(firstFailure ?? 'vcr_match_no_patient_text', '这位受试者没有可读的病历或表格。');
  return { hash: sha256(canonicalScenarioJson(identity)), documentIds, records, sentences, unreadable, chars: records.reduce((sum, record) => sum + record.text.length, 0), ...(leftOut ? { leftOut } : {}) };
}

/**
 * What the two kinds of target read as, one trial or protocol version at a time. A registry read is shared by every call of a job through `once`, and the
 * number at once is bounded.
 * A ChiCTR listing carries no eligibility text; `pages` (vcrRegistryPages) reads it from the record's page when it can, and a record whose page gave nothing is a
 * target with `eligibilitySource: 'none'` as before. Whatever `pages` does, it never makes a read fail.
 * @param {{ evidence?: any, matchStore: any, pages?: { eligibilityFor: (input: { registry: string, registryId: string, url?: string | null, signal?: AbortSignal }) => Promise<{ eligibility: string, url: string, fetchedAt: string, source: string } | null> } | null }} deps
 */
export function judgmentTargets({ evidence = null, matchStore, pages = null }) {
  return {
    /** A registry record, whole: nothing here is cut, because a clause is never truncated. A record with no eligibility text is still a target.
     * @param {{ userId: string, registry: string, registryId: string, collection?: string | null, collectionRevision?: string | null, signal?: AbortSignal }} input */
    async trial(input) {
      if (!evidence?.judgmentRecord) throw failure('registry_unavailable', '试验登记检索未接入。');
      const fetched = await evidence.judgmentRecord(input);
      if (fetched?.status !== 'ok') {
        const missing = fetched?.status === 'registry_not_found';
        throw failure(missing ? 'registry_not_found' : 'registry_unavailable', missing ? '登记平台没有这个登记号的记录。' : `没能取回这条登记记录（${fetched?.reason ?? fetched?.status ?? 'unknown'}）。`);
      }
      const trial = fetched.trial;
      let eligibility = String(trial.eligibility ?? '');
      /** @type {{ eligibility: string, url: string, fetchedAt: string, source: string } | null} */
      let page = null;
      if (!eligibility.trim() && pages && !trial.collection) {
        page = await pages.eligibilityFor({ registry: String(trial.registry ?? input.registry), registryId: String(trial.registryId), url: trial.url, signal: input.signal }).catch(() => null);
        if (page?.eligibility.trim()) eligibility = page.eligibility;
        else page = null;
      }
      const words = { title: String(trial.title ?? ''), summary: String(trial.summary ?? ''), eligibility, conditions: list(trial.conditions).map(String), interventions: list(trial.interventions).map(String) };
      return { kind: 'candidate_trial', id: String(trial.registryId), ...words, clauses: segmentCriteria(eligibility), hash: sha256(canonicalScenarioJson(words)),
        eligibilitySource: page ? 'web_read' : eligibility.trim() ? 'registry' : 'none',
        summaryOfTarget: { kind: 'candidate_trial', id: String(trial.registryId), registry: String(trial.registry ?? input.registry), registryId: String(trial.registryId), title: words.title,
          ...(trial.url ? { url: String(trial.url) } : {}), ...(trial.status ? { status: String(trial.status) } : {}), ...(trial.phase ? { phase: String(trial.phase) } : {}),
          ...(trial.recordHash ? { recordHash: String(trial.recordHash) } : {}), ...(trial.collection ? { collection: trial.collection } : {}),
          ...(page ? { eligibilityPage: { url: page.url, fetchedAt: page.fetchedAt } } : {}) } };
    },
    /** A protocol version: its clauses are its criteria as written, each a clause, and those words in order are its eligibility text.
     * @param {{ study: any, protocolVersionId: string }} input */
    async protocol({ study, protocolVersionId }) {
      const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId });
      if (!criteria.length) throw failure('vcr_criteria_missing', '这个方案版本没有入排条件。');
      const version = (await matchStore.protocols?.(study.id, protocolVersionId))?.[0] ?? null;
      /** @type {Array<{ number: number, kind: string, text: string, start: number, end: number, criterionId?: string }>} */
      const clauses = [];
      let eligibility = '';
      for (const [kind, heading] of [['inclusion', 'Inclusion Criteria:'], ['exclusion', 'Exclusion Criteria:']]) {
        const rows = criteria.filter((/** @type {any} */ row) => (row.kind ?? 'inclusion') === kind);
        if (!rows.length) continue;
        eligibility += `${eligibility ? '\n\n' : ''}${heading}`;
        for (const row of rows) {
          const text = String(row.sourceText ?? '').trim();
          if (!text) continue;
          eligibility += '\n* ';
          clauses.push({ number: clauses.length + 1, kind, text, start: eligibility.length, end: eligibility.length + text.length, ...(row.id ? { criterionId: String(row.id) } : {}) });
          eligibility += text;
        }
      }
      const title = String(version?.title ?? '');
      return { kind: 'protocol_version', id: protocolVersionId, title, summary: '', eligibility, conditions: [], interventions: [], clauses, hash: sha256(canonicalScenarioJson({ title, eligibility })),
        eligibilitySource: 'protocol', summaryOfTarget: { kind: 'protocol_version', id: protocolVersionId, title, ...(version?.version ? { version: version.version } : {}) } };
    },
  };
}

/**
 * One model answer, asked again once when it cannot be read: 2 of the first 205 real answers held no usable score, and the same pair read
 * fine when asked again, so one more call is worth more than a failed pair.
 * @param {{ judge: any, ask: Record<string, any>, calls: any[], read: (content: string) => any, usable: (parsed: any) => boolean }} input
 */
async function askOnceMore({ judge, ask, calls, read, usable }) {
  for (let attempt = 0; ; attempt += 1) {
    const answered = await judge.call(ask).catch((/** @type {any} */ error) => { throw Object.assign(error, { calls }); });
    calls.push(answered);
    const parsed = read(answered.content);
    if (attempt >= 1 || usable(parsed)) return parsed;
  }
}

/**
 * One pair's trial-level judgment, a call per part of the record.
 * @param {{ judge: any, study: any, jobId: string, note: any, target: any, thinking: string, cap: number }} input
 */
async function judgeFit({ judge, study, jobId, note, target, thinking, cap }) {
  const parts = splitNoteParts(note.records, cap);
  const answers = [];
  /** @type {any[]} */ const calls = [];
  for (const part of parts) {
    const messages = fitMessages({ title: target.title, summary: target.summary, eligibility: target.eligibility, note: part.text, conditions: target.conditions, interventions: target.interventions });
    answers.push(await askOnceMore({ judge, ask: { study, jobId, messages, thinking }, calls, read: parseFitAnswer, usable: (parsed) => parsed.fit !== null }));
  }
  const merged = mergeFitAnswers(answers);
  if (merged.fit === null) throw Object.assign(failure('vcr_match_answer_unreadable', 'The answer held no score.'), { calls });
  return { parsed: merged, calls, parts: parts.length };
}

/**
 * One pair's per-clause judgment, a call per part of the record.
 * @param {{ judge: any, study: any, jobId: string, note: any, target: any, thinking: string, cap: number }} input
 */
async function judgeCriteria({ judge, study, jobId, note, target, thinking, cap }) {
  const parts = splitNoteParts(note.records, cap);
  const answers = [];
  /** @type {any[]} */ const calls = [];
  for (const part of parts) {
    const messages = criteriaMessages({ title: target.title, summary: target.summary, criteria: target.clauses, sentences: part.sentences, conditions: target.conditions, interventions: target.interventions });
    answers.push(await askOnceMore({ judge, ask: { study, jobId, messages, thinking }, calls,
      read: (/** @type {string} */ content) => parseCriteriaAnswer(content, { criteria: target.clauses, sentences: part.sentences }),
      usable: (parsed) => parsed.rows.length > 0 }));
  }
  const merged = mergeCriteriaAnswers(answers);
  if (!merged.rows.length) throw Object.assign(failure('vcr_match_answer_unreadable', 'The answer judged no clause.'), { calls });
  return { parsed: merged, calls, parts: parts.length };
}

/** The usage of some calls as one, for the row and the result. @param {readonly any[]} calls */
function usageOfCalls(calls) {
  const sum = { calls: calls.length, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, reasoningTokens: 0, cost: /** @type {number | null} */ (0), currency: 'CNY' };
  for (const call of calls) {
    for (const key of /** @type {const} */ (['inputTokens', 'outputTokens', 'cacheHitTokens', 'reasoningTokens'])) sum[key] += Number(call?.usage?.[key] ?? 0);
    sum.cost = sum.cost === null || call?.cost == null ? null : sum.cost + Number(call.cost);
    if (call?.currency) sum.currency = call.currency;
  }
  return sum;
}

/**
 * What a study's long tables mean for one job, from the model: what a table no list knows holds, and which recorded concepts bear on these criteria. A failure is a job that picks rows on dates alone.
 * @param {{ judge: any, study: any, jobId: string, long: any, scenario: Record<string, any>, targetList: any[], targetOf: (entry: any) => Promise<any> }} input
 */
async function askLongMeaning({ judge, study, jobId, long, scenario, targetList, targetOf }) {
  /** @type {Record<string, any>} */
  let shapes = {};
  try {
    const unknown = await long.unknownTables();
    if (unknown.length) {
      const answered = await judge.call({ study, jobId, thinking: 'off', messages: longShapeMessages(unknown) });
      shapes = acceptLongShapes(answered.content, unknown);
      await long.setShapes(shapes);
    }
  } catch { shapes = {}; }
  /** @type {string[]} */
  let relevant = [];
  try {
    const concepts = await long.concepts();
    const criteria = [];
    for (const entry of targetList.slice(0, LONG_CRITERIA_TARGETS)) {
      const target = await targetOf(entry).catch(() => null);
      if (target?.eligibility) criteria.push(String(target.eligibility).slice(0, LONG_CRITERIA_CHARS));
    }
    if (concepts.length && criteria.length) relevant = acceptRelevance((await judge.call({ study, jobId, thinking: 'off', messages: longRelevanceMessages(concepts, criteria.join('\n\n')) })).content, concepts);
  } catch { relevant = []; }
  return { shapes, relevant, ...(scenario.chain ? { chain: scenario.chain } : {}) };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** How many pairs stage two takes for this many people and targets. @param {number} people @param {number} targets @param {number | 'all'} topK */
const criteriaPairs = (people, targets, topK) => people * (topK === 'all' ? targets : Math.min(Number(topK), targets));

/**
 * What a start will do, from the roster alone (no record and no trial is read to make it).
 *
 * @param {{ study: any, selection?: unknown, matchStore: any, documents: any, subjectTable?: any, config: Record<string, any>, peak?: boolean }} deps
 * @returns {Promise<{ ok: false, message: string } | { ok: true, scenario: Record<string, any>, statement: string, withdrawn: number, noRecord: number }>}
 */
export async function planMatchJudge({ study, selection: raw = {}, matchStore, documents, subjectTable = null, config, peak = true }) {
  const selection = judgeSelection(raw);
  if (!documents?.roster) return { ok: false, message: '病历文档未接入本部署：这一步暂不可用，其余步骤照常。' };
  const withdrawn = await matchStore.withdrawnSubjects?.(study.id) ?? new Set();
  const records = await documents.roster(study);
  /** @type {Map<string, number>} */
  const charsOf = new Map();
  for (const record of records) charsOf.set(String(record.subjectKey), (charsOf.get(String(record.subjectKey)) ?? 0) + (Number(record.chars) > 0 ? Number(record.chars) : VCR_MATCH_JUDGE_LIMITS.noteChars));
  const table = await tableFieldsOf(subjectTable, study);
  const inTable = new Set(table?.subjects ?? []);
  const direction = selection.direction;
  /** @type {string[]} */
  let people;
  /** @type {Record<string, any>} */
  const target = {};
  let targets = 1;
  if (direction === 'patient_to_trial') {
    people = [String(selection.subjectKey)];
    target.trials = list(selection.registryIds).map((registryId) => ({ registry: selection.registry ?? registryOfId(String(registryId)), registryId: String(registryId) }));
    targets = target.trials.length;
    if (selection.collection) { target.collection = selection.collection; target.collectionRevision = selection.collectionRevision; }
  } else {
    const version = selection.protocolVersionId ?? (await matchStore.latestProtocol?.(study.id))?.id;
    const criteria = version ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: String(version) }) : [];
    if (!version || !criteria.length) return { ok: false, message: '还没有入排条件：先写方案的入排条件，再判定患者。' };
    target.protocolVersionId = String(version);
    people = selection.subjectKeys ?? [...new Set([...charsOf.keys(), ...inTable])].sort();
  }
  const leftOut = people.filter((key) => withdrawn.has(key)).length;
  people = people.filter((key) => !withdrawn.has(key));
  const readable = people.filter((key) => charsOf.has(key) || inTable.has(key));
  if (!readable.length) return { ok: false, message: direction === 'patient_to_trial' ? '这位受试者没有可读的病历，也不在受试者表里：先写入病历再判定。' : '这项研究还没有可读的病历或受试者表：先导入，再判定。' };
  // A person named who has no record is one failed pair with its code, and the others go on.
  const fit = selection.fit !== false;
  const topK = selection.topK ?? effectiveTopK(config);
  const thinking = selection.thinking ?? effectiveThinking(config);
  const model = effectiveModel(config);
  const outputPerCall = effectiveOutputTokens(config);
  const cap = VCR_MATCH_JUDGE_LIMITS.noteChars;
  let inputTokens = 0, outputTokens = 0, calls = 0;
  const perPerson = criteriaPairs(1, targets, topK);
  for (const key of readable) {
    const chars = charsOf.get(key) ?? 2_000;
    const parts = Math.max(1, Math.ceil(chars / cap));
    const pairs = (fit ? targets : 0) + perPerson;
    calls += parts * pairs;
    inputTokens += pairs * (chars + parts * (VCR_MATCH_JUDGE_LIMITS.trialChars + VCR_MATCH_JUDGE_LIMITS.overheadTokens));
    outputTokens += parts * pairs * outputPerCall;
  }
  const priced = priceUsage({ resourceType: 'model', model, cacheHit: 0, cacheMiss: inputTokens, output: outputTokens, peak });
  const pairs = people.length * targets;
  const estimate = { basis: 'estimate', model, thinking, pairs, calls, inputTokens, outputTokens, outputTokensPerCall: outputPerCall, cost: priced.priced ? priced.cost : null, currency: priced.currency || 'CNY' };
  const scenario = { direction, subjects: people, ...target, fit, topK, thinking, model, promptVersions: { ...VCR_JUDGMENT_PROMPT_VERSIONS }, estimate };
  return { ok: true, scenario: { ...scenario, chain: judgeChain(scenario) }, statement: judgeStatement({ pairs, fit, topK, estimate, withdrawn: leftOut, noRecord: people.length - readable.length }), withdrawn: leftOut, noRecord: people.length - readable.length };
}

/** @param {Record<string, any>} scenario What makes two starts the same job. */
function judgeChain(scenario) {
  const { estimate: _estimate, chain: _chain, ...identity } = scenario;
  return createHash('sha256').update(canonicalScenarioJson(identity)).digest('hex').slice(0, 16);
}

/** @param {{ pairs: number, fit: boolean, topK: number | 'all', estimate: Record<string, any>, withdrawn: number, noRecord: number }} input */
function judgeStatement({ pairs, fit, topK, estimate, withdrawn, noRecord }) {
  const wan = (/** @type {number} */ value) => (value >= 10_000 ? `${Math.round(value / 1_000) / 10} 万` : String(value));
  const stages = [fit ? '先逐对整体评估' : '', topK === 'all' ? '再逐条判定每一对' : topK ? `再对每位患者排名前 ${topK} 的逐条判定` : ''].filter(Boolean).join('，') || '逐条判定';
  const cost = estimate.cost == null ? '费用按当前价格表算不出' : `最多约 ${estimate.cost.toFixed(2)} 元`;
  return [
    `这一批判定 ${pairs} 对（患者 × 试验），${stages}，共约 ${estimate.calls} 次模型调用；预计最多 ${wan(estimate.inputTokens)} 个输入词元、${wan(estimate.outputTokens)} 个输出词元，${cost}（按每个字一个词元和每次调用的全部输出额度估，实际通常低得多；做完会写出实际用量）。`,
    withdrawn ? `有 ${withdrawn} 位已撤回同意，不判定。` : '',
    noRecord ? `有 ${noRecord} 位没有病历，会记为没判成。` : '',
    '已经开始，不用确认。一对失败不影响其他；中途取消，判完的保留；再启动同样的选择只判没判过的。判完会通知。',
  ].join('');
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * The local executor of `matching.judge`.
 *
 * A job the queue runs (`yieldable`) works in batches: after `vcrMatchJudgeSlicePairs` pairs or `vcrMatchJudgeSliceMs`, whichever comes first, it hands its turn back with what it
 * has done in its checkpoint, so that a run of thousands of people needs nobody to restart it, outlives a deployment and does not make the account's other work wait for it. What
 * the checkpoint carries is small: a cursor, a mark per pair, the bill. A marked pair is not read again, which is what keeps the batches from growing with the roster; a pair past
 * the last checkpoint is read again after a crash and finds its row in the ledger. A provider that is down is waited out the same way, a few times with a growing wait, and a pair
 * that failed for a reason that passes is tried once more at the end of its stage.
 *
 * @param {{ store: any, matchStore: any, judgments: any, documents: any, subjectTable?: any, targets: ReturnType<typeof judgmentTargets>, judge: ReturnType<typeof createPairJudge>,
 *   config?: Record<string, any>, report?: (code: string) => void, counters?: ReturnType<typeof createMatchJudgeCounters>, now?: () => Date }} deps
 */
export function createMatchJudgeExecutor({ store, matchStore, judgments, documents, subjectTable = null, targets, judge, config = {}, report = () => {}, counters = createMatchJudgeCounters(), now = () => new Date() }) {
  const width = Math.max(1, Math.min(64, Number(config.vcrMatchJudgeConcurrency ?? 8) || 8));
  const stopAfter = Math.max(1, Number(config.vcrMatchJudgeMaxUpstreamFailures ?? 20) || 20);
  const slicePairs = Math.max(1, Number(config.vcrMatchJudgeSlicePairs ?? 400) || 400);
  const sliceMs = Math.max(1_000, Number(config.vcrMatchJudgeSliceMs ?? 300_000) || 300_000);
  const outageWaits = Math.max(0, Number(config.vcrMatchJudgeOutageWaits ?? 6));
  const cap = VCR_MATCH_JUDGE_LIMITS.noteChars;
  /** @param {{ job: Record<string, any>, onProgress: (progress: { done: number, total: number, note?: string }) => Promise<unknown>, isCanceled?: () => Promise<boolean>, yieldable?: boolean, saveCheckpoint?: ((patch: Record<string, any>) => Promise<unknown>) | null }} input */
  return async ({ job, onProgress, isCanceled = async () => false, yieldable = false, saveCheckpoint = null }) => {
    const studyId = String(job?.studyId ?? '');
    const jobId = String(job?.jobId ?? job?.id);
    const found = await store.studyById(studyId);
    if (!found) throw Object.assign(new Error('The study of this job is gone.'), { code: 'vcr_study_not_found' });
    const scenario = object(job.scenario);
    const checkpoint = object((await store.one('SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1', [jobId]))?.checkpoint);
    const origin = object(checkpoint.cloudContext);
    const carried = object(checkpoint.judge);
    const startedAt = String(carried.startedAt ?? now().toISOString());
    // `tableSession`: the study's subject table read once for this batch, not once per person. Each person's read is still judged and audited (`subjectTableEvidenceBatch`).
    const study = { ...found, tableSession: new Map(), cloudContext: origin.runId && origin.sessionId ? { runId: String(origin.runId), sessionId: String(origin.sessionId) } : { runId: jobId, sessionId: `vcr-job:${jobId}` } };
    const thinking = String(scenario.thinking), model = String(scenario.model);
    const promptVersions = object(scenario.promptVersions);
    const direction = String(scenario.direction);
    const targetKind = direction === 'patient_to_trial' ? 'candidate_trial' : 'protocol_version';

    const withdrawn = await matchStore.withdrawnSubjects?.(studyId) ?? new Set();
    const frozenSubjects = list(scenario.subjects).map(String);
    const subjects = frozenSubjects.filter((key) => !withdrawn.has(key));
    const skippedWithdrawn = frozenSubjects.length - subjects.length;
    const held = await documents.roster(found);
    /** @type {Map<string, any[]>} */
    const rosterOf = new Map();
    for (const record of held) {
      const key = String(record.subjectKey);
      const own = rosterOf.get(key);
      if (own) own.push(record); else rosterOf.set(key, [record]);
    }
    const table = await tableFieldsOf(subjectTable, study);
    // The long tables, if the study has any, and what they mean for this job: asked of the model once, then in the checkpoint and on every later attempt of the same selection, so the same
    // words are read again and the ledger finds them.
    const long = await documents.longTables?.(study).catch(() => null) ?? null;

    /** A few people's records at a time, so a roster of thousands does not sit in memory. @type {Map<string, Promise<any>>} */
    const notes = new Map();
    const noteOf = (/** @type {string} */ subjectKey) => {
      const open = notes.get(subjectKey);
      if (open) return open;
      const position = long ? frozenSubjects.indexOf(subjectKey) : -1;
      const reading = readSubjectNote({ study, subjectKey, documents, roster: rosterOf.get(subjectKey) ?? [], table, long, ahead: position >= 0 ? frozenSubjects.slice(position + 1, position + LONG_LIMITS.windowPeople) : [] });
      notes.set(subjectKey, reading);
      reading.catch(() => {});
      if (notes.size > NOTES_HELD) notes.delete(/** @type {string} */ (notes.keys().next().value));
      return reading;
    };
    // A failed read is not held for the job: the next pair of this trial may find the registry back.
    /** @type {Map<string, Promise<any>>} */
    const targetsHeld = new Map();
    let reading = 0;
    /** @type {Array<() => void>} */
    const waiting = [];
    const readTarget = async (/** @type {Record<string, any>} */ entry) => {
      if (reading >= REGISTRY_READS) await new Promise((resolve) => { waiting.push(() => resolve(null)); });
      reading += 1;
      try {
        return direction === 'patient_to_trial'
          ? await targets.trial({ userId: String(found.userId), registry: String(entry.registry), registryId: String(entry.registryId), collection: scenario.collection ?? null, collectionRevision: scenario.collectionRevision ?? null })
          : await targets.protocol({ study, protocolVersionId: String(scenario.protocolVersionId) });
      } finally {
        reading -= 1;
        waiting.shift()?.();
      }
    };
    const targetOf = (/** @type {Record<string, any>} */ entry) => {
      const key = String(entry.registryId ?? scenario.protocolVersionId);
      const open = targetsHeld.get(key);
      if (open) return open;
      const fetching = readTarget(entry);
      targetsHeld.set(key, fetching);
      fetching.catch(() => { targetsHeld.delete(key); });
      return fetching;
    };

    const targetList = direction === 'patient_to_trial' ? list(scenario.trials).map(object) : [{ protocolVersionId: String(scenario.protocolVersionId) }];
    // Over the frozen roster, withdrawn people included, so that a position in the marks means the same pair in every batch.
    const pairs = frozenSubjects.flatMap((subjectKey) => targetList.map((target) => ({ subjectKey, target, targetId: String(target.registryId ?? target.protocolVersionId) })));
    const done = await judgments.doneFor({ studyId, promptVersions: Object.values(promptVersions).map(String), model, thinking, subjectKeys: subjects.length <= 1000 ? subjects : null });

    /**
     * What has become of each pair in each stage, one character a pair: `.` not reached, `d` judged by this job, `a` already in the ledger, `f` failed, `t` failed for a reason that
     * passes, `w` the person withdrew, `n` nothing for this stage to ask.
     */
    const marks = { fit: Array.from(String(object(carried.marks).fit ?? '.'.repeat(pairs.length))), criteria: Array.from(String(object(carried.marks).criteria ?? '.'.repeat(pairs.length))) };
    const used = { calls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, reasoningTokens: 0, cost: /** @type {number | null} */ (0), currency: 'CNY', ...object(carried.used) };
    /** @type {Record<string, number>} */
    const failures = { ...object(carried.failures) };
    /** @type {Map<string, any>} what this batch learned of a pair's trial-level row, for stage two's order and the row it writes: not the answers, so a roster of thousands stays small */
    const fitSeen = new Map();
    const noted = (/** @type {any} */ row) => ({ fit: row.fit ?? null, confidence: row.confidence ?? null, updatedAt: row.updatedAt ?? null });
    let consecutiveUpstream = 0;
    let stopped = /** @type {{ code: string, reason: string } | null} */ (null);
    let canceled = false;
    let finished = Number(carried.finished ?? 0);
    let lastProgressAt = Date.now();
    let progressTotal = Number(carried.progressTotal ?? (scenario.fit !== false ? pairs.length : 0));
    let waits = Number(carried.waits ?? 0);
    let judgedThisBatch = 0;
    /** Where the walk stands: the stage, the pass (the second is the one over what failed for a reason that passes) and the position. */
    let at = { stage: 'fit', pass: 0, next: 0, ...object(carried.at) };
    /** @type {number[] | null} stage two's pairs, by position in `pairs` */
    let second = Array.isArray(carried.second) ? carried.second.map(Number) : null;
    /** @type {number[] | null} the second pass's pairs */
    let retrying = Array.isArray(carried.retrying) ? carried.retrying.map(Number) : null;
    /** @type {{ shapes: Record<string, any>, relevant: string[] } | null} */
    let longMeaning = object(carried.longMeaning).relevant ? /** @type {any} */ (carried.longMeaning) : null;
    if (long && !longMeaning) {
      const earlier = await store.one(`SELECT checkpoint -> 'judge' -> 'longMeaning' AS meaning FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'chain' = $2 AND checkpoint -> 'judge' ? 'longMeaning' ORDER BY created_at DESC LIMIT 1`, [studyId, String(scenario.chain ?? '')]).catch(() => null);
      longMeaning = object(earlier?.meaning).relevant ? earlier.meaning : await askLongMeaning({ judge, study, jobId, long, scenario, targetList, targetOf });
      await saveCheckpoint?.({ judge: { ...carried, startedAt, longMeaning } });
    }
    if (long && longMeaning) { await long.setShapes(longMeaning.shapes ?? {}); long.setRelevant(longMeaning.relevant ?? []); }
    const batchEnds = Date.now() + sliceMs;
    let taken = 0;
    let batchOver = false;
    let outage = false;

    const more = async () => {
      if (canceled || stopped || batchOver) return false;
      if (await isCanceled()) { canceled = true; counters.canceled += 1; return false; }
      if (yieldable && (taken >= slicePairs || Date.now() >= batchEnds)) { batchOver = true; return false; }
      return true;
    };
    const account = (/** @type {readonly any[]} */ calls) => {
      const sum = usageOfCalls(calls);
      for (const key of /** @type {const} */ (['calls', 'inputTokens', 'outputTokens', 'cacheHitTokens', 'reasoningTokens'])) used[key] += sum[key];
      used.cost = used.cost === null || sum.cost === null ? null : used.cost + sum.cost;
      used.currency = sum.currency;
      return sum;
    };
    const tick = async () => {
      finished += 1;
      if (finished % 5 === 0 || finished === progressTotal || Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
        lastProgressAt = Date.now();
        await onProgress({ done: finished, total: progressTotal });
      }
    };

    /**
     * One pair in one mode: its ledger row if it has one, otherwise a model call and a row. Whatever goes wrong is this pair's.
     * @param {number} index the pair's position @param {'fit' | 'criteria'} mode
     */
    const judgeOne = async (index, mode) => {
      const pair = pairs[index];
      const pairKey = `${pair.subjectKey}\u0000${pair.targetId}`;
      if (withdrawn.has(pair.subjectKey)) { marks[mode][index] = 'w'; return; }
      const base = { studyId, userId: String(found.userId), subjectKey: pair.subjectKey, targetKind, targetId: pair.targetId, mode, promptVersion: String(promptVersions[mode]), model, thinking, producer: 'job', jobId };
      /** @type {any} */ let note = null;
      /** @type {any} */ let target = null;
      try {
        target = await targetOf(pair.target);
        note = await noteOf(pair.subjectKey);
        const key = judgmentKey({ ...base, targetHash: target.hash, documentHash: note.hash });
        const ledger = done.get(key);
        if (ledger) { marks[mode][index] = 'a'; if (mode === 'fit') fitSeen.set(pairKey, noted(ledger)); consecutiveUpstream = 0; return; }
        const context = { judge, study, jobId, note, target, thinking, cap };
        const settings = { maxTokens: judge.maxTokens, timeoutMs: judge.timeoutMs, ...(note.unreadable ? { unreadableDocuments: note.unreadable } : {}), ...(note.leftOut ? { leftOut: note.leftOut } : {}) };
        const answer = { target: target.summaryOfTarget, eligibilitySource: target.eligibilitySource, ...(note.unreadable ? { unreadableDocuments: note.unreadable } : {}), ...(note.leftOut ? { leftOut: note.leftOut } : {}) };
        /** @type {any} */
        let saved;
        if (mode === 'fit') {
          const { parsed, calls, parts } = await judgeFit(context);
          const usage = account(calls);
          const verdict = trialVerdict({ fit: parsed.fit, missingReasons: parsed.reasons.missing });
          saved = await judgments.save({ ...base, targetHash: target.hash, documentHash: note.hash, status: 'done', fit: parsed.fit, confidence: parsed.confidence, verdict: verdict.verdict,
            answer: { ...answer, reasons: parsed.reasons, issues: parsed.issues, parts }, usage: { ...usage, settings }, documentIds: note.documentIds });
        } else {
          const { parsed, calls, parts } = await judgeCriteria(context);
          const usage = account(calls);
          // The trial-level row of these same words, whichever batch wrote it.
          const scored = fitSeen.get(pairKey) ?? done.get(judgmentKey({ ...base, mode: 'fit', promptVersion: String(promptVersions.fit), targetHash: target.hash, documentHash: note.hash }));
          const verdict = trialVerdict({ fit: scored?.fit ?? null, criteria: parsed.rows, missing: parsed.missing });
          saved = await judgments.save({ ...base, targetHash: target.hash, documentHash: note.hash, status: 'done', fit: scored?.fit ?? null, confidence: scored?.confidence ?? null, verdict: verdict.verdict,
            answer: { ...answer, rows: parsed.rows, missing: parsed.missing, droppedSentenceIds: parsed.droppedSentenceIds, issues: parsed.issues, parts }, usage: { ...usage, settings }, documentIds: note.documentIds });
        }
        consecutiveUpstream = 0;
        judgedThisBatch += 1;
        // Nothing saved means the person withdrew while this was in flight: what was read of them is not put back, and the pair is not reported as judged.
        if (!saved) { marks[mode][index] = 'w'; return; }
        if (mode === 'fit') fitSeen.set(pairKey, noted(saved));
        marks[mode][index] = 'd'; counters.pairsDone += 1;
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code ?? 'vcr_match_judge_failed');
        // What the failing pair already paid for is in the bill: the parts before it, and a cut-off answer's own words.
        const usage = account([...list(/** @type {any} */ (error)?.calls), .../** @type {any} */ (error)?.usage ? [{ usage: /** @type {any} */ (error).usage }] : []]);
        counters.pairsFailed += 1;
        failures[code] = (failures[code] ?? 0) + 1;
        report(code);
        const row = { ...base, targetHash: target?.hash ?? '', documentHash: note?.hash ?? '', status: 'failed', errorCode: code,
          answer: { ...(target ? { target: target.summaryOfTarget } : { target: targetKind === 'candidate_trial' ? { kind: targetKind, id: pair.targetId, registry: pair.target.registry, registryId: pair.targetId } : { kind: targetKind, id: pair.targetId } }) },
          usage, documentIds: note?.documentIds ?? [] };
        await judgments.save(row).catch(() => null);
        marks[mode][index] = transientFailure(error) ? 't' : 'f';
        if (BUDGET_CODES.includes(code)) {
          stopped = { code, reason: code === 'usage_ledger_unavailable' ? '用量账本不可用，停止发起新的调用。' : '预算或额度用完了，已判完的保留。' };
          counters.stopped += 1;
        } else if (transientFailure(error)) {
          consecutiveUpstream += 1;
          if (consecutiveUpstream >= stopAfter) {
            // Waited out while there are waits left: the provider comes back, and nobody has to start this again. Past that the job says so and stops.
            if (yieldable && waits < outageWaits) outage = true;
            else {
              stopped = { code, reason: `模型服务连续 ${consecutiveUpstream} 次没有回答，先停在这里，已判完的保留。` };
              counters.stopped += 1;
            }
          }
        } else consecutiveUpstream = 0;
      } finally {
        await tick().catch(() => {});
      }
    };

    /**
     * Walk a stage from where the walk stands: the pairs in order, then once more the ones that failed for a reason that passes.
     * @param {'fit' | 'criteria'} stage @param {number[]} order @param {(index: number) => Promise<void>} work
     */
    const walk = async (stage, order, work) => {
      if (at.stage !== stage) at = { stage, pass: 0, next: 0 };
      const lanesOver = async (/** @type {number[]} */ items) => {
        const lane = async () => {
          while (at.next < items.length && !outage && await more()) {
            // Another lane may have taken the last one while this one asked.
            if (at.next >= items.length || outage) return;
            const index = items[at.next++];
            taken += 1;
            await work(index);
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, lane));
      };
      if (at.pass === 0) {
        await lanesOver(order);
        if (at.next < order.length) return false;
        retrying = order.filter((index) => marks[stage][index] === 't');
        if (yieldable) progressTotal += retrying.length;
        at = { stage, pass: 1, next: 0 };
      }
      if (at.pass === 1) {
        if (yieldable) await lanesOver(retrying ?? []);
        if (yieldable && at.next < (retrying ?? []).length) return false;
        retrying = null;
        at = { stage, pass: 2, next: 0 };
      }
      return true;
    };

    /** Stage two's pairs, per person the top K by rank; with no stage one, the first K in the order they were named. */
    const secondStage = async () => {
      /** @type {Map<string, number[]>} */
      const bySubject = new Map();
      pairs.forEach((pair, index) => {
        if (withdrawn.has(pair.subjectKey)) return;
        const own = bySubject.get(pair.subjectKey);
        if (own) own.push(index); else bySubject.set(pair.subjectKey, [index]);
      });
      // What an earlier batch learned is in the ledger, and the newest row of a pair is the one its mark speaks for.
      if (carried.marks && scenario.fit !== false) {
        const ledger = await judgments.doneFor({ studyId, promptVersions: [String(promptVersions.fit)], model, thinking, subjectKeys: subjects.length <= 1000 ? subjects : null });
        for (const row of ledger.values()) {
          if (row.mode !== 'fit') continue;
          const key = `${row.subjectKey}\u0000${row.targetId}`;
          const heldRow = fitSeen.get(key);
          if (!heldRow || String(row.updatedAt ?? '') > String(heldRow.updatedAt ?? '')) fitSeen.set(key, noted(row));
        }
      }
      const topK = scenario.topK;
      /** @type {number[]} */
      const chosen = [];
      for (const [subjectKey, own] of bySubject) {
        /** @type {number[]} */
        let ranked = own;
        if (scenario.fit !== false) {
          // A trial with no clauses has nothing for this stage to ask and takes no one's place in the top K.
          const judged = [];
          for (const index of own) {
            if (!['d', 'a'].includes(marks.fit[index])) continue;
            const row = fitSeen.get(`${subjectKey}\u0000${pairs[index].targetId}`);
            if (!row) continue;
            const target = await targetOf(pairs[index].target).catch(() => null);
            if (target?.clauses.length) judged.push({ id: pairs[index].targetId, fit: row.fit, confidence: row.confidence, index });
          }
          ranked = rankJudgments(judged).map((row) => row.index);
        }
        chosen.push(...(topK === 'all' ? ranked : ranked.slice(0, Number(topK))));
      }
      return chosen;
    };

    // Stage one: every pair, trial-level.
    let walked = true;
    if (at.stage === 'fit' && scenario.fit !== false) walked = await walk('fit', pairs.map((_, index) => index), (index) => judgeOne(index, 'fit'));

    // Stage two: per person, the top K by rank, clause by clause.
    const topK = scenario.topK;
    if (walked && topK !== 0 && !stopped && !canceled) {
      if (!second) {
        second = await secondStage();
        progressTotal += second.length;
      }
      walked = await walk('criteria', second, async (index) => {
        // A trial whose record has no eligibility text has no clauses to judge: it is judged on what it has, which a job with no stage one asks here.
        const target = await targetOf(pairs[index].target).catch(() => null);
        if (target && !target.clauses.length) {
          marks.criteria[index] = 'n';
          await judgeOne(index, 'fit');
          return;
        }
        await judgeOne(index, 'criteria');
      });
    }

    if (judgedThisBatch > 0) waits = 0;
    // A turn given back, or a wait for a provider that is down: everything needed to go on is in the checkpoint, and the queue claims it again.
    if (yieldable && !stopped && !canceled && (outage || batchOver || !walked)) {
      await onProgress({ done: finished, total: progressTotal, ...(outage ? { note: '模型服务暂时没有回答，等一会儿自动接着判定。' } : {}) }).catch(() => {});
      const afterSeconds = outage ? Math.min(1_800, 120 * 2 ** waits) : 0;
      return { yield: { afterSeconds, checkpoint: { judge: { startedAt, at, marks: { fit: marks.fit.join(''), criteria: marks.criteria.join('') }, ...(second ? { second } : {}), ...(retrying ? { retrying } : {}), ...(longMeaning ? { longMeaning } : {}),
        used, failures, finished, progressTotal, waits: outage ? waits + 1 : waits } } } };
    }

    const standing = (/** @type {number} */ index) => !withdrawn.has(pairs[index].subjectKey);
    const positions = pairs.map((_, index) => index).filter(standing);
    const judgedAt = (/** @type {number} */ index) => ['d', 'a'].includes(marks.fit[index]) || ['d', 'a'].includes(marks.criteria[index]);
    const failedAt = (/** @type {number} */ index) => ['f', 't'].includes(marks.fit[index]) || ['f', 't'].includes(marks.criteria[index]);
    const total = positions.length;
    const finishedPairs = positions.filter(judgedAt).length;
    const failedPairs = positions.filter((index) => !judgedAt(index) && failedAt(index)).length;
    const remaining = Math.max(0, total - finishedPairs - failedPairs);
    const tallyOf = (/** @type {'fit' | 'criteria'} */ mode, /** @type {number} */ asked) => ({
      done: marks[mode].filter((mark) => mark === 'd').length, already: marks[mode].filter((mark) => mark === 'a').length, failed: marks[mode].filter((mark) => mark === 'f' || mark === 't').length, total: asked,
    });
    const stages = { fit: tallyOf('fit', scenario.fit !== false ? pairs.filter((pair) => !withdrawn.has(pair.subjectKey)).length : marks.criteria.filter((mark) => mark === 'n').length), criteria: tallyOf('criteria', (second?.length ?? 0) - marks.criteria.filter((mark) => mark === 'n').length) };
    await onProgress({ done: finished, total: progressTotal });

    const scenarioHash = /^[a-f0-9]{64}$/.test(String(job.scenarioHash ?? '')) ? String(job.scenarioHash) : createHash('sha256').update(canonicalScenarioJson(scenario)).digest('hex');
    // Everyone on the frozen roster having withdrawn since is a job that judged nobody, not a clean one.
    const outcome = total ? resultOutcome({ finished: finishedPairs, total, failed: failedPairs + stages.criteria.failed, stopped: Boolean(stopped) || canceled, failures, noun: '对', verb: '判定' })
      : { status: 'failed', conclusion: 'not_estimable', issues: [{ code: 'vcr_match_nothing_finished', message: '这一批的受试者都已撤回同意，没有可判定的。' }] };
    const changes = scenario.followUp && judgments.list ? judgmentChanges(await judgments.list({ studyId, subjectKey: frozenSubjects.length === 1 ? frozenSubjects[0] : null }).catch(() => [])) : null;
    /** @type {Record<string, any>} */
    const result = {
      jobId, protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: outcome.status, method: 'matching.judge', methodVersion: VCR_MATCH_BATCH_METHODS['matching.judge'].version,
      scenarioHash, seed: Number(job.seed ?? 0), replicates: null, conclusion: outcome.conclusion,
      counts: { realPatients: subjects.length, events: null, effectiveSampleSize: null, generatedRecords: 0 },
      measures: [
        { name: 'pairs_finished', value: finishedPairs }, { name: 'pairs_total', value: total }, { name: 'pairs_failed', value: failedPairs },
        { name: 'criteria_pairs_finished', value: stages.criteria.done + stages.criteria.already }, { name: 'criteria_pairs_total', value: stages.criteria.total },
      ].map((measure) => ({ ...measure, simulated: false, source: 'calculated' })),
      diagnostics: {
        ...(outcome.issues.length ? { issues: outcome.issues } : {}),
        direction, ...(scenario.protocolVersionId ? { protocolVersionId: String(scenario.protocolVersionId) } : {}), chain: scenario.chain ?? null,
        finished: finishedPairs, total, failed: failedPairs, remaining, canceled, stages,
        ...(Object.keys(failures).length ? { failures } : {}), ...(stopped ? { stopped } : {}), ...(skippedWithdrawn ? { skippedWithdrawn } : {}),
        ...(changes ? { changes: { ...changes, followUp: scenario.followUp } } : {}),
        // What was stated before the work and what it came to.
        estimate: object(scenario.estimate), used: { ...used, model, thinking },
        settings: { model, thinking, concurrency: width, maxTokens: judge.maxTokens, timeoutMs: judge.timeoutMs, fit: scenario.fit !== false, topK },
      },
      tables: [],
      manifest: { engineVersion: 'control-plane', rVersion: `node ${process.version}`, packageLockHash: LOCK_HASH, startedAt, finishedAt: now().toISOString(), cpuSeconds: 0 },
    };
    result.manifest.outputHash = createHash('sha256').update(vcrResultOutputPayload(result)).digest('hex');
    return result;
  };
}

/**
 * What re-judging changed: for each pair, the verdict of the newest words read against the verdict of the words before them. Rows are never overwritten by a re-judgment (the key
 * holds the hashes), so the earlier one is still there to compare. A pair's verdict is its clause-level row's when it has one, its trial-level row's otherwise.
 * @param {ReadonlyArray<any>} rows light rows, any order
 * @returns {{ compared: number, changed: number, pairs: Array<{ subjectKey: string, targetId: string, from: string, to: string }>, sentence: string }}
 */
export function judgmentChanges(rows) {
  /** @type {Map<string, Map<string, { at: string, fit?: any, criteria?: any }>>} */
  const byPair = new Map();
  for (const row of rows) {
    if (row.status !== 'done' || !row.verdict) continue;
    const pair = `${row.subjectKey}\u0000${row.targetKind}\u0000${row.targetId}`;
    const reading = `${row.documentHash}\u0000${row.targetHash}`;
    const readings = byPair.get(pair) ?? new Map();
    byPair.set(pair, readings);
    const entry = readings.get(reading) ?? { at: '' };
    readings.set(reading, entry);
    /** @type {any} */ (entry)[row.mode] = row;
    if (String(row.updatedAt ?? '') > entry.at) entry.at = String(row.updatedAt ?? '');
  }
  /** @type {Array<{ subjectKey: string, targetId: string, from: string, to: string }>} */
  const pairs = [];
  let compared = 0;
  for (const readings of byPair.values()) {
    const ordered = [...readings.values()].sort((a, b) => b.at.localeCompare(a.at));
    if (ordered.length < 2) continue;
    compared += 1;
    const verdictOf = (/** @type {any} */ entry) => (entry.criteria ?? entry.fit);
    const now_ = verdictOf(ordered[0]), before_ = verdictOf(ordered[1]);
    if (now_.verdict !== before_.verdict) pairs.push({ subjectKey: now_.subjectKey, targetId: now_.targetId, from: VCR_TRIAL_VERDICT_LABELS_ZH[/** @type {keyof typeof VCR_TRIAL_VERDICT_LABELS_ZH} */ (before_.verdict)] ?? before_.verdict, to: VCR_TRIAL_VERDICT_LABELS_ZH[/** @type {keyof typeof VCR_TRIAL_VERDICT_LABELS_ZH} */ (now_.verdict)] ?? now_.verdict });
  }
  return { compared, changed: pairs.length, pairs: pairs.slice(0, 50), sentence: compared ? (pairs.length ? `重算后 ${pairs.length} 个试验结论变化。` : `重算了 ${compared} 个试验，结论都没有变化。`) : '' };
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

/**
 * What the platform does when a judging job is asked for: plan it, say it, queue it. Nothing waits on an answer.
 * @param {{ jobs: any, matchStore: any, documents: any, subjectTable?: any, config: Record<string, any>, counters?: ReturnType<typeof createMatchJudgeCounters> }} deps
 */
export function createMatchJudge({ jobs, matchStore, documents, subjectTable = null, judgments = null, config, counters = createMatchJudgeCounters() }) {
  return {
    /** @param {any} study @param {unknown} selection @param {{ actor?: string, followUp?: Record<string, any> | null }} [options] */
    async start(study, selection, { actor = 'runtime', followUp = null } = {}) {
      if (!jobs?.enqueue) throw new HttpError(503, 'vcr_gateway_unavailable', '作业队列未接入本部署：判定暂不可用，其余步骤照常。');
      const built = await planMatchJudge({ study, selection, matchStore, documents, subjectTable, config });
      if (built.ok !== true) throw new HttpError(409, 'vcr_match_judge_nothing_to_read', String(/** @type {any} */ (built).message));
      counters.started += 1;
      // A re-judgment is its own job even for the same selection: it follows a named change, and the words read are newer than whatever is still running.
      const scenario = followUp ? (() => { const { chain: _chain, ...rest } = built.scenario; return { ...rest, followUp, chain: judgeChain({ ...rest, followUp }) }; })() : built.scenario;
      const summary = { statement: built.statement, estimate: scenario.estimate, direction: scenario.direction, topK: scenario.topK, fit: scenario.fit, thinking: scenario.thinking,
        ...(scenario.protocolVersionId ? { protocolVersionId: scenario.protocolVersionId } : {}) };
      // The same selection asked for again while it is out is that job; one that has ended is a new attempt, and the ledger keeps it from paying twice.
      const same = await jobs.store?.rows?.(`SELECT id, state FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'match_judge' AND scenario ->> 'chain' = $2 ORDER BY created_at`, [study.id, scenario.chain]) ?? [];
      const open = same.find((/** @type {any} */ entry) => ['queued', 'running', 'awaiting_budget'].includes(String(entry.state)));
      if (open) return { action: 'start', kind: 'match_judge', state: String(open.state), jobId: String(open.id), alreadyRunning: true, ...summary };
      const { job } = await jobs.enqueue({
        studyId: study.id, userId: study.userId, kind: 'match_judge', scenario, inputs: [], internal: true, runId: study.executionOrigin?.runId ?? null,
        cpuSecondsLimit: 60, maxAttempts: 5, idempotencyKey: `vcr:${study.id}:judge:${scenario.chain}:g${same.length}`,
        detail: { origin: actor, ...(scenario.protocolVersionId ? { protocolVersionId: scenario.protocolVersionId } : {}), principal: study.userId,
          ...(study.cloudContext ? { cloudContext: { runId: String(study.cloudContext.runId), sessionId: String(study.cloudContext.sessionId) } } : {}),
          ...(study.completionOrigin ? { conversationOrigin: study.completionOrigin } : {}) },
      });
      return { action: 'start', kind: 'match_judge', state: job.state, jobId: job.id, ...summary };
    },

    /**
     * Judge again what this person already has a verdict on, because something they rest on changed: a later note, a new fact, a registry record. Through the same job, so the ledger
     * pays only for what is new: a new `documentHash` or target hash is a new row, and the earlier row stays readable as history. A person with no verdict has nothing to redo: null.
     * Trials and protocol versions are separate jobs, because a job has one direction.
     * @param {any} study
     * @param {{ subjectKey: string, reason?: string, documentId?: string | null, targetIds?: readonly string[] | null, actor?: string }} input
     * @returns {Promise<{ jobs: any[], statement: string } | null>}
     */
    async rejudge(study, { subjectKey, reason = 'follow_up', documentId = null, targetIds = null, actor = 'runtime' }) {
      if (!judgments?.list) return null;
      const rows = (await judgments.list({ studyId: study.id, subjectKey })).filter((/** @type {any} */ row) => row.status === 'done' && (!targetIds || targetIds.includes(row.targetId)));
      if (!rows.length) return null;
      /** @type {Map<string, { kind: string, targetId: string, target: any, modes: Set<string>, thinking: string }>} */
      const byTarget = new Map();
      for (const row of rows) {
        const entry = byTarget.get(row.targetId) ?? { kind: row.targetKind, targetId: row.targetId, target: row.target ?? {}, modes: new Set(), thinking: row.thinking };
        entry.modes.add(row.mode);
        byTarget.set(row.targetId, entry);
      }
      const followUp = { reason, ...(documentId ? { documentId } : {}), at: new Date().toISOString() };
      const asked = (/** @type {any[]} */ entries) => {
        const clauses = entries.filter((entry) => entry.modes.has('criteria')).length;
        const fit = entries.some((entry) => entry.modes.has('fit'));
        const thinking = ['high', 'off'].includes(entries[0].thinking) ? { thinking: entries[0].thinking } : {};
        return { fit, topK: !fit || clauses === entries.length ? 'all' : clauses, ...thinking };
      };
      const started = [];
      const trials = [...byTarget.values()].filter((entry) => entry.kind === 'candidate_trial');
      /** A frozen collection is one job per collection; a live trial is read as it stands today. @type {Map<string, any[]>} */
      const groups = new Map();
      for (const entry of trials) {
        const collection = object(entry.target.collection);
        const key = collection.name ? `${collection.name}\u0000${collection.revision ?? ''}` : '';
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      for (const [key, entries] of groups) {
        const [collection, collectionRevision] = key ? key.split('\u0000') : [];
        started.push(await this.start(study, { direction: 'patient_to_trial', subjectKey, registryIds: entries.map((entry) => entry.targetId), ...(key ? { collection, collectionRevision } : {}), ...asked(entries) }, { actor, followUp }));
      }
      for (const entry of [...byTarget.values()].filter((row) => row.kind === 'protocol_version')) {
        started.push(await this.start(study, { direction: 'trial_to_patient', protocolVersionId: entry.targetId, subjectKeys: [subjectKey], ...asked([entry]) }, { actor, followUp }));
      }
      return { jobs: started, statement: `这位患者已有 ${byTarget.size} 个判定，正在按新内容重算，已有结论保留为历史；算完会说明哪些结论变了。` };
    },
  };
}

// ---------------------------------------------------------------------------
// Reading what was saved, and the conversation's own writes
// ---------------------------------------------------------------------------

/** The newest finished row of a pair and mode, or its newest failure. @param {readonly any[]} rows */
function newest(rows) {
  return rows.find((row) => row.status === 'done') ?? rows[0] ?? null;
}

/**
 * One pair as a reader sees it: the verdict computed from what is stored, the reasons, and each clause with its plain label and its evidence.
 * @param {any} fit the pair's `fit` row, or null @param {any} criteria the pair's `criteria` row, or null
 */
export function presentJudgment(fit, criteria) {
  const usable = (/** @type {any} */ row) => (row?.status === 'done' ? row : null);
  const scored = usable(fit), clauses = usable(criteria);
  const rows = list(clauses?.answer?.rows);
  const missing = list(clauses?.answer?.missing);
  const reasons = object(scored?.answer?.reasons);
  const judged = trialVerdict({ fit: scored?.fit ?? clauses?.fit ?? null, criteria: clauses ? rows : null, missing: clauses ? missing : null, missingReasons: list(reasons.missing) });
  const newestOf = clauses && scored ? ((clauses.updatedAt ?? '') > (scored.updatedAt ?? '') ? clauses : scored) : clauses ?? scored;
  const anchor = newestOf ?? fit ?? criteria;
  const basisChanged = scored?.basisChanged ?? clauses?.basisChanged ?? null;
  return {
    id: anchor.id, subjectKey: anchor.subjectKey, target: object(anchor.answer?.target).id ? anchor.answer.target : { kind: anchor.targetKind, id: anchor.targetId },
    verdict: judged.verdict, verdictLabel: VCR_TRIAL_VERDICT_LABELS_ZH[judged.verdict], fit: scored?.fit ?? clauses?.fit ?? null, confidence: scored?.confidence ?? clauses?.confidence ?? null,
    reasons: { eligible: list(reasons.eligible), ineligible: list(reasons.ineligible), missing: list(reasons.missing), rationale: String(reasons.rationale ?? '') },
    criteria: rows.map((row) => ({ ...row, display: criterionDisplay(row) })),
    missingClauses: missing,
    eligibilitySource: anchor.answer?.eligibilitySource ?? null,
    producer: anchor.producer, model: anchor.model, thinking: anchor.thinking, judgedAt: anchor.updatedAt,
    ...(basisChanged ? { basisChanged } : {}),
    ...(isRegistryMark(basisChanged) && anchor.targetKind === 'candidate_trial' ? { rejudge: { reason: REGISTRY_RECORD_BASIS, label: '重新判定', subjectKey: anchor.subjectKey, registryIds: [anchor.targetId] } } : {}),
  };
}

/** Whether a row's `basisChanged` is the registry watch's mark: the record the verdict was made of has changed since. @param {any} basisChanged */
const isRegistryMark = (basisChanged) => basisChanged?.kind === REGISTRY_RECORD_BASIS;

/**
 * Reading the judgments of a study and writing the conversation's: the `ranking` of `vcr_read`, the numbered sentences a conversation reads a record through,
 * and the writer behind `vcr_write what: "trial_judgment"`.
 *
 * A person's trials whose record has changed since they were judged (the registry watch's mark) are offered for judging again (`rejudge`); in an attended conversation
 * they are judged again at once through `rejudge.rejudge` (the judging job, `createMatchJudge`), once per half hour for the same trials, and the old rows stay in the read, marked.
 *
 * @param {{ judgments: any, documents: any, subjectTable?: any, targets: ReturnType<typeof judgmentTargets>, matchStore: any, windowChars?: number,
 *   rejudge?: { rejudge?: (study: any, input: { subjectKey: string, reason: string, targetIds: string[] }) => Promise<{ jobId: string } | null> } | null,
 *   report?: (code: string) => void, now?: () => Date }} deps
 */
export function createMatchJudgmentReads({ judgments, documents, subjectTable = null, targets, matchStore, windowChars = 20_000, rejudge = null, report = () => {}, now = () => new Date() }) {
  /** @param {any} study @param {string} subjectKey */
  const noteFor = async (study, subjectKey) => {
    const roster = (await documents.roster(study)).filter((/** @type {any} */ row) => String(row.subjectKey) === subjectKey);
    return readSubjectNote({ study, subjectKey, documents, roster, table: await tableFieldsOf(subjectTable, study), long: await documents.longTables?.(study).catch(() => null) ?? null });
  };

  /** Evidence is sent back out only from what the cloud may read now, as every other quote is (`runtimeEvidence`). @param {any} study @param {any} presented */
  const projected = async (study, presented) => {
    const items = presented.criteria.flatMap((/** @type {any} */ row) => list(row.evidence).map((item) => ({ ...item, number: row.number, quote: item.text, ...(item.source ? { source: item.source } : {}) })));
    if (!items.length) return presented;
    const kept = documents?.runtimeEvidence ? await documents.runtimeEvidence(study, items, presented.subjectKey).catch(() => []) : [];
    const stands = new Set(list(kept).map((item) => `${item.number}:${item.sentenceId}`));
    return { ...presented, criteria: presented.criteria.map((/** @type {any} */ row) => {
      const evidence = list(row.evidence).filter((item) => stands.has(`${row.number}:${item.sentenceId}`));
      return evidence.length === list(row.evidence).length ? row : { ...row, evidence, evidenceWithheld: list(row.evidence).length - evidence.length };
    }) };
  };

  /** The rows of one read, a pair at a time, with the newest finished row of each mode. @param {readonly any[]} rows */
  const pairsOf = (rows) => {
    /** @type {Map<string, { fit: any[], criteria: any[] }>} */
    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.subjectKey}\u0000${row.targetKind}\u0000${row.targetId}`;
      const entry = grouped.get(key) ?? { fit: [], criteria: [] };
      /** @type {any} */ (entry)[row.mode].push(row);
      grouped.set(key, entry);
    }
    const pairs = [];
    const failed = [];
    for (const { fit, criteria } of grouped.values()) {
      const scored = newest(fit), clauses = newest(criteria);
      if (scored?.status === 'done' || clauses?.status === 'done') {
        const usableFit = scored?.status === 'done' ? scored : null, usableCriteria = clauses?.status === 'done' ? clauses : null;
        pairs.push({ fitRow: usableFit, criteriaRow: usableCriteria, subjectKey: (usableFit ?? usableCriteria).subjectKey, targetId: (usableFit ?? usableCriteria).targetId,
          fit: usableFit?.fit ?? usableCriteria?.fit ?? null, confidence: usableFit?.confidence ?? usableCriteria?.confidence ?? null,
          // What an order needs of a clause row is whether it states a disqualifier, and the store says so without reading the answer out.
          criteria: usableCriteria?.disqualified ? [{ label: 'excluded', basis: 'stated' }] : [] });
      } else {
        const row = scored ?? clauses;
        failed.push({ subjectKey: row.subjectKey, target: object(row.target).id ? row.target : { kind: row.targetKind, id: row.targetId }, code: row.errorCode, at: row.updatedAt });
      }
    }
    return { pairs, failed };
  };

  /** @param {any} study @param {{ subjectKey?: string | null, targetKind?: string | null, targetId?: string | null, limit: number, offset: number, order: 'target' | 'subject' }} input */
  const read = async (study, { subjectKey = null, targetKind = null, targetId = null, limit, offset, order }) => {
    const { pairs, failed } = pairsOf(await judgments.list({ studyId: study.id, subjectKey, targetKind, targetId }));
    const ranked = rankJudgments(pairs.map((pair) => ({ ...pair, id: order === 'target' ? pair.targetId : pair.subjectKey })));
    const page = ranked.slice(offset, offset + limit);
    const whole = new Map((await judgments.byIds(study.id, page.flatMap((pair) => [pair.fitRow?.id, pair.criteriaRow?.id].filter(Boolean)))).map((/** @type {any} */ row) => [row.id, row]));
    const presented = page.flatMap((pair) => {
      const fit = pair.fitRow ? whole.get(pair.fitRow.id) ?? null : null, criteria = pair.criteriaRow ? whole.get(pair.criteriaRow.id) ?? null : null;
      return fit || criteria ? [presentJudgment(fit, criteria)] : [];
    });
    // The trials of this person whose verdict rests on a record that has since changed, whatever page they are on: one action judges them again.
    const stale = order === 'target' && subjectKey
      ? ranked.filter((pair) => isRegistryMark(pair.fitRow?.basisChanged) || isRegistryMark(pair.criteriaRow?.basisChanged)).map((pair) => String(pair.targetId)).slice(0, VCR_MATCH_JUDGE_LIMITS.trials) : [];
    return { ranking: await Promise.all(presented.map((row) => projected(study, row))), finished: ranked.length, failedPairs: failed.length, ...(failed.length ? { failed: failed.slice(0, 50) } : {}), more: ranked.length > offset + limit,
      ...(stale.length ? { rejudge: { reason: REGISTRY_RECORD_BASIS, label: '登记记录已更新，可重新判定', subjectKey, registryIds: stale } } : {}) };
  };

  /** The auto-started re-judgments of the last half hour, by study, person and trials: a read does not start the same job again, and says which one is out. @type {Map<string, { at: number, jobId: string }>} */
  const started = new Map();
  const COOLDOWN_MS = 30 * 60_000;
  /**
   * A conversation that asks for a person's trials whose records have changed gets them judged again without being asked (an attended turn only: a page and an unattended
   * run read what was saved). A failure is quiet: the read it was part of is the old rows, as before.
   * @param {any} study @param {string} subjectKey @param {string[]} registryIds
   */
  const startRejudge = async (study, subjectKey, registryIds) => {
    const key = [study.id, subjectKey, ...[...registryIds].sort()].join('\u0000');
    const at = now().getTime();
    const held = started.get(key);
    if (held && at - held.at < COOLDOWN_MS) return { jobId: held.jobId };
    try {
      const job = await rejudge?.rejudge?.(study, { subjectKey, reason: REGISTRY_RECORD_BASIS, targetIds: registryIds });
      if (!job?.jobId) return null;
      if (started.size >= 500) for (const [old, entry] of started) if (at - entry.at >= COOLDOWN_MS) started.delete(old);
      started.set(key, { at, jobId: String(job.jobId) });
      return { jobId: String(job.jobId) };
    } catch (error) {
      report(String(/** @type {any} */ (error)?.code ?? 'vcr_rejudge_failed'));
      return null;
    }
  };

  return {
    /** A person's trials from the saved judgments. An empty `ranking` is the caller's cue to say what it held before. @param {any} study @param {string} subjectKey @param {{ limit?: number, offset?: number }} [page] */
    forSubject: async (study, subjectKey, { limit = 20, offset = 0 } = {}) => {
      const answer = await read(study, { subjectKey, limit, offset, order: 'target' });
      const offered = /** @type {{ registryIds: string[] } | undefined} */ (answer.rejudge);
      if (!offered || !study?.completionOrigin || !rejudge?.rejudge) return answer;
      const job = await startRejudge(study, subjectKey, offered.registryIds);
      return job ? { ...answer, rejudging: job } : answer;
    },
    /** The ids of a person's trials whose verdicts rest on a record that has changed: what the page's one action judges again. @param {any} study @param {string} subjectKey */
    async staleTargets(study, subjectKey) {
      return (await read(study, { subjectKey, limit: 1, offset: 0, order: 'target' })).rejudge?.registryIds ?? [];
    },
    /** A protocol version's people from the saved judgments. @param {any} study @param {string} protocolVersionId @param {{ subjectKey?: string | null, limit?: number, offset?: number }} [page] */
    forProtocol: (study, protocolVersionId, { subjectKey = null, limit = 20, offset = 0 } = {}) => read(study, { subjectKey, targetKind: 'protocol_version', targetId: protocolVersionId, limit, offset, order: 'subject' }),

    /** A protocol version's numbered clauses, for a conversation that judges by itself. @param {any} study @param {string} protocolVersionId */
    async protocolClauses(study, protocolVersionId) {
      const target = await targets.protocol({ study, protocolVersionId }).catch(() => null);
      return target ? target.clauses.map((/** @type {any} */ clause) => ({ number: clause.number, kind: clause.kind, text: clause.text })) : [];
    },

    /**
     * A person's record as numbered sentences, a window at a time, with the hash that binds a later write to these same numbers.
     * @param {any} study @param {{ subjectKey?: string, offset?: number, limit?: number }} filter
     */
    async sentences(study, filter) {
      if (!filter.subjectKey) return { available: false, code: 'vcr_read_filter_invalid', message: '读编号句子要写 subjectKey。' };
      const subjectKey = String(filter.subjectKey);
      if ((await matchStore.withdrawnSubjects?.(study.id) ?? new Set()).has(subjectKey)) return { available: false, code: 'vcr_document_withdrawn', message: '这位受试者已撤回同意，文本已清除。' };
      let note;
      try { note = await noteFor(study, subjectKey); }
      catch (error) {
        const code = String(/** @type {any} */ (error)?.code ?? 'vcr_projection_unavailable');
        return { available: false, code, message: code === 'vcr_match_no_patient_text' ? '这位受试者没有可读的病历或表格。' : '这份病历现在不能交给云端模型读取；其他工作可以继续。' };
      }
      const offset = Math.max(0, Number(filter.offset ?? 0));
      const limit = Math.max(1, Number(filter.limit ?? 500));
      const page = [];
      let chars = 0;
      for (const sentence of note.sentences.slice(offset, offset + limit)) {
        if (page.length && chars + sentence.text.length > windowChars) break;
        page.push(sentence);
        chars += sentence.text.length;
      }
      /** @type {Map<string, { start: number, end: number }>} */
      const served = new Map();
      for (const sentence of page) {
        if (!sentence.documentId) continue;
        const span = served.get(sentence.documentId) ?? { start: sentence.start, end: sentence.end };
        span.end = Math.max(span.end, sentence.end);
        served.set(sentence.documentId, span);
      }
      for (const [documentId, span] of served) {
        const text = note.records.find((/** @type {any} */ record) => record.documentId === documentId)?.text;
        if (text != null) await documents.recordWindow?.(study, documentId, text, span.start, span.end);
      }
      const next = offset + page.length;
      return { available: true, subjectKey, documentHash: note.hash, sentences: page.map((sentence) => ({ id: sentence.id, text: sentence.text, ...(sentence.page ? { page: sentence.page } : {}), ...(sentence.documentId ? { documentId: sentence.documentId } : { fromTable: true }) })),
        sentencesTotal: note.sentences.length, offset, more: next < note.sentences.length, ...(next < note.sentences.length ? { nextOffset: next } : {}), ...(note.unreadable ? { unreadableDocuments: note.unreadable } : {}) };
    },

    /**
     * One item of `vcr_write what: "trial_judgment"`: the same parsers as the job, the same rows, producer `conversation`. What code cannot use in an answer (a clause
     * number that does not exist, a sentence id, a label outside the list) comes back as a notice beside what was saved; nothing clinical refuses it.
     * @param {any} study
     * @param {{ subjectKey: string, registry?: string, registryId?: string, collection?: string | null, collectionRevision?: string | null, protocolVersionId?: string, fit?: number | null, confidence?: number | null, reasons?: any, criteria?: any[], documentHash?: string }} item
     * @param {{ signal?: AbortSignal }} [options]
     */
    async writeConversation(study, item, { signal } = {}) {
      const direction = item.registryId ? 'candidate_trial' : 'protocol_version';
      const target = direction === 'candidate_trial'
        ? await targets.trial({ userId: String(study.userId), registry: String(item.registry ?? registryOfId(String(item.registryId))), registryId: String(item.registryId), collection: item.collection ?? null, collectionRevision: item.collectionRevision ?? null, signal })
        : await targets.protocol({ study, protocolVersionId: String(item.protocolVersionId) });
      const note = await noteFor(study, item.subjectKey);
      if (item.documentHash && item.documentHash !== note.hash) throw failure('vcr_match_note_changed', '这份病历在读取之后变了，句子编号已不对应：重新读一次 sentences 再写。');
      const base = { studyId: study.id, userId: String(study.userId), subjectKey: item.subjectKey, targetKind: direction, targetId: target.id, targetHash: target.hash, documentHash: note.hash,
        model: '', thinking: '', producer: 'conversation', jobId: null, documentIds: note.documentIds };
      const answer = { target: target.summaryOfTarget, eligibilitySource: target.eligibilitySource };
      /** @type {any[]} */ const notices = [];
      /** @type {any} */ let fitRow = null, criteriaRow = null;
      const reasons = object(item.reasons);
      /** @type {ReturnType<typeof parseFitAnswer> | null} */
      let fit = null;
      if (item.fit != null) {
        fit = parseFitAnswer({ score: item.fit, confidence: item.confidence ?? null, eligible_reasons: reasons.eligible, ineligible_reasons: reasons.ineligible, missing_information: reasons.missing, rationale: reasons.rationale });
        notices.push(...fit.issues);
        const verdict = trialVerdict({ fit: fit.fit, missingReasons: fit.reasons.missing });
        fitRow = await judgments.save({ ...base, mode: 'fit', promptVersion: 'conversation', status: 'done', fit: fit.fit, confidence: fit.confidence, verdict: verdict.verdict, answer: { ...answer, reasons: fit.reasons, issues: fit.issues } });
      }
      /** @type {Record<string, any> | null} */
      let verdict = fit ? trialVerdict({ fit: fit.fit, missingReasons: fit.reasons.missing }) : null;
      if (list(item.criteria).length) {
        const parsed = parseCriteriaAnswer(item.criteria, { criteria: target.clauses, sentences: note.sentences });
        notices.push(...parsed.issues);
        if (parsed.rows.length) {
          verdict = trialVerdict({ fit: fit?.fit ?? null, criteria: parsed.rows, missing: parsed.missing });
          criteriaRow = await judgments.save({ ...base, mode: 'criteria', promptVersion: 'conversation', status: 'done', fit: fit?.fit ?? null, confidence: fit?.confidence ?? null, verdict: verdict.verdict,
            answer: { ...answer, rows: parsed.rows, missing: parsed.missing, droppedSentenceIds: parsed.droppedSentenceIds, issues: parsed.issues } });
        }
        if (parsed.missing.length) notices.push({ code: 'clauses_not_answered', numbers: parsed.missing.map((clause) => clause.number) });
      }
      const saved = criteriaRow ?? fitRow;
      return { id: saved?.id ?? null, verdict: verdict?.verdict ?? null, ...(verdict ? { verdictLabel: VCR_TRIAL_VERDICT_LABELS_ZH[/** @type {keyof typeof VCR_TRIAL_VERDICT_LABELS_ZH} */ (verdict.verdict)] } : {}), target: target.summaryOfTarget, notices };
    },
  };
}
