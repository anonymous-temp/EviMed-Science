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
 * Clustering (fr-events 2026-10-22, after AIHOT `events/recall.ts`, `group.ts`, `relate.ts`; the
 * prompts and the answer's shape are `frontierEventGrouping.mjs`):
 *
 *   1. recall: the clustered items of the last fourteen days whose vector is
 *      at least 0.6 cosine from the item's — any subject, no shared entity
 *      required (that requirement hid nine in ten of the pairs that were one
 *      story: on the 2026-10-20 production sample it proposed 115 items a day
 *      where 0.6 proposes 1,276) — or, for an item without a vector, whose
 *      title and summary share at least a quarter of their words and
 *      character pairs; plus every report naming the same trial, at any age;
 *      the ten best events, each by its best member;
 *   2. one grouping call per item labels each candidate event
 *      `SAME_OCCURRENCE` (joins), `SAME_STORY` (a `follows` link from the
 *      older event to the newer, never a merge), `UNRELATED` or `ROUNDUP`
 *      (nothing), and says whether the report adds anything to the event's
 *      selected report (`selection`);
 *   3. a `SAME_OCCURRENCE` below 0.85 cosine — or between one publisher's
 *      reports, or between two different works — is looked at again by a
 *      second call on the two reports alone, and joins only if that call
 *      agrees (a `SAME_STORY` there links instead).
 *   An unknown or invalid answer leaves the item distinct; a budget that
 *   cannot be spent leaves it unplaced until it can. Exact DOI/PMID
 *   deduplication remains the ingestion layer's responsibility.
 *
 * Hidden knowledge:
 *
 * - **Every item gets an event, and most events are one item.** (One whose
 *   candidates could not be asked about, for want of budget, gets it when they
 *   can: it is not an event of its own for good, D-16.) A singleton is
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
 *   this deployment). Items older than fourteen days are not clustered at all.
 * - **One selected item per event** (fr-events 2026-10-22). A report that
 *   joins an event whose selected report it adds nothing to — the grouping
 *   call's `selection.addsValue` false — names that report in
 *   `items.same_event_item_id` and, when it was selected by the threshold,
 *   the lane floor or the preprint lane, is unselected in the same
 *   transaction (an `item_changes` row, the content version). A safety alert
 *   and an operator's pin stay selected. The pipeline's later selections read
 *   the same column.
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
 *   Since 2026-09-24 it is shown (plan 2026-09-23 §6.5 #1), as heat × 10
 *   rounded (`frontierHeatDisplay`); the numbers live in `@evimed/domain`,
 *   whose 「热度怎么算」 text states them, so the page cannot explain one
 *   thing while the list does another.
 * - **Two trends, two sources.** Each hot snapshot records the heat of every
 *   event that could be listed (`heats`, the first fifty eligible by heat), and
 *   the list's 24-hour trend reads what was measured then. The event page's
 *   72-hour trend is computed when read, the heat function at each hour over
 *   the reports that existed by then — no table. Neither can keep to the
 *   sources covered the whole time (AIHOT's 「可比范围」): the platform keeps
 *   no history of when a source was enabled (`frontierHotReading` says what
 *   softens that).
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
import {
  DISPLAY_TIME_ZONE,
  FRONTIER_HEAT_BILINGUAL_FACTOR,
  FRONTIER_HEAT_HALF_LIFE_HOURS,
  FRONTIER_HEAT_PRIMARY_FACTOR,
  FRONTIER_HOT_BADGE_HOURS,
  FRONTIER_HOT_MIN_INSTITUTIONS,
  FRONTIER_HOT_TREND,
  FRONTIER_HOT_WINDOW_HOURS,
  FRONTIER_MENTION_REGISTRY_IDS,
  FRONTIER_MENTION_SOURCE_TYPES,
  FRONTIER_SOURCE_TYPES,
  frontierHeatDisplay,
  frontierSourceDisplayName,
} from "@evimed/domain";
import { buildDigestInput } from "./frontierEditor.mjs";
import { frontierEventReports, frontierRepresentative, frontierStoryEventIds } from "./frontierEventReading.mjs";
import {
  FRONTIER_EVENT_DIGEST_INSTRUCTIONS,
  FRONTIER_GROUP_INSTRUCTIONS,
  FRONTIER_GROUP_PAIR_INSTRUCTIONS,
  buildGroupInput,
  buildGroupPairInput,
  validateGroupAnswer,
  validateGroupPair,
  verifyEventDigest,
} from "./frontierEventGrouping.mjs";
import { bumpFrontierVersion, FRONTIER_META_KEYS, migrateFrontier } from "./frontierPersistence.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Half-life of an entity's contribution to heat (plan §4.4); the number lives in `@evimed/domain`, which the page's 「热度怎么算」 states. */
export { FRONTIER_HEAT_HALF_LIFE_HOURS };
/** The window the independent-source count and hot eligibility read. */
export const FRONTIER_EVENT_WINDOW_MS = FRONTIER_HOT_WINDOW_HOURS * HOUR;
/** Clustering compares an item with the items clustered this far back (by when each was published in the feed: AIHOT's 14 days). */
export const FRONTIER_CLUSTER_WINDOW_MS = 14 * DAY;
/**
 * Recall and the second look (AIHOT `group.ts`, `recall.ts`): the cosine from which an earlier item is a candidate, the word
 * and character-pair overlap that stands in for it when the item has no vector (not on the cosine scale, so it has its own
 * bar), the candidate events one grouping call weighs, and the cosine below which a `SAME_OCCURRENCE` is looked at again.
 */
export const FRONTIER_RECALL = Object.freeze({ minCosine: 0.6, minOverlap: 0.25, topEvents: 10, confirmBelowCosine: 0.85 });
/** The selection rules the one-selected-item gate may undo: the arithmetic ones. A safety alert and an operator's pin stay. */
export const FRONTIER_SAME_EVENT_GATED_RULES = Object.freeze(["threshold", "lane-floor", "preprint-lane"]);
/** Events on the hot list. */
export const FRONTIER_HOT_SIZE = 10;
/**
 * Events a hot snapshot records the heat of: the eligible ones by heat, the
 * ten on the list and the forty below them — so an event climbing onto the
 * list already has a trend, and a snapshot stays a few kilobytes.
 */
export const FRONTIER_HOT_TRACKED = 50;
/** A trend point or a comparison reads the latest snapshot at most this long before its time; older means no reading. */
export const FRONTIER_HOT_SNAPSHOT_TOLERANCE_MS = HOUR;
/**
 * Time on the list counts at most this much per snapshot (two hot runs): a
 * longer gap to the next snapshot is the worker being down, not the event
 * being listed.
 */
export const FRONTIER_HOT_SNAPSHOT_SPAN_MS = 20 * MINUTE;
/** The rankings a reader may ask for besides the current list, and how far back each reads. */
export const FRONTIER_HOT_PERIODS = Object.freeze({ week: 7 * DAY, month: 30 * DAY });
/** A fresh item waits this long for its vector before it is clustered without one. */
export const FRONTIER_VECTOR_GRACE_MS = 30 * MINUTE;
/** An item still owed its edit waits this long for its entities. */
export const FRONTIER_EDIT_GRACE_MS = DAY;
/** Reports a digest call is shown (the editor bounds its text as well). */
const DIGEST_REPORTS = 12;
const DIGEST_MAX_TOKENS = 1_500;
/** One grouping call's answer: a sentence, then a decision of about 60 tokens per candidate, then the selection (AIHOT). */
const GROUP_BASE_TOKENS = 400;
const GROUP_TOKENS_PER_CANDIDATE = 120;
const GROUP_TIMEOUT_MS = 60_000;
const PAIR_MAX_TOKENS = 400;
const PAIR_TIMEOUT_MS = 45_000;
/** A round of clustering starts no new item after this long: the hot list waits behind it on the same chain. */
const CLUSTER_ROUND_MS = 2 * MINUTE;
/** The lexical stand-in reads at most this many of the window's items, newest first. */
const LEXICAL_POOL = 20_000;
/** Vector candidates read per item before they are folded into events. */
const VECTOR_RECALL_ROWS = 200;
/** A digest that failed is not asked for again for this long. */
const DIGEST_RETRY_MS = 6 * HOUR;
/** An item left unplaced because the model could not be asked is not looked at again for this long (or until the budget is back). */
const CLUSTER_RETRY_MS = 10 * MINUTE;
/** Reports naming the same trial the identifier step reads at most, newest first. */
const IDENTIFIER_CANDIDATES = 500;
const PUBLIC_ID = /^[a-z0-9]{12,32}$/;
/** What clustering reads of an item it places. */
const PENDING_COLUMNS = `i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.lane, i.lang,
  i.source_type, i.evidence_type, i.identity_key, i.registry_ids, i.entity_keys, i.published_at, i.timeline_at, i.visible_at,
  i.doi AS doi, i.pmid AS pmid, i.event_id, s.id AS source_id, s.name AS source_name, s.owner_entity AS owner_entity,
  s.platform_produced AS platform_produced`;
const CLUSTER_LOCK = "evimed-frontier-cluster";
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
 *
 * An item of a source whose content is the platform's own (contract 1.3.0, flywheel F09) is a report whatever it
 * says it is. Only a first-hand item folds two events into one (`frontierClusterDecision`), and the platform's
 * reading of a study — or its own analysis — is not another institution's first-hand text: it joins the event of the
 * study it is about, or stands in an event of its own, and never merges two events (plan §4.3 rule 2, §2.2).
 * @param {{ sourceType?: string | null, evidenceType?: string | null, platformProduced?: boolean }} item
 * @returns {"primary" | "report" | "background"}
 */
export function frontierEventRole({ sourceType, evidenceType, platformProduced = false }) {
  if (platformProduced) return "report";
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
 *             scoreTotal?: number | null, platformProduced?: boolean }} FrontierEventMember
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
    // The platform's own report is a report of the event and no corroboration of it: it is no independent institution,
    // so it adds to no count of them (plan §4.3 rule 2).
    if (member.platformProduced !== true) {
      entities.add(entity);
      if (at >= since) recent.add(entity);
    }
    firstAt = Math.min(firstAt, at);
    lastAt = Math.max(lastAt, at);
  }
  const languages = new Set(members.filter((member) => member.platformProduced !== true).map((member) => String(member.lang ?? "")));
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
    // The platform's own report lends an event no heat: heat is what independent institutions reporting it adds up to.
    if (member.platformProduced === true) continue;
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
  if (counts.bilingual) heat *= FRONTIER_HEAT_BILINGUAL_FACTOR;
  if (counts.hasPrimary) heat *= FRONTIER_HEAT_PRIMARY_FACTOR;
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
  return sourceCount72h >= FRONTIER_HOT_MIN_INSTITUTIONS || (sourceCount72h >= 1 && selectedRegulatorPrimary);
}

