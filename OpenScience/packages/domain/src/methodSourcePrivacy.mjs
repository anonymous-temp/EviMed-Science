/** Reusable procedures have a different boundary from factual memory. A
 * contact may be useful to its owner; a method must not carry that person.
 * This format floor does not replace typed source privacy before distillation. */
import { identifierShapesIn } from './memoryVocabulary.mjs';

// The established contact formats, kept out of the factual never-kept policy.
const MOBILE = /(?<![0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![0-9])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** @param {unknown} text @returns {string[]} */
export function methodSourceIdentifierShapesIn(text) {
  const value = String(text ?? '');
  return [...new Set([...identifierShapesIn(value), ...(MOBILE.test(value) ? ['mobile'] : []), ...(EMAIL.test(value) ? ['email'] : [])])];
}
