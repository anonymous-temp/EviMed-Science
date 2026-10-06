// "What enters the frontier from a user is not self-declared" (evidence-flywheel review fix 4, 2026-10-06), against a real
// PostgreSQL: the author rule (`evidenceAuthorIsEstablished`) and the feed's use of it. A researcher's card is in the feed only
// when it was published from a research result, its author has three published, unwithdrawn cards each with a quotation the
// platform verified, and it is not withdrawn; the author's own word (`originality`) and excerpts they typed decide nothing.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { evidenceAuthorIsEstablished } from "../src/evidenceAuthorStanding.mjs";
import { createEvidenceFeed } from "../src/evidenceFeed.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const TEXT = "Among 100 adults on the drug, 7 had a stroke.";
const CLAIM = [{ claimId: "CLM-1", claimType: "direct", claim: "Strokes were rarer.", sourceIndexes: [1], supportQuote: "7 had a stroke" }];

/** @type {any} */ let isolated, db, zones, feed;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "standing");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')");
  zones = new EvidenceZoneService({ database: db });
  feed = createEvidenceFeed({ database: db, config: { publicUrl: "https://www.evimed.test" } });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => { if (db) await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE"); });

const publishedZone = async (/** @type {any} */ user, title, internet = false) => {
  const { zone } = await zones.save(user, { title, description: "d", background: "b" });
  const live = (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
  return internet ? (await zones.setVisibility(user, live.id, { visibility: "internet", expectedRevision: live.revision })).zone : live;
};
const body = (/** @type {string} */ title, /** @type {any} */ extra = {}) => ({
  title, subtype: "academic", summary: "s", body: "b", state: "published", limitations: "l", provenance: "p",
  content: { question: "Q?", answer: "A." }, claims: CLAIM, ...extra,
});
const read = { title: "Trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT, documentText: TEXT, coverage: "full-text" };
/** A card the platform checked: its source text was read by the platform (a session cannot send `documentText`). */
const checked = (/** @type {any} */ user, /** @type {any} */ zone, /** @type {string} */ title, /** @type {any} */ extra = {}) =>
  zones.saveEditorial(user, body(title, { sources: [read], ...extra }), zone.id, null, true, "result").then((result) => result.evidence);
/** A card as its author writes it: an excerpt they typed, which the platform has not read. */
const typed = (/** @type {any} */ user, /** @type {any} */ zone, /** @type {string} */ title) =>
  zones.save(user, body(title, { sources: [{ title: "Trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: TEXT }] }), zone.id, null, true).then((result) => result.evidence);
const titles = async (/** @type {any} */ query) => (await feed.page(query)).page.items.map((/** @type {any} */ item) => item.title).sort();
/** Published from a research result; and with no claim of its own, so it adds nothing to its author's standing. */
const RESULT = { claims: [], lineage: { resultVersionId: `rv_${"3".repeat(64)}` } };
const result = (/** @type {string} */ digit) => ({ claims: [], lineage: { resultVersionId: `rv_${digit.repeat(64)}` } });

test("an author is established with three published cards that each have a claim the platform verified, and not before", options, async () => {
  const zone = await publishedZone(alice, "Standing");
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), false, "a new account");
  await checked(alice, zone, "One");
  await checked(alice, zone, "Two");
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), false, "two is not three");
  // Cards whose quotation only the author vouches for (an excerpt they typed) are not counted, however many there are.
  for (const name of ["x", "y", "z", "w"]) await typed(alice, zone, `Typed ${name}`);
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), false, "excerpts the platform never read count for nothing");
  const third = await checked(alice, zone, "Three");
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), true);
  assert.equal(await evidenceAuthorIsEstablished(db, "bob"), false, "standing is the author's own");
  // A withdrawn card, a draft and a card in an unpublished zone are not published cards.
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn='{\"at\":\"2026-10-06T00:00:00Z\",\"reason\":\"r\"}'::jsonb WHERE id=$1", [third.id]);
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), false, "a withdrawn card takes the standing with it");
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn=NULL WHERE id=$1", [third.id]);
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), true);
  await zones.save(alice, { expectedRevision: zone.revision, state: "draft" }, zone.id);
  assert.equal(await evidenceAuthorIsEstablished(db, "alice"), false, "the zone was taken back to a draft");
});

