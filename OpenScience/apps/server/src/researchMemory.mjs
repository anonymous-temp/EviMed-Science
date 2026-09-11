import { createHash, randomUUID } from "node:crypto";
import { DURABLE_RECALL_KINDS, recallContent, searchTokens, selectWithinBudget } from "./memoryRecallPolicy.mjs";
import { HttpError } from "./security.mjs";
import {
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  migrateResearchMemory,
} from "./researchMemoryPersistence.mjs";

/**
 * Research memory — structured records and manual notes — on the control-plane
 * database.
 *
 * This replaces a REST client to a separate service. The method surface, the
 * return shapes, the ordering and the error codes are the ones its callers
 * already depend on, because the change worth making here is where the rows
 * live, not what a recall or a confirmation means.
 *
 * Two things the boundary used to hide are now decidable in one place:
 * ownership is a column rather than a hidden tag inside the text (see
 * `extractTags`), and every limit is counted in characters, the unit the routes
 * and the extractor already validate in.
 */

const recordIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const memoryKeyPattern = /^[a-z0-9][a-z0-9._/-]{0,254}$/;
/** The per-user tag the retired client appended to every note to fence one
 *  account off from another. Ownership is a column now; the tag is neither
 *  stored nor returned, and a line of it inside imported text is removed. */
const internalTagLine = /^#evimed-user-[a-f0-9]{24}$/gm;
const internalTagName = /^evimed-user-[a-f0-9]{24}$/;
/** A tag is at most 100 runes (`记忆模块/internal/markdown/parser/tag.go`). */
const MAX_TAG_RUNES = 100;
/** The fingerprint separator, written as an escape. A raw control byte in a
 *  source file is invisible to every reader and to every grep that would
 *  look for it. */
const NUL_SEPARATOR = "\u0000";
const tagCharacter = /[\p{L}\p{N}\p{S}\p{M}\u200D_\-/&]/u;

export const MEMORY_VALUE_LIMIT = 100_000;
export const MEMORY_SUMMARY_LIMIT = 2_000;
export const MEMORY_SCOPE_ID_LIMIT = 255;
export const MEMORY_REASON_LIMIT = 500;
export const MEMORY_QUERY_LIMIT = 500;
export const MEMORY_QUOTE_LIMIT = 4_000;
export const MEMORY_SOURCE_TYPE_LIMIT = 64;
export const MEMORY_SOURCE_REF_LIMIT = 500;
export const MEMORY_NOTE_CONTENT_LIMIT = 100_000;
/** One statement answers a whole export. Past this a caller is not exporting,
 *  it is asking the process to hold a database in memory. */
export const MEMORY_EXPORT_LIMIT = 100_000;

export { MEMORY_EVIDENCE_LIMIT, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_REVISION_LIMIT, MEMORY_SCOPES, MEMORY_STATUSES };

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
    && (stored.expiresAt ?? null) === (next.expiresAt ?? null);
}

/** A URL the GFM autolink extension consumes whole: a bare `https://…`,
 *  `ftp://…` or `www.…`, or an angle-bracket autolink with a scheme. What
 *  follows a `#` inside one is a fragment, not a tag. */
const autolinkedUrl = /<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*>|\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;
/** The destination half of `[label](destination)`, which the link parser reads
 *  as a URL rather than handing to the inline parsers. */
const linkDestination = /\]\([^)\n]*\)/g;

/**
 * Text with everything the inline tag parser never sees removed: code spans,
 * fenced blocks, autolinked URLs and link destinations. A researcher's note
 * cites DOIs and PubMed links, and `https://doi.org/10.1000/xyz#section` used
 * to become the tag `section` here while goldmark made no tag at all.
 *
 * One construct is deliberately not reproduced: an indented code block (four
 * spaces after a blank line). Telling one from a list-item continuation needs a
 * block parser, and dropping a tag a researcher typed is worse than keeping one
 * goldmark would not have made. Keeps line structure so the caller can still
 * reason in lines.
 */
