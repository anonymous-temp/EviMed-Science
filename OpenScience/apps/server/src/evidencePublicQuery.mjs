// What the public evidence pages and the read-only API may read, and how they read it (flywheel F08, F27, 2026-10-06).
//
// Hidden knowledge:
//
// - **"What is public" is one function, and it is in the statement.** `evidencePublicPredicate` is the SQL every public read carries —
//   the pages, the API, the sitemap and the feed (`evidenceFeed.mjs` passes its own audience) — so a reader of any of them can only be
//   handed a row the predicate admitted; nothing is fetched and filtered afterwards. For the pages and the API it is: the card and its
//   zone are published and the zone's visibility is `internet`, for every kind of zone. A zone that is platform-visible, a draft, or a
//   card whose account no longer exists (the join to `users` is inner) is not found, with exactly the answer a missing id gets.
//   NOTE for the programme: its official zones are created `platform`-visible and nothing opens them, so until the publisher account
//   calls `setVisibility(..., "internet")` on them they are not on these pages (the feed, whose audience differs, lists them already).
// - **Ordering reads only `EVIDENCE_RANKING_INPUTS`.** The index sorts its zones with `evidenceRankingComparator`, which refuses an
//   input that is not on the domain's list; a zone's cards are newest first (the `recency` input). There is no paid field to sort by.
// - **A ✓ is recomputed, never stored.** Each card's claims are checked against its sources' preserved text by the domain's
//   `verifyEvidenceCardClaims`, the same comparison the in-app reader's ✓ uses. The result is cached by (card id, revision) — a revision
//   never changes — so the heavy columns (sources carry their full text) are read only for a revision not seen before, and a list of
//   cards costs one light query.
// - **Source text never leaves.** A card's sources reach a page as title, address, coverage and check date; `documentText` and
//   `excerpt` are not selected into the model at all. A restricted source's claim carries no quotation (the card writer's rule), so
//   nothing here has any text to show for it.
// - **Authors are new until three of their published cards each carry a ✓.** The lift is a count taken at read time, so it is
//   automatic (`authorQualifies`); official zones are exempt (the platform is not a new author).
// - **No account id leaves.** An author or a zone's owner is named by the public handle (`evidenceAuthorHandles.mjs`), made for every
//   account a result mentions in one statement before the result is built; `author(handle)` and `authorQualifies(handle)` take a
//   handle and find the account behind it here, and an account id is the same "no such author" as a handle nobody holds. The account
//   id is read inside this module for the SQL (`user_id`) and is not a field of anything it returns.
//
// Which model capability would make it deletable: none — it is a projection of rows the platform already holds.

