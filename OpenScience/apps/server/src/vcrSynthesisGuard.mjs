/**
 * The refusal of an empirical synthesis that cannot finish, and the notice of one that may not, said before it is queued (2026-10-31).
 *
 * `population.synthpop` makes its copies one after another inside one R process, then scores each of them against the training table,
 * and the process stops at 90 % of the job's CPU limit with nothing to show for the work done. The domain holds the cost model and the
 * sentence (`vcrSynthesisLimits.mjs`); this module is the part that needs the table: the queue knows which file the engine will read,
 * and the file knows its rows and columns.
 *
 * Hidden knowledge:
 *
 * - **The table the engine learns from is the one `.vcr_main_table` picks**: the subject analysis table when the job carries one,
 *   else the first raw file. The subject key (`USUBJID`) is not a variable of the synthesis and is not counted.
 * - **An unreadable table is not a refusal.** A table whose size cannot be read here (missing, too large to scan) is left to the
 *   engine's own budget, which still stops it; a guess is not a reason to refuse work.
 * - **It reads the file, never the rows.** Only the header's width and the record count leave the scan.
 *
 * @module vcrSynthesisGuard
 */

import path from "node:path";
import { VCR_SYNTHPOP_COPIES, vcrSynthpopFeasibility } from "@evimed/domain";

import { readCsvRows } from "./vcrRows.mjs";

/** The columns the synthesis does not learn from: a person's key. */
const KEY_COLUMNS = new Set(["USUBJID"]);

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * The records and the learned columns of a delimited table, counted by reading it once.
 * @param {string} file
 * @returns {Promise<{ rows: number, columns: number } | null>} null for an empty or unreadable file
 */
export async function vcrTableShape(file) {
  /** @type {string[] | null} */
  let header = null;
  let rows = 0;
  try {
    for await (const row of readCsvRows(file)) {
      if (header === null) header = row;
      else rows += 1;
    }
  } catch {
    return null;
  }
  if (header === null) return null;
  return { rows, columns: header.filter((name) => !KEY_COLUMNS.has(name)).length };
}

/**
 * What the budget says of a synthesis job's table, or null when it fits. `refused` is a table that could not be finished even at the
 * model's best measured case (not queued); otherwise the table may or may not finish and the job is queued with this as its notice.
 * @param {{ root: string | null, inputs: ReadonlyArray<Record<string, any>>, scenario: Record<string, any>, cpuSecondsLimit: number, cpuSecondsCeiling?: number }} input
 *   `root` is the data plane's directory; `inputs` the table inputs as the queue resolved them
 * @returns {Promise<{ code: string, message: string, refused: boolean } | null>}
 */
export async function vcrSynthesisIssue({ root, inputs, scenario, cpuSecondsLimit, cpuSecondsCeiling }) {
  if (!root) return null;
  const table = inputs.find((entry) => entry.kind === "analysis_table" && entry.shape === "subject") ?? inputs.find((entry) => entry.kind === "snapshot_file");
  if (!table || typeof table.location !== "string") return null;
  const file = path.resolve(root, table.location);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  const shape = await vcrTableShape(file);
  if (!shape || shape.columns < 1) return null;
  const copies = Number.isInteger(object(scenario).m) ? Number(object(scenario).m) : VCR_SYNTHPOP_COPIES.min;
  const verdict = vcrSynthpopFeasibility({ rows: shape.rows, columns: shape.columns, copies, cpuSecondsLimit, cpuSecondsCeiling });
  if (!verdict.ok) return { code: "vcr_synthesis_too_large", message: verdict.message, refused: true };
  return verdict.risk ? { code: "vcr_synthesis_may_not_finish", message: verdict.risk.message, refused: false } : null;
}
