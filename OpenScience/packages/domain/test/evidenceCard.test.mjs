import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EVIDENCE_CARD_ERROR_CODES,
  EVIDENCE_ORIGINALITY,
  EVIDENCE_PRIMARY_ORIGINALITY,
  EVIDENCE_RANKING_INPUTS,
  EVIDENCE_WRITE_ORIGINS,
  EVIDENCE_ZONE_KINDS,
  EVIDENCE_ZONE_VISIBILITY,
  EvidenceCardError,
  VCR_VALUE_SOURCES,
  assertEvidenceCardForZone,
  assertEvidenceValueSources,
  assertEvidenceWriteAllowed,
  createEvidenceCardHashing,
  evidenceAbsoluteEffect,
  evidenceCardClaims,
  evidenceCardClinicalView,
  evidenceCardIdentifiers,
  evidenceCardPublicView,
  evidenceDefaultProducer,
  evidenceDisclosure,
  evidenceEntityKeys,
  evidenceFactBox,
  evidenceJourneyStage,
  evidenceLineage,
  evidenceMergeEntityKeys,
  evidenceOriginalityIsPrimary,
  evidenceProducer,
  evidencePublicViewContent,
  evidenceRankingComparator,
  evidenceStructuredContent,
  evidenceValueSourceIssues,
  evidenceWriteAllowed,
  knownErrorCodeMessage,
  verifyEvidenceCardClaims,
} from "../index.mjs";

/** @param {string} text */
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
/** @param {string} code */
const refusedWith = (code) => (/** @type {any} */ error) => error instanceof EvidenceCardError && error.code === code;

