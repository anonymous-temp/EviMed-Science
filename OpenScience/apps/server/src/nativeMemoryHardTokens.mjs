import { normalizedPassage } from '@evimed/domain/clinical-evidence';

// Lexical shapes only. These do not infer a person's name, a unit's meaning, or whether two statements agree.
const TOKEN_SHAPES = /\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|(?<![\d:])(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])|(?<![\w.])[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:[%‰°]|[A-Za-zµμ]+(?:\s*[/^]\s*[A-Za-zµμ0-9]+)*|\p{Script=Han}+))?|\b(?=[A-Za-z0-9_./-]*[A-Za-z])(?=[A-Za-z0-9_./-]*\d)[A-Za-z0-9]+(?:[_.:/-]?[A-Za-z0-9]+)*\b|\b[A-Za-z]+(?:[_/-][A-Za-z]+)+\b/gu;
const QUOTED = /[“「『‘"]([^”」』’"\n]+)[”」』’"]|'([^'\n]+)'/gu;

/** Shared lexical normalization for body, history, titles and filenames. A single-letter identifier
 * prefix followed by digits has the same shape with a space, underscore or dash. Number/unit pairs
 * and complete identifiers retain their boundaries (ABC123 is never ABC123-4).
 * @param {string} text */
function hardText(text) {
  return normalizedPassage(text).replace(/[‐‑‒−]/gu, '-')
    .replace(/(?<=[a-z0-9])_(?=[a-z0-9])/g, '-')
    .replace(/\b([a-z])[\s-]+(?=\d)/g, '$1-');
}

/** A native filename is content too. Keep its complete spelling as well as the engine's word
 * separators; both go through the same hard-token comparator as body and history text.
 * @param {string} uri */
export function memoryNameVariants(uri) {
  const name = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return [...new Set([name, name.normalize('NFKC').replace(/_/g, ' ')])];
}

/** All literal hard tokens; typography is normalised by the platform's existing quotation comparator.
 * @param {string} text @returns {string[]} */
export function hardTokens(text) {
  const normal = hardText(text);
  return [...new Set([
    ...normal.matchAll(TOKEN_SHAPES),
    ...String(text).matchAll(QUOTED),
  ].map(match => hardText(match[1] ?? match[2] ?? match[0])).filter(Boolean))];
}

/** A token must stand on its own: 12 mg is not supported by 112 mg, and a date is not a substring of another identifier.
 * @param {string} token @param {string} source @param {{ignoreWhitespace?:boolean}} [options] */
export function tokenPresent(token, source, { ignoreWhitespace = false } = {}) {
  token = hardText(token);
  const text = hardText(source);
  // Compare complete lexical shapes: a concentration is not a dose, a positive value is not its negative,
  // and ABC123 is not the identifier ABC123-4. Quoted words/names use literal containment below.
  if ([...token.matchAll(TOKEN_SHAPES)].some(match => match.index === 0 && match[0].length === token.length)) {
    const canonical = value => ignoreWhitespace ? value.replace(/\s+/gu, '') : value;
    return [...text.matchAll(TOKEN_SHAPES)].some(match => canonical(match[0]) === canonical(token));
  }
  let start = text.indexOf(token);
  while (start >= 0) {
    const before = text[start - 1] ?? '', after = text[start + token.length] ?? '';
    if ((!/[a-z0-9_.]/i.test(token[0]) || !/[a-z0-9_.]/i.test(before))
      && (!/[a-z0-9_]/i.test(token.at(-1) ?? '') || !/[a-z0-9_]/i.test(after))) return true;
    start = text.indexOf(token, start + 1);
  }
  return false;
}

/** Conversation timestamps can ground their calendar date and clock time, never other numbers or identifiers.
 * A date in an excerpt is still read for meaning by the judge; this is only its literal provenance.
 * @param {string} token @param {{text:string,created_at?:string|null}} source @param {{ignoreWhitespace?:boolean}} [options] */
export function sourceHasToken(token, source, options = {}) {
  if (tokenPresent(token, source.text, options)) return true;
  const stamp = source.created_at;
  if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token === stamp.slice(0, 10);
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(token)
    && token === stamp.slice(11, 11 + token.length);
}
