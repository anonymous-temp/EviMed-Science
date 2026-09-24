/**
 * 「与你相关」: the frontier feed's per-reader ranking (plan §4.6, §6.5, §10.5.3;
 * rebuilt 2026-09-24 on what the reader actually shows interest in).
 *
 * Content is written once for everyone; personalization only re-orders what
 * is already written. A reader's profile — specialties and at most ten
 * interest phrases, each naming what it came from — is extracted by one model
 * call and the phrases are embedded; the published items of the last 72 hours
 * (7 days when that holds fewer than 20) are ranked against it in SQL, and the
 * top eight are cached with the phrase that picked each: that phrase is the
 * heading the reader sees the item under.
 *
 * Hidden knowledge:
 *
 * - **What the reader shows interest in, three ways.** Their memory of every
 *   provenance — stated, confirmed, edited, inferred, from a tool or from the
 *   assistant — that is active and not sensitive (at most 40, by importance);
 *   the questions of their own conversations of the last 30 days (at most 30,
 *   newest first, `frontierProfileQuestions`); and the feed items they starred
 *   or opened in the last 60 days (at most 30, stars first). Left out: run
 *   summaries; memories and questions of a project the reader paused and of
 *   the platform's internal projects; deleted conversations and work a
 *   machine started. Everything is left out when the reader paused recall —
 *   for them the block is off. An inferred memory feeds a ranking and nothing
 *   else: it is at most the heading of a group of news items, never written
 *   anywhere as a fact (principle 18).
 * - **Every phrase keeps where it came from** — `memory` with the memory's
 *   id, `question`, or `frontier-item`. A memory the reader deleted or archived
 *   since the ranking was cached takes its items with it at once, without a
 *   new ranking; the other two are read again at the next profile.
 * - **What the reader hid pushes back.** An item marked 「不感兴趣」 keeps out
 *   every candidate of its event and, where there are vectors, every candidate
 *   whose cosine to it is at least `FRONTIER_FOR_YOU_HIDDEN_COSINE`. Items the
 *   reader already starred or opened are not recommended to them again.
 * - **Ranking.** Every published item of the window that passes the reader's
 *   hidden and muted filters is a candidate (the newest 300), not only the
 *   editor's best. An item scores its best phrase's cosine plus a tenth of its
 *   editorial score out of 100 — enough to order near-equals, never to carry
 *   an item past the 0.4 floor — and a phrase picks at most two items, so one
 *   interest never fills the block. Vectors, not the rerank service
 *   (§10.5.3): that service returns an order without scores and cannot say
 *   which phrase matched.
 * - **Without vectors it says so.** No embedder, no pgvector, or no phrase
 *   vector: the phrases are matched as keywords against the items' own search
 *   lexemes, and the answer's `basis` is `tags` — never a ranking that
 *   pretends to be semantic.
 * - **Fresh within a round, not a day.** A profile is due when it is missing
 *   or a day old, and as soon as what it was read from changes: a star or an
 *   unstar, a researcher's new or deleted question (`noteConversation`), a
 *   change to their memory (its count, versions and latest change, kept as
 *   `memory_mark`), and — for a reader who has nothing yet — an item opened or
 *   the block opened. A hide changes nothing the model reads and only drops
 *   the cached ranking. Readers who opened the block since their profile was
 *   computed go first. Each round computes at most five profiles, one model
 *   call each, and none while the day's budget is past its threshold.
 * - **States, honestly.** `off`: this deployment has no memory store or no
 *   model to read it with — the block is absent — or this reader paused recall
 *   (`paused: true`). `unavailable`: the memory store failed when it was last
 *   read — the page says 「暂时不可用」 and the rest goes on (§10.5.3). Nothing
 *   to show yet is `available` with no items. Never a guessed hit.
 * - **The read path makes no model call and no embedding call.** A reader
 *   whose profile is not computed yet sees nothing until the composer's next
 *   round computes it; a cached ranking older than six hours, or dropped by a
 *   hide, is recomputed in SQL alone.
 *
 * @module frontierProfiles
 */

import { FRONTIER_SPECIALTIES } from "@evimed/domain";
import { FRONTIER_PHRASE_LIMITS } from "./frontierEditor.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { tsqueryLiteral } from "./kbChunker.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A profile is extracted again after this long even when nothing changed (plan §10.5.3). */
export const FRONTIER_PROFILE_TTL_MS = DAY;
/** A cached ranking is recomputed after this long. */
export const FRONTIER_FOR_YOU_TTL_MS = 6 * HOUR;
/** Readers seen in this long get a profile. */
export const FRONTIER_PROFILE_ACTIVE_MS = 14 * DAY;
/** Items the block shows. */
export const FRONTIER_FOR_YOU_SIZE = 8;
/** Items one phrase may pick: one interest never fills the block. */
export const FRONTIER_FOR_YOU_PER_PHRASE = 2;
/** Candidates ranked, newest first: a few days of published items. */
export const FRONTIER_FOR_YOU_CANDIDATES = 300;
/** The window ranked, and the wider one used when it holds too few candidates. */
export const FRONTIER_FOR_YOU_WINDOW_MS = 72 * HOUR;
export const FRONTIER_FOR_YOU_WIDE_WINDOW_MS = 7 * DAY;
export const FRONTIER_FOR_YOU_MIN_CANDIDATES = 20;
/**
 * Below this cosine a phrase is not a reason: an item near nothing the reader
 * showed interest in is not 「与你相关」. A starting point to be read against the
 * measured distribution, as the selection threshold is.
 */
