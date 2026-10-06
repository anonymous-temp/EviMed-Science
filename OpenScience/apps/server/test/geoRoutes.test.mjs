// The GEO routes' plumbing against doubles: bounded metric labels, the CSRF
// check repeated, ids in a path held to their shape, a creation with no
// project hook answering 503 by name — and the module's readiness and metric
// families, off and on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ALL_ERROR_CODES, GEO_ROUTE_ERROR_CODES } from "@evimed/domain";
import { createGeoRoutes, geoRoutePattern } from "../src/geoRoutes.mjs";
import { geoAudienceAllows, geoMetricFamilies, geoReadiness } from "../src/geoService.mjs";
import { readFile } from "node:fs/promises";

/** @param {string} method @param {string} url @param {unknown} [body] */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}

function response() {
  return {
    status: 0, body: "",
    writeHead(/** @type {number} */ status) { this.status = status; return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

const config = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [] };

function fixture(overrides = {}) {
  const calls = /** @type {any[]} */ ([]);
  const store = {
    async ensureSessionUser() { return { user: { id: "reader" } }; },
    async assertCsrf(/** @type {any} */ _req, /** @type {string} */ pathname) { calls.push(["csrf", pathname]); },
  };
  const service = {
    allows: (/** @type {any} */ user) => geoAudienceAllows(config, user),
    isOperator: () => false,
    async listProjects() { calls.push(["list"]); return { projects: [] }; },
    async createProject() { throw new Error("must not be reached without a project hook"); },
  };
  return { calls, routes: createGeoRoutes({ store, service, config, maxJsonBytes: 65_536, ...overrides }) };
}

test("a GEO path's metric label folds every id, so a dashboard row is a route", () => {
  for (const [path, label] of [
    ["/api/geo", "/api/geo"],
    ["/api/geo/projects", "/api/geo/projects"],
    ["/api/geo/projects/geo_abc", "/api/geo/projects/:id"],
    ["/api/geo/projects/geo_abc/diagnosis", "/api/geo/projects/:id/diagnosis"],
    ["/api/geo/projects/geo_abc/answers/s_1", "/api/geo/projects/:id/answers/:item"],
    ["/api/geo/projects/geo_abc/questions/gq_1/unmeasure", "/api/geo/projects/:id/questions/:item/:action"],
    ["/api/geo/projects/geo_abc/whatever-this-is", "/api/geo/projects/:id/:route"],
    ["/api/geo/market", "/api/geo/market"],
    ["/api/geo/market/topups/t_1/confirm", "/api/geo/market/topups/:id/confirm"],
    ["/api/geo/other", "/api/geo/:route"],
  ]) assert.equal(geoRoutePattern(path), label, path);
});

test("the CSRF check is repeated, a path id is held to its shape, and creation without its hook is a named 503", async () => {
  const { calls, routes } = fixture();
  const res = response();
  assert.equal(await routes(request("GET", "/api/geo/projects"), res), true);
  assert.deepEqual(calls, [["csrf", "/api/geo/projects"], ["list"]]);
  assert.deepEqual(res.json(), { data: { projects: [] } });
  await assert.rejects(routes(request("GET", "/api/geo/projects/..%2F..%2Fetc"), response()), { status: 404, code: "not_found" });
  await assert.rejects(routes(request("GET", "/api/geo/projects/%E0%A4%A"), response()), { status: 400, code: "geo_path_invalid" });
  await assert.rejects(routes(request("POST", "/api/geo/projects", { brandName: "司美格鲁肽" }), response()), { status: 503, code: "geo_unavailable" });
  await assert.rejects(routes(request("PUT", "/api/geo/projects"), response()), { status: 404, code: "not_found" });
  await assert.rejects(routes(request("GET", "/api/geo/market"), response()), { status: 403, code: "geo_operator_required" });
});

test("every code the routes and the service answer with is registered", async () => {
  // The refusals a request can meet: an HttpError, directly or through the
  // service's `failure` helper. Readiness codes are the readiness board's.
  const emitted = new Set();
  for (const file of ["../src/geoRoutes.mjs", "../src/geoService.mjs"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    for (const [, code] of text.matchAll(/(?:failure|HttpError)\(\s*\d{3},\s*"(geo_[a-z0-9_]+)"/g)) emitted.add(code);
    for (const [, code] of text.matchAll(/new HttpError\(\d{3}, "(geo_[a-z0-9_]+)"/g)) emitted.add(code);
  }
  assert.ok(emitted.size >= 15, `only ${emitted.size} codes were found; the scan did not run`);
  const unregistered = [...emitted].filter((code) => !ALL_ERROR_CODES.includes(code)).sort();
  assert.deepEqual(unregistered, [], `emitted but not registered: ${unregistered.join(", ")}`);
  // A page's refusal is a page's; the one tool code the service throws is the runtime read's own.
  assert.deepEqual([...emitted].filter((code) => !GEO_ROUTE_ERROR_CODES.includes(code)), ["geo_read_what_invalid"]);
});

test("readiness: off is green and says so; on it is red only for the module's own invariants", async () => {
  assert.deepEqual(await geoReadiness({ config: { geoEnabled: false }, geo: null, database: null }), { required: false, enabled: false });
  await assert.rejects(geoReadiness({ config, geo: null, database: null }), { code: "geo_unavailable" });
  const failing = { service: { ready: async () => { throw Object.assign(new Error("x"), { code: "42501" }); } }, worker: null, social: null };
  await assert.rejects(geoReadiness({ config, geo: failing, database: {} }), (error) => /** @type {any} */ (error).code === "geo_migration_failed"
    && /** @type {any} */ (error).details.reason === "42501");
  const healthy = { service: { ready: async () => ({}) }, worker: null, social: { status: () => ({ configured: false, counters: {}, lastError: null }) } };
  const answer = await geoReadiness({ config: { ...config, geoEngines: ["deepseek"] }, geo: healthy, database: {} });
  assert.equal(answer.required, true);
  assert.deepEqual(answer.warnings, ["geo_worker_missing", "geo_social_unconfigured", "geo_market_unconfigured"],
    "what lives outside the platform, or in another package, is a warning on a green check");
  // Wired means a usable key file, not a path (mediaMarketConfigured).
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "geo-routes-key-"));
  try {
    const keyFile = path.join(keyDir, "media-market-api-key");
    writeFileSync(keyFile, "k-123456\n", { mode: 0o600 });
    const wired = await geoReadiness({ config: { ...config, geoSocialUrl: "http://social:9966", mediaMarketUrl: "https://m", mediaMarketApiKeyFile: keyFile },
      geo: { ...healthy, worker: { status: () => ({ running: false }) } }, database: {} });
    assert.equal(wired.warning, undefined);
  } finally { rmSync(keyDir, { recursive: true, force: true }); }
});

test("metric families: one line off, the module's counts on", () => {
  assert.deepEqual(geoMetricFamilies(false, null).map((family) => [family.name, family.series[0].value]), [["open_science_geo_enabled", 0]]);
  const families = geoMetricFamilies(true, {
    tables: { projects: 3, active: 2, openErrors: 4, urgentErrors: 1, safetyStops: 1, openRounds: 0 },
    service: { projectsCreated: 3, reads: 10, writes: 5, writeIssues: 2, notFound: 1 },
    social: { configured: true, counters: { searches: 1, requests: 6, collected: 5, noResults: 0, failed: 1 }, lastError: null },
  });
  const byName = new Map(families.map((family) => [family.name, family]));
  assert.equal(byName.get("open_science_geo_enabled")?.series[0].value, 1);
  assert.deepEqual(byName.get("open_science_geo_open_errors")?.series.map((series) => series.value), [4, 1]);
  assert.equal(byName.get("open_science_geo_safety_stops")?.series[0].value, 1);
  assert.ok(byName.get("open_science_geo_social_requests_total")?.series.some((series) => series.labels?.outcome === "failed" && series.value === 1));
  for (const family of families) assert.match(family.name, /^open_science_geo_[a-z_]+$/);
});

test("metric families: the worker's loops and the probe's paused engines, which the evimed-geo alerts read", () => {
  // Audit I3-7: readiness showed the worker and nothing alerted on it.
  const snapshot = {
    tables: null, service: {}, social: null,
    worker: { loops: {
      probe: { wired: true, stalled: false, lastOkAt: "2026-09-26T15:03:00.000Z", last: { paused: 3, asked: 0 } },
      parse: { wired: true, stalled: true, lastOkAt: null, last: null },
      topups: { wired: false, stalled: false, lastOkAt: null, last: null },
    } },
  };
  const byName = new Map(geoMetricFamilies(true, snapshot).map((family) => [family.name, family]));
  assert.deepEqual(byName.get("open_science_geo_loop_last_ok_timestamp_seconds")?.series,
    [{ labels: { loop: "probe" }, value: Date.parse("2026-09-26T15:03:00.000Z") / 1000 }, { labels: { loop: "parse" }, value: 0 }]);
  assert.deepEqual(byName.get("open_science_geo_loop_stalled")?.series.map((series) => [series.labels.loop, series.value]), [["probe", 0], ["parse", 1]]);
  assert.equal(byName.get("open_science_geo_probe_paused_engines")?.series[0].value, 3);
  // A worker that reports nothing adds nothing: no series is invented.
  const quiet = new Map(geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null }).map((family) => [family.name, family]));
  assert.equal(quiet.has("open_science_geo_loop_stalled"), false);
  assert.equal(quiet.has("open_science_geo_probe_paused_engines"), false);
});

test("the evimed-geo alerts read series the module exports", async () => {
  const { readFile } = await import("node:fs/promises");
  const rules = JSON.parse(await readFile(new URL("../../../deploy/web/monitoring/open-science.rules.json", import.meta.url), "utf8"));
  const group = rules.groups.find((entry) => entry.name === "evimed-geo");
  assert.ok(group, "an evimed-geo rule group exists");
  const alerts = new Map(group.rules.map((rule) => [rule.alert, rule]));
  assert.deepEqual([...alerts.keys()].sort(), ["GeoProbeEnginesPaused", "GeoProbeLoopStalled", "GeoUrgentFindingsOpen"]);
  const exported = new Set(geoMetricFamilies(true, {
    tables: { projects: 1, active: 1, openErrors: 1, urgentErrors: 1, safetyStops: 0, openRounds: 0 }, service: {}, social: null,
    worker: { loops: { probe: { wired: true, stalled: false, lastOkAt: null, last: { paused: 0 } } } },
  }).map((family) => family.name));
  for (const rule of group.rules) {
    const names = [...String(rule.expr).matchAll(/\b(open_science_geo_[a-z_]+)/g)].map((match) => match[1]);
    assert.ok(names.length > 0, `${rule.alert} reads no GEO series`);
    for (const name of names) assert.ok(exported.has(name), `${rule.alert} reads ${name}, which geoMetricFamilies does not export`);
  }
});

test("operators can page marketplace records and statements without invoking write hooks", async () => {
  const calls = [];
  const service = { allows: () => true, isOperator: () => true };
  const market = Object.fromEntries(["orders", "topups", "settlement"].map((name) => [name, async (input) => {
    calls.push([name, input]); return { items: [], summary: null };
  }]));
  const { routes } = fixture({ service, market });
  for (const path of ["orders?view=problems&limit=2", "topups?status=requested", "settlement?month=2026-09"]) {
    const res = response();
    await routes(request("GET", `/api/geo/market/${path}`), res);
    assert.equal(res.status, 200);
  }
  assert.deepEqual(calls, [["orders", { view: "problems", limit: "2" }], ["topups", { status: "requested" }], ["settlement", { month: "2026-09" }]]);
  for (const name of ["orders", "topups", "settlement"]) assert.equal(geoRoutePattern(`/api/geo/market/${name}`), `/api/geo/market/${name}`);
  await assert.rejects(fixture({ service: { ...service, isOperator: () => false }, market }).routes(
    request("GET", "/api/geo/market/settlement?month=2026-09"), response()), { code: "geo_operator_required" });
  assert.equal(calls.length, 3);
});

test("market overview uses the composed operations status and preserves reconciliation compatibility", async () => {
  const { GeoService } = await import("../src/geoService.mjs");
  const current = { configured: false, operationsAvailable: true, counts: { unknownOrders: 4 }, lastReconciliation: { day: "2026-09-29" } };
  const result = await GeoService.prototype.market.call({ ready: async () => {}, store: { query: () => assert.fail("legacy query bypassed composed status") } }, { status: async () => current });
  assert.equal(result.counts.unknownOrders, 4);
  assert.deepEqual(result.reconciliation, current.lastReconciliation);
});

test("the cards route reads and writes only the caller's own project, and the producer settings are the domain's own", async () => {
  const patched = /** @type {any[]} */ ([]);
  const cardCalls = /** @type {any[]} */ ([]);
  const project = { id: "geo_mine", userId: "reader", projectId: "p" };
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} };
  const service = {
    allows: () => true, isOperator: () => false,
    async requireProject(/** @type {any} */ user, /** @type {string} */ id) {
      if (user.id !== "reader" || id !== "geo_mine") throw Object.assign(new Error("none"), { status: 404, code: "geo_project_not_found" });
      return project;
    },
    async updateProject(/** @type {any} */ _user, /** @type {string} */ id, /** @type {any} */ patch) { patched.push([id, patch]); return { id, ...patch }; },
  };
  const cards = {
    list: async (/** @type {any} */ found) => { cardCalls.push(["list", found.id]); return { zoneId: "ez_1", cards: [] }; },
    refresh: async (/** @type {any} */ user, /** @type {any} */ found) => { cardCalls.push(["refresh", user.id, found.id]); return { zoneId: "ez_1", cards: [{ cardId: "ec_1" }], held: [], failed: [], skipped: [] }; },
  };
  const real = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536, cards });
  let res = response();
  await real(request("GET", "/api/geo/projects/geo_mine/cards"), res);
  assert.deepEqual(res.json(), { data: { zoneId: "ez_1", cards: [] } });
  res = response();
  await real(request("POST", "/api/geo/projects/geo_mine/cards/refresh", {}), res);
  assert.equal(res.json().data.cards[0].cardId, "ec_1");
  assert.deepEqual(cardCalls, [["list", "geo_mine"], ["refresh", "reader", "geo_mine"]]);
  // A project that is not the caller's reads as one that does not exist, for both.
  await assert.rejects(real(request("GET", "/api/geo/projects/geo_theirs/cards"), response()), { status: 404, code: "geo_project_not_found" });
  await assert.rejects(real(request("POST", "/api/geo/projects/geo_theirs/cards/refresh", {}), response()), { status: 404, code: "geo_project_not_found" });
  // Without the card hook the route exists and says so by name.
  const bare = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536 });
  await assert.rejects(bare(request("GET", "/api/geo/projects/geo_mine/cards"), response()), { status: 503, code: "geo_unavailable" });
  // The producer is checked by the domain: a kind outside the list or a doctor with no name is refused for this write and nothing else.
  await assert.rejects(real(request("PATCH", "/api/geo/projects/geo_mine", { producer: { kind: "agency" } }), response()), { status: 400, code: "geo_producer_invalid" });
  await assert.rejects(real(request("PATCH", "/api/geo/projects/geo_mine", { producer: { kind: "doctor" } }), response()), { status: 400, code: "geo_producer_invalid" });
  assert.deepEqual(patched, []);
  res = response();
  await real(request("PATCH", "/api/geo/projects/geo_mine", { producer: { kind: "doctor", name: " 张医生 ", hospital: "某某医院" } }), res);
  assert.deepEqual(patched, [["geo_mine", { producer: { kind: "doctor", name: "张医生", relation: "user_of_therapy", hospital: "某某医院" } }]]);
  res = response();
  await real(request("PATCH", "/api/geo/projects/geo_mine", { producer: null }), res);
  assert.deepEqual(patched.at(-1), ["geo_mine", { producer: null }]);
  assert.equal(geoRoutePattern("/api/geo/projects/geo_mine/cards"), "/api/geo/projects/:id/cards");
  assert.equal(geoRoutePattern("/api/geo/projects/geo_mine/cards/refresh"), "/api/geo/projects/:id/cards/:item");
});

