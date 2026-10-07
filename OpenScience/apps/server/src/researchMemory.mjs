import { createHash, randomUUID } from "node:crypto";
import {
  DURABLE_RECALL_KINDS, recallContent, searchTokens, selectWithinBudget,
} from "./memoryRecallPolicy.mjs";
import { annotateVersions, recordLabels, versionFields, versionsInForce } from "./memoryValidity.mjs";
import { HttpError } from "./security.mjs";
import {
  MEMORY_CONFLICT_STATES,
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_PAUSED_PROJECT_LIMIT,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_SOURCE_LINK_LIMIT,
  MEMORY_SOURCE_STATES,
  MEMORY_SOURCE_TYPES,
  MEMORY_STATUSES,
  migrateResearchMemory,
} from "./researchMemoryPersistence.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { projectMemoryUri, researchMemoryRoots } from "./openVikingClient.mjs";

/**
 * Research memory — the structured records — on the control-plane database.
 *
 * This replaces a REST client to a separate service. The method surface, the
 * return shapes, the ordering and the error codes are the ones its callers
 * already depend on, because the change worth making here is where the rows
 * live, not what a recall or a confirmation means.
 *
 * Two things the boundary used to hide are now decidable in one place:
 * ownership is a column rather than a hidden tag inside the text, and every
 * limit is counted in characters, the unit the routes and the extractor
 * already validate in.
 *
 * 「你写下的笔记」 — a second, hand-written store of the same intent — was
 * deleted on 2026-09-20 along with its table; what a researcher wants
 * remembered they say in a conversation, and the extractor records it with the
 * quote it rests on.
 */

const recordIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const memoryKeyPattern = /^[a-z0-9][a-z0-9._/-]{0,254}$/;
/** The fingerprint separator, written as an escape. A raw control byte in a
 *  source file is invisible to every reader and to every grep that would
 *  look for it. */
const NUL_SEPARATOR = "\u0000";

export const MEMORY_VALUE_LIMIT = 100_000;
export const MEMORY_SUMMARY_LIMIT = 2_000;
export const MEMORY_SCOPE_ID_LIMIT = 255;
export const MEMORY_REASON_LIMIT = 500;
export const MEMORY_QUERY_LIMIT = 500;
export const MEMORY_QUOTE_LIMIT = 4_000;
export const MEMORY_SOURCE_TYPE_LIMIT = 64;
export const MEMORY_SOURCE_REF_LIMIT = 500;
/** One statement answers a whole export. Past this a caller is not exporting,
 *  it is asking the process to hold a database in memory. */
export const MEMORY_EXPORT_LIMIT = 100_000;
/** How many removed records one bulk delete tells the index about row by row,
 *  in its own transaction. Past it, the caller's subtree forget and the
 *  index sweep (`MemorySubstrate.sweepRecordLeaves`) converge the rest: one
 *  transaction inserting a job per row of a very large account is a lock held
 *  for as long as it takes, for work the sweep does anyway. */
export const MEMORY_BULK_OUTBOX_LIMIT = 2_000;

export {
  MEMORY_CONFLICT_STATES, MEMORY_EVIDENCE_LIMIT, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_REVISION_LIMIT, MEMORY_SCOPES,
  MEMORY_SOURCE_LINK_LIMIT, MEMORY_SOURCE_STATES, MEMORY_SOURCE_TYPES, MEMORY_STATUSES,
};

/**
 * Who changed a record: the extractor after a run, the researcher on the
 * page, or the platform (an undo, a supersession it resolved). A closed list,
 * so a revision cannot claim an actor nothing writes.
 */
export const REVISION_ACTORS = Object.freeze(["extraction", "user", "system"]);

/** The weight an origin carries, as extraction sets it (`memoryIntelligence.mjs`). */
const ORIGIN_CONFIDENCE = Object.freeze({ manual: 1, explicit: 1, inferred: 0.6, system: 0.8 });

/** @param {string} field */
function invalid(field) {
  return new HttpError(400, "memory_payload_invalid", `${field} is invalid.`);
}

/**
 * Trim to a character budget.
 *
 * One unit for every limit, and it is the one the callers count in: the routes
 * validate `value.length`, the extractor bounds its candidates the same way,
 * and the model writes UTF-16 strings. The retired service counted Go bytes, so
 * a 2000-character Chinese summary every caller had accepted was refused at the
 * boundary as 6000 bytes — a contract that existed on one side and was
 * discovered on the other by a 400.
 *
 * Cuts between code points: half a surrogate pair is not a shorter string, it
 * is a broken one.
 * @param {unknown} value @param {number} limit @returns {string}
 */
export function boundedText(value, limit) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  let out = "";
  for (const character of text) {
    if (out.length + character.length > limit) break;
    out += character;
  }
  return out;
}

/** @param {unknown} value */
export function boundedScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

/** @param {unknown} value */
export function normalizeMemoryKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * When something happened, to the second.
 *
 * Whole seconds, formatted the way the retired service's protojson formatted
 * them (`2026-09-11T06:51:44Z`), because two behaviours are built on that
 * precision: the extractor counts distinct runs by distinct `observedAt`
 * strings, and the upsert's no-op check compares `lastConfirmedAt` and
 * `expiresAt`. A millisecond that survives a write makes both of them wrong in
 * the direction that writes a new version of an unchanged record forever.
 * @param {unknown} value @returns {string|null}
 */
export function memoryInstant(value) {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value : new Date(String(value));
  const milliseconds = time.getTime();
  if (!Number.isFinite(milliseconds)) return null;
  return `${new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString().slice(0, 19)}Z`;
}

/** @param {unknown} value @param {string} field */
function timestampInput(value, field) {
  if (value == null || value === "") return null;
  const instant = memoryInstant(value);
  if (!instant) throw invalid(field);
  return instant;
}

/**
 * The identity of one piece of evidence: what was said, where, and by what kind
 * of source. Never when — a later run re-quoting the same message adds nothing,
 * which is what makes "distinct observation runs" countable from the timestamps
 * that do survive.
 *
 * `hex(sha256(sourceType ‖ NUL ‖ sourceRef ‖ NUL ‖ quote))[0:32]`, the formula
 * of `记忆模块/store/memory_record.go:memoryEvidenceFingerprint`, kept exactly
 * so imported evidence and evidence written after the move dedupe against each
 * other.
 * @param {{sourceType?: unknown, sourceRef?: unknown, quote?: unknown}} evidence
 */
export function evidenceFingerprint(evidence) {
  const fields = [evidence?.sourceType, evidence?.sourceRef, evidence?.quote]
    .map((field) => String(field ?? "").trim());
  return createHash("sha256").update(fields.join(NUL_SEPARATOR)).digest("hex").slice(0, 32);
}

/**
 * Bound one evidence item, or drop it.
 *
 * An over-long quote is trimmed rather than refused: evidence rides along with
 * the record in one write, so refusing the quote loses the memory as well. An
 * empty required field is not evidence at all, and attaching it would fail the
 * record — better an unevidenced record than no record.
 * @param {Record<string, any>|null|undefined} evidence
 */
export function boundedEvidence(evidence) {
  if (!evidence) return null;
  const sourceType = boundedText(evidence.sourceType, MEMORY_SOURCE_TYPE_LIMIT);
  const sourceRef = boundedText(evidence.sourceRef, MEMORY_SOURCE_REF_LIMIT);
  const quote = boundedText(evidence.quote, MEMORY_QUOTE_LIMIT);
  if (!sourceType || !sourceRef || !quote) return null;
  return {
    sourceType,
    sourceRef,
    quote,
    observedAt: memoryInstant(evidence.observedAt) ?? memoryInstant(new Date()),
    weight: boundedScore(evidence.weight ?? 1),
    fingerprint: evidenceFingerprint({ sourceType, sourceRef, quote }),
  };
}

/**
 * Append evidence unless the record already holds it, keeping the newest 64.
 * @param {Array<Record<string, any>>} existing @param {Record<string, any>|null} evidence
 * @returns {{ evidence: Array<Record<string, any>>, added: boolean }}
 */
export function mergeEvidence(existing, evidence) {
  const kept = [...existing];
  if (!evidence) return { evidence: kept, added: false };
  if (kept.some((item) => item.fingerprint === evidence.fingerprint)) return { evidence: kept, added: false };
  kept.push(evidence);
  return { evidence: kept.slice(-MEMORY_EVIDENCE_LIMIT), added: true };
}

/**
 * The actor fields a revision carries, from a caller's options — nothing when
 * the caller named no known actor.
 * @param {unknown} by @param {unknown} runId @returns {Record<string, string>}
 */
function revisionActor(by, runId) {
  const actor = String(by ?? "");
  if (!REVISION_ACTORS.includes(actor)) return {};
  const run = typeof runId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(runId) ? runId : "";
  return { by: actor, ...(run ? { runId: run } : {}) };
}

/** Append one revision, keeping the newest 32.
 *  @param {Array<Record<string, any>>} existing @param {Record<string, any>} revision */
export function appendRevision(existing, revision) {
  return [...existing, revision].slice(-MEMORY_REVISION_LIMIT);
}

/**
 * The pointers and the interval a revision keeps beside the text it holds, so
 * undoing a change puts back exactly what it replaced: what replaced a
 * superseded fact, when the fact stopped holding, and when it began.
 * `validFrom` is always written (null is a value: the start was unknown), so a
 * revision that carries the key is one an undo may restore it from.
 * @param {{ supersededBy?: string | null, invalidSince?: string | null, validFrom?: string | null }} record
 */
function revisionPointers(record) {
  return {
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    ...(record.invalidSince ? { invalidSince: record.invalidSince } : {}),
    validFrom: record.validFrom ?? null,
  };
}

/**
 * Is this write asking for the state the record is already in?
 *
 * Every mutable field, compared at the precision the row is stored at. A write
 * that changes nothing returns the record untouched — no version bump, no new
 * `updatedAt` — because the extractor re-observes the same preference in every
 * run, and a version that moves on each of them would make every later
 * compare-and-swap fail against a record nobody edited.
 * @param {Record<string, any>} stored @param {Record<string, any>} next
 */
export function currentStateEqual(stored, next) {
  return stored.value === next.value
    && stored.summary === next.summary
    && stored.origin === next.origin
    && stored.status === next.status
    && Number(stored.confidence) === Number(next.confidence)
    && Number(stored.importance) === Number(next.importance)
    && Boolean(stored.sensitive) === Boolean(next.sensitive)
    && (stored.lastConfirmedAt ?? null) === (next.lastConfirmedAt ?? null)
    && (stored.expiresAt ?? null) === (next.expiresAt ?? null)
    && (stored.supersededBy ?? null) === (next.supersededBy ?? null)
    && (stored.invalidSince ?? null) === (next.invalidSince ?? null)
    && (stored.validFrom ?? null) === (next.validFrom ?? null);
}

/** @param {unknown} value */
function assertRecordId(value) {
  const id = String(value ?? "");
  if (!recordIdPattern.test(id)) throw new HttpError(400, "memory_id_invalid", "Structured memory id is invalid.");
  return id;
}

/** @param {unknown} value */
function assertUserId(value) {
  const id = String(value ?? "");
  if (!id.trim() || id.length > 200 || [...id].some((character) => character.charCodeAt(0) < 32)) {
    throw invalid("userId");
  }
  return id;
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} field */
function enumValue(value, allowed, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!allowed.includes(normalized)) throw invalid(field);
  return normalized;
}

/** @param {unknown} values @param {readonly string[]} allowed @param {string} field */
function enumFilter(values, allowed, field) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw invalid(field);
  return values.map((value) => enumValue(value, allowed, field));
}

/**
 * Everything a record's mutable state must satisfy before it reaches the
 * database, in the unit the caller counts in.
 * @param {Record<string, any>} input
 */
