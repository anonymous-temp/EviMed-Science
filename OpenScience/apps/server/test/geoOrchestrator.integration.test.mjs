// 「循证传播」's orchestrator on PostgreSQL with everything around it faked —
// the dispatch of a run, a run finishing (by writing what a run writes through
// geo_write, then the ledger's completion), a round being enqueued and
// finishing, the inbox: the full program from nothing to monitoring, a single
// step's minimal path, the runtime cap, one run per project, retries, the
// schedules (weekly, sentinels, post-publication), the five notices once each,
// and a paused project.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore, normalizedSteps } from "../src/geoStore.mjs";
import { GeoOrchestrator } from "../src/geoOrchestrator.mjs";
import { createGeoNotifier } from "../src/geoNotify.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { HttpError } from "../src/security.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {ControlPlaneDatabase} */
let database;
/** @type {GeoStore} */
let store;
/** @type {pg.Client | null} */
let admin = null;
let isolatedName = "";

// Its own database: the orchestrator's tick reads every project, so a shared
// database would let it advance the other suites' projects.
before(async () => {
  if (!databaseUrl) return;
  const source = new URL(databaseUrl);
  isolatedName = `${decodeURIComponent(source.pathname.slice(1))}_geoorch_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  assert.match(isolatedName, /^evimed_test_[a-z0-9_]+$/);
  admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${isolatedName}"`);
  source.pathname = `/${isolatedName}`;
  database = new ControlPlaneDatabase({ databaseUrl: source.href, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  await database?.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${isolatedName}" WITH (FORCE)`);
    await admin.end();
  }
});

const ENGINES = ["doubao", "deepseek", "kimi"];
const sha = (/** @type {string} */ text) => createHash("sha256").update(text).digest("hex");
/** The run ledger's verdict on an article's deliverable, as the composition hands it to geo_write. */
const passedGate = async () => "passed";
/** @param {string} sql @param {unknown[]} [values] */
const q = async (sql, values = []) => (await database.query(sql, values)).rows;

/**
 * An orchestrator whose world is faked: dispatch records and answers (or
 * refuses, once per queued failure), rounds are inserted as the measurement
 * would, notices and citations are recorded.
 */
function harness({ at = null, geoStore = store } = /** @type {{ at?: string | null, geoStore?: GeoStore }} */ ({})) {
  /** @type {any[]} */ const dispatched = [];
  /** @type {any[]} */ const enqueued = [];
  /** @type {any[]} */ const notices = [];
  /** @type {any[]} */ const citations = [];
  /** @type {Error[]} */ const failures = [];
  let clock = at ? Date.parse(at) : null;
  const orchestrator = new GeoOrchestrator({
    store: geoStore, config: { geoTimeZone: "Asia/Shanghai", operatorUsers: ["ops"] },
    notifier: createGeoNotifier({ store, config: { operatorUsers: ["ops"] }, notifications: { async create(/** @type {string} */ userId, /** @type {any} */ input) {
      notices.push({ userId, ...input });
      return { id: `n${notices.length}` };
    } } }),
    dispatchRun: async (input) => {
      const failure = failures.shift();
      if (failure) throw failure;
      dispatched.push(input);
      return { runId: `run-${dispatched.length}-${input.dispatchId}`, sessionId: `session-${dispatched.length}`, status: "running" };
    },
    latestSessionId: async () => "session-latest",
    enqueueRound: async (spec) => {
      const project = (await q(`SELECT user_id, engines FROM evimed_geo.projects WHERE id = $1`, [spec.geoProjectId]))[0];
      const id = `gr_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await q(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, engines, planned, ref) VALUES ($1, $2, $3, $4, $5::text[], 10, $6::jsonb)`,
        [id, project.user_id, spec.geoProjectId, spec.kind, spec.engines ?? project.engines, JSON.stringify(spec.ref ?? null)]);
      enqueued.push({ id, ...spec });
      return { roundId: id, planned: 10 };
    },
    noteCitation: async (input) => { citations.push(input); return { matched: true }; },
    now: () => (clock == null ? new Date() : new Date(clock)),
  });
  return { orchestrator, dispatched, enqueued, notices, citations, failures, setClock: (/** @type {string} */ iso) => { clock = Date.parse(iso); } };
}

/** A GEO project of a fresh account. @param {string} [brand] */
async function newProject(brand = "玛仕度肽") {
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const project = await store.createProject({ userId, projectId: `p-${randomUUID().slice(0, 8)}`, engines: ENGINES, coverageDays: 90,
    product: { brandName: brand, genericName: "mazdutide" } });
  return { userId, project, user: { id: userId }, control: { userId, id: project.projectId } };
}

/** @param {string} id */
const reload = async (id) => {
  const row = /** @type {any} */ (await q(`SELECT steps, status FROM evimed_geo.projects WHERE id = $1`, [id]))[0];
  return { ...row, steps: normalizedSteps(row.steps) };
};
/** @param {string} id */
const statuses = async (id) => Object.fromEntries(Object.entries((await reload(id)).steps ?? {}).map(([step, value]) => [step, /** @type {any} */ (value).status]));

/** What a finished insight run wrote: claims, the journey, a locked question set (full or minimal). @param {any} project @param {{ minimal?: boolean }} [options] */
async function insightRunWrites(project, { minimal = false } = {}) {
  const current = await store.getProject(project.userId, project.id);
  await geoRuntimeWrite({ store, project: current, what: "claims", body: { items: [
    { claimKey: "dosing", statement: "每周一次皮下注射", quote: "本品每周一次皮下注射给药。", sourceRef: "说明书 2025 版", sourceKind: "label" },
  ] } });
  if (!minimal) await store.writeJourney(project.userId, project.id, { subtypes: ["肥胖"], stages: [] });
  /** @type {any[]} */
  const groups = [];
  const pools = ["P1", "P2", "P3", "P4"];
  const perGroup = minimal ? 3 : 4;
  const groupCount = minimal ? 10 : 12;
  for (let index = 0; index < groupCount; index += 1) {
    const pool = pools[index % 4];
    groups.push({ pool, name: `语义群${index + 1}`, typicalQuestion: `典型问句 ${index + 1}`, weight: groupCount - index,
      isControl: !minimal && index >= groupCount - 3,
      questions: Array.from({ length: perGroup }, (_, n) => ({ text: `问句 ${index + 1}-${n + 1}`, kind: "typical", isMeasured: true })) });
  }
  const written = await geoRuntimeWrite({ store, project: current, what: "questions", body: { data: { groups } } });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  const locked = await geoRuntimeWrite({ store, project: current, what: "lock_questions", body: { data: { minimal } } });
  assert.equal(locked.ok, true, JSON.stringify(locked.issues));
}

