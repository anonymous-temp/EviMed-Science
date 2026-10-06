// The community column of an official zone against a real PostgreSQL (evidence-flywheel F07, 2026-10-06): which cards of other zones it lists, the
// new-author boundary at exactly three ✓ cards, the order from the contract's ranking inputs, and the route's door.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { COMMUNITY_MAX_CARDS_CEILING, createEvidenceCommunity, createEvidenceCommunityRoutes, evidenceCommunityMetricFamilies } from "../src/evidenceCommunity.mjs";
import { establishedAuthors } from "../src/evidenceVerifiedCards.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const publisher = { id: "publisher" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const found = { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" };
const found2 = { claimId: "CLM-002", claimType: "direct", claim: "Usual care had more strokes.", sourceIndexes: [1], supportQuote: "Among 100 adults on usual care, 12 had a stroke" };
const lost = { claimId: "CLM-003", claimType: "direct", claim: "Nobody died.", sourceIndexes: [1], supportQuote: "No one died in either group" };
const KEYS = ["disease:atrial-fibrillation", "drug:apixaban"];

const card = (title, claims, extra = {}) => ({
  title, subtype: "academic", summary: `${title} summary.`, body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen." }, claims, entityKeys: KEYS, ...extra,
});

/** @type {any} */ let isolated, db, zones, official;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "community");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('publisher','EviMed 证据中心','development'),('reader','Reader','development'),('alice','Alice Li','development'),('bob','Bob','development'),('carol','Carol','development'),('dave','Dave','development'),('erin','Erin','development'),('frank','Frank','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  const made = (await zones.saveEditorial(publisher, { title: "房颤抗凝", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, card("Official card", [found], { entityKeys: [...KEYS, "org:fda"] }), official.id, null, true, "programme");
});

