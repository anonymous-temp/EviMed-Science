// The public evidence pages and their read-only API against a real PostgreSQL and over HTTP (flywheel F08, F27): what is public and
// what is not (and that the two answer alike), the pages' content for each kind of page, the indexing rules, the withdrawn card, the
// API envelope, the page reads and the topic requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { withAccountExportSnapshot } from "../src/accountExport.mjs";
import { createEvidenceChangeLog } from "../src/evidenceChangeLog.mjs";
import { EVIDENCE_ZONE_SQL, migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidencePublicMetrics } from "../src/evidencePublicMetrics.mjs";
import { pageReads } from "../src/evidencePublicReads.mjs";
import { createEvidenceTopicRequests, normalizeTopicTitle, topicRequestCounts } from "../src/evidencePublicRequests.mjs";
import { createEvidencePublicRoutes, evidencePublicMetricFamilies } from "../src/evidencePublicRoutes.mjs";
import { sendError } from "../src/security.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const PUBLIC_URL = "https://www.evimed.test";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const alice = { id: "alice" };
const bob = { id: "bob" };
const carol = { id: "carol" };
const publisher = { id: "publisher" };

const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const SENTINEL = "RESTRICTED-PASSAGE-THAT-MUST-NEVER-LEAVE";
const comparisons = [
  { title: "Stroke", outcome: "Stroke", timeframe: "2 years", denominator: 100, control: { label: "Usual care", events: 12 }, intervention: { label: "Drug", events: 7 },
    relativeEffect: "RR 0.58", certainty: "moderate", participants: 4200, studies: 3, outcomeRole: "benefit", sourceIndexes: [1] },
];
/** A card with one claim that is in its source and one that is not. */
const cardInput = (title, extra = {}) => ({
  title, subtype: "academic", summary: `${title} summary.`, body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: `${TEXT} ${SENTINEL}`, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen.", population: "Adults", comparisons },
  claims: [
    { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" },
    { claimId: "CLM-002", claimType: "direct", claim: "Nobody died.", sourceIndexes: [1], supportQuote: "No one died in either group" },
  ],
  ...extra,
});
/** A card whose every claim is in its source (it earns a ✓). */
const passing = (title, extra = {}) => cardInput(title, { claims: [cardInput(title).claims[0]], ...extra });
const productFields = {
  producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] },
  journeyStage: { key: "treatment-choice", label: "治疗选择" },
  disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH", title: "主任医师" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] },
};

/** @type {any} */ let isolated;
/** @type {any} */ let db;
/** @type {any} */ let zones;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "evpublic");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('carol','Carol','development'),('publisher','Platform publisher','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  await db.query("TRUNCATE evimed_frontier.evidence_topic_requests CASCADE");
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('carol','Carol','development') ON CONFLICT DO NOTHING");
});

