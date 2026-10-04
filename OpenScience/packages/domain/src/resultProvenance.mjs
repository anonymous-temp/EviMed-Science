import { RESULT_PRODUCER_KINDS, RESULT_INPUT_KINDS, RESULT_AVAILABILITY, isResultDigest, normalizeResultPath, projectResultInput } from "./resultIdentity.mjs";
import { projectProducerSnapshot, unobservedSnapshot } from "./producerSnapshot.mjs";
import { emptyValueBindings, projectValueBindings } from "./valueBindings.mjs";

/** Immutable result vocabulary. Inputs are facts captured by owned producers,
 * never an execution recipe inferred from an artifact's filename or prose. */
export { RESULT_PRODUCER_KINDS, RESULT_INPUT_KINDS, RESULT_AVAILABILITY, isResultDigest, normalizeResultPath, projectResultInput };

/**
 * What produced a calculated result, from the engine's own method record: the
 * record's id, version and digest, and whether the method is seeded and with
 * what. Absent for a result with no record (anything captured before records
 * existed, or not produced by an admitted calculation), and "unknown" is not
 * "the same": a comparison with a missing side says so.
 * @param {any} value @returns {{id: string, version: string, digest: string | null, seeded: boolean | null, seed: number | null} | null}
 */
export function projectResultMethod(value) {
  if (!value || typeof value.id !== "string" || !value.id || value.id.length > 200
    || typeof value.version !== "string" || !value.version || value.version.length > 64) return null;
  return { id: value.id, version: value.version, digest: isResultDigest(value.digest) ? value.digest : null,
    seeded: typeof value.seeded === "boolean" ? value.seeded : null,
    seed: Number.isSafeInteger(value.seed) ? value.seed : null };
}

/** Public projection excludes storage paths, credentials and unbounded tool arguments.
 * @param {any} value @returns {any} */
export function projectResultVersion(value) {
  if (!value || !/^rv_[a-f0-9]{64}$/.test(value.versionId) || !/^ra_[a-f0-9]{64}$/.test(value.artifactId)
    || !isResultDigest(value.digest) || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.projectId !== "string") throw new Error("Invalid immutable result version.");
  const producer = value.producer ?? {};
  const inputs = Array.isArray(value.inputs) ? value.inputs.map(projectResultInput) : [];
  const fields = ["sessionId", "runId", "callId", "eventId", "parentSessionId", "branchId"];
  /** @type {Record<string, any>} */
  const publicProducer = { kind: RESULT_PRODUCER_KINDS.includes(producer.kind) ? producer.kind : "workspace" };
  for (const field of fields) publicProducer[field] = typeof producer[field] === "string" ? producer[field] : null;
  return {
    artifactId: value.artifactId, versionId: value.versionId, projectId: value.projectId,
    path: normalizeResultPath(value.path), digest: value.digest, size: value.size,
    mimeType: value.mimeType ?? "application/octet-stream", capturedAt: value.capturedAt,
    producer: publicProducer, inputs, code: value.code ? projectResultInput(value.code) : null,
    environment: value.environment ? projectResultInput(value.environment) : null,
    method: projectResultMethod(value.method),
    findings: Array.isArray(value.findings) ? value.findings.map((/** @type {any} */ finding) => ({
      id: finding.id, kind: finding.kind, status: finding.status, message: finding.message,
      elementId: finding.elementId ?? null, sourceRefs: finding.sourceRefs ?? [],
      machineValues: finding.machineValues ?? [], versionId: value.versionId })) : [],
    machineValues: Array.isArray(value.machineValues) ? value.machineValues : [],
    review: value.review ? { status: ["available", "unavailable", "unknown"].includes(value.review.status) ? value.review.status : "unknown",
      matrixText: typeof value.review.matrixText === "string" ? value.review.matrixText : null,
      verification: value.review.verification ?? null,
      matrixVersionId: typeof value.review.matrixVersionId === "string" ? value.review.matrixVersionId : null,
      matrixDigest: isResultDigest(value.review.matrixDigest) ? value.review.matrixDigest : null } : { status: "unknown" },
    coverage: value.coverage, supersedesVersionId: value.supersedesVersionId ?? null,
    // How the bytes were produced and which calculation each printed number came from (`resultLineage.mjs`).
    // A version captured before either was recorded says so: it is unobserved, and its numbers are not checked.
    snapshot: projectProducerSnapshot(value.snapshot) ?? unobservedSnapshot(),
    bindings: value.bindings ? projectValueBindings(value.bindings) : emptyValueBindings(),
  };
}