const DOCUMENT = "In this randomized trial, 12 of 100 adults on usual care had a stroke. Among 100 adults on the drug, 7 had a stroke. Major bleeding occurred in 3 of 100 on the drug and 1 of 100 on usual care.";
const sources = [
  { title: "Trial", url: "https://doi.org/10.1000/Trial.1", excerpt: "12 of 100 adults on usual care had a stroke", documentText: DOCUMENT },
  // The platform read this page (a read receipt beside the excerpt it kept); the trial above was kept whole.
  { title: "Label", url: "https://www.example.org/label", excerpt: "Do not use the drug with severe bleeding.", fetchedSha256: "b".repeat(64) },
  { title: "Page without text", url: "https://www.example.org/missing" },
];
const comparisons = [
  {
    title: "Stroke", outcome: "Stroke", timeframe: "2 years", denominator: 100,
    control: { label: "Usual care", events: 12 }, intervention: { label: "Drug", events: 7 },
    relativeEffect: "RR 0.58", certainty: "moderate", participants: 4200, studies: 3, outcomeRole: "benefit", sourceIndexes: [1],
  },
  {
    title: "Bleeding", outcome: "Major bleeding", timeframe: "2 years", denominator: 100,
    control: { label: "Usual care", events: 1 }, intervention: { label: "Drug", events: 3 }, outcomeRole: "harm", sourceIndexes: [1],
  },
];
const claims = [
  { claimId: "CLM-001", claimType: "direct", claim: "Stroke was less frequent on the drug.", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke" },
  { claimId: "CLM-002", claimType: "direct", claim: "Bleeding was more frequent.", sourceIndexes: [1], supportQuote: "Major bleeding occurred in 3 of 100 on the drug and 9 of 100 on usual care" },
  { claimId: "CLM-003", claimType: "direct", claim: "The label restricts use.", sourceIndexes: [3], supportQuote: "Do not use the drug" },
  {
    claimId: "CLM-004", claimType: "synthesized", confidence: "moderate", claim: "Benefit and bleeding risk both appear.",
    supportingSources: [{ sourceIndex: 1, supportQuote: "7 had a stroke" }, { sourceIndex: 2, supportQuote: "severe bleeding" }],
  },
  { claimId: "CLM-005", claimType: "direct", claim: "No quote given.", sourceIndexes: [1] },
  {
    claimId: "CLM-006", claimType: "derived", claim: "About 5 fewer strokes per 100.", derivedFrom: ["CLM-001"],
    method: "12/100 minus 7/100", assumptions: "Equal follow-up", sensitivity: "Moves with the control rate",
  },
];
const card = () => ({
  title: "Does the drug prevent stroke?",
  content: evidenceStructuredContent({ question: "Q", answer: "A", population: "Adults", comparisons }, sources.length),
  sources,
  claims: evidenceCardClaims(claims, sources.length),
  producer: { kind: "platform", name: "EviMed", relation: "none" },
  originality: "synthesis",
});

test("the vocabularies are closed and the ranking list is exactly the four named inputs", () => {
  assert.deepEqual([...EVIDENCE_ZONE_KINDS], ["official", "product", "user"]);
  assert.deepEqual([...EVIDENCE_ZONE_VISIBILITY], ["platform", "internet"]);
  assert.deepEqual([...EVIDENCE_WRITE_ORIGINS], ["owner", "import", "model", "programme", "result", "geo"]);
  // Pinned: a paid or commercial field enters an ordering only by changing this list and this test.
  assert.deepEqual([...EVIDENCE_RANKING_INPUTS], ["recency", "verified_share", "review_score", "follows"]);
  assert.deepEqual([...EVIDENCE_PRIMARY_ORIGINALITY], ["original_analysis", "recalculation", "original_research"]);
  assert.equal(EVIDENCE_ORIGINALITY.length, 5);
  for (const value of EVIDENCE_PRIMARY_ORIGINALITY) assert.equal(evidenceOriginalityIsPrimary(value), true);
  for (const value of ["synthesis", "brief", "", null, "other"]) assert.equal(evidenceOriginalityIsPrimary(value), false);
});

test("a ranking refuses any input outside the closed list, whatever it is called", () => {
  for (const input of /** @type {any[]} */ (["paid", "sponsored", "ad_spend", "price", "boost", "updatedAt", undefined, null, ""])) {
    assert.throws(() => evidenceRankingComparator([input]), refusedWith("evidence_ranking_input_unknown"), String(input));
    assert.throws(() => evidenceRankingComparator(["recency", { input, direction: "asc" }]), refusedWith("evidence_ranking_input_unknown"), String(input));
  }
  assert.throws(() => evidenceRankingComparator([]), refusedWith("evidence_ranking_input_unknown"));
  // An item cannot smuggle an extra field into an order: only ranking inputs are read.
  const compare = evidenceRankingComparator(["verified_share", { input: "recency", direction: "asc" }]);
  const items = [
    { id: "c", ranking: { verified_share: 0.5, recency: 5 }, paid: 1e9 },
    { id: "a", ranking: { verified_share: 1, recency: 9 }, paid: 0 },
    { id: "b", ranking: { verified_share: 1, recency: 3 }, paid: 0 },
    { id: "d", ranking: {} },
    { id: "e", ranking: { verified_share: 0.5, recency: 5 } },
  ];
  assert.deepEqual(items.sort(compare).map((item) => item.id), ["b", "a", "c", "e", "d"]);
});

test("who may write where: the matrix of origins and zone kinds", () => {
  const allow = (/** @type {string} */ origin, /** @type {string} */ zoneKind, /** @type {boolean} */ actorIsZoneOwner, /** @type {boolean} */ actorIsPlatformPublisher) => evidenceWriteAllowed({ origin, zoneKind, actorIsZoneOwner, actorIsPlatformPublisher }).allowed;
  for (const origin of EVIDENCE_WRITE_ORIGINS) {
    assert.equal(allow(origin, "official", true, true), ["import", "model", "programme"].includes(origin), `official ${origin}`);
    assert.equal(allow(origin, "official", true, false), false, `official ${origin} not as the publisher`);
    assert.equal(allow(origin, "product", true, false), ["owner", "geo"].includes(origin), `product ${origin}`);
    assert.equal(allow(origin, "product", false, false), false, `product ${origin} by a stranger`);
    assert.equal(allow(origin, "user", true, false), ["owner", "result", "model"].includes(origin), `user ${origin}`);
    assert.equal(allow(origin, "user", false, false), false, `user ${origin} by a stranger`);
  }
  assert.equal(allow("owner", "unknown", true, true), false);
  assert.equal(allow("batch", "user", true, true), false);
  const refused = evidenceWriteAllowed({ origin: "result", zoneKind: "official", actorIsZoneOwner: true, actorIsPlatformPublisher: false });
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "evidence_write_origin_refused");
  assert.match(refused.message ?? "", /result/);
  assert.match(refused.message ?? "", /official/);
  assert.throws(() => assertEvidenceWriteAllowed({ origin: "geo", zoneKind: "official", actorIsZoneOwner: true, actorIsPlatformPublisher: false }), refusedWith("evidence_write_origin_refused"));
  assert.doesNotThrow(() => assertEvidenceWriteAllowed({ origin: "programme", zoneKind: "official", actorIsZoneOwner: true, actorIsPlatformPublisher: true }));
});

