// The platform's medication-question bank on the real tables (flywheel F22): the publisher's internal project, the locked set, the claims
// copied from published cards, one round per engine a month with a down engine skipped and asked again the day it answers, the errors
// grouped by entity key for the topic selector, and the per-class summary — and off, nothing at all.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { GEO_QUESTION_BANK, PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { createGeoQuestionBank, questionBankSummary } from "../src/geoQuestionBank.mjs";
import { geoMeasureState } from "../src/geoProbeQueue.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { EVIDENCE_PROJECT_ID } from "../src/internalProjects.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };

/** @type {any} */ let isolated, db, store, measure, zones;
let clock = new Date("2026-10-07T03:00:00Z");
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geobank");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  // The control plane's own migration makes the platform publisher account.
  store = new GeoStore({ database: db });
  await store.ready();
  measure = new GeoMeasureStore(db);
  await measure.ready();
  zones = new EvidenceZoneService({ database: db, platformPublisherUserId: PLATFORM_PUBLISHER_USER_ID });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  clock = new Date("2026-10-07T03:00:00Z");
  await db.query("TRUNCATE evimed_geo.projects, evimed_geo.snapshots, evimed_geo.rounds CASCADE");
  await db.query("TRUNCATE evimed_frontier.evidence_zones CASCADE");
});

const config = (/** @type {Record<string, any>} */ over = {}) => ({ geoEnabled: true, geoQuestionBankEnabled: true, geoEngines: ["deepseek", "doubao"], geoTimeZone: "Asia/Shanghai",
  publicUrl: "https://evimed.example.org", ...over });
/** The probe's view of the deployment: both engines have a channel; `down` are paused by the breaker. @param {string[]} [down] */
function deps(down = []) {
  const state = geoMeasureState();
  for (const engine of down) state.breaker.engines.set(engine, { consecutive: 9, pausedAt: Date.now(), lastCheckAt: null, failedCheckAt: null, resumedAt: null });
  return { store: measure, now: () => clock, inclusion: null, state, config: config() };
}
const bank = (/** @type {any} */ measureDeps, over = {}, vocabulary = null) => createGeoQuestionBank({ store, measureDeps, database: db, config: config(over), now: () => clock, entityVocabulary: vocabulary });

/** A published official card with one verified claim. */
async function officialCard() {
  const zone = (await zones.saveEditorial({ id: PLATFORM_PUBLISHER_USER_ID }, { title: "官方专区", description: "", background: "", kind: "official", state: "published" }, null, null, false, "programme")).zone;
  return (await zones.saveEditorial({ id: PLATFORM_PUBLISHER_USER_ID }, {
    title: "抗菌药使用要点", subtype: "knowledge", summary: "s", body: "- 抗生素不用于普通感冒", state: "published", requestId: "bank-official-card-1",
    sources: [{ title: "指南", url: "https://example.org/guideline", excerpt: "普通感冒多由病毒引起，抗菌药物无效。" }],
    claims: [{ claimId: "c1", claimType: "direct", claim: "普通感冒多由病毒引起，不需要使用抗生素。", sourceIndexes: [1], supportQuote: "普通感冒多由病毒引起，抗菌药物无效" }] }, zone.id, null, true, "programme")).evidence;
}

test("with the lever off the tick does nothing at all: no project, no table touched", options, async () => {
  const counts = await bank(deps(), { geoQuestionBankEnabled: false }).tick();
  assert.deepEqual(counts, { skipped: "disabled" });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_geo.projects")).rows[0].n, 0);
  assert.deepEqual(await bank(deps(), { geoEnabled: false }).tick(), { skipped: "disabled" }, "both switches are needed");
  assert.deepEqual(await bank(deps(), { geoQuestionBankEnabled: false }).observedErrors(), []);
});

