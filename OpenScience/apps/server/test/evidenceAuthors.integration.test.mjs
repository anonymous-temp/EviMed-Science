// The author page and the card links (evidence-flywheel F07, 2026-10-05): only what the reader may see, the one citation
// signal that exists — runs another account started from the author's cards — named for what it is, the change log through
// an optional reader, and the citation gift reached only at a milestone of another account's runs.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIDENCE_AUTHOR_PAGE_LIMITS, EvidenceAuthors } from "../src/evidenceAuthors.mjs";
import { EVIDENCE_CITATION_MILESTONES } from "../src/evidenceCitationGift.mjs";
import { EvidenceOrigins } from "../src/evidenceOrigins.mjs";
import { resetEvidencePublishMetrics } from "../src/evidencePublishMetrics.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const carol = { id: "carol" };
const publisher = { id: "publisher" };

/** @type {any} */ let isolated, db, zones, authors, origins, cited;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "authors");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice Li','development'),('bob','Bob','development'),('carol','Carol','development'),('publisher','EviMed 证据中心','development'),('nobody','Nobody','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  resetEvidencePublishMetrics();
  cited = [];
  authors = new EvidenceAuthors({ database: db, platformPublisherUserId: "publisher" });
  origins = new EvidenceOrigins({ database: db, cited: async (input) => { cited.push(input); } });
});

