// "✓ means the platform read the source" (evidence-flywheel review fix 2, 2026-10-06), against a real PostgreSQL: a card an author
// writes over the service's own door carries an excerpt they typed, and its quotation is ⚠ author_excerpt_only until the platform
// has read the address. The owner's request reads each source through the reader the editor uses, keeps what it read the way
// the editor keeps it, and the claims re-verify; what cannot be read stays as written and is reported per source.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidenceSourceVerification, evidenceSourceVerificationMetricFamilies } from "../src/evidenceSourceVerification.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let isolated, db, service;
const alice = { id: "alice" }, bob = { id: "bob" };
const PAGE = "In this randomized trial, 7 of 100 adults on the drug had a stroke. Major bleeding occurred in 3 of 100 on the drug.";

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "sourceverify");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice','development'),('bob','Bob','development')");
  service = new EvidenceZoneService({ database: db });
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => {
  if (db) await db.query("TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.evidence_source_reads CASCADE").catch(() => db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE"));
});

/** A reader double: the page at each address, or the named refusal. @param {Record<string, string | { code: string }>} pages */
function reader(pages) {
  /** @type {string[]} */
  const asked = [];
  const read = async (/** @type {string} */ address) => {
    asked.push(address);
    const page = pages[address];
    if (page && typeof page === "object") throw Object.assign(new Error(page.code), { code: page.code });
    if (page === undefined) throw Object.assign(new Error("gone"), { code: "web_read_not_found" });
    return { text: page, coverage: "full-text", receipt: { sha256: "d".repeat(64), truncated: false } };
  };
  return { read, asked };
}

