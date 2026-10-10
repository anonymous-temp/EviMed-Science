import { createHash } from 'node:crypto';
/** Read windows overlap so a boundary does not separate a negation or unit.
 * This records what was served, not a claim that the model extracted every fact.
 * @param {string} source @param {number} offset @param {number} [limit] */
export function clinicalDocumentWindow(source, offset, limit = 20_000) {
  const boundary = index => index > 0 && index < source.length && /[\uD800-\uDBFF]/.test(source[index - 1]) && /[\uDC00-\uDFFF]/.test(source[index]);
  let start = Math.min(source.length, Math.max(0, Math.trunc(offset)));
  if (boundary(start)) start -= 1;
  let end = Math.min(source.length, start + limit);
  if (boundary(end)) end -= 1;
  const text = source.slice(start, end);
  let nextOffset = end < source.length ? Math.max(start + 1, end - Math.min(512, Math.floor(limit / 4))) : null;
  if (nextOffset !== null && boundary(nextOffset)) nextOffset -= 1;
  return { text, offset: start, end, nextOffset, more: nextOffset !== null, offsetUnit: 'utf16',
    windowHash: createHash('sha256').update(text).digest('hex'),
    coverage: { served: [start, end], extraction: 'unknown', before: start, after: source.length - end } };
}
