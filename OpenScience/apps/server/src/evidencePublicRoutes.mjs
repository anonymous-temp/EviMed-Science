// `/evidence/…`: the public evidence pages and their read-only API (flywheel F08, F27, 2026-10-06). One router, registered by one line in
// `createWebApiApp` after the feed's, answering to nobody's session: what it serves is what the platform and its authors published to be
// read by anyone. `/evidence` is the default base; a deployment whose own `/evidence/` belongs to another product serves everything under
// `/evimed-evidence` instead (`OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH`, `evidencePublicPaths.mjs`) and answers nothing under the other.
//
//   /evidence/                        the index          /evidence/about            《编辑说明》
//   /evidence/z/<zone>                a zone             /evidence/metrics          the monthly figures
//   /evidence/z/<zone>/changes        its change log     /evidence/simulations[/id] 「模拟研究」
//   /evidence/z/s/<slug>              a topic zone, by   /evidence/z/<zone>/feed.xml   a topic zone's feed (also under /z/s/<slug>)
//                                     its readable name
//   /evidence/c/<card>?view=          a card
//   /evidence/a/<handle>              an author (`au_…`) /evidence/sitemap.xml      only while indexing is on
//   /evidence/api/v1/…                the JSON API       /evidence/assets/site.css  the stylesheet
//   /robots.txt                       the host's root, the one path answered outside the base (see below)
//
// Hidden knowledge:
//
// - **Off is nothing.** With `OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED` off (or no database) the router returns `false` before it does
//   anything, so every `/evidence/…` path is answered by whatever answers an unknown path — the single-page app's fallback today —
//   and no table is read, no timer started, no counter moved. (The feed's two paths are the feed's, answered by `evidenceFeedRoutes.mjs`,
//   which is registered first and names its own refusal.)
// - **`/robots.txt` is answered here, outside the base, while the pages are on.** The application is the host's catch-all, and its
//   single-page fallback used to hand a crawler's first request an HTML shell. The text is made by `evidenceRobotsTxt` (indexing,
//   the sitemap's address); it needs no database, is not limited per address, and is counted as its own kind of request.
// - **A topic zone is its own kind of page** (plan 2026-10-29 §4.7): the platform's (`official`) topic zones, open to the internet, read at
//   `/z/<id>` and `/z/s/<slug>` (the alias, whose canonical address is the id's) with a feed at `/feed.xml`; a reader's topic zone is
//   never found, and a zone of cards (`lifecycle = 'none'`) keeps the page it had.
// - **Not found is one answer.** A page or API id that is missing, is a draft, sits in a zone that is platform-visible, or belongs to an
//   account that is gone gets the same 404 body and the same headers, so the answer cannot be used to find out what exists.
// - **A withdrawn card keeps its page**: 410, the reason and the date, `noindex`. It is not counted as a read.
// - **Pages carry no script, no cookie and no inline style.** The Content-Security-Policy admits the stylesheet by path and nothing else,
//   so a hole in escaping could still not run code; `nosniff` and a strict referrer policy go with it.
// - **An address is limited, not a reader.** `limiter` (the server's own fixed-window limiter, keyed by client address with
//   `OPEN_SCIENCE_EVIDENCE_PUBLIC_RATE_PER_MINUTE`) answers 429 with Retry-After; the pages are outside `/api/`, so the API's limiter
//   never saw them. Every answer, limited or not, is counted.

