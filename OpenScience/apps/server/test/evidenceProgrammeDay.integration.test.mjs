// The platform's evidence programme, the day's half (evidence-flywheel plan §5.1, F01): the official zones exist, the topic selector
// reads five signal classes as counts and ids, one budgeted Flash decision (or its recorded fallback) chooses, and the chosen zone's
// agenda is created or continued as ordinary proactive research that is the platform's money and nobody's wallet. Real PostgreSQL;
// the model, the result store and the glossary are the only doubles (`helpers/evidenceProgrammeFixture.mjs`).
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { isChargeableResearchRun, usagePurposeOfRun } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { isInternalProjectOf } from "../src/internalProjects.mjs";
import { PRODUCT_JOB_KINDS, PRODUCT_KINDS, migrateProductStore } from "../src/productPersistence.mjs";
import { EVIDENCE_PROJECT_ID, PLATFORM_PUBLISHER_USER_ID, modelAnswer, programmeFixture } from "./helpers/evidenceProgrammeFixture.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
/** @type {any} */ let fx;
const day = "2026-10-05";
const chooses = (...actions) => async () => modelAnswer({ actions: actions.map(([zone, taskType]) => ({ zone, taskType, reason: `${zone} 有新证据` })), reason: "按计数选题" });

before(async () => {
  if (!url) return;
  fx = await programmeFixture({ url, label: "programmeday", callModel: chooses(["nsclc", "evidence-update"]) });
});
after(async () => { await fx?.close(); });

const zoneRows = async () => (await fx.database.query("SELECT id, user_id, kind, state, title FROM evimed_frontier.evidence_zones ORDER BY title")).rows;
const decisionOf = async (d = day) => (await fx.documents.get(PLATFORM_PUBLISHER_USER_ID, "programme-decision", `programme-decision-${d}`))?.payload;

test("with the switch off nothing ticks and no table is read", async () => {
  const dead = { query: async () => { throw new Error("a table was read"); }, transaction: async () => { throw new Error("a transaction was opened"); } };
  const { createEvidenceProgramme } = await import("../src/evidenceProgramme.mjs");
  const touched = [];
  const watch = (name) => new Proxy({}, { get: (_target, key) => () => { touched.push(`${name}.${String(key)}`); return Promise.reject(new Error("touched")); } });
  const off = createEvidenceProgramme({ config: { evidenceProgrammeEnabled: false }, database: dead, documents: watch("documents"), jobs: watch("jobs"), autopilot: watch("autopilot"),
    zones: watch("zones"), budget: watch("budget"), entityVocabulary: watch("vocabulary"), results: watch("results") });
  assert.equal(off.enabled, false);
  assert.equal(off.worker, null, "no worker, so no timer and no job");
  assert.equal(off.owns(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID), false, "no agenda is the programme's");
  assert.deepEqual(await off.runDay("2026-10-05"), { state: "off" });
  assert.deepEqual(await off.ensureOfficialZones(), []);
  assert.deepEqual(await off.sweep(), { settled: 0, applied: 0 });
  assert.deepEqual(await off.settleEpisode("episode-1"), { state: "off" });
  assert.equal(await off.onRunFinished({ userId: PLATFORM_PUBLISHER_USER_ID, id: EVIDENCE_PROJECT_ID }, { id: "run_1" }), null);
  await off.assertAdmitted(PLATFORM_PUBLISHER_USER_ID, { projectId: EVIDENCE_PROJECT_ID }); // admits nothing and asks nothing: it is not its agenda
  assert.deepEqual(touched, []);
});

test("the official zones exist: the four the programme adds are made once as the publisher, and the three an operator imported are recognised and left alone", options, async () => {
  // Nothing imported yet: the programme makes its four and never makes the operator's.
  const first = await fx.programme.ensureOfficialZones();
  const made = first.filter((zone) => zone.id);
  assert.deepEqual(made.map((zone) => zone.key).sort(), ["breast-cancer", "hot-questions", "nsclc", "type2-diabetes"]);
  assert.deepEqual(first.filter((zone) => !zone.id).map((zone) => zone.key).sort(), ["af-anticoagulation", "cardiorenal-ckd", "research-interpretation"], "an import is the operator's act");
  const rows = await zoneRows();
  assert.deepEqual(rows.map((row) => row.title), ["2 型糖尿病", "乳腺癌", "热点求证", "非小细胞肺癌"]);
  assert.ok(rows.every((row) => row.kind === "official" && row.user_id === PLATFORM_PUBLISHER_USER_ID && row.state === "published"), "official, the publisher's, published");
  const hot = (await fx.database.query("SELECT description, background FROM evimed_frontier.evidence_zones WHERE title = '热点求证'")).rows[0];
  assert.match(hot.description, /原始研究、指南和官方统计/, "made with its own text");
  // A second run makes nothing.
  const again = await fx.programme.ensureOfficialZones();
  assert.deepEqual(again.map((zone) => zone.id), first.map((zone) => zone.id));
  assert.equal((await zoneRows()).length, 4, "idempotent");
  // The operator imports 房颤抗凝 (still owned by them, not yet re-owned) and 研究解读 (re-owned and marked official).
  const imported = await fx.importedZone("房颤抗凝", { owner: fx.operatorId, kind: "user" });
  const reowned = await fx.importedZone("研究解读");
  const found = await fx.programme.ensureOfficialZones();
  assert.equal((await zoneRows()).length, 6, "recognised, never duplicated: still the four of the programme and the two imported");
  const af = found.find((zone) => zone.key === "af-anticoagulation");
  assert.deepEqual([af.id, af.writable, af.ownerId], [imported, false, fx.operatorId], "an operator's zone is recognised and is not the programme's to write until it is re-owned");
  const interpretation = found.find((zone) => zone.key === "research-interpretation");
  assert.deepEqual([interpretation.id, interpretation.writable], [reowned, true]);
  await fx.database.query("UPDATE evimed_frontier.evidence_zones SET user_id=$2, kind='official' WHERE id=$1", [imported, PLATFORM_PUBLISHER_USER_ID]);
  assert.equal((await fx.programme.ensureOfficialZones()).find((zone) => zone.key === "af-anticoagulation").writable, true, "re-owned, it is writable");
});

