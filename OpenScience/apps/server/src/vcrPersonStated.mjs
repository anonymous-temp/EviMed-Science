/**
 * Which numbers of a computed design are the person's own words (live check 2026-11-04).
 *
 * The premise word 「你给的数据」 (`given`) had grown to cover every number a scenario stated: a follow-up of 24 months, a dropout of 5%, a correlation
 * of 0.3 and 'at most 30 patients', all chosen by the model, were shown as the person's data. The word now means one of two things and nothing else:
 * the value comes from a table or a record the person supplied, or the number is literally in a message the person typed in this conversation.
 * Everything else a model wrote into a scenario is 「假设」.
 *
 * Hidden knowledge:
 *
 * - **Code decides it, not language.** When a design job starts, the scenario's numbers are laid against the numeric literals of the person's own
 *   messages (`numberIsInQuote`, the helper that binds a number to a quotation: a fraction is matched against its percentage too), and the paths
 *   that were found are frozen with the job (`detail.personStated`, then `diagnostics.personStated` on the result). The page reads that record and
 *   guesses nothing.
 * - **No evidence, no strong word.** A conversation whose messages could not be read records `readable: false` and every number reads 「假设」.
 * - **An old result has no record and reads as it read.** `personWord` returns the word the page used before for a result with none, so a replay or
 *   a fixture of an earlier release shows what it showed.
 * - **0 and 1 are structure, not statements.** A hazard ratio of 1, an allocation of 1 and a count of 0 are what a design needs to exist, and a digit
 *   of the person's message that happens to be one is no evidence that they said it.
 *
 * @module vcrPersonStated
 */

import { numberIsInQuote } from "./vcrEvidence.mjs";

/** The most paths a record keeps: a scenario with more numbers than this is a table, and a table is not a message. */
const MAX_PATHS = 200;
/** The schema of the record. */
export const VCR_PERSON_STATED_SCHEMA = 1;

/**
 * The numbers of a scenario with the path each sits at (`truth.effects[0]`, `design.cohortSize`).
 * @param {unknown} value @param {string} [path]
 * @returns {Array<{ path: string, value: number }>}
 */
export function vcrNumericLeaves(value, path = "") {
  if (typeof value === "number") return Number.isFinite(value) ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => vcrNumericLeaves(entry, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => vcrNumericLeaves(entry, path ? `${path}.${key}` : key));
  return [];
}

/**
 * Is `fraction` written in the text as a percentage (5% for 0.05, 12.5% for 0.125)? The sign or the word decides: a bare 5 is not.
 * @param {string} text @param {number} fraction
 */
function percentIsInText(text, fraction) {
  const target = Number((fraction * 100).toPrecision(12));
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|％|个百分点|percent(?:age points?)?)/giu)) if (Number(match[1]) === target) return true;
  return false;
}

/**
 * The record of which numbers of a scenario are in the person's own messages.
 * @param {Record<string, any>} scenario @param {readonly string[] | null | undefined} messages the person's messages of this conversation, or null when they could not be read
 * @returns {{ schema: 1, readable: boolean, paths: string[] }}
 */
export function vcrPersonStated(scenario, messages) {
  const texts = Array.isArray(messages) ? messages.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  if (!texts.length) return { schema: VCR_PERSON_STATED_SCHEMA, readable: false, paths: [] };
  const text = texts.join("\n");
  const paths = vcrNumericLeaves(scenario)
    .filter(({ value }) => value !== 0 && value !== 1)
    // a fraction is also the percentage the person wrote (0.05 for 「5%」, 「百分之五」 is not read); a bare 5 is not a 0.05
    .filter(({ value }) => numberIsInQuote(text, value) || (value > 0 && value < 1 && percentIsInText(text, value)))
    .map(({ path }) => path);
  return { schema: VCR_PERSON_STATED_SCHEMA, readable: true, paths: [...new Set(paths)].slice(0, MAX_PATHS) };
}

/**
 * The word a premise of a stated number takes. `legacy` is the word the page used before there was a record.
 * @param {Record<string, any> | null | undefined} record `diagnostics.personStated` of the result
 * @param {string | readonly string[]} paths the scenario path(s) of the number(s) the premise shows. A premise of several numbers is the person's only
 *   when every one is: a row that shows a number the model chose beside one the person said is not 「你给的数据」
 * @param {"given" | "assumed"} legacy
 * @returns {"given" | "assumed"}
 */
export function personWord(record, paths, legacy) {
  if (!record || typeof record !== "object" || record.schema !== VCR_PERSON_STATED_SCHEMA) return legacy;
  if (record.readable !== true || !Array.isArray(record.paths)) return "assumed";
  const wanted = Array.isArray(paths) ? paths : [paths];
  return wanted.length > 0 && wanted.every((path) => record.paths.includes(path)) ? "given" : "assumed";
}
