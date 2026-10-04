/**
 * A correction, as a fact about two immutable result versions (plan 2026-10-02 §11.3 N12).
 *
 * A researcher selects something in a delivered result ("check this denominator", "add this study", "change this
 * analysis") and says what they want in the native composer; the run writes the revised form of the selection beside
 * the original (`resultRevision.mjs`). What this module holds is what that act IS once both versions exist: the pair
 * of version identities, what differs between them, and the words the researcher gave. It is the evidence the learning
 * loop reads (`feedbackEvents.mjs`, trigger `result-corrected`) and the record the result view shows.
 *
 * Hidden knowledge:
 *
 * - **The pair is two immutable versions, never a path.** The older feedback producers named a deliverable by
 *   `<run>:<path>` and its bytes by a digest taken when the event was posted, so a path overwritten later changed what
 *   the event was about. A correction names `(original versionId, digest)` and `(successor versionId, digest)`; those
 *   cannot move, and N14 joins them to the method digest the original's run used and to the version a later task
 *   produced, by those identifiers.
 * - **What a correction IS comes from the two versions, never from the instruction.** "Check this denominator" and
 *   "change this analysis" are language, and regex does not read language; whether the printed numbers moved, whether
 *   the identifiers of the sources (a DOI, a PMID, a trial number) or the marked claims moved, whether a calculation's
 *   machine values moved, are decidable from the bytes. The `kind` is a closed reading of those effects, and where the
 *   bytes cannot be read (a PDF, a raster figure, a result a restricted source is embedded in) the kind is `unknown`,
 *   which is a value and not a failure.
 * - **The researcher's words are theirs; the successor is not.** The instruction is the researcher's, recorded
 *   bounded and never when it carries what `hasSensitiveText` names. The successor is something the platform's run
 *   generated: the record says `successorOrigin: "system_generated"` and `adoption: "not_recorded"`. Nothing here is a
 *   `deliverable-adopted`, and keeping a correction the researcher asked for is not an approval of what was produced.
 * - **A label, never a gate.** Nothing in this module refuses a revision, withholds a successor or asks anyone to
 *   confirm anything.
 *
 * Pure, browser-safe, no I/O.
 * @module @evimed/domain/resultCorrection
 */

import { markedClaimIds, referenceIdentifiers } from "./clinicalEvidence.mjs";
import { resultVersionDifference } from "./resultProvenance.mjs";
import { hasSensitiveText } from "./sensitiveText.mjs";
import { printedNumberWords } from "./valueBindings.mjs";

/** The version of this record's shape. */
export const RESULT_CORRECTION_VERSION = 1;

/**
 * What a correction did, read from the two versions. `analytic`: printed numbers or a calculation's machine values
 * moved. `evidence`: the sources or the marked claims moved and no number did. `presentation`: the bytes changed and
 * neither numbers nor sources did (a restyled figure, a reworded sentence). `unknown`: the two versions cannot be
 * compared by their bytes.
 */
export const RESULT_CORRECTION_KINDS = Object.freeze(["analytic", "evidence", "presentation", "unknown"]);

/** The outcome of one comparison. `unknown` is a value: a side that could not be read says so. */
export const RESULT_CORRECTION_STATES = Object.freeze(["changed", "identical", "unknown"]);

/** What the researcher selected, by the vocabulary the revision's anchor already has. */
export const RESULT_CORRECTION_ANCHOR_KINDS = Object.freeze(["text", "table-cell", "figure", "claim", "pdf-region", "rendered-element"]);

/** The most the researcher's own words take of one record; the ledger bounds a whole event at 4 KiB. */
const INSTRUCTION_LIMIT = 600;
const SELECTION_LIMIT = 300;
/** How many of each list one record carries, so a large rewrite is a count and never a megabyte. */
const LIST_LIMIT = 8;
const WORD_LIMIT = 12;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {number} max */
const bounded = (value, max) => (typeof value === "string"
  ? [...value].filter((char) => char.charCodeAt(0) >= 32 || char === "\t" || char === "\n" || char === "\r").join("").trim().slice(0, max) : "");
/** @param {unknown} value */
const digestOf = (value) => (typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null);
/** @param {unknown} value */
const versionIdOf = (value) => (typeof value === "string" && /^rv_[a-f0-9]{64}$/.test(value) ? value : null);

