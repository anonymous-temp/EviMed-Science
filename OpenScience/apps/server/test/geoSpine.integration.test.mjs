// The question group as the spine of a GEO project (rectification 2026-10-14, G3): the clusters, the actions by group, the strategy
// page's one read, what a person is asked and the rail's counts — over HTTP, against the real service, store and DDL. One scenario,
// seeded straight into the tables: four groups (one a control), a baseline and a weekly round with their answers and rows, gaps
// and tiers written through the platform's own writer, and what came of them — a publication nobody cited, a link an engine did.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoService, compactAction } from "../src/geoService.mjs";
import { GeoMarketStore } from "../src/geoMarketStore.mjs";
import { previewOutlets } from "../src/geoMarket.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoRoutes } from "../src/geoRoutes.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { sendError } from "../src/security.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const run = randomBytes(4).toString("hex");
const ALICE = `alice-${run}`;
const MALLORY = `mallory-${run}`;
const NOW = new Date("2026-10-14T03:00:00.000Z");
const DAY = 86_400_000;
const ago = (/** @type {number} */ days) => new Date(NOW.getTime() - days * DAY).toISOString();

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
/** @type {GeoService} */
let service;
/** @type {http.Server | null} */
let server = null;
let base = "";
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {any} */
let geo = null;
const id = (/** @type {string} */ name) => `${name}-${run}`;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geospine");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  const config = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [], geoEngines: ["doubao", "deepseek"], geoTimeZone: "Asia/Shanghai",
    mediaMarketUrl: "", mediaMarketApiKeyFile: "" };
  service = new GeoService({ store, config, now: () => NOW });
  await service.ready();
  const auth = {
    async ensureSessionUser(/** @type {any} */ req) {
      const user = String(req.headers["x-test-user"] ?? "");
      if (!user) throw Object.assign(new Error("Authentication required."), { status: 401, code: "auth_required" });
      return { user: { id: user } };
    },
    async assertCsrf() {},
  };
  const audits = /** @type {any[]} */ ([]);
  const routes = createGeoRoutes({ store: auth, service, config, maxJsonBytes: 65_536,
    audit: async (event, status, details) => { audits.push({ event, status, ...details }); } });
  server = http.createServer(async (req, res) => {
    try {
      if (!(await routes(req, res))) { res.writeHead(404); res.end(); }
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    }
  });
  await new Promise((resolve) => server?.listen(0, "127.0.0.1", () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  geo = await seed();
});

