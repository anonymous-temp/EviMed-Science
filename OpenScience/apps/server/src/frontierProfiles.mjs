/**
 * 「与你相关」: the frontier feed's per-reader ranking (plan §4.6, §6.5, §10.5.3).
 *
 * Content is written once for everyone; personalization only re-orders what
 * is already written. Once a day per active reader, a profile is extracted from
 * the reader's own memory — specialties and at most ten interest phrases, each
 * naming the memory it came from — and the phrases are embedded. Every six
 * hours at most, the last 72 hours of published items are ranked against it,
 * and the top five are cached with the phrase that picked each: that phrase,
 * and the memory it points at, is the 「因为你……」 the reader sees.
 *
 * Hidden knowledge:
 *
 * - **Only what the reader said or confirmed.** A memory feeds the profile
 *   when it is active and its provenance is stated, confirmed or edited by its
 *   owner (principle 18: an inference never becomes a fact on its own). Run
 *   summaries, sensitive records, records of a project the reader paused and
 *   of the platform's own internal projects are left out; so is everything
 *   when the reader paused recall — for them the block is off.
 * - **The memory is read, never written.** Follows and 「不感兴趣」 live in the
 *   module's own tables; this module writes only `user_profiles`.
 * - **A reason is re-checked when it is read.** A memory the reader deleted or
 *   archived since the ranking was cached takes its reason with it at once:
 *   the item is dropped rather than shown with a reason that no longer exists.
 *   The reader's switches are read then too: recall paused since turns the
 *   block off at once, and a paused project's memory is no reason.
 * - **Ranking is vectors, not the rerank service** (§10.5.3): the rerank
 *   service returns an order without scores, so it cannot say which phrase
 *   matched. The phrases are embedded when the profile is refreshed (a dozen
 *   short texts, stored with it) and the cosine to each candidate item's vector
 *   is computed in the database; the best phrase is the reason. The candidates
 *   are a coarse SQL cut first — the last 72 hours, a specialty or a
 *   glossary entity in common, not hidden, not from a muted source or
 *   specialty, at most 32 by score.
 * - **Without vectors it says so.** No embedder, no pgvector, or no phrase
 *   vector: the phrases are matched as keywords against the items' own search
 *   lexemes, and the answer's `basis` is `tags` — never a ranking that
 *   pretends to be semantic.
 * - **States, honestly.** `off`: this deployment has no memory store or no
 *   model to read it with, or this reader paused recall or has said nothing the
 *   block could use — the block is absent. `unavailable`: the memory store
 *   failed when it was last read — the page says 「暂时不可用」 and the rest goes
 *   on (§10.5.3). Never a guessed hit.
 * - **The read path makes no model call and no embedding call.** A reader
 *   whose profile is not computed yet sees nothing until the composer's next
 *   round computes it (within minutes of their first visit); a cached ranking
 *   older than six hours is recomputed in SQL alone.
 *
 * @module frontierProfiles
 */

import { FRONTIER_SPECIALTIES } from "@evimed/domain";
import { FrontierGlossaryStore } from "./frontierGlossary.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { tsqueryLiteral } from "./kbChunker.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A profile is extracted again after this long (plan §10.5.3: once a day). */
export const FRONTIER_PROFILE_TTL_MS = DAY;
/** A cached ranking is recomputed after this long. */
export const FRONTIER_FOR_YOU_TTL_MS = 6 * HOUR;
/** Readers seen in this long get a profile. */
export const FRONTIER_PROFILE_ACTIVE_MS = 14 * DAY;
/** Items the block shows. */
export const FRONTIER_FOR_YOU_SIZE = 5;
/** The coarse cut's size (the rerank service's limit, which the plan sized it by). */
export const FRONTIER_FOR_YOU_CANDIDATES = 32;
/** The window ranked. */
export const FRONTIER_FOR_YOU_WINDOW_MS = 72 * HOUR;
/**
 * Below this cosine a phrase is not a reason: an item near nothing the reader
 * said is not 「与你相关」. A starting point to be read against the measured
 * distribution, as the selection threshold is.
 */
