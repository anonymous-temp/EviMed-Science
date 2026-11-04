/**
 * Batch matching on the control plane (remediation plan D4, 2026-11-01): the patient records of a roster are read for the facts the
 * protocol's criteria ask about, one record at a time, in a job of their own, instead of crowding into one conversation turn.
 *
 * What it is made of, all of it already there:
 *
 * - the **job queue and its local lane** (`match_extract` is a local method; it runs on its own worker loop because it calls a model
 *   per record and a long job must not hold the short local jobs behind it);
 * - the **model gateway** (`callModelForControlPlane`, purpose `vcr`, reserve-then-settle in the usage ledger: no second model client);
 * - the **fact writer** (`vcrRuntimeWrite`, `what: "fact"`): a fact proposed here is verified against the record's own bytes, located,
 *   checked for the negation-on-another-fact's-words case and saved exactly as a fact a conversation writes, and stands under the same
 *   evaluator; the model proposes, the writer decides;
 * - the **cloud reader** (`documents.runtimeRead`): a record reaches a model only under the source's cloud basis, audited with it.
 *
 * Hidden knowledge:
 *
 * - **Resume is the ledger, not the job.** A record read for these questions has a row in `matching_extractions`; a later job, a
 *   re-claimed one after a worker died, or a fresh start after a cancel skips it. Nothing is recomputed because nothing remembers
 *   where a job got to except that table. A record that failed has no row and is read again.
 * - **Cancel is a check between records.** `isCanceled` is asked before each record is taken; a record in flight is finished and
 *   written (its facts and ledger row), so what was paid for is kept. A canceled or crashed job leaves every finished record's facts.
 * - **The questions are the criteria's variables the table does not already answer.** A study that arrived as a cohort table has its
 *   age, sex and coded fields in columns; the model is asked only for what the columns do not hold (`subjectTableFacts` says which).
 * - **The estimate is stated before, and it is a ceiling.** `plan` is computed from the roster's lengths without reading a record;
 *   what was actually read, in tokens, comes back in the result.
 * - **Reading and judging are two jobs and the conversation joins them.** The reading's completion goes back to the conversation that
 *   asked for it (finished, partly finished, canceled or failed alike), and the model then starts the ordinary `match_criteria` over
 *   the same roster: the evaluator freezes the facts that exist at that moment, so what a stopped reading did write is judged too, and
 *   the people it did not reach are `unknown` -- never excluded.
 *
 * @module vcrMatchBatch
 */

import { createHash } from 'node:crypto';
import {
  VCR_ENGINE_PROTOCOL_VERSION, VCR_MATCH_BATCH_DEFAULT_MODEL, VCR_MATCH_BATCH_LIMITS, VCR_MATCH_BATCH_METHODS, VCR_MIN_CELL_SIZE, acceptExtractedFacts,
  canonicalScenarioJson, matchBatchStatement, matchBatchUnitKey, planMatchExtraction, vcrResultOutputPayload,
} from '@evimed/domain';
import { HttpError } from './security.mjs';
import { callModelForControlPlane } from './modelGateway.mjs';
import { assessSubject, frozenAsOf, ambiguousCriterionLanguageKeys } from './vcrMatching.mjs';
import { languageCriteriaByKey } from './vcrMatchingSnapshot.mjs';
import { columnReadsPresence, matchingVariablesOf, presenceVariablesOf, subjectTableFacts } from './vcrMatchingTable.mjs';
import { locatePassages, passageTerms } from './vcrPassages.mjs';

/** Bumped when the instructions change enough that a record read under the old ones should be read again. */
export const MATCH_EXTRACT_PROMPT_VERSION = 'match-extract-5';

const LOCK_HASH = createHash('sha256').update(`evimed-control-plane:matching.extract:${VCR_MATCH_BATCH_METHODS['matching.extract'].version}`).digest('hex');

const object = (/** @type {unknown} */ value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);

/**
 * The smallest head count the model is shown: the domain's floor, raised and never lowered by the deployment (the service's own rule).
 * @param {Record<string, any>} config
 */
export function matchBatchMinCell(config) {
  const configured = Number(config?.vcrMinCellSize);
  return Number.isInteger(configured) && configured > VCR_MIN_CELL_SIZE ? configured : VCR_MIN_CELL_SIZE;
}

/** What the batch counts, for the operator's metric family (principle 15). */
export function createMatchBatchCounters() {
  return { started: 0, recordsRead: 0, factsKept: 0, factsRefused: 0, recordsFailed: 0, recordsUnreadable: 0, canceled: 0 };
}

/** The full interpretation context belongs to the reading, even when variable names are unchanged.
 * @param {readonly string[]} variables @param {readonly any[]} [criteria] @param {string|null} [protocolVersionId]
 */
export function matchExtractDigest(variables, criteria = [], protocolVersionId = null) {
  return createHash('sha256').update(canonicalScenarioJson({ prompt: MATCH_EXTRACT_PROMPT_VERSION, protocolVersionId,
    variables: [...new Set(variables)].sort(), criteria: criteria.map(criterionContext) })).digest('hex');
}

