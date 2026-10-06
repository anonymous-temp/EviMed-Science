// What the topic selector reads of the public pages, and what an operator reads of the programme (evidence-flywheel polish, 2026-10-06):
// the reads of a zone's pages and the open topic requests are counted per zone and handed to the selector as numbers, and the day's
// decision, the six zones and the budget are one view. Real PostgreSQL; the model and the glossary are the doubles of the programme's own tests.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createEvidenceTopicRequests, topicRequestCounts } from "../src/evidencePublicRequests.mjs";
import { pageReads, recordPageRead } from "../src/evidencePublicReads.mjs";
import { modelAnswer, programmeFixture } from "./helpers/evidenceProgrammeFixture.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let fx;
/** @type {Record<string, any>} */ const ids = {};
const day = "2026-10-05";
const TITLES = { lung: "非小细胞肺癌的免疫治疗到底怎么选", diabetes: "糖尿病新药的心肾证据", unrelated: "今年有哪些值得细读的新研究", both: "房颤合并非小细胞肺癌的抗凝" };

before(async () => {
  if (!url) return;
  fx = await programmeFixture({ url, label: "programmeops", callModel: async () => modelAnswer({ actions: [{ zone: "nsclc", taskType: "evidence-update", reason: "肺癌专区被读得最多" }], reason: "按计数选题" }) });
  for (const zone of await fx.programme.ensureOfficialZones()) if (zone.id) ids[zone.key] = zone.id;
});
after(async () => { await fx?.close(); });

/** The two readers the programme is handed, over the real tables. */
const wire = () => fx.programme.useSignals({
  pageReads: (/** @type {any} */ query) => pageReads(fx.database, query),
  topicRequests: () => topicRequestCounts(fx.database, { limit: 100 }),
});
const unwire = () => fx.programme.useSignals({ pageReads: null, topicRequests: null });

test("without the public pages' readers the signal is reported as not recorded, which is not zero", options, async () => {
  const signals = await fx.programme.gatherSignals(day);
  assert.equal(signals.readsRecorded, false);
  assert.equal(signals.topicRequestsRecorded, false);
  const zone = signals.zones.nsclc;
  assert.deepEqual([zone.attention.readsRecorded, zone.attention.reads], [false, null]);
  assert.deepEqual(zone.topicRequests, { recorded: false, requests: 0, votes: 0, requestIds: [] });
});

test("reads and topic requests are counted per zone: the window, the zone's own page and its cards, a request that names the zone or shares an entity with it", options, async () => {
  // Reads: five this week on the lung zone (three of its page, two of a card), fifty long ago, one on the breast zone.
  for (let n = 0; n < 3; n += 1) await recordPageRead(fx.database, { zoneId: ids.nsclc, day: "2026-10-04" });
  for (let n = 0; n < 2; n += 1) await recordPageRead(fx.database, { zoneId: ids.nsclc, cardId: "ec_lungcard1", day: "2026-10-03" });
  await fx.database.query("INSERT INTO evimed_frontier.evidence_page_reads(zone_id, card_id, day, reads) VALUES($1, '', '2026-09-01', 50)", [ids.nsclc]);
  await recordPageRead(fx.database, { zoneId: ids["breast-cancer"], day: "2026-10-05" });
  // Requests: the lung one is found by the entity its words name, the diabetes one by naming the zone, one of two entities counts for
  // both zones, and one that concerns nothing counts for none. A second account seconds the lung request.
  const requests = createEvidenceTopicRequests({ database: fx.database, config: { evidenceTopicRequestsPerDay: 5 } });
  const a = await fx.reader([]); const b = await fx.reader([]); const c = await fx.reader([]);
  const lung = (await requests.file({ id: a }, { title: TITLES.lung })).request;
  await requests.second({ id: b }, lung.id);
  const diabetes = (await requests.file({ id: c }, { title: TITLES.diabetes, zoneId: ids["type2-diabetes"] })).request;
  const both = (await requests.file({ id: a }, { title: TITLES.both })).request;
  await requests.file({ id: b }, { title: TITLES.unrelated });
  assert.equal(diabetes.zoneId, ids["type2-diabetes"], "the zone it names is public, so the request carries it");
  wire();
  const signals = await fx.programme.gatherSignals(day);
  assert.equal(signals.readsRecorded, true);
  const nsclc = signals.zones.nsclc;
  assert.deepEqual(nsclc.attention.reads, { zonePage: 3, cardPages: 2 }, "the old reads are outside the week");
  assert.deepEqual(signals.zones["breast-cancer"].attention.reads, { zonePage: 1, cardPages: 0 });
  assert.deepEqual(signals.zones["type2-diabetes"].attention.reads, { zonePage: 0, cardPages: 0 }, "a zone nobody read is zero and is recorded as zero");
  assert.deepEqual([nsclc.topicRequests.requests, nsclc.topicRequests.votes], [2, 3], "the lung request (two accounts) and the one that also names a second entity");
  assert.deepEqual(nsclc.topicRequests.requestIds.sort(), [lung.id, both.id].sort());
  assert.deepEqual([signals.zones["type2-diabetes"].topicRequests.requests, signals.zones["type2-diabetes"].topicRequests.votes], [1, 1], "a request counts for the zone it names");
  assert.equal(signals.zones["breast-cancer"].topicRequests.requests, 0);
  assert.equal(signals.zones["af-anticoagulation"].topicRequests.requests, 1, "the request that names atrial fibrillation counts for the zone of its entity as well");
  assert.equal(fx.programme.status().counters.signals.reads >= 1 && fx.programme.status().counters.signals.requests >= 1, true);
  // What is stored is counts and ids: no title any account wrote.
  const serialised = JSON.stringify(signals);
  for (const title of Object.values(TITLES)) assert.ok(!serialised.includes(title), `the signals do not carry "${title}"`);
});

