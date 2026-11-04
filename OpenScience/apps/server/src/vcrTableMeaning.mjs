/**
 * What a study's subject table MEANS, asked of the model once and remembered.
 *
 * A cohort table records a history in filled cells: `DIABETES = 0`, `否`, `No`. Whether a code says the event happened is language, and
 * so is which column answers a criterion's variable (`egfr_mutation` against `EGFR_STATUS`); the evaluator that decides eligibility is
 * arithmetic and reads neither (`vcrMatchingTable.mjs`). This module is the one place a model is asked, and what it answers is kept as
 * facts of the dataset-semantics asset (`@evimed/domain`'s `dataSemantics.mjs`): per column its `concept` (the study's own variable it
 * answers) and its `valueMap` (what each code means), basis `model_inferred`, so a researcher's correction outranks it and a later
 * proposal never overwrites that correction.
 *
 * Hidden knowledge:
 *
 * - **One dataset per snapshot, one model call per question.** The asset is bound to the exact table the codes were read from
 *   (`tableMeaningDatasetId`), so a re-derived table asks again and a researcher's correction of the old one does not follow its
 *   codes to a table that may mean something else. What was asked is recorded with the answer: the columns that got a map, and the
 *   variables the model looked for (`askedConcepts`) -- a second start, and a start with another subset of the criteria that adds
 *   nothing new, find everything recorded and cost nothing.
 * - **The model sees codes, never a person.** The prompt holds column names, declared types and units, and for a column of at most
 *   `vocabularyMax` distinct short values the distinct values themselves -- never a row, never a value beside a key. A column with more
 *   distinct values gets no map and can only be called a measurement; a column whose values are nearly one per person lists no values at all, and under the small-cell floor of filled
 *   cells only a column of a few codes lists them. The values are patient data, so they leave under the same rule every
 *   other patient text does: the source's cloud permission or the deployment's agreements (`authorizeCloud`, the plane's judged answer).
 *   A refusal is a result that says so.
 * - **Code applies what the model said, exactly.** An answer is held to what was offered: a code the column does not contain, a state
 *   outside present / absent / unknown, a concept that is not one of the variables asked, is dropped and never repaired. What the
 *   model leaves out reads `unknown` (the map names what it is sure of).
 * - **The model failing costs nothing but the answer.** No model, no permission, no asset store, a malformed answer, a spent budget:
 *   the result says the meaning could not be proposed (`status: "not_proposed"` and a code) and every code reads `unknown`, which the
 *   evaluator answers `coding_unmapped` -- never `present`, never an exclusion. Nothing here throws into the job that asked.
 * - **The frozen job is held to what it was frozen with.** `digest` names what the recorded meaning does to the variables of one set
 *   of criteria; the job that freezes its inputs stores it with the table's identity, and a job that finds another meaning when it runs
 *   (a researcher corrected a map in between) is a changed input like a changed column definition. A job that only runs never asks the
 *   model (`propose: false`): the question was settled when it was frozen.
 *
 * @module vcrTableMeaning
 */

import { createHash } from 'node:crypto';
import { DATA_DRIFT_BOUNDS, DATA_VALUE_STATES, VCR_MATCH_BATCH_DEFAULT_MODEL, canonicalJson, errorCodeMessage } from '@evimed/domain';
import { callModelForControlPlane } from './modelGateway.mjs';
import { columnForVariable, columnsWithMeaning } from './vcrMatchingTable.mjs';
import { matchBatchMinCell } from './vcrMatchBatch.mjs';

/** The table of the asset every subject-table fact is filed under. */
export const TABLE_MEANING_TABLE = 'subjects';
/** The subject column of the module's own subject table: never offered, never read as a meaning. */
const SUBJECT_COLUMN = 'USUBJID';
/** The most columns one question offers: a wider table is asked in the next question about what is still open. */
export const TABLE_MEANING_MAX_COLUMNS = 120;
/** A code longer than this is text, not a code (the domain's code length). */
const CODE_CHARS = 40;
/** What a table too small to show levels being shared may offer as codes in one column. */
const SMALL_TABLE_CODES = 4;
/** Bumped when the instructions change enough that a recorded meaning should be asked for again (a new dataset id follows the version). */
export const TABLE_MEANING_PROMPT_VERSION = 'table-meaning-1';