/** @param {string} [title] @param {boolean} [internet] */
const officialZone = async (title = "Official zone", internet = true) => {
  const { zone } = await zones.saveEditorial(publisher, { title, description: "Official description", background: "b", kind: "official" }, null, null, false, "programme");
  const live = (await zones.saveEditorial(publisher, { expectedRevision: zone.revision, state: "published" }, zone.id, null, false, "programme")).zone;
  return internet ? (await zones.setVisibility(publisher, live.id, { visibility: "internet", expectedRevision: live.revision })).zone : live;
};
const userZone = async (user, { internet = true, kind = /** @type {string | undefined} */ (undefined), title = "User zone", published = true } = {}) => {
  const { zone } = await zones.save(user, { title, description: "d", background: "b", ...(kind ? { kind } : {}) });
  if (!published) return zone;
  const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  return internet ? (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone : live;
};
const officialCard = (zone, input) => zones.saveEditorial(publisher, input, zone.id, null, true, "programme").then((result) => result.evidence);
const userCard = (user, zone, input, origin = "result") => zones.saveEditorial(user, input, zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);

/**
 * The router in front of a real HTTP server.
 * @param {import("node:test").TestContext} t
 * @param {{ config?: Record<string, any>, simulations?: any, requests?: any, limiter?: any, now?: () => Date, metrics?: any }} [settings]
 */
async function serve(t, { config = {}, simulations = null, requests = null, limiter = null, now, metrics } = {}) {
  const routes = createEvidencePublicRoutes({ config: { evidencePublicWebEnabled: true, publicUrl: PUBLIC_URL, ...config }, database: db, simulations, requests, limiter, ...(now ? { now } : {}), ...(metrics ? { metrics } : {}) });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => { if (!handled) { res.writeHead(418); res.end("not the pages'"); } }, (error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = /** @type {any} */ (server.address());
  const get = (/** @type {string} */ path, /** @type {RequestInit & { agent?: string }} */ init = {}) => {
    const { agent = BROWSER, ...rest } = init;
    return fetch(`http://127.0.0.1:${address.port}${path}`, { ...rest, headers: { "user-agent": agent, ...(rest.headers ?? {}) } });
  };
  const text = async (/** @type {string} */ path, init) => { const response = await get(path, init); return { status: response.status, headers: response.headers, body: await response.text() }; };
  return { get, text, routes };
}
const json = (/** @type {{ body: string }} */ response) => JSON.parse(response.body);

test("only a published card in a published zone opened to the internet is public — a platform-only zone, a draft, and an account that is gone answer exactly like an id that never existed", options, async (t) => {
  const official = await officialZone();
  // An official zone has no owner who could open it: published, it is public by rule (2026-10-06).
  const unopenedOfficial = await officialZone("Official zone nobody opened", false);
  const open = await userZone(alice);
  const closed = await userZone(alice, { internet: false, title: "Platform-only zone" });
  const draft = await userZone(alice, { published: false, title: "Draft zone" });
  const goneZone = await userZone(carol, { title: "Carol's zone" });
  const shown = await officialCard(official, cardInput("Official card"));
  const shownUser = await userCard(alice, open, cardInput("Open user card"));
  const draftCard = await userCard(alice, open, cardInput("A draft card", { state: "draft" }));
  const unopenedCard = await officialCard(unopenedOfficial, cardInput("Official card, zone never opened by anyone"));
  const hidden = [
    await userCard(alice, closed, cardInput("Card in a platform-only zone")),
    await userCard(alice, draft, cardInput("Card in a draft zone")),
    draftCard,
  ];
  const goneCard = await userCard(carol, goneZone, cardInput("Card of an account that is deleted"));
  const { get, text } = await serve(t);
  assert.equal(unopenedOfficial.visibility, "internet");
  assert.equal((await get(`/evidence/c/${unopenedCard.id}`)).status, 200, "a published official zone is public without anyone opening it");
  // Before the account is deleted the card is public; after it, it is not found.
  assert.equal((await get(`/evidence/c/${goneCard.id}`)).status, 200);
  await db.query("DELETE FROM evimed_control.users WHERE id = 'carol'");
  const missing = await text("/evidence/c/ec_0000000000000000");
  const missingZone = await text("/evidence/z/ez_0000000000000000");
  const missingApi = await text("/evidence/api/v1/cards/ec_0000000000000000");
  for (const id of [...hidden.map((card) => card.id), goneCard.id]) {
    const answer = await text(`/evidence/c/${id}`);
    assert.equal(answer.status, 404, id);
    assert.equal(answer.body, missing.body, "the body is the one a missing card gets");
    for (const header of ["content-type", "cache-control", "x-robots-tag"]) assert.equal(answer.headers.get(header), missing.headers.get(header), header);
    const api = await text(`/evidence/api/v1/cards/${id}`);
    assert.equal(api.status, 404);
    assert.equal(api.body, missingApi.body);
  }
  for (const zone of [closed, draft, goneZone]) {
    const answer = await text(`/evidence/z/${zone.id}`);
    assert.equal(answer.status, 404, zone.id);
    assert.equal(answer.body, missingZone.body);
    assert.equal((await text(`/evidence/z/${zone.id}/changes`)).status, 404);
    assert.equal((await text(`/evidence/api/v1/zones/${zone.id}`)).status, 404);
    assert.equal((await text(`/evidence/api/v1/zones/${zone.id}/cards`)).status, 404);
  }
  assert.equal((await text("/evidence/a/carol")).status, 404, "an account that is gone has no page");
  assert.equal((await text("/evidence/a/nobody")).status, 404, "nor has an id that is no account");
  assert.equal((await text("/evidence/a/bob")).status, 404, "an account with nothing public has the same answer, so the page reveals nothing about who signed up");
  // What is listed: the index, the zone's own list and every API listing.
  const index = (await text("/evidence/")).body;
  const listed = (api) => JSON.stringify(api);
  assert.ok(index.includes("Official zone") && index.includes("User zone"));
  for (const title of ["Platform-visible official", "Platform-only zone", "Draft zone", "Carol&#39;s zone"]) assert.equal(index.includes(title), false, title);
  const zonePage = (await text(`/evidence/z/${open.id}`)).body;
  assert.ok(zonePage.includes("Open user card"));
  assert.equal(zonePage.includes("A draft card"), false, "a draft card is not listed");
  const api = json(await text("/evidence/api/v1/zones"));
  assert.deepEqual(api.data.zones.map((zone) => zone.id).sort(), [official.id, open.id].sort());
  const cards = json(await text(`/evidence/api/v1/zones/${open.id}/cards`));
  assert.deepEqual(cards.data.cards.map((card) => card.id), [shownUser.id]);
  assert.equal((await text(`/evidence/api/v1/cards/${shown.id}`)).status, 200);
  const everything = listed(api) + listed(cards) + index + zonePage;
  for (const secret of [...hidden.map((card) => card.id), goneCard.id, closed.id, draft.id, goneZone.id]) assert.equal(everything.includes(secret), false, `${secret} is not in a public listing`);
});

test("the index lists the three kinds in three separate sections, a product zone with its producer and relation, and orders by the ranking inputs only", options, async (t) => {
  const official = await officialZone("Official A");
  const product = await userZone(alice, { kind: "product", title: "Product zone" });
  await userCard(alice, product, cardInput("Product card", productFields), "geo");
  const quiet = await userZone(bob, { title: "Quiet zone" });
  const followed = await userZone(alice, { title: "Followed zone" });
  await officialCard(official, cardInput("Official card"));
  await userCard(bob, quiet, cardInput("Quiet card"));
  await userCard(alice, followed, cardInput("Followed card"));
  // Same day, so recency ties and the next input decides: the zone with followers comes first although it was made last.
  await zones.act(bob, followed.id, "follow", { expectedRevision: followed.revision });
  await zones.act(carol, followed.id, "follow", { expectedRevision: followed.revision });
  const { text } = await serve(t);
  const page = (await text("/evidence/")).body;
  const section = (id, next) => page.slice(page.indexOf(`<h2 id="${id}">`), next ? page.indexOf(`<h2 id="${next}">`) : undefined);
  const officialSection = section("official", "product");
  const productSection = section("product", "user");
  const userSection = section("user");
  assert.ok(officialSection.includes("Official A") && !officialSection.includes("Product zone") && !officialSection.includes("Followed zone"));
  assert.ok(productSection.includes("Product zone") && !productSection.includes("Official A") && !productSection.includes("Followed zone"), "a product zone is never in another section");
  assert.ok(productSection.includes("企业 Acme Pharma。涉及出品方自己的产品（Drug A）"), "the producer and its relation are in the row");
  assert.ok(userSection.indexOf("Followed zone") > -1 && userSection.indexOf("Followed zone") < userSection.indexOf("Quiet zone"), "followers rank above none on the same day");
  assert.match(page, /<link rel="alternate" type="application\/rss\+xml"[^>]*href="\/evidence\/feed\.xml">/, "the feed is advertised");
  // The ordering is the domain's closed list: there is no field a payment could be written into.
  const { evidenceRankingComparator } = await import("@evimed/domain");
  assert.throws(() => evidenceRankingComparator(["paid_placement"]), { code: "evidence_ranking_input_unknown" });
});

test("a zone page leads with its producer, lists its cards with ✓/⚠, currency and check date, links the change log and ends with the way into the app", options, async (t) => {
  const zone = await userZone(alice, { kind: "product", title: "Acme zone" });
  const stale = await userCard(alice, zone, cardInput("Product card", productFields), "geo");
  await db.query("UPDATE evimed_frontier.evidence_cards SET currency='new_evidence_pending', pending_item_ids='{a,b}', last_checked_at='2026-10-01T04:00:00Z' WHERE id=$1", [stale.id]);
  const { text } = await serve(t);
  const answer = await text(`/evidence/z/${zone.id}`);
  assert.equal(answer.status, 200);
  const body = answer.body;
  assert.ok(body.indexOf('class="producer"') < body.indexOf("<h1>"), "who made it is the first thing on the page");
  assert.ok(body.includes("企业 Acme Pharma。涉及出品方自己的产品"));
  assert.match(body, /<h1>Acme zone<\/h1>/);
  assert.match(body, /<span class="mark-ok"[^>]*>✓ 1<\/span> <span class="mark-warn"[^>]*>⚠ 1<\/span>/, "one claim found in its source, one not");
  assert.ok(body.includes("有新证据，尚未纳入"), "the currency label of the card");
  assert.ok(body.includes("最后核对 <time datetime=\"2026-10-01T04:00:00.000Z\">2026-10-01</time>"), "the last checked date");
  assert.ok(body.includes(`href="/evidence/z/${zone.id}/changes"`));
  assert.ok(body.includes(`href="/app/frontier/zones/${zone.id}"`) && body.includes("继续研究"));
  assert.match(answer.headers.get("content-type"), /^text\/html; charset=utf-8/);
  assert.match(body, /^<!doctype html>\n<html lang="zh-CN">/);
});

test("a card page in both views: the clinical table with absolute numbers computed by code, the public fact box, the marked claims with their quotations, and no source text", options, async (t) => {
  const zone = await userZone(alice, { kind: "product", title: "Acme zone" });
  const card = await userCard(alice, zone, cardInput("Does the drug prevent stroke?", {
    ...productFields,
    publicView: { oneLineAnswer: { text: "Fewer strokes were seen.", claimIds: ["CLM-001"] }, whatItIs: "A drug." },
  }), "geo");
  const { text } = await serve(t);
  const clinical = await text(`/evidence/c/${card.id}`);
  assert.equal(clinical.status, 200);
  const body = clinical.body;
  assert.ok(body.indexOf('class="producer"') < body.indexOf("<h1>"));
  assert.ok(body.includes("结果总结（临床版）"));
  assert.ok(body.includes("每 1000 人：对照 120，干预 70（相差 -50）"), "120 vs 70 per 1000 from 12/100 and 7/100, computed here");
  assert.ok(body.includes("RR 0.58") && body.includes("moderate"), "the author's relative effect and certainty, as written");
  assert.match(body, /<div class="claim verified" id="claim-CLM-001">\s*<p><span class="mark-ok">✓<\/span> Stroke was less frequent on the drug\./);
  assert.match(body, /<div class="claim unverified" id="claim-CLM-002">\s*<p><span class="mark-warn">⚠<\/span> Nobody died\./);
  assert.ok(body.includes("<blockquote>Among 100 adults on the drug, 7 had a stroke</blockquote>"), "the verbatim quotation under its claim");
  assert.ok(body.includes("引文在所标的来源里没有找到"));
  assert.match(body, /<a href="https:\/\/doi\.org\/10\.1000\/Stroke\.1" rel="nofollow noopener noreferrer" target="_blank">The trial<\/a>/);
  assert.equal(body.includes(SENTINEL), false, "the source's preserved text never leaves");
  assert.equal(body.includes("Among 100 adults on usual care, 12 had a stroke."), false, "nor does a passage no claim quotes");
  // Disclosure of plan §8: producer, AI (none here), dates, authors and reviewers.
  assert.ok(body.includes("Dr. Li，PUMCH，主任医师") && body.includes("Dr. Wang，Pharmacist"));
  assert.ok(body.includes("没有披露 AI 参与写作"));
  assert.equal(body.includes('name="AIGC"'), false, "no AI label on a card no AI wrote");
  assert.match(body, /<link rel="canonical" href="https:\/\/www\.evimed\.test\/evidence\/c\/ec_[A-Za-z0-9]+">/);

  const pub = await text(`/evidence/c/${card.id}?view=public`);
  assert.equal(pub.status, 200);
  assert.ok(pub.body.includes("公众版") && pub.body.includes("事实框：每 1000 人里"));
  assert.ok(pub.body.includes("<td>Stroke</td><td>2 years</td><td class=\"num\">120</td><td class=\"num\">70</td><td class=\"num\">-50</td>"), "the fact box: one denominator, both arms");
  assert.ok(pub.body.includes("Fewer strokes were seen.") && pub.body.includes("一句话回答"));
  assert.ok(pub.body.includes("作者没有填写这一栏"), "an unwritten panel says so");
  assert.ok(pub.body.includes(`<link rel="canonical" href="${PUBLIC_URL}/evidence/c/${card.id}">`), "the view variant has the one canonical address");
  assert.equal((await text(`/evidence/c/${card.id}?view=other`)).status, 400);
  assert.equal(pub.body.includes(SENTINEL), false);
});

test("a source whose address is javascript: is not a link, and every author-written value is escaped on the page", options, async (t) => {
  const zone = await userZone(alice, { title: `<script>alert("zone")</script> & "co"` });
  const card = await userCard(alice, zone, cardInput(`<img src=x onerror=alert(1)> card`, {
    sources: [{ title: "Hostile <b>source</b>", url: "https://example.org/a", excerpt: TEXT }, { title: "Script source", url: "https://example.org/b", excerpt: TEXT }],
    claims: [{ claimId: "CLM-001", claimType: "direct", claim: "<script>claim()</script>", sourceIndexes: [1], supportQuote: "7 had a stroke" }],
  }));
  // The address check at write time refuses a javascript: URL, so plant it the way an old row could hold one.
  await db.query(`UPDATE evimed_frontier.evidence_cards SET sources = jsonb_set(sources, '{1,url}', '"javascript:alert(1)"') WHERE id = $1`, [card.id]);
  const { text } = await serve(t);
  for (const path of [`/evidence/z/${zone.id}`, `/evidence/c/${card.id}`, "/evidence/", "/evidence/a/alice"]) {
    const answer = await text(path);
    assert.equal(answer.status, 200, path);
    assert.equal(/<script/i.test(answer.body), false, `${path}: no script element from a value`);
    assert.equal(answer.body.includes("<img src=x"), false, path);
    assert.equal(/href="javascript:/i.test(answer.body), false, `${path}: no script link`);
  }
  const page = (await text(`/evidence/c/${card.id}`)).body;
  assert.ok(page.includes("&lt;img src=x onerror=alert(1)&gt; card"));
  assert.ok(page.includes("Script source"), "the source is still named");
  assert.equal(page.includes('href="javascript'), false);
  assert.ok(page.includes("&lt;script&gt;claim()&lt;/script&gt;"));
  const zonePage = (await text(`/evidence/z/${zone.id}`)).body;
  assert.ok(zonePage.includes("&lt;script&gt;alert(&quot;zone&quot;)&lt;/script&gt; &amp; &quot;co&quot;"));
  const api = json(await text(`/evidence/api/v1/cards/${card.id}`));
  assert.equal(api.data.card.sources[1].url, null, "the API drops an address that is not http(s) too");
});

test("the security headers are on every page, the stylesheet is served by path and cached by tag, and no page carries script, cookie or inline style", options, async (t) => {
  const official = await officialZone();
  const card = await officialCard(official, cardInput("Official card"));
  const { get, text } = await serve(t);
  for (const path of ["/evidence/", "/evidence/about", `/evidence/z/${official.id}`, `/evidence/c/${card.id}`, "/evidence/requests", "/evidence/metrics", "/evidence/simulations", "/evidence/nope", "/evidence/assets/site.css", `/evidence/api/v1/zones`]) {
    const response = await get(path);
    const policy = response.headers.get("content-security-policy");
    assert.ok(policy, `${path} has a policy`);
    assert.ok(policy.includes("default-src 'none'") && policy.includes("style-src 'self'") && !policy.includes("unsafe-inline") && !policy.includes("script-src"), policy);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.equal(response.headers.get("set-cookie"), null, `${path} sets no cookie`);
    await response.arrayBuffer();
  }
  const page = (await text(`/evidence/c/${card.id}`)).body;
  assert.equal(/<script|style=|onclick=|<style/i.test(page), false);
  assert.ok(page.includes('<link rel="stylesheet" href="/evidence/assets/site.css">'));
  const css = await get("/evidence/assets/site.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/);
  const etag = css.headers.get("etag");
  assert.equal((await get("/evidence/assets/site.css", { headers: { "if-none-match": etag } })).status, 304);
  const head = await get(`/evidence/z/${official.id}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await get("/evidence/", { method: "POST", body: "{}" });
  assert.equal(post.status, 405);
  const bare = await get("/evidence", { redirect: "manual" });
  assert.equal(bare.status, 301, "the bare path goes to the index");
  assert.equal(bare.headers.get("location"), "/evidence/");
});

test("indexing: with the switch off every page says noindex in its markup and its header and there is no sitemap", options, async (t) => {
  const official = await officialZone();
  const card = await officialCard(official, cardInput("Official card"));
  const { get, text } = await serve(t, { config: { evidencePublicIndexable: false } });
  for (const path of ["/evidence/", "/evidence/about", "/evidence/metrics", "/evidence/simulations", "/evidence/requests", `/evidence/z/${official.id}`, `/evidence/z/${official.id}/changes`, `/evidence/c/${card.id}`, "/evidence/a/publisher"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex", path);
    assert.match(await response.text(), /<meta name="robots" content="noindex">/, path);
  }
  assert.equal((await text("/evidence/sitemap.xml")).status, 404);
});

test("indexing: on, a page is indexable unless its author is new (fewer than three published cards that each carry a ✓) or the card is withdrawn; the new-author rule lifts at exactly three", options, async (t) => {
  const official = await officialZone();
  const officialOne = await officialCard(official, cardInput("Official card"));
  const zone = await userZone(alice, { title: "Alice's zone" });
  const first = await userCard(alice, zone, passing("Alice one"));
  const second = await userCard(alice, zone, passing("Alice two"));
  // A card whose only claim is not in its source carries no ✓, so it does not count towards the three.
  const unverified = await userCard(alice, zone, cardInput("Alice no check", { claims: [cardInput("x").claims[1]] }));
  const { get, text } = await serve(t, { config: { evidencePublicIndexable: true } });
  const robots = async (path) => { const response = await get(path); const body = await response.text(); return { status: response.status, header: response.headers.get("x-robots-tag"), meta: /<meta name="robots" content="noindex">/.test(body) }; };
  assert.deepEqual(await robots(`/evidence/z/${official.id}`), { status: 200, header: null, meta: false }, "an official zone is exempt");
  assert.deepEqual(await robots(`/evidence/c/${officialOne.id}`), { status: 200, header: null, meta: false });
  assert.deepEqual(await robots("/evidence/"), { status: 200, header: null, meta: false });
  for (const path of [`/evidence/z/${zone.id}`, `/evidence/c/${first.id}`, `/evidence/c/${second.id}`, `/evidence/c/${unverified.id}`, "/evidence/a/alice"]) {
    assert.deepEqual(await robots(path), { status: 200, header: "noindex", meta: true }, `${path}: two cards with a ✓ is a new author: it opens, but is noindex`);
  }
  let sitemap = (await text("/evidence/sitemap.xml")).body;
  assert.ok(sitemap.includes(`/evidence/z/${official.id}`) && sitemap.includes(`/evidence/c/${officialOne.id}`));
  for (const id of [zone.id, first.id, second.id, "alice"]) assert.equal(sitemap.includes(id), false, `${id} is not in the sitemap while the author is new`);
  // The third card with a ✓ lifts it, by itself, with no one doing anything.
  const third = await userCard(alice, zone, passing("Alice three"));
  for (const path of [`/evidence/z/${zone.id}`, `/evidence/c/${first.id}`, `/evidence/c/${third.id}`, "/evidence/a/alice"]) {
    assert.deepEqual(await robots(path), { status: 200, header: null, meta: false }, `${path}: lifted at three`);
  }
  sitemap = (await text("/evidence/sitemap.xml")).body;
  for (const id of [zone.id, first.id, second.id, third.id, "/evidence/a/alice"]) assert.ok(sitemap.includes(id), `${id} is in the sitemap`);
  assert.equal(sitemap.includes(unverified.id), true, "every published card of a qualifying author is listed");
  // A withdrawn card is never indexed and never listed, whoever wrote it; its page stays.
  await db.query(`UPDATE evimed_frontier.evidence_cards SET withdrawn = jsonb_build_object('at', '2026-10-04T00:00:00Z', 'reason', 'wrong', 'changeLogId', '1') WHERE id = $1`, [officialOne.id]);
  const withdrawn = await get(`/evidence/c/${officialOne.id}`);
  assert.equal(withdrawn.status, 410);
  assert.equal(withdrawn.headers.get("x-robots-tag"), "noindex");
  assert.match(await withdrawn.text(), /<meta name="robots" content="noindex">/);
  assert.equal((await text("/evidence/sitemap.xml")).body.includes(officialOne.id), false);
  assert.deepEqual(await robots("/evidence/requests"), { status: 200, header: "noindex", meta: true }, "a list of reader-written titles is never indexed");
  // The markup of an indexable page: lang, title, description, canonical, no structured data.
  const page = (await text(`/evidence/z/${zone.id}`)).body;
  assert.match(page, /<html lang="zh-CN">/);
  assert.match(page, /<title>User zone|Alice's zone · EviMed 证据中心<\/title>|<title>Alice&#39;s zone · EviMed 证据中心<\/title>/);
  assert.match(page, /<meta name="description" content="[^"]+">/);
  assert.ok(page.includes(`<link rel="canonical" href="${PUBLIC_URL}/evidence/z/${zone.id}">`));
  for (const forbidden of ["ld+json", "itemscope", "schema.org", "llms"]) assert.equal(page.includes(forbidden), false, forbidden);
});

test("a withdrawn card keeps its page: 410, the reason and date, the link to its change-log entry, noindex, no claims — and it is not counted as read", options, async (t) => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  const card = await userCard(alice, zone, cardInput("Withdrawn card"));
  const log = createEvidenceChangeLog({ database: db });
  const entry = await log.append({ zoneId: zone.id, cardId: card.id, category: "withdrawal", trigger: "challenge", facts: { claimId: "CLM-001", cardWithdrawn: true }, revisionBefore: 1, revisionAfter: 2 });
  await db.query(`UPDATE evimed_frontier.evidence_cards SET withdrawn = $2::jsonb, currency = 'no_longer_updated', retired_at = clock_timestamp() WHERE id = $1`,
    [card.id, JSON.stringify({ at: "2026-10-04T08:00:00.000Z", reason: "引文与来源不符，已撤回", changeLogId: entry.id })]);
  const { text, get } = await serve(t);
  const answer = await text(`/evidence/c/${card.id}`);
  assert.equal(answer.status, 410);
  assert.equal(answer.headers.get("x-robots-tag"), "noindex");
  assert.ok(answer.body.includes("引文与来源不符，已撤回") && answer.body.includes("2026-10-04"));
  assert.ok(answer.body.includes(`href="/evidence/z/${zone.id}/changes?before=${Number(entry.id) + 1}#log-${entry.id}"`), "it links to the log entry that records it");
  assert.equal(answer.body.includes("Stroke was less frequent"), false, "nothing it said stands");
  assert.equal(answer.body.includes("7 had a stroke"), false);
  // The linked entry is on the page the link names, with its sentence and trigger.
  const logPage = (await text(`/evidence/z/${zone.id}/changes?before=${Number(entry.id) + 1}`)).body;
  assert.ok(logPage.includes(`id="log-${entry.id}"`) && logPage.includes("撤回"));
  // The zone page lists it, marked; the API answers 410 with the envelope and the reason.
  assert.ok((await text(`/evidence/z/${zone.id}`)).body.includes("已撤回"));
  const api = await get(`/evidence/api/v1/cards/${card.id}`);
  assert.equal(api.status, 410);
  const body = await api.json();
  assert.equal(body.data.card.withdrawn.reason, "引文与来源不符，已撤回");
  assert.equal(body.error.code, "evidence_public_card_withdrawn");
  assert.deepEqual(body.data.card.claimList, []);
  assert.deepEqual((await pageReads(db, { cardIds: [card.id], since: "2000-01-01" })), [], "a withdrawn card's page is not a read");
});

test("the change log page lists date, what changed, why and what triggered it, pages by `before`, and names only public cards", options, async (t) => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  const open = await userCard(alice, zone, cardInput("Public card"));
  const draft = await userCard(alice, zone, cardInput("Card since taken back to a draft"));
  await db.query("UPDATE evimed_frontier.evidence_cards SET state='draft' WHERE id=$1", [draft.id]);
  const log = createEvidenceChangeLog({ database: db });
  const entries = [];
  for (const [index, category] of ["searched_no_change", "correction", "new_evidence_conclusion_changed"].entries()) {
    entries.push(await log.append({ zoneId: zone.id, cardId: index === 1 ? draft.id : open.id, category, trigger: index === 1 ? "challenge" : "scheduled_check", facts: { claimId: "CLM-001" } }));
  }
  const { text } = await serve(t);
  const page = (await text(`/evidence/z/${zone.id}/changes`)).body;
  for (const entry of entries) assert.ok(page.includes(`id="log-${entry.id}"`));
  assert.ok(page.includes("已重新检索，结论未变") && page.includes("更正") && page.includes("有新研究，结论改变"));
  assert.ok(page.includes("读者质疑") || page.includes("质疑"), "the trigger is named");
  assert.ok(page.includes("Public card"));
  assert.equal(page.includes("Card since taken back to a draft"), false, "a log entry must not be a way to read a title that is not public");
  assert.ok(page.indexOf(`log-${entries[2].id}`) < page.indexOf(`log-${entries[0].id}`), "newest first");
  const api = json(await text(`/evidence/api/v1/zones/${zone.id}/changes?limit=2`));
  assert.deepEqual(api.data.changes.map((entry) => entry.id), [entries[2].id, entries[1].id]);
  assert.equal(api.meta.next, entries[1].id);
  const next = json(await text(`/evidence/api/v1/zones/${zone.id}/changes?limit=2&before=${api.meta.next}`));
  assert.deepEqual(next.data.changes.map((entry) => entry.id), [entries[0].id]);
  assert.equal(next.meta.next, undefined);
  assert.equal((await text(`/evidence/api/v1/zones/${zone.id}/changes?limit=0`)).status, 400);
  assert.equal(JSON.stringify(api).includes("refs"), false, "the log's internal references stay inside");
});

test("an author page: public zones and cards only, followers, times cited by research, change records, and the people a producer names", options, async (t) => {
  const zone = await userZone(alice, { kind: "product", title: "Acme zone" });
  const closed = await userZone(alice, { internet: false, title: "Platform-only zone" });
  const card = await userCard(alice, zone, cardInput("Acme card", productFields), "geo");
  await userCard(alice, closed, cardInput("Card in the platform-only zone"));
  await zones.act(bob, zone.id, "follow", { expectedRevision: zone.revision });
  await db.query("INSERT INTO evimed_frontier.evidence_card_runs(user_id,project_id,run_id,card_id) VALUES('bob','p','r1',$1),('carol','p','r2',$1),('alice','p','r3',$1)", [card.id]);
  await createEvidenceChangeLog({ database: db }).append({ zoneId: zone.id, cardId: card.id, category: "correction", trigger: "challenge", facts: {} });
  const { text } = await serve(t);
  const answer = await text("/evidence/a/alice");
  assert.equal(answer.status, 200);
  const body = answer.body;
  assert.ok(body.includes("Acme zone") && body.includes("Acme card"));
  assert.equal(body.includes("Platform-only zone") || body.includes("Card in the platform-only zone"), false, "a platform-visible zone is not on the public page");
  assert.match(body, /<dt>关注者<\/dt><dd>1<\/dd>/);
  assert.match(body, /<dt>被研究引用<\/dt><dd>2 次/, "other accounts' runs from the author's cards, not the author's own");
  assert.match(body, /<dt>公开的证据卡<\/dt><dd>1<\/dd>/);
  assert.ok(body.includes("企业 Acme Pharma"), "an enterprise producer's record");
  assert.ok(body.includes("Dr. Li，PUMCH，主任医师"), "the people the producer names, with affiliation and title");
  assert.ok(body.includes("更正") === false || body.includes("读者对"), "the recent change records are listed");
  const api = json(await text("/evidence/api/v1/authors/alice"));
  assert.deepEqual(api.data.author.totals, { cards: 1, followers: 1, runsFromCards: 2 });
  assert.deepEqual(api.data.author.zones.map((zoneEntry) => zoneEntry.id), [zone.id]);
  assert.equal(api.data.author.changes.length, 1);
});

test("the AI label: a card an AI wrote carries the visible label and the implicit metadata; one it did not, neither", options, async (t) => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  const ai = await userCard(alice, zone, passing("AI card", { disclosure: { model: "deepseek-v4-flash", modelVersion: "2026-09", aiSteps: ["search", "extract", "synthesize"], generatedAt: "2026-10-01T00:00:00Z", lastCheckedAt: "2026-10-02T00:00:00Z" } }), "model");
  const human = await userCard(alice, zone, passing("Human card"));
  const { text } = await serve(t);
  const page = (await text(`/evidence/c/${ai.id}`)).body;
  assert.match(page, /<h1>AI card <span class="badge ai">AI 生成<\/span><\/h1>/);
  const meta = /<meta name="AIGC" content="([^"]+)">/.exec(page);
  assert.ok(meta);
  const label = JSON.parse(meta[1].replaceAll("&quot;", '"'));
  assert.deepEqual(Object.keys(label), ["Label", "ContentProducer", "ProduceID", "ReserveCode1", "ContentPropagator", "PropagateID", "ReserveCode2"]);
  assert.equal(label.Label, "1");
  assert.equal(label.ProduceID, `${ai.id}@1`);
  assert.ok(page.includes("检索、抽取、综合") && page.includes("deepseek-v4-flash 2026-09"));
  const plain = (await text(`/evidence/c/${human.id}`)).body;
  assert.equal(plain.includes("AI 生成"), false);
  assert.equal(plain.includes('name="AIGC"'), false);
  // The list and the API say it too.
  assert.ok((await text(`/evidence/z/${zone.id}`)).body.includes('<span class="badge ai">AI 生成</span>'));
  assert.equal(json(await text(`/evidence/api/v1/cards/${ai.id}`)).data.card.aiGenerated, true);
});

test("the simulations column reads an injected reader, shows every number with its value source and the fixed banner, and says it is empty with no reader", options, async (t) => {
  const records = [
    { id: "sim-1", title: "Simulated <trial>", summary: "A model run.", createdAt: "2026-10-03T00:00:00Z", numbers: [{ label: "Hazard ratio", value: 0.8, unit: "", valueSource: "predicted" }, { label: "Arm size", value: 400, valueSource: "assumed" }, { label: "Mystery", value: 7 }], assumptions: ["Constant hazard"], limitations: "Synthetic only." },
    { id: "sim-2", title: "Second run", createdAt: "2026-10-02T00:00:00Z" },
  ];
  const calls = [];
  const reader = { list: async (query) => { calls.push(query); return { items: records, next: null }; }, get: async (id) => records.find((record) => record.id === id) ?? null };
  const { text } = await serve(t, { simulations: reader });
  const list = await text("/evidence/simulations");
  assert.equal(list.status, 200);
  assert.ok(list.body.includes("模拟研究的结果是模拟，不是证据"));
  assert.ok(list.body.includes("Simulated &lt;trial&gt;") && list.body.includes("Second run"));
  assert.deepEqual(calls[0], { limit: 20, before: null });
  const detail = (await text("/evidence/simulations/sim-1")).body;
  assert.ok(detail.includes("模拟研究的结果是模拟，不是证据"));
  assert.match(detail, /<td>Hazard ratio<\/td><td class="num">0\.8<\/td><td>预测<\/td>/);
  assert.match(detail, /<td>Arm size<\/td><td class="num">400<\/td><td>假设<\/td>/);
  assert.match(detail, /<td>Mystery<\/td><td class="num">7<\/td><td>来源未标注<\/td>/);
  assert.equal((await text("/evidence/simulations/missing")).status, 404);
  assert.equal((await text("/evidence/simulations/bad id!")).status, 404);
  const empty = await serve(t, { simulations: null });
  const none = await empty.text("/evidence/simulations");
  assert.equal(none.status, 200);
  assert.ok(none.body.includes("没有公开的模拟研究") && none.body.includes("模拟研究的结果是模拟，不是证据"));
  assert.equal((await empty.text("/evidence/simulations/sim-1")).status, 404);
});

test("the monthly page shows the last twelve months that have data, a month without data says so, and the figures are shared and cached", options, async (t) => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  await userCard(alice, zone, cardInput("Card"));
  let clock = new Date("2026-12-15T04:00:00Z");
  /** @type {string[]} */ const computed = [];
  const figures = async ({ month }) => {
    computed.push(month);
    const has = month === "2026-10";
    return { month, verification: { cards: has ? 2 : 0, claims: has ? 8 : 0, verified: has ? 6 : 0, passRate: has ? 0.75 : null }, corrections: { entries: 0, medianLatencyHours: null }, challenges: { filed: 0, upheld: 0, amended: 0, withdrawn: 0, open: 0, upheldShare: null } };
  };
  const metrics = createEvidencePublicMetrics({ database: db, now: () => clock, figures });
  const { text } = await serve(t, { now: () => clock, metrics });
  const [a, b] = await Promise.all([text("/evidence/metrics"), text("/evidence/metrics")]);
  assert.equal(a.status, 200);
  assert.ok(a.body.includes("75%") && a.body.includes("6 / 8 条结论"));
  assert.match(a.body, /2026-12<\/td><td colspan="3" class="muted">这个月没有数据。/);
  assert.match(a.body, /2026-11<\/td><td colspan="3" class="muted">这个月没有数据。/);
  assert.equal(/0%/.test(a.body.replace(/75%|100%|10%/g, "")), false, "a month with no data is never shown as 0");
  assert.equal(computed.length, 3, "three months, built once for both requests that arrived together");
  assert.equal(b.body, a.body);
  await text("/evidence/metrics");
  assert.equal(computed.length, 3, "answered from the cache");
  clock = new Date(clock.getTime() + 11 * 60_000);
  await text("/evidence/metrics");
  assert.equal(computed.length, 6, "recomputed once the cache is ten minutes old");
  const api = json(await text("/evidence/api/v1/metrics"));
  assert.deepEqual(api.data.months.map((month) => [month.month, month.hasData]), [["2026-12", false], ["2026-11", false], ["2026-10", true]]);
  // The real computation, over the tables, gives this month's verification: one of two claims found in its source.
  const real = createEvidencePublicMetrics({ database: db });
  const months = await real.months();
  assert.equal(months[0].data, true);
  assert.equal(months[0].figures.verification.passRate, 0.5);
});

test("the read-only API: the envelope, the kinds filter, a cursor, an ETag answered 304, CORS on GET only, no cookie, and the same 404 for anything not public", options, async (t) => {
  const official = await officialZone();
  const product = await userZone(alice, { kind: "product", title: "Product zone" });
  const user = await userZone(bob, { title: "User zone" });
  await userCard(alice, product, cardInput("Product card", productFields), "geo");
  const cards = [];
  for (let index = 0; index < 3; index += 1) cards.push(await officialCard(official, cardInput(`Official ${index}`)));
  const { get, text } = await serve(t, { now: () => new Date("2026-10-06T00:00:00Z") });
  const response = await get("/evidence/api/v1/zones?kind=official");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("set-cookie"), null);
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["data", "meta"]);
  assert.deepEqual(body.meta, { generatedAt: "2026-10-06T00:00:00.000Z" });
  assert.deepEqual(body.data.zones.map((zone) => [zone.id, zone.kind]), [[official.id, "official"]]);
  assert.equal(body.data.zones[0].url, `${PUBLIC_URL}/evidence/z/${official.id}`);
  const again = await get("/evidence/api/v1/zones?kind=official", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);
  assert.equal(again.headers.get("cache-control"), "public, max-age=300");
  assert.equal(await again.text(), "");
  const all = json(await text("/evidence/api/v1/zones"));
  assert.deepEqual(all.data.zones.map((zone) => zone.kind), ["official", "product", "user"], "official, product and user, in that order, never merged");
  assert.deepEqual(all.data.zones.map((zone) => zone.id).sort(), [official.id, product.id, user.id].sort());
  assert.equal((await text("/evidence/api/v1/zones?kind=paid")).status, 400);
  assert.equal(json(await text("/evidence/api/v1/zones?kind=paid")).code, "evidence_public_query_invalid");
  const one = json(await text(`/evidence/api/v1/zones/${official.id}`));
  assert.equal(one.data.zone.cards, 3);
  const first = json(await text(`/evidence/api/v1/zones/${official.id}/cards?limit=2`));
  assert.equal(first.data.cards.length, 2);
  assert.ok(first.meta.next);
  const second = json(await text(`/evidence/api/v1/zones/${official.id}/cards?limit=2&cursor=${first.meta.next}`));
  assert.equal(second.data.cards.length, 1);
  assert.equal(second.meta.next, undefined);
  assert.deepEqual([...first.data.cards, ...second.data.cards].map((card) => card.id), cards.map((card) => card.id).reverse(), "newest first across pages");
  assert.equal((await text(`/evidence/api/v1/zones/${official.id}/cards?cursor=garbage`)).status, 400);
  assert.equal((await text(`/evidence/api/v1/zones/${official.id}/cards?limit=51`)).status, 400);
  const card = json(await text(`/evidence/api/v1/cards/${cards[0].id}`));
  assert.equal(card.data.card.view, "clinical");
  assert.deepEqual(card.data.card.claims, { total: 2, verified: 1, derived: 0, warned: 1 });
  assert.equal(card.data.card.claimList[0].mark, "✓");
  assert.equal(JSON.stringify(card).includes(SENTINEL), false, "no source text in the API either");
  assert.equal(JSON.stringify(card).includes("documentText"), false);
  assert.equal(json(await text(`/evidence/api/v1/cards/${cards[0].id}?view=public`)).data.card.view, "public");
  assert.equal((await text(`/evidence/api/v1/cards/${cards[0].id}?view=x`)).status, 400);
  assert.equal((await text("/evidence/api/v1/nothing")).status, 404);
  assert.equal((await text("/evidence/api/v1")).status, 404);
  const post = await get("/evidence/api/v1/zones", { method: "POST", body: "{}" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("access-control-allow-origin"), null, "CORS only where it is a GET");
});

test("page reads: one per GET of a card or zone page, none for a program or a HEAD, and `pageReads` returns them", options, async (t) => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  const card = await userCard(alice, zone, cardInput("Card"));
  const other = await userCard(alice, zone, cardInput("Other card"));
  const { get } = await serve(t, { now: () => new Date("2026-10-06T04:00:00Z") });
  const read = async (path, init) => { const response = await get(path, init); await response.arrayBuffer(); return response.status; };
  for (let i = 0; i < 3; i += 1) assert.equal(await read(`/evidence/c/${card.id}`), 200);
  assert.equal(await read(`/evidence/c/${other.id}`), 200);
  assert.equal(await read(`/evidence/z/${zone.id}`), 200);
  assert.equal(await read(`/evidence/z/${zone.id}`), 200);
  assert.equal(await read(`/evidence/c/${card.id}`, { agent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }), 200);
  assert.equal(await read(`/evidence/c/${card.id}`, { agent: "curl/8.0" }), 200);
  assert.equal(await read(`/evidence/c/${card.id}`, { method: "HEAD" }), 200);
  assert.equal(await read("/evidence/about"), 200, "a page that is neither a card nor a zone is not counted");
  assert.equal(await read("/evidence/c/ec_0000000000000000"), 404, "nor is a page that does not exist");
  assert.deepEqual(await pageReads(db, { cardIds: [card.id, other.id], since: "2026-10-01" }), [{ zoneId: zone.id, cardId: card.id, reads: 3 }, { zoneId: zone.id, cardId: other.id, reads: 1 }].sort((a, b) => a.cardId.localeCompare(b.cardId)));
  const zoneRows = await pageReads(db, { zoneIds: [zone.id], since: new Date("2026-10-06T00:00:00Z") });
  assert.deepEqual(zoneRows.find((entry) => entry.cardId === null), { zoneId: zone.id, cardId: null, reads: 2 }, "a zone page's own reads are the row with no card");
  assert.deepEqual(zoneRows.map((entry) => entry.reads).sort(), [1, 2, 3]);
  assert.deepEqual(await pageReads(db, { zoneIds: [zone.id], since: "2026-10-07" }), [], "since is a floor");
  assert.deepEqual(await pageReads(db, { zoneIds: ["ez_other"], since: "2026-10-01" }), []);
  const row = (await db.query("SELECT day::text AS day, reads FROM evimed_frontier.evidence_page_reads WHERE card_id=$1", [card.id])).rows[0];
  assert.deepEqual(row, { day: "2026-10-06", reads: 3 }, "one row per card and day, in the platform's own day");
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='evimed_frontier' AND table_name='evidence_page_reads' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["zone_id", "card_id", "day", "reads"], "no address, no user agent, no cookie is kept");
  await assert.rejects(pageReads(db, { since: "yesterday" }), TypeError);
});

test("topic requests: one vote per account, a repeat of the same words is a vote for the same request, the list orders by distinct requesters, and a daily limit stops a flood", options, async (t) => {
  const official = await officialZone("Official zone");
  const requests = createEvidenceTopicRequests({ database: db, config: { evidenceTopicRequestsPerDay: 3 } });
  const first = await requests.file(alice, { title: "  Apixaban   vs rivaroxaban in elderly AF ", zoneId: official.id });
  assert.equal(first.filed, true);
  assert.equal(first.request.requesters, 1);
  assert.equal(first.request.zoneId, official.id);
  const again = await requests.file(alice, { title: "Apixaban vs rivaroxaban in elderly AF" });
  assert.equal(again.alreadySeconded, true, "one vote per account");
  assert.equal(again.request.requesters, 1);
  const repeated = await requests.file(bob, { title: "APIXABAN vs RIVAROXABAN in elderly AF" });
  assert.equal(repeated.filed, false, "the same words are the same request");
  assert.equal(repeated.request.id, first.request.id);
  assert.equal(repeated.request.requesters, 2);
  const popular = await requests.file(bob, { title: "SGLT2 inhibitors and CKD progression" });
  await requests.second(carol, popular.request.id);
  await requests.second(alice, popular.request.id);
  assert.equal((await requests.second(alice, popular.request.id)).alreadySeconded, true);
  const list = await topicRequestCounts(db, { limit: 10 });
  assert.deepEqual(list.map((item) => [item.title, item.requesters]), [["SGLT2 inhibitors and CKD progression", 3], ["Apixaban vs rivaroxaban in elderly AF", 2]], "most distinct requesters first");
  // A tie goes to the request filed first.
  await requests.file(carol, { title: "Colchicine after myocardial infarction" });
  await requests.second(bob, (await topicRequestCounts(db, { limit: 10 })).find((item) => item.title.startsWith("Colchicine")).id);
  assert.deepEqual((await topicRequestCounts(db, { limit: 10 })).map((item) => item.requesters), [3, 2, 2]);
  assert.equal((await topicRequestCounts(db, { limit: 10 }))[1].title, "Apixaban vs rivaroxaban in elderly AF", "equal counts: the earlier request is first");
  // Invalid input is refused by name and writes nothing.
  for (const body of [{ title: "abc" }, { title: "x".repeat(201) }, { title: "bad\u0007control" }, { title: 5 }, {}, { title: "A fine title", extra: 1 }, { title: "A fine title", zoneId: "not-a-zone" }, { title: "A fine title", zoneId: "ez_0000000000000000" }, null, []]) {
    await assert.rejects(requests.file(alice, /** @type {any} */ (body)), { code: "evidence_topic_request_invalid", status: 400 }, JSON.stringify(body));
  }
  await assert.rejects(requests.second(alice, "tr_" + "0".repeat(32)), { code: "evidence_topic_request_not_found", status: 404 });
  await assert.rejects(requests.second(alice, "garbage"), { code: "evidence_topic_request_not_found" });
  // Alice has voted three times today (first, popular's second ×1; the repeats were free): she has one left, then none.
  const used = Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_topic_request_votes WHERE user_id='alice'")).rows[0].n);
  assert.equal(used, 2);
  await requests.file(alice, { title: "A third topic from Alice" });
  const before = Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_topic_requests")).rows[0].n);
  await assert.rejects(requests.file(alice, { title: "A fourth topic from Alice" }), { code: "evidence_topic_request_limit", status: 429 });
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_topic_requests")).rows[0].n), before, "a refused request leaves no row behind");
  assert.equal((await requests.file(alice, { title: "A third topic from Alice" })).alreadySeconded, true, "repeating a vote already given is never over the limit");
  const mine = await requests.list({ userId: "alice" });
  assert.equal(mine.remainingToday, 0);
  assert.equal(mine.seconded.length, 3);
  assert.equal(requests.stats().refusedLimit, 1);
  assert.equal(requests.stats().refusedInvalid, 10, "every invalid body was counted");
  // Concurrent filing by one account cannot pass the ceiling together.
  await db.query("DELETE FROM evimed_frontier.evidence_topic_request_votes WHERE user_id='carol'");
  const burst = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => requests.file(carol, { title: `Concurrent topic number ${n}` })));
  assert.equal(burst.filter((result) => result.status === "fulfilled").length, 3, "three votes a day, however many arrive at once");
  // The page: the list in order with the requesters, titles escaped, never indexed, and the page says filing needs an account.
  const wide = createEvidenceTopicRequests({ database: db, config: { evidenceTopicRequestsPerDay: 50 } });
  await wide.file(bob, { title: "<script>alert(1)</script> topic" });
  const { text } = await serve(t, { requests: wide });
  const page = await text("/evidence/requests");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("&lt;script&gt;alert(1)&lt;/script&gt; topic"));
  assert.equal(/<script>alert/.test(page.body), false);
  assert.ok(page.body.indexOf("SGLT2 inhibitors") < page.body.indexOf("Colchicine after"), "the page is in the list's order");
  assert.ok(page.body.includes("2 人申请"), "the number of distinct requesters is on each row");
  assert.ok(page.body.includes("申请和附议需要登录"));
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  assert.match(page.body, /指向专区：<a href="\/evidence\/z\/ez_/);
  assert.equal(normalizeTopicTitle("Ｆｕｌｌｗｉｄｔｈ　topic"), "Fullwidth topic", "NFKC folds width, a format fold");
});

test("the router limits an address per minute: a page gets 429 with Retry-After and noindex, the API gets the JSON refusal, and each is counted", options, async (t) => {
  const official = await officialZone();
  const { HttpError } = await import("../src/security.mjs");
  let allowed = 2;
  const real = () => { if (allowed-- > 0) return; throw new HttpError(429, "rate_limited", "Too many requests.", { retryAfterSeconds: 42 }); };
  const { get, routes } = await serve(t, { limiter: real });
  assert.equal((await get("/evidence/")).status, 200);
  assert.equal((await get(`/evidence/z/${official.id}`)).status, 200);
  const limited = await get("/evidence/about");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  assert.equal(limited.headers.get("x-robots-tag"), "noindex");
  assert.ok((await limited.text()).includes("访问太频繁"));
  const api = await get("/evidence/api/v1/zones");
  assert.equal(api.status, 429);
  assert.equal((await api.json()).code, "evidence_public_rate_limited");
  assert.equal(api.headers.get("retry-after"), "42");
  assert.equal(routes.stats().rateLimited, 2);
  const families = evidencePublicMetricFamilies(routes.stats());
  const refusals = families.find((family) => family.name === "open_science_evidence_public_refusals_total");
  assert.equal(refusals.series.find((series) => series.labels.reason === "rate_limited").value, 2);
  assert.ok(families.some((family) => family.name === "open_science_evidence_public_page_reads_total"));
  assert.deepEqual(evidencePublicMetricFamilies(null), []);
});

test("the migration is idempotent on a database that already holds earlier evidence data, and creates the three tables", options, async () => {
  const zone = await userZone(alice, { title: "Alice's zone" });
  await userCard(alice, zone, cardInput("Card"));
  await db.query("DROP TABLE evimed_frontier.evidence_topic_request_votes; DROP TABLE evimed_frontier.evidence_topic_requests; DROP TABLE evimed_frontier.evidence_page_reads;");
  await db.query(EVIDENCE_ZONE_SQL);
  await db.query(EVIDENCE_ZONE_SQL);
  await migrateEvidenceZones(db);
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='evimed_frontier' AND table_name LIKE 'evidence_%' ORDER BY table_name")).rows.map((row) => row.table_name);
  for (const table of ["evidence_page_reads", "evidence_topic_requests", "evidence_topic_request_votes"]) assert.ok(tables.includes(table), table);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_cards")).rows[0].n), 1, "the earlier data is untouched");
  // The topic-request key is the folded title, so two spellings of one title cannot both be rows.
  await db.query("INSERT INTO evimed_frontier.evidence_topic_requests(id,title,title_key) VALUES('tr_a','One title','one title')");
  await assert.rejects(db.query("INSERT INTO evimed_frontier.evidence_topic_requests(id,title,title_key) VALUES('tr_b','one TITLE','one title')"), { code: "23505" });
});

test("an account's export carries the topic requests it filed or seconded, and no one else's", options, async () => {
  const requests = createEvidenceTopicRequests({ database: db, config: { evidenceTopicRequestsPerDay: 5 } });
  await requests.file(alice, { title: "Apixaban after a bleed" });
  const popular = await requests.file(bob, { title: "SGLT2 inhibitors in heart failure" });
  await requests.second(alice, popular.request.id);
  const archive = async (user) => {
    const created = (await db.query("SELECT created_at::text AS value FROM evimed_control.users WHERE id=$1", [user.id])).rows[0].value;
    return withAccountExportSnapshot(db, { ...user, accountCreatedAt: created }, {}, async (snapshot) => JSON.parse(snapshot.data.toString()));
  };
  const mine = await archive(alice);
  assert.deepEqual(mine.evidenceTopicRequestVotes.map((vote) => vote.title).sort(), ["Apixaban after a bleed", "SGLT2 inhibitors in heart failure"]);
  assert.deepEqual((await archive(bob)).evidenceTopicRequestVotes.map((vote) => vote.title), ["SGLT2 inhibitors in heart failure"]);
  assert.deepEqual((await archive(carol)).evidenceTopicRequestVotes, []);
});
