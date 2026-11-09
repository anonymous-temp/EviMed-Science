/**
 * The sentence every simulated result carries when a conversation reads it (round 2, R24).
 *
 * A reply that says 「模拟 20,000 次，所以很准」 mistakes the Monte Carlo error for the whole error: more replicates shrink only that,
 * never the error of the model's form or of a wrong assumption about the drug. A result that holds a simulated measure is handed over
 * with `simulationNote`, the domain's one sentence (`VCR_SIMULATION_ERROR_SENTENCE_ZH`), so the reply can say it from the answer it
 * reads and not from memory. A copy; a result with no simulated measure is returned as it is.
 *
 * @module vcrSimulationNote
 */

import { VCR_SIMULATION_ERROR_SENTENCE_ZH } from "@evimed/domain";

/** @param {unknown} measures */
const holdsSimulated = (measures) => Array.isArray(measures) && measures.some((/** @type {any} */ measure) => measure?.simulated === true);

/**
 * @param {Record<string, any>} result as the answer carries it (`measures`, `diagnostics.cells[].measures`)
 * @returns {Record<string, any>}
 */
export function vcrWithSimulationNote(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.simulationNote === "string") return result;
  const cells = Array.isArray(result.diagnostics?.cells) ? result.diagnostics.cells : [];
  return holdsSimulated(result.measures) || cells.some((/** @type {any} */ cell) => holdsSimulated(cell?.measures))
    ? { ...result, simulationNote: VCR_SIMULATION_ERROR_SENTENCE_ZH } : result;
}
