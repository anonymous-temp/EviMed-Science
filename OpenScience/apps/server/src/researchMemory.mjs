import { createHash, randomUUID } from "node:crypto";
import {
  DURABLE_RECALL_KINDS, noteSearchQuery, noteSearchTokens, recallContent, searchTokens, selectWithinBudget, setAsideIn,
} from "./memoryRecallPolicy.mjs";
import { HttpError } from "./security.mjs";
import {
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_PAUSED_PROJECT_LIMIT,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_SESSION_EXCLUSION_TYPES,
  MEMORY_STATUSES,
  migrateResearchMemory,
} from "./researchMemoryPersistence.mjs";
import { migrateProductStore } from "./productPersistence.mjs";

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
 * An incognito conversation (2026-09-20) is paused both ways for itself only:
 * nothing is extracted from it and nothing is recalled into it. A conversation
 * trying someone else's capsule (`trial`) writes nothing and still reads.
 * `excluded` is what the researcher set aside in that conversation with 「本次不用」.
 *
 * @param {any} store @param {string} userId @param {string | null} projectId @param {string | null} [sessionId]
 * @returns {Promise<{ learning: boolean, recall: boolean, incognito: boolean, trial: boolean, excluded: { type: string, id: string, label?: string }[] }>} true = paused
 */
