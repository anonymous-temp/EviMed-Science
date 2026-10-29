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
//   Every entry carries the `lastmod` of the page (an author's page, and the index, the latest of what they list).
// - **"Indexable" is the absence of `noindex`**, in the markup and in the header, on the same verdict. No page says `index` aloud: there
//   is no second tag that could contradict the first, and a crawler's default is the answer the deployment wants.
// - **`/robots.txt` is the one thing the pages answer outside their base** (`evidenceRobotsTxt`): the application serves the whole host's
//   root, and without it the single-page fallback answered the crawler's first request with an HTML shell. It names the sitemap only while
//   indexing is on and the deployment has a public address (the sitemap's own conditions), keeps crawlers off the private surfaces
//   (`/app/`, `/api/`, `/internal/`, `/evolution/`) and off the pages' JSON API, and never disallows a page: a page that says `noindex` has
//   to be crawlable for the crawler to read it.

import { HttpError } from "./security.mjs";
import { evidencePublicPath } from "./evidencePublicPaths.mjs";

/** The static pages a sitemap lists besides zones, cards and authors, under the base the deployment serves the pages at. The index is the first of them. */
const sitePaths = () => ["/", "/about", "/metrics", "/simulations"].map((suffix) => evidencePublicPath(suffix));

/** The sitemaps.org limit on one document; a library that grows past it needs a sitemap index, and until then the newest pages are kept. */
export const EVIDENCE_SITEMAP_MAX_URLS = 50_000;

/** The later of two instants as ISO strings, either of which may be missing or unreadable. @param {string | null} left @param {string | null} right */
function later(left, right) {
  const time = (/** @type {string | null} */ value) => (value ? Date.parse(value) : Number.NaN);
  if (Number.isNaN(time(right))) return left;
  return Number.isNaN(time(left)) || time(right) > time(left) ? right : left;
}

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
    const pages = [];
    /** @type {Map<string, string | null>} an author's page changes when any zone or card of theirs does */
    const authors = new Map();
    /** @type {string | null} */
    let latest = null;
    const note = (/** @type {string | null} */ authorHandle, /** @type {string | null} */ updatedAt) => {
      latest = later(latest, updatedAt);
      if (authorHandle) authors.set(authorHandle, later(authors.get(authorHandle) ?? null, updatedAt));
    };
    for (const zone of zones) {
      if (!(await allowed(zone.kind, zone.authorHandle))) continue;
      pages.push({ path: evidencePublicPath(`/z/${encodeURIComponent(zone.id)}`), lastmod: zone.updatedAt });
      note(zone.authorHandle, zone.updatedAt);
    }
    for (const card of cards) {
      if (!(await allowed(card.kind, card.authorHandle))) continue;
      pages.push({ path: evidencePublicPath(`/c/${encodeURIComponent(card.id)}`), lastmod: card.updatedAt });
      note(card.authorHandle, card.updatedAt);
    }
    for (const [authorHandle, lastmod] of authors) pages.push({ path: evidencePublicPath(`/a/${encodeURIComponent(authorHandle)}`), lastmod });
    // The index changes whenever anything listed below it does; the other static pages have no date of their own to state.
    const site = sitePaths().map((path, position) => ({ path, lastmod: position === 0 ? latest : null }));
    const paths = [...site, ...pages].slice(0, EVIDENCE_SITEMAP_MAX_URLS);
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

/** The application's own surfaces no crawler has a reason to read: the signed-in app and its API, the gateways and the plugin manifests. */
const PRIVATE_SURFACES = Object.freeze(["/app/", "/api/", "/internal/", "/evolution/"]);

/**
 * The host's `/robots.txt`. The pages are crawlable whatever the deployment's indexing switch says, so a page that says `noindex` is read
 * as such; the sitemap is announced only when it exists (indexing on, a public address configured).
 * @param {{ indexable: boolean, publicUrl: unknown }} options
 */
export function evidenceRobotsTxt({ indexable, publicUrl }) {
  const sitemap = indexable ? evidenceAbsoluteUrl(publicUrl, evidencePublicPath("/sitemap.xml")) : null;
  return [
    "User-agent: *",
    ...(indexable ? [`Allow: ${evidencePublicPath("/")}`] : []),
    `Disallow: ${evidencePublicPath("/api/")}`,
    ...PRIVATE_SURFACES.map((path) => `Disallow: ${path}`),
    ...(sitemap ? ["", `Sitemap: ${sitemap}`] : []),
    "",
  ].join("\n");
}

/** A `lastmod` the document can state: a W3C datetime, or nothing for a value that is not a date. @param {string | null} value */
function lastmodText(value) {
  const time = value ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? `<lastmod>${xml(time.toISOString())}</lastmod>` : "";
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
    urls.push(`<url><loc>${xml(loc)}</loc>${lastmodText(entry.lastmod)}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
