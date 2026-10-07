// The programme's own parts that need no database: the decision's closed schema and its fallback, the worker's schedule over the platform's
// job ledger, and the metric families an operator reads.
import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceProgrammeWorker, evidenceProgrammeMetricFamilies, fallbackProgrammeAction, parseProgrammeDecision } from "../src/evidenceProgramme.mjs";
import { EVIDENCE_PROGRAMME_ZONES, PROGRAMME_DECISION_HOUR } from "../src/evidenceProgrammeData.mjs";
import { AUTOPILOT_TASK_TYPES } from "@evimed/domain";

const zones = new Map([
  ["af-anticoagulation", { choosable: true, allowed: ["evidence-update", "literature-sentinel"] }],
  ["nsclc", { choosable: true, allowed: ["evidence-update", "literature-sentinel", "signal-monitoring"] }],
  ["breast-cancer", { choosable: false, allowed: ["evidence-update"] }],
]);

test("the official zones are data in one module: six zones, every task type a real one, the operator's three recognised by title and not made", () => {
  assert.deepEqual(EVIDENCE_PROGRAMME_ZONES.map((zone) => zone.title), ["房颤抗凝", "心肾与慢性肾病", "研究解读", "非小细胞肺癌", "乳腺癌", "2 型糖尿病"]);
  assert.deepEqual(EVIDENCE_PROGRAMME_ZONES.filter((zone) => zone.origin === "imported").map((zone) => zone.key), ["af-anticoagulation", "cardiorenal-ckd", "research-interpretation"]);
  for (const zone of EVIDENCE_PROGRAMME_ZONES) {
    assert.ok(zone.topic.taskTypes.every((type) => AUTOPILOT_TASK_TYPES.includes(type)), `${zone.key}: task types are the domain's`);
    assert.ok(zone.topic.standingQuestion && zone.topic.questionZh, zone.key);
    if (zone.origin === "programme") assert.ok(zone.requestId && zone.description && zone.background, `${zone.key} carries the text it is made with`);
  }
  assert.equal(new Set(EVIDENCE_PROGRAMME_ZONES.map((zone) => zone.key)).size, 6);
});

test("the decision is parsed against a closed schema: only a zone that can be chosen, a task type it allows, once, within what the budget buys", () => {
  const ok = JSON.stringify({ actions: [{ zone: "nsclc", taskType: "signal-monitoring", reason: "有安全警示" }, { zone: "af-anticoagulation", taskType: "evidence-update", reason: "新试验" }], reason: "两个题目" });
  assert.deepEqual(parseProgrammeDecision(ok, { zones, maxActions: 2 }).actions.map((action) => action.zone), ["nsclc", "af-anticoagulation"]);
  assert.deepEqual(parseProgrammeDecision("```json\n" + ok + "\n```", { zones, maxActions: 2 }).actions.length, 2, "a fenced answer is read");
  assert.deepEqual(parseProgrammeDecision(JSON.stringify({ actions: [], reason: "没有变化" }), { zones, maxActions: 1 }), { actions: [], reason: "没有变化" }, "choosing nothing is an answer");
  const refused = (content, maxActions = 2) => assert.throws(() => parseProgrammeDecision(content, { zones, maxActions }), { code: "evidence_programme_decision_invalid" });
  refused(ok, 1);
  refused(JSON.stringify({ actions: [{ zone: "breast-cancer", taskType: "evidence-update", reason: "x" }] }));
  refused(JSON.stringify({ actions: [{ zone: "oncology", taskType: "evidence-update", reason: "x" }] }));
  refused(JSON.stringify({ actions: [{ zone: "af-anticoagulation", taskType: "signal-monitoring", reason: "x" }] }));
  refused(JSON.stringify({ actions: [{ zone: "nsclc", taskType: "evidence-update", reason: "x" }, { zone: "nsclc", taskType: "literature-sentinel", reason: "y" }] }));
  refused(JSON.stringify({ actions: [{ zone: "nsclc", taskType: "evidence-update", reason: "  " }] }));
  refused(JSON.stringify({ zone: "nsclc" }));
  refused("");
  refused(undefined);
});

