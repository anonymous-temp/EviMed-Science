/**
 * The frontier feed's event layer (「前沿动态」 事件、热点, plan §4.4, §6.4,
 * §10.3.1 steps 11–13, §14.8 #1–#5).
 *
 * An event is one thing that happened — a trial's results, a label change, a
 * guideline — and every report of it: the paper, the regulator's notice, the
 * media coverage. Items are clustered into events after they are published,
 * the hot list ranks events, and an event page shows the first-hand sources
 * above the reports.
 *
 * Clustering, from the certain to the uncertain (plan §6.4):
 *
 *   1. identifiers — an item that shares a registry id with an item already in
 *      an event joins that event (`reg:<id>` cluster keys, `item_keys`);
 *   2. vectors — an item that shares a drug, trial or organisation with a
 *      clustered item of the last seven days and whose vector is within cosine
 *      0.82 of it joins that item's event. The cosine is computed exactly over
 *      that small candidate set, never through the HNSW index: a filtered
 *      approximate search can miss the one candidate that matters;
 *   3. the model — pairs between 0.72 and 0.82 are asked 「是不是同一件事」
 *      (at most three per item); `yes` joins, `related` becomes an edge.
 *
 * Hidden knowledge:
 *
 * - **Every item gets an event, and most events are one item.** A singleton is
 *   an event like any other: the hot list admits an event with one reporting
 *   entity when that entity is a regulator's primary source (plan §6.4), and a
 *   later report of the same thing joins it. A card links to its event only
 *   when the event holds more than one report (`frontierService.mjs`): a link
 *   that says 「同一事件的全部报道」 over one report would be a false promise.
 * - **An item waits for what clustering reads.** An item published title-only
 *   (at peak, past 80% of the budget) has no entities until its edit, and a
 *   fresh item has no vector until the pipeline's next round. An item is
 *   clustered once its edit is done (or 24 hours have passed without one) and
 *   its vector exists (or 30 minutes have passed, or there are no vectors in
 *   this deployment). Items older than seven days are not clustered at all.
 * - **A bridge merges.** When one item is the same thing as two events, the two
 *   are one event: the older survives, the other's public id goes into
 *   `event_aliases` and its row keeps `merged_into`, so every old link answers
 *   308 to the survivor (inbox items, stars, Feishu cards, drafts). Members,
 *   edges and earlier aliases move with it; chains are flattened, so a
 *   redirect is one hop.
 * - **Heat is a decayed sum over owner entities, not feeds** (plan §6.4,
 *   §11.6): each independent operating entity reporting contributes its
 *   authority weight (authority / 5) × 2^(−age / 36 h), age of its latest
 *   report; ×1.3 when both Chinese and English sources report it, ×1.5 when it
 *   holds a primary source. No age cap: the window is the decay, so a safety
 *   signal reported for two weeks stays on the list while it is reported.
 *   Heat is never shown (plan §4.4) — only rank and the two counts.
 * - **Three counts** (§14.8 #4): independent entities in the last 72 hours,
 *   every report over the event's life, distinct entities over its life. The
 *   page shows the first two.
 * - **A digest is earned** (§14.8 #5): written for an event on the hot list or
 *   one holding a primary source with at least two reports — a digest of one
 *   report would restate its card — and rewritten when a new primary arrives.
 *   A report that is not primary marks the digest stale and updates 「最新进展」
 *   (the newest report's own title, by code); the old digest stays until a
 *   primary makes a rewrite worth a call. A failed digest keeps the previous
 *   one (plan §10.3.1 step 12).
 * - **Model calls are the editor's** (metered under purpose `frontier`, the
 *   module's budget): adjudication and digests run only while the day's budget
 *   is `ok`, never throttled or exhausted — neither is urgent.
 * - **Serialized by one advisory lock.** Clustering applies each decision, and
 *   the hot list recomputes its counts, under the same lock (a merge touches
 *   several events, the hot list rewrites hundreds), so neither ever holds the
 *   other's rows in the opposite order. No model call is ever made while a
 *   lock or a transaction is held.
 *
 * @module frontierEvents
 */

import { randomBytes } from "node:crypto";
import { bumpFrontierVersion, FRONTIER_META_KEYS, migrateFrontier } from "./frontierPersistence.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Half-life of an entity's contribution to heat (plan §4.4). */
export const FRONTIER_HEAT_HALF_LIFE_HOURS = 36;
/** The window the independent-source count and hot eligibility read. */
export const FRONTIER_EVENT_WINDOW_MS = 72 * HOUR;
/** Clustering compares an item with clustered items this far back. */
export const FRONTIER_CLUSTER_WINDOW_MS = 7 * DAY;
/** Cosine at or above which two items are one event without asking. */
export const FRONTIER_CLUSTER_JOIN_COSINE = 0.82;
/** Cosine from which a pair is worth asking the model about. */
export const FRONTIER_CLUSTER_ASK_COSINE = 0.72;
/** Pairs asked per item. */
export const FRONTIER_CLUSTER_ASK_MAX = 3;
/** Events on the hot list. */
export const FRONTIER_HOT_SIZE = 10;
/** A fresh item waits this long for its vector before it is clustered without one. */
export const FRONTIER_VECTOR_GRACE_MS = 30 * MINUTE;
/** An item still owed its edit waits this long for its entities. */
export const FRONTIER_EDIT_GRACE_MS = DAY;
/** Reports a digest call is shown (the editor bounds its text as well). */
const DIGEST_REPORTS = 12;
/** A digest that failed is not asked for again for this long. */
const DIGEST_RETRY_MS = 6 * HOUR;
/** Candidates the vector step reads at most, newest first. */
const VECTOR_CANDIDATES = 500;
const PUBLIC_ID = /^[a-z0-9]{12,32}$/;
const CLUSTER_LOCK = "evimed-frontier-cluster";
/** Entity kinds that make two items candidates (plan §6.4): diseases are too broad. */
const CLUSTER_ENTITY_PREFIXES = Object.freeze(["drug:", "trial:", "org:"]);
/** How an item link reads as an edge between the two items' events: the direction is from → to. */
const LINK_RELATIONS = Object.freeze({
  "preprint-of": { relation: "preprint-of", reverse: false },
  retraction: { relation: "retracted-by", reverse: true },
  withdrawal: { relation: "retracted-by", reverse: true },
  correction: { relation: "corrected-by", reverse: true },
  "new-version": { relation: "supersedes", reverse: false },
  "expression-of-concern": { relation: "related", reverse: true },
});

// ───────────────────────── pure decisions (unit-tested) ─────────────────────────

/**
 * What an item is in an event (plan §4.4: 「一手来源」 is the party's own text —
 * the paper, the regulator's notice, the label, the guideline). A journal's
 * comment or editorial is background; a company's press release and media
 * coverage are reports.
 * @param {{ sourceType?: string | null, evidenceType?: string | null }} item
 * @returns {"primary" | "report" | "background"}
 */
export function frontierEventRole({ sourceType, evidenceType }) {
  if (sourceType === "journal") return evidenceType === "review-opinion" ? "background" : "primary";
  if (sourceType === "preprint" || sourceType === "regulator") return "primary";
  if (sourceType === "evidence-body") {
    return ["guideline", "systematic-review", "regulatory-decision", "safety-notice"].includes(String(evidenceType)) ? "primary" : "report";
  }
  return "report";
}