/** The reference stays on the exact version. Matching text in a later file is
 * insufficient to make a stale selection valid.
 * @param {any} version @param {any} anchor @returns {any} */
export function validateResultAnchor(version, anchor) {
  if (!anchor || anchor.versionId !== version.versionId || anchor.digest !== version.digest) {
    throw new Error("The selected result version changed.");
  }
  if (!["text", "table-cell", "figure", "claim", "pdf-region", "rendered-element"].includes(anchor.kind ?? "text")
    || typeof anchor.elementId !== "string" || !anchor.elementId || anchor.elementId.length > 512
    || typeof anchor.selectedText !== "string" || anchor.selectedText.length > 12000
    || (anchor.instruction != null && (typeof anchor.instruction !== "string" || !anchor.instruction.trim() || anchor.instruction.length > 12000))) {
    throw new Error("Invalid result selection.");
  }
  if (anchor.sourceDigest != null && !isResultDigest(anchor.sourceDigest)) throw new Error("Invalid source digest.");
  if (anchor.page != null && (!Number.isSafeInteger(anchor.page) || anchor.page < 1)) throw new Error("Invalid source page.");
  for (const coordinate of ["row", "column"]) {
    if (anchor[coordinate] != null && (!Number.isSafeInteger(anchor[coordinate]) || anchor[coordinate] < 0)) throw new Error("Invalid table selection.");
  }
  if (anchor.kind === "rendered-element" && !["text", "table-cell", "figure", "claim"].includes(anchor.elementKind)) throw new Error("Invalid rendered selection.");
  return { versionId: version.versionId, digest: version.digest, kind: anchor.kind ?? "text", elementId: anchor.elementId,
    selectedText: anchor.selectedText, ...(anchor.instruction ? { instruction: anchor.instruction } : {}),
    ...(anchor.kind === "rendered-element" ? { elementKind: anchor.elementKind, matchMode: "rendered_selection_unverified" } : {}),
    ...(anchor.row != null ? { row: anchor.row } : {}), ...(anchor.column != null ? { column: anchor.column } : {}),
    ...(anchor.sourceDigest ? { sourceDigest: anchor.sourceDigest, page: anchor.page ?? null,
      parserId: typeof anchor.parserId === "string" ? anchor.parserId : null,
      regionId: typeof anchor.regionId === "string" ? anchor.regionId : null } : {}) };
}

/** @param {any} before @param {any} after @returns {any} */
export function resultVersionDifference(before, after) {
  /** @param {any} input */
  const inputKey = input => `${input.kind}:${input.id}:${input.versionId ?? ""}:${input.digest ?? "unknown"}`;
  const oldInputs = new Set((before.inputs ?? []).map(inputKey));
  const newInputs = new Set((after.inputs ?? []).map(inputKey));
  return { beforeVersionId: before.versionId, afterVersionId: after.versionId,
    bytes: before.digest === after.digest ? "identical" : "changed",
    pathChanged: before.path !== after.path,
    addedInputs: [...newInputs].filter(key => !oldInputs.has(key)),
    removedInputs: [...oldInputs].filter(key => !newInputs.has(key)),
    machineValues: JSON.stringify(before.machineValues ?? []) === JSON.stringify(after.machineValues ?? []) ? "identical" : "changed",
    method: resultMethodDifference(before.method, after.method),
    applicability: "not_assessed" };
}

/** Whether two results ran the same method record. A side with no record cannot be said to match.
 * @param {any} before @param {any} after @returns {"identical" | "changed" | "unknown"} */
export function resultMethodDifference(before, after) {
  const left = projectResultMethod(before); const right = projectResultMethod(after);
  if (!left || !right) return "unknown";
  return left.id === right.id && left.version === right.version && left.digest === right.digest
    && left.seeded === right.seeded && left.seed === right.seed ? "identical" : "changed";
}
