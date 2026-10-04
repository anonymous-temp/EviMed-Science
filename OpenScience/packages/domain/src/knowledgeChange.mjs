/**
 * What a change to a source means for the work that rests on it (plan 2026-10-02 §11.3 N15).
 *
 * A source changes in two ways the platform can observe for itself: the publisher of a work records a correction, an
 * expression of concern or a retraction (`sourceUpdates.mjs`), and the knowledge base receives new bytes for a file it
 * already holds, which is a new content-addressed document beside the old one. Both reach the same question: which of
 * the researcher's work rests on the old state of that source. This module is the vocabulary of the answer; the lookups
 * that fill it are the control plane's (`knowledgeChange.mjs`, `resultImpact.mjs`).
 *
 * Hidden knowledge:
 *
 * - **Found by recorded links, never by what a thing says.** A result rests on a source when one of its recorded inputs
 *   names it (by identifier, or by the digest of the exact bytes when the source is a knowledge-base document); a
 *   calculation among the value bindings of a report is the same, one step along `bindingSources`; a memory rests on it
 *   by its `record_sources` link, a learned method through the immutable result versions its record names. A title, a
 *   topic or a similar-looking sentence is not a link.
 * - **A notice is not a verdict.** A correction says the source changed; whether the conclusion that cites it still
 *   stands is for the researcher or a recheck to say. Every sentence built from this record states the change and what
 *   depends on it, and none says the result is wrong. The label never moves a version, withholds a delivery or hides
 *   a thing: it is read beside the work.
 * - **Unknown is a value.** A lookup that could not be made is `unknown`, which is neither "nothing depends on this"
 *   nor "this is clean": each class of dependent carries its own lookup state, and a class whose lookup failed says so.
 *   A check that could not be made does not downgrade what an earlier check found.
 * - **Only affected work is named, so only it is rechecked.** The record lists the dependents that were found; an agenda
 *   asked to continue is told to take those and leave the rest of the researcher's work as it is.
 *
 * Pure, browser-safe, no I/O, no hashing (the identity of a label is cut by the control plane, which has a hash).
 * @module @evimed/domain/knowledgeChange
 */

import { SOURCE_UPDATE_WEIGHT } from "./sourceUpdates.mjs";

/** The `kind` of the one notice a knowledge-base replacement carries: not a publisher's, the knowledge base's own. */
export const SOURCE_REPLACED_KIND = "replaced";

/** The kinds of work a source change can reach, in the order a reader is shown them. */
export const AFFECTED_CLASSES = Object.freeze(["calculations", "dependents", "memories", "methods"]);

/** What one lookup of a class found: something, nothing, or it could not be made. */
export const AFFECTED_LOOKUP_STATES = Object.freeze(["found", "none", "unknown"]);

/** How the version of an impact rests on the source: it names it itself, or a calculation among its bound values does. */
export const AFFECTED_VIA = Object.freeze(["input", "calculation"]);

/** How a learned method meets a result version: learnt from it, or used for it. */
export const METHOD_SOURCE_RELATIONS = Object.freeze(["learnt_from", "used_for"]);

/** How many entries of one class a record lists; the total says how many there were. */
export const AFFECTED_LIST_LIMIT = 20;

/** How many source changes one method keeps; the oldest go first. */
export const METHOD_SOURCE_CHANGE_LIMIT = 20;

/** The states a link may take from a check; every one is also a state of the memory source link. */
export const SOURCE_CHANGE_LINK_STATES = Object.freeze(["current", "changed", "retracted", "unknown"]);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** @param {unknown} value @param {number} max @returns {string | null} */
const text = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max && ![...value].some((char) => char.charCodeAt(0) < 32) ? value : null);

/** @param {unknown} value @returns {string | null} */
const versionIdOf = (value) => (typeof value === "string" && /^rv_[a-f0-9]{64}$/.test(value) ? value : null);

/** @param {unknown} value @returns {string | null} */
const timeOf = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

/** @param {unknown} value @returns {number} */
const countOf = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0);

/**
 * The state a source's recorded links take from one check of it. A retraction, a withdrawal or a removal is
 * `retracted`; any other notice, and a replaced knowledge-base file, is `changed`; a check that found nothing is
 * `current`; and a check that could not answer, or an answer this does not know, is `unknown` — never `current`.
 * @param {{ state?: unknown, updates?: unknown } | null | undefined} status a source update status (`sourceUpdates.mjs`)
 * @returns {"current" | "changed" | "retracted" | "unknown"}
 */
