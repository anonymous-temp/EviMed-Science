// A card never stores the full text of a source that has no public address (evidence-flywheel review fix 11, 2026-10-06), against a real
// PostgreSQL. A researcher's own uploaded document reached a card as a source's retained text through the result publisher; the card
// view strips the text, but "continue research from this card" wrote it into another account's knowledge base. The writers no longer
// keep it, the claims that quote it stay ✓ by the passages they quote, the continuation hands citations and addresses only, and the
// rows an earlier release wrote are cleaned by the zone migration.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceCardFromResult } from "../src/evidenceCardFromResult.mjs";
import { EvidenceContinuation, evidenceSourceRecord } from "../src/evidenceContinuation.mjs";
import { EvidenceOrigins } from "../src/evidenceOrigins.mjs";
import { buildProgrammeCard } from "../src/evidenceProgrammeCard.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { EVIDENCE_ZONE_SQL } from "../src/evidenceZonePersistence.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { clinicalResultFixture, QUOTES } from "./helpers/clinicalResultFixture.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice", name: "Alice Li" };
const bob = { id: "bob", name: "Bob" };
/** The private document: a sentence the claim quotes, and one the card must never carry. */
const PRIVATE_SECRET = "UNPUBLISHED-ENROLMENT-FIGURE-4321";

/** @type {any} */ let isolated, db, zones;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "privatetext");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice Li','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: "publisher" });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => { if (db) await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE"); });

const ownZone = async (user = alice) => {
  const { zone } = await zones.save(user, { title: "My research", description: "", background: "" });
  return (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
};
const rawCard = async (/** @type {string} */ id) => (await db.query("SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1", [id])).rows[0];

test("the zone service keeps no text for a source with no public address, and keeps it for one that has one", options, async () => {
  const zone = await ownZone();
  const text = `Public paragraph. ${PRIVATE_SECRET} A private paragraph that is only the researcher's.`;
  const card = (await zones.saveEditorial(alice, {
    title: "A card", subtype: "academic", summary: "s", body: "b", limitations: "l", provenance: "p", state: "published",
    sources: [
      { title: "Public trial", url: "https://example.org/a", excerpt: "Public paragraph.", documentText: text, coverage: "full-text", fetchedSha256: "a".repeat(64) },
      { title: "My uploaded report", excerpt: "Public paragraph.", documentText: text, coverage: "full-text", fetchedSha256: "b".repeat(64) },
    ],
  }, zone.id, null, true, "result")).evidence;
  const row = await rawCard(card.id);
  assert.equal(row.sources[0].documentText, text, "a source with a public address keeps its text, as it did");
  assert.equal(row.sources[1].documentText, undefined, "a source without one does not");
  assert.equal(row.sources[1].coverage, "excerpt", "and is no longer full text");
  assert.equal(row.sources[1].fetchedSha256, "b".repeat(64), "the receipt of what the platform read stays");
  assert.equal(JSON.stringify(row).includes(PRIVATE_SECRET), true, "the premise: the public one still holds it");
  assert.equal(JSON.stringify(row.sources[1]).includes(PRIVATE_SECRET), false);
  // The hash a writer computed over the text it was given is accepted, and the card's own is over what it holds.
  assert.equal((await zones.saveEditorial(alice, {
    title: "Another", subtype: "academic", summary: "s", body: "b", limitations: "l", provenance: "p", state: "published", requestId: "private-hash-card",
    sources: [{ title: "Mine", excerpt: "Public paragraph.", documentText: text, sha256: (await import("../src/evidenceCardContent.mjs")).evidenceHash(text) }],
  }, zone.id, null, true, "result")).evidence.sources[0].title, "Mine");
});

test("a result card from a researcher's own document keeps its claims ✓ by the passages they quote, and never the document", options, async (t) => {
  const f = await clinicalResultFixture(t, { unaddressed: ["A"], claims: ["CLM-001", "CLM-004"] });
  // The private document's text, as the run preserved it: the claim's quotation and a sentence the card must never carry.
  const { report } = await f.deliver();
  const zone = await ownZone();
  const answer = await new EvidenceCardFromResult({ database: db, results: f.results, zones, runs: { list: async () => [f.run] } })
    .publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, claimIds: ["CLM-001", "CLM-004"] });
  const row = await rawCard(answer.evidence.id);
  const mine = row.sources.find((/** @type {any} */ source) => /Trial A/.test(source.title));
  assert.equal(mine.url, null, "the premise: a document with no public address");
  assert.equal(mine.documentText, undefined, "its text is not on the card");
  assert.ok(mine.fetchedSha256, "the receipt of what the platform read is");
  assert.equal(mine.excerpt.includes(QUOTES.A), true, "the passage the claims quote is the excerpt");
  assert.deepEqual(answer.evidence.claims.map((/** @type {any} */ claim) => [claim.claimId, claim.verification.mark]), [["CLM-001", "✓"], ["CLM-004", "✓"]], "and the claims that quote it stay ✓");
  assert.equal(JSON.stringify(row).includes("The trial was open-label."), false, "nothing else of the document is on the card");
  const other = row.sources.find((/** @type {any} */ source) => /Trial B/.test(source.title));
  assert.ok(other.documentText, "a source with a public address is kept as before");
});

