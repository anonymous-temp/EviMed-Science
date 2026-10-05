// 「发布为证据卡」 (evidence-flywheel F05, 2026-10-05): a result version of a clinical package becomes a draft card in a zone
// its researcher owns — with only the verified claims by default, the preserved sources hashed, a restricted source cited
// and nothing more, and every refusal named. Built on the real capture and the real zone service.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceCardFromResult, readResultCardRequest, resultOriginality } from "../src/evidenceCardFromResult.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { evidencePublishMetricFamilies, resetEvidencePublishMetrics } from "../src/evidencePublishMetrics.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { clinicalResultFixture, QUOTES } from "./helpers/clinicalResultFixture.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice", name: "Alice Li" };
const bob = { id: "bob", name: "Bob" };
const publisher = { id: "publisher", name: "Platform publisher" };

/** @type {any} */ let isolated, db, zones;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "resultcard");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Alice Li','development'),('bob','Bob','development'),('publisher','Platform publisher','development')");
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
});

const ownZone = async (user = alice, fields = {}) => {
  const { zone } = await zones.save(user, { title: "My research", description: "", background: "", ...fields });
  return (await zones.save(user, { expectedRevision: zone.revision, state: "published" }, zone.id)).zone;
};
const rawCard = async (cardId) => (await db.query("SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1", [cardId])).rows[0];
const counter = (name, label, value) => evidencePublishMetricFamilies({ citationGiftEnabled: false }).find((family) => family.name === name)?.series.find((series) => series.labels?.[label] === value)?.value;
/** @param {any} fixture @param {any} [runs] */
const publisherFor = (fixture, runs = [fixture.run]) => new EvidenceCardFromResult({ database: db, results: fixture.results, zones, runs: { list: async () => runs } });
const names = (claims) => claims.map((claim) => claim.claimId);
const refused = (code, status) => (error) => {
  assert.equal(error.code, code, `refused as ${code}, not ${error.code}`);
  if (status) assert.equal(error.status, status);
  return true;
};

test("a clinical result becomes a draft with only its verified claims, hashed sources, lineage and the account's own name", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  assert.equal(report.review.status, "available");
  const zone = await ownZone();
  const answer = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id });
  assert.equal(answer.created, true);
  assert.equal(answer.outcome, "created");
  const card = answer.evidence;
  assert.equal(card.state, "draft", "publishing stays the researcher's own click");
  assert.equal(card.zoneId, zone.id);
  assert.equal(card.title, "Does the drug prevent stroke?", "the report's own heading");
  // The verified ones: the unverified quotation and the analyst's estimate are not in by default.
  assert.deepEqual(names(card.claims), ["CLM-001", "CLM-004", "CLM-005"]);
  assert.deepEqual(answer.omitted, []);
  // The card's own marks, computed against the preserved text it carries, agree with the run's: all three ✓.
  assert.deepEqual(card.claims.map((claim) => claim.verification.mark), ["✓", "✓", "✓"]);
  assert.deepEqual(card.claimVerification, { total: 3, verified: 3, quote_not_found: 0, source_unavailable: 0, no_quote: 0, derived: 0 });
  // Sources are the trials the claims rest on, in the order claims first meet them, each with the hash of what was kept.
  assert.deepEqual(card.sources.map((source) => source.title), ["Trial A", "Trial B", "Trial R"]);
  const row = await rawCard(card.id);
  for (const [position, key] of ["A", "B", "R"].entries()) {
    const source = row.sources[position];
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(source.fetchedSha256, f.sources[key].digest, "the hash of the preserved bytes the capture recorded");
    assert.equal(source.coverage, "full-text");
    assert.ok(source.documentText.includes("randomized trial") || source.documentText.includes("second trial") || source.documentText.includes("registry"), "the preserved text is carried");
    assert.ok(source.excerpt.split(/\s+/).length <= 26, "a reader sees a short anchor, not the document");
    assert.ok(!("documentText" in card.sources[position]), "and never the whole text");
  }
  assert.equal(card.claims[0].supportQuote, QUOTES.A);
  assert.deepEqual(card.claims[1].supportingSources.map((bond) => bond.sourceIndex), [1, 2]);
  assert.equal(card.claims[1].confidence, "moderate");
  // Who made it, how, and where it came from.
  assert.equal(card.producer.kind, "user");
  assert.equal(card.producer.name, "Alice Li");
  assert.equal(card.originality, "synthesis");
  assert.deepEqual(card.lineage, { resultVersionId: report.versionId, runId: "run_one" });
  assert.equal(card.disclosure.model, "deepseek-v4-flash");
  assert.deepEqual(card.disclosure.aiSteps, ["search", "screen", "extract", "synthesize"]);
  assert.deepEqual(card.disclosure.authors, [{ name: "Alice Li" }]);
  assert.equal(card.disclosure.generatedAt, report.capturedAt);
  // No comparison is invented: this matrix carries no events or denominators.
  assert.equal(card.content.comparisons, undefined);
  assert.match(card.content.question, /人群：Adults at risk of stroke/);
  assert.equal(counter("open_science_evidence_result_cards_total", "outcome", "created"), 1);
});

