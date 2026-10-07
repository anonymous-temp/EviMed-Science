// Which public evidence pages a search engine may index, and the sitemap that lists them (flywheel F08, plan §5.2 and §12, 2026-10-06).
//
// Hidden knowledge:
//
// - **Two separate gates.** `OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE` is the deployment's: while it is off (no domain has been chosen,
//   so a page reachable by an address must not become a search result by accident) every page says `noindex` in its markup and in the
//   `X-Robots-Tag` header and there is no sitemap. When it is on, a page is indexable unless one of two rules holds:
//   (a) its author is new — fewer than three published cards that each carry a ✓ claim — in which case the page opens normally but is
//   `noindex` and absent from the sitemap, and the rule lifts by itself the moment the third card counts (`authorQualifies` is a count
//   at read time; it is asked by the author's public handle, the only name of an author this module holds). Official zones are exempt: the platform is not a new author. This stops borrowing the platform's domain to place
//   pages without stopping anyone from publishing; (b) the card is withdrawn — its page stays, explaining why, and is never indexed.
// - **User-written lists stay out of the index.** The topic requests page is made of titles any signed-in account typed; it is
//   `noindex` always, for the reason (a) exists.
// - **A sitemap lists what the same rules call indexable, and nothing else.** With the deployment's switch off the sitemap is a 404.

import { HttpError } from "./security.mjs";
import { evidencePublicPath } from "./evidencePublicPaths.mjs";

/** The static pages a sitemap lists besides zones, cards and authors, under the base the deployment serves the pages at. */
const sitePaths = () => ["/", "/about", "/metrics", "/simulations"].map((suffix) => evidencePublicPath(suffix));

/**
 * @param {{ config: Record<string, any>, reads: { authorQualifies: (authorHandle: string | null) => Promise<boolean> } }} options
 */
export function createEvidencePublicIndexing({ config, reads }) {
  const counters = { noindexSwitchOff: 0, noindexNewAuthor: 0, noindexWithdrawn: 0, noindexAlways: 0, indexable: 0, sitemapRequests: 0, sitemapUrls: 0 };

  /**
   * Whether a page may be indexed, and why not.
   * @param {{ kind: "site" } | { kind: "never" } | { kind: "zone", zoneKind: string, ownerHandle: string | null } | { kind: "card", zoneKind: string, authorHandle: string | null, withdrawn: boolean } | { kind: "author", official: boolean, authorHandle: string }} page
   * @returns {Promise<{ index: boolean, reason: "switch_off" | "new_author" | "withdrawn" | "never" | null }>}
   */
  async function decide(page) {
    if (page.kind === "never") { counters.noindexAlways += 1; return { index: false, reason: "never" }; }
    if (page.kind === "card" && page.withdrawn) { counters.noindexWithdrawn += 1; return { index: false, reason: "withdrawn" }; }
    if (config.evidencePublicIndexable !== true) { counters.noindexSwitchOff += 1; return { index: false, reason: "switch_off" }; }
    if (page.kind === "site") { counters.indexable += 1; return { index: true, reason: null }; }
    const { official, authorHandle } = page.kind === "author" ? { official: page.official, authorHandle: page.authorHandle }
      : page.kind === "zone" ? { official: page.zoneKind === "official", authorHandle: page.ownerHandle }
        : { official: page.zoneKind === "official", authorHandle: page.authorHandle };
    if (!official && !(await reads.authorQualifies(authorHandle))) { counters.noindexNewAuthor += 1; return { index: false, reason: "new_author" }; }
    counters.indexable += 1;
    return { index: true, reason: null };
  }

  /**
   * The sitemap's entries: every page `decide` calls indexable. Authors are asked about once each.
   * @param {{ zones: { id: string, kind: string, authorHandle: string | null, updatedAt: string | null }[], cards: { id: string, kind: string, authorHandle: string | null, updatedAt: string | null }[] }} entries
   */
  async function sitemapPaths({ zones, cards }) {
    /** @type {Map<string, boolean>} */
    const verdicts = new Map();
    const allowed = async (/** @type {string} */ kind, /** @type {string | null} */ authorHandle) => {
      if (kind === "official") return true;
      if (!authorHandle) return false;
      if (!verdicts.has(authorHandle)) verdicts.set(authorHandle, await reads.authorQualifies(authorHandle));
      return /** @type {boolean} */ (verdicts.get(authorHandle));
    };
    /** @type {{ path: string, lastmod: string | null }[]} */
    const paths = sitePaths().map((path) => ({ path, lastmod: null }));
    const authors = new Map();
    for (const zone of zones) {
      if (!(await allowed(zone.kind, zone.authorHandle))) continue;
      paths.push({ path: evidencePublicPath(`/z/${encodeURIComponent(zone.id)}`), lastmod: zone.updatedAt });
      if (zone.authorHandle) authors.set(zone.authorHandle, zone.updatedAt);
    }
    for (const card of cards) {
      if (!(await allowed(card.kind, card.authorHandle))) continue;
      paths.push({ path: evidencePublicPath(`/c/${encodeURIComponent(card.id)}`), lastmod: card.updatedAt });
    }
    for (const [authorHandle, lastmod] of authors) paths.push({ path: evidencePublicPath(`/a/${encodeURIComponent(authorHandle)}`), lastmod });
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
