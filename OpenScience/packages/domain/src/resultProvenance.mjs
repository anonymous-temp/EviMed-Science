/** Immutable result vocabulary. Inputs are facts captured by owned producers,
 * never an execution recipe inferred from an artifact's filename or prose. */
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
    applicability: "not_assessed" };
}