const cardFields = (title, extra = {}) => ({ title, subtype: "knowledge", summary: `${title} summary`, body: "b", sources: [{ title: "S", url: "https://example.org/s" }], limitations: "", ...extra });
async function zoneOf(user, title, { published = true } = {}) {
  const { zone } = await zones.save(user, { title, description: "", background: "" });
  return published ? (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone : zone;
}
async function card(user, zone, title, { published = true } = /** @type {any} */ ({})) {
  const made = (await zones.save(user, cardFields(title), zone.id, null, true)).evidence;
  if (!published) return made;
  return (await zones.save(user, { expectedRevision: made.revision, state: "published" }, zone.id, made.id)).evidence;
}
const follow = async (user, zone) => zones.act(user, zone.id, "follow", { expectedRevision: (await zones.detail(user, zone.id)).zone.revision });

test("an author's page is their published zones and cards, the followers over those zones and the runs others started from their cards", options, async () => {
  const z1 = await zoneOf(alice, "Stroke");
  const hiddenZone = await zoneOf(alice, "Unpublished zone", { published: false });
  const c1 = await card(alice, z1, "First published card");
  await card(alice, z1, "Second published card");
  await card(alice, z1, "A draft card", { published: false });
  await card(alice, hiddenZone, "Card in a zone nobody can read");
  await follow(bob, z1);
  await follow(carol, z1);
  // Runs: two from Bob, one from Carol, and one from Alice herself — hers is not the card being cited by research.
  await origins.runStarted({ userId: "bob", id: "b1" }, { id: "r1", originCardId: c1.id });
  await origins.runStarted({ userId: "bob", id: "b1" }, { id: "r2", originCardId: c1.id });
  await origins.runStarted({ userId: "carol", id: "c1" }, { id: "r3", originCardId: c1.id });
  await origins.runStarted({ userId: "alice", id: "a1" }, { id: "r4", originCardId: c1.id });
  const page = await authors.page(bob, "alice");
  assert.deepEqual(page.author, { id: "alice", name: "Alice Li", platform: false });
  assert.deepEqual(page.zones.map((zone) => zone.title), ["Stroke"], "only the published zone");
  assert.equal(page.zones[0].evidenceCount, 2);
  assert.equal(page.zones[0].follows, 2);
  assert.deepEqual(page.cards.map((entry) => entry.title).sort(), ["First published card", "Second published card"], "no draft, nothing from an unpublished zone");
  assert.ok(page.cards.every((entry) => entry.creator === "Alice Li" && entry.claimCount === 0));
  assert.deepEqual(page.totals, { cards: 2, followers: 2, runsFromCards: 3 });
  assert.equal("changes" in page, false, "no change section without a change log's reader");
  // The page is the same to everyone: the author reads it as a reader does.
  assert.deepEqual((await authors.page(alice, "alice")).totals, page.totals);
  // A follower of two of the author's zones is one follower.
  const z2 = await zoneOf(alice, "Kidney");
  await card(alice, z2, "Kidney card");
  await follow(bob, z2);
  assert.equal((await authors.page(carol, "alice")).totals.followers, 2);
  // Withdrawing the zone takes its cards, its followers and the runs from the page.
  const zone2 = (await zones.detail(alice, z2.id)).zone;
  await zones.save(alice, { expectedRevision: zone2.revision, state: "draft" }, z2.id);
  assert.deepEqual((await authors.page(carol, "alice")).zones.map((zone) => zone.title), ["Stroke"]);
});

test("an account with nothing published has no page, and the answer is the same as for an id that is not an account", options, async () => {
  await zoneOf(carol, "Only a draft", { published: false });
  for (const id of ["carol", "nobody", "no-such-account", "has space", "", "x".repeat(300)]) {
    await assert.rejects(authors.page(bob, id), (error) => error.status === 404 && error.code === "evidence_author_not_found", JSON.stringify(id));
  }
});

test("the platform's own publisher account has an author page, marked as the platform's", options, async () => {
  const official = (await zones.saveEditorial(publisher, { title: "官方专区", description: "", background: "", kind: "official" }, null, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, { expectedRevision: official.revision, state: "published" }, official.id, null, false, "programme");
  const page = await authors.page(bob, "publisher");
  assert.deepEqual(page.author, { id: "publisher", name: "EviMed 证据中心", platform: true });
  assert.equal(page.zones[0].kind, "official");
});

test("the change log comes through an optional reader: carried when it answers, left out when it is absent or fails", options, async () => {
  const z = await zoneOf(alice, "Stroke");
  await card(alice, z, "A card");
  const entries = [{ id: "ch_1", kind: "correction", at: "2026-10-05T00:00:00Z", summary: "更正" }];
  const asked = [];
  const withLog = new EvidenceAuthors({ database: db, changeLog: { recentForAuthor: async (authorId, { limit }) => { asked.push([authorId, limit]); return entries; } } });
  assert.deepEqual((await withLog.page(bob, "alice")).changes, entries);
  assert.deepEqual(asked, [["alice", EVIDENCE_AUTHOR_PAGE_LIMITS.changes]]);
  const failing = new EvidenceAuthors({ database: db, changeLog: { recentForAuthor: async () => { throw new Error("change log down"); } } });
  const page = await failing.page(bob, "alice");
  assert.equal("changes" in page, false);
  assert.equal(page.zones.length, 1, "the page is otherwise the same");
});

test("a card's links name its author, what it points back to and the published cards that follow it — and only what the reader may read", options, async () => {
  const za = await zoneOf(alice, "Alice zone");
  const base = await card(alice, za, "Base card");
  const zb = await zoneOf(bob, "Bob zone");
  const next = (await zones.saveEditorial(bob, { ...cardFields("Bob's follow-up"), lineage: { originCardId: base.id } }, zb.id, null, true, "owner")).evidence;
  const successor = (await zones.saveEditorial(alice, { ...cardFields("Alice's next version"), lineage: { previousCardId: base.id } }, za.id, null, true, "owner")).evidence;
  // Drafts are not listed.
  assert.deepEqual((await authors.links(carol, base.id)).related, []);
  for (const [user, zone, entry] of [[bob, zb, next], [alice, za, successor]]) await zones.save(user, { expectedRevision: entry.revision, state: "published" }, zone.id, entry.id);
  const links = await authors.links(carol, base.id);
  assert.deepEqual(links.author, { id: "alice", name: "Alice Li" });
  assert.deepEqual(links.related.map((entry) => [entry.title, entry.relation]).sort(), [["Alice's next version", "next_version"], ["Bob's follow-up", "research_from_card"]]);
  assert.equal(links.origin, null);
  const back = await authors.links(carol, next.id);
  assert.equal(back.origin.id, base.id);
  assert.equal(back.previous, null);
  assert.equal((await authors.links(carol, successor.id)).previous.id, base.id);
  // What a card points back to is shown only to a reader who may read it.
  const draftOrigin = await card(alice, za, "Alice's draft", { published: false });
  const pointing = (await zones.saveEditorial(bob, { ...cardFields("Points at a draft"), lineage: { originCardId: draftOrigin.id } }, zb.id, null, true, "owner")).evidence;
  await zones.save(bob, { expectedRevision: pointing.revision, state: "published" }, zb.id, pointing.id);
  assert.equal((await authors.links(carol, pointing.id)).origin, null, "Carol cannot read Alice's draft");
  assert.equal((await authors.links(alice, pointing.id)).origin.id, draftOrigin.id, "Alice can");
  // A card the caller cannot read has no links, and a malformed id is no card.
  await assert.rejects(authors.links(carol, draftOrigin.id), (error) => error.status === 404 && error.code === "evidence_not_found");
  await assert.rejects(authors.links(carol, "nope"), (error) => error.status === 404);
});

test("the gift hook is reached only at a milestone of another account's runs, never by the author's own", options, async () => {
  const z = await zoneOf(alice, "Stroke");
  const c = await card(alice, z, "Cited card");
  const [first, second] = EVIDENCE_CITATION_MILESTONES;
  for (let index = 1; index < first; index += 1) await origins.runStarted({ userId: "bob", id: "b" }, { id: `r${index}`, originCardId: c.id });
  assert.deepEqual(cited, [], "one short of the milestone");
  await origins.runStarted({ userId: "bob", id: "b" }, { id: `r${first}`, originCardId: c.id });
  assert.deepEqual(cited, [{ cardId: c.id, authorId: "alice", count: first }]);
  await origins.runStarted({ userId: "bob", id: "b" }, { id: "r-after", originCardId: c.id });
  assert.equal(cited.length, 1, "past it, nothing more until the next one");
  // Ten of the author's own runs are not a citation.
  const own = await card(alice, z, "Her own research");
  for (let index = 0; index < second; index += 1) await origins.runStarted({ userId: "alice", id: "a" }, { id: `own${index}`, originCardId: own.id });
  assert.equal(cited.length, 1);
  // Runs counted at the same moment cannot step over a milestone.
  const raced = await card(alice, z, "Raced card");
  await Promise.all(Array.from({ length: first }, (_, index) => origins.runStarted({ userId: "carol", id: "c" }, { id: `race${index}`, originCardId: raced.id })));
  assert.deepEqual(cited.filter((entry) => entry.cardId === raced.id).map((entry) => entry.count), [first]);
  // A card that is not there, and a run with no card, record nothing and throw nothing.
  await origins.runStarted({ userId: "bob", id: "b" }, { id: "ghost", originCardId: "ec_0123456789abcdef" });
  await origins.runStarted({ userId: "bob", id: "b" }, { id: "plain" });
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_card_runs WHERE run_id IN ('ghost','plain')")).rows[0].n, 0);
});

test("the module's tables migrate on a database that already holds data, and twice in a row", options, async () => {
  const { migrateEvidenceOrigins } = await import("../src/evidenceOrigins.mjs");
  const fresh = await createGeoTestDatabase(url, "authorsmigrate");
  const second = new ControlPlaneDatabase({ databaseUrl: fresh.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  try {
    await migrateFrontier(second, { dimension: 1024 });
    await second.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development')");
    const service = new EvidenceZoneService({ database: second });
    const { zone } = await service.save(alice, { title: "Older zone", description: "", background: "" });
    await service.save(alice, cardFields("Older card"), zone.id, null, true);
    await migrateEvidenceOrigins(second);
    await migrateEvidenceOrigins(second);
    const { EVIDENCE_ORIGINS_SQL } = await import("../src/evidenceOrigins.mjs");
    await second.query(EVIDENCE_ORIGINS_SQL);
    await second.query(EVIDENCE_ORIGINS_SQL);
    assert.equal((await second.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 1, "what was there is still there");
  } finally {
    await second.close();
    await fresh.drop();
  }
});