/** A round finished by the measurement, its metrics in. @param {string} roundId @param {{ finishedAt?: string }} [options] */
async function finishRound(roundId, { finishedAt, answers = 2, metrics = true } = /** @type {{ finishedAt?: string, answers?: number, metrics?: boolean }} */ ({})) {
  const round = (await q(`SELECT * FROM evimed_geo.rounds WHERE id = $1`, [roundId]))[0];
  await q(`UPDATE evimed_geo.rounds SET status = 'done', done = $3, sample_date = current_date, finished_at = coalesce($2::timestamptz, now()) WHERE id = $1`,
    [roundId, finishedAt ?? null, answers]);
  // The answers were asked when the round finished, on the test's clock. With
  // the database's now() they were asked "later" than any scenario dated
  // before the wall clock: from 2026-09-29T00:30Z the sentinel make-up test
  // found the baseline's answers newer than its skipped round and failed.
  for (let index = 0; index < answers; index += 1) {
    await q(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, engine, asked_at, status, answer_text)
      VALUES ($1, $2, $3, $4, 'deepseek', coalesce($5::timestamptz, now()), 'valid', '回答')`,
    [`s-${roundId}-${index}`, round.user_id, roundId, round.geo_project_id, finishedAt ?? null]);
  }
  if (metrics) await measured(roundId);
}

/** The measurement's metrics for a round. @param {string} roundId */
async function measured(roundId) {
  const round = (await q(`SELECT * FROM evimed_geo.rounds WHERE id = $1`, [roundId]))[0];
  await q(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, metric_id, status, value, numerator, denominator)
    VALUES ($1, $2, $3, $4, 'project', 'M-19', 'ok', 31.5, NULL, NULL)`, [`m-${roundId}`, round.user_id, round.geo_project_id, roundId]);
}

/** A program that wants the diagnosis and the strategy, its full question set locked. */
async function lockedProgram() {
  const world = harness();
  const made = await newProject();
  for (const step of ["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"]) {
    await store.setStep(made.project.id, step, { requested: true });
  }
  await insightRunWrites(made.project);
  for (const step of ["evidence", "journey"]) await store.setStep(made.project.id, step, { status: "done" });
  await world.orchestrator.advance(made.project.id);
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["baseline"]);
  return { world, ...made };
}

/** The ledger's completion of a dispatched run. @param {ReturnType<typeof harness>} world @param {any} control @param {number} index @param {string} status */
const finishRun = (world, control, index, status = "succeeded") => world.orchestrator.onRunFinished(control,
  { id: `run-${index + 1}-${world.dispatched[index].dispatchId}`, dispatchId: world.dispatched[index].dispatchId, status });