test("an unverified claim is in only when the caller names it, and the card then marks it ⚠", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  const zone = await ownZone();
  const answer = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, claimIds: ["CLM-001", "CLM-002"] });
  assert.deepEqual(names(answer.evidence.claims), ["CLM-001", "CLM-002"], "exactly the selection");
  assert.deepEqual(answer.evidence.claims.map((claim) => claim.verification.mark), ["✓", "⚠"]);
  assert.equal(answer.evidence.claims[1].verification.status, "quote_not_found");
});

test("a derived claim comes with the claims it reasons from, and is left out, said so, when they are not selected", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  const zone = await ownZone();
  const withInput = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, claimIds: ["CLM-001", "CLM-003"] });
  assert.deepEqual(names(withInput.evidence.claims), ["CLM-001", "CLM-003"]);
  assert.equal(withInput.evidence.claims[1].claimType, "derived");
  assert.equal(withInput.evidence.claims[1].verification.mark, null, "an estimate has inputs, not a quotation");
  const other = await ownZone(alice, { title: "Another" });
  const alone = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: other.id, claimIds: ["CLM-003", "CLM-004"] }).catch((error) => error);
  // The version already has its draft (idempotent by lineage), so the second request is that draft.
  assert.equal(alone.created, false);
  const g = await clinicalResultFixture(t, { runId: "run_two", reportTitle: "Second" });
  const second = await g.deliver();
  const answer = await publisherFor(g).publish(alice, second.report.versionId, { projectId: "p", zoneId: other.id, claimIds: ["CLM-003", "CLM-004"] });
  assert.deepEqual(names(answer.evidence.claims), ["CLM-004"]);
  assert.deepEqual(answer.omitted, [{ claimId: "CLM-003", reason: "derived_inputs_missing" }]);
});

