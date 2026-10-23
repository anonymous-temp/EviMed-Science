import { createModuleEvolutionPolicies } from "./moduleEvolutionPolicies.mjs";
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
 *   batches cannot both take a source's third slot, both fill a lane's floor or
 *   both take the preprint lane's last place. Selection is sticky: a later
 *   re-score never unselects.
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
  FRONTIER_MODEL_FLAGS,
  FRONTIER_NOTICE_KINDS,
  FRONTIER_PREPRINT_LANE_SOURCE_TYPES,
  FRONTIER_SOURCE_TYPE_LABELS_ZH,
  doiOf,
  frontierAuthorityScore,
  FRONTIER_MENTION_REGISTRY_IDS,
  FRONTIER_MENTION_SOURCE_TYPES,
  frontierEvidenceFromPublicationTypes,
  frontierSourceDisplayName,
  frontierUpdateKind,
  isFrontierMastheadTitle,
  isPeak,
} from "@evimed/domain";
import { FRONTIER_RETAG_BATCH } from "./frontierEditor.mjs";
import { FRONTIER_EDITOR_VERSION, frontierEditorDiagnostics, sha256, FRONTIER_SCREEN_BATCH, FRONTIER_SCREEN_EXCERPT_CHARS, buildModelInput, frontierParagraphs,
  isChineseProse, isChineseTitle } from "./frontierEditor.mjs";
import { isDiscoveryOnlySource } from "./evolutionDiscoverySources.mjs";
import { FrontierGlossary, FrontierGlossaryStore } from "./frontierGlossary.mjs";
import { bumpFrontierVersion, migrateFrontier } from "./frontierPersistence.mjs";
import { FrontierTagStore } from "./frontierTags.mjs";
import { frontierFullTextParagraphs, frontierSettledParagraphs, frontierTidyBasis, frontierTidyVerdict, FRONTIER_TIDY_LIMITS } from "./frontierReaderTidy.mjs";
import { frontierWriteLead } from "./frontierLead.mjs";
import { FRONTIER_INSIGHT_LIMITS, frontierInsightBasis, frontierInsightWorthAsking, frontierWriteInsight } from "./frontierInsight.mjs";
import { frontierItemFollowups } from "./frontierEventReading.mjs";
import { frontierScreenExcerpt, frontierScreenSource } from "./frontierIngest.mjs";
import { tsvectorLiteral } from "./kbChunker.mjs";
import { recordFrontierNotices } from "./sourceChanges.mjs";

const MINUTE = 60_000;
/** Tagging calls one batch makes side by side (`#retag`). */
const FRONTIER_RETAG_CALLS = 3;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
const DAY = 24 * HOUR;

/**
 * The longest an entry waits before the plugin is asked for its text again
 * (plan §10.3.4), and the wait when a pending answer names no next try.
 */
export const FRONTIER_TEXT_HOLD_MS = 12 * HOUR;
/**
 * A pending answer is asked again this long after the plugin's own next try
 * (`next_attempt_at`) — its usual time to finish one — and never sooner.
 */
export const FRONTIER_TEXT_AFTER_ATTEMPT_MS = 5 * MINUTE;
/**
 * After this long from first sight an entry is not waited for any more: it proceeds with what it has, or — with no text and no
 * summary a reader could use — is not shown (2026-10-22). Fourteen days, the knowledge plugin's own text horizon for a journal
 * entry: PubMed often indexes a paper one to two weeks after it is online, and the publisher's page, feed and open-access copy
 * are read before that.
 */
export const FRONTIER_TEXT_GIVE_UP_MS = 14 * DAY;
/** A plugin that did not answer is asked again sooner than one that said "pending". */
export const FRONTIER_TEXT_RETRY_MS = 15 * MINUTE;
/** An entry whose work is already in flight under another entry waits this long. */
export const FRONTIER_IN_FLIGHT_WAIT_MS = 10 * MINUTE;
/** Claims per row before it fails with its last reason. */
export const FRONTIER_MAX_ATTEMPTS = 3;
/**
 * How long the pipeline stops asking the model after the provider refused a
 * call for its balance (`model_gateway_payment_required`, HTTP 402). A spent
 * balance is topped up by a person, not by time, so this is a wait and never
 * an attempt: on 2026-09-23 DeepSeek answered every call 402 for two hours,
 * each screening was counted as a used attempt, and a third failed the entry
 * for good — feed items lost to an outage of our own account (audit
 * follow-up). Half an hour between asks bounds the refused calls (each is a
 * released ledger row and a count in ModelProviderBalanceExhausted) without
 * holding the feed up long after the top-up.
 */
export const FRONTIER_PROVIDER_REFUSED_WAIT_MS = 30 * MINUTE;
/** A temporary transport/provider outage gets one new ask after five minutes. */
export const FRONTIER_PROVIDER_RETRY_MS = 5 * MINUTE;
/** The provider's answer for a spent balance, as the model gateway names it. */
const PROVIDER_BALANCE_REFUSAL = "model_gateway_payment_required";
/** Only observed provider/transport failures wait; malformed content still spends an attempt.
 * @param {any} error */
export function frontierProviderUnavailable(error) {
  const code = typeof error === "string" ? error : error?.code;
  if ([PROVIDER_BALANCE_REFUSAL, "frontier_model_timeout", "model_gateway_timeout",
    "model_gateway_rate_limited", "model_gateway_upstream_unavailable"].includes(code)) return true;
  const status = error?.upstreamStatus;
  if (code === "model_gateway_upstream_error" && Number.isInteger(status) && (status === 429 || (status >= 500 && status <= 599))) return true;
  const networkCode = error?.networkCode ?? error?.cause?.cause?.code ?? error?.cause?.code;
  return code === "frontier_model_failed" && typeof networkCode === "string"
    && /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(networkCode);
}
/** The 72-hour rule of `timeline_at` (plan §6.1). */
export const FRONTIER_TIMELINE_WINDOW_MS = 72 * HOUR;
/** A lane with an item at or above this score today gets at least one selected. */
export const FRONTIER_LANE_FLOOR_SCORE = 60;
/**
 * The selection line when `OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD` is unset
 * (config.mjs holds the same number; frontierConfig.test.mjs holds them
 * equal). Calibrated 2026-09-28 from production's first week against the
 * plan's 15-30 selected a day (acceptance 1.4): at 75 the weekdays of
 * 09-23..26 selected 29/56/50/37. Replaying their 2,259 published items
 * through `frontierSelectionDecision`, the source caps and the lane floor
 * gives 22/46/43/32 at 75 (production runs ~19% above the replay: selection
 * is sticky when a re-edit lowers a score, and the floor runs every round),
 * 15/26/30/22 at 80 and 12/22/24/20 at 82 — about 14-29 once that margin is
 * added. Weekends and quiet days fall under 15 whatever the line; the daily
 * never pads (§14.8 #6). Re-read a week's distribution before moving it.
 */
export const FRONTIER_SELECT_THRESHOLD_DEFAULT = 82;
/**
 * The preprint lane (`OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY` / `_MIN_SCORE`; config.mjs holds the same numbers and
 * frontierConfig.test.mjs holds them equal). Review B, D-08: a preprint server tops out at a total of 77 and a company newsroom at 76
 * against the line of 82, whatever they publish - 52 of the 494 enabled sources could never reach 精选 or the daily, by arithmetic and not
 * by quality. The owner ruled on 2026-10-10 that a few of them should: each day, up to 2 of their items, the highest total first.
 *
 * The total, because that is the editorial score a card shows and its band is read from (high from the line, medium from 60, low
 * below). The floor is 60, the lower edge of the "medium" band and the line the lane floor has drawn since launch (production's
 * seven days to 2026-10-10, read only: it selected 45 items, so a total of 60 is a level the editor reaches every day): a selected
 * card never reads as low. For these classes 60 asks the editor for 53 or 54 of its 70 points (76-77%), against the 64 (91%) that
 * the line of 82 asks for a journal of authority 3 - what a place kept for "worth reading" should ask for. The only preprint on
 * record with the real editor (the live-chain receipt of 2026-10-10) scored 40, a middling secondary analysis, and stays out.
 * That is one sample and the arithmetic, not a distribution: the first week of
 * `open_science_frontier_pipeline_total{outcome="preprintLane"}` and the totals per day of the two classes
 * (`SELECT max(score_total) ... WHERE source_type IN ('preprint','company') GROUP BY day`) are what to move the floor from.
 */
export const FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT = 2;
export const FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT = 60;
/**
 * The module's own model money per day, in CNY, when `OPEN_SCIENCE_FRONTIER_DAILY_BUDGET_CNY` is unset (config.mjs holds the same
 * number; frontierConfig.test.mjs holds them equal). The owner's ruling of 2026-10-22: ¥300, from ¥10. At ¥10 the 80% throttle (¥8)
 * was crossed on 2026-10-20 at ¥8.03 and every non-urgent item that afternoon was published title-only. Production's last fourteen
 * days spent ¥1.4-8.0 a day on 1,200-5,500 calls (about ¥0.0012 a call, ¥0.004 an item). The live check of 2026-10-22 (20 real
 * items, the shipping prompts) measured ¥0.0042 an edit with the 导读, 推荐理由 and tags, and ¥0.0046 a full-text translation
 * (FRONTIER_TRANSLATION_LIMITS caps one at about ¥0.04); with 1,000-1,850 items a day and 100-200 of them selected or near the
 * line, the expected day is about ¥6-15 and a heavy one about ¥25, so the throttle at ¥240 is reached only by a runaway day, and
 * then the last ¥60 still edits safety feeds, regulators and the top journals.
 */
export const FRONTIER_DAILY_BUDGET_CNY_DEFAULT = 300;
/** Owed edits cover recent source dates, actual publication, or generated dailies. */
export const FRONTIER_DEFERRED_EDIT_WINDOW_MS = 7 * DAY;
/** Items embedded by the pipeline (older ones are the rebuild script's). */
export const FRONTIER_EMBED_WINDOW_MS = 30 * DAY;
/** Selected items a source may place per day; an authority-5 journal five. */
export const FRONTIER_SOURCE_DAILY_CAP = 3;
export const FRONTIER_TOP_JOURNAL_DAILY_CAP = 5;

/** How far below the selection line an item still gets the reader's 推荐理由 and full-text translation (contract B). */
export const FRONTIER_READER_MARGIN = 10;
const ENTRY_BATCH = FRONTIER_SCREEN_BATCH;
/** Items one round translates at most; each is at most a few calls (`FRONTIER_TRANSLATION_LIMITS`). */
const TRANSLATE_BATCH = 3;
/** Reader texts settled a round: those the model judges (one call each, at once), and those code settles alone. */
const TIDY_MODEL_BATCH = 6;
const TIDY_PLAIN_BATCH = 200;
/** 导读 paragraphs and 「AI 解读」 written a round, all at once (frontierLead.mjs, frontierInsight.mjs). */
const LEAD_BATCH = 8;
const INSIGHT_BATCH = 4;
/** Open-access PDFs read a round (each a download and a parse), and how long one may take. */
const FULLTEXT_BATCH = 2;
/** A trial key that is a registry number (ClinicalTrials.gov, ISRCTN, ChiCTR, EU CTR, jRCT, CTRI, ANZCTR): one trial, wherever it stands. */
const FRONTIER_REGISTERED_TRIAL_KEY = "^trial:(nct[0-9]{8}|isrctn[0-9]+|chictr|euctr|jrct|ctri|actrn)";
const FULLTEXT_TIMEOUT_MS = 180_000;
/** How far back a published item gets its 导读 written (a late text, the backfill of 2026-10-22). */
export const FRONTIER_LEAD_WINDOW_MS = 30 * DAY;
const ITEM_BATCH = 20;
const DEFERRED_BATCH = 8;
const EMBED_BATCH = 16;
const TITLE_DUPLICATE_WINDOW_MS = 7 * DAY;
const TITLE_DUPLICATE_SIMILARITY = 0.85;
const TITLE_DUPLICATE_MIN_CHARS = 24;
const SELECT_LOCK = "evimed-frontier-select";