export const FRONTIER_FOR_YOU_MIN_COSINE = 0.4;
/** The share of the editorial score (out of 100) added to a cosine: 0.1 lifts a 90-point item 0.04 over a 50-point one. */
export const FRONTIER_FOR_YOU_EDITORIAL_SHARE = 0.1;
/**
 * A candidate at least this close to an item the reader hid is dropped: the
 * same story again, or its twin. Uncalibrated — item-to-item cosines of the
 * embedding pin were not measured when it was set; read it against the
 * `hiddenDropped` counter and the reader's hides before moving it.
 */
export const FRONTIER_FOR_YOU_HIDDEN_COSINE = 0.85;
/** The windows the signals are read over. */
export const FRONTIER_PROFILE_QUESTION_WINDOW_MS = 30 * DAY;
export const FRONTIER_PROFILE_ITEM_WINDOW_MS = 60 * DAY;
/** The hides weighed against candidates, most recent first. */
const HIDDEN_LIMIT = 100;
/** Memory kinds that describe what a researcher works on. */
const WORK_KINDS = new Set(["project_fact", "analysis", "decision", "follow_up"]);
/** A failed refresh is not tried again for this long. */
const RETRY_MS = HOUR;
/** The memory store is reported unavailable this long after it last failed. */
const UNAVAILABLE_MS = 15 * MINUTE;
/** How often one reader's opening of the block is written, at most. */
const VISIT_INTERVAL_MS = 10 * MINUTE;
/** Conversation changes remembered as already noted, so a run's every state change is not a write. */
const NOTED_LIMIT = 5_000;
/**
 * What a reader's memory was when a profile read it: how many records, the sum
 * of their versions (every write moves one) and the latest change. Any
 * insert, update, archive or delete moves it; comparing it needs no clock.
 */
const MEMORY_MARK = "count(*)::text || ':' || coalesce(sum(r.version), 0)::text || ':' || coalesce(extract(epoch FROM max(r.updated_at))::text, '')";

// ───────────────────────── pure decisions (unit-tested) ─────────────────────────

/**
 * The memories a profile may be built from, as the model is shown them, in
 * the order given (the store's: by importance). Every provenance counts; run
 * summaries, sensitive and inactive records, and records of a paused or
 * internal project do not.
 * @param {any[]} records `researchMemory.listAllRecords` rows
 * @param {{ pausedProjects?: string[] }} [settings]
 * @returns {Array<{ id: string, kind: string, text: string }>}
 */
export function frontierProfileMemories(records, { pausedProjects = [] } = {}) {
  const paused = new Set(pausedProjects.map(String));
  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === "active" && record?.kind !== "run_summary" && record?.sensitive !== true
      && (record?.scope === "user" || (record?.scope === "project" && !paused.has(String(record.scopeId)) && !isInternalProject(record.scopeId))))
    .map((record) => ({ id: String(record.id), kind: String(record.kind), text: String(record.summary || record.value || "").replace(/\s+/g, " ").trim() }))
    .filter((memory) => memory.text);
}

/**
 * The questions a profile may be read from: the researcher's own
 * conversations since `since` — not deleted, not in a paused or internal
 * project — newest first, each question once, at most 30. A run is read by
 * what was asked; one without a question by its title when a person or the
 * titler gave it one, never by a placeholder.
 * @param {Array<{ projectId: string, run: Record<string, any> }>} entries a researcher's own runs (`isResearcherRun`), by project
 * @param {{ since?: Date, pausedProjects?: string[] }} [options]
 * @returns {Array<{ text: string, at: string }>}
 */
export function frontierProfileQuestions(entries, { since = new Date(0), pausedProjects = [] } = {}) {
  const paused = new Set(pausedProjects.map(String));
  const cutoff = since.getTime();
  const usable = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.run && entry.run.deleted !== true && !isInternalProject(entry.projectId) && !paused.has(String(entry.projectId))
      && Date.parse(String(entry.run.startedAt ?? "")) >= cutoff)
    .sort((left, right) => String(right.run.startedAt).localeCompare(String(left.run.startedAt)));
  const seen = new Set();
  /** @type {Array<{ text: string, at: string }>} */
  const questions = [];
  for (const { run } of usable) {
    const asked = typeof run.question === "string" && run.question.trim() ? run.question
      : (run.titleSource === "user" || run.titleSource === "auto") && typeof run.title === "string" ? run.title : "";
    const text = asked.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    questions.push({ text, at: String(run.startedAt) });
    if (questions.length >= FRONTIER_PHRASE_LIMITS.questions) break;
  }
  return questions;
}

/**
 * What the block says a phrase is to the reader: what they work on, what they
 * asked, or what they follow — by what the phrase came from.
 * @param {{ text: string, kind?: string | null }} phrase
 */
export function frontierReasonText(phrase) {
  const kind = String(phrase.kind ?? "");
  return `${WORK_KINDS.has(kind) ? "因为你在做" : kind === "question" ? "因为你问过" : "因为你关注"}：${phrase.text}`;
}

/**
 * Where a stored phrase or cached entry came from. One written before the
 * other signals existed names only a memory.
 * @param {{ source?: unknown, memoryId?: unknown }} entry @returns {"memory" | "question" | "frontier-item"}
 */
export function frontierPhraseSource(entry) {
  return entry?.source === "question" || entry?.source === "frontier-item" ? entry.source : "memory";
}

