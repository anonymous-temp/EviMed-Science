// `GET /evidence/feed.json` and `GET /evidence/feed.xml` (flywheel F09): the public feed the knowledge-source plugin
// reads, and anyone else may. Unauthenticated by design — what is in it is what the platform has published to be
// read — and only while the public evidence pages are switched on (`OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED`);
// switched off, the two paths answer 404 `evidence_public_not_enabled` by name and read nothing.
//
// Everything else under `/evidence/` belongs to the pages (`evidencePublicRoutes.mjs`); this answers only these two
// paths and says it did not handle any other, so the two modules never need to know of each other. Under the base the
// deployment serves the pages at (`evidencePublicPaths.mjs`: `/evidence`, or `/evimed-evidence` where another product holds
// `/evidence/`); the other base's feed path is not answered.

import { EVIDENCE_FEED_VERSION, evidenceFeedRss } from "./evidenceFeed.mjs";
import { evidencePublicPath } from "./evidencePublicPaths.mjs";
import { HttpError } from "./security.mjs";

export const evidenceFeedJsonPath = () => evidencePublicPath("/feed.json");
export const evidenceFeedRssPath = () => evidencePublicPath("/feed.xml");
/** How long a reader may keep a page without asking again: the version's ETag answers the rest. */
const MAX_AGE_SECONDS = 60;

/** Whether an If-None-Match names this tag. @param {unknown} header @param {string} etag */
function matches(header, etag) {
  const tags = String(header ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
  return tags.includes("*") || tags.includes(etag.replace(/^W\//, ""));
}

/**
 * @param {{ config: Record<string, any>, feed: ReturnType<typeof import("./evidenceFeed.mjs").createEvidenceFeed> | null }} options
 *   `feed` is null where there is no database to read cards from.
 */
export function createEvidenceFeedRoutes({ config, feed }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== evidenceFeedJsonPath() && url.pathname !== evidenceFeedRssPath()) return false;
    if (config.evidencePublicWebEnabled !== true) throw new HttpError(404, "evidence_public_not_enabled", "The public evidence pages are not enabled.");
    if (!feed) throw new HttpError(404, "evidence_public_not_enabled", "The public evidence pages are not available in this deployment.");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "The evidence feed is read-only.", code: "method_not_allowed" }));
      return true;
    }
    feed.count("requests");
    const limit = url.searchParams.get("limit");
    const { etag, page } = await feed.page({ cursor: url.searchParams.get("cursor"), limit: limit == null || limit === "" ? null : Number(limit) });
    const rss = url.pathname === evidenceFeedRssPath();
    const headers = { ETag: etag, "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}`, Vary: "Accept-Encoding" };
    if (matches(req.headers["if-none-match"], etag)) {
      feed.count("notModified");
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const body = Buffer.from(rss
      ? evidenceFeedRss(page, { publicUrl: config.publicUrl, selfPath: `${url.pathname}${url.search}` })
      : JSON.stringify({ version: EVIDENCE_FEED_VERSION, generatedAt: page.generatedAt, items: page.items, next: page.next }), "utf8");
    res.writeHead(200, { ...headers, "Content-Type": rss ? "application/rss+xml; charset=utf-8" : "application/json; charset=utf-8", "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
