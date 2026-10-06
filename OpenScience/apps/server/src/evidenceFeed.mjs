// The feed of what the platform's own evidence may offer the frontier (flywheel F09, plan §5.3, 2026-10-05).
//
// The frontier feed never reads a source itself: it takes what the knowledge-source plugin delivers, and the plugin
// reads a public URL like it reads every other publisher's. So platform content enters the frontier by the same door
// as a journal does — a feed the plugin polls, registered there as one more ordinary source — and cannot be favoured
// on the way in. This module builds that feed from the published cards, as JSON (the contract below) and as RSS 2.0.
//
// Hidden knowledge:
//
// - **What may enter.** (The rule is `evidencePublicPredicate("feed")`, which the public pages' own audience sits beside, so what is
//   public is defined once.) The cards of official zones, and the cards of user zones that are the researcher's original
//   research in a zone the researcher opened to the internet. Never a product zone's card (a company's or a doctor's
//   own evidence about its own product is not news the frontier carries, plan §5.6), never a user zone that is still
//   platform-only, and never a card that is not published in a published zone. Interpretations of other people's
//   studies (briefs, syntheses) come from official zones only: a researcher's reading of someone else's paper is not
//   the researcher's research.
// - **What a card says about the study it is about.** `about` carries the DOI, PMID and registry numbers of the work
//   a card verified or cites, so the plugin can hand registry numbers to the frontier's clustering and a reader's
//   event for that trial finds the card as one more report. The card's identity in the feed is its own address, never
//   those identifiers: an identifier is how the frontier knows a *work*, and a card is not the work it is about.
// - **Only a source's name and address leave.** Each source is its title and its address; a preserved text, an
//   excerpt or a source whose text is restricted never appears.
// - **One page is a function of the zones' content version.** The version moves on every zone or card write, so a
//   page built at one version is the page of that version: it is cached by it, and a reader (or the plugin) that
//   holds the version's ETag is answered 304 without a query beyond the version.
// - **The version of the contract is in the document.** `version` names the shape (`evimed-evidence-feed/1`); a
//   change of shape that is not additive is a new number, and the plugin refuses a number it does not know.
//
// Which model capability would make it deletable: none — it is a projection of rows the platform already holds.

import { createHash } from "node:crypto";
import { evidenceCardIdentifiers, evidenceOriginalityIsPrimary } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { evidencePublicPredicate } from "./evidencePublicQuery.mjs";

/** The shape of the JSON feed; a non-additive change is a new number. */
export const EVIDENCE_FEED_VERSION = "evimed-evidence-feed/1";
export const EVIDENCE_FEED_DEFAULT_LIMIT = 50;
export const EVIDENCE_FEED_MAX_LIMIT = 200;
/** Cached pages, at most: each is one query's worth of a few hundred cards' headers. */
const CACHE_PAGES = 32;
/** The words a summary is cut at: a feed item is a pointer, the card is the reading. */
const SUMMARY_CHARS = 600;
/** Sources named per item, and entity keys carried per item. */
const SOURCES_PER_ITEM = 12;
const KEYS_PER_ITEM = 40;

/** @param {unknown} value */
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** @param {unknown} value @returns {string | null} */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {string} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * The identifiers of the work a card is about, split by kind, from the keys `evidenceCardIdentifiers` reads off the
 * card's verified study and its sources' addresses.
 * @param {{ lineage?: any, sources?: any[] }} card
 * @returns {{ doi: string[], pmid: string[], registryIds: string[] }}
 */
export function evidenceFeedAbout(card) {
  const keys = evidenceCardIdentifiers(card);
  const after = (/** @type {string} */ prefix) => keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  return { doi: after("doi:"), pmid: after("pmid:"), registryIds: after("registry:").map((id) => id.toUpperCase()) };
}

/**
 * The address a card is read at: fixed, on the deployment's public URL (`/evidence/c/<id>`). With no public URL
 * configured it is the path alone — a feed nobody can reach has no use for an absolute address.
 * @param {string | null | undefined} publicUrl @param {string} cardId
 */
export function evidenceCardAddress(publicUrl, cardId) {
  const path = `/evidence/c/${encodeURIComponent(cardId)}`;
  try {
    const base = new URL(String(publicUrl ?? ""));
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) return path;
    return new URL(path, `${base.origin}/`).href;
  } catch {
    return path;
  }
}

