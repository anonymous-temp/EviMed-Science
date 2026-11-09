/**
 * Official-corpus intake for the capsule proving lane. These adapters preserve
 * dialogue roles and chronology; answer material belongs to a separate scorer.
 * They do not write memory, call a model, or certify a product evaluation.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';

const INPUT_SCHEMA = 'capsule-proving-input/1';
const POOL_SCHEMA = 'capsule-proving-pools/1';
const SHA256 = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be nonempty text`);
  return value;
}

function list(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function sourceDate(value) {
  if (value == null || value === '') return null;
  return text(value, 'source date');
}

function messagesOf(messages) {
  return list(messages, 'messages').map(message => {
    if (!['user', 'assistant'].includes(message?.role)) throw new TypeError('unsupported source role');
    // Some official historical turns contain no text. Keep their role and
    // absence; the product capture boundary decides no_text. Never stringify
    // null or an object into a statement or remove the question from scoring.
    if (message.content != null && typeof message.content !== 'string') throw new TypeError('message content must be text or null');
    return { role: message.role, text: message.content ?? '' };
  });
}

function medicalSourceId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('medical source identifier must be a nonnegative safe integer');
    return String(value);
  }
  return text(value, 'medical source identifier');
}

function uniqueIds(values, field) {
  const ids = values.map(value => text(value, field));
  if (new Set(ids).size !== ids.length) throw new TypeError(`duplicate ${field}`);
  return ids;
}

/** Original role/date history and the question only; never spread a corpus row into a model request. */
export function longMemRuntimeInput(row) {
  const ids = list(row.haystack_session_ids, 'history ids').map(id => text(id, 'history session id'));
  const dates = list(row.haystack_dates, 'history dates');
  const sessions = list(row.haystack_sessions, 'history sessions');
  if (ids.length !== dates.length || ids.length !== sessions.length) throw new TypeError('history alignment mismatch');
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return {
    schema: INPUT_SCHEMA, benchmark: 'longmemeval-s', id: text(row.question_id, 'question id'),
    question: { text: text(row.question, 'question'), asOf: sourceDate(row.question_date) },
    // The official source has thirteen repeated IDs with different visible
    // payloads. Preserve every original position, date and role; parts with
    // one sourceSessionId remain one logical conversation for learning counts.
    histories: ids.map((sourceSessionId, index) => ({ sourceSessionId,
      ...(counts.get(sourceSessionId) > 1 ? { sourcePart: index } : {}),
      at: sourceDate(dates[index]), messages: messagesOf(sessions[index]) })),
  };
}

/** Gold stays in the operator/scorer process, outside every answering runtime workspace. */
export function longMemGold(row) {
  if (!Object.hasOwn(row, 'answer')) throw new TypeError('official answer is missing');
  return structuredClone({ question_id: text(row.question_id, 'question id'), question: text(row.question, 'question'), question_type: row.question_type,
    question_date: row.question_date, answer: row.answer, answer_session_ids: row.answer_session_ids });
}

/** A question at one medical session sees that original prefix, never later sessions or key points. */
export function medMemoryRuntimeInput(dialogues, query, { language, persona }) {
  if (!['zh', 'en'].includes(language)) throw new TypeError('medical source language must be zh or en');
  text(persona, 'persona');
  const sessions = list(dialogues.sessions, 'medical sessions');
  const ids = uniqueIds(sessions.map(session => medicalSourceId(session.session_id)), 'medical session id');
  const anchor = ids.indexOf(medicalSourceId(query.session_id));
  if (anchor === -1) throw new TypeError('question anchor is missing from the source dialogue');
  const histories = sessions.slice(0, anchor + 1).map((session, index) => ({
    sourceSessionId: ids[index], at: sourceDate(session.event_info?.date), messages: messagesOf(session.messages),
  }));
  return { schema: INPUT_SCHEMA, benchmark: 'medmemorybench', id: `${language}:${persona}:${text(query.query_id, 'query id')}`,
    question: { text: text(query.question, 'question'), asOf: histories.at(-1).at }, histories };
}

