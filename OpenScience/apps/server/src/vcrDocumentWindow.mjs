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

/**
 * How much of a document the windows served to runs cover, and how much was never served. The union of the served ranges
 * across every read (overlapping windows and repeated reads count once), over the text's length: that length as the windows
 * recorded it, else the caller's, else unknown. It describes what a run was shown, not what it extracted: a served window is
 * no claim that every fact in it was written down (the windows say `extraction: "unknown"`).
 * @param {readonly { served?: unknown, chars?: unknown }[]} windows the recorded windows, from every conversation that read it
 * @param {number | null} [chars] the length of the text when the windows did not record it
 * @returns {{ chars: number | null, read: number, skipped: number | null, complete: boolean, windows: number }}
 */
export function documentReading(windows, chars = null) {
  const ranges = [];
  let recorded = null;
  for (const window of windows ?? []) {
    const served = /** @type {any} */ (window)?.served;
    if (!Array.isArray(served) || served.length !== 2 || !Number.isFinite(served[0]) || !Number.isFinite(served[1]) || !(served[1] > served[0]) || served[0] < 0) continue;
    ranges.push([served[0], served[1]]);
    const length = /** @type {any} */ (window)?.chars;
    if (Number.isInteger(length) && length > 0) recorded = Math.max(recorded ?? 0, length);
  }
  const total = recorded ?? (Number.isInteger(chars) && /** @type {number} */ (chars) > 0 ? chars : null);
  ranges.sort((a, b) => a[0] - b[0]);
  let read = 0;
  let end = 0;
  for (const [from, to] of ranges) {
    const start = Math.max(from, end);
    const stop = total === null ? to : Math.min(to, total);
    if (stop > start) read += stop - start;
    end = Math.max(end, stop);
  }
  return { chars: total, read, skipped: total === null ? null : total - read, complete: total !== null && read >= total, windows: ranges.length };
}