test("producer, journey stage and disclosure are validated, and a zone decides who may sign", () => {
  assert.deepEqual(evidenceProducer({ kind: "enterprise", name: " Acme ", relation: "own_product", products: ["Drug A", "Drug A"] }),
    { kind: "enterprise", name: "Acme", relation: "own_product", products: ["Drug A"] });
  for (const bad of [null, [], { kind: "platform", name: "x" }, { kind: "ai", name: "x", relation: "none" }, { kind: "user", name: "x", relation: "paid" }, { kind: "user", name: "", relation: "none" }, { kind: "user", name: "x", relation: "none", extra: 1 }]) {
    assert.throws(() => evidenceProducer(bad), refusedWith("evidence_invalid"), JSON.stringify(bad));
  }
  assert.deepEqual(evidenceDefaultProducer({ zoneKind: "official", ownerName: "Anyone" }), { kind: "platform", name: "EviMed 证据中心", relation: "none" });
  assert.deepEqual(evidenceDefaultProducer({ zoneKind: "user", ownerName: "Alice" }), { kind: "user", name: "Alice", relation: "none" });
  assert.equal(evidenceDefaultProducer({ zoneKind: "product", ownerName: "Acme" }), null);

  assert.deepEqual(evidenceJourneyStage({ key: "treatment-choice", label: "治疗选择" }), { key: "treatment-choice", label: "治疗选择" });
  assert.deepEqual(evidenceJourneyStage({ key: "诊断", label: "诊断" }), { key: "诊断", label: "诊断" });
  assert.equal(evidenceJourneyStage(null), null);
  for (const bad of [{ key: "has space", label: "x" }, { key: "k" }, { key: "k", label: "" }, "stage", { key: "k", label: "x", order: 1 }]) {
    assert.throws(() => evidenceJourneyStage(bad), refusedWith("evidence_invalid"), JSON.stringify(bad));
  }

  const disclosure = evidenceDisclosure({
    model: "deepseek-flash", generatedAt: "2026-10-05T00:00:00Z", aiSteps: ["review", "extract", "extract"],
    authors: [{ name: "Dr. Li", affiliation: "PUMCH" }], reviewers: [{ name: "Dr. Wang", title: "Pharmacist" }],
  });
  assert.deepEqual(disclosure?.aiSteps, ["extract", "review"]);
  assert.deepEqual(disclosure?.authors, [{ name: "Dr. Li", affiliation: "PUMCH" }]);
  for (const bad of [{ aiSteps: ["guess"] }, { generatedAt: "yesterday" }, { authors: [{ affiliation: "x" }] }, { authors: "Dr" }, { extra: true }]) {
    assert.throws(() => evidenceDisclosure(bad), refusedWith("evidence_invalid"), JSON.stringify(bad));
  }

  const producer = { kind: "enterprise", name: "Acme", relation: "own_product" };
  const stage = { key: "treatment", label: "治疗" };
  const named = { authors: [{ name: "A" }], reviewers: [{ name: "R" }] };
  assert.doesNotThrow(() => assertEvidenceCardForZone({ zoneKind: "product", producer, journeyStage: stage, disclosure: named }));
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "product", producer, journeyStage: null, disclosure: named }), refusedWith("evidence_journey_stage_required"));
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "product", producer, journeyStage: stage, disclosure: null }), refusedWith("evidence_disclosure_required"));
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "product", producer, journeyStage: stage, disclosure: { authors: [{ name: "A" }], reviewers: [] } }), refusedWith("evidence_disclosure_required"));
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "user", producer: null, journeyStage: null, disclosure: null }), refusedWith("evidence_producer_required"));
  // A user cannot sign as the platform, and the platform does not sign in a product zone.
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "user", producer: { kind: "platform", name: "EviMed", relation: "none" }, journeyStage: null, disclosure: null }), refusedWith("evidence_producer_mismatch"));
  assert.throws(() => assertEvidenceCardForZone({ zoneKind: "product", producer: { kind: "platform", name: "EviMed", relation: "none" }, journeyStage: stage, disclosure: named }), refusedWith("evidence_producer_mismatch"));
  assert.doesNotThrow(() => assertEvidenceCardForZone({ zoneKind: "official", producer: { kind: "platform", name: "EviMed", relation: "none" }, journeyStage: null, disclosure: null }));
  assert.doesNotThrow(() => assertEvidenceCardForZone({ zoneKind: "user", producer: { kind: "user", name: "Alice", relation: "none" }, journeyStage: null, disclosure: null }));
});

