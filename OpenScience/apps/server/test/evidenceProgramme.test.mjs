// The programme's own parts that need no database: the decision's closed schema and its fallback, the worker's schedule over the platform's
// job ledger, and the metric families an operator reads.
import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceProgrammeWorker, evidenceProgrammeMetricFamilies, fallbackProgrammeAction, parseProgrammeDecision, rankProgrammeTopics, subjectNamesIn, summariseProgrammeDecision, topicBoardStanding } from "../src/evidenceProgramme.mjs";
import { EVIDENCE_PROGRAMME_ZONES, PROGRAMME_DECISION_HOUR, PROGRAMME_TOPIC_TASK_TYPE, SELECTOR_ZONES, TOPIC_ZONE } from "../src/evidenceProgrammeData.mjs";
import { AUTOPILOT_TASK_TYPES } from "@evimed/domain";

const zones = new Map([
  ["af-anticoagulation", { choosable: true, allowed: ["evidence-update", "literature-sentinel"] }],
  ["nsclc", { choosable: true, allowed: ["evidence-update", "literature-sentinel", "signal-monitoring"] }],
  ["breast-cancer", { choosable: false, allowed: ["evidence-update"] }],
]);

test("the official zones are data in one module: seven zones, every task type a real one, the operator's three recognised by title and not made", () => {
  assert.deepEqual(EVIDENCE_PROGRAMME_ZONES.map((zone) => zone.title), ["房颤抗凝", "心肾与慢性肾病", "研究解读", "非小细胞肺癌", "乳腺癌", "2 型糖尿病", "热点求证"]);
  assert.deepEqual(EVIDENCE_PROGRAMME_ZONES.filter((zone) => zone.origin === "imported").map((zone) => zone.key), ["af-anticoagulation", "cardiorenal-ckd", "research-interpretation"]);
  for (const zone of EVIDENCE_PROGRAMME_ZONES) {
    assert.ok(zone.topic.taskTypes.every((type) => AUTOPILOT_TASK_TYPES.includes(type)), `${zone.key}: task types are the domain's`);
    assert.ok(zone.topic.standingQuestion && zone.topic.questionZh, zone.key);
    if (zone.origin === "programme") assert.ok(zone.requestId && zone.description && zone.background, `${zone.key} carries the text it is made with`);
  }
  assert.equal(new Set(EVIDENCE_PROGRAMME_ZONES.map((zone) => zone.key)).size, 7);
  assert.equal(new Set(EVIDENCE_PROGRAMME_ZONES.filter((zone) => zone.requestId).map((zone) => zone.requestId)).size, 4, "each zone the programme makes has its own request id");
});