function tagScannableText(content) {
  const kept = [];
  let fenced = false;
  for (const line of String(content ?? "").split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    kept.push(fenced ? "" : line
      .replaceAll(/`[^`\n]*`/g, " ")
      .replaceAll(linkDestination, "] ")
      .replaceAll(autolinkedUrl, " "));
  }
  return kept.join("\n");
}

/**
 * The tags a note carries, by the rule the retired service used.
 *
 * `#` followed by 1..100 runes of Unicode letters, numbers, symbols or marks,
 * ZWJ, `_`, `-`, `/` or `&`; `##` and `# ` are headings rather than tags, and
 * the scan resumes at the next character exactly as the goldmark inline parser
 * does, so `##tag` still yields `tag`. Duplicates keep their first-seen case
 * and position. The rule is reproduced rather than simplified because these
 * strings are already in the UI's filters and in exported archives.
 *
 * This is the rule for notes written after the move. A note carried over from
 * the retired service keeps the tag list that service computed with goldmark
 * itself — see the import script — because that list is what its UI already
 * shows.
 *
 * The per-user internal tag is never returned: it was a tenancy fence, the
 * fence is a column now, and echoing another account's digest back would be the
 * one piece of the old design worth not carrying over.
 * @param {unknown} content @returns {string[]}
 */
export function extractTags(content) {
  const characters = [...tagScannableText(content)];
  const tags = [];
  const seen = new Set();
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "#") continue;
    const next = characters[index + 1];
    if (next === undefined || next === "#" || next === " ") continue;
    let end = index + 1;
    while (end < characters.length && end - index <= MAX_TAG_RUNES && tagCharacter.test(characters[end])) end += 1;
    if (end === index + 1) continue;
    const tag = characters.slice(index + 1, end).join("");
    index = end - 1;
    if (internalTagName.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** What a note stores: the researcher's text, minus any whole line that is one
 *  of the retired internal tags, with runs of blank lines collapsed. */
export function normalizeNoteContent(content) {
  return String(content ?? "")
    .replaceAll(internalTagLine, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** @param {unknown} value */
function assertRecordId(value) {
  const id = String(value ?? "");
  if (!recordIdPattern.test(id)) throw new HttpError(400, "memory_id_invalid", "Structured memory id is invalid.");
  return id;
}

/** @param {unknown} value */
function assertNoteId(value) {
  const id = String(value ?? "");
  if (!recordIdPattern.test(id)) throw new HttpError(400, "memory_id_invalid", "Memory id is invalid.");
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
  };
}

/** The lock one upsert takes: the canonical key of the record it will write. */
function canonicalKeyLock(userId, record) {
  return JSON.stringify([userId, record.scope, record.scopeId, record.kind, record.key]);
}

/** @param {any} row */
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
    })),
  };
}

