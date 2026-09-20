import { createHash, randomUUID } from "node:crypto";
import {
  DURABLE_RECALL_KINDS, recallContent, searchTokens, selectWithinBudget,
} from "./memoryRecallPolicy.mjs";
import { HttpError } from "./security.mjs";
import {
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_PAUSED_PROJECT_LIMIT,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  migrateResearchMemory,
} from "./researchMemoryPersistence.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

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

export { MEMORY_EVIDENCE_LIMIT, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_REVISION_LIMIT, MEMORY_SCOPES, MEMORY_STATUSES };

/**
 * Who changed a record: the extractor after a run, the researcher on the
 * page, or the platform (an undo, a supersession it resolved). A closed list,
 * so a revision cannot claim an actor nothing writes.
 */
export const REVISION_ACTORS = Object.freeze(["extraction", "user", "system"]);

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
    && (stored.invalidSince ?? null) === (next.invalidSince ?? null);
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
  };
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
 * A conversation trying someone else's capsule (`trial`) writes nothing and
 * still reads. 无痕 used to be the third thing read here; it was deleted on
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
  // A conversation trying someone else's capsule writes nothing into this
  // researcher's memory (「试用一次」); it still reads it.
  const trial = Boolean(session.trialCapsuleId);
  return {
    learning: settings.learningPaused || projectPaused || trial,
    recall: settings.recallPaused || projectPaused,
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
  superseded_by, invalid_since,
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
  + "sensitive,evidence,revisions,version,created_at,updated_at,last_confirmed_at,expires_at,superseded_by,invalid_since";

export class ResearchMemoryStore {

  /**
   * `jobs` is the derived index's outbox, and it is handed over only when
   * something will claim from it — the same rule the feedback ledger follows
   * for its distillation queue. A store given the queue on a deployment whose
   * recall provider is `builtin` would enqueue one job per memory for a worker
   * that is never composed.
   *
   * @param {any} config @param {{ database?: any, jobs?: any }} options
   */
  constructor(config, { database = null, jobs = null } = {}) {
    this.database = database ?? null;
    this.jobs = jobs ?? null;
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
   * @param {{ expectedVersion?: number, reason?: string, by?: string, runId?: string | null }} options
   */
  async upsertRecord(userId, input, evidence = null, { expectedVersion = 0, reason = "", by = "", runId = null } = {}) {
    const owner = assertUserId(userId);
    const next = validateRecordInput(input);
    const proof = boundedEvidence(evidence);
    // Truncated, never refused. This is audit text that rides along with a
    // write; a long contradiction notice must not cost the memory it explains.
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    const actor = revisionActor(by, runId);
    const expected = Math.max(0, Number(expectedVersion) || 0);
    const providedId = input?.id == null || input.id === "" ? null : assertRecordId(input.id);

    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      return this.#writeRecord(client, owner, next, proof, { expected, providedId, auditReason, actor });
    });
  }

  /**
   * The upsert itself, inside a transaction the caller holds — so a write
   * that must land together with another (a fact and the one it supersedes)
   * shares one commit.
   * @param {any} client @param {string} owner @param {Record<string, any>} next
   * @param {Record<string, any>|null} proof
   * @param {{ expected: number, providedId: string|null, auditReason: string, actor?: Record<string, string> }} options
   */
  async #writeRecord(client, owner, next, proof, { expected, providedId, auditReason, actor = {} }) {
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
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'[]'::jsonb,1,$15,$15,$16,$17,$18,$19)
        ON CONFLICT DO NOTHING RETURNING *`,
      [owner, providedId ?? randomUUID(), next.scope, next.scopeId, next.kind, next.key, next.value, next.summary,
        next.origin, next.status, next.confidence, next.importance, next.sensitive, JSON.stringify(created),
        now, next.lastConfirmedAt, next.expiresAt, next.supersededBy ?? null, next.invalidSince ?? null]);
      // The only way to get here is a provided id that already names another
      // of this user's memories: the canonical key was free a statement ago
      // and the lock is still held. Resurrecting the wrong row would be
      // worse than refusing the write.
      if (inserted.rowCount !== 1) {
        throw new HttpError(409, "memory_conflict", "That memory id already names another memory.");
      }
      const record = publicRecord(inserted.rows[0]);
      await this.#enqueueRecordIndex(client, owner, record);
      return record;
    }

    const stored = publicRecord(found.rows[0]);
    if (expected > 0 && expected !== stored.version) {
      throw new HttpError(409, "memory_conflict", "This memory changed since it was read.");
    }
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
        ...(stored.supersededBy ? { supersededBy: stored.supersededBy, invalidSince: stored.invalidSince } : {}),
      })
      : stored.revisions;
    if (!added && !stateChanged && currentStateEqual(stored, next)) return stored;

    const updated = await client.query(`UPDATE evimed_memory.records SET value=$3,summary=$4,origin=$5,status=$6,
      confidence=$7,importance=$8,sensitive=$9,evidence=$10::jsonb,revisions=$11::jsonb,version=version+1,
      updated_at=$12,last_confirmed_at=$13,expires_at=$14,superseded_by=$16,invalid_since=$17
      WHERE user_id=$1 AND id=$2 AND version=$15 RETURNING *`,
    [owner, stored.id, next.value, next.summary, next.origin, next.status, next.confidence, next.importance,
      next.sensitive, JSON.stringify(merged), JSON.stringify(revisions), now, next.lastConfirmedAt,
      next.expiresAt, stored.version, next.supersededBy ?? null, next.invalidSince ?? null]);
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
   * @param {Record<string, any>|null} evidence @param {{ reason?: string, by?: string, runId?: string | null }} options
   * @returns {Promise<{ record: any, superseded: any }>}
   */
  async supersede(userId, previousId, input, evidence = null, { reason = "", by = "", runId = null } = {}) {
    const owner = assertUserId(userId);
    const next = validateRecordInput(input);
    const proof = boundedEvidence(evidence);
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
      const record = await this.#writeRecord(client, owner, next, proof, { expected: 0, providedId: null, auditReason, actor });
      const now = await transactionInstant(client);
      const retired = await client.query(`UPDATE evimed_memory.records SET status='superseded',superseded_by=$3,
        invalid_since=COALESCE(invalid_since,$4),revisions=$5::jsonb,version=version+1,updated_at=$4
        WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, replaced.id, record.id, now, JSON.stringify(appendRevision(replaced.revisions, {
        version: replaced.version, value: replaced.value, summary: replaced.summary, status: replaced.status,
        changedAt: now, reason: boundedText(`superseded by ${record.key}${auditReason ? `: ${auditReason}` : ""}`, MEMORY_REASON_LIMIT),
        ...actor,
      }))]);
      const superseded = publicRecord(retired.rows[0]);
      await this.#enqueueRecordIndex(client, owner, superseded);
      return { record, superseded };
    });
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
        await this.#enqueueRecordIndex(client, owner, current);
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
              supersededBy: earlier.supersededBy, invalidSince: earlier.invalidSince,
            })), now]);
          const record = publicRecord(back.rows[0]);
          await this.#enqueueRecordIndex(client, owner, record);
          restored.push(record);
        }
        return { undone: "removed", record: null, previous: current, restored };
      }
      const before = /** @type {any} */ (current.revisions.at(-1));
      const raw = Array.isArray(found.rows[0].revisions) ? found.rows[0].revisions.at(-1) : null;
      const updated = await client.query(`UPDATE evimed_memory.records SET value=$3,summary=$4,status=$5,
        superseded_by=$6,invalid_since=$7,revisions=$8::jsonb,version=version+1,updated_at=$9
        WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, current.id, before.value || current.value, before.summary, before.status,
        typeof raw?.supersededBy === "string" ? raw.supersededBy : null,
        typeof raw?.supersededBy === "string" ? memoryInstant(raw.invalidSince) : null,
        JSON.stringify(appendRevision(current.revisions, {
          version: current.version, value: current.value, summary: current.summary, status: current.status,
          changedAt: now, reason: boundedText(`undone: ${before.reason || "the last change"}`, MEMORY_REASON_LIMIT),
          ...actor,
          ...(current.supersededBy ? { supersededBy: current.supersededBy, invalidSince: current.invalidSince } : {}),
        })), now]);
      const record = publicRecord(updated.rows[0]);
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

  /** @param {string} userId @param {string} id */
  async deleteRecord(userId, id) {
    const owner = assertUserId(userId);
    const recordId = assertRecordId(id);
    return this.#transaction(async (client) => {
      await this.#lockOwnerForOutbox(client, owner);
      const result = await client.query(`DELETE FROM evimed_memory.records
        WHERE user_id=$1 AND id=$2 RETURNING id,scope,scope_id,kind`, [owner, recordId]);
      if (result.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const row = result.rows[0];
      // Enqueued from the delete's own transaction: a forget that commits must
      // not be able to leave the derived copy behind, and a forget that rolls
      // back must not remove a copy of a memory that still exists.
      await this.#enqueueRecordIndex(client, owner, {
        id: row.id, scope: row.scope, scopeId: row.scope_id, kind: row.kind,
      });
      // The usage counter has no foreign key — a recall must never be able to
      // fail on a row being deleted underneath it — so it is cleared here.
      await client.query("DELETE FROM evimed_memory.record_usage WHERE user_id=$1 AND record_id=$2", [owner, recordId]);
      return true;
    });
  }

  /** @param {string} userId */
  async purgeRecords(userId) {
    const result = await this.#query("DELETE FROM evimed_memory.records WHERE user_id=$1", [assertUserId(userId)]);
    return Number(result.rowCount ?? 0);
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
   * exactly as it was.
   *
   * @param {string} userId @param {string} query
   * @param {{ projectId?: string|null, sessionId?: string|null }} scope
   */
  async relevant(userId, query, { projectId = null, sessionId = null } = {}) {
    if (!this.configured || this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const terms = searchTokens(query);
    // Durable memories are fetched in their own query. A single page ordered by
    // importance cannot hold both: run summaries arrive one per run and a failed
    // one carries importance 0.7 against a preference's 0.6, so past a hundred
    // runs the page is all episodes and the user's long-term picture becomes
    // permanently unreachable — silently, because a full page still looks fine.
    const [durableRecords, episodicRecords] = await Promise.all([
      this.listRecords(userId, { statuses: ["active"], kinds: [...DURABLE_RECALL_KINDS], pageSize: 100 }),
      this.listRecords(userId, { statuses: ["active"], pageSize: 100 }),
    ]);
    const seenRecordIds = new Set();
    const records = [...durableRecords, ...episodicRecords].filter((record) => {
      if (seenRecordIds.has(record.id)) return false;
      seenRecordIds.add(record.id);
      return true;
    });
    const now = Date.now();
    const structured = records
      // A run summary is the timeline's, not memory the next prompt is handed
      // (2026-09-19 proposal §4.1): it held the platform's own earlier answer,
      // and recalled it as if it were something known about the researcher.
      .filter((record) => record.kind !== "run_summary")
      .filter((record) => !record.sensitive)
      .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now)
      // A fact that stopped holding: what replaced it is the one to recall.
      .filter((record) => !record.invalidSince || Date.parse(record.invalidSince) > now)
      .filter((record) => record.scope === "user"
        || (record.scope === "project" && record.scopeId === projectId)
        || (record.scope === "session" && record.scopeId === sessionId))
      .map((record) => {
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
          // Only durable identity memories apply to every question. Everything
          // else has to earn recall with a query-term match: importance and
          // confidence alone put the score above zero, so without this a
          // greeting would pull every stored run summary into the prompt.
          recallable: durable || matches > 0,
          memo: {
            id: `record:${record.id}`,
            content,
            updatedAt: record.updatedAt,
            memoryType: "structured",
            kind: record.kind,
            scope: record.scope,
            origin: record.origin,
            confidence: record.confidence,
            importance: record.importance,
          },
          score,
        };
      })
      .filter((row) => row.recallable);
    const byScore = (left, right) =>
      right.score - left.score || String(right.memo.updatedAt).localeCompare(String(left.memo.updatedAt));
    const ranked = [...structured].sort(byScore);
    return selectWithinBudget(ranked, {
      contextLimit: this.contextLimit,
      contextMaxChars: this.contextMaxChars,
    });
  }

  /** @param {string} userId @param {{ projectId?: string|null }} scope */
  async profile(userId, { projectId = null } = {}) {
    const records = await this.listAllRecords(userId);
    const visible = records.filter((record) => record.scope === "user"
      || (record.scope === "project" && record.scopeId === projectId));
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
    const records = await this.#query(
      "DELETE FROM evimed_memory.records WHERE user_id=$1 AND scope='project' AND scope_id=$2", [owner, scopeId]);
    // The project's conversations' own state goes with it.
    await this.#query("DELETE FROM evimed_memory.sessions WHERE user_id=$1 AND project_id=$2", [owner, scopeId]);
    return { structured: Number(records.rowCount ?? 0) };
  }

  /** @param {string} userId */
  async exportUserMemory(userId) {
    const [records, settings] = await Promise.all([this.listAllRecords(userId), this.settings(userId)]);
    // `manualMemos` is still in the archive, always empty: an archive a
    // customer already downloaded has the key, and a reader that expects it is
    // owed the same shape rather than a missing field it has to guess about.
    return { version: 1, records, manualMemos: [], settings };
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
    // that no longer exists is a copy of deleted data, however small.
    await this.#query("DELETE FROM evimed_memory.record_usage WHERE user_id=$1", [owner]);
    return { structured };
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
   * project it belongs to. The conversation's own words come from its run
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
    const records = await this.listAllRecords(owner);
    const titles = conversationTitlesIn(records);
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
