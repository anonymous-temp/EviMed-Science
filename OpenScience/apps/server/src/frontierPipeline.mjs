/**
 * The frontier feed's processing pipeline (「前沿动态」 处理管线, plan §10.3).
 *
 * The plugin delivers normalised, enriched entries; this module turns them
 * into what a reader sees: drop the defective, merge what another source
 * already brought, screen, fetch the text, promote, edit, verify, label,
 * select, publish, embed. `processBatch()` does one bounded round of all of
 * it; the worker calls it every poll interval, `PROCESS_CONCURRENCY` at once.
 *
 * State machines (plan §10.3.1):
 *
 *   entries: received → held (waiting for text) → merged | screened-out | promoted | dropped | failed
 *            backfill (never processed)
 *   items:   screened → scored → published ; withdrawn ; failed
 *
 * Hidden knowledge:
 *
 * - **The queues are the tables.** Entries (`received`/`held`, due) and items
 *   (`screened`/`scored`, and published items whose edit is still owed) are
 *   claimed with `FOR UPDATE SKIP LOCKED` and a lease, the way `ProductJobs`
 *   claims jobs; a lease that expires counts as an attempt, and the third
 *   attempt fails the row with its last reason (plan §10.4.4). A retry that is
 *   only waiting — for text, for a duplicate in flight, for tomorrow's budget
 *   — is a `hold_until`, never an attempt.
 * - **An item exists from the moment an entry passes screening** (state
 *   `screened`, invisible), so an entry held for days waiting for its
 *   abstract is visible to deduplication as in flight: the PubMed sighting of
 *   the same paper waits for it instead of becoming a second item. The item
 *   is *promoted* when its text snapshot (`item_texts`) exists; only promoted
 *   items are edited and published.
 * - **Deduplication keys the event, not the object, for registries**
 *   (review #10): an entry keyed `reg:NCT…:results-posted:…` or `fda:…` is
 *   looked up by that key alone — its trial page URL and its bare registry id
 *   would merge "results posted" into "registered". Bare registry ids are
 *   written to `item_keys` for clustering only and never looked up here.
 * - **Nothing waits for money.** When the day's budget is spent, or the hour
 *   is the provider's peak, or the model is unreachable, a screened item is
 *   published with its original title and source (`verification: pending`,
 *   never selected) and edited later, when it is allowed; an entry that still
 *   needs screening waits for the budget (collect only). Safety feeds,
 *   regulators and authority-5 journals are edited at peak and past 80% of
 *   the budget (plan §10.3.6, §10.3.10).
 * - **`timeline_at` is decided once, at publication** (review #11): the
 *   publication instant, or the source's date when that is more than 72 hours
 *   older. An item that waited five days for its abstract still reaches today.
 * - **Every reader-visible change moves `meta.content_version` in the same
 *   transaction** (review #14), and leaves an `item_changes` row for
 *   downstream copies.
 * - **Selection is serialized** by one advisory lock, so two concurrent
 *   batches cannot both take a source's third slot or both fill a lane's floor.
 *   Selection is sticky: a later re-score never unselects.
 * - **The number check reads what the model was shown.** The edit stores the
 *   exact item text it sent (`item_texts.model_input` + SHA-256); until the
 *   first edit that column holds the text the edit will use.
 *
 * @module frontierPipeline
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FRONTIER_ITEM_FLAGS,
  FRONTIER_LANES,
  FRONTIER_SOURCE_TYPE_LABELS_ZH,
  doiOf,
  frontierAuthorityScore,
  frontierEvidenceFromPublicationTypes,
  isFrontierMastheadTitle,
  isPeak,
} from "@evimed/domain";
import { FRONTIER_EDITOR_VERSION, FRONTIER_SCREEN_BATCH, FRONTIER_SCREEN_EXCERPT_CHARS, buildModelInput, isChineseTitle } from "./frontierEditor.mjs";
import { FrontierGlossary, FrontierGlossaryStore } from "./frontierGlossary.mjs";
import { bumpFrontierVersion, migrateFrontier } from "./frontierPersistence.mjs";
import { tsvectorLiteral } from "./kbChunker.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long an entry waits before the plugin is asked for its text again (plan §10.3.4). */
export const FRONTIER_TEXT_HOLD_MS = 12 * HOUR;
/** After this long from first sight an entry proceeds with what it has (`no-abstract`). */
export const FRONTIER_TEXT_GIVE_UP_MS = 5 * DAY;
/** A plugin that did not answer is asked again sooner than one that said "pending". */
export const FRONTIER_TEXT_RETRY_MS = 15 * MINUTE;
/** An entry whose work is already in flight under another entry waits this long. */
export const FRONTIER_IN_FLIGHT_WAIT_MS = 10 * MINUTE;
/** Claims per row before it fails with its last reason. */
export const FRONTIER_MAX_ATTEMPTS = 3;
/** The 72-hour rule of `timeline_at` (plan §6.1). */
export const FRONTIER_TIMELINE_WINDOW_MS = 72 * HOUR;
/** A lane with an item at or above this score today gets at least one selected. */
export const FRONTIER_LANE_FLOOR_SCORE = 60;
/** Published items still owed an edit are edited only this long after publication. */
export const FRONTIER_DEFERRED_EDIT_WINDOW_MS = 7 * DAY;
/** Items embedded by the pipeline (older ones are the rebuild script's). */
export const FRONTIER_EMBED_WINDOW_MS = 30 * DAY;
/** Selected items a source may place per day; an authority-5 journal five. */
export const FRONTIER_SOURCE_DAILY_CAP = 3;
export const FRONTIER_TOP_JOURNAL_DAILY_CAP = 5;

const ENTRY_BATCH = FRONTIER_SCREEN_BATCH;
const ITEM_BATCH = 20;
const DEFERRED_BATCH = 8;
const EMBED_BATCH = 16;
const TITLE_DUPLICATE_WINDOW_MS = 7 * DAY;
const TITLE_DUPLICATE_SIMILARITY = 0.85;
const TITLE_DUPLICATE_MIN_CHARS = 24;
const SELECT_LOCK = "evimed-frontier-select";

/** Crossref `update-to` types → the link kind and the flag it puts on the work. */
const UPDATE_KINDS = Object.freeze({
  retraction: { kind: "retraction", flag: "retracted", reason: "retracted" },
  partial_retraction: { kind: "retraction", flag: "retracted", reason: "retracted" },
  withdrawal: { kind: "withdrawal", flag: "retracted", reason: "retracted" },
  removal: { kind: "withdrawal", flag: "retracted", reason: "retracted" },
  expression_of_concern: { kind: "expression-of-concern", flag: "expression-of-concern", reason: "expression-of-concern" },
  correction: { kind: "correction", flag: "corrected", reason: "corrected" },
  corrigendum: { kind: "correction", flag: "corrected", reason: "corrected" },
  erratum: { kind: "correction", flag: "corrected", reason: "corrected" },
  new_version: { kind: "new-version", flag: null, reason: null },
});
/** What a link to an item says about it. */
const LINK_FLAGS = Object.freeze({ retraction: "retracted", withdrawal: "retracted", correction: "corrected", "expression-of-concern": "expression-of-concern" });

// ───────────────────────── pure decisions (unit-tested) ─────────────────────────

/**
 * A calendar day in a time zone, as instants: [start, end).
 * @param {Date} now @param {string} timeZone
 * @returns {{ start: Date, end: Date, day: string }}
 */
export function frontierDayWindow(now, timeZone) {
  const startOf = (/** @type {Date} */ at) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((part) => [part.type, part.value]));
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const offset = wall - Math.floor(at.getTime() / 1000) * 1000;
    return { start: new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offset), day: `${parts.year}-${parts.month}-${parts.day}` };
  };
  const today = startOf(now);
  const tomorrow = startOf(new Date(today.start.getTime() + 26 * HOUR));
  return { start: today.start, end: tomorrow.start, day: today.day };
}

/**
 * The budget's state: `exhausted` from 100% of the day's budget (no model
 * calls), `throttled` from 80% (only urgent items edited). A budget of 0 is
 * no budget, as every spend limit on this platform reads 0.
 * @param {number} spentCny @param {number} budgetCny
 * @returns {"ok" | "throttled" | "exhausted"}
 */
export function frontierBudgetState(spentCny, budgetCny) {
  if (!(budgetCny > 0)) return "ok";
  if (spentCny >= budgetCny) return "exhausted";
  if (spentCny >= budgetCny * 0.8) return "throttled";
  return "ok";
}

/** Safety feeds, regulators and authority-5 journals: edited at peak and past 80%, never waiting for an abstract.
 * @param {any} source */
export function isUrgentSource(source) {
  return source?.safety_feed === true || source?.source_type === "regulator"
    || (source?.source_type === "journal" && Number(source?.authority) >= 5);
}

/** The lanes a source's items may take: its own, or all eight for a mixed one. @param {any} source @returns {string[]} */
export function allowedLanes(source) {
  return FRONTIER_LANES.includes(source?.lane) ? [source.lane] : [...FRONTIER_LANES];
}

/**
 * Whether an item may be edited now.
 * @param {{ source: any, budget: { state: string }, offpeak: boolean, now: Date, available: boolean }} input
 * @returns {{ edit: boolean, reason: "ok" | "unavailable" | "exhausted" | "throttled" | "peak" }}
 */
export function frontierEditDecision({ source, budget, offpeak, now, available }) {
  if (!available) return { edit: false, reason: "unavailable" };
  if (budget.state === "exhausted") return { edit: false, reason: "exhausted" };
  if (isUrgentSource(source)) return { edit: true, reason: "ok" };
  if (budget.state === "throttled") return { edit: false, reason: "throttled" };
  if (offpeak && isPeak(now)) return { edit: false, reason: "peak" };
  return { edit: true, reason: "ok" };
}

/** @param {string} canonicalUrl */
function urlKey(canonicalUrl) {
  return `url:${createHash("sha256").update(String(canonicalUrl)).digest("hex")}`;
}

/**
 * Every key an entry is known by: `dedupe` keys are looked up and claimed,
 * `cluster` keys (bare registry ids) are written for event clustering only.
 * An event-level identity (`reg:`/`fda:`) dedupes by itself alone.
 * @param {any} entry @returns {{ dedupe: string[], cluster: string[] }}
 */