/** A vector as stored with a phrase: float32, little-endian, base64. @param {number[]} vector */
export function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

/** @param {unknown} value @param {number} dimension @returns {number[] | null} */
export function decodeVector(value, dimension) {
  if (typeof value !== "string" || !value) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== dimension * 4) return null;
  // Read float by float: a small decoded Buffer is a slice of Node's shared
  // pool, and its offset need not be the multiple of four a Float32Array view
  // over it requires.
  const vector = Array.from({ length: dimension }, (_, index) => bytes.readFloatLE(index * 4));
  return vector.every(Number.isFinite) ? vector : null;
}

/**
 * The block from per-phrase scores. Every (item, phrase) pair at or above the
 * floor is ordered by its score plus `editorial` × the item's editorial score
 * out of 100, and taken greedily: an item once, a phrase at most `perPhrase`
 * times, at most `size` items. An item whose best phrase is full may still
 * come in under its next phrase above the floor — which is how one phrase
 * stops filling the block while each item keeps a reason that holds.
 * @param {Array<{ itemId: string, phrase: number, score: number, weight?: number }>} matches
 * @param {{ minScore?: number, editorial?: number, size?: number, perPhrase?: number }} [options]
 * @returns {Array<{ itemId: string, phrase: number, score: number }>}
 */
export function frontierForYouRanking(matches, { minScore = -Infinity, editorial = 0, size = FRONTIER_FOR_YOU_SIZE,
  perPhrase = FRONTIER_FOR_YOU_PER_PHRASE } = {}) {
  const pairs = matches
    .filter((match) => Number.isFinite(match.score) && match.score >= minScore)
    .map((match) => {
      const weight = Number(match.weight ?? 0) || 0;
      return { itemId: match.itemId, phrase: match.phrase, score: match.score, weight, rank: match.score + editorial * weight / 100 };
    })
    .sort((left, right) => right.rank - left.rank || right.weight - left.weight || left.phrase - right.phrase
      || left.itemId.localeCompare(right.itemId));
  const taken = new Set();
  /** @type {Map<number, number>} */
  const perPhraseTaken = new Map();
  /** @type {Array<{ itemId: string, phrase: number, score: number }>} */
  const ranked = [];
  for (const pair of pairs) {
    if (ranked.length >= size) break;
    if (taken.has(pair.itemId) || (perPhraseTaken.get(pair.phrase) ?? 0) >= perPhrase) continue;
    taken.add(pair.itemId);
    perPhraseTaken.set(pair.phrase, (perPhraseTaken.get(pair.phrase) ?? 0) + 1);
    ranked.push({ itemId: pair.itemId, phrase: pair.phrase, score: pair.score });
  }
  return ranked;
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_profile_failed";
}

// ───────────────────────── profiles ─────────────────────────

export class FrontierProfiles {
  /**
   * @param {{ database: any, researchMemory?: any, editor?: any, embedder?: any, config?: Record<string, any>,
   *           budget?: (() => Promise<{ state: string }>) | null, now?: () => Date, dimension?: number,
   *           conversations?: ((userId: string) => Promise<Array<{ projectId: string, run: Record<string, any> }>>) | null }} options
   *   `researchMemory` the account memory store (`listAllRecords`, `settings`),
   *   `editor` a `FrontierEditor` (`extractProfile`), `embedder` the feed's,
   *   `conversations` a reader's own runs across their projects (the run ledger's
   *   `researcherRuns`, composed in `server.mjs`); without it no question is read.
   */
  constructor({ database, researchMemory = null, editor = null, embedder = null, config = {}, budget = null,
    now = () => new Date(), dimension = 1024, conversations = null }) {
    if (!database) throw new TypeError("The frontier profiles need the product database.");
    this.database = database;
    this.researchMemory = researchMemory;
    this.editor = editor;
    this.embedder = embedder;
    this.config = config ?? {};
    this.budgetReader = budget;
    this.now = now;
    this.conversations = typeof conversations === "function" ? conversations : null;
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || dimension;
    /** @type {Map<string, number>} reader → when their last refresh failed */
    this.failures = new Map();
    /** @type {Map<string, number>} reader → when their opening of the block was last written */
    this.visits = new Map();
    /** @type {Set<string>} conversation changes already marked (`noteConversation`) */
    this.noted = new Set();
    /** @type {number | null} when the memory store last failed */
    this.memoryFailedAt = null;
    /** Observable counters (principle 15). */
    this.counters = { refreshed: 0, empty: 0, paused: 0, failures: 0, ranked: 0, embedded: 0, embedFailures: 0, reasonsDropped: 0, reads: 0,
      staleMarks: 0, staleMarkFailures: 0, visitFailures: 0, questionFailures: 0, hiddenDropped: 0 };
    /** @type {string | null} */
    this.lastError = null;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** Whether this deployment can personalize at all: a memory store to read and a model to read it with. */
  get composed() {
    return Boolean(this.researchMemory?.configured) && this.config.deepseekProviderEnabled === true && Boolean(this.config.deepseekApiKey);
  }

  /** `available`, `unavailable` (the memory store failed lately) or `off` — what `/status` says. */
  state() {
    if (!this.composed) return "off";
    if (this.memoryFailedAt != null && this.now().getTime() - this.memoryFailedAt < UNAVAILABLE_MS) return "unavailable";
    return "available";
  }

  /** @returns {Promise<{ state: string }>} */
  async #budget() {
    if (!this.budgetReader) return { state: "ok" };
    try { return await this.budgetReader(); } catch { return { state: "exhausted" }; }
  }