/** The multiset difference of two word lists: what `after` has more of, and what it has less of.
 * @param {string[]} before @param {string[]} after */
function multisetDifference(before, after) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const word of before) counts.set(word, (counts.get(word) ?? 0) - 1);
  for (const word of after) counts.set(word, (counts.get(word) ?? 0) + 1);
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  for (const [word, count] of counts) for (let index = 0; index < Math.abs(count); index += 1) (count > 0 ? added : removed).push(word);
  return { added, removed };
}

/**
 * The identifiers a text names in closed formats (a DOI, a PMID, a PMC id, a trial registration number). Their digits
 * name a source; they are not numbers of the analysis, so what a text prints is read with them taken out.
 */
const IDENTIFIER_SPANS = /10\.\d{4,9}\/[^\s\]，。；、)]+|PMID:?\s*\d{5,9}|PMC\d{5,9}|NCT\d{8}|ChiCTR[-A-Za-z0-9]+|ISRCTN\d{8}/gi;

/** @param {string} text */
const withoutIdentifiers = (text) => text.replace(IDENTIFIER_SPANS, " ");

/**
 * The normalised identifiers a text names. A DOI written in running Chinese prose runs on into the sentence's full-width stop
 * and the words after it, none of which is part of it: an identifier ends where printable ASCII does.
 * @param {string} text @returns {Set<string>}
 */
const identifierSet = (text) => new Set([...referenceIdentifiers(text)].map((key) => key.replace(/[^\u0021-\u007e].*$/su, "")));

/** @param {Set<string>} before @param {Set<string>} after */
function setDifference(before, after) {
  return { added: [...after].filter((item) => !before.has(item)), removed: [...before].filter((item) => !after.has(item)) };
}

/** @param {any} input */
const inputKey = (input) => `${input.kind}:${input.id}:${input.versionId ?? ""}:${input.digest ?? "unknown"}`;

/**
 * What differs between an original and its successor, decided from their bytes and their recorded links.
 *
 * `beforeText` and `afterText` are the decoded bytes of each side, or null when a side is not text, could not be read
 * or may not be read (a restricted source embedded in it). A side that is null makes every comparison of bytes
 * `unknown`; it never reads as identical.
 *
 * @param {{ before: any, after: any, beforeText?: string | null, afterText?: string | null }} input
 *   `before`, `after`: projected result versions (`projectResultVersion`)
 */
export function correctionEffects({ before, after, beforeText = null, afterText = null }) {
  const difference = resultVersionDifference(before, after);
  const readable = typeof beforeText === "string" && typeof afterText === "string";
  /** @type {{ before: ReturnType<typeof printedNumberWords>, after: ReturnType<typeof printedNumberWords> } | null} */
  const printed = readable ? {
    before: printedNumberWords({ body: withoutIdentifiers(/** @type {string} */ (beforeText)), path: before.path, mimeType: before.mimeType }),
    after: printedNumberWords({ body: withoutIdentifiers(/** @type {string} */ (afterText)), path: after.path, mimeType: after.mimeType }),
  } : null;
  const numbersCheckable = Boolean(printed?.before.checkable && printed.after.checkable);
  const numbers = numbersCheckable && printed ? multisetDifference(printed.before.words, printed.after.words) : { added: [], removed: [] };
  const printedNumbers = !numbersCheckable ? "unknown" : numbers.added.length || numbers.removed.length ? "changed" : "identical";

  const hasValues = (before.machineValues ?? []).length > 0 || (after.machineValues ?? []).length > 0;
  const machineValues = !hasValues ? "none" : difference.machineValues;

  const identifiers = readable
    ? setDifference(identifierSet(/** @type {string} */ (beforeText)), identifierSet(/** @type {string} */ (afterText)))
    : { added: [], removed: [] };
  const claims = readable
    ? setDifference(new Set(markedClaimIds(/** @type {string} */ (beforeText))), new Set(markedClaimIds(/** @type {string} */ (afterText))))
    : { added: [], removed: [] };
  const evidence = !readable ? "unknown" : identifiers.added.length || identifiers.removed.length || claims.added.length || claims.removed.length ? "changed" : "identical";

  // The revision's own link to the original is not a change of inputs.
  const beforeInputs = new Set((before.inputs ?? []).map(inputKey));
  const afterInputs = new Set((after.inputs ?? []).filter((/** @type {any} */ input) => input.versionId !== before.versionId).map(inputKey));
  const inputs = setDifference(beforeInputs, afterInputs);

  /** @type {(typeof RESULT_CORRECTION_KINDS)[number]} */
  let kind = "unknown";
  if (printedNumbers === "changed" || machineValues === "changed") kind = "analytic";
  else if (evidence === "changed" || inputs.added.length || inputs.removed.length) kind = "evidence";
  else if (before.digest !== after.digest && printedNumbers === "identical") kind = "presentation";
  return {
    kind,
    effects: {
      bytes: before.digest === after.digest ? "identical" : "changed",
      printedNumbers, machineValues, evidence,
      numbersAdded: numbers.added.slice(0, WORD_LIMIT), numbersRemoved: numbers.removed.slice(0, WORD_LIMIT),
      numbersAddedCount: numbers.added.length, numbersRemovedCount: numbers.removed.length,
      identifiersAdded: identifiers.added.slice(0, LIST_LIMIT), identifiersRemoved: identifiers.removed.slice(0, LIST_LIMIT),
      claimsAdded: claims.added.slice(0, LIST_LIMIT), claimsRemoved: claims.removed.slice(0, LIST_LIMIT),
      inputsAdded: inputs.added.length, inputsRemoved: inputs.removed.length,
      method: difference.method,
    },
  };
}