/**
 * The selection of a batch: an optional protocol version, an optional list of subjects, an optional instant and whether the
 * table-held decisions leave a record unread. Nothing else is accepted: the roster, the criteria and the facts are the study's own.
 * @param {unknown} raw
 * @returns {{ protocolVersionId?: string, subjectKeys?: string[], asOf?: string, prefilter?: boolean }}
 */
export function extractSelection(raw = {}) {
  const fields = ['protocolVersionId', 'subjectKeys', 'asOf', 'prefilter'];
  const id = (/** @type {unknown} */ value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const row = object(raw);
  const valid = Object.keys(row).every((key) => fields.includes(key))
    && (row.protocolVersionId == null || id(row.protocolVersionId))
    && (row.subjectKeys == null || Array.isArray(row.subjectKeys) && row.subjectKeys.length > 0 && row.subjectKeys.length <= VCR_MATCH_BATCH_LIMITS.subjects && row.subjectKeys.every(id))
    && (row.asOf == null || typeof row.asOf === 'string' && Number.isFinite(Date.parse(row.asOf)))
    && (row.prefilter == null || typeof row.prefilter === 'boolean');
  if (!valid) throw new HttpError(400, 'vcr_matching_selection_invalid', 'A batch reading takes a protocol version, a list of subjects, an instant and prefilter true or false.');
  return { ...row, ...(row.subjectKeys ? { subjectKeys: [...new Set(row.subjectKeys)] } : {}) };
}

// ---------------------------------------------------------------------------
// The model's part
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  '你从一份病历里为入排条件找事实。只输出 JSON：{"facts":[{"variable","polarity","value","unit","occurredAt","dateSurface","dateQuote","temporality","surface","quote","clinical"}]}。',
  '规则：',
  '1. variable 只能是下面列出的变量名，原样使用；病历没提到的变量不要写，不要猜。',
  '2. quote 是病历里的一句原话，逐字照抄，不改写、不换算、不合并两句；surface 是 quote 里你读到的词；有数值时 value 是 quote 里印着的数。unit 只在 quote 里紧挨着数值印着单位时才写，没印就不写（事实仍保存，数值保留）。',
  '3. polarity：affirmed（确有）、negated（quote 本身明确否认，如“否认妊娠”）、hypothetical（拟行、可能、不除外）、family（家族史）。病历没提到的是未知，不是 negated。',
  '4. occurredAt（YYYY-MM-DD）只在病历为这个事实印出了完整日期（含年份）时填：日期在 quote 里，或印在 dateQuote 里（同一份病历里为这一条事实印着日期的另一句原话，逐字照抄），日期原文放进 dateSurface。事实自己没有日期就都不填，不要把所在记录的日期补进来——平台会取它上面记录抬头的日期。缺年份的写法（如 3/14）不算日期，不要补全。',
  '5. temporality：quote 说的是既往发生的事（既往史、曾经做过的手术、“曾患”）时写 "historical"，这时记录抬头的日期只算“不晚于这一天”；现在的状态（正在用的药、本次就诊的事）不写这一项。',
  '6. 年龄、性别、诊断推不出绝经、妊娠、操作史或阴性结果，这类不要写。',
  '7. 没有可写的事实就返回 {"facts":[]}。',
  '8. quote 明确说在一段完整区间内没有该事件、并逐字印着两个完整边界日期（含年份）时，可加 clinical: {"schema":1,"assertion":"negated","experiencer":"patient","occurredInterval":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}}。clinical 的 assertion 与 polarity 一致；这是原文明确覆盖的否认区间，不是根据一条当前阴性、年龄、上传日期、记录抬头或未提到事件推算的区间。两个边界必须在同一条 quote 里；不完整就不填 occurredInterval，保留未知。不添加其他 clinical 字段。',
].join('\n');

/**
 * Every use of each requested variable, with full source wording and the complete stored predicates. The model proposes observations,
 * not the final eligibility state: an exclusion's stored negation is the evaluator's to apply.
 * @param {readonly any[]} criteria @param {readonly string[]} variables
 */
function questionLines(criteria, variables) {
  /** @type {Map<string, any[]>} */
  const said = new Map();
  /** @param {any} node @param {any} context */
  const walk = (node, context) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.variable === 'string' && node.variable) {
      const uses = said.get(node.variable) ?? [];
      if (!uses.includes(context)) uses.push(context);
      said.set(node.variable, uses);
    }
    for (const child of list(node.operands)) walk(child, context);
    if (node.operand) walk(node.operand, context);
  };
  for (const criterion of criteria) {
    const context = criterionContext(criterion);
    walk(criterion?.requirement, context);
    walk(criterion?.applicability, context);
  }
  return variables.map((variable) => {
    const uses = said.get(variable) ?? [];
    return `- ${variable}：${uses.map(use => use.sourceText).join('\n')}\n${canonicalScenarioJson(uses)}`;
  }).join('\n');
}

/** @param {any} criterion */
function criterionContext(criterion) {
  return { id: criterion?.id ?? null, kind: criterion?.kind ?? 'inclusion', sourceText: String(criterion?.sourceText ?? ''),
    requirement: criterion?.requirement ?? null, applicability: criterion?.applicability ?? null };
}

/** Whole questions stay together. A definition too large for one request is reported, never silently shortened.
 * @param {readonly any[]} criteria @param {readonly string[]} variables @returns {string[][]}
 */
