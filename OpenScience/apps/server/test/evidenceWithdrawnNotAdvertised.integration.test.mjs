// A withdrawn card is not advertised (evidence-flywheel review fix 3, 2026-10-06), against a real PostgreSQL. A withdrawal sets
// `withdrawn` on the card and leaves its state published, so every list of published cards had to learn the difference: the public
// feed, a run's card search, an author's page, a card's related cards and what a zone offers to research from. The card's own page
// still reads, marked withdrawn, and so does its zone's own list, where the card sits labelled as no longer updated (a documented
// behaviour of the upkeep, `evidenceUpkeep.integration.test.mjs`).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceAuthors } from "../src/evidenceAuthors.mjs";
import { createEvidenceCardSearch } from "../src/evidenceCardSearch.mjs";
import { createEvidenceFeed } from "../src/evidenceFeed.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const publisher = { id: "publisher" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke.";
const cardInput = (/** @type {string} */ title, /** @type {any} */ extra = {}) => ({
  title, subtype: "academic", summary: "Warfarin summary.", body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT }],
  content: { question: "Does warfarin prevent stroke?", answer: "Fewer strokes were seen on warfarin." }, ...extra,
});

/** @type {any} */ let isolated, db, zones, feed, search, authors;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "withdrawn");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
  feed = createEvidenceFeed({ database: db, config: { publicUrl: "https://www.evimed.test" } });
  search = createEvidenceCardSearch({ database: db, entityVocabulary: null });
  authors = new EvidenceAuthors({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => { if (db) await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE"); });

/** What a challenge's withdrawal writes: the mark on the card and, with it, a new content version for the feed's cached pages. */
const withdraw = async (/** @type {string} */ id) => {
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=$2::jsonb WHERE id=$1", [id, JSON.stringify({ at: "2026-10-06T00:00:00Z", reason: "The source was retracted." })]);
  await db.query("UPDATE evimed_frontier.evidence_zone_meta SET version=version+1 WHERE singleton");
};

test("a withdrawn card leaves the feed, the card search, the author page and the related cards, and keeps its own page and its place in its zone's list", options, async () => {
  const { zone: made } = await zones.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  const official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  const kept = (await zones.saveEditorial(publisher, cardInput("Warfarin kept"), official.id, null, true, "programme")).evidence;
  const gone = (await zones.saveEditorial(publisher, cardInput("Warfarin withdrawn"), official.id, null, true, "programme")).evidence;
  const { zone: own } = await zones.save(alice, { title: "Alice's zone", description: "d", background: "b" });
  const aliceZone = (await zones.save(alice, { expectedRevision: own.revision, state: "published" }, own.id)).zone;
  const first = (await zones.saveEditorial(alice, cardInput("Alice's first"), aliceZone.id, null, true, "result")).evidence;
  const next = (await zones.saveEditorial(alice, cardInput("Alice's second", { lineage: { previousCardId: first.id } }), aliceZone.id, null, true, "result")).evidence;

  const feedTitles = async () => (await feed.page({})).page.items.map((/** @type {any} */ item) => item.title).sort();
  const searched = async () => (await search.search(bob, { q: "warfarin", limit: 20 })).cards.map((/** @type {any} */ card) => card.title).sort();
  const authorCards = async () => (await authors.page(bob, "alice")).cards.map((/** @type {any} */ card) => card.title).sort();
  const listed = async () => (await zones.list(bob, new URLSearchParams({ scope: "public" }), official.id)).items.map((/** @type {any} */ card) => card.title).sort();
  assert.deepEqual(await feedTitles(), ["Warfarin kept", "Warfarin withdrawn"]);
  assert.deepEqual(await searched(), ["Alice's first", "Alice's second", "Warfarin kept", "Warfarin withdrawn"]);
  assert.deepEqual(await listed(), ["Warfarin kept", "Warfarin withdrawn"]);
  assert.equal((await zones.detail(bob, official.id)).zone.evidenceCount, 2);
  assert.deepEqual((await authors.links(bob, first.id)).related.map((/** @type {any} */ card) => card.title), ["Alice's second"]);

  await withdraw(gone.id);
  await withdraw(next.id);
  assert.deepEqual(await feedTitles(), ["Warfarin kept"], "the feed");
  assert.deepEqual(await searched(), ["Alice's first", "Warfarin kept"], "a run's card search");
  assert.deepEqual(await authorCards(), ["Alice's first"], "the author page's list");
  const page = await authors.page(bob, "alice");
  assert.equal(page.totals.cards, 1, "and its total");
  assert.equal(page.zones[0].evidenceCount, 1, "and the zone's count on it");
  assert.deepEqual((await authors.links(bob, first.id)).related, [], "a withdrawn card is not the next version of anything");
  assert.deepEqual(await listed(), ["Warfarin kept", "Warfarin withdrawn"], "the zone's own list still shows it, labelled");
  assert.equal((await zones.list(bob, new URLSearchParams({ scope: "public" }), official.id)).items.find((/** @type {any} */ card) => card.id === gone.id).withdrawn.reason, "The source was retracted.");
  // The card's own page keeps showing it, as withdrawn.
  const page2 = (await zones.detail(bob, official.id, gone.id)).evidence;
  assert.equal(page2.title, "Warfarin withdrawn");
  assert.equal(page2.withdrawn.reason, "The source was retracted.");
  // Its author still finds it among their own cards.
  assert.deepEqual((await zones.list(alice, new URLSearchParams({ scope: "owned" }), aliceZone.id)).items.map((/** @type {any} */ card) => card.title).sort(), ["Alice's first", "Alice's second"]);
  assert.ok(kept.id);
});
