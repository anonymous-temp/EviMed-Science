import table from './clinical-units.json' with { type: 'json' };
export const CLINICAL_UNIT_VERSION = table.version;
/** Exact known spellings only: case folding arbitrary UCUM symbols changes dimensions, so two spellings are one unit
 * only where the table lists them (`aliases`, then `caseVariants`; its `caseRule` says which case renderings are listed and why
 * Mmol/L, MU/L and G/L are not folded into their lower-case neighbours). The token of a unit the table does not know is the unit as typed.
 * @param {unknown} unit */
export function clinicalUnitToken(unit) {
  const token = String(unit ?? '').trim();
  const group = Object.entries(table.aliases).find(([, spellings]) => spellings.includes(token))
    ?? Object.entries(table.caseVariants).find(([, spellings]) => spellings.includes(token));
  return group?.[0] ?? token;
}
const LETTER = /[A-Za-zµμ]/;
const ALNUM = /[A-Za-z0-9µμ]/;
/** A number as a chart prints it, thousands separators and all (unsigned: the sign is not what a unit is beside). */
const PRINTED_NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** Characters a header or a bracket puts between a unit named before its number: `肌酐(μmol/L)：98`. */
const HEADER_GAP = /[:：=（）()[\]【】,，;；\-–—]/;
/** How far from its number a unit may stand: a flag, a bracket or a comma and no more. A letter or a digit in between is another word or number. */
const MOST_GAP = 6;
/** A unit written as a ratio, a power or a percentage is a symbol, never a word the chart might spell otherwise (岁 for year, 公斤 for kg). */
const SYMBOL_UNIT = /[/%^]/;

/**
 * The quote with its whitespace removed (so `μmol / L` is one unit and `7.2 %` one token), and for each character left the index it
 * had in the quote as printed: what stands next to a unit is judged on the printed quote, because once the whitespace is gone the
 * next word of a sentence looks like part of the unit (`7.2 % this week` became `7.2%thisweek`).
 * @param {string} quote
 */
function compacted(quote) {
  const kept = [];
  /** @type {number[]} */
  const origin = [];
  for (let index = 0; index < quote.length; index += 1) {
    if (!/\s/.test(quote[index])) { kept.push(quote[index]); origin.push(index); }
  }
  return { text: kept.join(''), origin, printed: quote };
}

/**
 * Whether `alias` stands beside the printed number `value` in `text` (whitespace already removed): right after it,
 * across at most {@link MOST_GAP} characters that are neither letters nor digits, or right before it as a header unit. The unit
 * ends where the printed quote shows it ending: a letter right after it makes it another word (`mg/dLx`), a space does not.
 * @param {ReturnType<typeof compacted>} compact @param {readonly string[]} aliases @param {number} value
 */
function besideValue(compact, aliases, value) {
  const { text, origin, printed } = compact;
  const afterUnit = (/** @type {number} */ end) => printed[origin[end - 1] + 1] ?? '';
  for (const match of text.matchAll(PRINTED_NUMBER)) {
    if (Math.abs(Number(match[0].replaceAll(',', '')) - Math.abs(value)) > 1e-9) continue;
    const from = /** @type {number} */ (match.index), to = from + match[0].length;
    for (const alias of aliases) {
      for (let gap = 0; gap <= MOST_GAP; gap += 1) {
        if (gap > 0 && ALNUM.test(text[to + gap - 1] ?? '')) break;
        if (!text.startsWith(alias, to + gap)) continue;
        if (!LETTER.test(text[to + gap - 1] ?? '') && !LETTER.test(afterUnit(to + gap + alias.length))) return true;
      }
      for (let gap = 0; gap <= 3; gap += 1) {
        if (gap > 0 && !HEADER_GAP.test(text[from - gap] ?? '')) break;
        const begins = from - gap - alias.length;
        if (begins < 0 || text.slice(begins, begins + alias.length) !== alias) continue;
        // A unit that already follows a number of its own (`6.1 mmol/L（110 …`) is that number's, not a header for the next one.
        if (!ALNUM.test(text[begins - 1] ?? '') && !LETTER.test(text[from - gap] ?? '')) return true;
      }
    }
  }
  return false;
}