test("the full program, from nothing to monitoring: runs, rounds, schedules and the five notices, each once", options, async () => {
  const world = harness();
  const { project, control, userId } = await newProject();
  // 「完整方案」: every step requested.
  for (const step of ["evidence", "journey", "questions", "diagnosis", "sources", "content", "distribution", "monitoring"]) {
    await store.setStep(project.id, step, { requested: true });
  }

  // Steps 1–3: one insight run.
  let result = await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 1);
  assert.deepEqual([world.dispatched[0].capabilityId, world.dispatched[0].reason, world.dispatched[0].dispatchId, world.dispatched[0].projectId],
    ["geo-insight", "geo:evidence", "geo-insight-a1", project.projectId]);
  assert.match(world.dispatched[0].brief, /完整方案/);
  assert.equal(result.dispatched?.runId, `run-1-geo-insight-a1`);
  assert.deepEqual(await statuses(project.id), { evidence: "running", journey: "running", questions: "running", diagnosis: "none", sources: "none",
    content: "none", distribution: "none", monitoring: "none" });
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 1, "one run per project at a time");
  await insightRunWrites(project);
  assert.equal(await finishRun(world, control, 0), true);

  // Step 4: the baseline round (full set), then the noise round once.
  await world.orchestrator.advance(project.id);
  assert.deepEqual(world.enqueued.map((round) => [round.kind, round.ref.scheduleKey]), [["baseline", "round:diagnosis:v1"]]);
  let steps = await statuses(project.id);
  assert.deepEqual([steps.evidence, steps.journey, steps.questions, steps.diagnosis], ["done", "done", "done", "running"]);
  assert.equal(world.dispatched.length, 1, "no strategy before the diagnosis is in");
  await world.orchestrator.advance(project.id);
  assert.equal(world.enqueued.length, 1, "a round is enqueued once");
  await finishRound(world.enqueued[0].id, { finishedAt: "2026-09-20T12:00:00Z" });
  result = await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "done");
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["baseline", "noise"]);
  assert.equal(world.notices.filter((notice) => notice.title === "玛仕度肽：诊断完成").length, 1);

  // Step 5: the strategy run; three tiers → 三档目标出来了.
  assert.equal(world.dispatched.length, 2);
  assert.deepEqual([world.dispatched[1].capabilityId, world.dispatched[1].reason], ["geo-strategy", "geo:sources"]);
  const current = await store.getProject(userId, project.id);
  await geoRuntimeWrite({ store, project: current, what: "strategy", body: { data: { battlefield: { groups: ["语义群1", "语义群2"], reason: "检索强" } } } });
  await geoRuntimeWrite({ store, project: current, what: "targets", body: { items: ["1", "2", "3"].map((tier) => ({ tier, metricId: "M-01", pool: "all",
    baseline: 10, target: 10 + Number(tier) * 10, placements: 4 * Number(tier), budgetCny: 3000 * Number(tier), dataType: "forecast" })) } });
  await finishRun(world, control, 1);
  assert.equal((await statuses(project.id)).sources, "done");
  assert.equal(world.notices.filter((notice) => notice.title === "玛仕度肽：三档目标出来了").length, 1);

  // Step 6: the first content batch, battlefield groups first.
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 3);
  assert.equal(world.dispatched[2].capabilityId, "geo-content");
  assert.match(world.dispatched[2].brief, /语义群“语义群1”[\s\S]*语义群“语义群2”/);
  const claim = (await store.listClaims(project.id))[0];
  const set = await store.questionMap(project.id, 1);
  const battlefield = ["语义群1", "语义群2"].map((name) => set.find((group) => group.name === name));
  await geoRuntimeWrite({ store, project: current, what: "articles", articleGate: passedGate, body: { items: battlefield.map((group, index) => ({
    path: `deliverables/c1/articles/a${index}.md`, layer: "card", title: `稿件 ${index + 1}`, groupId: group.id, claimIds: [claim.id], gate: "passed",
    safety: "clear", contentSha256: sha(`a${index}`) })) } });
  await finishRun(world, control, 2);
  assert.equal((await statuses(project.id)).content, "done");
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 3, "the battlefield is covered: no second first-round batch");
  assert.equal(world.notices.filter((notice) => notice.title === "玛仕度肽：首批稿件可发布").length, 1);
  steps = await statuses(project.id);
  assert.deepEqual([steps.distribution, steps.monitoring], ["none", "running"], "no order yet; monitoring armed once the diagnosis is in");

  // Step 7 is the market's: a published order makes it done.
  const article = (await store.listArticles(project.id))[0];
  await q(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, media_type, resource_id, state, reserve_cny, price_cny, published_url)
    VALUES ($1, $2, $3, $4, 'website', 'r1', 'verified', 110, 100, 'https://news.example.com/a/1.html')`, [`o-${project.id}`, userId, project.id, article.id]);
  await q(`INSERT INTO evimed_geo.order_events (id, order_id, at, from_state, to_state, detail) VALUES ($1, $2, '2026-09-26T01:00:00Z', 'accepted', 'published', '{}'::jsonb)`,
    [`e-${project.id}`, `o-${project.id}`]);
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).distribution, "done");

  // 第一次被 AI 引用: an answer cites the published article.
  // Asked the day after the 09-26 publication, on a fixed date: "has this
  // engine answered since" is asked across projects, so an answer stamped
  // with the wall clock was newer than the sentinel test's 2026-09-29 rounds.
  await q(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, engine, asked_at, status, citations)
    VALUES ($1, $2, $3, $4, 'deepseek', '2026-09-27T01:00:00Z', 'valid', $5::jsonb)`, [`s-cite-${project.id}`, userId, world.enqueued[0].id, project.id,
    JSON.stringify([{ url: "https://news.example.com/a/1.html#top", domain: "news.example.com", title: "t", inBody: true }])]);
  await world.orchestrator.advance(project.id);
  assert.deepEqual(world.citations, [{ orderId: `o-${project.id}`, engine: "deepseek" }], "the market learns which engine cited which outlet");
  assert.equal(world.notices.filter((notice) => /^DeepSeek 第一次引用了《稿件 1》$/.test(notice.title)).length, 1);

  // 讲错我方: an S3 error found by a round.
  await q(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, statement, severity, status, last_snapshot_id)
    VALUES ($1, $2, $3, 'dosing', 'deepseek', '把玛仕度肽说成每天注射一次', 'S3', 'open', $4)`, [`err-${project.id}`, userId, project.id, `s-cite-${project.id}`]);
  await world.orchestrator.advance(project.id);
  const wrong = world.notices.filter((notice) => notice.title === "DeepSeek 把玛仕度肽说成每天注射一次");
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].severity, "safety");
  // …and, the battlefield being covered, the next first-round batch is its correction material.
  assert.equal(world.dispatched.length, 4);
  assert.deepEqual([world.dispatched[3].capabilityId, world.dispatched[3].dispatchId], ["geo-content", "geo-content-2-a1"]);
  assert.match(world.dispatched[3].brief, /纠错材料：DeepSeek 讲错“把玛仕度肽说成每天注射一次”/);
  assert.equal(world.dispatched[3].brief.includes("语义群“"), false);
  await geoRuntimeWrite({ store, project: current, what: "articles", articleGate: passedGate, body: { items: [{ path: "deliverables/c2/articles/fix.md", layer: "correction",
    title: "更正函", claimIds: [claim.id], gate: "passed", safety: "clear", contentSha256: sha("fix") }] } });
  await finishRun(world, control, 3);
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 4, "nothing left for the first round");

  // Step 8: Monday 03:10 in Shanghai (a week after the baseline) → the weekly round; 08:10 → the sentinels.
  await q(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, engine, metric_id, status, value, denominator) VALUES
    ($1, $2, $3, $4, 'engine', 'kimi', 'M-10', 'ok', 80, 40), ($5, $2, $3, $4, 'engine', 'doubao', 'M-10', 'ok', 62, 60),
    ($6, $2, $3, $4, 'engine', 'deepseek', 'M-10', 'ok', 50, 60)`,
  [`m10a-${project.id}`, userId, project.id, world.enqueued[0].id, `m10b-${project.id}`, `m10c-${project.id}`]);
  world.setClock("2026-10-04T19:10:00Z"); // Monday 2026-10-05 03:10 local
  let counts = await world.orchestrator.tickSchedules();
  assert.equal(counts.weekly, 1);
  assert.equal(counts.sentinel, 0, "07:59 has not come");
  const weekly = world.enqueued.find((round) => round.kind === "weekly");
  assert.deepEqual([weekly.ref.scheduleKey, weekly.ref.week, weekly.engines], ["weekly:2026-10-05", "2026-10-05", ENGINES]);
  counts = await world.orchestrator.tickSchedules();
  assert.equal(counts.weekly, 0, "one weekly round per week, whatever the ticks");
  world.setClock("2026-10-05T00:10:00Z"); // 08:10 local
  counts = await world.orchestrator.tickSchedules();
  assert.equal(counts.sentinel, 1);
  const sentinel = world.enqueued.find((round) => round.kind === "sentinel");
  assert.deepEqual([sentinel.ref.scheduleKey, sentinel.engines], ["sentinel:2026-10-05", ["kimi", "doubao"]], "the two highest retrieval rates");
  assert.equal(sentinel.questionIds, undefined, "the ten questions are the measurement's own pick");

  // The weekly round measured → the weekly report run, then the next round (no budget yet → skipped with its reason).
  await finishRound(weekly.id);
  await world.orchestrator.advance(project.id);
  steps = await statuses(project.id);
  assert.equal(steps.monitoring, "done");
  assert.equal((await reload(project.id)).steps.monitoring.note, "第 1 周");
  assert.equal(world.dispatched.length, 5);
  assert.deepEqual([world.dispatched[4].capabilityId, world.dispatched[4].reason, world.dispatched[4].dispatchId],
    ["geo-proposal", "geo:export-weekly", "geo-export-weekly-2026-10-05-a1"]);
  assert.match(world.dispatched[4].brief, /周报/);
  await finishRun(world, control, 4);
  await world.orchestrator.advance(project.id);
  const next = (await q(`SELECT state, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = 'run:content:w2026-10-05'`, [project.id]))[0];
  assert.deepEqual([next.state, next.detail.reason], ["skipped", "no_budget"], "groups need a budget; the weekly round did not see the error again");
  assert.equal(world.dispatched.length, 5);

  // Post-publication checks: weeks 1 and 2 after 2026-09-26 01:00Z.
  world.setClock("2026-10-03T02:00:00Z");
  await world.orchestrator.tickSchedules();
  const postpub = world.enqueued.filter((round) => round.kind === "post_publication");
  assert.deepEqual(postpub.map((round) => [round.ref.scheduleKey, round.ref.week, round.questionIds.length]),
    [[`postpub:${article.id}:w1`, 1, 4]], "the article's group's questions × the project's engines");
  assert.deepEqual(postpub[0].engines, ENGINES);

  // Idempotent: more ticks send nothing twice.
  for (let index = 0; index < 3; index += 1) {
    await world.orchestrator.advance(project.id);
    await world.orchestrator.tickSchedules();
  }
  const keys = world.notices.map((notice) => notice.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length, "no notice sent twice");
  assert.deepEqual(keys.sort(), [`geo:${project.id}:diagnosis:${world.enqueued[0].id}`, `geo:${project.id}:first-cited`,
    `geo:${project.id}:first-publishable`, `geo:${project.id}:targets:1`, `geo:wrong_ours:err-${project.id}:first`].sort(), "the five kinds, once each");
  assert.equal(world.enqueued.filter((round) => round.kind === "post_publication").length, 1);
  assert.equal(world.dispatched.length, 5);
});