test("the selector's prompt carries the reads and the requests as numbers, never a title; the recorded decision carries them too", options, async () => {
  wire();
  const result = await fx.programme.runDay(day);
  const prompt = JSON.parse(fx.decisions.calls.at(-1).body.messages[1].content);
  assert.equal(prompt.readsRecorded, true);
  const lung = prompt.zones.find((/** @type {any} */ zone) => zone.zone === "nsclc");
  assert.equal(lung.reads, 5);
  assert.deepEqual(lung.topicRequests, { requests: 2, votes: 3 });
  assert.equal(prompt.zones.find((/** @type {any} */ zone) => zone.zone === "type2-diabetes").reads, 0);
  const instructions = fx.decisions.calls.at(-1).body.messages[0].content;
  assert.match(instructions, /topic requests/, "the selector is told what the new numbers are");
  for (const title of Object.values(TITLES)) assert.ok(!JSON.stringify(fx.decisions.calls.at(-1).body.messages).includes(title), "no request title is shown to the model");
  const recorded = result.decision.signals.zones.nsclc;
  assert.deepEqual([recorded.attention.reads, recorded.topicRequests.requests], [{ zonePage: 3, cardPages: 2 }, 2]);
  assert.equal(result.decision.signals.readsRecorded, true);
});

test("a reader that fails is counted, the day goes on without that signal, and the selector is told it is not recorded", options, async () => {
  fx.programme.useSignals({ pageReads: async () => { throw Object.assign(new Error("down"), { code: "database_unavailable" }); }, topicRequests: async () => { throw new Error("down"); } });
  const before = { ...fx.programme.status().counters.signalFailures };
  const signals = await fx.programme.gatherSignals(day);
  assert.equal(signals.readsRecorded, false);
  assert.equal(signals.topicRequestsRecorded, false);
  assert.equal(signals.zones.nsclc.attention.reads, null);
  const after = fx.programme.status().counters.signalFailures;
  assert.deepEqual([after.reads - before.reads, after.requests - before.requests], [1, 1]);
  unwire();
});

