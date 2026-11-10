/**
 * Set adapters for the engine-layer runner: every development test set becomes the runner's common `Case[]`.
 *
 * A Case carries only what the runner may show: sessions to ingest (with optional per-message time and attachments that are
 * shown to the answering model as material and never sent to the memory engine) and questions. Answers, gold, rubrics,
 * anchors and every other scorer field stay in the gold files and never enter a Case; `assertCase` enforces that.
 *
 * Data root (read-only): `CAPSULE_PROVING_DATA` or `DEFAULT_DATA_DIR`. `split` is "dev" or "sealed"; the sealed split is
 * resolved by symmetry of names (`<name>-dev` <-> `<name>-sealed`, pool `development` <-> `confirmation`).
 *
 * Dates: sets whose data carry no dates get deterministic ones, a fixed base date per set (`SET_BASE`) plus one day per
 * session; a question's `asOf` is 12 hours after the session it follows (one day before the first session, or before the
 * base date, when it precedes every session). Sets with real dates keep them, converted to ISO strings in UTC.
 *
 * @module capsule-proving/run/sets
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicMemory, PUBLIC_MEMORY_SETS } from './publicSets.mjs';
import { longMemRuntimeInput } from '../inputs.mjs';
import {
  brandGenericRuntimeInput, medLoCoMoRuntimeInput, medMemoryHfKey, medMemoryHfRuntimeInput,
} from '../inputsLearning.mjs';

/**
 * @typedef {{ role: 'user'|'assistant', text: string, at?: string }} Message
 * @typedef {{ afterMessage: number, kind: 'document'|'web'|'tool'|'paste', title: string, text: string }} Attachment
 * @typedef {{ id: string, name: string }} Project
 * @typedef {{ sessionId: string, at: string, project: Project|null, messages: Message[], attachments?: Attachment[] }} Session
 * @typedef {{ kind: string, title: string, text: string }} Material
 * @typedef {{ name: string, args: object }} Probe
 * @typedef {{ qid: string, afterSession: number, asOf: string, text: string, project?: Project|null, materials?: Material[], probe?: Probe[] }} Question
 * @typedef {{ caseId: string, set: string, split: string, userKey: string, sessions: Session[], questions: Question[], [extra: string]: any }} Case
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const POOLS = join(HERE, '..', 'pools');
export const DEFAULT_DATA_DIR = '/home/coder/evimed-wt/memdata-data';
const DAY = 86400000;
const FALLBACK_BASE = '2026-01-01T09:00:00.000Z';

/** Fixed base date per set for sets without dates. */
export const SET_BASE = Object.freeze({
  scenarios: '2026-03-02T09:00:00.000Z', 'med-m1': '2026-03-09T09:00:00.000Z', 'med-m2': '2026-03-16T09:00:00.000Z',
  'med-m3': '2026-03-23T09:00:00.000Z', 'med-m5': '2026-03-30T09:00:00.000Z', 'med-m10': '2026-04-06T09:00:00.000Z',
  g9: '2026-04-13T09:00:00.000Z', m6: '2026-04-20T09:00:00.000Z', m7: '2026-04-27T09:00:00.000Z',
  m11: '2026-05-04T09:00:00.000Z', g6: '2026-05-11T09:00:00.000Z', 'brand-generic': '2026-05-18T09:00:00.000Z',
});

/** Keys that must never appear anywhere in a Case (compared lower-case, at any depth). */
export const FORBIDDEN_KEYS = Object.freeze([
  'answer', 'answers', 'gold', 'expect', 'rubric', 'mustcontain', 'mustnotcontain', 'mustcontainany', 'mustnotcontainasfact',
  'evidence', 'knowledge_points', 'source_key_points', 'secret', 'anchor', 'preferenceanchor', 'instructiontext', 'judge',
  'adversarial_answer', 'reference_answer', 'has_answer', 'answer_session_ids', 'is_correct', 'citations', 'allowedcitations',
  'full', 'partial', 'why', 'store', 'redline', 'poison', 'established', 'wrong', 'expectstored',
]);
const FORBIDDEN = new Set(FORBIDDEN_KEYS);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isIso = (v) => typeof v === 'string' && ISO.test(v) && new Date(v).toISOString() === v;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function walkKeys(value, path, out) {
  if (Array.isArray(value)) value.forEach((v, i) => walkKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.has(k.toLowerCase())) out.push(`${path}.${k}`);
      walkKeys(v, `${path}.${k}`, out);
    }
  }
}