export function linkStateOf(status) {
  if (status?.state === "no_update") return "current";
  if (status?.state !== "changed") return "unknown";
  const updates = Array.isArray(status.updates) ? status.updates : [];
  return updates.some((/** @type {any} */ update) => /** @type {Record<string, string>} */ (SOURCE_UPDATE_WEIGHT)[String(update?.kind)] === "withdrawn") ? "retracted" : "changed";
}

/**
 * Which states a link may leave for the state a check found. A check moves a link only where it adds knowledge: a
 * retraction outranks a correction, a correction is never turned back into `unknown` by a check that could not be
 * made, and `unknown` is the one state a later clean check may set right. Nothing here lowers a retraction.
 * @param {string} next
 * @returns {string[]}
 */
export function linkStatesLeftFor(next) {
  if (next === "retracted") return ["current", "unknown", "changed", "expired"];
  if (next === "changed") return ["current", "unknown", "expired"];
  if (next === "unknown") return ["current"];
  if (next === "current") return ["unknown"];
  return [];
}

/**
 * The short machine reason a link is labelled with: what kind of notice, or why the check could not answer.
 * @param {{ state?: unknown, reason?: unknown, updates?: unknown } | null | undefined} status
 * @returns {string}
 */
export function linkReasonOf(status) {
  const updates = Array.isArray(status?.updates) ? status.updates : [];
  if (status?.state === "changed") {
    const kinds = updates.map((/** @type {any} */ update) => String(update?.kind ?? ""));
    for (const kind of [...Object.keys(SOURCE_UPDATE_WEIGHT), SOURCE_REPLACED_KIND]) if (kinds.includes(kind)) return kind;
    return "changed";
  }
  if (status?.state === "no_update") return "no_update";
  const reason = typeof status?.reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(status.reason) ? status.reason : "unavailable";
  return `check_${reason}`;
}

/** @param {unknown} raw @returns {{ versionId: string, path: string | null, boundValues: number, keys: string[] } | null} */
function projectResultEntry(raw) {
  const versionId = isRecord(raw) ? versionIdOf(raw.versionId) : null;
  if (!versionId || !isRecord(raw)) return null;
  return { versionId, path: text(raw.path, 4096), boundValues: countOf(raw.boundValues),
    keys: (Array.isArray(raw.keys) ? raw.keys : []).flatMap((/** @type {unknown} */ key) => text(key, 200) ?? []).slice(0, 5) };
}

/** @param {unknown} raw @returns {{ recordId: string, scope: string, kind: string, state: string } | null} */
function projectMemoryEntry(raw) {
  const recordId = isRecord(raw) ? text(raw.recordId, 200) : null;
  if (!recordId || !isRecord(raw)) return null;
  return { recordId, scope: text(raw.scope, 40) ?? "", kind: text(raw.kind, 40) ?? "",
    state: SOURCE_CHANGE_LINK_STATES.includes(/** @type {any} */ (raw.state)) || raw.state === "expired" ? String(raw.state) : "unknown" };
}

/** @param {unknown} raw @returns {{ id: string, title: string | null, relation: string, versionId: string | null } | null} */
function projectMethodEntry(raw) {
  const id = isRecord(raw) ? text(raw.id, 200) : null;
  if (!id || !isRecord(raw)) return null;
  return { id, title: text(raw.title, 120), relation: METHOD_SOURCE_RELATIONS.includes(/** @type {any} */ (raw.relation)) ? String(raw.relation) : "used_for",
    versionId: versionIdOf(raw.versionId) };
}

const PROJECT_ENTRY = Object.freeze({
  calculations: projectResultEntry, dependents: projectResultEntry, memories: projectMemoryEntry, methods: projectMethodEntry,
});

/**
 * One class of what depends on a source, as stored: how the lookup went, how many there were, and the first of them.
 * A lookup that was not made is `unknown` with its reason, whatever else the stored record claims.
 * @param {unknown} raw @param {keyof typeof PROJECT_ENTRY} name
 */
function projectClass(raw, name) {
  if (!isRecord(raw) || !AFFECTED_LOOKUP_STATES.includes(raw.status)) return { status: "unknown", reason: "not_recorded", total: 0, items: [] };
  const project = /** @type {(entry: unknown) => any} */ (PROJECT_ENTRY[name]);
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((entry) => project(entry) ?? []).slice(0, AFFECTED_LIST_LIMIT);
  if (raw.status === "unknown") return { status: "unknown", reason: text(raw.reason, 80) ?? "lookup_failed", total: 0, items: [] };
  const total = Math.max(countOf(raw.total), items.length);
  return { status: total > 0 ? "found" : "none", reason: null, total, items };
}

