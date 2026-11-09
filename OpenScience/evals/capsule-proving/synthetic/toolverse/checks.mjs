/** Validators over the model-written text: every check is exact string work on values the code fabricated. */
import { intermediateValues, userValues } from './env.mjs';

const flat = (v) => (Array.isArray(v) ? v.map(String) : [String(v)]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Verbatim mention; a value made of ASCII letters or digits must not sit inside a longer such token. */
export function mentions(text, value) {
  const v = String(value);
  if (!v) return false;
  return /^[\x20-\x7e]+$/.test(v) ? new RegExp(`(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])`).test(text) : text.includes(v);
}
const cjkShare = (t) => ((t.match(/[一-鿿]/g) || []).length) / Math.max(1, t.length);
const toolNameHits = (task, text) => [...new Set(task.steps.map((s) => s.tool))].filter((n) => text.includes(n));

/** Problems of a request: known user values stated verbatim, removed ones and intermediates absent, no tool names. */
export function requestProblems(task, request, { removed = [], lang = 'zh' } = {}) {
  const out = [];
  if (typeof request !== 'string' || request.trim().length < 8 || request.length > 400) return ['request is missing or has a bad length'];
  if (lang !== 'en' && cjkShare(request) < 0.15) out.push('request is not mainly Simplified Chinese');
  const gone = new Set(removed.map((r) => `${r.step}:${r.param}`));
  for (const u of userValues(task)) {
    const absent = gone.has(`${u.step}:${u.param}`);
    for (const v of flat(u.value)) {
      if (absent && mentions(request, v)) out.push(`request states the withheld value of ${u.param}`);
      if (!absent && !mentions(request, v)) out.push(`request lacks the value of ${u.param} verbatim`);
    }
  }
  for (const i of intermediateValues(task)) for (const v of flat(i.value)) if (mentions(request, v)) out.push(`request states a tool-produced value (${i.param})`);
  const names = toolNameHits(task, request);
  if (names.length) out.push(`request names a tool: ${names.join(',')}`);
  return out;
}

/** Messages must carry no tool name and no tool-produced value. */
function cleanText(task, text, label) {
  const out = [];
  for (const i of intermediateValues(task)) for (const v of flat(i.value)) if (mentions(text, v)) out.push(`${label} states a tool-produced value`);
  if (toolNameHits(task, text).length) out.push(`${label} names a tool`);
  return [...new Set(out)];
}

/** Sessions: 1-2, each 2-8 messages; every removed value appears verbatim in a user message. */
export function sessionsProblems(task, sessions, removed, { carryValues = true } = {}) {
  const out = [];
  if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 2) return ['sessions must be 1 or 2'];
  const users = [];
  const all = [];
  for (const s of sessions) {
    const ms = s?.messages;
    if (!Array.isArray(ms) || ms.length < 2 || ms.length > 8) { out.push('a session needs 2-8 messages'); continue; }
    for (const m of ms) {
      if (!['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string' || !m.content.trim()) { out.push('bad message'); continue; }
      all.push(m.content);
      if (m.role === 'user') users.push(m.content);
    }
  }
  for (const r of removed) {
    const there = users.some((t) => mentions(t, r.value));
    if (carryValues && !there) out.push(`no user message states the value of ${r.param}`);
    if (!carryValues && all.some((t) => mentions(t, r.value))) out.push(`a distractor session states the value of ${r.param}`);
  }
  out.push(...cleanText(task, all.join('\n'), 'sessions'));
  if (cjkShare(all.join('')) < 0.15) out.push('sessions are not mainly Chinese');
  return [...new Set(out)];
}

/** Rule card: title and body; the body states every removed value verbatim and names no tool. */
export function cardProblems(task, card, removed) {
  const out = [];
  if (!card || typeof card.title !== 'string' || typeof card.body !== 'string' || !card.title.trim() || !card.body.trim()) return ['card needs a title and a body'];
  if (card.body.length > 160) out.push('card body is longer than 160 characters');
  for (const r of removed) if (!mentions(card.body, r.value)) out.push(`card body lacks the value of ${r.param}`);
  out.push(...cleanText(task, `${card.title}\n${card.body}`, 'card'));
  if (cjkShare(card.body) < 0.15) out.push('card is not mainly Chinese');
  return [...new Set(out)];
}
