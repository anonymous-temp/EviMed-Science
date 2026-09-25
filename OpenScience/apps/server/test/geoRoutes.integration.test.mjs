// Every `/api/geo/*` route over HTTP, against the real service, store and DDL:
// the shapes of build spec §3 built from rows, another account's project read
// as one that never existed, the write-side hooks delegated or 503, and the
// runtime's writes (geo_write) landing where the pages read them.
//
// Its own database (test/helpers/geoTestDatabase.mjs), and every account and
// platform row id carries this run's suffix besides.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoService, geoScreenshotPath } from "../src/geoService.mjs";
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

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
/** @type {GeoService} */
let service;
/** @type {string} */
let dataDir = "";
/** @type {http.Server | null} */
let server = null;
let base = "";
/** The hooks the other packages attach; each test sets what it needs. */
const hooks = { orchestrator: /** @type {any} */ (null), market: /** @type {any} */ (null), exporter: /** @type {any} */ (null) };
const audits = /** @type {any[]} */ ([]);
let projectCounter = 0;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

const run = randomBytes(4).toString("hex");
/** Accounts unique to this run. */
const ALICE = `alice-${run}`;
const MALLORY = `mallory-${run}`;
const OPS = `ops-${run}`;
const config = {
  geoEnabled: true, geoAudience: "all", operatorUsers: [OPS], geoPreviewUsers: [], geoEngines: ["doubao", "deepseek", "kimi"],
  geoTimeZone: "Asia/Shanghai", geoSocialUrl: "", mediaMarketUrl: "", mediaMarketApiKeyFile: "",
};

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "georoutes");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-routes-"));
  store = new GeoStore({ database });
  service = new GeoService({ store, config: { ...config, dataDir }, now: () => new Date() });
  await service.ready();
  // The platform's own authentication, reduced to what the routes ask of it:
  // the account is the one the test names in a header.
  const auth = {
    async ensureSessionUser(/** @type {any} */ req) {
      const id = String(req.headers["x-test-user"] ?? "");
      if (!id) throw Object.assign(new Error("Authentication required."), { status: 401, code: "auth_required" });
      return { user: { id } };
    },
    async assertCsrf() {},
  };
  const routes = createGeoRoutes({
    store: auth, service, config, maxJsonBytes: 65_536,
    audit: async (event, status, details) => { audits.push({ event, status, ...details }); },
    projects: {
      create: async (_user, name) => ({ id: `p-${++projectCounter}`, name }),
      bindSession: async () => ({ sessionId: "geo-session-1", bound: true }),
      latestSessionId: async () => "geo-session-1",
    },
    get orchestrator() { return hooks.orchestrator; },
    get market() { return hooks.market; },
    get exporter() { return hooks.exporter; },
  });
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
});