after(async () => {
  if (server) await new Promise((resolve) => server?.close(() => resolve(undefined)));
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {string} method @param {string} route @param {{ user?: string, body?: unknown }} [request] */
async function call(method, route, { user = ALICE, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: /** @type {any} */ (await response.json()) };
}

/** @param {string} sql @param {unknown[]} values */
const q = (sql, values = []) => database.query(sql, values);

/**
 * The scenario. Groups: G1 (P2, no articles), G2 (P4, one article published 70 days ago and never cited), G3 (P1, an owned link an
 * engine cited), C1 (P2, a control group). Two rounds of the same set: a baseline and a weekly one.
 */
async function seed() {
  const created = await store.createProject({ userId: ALICE, projectId: id("proj"), engines: ["doubao", "deepseek"], coverageDays: 90,
    product: { brandName: "信尔美", genericName: "玛仕度肽注射液" } });
  const geoId = created.id;
  await q(`UPDATE evimed_geo.projects SET tier = '2', steps = $2::jsonb WHERE id = $1`, [geoId, JSON.stringify({
    evidence: { status: "done", requested: true }, questions: { status: "done", requested: true }, diagnosis: { status: "done", requested: true },
    sources: { status: "done", requested: true }, content: { status: "failed", requested: true } })]);
  await q(`INSERT INTO evimed_geo.question_sets (geo_project_id, version, user_id, locked_at, measured_count) VALUES ($1, 1, $2, now(), 8)`, [geoId, ALICE]);
  const groups = [["g1", "P2", "停药与反弹", 0.12, false], ["g2", "P4", "说明书安全题组", 0.06, false], ["g3", "P1", "品牌身份", 0.2, false], ["c1", "P2", "对照一", 0.1, true]];
  for (const [key, pool, name, weight, control] of groups) {
    await q(`INSERT INTO evimed_geo.question_groups (id, user_id, geo_project_id, set_version, pool, name, weight, is_control, journey_stage)
      VALUES ($1, $2, $3, 1, $4, $5, $6, $7, '疗效评估')`, [id(String(key)), ALICE, geoId, pool, name, weight, control]);
    for (const n of [1, 2]) {
      await q(`INSERT INTO evimed_geo.questions (id, user_id, geo_project_id, group_id, set_version, text, kind, pool, is_measured)
        VALUES ($1, $2, $3, $4, 1, $5, $6, $7, true)`, [id(`${key}q${n}`), ALICE, geoId, id(String(key)), `${name}的问题 ${n}`, n === 1 ? "real" : "typical", pool]);
    }
  }
  const rounds = [["r1", "baseline", "2026-09-25", 19], ["r2", "weekly", "2026-10-05", 9]];
  for (const [key, kind, day, daysAgo] of rounds) {
    await q(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, status, planned, done, sample_date, created_at, started_at, finished_at)
      VALUES ($1, $2, $3, $4, 1, ARRAY['doubao', 'deepseek'], 'done', 16, 16, $5::date, $6, $6, $6)`, [id(String(key)), ALICE, geoId, kind, day, ago(Number(daysAgo))]);
  }
  // answers: every question on both engines in both rounds; G1 is mentioned twice in the weekly round, G3's owned link is cited once
  let snapshot = 0;
  for (const [roundKey] of rounds) {
    for (const [key] of groups) {
      for (const n of [1, 2]) {
        for (const engine of ["doubao", "deepseek"]) {
          snapshot += 1;
          const cites = key === "g3" && roundKey === "r2" && engine === "deepseek" && n === 1;
          const mentioned = roundKey === "r2" && key === "g1" && n === 1;
          const wrong = key === "g3" && engine === "doubao" && n === 2;
          await q(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text, citations)
            VALUES ($1, $2, $3, $4, $5, $6, now(), 'valid', '答案', $7::jsonb)`, [id(`s${snapshot}`), ALICE, id(String(roundKey)), geoId, id(`${key}q${n}`), engine,
            JSON.stringify(cites ? [{ url: "https://mp.weixin.qq.com/s?__biz=ABC&mid=1&idx=1&sn=XYZ", domain: "mp.weixin.qq.com" }, { url: "https://dayi.org.cn/a", domain: "dayi.org.cn" }]
              : [{ url: "https://dayi.org.cn/a", domain: "dayi.org.cn" }])]);
          await q(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, mentions_ours, cites_ours, failure_mode) VALUES ($1, $2, $3, $4, $5, $6)`,
            [id(`s${snapshot}`), ALICE, geoId, mentioned, cites, wrong ? "wrong_ours" : mentioned ? "correct" : "omitted"]);
        }
      }
    }
  }
  // metric rows: the group scope (k of n), the pool scope the proxy reads, and the net effect
  const metric = (/** @type {string} */ round, /** @type {Record<string, any>} */ row) => q(`INSERT INTO evimed_geo.metrics (id, user_id, geo_project_id, round_id, scope,
      pool, group_id, metric_id, numerator, denominator, value, status, data_type, reason, noise_band, variant, computed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'measured', $13, $14, $15, now())`, [id(`m${Math.random().toString(16).slice(2)}`), ALICE, geoId, id(round),
    row.scope, row.pool ?? null, row.group ? id(row.group) : null, row.metric, row.k ?? null, row.n ?? null, row.value ?? null, row.status ?? "ok", row.reason ?? null,
    row.noise ?? null, row.variant ?? null]);
  await metric("r1", { scope: "group", group: "g1", pool: "P2", metric: "M-01", k: 0, n: 12, value: 0, status: "insufficient" });
  await metric("r2", { scope: "group", group: "g1", pool: "P2", metric: "M-01", k: 2, n: 14, value: 14.29, status: "insufficient" });
  await metric("r2", { scope: "group", group: "g3", pool: "P1", metric: "M-06", k: 70, n: 80, value: 87.5, status: "ok" });
  await metric("r2", { scope: "group", group: "g2", pool: "P4", metric: "M-15", k: 0, n: 40, value: 0, status: "ok" });
  await metric("r1", { scope: "pool", pool: "P2", metric: "M-01", k: 5, n: 60, value: 8.33, status: "ok" });
  await metric("r2", { scope: "pool", pool: "P2", metric: "M-01", k: 6, n: 60, value: 10, status: "ok" });
  await metric("r1", { scope: "project", metric: "M-19", value: 20, status: "ok" });
  await metric("r2", { scope: "project", metric: "M-19", value: 27, status: "ok" });
  await metric("r2", { scope: "project", metric: "NET", variant: "M-19", value: 4.2, status: "ok", reason: "up", noise: 3 });
  // the strategy and its tiers, through the platform's own writer
  const project = await store.getProject(ALICE, geoId);
  const write = (/** @type {string} */ what, /** @type {any} */ body) => geoRuntimeWrite({ store, project: /** @type {any} */ (project), what, body });
  await write("strategy", { data: {
    battlefield: { id: "BF-01", name: "说明书级事实讲准", why: ["P1 已有可见度"], action: "先出 6 篇事实稿", groups: [id("g3"), "停药与反弹"],
      secondary: [{ id: "BF-02", name: "安全题组", why: "红旗覆盖不足", groups: [id("g2")] }] },
    gaps: [
      { gapId: "GAP-01", groupId: id("g2"), class: "benefit_only", rank: 1, safetyPinned: true, handoff: "content", judgment: "就医红旗覆盖不全",
        consequence: { band: "高", basis: "健康后果" }, expectedPoints: [{ pointId: "EP-1", kind: "safety", statement: "出现过敏及时就医", refs: [{ type: "claim_id", id: id("claim1") }] }] },
      { gapId: "GAP-02", groupId: id("g1"), class: "dropped_condition", rank: 2, handoff: "content", judgment: "没提停药后的限定条件" },
      { gapId: "GAP-03", groupId: id("g3"), class: "wrong", rank: 3, handoff: "EC", judgment: "讲错", evidence: { errors: [id("e1")] } },
      { gapId: "GAP-04", groupId: id("c1"), class: "weak_source", handoff: "monitor_only", judgment: "对照组" },
      { gapId: "GAP-05", groupId: id("g3"), class: "missing_evidence", rank: 4, handoff: "content", judgment: "品牌身份缺说明书依据" },
    ],
    actions: [
      { gapId: "GAP-01", what: { layer: "qa", title: "哪些人不能用", channel: "wechat_mp" }, engines: ["deepseek"], promise: "coverage_complete",
        sources: [{ domain: "dayi.org.cn", why: "说明书原文所在" }], reason: "补禁忌与必须就医的情形" },
      { gapId: "GAP-02", reason: "与 GAP-03 的纠错稿合并处理" },
    ],
    expectations: [{ engine: "doubao", promise: "只承诺讲对", promiseCeiling: { value: "accuracy_only", basis: "检索触发率低" } },
      { engine: "deepseek", promise: "可以承诺被提及", promiseCeiling: { value: "mention_and_accuracy", basis: "检索触发率 90%" } }],
    layout: { layers: { anchor: ["nmpa.gov.cn"], coverage: ["dayi.org.cn"], owned: [] }, byEngine: [{ engine: "doubao", account: "抖音号", state: "未登记", evidence: "豆包自家生态" }],
      constraints: ["处方药只进专业渠道"], clientActions: ["开通并认证自有微信公众号", "登记自有抖音号"] },
    tiers: [{ tier: 2, name: "档二", summary: "讲准加进入被提及", buys: "12 个位次 + 14 篇稿件", notPromised: ["不承诺 P3 位次"], contentUnits: 14 }],
    assumptions: [{ field: "tier", value: 2, basis: "default", reason: "用户未指定", howToChange: "在方案页换一档" }],
    sources: [{ domain: "dayi.org.cn", name: "大医", kind: "vertical", layer: "coverage", icpMatches: true, newsIndexed: true, medicalVertical: true, checkedAt: "2026-09-25",
      evidence: "页脚备案号" }, { domain: "mp.weixin.qq.com", name: "微信公众号", kind: "wemedia", layer: "owned" }],
  } });
  await write("targets", { items: [
    { tier: "2", metricId: "M-19", pool: "all", baseline: 20, target: 35, dataType: "forecast", horizonWeeks: 12, placements: 12, budgetCny: 40000 },
    { tier: "2", metricId: "M-01S", pool: "all", baseline: 7, target: 12, dataType: "forecast", horizonWeeks: 12 },
    { tier: "2", metricId: "M-01", pool: "P2", baseline: 8, target: 15, dataType: "forecast", horizonWeeks: 12 },
    { tier: "2", metricId: "M-06", pool: "P1", baseline: 80, target: 98, dataType: "forecast", horizonWeeks: 12 },
    { tier: "2", metricId: "M-15", pool: "P4", baseline: 0, target: 0, dataType: "forecast", horizonWeeks: 12 },
    { tier: "1", metricId: "M-19", pool: "all", baseline: 20, target: 28, dataType: "forecast", horizonWeeks: 12 },
  ] });
  // what is being done: one article published seventy days ago and never cited (G2); an owned link an engine cited (G3)
  const [a2] = await store.registerArticles(ALICE, geoId, [{ path: "deliverables/geo-content/articles/safety.md", layer: "qa", title: "哪些人不能用", groupId: id("g2"),
    claimIds: [], gate: "passed", safety: "clear", contentSha256: "b".repeat(64), runId: "run_x", deliverableId: "geo-content", channel: "wechat_mp" }]);
  const [a3] = await store.registerArticles(ALICE, geoId, [{ path: "deliverables/geo-content/articles/brand.md", layer: "deep", title: "信尔美是什么药", groupId: id("g3"),
    claimIds: [], gate: "passed", safety: "open", contentSha256: "c".repeat(64), runId: "run_x", deliverableId: "geo-content" }]);
  await q(`UPDATE evimed_geo.articles SET status = 'published' WHERE id = $1`, [a2]);
  await q(`INSERT INTO evimed_geo.media (resource_id, media_type, name, domain, price_cny, available) VALUES ('res1', 'website', '大医', 'dayi.org.cn', 120, true)`);
  await q(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, media_type, resource_id, state, price_cny, published_url, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'website', 'res1', 'published', 120, 'https://dayi.org.cn/published', $5, $5)`, [id("o1"), ALICE, geoId, a2, ago(70)]);
  await q(`INSERT INTO evimed_geo.order_events (id, order_id, at, from_state, to_state, detail) VALUES ($1, $2, $3, 'accepted', 'published', '{}'::jsonb)`, [id("oe1"), id("o1"), ago(70)]);
  await q(`INSERT INTO evimed_geo.owned_links (id, user_id, geo_project_id, url, url_key, platform, title, published_at, article_id, group_id)
    VALUES ($1, $2, $3, $4, $5, 'wechat_mp', '信尔美是什么药', $6, $7, $8)`, [id("l1"), ALICE, geoId, "https://mp.weixin.qq.com/s?__biz=ABC&mid=1&idx=1&sn=XYZ",
    "mp.weixin.qq.com/s?__biz=ABC&mid=1&idx=1&sn=XYZ", ago(20), a3, id("g3")]);
  await q(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, first_snapshot_id, last_snapshot_id, statement, error_type, severity,
      status, claim_id, created_at)
    VALUES ($1, $2, $3, 'claimA', 'doubao', $4, $5, $5, '品牌身份讲错', 'number', 'S3', 'open', $6, $7),
           ($8, $2, $3, 'claimA', 'deepseek', $4, $5, $5, '品牌身份讲错', 'number', 'S3', 'open', $6, $7),
           ($9, $2, $3, 'claimB', 'doubao', $10, $5, $5, '又错', 'number', 'S2', 'open', $6, $7)`,
  [id("e1"), ALICE, geoId, id("g3q2"), id("s1"), id("claim1"), ago(8), id("e2"), id("e3"), id("g1q1")]);
  await q(`INSERT INTO evimed_geo.claims (id, user_id, geo_project_id, claim_key, version, statement, quote, source_ref, source_label, source_kind)
    VALUES ($1, $2, $3, 'C1', 1, '过敏者禁用', '对本品过敏者禁用', 'web-page:x', '说明书', 'label')`, [id("claim1"), ALICE, geoId]);
  return { geoId, a2, a3 };
}

test("the clusters list gives each group's reading as k of n and a state — no rate under the floor — and what stands beside it", options, async () => {
  const { status, payload } = await call("GET", `/api/geo/projects/${geo.geoId}/clusters`);
  assert.equal(status, 200);
  const view = payload.data;
  assert.deepEqual([view.version, view.locked, view.floor, view.round.kind], [1, true, 30, "weekly"]);
  assert.deepEqual(view.groups.map((/** @type {any} */ group) => group.name).sort(), ["停药与反弹", "品牌身份", "对照一", "说明书安全题组"].sort());
  const g1 = view.groups.find((/** @type {any} */ group) => group.id === id("g1"));
  assert.deepEqual([g1.mention.k, g1.mention.n, g1.mention.state], [2, 14, "thin"]);
  assert.equal(Object.hasOwn(g1.mention, "rate"), false, "a group's reading under 30 answers has no rate");
  assert.deepEqual([g1.questionCount, g1.measuredCount, g1.realCount, g1.realPhrasings.length], [2, 2, 1, 1]);
  assert.deepEqual(g1.byEngine.doubao, { answered: 2, mentioned: 1, wrong: 0 }, "counted over the latest full round's answers");
  assert.equal(g1.errors.open, 1);
  assert.equal(g1.isControl, false);
  const c1 = view.groups.find((/** @type {any} */ group) => group.id === id("c1"));
  assert.equal(c1.isControl, true);
  assert.equal(c1.actions.total, 0, "a control group has no action");
  const g3 = view.groups.find((/** @type {any} */ group) => group.id === id("g3"));
  assert.deepEqual(g3.errors, { open: 2, severe: 2, total: 2 });
  assert.equal(g3.byEngine.doubao.wrong, 1);
});

test("a cluster in full: its questions by engine, the sources its answers cite, its gaps with their points and claims, what is done and what came of it", options, async () => {
  const { status, payload } = await call("GET", `/api/geo/projects/${geo.geoId}/clusters/${id("g2")}`);
  assert.equal(status, 200);
  const view = payload.data;
  assert.equal(view.group.name, "说明书安全题组");
  assert.equal(view.questions.length, 2);
  assert.deepEqual(view.questions[0].answers.map((/** @type {any} */ answer) => answer.engine).sort(), ["deepseek", "doubao"]);
  assert.ok(view.questions[0].answers.every((/** @type {any} */ answer) => typeof answer.snapshotId === "string"));
  assert.deepEqual(view.sources.map((/** @type {any} */ source) => source.domain), ["dayi.org.cn"]);
  assert.equal(view.sources[0].cited.total, 4, "the latest round's four answers to this group's two questions, each citing it once");
  assert.equal(view.gaps.length, 1);
  assert.equal(view.gaps[0].expectedPoints[0].statement, "出现过敏及时就医");
  assert.equal(view.claims[id("claim1")].statement, "过敏者禁用", "the claims the expected points cite, resolved");
  assert.equal(view.actions[0].key, `fill_gap:${id("g2")}:benefit_only`);
  assert.equal(view.orders[0].state, "published");
  assert.ok(view.effect.events.some((/** @type {any} */ event) => event.kind === "published"));
  assert.deepEqual([view.effect.metricId, view.effect.series.map((/** @type {any} */ point) => [point.k, point.n, point.state])], ["M-15", [[0, 40, "enough"]]],
    "the series is of the metric the group's work is judged on");
  assert.equal((await call("GET", `/api/geo/projects/${geo.geoId}/clusters/ggr_nope`)).payload.code, "geo_cluster_not_found");
  assert.equal((await call("GET", `/api/geo/projects/${geo.geoId}/clusters/${id("g2")}`, { user: MALLORY })).status, 404, "another account's project reads as one that does not exist");
});

test("the actions are grouped by gap, with sources, the tier's target, k of n and a status the code derived", options, async () => {
  const { status, payload } = await call("GET", `/api/geo/projects/${geo.geoId}/actions`);
  assert.equal(status, 200);
  const view = payload.data;
  const byKey = Object.fromEntries(view.actions.map((/** @type {any} */ action) => [action.key, action]));
  assert.deepEqual(Object.keys(byKey).sort(), [`correct_error:${id("g3")}:wrong`, `correct_error:${id("g1")}:${id("e3")}`, `fill_gap:${id("g2")}:benefit_only`,
    `fill_gap:${id("g3")}:missing_evidence`, `win_cluster:${id("g1")}:M-01`].sort(), "G1's gap was answered with a reason and no action; its pool is short of the tier's target, so the next batch is its action");
  const safety = byKey[`fill_gap:${id("g2")}:benefit_only`];
  assert.deepEqual([safety.kind, safety.status], ["fill_gap", "stale"], "published seventy days ago, never cited: the orchestrator's rule, read here");
  assert.deepEqual(safety.what, { layer: "qa", title: "哪些人不能用", channel: "wechat_mp", channelNote: null });
  assert.deepEqual(safety.engines, ["deepseek"]);
  assert.equal(safety.expected.primaryMetricId, "M-15");
  assert.deepEqual([safety.expected.target, safety.expected.horizonWeeks, safety.expected.dataType, safety.expected.tier], [0, 12, "forecast", "2"]);
  assert.equal(safety.expected.promise, "coverage_complete");
  assert.equal(safety.need.expectedPoints.length, 1);
  assert.deepEqual(safety.sources.map((/** @type {any} */ source) => [source.domain, source.channel, source.chosen, source.available, source.route]),
    [["dayi.org.cn", null, "placed", true, "market"], [null, "wechat_mp", "recommended", true, "own"], ["nmpa.gov.cn", null, "recommended", null, "waiting_market"]],
    "the outlet its article was placed in (the three conditions the strategy checked hold), the brand's own channel its article names, then the layout's anchor "
    + "that nobody has checked and no market is connected to place at");
  const own = safety.sources[1];
  assert.deepEqual([own.name, own.kind, own.layer, own.price, own.origin, own.articleIds], ["微信公众号", "own_channel", "owned", null, "own_channel", safety.articleIds],
    "the brand publishes there itself and pastes the link");
  assert.equal(safety.articleIds.length, 1);
  const brand = byKey[`fill_gap:${id("g3")}:missing_evidence`];
  assert.equal(brand.status, "cited", "the owned link of G3's article was cited by an engine — direct evidence, by the page's address");
  assert.equal(brand.observed.citedBy.length, 1);
  assert.deepEqual([brand.observed.citedBy[0].engine, typeof brand.observed.citedBy[0].questionId], ["deepseek", "string"], "and the question whose answer cited it");
  assert.equal(byKey[`correct_error:${id("g3")}:wrong`].status, "proposed", "the group's error has no correction written yet");
  assert.deepEqual(byKey[`correct_error:${id("g3")}:wrong`].need.errorIds.sort(), [id("e1"), id("e2")].sort(), "an error is one claim told by two engines");
  assert.deepEqual(view.control.map((/** @type {any} */ group) => group.id), [id("c1")]);
  assert.deepEqual(view.noAction.map((/** @type {any} */ entry) => [entry.gapId, entry.reason]), [["GAP-02", "与 GAP-03 的纠错稿合并处理"], ["GAP-04", "control_group"]].sort(),
    "a gap answered with a reason alone has no action to list, and a control group's gap never does");
  assert.deepEqual(view.headline.arm, { netEffect: 4.2, verdict: "up", noiseBand: 3, comparable: true });
  assert.match(view.headline.sentence, /比对照多涨 4.2 个点（波动 ±3）/);
});

test("a person can skip an action or send it to another source, and take either back; nothing else is written", options, async () => {
  const key = `fill_gap:${id("g2")}:benefit_only`;
  const route = `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}`;
  const view = async () => (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data.actions.find((/** @type {any} */ action) => action.key === key);
  const skipped = await call("POST", `${route}/skip`, { body: {} });
  assert.deepEqual([skipped.status, skipped.payload.data.skipped, skipped.payload.data.cleared], [200, true, false]);
  assert.equal((await view()).status, "skipped");
  const swapped = await call("POST", `${route}/source`, { body: { domain: "https://WWW.kepuchina.cn/page" } });
  assert.deepEqual([swapped.payload.data.skipped, swapped.payload.data.sourceDomain], [true, "kepuchina.cn"], "the domain, never the page");
  const restored = await call("POST", `${route}/skip`, { body: { skipped: false } });
  assert.equal(restored.payload.data.skipped, false);
  const after = await view();
  assert.equal(after.status, "stale");
  assert.equal(after.sources[0].domain, "kepuchina.cn", "the swapped source leads");
  assert.equal(after.sources[0].chosen, "swapped");
  const cleared = await call("POST", `${route}/source`, { body: { domain: null } });
  assert.equal(cleared.payload.data.cleared, true);
  assert.equal((await view()).choice, null);
  // what cannot be decided
  assert.equal((await call("POST", `/api/geo/projects/${geo.geoId}/actions/fill_gap:${id("g2")}:missing_evidence/skip`, { body: {} })).payload.code, "geo_action_not_found");
  assert.equal((await call("POST", `${route}/source`, { body: { domain: "not a host" } })).payload.code, "geo_action_choice_invalid");
  assert.equal((await call("POST", `${route}/skip`, { body: { skipped: "yes" } })).payload.code, "geo_action_choice_invalid");
  assert.equal((await call("POST", `${route}/skip`, { body: {}, user: MALLORY })).status, 404);
  assert.equal((await call("GET", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent("bad key!")}`)).status, 404);
});