/** Throws on a malformed Case or on any forbidden key anywhere in it. Returns the case. */
export function assertCase(c) {
  const bad = (m) => { throw new TypeError(`case ${c?.caseId ?? '?'}: ${m}`); };
  if (!c || typeof c !== 'object') throw new TypeError('case must be an object');
  for (const k of ['caseId', 'set', 'split', 'userKey']) if (!nonEmpty(c[k])) bad(`${k} must be nonempty text`);
  if (!['dev', 'sealed'].includes(c.split)) bad('split must be dev or sealed');
  if (!Array.isArray(c.sessions) || !Array.isArray(c.questions)) bad('sessions and questions must be arrays');
  if (!c.questions.length) bad('a case needs at least one question');
  const forbidden = [];
  walkKeys(c, 'case', forbidden);
  if (forbidden.length) bad(`forbidden key(s) ${forbidden.slice(0, 3).join(', ')}`);
  let previous = '';
  c.sessions.forEach((s, i) => {
    if (s.sessionId !== `s${String(i + 1).padStart(3, '0')}`) bad(`session ${i} id is not the expected s### in order`);
    if (!isIso(s.at)) bad(`session ${s.sessionId} at is not an ISO string`);
    if (s.at < previous) bad(`session ${s.sessionId} is earlier than the one before`);
    previous = s.at;
    if (!(s.project === null || (nonEmpty(s.project?.id) && nonEmpty(s.project?.name)))) bad(`session ${s.sessionId} project is malformed`);
    if (!Array.isArray(s.messages) || !s.messages.length) bad(`session ${s.sessionId} has no messages`);
    for (const m of s.messages) {
      if (!['user', 'assistant'].includes(m?.role) || !nonEmpty(m.text)) bad(`session ${s.sessionId} has a malformed or empty message`);
      for (const k of Object.keys(m)) if (!['role', 'text', 'at'].includes(k)) bad(`message key ${k}`);
      if (m.at !== undefined && !isIso(m.at)) bad('message at is not an ISO string');
    }
    for (const a of s.attachments ?? []) {
      if (!Number.isInteger(a.afterMessage) || a.afterMessage < 0 || a.afterMessage > s.messages.length) bad('attachment afterMessage out of range');
      if (!['document', 'web', 'tool', 'paste'].includes(a.kind) || typeof a.title !== 'string' || !nonEmpty(a.text)) bad('attachment is malformed');
    }
  });
  const qids = new Set();
  for (const q of c.questions) {
    if (!nonEmpty(q.qid) || qids.has(q.qid)) bad('question id is missing or repeated');
    qids.add(q.qid);
    if (!Number.isInteger(q.afterSession) || q.afterSession < 0 || q.afterSession > c.sessions.length) bad(`${q.qid} afterSession out of range`);
    if (!isIso(q.asOf)) bad(`${q.qid} asOf is not an ISO string`);
    if (typeof q.text !== 'string') bad(`${q.qid} text must be text`);
    if (q.probe !== undefined) {
      if (!Array.isArray(q.probe) || !q.probe.length || q.text !== '') bad(`${q.qid} probe needs a list and empty text`);
      for (const p of q.probe) if (!nonEmpty(p?.name) || typeof p.args !== 'object' || p.args === null) bad(`${q.qid} probe call is malformed`);
    } else if (!nonEmpty(q.text)) bad(`${q.qid} text is empty`);
    for (const m of q.materials ?? []) if (!nonEmpty(m?.text) || !nonEmpty(m?.kind)) bad(`${q.qid} material is malformed`);
  }
  return c;
}