test("the first pass makes the publisher's internal project, locks the sixty questions by class, and asks each engine once", options, async () => {
  const measureDeps = deps();
  const result = await bank(measureDeps).tick();
  assert.deepEqual([result.month, result.asked, result.skipped], ["2026-10", 2, 0]);
  const project = await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID);
  assert.ok(project);
  assert.equal(project.internal, true);
  assert.equal(project.userId, PLATFORM_PUBLISHER_USER_ID);
  const sets = await store.questionSets(project.id);
  assert.equal(sets.length, 1);
  assert.ok(sets[0].lockedAt);
  assert.equal(sets[0].measuredCount, GEO_QUESTION_BANK.length);
  const groups = (await db.query("SELECT name, count(q.id)::int AS n FROM evimed_geo.question_groups g JOIN evimed_geo.questions q ON q.group_id = g.id WHERE g.geo_project_id = $1 GROUP BY name", [project.id])).rows;
  assert.equal(groups.length, 10, "one group per drug class");
  assert.equal(groups.reduce((total, row) => total + row.n, 0), GEO_QUESTION_BANK.length);
  const rounds = (await db.query("SELECT engines, ref, kind, planned FROM evimed_geo.rounds WHERE geo_project_id = $1 ORDER BY (engines)[1]", [project.id])).rows;
  assert.deepEqual(rounds.map((row) => [row.engines[0], row.ref.questionBank, row.kind, row.planned]), [["deepseek", "2026-10", "single_step", 60], ["doubao", "2026-10", "single_step", 60]]);
  // The same day again: nothing new — the engines are asked, not asked twice.
  const again = await bank(measureDeps).tick();
  assert.deepEqual([again.asked, again.waiting], [0, 2]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_geo.rounds")).rows[0].n, 2);
  // And the questions are written once per version of the bank.
  assert.equal((await store.questionSets(project.id)).length, 1);
});