test("the strategy page's one read gives each target as baseline, now and target with the date of each, and the battlefield with its groups", options, async () => {
  const { status, payload } = await call("GET", `/api/geo/projects/${geo.geoId}/strategy`);
  assert.equal(status, 200);
  const view = payload.data;
  assert.deepEqual([view.version >= 1, view.chosenTier], [true, "2"]);
  assert.deepEqual([view.targets.baselineRound.sampleDate, view.targets.latestRound.sampleDate], ["2026-09-25", "2026-10-05"]);
  const index = view.targets.rows.find((/** @type {any} */ row) => row.metricId === "M-19" && row.pool === "all");
  assert.deepEqual([index.baseline.value, index.baseline.date, index.latest.value, index.latest.date, index.target, index.horizonWeeks, index.dueAt],
    [20, "2026-09-25", 27, "2026-10-05", 35, 12, "2026-12-18"]);
  assert.equal(index.name, "综合可见度指数");
  assert.equal(index.tiers["1"].target, 28);
  const mention = view.targets.rows.find((/** @type {any} */ row) => row.metricId === "M-01S");
  assert.equal(mention.name, "品类问题可见率", "one name for M-01S, not 品牌提及率");
  assert.equal(mention.baseline, null, "no row speaks for it: nothing is read as zero");
  assert.equal(view.battlefield.name, "说明书级事实讲准");
  assert.deepEqual(view.battlefield.groups.map((/** @type {any} */ group) => [group.id, group.name]), [[id("g3"), "品牌身份"], [id("g1"), "停药与反弹"]]);
  assert.equal(view.battlefield.secondary[0].why[0], "红旗覆盖不足", "a plain why is a list of one");
  assert.equal(view.battlefield.reason, "P1 已有可见度");
  assert.deepEqual(view.engines.map((/** @type {any} */ engine) => [engine.engine, engine.ceiling]), [["doubao", "accuracy_only"], ["deepseek", "mention_and_accuracy"]]);
  assert.equal(view.engines[0].layout.account, "抖音号");
  assert.deepEqual(view.layout.clientActions.map((/** @type {any} */ entry) => entry.done), [false, false]);
  assert.ok(view.layout.clientActions[0].key.startsWith("client:"));
  assert.equal(view.tiers.find((/** @type {any} */ tier) => tier.tier === "2").buys, "12 个位次 + 14 篇稿件");
  assert.equal(view.assumptions[0].field, "tier");
  assert.equal(view.noGo.length, 0);
});