export function entryKeys(entry) {
  const identity = String(entry.identity_key);
  const dedupe = new Set([identity]);
  if (!/^(reg|fda):/.test(identity)) {
    const doi = doiOf(entry.doi);
    if (doi) dedupe.add(`doi:${doi}`);
    if (/^\d{1,10}$/.test(String(entry.pmid ?? ""))) dedupe.add(`pmid:${entry.pmid}`);
    if (entry.canonical_url) dedupe.add(urlKey(entry.canonical_url));
  }
  const cluster = new Set();
  for (const id of Array.isArray(entry.registry_ids) ? entry.registry_ids : []) {
    const key = `reg:${String(id).trim().toUpperCase()}`;
    if (key.length > 4 && !dedupe.has(key)) cluster.add(key);
  }
  return { dedupe: [...dedupe], cluster: [...cluster] };
}

/** Whether a feed's own summary can stand in for an abstract. @param {any} entry */
export function usableSummary(entry) {
  const defects = Array.isArray(entry?.defects) ? entry.defects : [];
  return typeof entry?.summary_raw === "string" && entry.summary_raw.trim().length >= 80
    && !defects.some((defect) => ["truncated-summary", "short-summary", "no-summary"].includes(defect));
}

/**
 * Why an entry is dropped before anything else, or null (plan §10.3.2).
 * @param {any} entry @returns {string | null}
 */
export function frontierDropReason(entry) {
  if (entry?.facts?.is_masthead === true || isFrontierMastheadTitle(entry?.title_raw)) return "masthead";
  const defects = Array.isArray(entry?.defects) ? entry.defects : [];
  if (defects.includes("encoding") && /\uFFFD/.test(String(entry?.title_raw ?? ""))) return "encoding";
  return null;
}

/** Whether an entry is a correction, retraction or concern notice about another work. @param {any} entry */
export function isCorrectionNotice(entry) {
  return entry?.facts?.is_correction_notice === true || (Array.isArray(entry?.facts?.update_to) && entry.facts.update_to.length > 0);
}

/**
 * What the text answer means for an entry (plan §10.3.4, §14.4).
 * `promote` — the text is in (or will not come): snapshot it, the entry is done;
 * `promote-hold` — go on with what there is and ask again later (a source
 *   that never waits, or a usable feed summary);
 * `hold` — wait for the text.
 * @param {{ status: "available" | "pending" | "unavailable" | "error", entry: any, source: any, promoted: boolean, now: Date }} input
 * @returns {{ action: "promote" | "promote-hold" | "hold", holdMs: number }}
 */
export function frontierTextDecision({ status, entry, source, promoted, now }) {
  const age = now.getTime() - new Date(entry.first_seen_at).getTime();
  if (status === "available" || status === "unavailable" || age >= FRONTIER_TEXT_GIVE_UP_MS) return { action: "promote", holdMs: 0 };
  const holdMs = status === "error" ? FRONTIER_TEXT_RETRY_MS : FRONTIER_TEXT_HOLD_MS;
  if (promoted || isUrgentSource(source) || usableSummary(entry)) return { action: "promote-hold", holdMs };
  return { action: "hold", holdMs };
}

/**
 * The evidence type code decides, or null for the model's pick.
 * Trial registries are `other` (registered, results not in a journal), FDA
 * database actions a regulatory decision, safety feeds safety notices,
 * company newsrooms press releases — all by the registry (`registry`); an
 * explicit PubMed research type replaces the model (`pubmed-types`).
 * @param {{ source: any, identityKey: string, publicationTypes: unknown }} input
 * @returns {{ fixed: { type: string, basis: "registry" | "pubmed-types" } | null, demote: boolean }}
 */
export function frontierEvidenceDecision({ source, identityKey, publicationTypes }) {
  if (/^reg:/.test(identityKey)) return { fixed: { type: "other", basis: "registry" }, demote: false };
  if (/^fda:/.test(identityKey)) return { fixed: { type: "regulatory-decision", basis: "registry" }, demote: false };
  if (source?.safety_feed === true) return { fixed: { type: "safety-notice", basis: "registry" }, demote: false };
  if (source?.source_type === "company") return { fixed: { type: "press-release", basis: "registry" }, demote: false };
  const types = frontierEvidenceFromPublicationTypes(publicationTypes);
  if (types.evidenceType) return { fixed: { type: types.evidenceType, basis: "pubmed-types" }, demote: types.demote };
  return { fixed: null, demote: false };
}

/**
 * An item's flags, every one decided by code (plan §10.3.8), in the
 * vocabulary's order.
 * @param {{ source: any, entry: any, item: any, text: any, modelFlags?: string[], linkFlags?: string[] }} input
 * @returns {string[]}
 */
export function frontierItemFlags({ source, entry, item, text, modelFlags = [], linkFlags = [] }) {
  const flags = new Set(linkFlags);
  const preprint = source?.source_type === "preprint";
  if (preprint) flags.add("preprint");
  const paper = Boolean(item?.doi || item?.pmid);
  if ((source?.source_type === "company" && !paper) || modelFlags.includes("press-release")) flags.add("press-release");
  if (!text?.abstract_raw && !text?.body_excerpt && !usableSummary(entry)) flags.add("no-abstract");
  const defects = Array.isArray(entry?.defects) ? entry.defects : [];
  if (item?.date_precision === "inferred" || defects.includes("no-date") || defects.includes("future-date")) flags.add("date-inferred");
  // 涉华: a Chinese source, or a Chinese affiliation among the authors (contract
  // 1.1.0 `affiliation_countries`); never the model's say.
  const countries = Array.isArray(text?.enrichment?.affiliation_countries) ? text.enrichment.affiliation_countries : [];
  if (["CN", "CHN", "CHINA"].includes(String(source?.region ?? "").trim().toUpperCase())
    || countries.some((/** @type {unknown} */ country) => String(country).trim().toUpperCase() === "CN")) flags.add("china");
  const event = String(entry?.facts?.trial_event ?? "");
  if (/^reg:/.test(String(entry?.identity_key ?? item?.identity_key ?? "")) && event !== "results-posted") flags.add("registry-unpublished");
  if (event === "updated") flags.add("data-updated");
  if (preprint && text?.enrichment?.published_version_doi) flags.add("published-version");
  return FRONTIER_ITEM_FLAGS.filter((flag) => flags.has(flag));
}

/**
 * `timeline_at` at publication: the publication instant, or the source's
 * own date when that is more than 72 hours older (plan §6.1, review #11).
 * @param {Date} visibleAt @param {Date | string | null} publishedAt @returns {Date}
 */
export function frontierTimelineAt(visibleAt, publishedAt) {
  const published = publishedAt ? new Date(publishedAt).getTime() : NaN;
  if (!Number.isFinite(published) || visibleAt.getTime() - published <= FRONTIER_TIMELINE_WINDOW_MS) return visibleAt;
  return new Date(published);
}

/**
 * Whether an item is a safety alert: shown red, never scored out, straight
 * into 精选 (plan §4.3, §6.3).
 *
 * - A recall carries the regulator's own severity scale, and only Class I —
 *   a reasonable probability of serious harm or death — is an alert; Class II
 *   and III are scored like any regulatory decision. openFDA's enforcement
 *   feed held 59 Class II recalls to 4 Class I in its first production week
 *   (2026-09-22); marked whole, 精选 would have been a recall list.
 * - An official safety feed says so by its registry row (§10.3.8).
 * - A regulator's mixed column cannot be marked whole — NMPA's 药品其他公告通告
 *   carries ADR bulletins beside reference-product catalogues and customs
 *   pilots, FDA's recall feed carries pasta and potato chips beside drugs and
 *   devices — so there the edit decides: a notice it types `safety-notice` and
 *   files under 药物安全. Both were found on the first live runs, shown red.
 * @param {{ source: any, evidenceType: string | null | undefined, lane?: string | null, facts?: any }} input
 */
export function frontierSafetyAlert({ source, evidenceType, lane = null, facts = null }) {
  const regulatorOrFeed = source?.safety_feed === true || source?.source_type === "regulator";
  const recallClass = typeof facts?.recall_class === "string" ? facts.recall_class.trim() : "";
  if (recallClass) return regulatorOrFeed && /^class\s+i$/i.test(recallClass);
  if (source?.safety_feed === true) return true;
  return source?.source_type === "regulator" && evidenceType === "safety-notice" && lane === "safety";
}

/**
 * Whether a published item is selected, and by which rule (plan §6.3). A
 * safety alert is selected whatever its score; otherwise a verified,
 * scored item at or above the threshold, while its source has room today.
 * @param {{ safetyAlert: boolean, verification: string, scoreTotal: number | null, demoted: boolean, flags: string[],
 *           source: any, selectedToday: number, threshold: number }} input
 * @returns {{ selected: boolean, rule: "safety-bypass" | "threshold" | null, capped?: boolean }}
 */
export function frontierSelectionDecision({ safetyAlert, verification, scoreTotal, demoted, flags, source, selectedToday, threshold }) {
  if (safetyAlert) return { selected: true, rule: "safety-bypass" };
  if (demoted || flags.includes("retracted")) return { selected: false, rule: null };
  if (!["passed", "repaired"].includes(verification) || scoreTotal == null || scoreTotal < threshold) return { selected: false, rule: null };
  const cap = source?.source_type === "journal" && Number(source?.authority) >= 5 ? FRONTIER_TOP_JOURNAL_DAILY_CAP : FRONTIER_SOURCE_DAILY_CAP;
  if (selectedToday >= cap) return { selected: false, rule: null, capped: true };
  return { selected: true, rule: "threshold" };
}

