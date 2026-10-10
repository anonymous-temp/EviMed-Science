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
/** Exact evidence check for this table's closed unit vocabulary only. Unknown
 * units return null; this is not a parser for medical prose or all UCUM units.
 * `caseVariants` only says that two spellings are one unit: it is not part of that closed vocabulary, so it adds no quote
 * requirement for a unit that was not already required to be found, but when one is required (`exactUnknown`) any listed spelling counts.
 * @param {unknown} unit @param {string} quote @param {boolean} [exactUnknown] @returns {boolean|null} */
export function clinicalUnitInQuote(unit, quote, exactUnknown = false) {
  const token = String(unit ?? '').trim();
  const aliases = Object.values(table.aliases).find(values => values.includes(token))
    ?? (exactUnknown && token ? Object.values(table.caseVariants).find(values => values.includes(token)) ?? [token] : null);
  if (!aliases) return null;
  const text = quote.replace(/\s+/g,'');
  return aliases.some(alias => {
    let offset = text.indexOf(alias);
    while (offset >= 0) {
      const before = text[offset-1] ?? '', after = text[offset+alias.length] ?? '';
      if (!/[A-Za-zµμ]/.test(before) && !/[A-Za-zµμ]/.test(after)) return true;
      offset = text.indexOf(alias,offset+1);
    }
    return false;
  });
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