test("the fallback is deterministic: the zone with the most unmatched new evidence, and nothing when there is none", () => {
  const zone = (key, over = {}) => ({ key, choosable: true, allowed: ["evidence-update", "literature-sentinel"], unmatched: 0, safetyAlerts: 0, stale: 0, lastFailed: {}, ...over });
  assert.equal(fallbackProgrammeAction([zone("a"), zone("b")]), null, "no new evidence, no action");
  assert.equal(fallbackProgrammeAction([zone("a", { unmatched: 2 }), zone("b", { unmatched: 5 }), zone("c", { unmatched: 3 })])?.zone, "b");
  assert.equal(fallbackProgrammeAction([zone("a", { unmatched: 4, safetyAlerts: 0 }), zone("b", { unmatched: 4, safetyAlerts: 2 })])?.zone, "b", "ties go to the safety alerts, then the stale cards, then the key");
  assert.equal(fallbackProgrammeAction([zone("z", { unmatched: 4 }), zone("a", { unmatched: 4 })])?.zone, "a");
  assert.equal(fallbackProgrammeAction([zone("a", { unmatched: 9, choosable: false }), zone("b", { unmatched: 1 })])?.zone, "b", "a zone the programme cannot write is not chosen");
  assert.equal(fallbackProgrammeAction([zone("a", { unmatched: 3, lastFailed: { "evidence-update": true } })])?.taskType, "literature-sentinel", "a type that has failed twice is not repeated");
  assert.equal(fallbackProgrammeAction([zone("a", { unmatched: 3 })])?.taskType, "evidence-update");
});

