import { normalizedPassage } from '@evimed/domain/clinical-evidence';

// Lexical shapes only. These do not infer a person's name, a unit's meaning, or whether two statements agree.
const TOKEN_SHAPES = /\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|(?<![\w.])[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:[%‰°]|[A-Za-zµμ]+(?:\s*[/^]\s*[A-Za-zµμ0-9]+)*|\p{Script=Han}+))?|\b(?=[A-Za-z0-9_./-]*[A-Za-z])(?=[A-Za-z0-9_./-]*\d)[A-Za-z0-9]+(?:[_.:/-]?[A-Za-z0-9]+)*\b|\b[A-Za-z]+(?:[_/-][A-Za-z]+)+\b/gu;
const QUOTED = /[“「『‘"]([^”」』’"\n]+)[”」』’"]|'([^'\n]+)'/gu;

/** All literal hard tokens; typography is normalised by the platform's existing quotation comparator.
 * @param {string} text @returns {string[]} */
export function hardTokens(text) {
  const normal = normalizedPassage(text);
  return [...new Set([
    ...normal.matchAll(TOKEN_SHAPES),
    ...String(text).matchAll(QUOTED),
  ].map(match => normalizedPassage(match[1] ?? match[2] ?? match[0])).filter(Boolean))];
}

/** A token must stand on its own: 12 mg is not supported by 112 mg, and a date is not a substring of another identifier.
 * @param {string} token @param {string} source */
export function tokenPresent(token, source) {
  const text = normalizedPassage(source);
  // Compare complete lexical shapes: a concentration is not a dose, a positive value is not its negative,
  // and ABC123 is not the identifier ABC123-4. Quoted words/names use literal containment below.
  if ([...token.matchAll(TOKEN_SHAPES)].some(match => match.index === 0 && match[0].length === token.length)) {
    return [...text.matchAll(TOKEN_SHAPES)].some(match => match[0] === token);
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

/** Conversation timestamps can ground their calendar date, never other numbers or identifiers.
 * A date in an excerpt is still read for meaning by the judge; this is only its literal provenance.
 * @param {string} token @param {{text:string,created_at?:string|null}} source */
export function sourceHasToken(token, source) {
  if (tokenPresent(token, source.text)) return true;
  const stamp = source.created_at;
  return typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(token)
    && token === stamp.slice(0, 10) && Number.isFinite(Date.parse(stamp));
}
