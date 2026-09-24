// The event layer's decisions without a database (build spec D.1): roles,
// the kind of first-hand material, the three counts, decayed heat, hot
// eligibility and order, cluster keys, what the vectors say and where an
// item goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTIER_CLUSTER_ASK_MAX,
  FRONTIER_HOT_SIZE,
  FRONTIER_HOT_TRACKED,
  frontierEventInstitutions,
  frontierHeatTrend,
  frontierHotBadge,
  frontierHotReading,
  frontierRankChange,
  frontierRankPeriod,
  frontierSnapshotReading,
  frontierTrackedHeats,
  frontierClusterDecision,
  frontierClusterEntities,
  frontierClusterKeys,
  frontierEventCounts,
  frontierEventHeat,
  frontierEventRole,
  FRONTIER_HOT_SOLO_SCORE,
  frontierHotEligible,
  frontierPrimaryKind,
  frontierRankHot,
  frontierVectorReading,
  otherWork,
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
  // A column that names several trials is writing about them.
  const roundup = { source_type: "media", registry_ids: ["NCT05376150", "NCT06000001"], identity_key: "url:x" };
  assert.deepEqual(frontierClusterKeys(roundup), []);
  assert.deepEqual(frontierClusterKeys({ ...roundup, registry_ids: ["NCT05376150"] }), ["reg:NCT05376150"], "one trial is what the piece is about");
  assert.deepEqual(frontierClusterKeys({ ...roundup, source_type: "journal" }), ["reg:NCT05376150", "reg:NCT06000001"], "a paper states every trial it reports");
  assert.deepEqual(frontierClusterKeys({ ...roundup, identity_key: "reg:NCT05376150:results-posted:2026-09-22" }), ["reg:NCT05376150"],
    "a registry's own entry keeps its own id");
});

test("two works that state different identities are asked about, never joined by cosine alone", () => {
  assert.equal(otherWork({ doi: "10.1/a" }, { doi: "10.1/B" }), true);
  assert.equal(otherWork({ doi: "10.1/a" }, { doi: " 10.1/A " }), false);
  assert.equal(otherWork({ doi: null, pmid: "1" }, { doi: "10.1/b", pmid: "2" }), true);
  assert.equal(otherWork({ doi: "10.1/a" }, { doi: null, pmid: "2" }), false, "nothing to compare is not a difference");
  const reading = frontierVectorReading([
    { eventId: "1", cosine: 0.95, otherWork: true }, { eventId: "2", cosine: 0.9 }, { eventId: "3", cosine: 0.93, samePublisher: true },
  ]);
  assert.deepEqual(reading.strong, ["2"]);
  assert.deepEqual(reading.ask.map((pair) => pair.eventId), ["1", "3"]);
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
  // A report covers several events; it joins the oldest and links the rest.
  const reported = frontierClusterDecision({ identifier: ["10"], strong: ["11"], yes: ["12"], related: [], events, role: "report" });
  assert.equal(reported.target, "11");
  assert.deepEqual(reported.merge, [], "only a first-hand item folds two events into one");
  assert.deepEqual(reported.related.sort(), ["10", "12"]);
  const background = frontierClusterDecision({ identifier: ["10", "12"], strong: [], yes: [], related: [], events, role: "background" });
  assert.deepEqual([background.target, background.merge, background.related], ["10", [], ["12"]]);
});