/** A job ledger and a programme that only record what the worker asks. */
function harness({ localHour = 9, localDay = "2026-10-05", jobs: queue = [], failRun = false, canRun = true } = {}) {
  const calls = { enqueue: [], claim: [], finish: [], fail: [], runDay: [], sweep: 0, ready: 0 };
  let clock = new Date("2026-10-05T01:00:00Z");
  const state = { localHour, localDay, canRun };
  const jobs = {
    enqueue: async (...args) => { calls.enqueue.push(args); },
    claim: async (...args) => { calls.claim.push(args); return queue.shift() ?? null; },
    renew: async () => true,
    finish: async (...args) => { calls.finish.push(args); },
    fail: async (...args) => { calls.fail.push(args); },
  };
  const programme = {
    runDay: async (day) => { calls.runDay.push(day); if (failRun) throw Object.assign(new Error("boom"), { code: "evidence_programme_failed" }); return { state: "decided" }; },
    sweep: async () => { calls.sweep += 1; }, ready: async () => { calls.ready += 1; }, localDay: () => state.localDay, localHour: () => state.localHour,
  };
  const worker = new EvidenceProgrammeWorker({ programme, jobs, canRun: () => state.canRun, now: () => clock, sweepMs: 300_000 });
  return { worker, calls, state, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test("the worker enqueues the day's decision once, at the programme's hour, and runs the job it claims", async () => {
  const day = harness({ localHour: PROGRAMME_DECISION_HOUR - 1, jobs: [] });
  await day.worker.tick();
  assert.equal(day.calls.enqueue.length, 0, "before the hour there is nothing to decide");
  day.state.localHour = PROGRAMME_DECISION_HOUR;
  await day.worker.tick();
  await day.worker.tick();
  assert.equal(day.calls.enqueue.length, 1, "once a day, however often it ticks");
  const [userId, kind, payload, options] = day.calls.enqueue[0];
  assert.deepEqual([userId, kind, payload, options.idempotencyKey, options.projectId], ["evimed-evidence-center", "evidence-programme", { day: "2026-10-05" }, "evidence-programme:2026-10-05", "evimed-evidence"]);
  day.state.localDay = "2026-10-06";
  await day.worker.tick();
  assert.equal(day.calls.enqueue.length, 2, "and again the next day");
  assert.equal(day.calls.enqueue[1][3].idempotencyKey, "evidence-programme:2026-10-06");

  const claimed = harness({ jobs: [{ id: "job-1", userId: "evimed-evidence-center", leaseToken: "lease", attempts: 1, payload: { day: "2026-10-05" } }] });
  await claimed.worker.tick();
  assert.deepEqual(claimed.calls.runDay, ["2026-10-05"], "the day on the job, not the day it happens to run");
  assert.equal(claimed.calls.finish.length, 1);
  assert.deepEqual(claimed.calls.claim[0][0], ["evidence-programme"], "it claims its own kind and no other");
  assert.equal(claimed.worker.status().lastError, null);
});

test("a failed decision is released for a retry with its code; a maintenance pause does nothing at all", async () => {
  const failing = harness({ failRun: true, jobs: [{ id: "job-2", userId: "evimed-evidence-center", leaseToken: "lease", attempts: 2, payload: { day: "2026-10-05" } }] });
  await failing.worker.tick();
  assert.equal(failing.calls.finish.length, 0);
  assert.equal(failing.calls.fail.length, 1);
  assert.equal(failing.calls.fail[0][3].code, "evidence_programme_failed");
  assert.equal(failing.calls.fail[0][4].retry, true);
  assert.equal(failing.worker.status().lastError, "evidence_programme_failed");
  const paused = harness({ canRun: false, jobs: [{ id: "job-3", userId: "x", leaseToken: "l", attempts: 1, payload: {} }] });
  await paused.worker.tick();
  assert.deepEqual([paused.calls.enqueue.length, paused.calls.claim.length, paused.calls.sweep], [0, 0, 0]);
});

test("the sweep runs every few minutes, not every tick", async () => {
  const swept = harness();
  await swept.worker.tick();
  await swept.worker.tick();
  assert.equal(swept.calls.sweep, 1);
  swept.advance(301_000);
  await swept.worker.tick();
  assert.equal(swept.calls.sweep, 2);
});

test("the timer is the worker's own and the maintenance pause clears it", async () => {
  const { worker } = harness({ jobs: [] });
  assert.equal(worker.timer, null);
  worker.start();
  assert.ok(worker.timer, "armed");
  await worker.close();
  assert.equal(worker.timer, null, "and closed with nothing running");
});

test("every outcome of the programme has a metric family: decisions, signals, actions, cards, excluded claims, admissions", () => {
  assert.deepEqual(evidenceProgrammeMetricFamilies(null), []);
  assert.deepEqual(evidenceProgrammeMetricFamilies({ enabled: false }), [], "a programme that is off exports nothing");
  const counters = { decisions: { model: 2, fallback: 1, none: 0 }, signals: { frontier: 6, demand: 1, reads: 2, requests: 2 }, signalFailures: { reads: 1, requests: 0 }, demandEntities: 3, actions: { scheduled: 2, budget: 1 },
    cards: { published: 1, pending_verification: 4 }, claimsExcluded: { refuted: 2 }, claimsPublished: 5, original: { signal: 1, deferred: 1 }, admissions: { admitted: 2, budget: 1, slot: 0 }, hookFailures: 0 };
  const families = evidenceProgrammeMetricFamilies(/** @type {any} */ ({ enabled: true, status: () => ({ counters }) }));
  const byName = Object.fromEntries(families.map((family) => [family.name, family]));
  for (const name of ["decisions_total", "signals_total", "signal_failures_total", "demand_entities_total", "actions_total", "cards_total", "claims_excluded_total", "claims_published_total", "original_analyses_total", "admissions_total", "hook_failures_total"]) {
    assert.ok(byName[`open_science_evidence_programme_${name}`], name);
  }
  assert.deepEqual(byName.open_science_evidence_programme_decisions_total.series, [{ labels: { source: "model" }, value: 2 }, { labels: { source: "fallback" }, value: 1 }, { labels: { source: "none" }, value: 0 }]);
  assert.deepEqual(byName.open_science_evidence_programme_cards_total.series.find((entry) => entry.labels.outcome === "pending_verification"), { labels: { outcome: "pending_verification" }, value: 4 });
  assert.equal(byName.open_science_evidence_programme_claims_published_total.series[0].value, 5);
  assert.deepEqual(byName.open_science_evidence_programme_signal_failures_total.series, [{ labels: { class: "reads" }, value: 1 }, { labels: { class: "requests" }, value: 0 }], "a page signal that could not be read is counted by class");
  assert.deepEqual(byName.open_science_evidence_programme_signals_total.series.filter((entry) => ["reads", "requests"].includes(entry.labels.class)).map((entry) => entry.value), [2, 2]);
});