/** A title in the form near-duplicates are compared in without trigrams. @param {unknown} title */
export function titleKey(title) {
  return String(title ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** @param {unknown} error */
function codeOf(error) {
  const value = /** @type {any} */ (error);
  return typeof value?.code === "string" && /^[a-z0-9_]{2,80}$/.test(value.code) ? value.code : "frontier_processing_failed";
}

/** @param {string[]} flags */
function orderedFlags(flags) {
  return FRONTIER_ITEM_FLAGS.filter((flag) => flags.includes(flag));
}

// ───────────────────────── the pipeline ─────────────────────────

/**
 * @typedef {{ claimed: number, promoted: number, published: number, merged: number, screenedOut: number, held: number,
 *             failed: number, dropped: number, waiting: number, deferred: number, edited: number, rescored: number, embedded: number }} FrontierBatchSummary
 */

export class FrontierPipeline {
  /**
   * @param {{ database: any, editor: any, plugin: any, embedder?: any, glossary?: any, config?: Record<string, any>,
   *           now?: () => Date, workerId?: string }} options
   *   `editor` a `FrontierEditor` (its `owner` is the operator's internal
   *   project, and the budget is read for it); `plugin` offers `text(entryId)`
   *   (`KnowledgePluginClient`); `embedder` a `KbEmbedder` or null; `glossary`
   *   a `FrontierGlossaryStore` (default: read from the database) or a
   *   `FrontierGlossary`.
   */
  constructor({ database, editor, plugin, embedder = null, glossary = null, config = {}, now = () => new Date(), workerId = `frontier-${randomUUID()}` }) {
    if (!database) throw new TypeError("The frontier pipeline needs a database.");
    if (typeof editor?.screen !== "function" || typeof editor?.edit !== "function") throw new TypeError("The frontier pipeline needs an editor.");
    if (typeof plugin?.text !== "function") throw new TypeError("The frontier pipeline needs the plugin client.");
    this.database = database;
    this.editor = editor;
    this.plugin = plugin;
    this.embedder = embedder;
    this.config = config ?? {};
    this.now = now;
    this.workerId = String(workerId).slice(0, 120);
    this.glossaryStore = glossary instanceof FrontierGlossary ? { current: async () => glossary }
      : glossary && typeof glossary.current === "function" ? glossary : new FrontierGlossaryStore({ database });
    this.leaseMs = Math.max(MINUTE, Number(this.config.frontierLeaseMs) || 10 * MINUTE);
    this.threshold = Number.isFinite(Number(this.config.frontierSelectThreshold)) ? Number(this.config.frontierSelectThreshold) : 70;
    this.budgetCny = Number.isFinite(Number(this.config.frontierDailyBudgetCny)) ? Number(this.config.frontierDailyBudgetCny) : 10;
    this.offpeak = this.config.frontierOffpeak !== false;
    this.timeZone = String(this.config.frontierTimeZone || this.config.frontierTimezone || "Asia/Shanghai");
    // The width the schema's vector column is created with; it must be the
    // one the server migrates with, or the migration would empty the vectors.
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || 1024;
    /** Observable counters (principle 15). */
    this.counters = {
      batches: 0, claimedEntries: 0, claimedItems: 0, promoted: 0, published: 0, merged: 0, screenedOut: 0, held: 0,
      failed: 0, dropped: 0, waiting: 0, deferred: 0, edited: 0, rescored: 0, embedded: 0, embedFailures: 0,
      titleDuplicates: 0, notices: 0, laneFloor: 0, selected: 0, capped: 0, releaseFailures: 0,
      editSkipped: { unavailable: 0, exhausted: 0, throttled: 0, peak: 0 },
    };
    /** @type {string | null} */
    this.lastError = null;
    /** @type {string | null} */
    this.lastEmbedError = null;
    /** @type {{ spentCny: number, budgetCny: number, state: string, measuredAt: string } | null} */
    this.lastBudget = null;
    /** @type {(FrontierBatchSummary & { at: string }) | null} */
    this.lastBatch = null;
  }

  /** The owner model spend is charged to (the editor's), or null. */
  get owner() {
    const owner = this.editor?.owner;
    return owner?.userId && owner?.projectId ? owner : null;
  }

  /**
   * Today's `frontier` spend (the time zone's day) against the day's budget:
   * settled cost plus what is still reserved or uncertain, of the internal
   * project's `frontier` rows (the same sum the status route shows).
   * @param {Date} [now]
   * @returns {Promise<{ spentCny: number, budgetCny: number, state: "ok" | "throttled" | "exhausted", measured: boolean }>}
   */
  async budget(now = this.now()) {
    const budgetCny = this.budgetCny;
    const owner = this.owner;
    let spentCny = 0;
    let measured = false;
    if (owner) {
      const table = await this.database.query("SELECT to_regclass('evimed_usage.model_requests') AS name");
      if (table.rows[0]?.name) {
        const { start } = frontierDayWindow(now, this.timeZone);
        const result = await this.database.query(`SELECT coalesce(sum(CASE
            WHEN status='settled' THEN coalesce(actual_cost, 0)
            WHEN status IN ('reserved','uncertain') THEN reserved_cost ELSE 0 END), 0) AS spent
          FROM evimed_usage.model_requests
          WHERE user_id=$1 AND project_id=$2 AND purpose='frontier' AND created_at >= $3::timestamptz`,
        [owner.userId, owner.projectId, start.toISOString()]);
        spentCny = Math.round(Number(result.rows[0]?.spent ?? 0) * 10_000) / 10_000;
        measured = true;
      }
    }
    const state = frontierBudgetState(spentCny, budgetCny);
    this.lastBudget = { spentCny, budgetCny, state, measuredAt: now.toISOString() };
    return { spentCny, budgetCny, state, measured };
  }

  /**
   * One bounded round: claimed entries, then promoted items, then owed edits,
   * the lane floor, and embeddings.
   * @returns {Promise<FrontierBatchSummary>}
   */
  async processBatch() {
    /** @type {FrontierBatchSummary} */
    const summary = { claimed: 0, promoted: 0, published: 0, merged: 0, screenedOut: 0, held: 0, failed: 0, dropped: 0,
      waiting: 0, deferred: 0, edited: 0, rescored: 0, embedded: 0 };
    try {
      const capabilities = await migrateFrontier(this.database, { dimension: this.dimension });
      const now = this.now();
      const budget = await this.budget(now);
      const glossary = await this.glossaryStore.current();
      const context = { now, budget, capabilities, glossary, summary };
      await this.#processEntries(context);
      await this.#processItems(context);
      await this.#processOwedEdits(context);
      if (summary.published || summary.rescored) await this.#laneFloor(context);
      summary.embedded += await this.#embed(context);
      this.counters.batches += 1;
      for (const key of /** @type {Array<keyof FrontierBatchSummary>} */ (Object.keys(summary))) {
        if (key in this.counters && typeof this.counters[key] === "number") this.counters[key] += summary[key];
      }
      this.lastBatch = { at: now.toISOString(), ...summary };
      this.lastError = null;
      return summary;
    } catch (error) {
      this.lastError = codeOf(error);
      throw error;
    }
  }

  status() {
    return {
      workerId: this.workerId, lastError: this.lastError, lastEmbedError: this.lastEmbedError,
      lastBatch: this.lastBatch, budget: this.lastBudget, counters: structuredClone(this.counters),
      editor: typeof this.editor.status === "function" ? this.editor.status() : null,
    };
  }

  // ───────────────────────── entries ─────────────────────────

  /** @param {any} context */
  async #processEntries(context) {
    const { now, summary } = context;
    const claimed = await this.#claimEntries(now);
    summary.claimed += claimed.length;
    this.counters.claimedEntries += claimed.length;
    if (!claimed.length) return;
    const sources = await this.#sources(claimed.map((entry) => entry.source_id));
    // The order work is done in is the order a duplicate is resolved in: of
    // two sightings of one work in one batch, the more authoritative source's
    // becomes the item and the other waits to be merged into it.
    const rank = (/** @type {any} */ entry) => {
      const source = sources.get(entry.source_id);
      return [source?.safety_feed ? 0 : 1, source?.source_type === "regulator" ? 0 : 1, -(Number(source?.authority) || 0), Number(entry.id)];
    };
    claimed.sort((left, right) => {
      const [a, b] = [rank(left), rank(right)];
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
    });
    const prior = await this.#priorItems(claimed);
    /** @type {any[]} */
    const fresh = [];
    // Two revisions of one entry in one batch: the newest does the work.
    const newest = new Map();
    for (const entry of claimed) {
      const seen = newest.get(entry.plugin_entry_id);
      if (!seen || Number(seen.revision) < Number(entry.revision)) newest.set(entry.plugin_entry_id, entry);
    }
    for (const entry of claimed) {
      try {
        if (entry.attempts >= FRONTIER_MAX_ATTEMPTS) {
          await this.#finishEntry(entry, "failed", entry.state_reason || "attempts_exhausted");
          summary.failed += 1;
          continue;
        }
        const source = sources.get(entry.source_id);
        if (newest.get(entry.plugin_entry_id) !== entry) {
          // An older revision that already feeds an item is superseded (and
          // released) by the newest one's revision step below.
          if (entry.item_id != null) continue;
          await this.#finishEntry(entry, "dropped", "superseded-revision");
          summary.dropped += 1;
          continue;
        }
        if (entry.item_id != null) {
          await this.#textStep(entry, Number(entry.item_id), source, context);
          continue;
        }
        const earlier = prior.get(Number(entry.id));
        if (earlier) {
          await this.#revision(entry, earlier, source, context);
          continue;
        }
        const drop = frontierDropReason(entry);
        if (drop) {
          await this.#finishEntry(entry, "dropped", drop);
          summary.dropped += 1;
          continue;
        }
        if (isCorrectionNotice(entry)) {
          await this.#notice(entry);
          summary.dropped += 1;
          continue;
        }
        fresh.push(entry);
      } catch (error) {
        await this.#failEntry(entry, error, summary);
      }
    }
    const kept = await this.#dedupe(fresh, sources, context);
    await this.#screenAndPromote(kept, sources, context);
  }

  /** @param {Date} now */
  async #claimEntries(now) {
    const result = await this.database.query(`WITH picked AS (
        SELECT e.id FROM evimed_frontier.entries e
        JOIN evimed_frontier.sources s ON s.id = e.source_id
        WHERE e.state IN ('received', 'held') AND (e.hold_until IS NULL OR e.hold_until <= $1)
          AND (e.lease_until IS NULL OR e.lease_until <= $1)
        ORDER BY s.safety_feed DESC, (s.source_type = 'regulator') DESC, s.authority DESC, e.id
        LIMIT $2
        FOR UPDATE OF e SKIP LOCKED)
      UPDATE evimed_frontier.entries e SET lease_owner = $3, lease_until = $4,
        attempts = e.attempts + CASE WHEN e.lease_owner IS NOT NULL THEN 1 ELSE 0 END
      FROM picked WHERE e.id = picked.id
      RETURNING e.*`, [now, ENTRY_BATCH, this.workerId, new Date(now.getTime() + this.leaseMs)]);
    return result.rows;
  }

  /** @param {string[]} ids @returns {Promise<Map<string, any>>} */
  async #sources(ids) {
    const result = await this.database.query("SELECT * FROM evimed_frontier.sources WHERE id = ANY($1::text[])", [[...new Set(ids)]]);
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  /**
   * For each claimed entry, the latest earlier revision of it that already
   * feeds an item — keyed by the claimed entry's id.
   * @param {any[]} entries @returns {Promise<Map<number, { entryId: number, itemId: number, state: string }>>}
   */
  async #priorItems(entries) {
    const result = await this.database.query(`SELECT plugin_entry_id, id, revision, item_id, state FROM evimed_frontier.entries
      WHERE plugin_entry_id = ANY($1::text[]) AND item_id IS NOT NULL ORDER BY revision DESC, id DESC`,
    [[...new Set(entries.map((entry) => entry.plugin_entry_id))]]);
    /** @type {Map<number, { entryId: number, itemId: number, state: string }>} */
    const prior = new Map();
    for (const entry of entries) {
      const row = result.rows.find((candidate) => candidate.plugin_entry_id === entry.plugin_entry_id
        && Number(candidate.revision) < Number(entry.revision) && Number(candidate.id) !== Number(entry.id));
      if (row) prior.set(Number(entry.id), { entryId: Number(row.id), itemId: Number(row.item_id), state: row.state });
    }
    return prior;
  }

  /**
   * End an entry's processing in a terminal (or waiting) state and release it.
   * @param {any} entry @param {string} state @param {string | null} reason
   * @param {{ itemId?: number | null, holdUntil?: Date | null, client?: any }} [options]
   */
  async #finishEntry(entry, state, reason, { itemId = undefined, holdUntil = null, client = null } = {}) {
    await (client ?? this.database).query(`UPDATE evimed_frontier.entries SET state = $2, state_reason = $3,
        item_id = CASE WHEN $4::boolean THEN $5::bigint ELSE item_id END, hold_until = $6,
        lease_owner = NULL, lease_until = NULL
      WHERE id = $1`, [entry.id, state, reason ? String(reason).slice(0, 200) : null, itemId !== undefined, itemId ?? null, holdUntil]);
  }

  /** Release an entry to try again later: a wait, not an attempt. @param {any} entry @param {Date} holdUntil @param {string | null} reason */
  async #waitEntry(entry, holdUntil, reason) {
    await this.database.query(`UPDATE evimed_frontier.entries SET hold_until = $2, state_reason = $3,
        lease_owner = NULL, lease_until = NULL WHERE id = $1`, [entry.id, holdUntil, reason]);
  }

  /** A processing error: an attempt spent; the third fails the entry. @param {any} entry @param {unknown} error @param {FrontierBatchSummary} summary */
  async #failEntry(entry, error, summary) {
    const code = codeOf(error);
    const attempts = Number(entry.attempts) + 1;
    try {
      await this.database.query(`UPDATE evimed_frontier.entries SET attempts = $2::integer, state_reason = $3,
          state = CASE WHEN $2::integer >= $4::integer THEN 'failed' ELSE state END, lease_owner = NULL, lease_until = NULL
        WHERE id = $1`, [entry.id, attempts, code, FRONTIER_MAX_ATTEMPTS]);
      if (attempts >= FRONTIER_MAX_ATTEMPTS) {
        summary.failed += 1;
        // An item the entry created but never promoted fails with it — and a
        // later sighting of the same work adopts it (#adopt) instead of
        // waiting for ever behind it.
        if (entry.item_id != null) {
          await this.database.query(`UPDATE evimed_frontier.items SET state = 'failed', updated_at = clock_timestamp()
            WHERE id = $1 AND state = 'screened' AND NOT EXISTS (SELECT 1 FROM evimed_frontier.item_texts t WHERE t.item_id = $1)`, [entry.item_id]);
        }
      }
    } catch (release) {
      // The lease expires on its own and the next claim counts the attempt;
      // the failure to record it is itself counted.
      this.counters.releaseFailures += 1;
      this.lastError = codeOf(release);
      return;
    }
    this.lastError = code;
  }

  /**
   * A correction, retraction or concern notice (plan §10.3.9): link it to the
   * work it names by DOI, flag that work if it is here, and drop the notice —
   * it is not an item. A notice that arrives first waits in `item_links`; the
   * work picks it up when it is published.
   * @param {any} entry
   */
  async #notice(entry) {
    const noticeDoi = doiOf(entry.doi);
    const targets = (Array.isArray(entry.facts?.update_to) ? entry.facts.update_to : [])
      .map((/** @type {any} */ update) => ({
        update: /** @type {Record<string, any>} */ (UPDATE_KINDS)[String(update?.type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")],
        doi: doiOf(update?.doi),
      }))
      .filter((/** @type {any} */ target) => target.update && target.doi);
    this.counters.notices += 1;
    await this.database.transaction(async (/** @type {any} */ client) => {
      let changed = false;
      for (const { update, doi } of noticeDoi ? targets : []) {
        const target = await client.query("SELECT id, state, flags FROM evimed_frontier.items WHERE lower(doi) = $1 LIMIT 1 FOR UPDATE", [doi]);
        const item = target.rows[0] ?? null;
        await client.query(`INSERT INTO evimed_frontier.item_links (kind, from_doi, to_doi, to_item_id, asserted_by)
          VALUES ($1, $2, $3, $4, 'crossref') ON CONFLICT (kind, from_doi, to_doi) DO UPDATE SET to_item_id = coalesce(evimed_frontier.item_links.to_item_id, excluded.to_item_id)`,
        [update.kind, noticeDoi, doi, item?.id ?? null]);
        if (item && update.flag && !item.flags.includes(update.flag)) {
          await client.query("UPDATE evimed_frontier.items SET flags = $2, updated_at = clock_timestamp() WHERE id = $1",
            [item.id, orderedFlags([...item.flags, update.flag])]);
          if (item.state === "published") {
            await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', $2)", [item.id, update.reason]);
            changed = true;
          }
        }
      }
      if (changed) await bumpFrontierVersion(client);
      await this.#finishEntry(entry, "dropped", noticeDoi && targets.length ? "correction-notice" : "correction-notice-unlinked", { client });
    });
  }

  /**
   * Cross-source deduplication (plan §10.3.3): an entry whose key names a
   * published item is merged into it (「还有谁在说」); one whose key names an
   * item still in flight waits for it; two fresh entries of one work in the
   * same batch — the first (the higher-priority source) goes on, the other
   * waits.
   * @param {any[]} entries @param {any} context @returns {Promise<any[]>} the entries that go on to screening
   */
  async #dedupe(entries, sources, context) {
    const { now, summary } = context;
    if (!entries.length) return [];
    const keysOf = new Map(entries.map((entry) => [entry.id, entryKeys(entry)]));
    const all = [...new Set([...keysOf.values()].flatMap((keys) => keys.dedupe))];
    const found = await this.database.query(`SELECT k.key, i.id, i.state FROM evimed_frontier.item_keys k
      JOIN evimed_frontier.items i ON i.id = k.item_id WHERE k.key = ANY($1::text[])`, [all]);
    const byKey = new Map(found.rows.map((row) => [row.key, { id: Number(row.id), state: row.state }]));
    /** @type {any[]} */
    const kept = [];
    const claimedKeys = new Set();
    for (const entry of entries) {
      const keys = keysOf.get(entry.id);
      try {
        const hit = keys.dedupe.map((key) => byKey.get(key)).find(Boolean);
        if (hit?.state === "failed") {
          // The work failed once; seeing it again is its second chance.
          if (await this.#adopt(entry, hit.id, keys)) {
            for (const key of keys.dedupe) claimedKeys.add(key);
            await this.#textStep({ ...entry, item_id: hit.id }, hit.id, sources.get(entry.source_id), context);
            continue;
          }
        }
        if (hit && ["published", "withdrawn"].includes(hit.state)) {
          await this.#merge(entry, hit.id, keys, "duplicate");
          summary.merged += 1;
          continue;
        }
        if (hit || keys.dedupe.some((key) => claimedKeys.has(key))) {
          await this.#waitEntry(entry, new Date(now.getTime() + FRONTIER_IN_FLIGHT_WAIT_MS), "in-flight-duplicate");
          summary.waiting += 1;
          continue;
        }
        for (const key of keys.dedupe) claimedKeys.add(key);
        kept.push(entry);
      } catch (error) {
        await this.#failEntry(entry, error, summary);
      }
    }
    return kept;
  }

  /**
   * A failed item seen again: the new sighting becomes its entry and the item
   * goes back to the start of its queue (screened, no attempts), keeping its
   * public id and keys. False when it is no longer failed.
   * @param {any} entry @param {number} itemId @param {{ dedupe: string[], cluster: string[] }} keys
   * @returns {Promise<boolean>}
   */
  async #adopt(entry, itemId, keys) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      const revived = await client.query(`UPDATE evimed_frontier.items SET state = 'screened', attempts = 0, lease_owner = NULL,
          lease_until = NULL, updated_at = clock_timestamp()
        WHERE id = $1 AND state = 'failed' RETURNING id`, [itemId]);
      if (!revived.rowCount) return false;
      await client.query(`INSERT INTO evimed_frontier.item_keys (key, item_id) SELECT key, $2 FROM unnest($1::text[]) AS key
        ON CONFLICT (key) DO NOTHING`, [[...keys.dedupe, ...keys.cluster], itemId]);
      await client.query("UPDATE evimed_frontier.entries SET item_id = $2, state_reason = 'adopted-failed-item' WHERE id = $1", [entry.id, itemId]);
      return true;
    });
  }

  /**
   * Record an entry as another road to an item: a mention (when it is another
   * source's), the keys it adds, the entry merged.
   * @param {any} entry @param {number} itemId @param {{ dedupe: string[], cluster: string[] }} keys @param {string} reason
   * @param {any} [client]
   */
  async #merge(entry, itemId, keys, reason, client = null) {
    const work = async (/** @type {any} */ tx) => {
      const item = (await tx.query("SELECT id, state, primary_source_id FROM evimed_frontier.items WHERE id = $1", [itemId])).rows[0];
      const mention = item && item.primary_source_id !== entry.source_id;
      if (mention) {
        await tx.query(`INSERT INTO evimed_frontier.item_mentions (item_id, entry_id, source_id, url, published_at)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (item_id, entry_id) DO NOTHING`,
        [itemId, entry.id, entry.source_id, entry.url, entry.published_at]);
      }
      await tx.query(`INSERT INTO evimed_frontier.item_keys (key, item_id) SELECT key, $2 FROM unnest($1::text[]) AS key
        ON CONFLICT (key) DO NOTHING`, [[...keys.dedupe, ...keys.cluster], itemId]);
      await this.#finishEntry(entry, "merged", reason, { itemId, client: tx });
      // 「还有谁在说」 is on the card: another source's sighting is a change a reader sees.
      if (mention && item.state === "published") await bumpFrontierVersion(tx);
    };
    if (client) await work(client);
    else await this.database.transaction(work);
  }

  /**
   * A new revision of an entry that already feeds an item: it takes the
   * earlier revision's place. As a mention it replaces the earlier mention;
   * as the item's own entry it refreshes the item's raw fields, asks for the
   * text again, and owes the item one re-edit when what it says changed.
   * @param {any} entry @param {{ entryId: number, itemId: number, state: string }} earlier @param {any} source @param {any} context
   */
  async #revision(entry, earlier, source, context) {
    const { summary } = context;
    const keys = entryKeys(entry);
    if (earlier.state === "merged") {
      await this.database.transaction(async (/** @type {any} */ client) => {
        await client.query(`UPDATE evimed_frontier.item_mentions SET entry_id = $3, url = $4, published_at = $5
          WHERE item_id = $1 AND entry_id = $2`, [earlier.itemId, earlier.entryId, entry.id, entry.url, entry.published_at]);
        await this.#merge(entry, earlier.itemId, keys, "revision", client);
      });
      summary.merged += 1;
      return;
    }
    await this.database.transaction(async (/** @type {any} */ client) => {
      const item = (await client.query("SELECT * FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [earlier.itemId])).rows[0];
      const previous = (await client.query("SELECT title_raw, summary_raw FROM evimed_frontier.entries WHERE id = $1", [earlier.entryId])).rows[0];
      const moved = previous?.title_raw !== entry.title_raw || (previous?.summary_raw ?? null) !== (entry.summary_raw ?? null);
      await client.query(`UPDATE evimed_frontier.items SET title_raw = $2, canonical_url = $3,
          doi = coalesce(doi, $4), pmid = coalesce(pmid, $5), registry_ids = $6,
          published_at = CASE WHEN state = 'published' THEN published_at ELSE $7 END,
          date_precision = CASE WHEN state = 'published' THEN date_precision ELSE $8 END,
          editor_version = CASE WHEN state = 'published' AND $9::boolean AND rescored_at IS NULL THEN NULL ELSE editor_version END,
          updated_at = clock_timestamp()
        WHERE id = $1`, [item.id, entry.title_raw, entry.canonical_url, entry.doi, entry.pmid, entry.registry_ids ?? [],
        entry.published_at, entry.date_precision, moved]);
      await client.query(`INSERT INTO evimed_frontier.item_keys (key, item_id) SELECT key, $2 FROM unnest($1::text[]) AS key
        ON CONFLICT (key) DO NOTHING`, [[...keys.dedupe, ...keys.cluster], item.id]);
      await client.query(`UPDATE evimed_frontier.entries SET state = 'merged', state_reason = 'superseded', hold_until = NULL,
          lease_owner = NULL, lease_until = NULL WHERE id = $1 AND state IN ('received', 'held', 'promoted')`, [earlier.entryId]);
      await client.query("UPDATE evimed_frontier.entries SET item_id = $2 WHERE id = $1", [entry.id, item.id]);
      if (item.state === "published" && moved) await bumpFrontierVersion(client);
    });
    await this.#textStep({ ...entry, item_id: earlier.itemId }, earlier.itemId, source, context);
  }

  /**
   * Screen the fresh entries in one call and promote what is kept.
   * @param {any[]} entries @param {Map<string, any>} sources @param {any} context
   */
  async #screenAndPromote(entries, sources, context) {
    const { now, budget, summary } = context;
    if (!entries.length) return;
    // Collect only: nothing to screen with, or nothing to spend.
    if (!this.editor.available || budget.state === "exhausted") {
      const until = budget.state === "exhausted"
        ? frontierDayWindow(now, this.timeZone).end
        : new Date(now.getTime() + FRONTIER_TEXT_RETRY_MS);
      for (const entry of entries) await this.#waitEntry(entry, until, budget.state === "exhausted" ? "budget-exhausted" : "editor-unavailable");
      summary.deferred += entries.length;
      return;
    }
    const inputs = entries.map((entry) => ({
      key: String(entry.id),
      title: entry.title_raw,
      sourceName: sources.get(entry.source_id)?.name ?? entry.source_id,
      excerpt: String(entry.summary_raw ?? "").slice(0, FRONTIER_SCREEN_EXCERPT_CHARS),
      allowedLanes: allowedLanes(sources.get(entry.source_id)),
    }));
    const { verdicts, errors } = await this.editor.screen(inputs);
    for (const entry of entries) {
      const source = sources.get(entry.source_id);
      try {
        const verdict = verdicts.get(String(entry.id));
        if (!verdict) {
          const code = errors.get(String(entry.id)) ?? "frontier_screen_invalid";
          if (code === "usage_budget_exceeded") {
            await this.#waitEntry(entry, frontierDayWindow(now, this.timeZone).end, "budget-exhausted");
            summary.deferred += 1;
          } else await this.#failEntry(entry, Object.assign(new Error(code), { code }), summary);
          continue;
        }
        const keep = verdict.medical && (verdict.news || source?.safety_feed === true);
        if (!keep) {
          await this.#finishEntry(entry, "screened-out", verdict.medical ? "not-news" : "not-medical");
          summary.screenedOut += 1;
          continue;
        }
        const created = await this.#createItem(entry, source, verdict, context);
        if (created.merged) {
          summary.merged += 1;
          continue;
        }
        if (created.waiting || created.itemId === null) {
          summary.waiting += 1;
          continue;
        }
        await this.#textStep({ ...entry, item_id: created.itemId }, created.itemId, source, context);
      } catch (error) {
        await this.#failEntry(entry, error, summary);
      }
    }
  }

  /**
   * The item an entry that passed screening becomes (state `screened`,
   * invisible until published), with every key it is known by. Serialized
   * per key by advisory locks, so two batches cannot create one work twice;
   * a title that is a near duplicate of a published item of the same lane in
   * the last seven days is merged instead (plan §10.3.3).
   * @param {any} entry @param {any} source @param {{ lane: string, specialties: string[], language: string }} verdict @param {any} context
   * @returns {Promise<{ itemId: number | null, merged: boolean, waiting: boolean }>}
   */
  async #createItem(entry, source, verdict, context) {
    const { now, capabilities } = context;
    const keys = entryKeys(entry);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(key)) FROM (SELECT DISTINCT unnest($1::text[]) AS key ORDER BY 1) AS keys", [keys.dedupe]);
      const hit = (await client.query(`SELECT i.id, i.state FROM evimed_frontier.item_keys k JOIN evimed_frontier.items i ON i.id = k.item_id
        WHERE k.key = ANY($1::text[]) LIMIT 1`, [keys.dedupe])).rows[0];
      if (hit) {
        if (hit.state === "failed") {
          await client.query(`UPDATE evimed_frontier.items SET state = 'screened', attempts = 0, lease_owner = NULL, lease_until = NULL,
            updated_at = clock_timestamp() WHERE id = $1`, [hit.id]);
          await client.query(`INSERT INTO evimed_frontier.item_keys (key, item_id) SELECT key, $2 FROM unnest($1::text[]) AS key
            ON CONFLICT (key) DO NOTHING`, [[...keys.dedupe, ...keys.cluster], hit.id]);
          await client.query("UPDATE evimed_frontier.entries SET item_id = $2, state_reason = 'adopted-failed-item' WHERE id = $1", [entry.id, hit.id]);
          return { itemId: Number(hit.id), merged: false, waiting: false };
        }
        if (["published", "withdrawn"].includes(hit.state)) {
          await this.#merge(entry, Number(hit.id), keys, "duplicate", client);
          return { itemId: null, merged: true, waiting: false };
        }
        await client.query(`UPDATE evimed_frontier.entries SET hold_until = $2, state_reason = 'in-flight-duplicate',
          lease_owner = NULL, lease_until = NULL WHERE id = $1`, [entry.id, new Date(now.getTime() + FRONTIER_IN_FLIGHT_WAIT_MS)]);
        return { itemId: null, merged: false, waiting: true };
      }
      const duplicate = await this.#titleDuplicate(client, entry.title_raw, verdict.lane, now, capabilities);
      if (duplicate) {
        this.counters.titleDuplicates += 1;
        await this.#merge(entry, duplicate, keys, "title-duplicate", client);
        return { itemId: null, merged: true, waiting: false };
      }
      const isChinese = isChineseTitle(entry.title_raw);
      const inserted = await client.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key,
          doi, pmid, registry_ids, title_raw, title_zh, lang, lane, source_type, specialties, published_at, date_precision,
          first_seen_at, timeline_at, state, safety_alert)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, 'screened', $17)
        RETURNING id`, [randomBytes(8).toString("hex"), entry.source_id, entry.canonical_url, entry.identity_key,
        entry.doi, entry.pmid, entry.registry_ids ?? [], entry.title_raw, isChinese ? String(entry.title_raw).slice(0, 200) : null,
        isChinese ? "zh" : verdict.language || entry.lang || "und", verdict.lane, source?.source_type ?? "media", verdict.specialties,
        entry.published_at, entry.date_precision, entry.first_seen_at, source?.safety_feed === true]);
      const itemId = Number(inserted.rows[0].id);
      await client.query(`INSERT INTO evimed_frontier.item_keys (key, item_id) SELECT key, $2 FROM unnest($1::text[]) AS key
        ON CONFLICT (key) DO NOTHING`, [[...keys.dedupe, ...keys.cluster], itemId]);
      await client.query("UPDATE evimed_frontier.entries SET item_id = $2 WHERE id = $1", [entry.id, itemId]);
      return { itemId, merged: false, waiting: false };
    });
  }

  /**
   * A published item of the same lane in the last seven days whose title is
   * this one's near duplicate: trigram similarity ≥ 0.85 where pg_trgm is
   * installed, else equal titles once case, spacing and punctuation are gone.
   * Short titles never match — a generic 「Drug Safety Communication」 is not
   * one work.
   * @param {any} client @param {string} title @param {string} lane @param {Date} now @param {{ trigram: boolean }} capabilities
   * @returns {Promise<number | null>}
   */
  async #titleDuplicate(client, title, lane, now, capabilities) {
    const key = titleKey(title);
    if (key.length < TITLE_DUPLICATE_MIN_CHARS) return null;
    const since = new Date(now.getTime() - TITLE_DUPLICATE_WINDOW_MS);
    if (capabilities?.trigram) {
      const found = await client.query(`SELECT id FROM evimed_frontier.items
        WHERE state = 'published' AND lane = $1 AND timeline_at > $2 AND similarity(title_raw, $3) >= $4
        ORDER BY similarity(title_raw, $3) DESC, id LIMIT 1`, [lane, since, title, TITLE_DUPLICATE_SIMILARITY]);
      return found.rows[0] ? Number(found.rows[0].id) : null;
    }
    const found = await client.query(`SELECT id, title_raw FROM evimed_frontier.items
      WHERE state = 'published' AND lane = $1 AND timeline_at > $2 ORDER BY timeline_at DESC LIMIT 2000`, [lane, since]);
    const match = found.rows.find((row) => titleKey(row.title_raw) === key);
    return match ? Number(match.id) : null;
  }

  /**
   * Ask the plugin for an entry's text and act on the answer (plan §10.3.4).
   * @param {any} entry (with `item_id`) @param {number} itemId @param {any} source @param {any} context
   */
  async #textStep(entry, itemId, source, context) {
    const { now, summary, glossary } = context;
    /** @type {any} */
    let text = null;
    /** @type {"available" | "pending" | "unavailable" | "error"} */
    let status;
    try {
      text = await this.plugin.text(entry.plugin_entry_id);
      status = ["available", "pending", "unavailable"].includes(text?.status) ? text.status : "error";
    } catch (error) {
      status = codeOf(error) === "knowledge_plugin_not_found" ? "unavailable" : "error";
    }
    const snapshot = await this.database.query("SELECT item_id FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId]);
    const promoted = snapshot.rowCount > 0;
    const decision = frontierTextDecision({ status, entry, source, promoted, now });
    if (decision.action === "hold") {
      await this.#finishEntry(entry, "held", status === "error" ? "plugin-text-unreachable" : "text-pending",
        { itemId, holdUntil: new Date(now.getTime() + decision.holdMs) });
      summary.held += 1;
      return;
    }
    const available = status === "available" ? text : null;
    await this.database.transaction(async (/** @type {any} */ client) => {
      const item = (await client.query("SELECT * FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
      if (!item) throw Object.assign(new Error("The entry's item is gone."), { code: "frontier_item_missing" });
      const enrichment = available?.enrichment && typeof available.enrichment === "object" ? available.enrichment : null;
      const existing = promoted
        ? (await client.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0]
        : null;
      const texts = {
        abstract_raw: available?.abstract ?? existing?.abstract_raw ?? null,
        body_excerpt: available?.body_excerpt ? String(available.body_excerpt).slice(0, 12_000) : existing?.body_excerpt ?? null,
        publication_types: Array.isArray(enrichment?.publication_types) ? enrichment.publication_types.slice(0, 40) : existing?.publication_types ?? [],
        mesh: Array.isArray(enrichment?.mesh) ? enrichment.mesh.slice(0, 80) : existing?.mesh ?? [],
        journal: enrichment?.journal ?? existing?.journal ?? (typeof entry.facts?.journal === "string" ? entry.facts.journal : null),
        authors_short: enrichment?.authors_short ?? existing?.authors_short ?? null,
        open_access: enrichment?.open_access ?? existing?.open_access ?? null,
        enrichment: enrichment ?? existing?.enrichment ?? {},
      };
      const gained = Boolean(available && (available.abstract || available.body_excerpt) && !existing?.abstract_raw && !existing?.body_excerpt);
      // The text the edit will use; the edit stores what it actually sent.
      const modelInput = existing && item.editor_version ? existing.model_input
        : buildModelInput(this.#editItem(item, texts, entry, source, glossary));
      await client.query(`INSERT INTO evimed_frontier.item_texts (item_id, abstract_raw, body_excerpt, model_input, model_input_sha256,
          publication_types, mesh, journal, authors_short, open_access, enrichment)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (item_id) DO UPDATE SET abstract_raw = excluded.abstract_raw, body_excerpt = excluded.body_excerpt,
          model_input = excluded.model_input, model_input_sha256 = excluded.model_input_sha256,
          publication_types = excluded.publication_types, mesh = excluded.mesh, journal = excluded.journal,
          authors_short = excluded.authors_short, open_access = excluded.open_access, enrichment = excluded.enrichment`,
      [itemId, texts.abstract_raw, texts.body_excerpt, modelInput, createHash("sha256").update(modelInput).digest("hex"),
        texts.publication_types, texts.mesh, texts.journal, texts.authors_short, texts.open_access, JSON.stringify(texts.enrichment)]);
      // Every version bump in a transaction comes last, after its row locks:
      // a transaction never waits for a row while it holds the version.
      const linked = await this.#preprintLinks(client, item, texts.enrichment);
      if (item.state === "published") {
        // Text that arrives after publication: code-decided labels move now,
        // and the item owes one re-edit (review #11).
        const evidence = frontierEvidenceDecision({ source, identityKey: item.identity_key, publicationTypes: texts.publication_types });
        const linkFlags = await this.#linkFlags(client, item);
        const flags = frontierItemFlags({ source, entry, item, text: texts, modelFlags: item.flags.includes("press-release") && source?.source_type !== "company" ? ["press-release"] : [], linkFlags });
        const evidenceType = evidence.fixed?.type ?? item.evidence_type;
        await client.query(`UPDATE evimed_frontier.items SET flags = $2, evidence_type = $3, evidence_basis = $4, score_authority = $5,
            score_total = CASE WHEN score_impact IS NULL THEN NULL ELSE $5 + score_impact + score_novelty + score_relevance END,
            editor_version = CASE WHEN $6::boolean AND rescored_at IS NULL THEN NULL ELSE editor_version END,
            updated_at = clock_timestamp()
          WHERE id = $1`, [itemId, flags, evidenceType, evidence.fixed?.basis ?? item.evidence_basis,
          frontierAuthorityScore({ authority: source?.authority, evidenceType, preprint: source?.source_type === "preprint" }), gained]);
      }
      if (linked || item.state === "published") await bumpFrontierVersion(client);
      const hold = decision.action === "promote-hold" && !available;
      await this.#finishEntry(entry, hold ? "held" : "promoted", hold ? "text-pending" : null,
        { itemId, holdUntil: hold ? new Date(now.getTime() + decision.holdMs) : null, client });
    });
    if (!promoted) summary.promoted += 1;
    if (decision.action === "promote-hold" && !available) summary.held += 1;
  }

  /**
   * Preprint ↔ published version links from the enrichment (Europe PMC):
   * the preprint item carries 「已正式发表」.
   * @param {any} client @param {any} item @param {any} enrichment
   * @returns {Promise<boolean>} whether a published item changed (the caller bumps the version, once, last)
   */
  async #preprintLinks(client, item, enrichment) {
    const own = doiOf(item.doi);
    if (!own || !enrichment) return false;
    const published = doiOf(enrichment.published_version_doi);
    const preprint = doiOf(enrichment.preprint_of_doi);
    if (published) {
      await client.query(`INSERT INTO evimed_frontier.item_links (kind, from_doi, to_doi, from_item_id, asserted_by)
        VALUES ('preprint-of', $1, $2, $3, 'europepmc') ON CONFLICT (kind, from_doi, to_doi) DO NOTHING`, [own, published, item.id]);
    }
    if (preprint) {
      await client.query(`INSERT INTO evimed_frontier.item_links (kind, from_doi, to_doi, to_item_id, asserted_by)
        VALUES ('preprint-of', $1, $2, $3, 'europepmc') ON CONFLICT (kind, from_doi, to_doi) DO NOTHING`, [preprint, own, item.id]);
      const earlier = (await client.query("SELECT id, state, flags FROM evimed_frontier.items WHERE lower(doi) = $1 FOR UPDATE", [preprint])).rows[0];
      if (earlier && !earlier.flags.includes("published-version")) {
        await client.query("UPDATE evimed_frontier.items SET flags = $2, updated_at = clock_timestamp() WHERE id = $1",
          [earlier.id, orderedFlags([...earlier.flags, "published-version"])]);
        if (earlier.state === "published") {
          await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'published-version')", [earlier.id]);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The flags links put on an item: retraction, correction and concern
   * notices that name its DOI, and 「已正式发表」 for a preprint whose
   * published version is known. Links recorded before the item existed are
   * attached to it here.
   * @param {any} client @param {any} item @returns {Promise<string[]>}
   */
  async #linkFlags(client, item) {
    const doi = doiOf(item.doi);
    if (!doi) return [];
    await client.query("UPDATE evimed_frontier.item_links SET to_item_id = $2 WHERE lower(to_doi) = $1 AND to_item_id IS NULL", [doi, item.id]);
    await client.query("UPDATE evimed_frontier.item_links SET from_item_id = $2 WHERE lower(from_doi) = $1 AND from_item_id IS NULL", [doi, item.id]);
    const links = await client.query(`SELECT kind, lower(from_doi) = $1 AS outgoing FROM evimed_frontier.item_links
      WHERE lower(to_doi) = $1 OR (kind = 'preprint-of' AND lower(from_doi) = $1)`, [doi]);
    /** @type {string[]} */
    const flags = [];
    for (const link of links.rows) {
      if (link.kind === "preprint-of") { if (link.outgoing) flags.push("published-version"); continue; }
      const flag = /** @type {Record<string, string>} */ (LINK_FLAGS)[link.kind];
      if (flag) flags.push(flag);
    }
    return flags;
  }

  // ───────────────────────── items ─────────────────────────

  /**
   * What the editor is given for an item.
   * @param {any} item @param {any} texts @param {any} entry @param {any} source @param {FrontierGlossary} glossary
   */
  #editItem(item, texts, entry, source, glossary) {
    const evidence = frontierEvidenceDecision({ source, identityKey: item.identity_key, publicationTypes: texts?.publication_types });
    const abstract = texts?.abstract_raw ?? null;
    const summary = abstract ? null : (entry?.summary_raw ?? null);
    const bodyExcerpt = texts?.body_excerpt ?? null;
    return {
      titleRaw: item.title_raw,
      sourceName: source?.name ?? item.primary_source_id,
      sourceTypeLabel: /** @type {Record<string, string>} */ (FRONTIER_SOURCE_TYPE_LABELS_ZH)[source?.source_type] ?? null,
      publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null,
      datePrecision: item.date_precision,
      isChinese: isChineseTitle(item.title_raw),
      allowedLanes: allowedLanes(source),
      evidenceFixed: evidence.fixed,
      abstract,
      summary,
      bodyExcerpt,
      journal: texts?.journal ?? null,
      publicationTypes: texts?.publication_types ?? [],
      trialFacts: texts?.enrichment?.trial_facts ?? null,
      glossary: glossary.match([item.title_raw, abstract ?? summary ?? "", bodyExcerpt ?? ""].join("\n")),
      defaults: { lane: item.lane, specialties: item.specialties ?? [] },
    };
  }

  /**
   * Everything an item's processing reads, in one place.
   * @param {any} item
   */
  async #itemContext(item) {
    const [texts, sources, entries] = await Promise.all([
      this.database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id]),
      this.database.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id]),
      this.database.query(`SELECT * FROM evimed_frontier.entries WHERE item_id = $1 AND state IN ('promoted', 'held', 'received')
        ORDER BY revision DESC, id DESC LIMIT 1`, [item.id]),
    ]);
    return { texts: texts.rows[0] ?? null, source: sources.rows[0] ?? null, entry: entries.rows[0] ?? null };
  }

  /** @param {Date} now @param {string} where @param {any[]} values @param {number} limit */
  async #claimItems(now, where, values, limit) {
    const result = await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i
        JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
        WHERE (i.lease_until IS NULL OR i.lease_until <= $1) AND ${where}
        ORDER BY s.safety_feed DESC, (s.source_type = 'regulator') DESC, s.authority DESC, i.id
        LIMIT $2
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $3, lease_until = $4,
        attempts = i.attempts + CASE WHEN i.lease_owner IS NOT NULL THEN 1 ELSE 0 END
      FROM picked WHERE i.id = picked.id
      RETURNING i.*`, [now, limit, this.workerId, new Date(now.getTime() + this.leaseMs), ...values]);
    this.counters.claimedItems += result.rowCount;
    return result.rows;
  }

  /**
   * Promoted items not yet published: edited when allowed, else published
   * title-only and edited later; then labelled, selected and published.
   * @param {any} context
   */
  async #processItems(context) {
    const { now, summary } = context;
    const items = await this.#claimItems(now, `i.state IN ('screened', 'scored')
      AND EXISTS (SELECT 1 FROM evimed_frontier.item_texts t WHERE t.item_id = i.id)`, [], ITEM_BATCH);
    for (const item of items) {
      try {
        if (item.attempts >= FRONTIER_MAX_ATTEMPTS) {
          await this.database.query(`UPDATE evimed_frontier.items SET state = 'failed', lease_owner = NULL, lease_until = NULL,
            updated_at = clock_timestamp() WHERE id = $1`, [item.id]);
          summary.failed += 1;
          continue;
        }
        const { texts, source, entry } = await this.#itemContext(item);
        if (item.state === "screened") {
          const decision = frontierEditDecision({ source, budget: context.budget, offpeak: this.offpeak, now, available: this.editor.available });
          let result = null;
          if (decision.edit) {
            result = await this.editor.edit(this.#editItem(item, texts, entry, source, context.glossary));
            if (result.verification !== "pending") summary.edited += 1;
          } else {
            this.counters.editSkipped[decision.reason] += 1;
            summary.deferred += 1;
          }
          await this.#score(item, { texts, source, entry, result, context });
        }
        if (await this.#publish(item.id, context)) summary.published += 1;
      } catch (error) {
        await this.#failItem(item, error, summary);
      }
    }
  }

  /**
   * Published items still owed an edit (published title-only at peak, past the
   * budget, while the model was down, or re-opened by a late abstract):
   * edited when allowed, re-labelled, re-selected, re-embedded.
   * @param {any} context
   */
  async #processOwedEdits(context) {
    const { now, budget, summary } = context;
    if (!this.editor.available || budget.state === "exhausted") return;
    const general = budget.state === "ok" && !(this.offpeak && isPeak(now));
    const items = await this.#claimItems(now, `i.state = 'published' AND i.editor_version IS NULL AND i.timeline_at > $5
      AND ($6::boolean OR s.safety_feed OR s.source_type = 'regulator' OR (s.source_type = 'journal' AND s.authority >= 5))`,
    [new Date(now.getTime() - FRONTIER_DEFERRED_EDIT_WINDOW_MS), general], DEFERRED_BATCH);
    for (const item of items) {
      try {
        const { texts, source, entry } = await this.#itemContext(item);
        const result = await this.editor.edit(this.#editItem(item, texts, entry, source, context.glossary));
        if (result.verification === "pending") {
          // No answer: the attempt is spent; the third leaves the item title-only for good.
          const attempts = Number(item.attempts) + 1;
          await this.database.query(`UPDATE evimed_frontier.items SET attempts = $2::integer,
              verification = CASE WHEN $2::integer >= $3::integer THEN 'title-only' ELSE verification END,
              editor_version = CASE WHEN $2::integer >= $3::integer THEN $4::text ELSE editor_version END,
              lease_owner = NULL, lease_until = NULL WHERE id = $1`,
          [item.id, attempts, FRONTIER_MAX_ATTEMPTS, FRONTIER_EDITOR_VERSION]);
          continue;
        }
        summary.edited += 1;
        await this.#score(item, { texts, source, entry, result, context });
        await this.#reselect(item.id, context);
        summary.rescored += 1;
      } catch (error) {
        await this.#failItem(item, error, summary);
      }
    }
  }

  /** @param {any} item @param {unknown} error @param {FrontierBatchSummary} summary */
  async #failItem(item, error, summary) {
    const code = codeOf(error);
    this.lastError = code;
    try {
      const attempts = Number(item.attempts) + 1;
      const published = item.state === "published";
      await this.database.query(`UPDATE evimed_frontier.items SET attempts = $2::integer, lease_owner = NULL, lease_until = NULL,
          state = CASE WHEN $2::integer >= $3::integer AND NOT $4::boolean THEN 'failed' ELSE state END,
          editor_version = CASE WHEN $2::integer >= $3::integer AND $4::boolean THEN $5::text ELSE editor_version END,
          updated_at = clock_timestamp()
        WHERE id = $1`, [item.id, attempts, FRONTIER_MAX_ATTEMPTS, published, FRONTIER_EDITOR_VERSION]);
      if (attempts >= FRONTIER_MAX_ATTEMPTS && !published) summary.failed += 1;
    } catch (release) {
      // The lease expires and the next claim counts the attempt.
      this.counters.releaseFailures += 1;
      this.lastError = codeOf(release);
    }
  }

  /**
   * Write an item's edit (or its title-only stand-in) and its code-decided
   * labels: evidence type, flags, authority score, total, safety alert.
   * A screened item becomes `scored`; a published one keeps its state and is
   * marked re-scored.
   * @param {any} item
   * @param {{ texts: any, source: any, entry: any, result: any, context: any }} input
   */
  async #score(item, { texts, source, entry, result, context }) {
    const output = result && result.verification !== "pending" ? result.output : null;
    const evidence = frontierEvidenceDecision({ source, identityKey: item.identity_key, publicationTypes: texts?.publication_types });
    const evidenceType = evidence.fixed?.type ?? output?.evidenceType ?? (item.state === "published" ? item.evidence_type : null);
    const evidenceBasis = evidence.fixed?.basis ?? (output?.evidenceType ? "model" : item.state === "published" ? item.evidence_basis : null);
    const isChinese = isChineseTitle(item.title_raw);
    const scoreAuthority = frontierAuthorityScore({ authority: source?.authority, evidenceType, preprint: source?.source_type === "preprint" });
    const scores = output?.scores ?? null;
    const entities = output?.entities ?? item.entities ?? {};
    const glossary = context.glossary;
    const fields = {
      titleZh: output ? output.titleZh : (isChinese ? String(item.title_raw).slice(0, 200) : item.title_zh ?? null),
      summaryZh: output ? output.summaryZh : item.summary_zh ?? null,
      reasonZh: output ? output.reasonZh : item.reason_zh ?? null,
      lane: output?.lane ?? item.lane,
      specialties: output?.specialties ?? item.specialties ?? [],
      entities,
      entityKeys: glossary.entityKeys(entities),
      verification: output ? result.verification : "pending",
      editorVersion: output ? result.editorVersion : null,
      editorModel: output ? result.model : item.editor_model ?? null,
    };
    await this.database.transaction(async (/** @type {any} */ client) => {
      const linkFlags = await this.#linkFlags(client, item);
      const flags = frontierItemFlags({ source, entry, item, text: texts, modelFlags: output?.flags ?? [], linkFlags });
      await client.query(`UPDATE evimed_frontier.items SET title_zh = $2, summary_zh = $3, reason_zh = $4, lane = $5, specialties = $6,
          evidence_type = $7, evidence_basis = $8, entities = $9::jsonb, entity_keys = $10, flags = $11,
          score_authority = $12, score_impact = $13, score_novelty = $14, score_relevance = $15, score_total = $16,
          safety_alert = $17, verification = $18, editor_version = $19, editor_model = $20,
          state = CASE WHEN state = 'screened' THEN 'scored' ELSE state END,
          rescored_at = CASE WHEN state = 'published' AND $19::text IS NOT NULL THEN $21::timestamptz ELSE rescored_at END,
          lease_owner = CASE WHEN state = 'published' THEN NULL ELSE lease_owner END,
          lease_until = CASE WHEN state = 'published' THEN NULL ELSE lease_until END,
          attempts = CASE WHEN state = 'published' THEN 0 ELSE attempts END,
          updated_at = clock_timestamp()
        WHERE id = $1`, [item.id, fields.titleZh, fields.summaryZh, fields.reasonZh, fields.lane, fields.specialties,
        evidenceType, evidenceBasis, JSON.stringify(fields.entities), fields.entityKeys, flags,
        scoreAuthority, scores?.impact ?? null, scores?.novelty ?? null, scores?.relevance ?? null,
        scores ? scoreAuthority + scores.impact + scores.novelty + scores.relevance : null,
        frontierSafetyAlert({ source, evidenceType, lane: fields.lane, facts: entry?.facts }), fields.verification, fields.editorVersion,
        fields.editorModel, context.now]);
      if (output) {
        await client.query("UPDATE evimed_frontier.item_texts SET model_input = $2, model_input_sha256 = $3 WHERE item_id = $1",
          [item.id, result.modelInput, result.modelInputSha256]);
      }
      if (item.state === "published") {
        await client.query(`UPDATE evimed_frontier.items SET lexemes = $2::tsvector WHERE id = $1`,
          [item.id, tsvectorLiteral(this.#lexemeText({ ...item, title_zh: fields.titleZh, summary_zh: fields.summaryZh, entities: fields.entities }))]);
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'rescored')", [item.id]);
        // What was embedded described the item before its edit.
        if (context.capabilities?.vector) await client.query("DELETE FROM evimed_frontier.item_vectors WHERE item_id = $1", [item.id]);
        await bumpFrontierVersion(client);
      }
    });
  }

  /** The words search finds an item by. @param {any} item */
  #lexemeText(item) {
    const entities = item.entities && typeof item.entities === "object" ? Object.values(item.entities).flat() : [];
    return [item.title_raw, item.title_zh, item.summary_zh, ...entities].filter((part) => typeof part === "string" && part).join("\n");
  }

  /**
   * How many items of a source are selected on the item's day (safety alerts
   * and operator pins do not count against the cap).
   * @param {any} client @param {string} sourceId @param {Date} timelineAt
   */
  async #selectedToday(client, sourceId, timelineAt) {
    const { start, end } = frontierDayWindow(timelineAt, this.timeZone);
    const result = await client.query(`SELECT count(*)::integer AS selected FROM evimed_frontier.items
      WHERE primary_source_id = $1 AND state = 'published' AND selected AND selected_rule IN ('threshold', 'lane-floor')
        AND timeline_at >= $2 AND timeline_at < $3`, [sourceId, start, end]);
    return Number(result.rows[0]?.selected ?? 0);
  }

  /**
   * Publish a scored item (plan §10.3.1 step 10): visible now, its timeline
   * instant fixed for good, selected or not, searchable, and announced — the
   * change row and the content version in the same transaction.
   * @param {number} itemId @param {any} context @returns {Promise<boolean>}
   */
  async #publish(itemId, context) {
    const { now } = context;
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const item = (await client.query("SELECT * FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
      if (!item || item.state !== "scored") return false;
      const source = (await client.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id])).rows[0];
      const texts = (await client.query("SELECT publication_types FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0];
      const linkFlags = await this.#linkFlags(client, item);
      const flags = orderedFlags([...new Set([...item.flags, ...linkFlags])]);
      const timelineAt = frontierTimelineAt(now, item.published_at);
      const decision = frontierSelectionDecision({
        safetyAlert: item.safety_alert, verification: item.verification, scoreTotal: item.score_total,
        demoted: frontierEvidenceFromPublicationTypes(texts?.publication_types).demote, flags, source,
        selectedToday: await this.#selectedToday(client, item.primary_source_id, timelineAt), threshold: this.threshold,
      });
      if (decision.capped) this.counters.capped += 1;
      if (decision.selected) this.counters.selected += 1;
      await client.query(`UPDATE evimed_frontier.items SET state = 'published', visible_at = $2::timestamptz, timeline_at = $3::timestamptz,
          flags = $4, selected = $5::boolean, selected_rule = $6,
          selected_at = CASE WHEN $5::boolean THEN $2::timestamptz ELSE NULL END, lexemes = $7::tsvector,
          lease_owner = NULL, lease_until = NULL, attempts = 0, updated_at = clock_timestamp()
        WHERE id = $1`, [itemId, now, timelineAt, flags, decision.selected, decision.rule, tsvectorLiteral(this.#lexemeText(item))]);
      await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'published')", [itemId]);
      await bumpFrontierVersion(client);
      return true;
    });
  }

  /**
   * After a re-edit: a published item that now clears the bar is selected
   * (never the reverse — selection is sticky).
   * @param {number} itemId @param {any} context
   */
  async #reselect(itemId, context) {
    await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const item = (await client.query("SELECT * FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
      if (!item || item.state !== "published" || item.selected) return;
      const source = (await client.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id])).rows[0];
      const texts = (await client.query("SELECT publication_types FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0];
      const decision = frontierSelectionDecision({
        safetyAlert: item.safety_alert, verification: item.verification, scoreTotal: item.score_total,
        demoted: frontierEvidenceFromPublicationTypes(texts?.publication_types).demote, flags: item.flags, source,
        selectedToday: await this.#selectedToday(client, item.primary_source_id, new Date(item.timeline_at)), threshold: this.threshold,
      });
      if (!decision.selected) return;
      this.counters.selected += 1;
      await client.query(`UPDATE evimed_frontier.items SET selected = true, selected_rule = $2, selected_at = $3,
        updated_at = clock_timestamp() WHERE id = $1`, [itemId, decision.rule, context.now]);
      await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'selected')", [itemId]);
      await bumpFrontierVersion(client);
    });
  }

  /**
   * The lane floor (plan §6.3): at the end of a round, every lane with a
   * verified item at or above 60 today and nothing selected gets its best one.
   * @param {any} context
   */
  async #laneFloor(context) {
    const { now } = context;
    const { start, end } = frontierDayWindow(now, this.timeZone);
    await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const candidates = await client.query(`SELECT ranked.id, ranked.lane, t.publication_types FROM (
          SELECT i.id, i.lane, row_number() OVER (PARTITION BY i.lane ORDER BY i.score_total DESC, i.id) AS rank
          FROM evimed_frontier.items i
          WHERE i.state = 'published' AND i.timeline_at >= $1 AND i.timeline_at < $2 AND i.score_total >= $3
            AND i.verification IN ('passed', 'repaired') AND NOT i.selected AND NOT ('retracted' = ANY(i.flags))
            AND NOT EXISTS (SELECT 1 FROM evimed_frontier.items s WHERE s.state = 'published' AND s.selected AND s.lane = i.lane
              AND s.timeline_at >= $1 AND s.timeline_at < $2)) AS ranked
        LEFT JOIN evimed_frontier.item_texts t ON t.item_id = ranked.id
        WHERE ranked.rank <= 5 ORDER BY ranked.lane, ranked.rank`, [start, end, FRONTIER_LANE_FLOOR_SCORE]);
      const chosen = new Map();
      for (const row of candidates.rows) {
        if (chosen.has(row.lane) || frontierEvidenceFromPublicationTypes(row.publication_types).demote) continue;
        chosen.set(row.lane, Number(row.id));
      }
      for (const id of chosen.values()) {
        await client.query(`UPDATE evimed_frontier.items SET selected = true, selected_rule = 'lane-floor', selected_at = $2,
          updated_at = clock_timestamp() WHERE id = $1`, [id, now]);
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'selected')", [id]);
      }
      if (chosen.size) {
        this.counters.laneFloor += chosen.size;
        await bumpFrontierVersion(client);
      }
    });
  }

  /**
   * Vectors for recently published items that have none (or one of another
   * model): never before publication, never blocking it; a failure waits for
   * the next round.
   * @param {any} context @returns {Promise<number>}
   */
  async #embed(context) {
    if (!context.capabilities?.vector || !this.embedder?.configured) return 0;
    const modelKey = String(this.embedder.modelKey);
    const rows = (await this.database.query(`SELECT i.id, i.title_raw, i.title_zh, i.summary_zh FROM evimed_frontier.items i
      LEFT JOIN evimed_frontier.item_vectors v ON v.item_id = i.id AND v.model_key = $1
      WHERE i.state = 'published' AND v.item_id IS NULL AND i.timeline_at > $2
      ORDER BY i.timeline_at DESC, i.id DESC LIMIT $3`,
    [modelKey, new Date(context.now.getTime() - FRONTIER_EMBED_WINDOW_MS), EMBED_BATCH])).rows;
    if (!rows.length) return 0;
    let vectors;
    try {
      vectors = await this.embedder.embedDocuments(rows.map((row) => [row.title_zh ?? row.title_raw, row.summary_zh ?? ""].filter(Boolean).join("\n")));
    } catch (error) {
      this.counters.embedFailures += 1;
      this.lastEmbedError = codeOf(error);
      return 0;
    }
    await this.database.transaction(async (/** @type {any} */ client) => {
      for (const [index, row] of rows.entries()) {
        await client.query(`INSERT INTO evimed_frontier.item_vectors (item_id, model_key, embedding, embedded_at)
          VALUES ($1, $2, $3, clock_timestamp())
          ON CONFLICT (item_id) DO UPDATE SET model_key = excluded.model_key, embedding = excluded.embedding, embedded_at = excluded.embedded_at`,
        [row.id, modelKey, `[${vectors[index].join(",")}]`]);
      }
    });
    this.lastEmbedError = null;
    return rows.length;
  }
}
