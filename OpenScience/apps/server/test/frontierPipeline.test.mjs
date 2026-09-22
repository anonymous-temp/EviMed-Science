import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  FRONTIER_TEXT_GIVE_UP_MS,
  FRONTIER_TEXT_HOLD_MS,
  FRONTIER_TEXT_RETRY_MS,
  FrontierPipeline,
  allowedLanes,
  entryKeys,
  frontierBudgetState,
  frontierDayWindow,
  frontierDropReason,
  frontierEditDecision,
  frontierEvidenceDecision,
  frontierItemFlags,
  frontierSafetyAlert,
  frontierSelectionDecision,
  frontierTextDecision,
  frontierTimelineAt,
  isCorrectionNotice,
  isUrgentSource,
  titleKey,
  usableSummary,
} from "../src/frontierPipeline.mjs";

const HOUR = 3_600_000;
const journal = { id: "j-nejm", source_type: "journal", authority: 5, lane: "evidence", safety_feed: false, region: "US" };
const smallJournal = { id: "j-small", source_type: "journal", authority: 3, lane: "evidence", safety_feed: false };
const media = { id: "m-stat", source_type: "media", authority: 2, lane: "mixed", safety_feed: false };
const safety = { id: "r-fda-medwatch", source_type: "regulator", authority: 5, lane: "safety", safety_feed: true };
const regulator = { id: "r-ema", source_type: "regulator", authority: 5, lane: "regulatory", safety_feed: false };
const company = { id: "c-novo", source_type: "company", authority: 2, lane: "pipeline", safety_feed: false };
const preprint = { id: "p-medrxiv", source_type: "preprint", authority: 3, lane: "evidence", safety_feed: false };
const chinese = { id: "m-cn", source_type: "media", authority: 2, lane: "mixed", safety_feed: false, region: "CN" };

test("a day in Asia/Shanghai starts at 16:00 UTC the day before", () => {
  const window = frontierDayWindow(new Date("2026-09-22T15:59:59Z"), "Asia/Shanghai");
  assert.equal(window.day, "2026-09-22");
  assert.equal(window.start.toISOString(), "2026-09-21T16:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-09-22T16:00:00.000Z");
  assert.equal(frontierDayWindow(new Date("2026-09-22T16:00:00Z"), "Asia/Shanghai").day, "2026-09-23");
  const utc = frontierDayWindow(new Date("2026-09-22T12:00:00Z"), "UTC");
  assert.equal(utc.start.toISOString(), "2026-09-22T00:00:00.000Z");
});

test("the budget: throttled from 80%, exhausted from 100%; no budget is no limit", () => {
  assert.equal(frontierBudgetState(0, 10), "ok");
  assert.equal(frontierBudgetState(7.99, 10), "ok");
  assert.equal(frontierBudgetState(8, 10), "throttled");
  assert.equal(frontierBudgetState(9.99, 10), "throttled");
  assert.equal(frontierBudgetState(10, 10), "exhausted");
  assert.equal(frontierBudgetState(50, 0), "ok");
});

test("urgent sources: safety feeds, regulators and authority-5 journals", () => {
  assert.equal(isUrgentSource(safety), true);
  assert.equal(isUrgentSource(regulator), true);
  assert.equal(isUrgentSource(journal), true);
  assert.equal(isUrgentSource(smallJournal), false);
  assert.equal(isUrgentSource(media), false);
  assert.equal(isUrgentSource({ ...company, authority: 5 }), false, "authority 5 alone is not urgency");
});

