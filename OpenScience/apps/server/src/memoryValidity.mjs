/**
 * Which stored version of a fact answers a question, and what the reader must be
 * told about it — decided from the authoritative record at the moment of recall.
 *
 * This is product policy and not index policy, which is why it lives on its own
 * beside `memoryRecallPolicy.mjs`: the term matcher and the OpenViking arm both
 * end here, so the answer to "is this the version that held when the question
 * is about, in this project?" cannot differ by which of them nominated the
 * record. The index holds text and nothing else (it is rebuilt from the
 * records, `MemorySubstrate.rebuild`); validity, replacement and conflict are
 * columns and relations in PostgreSQL, read at hydration.
 *
 * A fact's validity is the interval [start, until). `until` is the record's
 * `invalidSince`, the instant it stopped (or will stop) holding. `start` is its
 * `validFrom` when the writer knew it and otherwise the moment the platform
 * recorded it: an unknown start is not "always", so a question about a time
 * before the platform knew anything gets the version that began later, labelled
 * `not_yet_valid`, rather than a confident answer.
 *
 * What is withheld is only what is decidable and was never this question's:
 * another project's records, a session's that is not this one, a forgotten,
 * archived or sensitive record, a version outside its interval, and the broader
 * of two scopes that hold the same fact. What is merely uncertain is labelled
 * and served (principle 13: a label never withholds): two statements that
 * disagree, a source that was retracted, corrected or has lapsed, a version that
 * begins after the time asked, an inference with no evidence behind it.
 *
 * @module memoryValidity
 */

/** Why a served memory is uncertain, most serious first. A closed vocabulary:
 *  it reaches the model as an attribute and the tool answer as a list. */
export const MEMORY_CAVEATS = Object.freeze([
  "conflict",
  "source_retracted",
  "source_expired",
  "source_changed",
  "not_yet_valid",
  "insufficient_evidence",
]);

/** The caveat each non-current source state raises. `current` and `unknown` raise
 *  none: an unanswered check is not a finding, and it is not a clean bill either
 *  (the link keeps saying `unknown`). */
const SOURCE_STATE_CAVEAT = Object.freeze({
  retracted: "source_retracted",
  expired: "source_expired",
  changed: "source_changed",
});

/** A narrower scope is about this conversation or project specifically, so where
 *  two scopes hold the same fact the narrower one is the version that applies. */
const SCOPE_RANK = Object.freeze({ session: 3, project: 2, user: 1, organization: 0 });

/** How much of a conflicting record's text rides along with the label. */
const CONFLICT_EXCERPT = 160;