/**
 * The calculations a correction recomputed, from the value bindings of the two versions: a printed value of the
 * original bound to one calculation version and the same key printed from another in the successor. The key is the
 * calculation's own, so this is a recorded link (N06) and never a guess from names. Bounded.
 * @param {any} before @param {any} after
 * @returns {Array<{ key: string, unit: string | null, before: { versionId: string, value: number }, after: { versionId: string, value: number } }>}
 */
export function correctionCalculations(before, after) {
  const prior = new Map((before?.bindings?.items ?? []).map((/** @type {any} */ item) => [item.calculation.key, item.calculation]));
  /** @type {Map<string, any>} */
  const found = new Map();
  for (const item of after?.bindings?.items ?? []) {
    const old = prior.get(item.calculation.key);
    if (!old || old.versionId === item.calculation.versionId) continue;
    found.set(`${old.versionId}\u0000${item.calculation.versionId}\u0000${item.calculation.key}`, { key: item.calculation.key, unit: item.calculation.unit ?? null,
      before: { versionId: old.versionId, value: old.value }, after: { versionId: item.calculation.versionId, value: item.calculation.value } });
  }
  return [...found.values()].slice(0, LIST_LIMIT * 2);
}

/**
 * The record a correction is carried as: in the feedback ledger's `detail`, and as the answer of the result view.
 * A closed projection, bounded to fit the ledger's allowance with the effects beside it.
 *
 * `instruction` is the researcher's own words, kept bounded and dropped when it carries what `hasSensitiveText` names
 * (the digest stays, so a later reading can tell two instructions apart without holding either).
 * @param {unknown} raw
 */