test("edit now or later: peak hours defer all but urgent items; 80% keeps only urgent; 100% edits nothing", () => {
  const peak = new Date("2026-09-22T02:00:00Z"); // Tuesday 10:00 in Beijing
  const lunch = new Date("2026-09-22T05:00:00Z"); // 13:00 in Beijing: off-peak
  const evening = new Date("2026-09-22T11:00:00Z"); // 19:00
  const saturday = new Date("2026-09-26T02:00:00Z");
  const ok = { state: "ok" };
  const decide = (/** @type {any} */ source, /** @type {any} */ budget, /** @type {Date} */ now, offpeak = true, available = true) =>
    frontierEditDecision({ source, budget, offpeak, now, available });
  assert.deepEqual(decide(media, ok, peak), { edit: false, reason: "peak" });
  assert.deepEqual(decide(media, ok, peak, false), { edit: true, reason: "ok" }, "off-peak deferral can be switched off");
  assert.deepEqual(decide(media, ok, lunch), { edit: true, reason: "ok" });
  assert.deepEqual(decide(media, ok, evening), { edit: true, reason: "ok" });
  assert.deepEqual(decide(media, ok, saturday), { edit: true, reason: "ok" }, "weekends are off-peak all day");
  for (const urgent of [safety, regulator, journal]) assert.deepEqual(decide(urgent, ok, peak), { edit: true, reason: "ok" });
  assert.deepEqual(decide(media, { state: "throttled" }, evening), { edit: false, reason: "throttled" });
  assert.deepEqual(decide(journal, { state: "throttled" }, peak), { edit: true, reason: "ok" });
  assert.deepEqual(decide(journal, { state: "exhausted" }, evening), { edit: false, reason: "exhausted" });
  assert.deepEqual(decide(journal, ok, evening, true, false), { edit: false, reason: "unavailable" });
});

test("a mixed source's items take any of the eight lanes; any other source's its own", () => {
  assert.deepEqual(allowedLanes(journal), ["evidence"]);
  assert.equal(allowedLanes(media).length, 8);
  assert.equal(allowedLanes({ lane: "gossip" }).length, 8, "an unknown lane is read as mixed");
});

test("the keys an entry is known by; an event-level identity dedupes by itself alone", () => {
  const canonical = "https://www.nejm.org/doi/full/10.1056/NEJMoa2307563";
  const keys = entryKeys({ identity_key: "doi:10.1056/nejmoa2307563", doi: "10.1056/NEJMoa2307563", pmid: "37952131",
    canonical_url: canonical, registry_ids: ["NCT03574597"] });
  assert.deepEqual(keys.dedupe, ["doi:10.1056/nejmoa2307563", "pmid:37952131", `url:${createHash("sha256").update(canonical).digest("hex")}`]);
  assert.deepEqual(keys.cluster, ["reg:NCT03574597"]);
  // ClinicalTrials.gov: "results posted" must not merge into "registered" (review #10).
  const registry = entryKeys({ identity_key: "reg:NCT03574597:results-posted:2026-09-20", doi: null, pmid: null,
    canonical_url: "https://clinicaltrials.gov/study/NCT03574597", registry_ids: ["NCT03574597"] });
  assert.deepEqual(registry.dedupe, ["reg:NCT03574597:results-posted:2026-09-20"]);
  assert.deepEqual(registry.cluster, ["reg:NCT03574597"]);
  assert.deepEqual(entryKeys({ identity_key: "fda:NDA215256:SUPPL-12", canonical_url: "https://x", doi: "10.1/x" }).dedupe, ["fda:NDA215256:SUPPL-12"]);
});

test("a feed summary stands in for an abstract only when it is whole and long enough", () => {
  assert.equal(usableSummary({ summary_raw: "x".repeat(80), defects: [] }), true);
  assert.equal(usableSummary({ summary_raw: "x".repeat(79), defects: [] }), false);
  assert.equal(usableSummary({ summary_raw: "x".repeat(500), defects: ["truncated-summary"] }), false);
  assert.equal(usableSummary({ summary_raw: null, defects: [] }), false);
});

test("mastheads and unreadable titles are dropped; correction notices are recognised", () => {
  assert.equal(frontierDropReason({ title_raw: "Editorial Board", facts: {} }), "masthead");
  assert.equal(frontierDropReason({ title_raw: "Anything", facts: { is_masthead: true } }), "masthead");
  assert.equal(frontierDropReason({ title_raw: `Bad ${String.fromCharCode(0xfffd)} title`, defects: ["encoding"], facts: {} }), "encoding");
  assert.equal(frontierDropReason({ title_raw: "Bad summary only", defects: ["encoding"], facts: {} }), null, "a garbled summary is not a garbled title");
  assert.equal(frontierDropReason({ title_raw: "Semaglutide in HFpEF", facts: {} }), null);
  assert.equal(isCorrectionNotice({ facts: { is_correction_notice: true } }), true);
  assert.equal(isCorrectionNotice({ facts: { update_to: [{ type: "retraction", doi: "10.1/x" }] } }), true);
  assert.equal(isCorrectionNotice({ facts: { update_to: [] } }), false);
});