export const FRONTIER_FOR_YOU_MIN_COSINE = 0.4;
/** Memory kinds that describe what a researcher works on. */
const WORK_KINDS = new Set(["project_fact", "analysis", "decision", "follow_up"]);
/** Provenance a memory must have to feed a profile. */
const OWN_BASES = new Set(["stated", "confirmed", "edited"]);
/** A failed refresh is not tried again for this long. */
const RETRY_MS = HOUR;
/** The memory store is reported unavailable this long after it last failed. */
const UNAVAILABLE_MS = 15 * MINUTE;

// ───────────────────────── pure decisions (unit-tested) ─────────────────────────

/**
 * The memories a profile may be built from, as the model is shown them.
 * @param {any[]} records `researchMemory.listAllRecords` rows
 * @param {{ pausedProjects?: string[] }} [settings]
 * @returns {Array<{ id: string, kind: string, text: string }>}
 */
export function frontierProfileMemories(records, { pausedProjects = [] } = {}) {
  const paused = new Set(pausedProjects.map(String));
  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === "active" && record?.kind !== "run_summary" && record?.sensitive !== true
      && OWN_BASES.has(String(record?.provenance?.basis ?? ""))
      && (record?.scope === "user" || (record?.scope === "project" && !paused.has(String(record.scopeId)) && !isInternalProject(record.scopeId))))
    .map((record) => ({ id: String(record.id), kind: String(record.kind), text: String(record.summary || record.value || "").replace(/\s+/g, " ").trim() }))
    .filter((memory) => memory.text);
}

/**
 * What the block says a phrase is to the reader: what they work on, or what
 * they follow — by the kind of memory the phrase came from.
 * @param {{ text: string, kind?: string | null }} phrase
 */