test("a single step (信源分析与预期) builds only its minimal upstream: identity, 30 questions, one round, the strategy", options, async () => {
  const world = harness();
  const { project, control, user, userId } = await newProject("诺和盈");
  const answer = await world.orchestrator.runStep(user, project, "sources");
  assert.deepEqual(answer, { sessionId: "session-1", runId: "run-1-geo-insight-a1" }, "「让 AI 做」 answers the run it dispatched");
  const brief = world.dispatched[0].brief;
  assert.match(brief, /单步模式/);
  assert.match(brief, /共 30 个测量问句/);
  assert.match(brief, /minimal:true/);
  assert.equal(brief.includes("· 旅程"), false);
  let steps = await statuses(project.id);
  assert.deepEqual([steps.evidence, steps.journey, steps.questions, steps.sources], ["running", "none", "running", "queued"]);
  await insightRunWrites(project, { minimal: true });
  await finishRun(world, control, 0);
  steps = await statuses(project.id);
  assert.deepEqual([steps.evidence, steps.questions], ["minimal", "minimal"]);
  await world.orchestrator.advance(project.id);
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["single_step"]);
  await finishRound(world.enqueued[0].id);
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "minimal");
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["single_step"], "no noise round for a single step");
  assert.equal(world.dispatched[1].capabilityId, "geo-strategy");
  assert.match(world.dispatched[1].brief, /最小版/);
  const current = await store.getProject(userId, project.id);
  await geoRuntimeWrite({ store, project: current, what: "strategy", body: { data: { battlefield: { groups: ["语义群1"], reason: "x" } } } });
  await geoRuntimeWrite({ store, project: current, what: "targets", body: { items: ["1", "2", "3"].map((tier) => ({ tier, metricId: "M-01", pool: "all",
    target: 20, dataType: "forecast" })) } });
  await finishRun(world, control, 1);
  await world.orchestrator.advance(project.id);
  steps = await statuses(project.id);
  assert.deepEqual(steps, { evidence: "minimal", journey: "none", questions: "minimal", diagnosis: "minimal", sources: "minimal", content: "none",
    distribution: "none", monitoring: "none" });
  assert.equal(world.dispatched.length, 2, "nothing else was asked for");
  // Later, in the same project, the user asks for the full question map: the minimal version is redone.
  await world.orchestrator.runStep(user, project, "questions");
  assert.equal(world.dispatched.length, 3);
  assert.match(world.dispatched[2].brief, /锁定 40–120 个测量问句/);
  assert.equal(world.dispatched[2].dispatchId, "geo-insight-a2", "a new attempt, never the old run's id");
});