test("the text step: take it when it is there, wait for it when it is worth waiting, never more than five days", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const fresh = { first_seen_at: new Date(now.getTime() - HOUR).toISOString(), summary_raw: "short", defects: ["short-summary"] };
  const old = { ...fresh, first_seen_at: new Date(now.getTime() - FRONTIER_TEXT_GIVE_UP_MS).toISOString() };
  const withSummary = { ...fresh, summary_raw: "s".repeat(200), defects: [] };
  const decide = (/** @type {any} */ status, /** @type {any} */ entry, /** @type {any} */ source, promoted = false) =>
    frontierTextDecision({ status, entry, source, promoted, now });
  assert.deepEqual(decide("available", fresh, smallJournal), { action: "promote", holdMs: 0 });
  assert.deepEqual(decide("unavailable", fresh, smallJournal), { action: "promote", holdMs: 0 });
  assert.deepEqual(decide("pending", fresh, smallJournal), { action: "hold", holdMs: FRONTIER_TEXT_HOLD_MS });
  assert.deepEqual(decide("error", fresh, smallJournal), { action: "hold", holdMs: FRONTIER_TEXT_RETRY_MS }, "a plugin that did not answer is asked again sooner");
  assert.deepEqual(decide("pending", old, smallJournal), { action: "promote", holdMs: 0 }, "after five days it goes on without");
  assert.deepEqual(decide("pending", fresh, journal), { action: "promote-hold", holdMs: FRONTIER_TEXT_HOLD_MS }, "a top journal never waits");
  assert.deepEqual(decide("pending", fresh, safety), { action: "promote-hold", holdMs: FRONTIER_TEXT_HOLD_MS });
  assert.deepEqual(decide("pending", withSummary, smallJournal), { action: "promote-hold", holdMs: FRONTIER_TEXT_HOLD_MS }, "a whole feed summary is enough to go on");
  assert.deepEqual(decide("pending", fresh, smallJournal, true), { action: "promote-hold", holdMs: FRONTIER_TEXT_HOLD_MS }, "a published item keeps asking");
});

test("evidence type decided by code: registries, FDA actions, safety feeds, newsrooms, then PubMed's research types", () => {
  const decide = (/** @type {any} */ source, /** @type {string} */ identityKey, /** @type {unknown} */ publicationTypes = []) =>
    frontierEvidenceDecision({ source, identityKey, publicationTypes });
  assert.deepEqual(decide(media, "reg:NCT1:registered:2026-09-20"), { fixed: { type: "other", basis: "registry" }, demote: false });
  assert.deepEqual(decide(regulator, "fda:NDA1:SUPPL-2"), { fixed: { type: "regulatory-decision", basis: "registry" }, demote: false });
  assert.deepEqual(decide(safety, "url:x"), { fixed: { type: "safety-notice", basis: "registry" }, demote: false });
  assert.deepEqual(decide(company, "url:x"), { fixed: { type: "press-release", basis: "registry" }, demote: false });
  assert.deepEqual(decide(journal, "doi:x", ["Randomized Controlled Trial", "Journal Article"]), { fixed: { type: "rct", basis: "pubmed-types" }, demote: false });
  assert.deepEqual(decide(journal, "doi:x", ["Comment"]), { fixed: { type: "review-opinion", basis: "pubmed-types" }, demote: true });
  assert.deepEqual(decide(journal, "doi:x", ["Journal Article"]), { fixed: null, demote: false }, "the model's pick until types arrive");
  assert.deepEqual(decide(journal, "doi:x"), { fixed: null, demote: false });
});

