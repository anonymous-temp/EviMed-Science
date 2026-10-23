import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { GeoService, geoCellFromRow } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { measureRound } from "../src/geoMetricsJob.mjs";
import { migrateGeo } from "../src/geoPersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { seedGeoProject } from "./helpers/geoMeasureFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {ControlPlaneDatabase} */
let database;
/** @type {GeoMeasureStore} */
let store;
const at = new Date("2026-10-23T08:00:00Z");
const coverage = { status: "partial", reasons: ["answer_truncated"], answerChars: 9000, assessedChars: 8000 };
const genericMentions = [{ name: "生血宝合剂", ours: true, competitor: false, count: 1, matchedNames: ["生血宝合剂"], productAttributed: true }];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoassessment");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoMeasureStore(database);
  await store.ready();
  await seedGeoProject(database, {
    id: "assessment_geo", userId: "assessment_user", projectId: "assessment_project", engines: ["deepseek"],
    groups: [{ id: "assessment_group", pool: "P1" }],
    questions: [{ id: "assessment_question", groupId: "assessment_group", text: "这个产品如何使用？" }],
  });
  await database.query(`INSERT INTO evimed_geo.rounds
    (id, user_id, geo_project_id, kind, set_version, engines, status, sample_date, finished_at)
    VALUES ('assessment_round', 'assessment_user', 'assessment_geo', 'single_step', 1, ARRAY['deepseek'], 'done', '2026-10-23', $1)`, [at]);
});

after(async () => {
  await database?.close();
  await isolated?.drop();
});

/** @param {string} id @param {Record<string, any>} [extra] */
async function writeAssessment(id, extra = {}) {
  await database.query(`INSERT INTO evimed_geo.questions (id, user_id, geo_project_id, group_id, set_version, text, pool, is_measured)
    VALUES ($1, 'assessment_user', 'assessment_geo', 'assessment_group', 1, $1, 'P1', true)`, [`question_${id}`]);
  await database.query(`INSERT INTO evimed_geo.snapshots
    (id, user_id, geo_project_id, round_id, question_id, engine, status, asked_at, answer_text, surface)
    VALUES ($1, 'assessment_user', 'assessment_geo', 'assessment_round', $3, 'deepseek', 'valid', $2,
      '生血宝合剂的使用需要结合适用范围。', '{"mode":"web"}'::jsonb)`, [id, at, `question_${id}`]);
  const facts = {
    brands: [], mentionsOurs: false, statements: [{ text: "使用条件", verdict: "correct" }],
    checks: { answerCut: true, judgementCoverage: coverage },
    judgeExtract: { genericMentions }, parserVersion: "geo-parse-2+geo-judge-test", judgedAt: at.toISOString(), registryKey: "old",
    ...extra,
  };
  await store.writeFacts({ id, userId: "assessment_user", geoProjectId: "assessment_geo" }, facts, { at });
  return facts;
}

test("stored assessment coverage and generic identity reach calculation and recount inputs", options, async () => {
  await writeAssessment("assessment_partial");
  const row = (await store.roundFactRows("assessment_round")).find(item => item.snapshotId === "assessment_partial");
  assert.deepEqual(row?.facts?.checks?.judgementCoverage, coverage);
  assert.deepEqual(row?.facts?.genericMentions, genericMentions);
  assert.equal(row?.facts?.parserVersion, "geo-parse-2+geo-judge-test");
  const old = (await store.factsCountedUnder("assessment_geo", "new", 10)).find(item => item.snapshotId === "assessment_partial");
  assert.deepEqual(old?.checks?.judgementCoverage, coverage);
  assert.equal(old?.judged, true);
});

test("registry recount preserves judgment and updates identity provenance", options, async () => {
  const facts = await writeAssessment("assessment_recount", { parserVersion: "geo-parse-1+geo-judge-test" });
  const next = [{ ...genericMentions[0], productAttributed: false }];
  const parserVersion = "geo-parse-2+geo-judge-test";
  await store.recountFacts("assessment_recount", { ...facts, parserVersion,
    judgeExtract: { genericMentions: next, sourceParserVersion: facts.parserVersion } }, { key: "new", at });
  const row = (await database.query("SELECT judge_extract, checks, statements, parser_version FROM evimed_geo.facts WHERE snapshot_id = $1", ["assessment_recount"])).rows[0];
  assert.deepEqual(row.judge_extract.genericMentions, next);
  assert.deepEqual(row.checks.judgementCoverage, coverage);
  assert.deepEqual(row.statements, facts.statements);
  assert.equal(row.parser_version, parserVersion);
  assert.equal(row.judge_extract.sourceParserVersion, facts.parserVersion);
});

test("measurement retries the durable assessment outbox instead of opening a missing-method scout lead", options, async () => {
  await writeAssessment("assessment_wrong", { statements: [{ text: "错误的适用条件", verdict: "wrong", severity: 2 }] });
  /** @type {any[]} */
  const ticks = [];
  await measureRound({ store, now: () => at, learning: { tick: async () => { ticks.push(true); } } }, "assessment_round");
  assert.equal(ticks.length, 1);
});