export function validateRecordInput(input) {
  if (!input || typeof input !== "object") throw invalid("memory");
  const scope = enumValue(input.scope, MEMORY_SCOPES, "scope");
  const scopeId = scope === "user" ? "" : String(input.scopeId ?? "").trim();
  if (scope !== "user" && !scopeId) throw invalid("scopeId");
  if (scopeId.length > MEMORY_SCOPE_ID_LIMIT) throw invalid("scopeId");
  const key = normalizeMemoryKey(input.key);
  if (!memoryKeyPattern.test(key)) throw invalid("key");
  const value = String(input.value ?? "").trim();
  if (!value || value.length > MEMORY_VALUE_LIMIT) throw invalid("value");
  const summary = String(input.summary ?? "").trim();
  if (summary.length > MEMORY_SUMMARY_LIMIT) throw invalid("summary");
  const confidence = Number(input.confidence ?? 0);
  const importance = Number(input.importance ?? 0);
  // Clamped rather than refused, as the retired client clamped before sending:
  // a score outside the range is a caller's arithmetic, not a reason to lose
  // the memory it describes.
  return {
    scope,
    scopeId,
    kind: enumValue(input.kind, MEMORY_KINDS, "kind"),
    key,
    value,
    summary,
    origin: enumValue(input.origin, MEMORY_ORIGINS, "origin"),
    status: enumValue(input.status, MEMORY_STATUSES, "status"),
    confidence: boundedScore(Number.isFinite(confidence) ? confidence : 0),
    importance: boundedScore(Number.isFinite(importance) ? importance : 0),
    sensitive: Boolean(input.sensitive),
    lastConfirmedAt: timestampInput(input.lastConfirmedAt, "lastConfirmedAt"),
    expiresAt: timestampInput(input.expiresAt, "expiresAt"),
    // What replaced this fact and since when it stopped holding. Written by
    // `supersede`; carried through an ordinary upsert so that editing a
    // superseded record's text does not quietly put it back in force.
    supersededBy: input.supersededBy == null || input.supersededBy === "" ? null : assertRecordId(input.supersededBy),
    invalidSince: timestampInput(input.invalidSince, "invalidSince"),
    // When the fact began to hold, when that is known; null is unknown. Together
    // with `invalidSince` it is the fact's validity interval, which an inverted
    // pair would make empty — refused, as any other malformed field is.
    validFrom: validFrom(input.validFrom, input.invalidSince),
  };
}

/** The one form of an identifier a source link is recorded and compared in. A
 *  knowledge-base document is its `src_` id; a published work is its DOI,
 *  lower-cased with no resolver prefix; an evidence card is its `ec_` id and a
 *  frontier item its public id. Anything else names nothing we can find again, so
 *  it is no link at all. */
const SOURCE_ID_FORMAT = Object.freeze({
  knowledge_source: /^src_[a-f0-9]{32}$/,
  doi: /^10\.\d{4,9}\/\S{1,250}$/,
  // An evidence card (`ec_` and the hex of its identity) and a frontier item (its public id), flywheel F19.
  evidence_card: /^ec_[a-f0-9]{32}$/,
  frontier_item: /^[a-z0-9]{12,32}$/,
});

/**
 * One recorded dependency on a source, normalised, or null when it is not one.
 * The version is whatever the writer knew the source to be at (a digest, a
 * revision); null is unknown, and is kept as unknown.
 * @param {unknown} link @returns {{ type: string, id: string, version: string | null } | null}
 */
export function sourceLinkOf(link) {
  const type = String(/** @type {any} */ (link)?.type ?? "");
  if (!MEMORY_SOURCE_TYPES.includes(type)) return null;
  const raw = String(/** @type {any} */ (link)?.id ?? "").trim();
  const id = type === "doi" ? raw.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "") : raw;
  if (!SOURCE_ID_FORMAT[/** @type {keyof typeof SOURCE_ID_FORMAT} */ (type)].test(id)) return null;
  const version = /** @type {any} */ (link)?.version == null || /** @type {any} */ (link).version === ""
    ? null : String(/** @type {any} */ (link).version).trim();
  if (version != null && (version.length === 0 || version.length > 200)) return null;
  return { type, id, version };
}

/** @param {unknown} links @returns {{ type: string, id: string, version: string | null }[]} */
function validSourceLinks(links) {
  if (links == null) return [];
  if (!Array.isArray(links) || links.length > MEMORY_SOURCE_LINK_LIMIT) throw invalid("sourceLinks");
  /** @type {Map<string, { type: string, id: string, version: string | null }>} */
  const found = new Map();
  for (const link of links) {
    const normal = sourceLinkOf(link);
    if (!normal) throw invalid("sourceLinks");
    found.set(`${normal.type}\u0000${normal.id}`, normal);
  }
  return [...found.values()];
}

/** @param {any} row */
function sourceLinkRow(row) {
  return {
    type: String(row.source_type), id: String(row.source_id), version: row.source_version ?? null,
    state: String(row.state), stateReason: String(row.state_reason ?? ""),
    stateAt: memoryInstant(row.state_at), linkedAt: memoryInstant(row.linked_at),
  };
}

/** @param {unknown} value @param {unknown} until */
function validFrom(value, until) {
  const from = timestampInput(value, "validFrom");
  const end = timestampInput(until, "invalidSince");
  if (from && end && Date.parse(from) >= Date.parse(end)) throw invalid("validFrom");
  return from;
}

/** The lock one upsert takes: the canonical key of the record it will write. */
function canonicalKeyLock(userId, record) {
  return JSON.stringify([userId, record.scope, record.scopeId, record.kind, record.key]);
}

/** @param {any} row */
/** The switches an account has set, or every switch off when it has set none.
 *  @param {any} row */
function publicSettings(row) {
  return {
    learningPaused: row?.learning_paused === true,
    recallPaused: row?.recall_paused === true,
    pausedProjects: Array.isArray(row?.paused_projects) ? row.paused_projects.map(String) : [],
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** @param {unknown} value */
function pausedProjectList(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "memory_settings_invalid", "pausedProjects must be a list of project ids.");
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()))];
  if (ids.some((id) => !projectIdPattern.test(id))) {
    throw new HttpError(400, "memory_settings_invalid", "pausedProjects holds something that is not a project id.");
  }
  if (ids.length > MEMORY_PAUSED_PROJECT_LIMIT) {
    throw new HttpError(400, "memory_settings_invalid", `At most ${MEMORY_PAUSED_PROJECT_LIMIT} projects can be paused.`);
  }
  return ids;
}

/**
 * Whether memory may be written, and read, for one account in one project —
 * and, given a session, in one conversation.
 *
 * Read through a function rather than off the store directly because not every
 * store has the switches: a deployment without the control-plane database has
 * no memory to pause, and the doubles the extraction tests use predate them.
 * Both read as "nothing paused", which is the behaviour before the switches.
 *
 * A conversation trying someone else's capsule (`trial`) neither writes nor
 * recalls this researcher's memory: it reads the pack alone (build spec
 * §9.4-5 「该会话只读这个包」), so what it shows is the pack's effect and not
 * the pack mixed with the researcher's own. It read the researcher's memory
 * until 2026-09-29. 无痕 used to be the third thing read here; it was deleted on
 * 2026-09-20 with the bar that was its only control, and the account-level
 * recall pause is the remaining switch.
 *
 * @param {any} store @param {string} userId @param {string | null} projectId @param {string | null} [sessionId]
 * @returns {Promise<{ learning: boolean, recall: boolean, trial: boolean }>} true = paused
 */
export async function memoryPausedFor(store, userId, projectId, sessionId = null) {
  if (typeof store?.settings !== "function" || store.configured === false) {
    return { learning: false, recall: false, trial: false };
  }
  const settings = await store.settings(userId);
  const projectPaused = Boolean(projectId) && settings.pausedProjects.includes(String(projectId));
  // A conversation id this store cannot hold has no state. Any other failure
  // is the store's, and propagates.
  const session = sessionId && projectId && typeof store.sessionState === "function"
    ? await store.sessionState(userId, projectId, sessionId).catch((/** @type {any} */ error) => {
      if (error?.code === "memory_session_invalid") return { trialCapsuleId: null };
      throw error;
    })
    : { trialCapsuleId: null };
  // A conversation trying someone else's capsule (「试用一次」) writes nothing
  // into this researcher's memory and reads nothing out of it.
  const trial = Boolean(session.trialCapsuleId);
  return {
    learning: settings.learningPaused || projectPaused || trial,
    recall: settings.recallPaused || projectPaused || trial,
    trial,
  };
}

/** A session id as the kernel writes one. @param {unknown} value */
function assertSessionId(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new HttpError(400, "memory_session_invalid", "The session id is invalid.");
  return id;
}

/** @param {unknown} value */
function assertProjectId(value) {
  const id = String(value ?? "").trim();
  if (!projectIdPattern.test(id)) throw new HttpError(400, "memory_session_invalid", "The project id is invalid.");
  return id;
}

/** @param {any} row */
function publicSessionState(row) {
  return {
    trialCapsuleId: typeof row?.trial_capsule_id === "string" ? row.trial_capsule_id : null,
    updatedAt: row?.updated_at ? memoryInstant(row.updated_at) : null,
  };
}

/**
 * How a record came to be known and how established it is, counted from its
 * own evidence — what the memory page shows in place of a percentage.
 *
 * The page used to print 「置信度 85%」, a number the extractor typed, over
 * records that held exactly one piece of evidence (49 of 52 on the acceptance
 * account, 2026-09-19). What a reader can rely on is countable: who it came
 * from, how many times it was seen, in how many separate runs and
 * conversations. `basis` is the provenance label that stays with the record
 * for good (principle 18): an inference is `inferred` however often it is
 * observed, and becomes `confirmed` only by its owner's own act.
 *
 * @param {any} row @param {any[]} evidence @param {any[]} revisions
 */
/**
 * The conversations one record rests on, by the id a link can use.
 *
 * An evidence `sourceRef` is `sessions/<sessionId>/messages/<n>` (or
 * `.../tools/<n>`) — the extractor's own shape, so this reads the record
 * rather than a second index of where it came from.
 * @param {{ evidence?: readonly { sourceRef?: string }[] }} record @returns {string[]}
 */