test("an engine that is down is skipped with the reason, and asked again the day it answers, three rounds a month at most", options, async () => {
  const measureDeps = deps(["doubao"]);
  const first = await bank(measureDeps).tick();
  assert.deepEqual([first.asked, first.skipped], [1, 1]);
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const marks = async () => Object.fromEntries((await db.query("SELECT key, state, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 ORDER BY key", [project.id])).rows.map((row) => [row.key, row]));
  assert.equal((await marks())["bank:2026-10:doubao"].state, "skipped");
  assert.equal((await marks())["bank:2026-10:doubao"].detail.reason, "engine_down");
  // The next day it answers again: the engine is asked, and the first is not asked again.
  clock = new Date("2026-10-08T03:00:00Z");
  measureDeps.state.breaker.engines.get("doubao").pausedAt = null;
  const next = await bank(measureDeps).tick();
  assert.deepEqual([next.asked], [1]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_geo.rounds WHERE engines = ARRAY['doubao']")).rows[0].n, 1);
  assert.equal((await marks())["bank:2026-10:doubao"].state, "running");
  // A round that ended with no answer from the engine is asked again, up to three rounds in the month.
  for (const day of [9, 10, 11]) {
    await db.query("UPDATE evimed_geo.rounds SET status = 'done', finished_at = now() WHERE status IN ('queued', 'running') AND engines = ARRAY['doubao']");
    clock = new Date(`2026-10-${String(day).padStart(2, "0")}T03:00:00Z`);
    await bank(measureDeps).tick();
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_geo.rounds WHERE engines = ARRAY['doubao']")).rows[0].n, 3, "the first and two makeups, no more");
  // A new month asks again.
  await db.query("UPDATE evimed_geo.rounds SET status = 'done', finished_at = now()");
  clock = new Date("2026-11-02T03:00:00Z");
  const november = await bank(measureDeps).tick();
  assert.equal(november.month, "2026-11");
  assert.equal(november.asked, 2, "every engine is asked again in its own new month, whatever happened to October's");
});

test("the bank's claims are the verified claims of the published official cards, each with its card and revision", options, async () => {
  const card = await officialCard();
  const measureDeps = deps();
  const bankService = bank(measureDeps);
  await bankService.tick();
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const claims = await store.listClaims(project.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].statement, "普通感冒多由病毒引起，不需要使用抗生素。");
  assert.deepEqual([claims[0].cardId, claims[0].cardClaimId, claims[0].cardRevision], [card.id, "c1", card.revision]);
  const context = await measure.projectContext(project.id);
  assert.deepEqual(context?.claims.map((claim) => [claim.cardId, claim.cardRevision]), [[card.id, card.revision]], "the judge is shown it with the card revision it will record");
  // A card taken back drops its claims from the bank.
  await db.query("UPDATE evimed_frontier.evidence_cards SET withdrawn = '{\"at\":\"2026-10-08T00:00:00Z\",\"reason\":\"撤回\"}'::jsonb WHERE id = $1", [card.id]);
  await bankService.syncClaims(project);
  assert.equal((await store.listClaims(project.id)).filter((claim) => claim.status === "active").length, 0);
});

test("a company's or a doctor's card is never what the bank holds an answer to: only official zones' claims are copied", options, async () => {
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('maker','某企业','development')");
  const maker = { id: "maker", name: "某企业" };
  const zone = (await zones.save(maker, { title: "某企业的产品专区", description: "", background: "", kind: "product" })).zone;
  await zones.save(maker, { expectedRevision: zone.revision, state: "published" }, zone.id);
  const productCard = (await zones.save(maker, {
    title: "我家产品每天吃一次最有效", subtype: "knowledge", summary: "s", body: "- 一条出品方自己的结论", state: "published", requestId: "bank-product-card-1",
    sources: [{ title: "内部资料", url: "https://example.org/internal", excerpt: "我家产品每天吃一次最有效，其他产品都不行。" }],
    claims: [{ claimId: "p1", claimType: "direct", claim: "我家产品每天吃一次最有效。", sourceIndexes: [1], supportQuote: "我家产品每天吃一次最有效" }],
    producer: { kind: "enterprise", name: "某企业", relation: "own_product" }, journeyStage: { key: "treat", label: "治疗选择" },
    disclosure: { authors: [{ name: "甲" }], reviewers: [{ name: "乙" }] } }, zone.id, null, true)).evidence;
  assert.equal(productCard.state, "published", "the card is published and its claim verifies: only its kind keeps it out");
  assert.equal(productCard.claims[0].verification.mark, "✓");
  const official = await officialCard();
  const bankService = bank(deps());
  await bankService.tick();
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const claims = await store.listClaims(project.id);
  assert.deepEqual(claims.map((claim) => claim.cardId), [official.id], "the official card's claim and nothing from the product zone");
  assert.ok(!claims.some((claim) => claim.statement.includes("我家产品")));
});

test("observedErrors is what the topic selector reads: the bank's open errors by entity key, and those no key was found for", options, async () => {
  await bank(deps()).tick();
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const [question] = (await db.query("SELECT id, text FROM evimed_geo.questions WHERE geo_project_id = $1 ORDER BY position LIMIT 1", [project.id])).rows;
  for (const [index, status] of ["open", "open", "closed"].entries()) {
    await db.query(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, statement, status, severity)
      VALUES ($1, $2, $3, $4, 'deepseek', $5, $6, $7, 'S2')`, [`err_${index}`, PLATFORM_PUBLISHER_USER_ID, project.id, `fp${index}`, question.id, `一个错误的说法 ${index}`, status]);
  }
  const vocabulary = { keysForText: async (/** @type {{ texts: string[] }} */ input) => (input.texts.some((text) => text.includes("说法 0")) ? ["drug:amoxicillin"] : []) };
  const errors = await bank(deps(), {}, vocabulary).observedErrors();
  assert.deepEqual(errors.sort((left, right) => (right.entityKeys?.length ?? 0) - (left.entityKeys?.length ?? 0)), [{ count: 1, entityKeys: ["drug:amoxicillin"] }, { count: 1 }],
    "closed errors are not counted; the two open ones group by key");
  // The exact shape the programme reads.
  for (const entry of errors) {
    assert.ok(Number.isFinite(entry.count));
    assert.ok(entry.entityKeys === undefined || (Array.isArray(entry.entityKeys) && entry.entityKeys.every((key) => typeof key === "string")));
  }
});

test("the monthly summary is per class and reads the answers' judged statements and cited pages; another month is empty, and no project is not available", options, async () => {
  const empty = await questionBankSummary(db, { month: "2026-10", publicUrl: "https://evimed.example.org" });
  assert.equal(empty.available, false);
  await bank(deps()).tick();
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const round = (await db.query("SELECT id FROM evimed_geo.rounds WHERE geo_project_id = $1 AND engines = ARRAY['deepseek']", [project.id])).rows[0];
  const questions = (await db.query("SELECT id, text FROM evimed_geo.questions WHERE geo_project_id = $1", [project.id])).rows;
  const q = questions.find((row) => row.text === "普通感冒需要吃抗生素吗？");
  await db.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text, citations)
    VALUES ('snap_b1', $1, $2, $3, $4, 'deepseek', now(), 'valid', '不需要。', $5::jsonb)`, [PLATFORM_PUBLISHER_USER_ID, round.id, project.id, q.id,
    JSON.stringify([{ url: "https://evimed.example.org/evidence/c/ec_1" }, { url: "https://other.example.com/a" }])]);
  await db.query(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, statements, judged_at) VALUES ('snap_b1', $1, $2, $3::jsonb, now())`,
    [PLATFORM_PUBLISHER_USER_ID, project.id, JSON.stringify([{ text: "不需要", verdict: "correct", topic: "indication" }, { text: "吃三天", verdict: "wrong", topic: "dosage" }])]);
  const summary = await questionBankSummary(db, { month: "2026-10", publicUrl: "https://evimed.example.org" });
  assert.equal(summary.available, true);
  const antibiotic = summary.classes.find((entry) => entry.class === "antibiotic");
  assert.deepEqual([antibiotic?.answers, antibiotic?.correct, antibiotic?.wrong, antibiotic?.rate, antibiotic?.eviMedCitedShare], [1, 1, 1, 0.5, 1]);
  assert.deepEqual(summary.coverage, { deepseek: { state: "running", rounds: 1 }, doubao: { state: "running", rounds: 1 } }, "which assistants were asked is part of the summary");
  assert.equal(summary.classes.length, 10);
  assert.equal((await questionBankSummary(db, { month: "2026-09", publicUrl: "https://evimed.example.org" })).overall.answers, 0);
  await assert.rejects(() => questionBankSummary(db, { month: "October" }), { code: "geo_question_bank_month_invalid" });
});

test("an internal project is never advanced by the orchestrator", options, async () => {
  await bank(deps()).tick();
  const { GeoOrchestrator } = await import("../src/geoOrchestrator.mjs");
  const dispatched = /** @type {any[]} */ ([]);
  const orchestrator = new GeoOrchestrator({ store, config: config(), notifier: null, dispatchRun: async (input) => { dispatched.push(input); return { runId: "r", sessionId: "s", status: "running" }; },
    runStatus: async () => null, latestSessionId: async () => null, enqueueRound: async () => ({}), noteCitation: async () => {} });
  const project = /** @type {any} */ (await store.projectByControlProject(PLATFORM_PUBLISHER_USER_ID, EVIDENCE_PROJECT_ID));
  const result = await orchestrator.advance(project.id);
  assert.deepEqual(result, { dispatched: null, deferred: null, enqueued: [] });
  const ticked = await orchestrator.tick();
  assert.equal(ticked.projects, 0, "the loop does not even list it");
  assert.deepEqual(dispatched, []);
});
