/** Reusable procedures have a different boundary from factual memory. A
 * contact may be useful to its owner; a method must not carry that person.
 * This format floor does not replace typed source privacy before distillation. */
import { identifierShapesIn, maskIdentifiers } from './memoryVocabulary.mjs';

// The established contact formats, kept out of the factual never-kept policy.
const MOBILE = /(?<![0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![0-9])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** @param {unknown} text @returns {string[]} */
export function methodSourceIdentifierShapesIn(text) {
  const value = String(text ?? '');
  return [...new Set([...identifierShapesIn(value), ...(MOBILE.test(value) ? ['mobile'] : []), ...(EMAIL.test(value) ? ['email'] : [])])];
}

/**
 * A text that leaves the deployment for a third party (a registry search, a reranker query, a model's view of a patient record) with
 * the identifier shapes `maskIdentifiers` replaces and the contact formats as well: what memory may keep for its owner is not what a
 * public registry is sent (2026-11-10: a search term carrying a mobile number reached the registries once the memory policy kept contacts).
 * @param {unknown} text @returns {string}
 */
export function maskOutboundIdentifiers(text) {
  return maskIdentifiers(text).replace(new RegExp(MOBILE.source, 'g'), '[已省略]').replace(new RegExp(EMAIL.source, 'g'), '[已省略]');
}