test("the runtime cap defers the dispatch to the next tick, with the same dispatch id; a failed run is retried once", options, async () => {
  const world = harness();
  const { project, control, user } = await newProject();
  world.failures.push(new HttpError(429, "runtime_limit_exceeded", "Too many running runtimes for this user."));
  const answer = await world.orchestrator.runStep(user, project, "evidence");
  assert.deepEqual(answer, { sessionId: "session-latest", runId: null }, "nothing dispatched: the latest conversation");
  assert.equal((await statuses(project.id)).evidence, "queued");
  const pending = (await q(`SELECT state, dispatch_id, attempts, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = 'run:insight'`,
    [project.id]))[0];
  assert.deepEqual([pending.state, pending.dispatch_id, pending.attempts, pending.detail.lastError], ["pending", "geo-insight-a1", 0, "runtime_limit_exceeded"]);
  assert.equal(world.orchestrator.status().lastDeferral, "runtime_limit_exceeded");
  await world.orchestrator.tick();
  assert.equal(world.dispatched.length, 1);
  assert.equal(world.dispatched[0].dispatchId, "geo-insight-a1", "the same id: a dispatch that did go through is found, never doubled");
  // One run per project: an export asked for meanwhile waits.
  const exported = await world.orchestrator.requestExport(user, project, "proposal");
  assert.equal(exported.runId, null);
  assert.equal(world.dispatched.length, 1);
  // The run fails having written nothing: its steps fail and it is tried once more (after the waiting export).
  await finishRun(world, control, 0, "failed");
  assert.equal((await statuses(project.id)).evidence, "failed");
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched[1].capabilityId, "geo-proposal", "the export asked for goes first");
  await finishRun(world, control, 1);
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched[2].dispatchId, "geo-insight-a2");
  await finishRun(world, control, 2, "failed");
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 3, "two tries, then the step waits for a person");
  await world.orchestrator.runStep(user, project, "evidence");
  assert.equal(world.dispatched[3].dispatchId, "geo-insight-a3", "asking again is two more tries");
  // A capability this deployment lacks fails the step instead of retrying every minute.
  const other = await newProject();
  world.failures.push(new HttpError(503, "geo_unavailable", "not installed"));
  await world.orchestrator.runStep(other.user, other.project, "evidence");
  assert.equal((await statuses(other.project.id)).evidence, "failed");
  await world.orchestrator.advance(other.project.id);
  assert.equal(world.dispatched.filter((entry) => entry.geoProjectId === other.project.id).length, 0);
});

test("a step the allowance refuses stays queued and says what it waits on; once the allowance allows it, the step runs and says nothing", options, async () => {
  const world = harness();
  const { project, user } = await newProject();
  const stepOf = async (/** @type {string} */ key) => (await q(`SELECT steps -> $2::text AS step FROM evimed_geo.projects WHERE id = $1`, [project.id, key]))[0].step;
  world.failures.push(new HttpError(402, "simulated_credits_exhausted", "The simulated allowance is too low."));
  await world.orchestrator.runStep(user, project, "evidence");
  const waiting = await stepOf("evidence");
  assert.equal(waiting.status, "queued", "not failed, and not started");
  assert.equal(waiting.waiting, "simulated_allowance");
  assert.equal(waiting.note, "等模拟额度");
  // The key stays pending, so the next tick asks again and the step starts by itself.
  await world.orchestrator.tick();
  assert.equal(world.dispatched.filter((entry) => entry.geoProjectId === project.id).length, 1);
  const started = await stepOf("evidence");
  assert.equal(started.status, "running");
  assert.equal(started.waiting, null);
  assert.equal(started.note, null);
  // The real wallet's refusal is the same wait, unmarked; any other deferral invents no wait.
  const other = await newProject();
  world.failures.push(new HttpError(402, "credits_exhausted", "This account holds 0 credits."));
  await world.orchestrator.runStep(other.user, other.project, "evidence");
  const real = (await q(`SELECT steps -> 'evidence' AS step FROM evimed_geo.projects WHERE id = $1`, [other.project.id]))[0].step;
  assert.deepEqual([real.status, real.waiting, real.note], ["queued", "allowance", "等科研额度"]);
  const third = await newProject();
  world.failures.push(new HttpError(429, "runtime_limit_exceeded", "Too many running runtimes for this user."));
  await world.orchestrator.runStep(third.user, third.project, "evidence");
  const busy = (await q(`SELECT steps -> 'evidence' AS step FROM evimed_geo.projects WHERE id = $1`, [third.project.id]))[0].step;
  assert.equal(busy.status, "queued");
  assert.equal(busy.waiting ?? null, null);
});

test("a baseline that measured no answer fails the diagnosis: no 「诊断完成」, no noise, no strategy; 「让 AI 做」 measures again", options, async () => {
  const { world, project, user } = await lockedProgram();
  const first = world.enqueued[0].id;
  // Every engine skipped: the round closes with nothing asked (metrics rows may still exist, all absent).
  await finishRound(first, { answers: 0 });
  await world.orchestrator.advance(project.id);
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "failed");
  const titles = world.notices.filter((notice) => notice.userId !== "ops").map((notice) => notice.title);
  assert.deepEqual(titles, ["玛仕度肽：诊断没有测到回答"], "a clear notice, never 「诊断完成」");
  assert.equal(world.notices.filter((notice) => notice.userId === "ops").length, 1, "operators are alerted once");
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["baseline"], "no noise round");
  assert.equal(world.dispatched.length, 0, "no strategy run");
  // 「让 AI 做」 on the diagnosis: a new baseline, not the empty one again.
  await world.orchestrator.runStep(user, project, "diagnosis");
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["baseline", "baseline"]);
  assert.notEqual(world.enqueued[1].id, first);
  assert.equal((await statuses(project.id)).diagnosis, "running");
  await finishRound(world.enqueued[1].id);
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "done");
  assert.equal(world.notices.filter((notice) => notice.title === "玛仕度肽：诊断完成").length, 1);
});