/**
 * Crossref `update-to` types → the link kind and the flag it puts on the work
 * they name. Which of them make the record carrying them a notice is the
 * domain's table (`frontierUpdateKind`), not this one: a new version is linked
 * and flags nothing, and is no notice.
 */
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
  new_edition: { kind: "new-version", flag: null, reason: null },
});
/** The type of an `update_to` relation, as the tables spell it. @param {any} update */
const updateKey = (update) => String(update?.type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
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

/** A moment as its calendar day in a zone (`2026-10-22`), or null. @param {Date | string} value @param {string} timeZone */
function isoDayIn(value, timeZone) {
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(at.getTime()) ? frontierDayWindow(at, timeZone).day : null;
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

/**
 * The selection line (`OPEN_SCIENCE_FRONTIER_SELECT_THRESHOLD`,
 * `FRONTIER_SELECT_THRESHOLD_DEFAULT` unless set): what the pipeline selects
 * by and what a card's score band is read against (`frontierService.mjs`),
 * from one reading of the config.
 * @param {Record<string, any> | null | undefined} config @returns {number}
 */
export function frontierSelectThreshold(config) {
  const value = Number(config?.frontierSelectThreshold);
  return config?.frontierSelectThreshold != null && config.frontierSelectThreshold !== "" && Number.isFinite(value)
    ? value : FRONTIER_SELECT_THRESHOLD_DEFAULT;
}

/**
 * How many items of a day the preprint lane may select (`OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_PER_DAY`; 0 is no lane).
 * @param {Record<string, any> | null | undefined} config @returns {number}
 */
export function frontierPreprintLanePerDay(config) {
  const value = Number(config?.frontierPreprintLanePerDay);
  return config?.frontierPreprintLanePerDay != null && config.frontierPreprintLanePerDay !== "" && Number.isInteger(value) && value >= 0
    ? value : FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT;
}

/**
 * The total an item must reach to be taken by the preprint lane (`OPEN_SCIENCE_FRONTIER_PREPRINT_LANE_MIN_SCORE`).
 * @param {Record<string, any> | null | undefined} config @returns {number}
 */
export function frontierPreprintLaneMinScore(config) {
  const value = Number(config?.frontierPreprintLaneMinScore);
  return config?.frontierPreprintLaneMinScore != null && config.frontierPreprintLaneMinScore !== "" && Number.isFinite(value)
    ? value : FRONTIER_PREPRINT_LANE_MIN_SCORE_DEFAULT;
}

/** Safety feeds, regulators and authority-5 journals: edited at peak and past 80%, never waiting for an abstract.
 * @param {any} source */
export function isUrgentSource(source) {
  return source?.safety_feed === true || source?.source_type === "regulator"
    || (source?.source_type === "journal" && Number(source?.authority) >= 5);
}

/** The lanes a source's items may take: its own, or all eight for a mixed one. @param {any} source @returns {string[]} */
/**
 * The six contract 1.5.0 columns of an entry as query parameters, in table order (channel, platform, author, media,
 * quoted, metrics): what the item made from the entry carries of the post (fr-social 2026-10-22).
 * @param {Record<string, any>} entry
 */
function socialColumns(entry) {
  const json = (/** @type {unknown} */ value) => (value == null ? null : JSON.stringify(value));
  return [entry.channel ?? null, entry.platform ?? null, json(entry.author), json(Array.isArray(entry.media) ? entry.media : []),
    json(entry.quoted), json(entry.metrics)];
}

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
 * An event-level identity (`reg:`/`fda:`) dedupes by itself alone. A story
 * that names two or more trials writes no cluster key at all: its registry
 * ids are what it mentions, and a key written here is what another item finds
 * later (2026-09-22: a results posting joined a column's event by one).
 * @param {any} entry @param {any} [source] @returns {{ dedupe: string[], cluster: string[] }}
 */
export function entryKeys(entry, source = null) {
  const identity = String(entry.identity_key);
  const dedupe = new Set([identity]);
  if (!/^(reg|fda):/.test(identity)) {
    const doi = doiOf(entry.doi);
    if (doi) dedupe.add(`doi:${doi}`);
    if (/^\d{1,10}$/.test(String(entry.pmid ?? ""))) dedupe.add(`pmid:${entry.pmid}`);
    if (entry.canonical_url) dedupe.add(urlKey(entry.canonical_url));
  }
  const cluster = new Set();
  const registered = Array.isArray(entry.registry_ids) ? entry.registry_ids : [];
  const mentions = FRONTIER_MENTION_SOURCE_TYPES.includes(String(source?.source_type ?? ""))
    && registered.length >= FRONTIER_MENTION_REGISTRY_IDS;
  if (!mentions) {
    for (const id of registered) {
      const key = `reg:${String(id).trim().toUpperCase()}`;
      if (key.length > 4 && !dedupe.has(key)) cluster.add(key);
    }
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

/**
 * What kind of notice an entry is about another work, or null when it is no
 * notice: `retraction`, `withdrawal`, `expression-of-concern` or `correction`,
 * the most serious its relations name (`FRONTIER_NOTICE_KINDS` is in that order).
 *
 * Decided by the relation's type. Any `update_to` used to make an entry a
 * correction notice, so an ordinary new version of a work — a preprint's second
 * version, a new edition — was flagged 更正 and dropped from the feed, and a
 * retraction notice was called a correction. A record whose relations are all
 * updates (a new version, an addendum, a clarification) is an item like any
 * other. The plugin's own flag still decides when no relation can speak: a title
 * in a notice form ("Correction: …") arrives with no relation to read, and is a
 * correction notice.
 * @param {any} entry @returns {'retraction' | 'withdrawal' | 'expression-of-concern' | 'correction' | null}
 */
export function frontierNoticeKind(entry) {
  const relations = Array.isArray(entry?.facts?.update_to) ? entry.facts.update_to : [];
  const kinds = new Set(relations.map((update) => frontierUpdateKind(update?.type)));
  const serious = FRONTIER_NOTICE_KINDS.find((kind) => kinds.has(kind));
  if (serious) return /** @type {any} */ (serious);
  return entry?.facts?.is_correction_notice === true ? "correction" : null;
}

/** Whether an entry is a correction, retraction, concern or withdrawal notice about another work. @param {any} entry */
export function isCorrectionNotice(entry) {
  return frontierNoticeKind(entry) !== null;
}

/**
 * The relations of an entry that updates another work without being a notice
 * about it, as links: a new version says which work it is the new version of.
 * @param {any} entry @returns {{ update: { kind: string }, doi: string }[]}
 */
export function frontierUpdateLinks(entry) {
  return (Array.isArray(entry?.facts?.update_to) ? entry.facts.update_to : [])
    .map((/** @type {any} */ update) => ({ update: /** @type {Record<string, any>} */ (UPDATE_KINDS)[updateKey(update)], doi: doiOf(update?.doi) }))
    .filter((/** @type {any} */ target) => target.update?.kind === "new-version" && target.doi);
}

/**
 * What the text answer means for an entry (plan §10.3.4, §14.4).
 * `promote` — the text is in (or will not come): snapshot it, the entry is done;
 * `promote-hold` — go on with what there is and ask again later (a source
 *   that never waits, or a usable feed summary);
 * `hold` — wait for the text;
 * `drop` — no text will come and nothing else a reader could use is there: the item is not shown (2026-10-22).
 * @param {{ status: "available" | "pending" | "unavailable" | "error", entry: any, source: any, promoted: boolean, now: Date, nextAttemptAt?: string | null }} input
 * @returns {{ action: "promote" | "promote-hold" | "hold" | "drop", holdMs: number }}
 */
export function frontierTextDecision({ status, entry, source, promoted, now, nextAttemptAt = null }) {
  const age = now.getTime() - new Date(entry.first_seen_at).getTime();
  // What a reader can be shown without the text: a whole feed summary, a record that is its own text (a registry entry, an openFDA
  // record), or a safety source's notice (a recall or a warning is news on its title). Anything else with no text is not shown
  // (owner, 2026-10-22: 「除非是真的全部信息都没有，那么就先不展示出来」).
  const readable = promoted || usableSummary(entry) || frontierRecordEntry(entry, source) || source?.safety_feed === true;
  if (status === "available") return { action: "promote", holdMs: 0 };
  if (status === "unavailable" || age >= FRONTIER_TEXT_GIVE_UP_MS) return readable ? { action: "promote", holdMs: 0 } : { action: "drop", holdMs: 0 };
  const holdMs = status === "error" ? FRONTIER_TEXT_RETRY_MS : frontierTextPendingHold(nextAttemptAt, now);
  return readable ? { action: "promote-hold", holdMs } : { action: "hold", holdMs };
}

/**
 * Whether an item may be shown: it has a reader text (`frontierReaderText`), its entry a summary a reader could use, or its source
 * is a safety feed. An item without is not published, and waits for its text (`#processItems`).
 * @param {{ texts: any, entry: any, source: any }} input
 */
export function frontierItemReadable({ texts, entry, source }) {
  return Boolean(frontierReaderText(texts)) || usableSummary(entry) || frontierRecordEntry(entry, source) || source?.safety_feed === true;
}

/**
 * Whether an entry is a record whose fields are its text: a database or registry source's entry (`json-api`, `evimed-api`) that
 * is not an article (no DOI, no PMID) — a trial registration, an openFDA recall or approval. The knowledge plugin answers its text
 * `unavailable` on purpose (`record_is_the_text`); its title and facts are what a reader is shown.
 * @param {any} entry @param {any} source
 */
export function frontierRecordEntry(entry, source) {
  return ["json-api", "evimed-api"].includes(String(source?.access ?? "")) && !entry?.doi && !entry?.pmid;
}

/**
 * Whether an item is a journal's without its abstract (flag `no-abstract`): never selected (2026-10-22).
 * @param {{ source: any, flags: string[] }} input
 */
export function frontierJournalWithoutAbstract({ source, flags }) {
  return source?.source_type === "journal" && flags.includes("no-abstract");
}

/**
 * How long a pending text answer waits (plan §14.4). The plugin fetches a
 * text when it is first asked for one — the first answer is always pending —
 * and says when it tries (`next_attempt_at`), so the entry is asked again
 * shortly after that try; until 2026-09-22 every pending answer waited the
 * full 12 hours, and an article with no feed summary stayed unpublished that
 * long though its abstract arrived within minutes. A try already overdue
 * means the plugin is behind: wait as long again as it is late, which doubles
 * the wait on each ask while it catches up.
 * @param {string | null | undefined} nextAttemptAt @param {Date} now
 */
export function frontierTextPendingHold(nextAttemptAt, now) {
  const next = nextAttemptAt ? Date.parse(nextAttemptAt) : Number.NaN;
  if (!Number.isFinite(next)) return FRONTIER_TEXT_HOLD_MS;
  const wait = next - now.getTime();
  const holdMs = wait >= 0 ? wait + FRONTIER_TEXT_AFTER_ATTEMPT_MS : -wait;
  return Math.min(FRONTIER_TEXT_HOLD_MS, Math.max(FRONTIER_TEXT_AFTER_ATTEMPT_MS, holdMs));
}

/**
 * The evidence type code decides, or null for the model's pick.
 * Trial registries are `other` (registered, results not in a journal), FDA
 * database actions a regulatory decision, safety feeds safety notices,
 * company newsrooms press releases — all by the registry (`registry`); an
 * explicit PubMed research type replaces the model (`pubmed-types`).
 * @param {{ source: any, identityKey: string, publicationTypes: unknown, modelType?: string | null }} input
 * @returns {{ fixed: { type: string, basis: "registry" | "pubmed-types" } | null, demote: boolean }}
 */
export function frontierEvidenceDecision({ source, identityKey, publicationTypes, modelType = null }) {
  if (/^reg:/.test(identityKey)) return { fixed: { type: "other", basis: "registry" }, demote: false };
  if (/^fda:/.test(identityKey)) return { fixed: { type: "regulatory-decision", basis: "registry" }, demote: false };
  if (source?.safety_feed === true) return { fixed: { type: "safety-notice", basis: "registry" }, demote: false };
  if (source?.source_type === "company") return { fixed: { type: "press-release", basis: "registry" }, demote: false };
  const types = frontierEvidenceFromPublicationTypes(publicationTypes, { modelType });
  if (types.evidenceType) return { fixed: { type: types.evidenceType, basis: "pubmed-types" }, demote: types.demote };
  return { fixed: null, demote: false };
}

/**
 * An item's flags, every one decided by code (plan §10.3.8), in the
 * vocabulary's order. The editor proposes two of them (`FRONTIER_MODEL_FLAGS`) and code keeps what it may: a boxed warning only on a
 * safety alert (`safetyAlert`, decided by `frontierSafetyAlert`), and a Class I recall is never the editor's to say.
 * @param {{ source: any, entry: any, item: any, text: any, modelFlags?: string[], linkFlags?: string[], safetyAlert?: boolean }} input
 * @returns {string[]}
 */
export function frontierItemFlags({ source, entry, item, text, modelFlags = [], linkFlags = [], safetyAlert = false }) {
  const flags = new Set(linkFlags);
  // What screening decided about the item itself stays on it.
  if ((Array.isArray(item?.flags) ? item.flags : []).includes("digest")) flags.add("digest");
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
  // 注册，未发表结果 is a trial registration's flag: the registries that carry
  // trial events say which event this is. A guideline registration (PREPARE)
  // shares the `reg:` identity and has no trial event — flagged, it told
  // readers a guideline in development had "results not published"
  // (production, 2026-09-22).
  const event = String(entry?.facts?.trial_event ?? "");
  if (event && event !== "results-posted" && /^reg:/.test(String(entry?.identity_key ?? item?.identity_key ?? ""))) flags.add("registry-unpublished");
  if (event === "updated") flags.add("data-updated");
  if (preprint && text?.enrichment?.published_version_doi) flags.add("published-version");
  // The two marks that send a safety alert to every reader with the push on (owner, 2026-10-10; FRONTIER_BROAD_SAFETY_FLAGS): the
  // recall's own class, read from the record, and a boxed warning the editor found the notice to add or strengthen.
  if (safetyAlert && frontierClassIRecall({ source, facts: entry?.facts })) flags.add("class-i-recall");
  if (safetyAlert && modelFlags.includes("boxed-warning")) flags.add("boxed-warning");
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
  const recallClass = typeof facts?.recall_class === "string" ? facts.recall_class.trim() : "";
  if (recallClass) return frontierClassIRecall({ source, facts });
  if (source?.safety_feed === true) return true;
  return source?.source_type === "regulator" && evidenceType === "safety-notice" && lane === "safety";
}

/**
 * The flags the editor proposed that an item already carries, to be handed back to `frontierItemFlags` when its labels are decided
 * again without a new edit (the text of a published item arrived): a release republished by a medium, a boxed warning a safety notice
 * adds. A company's own newsroom is a `press-release` by its source, not by the editor, so that one is not kept as the editor's.
 * @param {{ flags: string[] | null | undefined, source: any }} input @returns {string[]}
 */
export function frontierKeptModelFlags({ flags, source }) {
  return (flags ?? []).filter((flag) => FRONTIER_MODEL_FLAGS.includes(/** @type {any} */ (flag)) && !(flag === "press-release" && source?.source_type === "company"));
}

/**
 * Whether a recall is Class I - the regulator's own grade for a reasonable probability of serious harm or death - by the class its
 * record carries, and from a regulator or a safety feed only. Read by code from the field, never judged: it is the half of "Class I
 * recall or boxed-warning alert" that is a fact of the record, and the half that decides how far a safety alert is pushed with
 * `class-i-recall`.
 * @param {{ source: any, facts?: any }} input
 */
export function frontierClassIRecall({ source, facts = null }) {
  const regulatorOrFeed = source?.safety_feed === true || source?.source_type === "regulator";
  const recallClass = typeof facts?.recall_class === "string" ? facts.recall_class.trim() : "";
  return regulatorOrFeed && /^class\s+i$/i.test(recallClass);
}

/**
 * Whether a published item is selected, and by which rule (plan §6.3). A
 * safety alert is selected whatever its score; otherwise a verified,
 * scored item at or above the threshold, while its source has room today —
 * never a journal's item still without its abstract (2026-10-22: it is in
 * 全部 only, until its abstract re-edits it).
 * @param {{ safetyAlert: boolean, verification: string, scoreTotal: number | null, demoted: boolean, flags: string[],
 *           source: any, selectedToday: number, threshold: number }} input
 * @returns {{ selected: boolean, rule: "safety-bypass" | "threshold" | null, capped?: boolean }}
 */
export function frontierSelectionDecision({ safetyAlert, verification, scoreTotal, demoted, flags, source, selectedToday, threshold }) {
  if (safetyAlert) return { selected: true, rule: "safety-bypass" };
  if (demoted || flags.includes("retracted") || frontierJournalWithoutAbstract({ source, flags })) return { selected: false, rule: null };
  if (!["passed", "repaired"].includes(verification) || scoreTotal == null || scoreTotal < threshold) return { selected: false, rule: null };
  const cap = source?.source_type === "journal" && Number(source?.authority) >= 5 ? FRONTIER_TOP_JOURNAL_DAILY_CAP : FRONTIER_SOURCE_DAILY_CAP;
  if (selectedToday >= cap) return { selected: false, rule: null, capped: true };
  return { selected: true, rule: "threshold" };
}

/** The reader texts, best first, as `item_texts.body_zh_source` names them. */
export const FRONTIER_READER_SOURCES = Object.freeze(/** @type {const} */ (["body", "abstract", "excerpt"]));
/** The best reader text's name, in SQL over `item_texts t` (`frontierReaderText`'s order); null when there is none. */
const READER_BEST_SOURCE_SQL = `(CASE WHEN btrim(coalesce(t.body_text, '')) <> '' THEN 'body' WHEN btrim(coalesce(t.abstract_raw, '')) <> '' THEN 'abstract'
  WHEN btrim(coalesce(t.body_excerpt, '')) <> '' THEN 'excerpt' END)`;

/**
 * The text a reader's full text is read from, best first: the plugin's full text (contract 1.4.0), the abstract, the page
 * excerpt; or the one a translation was made from, when `source` names it. Null when there is none. It is the settled text
 * (`frontierReaderTidy.mjs`, 2026-10-22): a structured abstract laid out by section, and the paragraphs the stored verdict
 * found not to be the article's taken out — as paragraphs joined by blank lines, so the reader, the translation and the
 * check that a translation is still its text's all read the same thing.
 * @param {any} texts an `item_texts` row @param {"body" | "abstract" | "excerpt" | null} [source]
 * @returns {{ source: "body" | "abstract" | "excerpt", text: string } | null}
 */
export function frontierReaderText(texts, source = null) {
  const columns = { body: texts?.body_text, abstract: texts?.abstract_raw, excerpt: texts?.body_excerpt };
  for (const name of source ? [source] : FRONTIER_READER_SOURCES) {
    const text = columns[name];
    if (typeof text === "string" && text.trim()) return { source: name, text: frontierSettledParagraphs(text, name, texts?.reader_tidy ?? null).join("\n\n") };
  }
  return null;
}

/**
 * Whether an item gets the reader's 推荐理由 and full-text translation: selected (a safety alert is), or a score within
 * `FRONTIER_READER_MARGIN` of the selection line.
 * @param {{ selected?: boolean | null, safety_alert?: boolean | null, score_total?: number | string | null }} item @param {number} threshold
 */
export function frontierReaderWorthy(item, threshold) {
  return item?.selected === true || item?.safety_alert === true
    || (item?.score_total != null && Number.isFinite(Number(item.score_total)) && Number(item.score_total) >= threshold - FRONTIER_READER_MARGIN);
}

/**
 * fr-events' verdict (cc/briefs/fr-contract.md, 2026-10-22): an item that joined an event whose selected report is another one
 * and adds nothing to it names that report in `same_event_item_id`, and none of this module's later selections — the re-select
 * after a re-edit, the lane floor, the preprint lane — takes it while the report it names is published and selected. Read
 * through `to_jsonb`, so the predicate holds whether or not the column exists yet.
 * @param {string} alias the items row's alias
 */
export function frontierBesideSelectedSql(alias) {
  return `EXISTS (SELECT 1 FROM evimed_frontier.items beside WHERE beside.id = (to_jsonb(${alias})->>'same_event_item_id')::bigint
    AND beside.state = 'published' AND beside.selected)`;
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
 *             failed: number, dropped: number, waiting: number, deferred: number, edited: number, rescored: number, embedded: number,
 *             preprintLane: number, translated: number, tidied: number, tidyDropped: number, leads: number, insights: number, retagged: number }} FrontierBatchSummary
 */

export class FrontierPipeline {
  /**
   * @param {{ database: any, editor: any, plugin: any, embedder?: any, glossary?: any, config?: Record<string, any>,
   *           sourceChanges?: any, policies?: any, evolution?: any, webReader?: { read: (url: string, options?: any) => Promise<any> } | null,
   *           tags?: FrontierTagStore | null, now?: () => Date, workerId?: string }} options
   *   `editor` a `FrontierEditor` (its `owner` is the operator's internal
   *   project, and the budget is read for it); `plugin` offers `text(entryId)`
   *   (`KnowledgePluginClient`); `embedder` a `KbEmbedder` or null; `glossary`
   *   a `FrontierGlossaryStore` (default: read from the database) or a
   *   `FrontierGlossary`; `sourceChanges` the one record of source changes
   *   (`sourceChanges.mjs`), which each retraction, correction, concern or
   *   withdrawal notice is also written to (absent: nothing is).
   */
  constructor({ database, editor, plugin, evolution = null, policies = createModuleEvolutionPolicies(), embedder = null, glossary = null, config = {}, sourceChanges = null, webReader = null, tags = null, now = () => new Date(), workerId = `frontier-${randomUUID()}` }) {
    if (!database) throw new TypeError("The frontier pipeline needs a database.");
    if (typeof editor?.screen !== "function" || typeof editor?.edit !== "function") throw new TypeError("The frontier pipeline needs an editor.");
    if (typeof plugin?.text !== "function") throw new TypeError("The frontier pipeline needs the plugin client.");
    this.database = database;
    this.editor = editor;
    this.plugin = plugin;
    this.embedder = embedder;
    this.sourceChanges = sourceChanges;
    /** The platform's web reader (`webRead.mjs`: robots.txt, private addresses refused, PDFs through the document parser), for an
     *  open-access PDF the plugin could not read; null reads none. */
    this.webReader = webReader && typeof webReader.read === "function" ? webReader : null;
    this.config = config ?? {};
    this.now = now;
    this.workerId = String(workerId).slice(0, 120);
    /** The tag tree (frontierTags.mjs): what an edit is offered and where its tags are written. */
    this.tags = tags ?? new FrontierTagStore({ database, now });
    this.glossaryStore = glossary instanceof FrontierGlossary ? { current: async () => glossary }
      : glossary && typeof glossary.current === "function" ? glossary : new FrontierGlossaryStore({ database });
    this.leaseMs = Math.max(MINUTE, Number(this.config.frontierLeaseMs) || 10 * MINUTE);
    this.evolution = evolution;
    this.policies = policies;
    this.threshold = frontierSelectThreshold(this.config);
    this.preprintLanePerDay = frontierPreprintLanePerDay(this.config);
    this.preprintLaneMinScore = frontierPreprintLaneMinScore(this.config);
    this.budgetCny = this.config.frontierDailyBudgetCny != null && this.config.frontierDailyBudgetCny !== "" && Number.isFinite(Number(this.config.frontierDailyBudgetCny))
      ? Number(this.config.frontierDailyBudgetCny) : FRONTIER_DAILY_BUDGET_CNY_DEFAULT;
    this.offpeak = this.config.frontierOffpeak === true;
    this.timeZone = String(this.config.frontierTimeZone || this.config.frontierTimezone || "Asia/Shanghai");
    // The width the schema's vector column is created with; it must be the
    // one the server migrates with, or the migration would empty the vectors.
    this.dimension = Number(this.config.kbEmbeddingDimension) || Number(embedder?.dimension) || 1024;
    /** Observable counters (principle 15). */
    this.counters = {
      batches: 0, claimedEntries: 0, claimedItems: 0, promoted: 0, published: 0, merged: 0, screenedOut: 0, held: 0,
      failed: 0, dropped: 0, waiting: 0, deferred: 0, edited: 0, rescored: 0, embedded: 0, embedFailures: 0, translated: 0, translateIncomplete: 0, translateStoreRefused: 0,
      // The reader's text (frontierReaderTidy.mjs): texts settled, paragraphs taken out, model answers refused by code, and
      // translations made from a text that has since changed, cleared to be made again.
      tidied: 0, tidyDropped: 0, tidyRefused: 0, translationsCleared: 0,
      // The reader's 导读 and 「AI 解读」: written, left empty (the source supports none), dropped by their checks, and insights asked.
      leads: 0, leadsEmpty: 0, leadsDropped: 0, insights: 0, insightsEmpty: 0, insightsAsked: 0,
      // Open-access PDFs read for a full text (`#fullText`): read and kept, read and too short or unreadable.
      fullTexts: 0, fullTextsMissed: 0, fullTextsRefused: 0,
      // The tag tree (`#retag`, `#score`): items tagged again, answers left without a usable row, calls that failed, candidates made.
      retagged: 0, retagSkipped: 0, retagFailures: 0, tagCandidatesCreated: 0,
      titleDuplicates: 0, notices: 0, laneFloor: 0, preprintLane: 0, selected: 0, capped: 0, releaseFailures: 0,
      editSkipped: { unavailable: 0, exhausted: 0, throttled: 0, peak: 0 },
      // Rows released to wait out a provider balance refusal, never charged an attempt.
      providerRefusedWaits: 0,
    };
    /** Until when (epoch ms) the model is not asked after a provider outage. @type {number | null} */
    this.providerPausedUntil = null;
    /** @type {string | null} */
    this.providerPauseReason = null;
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
        // An uncertain call counts at the bound its client recorded
        // (`estimated_cost`: its prompt plus the output seen), falling back to
        // the reservation — the rule the account caps use (usageLedger.mjs
        // OPEN_COST_VALUE). At the full reservation, a burst of lost calls
        // priced at the cache-miss ceiling (09-23: 479 frontier rows) spent
        // the day's budget on money nobody was charged. Read through to_jsonb
        // so a database whose usage migration has not yet added the column
        // still answers, at the reservation.
        const result = await this.database.query(`SELECT coalesce(sum(CASE
            WHEN m.status='settled' THEN coalesce(m.actual_cost, 0)
            WHEN m.status='reserved' THEN m.reserved_cost
            WHEN m.status='uncertain' THEN LEAST(m.reserved_cost, coalesce((to_jsonb(m)->>'estimated_cost')::numeric, m.reserved_cost))
            ELSE 0 END), 0) AS spent
          FROM evimed_usage.model_requests m
          WHERE m.user_id=$1 AND m.project_id=$2 AND m.purpose='frontier' AND m.created_at >= $3::timestamptz`,
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
   * the lane floor and the preprint lane, and embeddings.
   * @returns {Promise<FrontierBatchSummary>}
   */
  async processBatch() {
    const policy = await this.policies.resolve("frontier", { selectionThreshold: frontierSelectThreshold(this.config) });
    this.threshold = policy.policy.selectionThreshold;
    this.policyRevisionId = policy.revisionId;
    /** @type {FrontierBatchSummary} */
    const summary = { claimed: 0, promoted: 0, published: 0, merged: 0, screenedOut: 0, held: 0, failed: 0, dropped: 0,
      waiting: 0, deferred: 0, edited: 0, rescored: 0, embedded: 0, preprintLane: 0, translated: 0, tidied: 0, tidyDropped: 0, leads: 0, insights: 0, retagged: 0 };
    try {
      const capabilities = await migrateFrontier(this.database, { dimension: this.dimension });
      const now = this.now();
      const budget = await this.budget(now);
      const glossary = await this.glossaryStore.current();
      // A tree that cannot be read leaves the edits without candidates; it never stops a batch.
      const tags = await this.tags.vocabulary().catch(() => null);
      const context = { now, budget, capabilities, glossary, tags, summary };
      await this.#processEntries(context);
      await this.#processItems(context);
      await this.#processOwedEdits(context);
      if (summary.published || summary.rescored) {
        await this.#laneFloor(context);
        summary.preprintLane += await this.#preprintLane(context);
      }
      await this.#fullText(context);
      await this.#tidy(context);
      await this.#lead(context);
      await this.#insight(context);
      summary.translated += await this.#translate(context);
      summary.retagged += await this.#retag(context);
      summary.embedded += await this.#embed(context);
      this.counters.batches += 1;
      for (const key of /** @type {Array<keyof FrontierBatchSummary>} */ (Object.keys(summary))) {
        if (key in this.counters && typeof this.counters[key] === "number") this.counters[key] += summary[key];
      }
      this.lastBatch = { at: now.toISOString(), ...summary };
      this.lastError = this.#providerPause(now) ? this.providerPauseReason ?? null : null;
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
      // The model is not asked until then: the provider refused for its balance.
      providerPausedUntil: this.providerPausedUntil !== null && this.providerPausedUntil > this.now().getTime()
        ? new Date(this.providerPausedUntil).toISOString() : null,
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
        if (isDiscoveryOnlySource(entry.source_id) || entry.facts?.discovery_only === true) {
          await this.#finishEntry(entry, "dropped", "evolution-discovery-only");
          summary.dropped += 1;
          continue;
        }
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
        // An update is an item: a new version of a work goes on to screening like
        // any other entry, and says which work it is the new version of.
        await this.#linkNewVersion(entry);
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

  /** Until when the model is not asked after a balance refusal, or null. @param {Date} now @returns {Date | null} */
  #providerPause(now) {
    return this.providerPausedUntil !== null && now.getTime() < this.providerPausedUntil ? new Date(this.providerPausedUntil) : null;
  }

  /** Stop asking during a provider outage; a balance refusal waits longer.
   * @param {Date} now @param {string} [reason] @returns {Date} */
  #pauseForProvider(now, reason = "provider-refused") {
    const waitMs = reason === "provider-refused" || reason === PROVIDER_BALANCE_REFUSAL
      ? FRONTIER_PROVIDER_REFUSED_WAIT_MS : FRONTIER_PROVIDER_RETRY_MS;
    this.providerPausedUntil = Math.max(this.providerPausedUntil ?? 0, Math.max(now.getTime(),this.now().getTime()) + waitMs);
    this.providerPauseReason = reason;
    return new Date(this.providerPausedUntil);
  }

  /** Release an entry to try again later: a wait, not an attempt. @param {any} entry @param {Date} holdUntil @param {string | null} reason */
  async #waitEntry(entry, holdUntil, reason) {
    await this.database.query(`UPDATE evimed_frontier.entries SET hold_until = $2, state_reason = $3,
        lease_owner = NULL, lease_until = NULL WHERE id = $1`, [entry.id, holdUntil, reason]);
  }

  /** A processing error: an attempt spent; the third fails the entry. @param {any} entry @param {unknown} error @param {FrontierBatchSummary} summary */
  async #failEntry(entry, error, summary) {
    const code = codeOf(error);
    if (frontierProviderUnavailable(error)) {
      await this.#waitEntry(entry, this.#pauseForProvider(this.now(), code), code);
      summary.deferred += 1;
      return;
    }
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
    const noticeKind = frontierNoticeKind(entry) ?? "correction";
    // Only the relations that are notices: a new version listed beside a
    // correction is not a correction of anything.
    const targets = (Array.isArray(entry.facts?.update_to) ? entry.facts.update_to : [])
      .map((/** @type {any} */ update) => ({
        update: /** @type {Record<string, any>} */ (UPDATE_KINDS)[updateKey(update)],
        doi: doiOf(update?.doi),
        date: typeof update?.date === "string" ? update.date : null,
      }))
      .filter((/** @type {any} */ target) => target.update && target.doi && target.update.kind !== "new-version");
    this.counters.notices += 1;
    /** @type {Array<{ kind: string, noticeDoi: string | null, doi: string, date: string | null }>} */
    const asserted = [];
    await this.database.transaction(async (/** @type {any} */ client) => {
      let changed = false;
      for (const { update, doi, date } of noticeDoi ? targets : []) {
        const target = await client.query("SELECT id, state, flags FROM evimed_frontier.items WHERE lower(doi) = $1 LIMIT 1 FOR UPDATE", [doi]);
        const item = target.rows[0] ?? null;
        await client.query(`INSERT INTO evimed_frontier.item_links (kind, from_doi, to_doi, to_item_id, asserted_by)
          VALUES ($1, $2, $3, $4, 'crossref') ON CONFLICT (kind, from_doi, to_doi) DO UPDATE SET to_item_id = coalesce(evimed_frontier.item_links.to_item_id, excluded.to_item_id)`,
        [update.kind, noticeDoi, doi, item?.id ?? null]);
        asserted.push({ kind: update.kind, noticeDoi, doi, date });
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
      // The kind is the entry's own state: a retraction notice is not recorded as a correction.
      await this.#finishEntry(entry, "dropped", `${noticeKind}-notice${noticeDoi && targets.length ? "" : "-unlinked"}`, { client });
    });
    // The same relation as a source change, for every module that reads one (B5), once the relation is committed.
    await recordFrontierNotices(this.sourceChanges, asserted);
  }

  /**
   * A record that is a new version of another work (a preprint's second
   * version, a new edition) is an item like any other. What it says about the
   * earlier version is kept as a `new-version` link, with nothing flagged on that
   * work, so its event can read as superseding the older one; the link waits in
   * `item_links` for the item to be published, as a notice's does.
   * @param {any} entry
   */
  async #linkNewVersion(entry) {
    const from = doiOf(entry.doi);
    if (!from) return;
    for (const { doi } of frontierUpdateLinks(entry)) {
      if (doi === from) continue;
      const target = await this.database.query("SELECT id FROM evimed_frontier.items WHERE lower(doi) = $1 LIMIT 1", [doi]);
      await this.database.query(`INSERT INTO evimed_frontier.item_links (kind, from_doi, to_doi, to_item_id, asserted_by)
        VALUES ('new-version', $1, $2, $3, 'crossref') ON CONFLICT (kind, from_doi, to_doi) DO UPDATE SET to_item_id = coalesce(evimed_frontier.item_links.to_item_id, excluded.to_item_id)`,
      [from, doi, target.rows[0]?.id ?? null]);
    }
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
    const keysOf = new Map(entries.map((entry) => [entry.id, entryKeys(entry, sources.get(entry.source_id))]));
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
    const keys = entryKeys(entry, source);
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
          editor_diagnostics = CASE WHEN $9::boolean THEN '{}'::jsonb ELSE editor_diagnostics END,
          state = CASE WHEN $9::boolean AND state='scored' THEN 'screened' ELSE state END,
          channel = $10, platform = $11, author = $12::jsonb, media = coalesce($13::jsonb, '[]'::jsonb), quoted = $14::jsonb,
          metrics = $15::jsonb,
          updated_at = clock_timestamp()
        WHERE id = $1`, [item.id, entry.title_raw, entry.canonical_url, entry.doi, entry.pmid, entry.registry_ids ?? [],
        entry.published_at, entry.date_precision, moved, ...socialColumns(entry)]);
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
    // The provider refused for its balance a moment ago: wait it out.
    const paused = this.#providerPause(now);
    if (paused) {
      for (const entry of entries) await this.#waitEntry(entry, paused, this.providerPauseReason ?? "provider-refused");
      summary.deferred += entries.length;
      this.counters.providerRefusedWaits += entries.length;
      return;
    }
    // Collect only: nothing to screen with, or nothing to spend.
    if (!this.editor.available || budget.state === "exhausted") {
      const until = budget.state === "exhausted"
        ? frontierDayWindow(now, this.timeZone).end
        : new Date(now.getTime() + FRONTIER_TEXT_RETRY_MS);
      for (const entry of entries) await this.#waitEntry(entry, until, budget.state === "exhausted" ? "budget-exhausted" : "editor-unavailable");
      summary.deferred += entries.length;
      return;
    }
    // fr-social 2026-10-22: a post's author (organisation or person), counts and quoted post ride in the source line and
    // the excerpt (frontierIngest); every other entry reads exactly as before.
    const inputs = entries.map((entry) => ({
      key: String(entry.id),
      title: entry.title_raw,
      sourceName: frontierScreenSource(entry, sources.get(entry.source_id)?.name ?? entry.source_id),
      excerpt: frontierScreenExcerpt(entry, FRONTIER_SCREEN_EXCERPT_CHARS),
      allowedLanes: allowedLanes(sources.get(entry.source_id)),
    }));
    const { verdicts, errors, providerErrors } = await this.editor.screen(inputs);
    for (const entry of entries) {
      const source = sources.get(entry.source_id);
      try {
        const verdict = verdicts.get(String(entry.id));
        if (!verdict) {
          const code = errors.get(String(entry.id)) ?? "frontier_screen_invalid";
          if (code === "usage_budget_exceeded") {
            await this.#waitEntry(entry, frontierDayWindow(now, this.timeZone).end, "budget-exhausted");
            summary.deferred += 1;
          } else if (code === PROVIDER_BALANCE_REFUSAL) {
            // Our account, not the entry: a wait, never an attempt.
            await this.#waitEntry(entry, this.#pauseForProvider(now), "provider-refused");
            summary.deferred += 1;
            this.counters.providerRefusedWaits += 1;
          } else if (frontierProviderUnavailable({code,...providerErrors?.get(String(entry.id))})) {
            await this.#waitEntry(entry, this.#pauseForProvider(now, code), code);
            summary.deferred += 1;
          } else await this.#failEntry(entry, Object.assign(new Error(code), { code }), summary);
          continue;
        }
        const keep = verdict.medical && (verdict.news || source?.safety_feed === true);
        if (!keep) {
          await this.#finishEntry(entry, "screened-out", verdict.medical ? "not-news" : "not-medical");
          summary.screenedOut += 1;
          try { await this.evolution?.observe?.({ moduleId: "frontier", kind: "screened-out", eventId: `frontier-entry:${entry.id}:${entry.revision}`,
            codes: [verdict.medical ? "not-news" : "not-medical"], policyRevisionId: this.policyRevisionId }); } catch { /* Observation does not affect publication. */ }
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
   * @param {any} entry @param {any} source @param {{ lane: string, specialties: string[], language: string, digest?: boolean }} verdict @param {any} context
   * @returns {Promise<{ itemId: number | null, merged: boolean, waiting: boolean }>}
   */
  async #createItem(entry, source, verdict, context) {
    const { now, capabilities } = context;
    const keys = entryKeys(entry, source);
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
          first_seen_at, timeline_at, state, safety_alert, flags, channel, platform, author, media, quoted, metrics)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, 'screened', $17, $18,
          $19, $20, $21::jsonb, coalesce($22::jsonb, '[]'::jsonb), $23::jsonb, $24::jsonb)
        RETURNING id`, [randomBytes(8).toString("hex"), entry.source_id, entry.canonical_url, entry.identity_key,
        entry.doi, entry.pmid, entry.registry_ids ?? [], entry.title_raw, isChinese ? String(entry.title_raw).slice(0, 200) : null,
        isChinese ? "zh" : verdict.language || entry.lang || "und", verdict.lane, source?.source_type ?? "media", verdict.specialties,
        entry.published_at, entry.date_precision, entry.first_seen_at, source?.safety_feed === true,
        // 「多事汇总」 is the screening model's call and the item keeps it: a
        // daily column is not one event's report, and the event layer leaves
        // it out of clustering (2026-09-22).
        verdict.digest === true ? ["digest"] : [],
        // fr-social 2026-10-22 (contract 1.5.0): what the primary entry carries of a post, copied onto the item.
        ...socialColumns(entry)]);
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
    const decision = frontierTextDecision({ status, entry, source, promoted, now, nextAttemptAt: status === "pending" ? text?.next_attempt_at : null });
    if (decision.action === "hold") {
      await this.#finishEntry(entry, "held", status === "error" ? "plugin-text-unreachable" : "text-pending",
        { itemId, holdUntil: new Date(now.getTime() + decision.holdMs) });
      summary.held += 1;
      return;
    }
    if (decision.action === "drop") {
      // No text came and nothing else a reader could use: the item is not shown. It stays unpublished without a text, so a later
      // revision of the entry that brings one (the plugin read it again) takes it through the ordinary path.
      await this.#finishEntry(entry, "dropped", "no-text", { itemId });
      summary.dropped += 1;
      return;
    }
    const available = status === "available" ? text : null;
    await this.database.transaction(async (/** @type {any} */ client) => {
      const item = (await client.query("SELECT * FROM evimed_frontier.items WHERE id = $1 FOR UPDATE", [itemId])).rows[0];
      if (!item) throw Object.assign(new Error("The entry's item is gone."), { code: "frontier_item_missing" });
      const enrichment = available?.enrichment && typeof available.enrichment === "object" ? available.enrichment : null;
      const existing = (await client.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0] ?? null;
      const texts = {
        // fr-social 2026-10-22: the full text (contract 1.5.0) and whether the plugin delivered it whole. A revision without one
        // keeps the stored full text, the platform's own too (`body_text_origin`, which the plugin's full text replaces).
        body_text: available?.body_text ?? existing?.body_text ?? null,
        body_text_complete: available?.body_text ? available.text_kind === "full" : existing?.body_text_complete ?? null,
        abstract_raw: available?.abstract ?? existing?.abstract_raw ?? null,
        body_excerpt: available?.body_excerpt ? String(available.body_excerpt).slice(0, 12_000) : existing?.body_excerpt ?? null,
        publication_types: Array.isArray(enrichment?.publication_types) ? enrichment.publication_types.slice(0, 40) : existing?.publication_types ?? [],
        mesh: Array.isArray(enrichment?.mesh) ? enrichment.mesh.slice(0, 80) : existing?.mesh ?? [],
        journal: enrichment?.journal ?? existing?.journal ?? (typeof entry.facts?.journal === "string" ? entry.facts.journal : null),
        authors_short: enrichment?.authors_short ?? existing?.authors_short ?? null,
        open_access: enrichment?.open_access ?? existing?.open_access ?? null,
        enrichment: enrichment ?? existing?.enrichment ?? {},
      };
      const effectiveInput = buildModelInput(this.#editItem(item, texts, entry, source, glossary), { timeZone: this.editor.timeZone });
      const previousInput = existing ? buildModelInput(this.#editItem(item, existing, entry, source, glossary), { timeZone: this.editor.timeZone }) : null;
      const inputChanged = Boolean(existing && (previousInput !== effectiveInput
        || (item.editor_diagnostics?.inputSha256 && item.editor_diagnostics.inputSha256 !== sha256(effectiveInput))));
      // The text the edit will use; the edit stores what it actually sent.
      const modelInput = existing && item.editor_version ? existing.model_input
        : buildModelInput(this.#editItem(item, texts, entry, source, glossary), { timeZone: this.timeZone });
      // A text that changed (the plugin read it again, 2026-10-22 `retext`) is settled again (`reader_tidy`), and a translation
      // made from the column that changed is cleared: it was the old text's, and the translation step makes it again.
      const translationStale = `(cur.body_zh_source = 'body' AND cur.body_text IS DISTINCT FROM excluded.body_text)
          OR (cur.body_zh_source = 'abstract' AND cur.abstract_raw IS DISTINCT FROM excluded.abstract_raw)
          OR (cur.body_zh_source = 'excerpt' AND cur.body_excerpt IS DISTINCT FROM excluded.body_excerpt)`;
      await client.query(`INSERT INTO evimed_frontier.item_texts AS cur (item_id, abstract_raw, body_excerpt, model_input, model_input_sha256,
          publication_types, mesh, journal, authors_short, open_access, enrichment, body_text, body_text_complete)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
        ON CONFLICT (item_id) DO UPDATE SET abstract_raw = excluded.abstract_raw, body_excerpt = excluded.body_excerpt,
          model_input = excluded.model_input, model_input_sha256 = excluded.model_input_sha256,
          publication_types = excluded.publication_types, mesh = excluded.mesh, journal = excluded.journal,
          authors_short = excluded.authors_short, open_access = excluded.open_access, enrichment = excluded.enrichment,
          body_text = excluded.body_text, body_text_complete = excluded.body_text_complete,
          body_text_origin = CASE WHEN cur.body_text IS NOT DISTINCT FROM excluded.body_text THEN cur.body_text_origin END,
          reader_tidy = CASE WHEN cur.body_text IS NOT DISTINCT FROM excluded.body_text AND cur.abstract_raw IS NOT DISTINCT FROM excluded.abstract_raw
            AND cur.body_excerpt IS NOT DISTINCT FROM excluded.body_excerpt THEN cur.reader_tidy END,
          body_zh = CASE WHEN ${translationStale} THEN NULL ELSE cur.body_zh END,
          body_zh_kind = CASE WHEN ${translationStale} THEN NULL ELSE cur.body_zh_kind END,
          body_zh_at = CASE WHEN ${translationStale} THEN NULL ELSE cur.body_zh_at END,
          body_complete = CASE WHEN ${translationStale} THEN NULL ELSE cur.body_complete END,
          body_zh_source = CASE WHEN ${translationStale} THEN NULL ELSE cur.body_zh_source END`,
      [itemId, texts.abstract_raw, texts.body_excerpt, modelInput, createHash("sha256").update(modelInput).digest("hex"),
        texts.publication_types, texts.mesh, texts.journal, texts.authors_short, texts.open_access, JSON.stringify(texts.enrichment),
        texts.body_text, texts.body_text_complete]);
      // Every version bump in a transaction comes last, after its row locks:
      // a transaction never waits for a row while it holds the version.
      const linked = await this.#preprintLinks(client, item, texts.enrichment);
      if (item.state === "published") {
        // Text that arrives after publication: code-decided labels move now,
        // and the item owes one re-edit (review #11).
        const evidence = frontierEvidenceDecision({ source, identityKey: item.identity_key, publicationTypes: texts.publication_types,
          modelType: item.evidence_type });
        const linkFlags = await this.#linkFlags(client, item);
        const flags = frontierItemFlags({ source, entry, item, text: texts, modelFlags: frontierKeptModelFlags({ flags: item.flags, source }), linkFlags,
          safetyAlert: item.safety_alert === true });
        const evidenceType = evidence.fixed?.type ?? item.evidence_type;
        await client.query(`UPDATE evimed_frontier.items SET flags = $2, evidence_type = $3, evidence_basis = $4, score_authority = $5,
            score_total = CASE WHEN score_impact IS NULL THEN NULL ELSE $5 + score_impact + score_novelty + score_relevance END,
            editor_version = CASE WHEN $6::boolean AND rescored_at IS NULL THEN NULL ELSE editor_version END,
            editor_diagnostics = CASE WHEN $6::boolean THEN '{}'::jsonb ELSE editor_diagnostics END,
            text_arrived_at = CASE WHEN $6::boolean THEN clock_timestamp() ELSE text_arrived_at END,
            updated_at = clock_timestamp()
          WHERE id = $1`, [itemId, flags, evidenceType, evidence.fixed?.basis ?? item.evidence_basis,
          frontierAuthorityScore({ authority: source?.authority, evidenceType, preprint: source?.source_type === "preprint" }), inputChanged]);
      }
      if (inputChanged && item.state !== "published") {
        // An item waiting for its text (`frontierItemReadable`) is taken at once when the text arrives, not when its wait ends.
        await client.query(`UPDATE evimed_frontier.items SET editor_diagnostics='{}'::jsonb,
          state=CASE WHEN state='scored' THEN 'screened' ELSE state END,
          lease_until=CASE WHEN lease_owner IS NULL THEN NULL ELSE lease_until END WHERE id=$1`, [item.id]);
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
    // The full text (contract 1.4.0) stands in for the excerpt a post or a page has none of: the edit is bounded anyway.
    const bodyExcerpt = texts?.body_excerpt ?? (typeof texts?.body_text === "string" && texts.body_text.trim() ? texts.body_text.slice(0, 12_000) : null);
    const author = item.author && typeof item.author === "object" && typeof item.author.name === "string" && item.author.name.trim()
      ? { name: item.author.name, role: ["organisation", "person"].includes(item.author.role) ? item.author.role : null } : null;
    const quoted = item.quoted && typeof item.quoted === "object" && typeof item.quoted.text === "string" && item.quoted.text.trim()
      ? { authorName: String(item.quoted.author?.name ?? ""), text: item.quoted.text } : null;
    return {
      titleRaw: item.title_raw,
      // The institution, not the feed: the summary is prose a reader reads, and
      // the model repeats the source's name as it was shown it (plan 2026-09-23 §6.5 #5).
      sourceName: frontierSourceDisplayName({ id: source?.id ?? item.primary_source_id, name: source?.name, ownerEntity: source?.owner_entity }),
      sourceTypeLabel: /** @type {Record<string, string>} */ (FRONTIER_SOURCE_TYPE_LABELS_ZH)[source?.source_type] ?? null,
      publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null,
      datePrecision: item.date_precision,
      isChinese: isChineseTitle(item.title_raw),
      allowedLanes: allowedLanes(source),
      evidenceFixed: evidence.fixed,
      abstract,
      summary,
      bodyExcerpt,
      author,
      quoted,
      journal: texts?.journal ?? null,
      publicationTypes: texts?.publication_types ?? [],
      trialFacts: texts?.enrichment?.trial_facts ?? null,
      glossary: glossary.match([item.title_raw, abstract ?? summary ?? "", bodyExcerpt ?? ""].join("\n")),
      defaults: { lane: item.lane, specialties: item.specialties ?? [] },
    };
  }

  /**
   * An edit's input with the tree's tags its text names (「候选标签」, frontierTags.mjs) — added for the call only, never part of the
   * input's identity (`#editItem`).
   * @param {any} editItem @param {import("./frontierTags.mjs").FrontierTagVocabulary | null} vocabulary
   */
  #withTagCandidates(editItem, vocabulary) {
    if (!vocabulary) return editItem;
    const text = [editItem.abstract ?? editItem.summary ?? "", editItem.bodyExcerpt ? String(editItem.bodyExcerpt).slice(0, 4_000) : ""].join("\n");
    return { ...editItem, tagCandidates: vocabulary.candidatesFor({ title: editItem.titleRaw, text }).map((tag) => tag.name) };
  }

  /**
   * Everything an item's processing reads, in one place.
   * @param {any} item @param {any} [database]
   */
  async #itemContext(item, database = this.database) {
    const [texts, sources, entries] = await Promise.all([
      database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id]),
      database.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id]),
      database.query(`SELECT * FROM evimed_frontier.entries WHERE item_id = $1 AND state IN ('promoted', 'held', 'received')
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

  /** Capture source identity independently of the last model_input retained on disk.
   * @param {any} item @param {any} texts @param {any} source @param {any} entry @param {FrontierGlossary} glossary */
  #captureEditClaim(item, texts, source, entry, glossary) {
    item.editClaim = { inputSha256: sha256(buildModelInput(this.#editItem(item, texts, entry, source, glossary), { timeZone: this.editor.timeZone })),
      primarySourceId: item.primary_source_id, identityKey: item.identity_key,
      entryId: entry?.id ?? null, revision: entry?.revision ?? null, entrySha256: entry?.content_sha256 ?? null, glossary };
  }

  /** All edit-side writes hold the same item row lock as source intake. Exact expiry is the claim token.
   * @param {any} client @param {any} item */
  async #lockEditClaim(client, item) {
    // If context could not be read, no source identity was proved; expiry retains the existing retry accounting.
    if (!item.editClaim) return null;
    const current = (await client.query(`SELECT * FROM evimed_frontier.items
      WHERE id=$1 AND lease_owner=$2 AND lease_until=$3 AND lease_until>$4 FOR UPDATE`,
    [item.id, this.workerId, item.lease_until, this.now()])).rows[0];
    if (!current) return null;
    if (item.editClaim) {
      const { texts, source, entry } = await this.#itemContext(current, client);
      const inputSha256 = sha256(buildModelInput(this.#editItem(current, texts, entry, source, item.editClaim.glossary), { timeZone: this.editor.timeZone }));
      if (current.primary_source_id !== item.editClaim.primarySourceId || current.identity_key !== item.editClaim.identityKey
        || inputSha256 !== item.editClaim.inputSha256 || (entry?.id ?? null) !== item.editClaim.entryId
        || (entry?.revision ?? null) !== item.editClaim.revision || (entry?.content_sha256 ?? null) !== item.editClaim.entrySha256) {
        // Commit only release of this obsolete claim; never touch a replacement owner's lease or newer content.
        await client.query("UPDATE evimed_frontier.items SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_until=$3",
          [item.id,this.workerId,item.lease_until]);
        return null;
      }
    }
    return current;
  }

  /** @param {any} item @param {(client: any, current: any) => Promise<any>} work @param {boolean} [selectionLock] */
  async #withEditClaim(item, work, selectionLock = false) {
    const result = await this.database.transaction(async (/** @type {any} */ client) => {
      if (selectionLock) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const current = await this.#lockEditClaim(client, item);
      return current ? { applied: true, value: await work(client, current) } : { applied: false, value: null };
    });
    if (!result.applied) throw Object.assign(new Error("The frontier edit's source or claim changed."), { code: "frontier_edit_obsolete" });
    return result.value;
  }

  /** Store only closed metadata, including waits that never reach scoring.
   * @param {any} item @param {any} input @param {any} result @param {Date} now @param {string | null} [reason] */
  async #recordEditDiagnostics(item, input, result, now, reason = null) {
    const called = result !== null;
    const modelInput = input ? buildModelInput(input, { timeZone: this.editor.timeZone }) : null;
    const metadata = frontierEditorDiagnostics({ schemaVersion: 1,
      outcome: result?.verification ?? "deferred", attempts: called ? result.attempts : 0,
      inputSha256: result?.modelInputSha256 ?? (modelInput ? sha256(modelInput) : null),
      editorVersion: result?.editorVersion ?? null, checkedAt: now.toISOString(),
      reason: (reason === "exhausted" ? "budget" : reason) ?? (result?.error === "usage_budget_exceeded" ? "budget" : result?.error ? "call_failed" : null),
      fields: result?.fieldDiagnostics ?? { title_zh: ["not_checked"],
        summary_zh: input && !(input.abstract || input.summary || input.bodyExcerpt) ? ["source_missing"] : ["not_checked"] } });
    await this.#withEditClaim(item, async (client) => {
      await client.query("UPDATE evimed_frontier.items SET editor_diagnostics=$2::jsonb WHERE id=$1", [item.id, JSON.stringify(metadata)]);
      if (item.state === "published") await bumpFrontierVersion(client);
    });
    item.editor_diagnostics = metadata;
  }

  /** @param {any} item @param {any} input */
  async #editWithDiagnostics(item, input) {
    let result;
    try { result = await this.editor.edit(input); }
    catch (error) {
      // A throwing adapter cannot prove how many provider calls it made or which policy it resolved.
      await this.#recordEditDiagnostics(item, input, { verification: "pending", attempts: null }, this.now(),
        frontierProviderUnavailable(error) ? "provider_unavailable" : "call_failed");
      throw error;
    }
    await this.#recordEditDiagnostics(item, input, result, this.now(),
      frontierProviderUnavailable({ ...result, code: result.error }) ? "provider_unavailable" : null);
    return result;
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
        const { texts, source, entry } = await this.#itemContext(item);
        this.#captureEditClaim(item, texts, source, entry, context.glossary);
        if (item.attempts >= FRONTIER_MAX_ATTEMPTS) {
          await this.#withEditClaim(item, async (client) => {
            await client.query(`UPDATE evimed_frontier.items SET state = 'failed', lease_owner = NULL, lease_until = NULL,
              updated_at = clock_timestamp() WHERE id = $1`, [item.id]);
          });
          summary.failed += 1;
          continue;
        }
        if (!frontierItemReadable({ texts, entry, source })) {
          // Nothing a reader could use yet (2026-10-22): not published; asked again when its text arrives or in twelve hours.
          await this.#waitItem(item, new Date(now.getTime() + FRONTIER_TEXT_HOLD_MS), "no-text");
          summary.held += 1;
          continue;
        }
        if (item.state === "screened") {
          // A paused provider is an unavailable editor: published title-only, edited later.
          const available = this.editor.available && !this.#providerPause(now);
          const decision = frontierEditDecision({ source, budget: context.budget, offpeak: this.offpeak, now, available });
          let result = null;
          if (decision.edit) {
            result = await this.#editWithDiagnostics(item, this.#withTagCandidates(this.#editItem(item, texts, entry, source, context.glossary), context.tags));
            if (frontierProviderUnavailable({...result,code:result.error})) {
              await this.#waitItem(item,this.#pauseForProvider(now,result.error),result.error);
              summary.deferred += 1;
              continue;
            }
          } else {
            await this.#recordEditDiagnostics(item, this.#editItem(item, texts, entry, source, context.glossary), null, now, decision.reason);
            this.counters.editSkipped[decision.reason] += 1;
            summary.deferred += 1;
          }
          await this.#score(item, { texts, source, entry, result, context });
          if (result && result.verification !== "pending") summary.edited += 1;
        }
        if (await this.#publish(item, context)) summary.published += 1;
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
    if (!this.editor.available || budget.state === "exhausted" || this.#providerPause(now)) return;
    const general = budget.state === "ok" && !(this.offpeak && isPeak(now));
    const items = await this.#claimItems(now, `i.state = 'published' AND i.editor_version IS NULL
      AND (i.timeline_at > $5 OR (i.visible_at > $5 AND i.visible_at <= $1) OR i.text_arrived_at > $5
        OR EXISTS (SELECT 1 FROM evimed_frontier.dailies d
        WHERE d.generated_at > $5 AND d.generated_at <= $1 AND i.id = ANY(d.item_ids)))
      AND ($6::boolean OR s.safety_feed OR s.source_type = 'regulator' OR (s.source_type = 'journal' AND s.authority >= 5))`,
    [new Date(now.getTime() - FRONTIER_DEFERRED_EDIT_WINDOW_MS), general], DEFERRED_BATCH);
    for (const item of items) {
      try {
        const { texts, source, entry } = await this.#itemContext(item);
        this.#captureEditClaim(item, texts, source, entry, context.glossary);
        if (this.#providerPause(now)) {
          // An outage earlier in this batch spends no edit attempt.
          await this.#recordEditDiagnostics(item, this.#editItem(item, texts, entry, source, context.glossary), null, this.now(), "provider_unavailable");
          await this.#waitItem(item, this.#providerPause(now), this.providerPauseReason ?? "provider-refused");
          continue;
        }
        const result = await this.#editWithDiagnostics(item, this.#withTagCandidates(this.#editItem(item, texts, entry, source, context.glossary), context.tags));
        if (frontierProviderUnavailable({...result,code:result.error})) {
          await this.#waitItem(item, this.#pauseForProvider(now, result.error), result.error);
          summary.deferred += 1;
          if (result.error === PROVIDER_BALANCE_REFUSAL) this.counters.providerRefusedWaits += 1;
          continue;
        }
        if (result.verification === "pending") {
          // No answer: the attempt is spent; the third leaves the item title-only for good.
          const attempts = Number(item.attempts) + 1;
          await this.#withEditClaim(item, async (client) => {
            await client.query(`UPDATE evimed_frontier.items SET attempts = $2::integer,
                verification = CASE WHEN $2::integer >= $3::integer THEN 'title-only' ELSE verification END,
                editor_diagnostics = CASE WHEN $2::integer >= $3::integer THEN editor_diagnostics || '{"outcome":"title-only","reason":"retry_exhausted"}'::jsonb ELSE editor_diagnostics END,
                editor_version = CASE WHEN $2::integer >= $3::integer THEN $4::text ELSE editor_version END,
                lease_owner = NULL, lease_until = NULL WHERE id = $1`,
            [item.id, attempts, FRONTIER_MAX_ATTEMPTS, FRONTIER_EDITOR_VERSION]);
            if (attempts >= FRONTIER_MAX_ATTEMPTS) await bumpFrontierVersion(client);
          });
          continue;
        }
        await this.#score(item, { texts, source, entry, result, context });
        summary.edited += 1;
        await this.#reselect(item.id, context);
        summary.rescored += 1;
      } catch (error) {
        await this.#failItem(item, error, summary);
      }
    }
  }

  /** The existing claim predicate also respects an ownerless future lease_until.
   * @param {any} item @param {Date} until @param {string} reason */
  async #waitItem(item, until, reason) {
    await this.#withEditClaim(item, async (client) => {
      await client.query("UPDATE evimed_frontier.items SET lease_owner=NULL,lease_until=$2 WHERE id=$1", [item.id,until]);
      await client.query("UPDATE evimed_frontier.entries SET state_reason=$2 WHERE item_id=$1", [item.id,reason]);
    });
  }

  /** @param {any} item @param {unknown} error @param {FrontierBatchSummary} summary */
  async #failItem(item, error, summary) {
    const code = codeOf(error);
    if (code === "frontier_edit_obsolete") return;
    this.lastError = code;
    if (frontierProviderUnavailable(error)) {
      try { await this.#waitItem(item, this.#pauseForProvider(this.now(), code), code); }
      catch (stale) { if (codeOf(stale) === "frontier_edit_obsolete") return; throw stale; }
      summary.deferred += 1;
      return;
    }
    try {
      const attempts = Number(item.attempts) + 1;
      const published = item.state === "published";
      await this.#withEditClaim(item, async (client) => {
        await client.query(`UPDATE evimed_frontier.items SET attempts = $2::integer, lease_owner = NULL, lease_until = NULL,
            state = CASE WHEN $2::integer >= $3::integer AND NOT $4::boolean THEN 'failed' ELSE state END,
            editor_version = CASE WHEN $2::integer >= $3::integer AND $4::boolean THEN $5::text ELSE editor_version END,
            editor_diagnostics = CASE WHEN $2::integer >= $3::integer AND $4::boolean AND editor_diagnostics->>'schemaVersion' = '1'
              THEN editor_diagnostics || '{"outcome":"title-only","reason":"retry_exhausted"}'::jsonb ELSE editor_diagnostics END,
            updated_at = clock_timestamp()
          WHERE id = $1`, [item.id, attempts, FRONTIER_MAX_ATTEMPTS, published, FRONTIER_EDITOR_VERSION]);
        if (published && attempts >= FRONTIER_MAX_ATTEMPTS) await bumpFrontierVersion(client);
      });
      if (attempts >= FRONTIER_MAX_ATTEMPTS && !published) summary.failed += 1;
    } catch (release) {
      if (codeOf(release) === "frontier_edit_obsolete") return;
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
    const evidence = frontierEvidenceDecision({ source, identityKey: item.identity_key, publicationTypes: texts?.publication_types,
      modelType: output?.evidenceType ?? item.evidence_type ?? null });
    const evidenceType = evidence.fixed?.type ?? output?.evidenceType ?? (item.state === "published" ? item.evidence_type : null);
    const evidenceBasis = evidence.fixed?.basis ?? (output?.evidenceType ? "model" : item.state === "published" ? item.evidence_basis : null);
    const isChinese = isChineseTitle(item.title_raw);
    const scoreAuthority = frontierAuthorityScore({ authority: source?.authority, evidenceType, preprint: source?.source_type === "preprint" });
    const scores = output?.scores ?? null;
    const safetyAlert = frontierSafetyAlert({ source, evidenceType, lane: output?.lane ?? item.lane, facts: entry?.facts });
    const entities = output?.entities ?? item.entities ?? {};
    const glossary = context.glossary;
    const fields = {
      titleZh: output ? output.titleZh : (isChinese ? String(item.title_raw).slice(0, 200) : item.title_zh ?? null),
      summaryZh: output ? output.summaryZh : item.summary_zh ?? null,
      // The 推荐理由 (back on 2026-10-22, frontierEditor.mjs): an edit writes its own or none, never keeps an older edit's.
      reasonZh: output ? output.reasonZh ?? null : item.reason_zh ?? null,
      tags: output ? output.tags ?? [] : item.tags ?? [],
      lane: output?.lane ?? item.lane,
      specialties: output?.specialties ?? item.specialties ?? [],
      entities,
      entityKeys: glossary.entityKeys(entities),
      verification: output ? result.verification : "pending",
      editorVersion: output ? result.editorVersion : null,
      editorModel: output ? result.model : item.editor_model ?? null,
    };
    await this.#withEditClaim(item, async (client) => {
      const linkFlags = await this.#linkFlags(client, item);
      const flags = frontierItemFlags({ source, entry, item, text: texts, modelFlags: output?.flags ?? [], linkFlags, safetyAlert });
      await client.query(`UPDATE evimed_frontier.items SET title_zh = $2, summary_zh = $3, reason_zh = $4, lane = $5, specialties = $6,
          evidence_type = $7, evidence_basis = $8, entities = $9::jsonb, entity_keys = $10, flags = $11,
          score_authority = $12, score_impact = $13, score_novelty = $14, score_relevance = $15, score_total = $16,
          safety_alert = $17, verification = $18, editor_version = $19, editor_model = $20, tags = $22,
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
        safetyAlert, fields.verification, fields.editorVersion,
        fields.editorModel, context.now, fields.tags]);
      if (output) {
        await client.query("UPDATE evimed_frontier.item_texts SET model_input = $2, model_input_sha256 = $3 WHERE item_id = $1",
          [item.id, result.modelInput, result.modelInputSha256]);
        const linked = await this.tags.link(client, item.id, fields.tags, { origin: "edit", specialties: fields.specialties });
        this.counters.tagCandidatesCreated += linked.created;
      }
      if (item.state === "published") {
        await client.query(`UPDATE evimed_frontier.items SET lexemes = $2::tsvector WHERE id = $1`,
          [item.id, tsvectorLiteral(this.#lexemeText({ ...item, title_zh: fields.titleZh, summary_zh: fields.summaryZh, entities: fields.entities, tags: fields.tags }))]);
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'rescored')", [item.id]);
        // What was embedded described the item before its edit.
        if (context.capabilities?.vector) await client.query("DELETE FROM evimed_frontier.item_vectors WHERE item_id = $1", [item.id]);
        await bumpFrontierVersion(client);
      }
    });
    try { await this.evolution?.observe?.({ moduleId: "frontier", kind: "edit-verification", eventId: `frontier-edit:${item.id}:${result.modelInputSha256}:${result.editorVersion}`,
      codes: [result.verification], policyRevisionId: result.editorVersion,
      counts: { failed: Number(result.verification === "title-only"), numbersChecked: result.numbers?.checked ?? 0, numberFailures: result.numbers?.missing?.length ?? 0, unitMismatches: result.numbers?.unitMismatches?.length ?? 0 } }); } catch { /* Observation does not affect publication. */ }
  }

  /** The words search finds an item by. @param {any} item */
  #lexemeText(item) {
    const entities = item.entities && typeof item.entities === "object" ? Object.values(item.entities).flat() : [];
    return [item.title_raw, item.title_zh, item.summary_zh, ...entities, ...(Array.isArray(item.tags) ? item.tags : [])]
      .filter((part) => typeof part === "string" && part).join("\n");
  }

  /**
   * How many items of a source are selected on the item's day (safety alerts
   * and operator pins do not count against the cap).
   * @param {any} client @param {string} sourceId @param {Date} timelineAt
   */
  async #selectedToday(client, sourceId, timelineAt) {
    const { start, end } = frontierDayWindow(timelineAt, this.timeZone);
    const result = await client.query(`SELECT count(*)::integer AS selected FROM evimed_frontier.items
      WHERE primary_source_id = $1 AND state = 'published' AND selected AND selected_rule IN ('threshold', 'lane-floor', 'preprint-lane')
        AND timeline_at >= $2 AND timeline_at < $3`, [sourceId, start, end]);
    return Number(result.rows[0]?.selected ?? 0);
  }

  /**
   * Publish a scored item (plan §10.3.1 step 10): visible now, its timeline
   * instant fixed for good, selected or not, searchable, and announced — the
   * change row and the content version in the same transaction.
   * @param {any} claim @param {any} context @returns {Promise<boolean>}
   */
  async #publish(claim, context) {
    const { now } = context;
    return this.#withEditClaim(claim, async (client, item) => {
      const itemId = item.id;
      if (!item || item.state !== "scored") return false;
      const source = (await client.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id])).rows[0];
      const texts = (await client.query("SELECT publication_types FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0];
      const linkFlags = await this.#linkFlags(client, item);
      const flags = orderedFlags([...new Set([...item.flags, ...linkFlags])]);
      const timelineAt = frontierTimelineAt(now, item.published_at);
      const decision = frontierSelectionDecision({
        safetyAlert: item.safety_alert, verification: item.verification, scoreTotal: item.score_total,
        demoted: frontierEvidenceFromPublicationTypes(texts?.publication_types, { modelType: item.evidence_type }).demote, flags, source,
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
    }, true);
  }

  /**
   * After a re-edit: a published item that now clears the bar is selected
   * (never the reverse — selection is sticky).
   * @param {number} itemId @param {any} context
   */
  async #reselect(itemId, context) {
    await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const item = (await client.query(`SELECT i.*, ${frontierBesideSelectedSql("i")} AS beside_selected FROM evimed_frontier.items i
        WHERE i.id = $1 FOR UPDATE OF i`, [itemId])).rows[0];
      if (!item || item.state !== "published" || item.selected || item.beside_selected) return;
      const source = (await client.query("SELECT * FROM evimed_frontier.sources WHERE id = $1", [item.primary_source_id])).rows[0];
      const texts = (await client.query("SELECT publication_types FROM evimed_frontier.item_texts WHERE item_id = $1", [itemId])).rows[0];
      const decision = frontierSelectionDecision({
        safetyAlert: item.safety_alert, verification: item.verification, scoreTotal: item.score_total,
        demoted: frontierEvidenceFromPublicationTypes(texts?.publication_types, { modelType: item.evidence_type }).demote, flags: item.flags, source,
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
      const candidates = await client.query(`SELECT ranked.id, ranked.lane, ranked.evidence_type, t.publication_types FROM (
          SELECT i.id, i.lane, i.evidence_type, row_number() OVER (PARTITION BY i.lane ORDER BY i.score_total DESC, i.id) AS rank
          FROM evimed_frontier.items i
          WHERE i.state = 'published' AND i.timeline_at >= $1 AND i.timeline_at < $2 AND i.score_total >= $3
            AND i.verification IN ('passed', 'repaired') AND NOT i.selected AND NOT ('retracted' = ANY(i.flags))
            AND NOT (i.source_type = 'journal' AND 'no-abstract' = ANY(i.flags)) AND NOT ${frontierBesideSelectedSql("i")}
            AND NOT EXISTS (SELECT 1 FROM evimed_frontier.items s WHERE s.state = 'published' AND s.selected AND s.lane = i.lane
              AND s.timeline_at >= $1 AND s.timeline_at < $2)) AS ranked
        LEFT JOIN evimed_frontier.item_texts t ON t.item_id = ranked.id
        WHERE ranked.rank <= 5 ORDER BY ranked.lane, ranked.rank`, [start, end, FRONTIER_LANE_FLOOR_SCORE]);
      const chosen = new Map();
      for (const row of candidates.rows) {
        if (chosen.has(row.lane) || frontierEvidenceFromPublicationTypes(row.publication_types, { modelType: row.evidence_type }).demote) continue;
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
   * The preprint lane (owner ruling 2026-10-10, review B D-08; the numbers and the reasoning are
   * `FRONTIER_PREPRINT_LANE_PER_DAY_DEFAULT`'s). At the end of a round, a day (the lane floor's) that has selected fewer than
   * `preprintLanePerDay` items of the classes that cannot reach the line by arithmetic - preprint servers and company newsrooms
   * (`FRONTIER_PREPRINT_LANE_SOURCE_TYPES`) - takes the best of the rest: verified, not retracted, not a letter or a comment, with a
   * Chinese summary (the daily and the weekly carry no item without one), the highest total first, at or above the floor.
   * Everything the day already selected of those classes counts against the places, by whatever rule, so the lane tops a day up to
   * the number and never past it; an operator's pin does not count. Sticky like every selection: a better item that comes later
   * finds the places taken. The item keeps its source class (`preprint` / `company`, and the flag that says it is unreviewed or a
   * press release); only `selected_rule` says why it is here.
   * @param {any} context @returns {Promise<number>} how many items it selected
   */
  async #preprintLane(context) {
    if (this.preprintLanePerDay < 1) return 0;
    const { now } = context;
    const { start, end } = frontierDayWindow(now, this.timeZone);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SELECT_LOCK]);
      const taken = Number((await client.query(`SELECT count(*)::integer AS taken FROM evimed_frontier.items
        WHERE state = 'published' AND selected AND selected_rule IN ('threshold', 'lane-floor', 'preprint-lane')
          AND source_type = ANY($1) AND timeline_at >= $2 AND timeline_at < $3`,
      [FRONTIER_PREPRINT_LANE_SOURCE_TYPES, start, end])).rows[0]?.taken ?? 0);
      const room = this.preprintLanePerDay - taken;
      if (room < 1) return 0;
      // A few more than the room: a letter or a comment is dropped below, as the lane floor drops them.
      const candidates = await client.query(`SELECT i.id, i.evidence_type, t.publication_types FROM evimed_frontier.items i
        JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled
        LEFT JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE i.state = 'published' AND i.source_type = ANY($1) AND i.timeline_at >= $2 AND i.timeline_at < $3
          AND i.score_total >= $4 AND NOT i.selected AND NOT ('retracted' = ANY(i.flags))
          AND i.verification IN ('passed', 'repaired') AND length(btrim(coalesce(i.summary_zh, ''))) > 0 AND NOT ${frontierBesideSelectedSql("i")}
        ORDER BY i.score_total DESC, i.id LIMIT $5`,
      [FRONTIER_PREPRINT_LANE_SOURCE_TYPES, start, end, this.preprintLaneMinScore, room + 5]);
      const chosen = candidates.rows
        .filter((/** @type {any} */ row) => !frontierEvidenceFromPublicationTypes(row.publication_types, { modelType: row.evidence_type }).demote)
        .slice(0, room);
      for (const row of chosen) {
        await client.query(`UPDATE evimed_frontier.items SET selected = true, selected_rule = 'preprint-lane', selected_at = $2,
          updated_at = clock_timestamp() WHERE id = $1`, [row.id, now]);
        await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'selected')", [row.id]);
      }
      if (chosen.length) await bumpFrontierVersion(client);
      return chosen.length;
    });
  }

  /**
   * The reader's text, settled (2026-10-22, `frontierReaderTidy.mjs`): every published item's best reader text gets a verdict,
   * stored with the hash of the text it was made for (`item_texts.reader_tidy`), and the translation waits for it. A page or
   * WeChat text (the full text, or the page excerpt) is judged by the model — which paragraphs are not the article's — at most
   * `TIDY_MODEL_BATCH` a round, all at once; an abstract (laid out by section in code), an X post and a text too short to
   * judge are settled without a call, `TIDY_PLAIN_BATCH` a round. Selected items and safety alerts first, newest first; past
   * 80 % of the budget only they are judged, and nothing is while the provider is paused or the budget is spent. A call that
   * could not be made for the provider or the budget records nothing (the text is tried again); an answer code refuses
   * keeps the whole text and is recorded with its reason, so it is not asked again. A translation made from paragraphs the
   * reader is no longer shown — a paragraph taken out, or an abstract now laid out in more paragraphs than the translation
   * has — is cleared, and the translation step makes it again. Claimed with the item lease; written only while the text is
   * still the one judged. Moves the content version when what a reader sees changed.
   * @param {any} context
   */
  async #tidy(context) {
    const { now, budget, summary } = context;
    const hasText = "(t.body_text IS NOT NULL OR t.abstract_raw IS NOT NULL OR t.body_excerpt IS NOT NULL)";
    // The reader's text (frontierReaderText's order) is judged by the model when it is a page's or a WeChat article's.
    const judged = `(i.platform IS DISTINCT FROM 'x' AND (btrim(coalesce(t.body_text, '')) <> ''
      OR (btrim(coalesce(t.abstract_raw, '')) = '' AND btrim(coalesce(t.body_excerpt, '')) <> '')))`;
    const modelReady = this.editor.available && typeof this.editor.callJson === "function" && budget.state !== "exhausted"
      && !this.#providerPause(now);
    /** @param {string} which @param {number} limit @param {boolean} onlyLeading */
    const claim = async (which, limit, onlyLeading) => (await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE t.reader_tidy IS NULL AND ${hasText} AND i.state = 'published' AND (i.lease_until IS NULL OR i.lease_until <= $1)
          AND ${which} AND (NOT $2::boolean OR i.selected OR i.safety_alert)
        ORDER BY i.safety_alert DESC, i.selected DESC, i.visible_at DESC NULLS LAST, i.id DESC
        LIMIT $3
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $4, lease_until = $5 FROM picked WHERE i.id = picked.id
      RETURNING i.id, i.title_raw, i.platform, i.primary_source_id, i.lease_until`,
    [now, onlyLeading, limit, this.workerId, new Date(now.getTime() + this.leaseMs)])).rows;
    const plain = await claim(`NOT ${judged}`, TIDY_PLAIN_BATCH, false);
    const models = modelReady ? await claim(judged, TIDY_MODEL_BATCH, budget.state === "throttled") : [];
    const names = models.length ? await this.#sources(models.map((item) => item.primary_source_id)) : new Map();
    /** @param {any} item @param {boolean} ask */
    const settle = async (item, ask) => {
      let release = true;
      try {
        const texts = (await this.database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0];
        const reader = frontierReaderText({ ...texts, reader_tidy: null });
        if (!reader) return;
        const basis = /** @type {{ text: string, sha: string }} */ (frontierTidyBasis(texts, reader.source));
        /** @type {{ drop: number[], refused: string | null, called: boolean }} */
        let verdict = { drop: [], refused: null, called: false };
        if (ask && reader.source !== "abstract" && basis.text.length >= FRONTIER_TIDY_LIMITS.minChars) {
          if (this.#providerPause(now)) return;
          try {
            verdict = await frontierTidyVerdict(this.editor, { title: item.title_raw, source: names.get(item.primary_source_id)?.name ?? null,
              paragraphs: frontierParagraphs(basis.text) });
          } catch (error) {
            const code = codeOf(error);
            if (frontierProviderUnavailable(error)) { this.#pauseForProvider(now, code); return; }
            if (code === "usage_budget_exceeded" || code === "frontier_editor_unavailable") return;
            verdict = { drop: [], refused: code, called: true };
          }
        }
        const tidy = { source: reader.source, sha: basis.sha, drop: verdict.drop, at: now.toISOString(),
          ...(verdict.called ? { model: this.editor.model ?? null } : {}), ...(verdict.refused ? { refused: verdict.refused } : {}) };
        const outcome = await this.database.transaction(async (/** @type {any} */ client) => {
          const current = (await client.query(`SELECT i.id FROM evimed_frontier.items i WHERE i.id = $1 AND i.lease_owner = $2 AND i.lease_until = $3 FOR UPDATE`,
            [item.id, this.workerId, item.lease_until])).rows[0];
          if (!current) return null;
          const row = (await client.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1 FOR UPDATE", [item.id])).rows[0];
          // The text may have moved while the model was reading it: a verdict on another text is not this text's.
          if (frontierTidyBasis(row, reader.source)?.sha !== basis.sha) return null;
          const settled = frontierSettledParagraphs(basis.text, reader.source, tidy);
          const zh = row.body_zh_kind === "translation" && row.body_zh_source === reader.source && typeof row.body_zh === "string" ? row.body_zh : null;
          const stale = zh !== null && item.platform !== "x" && (tidy.drop.length > 0 || zh.split(/\n[ \t]*\n/).length !== settled.length);
          await client.query(`UPDATE evimed_frontier.item_texts SET reader_tidy = $2::jsonb${stale
            ? ", body_zh = NULL, body_zh_kind = NULL, body_zh_source = NULL, body_zh_at = NULL, body_complete = NULL" : ""} WHERE item_id = $1`,
          [item.id, JSON.stringify(tidy)]);
          await client.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1", [item.id]);
          const visible = tidy.drop.length > 0 || stale || settled.join("\n\n") !== frontierParagraphs(basis.text).join("\n\n");
          if (visible) await bumpFrontierVersion(client);
          return { stale };
        });
        if (outcome) {
          release = false;
          summary.tidied += 1;
          summary.tidyDropped += tidy.drop.length;
          this.counters.tidied += 1;
          this.counters.tidyDropped += tidy.drop.length;
          if (verdict.refused) this.counters.tidyRefused += 1;
          if (outcome.stale) this.counters.translationsCleared += 1;
        }
      } catch (error) {
        this.lastError = codeOf(error);
      } finally {
        if (release) {
          await this.database.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND lease_until = $3",
            [item.id, this.workerId, item.lease_until]).catch(() => { this.counters.releaseFailures += 1; });
        }
      }
    };
    for (const item of plain) await settle(item, false);
    await Promise.all(models.map((item) => settle(item, true)));
  }

  /**
   * The full text of an open-access paper the plugin could not read itself (2026-10-22: 「开放获取全文要进正文并翻译」): a 精选 or
   * near-line item of the last `FRONTIER_LEAD_WINDOW_MS` with no full text and an open-access PDF (`enrichment.oa_pdf_url`, from
   * Unpaywall or OpenAlex) is read once through the platform's web reader — robots.txt, private addresses refused, the PDF through
   * the document parser — and its text kept as the item's full text (`body_text_origin = 'oa-pdf'`) when it is the article
   * (`frontierFullTextParagraphs`). The reader text is then settled again (`reader_tidy` cleared), so the 导读, the 解读 and the
   * translation are made from the whole paper. Tried once per item (`oa_pdf_tried_at`), at most `FULLTEXT_BATCH` a round.
   * @param {any} context
   */
  async #fullText(context) {
    const { now } = context;
    if (!this.webReader) return;
    const claimed = (await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE i.state = 'published' AND i.visible_at > $2 AND (i.lease_until IS NULL OR i.lease_until <= $1)
          AND (i.selected OR i.safety_alert OR i.score_total >= $3) AND btrim(coalesce(t.body_text, '')) = ''
          AND t.enrichment->>'oa_pdf_url' ~* '^https?://' AND t.oa_pdf_tried_at IS NULL
        ORDER BY i.selected DESC, i.score_total DESC NULLS LAST, i.visible_at DESC
        LIMIT $4
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $5, lease_until = $6 FROM picked WHERE i.id = picked.id
      RETURNING i.id, i.lease_until`,
    [now, new Date(now.getTime() - FRONTIER_LEAD_WINDOW_MS), this.threshold - FRONTIER_READER_MARGIN, FULLTEXT_BATCH, this.workerId,
      new Date(now.getTime() + this.leaseMs)])).rows;
    await Promise.all(claimed.map((item) => this.#withItemLease(item, async () => {
      const texts = (await this.database.query("SELECT enrichment, body_text FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0];
      const url = String(texts?.enrichment?.oa_pdf_url ?? "");
      /** @type {{ body: string, complete: boolean } | null} */
      let read = null;
      try {
        const page = await this.webReader?.read(url, { signal: AbortSignal.timeout(FULLTEXT_TIMEOUT_MS) });
        read = page?.receipt?.contentType === "document" || page?.receipt?.contentType === "html" ? frontierFullTextParagraphs(page.text) : null;
      } catch {
        read = null;
      }
      const write = (/** @type {{ body: string, complete: boolean } | null} */ found) => this.#writeUnderLease(item, async (client) => {
        const row = (await client.query("SELECT body_text FROM evimed_frontier.item_texts WHERE item_id = $1 FOR UPDATE", [item.id])).rows[0];
        // The plugin's own full text may have arrived meanwhile: it is kept.
        const keep = found && !String(row?.body_text ?? "").trim();
        await client.query(`UPDATE evimed_frontier.item_texts SET oa_pdf_tried_at = $2${keep
          ? ", body_text = $3, body_text_complete = $4, body_text_origin = 'oa-pdf', reader_tidy = NULL" : ""} WHERE item_id = $1`,
        keep ? [item.id, now, found.body, found.complete] : [item.id, now]);
        await client.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1", [item.id]);
        if (keep) {
          this.counters.fullTexts += 1;
          await bumpFrontierVersion(client);
        } else this.counters.fullTextsMissed += 1;
      });
      try {
        return await write(read);
      } catch (error) {
        // A text the store refuses is a try all the same, recorded without it, so the queue moves on (2026-10-22: a length check
        // left from contract 1.5.0 refused every paper over 40,000 characters, and the first of them headed the queue each round).
        this.lastError = codeOf(error);
        this.counters.fullTextsRefused += 1;
        return write(null);
      }
    })));
  }

  /**
   * The reader's 导读 paragraph (`frontierLead.mjs`): every published item of the last `FRONTIER_LEAD_WINDOW_MS` whose settled
   * reader text has none yet — written from that text, kept with its hash (`lead_basis = reader_tidy->>'sha'`), and written again
   * when the text changes (a late abstract, a full text, the plugin reading it again). Safety alerts and 精选 first, then the
   * newest; past 80 % of the budget only they; nothing while the provider is paused or the budget is spent. A call the provider or
   * the budget prevented records nothing (asked again); an answer the checks refused twice, or an empty one, is recorded as no
   * 导读 for that text (the reader shows the card's summary) and not asked again until the text changes. Moves the content version.
   * @param {any} context
   */
  async #lead(context) {
    const { now, budget, summary } = context;
    if (!this.editor.available || typeof this.editor.writeJson !== "function" || budget.state === "exhausted" || this.#providerPause(now)) return;
    const claimed = (await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE i.state = 'published' AND i.visible_at > $2 AND (i.lease_until IS NULL OR i.lease_until <= $1)
          AND t.reader_tidy IS NOT NULL AND t.reader_tidy->>'source' = ${READER_BEST_SOURCE_SQL}
          AND i.lead_basis IS DISTINCT FROM t.reader_tidy->>'sha' AND (NOT $3::boolean OR i.selected OR i.safety_alert)
        ORDER BY i.safety_alert DESC, i.selected DESC, i.visible_at DESC, i.id DESC
        LIMIT $4
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $5, lease_until = $6 FROM picked WHERE i.id = picked.id
      RETURNING i.id, i.title_raw, i.title_zh, i.platform, i.primary_source_id, i.published_at, i.lease_until`,
    [now, new Date(now.getTime() - FRONTIER_LEAD_WINDOW_MS), budget.state === "throttled", LEAD_BATCH, this.workerId,
      new Date(now.getTime() + this.leaseMs)])).rows;
    if (!claimed.length) return;
    const sources = await this.#sources(claimed.map((item) => item.primary_source_id));
    await Promise.all(claimed.map((item) => this.#withItemLease(item, async () => {
      if (this.#providerPause(now)) return false;
      const texts = (await this.database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0];
      const reader = frontierReaderText(texts);
      const sha = texts?.reader_tidy?.sha;
      if (!reader || !sha || texts.reader_tidy.source !== reader.source) return false;
      const source = sources.get(item.primary_source_id);
      const result = await frontierWriteLead(this.editor, {
        sourceName: frontierSourceDisplayName({ id: item.primary_source_id, name: source?.name ?? item.primary_source_id, ownerEntity: source?.owner_entity }),
        date: item.published_at ? isoDayIn(item.published_at, this.timeZone) : null, titleRaw: item.title_raw, titleZh: item.title_zh,
        text: reader.text, kind: reader.source, post: item.platform === "x" });
      if (result.error && (frontierProviderUnavailable(result.error) || result.error === "usage_budget_exceeded" || result.error === "frontier_editor_unavailable")) {
        if (frontierProviderUnavailable(result.error)) this.#pauseForProvider(now, result.error);
        return false;
      }
      const lead = result.verification === "passed" || result.verification === "repaired" ? result.lead : null;
      const written = await this.#writeUnderLease(item, async (client) => {
        await client.query(`UPDATE evimed_frontier.items SET lead_zh = $2, lead_basis = $3, lead_at = $4, lease_owner = NULL, lease_until = NULL
          WHERE id = $1`, [item.id, lead, sha, now]);
        if (lead) await bumpFrontierVersion(client);
      });
      if (written) {
        summary.leads += lead ? 1 : 0;
        this.counters.leads += lead ? 1 : 0;
        if (!lead && result.verification === "dropped") this.counters.leadsDropped += 1;
        else if (!lead) this.counters.leadsEmpty += 1;
      }
      return written;
    })));
  }

  /**
   * The 「AI 解读」 of a 精选 item or a safety alert (`frontierInsight.mjs`), once its 导读 is written: the related reports it may
   * cite are gathered (its event's other reports and follow-ups, then earlier items naming the same drug or trial), and the basis
   * — the reader text's hash and those reports' ids — decides: unchanged since the last look, nothing is asked; no related report
   * and a short text, it is recorded as none without a call; otherwise the model writes one or answers that there is nothing to
   * say. Looked at again at most every `FRONTIER_INSIGHT_LIMITS.refreshMs`, so a follow-up that joins the event is taken in. Items
   * flagged retracted get none. The same budget and provider rules as the 导读.
   * @param {any} context
   */
  async #insight(context) {
    const { now, budget, summary } = context;
    if (!this.editor.available || typeof this.editor.writeJson !== "function" || budget.state === "exhausted" || this.#providerPause(now)) return;
    const claimed = (await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE i.state = 'published' AND (i.selected OR i.safety_alert) AND NOT ('retracted' = ANY(i.flags)) AND i.visible_at > $2
          AND (i.lease_until IS NULL OR i.lease_until <= $1) AND t.reader_tidy IS NOT NULL AND i.lead_basis = t.reader_tidy->>'sha'
          AND (i.insight_at IS NULL OR i.insight_at <= $3)
        ORDER BY i.safety_alert DESC, i.insight_at NULLS FIRST, i.visible_at DESC, i.id DESC
        LIMIT $4
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $5, lease_until = $6 FROM picked WHERE i.id = picked.id
      RETURNING i.id, i.title_raw, i.title_zh, i.lead_zh, i.summary_zh, i.entity_keys, i.event_id, i.primary_source_id, i.published_at,
        i.insight_basis, i.lease_until`,
    [now, new Date(now.getTime() - FRONTIER_INSIGHT_LIMITS.windowDays * DAY), new Date(now.getTime() - FRONTIER_INSIGHT_LIMITS.refreshMs),
      INSIGHT_BATCH, this.workerId, new Date(now.getTime() + this.leaseMs)])).rows;
    if (!claimed.length) return;
    await Promise.all(claimed.map((item) => this.#withItemLease(item, async () => {
      if (this.#providerPause(now)) return false;
      const texts = (await this.database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0];
      const reader = frontierReaderText(texts);
      const sha = texts?.reader_tidy?.sha;
      if (!reader || !sha) return false;
      const refs = await this.#insightRefs(item);
      const basis = frontierInsightBasis(sha, refs);
      /** @type {{ insight: string | null, cited: number[] }} */
      let written = { insight: null, cited: [] };
      if (basis !== item.insight_basis && frontierInsightWorthAsking({ text: reader.text, refs })) {
        const sources = await this.#sources([item.primary_source_id]);
        const source = sources.get(item.primary_source_id);
        this.counters.insightsAsked += 1;
        const result = await frontierWriteInsight(this.editor, {
          sourceName: frontierSourceDisplayName({ id: item.primary_source_id, name: source?.name ?? item.primary_source_id, ownerEntity: source?.owner_entity }),
          date: item.published_at ? isoDayIn(item.published_at, this.timeZone) : null, title: item.title_zh || item.title_raw,
          lead: item.lead_zh || item.summary_zh || null, text: reader.text, refs });
        if (result.error && (frontierProviderUnavailable(result.error) || result.error === "usage_budget_exceeded" || result.error === "frontier_editor_unavailable")) {
          if (frontierProviderUnavailable(result.error)) this.#pauseForProvider(now, result.error);
          return false;
        }
        written = result.verification === "passed" || result.verification === "repaired" ? { insight: result.insight, cited: result.cited } : written;
      } else if (basis === item.insight_basis) {
        // Nothing moved since the last look: only the look is recorded.
        return this.#writeUnderLease(item, async (client) => {
          await client.query("UPDATE evimed_frontier.items SET insight_at = $2, lease_owner = NULL, lease_until = NULL WHERE id = $1", [item.id, now]);
        });
      }
      const cited = written.cited.flatMap((n) => { const ref = refs.find((entry) => entry.n === n); return ref ? [{ n, item_id: ref.itemId }] : []; });
      const done = await this.#writeUnderLease(item, async (client) => {
        await client.query(`UPDATE evimed_frontier.items SET insight_zh = $2, insight_refs = $3::jsonb, insight_basis = $4, insight_at = $5,
          lease_owner = NULL, lease_until = NULL WHERE id = $1`, [item.id, written.insight, JSON.stringify(cited), basis, now]);
        await bumpFrontierVersion(client);
      });
      if (done) {
        summary.insights += written.insight ? 1 : 0;
        this.counters.insights += written.insight ? 1 : 0;
        if (!written.insight) this.counters.insightsEmpty += 1;
      }
      return done;
    })));
  }

  /**
   * The related reports an insight may cite, numbered from 1: the item's event's other reports and follow-ups
   * (`frontierItemFollowups`, newest first), then earlier published items of the last year that share a registered trial, a
   * named trial with a drug or a disease, two drugs, or the item's own drug and a disease with it, the most shared first — at most `FRONTIER_INSIGHT_LIMITS.refs`, each with its date, source, title and 导读.
   * @param {any} item @returns {Promise<import("./frontierInsight.mjs").FrontierInsightRef[]>}
   */
  async #insightRefs(item) {
    const followups = await frontierItemFollowups(this.database, item.id, { limit: 8 }).catch(() => null);
    // Related by what it is about, not by a word it shares (measured 2026-10-22: a glucose-meter recall drew four diabetes-drug
    // items through one shared key): the same registered trial; the same named trial or cohort with a drug or a disease too (a
    // name alone is shared — "trial:charls" stood on 32 unrelated papers, "trial:mint" on a myasthenia trial, a lymphoma study and
    // an emergency-department model); two of the same drugs; or the item's own drug (its first) and a disease both — a common
    // companion drug and a common disease are not enough (amlodipine and hypertension drew three unrelated studies).
    const keys = (Array.isArray(item.entity_keys) ? item.entity_keys : []).filter((key) => /^(?:drug|trial|disease):/.test(String(key)));
    const principal = keys.find((key) => String(key).startsWith("drug:")) ?? null;
    const byEntity = keys.some((key) => /^(?:drug|trial):/.test(String(key))) ? (await this.database.query(`SELECT i.public_id FROM (
        SELECT i.public_id, i.timeline_at,
          (SELECT count(*) FROM unnest(i.entity_keys) k WHERE k = ANY($2::text[]) AND k ~ '${FRONTIER_REGISTERED_TRIAL_KEY}') AS registered,
          (SELECT count(*) FROM unnest(i.entity_keys) k WHERE k = ANY($2::text[]) AND k LIKE 'trial:%') AS trials,
          (SELECT count(*) FROM unnest(i.entity_keys) k WHERE k = ANY($2::text[]) AND k LIKE 'drug:%') AS drugs,
          (SELECT count(*) FROM unnest(i.entity_keys) k WHERE k = ANY($2::text[]) AND k LIKE 'disease:%') AS diseases,
          ($6::text IS NOT NULL AND $6::text = ANY(i.entity_keys)) AS principal
        FROM evimed_frontier.items i
        WHERE i.state = 'published' AND i.id <> $1 AND i.entity_keys && $2::text[] AND i.visible_at > $3
          AND ($4::bigint IS NULL OR i.event_id IS DISTINCT FROM $4::bigint) AND i.timeline_at <= (SELECT timeline_at FROM evimed_frontier.items WHERE id = $1)) i
      WHERE i.registered > 0 OR (i.trials > 0 AND (i.drugs > 0 OR i.diseases > 0)) OR i.drugs >= 2 OR (i.principal AND i.diseases > 0)
      ORDER BY i.registered DESC, i.trials DESC, i.drugs + i.diseases DESC, i.timeline_at DESC
      LIMIT $5`, [item.id, keys, new Date(Date.now() - FRONTIER_INSIGHT_LIMITS.entityLookbackDays * DAY), item.event_id ?? null,
      FRONTIER_INSIGHT_LIMITS.refs, principal])).rows.map((row) => String(row.public_id)) : [];
    /** @type {Array<{ publicId: string, relation: "same-event" | "follows" | "entity" }>} */
    const wanted = [];
    for (const row of (followups?.rows ?? []).slice(0, 4)) wanted.push({ publicId: row.itemId, relation: row.relation });
    for (const publicId of byEntity) if (!wanted.some((entry) => entry.publicId === publicId)) wanted.push({ publicId, relation: "entity" });
    const chosen = wanted.slice(0, FRONTIER_INSIGHT_LIMITS.refs);
    if (!chosen.length) return [];
    const rows = (await this.database.query(`SELECT i.id, i.public_id, coalesce(i.title_zh, i.title_raw) AS title, coalesce(i.lead_zh, i.summary_zh) AS summary,
        i.timeline_at, i.primary_source_id, s.name AS source_name, s.owner_entity AS source_owner
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.public_id = ANY($1::text[]) AND i.state = 'published'`, [chosen.map((entry) => entry.publicId)])).rows;
    const byPublic = new Map(rows.map((row) => [String(row.public_id), row]));
    return chosen.flatMap((entry) => { const row = byPublic.get(entry.publicId); return row ? [row] : []; }).map((row, index) => ({
      n: index + 1, itemId: String(row.id), publicId: String(row.public_id),
      relation: chosen.find((entry) => entry.publicId === String(row.public_id))?.relation ?? "entity",
      sourceName: frontierSourceDisplayName({ id: row.primary_source_id, name: row.source_name, ownerEntity: row.source_owner }),
      date: row.timeline_at ? isoDayIn(row.timeline_at, this.timeZone) : null, title: String(row.title), summary: row.summary ?? null,
    }));
  }

  /**
   * Run one claimed item's work and release its lease if the work did not (an error, a pause, nothing written).
   * @param {any} item @param {() => Promise<boolean>} work
   */
  async #withItemLease(item, work) {
    let released = false;
    try {
      released = await work();
    } catch (error) {
      this.lastError = codeOf(error);
    } finally {
      if (!released) {
        await this.database.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND lease_until = $3",
          [item.id, this.workerId, item.lease_until]).catch(() => { this.counters.releaseFailures += 1; });
      }
    }
  }

  /**
   * A write that holds only while this worker still holds the item's lease; whether it was made.
   * @param {any} item @param {(client: any) => Promise<void>} write
   */
  async #writeUnderLease(item, write) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      const current = (await client.query("SELECT id FROM evimed_frontier.items WHERE id = $1 AND lease_owner = $2 AND lease_until = $3 FOR UPDATE",
        [item.id, this.workerId, item.lease_until])).rows[0];
      if (!current) return false;
      await write(client);
      return true;
    });
  }

  /**
   * The reader's full-text translation (contract B `body`, 2026-10-22), on the edit and never on a reader's click: published,
   * edited items that are selected or within `FRONTIER_READER_MARGIN` of the line, shown in the last `FRONTIER_LEAD_WINDOW_MS` (a
   * full text that arrives weeks later is translated too), whose best reader text
   * (`frontierReaderText`) is better than the one a translation was last made from — never translated, or the full text arrived
   * after the abstract was translated. A Chinese text is not translated: it is marked `original-zh`. An X post (and the post it
   * quotes) takes the post shape. Claimed with the item lease, so two rounds never pay for one item; the result is written only if
   * the text it was made from is still the item's. A translation that could not be had for the provider or the budget is not
   * recorded (it is tried again); one the checks refused is recorded with no Chinese text, and is tried again only when a better
   * text arrives — the reader keeps the original and the click path (中文摘要) stays. Moves the content version, and writes no
   * `item_changes` row: no downstream copy reads a translation. Past 80% of the budget only safety alerts are translated. A
   * text is translated once its best text is settled (`#tidy`), so a translation is never made of paragraphs the reader is not
   * shown.
   * @param {any} context @returns {Promise<number>} items whose Chinese text was written
   */
  async #translate(context) {
    const { now, budget, glossary } = context;
    if (typeof this.editor.translateBody !== "function" || !this.editor.available || budget.state === "exhausted" || this.#providerPause(now)) return 0;
    const rank = (/** @type {string} */ column) => `CASE ${FRONTIER_READER_SOURCES.map((source, index) => `WHEN t.${column} = '${source}' THEN ${FRONTIER_READER_SOURCES.length - index}`).join(" ")} ELSE 0 END`;
    const best = `CASE WHEN btrim(coalesce(t.body_text, '')) <> '' THEN 3 WHEN btrim(coalesce(t.abstract_raw, '')) <> '' THEN 2
      WHEN btrim(coalesce(t.body_excerpt, '')) <> '' THEN 1 ELSE 0 END`;
    const claimed = (await this.database.query(`WITH picked AS (
        SELECT i.id FROM evimed_frontier.items i JOIN evimed_frontier.item_texts t ON t.item_id = i.id
        WHERE i.state = 'published' AND i.editor_version IS NOT NULL AND (i.lease_until IS NULL OR i.lease_until <= $1)
          AND i.visible_at > $2 AND (i.selected OR i.safety_alert OR i.score_total >= $3) AND (NOT $4::boolean OR i.safety_alert)
          AND ${best} > ${rank("body_zh_source")} AND t.reader_tidy->>'source' = ${READER_BEST_SOURCE_SQL}
        ORDER BY i.safety_alert DESC, i.selected DESC, i.score_total DESC NULLS LAST, i.id DESC
        LIMIT $5
        FOR UPDATE OF i SKIP LOCKED)
      UPDATE evimed_frontier.items i SET lease_owner = $6, lease_until = $7 FROM picked WHERE i.id = picked.id
      RETURNING i.id, i.title_raw, i.platform, i.quoted, i.lease_until`,
    [now, new Date(now.getTime() - FRONTIER_LEAD_WINDOW_MS), this.threshold - FRONTIER_READER_MARGIN, budget.state === "throttled",
      TRANSLATE_BATCH, this.workerId, new Date(now.getTime() + this.leaseMs)])).rows;
    let written = 0;
    for (const item of claimed) {
      let release = true;
      /** @type {"body" | "abstract" | "excerpt" | null} */
      let translatedFrom = null;
      try {
        // A provider outage earlier in this round: the rest wait for the next one.
        if (this.#providerPause(now)) continue;
        const texts = (await this.database.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1", [item.id])).rows[0];
        const reader = frontierReaderText(texts);
        if (!reader) continue;
        translatedFrom = reader.source;
        const paragraphs = frontierParagraphs(reader.text);
        const post = item.platform === "x";
        const quotedText = item.quoted && typeof item.quoted === "object" && typeof item.quoted.text === "string" ? item.quoted.text : "";
        /** @type {{ kind: "translation" | "original-zh", zh: string | null, complete: boolean, quotedZh: string | null }} */
        let result;
        if (isChineseProse(paragraphs.slice(0, 6).join("\n"))) {
          result = { kind: "original-zh", zh: null, complete: true, quotedZh: null };
        } else {
          const hints = glossary.match([item.title_raw, reader.text.slice(0, 6_000)].join("\n"));
          const body = await this.editor.translateBody({ paragraphs: post ? [paragraphs.join("\n")] : paragraphs, glossary: hints, post });
          const quoted = quotedText && !isChineseProse(quotedText) && !body.error
            ? await this.editor.translateBody({ paragraphs: [quotedText], post: true }) : null;
          const error = body.error ?? quoted?.error ?? null;
          if (error && frontierProviderUnavailable(error)) {
            // The provider, not the text: nothing is recorded, the item is tried again after the pause.
            this.#pauseForProvider(now, error);
            continue;
          }
          if (error === "usage_budget_exceeded" || error === "frontier_editor_unavailable") continue;
          const done = body.paragraphs.filter((paragraph) => paragraph !== null).length;
          result = {
            kind: "translation",
            // What was verified, each paragraph in its place; one the checks refused keeps its original, so the two texts align.
            zh: done ? (post ? [body.paragraphs[0] ?? paragraphs.join("\n")] : body.paragraphs.map((paragraph, index) => paragraph ?? paragraphs[index])).join("\n\n") : null,
            complete: done > 0 && body.complete,
            quotedZh: quoted?.paragraphs[0] ?? null,
          };
          if (!result.complete) this.counters.translateIncomplete += 1;
        }
        const applied = await this.database.transaction(async (/** @type {any} */ client) => {
          const current = (await client.query(`SELECT i.id FROM evimed_frontier.items i WHERE i.id = $1 AND i.lease_owner = $2 AND i.lease_until = $3 FOR UPDATE`,
            [item.id, this.workerId, item.lease_until])).rows[0];
          if (!current) return false;
          const now2 = (await client.query("SELECT * FROM evimed_frontier.item_texts WHERE item_id = $1 FOR UPDATE", [item.id])).rows[0];
          // The text may have moved while the model was translating: a translation of another text is not this text's.
          if (frontierReaderText(now2, reader.source)?.text !== reader.text) return false;
          await client.query(`UPDATE evimed_frontier.item_texts SET body_zh = $2, body_zh_kind = $3, body_zh_source = $4, body_zh_at = $5,
              body_complete = $6, quoted_zh = $7 WHERE item_id = $1`,
          [item.id, result.zh, result.kind, reader.source, now, result.complete, result.quotedZh]);
          await client.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1", [item.id]);
          await bumpFrontierVersion(client);
          return true;
        });
        if (applied) {
          release = false;
          if (result.zh || result.kind === "original-zh") written += 1;
        }
      } catch (error) {
        this.lastError = codeOf(error);
        // A translation the store refuses (a check on its length or shape) was paid for once: it is recorded as made with no
        // Chinese text, so the next round does not pay for it again; the reader keeps the original.
        const refused = /** @type {any} */ (error)?.code === "23514" || /** @type {any} */ (error)?.code === "22001";
        if (refused && translatedFrom) {
          this.counters.translateStoreRefused += 1;
          await this.database.query(`UPDATE evimed_frontier.item_texts SET body_zh = NULL, body_zh_kind = 'translation', body_zh_source = $2,
              body_zh_at = $3, body_complete = false WHERE item_id = $1`, [item.id, translatedFrom, now]).catch(() => {});
        }
      } finally {
        if (release) {
          await this.database.query("UPDATE evimed_frontier.items SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND lease_until = $3",
            [item.id, this.workerId, item.lease_until]).catch(() => { this.counters.releaseFailures += 1; });
        }
      }
    }
    return written;
  }

  /**
   * Tag again what was published before the tag tree, or under an older tagging (`items.tag_version` below `FRONTIER_TAG_VERSION`):
   * newest first, `FRONTIER_RETAG_CALLS` calls of `FRONTIER_RETAG_BATCH` items side by side per batch, each item's specialties and
   * tags judged again from what was written about it (`FrontierEditor#retag`) and its tags linked to the tree. Only while the day's
   * budget is untouched by the 80% line and the provider is not paused: new items come first. An item claimed and not answered waits
   * out its claim; one the model answers malformed waits a day; nothing here fails a batch.
   * @param {any} context @returns {Promise<number>}
   */
  async #retag(context) {
    const { now, budget, tags } = context;
    if (!tags || !this.editor.available || typeof this.editor.retag !== "function" || budget.state !== "ok" || this.#providerPause(now)) return 0;
    const claimed = await this.database.query(`UPDATE evimed_frontier.items i SET tag_claim_until = $2
      WHERE i.id IN (SELECT id FROM evimed_frontier.items WHERE state = 'published' AND tag_version IS NULL
          AND (tag_claim_until IS NULL OR tag_claim_until < $1) ORDER BY timeline_at DESC LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING i.id, i.title_raw, i.title_zh, i.summary_zh, i.entities, i.specialties, i.tags, i.timeline_at`,
    [now, new Date(now.getTime() + 10 * MINUTE), FRONTIER_RETAG_BATCH * FRONTIER_RETAG_CALLS]);
    if (!claimed.rowCount) return 0;
    // RETURNING keeps no order: newest first again.
    const rows = [...claimed.rows].sort((left, right) => new Date(right.timeline_at).getTime() - new Date(left.timeline_at).getTime() || Number(right.id) - Number(left.id));
    const groups = [];
    for (let start = 0; start < rows.length; start += FRONTIER_RETAG_BATCH) groups.push(rows.slice(start, start + FRONTIER_RETAG_BATCH));
    const done = await Promise.all(groups.map(async (group) => {
      const input = group.map((row) => {
        const entities = row.entities && typeof row.entities === "object" ? row.entities : {};
        const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value.filter((name) => typeof name === "string") : []);
        return {
          titleZh: row.title_zh ?? null, titleRaw: row.title_raw, summaryZh: row.summary_zh ?? null,
          diseases: list(entities.diseases), drugs: list(entities.drugs),
          tagCandidates: tags.candidatesFor({ title: row.title_raw, text: [row.title_zh, row.summary_zh, ...list(entities.diseases), ...list(entities.drugs)].filter(Boolean).join("\n") }).map((/** @type {any} */ tag) => tag.name),
        };
      });
      let answers;
      try {
        answers = await this.editor.retag(input);
      } catch (error) {
        this.counters.retagFailures += 1;
        this.lastError = codeOf(error);
        if (frontierProviderUnavailable(error)) this.#pauseForProvider(this.now(), codeOf(error));
        return 0;
      }
      let count = 0;
      await this.database.transaction(async (/** @type {any} */ client) => {
        for (const [index, row] of group.entries()) {
          const answer = answers[index];
          if (!answer) {
            this.counters.retagSkipped += 1;
            await client.query("UPDATE evimed_frontier.items SET tag_claim_until = $2 WHERE id = $1", [row.id, new Date(now.getTime() + DAY_MS)]);
            continue;
          }
          await client.query(`UPDATE evimed_frontier.items SET specialties = $2, tags = $3, lexemes = $4::tsvector, updated_at = clock_timestamp() WHERE id = $1`,
            [row.id, answer.specialties, answer.tags, tsvectorLiteral(this.#lexemeText({ ...row, tags: answer.tags }))]);
          const linked = await this.tags.link(client, row.id, answer.tags, { origin: "retag", specialties: answer.specialties });
          this.counters.tagCandidatesCreated += linked.created;
          await client.query("INSERT INTO evimed_frontier.item_changes (item_id, op, reason) VALUES ($1, 'upsert', 'retagged')", [row.id]);
          count += 1;
        }
        if (count) await bumpFrontierVersion(client);
      });
      return count;
    }));
    const total = done.reduce((sum, value) => sum + value, 0);
    this.counters.retagged += total;
    return total;
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