export function sessionsOf(record) {
  const found = [];
  for (const item of record?.evidence ?? []) {
    const id = /^sessions\/([^/]+)\//.exec(String(item?.sourceRef ?? ""))?.[1];
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * What each conversation was about, in the researcher's own words: the
 * question its run summary stored.
 *
 * The page shows 「来自 9月12日《…》」 on every row, and this is where the 《…》
 * comes from. Derived from the records already in hand — a run summary is one
 * per conversation and carries the question as its summary — so naming the
 * conversation costs no ledger read and stays true if the ledger is rotated.
 * @param {readonly any[]} records @returns {Record<string, string>}
 */
export function conversationTitlesIn(records) {
  /** @type {Record<string, string>} */
  const titles = {};
  for (const record of records ?? []) {
    if (record?.kind !== "run_summary") continue;
    let sessionId = "";
    try { sessionId = String(JSON.parse(record.value)?.sessionId ?? ""); } catch { sessionId = ""; }
    if (!sessionId) continue;
    const title = String(record.summary ?? "").trim();
    if (title) titles[sessionId] = title;
  }
  return titles;
}

export function recordProvenance(row, evidence, revisions) {
  const refs = evidence.map((item) => String(item?.sourceRef ?? ""));
  // Our own audit vocabulary (the memory routes write this reason), not prose.
  const confirmed = revisions.some((item) => String(item?.reason ?? "").startsWith("user confirmed"));
  const basis = row.origin === "manual" ? "edited"
    : row.origin === "explicit" ? (confirmed ? "confirmed" : "stated")
      : row.origin === "inferred" ? "inferred"
        : refs.some((ref) => /\/tools\/\d+$/.test(ref)) ? "tool" : "assistant";
  return {
    basis,
    observations: evidence.length,
    // One stamp per run by construction (the extractor stamps an observation
    // with its run's terminal time), so distinct stamps are distinct runs.
    runs: new Set(evidence.map((item) => item?.observedAt).filter(Boolean)).size,
    conversations: new Set(refs.map((ref) => /^sessions\/([^/]+)\//.exec(ref)?.[1]).filter(Boolean)).size,
  };
}

/**
 * A record as the read-only views need it — the timeline, the change list,
 * a conversation's background — and no more: every column but the texts,
 * each text cut to its first thousand characters (the views show two hundred),
 * each observation to its source and time, each revision without its full
 * texts. A record may hold 100,000 characters of value, 64 observations and
 * 32 revisions of that size, and these views read up to hundreds of records
 * per request (security review 2026-09-20). `publicRecord` reads the result
 * as it reads a whole row.
 */
const LIGHT_RECORD_COLUMNS = `user_id, id, scope, scope_id, kind, key, left(value, 1000) AS value, left(summary, 1000) AS summary,
  origin, status, confidence, importance, sensitive, version, created_at, updated_at, last_confirmed_at, expires_at,
  superseded_by, invalid_since, valid_from,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceRef', item->'sourceRef', 'observedAt', item->'observedAt') ORDER BY position), '[]'::jsonb)
     FROM jsonb_array_elements(evidence) WITH ORDINALITY AS observed(item, position)) AS evidence,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('version', item->'version', 'status', item->'status', 'changedAt', item->'changedAt',
     'reason', item->'reason', 'by', item->'by', 'runId', item->'runId',
     'value', left(item->>'value', 1000), 'summary', left(item->>'summary', 1000)) ORDER BY position), '[]'::jsonb)
     FROM jsonb_array_elements(revisions) WITH ORDINALITY AS revised(item, position)) AS revisions`;

function publicRecord(row) {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  const revisions = Array.isArray(row.revisions) ? row.revisions : [];
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id ?? "",
    kind: row.kind,
    key: row.key,
    value: row.value,
    summary: row.summary ?? "",
    origin: row.origin,
    status: row.status,
    confidence: boundedScore(row.confidence),
    importance: boundedScore(row.importance),
    sensitive: Boolean(row.sensitive),
    evidenceCount: evidence.length,
    version: Math.max(1, Number(row.version) || 1),
    createdAt: memoryInstant(row.created_at),
    updatedAt: memoryInstant(row.updated_at),
    lastConfirmedAt: memoryInstant(row.last_confirmed_at),
    expiresAt: memoryInstant(row.expires_at),
    supersededBy: row.superseded_by ?? null,
    invalidSince: memoryInstant(row.invalid_since),
    validFrom: memoryInstant(row.valid_from),
    provenance: recordProvenance(row, evidence, revisions),
    evidence: evidence.map((item) => ({
      sourceType: String(item?.sourceType ?? ""),
      sourceRef: String(item?.sourceRef ?? ""),
      quote: String(item?.quote ?? ""),
      observedAt: item?.observedAt ?? null,
      weight: boundedScore(item?.weight),
      fingerprint: String(item?.fingerprint ?? ""),
    })),
    revisions: revisions.map((item) => ({
      version: Number(item?.version) || 0,
      value: String(item?.value ?? ""),
      summary: String(item?.summary ?? ""),
      status: MEMORY_STATUSES.includes(String(item?.status)) ? String(item?.status) : "archived",
      changedAt: item?.changedAt ?? null,
      reason: String(item?.reason ?? ""),
      // Who made the change and in which run: the provenance of a revision,
      // so the timeline can say 「因：你在任务里纠正」 and the undo knows what
      // it is undoing. Absent on revisions written before 2026-09-20.
      ...(REVISION_ACTORS.includes(String(item?.by)) ? { by: String(item.by) } : {}),
      ...(typeof item?.runId === "string" && item.runId ? { runId: item.runId } : {}),
    })),
  };
}

/**
 * What a database failure means to a caller.
 *
 * A connection that is down is 503 and nothing else: chat and autopilot read
 * this code to decide between degrading and refusing, and a memory store that
 * is merely unreachable must never look like a rejected payload. A constraint
 * the store's own validation should have caught first is the opposite case —
 * the payload really is invalid — and it says so rather than hiding behind an
 * outage code.
 * @param {any} error
 */
function memoryDatabaseError(error) {
  if (error instanceof HttpError) return error;
  const code = String(error?.code ?? "");
  if (code === "23505") return new HttpError(409, "memory_conflict", "That memory changed while this write was in flight.");
  if (code.startsWith("23")) return new HttpError(400, "memory_payload_invalid", "The research memory store refused this memory.");
  if (code === "57014" || code === "ETIMEDOUT" || error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new HttpError(503, "memory_timeout", "The research memory store did not answer in time.");
  }
  return new HttpError(503, "memory_unavailable", "The research memory store is unavailable.");
}

/** The wall clock, truncated to the second everything else is stored at, read
 *  once so a revision's `changedAt` and the row's `updatedAt` cannot disagree.
 *
 *  `clock_timestamp()`, never `now()`: `now()` is the transaction's start time,
 *  frozen before this transaction waited for the canonical key's lock. A write
 *  that queued behind another writer would stamp itself with the moment it
 *  began queueing, so `updated_at` — which orders both the list and recall —
 *  could move backwards relative to a write that started later and got the lock
 *  first. Measured drift on a 1.5 s wait here: 1.5 s.
 *  @param {any} client */
async function transactionInstant(client) {
  const result = await client.query("SELECT date_trunc('second', clock_timestamp()) AS now");
  return memoryInstant(result.rows[0]?.now);
}

/**
 * How much of its weight an inference still carries: 1 when just observed,
 * falling linearly to 0 at its expiry. Unknown times and no TTL keep it whole.
 * @param {string | null} updatedAt @param {number} now @param {number} ttlMs
 */
export function inferenceFreshness(updatedAt, now, ttlMs) {
  const at = Date.parse(String(updatedAt ?? ""));
  if (!ttlMs || !Number.isFinite(at)) return 1;
  return Math.max(0, Math.min(1, 1 - (now - at) / ttlMs));
}

const recordColumns = "user_id,id,scope,scope_id,kind,key,value,summary,origin,status,confidence,importance,"
  + "sensitive,evidence,revisions,version,created_at,updated_at,last_confirmed_at,expires_at,superseded_by,invalid_since,valid_from";

export class ResearchMemoryStore {

  /**
   * `jobs` is the derived index's outbox, and it is handed over only when
   * something will claim from it — the same rule the feedback ledger follows
   * for its distillation queue. A store given the queue on a deployment whose
   * recall provider is `builtin` would enqueue one job per memory for a worker
   * that is never composed.
   *
   * `withdrawals` is the other half of that outbox: what a deletion of a whole
   * project's or account's memory owes the index as subtrees, kept in the same
   * transaction as the rows (`MemoryIndexWithdrawals`). Handed over under the
   * same rule as `jobs`.
   *
   * @param {any} config @param {{ database?: any, jobs?: any, withdrawals?: any }} options
   */
  constructor(config, { database = null, jobs = null, withdrawals = null } = {}) {
    this.database = database ?? null;
    this.jobs = jobs ?? null;
    this.withdrawals = withdrawals ?? null;
    this.contextLimit = Math.max(0, Math.min(20, Number(config?.memoryContextLimit ?? 8)));
    this.contextMaxChars = Math.max(0, Math.min(100_000, Number(config?.memoryContextMaxChars ?? 20_000)));
    this.inferredTtlMs = Math.max(0, Number(config?.memoryInferredTtlDays ?? 90)) * 24 * 60 * 60 * 1_000;
  }

  /** The store exists exactly when the control-plane database does. There is no
   *  second implementation: a deployment without a database has no research
   *  memory, which is what a deployment without the retired service had. */
  get configured() {
    return Boolean(this.database);
  }

  #assertConfigured() {
    if (!this.database) {
      throw new HttpError(503, "memory_unconfigured", "The research memory store is not configured.");
    }
  }

  /** @param {string} text @param {any[]} values */
  async #query(text, values = []) {
    this.#assertConfigured();
    try {
      await migrateResearchMemory(this.database);
      return await this.database.query(text, values);
    } catch (error) {
      throw memoryDatabaseError(error);
    }
  }

  /** @param {(client: any) => Promise<any>} operation */
  async #transaction(operation) {
    this.#assertConfigured();
    try {
      await migrateResearchMemory(this.database);
      // The outbox row goes into `evimed_product.jobs` inside the same
      // transaction as the memory it describes, so that table has to exist
      // before the transaction opens; inside one there is no second connection
      // to run DDL on. Memoised per database, so this costs one lookup.
      if (this.jobs) await migrateProductStore(this.database);
      if (this.withdrawals) await this.withdrawals.migrate();
      return await this.database.transaction(operation);
    } catch (error) {
      throw memoryDatabaseError(error);
    }
  }

  /**
   * Take the account row first, when this write will also enqueue.
   *
   * The outbox row references `evimed_control.users`, so inserting it takes a
   * FOR KEY SHARE on that row — at the end of a transaction that already holds
   * the memory row. Account deletion locks the same user row FOR UPDATE and
   * then cascades into the memory rows, so without this the two acquire the
   * pair in opposite orders and PostgreSQL aborts one of them: either the
   * memory write answers 503, or the deletion fails after it has begun.
   * Reproduced as a real 40P01 before this line existed.
   *
   * @param {any} client @param {string} owner
   */
  async #lockOwnerForOutbox(client, owner) {
    if (!this.jobs) return;
    await client.query("SELECT 1 FROM evimed_control.users WHERE id=$1 FOR KEY SHARE", [owner]);
  }

  /**
   * Tell the derived index that one record changed, in the writer's own transaction.
   *
   * A transactional outbox rather than a call after the commit: a write that
   * succeeds and an index that never hears about it is exactly the state that
   * makes a recall answer from memory the researcher has already corrected.
   * Rolling the queue row back with the write is the other half — a job naming
   * a version that was never committed would write the wrong text.
   *
   * The job is the *event*, so its key is fresh every time rather than derived
   * from the record and its version. Those repeat: delete a memory and create
   * another under the same id and the pair is back at version 1, and a key that
   * collided there would silently drop the write that re-publishes it.
   *
   * @param {any} client @param {string} owner @param {{scope:string,scopeId:string,kind:string,id:string}} record
   */
  async #enqueueRecordIndex(client, owner, record) {
    if (!this.jobs) return;
    await this.jobs.enqueue(owner, "memory-record-index", {
      recordId: record.id, scope: record.scope, scopeId: record.scopeId, memoryKind: record.kind,
    }, { idempotencyKey: `memory-record-index:${randomUUID()}`, maxAttempts: 10, transactionClient: client });
  }

  /**
   * What removing these rows owes the rest of the store, inside the removing
   * transaction: one index job per row (bounded, see MEMORY_BULK_OUTBOX_LIMIT)
   * and their usage counters. Every delete path goes through here since
   * 2026-09-27 — `purgeRecords` and `deleteProjectMemory` used to run a bare
   * DELETE, leaving index copies to whichever caller remembered a subtree
   * forget and usage rows to nobody (84 orphans on production, audit M-7).
   * @param {any} client @param {string} owner @param {readonly { id: string, scope: string, scope_id: string, kind: string }[]} rows
   */
  async #forgetRows(client, owner, rows) {
    for (const row of rows.slice(0, MEMORY_BULK_OUTBOX_LIMIT)) {
      await this.#enqueueRecordIndex(client, owner, { id: row.id, scope: row.scope, scopeId: row.scope_id, kind: row.kind });
    }
    if (rows.length > 0) {
      await client.query("DELETE FROM evimed_memory.record_usage WHERE user_id=$1 AND record_id=ANY($2::text[])",
        [owner, rows.map((row) => row.id)]);
    }
  }

  async status() {
    if (!this.database) {
      return { configured: false, connected: false, code: "memory_unconfigured", structured: false };
    }
    try {
      await migrateResearchMemory(this.database);
      await this.database.query("SELECT 1 FROM evimed_memory.records LIMIT 1");
      return { configured: true, connected: true, code: null, structured: true };
    } catch (error) {
      const code = ["42P01", "3F000"].includes(String(error?.code ?? ""))
        ? "memory_schema_unavailable"
        : memoryDatabaseError(error).code;
      return { configured: true, connected: false, code, structured: false };
    }
  }

  // ---------------------------------------------------------------- records

  /** @param {string} userId @param {Record<string, any>} filters */
  async listRecords(userId, {
    scopes = [], kinds = [], statuses = [], scopeId = "", query = "", pageSize = 100,
  } = {}) {
    const rows = await this.#selectRecords(userId, { scopes, kinds, statuses, scopeId, query },
      Math.max(1, Math.min(100, Number(pageSize) || 100)));
    return rows.map(publicRecord);
  }

  /** Every match, in one statement. The retired client paged because the
   *  boundary paged; nothing here has to.
   *  @param {string} userId @param {Record<string, any>} filters */
  async listAllRecords(userId, filters = {}) {
    const rows = await this.#selectRecords(userId, filters, MEMORY_EXPORT_LIMIT + 1);
    if (rows.length > MEMORY_EXPORT_LIMIT) {
      throw new HttpError(413, "memory_export_too_large", "This account holds more memories than one export can carry.");
    }
    return rows.map(publicRecord);
  }

  /** @param {string} userId @param {Record<string, any>} filters @param {number} limit */
  async #selectRecords(userId, { scopes = [], kinds = [], statuses = [], scopeId = "", query = "" } = {}, limit) {
    const owner = assertUserId(userId);
    const scopeFilter = enumFilter(scopes, MEMORY_SCOPES, "scope");
    const kindFilter = enumFilter(kinds, MEMORY_KINDS, "kind");
    const statusFilter = enumFilter(statuses, MEMORY_STATUSES, "status");
    const scope = String(scopeId ?? "").trim();
    // Truncated, not refused: a search box is not a place to lose a request.
    const search = boundedText(query, MEMORY_QUERY_LIMIT);
    const result = await this.#query(`SELECT * FROM evimed_memory.records
      WHERE user_id=$1
        AND (cardinality($2::text[])=0 OR scope=ANY($2::text[]))
        AND (cardinality($3::text[])=0 OR kind=ANY($3::text[]))
        AND (cardinality($4::text[])=0 OR status=ANY($4::text[]))
        AND ($5::text='' OR scope_id=$5)
        AND ($6::text='' OR strpos(lower(key),lower($6))>0 OR strpos(lower(summary),lower($6))>0
             OR strpos(lower(value),lower($6))>0)
      ORDER BY importance DESC, confidence DESC, updated_at DESC, id DESC LIMIT $7`,
    [owner, scopeFilter, kindFilter, statusFilter, scope, search, limit]);
    return result.rows;
  }

  /** @param {string} userId @param {string} id */
  async getRecord(userId, id) {
    const result = await this.#query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=$2",
      [assertUserId(userId), assertRecordId(id)]);
    if (result.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
    return publicRecord(result.rows[0]);
  }

  /**
   * The memories a conversation was handed, as light records, in one read:
   * at most `limit` of the ids named, the rest left out. Ids that are not
   * record ids, or no longer records, are simply absent.
   * @param {string} userId @param {readonly unknown[]} ids @param {{ limit?: number }} [options]
   */
  async recordSummaries(userId, ids, { limit = 500 } = {}) {
    const owner = assertUserId(userId);
    const wanted = [...new Set(ids.map(String))].filter((id) => recordIdPattern.test(id)).slice(0, Math.max(1, Math.min(1000, Number(limit) || 500)));
    if (wanted.length === 0) return [];
    const result = await this.#query(`SELECT ${LIGHT_RECORD_COLUMNS} FROM evimed_memory.records WHERE user_id=$1 AND id=ANY($2::text[])`,
      [owner, wanted]);
    return result.rows.map(publicRecord);
  }

  /**
   * What the timeline derives its memory events from: the account's records
   * a project sees (its own and the account's), light, the most recently
   * changed `limit` of them. Run summaries are the run's own events, so they
   * do not spend the bound. The timeline used to read every record whole
   * through `profile` — up to 100,000 of them — on every page.
   * @param {string} userId @param {{ projectId?: string | null, limit?: number }} [options]
   */
  async timelineRecords(userId, { projectId = null, limit = 1000 } = {}) {
    const owner = assertUserId(userId);
    const bound = Math.max(1, Math.min(5000, Number(limit) || 1000));
    const result = await this.#query(`SELECT ${LIGHT_RECORD_COLUMNS} FROM evimed_memory.records
      WHERE user_id=$1 AND kind <> 'run_summary' AND (scope='user' OR (scope='project' AND scope_id=$2))
      ORDER BY updated_at DESC, id DESC LIMIT $3`, [owner, String(projectId ?? ""), bound]);
    return result.rows.map(publicRecord);
  }

  /**
   * How many memories began to hold, and how many stopped, on each calendar
   * day in a zone: what the capsule page's growth line is drawn from. The
   * memories are the ones the page lists (the account's and its projects',
   * never a run summary). One stops holding when it is forgotten — its last
   * change is the archiving — or replaced (`invalid_since`). Grouped in the
   * database, so an account of any size costs one row per day it changed,
   * never a read of every memory.
   * @param {string} userId @param {{ timeZone?: string }} [options]
   * @returns {Promise<Array<{ day: string, added: number, ended: number }>>}
   */
  async growthDays(userId, { timeZone = "UTC" } = {}) {
    const owner = assertUserId(userId);
    const result = await this.#query(`SELECT day, sum(added)::integer AS added, sum(ended)::integer AS ended FROM (
        SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS day, 1 AS added, 0 AS ended
          FROM evimed_memory.records WHERE user_id=$1 AND kind <> 'run_summary' AND scope IN ('user','project')
        UNION ALL
        SELECT to_char((CASE WHEN status='superseded' THEN coalesce(invalid_since, updated_at) ELSE updated_at END) AT TIME ZONE $2,
            'YYYY-MM-DD'), 0, 1
          FROM evimed_memory.records WHERE user_id=$1 AND kind <> 'run_summary' AND scope IN ('user','project')
            AND status IN ('archived','superseded')
      ) AS changes GROUP BY day ORDER BY day`, [owner, String(timeZone)]);
    return result.rows.map((/** @type {any} */ row) => ({ day: String(row.day), added: Number(row.added) || 0, ended: Number(row.ended) || 0 }));
  }

  /**
   * Create or atomically update the memory that owns a canonical key.
   *
   * The canonical key — owner, scope, scope id, kind, key — is the identity, not
   * the id: one fact about a researcher is one row however many times it is
   * observed. A provided id names the row to create; on an existing key it is
   * ignored, exactly as before, because the caller that sends it is sending back
   * what it last read.
   *
   * @param {string} userId @param {Record<string, any>} input
   * @param {Record<string, any>|null} evidence
   * @param {{ expectedVersion?: number, reason?: string, by?: string, runId?: string | null,
   *   sourceLinks?: readonly { type: string, id: string, version?: string | null }[] }} options
   *   `sourceLinks`: the sources this write rests on, by recorded identifier
   *   (`sourceLinkOf`); they are added to the record's links in the same
   *   transaction and never replace the ones it already has.
   */
  async upsertRecord(userId, input, evidence = null, { expectedVersion = 0, reason = "", by = "", runId = null, sourceLinks = [] } = {}) {
    const owner = assertUserId(userId);
    const next = validateRecordInput(input);
    const proof = boundedEvidence(evidence);
    const links = validSourceLinks(sourceLinks);
    // Truncated, never refused. This is audit text that rides along with a
    // write; a long contradiction notice must not cost the memory it explains.
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    const actor = revisionActor(by, runId);
    const expected = Math.max(0, Number(expectedVersion) || 0);
    const providedId = input?.id == null || input.id === "" ? null : assertRecordId(input.id);

    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      return this.#writeRecord(client, owner, next, proof, { expected, providedId, auditReason, actor, sourceLinks: links });
    });
  }

  /**
   * The upsert itself, inside a transaction the caller holds — so a write
   * that must land together with another (a fact and the one it supersedes)
   * shares one commit.
   * @param {any} client @param {string} owner @param {Record<string, any>} next
   * @param {Record<string, any>|null} proof
   * @param {{ expected: number, providedId: string|null, auditReason: string, actor?: Record<string, string>,
   *   sourceLinks?: { type: string, id: string, version: string | null }[] }} options
   */
  async #writeRecord(client, owner, next, proof, { expected, providedId, auditReason, actor = {}, sourceLinks = [] }) {
    // Two writers extracting from two runs of the same conversation reach
    // this line at the same instant. The lock is on the canonical key rather
    // than the table, so unrelated memories still write in parallel, and it
    // is what the retired service's process-wide mutex gave a single process
    // and could not give a web tier of several.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [canonicalKeyLock(owner, next)]);
    const found = await client.query(`SELECT * FROM evimed_memory.records
      WHERE user_id=$1 AND scope=$2 AND scope_id=$3 AND kind=$4 AND key=$5 FOR UPDATE`,
    [owner, next.scope, next.scopeId, next.kind, next.key]);
    // Read after both waits above, so the stamp is the moment of the write
    // and not the moment this writer joined the queue.
    const now = await transactionInstant(client);

    if (found.rowCount === 0) {
      const { evidence: created } = mergeEvidence([], proof);
      const inserted = await client.query(`INSERT INTO evimed_memory.records (${recordColumns})
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'[]'::jsonb,1,$15,$15,$16,$17,$18,$19,$20)
        ON CONFLICT DO NOTHING RETURNING *`,
      [owner, providedId ?? randomUUID(), next.scope, next.scopeId, next.kind, next.key, next.value, next.summary,
        next.origin, next.status, next.confidence, next.importance, next.sensitive, JSON.stringify(created),
        now, next.lastConfirmedAt, next.expiresAt, next.supersededBy ?? null, next.invalidSince ?? null, next.validFrom ?? null]);
      // The only way to get here is a provided id that already names another
      // of this user's memories: the canonical key was free a statement ago
      // and the lock is still held. Resurrecting the wrong row would be
      // worse than refusing the write.
      if (inserted.rowCount !== 1) {
        throw new HttpError(409, "memory_conflict", "That memory id already names another memory.");
      }
      const record = publicRecord(inserted.rows[0]);
      await this.#linkSources(client, owner, record.id, sourceLinks, now);
      await this.#enqueueRecordIndex(client, owner, record);
      return record;
    }

    const stored = publicRecord(found.rows[0]);
    if (expected > 0 && expected !== stored.version) {
      throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
    }
    // Before the no-change return below: a re-observation that adds nothing to
    // the text may still be the first to name the source it came from.
    await this.#linkSources(client, owner, stored.id, sourceLinks, now);
    const { evidence: merged, added } = mergeEvidence(stored.evidence, proof);
    const stateChanged = stored.value !== next.value || stored.summary !== next.summary || stored.status !== next.status;
    const revisions = stateChanged
      ? appendRevision(stored.revisions, {
        version: stored.version,
        value: stored.value,
        summary: stored.summary,
        status: stored.status,
        changedAt: now,
        reason: auditReason,
        ...actor,
        // The pointers a restore needs: undoing a change to a superseded
        // record must be able to put them back exactly.
        ...revisionPointers(stored),
      })
      : stored.revisions;
    if (!added && !stateChanged && currentStateEqual(stored, next)) return stored;

    const updated = await client.query(`UPDATE evimed_memory.records SET value=$3,summary=$4,origin=$5,status=$6,
      confidence=$7,importance=$8,sensitive=$9,evidence=$10::jsonb,revisions=$11::jsonb,version=version+1,
      updated_at=$12,last_confirmed_at=$13,expires_at=$14,superseded_by=$16,invalid_since=$17,valid_from=$18
      WHERE user_id=$1 AND id=$2 AND version=$15 RETURNING *`,
    [owner, stored.id, next.value, next.summary, next.origin, next.status, next.confidence, next.importance,
      next.sensitive, JSON.stringify(merged), JSON.stringify(revisions), now, next.lastConfirmedAt,
      next.expiresAt, stored.version, next.supersededBy ?? null, next.invalidSince ?? null, next.validFrom ?? null]);
    if (updated.rowCount !== 1) {
      throw new HttpError(409, "memory_conflict", "This memory changed while it was being written.");
    }
    const record = publicRecord(updated.rows[0]);
    await this.#enqueueRecordIndex(client, owner, record);
    return record;
  }

  /**
   * Write a fact that replaces another, and retire the one it replaces.
   *
   * One transaction, so no reader ever sees both in force or neither. The old
   * record is not deleted and not edited: it keeps its value and evidence,
   * becomes `superseded`, points at what replaced it and says from when it
   * stopped holding — the 「曾经如此」 the timeline shows. Recall reads only
   * `active` rows, so the replaced fact leaves every prompt at once.
   *
   * @param {string} userId @param {string} previousId @param {Record<string, any>} input
   * @param {Record<string, any>|null} evidence
   * @param {{ reason?: string, by?: string, runId?: string | null,
   *   sourceLinks?: readonly { type: string, id: string, version?: string | null }[] }} options
   * @returns {Promise<{ record: any, superseded: any }>}
   */
  async supersede(userId, previousId, input, evidence = null, { reason = "", by = "", runId = null, sourceLinks = [] } = {}) {
    const owner = assertUserId(userId);
    const next = validateRecordInput(input);
    const proof = boundedEvidence(evidence);
    const links = validSourceLinks(sourceLinks);
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    const actor = revisionActor(by, runId);
    const replacedId = assertRecordId(previousId);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const found = await client.query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [owner, replacedId]);
      if (found.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const replaced = publicRecord(found.rows[0]);
      if (canonicalKeyLock(owner, replaced) === canonicalKeyLock(owner, next)) {
        // The same fact under the same key is an update, and its old value is
        // already kept as a revision; calling it a supersession would retire
        // the record it is about to write.
        throw new HttpError(400, "memory_supersede_invalid", "A memory cannot supersede itself.");
      }
      const record = await this.#writeRecord(client, owner, next, proof, { expected: 0, providedId: null, auditReason, actor, sourceLinks: links });
      const superseded = await this.#retire(client, owner, replaced, record, { auditReason, actor });
      return { record, superseded };
    });
  }

  /**
   * Retire a fact in favour of the record that replaces it, inside the caller's
   * transaction: it stops holding from now, points at its replacement, keeps its
   * value and evidence and its links, and every disagreement it was a side of is
   * settled by the replacement (the statement that lost is no longer in force).
   * @param {any} client @param {string} owner @param {any} replaced @param {any} replacement
   * @param {{ auditReason: string, actor: Record<string, string> }} options
   */
  async #retire(client, owner, replaced, replacement, { auditReason, actor }) {
    const now = await transactionInstant(client);
    const retired = await client.query(`UPDATE evimed_memory.records SET status='superseded',superseded_by=$3,
      invalid_since=COALESCE(invalid_since,$4),revisions=$5::jsonb,version=version+1,updated_at=$4
      WHERE user_id=$1 AND id=$2 RETURNING *`,
    [owner, replaced.id, replacement.id, now, JSON.stringify(appendRevision(replaced.revisions, {
      version: replaced.version, value: replaced.value, summary: replaced.summary, status: replaced.status,
      changedAt: now, reason: boundedText(`superseded by ${replacement.key}${auditReason ? `: ${auditReason}` : ""}`, MEMORY_REASON_LIMIT),
      ...actor,
    }))]);
    await client.query(`UPDATE evimed_memory.record_conflicts SET state='resolved',resolved_at=$3,resolution=$4,resolved_by=$5
      WHERE user_id=$1 AND state='open' AND (record_id=$2 OR other_id=$2)`,
    [owner, replaced.id, now, boundedText(`${replaced.key} was replaced by ${replacement.key}`, MEMORY_REASON_LIMIT), replacement.id]);
    const superseded = publicRecord(retired.rows[0]);
    await this.#enqueueRecordIndex(client, owner, superseded);
    return superseded;
  }

  /**
   * Put back the disagreements a replacement had settled, when the replacement
   * is undone: the statement it retired is in force again, and so is what it
   * disagreed with. A disagreement is reopened, never invented — only rows that
   * were settled by that replacement.
   * @param {any} client @param {string} owner @param {string} resolvedBy @param {string | null} [recordId]
   */
  async #reopenConflicts(client, owner, resolvedBy, recordId = null) {
    await client.query(`UPDATE evimed_memory.record_conflicts SET state='open',resolved_at=NULL,resolution='',resolved_by=NULL
      WHERE user_id=$1 AND state='resolved' AND resolved_by=$2 AND ($3::text IS NULL OR record_id=$3 OR other_id=$3)`,
    [owner, resolvedBy, recordId]);
  }

  /**
   * Record the sources a memory rests on. Additive: a link already there keeps
   * its state, except that naming it again against a different version resets
   * it to `current` — the memory was just read from that version. At most
   * `MEMORY_SOURCE_LINK_LIMIT` per record; a link past it is not recorded, and
   * the memory is unaffected.
   * @param {any} client @param {string} owner @param {string} recordId
   * @param {readonly { type: string, id: string, version: string | null }[]} links @param {string} now
   */
  async #linkSources(client, owner, recordId, links, now) {
    if (links.length === 0) return;
    const held = await client.query(
      "SELECT source_type, source_id FROM evimed_memory.record_sources WHERE user_id=$1 AND record_id=$2", [owner, recordId]);
    const have = new Set(held.rows.map((/** @type {any} */ row) => `${row.source_type}\u0000${row.source_id}`));
    let room = MEMORY_SOURCE_LINK_LIMIT - have.size;
    const wanted = links.filter((link) => {
      if (have.has(`${link.type}\u0000${link.id}`)) return true;
      room -= 1;
      return room >= 0;
    });
    if (wanted.length === 0) return;
    await client.query(`INSERT INTO evimed_memory.record_sources AS s
        (user_id, record_id, source_type, source_id, source_version, linked_at)
      SELECT $1, $2, given.type, given.id, given.version, $6
        FROM unnest($3::text[], $4::text[], $5::text[]) AS given(type, id, version)
      ON CONFLICT (user_id, record_id, source_type, source_id) DO UPDATE
        SET source_version=EXCLUDED.source_version, state='current', state_reason='', state_at=NULL
        WHERE EXCLUDED.source_version IS NOT NULL AND s.source_version IS DISTINCT FROM EXCLUDED.source_version`,
    [owner, recordId, wanted.map((link) => link.type), wanted.map((link) => link.id), wanted.map((link) => link.version), now]);
  }

  /**
   * Undo the last change to one record — the one click the write prompt and
   * the timeline offer. Owner ruling 2026-09-19: memory changes by itself and
   * asks nobody first, so every change has to be reversible in one step.
   *
   * A record with history goes back to the state its last revision kept —
   * value, summary, status and, for one that had been superseded, its
   * pointers — and the state it leaves is kept as a revision in turn, so an
   * undo is as reversible as what it undid. A record with no history was
   * created by the change being undone, so undoing it removes the record, and
   * a fact it had replaced goes back into force: the state before the change
   * is exactly that.
   *
   * @param {string} userId @param {string} id @param {{ expectedVersion?: number }} options
   * @returns {Promise<{ undone: "restored" | "removed", record: any | null, previous: any, restored: any[] }>}
   */
  async undo(userId, id, { expectedVersion = 0 } = {}) {
    const owner = assertUserId(userId);
    const recordId = assertRecordId(id);
    const expected = Math.max(0, Number(expectedVersion) || 0);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const found = await client.query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [owner, recordId]);
      if (found.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const current = publicRecord(found.rows[0]);
      if (expected > 0 && expected !== current.version) {
        throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
      }
      const now = await transactionInstant(client);
      const actor = revisionActor("user", null);
      if (current.revisions.length === 0) {
        const replaced = await client.query(`SELECT * FROM evimed_memory.records
          WHERE user_id=$1 AND superseded_by=$2 FOR UPDATE`, [owner, current.id]);
        await client.query("DELETE FROM evimed_memory.records WHERE user_id=$1 AND id=$2", [owner, current.id]);
        await this.#forgetRows(client, owner, [{ id: current.id, scope: current.scope, scope_id: current.scopeId, kind: current.kind }]);
        const restored = [];
        for (const row of replaced.rows) {
          const earlier = publicRecord(row);
          const before = earlier.revisions.at(-1);
          const back = await client.query(`UPDATE evimed_memory.records SET status=$3,superseded_by=NULL,invalid_since=NULL,
            revisions=$4::jsonb,version=version+1,updated_at=$5 WHERE user_id=$1 AND id=$2 RETURNING *`,
          [owner, earlier.id, before?.status && before.status !== "superseded" ? before.status : "active",
            JSON.stringify(appendRevision(earlier.revisions, {
              version: earlier.version, value: earlier.value, summary: earlier.summary, status: earlier.status,
              changedAt: now, reason: `back in force: ${current.key}, which had replaced it, was undone`,
              ...revisionActor("system", null),
              ...revisionPointers(earlier),
            })), now]);
          const record = publicRecord(back.rows[0]);
          await this.#enqueueRecordIndex(client, owner, record);
          restored.push(record);
        }
        // What the removed record's replacing had settled is open again.
        await this.#reopenConflicts(client, owner, current.id);
        return { undone: "removed", record: null, previous: current, restored };
      }
      const before = /** @type {any} */ (current.revisions.at(-1));
      const raw = Array.isArray(found.rows[0].revisions) ? found.rows[0].revisions.at(-1) : null;
      // The interval goes back with the text only when the revision recorded it:
      // one written before the interval existed says nothing about it.
      const restoresStart = Boolean(raw) && Object.hasOwn(raw, "validFrom");
      const updated = await client.query(`UPDATE evimed_memory.records SET value=$3,summary=$4,status=$5,
        superseded_by=$6,invalid_since=$7,revisions=$8::jsonb,version=version+1,updated_at=$9,
        valid_from=CASE WHEN $10::boolean THEN $11::timestamptz ELSE valid_from END
        WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, current.id, before.value || current.value, before.summary, before.status,
        typeof raw?.supersededBy === "string" ? raw.supersededBy : null,
        typeof raw?.invalidSince === "string" ? memoryInstant(raw.invalidSince) : null,
        JSON.stringify(appendRevision(current.revisions, {
          version: current.version, value: current.value, summary: current.summary, status: current.status,
          changedAt: now, reason: boundedText(`undone: ${before.reason || "the last change"}`, MEMORY_REASON_LIMIT),
          ...actor,
          ...revisionPointers(current),
        })), now, restoresStart, restoresStart ? memoryInstant(raw.validFrom) : null]);
      const record = publicRecord(updated.rows[0]);
      if (current.status === "superseded" && current.supersededBy && record.status !== "superseded") {
        await this.#reopenConflicts(client, owner, current.supersededBy, record.id);
      }
      await this.#enqueueRecordIndex(client, owner, record);
      return { undone: "restored", record, previous: current, restored: [] };
    });
  }

  /**
   * What changed by itself since a moment — the write prompt 「刚记住了…」, on
   * the capsule page after a visit and in the conversation it came from.
   *
   * "By itself" is decided by the record's own history: created by the
   * extractor (anything but a hand-written record), or last changed by it.
   * A fact that was replaced is not listed on its own; its replacement is,
   * naming it. A run summary is the timeline's, never a prompt.
   *
   * @param {string} userId
   * @param {{ since: string, sessionId?: string | null, limit?: number }} options
   */
  async recentChanges(userId, { since, sessionId = null, limit = 20 }) {
    const owner = assertUserId(userId);
    const from = memoryInstant(since);
    if (!from) throw new HttpError(400, "memory_payload_invalid", "since is invalid.");
    const session = sessionId == null || sessionId === "" ? null : String(sessionId);
    if (session && !/^[A-Za-z0-9_-]{1,160}$/.test(session)) throw new HttpError(400, "memory_payload_invalid", "sessionId is invalid.");
    const result = await this.#query(`SELECT ${LIGHT_RECORD_COLUMNS} FROM evimed_memory.records
      WHERE user_id=$1 AND updated_at >= $2 AND kind <> 'run_summary'
      ORDER BY updated_at DESC, id DESC LIMIT 200`, [owner, from]);
    const rows = result.rows.map(publicRecord);
    const replacedBy = new Map();
    for (const record of rows) {
      if (record.status === "superseded" && record.supersededBy) replacedBy.set(record.supersededBy, record);
    }
    const automatic = (/** @type {any} */ record) => {
      const last = record.revisions.at(-1);
      if (!last) return record.origin !== "manual";
      return last.by ? last.by === "extraction" : !String(last.reason).startsWith("user ");
    };
    return rows
      .filter((record) => record.status !== "superseded")
      .filter(automatic)
      .filter((record) => !session || record.evidence.some((item) => item.sourceRef.startsWith(`sessions/${session}/`)))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
      .map((record) => {
        const replaced = replacedBy.get(record.id);
        return {
          id: record.id, key: record.key, kind: record.kind, scope: record.scope, scopeId: record.scopeId,
          summary: boundedText(record.summary || record.value, 200), status: record.status,
          change: record.revisions.length === 0 ? "created" : "updated",
          changedAt: record.updatedAt, version: record.version, provenance: record.provenance,
          ...(replaced ? { replaced: { id: replaced.id, summary: boundedText(replaced.summary || replaced.value, 200) } } : {}),
        };
      });
  }

  /**
   * Say who a record's words came from, correcting what extraction wrote.
   *
   * Written for one incident class (2026-09-26 audit, M-2): a GEO step's
   * dispatch brief reached the user slot untagged and its product line was
   * stored as the researcher's own words (`explicit`). Whose words a record
   * holds is its provenance (principle 18), so the correction is a revision
   * like any other change — by the platform, with the reason — and the value,
   * the summary and the evidence are left exactly as they were. The operator
   * script `scripts/ops/correct-memory-origin.mjs` is its caller.
   *
   * @param {string} userId @param {string} id
   * @param {{ origin: string, reason: string, expectedVersion?: number }} change
   */
  async correctOrigin(userId, id, { origin, reason, expectedVersion = 0 }) {
    const owner = assertUserId(userId);
    const recordId = assertRecordId(id);
    const next = enumValue(origin, MEMORY_ORIGINS, "origin");
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    if (!auditReason) throw invalid("reason");
    const expected = Math.max(0, Number(expectedVersion) || 0);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const found = await client.query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=$2 FOR UPDATE", [owner, recordId]);
      if (found.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const current = publicRecord(found.rows[0]);
      if (expected > 0 && expected !== current.version) throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
      if (current.origin === next) return { record: current, changed: false };
      const now = await transactionInstant(client);
      // Only the user's own word sets a confirmation time; a record that turns
      // out not to be their word never had one.
      const confirmedAt = next === "explicit" || next === "manual" ? current.lastConfirmedAt : null;
      const updated = await client.query(`UPDATE evimed_memory.records SET origin=$3,confidence=$4,last_confirmed_at=$5,
        revisions=$6::jsonb,version=version+1,updated_at=$7 WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, recordId, next, ORIGIN_CONFIDENCE[/** @type {keyof typeof ORIGIN_CONFIDENCE} */ (next)] ?? current.confidence, confirmedAt,
        JSON.stringify(appendRevision(current.revisions, {
          version: current.version, value: current.value, summary: current.summary, status: current.status,
          changedAt: now, reason: boundedText(`origin ${current.origin} -> ${next}: ${auditReason}`, MEMORY_REASON_LIMIT),
          ...revisionActor("system", null),
          ...revisionPointers(current),
        })), now]);
      const record = publicRecord(updated.rows[0]);
      await this.#enqueueRecordIndex(client, owner, record);
      return { record, changed: true };
    });
  }

  /** @param {string} userId @param {string} id */
  async deleteRecord(userId, id) {
    const owner = assertUserId(userId);
    const recordId = assertRecordId(id);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const result = await client.query(`DELETE FROM evimed_memory.records
        WHERE user_id=$1 AND id=$2 RETURNING id,scope,scope_id,kind`, [owner, recordId]);
      if (result.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      // Enqueued from the delete's own transaction: a forget that commits must
      // not be able to leave the derived copy behind, and a forget that rolls
      // back must not remove a copy of a memory that still exists. The usage
      // counter has no foreign key — a recall must never be able to fail on a
      // row being deleted underneath it — so it is cleared here too.
      await this.#forgetRows(client, owner, result.rows);
      return true;
    });
  }

  /** Every record of one account, with what their removal owes the index
   *  and the usage counters (`#forgetRows`). @param {string} userId */
  async purgeRecords(userId) {
    const owner = assertUserId(userId);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const result = await client.query("DELETE FROM evimed_memory.records WHERE user_id=$1 RETURNING id,scope,scope_id,kind", [owner]);
      await this.#forgetRows(client, owner, result.rows);
      await this.withdrawals?.enqueue(client, owner, researchMemoryRoots(owner));
      return Number(result.rowCount ?? 0);
    });
  }

  // -------------------------------------------------------------- relations

  /**
   * Record that two memories disagree, without deciding which is right.
   *
   * A relation, not a resolution: both stay in force and recall labels each with
   * the other until one replaces it (`supersede`, `resolveConflict`) or one is
   * forgotten. Whether two statements disagree is a language judgement — the
   * extraction model's, or the researcher's — and this is where it is kept; what
   * the store checks is the closed half: both memories are this account's, both
   * are live (a replaced or archived memory is not one side of anything), and
   * they are two memories. Idempotent, and a pair settled earlier stays settled.
   *
   * @param {string} userId @param {string} firstId @param {string} secondId
   * @param {{ reason?: string }} [options]
   * @returns {Promise<{ recordId: string, otherId: string, state: string, created: boolean }>}
   */
  async markConflict(userId, firstId, secondId, { reason = "" } = {}) {
    const owner = assertUserId(userId);
    const a = assertRecordId(firstId);
    const b = assertRecordId(secondId);
    if (a === b) throw new HttpError(400, "memory_conflict_invalid", "A memory cannot conflict with itself.");
    const [low, high] = a < b ? [a, b] : [b, a];
    const note = boundedText(reason, MEMORY_REASON_LIMIT);
    return this.#transaction(async (client) => {
      // In id order, so two writers marking the same pair take the rows in one order.
      const found = await client.query(`SELECT id, status FROM evimed_memory.records
        WHERE user_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`, [owner, [low, high]]);
      if (found.rowCount !== 2) throw new HttpError(404, "memory_not_found", "Memory not found.");
      if (found.rows.some((/** @type {any} */ row) => !["active", "pending"].includes(row.status))) {
        throw new HttpError(409, "memory_conflict_invalid", "A replaced or archived memory is not in conflict with anything.");
      }
      const inserted = await client.query(`INSERT INTO evimed_memory.record_conflicts (user_id, record_id, other_id, reason)
        VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, record_id, other_id) DO NOTHING RETURNING state`, [owner, low, high, note]);
      if (inserted.rowCount === 1) return { recordId: low, otherId: high, state: "open", created: true };
      const existing = await client.query(
        "SELECT state FROM evimed_memory.record_conflicts WHERE user_id=$1 AND record_id=$2 AND other_id=$3", [owner, low, high]);
      return { recordId: low, otherId: high, state: String(existing.rows[0]?.state ?? "open"), created: false };
    });
  }

  /**
   * Settle a disagreement in favour of one statement: the other is replaced by
   * it — kept, with its value, evidence and links, but no longer in force — and
   * the conflict is resolved. The act of the researcher, or of a platform step
   * acting on their word; the old statement stays as history and is never
   * deleted.
   *
   * When the researcher is the one who settles it (`by: "user"`), the statement
   * they chose is theirs from then on: it is stamped confirmed, and an
   * inference they chose becomes their own word (`explicit`, as confirming a
   * pending memory on the page does), with a revision saying who decided. The
   * decision is the researcher's and is recorded as theirs — the statement was
   * not made true by a model's say-so (principle 18).
   *
   * @param {string} userId @param {string} keepId @param {string} otherId
   * @param {{ reason?: string, by?: string, runId?: string | null }} [options]
   * @returns {Promise<{ kept: any, superseded: any }>}
   */
  async resolveConflict(userId, keepId, otherId, { reason = "", by = "user", runId = null } = {}) {
    const owner = assertUserId(userId);
    const keep = assertRecordId(keepId);
    const loser = assertRecordId(otherId);
    if (keep === loser) throw new HttpError(400, "memory_conflict_invalid", "A memory cannot conflict with itself.");
    // An inference does not settle which of two statements is right: the
    // researcher does, or a platform step acting on their word (principle 18).
    if (by === "extraction") throw new HttpError(400, "memory_conflict_invalid", "A disagreement is settled by the researcher, not by an extraction.");
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    const actor = revisionActor(by, runId);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const rows = await client.query(`SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id=ANY($2::text[])
        ORDER BY id FOR UPDATE`, [owner, [keep, loser]]);
      if (rows.rowCount !== 2) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const kept = publicRecord(rows.rows.find((/** @type {any} */ row) => row.id === keep));
      const replaced = publicRecord(rows.rows.find((/** @type {any} */ row) => row.id === loser));
      const [low, high] = keep < loser ? [keep, loser] : [loser, keep];
      const pair = await client.query(`SELECT state FROM evimed_memory.record_conflicts
        WHERE user_id=$1 AND record_id=$2 AND other_id=$3 AND state='open'`, [owner, low, high]);
      if (pair.rowCount !== 1) throw new HttpError(404, "memory_conflict_not_found", "These memories are not in open conflict.");
      if (kept.status !== "active" || replaced.status !== "active") {
        throw new HttpError(409, "memory_conflict_invalid", "Only memories in force can be settled against each other.");
      }
      const superseded = await this.#retire(client, owner, replaced, kept, {
        auditReason: auditReason || "the researcher settled a disagreement in favour of it", actor,
      });
      return { kept: by === "user" ? await this.#confirmChosen(client, owner, kept, replaced, auditReason) : kept, superseded };
    });
  }

  /**
   * The statement a researcher chose when settling a disagreement, as theirs: a
   * confirmation time, a revision that says so (`recordProvenance` reads a
   * reason that begins "user confirmed" as the `confirmed` basis), and — for an
   * inference — the origin and weight of their own word.
   * @param {any} client @param {string} owner @param {any} kept @param {any} replaced @param {string} auditReason
   */
  async #confirmChosen(client, owner, kept, replaced, auditReason) {
    const now = await transactionInstant(client);
    const own = kept.origin === "inferred";
    const updated = await client.query(`UPDATE evimed_memory.records SET origin=$3,confidence=$4,last_confirmed_at=$5,
      revisions=$6::jsonb,version=version+1,updated_at=$5 WHERE user_id=$1 AND id=$2 RETURNING *`,
    [owner, kept.id, own ? "explicit" : kept.origin, own ? 1 : kept.confidence, now,
      JSON.stringify(appendRevision(kept.revisions, {
        version: kept.version, value: kept.value, summary: kept.summary, status: kept.status,
        changedAt: now,
        reason: boundedText(`user confirmed it over ${replaced.key}${auditReason ? `: ${auditReason}` : ""}`, MEMORY_REASON_LIMIT),
        ...revisionActor("user", null),
        ...revisionPointers(kept),
      }))]);
    const confirmed = publicRecord(updated.rows[0]);
    await this.#enqueueRecordIndex(client, owner, confirmed);
    return confirmed;
  }

  /**
   * What the memory page labels records with, in as few reads as the relations
   * need: for each live record, the interval it holds over, the open
   * disagreements it is a side of and the sources it rests on that are no
   * longer as they were (`recordLabels`). A record with nothing to say is not
   * in the map, and a store that cannot read the relations throws rather than
   * answering as if there were none.
   *
   * @param {string} userId @param {readonly { id: string, status: string }[]} records
   * @returns {Promise<Map<string, ReturnType<typeof recordLabels>>>}
   */
  async labelRecords(userId, records) {
    const owner = assertUserId(userId);
    const isLive = (/** @type {{ status: string }} */ record) => record.status === "active" || record.status === "pending";
    /** @type {Map<string, ReturnType<typeof recordLabels>>} */
    const labels = new Map();
    const now = Date.now();
    /** @param {any} record @param {any} [links] */
    const label = (record, links = {}) => {
      const found = recordLabels(record, links, { now });
      if (found.caveats.length || found.validity.from || found.validity.until) labels.set(record.id, found);
    };
    // A replaced or forgotten record keeps only its interval, which is what
    // the page says about it (「3月2日～9月1日」); no relation is read for it.
    for (const record of records) if (!isLive(record)) label(record);
    const live = records.filter(isLive);
    // `recallLinks` reads at most 500 ids at once.
    for (let from = 0; from < live.length; from += 500) {
      const chunk = live.slice(from, from + 500);
      const links = await this.recallLinks(owner, chunk.map((record) => record.id));
      for (const record of chunk) label(record, links);
    }
    return labels;
  }

  /**
   * What recall needs to label a set of memories, in one read: the open
   * disagreements each is a side of (with the other statement, light) and the
   * sources it rests on that are no longer as they were. A source whose state is
   * `current` or `unknown` is not listed — neither is a finding.
   *
   * @param {string} userId @param {readonly unknown[]} recordIds
   * @returns {Promise<{ conflicts: Map<string, any[]>, sources: Map<string, any[]> }>}
   */
  async recallLinks(userId, recordIds) {
    const owner = assertUserId(userId);
    const ids = [...new Set((recordIds ?? []).map(String))].filter((id) => recordIdPattern.test(id)).slice(0, 500);
    /** @type {{ conflicts: Map<string, any[]>, sources: Map<string, any[]> }} */
    const links = { conflicts: new Map(), sources: new Map() };
    if (ids.length === 0) return links;
    const [conflicts, sources] = await Promise.all([
      this.#query(`SELECT t.self_id, c.state, c.created_at, o.id, o.scope, o.scope_id, o.kind, o.key, o.status, o.origin,
          o.sensitive, o.expires_at, o.created_at AS other_created_at, o.valid_from, o.invalid_since, o.superseded_by,
          left(o.summary, 300) AS summary, left(o.value, 300) AS value
        FROM evimed_memory.record_conflicts c
        CROSS JOIN LATERAL (VALUES (c.record_id, c.other_id), (c.other_id, c.record_id)) AS t(self_id, peer_id)
        JOIN evimed_memory.records o ON o.user_id=c.user_id AND o.id=t.peer_id
        WHERE c.user_id=$1 AND c.state='open' AND t.self_id=ANY($2::text[])`, [owner, ids]),
      this.#query(`SELECT record_id, source_type, source_id, source_version, state FROM evimed_memory.record_sources
        WHERE user_id=$1 AND record_id=ANY($2::text[]) AND state IN ('changed','retracted','expired')
        ORDER BY record_id, source_type, source_id`, [owner, ids]),
    ]);
    for (const row of conflicts.rows) {
      const list = links.conflicts.get(row.self_id) ?? [];
      list.push({
        otherId: row.id, state: row.state, createdAt: memoryInstant(row.created_at),
        other: {
          id: row.id, scope: row.scope, scopeId: row.scope_id, kind: row.kind, key: row.key, status: row.status,
          origin: row.origin, sensitive: Boolean(row.sensitive), summary: row.summary, value: row.value,
          expiresAt: memoryInstant(row.expires_at), createdAt: memoryInstant(row.other_created_at),
          validFrom: memoryInstant(row.valid_from), invalidSince: memoryInstant(row.invalid_since),
          supersededBy: row.superseded_by ?? null,
        },
      });
      links.conflicts.set(row.self_id, list);
    }
    for (const row of sources.rows) {
      const list = links.sources.get(row.record_id) ?? [];
      list.push({ type: row.source_type, id: row.source_id, state: row.state, version: row.source_version ?? null });
      links.sources.set(row.record_id, list);
    }
    return links;
  }

  /**
   * Every source a record rests on, with what is known of each. A record's
   * history keeps its links: a replaced fact still says what it was read from.
   * @param {string} userId @param {string} recordId
   * @returns {Promise<{ type: string, id: string, version: string | null, state: string, stateReason: string,
   *   stateAt: string | null, linkedAt: string | null }[]>}
   */
  async sourceLinks(userId, recordId) {
    const result = await this.#query(`SELECT source_type, source_id, source_version, state, state_reason, state_at, linked_at
      FROM evimed_memory.record_sources WHERE user_id=$1 AND record_id=$2 ORDER BY source_type, source_id`,
    [assertUserId(userId), assertRecordId(recordId)]);
    return result.rows.map(sourceLinkRow);
  }

  /**
   * The memories that rest on one source, found by the recorded identifier and
   * nothing else — never by what a memory says. What a knowledge change walks
   * to find the memories it may affect. Every status is returned (a replaced
   * memory is history that still names its source), tagged, so the caller
   * decides what an old version is owed; one account's, always.
   *
   * @param {string} userId @param {{ type: string, id: string }} source @param {{ limit?: number }} [options]
   */
  async dependentsOfSource(userId, source, { limit = 500 } = {}) {
    const link = sourceLinkOf({ type: source?.type, id: source?.id });
    if (!link) throw invalid("source");
    const result = await this.#query(`SELECT r.id, r.scope, r.scope_id, r.kind, r.key, r.status, r.version,
        s.source_type, s.source_id, s.source_version, s.state, s.state_reason, s.state_at, s.linked_at
      FROM evimed_memory.record_sources s JOIN evimed_memory.records r ON r.user_id=s.user_id AND r.id=s.record_id
      WHERE s.user_id=$1 AND s.source_type=$2 AND s.source_id=$3 ORDER BY r.id LIMIT $4`,
    [assertUserId(userId), link.type, link.id, Math.max(1, Math.min(2000, Number(limit) || 500))]);
    return result.rows.map((/** @type {any} */ row) => {
      const recorded = sourceLinkRow(row);
      return {
        recordId: row.id, scope: row.scope, scopeId: row.scope_id, kind: row.kind, key: row.key, status: row.status,
        recordVersion: Number(row.version) || 1,
        sourceVersion: recorded.version, state: recorded.state, stateReason: recorded.stateReason,
        stateAt: recorded.stateAt, linkedAt: recorded.linkedAt,
      };
    });
  }

  /**
   * The evidence cards and frontier items memories name, one row per link, with the state each holds — what
   * `KnowledgeChangeService.sweepEvidenceLinks` looks the current state up for (flywheel F19). Links not yet moved first, so a
   * bounded pass reaches the ones nobody has looked at before it revisits the ones it has.
   * @param {{ userId?: string | null, limit?: number }} [options]
   * @returns {Promise<{ userId: string, type: string, id: string, state: string }[]>}
   */
  async linkedEvidenceSources({ userId = null, limit = 500 } = {}) {
    const result = await this.#query(`SELECT user_id, source_type, source_id, state FROM evimed_memory.record_sources
      WHERE source_type IN ('evidence_card','frontier_item') AND ($1::text IS NULL OR user_id=$1)
      ORDER BY state_at NULLS FIRST, user_id, record_id LIMIT $2`,
    [userId == null ? null : assertUserId(userId), Math.max(1, Math.min(5000, Number(limit) || 500))]);
    return result.rows.map((/** @type {any} */ row) => ({ userId: String(row.user_id), type: String(row.source_type), id: String(row.source_id), state: String(row.state) }));
  }

  /**
   * Say what a check found about a source, on every memory that rests on it:
   * `retracted`, `changed`, `expired`, `current` again, or `unknown` when the
   * check could not answer — which is recorded as unknown and not as clean.
   *
   * The memories themselves are untouched: no version moves and nothing is
   * withheld. A label on the link is what recall reads, so the memory keeps its
   * history and the researcher's own statement stays theirs. A correction notice
   * does not by itself make a conclusion false; it makes it worth checking.
   *
   * `onlyFrom` names the states a link may be moved out of, so a check that adds
   * nothing leaves what an earlier one found: a lookup that could not answer
   * (`unknown`) moves only a link nobody had found a change on, and a correction
   * never lowers a retraction (`linkStatesLeftFor`). Only the links it moved are
   * returned, and a link already in the state is not stamped again.
   *
   * @param {string} userId @param {{ type: string, id: string }} source
   * @param {{ state: string, reason?: string, onlyFrom?: readonly string[] | null }} finding
   * @returns {Promise<{ recordIds: string[] }>}
   */
  async markSourceLinks(userId, source, { state, reason = "", onlyFrom = null }) {
    const link = sourceLinkOf({ type: source?.type, id: source?.id });
    if (!link) throw invalid("source");
    const next = enumValue(state, MEMORY_SOURCE_STATES, "state");
    const from = onlyFrom == null ? null : onlyFrom.map((value) => enumValue(value, MEMORY_SOURCE_STATES, "onlyFrom"));
    const result = await this.#query(`UPDATE evimed_memory.record_sources SET state=$4,state_reason=$5,
        state_at=date_trunc('second', clock_timestamp())
      WHERE user_id=$1 AND source_type=$2 AND source_id=$3 AND ($6::text[] IS NULL OR (state = ANY($6::text[]) AND state <> $4))
      RETURNING record_id`,
    [assertUserId(userId), link.type, link.id, next, boundedText(reason, MEMORY_REASON_LIMIT), from]);
    return { recordIds: result.rows.map((/** @type {any} */ row) => String(row.record_id)).sort() };
  }

  // --------------------------------------------------------------- settings

  /**
   * The researcher's own switches (2026-09-16 review, M4④): stop learning new
   * memories, stop using memories in answers, and projects where neither
   * happens. Nothing is deleted by any of them; reset is a separate, explicit
   * act.
   * @param {string} userId
   */
  async settings(userId) {
    const result = await this.#query("SELECT * FROM evimed_memory.settings WHERE user_id=$1", [assertUserId(userId)]);
    return publicSettings(result.rows[0] ?? null);
  }

  /**
   * Change some switches and leave the rest as they are, in one statement: two
   * tabs flipping different switches at once must both win.
   * @param {string} userId
   * @param {{ learningPaused?: unknown, recallPaused?: unknown, pausedProjects?: unknown }} patch
   */
  async updateSettings(userId, patch) {
    const owner = assertUserId(userId);
    /** @param {unknown} value @param {string} name */
    const flag = (value, name) => {
      if (value === undefined) return null;
      if (typeof value !== "boolean") throw new HttpError(400, "memory_settings_invalid", `${name} must be true or false.`);
      return value;
    };
    const learning = flag(patch?.learningPaused, "learningPaused");
    const recall = flag(patch?.recallPaused, "recallPaused");
    const projects = patch?.pausedProjects === undefined ? null : pausedProjectList(patch.pausedProjects);
    const result = await this.#query(`INSERT INTO evimed_memory.settings AS s
        (user_id, learning_paused, recall_paused, paused_projects, updated_at)
      VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::boolean, false), COALESCE($4::text[], '{}'),
        date_trunc('second', clock_timestamp()))
      ON CONFLICT (user_id) DO UPDATE SET
        learning_paused = COALESCE($2::boolean, s.learning_paused),
        recall_paused = COALESCE($3::boolean, s.recall_paused),
        paused_projects = COALESCE($4::text[], s.paused_projects),
        updated_at = date_trunc('second', clock_timestamp())
      RETURNING *`, [owner, learning, recall, projects]);
    return publicSettings(result.rows[0]);
  }

  // --------------------------------------------------------------- sessions

  /**
   * One conversation's memory state; nothing set when it has none. All that is
   * left of it is the shared capsule the conversation is trying.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   */
  async sessionState(userId, projectId, sessionId) {
    const result = await this.#query(`SELECT * FROM evimed_memory.sessions
      WHERE user_id=$1 AND project_id=$2 AND session_id=$3`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId)]);
    return publicSessionState(result.rows[0] ?? null);
  }

  /**
   * The conversations of one project that are trying a shared capsule, by
   * session id — what the conversation lists mark with 「试用 ·」.
   * @param {string} userId @param {string} projectId @returns {Promise<Set<string>>}
   */
  async trialSessions(userId, projectId) {
    const result = await this.#query(`SELECT session_id FROM evimed_memory.sessions
      WHERE user_id=$1 AND project_id=$2 AND trial_capsule_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1000`,
    [assertUserId(userId), assertProjectId(projectId)]);
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.session_id)));
  }

  /**
   * Mark a conversation as trying a shared capsule, or end the trial (`null`).
   * @param {string} userId @param {string} projectId @param {string} sessionId
   * @param {{ trialCapsuleId?: unknown }} patch
   */
  async updateSessionState(userId, projectId, sessionId, patch) {
    const owner = assertUserId(userId);
    const project = assertProjectId(projectId);
    const session = assertSessionId(sessionId);
    const trialGiven = patch?.trialCapsuleId !== undefined;
    if (trialGiven && patch.trialCapsuleId !== null
      && (typeof patch.trialCapsuleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(patch.trialCapsuleId))) {
      throw new HttpError(400, "memory_session_invalid", "The trial capsule id is invalid.");
    }
    const result = await this.#query(`INSERT INTO evimed_memory.sessions AS s (user_id, project_id, session_id, trial_capsule_id)
      VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN $5::text ELSE NULL END)
      ON CONFLICT (user_id, project_id, session_id) DO UPDATE SET
        trial_capsule_id = CASE WHEN $4::boolean THEN $5::text ELSE s.trial_capsule_id END,
        updated_at = date_trunc('second', clock_timestamp())
      RETURNING *`,
    [owner, project, session, trialGiven, trialGiven ? patch.trialCapsuleId : null]);
    return publicSessionState(result.rows[0]);
  }

  // ------------------------------------------------------------- composites

  /**
   * The memories this question should see, ranked by term matching.
   *
   * This is the builtin recall arm — the one that needs no index deployed and
   * the one every other arm is measured against — so its scoring is kept
   * exactly as it was. What it is allowed to nominate is decided by
   * `memoryValidity`, the decision both arms share: the version of each fact
   * that held at the time asked (now, unless `asOf` names another) in this
   * project, with what a reader must be told about it — a disagreement, a
   * retracted or corrected source — as labels on the memo and never as a
   * reason to withhold it.
   *
   * A question about an earlier time is answered from here and not from the
   * index: the index holds what is in force now and nothing else, and the
   * versions that held then are in the authority.
   *
   * @param {string} userId @param {string} query
   * @param {{ projectId?: string|null, sessionId?: string|null, asOf?: number|null, now?: number }} scope
   *   `asOf`/`now` in epoch milliseconds; `now` is injectable so the time a
   *   recall is made in is never read behind a test's back.
   */
  async relevant(userId, query, { projectId = null, sessionId = null, asOf = null, now = Date.now() } = {}) {
    if (!this.configured || this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const terms = searchTokens(query);
    const past = asOf != null && asOf < now;
    // History is recallable only for a question about the time before it was
    // replaced; for now, a replaced fact is not true and is not read.
    const statuses = past ? ["active", "superseded"] : ["active"];
    // Durable memories are fetched in their own query. A single page ordered by
    // importance cannot hold both: run summaries arrive one per run and a failed
    // one carries importance 0.7 against a preference's 0.6, so past a hundred
    // runs the page is all episodes and the user's long-term picture becomes
    // permanently unreachable — silently, because a full page still looks fine.
    const [durableRecords, episodicRecords] = await Promise.all([
      this.listRecords(userId, { statuses, kinds: [...DURABLE_RECALL_KINDS], pageSize: 100 }),
      this.listRecords(userId, { statuses, pageSize: 100 }),
    ]);
    const seenRecordIds = new Set();
    const records = [...durableRecords, ...episodicRecords].filter((record) => {
      if (seenRecordIds.has(record.id)) return false;
      seenRecordIds.add(record.id);
      return true;
    });
    const context = { now, asOf, projectId, sessionId };
    // A run summary is the timeline's, not memory the next prompt is handed
    // (2026-09-19 proposal §4.1): it held the platform's own earlier answer,
    // and recalled it as if it were something known about the researcher.
    // Sensitive text is stored and never recalled. Scope, expiry and the
    // validity interval are `versionsInForce`'s.
    const inForce = versionsInForce(records, context);
    const scored = inForce
      .map((entry) => {
        const record = entry.record;
        const content = recallContent(record);
        const haystack = `${record.key} ${content}`.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        const durable = DURABLE_RECALL_KINDS.has(record.kind);
        // An inference weighs less the longer it goes unobserved, on its way
        // to its expiry: a pattern from one week months ago should not outrank
        // one seen yesterday. A statement the researcher made does not fade.
        const freshness = record.origin === "inferred" ? inferenceFreshness(record.updatedAt, now, this.inferredTtlMs) : 1;
        const score = matches + (durable ? 0.75 * freshness : 0) + record.importance + record.confidence * 0.5;
        return {
          entry,
          content,
          // Only durable identity memories apply to every question. Everything
          // else has to earn recall with a query-term match: importance and
          // confidence alone put the score above zero, so without this a
          // greeting would pull every stored run summary into the prompt.
          recallable: durable || matches > 0,
          score,
        };
      })
      .filter((row) => row.recallable);
    // What each recallable memory has to be labelled with, in one read.
    const links = scored.length ? await this.recallLinks(userId, scored.map((row) => row.entry.record.id)) : undefined;
    const labelled = annotateVersions(scored.map((row) => row.entry), links, context);
    const structured = scored.map((row, index) => ({
      memo: {
        id: `record:${row.entry.record.id}`,
        content: row.content,
        updatedAt: row.entry.record.updatedAt,
        memoryType: "structured",
        kind: row.entry.record.kind,
        scope: row.entry.record.scope,
        origin: row.entry.record.origin,
        confidence: row.entry.record.confidence,
        importance: row.entry.record.importance,
        ...versionFields(labelled[index]),
      },
      score: row.score,
    }));
    const byScore = (left, right) =>
      right.score - left.score || String(right.memo.updatedAt).localeCompare(String(left.memo.updatedAt));
    const ranked = [...structured].sort(byScore);
    return selectWithinBudget(ranked, {
      contextLimit: this.contextLimit,
      contextMaxChars: this.contextMaxChars,
    });
  }

  /**
   * What the memory page lists: everything about the researcher and every
   * project's memory, whichever project the page was opened from. It used to
   * list only the current project's, so another project's 45 memories could
   * be reached only by searching or switching (2026-09-26 audit, M-4); each
   * row carries its project, and the page filters by it. A conversation's own
   * (session-scoped) records stay out, as before.
   * @param {string} userId
   */
  async profile(userId) {
    const records = await this.listAllRecords(userId);
    const visible = records.filter((record) => record.scope === "user" || record.scope === "project");
    const groups = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, []]));
    for (const record of visible) groups[record.kind].push(record);
    // A run summary is an entry on the timeline, not something in force about
    // the researcher: 22 of the acceptance account's "52 已生效" were run
    // summaries the page never showed (2026-09-19). They are counted apart.
    const memories = visible.filter((record) => record.kind !== "run_summary");
    return {
      records: visible,
      groups,
      activeCount: memories.filter((record) => record.status === "active").length,
      pendingCount: memories.filter((record) => record.status === "pending").length,
      episodeCount: visible.length - memories.length,
    };
  }

  /**
   * Everything a deleted project leaves behind.
   * @param {string} userId @param {string} projectId
   */
  async deleteProjectMemory(userId, projectId) {
    const owner = assertUserId(userId);
    const scopeId = String(projectId ?? "").trim();
    if (!scopeId) throw new HttpError(400, "memory_payload_invalid", "projectId is required.");
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const records = await client.query(`DELETE FROM evimed_memory.records WHERE user_id=$1 AND scope='project' AND scope_id=$2
        RETURNING id,scope,scope_id,kind`, [owner, scopeId]);
      await this.#forgetRows(client, owner, records.rows);
      // The subtree itself, which the per-record jobs above are bounded and
      // cannot promise to empty: owed to the index in this transaction, so the
      // deletion never waits for the index and the index is still told.
      await this.withdrawals?.enqueue(client, owner, [projectMemoryUri(owner, scopeId)]);
      // The project's conversations' own state goes with it.
      await client.query("DELETE FROM evimed_memory.sessions WHERE user_id=$1 AND project_id=$2", [owner, scopeId]);
      return { structured: Number(records.rowCount ?? 0) };
    });
  }

  /** @param {string} userId */
  async exportUserMemory(userId) {
    const [records, settings, links] = await Promise.all([this.listAllRecords(userId), this.settings(userId), this.#allLinks(userId)]);
    // `manualMemos` is still in the archive, always empty: an archive a
    // customer already downloaded has the key, and a reader that expects it is
    // owed the same shape rather than a missing field it has to guess about.
    // `links` is the relations between memories and what they rest on, added
    // beside the existing keys: everything held about the researcher is in it.
    return { version: 1, records, manualMemos: [], settings, links };
  }

  /** Every relation an account's memories hold, for the export.
   *  @param {string} userId */
  async #allLinks(userId) {
    const owner = assertUserId(userId);
    const [conflicts, sources] = await Promise.all([
      this.#query(`SELECT record_id, other_id, state, reason, resolution, created_at, resolved_at
        FROM evimed_memory.record_conflicts WHERE user_id=$1 ORDER BY record_id, other_id`, [owner]),
      this.#query(`SELECT record_id, source_type, source_id, source_version, state, state_reason, state_at, linked_at
        FROM evimed_memory.record_sources WHERE user_id=$1 ORDER BY record_id, source_type, source_id`, [owner]),
    ]);
    return {
      conflicts: conflicts.rows.map((/** @type {any} */ row) => ({
        recordId: row.record_id, otherId: row.other_id, state: row.state, reason: row.reason, resolution: row.resolution,
        createdAt: memoryInstant(row.created_at), resolvedAt: memoryInstant(row.resolved_at),
      })),
      sources: sources.rows.map((/** @type {any} */ row) => ({ recordId: row.record_id, ...sourceLinkRow(row) })),
    };
  }

  /** What an account's memory amounts to, without deleting any of it.
   *
   *  Account deletion reports these counts and lets the foreign key cascade do
   *  the deleting, inside the transaction that can still fail. Deleting them
   *  first only to name them in an audit line would mean a deletion that failed
   *  halfway had already destroyed the memory of an account that still exists.
   *  @param {string} userId */
  async countUserMemory(userId) {
    const owner = assertUserId(userId);
    const result = await this.#query(
      "SELECT count(*)::integer AS structured FROM evimed_memory.records WHERE user_id=$1", [owner]);
    return { structured: result.rows[0].structured };
  }

  /** Hard deletion of everything one account holds, with the counts the
   *  deletion audit records. Account deletion no longer calls it — the cascade
   *  does that work inside the transaction that can fail — and the export and
   *  the tests still do.
   *  @param {string} userId */
  async purgeUserMemory(userId) {
    const owner = assertUserId(userId);
    const structured = await this.purgeRecords(owner);
    // The counters go with the records they count: a usage row for a record
    // that no longer exists is a copy of deleted data, however small. Any the
    // records did not name (orphans from before 2026-09-27) go as well.
    await this.#query("DELETE FROM evimed_memory.record_usage WHERE user_id=$1", [owner]);
    return { structured };
  }

  /**
   * The next accounts after `after`, in id order: the index sweep's cursor
   * (`MemorySubstrate.sweepRecordLeaves`). Every account, not only those that
   * hold records — an account whose last record was deleted by a path that
   * bypassed the outbox is exactly the one whose index still holds copies.
   * @param {{ after?: string, limit?: number }} [options] @returns {Promise<string[]>}
   */
  async accountsAfter({ after = "", limit = 5 } = {}) {
    const result = await this.#query("SELECT id FROM evimed_control.users WHERE id > $1 ORDER BY id LIMIT $2",
      [String(after ?? ""), Math.max(1, Math.min(100, Number(limit) || 5))]);
    return result.rows.map((row) => String(row.id));
  }

  /**
   * Usage counters whose record no longer exists — what a delete that did not
   * clear them left behind — counted by account, and removed with `apply`.
   * Idempotent: a second pass finds none (audit 2026-09-26, M-7: 84 rows).
   * @param {{ userId?: string | null, apply?: boolean }} [options]
   * @returns {Promise<{ applied: boolean, orphans: { userId: string, rows: number }[] }>}
   */
  async orphanUsage({ userId = null, apply = false } = {}) {
    const owner = userId == null ? null : assertUserId(userId);
    const where = `NOT EXISTS (SELECT 1 FROM evimed_memory.records r WHERE r.user_id=u.user_id AND r.id=u.record_id)
      AND ($1::text IS NULL OR u.user_id=$1)`;
    const result = apply
      ? await this.#query(`WITH removed AS (DELETE FROM evimed_memory.record_usage u WHERE ${where} RETURNING u.user_id)
          SELECT user_id, count(*)::integer AS rows FROM removed GROUP BY user_id ORDER BY user_id`, [owner])
      : await this.#query(`SELECT u.user_id, count(*)::integer AS rows FROM evimed_memory.record_usage u WHERE ${where}
          GROUP BY u.user_id ORDER BY u.user_id`, [owner]);
    return { applied: apply, orphans: result.rows.map((row) => ({ userId: String(row.user_id), rows: Number(row.rows) })) };
  }

  // ------------------------------------------------------------------ usage

  /**
   * Note that these memories were handed to a run, for 「用过 7 次，上次 9月18日」.
   *
   * One statement for the whole recall, and never awaited by the recall itself
   * (see `MemorySubstrate.recall`): a counter that could fail an answer would
   * be a bookkeeping row deciding whether a researcher gets a reply. A record
   * deleted between the recall and this write leaves nothing behind — the
   * foreign key on `records` is deliberately absent so a concurrent delete
   * cannot fail the statement, and `purgeRecords`/`deleteRecord` clear the
   * rows they orphan.
   * @param {string} userId @param {readonly string[]} recordIds
   */
  async noteRecordUsage(userId, recordIds) {
    const owner = assertUserId(userId);
    const ids = [...new Set((recordIds ?? []).map(String).filter((id) => recordIdPattern.test(id)))].slice(0, 100);
    if (ids.length === 0) return 0;
    const result = await this.#query(`INSERT INTO evimed_memory.record_usage AS u (user_id, record_id, used_count, last_used_at)
      SELECT $1, id, 1, date_trunc('second', clock_timestamp()) FROM unnest($2::text[]) AS given(id)
      ON CONFLICT (user_id, record_id) DO UPDATE
        SET used_count = u.used_count + 1, last_used_at = date_trunc('second', clock_timestamp())`,
    [owner, ids]);
    return Number(result.rowCount ?? 0);
  }

  /**
   * How often each of these memories has been used, and when last — the rows
   * that have one. Absent means never used, which the page says as 「还没用过」
   * rather than as a zero the reader has to interpret.
   * @param {string} userId @param {readonly string[]} recordIds
   * @returns {Promise<Record<string, { count: number, lastUsedAt: string | null }>>}
   */
  async recordUsage(userId, recordIds) {
    const owner = assertUserId(userId);
    const ids = [...new Set((recordIds ?? []).map(String).filter((id) => recordIdPattern.test(id)))].slice(0, 2000);
    if (ids.length === 0) return {};
    const result = await this.#query(`SELECT record_id, used_count, last_used_at FROM evimed_memory.record_usage
      WHERE user_id=$1 AND record_id = ANY($2::text[])`, [owner, ids]);
    /** @type {Record<string, { count: number, lastUsedAt: string | null }>} */
    const usage = {};
    for (const row of result.rows) {
      usage[String(row.record_id)] = { count: Number(row.used_count) || 0, lastUsedAt: memoryInstant(row.last_used_at) };
    }
    return usage;
  }

  // ----------------------------------------------------------------- search

  /**
   * The memory page's own search: keyword over everything the account holds,
   * including what recall never serves.
   *
   * Deliberately not `relevant`. That is the recall path — it drops archived
   * rows, drops episodes, applies the prompt budget and answers with rendered
   * strings, all correct for handing memories to a model and all wrong for a
   * person looking for one. The page had no server search at all: its box was
   * a `toLowerCase().includes` over the notes already on screen, so 「阿司匹林」
   * found nothing unless the row happened to be loaded.
   *
   * Three haystacks, because those are the three things a person remembers a
   * memory by: what it says, which conversation it came out of, and which
   * project it belongs to. Run summaries are read for the second and are not
   * results themselves. The conversation's own words come from its run
   * summary — the record the extractor writes per conversation — so this needs
   * no run-ledger scan.
   *
   * Keyword only here; the semantic half is the recall index, and the route
   * unions the two (`memoryRoutes`). A store with no index still searches.
   * @param {string} userId
   * @param {{ query: string, projectId?: string|null, limit?: number }} input
   */
  async searchRecords(userId, { query, projectId = null, limit = 100 }) {
    const owner = assertUserId(userId);
    const terms = searchTokens(boundedText(query, MEMORY_QUERY_LIMIT));
    const bound = Math.max(1, Math.min(500, Number(limit) || 100));
    const all = await this.listAllRecords(owner);
    const titles = conversationTitlesIn(all);
    // A conversation's run summary names it (`titles`) and is not a memory
    // row: shown as one, it put a whole task brief — a GEO step's included —
    // on the page as an inference (2026-09-26 audit, M-4).
    const records = all.filter((record) => record.kind !== "run_summary");
    const project = String(projectId ?? "");
    if (terms.length === 0) return { items: records.slice(0, bound), titles };
    const scored = records
      .map((record) => {
        const conversation = sessionsOf(record).map((id) => titles[id] ?? "").join(" ");
        const haystack = `${record.key} ${record.summary} ${record.value} ${conversation} ${record.scopeId}`.toLowerCase();
        return { record, score: terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score
        || Number(right.record.scopeId === project) - Number(left.record.scopeId === project)
        || String(right.record.updatedAt).localeCompare(String(left.record.updatedAt)));
    return { items: scored.slice(0, bound).map((row) => row.record), titles };
  }
}
