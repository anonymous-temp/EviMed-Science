// The GEO routes' plumbing against doubles: bounded metric labels, the CSRF
// check repeated, ids in a path held to their shape, a creation with no
// project hook answering 503 by name — and the module's readiness and metric
// families, off and on.
import assert from "node:assert/strict";
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
  const wired = await geoReadiness({ config: { ...config, geoSocialUrl: "http://social:9966", mediaMarketUrl: "https://m", mediaMarketApiKeyFile: "/k" },
    geo: { ...healthy, worker: { status: () => ({ running: false }) } }, database: {} });
  assert.equal(wired.warning, undefined);
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