/** What the person sees when a meaning could not be proposed: the registry's sentence for the code. */
export const TABLE_MEANING_NOT_PROPOSED_ZH = errorCodeMessage('vcr_table_meaning_not_proposed');

const object = (/** @type {unknown} */ value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * The dataset one snapshot's table meaning is kept under: derived from the snapshot so that the id is always in the semantics
 * alphabet whatever the snapshot is called, and one study's tables never meet.
 * @param {string} snapshotId
 */
export function tableMeaningDatasetId(snapshotId) {
  return `vcr-tbl-${createHash('sha256').update(`${TABLE_MEANING_PROMPT_VERSION}\0${snapshotId}`).digest('hex').slice(0, 32)}`;
}

/**
 * The meaning an asset holds for the subject table.
 * @param {any} asset @returns {import('./vcrMatchingTable.mjs').TableMeaning & { asked: string[] }}
 */
export function readTableMeaning(asset) {
  const table = asset?.tables?.find((/** @type {any} */ candidate) => candidate.name === TABLE_MEANING_TABLE);
  /** @type {Record<string, any>} */
  const columns = {};
  for (const variable of table?.variables ?? []) {
    const concept = variable.facts?.concept?.value;
    const valueMap = variable.facts?.valueMap?.value;
    if (concept || valueMap) columns[variable.name] = { ...(concept ? { concept } : {}), ...(valueMap ? { valueMap } : {}) };
  }
  const asked = table?.facts?.askedConcepts?.value;
  return { columns, asked: Array.isArray(asked) ? asked : [] };
}

/**
 * What the recorded meaning does to one set of criteria's variables over one table: null where it does nothing (so a study without a
 * meaning keeps the identity it had), else a short digest of the columns the variables reach and the maps they are read through.
 * @param {{ table: { header: readonly string[], columns: readonly any[] }, variables: readonly string[], meaning: import('./vcrMatchingTable.mjs').TableMeaning | null | undefined }} input
 * @returns {string | null}
 */
export function meaningDigest({ table, variables, meaning }) {
  if (!meaning) return null;
  const effective = columnsWithMeaning(table.columns.filter((column) => table.header.includes(column.name)), meaning);
  const used = [];
  for (const variable of [...new Set(variables)].sort()) {
    const { column } = columnForVariable(variable, effective);
    const own = column ? meaning.columns?.[column.name] : null;
    if (column && own) used.push([variable, column.name, own.concept ?? null, own.valueMap ?? null]);
  }
  return used.length ? createHash('sha256').update(canonicalJson(used)).digest('hex').slice(0, 16) : null;
}

/**
 * One column as the model is shown it: the name, the declared type and unit, how many cells are filled and how many distinct values they
 * hold, and -- for a column that is a vocabulary -- the values. Never a row.
 * @param {{ header: readonly string[], rows: readonly (readonly string[])[] }} table @param {{ name: string, type?: string | null, unit?: string | null }} column
 * @param {number} floor
 */
function briefOf(table, column, floor) {
  const at = table.header.indexOf(column.name);
  /** @type {Set<string>} */
  const seen = new Set();
  let filled = 0;
  for (const row of table.rows) {
    const cell = String(row[at] ?? '').trim();
    if (!cell) continue;
    filled += 1;
    if (seen.size <= DATA_DRIFT_BOUNDS.vocabularyMax) seen.add(cell);
  }
  // A vocabulary is levels that people share: a column whose values are nearly one per person is a measurement, not a code list. A small table cannot show that sharing, and 0 and 1 mean what they mean
  // however few people there are: without its codes every presence criterion of the table would stay open for good. So a table under the floor offers a column of a few codes.
  const shared = filled >= floor ? seen.size * 2 <= filled : seen.size <= SMALL_TABLE_CODES && (seen.size * 2 <= filled || filled <= SMALL_TABLE_CODES);
  const vocabulary = column.type !== 'date' && seen.size > 0 && seen.size <= DATA_DRIFT_BOUNDS.vocabularyMax && shared
    && [...seen].every((value) => [...value].length <= CODE_CHARS);
  return {
    name: column.name, type: column.type ?? 'unknown', ...(column.unit ? { unit: String(column.unit) } : {}), filled,
    distinct: seen.size > DATA_DRIFT_BOUNDS.vocabularyMax ? `more than ${DATA_DRIFT_BOUNDS.vocabularyMax}` : seen.size,
    ...(vocabulary ? { values: [...seen].sort() } : {}),
  };
}

/**
 * What a question would be, from what is recorded: the columns to offer, the variables to look for, and which columns get a map.
 * Null where nothing is open.
 * @param {{ table: { header: readonly string[], rows: readonly (readonly string[])[], columns: readonly any[] }, variables: readonly string[],
 *   meaning: import('./vcrMatchingTable.mjs').TableMeaning & { asked: string[] }, floor: number }} input
 */
export function planTableMeaning({ table, variables, meaning, floor }) {
  const columns = table.columns.filter((column) => table.header.includes(column.name) && column.name !== SUBJECT_COLUMN);
  const effective = columnsWithMeaning(columns, meaning);
  const reached = new Set();
  /** @type {string[]} */
  const unresolved = [];
  for (const variable of [...new Set(variables)].sort()) {
    const { column, ambiguous } = columnForVariable(variable, effective);
    if (column) reached.add(column.name);
    else if (!ambiguous && !meaning.asked.includes(variable)) unresolved.push(variable);
  }
  // A variable no column answers to may be answered by any column the field map has not already named; otherwise only the columns the
  // variables reach need a map.
  const needsMap = (/** @type {any} */ column) => !meaning.columns[column.name]?.valueMap && (unresolved.length > 0 || reached.has(column.name));
  const needsConcept = (/** @type {any} */ column) => unresolved.length > 0 && !effective.find((candidate) => candidate.name === column.name)?.concept;
  const offered = columns.filter((column) => needsMap(column) || needsConcept(column))
    .sort((a, b) => Number(reached.has(b.name)) - Number(reached.has(a.name))).slice(0, TABLE_MEANING_MAX_COLUMNS);
  if (!offered.length) return null;
  return {
    unresolved,
    maps: new Set(offered.filter(needsMap).map((column) => column.name)),
    concepts: new Set(offered.filter(needsConcept).map((column) => column.name)),
    briefs: offered.map((column) => briefOf(table, column, floor)),
  };
}

/** @param {string[]} unresolved @param {Array<Record<string, any>>} briefs */
function promptOf(unresolved, briefs) {
  return [
    '你在读一张研究受试者数据表的列。下面给出每一列的列名、声明类型、单位，以及（取值不多的列）这一列出现过的全部取值；这里没有任何一个人的内容。',
    '对每一列回答三件事：',
    '1. values：对给了取值的列，说明每个取值对“这一列所记录的事件”意味着什么：present（有、发生过、是）、absent（没有、否、无）、unknown（不详、拒答、未查，或你无法判断）。键必须与给出的取值逐字一致；没有把握的不要写。',
    '2. measurement：这一列的数字本身就是测量、计数或评分结果（年龄、检验值、天数、分级）而不是“有无”的标记时，为 true；否则 false。',
    '3. concept：这一列如果回答的是下面“研究条件所问的变量”之一，原样写出那个变量名；都不是就写 null。一个变量最多对应一列，拿不准就写 null。',
    '只输出 JSON：{"columns":[{"name":"列名","concept":null,"measurement":false,"values":{"0":"absent","1":"present"}}]}。不要写别的。',
    `研究条件所问的变量：${unresolved.length ? unresolved.join('、') : '（无，只需回答 values 和 measurement）'}`,
    `数据表的列：\n${JSON.stringify(briefs)}`,
  ].join('\n');
}

/**
 * The answer, held to what was offered. Nothing is repaired: an entry that does not fit is left out and the column reads as if the
 * model had said nothing about it.
 * @param {unknown} answer @param {NonNullable<ReturnType<typeof planTableMeaning>>} plan
 * @returns {Map<string, { concept?: string, valueMap?: { values: Record<string, string>, measurement: boolean } }>}
 */
export function acceptTableMeaning(answer, plan) {
  const asked = new Set(plan.unresolved);
  const offered = new Map(plan.briefs.map((brief) => [String(brief.name), brief]));
  /** @type {Map<string, any>} */
  const accepted = new Map();
  for (const item of Array.isArray(object(answer).columns) ? object(answer).columns : []) {
    const entry = object(item);
    const brief = offered.get(String(entry.name ?? ''));
    if (!brief || accepted.has(brief.name)) continue;
    /** @type {{ concept?: string, valueMap?: { values: Record<string, string>, measurement: boolean } }} */
    const kept = {};
    if (plan.concepts.has(brief.name) && typeof entry.concept === 'string' && asked.has(entry.concept)) kept.concept = entry.concept;
    if (plan.maps.has(brief.name)) {
      /** @type {Record<string, string>} */
      const values = {};
      if (Array.isArray(brief.values)) {
        for (const [code, state] of Object.entries(object(entry.values))) {
          if (brief.values.includes(code) && typeof state === 'string' && DATA_VALUE_STATES.includes(state)) values[code] = state;
        }
      }
      kept.valueMap = { values, measurement: entry.measurement === true };
    }
    accepted.set(brief.name, kept);
  }
  // A column the model left out is still a column that was asked: it is recorded as read, with nothing in it.
  for (const name of plan.maps) if (!accepted.has(name)) accepted.set(name, { valueMap: { values: {}, measurement: false } });
  return accepted;
}

/** @type {Map<string, Promise<any>>} questions in flight, so two starts at once make one call */
const inflight = new Map();

/**
 * The meaning of a study's subject table for the variables its criteria ask: what is recorded, and -- when `propose` -- one model
 * call for what is not, recorded before it is returned. Never throws.
 *
 * @param {{
 *   study: { id: string, userId: string, projectId?: string | null },
 *   table: { snapshotId: string, header: readonly string[], rows: readonly (readonly string[])[], columns: readonly any[] },
 *   variables: readonly string[],
 *   semantics: { get: Function, write: Function } | null | undefined,
 *   config: Record<string, any>,
 *   callModel?: typeof callModelForControlPlane, usageLedger?: any, fetchImpl?: typeof fetch,
 *   authorizeCloud?: ((input: { fields: string[] }) => Promise<unknown>) | null,
 *   propose?: boolean, signal?: AbortSignal,
 * }} input `authorizeCloud` is the plane's judged answer to whether the table's codes may go to the model; it throws to refuse.
 * @returns {Promise<{ meaning: (import('./vcrMatchingTable.mjs').TableMeaning & { asked: string[] }) | null, digest: string | null,
 *   status: 'recorded' | 'proposed' | 'not_proposed' | 'unavailable', code?: string, message?: string }>}
 */
export async function ensureTableMeaning(input) {
  const { study, table } = input;
  const variables = [...new Set(input.variables ?? [])];
  const datasetId = tableMeaningDatasetId(String(table?.snapshotId ?? ''));
  const key = `${study?.userId}\0${study?.projectId}\0${datasetId}\0${canonicalJson([...variables].sort())}`;
  if (inflight.has(key)) return inflight.get(key);
  const running = ask(input, variables, datasetId)
    .catch(() => ({ meaning: null, digest: null, status: /** @type {const} */ ('unavailable'), code: 'vcr_table_meaning_failed' }))
    .finally(() => { inflight.delete(key); });
  inflight.set(key, running);
  return running;
}

/** @param {Parameters<typeof ensureTableMeaning>[0]} input @param {string[]} variables @param {string} datasetId */
async function ask(input, variables, datasetId) {
  const { study, table, semantics, config } = input;
  const done = (/** @type {any} */ meaning, /** @type {'recorded' | 'proposed' | 'not_proposed' | 'unavailable'} */ status, /** @type {string} */ code = '') => ({
    meaning, digest: meaningDigest({ table, variables, meaning }), status,
    ...(code ? { code } : {}), ...(status === 'not_proposed' ? { message: TABLE_MEANING_NOT_PROPOSED_ZH } : {}),
  });
  if (!semantics || !study?.projectId || !table?.header || !table.columns) return done(null, 'unavailable', 'semantics_unavailable');
  const userId = String(study.userId);
  const projectId = String(study.projectId);
  /** @type {any} */
  let record;
  try { record = await semantics.get(userId, projectId, datasetId); }
  catch (error) { return done(null, 'unavailable', String(/** @type {any} */ (error)?.code ?? 'semantics_unavailable')); }
  const meaning = readTableMeaning(record?.asset);
  if (input.propose === false) return done(meaning, 'recorded');
  const plan = planTableMeaning({ table, variables, meaning, floor: matchBatchMinCell(config) });
  if (!plan) return done(meaning, 'recorded');

  const model = String(config.deepseekModel || VCR_MATCH_BATCH_DEFAULT_MODEL);
  const controller = new AbortController();
  const timeoutMs = Math.max(5_000, Math.min(300_000, Number(config.vcrMatchExtractTimeoutMs ?? 90_000) || 90_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  input.signal?.addEventListener('abort', relay, { once: true });
  let accepted;
  try {
    // The codes are patient data: they leave only where the source's permission or the deployment's agreements say they may.
    await input.authorizeCloud?.({ fields: plan.briefs.map((brief) => String(brief.name)) });
    const body = await (input.callModel ?? callModelForControlPlane)({ config, usageLedger: input.usageLedger ?? null, fetchImpl: input.fetchImpl ?? globalThis.fetch }, {
      userId, projectId, runId: null, purpose: 'vcr', signal: controller.signal,
      body: {
        model, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 8000, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: promptOf(plan.unresolved, plan.briefs) }, { role: 'user', content: '请按要求只输出 JSON。' }],
      },
    });
    const choice = body?.choices?.[0];
    if (choice && Object.hasOwn(choice, 'finish_reason') && choice.finish_reason !== 'stop') throw Object.assign(new Error('The answer was cut off.'), { code: 'vcr_table_meaning_failed' });
    let answer;
    try { answer = JSON.parse(String(choice?.message?.content ?? '')); }
    catch { throw Object.assign(new Error('The answer was not JSON.'), { code: 'vcr_table_meaning_failed' }); }
    accepted = acceptTableMeaning(answer, plan);
  } catch (error) {
    const code = /** @type {any} */ (error)?.name === 'AbortError' ? 'vcr_table_meaning_failed' : String(/** @type {any} */ (error)?.code ?? 'vcr_table_meaning_failed');
    return done(meaning, 'not_proposed', code);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', relay);
  }

  const patch = {
    datasetId, basis: 'model_inferred',
    inferredFrom: [`column names and codes of the study's subject table, read by ${model}`],
    tables: plan.unresolved.length ? [{ name: TABLE_MEANING_TABLE, askedConcepts: [...new Set([...meaning.asked, ...plan.unresolved])] }] : [],
    variables: [...accepted].filter(([, facts]) => facts.concept || facts.valueMap).map(([name, facts]) => ({ table: TABLE_MEANING_TABLE, name, ...facts })),
  };
  try {
    await semantics.write(userId, projectId, patch, { via: 'conversation' });
    // What is kept is read back: a researcher's word that outranked the proposal is the one that applies.
    return done(readTableMeaning((await semantics.get(userId, projectId, datasetId))?.asset), 'proposed');
  } catch (error) {
    return done(meaning, 'not_proposed', String(/** @type {any} */ (error)?.code ?? 'vcr_table_meaning_not_recorded'));
  }
}