test("a diagnosis is done only when its metrics exist; past the grace operators are alerted and the program waits", options, async () => {
  const { world, project } = await lockedProgram();
  const round = world.enqueued[0].id;
  await finishRound(round, { metrics: false, finishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  for (let index = 0; index < 3; index += 1) await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "running", "no metrics, no diagnosis — whatever the clock says");
  assert.deepEqual(world.enqueued.map((entry) => entry.kind), ["baseline"]);
  assert.equal(world.dispatched.length, 0);
  assert.equal(world.notices.filter((notice) => notice.userId !== "ops").length, 0);
  const alerts = world.notices.filter((notice) => notice.userId === "ops");
  assert.equal(alerts.length, 1, "one operator alert, not one a tick");
  await measured(round);
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "done");
  assert.equal(world.dispatched[0].capabilityId, "geo-strategy");
});

test("a diagnosis marked done on a round with no answer (before this rule) is measured again on request", options, async () => {
  const { world, project, user } = await lockedProgram();
  const round = world.enqueued[0].id;
  await finishRound(round, { answers: 0 });
  await store.setStep(project.id, "diagnosis", { status: "done", roundId: round });
  await world.orchestrator.runStep(user, project, "diagnosis");
  assert.deepEqual(world.enqueued.map((entry) => entry.kind), ["baseline", "baseline"]);
  assert.equal((await statuses(project.id)).diagnosis, "running");
});

test("the sentinel engines come from the latest full measurement's retrieval rates, never a sentinel's own", options, async () => {
  const { world, project, userId } = await lockedProgram();
  const baseline = world.enqueued[0].id;
  await finishRound(baseline, { finishedAt: "2026-09-20T12:00:00Z" });
  await world.orchestrator.advance(project.id);
  assert.equal((await statuses(project.id)).diagnosis, "done");
  const later = `gr_sentinel_${project.id}`;
  await q(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, status, done, finished_at) VALUES ($1, $2, $3, 'sentinel', 'done', 4, now())`,
    [later, userId, project.id]);
  const rows = [[baseline, "kimi", 80, "2026-09-20T13:00:00Z"], [baseline, "doubao", 62, "2026-09-20T13:00:00Z"], [baseline, "deepseek", 50, "2026-09-20T13:00:00Z"],
    // A sentinel measured only two engines on ten questions; its rows are newer and must not choose.
    [later, "deepseek", 99, "2026-09-26T13:00:00Z"]];
  for (const [roundId, engine, value, at] of rows) {
    await q(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope, engine, metric_id, status, value, denominator, computed_at)
      VALUES ($1, $2, $3, $4, 'engine', $5, 'M-10', 'ok', $6, 40, $7)`, [`m10-${roundId}-${engine}`, userId, project.id, roundId, engine, value, at]);
  }
  world.setClock("2026-09-29T00:10:00Z"); // 08:10 in Shanghai
  await world.orchestrator.tickSchedules();
  // The schedule tick reads every project of the database: this test's own sentinel is the one.
  const sentinel = world.enqueued.find((entry) => entry.kind === "sentinel" && entry.geoProjectId === project.id);
  assert.deepEqual(sentinel?.engines, ["kimi", "doubao"]);
});

test("a paused project runs nothing new; 「让 AI 做」 says so", options, async () => {
  const world = harness();
  const { project, user, userId } = await newProject();
  await store.setStep(project.id, "evidence", { requested: true });
  await store.updateProject(userId, project.id, { status: "paused" });
  const result = await world.orchestrator.advance(project.id);
  assert.equal(result.paused, true);
  assert.equal(world.dispatched.length, 0);
  await assert.rejects(world.orchestrator.runStep(user, project, "evidence"), { status: 409, code: "geo_project_paused" });
  await assert.rejects(world.orchestrator.requestExport(user, project, "weekly"), { code: "geo_project_paused" });
  await assert.rejects(world.orchestrator.runStep({ id: "someone-else" }, project, "evidence"), { status: 404, code: "geo_project_not_found" });
});

test("a pause that lands while a tick is under way still holds the run it was about to dispatch", options, async () => {
  const world = harness();
  const { project, userId } = await newProject();
  await store.setStep(project.id, "evidence", { requested: true });
  // The tick's own reads of the project happen before the pause commits (as a
  // 暂停 clicked while the tick folds the last run); the dispatch comes after.
  const query = store.query.bind(store);
  let reads = 0;
  store.query = async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => {
    const rows = await query(sql, values);
    if (/^SELECT \* FROM evimed_geo\.projects WHERE id = \$1/.test(sql) && values?.[0] === project.id && ++reads === 2) {
      await query(`UPDATE evimed_geo.projects SET status = 'paused' WHERE id = $1`, [project.id]);
    }
    return rows;
  };
  try {
    const result = await world.orchestrator.advance(project.id);
    assert.equal(result.dispatched, null);
  } finally {
    store.query = query;
  }
  assert.equal(world.dispatched.length, 0, "nothing went out after the pause");
  assert.equal((await reload(project.id)).status, "paused");
  await store.updateProject(userId, project.id, { status: "active" });
  await world.orchestrator.advance(project.id);
  assert.equal(world.dispatched.length, 1, "and it goes out once the project is resumed");
});

