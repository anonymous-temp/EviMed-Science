/** One lexical grammar for source-number candidates and exact derived-input spans. */
const NUMBER = String.raw`(?<![\w.+−-])(?:[-+−]\s*)?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?!\w|\.\d)`;
/** @param {string} raw */
const numericValue = raw => Number(raw.replace('−', '-').replace(/\s/gu, ''));
/** A quotation starting after a typeset unary sign must not turn it into an unsigned value.
 * @param {string} text @param {number} start */
const detachedSignBefore = (text, start) => {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(text[index])) index -= 1;
  return index < start - 1 && /[-+−]/u.test(text[index] ?? '');
};
/** @param {string} text */
export function* numericLiteralSpans(text) {
  for (const match of text.matchAll(new RegExp(NUMBER, 'g'))) {
    const value = numericValue(match[0]);
    if (Number.isFinite(value)) yield { value, raw: match[0], start: match.index, end: match.index + match[0].length };
  }
}
/** Validate only tokens inside the bounded quotation, then recheck each at its original source position.
 * Sticky matching prevents a clipped suffix, decimal or exponent from becoming a different source number.
 * @param {string} text @param {number} start @param {number} end @param {number} value */
export function numericLiteralInSpan(text, start, end, value) {
  for (const token of numericLiteralSpans(text.slice(start, end))) {
    if (token.value !== value) continue;
    const position = start + token.start;
    if (detachedSignBefore(text, position)) continue;
    const pattern = new RegExp(NUMBER, 'y'); pattern.lastIndex = position;
    const original = pattern.exec(text);
    if (original && pattern.lastIndex <= end && numericValue(original[0]) === value) return true;
  }
  return false;
}
