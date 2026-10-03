/** Scientific agreement is evaluated independently from serialized bytes.
 * Missing values, incompatible units and absent tolerances never imply success. */
export const RESULT_REPLAY_METHODS = Object.freeze(["meta.dl", "faers.signals", "bibliometric.network", "design.analytic", "comparator.evalue"]);

/** @param {any} before @param {any} after */
export function compareResultNumbers(before, after) {
  /** @param {any[]} values */
  const valid = values => Array.isArray(values) && values.length <= 10000 && values.every(item => item
    && typeof item.key === "string" && item.key.length > 0 && item.key.length <= 512 && Number.isFinite(item.value)
    && (item.unit === undefined || typeof item.unit === "string")
    && [item.absoluteTolerance, item.relativeTolerance].every(value => value === undefined || Number.isFinite(value) && value >= 0))
    && new Set(values.map(item => item.key)).size === values.length;
  if (!valid(before) || !valid(after)) throw new Error("Invalid machine-readable scientific values.");
  /** @type {Map<string, any>} */
  const left = new Map(before.map((/** @type {any} */ item) => [item.key, item]));
  /** @type {Map<string, any>} */
  const right = new Map(after.map((/** @type {any} */ item) => [item.key, item]));
  const values = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key); const b = right.get(key);
    if (!a || !b) { values.push({ key, status: "missing", before: a?.value ?? null, after: b?.value ?? null }); continue; }
    if ((a.unit ?? "") !== (b.unit ?? "")) { values.push({ key, status: "incompatible-unit", before: a.value, after: b.value }); continue; }
    const absoluteDifference = Math.abs(b.value - a.value);
    // The frozen original names acceptable tolerances. A rerun cannot enlarge
    // its own allowance to turn a discrepancy into an agreement.
    const tolerance = Math.max(a.absoluteTolerance ?? 0, (a.relativeTolerance ?? 0) * Math.abs(a.value));
    values.push({ key, unit: a.unit ?? null, before: a.value, after: b.value, absoluteDifference, tolerance,
      status: a.value === b.value ? "identical" : absoluteDifference <= tolerance ? "within-tolerance" : "changed" });
  }
  return { status: !values.length ? "not-assessed" : values.every(item => item.status === "identical") ? "identical"
    : values.every(item => ["identical", "within-tolerance"].includes(item.status)) ? "within-tolerance" : "changed",
  values, scientificApplicability: "not_assessed" };
}
