// The event layer's decisions without a database (build spec D.1): roles,
// the kind of first-hand material, the three counts, decayed heat, hot
// eligibility and order, cluster keys, what the vectors say and where an
// item goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_CLUSTER_ASK_MAX,
  FRONTIER_HOT_SIZE,
  frontierClusterDecision,
  frontierClusterEntities,
  frontierClusterKeys,
  frontierEventCounts,
  frontierEventHeat,
  frontierEventRole,
  frontierHotEligible,
  frontierPrimaryKind,
  frontierRankHot,
  frontierVectorReading,
} from "../src/frontierEvents.mjs";

const NOW = new Date("2026-09-22T04:00:00Z");
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

test("a party's own text is primary; a journal's opinion piece is background; coverage is a report", () => {
  assert.equal(frontierEventRole({ sourceType: "journal", evidenceType: "rct" }), "primary");
  assert.equal(frontierEventRole({ sourceType: "journal", evidenceType: "review-opinion" }), "background");
  assert.equal(frontierEventRole({ sourceType: "preprint", evidenceType: "other" }), "primary");
  assert.equal(frontierEventRole({ sourceType: "regulator", evidenceType: "safety-notice" }), "primary");
  assert.equal(frontierEventRole({ sourceType: "evidence-body", evidenceType: "guideline" }), "primary");
  assert.equal(frontierEventRole({ sourceType: "evidence-body", evidenceType: "review-opinion" }), "report");
  assert.equal(frontierEventRole({ sourceType: "company", evidenceType: "press-release" }), "report", "a press release is not the paper");
  assert.equal(frontierEventRole({ sourceType: "media", evidenceType: "rct" }), "report");
});

test("the kind of first-hand material an event holds: a regulator's text over a guideline over a paper", () => {
  assert.equal(frontierPrimaryKind([{ role: "report", sourceType: "media" }]), null);
  assert.equal(frontierPrimaryKind([{ role: "primary", sourceType: "journal", evidenceType: "rct" }]), "paper");
  assert.equal(frontierPrimaryKind([{ role: "primary", sourceType: "journal", evidenceType: "rct" },
    { role: "primary", sourceType: "evidence-body", evidenceType: "guideline" }]), "guideline");
  assert.equal(frontierPrimaryKind([{ role: "primary", sourceType: "journal", evidenceType: "rct" },
    { role: "primary", sourceType: "regulator", evidenceType: "regulatory-decision" }]), "official");
  // A regulator's guideline is a guideline.
  assert.equal(frontierPrimaryKind([{ role: "primary", sourceType: "regulator", evidenceType: "guideline" }]), "guideline");
});

test("three counts: independent entities in 72 hours, every report, distinct entities over the event's life", () => {
  const members = [
    { role: "primary", ownerEntity: "nejm-group", authority: 5, timelineAt: hoursAgo(80), lang: "en", sourceType: "journal" },
    { role: "report", ownerEntity: "reuters", authority: 3, timelineAt: hoursAgo(10), lang: "en", sourceType: "media" },
    { role: "report", ownerEntity: "reuters", authority: 3, timelineAt: hoursAgo(9), lang: "en", sourceType: "media" },
    { role: "report", ownerEntity: "yimaitong", authority: 2, timelineAt: hoursAgo(5), lang: "zh", sourceType: "media" },
  ];
  const counts = frontierEventCounts({ members, now: NOW });
  assert.equal(counts.sourceCount72h, 2, "two feeds of one owner are one independent source; the paper is older than 72 h");
  assert.equal(counts.reportCount, 4);
  assert.equal(counts.entityCount, 3);
  assert.equal(counts.hasPrimary, true);
  assert.equal(counts.regulatorPrimary, false);
  assert.equal(counts.bilingual, true);
  assert.equal(counts.firstAt.toISOString(), hoursAgo(80));
  assert.equal(counts.lastAt.toISOString(), hoursAgo(5));
});

test("heat: authority weight decayed by a 36-hour half-life per owner entity, ×1.3 bilingual, ×1.5 with a primary", () => {
  const one = frontierEventHeat({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: NOW.toISOString(), lang: "en" }], now: NOW });
  assert.equal(one, 1);
  const halved = frontierEventHeat({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: hoursAgo(36), lang: "en" }], now: NOW });
  assert.ok(Math.abs(halved - 0.5) < 1e-12, "36 hours is one half-life");
  const weak = frontierEventHeat({ members: [{ role: "report", ownerEntity: "a", authority: 1, timelineAt: NOW.toISOString(), lang: "en" }], now: NOW });
  assert.ok(Math.abs(weak - 0.2) < 1e-12, "authority 1 of 5 weighs a fifth");
  // One entity counts once, at its latest report and its highest authority.
  const repeated = frontierEventHeat({ members: [
    { role: "report", ownerEntity: "a", authority: 3, timelineAt: hoursAgo(72), lang: "en" },
    { role: "report", ownerEntity: "a", authority: 5, timelineAt: NOW.toISOString(), lang: "en" },
  ], now: NOW });
  assert.equal(repeated, 1);
  const both = frontierEventHeat({ members: [
    { role: "report", ownerEntity: "a", authority: 5, timelineAt: NOW.toISOString(), lang: "en" },
    { role: "report", ownerEntity: "b", authority: 5, timelineAt: NOW.toISOString(), lang: "zh" },
  ], now: NOW });
  assert.ok(Math.abs(both - 2 * 1.3) < 1e-12);
  const primary = frontierEventHeat({ members: [
    { role: "primary", ownerEntity: "a", authority: 5, timelineAt: NOW.toISOString(), lang: "en" },
    { role: "report", ownerEntity: "b", authority: 5, timelineAt: NOW.toISOString(), lang: "zh" },
  ], now: NOW });
  assert.ok(Math.abs(primary - 2 * 1.3 * 1.5) < 1e-12);
  // No age cap: two weeks of reporting still counts, decayed.
  const old = frontierEventHeat({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: hoursAgo(14 * 24), lang: "en" }], now: NOW });
  assert.ok(old > 0 && old < 0.01);
  const future = frontierEventHeat({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: new Date(NOW.getTime() + 3_600_000).toISOString(), lang: "en" }], now: NOW });
  assert.equal(future, 1, "a report dated in the future counts as now, never more");
});