test("lineage ids are validated by shape and entity keys are bounded", () => {
  assert.deepEqual(evidenceLineage({
    frontierItemId: "abcdef123456", resultVersionId: "rv_0123abcd", runId: "run-1", agendaId: "agenda_1b2c", episodeId: "ep:1",
    previousCardId: "ec_0123456789abcdef", originCardId: "ec_fedcba9876543210", verifiedStudy: { doi: "10.1056/NEJMoa1", pmid: 12345, registryId: "NCT01234567" },
  }), {
    frontierItemId: "abcdef123456", resultVersionId: "rv_0123abcd", runId: "run-1", agendaId: "agenda_1b2c", episodeId: "ep:1",
    previousCardId: "ec_0123456789abcdef", originCardId: "ec_fedcba9876543210", verifiedStudy: { doi: "10.1056/nejmoa1", pmid: "12345", registryId: "NCT01234567" },
  });
  assert.equal(evidenceLineage({}), null);
  assert.equal(evidenceLineage(null), null);
  for (const bad of [{ frontierItemId: "UPPER" }, { runId: "has space" }, { previousCardId: "zone_1" }, { verifiedStudy: { doi: "not-a-doi" } }, { verifiedStudy: { pmid: "x1" } }, { verifiedStudy: { registryId: "!!" } }, { other: 1 }, "x"]) {
    assert.throws(() => evidenceLineage(bad), refusedWith("evidence_invalid"), JSON.stringify(bad));
  }
  assert.deepEqual(evidenceEntityKeys(["drug:warfarin", "drug:warfarin", " disease:af "]), ["drug:warfarin", "disease:af"]);
  assert.deepEqual(evidenceEntityKeys(null), []);
  assert.throws(() => evidenceEntityKeys(Array.from({ length: 41 }, (_, index) => `drug:${index}`)), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceEntityKeys(["x".repeat(161)]), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceEntityKeys(["bad\nkey"]), refusedWith("evidence_invalid"));
  assert.equal(evidenceMergeEntityKeys(["a:1"], ["a:1", "b:2"]).length, 2);
  assert.equal(evidenceMergeEntityKeys(["a:1"], Array.from({ length: 80 }, (_, index) => `b:${index}`)).length, 40);
});

test("claims keep the run's three types, refer to the card's sources by index and name their working", () => {
  const normalized = evidenceCardClaims(claims, sources.length);
  assert.equal(normalized.length, 6);
  assert.deepEqual(normalized[3].sourceIndexes, [1, 2]);
  assert.equal(normalized[3].confidence, "moderate");
  assert.deepEqual(normalized[5].derivedFrom, ["CLM-001"]);
  assert.deepEqual(evidenceCardClaims(null, 0), []);
  const bad = (/** @type {Record<string, any>} */ override, count = sources.length) => () => evidenceCardClaims([{ ...claims[0], ...override }], count);
  assert.throws(bad({ sourceIndexes: [4] }), refusedWith("evidence_invalid"));
  assert.throws(bad({ sourceIndexes: [] }), refusedWith("evidence_invalid"));
  assert.throws(bad({ sourceIndexes: [1, 2] }), refusedWith("evidence_invalid"));
  assert.throws(bad({ claimId: "has space" }), refusedWith("evidence_invalid"));
  assert.throws(bad({ claimType: "guess" }), refusedWith("evidence_invalid"));
  assert.throws(bad({ claim: "" }), refusedWith("evidence_invalid"));
  assert.throws(bad({ valueSource: "invented" }), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([claims[0], claims[0]], sources.length), /repeated claimId/);
  // A synthesis needs two distinct sources and a confidence label.
  const synthesis = /** @type {any} */ (claims[3]);
  assert.throws(() => evidenceCardClaims([{ ...synthesis, supportingSources: [synthesis.supportingSources[0]] }], 3), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([{ ...synthesis, supportingSources: [synthesis.supportingSources[0], synthesis.supportingSources[0]] }], 3), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([{ ...synthesis, confidence: undefined }], 3), refusedWith("evidence_invalid"));
  // A derived claim names its inputs, method, assumptions and sensitivity, and rests on a quoted claim.
  const derived = claims[5];
  for (const key of ["derivedFrom", "method", "assumptions", "sensitivity"]) {
    assert.throws(() => evidenceCardClaims([claims[0], { ...derived, [key]: undefined }], 3), refusedWith("evidence_invalid"), key);
  }
  assert.throws(() => evidenceCardClaims([claims[0], { ...derived, derivedFrom: ["CLM-404"] }], 3), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([claims[0], { ...derived, derivedFrom: ["CLM-006"] }], 3), refusedWith("evidence_invalid"));
  assert.throws(() => evidenceCardClaims([{ ...derived, derivedFrom: ["CLM-007"] }, { ...derived, claimId: "CLM-007", derivedFrom: ["CLM-006"] }], 3), /reaches no quoted claim/);
  assert.doesNotThrow(() => evidenceCardClaims([claims[0], derived, { ...derived, claimId: "CLM-007", derivedFrom: ["CLM-006"] }], 3));
});