const zoneFor = async (/** @type {any} */ user = alice) => {
  const { zone } = await service.save(user, { title: "Stroke", description: "d", background: "b" });
  return (await service.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
};
/** A card as an account writes it: an excerpt it typed, a quotation that matches it. */
const cardFor = async (/** @type {any} */ zone, /** @type {any[]} */ sources, /** @type {any[]} */ claims, user = alice) => (await service.save(user, {
  title: "A trial", subtype: "academic", summary: "s", body: "The trial describes outcomes.", limitations: "l", provenance: "p", sources, claims,
}, zone.id, null, true)).evidence;
const statusOf = (/** @type {any} */ evidence, /** @type {string} */ claimId) => evidence.claims.find((/** @type {any} */ claim) => claim.claimId === claimId)?.verification;
const stored = async (/** @type {string} */ id) => (await db.query("SELECT sources,revision FROM evimed_frontier.evidence_cards WHERE id=$1", [id])).rows[0];

const TYPED = [
  { title: "Trial", url: "https://example.org/trial", excerpt: "7 of 100 adults on the drug had a stroke" },
  { title: "Label", url: "https://example.org/label", excerpt: "Do not use with severe bleeding." },
  { title: "Restricted", url: "https://example.org/private", excerpt: "A paywalled sentence." },
  { title: "Down", url: "https://example.org/down", excerpt: "Another sentence." },
  { title: "Cited by title only", excerpt: "No address, only what the author typed." },
];
const CLAIMS = [
  { claimId: "C1", claimType: "direct", claim: "Strokes were rarer on the drug.", sourceIndexes: [1], supportQuote: "7 of 100 adults on the drug had a stroke" },
  { claimId: "C2", claimType: "direct", claim: "Bleeding was more frequent.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 9 of 100 on the drug" },
  { claimId: "C3", claimType: "direct", claim: "Use is restricted.", sourceIndexes: [3], supportQuote: "A paywalled sentence." },
];

test("an author's typed excerpt and matching quotation are ⚠ author_excerpt_only, never ✓", options, async () => {
  const card = await cardFor(await zoneFor(), TYPED, CLAIMS);
  assert.equal(statusOf(card, "C1").status, "author_excerpt_only");
  assert.equal(statusOf(card, "C1").mark, "⚠");
  assert.equal(card.claimVerification.verified, 0);
  assert.equal(card.claimVerification.author_excerpt_only, 2);
  assert.equal(statusOf(card, "C2").mark, "⚠");
});

test("the owner's request reads each address, keeps what it read as the editor keeps it, and the claim re-verifies", options, async () => {
  const card = await cardFor(await zoneFor(), TYPED, CLAIMS);
  const pages = reader({ "https://example.org/trial": PAGE, "https://example.org/label": "Do not use with severe bleeding.", "https://example.org/private": { code: "web_read_login_required" } });
  const verification = createEvidenceSourceVerification({ database: db, zones: service, readSource: pages.read, perDay: 60 });
  const answer = await verification.verify(alice, card.id);
  assert.deepEqual(answer.sources.map((/** @type {any} */ entry) => [entry.sourceIndex, entry.status, entry.code ?? null]), [
    [1, "read", null], [2, "read", null], [3, "restricted", "web_read_login_required"], [4, "unreachable", "web_read_not_found"], [5, "no_address", null],
  ]);
  assert.equal(statusOf(answer.evidence, "C1").status, "verified", "the quotation is in the text the platform read");
  assert.equal(statusOf(answer.evidence, "C1").mark, "✓");
  assert.equal(statusOf(answer.evidence, "C2").status, "quote_not_found", "the platform's text outranks the author's excerpt");
  assert.equal(statusOf(answer.evidence, "C3").mark, "⚠", "a restricted source stays as the author wrote it");
  assert.equal(statusOf(answer.evidence, "C3").status, "author_excerpt_only");
  const row = await stored(card.id);
  assert.equal(row.sources[0].documentText, PAGE, "the retained text is stored");
  assert.equal(row.sources[0].fetchedSha256, "d".repeat(64), "with the receipt of the bytes the platform read");
  assert.equal(row.sources[2].documentText, undefined);
  assert.equal(row.sources[2].fetchedSha256, undefined);
  assert.equal(row.sources[2].excerpt, "A paywalled sentence.", "the author's excerpt is untouched");
  assert.equal(row.revision, card.revision + 1);
  assert.ok(!JSON.stringify(answer.evidence.sources).includes("documentText"), "the response carries no retained text");
  assert.deepEqual(pages.asked, ["https://example.org/trial", "https://example.org/label", "https://example.org/private", "https://example.org/down"], "no address was read for a source without one");
});

test("a source the platform already read is not read again, and an ask with nothing to read is not a failure", options, async () => {
  const card = await cardFor(await zoneFor(), TYPED.slice(0, 2), CLAIMS.slice(0, 1));
  const pages = reader({ "https://example.org/trial": PAGE, "https://example.org/label": "Do not use with severe bleeding." });
  const verification = createEvidenceSourceVerification({ database: db, zones: service, readSource: pages.read, perDay: 60 });
  await verification.verify(alice, card.id);
  assert.equal(pages.asked.length, 2);
  const again = await verification.verify(alice, card.id);
  assert.deepEqual(again.sources.map((/** @type {any} */ entry) => entry.status), ["already_read", "already_read"]);
  assert.equal(pages.asked.length, 2, "nothing was read the second time");
  assert.equal(again.evidence, null, "nothing changed, so nothing was saved");
  assert.equal((await stored(card.id)).revision, card.revision + 1);
});

test("an account reads at most its daily number of sources, and the rest wait for the next request, then the next day", options, async () => {
  const card = await cardFor(await zoneFor(), TYPED.slice(0, 4), CLAIMS.slice(0, 1));
  const pages = reader({ "https://example.org/trial": PAGE, "https://example.org/label": "Do not use with severe bleeding.", "https://example.org/private": "x", "https://example.org/down": "y" });
  const verification = createEvidenceSourceVerification({ database: db, zones: service, readSource: pages.read, perDay: 3 });
  const first = await verification.verify(alice, card.id);
  assert.deepEqual(first.sources.map((/** @type {any} */ entry) => entry.status), ["read", "read", "read", "not_read"]);
  assert.equal(first.sources[3].code, "evidence_source_read_deferred");
  assert.equal(pages.asked.length, 3);
  await assert.rejects(verification.verify(alice, card.id), { status: 429, code: "evidence_source_verification_rate_limited" });
  assert.equal(pages.asked.length, 3, "a refused request read nothing");
  // The rolling day: the three reads age out, and the fourth source is taken.
  await db.query("UPDATE evimed_frontier.evidence_source_reads SET read_at=clock_timestamp()-interval '25 hours'");
  assert.equal((await verification.verify(alice, card.id)).sources[3].status, "read");
  const text = Object.fromEntries(evidenceSourceVerificationMetricFamilies(verification.stats()).map((family) => [family.name, family.series]));
  assert.equal(text.open_science_evidence_source_verifications_total.find((entry) => entry.labels?.outcome === "rate_limited")?.value, 1);
  assert.equal(text.open_science_evidence_source_reads_total.find((entry) => entry.labels?.outcome === "read")?.value, 4);
});

test("only the owner of the card and of its zone may ask, and a withdrawn card is not read", options, async () => {
  const card = await cardFor(await zoneFor(), TYPED.slice(0, 1), CLAIMS.slice(0, 1));
  const pages = reader({ "https://example.org/trial": PAGE });
  const verification = createEvidenceSourceVerification({ database: db, zones: service, readSource: pages.read, perDay: 60 });
  await assert.rejects(verification.verify(bob, card.id), { status: 404, code: "evidence_not_found" });
  await assert.rejects(verification.verify(alice, "ec_missing"), { status: 404, code: "evidence_not_found" });
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn='{\"at\":\"2026-10-06T00:00:00Z\",\"reason\":\"test\"}'::jsonb WHERE id=$1", [card.id]);
  await assert.rejects(verification.verify(alice, card.id), { status: 409, code: "evidence_card_withdrawn" });
  assert.deepEqual(pages.asked, [], "no one else's request, and no withdrawn card, reached the reader");
});
