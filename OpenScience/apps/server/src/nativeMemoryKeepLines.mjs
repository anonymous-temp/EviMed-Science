import { hardTokens, tokenPresent } from './nativeMemoryHardTokens.mjs';
import { lineFingerprint, memoryLines, normalisedStatement } from './nativeMemoryOverlay.mjs';

/** @typedef {'restored'|'kept_deleted_rejected'|'kept_deleted_replaced'|'kept_deleted_grounded'|'kept_deleted_never_kept'|'kept_deleted_moved'|'skipped_large'} KeepLineOutcome */

const CJK_STOP_CHARACTERS = Object.freeze([...new Set('的了是在我你他她它们这那和与及也都就还很不没有着过吧呢啊吗把被给对从到向于为以之其一个上下里中去来说要会能可')]);
const ENGLISH_STOP_WORDS = Object.freeze(['about', 'also', 'been', 'from', 'have', 'into', 'just', 'more', 'only', 'some',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'very', 'were', 'what', 'when', 'where',
  'which', 'will', 'with', 'would', 'your']);

/** Specific information must survive in the replacement itself. A shared topic, date or
 * change hunk is not evidence that a summary preserved its numbers, names or values.
 * CJK bigrams conservatively retain names that have no lexical identifier shape.
 * @param {string} before @param {string} after */
function preservesStatement(before, after) {
  const old = normalisedStatement(before), next = normalisedStatement(after);
  if (!hardTokens(before).every(token => tokenPresent(token, after))) return false;
  if (tokenPresent(old, next)) return true;
  const tokens = contentTokens(before), replacement = contentTokens(after);
  return tokens.size > 0 && [...tokens].every(token => replacement.has(token));
}

/** @param {string} value @returns {Set<string>} */
function contentTokens(value) {
  const normalized = normalisedStatement(value);
  const characters = [...normalized];
  const tokens = new Set((normalized.match(/\b[a-z]+\b/g) ?? []).filter(word => !ENGLISH_STOP_WORDS.includes(word)));
  for (let index = 1; index < characters.length; index++) {
    const left = characters[index - 1], right = characters[index];
    if (/^\p{Script=Han}{2}$/u.test(left + right)
      && !(CJK_STOP_CHARACTERS.includes(left) && CJK_STOP_CHARACTERS.includes(right))) tokens.add(left + right);
  }
  return tokens;
}

/** Linear-space change hunks anchored only by unchanged, unique lines in order.
 * Ambiguous/reordered anchors yield a larger conservative hunk, never a skipped file.
 * @param {readonly string[]} prior @param {readonly string[]} current */
function lineChanges(prior, current) {
  const before = prior.map(lineFingerprint), after = current.map(lineFingerprint);
  const counts = new Map(), positions = new Map();
  for (const print of before) counts.set(print, (counts.get(print) ?? 0) + 1);
  after.forEach((print, index) => positions.set(print, positions.has(print) ? -1 : index));
  const hunks = new Map();
  let left = 0, right = 0;
  for (let index = 0; index <= before.length; index++) {
    const at = index === before.length ? after.length : positions.get(before[index]);
    if (at === undefined || at < right || index < before.length && counts.get(before[index]) !== 1) continue;
    const added = current.slice(right, at);
    for (let deleted = left; deleted < index; deleted++) hunks.set(before[deleted], added);
    left = index + 1; right = at + 1;
  }
  return hunks;
}

/** @typedef {{enabled:boolean,before:string,after:string|null,neverKept:(text:string)=>boolean,
 * rejected?:ReadonlySet<string>,withdrawn?:ReadonlySet<string>,elsewhere?:ReadonlySet<string>,
 * messages?:readonly {role:string,text:string}[]}} KeepInput */

/** Unique Markdown headings that survive in the same order separate independent diff
 * regions. Without a stable heading the ordinary unique-line anchors still apply.
 * @param {string[]} before @param {string[]} after */