test("the project view asks of its person only what is really theirs, and counts what each step produced", options, async () => {
  const { payload } = await call("GET", `/api/geo/projects/${geo.geoId}`);
  const view = payload.data;
  const kinds = view.needsYou.map((/** @type {any} */ item) => item.kind);
  assert.deepEqual(kinds, ["release_articles", "correct_severe_error", "client_action", "client_action", "step_failed"],
    "no budget is asked for where there is no market; the failed step is a real to-do; no completed step appears");
  assert.deepEqual(view.needsYou[0].object.ids, [geo.a3]);
  assert.equal(view.needsYou[1].object.id, id("e1"), "one row per claim: the earliest error of it");
  assert.equal(view.needsYou[4].object.id, "content");
  assert.deepEqual(view.steps.questions.summary, { text: "4 个群", count: 4, unit: "groups" });
  assert.deepEqual(view.steps.evidence.summary, { text: "1 条结论", count: 1, unit: "claims" });
  assert.equal(view.steps.journey.summary, null);
  assert.deepEqual(view.steps.content.summary, { text: "2 篇稿件", count: 2, unit: "articles" });
  assert.equal(view.overview.steps.questions.summary.count, 4);
  // a client to-do a person has done is gone from the list
  const key = view.needsYou.find((/** @type {any} */ item) => item.kind === "client_action").key;
  assert.equal((await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/skip`, { body: {} })).status, 200);
  const next = (await call("GET", `/api/geo/projects/${geo.geoId}`)).payload.data.needsYou.map((/** @type {any} */ item) => item.kind);
  assert.equal(next.filter((/** @type {string} */ kind) => kind === "client_action").length, 1);
});

test("the accuracy read gives each claim once, with the engines that say it, beside the rows it always had", options, async () => {
  const { payload } = await call("GET", `/api/geo/projects/${geo.geoId}/diagnosis`);
  const view = payload.data;
  assert.equal(view.errors.length, 3);
  assert.equal(view.byClaim.length, 2);
  const claim = view.byClaim.find((/** @type {any} */ row) => row.statement === "品牌身份讲错");
  assert.deepEqual([claim.engines.sort(), claim.count, claim.severity, claim.urgent], [["deepseek", "doubao"], 2, "S3", true]);
  assert.ok(view.errors.every((/** @type {any} */ row) => typeof row.fingerprint === "string"));
});

test("the runtime reads the same verdicts as the page: numbers equal, one function", options, async () => {
  const project = await store.getProject(ALICE, geo.geoId);
  const page = (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data;
  const read = await service.runtimeRead(/** @type {any} */ (project), "actions", {});
  assert.deepEqual(read.actions, page.actions.map(compactAction), "the model reads the page's actions, shortened");
  assert.deepEqual([read.headline, read.counts, read.tier], [page.headline, page.counts, page.tier]);
  const one = await service.runtimeRead(/** @type {any} */ (project), "actions", { groupId: id("g3") });
  assert.deepEqual(one.actions.map((/** @type {any} */ action) => action.key).sort(), [`correct_error:${id("g3")}:wrong`, `fill_gap:${id("g3")}:missing_evidence`].sort());
  const clusters = await service.runtimeRead(/** @type {any} */ (project), "clusters", { pool: "P2" });
  assert.deepEqual(clusters.groups.map((/** @type {any} */ group) => group.id).sort(), [id("c1"), id("g1")].sort());
  assert.ok(JSON.stringify(read).length < JSON.stringify(page).length, "shorter than the page's");
  // the numbers the model can quote: k, n and the target are the page's
  const compact = read.actions.find((/** @type {any} */ action) => action.key.startsWith("correct_error:") && action.key.includes(id("g1")));
  const full = page.actions.find((/** @type {any} */ action) => action.key === compact.key);
  assert.deepEqual([compact.expected.from, compact.expected.target], [full.expected.from, full.expected.target]);
});

test("a person pastes the address of a page the brand published: the run's own registration, so the re-tests that read the row pick it up", options, async () => {
  const route = `/api/geo/projects/${geo.geoId}/owned-links`;
  const created = await call("POST", route, { body: { url: "https://zhuanlan.zhihu.com/p/5551234?utm_source=x", platform: "zhihu", articleId: geo.a2 } });
  assert.equal(created.status, 201);
  const linkId = created.payload.data.id;
  assert.match(linkId, /^[A-Za-z0-9_-]+$/);
  const row = (await q(`SELECT platform, title, article_id, group_id, published_at, status, url_key FROM evimed_geo.owned_links WHERE id = $1`, [linkId])).rows[0];
  assert.deepEqual([row.platform, row.title, row.article_id, row.group_id, row.status], ["zhihu", "哪些人不能用", geo.a2, id("g2"), "active"],
    "the article gives its title and its group");
  assert.equal(new Date(row.published_at).toISOString(), NOW.toISOString(), "the day it went live is today unless the person says another");
  assert.equal(row.url_key.includes("utm_source"), false, "the page's key is the page's, not its tracking");

  // The action of that group now counts it, and is no longer stale: a new publication starts the wait again.
  const actions = (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data.actions;
  const safety = actions.find((/** @type {any} */ action) => action.key === `fill_gap:${id("g2")}:benefit_only`);
  assert.deepEqual(safety.ownedLinkIds, [linkId]);
  assert.equal(safety.status, "live");
  // The orchestrator's post-publication rounds read exactly this row (an active link with a group and a day it went live): its own
  // test registers through the same function this route calls and asserts the rounds (geoOrchestrator.integration.test.mjs).

  // The same page again is an update, never a second row.
  const again = await call("POST", route, { body: { url: "https://zhuanlan.zhihu.com/p/5551234", platform: "zhihu", articleId: geo.a2, title: "改了标题" } });
  assert.equal(again.status, 201);
  assert.equal((await q(`SELECT count(*)::int AS n FROM evimed_geo.owned_links WHERE geo_project_id = $1 AND url_key LIKE 'zhuanlan.zhihu.com%'`, [geo.geoId])).rows[0].n, 1);

  // What cannot be registered says why, and what is not the person's to do is refused.
  assert.equal((await call("POST", route, { body: { url: "not a page", platform: "zhihu", title: "x" } })).payload.code, "geo_owned_link_invalid");
  assert.equal((await call("POST", route, { body: { url: "https://baijiahao.baidu.com/s", platform: "baijiahao", title: "x" } })).payload.code, "geo_owned_link_invalid",
    "an address that names no single page");
  assert.equal((await call("POST", route, { body: { url: "https://example.com/a", platform: "nowhere", title: "x" } })).payload.code, "geo_owned_link_invalid");
  assert.equal((await call("POST", route, { body: { url: "https://example.com/a", platform: "zhihu" } })).payload.code, "geo_owned_link_invalid", "a title, or an article that has one");
  assert.equal((await call("POST", route, { body: { platform: "zhihu" } })).payload.code, "geo_owned_link_invalid");
  assert.equal((await call("POST", route, { body: { url: "https://example.com/a", platform: "zhihu", title: "x", extra: 1 } })).status, 400);
  assert.equal((await call("POST", route, { body: { url: "https://example.com/a", platform: "zhihu", title: "x" }, user: MALLORY })).status, 404);
});

test("what a person's choices do to the platform's choosers is the page's own verdict, read from the same actions", options, async () => {
  const project = /** @type {any} */ (await store.getProject(ALICE, geo.geoId));
  const key = `fill_gap:${id("g2")}:benefit_only`;
  const effects = async () => service.spine.choiceEffects(project);
  const before = await effects();
  assert.equal(before.skippedGroupIds.size + before.skippedArticleIds.size + before.skippedErrorIds.size, 0);
  // Skipped: the group's only content action, so the group and the article both its actions list are set aside.
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/skip`, { body: {} });
  const skipped = await effects();
  assert.equal(skipped.skippedGroupIds.has(id("g2")), true);
  assert.equal(skipped.skippedArticleIds.has(geo.a2), true);
  const page = (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data.actions;
  assert.equal(page.find((/** @type {any} */ action) => action.key === key).status, "skipped", "the page says what the choosers do");
  // A source sent to: preferred for the article, and not once the action is skipped.
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/skip`, { body: { skipped: false } });
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/source`, { body: { domain: "kepuchina.cn" } });
  assert.deepEqual((await effects()).preferredByArticle.get(geo.a2), ["kepuchina.cn"]);
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/skip`, { body: {} });
  assert.equal((await effects()).preferredByArticle.has(geo.a2), false);
  // Everything put back as it was.
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/skip`, { body: { skipped: false } });
  await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/source`, { body: { domain: null } });
  const restored = await effects();
  assert.equal(restored.skippedArticleIds.size + restored.preferredByArticle.size, 0);
});

test("with a market the sources carry its word on them: price, whether it would place there, and why not — and looking orders nothing", options, async () => {
  const market = new GeoMarketStore(database);
  await q(`UPDATE evimed_geo.media SET domain_verified = true, flags = '{}'::jsonb WHERE resource_id = 'res1'`);
  await q(`INSERT INTO evimed_geo.media (resource_id, media_type, name, domain, price_cny, available, domain_verified) VALUES ('res2', 'website', '科普中国', 'kepuchina.cn', 90, true, true)`);
  const before = (await q(`SELECT count(*)::int AS n FROM evimed_geo.orders WHERE geo_project_id = $1`, [geo.geoId])).rows[0].n;
  service.spine.placementPreview = (input) => previewOutlets({ store: market, market: { configured: true }, now: () => NOW, config: {} }, input);
  const configuredBefore = service.spine.marketConfigured;
  service.spine.marketConfigured = () => true;
  try {
    const key = `fill_gap:${id("g2")}:benefit_only`;
    const view = (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data.actions.find((/** @type {any} */ action) => action.key === key);
    const byDomain = Object.fromEntries(view.sources.filter((/** @type {any} */ source) => source.domain).map((/** @type {any} */ source) => [source.domain, source]));
    // dayi.org.cn is an outlet of the catalogue the three conditions hold for: placed there, its price is the market's.
    assert.deepEqual([byDomain["dayi.org.cn"].route, byDomain["dayi.org.cn"].price, byDomain["dayi.org.cn"].available], ["market", 120, true]);
    // nmpa.gov.cn is not an outlet of the catalogue: the platform cannot place there, and says so.
    assert.deepEqual([byDomain["nmpa.gov.cn"].route, byDomain["nmpa.gov.cn"].available], ["not_in_market", false]);
    assert.ok(byDomain["nmpa.gov.cn"].unavailableBecause.includes("not_in_catalogue"));
    // A person who sends the action to an outlet of the catalogue sees it listed first with its price, as the plan would take it.
    await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/source`, { body: { domain: "kepuchina.cn" } });
    const swapped = (await call("GET", `/api/geo/projects/${geo.geoId}/actions`)).payload.data.actions.find((/** @type {any} */ action) => action.key === key);
    assert.deepEqual([swapped.sources[0].domain, swapped.sources[0].chosen, swapped.sources[0].price, swapped.sources[0].route], ["kepuchina.cn", "swapped", 90, "market"]);
    await call("POST", `/api/geo/projects/${geo.geoId}/actions/${encodeURIComponent(key)}/source`, { body: { domain: null } });
    assert.equal((await q(`SELECT count(*)::int AS n FROM evimed_geo.orders WHERE geo_project_id = $1`, [geo.geoId])).rows[0].n, before, "no order was created by looking");
  } finally {
    service.spine.placementPreview = null;
    service.spine.marketConfigured = configuredBefore;
  }
});