test("a restricted source gives its citation and nothing else: no text, no excerpt, no quotation", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  // The project can no longer authorize source R: the result's own read withholds the matrix text and any quotation of it.
  f.access.restricted.add(f.sources.R.doi);
  const projected = await f.results.get("alice", "p", report.versionId);
  assert.equal(projected.review.status, "unavailable", "the premise: the projected result holds back its review");
  const zone = await ownZone();
  const byDefault = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id });
  assert.deepEqual(names(byDefault.evidence.claims), ["CLM-001", "CLM-004"], "a claim resting on a source it may not read is not verified by default");
  const other = await ownZone(alice, { title: "Cited" });
  const g = await clinicalResultFixture(t, { runId: "run_two", reportTitle: "Cited" });
  g.access.restricted.add(g.sources.R.doi);
  const second = await g.deliver();
  g.access.restricted.add(g.sources.R.doi);
  const answer = await publisherFor(g).publish(alice, second.report.versionId, { projectId: "p", zoneId: other.id, claimIds: ["CLM-005"] });
  const [claim] = answer.evidence.claims;
  assert.equal(claim.claimId, "CLM-005");
  assert.equal(claim.supportQuote, undefined, "no quotation beyond what the result may show");
  assert.equal(claim.verification.mark, "⚠", "a reader cannot check what the card does not show");
  assert.equal(claim.verification.status, "no_quote");
  assert.equal(answer.evidence.sources.length, 1);
  assert.equal(answer.evidence.sources[0].title, "Trial R");
  assert.equal(answer.evidence.sources[0].url, "https://example.org/R", "its citation is kept");
  const row = await rawCard(answer.evidence.id);
  assert.equal(row.sources[0].documentText, undefined);
  assert.equal(row.sources[0].excerpt, null);
  assert.equal(row.sources[0].fetchedSha256, undefined);
  assert.ok(!JSON.stringify(row).includes("4,321"), "not a word of the restricted source is in the card");
});

test("refusals are named: not a clinical package, no verified claim, an unknown claim, a zone that is not the caller's, not a user zone", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  const plain = await f.capturePlain();
  const zone = await ownZone();
  const service = publisherFor(f);
  const request = (fields = {}) => ({ projectId: "p", zoneId: zone.id, ...fields });
  await assert.rejects(service.publish(alice, plain.versionId, request()), refused("evidence_result_not_clinical_package", 409));
  await assert.rejects(service.publish(alice, report.versionId, request({ claimIds: [] })), refused("evidence_result_no_verified_claim", 409));
  await assert.rejects(service.publish(alice, report.versionId, request({ claimIds: ["CLM-404"] })), refused("evidence_result_claim_unknown", 400));
  await assert.rejects(service.publish(alice, report.versionId, { projectId: "p" }), refused("evidence_result_zone_required", 400));
  await assert.rejects(service.publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, newZone: { title: "x" } }), refused("evidence_result_zone_required", 400));
  await assert.rejects(service.publish(alice, report.versionId, { projectId: "p", zoneId: zone.id, extra: 1 }), refused("evidence_result_request_invalid", 400));
  // A zone that is not the caller's: visible (published) but another account's.
  const theirs = await ownZone(bob, { title: "Bob's zone" });
  await assert.rejects(service.publish(alice, report.versionId, request({ zoneId: theirs.id })), refused("evidence_result_zone_not_owned", 403));
  // Another account's unpublished zone is simply not there.
  const hidden = (await zones.save(bob, { title: "Bob's draft", description: "", background: "" })).zone;
  await assert.rejects(service.publish(alice, report.versionId, request({ zoneId: hidden.id })), refused("evidence_not_found", 404));
  // An official zone is the platform's.
  const official = (await zones.saveEditorial(publisher, { title: "Official", description: "", background: "", kind: "official" }, null, null, false, "programme")).zone;
  await zones.saveEditorial(publisher, { expectedRevision: official.revision, state: "published" }, official.id, null, false, "programme");
  await assert.rejects(service.publish(alice, report.versionId, request({ zoneId: official.id })), refused("evidence_result_zone_kind_refused", 409));
  // And so is a product zone, even the caller's own: a result is a researcher's voice.
  const product = (await zones.save(alice, { title: "My product", description: "", background: "", kind: "product" })).zone;
  await assert.rejects(service.publish(alice, report.versionId, request({ zoneId: product.id })), refused("evidence_result_zone_kind_refused", 409));
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0, "no refusal left a card behind");
  assert.equal(counter("open_science_evidence_result_cards_total", "outcome", "refused") > 0, true);
});