test("a regulator's notice is hot on its own only when it is major: a top-band score", () => {
  // First production hours (2026-09-22): nine of ten hot events were single
  // notices — an administrative-forms circular, an EPAR revision.
  const now = new Date("2026-09-22T12:00:00Z");
  const notice = (overrides) => [{ role: "primary", ownerEntity: "us-fda", authority: 5, timelineAt: "2026-09-22T10:00:00Z", sourceType: "regulator",
    selected: true, safetyAlert: false, scoreTotal: 78, ...overrides }];
  const eligible = (members) => frontierHotEligible(frontierEventCounts({ members, now }));
  assert.equal(eligible(notice({})), false, "selected at 78: in 精选, not a hot topic");
  assert.equal(eligible(notice({ scoreTotal: FRONTIER_HOT_SOLO_SCORE })), true);
  // A safety alert has its own rail; alone, it is not a 热点 (five single
  // recalls filled five of nine places on 2026-09-22).
  assert.equal(eligible(notice({ safetyAlert: true, scoreTotal: 70 })), false);
  assert.equal(eligible(notice({ selected: false, scoreTotal: 95 })), false, "unselected is never hot alone");
  assert.equal(eligible(notice({ sourceType: "media", scoreTotal: 95 })), false, "one outlet alone is never hot");
});

test("one publisher's notices above the join cosine are asked about, never joined by the vector alone", () => {
  // Production, 2026-09-22: 「EMA 对 Sogroya / Anzupgo / Keytruda … 给出正面意见」
  // were joined into one event by the template's cosine.
  const reading = frontierVectorReading([
    { eventId: "7", cosine: 0.93, samePublisher: true },
    { eventId: "8", cosine: 0.9, samePublisher: false },
    { eventId: "9", cosine: 0.76, samePublisher: false },
  ]);
  assert.deepEqual(reading.strong, ["8"]);
  assert.deepEqual(reading.ask.map((pair) => pair.eventId), ["7", "9"]);
});

// ───────────────── the hot list's numbers (plan 2026-09-23 §6.5 #1, #2, #4) ─────────────────

test("a snapshot tracks the heat of every eligible event in the list's order, the first fifty, to four decimals", () => {
  const events = Array.from({ length: 60 }, (_, index) => ({ id: String(index + 1), publicId: `e${index + 1}`, heat: 60 - index + 0.123456,
    lastAt: NOW, eligible: index !== 1 }));
  events.push({ id: "99", publicId: "nan", heat: Number.NaN, lastAt: NOW, eligible: true });
  const tracked = frontierTrackedHeats(events);
  assert.equal(Object.keys(tracked).length, FRONTIER_HOT_TRACKED);
  assert.equal(tracked.e1, 60.1235);
  assert.equal(Object.hasOwn(tracked, "e2"), false, "an ineligible event is not tracked, however hot");
  assert.equal(Object.hasOwn(tracked, "nan"), false, "a heat that is not a number is not recorded");
  assert.equal(Object.keys(tracked).at(-1), "e51", "the ten listed and the forty just below them");
});

test("one snapshot's reading of an event: under any of its ids, the best rank and the highest heat", () => {
  const sample = { at: NOW, ranking: [{ rank: 3, eventId: "a" }, { rank: 1, eventId: "old" }, { rank: "x", eventId: "b" }],
    heats: { a: 2.1, old: 3.4, b: "hot" } };
  assert.deepEqual(frontierSnapshotReading(sample, ["a"]), { rank: 3, heat: 2.1 });
  assert.deepEqual(frontierSnapshotReading(sample, ["a", "old"]), { rank: 1, heat: 3.4 }, "an event folded in since counts as this one");
  assert.deepEqual(frontierSnapshotReading(sample, ["b"]), { rank: null, heat: null }, "what is not a number reads as nothing");
  assert.deepEqual(frontierSnapshotReading(null, ["a"]), { rank: null, heat: null });
  assert.deepEqual(frontierSnapshotReading({ at: NOW, ranking: "junk", heats: [1, 2] }, ["a"]), { rank: null, heat: null });
});

test("rank change against the list six hours before: places gained or lost, new, or nothing to compare with", () => {
  assert.equal(frontierRankChange({ rank: 1, before: { rank: 3 } }), 2);
  assert.equal(frontierRankChange({ rank: 5, before: { rank: 2 } }), -3);
  assert.equal(frontierRankChange({ rank: 4, before: { rank: 4 } }), 0);
  assert.equal(frontierRankChange({ rank: 4, before: { rank: null } }), "new", "not on that list");
  assert.equal(frontierRankChange({ rank: 4, before: null }), null, "no list that old");
});

