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
    return { role: message.role, text: text(message.content, 'message content') };
  });
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
  return structuredClone({ question_id: text(row.question_id, 'question id'), question_type: row.question_type,
    question_date: row.question_date, answer: row.answer, answer_session_ids: row.answer_session_ids });
}

/** A question at one medical session sees that original prefix, never later sessions or key points. */
export function medMemoryRuntimeInput(dialogues, query, { language, persona }) {
  if (!['zh', 'en'].includes(language)) throw new TypeError('medical source language must be zh or en');
  text(persona, 'persona');
  const sessions = list(dialogues.sessions, 'medical sessions');
  const ids = uniqueIds(sessions.map(session => session.session_id), 'medical session id');
  const anchor = ids.indexOf(text(query.session_id, 'question source session'));
  if (anchor === -1) throw new TypeError('question anchor is missing from the source dialogue');
  const histories = sessions.slice(0, anchor + 1).map(session => ({
    sourceSessionId: session.session_id, at: sourceDate(session.event_info?.date), messages: messagesOf(session.messages),
  }));
  return { schema: INPUT_SCHEMA, benchmark: 'medmemorybench', id: `${language}:${persona}:${text(query.query_id, 'query id')}`,
    question: { text: text(query.question, 'question'), asOf: histories.at(-1).at }, histories };
}

/** Preserve official scoring inputs separately, including correctness flags and deduction metadata. */
export function medMemoryGold(query) {
  return structuredClone({ query_id: text(query.query_id, 'query id'), query_type: query.query_type,
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
 */
export function registerQuestionPools(rows, { seed, developmentCount, sourceSha256 }) {
  text(seed, 'pool seed');
  if (typeof sourceSha256 !== 'string' || !SHA256.test(sourceSha256)) throw new TypeError('source digest must be SHA256');
  const source = list(rows, 'source questions');
  const ids = uniqueIds(source.map(row => row.question_id), 'question id');
  if (!Number.isSafeInteger(developmentCount) || developmentCount < 1 || developmentCount >= ids.length) {
    throw new TypeError('development and confirmation must both contain questions');
  }
  const ranked = ids.map(id => ({ id, rank: hash(`${seed}|${id}`) })).sort((a, b) => compare(a.rank, b.rank) || compare(a.id, b.id));
  const selected = new Set(ranked.slice(0, developmentCount).map(item => item.id));
  const document = {
    schema: POOL_SCHEMA, benchmark: 'longmemeval-s', seed, sourceSha256, universe: ids.length,
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