// ---------------------------------------------------------------- helpers

/** Parses the date spellings of the public sets ("2023/05/30 (Tue) 23:40", "2024-12-20", "2120-08-06 20:15:00", ISO) to a UTC ISO string or null. */
export function toIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[^\d]*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (!m) {
    // LoCoMo: "1:56 pm on 8 May, 2023"; HaluMem: "Dec 15, 2025, 06:11:23".
    const locomo = /^(\d{1,2}:\d{2}\s*[ap]m) on (.+)$/i.exec(v);
    const parsed = Date.parse(`${locomo ? `${locomo[2]} ${locomo[1]}` : v} UTC`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

const baseOf = (set) => SET_BASE[set] ?? FALLBACK_BASE;
const addMs = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const sid = (i) => `s${String(i + 1).padStart(3, '0')}`;

/** Drops empty-text messages (and moves attachment positions so they keep pointing after the same kept messages). */
function cleanMessages(messages, attachments) {
  const kept = []; const keptBefore = [0];
  for (const m of messages ?? []) {
    const text = typeof m?.text === 'string' ? m.text : (typeof m?.content === 'string' ? m.content : '');
    if (text.trim()) kept.push({ role: m.role, text, ...(isIso(m.at) ? { at: m.at } : {}) });
    keptBefore.push(kept.length);
  }
  const atts = (attachments ?? []).map((a) => ({ ...a, afterMessage: keptBefore[Math.min(a.afterMessage, keptBefore.length - 1)] }));
  return { messages: kept, attachments: atts };
}

/**
 * Builds a Case. `rawSessions`: `{ at?, messages, attachments?, project? }`; `rawQuestions`: `{ qid, text, afterSession?, asOf?, probe?, materials? }`
 * (afterSession defaults to all sessions; asOf defaults as described in the module header). Sessions without any kept
 * message are dropped and `afterSession` is remapped accordingly.
 * @returns {Case}
 */
export function makeCase({ caseId, set, split, userKey, rawSessions, rawQuestions, extra = {} }) {
  const sessions = [];
  const remap = [0];
  rawSessions.forEach((raw, i) => {
    const { messages, attachments } = cleanMessages(raw.messages, raw.attachments);
    if (messages.length) {
      const previous = sessions.at(-1)?.at;
      const at = isIso(raw.at) ? raw.at : (previous ? addMs(previous, DAY) : addMs(baseOf(set), i * DAY));
      sessions.push({ sessionId: sid(sessions.length), at, project: raw.project ?? null, messages, ...(attachments.length ? { attachments } : {}) });
    }
    remap.push(sessions.length);
  });
  const questions = rawQuestions.map((q) => {
    const after = q.afterSession === undefined ? sessions.length : remap[Math.min(q.afterSession, remap.length - 1)];
    const asOf = isIso(q.asOf) ? q.asOf : (after > 0 ? addMs(sessions[after - 1].at, DAY / 2) : addMs(sessions[0]?.at ?? baseOf(set), -DAY));
    return { qid: q.qid, afterSession: after, asOf, text: q.text ?? '',
      ...(q.probe ? { probe: q.probe } : {}), ...(q.materials?.length ? { materials: q.materials } : {}) };
  });
  return { caseId, set, split, userKey, sessions, questions, ...extra };
}

const onlyFilter = (cases, only) => {
  if (!only?.length) return cases;
  const want = new Set(only);
  return cases.filter((c) => want.has(c.caseId) || (c.itemId && want.has(c.itemId)));
};

const resolveData = (dataDir) => dataDir ?? process.env.CAPSULE_PROVING_DATA ?? DEFAULT_DATA_DIR;
function checkSplit(split) { if (!['dev', 'sealed'].includes(split)) throw new TypeError('split must be "dev" or "sealed"'); }
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
function setDir(dataDir, name, split) {
  const dir = join(resolveData(dataDir), `${name}-${split}`);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  return dir;
}
function pool(file, split) {
  const p = readJson(join(POOLS, file));
  return split === 'dev' ? p.pools.development : p.pools.confirmation;
}
const slug = (s) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
const done = (cases, only) => onlyFilter(cases, only).map(assertCase);

// ---------------------------------------------------------------- synthetic sets

const plainQuestion = (q) => ({ qid: q.qid, text: q.text });

/** scenarios: one case and userKey per scenario, every question asked after the whole history. */
export async function loadScenarios({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const input = readJson(join(setDir(dataDir, 'scenarios', split), 'input.json'));
  return done(input.scenarios.map((s) => makeCase({ caseId: s.scenarioId, set: 'scenarios', split, userKey: s.scenarioId,
    rawSessions: s.sessions, rawQuestions: s.questions.map(plainQuestion), extra: { itemId: s.scenarioId } })), only);
}

function medLoader(n) {
  const name = `med-m${n}`;
  return async function loadMed({ split = 'dev', dataDir, only } = {}) {
    checkSplit(split);
    const input = readJson(join(setDir(dataDir, name, split), 'input.json'));
    return done(input.items.map((it) => makeCase({ caseId: it.itemId, set: name, split, userKey: it.itemId,
      rawSessions: it.sessions, rawQuestions: it.questions.map(plainQuestion), extra: { itemId: it.itemId } })), only);
  };
}
export const loadMedM1 = medLoader(1);
export const loadMedM2 = medLoader(2);
export const loadMedM3 = medLoader(3);
export const loadMedM5 = medLoader(5);
export const loadMedM10 = medLoader(10);

const MATERIAL_KINDS = { document: 'document', webpage: 'web', tool_result: 'tool', pasted: 'paste' };

/**
 * g9: poisoning and sycophancy items. A poison item's carrier text rides in `sessions[i].attachments` (kinds document, web,
 * tool, paste); the generator keeps it out of every user message, so it stays an attachment (material for the answering
 * model, never ingested). `afterMessage` keeps the source meaning: the number of messages before the material appears.
 * In poison items the last user message of the final session repeats the question; it is dropped from the history because
 * the question is asked separately.
 */
export async function loadG9({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const input = readJson(join(setDir(dataDir, 'g9', split), 'input.json'));
  return done(input.items.map((it) => {
    const rawSessions = it.sessions.map((s, i) => {
      let messages = s.messages;
      const last = messages.at(-1);
      if (i === it.sessions.length - 1 && last?.role === 'user' && last.text === it.question.text) messages = messages.slice(0, -1);
      return { messages, attachments: (s.attachments ?? []).map((a) => {
        const kind = MATERIAL_KINDS[a.kind];
        if (!kind) throw new TypeError(`g9 ${it.itemId}: unknown carrier ${a.kind}`);
        return { afterMessage: a.afterMessage, kind, title: a.title ?? '', text: a.text };
      }) };
    });
    // The question is asked inside the final session, so that session's material is in front of the answering model when it is asked.
    const inContext = (rawSessions.at(-1)?.attachments ?? []).map(({ kind, title, text }) => ({ kind, title, text }));
    return makeCase({ caseId: it.itemId, set: 'g9', split, userKey: it.itemId, rawSessions,
      rawQuestions: [{ ...plainQuestion(it.question), ...(inContext.length ? { materials: inContext } : {}) }], extra: { itemId: it.itemId, itemKind: it.kind } });
  }), only);
}

/** m6: each item has a with-memory arm (history, then question) and a without-memory arm (no history); each arm is its own case and userKey. */
export async function loadM6({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const input = readJson(join(setDir(dataDir, 'm6', split), 'input.json'));
  const cases = [];
  for (const it of input.items) {
    for (const [arm, a] of Object.entries(it.arms)) {
      cases.push(makeCase({ caseId: `${it.itemId}:${arm}`, set: 'm6', split, userKey: `${it.itemId}:${arm}`,
        rawSessions: a.sessions, rawQuestions: [plainQuestion(a.question)], extra: { itemId: it.itemId, arm } }));
    }
  }
  return done(cases, only);
}

/** m11: the case with history plus a no-history control case (`<itemId>:control`, same question, zero sessions, `control: true`). */
export async function loadM11({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const input = readJson(join(setDir(dataDir, 'm11', split), 'input.json'));
  const cases = [];
  for (const it of input.items) {
    cases.push(makeCase({ caseId: it.itemId, set: 'm11', split, userKey: it.itemId, rawSessions: it.sessions,
      rawQuestions: [plainQuestion(it.question)], extra: { itemId: it.itemId, itemKind: it.kind, control: false } }));
    cases.push(makeCase({ caseId: `${it.itemId}:control`, set: 'm11', split, userKey: `${it.itemId}:control`, rawSessions: [],
      rawQuestions: [{ qid: `${it.question.qid}-control`, text: it.question.text }], extra: { itemId: it.itemId, itemKind: it.kind, control: true } }));
  }
  return done(cases, only);
}

/**
 * m7 (remembered layouts): the runtime input is each case's `memory` files and its two requests (`full.ask`, `partial.ask`).
 * Every memory file becomes one session: the file's text as one user message and a short assistant acknowledgement
 * (Chinese for `lang: "zh"`, English otherwise). The learned `method` card, `full.given`, `partial.given/missing`, `why`,
 * `citations` and `domain` are scorer-side and never enter the case. Both requests are asked after all sessions.
 */
export async function loadM7({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const file = readJson(join(setDir(dataDir, 'm7', split), 'cases.json'));
  return done(file.cases.map((c) => {
    const ack = c.lang === 'zh' ? '好的，我记下了。' : 'Noted, I will remember that.';
    const rawSessions = c.memory.map((m) => ({ messages: [{ role: 'user', text: m.text }, { role: 'assistant', text: ack }] }));
    const rawQuestions = [{ qid: `${c.id}-full`, text: c.full.ask }, { qid: `${c.id}-partial`, text: c.partial.ask }];
    return makeCase({ caseId: c.id, set: 'm7', split, userKey: c.id, rawSessions, rawQuestions, extra: { itemId: c.id } });
  }), only);
}

/**
 * g6: 450 secret-carrying sentences, no split. Each item is one session (the sentence as the user message, a neutral
 * acknowledgement from the assistant); 15 items per user in file order (`g6-u01`...). After the last session each item
 * gets a probe question: a direct `search` tool call (no model) for the carrier sentence with the secret removed.
 */
export async function loadG6({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  if (split !== 'dev') throw new Error('g6 has no sealed split');
  const items = readJson(join(resolveData(dataDir), 'g6', 'items.json')).items;
  const cases = [];
  for (let g = 0; g * 15 < items.length; g += 1) {
    const group = items.slice(g * 15, g * 15 + 15);
    const userKey = `g6-u${String(g + 1).padStart(2, '0')}`;
    const rawQuestions = group.map((it) => {
      const query = it.text.split(it.secret).join('').replace(/\s+/g, ' ').trim();
      if (!query || query.includes(it.secret)) throw new Error(`g6 ${it.id}: probe query is empty or still holds the secret`);
      return { qid: `${it.id}-probe`, text: '', probe: [{ name: 'search', args: { query, limit: 5 } }] };
    });
    cases.push(makeCase({ caseId: userKey, set: 'g6', split, userKey, rawQuestions,
      rawSessions: group.map((it) => ({ messages: [{ role: 'user', text: it.text }, { role: 'assistant', text: '好的，收到。' }] })),
      extra: { itemId: userKey } }));
  }
  return done(cases, only);
}

// ---------------------------------------------------------------- public sets

/** brand-generic: the English brand/generic probe, one case per pool item (the single statement is the one session; no dates, so synthetic). */
export async function loadBrandGeneric({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const want = new Set(pool('brand-generic-probe-20261109.json', split));
  const lines = readFileSync(join(resolveData(dataDir), 'public', 'brand-generic-probe', 'inputs.jsonl'), 'utf8').split('\n').filter(Boolean);
  const cases = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    if (!want.has(row.id)) continue;
    const input = brandGenericRuntimeInput({ id: row.id, questionText: row.question.text, statementText: row.histories[0].messages[0].text });
    cases.push(makeCase({ caseId: input.id, set: 'brand-generic', split, userKey: slug(input.id),
      rawSessions: input.histories.map((h) => ({ messages: h.messages })), rawQuestions: [{ qid: `${input.id}:q`, text: input.question.text }],
      extra: { itemId: input.id } }));
  }
  return done(cases, only);
}

/**
 * Streams the top-level JSON array of a big file and parses only the elements whose first `"question_id"` is wanted
 * (LongMemEval's file is 277 MB; it is never held whole). String and escape state are tracked per byte; the bytes of
 * `{ } [ ] " \` never occur inside a UTF-8 multi-byte sequence, so scanning bytes is exact.
 * @returns {Promise<Map<string, any>>}
 */
export async function streamArrayElements(path, wanted) {
  const found = new Map();
  let depth = 0; let inString = false; let escape = false; let parts = []; let from = -1;
  const idOf = (buf) => /"question_id"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, 400).toString('utf8'))?.[1];
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    if (from >= 0) from = 0; // an element continues from the previous chunk
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (inString) { if (escape) escape = false; else if (b === 92) escape = true; else if (b === 34) inString = false; continue; }
      if (b === 34) inString = true;
      else if (b === 123 || b === 91) { depth += 1; if (depth === 2 && b === 123) from = i; }
      else if (b === 125 || b === 93) {
        depth -= 1;
        if (depth === 1 && b === 125 && from >= 0) {
          const buf = Buffer.concat([...parts, chunk.subarray(from, i + 1)]);
          parts = []; from = -1;
          const id = idOf(buf);
          if (id && wanted.has(id)) found.set(id, JSON.parse(buf.toString('utf8')));
        }
      }
    }
    if (from >= 0) parts.push(Buffer.from(chunk.subarray(from)));
  }
  return found;
}

/**
 * longmemeval-s: one case and userKey per question; the haystack sessions in date order with their dates as `at`
 * (the source's repeated session ids stay separate sessions), asked after all of them, `asOf` = the question date.
 * Original language; ids come from the frozen pool.
 */
export async function loadLongMemEvalS({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  let ids = pool('longmemeval-s-20261105.json', split);
  if (only?.length) ids = ids.filter((id) => only.includes(id) || only.includes(`lme-${id}`));
  const rows = await streamArrayElements(join(resolveData(dataDir), 'public', 'longmemeval', 'longmemeval_s_cleaned.json'), new Set(ids));
  const cases = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) throw new Error(`longmemeval-s question ${id} is not in the pinned file`);
    rows.delete(id); // release as we go
    const input = longMemRuntimeInput(row);
    const histories = input.histories.map((h, i) => ({ h, i, at: toIso(h.at) }))
      .sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : a.i - b.i));
    cases.push(makeCase({ caseId: `lme-${id}`, set: 'longmemeval-s', split, userKey: `lme-${id}`,
      rawSessions: histories.map(({ h, at }) => ({ at, messages: h.messages })),
      rawQuestions: [{ qid: id, text: input.question.text, asOf: toIso(input.question.asOf) ?? undefined }], extra: { itemId: id } }));
  }
  return done(cases, only);
}

async function readJsonl(path) {
  const rows = [];
  let first = true;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line) continue;
    if (first) { first = false; continue; } // header line: { derivedFrom, sha256 }
    rows.push(JSON.parse(line));
  }
  return rows;
}

