/** The identity vocabulary of an immutable result version: who produced it, what it read, whether the bytes are held.
 * Split from `resultProvenance.mjs` so `resultLineage.mjs` can read it without a cycle. */
export const RESULT_PRODUCER_KINDS = Object.freeze([
  "tool", "deliverable", "engine", "revision", "workspace", "legacy",
]);
export const RESULT_INPUT_KINDS = Object.freeze(["source", "artifact", "data", "code", "method"]);
export const RESULT_AVAILABILITY = Object.freeze(["captured", "reference", "unknown", "restricted", "deleted"]);

/** @param {unknown} value @returns {value is string} */
export function isResultDigest(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

/** @param {unknown} value @returns {string} */
export function normalizeResultPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096
    || [...value].some(char => char.charCodeAt(0) < 32 || char === "\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) {
    throw new Error("Invalid result path.");
  }
  const segments = value.split("/").filter(part => part !== "." && part !== "");
  if (!segments.length || segments.some(part => part === "..")) throw new Error("Invalid result path.");
  return segments.join("/");
}

/** @param {any} value @returns {any} */
export function projectResultInput(value) {
  if (!value || !RESULT_INPUT_KINDS.includes(value.kind) || typeof value.id !== "string"
    || !value.id || value.id.length > 200) throw new Error("Invalid result input.");
  const digest = isResultDigest(value.digest) ? value.digest : null;
  const availability = RESULT_AVAILABILITY.includes(value.availability) ? value.availability : "reference";
  return { kind: value.kind, id: value.id, digest,
    versionId: typeof value.versionId === "string" ? value.versionId : null,
    path: typeof value.path === "string" ? normalizeResultPath(value.path) : null,
    availability: availability === "captured" && !digest ? "reference" : availability };
}


// Bounds and small readers shared by the producer snapshot and the value bindings (`resultLineage` modules).

/** Bounds, so a record always fits the ledger's document limit beside the rest of a version. */
export const RESULT_LINEAGE_LIMITS = Object.freeze({
  bindings: 300, unbound: 100, unresolved: 40, calculations: 8, machineValues: 5000, packages: 400, files: 64, inputs: 256,
  transformations: 32, candidates: 4, textBytes: 1024 * 1024,
});

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {number} max @returns {string | null} */
export const boundedText = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max && ![...value].some((char) => char.charCodeAt(0) < 32) ? value : null);
/** @param {unknown} value @returns {number | null} */
export const nonNegativeInteger = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);
/** @param {unknown} value @returns {string | null} */
export const isoTimestamp = (value) => (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null);
/** @param {unknown} value @returns {string | null} */
export const digestOrNull = (value) => (isResultDigest(value) ? /** @type {string} */ (value) : null);
/** @param {unknown} value @returns {string | null} */
export const pathOrNull = (value) => { try { return typeof value === "string" ? normalizeResultPath(value) : null; } catch { return null; } };

/**
 * A bounded map of scalars: names that read as identifiers, values that are
 * short strings, finite numbers or booleans. Anything else is dropped, so no
 * nested structure and no long string (a token, a command line) can ride in.
 * @param {unknown} value @param {number} maxKeys @returns {Record<string, string | number | boolean> | null}
 */
export function scalarMap(value, maxKeys) {
  if (!isRecord(value)) return null;
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, maxKeys)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
    if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
    else if (typeof item === "boolean") out[key] = item;
    else if (typeof item === "string" && boundedText(item, 80) !== null) out[key] = item;
  }
  return Object.keys(out).length ? out : null;
}