/**
 * The hot list's order: heat, then the latest report, then the lower id.
 * @param {{ id: number | string, heat: number, lastAt: Date | string | null }} left
 * @param {{ id: number | string, heat: number, lastAt: Date | string | null }} right
 */
function byHeat(left, right) {
  return right.heat - left.heat
    || new Date(right.lastAt ?? 0).getTime() - new Date(left.lastAt ?? 0).getTime()
    || Number(left.id) - Number(right.id);
}

/**
 * The hot list: eligible events by heat, then the latest report, then the
 * lower id; at most ten.
 * @template {{ id: number | string, heat: number, lastAt: Date | string | null, eligible: boolean }} T
 * @param {T[]} events @returns {T[]}
 */
export function frontierRankHot(events) {
  return events.filter((event) => event.eligible).sort(byHeat).slice(0, FRONTIER_HOT_SIZE);
}

/**
 * What a hot snapshot records besides the list (plan 2026-09-23 §6.5 #2):
 * the heat of each eligible event in the list's own order, the first fifty —
 * the ten listed and those just below — by public id, to four decimals.
 * @param {Array<{ id: number | string, publicId: string, heat: number, lastAt: Date | string | null, eligible: boolean }>} events
 * @returns {Record<string, number>}
 */
export function frontierTrackedHeats(events) {
  return Object.fromEntries(events.filter((event) => event.eligible && Number.isFinite(event.heat)).sort(byHeat).slice(0, FRONTIER_HOT_TRACKED)
    .map((event) => [event.publicId, Math.round(event.heat * 10_000) / 10_000]));
}

/**
 * @typedef {{ at: Date | string, ranking?: unknown, heats?: unknown }} FrontierHotSample
 *   One snapshot as a trend point or a comparison reads it: `at` the point's
 *   own time (the snapshot is the latest one at most an hour before it).
 */

/**
 * An event's rank and recorded heat in one snapshot, under any of its public
 * ids — its own, and those of events folded into it since, which the
 * snapshot may name instead: the best rank and the highest heat among them.
 * @param {FrontierHotSample | null | undefined} sample @param {string[]} ids
 * @returns {{ rank: number | null, heat: number | null }}
 */
export function frontierSnapshotReading(sample, ids) {
  const ranking = Array.isArray(sample?.ranking) ? sample.ranking : [];
  const heats = sample?.heats && typeof sample.heats === "object" && !Array.isArray(sample.heats)
    ? /** @type {Record<string, unknown>} */ (sample.heats) : {};
  let rank = null;
  let heat = null;
  for (const id of ids) {
    for (const entry of ranking) {
      const value = Number(entry?.rank);
      if (String(entry?.eventId ?? "") === id && Number.isSafeInteger(value) && value > 0 && (rank == null || value < rank)) rank = value;
    }
    const recorded = Object.hasOwn(heats, id) ? Number(heats[id]) : Number.NaN;
    if (Number.isFinite(recorded) && (heat == null || recorded > heat)) heat = recorded;
  }
  return { rank, heat };
}

/**
 * A hot event's rank change against the list of six hours before (plan
 * 2026-09-23 §6.2 「↑2 / 新」): places gained (negative when lost), `"new"`
 * when it was not on that list, null when there is no list that old to read.
 * @param {{ rank: number, before: { rank: number | null } | null }} input
 * @returns {number | "new" | null}
 */
export function frontierRankChange({ rank, before }) {
  if (!before) return null;
  if (before.rank == null) return "new";
  return before.rank - rank;
}

/**
 * The one badge a hot event may carry (plan 2026-09-23 §6.2): 「新」 when its
 * first report is at most twelve hours older than the list; else 「升温」 when
 * it is placed higher than six hours before — including not having been on
 * that list — or its shown heat is higher than the heat recorded for it then;
 * else none. Heats are compared as shown (×10, rounded), so a rise too small
 * to see is not called one. No list six hours old, no 「升温」.
 * @param {{ firstAt: Date | string | null, takenAt: Date | string, rank: number, heat: number | null,
 *           before: { rank: number | null, heat: number | null } | null }} input
 * @returns {"new" | "rising" | null}
 */
export function frontierHotBadge({ firstAt, takenAt, rank, heat, before }) {
  const taken = new Date(takenAt).getTime();
  const first = firstAt == null ? Number.NaN : new Date(firstAt).getTime();
  if (Number.isFinite(first) && taken - first <= FRONTIER_HOT_BADGE_HOURS.new * HOUR) return "new";
  if (!before) return null;
  if (before.rank == null || rank < before.rank) return "rising";
  if (before.heat != null && heat != null && heat > before.heat) return "rising";
  return null;
}

/**
 * What the hot list says about one listed event beyond its rank, from the
 * snapshots (plan 2026-09-23 §6.5 #1, #2): the heat shown (×10, rounded), the
 * rank change and the badge against the list six hours before, and the
 * 24-hour trend — seven points four hours apart, oldest first, ending with the
 * list itself — or null, 「暂无走势」, when the snapshot six hours before did
 * not record the event's heat: less history than that is not a trend.
 *
 * Limitation, said here because the page cannot say it better: AIHOT compares
 * a trend over the sources covered the whole time (「可比范围」). A snapshot
 * holds the heat measured over the sources enabled then, and the platform keeps
 * no history of when a source was enabled or switched off, so the trend cannot
 * be cut to sources covered throughout. What softens it: a source the plugin
 * adds brings no backlog (its first contact is `backfill`, never an item), so
 * it enters a trend with what it reports from then on, as new coverage.
 * @param {{ rank: number, ids: string[], firstAt: Date | string | null, fallbackHeat?: number | null,
 *           latest: FrontierHotSample, compare: FrontierHotSample | null, earlier: Array<FrontierHotSample | null> }} input
 *   `ids` the event's public id and those of events folded into it; `earlier` the
 *   trend's points before the list, oldest first (a missing snapshot is null).
 */
export function frontierHotReading({ rank, ids, firstAt, fallbackHeat = null, latest, compare, earlier }) {
  const now = frontierSnapshotReading(latest, ids);
  // A snapshot from before snapshots recorded heat: the event's stored heat,
  // which that same run wrote.
  const heat = frontierHeatDisplay(now.heat ?? fallbackHeat);
  const then = compare ? frontierSnapshotReading(compare, ids) : null;
  const before = then ? { rank: then.rank, heat: frontierHeatDisplay(then.heat) } : null;
  const trend = then?.heat == null ? null : [
    ...earlier.map((sample, index) => ({
      at: new Date(sample?.at ?? new Date(latest.at).getTime() - (earlier.length - index) * FRONTIER_HOT_TREND.stepHours * HOUR).toISOString(),
      heat: sample ? frontierHeatDisplay(frontierSnapshotReading(sample, ids).heat) : null,
    })),
    { at: new Date(latest.at).toISOString(), heat },
  ];
  return {
    heat,
    rankChange: frontierRankChange({ rank, before }),
    badge: frontierHotBadge({ firstAt, takenAt: latest.at, rank, heat, before }),
    trend,
  };
}

/**
 * The week's or the month's ranking (plan 2026-09-23 §6.2, research §8.1
 * #10), computed when read: independent institutions reporting within the
 * window, then whether the event holds first-hand material, then the best
 * rank it reached on the hot list within the window, then the latest report,
 * then the lower id; at most ten.
 * @template {{ id: number | string, institutions: number, hasPrimary: boolean, bestRank: number | null, lastAt: Date | string | null }} T
 * @param {T[]} events @returns {T[]}
 */
export function frontierRankPeriod(events) {
  const best = (/** @type {number | null} */ rank) => (rank == null ? Number.MAX_SAFE_INTEGER : rank);
  return [...events].sort((left, right) => right.institutions - left.institutions
    || Number(right.hasPrimary) - Number(left.hasPrimary)
    || best(left.bestRank) - best(right.bestRank)
    || new Date(right.lastAt ?? 0).getTime() - new Date(left.lastAt ?? 0).getTime()
    || Number(left.id) - Number(right.id)).slice(0, FRONTIER_HOT_SIZE);
}

/**
 * The institutions reporting an event in the last 72 hours, split by the kind
 * of source (plan 2026-09-23 §6.2 「机构：期刊 1 · 媒体 1」): an institution
 * counts once, as the kind of its most authoritative channel (on a tie, the
 * vocabulary's first), so the kinds add up to the total.
 * @param {{ members: FrontierEventMember[], now: Date }} input
 * @returns {{ total: number, byType: Array<{ type: string, count: number }> }}
 */
export function frontierEventInstitutions({ members, now }) {
  const since = now.getTime() - FRONTIER_EVENT_WINDOW_MS;
  const order = (/** @type {string} */ type) => {
    const index = FRONTIER_SOURCE_TYPES.indexOf(/** @type {any} */ (type));
    return index < 0 ? FRONTIER_SOURCE_TYPES.length : index;
  };
  /** @type {Map<string, { type: string, authority: number }>} */
  const entities = new Map();
  for (const member of members) {
    if (!(new Date(member.timelineAt).getTime() >= since) || member.platformProduced === true) continue;
    const entity = String(member.ownerEntity || "");
    const type = String(member.sourceType || "media");
    const authority = Number(member.authority) || 0;
    const seen = entities.get(entity);
    if (!seen || authority > seen.authority || (authority === seen.authority && order(type) < order(seen.type))) entities.set(entity, { type, authority });
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { type } of entities.values()) counts.set(type, (counts.get(type) ?? 0) + 1);
  return {
    total: entities.size,
    byType: [...counts].sort((left, right) => order(left[0]) - order(right[0]) || left[0].localeCompare(right[0]))
      .map(([type, count]) => ({ type, count })),
  };
}