test("「热点求证」 answers the day's hot topic: a programme zone with its own text and request id, no terms, a synthesis task type, and never the selector's choice", () => {
  assert.equal(TOPIC_ZONE?.key, "hot-questions");
  assert.deepEqual([TOPIC_ZONE.title, TOPIC_ZONE.origin, TOPIC_ZONE.answersTopics, TOPIC_ZONE.requestId], ["热点求证", "programme", true, "evimed-evidence-zone-20261025-hot-questions"]);
  assert.match(TOPIC_ZONE.requestId, /^evimed-evidence-zone-\d{8}-[a-z0-9-]+$/, "in the form the other programme zones use");
  assert.deepEqual(TOPIC_ZONE.topic.terms, [], "fed by topics, never by the feed's entity counts");
  assert.ok(TOPIC_ZONE.topic.taskTypes.includes(PROGRAMME_TOPIC_TASK_TYPE), "a topic's episode is a synthesis the zone allows");
  assert.ok(!TOPIC_ZONE.topic.taskTypes.includes("signal-monitoring"));
  for (const text of [TOPIC_ZONE.description, TOPIC_ZONE.background, TOPIC_ZONE.topic.questionZh]) assert.match(text, /[\u4e00-\u9fff]/, "plain Chinese for the reader");
  assert.match(TOPIC_ZONE.background, /原始研究/);
  assert.match(TOPIC_ZONE.background, /绝对风险/);
  assert.ok(!SELECTOR_ZONES.some((zone) => zone.key === "hot-questions"), "the selector never chooses it");
  assert.equal(SELECTOR_ZONES.length, 6);
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

test("where a hot topic was seen is two numbers: distinct boards, and the best rank on any of them", () => {
  assert.deepEqual(topicBoardStanding([{ board: "weibo", peakRank: 7 }, { board: "baidu", peakRank: 3 }, { board: "weibo", peakRank: 2 }]), { boards: 2, bestRank: 2 }, "a board seen twice is one board");
  assert.deepEqual(topicBoardStanding(["weibo", "toutiao"]), { boards: 2, bestRank: null }, "a board named alone has no rank");
  assert.deepEqual(topicBoardStanding([{ board: "baidu", rank: 4 }, { board: "toutiao", bestRank: 9 }]), { boards: 2, bestRank: 4 }, "the rank may be recorded under the trigger's other names");
  assert.deepEqual(topicBoardStanding([{ peakRank: 1 }, { board: " ", peakRank: 1 }, { board: "weibo", peakRank: 0 }, { board: "baidu", peakRank: "x" }, null, 5]), { boards: 2, bestRank: null },
    "an entry that names no board is not counted, and a rank that is not a positive number is no rank");
  assert.deepEqual(topicBoardStanding(null), { boards: 0, bestRank: null });
});

test("the day's pick ranks hot topics in code: a surge first, then the most boards, then the best peak rank, then the earliest accepted, then the id", () => {
  const order = (topics) => rankProgrammeTopics(topics).map((topic) => topic.id);
  const at = (hour) => `2026-10-05T0${hour}:00:00.000Z`;
  assert.deepEqual(order([
    { id: "wide", surge: false, boards: [{ board: "weibo", peakRank: 1 }, { board: "baidu", peakRank: 1 }, { board: "toutiao", peakRank: 1 }], acceptedAt: at(1) },
    { id: "surge", surge: true, boards: [{ board: "weibo", peakRank: 20 }], acceptedAt: at(2) },
  ]), ["surge", "wide"], "a surge beats a topic on more boards");
  assert.deepEqual(order([
    { id: "one", boards: [{ board: "weibo", peakRank: 1 }], acceptedAt: at(1) },
    { id: "two", boards: [{ board: "weibo", peakRank: 30 }, { board: "baidu", peakRank: 30 }], acceptedAt: at(2) },
  ]), ["two", "one"], "two boards beat one, whatever the rank");
  assert.deepEqual(order([
    { id: "low", boards: [{ board: "weibo", peakRank: 12 }], acceptedAt: at(1) },
    { id: "high", boards: [{ board: "baidu", peakRank: 3 }], acceptedAt: at(2) },
    { id: "unranked", boards: ["toutiao"], acceptedAt: at(0) },
  ]), ["high", "low", "unranked"], "then the best peak rank; no rank is the worst");
  assert.deepEqual(order([
    { id: "b", boards: [{ board: "weibo", peakRank: 3 }], acceptedAt: at(2) },
    { id: "a", boards: [{ board: "weibo", peakRank: 3 }], acceptedAt: at(2) },
    { id: "c", boards: [{ board: "weibo", peakRank: 3 }], acceptedAt: at(1) },
  ]), ["c", "a", "b"], "a full tie goes to the earliest accepted (nearest to leaving the window), then the id");
  assert.deepEqual(rankProgrammeTopics([]), []);
});

test("a subject name is found in a card's title by exact comparison of the topic's closed list, folded for width, case and space", () => {
  assert.deepEqual(subjectNamesIn(["张某某猝死：年轻人风险有多大？"], ["张某某"]), ["张某某"]);
  assert.deepEqual(subjectNamesIn(["What Kevin  Smith's collapse means"], ["kevin smith"]), ["kevin smith"], "case and spaces are folded");
  assert.deepEqual(subjectNamesIn(["ＡＢＣ 俱乐部球员心脏骤停"], ["ABC俱乐部"]), ["ABC俱乐部"], "full-width letters are folded");
  assert.deepEqual(subjectNamesIn(["年轻人心源性猝死的风险有多大？", "年轻人发生心源性猝死的风险有多大？"], ["张某某", "某俱乐部"]), [], "the question names nobody");
  assert.deepEqual(subjectNamesIn(["张三丰的问题"], ["张", "", null]), [], "a name of fewer than two characters names nobody");
  assert.deepEqual(subjectNamesIn(["任何标题"], null), []);
});

test("the operator reads the day's topic pick and what became of the topic beside each action", () => {
  const summary = summariseProgrammeDecision({ id: "programme-decision-2026-10-05", payload: {
    day: "2026-10-05", source: "model", topicPick: { state: "picked", candidates: 2, topicId: "tpabc123def4567", surge: true, boards: 2, bestRank: 1 },
    actions: [{ zone: "hot-questions", taskType: "evidence-update", status: "scheduled", reason: "今天最强的热点话题", topicId: "tpabc123def4567", topicState: "skipped", topicReason: "no_qualifying_claims", episodeId: "episode-1" },
      { zone: "nsclc", taskType: "evidence-update", status: "deferred", reason: "concurrency" }],
    outcomes: { "episode-1": { outcome: "no_qualifying_claims" } } } });
  assert.deepEqual(summary.topicPick, { state: "picked", candidates: 2, topicId: "tpabc123def4567", surge: true, boards: 2, bestRank: 1 });
  assert.deepEqual([summary.actions[0].topicId, summary.actions[0].topicState, summary.actions[0].topicReason, summary.actions[0].outcome], ["tpabc123def4567", "skipped", "no_qualifying_claims", "no_qualifying_claims"]);
  assert.deepEqual([summary.actions[1].topicId, summary.actions[1].topicState], [null, null], "a zone's own action has no topic");
  assert.equal(summariseProgrammeDecision({ id: "x", payload: { actions: [] } }).topicPick, null, "a decision made before topics existed says so");
});

test("the topic pick and the topic states have their metric families", () => {
  const counters = { decisions: { model: 0, fallback: 0, none: 0, topic: 1 }, signals: {}, signalFailures: {}, demandEntities: 0, actions: {}, cards: {}, claimsExcluded: {}, claimsPublished: 0,
    original: {}, admissions: {}, hookFailures: 0, topics: { picks: { picked: 3, none: 1, zone_unavailable: 0, unreadable: 0 }, states: { taken: 3, card: 2, skipped: 1, expired: 0 } } };
  const byName = Object.fromEntries(evidenceProgrammeMetricFamilies(/** @type {any} */ ({ enabled: true, status: () => ({ counters }) })).map((family) => [family.name, family]));
  assert.deepEqual(byName.open_science_evidence_programme_topic_picks_total.series.find((entry) => entry.labels.outcome === "picked"), { labels: { outcome: "picked" }, value: 3 });
  assert.deepEqual(byName.open_science_evidence_programme_topic_states_total.series.find((entry) => entry.labels.state === "card"), { labels: { state: "card" }, value: 2 });
  assert.deepEqual(byName.open_science_evidence_programme_decisions_total.series.find((entry) => entry.labels.source === "topic"), { labels: { source: "topic" }, value: 1 });
  const older = evidenceProgrammeMetricFamilies(/** @type {any} */ ({ enabled: true, status: () => ({ counters: { ...counters, topics: undefined } }) }));
  assert.deepEqual(older.find((family) => family.name.endsWith("topic_picks_total")).series, [], "counters without topics export empty series, never a throw");
});
