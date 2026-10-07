// A run's search for evidence cards against a real PostgreSQL (flywheel F12): the cards a run may be shown are the
// published ones, the rest are never read, what leaves is an index entry with its primary sources and the one
// instruction, and the gateway in front of it answers beside the items.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { CARD_INDEX_INSTRUCTION, CARD_SEARCH_MAX, cardQueryTerms, createEvidenceCardSearch } from "../src/evidenceCardSearch.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { FRONTIER_GATEWAY_PATH, createFrontierGatewayHandler } from "../src/frontierGateway.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };
const publisher = { id: "publisher" };

const DOCUMENT = "In this randomized trial, 12 of 100 adults on usual care had a stroke. Among 100 adults on the drug, 7 had a stroke.";
const cardInput = {
  title: "Does apixaban prevent stroke?",
  subtype: "academic",
  summary: "A randomized trial summary.",
  body: "The trial reports fewer strokes.",
  sources: [{ title: "The stroke trial", url: "https://doi.org/10.1000/Stroke.1", excerpt: DOCUMENT, documentText: `${DOCUMENT} A restricted passage that must never leave.`, coverage: "full-text" }],
  limitations: "One trial.",
  provenance: "Authored synthesis",
  content: { question: "Does apixaban prevent stroke?", answer: "Fewer strokes were seen on apixaban.", population: "Adults with atrial fibrillation" },
  claims: [
    { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" },
    { claimId: "CLM-002", claimType: "direct", claim: "Bleeding was far less frequent.", sourceIndexes: [1], supportQuote: "Bleeding fell by half in this trial" },
  ],
};
const productFields = {
  producer: { kind: "enterprise", name: "Acme Pharma", relation: "own_product", products: ["Drug A"] },
  journeyStage: { key: "treatment-choice", label: "治疗选择" },
  disclosure: { authors: [{ name: "Dr. Li", affiliation: "PUMCH" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }] },
};

let isolated, db, service, tagging, search;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "cardsearch");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  // The shared vocabulary, scripted: what a card is tagged with at its write, and what a query is tagged with at a search.
  tagging = { card: /** @type {string[]} */ ([]), query: /** @type {string[]} */ ([]) };
  service = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher", entityKeysFor: async () => tagging.card });
  search = createEvidenceCardSearch({ database: db, entityVocabulary: { keysForText: async () => tagging.query } });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
  tagging.card = [];
  tagging.query = [];
});