/**
 * One card row as a feed item.
 * @param {any} row @param {string | null | undefined} publicUrl
 */
function feedItem(row, publicUrl) {
  const sources = (Array.isArray(row.sources_view) ? row.sources_view : []).map((source) => ({ title: text(source?.title), url: text(source?.url) }))
    .filter((source) => source.title && source.url && /^https?:\/\//i.test(source.url));
  const primary = evidenceOriginalityIsPrimary(row.originality);
  const summary = text(row.content?.answer) ?? text(row.summary) ?? "";
  return {
    id: String(row.id),
    url: evidenceCardAddress(publicUrl, String(row.id)),
    title: String(row.title),
    summary: summary.slice(0, SUMMARY_CHARS),
    zone: { id: String(row.zone_id), title: String(row.zone_title), kind: String(row.zone_kind) },
    producer: { kind: row.producer?.kind ?? null, name: text(row.producer?.name) },
    originality: row.originality ?? null,
    primary,
    publishedAt: iso(row.published_at ?? row.created_at),
    updatedAt: iso(row.updated_at),
    revision: Number(row.revision),
    about: evidenceFeedAbout({ lineage: row.lineage, sources: sources.map((source) => ({ url: source.url })) }),
    entityKeys: (Array.isArray(row.entity_keys) ? row.entity_keys : []).map(String).slice(0, KEYS_PER_ITEM),
    sources: sources.slice(0, SOURCES_PER_ITEM),
  };
}

/** @param {string} value */
const xml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[/** @type {"&"} */ (character)]);

/**
 * The feed as RSS 2.0: one item per card, its address as the permanent link, the zone as the category, the page of
 * the next cursor as an Atom link.
 * @param {{ generatedAt: string, items: any[], next: string | null }} page
 * @param {{ publicUrl?: string | null, selfPath: string }} options
 */
export function evidenceFeedRss(page, { publicUrl, selfPath }) {
  const absolute = (/** @type {string} */ path) => {
    try { return new URL(path, `${new URL(String(publicUrl)).origin}/`).href; } catch { return path; }
  };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>',
    "<title>EviMed 证据中心</title>",
    `<link>${xml(absolute("/evidence/"))}</link>`,
    "<description>EviMed 证据专区里平台的官方证据卡，和作者公开的原创研究。证据卡只是索引，请引用它列出的原始来源。</description>",
    "<language>zh-CN</language>",
    `<lastBuildDate>${new Date(page.generatedAt).toUTCString()}</lastBuildDate>`,
    `<atom:link rel="self" type="application/rss+xml" href="${xml(absolute(selfPath))}"/>`,
    ...(page.next ? [`<atom:link rel="next" type="application/rss+xml" href="${xml(absolute(`/evidence/feed.xml?cursor=${encodeURIComponent(page.next)}`))}"/>`] : []),
  ];
  for (const item of page.items) {
    lines.push("<item>",
      `<title>${xml(item.title)}</title>`,
      `<link>${xml(item.url)}</link>`,
      `<guid isPermaLink="true">${xml(item.url)}</guid>`,
      ...(item.publishedAt ? [`<pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>`] : []),
      `<description>${xml(item.summary)}</description>`,
      `<category>${xml(item.zone.title)}</category>`,
      "</item>");
  }
  lines.push("</channel></rss>");
  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ database: any, config?: Record<string, any>, now?: () => Date }} options
 */
