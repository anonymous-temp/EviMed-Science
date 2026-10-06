// Where the public evidence pages are served (flywheel review 2026-10-06, `OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH`): a closed choice of
// two, one module that makes every address, and nothing left holding a literal `/evidence/` once the base is `/evimed-evidence`.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EVIDENCE_PUBLIC_BASE_PATHS } from "@evimed/domain";
import { evidenceCardAddress, evidenceFeedRss } from "../src/evidenceFeed.mjs";
import { evidenceFeedJsonPath, evidenceFeedRssPath } from "../src/evidenceFeedRoutes.mjs";
import { evidencePublicApiPrefix } from "../src/evidencePublicApi.mjs";
import { createEvidencePublicIndexing, evidenceSitemapXml } from "../src/evidencePublicIndexing.mjs";
import { authorPath, cardPath, changesPath, renderPage, zonePath } from "../src/evidencePublicLayout.mjs";
import { aboutPage, indexPage, metricsPage, notFoundPage, requestsPage, simulationsPage } from "../src/evidencePublicPages.mjs";
import { evidencePublicBase, evidencePublicPath, evidencePublicSuffix, setEvidencePublicBase } from "../src/evidencePublicPaths.mjs";
import { createEvidencePublicRoutes } from "../src/evidencePublicRoutes.mjs";
import { evidencePublicStylesheetPath } from "../src/evidencePublicStyle.mjs";
import { loadConfig } from "../src/config.mjs";

after(() => setEvidencePublicBase("/evidence"));

test("the base is a closed set of two, `/evidence` unless set, and anything else is refused by the variable's name", () => {
  assert.deepEqual([...EVIDENCE_PUBLIC_BASE_PATHS], ["/evidence", "/evimed-evidence"]);
  assert.equal(evidencePublicBase(), "/evidence", "the default every deployment before the lever served");
  assert.equal(evidencePublicPath("/c/ec_1"), "/evidence/c/ec_1");
  for (const bad of ["/", "", "/evidence/", "/Evidence", "/other", "evidence", "/evimed-evidence/x", null, undefined, 3]) {
    assert.throws(() => setEvidencePublicBase(bad), /OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH must be one of \/evidence, \/evimed-evidence/, String(bad));
  }
  assert.equal(evidencePublicBase(), "/evidence", "a refused value changes nothing");
  setEvidencePublicBase("/evimed-evidence");
  assert.equal(evidencePublicPath("/"), "/evimed-evidence/");
  assert.equal(evidencePublicSuffix("/evimed-evidence"), "");
  assert.equal(evidencePublicSuffix("/evimed-evidence/c/ec_1"), "/c/ec_1");
  assert.equal(evidencePublicSuffix("/evidence/c/ec_1"), null, "the other member of the set is not answered");
  assert.equal(evidencePublicSuffix("/evimed-evidence-more/x"), null, "a longer name that merely starts with the base is not under it");
  setEvidencePublicBase("/evidence");
  assert.equal(evidencePublicSuffix("/evimed-evidence/c/ec_1"), null);
});

test("the start is stopped by the variable's name for a value outside the set, and the default is /evidence", () => {
  const under = (/** @type {Record<string, string>} */ env) => {
    const saved = process.env;
    process.env = { ...env };
    try { return /** @type {any} */ (loadConfig({})); } finally { process.env = saved; }
  };
  assert.equal(under({}).evidencePublicBasePath, "/evidence");
  assert.equal(under({ OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH: "" }).evidencePublicBasePath, "/evidence", "empty reads as unset");
  assert.equal(under({ OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH: "/evimed-evidence" }).evidencePublicBasePath, "/evimed-evidence");
  for (const bad of ["/", "/evidence/", "/ev", "https://x.example/evidence", "evidence"]) {
    assert.throws(() => under({ OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH: bad }), /OPEN_SCIENCE_EVIDENCE_PUBLIC_BASE_PATH must be one of/, bad);
  }
});