/**
 * medmemorybench (Hugging Face version, zh by default; `variant: "en"` needs `dialogues.en.jsonl`, which is only built on
 * request): one case and userKey per patient. Sessions are the patient's sessions in order up to the latest anchor among the
 * selected questions; each question is asked right after its own anchor session (`afterSession` = that session's position),
 * `asOf` = the anchor session's date. Question text only: answers, key points and metadata stay out.
 */
export async function loadMedMemoryBench({ split = 'dev', dataDir, only, variant = 'zh' } = {}) {
  checkSplit(split);
  if (!['zh', 'en'].includes(variant)) throw new TypeError('variant must be zh or en');
  const want = new Set(pool('medmemorybench-hf-20261109.json', split));
  const dir = join(resolveData(dataDir), 'public', 'medmemorybench-hf', 'derived');
  const dialoguePath = join(dir, `dialogues.${variant}.jsonl`);
  if (!existsSync(dialoguePath)) throw new Error(`medmemorybench ${variant} dialogues are not derived locally (${dialoguePath} is missing)`);
  const queries = (await readJsonl(join(dir, `queries.${variant}.jsonl`))).filter((q) => want.has(medMemoryHfKey(q)));
  const maxAnchor = new Map();
  for (const q of queries) maxAnchor.set(q.persona_id, Math.max(maxAnchor.get(q.persona_id) ?? 0, q.session_id));
  const rowsByPersona = new Map();
  for await (const line of createInterface({ input: createReadStream(dialoguePath), crlfDelay: Infinity })) {
    if (!line || line.startsWith('{"derivedFrom"')) continue;
    const r = JSON.parse(line);
    if (!maxAnchor.has(r.persona_id) || r.session_id > maxAnchor.get(r.persona_id)) continue;
    if (!rowsByPersona.has(r.persona_id)) rowsByPersona.set(r.persona_id, []);
    rowsByPersona.get(r.persona_id).push({ persona_id: r.persona_id, session_id: r.session_id, turn: r.turn, role: r.role, content: r.content, event_info: r.event_info });
  }
  const cases = [];
  for (const [persona, personaQueries] of Map.groupBy(queries, (q) => q.persona_id)) {
    if (only?.length && !only.includes(`mm-${variant}-p${persona}`) && !only.includes(`persona_${persona}`)) continue;
    const rows = rowsByPersona.get(persona) ?? [];
    let longest = null; const rawQuestions = [];
    for (const q of personaQueries) {
      const input = medMemoryHfRuntimeInput(rows, q, { language: variant });
      if (!longest || input.histories.length > longest.length) longest = input.histories;
      rawQuestions.push({ qid: input.id, text: input.question.text, afterSession: input.histories.length, asOf: toIso(input.question.asOf) ?? undefined });
    }
    rowsByPersona.delete(persona); // release this patient's rows
    cases.push(makeCase({ caseId: `mm-${variant}-p${persona}`, set: 'medmemorybench', split, userKey: `mm-${variant}-p${persona}`,
      rawSessions: longest.map((h) => ({ at: toIso(h.at), messages: h.messages })), rawQuestions, extra: { itemId: `persona_${persona}`, variant } }));
  }
  return done(cases, only);
}