/** A user zone, published and (by default) opened to the internet. */
async function userZone(userId, { internet = true, kind = /** @type {string | undefined} */ (undefined), title = `${userId}'s zone` } = {}) {
  const user = { id: userId };
  const { zone } = await zones.save(user, { title, description: "d", background: "b", ...(kind ? { kind } : {}) });
  const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  return internet ? (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone : live;
}
const put = (userId, zone, input, origin = "owner") => zones.saveEditorial({ id: userId }, input, zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);
/** An author with `n` ✓ cards in one open zone. */
async function establishedAuthor(userId, n = 3, claims = [found], extra = {}) {
  const zone = await userZone(userId);
  const cards = [];
  for (let index = 1; index <= n; index += 1) cards.push(await put(userId, zone, card(`${userId} card ${index}`, claims, extra), "result"));
  return { zone, cards };
}
const community = (extra = {}) => createEvidenceCommunity({ database: db, platformPublisherUserId: "publisher", ...extra });

test("an established author's public card on the zone's subject is listed, signed, with its verified share and its shared keys", options, async () => {
  const { cards } = await establishedAuthor("alice");
  const column = await community().forZone(official.id);
  assert.deepEqual(column?.entityKeys, KEYS, "organisations are not a subject");
  assert.equal(column?.items.length, 3);
  const item = column?.items.find((entry) => entry.id === cards[0].id);
  assert.equal(item?.author.name, "Alice Li");
  assert.equal(item?.author.id, "alice", "the account id by default; publicAuthorId is the one place it becomes an opaque id");
  assert.deepEqual(item?.claims, { total: 1, verified: 1 });
  assert.equal(item?.verifiedShare, 1);
  assert.deepEqual(item?.sharedKeys, KEYS);
  assert.equal(item?.zoneTitle, "alice's zone");
  assert.equal("ranking" in (item ?? {}), false, "the order's inputs are not part of what is shown");
  const opaque = await community({ publicAuthorId: (id) => `a_${id.length}` }).forZone(official.id);
  assert.equal(opaque?.items[0].author.id, "a_5");
});

test("the new-author boundary is exactly three published cards that each carry a ✓: two are held back, a third lists all three, a ⚠-only card does not count", options, async () => {
  const { zone } = await establishedAuthor("bob", 2);
  await put("bob", zone, card("bob card ⚠", [lost]), "result");
  const held = await community().forZone(official.id);
  assert.deepEqual(held?.items, [], "two ✓ cards and one ⚠ card: not yet");
  assert.deepEqual([...(await establishedAuthors(db, ["bob"]))], []);
  await put("bob", zone, card("bob card 3", [found]), "result");
  const listed = await community().forZone(official.id);
  assert.deepEqual(listed?.items.map((entry) => entry.title).sort(), ["bob card 1", "bob card 2", "bob card 3", "bob card ⚠"], "the third ✓ lifts the rule by itself, and the author's other cards on the subject come with it");
  assert.deepEqual([...(await establishedAuthors(db, ["bob", "alice"]))], ["bob"]);
  const stats = community().stats();
  assert.equal(stats.heldBackNewAuthors, 0);
});

test("what is never listed: product zones, platform-visible zones, drafts, withdrawn cards, other subjects, the platform's own cards, the official zone itself", options, async () => {
  await establishedAuthor("alice");
  const product = await userZone("carol", { kind: "product", title: "Carol's product zone" });
  const productFields = { producer: { kind: "enterprise", name: "Acme", relation: "own_product", products: ["Drug A"] }, journeyStage: { key: "treatment-choice", label: "治疗选择" },
    disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH", title: "主任医师" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] } };
  for (let index = 1; index <= 4; index += 1) await put("carol", product, card(`carol product ${index}`, [found], productFields));
  const closed = await userZone("dave", { internet: false, title: "Dave, platform only" });
  for (let index = 1; index <= 4; index += 1) await put("dave", closed, card(`dave closed ${index}`, [found]), "result");
  const { cards: erin } = await establishedAuthor("erin", 5);
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=jsonb_build_object('at',now(),'reason','r') WHERE id=$1", [erin[0].id]);
  await db.query("UPDATE evimed_frontier.evidence_cards SET entity_keys='{drug:metformin}' WHERE id=$1", [erin[1].id]);
  await db.query("UPDATE evimed_frontier.evidence_cards SET state='draft' WHERE id=$1", [erin[2].id]);
  const column = await community().forZone(official.id);
  const titles = column?.items.map((entry) => entry.title).sort();
  assert.deepEqual(titles, ["alice card 1", "alice card 2", "alice card 3", "erin card 4", "erin card 5"], "erin lost three of five cards to a withdrawal, another subject and a draft; the card on another subject still counts toward being established");
  assert.ok(!titles?.some((title) => /Official|carol|dave/.test(title)));
});

test("the order reads the ranking inputs and nothing else: verified share first, then the readers' score of the current revision, then recency", options, async () => {
  const half = await establishedAuthor("alice", 3, [found, lost]);
  const whole = await establishedAuthor("bob", 3, [found, found2]);
  // Alice's cards hold 1 of 2 claims; Bob's hold both. Within Bob's, readers' scores decide.
  await db.query("INSERT INTO evimed_frontier.evidence_reviews(card_id,user_id,card_revision,score,text) VALUES($1,'reader',$2,5,'good'),($3,'reader',$4,2,'poor')",
    [whole.cards[1].id, whole.cards[1].revision, whole.cards[0].id, whole.cards[0].revision]);
  // A score for an earlier revision of a card is not its current score.
  await db.query("INSERT INTO evimed_frontier.evidence_reviews(card_id,user_id,card_revision,score,text) VALUES($1,'reader',$2,5,'old')", [whole.cards[2].id, whole.cards[2].revision + 7]);
  const column = await community().forZone(official.id);
  const order = column?.items.map((entry) => entry.id);
  assert.deepEqual(order?.slice(0, 2), [whole.cards[1].id, whole.cards[0].id], "full share, score 5 then 2");
  assert.equal(order?.[2], whole.cards[2].id, "unscored after scored");
  assert.deepEqual(new Set(order?.slice(3)), new Set(half.cards.map((entry) => entry.id)), "half share last");
  assert.equal(column?.items[0].reviewScore, 5);
  assert.equal(column?.items[2].reviewScore, null);
  // The cap is a resource bound, not an opinion.
  assert.equal((await community({ maxCards: 2 }).forZone(official.id))?.items.length, 2);
  assert.equal((await community({ maxCards: 9999 }).forZone(official.id))?.limit, COMMUNITY_MAX_CARDS_CEILING);
});

test("only a published official zone has a column: a user zone, a draft, a missing id and a malformed id all answer null; a zone with no subject keys lists nothing", options, async () => {
  const subject = community();
  const user = await userZone("alice");
  const draft = (await zones.saveEditorial(publisher, { title: "Draft", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  for (const id of [user.id, draft.id, `ez_${"0".repeat(32)}`, "not-a-zone", "", "x".repeat(300)]) assert.equal(await subject.forZone(id), null, id);
  const bare = (await zones.saveEditorial(publisher, { title: "No subjects yet", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, { expectedRevision: bare.revision, state: "published" }, bare.id, null, false, "programme");
  await establishedAuthor("alice");
  assert.deepEqual((await subject.forZone(bare.id))?.items, []);
});

test("the metric families say what was listed and what was held back", options, async () => {
  await establishedAuthor("alice");
  await establishedAuthor("frank", 2);
  const subject = community();
  await subject.forZone(official.id);
  const stats = subject.stats();
  assert.deepEqual([stats.requests, stats.listed, stats.heldBackNewAuthors], [1, 3, 2]);
  const families = evidenceCommunityMetricFamilies(subject);
  assert.deepEqual(families.map((family) => family.name), ["open_science_evidence_community_requests_total", "open_science_evidence_community_held_back_total", "open_science_evidence_community_max_cards"]);
  assert.deepEqual(evidenceCommunityMetricFamilies(null), []);
});

/** @param {string} method @param {string} path */
const request = (method, path) => Object.assign(Readable.from([]), { method, url: path, headers: {} });
const response = () => ({ status: 0, headers: /** @type {any} */ ({}), body: "", writeHead(/** @type {number} */ status, /** @type {any} */ headers = {}) { this.status = status; this.headers = headers; return this; }, end(chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } });

test("the route: off is a 404 by name before anything is read; the same door as the zone routes; an unknown or draft zone is a 404 by name; the column is private and uncached", options, async () => {
  await establishedAuthor("alice");
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} };
  const door = (/** @type {any} */ over = {}) => createEvidenceCommunityRoutes({ store, service: {}, frontier: { allows: () => true }, config: { frontierEnabled: true, evidenceCommunityCardsEnabled: true }, community: community(), ...over });
  const path = `/api/frontier/zones/${official.id}/community`;
  assert.equal(await door()(request("GET", "/api/frontier/zones/ez_x/follow"), response()), false);
  assert.equal(await door()(request("POST", path), response()), false, "reads only");
  await assert.rejects(door({ config: { frontierEnabled: true, evidenceCommunityCardsEnabled: false } })(request("GET", path), response()), { status: 404, code: "evidence_community_not_enabled" });
  await assert.rejects(door({ community: null })(request("GET", path), response()), { status: 404, code: "evidence_community_not_enabled" });
  await assert.rejects(door({ frontier: { allows: () => false } })(request("GET", path), response()), { status: 404, code: "frontier_not_enabled" });
  await assert.rejects(door()(request("GET", "/api/frontier/zones/nope/community"), response()), { status: 404, code: "evidence_community_not_found" });
  const reply = response();
  assert.equal(await door()(request("GET", path), reply), true);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["Cache-Control"], "private, no-store");
  assert.equal(reply.json().data.items.length, 3);
});
