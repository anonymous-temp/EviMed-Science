/**
 * The incidents as cases (principle 6): `incidents.json` holds synthetic records and trials built from customer feedback, red-team ideas and the defects the first
 * real runs found, each with what the saved judgment must say. `native_replay.mjs --board incidents` runs them through the patient-matching plugin, and `findings`
 * is what checks a saved fit, verdict and clause labels against a case's expectation, and whether a clause names the sentences behind it. A case that fails is a
 * finding to read, not a reason to edit its expectation.
 */

/** @param {any} row @param {string} words */
const clauseMatches = (row, words) => String(row.clause ?? '').toLowerCase().includes(words.toLowerCase());

/**
 * What is wrong with one saved judgment against one case's expectations. Pure.
 * @param {any} expect @param {any} entry the ranking entry of the pair, with `criteria`
 * @returns {string[]}
 */
export function findings(expect, entry) {
  if (!entry) return ['no judgment saved'];
  const out = [];
  const { fit, verdict, verdictNot, clauses } = expect;
  if (fit?.min != null && !(Number(entry.fit) >= fit.min)) out.push(`fit ${entry.fit} is below ${fit.min}`);
  if (fit?.max != null && !(Number(entry.fit) <= fit.max)) out.push(`fit ${entry.fit} is above ${fit.max}`);
  if (verdict && !verdict.includes(entry.verdict)) out.push(`verdict ${entry.verdict}, wanted ${verdict.join(' or ')}`);
  if (verdictNot?.includes(entry.verdict)) out.push(`verdict ${entry.verdict}`);
  for (const want of clauses ?? []) {
    const row = (entry.criteria ?? []).find((candidate) => clauseMatches(candidate, want.contains));
    if (!row) { out.push(`no clause holds "${want.contains}"`); continue; }
    const label = String(row.label ?? '').replaceAll('_', ' ');
    if (!want.labels.includes(label)) out.push(`"${want.contains}": ${label}, wanted ${want.labels.join(' or ')}`);
    if (want.evidence && !(row.sentenceIds ?? []).length) out.push(`"${want.contains}": no sentence behind it`);
  }
  return out;
}
