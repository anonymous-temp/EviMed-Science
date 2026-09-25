// The measurement loop against PostgreSQL on the evimed_geo DDL and a fake
// probe host over real HTTP: rounds become jobs, jobs become answers,
// answers become facts, facts become errors and numbers. Everything real
// except the probe host, the model and the inclusion vendor.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { enqueueRound, geoMeasureState, tickProbe } from "../src/geoProbeQueue.mjs";
import { GeoJudge, tickParse } from "../src/geoJudge.mjs";
import { tickMetrics } from "../src/geoMetricsJob.mjs";
import { noteErrorAction, tickErrors } from "../src/geoErrors.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { GEO_TABLES_FOR_TESTS, fakeModel, seedGeoProject, startFakeProbe, testClock } from "./helpers/geoMeasureFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {GeoMeasureStore} */
let store;
/** @type {string} */
let dataDir;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoMeasureStore(database);
  await store.ready();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "geo-measure-"));
});

after(async () => {
  await database?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function reset() {
  await database.query(`TRUNCATE ${GEO_TABLES_FOR_TESTS.map((table) => `evimed_geo.${table}`).join(", ")} CASCADE`);
  await rm(path.join(dataDir, "geo"), { recursive: true, force: true });
}

// ---------------------------------------------------------------- a product, its claims, its answers

const DOSING = { key: "dosing", statement: "每周一次皮下注射", quote: "本品每周一次皮下注射给药，起始剂量为2 mg。" };
const INDICATION = { key: "indication", statement: "用于成人2型糖尿病的血糖控制", quote: "用于成人2型糖尿病患者的血糖控制。" };
const Q1 = "玛仕度肽一周打几次？";
const Q2 = "GLP-1类降糖药哪个好？";
const Q3 = "血糖高了吃什么药？";
const WRONG = "玛仕度肽每天注射一次";
const A_WRONG = `${WRONG}[1]，适合成人2型糖尿病患者控制血糖，使用时请遵医嘱，出现持续剧烈腹痛应立即就医。`;
const A_RIGHT = "玛仕度肽每周注射一次，适合成人2型糖尿病患者控制血糖，使用时请遵医嘱，如有不适请及时就医。";
const A_Q1_DOUBAO = "常见选择：\n1. 诺和泰每周一次。\n2. 玛仕度肽每周注射一次，玛仕度肽起始剂量为5 mg，具体请遵医嘱并定期复查血糖水平。";
const A_Q2 = "GLP-1 类药物包括司美格鲁肽（诺和泰）和玛仕度肽等，医生通常推荐玛仕度肽用于超重的糖尿病患者，需遵医嘱使用。";
const A_Q3 = "血糖高时应先就医明确诊断，常用药物包括二甲双胍片等，需要在医生指导下使用，不要自行购药服用，注意饮食控制。";
// Long, no refusal marker: only the judge can tell it declines to answer.
const DEFER = "这个问题需要结合您的具体情况判断，我不便推荐具体药物，建议到正规医院内分泌科就诊，由医生根据检查结果决定用药方案。";
const LOGIN = "请先登录后继续使用";
const REFUSAL = "抱歉，我无法提供医疗建议，请咨询专业医生。";
const OWNED_LABEL = [{ title: "说明书", url: "https://www.mazdutide.example.com/label" }];

/** @param {string} id @param {{ engines?: string[], controls?: number }} [options] */
async function seed(id, { engines = ["deepseek", "doubao"] } = {}) {
  await seedGeoProject(database, {
    id, userId: `user_${id}`, projectId: `proj_${id}`, engines,
    groups: [
      { id: `${id}_g1`, pool: "P1", weight: 3, journeyStage: "用药中" },
      { id: `${id}_g2`, pool: "P2", weight: 2 },
      { id: `${id}_g3`, pool: "P3", weight: 1, isControl: true },
    ],
    questions: [
      { id: `${id}_q1`, groupId: `${id}_g1`, text: Q1 },
      { id: `${id}_q2`, groupId: `${id}_g2`, text: Q2 },
      { id: `${id}_q3`, groupId: `${id}_g3`, text: Q3 },
    ],
    claims: [DOSING, INDICATION],
    ownedDomains: ["mazdutide.example.com"],
    careNodes: [{ node: "用药中", redFlags: ["出现持续剧烈腹痛应立即就医"] }],
  });
}

/** The probe's answers in the baseline: a wrong statement, a suspect that is asked again, a refusal. */
const baselineAnswers = (/** @type {{ question: string, engine: string, nth: number }} */ { question, engine, nth }) => {
  if (question === Q1 && engine === "deepseek") return { answer: A_WRONG, searchResults: OWNED_LABEL };
  if (question === Q1) return { answer: A_Q1_DOUBAO, searchResults: [{ title: "新闻", url: "https://news.example.org/a" }] };
  if (question === Q2 && engine === "deepseek") return nth === 1 ? { answer: LOGIN } : { answer: A_Q2 };
  if (question === Q2) return { answer: REFUSAL };
  if (engine === "doubao") return { answer: DEFER };
  return { answer: A_Q3 };
};

/** The model's judgement of an answer, as the judge would return it. */
const judgeAnswers = (/** @type {{ answer: string, claimAlias: (fragment: string) => string | null }} */ { answer, claimAlias }) => {
  const statements = [];
  if (answer.includes(WRONG)) {
    statements.push({ text: WRONG, verdict: "wrong", claim: claimAlias("每周一次皮下注射"), evidence: "本品每周一次皮下注射给药", errorType: "number", severity: "S3" });
  }
  if (answer.includes("玛仕度肽每周注射一次")) {
    statements.push({ text: "玛仕度肽每周注射一次", verdict: "correct", claim: claimAlias("每周一次"), evidence: "每周一次皮下注射给药" });
  }
  if (answer.includes("玛仕度肽起始剂量为5 mg")) {
    // Judged correct by the model, but 5 mg is not in the claim: code drops it.
    statements.push({ text: "玛仕度肽起始剂量为5 mg", verdict: "correct", claim: claimAlias("起始剂量"), evidence: "起始剂量为2 mg" });
  }
  return {
    refusal: answer.includes("无法提供医疗建议") || answer.includes("我不便推荐具体药物"),
    statements,
    entities: answer.includes("二甲双胍片") ? ["二甲双胍片"] : [],
    recommendations: answer.includes("医生通常推荐玛仕度肽") ? ["医生通常推荐玛仕度肽用于超重的糖尿病患者"] : [],
    careHint: answer.includes("就医"),
    redFlagsExpected: ["F1"],
    redFlagsHit: answer.includes("剧烈腹痛") ? ["F1"] : [],
    safetyTerms: [],
  };
};

/**
 * Everything one scenario needs: the fake probe, the clock, the recorded
 * hooks, and the deps each tick takes.
 * @param {{ answers?: Function, clock?: string, config?: Record<string, unknown>, inclusion?: any, providers?: () => Record<string, string> }} [setup]
 */
async function harness(setup = {}) {
  const script = { ask: setup.answers ?? baselineAnswers };
  const probe = await startFakeProbe({ ask: (request) => script.ask(request), providers: setup.providers });
  const clock = testClock(setup.clock ?? "2026-09-25T15:00:00Z"); // 23:00 in Shanghai: inside the night window
  const model = fakeModel(judgeAnswers);
  /** @type {any[]} */
  const alerts = [];
  /** @type {any[]} */
  const notices = [];
  const config = {
    geoProbeUrl: probe.url, geoProbeTimeoutMs: 10_000, dataDir, geoNightWindow: "22-07", geoTimeZone: "Asia/Shanghai",
    geoWeeklyAskCap: 1_500, geoDailyBudgetCny: 20, deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", ...setup.config,
  };
  const state = geoMeasureState();
  const deps = {
    store, config, now: clock.now, state, inclusion: setup.inclusion ?? null,
    judge: new GeoJudge(config, { callModel: /** @type {any} */ (model.callModel) }),
    alertOperator: (/** @type {any} */ event) => { alerts.push(event); },
    notify: (/** @type {any} */ event) => { notices.push(event); },
  };
  return { script, probe, clock, model, alerts, notices, config, state, deps };
}

/** @param {string} sql @param {unknown[]} [values] */
const rows = async (sql, values = []) => (await database.query(sql, values)).rows;

/** @param {any[]} cells @param {Record<string, unknown>} where */
const cell = (cells, where) => cells.find((row) => Object.entries(where).every(([key, value]) => row[key] === value));

// ---------------------------------------------------------------- the round

test("a round of 3 questions × 2 engines becomes answers, facts and numbers; a suspect is asked again and alerted, a refusal stays in", options, async () => {
  await reset();
  await seed("geo_a");
  const h = await harness();
  try {
    const round = await enqueueRound(h.deps, { geoProjectId: "geo_a", kind: "baseline" });
    assert.equal(round.planned, 6);
    assert.deepEqual(round.engines, ["deepseek", "doubao"]);

    const first = await tickProbe({ ...h.deps, maxAsks: 10 });
    assert.equal(first.asked, 6);
    assert.equal(first.suspect, 1);
    assert.equal(first.refusal, 1);
    assert.equal(first.valid, 4);
    assert.equal(first.retried, 1, "the login page is asked again, later");
    assert.equal(first.screenshotsStored, 1, "six answers, one image: stored once");
    assert.equal(first.roundsFinished, 0);
    assert.deepEqual(h.alerts.map((event) => [event.kind, event.engine]), [["geo_probe_suspect", "deepseek"]]);

    h.clock.advance(3 * 60_000);
    const second = await tickProbe({ ...h.deps, maxAsks: 10 });
    assert.equal(second.asked, 1);
    assert.equal(second.valid, 1);
    assert.equal(second.roundsFinished, 1);

    // Fresh every time: seven requests, one per ask, none replayed.
    assert.equal(h.probe.asks.length, 7);
    assert.ok(h.probe.asks.every((ask) => ask.body.new_chat === 1 && ask.body.deep === 0 && ask.body.providers.length === 1));
    const snapshots = await rows(`SELECT status, engine, screenshot_sha256, surface, warnings, probe_job_id FROM evimed_geo.snapshots ORDER BY asked_at, id`);
    assert.equal(snapshots.length, 7);
    assert.deepEqual(snapshots.map((row) => row.status).sort(), ["refusal", "suspect", "valid", "valid", "valid", "valid", "valid"]);
    assert.equal(new Set(snapshots.map((row) => row.screenshot_sha256)).size, 1);
    const shots = await readdir(path.join(dataDir, "geo", "snapshots"), { recursive: true });
    assert.equal(shots.filter((name) => String(name).endsWith(".png")).length, 1);
    assert.ok(snapshots.every((row) => row.probe_job_id && row.surface.mode === "web"));
    assert.ok(snapshots.find((row) => row.status === "suspect").warnings.includes("sanity:session_invalid:请先登录"));
    const [closed] = await rows(`SELECT status, done, failed, planned, sample_date::text AS day FROM evimed_geo.rounds WHERE id = $1`, [round.roundId]);
    assert.deepEqual({ ...closed }, { status: "done", done: 6, failed: 0, planned: 6, day: "2026-09-25" });

    // Parse and judge: code counts, the model judges, code re-verifies.
    const parsed = await tickParse({ ...h.deps, maxParse: 20 });
    assert.equal(parsed.parsed, 6, "the suspect is never parsed");
    assert.equal(parsed.refusals, 2, "the marker refusal, and the long one only the judge recognised");
    const [deferred] = await rows(`SELECT status FROM evimed_geo.snapshots WHERE answer_text = $1`, [DEFER]);
    assert.equal(deferred.status, "refusal");
    assert.equal(parsed.errorsCreated, 1);
    assert.equal(parsed.notified, 1);
    assert.ok(parsed.dropped >= 1);
    assert.equal(h.model.calls.length, 6);
    for (const call of h.model.calls) {
      assert.equal(call.purpose, "geo");
      assert.deepEqual(call.limits, { daily: 0, weekly: 0 });
      assert.equal(call.body.model, "deepseek-flash");
      assert.deepEqual({ userId: call.userId, projectId: call.projectId }, { userId: "user_geo_a", projectId: "proj_geo_a" });
    }
    const [doubaoQ1] = await rows(`SELECT f.statements, f.brands, f.recommended_ours, s.warnings FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id
      JOIN evimed_geo.questions q ON q.id = s.question_id WHERE q.text = $1 AND s.engine = 'doubao'`, [Q1]);
    assert.deepEqual(doubaoQ1.statements.map((/** @type {any} */ statement) => [statement.text, statement.verdict]), [["玛仕度肽每周注射一次", "correct"]],
      "the 5 mg verdict failed re-verification and is gone, not softened");
    assert.ok(doubaoQ1.warnings.includes("judge_dropped:statement:number_not_in_claim"));
    assert.deepEqual(doubaoQ1.brands.map((/** @type {any} */ brand) => [brand.name, brand.position, brand.inRecommendation]), [["诺和泰", 1, true], ["玛仕度肽", 2, true]]);
    const refusals = await rows(`SELECT f.failure_mode FROM evimed_geo.facts f JOIN evimed_geo.snapshots s ON s.id = f.snapshot_id WHERE s.status = 'refusal'`);
    assert.deepEqual(refusals.map((row) => row.failure_mode), ["none", "none"]);

    // The S3 error: notified once, traced to our own page, confirmation queued.
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].kind, "wrong_ours");
    assert.equal(h.notices[0].level, "S3");
    assert.equal(h.notices[0].engineLabel, "DeepSeek");
    assert.equal(h.notices[0].statement, WRONG);
    const [error] = await rows(`SELECT * FROM evimed_geo.errors`);
    assert.equal(error.severity, "S3");
    assert.equal(error.severity_basis, "initial");
    assert.equal(error.error_type, "number");
    assert.equal(error.evidence_quote, "本品每周一次皮下注射给药");
    assert.equal(error.cited_source.attribute, "owned");
    assert.equal(error.cited_source.domain, "www.mazdutide.example.com");
    assert.deepEqual([error.action, error.responsible], ["own_edit", "client"]);
    assert.ok(error.notified_at);
    assert.equal(error.confirm.status, "pending");
    const [confirm] = await rows(`SELECT kind, planned, engines, ref FROM evimed_geo.rounds WHERE id = $1`, [error.confirm.roundId]);
    assert.deepEqual({ kind: confirm.kind, planned: confirm.planned, engines: confirm.engines }, { kind: "confirm", planned: 10, engines: ["deepseek"] });

    // The numbers.
    const metrics = await tickMetrics(h.deps);
    assert.equal(metrics.rounds, 1);
    const cells = await rows(`SELECT metric_id, scope, pool, engine, group_id, arm, variant, rival, reason, status, data_type,
        numerator::float8 AS numerator, denominator::float8 AS denominator, value::float8 AS value FROM evimed_geo.metrics WHERE round_id = $1`, [round.roundId]);
    assert.deepEqual(pick(cell(cells, { metric_id: "M-01", scope: "engine", engine: "deepseek" })), { numerator: 2, denominator: 3, status: "insufficient" },
      "the suspect left the denominator");
    assert.deepEqual(pick(cell(cells, { metric_id: "M-01", scope: "engine", engine: "doubao" })), { numerator: 1, denominator: 3, status: "insufficient" },
      "the refusal stayed in it");
    assert.deepEqual(pick(cell(cells, { metric_id: "M-20", scope: "project", variant: null })), { numerator: 6, denominator: 7, status: "insufficient" });
    assert.deepEqual(pick(cell(cells, { metric_id: "M-20", scope: "project", variant: "refusal" })), { numerator: 2, denominator: 6, status: "insufficient" });
    assert.ok(cell(cells, { metric_id: "M-19", scope: "project" }), "the index is the owner's M-19");
    assert.ok(cells.some((row) => row.status === "not_measurable" && row.reason), "a not-measurable cell says why");
    assert.ok(cells.some((row) => row.scope === "arm" && row.arm === "control"));
    assert.ok(cells.some((row) => row.metric_id === "M-16" && row.rival === "诺和泰"));
    const net = cells.filter((row) => row.metric_id === "NET");
    assert.ok(net.length > 0 && net.every((row) => row.reason === "no_follow_up" && row.status === "not_measurable" && row.data_type === "derived"));
    const sources = await rows(`SELECT domain, layer, cited FROM evimed_geo.sources ORDER BY domain`);
    assert.deepEqual(sources.map((row) => [row.domain, row.layer, row.cited]), [
      ["mazdutide.example.com", "owned", { deepseek: { P1: 1 } }],
      ["news.example.org", null, { doubao: { P1: 1 } }],
    ]);
    // Measured once: nothing new, nothing recomputed.
    assert.equal((await tickMetrics(h.deps)).rounds, 0);
  } finally {
    await h.probe.close();
  }
});

