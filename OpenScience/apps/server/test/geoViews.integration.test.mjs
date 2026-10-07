// What the 循证 GEO pages read beyond the shapes geoRoutes pins: the project-wide target and no other, the true error counts of a
// project with more errors than the list carries, a question's latest answers across set versions, the battlefield's names, and the
// one round every diagnosis reads. Against the real service, store and DDL, in a database of its own.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
/** @type {GeoService} */
let service;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
let counter = 0;

const run = randomBytes(4).toString("hex");
const ALICE = `alice-${run}`;
const USER = { id: ALICE };
const config = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [], geoEngines: ["doubao", "deepseek", "kimi"],
  geoTimeZone: "Asia/Shanghai", geoDiagnosisErrorLimit: 5, dataDir: "/nonexistent" };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoviews");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  service = new GeoService({ store, config, now: () => new Date() });
  await service.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** A project of alice's with a locked 48-question map (12 groups of 4, P1..P4). @param {string[]} [engines] */
async function seededProject(engines = ["doubao", "deepseek", "kimi"]) {
  counter += 1;
  const project = await store.createProject({ userId: ALICE, projectId: `p-${run}-${counter}`, engines, coverageDays: 90, product: { brandName: "玛仕度肽" } });
  const write = (/** @type {string} */ what, /** @type {Record<string, any>} */ body) =>
    geoRuntimeWrite({ store, project, what, body, articleGate: async () => "passed" });
  await write("product", { data: { genericName: "玛仕度肽注射液", rx: "rx" } });
  await write("claims", { items: [{ claimKey: "dose", statement: "每周皮下注射一次", quote: "本品每周一次皮下注射。", sourceRef: "说明书 2024 版", sourceKind: "label", inLabel: true }] });
  const pools = ["P1", "P2", "P3", "P4"];
  const groups = Array.from({ length: 12 }, (_unused, index) => ({
    pool: pools[index % 4], name: `语义群 ${index + 1}`, typicalQuestion: `典型问句 ${index + 1}`, isControl: index % 4 === 1,
    questions: Array.from({ length: 4 }, (_q, q) => ({ text: `问句 ${index + 1}-${q + 1}`, kind: "real", platform: "xhs", isMeasured: true })),
  }));
  await write("questions", { data: { groups } });
  const lock = await write("lock_questions", { data: {} });
  assert.equal(lock.ok, true, JSON.stringify(lock.issues));
  return { project, write };
}

/** @param {string} id @param {string} geoId @param {string} kind @param {Record<string, string | null>} [extra] */
const insertRound = (id, geoId, kind, extra = {}) => database.query(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, status,
    planned, done, sample_date, created_at, finished_at) VALUES ($1, $2, $3, $4, 1, ARRAY['doubao','deepseek','kimi'], $5, 10, 10, '2026-09-24',
    coalesce($6::timestamptz, now()), $7::timestamptz)`, [id, ALICE, geoId, kind, extra.status ?? "done", extra.createdAt ?? null, extra.finishedAt ?? null]);

/** @param {string} id @param {string} geoId @param {string} roundId @param {string} questionId @param {string} engine @param {string} status @param {string} askedAt */
const insertSnapshot = (id, geoId, roundId, questionId, engine, status, askedAt) => database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id,
    geo_project_id, question_id, engine, asked_at, status, answer_text) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, '回答')`,
[id, ALICE, roundId, geoId, questionId, engine, askedAt, status]);

test("a target is the project-wide row or nothing: a pool's own goal never stands in for it", options, async () => {
  const { project, write } = await seededProject();
  // M-01S has goals for two pools only; M-19 has a project-wide goal.
  await store.writeTargets(ALICE, project.id, [
    { tier: "2", metricId: "M-01S", pool: "P2", baseline: 8, target: 12, dataType: "forecast" },
    { tier: "2", metricId: "M-01S", pool: "P3", baseline: 9, target: 13, dataType: "forecast" },
    { tier: "2", metricId: "M-19", pool: "all", baseline: 20, target: 50, dataType: "forecast" },
  ]);
  void write;
  const page = await service.projectView(USER, project.id);
  const byKey = Object.fromEntries(page.overview.metrics.map((/** @type {any} */ metric) => [metric.key, metric.target]));
  assert.equal(byKey.gvi, 50);
  assert.equal(byKey.mention, null, "P2's 12 % is not the project's mention goal");
  await store.writeTargets(ALICE, project.id, [
    { tier: "2", metricId: "M-01S", pool: "P2", baseline: 8, target: 12, dataType: "forecast" },
    { tier: "2", metricId: "M-01S", pool: "all", baseline: 22, target: 45, dataType: "forecast" },
  ]);
  const later = await service.projectView(USER, project.id);
  assert.equal(later.overview.metrics.find((/** @type {any} */ metric) => metric.key === "mention").target, 45);
  const row = (await service.listProjects(USER)).projects.find((entry) => entry.id === project.id);
  assert.equal(row?.headline.gvi.target, null, "the list reads the same rule: this version has no project-wide M-19 goal");
});