test("the operator's view: the day's decision with who chose and what became of each action, the six zones with who may write them, today's budget", options, async () => {
  wire();
  // One zone is an operator's own and not yet re-owned; the other two imported ones do not exist.
  await fx.importedZone("房颤抗凝", { owner: fx.operatorId, kind: "user" });
  const overview = await fx.programme.overview();
  assert.equal(overview.enabled, true);
  assert.equal(overview.day, day);
  const [decision] = overview.decisions;
  assert.equal(decision.day, day);
  assert.equal(decision.source, "model");
  assert.equal(decision.model, "deepseek-flash");
  assert.equal(typeof decision.costCny, "number");
  assert.equal(decision.signals.readsRecorded, true);
  assert.deepEqual([decision.signals.zones.nsclc.reads, decision.signals.zones.nsclc.topicRequests], [5, { requests: 2, votes: 3 }]);
  assert.deepEqual(Object.keys(decision.signals.zones).sort(), ["af-anticoagulation", "breast-cancer", "cardiorenal-ckd", "nsclc", "research-interpretation", "type2-diabetes"]);
  assert.equal(decision.actions.length, 1);
  const [action] = decision.actions;
  assert.deepEqual([action.zone, action.taskType, action.status, action.because, action.deferredFor], ["nsclc", "evidence-update", "scheduled", "肺癌专区被读得最多", null]);
  assert.ok(action.episodeId && action.agendaId, "the episode it started");
  assert.equal(action.outcome, null, "not settled yet");
  const byKey = Object.fromEntries(overview.zones.map((/** @type {any} */ zone) => [zone.key, zone]));
  assert.equal(overview.zones.length, 6);
  assert.deepEqual([byKey.nsclc.writable, byKey.nsclc.owner, byKey.nsclc.blockedBy], [true, "platform", null]);
  assert.deepEqual([byKey["af-anticoagulation"].writable, byKey["af-anticoagulation"].owner, byKey["af-anticoagulation"].blockedBy], [false, "other", "zone_not_publisher_owned"]);
  assert.deepEqual([byKey["cardiorenal-ckd"].zoneId, byKey["cardiorenal-ckd"].blockedBy], [null, "zone_unavailable"]);
  assert.deepEqual([overview.budget.budgetCny, overview.budget.state, overview.budget.measured], [30, "ok", true]);
  assert.equal(overview.budget.remainingCny, overview.budget.budgetCny - overview.budget.spentCny);
  assert.equal(overview.status.enabled, true);
  // Nothing in it names a reader or carries a request title.
  const serialised = JSON.stringify(overview);
  for (const title of Object.values(TITLES)) assert.ok(!serialised.includes(title));
});

test("a decision recorded before the new signal classes existed reads as not recorded, and a deferral is shown as one", options, async () => {
  const { summariseProgrammeDecision } = await import("../src/evidenceProgramme.mjs");
  const view = summariseProgrammeDecision({ id: "programme-decision-2026-09-30", payload: {
    day: "2026-09-30", source: "fallback", fallbackReason: "evidence_programme_model_unavailable", reason: "x", costCny: 0,
    signals: { zones: { nsclc: { frontier: { newItems: 4, highScoring: 1, safetyAlerts: 0, unmatched: 3 }, demand: { entities: [] }, attention: { follows: 2, readsRecorded: false }, stale: { count: 1 }, observedErrors: 0 } } },
    actions: [{ zone: "nsclc", taskType: "evidence-update", status: "deferred", reason: "zone_not_publisher_owned" }], outcomes: {},
  } });
  assert.equal(view.source, "fallback");
  assert.equal(view.signals.readsRecorded, false);
  assert.deepEqual([view.signals.zones.nsclc.reads, view.signals.zones.nsclc.topicRequests, view.signals.zones.nsclc.unreflected, view.signals.zones.nsclc.followers], [null, null, 3, 2]);
  assert.deepEqual([view.actions[0].status, view.actions[0].deferredFor, view.actions[0].because], ["deferred", "zone_not_publisher_owned", null]);
});

test("a programme that is switched off has nothing to show and reads no table", async () => {
  const { createEvidenceProgramme } = await import("../src/evidenceProgramme.mjs");
  const dead = { query: async () => { throw new Error("a table was read"); }, transaction: async () => { throw new Error("a transaction was opened"); } };
  const watch = () => new Proxy({}, { get: () => () => Promise.reject(new Error("touched")) });
  const off = createEvidenceProgramme({ config: { evidenceProgrammeEnabled: false }, database: dead, documents: watch(), jobs: watch(), autopilot: watch(), zones: watch(), budget: watch(), entityVocabulary: watch() });
  assert.deepEqual(await off.overview(), { enabled: false });
});
