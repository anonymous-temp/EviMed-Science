/**
 * Adapters for the sets added on 2026-11-09 (MedMemoryBench Hugging Face version, MedLoCoMo, the English brand/generic
 * probe, WildChat pseudo-users). Same contract as inputs.mjs: runtime input carries roles, original dates and the question
 * only; answers, labels and annotations go to gold functions that run in the scorer process. Nothing here translates,
 * repairs or drops a source row.
 */
import { createHash } from 'node:crypto';

const INPUT_SCHEMA = 'capsule-proving-input/1';
const sha = value => createHash('sha256').update(value).digest('hex');

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be nonempty text`);
  return value;
}
function list(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}
function plainMessage(message) {
  if (!['user', 'assistant'].includes(message?.role)) throw new TypeError('unsupported source role');
  const content = message.content ?? message.text ?? null;
  if (content != null && typeof content !== 'string') throw new TypeError('message content must be text or null');
  return { role: message.role, text: content ?? '' };
}
const parsed = value => (typeof value === 'string' ? JSON.parse(value) : value);

// --- MedMemoryBench, Hugging Face / paper version (1,939 questions per language) -----------------------------------

/** Language-neutral key: the same question has the same key in zh and en, so one frozen split serves both. */
export const medMemoryHfKey = query => `persona_${query.persona_id}:${text(query.query_id, 'query id')}`;

/**
 * `turnRows` are the flat rows of dialogues.parquet (or dialogues_with_noise.parquet) of ONE persona: persona_id,
 * session_id, turn, role, content, event_info. A question sees every session up to and including its anchor session; an
 * anchor that is absent from the dialogue is an error, never "all history". `session_type`, `knowledge_points` and
 * `event_info` text other than the date never reach the input.
 */
export function medMemoryHfRuntimeInput(turnRows, query, { language }) {
  if (!['zh', 'en'].includes(language)) throw new TypeError('medical source language must be zh or en');
  const personaId = query.persona_id;
  const bySession = new Map();
  for (const row of list(turnRows, 'dialogue turns')) {
    if (row.persona_id !== personaId) throw new TypeError('dialogue row belongs to another persona');
    if (!Number.isSafeInteger(row.session_id)) throw new TypeError('dialogue row has no numeric session id');
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
    bySession.get(row.session_id).push(row);
  }
  const anchor = query.session_id;
  if (!bySession.has(anchor)) throw new TypeError('question anchor is missing from the source dialogue');
  const ids = [...bySession.keys()].filter(id => id <= anchor).sort((a, b) => a - b);
  const histories = ids.map(id => {
    const rows = [...bySession.get(id)].sort((a, b) => a.turn - b.turn);
    const info = parsed(rows[0].event_info);
    return { sourceSessionId: `session_${id}`, at: info?.date ?? info?.event_date ?? null, messages: rows.map(plainMessage) };
  });
  return { schema: INPUT_SCHEMA, benchmark: 'medmemorybench-hf', id: `${language}:${medMemoryHfKey(query)}`,
    question: { text: text(query.question, 'question'), asOf: histories.at(-1).at }, conversationKey: `${language}:persona_${personaId}`, histories };
}

export function medMemoryHfGold(query, { language }) {
  return structuredClone({ id: `${language}:${medMemoryHfKey(query)}`, query_id: query.query_id, session_id: query.session_id,
    question: text(query.question, 'question'), query_type: query.query_type, answers: list(parsed(query.answers), 'official answers'),
    source_key_points: parsed(query.source_key_points), metadata: parsed(query.metadata) });
}

// --- WildChat pseudo-users -------------------------------------------------------------------------------------------

/**
 * One pseudo-user (a hashed-IP + header key, not a person) as a runtime input without a question: sessions are the
 * user's conversations in time order. WildChat's `timestamp` is the time of the conversation's last turn, recorded in
 * `structure`. Feeds the write-quality and silent-zero audits; there is no gold.
 */
export function wildChatPseudoUserRuntimeInput(user) {
  const id = text(user.pseudoUserId, 'pseudo-user id');
  const conversations = list(user.conversations, 'conversations');
  if (conversations.length < 1) throw new TypeError('a pseudo-user has no conversations');
  const ordered = [...conversations].sort((a, b) => (text(a.timestamp, 'timestamp') < text(b.timestamp, 'timestamp') ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { schema: INPUT_SCHEMA, benchmark: 'wildchat-pseudo-users', id: `wildchat:${id}`, question: null,
    structure: { sessionBoundaries: true, timestamps: true, timestampMeaning: 'last-turn', pseudoUser: true }, conversationKey: id,
    histories: ordered.map(conversation => ({ sourceSessionId: text(conversation.conversationHash, 'conversation hash'), at: conversation.timestamp,
      messages: list(conversation.messages, 'messages').map(plainMessage) })) };
}


// --- English brand/generic memory-form probe (RABBITS drug pairs, templates written by Kimi) ---------------------------

export const DRUG_SLOT = '{drug}';
/** A template is usable only with exactly one {drug} slot and no other brace. */
export const templateOk = template => typeof template === 'string' && template.split(DRUG_SLOT).length === 2 && !/[{}]/.test(template.replace(DRUG_SLOT, ''));

/**
 * generic_to_brand.csv of RABBITS: `generic,brand` with brand written as a Python list of lists. A pair is kept when the
 * generic is one lowercase word and the first brand is one alphabetic word of 4+ letters different from the generic; a
 * brand that appears under two generics is dropped on both (the pair would be ambiguous). Order follows the file.
 */
export function rabbitsPairs(csvText) {
  const lines = text(csvText, 'pairs csv').split('\n').filter(Boolean);
  if (lines[0].trim() !== 'generic,brand') throw new TypeError('unexpected RABBITS pair header');
  const pairs = [];
  for (const line of lines.slice(1)) {
    const at = line.indexOf(',');
    const generic = line.slice(0, at).trim().toLowerCase();
    const brands = [...line.slice(at + 1).matchAll(/'([^']+)'/g)].map(match => match[1].trim().toLowerCase());
    const brand = brands.find(name => /^[a-z]{4,}$/.test(name));
    if (/^[a-z]{4,}$/.test(generic) && brand && brand !== generic) pairs.push({ generic, brand });
  }
  const count = new Map();
  for (const pair of pairs) count.set(pair.brand, (count.get(pair.brand) ?? 0) + 1);
  const unique = new Set(); const out = [];
  for (const pair of pairs) if (count.get(pair.brand) === 1 && !unique.has(pair.generic)) { unique.add(pair.generic); out.push(pair); }
  return out;
}

const title = word => word[0].toUpperCase() + word.slice(1);
const pick = (seed, key, size) => Number.parseInt(sha(`${seed}|${key}`).slice(0, 8), 16) % size;

/** One item per pair: the person states one name (a statement template) and later asks with the other (a question template). */
export function buildBrandGenericItems(pairs, templates, { seed }) {
  const statements = list(templates.statements, 'statement templates'); const questions = list(templates.questions, 'question templates');
  if (![...statements, ...questions].every(templateOk)) throw new TypeError('every template needs exactly one {drug} slot');
  if (!statements.length || !questions.length) throw new TypeError('both template kinds are required');
  return pairs.map(pair => {
    const direction = pick(seed, `${pair.generic}|direction`, 2) === 0 ? 'brand-to-generic' : 'generic-to-brand';
    const [stated, asked] = direction === 'brand-to-generic' ? [pair.brand, pair.generic] : [pair.generic, pair.brand];
    const display = (name, kind) => (kind === 'brand' ? title(name) : name);
    const [statedKind, askedKind] = direction === 'brand-to-generic' ? ['brand', 'generic'] : ['generic', 'brand'];
    const statementIndex = pick(seed, `${pair.generic}|statement`, statements.length);
    const questionIndex = pick(seed, `${pair.generic}|question`, questions.length);
    return { id: `bgp:${pair.generic}:${direction}`, generic: pair.generic, brand: pair.brand, direction, stated, asked, statedKind, askedKind, statementIndex, questionIndex,
      statementText: statements[statementIndex].replace(DRUG_SLOT, display(stated, statedKind)),
      questionText: questions[questionIndex].replace(DRUG_SLOT, display(asked, askedKind)) };
  });
}

/** Runtime input: the statement as one dated-less user message and the question; no pair, direction or gold. */
export function brandGenericRuntimeInput(item) {
  const id = text(item.id, 'item id');
  return { schema: INPUT_SCHEMA, benchmark: 'brand-generic-probe', id, question: { text: text(item.questionText, 'question'), asOf: null },
    structure: { sessionBoundaries: false, timestamps: false }, conversationKey: id,
    histories: [{ sourceSessionId: id, at: null, messages: [{ role: 'user', text: text(item.statementText, 'statement') }] }] };
}

export function brandGenericGold(item) {
  return { id: item.id, generic: item.generic, brand: item.brand, direction: item.direction, stated: item.stated, asked: item.asked,
    accept: [item.stated, item.asked], bridge: [item.stated] };
}

const hasWord = (reply, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(reply);
/**
 * Code-decidable scoring. `pass` is the plan's check (the reply names the stated name or its pair); `bridged` is the
 * stricter memory signal: the reply names the stated form although the question used the other one.
 */
export function brandGenericScore(gold, reply) {
  const containsStated = hasWord(text(reply, 'reply'), gold.stated); const containsAsked = hasWord(reply, gold.asked);
  return { containsStated, containsAsked, pass: containsStated || containsAsked, bridged: containsStated };
}

// --- MedLoCoMo (English, derived from MIMIC-IV; keep local) -----------------------------------------------------------

const MEDLOCOMO_ROLES = { Patient: 'user', Doctor: 'assistant' };

/**
 * One question over a patient's whole conversation: each admission is a session dated by its start, the patient is the
 * `user` and the doctor the `assistant` (fixed mapping, recorded). Single-admission questions name their admission dates in
 * the question text and are asked over the full history like the official protocol. Evidence and answers stay in gold.
 */
export function medLoCoMoRuntimeInput(patient, qa) {
  const subject = text(String(patient.subject_id ?? ''), 'subject id');
  const admissions = [...list(patient.admissions, 'admissions')].sort((a, b) => (text(a.admission_start, 'admission start') < b.admission_start ? -1 : a.admission_start > b.admission_start ? 1 : 0));
  return { schema: INPUT_SCHEMA, benchmark: 'medlocomo', id: text(qa.qa_id, 'qa id'), question: { text: text(qa.question, 'question'), asOf: null },
    roleMapping: { rule: 'Patient=user, Doctor=assistant', user: 'Patient', assistant: 'Doctor' }, conversationKey: subject,
    histories: admissions.map(admission => ({ sourceSessionId: text(String(admission.hadm_id ?? ''), 'hadm id'), at: admission.admission_start,
      messages: list(admission.conversation_lines, 'conversation lines').map(line => {
        const role = MEDLOCOMO_ROLES[line?.speaker];
        if (!role) throw new TypeError('unknown MedLoCoMo speaker');
        if (line.text != null && typeof line.text !== 'string') throw new TypeError('message content must be text or null');
        return { role, text: line.text ?? '', at: line.time ?? null };
      }) })) };
}

export function medLoCoMoGold(qa) {
  return structuredClone({ id: text(qa.qa_id, 'qa id'), question: qa.question, scope: qa.scope, question_type: qa.question_type, adversarial: qa.question_type === 'adversarial',
    answer: qa.answer, evidence: qa.evidence });
}