test("flags are code's: registry facts, defects, identifiers, affiliations and links", () => {
  const entry = { defects: [], facts: {}, identity_key: "doi:x", summary_raw: null };
  const item = { doi: "10.1/x", pmid: null, date_precision: "instant" };
  const text = { abstract_raw: "An abstract.", body_excerpt: null, enrichment: {} };
  const flags = (/** @type {Record<string, any>} */ input) => frontierItemFlags({ source: journal, entry, item, text, ...input });
  assert.deepEqual(flags({}), []);
  assert.deepEqual(flags({ source: preprint, text: { ...text, enrichment: { published_version_doi: "10.1/y" } } }), ["preprint", "published-version"]);
  assert.deepEqual(flags({ source: company, item: { ...item, doi: null } }), ["press-release"], "a newsroom item without a paper");
  assert.deepEqual(flags({ source: company }), [], "a newsroom item that names its paper");
  assert.deepEqual(flags({ source: media, modelFlags: ["press-release"] }), ["press-release"], "a release republished by a medium");
  assert.deepEqual(flags({ text: { abstract_raw: null, body_excerpt: null, enrichment: {} } }), ["no-abstract"]);
  assert.deepEqual(flags({ item: { ...item, date_precision: "inferred" } }), ["date-inferred"]);
  assert.deepEqual(flags({ entry: { ...entry, defects: ["future-date"] } }), ["date-inferred"]);
  assert.deepEqual(flags({ source: chinese }), ["china"]);
  assert.deepEqual(flags({ text: { ...text, enrichment: { affiliation_countries: ["US", "CN"] } } }), ["china"], "contract 1.1.0 affiliations");
  assert.deepEqual(flags({ entry: { ...entry, identity_key: "reg:NCT1:registered:2026-09-20", facts: { trial_event: "registered" } } }), ["registry-unpublished"]);
  assert.deepEqual(flags({ entry: { ...entry, identity_key: "reg:NCT1:results-posted:2026-09-20", facts: { trial_event: "results-posted" } } }), []);
  assert.deepEqual(flags({ entry: { ...entry, identity_key: "reg:NCT1:updated:2026-09-20", facts: { trial_event: "updated" } } }), ["registry-unpublished", "data-updated"]);
  assert.deepEqual(flags({ linkFlags: ["corrected", "retracted"] }), ["retracted", "corrected"], "in the vocabulary's order");
});

test("timeline_at: the publication instant, or the source's date when that is more than 72 hours older", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  assert.equal(frontierTimelineAt(now, null).toISOString(), now.toISOString());
  assert.equal(frontierTimelineAt(now, "2026-09-20T12:00:00Z").toISOString(), now.toISOString(), "48 hours: today");
  assert.equal(frontierTimelineAt(now, "2026-09-19T12:00:00Z").toISOString(), now.toISOString(), "exactly 72 hours: today");
  assert.equal(frontierTimelineAt(now, "2026-09-15T00:00:00Z").toISOString(), "2026-09-15T00:00:00.000Z", "a week old: its own day");
  assert.equal(frontierTimelineAt(now, "not a date").toISOString(), now.toISOString());
});

test("selection: safety alerts always; verified items at the threshold while the source has room; never demoted or retracted", () => {
  const base = { safetyAlert: false, verification: "passed", scoreTotal: 75, demoted: false, flags: [], source: smallJournal, selectedToday: 0, threshold: 70 };
  const decide = (/** @type {Record<string, any>} */ overrides) => frontierSelectionDecision({ ...base, ...overrides });
  assert.deepEqual(decide({}), { selected: true, rule: "threshold" });
  assert.deepEqual(decide({ safetyAlert: true, verification: "pending", scoreTotal: null, selectedToday: 99 }), { selected: true, rule: "safety-bypass" });
  assert.deepEqual(decide({ scoreTotal: 69 }), { selected: false, rule: null });
  assert.deepEqual(decide({ scoreTotal: 70, verification: "repaired" }), { selected: true, rule: "threshold" });
  assert.deepEqual(decide({ verification: "title-only" }), { selected: false, rule: null });
  assert.deepEqual(decide({ verification: "pending", scoreTotal: null }), { selected: false, rule: null });
  assert.deepEqual(decide({ selectedToday: 3 }), { selected: false, rule: null, capped: true }, "three a day per source");
  assert.deepEqual(decide({ source: journal, selectedToday: 3 }), { selected: true, rule: "threshold" }, "a top journal five");
  assert.deepEqual(decide({ source: journal, selectedToday: 5 }), { selected: false, rule: null, capped: true });
  assert.deepEqual(decide({ demoted: true }), { selected: false, rule: null });
  assert.deepEqual(decide({ flags: ["retracted"] }), { selected: false, rule: null });
});

