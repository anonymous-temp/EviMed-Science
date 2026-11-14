import { hardTokens } from './nativeMemoryHardTokens.mjs';
import { lineFingerprint, memoryLines, normalisedStatement } from './nativeMemoryOverlay.mjs';

/** @typedef {'restored'|'kept_deleted_rejected'|'kept_deleted_replaced'|'kept_deleted_grounded'|'kept_deleted_never_kept'|'kept_deleted_moved'|'skipped_large'} KeepLineOutcome */

const CJK_STOP_CHARACTERS = Object.freeze([...new Set('的了是在我你他她它们这那和与及也都就还很不没有着过吧呢啊吗把被给对从到向于为以之其一个上下里中去来说要会能可')]);
const ENGLISH_STOP_WORDS = Object.freeze(['about', 'also', 'been', 'from', 'have', 'into', 'just', 'more', 'only', 'some',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'very', 'were', 'what', 'when', 'where',
  'which', 'will', 'with', 'would', 'your']);

/** Literal content overlap, with no similarity threshold or inferred meaning.
 * @param {string} value @returns {Set<string>} */
function contentTokens(value) {
  const normalized = normalisedStatement(value);
  const characters = [...normalized];
  const tokens = new Set((normalized.match(/\b[a-z]{4,}\b/g) ?? []).filter(word => !ENGLISH_STOP_WORDS.includes(word)));
  for (let index = 1; index < characters.length; index++) {
    const left = characters[index - 1], right = characters[index];
    if (/^\p{Script=Han}{2}$/u.test(left + right)
      && !(CJK_STOP_CHARACTERS.includes(left) && CJK_STOP_CHARACTERS.includes(right))) tokens.add(left + right);
  }
  return tokens;
}

/** @param {string} left @param {string} right */
function sharesContent(left, right) {
  const tokens = contentTokens(left);
  return [...contentTokens(right)].some(token => tokens.has(token));
}

/** LCS anchors separate change hunks; no unchanged context joins adjacent hunks.
 * The caller caps the before-image at 200 statements, so LCS lengths fit in Uint16.
 * @param {readonly string[]} prior @param {readonly string[]} current
 * @returns {{replaced:Set<string>,added:string[]}} */
function lineChanges(prior, current) {
  const beforePrints = prior.map(lineFingerprint), afterPrints = current.map(lineFingerprint);
  const lengths = Array.from({ length: prior.length + 1 }, () => new Uint16Array(current.length + 1));
  for (let row = prior.length - 1; row >= 0; row--) {
    for (let column = current.length - 1; column >= 0; column--) {
      lengths[row][column] = beforePrints[row] === afterPrints[column]
        ? lengths[row + 1][column + 1] + 1 : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
    }
  }
  /** @type {Set<string>} */
  const replaced = new Set();
  /** @type {string[]} */
  const added = [];
  let left = 0, right = 0;
  while (left < prior.length || right < current.length) {
    if (left < prior.length && right < current.length && beforePrints[left] === afterPrints[right]) {
      left++; right++; continue;
    }
    /** @type {string[]} */
    const deleted = [];
    const addedStart = added.length;
    while ((left < prior.length || right < current.length)
      && !(left < prior.length && right < current.length && beforePrints[left] === afterPrints[right])) {
      // Prefer deletion on equal-length paths, making ambiguous LCS choices deterministic.
      if (left < prior.length && (right === current.length || lengths[left + 1][right] >= lengths[left][right + 1])) {
        deleted.push(beforePrints[left++]);
      } else added.push(current[right++]);
    }
    if (added.length > addedStart) for (const print of deleted) replaced.add(print);
  }
  return { replaced, added };
}

/** @param {string} left @param {string} right */
function sharesToken(left, right) {
  const tokens = new Set(hardTokens(normalisedStatement(left)));
  return hardTokens(normalisedStatement(right)).some(token => tokens.has(token));
}

/** Pure acceptance decision; callers supply existing privacy/removal authority, never a model.
 * `elsewhere` is the actual post-commit state of other files; additions come only from this file's diff.
 * @param {{enabled:boolean,before:string,after:string|null,neverKept:(text:string)=>boolean,
 * rejected?:ReadonlySet<string>,withdrawn?:ReadonlySet<string>,elsewhere?:ReadonlySet<string>,
 * messages?:readonly {role:string,text:string}[]}} input
 * @returns {{after:string|null,outcomes:KeepLineOutcome[]}} */
export function keepUnexplainedLines({ enabled, before, after, neverKept, rejected = new Set(), withdrawn = new Set(), elsewhere = new Set(), messages = [] }) {
  if (!enabled) return { after, outcomes: [] };
  const prior = memoryLines(before);
  if (prior.length > 200) return { after, outcomes: ['skipped_large'] };
  const current = memoryLines(after);
  const present = new Set(current.map(lineFingerprint));
  const { replaced, added } = lineChanges(prior, current);
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
    else if (replaced.has(print) || added.some(value => sharesToken(line, value) || sharesContent(line, value)
      || /(?:earlier:|曾为：)/i.test(value) && normalisedStatement(value).includes(normalisedStatement(line)))) outcome = /** @type {const} */ ('kept_deleted_replaced');
    else if (messages.some(message => message.role === 'user' && (sharesToken(line, message.text) || sharesContent(line, message.text)))) outcome = /** @type {const} */ ('kept_deleted_grounded');
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
