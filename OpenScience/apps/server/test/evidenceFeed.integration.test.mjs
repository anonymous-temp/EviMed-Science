// The public evidence feed (flywheel F09), against a real PostgreSQL and over HTTP: what the knowledge-source plugin
// may read of the platform's own evidence. An official zone's cards and a researcher's original research in a zone
// opened to the internet are in; a product zone's card, a platform-only user zone's card, a draft and an unpublished
// zone's card are never; the two paths answer 404 by name while the public pages are off; a page is cached by the
// zones' content version and answered 304 to its ETag; and no source text leaves.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIDENCE_FEED_VERSION, createEvidenceFeed, evidenceCardAddress, evidenceFeedAbout, evidenceFeedMetricFamilies, evidenceFeedRss } from "../src/evidenceFeed.mjs";
import { createEvidenceFeedRoutes } from "../src/evidenceFeedRoutes.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { sendError } from "../src/security.mjs";
import { PLUGIN_FIXTURE_DIR, pluginProvenance, recordEvidenceFeed } from "./helpers/evidenceFeedFixture.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const PUBLIC_URL = "https://www.evimed.test";
const alice = { id: "alice" };
const publisher = { id: "publisher" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke.";
const cardInput = (title, extra = {}) => ({
  title, subtype: "academic", summary: "A summary.", body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: `${TEXT} A restricted passage that must never leave.`, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen." }, ...extra,
});
const productFields = {
  producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] },
  journeyStage: { key: "treatment-choice", label: "治疗选择" },
  disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] },
};

let isolated, db, zones, feed;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evfeed");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
  feed = createEvidenceFeed({ database: db, config: { publicUrl: PUBLIC_URL }, now: () => new Date("2026-10-05T08:00:00Z") });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
});