/** @param {any} row */
function publicNote(row) {
  return {
    id: row.id,
    content: row.content,
    state: row.state,
    pinned: Boolean(row.pinned),
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: memoryInstant(row.created_at),
    updatedAt: memoryInstant(row.updated_at),
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

const recordColumns = "user_id,id,scope,scope_id,kind,key,value,summary,origin,status,confidence,importance,"
  + "sensitive,evidence,revisions,version,created_at,updated_at,last_confirmed_at,expires_at";

export class ResearchMemoryStore {
  /** @param {any} config @param {{ database?: any }} options */
  constructor(config, { database = null } = {}) {
    this.database = database ?? null;
    this.contextLimit = Math.max(0, Math.min(20, Number(config?.memoryContextLimit ?? 8)));
    this.contextMaxChars = Math.max(0, Math.min(100_000, Number(config?.memoryContextMaxChars ?? 20_000)));
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
      return await this.database.transaction(operation);
    } catch (error) {
      throw memoryDatabaseError(error);
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
   * @param {{ expectedVersion?: number, reason?: string }} options
   */
  async upsertRecord(userId, input, evidence = null, { expectedVersion = 0, reason = "" } = {}) {
    const owner = assertUserId(userId);
    const next = validateRecordInput(input);
    const proof = boundedEvidence(evidence);
    // Truncated, never refused. This is audit text that rides along with a
    // write; a long contradiction notice must not cost the memory it explains.
    const auditReason = boundedText(reason, MEMORY_REASON_LIMIT);
    const expected = Math.max(0, Number(expectedVersion) || 0);
    const providedId = input?.id == null || input.id === "" ? null : assertRecordId(input.id);

    return this.#transaction(async (client) => {
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
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'[]'::jsonb,1,$15,$15,$16,$17)
          ON CONFLICT DO NOTHING RETURNING *`,
        [owner, providedId ?? randomUUID(), next.scope, next.scopeId, next.kind, next.key, next.value, next.summary,
          next.origin, next.status, next.confidence, next.importance, next.sensitive, JSON.stringify(created),
          now, next.lastConfirmedAt, next.expiresAt]);
        // The only way to get here is a provided id that already names another
        // of this user's memories: the canonical key was free a statement ago
        // and the lock is still held. Resurrecting the wrong row would be
        // worse than refusing the write.
        if (inserted.rowCount !== 1) {
          throw new HttpError(409, "memory_conflict", "That memory id already names another memory.");
        }
        return publicRecord(inserted.rows[0]);
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
        })
        : stored.revisions;
      if (!added && !stateChanged && currentStateEqual(stored, next)) return stored;

      const updated = await client.query(`UPDATE evimed_memory.records SET value=$3,summary=$4,origin=$5,status=$6,
        confidence=$7,importance=$8,sensitive=$9,evidence=$10::jsonb,revisions=$11::jsonb,version=version+1,
        updated_at=$12,last_confirmed_at=$13,expires_at=$14
        WHERE user_id=$1 AND id=$2 AND version=$15 RETURNING *`,
      [owner, stored.id, next.value, next.summary, next.origin, next.status, next.confidence, next.importance,
        next.sensitive, JSON.stringify(merged), JSON.stringify(revisions), now, next.lastConfirmedAt,
        next.expiresAt, stored.version]);
      if (updated.rowCount !== 1) {
        throw new HttpError(409, "memory_conflict", "This memory changed while it was being written.");
      }
      return publicRecord(updated.rows[0]);
    });
  }

  /** @param {string} userId @param {string} id */
  async deleteRecord(userId, id) {
    const result = await this.#query("DELETE FROM evimed_memory.records WHERE user_id=$1 AND id=$2 RETURNING id",
      [assertUserId(userId), assertRecordId(id)]);
    if (result.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
    return true;
  }

  /** @param {string} userId */
  async purgeRecords(userId) {
    const result = await this.#query("DELETE FROM evimed_memory.records WHERE user_id=$1", [assertUserId(userId)]);
    return Number(result.rowCount ?? 0);
  }

  // ------------------------------------------------------------------ notes

  /** @param {string} userId @param {{ state?: string, pageSize?: number }} options */
  async list(userId, { state = "normal", pageSize = 100 } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.notes WHERE user_id=$1 AND state=$2
      ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT $3`,
    [assertUserId(userId), state === "archived" ? "archived" : "normal",
      Math.max(1, Math.min(200, Number(pageSize) || 100))]);
    return result.rows.map(publicNote);
  }

  /** @param {string} userId @param {{ state?: string }} options */
  async listAllMemos(userId, { state = "normal" } = {}) {
    const result = await this.#query(`SELECT * FROM evimed_memory.notes WHERE user_id=$1 AND state=$2
      ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT $3`,
    [assertUserId(userId), state === "archived" ? "archived" : "normal", MEMORY_EXPORT_LIMIT + 1]);
    if (result.rows.length > MEMORY_EXPORT_LIMIT) {
      throw new HttpError(413, "memory_export_too_large", "This account holds more notes than one export can carry.");
    }
    return result.rows.map(publicNote);
  }

  /** @param {string} userId @param {string} content */
  async create(userId, content) {
    const owner = assertUserId(userId);
    const text = normalizeNoteContent(content);
    if (!text || text.length > MEMORY_NOTE_CONTENT_LIMIT) throw invalid("content");
    // One read of the clock for both stamps: two evaluations of a volatile
    // function in one statement can land either side of a second boundary.
    const result = await this.#query(`INSERT INTO evimed_memory.notes(user_id,id,content,state,pinned,tags,created_at,updated_at)
      SELECT $1,$2,$3,'normal',false,$4::text[],stamp,stamp
      FROM (SELECT date_trunc('second',clock_timestamp()) AS stamp) clock RETURNING *`,
    [owner, randomUUID(), text, extractTags(text)]);
    return publicNote(result.rows[0]);
  }

  /** @param {string} userId @param {string} id @param {Record<string, any>} update */
  async update(userId, id, update) {
    const owner = assertUserId(userId);
    const noteId = assertNoteId(id);
    return this.#transaction(async (client) => {
      const found = await client.query("SELECT * FROM evimed_memory.notes WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [owner, noteId]);
      if (found.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
      const current = publicNote(found.rows[0]);
      const next = { content: current.content, pinned: current.pinned, state: current.state };
      if (Object.hasOwn(update ?? {}, "content")) {
        next.content = normalizeNoteContent(update.content);
        if (!next.content || next.content.length > MEMORY_NOTE_CONTENT_LIMIT) throw invalid("content");
      }
      if (Object.hasOwn(update ?? {}, "pinned")) next.pinned = Boolean(update.pinned);
      if (Object.hasOwn(update ?? {}, "state")) next.state = update.state === "archived" ? "archived" : "normal";
      // Nothing changed, so nothing is written: an edit that restores what is
      // already there must not reorder the list by moving `updatedAt`.
      if (next.content === current.content && next.pinned === current.pinned && next.state === current.state) {
        return current;
      }
      const updated = await client.query(`UPDATE evimed_memory.notes
        SET content=$3,pinned=$4,state=$5,tags=$6::text[],updated_at=date_trunc('second',clock_timestamp())
        WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, noteId, next.content, next.pinned, next.state, extractTags(next.content)]);
      return publicNote(updated.rows[0]);
    });
  }

  /** @param {string} userId @param {string} id */
  async delete(userId, id) {
    const result = await this.#query("DELETE FROM evimed_memory.notes WHERE user_id=$1 AND id=$2 RETURNING id",
      [assertUserId(userId), assertNoteId(id)]);
    if (result.rowCount !== 1) throw new HttpError(404, "memory_not_found", "Memory not found.");
    return true;
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
    const [memos, durableRecords, episodicRecords] = await Promise.all([
      this.list(userId, { pageSize: 100 }),
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
      .filter((record) => !record.sensitive)
      .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter((record) => record.scope === "user"
        || (record.scope === "project" && record.scopeId === projectId)
        || (record.scope === "session" && record.scopeId === sessionId))
      .map((record) => {
        const content = recallContent(record);
        const haystack = `${record.key} ${content}`.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        const durable = DURABLE_RECALL_KINDS.has(record.kind);
        const score = matches + (durable ? 0.75 : 0) + record.importance + record.confidence * 0.5;
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
            confidence: record.confidence,
            importance: record.importance,
          },
          score,
        };
      })
      .filter((row) => row.recallable);
    const legacy = memos
      .map((memo) => {
        const haystack = memo.content.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        return { memo: { ...memo, memoryType: "manual" }, score: matches + (memo.pinned ? 0.25 : 0) };
      })
      .filter((row) => row.score > 0);
    const byScore = (left, right) =>
      right.score - left.score || String(right.memo.updatedAt).localeCompare(String(left.memo.updatedAt));
    const ranked = [...structured, ...legacy].sort(byScore);
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
    return {
      records: visible,
      groups,
      activeCount: visible.filter((record) => record.status === "active").length,
      pendingCount: visible.filter((record) => record.status === "pending").length,
    };
  }

  /**
   * Everything a deleted project leaves behind.
   *
   * The notes half is the legacy rule kept verbatim: nothing writes a note with
   * the `evimed-agent-run` tag and a `- Project: <id>` line any more, and a
   * deployment that ran the version which did must still lose them with the
   * project.
   * @param {string} userId @param {string} projectId
   */
  async deleteProjectMemory(userId, projectId) {
    const owner = assertUserId(userId);
    const scopeId = String(projectId ?? "").trim();
    if (!scopeId) throw new HttpError(400, "memory_payload_invalid", "projectId is required.");
    const records = await this.#query(
      "DELETE FROM evimed_memory.records WHERE user_id=$1 AND scope='project' AND scope_id=$2", [owner, scopeId]);
    const notes = await this.#query(`DELETE FROM evimed_memory.notes
      WHERE user_id=$1 AND 'evimed-agent-run'=ANY(tags) AND $2=ANY(string_to_array(content,chr(10)))`,
    [owner, `- Project: ${scopeId}`]);
    return { structured: Number(records.rowCount ?? 0), manual: Number(notes.rowCount ?? 0) };
  }

  /** @param {string} userId */
  async exportUserMemory(userId) {
    const [records, current, archived] = await Promise.all([
      this.listAllRecords(userId),
      this.listAllMemos(userId, { state: "normal" }),
      this.listAllMemos(userId, { state: "archived" }),
    ]);
    return { version: 1, records, manualMemos: [...current, ...archived] };
  }

  /** Hard deletion of everything one account holds, with the counts the
   *  deletion audit records. The foreign key would do this on its own when the
   *  user row goes; this runs first so the audit can say how much there was.
   *  @param {string} userId */
  async purgeUserMemory(userId) {
    const owner = assertUserId(userId);
    const structured = await this.purgeRecords(owner);
    const notes = await this.#query("DELETE FROM evimed_memory.notes WHERE user_id=$1", [owner]);
    return { structured, manual: Number(notes.rowCount ?? 0) };
  }
}