/** @param {any} row */
function pick(row) {
  assert.ok(row, "expected a metric row");
  return { numerator: row.numerator, denominator: row.denominator, status: row.status };
}

// ---------------------------------------------------------------- the error's life

test("an S3 error notifies once, is confirmed by ten fresh asks, closes only after a later answer without it, and reopens when it returns", options, async () => {
  await reset();
  await seed("geo_b");
  const h = await harness();
  try {
    await enqueueRound(h.deps, { geoProjectId: "geo_b", kind: "baseline" });
    await tickProbe({ ...h.deps, maxAsks: 10 });
    h.clock.advance(3 * 60_000);
    await tickProbe({ ...h.deps, maxAsks: 10 });
    await tickParse({ ...h.deps, maxParse: 20 });
    assert.equal(h.notices.length, 1);

    // The confirmation: six of ten fresh asks repeat it, in other words.
    h.script.ask = ({ question, engine, nth }) => (question === Q1 && engine === "deepseek"
      ? { answer: nth <= 7 ? A_WRONG.replace("，适合", "，一般适合") : A_RIGHT, searchResults: OWNED_LABEL }
      : baselineAnswers({ question, engine, nth }));
    const asked = await tickProbe({ ...h.deps, maxAsks: 20 });
    assert.equal(asked.asked, 10);
    assert.equal(asked.roundsFinished, 1);
    assert.equal(h.probe.asks.filter((ask) => ask.question === Q1 && ask.engine === "deepseek").length, 11, "ten new requests, no replay");
    await tickParse({ ...h.deps, maxParse: 20 });
    assert.equal(h.notices.length, 1, "seen again is not notified again");
    const [pending] = await rows(`SELECT id FROM evimed_geo.errors`);
    const read = await tickErrors(h.deps);
    assert.equal(read.confirmsRead, 1);
    const [confirmed] = await rows(`SELECT confirm, status FROM evimed_geo.errors WHERE id = $1`, [pending.id]);
    assert.deepEqual({ status: confirmed.confirm.status, valid: confirmed.confirm.valid, seen: confirmed.confirm.seen, stability: confirmed.confirm.stability },
      { status: "done", valid: 10, seen: 6, stability: "stable" });
    assert.equal((await rows(`SELECT count(*)::int AS n FROM evimed_geo.errors`))[0].n, 1, "one error per fact per engine, whatever the wording");

    // Acted on, then measured again without it: closed.
    await noteErrorAction(h.deps, { geoProjectId: "geo_b", errorId: pending.id, materials: [{ kind: "owned_fix_diff" }], status: "awaiting_remeasure" });
    assert.equal((await tickErrors(h.deps)).closed, 0, "no later answer yet");
    h.clock.advance(86_400_000);
    h.script.ask = ({ question, engine, nth }) => (question === Q1 && engine === "deepseek" ? { answer: A_RIGHT } : baselineAnswers({ question, engine, nth }));
    await enqueueRound(h.deps, { geoProjectId: "geo_b", kind: "sentinel", questionIds: ["geo_b_q1"], engines: ["deepseek"] });
    await tickProbe({ ...h.deps, maxAsks: 5 });
    await tickParse({ ...h.deps, maxParse: 5 });
    assert.equal((await tickErrors(h.deps)).closed, 1);
    const [closed] = await rows(`SELECT status, closed_snapshot_id, materials FROM evimed_geo.errors WHERE id = $1`, [pending.id]);
    assert.equal(closed.status, "closed");
    assert.ok(closed.closed_snapshot_id);
    assert.equal(closed.materials[0].kind, "owned_fix_diff");

    // It comes back: reopened, and a severe one is told again.
    h.clock.advance(86_400_000);
    h.script.ask = baselineAnswers;
    await enqueueRound(h.deps, { geoProjectId: "geo_b", kind: "sentinel", questionIds: ["geo_b_q1"], engines: ["deepseek"] });
    await tickProbe({ ...h.deps, maxAsks: 5 });
    await tickParse({ ...h.deps, maxParse: 5 });
    const [reopened] = await rows(`SELECT status, closed_snapshot_id FROM evimed_geo.errors WHERE id = $1`, [pending.id]);
    assert.deepEqual({ ...reopened }, { status: "open", closed_snapshot_id: null });
    assert.equal(h.notices.length, 2);
    assert.notEqual(h.notices[1].idempotencyKey, h.notices[0].idempotencyKey);
  } finally {
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- the breaker

test("an engine that keeps returning a login page is paused, its round finishes without it, and it resumes when its tab is back", options, async () => {
  await reset();
  await seed("geo_c");
  /** @type {Record<string, string>} */
  let tabs = { deepseek: "tab_found", doubao: "no_tab" };
  const h = await harness({
    answers: ({ engine }) => (engine === "doubao" ? { answer: LOGIN } : { answer: A_Q3 }),
    providers: () => tabs,
  });
  try {
    const round = await enqueueRound(h.deps, { geoProjectId: "geo_c", kind: "sentinel" });
    assert.equal(round.planned, 6);
    const counts = await tickProbe({ ...h.deps, maxAsks: 10 });
    assert.equal(counts.asked, 6);
    assert.deepEqual(counts.tripped, ["doubao"]);
    assert.deepEqual(counts.paused, ["doubao"]);
    assert.equal(counts.roundsFinished, 1, "the round finishes with the paused engine's jobs skipped");
    assert.ok(h.alerts.some((event) => event.kind === "geo_probe_engine_paused" && event.engine === "doubao"));
    const [closed] = await rows(`SELECT status, done, failed FROM evimed_geo.rounds WHERE id = $1`, [round.roundId]);
    assert.deepEqual({ ...closed }, { status: "partial", done: 3, failed: 3 });
    const skipped = await rows(`SELECT engine, error_code FROM evimed_geo.probe_jobs WHERE round_id = $1 AND status = 'skipped'`, [round.roundId]);
    assert.deepEqual(skipped.map((row) => [row.engine, row.error_code]), [["doubao", "engine_paused"], ["doubao", "engine_paused"], ["doubao", "engine_paused"]]);

    await tickParse({ ...h.deps, maxParse: 20 });
    await tickMetrics(h.deps);
    const cells = await rows(`SELECT metric_id, scope, engine, variant, status, reason, numerator::float8 AS numerator, denominator::float8 AS denominator
      FROM evimed_geo.metrics WHERE round_id = $1`, [round.roundId]);
    assert.deepEqual({ ...cell(cells, { metric_id: "M-01", scope: "engine", engine: "doubao" }) }, {
      metric_id: "M-01", scope: "engine", engine: "doubao", variant: null, status: "absent", reason: "engine_absent", numerator: null, denominator: null,
    }, "absent — 未测 — never zero");
    assert.deepEqual(pick(cell(cells, { metric_id: "M-20", scope: "project", variant: null })), { numerator: 3, denominator: 3, status: "insufficient" },
      "the paused engine's answers are out of the round altogether");

    // Still logged out ten minutes later; logged in ten minutes after that.
    const providersBefore = h.probe.providerCalls.count;
    await tickProbe({ ...h.deps, maxAsks: 1 });
    assert.equal(h.probe.providerCalls.count, providersBefore, "not re-checked before ten minutes");
    h.clock.advance(10 * 60_000);
    assert.deepEqual((await tickProbe({ ...h.deps, maxAsks: 1 })).resumed, []);
    tabs = { deepseek: "tab_found", doubao: "tab_found" };
    h.clock.advance(10 * 60_000);
    const resumed = await tickProbe({ ...h.deps, maxAsks: 1 });
    assert.deepEqual(resumed.resumed, ["doubao"]);
    assert.deepEqual(resumed.paused, []);
  } finally {
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- one prober

test("the advisory lock keeps a second prober from asking at the same time", options, async () => {
  await reset();
  await seed("geo_d");
  const h = await harness({ answers: () => ({ answer: A_Q3, delayMs: 150 }) });
  const other = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  try {
    await enqueueRound(h.deps, { geoProjectId: "geo_d", kind: "sentinel" });
    // Held elsewhere: this worker asks nothing.
    await database.withClient(async (client) => {
      await client.query("SELECT pg_advisory_lock(hashtext('evimed_geo_probe'))");
      try {
        const held = await tickProbe({ ...h.deps, maxAsks: 3 });
        assert.equal(held.probe, "locked");
        assert.equal(held.asked, 0);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('evimed_geo_probe'))");
      }
    });
    assert.equal(h.probe.asks.length, 0);

    // Two workers, two pools, one moment: one asks, the other finds the lock.
    const second = { ...h.deps, store: new GeoMeasureStore(other), state: geoMeasureState() };
    const [left, right] = await Promise.all([tickProbe({ ...h.deps, maxAsks: 3 }), tickProbe({ ...second, maxAsks: 3 })]);
    assert.deepEqual([left.probe, right.probe].sort(), [null, "locked"].sort());
    assert.equal(left.asked + right.asked, 3);
    assert.equal(h.probe.maxInFlight, 1, "never two asks in flight");
  } finally {
    await other.close();
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- when and how much

test("big baseline rounds wait for the night window, small rounds do not, the weekly cap holds, and a busy probe backs off without spending attempts", options, async () => {
  await reset();
  await seed("geo_e");
  const h = await harness({ answers: () => ({ answer: A_Q3 }), clock: "2026-09-25T04:00:00Z" }); // noon in Shanghai
  try {
    const big = await enqueueRound(h.deps, { geoProjectId: "geo_e", kind: "baseline", repeat: 11 });
    assert.equal(big.planned, 66);
    const noon = await tickProbe({ ...h.deps, maxAsks: 5 });
    assert.equal(noon.asked, 0);
    assert.equal(noon.held.night, 66);
    assert.equal(h.probe.asks.length, 0);

    await enqueueRound(h.deps, { geoProjectId: "geo_e", kind: "confirm", questionIds: ["geo_e_q1"], engines: ["deepseek"], repeat: 2 });
    const small = await tickProbe({ ...h.deps, maxAsks: 5 });
    assert.equal(small.asked, 2, "a confirmation round runs any time");

    h.clock.set("2026-09-25T15:00:00Z"); // 23:00
    assert.equal((await tickProbe({ ...h.deps, maxAsks: 3 })).asked, 3);

    const capped = { ...h.deps, config: { ...h.config, geoWeeklyAskCap: 6 } };
    const cap = await tickProbe({ ...capped, maxAsks: 5 });
    assert.equal(cap.asked, 1, "the sixth ask of the week is the last");
    assert.ok(cap.held.cap > 0);
    // Next week the cap is fresh.
    h.clock.set("2026-09-28T15:00:00Z");
    assert.equal((await tickProbe({ ...capped, maxAsks: 2 })).asked, 2);

    // Busy: the job goes back unspent and the queue backs off.
    h.script.ask = () => ({ status: 409 });
    const busy = await tickProbe({ ...h.deps, maxAsks: 5 });
    assert.equal(busy.busy, 1);
    assert.equal(busy.asked, 0);
    assert.equal(busy.probe, "busy_backoff");
    const bounced = await rows(`SELECT attempts, status FROM evimed_geo.probe_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`);
    assert.deepEqual({ ...bounced[0] }, { attempts: 0, status: "queued" });
    const asksBefore = h.probe.asks.length;
    assert.equal((await tickProbe({ ...h.deps, maxAsks: 5 })).probe, "busy_backoff");
    assert.equal(h.probe.asks.length, asksBefore, "no ask inside the backoff");
    h.script.ask = () => ({ answer: A_Q3 });
    h.clock.advance(5_000);
    assert.equal((await tickProbe({ ...h.deps, maxAsks: 1 })).asked, 1);
  } finally {
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- Baidu through the inclusion channel

test("Baidu is measured through the inclusion channel: a snapshot without text, mention cells only, accuracy and citation not measurable", options, async () => {
  await reset();
  await seed("geo_f", { engines: ["deepseek", "baidu"] });
  /** @type {Map<string, number>} */
  const polls = new Map();
  /** @type {any[]} */
  const submitted = [];
  const inclusion = {
    engines: () => ["baidu"],
    submit: async (/** @type {any} */ task) => {
      submitted.push(task);
      return { requestId: `req_${task.thirdId}`, engine: task.engine };
    },
    poll: async (/** @type {string} */ engine, /** @type {string} */ requestId) => {
      const n = (polls.get(requestId) ?? 0) + 1;
      polls.set(requestId, n);
      return n === 1
        ? { engine, surface: { mode: "inclusion" }, status: "pending", hit: null, requestId }
        : { engine, surface: { mode: "inclusion" }, status: "valid", hit: true, keywordRes: "玛仕度肽", requestId, shareUrl: null, screenshotUrl: null };
    },
  };
  const h = await harness({ answers: () => ({ answer: A_RIGHT }), inclusion });
  try {
    const round = await enqueueRound(h.deps, { geoProjectId: "geo_f", kind: "baseline" });
    assert.deepEqual(round.engines, ["deepseek", "baidu"]);
    const first = await tickProbe({ ...h.deps, maxAsks: 10 });
    assert.equal(first.inclusion.submitted, 3);
    assert.equal(first.asked, 3);
    assert.deepEqual(submitted[0].keywords, ["玛仕度肽", "信尔美"]);
    h.clock.advance(61_000);
    assert.equal((await tickProbe(h.deps)).inclusion.polled, 3);
    h.clock.advance(61_000);
    const done = await tickProbe(h.deps);
    assert.equal(done.inclusion.done, 3);
    assert.equal(done.roundsFinished, 1);
    assert.equal(h.probe.asks.filter((ask) => ask.engine === "baidu").length, 0, "Baidu never reaches the probe host");
    const [inclusionSnapshot] = await rows(`SELECT answer_text, surface, status FROM evimed_geo.snapshots WHERE engine = 'baidu' LIMIT 1`);
    assert.equal(inclusionSnapshot.answer_text, null);
    assert.equal(inclusionSnapshot.surface.mode, "inclusion");

    assert.equal((await tickParse({ ...h.deps, maxParse: 20 })).parsed, 3, "only the probe's answers need the judge");
    await tickMetrics(h.deps);
    const cells = await rows(`SELECT metric_id, scope, engine, status, reason, numerator::float8 AS numerator, denominator::float8 AS denominator
      FROM evimed_geo.metrics WHERE round_id = $1 AND scope = 'engine' AND engine = 'baidu'`, [round.roundId]);
    assert.deepEqual(pick(cell(cells, { metric_id: "M-01" })), { numerator: 3, denominator: 3, status: "insufficient" });
    for (const metricId of ["M-06", "M-08", "M-10"]) {
      assert.deepEqual({ status: cell(cells, { metric_id: metricId }).status, reason: cell(cells, { metric_id: metricId }).reason },
        { status: "not_measurable", reason: "inclusion_channel" }, metricId);
    }

    // Without the channel, Baidu stays on the round and gets no jobs: 未测.
    const without = await enqueueRound({ ...h.deps, inclusion: null }, { geoProjectId: "geo_f", kind: "weekly" });
    assert.deepEqual(without.absentEngines, ["baidu"]);
    assert.equal(without.planned, 3);
  } finally {
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- noise and net effect

test("a noise round writes the noise bands, and the net effect is not computed before a follow-up or with too few clean controls", options, async () => {
  await reset();
  await seed("geo_g");
  const h = await harness({ answers: ({ question }) => ({ answer: question === Q3 ? A_Q3 : A_RIGHT }) });
  try {
    await enqueueRound(h.deps, { geoProjectId: "geo_g", kind: "baseline" });
    await tickProbe({ ...h.deps, maxAsks: 10 });
    await tickParse({ ...h.deps, maxParse: 20 });
    await tickMetrics(h.deps);

    const noise = await enqueueRound(h.deps, { geoProjectId: "geo_g", kind: "noise" });
    assert.equal(noise.planned, 30, "3 questions × 5 repeats × 2 engines");
    await tickProbe({ ...h.deps, maxAsks: 40 });
    await tickParse({ ...h.deps, maxParse: 40 });
    await tickMetrics(h.deps);
    const bands = await rows(`SELECT variant, status, value::float8 AS value, data_type FROM evimed_geo.metrics
      WHERE round_id = $1 AND metric_id = 'NOISE' ORDER BY variant`, [noise.roundId]);
    assert.deepEqual(bands.map((row) => [row.variant, row.status, row.value, row.data_type]), [
      ["M-01", "ok", 0, "derived"], ["M-03", "ok", 0, "derived"], ["M-10", "ok", 0, "derived"],
    ], "the same answers five times: a band of zero, measured");

    h.clock.advance(7 * 86_400_000);
    const weekly = await enqueueRound(h.deps, { geoProjectId: "geo_g", kind: "weekly" });
    await tickProbe({ ...h.deps, maxAsks: 10 });
    await tickParse({ ...h.deps, maxParse: 20 });
    await tickMetrics(h.deps);
    const net = await rows(`SELECT scope, pool, variant, status, reason, data_type FROM evimed_geo.metrics WHERE round_id = $1 AND metric_id = 'NET'`, [weekly.roundId]);
    assert.ok(net.length >= 9);
    assert.ok(net.every((row) => row.status === "not_measurable" && row.reason === "too_few_control_groups" && row.data_type === "derived"));
    assert.ok(net.some((row) => row.scope === "project" && row.variant === "M-19" && row.pool === null));
  } finally {
    await h.probe.close();
  }
});

// ---------------------------------------------------------------- a probe that is not there

test("an unconfigured probe is a wait, not an absence; an unreachable one fails its asks, is retried, and pauses", options, async () => {
  await reset();
  await seed("geo_i");
  const h = await harness({ answers: () => ({ answer: A_Q3 }) });
  try {
    const round = await enqueueRound(h.deps, { geoProjectId: "geo_i", kind: "sentinel" });
    const unconfigured = { ...h.deps, config: { ...h.config, geoProbeUrl: "" } };
    const waiting = await tickProbe(unconfigured);
    assert.equal(waiting.probe, "unconfigured");
    assert.equal(waiting.roundsFinished, 0);
    const [queued] = await rows(`SELECT status FROM evimed_geo.rounds WHERE id = $1`, [round.roundId]);
    assert.equal(queued.status, "queued", "the round waits for the probe; its engines are not marked absent");
    assert.ok(h.alerts.some((event) => event.kind === "geo_probe_unconfigured"));

    await h.probe.close();
    const down = await tickProbe({ ...h.deps, maxAsks: 10 });
    assert.equal(down.asked, 3);
    assert.equal(down.failed, 3);
    assert.equal(down.retried, 3);
    assert.ok(h.alerts.some((event) => event.kind === "geo_probe_host_down"));
    const failed = await rows(`SELECT status, warnings FROM evimed_geo.snapshots`);
    assert.ok(failed.every((row) => row.status === "failed" && row.warnings.includes("probe_error:geo_probe_unavailable")));
    assert.equal((await tickProbe({ ...h.deps, maxAsks: 10 })).probe, "host_paused");
    const jobs = await rows(`SELECT status, attempts FROM evimed_geo.probe_jobs WHERE round_id = $1 ORDER BY created_at`, [round.roundId]);
    assert.deepEqual(jobs.map((row) => [row.status, row.attempts]), [["queued", 1], ["queued", 1], ["queued", 1], ["queued", 0], ["queued", 0], ["queued", 0]]);
  } finally {
    await h.probe.close().catch(() => {});
  }
});

// ---------------------------------------------------------------- money

test("the judge stops when the module's daily budget is spent: answers wait unparsed, nothing is counted as zero", options, async () => {
  await reset();
  await seed("geo_h");
  await migrateUsageLedger(database);
  const user = `geo_budget_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'GEO budget','development')", [user]);
  const h = await harness({ answers: () => ({ answer: A_RIGHT }) });
  const rowId = randomUUID();
  try {
    await enqueueRound(h.deps, { geoProjectId: "geo_h", kind: "baseline" });
    await tickProbe({ ...h.deps, maxAsks: 10 });
    await database.query(`INSERT INTO evimed_usage.model_requests (id,user_id,project_id,model,price_version,currency,request_fingerprint,status,
        reserved_cost,actual_cost,reservation_expires_at,created_at,settled_at,purpose)
      VALUES ($1,$2,NULL,'deepseek-flash','test','CNY',$3,'settled',25,25,$4,$4,$4,'geo')`,
    [rowId, user, createHash("sha256").update(rowId).digest("hex"), h.clock.now().toISOString()]);
    const parsed = await tickParse({ ...h.deps, maxParse: 20 });
    assert.equal(parsed.skipped, "budget_exhausted");
    assert.equal(parsed.parsed, 0);
    assert.equal(h.model.calls.length, 0);
    assert.equal((await tickMetrics(h.deps)).rounds, 0, "a round with unread answers is not measured");
  } finally {
    await database.query("DELETE FROM evimed_usage.model_requests WHERE id = $1", [rowId]);
    await database.query("DELETE FROM evimed_control.users WHERE id = $1", [user]);
    await h.probe.close();
  }
});