test("restarting an existing schema permits explicit unknown and partial assessments without changing its facts", options, async () => {
  await writeAssessment("assessment_legacy");
  await database.query("ALTER TABLE evimed_geo.facts DROP CONSTRAINT facts_failure_mode_check");
  await database.query("ALTER TABLE evimed_geo.facts ADD CONSTRAINT facts_failure_mode_check CHECK (failure_mode IN ('correct', 'wrong_ours'))");
  await assert.rejects(database.query("UPDATE evimed_geo.facts SET failure_mode = 'partial' WHERE snapshot_id = 'assessment_legacy'"), { code: "23514" });
  const restarted = new ControlPlaneDatabase({ databaseUrl: isolated?.url ?? databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  try {
    await migrateGeo(restarted);
    for (const mode of ["unknown", "partial"]) {
      await restarted.query("UPDATE evimed_geo.facts SET failure_mode = $1 WHERE snapshot_id = 'assessment_legacy'", [mode]);
    }
    const row = (await restarted.query("SELECT statements, checks FROM evimed_geo.facts WHERE snapshot_id = 'assessment_legacy'")).rows[0];
    assert.deepEqual(row.checks.judgementCoverage, coverage);
    assert.equal(row.statements[0].text, "使用条件");
  } finally { await restarted.close(); }
});

test("diagnosis composition separates complete, partial, unknown and refused answers", options, async () => {
  await writeAssessment("composition_complete", { mentionsOurs: true, checks: {
    judgementCoverage: { status: "complete", reasons: [], answerChars: 20, assessedChars: 20 },
  } });
  await writeAssessment("composition_partial", { mentionsOurs: true });
  await writeAssessment("composition_legacy", { mentionsOurs: true, checks: {}, failureMode: "correct", parserVersion: "geo-parse-1+geo-judge-1" });
  await writeAssessment("composition_unjudged", { mentionsOurs: true, judgedAt: null, checks: {}, failureMode: "correct" });
  await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, round_id, engine, status, asked_at)
    VALUES ('composition_refusal', 'assessment_user', 'assessment_geo', 'assessment_round', 'deepseek', 'refusal', $1)`, [at]);
  await writeAssessment("composition_refusal_wrong", { statements: [{ text: "错误的适用条件", verdict: "wrong" }], failureMode: "wrong_ours" });
  await database.query("UPDATE evimed_geo.snapshots SET status = 'refusal' WHERE id = 'composition_refusal_wrong'");
  const service = new GeoService({ store: new GeoStore({ database }), config: {
    geoEnabled: true, geoAudience: "all", geoTimeZone: "Asia/Shanghai", operatorUsers: [], geoPreviewUsers: [],
  } });
  const view = await service.diagnosis({ id: "assessment_user" }, "assessment_geo");
  assert.deepEqual(view.failureModes.correct.snapshotIds, ["composition_complete"]);
  assert.ok(view.failureModes.partial.snapshotIds.includes("composition_partial"));
  assert.ok(view.failureModes.unknown.snapshotIds.includes("composition_legacy"));
  assert.ok(view.failureModes.unknown.snapshotIds.includes("composition_unjudged"));
  assert.deepEqual(view.failureModes.refused.snapshotIds, ["composition_refusal"]);
  assert.ok(view.failureModes.wrongOurs.snapshotIds.includes("composition_refusal_wrong"), "a refusal does not erase its verified medical error");
});

test("metric assessment counts and method identity survive database and API reads", options, async () => {
  const assessment = { methodVersion: "geo-measurement-2", completeAnswers: 1, partialAnswers: 2, unknownAnswers: 3 };
  await store.writeMetrics({ roundId: "assessment_round", geoProjectId: "assessment_geo", userId: "assessment_user", computedAt: at,
    rows: [{ metricId: "M-06", scope: "project", numerator: 1, denominator: 1, value: 100, status: "insufficient", assessment }] });
  const saved = (await database.query("SELECT * FROM evimed_geo.metrics WHERE round_id = 'assessment_round' AND metric_id = 'M-06'")).rows[0];
  assert.deepEqual(saved.assessment, assessment);
  assert.equal(saved.method_version, "geo-measurement-2");
  assert.deepEqual(geoCellFromRow(saved).assessment, assessment);
  assert.equal(geoCellFromRow(saved).methodVersion, "geo-measurement-2");
  assert.equal(geoCellFromRow({ ...saved, method_version: null }).methodVersion, null);
  assert.equal(geoCellFromRow({ ...saved, assessment: null }).assessment, undefined, "legacy rows do not acquire invented coverage");
});

test("value coverage carries partial observation scope through the shared service", options, async () => {
  const geoStore = new GeoStore({ database });
  await geoStore.writeValue("assessment_user", "assessment_geo", { findings: [{ id: "finding_1", statement: "适用范围" }] });
  await writeAssessment("value_partial", { judgeExtract: { valueBasisVersion: 1, valueCoverage: [
    { findingId: "finding_1", status: "not_addressed", reason: "The inspected prefix does not mention it." },
    { findingId: "finding_1", status: "represented", quote: "适用范围" },
  ] } });
  const service = new GeoService({ store: geoStore, config: {
    geoEnabled: true, geoAudience: "all", geoTimeZone: "Asia/Shanghai", operatorUsers: [], geoPreviewUsers: [],
  } });
  const view = await service.value({ id: "assessment_user" }, "assessment_geo");
  assert.equal(view.coverage.notAddressed, 0);
  assert.equal(view.coverage.uncertain, 1);
  assert.equal(view.coverage.represented, 1);
  assert.deepEqual(view.coverage.assessment, { completeObservations: 0, partialObservations: 2, unknownObservations: 0 });
  assert.ok(view.observations.every(item => item.judgementCoverage.status === "partial"));
});