export async function memoryPausedFor(store, userId, projectId, sessionId = null) {
  if (typeof store?.settings !== "function" || store.configured === false) {
    return { learning: false, recall: false, incognito: false, trial: false, excluded: [] };
  }
  const settings = await store.settings(userId);
  const projectPaused = Boolean(projectId) && settings.pausedProjects.includes(String(projectId));
  // A conversation id this store cannot hold has no state: nothing set aside,
  // not incognito. Any other failure is the store's, and propagates.
  const session = sessionId && projectId && typeof store.sessionState === "function"
    ? await store.sessionState(userId, projectId, sessionId).catch((/** @type {any} */ error) => {
      if (error?.code === "memory_session_invalid") return { incognito: false, excluded: [] };
      throw error;
    })
    : { incognito: false, excluded: [] };
  // A conversation trying someone else's capsule writes nothing into this
  // researcher's memory (「试用一次」); it still reads it.
  const trial = Boolean(session.trialCapsuleId);
  return {
    learning: settings.learningPaused || projectPaused || session.incognito || trial,
    recall: settings.recallPaused || projectPaused || session.incognito,
    incognito: session.incognito,
    trial,
    excluded: session.excluded,
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

/**
 * One 「本次不用」 item, bounded: what kind of thing it is, its id as recall
 * names it, and a label so the panel can still say what was set aside after
 * the thing itself is gone.
 * @param {unknown} value
 */
export function sessionExclusion(value) {
  const item = /** @type {Record<string, unknown>} */ (value && typeof value === "object" ? value : {});
  const type = String(item.type ?? "");
  if (!MEMORY_SESSION_EXCLUSION_TYPES.includes(type)) throw new HttpError(400, "memory_session_invalid", "Unknown exclusion type.");
  const id = String(item.id ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,299}$/.test(id)) throw new HttpError(400, "memory_session_invalid", "The excluded item's id is invalid.");
  const label = boundedText(item.label, 200);
  return { type, id, ...(label ? { label } : {}) };
}

/** @param {any} row */
function publicSessionState(row) {
  return {
    incognito: row?.incognito === true,
    excluded: Array.isArray(row?.excluded) ? row.excluded.map((item) => {
      try { return sessionExclusion(item); } catch { return null; }
    }).filter(Boolean) : [],
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
  /** Accounts whose notes all carry search tokens, in this process. */
  #vectorsReady = new Set();

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
    const result = await this.#query(`SELECT * FROM evimed_memory.records
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
   * One conversation's memory state; every switch off when it has none.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   */
  async sessionState(userId, projectId, sessionId) {
    const result = await this.#query(`SELECT * FROM evimed_memory.sessions
      WHERE user_id=$1 AND project_id=$2 AND session_id=$3`,
    [assertUserId(userId), assertProjectId(projectId), assertSessionId(sessionId)]);
    return publicSessionState(result.rows[0] ?? null);
  }

  /**
   * Change one conversation's memory state in one statement: the incognito
   * switch, and one item set aside (`exclude`) or brought back (`include`).
   * Two tabs changing different things at once must both win, which is why
   * this is an upsert over the stored array rather than a read and a write.
   * @param {string} userId @param {string} projectId @param {string} sessionId
   * @param {{ incognito?: unknown, exclude?: unknown, include?: unknown, trialCapsuleId?: unknown }} patch
   *   `trialCapsuleId` marks the conversation as a trial of a shared capsule (null ends it).
   */
  async updateSessionState(userId, projectId, sessionId, patch) {
    const owner = assertUserId(userId);
    const project = assertProjectId(projectId);
    const session = assertSessionId(sessionId);
    if (patch?.incognito !== undefined && typeof patch.incognito !== "boolean") {
      throw new HttpError(400, "memory_session_invalid", "incognito must be true or false.");
    }
    const trialGiven = patch?.trialCapsuleId !== undefined;
    if (trialGiven && patch.trialCapsuleId !== null
      && (typeof patch.trialCapsuleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(patch.trialCapsuleId))) {
      throw new HttpError(400, "memory_session_invalid", "The trial capsule id is invalid.");
    }
    const exclude = patch?.exclude === undefined ? null : sessionExclusion(patch.exclude);
    const include = patch?.include === undefined ? null : sessionExclusion({ label: "", ...(/** @type {any} */ (patch.include)) });
    const result = await this.#query(`INSERT INTO evimed_memory.sessions AS s (user_id, project_id, session_id, incognito, excluded, trial_capsule_id)
      VALUES ($1, $2, $3, COALESCE($4::boolean, false), CASE WHEN $5::jsonb IS NULL THEN '[]'::jsonb ELSE jsonb_build_array($5::jsonb) END,
        CASE WHEN $7::boolean THEN $8::text ELSE NULL END)
      ON CONFLICT (user_id, project_id, session_id) DO UPDATE SET
        incognito = COALESCE($4::boolean, s.incognito),
        trial_capsule_id = CASE WHEN $7::boolean THEN $8::text ELSE s.trial_capsule_id END,
        excluded = (
          SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb) FROM (
            SELECT item, ordinal FROM jsonb_array_elements(s.excluded) WITH ORDINALITY AS kept(item, ordinal)
            WHERE NOT ($5::jsonb IS NOT NULL AND item->>'type' = $5::jsonb->>'type' AND item->>'id' = $5::jsonb->>'id')
              AND NOT ($6::jsonb IS NOT NULL AND item->>'type' = $6::jsonb->>'type' AND item->>'id' = $6::jsonb->>'id')
            UNION ALL
            SELECT $5::jsonb, 1000000 WHERE $5::jsonb IS NOT NULL
          ) AS merged
        ),
        updated_at = date_trunc('second', clock_timestamp())
      RETURNING *`,
    [owner, project, session, patch?.incognito ?? null, exclude ? JSON.stringify(exclude) : null,
      include ? JSON.stringify({ type: include.type, id: include.id }) : null, trialGiven, trialGiven ? patch.trialCapsuleId : null]);
    // The table's CHECK bounds the list at MEMORY_SESSION_EXCLUSION_LIMIT; a
    // write past it is refused there, as a payload error.
    return publicSessionState(result.rows[0]);
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
    const result = await this.#query(`INSERT INTO evimed_memory.notes(user_id,id,content,state,pinned,tags,created_at,updated_at,search_vector)
      SELECT $1,$2,$3,'normal',false,$4::text[],stamp,stamp,array_to_tsvector($5::text[])
      FROM (SELECT date_trunc('second',clock_timestamp()) AS stamp) clock RETURNING *`,
    [owner, randomUUID(), text, extractTags(text), noteSearchTokens(text)]);
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
        SET content=$3,pinned=$4,state=$5,tags=$6::text[],updated_at=date_trunc('second',clock_timestamp()),
          search_vector=array_to_tsvector($7::text[])
        WHERE user_id=$1 AND id=$2 RETURNING *`,
      [owner, noteId, next.content, next.pinned, next.state, extractTags(next.content), noteSearchTokens(next.content)]);
      return publicNote(updated.rows[0]);
    });
  }

  /**
   * The notes a question can reach: every note of the account that shares a
   * token with it, and every pinned note — the same two things the matcher
   * below always let through, now over all of them rather than the newest
   * hundred (plan §3.4 #8). Ordered by how much of the question each matches;
   * the caller scores them. Reached only through this store (principle 18):
   * the knowledge-base search never reads memory, nor this the KB.
   * @param {string} userId @param {string} query @param {{ limit?: number }} [options]
   */
  async searchNotes(userId, query, { limit = 100 } = {}) {
    const owner = assertUserId(userId);
    await this.#backfillNoteVectors(owner);
    const result = await this.#query(`SELECT * FROM evimed_memory.notes
      WHERE user_id=$1 AND state='normal' AND (pinned OR ($2::tsquery IS NOT NULL AND search_vector @@ $2::tsquery))
      ORDER BY CASE WHEN $2::tsquery IS NULL THEN 0 ELSE ts_rank(search_vector, $2::tsquery) END DESC,
        pinned DESC, updated_at DESC, id DESC
      LIMIT $3`,
    [owner, noteSearchQuery(query), Math.max(1, Math.min(200, Number(limit) || 100))]);
    return result.rows.map(publicNote);
  }

  /**
   * Give the notes written before `search_vector` existed their tokens, once
   * per account per process. A row edited meanwhile keeps the tokens its edit
   * wrote: the update matches on the content it tokenized.
   * @param {string} owner
   */
  async #backfillNoteVectors(owner) {
    if (this.#vectorsReady.has(owner)) return;
    for (let round = 0; round < 50; round += 1) {
      const pending = await this.#query(`SELECT id, content FROM evimed_memory.notes
        WHERE user_id=$1 AND search_vector IS NULL ORDER BY id LIMIT 200`, [owner]);
      if (pending.rowCount === 0) break;
      for (const row of pending.rows) {
        await this.#query(`UPDATE evimed_memory.notes SET search_vector=array_to_tsvector($4::text[])
          WHERE user_id=$1 AND id=$2 AND content=$3 AND search_vector IS NULL`, [owner, row.id, row.content, noteSearchTokens(row.content)]);
      }
    }
    this.#vectorsReady.add(owner);
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
   * @param {{ projectId?: string|null, sessionId?: string|null, excluded?: readonly { type: string, id: string }[] }} scope
   */
  async relevant(userId, query, { projectId = null, sessionId = null, excluded = [] } = {}) {
    if (!this.configured || this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const setAside = setAsideIn(excluded);
    const terms = searchTokens(query);
    // Durable memories are fetched in their own query. A single page ordered by
    // importance cannot hold both: run summaries arrive one per run and a failed
    // one carries importance 0.7 against a preference's 0.6, so past a hundred
    // runs the page is all episodes and the user's long-term picture becomes
    // permanently unreachable — silently, because a full page still looks fine.
    const [memos, durableRecords, episodicRecords] = await Promise.all([
      this.searchNotes(userId, query),
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
      .filter((row) => row.recallable)
      .filter((row) => !setAside(row.memo));
    const legacy = memos
      .map((memo) => {
        const haystack = memo.content.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        return { memo: { ...memo, memoryType: "manual" }, score: matches + (memo.pinned ? 0.25 : 0) };
      })
      .filter((row) => row.score > 0)
      .filter((row) => !setAside(row.memo));
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
    // The project's conversations' own state goes with it.
    await this.#query("DELETE FROM evimed_memory.sessions WHERE user_id=$1 AND project_id=$2", [owner, scopeId]);
    const notes = await this.#query(`DELETE FROM evimed_memory.notes
      WHERE user_id=$1 AND 'evimed-agent-run'=ANY(tags) AND $2=ANY(string_to_array(content,chr(10)))`,
    [owner, `- Project: ${scopeId}`]);
    return { structured: Number(records.rowCount ?? 0), manual: Number(notes.rowCount ?? 0) };
  }

  /** @param {string} userId */
  async exportUserMemory(userId) {
    const [records, current, archived, settings] = await Promise.all([
      this.listAllRecords(userId),
      this.listAllMemos(userId, { state: "normal" }),
      this.listAllMemos(userId, { state: "archived" }),
      this.settings(userId),
    ]);
    return { version: 1, records, manualMemos: [...current, ...archived], settings };
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
    const result = await this.#query(`SELECT
      (SELECT count(*)::integer FROM evimed_memory.records WHERE user_id=$1) AS structured,
      (SELECT count(*)::integer FROM evimed_memory.notes WHERE user_id=$1) AS manual`, [owner]);
    return { structured: result.rows[0].structured, manual: result.rows[0].manual };
  }

  /** Hard deletion of everything one account holds, with the counts the
   *  deletion audit records. Account deletion no longer calls it — the cascade
   *  does that work inside the transaction that can fail — and the export and
   *  the tests still do.
   *  @param {string} userId */
  async purgeUserMemory(userId) {
    const owner = assertUserId(userId);
    const structured = await this.purgeRecords(owner);
    const notes = await this.#query("DELETE FROM evimed_memory.notes WHERE user_id=$1", [owner]);
    return { structured, manual: Number(notes.rowCount ?? 0) };
  }
}
