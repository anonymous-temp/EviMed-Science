// One rule for "an established author" (flywheel review 2026-10-06), against a real PostgreSQL. The feed, the public pages' indexing and the
// community column each held a copy of it, looking at the newest 150, 50 and 50 cards. They now all ask `evidenceAuthorIsEstablished`: here the
// same authors — two ✓ cards, three, three typed-excerpt cards the platform never read, and three ✓ cards buried under fifty-five newer cards
// without one — get the same verdict from every caller, at the boundary of two against three, and each caller's own extra condition is its own.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { authorHandlesFor } from "../src/evidenceAuthorHandles.mjs";
import { evidenceAuthorIsEstablished, evidenceEstablishedAuthors } from "../src/evidenceAuthorStanding.mjs";
import { createEvidenceCommunity } from "../src/evidenceCommunity.mjs";
import { createEvidenceFeed } from "../src/evidenceFeed.mjs";
import { createEvidencePublicReads } from "../src/evidencePublicQuery.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const publisher = { id: "publisher" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke. Among 100 adults on usual care, 12 had a stroke.";
const found = { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" };
const lost = { claimId: "CLM-003", claimType: "direct", claim: "Nobody died.", sourceIndexes: [1], supportQuote: "No one died in either group" };
const KEYS = ["disease:atrial-fibrillation", "drug:apixaban"];
const card = (/** @type {string} */ title, /** @type {any[]} */ claims, /** @type {any} */ extra = {}) => ({
  title, subtype: "academic", summary: `${title} summary.`, body: "The body.", state: "published", limitations: "One trial.", provenance: "p",
  sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" }],
  content: { question: "Does it prevent stroke?", answer: "Fewer strokes were seen." }, claims, entityKeys: KEYS, ...extra,
});

/** @type {any} */ let isolated, db, zones, official;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "onerule");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('publisher','EviMed 证据中心','development'),('two','Two Cards','development'),('three','Three Cards','development'),('typed','Typed Only','development'),('buried','Buried Early','development'),('fresh','Fresh Account','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  const made = (await zones.saveEditorial(publisher, { title: "房颤抗凝", description: "d", background: "b", kind: "official" }, null, null, false, "programme")).zone;
  official = (await zones.saveEditorial(publisher, { expectedRevision: made.revision, state: "published" }, made.id, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, card("Official card", [found]), official.id, null, true, "programme");
});