test("the counts of errors are taken over every row, severe means live S3 or S4, and the list is capped", options, async () => {
  const { project } = await seededProject();
  const map = await store.questionMap(project.id, 1);
  const question = map[0].questions[0];
  let n = 0;
  const addError = (/** @type {string} */ status, /** @type {string} */ severity, /** @type {string | null} */ last = null) => {
    n += 1;
    return database.query(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, statement, error_type, severity, status,
        first_snapshot_id, last_snapshot_id, updated_at) VALUES ($1, $2, $3, $4, 'deepseek', $5, $6, 'number', $7, $8, NULL, $9, now() + ($10 || ' seconds')::interval)`,
    [`e-${run}-${project.id}-${n}`, ALICE, project.id, `fp-${n}`, question.id, `讲错第 ${n} 句`, severity, status, last, String(n)]);
  };
  // 6 open (one S4, one S3), 2 acting (one S3), 1 awaiting a remeasure (S3), 3 closed (one S4): 12 rows against a list of 5.
  await addError("open", "S4"); await addError("open", "S3");
  for (let index = 0; index < 4; index += 1) await addError("open", "S1");
  await addError("acting", "S3"); await addError("acting", "S2");
  await addError("awaiting_remeasure", "S3");
  await addError("closed", "S4"); await addError("closed", "S1"); await addError("closed", "S2");

  const diagnosis = await service.diagnosis(USER, project.id);
  assert.deepEqual(diagnosis.errorCounts, { total: 12, open: 6, acting: 2, awaiting_remeasure: 1, closed: 3, severe: 4 },
    "S4 + S3 open, S3 acting, S3 awaiting a remeasure — the closed S4 is not live");
  assert.equal(diagnosis.errors.length, 5, "the list is capped (geoDiagnosisErrorLimit), the counts are not");
  assert.ok(diagnosis.errors.every((error) => error.status !== "closed"), "live errors come first, severe first");
  assert.deepEqual(diagnosis.errors.slice(0, 2).map((error) => error.severity), ["S4", "S3"]);

  const row = (await service.listProjects(USER)).projects.find((entry) => entry.id === project.id);
  assert.deepEqual(row?.alert, { wrongOurs: 9, severe: 4, safety: 0, severity: "S4" }, "wrongOurs is every live error, severe the S3/S4 among them");
});

test("a measured question links its latest answer per engine, in the project's order, across set versions", options, async () => {
  const { project } = await seededProject(["kimi", "doubao", "deepseek"]);
  const v1 = await store.questionMap(project.id, 1);
  const question = v1[0].questions[0];
  await insertRound(`rb-${project.id}`, project.id, "baseline", { finishedAt: "2026-09-24T10:00:00Z" });
  await insertRound(`rs-${project.id}`, project.id, "sentinel", { finishedAt: "2026-09-30T10:00:00Z" });
  // doubao answered twice (the later one wins); deepseek once; kimi's answer is a suspect login page, so kimi has none; the sentinel round is not a full measurement.
  await insertSnapshot(`sa-${project.id}`, project.id, `rb-${project.id}`, question.id, "doubao", "valid", "2026-09-24T01:00:00Z");
  await insertSnapshot(`sb-${project.id}`, project.id, `rb-${project.id}`, question.id, "doubao", "refusal", "2026-09-24T02:00:00Z");
  await insertSnapshot(`sc-${project.id}`, project.id, `rb-${project.id}`, question.id, "deepseek", "valid", "2026-09-24T03:00:00Z");
  await insertSnapshot(`sd-${project.id}`, project.id, `rb-${project.id}`, question.id, "kimi", "suspect", "2026-09-24T04:00:00Z");
  await insertSnapshot(`se-${project.id}`, project.id, `rs-${project.id}`, question.id, "deepseek", "valid", "2026-09-30T04:00:00Z");

  const first = await service.questions(USER, project.id, null);
  const measured = first.groups[0].questions[0];
  assert.deepEqual(measured.answers, [{ engine: "doubao", snapshotId: `sb-${project.id}` }, { engine: "deepseek", snapshotId: `sc-${project.id}` }],
    "project order (kimi first, but it has no answer), the latest valid or refusal answer of each engine, full rounds only");
  assert.deepEqual(first.groups[0].questions[1].answers, [], "a question never asked has no answer");

  // Taking another question out of measurement writes version 2 with all-new question ids: the links are matched by the text.
  const other = v1[1].questions[0];
  const moved = await service.unmeasureQuestion(USER, project.id, other.id);
  assert.equal(moved.version, 2);
  const second = await service.questions(USER, project.id, null);
  assert.equal(second.version, 2);
  const again = second.groups[0].questions[0];
  assert.notEqual(again.id, question.id, "a new set version is new rows");
  assert.equal(again.text, question.text);
  assert.deepEqual(again.answers, measured.answers);
  const taken = second.groups.flatMap((group) => group.questions).find((entry) => entry.text === other.text);
  assert.equal(taken?.isMeasured, false);
  assert.deepEqual(taken?.answers, [], "a question out of measurement has no link");
});

test("the main battlefield is named: an id is resolved, a name stays, an id nobody owns is dropped", options, async () => {
  const { project, write } = await seededProject();
  const groupTwo = (await store.questionMap(project.id, 1)).find((group) => group.name === "语义群 2");
  assert.ok(groupTwo);
  await insertRound(`rb2-${project.id}`, project.id, "baseline", { finishedAt: "2026-09-24T10:00:00Z" });
  await write("strategy", { data: {
    battlefield: { groups: [groupTwo.id, "语义群 3", "ggr_00000000000000000000000000000000", groupTwo.id], reason: "证据最硬" },
    expectations: [{ engine: "deepseek", promise: "讲对", layers: ["anchor"] }],
    sources: [],
  } });
  const sources = await service.sources(USER, project.id);
  assert.equal(sources.battlefield.groupNames.join("、"), "语义群 2、语义群 3", "once each, in the order written");
  assert.equal(sources.battlefield.groups.length, 4, "what the run wrote stays for the runtime's own reads");
  assert.ok(sources.battlefield.groupNames.every((/** @type {string} */ name) => !name.startsWith("ggr_")));
});

test("the diagnosis reads the round that finished last, not the one begun last", options, async () => {
  const { project } = await seededProject();
  // `late` was created last but finished first; `early` was created first and finished last: the latest measurement is `early`.
  await insertRound(`late-${project.id}`, project.id, "weekly", { createdAt: "2026-10-02T00:00:00Z", finishedAt: "2026-10-02T06:00:00Z" });
  await insertRound(`early-${project.id}`, project.id, "weekly", { createdAt: "2026-10-01T00:00:00Z", finishedAt: "2026-10-03T06:00:00Z" });
  await insertRound(`run-${project.id}`, project.id, "weekly", { createdAt: "2026-10-04T00:00:00Z", status: "running" });
  const diagnosis = await service.diagnosis(USER, project.id);
  assert.equal(diagnosis.round?.id, `early-${project.id}`, "a round still running never stands in for a finished one");
});

test("a point of a trend says how many answers it rests on", options, async () => {
  const { project } = await seededProject();
  await insertRound(`rt-${project.id}`, project.id, "baseline", { finishedAt: "2026-09-24T10:00:00Z" });
  await database.query(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, metric_id, numerator, denominator, value, status, data_type)
    VALUES ($1, $2, $3, $4, 'project', 'M-19', NULL, 310, 44, 'ok', 'measured')`, [`mt-${project.id}`, ALICE, project.id, `rt-${project.id}`]);
  const page = await service.projectView(USER, project.id);
  assert.deepEqual(page.overview.metrics[0].trend, [{ date: "2026-09-24", value: 44, n: 310 }]);
});