/**
 * medlocomo (English, MIMIC-derived): one case and userKey per patient; each admission is a session dated by its start
 * (patient = user, doctor = assistant, per-line times kept as message `at`), every selected question asked after the full
 * history. The source gives no question date, so `asOf` is 12 hours after the last session.
 */
export async function loadMedLoCoMo({ split = 'dev', dataDir, only } = {}) {
  checkSplit(split);
  const ids = pool('medlocomo-20261109.json', split);
  const cases = [];
  for (const [subject, qaIds] of Map.groupBy(ids, (id) => id.split('_')[0])) {
    if (only?.length && !only.includes(`ml-${subject}`) && !only.includes(subject)) continue;
    const base = join(resolveData(dataDir), 'public', 'medlocomo', 'MedLoCoMo', subject);
    const patient = readJson(join(base, 'combined_conversation.json'));
    const qas = new Map(readJson(join(base, 'benchmark_qa.json')).qas.map((qa) => [qa.qa_id, qa]));
    let histories = null; const rawQuestions = [];
    for (const qaId of qaIds) {
      const qa = qas.get(qaId);
      if (!qa) throw new Error(`medlocomo question ${qaId} is not in the patient's file`);
      const input = medLoCoMoRuntimeInput(patient, qa);
      histories ??= input.histories;
      rawQuestions.push({ qid: input.id, text: input.question.text });
    }
    const toMessages = (h) => h.messages.map((m) => ({ role: m.role, text: m.text, ...(toIso(m.at) ? { at: toIso(m.at) } : {}) }));
    cases.push(makeCase({ caseId: `ml-${subject}`, set: 'medlocomo', split, userKey: `ml-${subject}`,
      rawSessions: histories.map((h) => ({ at: toIso(h.at), messages: toMessages(h) })), rawQuestions, extra: { itemId: subject } }));
  }
  return done(cases, only);
}