test("a source too large to keep whole carries the passages its claims quote, so each of them stays ✓ without the document", options, async (t) => {
  const f = await clinicalResultFixture(t, { oversize: ["A"], claims: ["CLM-001", "CLM-006"] });
  const { report } = await f.deliver();
  const zone = await ownZone();
  const answer = await new EvidenceCardFromResult({ database: db, results: f.results, zones, runs: { list: async () => [f.run] } })
    .publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, claimIds: ["CLM-001", "CLM-006"] });
  const row = await rawCard(answer.evidence.id);
  assert.equal(row.sources[0].documentText, undefined, "past what a card keeps whole");
  assert.ok(row.sources[0].excerpt.includes(QUOTES.A) && row.sources[0].excerpt.includes("The trial was open-label."), "both passages are the excerpt");
  assert.deepEqual(answer.evidence.claims.map((/** @type {any} */ claim) => [claim.claimId, claim.verification.mark]), [["CLM-001", "✓"], ["CLM-006", "✓"]]);
});

test("the programme keeps no whole text of a source with no public address either, only the passages its claims stand on", () => {
  const text = `Intro. ${QUOTES.A} ${PRIVATE_SECRET}`;
  const claim = (/** @type {string} */ id, /** @type {string | undefined} */ sourceUrl) => ({ claimId: id, claimType: "direct", claim: "c", artifactPath: "p/a.md", supportQuote: QUOTES.A, ...(sourceUrl ? { sourceUrl } : {}), sourceTitle: "Doc", accessLevel: "full_text" });
  const build = (/** @type {string | undefined} */ sourceUrl) => buildProgrammeCard({
    zone: { id: "ez_1", title: "Z" }, question: "q", taskType: "evidence-update", capabilityId: "clinical-evidence-synthesis", decisionId: "d", agenda: { id: "a" }, episode: { id: "e" },
    runId: "r", resultVersionId: "rv_1", evaluation: { included: [{ claim: claim("C1", sourceUrl), headline: true }], excluded: [] },
    captured: new Map([["p/a.md", { text, digest: "c".repeat(64), capturedAt: "2026-10-05T00:00:00Z" }]]), model: "m", at: new Date("2026-10-05T00:00:00Z"),
  });
  const addressed = /** @type {any} */ (build("https://example.org/doc"));
  assert.equal(addressed.status, "card");
  assert.equal(addressed.card.sources[0].documentText, text, "a public source is kept whole, as before");
  const private_ = /** @type {any} */ (build(undefined));
  assert.equal(private_.status, "card");
  assert.equal(private_.card.sources[0].documentText, undefined);
  assert.equal(JSON.stringify(private_.card.sources[0]).includes(PRIVATE_SECRET), false);
  assert.equal(private_.card.sources[0].excerpt, QUOTES.A, "the quotations the card stands on");
});