test("a 本周 line about an error opens the answer that holds the sentence it quotes", options, async () => {
  const { project } = await seededProject();
  const question = (await store.questionMap(project.id, 1))[0].questions[0];
  await insertRound(`rw-${project.id}`, project.id, "baseline", { finishedAt: new Date().toISOString() });
  await insertSnapshot(`sf-${project.id}`, project.id, `rw-${project.id}`, question.id, "deepseek", "valid", new Date(Date.now() - 86_400_000).toISOString());
  await insertSnapshot(`sl-${project.id}`, project.id, `rw-${project.id}`, question.id, "deepseek", "valid", new Date().toISOString());
  await database.query(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, statement, error_type, severity, status,
      first_snapshot_id, last_snapshot_id) VALUES ($1, $2, $3, 'fp-w', 'deepseek', $4, '每天注射一次', 'number', 'S3', 'open', $5, $6)`,
  [`ew-${project.id}`, ALICE, project.id, question.id, `sf-${project.id}`, `sl-${project.id}`]);
  const page = await service.projectView(USER, project.id);
  const line = page.overview.week.find((item) => item.kind === "wrong_ours");
  assert.equal(line?.ref?.snapshotId, `sf-${project.id}`);
  const error = (await service.diagnosis(USER, project.id)).errors[0];
  assert.deepEqual([error.firstSnapshotId, error.snapshotId], [`sf-${project.id}`, `sl-${project.id}`]);
});