test("a claim set returns ✓ and ⚠ by the gate's own quotation comparison, and never refuses", () => {
  const verdict = verifyEvidenceCardClaims(card());
  const byId = Object.fromEntries(verdict.claims.map((claim) => [claim.claimId, claim]));
  assert.equal(byId["CLM-001"].status, "verified");
  assert.equal(byId["CLM-001"].mark, "✓");
  assert.deepEqual(byId["CLM-001"].sources, [{ sourceIndex: 1, status: "verified", mark: "✓" }]);
  // The quotation says 9 of 100 and the source says 1 of 100.
  assert.equal(byId["CLM-002"].status, "quote_not_found");
  assert.equal(byId["CLM-002"].mark, "⚠");
  // The third source has no preserved text: neither confirmed nor refuted.
  assert.equal(byId["CLM-003"].status, "source_unavailable");
  assert.equal(byId["CLM-003"].mark, "⚠");
  // A synthesis is verified only when every quoted source is.
  assert.equal(byId["CLM-004"].status, "verified");
  assert.deepEqual(byId["CLM-004"].sources.map((source) => source.sourceIndex), [1, 2]);
  assert.equal(byId["CLM-005"].status, "no_quote");
  assert.equal(byId["CLM-005"].mark, "⚠");
  assert.equal(byId["CLM-006"].status, "derived");
  assert.equal(byId["CLM-006"].mark, null);
  assert.deepEqual(verdict.counts, { total: 6, verified: 2, quote_not_found: 1, source_unavailable: 1, no_quote: 1, derived: 1 });

  // The same normalisation as the run's mark: case, smart quotes, dashes and an elision are one comparison.
  const lenient = { ...card(), claims: evidenceCardClaims([{ ...claims[0], supportQuote: "AMONG 100 adults … 7 had a stroke" }], 3) };
  assert.equal(verifyEvidenceCardClaims(lenient).claims[0].status, "verified");
  const joined = { ...card(), claims: evidenceCardClaims([{ ...claims[0], supportQuote: "randomized trial 7 had a stroke" }], 3) };
  assert.equal(verifyEvidenceCardClaims(joined).claims[0].status, "quote_not_found");
  // A card with no claims is an empty verdict, not an error.
  assert.deepEqual(verifyEvidenceCardClaims({ sources }).counts, { total: 0, verified: 0, quote_not_found: 0, source_unavailable: 0, no_quote: 0, derived: 0 });
  // Locations are best effort and only added on request.
  const located = verifyEvidenceCardClaims(card(), { locations: true });
  assert.ok(located.claims[0].sources[0].location);
  assert.equal(located.claims[0].status, "verified");
});