test("hot eligibility: two independent entities in 72 hours, or one with a regulator's primary source", () => {
  assert.equal(frontierHotEligible({ sourceCount72h: 2, selectedRegulatorPrimary: false }), true);
  assert.equal(frontierHotEligible({ sourceCount72h: 1, selectedRegulatorPrimary: false }), false);
  assert.equal(frontierHotEligible({ sourceCount72h: 1, selectedRegulatorPrimary: true }), true);
  // A regulator's routine notice alone (an EPAR revision below the 精选 line)
  // is not hot: 2026-09-22's first live run filled the list with them.
  assert.equal(frontierHotEligible({ sourceCount72h: 1 }), false);
  assert.equal(frontierHotEligible({ sourceCount72h: 0, selectedRegulatorPrimary: true }), false, "a settled event is never hot");
});

test("the hot list: the eligible by heat, then the latest, then the lower id; at most ten", () => {
  const events = Array.from({ length: 14 }, (_, index) => ({ id: String(index + 1), heat: 14 - index, lastAt: NOW, eligible: index !== 0 }));
  events.push({ id: "99", heat: 5, lastAt: new Date(NOW.getTime() + 1000), eligible: true });
  const ranked = frontierRankHot(events);
  assert.equal(ranked.length, FRONTIER_HOT_SIZE);
  assert.equal(ranked[0].id, "2", "the hottest is ineligible and left out");
  const fives = ranked.filter((event) => event.heat === 5).map((event) => event.id);
  assert.deepEqual(fives, ["99", "10"], "equal heat: the later report first");
});

test("cluster keys: every registry id, and the bare id of an event-level registry identity", () => {
  assert.deepEqual(frontierClusterKeys({ registry_ids: ["nct01234567", " NCT07654321 "], identity_key: "doi:10.1/x" }), ["reg:NCT01234567", "reg:NCT07654321"]);
  assert.deepEqual(frontierClusterKeys({ registry_ids: [], identity_key: "reg:NCT01234567:results-posted:2026-09-20" }), ["reg:NCT01234567"]);
  assert.deepEqual(frontierClusterKeys({ registry_ids: null, identity_key: "fda:NDA123:SUPPL-4" }), []);
  assert.deepEqual(frontierClusterEntities(["drug:semaglutide", "disease:obesity", "trial:select", "org:fda", 7]), ["drug:semaglutide", "trial:select", "org:fda"],
    "a disease alone is too broad to make two items candidates");
});

test("the vectors: at or above 0.82 is the same event; the band below it is asked, one pair per event, at most three", () => {
  const reading = frontierVectorReading([
    { eventId: "1", cosine: 0.9 }, { eventId: "1", cosine: 0.75 }, { eventId: "2", cosine: 0.82 },
    { eventId: "3", cosine: 0.8 }, { eventId: "3", cosine: 0.79 }, { eventId: "4", cosine: 0.74 }, { eventId: "5", cosine: 0.73 },
    { eventId: "6", cosine: 0.72 }, { eventId: "7", cosine: 0.71 }, { eventId: "8", cosine: Number.NaN },
  ]);
  assert.deepEqual(reading.strong, ["1", "2"]);
  assert.deepEqual(reading.ask.map((pair) => [pair.eventId, pair.cosine]), [["3", 0.8], ["4", 0.74], ["5", 0.73]]);
  assert.equal(reading.ask.length, FRONTIER_CLUSTER_ASK_MAX);
  assert.equal(reading.ask[0].index, 3, "the index points back at the candidate the pair came from");
});

test("where an item goes: the oldest of the events it is the same as survives the rest; related events are edges", () => {
  const events = new Map([
    ["10", { id: "10", firstAt: "2026-09-20T00:00:00Z" }],
    ["11", { id: "11", firstAt: "2026-09-18T00:00:00Z" }],
    ["12", { id: "12", firstAt: "2026-09-21T00:00:00Z" }],
  ]);
  const created = frontierClusterDecision({ identifier: [], strong: [], yes: [], related: ["12"], events });
  assert.deepEqual(created, { target: null, merge: [], related: ["12"], joinedBy: null });
  const bridged = frontierClusterDecision({ identifier: ["10"], strong: ["11"], yes: [], related: ["12", "11"], events });
  assert.equal(bridged.target, "11", "the older event survives");
  assert.deepEqual(bridged.merge, ["10"]);
  assert.deepEqual(bridged.related, ["12"], "an event it is the same as is not also related");
  assert.equal(bridged.joinedBy, "identifier", "the item's own strongest evidence names how it joined");
  assert.equal(frontierClusterDecision({ identifier: [], strong: [], yes: ["12"], related: [], events }).joinedBy, "model");
  assert.equal(frontierClusterDecision({ identifier: [], strong: ["12"], yes: [], related: [], events }).joinedBy, "vector");
  assert.equal(frontierClusterDecision({ identifier: ["404"], strong: [], yes: [], related: [], events }).target, null,
    "an event that no longer exists is no match");
});