export function projectResultCorrection(raw) {
  const source = isObject(raw) ? raw : {};
  const side = (/** @type {unknown} */ value) => {
    const version = isObject(value) ? value : {};
    return { versionId: versionIdOf(version.versionId), digest: digestOf(version.digest), path: bounded(version.path, 300) || null };
  };
  const original = side(source.original);
  const successor = side(source.successor);
  if (!original.versionId || !original.digest || !successor.versionId || !successor.digest) throw new Error("A correction names both immutable versions.");
  const effects = isObject(source.effects) ? source.effects : {};
  const state = (/** @type {unknown} */ value) => (RESULT_CORRECTION_STATES.includes(/** @type {any} */ (value)) ? /** @type {string} */ (value) : "unknown");
  const words = (/** @type {unknown} */ value, /** @type {number} */ limit) => (Array.isArray(value) ? value.map((item) => bounded(item, 80)).filter(Boolean).slice(0, limit) : []);
  const count = (/** @type {unknown} */ value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0);
  const anchor = isObject(source.anchor) ? source.anchor : {};
  const instructionText = bounded(source.instruction, INSTRUCTION_LIMIT);
  const method = isObject(source.originalMethod) && typeof source.originalMethod.id === "string"
    ? { id: bounded(source.originalMethod.id, 200), version: bounded(source.originalMethod.version, 64) || null, digest: digestOf(source.originalMethod.digest) } : null;
  return {
    schemaVersion: RESULT_CORRECTION_VERSION,
    revisionId: typeof source.revisionId === "string" && /^rr_[a-f0-9]{64}$/.test(source.revisionId) ? source.revisionId : null,
    original, successor,
    kind: RESULT_CORRECTION_KINDS.includes(source.kind) ? /** @type {string} */ (source.kind) : "unknown",
    effects: {
      bytes: state(effects.bytes), printedNumbers: state(effects.printedNumbers),
      machineValues: ["changed", "identical", "none"].includes(/** @type {any} */ (effects.machineValues)) ? /** @type {string} */ (effects.machineValues) : "unknown",
      evidence: state(effects.evidence),
      numbersAdded: words(effects.numbersAdded, WORD_LIMIT), numbersRemoved: words(effects.numbersRemoved, WORD_LIMIT),
      numbersAddedCount: count(effects.numbersAddedCount), numbersRemovedCount: count(effects.numbersRemovedCount),
      identifiersAdded: words(effects.identifiersAdded, LIST_LIMIT), identifiersRemoved: words(effects.identifiersRemoved, LIST_LIMIT),
      claimsAdded: words(effects.claimsAdded, LIST_LIMIT), claimsRemoved: words(effects.claimsRemoved, LIST_LIMIT),
      inputsAdded: count(effects.inputsAdded), inputsRemoved: count(effects.inputsRemoved),
      method: ["identical", "changed", "unknown"].includes(/** @type {any} */ (effects.method)) ? /** @type {string} */ (effects.method) : "unknown",
    },
    anchor: {
      kind: RESULT_CORRECTION_ANCHOR_KINDS.includes(anchor.kind) ? /** @type {string} */ (anchor.kind) : "text",
      elementId: bounded(anchor.elementId, 120) || null,
      selectedText: bounded(anchor.selectedText, SELECTION_LIMIT),
      ...(Number.isSafeInteger(anchor.page) ? { page: anchor.page } : {}),
      ...(Number.isSafeInteger(anchor.row) ? { row: anchor.row } : {}),
      ...(Number.isSafeInteger(anchor.column) ? { column: anchor.column } : {}),
    },
    instructionDigest: digestOf(source.instructionDigest),
    instruction: instructionText && !hasSensitiveText(instructionText) ? instructionText : null,
    // Who said what: the words are the researcher's, the successor is the platform run's. Adoption is a separate act the
    // researcher may or may not do later, and this record is not it.
    instructionOrigin: "researcher",
    successorOrigin: "system_generated",
    adoption: "not_recorded",
    capabilityId: bounded(source.capabilityId, 120) || null,
    originalRunId: bounded(source.originalRunId, 160) || null,
    revisionRunId: bounded(source.revisionRunId, 160) || null,
    originalMethod: method,
  };
}

/** The ledger's allowance for one event's detail, in bytes (`feedbackEvents.mjs`). */
export const RESULT_CORRECTION_DETAIL_BYTES = 4096;

/** @param {unknown} value */
const sizeOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * A correction record cut, step by step, until it fits the ledger's allowance for one event; the counts and both
 * version identities are never cut, the lists and the words are. A record that already fits is returned as it is.
 * @param {ReturnType<typeof projectResultCorrection>} record @param {number} [maxBytes]
 */