test("the selector counts an entity from five distinct readers and stores no reader", options, async () => {
  const phrase = (text, source = "question") => ({ text, source, memoryId: "", kind: "question" });
  const ids = [];
  for (let n = 0; n < 5; n += 1) ids.push(await fx.reader([phrase("apixaban 在房颤合并肾功能不全时怎么用")]));
  for (let n = 0; n < 4; n += 1) ids.push(await fx.reader([phrase("奥希替尼耐药后的下一步 osimertinib")]));
  // Five more readers whose only mention is an item the feed itself showed them: that is not demand.
  for (let n = 0; n < 5; n += 1) ids.push(await fx.reader([phrase("semaglutide 与肾脏结局", "frontier-item")]));
  const signals = await fx.programme.gatherSignals(day);
  const af = signals.zones["af-anticoagulation"].demand;
  assert.ok(af.entities.some((entry) => entry.key === "drug:apixaban" && entry.users === 5), "five readers is enough to count");
  const lung = signals.zones.nsclc.demand;
  assert.deepEqual(lung.entities, [], "four readers is one too few: the entity is not shown at all");
  assert.equal(lung.users, 0);
  assert.deepEqual(signals.zones["type2-diabetes"].demand.entities, [], "what the feed itself showed a reader is not what they asked");
  assert.equal(signals.minDemandUsers, 5);
  assert.ok(signals.profilesRead >= 14);
  const serialised = JSON.stringify(signals);
  for (const id of ids) assert.ok(!serialised.includes(id), "no reader is named in what the selector reads");
  assert.ok(!/奥希替尼|房颤合并/.test(serialised), "no text a reader wrote is in what the selector reads");
});

test("the selector reads entity keys and never a reader's words: the query selects no text, and a profile built before keys were stored is counted, not guessed at", options, async () => {
  await fx.database.query("DELETE FROM evimed_frontier.user_profiles");
  // Six readers who asked about apixaban, with the keys the profile builder stored; five more built before keys were stored.
  for (let n = 0; n < 6; n += 1) await fx.reader([{ text: "apixaban 在房颤合并肾功能不全时怎么用", source: "question", memoryId: "", kind: "question" }]);
  for (let n = 0; n < 5; n += 1) await fx.reader([{ text: "apixaban 的剂量调整", source: "question", memoryId: "", kind: "question" }], { tagged: false });
  const queries = [];
  const database = fx.database;
  const original = database.query.bind(database);
  database.query = (/** @type {any} */ sql, /** @type {any} */ ...rest) => { queries.push(String(sql)); return original(sql, ...rest); };
  let signals;
  try { signals = await fx.programme.gatherSignals(day); } finally { database.query = original; }
  const profileQueries = queries.filter((sql) => sql.includes("user_profiles"));
  assert.equal(profileQueries.length, 1, "the readers are read once");
  assert.doesNotMatch(profileQueries[0], /'text'|->>\s*'text'|\btext\b/i, "no text column of a phrase is in the query");
  assert.match(profileQueries[0], /'source'/);
  assert.match(profileQueries[0], /'entityKeys'/);
  const af = signals.zones["af-anticoagulation"].demand;
  assert.deepEqual(af.entities.filter((entry) => entry.key === "drug:apixaban").map((entry) => entry.users), [6], "the five without keys are not counted: nobody's words are tagged here");
  assert.equal(fx.programme.status().counters.demandProfilesWithoutKeys, 5, "and they are counted, until their next refresh");
});