/**
 * What kind of first-hand material an event holds, for 「含原始论文」「含官方公告」:
 * a regulator's text first, then a guideline, then a paper. `label` is part
 * of the vocabulary the page reads and is not produced yet: nothing in the
 * registry marks a source as a label source, and a guess from its name would
 * be a regex doing language.
 * @param {Array<{ role: string, sourceType?: string | null, evidenceType?: string | null }>} members
 * @returns {"official" | "guideline" | "paper" | null}
 */
export function frontierPrimaryKind(members) {
  const primaries = members.filter((member) => member.role === "primary");
  if (primaries.some((member) => member.sourceType === "regulator" && member.evidenceType !== "guideline")) return "official";
  if (primaries.some((member) => member.evidenceType === "guideline")) return "guideline";
  if (primaries.length) return "paper";
  return null;
}

/**
 * @typedef {{ role: string, ownerEntity: string, authority: number, timelineAt: string | Date, lang?: string | null,
 *             sourceType?: string | null, evidenceType?: string | null, selected?: boolean, safetyAlert?: boolean,
 *             scoreTotal?: number | null }} FrontierEventMember
 */

/**
 * The three counts and the facts heat and eligibility read, from an event's
 * visible members.
 * @param {{ members: FrontierEventMember[], now: Date }} input
 */
export function frontierEventCounts({ members, now }) {
  const since = now.getTime() - FRONTIER_EVENT_WINDOW_MS;
  const entities = new Set();
  const recent = new Set();
  let firstAt = Infinity;
  let lastAt = -Infinity;
  for (const member of members) {
    const at = new Date(member.timelineAt).getTime();
    const entity = String(member.ownerEntity || "");
    entities.add(entity);
    if (at >= since) recent.add(entity);
    firstAt = Math.min(firstAt, at);
    lastAt = Math.max(lastAt, at);
  }
  const languages = new Set(members.map((member) => String(member.lang ?? "")));
  return {
    sourceCount72h: recent.size,
    reportCount: members.length,
    entityCount: entities.size,
    hasPrimary: members.some((member) => member.role === "primary"),
    regulatorPrimary: members.some((member) => member.role === "primary" && member.sourceType === "regulator"),
    // A regulator's own notice that is itself major: selected with a score of
    // at least FRONTIER_HOT_SOLO_SCORE (plan §6.3, §6.4).
    selectedRegulatorPrimary: members.some((member) => member.role === "primary" && member.sourceType === "regulator" && member.selected === true
      && Number(member.scoreTotal ?? 0) >= FRONTIER_HOT_SOLO_SCORE),
    bilingual: languages.has("zh") && languages.has("en"),
    firstAt: Number.isFinite(firstAt) ? new Date(firstAt) : null,
    lastAt: Number.isFinite(lastAt) ? new Date(lastAt) : null,
  };
}

/**
 * Decayed heat (plan §6.4): each owner entity's authority weight (1–5 → 0.2–1)
 * × 2^(−hours since its latest report / 36); ×1.3 bilingual; ×1.5 with a
 * primary source. A report dated in the future counts as now.
 * @param {{ members: FrontierEventMember[], now: Date }} input
 * @returns {number}
 */
export function frontierEventHeat({ members, now }) {
  /** @type {Map<string, { authority: number, at: number }>} */
  const byEntity = new Map();
  for (const member of members) {
    const entity = String(member.ownerEntity || "");
    const at = new Date(member.timelineAt).getTime();
    const authority = Math.min(5, Math.max(1, Number(member.authority) || 1));
    const seen = byEntity.get(entity);
    byEntity.set(entity, { authority: Math.max(seen?.authority ?? 0, authority), at: Math.max(seen?.at ?? -Infinity, at) });
  }
  let heat = 0;
  for (const { authority, at } of byEntity.values()) {
    const hours = Math.max(0, now.getTime() - at) / HOUR;
    heat += (authority / 5) * 2 ** (-hours / FRONTIER_HEAT_HALF_LIFE_HOURS);
  }
  const counts = frontierEventCounts({ members, now });
  if (counts.bilingual) heat *= 1.3;
  if (counts.hasPrimary) heat *= 1.5;
  return heat;
}

/**
 * The score a regulator's notice needs to be hot on its own, with no second
 * source reporting it. Selection alone was not enough: in the first
 * production hours (2026-09-22) nine of the ten hot events were single notices
 * — an administrative-forms circular, an EPAR revision — because a feed of
 * official sources selects many of them and few events had a second report
 * yet. A 热点 is what several sources report; one source is enough only for a
 * notice scored in the top band (9 of 1,160 items then). Not for a safety
 * alert as such: it already has the page's own rail, and on the next hot run
 * five single device and drug recalls filled five of nine places — a recall
 * that many sources report is hot by the two-source rule anyway.
 */
export const FRONTIER_HOT_SOLO_SCORE = 85;

/**
 * Whether an event may be on the hot list (plan §6.4): two independent
 * entities reported it in the last 72 hours, or one when it holds a
 * regulator's primary source that is itself major — selected and scored at
 * least FRONTIER_HOT_SOLO_SCORE. The plan's "one is enough
 * for a regulator" was meant for an approval or a withdrawal; on the first
 * live run it let EMA's routine EPAR revisions fill the whole list.
 * @param {{ sourceCount72h: number, selectedRegulatorPrimary?: boolean }} counts
 */
export function frontierHotEligible({ sourceCount72h, selectedRegulatorPrimary = false }) {
  return sourceCount72h >= 2 || (sourceCount72h >= 1 && selectedRegulatorPrimary);
}

/**
 * The hot list: eligible events by heat, then the latest report, then the
 * lower id; at most ten.
 * @template {{ id: number | string, heat: number, lastAt: Date | string | null, eligible: boolean }} T
 * @param {T[]} events @returns {T[]}
 */
export function frontierRankHot(events) {
  return events.filter((event) => event.eligible)
    .sort((left, right) => right.heat - left.heat
      || new Date(right.lastAt ?? 0).getTime() - new Date(left.lastAt ?? 0).getTime()
      || Number(left.id) - Number(right.id))
    .slice(0, FRONTIER_HOT_SIZE);
}

/**
 * The keys that tie an item to others of one trial: `reg:<ID>` for each
 * registry id, and the bare id of an event-level `reg:` identity.
 * @param {{ registry_ids?: unknown, identity_key?: unknown, source_type?: unknown }} item @returns {string[]}
 */
export function frontierClusterKeys(item) {
  const keys = new Set();
  const registered = (Array.isArray(item?.registry_ids) ? item.registry_ids : [])
    .map((id) => String(id ?? "").trim().toUpperCase()).filter(Boolean);
  // A story that names several trials is writing *about* them: its registry
  // ids are mentions, not its identity. One column naming five NCT numbers
  // pulled a results posting of an unrelated trial into it by identifier
  // (2026-09-22, `f765b9db907eba1d`). A registry's own entry, a journal's
  // paper or a regulator's notice keeps every id it states.
  const mentions = MENTION_SOURCE_TYPES.has(String(item?.source_type ?? "")) && registered.length >= 2;
  if (!mentions) for (const value of registered) keys.add(`reg:${value}`);
  const identity = /^reg:([^:]+):/.exec(String(item?.identity_key ?? ""));
  if (identity) keys.add(`reg:${identity[1].trim().toUpperCase()}`);
  return [...keys];
}