export function fitResultCorrection(record, maxBytes = RESULT_CORRECTION_DETAIL_BYTES) {
  /** @param {string[]} list @param {number} items @param {number} width */
  const cut = (list, items, width) => list.slice(0, items).map((item) => item.slice(0, width));
  /** @param {ReturnType<typeof projectResultCorrection>} value @param {{ items: number, width: number, selection: number, instruction: number }} step */
  const shape = (value, step) => ({ ...value,
    effects: { ...value.effects, numbersAdded: cut(value.effects.numbersAdded, step.items, step.width), numbersRemoved: cut(value.effects.numbersRemoved, step.items, step.width),
      identifiersAdded: cut(value.effects.identifiersAdded, step.items, step.width), identifiersRemoved: cut(value.effects.identifiersRemoved, step.items, step.width),
      claimsAdded: cut(value.effects.claimsAdded, step.items, step.width), claimsRemoved: cut(value.effects.claimsRemoved, step.items, step.width) },
    anchor: { ...value.anchor, selectedText: value.anchor.selectedText.slice(0, step.selection) },
    instruction: value.instruction === null ? null : value.instruction.slice(0, step.instruction) || null,
    originalMethod: value.originalMethod });
  const steps = [
    { items: LIST_LIMIT, width: 80, selection: SELECTION_LIMIT, instruction: INSTRUCTION_LIMIT },
    { items: 6, width: 40, selection: 160, instruction: 400 },
    { items: 4, width: 32, selection: 80, instruction: 240 },
    { items: 2, width: 24, selection: 40, instruction: 120 },
    { items: 0, width: 0, selection: 0, instruction: 0 },
  ];
  let fitted = record;
  for (const step of steps) {
    fitted = shape(record, step);
    if (sizeOf(fitted) <= maxBytes) return fitted;
  }
  return fitted;
}

/**
 * What a settled revision says about what the run produced, in the shape the revision record keeps: the successor the
 * run ended on, every output it left in the revision's directory, the calculations recomputed, and what the run was told
 * the change could reach. Renderings (Word, PDF, HTML) the run wrote are named as such with their consistency with the
 * successor unchecked. A rendering the platform makes from a version's own bytes (the version-bound conversion in
 * `documentExport.mjs`) is consistent by construction and is not among these: it is not something the run left.
 * @param {unknown} raw
 */
export function projectCorrectionOutcome(raw) {
  const source = isObject(raw) ? raw : {};
  const status = ["settled", "no_successor"].includes(source.status) ? /** @type {string} */ (source.status) : "no_successor";
  const outputs = Array.isArray(source.outputs) ? source.outputs.slice(0, 40).flatMap((/** @type {any} */ item) => {
    const versionId = versionIdOf(item?.versionId);
    const path = bounded(item?.path, 300);
    if (!versionId || !path) return [];
    return [{ versionId, path, role: ["successor", "rendering", "other"].includes(item.role) ? /** @type {string} */ (item.role) : "other",
      format: bounded(item.format, 8) || null,
      // Nothing reads a Word, a PDF or a figure's bytes here, so a rendering's consistency with the successor is not checked.
      // That is a value of its own, and it is never read as consistent.
      consistency: "not_checked" }];
  }) : [];
  const calculations = Array.isArray(source.calculations) ? source.calculations.slice(0, LIST_LIMIT * 2).flatMap((/** @type {any} */ item) => {
    const key = bounded(item?.key, 300);
    const beforeId = versionIdOf(item?.before?.versionId);
    const afterId = versionIdOf(item?.after?.versionId);
    if (!key || !beforeId || !afterId || !Number.isFinite(item.before.value) || !Number.isFinite(item.after.value)) return [];
    return [{ key, unit: bounded(item.unit, 40) || null, before: { versionId: beforeId, value: item.before.value }, after: { versionId: afterId, value: item.after.value } }];
  }) : [];
  const ids = (/** @type {unknown} */ value) => (Array.isArray(value) ? value.map(versionIdOf).filter((/** @type {string | null} */ id) => id !== null).slice(0, 12) : []);
  return {
    status, successorVersionId: versionIdOf(source.successorVersionId), outputs, calculations,
    reach: { calculations: ids(source.reach?.calculations), alsoPrintedFrom: ids(source.reach?.alsoPrintedFrom) },
    settledAt: typeof source.settledAt === "string" && Number.isFinite(Date.parse(source.settledAt)) ? source.settledAt : null,
  };
}

/** The formats of a rendering a run leaves beside a report; a closed list of file types, not a reading of content. */
export const RENDERING_FORMATS = Object.freeze(["docx", "pdf", "html", "htm", "odt", "rtf"]);

/** @param {string} path @returns {string | null} the rendering format of a path by its extension, or null */
export function renderingFormat(path) {
  const dot = path.lastIndexOf(".");
  const extension = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  return RENDERING_FORMATS.includes(extension) ? extension : null;
}