import { createHash } from "node:crypto";
import { EVIDENCE_PLATFORM_PRODUCER_NAME } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { createEvidencePublicReads, EVIDENCE_PUBLIC_AUTHOR_HANDLE } from "./evidencePublicQuery.mjs";
import { createEvidencePublicIndexing, evidenceRobotsTxt, evidenceSitemapXml } from "./evidencePublicIndexing.mjs";
import { createEvidencePublicMetrics } from "./evidencePublicMetrics.mjs";
import { createEvidencePublicApi, evidencePublicApiPrefix } from "./evidencePublicApi.mjs";
import { evidencePublicDay, evidencePublicIsBot, recordPageRead } from "./evidencePublicReads.mjs";
import { EVIDENCE_SITE_NAME, aigcMetadata, authorPath, cardPath, changesPath, renderPage, zonePath } from "./evidencePublicLayout.mjs";
import { evidencePublicBase, evidencePublicPath, evidencePublicSuffix } from "./evidencePublicPaths.mjs";
import { evidencePublicStylesheet, evidencePublicStylesheetPath } from "./evidencePublicStyle.mjs";
import { createEvidencePublicTopicReads, EVIDENCE_PUBLIC_TOPIC_LIMITS } from "./evidencePublicTopicReads.mjs";
import { topicZoneFeedPath, topicZonePage, topicZonePath, topicZoneRss, topicZoneSlugPath } from "./evidencePublicTopicPages.mjs";
import {
  aboutPage, authorPage, cardPage, changesPage, indexPage, metricsPage, notFoundPage, rateLimitedPage, simulationPage, simulationsPage, withdrawnCardPage, zonePage,
} from "./evidencePublicPages.mjs";

/** The feed's two documents, below the base: the feed's own router answers them (`evidenceFeedRoutes.mjs`). */
const FEED_SUFFIXES = new Set(["/feed.json", "/feed.xml"]);
const SIMULATION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_AGE_SECONDS = 300;

/** What every response from here carries. The policy admits only this origin's stylesheet: no script, no frame, no form, no connection. */
export const EVIDENCE_PUBLIC_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

