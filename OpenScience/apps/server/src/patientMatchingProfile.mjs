/** The patient text discovery ranks with: the whole record when it is short, otherwise a profile summary or the newest sentences. */

/** Characters of a record the profile summary reads, newest first. */
export const PROFILE_INPUT_CHARS = 60000;

/** @param {string} value sentences, each keeping its terminator; a line break also ends one. */
function sentences(value) {
  return (value.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n|$)/g) ?? []).map(part => part.trim()).filter(Boolean);
}

/**
 * The newest whole sentences of the passages that fit in `budget` characters, in chronological order (passages separated by a line break,
 * sentences inside one by a space). A sentence is never cut; the first one that does not fit ends the window.
 * @param {Array<{text?: string}>} passages oldest first
 * @param {number} budget
 */
export function newestWindow(passages, budget) {
  /** @type {string[]} */ const kept = [];
  let used = 0;
  outer: for (let at = passages.length - 1; at >= 0; at -= 1) {
    const parts = sentences(String(passages[at]?.text ?? ''));
    /** @type {string[]} */ const taken = [];
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      const cost = parts[part].length + 1;
      if (used + cost > budget) { if (taken.length) kept.push(taken.reverse().join(' ')); break outer; }
      used += cost;
      taken.push(parts[part]);
    }
    if (taken.length) kept.push(taken.reverse().join(' '));
  }
  return kept.reverse().join('\n');
}

/** Whether the query and passages together exceed `budget` characters, so that discovery needs a profile summary. @param {{query: string, passages?: Array<{text?: string}>, budget?: number}} input */
export function recordIsLong({ query, passages = [], budget = 6000 }) {
  return (query + '\n' + passages.map(passage => passage.text).join('\n')).length > budget;
}

/**
 * The text that stands for the patient in the dense query, the rerank query and Jev's patient note. Within `budget` characters it is the query
 * and the passages joined, exactly as before; over it, the query and the profile summary, or without one the query and the newest sentences.
 * @param {{query: string, passages?: Array<{text?: string}>, profile?: string | {text?: string} | null, budget?: number}} input
 */
export function patientRankingText({ query, passages = [], profile = null, budget = 6000 }) {
  const whole = query + '\n' + passages.map(passage => passage.text).join('\n');
  if (whole.length <= budget) return whole;
  const summary = (typeof profile === 'string' ? profile : profile?.text ?? '').trim();
  if (summary) return query + '\n' + summary;
  return query + '\n' + newestWindow(passages, Math.max(0, budget - query.length - 1));
}