const officialZone = async (title = "Official zone") => {
  const { zone } = await zones.saveEditorial(publisher, { title, description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  return (await zones.saveEditorial(publisher, { expectedRevision: zone.revision, state: "published" }, zone.id, null, false, "programme")).zone;
};
const userZone = async (user, { internet = false, kind, title = "User zone", published = true } = /** @type {any} */ ({})) => {
  const { zone } = await zones.save(user, { title, description: "d", background: "b", ...(kind ? { kind } : {}) });
  if (!published) return zone;
  const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  return internet ? (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone : live;
};
const officialCard = (zone, title, extra = {}, origin = "programme") => zones.saveEditorial(publisher, cardInput(title, extra), zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);
const userCard = (user, zone, title, extra = {}, origin = "result") => zones.saveEditorial(user, cardInput(title, extra), zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);
const titles = async (query) => (await feed.page(query)).page.items.map((item) => item.title);

test("an official zone's cards and a researcher's original research in an open zone are in the feed; nothing else is", options, async () => {
  const official = await officialZone();
  const open = await userZone(alice, { internet: true });
  const closed = await userZone(alice, { title: "Platform-only zone" });
  const product = await userZone(alice, { kind: "product", title: "Product zone" });
  const draftZone = await userZone(alice, { published: false, title: "Draft zone" });
  await officialCard(official, "Official brief", { originality: "brief" });
  await officialCard(official, "Official recalculation", { originality: "recalculation" });
  await officialCard(official, "Official draft", { state: "draft" });
  await userCard(alice, open, "Original research of Alice", { originality: "original_research" });
  await userCard(alice, open, "Alice's synthesis in an open zone", { originality: "synthesis" });
  await userCard(alice, closed, "Original research in a platform-only zone", { originality: "original_research" });
  await userCard(alice, product, "A product card", { ...productFields, originality: "original_research" }, "geo");
  await userCard(alice, draftZone, "A card in an unpublished zone", { originality: "original_research" });
  assert.deepEqual((await titles()).sort(), ["Official brief", "Official recalculation", "Original research of Alice"].sort());
  const { page } = await feed.page();
  const byTitle = Object.fromEntries(page.items.map((item) => [item.title, item]));
  assert.equal(byTitle["Official brief"].primary, false);
  assert.equal(byTitle["Official recalculation"].primary, true);
  assert.equal(byTitle["Original research of Alice"].primary, true);
  assert.deepEqual(byTitle["Original research of Alice"].zone, { id: open.id, title: "User zone", kind: "user" });
  assert.deepEqual(byTitle["Original research of Alice"].producer, { kind: "user", name: "Alice" });
  assert.deepEqual(byTitle["Official brief"].producer, { kind: "platform", name: "EviMed 证据中心" });
  // A zone taken back to a draft, and a zone returned to platform-only, take their cards out again.
  await zones.setVisibility(alice, open.id, { visibility: "platform", expectedRevision: (await zones.detail(alice, open.id)).zone.revision });
  assert.equal((await titles()).includes("Original research of Alice"), false, "the researcher closed the zone: the card leaves the feed");
  await zones.saveEditorial(publisher, { expectedRevision: (await zones.detail(publisher, official.id)).zone.revision, state: "draft" }, official.id, null, false, "programme");
  assert.deepEqual(await titles(), []);
});

test("an item is the fixed contract: the card's own address, its words, who made it, what it is about, its keys and its sources — no source text", options, async () => {
  const official = await officialZone();
  await db.query("UPDATE evimed_frontier.evidence_zones SET title='Cardiology' WHERE id=$1", [official.id]);
  const card = await officialCard(official, "Apixaban and stroke", {
    originality: "synthesis", entityKeys: ["drug:apixaban"],
    lineage: { verifiedStudy: { doi: "10.1056/NEJMoa1", registryId: "NCT01234567" } },
    sources: [
      { title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: `${TEXT} A restricted passage that must never leave.`, coverage: "full-text" },
      { title: "The registry", url: "https://clinicaltrials.gov/study/NCT09876543", excerpt: TEXT },
      { title: "A paper by PMC id", url: "https://pubmed.ncbi.nlm.nih.gov/12345678/", excerpt: TEXT },
    ],
  });
  const { page } = await feed.page();
  assert.equal(page.version, EVIDENCE_FEED_VERSION);
  assert.equal(page.generatedAt, "2026-10-05T08:00:00.000Z");
  assert.equal(page.next, null);
  const [item] = page.items;
  assert.deepEqual(Object.keys(item).sort(), ["about", "entityKeys", "id", "originality", "primary", "producer", "publishedAt", "revision", "sources", "summary", "title", "updatedAt", "url", "zone"]);
  assert.equal(item.id, card.id);
  assert.equal(item.url, `${PUBLIC_URL}/evidence/c/${card.id}`);
  assert.equal(item.summary, "Fewer strokes were seen.");
  assert.deepEqual(item.about, { doi: ["10.1000/stroke.1", "10.1056/nejmoa1"], pmid: ["12345678"], registryIds: ["NCT01234567", "NCT09876543"] });
  assert.ok(item.entityKeys.includes("drug:apixaban"));
  assert.deepEqual(item.sources, [
    { title: "The trial", url: "https://doi.org/10.1000/Stroke.1" },
    { title: "The registry", url: "https://clinicaltrials.gov/study/NCT09876543" },
    { title: "A paper by PMC id", url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" },
  ]);
  assert.equal(item.revision, 1);
  assert.ok(Date.parse(item.publishedAt) <= Date.parse(item.updatedAt));
  const wire = JSON.stringify(page);
  assert.equal(wire.includes("restricted passage"), false, "a source's text never leaves");
  assert.equal(wire.includes("documentText"), false);
  assert.equal(wire.includes("excerpt"), false);
});

test("the feed pages by a cursor, newest first, and an old cursor or a bad limit is refused by name", options, async () => {
  const official = await officialZone();
  for (let index = 0; index < 5; index += 1) await officialCard(official, `Card ${index}`);
  const first = (await feed.page({ limit: 2 })).page;
  assert.deepEqual(first.items.map((item) => item.title), ["Card 4", "Card 3"]);
  assert.ok(first.next);
  const second = (await feed.page({ limit: 2, cursor: first.next })).page;
  assert.deepEqual(second.items.map((item) => item.title), ["Card 2", "Card 1"]);
  const third = (await feed.page({ limit: 2, cursor: second.next })).page;
  assert.deepEqual(third.items.map((item) => item.title), ["Card 0"]);
  assert.equal(third.next, null);
  await assert.rejects(feed.page({ cursor: "not-a-cursor" }), { code: "evidence_feed_cursor_invalid", status: 400 });
  await assert.rejects(feed.page({ limit: 0 }), { code: "evidence_feed_query_invalid", status: 400 });
  await assert.rejects(feed.page({ limit: 201 }), { code: "evidence_feed_query_invalid" });
  await assert.rejects(feed.page({ limit: 1.5 }), { code: "evidence_feed_query_invalid" });
  assert.equal((await feed.page({ limit: 200 })).page.items.length, 5);
});

test("a page is cached by the zones' content version and a write moves it", options, async () => {
  const official = await officialZone();
  await officialCard(official, "First");
  const a = await feed.page();
  const before = feed.stats().cacheHits;
  const b = await feed.page();
  assert.equal(feed.stats().cacheHits, before + 1, "the same version is the same page");
  assert.equal(b.page, a.page);
  assert.equal(a.etag, b.etag);
  await officialCard(official, "Second");
  const c = await feed.page();
  assert.notEqual(c.etag, a.etag, "a write moved the version");
  assert.deepEqual(c.page.items.map((item) => item.title), ["Second", "First"]);
  assert.notEqual((await feed.page({ limit: 1 })).etag, c.etag, "another page of the same version has its own tag");
});

/** The routes in front of a real HTTP server, errors as the server renders them. */
async function serve(t, { config, feed: served = feed }) {
  const routes = createEvidenceFeedRoutes({ config, feed: served });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.writeHead(418); res.end("not the feed's"); } }, (error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}

test("over HTTP: the JSON and the RSS, unauthenticated, with an ETag the second request is answered 304 to", options, async (t) => {
  const official = await officialZone();
  const card = await officialCard(official, "Apixaban & stroke <brief>");
  const get = await serve(t, { config: { evidencePublicWebEnabled: true, publicUrl: PUBLIC_URL } });
  const json = await get("/evidence/feed.json");
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type"), /^application\/json/);
  const etag = json.headers.get("etag");
  assert.ok(etag);
  const body = await json.json();
  assert.deepEqual(Object.keys(body), ["version", "generatedAt", "items", "next"], "the document itself, not wrapped in an envelope");
  assert.equal(body.version, "evimed-evidence-feed/1");
  assert.equal(body.items[0].id, card.id);
  const again = await get("/evidence/feed.json", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);
  assert.equal((await get("/evidence/feed.json", { headers: { "if-none-match": 'W/"something-else"' } })).status, 200);
  const rss = await get("/evidence/feed.xml");
  assert.equal(rss.status, 200);
  assert.match(rss.headers.get("content-type"), /^application\/rss\+xml/);
  const xmlText = await rss.text();
  assert.match(xmlText, /<rss version="2.0"/);
  assert.match(xmlText, new RegExp(`<guid isPermaLink="true">${PUBLIC_URL}/evidence/c/${card.id}</guid>`));
  assert.ok(xmlText.includes("<title>Apixaban &amp; stroke &lt;brief&gt;</title>"), "the words are escaped");
  assert.equal((await get("/evidence/feed.xml", { headers: { "if-none-match": rss.headers.get("etag") } })).status, 304);
  const head = await get("/evidence/feed.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await get("/evidence/feed.json", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal((await get("/evidence/c/anything")).status, 418, "every other path under /evidence is the pages' to answer");
  assert.equal((await get("/evidence/feed.json?limit=0")).status, 400);
  assert.equal((await (await get("/evidence/feed.json?cursor=zzz")).json()).code, "evidence_feed_cursor_invalid");
  const counters = feed.stats();
  assert.ok(counters.requests >= 6 && counters.notModified >= 2);
  assert.ok(evidenceFeedMetricFamilies(counters).some((family) => family.name === "open_science_evidence_feed_requests_total"));
});

test("with the public pages off the two paths answer 404 by name and read nothing; any other path is not theirs", options, async (t) => {
  const official = await officialZone();
  await officialCard(official, "Hidden while off");
  const reads = [];
  const watched = { ...feed, count: () => {}, page: async (...args) => { reads.push(args); return feed.page(...args); } };
  const get = await serve(t, { config: { evidencePublicWebEnabled: false, publicUrl: PUBLIC_URL }, feed: watched });
  for (const path of ["/evidence/feed.json", "/evidence/feed.xml"]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).code, "evidence_public_not_enabled", path);
  }
  assert.equal(reads.length, 0, "an off module reads no card");
  assert.equal((await get("/evidence/anything-else")).status, 418);
  const noDatabase = await serve(t, { config: { evidencePublicWebEnabled: true }, feed: null });
  const unbuilt = await noDatabase("/evidence/feed.json");
  assert.equal(unbuilt.status, 404);
  assert.equal((await unbuilt.json()).code, "evidence_public_not_enabled");
});

test("the card's address is fixed on the public URL, the study it is about is read off its sources, and the RSS names the next page", () => {
  assert.equal(evidenceCardAddress("https://www.evimed.com/anything/else", "ec_1"), "https://www.evimed.com/evidence/c/ec_1");
  assert.equal(evidenceCardAddress("", "ec_1"), "/evidence/c/ec_1", "with no public URL it is the path alone");
  assert.equal(evidenceCardAddress("http://user:pw@x.test/", "ec_1"), "/evidence/c/ec_1", "an address with credentials is not used");
  assert.deepEqual(evidenceFeedAbout({ lineage: { verifiedStudy: { pmid: "42" } }, sources: [{ url: "https://x.test/NCT01234567" }] }),
    { doi: [], pmid: ["42"], registryIds: ["NCT01234567"] });
  const rss = evidenceFeedRss({ generatedAt: "2026-10-05T08:00:00.000Z", items: [], next: "abc" }, { publicUrl: PUBLIC_URL, selfPath: "/evidence/feed.xml" });
  assert.match(rss, /<atom:link rel="next" type="application\/rss\+xml" href="https:\/\/www\.evimed\.test\/evidence\/feed\.xml\?cursor=abc"\/>/);
});

test("the knowledge-source plugin's recording of this feed is what the feed builds now, byte for byte", options, async (t) => {
  // The plugin reads this feed like any publisher's and replays a recording of it in its tests. The recording is made by
  // this code (helpers/evidenceFeedFixture.mjs), so a change to the feed's shape that is not recorded again fails here.
  const recorded = await readFile(path.join(PLUGIN_FIXTURE_DIR, "01.json"), "utf8").catch(() => null);
  if (recorded == null) { t.skip("outside the monorepo: the plugin's copy is not here to compare"); return; }
  const now = await recordEvidenceFeed(db);
  assert.equal(recorded, now.body, "re-record: OPEN_SCIENCE_TEST_POSTGRES_URL=… node apps/server/test/helpers/evidenceFeedFixture.mjs --write");
  const provenance = JSON.parse(await readFile(path.join(PLUGIN_FIXTURE_DIR, "provenance.json"), "utf8"));
  assert.deepEqual(provenance, pluginProvenance(now));
  const items = JSON.parse(recorded).items;
  assert.deepEqual(items.map((item) => [item.originality, item.primary]).sort(), [["brief", false], ["original_research", true], ["recalculation", true]]);
  assert.deepEqual(items.find((item) => item.originality === "brief").about.registryIds, ["NCT00412984"], "an interpretation names the trial it is about");
});