const makeZone = async (user = alice, { kind, published = true } = /** @type {any} */ ({})) => {
  const { zone } = await service.save(user, { title: "Stroke prevention", description: "d", background: "b", ...(kind ? { kind } : {}) });
  return published ? (await service.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone : zone;
};
// Through the internal entry: only it may preserve a source's text, which is what a claim's quotation is checked against.
const publishedCard = (zone, fields = {}, user = alice, origin = "result") => service.saveEditorial(user, { ...cardInput, state: "published", ...fields }, zone.id, null, true, /** @type {any} */ (origin)).then((result) => result.evidence);
const titles = async (q, reader = alice) => (await search.search(reader, { q })).cards.map((card) => card.title);

test("a published card is found by the words of the query, with its primary sources and the instruction, and never its restricted text", options, async () => {
  const zone = await makeZone();
  const card = await publishedCard(zone);
  const { cards, more } = await search.search(bob, { q: "apixaban stroke" });
  assert.equal(more, false);
  assert.equal(cards.length, 1);
  const [found] = cards;
  assert.equal(found.kind, "card");
  assert.equal(found.id, card.id);
  assert.equal(found.title, "Does apixaban prevent stroke?");
  assert.equal(found.question, "Does apixaban prevent stroke?");
  assert.equal(found.answer, "Fewer strokes were seen on apixaban.");
  assert.deepEqual(found.zone, { title: "Stroke prevention", kind: "user" });
  assert.deepEqual(found.producer, { kind: "user", name: "Alice", relation: "none" });
  assert.equal(found.originality, "synthesis");
  assert.deepEqual(found.claims, { total: 2, verified: 1 }, "one of the two quotations is in the source, and the count is the code's");
  assert.equal(found.matchedBy, "text");
  assert.equal(found.instruction, CARD_INDEX_INSTRUCTION);
  assert.deepEqual(found.primarySources, [{ title: "The stroke trial", url: "https://doi.org/10.1000/Stroke.1", doi: "10.1000/stroke.1", pmid: null }]);
  assert.ok(Date.parse(found.lastCheckedAt), "the last checked date falls back to the card's own update time");
  assert.equal("currency" in found, false, "nothing was ever checked, so no label is said");
  assert.equal(JSON.stringify(found).includes("restricted passage"), false, "a source is its title and address; its text stays server-side");
  assert.equal(JSON.stringify(found).includes("documentText"), false);
});

test("never an unpublished card, an unpublished zone's card, or anybody's draft — the owner's own drafts included", options, async () => {
  const zone = await makeZone(alice);
  const draftZone = await makeZone(alice, { published: false });
  await publishedCard(zone, { title: "Published apixaban card" });
  await publishedCard(zone, { title: "Draft apixaban card", state: "draft" });
  await publishedCard(draftZone, { title: "Apixaban card in an unpublished zone", state: "published" }).catch(() => null);
  const bobZone = await makeZone(bob);
  await publishedCard(bobZone, { title: "Bob's draft apixaban card", state: "draft" }, bob);
  assert.deepEqual(await titles("apixaban", bob), ["Published apixaban card"]);
  assert.deepEqual(await titles("apixaban", alice), ["Published apixaban card"], "the owner is shown what every reader is shown: a draft is no index entry to point at");
  // Withdrawn after being found: the next search no longer has it.
  const withdrawn = (await db.query("SELECT id FROM evimed_frontier.evidence_cards WHERE title='Published apixaban card'")).rows[0].id;
  await db.query("UPDATE evimed_frontier.evidence_cards SET state='draft' WHERE id=$1", [withdrawn]);
  assert.deepEqual(await titles("apixaban", bob), []);
  await db.query("UPDATE evimed_frontier.evidence_cards SET state='published' WHERE id=$1", [withdrawn]);
  await db.query("UPDATE evimed_frontier.evidence_zones SET state='draft' WHERE id=$1", [zone.id]);
  assert.deepEqual(await titles("apixaban", bob), [], "a zone taken back to a draft takes its cards with it");
});

test("a card is found by an identifier or an entity key the query names, identifiers first, and says how it matched", options, async () => {
  const zone = await makeZone();
  tagging.card = ["drug:apixaban", "doi:10.1000/stroke.1"];
  await publishedCard(zone, { title: "About the drug and the trial", summary: "x", content: { ...cardInput.content, question: "q", answer: "a" } });
  tagging.card = ["drug:apixaban"];
  await publishedCard(zone, { title: "About the drug only", summary: "x", content: { ...cardInput.content, question: "q", answer: "a" } });
  tagging.card = ["drug:warfarin"];
  await publishedCard(zone, { title: "About another drug", summary: "x", content: { ...cardInput.content, question: "q", answer: "a" } });
  tagging.query = ["drug:apixaban"];
  const byEntity = (await search.search(bob, { q: "zzzz" })).cards;
  assert.deepEqual(byEntity.map((card) => [card.title, card.matchedBy]).sort(), [["About the drug and the trial", "entity"], ["About the drug only", "entity"]]);
  tagging.query = ["drug:apixaban", "doi:10.1000/stroke.1"];
  const byIdentifier = (await search.search(bob, { q: "zzzz" })).cards;
  assert.deepEqual(byIdentifier.map((card) => [card.title, card.matchedBy]), [["About the drug and the trial", "identifier"], ["About the drug only", "entity"]], "the work itself outranks a shared subject");
  tagging.query = [];
  assert.deepEqual(await titles("zzzz"), [], "a name the glossary does not hold is only a word, and nothing matches it");
});

test("official and product zones' cards are found too, each saying who made it and how it relates to the product", options, async () => {
  const { zone: official } = await service.saveEditorial(publisher, { title: "Official", description: "d", background: "b", kind: "official" }, null, null, false, "programme");
  const published = (await service.saveEditorial(publisher, { expectedRevision: official.revision, state: "published" }, official.id, null, false, "programme")).zone;
  await service.saveEditorial(publisher, { ...cardInput, state: "published", title: "Official apixaban synthesis" }, published.id, null, true, "programme");
  const productZone = await makeZone(alice, { kind: "product" });
  await publishedCard(productZone, { ...productFields, title: "Acme apixaban story" }, alice, "geo");
  const cards = (await search.search(bob, { q: "apixaban" })).cards;
  const byTitle = Object.fromEntries(cards.map((card) => [card.title, card]));
  assert.deepEqual(byTitle["Official apixaban synthesis"].producer, { kind: "platform", name: "EviMed 证据中心", relation: "none" });
  assert.equal(byTitle["Official apixaban synthesis"].zone.kind, "official");
  assert.deepEqual(byTitle["Acme apixaban story"].producer, { kind: "enterprise", name: "Acme Pharma", relation: "own_product" });
  assert.equal(byTitle["Acme apixaban story"].zone.kind, "product");
});

test("at most five cards, newest first, and it says when there were more", options, async () => {
  const zone = await makeZone();
  for (let index = 0; index < CARD_SEARCH_MAX + 2; index += 1) await publishedCard(zone, { title: `Apixaban card ${index}` });
  const { cards, more } = await search.search(bob, { q: "apixaban", limit: 20 });
  assert.equal(cards.length, CARD_SEARCH_MAX);
  assert.equal(more, true);
  assert.deepEqual(cards.map((card) => card.title), ["Apixaban card 6", "Apixaban card 5", "Apixaban card 4", "Apixaban card 3", "Apixaban card 2"]);
  assert.equal((await search.search(bob, { q: "apixaban", limit: 2 })).cards.length, 2);
});

test("the currency label is said only for a card whose sources were checked, and a source change shows", options, async () => {
  const zone = await makeZone();
  await publishedCard(zone);
  const unchecked = createEvidenceCardSearch({ database: db, sourceChanges: { changesForCardSources: async (sources) => sources.map((_s, index) => ({ index, identifiers: [], changes: [], lastCheckedAt: null, state: "unknown" })) } });
  assert.equal("currency" in (await unchecked.search(bob, { q: "apixaban" })).cards[0], false);
  const clean = createEvidenceCardSearch({ database: db, sourceChanges: { changesForCardSources: async (sources) => sources.map((_s, index) => ({ index, identifiers: [], changes: [], lastCheckedAt: "2026-10-04T00:00:00Z", state: "clean" })) } });
  assert.equal((await clean.search(bob, { q: "apixaban" })).cards[0].currency, "current");
  const retracted = createEvidenceCardSearch({ database: db, sourceChanges: { changesForCardSources: async (sources) => sources.map((_s, index) => ({ index, identifiers: [], changes: [{ kind: "retraction" }], lastCheckedAt: "2026-10-04T00:00:00Z", state: "changed" })) } });
  assert.equal((await retracted.search(bob, { q: "apixaban" })).cards[0].currency, "source_changed");
  const failing = createEvidenceCardSearch({ database: db, sourceChanges: { changesForCardSources: async () => { throw new Error("store down"); } } });
  const answered = (await failing.search(bob, { q: "apixaban" })).cards[0];
  assert.equal(answered.title, "Does apixaban prevent stroke?", "a store that cannot answer costs the label, not the card");
  assert.equal("currency" in answered, false);
});

test("the query is cut into at most six words of two characters or more", () => {
  assert.deepEqual(cardQueryTerms("  GLP-1   心衰 a  semaglutide HFpEF  GLP-1 one two three four "), ["glp-1", "心衰", "semaglutide", "hfpef", "one", "two"]);
  assert.deepEqual(cardQueryTerms("a b c"), []);
});

test("in front of the real gateway a run's search answers items and cards together, and with the module's cards off it is the old answer", options, async (t) => {
  const zone = await makeZone();
  await publishedCard(zone);
  const items = { async listItems() { return { status: 200, body: { items: [], nextCursor: null, mode: "list" } }; }, allows: () => true };
  const runtimeManager = { assertActiveModelGatewayToken: () => ({ userId: "bob", projectId: "project-1" }) };
  const ask = async (cards) => {
    const handler = createFrontierGatewayHandler({ frontierEnabled: true }, runtimeManager, { service: items, ...(cards ? { cards } : {}) });
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${FRONTIER_GATEWAY_PATH}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify({ q: "apixaban", mode: "all" }),
      });
      return { status: response.status, body: (await response.json()).data };
    } finally { await new Promise((resolve) => server.close(resolve)); }
  };
  const withCards = await ask(search);
  assert.equal(withCards.status, 200);
  assert.deepEqual(withCards.body.items, []);
  assert.deepEqual(withCards.body.cards.map((card) => card.title), ["Does apixaban prevent stroke?"]);
  const without = await ask(null);
  assert.equal("cards" in without.body, false);
  t.diagnostic("the gateway answered with and without the card module");
});