test("✓ means the platform read the source: a quotation found only in an excerpt its author typed is ⚠ author_excerpt_only", () => {
  // The same card as an author's session can write it: sources carry a title, an address and an excerpt, nothing the platform sets.
  const typed = {
    ...card(),
    sources: [
      { title: "Trial", url: "https://doi.org/10.1000/Trial.1", excerpt: "Among 100 adults on the drug, 7 had a stroke" },
      { title: "Label", url: "https://www.example.org/label", excerpt: "Do not use the drug with severe bleeding." },
      { title: "Page without text", url: "https://www.example.org/missing" },
    ],
  };
  const verdict = verifyEvidenceCardClaims(typed);
  const byId = Object.fromEntries(verdict.claims.map((claim) => [claim.claimId, claim]));
  assert.equal(byId["CLM-001"].status, "author_excerpt_only");
  assert.equal(byId["CLM-001"].mark, "⚠");
  assert.deepEqual(byId["CLM-001"].sources, [{ sourceIndex: 1, status: "author_excerpt_only", mark: "⚠" }]);
  // The excerpt does not hold this one at all: still not verified, and not claimed to be anything better.
  assert.equal(byId["CLM-002"].mark, "⚠");
  assert.notEqual(byId["CLM-002"].status, "author_excerpt_only");
  // A synthesis is as good as its worst source, and a source with no text is not helped by its neighbour.
  assert.equal(byId["CLM-004"].status, "author_excerpt_only");
  assert.deepEqual(byId["CLM-004"].sources.map((source) => source.status), ["author_excerpt_only", "author_excerpt_only"]);
  assert.equal(byId["CLM-003"].status, "source_unavailable");
  assert.equal(verdict.counts.verified, 0, "nothing the platform did not read is ✓");
  assert.equal(verdict.counts.author_excerpt_only, 2);
  assert.equal(verdict.counts.total, 6);
  assert.equal(Object.entries(verdict.counts).filter(([key]) => key !== "total").reduce((sum, [, count]) => sum + count, 0), 6, "every claim is counted once");

  // The platform's read receipt, or the text it kept, is what turns the same excerpt into ✓.
  const receipted = { ...typed, sources: typed.sources.map((source, index) => (index === 0 ? { ...source, fetchedSha256: "c".repeat(64) } : source)) };
  assert.equal(verifyEvidenceCardClaims(receipted).claims[0].status, "verified");
  const kept = { ...typed, sources: typed.sources.map((source, index) => (index === 0 ? { ...source, documentText: DOCUMENT } : source)) };
  assert.equal(verifyEvidenceCardClaims(kept).claims[0].status, "verified");
  // Text the platform kept outranks an excerpt the author typed beside it.
  const contradicted = { ...typed, sources: typed.sources.map((source, index) => (index === 0 ? { ...source, documentText: "A different record altogether." } : source)) };
  assert.equal(verifyEvidenceCardClaims(contradicted).claims[0].status, "quote_not_found");
  // A located quotation is only ever one the platform read.
  const located = verifyEvidenceCardClaims(typed, { locations: true });
  assert.equal(located.claims[0].sources[0].location.status, "unknown");
});

test("the clinical view computes the absolute effect per 1000 from events and denominators", () => {
  const view = evidenceCardClinicalView(card());
  assert.equal(view.kind, "clinical");
  assert.equal(view.header.title, "Does the drug prevent stroke?");
  assert.equal(view.header.producer.kind, "platform");
  assert.equal(view.rows.length, 2);
  const [stroke, bleeding] = view.rows;
  assert.deepEqual(stroke.absoluteEffect, { status: "computed", per: 1000, unit: "people", control: 120, intervention: 70, difference: -50 });
  assert.deepEqual(bleeding.absoluteEffect, { status: "computed", per: 1000, unit: "people", control: 10, intervention: 30, difference: 20 });
  assert.equal(stroke.relativeEffect, "RR 0.58");
  assert.equal(stroke.participants, 4200);
  assert.equal(stroke.studies, 3);
  assert.equal(stroke.certainty, "moderate");
  // Only verified claims are listed beside the table.
  assert.deepEqual(view.claims.map((claim) => claim.claimId), ["CLM-001", "CLM-004"]);
  assert.equal(view.counts.derived, 1);
  // A typed absolute number is never carried: the code's arithmetic is the only one.
  const typed = card();
  typed.content = { ...typed.content, comparisons: [{ ...comparisons[0], absoluteEffect: "9999 per 1000" }] };
  assert.deepEqual(evidenceCardClinicalView(typed).rows[0].absoluteEffect.control, 120);
  assert.equal(JSON.stringify(evidenceCardClinicalView(typed)).includes("9999"), false);

  assert.deepEqual(evidenceAbsoluteEffect({ denominator: 357, control: { events: 7 }, intervention: { events: 5 } }),
    { status: "computed", per: 1000, unit: "people", control: 19.6, intervention: 14, difference: -5.6 });
  assert.equal(/** @type {any} */ (evidenceAbsoluteEffect({ measure: "rate", denominator: 200, control: { events: 10 }, intervention: { events: 4 } })).unit, "person-years");
  assert.deepEqual(evidenceAbsoluteEffect({ denominator: 100, control: { events: 120 }, intervention: { events: 4 } }), { status: "unavailable", reason: "events_exceed_denominator" });
  assert.deepEqual(evidenceAbsoluteEffect({ denominator: 100, control: { events: 1 } }), { status: "unavailable", reason: "counts_missing" });
  assert.deepEqual(evidenceAbsoluteEffect(null), { status: "unavailable", reason: "no_comparison" });
});

