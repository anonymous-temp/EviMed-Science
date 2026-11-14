import { hardTokens } from './nativeMemoryHardTokens.mjs';
import { lineFingerprint, memoryLines, normalisedStatement } from './nativeMemoryOverlay.mjs';

/** @typedef {'restored'|'kept_deleted_rejected'|'kept_deleted_replaced'|'kept_deleted_grounded'|'kept_deleted_never_kept'|'kept_deleted_moved'|'skipped_large'} KeepLineOutcome */

/** Character-bigram Jaccard after exactly the store's statement normalization.
 * @param {string} left @param {string} right */
export function lineJaccard(left, right) {
  /** @param {string} value */
  const pairs = value => {
    const characters = [...normalisedStatement(value)];
    return new Set(characters.slice(1).map((character, index) => characters[index] + character));
  };
  const a = pairs(left), b = pairs(right);
  const intersection = [...a].filter(pair => b.has(pair)).length;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

/** @param {string} left @param {string} right */
function sharesToken(left, right) {
  const tokens = new Set(hardTokens(normalisedStatement(left)));
  return hardTokens(normalisedStatement(right)).some(token => tokens.has(token));
}

/** Pure acceptance decision; callers supply existing privacy/removal authority, never a model.
 * `elsewhere` is the actual post-commit state of other files; `added` excludes unchanged lines.
 * @param {{enabled:boolean,before:string,after:string|null,neverKept:(text:string)=>boolean,
 * rejected?:ReadonlySet<string>,withdrawn?:ReadonlySet<string>,elsewhere?:ReadonlySet<string>,
 * added?:readonly string[],messages?:readonly {role:string,text:string}[]}} input
 * @returns {{after:string|null,outcomes:KeepLineOutcome[]}} */
export function keepUnexplainedLines({ enabled, before, after, neverKept, rejected = new Set(), withdrawn = new Set(), elsewhere = new Set(), added = [], messages = [] }) {
  if (!enabled) return { after, outcomes: [] };
  const prior = memoryLines(before);
  if (prior.length > 200) return { after, outcomes: ['skipped_large'] };
  const present = new Set(memoryLines(after).map(lineFingerprint));
  /** @type {KeepLineOutcome[]} */
  const outcomes = [];
  /** @type {Set<string>} */
  const restore = new Set();
  for (const line of prior) {
    const print = lineFingerprint(line);
    if (present.has(print)) continue;
    let outcome;
    if (neverKept(line)) outcome = /** @type {const} */ ('kept_deleted_never_kept');
    else if (rejected.has(print) || withdrawn.has(print)) outcome = /** @type {const} */ ('kept_deleted_rejected');
    else if (elsewhere.has(print)) outcome = /** @type {const} */ ('kept_deleted_moved');
    else if (added.some(value => sharesToken(line, value) || lineJaccard(line, value) >= 0.5
      || /(?:earlier:|曾为：)/i.test(value) && normalisedStatement(value).includes(normalisedStatement(line)))) outcome = /** @type {const} */ ('kept_deleted_replaced');
    else if (messages.some(message => message.role === 'user' && (sharesToken(line, message.text) || lineJaccard(line, message.text) >= 0.3))) outcome = /** @type {const} */ ('kept_deleted_grounded');
    else { outcome = /** @type {const} */ ('restored'); restore.add(print); }
    outcomes.push(outcome);
  }
  if (!restore.size) return { after, outcomes };
  const original = before.split('\n');
  const result = after === null ? [] : after.split('\n');
  /** Match a raw line using the same bullet removal as memoryLines (including headings for anchors).
   * @param {string} raw */
  const fingerprint = raw => lineFingerprint(memoryLines(raw)[0] ?? '');
  if (after === null) {
    // Preserve the deleted file's layout only when at least one statement must survive.
    return { after: original.filter(raw => !raw.trim() || /^\s*#{1,6}\s/.test(raw) || restore.has(fingerprint(raw))).join('\n'), outcomes };
  }
  for (let index = 0; index < original.length; index++) {
    const raw = original[index], print = fingerprint(raw);
    if (!restore.has(print)) continue;
    const next = original.slice(index + 1).map(fingerprint).find(candidate => result.some(value => fingerprint(value) === candidate));
    let at = next === undefined ? -1 : result.findIndex(value => fingerprint(value) === next);
    if (at < 0) {
      const previous = original.slice(0, index).reverse().map(fingerprint).find(candidate => result.some(value => fingerprint(value) === candidate));
      at = previous === undefined ? Math.min(index, result.length) : result.findLastIndex(value => fingerprint(value) === previous) + 1;
    }
    result.splice(at, 0, raw);
    restore.delete(print);
  }
  return { after: result.join('\n'), outcomes };
}