function sectionAnchors(before, after) {
  const unique = lines => {
    const byHeading = new Map();
    lines.forEach((line, i) => {
      const heading = line.trim();
      if (/^#{1,6}\s/.test(heading)) byHeading.set(heading, byHeading.has(heading) ? -1 : i);
    });
    return byHeading;
  };
  const positions = unique(after), anchors = [];
  let last = -1;
  for (const [heading, left] of unique(before)) {
    const right = positions.get(heading);
    if (left >= 0 && right > last) { anchors.push([left, right]); last = right; }
  }
  return anchors;
}

/** @param {KeepInput} input @returns {{after:string|null,outcomes:KeepLineOutcome[]}} */
export function keepUnexplainedLines(input) {
  if (!input.enabled) return { after: input.after, outcomes: [] };
  const before = input.before.split('\n');
  if (before.length <= 200 || input.after === null) return keepRegion(input);
  const after = input.after.split('\n'), anchors = sectionAnchors(before, after);
  if (!anchors.length) return keepRegion(input);
  const elsewhere = new Set([...(input.elsewhere ?? []), ...memoryLines(input.after).map(lineFingerprint)]);
  const history = memoryLines(input.after).filter(line => /(?:earlier:|曾为：)/i.test(line));
  const result = [], outcomes = [];
  let start = 0, at = 0;
  for (const [end, until] of [...anchors, [before.length, after.length]]) {
    const region = after.slice(at, until);
    if (end > start || region.length) {
      const kept = keepRegion({ ...input, elsewhere, before: before.slice(start, end).join('\n'),
        after: region.length ? region.join('\n') : null }, history);
      if (kept.after !== null) result.push(kept.after);
      outcomes.push(...kept.outcomes);
    }
    if (until < after.length) result.push(after[until]);
    at = until + 1; start = end + 1;
  }
  return { after: result.join('\n'), outcomes };
}

/** @param {KeepInput} input @param {readonly string[]} earlier */
function keepRegion({ before, after, neverKept, rejected = new Set(), withdrawn = new Set(), elsewhere = new Set() }, earlier = []) {
  const prior = memoryLines(before);
  const current = memoryLines(after);
  const present = new Set(current.map(lineFingerprint));
  const hunks = lineChanges(prior, current);
  const priorPrints = new Set(prior.map(lineFingerprint));
  const addedHistory = [...earlier, ...current.filter(line => !priorPrints.has(lineFingerprint(line)) && /(?:earlier:|曾为：)/i.test(line))];
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
    else if ((hunks.get(print) ?? []).some(value => preservesStatement(line, value))
      || addedHistory.some(value => preservesStatement(line, value))) outcome = /** @type {const} */ ('kept_deleted_replaced');
    // Only the existing withdrawal/rejection authority can explain a deletion. Mentioning
    // coffee or a project in this turn cannot authorize erasing its earlier details.
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
    const retained = original.filter(raw => {
      const heading = raw.trim().match(/^#{1,6}\s+(.+)$/);
      if (!heading) return !raw.trim() || restore.has(fingerprint(raw));
      const print = lineFingerprint(heading[1]);
      return !neverKept(heading[1]) && !rejected.has(print) && !withdrawn.has(print) && !withdrawn.has(fingerprint(raw));
    });
    return { after: retained.some(raw => raw.trim()) ? retained.join('\n') : null, outcomes };
  }
  const positions = new Map(result.map((raw, index) => [fingerprint(raw), index]));
  const nextAnchors = new Array(original.length);
  let nextAnchor = result.length;
  for (let index = original.length - 1; index >= 0; index--) {
    nextAnchors[index] = nextAnchor;
    if (positions.has(fingerprint(original[index]))) nextAnchor = positions.get(fingerprint(original[index]));
  }
  const insertions = new Map();
  let previousAnchor = -1;
  for (let index = 0; index < original.length; index++) {
    const raw = original[index], print = fingerprint(raw);
    if (positions.has(print)) previousAnchor = positions.get(print);
    if (!restore.has(print)) continue;
    const next = nextAnchors[index];
    const at = next < result.length ? next : previousAnchor >= 0 ? previousAnchor + 1 : result.length;
    if (!insertions.has(at)) insertions.set(at, []);
    insertions.get(at).push(raw);
    restore.delete(print);
  }
  const combined = [];
  for (let index = 0; index <= result.length; index++) {
    combined.push(...(insertions.get(index) ?? []));
    if (index < result.length) combined.push(result[index]);
  }
  return { after: combined.join('\n'), outcomes };
}