test("the badge: new within twelve hours of its first report, rising when placed or measured higher than six hours before", () => {
  const takenAt = NOW;
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(11), takenAt, rank: 5, heat: 10, before: null }), "new");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(12), takenAt, rank: 5, heat: 10, before: { rank: 1, heat: 30 } }), "new", "twelve hours is still new");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(13), takenAt, rank: 5, heat: 10, before: null }), null, "no list six hours old: no rise to see");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(30), takenAt, rank: 2, heat: 10, before: { rank: 4, heat: 12 } }), "rising", "placed higher");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(30), takenAt, rank: 4, heat: 13, before: { rank: 4, heat: 12 } }), "rising", "hotter");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(30), takenAt, rank: 6, heat: 10, before: { rank: null, heat: null } }), "rising", "newly on the list");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(30), takenAt, rank: 4, heat: 12, before: { rank: 4, heat: 12 } }), null, "the same is no rise");
  assert.equal(frontierHotBadge({ firstAt: hoursAgo(30), takenAt, rank: 5, heat: 11, before: { rank: 3, heat: 14 } }), null, "cooling");
  assert.equal(frontierHotBadge({ firstAt: null, takenAt, rank: 5, heat: 11, before: { rank: 3, heat: null } }), null);
});

test("the list's reading of an event: the heat shown, the change, the badge and seven trend points — or no trend without six hours of history", () => {
  const at = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
  const sample = (hours, heats, ranking = []) => ({ at: at(hours), heats, ranking });
  const latest = sample(0, { cur: 2.44 }, [{ rank: 1, eventId: "cur" }]);
  const earlier = [sample(24, { old: 0.5 }), null, sample(16, { cur: 1.02 }), sample(12, { cur: 1.5 }), sample(8, { cur: 1.9 }), sample(4, { cur: 2.2 })];
  const compare = sample(6, { cur: 2.0 }, [{ rank: 3, eventId: "cur" }]);
  const reading = frontierHotReading({ rank: 1, ids: ["cur", "old"], firstAt: at(40), latest, compare, earlier });
  assert.equal(reading.heat, 24, "×10, rounded");
  assert.equal(reading.rankChange, 2);
  assert.equal(reading.badge, "rising");
  assert.deepEqual(reading.trend, [
    { at: at(24).toISOString(), heat: 5 }, { at: at(20).toISOString(), heat: null }, { at: at(16).toISOString(), heat: 10 },
    { at: at(12).toISOString(), heat: 15 }, { at: at(8).toISOString(), heat: 19 }, { at: at(4).toISOString(), heat: 22 },
    { at: NOW.toISOString(), heat: 24 },
  ], "oldest first; a folded-in event's heat counts; an hour with no snapshot is null");

  const young = frontierHotReading({ rank: 2, ids: ["cur"], firstAt: at(5), latest, compare: sample(6, {}, []), earlier });
  assert.equal(young.trend, null, "not tracked six hours ago: 「暂无走势」");
  assert.equal(young.rankChange, "new");
  assert.equal(young.badge, "new");
  const unrecorded = frontierHotReading({ rank: 1, ids: ["cur"], firstAt: at(40), fallbackHeat: 1.26, latest: sample(0, {}, []), compare: null, earlier: [] });
  assert.equal(unrecorded.heat, 13, "a snapshot from before heats were recorded: the event's stored heat");
  assert.deepEqual([unrecorded.rankChange, unrecorded.badge, unrecorded.trend], [null, null, null]);
});