/** Preserve official scoring inputs separately, including correctness flags and deduction metadata. */
export function medMemoryGold(query) {
  return structuredClone({ query_id: text(query.query_id, 'query id'), session_id: query.session_id,
    question: text(query.question, 'question'), query_type: query.query_type,
    answers: list(query.answers, 'official answers'), source_key_points: query.source_key_points, metadata: query.metadata });
}

function overlapOf(rows, development) {
  const memberships = new Map();
  for (const row of rows) {
    const side = development.has(row.question_id) ? 1 : 2;
    for (const id of list(row.haystack_session_ids, 'history ids')) {
      text(id, 'history session id');
      memberships.set(id, (memberships.get(id) ?? 0) | side);
    }
  }
  const sharedSessionIds = [...memberships.values()].filter(side => side === 3).length;
  return { sharedSessionIds, sourceContextDisjoint: sharedSessionIds === 0 };
}

function poolDigest(document) {
  const { digest: _digest, ...unsigned } = document;
  return hash(canonicalJson(unsigned));
}

/**
 * Freeze the same requested number of questions on every machine. Reused
 * distractor histories make LongMemEval question-disjoint, not history-unseen;
 * report that overlap rather than labelling the full 500 as unseen confirmation.
 * `benchmark` defaults to longmemeval-s so the published LongMemEval digest is unchanged.
 */
export function registerQuestionPools(rows, { seed, developmentCount, sourceSha256, benchmark = 'longmemeval-s' }) {
  text(seed, 'pool seed');
  text(benchmark, 'pool benchmark');
  if (typeof sourceSha256 !== 'string' || !SHA256.test(sourceSha256)) throw new TypeError('source digest must be SHA256');
  const source = list(rows, 'source questions');
  const ids = uniqueIds(source.map(row => row.question_id), 'question id');
  if (!Number.isSafeInteger(developmentCount) || developmentCount < 1 || developmentCount >= ids.length) {
    throw new TypeError('development and confirmation must both contain questions');
  }
  const ranked = ids.map(id => ({ id, rank: hash(`${seed}|${id}`) })).sort((a, b) => compare(a.rank, b.rank) || compare(a.id, b.id));
  const selected = new Set(ranked.slice(0, developmentCount).map(item => item.id));
  const document = {
    schema: POOL_SCHEMA, benchmark, seed, sourceSha256, universe: ids.length,
    confirmationScope: 'question-only',
    pools: { development: ids.filter(id => selected.has(id)).sort(compare), confirmation: ids.filter(id => !selected.has(id)).sort(compare) },
    sourceOverlap: overlapOf(source, selected),
  };
  return { ...document, digest: poolDigest(document) };
}

