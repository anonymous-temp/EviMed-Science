/**
 * The key a result is filed under when it belongs to no object of the study but to the question it was asked (the result's `subject_id`).
 *
 * Hidden knowledge:
 *
 * - **The key covers the scenario.** `recordResult` supersedes the earlier result of the same (kind, subject); a key made of the design and
 *   the endpoint alone made a futility design with a planned effect of 0.4 and the same design with 0.25 one card with two versions, while
 *   the reply of the first still stated its number (2026-11-04). The same question asked again is the next version of one result; another
 *   effect, another size, another objective is another result and another card.
 * - **A hash of the canonical text**, with the keys in order, so the order a caller wrote them in never matters. Ten hex digits are
 *   enough to tell the questions of one study apart.
 *
 * @module vcrScenarioKey
 */

import { createHash } from "node:crypto";

/** @param {unknown} value @returns {unknown} the value with every object's keys in order */
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(/** @type {any} */ (value)[key])]));
  }
  return value;
}

/**
 * The first ten hex digits of the hash of a scenario: the same scenario is the same text whatever order its keys were written in.
 * @param {unknown} scenario
 */
export function vcrScenarioKey(scenario) {
  const record = scenario && typeof scenario === "object" && !Array.isArray(scenario) ? scenario : {};
  return createHash("sha256").update(JSON.stringify(ordered(record))).digest("hex").slice(0, 10);
}