test("the same result version published twice is one draft, however it is named", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  const service = publisherFor(f);
  const first = await service.publish(alice, report.versionId, { projectId: "p", newZone: { title: "Stroke research" } });
  assert.equal(first.created, true);
  assert.equal(first.zone.title, "Stroke research");
  assert.equal(first.zone.state, "draft", "a new zone is the researcher's to publish");
  const again = await service.publish(alice, report.versionId, { projectId: "p", newZone: { title: "Stroke research" } });
  assert.equal(again.created, false);
  assert.equal(again.outcome, "existing");
  assert.equal(again.evidence.id, first.evidence.id);
  const elsewhere = await service.publish(alice, report.versionId, { projectId: "p", zoneId: (await ownZone(alice, { title: "Another zone" })).id });
  assert.equal(elsewhere.evidence.id, first.evidence.id, "idempotent by lineage, not by the zone it was asked for");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 1);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_zones WHERE title='Stroke research'")).rows[0].n, 1, "no second zone either");
});

test("another account's result version reads as not found", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  const zone = await ownZone(bob);
  await assert.rejects(publisherFor(f).publish(bob, report.versionId, { projectId: "p", zoneId: zone.id }), refused("result_version_unavailable", 404));
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0);
});

test("a newer version of the same artifact is a new draft that follows the earlier card, which is left as it was", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const one = await f.deliver();
  const zone = await ownZone();
  const service = publisherFor(f);
  const first = (await service.publish(alice, one.report.versionId, { projectId: "p", zoneId: zone.id })).evidence;
  await zones.save(alice, { expectedRevision: first.revision, state: "published" }, zone.id, first.id);
  const live = (await zones.detail(alice, zone.id, first.id)).evidence;
  assert.equal(live.state, "published");
  // The research is run again: a new run writes the same deliverable path with new bytes.
  const newer = await f.deliver({ body: "Observed fewer strokes, and the bleeding signal is clearer [1].\n", thisRun: { ...f.run, id: "run_two", sessionId: "session_run_two" } });
  assert.notEqual(newer.report.versionId, one.report.versionId);
  assert.equal(newer.report.artifactId, one.report.artifactId, "the same artifact");
  const second = await service.publish(alice, newer.report.versionId, { projectId: "p", zoneId: zone.id });
  assert.equal(second.outcome, "next_version");
  assert.equal(second.previousCardId, first.id);
  assert.notEqual(second.evidence.id, first.id);
  assert.equal(second.evidence.lineage.previousCardId, first.id);
  assert.equal(second.evidence.state, "draft");
  const after = await rawCard(first.id);
  assert.equal(after.revision, live.revision, "the live card was not rewritten");
  assert.equal(after.state, "published");
  assert.equal(counter("open_science_evidence_result_cards_total", "outcome", "next_version"), 1);
});

test("research that began from a card carries it: the researcher's own card is followed, another's is only named", options, async (t) => {
  const f = await clinicalResultFixture(t);
  const { report } = await f.deliver();
  // Alice's own earlier card, and a published card of Bob's.
  const aliceZone = await ownZone();
  const mine = (await zones.save(alice, { title: "Earlier", subtype: "knowledge", summary: "", body: "b", sources: [{ title: "S", url: "https://example.org/s" }], limitations: "" }, aliceZone.id, null, true)).evidence;
  const bobZone = await ownZone(bob);
  const theirs = (await zones.save(bob, { title: "Theirs", subtype: "knowledge", summary: "", body: "b", sources: [{ title: "S", url: "https://example.org/s" }], limitations: "" }, bobZone.id, null, true)).evidence;

  const fromOwn = await publisherFor(f, [{ ...f.run, originCardId: mine.id }]).publish(alice, report.versionId, { projectId: "p", zoneId: aliceZone.id });
  assert.equal(fromOwn.evidence.lineage.originCardId, mine.id);
  assert.equal(fromOwn.evidence.lineage.previousCardId, mine.id, "offered as the next version of the researcher's own card");
  assert.equal(fromOwn.outcome, "next_version");

  const g = await clinicalResultFixture(t, { runId: "run_theirs", reportTitle: "Other" });
  const other = await g.deliver();
  const fromTheirs = await publisherFor(g, [{ ...g.run, originCardId: theirs.id }]).publish(alice, other.report.versionId, { projectId: "p", zoneId: aliceZone.id });
  assert.equal(fromTheirs.evidence.lineage.originCardId, theirs.id);
  assert.equal(fromTheirs.evidence.lineage.previousCardId, undefined, "another's card is never this one's earlier version");
  assert.equal(fromTheirs.outcome, "created");
});