const openZone = async (/** @type {string} */ userId) => {
  const user = { id: userId };
  const { zone } = await zones.save(user, { title: `${userId}'s zone`, description: "d", background: "b" });
  const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  return (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone;
};
const put = (/** @type {string} */ userId, /** @type {any} */ zone, /** @type {any} */ input) => zones.saveEditorial({ id: userId }, input, zone.id, null, true, "result").then((result) => result.evidence);
/** The same cards but as their author typed them: an excerpt the platform never read, so no ✓. */
const typedCard = (/** @type {string} */ title) => card(title, [found], { sources: [{ title: "The trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT }] });

async function fixture() {
  const mine = { two: await openZone("two"), three: await openZone("three"), typed: await openZone("typed"), buried: await openZone("buried") };
  for (const index of [1, 2]) await put("two", mine.two, card(`two ${index}`, [found]));
  for (const index of [1, 2, 3]) await put("three", mine.three, card(`three ${index}`, [found]));
  for (const index of [1, 2, 3]) await put("typed", mine.typed, typedCard(`typed ${index}`));
  // Three ✓ cards, then fifty-five newer cards none of which carries one: the three are among the newest 58, outside the newest 50.
  for (const index of [1, 2, 3]) await put("buried", mine.buried, card(`buried ${index}`, [found]));
  for (let index = 1; index <= 55; index += 1) await put("buried", mine.buried, card(`buried filler ${index}`, [lost]));
  return mine;
}

test("every caller gives the same verdict for the same authors: two against three, typed excerpts, and ✓ cards beyond the newest fifty", options, async () => {
  await fixture();
  const accounts = ["two", "three", "typed", "buried", "fresh"];
  const expected = ["three", "buried"];
  const single = [];
  for (const id of accounts) if (await evidenceAuthorIsEstablished(db, id)) single.push(id);
  assert.deepEqual(single, expected, "the rule itself: three ✓ cards, the platform-read ones only, among the newest 150");
  assert.deepEqual([...(await evidenceEstablishedAuthors(db, accounts))].sort(), [...expected].sort(), "the batch form is the same rule asked once for each");

  // The public pages' indexing asks by handle.
  const reads = createEvidencePublicReads({ database: db });
  const handles = await authorHandlesFor(db, accounts);
  const pages = [];
  for (const id of accounts) if (await reads.authorQualifies(/** @type {string} */ (handles.get(id)))) pages.push(id);
  assert.deepEqual(pages, expected, "the public pages (they looked at the newest 50 cards, so `buried` was a new author there)");
  assert.equal(await reads.authorQualifies("au_ffffffffffffffff"), false, "a handle nobody holds does not qualify");

  // The feed: a researcher's card published from a research result is in it only for an established author.
  const feed = createEvidenceFeed({ database: db, config: { publicUrl: "https://www.evimed.test" } });
  for (const id of ["two", "three", "buried"]) {
    const zone = await openZone(id);
    await put(id, zone, card(`${id} result card`, [], { originality: "original_research", lineage: { resultVersionId: `rv_${id.length.toString().repeat(64)}` } }));
  }
  const inFeed = (await feed.page({ limit: 50 })).page.items.map((/** @type {any} */ item) => item.title).filter((/** @type {string} */ title) => title.endsWith("result card")).sort();
  assert.deepEqual(inFeed, ["buried result card", "three result card"], "the feed");

  // The community column: the same authors' cards on the official zone's subject.
  const column = await createEvidenceCommunity({ database: db, maxCards: 50, platformPublisherUserId: "publisher" }).forZone(official.id);
  const listed = [...new Set(column?.items.map((/** @type {any} */ item) => item.author.name))].sort();
  assert.deepEqual(listed, ["Buried Early", "Three Cards"], "the community column");
});

test("each caller keeps its own extra condition beside the rule: official zones are exempt on the pages, and the community column may list a corroborated card", options, async () => {
  await fixture();
  const reads = createEvidencePublicReads({ database: db });
  // The platform's own zone needs no standing: the pages and the feed exempt it by zone kind, not by asking the rule.
  assert.equal(await evidenceAuthorIsEstablished(db, "publisher"), false);
  const twoCards = (await db.query("SELECT id FROM evimed_frontier.evidence_cards WHERE user_id='two' ORDER BY id")).rows.map((/** @type {any} */ row) => row.id);
  const held = await createEvidenceCommunity({ database: db, maxCards: 50, platformPublisherUserId: "publisher" }).forZone(official.id);
  assert.equal(held?.items.some((/** @type {any} */ item) => item.author.name === "Two Cards"), false, "two ✓ cards: not established, not listed");
  const corroborated = createEvidenceCommunity({ database: db, maxCards: 50, platformPublisherUserId: "publisher",
    corroborated: async (cardRow) => cardRow.id === twoCards[0] });
  const lifted = await corroborated.forZone(official.id);
  assert.deepEqual(lifted?.items.filter((/** @type {any} */ item) => item.author.name === "Two Cards").map((/** @type {any} */ item) => item.id), [twoCards[0]],
    "a card something independent vouches for is listed without its author being established; the author's other card is not");
  assert.equal(corroborated.stats().heldBackNewAuthors, 4, "the cards still held back are counted: two's other card and the three typed ones");
  assert.equal(await reads.authorQualifies(/** @type {string} */ ((await authorHandlesFor(db, ["two"])).get("two"))), false, "corroboration is the column's own: the pages' rule is unchanged");
});

test("a verdict kept by a caller follows the author's cards: the third ✓ card lifts it at once and a withdrawal takes it away at once", options, async () => {
  const mine = await fixture();
  const reads = createEvidencePublicReads({ database: db });
  const handle = /** @type {string} */ ((await authorHandlesFor(db, ["two"])).get("two"));
  assert.equal(await reads.authorQualifies(handle), false);
  assert.equal(await reads.authorQualifies(handle), false, "asked again from the memory");
  const third = await put("two", mine.two, card("two 3", [found]));
  assert.equal(await reads.authorQualifies(handle), true, "the third card lifts the rule");
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=jsonb_build_object('at',now(),'reason','r') WHERE id=$1", [third.id]);
  assert.equal(await reads.authorQualifies(handle), false, "a withdrawn card takes the standing with it, though nothing else was written");
});