/** @param {unknown} value @returns {number | null} */
function instant(value) {
  if (value == null || value === "") return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

/**
 * A record's validity interval in epoch milliseconds.
 *
 * `recorded`: whether an unknown start is read as the moment the platform
 * recorded the fact. It is for a question about an earlier time, where "the
 * platform knew nothing then" is the honest answer. For a question about now it
 * is not: a record the platform holds in force is in force now, and reading its
 * recording time against the caller's clock would make a memory written a
 * second ago "not yet valid" whenever the database's clock runs ahead of the
 * server's.
 * @param {Record<string, any>} record @param {{ recorded?: boolean }} [options]
 * @returns {{ start: number, until: number }}
 */
export function validityOf(record, { recorded = true } = {}) {
  return {
    start: instant(record.validFrom) ?? (recorded ? instant(record.createdAt) : null) ?? -Infinity,
    until: instant(record.invalidSince) ?? Infinity,
  };
}

/**
 * What a recall is asked in: the moment the question is about (now unless the
 * question names another), and where it is asked.
 * @typedef {{ now?: number, asOf?: number | null, projectId?: string | null, sessionId?: string | null }} RecallContext
 */

/** @param {RecallContext} context */
function momentOf(context) {
  const now = Number.isFinite(context.now) ? /** @type {number} */ (context.now) : Date.now();
  const asked = context.asOf == null ? null : Number(context.asOf);
  const at = asked != null && Number.isFinite(asked) ? asked : now;
  return { now, at, past: at < now };
}

/** Whether this caller may be handed the record at all, whatever it says. The
 *  scope is a permission, proved by the record and not by where it was found.
 *  @param {Record<string, any>} record @param {RecallContext} context */
function mayRead(record, context) {
  if (record.kind === "run_summary" || record.sensitive) return false;
  return record.scope === "user"
    || (record.scope === "project" && record.scopeId === (context.projectId ?? null))
    || (record.scope === "session" && record.scopeId === (context.sessionId ?? null));
}

/**
 * Whether a record is one a recall may use at the moment asked: allowed, in a
 * status that can be recalled, and inside its validity interval.
 *
 * `active` is what is in force. `superseded` is history, and is recallable only
 * for a question about a time before it was replaced — never for now, where it
 * is simply not true any more. `pending`, `archived` and `forgotten` never are:
 * a researcher who removed a memory does not get it back by asking about the
 * past (retrieval never restores revoked access).
 *
 * The expiry of an inference is the platform's own retention horizon, not a
 * statement about the world, so it applies to a question about now and not to a
 * question about an earlier time.
 * @param {Record<string, any>} record @param {RecallContext} context
 */
export function heldAt(record, context) {
  const { now, at, past } = momentOf(context);
  if (!mayRead(record, context)) return false;
  if (!(record.status === "active" || (past && record.status === "superseded"))) return false;
  if (!past && instant(record.expiresAt) != null && /** @type {number} */ (instant(record.expiresAt)) <= now) return false;
  const { start, until } = validityOf(record, { recorded: past });
  return start < until && start <= at && at < until;
}

/**
 * The records that answer the question, from the records a matcher or an index
 * nominated: one version per fact, and nothing outside this project.
 *
 * Input order is kept, so the caller's ranking survives. Each entry says whether
 * it is the version in force (`caveats: []`) or one that begins after the time
 * asked (`not_yet_valid`, served only when nothing else in hand covers it).
 *
 * @param {readonly Record<string, any>[]} records
 * @param {RecallContext} [context]
 * @returns {{ record: Record<string, any>, caveats: string[] }[]}
 */
export function versionsInForce(records, context = {}) {
  const { now, at, past } = momentOf(context);
  /** @type {Record<string, any>[]} */
  let held = [];
  /** @type {Record<string, any>[]} */
  const upcoming = [];
  for (const record of records) {
    if (heldAt(record, context)) { held.push(record); continue; }
    if (!mayRead(record, context)) continue;
    if (!(record.status === "active" || (past && record.status === "superseded"))) continue;
    if (!past && instant(record.expiresAt) != null && /** @type {number} */ (instant(record.expiresAt)) <= now) continue;
    const { start, until } = validityOf(record, { recorded: past });
    if (start < until && start > at) upcoming.push(record);
  }

  // Where a record and its replacement are both in hand and both held — the
  // replacement was written before the old one was retired — the replacement is
  // the version.
  const heldIds = new Set(held.map((record) => record.id));
  held = held.filter((record) => !(record.supersededBy && heldIds.has(record.supersededBy)));

  // The same fact at two scopes: the narrower one applies. Keyed by kind and key,
  // the fact's name across scopes; a project's memory never reaches another
  // project (`mayRead`), so this only ever chooses between what this caller may see.
  /** @type {Map<string, number>} */
  const widest = new Map();
  for (const record of held) {
    const name = `${record.kind}\u0000${record.key}`;
    widest.set(name, Math.max(widest.get(name) ?? -1, SCOPE_RANK[/** @type {keyof typeof SCOPE_RANK} */ (record.scope)] ?? 0));
  }
  held = held.filter((record) => (SCOPE_RANK[/** @type {keyof typeof SCOPE_RANK} */ (record.scope)] ?? 0)
    >= (widest.get(`${record.kind}\u0000${record.key}`) ?? 0));

  // A version that has not begun is a heads-up only while nothing in hand holds
  // the place it will take: its predecessor — held now, or itself still to
  // begin, when the question is about a time before the whole chain — is the
  // answer, and only the earliest version of a chain is offered.
  const waiting = new Set([...held, ...upcoming].map((record) => record.supersededBy).filter(Boolean));
  const ahead = upcoming.filter((record) => !waiting.has(record.id));

  /** @type {Map<string, string[]>} */
  const chosen = new Map();
  for (const record of held) chosen.set(record.id, []);
  for (const record of ahead) chosen.set(record.id, ["not_yet_valid"]);
  return records.filter((record) => chosen.has(record.id))
    .map((record) => ({ record, caveats: [...(chosen.get(record.id) ?? [])] }));
}

/**
 * @typedef {{ otherId: string, state: string, createdAt: string | null,
 *   other: Record<string, any> }} ConflictLink
 * @typedef {{ type: string, id: string, state: string, version?: string | null }} SourceLink
 * @typedef {{ conflicts?: ReadonlyMap<string, readonly ConflictLink[]>,
 *   sources?: ReadonlyMap<string, readonly SourceLink[]> }} RecordLinks
 * @typedef {{ record: Record<string, any>, caveats: string[],
 *   conflictsWith: { id: string, key: string, kind: string, scope: string, origin: string, summary: string }[],
 *   staleSources: { type: string, id: string, state: string }[],
 *   validity: { from: string | null, until: string | null } }} RecalledVersion
 */

/**
 * The labels a served version carries: whether a statement that disagrees with
 * it is in force, whether a source it rests on was retracted, corrected or has
 * lapsed, and whether anything stands behind an inference.
 *
 * A conflict counts only while both statements hold at the time asked — a
 * forgotten, replaced or not-yet-begun statement is no longer one side of it —
 * and only from the moment it was recorded: a question about a time before the
 * pair existed is not answered with a disagreement that did not exist then.
 *
 * @param {readonly { record: Record<string, any>, caveats: string[] }[]} entries
 * @param {RecordLinks} [links] @param {RecallContext} [context]
 * @returns {RecalledVersion[]}
 */
export function annotateVersions(entries, links = {}, context = {}) {
  const { at } = momentOf(context);
  return entries.map(({ record, caveats }) => {
    const found = new Set(caveats);
    const conflictsWith = [];
    for (const link of links.conflicts?.get(record.id) ?? []) {
      if (link.state !== "open") continue;
      const recorded = instant(link.createdAt);
      if (recorded != null && recorded > at) continue;
      if (!heldAt(link.other, context)) continue;
      conflictsWith.push({
        id: String(link.other.id), key: String(link.other.key ?? ""), kind: String(link.other.kind ?? ""),
        scope: String(link.other.scope ?? ""),
        // Whose statement it is — the researcher's, an inference, a platform
        // or source record — because two statements that disagree are weighed
        // by who made each.
        origin: String(link.other.origin ?? ""),
        summary: String(link.other.summary || link.other.value || "").replace(/\s+/gu, " ").trim().slice(0, CONFLICT_EXCERPT),
      });
    }
    if (conflictsWith.length) found.add("conflict");
    const staleSources = [];
    for (const link of links.sources?.get(record.id) ?? []) {
      const caveat = SOURCE_STATE_CAVEAT[/** @type {keyof typeof SOURCE_STATE_CAVEAT} */ (link.state)];
      if (!caveat) continue;
      found.add(caveat);
      staleSources.push({ type: link.type, id: link.id, state: link.state });
    }
    // An inference or a platform note that cites nothing: not wrong, but nothing
    // can be checked behind it. The researcher's own statement needs no citation.
    if (record.evidenceCount === 0 && ["inferred", "system"].includes(record.origin)) found.add("insufficient_evidence");
    return {
      record,
      caveats: MEMORY_CAVEATS.filter((caveat) => found.has(caveat)),
      conflictsWith,
      staleSources,
      validity: { from: record.validFrom ?? null, until: record.invalidSince ?? null },
    };
  });
}

/**
 * What a version adds to the memo a recall hands out: only what is there, so a
 * memory with no history of any kind is the memo it always was.
 * @param {RecalledVersion} version
 * @returns {Record<string, unknown>}
 */
export function versionFields(version) {
  return {
    ...(version.caveats.length ? { caveats: version.caveats } : {}),
    ...(version.validity.from || version.validity.until ? { validity: version.validity } : {}),
    ...(version.conflictsWith.length ? { conflictsWith: version.conflictsWith } : {}),
    ...(version.staleSources.length ? { staleSources: version.staleSources } : {}),
  };
}

/**
 * A question's own time, as the model gives it: an ISO date or instant, or
 * nothing. A date with no time of day is read at its end, so "as of 2025-06-30"
 * includes the whole of that day. Anything else is refused by the caller.
 * @param {unknown} value @returns {number | null | undefined} undefined when it is not a date
 */
export function parseAsOf(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const time = Date.parse(dateOnly ? `${text}T23:59:59.999Z` : text);
  return Number.isFinite(time) ? time : undefined;
}