test("with the base at /evimed-evidence every address the pages, the API, the sitemap, the stylesheet and the feed write is under it, and none holds /evidence/", async () => {
  setEvidencePublicBase("/evimed-evidence");
  const author = "au_0123456789abcdef";
  assert.deepEqual([zonePath("ez_1"), changesPath("ez_1"), cardPath("ec_1"), authorPath(author)],
    ["/evimed-evidence/z/ez_1", "/evimed-evidence/z/ez_1/changes", "/evimed-evidence/c/ec_1", `/evimed-evidence/a/${author}`]);
  assert.equal(evidencePublicApiPrefix(), "/evimed-evidence/api/v1");
  assert.equal(evidencePublicStylesheetPath(), "/evimed-evidence/assets/site.css");
  assert.deepEqual([evidenceFeedJsonPath(), evidenceFeedRssPath()], ["/evimed-evidence/feed.json", "/evimed-evidence/feed.xml"]);
  assert.equal(evidenceCardAddress("https://www.evimed.test/ignored/prefix", "ec_1"), "https://www.evimed.test/evimed-evidence/c/ec_1");
  assert.equal(evidenceCardAddress("", "ec_1"), "/evimed-evidence/c/ec_1");

  // Every page kind that needs no data: its markup links only under the base (or the in-app and sign-in paths), and says so in the head.
  const pages = [
    ["index", indexPage({ official: [], product: [], user: [] }), "/evimed-evidence/"],
    ["about", aboutPage(), "/evimed-evidence/about"],
    ["metrics", metricsPage({ months: [] }), "/evimed-evidence/metrics"],
    ["requests", requestsPage({ items: [] }), "/evimed-evidence/requests"],
    ["simulations", simulationsPage({ reader: true, items: [{ id: "sim-1", title: "Trial", summary: "s" }], next: "cursor" }), "/evimed-evidence/simulations"],
    ["not found", notFoundPage(), "/evimed-evidence/"],
  ];
  for (const [name, page, path] of /** @type {[string, any, string][]} */ (pages)) {
    const markup = renderPage({ ...page, path, noindex: false, publicUrl: "https://www.evimed.test", alternates: true });
    assert.equal(/(?:href|src|content)="[^"]*\/evidence\//.test(markup) || /(?:href|src)="\/evidence"/.test(markup), false, `${name}: no link under /evidence/`);
    assert.ok(markup.includes('href="/evimed-evidence/assets/site.css"'), `${name}: the stylesheet`);
    assert.ok(markup.includes('<link rel="canonical" href="https://www.evimed.test' + path + '">'), `${name}: the canonical address`);
    for (const [, href] of markup.matchAll(/href="(\/[^"]*)"/g)) {
      assert.ok(href.startsWith("/evimed-evidence") || href === "/login" || href.startsWith("/app/"), `${name}: ${href} is under the base`);
    }
  }
  assert.ok(String(pages[4][1].body).includes('href="/evimed-evidence/simulations/sim-1"'), "a simulation links under the base");
  assert.ok(String(pages[4][1].body).includes("/evimed-evidence/simulations?cursor="), "and so does its pager");
  assert.ok(renderPage({ ...(/** @type {any} */ (pages[0][1])), path: "/evimed-evidence/", noindex: false, alternates: true }).includes('href="/evimed-evidence/feed.xml"'), "the feed links");

  // The sitemap lists the static pages, the zones, the cards and the authors under the base.
  const indexing = createEvidencePublicIndexing({ config: { evidencePublicIndexable: true }, reads: { authorQualifies: async () => true } });
  const paths = await indexing.sitemapPaths({
    zones: [{ id: "ez_1", kind: "user", authorHandle: author, updatedAt: "2026-10-01T00:00:00Z" }],
    cards: [{ id: "ec_1", kind: "user", authorHandle: author, updatedAt: "2026-10-01T00:00:00Z" }],
  });
  const sitemap = evidenceSitemapXml(paths, "https://www.evimed.test");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, [
    "https://www.evimed.test/evimed-evidence/", "https://www.evimed.test/evimed-evidence/about", "https://www.evimed.test/evimed-evidence/metrics", "https://www.evimed.test/evimed-evidence/simulations",
    "https://www.evimed.test/evimed-evidence/z/ez_1", "https://www.evimed.test/evimed-evidence/c/ec_1", `https://www.evimed.test/evimed-evidence/a/${author}`,
  ]);

  // The feed's RSS links its own channel and its next page under the base.
  const rss = evidenceFeedRss({ generatedAt: "2026-10-06T00:00:00Z", items: [], next: "abc" }, { publicUrl: "https://www.evimed.test", selfPath: "/evimed-evidence/feed.xml" });
  assert.ok(rss.includes("<link>https://www.evimed.test/evimed-evidence/</link>") && rss.includes("https://www.evimed.test/evimed-evidence/feed.xml?cursor=abc"));
  assert.equal(rss.includes("/evidence/"), false);
});

test("the router answers its own base and nothing under the other: the stylesheet is served at the base, and /evidence/… is not claimed", async () => {
  setEvidencePublicBase("/evimed-evidence");
  const routes = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true, publicUrl: "https://www.evimed.test" }, database: { query: async () => ({ rows: [] }) } });
  /** @param {string} url */
  const ask = async (url) => {
    const res = { status: 0, headers: /** @type {any} */ ({}), body: "", writeHead(/** @type {number} */ status, /** @type {any} */ headers) { this.status = status; this.headers = headers; return this; }, end(/** @type {any} */ chunk) { this.body = chunk ? String(chunk) : ""; } };
    const handled = await routes({ url, method: "GET", headers: { "user-agent": "Mozilla/5.0 Safari" } }, res);
    return { handled, res };
  };
  const own = await ask("/evimed-evidence/assets/site.css");
  assert.equal(own.handled, true);
  assert.equal(own.res.status, 200);
  assert.match(own.res.headers["Content-Type"], /^text\/css/);
  for (const other of ["/evidence/assets/site.css", "/evidence/", "/evidence", "/evidence/c/ec_0123456789ab", "/evidence/api/v1/zones", "/evidence/sitemap.xml"]) {
    assert.equal((await ask(other)).handled, false, `${other} is another product's path here: not claimed`);
  }
  assert.equal((await ask("/evimed-evidence")).res.status, 301, "the bare base redirects to its index");
  assert.equal((await ask("/evimed-evidence")).res.headers.Location, "/evimed-evidence/");
});
