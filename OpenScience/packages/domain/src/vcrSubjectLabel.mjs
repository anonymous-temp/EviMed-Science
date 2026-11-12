/**
 * What a person reads for a study's subject: `P-` and a few digits, the same on every page and in every sentence a conversation says to them.
 *
 * Hidden knowledge:
 *
 * - **The key is the identity and never changes.** A subject's key (`P` and sixteen hex digits of an HMAC of the source's id, `pseudonymOf`) is what every
 *   stored row, every tool argument and every link carries. The label is a reading of it: its first six digits, upper case, extended one digit at a time for
 *   the subjects of a study whose first digits agree, so that no two people of one study read alike. A key of another form (a seeded `P-0192`, a name a
 *   source gave) is its own label.
 * - **Labels are decided by the roster that is at hand.** With the whole roster the labels are unique; with one key alone they are the six digits, which
 *   is what the roster would give unless another subject shares them (about one pair in sixteen million). The roster is never needed to find a person.
 *
 * @module vcrSubjectLabel
 */

const KEY = /^P([0-9a-f]{16})$/u;
const SHORTEST = 6;

/**
 * The label of one subject key, read alone.
 * @param {unknown} subjectKey
 * @returns {string}
 */
export function vcrSubjectLabel(subjectKey) {
  const key = String(subjectKey ?? '');
  const match = KEY.exec(key);
  return match ? `P-${match[1].slice(0, SHORTEST).toUpperCase()}` : key;
}

/**
 * The labels of a roster, unique within it: the same digits for the same key whatever else is in the roster, longer only for the keys that share a shorter form.
 * @param {Iterable<unknown>} subjectKeys
 * @returns {Map<string, string>} label by key
 */
export function vcrSubjectLabels(subjectKeys) {
  const keys = [...new Set([...subjectKeys].map((key) => String(key ?? '')).filter(Boolean))].sort();
  /** @type {Map<string, string>} */
  const labels = new Map();
  const hexOf = (/** @type {string} */ key) => KEY.exec(key)?.[1] ?? null;
  for (let length = SHORTEST; length <= 16; length += 1) {
    /** @type {Map<string, string[]>} */
    const groups = new Map();
    for (const key of keys) {
      const hex = hexOf(key);
      if (!hex || labels.has(key)) continue;
      const label = `P-${hex.slice(0, length).toUpperCase()}`;
      groups.set(label, [...(groups.get(label) ?? []), key]);
    }
    for (const [label, members] of groups) if (members.length === 1 || length === 16) for (const key of members) labels.set(key, label);
    // A short form two keys share is held by neither: both read longer, so that the label still names one person.
    if (![...groups.values()].some((members) => members.length > 1)) break;
  }
  for (const key of keys) if (!labels.has(key)) labels.set(key, key);
  return labels;
}