after(async () => {
  if (server) await new Promise((resolve) => server?.close(() => resolve(undefined)));
  if (database) await database.close();
  await isolated?.drop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** @param {string} method @param {string} route @param {{ user?: string, body?: unknown }} [options] */
async function call(method, route, { user = ALICE, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, payload, headers: response.headers };
}

/** @param {{ status: number, payload: any }} answer @param {number} status @param {string} code */
function refused(answer, status, code) {
  assert.equal(answer.status, status, JSON.stringify(answer.payload));
  assert.equal(answer.payload?.error?.code ?? answer.payload?.code, code, JSON.stringify(answer.payload));
}

/** A project of alice's with a runtime-written product, claims, locked question map, strategy, targets and articles. */
async function seededProject() {
  const created = await call("POST", "/api/geo/projects", { body: { brandName: "玛仕度肽", coverageDays: 90, engines: ["doubao", "deepseek", "kimi"] } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const project = await store.getProject(ALICE, created.payload.data.id);
  assert.ok(project);
  // The run ledger's verdict on the deliverable, as the composition hands it in: passed.
  const write = (/** @type {string} */ what, /** @type {Record<string, any>} */ body) =>
    geoRuntimeWrite({ store, project, what, body, articleGate: async () => "passed" });
  await write("product", { data: { genericName: "玛仕度肽注射液", rx: "rx", competitors: [{ brandName: "替尔泊肽", reason: "同适应证" }] } });
  const claims = await write("claims", { items: [
    { claimKey: "dose", statement: "每周皮下注射一次", quote: "本品每周一次皮下注射。", sourceRef: "说明书 2024 版", sourceKind: "label", inLabel: true },
    { claimKey: "indication", statement: "用于成人肥胖", quote: "适用于成人肥胖或超重患者的长期体重管理。", sourceRef: "说明书 2024 版", sourceKind: "label" },
  ] });
  const groups = [];
  const pools = ["P1", "P2", "P3", "P4"];
  for (let index = 0; index < 12; index += 1) {
    groups.push({
      pool: pools[index % 4], name: `语义群 ${index + 1}`, typicalQuestion: `典型问句 ${index + 1}`, isControl: index % 4 === 1,
      questions: Array.from({ length: 4 }, (_unused, q) => ({ text: `问句 ${index + 1}-${q + 1}`, kind: "real", platform: "xhs", isMeasured: true })),
    });
  }
  const questions = await write("questions", { data: { groups } });
  const lock = await write("lock_questions", { data: {} });
  assert.equal(lock.ok, true, JSON.stringify(lock.issues));
  await write("strategy", { data: {
    battlefield: { groups: ["语义群 2"], reason: "证据最硬" },
    expectations: [{ engine: "deepseek", promise: "讲对，不承诺提及", layers: ["anchor", "coverage"] }],
    sources: [{ domain: "www.39.net", name: "39 健康网", kind: "vertical", layer: "coverage", icpMatches: true, newsIndexed: true, medicalVertical: true }],
  } });
  await write("targets", { items: ["1", "2", "3"].flatMap((tier) => [
    { tier, metricId: "M-19", baseline: 20, target: 20 + Number(tier) * 5, placements: 5 * Number(tier), budgetCny: 1_000 * Number(tier), dataType: "forecast" },
  ]) });
  const articles = await write("articles", { items: [
    { path: "deliverables/geo-content/articles/card-1.md", layer: "card", title: "玛仕度肽怎么用", groupId: questions.ids[0], claimIds: [claims.ids[0]],
      safety: "clear", contentSha256: "a".repeat(64) },
    { path: "deliverables/geo-content/articles/popular-1.md", layer: "popular", title: "减重针能停吗", groupId: questions.ids[1], claimIds: [claims.ids[1]],
      safety: "open", contentSha256: "b".repeat(64) },
  ] });
  return { project, claims, questions, articles };
}

test("off, every GEO path answers 404 geo_not_enabled, and an account outside the audience gets the same", options, async () => {
  const off = createGeoRoutes({ store: { async ensureSessionUser() { return { user: { id: ALICE } }; }, async assertCsrf() {} },
    service, config: { ...config, geoEnabled: false }, maxJsonBytes: 1024 });
  const res = { writeHead() {}, end() {} };
  await assert.rejects(off(/** @type {any} */ ({ url: "/api/geo/projects", method: "GET", headers: {} }), res), { status: 404, code: "geo_not_enabled" });
  const noService = createGeoRoutes({ store: {}, service: null, config, maxJsonBytes: 1024 });
  await assert.rejects(noService(/** @type {any} */ ({ url: "/api/geo/projects", method: "GET", headers: {} }), res), { code: "geo_not_enabled" });
  assert.equal(await off(/** @type {any} */ ({ url: "/api/geox", method: "GET", headers: {} }), res), false, "not this factory's path");
  const operatorsOnly = new GeoService({ store, config: { ...config, geoAudience: "operators" } });
  const narrow = createGeoRoutes({ store: { async ensureSessionUser() { return { user: { id: ALICE } }; }, async assertCsrf() {} },
    service: operatorsOnly, config, maxJsonBytes: 1024 });
  await assert.rejects(narrow(/** @type {any} */ ({ url: "/api/geo/projects", method: "GET", headers: {} }), res), { code: "geo_not_enabled" });
});

test("creating a project makes the control-plane project, its GEO row and a bound conversation; validation refuses by name", options, async () => {
  const created = await call("POST", "/api/geo/projects", { body: { brandName: "司美格鲁肽" } });
  assert.equal(created.status, 201);
  assert.match(created.payload.data.id, /^geo_[0-9a-f]{32}$/);
  assert.equal(created.payload.data.sessionId, "geo-session-1");
  assert.equal(created.payload.data.bound, true);
  const listed = (await call("GET", "/api/geo/projects")).payload.data.projects.find((/** @type {any} */ row) => row.id === created.payload.data.id);
  assert.equal(listed.name, "司美格鲁肽");
  assert.deepEqual(listed.engines, ["doubao", "deepseek", "kimi"], "the deployment's engines when none are given");
  assert.equal(listed.coverageDays, 90);
  assert.deepEqual(listed.headline.gvi, { value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "absent",
    dataType: "measured", reason: null, target: null, trend: [] }, "an unmeasured number is absent, never zero");
  assert.deepEqual(listed.alert, { wrongOurs: 0, safety: 0, text: null });
  assert.ok(audits.some((entry) => entry.event === "geo.project.create" && entry.code === created.payload.data.id));
  const unnamed = await call("POST", "/api/geo/projects", { body: {} });
  assert.equal(unnamed.status, 201);
  assert.equal((await call("GET", `/api/geo/projects/${unnamed.payload.data.id}`)).payload.data.name, "新 GEO 项目");

  refused(await call("POST", "/api/geo/projects", { body: { brandName: "x".repeat(41) } }), 400, "geo_brand_name_invalid");
  refused(await call("POST", "/api/geo/projects", { body: { engines: ["bing"] } }), 400, "geo_engines_invalid");
  refused(await call("POST", "/api/geo/projects", { body: { engines: ["kimi", "kimi"] } }), 400, "geo_engines_invalid");
  refused(await call("POST", "/api/geo/projects", { body: { coverageDays: 3 } }), 400, "geo_coverage_invalid");
  refused(await call("POST", "/api/geo/projects", { body: { brandName: "a", tier: "1" } }), 400, "geo_payload_invalid");
});

test("the project page, its tabs and its actions answer in the spec's shapes from the rows the runtime wrote", options, async () => {
  const { project, claims, questions, articles } = await seededProject();
  const id = project.id;

  const page = (await call("GET", `/api/geo/projects/${id}`)).payload.data;
  assert.equal(page.sessionId, "geo-session-1");
  assert.equal(page.name, "玛仕度肽");
  assert.deepEqual(page.overview.metrics.map((/** @type {any} */ entry) => entry.key), ["gvi", "mention", "accuracy", "citation"]);
  assert.equal(page.overview.metrics[0].target, 30, "the chosen tier's (2) target");
  assert.equal(page.overview.steps.questions.status, "done", "locking the set marked the step");
  assert.ok(page.overview.week.some((/** @type {any} */ item) => item.kind === "safety" && item.tab === "content"));

  const evidence = (await call("GET", `/api/geo/projects/${id}/evidence`)).payload.data;
  assert.equal(evidence.product.genericName, "玛仕度肽注射液");
  assert.equal(evidence.product.brandName, "玛仕度肽", "the brand given at creation stays");
  assert.equal(evidence.competitors[0].brandName, "替尔泊肽");
  assert.deepEqual(evidence.claims.map((/** @type {any} */ claim) => claim.id), claims.ids);
  assert.deepEqual(Object.keys(evidence.claims[0]).sort(), ["evidenceLevel", "id", "inLabel", "population", "quote", "sourceKind", "sourceLabel", "sourceRef",
    "statement", "status", "validUntil", "verifiedAt"]);

  const map = (await call("GET", `/api/geo/projects/${id}/questions`)).payload.data;
  assert.equal(map.version, 1);
  assert.equal(map.sets[0].measuredCount, 48);
  assert.ok(map.sets[0].lockedAt);
  assert.equal(map.groups.length, 12);
  assert.deepEqual(Object.keys(map.groups[0].questions[0]).sort(), ["id", "isMeasured", "kind", "platform", "sourceUrl", "text"]);
  const target = map.groups[0].questions[0].id;
  const moved = (await call("POST", `/api/geo/projects/${id}/questions/${target}/unmeasure`, { body: {} })).payload.data;
  assert.equal(moved.version, 2);
  const second = (await call("GET", `/api/geo/projects/${id}/questions`)).payload.data;
  assert.equal(second.version, 2);
  assert.equal(second.sets[0].measuredCount, 47);
  assert.ok(second.sets[0].lockedAt, "a copy of a locked set is locked");
  assert.equal(second.groups[0].questions[0].isMeasured, false);
  assert.equal((await call("GET", `/api/geo/projects/${id}/questions?version=1`)).payload.data.groups[0].questions[0].isMeasured, true, "version 1 is unchanged");
  refused(await call("GET", `/api/geo/projects/${id}/questions?version=0`), 400, "geo_version_invalid");
  refused(await call("GET", `/api/geo/projects/${id}/questions?version=9`), 404, "geo_version_invalid");
  refused(await call("POST", `/api/geo/projects/${id}/questions/gq_missing/unmeasure`, { body: {} }), 404, "geo_question_not_found");
  // Only the latest set's questions: taking a question out of version 1 now would fork an old set.
  const stale = map.groups[1].questions[0].id;
  refused(await call("POST", `/api/geo/projects/${id}/questions/${stale}/unmeasure`, { body: {} }), 409, "geo_question_not_current");
  assert.equal((await call("GET", `/api/geo/projects/${id}/questions`)).payload.data.version, 2, "nothing was written");
  // A locked set that would fall below the lock rule is not written: 47 → 40 is fine, 39 is not.
  for (let remaining = 47; remaining > 40; remaining -= 1) {
    const latest = (await call("GET", `/api/geo/projects/${id}/questions`)).payload.data;
    const next = latest.groups.flatMap((/** @type {any} */ group) => group.questions).find((/** @type {any} */ question) => question.isMeasured);
    assert.equal((await call("POST", `/api/geo/projects/${id}/questions/${next.id}/unmeasure`, { body: {} })).status, 200);
  }
  const forty = (await call("GET", `/api/geo/projects/${id}/questions`)).payload.data;
  assert.equal(forty.sets[0].measuredCount, 40);
  const last = forty.groups.flatMap((/** @type {any} */ group) => group.questions).find((/** @type {any} */ question) => question.isMeasured);
  const below = await call("POST", `/api/geo/projects/${id}/questions/${last.id}/unmeasure`, { body: {} });
  refused(below, 409, "geo_question_set_invalid");
  assert.match(String(below.payload.error), /40 to 120/);
  assert.equal((await call("GET", `/api/geo/projects/${id}/questions`)).payload.data.version, forty.version, "the refused copy was not written");

  const journey = (await call("GET", `/api/geo/projects/${id}/journey`)).payload.data;
  assert.deepEqual(journey, { version: null, subtypes: [], personas: [], stages: [], careNodes: [], files: [] }, "nothing written yet reads as empty");

  const sources = (await call("GET", `/api/geo/projects/${id}/sources`)).payload.data;
  assert.equal(sources.sources[0].domain, "39.net");
  assert.deepEqual(sources.sources[0].conditions, { icp: true, newsIndexed: true, medical: true });
  assert.equal(sources.battlefield.reason, "证据最硬");
  assert.deepEqual(sources.tiers.map((/** @type {any} */ tier) => [tier.tier, tier.budgetCny]), [["1", 1000], ["2", 2000], ["3", 3000]]);
  assert.equal(sources.chosenTier, "2");
  const deepseek = sources.expectations.find((/** @type {any} */ entry) => entry.engine === "deepseek");
  assert.equal(deepseek.promise, "讲对，不承诺提及");
  assert.equal(deepseek.retrieval.status, "absent");
  assert.equal((await call("POST", `/api/geo/projects/${id}/tier`, { body: { tier: "3" } })).payload.data.tier, "3");
  refused(await call("POST", `/api/geo/projects/${id}/tier`, { body: { tier: "4" } }), 400, "geo_tier_invalid");

  const content = (await call("GET", `/api/geo/projects/${id}/articles`)).payload.data.articles;
  assert.deepEqual(content.map((/** @type {any} */ article) => [article.layer, article.status, article.safety]),
    [["card", "publishable", "clear"], ["popular", "draft", "open"]], "an open safety finding holds an article back");
  assert.equal(content[0].question, "典型问句 1");
  assert.equal(content[0].claimCount, 1);
  const released = (await call("POST", `/api/geo/projects/${id}/articles/${articles.ids[1]}/release`, { body: {} })).payload.data;
  assert.deepEqual([released.safety, released.status], ["released", "publishable"]);
  refused(await call("POST", `/api/geo/projects/${id}/articles/${articles.ids[1]}/release`, { body: {} }), 409, "geo_article_state_invalid");
  assert.equal((await call("POST", `/api/geo/projects/${id}/articles/${articles.ids[0]}/withdraw`, { body: {} })).payload.data.status, "withdrawn");
  refused(await call("POST", `/api/geo/projects/${id}/articles/${articles.ids[0]}/withdraw`, { body: {} }), 409, "geo_article_state_invalid");
  refused(await call("POST", `/api/geo/projects/${id}/articles/gart_missing/withdraw`, { body: {} }), 404, "geo_article_not_found");

  const patched = (await call("PATCH", `/api/geo/projects/${id}`, { body: { coverageDays: 180, engines: ["deepseek"], status: "paused" } })).payload.data;
  assert.deepEqual([patched.coverageDays, patched.engines, patched.status], [180, ["deepseek"], "paused"]);
  refused(await call("PATCH", `/api/geo/projects/${id}`, { body: { status: "gone" } }), 400, "geo_status_invalid");
  refused(await call("PATCH", `/api/geo/projects/${id}`, { body: { name: "x" } }), 400, "geo_payload_invalid");
  void questions;
});

test("measured rows become the diagnosis, the answer page, the overview and monitoring — and nothing is computed", options, async () => {
  const { project } = await seededProject();
  const id = project.id;
  const map = await store.questionMap(id, 1);
  const question = map[0].questions[0];
  const insert = (/** @type {string} */ sql, /** @type {unknown[]} */ values) => database.query(sql, values);
  const roundId = `r-${id}`;
  await insert(`INSERT INTO evimed_geo.rounds (id, user_id, geo_project_id, kind, set_version, engines, status, planned, done, sample_date, finished_at)
    VALUES ($1, $3, $2, 'baseline', 1, ARRAY['doubao','deepseek'], 'done', 96, 94, '2026-09-24', now())`, [roundId, id, ALICE]);
  const sha = "c".repeat(64);
  await insert(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text, citations,
      screenshot_sha256, surface) VALUES ($1, $8, $2, $3, $4, 'deepseek', now(), 'valid', $5, $6::jsonb, $7, '{"mode":"web"}'::jsonb)`,
  [`s1-${id}`, roundId, id, question.id, "玛仕度肽每天注射一次。", JSON.stringify([{ url: "https://www.39.net/a", domain: "39.net", title: "a", inBody: true }]), sha,
    ALICE]);
  await insert(`INSERT INTO evimed_geo.snapshots (id, user_id, round_id, geo_project_id, question_id, engine, asked_at, status, answer_text)
    VALUES ($1, $5, $2, $3, $4, 'doubao', now(), 'suspect', '请登录')`, [`s2-${id}`, roundId, id, question.id, ALICE]);
  await insert(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, brands, statements, failure_mode, mentions_ours)
    VALUES ($1, $5, $2, $3::jsonb, $4::jsonb, 'wrong_ours', true)`, [`s1-${id}`, id,
    JSON.stringify([{ name: "替尔泊肽", ours: false, competitor: true, count: 2 }]),
    JSON.stringify([{ text: "每天注射一次", verdict: "wrong", errorType: "number", severity: "S3" }]), ALICE]);
  await insert(`INSERT INTO evimed_geo.facts (snapshot_id, user_id, geo_project_id, failure_mode) VALUES ($1, $3, $2, 'omitted')`, [`s2-${id}`, id, ALICE]);
  await insert(`INSERT INTO evimed_geo.errors (id, user_id, geo_project_id, fingerprint, engine, question_id, first_snapshot_id, last_snapshot_id, statement,
      error_type, severity, confirm, cited_source, action, status) VALUES ($1, $5, $2, 'dose', 'deepseek', $3, $4, $4, '把玛仕度肽说成每天注射一次',
      'number', 'S3', '{"stability":"stable"}'::jsonb, '{"domain":"39.net","attribute":"farm"}'::jsonb, 'report_and_cover', 'open')`,
  [`e-${id}`, id, question.id, `s1-${id}`, ALICE]);
  const metric = (/** @type {string} */ suffix, /** @type {Record<string, unknown>} */ row) => insert(`INSERT INTO evimed_geo.metrics
      (id, user_id, geo_project_id, round_id, scope, pool, engine, arm, metric_id, numerator, denominator, value, ci_low, ci_high, status, data_type,
       computed_at, variant, rival, reason)
    VALUES ($1, $19, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'measured', coalesce($15::timestamptz, now()), $16, $17, $18)`,
  [`m-${suffix}-${id}`, id, row.round ?? roundId, row.scope ?? "project", row.pool ?? null, row.engine ?? null, row.arm ?? null, row.metricId, row.k ?? null,
    row.n ?? null, row.value ?? null, row.low ?? null, row.high ?? null, row.status ?? "ok", row.at ?? null, row.variant ?? null, row.rival ?? null,
    row.reason ?? null, ALICE]);
  await metric("gvi", { metricId: "M-19", value: 31.5, status: "ok" });
  await metric("m01s", { metricId: "M-01S", k: 56, n: 310, value: 0.18, low: 0.14, high: 0.23 });
  // A variant of the same metric is another cell: it never stands in for the headline.
  await metric("m01s-top1", { metricId: "M-01S", variant: "top1", k: 9, n: 310, value: 0.03 });
  await metric("m06", { metricId: "M-06", k: 12, n: 20, value: 0.6, status: "insufficient" });
  await metric("m05", { metricId: "M-05", value: 2.4 });
  await metric("eng", { scope: "engine", engine: "deepseek", metricId: "M-01", k: 20, n: 48, value: 0.42 });
  await metric("eng-m10", { scope: "engine", engine: "doubao", metricId: "M-10", value: null, status: "not_measurable", reason: "no_retrieval" });
  await metric("pool", { scope: "pool", pool: "P2", metricId: "M-01", k: 3, n: 24, value: 0.125, status: "insufficient" });
  // The measurement package writes one NOISE row per metric (variant) and the index's NET row (variant M-19);
  // the page shows mention's band and the index's net effect, whatever was written after them.
  await metric("noise", { metricId: "NOISE", variant: "M-01", value: 0.04 });
  await metric("net", { metricId: "NET", variant: "M-19", value: 0.06, low: -0.01, high: 0.12 });
  const later = new Date(Date.now() + 60_000).toISOString();
  await metric("noise-m10", { metricId: "NOISE", variant: "M-10", value: 0.2, at: later });
  await metric("net-other", { metricId: "NET", variant: "M-06", value: 0.9, at: later });
  await metric("pilot", { scope: "arm", arm: "pilot", metricId: "M-19", value: 33.2 });
  await metric("control", { scope: "arm", arm: "control", metricId: "M-19", value: 30.1 });
  // An arm's per-pool row is a net-effect input, not the arm's line.
  await metric("pilot-p2", { scope: "arm", arm: "pilot", pool: "P2", metricId: "M-19", value: 99 });

  const diagnosis = (await call("GET", `/api/geo/projects/${id}/diagnosis`)).payload.data;
  assert.equal(diagnosis.round.id, roundId);
  assert.equal(diagnosis.round.sampleDate, "2026-09-24");
  assert.deepEqual(diagnosis.round.engines, ["doubao", "deepseek"]);
  const deepseek = diagnosis.byEngine.find((/** @type {any} */ row) => row.engine === "deepseek");
  assert.deepEqual(deepseek.mention, { value: 0.42, numerator: 20, denominator: 48, ciLow: null, ciHigh: null, status: "ok", dataType: "measured",
    reason: null, snapshotIds: [`s1-${id}`] }, "a cell names the answers it rests on (the suspect one is out)");
  assert.equal(deepseek.retrieval.status, "absent", "an unmeasured cell is absent, never zero");
  const doubao = diagnosis.byEngine.find((/** @type {any} */ row) => row.engine === "doubao");
  assert.deepEqual([doubao.retrieval.status, doubao.retrieval.reason, doubao.retrieval.value], ["not_measurable", "no_retrieval", null]);
  const p2 = diagnosis.byPool.find((/** @type {any} */ row) => row.pool === "P2");
  assert.equal(p2.mention.status, "insufficient");
  const p1 = diagnosis.byPool.find((/** @type {any} */ row) => row.pool === "P1");
  assert.equal(p1.topCompetitor, "替尔泊肽");
  assert.equal(p1.mainIssue, "wrong_ours");
  assert.deepEqual(Object.fromEntries(Object.entries(diagnosis.failureModes).map(([mode, cell]) => [mode, [/** @type {any} */ (cell).numerator,
    /** @type {any} */ (cell).denominator]])), { omitted: [0, 1], correct: [0, 1], wrongOurs: [1, 1], wrongCompetitor: [0, 1] },
  "a suspect answer is out of the tally");
  assert.deepEqual(diagnosis.failureModes.wrongOurs.snapshotIds, [`s1-${id}`], "a failure mode opens on its answers");
  assert.equal(diagnosis.errors[0].stability, "stable");
  assert.equal(diagnosis.errors[0].snapshotId, `s1-${id}`);
  assert.deepEqual(diagnosis.noise, { band: 0.04, measuredAt: diagnosis.noise.measuredAt });
  assert.deepEqual(diagnosis.more.map((/** @type {any} */ row) => [row.metricId, row.variant]), [["M-01S", "top1"], ["M-05", null]],
    "headline, NET and NOISE rows are not repeated under 更多; a variant is");
  assert.deepEqual(diagnosis.rounds.map((/** @type {any} */ row) => row.id), [roundId]);
  refused(await call("GET", `/api/geo/projects/${id}/diagnosis?round=r-nope`), 404, "geo_round_not_found");

  const answer = (await call("GET", `/api/geo/projects/${id}/answers/s1-${id}`)).payload.data;
  assert.equal(answer.question.text, question.text);
  assert.equal(answer.snapshot.screenshot, true);
  assert.equal(answer.snapshot.citations[0].domain, "39.net");
  assert.deepEqual(answer.siblings.map((/** @type {any} */ row) => row.engine).sort(), ["deepseek", "doubao"]);
  const own = answer.siblings.find((/** @type {any} */ row) => row.engine === "deepseek");
  assert.deepEqual([own.mentionsOurs, own.wrongOurs, own.citesOurs], [true, 1, null], "what the answer did for us, from its facts");
  assert.equal(answer.snapshot.screenshotSha256, sha);
  assert.deepEqual([answer.errors[0].claimId, answer.errors[0].evidenceQuote], [null, null], "an error row carries its claim and quote fields");
  assert.equal(answer.facts.statements[0].severity, "S3");
  assert.equal(answer.errors[0].id, `e-${id}`);
  assert.equal(answer.history[0].snapshotId, `s1-${id}`);
  refused(await call("GET", `/api/geo/projects/${id}/answers/s-missing`), 404, "geo_snapshot_not_found");

  const file = geoScreenshotPath(dataDir, sha);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const png = await call("GET", `/api/geo/projects/${id}/screenshots/${sha}`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual([...png.payload], [0x89, 0x50, 0x4e, 0x47]);
  refused(await call("GET", `/api/geo/projects/${id}/screenshots/${"d".repeat(64)}`), 404, "geo_screenshot_not_found");

  const page = (await call("GET", `/api/geo/projects/${id}`)).payload.data;
  const [gvi, mention, accuracy, citation] = page.overview.metrics;
  assert.equal(gvi.cell.value, 31.5);
  assert.deepEqual(gvi.trend, [{ date: "2026-09-24", value: 31.5 }]);
  assert.deepEqual([mention.cell.numerator, mention.cell.denominator], [56, 310], "the plain M-01S, not its top1 variant");
  assert.equal(accuracy.cell.status, "insufficient");
  assert.equal(citation.cell.status, "absent");
  assert.ok(page.overview.week.some((/** @type {any} */ item) => item.kind === "wrong_ours" && item.ref.snapshotId === `s1-${id}`));
  assert.ok(page.overview.week.every((/** @type {any} */ item) => typeof item.at === "string" && !Number.isNaN(Date.parse(item.at))), "every 本周 line says when");
  assert.deepEqual(mention.cell.snapshotIds, [], "the overview's mention (P2+P3) cell names its answers; this round had none in those pools");
  assert.deepEqual(page.availableEngines, ["doubao", "deepseek", "kimi"]);
  assert.ok(page.startedAt && Date.parse(page.startedAt) <= Date.now(), "the coverage window's start");
  const row = (await call("GET", "/api/geo/projects")).payload.data.projects.find((/** @type {any} */ entry) => entry.id === id);
  assert.deepEqual(row.alert, { wrongOurs: 1, safety: 1, text: "DeepSeek：把玛仕度肽说成每天注射一次" });
  assert.equal(row.headline.gvi.value, 31.5);
  assert.equal(row.headline.mention.denominator, 310);

  const monitoring = (await call("GET", `/api/geo/projects/${id}/monitoring`)).payload.data;
  assert.deepEqual(monitoring.series[0], { key: "gvi", points: [{ date: "2026-09-24", value: 31.5, n: null, k: null }] });
  assert.deepEqual(monitoring.arms.pilot, [{ date: "2026-09-24", value: 33.2 }], "the arm-scope index at pool null");
  assert.deepEqual(monitoring.arms.control, [{ date: "2026-09-24", value: 30.1 }]);
  assert.equal(monitoring.arms.netEffect.value, 0.06);
  assert.equal(monitoring.arms.netEffect.noiseBand, 0.04);
  assert.deepEqual(monitoring.byEngine.find((/** @type {any} */ entry) => entry.engine === "deepseek").points, [{ date: "2026-09-24", value: 0.42 }]);
  assert.equal(monitoring.newErrors[0].id, `e-${id}`);
  assert.equal(monitoring.next.kind, "weekly", "past a baseline, the next is the weekly round");
});

test("distribution reads the orders; budget, cancel, run and export go to their hooks or answer 503", options, async () => {
  const { project, articles } = await seededProject();
  const id = project.id;
  const media = `m1-${run}`;
  await database.query(`INSERT INTO evimed_geo.media (resource_id, media_type, name, domain, price_cny) VALUES ($1, 'website', '生命时报', 'lifetimes.cn', 946)
    ON CONFLICT DO NOTHING`, [media]);
  // One live order per article (geo_orders_live_article_key), and the money in
  // the ledger the market would have written: three reserves, one settlement.
  const third = `art3-${id}`;
  await database.query(`INSERT INTO evimed_geo.articles (id, user_id, geo_project_id, layer, title, gate, safety, status)
    VALUES ($1, $2, $3, 'popular', '第三篇', 'passed', 'clear', 'published')`, [third, ALICE, id]);
  await database.query(`INSERT INTO evimed_geo.orders (id, user_id, geo_project_id, article_id, media_type, resource_id, state, reserve_cny, price_cny)
    VALUES ($1, $6, $2, $3, 'website', $7, 'submitted', 1040.6, 946), ($4, $6, $2, $8, 'website', $7, 'accepted', 1040.6, 946),
      ($5, $6, $2, $9, 'website', $7, 'settled', 1040.6, 946)`, [`o1-${id}`, id, articles.ids[0], `o2-${id}`, `o3-${id}`, ALICE, media, articles.ids[1], third]);
  await database.query(`UPDATE evimed_geo.orders SET settled_cny = 946, published_url = 'https://lifetimes.cn/a' WHERE id = $1`, [`o3-${id}`]);
  await database.query(`INSERT INTO evimed_geo.ledger (id, user_id, geo_project_id, order_id, kind, amount_cny) VALUES
    ($1 || '-r1', $2, $3, $4, 'reserve', 1040.6), ($1 || '-r2', $2, $3, $5, 'reserve', 1040.6), ($1 || '-r3', $2, $3, $6, 'reserve', 1040.6),
    ($1 || '-s3', $2, $3, $6, 'settle', 946), ($1 || '-l3', $2, $3, $6, 'release', 94.6)`, [`gl-${id}`, ALICE, id, `o1-${id}`, `o2-${id}`, `o3-${id}`]);
  // An engine cites the published page by another spelling of the same address; a longer path is another page.
  await database.query(`INSERT INTO evimed_geo.snapshots (id, user_id, geo_project_id, engine, asked_at, status, citations)
    VALUES ($1, $3, $4, 'deepseek', now(), 'valid', $5::jsonb), ($2, $3, $4, 'doubao', now(), 'valid', $6::jsonb)`,
  [`sc1-${id}`, `sc2-${id}`, ALICE, id, JSON.stringify([{ url: "http://www.LifeTimes.cn/a/?utm_source=ai#top", domain: "lifetimes.cn" }]),
    JSON.stringify([{ url: "https://lifetimes.cn/ab", domain: "lifetimes.cn" }])]);
  const content = (await call("GET", `/api/geo/projects/${id}/articles`)).payload.data.articles;
  // The published order (o3) is the third article's: one live order per article.
  assert.equal(content.find((/** @type {any} */ article) => article.id === third).cited, true, "matched by the owner's URL key");
  const cited = (await call("GET", `/api/geo/projects/${id}/monitoring`)).payload.data.cited;
  assert.deepEqual(cited.map((/** @type {any} */ row) => [row.articleId, row.engine]), [[third, "deepseek"]], "the longer path is another page");
  const view = (await call("GET", `/api/geo/projects/${id}/distribution`)).payload.data;
  assert.equal(view.budget, null);
  assert.equal(view.spentCny, 946);
  assert.equal(view.reservedCny, 2081.2);
  assert.equal(view.suggestedBudgetCny, 2000, "the chosen tier's budget");
  assert.deepEqual(view.market, { configured: false });
  assert.equal(view.orders.length, 3);
  assert.deepEqual(Object.keys(view.orders[0]).sort(), ["articleId", "articleTitle", "cancellable", "checks", "domain", "id", "layer", "media",
    "priceCny", "publishedUrl", "state", "updatedAt"]);
  assert.equal(view.orders.find((/** @type {any} */ order) => order.id === `o1-${id}`).media, "生命时报");

  hooks.market = null;
  refused(await call("PUT", `/api/geo/projects/${id}/budget`, { body: { totalCny: 5000, dailyCny: 500 } }), 503, "geo_unavailable");
  refused(await call("PUT", `/api/geo/projects/${id}/budget`, { body: { totalCny: 500, dailyCny: 5000 } }), 400, "geo_budget_invalid");
  refused(await call("PUT", `/api/geo/projects/${id}/budget`, { body: { totalCny: -1, dailyCny: 1 } }), 400, "geo_budget_invalid");
  refused(await call("POST", `/api/geo/projects/${id}/orders/o1-${id}/cancel`, { body: {} }), 503, "geo_unavailable");
  refused(await call("POST", `/api/geo/projects/${id}/orders/o2-${id}/cancel`, { body: {} }), 409, "geo_order_not_cancellable");
  refused(await call("POST", `/api/geo/projects/${id}/orders/o-missing/cancel`, { body: {} }), 404, "geo_order_not_found");
  const seen = /** @type {any[]} */ ([]);
  hooks.market = {
    async setBudget(/** @type {any} */ user, /** @type {any} */ target, /** @type {any} */ budget) { seen.push(["budget", user.id, target.id, budget]); return { budget }; },
    async cancelOrder(/** @type {any} */ user, /** @type {any} */ target, /** @type {string} */ orderId) { seen.push(["cancel", user.id, target.id, orderId]); return { id: orderId, state: "cancelled" }; },
    configured: () => true,
  };
  assert.deepEqual((await call("PUT", `/api/geo/projects/${id}/budget`, { body: { totalCny: 5000, dailyCny: 500 } })).payload.data,
    { budget: { totalCny: 5000, dailyCny: 500 } });
  assert.equal((await call("POST", `/api/geo/projects/${id}/orders/o1-${id}/cancel`, { body: {} })).payload.data.state, "cancelled");
  assert.deepEqual(seen, [["budget", ALICE, id, { totalCny: 5000, dailyCny: 500 }], ["cancel", ALICE, id, `o1-${id}`]]);
  assert.deepEqual((await call("GET", `/api/geo/projects/${id}/distribution`)).payload.data.market, { configured: true });
  hooks.market = null;

  refused(await call("POST", `/api/geo/projects/${id}/run`, { body: { step: "diagnosis" } }), 503, "geo_unavailable");
  refused(await call("POST", `/api/geo/projects/${id}/run`, { body: { step: "everything" } }), 400, "geo_step_invalid");
  refused(await call("POST", `/api/geo/projects/${id}/export`, { body: { kind: "weekly" } }), 503, "geo_unavailable");
  refused(await call("POST", `/api/geo/projects/${id}/export`, { body: { kind: "annual" } }), 400, "geo_export_kind_invalid");
  hooks.orchestrator = { async runStep(/** @type {any} */ _user, /** @type {any} */ target, /** @type {string} */ step) { return { sessionId: `run-${step}`, runId: `${target.id}:${step}` }; } };
  hooks.exporter = { async export(/** @type {any} */ _user, /** @type {any} */ target, /** @type {string} */ kind) { return { sessionId: `export-${kind}`, runId: target.id }; } };
  assert.deepEqual((await call("POST", `/api/geo/projects/${id}/run`, { body: { step: "sources" } })).payload.data, { sessionId: "run-sources", runId: `${id}:sources` });
  assert.deepEqual((await call("POST", `/api/geo/projects/${id}/export`, { body: { kind: "proposal" } })).payload.data, { sessionId: "export-proposal", runId: id });
  hooks.orchestrator = null;
  hooks.exporter = null;
});

test("another account's GEO project is a 404 on every route, reads and writes alike", options, async () => {
  const { project, articles } = await seededProject();
  const id = project.id;
  hooks.market = { async setBudget() { throw new Error("must not be reached"); }, async cancelOrder() { throw new Error("must not be reached"); } };
  hooks.orchestrator = { async runStep() { throw new Error("must not be reached"); } };
  hooks.exporter = { async export() { throw new Error("must not be reached"); } };
  const routes = [
    ["GET", `/api/geo/projects/${id}`], ["PATCH", `/api/geo/projects/${id}`, { tier: "1" }], ["DELETE", `/api/geo/projects/${id}`, {}],
    ["GET", `/api/geo/projects/${id}/evidence`], ["GET", `/api/geo/projects/${id}/journey`], ["GET", `/api/geo/projects/${id}/questions`],
    ["POST", `/api/geo/projects/${id}/questions/gq_x/unmeasure`, {}], ["GET", `/api/geo/projects/${id}/diagnosis`],
    ["GET", `/api/geo/projects/${id}/answers/s-x`], ["GET", `/api/geo/projects/${id}/screenshots/${"c".repeat(64)}`],
    ["GET", `/api/geo/projects/${id}/sources`], ["POST", `/api/geo/projects/${id}/tier`, { tier: "1" }], ["GET", `/api/geo/projects/${id}/articles`],
    ["POST", `/api/geo/projects/${id}/articles/${articles.ids[0]}/withdraw`, {}], ["POST", `/api/geo/projects/${id}/articles/${articles.ids[1]}/release`, {}],
    ["GET", `/api/geo/projects/${id}/distribution`], ["PUT", `/api/geo/projects/${id}/budget`, { totalCny: 10, dailyCny: 1 }],
    ["POST", `/api/geo/projects/${id}/orders/o-x/cancel`, {}], ["GET", `/api/geo/projects/${id}/monitoring`],
    ["POST", `/api/geo/projects/${id}/run`, { step: "evidence" }], ["POST", `/api/geo/projects/${id}/export`, { kind: "weekly" }],
  ];
  for (const [method, route, body] of routes) refused(await call(/** @type {string} */ (method), /** @type {string} */ (route), { user: MALLORY, body }), 404, "geo_project_not_found");
  assert.ok(!(await call("GET", "/api/geo/projects", { user: MALLORY })).payload.data.projects.some((/** @type {any} */ row) => row.id === id));
  // And nothing of alice's moved.
  assert.equal((await store.getProject(ALICE, id))?.tier, "2");
  assert.equal((await store.getArticle(id, articles.ids[1]))?.safety, "open");
  hooks.market = null;
  hooks.orchestrator = null;
  hooks.exporter = null;
});

test("deleting a GEO project hides it from 循证 GEO and leaves its control-plane project alone", options, async () => {
  const { project } = await seededProject();
  const deleted = (await call("DELETE", `/api/geo/projects/${project.id}`, { body: {} })).payload.data;
  assert.deepEqual(deleted, { id: project.id, projectId: project.projectId, deleted: true });
  refused(await call("GET", `/api/geo/projects/${project.id}`), 404, "geo_project_not_found");
  assert.ok(!(await call("GET", "/api/geo/projects")).payload.data.projects.some((/** @type {any} */ row) => row.id === project.id));
  refused(await call("DELETE", `/api/geo/projects/${project.id}`, { body: {} }), 404, "geo_project_not_found");
});

test("the marketplace account is an operator's: others get 403, top-ups are confirmed through the market or 503", options, async () => {
  refused(await call("GET", "/api/geo/market"), 403, "geo_operator_required");
  const market = (await call("GET", "/api/geo/market", { user: OPS })).payload.data;
  assert.deepEqual(Object.keys(market).sort(), ["balance", "balanceCapCny", "configured", "reconciliation", "topups"]);
  assert.deepEqual([market.configured, market.balance, market.balanceCapCny], [false, null, null]);
  const topup = `t-${run}`;
  refused(await call("POST", `/api/geo/market/topups/${topup}/confirm`, { user: OPS, body: {} }), 404, "geo_topup_not_found");
  await database.query(`INSERT INTO evimed_geo.topups (id, amount_cny, status, requested_at) VALUES ($1, 5000, 'requested', now() + interval '1 day')`, [topup]);
  refused(await call("POST", `/api/geo/market/topups/${topup}/confirm`, { user: OPS, body: {} }), 503, "geo_unavailable");
  hooks.market = { async confirmTopup(/** @type {any} */ user, /** @type {string} */ topupId) { return { id: topupId, status: "confirmed", by: user.id }; },
    async balance() { return { money: 12_000, powerCount: 30 }; } };
  assert.deepEqual((await call("POST", `/api/geo/market/topups/${topup}/confirm`, { user: OPS, body: {} })).payload.data, { id: topup, status: "confirmed", by: OPS });
  const withBalance = (await call("GET", "/api/geo/market", { user: OPS })).payload.data;
  assert.deepEqual(withBalance.balance, { money: 12_000, powerCount: 30 });
  assert.equal(withBalance.topups[0].id, topup, "newest request first");
  await database.query(`DELETE FROM evimed_geo.topups WHERE id = $1`, [topup]);
  hooks.market = null;
});