/**
 * Whether two items state their own, different, work identities (a DOI or a
 * PMID each). @param {any} item @param {any} other
 */
export function otherWork(item, other) {
  const value = (/** @type {unknown} */ raw) => String(raw ?? "").trim().toLowerCase();
  const doi = [value(item?.doi), value(other?.doi)];
  const pmid = [value(item?.pmid), value(other?.pmid)];
  if (doi[0] && doi[1] && doi[0] !== doi[1]) return true;
  return Boolean(pmid[0] && pmid[1] && pmid[0] !== pmid[1]);
}

/** Source types whose items write about registrations rather than being one. */
const MENTION_SOURCE_TYPES = new Set(["media", "company"]);

/** An item's entity keys that make candidates. @param {unknown} keys @returns {string[]} */
export function frontierClusterEntities(keys) {
  return (Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && CLUSTER_ENTITY_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

/**
 * The vector step's reading of the candidates: which events are the same by
 * cosine alone, and which pairs to ask about (the best candidate of each
 * other event in the band, or above it from the same publisher; at most three).
 * @param {Array<{ eventId: string, cosine: number, samePublisher?: boolean, otherWork?: boolean }>} candidates
 * @returns {{ strong: string[], ask: Array<{ eventId: string, cosine: number, index: number }> }}
 */
export function frontierVectorReading(candidates) {
  const ordered = candidates.map((candidate, index) => ({ ...candidate, index }))
    .filter((candidate) => Number.isFinite(candidate.cosine))
    .sort((left, right) => right.cosine - left.cosine || left.index - right.index);
  // One publisher's templated notices — 「EMA 对 X 给出正面意见」 for seven
  // different medicines, two biosimilars' EPAR revisions — sit above the join
  // cosine because the template is most of the text; the vector joined them
  // into single events in production (2026-09-22, 4 wrong merges of 25). Two
  // notices of one publisher are the same event only if the model says so.
  // Two works that each state their own identity — a DOI, a PMID — and state
  // different ones are two works: a paper and the editorial on it belong to
  // one event, two Cochrane protocols on one topic do not, and only the model
  // can tell those apart (2026-09-22, `246a1c2a0b4df84f`). Identity decides
  // before similarity does; the cosine only proposes.
  const joins = (/** @type {any} */ candidate) => candidate.cosine >= FRONTIER_CLUSTER_JOIN_COSINE
    && candidate.samePublisher !== true && candidate.otherWork !== true;
  const strong = [...new Set(ordered.filter(joins).map((candidate) => candidate.eventId))];
  const ask = [];
  const seen = new Set(strong);
  for (const candidate of ordered) {
    if (joins(candidate) || candidate.cosine < FRONTIER_CLUSTER_ASK_COSINE || seen.has(candidate.eventId)) continue;
    seen.add(candidate.eventId);
    ask.push(candidate);
    if (ask.length >= FRONTIER_CLUSTER_ASK_MAX) break;
  }
  return { strong, ask };
}

/**
 * Where an item goes: the events it is the same as (by identifier, by cosine,
 * by the model's `yes`), the one of them that survives — the oldest — and the
 * events it is only related to.
 *
 * Only a first-hand item folds two events into one. A daily column covers
 * several stories in one piece — Novo's capital-markets day, an ADHD
 * read-out, a depression trial's results — and matching all three, it used to
 * fuse them (2026-09-22, `f765b9db907eba1d`). Reporting on several events is
 * what a report does: it joins the oldest of them and the rest become edges.
 * @param {{ identifier: string[], strong: string[], yes: string[], related: string[],
 *           events: Map<string, { firstAt: Date | string, id: string }>, role?: string }} input
 * @returns {{ target: string | null, merge: string[], related: string[], joinedBy: "identifier" | "vector" | "model" | null }}
 */
export function frontierClusterDecision({ identifier, strong, yes, related, events, role = "primary" }) {
  const same = [...new Set([...identifier, ...strong, ...yes])].filter((id) => events.has(id));
  if (!same.length) return { target: null, merge: [], related: [...new Set(related)].filter((id) => events.has(id)), joinedBy: null };
  same.sort((left, right) => {
    const a = /** @type {any} */ (events.get(left));
    const b = /** @type {any} */ (events.get(right));
    return new Date(a.firstAt).getTime() - new Date(b.firstAt).getTime() || Number(a.id) - Number(b.id);
  });
  const [target, ...rest] = same;
  const merge = role === "primary" ? rest : [];
  const alsoRelated = role === "primary" ? [] : rest;
  // How the item itself was matched, by its strongest evidence: an item that
  // bridged a vector match into an older identifier match joined by identifier.
  const joinedBy = identifier.some((id) => events.has(id)) ? "identifier" : strong.some((id) => events.has(id)) ? "vector" : "model";
  return { target, merge,
    related: [...new Set([...related, ...alsoRelated])].filter((id) => events.has(id) && id !== target && !merge.includes(id)), joinedBy };
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_events_failed";
}

/** An event's title from one of its reports: the Chinese title, else the original. @param {any} item */
function eventTitle(item) {
  const text = String(item?.title_zh || item?.title_raw || "").replace(/\s+/g, " ").trim();
  return [...text].slice(0, 200).join("");
}

/** A report's own words for 「最新进展」: its Chinese title, else its original. @param {any} item */
function latestText(item) {
  const text = String(item?.title_zh || item?.title_raw || "").replace(/\s+/g, " ").trim();
  return [...text].length > 80 ? `${[...text].slice(0, 79).join("")}…` : text;
}

/** @param {unknown} value */
const iso = (value) => (value == null ? null : new Date(/** @type {any} */ (value)).toISOString());

// ───────────────────────── the event layer ─────────────────────────

export class FrontierEvents {
  /**
   * @param {{ database: any, editor?: any, embedder?: any, config?: Record<string, any>, now?: () => Date,
   *           budget?: (() => Promise<{ state: string }>) | null, dimension?: number }} options
   *   `editor` a `FrontierEditor` (adjudication and digests; optional),
   *   `embedder` the pipeline's (its `modelKey` names the vectors compared),
   *   `budget` the pipeline's reading of the day's spend.
   */
  constructor({ database, editor = null, embedder = null, config = {}, now = () => new Date(), budget = null, dimension = 1024 }) {
    if (!database) throw new TypeError("The frontier event layer needs the product database.");
    this.database = database;
    this.editor = editor;
    this.embedder = embedder;
    this.config = config ?? {};
    this.now = now;
    this.budgetReader = budget;
    // The width the pipeline and the service migrate with: a migration asked
    // for another width empties the vector table.
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || dimension;
    /** @type {Map<string, number>} event id → when its last digest attempt failed */
    this.digestFailures = new Map();
    /** Observable counters (principle 15). */
    this.counters = {
      clustered: 0, created: 0, joined: 0, merged: 0, relatedLinks: 0, identifierLinks: 0, adjudicated: 0, adjudicationSkipped: 0,
      adjudicationFailures: 0, hotRuns: 0, hotChanges: 0, digestsWritten: 0, digestsDropped: 0, digestsSkipped: 0,
    };
    /** @type {{ at: string, ranking: any[] } | null} */
    this.lastHot = null;
    /** @type {string | null} */
    this.lastError = null;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /** Whether a model call may be made now: an editor with an owner, and the day's budget untouched. */
  async #modelAllowed() {
    if (!this.editor?.available) return false;
    if (!this.budgetReader) return true;
    try {
      return (await this.budgetReader()).state === "ok";
    } catch {
      return false;
    }
  }

  // ───────────────────────── clustering ─────────────────────────

  /**
   * One bounded round of clustering: published items without an event, oldest
   * first, each placed in an event (made when none fits).
   * @param {{ limit?: number }} [options]
   */
  async clusterPending({ limit = 25 } = {}) {
    const capabilities = await this.ready();
    const now = this.now();
    const summary = { clustered: 0, created: 0, joined: 0, merged: 0, skipped: 0 };
    const vectors = Boolean(capabilities.vector && this.embedder?.configured);
    const modelKey = vectors ? String(this.embedder.modelKey) : null;
    /** @type {any[]} */
    const values = [new Date(now.getTime() - FRONTIER_CLUSTER_WINDOW_MS), new Date(now.getTime() - FRONTIER_EDIT_GRACE_MS), limit];
    // Without pgvector there is no vector table to name, even in a branch
    // that would never be taken: the clause exists only where the table does.
    const vectorWait = vectors ? `AND (i.visible_at < $${values.push(new Date(now.getTime() - FRONTIER_VECTOR_GRACE_MS))}::timestamptz
          OR EXISTS (SELECT 1 FROM evimed_frontier.item_vectors v WHERE v.item_id = i.id AND v.model_key = $${values.push(modelKey)}))` : "";
    const rows = (await this.database.query(`SELECT i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.lane, i.lang,
        i.source_type, i.evidence_type, i.identity_key, i.registry_ids, i.entity_keys, i.published_at, i.timeline_at, i.visible_at,
        s.name AS source_name, s.owner_entity AS owner_entity
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND i.event_id IS NULL AND i.visible_at >= $1::timestamptz
        AND (i.verification <> 'pending' OR i.visible_at < $2::timestamptz) ${vectorWait}
      ORDER BY i.visible_at, i.id LIMIT $3`, values)).rows ?? [];
    if (!rows.length) return summary;
    const allowModel = await this.#modelAllowed();
    for (const item of rows) {
      try {
        const outcome = await this.#clusterOne(item, { now, modelKey, allowModel });
        // Skipped: another round placed it first; it is not counted twice.
        if (outcome === "skipped") { summary.skipped += 1; continue; }
        summary.clustered += 1;
        if (outcome === "created") summary.created += 1;
        else summary.joined += 1;
        if (outcome === "merged") summary.merged += 1;
      } catch (error) {
        // One item that cannot be placed stays without an event and is tried
        // again next round; the rest of the round goes on.
        this.lastError = codeOf(error);
        summary.skipped += 1;
      }
    }
    for (const key of /** @type {const} */ (["clustered", "created", "joined", "merged"])) this.counters[key] += summary[key];
    return summary;
  }

  /**
   * @param {any} item @param {{ now: Date, modelKey: string | null, allowModel: boolean }} context
   * @returns {Promise<"created" | "joined" | "merged" | "skipped">}
   */
  async #clusterOne(item, { now, modelKey, allowModel }) {
    const identifier = await this.#identifierEvents(item);
    const candidates = modelKey ? await this.#vectorCandidates(item, modelKey, now) : [];
    const reading = frontierVectorReading(candidates.map((candidate) => ({ eventId: candidate.eventId, cosine: candidate.cosine,
      samePublisher: candidate.samePublisher, otherWork: candidate.otherWork })));
    /** @type {string[]} */
    const yes = [];
    /** @type {string[]} */
    const related = [];
    const asked = reading.ask.filter((pair) => !identifier.includes(pair.eventId));
    if (asked.length) {
      if (allowModel) {
        const judged = await this.editor.judgeSameEvent({
          report: { sourceName: item.source_name, titleRaw: item.title_raw, titleZh: item.title_zh, summaryZh: item.summary_zh, publishedAt: iso(item.published_at) },
          candidates: asked.map((pair) => {
            const candidate = candidates[pair.index];
            return { sourceName: candidate.sourceName, titleRaw: candidate.titleRaw, titleZh: candidate.titleZh, summaryZh: candidate.summaryZh, publishedAt: candidate.publishedAt };
          }),
        });
        this.counters.adjudicated += asked.length;
        if (judged.verdicts) {
          judged.verdicts.forEach((verdict, index) => {
            if (verdict === "yes") yes.push(asked[index].eventId);
            else if (verdict === "related") related.push(asked[index].eventId);
          });
        } else this.counters.adjudicationFailures += 1;
      } else this.counters.adjudicationSkipped += asked.length;
    }
    return this.#apply(item, { identifier, strong: reading.strong, yes, related }, now);
  }

  /** Events of the items this one shares a registry id with. @param {any} item @returns {Promise<string[]>} */
  async #identifierEvents(item) {
    const keys = frontierClusterKeys(item);
    if (!keys.length) return [];
    const rows = (await this.database.query(`SELECT DISTINCT i.event_id FROM evimed_frontier.item_keys k
      JOIN evimed_frontier.items i ON i.id = k.item_id
      WHERE k.key = ANY($1::text[]) AND k.item_id <> $2 AND i.event_id IS NOT NULL AND i.state = 'published'`, [keys, item.id])).rows ?? [];
    return rows.map((row) => String(row.event_id));
  }

  /**
   * Clustered items of the last seven days that share a drug, trial or
   * organisation with this one, with their exact cosine to it.
   * @param {any} item @param {string} modelKey @param {Date} now
   */
  async #vectorCandidates(item, modelKey, now) {
    const entities = frontierClusterEntities(item.entity_keys);
    if (!entities.length) return [];
    const since = new Date(new Date(item.timeline_at).getTime() - FRONTIER_CLUSTER_WINDOW_MS);
    const rows = (await this.database.query(`SELECT i.id, i.event_id, i.title_raw, i.title_zh, i.summary_zh, i.published_at, s.name AS source_name,
        s.owner_entity AS owner_entity, i.doi AS doi, i.pmid AS pmid, 1 - (v.embedding <=> own.embedding) AS cosine
      FROM evimed_frontier.items i
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      JOIN evimed_frontier.item_vectors v ON v.item_id = i.id AND v.model_key = $2
      CROSS JOIN (SELECT embedding FROM evimed_frontier.item_vectors WHERE item_id = $1 AND model_key = $2) own
      WHERE i.state = 'published' AND i.id <> $1 AND i.event_id IS NOT NULL
        AND i.timeline_at >= $3::timestamptz AND i.timeline_at <= $4::timestamptz AND i.entity_keys && $5::text[]
      ORDER BY i.timeline_at DESC, i.id DESC LIMIT ${VECTOR_CANDIDATES}`, [item.id, modelKey, since, now, entities])).rows ?? [];
    return rows.map((row) => ({
      itemId: String(row.id), eventId: String(row.event_id), cosine: Number(row.cosine),
      samePublisher: Boolean(item.owner_entity) && row.owner_entity === item.owner_entity,
      otherWork: otherWork(item, row),
      sourceName: row.source_name, titleRaw: row.title_raw, titleZh: row.title_zh, summaryZh: row.summary_zh, publishedAt: iso(row.published_at),
    }));
  }

  /**
   * Place one item, under the clustering lock: the events named are read again
   * (a merge since may have absorbed one — its survivor is used), the survivor
   * absorbs the others, the item joins it, and the edges are written.
   * @param {any} item @param {{ identifier: string[], strong: string[], yes: string[], related: string[] }} found @param {Date} now
   * @returns {Promise<"created" | "joined" | "merged" | "skipped">}
   */
  async #apply(item, found, now) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CLUSTER_LOCK]);
      const current = (await client.query(`SELECT id, event_id, state FROM evimed_frontier.items WHERE id = $1 FOR UPDATE`, [item.id])).rows?.[0];
      if (!current || current.state !== "published" || current.event_id != null) return "skipped";
      const named = [...new Set([...found.identifier, ...found.strong, ...found.yes, ...found.related])];
      const events = await this.#resolveEvents(client, named);
      const survivorOf = (/** @type {string} */ id) => events.get(id)?.id ?? null;
      const role = frontierEventRole({ sourceType: item.source_type, evidenceType: item.evidence_type });
      const decision = frontierClusterDecision({
        role,
        identifier: found.identifier.map(survivorOf).filter(/** @returns {id is string} */ (id) => Boolean(id)),
        strong: found.strong.map(survivorOf).filter(/** @returns {id is string} */ (id) => Boolean(id)),
        yes: found.yes.map(survivorOf).filter(/** @returns {id is string} */ (id) => Boolean(id)),
        related: found.related.map(survivorOf).filter(/** @returns {id is string} */ (id) => Boolean(id)),
        events: new Map([...events.values()].map((event) => [event.id, event])),
      });
      let target = decision.target;
      let outcome = /** @type {"created" | "joined" | "merged"} */ ("joined");
      if (!target) {
        const created = (await client.query(`INSERT INTO evimed_frontier.events (public_id, title_zh, latest_zh, lane, entity_keys,
            first_at, last_at, has_primary, heat_updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING id`,
        [randomBytes(8).toString("hex"), eventTitle(item), latestText(item), item.lane,
          item.entity_keys ?? [], item.timeline_at, role === "primary", now])).rows[0];
        target = String(created.id);
        outcome = "created";
      } else {
        for (const absorbed of decision.merge) {
          await this.#mergeInto(client, target, absorbed, now);
          outcome = "merged";
        }
      }
      await client.query(`INSERT INTO evimed_frontier.event_items (event_id, item_id, role, joined_by) VALUES ($1, $2, $3, $4)
        ON CONFLICT (item_id) DO NOTHING`, [target, item.id, role, decision.joinedBy ?? "identifier"]);
      await client.query("UPDATE evimed_frontier.items SET event_id = $2 WHERE id = $1", [item.id, target]);
      if (outcome !== "created") {
        // The newest report is 「最新进展」 until a digest says it better; a
        // written digest no longer covers every report.
        await client.query(`UPDATE evimed_frontier.events SET latest_zh = $2,
            digest_state = CASE WHEN digest_state = 'written' THEN 'stale' ELSE digest_state END
          WHERE id = $1 AND $3::timestamptz >= last_at`, [target, latestText(item), item.timeline_at]);
      }
      for (const other of decision.related) {
        if (other === target) continue;
        const inserted = await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by)
          VALUES ($1, $2, 'related', 'model') ON CONFLICT DO NOTHING`, [target, other]);
        this.counters.relatedLinks += inserted.rowCount ?? 0;
      }
      await this.#linkFromItemLinks(client, item.id, target);
      await this.#refresh(client, [target], now);
      // A card's 「同一事件的全部报道」 appears, or its event's title moves: a
      // change every reader of the lists can see.
      if (outcome !== "created") await bumpFrontierVersion(client, FRONTIER_META_KEYS.contentVersion);
      return outcome;
    });
  }

  /**
   * The events these ids name, each resolved to its survivor and locked. A
   * merge flattens chains, so a survivor is one hop away; the bound is a guard.
   * @param {any} client @param {string[]} ids
   * @returns {Promise<Map<string, { id: string, firstAt: Date, publicId: string }>>} named id → survivor
   */
  async #resolveEvents(client, ids) {
    /** @type {Map<string, { id: string, firstAt: Date, publicId: string }>} */
    const resolved = new Map();
    for (const id of [...new Set(ids)].sort((left, right) => Number(left) - Number(right))) {
      let current = id;
      for (let hop = 0; hop < 5; hop += 1) {
        const row = (await client.query(`SELECT id, public_id, merged_into, first_at FROM evimed_frontier.events WHERE id = $1 FOR UPDATE`,
          [current])).rows?.[0];
        if (!row) break;
        if (row.merged_into == null) {
          resolved.set(id, { id: String(row.id), firstAt: row.first_at, publicId: row.public_id });
          break;
        }
        current = String(row.merged_into);
      }
    }
    return resolved;
  }

  /**
   * Fold one event into another (plan §6.4, §14.8 #1): members, aliases and
   * edges move; the absorbed row stays, `merged_into` the survivor, its
   * public id an alias, so every old link still opens.
   * @param {any} client @param {string} survivorId @param {string} absorbedId @param {Date} now
   */
  async #mergeInto(client, survivorId, absorbedId, now) {
    if (survivorId === absorbedId) return;
    await client.query("UPDATE evimed_frontier.event_items SET event_id = $1 WHERE event_id = $2", [survivorId, absorbedId]);
    await client.query("UPDATE evimed_frontier.items SET event_id = $1 WHERE event_id = $2", [survivorId, absorbedId]);
    await client.query(`INSERT INTO evimed_frontier.event_aliases (public_id, event_id)
      SELECT public_id, $1 FROM evimed_frontier.events WHERE id = $2
      ON CONFLICT (public_id) DO UPDATE SET event_id = EXCLUDED.event_id`, [survivorId, absorbedId]);
    await client.query("UPDATE evimed_frontier.event_aliases SET event_id = $1 WHERE event_id = $2", [survivorId, absorbedId]);
    await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by, linked_at)
      SELECT moved.from_id, moved.to_id, moved.relation, moved.asserted_by, moved.linked_at FROM (
        SELECT CASE WHEN from_event_id = $2 THEN $1 ELSE from_event_id END AS from_id,
               CASE WHEN to_event_id = $2 THEN $1 ELSE to_event_id END AS to_id, relation, asserted_by, linked_at
        FROM evimed_frontier.event_links WHERE from_event_id = $2 OR to_event_id = $2) moved
      WHERE moved.from_id <> moved.to_id
      ON CONFLICT (from_event_id, to_event_id, relation) DO NOTHING`, [survivorId, absorbedId]);
    await client.query("DELETE FROM evimed_frontier.event_links WHERE from_event_id = $1 OR to_event_id = $1", [absorbedId]);
    // What was folded into the absorbed event before now points at the survivor: one hop.
    await client.query("UPDATE evimed_frontier.events SET merged_into = $1 WHERE merged_into = $2", [survivorId, absorbedId]);
    // A digest the survivor lacks is carried over, marked stale: the next
    // primary source rewrites it from every report.
    await client.query(`UPDATE evimed_frontier.events s SET digest_zh = a.digest_zh, digest_state = 'stale'
      FROM evimed_frontier.events a WHERE s.id = $1 AND a.id = $2 AND s.digest_zh IS NULL AND a.digest_zh IS NOT NULL`, [survivorId, absorbedId]);
    await client.query(`UPDATE evimed_frontier.events SET digest_state = CASE WHEN digest_state = 'written' THEN 'stale' ELSE digest_state END,
      updated_at = clock_timestamp() WHERE id = $1`, [survivorId]);
    await client.query(`UPDATE evimed_frontier.events SET merged_into = $1, merged_at = $3, status = 'settled', source_count_72h = 0,
      heat = 0, updated_at = clock_timestamp() WHERE id = $2`, [survivorId, absorbedId, now]);
    this.counters.merged += 1;
  }

  /**
   * Edges from the item links that touch this item (plan §10.3.9): a preprint
   * and its published version, a work and its retraction, correction or new
   * version — when both ends are items in two different events.
   * @param {any} client @param {string | number} itemId @param {string} eventId
   */
  async #linkFromItemLinks(client, itemId, eventId) {
    const rows = (await client.query(`SELECT l.kind, l.from_item_id, l.to_item_id, fi.event_id AS from_event, ti.event_id AS to_event
      FROM evimed_frontier.item_links l
      JOIN evimed_frontier.items fi ON fi.id = l.from_item_id
      JOIN evimed_frontier.items ti ON ti.id = l.to_item_id
      WHERE l.from_item_id = $1 OR l.to_item_id = $1`, [itemId])).rows ?? [];
    for (const row of rows) {
      const mapping = /** @type {Record<string, { relation: string, reverse: boolean }>} */ (LINK_RELATIONS)[row.kind];
      if (!mapping) continue;
      const fromEvent = String(row.from_item_id) === String(itemId) ? eventId : row.from_event == null ? null : String(row.from_event);
      const toEvent = String(row.to_item_id) === String(itemId) ? eventId : row.to_event == null ? null : String(row.to_event);
      if (!fromEvent || !toEvent || fromEvent === toEvent) continue;
      const [from, to] = mapping.reverse ? [toEvent, fromEvent] : [fromEvent, toEvent];
      const inserted = await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by)
        VALUES ($1, $2, $3, 'identifier') ON CONFLICT DO NOTHING`, [from, to, mapping.relation]);
      this.counters.identifierLinks += inserted.rowCount ?? 0;
    }
  }

  /**
   * The visible members of these events, with what heat and the counts read.
   * @param {any} client @param {string[]} eventIds
   * @returns {Promise<Map<string, any[]>>}
   */
  async #members(client, eventIds) {
    const rows = (await client.query(`SELECT ei.event_id, ei.role, i.id AS item_id, i.timeline_at, i.lang, i.lane, i.title_zh, i.title_raw,
        i.entity_keys, i.source_type, i.evidence_type, i.selected, i.safety_alert, i.score_total, s.owner_entity, s.authority
      FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE ei.event_id = ANY($1::bigint[]) AND i.state = 'published' AND s.enabled
      ORDER BY i.timeline_at, i.id`, [eventIds])).rows ?? [];
    /** @type {Map<string, any[]>} */
    const byEvent = new Map(eventIds.map((id) => [String(id), []]));
    for (const row of rows) byEvent.get(String(row.event_id))?.push(row);
    return byEvent;
  }

  /** @param {any[]} rows @returns {FrontierEventMember[]} */
  #asMembers(rows) {
    return rows.map((row) => ({ role: row.role, ownerEntity: row.owner_entity, authority: Number(row.authority), timelineAt: row.timeline_at,
      lang: row.lang, sourceType: row.source_type, evidenceType: row.evidence_type, selected: row.selected === true,
      safetyAlert: row.safety_alert === true, scoreTotal: row.score_total == null ? null : Number(row.score_total) }));
  }

  /**
   * Recompute an event from its visible members: title (its first primary
   * source's, else its first report's), lane, entities, the three counts,
   * heat, the time span and the status.
   * @param {any} client @param {string[]} eventIds @param {Date} now
   */
  async #refresh(client, eventIds, now) {
    const byEvent = await this.#members(client, eventIds);
    for (const [eventId, rows] of byEvent) {
      if (!rows.length) {
        await client.query(`UPDATE evimed_frontier.events SET report_count = 0, source_count_72h = 0, entity_count = 0, has_primary = false,
          heat = 0, heat_updated_at = $2, status = 'settled', updated_at = clock_timestamp() WHERE id = $1`, [eventId, now]);
        continue;
      }
      const members = this.#asMembers(rows);
      const counts = frontierEventCounts({ members, now });
      const lead = rows.find((row) => row.role === "primary") ?? rows[0];
      const keys = [...new Set(rows.flatMap((row) => Array.isArray(row.entity_keys) ? row.entity_keys : []))].slice(0, 64);
      await client.query(`UPDATE evimed_frontier.events SET title_zh = $2, lane = $3, entity_keys = $4, source_count_72h = $5, report_count = $6,
          entity_count = $7, has_primary = $8, heat = $9, heat_updated_at = $10, first_at = $11, last_at = $12,
          status = CASE WHEN $12::timestamptz < $13::timestamptz THEN 'settled' ELSE 'developing' END, updated_at = clock_timestamp()
        WHERE id = $1`, [eventId, eventTitle(lead), lead.lane, keys, counts.sourceCount72h,
        counts.reportCount, counts.entityCount, counts.hasPrimary, frontierEventHeat({ members, now }), now, counts.firstAt, counts.lastAt,
        new Date(now.getTime() - FRONTIER_EVENT_WINDOW_MS)]);
    }
  }

  // ───────────────────────── hot list ─────────────────────────

  /**
   * The hot list (plan §6.4, every ten minutes): heat and counts of every
   * event reported in the last 72 hours recomputed, older ones settled, the
   * eligible ranked, a snapshot written, and `meta.hot_version` moved when
   * the list a reader sees changed.
   */
  async computeHot() {
    await this.ready();
    const now = this.now();
    const result = await this.database.transaction(async (/** @type {any} */ client) => {
      // The clustering lock: both rewrite events' counts, and one lock means
      // they never hold each other's rows in opposite orders.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CLUSTER_LOCK]);
      const cut = new Date(now.getTime() - FRONTIER_EVENT_WINDOW_MS);
      await client.query(`UPDATE evimed_frontier.events SET status = 'settled', source_count_72h = 0, updated_at = clock_timestamp()
        WHERE merged_into IS NULL AND status = 'developing' AND last_at < $1::timestamptz`, [cut]);
      const candidates = (await client.query(`SELECT id, public_id, last_at FROM evimed_frontier.events
        WHERE merged_into IS NULL AND last_at >= $1::timestamptz`, [cut])).rows ?? [];
      const byEvent = await this.#members(client, candidates.map((row) => String(row.id)));
      /** @type {Array<{ id: string, publicId: string, heat: number, lastAt: Date | null, eligible: boolean, sourceCount72h: number, reportCount: number }>} */
      const scored = [];
      for (const row of candidates) {
        const members = this.#asMembers(byEvent.get(String(row.id)) ?? []);
        const counts = frontierEventCounts({ members, now });
        const heat = members.length ? frontierEventHeat({ members, now }) : 0;
        scored.push({ id: String(row.id), publicId: row.public_id, heat, lastAt: counts.lastAt ?? row.last_at,
          eligible: members.length > 0 && frontierHotEligible(counts), sourceCount72h: counts.sourceCount72h, reportCount: counts.reportCount });
      }
      if (scored.length) {
        await client.query(`UPDATE evimed_frontier.events e SET heat = u.heat, heat_updated_at = $5, source_count_72h = u.recent,
            report_count = u.reports, updated_at = clock_timestamp()
          FROM unnest($1::bigint[], $2::float8[], $3::integer[], $4::integer[]) AS u(id, heat, recent, reports) WHERE e.id = u.id`,
        [scored.map((event) => event.id), scored.map((event) => event.heat), scored.map((event) => event.sourceCount72h),
          scored.map((event) => event.reportCount), now]);
      }
      const previous = (await client.query(`SELECT ranking FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1`)).rows?.[0]?.ranking;
      const before = new Map((Array.isArray(previous) ? previous : []).map((entry) => [String(entry?.eventId), Number(entry?.rank)]));
      const ranking = frontierRankHot(scored).map((event, index) => ({
        rank: index + 1, eventId: event.publicId, sourceCount: event.sourceCount72h, reportCount: event.reportCount,
        delta: before.has(event.publicId) ? /** @type {number} */ (before.get(event.publicId)) - (index + 1) : null,
      }));
      await client.query("INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking) VALUES ($1, $2::jsonb) ON CONFLICT (taken_at) DO NOTHING",
        [now, JSON.stringify(ranking)]);
      const shown = (/** @type {any[]} */ list) => JSON.stringify(list.map((entry) => [entry?.eventId, entry?.rank, entry?.sourceCount, entry?.reportCount]));
      const changed = shown(ranking) !== shown(Array.isArray(previous) ? previous : []);
      if (changed) await bumpFrontierVersion(client, FRONTIER_META_KEYS.hotVersion);
      return { ranking, changed };
    });
    this.counters.hotRuns += 1;
    if (result.changed) this.counters.hotChanges += 1;
    this.lastHot = { at: now.toISOString(), ranking: result.ranking };
    return result;
  }

  /**
   * The ids of the events on the latest hot list, resolved to their survivors.
   * @param {any} [client] @returns {Promise<string[]>}
   */
  async hotEventIds(client = this.database) {
    const ranking = (await client.query(`SELECT ranking FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1`)).rows?.[0]?.ranking;
    const publicIds = (Array.isArray(ranking) ? ranking : []).map((entry) => String(entry?.eventId ?? "")).filter((id) => PUBLIC_ID.test(id));
    if (!publicIds.length) return [];
    const rows = (await client.query(`SELECT coalesce(e.merged_into, e.id) AS id, e.public_id FROM evimed_frontier.events e
      WHERE e.public_id = ANY($1::text[])`, [publicIds])).rows ?? [];
    const byPublic = new Map(rows.map((row) => [row.public_id, String(row.id)]));
    return [...new Set(publicIds.map((id) => byPublic.get(id)).filter(/** @returns {id is string} */ (id) => Boolean(id)))];
  }

  /**
   * The hot list as the page shows it: the latest snapshot's events, current
   * (a merged one appears as its survivor, once), with rank, the two counts,
   * the kind of first-hand material, the latest report and the status. The
   * heat is never here.
   */
  async hotList() {
    await this.ready();
    const snapshot = (await this.database.query(`SELECT taken_at, ranking FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1`)).rows?.[0];
    const ranking = Array.isArray(snapshot?.ranking) ? snapshot.ranking : [];
    const publicIds = ranking.map((entry) => String(entry?.eventId ?? "")).filter((id) => PUBLIC_ID.test(id));
    if (!publicIds.length) return { takenAt: iso(snapshot?.taken_at), events: [] };
    const rows = (await this.database.query(`SELECT named.public_id AS named_id, e.id, e.public_id, e.title_zh, e.latest_zh, e.source_count_72h,
        e.report_count, e.last_at, e.status
      FROM evimed_frontier.events named
      JOIN evimed_frontier.events e ON e.id = coalesce(named.merged_into, named.id) AND e.merged_into IS NULL
      WHERE named.public_id = ANY($1::text[])`, [publicIds])).rows ?? [];
    const byNamed = new Map(rows.map((row) => [row.named_id, row]));
    const primaries = await this.#primaryKinds(this.database, rows.map((row) => String(row.id)));
    const seen = new Set();
    const events = [];
    for (const publicId of publicIds) {
      const row = byNamed.get(publicId);
      if (!row || seen.has(row.id) || Number(row.report_count) < 1) continue;
      seen.add(row.id);
      events.push({
        rank: events.length + 1, id: row.public_id, title: row.title_zh, latest: row.latest_zh ?? null,
        sourceCount72h: Number(row.source_count_72h), reportCount: Number(row.report_count),
        primary: primaries.get(String(row.id)) ?? null, lastAt: iso(row.last_at), status: row.status,
      });
    }
    return { takenAt: iso(snapshot?.taken_at), events };
  }

  /** @param {any} client @param {string[]} eventIds @returns {Promise<Map<string, "official" | "guideline" | "paper" | null>>} */
  async #primaryKinds(client, eventIds) {
    if (!eventIds.length) return new Map();
    const rows = (await client.query(`SELECT ei.event_id, ei.role, i.source_type, i.evidence_type FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE ei.event_id = ANY($1::bigint[]) AND ei.role = 'primary' AND i.state = 'published' AND s.enabled`, [eventIds])).rows ?? [];
    /** @type {Map<string, any[]>} */
    const byEvent = new Map();
    for (const row of rows) {
      const list = byEvent.get(String(row.event_id)) ?? [];
      list.push({ role: row.role, sourceType: row.source_type, evidenceType: row.evidence_type });
      byEvent.set(String(row.event_id), list);
    }
    return new Map([...byEvent].map(([id, members]) => [id, frontierPrimaryKind(members)]));
  }

  // ───────────────────────── digests ─────────────────────────

  /**
   * Digests that are owed (plan §6.4, §14.8 #5), at most `limit` per round,
   * hot-list events first: an event on the hot list or holding a primary
   * source with two reports or more, with no digest yet, or with a primary
   * source that arrived after its last one. Only while the budget is `ok`.
   * @param {{ limit?: number }} [options]
   */
  async writeDigests({ limit = 3 } = {}) {
    await this.ready();
    const summary = { written: 0, dropped: 0, skipped: 0 };
    if (!(await this.#modelAllowed())) return summary;
    const now = this.now();
    const hot = await this.hotEventIds();
    const due = (await this.database.query(`SELECT e.id, e.public_id, e.digest_zh, e.digest_state, e.digest_revision
      FROM evimed_frontier.events e
      WHERE e.merged_into IS NULL AND e.report_count >= 1
        AND (e.id = ANY($1::bigint[]) OR (e.has_primary AND e.report_count >= 2))
        AND (e.digest_state = 'none' OR (e.digest_state = 'stale' AND EXISTS (
          SELECT 1 FROM evimed_frontier.event_items ei WHERE ei.event_id = e.id AND ei.role = 'primary'
            AND ei.joined_at > coalesce((SELECT max(written_at) FROM evimed_frontier.event_revisions r WHERE r.event_id = e.id), '-infinity'::timestamptz))))
      ORDER BY (e.id = ANY($1::bigint[])) DESC, e.heat DESC, e.id
      LIMIT 50`, [hot])).rows ?? [];
    for (const event of due) {
      if (summary.written + summary.dropped >= limit) break;
      const failedAt = this.digestFailures.get(String(event.id));
      if (failedAt && now.getTime() - failedAt < DIGEST_RETRY_MS) { summary.skipped += 1; continue; }
      const reports = await this.#digestReports(String(event.id));
      if (!reports.length) { summary.skipped += 1; continue; }
      const result = await this.editor.writeEventDigest({ reports, previousDigest: event.digest_zh ?? null });
      if (!["passed", "repaired"].includes(result.verification) || !result.digestZh) {
        // The previous digest (or none) stands; the event is asked again later.
        this.digestFailures.set(String(event.id), now.getTime());
        if (result.error === "usage_budget_exceeded") break;
        summary.dropped += 1;
        continue;
      }
      this.digestFailures.delete(String(event.id));
      const cause = event.digest_state === "none" && !reports.some((report) => report.role === "primary") ? "new-report" : "new-primary";
      await this.database.transaction(async (/** @type {any} */ client) => {
        const current = (await client.query(`SELECT digest_revision, merged_into FROM evimed_frontier.events WHERE id = $1 FOR UPDATE`, [event.id])).rows?.[0];
        if (!current || current.merged_into != null) return;
        const revision = Number(current.digest_revision) + 1;
        await client.query(`UPDATE evimed_frontier.events SET digest_zh = $2, latest_zh = coalesce($3, latest_zh), digest_state = 'written',
          digest_revision = $4, updated_at = clock_timestamp() WHERE id = $1`, [event.id, result.digestZh, result.latestZh, revision]);
        await client.query(`INSERT INTO evimed_frontier.event_revisions (event_id, revision, digest_zh, cause) VALUES ($1, $2, $3, $4)
          ON CONFLICT (event_id, revision) DO NOTHING`, [event.id, revision, result.digestZh, cause]);
        // The hot list shows 「最新进展」.
        if (hot.includes(String(event.id))) await bumpFrontierVersion(client, FRONTIER_META_KEYS.hotVersion);
      });
      summary.written += 1;
    }
    this.counters.digestsWritten += summary.written;
    this.counters.digestsDropped += summary.dropped;
    this.counters.digestsSkipped += summary.skipped;
    return summary;
  }

  /** The reports a digest is written from, primary sources first. @param {string} eventId */
  async #digestReports(eventId) {
    const rows = (await this.database.query(`SELECT ei.role, s.name AS source_name, s.source_type, i.published_at, i.timeline_at,
        i.title_raw, i.title_zh, i.summary_zh, t.abstract_raw, t.body_excerpt
      FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE ei.event_id = $1 AND i.state = 'published' AND s.enabled
      ORDER BY (ei.role = 'primary') DESC, i.timeline_at DESC, i.id DESC LIMIT ${DIGEST_REPORTS}`, [eventId])).rows ?? [];
    return rows.map((row) => ({
      role: row.role, sourceName: row.source_name, sourceTypeLabel: null, publishedAt: iso(row.published_at ?? row.timeline_at),
      titleRaw: row.title_raw, titleZh: row.title_zh, summaryZh: row.summary_zh, text: row.abstract_raw || row.body_excerpt || null,
    }));
  }

  // ───────────────────────── the event page ─────────────────────────

  /**
   * One event as the page reads it, or where it went, or null.
   * `{ redirect }` for a merged event's old public id — its row, or an alias.
   * @param {string} publicId
   * @returns {Promise<null | { redirect: string } | { event: any, members: Array<{ rowId: string, role: string }>,
   *   related: Array<{ id: string, title: string, relation: string, at: string | null }>, specialties: string[] }>}
   */
  async read(publicId) {
    if (!PUBLIC_ID.test(String(publicId ?? ""))) return null;
    await this.ready();
    const named = (await this.database.query(`SELECT id, merged_into FROM evimed_frontier.events WHERE public_id = $1`, [publicId])).rows?.[0];
    let target = named ? String(named.merged_into ?? named.id) : null;
    if (!named) {
      const alias = (await this.database.query(`SELECT event_id FROM evimed_frontier.event_aliases WHERE public_id = $1`, [publicId])).rows?.[0];
      if (!alias) return null;
      target = String(alias.event_id);
    }
    // Follow what a merge left behind to the survivor: chains are flattened
    // on merge, so this is one hop and the bound is a guard.
    let event = null;
    for (let hop = 0; hop < 5 && target; hop += 1) {
      event = (await this.database.query(`SELECT * FROM evimed_frontier.events WHERE id = $1`, [target])).rows?.[0] ?? null;
      if (!event || event.merged_into == null) break;
      target = String(event.merged_into);
    }
    if (!event || event.merged_into != null) return null;
    if (event.public_id !== publicId) return { redirect: event.public_id };
    const members = (await this.database.query(`SELECT ei.item_id, ei.role, i.specialties FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE ei.event_id = $1 AND i.state = 'published' AND s.enabled
      ORDER BY (ei.role = 'primary') DESC, i.timeline_at DESC, i.id DESC`, [event.id])).rows ?? [];
    if (!members.length) return null;
    const related = (await this.database.query(`SELECT l.relation, other.public_id, other.title_zh, other.last_at, l.linked_at
      FROM evimed_frontier.event_links l
      JOIN evimed_frontier.events other ON other.id = CASE WHEN l.from_event_id = $1 THEN l.to_event_id ELSE l.from_event_id END
      WHERE (l.from_event_id = $1 OR l.to_event_id = $1) AND other.merged_into IS NULL AND other.report_count > 0
      ORDER BY other.last_at DESC LIMIT 20`, [event.id])).rows ?? [];
    /** @type {Map<string, number>} */
    const tally = new Map();
    for (const row of members) for (const key of Array.isArray(row.specialties) ? row.specialties : []) tally.set(key, (tally.get(key) ?? 0) + 1);
    return {
      event,
      members: members.map((row) => ({ rowId: String(row.item_id), role: row.role })),
      related: related.map((row) => ({ id: row.public_id, title: row.title_zh, relation: row.relation, at: iso(row.last_at ?? row.linked_at) })),
      specialties: [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 3).map(([key]) => key),
    };
  }

  status() {
    return { lastError: this.lastError, lastHot: this.lastHot, counters: { ...this.counters } };
  }
}