test("metric families: the evidence chain's cards and the judge's checks are counted", () => {
  const families = geoMetricFamilies(true, {
    tables: null, service: {}, social: null, worker: null,
    cards: { zonesMade: 1, cardsCreated: 4, cardsUpdated: 1, cardsUnchanged: 7, claimsCarded: 12, claimsHeld: 3, refused: 2, referencesChecked: 9, referencesUnresolved: 1, articlesFlagged: 2 },
    checks: { offLabel: 3, omittedSafety: 1, linkMissing: 2 },
  });
  const byName = new Map(families.map((family) => [family.name, family]));
  const cards = byName.get("open_science_geo_cards_total");
  assert.equal(cards?.type, "counter");
  assert.deepEqual(cards?.series.find((series) => series.labels?.event === "claimsHeld")?.value, 3);
  assert.deepEqual(cards?.series.find((series) => series.labels?.event === "articlesFlagged")?.value, 2);
  assert.deepEqual(byName.get("open_science_geo_checks_total")?.series.map((series) => [series.labels?.check, series.value]), [["offLabel", 3], ["omittedSafety", 1], ["linkMissing", 2]]);
  assert.equal(byName.has("open_science_geo_cards_total") && geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null }).some((family) => family.name === "open_science_geo_checks_total"), false,
    "no checks recorded, no family");
});