test("the week's ranking: institutions in the window, then first-hand material, then the best rank reached, then the latest", () => {
  const ranked = frontierRankPeriod([
    { id: "1", institutions: 3, hasPrimary: false, bestRank: 1, lastAt: hoursAgo(5) },
    { id: "2", institutions: 5, hasPrimary: false, bestRank: null, lastAt: hoursAgo(50) },
    { id: "3", institutions: 3, hasPrimary: true, bestRank: 7, lastAt: hoursAgo(90) },
    { id: "4", institutions: 3, hasPrimary: true, bestRank: 2, lastAt: hoursAgo(90) },
    { id: "5", institutions: 3, hasPrimary: true, bestRank: null, lastAt: hoursAgo(1) },
    { id: "6", institutions: 3, hasPrimary: true, bestRank: null, lastAt: hoursAgo(2) },
  ]);
  assert.deepEqual(ranked.map((event) => event.id), ["2", "4", "3", "5", "6", "1"]);
  const many = frontierRankPeriod(Array.from({ length: 15 }, (_, index) => ({ id: String(index), institutions: index, hasPrimary: false, bestRank: null, lastAt: null })));
  assert.equal(many.length, FRONTIER_HOT_SIZE);
  assert.equal(many[0].id, "14");
});

test("institutions of the last 72 hours by kind: each once, as the kind of its most authoritative channel; the kinds add up", () => {
  const counted = frontierEventInstitutions({ now: NOW, members: [
    { role: "primary", ownerEntity: "nejm-group", authority: 5, timelineAt: hoursAgo(10), sourceType: "journal" },
    { role: "report", ownerEntity: "nejm-group", authority: 3, timelineAt: hoursAgo(9), sourceType: "media" },
    { role: "report", ownerEntity: "stat", authority: 3, timelineAt: hoursAgo(8), sourceType: "media" },
    { role: "primary", ownerEntity: "fda", authority: 5, timelineAt: hoursAgo(7), sourceType: "regulator" },
    { role: "report", ownerEntity: "reuters", authority: 3, timelineAt: hoursAgo(80), sourceType: "media" },
  ] });
  assert.deepEqual(counted, { total: 3, byType: [{ type: "journal", count: 1 }, { type: "regulator", count: 1 }, { type: "media", count: 1 }] },
    "a publisher's news arm is the publisher; a report older than 72 hours is not counted");
  assert.deepEqual(frontierEventInstitutions({ now: NOW, members: [] }), { total: 0, byType: [] });
});

test("the event's hourly trend: the heat function at each hour over the reports that existed by then, from the first report on", () => {
  const members = [
    { role: "primary", ownerEntity: "nejm-group", authority: 5, timelineAt: hoursAgo(10), lang: "en", sourceType: "journal" },
    { role: "report", ownerEntity: "stat", authority: 3, timelineAt: hoursAgo(4), lang: "en", sourceType: "media" },
  ];
  const trend = frontierHeatTrend({ members, now: NOW });
  assert.equal(trend.length, 11, "hours 10 … 0 before now");
  assert.equal(trend[0].at, hoursAgo(10));
  assert.equal(trend.at(-1).at, NOW.toISOString());
  assert.equal(trend[0].heat, 15, "the paper alone when it appeared: 1 × 1.5, shown ×10");
  assert.ok(trend[7].heat > trend[5].heat, "the report six hours later lifts it");
  assert.equal(trend.at(-1).heat, Math.round(frontierEventHeat({ members, now: NOW }) * 10), "the last point is the heat now");
  const old = frontierHeatTrend({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: hoursAgo(200), lang: "en" }], now: NOW });
  assert.equal(old.length, 73, "an event older than the window: every hour of 72, both ends counted");
  assert.equal(frontierHeatTrend({ members: [{ role: "report", ownerEntity: "a", authority: 5, timelineAt: hoursAgo(5), lang: "en" }], now: NOW }), null,
    "under six hours of history: 「暂无走势」");
  assert.equal(frontierHeatTrend({ members: [], now: NOW }), null);
});