/** Public question pools share one user per original conversation/person, with bounded prefixes at every question. */
export async function loadPublicMemory(options = {}) {
  const { set, split = 'dev', dataDir, only } = options;
  const entries = await readPublicMemory({ set, split, dataDir: resolveData(dataDir), only });
  return entries.map(entry => {
    const longest = entry.inputs.reduce((a, b) => a.histories.length >= b.histories.length ? a : b);
    const timingAdjustments = [];
    let previous = '';
    const rawSessions = longest.histories.map(h => {
      const original = toIso(h.at);
      // HaluMem has an intra-day backwards start time. Its official protocol follows source session order.
      // Clamp only the session scheduling clock; preserve original per-message times and record the exact adjustment.
      const at = original && original < previous ? previous : original;
      if (at !== original) timingAdjustments.push({ session: h.sourceSessionId, original, scheduled: at });
      if (at) previous = at;
      return { at, messages: h.messages.map(m => ({ role: m.role,
        // Pinned snap-research/locomo task_eval/gpt_utils.py get_input_context: keep the named speaker and shared caption.
        // These are original visible conversation content, not QA annotations or inferred image descriptions.
        text: set.startsWith('locomo') ? `${m.speaker} said, \"${m.text}\"\n${m.imageCaption ? ` and shared ${m.imageCaption}.` : ''}` : m.text,
        ...(toIso(m.at) ? { at: toIso(m.at) } : {}) })) };
    });
    return assertCase(makeCase({ caseId: entry.caseId, set, split, userKey: entry.caseId,
      rawSessions,
      rawQuestions: entry.inputs.map(input => ({ qid: input.id, text: input.question.text,
        afterSession: input.histories.length, asOf: toIso(input.question.asOf) ?? undefined })),
      extra: { itemId: entry.itemId, ...(timingAdjustments.length ? { timingAdjustments } : {}), ...(longest.roleMapping ? { roleMapping: longest.roleMapping } : {}) } }));
  });
}

/** Set name to loader. Every loader takes `{ split, dataDir, only }` and returns `Case[]` (each already through `assertCase`). */
export const SET_LOADERS = Object.freeze({
  ...Object.fromEntries(PUBLIC_MEMORY_SETS.map(set => [set, options => loadPublicMemory({ ...options, set })])),
  scenarios: loadScenarios,
  'med-m1': loadMedM1, 'med-m2': loadMedM2, 'med-m3': loadMedM3, 'med-m5': loadMedM5, 'med-m10': loadMedM10,
  g9: loadG9, m6: loadM6, m11: loadM11, m7: loadM7, g6: loadG6,
  'brand-generic': loadBrandGeneric, 'longmemeval-s': loadLongMemEvalS, medmemorybench: loadMedMemoryBench, medlocomo: loadMedLoCoMo,
});