test("a researcher's card is in the feed only from a research result, by an established author, unwithdrawn; their own word decides nothing", options, async () => {
  const open = await publishedZone(alice, "Open zone", true);
  const standing = await publishedZone(alice, "Standing zone");
  for (const name of ["a", "b"]) await checked(alice, standing, `Standing ${name}`);
  await checked(alice, open, "From a result", { originality: "original_research", ...RESULT });
  await checked(alice, open, "Self-declared", { originality: "original_research", claims: [] });
  assert.deepEqual(await titles(), [], "an author with two checked cards is not established");
  await checked(alice, standing, "Standing c");
  assert.deepEqual(await titles(), ["From a result"], "established now; the card that only calls itself original research is still out");
  const second = await checked(alice, open, "Second from a result", { originality: "synthesis", ...result("4") });
  assert.deepEqual(await titles(), ["From a result", "Second from a result"], "what the author says of the card is not asked");
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn='{\"at\":\"2026-10-06T00:00:00Z\",\"reason\":\"r\"}'::jsonb WHERE id=$1", [second.id]);
  await db.query("UPDATE evimed_frontier.evidence_zone_meta SET version=version+1 WHERE singleton");
  assert.deepEqual(await titles(), ["From a result"], "a withdrawn card is out");
  // The author's own card with a quotation only they vouch for gives no standing to another account's cards.
  const bobZone = await publishedZone(bob, "Bob open", true);
  await checked(bob, bobZone, "Bob from a result", RESULT);
  assert.deepEqual(await titles(), ["From a result"], "bob has no checked cards of his own");
});

test("a page skips the cards of authors who are not established without losing its place: the cursor continues where it stopped", options, async () => {
  const open = await publishedZone(alice, "Open zone", true);
  const standing = await publishedZone(alice, "Standing zone");
  for (const name of ["a", "b", "c"]) await checked(alice, standing, `Standing ${name}`);
  const bobZone = await publishedZone(bob, "Bob open", true);
  // Newest first: three of bob's (not established) over three of alice's.
  for (const name of ["1", "2", "3"]) await checked(alice, open, `Alice ${name}`, result(name));
  for (const name of ["1", "2", "3"]) await checked(bob, bobZone, `Bob ${name}`, result(name));
  const pages = [];
  /** @type {string | null} */ let cursor = null;
  do {
    const { page } = await feed.page({ cursor, limit: 2 });
    pages.push(page.items.map((/** @type {any} */ item) => item.title));
    cursor = page.next;
  } while (cursor && pages.length < 6);
  assert.deepEqual(pages.flat().sort(), ["Alice 1", "Alice 2", "Alice 3"], "every admitted card once, none of bob's");
  assert.ok(pages.every((page) => page.length <= 2));
});

test("a page that finds only skipped cards within its scan bound answers empty with a cursor, and the client carries on to the rest", options, async () => {
  const open = await publishedZone(alice, "Open zone", true);
  const standing = await publishedZone(alice, "Standing zone");
  for (const name of ["a", "b", "c"]) await checked(alice, standing, `Standing ${name}`);
  await checked(alice, open, "Alice only", result("1"));
  const bobZone = await publishedZone(bob, "Bob open", true);
  // Newest first, twenty of bob's over alice's one: a page of one card looks at two cards a batch and eight batches at most.
  for (let n = 0; n < 20; n += 1) await checked(bob, bobZone, `Bob ${n}`, { claims: [], lineage: { resultVersionId: `rv_${String(n).padStart(2, "0").repeat(32)}` } });
  const first = (await feed.page({ limit: 1 })).page;
  assert.deepEqual(first.items, [], "the bound was reached before an admitted card was met");
  assert.ok(first.next, "and the page says so by a cursor");
  const seen = [];
  /** @type {string | null} */ let cursor = first.next;
  for (let hops = 0; cursor && hops < 5; hops += 1) {
    const { page } = await feed.page({ cursor, limit: 1 });
    seen.push(...page.items.map((/** @type {any} */ item) => item.title));
    cursor = page.next;
  }
  assert.deepEqual(seen, ["Alice only"]);
  assert.equal(cursor, null);
});
