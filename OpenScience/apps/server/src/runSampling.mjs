/**
 * A stable sample of runs.
 *
 * Hidden knowledge: two parts of the learning loop spend model money per finished run and learn little from most of them — a distillation per delivery
 * answers `no_change` most of the time, and a platform handbook on probation needs only some runs to be observed — so each takes a share of the runs
 * rather than all of them. The share is a property of the run, not of the moment: it is chosen by a hash of the run id, so asking again about the same
 * run (a retry, a replayed completion, a second reader) gets the same answer, the sample needs no state, and a run can be re-derived as in or out
 * afterwards. A random draw would have been a different answer each time and a counter that could not be checked against anything.
 *
 * `purpose` is hashed in with the id, so two samples of the same runs (the distillation's and the probation's) are independent of each other instead of
 * picking the same runs, which would make one run carry both costs and another neither.
 *
 * @module runSampling
 */
import { createHash } from "node:crypto";

/**
 * Whether `id` is among the `share` of ids a hash of it selects, for this purpose.
 * @param {unknown} id  the run (or request) id; anything stable that names one run
 * @param {unknown} share  a fraction from 0 to 1; one or more selects everything, zero or anything that is not a positive number selects nothing
 * @param {string} purpose  what the sample is for, so that two purposes do not choose the same ids
 * @returns {boolean}
 */
export function sampledByHash(id, share, purpose) {
  const fraction = Number(share);
  if (!(fraction > 0)) return false;
  if (fraction >= 1) return true;
  const digest = createHash("sha256").update(`${purpose}\0${String(id)}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < fraction;
}