/** @param {string} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Whether an If-None-Match names this tag. @param {unknown} header @param {string} etag */
function matches(header, etag) {
  const tags = String(header ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
  return tags.includes("*") || tags.includes(etag.replace(/^W\//, ""));
}

/**
 * @typedef {{ list: (query: { limit: number, before: string | null }) => Promise<{ items: any[], next?: string | null }>, get: (id: string) => Promise<any | null> }} SimulationReader
 */

/**
 * @param {{
 *   config: Record<string, any>,
 *   database: any,
 *   simulations?: SimulationReader | null,
 *   limiter?: ((req: any) => void) | null,
 *   now?: () => Date,
 *   metrics?: ReturnType<typeof createEvidencePublicMetrics>,
 *   questionBank?: ((query: { month: string }) => Promise<any>) | null,
 *   predictionCalibration?: (() => Promise<any>) | null,
 *   receiptsFor?: ((card: any) => Promise<Map<string, any>>) | null,
 *   report?: (code: string) => void,
 * }} options
 *   `simulations` is the 「模拟研究」 column's reader (another package publishes into it); absent, the column says it is empty.
 *   `limiter` throws a 429 `HttpError` when an address is over its minute; absent, none. `metrics` is for a test's figures. `questionBank` and
 *   `predictionCalibration` are the readers of the monthly page's two optional sections (the question bank's month, the prediction registry's
 *   calibration), composed only where those modules are; absent, the section is not rendered.
 */
export function createEvidencePublicRoutes({ config, database, simulations = null, limiter = null, now = () => new Date(), metrics, questionBank = null, predictionCalibration = null, receiptsFor = null, report = () => {} }) {
  const enabled = config.evidencePublicWebEnabled === true && Boolean(database);
  const counters = {
    pages: 0, api: 0, assets: 0, sitemap: 0, robots: 0, feeds: 0, notFound: 0, withdrawn: 0, rateLimited: 0, notModified: 0, errors: 0,
    readsCounted: 0, readsSkippedBot: 0, readsFailed: 0,
  };
  const reads = enabled ? createEvidencePublicReads({ database, now, receiptsFor }) : null;
  const topics = enabled ? createEvidencePublicTopicReads({ database, now }) : null;
  const indexing = reads ? createEvidencePublicIndexing({ config, reads }) : null;
  const figures = enabled ? (metrics ?? createEvidencePublicMetrics({ database, now, questionBank, predictionCalibration, report })) : null;
  const api = reads && figures ? createEvidencePublicApi({ reads, metrics: figures, config }) : null;

  /** @param {any} res @param {number} status @param {Record<string, string>} headers @param {string | Buffer} body @param {boolean} head */
  function send(res, status, headers, body, head) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(status, { ...EVIDENCE_PUBLIC_SECURITY_HEADERS, ...headers, "Content-Length": String(bytes.length) });
    res.end(head ? undefined : bytes);
  }

  /**
   * A page.
   * @param {any} res @param {boolean} head @param {number} status
   * @param {{ title: string, description: string, body: any }} page
   * @param {{ path: string, noindex: boolean, active?: string, wide?: boolean, aigc?: string | null, alternates?: boolean, ogType?: "website" | "article",
   *   canonicalPath?: string | null, feed?: { title: string, href: string } | null }} frame
   */
  function sendPage(res, head, status, page, frame) {
    counters.pages += 1;
    const body = renderPage({ ...page, ...frame, wide: frame.wide ?? true, publicUrl: config.publicUrl });
    send(res, status, {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
      ...(frame.noindex ? { "X-Robots-Tag": "noindex" } : {}),
    }, body, head);
  }

  /** The noindex verdict of a page: whether to say `noindex`. @param {Parameters<NonNullable<typeof indexing>["decide"]>[0]} page */
  async function noindexFor(page) {
    return !(await /** @type {NonNullable<typeof indexing>} */ (indexing).decide(page)).index;
  }

  /** The 404 every missing, hidden or malformed public page gets. @param {any} res @param {boolean} head @param {number} [status] */
  function sendNotFound(res, head, status = 404) {
    counters.notFound += 1;
    sendPage(res, head, status, notFoundPage(), { path: evidencePublicPath("/"), noindex: true });
  }

  /** @param {any} req @param {any} res @param {URL} url @param {string[]} parts @param {boolean} head */
  async function servePage(req, res, url, parts, head) {
    const [section, id, sub] = parts;
    const r = /** @type {NonNullable<typeof reads>} */ (reads);
    if (section === "" && parts.length === 1) {
      const sections = await r.indexZones();
      return sendPage(res, head, 200, indexPage({ ...sections, topics: await /** @type {NonNullable<typeof topics>} */ (topics).index() }), { path: evidencePublicPath("/"), noindex: await noindexFor({ kind: "site" }), active: "zones", alternates: true });
    }
    if (section === "about" && parts.length === 1) {
      return sendPage(res, head, 200, aboutPage(), { path: evidencePublicPath("/about"), noindex: await noindexFor({ kind: "site" }), active: "about", wide: false });
    }
    if (section === "metrics" && parts.length === 1) {
      const months = await /** @type {NonNullable<typeof figures>} */ (figures).months();
      const questionBankMonth = await figures?.questionBank?.() ?? null;
      const calibration = await figures?.predictionCalibration?.() ?? null;
      return sendPage(res, head, 200, metricsPage({ months, questionBank: questionBankMonth, calibration }), { path: evidencePublicPath("/metrics"), noindex: await noindexFor({ kind: "site" }), active: "metrics" });
    }
    if (section === "simulations" && parts.length <= 2) {
      if (parts.length === 1) {
        const page = simulations ? await simulations.list({ limit: 20, before: url.searchParams.get("cursor") }) : { items: [], next: null };
        return sendPage(res, head, 200, simulationsPage({ reader: Boolean(simulations), items: page.items, next: page.next ?? null }), {
          path: evidencePublicPath("/simulations"), noindex: await noindexFor({ kind: "site" }), active: "simulations",
        });
      }
      const record = simulations && SIMULATION_ID.test(id) ? await simulations.get(id) : null;
      if (!record) return sendNotFound(res, head);
      return sendPage(res, head, 200, simulationPage(record), { path: evidencePublicPath(`/simulations/${encodeURIComponent(id)}`), noindex: await noindexFor({ kind: "site" }), active: "simulations", wide: false });
    }
    if (section === "z" && id === "s" && (parts.length === 3 || (parts.length === 4 && parts[3] === "feed.xml"))) {
      return serveTopic(req, res, head, parts[2], parts.length === 4 ? "feed" : "page");
    }
    if (section === "z" && id && id !== "s" && (parts.length === 2 || (parts.length === 3 && sub === "feed.xml"))) {
      const served = await serveTopic(req, res, head, id, parts.length === 3 ? "feed" : "page", { quiet: true });
      if (served) return;
    }
    if (section === "z" && id && (parts.length === 2 || (parts.length === 3 && sub === "changes"))) {
      const zone = await r.zone(id);
      if (!zone) return sendNotFound(res, head);
      const noindex = await noindexFor({ kind: "zone", zoneKind: zone.kind, ownerHandle: zone.owner.id });
      if (parts.length === 3) {
        const page = await r.changeLog(id, { limit: null, before: url.searchParams.get("before") });
        return sendPage(res, head, 200, changesPage({ zone, items: page.items, nextBefore: page.nextBefore }), { path: changesPath(id), noindex, active: "zones" });
      }
      const cards = await r.zoneCards(id, { limit: null, cursor: url.searchParams.get("cursor") });
      await countRead(req, head, { zoneId: id });
      return sendPage(res, head, 200, zonePage({ zone, cards }), { path: zonePath(id), noindex, active: "zones" });
    }
    if (section === "c" && id && parts.length === 2) {
      const view = url.searchParams.get("view") ?? "clinical";
      if (view !== "clinical" && view !== "public") return sendNotFound(res, head, 400);
      const card = await r.card(id, view);
      if (!card) return sendNotFound(res, head);
      if (card.withdrawn) {
        counters.withdrawn += 1;
        return sendPage(res, head, 410, withdrawnCardPage({ card }), { path: cardPath(id), noindex: await noindexFor({ kind: "card", zoneKind: card.zone.kind, authorHandle: card.creator.id, withdrawn: true }), wide: false, active: "zones" });
      }
      const noindex = await noindexFor({ kind: "card", zoneKind: card.zone.kind, authorHandle: card.creator.id, withdrawn: false });
      const links = await r.cardLinks(card);
      await countRead(req, head, { zoneId: card.zone.id, cardId: card.id });
      const version = `${card.id}@${card.revision}`;
      return sendPage(res, head, 200, cardPage({ card, links, view }), {
        path: cardPath(id), noindex, wide: false, active: "zones", ogType: "article",
        aigc: card.aiGenerated ? aigcMetadata({ producerName: EVIDENCE_PLATFORM_PRODUCER_NAME, produceId: version, propagateId: version }) : null,
      });
    }
    if (section === "a" && id && parts.length === 2) {
      const author = EVIDENCE_PUBLIC_AUTHOR_HANDLE.test(id) ? await r.author(id) : null;
      if (!author) return sendNotFound(res, head);
      return sendPage(res, head, 200, authorPage(author), {
        path: authorPath(id), noindex: await noindexFor({ kind: "author", official: author.official, authorHandle: id }), active: "zones",
      });
    }
    return sendNotFound(res, head);
  }

  /**
   * A platform topic zone's page or its feed, by id or slug. Answers 404 itself unless `quiet`, where it returns false and lets the caller
   * try the zones of cards (an id may be either kind).
   * @param {any} req @param {any} res @param {boolean} head @param {string} ref @param {"page" | "feed"} kind @param {{ quiet?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function serveTopic(req, res, head, ref, kind, { quiet = false } = {}) {
    const source = /** @type {NonNullable<typeof topics>} */ (topics);
    const zone = await source.zone(ref);
    if (!zone) {
      if (quiet) return false;
      sendNotFound(res, head);
      return true;
    }
    if (kind === "feed") {
      counters.feeds += 1;
      const items = await source.items(zone.id, { limit: EVIDENCE_PUBLIC_TOPIC_LIMITS.feedItems });
      send(res, 200, { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}` },
        topicZoneRss({ zone, items, generatedAt: now(), publicUrl: config.publicUrl }), head);
      return true;
    }
    // The newest few hundred decide the key updates; the page shows the newest fifty.
    const found = await source.items(zone.id, { limit: 300 });
    const items = found.slice(0, EVIDENCE_PUBLIC_TOPIC_LIMITS.items);
    const keyUpdates = found.filter((item) => item.key).slice(0, EVIDENCE_PUBLIC_TOPIC_LIMITS.keyUpdates);
    const [cited, tags] = await Promise.all([source.cited((zone.progress?.refs ?? []).map((reference) => reference.itemId)), source.keywordTags(zone)]);
    const page = topicZonePage({ zone, items, cited, keyUpdates, shown: Math.max(found.length, zone.month), publicUrl: config.publicUrl, tags });
    const alias = ref !== zone.id;
    await countRead(req, head, { zoneId: zone.id });
    sendPage(res, head, 200, page, {
      path: alias && zone.slug ? topicZoneSlugPath(zone.slug) : topicZonePath(zone.id), canonicalPath: topicZonePath(zone.id), active: "zones", ogType: "article",
      // 最新进展 is written by a model, so the page carries the implicit AI-content label (as a card an AI wrote does) beside the visible note under it.
      aigc: zone.progress ? aigcMetadata({ producerName: EVIDENCE_PLATFORM_PRODUCER_NAME, produceId: `${zone.id}@${zone.progress.at}`, propagateId: `${zone.id}@${zone.progress.at}` }) : null,
      noindex: await noindexFor({ kind: "topic", month: zone.month, hasProgress: Boolean(zone.progress) }),
      feed: { title: `${zone.title} · ${EVIDENCE_SITE_NAME}`, href: topicZoneFeedPath(zone.id) },
    });
    return true;
  }

  /** One read of a zone or card page, counted once; a program's request and a failed write are not. @param {any} req @param {boolean} head @param {{ zoneId: string, cardId?: string | null }} read */
  async function countRead(req, head, read) {
    if (head) return;
    if (evidencePublicIsBot(req.headers["user-agent"])) { counters.readsSkippedBot += 1; return; }
    try {
      await recordPageRead(database, { ...read, day: evidencePublicDay(now()) });
      counters.readsCounted += 1;
    } catch {
      counters.readsFailed += 1;
      report("evidence_public_read_count_failed");
    }
  }

  /** @param {any} req @param {any} res @param {URL} url @param {string[]} parts @param {boolean} head */
  async function serveApi(req, res, url, parts, head) {
    counters.api += 1;
    // The API is anonymous and public: `*` is its whole CORS policy. The server's own CORS step (for the app's origin, with credentials)
    // may already have run, and `*` beside `Allow-Credentials: true` is a pair a browser refuses, so that header goes.
    if (typeof res.removeHeader === "function") res.removeHeader("Access-Control-Allow-Credentials");
    const cors = { "Access-Control-Allow-Origin": "*" };
    try {
      const result = await /** @type {NonNullable<typeof api>} */ (api).handle(parts, url.searchParams);
      const next = result.next ?? undefined;
      const etag = `W/"${sha(JSON.stringify({ data: result.data, next: next ?? null })).slice(0, 32)}"`;
      const status = result.status ?? 200;
      const headers = { ...cors, "Content-Type": "application/json; charset=utf-8", ETag: etag, "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}`, Vary: "Accept-Encoding" };
      if (status === 200 && matches(req.headers["if-none-match"], etag)) {
        counters.notModified += 1;
        res.writeHead(304, { ...EVIDENCE_PUBLIC_SECURITY_HEADERS, ...headers });
        res.end();
        return;
      }
      send(res, status, headers, JSON.stringify({
        data: result.data, meta: { generatedAt: now().toISOString(), ...(next ? { next } : {}) }, ...(result.error ? { error: result.error } : {}),
      }), head);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      if (error.status === 404) counters.notFound += 1;
      send(res, error.status, { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ error: error.message, code: error.code }), head);
    }
  }

  return Object.assign(
    /** @param {any} req @param {any} res */
    async (req, res) => {
      const url = new URL(req.url ?? "/", "http://evimed.local");
      const pathname = url.pathname;
      // Only the base this deployment serves the pages at is answered; the other member of the closed set falls through like any unknown path.
      const below = evidencePublicSuffix(pathname);
      const robots = pathname === "/robots.txt";
      if (below === null && !robots) return false;
      if (!enabled || !reads || !indexing || !figures || !api) return false;
      if (below !== null && FEED_SUFFIXES.has(below)) return false;
      const method = req.method ?? "GET";
      if (robots) {
        // Not a page of ours to refuse a method of, and not limited: a crawler that cannot read its robots.txt may stop reading the site.
        if (method !== "GET" && method !== "HEAD") return false;
        counters.robots += 1;
        send(res, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
          evidenceRobotsTxt({ indexable: config.evidencePublicIndexable === true, publicUrl: config.publicUrl }), method === "HEAD");
        return true;
      }
      const apiPrefix = evidencePublicApiPrefix();
      const isApi = pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
      if (method !== "GET" && method !== "HEAD") {
        send(res, 405, { Allow: "GET, HEAD", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ error: "The public evidence pages are read-only.", code: "method_not_allowed" }), false);
        return true;
      }
      const head = method === "HEAD";
      try {
        limiter?.(req);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 429) throw error;
        counters.rateLimited += 1;
        const seconds = Math.max(1, Math.ceil(/** @type {any} */ (error).retryAfterSeconds ?? 60));
        if (isApi) {
          send(res, 429, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Retry-After": String(seconds) }, JSON.stringify({ error: "Too many requests.", code: "evidence_public_rate_limited" }), head);
        } else {
          counters.pages += 1;
          send(res, 429, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(seconds), "X-Robots-Tag": "noindex" },
            renderPage({ ...rateLimitedPage(seconds), path: evidencePublicPath("/"), noindex: true, wide: true }), head);
        }
        return true;
      }
      if (below === "") {
        res.writeHead(301, { Location: evidencePublicPath("/"), "Cache-Control": "public, max-age=3600" });
        res.end();
        return true;
      }
      const parts = pathname.slice(evidencePublicBase().length + 1).split("/").map((part) => { try { return decodeURIComponent(part); } catch { return "\u0000"; } });
      if (parts.includes("\u0000")) { sendNotFound(res, head); return true; }
      try {
        if (isApi) {
          await serveApi(req, res, url, parts.slice(2), head);
          return true;
        }
        if (pathname === evidencePublicStylesheetPath()) {
          counters.assets += 1;
          const { css, etag } = evidencePublicStylesheet();
          const headers = { "Content-Type": "text/css; charset=utf-8", ETag: etag, "Cache-Control": "public, max-age=3600" };
          if (matches(req.headers["if-none-match"], etag)) { counters.notModified += 1; res.writeHead(304, { ...EVIDENCE_PUBLIC_SECURITY_HEADERS, ...headers }); res.end(); return true; }
          send(res, 200, headers, css, head);
          return true;
        }
        if (below === "/sitemap.xml") {
          if (config.evidencePublicIndexable !== true) { sendNotFound(res, head); return true; }
          counters.sitemap += 1;
          indexing.count("sitemapRequests");
          const xml = evidenceSitemapXml(await indexing.sitemapPaths({ ...(await reads.sitemapEntries()), topics: await /** @type {NonNullable<typeof topics>} */ (topics).sitemapEntries() }), config.publicUrl);
          send(res, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": `public, max-age=${MAX_AGE_SECONDS}` }, xml, head);
          return true;
        }
        await servePage(req, res, url, parts, head);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500) { counters.errors += 1; throw error; }
        // A refusal the pages know how to say (a malformed cursor, a missing sitemap address) is the page's own "not found".
        sendNotFound(res, head, error.status === 400 ? 400 : 404);
      }
      return true;
    },
    {
      /** The counters of the pages, the read counter, the indexing rule and the caches; null where the pages are off. */
      stats: () => (enabled && reads && indexing && figures
        ? { ...counters, base: evidencePublicBase(), indexing: indexing.stats(), reads: reads.stats(), metrics: figures.stats() }
        : null),
    },
  );
}

