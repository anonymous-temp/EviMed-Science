// Which public evidence pages a search engine may index, and the sitemap that lists them (flywheel F08, plan §5.2 and §12, 2026-10-06).
//
// Hidden knowledge:
//
// - **Two separate gates.** `OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE` is the deployment's: while it is off (no domain has been chosen,
//   so a page reachable by an address must not become a search result by accident) every page says `noindex` in its markup and in the
//   `X-Robots-Tag` header and there is no sitemap. When it is on, a page is indexable unless one of two rules holds:
//   (a) its author is new — fewer than three published cards that each carry a ✓ claim — in which case the page opens normally but is
//   `noindex` and absent from the sitemap, and the rule lifts by itself the moment the third card counts (`authorQualifies` is a count
//   at read time). Official zones are exempt: the platform is not a new author. This stops borrowing the platform's domain to place
//   pages without stopping anyone from publishing; (b) the card is withdrawn — its page stays, explaining why, and is never indexed.
// - **User-written lists stay out of the index.** The topic requests page is made of titles any signed-in account typed; it is
//   `noindex` always, for the reason (a) exists.
// - **A sitemap lists what the same rules call indexable, and nothing else.** With the deployment's switch off the sitemap is a 404.

import { HttpError } from "./security.mjs";

/** The static pages a sitemap lists besides zones, cards and authors. */
const SITE_PATHS = ["/evidence/", "/evidence/about", "/evidence/metrics", "/evidence/simulations"];

/**
 * @param {{ config: Record<string, any>, reads: { authorQualifies: (authorId: string) => Promise<boolean> } }} options
 */
export function createEvidencePublicIndexing({ config, reads }) {
  const counters = { noindexSwitchOff: 0, noindexNewAuthor: 0, noindexWithdrawn: 0, noindexAlways: 0, indexable: 0, sitemapRequests: 0, sitemapUrls: 0 };

  /**
   * Whether a page may be indexed, and why not.
   * @param {{ kind: "site" | "never" } | { kind: "zone", zoneKind: string, ownerId: string } | { kind: "card", zoneKind: string, authorId: string, withdrawn: boolean } | { kind: "author", official: boolean, authorId: string }} page
   * @returns {Promise<{ index: boolean, reason: "switch_off" | "new_author" | "withdrawn" | "never" | null }>}
   */
  async function decide(page) {
    if (page.kind === "never") { counters.noindexAlways += 1; return { index: false, reason: "never" }; }
    if (page.kind === "card" && page.withdrawn) { counters.noindexWithdrawn += 1; return { index: false, reason: "withdrawn" }; }
    if (config.evidencePublicIndexable !== true) { counters.noindexSwitchOff += 1; return { index: false, reason: "switch_off" }; }
    if (page.kind === "site") { counters.indexable += 1; return { index: true, reason: null }; }
    const official = page.kind === "author" ? page.official : page.zoneKind === "official";
    const authorId = page.kind === "zone" ? page.ownerId : page.authorId;
    if (!official && !(await reads.authorQualifies(authorId))) { counters.noindexNewAuthor += 1; return { index: false, reason: "new_author" }; }
    counters.indexable += 1;
    return { index: true, reason: null };
  }

  /**
   * The sitemap's entries: every page `decide` calls indexable. Authors are asked about once each.
   * @param {{ zones: { id: string, kind: string, authorId: string, updatedAt: string | null }[], cards: { id: string, kind: string, authorId: string, updatedAt: string | null }[] }} entries
   */
  async function sitemapPaths({ zones, cards }) {
    /** @type {Map<string, boolean>} */
    const verdicts = new Map();
    const allowed = async (/** @type {string} */ kind, /** @type {string} */ authorId) => {
      if (kind === "official") return true;
      if (!verdicts.has(authorId)) verdicts.set(authorId, await reads.authorQualifies(authorId));
      return /** @type {boolean} */ (verdicts.get(authorId));
    };
    /** @type {{ path: string, lastmod: string | null }[]} */
    const paths = SITE_PATHS.map((path) => ({ path, lastmod: null }));
    const authors = new Map();
    for (const zone of zones) {
      if (!(await allowed(zone.kind, zone.authorId))) continue;
      paths.push({ path: `/evidence/z/${encodeURIComponent(zone.id)}`, lastmod: zone.updatedAt });
      authors.set(zone.authorId, zone.updatedAt);
    }
    for (const card of cards) {
      if (!(await allowed(card.kind, card.authorId))) continue;
      paths.push({ path: `/evidence/c/${encodeURIComponent(card.id)}`, lastmod: card.updatedAt });
    }
    for (const [authorId, lastmod] of authors) paths.push({ path: `/evidence/a/${encodeURIComponent(authorId)}`, lastmod });
    counters.sitemapUrls += paths.length;
    return paths;
  }

  return { decide, sitemapPaths, stats: () => ({ ...counters }), count: (/** @type {"sitemapRequests"} */ name) => { counters[name] += 1; } };
}

/** @param {string} value */
const xml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[/** @type {"&"} */ (character)]);

/**
 * The absolute address of a path on the deployment's public URL, or null when none is configured (a sitemap needs absolute locations).
 * @param {unknown} publicUrl @param {string} path
 */
export function evidenceAbsoluteUrl(publicUrl, path) {
  try {
    const base = new URL(String(publicUrl ?? ""));
    if (!/^https?:$/.test(base.protocol) || base.username || base.password) return null;
    return new URL(path, `${base.origin}/`).href;
  } catch {
    return null;
  }
}

/**
 * The sitemap document (sitemaps.org 0.9).
 * @param {{ path: string, lastmod: string | null }[]} paths @param {unknown} publicUrl
 */
export function evidenceSitemapXml(paths, publicUrl) {
  const urls = [];
  for (const entry of paths) {
    const loc = evidenceAbsoluteUrl(publicUrl, entry.path);
    if (!loc) throw new HttpError(404, "evidence_public_not_found", "The sitemap needs the deployment's public address (OPEN_SCIENCE_PUBLIC_URL).");
    urls.push(`<url><loc>${xml(loc)}</loc>${entry.lastmod ? `<lastmod>${xml(new Date(entry.lastmod).toISOString())}</lastmod>` : ""}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
