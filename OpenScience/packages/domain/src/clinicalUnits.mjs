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
/** A name as the table keys it: lower case, the spaces and hyphens of a typed name folded to the underscores a variable id uses. @param {unknown} name */
const analyteKey = (name) => String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** analyte id or alias -> the analyte's row, built once from the table */
const ANALYTES = new Map(table.analytes.flatMap(/** @param {any} row */ row => [row.id, ...row.aliases].map(name => [analyteKey(name), row])));
/** scalar quantity analyte name -> its row (weight, height, temperature, pressure) */
const SCALARS = new Map(table.scalarQuantities.flatMap(/** @param {any} row */ row => row.analytes.map(/** @param {string} name */ name => [analyteKey(name), row])));
const MASS = /** @type {Record<string, number>} */ (table.massConcentration.sizes);
const MOLAR = /** @type {Record<string, number>} */ (table.molarConcentration.sizes);

/** The unit of a quantity row, from any of its listed spellings (case-insensitive inside one quantity: `m` is a metre here and nothing else).
 * @param {any} row @param {string} unit @returns {[string, {scale:number, offset:number}] | null} */
function scalarUnit(row, unit) {
  const folded = String(unit ?? '').trim().toLowerCase();
  for (const [name, entry] of Object.entries(row.units)) {
    if (entry.spellings.some(/** @param {string} spelling */ spelling => spelling.toLowerCase() === folded)) return [name, entry];
  }
  return null;
}

/** A derived value to twelve significant digits, so that a cut-off written in another unit (100.4 degF for 38 degC) lands on the cut-off and not on the rounding error beside it. @param {number} value */
const settle = (value) => Number(value.toPrecision(12));

/** @param {number} value @param {string} a @param {string} b the table's tokens @param {any} analyte @returns {{ value: number, basis: string } | null} */
function derivedConversion(value, a, b, analyte) {
  const aMass = MASS[a], bMass = MASS[b], aMolar = MOLAR[a], bMolar = MOLAR[b];
  if (aMass && bMass) return { value: value * aMass / bMass, basis: 'Mass concentrations differ only by their size (g/L as the base)' };
  if (aMolar && bMolar) return { value: value * aMolar / bMolar, basis: 'Molar concentrations differ only by their size (mol/L as the base)' };
  if ((aMass && bMolar) || (aMolar && bMass)) {
    // mass per volume x (1 / molar mass) = moles per volume, the conversion ucum-lhc makes when it is given a molecular weight
    if (!(analyte.molarMass > 0)) return null;
    const grams = aMass ? value * aMass : value * aMolar * analyte.molarMass;
    return { value: aMass ? grams / analyte.molarMass / bMolar : grams / bMass, basis: `${analyte.id}: ${analyte.basis}` };
  }
  const equivalent = (/** @type {string} */ unit) => unit === 'mEq/L' || unit === 'meq/L';
  const aEq = equivalent(a), bEq = equivalent(b);
  if ((aEq && bMolar) || (bEq && aMolar)) {
    // mEq/L is mmol/L times the valence of the ion
    if (!(analyte.valence > 0)) return null;
    const mmol = aEq ? value / analyte.valence : value * aMolar / MOLAR['mmol/L'];
    return { value: aEq ? mmol * MOLAR['mmol/L'] / bMolar : mmol * analyte.valence, basis: `${analyte.id}: ${analyte.basis}` };
  }
  return null;
}

/** Original values are immutable; the result is a derived comparison value. The four explicit rows of `conversions` answer first, with
 * the factors they have always had; any other pair of an analyte the table knows is derived (`derivation` in the table says how), a quantity
 * with an offset (a temperature) through its own scale and offset, and anything else is `null`.
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
  const scalar = SCALARS.get(analyteKey(analyte));
  if (scalar) {
    const source = scalarUnit(scalar, from), target = scalarUnit(scalar, to);
    if (!source || !target) return null;
    const converted = settle((value * source[1].scale + source[1].offset - target[1].offset) / target[1].scale);
    return Number.isFinite(converted) ? { value: converted, version: table.version, from: source[0], to: target[0], basis: scalar.basis } : null;
  }
  const known = ANALYTES.get(analyteKey(analyte));
  if (!known) return null;
  const derived = derivedConversion(value, a, b, known);
  return derived && Number.isFinite(derived.value) ? { value: settle(derived.value), version: table.version, from: a, to: b, basis: derived.basis } : null;
}