/**
 * The closed projection of what depends on a changed source, for one result version. Absent or unreadable input is
 * null: a record written before this was recorded says nothing, and is not read as "nothing depends on it".
 * @param {unknown} raw
 * @returns {{ schemaVersion: 1, via: string, calculations: any, dependents: any, memories: any, methods: any } | null}
 */
export function projectAffected(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  return { schemaVersion: 1, via: AFFECTED_VIA.includes(/** @type {any} */ (raw.via)) ? String(raw.via) : "input",
    calculations: projectClass(raw.calculations, "calculations"), dependents: projectClass(raw.dependents, "dependents"),
    memories: projectClass(raw.memories, "memories"), methods: projectClass(raw.methods, "methods") };
}

/**
 * What one class holds, for a record built from lookups: a lookup that found nothing is `none`, one that could not be
 * made is `unknown` with its reason. Bounded; the total is kept when the list is cut.
 * @param {{ items?: readonly unknown[], unknown?: string | null, total?: number }} found
 * @param {keyof typeof PROJECT_ENTRY} name
 */
export function affectedClass(found, name) {
  if (found?.unknown) return { status: "unknown", reason: String(found.unknown).slice(0, 80), total: 0, items: [] };
  const project = /** @type {(entry: unknown) => any} */ (PROJECT_ENTRY[name]);
  const items = (found?.items ?? []).flatMap((entry) => project(entry) ?? []);
  const total = Math.max(countOf(found?.total), items.length);
  return { status: total > 0 ? "found" : "none", reason: null, total, items: items.slice(0, AFFECTED_LIST_LIMIT) };
}

/**
 * What a researcher is told in one line: how many of each kind of work were found, and which lookups could not be
 * made. The count of a class whose lookup failed is not zero and is not given as one.
 * @param {ReturnType<typeof projectAffected>} affected
 * @returns {{ found: Record<string, number>, unknown: string[] }}
 */
export function affectedCounts(affected) {
  /** @type {Record<string, number>} */
  const found = {};
  /** @type {string[]} */
  const unknown = [];
  for (const name of AFFECTED_CLASSES) {
    const entry = affected?.[/** @type {"calculations"} */ (name)];
    if (!entry || entry.status === "unknown") unknown.push(name);
    else if (entry.total > 0) found[name] = entry.total;
  }
  return { found, unknown };
}

/**
 * Add one source change to a method's record: the source, the state it was found in, why, the result version the
 * method is linked to and how, and when. Idempotent by the entry's own identity, bounded to the newest
 * `METHOD_SOURCE_CHANGE_LIMIT`. Returns the same array when there is nothing to add, so a caller can tell. It is a
 * label read beside the method: no revision of the method moves, and its lifecycle (`retirementProposal`) never reads it.
 * @param {unknown} existing @param {unknown} entry
 * @returns {Array<Record<string, any>>}
 */
export function foldSourceChange(existing, entry) {
  const list = Array.isArray(existing) ? existing : [];
  const id = isRecord(entry) && typeof entry.id === "string" && /^sc_[a-f0-9]{32}$/.test(entry.id) ? entry.id : null;
  const source = isRecord(entry) && isRecord(entry.source) ? text(entry.source.id, 512) : null;
  const versionId = isRecord(entry) ? versionIdOf(entry.versionId) : null;
  const at = isRecord(entry) ? timeOf(entry.at) : null;
  if (!id || !source || !versionId || !at || !isRecord(entry)) return list;
  const state = entry.state === "retracted" ? "retracted" : entry.state === "changed" ? "changed" : null;
  if (!state || list.some((/** @type {any} */ item) => item?.id === id)) return list;
  const doi = isRecord(entry.source) ? text(entry.source.doi, 300) : null;
  return [...list, { id, source: { id: source, ...(doi ? { doi } : {}) }, state, reason: text(entry.reason, 60) ?? state, versionId,
    relation: METHOD_SOURCE_RELATIONS.includes(/** @type {any} */ (entry.relation)) ? entry.relation : "used_for", at }].slice(-METHOD_SOURCE_CHANGE_LIMIT);
}

/**
 * The labels a method carries, as the researcher's page reads them: closed, bounded, newest last.
 * @param {unknown} raw
 * @returns {Array<{ id: string, source: { id: string, doi?: string }, state: string, reason: string, versionId: string, relation: string, at: string }>}
 */
export function methodSourceChanges(raw) {
  /** @type {any[]} */
  let kept = [];
  for (const item of Array.isArray(raw) ? raw : []) kept = foldSourceChange(kept, item);
  return kept;
}