export function createEvidenceFeed({ database, config = {}, now = () => new Date() }) {
  /** @type {Map<string, { page: any }>} */
  const cache = new Map();
  const counters = { requests: 0, notModified: 0, cacheHits: 0, items: 0, failures: 0 };

  /** @param {string | null} cursor */
  function decodeCursor(cursor) {
    if (!cursor) return null;
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof value?.u !== "string" || !Number.isFinite(Date.parse(value.u)) || typeof value?.i !== "string" || !value.i || value.i.length > 100) throw new Error();
      return { updatedKey: value.u, id: value.i };
    } catch {
      throw new HttpError(400, "evidence_feed_cursor_invalid", "The feed cursor is not valid; read from the first page.");
    }
  }

  return {
    /** The zones' content version: every zone and card write moves it. */
    async version() {
      await migrateEvidenceZones(database);
      return String((await database.query("SELECT version FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0]?.version ?? "0");
    },

    /**
     * One page of the feed and the tag that names it.
     * @param {{ cursor?: string | null, limit?: number | null }} [query]
     * @returns {Promise<{ etag: string, version: string, page: { version: string, generatedAt: string, items: any[], next: string | null } }>}
     */
    async page({ cursor = null, limit = null } = {}) {
      const size = limit == null ? EVIDENCE_FEED_DEFAULT_LIMIT : Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > EVIDENCE_FEED_MAX_LIMIT) {
        throw new HttpError(400, "evidence_feed_query_invalid", `limit must be an integer from 1 to ${EVIDENCE_FEED_MAX_LIMIT}.`);
      }
      const after = decodeCursor(cursor);
      const version = await this.version();
      const key = `${version}\u0000${cursor ?? ""}\u0000${size}`;
      const etag = `W/"${sha(`${EVIDENCE_FEED_VERSION}\u0000${key}`).slice(0, 32)}"`;
      const cached = cache.get(key);
      if (cached) { counters.cacheHits += 1; return { etag, version, page: cached.page }; }
      try {
        const rows = (await database.query(`SELECT c.id, c.zone_id, c.title, c.summary, c.revision, c.created_at, c.updated_at, c.content, c.producer,
            c.originality, c.lineage, c.entity_keys, z.title AS zone_title, z.kind AS zone_kind,
            (SELECT coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'url', s->>'url')), '[]'::jsonb) FROM jsonb_array_elements(c.sources) s) AS sources_view,
            (SELECT least(min(r.recorded_at), c.updated_at) FROM evimed_frontier.evidence_card_revisions r WHERE r.card_id = c.id AND r.snapshot->>'state' = 'published') AS published_at,
            to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_key
          FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
          WHERE ${evidencePublicPredicate("feed")}
            AND ($1::timestamptz IS NULL OR (c.updated_at, c.id) < ($1::timestamptz, $2::text))
          ORDER BY c.updated_at DESC, c.id DESC LIMIT $3`, [after?.updatedKey ?? null, after?.id ?? null, size + 1])).rows ?? [];
        const kept = rows.slice(0, size);
        const last = kept.at(-1);
        const page = {
          version: EVIDENCE_FEED_VERSION,
          generatedAt: now().toISOString(),
          items: kept.map((row) => feedItem(row, config.publicUrl)),
          next: rows.length > size && last ? Buffer.from(JSON.stringify({ u: last.updated_key, i: last.id })).toString("base64url") : null,
        };
        if (cache.size >= CACHE_PAGES) cache.delete(/** @type {string} */ (cache.keys().next().value));
        cache.set(key, { page });
        counters.items += page.items.length;
        return { etag, version, page };
      } catch (error) {
        counters.failures += 1;
        throw error;
      }
    },
    /** The counters and the cache's size, for the operator's metrics. */
    stats: () => ({ ...counters, cachedPages: cache.size }),
    /** @param {"requests" | "notModified"} name */
    count(name) { counters[name] += 1; },
  };
}

/**
 * The operator's counters for the feed.
 * @param {{ requests: number, notModified: number, cacheHits: number, items: number, failures: number, cachedPages: number } | null} stats
 */
export function evidenceFeedMetricFamilies(stats) {
  if (!stats) return [];
  return [
    { name: "open_science_evidence_feed_requests_total", help: "Requests the public evidence feed answered (JSON and RSS), and those it answered 304.", type: /** @type {const} */ ("counter"),
      series: [{ labels: { outcome: "served" }, value: stats.requests - stats.notModified }, { labels: { outcome: "not_modified" }, value: stats.notModified }] },
    { name: "open_science_evidence_feed_items_total", help: "Feed items built from the cards (a cached page is not built again).", type: /** @type {const} */ ("counter"), series: [{ value: stats.items }] },
    { name: "open_science_evidence_feed_cache_hits_total", help: "Feed pages answered from the cache of the zones' content version.", type: /** @type {const} */ ("counter"), series: [{ value: stats.cacheHits }] },
    { name: "open_science_evidence_feed_failures_total", help: "Feed pages that could not be built.", type: /** @type {const} */ ("counter"), series: [{ value: stats.failures }] },
  ];
}