/** Self-integrity only: callers must also verify the actual input bytes against the pinned source digest. */
export function validateFrozenPools(document) {
  const issues = [];
  try {
    if (document?.schema !== POOL_SCHEMA || document?.confirmationScope !== 'question-only') issues.push('unsupported_schema');
    if (!SHA256.test(document?.sourceSha256 ?? '')) issues.push('invalid_source_digest');
    const development = uniqueIds(list(document?.pools?.development, 'development pool'), 'development id');
    const confirmation = uniqueIds(list(document?.pools?.confirmation, 'confirmation pool'), 'confirmation id');
    if (!development.length || !confirmation.length) issues.push('empty_pool');
    if (new Set([...development, ...confirmation]).size !== development.length + confirmation.length) issues.push('overlapping_pools');
    if (development.length + confirmation.length !== document.universe) issues.push('universe_mismatch');
    if (document.digest !== poolDigest(document)) issues.push('digest_mismatch');
  } catch { issues.push('invalid_pool_shape'); }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Public general-memory corpora (2026-11-09). Same contract as the adapters
// above: runtime input carries roles, original dates and the question only;
// every answer, label and memory annotation goes to a gold function that runs
// in the scorer process. Nothing here drops, merges or repairs a source row.
// ---------------------------------------------------------------------------

const NO_STRUCTURE = { sessionBoundaries: false, timestamps: false };

function withSourceFields(messages, extra) {
  // messagesOf validates roles and keeps empty text; `extra` adds per-message source fields.
  const base = messagesOf(messages);
  return base.map((message, index) => ({ ...message, ...extra(messages[index]) }));
}

function nonemptyQuestion(value) {
  return text(value, 'question');
}

/** Digest of the pinned files an intake actually read, for pools over a set of files. */
export function sourceSetSha256(files) {
  const entries = list(files, 'source files').map(file => ({ path: text(file.path, 'source path'), sha256: text(file.sha256, 'source sha256') }));
  if (entries.some(entry => !SHA256.test(entry.sha256))) throw new TypeError('source digest must be SHA256');
  return hash(canonicalJson(entries.sort((a, b) => compare(a.path, b.path))));
}

// --- LoCoMo (original and refined) -----------------------------------------

export const LOCOMO_CATEGORIES = Object.freeze({ 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' });

function locomoSessions(sample) {
  const conversation = sample?.conversation;
  if (!conversation || typeof conversation !== 'object') throw new TypeError('conversation is missing');
  const names = { a: text(conversation.speaker_a, 'speaker_a'), b: text(conversation.speaker_b, 'speaker_b') };
  if (names.a === names.b) throw new TypeError('LoCoMo speakers must be two different people');
  const numbers = Object.keys(conversation).map(key => /^session_(\d+)$/.exec(key)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
  const histories = numbers.map(number => {
    const turns = list(conversation[`session_${number}`], `session_${number}`);
    return {
      sourceSessionId: `session_${number}`, at: sourceDate(conversation[`session_${number}_date_time`]),
      messages: turns.map(turn => {
        const role = turn?.speaker === names.a ? 'user' : turn?.speaker === names.b ? 'assistant' : null;
        if (!role) throw new TypeError('unknown LoCoMo speaker');
        const caption = typeof turn.blip_caption === 'string' && turn.blip_caption.trim() ? { imageCaption: turn.blip_caption } : {};
        if (turn.text != null && typeof turn.text !== 'string') throw new TypeError('message content must be text or null');
        return { role, text: turn.text ?? '', speaker: turn.speaker, turnId: text(turn.dia_id, 'turn id'), ...caption };
      }),
    };
  });
  return { names, histories };
}

/**
 * One LoCoMo question over its full conversation. The two speakers are people,
 * not user and assistant: speaker_a is mapped to `user` and speaker_b to
 * `assistant`, always, and the mapping is recorded in the input. LoCoMo asks
 * after the whole conversation and gives no question date, so asOf stays null.
 */
export function locomoRuntimeInput(sample, qaIndex, { benchmark = 'locomo' } = {}) {
  if (!['locomo', 'locomo-refined'].includes(benchmark)) throw new TypeError('unsupported LoCoMo benchmark');
  const qa = list(sample.qa, 'qa')[qaIndex];
  if (!qa) throw new TypeError('LoCoMo question index is out of range');
  const sampleId = text(sample.sample_id, 'sample id');
  const { names, histories } = locomoSessions(sample);
  return {
    schema: INPUT_SCHEMA, benchmark, id: `${sampleId}:q${qaIndex}`,
    question: { text: nonemptyQuestion(qa.question), asOf: null },
    roleMapping: { rule: 'speaker_a=user, speaker_b=assistant', user: names.a, assistant: names.b },
    conversationKey: sampleId, histories,
  };
}

export function locomoGold(sample, qaIndex, { benchmark = 'locomo' } = {}) {
  const qa = list(sample.qa, 'qa')[qaIndex];
  if (!qa) throw new TypeError('LoCoMo question index is out of range');
  const category = qa.category;
  return structuredClone({
    id: `${text(sample.sample_id, 'sample id')}:q${qaIndex}`, benchmark, question: qa.question,
    category, categoryName: LOCOMO_CATEGORIES[category] ?? null,
    // Category 5 rows carry no official answer (444 of 446); adversarial_answer is the decoy, never a reference answer.
    adversarial: category === 5, hasAnswer: Object.hasOwn(qa, 'answer') && qa.answer != null,
    ...(Object.hasOwn(qa, 'answer') ? { answer: qa.answer } : {}),
    ...(Object.hasOwn(qa, 'adversarial_answer') ? { adversarial_answer: qa.adversarial_answer } : {}),
    evidence: qa.evidence, ...(Object.hasOwn(qa, 'is_multi_modality') ? { is_multi_modality: qa.is_multi_modality } : {}),
  });
}

// --- HaluMem ---------------------------------------------------------------

/** A HaluMem question sees the sessions up to and including the one it hangs on; persona_info and memory points stay in gold. */
export function haluMemRuntimeInput(user, sessionIndex, questionIndex, { benchmark = 'halumem-medium' } = {}) {
  const sessions = list(user.sessions, 'sessions');
  const session = sessions[sessionIndex];
  if (!session) throw new TypeError('HaluMem session index is out of range');
  const question = list(session.questions ?? [], 'questions')[questionIndex];
  if (!question) throw new TypeError('HaluMem question index is out of range');
  const uuid = text(user.uuid, 'user uuid');
  const histories = sessions.slice(0, sessionIndex + 1).map((item, index) => ({
    sourceSessionId: `session_${index}`, at: sourceDate(item.start_time),
    messages: withSourceFields(item.dialogue, message => (typeof message.timestamp === 'string' && message.timestamp ? { at: message.timestamp } : {})),
  }));
  return {
    schema: INPUT_SCHEMA, benchmark, id: `${uuid}:s${sessionIndex}:q${questionIndex}`,
    question: { text: nonemptyQuestion(question.question), asOf: sourceDate(session.end_time ?? session.start_time) },
    conversationKey: uuid, histories,
  };
}

export function haluMemGold(user, sessionIndex, questionIndex, { benchmark = 'halumem-medium' } = {}) {
  const session = list(user.sessions, 'sessions')[sessionIndex];
  const question = session && list(session.questions ?? [], 'questions')[questionIndex];
  if (!question) throw new TypeError('HaluMem question index is out of range');
  return structuredClone({
    id: `${text(user.uuid, 'user uuid')}:s${sessionIndex}:q${questionIndex}`, benchmark, sessionIndex, questionIndex,
    question: question.question, answer: question.answer, evidence: question.evidence, difficulty: question.difficulty,
    question_type: question.question_type, memory_points: session.memory_points ?? [], persona_info: user.persona_info,
  });
}

/** Every memory point of a user by session, for the extraction and update metrics. */
export function haluMemUserGold(user) {
  return structuredClone({ uuid: text(user.uuid, 'user uuid'), persona_info: user.persona_info,
    sessions: list(user.sessions, 'sessions').map((session, index) => ({ index, start_time: session.start_time, end_time: session.end_time,
      memory_points: session.memory_points ?? [], questions: session.questions ?? [] })) });
}

// --- RealMem ---------------------------------------------------------------

const REALMEM_ROLES = { User: 'user', Assistant: 'assistant' };
// The pinned files hold booleans; the upstream README and an earlier note say strings. Both spellings of true count, nothing else does.
const isRealMemQuery = value => value === true || value === 'True';

/** Query turns of one persona in source order: { sessionIndex, turnIndex }. */
export function realMemQueryRefs(persona) {
  const refs = [];
  list(persona.dialogues, 'dialogues').forEach((session, sessionIndex) => {
    list(session.dialogue_turns, 'dialogue turns').forEach((turn, turnIndex) => { if (isRealMemQuery(turn?.is_query)) refs.push({ sessionIndex, turnIndex }); });
  });
  return refs;
}

/**
 * The official protocol answers each query when it is met in time order and
 * only then ingests that query's session, so a query sees the sessions before
 * its own. `lastIngestedSessionIndex` names the last of them (-1: none).
 */
export function realMemRuntimeInput(persona, { sessionIndex, turnIndex }) {
  const sessions = list(persona.dialogues, 'dialogues');
  const session = sessions[sessionIndex];
  const turn = session && list(session.dialogue_turns, 'dialogue turns')[turnIndex];
  if (!turn || !isRealMemQuery(turn.is_query)) throw new TypeError('RealMem reference is not a query turn');
  if (turn.speaker !== 'User') throw new TypeError('RealMem query must be a user turn');
  const person = text(persona._metadata?.person_name, 'person name');
  const histories = sessions.slice(0, sessionIndex).map(item => ({
    sourceSessionId: text(item.session_uuid, 'session uuid'), sourceSessionLabel: item.session_identifier ?? null, at: sourceDate(item.current_time),
    messages: list(item.dialogue_turns, 'dialogue turns').map(entry => {
      const role = REALMEM_ROLES[entry?.speaker];
      if (!role) throw new TypeError('unsupported source role');
      if (entry.content != null && typeof entry.content !== 'string') throw new TypeError('message content must be text or null');
      return { role, text: entry.content ?? '' };
    }),
  }));
  return {
    schema: INPUT_SCHEMA, benchmark: 'realmem', id: `${person}:${text(turn.query_id, 'query id')}`,
    question: { text: nonemptyQuestion(turn.content), asOf: sourceDate(session.current_time) },
    protocol: { order: 'query-before-own-session', lastIngestedSessionIndex: sessionIndex - 1, ingestedSessions: sessionIndex, queryTurnIndex: turnIndex },
    conversationKey: person, histories,
  };
}

/** The reference answer is the LLM-generated assistant turn after the query; RealMem has no human gold. */
export function realMemGold(persona, { sessionIndex, turnIndex }) {
  const session = list(persona.dialogues, 'dialogues')[sessionIndex];
  const turns = session && list(session.dialogue_turns, 'dialogue turns');
  const turn = turns?.[turnIndex];
  if (!turn || !isRealMemQuery(turn.is_query)) throw new TypeError('RealMem reference is not a query turn');
  const reply = turns[turnIndex + 1];
  const answered = reply?.speaker === 'Assistant';
  return structuredClone({
    id: `${text(persona._metadata?.person_name, 'person name')}:${text(turn.query_id, 'query id')}`, query_id: turn.query_id, question: turn.content,
    topic: turn.topic, category_name: turn.category_name, session_type: turn.session_type, goldKind: 'llm-generated',
    reference_answer: answered ? reply.content : null, memory_used: answered ? reply.memory_used ?? null : null,
    memory_session_uuids: answered ? reply.memory_session_uuids ?? null : null,
    sessionIndex, turnIndex, lastIngestedSessionIndex: sessionIndex - 1,
  });
}

// --- PersonaMem-v2 ---------------------------------------------------------

/** Minimal reader for the Python-repr dict the benchmark CSV stores in user_query ({'role': 'user', 'content': '...'}). */
export function pythonLiteralDict(source) {
  const s = text(source, 'python literal');
  let i = 0;
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
  const expect = char => { skip(); if (s[i] !== char) throw new TypeError(`python literal: expected ${char}`); i += 1; };
  const string = () => {
    skip(); const quote = s[i];
    if (quote !== "'" && quote !== '"') throw new TypeError('python literal: expected a string');
    i += 1; let out = '';
    while (i < s.length && s[i] !== quote) {
      if (s[i] !== '\\') { out += s[i]; i += 1; continue; }
      i += 1; const c = s[i]; i += 1;
      const hex = length => { const digits = s.slice(i, i + length); if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) throw new TypeError('python literal: bad escape'); i += length; return String.fromCodePoint(parseInt(digits, 16)); };
      if (c === 'n') out += '\n'; else if (c === 't') out += '\t'; else if (c === 'r') out += '\r';
      else if (c === 'x') out += hex(2); else if (c === 'u') out += hex(4); else if (c === 'U') out += hex(8);
      else if (c === '\\' || c === "'" || c === '"') out += c; else if (c === '\n') out += '';
      else out += `\\${c}`;
    }
    if (s[i] !== quote) throw new TypeError('python literal: unterminated string');
    i += 1; return out;
  };
  const value = () => {
    skip();
    if (s[i] === "'" || s[i] === '"') return string();
    for (const [word, result] of [['None', null], ['True', true], ['False', false]]) if (s.startsWith(word, i)) { i += word.length; return result; }
    const number = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (!number) throw new TypeError('python literal: unsupported value');
    i += number[0].length; return Number(number[0]);
  };
  expect('{'); const out = {};
  skip();
  if (s[i] === '}') { i += 1; return out; }
  for (;;) {
    const key = string(); expect(':'); out[key] = value(); skip();
    if (s[i] === ',') { i += 1; skip(); if (s[i] === '}') { i += 1; break; } continue; }
    expect('}'); break;
  }
  skip();
  if (i !== s.length) throw new TypeError('python literal: trailing text');
  return out;
}

/**
 * The 32k PersonaMem-v2 history is one flat message list: no session
 * boundaries and no timestamps (recorded in `structure`). Its leading system
 * message is the full persona and would hand over the answer; it is removed
 * from runtime input and kept in gold only. A system message anywhere else is
 * an unknown format and fails.
 */
export function personaMemRuntimeInput(row, history, { index } = {}) {
  const personaId = text(String(row.persona_id ?? ''), 'persona id');
  const messages = list(history.chat_history, 'chat history');
  if (messages[0]?.role !== 'system') throw new TypeError('PersonaMem history does not start with its persona system message');
  const rest = messages.slice(1);
  if (rest.some(message => message?.role === 'system')) throw new TypeError('unexpected system message inside the PersonaMem history');
  const query = pythonLiteralDict(text(row.user_query, 'user query'));
  if (query.role !== 'user') throw new TypeError('PersonaMem query must be a user message');
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('PersonaMem row index is required');
  return {
    schema: INPUT_SCHEMA, benchmark: 'personamem-v2-32k', id: `persona${personaId}:q${index}`,
    question: { text: nonemptyQuestion(query.content), asOf: null },
    structure: NO_STRUCTURE, conversationKey: `persona${personaId}`,
    histories: [{ sourceSessionId: `persona${personaId}`, at: null, messages: messagesOf(rest) }],
  };
}

export function personaMemGold(row, history, { index } = {}) {
  const personaId = text(String(row.persona_id ?? ''), 'persona id');
  const system = list(history.chat_history, 'chat history')[0];
  if (system?.role !== 'system') throw new TypeError('PersonaMem history does not start with its persona system message');
  const parsed = value => { try { return JSON.parse(value); } catch { return value; } };
  return structuredClone({
    id: `persona${personaId}:q${index}`, row_index: index, persona_id: personaId, question: row.user_query,
    correct_answer: row.correct_answer, incorrect_answers: parsed(row.incorrect_answers),
    preference: row.preference, topic_preference: row.topic_preference, topic_query: row.topic_query, pref_type: row.pref_type,
    who: row.who, updated: row.updated, prev_pref: row.prev_pref, sensitive_info: row.sensitive_info,
    conversation_scenario: row.conversation_scenario, related_conversation_snippet: row.related_conversation_snippet,
    short_persona: row.short_persona, expanded_persona: row.expanded_persona, persona_system_message: system.content ?? '',
  });
}

// --- MemSyco-Bench ---------------------------------------------------------

/** One sample is one short dialogue with no session boundary and no date; the task type rides along for the harness only. */
export function memSycoRuntimeInput(row) {
  const id = text(row.id, 'sample id');
  return {
    schema: INPUT_SCHEMA, benchmark: 'memsyco-bench', id,
    question: { text: nonemptyQuestion(row.question), asOf: null },
    harnessMeta: { task: text(row.task, 'task') }, structure: NO_STRUCTURE, conversationKey: id,
    histories: [{ sourceSessionId: id, at: null, messages: messagesOf(row.dialogue) }],
  };
}

/** The memory block (policy and ideal items) and the rubric are gold: either one in a runtime would answer the task. */
export function memSycoGold(row) {
  return structuredClone({ id: text(row.id, 'sample id'), task: row.task, question: row.question, memory: row.memory, evaluation: row.evaluation, metadata: row.metadata });
}