test("the five signal classes are counts and ids: the feed, the readers, the follows, the stale cards, the observed errors", options, async () => {
  const keys = ["disease:atrial fibrillation", "drug:apixaban"];
  const covered = await fx.feedItem({ title: "Trial A", doi: "10.1056/covered", entityKeys: keys, score: 70 });
  await fx.feedItem({ title: "Trial B", doi: "10.1056/new-one", entityKeys: keys, score: 91 });
  await fx.feedItem({ title: "Safety notice", entityKeys: ["drug:apixaban"], score: 60, safetyAlert: true });
  await fx.feedItem({ title: "Old item", entityKeys: keys, timelineAt: "2026-09-01T00:00:00Z" });
  await fx.feedItem({ title: "Unrelated", entityKeys: ["drug:osimertinib"] });
  const zone = (await zoneRows()).find((row) => row.title === "房颤抗凝");
  // A card of the zone already cites Trial A by its DOI, and its sources were last checked long ago.
  await fx.database.query(`INSERT INTO evimed_frontier.evidence_cards(id, zone_id, user_id, title, subtype, state, sources, disclosure, provenance)
    VALUES('ec_signalcard1', $1, $2, 'Old card', 'academic', 'published', $3::jsonb, $4::jsonb, 'x')`,
  [zone.id, PLATFORM_PUBLISHER_USER_ID, JSON.stringify([{ title: "A", url: "https://doi.org/10.1056/covered", excerpt: "x" }]), JSON.stringify({ lastCheckedAt: "2026-07-01T00:00:00.000Z" })]);
  await fx.database.query("INSERT INTO evimed_frontier.evidence_zone_follows(zone_id, user_id) SELECT $1, id FROM evimed_control.users WHERE id LIKE 'reader-%' LIMIT 3", [zone.id]);
  fx.programme.useSignals({ staleOfficialCards: async () => [{ zoneId: zone.id, cardId: "ec_pending_currency" }], observedErrors: async () => [{ zoneKey: "af-anticoagulation", count: 4 }, { entityKeys: ["drug:osimertinib"], count: 9 }] });
  const signals = await fx.programme.gatherSignals(day);
  const af = signals.zones["af-anticoagulation"];
  assert.equal(af.frontier.newItems, 3, "the window is a week: the old item is out, the unrelated one never matched");
  assert.equal(af.frontier.highScoring, 1, "only Trial B reaches the feed's own threshold");
  assert.equal(af.frontier.safetyAlerts, 1);
  assert.equal(af.frontier.unmatched, 2, "Trial A is already a source of a card of the zone; the other two are in no card yet");
  assert.equal(af.frontier.itemIds.length, 3);
  assert.ok(af.frontier.itemIds.every((id) => /^[a-z0-9]{12,32}$/.test(id)), "ids, not titles");
  assert.equal(af.attention.follows, 3);
  assert.equal(af.attention.readsRecorded, false, "reads are not recorded anywhere yet, and the signal says so");
  assert.deepEqual(af.stale.cardIds.sort(), ["ec_pending_currency", "ec_signalcard1"], "the card whose sources were checked long ago, and the one the upkeep's own view names");
  assert.equal(af.observedErrors, 4);
  assert.equal(signals.zones.nsclc.observedErrors, 9, "an observed error is joined to a zone by entity too");
  assert.equal(covered.publicId.length > 0, true);
  fx.programme.useSignals({ staleOfficialCards: null, observedErrors: null });
});

test("the daily decision is one Flash call under purpose `evidence`, held to a closed schema, and recorded with its counts and its cost", options, async () => {
  const { programme } = fx;
  const result = await programme.runDay(day);
  assert.equal(result.state, "decided");
  const call = fx.decisions.calls.at(-1);
  assert.equal(call.purpose, "evidence", "the platform's own money, never a researcher's");
  assert.equal(call.userId, PLATFORM_PUBLISHER_USER_ID);
  assert.equal(call.projectId, EVIDENCE_PROJECT_ID);
  assert.equal(call.body.model, "deepseek-flash");
  assert.equal(call.body.response_format.type, "json_object");
  const input = JSON.parse(call.body.messages[1].content);
  assert.equal(input.zones.length, 6);
  assert.ok(!JSON.stringify(input).includes("reader-"), "the model reads counts, never a reader");
  const recorded = await decisionOf();
  assert.equal(recorded.source, "model");
  assert.equal(recorded.model, "deepseek-flash");
  assert.deepEqual(recorded.actions.map((action) => [action.zone, action.taskType]), [["nsclc", "evidence-update"]]);
  assert.equal(typeof recorded.costCny, "number", "its cost is on the record");
  assert.ok(recorded.signals.zones["af-anticoagulation"].frontier.newItems >= 0 && recorded.signals.zones.nsclc.demand, "and the counts it was read from");
  assert.equal(recorded.budget.maxActions, 3);
  assert.ok(!JSON.stringify(recorded).match(/reader-[0-9a-f]{12}/), "nothing stored names a reader");
  // The same day again decides nothing twice.
  const callsBefore = fx.decisions.calls.length;
  await programme.runDay(day);
  assert.equal(fx.decisions.calls.length, callsBefore);
});