import {
  EVIDENCE_AI_STEPS,
  EVIDENCE_ORIGINALITY_LABELS_ZH,
  EVIDENCE_PRODUCER_KIND_LABELS_ZH,
  EVIDENCE_PRODUCER_RELATION_LABELS_ZH,
  EVIDENCE_ZONE_KIND_LABELS_ZH,
  SOURCE_CURRENCY_LABELS_ZH,
  evidenceCardClinicalView,
  evidenceCardPublicView,
  evidenceDefaultProducer,
  evidenceOriginalityIsPrimary,
  evidenceRankingComparator,
  verifyEvidenceCardClaims,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { EVIDENCE_AUTHOR_HANDLE, accountOfHandle, authorHandlesFor, migrateAuthorHandles } from "./evidenceAuthorHandles.mjs";
import { evidenceCurrencyView, EVIDENCE_ZONE_CURRENCY_SQL } from "./evidenceCurrency.mjs";
import { EVIDENCE_CHANGE_LOG_MAX_PAGE, readEvidenceChangeLog } from "./evidenceChangeLog.mjs";
import { safeHref } from "./evidencePublicHtml.mjs";

/** The shape of a zone id and a card id: a value of any other shape is never looked up. */
export const EVIDENCE_PUBLIC_ZONE_ID = /^ez_[A-Za-z0-9]{8,64}$/;
export const EVIDENCE_PUBLIC_CARD_ID = /^ec_[A-Za-z0-9]{8,64}$/;
/** An author as the author page's address names it: the public handle, never an account id. */
export const EVIDENCE_PUBLIC_AUTHOR_HANDLE = EVIDENCE_AUTHOR_HANDLE;

/** Zones one section of the index lists, and the candidates fetched to rank them from. */
export const EVIDENCE_PUBLIC_INDEX_ZONES = 50;
const INDEX_CANDIDATES = 100;
/** Cards one list page carries, at most. */
export const EVIDENCE_PUBLIC_MAX_PAGE = 50;
export const EVIDENCE_PUBLIC_DEFAULT_PAGE = 20;
/** Cards considered when an author's cards are counted for the new-author rule: three ✓ cards among the newest fifty is enough. */
const QUALIFYING_WINDOW = 50;
/** The published ✓ cards that make an author no longer new. */
export const EVIDENCE_PUBLIC_QUALIFYING_CARDS = 3;
/** Entries one sitemap lists at most (the protocol allows 50,000; this is a resource bound). */
export const EVIDENCE_PUBLIC_SITEMAP_CARDS = 5000;
/** Verified-card results kept: one small object per (card, revision). */
const VERIFICATION_CACHE = 5000;
const AUTHOR_CACHE = 500;

/**
 * The SQL that says what each audience may read. `pages` is the public pages, the API and the sitemap; `zones` is the same for a
 * zone alone; `feed` is the knowledge-source plugin's feed (official zones, and a researcher's original research in a zone opened to
 * the internet — never a product zone). Aliases are fixed by the caller's FROM clause.
 * @param {"pages" | "zones" | "feed"} audience @param {{ card?: string, zone?: string }} [aliases]
 */
export function evidencePublicPredicate(audience, { card = "c", zone = "z" } = {}) {
  if (audience === "feed") {
    // A user's card is admitted only when the platform published it from a research result (a lineage key no client can set) and
    // never on what its author says of it; whether its author is established is asked per author by the feed (2026-10-06 review).
    return `${card}.state = 'published' AND ${zone}.state = 'published' AND ${card}.withdrawn IS NULL
            AND (${zone}.kind = 'official' OR (${zone}.kind = 'user' AND ${zone}.visibility = 'internet' AND ${card}.lineage->>'resultVersionId' IS NOT NULL))`;
  }
  if (audience === "pages") return `${card}.state = 'published' AND ${zone}.state = 'published' AND ${zone}.visibility = 'internet'`;
  if (audience === "zones") return `${zone}.state = 'published' AND ${zone}.visibility = 'internet'`;
  throw new TypeError(`Unknown public audience "${audience}".`);
}

/** @param {unknown} value @returns {string | null} */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const labels = (/** @type {any} */ table, /** @type {unknown} */ key) => (typeof key === "string" ? table[key] ?? key : null);

/**
 * The producer line of a card or a zone, with the labels a reader reads.
 * @param {any} producer
 */
export function producerView(producer) {
  if (!producer || typeof producer !== "object") return null;
  const products = Array.isArray(producer.products) ? producer.products.map(String).slice(0, 20) : [];
  return {
    kind: String(producer.kind ?? ""), kindLabel: labels(EVIDENCE_PRODUCER_KIND_LABELS_ZH, producer.kind),
    name: String(producer.name ?? ""), relation: String(producer.relation ?? "none"), relationLabel: labels(EVIDENCE_PRODUCER_RELATION_LABELS_ZH, producer.relation ?? "none"),
    products,
  };
}

/**
 * Whether a card was written, wholly or in part, by an AI: its editorial receipt says an AI wrote it, or its disclosure names a
 * model or any step an AI took. A property of the record, not a reading of its prose.
 * @param {{ editorial?: any, disclosure?: any }} card
 */
export function evidenceCardIsAiGenerated({ editorial, disclosure }) {
  if (editorial?.author?.kind === "ai") return true;
  if (typeof disclosure?.model === "string" && disclosure.model.trim()) return true;
  return Array.isArray(disclosure?.aiSteps) && disclosure.aiSteps.some((/** @type {string} */ step) => EVIDENCE_AI_STEPS.includes(/** @type {any} */ (step)));
}

/**
 * One source as a reader may see it: where it is and what it is called. Never its text, its excerpt or its hash.
 * @param {any} source @param {number} index 1-based, as claims name sources
 */
function sourceView(source, index) {
  return {
    index, title: String(source?.title ?? ""), url: safeHref(source?.url), coverage: text(source?.coverage), checkedAt: iso(source?.checkedAt),
    ...(source?.publicationStatus?.kind ? { publicationStatus: String(source.publicationStatus.kind) } : {}),
  };
}

/** @param {any} counts the `counts` of `verifyEvidenceCardClaims` */
const claimCounts = (counts) => ({
  total: counts.total ?? 0, verified: counts.verified ?? 0, derived: counts.derived ?? 0,
  warned: (counts.quote_not_found ?? 0) + (counts.source_unavailable ?? 0) + (counts.no_quote ?? 0),
});

/**
 * The claims of a card with their marks and the quotations that stand under them: the direct claim's quotation and source, a
 * synthesized claim's quotation from each source, a derived claim's stated method (it has no quotation to check).
 * @param {any[]} claims @param {ReturnType<typeof verifyEvidenceCardClaims>} verification @param {ReturnType<typeof sourceView>[]} sources
 */
function claimViews(claims, verification, sources) {
  const verdicts = new Map(verification.claims.map((claim) => [claim.claimId, claim]));
  const source = (/** @type {unknown} */ index) => sources.find((entry) => entry.index === index) ?? null;
  return claims.map((claim) => {
    const verdict = verdicts.get(claim.claimId);
    const quotes = claim.claimType === "synthesized"
      ? (claim.supportingSources ?? []).map((/** @type {any} */ bond) => ({ quote: text(bond.supportQuote), source: source(bond.sourceIndex) }))
      : claim.claimType === "derived" ? []
        : [{ quote: text(claim.supportQuote), source: source((claim.sourceIndexes ?? [])[0]) }];
    return {
      claimId: String(claim.claimId), claimType: String(claim.claimType), text: String(claim.claim), mark: verdict?.mark ?? "⚠", status: verdict?.status ?? "unknown",
      quotes, applicability: text(claim.applicability), uncertainty: text(claim.uncertainty), confidence: text(claim.confidence),
      valueSource: text(claim.valueSource),
      ...(claim.claimType === "derived" ? { method: text(claim.method), assumptions: text(claim.assumptions), sensitivity: text(claim.sensitivity) } : {}),
    };
  });
}

/**
 * @param {{ database: any, now?: () => Date }} options
 */
export function createEvidencePublicReads({ database, now = () => new Date() }) {
  const counters = { verifications: 0, verificationCacheHits: 0, authorChecks: 0, failures: 0 };
  /** @type {Map<string, { total: number, verified: number, derived: number, warned: number }>} */
  const verificationCache = new Map();
  /** @type {Map<string, { qualifies: boolean, key: string }>} */
  const authorCache = new Map();

  async function ready() {
    await migrateEvidenceZones(database);
    await migrateAuthorHandles(database);
  }

  /**
   * The public handle of each account in a set of rows, made where missing, in one statement.
   * @param {any[]} rows @param {string} [column] the row field that holds the account id
   * @returns {Promise<Map<string, string>>}
   */
  const handlesOf = (rows, column = "user_id") => authorHandlesFor(database, rows.map((row) => row[column]));

  /** A handle's account, remembered: the handle of an account never changes. @type {Map<string, string>} */
  const accounts = new Map();
  /** @param {unknown} handle @returns {Promise<string | null>} */
  async function accountIdOf(handle) {
    if (typeof handle !== "string" || !EVIDENCE_AUTHOR_HANDLE.test(handle)) return null;
    const known = accounts.get(handle);
    if (known) return known;
    const found = await accountOfHandle(database, handle);
    if (!found) return null;
    accounts.set(handle, found.id);
    if (accounts.size > AUTHOR_CACHE) accounts.delete(/** @type {string} */ (accounts.keys().next().value));
    return found.id;
  }

  /** The zones' content version: every zone and card write moves it. */
  async function version() {
    await migrateEvidenceZones(database);
    return String((await database.query("SELECT version FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0]?.version ?? "0");
  }

  /**
   * The verified/warned counts of cards, by (id, revision). A card without claims is zero without a read; the rest are read in one query
   * for those not cached and checked against their sources' preserved text.
   * @param {{ id: string, revision: number, claim_count?: number }[]} rows
   */
  async function verificationOf(rows) {
    const out = new Map();
    const missing = [];
    for (const row of rows) {
      const key = `${row.id}:${row.revision}`;
      const known = verificationCache.get(key);
      if (known) { counters.verificationCacheHits += 1; verificationCache.delete(key); verificationCache.set(key, known); out.set(row.id, known); continue; }
      if (row.claim_count === 0) { out.set(row.id, { total: 0, verified: 0, derived: 0, warned: 0 }); continue; }
      missing.push(row);
    }
    if (missing.length) {
      const heavy = (await database.query("SELECT id, revision, claims, sources FROM evimed_frontier.evidence_cards WHERE id = ANY($1::text[])", [missing.map((row) => row.id)])).rows;
      for (const card of heavy) {
        const counts = claimCounts(verifyEvidenceCardClaims({ claims: card.claims ?? [], sources: card.sources ?? [] }).counts);
        counters.verifications += 1;
        verificationCache.set(`${card.id}:${card.revision}`, counts);
        if (verificationCache.size > VERIFICATION_CACHE) verificationCache.delete(/** @type {string} */ (verificationCache.keys().next().value));
        out.set(card.id, counts);
      }
    }
    return out;
  }

  const ZERO_COUNTS = Object.freeze({ total: 0, verified: 0, derived: 0, warned: 0 });

  /** The light columns of a card as a list row carries them. */
  const CARD_LIST_COLUMNS = `c.id, c.zone_id, c.user_id, c.revision, c.title, c.summary, c.producer, c.originality, c.editorial, c.disclosure,
    c.currency, c.pending_item_ids, c.last_checked_at, c.withdrawn, c.retired_at, c.created_at, c.updated_at, jsonb_array_length(c.claims) AS claim_count,
    u.name AS creator, z.kind AS zone_kind, z.title AS zone_title`;

  /**
   * One card as a list shows it. @param {any} row @param {{ total: number, verified: number, derived: number, warned: number }} counts
   * @param {Map<string, string>} handles
   */
  function cardSummary(row, counts, handles) {
    const currency = evidenceCurrencyView(row);
    return {
      id: String(row.id), zoneId: String(row.zone_id), zoneTitle: row.zone_title ?? null, zoneKind: row.zone_kind ?? null, title: String(row.title), summary: String(row.summary ?? ""), revision: Number(row.revision),
      producer: producerView(row.producer), originality: row.originality ?? null, originalityLabel: labels(EVIDENCE_ORIGINALITY_LABELS_ZH, row.originality),
      primary: evidenceOriginalityIsPrimary(row.originality), aiGenerated: evidenceCardIsAiGenerated(row),
      creator: { id: handles.get(String(row.user_id)) ?? null, name: String(row.creator ?? "") },
      claims: counts, currency: currency.currency, currencyLabel: currency.currencyLabel, pendingItems: currency.pendingItemIds.length, hasPendingEvidence: currency.pendingItemIds.length > 0,
      lastCheckedAt: currency.lastCheckedAt ?? iso(row.disclosure?.lastCheckedAt), withdrawn: currency.withdrawn,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  }

  /** @param {string | null | undefined} cursor @returns {{ updatedKey: string, id: string } | null} */
  function decodeCursor(cursor) {
    if (!cursor) return null;
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof value?.u !== "string" || !Number.isFinite(Date.parse(value.u)) || typeof value?.i !== "string" || !value.i || value.i.length > 100) throw new Error();
      return { updatedKey: value.u, id: value.i };
    } catch {
      throw new HttpError(400, "evidence_public_query_invalid", "The cursor is not valid; read from the first page.");
    }
  }
  const encodeCursor = (/** @type {{ updated_key: string, id: string }} */ row) => Buffer.from(JSON.stringify({ u: row.updated_key, i: row.id })).toString("base64url");

  /** @param {unknown} limit @param {number} fallback */
  function pageSize(limit, fallback = EVIDENCE_PUBLIC_DEFAULT_PAGE) {
    if (limit === null || limit === undefined || limit === "") return fallback;
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > EVIDENCE_PUBLIC_MAX_PAGE) throw new HttpError(400, "evidence_public_query_invalid", `limit is a whole number from 1 to ${EVIDENCE_PUBLIC_MAX_PAGE}.`);
    return size;
  }

  /** The zone row of a public zone with what its heading needs, or null. @param {string} zoneId */
  async function zoneRow(zoneId) {
    if (typeof zoneId !== "string" || !EVIDENCE_PUBLIC_ZONE_ID.test(zoneId)) return null;
    await ready();
    return (await database.query(
      `SELECT z.id, z.title, z.description, z.background, z.kind, z.revision, z.created_at, z.updated_at, z.user_id, u.name AS owner_name,
         (SELECT count(*)::integer FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id) AS follows,
         (SELECT c.producer FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published' AND c.producer IS NOT NULL
            ORDER BY c.updated_at DESC, c.id LIMIT 1) AS producer
       FROM evimed_frontier.evidence_zones z JOIN evimed_control.users u ON u.id = z.user_id
       WHERE z.id = $1 AND ${evidencePublicPredicate("zones")}`, [zoneId])).rows[0] ?? null;
  }

  /** @param {any} row @param {Map<string, string>} handles */
  function zoneBase(row, handles) {
    const producer = row.producer ?? evidenceDefaultProducer({ zoneKind: row.kind, ownerName: row.owner_name });
    return {
      id: String(row.id), title: String(row.title), description: String(row.description ?? ""), kind: String(row.kind), kindLabel: labels(EVIDENCE_ZONE_KIND_LABELS_ZH, row.kind),
      producer: producerView(producer), owner: { id: handles.get(String(row.user_id)) ?? null, name: String(row.owner_name ?? "") }, follows: Number(row.follows ?? 0),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  }

  return {
    ready, version,

    /** The three sections of the index, each ranked by the domain's own ranking inputs and never mixed. */
    async indexZones() {
      await ready();
      const rank = evidenceRankingComparator(["recency", "follows", "review_score"]);
      /** @type {{ official: any[], product: any[], user: any[] }} */
      const sections = { official: [], product: [], user: [] };
      /** @type {Record<string, any[]>} */
      const found = {};
      for (const kind of /** @type {const} */ (["official", "product", "user"])) {
        found[kind] = (await database.query(
          `SELECT z.id, z.title, z.description, z.kind, z.revision, z.created_at, z.updated_at, z.user_id, u.name AS owner_name,
             (SELECT count(*)::integer FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published' AND c.withdrawn IS NULL) AS card_count,
             (SELECT max(c.updated_at) FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published') AS last_card_at,
             (SELECT count(*)::integer FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id) AS follows,
             (SELECT avg(r.score)::float8 FROM evimed_frontier.evidence_reviews r JOIN evimed_frontier.evidence_cards c ON c.id = r.card_id AND c.revision = r.card_revision
               WHERE c.zone_id = z.id AND c.state = 'published') AS review_score,
             (SELECT c.producer FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published' AND c.producer IS NOT NULL
               ORDER BY c.updated_at DESC, c.id LIMIT 1) AS producer
           FROM evimed_frontier.evidence_zones z JOIN evimed_control.users u ON u.id = z.user_id
           WHERE ${evidencePublicPredicate("zones")} AND z.kind = $1 ORDER BY z.updated_at DESC, z.id LIMIT $2`, [kind, INDEX_CANDIDATES])).rows;
      }
      const handles = await handlesOf(Object.values(found).flat());
      for (const kind of /** @type {const} */ (["official", "product", "user"])) {
        sections[kind] = found[kind].map((row) => {
          const latest = Math.max(new Date(row.updated_at).getTime(), row.last_card_at ? new Date(row.last_card_at).getTime() : 0);
          return {
            ...zoneBase(row, handles), cards: Number(row.card_count), lastCardAt: iso(row.last_card_at),
            // The day, not the instant: two zones touched on one day tie on `recency` and fall to the next input.
            ranking: { recency: Math.floor(latest / 86_400_000), follows: Number(row.follows), review_score: row.review_score === null ? null : Number(row.review_score) },
          };
        }).sort(rank).slice(0, EVIDENCE_PUBLIC_INDEX_ZONES).map(({ ranking: _ranking, ...zone }) => zone);
      }
      return sections;
    },

    /**
     * One public zone with its counts, or null when there is no such public zone (the caller answers 404).
     * @param {string} zoneId
     */
    async zone(zoneId) {
      const row = await zoneRow(zoneId);
      if (!row) return null;
      const counts = (await database.query(
        `SELECT count(*) FILTER (WHERE state = 'published' AND withdrawn IS NULL)::integer AS cards, count(*) FILTER (WHERE state = 'published' AND withdrawn IS NOT NULL)::integer AS withdrawn,
           ${EVIDENCE_ZONE_CURRENCY_SQL} FROM evimed_frontier.evidence_cards WHERE zone_id = $1`, [zoneId])).rows[0];
      return {
        ...zoneBase(row, await handlesOf([row])), background: String(row.background ?? ""), revision: Number(row.revision), cards: counts.cards, withdrawnCards: counts.withdrawn,
        currencyCounts: Object.fromEntries(Object.keys(SOURCE_CURRENCY_LABELS_ZH).map((label) => [label, Number(counts[`currency_${label}`] ?? 0)])),
        lastCheckedAt: iso(counts.currency_last_checked_at),
      };
    },

    /**
     * One page of a public zone's published cards, newest first (the `recency` input), each with its ✓/⚠ counts. Withdrawn cards are in
     * the list, marked: a card taken back keeps its page.
     * @param {string} zoneId @param {{ limit?: unknown, cursor?: string | null }} [query]
     */
    async zoneCards(zoneId, { limit = null, cursor = null } = {}) {
      const size = pageSize(limit);
      const after = decodeCursor(cursor);
      await ready();
      const rows = (await database.query(
        `SELECT ${CARD_LIST_COLUMNS}, to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_key
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
         WHERE c.zone_id = $1 AND ${evidencePublicPredicate("pages")} AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::text))
         ORDER BY c.updated_at DESC, c.id DESC LIMIT $4`, [zoneId, after?.updatedKey ?? null, after?.id ?? null, size + 1])).rows;
      const kept = rows.slice(0, size);
      const verification = await verificationOf(kept.filter((row) => !row.withdrawn));
      const handles = await handlesOf(kept);
      return {
        items: kept.map((row) => cardSummary(row, verification.get(row.id) ?? ZERO_COUNTS, handles)),
        next: rows.length > size && kept.length ? encodeCursor(kept[kept.length - 1]) : null,
      };
    },

    /**
     * One public card in full, or null. A withdrawn card is returned with `withdrawn` set and no claims, no view and no sources: it
     * says why it was taken back and nothing it said stands.
     * @param {string} cardId @param {"clinical" | "public"} [view]
     */
    async card(cardId, view = "clinical") {
      if (typeof cardId !== "string" || !EVIDENCE_PUBLIC_CARD_ID.test(cardId)) return null;
      await ready();
      const row = (await database.query(
        `SELECT c.*, u.name AS creator, z.kind AS zone_kind, z.title AS zone_title, z.user_id AS zone_owner, jsonb_array_length(c.claims) AS claim_count
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
         WHERE c.id = $1 AND ${evidencePublicPredicate("pages")}`, [cardId])).rows[0];
      if (!row) return null;
      const currency = evidenceCurrencyView(row);
      const zone = { id: String(row.zone_id), title: String(row.zone_title), kind: String(row.zone_kind) };
      const handles = await handlesOf([row]);
      if (currency.withdrawn) return { ...cardSummary(row, ZERO_COUNTS, handles), withdrawn: currency.withdrawn, claimList: [], sources: [], view: null, disclosure: row.disclosure ?? null, lineage: null, content: null, zone };
      const contract = {
        title: row.title, content: row.content ?? null, sources: row.sources ?? [], claims: row.claims ?? [], producer: row.producer ?? null, originality: row.originality ?? null,
        lineage: row.lineage ?? null, journeyStage: row.journey_stage ?? null, disclosure: row.disclosure ?? null, publicView: row.public_view ?? null, editorial: row.editorial ?? null,
      };
      const verification = verifyEvidenceCardClaims(contract);
      counters.verifications += 1;
      verificationCache.set(`${row.id}:${row.revision}`, claimCounts(verification.counts));
      const sources = contract.sources.map((/** @type {any} */ source, /** @type {number} */ index) => sourceView(source, index + 1));
      const clinical = evidenceCardClinicalView(contract, { verification });
      const full = view === "public" ? evidenceCardPublicView(contract, { verification }) : clinical;
      // The claims are listed once, with their marks, by `claimList`; the clinical view's own list is only its verified ones.
      const { claims: _verified, ...viewContent } = /** @type {any} */ (full);
      return {
        ...cardSummary(row, claimCounts(verification.counts), handles), view: view === "public" ? "public" : "clinical", viewContent,
        claimList: claimViews(contract.claims, verification, sources), sources, disclosure: row.disclosure ?? null, journeyStage: row.journey_stage ?? null,
        content: row.content ?? null, lineage: publicLineage(row.lineage),
        zone,
      };
    },

    /**
     * The cards a card points to and the published ones that point to it, public ones only: the card it follows, the card its research
     * began from, the newer versions that follow it, and research that began from it.
     * @param {{ id: string, lineage?: any }} card
     */
    async cardLinks(card) {
      await ready();
      const ref = `c.id, c.zone_id, c.title, c.producer, c.updated_at, u.name AS creator`;
      /** @param {unknown} id */
      const pointed = async (id) => {
        if (typeof id !== "string" || !EVIDENCE_PUBLIC_CARD_ID.test(id)) return null;
        const row = (await database.query(
          `SELECT ${ref} FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
           WHERE c.id = $1 AND ${evidencePublicPredicate("pages")}`, [id])).rows[0];
        return row ? linkRef(row) : null;
      };
      const followers = (await database.query(
        `SELECT ${ref}, CASE WHEN c.lineage->>'previousCardId' = $1 THEN 'next' ELSE 'research' END AS relation
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
         WHERE ${evidencePublicPredicate("pages")} AND c.id <> $1 AND (c.lineage->>'previousCardId' = $1 OR c.lineage->>'originCardId' = $1) AND c.withdrawn IS NULL
         ORDER BY c.updated_at DESC, c.id LIMIT 20`, [card.id])).rows;
      return {
        previous: await pointed(card.lineage?.previousCardId), origin: await pointed(card.lineage?.originCardId),
        next: followers.filter((row) => row.relation === "next").map(linkRef), research: followers.filter((row) => row.relation === "research").map(linkRef),
      };
    },

    /**
     * One page of a public zone's change log, newest first. A card's title is named only when that card is itself public: a log entry
     * outlives the card it is about, and the log must not be a way to read the title of one that was taken back to a draft.
     * @param {string} zoneId @param {{ limit?: unknown, before?: unknown }} [query]
     */
    async changeLog(zoneId, { limit = null, before = null } = {}) {
      const size = limit === null || limit === undefined || limit === "" ? 50 : Number(limit);
      const cursor = before === null || before === undefined || before === "" ? null : Number(before);
      if (!Number.isSafeInteger(size) || size < 1 || size > EVIDENCE_CHANGE_LOG_MAX_PAGE || (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1))) {
        throw new HttpError(400, "evidence_public_query_invalid", `limit is a whole number from 1 to ${EVIDENCE_CHANGE_LOG_MAX_PAGE}; before is an entry number.`);
      }
      const page = await readEvidenceChangeLog(database, { zoneId, limit: size, before: cursor });
      const ids = [...new Set(page.items.map((entry) => entry.cardId))];
      const titles = ids.length ? new Map((await database.query(
        `SELECT c.id, c.title FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
         WHERE c.id = ANY($1::text[]) AND ${evidencePublicPredicate("pages")}`, [ids])).rows.map((/** @type {any} */ row) => [String(row.id), String(row.title)])) : new Map();
      return {
        items: page.items.map((entry) => ({
          id: entry.id, zoneId: entry.zoneId, cardId: entry.cardId, cardTitle: titles.get(entry.cardId) ?? null, revisionBefore: entry.revisionBefore, revisionAfter: entry.revisionAfter,
          category: entry.category, categoryLabel: entry.categoryLabel, trigger: entry.trigger, triggerLabel: entry.triggerLabel, summary: entry.summary, occurredAt: entry.occurredAt,
        })),
        nextBefore: page.nextBefore,
      };
    },

    /**
     * Whether an author is no longer new: at least three published cards that each carry a ✓ claim. Taken at read time and cached by the
     * author's card revisions, so it lifts by itself the moment the third card is published. Asked by the author's handle, the only name
     * the pages hold; a handle nobody holds does not qualify.
     * @param {string} authorHandle
     */
    async authorQualifies(authorHandle) {
      await ready();
      counters.authorChecks += 1;
      const authorId = await accountIdOf(authorHandle);
      if (!authorId) return false;
      const cards = (await database.query(
        `SELECT c.id, c.revision, jsonb_array_length(c.claims) AS claim_count FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
         WHERE c.user_id = $1 AND c.state = 'published' AND z.state = 'published' AND c.withdrawn IS NULL AND jsonb_array_length(c.claims) > 0
         ORDER BY c.updated_at DESC, c.id LIMIT $2`, [authorId, QUALIFYING_WINDOW])).rows;
      const key = cards.map((card) => `${card.id}:${card.revision}`).join(",");
      const known = authorCache.get(authorId);
      if (known && known.key === key) return known.qualifies;
      const counts = await verificationOf(cards);
      const qualifying = cards.filter((card) => (counts.get(card.id)?.verified ?? 0) >= 1).length;
      const qualifies = qualifying >= EVIDENCE_PUBLIC_QUALIFYING_CARDS;
      authorCache.set(authorId, { qualifies, key });
      if (authorCache.size > AUTHOR_CACHE) authorCache.delete(/** @type {string} */ (authorCache.keys().next().value));
      return qualifies;
    },

    /**
     * An author's page: their public zones and cards, followers, the times other accounts' research started from their cards, and the
     * latest entries of the change log for their public zones. Null when the account has nothing public (the same answer as for no
     * account, so the page cannot be used to find out who has signed up). Asked by handle; an account id is not one.
     * @param {string} authorHandle
     */
    async author(authorHandle) {
      if (typeof authorHandle !== "string" || !EVIDENCE_PUBLIC_AUTHOR_HANDLE.test(authorHandle)) return null;
      await ready();
      const author = await accountOfHandle(database, authorHandle);
      if (!author) return null;
      const authorId = author.id;
      /** Every card on the page is this author's own. */
      const handles = new Map([[authorId, authorHandle]]);
      const zones = (await database.query(
        `SELECT z.id, z.title, z.description, z.kind, z.updated_at,
           (SELECT count(*)::integer FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published' AND c.withdrawn IS NULL) AS card_count,
           (SELECT count(*)::integer FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id) AS follows
         FROM evimed_frontier.evidence_zones z WHERE z.user_id = $1 AND ${evidencePublicPredicate("zones")} ORDER BY z.updated_at DESC, z.id LIMIT 50`, [authorId])).rows;
      if (!zones.length) return null;
      const cards = (await database.query(
        `SELECT ${CARD_LIST_COLUMNS} FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
         WHERE c.user_id = $1 AND z.user_id = $1 AND ${evidencePublicPredicate("pages")} ORDER BY c.updated_at DESC, c.id LIMIT 30`, [authorId])).rows;
      const verification = await verificationOf(cards.filter((row) => !row.withdrawn));
      const totals = (await database.query(
        `SELECT
           (SELECT count(DISTINCT f.user_id)::integer FROM evimed_frontier.evidence_zone_follows f JOIN evimed_frontier.evidence_zones z ON z.id = f.zone_id
             WHERE z.user_id = $1 AND ${evidencePublicPredicate("zones")}) AS followers,
           (SELECT count(*)::integer FROM evimed_frontier.evidence_card_runs r JOIN evimed_frontier.evidence_cards c ON c.id = r.card_id JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
             WHERE c.user_id = $1 AND z.user_id = $1 AND ${evidencePublicPredicate("pages")} AND r.user_id <> $1) AS runs_from_cards,
           (SELECT count(*)::integer FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
             WHERE c.user_id = $1 AND z.user_id = $1 AND ${evidencePublicPredicate("pages")} AND c.withdrawn IS NULL) AS cards`, [authorId])).rows[0];
      const changes = (await database.query(
        `SELECT l.id, l.zone_id, l.card_id, l.category, l.trigger, l.summary_zh, l.occurred_at, c.title AS card_title FROM evimed_frontier.evidence_change_log l
           LEFT JOIN evimed_frontier.evidence_cards c ON c.id = l.card_id WHERE l.zone_id = ANY($1::text[]) ORDER BY l.id DESC LIMIT 10`, [zones.map((zone) => zone.id)])).rows;
      // The people a producer's cards name, as they wrote them: a doctor's hospital and title, an enterprise's authors and reviewers.
      /** @type {Map<string, { name: string, affiliation: string | null, title: string | null }>} */
      const people = new Map();
      for (const row of cards) {
        for (const person of [...(row.disclosure?.authors ?? []), ...(row.disclosure?.reviewers ?? [])]) {
          if (person?.name && !people.has(person.name)) people.set(person.name, { name: String(person.name), affiliation: text(person.affiliation), title: text(person.title) });
        }
      }
      const producer = cards.find((row) => row.producer)?.producer ?? null;
      return {
        author: { id: authorHandle, name: author.name },
        producer: producerView(producer),
        people: [...people.values()].slice(0, 20),
        zones: zones.map((zone) => ({
          id: String(zone.id), title: String(zone.title), description: String(zone.description ?? ""), kind: String(zone.kind), kindLabel: labels(EVIDENCE_ZONE_KIND_LABELS_ZH, zone.kind),
          cards: zone.card_count, follows: zone.follows, updatedAt: iso(zone.updated_at),
        })),
        cards: cards.map((row) => cardSummary(row, verification.get(row.id) ?? ZERO_COUNTS, handles)),
        totals: { cards: totals.cards, followers: totals.followers, runsFromCards: totals.runs_from_cards },
        changes: changes.map((row) => ({ id: String(row.id), zoneId: row.zone_id, cardId: row.card_id, cardTitle: row.card_title ?? null, category: row.category, summary: row.summary_zh, occurredAt: iso(row.occurred_at) })),
        official: zones.some((zone) => zone.kind === "official"),
      };
    },

    /**
     * Every page a sitemap may list, with what decides whether it may be listed: the author by handle. The caller
     * (`evidencePublicIndexing`) applies the indexing rules.
     */
    async sitemapEntries() {
      await ready();
      const zones = (await database.query(
        `SELECT z.id, z.kind, z.user_id, z.updated_at FROM evimed_frontier.evidence_zones z WHERE ${evidencePublicPredicate("zones")}
           AND EXISTS (SELECT 1 FROM evimed_frontier.evidence_cards c WHERE c.zone_id = z.id AND c.state = 'published' AND c.withdrawn IS NULL)
         ORDER BY z.updated_at DESC, z.id LIMIT 1000`)).rows;
      const cards = (await database.query(
        `SELECT c.id, c.user_id, z.kind, c.updated_at FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id JOIN evimed_control.users u ON u.id = c.user_id
         WHERE ${evidencePublicPredicate("pages")} AND c.withdrawn IS NULL ORDER BY c.updated_at DESC, c.id LIMIT $1`, [EVIDENCE_PUBLIC_SITEMAP_CARDS])).rows;
      const handles = await handlesOf([...zones, ...cards]);
      return {
        zones: zones.map((row) => ({ id: String(row.id), kind: String(row.kind), authorHandle: handles.get(String(row.user_id)) ?? null, updatedAt: iso(row.updated_at) })),
        cards: cards.map((row) => ({ id: String(row.id), kind: String(row.kind), authorHandle: handles.get(String(row.user_id)) ?? null, updatedAt: iso(row.updated_at) })),
      };
    },

    stats: () => ({ ...counters, cachedVerifications: verificationCache.size, cachedAuthors: authorCache.size }),
    now,
  };
}

/**
 * The part of a card's lineage a reader sees: the cards it follows and began from, and the study it verified. The run, agenda and episode
 * the platform stamped on it are the platform's own bookkeeping.
 * @param {any} lineage
 */
function publicLineage(lineage) {
  if (!lineage || typeof lineage !== "object") return null;
  const out = {
    ...(typeof lineage.previousCardId === "string" ? { previousCardId: lineage.previousCardId } : {}),
    ...(typeof lineage.originCardId === "string" ? { originCardId: lineage.originCardId } : {}),
    ...(lineage.verifiedStudy && typeof lineage.verifiedStudy === "object" ? { verifiedStudy: lineage.verifiedStudy } : {}),
  };
  return Object.keys(out).length ? out : null;
}

/** A card another card points to, as a reader sees it. @param {any} row */
function linkRef(row) {
  return { id: String(row.id), zoneId: String(row.zone_id), title: String(row.title), producer: producerView(row.producer), creator: String(row.creator ?? ""), updatedAt: iso(row.updated_at) };
}