test("the public view is the author's six panels, a computed seventh and a fact box in code", () => {
  const publicView = evidencePublicViewContent({
    oneLineAnswer: { text: "服用后两年内中风少一些，出血多一些。", claimIds: ["CLM-001", "CLM-002"] },
    whatItIs: "一种抗凝药。",
    notApplicable: { text: "严重出血时不用。", claimIds: ["CLM-001"] },
    commonMisunderstandings: [{ misunderstanding: "吃了就不会中风", correction: "只是降低风险", observedIn: "AI 助手回答监测", claimIds: ["CLM-001"] }],
  }, card().claims);
  const view = evidenceCardPublicView({ ...card(), publicView, disclosure: { lastCheckedAt: "2026-10-04T00:00:00Z" } });
  assert.equal(view.kind, "public");
  assert.deepEqual(view.panels.map((panel) => panel.key), ["oneLineAnswer", "whatItIs", "labelSays", "notApplicable", "seekCareWhen", "commonMisunderstandings", "sourcesAndCheckDate"]);
  const panel = /** @type {Record<string, any>} */ (Object.fromEntries(view.panels.map((entry) => [entry.key, entry])));
  assert.equal(panel.oneLineAnswer.status, "written");
  // CLM-002's quotation is not in its source, so this panel is not fully traced.
  assert.equal(panel.oneLineAnswer.traced, false);
  assert.equal(panel.notApplicable.traced, true);
  assert.equal(panel.whatItIs.traced, false);
  assert.equal(panel.labelSays.status, "missing");
  assert.equal(panel.labelSays.text, null);
  assert.equal(panel.commonMisunderstandings.items[0].traced, true);
  assert.equal(panel.sourcesAndCheckDate.checkedAt, "2026-10-04T00:00:00Z");
  assert.equal(panel.sourcesAndCheckDate.sources.length, 3);
  assert.equal(view.factBox.status, "available");
  assert.equal(view.factBox.per, 1000);
  assert.deepEqual(view.factBox.benefits[0].control, { label: "Usual care", per1000: 120 });
  assert.deepEqual(view.factBox.benefits[0].intervention, { label: "Drug", per1000: 70 });
  assert.equal(view.factBox.benefits[0].difference, -50);
  assert.equal(view.factBox.harms[0].difference, 20);
  // The author cannot type a number into the box: it is not a field of the view.
  assert.throws(() => evidencePublicViewContent({ factBox: { benefits: "1 in 3" } }, []), refusedWith("evidence_invalid"));
  // Panels are length-limited and trace only to claims the card has.
  assert.throws(() => evidencePublicViewContent({ oneLineAnswer: "x".repeat(201) }, []), refusedWith("evidence_invalid"));
  assert.throws(() => evidencePublicViewContent({ whatItIs: { text: "x", claimIds: ["CLM-404"] } }, card().claims), refusedWith("evidence_invalid"));
  assert.equal(evidencePublicViewContent({}, []), null);
});

test("a fact box that cannot be computed says why by a named reason", () => {
  assert.deepEqual(evidenceFactBox([]), { status: "unavailable", reason: "no_comparisons", per: 1000, unit: "people", benefits: [], harms: [], excluded: [] });
  const unclassified = evidenceFactBox([{ ...comparisons[0], outcomeRole: undefined }]);
  assert.equal(unclassified.status, "unavailable");
  assert.equal(unclassified.reason, "outcome_role_missing");
  const rate = evidenceFactBox([{ ...comparisons[0], measure: "rate" }]);
  assert.equal(rate.reason, "not_per_people");
  const impossible = evidenceFactBox([{ ...comparisons[0], control: { label: "x", events: 500 } }]);
  assert.equal(impossible.reason, "events_exceed_denominator");
  // One usable comparison is enough; the others are listed with their reason.
  const partial = evidenceFactBox([comparisons[0], { ...comparisons[1], outcomeRole: undefined }]);
  assert.equal(partial.status, "available");
  assert.deepEqual(partial.excluded, [{ index: 1, reason: "outcome_role_missing" }]);
});