export function matchExtractChunks(criteria, variables) {
  /** @type {string[][]} */ const chunks = [];
  let current = [];
  for (const variable of [...new Set(variables)].sort()) {
    if (questionLines(criteria, [variable]).length > VCR_MATCH_BATCH_LIMITS.questionChars) {
      throw Object.assign(new Error('A complete extraction question exceeds the context bound.'), { code: 'vcr_extract_context_too_large' });
    }
    if (current.length && (current.length >= VCR_MATCH_BATCH_LIMITS.questionsPerCall
      || questionLines(criteria, [...current, variable]).length > VCR_MATCH_BATCH_LIMITS.questionChars)) {
      chunks.push(current); current = [];
    }
    current.push(variable);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** @param {readonly any[]} criteria @param {readonly string[]} variables */
const extractionPrompt = (criteria, variables) => `${INSTRUCTIONS}\n\n变量（完整入排原文及结构，排除条件的取反由平台计算，不要据此反写事实）：\n${questionLines(criteria, variables)}`;

/** The estimate uses the very prompts the extractor sends, once for every bounded question chunk.
 * @param {readonly any[]} criteria @param {readonly string[]} variables */
export function matchExtractBudget(criteria, variables) {
  const chunks = matchExtractChunks(criteria, variables);
  return { calls: chunks.length, overheadTokens: chunks.reduce((sum, chunk) => sum + extractionPrompt(criteria, chunk).length + 100, 0), promptVersion: MATCH_EXTRACT_PROMPT_VERSION };
}

/**
 * The record as the model is shown it. A record within the cap is shown whole; a longer one is shown through the passages that carry
 * the criteria's words (the same locator a conversation's long-record read uses), cut at the cap, or its head when no passage was
 * found. The quotations are checked against the whole record by the writer, so a shortened view costs completeness, never accuracy.
 * @param {string} text @param {readonly any[]} criteria @param {number} cap
 * @returns {{ text: string, whole: boolean, shown: number }}
 */
export function recordView(text, criteria, cap = VCR_MATCH_BATCH_LIMITS.documentChars) {
  if (text.length <= cap) return { text, whole: true, shown: text.length };
  /** @type {Map<number, { start: number, end: number }>} */
  const found = new Map();
  for (const criterion of criteria) {
    for (const passage of locatePassages(text, passageTerms(criterion)).passages) found.set(passage.start, { start: passage.start, end: passage.end });
  }
  const spans = [...found.values()].sort((a, b) => a.start - b.start);
  if (!spans.length) return { text: text.slice(0, cap), whole: false, shown: cap };
  let out = '';
  for (const span of spans) {
    const piece = `[${span.start}]\n${text.slice(span.start, span.end)}\n`;
    if (out.length + piece.length > cap) break;
    out += piece;
  }
  return { text: out || text.slice(0, cap), whole: false, shown: out.length || cap };
}

/**
 * The extractor: one call of the control plane's model client per bounded question chunk. It returns the parsed answer and the usage; accepting what
 * it proposed, and writing it, are the executor's.
 *
 * @param {{ config: Record<string, any>, usageLedger?: any, callModel?: typeof callModelForControlPlane, fetchImpl?: typeof fetch }} deps
 */
export function createFactExtractor({ config, usageLedger = null, callModel = callModelForControlPlane, fetchImpl = globalThis.fetch }) {
  const model = String(config.deepseekModel || VCR_MATCH_BATCH_DEFAULT_MODEL);
  const timeoutMs = Math.max(5_000, Math.min(300_000, Number(config.vcrMatchExtractTimeoutMs ?? 90_000) || 90_000));
  return {
    model,
    /**
     * @param {{ study: any, jobId: string, text: string, criteria: readonly any[], variables: readonly string[], signal?: AbortSignal }} input
     * @returns {Promise<{ answer: unknown, inputTokens: number | null, outputTokens: number | null }>}
     */
    async extract({ study, jobId, text, criteria, variables, signal }) {
      if (matchExtractChunks(criteria, variables).length !== 1) {
        throw Object.assign(new Error('An extraction call takes one bounded question chunk.'), { code: 'vcr_extract_questions_invalid' });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const relay = () => controller.abort();
      signal?.addEventListener('abort', relay, { once: true });
      try {
        const body = await callModel({ config, usageLedger, fetchImpl }, {
          userId: String(study.userId), projectId: String(study.projectId ?? ''), runId: jobId, purpose: 'vcr', signal: controller.signal,
          body: {
            model, thinking: { type: 'disabled' }, temperature: 0, max_tokens: VCR_MATCH_BATCH_LIMITS.outputTokens,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: extractionPrompt(criteria, variables) },
              { role: 'user', content: `病历：\n${text}` },
            ],
          },
        });
        const choice = body?.choices?.[0];
        if (choice && Object.hasOwn(choice, 'finish_reason') && choice.finish_reason !== 'stop') {
          throw Object.assign(new Error('The extraction was cut off.'), { code: 'vcr_extract_incomplete' });
        }
        let answer;
        try { answer = JSON.parse(String(choice?.message?.content ?? '')); }
        catch { throw Object.assign(new Error('The extraction did not return JSON.'), { code: 'vcr_extract_unreadable' }); }
        const usage = object(body?.usage);
        return { answer, inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
          outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null };
      } catch (error) {
        if (/** @type {any} */ (error)?.name === 'AbortError') throw Object.assign(new Error('The extraction timed out.'), { code: 'vcr_extract_timeout' });
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * What a start will do: the roster, who needs reading, the questions, the estimate and the sentence that says it all. `exact` is the study
 * owner's own conversation: the sentence prints every head count (the default hides the small ones, as a read does).
 *
 * @param {{ study: any, selection?: unknown, matchStore: any, documents: any, subjectTable?: any, config: Record<string, any>, exact?: boolean, now?: () => Date }} deps
 * @returns {Promise<{ ok: false, message: string } | { ok: true, protocolVersionId: string, asOf: string, variables: string[], plan: ReturnType<typeof planMatchExtraction>,
 *   statement: string, prefilter: boolean, model: string, pendingLanguageKeys: string[], ambiguousLanguageKeys: string[], questionsDigest: string }>}
 */
export async function planBatch({ study, selection: raw = {}, matchStore, documents, subjectTable = null, config, exact = false, now = () => new Date() }) {
  const selection = extractSelection(raw);
  const latest = selection.protocolVersionId ? { id: selection.protocolVersionId } : await matchStore.latestProtocol(study.id);
  const criteria = latest ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: latest.id }) : [];
  if (!latest || !criteria.length) return { ok: false, message: '还没有入排条件：先在方案步骤里写入排条件，再读病历。' };
  if (!documents?.roster) return { ok: false, message: '病历文档未接入本部署：这一步暂不可用，其余步骤照常。' };
  const asOf = selection.asOf ? frozenAsOf(selection.asOf) : now().toISOString();
  const wanted = matchingVariablesOf(criteria);
  const pendingLanguageKeys = [...languageCriteriaByKey(criteria).keys()];
  const ambiguousLanguageKeys = [...ambiguousCriterionLanguageKeys(criteria)];
  const languageNote = (pendingLanguageKeys.length ? '这次批量读取只提取事实，不回答语言条件；读回患者评估，对仍缺失的条件在会话中根据患者全部相关病历逐条回答。' : '')
    + (ambiguousLanguageKeys.length ? '部分语言条件的 key 有冲突，需先修正完整条件集，冲突项保持未知。' : '');

  // The table, when the study has one: the columns answer their variables, and the people they decide against are not read.
  /** @type {any} */
  let tableRead = null;
  if (subjectTable?.read) {
    // Starting a reading is where the meaning of the table's codes is settled (asked once, recorded): without it a cell of 0 or 否 would clear nobody.
    try { tableRead = await subjectTable.read(study, { variables: wanted, propose: true }); } catch { tableRead = null; }
  }
  const tableFacts = tableRead?.available ? subjectTableFacts({ ...tableRead, variables: wanted, limit: Number.POSITIVE_INFINITY }) : null;
  // A column answers a variable the criteria ask the presence of only if its codes can be read; otherwise the record is still asked.
  const presence = new Set(presenceVariablesOf(criteria));
  const answeredByTable = tableFacts
    ? tableFacts.mapped.filter(({ variable, column }) => !presence.has(variable) || columnReadsPresence(tableRead.columns.find((/** @type {any} */ item) => item.name === column), tableRead.meaning)).map((entry) => entry.variable) : [];
  const variables = wanted.filter((variable) => !answeredByTable.includes(variable));
  const questionsDigest = matchExtractDigest(variables, criteria, String(latest.id));
  if (!variables.length) {
    const plan = planMatchExtraction({ roster: [], limit: 1, answeredByTable });
    return { ok: true, protocolVersionId: String(latest.id), asOf, variables, plan, pendingLanguageKeys, ambiguousLanguageKeys, questionsDigest,
      statement: languageNote || `${matchBatchStatement(plan, { minCell: matchBatchMinCell(config), exact })}（没有需要从病历提取的变量。）`,
      prefilter: selection.prefilter !== false, model: String(config.deepseekModel || VCR_MATCH_BATCH_DEFAULT_MODEL) };
  }

  const withdrawn = await matchStore.withdrawnSubjects?.(study.id) ?? new Set();
  const records = await documents.roster(study);
  /** @type {Map<string, Array<{ id: string, chars: number }>>} */
  const byPerson = new Map();
  for (const record of records) {
    if (withdrawn.has(record.subjectKey)) continue;
    byPerson.set(record.subjectKey, [...(byPerson.get(record.subjectKey) ?? []), { id: String(record.id), chars: Number(record.chars) }]);
  }
  /** @type {Set<string>} */
  const decided = new Set();
  if (tableFacts && selection.prefilter !== false) {
    for (const { subjectKey, facts } of tableFacts.subjects) {
      try {
        const assessment = assessSubject({ studyId: study.id, protocolVersionId: String(latest.id), subjectKey, asOf, criteria, facts });
        if (assessment.summary === 'ineligible') decided.add(subjectKey);
      } catch { /* a person the table cannot assess is read like anyone else */ }
    }
  }
  const people = selection.subjectKeys ?? [...byPerson.keys()].sort();
  const done = await matchStore.extractionsRead(study.id, questionsDigest);
  const model = String(config.deepseekModel || VCR_MATCH_BATCH_DEFAULT_MODEL);
  const plan = planMatchExtraction({
    roster: people.map((subjectKey) => ({ subjectKey, documents: byPerson.get(subjectKey) ?? [], decided: decided.has(subjectKey) })),
    done, limit: Number(config.vcrMatchBatchMaxSubjects) || VCR_MATCH_BATCH_LIMITS.subjects, prefilter: selection.prefilter !== false, model, answeredByTable,
    reading: matchExtractBudget(criteria, variables),
  });
  return { ok: true, protocolVersionId: String(latest.id), asOf, variables, plan, pendingLanguageKeys, ambiguousLanguageKeys, questionsDigest,
    statement: matchBatchStatement(plan, { minCell: matchBatchMinCell(config), exact }) + languageNote, prefilter: selection.prefilter !== false, model };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * What a reading is, whoever asks for it and whenever: the records it will read (a person's documents), the questions it asks of them and
 * the instructions it asks them with. The same selection started twice is the same reading, so the second start finds the first and does
 * not queue a second job that would finish empty and send a second continuation to the conversation.
 * @param {{ protocolVersionId: string, variables: readonly string[], questionsDigest?: string, plan: { toRead: ReadonlyArray<{ subjectKey: string, documents: ReadonlyArray<{ id: string }> }> } }} built
 */
export function extractChain(built) {
  const units = built.plan.toRead.map((entry) => [entry.subjectKey, entry.documents.map((doc) => doc.id)]);
  return createHash('sha256').update(canonicalScenarioJson({ protocolVersionId: built.protocolVersionId, variables: [...new Set(built.variables)].sort(),
    prompt: MATCH_EXTRACT_PROMPT_VERSION, questionsDigest: built.questionsDigest ?? null, units })).digest('hex').slice(0, 16);
}

/**
 * The scenario a `match_extract` job freezes: the roster and the questions, as the platform read them when the work was started.
 * @param {Awaited<ReturnType<typeof planBatch>> & { ok: true }} built
 */
export function extractScenario(built) {
  return {
    protocolVersionId: built.protocolVersionId, asOf: built.asOf, subjects: built.plan.toRead.map((entry) => entry.subjectKey), variables: built.variables,
    estimate: built.plan.estimate, questionsDigest: built.questionsDigest, chain: extractChain(built), prefilter: built.prefilter,
    ...(built.plan.prefiltered.length ? { prefiltered: built.plan.prefiltered } : {}), model: built.model,
  };
}

/**
 * What a batch's result says of itself, from its counts. Nothing finished out of something is a failure, with the commonest reason named, however
 * many attempts it took; some finished and some not (or stopped before the end) is `limited`, and what was done stands; all of it is `estimable`. A job
 * never reports success by default.
 * @param {{ finished: number, total: number, failed: number, stopped: boolean, failures: Record<string, number>, noun: string, verb: string }} input
 * @returns {{ status: 'succeeded' | 'failed', conclusion: 'estimable' | 'limited' | 'not_estimable', issues: Array<{ code: string, message: string }> }}
 */
export function resultOutcome({ finished, total, failed, stopped, failures, noun, verb }) {
  const commonest = Object.entries(failures).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  if (total > 0 && finished === 0) {
    return { status: 'failed', conclusion: 'not_estimable', issues: [{ code: commonest ?? 'vcr_match_nothing_finished', message: `${total} ${noun}都没有${verb}成${commonest ? `，最多的原因是 ${commonest}` : ''}。` }] };
  }
  if (failed > 0 || stopped || finished < total) {
    return { status: 'succeeded', conclusion: 'limited', issues: [{ code: commonest ?? 'vcr_match_stopped_early', message: `${total} ${noun}里${verb}完 ${finished} ${noun}${failed > 0 ? `，${failed} ${noun}没${verb}成` : ''}${stopped ? '，中途停下' : ''}；${verb}完的保留。` }] };
  }
  return { status: 'succeeded', conclusion: 'estimable', issues: [] };
}

/** Run `work` over `items` with at most `width` in flight, taking the next item only while `more()` says so. */
export async function pool(/** @type {readonly any[]} */ items, /** @type {number} */ width, /** @type {() => Promise<boolean>} */ more, /** @type {(item: any) => Promise<void>} */ work) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && await more()) {
      // `more` is a read of the database: another lane may have taken the last item while this one waited for it.
      if (next >= items.length) return;
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, lane));
}

/**
 * The local executor of `matching.extract`.
 *
 * @param {{
 *   store: any, matchStore: any, documents: { roster: (study: any) => Promise<any[]>, runtimeRead: (study: any, input: { subjectKey: string, documentId: string }) => Promise<any> },
 *   extractor: { model?: string, extract: (input: any) => Promise<{ answer: unknown, inputTokens: number | null, outputTokens: number | null }> },
 *   writeFacts: (input: { study: any, items: any[], documents: any, caller: any }) => Promise<{ ids?: string[], issues?: any[] }>,
 *   config?: Record<string, any>, report?: (code: string) => void, counters?: ReturnType<typeof createMatchBatchCounters>,
 * }} deps
 */
export function createMatchExtractExecutor({ store, matchStore, documents, extractor, writeFacts, config = {}, report = () => {}, counters = createMatchBatchCounters() }) {
  const width = Math.max(1, Math.min(8, Number(config.vcrMatchExtractConcurrency ?? 3) || 3));
  /** @param {{ job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown>, isCanceled?: () => Promise<boolean> }} input */
  return async ({ job, onProgress, isCanceled = async () => false }) => {
    const startedAt = new Date().toISOString();
    const studyId = String(job?.studyId ?? '');
    const found = await store.studyById(studyId);
    if (!found) throw Object.assign(new Error('The study of this job is gone.'), { code: 'vcr_study_not_found' });
    const scenario = object(job.scenario);
    const variables = list(scenario.variables).map(String);
    const criteria = await matchStore.listCriteria({ studyId, protocolVersionId: String(scenario.protocolVersionId) });
    if (!criteria.length) throw new HttpError(409, 'vcr_criteria_missing', 'The protocol version of this job has no criteria.');
    const digest = matchExtractDigest(variables, criteria, String(scenario.protocolVersionId));
    const chunks = matchExtractChunks(criteria, variables);
    const budget = matchExtractBudget(criteria, variables);
    const estimate = object(scenario.estimate);
    const replan = () => Object.assign(new HttpError(409, 'vcr_extract_replan_required',
      'The frozen reading uses a different context or budget. Start a new planned reading; completed facts are preserved.'), { recoverable: true });
    if (scenario.questionsDigest !== digest || estimate.promptVersion !== MATCH_EXTRACT_PROMPT_VERSION
      || estimate.callsPerRecord !== chunks.length || estimate.overheadTokensPerRecord !== budget.overheadTokens
      || (extractor.model && (estimate.model !== extractor.model || scenario.model !== extractor.model))) throw replan();
    // The reading is filed as a dependency of the conversation that asked for it (or of the job when none did): the same record a
    // conversation would have read, under the same copy boundary.
    const origin = object(object((await store.one('SELECT checkpoint FROM evimed_vcr.jobs WHERE id=$1', [String(job.jobId ?? job.id)]))?.checkpoint).cloudContext);
    const jobId = String(job.jobId ?? job.id);
    const study = { ...found, cloudContext: origin.runId && origin.sessionId ? { runId: String(origin.runId), sessionId: String(origin.sessionId) } : { runId: jobId, sessionId: `vcr-job:${jobId}` } };

    const withdrawn = await matchStore.withdrawnSubjects?.(studyId) ?? new Set();
    const records = await documents.roster(found);
    const done = await matchStore.extractionsRead(studyId, digest);
    const wanted = new Set(list(scenario.subjects).map(String));
    /** @type {Array<{ subjectKey: string, documentId: string }>} */
    const units = [];
    let alreadyRead = 0;
    for (const record of records) {
      const subjectKey = String(record.subjectKey);
      if (!wanted.has(subjectKey) || withdrawn.has(subjectKey)) continue;
      if (done.has(matchBatchUnitKey(subjectKey, String(record.id)))) { alreadyRead += 1; continue; }
      units.push({ subjectKey, documentId: String(record.id) });
    }
    const selected = new Set(units.map(unit => matchBatchUnitKey(unit.subjectKey, unit.documentId)));
    const characters = records.filter(record => selected.has(matchBatchUnitKey(String(record.subjectKey), String(record.id))))
      .reduce((sum, record) => sum + Math.min(Number(record.chars) > 0 ? Number(record.chars) : VCR_MATCH_BATCH_LIMITS.documentChars, VCR_MATCH_BATCH_LIMITS.documentChars), 0);
    const required = { records: units.length, calls: units.length * budget.calls,
      inputTokens: characters * budget.calls + units.length * budget.overheadTokens,
      outputTokens: units.length * budget.calls * VCR_MATCH_BATCH_LIMITS.outputTokens };
    if (Object.entries(required).some(([key, value]) => !Number.isFinite(estimate[key]) || estimate[key] < value)) throw replan();
    units.sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : a.documentId < b.documentId ? -1 : 1));

    // A record is read once for the writer too: the fact writer re-reads it to locate and verify each quotation, and the cloud read
    // is audited per read, so the executor hands it the record it already holds.
    /** @type {Map<string, any>} */
    const held = new Map();
    const cachedDocuments = { ...documents, runtimeRead: async (/** @type {any} */ forStudy, /** @type {{ subjectKey: string, documentId: string }} */ input) => {
      const key = matchBatchUnitKey(input.subjectKey, input.documentId);
      if (held.has(key)) return held.get(key);
      const record = await documents.runtimeRead(forStudy, input);
      if (record) held.set(key, record);
      return record;
    } };

    const tally = { read: 0, facts: 0, refused: 0, failed: 0, unreadable: 0, inputTokens: 0, outputTokens: 0, shortened: 0 };
    /** @type {Record<string, number>} */
    const failures = {};
    let canceled = false;
    let finished = 0;
    let reservedInputTokens = 0;
    await pool(units, width, async () => {
      if (canceled) return false;
      if (await isCanceled()) { canceled = true; counters.canceled += 1; return false; }
      return true;
    }, async ({ subjectKey, documentId }) => {
      const key = matchBatchUnitKey(subjectKey, documentId);
      try {
        const record = await cachedDocuments.runtimeRead(study, { subjectKey, documentId });
        if (!record?.text) { tally.unreadable += 1; counters.recordsUnreadable += 1; failures.record_unreadable = (failures.record_unreadable ?? 0) + 1; return; }
        const view = recordView(String(record.text), criteria);
        if (!view.whole) tally.shortened += 1;
        // Roster lengths can become stale. Reserve the actual shown input before
        // calling the model so a changed record cannot exceed the frozen ceiling.
        const neededInput = view.text.length * budget.calls + budget.overheadTokens;
        if (reservedInputTokens + neededInput > estimate.inputTokens) throw replan();
        reservedInputTokens += neededInput;
        // Nothing reaches the writer until every bounded question chunk returned a complete answer. A cut-off chunk leaves no
        // completed-record ledger row and no partially written facts to duplicate when the record is retried.
        const read = { answer: { facts: /** @type {any[]} */ ([]) }, inputTokens: 0, outputTokens: 0 };
        let chunkDropped = 0;
        for (const chunk of chunks) {
          const part = await extractor.extract({ study, jobId, text: view.text, criteria, variables: chunk });
          const acceptedChunk = acceptExtractedFacts(part.answer, new Set(chunk));
          read.answer.facts.push(...acceptedChunk.facts);
          for (const count of Object.values(acceptedChunk.dropped)) chunkDropped += count;
          read.inputTokens += part.inputTokens ?? 0;
          read.outputTokens += part.outputTokens ?? 0;
        }
        const items = read.answer.facts.flatMap((fact) => {
          const start = String(record.text).indexOf(fact.quote);
          // A quotation the record does not hold is not written (the writer would refuse it); it is counted as refused below. A date
          // quotation it does not hold, or a date the quotations do not print, costs the date and not the fact: the writer finds both
          // word for word and keeps the fact undated.
          if (start < 0) return [];
          return [{ ...fact, subjectKey, documentId, start, end: start + fact.quote.length }];
        });
        const written = items.length
          ? await writeFacts({ study, items, documents: cachedDocuments, caller: { provenance: { schema: 1, status: 'batch_extraction', runId: jobId, association: 'matching.extract', skillDigest: null, requests: [] }, runtimeRunId: jobId } })
          : { ids: [], issues: [] };
        const kept = list(written.ids).length;
        const refused = list(written.issues).length + chunkDropped + (read.answer.facts.length - items.length);
        await matchStore.recordExtraction({ studyId, subjectKey, documentId, variablesDigest: digest, documentHash: record.projectionHash ?? record.sourceHash ?? null,
          facts: kept, rejected: refused, inputTokens: read.inputTokens, outputTokens: read.outputTokens, model: extractor.model ?? null, jobId });
        tally.read += 1; tally.facts += kept; tally.refused += refused;
        tally.inputTokens += read.inputTokens ?? 0; tally.outputTokens += read.outputTokens ?? 0;
        counters.recordsRead += 1; counters.factsKept += kept; counters.factsRefused += refused;
      } catch (error) {
        // One record that could not be read is one record counted; the others go on, and it is read again by the next start.
        const code = String(/** @type {any} */ (error)?.code ?? 'vcr_extract_failed');
        tally.failed += 1; counters.recordsFailed += 1;
        failures[code] = (failures[code] ?? 0) + 1;
        report(code);
        // A budget spent or a provider down is not worth a hundred more tries in a row: the batch stops here and says why.
        if (['usage_budget_exceeded', 'insufficient_quota'].includes(code)) canceled = true;
      } finally {
        held.delete(key);
        finished += 1;
        if (finished % 5 === 0 || finished === units.length) await onProgress({ done: finished, total: units.length });
      }
    });
    await onProgress({ done: finished, total: units.length });

    const remaining = Math.max(0, units.length - finished);
    const outcome = resultOutcome({ finished: tally.read, total: units.length, failed: tally.failed + tally.unreadable, stopped: canceled, failures, noun: '份', verb: '读' });
    const scenarioHash = /^[a-f0-9]{64}$/.test(String(job.scenarioHash ?? '')) ? String(job.scenarioHash) : createHash('sha256').update(canonicalScenarioJson(scenario)).digest('hex');
    /** @type {Record<string, any>} */
    const result = {
      jobId, protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: outcome.status, method: 'matching.extract', methodVersion: VCR_MATCH_BATCH_METHODS['matching.extract'].version,
      scenarioHash, seed: Number(job.seed ?? 0), replicates: null, conclusion: outcome.conclusion,
      counts: { realPatients: new Set(units.map((unit) => unit.subjectKey)).size, events: null, effectiveSampleSize: null, generatedRecords: 0 },
      measures: [
        { name: 'records_read', value: tally.read }, { name: 'facts_kept', value: tally.facts }, { name: 'facts_refused', value: tally.refused },
        { name: 'records_failed', value: tally.failed + tally.unreadable }, { name: 'records_already_read', value: alreadyRead },
      ].map((measure) => ({ ...measure, simulated: false, source: 'calculated' })),
      diagnostics: {
        ...(outcome.issues.length ? { issues: outcome.issues } : {}),
        protocolVersionId: String(scenario.protocolVersionId), asOf: scenario.asOf, variables: variables.length, chain: scenario.chain ?? null,
        peopleSelected: list(scenario.subjects).length, recordsToRead: units.length, recordsRead: tally.read, recordsAlreadyRead: alreadyRead, recordsFailed: tally.failed,
        recordsUnreadable: tally.unreadable, recordsShortened: tally.shortened, remaining, canceled,
        factsKept: tally.facts, factsRefused: tally.refused,
        ...(Object.keys(failures).length ? { failures } : {}),
        // What was stated before the work and what it came to: the ceiling and the tokens actually used.
        estimate: object(scenario.estimate), used: { inputTokens: tally.inputTokens, outputTokens: tally.outputTokens, model: extractor.model ?? null },
        ...(list(scenario.prefiltered).length ? { prefiltered: list(scenario.prefiltered).length } : {}),
      },
      tables: [],
      manifest: { engineVersion: 'control-plane', rVersion: `node ${process.version}`, packageLockHash: LOCK_HASH, startedAt, finishedAt: new Date().toISOString(), cpuSeconds: 0 },
    };
    // A reading that stopped before the end keeps what it read and says how much is left; one that read nothing says that (`resultOutcome`).
    result.manifest.outputHash = createHash('sha256').update(vcrResultOutputPayload(result)).digest('hex');
    return result;
  };
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

/**
 * What the platform does when a reading is asked for: plan it, state it, queue it. Nothing waits on an answer.
 *
 * @param {{ jobs: any, matchStore: any, documents: any, subjectTable?: any, config: Record<string, any>, counters?: ReturnType<typeof createMatchBatchCounters>,
 *   now?: () => Date }} deps
 */
export function createMatchBatch({ jobs, matchStore, documents, subjectTable = null, config, counters = createMatchBatchCounters(), now = () => new Date() }) {
  return {
    /**
     * `ownerView` is the study owner's own conversation (the gateway decides it): the start sentence prints every head count.
     * @param {any} study @param {unknown} selection @param {{ actor?: string, ownerView?: boolean }} [options]
     */
    async start(study, selection, { actor = 'runtime', ownerView = false } = {}) {
      if (!jobs?.enqueue) throw new HttpError(503, 'vcr_gateway_unavailable', '作业队列未接入本部署：读病历暂不可用，其余步骤照常。');
      const built = await planBatch({ study, selection, matchStore, documents, subjectTable, config, exact: ownerView, now });
      if (built.ok !== true) throw new HttpError(409, 'vcr_criteria_missing', String(/** @type {any} */ (built).message));
      counters.started += 1;
      const summary = {
        statement: built.statement, estimate: built.plan.estimate,
        plan: { toRead: built.plan.toRead.length, alreadyRead: built.plan.alreadyRead.length, prefiltered: built.plan.prefiltered.length,
          noDocuments: built.plan.noDocuments.length, deferred: built.plan.deferred.length },
        ...(built.plan.bounded ? { bounded: built.plan.bounded } : {}),
        protocolVersionId: built.protocolVersionId,
        pendingLanguageKeys: built.pendingLanguageKeys,
        ambiguousLanguageKeys: built.ambiguousLanguageKeys,
      };
      if (!built.plan.toRead.length) return { action: 'start', kind: 'match_extract', state: built.pendingLanguageKeys.length || built.ambiguousLanguageKeys.length ? 'language_pending' : 'nothing_to_read', jobId: null, ...summary };
      const scenario = extractScenario(built);
      // The same reading asked for again while it is out is that reading; one that has ended is a new attempt (a record that failed is read
      // again), so the key carries how many readings of this one there have been.
      const same = await jobs.store?.rows?.(`SELECT id, state FROM evimed_vcr.jobs WHERE study_id = $1 AND kind = 'match_extract' AND scenario ->> 'chain' = $2
        ORDER BY created_at`, [study.id, scenario.chain]) ?? [];
      const open = same.find((entry) => ['queued', 'running', 'awaiting_budget'].includes(String(entry.state)));
      if (open) return { action: 'start', kind: 'match_extract', state: String(open.state), jobId: String(open.id), alreadyRunning: true, ...summary };
      const { job } = await jobs.enqueue({
        studyId: study.id, userId: study.userId, kind: 'match_extract', scenario, inputs: [], internal: true, runId: study.executionOrigin?.runId ?? null,
        cpuSecondsLimit: 60, maxAttempts: 3, idempotencyKey: `vcr:${study.id}:extract:${scenario.chain}:g${same.length}`,
        detail: { origin: actor, protocolVersionId: built.protocolVersionId, principal: study.userId,
          ...(study.cloudContext ? { cloudContext: { runId: String(study.cloudContext.runId), sessionId: String(study.cloudContext.sessionId) } } : {}),
          ...(study.completionOrigin ? { conversationOrigin: study.completionOrigin } : {}) },
      });
      return { action: 'start', kind: 'match_extract', state: job.state, jobId: job.id, ...summary };
    },
  };
}
