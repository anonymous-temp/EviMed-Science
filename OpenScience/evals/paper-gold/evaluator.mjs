import { createHash } from "node:crypto";
import { boundedHalfWidth } from "./tolerance.mjs";
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A reference's stated tolerance is honoured only up to the bound `tolerance.mjs` derives from how the
 *  number was printed; `toleranceClamped` says a frozen definition asked for more than that. */
export function numericScore(actual, reference) {
  if (!Number.isFinite(actual)) return { valid: false, reason: "missing_numeric_result" };
  const interval = reference.interval ?? [reference.value, reference.value];
  const { halfWidth: tolerance, clamped } = boundedHalfWidth(reference);
  return { valid: actual >= interval[0] - tolerance && actual <= interval[1] + tolerance, distance: actual < interval[0] ? interval[0] - actual : actual > interval[1] ? actual - interval[1] : 0, ...(clamped ? { toleranceClamped: true } : {}) };
}