test("near-duplicate titles compare without case, spacing or punctuation", () => {
  assert.equal(titleKey("Semaglutide, and Heart-Failure: a RCT."), titleKey("semaglutide and heart failure — a RCT"));
  assert.equal(titleKey("司美格鲁肽：心衰新证据"), "司美格鲁肽心衰新证据");
});

test("the pipeline refuses to start without what it needs", () => {
  const database = { query: async () => ({ rows: [] }) };
  const editor = { screen: async () => ({}), edit: async () => ({}) };
  const plugin = { text: async () => ({}) };
  assert.throws(() => new FrontierPipeline(/** @type {any} */ ({ editor, plugin })), /database/);
  assert.throws(() => new FrontierPipeline(/** @type {any} */ ({ database, plugin, editor: {} })), /editor/);
  assert.throws(() => new FrontierPipeline(/** @type {any} */ ({ database, editor, plugin: {} })), /plugin/);
  const pipeline = new FrontierPipeline({ database, editor, plugin, config: { frontierSelectThreshold: 65, frontierDailyBudgetCny: 4, frontierTimeZone: "UTC" } });
  assert.equal(pipeline.threshold, 65);
  assert.equal(pipeline.budgetCny, 4);
  assert.equal(pipeline.timeZone, "UTC");
  assert.equal(pipeline.owner, null, "no owner until the editor has one");
});

test("the budget is read for the editor's owner, as settled plus open cost of today's frontier rows", async () => {
  /** @type {Array<{ text: string, values: any[] }>} */
  const queries = [];
  const database = {
    async query(/** @type {string} */ text, /** @type {any[]} */ values = []) {
      queries.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ name: "evimed_usage.model_requests" }] };
      return { rows: [{ spent: "8.5" }] };
    },
  };
  const editor = { screen: async () => ({}), edit: async () => ({}), owner: { userId: "operator", projectId: "evimed-frontier" } };
  const pipeline = new FrontierPipeline({ database, editor, plugin: { text: async () => ({}) }, config: { frontierDailyBudgetCny: 10 } });
  const budget = await pipeline.budget(new Date("2026-09-22T12:00:00Z"));
  assert.deepEqual(budget, { spentCny: 8.5, budgetCny: 10, state: "throttled", measured: true });
  const sum = queries.find((query) => query.text.includes("model_requests") && !query.text.includes("to_regclass"));
  assert.deepEqual(sum?.values, ["operator", "evimed-frontier", "2026-09-21T16:00:00.000Z"]);
  assert.match(sum?.text ?? "", /purpose='frontier'/);
  editor.owner = /** @type {any} */ (null);
  assert.deepEqual(await pipeline.budget(), { spentCny: 0, budgetCny: 10, state: "ok", measured: false });
});

test("a safety alert is a safety feed's item, or a regulator's own notice the edit typed as one", () => {
  // The registry marks whole feeds; NMPA's mixed 其他公告通告 column is not one
  // (2026-09-22: a 参比制剂目录 announcement was shown red), so there the
  // evidence type decides — and never for a journal or a news site.
  assert.equal(frontierSafetyAlert({ source: { safety_feed: true, source_type: "regulator" }, evidenceType: "regulatory-decision" }), true);
  assert.equal(frontierSafetyAlert({ source: { safety_feed: false, source_type: "regulator" }, evidenceType: "safety-notice" }), true);
  assert.equal(frontierSafetyAlert({ source: { safety_feed: false, source_type: "regulator" }, evidenceType: "regulatory-decision" }), false);
  assert.equal(frontierSafetyAlert({ source: { safety_feed: false, source_type: "media" }, evidenceType: "safety-notice" }), false);
  assert.equal(frontierSafetyAlert({ source: { safety_feed: false, source_type: "journal" }, evidenceType: "safety-notice" }), false);
  assert.equal(frontierSafetyAlert({ source: null, evidenceType: null }), false);
});