/**
 * An event's heat hour by hour over the last 72 hours, computed now (plan
 * 2026-09-23 §6.5 #4, no table): at each hour the heat function over the
 * reports that existed by then — a member's timeline instant is fixed at
 * publication, so the function answers for any past hour. From the event's
 * first report on (73 points for an event older than the window), oldest
 * first; null — 「暂无走势」 — with less than six hours of history. The same
 * limitation as the hot list's trend holds (`frontierHotReading`), with one
 * difference: this is computed over the sources enabled now, for every hour.
 * @param {{ members: FrontierEventMember[], now: Date }} input
 * @returns {Array<{ at: string, heat: number | null }> | null}
 */
export function frontierHeatTrend({ members, now }) {
  const times = members.map((member) => new Date(member.timelineAt).getTime()).filter(Number.isFinite);
  if (!times.length) return null;
  const first = Math.min(...times);
  if (now.getTime() - first < FRONTIER_HOT_TREND.minHistoryHours * HOUR) return null;
  /** @type {Array<{ at: string, heat: number | null }>} */
  const points = [];
  for (let back = FRONTIER_HOT_WINDOW_HOURS; back >= 0; back -= 1) {
    const at = now.getTime() - back * HOUR;
    if (at < first) continue;
    const known = members.filter((member) => new Date(member.timelineAt).getTime() <= at);
    points.push({ at: new Date(at).toISOString(), heat: frontierHeatDisplay(frontierEventHeat({ members: known, now: new Date(at) })) });
  }
  return points;
}

/**
 * The candidate keys that associate an item with others mentioning one trial: `reg:<ID>` for each
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
  const mentions = FRONTIER_MENTION_SOURCE_TYPES.includes(String(item?.source_type ?? ""))
    && registered.length >= FRONTIER_MENTION_REGISTRY_IDS;
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

/**
 * The words and character pairs two texts are compared by when there is no vector (AIHOT `lexicalSimilarity`, which compares
 * character pairs only — enough for Chinese text, but any two English sentences share most of their letter pairs): a run of
 * Chinese characters gives its character pairs, a run of Latin letters or digits gives itself as one word, lower-cased.
 * @param {unknown} text @returns {Set<string>}
 */
export function frontierTextTokens(text) {
  const tokens = new Set();
  for (const run of String(text ?? "").toLowerCase().match(/[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9]+/g) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) tokens.add(run);
      continue;
    }
    const characters = [...run];
    if (characters.length === 1) tokens.add(run);
    for (let index = 0; index + 1 < characters.length; index += 1) tokens.add(characters[index] + characters[index + 1]);
  }
  return tokens;
}

/**
 * How much of the shorter of two token sets the other holds (0–1; AIHOT's overlap over the smaller set).
 * @param {Set<string>} left @param {Set<string>} right
 */