  /** @param {string} userId @returns {Promise<{ recallPaused: boolean, pausedProjects: string[] }>} */
  async #settings(userId) {
    const settings = typeof this.researchMemory?.settings === "function" ? await this.researchMemory.settings(userId) : null;
    return { recallPaused: settings?.recallPaused === true, pausedProjects: (settings?.pausedProjects ?? []).map(String) };
  }

  /**
   * One round of refreshes (the composer's, every five minutes): profiles
   * whose memory changed are marked, then readers seen in the last 14 days
   * whose profile is missing, a day old or marked — those who opened the block
   * since first — at most `limit`, while a model may be called; then cached
   * rankings older than six hours, or dropped, recomputed in SQL.
   * @param {{ limit?: number, rerankLimit?: number }} [options]
   */
  async refreshDue({ limit = 5, rerankLimit = 20 } = {}) {
    const summary = { refreshed: 0, ranked: 0, skipped: 0 };
    if (!this.composed) return summary;
    await this.ready();
    const now = this.now();
    const active = new Date(now.getTime() - FRONTIER_PROFILE_ACTIVE_MS);
    const audience = this.#audience();
    await this.#markMemoryChanges(active);
    const due = (await this.database.query(`SELECT up.user_id FROM evimed_frontier.user_prefs up
      JOIN evimed_control.users u ON u.id = up.user_id
      LEFT JOIN evimed_frontier.user_profiles pr ON pr.user_id = up.user_id
      WHERE up.last_seen_at >= $1::timestamptz AND ($3::text[] IS NULL OR up.user_id = ANY($3::text[]))
        AND (pr.user_id IS NULL OR pr.computed_at < $2::timestamptz OR pr.inputs_version > pr.computed_inputs_version
          OR (pr.for_you->>'state' = 'off' AND up.for_you_seen_at > pr.computed_at))
      ORDER BY (up.for_you_seen_at IS NOT NULL AND (pr.user_id IS NULL OR up.for_you_seen_at > pr.computed_at)) DESC,
        (pr.inputs_version > pr.computed_inputs_version) DESC NULLS LAST,
        pr.computed_at NULLS FIRST, up.last_seen_at DESC LIMIT 100`,
    [active, new Date(now.getTime() - FRONTIER_PROFILE_TTL_MS), audience])).rows ?? [];
    const budget = due.length ? await this.#budget() : { state: "ok" };
    for (const row of due) {
      if (summary.refreshed >= limit) break;
      const failedAt = this.failures.get(row.user_id);
      if (failedAt && now.getTime() - failedAt < RETRY_MS) { summary.skipped += 1; continue; }
      // Not urgent: like clustering's adjudication and the digests, a profile
      // waits while the day's budget is past 80% (plan §10.3.10).
      if (budget.state !== "ok" || !this.editor?.available) break;
      try {
        await this.refreshUser(row.user_id);
        summary.refreshed += 1;
      } catch (error) {
        this.failures.set(row.user_id, now.getTime());
        this.counters.failures += 1;
        this.lastError = codeOf(error);
      }
    }
    const stale = (await this.database.query(`SELECT pr.user_id FROM evimed_frontier.user_profiles pr
      JOIN evimed_frontier.user_prefs up ON up.user_id = pr.user_id
      WHERE up.last_seen_at >= $1::timestamptz AND jsonb_array_length(pr.phrases) > 0
        AND (pr.for_you_at IS NULL OR pr.for_you_at < $2::timestamptz)
      ORDER BY pr.for_you_at NULLS FIRST LIMIT $3`, [active, new Date(now.getTime() - FRONTIER_FOR_YOU_TTL_MS), rerankLimit])).rows ?? [];
    for (const row of stale) {
      try {
        await this.rank(row.user_id);
        summary.ranked += 1;
      } catch (error) {
        this.counters.failures += 1;
        this.lastError = codeOf(error);
      }
    }
    return summary;
  }

  /** @returns {string[] | null} null = every account */
  #audience() {
    if (this.config.frontierAudience === "all") return null;
    return [...new Set([...(this.config.operatorUsers ?? []), ...(this.config.frontierPreviewUsers ?? [])].map(String))];
  }

  /**
   * Mark the profiles of active readers whose memory changed since it was
   * read: any writer — the extractor after a conversation, the memory page, an
   * import, a delete — moves the mark, so none of them has to call here. A
   * memory store that cannot be read marks nothing and the round goes on.
   * @param {Date} active
   */
  async #markMemoryChanges(active) {
    try {
      const result = await this.database.query(`UPDATE evimed_frontier.user_profiles pr SET inputs_version = pr.inputs_version + 1
        FROM evimed_frontier.user_prefs up
        WHERE up.user_id = pr.user_id AND up.last_seen_at >= $1::timestamptz AND pr.inputs_version <= pr.computed_inputs_version
          AND pr.memory_mark IS DISTINCT FROM (SELECT ${MEMORY_MARK} FROM evimed_memory.records r WHERE r.user_id = pr.user_id)`, [active]);
      this.counters.staleMarks += Number(result?.rowCount ?? 0);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * Something a profile is read from changed: it is due at the next round.
   * Never fails its caller — a mark lost is a profile a day old, not an error.
   * @param {string} userId @param {{ onlyEmpty?: boolean }} [options] `onlyEmpty`: only a profile with no phrase yet
   */
  async #markInputsChanged(userId, { onlyEmpty = false } = {}) {
    try {
      const result = await this.database.query(`UPDATE evimed_frontier.user_profiles SET inputs_version = inputs_version + 1
        WHERE user_id = $1 AND (NOT $2::boolean OR jsonb_array_length(phrases) = 0)`, [userId, onlyEmpty]);
      this.counters.staleMarks += Number(result?.rowCount ?? 0);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * What a reader's action on an item changes for 与我相关, after it
   * committed: a star or an unstar changes what the profile is read from; an
   * item opened does too, but is only worth a new profile while there is none
   * to show — otherwise it waits for the day's; a hide or an unhide changes
   * only which items are left out, so the cached ranking is dropped and the
   * next read or round ranks again in SQL.
   * @param {string} userId @param {string} action `star` | `unstar` | `hide` | `unhide` | `read`
   */
  async noteItemAction(userId, action) {
    if (action === "star" || action === "unstar") return this.#markInputsChanged(userId);
    if (action === "read") return this.#markInputsChanged(userId, { onlyEmpty: true });
    if (action !== "hide" && action !== "unhide") return;
    try {
      await this.database.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [userId]);
    } catch (error) {
      this.counters.staleMarkFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * A researcher's run changed (the run ledger's state signal, composed in
   * `server.mjs` for their own runs of their own projects): a question seen for
   * the first time, or a conversation deleted, marks their profile. Returns at
   * once; the write happens behind it and never fails the ledger's.
   * @param {string} userId @param {{ id?: unknown, question?: unknown, deleted?: unknown }} run
   */
  noteConversation(userId, run) {
    const key = run?.deleted === true ? `${String(run.id)}:deleted` : typeof run?.question === "string" && run.question.trim() ? `${String(run.id)}:asked` : null;
    if (!key || !userId || this.noted.has(key)) return;
    if (this.noted.size >= NOTED_LIMIT) this.noted.clear();
    this.noted.add(key);
    void this.#markInputsChanged(String(userId));
  }

  /**
   * Record that this reader opened the block (`user_prefs.for_you_seen_at`),
   * at most every ten minutes per reader by this process: readers waiting on
   * it are computed first, and one with nothing yet is computed again.
   * @param {string} userId
   */
  async #noteVisit(userId) {
    const at = this.now().getTime();
    const last = this.visits.get(userId);
    if (last != null && at - last < VISIT_INTERVAL_MS) return;
    this.visits.set(userId, at);
    if (this.visits.size > 10_000) this.visits.clear();
    try {
      await this.database.query(`INSERT INTO evimed_frontier.user_prefs (user_id, for_you_seen_at) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET for_you_seen_at = GREATEST(coalesce(evimed_frontier.user_prefs.for_you_seen_at, EXCLUDED.for_you_seen_at),
          EXCLUDED.for_you_seen_at)`, [userId, new Date(at)]);
    } catch (error) {
      this.visits.delete(userId);
      this.counters.visitFailures += 1;
      this.lastError = codeOf(error);
    }
  }

  /**
   * The reader's recent questions. The run ledger is one input among three:
   * a ledger that cannot be read leaves the questions out and the profile is
   * built from the rest (counted, never faked).
   * @param {string} userId @param {string[]} pausedProjects @param {Date} now
   */
  async #questions(userId, pausedProjects, now) {
    if (!this.conversations) return [];
    try {
      return frontierProfileQuestions(await this.conversations(userId),
        { since: new Date(now.getTime() - FRONTIER_PROFILE_QUESTION_WINDOW_MS), pausedProjects });
    } catch (error) {
      this.counters.questionFailures += 1;
      this.lastError = codeOf(error);
      return [];
    }
  }

  /**
   * The items the reader starred or opened in the last 60 days and did not
   * hide since, stars first, newest first, as the titles a reader saw.
   * @param {string} userId @param {Date} now
   * @returns {Promise<Array<{ text: string, starred: boolean }>>}
   */
  async #itemSignals(userId, now) {
    const since = new Date(now.getTime() - FRONTIER_PROFILE_ITEM_WINDOW_MS);
    const rows = (await this.database.query(`SELECT coalesce(nullif(i.title_zh, ''), i.title_raw) AS title, us.starred_at IS NOT NULL AS starred
      FROM evimed_frontier.user_state us JOIN evimed_frontier.items i ON i.id = us.item_id
      WHERE us.user_id = $1 AND us.hidden_at IS NULL AND i.state = 'published'
        AND (us.starred_at >= $2::timestamptz OR us.read_at >= $2::timestamptz)
      ORDER BY (us.starred_at IS NOT NULL) DESC, greatest(us.starred_at, us.read_at) DESC, i.id DESC LIMIT $3`,
    [userId, since, FRONTIER_PHRASE_LIMITS.items])).rows ?? [];
    return rows.map((row) => ({ text: String(row.title ?? "").trim(), starred: row.starred === true })).filter((item) => item.text);
  }

  /** @param {string} userId @returns {Promise<string>} */
  async #memoryMark(userId) {
    const row = (await this.database.query(`SELECT ${MEMORY_MARK} AS mark FROM evimed_memory.records r WHERE r.user_id = $1`, [userId])).rows?.[0];
    return String(row?.mark ?? "");
  }

  /**
   * Read, extract, embed and store one reader's profile, then rank for them.
   * A reader who paused recall, or who has shown nothing the block could use
   * yet, gets an empty profile — the block has nothing for them until that
   * changes, which marks the profile due again.
   * @param {string} userId
   */
  async refreshUser(userId) {
    const now = this.now();
    await this.ready();
    // Read first: a change while this runs moves the version past it, and the
    // profile is due again at the next round.
    const version = Number((await this.database.query(`SELECT inputs_version FROM evimed_frontier.user_profiles WHERE user_id = $1`,
      [userId])).rows?.[0]?.inputs_version ?? 0);
    let settings;
    let records;
    let mark;
    try {
      settings = await this.#settings(userId);
      mark = await this.#memoryMark(userId);
      records = settings.recallPaused ? [] : await this.researchMemory.listAllRecords(userId);
      this.memoryFailedAt = null;
    } catch (error) {
      this.memoryFailedAt = now.getTime();
      throw error;
    }
    const stamp = { now, version, mark };
    if (settings.recallPaused) {
      await this.#store(userId, { specialties: [], phrases: [], forYou: { state: "off", reason: "recall-paused" }, ...stamp });
      this.counters.paused += 1;
      return { state: "off", reason: "recall-paused" };
    }
    const memories = frontierProfileMemories(records, { pausedProjects: settings.pausedProjects });
    const questions = await this.#questions(userId, settings.pausedProjects, now);
    const items = await this.#itemSignals(userId, now);
    if (!memories.length && !questions.length && !items.length) {
      await this.#store(userId, { specialties: [], phrases: [], forYou: { state: "off", reason: "no-signal" }, ...stamp });
      this.counters.empty += 1;
      return { state: "off", reason: "no-signal" };
    }
    const extracted = await this.editor.extractProfile({ memories, questions, items });
    if (extracted.error) throw Object.assign(new Error("The profile could not be extracted."), { code: extracted.error });
    /** @type {Array<{ text: string, source: string, memoryId: string, kind: string, vector?: string }>} */
    const phrases = extracted.phrases.map((/** @type {any} */ phrase) => ({ text: String(phrase.text), source: frontierPhraseSource(phrase),
      memoryId: frontierPhraseSource(phrase) === "memory" ? String(phrase.memoryId ?? "") : "", kind: String(phrase.kind ?? "profile") }))
      .filter((phrase) => phrase.text && (phrase.source !== "memory" || phrase.memoryId));
    const capabilities = await this.ready();
    if (phrases.length && capabilities.vector && this.embedder?.configured) {
      try {
        // A phrase is what the reader is looking for: embedded as a query.
        const vectors = [];
        for (const phrase of phrases) vectors.push(await this.embedder.embedQuery(phrase.text));
        vectors.forEach((vector, index) => {
          if (Array.isArray(vector) && vector.length === this.dimension && vector.every(Number.isFinite)) phrases[index].vector = encodeVector(vector);
        });
        this.counters.embedded += phrases.length;
      } catch {
        // Kept without vectors, ranked by keywords, and said so (`basis: tags`).
        this.counters.embedFailures += 1;
      }
    }
    await this.#store(userId, { specialties: extracted.specialties, phrases, forYou: null, ...stamp });
    this.counters.refreshed += 1;
    if (!phrases.length) return { state: "available", phrases: 0 };
    await this.rank(userId);
    return { state: "available", phrases: phrases.length };
  }

  /**
   * @param {string} userId
   * @param {{ specialties: string[], phrases: any[], forYou: any, now: Date, version: number, mark: string }} profile
   */
  async #store(userId, { specialties, phrases, forYou, now, version, mark }) {
    await this.database.query(`INSERT INTO evimed_frontier.user_profiles
        (user_id, specialties, phrases, for_you, computed_at, for_you_at, computed_inputs_version, memory_mark)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, CASE WHEN $4::jsonb IS NULL THEN NULL ELSE $5::timestamptz END, $6, $7)
      ON CONFLICT (user_id) DO UPDATE SET specialties = EXCLUDED.specialties, phrases = EXCLUDED.phrases, for_you = EXCLUDED.for_you,
        computed_at = EXCLUDED.computed_at, for_you_at = EXCLUDED.for_you_at, computed_inputs_version = EXCLUDED.computed_inputs_version,
        memory_mark = EXCLUDED.memory_mark`,
    [userId, specialties.filter((key) => FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key))), JSON.stringify(phrases),
      forYou == null ? null : JSON.stringify(forYou), now, version, mark]);
  }

  /**
   * The candidates for one reader since `since`: published items of enabled
   * sources, newest first, at most 300 — none the reader hid, starred or
   * opened, none of an event they hid an item of, none from a source or
   * specialty they muted.
   * @param {string} userId @param {Date} since
   * @returns {Promise<Array<{ id: string, public_id: string, weight: number }>>}
   */
  async #candidates(userId, since) {
    return (await this.database.query(`SELECT i.id, i.public_id, coalesce(i.score_total, 0) AS weight
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = $2 AND us.item_id = i.id
          AND (us.hidden_at IS NOT NULL OR us.starred_at IS NOT NULL OR us.read_at IS NOT NULL))
        AND (i.event_id IS NULL OR NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state hs
          JOIN evimed_frontier.items hi ON hi.id = hs.item_id
          WHERE hs.user_id = $2 AND hs.hidden_at IS NOT NULL AND hi.event_id = i.event_id))
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_follows f WHERE f.user_id = $2 AND f.muted
          AND ((f.kind = 'source' AND f.key = i.primary_source_id) OR (f.kind = 'specialty' AND f.key = ANY(i.specialties))))
      ORDER BY i.visible_at DESC, i.id DESC LIMIT ${FRONTIER_FOR_YOU_CANDIDATES}`, [since, userId])).rows ?? [];
  }

  /**
   * The candidates that are the same story as something the reader hid, by
   * meaning: cosine to one of their last hundred hides at least
   * `FRONTIER_FOR_YOU_HIDDEN_COSINE`.
   * @param {string} userId @param {string[]} candidateIds
   * @returns {Promise<Set<string>>}
   */
  async #nearHidden(userId, candidateIds) {
    const hidden = ((await this.database.query(`SELECT item_id FROM evimed_frontier.user_state
      WHERE user_id = $1 AND hidden_at IS NOT NULL ORDER BY hidden_at DESC LIMIT ${HIDDEN_LIMIT}`, [userId])).rows ?? [])
      .map((row) => String(row.item_id));
    if (!hidden.length || !candidateIds.length) return new Set();
    const rows = (await this.database.query(`SELECT DISTINCT v.item_id FROM evimed_frontier.item_vectors v
      JOIN evimed_frontier.item_vectors h ON h.model_key = v.model_key AND h.item_id = ANY($2::bigint[])
      WHERE v.item_id = ANY($1::bigint[]) AND v.model_key = $3 AND 1 - (v.embedding <=> h.embedding) >= $4`,
    [candidateIds, hidden, String(this.embedder.modelKey), FRONTIER_FOR_YOU_HIDDEN_COSINE])).rows ?? [];
    return new Set(rows.map((row) => String(row.item_id)));
  }

  /**
   * Rank the window for one reader from their stored profile and cache it
   * (`user_profiles.for_you`). Never a model call and never an embedding
   * call: the phrase vectors are stored with the profile.
   * @param {string} userId
   */
  async rank(userId) {
    const capabilities = await this.ready();
    const now = this.now();
    const profile = (await this.database.query(`SELECT phrases FROM evimed_frontier.user_profiles WHERE user_id = $1`, [userId])).rows?.[0];
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases : [];
    if (!profile || !phrases.length) return null;
    const vectors = phrases.map((phrase) => decodeVector(phrase.vector, this.dimension));
    const useVectors = Boolean(capabilities.vector && this.embedder?.configured) && vectors.some(Boolean);
    let candidates = await this.#candidates(userId, new Date(now.getTime() - FRONTIER_FOR_YOU_WINDOW_MS));
    if (candidates.length < FRONTIER_FOR_YOU_MIN_CANDIDATES) {
      candidates = await this.#candidates(userId, new Date(now.getTime() - FRONTIER_FOR_YOU_WIDE_WINDOW_MS));
    }
    const ids = candidates.map((row) => String(row.id));
    const weights = new Map(candidates.map((row) => [String(row.id), Number(row.weight)]));
    const publicIds = new Map(candidates.map((row) => [String(row.id), row.public_id]));
    /** @type {Array<{ itemId: string, phrase: number, score: number, weight: number }>} */
    let matches = [];
    let basis = /** @type {"vector" | "tags"} */ ("tags");
    if (useVectors && ids.length) {
      const type = capabilities.halfvec ? "halfvec" : "vector";
      const literals = vectors.map((vector) => (vector ? `[${vector.join(",")}]` : null));
      const indexes = literals.map((literal, index) => (literal ? index : -1)).filter((index) => index >= 0);
      const rows = (await this.database.query(`SELECT v.item_id, p.idx, 1 - (v.embedding <=> p.vec::${type}) AS cosine
        FROM evimed_frontier.item_vectors v
        CROSS JOIN unnest($1::text[], $2::integer[]) AS p(vec, idx)
        WHERE v.item_id = ANY($3::bigint[]) AND v.model_key = $4`,
      [indexes.map((index) => literals[index]), indexes, ids, String(this.embedder.modelKey)])).rows ?? [];
      if (rows.length) {
        basis = "vector";
        const near = await this.#nearHidden(userId, ids);
        this.counters.hiddenDropped += near.size;
        matches = rows.filter((row) => !near.has(String(row.item_id)))
          .map((row) => ({ itemId: String(row.item_id), phrase: Number(row.idx), score: Number(row.cosine), weight: weights.get(String(row.item_id)) ?? 0 }));
      }
    }
    if (basis === "tags" && ids.length) {
      const queries = phrases.map((phrase, index) => ({ index, query: tsqueryLiteral(String(phrase.text ?? "")) })).filter((entry) => entry.query);
      if (queries.length) {
        const rows = (await this.database.query(`SELECT i.id, p.idx, ts_rank(i.lexemes, p.q::tsquery, 1) AS rank
          FROM evimed_frontier.items i CROSS JOIN unnest($1::text[], $2::integer[]) AS p(q, idx)
          WHERE i.id = ANY($3::bigint[]) AND i.lexemes @@ p.q::tsquery`,
        [queries.map((entry) => entry.query), queries.map((entry) => entry.index), ids])).rows ?? [];
        matches = rows.map((row) => ({ itemId: String(row.id), phrase: Number(row.idx), score: Number(row.rank), weight: weights.get(String(row.id)) ?? 0 }));
      }
    }
    // Keyword ranks are not cosines: no floor and no editorial share for
    // them, the editorial score only breaks their ties.
    const ranked = basis === "vector"
      ? frontierForYouRanking(matches, { minScore: FRONTIER_FOR_YOU_MIN_COSINE, editorial: FRONTIER_FOR_YOU_EDITORIAL_SHARE })
      : frontierForYouRanking(matches);
    const items = ranked.map((match) => {
      const phrase = phrases[match.phrase] ?? {};
      const source = frontierPhraseSource(phrase);
      return { itemId: publicIds.get(match.itemId), text: String(phrase.text ?? ""), source,
        memoryId: source === "memory" ? String(phrase.memoryId ?? "") : "", kind: String(phrase.kind ?? "profile") };
    }).filter((entry) => entry.itemId && entry.text && (entry.source !== "memory" || entry.memoryId));
    this.counters.ranked += 1;
    return this.#cache(userId, { state: "available", basis, items }, now);
  }

  /** @param {string} userId @param {{ state: string, basis: string, items: any[] }} forYou @param {Date} now */
  async #cache(userId, forYou, now) {
    const value = { ...forYou, computedAt: now.toISOString() };
    await this.database.query(`UPDATE evimed_frontier.user_profiles SET for_you = $2::jsonb, for_you_at = $3 WHERE user_id = $1`,
      [userId, JSON.stringify(value), now]);
    return value;
  }

  /**
   * The block for one reader (the read path): the cached ranking, recomputed
   * in SQL when older than six hours or dropped, each memory reason checked
   * against the memory it names; items hydrated by `hydrate` (the service's,
   * with the reader's own state), hidden ones left out.
   * @param {{ id: string }} user
   * @param {(user: { id: string }, publicIds: string[]) => Promise<Map<string, any>>} hydrate
   * @returns {Promise<{ state: "available" | "unavailable" | "off", basis: "vector" | "tags" | null, paused?: true,
   *   items: Array<{ item: any, reason: { text: string, topic: string, memoryId: string | null, source: string } }> }>}
   */
  async forYou(user, hydrate) {
    this.counters.reads += 1;
    const deployment = this.state();
    if (deployment === "off") return { state: "off", basis: null, items: [] };
    await this.ready();
    await this.#noteVisit(user.id);
    let settings;
    try {
      settings = await this.#settings(user.id);
    } catch {
      this.memoryFailedAt = this.now().getTime();
      return { state: "unavailable", basis: null, items: [] };
    }
    // The reader's own switch holds now, not at the next refresh.
    if (settings.recallPaused) return { state: "off", basis: null, paused: true, items: [] };
    const profile = (await this.database.query(`SELECT phrases, for_you, for_you_at FROM evimed_frontier.user_profiles WHERE user_id = $1`,
      [user.id])).rows?.[0];
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases : [];
    let forYou = profile?.for_you ?? null;
    const stale = !profile?.for_you_at || this.now().getTime() - new Date(profile.for_you_at).getTime() > FRONTIER_FOR_YOU_TTL_MS;
    if (phrases.length && (stale || forYou?.state !== "available")) forYou = await this.rank(user.id);
    const entries = forYou?.state === "available" && Array.isArray(forYou.items) ? forYou.items : [];
    // Nothing yet — no profile, nothing to read one from, nothing in the
    // window — is not a state of its own: the next round may have something.
    if (!entries.length) return { state: deployment, basis: forYou?.basis ?? null, items: [] };
    const remembered = [...new Set(entries.filter((/** @type {any} */ entry) => frontierPhraseSource(entry) === "memory")
      .map((/** @type {any} */ entry) => String(entry.memoryId)))];
    /** @type {Set<string>} */
    let alive = new Set();
    if (remembered.length) {
      try {
        // A memory of a project paused since is no reason any more.
        const rows = (await this.database.query(`SELECT id FROM evimed_memory.records WHERE user_id = $1 AND id = ANY($2::text[]) AND status = 'active'
            AND (scope <> 'project' OR NOT (scope_id = ANY($3::text[])))`, [user.id, remembered, settings.pausedProjects])).rows ?? [];
        alive = new Set(rows.map((row) => String(row.id)));
      } catch {
        // The memory store cannot say whether a reason still stands: no reason
        // is shown rather than one that may no longer be true.
        this.memoryFailedAt = this.now().getTime();
        return { state: "unavailable", basis: null, items: [] };
      }
    }
    const kept = entries.filter((/** @type {any} */ entry) => frontierPhraseSource(entry) !== "memory" || alive.has(String(entry.memoryId)));
    this.counters.reasonsDropped += entries.length - kept.length;
    const items = await hydrate(user, kept.map((/** @type {any} */ entry) => String(entry.itemId)));
    return {
      state: "available",
      basis: forYou?.basis === "vector" ? "vector" : "tags",
      items: kept.flatMap((/** @type {any} */ entry) => {
        const item = items.get(String(entry.itemId));
        if (!item || item.state?.hidden) return [];
        const source = frontierPhraseSource(entry);
        // `topic` is the phrase alone — what 「与我相关」 groups by and heads a
        // group with (plan 2026-09-23 §6.2), without the 「因为你在做」 before it.
        return [{ item, reason: { text: frontierReasonText({ text: String(entry.text), kind: entry.kind }), topic: String(entry.text),
          memoryId: source === "memory" ? String(entry.memoryId) : null, source } }];
      }).slice(0, FRONTIER_FOR_YOU_SIZE),
    };
  }

  status() {
    return { state: this.state(), lastError: this.lastError, counters: { ...this.counters } };
  }
}