test("a comparison row is carried only where the matrix holds its events and denominators, and its figures are computed by code", options, async (t) => {
  const comparison = { title: "Stroke", outcome: "Stroke", timeframe: "2 years", denominator: 100, control: { label: "Usual care", events: 12 },
    intervention: { label: "Drug", events: 7 }, relativeEffect: "RR 0.58", certainty: "moderate", participants: 4200, studies: 1, outcomeRole: "benefit", claimIds: ["CLM-001"] };
  const f = await clinicalResultFixture(t, { matrixExtra: { comparisons: [comparison,
    // Stands on a claim the card does not carry, and has no counts at all: neither becomes a row.
    { ...comparison, title: "Bleeding", claimIds: ["CLM-002"] },
    { title: "Invented", outcome: "Death", timeframe: "1 year", claimIds: ["CLM-001"] }] } });
  const { report } = await f.deliver();
  const zone = await ownZone();
  const { evidence } = await publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id });
  assert.equal(evidence.content.comparisons.length, 1);
  assert.deepEqual(evidence.content.comparisons[0].sourceIndexes, [1], "its sources are the claim's own");
  const [row] = evidence.views.clinical.rows;
  assert.deepEqual(row.absoluteEffect, { status: "computed", per: 1000, unit: "people", control: 120, intervention: 70, difference: -50 });
  assert.equal(evidence.views.public.factBox.benefits[0].control.per1000, 120);
});

test("a value the matrix labels a simulation is refused by name and nothing is saved", options, async (t) => {
  const f = await clinicalResultFixture(t, { matrixExtra: { comparisons: [{ title: "Stroke", outcome: "Stroke", timeframe: "2 years", denominator: 100,
    control: { label: "Usual care", events: 12 }, intervention: { label: "Drug", events: 7 }, outcomeRole: "benefit", valueSource: "synthetic", claimIds: ["CLM-001"] }] } });
  const { report } = await f.deliver();
  const zone = await ownZone();
  await assert.rejects(publisherFor(f).publish(alice, report.versionId, { projectId: "p", zoneId: zone.id }), refused("evidence_value_source_refused", 400));
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0);
});

test("the request is read field by field and the originality is a closed map", () => {
  assert.deepEqual(readResultCardRequest({ projectId: "p", zoneId: "ez_1", claimIds: ["CLM-001", "CLM-001"] }), { projectId: "p", zoneId: "ez_1", newZone: null, claimIds: ["CLM-001"] });
  assert.throws(() => readResultCardRequest({ projectId: "../x", zoneId: "ez_1" }), refused("evidence_result_request_invalid"));
  assert.throws(() => readResultCardRequest({ projectId: "p", newZone: { title: "  " } }), refused("evidence_result_request_invalid"));
  assert.throws(() => readResultCardRequest({ projectId: "p", newZone: { title: "t", kind: "official" } }), refused("evidence_result_request_invalid"));
  assert.throws(() => readResultCardRequest({ projectId: "p", zoneId: "z", claimIds: Array.from({ length: 61 }, (_, index) => `C${index}`) }), refused("evidence_result_too_many_claims"));
  assert.equal(resultOriginality("clinical-evidence-synthesis"), "synthesis");
  assert.equal(resultOriginality("dataset-research-scoping"), "original_research");
  assert.equal(resultOriginality("statistical-analysis"), "original_research");
  assert.equal(resultOriginality("something-new"), "synthesis", "what the map does not list is the humbler label");
  assert.equal(resultOriginality(undefined), "synthesis");
});