export function frontierReasonText(phrase) {
  return `${WORK_KINDS.has(String(phrase.kind ?? "")) ? "因为你在做" : "因为你关注"}：${phrase.text}`;
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
 * The top items and their reasons from per-phrase scores: each item's best
 * phrase, items by that score, at most five, an item only once.
 * @param {Array<{ itemId: string, phrase: number, score: number, weight?: number }>} matches
 * @param {{ minScore?: number }} [options]
 * @returns {Array<{ itemId: string, phrase: number, score: number }>}
 */
export function frontierForYouRanking(matches, { minScore = -Infinity } = {}) {
  /** @type {Map<string, { itemId: string, phrase: number, score: number, weight: number }>} */
  const best = new Map();
  for (const match of matches) {
    if (!(match.score >= minScore)) continue;
    const seen = best.get(match.itemId);
    if (!seen || match.score > seen.score || (match.score === seen.score && match.phrase < seen.phrase)) {
      best.set(match.itemId, { itemId: match.itemId, phrase: match.phrase, score: match.score, weight: Number(match.weight ?? 0) });
    }
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score || right.weight - left.weight || left.itemId.localeCompare(right.itemId))
    .slice(0, FRONTIER_FOR_YOU_SIZE)
    .map(({ itemId, phrase, score }) => ({ itemId, phrase, score }));
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_profile_failed";
}

// ───────────────────────── profiles ─────────────────────────

export class FrontierProfiles {
  /**
   * @param {{ database: any, researchMemory?: any, editor?: any, embedder?: any, glossary?: any, config?: Record<string, any>,
   *           budget?: (() => Promise<{ state: string }>) | null, now?: () => Date, dimension?: number }} options
   *   `researchMemory` the account memory store (`listAllRecords`, `settings`),
   *   `editor` a `FrontierEditor` (`extractProfile`), `embedder` the feed's.
   */
  constructor({ database, researchMemory = null, editor = null, embedder = null, glossary = null, config = {}, budget = null,
    now = () => new Date(), dimension = 1024 }) {
    if (!database) throw new TypeError("The frontier profiles need the product database.");
    this.database = database;
    this.researchMemory = researchMemory;
    this.editor = editor;
    this.embedder = embedder;
    this.config = config ?? {};
    this.budgetReader = budget;
    this.now = now;
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || dimension;
    this.glossaryStore = glossary && typeof glossary.current === "function" ? glossary : new FrontierGlossaryStore({ database });
    /** @type {Map<string, number>} reader → when their last refresh failed */
    this.failures = new Map();
    /** @type {number | null} when the memory store last failed */
    this.memoryFailedAt = null;
    /** Observable counters (principle 15). */
    this.counters = { refreshed: 0, empty: 0, paused: 0, failures: 0, ranked: 0, embedded: 0, embedFailures: 0, reasonsDropped: 0, reads: 0 };
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

  /**
   * One round of refreshes (the composer's): readers seen in the last 14 days
   * whose profile is missing or a day old, at most `limit`, while a model may
   * be called; then cached rankings older than six hours for readers seen in
   * that time, recomputed in SQL.
   * @param {{ limit?: number, rerankLimit?: number }} [options]
   */
  async refreshDue({ limit = 5, rerankLimit = 20 } = {}) {
    const summary = { refreshed: 0, ranked: 0, skipped: 0 };
    if (!this.composed) return summary;
    await this.ready();
    const now = this.now();
    const active = new Date(now.getTime() - FRONTIER_PROFILE_ACTIVE_MS);
    const audience = this.#audience();
    const due = (await this.database.query(`SELECT up.user_id FROM evimed_frontier.user_prefs up
      JOIN evimed_control.users u ON u.id = up.user_id
      LEFT JOIN evimed_frontier.user_profiles pr ON pr.user_id = up.user_id
      WHERE up.last_seen_at >= $1::timestamptz AND (pr.user_id IS NULL OR pr.computed_at < $2::timestamptz)
        AND ($3::text[] IS NULL OR up.user_id = ANY($3::text[]))
      ORDER BY pr.computed_at NULLS FIRST, up.last_seen_at DESC LIMIT 100`,
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
   * Extract, embed and store one reader's profile, then rank for them. A
   * reader who paused recall, or whose memory holds nothing the block could
   * use, gets an empty profile — the block is off for them until that changes
   * (the next day's refresh reads again).
   * @param {string} userId
   */
  async refreshUser(userId) {
    const now = this.now();
    let settings;
    let records;
    try {
      settings = typeof this.researchMemory?.settings === "function" ? await this.researchMemory.settings(userId) : { recallPaused: false, pausedProjects: [] };
      records = settings?.recallPaused ? [] : await this.researchMemory.listAllRecords(userId);
      this.memoryFailedAt = null;
    } catch (error) {
      this.memoryFailedAt = now.getTime();
      throw error;
    }
    const memories = frontierProfileMemories(records, { pausedProjects: settings?.pausedProjects ?? [] });
    const off = settings?.recallPaused ? "recall-paused" : memories.length ? null : "no-memory";
    if (off) {
      await this.#store(userId, { specialties: [], phrases: [], forYou: { state: "off", reason: off }, now });
      this.counters[off === "recall-paused" ? "paused" : "empty"] += 1;
      return { state: "off", reason: off };
    }
    const extracted = await this.editor.extractProfile({ memories });
    if (extracted.error) throw Object.assign(new Error("The profile could not be extracted."), { code: extracted.error });
    const kinds = new Map(memories.map((memory) => [memory.id, memory.kind]));
    /** @type {Array<{ text: string, memoryId: string, kind: string, vector?: string }>} */
    const phrases = extracted.phrases.map((phrase) => ({ text: phrase.text, memoryId: phrase.memoryId, kind: kinds.get(phrase.memoryId) ?? "profile" }));
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
    await this.#store(userId, { specialties: extracted.specialties, phrases, forYou: null, now });
    this.counters.refreshed += 1;
    if (!phrases.length) return { state: "available", phrases: 0 };
    await this.rank(userId);
    return { state: "available", phrases: phrases.length };
  }

  /** @param {string} userId @param {{ specialties: string[], phrases: any[], forYou: any, now: Date }} profile */
  async #store(userId, { specialties, phrases, forYou, now }) {
    await this.database.query(`INSERT INTO evimed_frontier.user_profiles (user_id, specialties, phrases, for_you, computed_at, for_you_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, CASE WHEN $4::jsonb IS NULL THEN NULL ELSE $5::timestamptz END)
      ON CONFLICT (user_id) DO UPDATE SET specialties = EXCLUDED.specialties, phrases = EXCLUDED.phrases, for_you = EXCLUDED.for_you,
        computed_at = EXCLUDED.computed_at, for_you_at = EXCLUDED.for_you_at`,
    [userId, specialties.filter((key) => FRONTIER_SPECIALTIES.includes(/** @type {any} */ (key))), JSON.stringify(phrases),
      forYou == null ? null : JSON.stringify(forYou), now]);
  }

  /**
   * Rank the last 72 hours for one reader from their stored profile and cache
   * it (`user_profiles.for_you`). Never a model call and never an embedding
   * call: the phrase vectors are stored with the profile.
   * @param {string} userId
   */
  async rank(userId) {
    const capabilities = await this.ready();
    const now = this.now();
    const profile = (await this.database.query(`SELECT specialties, phrases FROM evimed_frontier.user_profiles WHERE user_id = $1`, [userId])).rows?.[0];
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases : [];
    if (!profile || !phrases.length) return null;
    const glossary = await this.glossaryStore.current();
    const entityKeys = [...new Set(phrases.flatMap((phrase) => glossary.match(String(phrase.text ?? ""))
      .map((/** @type {any} */ entry) => glossary.entityKey(entry.kind, entry.termEn)).filter(Boolean)))];
    const specialties = Array.isArray(profile.specialties) ? profile.specialties : [];
    const vectors = phrases.map((phrase) => decodeVector(phrase.vector, this.dimension));
    const useVectors = Boolean(capabilities.vector && this.embedder?.configured) && vectors.some(Boolean);
    const since = new Date(now.getTime() - FRONTIER_FOR_YOU_WINDOW_MS);
    // The coarse cut (§10.5.3): a specialty or an entity in common. With the
    // vectors to rank by and nothing to cut with, the day's best stand in.
    const overlap = specialties.length || entityKeys.length;
    if (!overlap && !useVectors) return this.#cache(userId, { state: "available", basis: "tags", items: [] }, now);
    const candidates = (await this.database.query(`SELECT i.id, i.public_id, coalesce(i.score_total, 0) AS weight
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND i.visible_at >= $1::timestamptz
        AND (NOT $2::boolean OR i.specialties && $3::text[] OR i.entity_keys && $4::text[])
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_state us WHERE us.user_id = $5 AND us.item_id = i.id AND us.hidden_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM evimed_frontier.user_follows f WHERE f.user_id = $5 AND f.muted
          AND ((f.kind = 'source' AND f.key = i.primary_source_id) OR (f.kind = 'specialty' AND f.key = ANY(i.specialties))))
      ORDER BY coalesce(i.score_total, 0) DESC, i.visible_at DESC, i.id DESC LIMIT ${FRONTIER_FOR_YOU_CANDIDATES}`,
    [since, Boolean(overlap), specialties, entityKeys, userId])).rows ?? [];
    const weights = new Map(candidates.map((row) => [String(row.id), Number(row.weight)]));
    const publicIds = new Map(candidates.map((row) => [String(row.id), row.public_id]));
    /** @type {Array<{ itemId: string, phrase: number, score: number, weight: number }>} */
    let matches = [];
    let basis = /** @type {"vector" | "tags"} */ ("tags");
    if (useVectors && candidates.length) {
      const type = capabilities.halfvec ? "halfvec" : "vector";
      const literals = vectors.map((vector) => (vector ? `[${vector.join(",")}]` : null));
      const indexes = literals.map((literal, index) => (literal ? index : -1)).filter((index) => index >= 0);
      const rows = (await this.database.query(`SELECT v.item_id, p.idx, 1 - (v.embedding <=> p.vec::${type}) AS cosine
        FROM evimed_frontier.item_vectors v
        CROSS JOIN unnest($1::text[], $2::integer[]) AS p(vec, idx)
        WHERE v.item_id = ANY($3::bigint[]) AND v.model_key = $4`,
      [indexes.map((index) => literals[index]), indexes, candidates.map((row) => String(row.id)), String(this.embedder.modelKey)])).rows ?? [];
      if (rows.length) {
        basis = "vector";
        matches = rows.map((row) => ({ itemId: String(row.item_id), phrase: Number(row.idx), score: Number(row.cosine), weight: weights.get(String(row.item_id)) ?? 0 }))
          .filter((match) => match.score >= FRONTIER_FOR_YOU_MIN_COSINE);
      }
    }
    if (basis === "tags" && candidates.length) {
      const queries = phrases.map((phrase, index) => ({ index, query: tsqueryLiteral(String(phrase.text ?? "")) })).filter((entry) => entry.query);
      if (queries.length) {
        const rows = (await this.database.query(`SELECT i.id, p.idx, ts_rank(i.lexemes, p.q::tsquery, 1) AS rank
          FROM evimed_frontier.items i CROSS JOIN unnest($1::text[], $2::integer[]) AS p(q, idx)
          WHERE i.id = ANY($3::bigint[]) AND i.lexemes @@ p.q::tsquery`,
        [queries.map((entry) => entry.query), queries.map((entry) => entry.index), candidates.map((row) => String(row.id))])).rows ?? [];
        matches = rows.map((row) => ({ itemId: String(row.id), phrase: Number(row.idx), score: Number(row.rank), weight: weights.get(String(row.id)) ?? 0 }));
      }
    }
    const ranked = frontierForYouRanking(matches);
    const items = ranked.map((match) => ({
      itemId: publicIds.get(match.itemId), text: String(phrases[match.phrase]?.text ?? ""), memoryId: String(phrases[match.phrase]?.memoryId ?? ""),
      kind: String(phrases[match.phrase]?.kind ?? "profile"),
    })).filter((entry) => entry.itemId && entry.text && entry.memoryId);
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
   * in SQL when older than six hours, each reason checked against the memory
   * it names; items hydrated by `hydrate` (the service's, with the reader's
   * own state), hidden ones left out.
   * @param {{ id: string }} user
   * @param {(user: { id: string }, publicIds: string[]) => Promise<Map<string, any>>} hydrate
   * @returns {Promise<{ state: "available" | "unavailable" | "off", basis: "vector" | "tags" | null, items: Array<{ item: any, reason: { text: string, memoryId: string } }> }>}
   */
  async forYou(user, hydrate) {
    this.counters.reads += 1;
    const deployment = this.state();
    if (deployment === "off") return { state: "off", basis: null, items: [] };
    await this.ready();
    const profile = (await this.database.query(`SELECT phrases, for_you, for_you_at FROM evimed_frontier.user_profiles WHERE user_id = $1`,
      [user.id])).rows?.[0];
    if (!profile) return { state: deployment, basis: null, items: [] };
    let forYou = profile.for_you;
    if (forYou?.state === "off") return { state: "off", basis: null, items: [] };
    const stale = !profile.for_you_at || this.now().getTime() - new Date(profile.for_you_at).getTime() > FRONTIER_FOR_YOU_TTL_MS;
    if ((stale || !forYou) && Array.isArray(profile.phrases) && profile.phrases.length) forYou = await this.rank(user.id);
    const entries = Array.isArray(forYou?.items) ? forYou.items : [];
    if (!entries.length) return { state: deployment, basis: forYou?.basis ?? null, items: [] };
    /** @type {Set<string>} */
    let alive;
    try {
      // The reader's own switches hold now, not at tomorrow's refresh: recall
      // paused since the ranking was cached turns the block off, and a memory
      // of a project paused since is no reason any more.
      const settings = typeof this.researchMemory?.settings === "function"
        ? await this.researchMemory.settings(user.id) : { recallPaused: false, pausedProjects: [] };
      if (settings?.recallPaused) return { state: "off", basis: null, items: [] };
      const rows = (await this.database.query(`SELECT id FROM evimed_memory.records WHERE user_id = $1 AND id = ANY($2::text[]) AND status = 'active'
          AND (scope <> 'project' OR NOT (scope_id = ANY($3::text[])))`,
      [user.id, [...new Set(entries.map((entry) => String(entry.memoryId)))], (settings?.pausedProjects ?? []).map(String)])).rows ?? [];
      alive = new Set(rows.map((row) => String(row.id)));
    } catch {
      // The memory store cannot say whether a reason still stands: no reason
      // is shown rather than one that may no longer be true.
      this.memoryFailedAt = this.now().getTime();
      return { state: "unavailable", basis: null, items: [] };
    }
    const kept = entries.filter((entry) => alive.has(String(entry.memoryId)));
    this.counters.reasonsDropped += entries.length - kept.length;
    const items = await hydrate(user, kept.map((entry) => String(entry.itemId)));
    return {
      state: "available",
      basis: forYou?.basis === "vector" ? "vector" : "tags",
      items: kept.flatMap((entry) => {
        const item = items.get(String(entry.itemId));
        if (!item || item.state?.hidden) return [];
        return [{ item, reason: { text: frontierReasonText({ text: String(entry.text), kind: entry.kind }), memoryId: String(entry.memoryId) } }];
      }).slice(0, FRONTIER_FOR_YOU_SIZE),
    };
  }

  status() {
    return { state: this.state(), lastError: this.lastError, counters: { ...this.counters } };
  }
}