test("continuing from a card hands the other account citations and addresses and never a source's text, whatever an older row holds", options, async () => {
  const zone = await ownZone();
  const card = (await zones.saveEditorial(alice, {
    title: "Mixed card", subtype: "academic", summary: "SUMMARY", body: "BODY", limitations: "l", provenance: "p", state: "published",
    sources: [{ title: "Public trial", url: "https://example.org/a", excerpt: "Public paragraph.", documentText: `Public paragraph. WHOLE-PUBLIC-TEXT`, coverage: "full-text" },
      { title: "My uploaded report", excerpt: "Public paragraph.", coverage: "excerpt" }],
  }, zone.id, null, true, "result")).evidence;
  // An older row: the private text is on it (written by a release before this one).
  await db.query(`UPDATE evimed_frontier.evidence_cards SET sources=jsonb_set(sources,'{1,documentText}',to_jsonb($2::text)) WHERE id=$1`, [card.id, `Public paragraph. ${PRIVATE_SECRET}`]);
  const saved = /** @type {any[]} */ ([]);
  const origins = new EvidenceOrigins({ database: db, cited: async () => {} });
  const continuation = new EvidenceContinuation({
    database: db, origins,
    library: { project: async (user, projectId) => ({ id: projectId, userId: user.id }), save: async ({ rel, buffer }) => { saved.push({ rel, text: buffer.toString("utf8") }); } },
    createProject: async () => ({ id: "continued" }), bindSession: async () => {},
  });
  const answer = await continuation.start(bob, card.id, {});
  assert.equal(saved.length, 2);
  const all = saved.map((file) => file.text).join("\n");
  assert.equal(all.includes(PRIVATE_SECRET), false, "a source with no public address is cited and nothing more");
  assert.equal(all.includes("WHOLE-PUBLIC-TEXT"), false, "and not even a public source's whole text: the account reads the address itself");
  assert.ok(saved[0].text.includes("原文链接：https://example.org/a") && saved[0].text.includes("Public paragraph."), "the address and the passage the card shows");
  assert.equal(saved[1].text.includes("原文链接"), false, "a source with no public address is cited by its title and the passage the card shows");
  assert.match(saved[1].text, /^# My uploaded report/);
  assert.deepEqual(answer.library.saved.map((/** @type {any} */ file) => file.kind), ["record", "record"]);
  assert.equal(evidenceSourceRecord({ card: { title: "c" }, source: { title: "t", documentText: "SECRET", url: "https://example.org/x" }, index: 1 }).markdown.includes("SECRET"), false);
});

test("the zone migration takes the text off a source with no public address on a card and on its revision snapshots, and runs twice", options, async () => {
  const zone = await ownZone();
  const card = (await zones.saveEditorial(alice, {
    title: "Older", subtype: "academic", summary: "s", body: "b", limitations: "l", provenance: "p", state: "published",
    sources: [{ title: "Public trial", url: "https://example.org/a", excerpt: "x", documentText: "PUBLIC-TEXT", coverage: "full-text" }, { title: "Mine", excerpt: "y" }],
  }, zone.id, null, true, "result")).evidence;
  // As release 6 could have written them: the private source holds its text and says full text, on the card and in its snapshot.
  const dirty = (/** @type {string} */ column) => `jsonb_set(jsonb_set(${column},'{1,documentText}',to_jsonb($2::text)),'{1,coverage}','"full-text"')`;
  await db.query(`UPDATE evimed_frontier.evidence_cards SET sources=${dirty("sources")} WHERE id=$1`, [card.id, PRIVATE_SECRET]);
  await db.query(`UPDATE evimed_frontier.evidence_card_revisions SET snapshot=jsonb_set(snapshot,'{sources}',${dirty("snapshot->'sources'")}) WHERE card_id=$1`, [card.id, PRIVATE_SECRET]);
  assert.equal(JSON.stringify(await rawCard(card.id)).includes(PRIVATE_SECRET), true, "the premise");
  const run = () => db.transaction(async (/** @type {any} */ client) => { await client.query(EVIDENCE_ZONE_SQL); });
  await run();
  const row = await rawCard(card.id);
  assert.equal(JSON.stringify(row).includes(PRIVATE_SECRET), false);
  assert.deepEqual([row.sources[1].documentText, row.sources[1].coverage, row.sources[1].excerpt, row.sources[1].title], [undefined, "excerpt", "y", "Mine"]);
  assert.equal(row.sources[0].documentText, "PUBLIC-TEXT", "a source with a public address is untouched");
  assert.equal(row.sources[0].coverage, "full-text");
  const snapshot = (await db.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1", [card.id])).rows[0].snapshot;
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE_SECRET), false);
  assert.equal(snapshot.sources[0].documentText, "PUBLIC-TEXT");
  const revision = (await rawCard(card.id)).revision;
  await run();
  assert.equal((await rawCard(card.id)).revision, revision, "a second run changes nothing and a cleaning is not an edit");
});