test("a conversation that locks a set with nothing requested starts the program; the worker's leases and daily claims hold", options, async () => {
  const world = harness();
  const { project } = await newProject();
  // A map written in plain conversation is held to the full program's rules (geoProgramMinimal);
  // the conversation's run marks the steps it did (`geo_write step`), as its SKILL says.
  await insightRunWrites(project);
  for (const step of ["evidence", "journey"]) {
    const marked = await geoRuntimeWrite({ store, project: await store.getProject(project.userId, project.id), what: "step",
      body: { data: { step, status: "done" } } });
    assert.equal(marked.ok, true, JSON.stringify(marked.issues));
  }
  await world.orchestrator.advance(project.id);
  const steps = (await reload(project.id)).steps;
  assert.ok(Object.values(steps).every((step) => step.requested), "a full set locked in conversation is the full program");
  assert.deepEqual(world.enqueued.map((round) => round.kind), ["baseline"]);
  assert.equal(world.dispatched.length, 0, "steps 1–3 are done by the conversation; nothing to dispatch before the baseline");

  // Leases: a second holder is refused until the first lets go.
  const second = harness().orchestrator;
  /** @type {() => void} */
  let release = () => {};
  const held = world.orchestrator.leaseLoop("orders", () => new Promise((resolve) => { release = () => resolve("first"); }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await second.leaseLoop("orders", async () => "second"), { acquired: false });
  release();
  assert.deepEqual(await held, { acquired: true, value: "first" });
  assert.deepEqual(await second.leaseLoop("orders", async () => "second"), { acquired: true, value: "second" });
  assert.equal(await world.orchestrator.claimDay("reconcile", "2026-10-05"), true);
  assert.equal(await second.claimDay("reconcile", "2026-10-05"), false);
});

test("a sentinel that skipped a paused engine is asked again on that engine the same day, once the engine answers again; the first keeps its counts", options, async () => {
  const { world, project } = await lockedProgram();
  const baseline = world.enqueued[0].id;
  await finishRound(baseline, { finishedAt: "2026-09-20T12:00:00Z" });
  await world.orchestrator.advance(project.id);
  world.setClock("2026-09-29T00:10:00Z"); // 08:10 in Shanghai
  await world.orchestrator.tickSchedules();
  const sentinel = world.enqueued.find((entry) => entry.kind === "sentinel" && entry.geoProjectId === project.id);
  assert.ok(sentinel);
  const [engine] = sentinel.engines;
  const [question] = (await store.questionMap(project.id, 1))[0].questions;
  // The probe closed it with that engine paused: its asks skipped. "Has the
  // engine answered since" is asked across projects, and other tests in this
  // run leave answers stamped with the wall clock, so the round closes after
  // every answer already on file (a fixed 00:30 made this test fail from
  // 2026-09-29T00:30Z on, whenever it ran).
  // Computed in SQL: a JavaScript Date keeps milliseconds, the column keeps
  // microseconds, and a round-tripped time lands just before the answer it
  // was taken from.
  await q(`UPDATE evimed_geo.rounds SET status = 'partial', done = 0, failed = 1,
      finished_at = (SELECT greatest('2026-09-29T00:30:00Z'::timestamptz, coalesce(max(asked_at), 'epoch'::timestamptz))
        FROM evimed_geo.snapshots WHERE engine = $2)
    WHERE id = $1`, [sentinel.id, engine]);
  await q(`INSERT INTO evimed_geo.probe_jobs (id, user_id, round_id, geo_project_id, question_id, engine, status, error_code)
    VALUES ($1, $2, $3, $4, $5, $6, 'skipped', 'engine_paused')`, [`job-${sentinel.id}`, project.userId, sentinel.id, project.id, question.id, engine]);
  const makeUps = () => world.enqueued.filter((entry) => entry.kind === "sentinel" && entry.geoProjectId === project.id && entry.ref?.retryOf);
  world.setClock("2026-09-29T01:00:00Z");
  await world.orchestrator.tickSchedules();
  assert.equal(makeUps().length, 0, "not back yet: nothing is asked again");

  await q(`INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, engine, asked_at, status, surface) VALUES ($1, $2, $3, $4,
    (SELECT finished_at + interval '5 minutes' FROM evimed_geo.rounds WHERE id = $5), 'valid', '{"mode":"web"}'::jsonb)`,
  [`back-${project.id}`, project.userId, project.id, engine, sentinel.id]);
  world.setClock("2026-09-29T01:10:00Z");
  await world.orchestrator.tickSchedules();
  const [makeUp] = makeUps();
  assert.deepEqual([makeUp?.engines, makeUp?.questionIds, makeUp?.ref?.retryOf, makeUp?.ref?.day], [[engine], [question.id], sentinel.id, "2026-09-29"]);
  const [first] = await q(`SELECT status, done, failed FROM evimed_geo.rounds WHERE id = $1`, [sentinel.id]);
  assert.deepEqual({ ...first }, { status: "partial", done: 0, failed: 1 }, "the skipped round keeps its counts");
  await world.orchestrator.tickSchedules();
  assert.equal(makeUps().length, 1, "made once");
});

/** A published article of a project: its order, its publication, the URL an engine may cite. @param {{ project: any, userId: string }} made */
async function publishedArticle({ project, userId }) {
  await q(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, title, safety, status) VALUES ($1, $2, $3, '稿件 微秒', 'clear', 'published')`,
    [`a-${project.id}`, userId, project.id]);
  await q(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, media_type, resource_id, state, reserve_cny, price_cny, published_url)
    VALUES ($1, $2, $3, $4, 'website', 'r-ms', 'verified', 110, 100, $5)`, [`o-${project.id}`, userId, project.id, `a-${project.id}`,
    `https://news.example.com/${project.id}.html`]);
  await q(`INSERT INTO evimed_geo.order_events (id, order_id, at, from_state, to_state, detail) VALUES ($1, $2, '2026-09-26T01:00:00Z', 'accepted', 'published', '{}'::jsonb)`,
    [`e-${project.id}`, `o-${project.id}`]);
  return `https://news.example.com/${project.id}.html`;
}