test("the chosen zone's agenda is ordinary proactive research in the internal project, capped by the programme's budget and never started by the calendar", options, async () => {
  const recorded = await decisionOf();
  const [action] = recorded.actions;
  assert.equal(action.status, "scheduled");
  const agenda = await fx.autopilot.get(PLATFORM_PUBLISHER_USER_ID, action.agendaId);
  assert.equal(agenda.projectId, EVIDENCE_PROJECT_ID, "in the internal project of the publisher account");
  assert.equal(agenda.payload.programme.zoneKey, "nsclc");
  assert.deepEqual([agenda.payload.dailyBudgetCny, agenda.payload.weeklyBudgetCny, agenda.payload.maxEpisodeCny], [30, 210, 10], "the caps come from the programme's budget, not AGENDA_DEFAULT_BUDGETS (100 / 500 / 3000)");
  assert.deepEqual(agenda.payload.taskTypes, ["evidence-update"]);
  assert.equal(agenda.payload.enabled, true);
  assert.equal(agenda.payload.schedule.kind, "once");
  assert.equal(agenda.payload.schedule.date, "2099-12-31", "its only occurrence is a date that never comes");
  assert.equal(await fx.autopilot.scheduleDue(PLATFORM_PUBLISHER_USER_ID, agenda.id), null, "the timer never starts it");
  const episode = await fx.autopilot.getEpisode(PLATFORM_PUBLISHER_USER_ID, action.episodeId);
  assert.equal(episode.payload.trigger, "manual");
  assert.equal(episode.payload.status, "queued");
  assert.equal(episode.projectId, EVIDENCE_PROJECT_ID);
  assert.equal(isInternalProjectOf({ operatorUsers: [] }, PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID), true, "so it waits for room and never takes a researcher's slot");
  const jobs = (await fx.database.query("SELECT kind, status, project_id FROM evimed_product.jobs WHERE user_id=$1 AND kind='episode'", [PLATFORM_PUBLISHER_USER_ID])).rows;
  assert.deepEqual(jobs, [{ kind: "episode", status: "queued", project_id: EVIDENCE_PROJECT_ID }], "one episode, dispatched like any other");
  // The planner's own decision for this agenda is booked as `evidence`, a researcher's agenda as `autopilot`.
  const plannerCall = fx.plannerCalls.at(-1).call;
  assert.equal(plannerCall.purpose, "evidence");
  assert.equal(plannerCall.userId, PLATFORM_PUBLISHER_USER_ID);
});

test("a researcher's agenda keeps purpose `autopilot` through the same service", options, async () => {
  const created = await fx.autopilot.create(fx.researcherId, { projectId: "default", title: "My question", prompt: "Look at apixaban", taskTypes: ["literature-sentinel"],
    schedule: { kind: "daily", timeZone: "UTC", time: "07:00" }, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 });
  const started = await fx.autopilot.start(fx.researcherId, created.id, { expectedRevision: created.revision });
  const scheduled = await fx.autopilot.runNow(fx.researcherId, started.id, { requestId: "mine-0001" });
  assert.ok(scheduled.episode);
  const call = fx.plannerCalls.at(-1).call;
  assert.equal(call.purpose, "autopilot");
  assert.equal(call.userId, fx.researcherId);
});

test("a run of the platform's own agenda resolves to purpose `evidence` and is never chargeable; a researcher's autopilot run is neither", () => {
  const programmeRun = { effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: "autopilot:evidence:evidence-update" };
  assert.equal(usagePurposeOfRun(programmeRun), "evidence");
  assert.equal(isChargeableResearchRun(programmeRun), false, "nobody pays for the platform's own research");
  const verification = { effectiveAgentId: "open-domain-answer", effectiveRouteReason: "autopilot-verify:evidence" };
  assert.equal(usagePurposeOfRun(verification), "evidence");
  assert.equal(isChargeableResearchRun(verification), false);
  const mine = { effectiveAgentId: "clinical-evidence-synthesis", effectiveRouteReason: "autopilot:evidence-update" };
  assert.equal(usagePurposeOfRun(mine), "kernel", "the researcher's own agenda is still the kernel's, as before");
  assert.equal(isChargeableResearchRun(mine), true);
  assert.equal(usagePurposeOfRun({ effectiveRouteReason: "autopilot-verify" }), "kernel");
});

test("a model that cannot decide, or decides outside the closed schema, takes the recorded fallback: the zone with the most unmatched new evidence", options, async () => {
  const cases = [
    ["a model failure", async () => { throw Object.assign(new Error("down"), { code: "model_gateway_upstream_unavailable" }); }, "model_gateway_upstream_unavailable"],
    ["a zone the programme does not know", chooses(["oncology", "evidence-update"]), "evidence_programme_decision_invalid"],
    ["a task type the zone does not allow", chooses(["research-interpretation", "signal-monitoring"]), "evidence_programme_decision_invalid"],
    ["more actions than the budget buys", chooses(["nsclc", "evidence-update"], ["breast-cancer", "evidence-update"], ["type2-diabetes", "evidence-update"], ["af-anticoagulation", "evidence-update"]), "evidence_programme_decision_invalid"],
    ["words that are not JSON", async () => modelAnswer("先看房颤抗凝"), "evidence_programme_decision_invalid"],
  ];
  for (const [index, [what, model, code]] of cases.entries()) {
    const sub = await programmeFixture({ url, label: `fallback${index}`, callModel: model });
    try {
      await sub.programme.ensureOfficialZones();
      await sub.importedZone("房颤抗凝");
      await sub.feedItem({ title: "A", doi: "10.1/a", entityKeys: ["disease:atrial fibrillation"] });
      await sub.feedItem({ title: "B", doi: "10.1/b", entityKeys: ["drug:apixaban"] });
      await sub.feedItem({ title: "C", doi: "10.1/c", entityKeys: ["disease:breast cancer"] });
      const result = await sub.programme.runDay(day);
      const decision = result.decision;
      assert.equal(decision.source, "fallback", what);
      assert.equal(decision.fallbackReason, code, what);
      assert.deepEqual(decision.actions.map((action) => [action.zone, action.taskType]), [["af-anticoagulation", "evidence-update"]], `${what}: the zone with two unmatched items beats the one with one`);
      assert.equal(sub.programme.status().counters.decisions.fallback, 1, what);
    } finally { await sub.close(); }
  }
});