export function frontierTextOverlap(left, right) {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

/** The text an item is compared by without a vector: its title and the start of its summary (AIHOT `reportText`). @param {any} item */
export function frontierRecallText(item) {
  return `${item?.title_zh || item?.title_raw || ""}。${String(item?.summary_zh ?? "").slice(0, 300)}`;
}

/**
 * @typedef {{ eventId: string, itemId: string, score: number, cosine: number | null, identifier?: boolean,
 *             samePublisher?: boolean, otherWork?: boolean }} FrontierRecallHit
 *   One earlier item recalled for a new one: `score` what ranks it (the cosine, the overlap, or 1 for a report naming the same
 *   trial), `cosine` the two vectors' when both exist (null otherwise), and the two pair guards of the clustering rules.
 */

/**
 * The candidate events one grouping call weighs (AIHOT `recallFacts`: the best report of each event counts): each event once,
 * by its best-scoring member, the ten best. The pair guards are the event's if any recalled member of it raised them, and its
 * cosine is the best of its members' — what the second look reads.
 * @param {FrontierRecallHit[]} hits @param {{ top?: number }} [options]
 * @returns {Array<FrontierRecallHit & { index: number }>}
 */
export function frontierRecallReading(hits, { top = FRONTIER_RECALL.topEvents } = {}) {
  /** @type {Map<string, FrontierRecallHit & { index: number }>} */
  const best = new Map();
  hits.forEach((hit, index) => {
    if (!hit?.eventId || !Number.isFinite(hit.score)) return;
    const seen = best.get(hit.eventId);
    const cosine = Math.max(Number.isFinite(seen?.cosine) ? Number(seen?.cosine) : -Infinity, Number.isFinite(hit.cosine) ? Number(hit.cosine) : -Infinity);
    const guards = { samePublisher: Boolean(seen?.samePublisher || hit.samePublisher), otherWork: Boolean(seen?.otherWork || hit.otherWork),
      identifier: Boolean(seen?.identifier || hit.identifier), cosine: Number.isFinite(cosine) ? cosine : null };
    best.set(hit.eventId, !seen || hit.score > seen.score ? { ...hit, ...guards, index } : { ...seen, ...guards });
  });
  return [...best.values()].sort((left, right) => right.score - left.score || left.index - right.index).slice(0, top);
}

/**
 * Whether a `SAME_OCCURRENCE` answer is looked at again before it joins (AIHOT `CONFIRM_BELOW_COSINE`): below 0.85 cosine (or
 * with no cosine to read), and always between one publisher's reports — its templated notices are a series, not an occurrence
 * — and between two items that state different works (the clustering rules 1 and 2 of 2026-09-22).
 * @param {{ cosine?: number | null, samePublisher?: boolean, otherWork?: boolean }} candidate
 */
export function frontierNeedsSecondLook(candidate) {
  const cosine = candidate.cosine ?? null;
  return !(Number.isFinite(cosine) && Number(cosine) >= FRONTIER_RECALL.confirmBelowCosine) || candidate.samePublisher === true || candidate.otherWork === true;
}

/**
 * What a grouping answer asks for before any second look: the candidates it joins at once, those a second call looks at
 * first, and those it follows from — each list in the candidates' order (best first). `UNRELATED` and `ROUNDUP` ask for
 * nothing.
 * @template {{ cosine?: number | null, samePublisher?: boolean, otherWork?: boolean }} T
 * @param {T[]} candidates @param {Array<{ relation: string }>} decisions one per candidate, in their order
 * @returns {{ join: T[], check: T[], story: T[] }}
 */
export function frontierGroupPlan(candidates, decisions) {
  /** @type {{ join: T[], check: T[], story: T[] }} */
  const plan = { join: [], check: [], story: [] };
  candidates.forEach((candidate, index) => {
    const relation = decisions[index]?.relation;
    if (relation === "SAME_OCCURRENCE") (frontierNeedsSecondLook(candidate) ? plan.check : plan.join).push(candidate);
    else if (relation === "SAME_STORY") plan.story.push(candidate);
  });
  return plan;
}

/**
 * One report as the grouping call describes it. @param {any} row @param {{ text?: string | null }} [extra]
 * @returns {import("./frontierEventGrouping.mjs").FrontierGroupReport}
 */
function groupReport(row, { text = null } = {}) {
  return {
    sourceName: frontierSourceDisplayName({ id: row.source_id ?? row.primary_source_id, name: row.source_name, ownerEntity: row.owner_entity }),
    primary: frontierEventRole({ sourceType: row.source_type, evidenceType: row.evidence_type, platformProduced: row.platform_produced === true }) === "primary",
    titleRaw: row.title_raw, titleZh: row.title_zh, summaryZh: row.summary_zh, publishedAt: row.published_at ?? row.timeline_at,
    doi: row.doi, pmid: row.pmid, registryIds: row.registry_ids, evidenceType: row.evidence_type, milestone: frontierMilestone(row.identity_key), text,
  };
}

/**
 * A registry entry's milestone from its identity (`reg:<id>:<what>:<when>`, the plugin's closed format), for the model:
 * `NCT01234567 · results-posted · 2026-09-21`; null for any other identity.
 * @param {unknown} identityKey
 */
export function frontierMilestone(identityKey) {
  const match = /^reg:([^:]+):([^:]+):(.+)$/.exec(String(identityKey ?? ""));
  return match ? `${match[1].toUpperCase()} · ${match[2]} · ${match[3]}` : null;
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
    /** The zone the dates the model is shown are read in: the feed's own. */
    this.timeZone = String(this.config.frontierTimeZone || DISPLAY_TIME_ZONE);
    // The width the pipeline and the service migrate with: a migration asked
    // for another width empties the vector table.
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || dimension;
    /** @type {Map<string, number>} event id → when its last digest attempt failed */
    this.digestFailures = new Map();
    /** @type {Map<string, number>} item id → until when it waits unplaced because the model could not be asked (D-16) */
    this.clusterDeferred = new Map();
    /** Observable counters (principle 15). */
    this.counters = {
      clustered: 0, created: 0, joined: 0, merged: 0, relatedLinks: 0, identifierLinks: 0, adjudicated: 0, adjudicationSkipped: 0,
      adjudicationFailures: 0, deferred: 0, hotRuns: 0, hotChanges: 0, digestsWritten: 0, digestsDropped: 0, digestsSkipped: 0,
      // fr-events 2026-10-22: grouping calls and their second looks, what they labelled, the links and the gate they wrote.
      groupCalls: 0, secondLooks: 0, secondLooksAgreed: 0, sameOccurrence: 0, sameStory: 0, followsLinks: 0, sameEventUnselected: 0,
      lexicalRecalls: 0, regrouped: 0,
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
   *
   * A 「多事汇总」 — a daily column, a week's round-up — is left out and is no
   * candidate for anyone else. It is not one event's report, and as a member
   * it made its event a magnet for every story it mentioned: one event held
   * Novo's capital-markets day, an ADHD read-out and a depression trial at
   * once (2026-09-22). It stays a card of its own in the feed.
   *
   * An item with candidates to ask the model about, while the model cannot be
   * asked for want of budget, is left unplaced and looked at again — after
   * ten minutes, or at once when the budget is back — instead of becoming an
   * event of its own for good (D-16; `clusterPending` only reads items with
   * no event). While it waits it is out of the batch, so the items behind it
   * are not starved. A deployment with no editor at all makes it an event of
   * its own, as before: nothing will ever answer.
   * @param {{ limit?: number }} [options]
   */
  async clusterPending({ limit = 25 } = {}) {
    const capabilities = await this.ready();
    const now = this.now();
    const started = Date.now();
    const summary = { clustered: 0, created: 0, joined: 0, merged: 0, skipped: 0 };
    const allowModel = await this.#modelAllowed();
    if (allowModel) this.clusterDeferred.clear();
    /** @type {string[]} */
    const waiting = [];
    for (const [id, until] of this.clusterDeferred) {
      if (until > now.getTime()) waiting.push(id);
      else this.clusterDeferred.delete(id);
    }
    const vectors = Boolean(capabilities.vector && this.embedder?.configured);
    const modelKey = vectors ? String(this.embedder.modelKey) : null;
    /** @type {any[]} */
    const values = [new Date(now.getTime() - FRONTIER_CLUSTER_WINDOW_MS), new Date(now.getTime() - FRONTIER_EDIT_GRACE_MS), limit];
    // Without pgvector there is no vector table to name, even in a branch
    // that would never be taken: the clause exists only where the table does.
    const vectorWait = vectors ? `AND (i.visible_at < $${values.push(new Date(now.getTime() - FRONTIER_VECTOR_GRACE_MS))}::timestamptz
          OR EXISTS (SELECT 1 FROM evimed_frontier.item_vectors v WHERE v.item_id = i.id AND v.model_key = $${values.push(modelKey)}))` : "";
    const rows = (await this.database.query(`SELECT ${PENDING_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND i.event_id IS NULL AND i.visible_at >= $1::timestamptz
        AND NOT ('digest' = ANY(i.flags)) AND (i.verification <> 'pending' OR i.visible_at < $2::timestamptz) ${vectorWait}
        AND i.id <> ALL($${values.push(waiting)}::bigint[])
      ORDER BY i.visible_at, i.id LIMIT $3`, values)).rows ?? [];
    if (!rows.length) return summary;
    /** The round's lexical pool, read once when an item without a vector first needs it. */
    const pool = { rows: /** @type {any[] | null} */ (null) };
    for (const item of rows) {
      // The hot list and the digests wait behind this round on the same chain: a round that has spent its time leaves the rest
      // for the next one, thirty seconds later.
      if (Date.now() - started > CLUSTER_ROUND_MS) break;
      try {
        const outcome = await this.#clusterOne(item, { now, modelKey, allowModel, pool });
        // Skipped: another round placed it first; it is not counted twice.
        if (outcome === "skipped") { summary.skipped += 1; continue; }
        // Deferred: it waits for the model; it is not placed, and it is out of the next rounds' batches until then.
        if (outcome === "deferred") {
          this.clusterDeferred.set(String(item.id), now.getTime() + CLUSTER_RETRY_MS);
          this.counters.deferred += 1;
          summary.skipped += 1;
          continue;
        }
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
   * The backfill (fr-events 2026-10-22, `scripts/ops/frontier-regroup.mjs`): the clustered items published in the feed in a
   * window, oldest first, each recalled again against the items published before it — and, with `apply`, asked about and
   * placed again (`#applyAgain`). Without `apply` nothing is asked and nothing is written: the report says how many items have
   * candidates and how many candidate events a call would weigh, which is what it costs. Placement is serialised by the
   * clustering lock like every round's; the calls of `concurrency` items are made at once. A day's budget that runs out stops
   * the run (`stopped: "budget"`); a second run takes up where the first left off, because an item already placed with the
   * events before it is asked again and answers the same; `resumeFrom` says where to start it so nothing is asked twice.
   * @param {{ since: Date, until?: Date, apply?: boolean, concurrency?: number, limit?: number,
   *           onProgress?: ((summary: Record<string, unknown>) => void) | null }} options
   */
  async regroupRecent({ since, until = this.now(), apply = false, concurrency = 4, limit = 100_000, onProgress = null }) {
    if (!(since instanceof Date) || !(until instanceof Date) || !(since < until)) throw new TypeError("The regroup window is invalid.");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError("The regroup concurrency is invalid.");
    const capabilities = await this.ready();
    const vectors = Boolean(capabilities.vector && this.embedder?.configured);
    const modelKey = vectors ? String(this.embedder.modelKey) : null;
    const items = (await this.database.query(`SELECT ${PENDING_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND i.event_id IS NOT NULL AND NOT ('digest' = ANY(i.flags))
        AND i.visible_at >= $1::timestamptz AND i.visible_at < $2::timestamptz
      ORDER BY i.visible_at, i.id LIMIT $3`, [since, until, limit])).rows ?? [];
    const summary = { items: items.length, scanned: 0, withCandidates: 0, candidateEvents: 0, kept: 0, joined: 0, merged: 0,
      skipped: 0, failed: 0, stopped: /** @type {string | null} */ (null), resumeFrom: /** @type {string | null} */ (null), apply };
    const pool = { rows: /** @type {any[] | null} */ (null) };
    let next = 0;
    /** The first item not placed when the budget stopped the run: where a run started tomorrow takes up (`since`). */
    let resume = Infinity;
    const work = async () => {
      while (next < items.length && !summary.stopped) {
        if (apply && !(await this.#modelAllowed())) { summary.stopped = "budget"; resume = Math.min(resume, next); break; }
        const index = next;
        const item = items[index];
        next += 1;
        try {
          const now = new Date(new Date(item.visible_at).getTime());
          if (!apply) {
            const candidates = frontierRecallReading((await this.#recall(item, { now, modelKey, pool, before: true }))
              .filter((hit) => hit.eventId !== String(item.event_id)));
            if (candidates.length) { summary.withCandidates += 1; summary.candidateEvents += candidates.length; }
          } else {
            // Read again: an earlier item of this run may have folded its event into another since the window was read.
            const own = (await this.database.query("SELECT event_id FROM evimed_frontier.items WHERE id = $1", [item.id])).rows?.[0]?.event_id;
            const outcome = own == null ? "skipped" : await this.#clusterOne(item, { now, modelKey, allowModel: true, pool, own: String(own) });
            if (outcome === "deferred") { summary.stopped = "budget"; resume = Math.min(resume, index); break; }
            if (outcome === "kept" || outcome === "joined" || outcome === "merged" || outcome === "skipped") summary[outcome] += 1;
          }
        } catch (error) {
          this.lastError = codeOf(error);
          summary.failed += 1;
        }
        summary.scanned += 1;
        if (onProgress && summary.scanned % 100 === 0) onProgress({ ...summary });
      }
    };
    await Promise.all(Array.from({ length: apply ? concurrency : 1 }, () => work()));
    if (Number.isFinite(resume) && items[resume]) summary.resumeFrom = new Date(items[resume].visible_at).toISOString();
    return summary;
  }

  /**
   * Recall, the grouping call and its second looks, then the placement.
   * @param {any} item @param {{ now: Date, modelKey: string | null, allowModel: boolean, pool: { rows: any[] | null }, own?: string | null }} context
   *   `own` the item's present event, when it is placed again (`regroupRecent`): never one of its own candidates.
   * @returns {Promise<"created" | "joined" | "merged" | "skipped" | "deferred" | "kept">}
   */
  async #clusterOne(item, { now, modelKey, allowModel, pool, own = null }) {
    const candidates = frontierRecallReading((await this.#recall(item, { now, modelKey, pool, before: own != null })).filter((hit) => hit.eventId !== own));
    /** @type {{ yes: string[], related: string[], follows: string | null, selection: { addsValue: boolean, reason: string | null } | null }} */
    let found = { yes: [], related: [], follows: null, selection: null };
    if (candidates.length) {
      if (!allowModel) {
        this.counters.adjudicationSkipped += candidates.length;
        // Out of budget, not out of editor: the item waits to be asked rather than being an event of its own for good.
        if (this.editor?.available) return "deferred";
      } else {
        const judged = await this.#judge(item, candidates);
        if (judged === "deferred") return "deferred";
        if (judged) found = judged;
      }
    }
    if (own) return found.yes.length || found.follows || found.selection ? this.#applyAgain(item, own, found, now) : "kept";
    const outcome = await this.#apply(item, { identifier: [], strong: [], ...found }, now);
    // An item placed in this round is a candidate for the rest of it.
    if (pool.rows && outcome !== "skipped") {
      const placed = (await this.database.query("SELECT event_id FROM evimed_frontier.items WHERE id = $1", [item.id])).rows?.[0];
      if (placed?.event_id != null) pool.rows.push({ ...item, event_id: placed.event_id });
    }
    return outcome;
  }

  /**
   * The earlier items recalled for one (see the module's account of clustering): every report naming the same trial, at any
   * age, and the window's items by vector — or, when the item has no vector, by the lexical stand-in.
   * @param {any} item @param {{ now: Date, modelKey: string | null, pool: { rows: any[] | null }, before?: boolean }} context
   *   `before` keeps to the items published in the feed before this one (a backfill asks about each pair once).
   * @returns {Promise<FrontierRecallHit[]>}
   */
  async #recall(item, { now, modelKey, pool, before = false }) {
    const earlier = (/** @type {any} */ row) => !before || new Date(row.visible_at).getTime() < new Date(item.visible_at).getTime()
      || (new Date(row.visible_at).getTime() === new Date(item.visible_at).getTime() && Number(row.id) < Number(item.id));
    const since = new Date(now.getTime() - FRONTIER_CLUSTER_WINDOW_MS);
    /** @type {FrontierRecallHit[]} */
    const hits = [];
    const guards = (/** @type {any} */ row) => ({ samePublisher: Boolean(item.owner_entity) && row.owner_entity === item.owner_entity, otherWork: otherWork(item, row) });
    const keys = frontierClusterKeys(item);
    /** @type {any[]} */
    let identified = [];
    if (keys.length) {
      // item_keys names the first item only; registry_ids also finds later trial
      // milestones, so a newer event is not hidden behind its registration row.
      identified = (await this.database.query(`SELECT i.id, i.event_id, i.doi, i.pmid, i.visible_at, s.owner_entity
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE i.id <> $3 AND i.state = 'published' AND i.event_id IS NOT NULL AND NOT ('digest' = ANY(i.flags))
          AND (i.registry_ids && $1::text[] OR EXISTS
            (SELECT 1 FROM evimed_frontier.item_keys k WHERE k.item_id = i.id AND k.key = ANY($2::text[])))
        ORDER BY i.timeline_at DESC, i.id DESC LIMIT ${IDENTIFIER_CANDIDATES}`, [keys.map((key) => key.slice(4)), keys, item.id])).rows ?? [];
      identified = identified.filter(earlier);
    }
    const hasVector = modelKey ? Boolean((await this.database.query(`SELECT 1 FROM evimed_frontier.item_vectors WHERE item_id = $1 AND model_key = $2`,
      [item.id, modelKey])).rows?.length) : false;
    /** @type {Map<string, number>} item id → its cosine to this one */
    const cosines = new Map();
    if (hasVector) {
      // Exact cosine over the window (a few thousand rows a day): an approximate index scan under these filters can return
      // fewer rows than asked for, and recall is what this round is about.
      const rows = (await this.database.query(`SELECT i.id, i.event_id, i.doi, i.pmid, i.visible_at, s.owner_entity, 1 - (v.embedding <=> own.embedding) AS cosine
        FROM evimed_frontier.items i
        JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        JOIN evimed_frontier.item_vectors v ON v.item_id = i.id AND v.model_key = $2
        CROSS JOIN (SELECT embedding FROM evimed_frontier.item_vectors WHERE item_id = $1 AND model_key = $2) own
        WHERE i.state = 'published' AND i.id <> $1 AND i.event_id IS NOT NULL AND NOT ('digest' = ANY(i.flags))
          AND i.visible_at >= $3::timestamptz AND 1 - (v.embedding <=> own.embedding) >= $4
          AND (NOT $5::boolean OR (i.visible_at, i.id) < ($6::timestamptz, $1::bigint))
        ORDER BY cosine DESC, i.id LIMIT ${VECTOR_RECALL_ROWS}`, [item.id, modelKey, since, FRONTIER_RECALL.minCosine, before, item.visible_at])).rows ?? [];
      for (const row of rows) {
        cosines.set(String(row.id), Number(row.cosine));
        hits.push({ eventId: String(row.event_id), itemId: String(row.id), score: Number(row.cosine), cosine: Number(row.cosine), ...guards(row) });
      }
      const unmeasured = identified.filter((row) => !cosines.has(String(row.id))).map((row) => String(row.id));
      if (unmeasured.length) {
        for (const row of (await this.database.query(`SELECT v.item_id, 1 - (v.embedding <=> own.embedding) AS cosine
          FROM evimed_frontier.item_vectors v
          CROSS JOIN (SELECT embedding FROM evimed_frontier.item_vectors WHERE item_id = $1 AND model_key = $2) own
          WHERE v.model_key = $2 AND v.item_id = ANY($3::bigint[])`, [item.id, modelKey, unmeasured])).rows ?? []) {
          cosines.set(String(row.item_id), Number(row.cosine));
        }
      }
    } else {
      // No vector of its own (the embedder failed, or this deployment has none): the window's titles and summaries.
      if (!pool.rows) {
        pool.rows = (await this.database.query(`SELECT i.id, i.event_id, i.title_raw, i.title_zh, i.summary_zh, i.doi, i.pmid, i.visible_at, s.owner_entity
          FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
          WHERE i.state = 'published' AND i.event_id IS NOT NULL AND NOT ('digest' = ANY(i.flags)) AND i.visible_at >= $1::timestamptz
          ORDER BY i.visible_at DESC, i.id DESC LIMIT ${LEXICAL_POOL}`, [since])).rows ?? [];
      }
      const mine = frontierTextTokens(frontierRecallText(item));
      this.counters.lexicalRecalls += 1;
      for (const row of pool.rows) {
        if (String(row.id) === String(item.id) || row.event_id == null || !earlier(row)) continue;
        row.tokens ??= frontierTextTokens(frontierRecallText(row));
        const overlap = frontierTextOverlap(mine, row.tokens);
        if (overlap >= FRONTIER_RECALL.minOverlap) hits.push({ eventId: String(row.event_id), itemId: String(row.id), score: overlap, cosine: null, ...guards(row) });
      }
    }
    for (const row of identified) {
      const cosine = cosines.get(String(row.id));
      hits.push({ eventId: String(row.event_id), itemId: String(row.id), score: 1, cosine: cosine ?? null, identifier: true, ...guards(row) });
    }
    return hits;
  }

  /**
   * What each candidate event is shown as (AIHOT `candidateViews`): its title, how many reports it holds, its representative
   * report, and the report of it already selected for the feed. A candidate whose event no longer has a visible report is
   * dropped.
   * @param {Array<FrontierRecallHit & { index: number }>} candidates
   */
  async #candidateViews(candidates) {
    const ids = candidates.map((candidate) => candidate.eventId);
    const titles = new Map(((await this.database.query(`SELECT id, title_zh FROM evimed_frontier.events WHERE id = ANY($1::bigint[])`, [ids])).rows ?? [])
      .map((row) => [String(row.id), row.title_zh]));
    const reports = await frontierEventReports(this.database, ids);
    const details = new Map(((await this.database.query(`SELECT i.id, i.summary_zh, i.published_at, i.doi, i.pmid, i.registry_ids, i.evidence_type,
        i.identity_key, s.platform_produced FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.id = ANY($1::bigint[])`, [[...reports.values()].flat().map((row) => row.id)])).rows ?? []).map((row) => [String(row.id), row]));
    const report = (/** @type {any} */ row) => groupReport({ ...row, ...details.get(String(row.id)) });
    return candidates.flatMap((candidate) => {
      const rows = reports.get(candidate.eventId) ?? [];
      const representative = frontierRepresentative(rows);
      if (!representative) return [];
      const selected = frontierRepresentative(rows.filter((row) => row.selected === true));
      return [{ candidate, view: { title: String(titles.get(candidate.eventId) ?? representative.title_zh ?? representative.title_raw), members: rows.length,
        report: report(representative), selected: selected ? report(selected) : null } }];
    });
  }

  /**
   * The grouping call for one item and the second looks it asks for: the events it joins, the one it follows from, and its
   * reading value against the reports already selected — or null when there is no answer to act on (the item then stands
   * alone: a wrong merge costs more than a missed one), or `deferred` when the day's budget ran out on the way.
   * @param {any} item @param {Array<FrontierRecallHit & { index: number }>} candidates
   * @returns {Promise<null | "deferred" | { yes: string[], related: string[], follows: string | null,
   *   selection: { addsValue: boolean, reason: string | null } | null }>}
   */
  async #judge(item, candidates) {
    const views = await this.#candidateViews(candidates);
    if (!views.length) return null;
    const texts = (await this.database.query(`SELECT abstract_raw, body_excerpt FROM evimed_frontier.item_texts WHERE item_id = $1`, [item.id])).rows?.[0];
    const report = groupReport(item, { text: texts?.abstract_raw || texts?.body_excerpt || null });
    const messages = [{ role: "system", content: FRONTIER_GROUP_INSTRUCTIONS },
      { role: "user", content: buildGroupInput({ report, candidates: views.map(({ view }) => view) }, { timeZone: this.timeZone }) }];
    this.counters.adjudicated += views.length;
    let answer = null;
    // An answer that does not address every candidate is asked for once more; a spent budget or a missing owner will not be
    // different a second later.
    for (let round = 0; round < 2 && !answer; round += 1) {
      this.counters.groupCalls += 1;
      try {
        answer = validateGroupAnswer(views.length, await this.editor.callJson(messages,
          { maxTokens: GROUP_BASE_TOKENS + GROUP_TOKENS_PER_CANDIDATE * views.length, timeoutMs: GROUP_TIMEOUT_MS }));
      } catch (error) {
        const code = codeOf(error);
        if (code === "usage_budget_exceeded") return "deferred";
        if (code === "frontier_editor_unavailable") break;
      }
    }
    if (!answer) {
      this.counters.adjudicationFailures += 1;
      return null;
    }
    const plan = frontierGroupPlan(views.map(({ candidate, view }) => ({ ...candidate, view })), answer.decisions);
    const join = [...plan.join];
    const story = [...plan.story];
    for (const candidate of plan.check) {
      this.counters.secondLooks += 1;
      let pair = null;
      try {
        pair = validateGroupPair(await this.editor.callJson([{ role: "system", content: FRONTIER_GROUP_PAIR_INSTRUCTIONS },
          { role: "user", content: buildGroupPairInput(report, candidate.view.report, { timeZone: this.timeZone }) }],
        { maxTokens: PAIR_MAX_TOKENS, timeoutMs: PAIR_TIMEOUT_MS }));
      } catch (error) {
        if (codeOf(error) === "usage_budget_exceeded") return "deferred";
      }
      // The merge stands only when the second look agrees; a development it sees instead links (AIHOT `confirmMerge`).
      if (pair?.relation === "SAME_OCCURRENCE") { join.push(candidate); this.counters.secondLooksAgreed += 1; }
      else if (pair?.relation === "SAME_STORY") story.push(candidate);
    }
    story.sort((left, right) => right.score - left.score || left.index - right.index);
    this.counters.sameOccurrence += join.length;
    this.counters.sameStory += story.length ? 1 : 0;
    return {
      yes: join.map((candidate) => candidate.eventId), related: [], follows: story[0]?.eventId ?? null,
      // Reading value is judged against the reports already selected; with none shown there was nothing to judge.
      selection: views.some(({ view }) => view.selected) ? answer.selection : null,
    };
  }

  /**
   * Place one item, under the clustering lock: the events named are read again
   * (a merge since may have absorbed one — its survivor is used), the survivor
   * absorbs the others, the item joins it, and the edges are written — the
   * `follows` link to the story it develops, and the one-selected-item gate.
   * @param {any} item
   * @param {{ identifier: string[], strong: string[], yes: string[], related: string[], follows?: string | null,
   *           selection?: { addsValue: boolean, reason: string | null } | null }} found
   * @param {Date} now
   * @returns {Promise<"created" | "joined" | "merged" | "skipped">}
   */
  async #apply(item, found, now) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CLUSTER_LOCK]);
      const current = (await client.query(`SELECT id, event_id, state FROM evimed_frontier.items WHERE id = $1 FOR UPDATE`, [item.id])).rows?.[0];
      if (!current || current.state !== "published" || current.event_id != null) return "skipped";
      const named = [...new Set([...found.identifier, ...found.strong, ...found.yes, ...found.related, ...(found.follows ? [found.follows] : [])])];
      const events = await this.#resolveEvents(client, named);
      const survivorOf = (/** @type {string} */ id) => events.get(id)?.id ?? null;
      const role = frontierEventRole({ sourceType: item.source_type, evidenceType: item.evidence_type, platformProduced: item.platform_produced === true });
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
      const story = found.follows ? survivorOf(found.follows) : null;
      const linked = story ? await this.#linkStory(client, target, story) : false;
      const unselected = found.selection ? await this.#applySelection(client, item.id, target, found.selection, now) : false;
      await this.#linkFromItemLinks(client, item.id, target);
      await this.#refresh(client, [target], now);
      // A card's 「同一事件的全部报道」 appears, its event's title moves, it
      // leaves the selected feed, or its 事件后续 grows: a change every reader
      // of the lists can see.
      if (outcome !== "created" || linked || unselected) await bumpFrontierVersion(client, FRONTIER_META_KEYS.contentVersion);
      return outcome;
    });
  }

  /**
   * Place an item that already has an event again (`regroupRecent`): what the grouping answer says about its event and the
   * earlier ones, under the clustering lock. An item alone in its event moves to the event it is the same occurrence as, and
   * its old event is folded in (its public id answers 308 for good); an item among other reports folds the events only when it
   * is first-hand — a report links them (the clustering rule 5). The follows link and the gate as for a new item.
   * @param {any} item @param {string} own the event it is in @param {{ yes: string[], related: string[], follows: string | null,
   *   selection: { addsValue: boolean, reason: string | null } | null }} found @param {Date} now
   * @returns {Promise<"joined" | "merged" | "kept" | "skipped">}
   */
  async #applyAgain(item, own, found, now) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CLUSTER_LOCK]);
      const current = (await client.query(`SELECT id, event_id, state FROM evimed_frontier.items WHERE id = $1 FOR UPDATE`, [item.id])).rows?.[0];
      if (!current || current.state !== "published" || current.event_id == null) return "skipped";
      const named = [...new Set([String(current.event_id), own, ...found.yes, ...(found.follows ? [found.follows] : [])])];
      const events = await this.#resolveEvents(client, named);
      const home = events.get(String(current.event_id))?.id;
      if (!home) return "skipped";
      const yes = [...new Set(found.yes.map((id) => events.get(id)?.id).filter(/** @returns {id is string} */ (id) => Boolean(id) && id !== home))];
      const role = frontierEventRole({ sourceType: item.source_type, evidenceType: item.evidence_type, platformProduced: item.platform_produced === true });
      const byId = new Map([...events.values()].map((event) => [event.id, event]));
      let place = home;
      let outcome = /** @type {"joined" | "merged" | "kept"} */ ("kept");
      if (yes.length) {
        const alone = Number((await client.query(`SELECT count(*)::integer AS n FROM evimed_frontier.event_items WHERE event_id = $1`, [home])).rows?.[0]?.n ?? 0) <= 1;
        if (alone || role === "primary") {
          // Alone, the item is free: it is placed as a new item would be, and its old event folds into where it went. Among
          // other reports, a first-hand item folds its event and the others into the oldest.
          const decision = frontierClusterDecision({ role, identifier: [], strong: [], yes: alone ? yes : [home, ...yes], related: [], events: byId });
          const target = /** @type {string} */ (decision.target);
          for (const absorbed of [...(alone && target !== home ? [home] : []), ...decision.merge]) await this.#mergeInto(client, target, absorbed, now);
          for (const other of decision.related) {
            const inserted = await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by)
              VALUES ($1, $2, 'related', 'model') ON CONFLICT DO NOTHING`, [target, other]);
            this.counters.relatedLinks += inserted.rowCount ?? 0;
          }
          place = target;
          outcome = "merged";
          await client.query("UPDATE evimed_frontier.event_items SET joined_by = 'model' WHERE item_id = $1 AND joined_by <> 'operator'", [item.id]);
        } else {
          // A report among other reports folds nothing (the clustering rule 5): its event is linked to the others.
          for (const other of yes) {
            const inserted = await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by)
              VALUES ($1, $2, 'related', 'model') ON CONFLICT DO NOTHING`, [home, other]);
            this.counters.relatedLinks += inserted.rowCount ?? 0;
            if (inserted.rowCount) outcome = "joined";
          }
        }
      }
      const story = found.follows ? events.get(found.follows)?.id ?? null : null;
      const linked = story && story !== place ? await this.#linkStory(client, place, story) : false;
      const unselected = found.selection ? await this.#applySelection(client, item.id, place, found.selection, now) : false;
      await this.#refresh(client, [...new Set([place, home])], now);
      if (outcome !== "kept" || linked || unselected) {
        this.counters.regrouped += 1;
        await bumpFrontierVersion(client, FRONTIER_META_KEYS.contentVersion);
        return outcome === "kept" ? "joined" : outcome;
      }
      return "kept";
    });
  }

  /**
   * A `follows` link between an event and the story it develops (fr-events 2026-10-22, AIHOT `storyForDevelopment`): to the
   * story's root — the event the candidate itself follows, else the candidate — so a story grows as a star and not by
   * chaining; from the older of the two to the newer (by first report). Nothing when the two are already linked either way.
   * @param {any} client @param {string} eventId @param {string} candidateId both survivors, locked
   * @returns {Promise<boolean>} whether a link was written
   */
  async #linkStory(client, eventId, candidateId) {
    const root = String((await client.query(`SELECT l.from_event_id FROM evimed_frontier.event_links l
      JOIN evimed_frontier.events e ON e.id = l.from_event_id
      WHERE l.to_event_id = $1 AND l.relation = 'follows' AND e.merged_into IS NULL ORDER BY e.first_at, e.id LIMIT 1`, [candidateId])).rows?.[0]?.from_event_id
      ?? candidateId);
    if (root === eventId) return false;
    const linked = (await client.query(`SELECT 1 FROM evimed_frontier.event_links WHERE relation = 'follows'
      AND ((from_event_id = $1 AND to_event_id = $2) OR (from_event_id = $2 AND to_event_id = $1))`, [eventId, root])).rows?.length;
    if (linked) return false;
    const [from, to] = ((await client.query(`SELECT id FROM evimed_frontier.events WHERE id = ANY($1::bigint[]) ORDER BY first_at, id`,
      [[eventId, root]])).rows ?? []).map((row) => String(row.id));
    if (!from || !to) return false;
    const inserted = await client.query(`INSERT INTO evimed_frontier.event_links (from_event_id, to_event_id, relation, asserted_by)
      VALUES ($1, $2, 'follows', 'model') ON CONFLICT DO NOTHING`, [from, to]);
    this.counters.followsLinks += inserted.rowCount ?? 0;
    return Boolean(inserted.rowCount);
  }

  /**
   * The one-selected-item gate (see the module's hidden knowledge): the verdict is recorded on the item; when it adds nothing to
   * a report of its event that is already selected, it names that report and, if an arithmetic rule selected it, leaves the
   * selected feed. The caller holds the item's row.
   * @param {any} client @param {string | number} itemId @param {string} eventId
   * @param {{ addsValue: boolean, reason: string | null }} selection @param {Date} now
   * @returns {Promise<boolean>} whether the item was unselected
   */
  async #applySelection(client, itemId, eventId, selection, now) {
    const verdict = JSON.stringify({ addsValue: selection.addsValue, reason: selection.reason ?? null, decidedAt: now.toISOString() });
    const others = selection.addsValue === false ? (await client.query(`SELECT i.id, ei.role, i.source_type, i.selected, i.score_total, i.timeline_at
      FROM evimed_frontier.event_items ei JOIN evimed_frontier.items i ON i.id = ei.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE ei.event_id = $1 AND i.id <> $2 AND i.state = 'published' AND i.selected AND s.enabled`, [eventId, itemId])).rows ?? [] : [];
    const named = frontierRepresentative(others);
    if (!named) {
      await client.query(`UPDATE evimed_frontier.items SET event_selection = $2::jsonb, same_event_item_id = NULL WHERE id = $1`, [itemId, verdict]);
      return false;
    }
    const before = (await client.query(`SELECT selected, selected_rule FROM evimed_frontier.items WHERE id = $1`, [itemId])).rows?.[0];
    const unselect = before?.selected === true && FRONTIER_SAME_EVENT_GATED_RULES.includes(String(before.selected_rule));
    await client.query(`UPDATE evimed_frontier.items SET event_selection = $2::jsonb, same_event_item_id = $3,
        selected = CASE WHEN $4::boolean THEN false ELSE selected END, selected_rule = CASE WHEN $4::boolean THEN NULL ELSE selected_rule END,
        selected_at = CASE WHEN $4::boolean THEN NULL ELSE selected_at END, updated_at = clock_timestamp()
      WHERE id = $1`, [itemId, verdict, named.id, unselect]);
    if (!unselect) return false;
    await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'same-event')", [itemId]);
    this.counters.sameEventUnselected += 1;
    return true;
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
    await client.query(`UPDATE evimed_frontier.events s SET digest_zh = a.digest_zh, digest_title_zh = a.digest_title_zh, digest_state = 'stale'
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
        i.entity_keys, i.source_type, i.evidence_type, i.selected, i.safety_alert, i.score_total, s.owner_entity, s.authority,
        s.platform_produced
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
      safetyAlert: row.safety_alert === true, scoreTotal: row.score_total == null ? null : Number(row.score_total),
      platformProduced: row.platform_produced === true }));
  }

  /**
   * Recompute an event from its visible members: title (its overview's, else
   * its first primary source's, else its first report's), lane, entities, the three counts,
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
      // The overview's title names the event once written (`writeDigests`); until then its first primary source's does.
      await client.query(`UPDATE evimed_frontier.events SET title_zh = coalesce(digest_title_zh, $2), lane = $3, entity_keys = $4, source_count_72h = $5, report_count = $6,
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
      // The heats go with the list, for its trend: what was measured now, of
      // every event that could be listed (`frontierTrackedHeats`).
      await client.query(`INSERT INTO evimed_frontier.hot_snapshots (taken_at, ranking, heats) VALUES ($1, $2::jsonb, $3::jsonb)
        ON CONFLICT (taken_at) DO NOTHING`, [now, JSON.stringify(ranking), JSON.stringify(frontierTrackedHeats(scored))]);
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
   * the kind of first-hand material, the first and the latest report, the
   * status — and, from the snapshots (plan 2026-09-23 §6.5 #1, #2), the heat
   * shown (×10, rounded), the rank change and the badge against the list six
   * hours before, and the 24-hour trend (`frontierHotReading`).
   */
  async hotList() {
    await this.ready();
    const snapshot = (await this.database.query(`SELECT taken_at, ranking, heats FROM evimed_frontier.hot_snapshots ORDER BY taken_at DESC LIMIT 1`)).rows?.[0];
    const ranking = Array.isArray(snapshot?.ranking) ? snapshot.ranking : [];
    const publicIds = ranking.map((entry) => String(entry?.eventId ?? "")).filter((id) => PUBLIC_ID.test(id));
    if (!publicIds.length) return { takenAt: iso(snapshot?.taken_at), events: [] };
    const rows = (await this.database.query(`SELECT named.public_id AS named_id, e.id, e.public_id, e.title_zh, e.latest_zh, e.source_count_72h,
        e.report_count, e.first_at, e.last_at, e.status, e.heat
      FROM evimed_frontier.events named
      JOIN evimed_frontier.events e ON e.id = coalesce(named.merged_into, named.id) AND e.merged_into IS NULL
      WHERE named.public_id = ANY($1::text[])`, [publicIds])).rows ?? [];
    const byNamed = new Map(rows.map((row) => [row.named_id, row]));
    const survivors = [...new Set(rows.map((row) => String(row.id)))];
    const primaries = await this.#primaryKinds(this.database, survivors);
    const aliases = await this.#aliases(survivors);
    const takenAt = new Date(snapshot.taken_at);
    const { earlier, compare } = await this.#hotSamples(takenAt);
    const latest = { at: takenAt, ranking, heats: snapshot.heats };
    const seen = new Set();
    const events = [];
    for (const publicId of publicIds) {
      const row = byNamed.get(publicId);
      if (!row || seen.has(row.id) || Number(row.report_count) < 1) continue;
      seen.add(row.id);
      const rank = events.length + 1;
      const primary = primaries.get(String(row.id)) ?? null;
      const reading = frontierHotReading({ rank, ids: aliases.get(String(row.id)) ?? [row.public_id], firstAt: row.first_at,
        fallbackHeat: row.heat == null ? null : Number(row.heat), latest, compare, earlier });
      events.push({
        rank, id: row.public_id, title: row.title_zh, latest: row.latest_zh ?? null,
        sourceCount72h: Number(row.source_count_72h), reportCount: Number(row.report_count),
        primary, hasPrimary: primary != null, firstAt: iso(row.first_at), lastAt: iso(row.last_at), status: row.status,
        heat: reading.heat, rankChange: reading.rankChange, badge: reading.badge, trend: reading.trend, period: null,
      });
    }
    return { takenAt: iso(snapshot.taken_at), events };
  }

  /**
   * The snapshots a list's trend and comparison read: the latest one at most
   * an hour before each of the trend's earlier points (24, 20 … 4 hours before
   * the list, oldest first) and before the comparison (six hours). A point
   * with no snapshot in its hour is null — the worker was not running then.
   * @param {Date} takenAt
   * @returns {Promise<{ earlier: Array<FrontierHotSample | null>, compare: FrontierHotSample | null }>}
   */
  async #hotSamples(takenAt) {
    const count = Math.round(FRONTIER_HOT_TREND.hours / FRONTIER_HOT_TREND.stepHours);
    const targets = Array.from({ length: count }, (_, index) => new Date(takenAt.getTime() - (count - index) * FRONTIER_HOT_TREND.stepHours * HOUR));
    const compareAt = new Date(takenAt.getTime() - FRONTIER_HOT_BADGE_HOURS.rising * HOUR);
    const rows = (await this.database.query(`SELECT t.k, s.ranking, s.heats
      FROM unnest($1::timestamptz[]) WITH ORDINALITY AS t(at, k)
      LEFT JOIN LATERAL (SELECT h.ranking, h.heats FROM evimed_frontier.hot_snapshots h
        WHERE h.taken_at <= t.at AND h.taken_at > t.at - make_interval(secs => $2::float8)
        ORDER BY h.taken_at DESC LIMIT 1) s ON true
      ORDER BY t.k`, [[...targets, compareAt], FRONTIER_HOT_SNAPSHOT_TOLERANCE_MS / 1000])).rows ?? [];
    const sample = (/** @type {number} */ index, /** @type {Date} */ at) => {
      const row = rows[index];
      return row && row.ranking != null ? { at, ranking: row.ranking, heats: row.heats } : null;
    };
    return { earlier: targets.map((at, index) => sample(index, at)), compare: sample(targets.length, compareAt) };
  }

  /**
   * Each event's public ids: its own first, then those of the events folded
   * into it — what older snapshots may name it by (merges flatten chains, so
   * one hop finds them all).
   * @param {string[]} eventIds @returns {Promise<Map<string, string[]>>}
   */
  async #aliases(eventIds) {
    /** @type {Map<string, string[]>} */
    const ids = new Map();
    if (!eventIds.length) return ids;
    const rows = (await this.database.query(`SELECT coalesce(merged_into, id) AS id, public_id FROM evimed_frontier.events
      WHERE id = ANY($1::bigint[]) OR merged_into = ANY($1::bigint[]) ORDER BY (merged_into IS NULL) DESC, id`, [eventIds])).rows ?? [];
    for (const row of rows) ids.set(String(row.id), [...(ids.get(String(row.id)) ?? []), row.public_id]);
    return ids;
  }

  /**
   * The week's or the month's ranking (plan 2026-09-23 §6.2), computed when
   * read and never stored: every event reported within the window by at
   * least two independent institutions, or on the hot list at some time in
   * it, ranked by `frontierRankPeriod`, with what its row says — 「本周 N 家机构
   * · M 篇 · 在榜 X 小时 · 最高第 K 名」. Time on the list sums, per snapshot
   * that listed the event, the time to the next snapshot, at most two hot runs
   * (`FRONTIER_HOT_SNAPSHOT_SPAN_MS`): the worker being down is not time on the
   * list. No heat, no trend, no badge: those belong to the current list.
   * @param {"week" | "month"} window
   */
  async hotPeriod(window) {
    const span = /** @type {Record<string, number>} */ (FRONTIER_HOT_PERIODS)[window];
    if (!span) throw Object.assign(new Error("The hot list's window is invalid."), { code: "frontier_query_invalid" });
    await this.ready();
    const now = this.now();
    const since = new Date(now.getTime() - span);
    const listed = (await this.database.query(`WITH snaps AS (
        SELECT ranking, least(coalesce(lead(taken_at) OVER (ORDER BY taken_at), $2::timestamptz), taken_at + make_interval(secs => $3::float8))
          - taken_at AS listed
        FROM evimed_frontier.hot_snapshots WHERE taken_at >= $1::timestamptz AND taken_at <= $2::timestamptz)
      SELECT entry->>'eventId' AS public_id, min((entry->>'rank')::integer) AS best_rank, sum(extract(epoch FROM snaps.listed))::float8 AS seconds
      FROM snaps CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(snaps.ranking) = 'array' THEN snaps.ranking ELSE '[]'::jsonb END) AS entry
      WHERE entry->>'eventId' IS NOT NULL AND (entry->>'rank') ~ '^[0-9]{1,4}$'
      GROUP BY 1`, [since, now, FRONTIER_HOT_SNAPSHOT_SPAN_MS / 1000])).rows ?? [];
    /** @type {Map<string, { bestRank: number, seconds: number }>} survivor row id → its time on the list */
    const onList = new Map();
    if (listed.length) {
      const named = (await this.database.query(`SELECT public_id, coalesce(merged_into, id) AS id FROM evimed_frontier.events
        WHERE public_id = ANY($1::text[])`, [listed.map((row) => row.public_id)])).rows ?? [];
      const survivorOf = new Map(named.map((row) => [row.public_id, String(row.id)]));
      for (const row of listed) {
        const id = survivorOf.get(row.public_id);
        if (!id) continue;
        const seen = onList.get(id);
        onList.set(id, { bestRank: Math.min(seen?.bestRank ?? Infinity, Number(row.best_rank)), seconds: (seen?.seconds ?? 0) + Number(row.seconds) });
      }
    }
    const rows = (await this.database.query(`SELECT e.id, e.public_id, e.title_zh, e.latest_zh, e.source_count_72h, e.report_count, e.first_at,
        e.last_at, e.status,
        count(DISTINCT s.owner_entity) FILTER (WHERE i.timeline_at >= $1::timestamptz AND NOT s.platform_produced)::integer AS institutions,
        count(*) FILTER (WHERE i.timeline_at >= $1::timestamptz)::integer AS reports,
        bool_or(ei.role = 'primary') AS has_primary
      FROM evimed_frontier.events e
      JOIN evimed_frontier.event_items ei ON ei.event_id = e.id
      JOIN evimed_frontier.items i ON i.id = ei.item_id AND i.state = 'published'
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
      WHERE e.merged_into IS NULL AND e.last_at >= $1::timestamptz
      GROUP BY e.id
      HAVING count(*) FILTER (WHERE i.timeline_at >= $1::timestamptz) > 0
        AND (count(DISTINCT s.owner_entity) FILTER (WHERE i.timeline_at >= $1::timestamptz AND NOT s.platform_produced) >= $2 OR e.id = ANY($3::bigint[]))`,
    [since, FRONTIER_HOT_MIN_INSTITUTIONS, [...onList.keys()]])).rows ?? [];
    /** @type {Array<{ id: string, institutions: number, hasPrimary: boolean, bestRank: number | null, lastAt: Date | string | null, row: any }>} */
    const candidates = rows.map((row) => ({ id: String(row.id), institutions: Number(row.institutions), hasPrimary: row.has_primary === true,
      bestRank: onList.get(String(row.id))?.bestRank ?? null, lastAt: row.last_at, row }));
    const ranked = frontierRankPeriod(candidates);
    const primaries = await this.#primaryKinds(this.database, ranked.map((entry) => entry.id));
    const events = ranked.map((entry, index) => {
      const { row } = entry;
      const listedFor = onList.get(entry.id);
      return {
        rank: index + 1, id: row.public_id, title: row.title_zh, latest: row.latest_zh ?? null,
        sourceCount72h: Number(row.source_count_72h), reportCount: Number(row.report_count),
        primary: primaries.get(entry.id) ?? null, hasPrimary: entry.hasPrimary, firstAt: iso(row.first_at), lastAt: iso(row.last_at), status: row.status,
        heat: null, rankChange: null, badge: null, trend: null,
        period: { institutions: entry.institutions, reports: Number(row.reports),
          hoursOnList: listedFor ? Math.round(listedFor.seconds / 3600) : null, bestRank: entry.bestRank },
      };
    });
    return { at: now.toISOString(), since: since.toISOString(), events };
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
      // The overview (AIHOT `story-digest.md`): the core change and its conclusion first, 100–300 characters, and a title for
      // the whole event; checked like every piece of prose, rewritten once with the issues named.
      const input = buildDigestInput({ reports, previousDigest: event.digest_zh ?? null }, { timeZone: this.timeZone });
      const result = await this.editor.writeJson(FRONTIER_EVENT_DIGEST_INSTRUCTIONS, input, DIGEST_MAX_TOKENS,
        { verify: (/** @type {any} */ answer) => verifyEventDigest(answer, input) });
      const written = { digest: result.output?.digest ?? null, title: result.output?.title ?? null };
      if (!["passed", "repaired"].includes(result.verification) || !written.digest) {
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
        // 「最新进展」 stays the newest report's own title, by code; the overview's title names the event from now on.
        await client.query(`UPDATE evimed_frontier.events SET digest_zh = $2, digest_title_zh = coalesce($3, digest_title_zh),
          title_zh = coalesce($3, title_zh), digest_state = 'written', digest_revision = $4, updated_at = clock_timestamp() WHERE id = $1`,
        [event.id, written.digest, written.title, revision]);
        await client.query(`INSERT INTO evimed_frontier.event_revisions (event_id, revision, digest_zh, cause) VALUES ($1, $2, $3, $4)
          ON CONFLICT (event_id, revision) DO NOTHING`, [event.id, revision, written.digest, cause]);
        // The cards name their event by its title; the hot list shows it with its 「最新进展」.
        await bumpFrontierVersion(client, FRONTIER_META_KEYS.contentVersion);
        if (hot.includes(String(event.id))) await bumpFrontierVersion(client, FRONTIER_META_KEYS.hotVersion);
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
    const rows = (await this.database.query(`SELECT ei.role, s.id AS source_id, s.name AS source_name, s.owner_entity, s.source_type,
        i.published_at, i.timeline_at, i.title_raw, i.title_zh, i.summary_zh, t.abstract_raw, t.body_excerpt
      FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id
      JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
      WHERE ei.event_id = $1 AND i.state = 'published' AND s.enabled
      ORDER BY (ei.role = 'primary') DESC, i.timeline_at DESC, i.id DESC LIMIT ${DIGEST_REPORTS}`, [eventId])).rows ?? [];
    return rows.map((row) => ({
      // The digest is prose a reader reads: the institution, never the feed (plan 2026-09-23 §6.5 #5).
      role: row.role, sourceName: frontierSourceDisplayName({ id: row.source_id, name: row.source_name, ownerEntity: row.owner_entity }),
      sourceTypeLabel: null, publishedAt: iso(row.published_at ?? row.timeline_at),
      titleRaw: row.title_raw, titleZh: row.title_zh, summaryZh: row.summary_zh, text: row.abstract_raw || row.body_excerpt || null,
    }));
  }

  // ───────────────────────── the event page ─────────────────────────

  /**
   * One event as the page reads it, or where it went, or null.
   * `{ redirect }` for a merged event's old public id — its row, or an alias.
   * `order` puts its reports (the timeline) and its developments in time
   * order, newest (`desc`) or oldest (`asc`) first; without it the reports
   * keep the page's first order — first-hand sources, then the newest.
   * `developments` are the other events of its story (`follows` links, two
   * hops: `frontierStoryEventIds`), each by its representative report.
   * @param {string} publicId @param {{ order?: "asc" | "desc" | null }} [options]
   * @returns {Promise<null | { redirect: string } | { event: any, members: Array<{ rowId: string, role: string }>,
   *   related: Array<{ id: string, title: string, relation: string, at: string | null }>, specialties: string[],
   *   heat: number | null, institutions: { total: number, byType: Array<{ type: string, count: number }> },
   *   trend: Array<{ at: string, heat: number | null }> | null, primary: "official" | "guideline" | "paper" | null,
   *   developments: Array<{ eventId: string, itemId: string, title: string, sourceName: string, at: string,
   *     relation: "follows", position: "earlier" | "later" }> }>}
   */
  async read(publicId, { order = null } = {}) {
    if (order != null && order !== "asc" && order !== "desc") throw Object.assign(new Error("The order is invalid."), { code: "frontier_query_invalid" });
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
    const members = (await this.database.query(`SELECT ei.item_id, ei.role, i.specialties, i.public_id, i.doi, i.pmid, i.registry_ids,
        i.title_zh, i.title_raw, i.summary_zh, s.owner_entity FROM evimed_frontier.event_items ei
      JOIN evimed_frontier.items i ON i.id = ei.item_id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE ei.event_id = $1 AND i.state = 'published' AND s.enabled
      ORDER BY ${order ? `i.timeline_at ${order.toUpperCase()}, i.id ${order.toUpperCase()}` : "(ei.role = 'primary') DESC, i.timeline_at DESC, i.id DESC"}`,
    [event.id])).rows ?? [];
    if (!members.length) return null;
    const related = (await this.database.query(`SELECT l.relation, other.public_id, other.title_zh, other.last_at, l.linked_at
      FROM evimed_frontier.event_links l
      JOIN evimed_frontier.events other ON other.id = CASE WHEN l.from_event_id = $1 THEN l.to_event_id ELSE l.from_event_id END
      WHERE (l.from_event_id = $1 OR l.to_event_id = $1) AND other.merged_into IS NULL AND other.report_count > 0
      ORDER BY other.last_at DESC LIMIT 20`, [event.id])).rows ?? [];
    /** @type {Map<string, number>} */
    const tally = new Map();
    for (const row of members) for (const key of Array.isArray(row.specialties) ? row.specialties : []) tally.set(key, (tally.get(key) ?? 0) + 1);
    // What the page's side column says (plan 2026-09-23 §6.5 #4), computed
    // now from the same visible members: the heat, the institutions of the
    // last 72 hours by kind, the hourly trend and the first-hand material.
    const now = this.now();
    const facts = this.#asMembers((await this.#members(this.database, [String(event.id)])).get(String(event.id)) ?? []);
    return {
      event,
      members: members.map((row) => ({ rowId: String(row.item_id), role: row.role, id: row.public_id, owner: row.owner_entity,
        title: row.title_zh || row.title_raw, summary: row.summary_zh ?? null,
        studyIds: [...(row.doi ? [`doi:${String(row.doi).toLowerCase()}`] : []), ...(row.pmid ? [`pmid:${row.pmid}`] : []),
          ...(Array.isArray(row.registry_ids) ? row.registry_ids.map(id => `registry:${String(id).toUpperCase()}`) : [])] })),
      related: related.map((row) => ({ id: row.public_id, title: row.title_zh, relation: row.relation, at: iso(row.last_at ?? row.linked_at) })),
      specialties: [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 3).map(([key]) => key),
      heat: facts.length ? frontierHeatDisplay(frontierEventHeat({ members: facts, now })) : null,
      institutions: frontierEventInstitutions({ members: facts, now }),
      trend: frontierHeatTrend({ members: facts, now }),
      primary: frontierPrimaryKind(facts),
      developments: await this.#developments(event, order ?? "desc"),
    };
  }

  /**
   * The other events of an event's story, each by its representative report (a regulator's own notice, then the party's own
   * text, then a selected report, the higher score, the earliest: `frontierRepresentative`), in time order.
   * @param {any} event its row @param {"asc" | "desc"} order
   */
  async #developments(event, order) {
    const story = await frontierStoryEventIds(this.database, event.id);
    const reports = await frontierEventReports(this.database, story);
    const rows = story.flatMap((id) => {
      const row = frontierRepresentative(reports.get(id) ?? []);
      return row ? [{
        eventId: String(row.event_public_id), itemId: String(row.public_id), title: String(row.title_zh || row.title_raw),
        sourceName: frontierSourceDisplayName({ id: row.source_id, name: row.source_name, ownerEntity: row.owner_entity }),
        at: new Date(row.timeline_at).toISOString(), relation: /** @type {const} */ ("follows"),
        position: /** @type {"earlier" | "later"} */ (new Date(row.event_first_at).getTime() < new Date(event.first_at).getTime() ? "earlier" : "later"),
      }] : [];
    });
    const sign = order === "asc" ? 1 : -1;
    return rows.sort((left, right) => sign * (Date.parse(left.at) - Date.parse(right.at)) || left.itemId.localeCompare(right.itemId));
  }

  status() {
    return { lastError: this.lastError, lastHot: this.lastHot, counters: { ...this.counters } };
  }
}