/**
 * The operator's counters for the public pages.
 * @param {ReturnType<ReturnType<typeof createEvidencePublicRoutes>["stats"]>} stats
 */
export function evidencePublicMetricFamilies(stats) {
  if (!stats) return [];
  const counter = (/** @type {string} */ name, /** @type {string} */ help, /** @type {any[]} */ series) => ({ name, help, type: /** @type {const} */ ("counter"), series });
  return [
    { name: "open_science_evidence_public_base_path", help: "The path the public evidence pages, their API, the sitemap and the feed are served under (OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH): one series, labelled with it.",
      type: /** @type {const} */ ("gauge"), series: [{ labels: { path: stats.base }, value: 1 }] },
    counter("open_science_evidence_public_requests_total", "Requests the public evidence pages answered, by kind (a page, the read-only API, the stylesheet, the sitemap, robots.txt).", [
      { labels: { kind: "page" }, value: stats.pages }, { labels: { kind: "api" }, value: stats.api }, { labels: { kind: "asset" }, value: stats.assets }, { labels: { kind: "sitemap" }, value: stats.sitemap }, { labels: { kind: "robots" }, value: stats.robots }, { labels: { kind: "feed" }, value: stats.feeds },
    ]),
    counter("open_science_evidence_public_refusals_total", "Public evidence requests that were refused or answered without content, by reason.", [
      { labels: { reason: "not_found" }, value: stats.notFound }, { labels: { reason: "withdrawn" }, value: stats.withdrawn },
      { labels: { reason: "rate_limited" }, value: stats.rateLimited }, { labels: { reason: "not_modified" }, value: stats.notModified }, { labels: { reason: "error" }, value: stats.errors },
    ]),
    counter("open_science_evidence_public_page_reads_total", "Reads of a zone or card page that were counted for the selector, and those not counted.", [
      { labels: { outcome: "counted" }, value: stats.readsCounted }, { labels: { outcome: "skipped_bot" }, value: stats.readsSkippedBot }, { labels: { outcome: "failed" }, value: stats.readsFailed },
    ]),
    counter("open_science_evidence_public_noindex_total", "Public evidence pages answered noindex, by reason (the deployment's switch, a new author, a withdrawn card, a topic zone with too little on it).", [
      { labels: { reason: "switch_off" }, value: stats.indexing.noindexSwitchOff }, { labels: { reason: "new_author" }, value: stats.indexing.noindexNewAuthor },
      { labels: { reason: "withdrawn" }, value: stats.indexing.noindexWithdrawn },
      { labels: { reason: "thin" }, value: stats.indexing.noindexThin },
    ]),
    counter("open_science_evidence_public_verifications_total", "Cards whose claims the public pages checked against their sources, and checks answered from the cache.", [
      { labels: { outcome: "checked" }, value: stats.reads.verifications }, { labels: { outcome: "cache_hit" }, value: stats.reads.verificationCacheHits },
    ]),
    counter("open_science_evidence_public_monthly_figures_total", "Builds of the monthly figures page, and requests answered from the ten-minute cache.", [
      { labels: { outcome: "computed" }, value: stats.metrics.computed }, { labels: { outcome: "cache_hit" }, value: stats.metrics.cacheHits }, { labels: { outcome: "failed" }, value: stats.metrics.failures },
      { labels: { outcome: "section_failed" }, value: stats.metrics.sectionFailures ?? 0 },
    ]),
  ];
}
