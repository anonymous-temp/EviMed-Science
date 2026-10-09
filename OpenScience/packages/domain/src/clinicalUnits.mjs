import table from './clinical-units.json' with { type: 'json' };
export const CLINICAL_UNIT_VERSION = table.version;
/** Exact known aliases only: case folding arbitrary UCUM symbols changes dimensions.
 * @param {unknown} unit */
export function clinicalUnitToken(unit) {
  const token = String(unit ?? '').trim();
  return Object.entries(table.aliases).find(([, aliases]) => aliases.includes(token))?.[0] ?? token;
}
/** Exact evidence check for this table's closed unit vocabulary only. Unknown
 * units return null; this is not a parser for medical prose or all UCUM units.
 * @param {unknown} unit @param {string} quote @returns {boolean|null} */
export function clinicalUnitInQuote(unit, quote) {
  const aliases = Object.values(table.aliases).find(values => values.includes(String(unit ?? '').trim()));
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