test("a simulated value is refused by name; imputed and reconstructed only inside a derived claim with its method", () => {
  assert.deepEqual(evidenceValueSourceIssues(card()), []);
  for (const label of ["observed", "extracted", "calculated", "aggregate"]) {
    assert.deepEqual(evidenceValueSourceIssues({ claims: [{ claimId: "C1", claimType: "direct", valueSource: label }] }), [], label);
  }
  for (const label of ["predicted", "assumed", "synthetic"]) {
    const asClaim = evidenceValueSourceIssues({ claims: [{ claimId: "CLM-9", claimType: "derived", method: "m", valueSource: label }] });
    assert.equal(asClaim.length, 1, label);
    assert.equal(asClaim[0].code, "evidence_value_source_refused");
    assert.equal(asClaim[0].valueSource, label);
    assert.match(asClaim[0].message, new RegExp(label));
    assert.match(asClaim[0].message, /CLM-9/);
    const inComparison = evidenceValueSourceIssues({ content: { comparisons: [{ ...comparisons[0], valueSource: label }] } });
    assert.equal(inComparison[0].where, "content.comparisons[0]");
    assert.throws(() => assertEvidenceValueSources({ content: { comparisons: [{ valueSource: label }] } }), (/** @type {any} */ error) => error.code === "evidence_value_source_refused" && error.message.includes(label));
  }
  for (const label of ["imputed", "reconstructed"]) {
    assert.deepEqual(evidenceValueSourceIssues({ claims: [{ claimId: "C1", claimType: "derived", method: "multiple imputation", valueSource: label }] }), [], label);
    assert.equal(evidenceValueSourceIssues({ claims: [{ claimId: "C1", claimType: "derived", valueSource: label }] }).length, 1, `${label} without a method`);
    assert.equal(evidenceValueSourceIssues({ claims: [{ claimId: "C1", claimType: "direct", valueSource: label }] }).length, 1, `${label} in a direct claim`);
    assert.equal(evidenceValueSourceIssues({ content: { comparisons: [{ valueSource: label }] } }).length, 1, `${label} in a comparison`);
  }
  // The nine labels are the virtual-clinical-research module's, imported and never copied.
  assert.equal(VCR_VALUE_SOURCES.length, 9);
  assert.throws(() => evidenceStructuredContent({ comparisons: [{ ...comparisons[0], valueSource: "invented" }] }, 1), refusedWith("evidence_invalid"));
  assert.doesNotThrow(() => evidenceStructuredContent({ comparisons: [{ ...comparisons[0], valueSource: "predicted" }] }, 1), "the label is valid vocabulary; refusing it is the rule's job");
});

test("a card with no claims and no public view hashes exactly as before they existed", () => {
  const { evidenceContentHash } = createEvidenceCardHashing(sha256Hex);
  const legacy = { title: "T", summary: "S", body: "B", content: null, limitations: "L", sources: [{ title: "x", url: "https://example.org/", excerpt: "e", sha256: "a".repeat(64) }] };
  // The original payload array, spelled out: the hash an existing AI review receipt is bound to.
  /** @param {any} value @returns {any} */
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const expected = sha256Hex(JSON.stringify(canonical([legacy.title, legacy.summary, legacy.body, null, legacy.limitations, [["x", "https://example.org/", "e", "a".repeat(64), "excerpt"]]])));
  assert.equal(evidenceContentHash(legacy), expected);
  assert.equal(evidenceContentHash({ ...legacy, claims: [] }), expected);
  const withClaims = evidenceContentHash({ ...legacy, claims: [claims[0]] });
  assert.notEqual(withClaims, expected, "claims are part of the scientific payload");
  assert.equal(evidenceContentHash({ ...legacy, public_view: { whatItIs: { text: "x", claimIds: [] } } }) !== expected, true);
});

test("identifiers are read from closed formats in a card's sources and verified study", () => {
  assert.deepEqual(evidenceCardIdentifiers({
    lineage: { verifiedStudy: { doi: "10.1056/NEJMoa1", pmid: "5", registryId: "NCT01234567" } },
    sources: [
      { url: "https://doi.org/10.1000/Trial.1" },
      { url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" },
      { url: "https://clinicaltrials.gov/study/NCT07654321?tab=results" },
      { url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/" },
      { url: "https://example.org/page" },
      { url: null },
    ],
  }), ["doi:10.1000/trial.1", "doi:10.1056/nejmoa1", "pmcid:pmc1234567", "pmid:12345678", "pmid:5", "registry:nct01234567", "registry:nct07654321"]);
});

test("every code the card raises has a Chinese sentence in the registry", () => {
  assert.equal(EVIDENCE_CARD_ERROR_CODES.length, 9);
  for (const code of EVIDENCE_CARD_ERROR_CODES) assert.match(knownErrorCodeMessage(code) ?? "", /[一-鿿]/, code);
});