test("the citation scan reads each answer once, to the microsecond, and the first citation is the one asked first", options, async () => {
  /** @type {string[][]} */
  const scans = [];
  // The store as the orchestrator sees it, with the citation scan's reads recorded.
  const spied = /** @type {GeoStore} */ (new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
      return async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => {
        const result = await target.query(sql, values);
        if (/FROM evimed_geo\.snapshots/.test(sql) && /jsonb_array_length\(citations\)/.test(sql)) scans.push(result.rows.map((/** @type {any} */ row) => String(row.id)));
        return result;
      };
    },
  }));
  const world = harness({ geoStore: spied });
  const made = await newProject();
  const url = await publishedArticle(made);
  // Three answers citing it, stored within one millisecond, microseconds
  // apart. Read into JavaScript the last one's time is .123, before its own
  // .123700, so the next scan read all three again. And Kimi's answer was
  // asked on a Tuesday, DeepSeek's on the Monday after: sorted by
  // `String(date)`, "Mon" came before "Tue" and the later answer was 「第一次」.
  const answer = (/** @type {string} */ id, /** @type {string} */ engine, /** @type {string} */ askedAt, /** @type {string} */ createdAt) => q(`INSERT INTO
    evimed_geo.snapshots (id, user_id, geo_project_id, engine, asked_at, status, citations, created_at) VALUES ($1, $2, $3, $4, $5, 'valid', $6::jsonb, $7)`,
  [id, made.userId, made.project.id, engine, askedAt, JSON.stringify([{ url, domain: "news.example.com", title: "t", inBody: true }]), createdAt]);
  await answer(`ms-a-${made.project.id}`, "deepseek", "2026-10-05T02:00:00Z", "2026-10-05T03:00:00.123100Z");
  await answer(`ms-b-${made.project.id}`, "kimi", "2026-09-29T02:00:00Z", "2026-10-05T03:00:00.123400Z");
  await answer(`ms-c-${made.project.id}`, "doubao", "2026-10-01T02:00:00Z", "2026-10-05T03:00:00.123700Z");
  await world.orchestrator.advance(made.project.id);
  assert.deepEqual(scans.at(-1), [`ms-a-${made.project.id}`, `ms-b-${made.project.id}`, `ms-c-${made.project.id}`]);
  assert.deepEqual(world.citations.map((citation) => citation.engine).sort(), ["deepseek", "doubao", "kimi"]);
  const cited = world.notices.filter((notice) => /第一次引用了/.test(notice.title));
  assert.deepEqual(cited.map((notice) => notice.title), ["Kimi 第一次引用了《稿件 微秒》"], "the answer asked first, not the first weekday in the alphabet");

  await world.orchestrator.advance(made.project.id);
  assert.deepEqual(scans.at(-1), [], "the next scan reads nothing the last one read");
  // One more answer stored at the very instant of the last one read: after it by id, so read.
  await answer(`ms-d-${made.project.id}`, "qianwen", "2026-10-05T02:30:00Z", "2026-10-05T03:00:00.123700Z");
  await world.orchestrator.advance(made.project.id);
  assert.deepEqual(scans.at(-1), [`ms-d-${made.project.id}`]);
  assert.equal(world.citations.length, 4);
});

test("a content run counts the articles written after its dispatch, not one written in the same millisecond before it", options, async () => {
  const world = harness();
  const made = await newProject();
  const { project, userId, control } = made;
  // The run's mark moved at .123456; an article from before, at .123100.
  // Read into JavaScript the mark's time is .123, and the older article
  // counted as this run's: the step read done for a run that wrote nothing.
  await q(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, title, safety, status, created_at, updated_at)
    VALUES ($1, $2, $3, '旧稿', 'clear', 'draft', '2026-09-29T00:00:00.123100Z', '2026-09-29T00:00:00.123100Z')`, [`old-${project.id}`, userId, project.id]);
  await q(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, run_id, dispatch_id, detail, created_at, updated_at)
    VALUES ($1, 'run:content:1', $2, 'run', 'running', 'run-ms', 'geo-content-ms', '{"purpose":"content"}'::jsonb,
      '2026-09-29T00:00:00.100000Z', '2026-09-29T00:00:00.123456Z')`, [project.id, userId]);
  assert.equal(await world.orchestrator.onRunFinished(control, { id: "run-ms", dispatchId: "geo-content-ms", status: "succeeded" }), true);
  assert.equal((await statuses(project.id)).content, "failed", "the run wrote no article");
  const [mark] = await q(`SELECT state, detail FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = 'run:content:1'`, [project.id]);
  assert.deepEqual([mark.state, mark.detail.articles], ["done", 0]);
});

test("a page the brand published itself gets the post-publication rounds a placement gets, on its group's questions; a retired one gets none", options, async () => {
  const world = harness();
  const made = await newProject();
  const { project } = made;
  await insightRunWrites(project);
  const [first, second] = await store.questionMap(project.id, 1);
  const current = await store.getProject(made.userId, project.id);
  const written = await geoRuntimeWrite({ store, project: current, what: "owned_links", body: { items: [
    { url: `https://www.zhihu.com/question/${project.id}/answer/1`, platform: "zhihu", title: "知乎回答", publishedAt: "2026-09-20T00:00:00Z", groupId: first.id },
    { url: `https://brand.example.com/${project.id}/news`, platform: "brand_site", title: "官网", publishedAt: "2026-09-20T00:00:00Z", groupId: second.id },
  ] } });
  const [live, retired] = written.registered;
  await geoRuntimeWrite({ store, project: current, what: "owned_links", body: { items: [{ id: retired, status: "retired" }] } });
  const mine = () => world.enqueued.filter((entry) => entry.geoProjectId === project.id && entry.kind === "post_publication");

  world.setClock("2026-09-26T12:00:00Z");
  await world.orchestrator.tickSchedules();
  assert.equal(mine().length, 0, "a week has not passed");
  world.setClock("2026-09-27T01:00:00Z");
  await world.orchestrator.tickSchedules();
  const [week1] = mine();
  assert.deepEqual([week1?.ref?.ownedLinkId, week1?.ref?.week, week1?.engines], [live, 1, ENGINES]);
  const groupQuestions = first.questions.map((/** @type {any} */ question) => question.id).sort();
  assert.deepEqual([...week1.questionIds].sort(), groupQuestions.slice(0, 10), "its group's questions");
  await world.orchestrator.tickSchedules();
  assert.equal(mine().length, 1, "once per checkpoint");
  const marks = await q(`SELECT key FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND starts_with(key, 'postpub:') ORDER BY key`, [project.id]);
  assert.deepEqual(marks.map((row) => row.key), [`postpub:owned:${live}:w1`], "the retired link has no checkpoint at all");

  // Retired after its first round: nothing more is asked about it.
  await geoRuntimeWrite({ store, project: current, what: "owned_links", body: { items: [{ id: live, status: "retired" }] } });
  world.setClock("2026-10-04T01:00:00Z");
  await world.orchestrator.tickSchedules();
  assert.equal(mine().length, 1);
});