/** Exact evidence check for this table's closed unit vocabulary, for units written as symbols, and for any unit of a fact that
 * is a laboratory value. Anything else (a unit spelled as a word or a bare symbol: year, kg) returns null; this is not a parser
 * for medical prose or all UCUM units.
 *
 * What is checked is that the quote prints the unit — and, given the fact's `value`, that it prints it *beside that
 * number* (right after it, across a flag or a bracket, or named in brackets right before it). A quote that prints two units
 * (`6.1 mmol/L（110 mg/dL）`) supports each unit only for the number it stands beside; "somewhere in the quote" supported
 * both for 6.1 (E-10). Without a `value` it is the older question, whether the unit is anywhere in the quote.
 *
 * A unit of the table is required in any of its listed spellings (`caseVariants` says two spellings are one unit; the quote
 * may use either). A unit outside the table is required literally, and only when the fact says it is a laboratory value
 * (`exactUnknown`) or the unit is a symbol written as a ratio, a power or a percentage (`mmol/mol`, `/uL`, `%`).
 * @param {unknown} unit @param {string} quote @param {boolean} [exactUnknown] @param {number|null} [value] the number the unit is to stand beside
 * @returns {boolean|null} */
export function clinicalUnitInQuote(unit, quote, exactUnknown = false, value = null) {
  const token = String(unit ?? '').trim();
  const listed = Object.values(table.aliases).find(values => values.includes(token))
    ?? Object.values(table.caseVariants).find(values => values.includes(token));
  const aliases = listed ?? (token && (exactUnknown || SYMBOL_UNIT.test(token)) ? [token] : null);
  if (!aliases) return null;
  const compact = compacted(quote);
  const spellings = aliases.map(alias => alias.replace(/\s+/g, ''));
  if (Number.isFinite(value)) return besideValue(compact, spellings, /** @type {number} */ (value));
  const { text, origin, printed } = compact;
  return spellings.some(alias => {
    let offset = text.indexOf(alias);
    while (offset >= 0) {
      const before = text[offset-1] ?? '', after = printed[origin[offset+alias.length-1] + 1] ?? '';
      if (!LETTER.test(before) && !LETTER.test(after)) return true;
      offset = text.indexOf(alias,offset+1);
    }
    return false;
  });
}

/** Every spelling of a unit the table knows, and the percent sign: what a number may be printed beside. */
const PRINTED_UNITS = [...Object.values(table.aliases).flat(), ...Object.values(table.caseVariants).flat(), '%'];

/**
 * Whether the quote prints a unit of the closed vocabulary (or a percent sign) beside this number. A number with none beside it is
 * bare: it may then be read in its analyte's one conventional unit, if the table has one (`clinicalConventionalUnit`).
 * @param {string} quote @param {number} value
 */
export function clinicalUnitPrintedBesideValue(quote, value) {
  return Number.isFinite(value) && besideValue(compacted(String(quote)), PRINTED_UNITS.map(alias => alias.replace(/\s+/g, '')), value);
}

/**
 * A fact's value as the number it is, when it is one: a finite number, or a string that is nothing but a plain number (`"9.9"`,
 * `" -3 "`). The one read the whole path shares: the writer holds such a value to the quotation like any number, the batch reader
 * turns it into the number, and the evaluator compares it as the number. A string with a word, a unit or a separator in it is text.
 * @param {unknown} value @returns {number | null}
 */
export function clinicalNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/**
 * The unit a bare number of this analyte is read in, from the closed table of analytes that have exactly one (`conventional`; an
 * analyte with a conversion row has two and is never listed). A number outside the printed range the table gives is not read in it.
 * The caller records `unitBasis: conventional` beside the unit: it was not printed.
 * @param {unknown} variable @param {unknown} value
 * @returns {{ unit: string, basis: string, version: string } | null}
 */
export function clinicalConventionalUnit(variable, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const row = table.conventional.find(entry => entry.analyte === String(variable ?? ''));
  if (!row || value < row.printed.min || value > row.printed.max) return null;
  return { unit: row.unit, basis: row.basis, version: table.version };
}
/** Original values are immutable; the result is a derived comparison value.
 * @param {number} value @param {string} from @param {string} to @param {string} analyte
 * @returns {{value:number,version:string,from:string,to:string,basis:string}|null} */
export function convertClinicalUnit(value, from, to, analyte) {
  if (!Number.isFinite(value)) return null;
  const a = clinicalUnitToken(from), b = clinicalUnitToken(to);
  for (const row of table.conversions) {
    if (row.analyte !== analyte) continue;
    const factor = row.from === a && row.to === b ? row.factor : row.from === b && row.to === a ? 1 / row.factor : null;
    if (factor != null && Number.isFinite(value * factor)) return { value: value * factor, version: table.version, from: a, to: b, basis: row.basis };
  }
  return null;
}