test("a day with nothing new and a model that chooses nothing records no action", options, async () => {
  const sub = await programmeFixture({ url, label: "nothing", callModel: async () => modelAnswer({ actions: [], reason: "没有变化" }) });
  try {
    const result = await sub.programme.runDay(day);
    assert.equal(result.decision.source, "none");
    assert.deepEqual(result.decision.actions, []);
    const down = await programmeFixture({ url, label: "nothingdown" });
    try { assert.deepEqual((await down.programme.runDay(day)).decision.actions, [], "and with no model and no new evidence, the fallback has nothing to choose either"); }
    finally { await down.close(); }
  } finally { await sub.close(); }
});

test("a spent day makes no decision and spends nothing; a day that is spent between decision and episode defers the episode by a recorded deferral", options, async () => {
  const spentDay = await programmeFixture({ url, label: "spent", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    await spentDay.spend(30);
    const none = (await spentDay.programme.runDay(day)).decision;
    assert.equal(none.source, "none");
    assert.equal(none.reason, "budget");
    assert.equal(spentDay.decisions.calls.length, 0, "no model call is made on a spent day");
    assert.equal((await spentDay.database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE kind='episode'")).rows[0].n, 0);
  } finally { await spentDay.close(); }

  // The model's own answer arrives after another 26 yuan were booked: the budget is checked again before the episode.
  const racing = await programmeFixture({ url, label: "racing", callModel: async (_deps, call) => { await racing.spend(26); return chooses(["nsclc", "evidence-update"])(_deps, call); } });
  try {
    const result = await racing.programme.runDay(day);
    const [action] = result.decision.actions;
    assert.equal(action.status, "deferred");
    assert.equal(action.reason, "budget");
    assert.equal(action.code, "evidence_programme_budget_spent");
    assert.equal((await racing.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='episode'")).rows[0].n, 0, "no episode was made");
    assert.equal((await racing.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='agenda'")).rows[0].n, 0, "and the zone's agenda was not touched for a day that could not pay for it");
    assert.equal(racing.programme.status().counters.admissions.budget, 1);
    assert.equal(racing.programme.status().counters.actions.budget, 1, "and the deferral has its own counter");
    // The budget comes back (a new day): the deferred action is applied by the sweep, and the episode exists.
    racing.clock.at = new Date("2026-10-05T01:00:00.000Z");
    await racing.database.query("UPDATE evimed_usage.model_requests SET created_at = created_at - interval '2 days'");
    const swept = await racing.programme.sweep();
    assert.equal(swept.applied, 1);
    const later = (await racing.documents.get(PLATFORM_PUBLISHER_USER_ID, "programme-decision", `programme-decision-${day}`)).payload.actions[0];
    assert.equal(later.status, "scheduled", "deferred, not dropped");
  } finally { await racing.close(); }
});

test("the programme works one thing at a time: a second zone waits for the first, and goes when it is over", options, async () => {
  const two = await programmeFixture({ url, label: "slot", callModel: chooses(["nsclc", "evidence-update"], ["breast-cancer", "literature-sentinel"]) });
  try {
    const result = await two.programme.runDay(day);
    const [first, second] = result.decision.actions;
    assert.equal(first.status, "scheduled");
    assert.equal(second.status, "deferred");
    assert.equal(second.reason, "concurrency");
    assert.equal(second.code, "evidence_programme_slot_busy");
    assert.equal((await two.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='episode'")).rows[0].n, 1);
    // The first episode ends; the next look at the day schedules the second.
    await two.autopilot.markEpisodeCanceled(PLATFORM_PUBLISHER_USER_ID, first.episodeId);
    await two.programme.sweep();
    const after = (await two.documents.get(PLATFORM_PUBLISHER_USER_ID, "programme-decision", `programme-decision-${day}`)).payload.actions[1];
    assert.equal(after.status, "scheduled");
    const agenda = await two.autopilot.get(PLATFORM_PUBLISHER_USER_ID, after.agendaId);
    assert.deepEqual(agenda.payload.taskTypes, ["literature-sentinel"], "the task type is the selector's choice");
  } finally { await two.close(); }
});

test("an operator's zone is not choosable, and a zone that stops being the publisher's before its episode is deferred with its reason while the day goes on", options, async () => {
  const refused = await programmeFixture({ url, label: "foreign", callModel: chooses(["af-anticoagulation", "evidence-update"]) });
  try {
    await refused.importedZone("房颤抗凝", { owner: refused.operatorId, kind: "user" });
    const result = await refused.programme.runDay(day);
    const input = JSON.parse(refused.decisions.calls[0].body.messages[1].content).zones.find((zone) => zone.zone === "af-anticoagulation");
    assert.equal(input.choosable, false, "the model is told it cannot be chosen");
    assert.equal(result.decision.source, "none", "and an answer that chooses it is refused by the closed schema, with nothing to fall back to");
    assert.equal(result.decision.fallbackReason, "evidence_programme_decision_invalid");
  } finally { await refused.close(); }

  const moved = await programmeFixture({ url, label: "moved", callModel: async (deps, call) => {
    // Between the decision and the episode an operator takes the zone back.
    await moved.database.query("UPDATE evimed_frontier.evidence_zones SET user_id=$1, kind='user' WHERE title='非小细胞肺癌'", [moved.operatorId]);
    return chooses(["nsclc", "evidence-update"])(deps, call);
  } });
  try {
    const result = await moved.programme.runDay(day);
    assert.equal(result.decision.actions[0].status, "deferred");
    assert.equal(result.decision.actions[0].reason, "zone_not_publisher_owned");
    assert.equal((await moved.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='agenda'")).rows[0].n, 0, "no agenda for a zone the programme cannot write");
    const swept = await moved.programme.sweep();
    assert.equal(swept.applied, 0, "a final reason is not asked again");
  } finally { await moved.close(); }
});

test("the programme's document kind and job kind are added to a database that predates them, and the migration runs cleanly twice", options, async () => {
  const sub = await programmeFixture({ url, label: "migrate", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    await migrateProductStore(sub.database);
    // A release-5 database: both CHECK constraints as they were before the programme's kinds existed, with rows in them.
    const without = (kinds, drop) => kinds.filter((kind) => kind !== drop).map((kind) => `'${kind}'`).join(",");
    await sub.database.query(`ALTER TABLE evimed_product.documents DROP CONSTRAINT product_documents_kind_check;
      ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check CHECK (kind IN (${without(PRODUCT_KINDS, "programme-decision")}));
      ALTER TABLE evimed_product.jobs DROP CONSTRAINT product_jobs_kind_check;
      ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check CHECK (kind IN (${without(PRODUCT_JOB_KINDS, "evidence-programme")}))`);
    await assert.rejects(sub.database.query(`INSERT INTO evimed_product.documents(user_id, kind, id, payload) VALUES($1, 'programme-decision', 'x', '{}'::jsonb)`, [PLATFORM_PUBLISHER_USER_ID]),
      (error) => error.code === "23514", "refused by the old constraint, before the migration");
    for (let pass = 0; pass < 2; pass += 1) {
      const fresh = new ControlPlaneDatabase({ databaseUrl: sub.databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
      try { await migrateProductStore(fresh); } finally { await fresh.close(); }
    }
    const constraints = (await sub.database.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('product_documents_kind_check','product_jobs_kind_check')`)).rows;
    assert.equal(constraints.length, 2);
    assert.ok(constraints.find((row) => row.conname === "product_documents_kind_check").def.includes("programme-decision"));
    assert.ok(constraints.find((row) => row.conname === "product_jobs_kind_check").def.includes("evidence-programme"));
    // And a day can be decided, and its job enqueued, on the migrated tables.
    assert.equal((await sub.programme.runDay(day)).state, "decided");
    await sub.jobs.enqueue(PLATFORM_PUBLISHER_USER_ID, "evidence-programme", { day }, { idempotencyKey: `evidence-programme:${day}`, projectId: EVIDENCE_PROJECT_ID });
  } finally { await sub.close(); }
});

// ── The day's hot topic (前沿动态 round 2, 2026-10-25): taken in code before the model's choice, in its own agenda ──────────────────

const hotZoneId = async (sub) => (await sub.database.query("SELECT id FROM evimed_frontier.evidence_zones WHERE title = '热点求证'")).rows[0]?.id ?? null;

test("a qualifying hot topic takes the day's first action in 「热点求证」 before the model's choice, runs in its own agenda with the topic's question, and is taken", options, async () => {
  const sub = await programmeFixture({ url, label: "topicone", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    const id = await sub.topic({ boards: [{ board: "weibo", peakRank: 3 }, { board: "baidu", peakRank: 8 }] });
    const decision = (await sub.programme.runDay(day)).decision;
    assert.deepEqual(decision.actions.map((action) => [action.zone, action.taskType, action.topicId ?? null]), [["hot-questions", "evidence-update", id], ["nsclc", "evidence-update", null]],
      "the topic first, the model's choice after it");
    assert.deepEqual(decision.topicPick, { state: "picked", candidates: 1, topicId: id, surge: false, boards: 2, bestRank: 3 });
    assert.match(decision.actions[0].reason, /2 个热榜，最高第 3 位/);
    const input = JSON.parse(sub.decisions.calls[0].body.messages[1].content);
    assert.equal(input.maxActions, 2, "the model is given what the topic left of the day's three");
    assert.equal(input.budget.maxActions, 2);
    assert.equal(input.zones.length, 6, "the zone that answers topics is never the model's to choose");
    assert.ok(!input.zones.some((zone) => zone.zone === "hot-questions"));
    assert.equal(decision.budget.maxActions, 3, "the day's own cap is recorded as it was");
    const [topicAction, zoneAction] = decision.actions;
    assert.deepEqual([topicAction.status, topicAction.topicState], ["scheduled", "taken"]);
    assert.deepEqual([zoneAction.status, zoneAction.reason], ["deferred", "concurrency"], "the programme's one slot went to the timely question");
    const row = await sub.topicRow(id);
    assert.deepEqual([row.programme_state, row.programme_card_id, row.programme_at.toISOString()], ["taken", null, sub.clock.at.toISOString()]);
    // Its own agenda: the topic's question in its brief, the event as context with the rules, no zone's standing question.
    const agenda = await sub.autopilot.get(PLATFORM_PUBLISHER_USER_ID, topicAction.agendaId);
    assert.deepEqual(agenda.payload.programme, { zoneKey: "hot-questions", topicId: id, zoneId: await hotZoneId(sub) });
    assert.equal(agenda.payload.title, "证据中心 · 热点求证 · 年轻人心源性猝死的风险有多大？");
    assert.deepEqual(agenda.payload.taskTypes, ["evidence-update"]);
    const episode = await sub.autopilot.getEpisode(PLATFORM_PUBLISHER_USER_ID, topicAction.episodeId);
    const prompt = episode.payload.prompt;
    assert.match(prompt, /Today's question, raised by a public event: 年轻人发生心源性猝死的风险有多大，哪些人风险更高，出现什么征兆应及时就医？/);
    assert.match(prompt, /The event, as reported \(新华社, 2026-10-04\): 据新华社报道，一位知名人士因心源性猝死去世。 This is context only/);
    assert.match(prompt, /Never state, guess or discuss the diagnosis, the cause, a prior condition or the treatment of any person the event concerns/);
    assert.match(prompt, /absolute risks/);
    assert.match(prompt, /who is at higher risk/);
    assert.doesNotMatch(prompt, /Standing question:/, "the episode's question is the topic's, not the zone's standing one");
    for (const document of [decision, agenda.payload, episode.payload]) assert.ok(!JSON.stringify(document).includes("张某某"), "a subject name is written into no document");
    // The same day again: the recorded decision is applied, not made again; the topic does not move.
    await sub.programme.runDay(day);
    assert.equal((await sub.topicRow(id)).programme_at.toISOString(), row.programme_at.toISOString());
    assert.equal((await sub.database.query("SELECT count(*)::int AS n FROM evimed_product.documents WHERE kind='episode' AND payload->>'agendaId' = $1", [topicAction.agendaId])).rows[0].n, 1);
    assert.equal(sub.programme.status().counters.topics.picks.picked, 1);
    assert.equal(sub.programme.status().counters.topics.states.taken, 1);
  } finally { await sub.close(); }
});

test("with no qualifying topic the day is the model's as before: a topic already taken, past a day, closed or not yet accepted is never picked, and one queued a day ago is let go", options, async () => {
  const sub = await programmeFixture({ url, label: "topicnone", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    const taken = await sub.topic({ programmeState: "taken", programmeAt: "2026-10-05T00:00:00.000Z", surge: true });
    const old = await sub.topic({ hoursAgo: 25, surge: true });
    const closed = await sub.topic({ status: "closed", surge: true });
    const future = await sub.topic({ hoursAgo: -2, surge: true });
    const stale = await sub.topic({ hoursAgo: 23, programmeState: "queued", programmeAt: "2026-10-04T00:30:00.000Z" });
    const decision = (await sub.programme.runDay(day)).decision;
    assert.deepEqual(decision.actions.map((action) => action.zone), ["nsclc"]);
    assert.deepEqual(decision.topicPick, { state: "none", candidates: 0 });
    assert.equal(JSON.parse(sub.decisions.calls[0].body.messages[1].content).maxActions, 3, "the model has the whole day");
    for (const id of [old, closed, future]) assert.equal((await sub.topicRow(id)).programme_state, null, "a topic not picked stays as it was");
    assert.equal((await sub.topicRow(taken)).programme_state, "taken");
    assert.equal((await sub.topicRow(stale)).programme_state, "skipped", "queued more than a day ago and never started: let go");
    assert.equal(sub.programme.status().counters.topics.states.expired, 1);
    assert.equal(sub.programme.status().counters.topics.picks.none, 1);
  } finally { await sub.close(); }
});

test("of two qualifying topics the stronger is taken and the other stays untouched", options, async () => {
  const sub = await programmeFixture({ url, label: "topictwo", callModel: async () => modelAnswer({ actions: [], reason: "没有变化" }) });
  try {
    const wide = await sub.topic({ title: "高温天气如何预防中暑？", boards: [{ board: "weibo", peakRank: 2 }, { board: "baidu", peakRank: 1 }, { board: "toutiao", peakRank: 4 }] });
    const surge = await sub.topic({ title: "地震后挤压伤怎么救？", surge: true, boards: [{ board: "weibo", peakRank: 9 }], hoursAgo: 1 });
    const decision = (await sub.programme.runDay(day)).decision;
    assert.deepEqual(decision.actions.map((action) => action.topicId), [surge], "a surge first, before the topic on more boards");
    assert.equal(decision.topicPick.candidates, 2);
    assert.equal(decision.source, "none", "the model chose nothing for the zones");
    assert.equal((await sub.topicRow(surge)).programme_state, "taken");
    assert.equal((await sub.topicRow(wide)).programme_state, null, "not picked because another was stronger: still null, for a later day if it is still within its window");
  } finally { await sub.close(); }
});

test("a spent day takes no topic; a day that buys one action gives it to the topic and asks no model", options, async () => {
  const spent = await programmeFixture({ url, label: "topicspent", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    const id = await spent.topic({ surge: true });
    await spent.spend(30);
    const decision = (await spent.programme.runDay(day)).decision;
    assert.deepEqual([decision.source, decision.reason, decision.actions.length], ["none", "budget", 0]);
    assert.equal(decision.topicPick, undefined, "a day that cannot pay looks at no topic");
    assert.equal((await spent.topicRow(id)).programme_state, null, "and the topic waits for a day that can");
    assert.equal(spent.decisions.calls.length, 0);
  } finally { await spent.close(); }

  const one = await programmeFixture({ url, label: "topiconeaction", callModel: chooses(["nsclc", "evidence-update"]) });
  try {
    const id = await one.topic();
    await one.spend(20); // ¥10 left: one episode's estimate (¥7), not two
    const decision = (await one.programme.runDay(day)).decision;
    assert.equal(decision.budget.maxActions, 1);
    assert.equal(decision.source, "topic", "the topic took the day's only action");
    assert.deepEqual(decision.actions.map((action) => [action.zone, action.status]), [["hot-questions", "scheduled"]]);
    assert.equal(one.decisions.calls.length, 0, "no model call for a day with nothing left to choose");
    assert.equal((await one.topicRow(id)).programme_state, "taken");
    assert.equal(one.programme.status().counters.decisions.topic, 1);
  } finally { await one.close(); }
});

test("a topic's action waits for the programme's slot like any other: queued while it waits, taken when the slot frees", options, async () => {
  const sub = await programmeFixture({ url, label: "topicslot", callModel: async () => modelAnswer({ actions: [], reason: "没有变化" }) });
  try {
    // Another of the programme's episodes still holds the slot.
    const holder = await sub.autopilot.create(PLATFORM_PUBLISHER_USER_ID, { projectId: EVIDENCE_PROJECT_ID, title: "占位", prompt: "hold the slot", taskTypes: ["evidence-update"],
      schedule: { kind: "once", timeZone: "Asia/Shanghai", time: "00:00", date: "2099-12-31" }, dailyBudgetCny: 30, weeklyBudgetCny: 210, maxEpisodeCny: 10 });
    const started = await sub.autopilot.start(PLATFORM_PUBLISHER_USER_ID, holder.id, { expectedRevision: holder.revision });
    const held = await sub.autopilot.runNow(PLATFORM_PUBLISHER_USER_ID, started.id, { requestId: "slot-holder-0001" });
    const id = await sub.topic();
    const decision = (await sub.programme.runDay(day)).decision;
    const [action] = decision.actions;
    assert.deepEqual([action.zone, action.status, action.reason, action.topicState], ["hot-questions", "deferred", "concurrency", "queued"]);
    assert.equal((await sub.topicRow(id)).programme_state, "queued");
    await sub.autopilot.markEpisodeCanceled(PLATFORM_PUBLISHER_USER_ID, held.episode.id);
    await sub.programme.sweep();
    const later = (await sub.documents.get(PLATFORM_PUBLISHER_USER_ID, "programme-decision", `programme-decision-${day}`)).payload.actions[0];
    assert.deepEqual([later.status, later.topicState], ["scheduled", "taken"]);
    assert.equal((await sub.topicRow(id)).programme_state, "taken");
  } finally { await sub.close(); }
});

test("when 「热点求证」 cannot be written no topic is taken, and every topic stays as it was", options, async () => {
  const sub = await programmeFixture({ url, label: "topiczone", callModel: async () => modelAnswer({ actions: [], reason: "没有变化" }) });
  try {
    await sub.programme.ensureOfficialZones();
    await sub.database.query("UPDATE evimed_frontier.evidence_zones SET user_id=$1, kind='user' WHERE title='热点求证'", [sub.operatorId]);
    const id = await sub.topic({ surge: true });
    const decision = (await sub.programme.runDay(day)).decision;
    assert.deepEqual(decision.actions, []);
    assert.deepEqual(decision.topicPick, { state: "zone_not_publisher_owned", candidates: 1 });
    assert.equal((await sub.topicRow(id)).programme_state, null);
  } finally { await sub.close(); }
});
