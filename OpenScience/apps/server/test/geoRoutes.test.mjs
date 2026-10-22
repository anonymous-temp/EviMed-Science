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
import { ALL_ERROR_CODES, GEO_MEDIA_MARKET_ERROR_CODES, GEO_ROUTE_ERROR_CODES } from "@evimed/domain";
import { createGeoRoutes, geoRoutePattern } from "../src/geoRoutes.mjs";
import { GeoService, geoAudienceAllows, geoMetricFamilies, geoReadiness } from "../src/geoService.mjs";
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
  // The market's refusals are the routes' too (`marketFailure("409", …)`, a status written as a string), and the vendor's codes pass
  // through them: the scan reads the market as it reads the routes (M-6, which a scan of the routes and the service alone could not see).
  for (const file of ["../src/geoRoutes.mjs", "../src/geoService.mjs", "../src/geoMarket.mjs", "../src/geoMarketOperations.mjs"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    for (const [, code] of text.matchAll(/(?:failure|HttpError|marketFailure)\(\s*"?\d{3}"?,\s*"((?:geo|media_market)_[a-z0-9_]+)"/g)) emitted.add(code);
    for (const [, code] of text.matchAll(/new HttpError\(\d{3}, "(geo_[a-z0-9_]+)"/g)) emitted.add(code);
  }
  assert.ok(emitted.size >= 15, `only ${emitted.size} codes were found; the scan did not run`);
  for (const code of ["geo_order_in_flight", "geo_order_not_found_at_vendor", "geo_topup_not_pending", "geo_topup_invalid", "media_market_unconfigured"]) {
    assert.ok(emitted.has(code), `the scan reaches the market: ${code}`);
  }
  const unregistered = [...emitted].filter((code) => !ALL_ERROR_CODES.includes(code)).sort();
  assert.deepEqual(unregistered, [], `emitted but not registered: ${unregistered.join(", ")}`);
  // A page's refusal is a page's; the one tool code the service throws is the runtime read's own.
  assert.deepEqual([...emitted].filter((code) => !GEO_ROUTE_ERROR_CODES.includes(code) && !GEO_MEDIA_MARKET_ERROR_CODES.includes(code)), ["geo_read_what_invalid"]);
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
    service: { projectsCreated: 3, reads: 10, writes: 5, writeIssues: 2, notFound: 1, researchCapped: 4 },
    social: { configured: true, counters: { searches: 1, requests: 6, collected: 5, noResults: 0, failed: 1 }, lastError: null },
    inclusion: { submitted: 6, polled: 40, done: 4, failed: 1, expired: 1 },
    imports: { imported: 9, failed: 2, ignoredFields: 7, declinedFields: 2 },
    writeFields: [{ what: "strategy", outcome: "ignored", value: 3 }, { what: "articles", outcome: "declined", value: 1 }],
    valueUpkeep: { ticks: 7, projectsChecked: 3, versionsPruned: 41, projectsPruned: 2, failures: 1 },
  });
  const byName = new Map(families.map((family) => [family.name, family]));
  assert.equal(byName.get("open_science_geo_enabled")?.series[0].value, 1);
  assert.deepEqual(byName.get("open_science_geo_open_errors")?.series.map((series) => series.value), [4, 1]);
  assert.equal(byName.get("open_science_geo_safety_stops")?.series[0].value, 1);
  assert.equal(byName.get("open_science_geo_service_total")?.series.find((series) => series.labels?.kind === "researchCapped")?.value, 4,
    "research requests over the limit are counted (D-06)");
  assert.ok(byName.get("open_science_geo_social_requests_total")?.series.some((series) => series.labels?.outcome === "failed" && series.value === 1));
  assert.equal(byName.get("open_science_geo_inclusion_total")?.series.find((series) => series.labels?.event === "expired")?.value, 1,
    "an inclusion check given up on after its age limit is counted (Q-7)");
  assert.deepEqual(byName.get("open_science_geo_run_import_total")?.series.map((series) => [series.labels?.outcome, series.value]), [["imported", 9], ["failed", 2]],
    "a run's import that lost a write is counted (D-24)");
  assert.deepEqual(byName.get("open_science_geo_write_fields_total")?.series.map((series) => [series.labels?.what, series.labels?.outcome, series.value]),
    [["strategy", "ignored", 3], ["articles", "declined", 1], ["run_files", "ignored", 7], ["run_files", "declined", 2]],
    "fields a run wrote that the platform does not keep are counted by the write: the evidence for storing one");
  assert.equal(byName.get("open_science_geo_value_upkeep_total")?.series.find((series) => series.labels?.event === "versionsPruned")?.value, 41,
    "the versions the upkeep pruned are counted (G10c)");
  assert.equal(new Map(geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null, inclusion: {} }).map((family) => [family.name, family])).has("open_science_geo_value_upkeep_total"), false);
  assert.equal(new Map(geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null, inclusion: {} }).map((family) => [family.name, family])).has("open_science_geo_run_import_total"), false);
  assert.equal(new Map(geoMetricFamilies(true, { tables: null, service: {}, social: null, worker: null, inclusion: {} }).map((family) => [family.name, family])).has("open_science_geo_inclusion_total"), false,
    "a deployment that never used the channel exports no series for it");
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
  assert.deepEqual([...alerts.keys()].sort(),
    ["GeoProbeEnginesPaused", "GeoProbeHostDown", "GeoProbeLoopStalled", "GeoSocialCrawlerDown", "GeoUrgentFindingsOpen"]);
  // The two external services are read by Prometheus's own blackbox jobs, not by a series this module exports.
  const prometheus = JSON.parse(await readFile(new URL("../../../deploy/web/monitoring/prometheus.json", import.meta.url), "utf8"));
  const jobs = new Set((prometheus.scrape_configs ?? []).map((config) => config.job_name));
  const blackbox = new Map([["GeoProbeHostDown", "geo-probe-host"], ["GeoSocialCrawlerDown", "geo-social-crawler"]]);
  const exported = new Set(geoMetricFamilies(true, {
    tables: { projects: 1, active: 1, openErrors: 1, urgentErrors: 1, safetyStops: 0, openRounds: 0 }, service: {}, social: null,
    worker: { loops: { probe: { wired: true, stalled: false, lastOkAt: null, last: { paused: 0 } } } },
  }).map((family) => family.name));
  for (const rule of group.rules) {
    if (blackbox.has(rule.alert)) {
      const job = blackbox.get(rule.alert);
      assert.match(String(rule.expr), new RegExp(`probe_success\\{job="${job}"\\}`), `${rule.alert} reads its blackbox job`);
      assert.ok(jobs.has(job), `${rule.alert} reads ${job}, which prometheus.json does not scrape`);
      continue;
    }
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

test("saving who speaks for the product writes the cards once, and what the cards could not do is theirs, never the save's (D-28)", async () => {
  const audits = /** @type {any[]} */ ([]);
  const refreshed = /** @type {any[]} */ ([]);
  const added = /** @type {any[]} */ ([]);
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} };
  const project = { id: "geo_mine", userId: "owner", projectId: "p" };
  const service = {
    allows: () => true, isOperator: () => false,
    async requireProject() { return project; },
    async updateProject(/** @type {any} */ _user, /** @type {string} */ id, /** @type {any} */ patch) { return { id, userId: "owner", projectId: "p", ...patch }; },
  };
  /** @type {() => Promise<any>} */
  let outcome = async () => ({ zoneId: "ez_1", cards: [{ cardId: "ec_1" }, { cardId: "ec_2" }], held: [], failed: [], skipped: [] });
  const cards = { refresh: async (/** @type {any} */ user, /** @type {any} */ found) => { refreshed.push([user.id, found.id, found.producer?.kind ?? null]); return outcome(); } };
  const members = { async list() { return []; }, async add(/** @type {any} */ input) { added.push(input.role); return { userId: input.userId, role: input.role }; }, async remove() { return { removed: 0 }; } };
  const routes = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536, cards, members, audit: async (event, status, details) => { audits.push([event, status, details.detail ?? null]); } });
  const producer = { kind: "doctor", name: "张医生" };
  const send = async (/** @type {string} */ method, /** @type {string} */ url, /** @type {unknown} */ body) => { const res = response(); await routes(request(method, url, body), res); return res.json().data; };

  // The producer saved: the cards are written once, as the project's owner, from the project as it now is.
  assert.deepEqual((await send("PATCH", "/api/geo/projects/geo_mine", { producer })).cards, { blockedBy: null, written: 2 });
  assert.deepEqual(refreshed, [["owner", "geo_mine", "doctor"]]);
  // A save that names no producer, or takes it away, writes nothing.
  await send("PATCH", "/api/geo/projects/geo_mine", { coverageDays: 60 });
  await send("PATCH", "/api/geo/projects/geo_mine", { producer: null });
  assert.equal(refreshed.length, 1);
  // The cards refused (nobody to review yet): the save stands, and the answer says what is missing.
  outcome = async () => { throw Object.assign(new Error("reviewer"), { status: 409, code: "geo_card_reviewer_required" }); };
  assert.deepEqual((await send("PATCH", "/api/geo/projects/geo_mine", { producer })).cards, { blockedBy: "reviewer", written: 0 });
  outcome = async () => { throw Object.assign(new Error("producer"), { status: 409, code: "geo_card_producer_required" }); };
  assert.equal((await send("PATCH", "/api/geo/projects/geo_mine", { producer })).cards.blockedBy, "producer");
  // Any other failure is audited and still never fails the save.
  outcome = async () => { throw Object.assign(new Error("zone"), { code: "evidence_zone_unavailable" }); };
  const failed = await send("PATCH", "/api/geo/projects/geo_mine", { producer });
  assert.deepEqual(failed.cards, { blockedBy: null, written: 0, failed: "evidence_zone_unavailable" });
  assert.deepEqual(audits.at(-1), ["geo.cards.refresh", "failed", "evidence_zone_unavailable"]);
  // The reviewing doctor named: the cards that waited for one are written. No other role changes who reviews.
  outcome = async () => ({ cards: [{ cardId: "ec_1" }], held: [], failed: [], skipped: [] });
  const before = refreshed.length;
  assert.deepEqual((await send("POST", "/api/geo/projects/geo_mine/members", { userId: "doc", role: "medical_reviewer" })).cards, { blockedBy: null, written: 1 });
  await send("POST", "/api/geo/projects/geo_mine/members", { userId: "viewer", role: "viewer" });
  await send("POST", "/api/geo/projects/geo_mine/members", { userId: "editor", role: "editor" });
  assert.deepEqual(added, ["medical_reviewer", "viewer", "editor"]);
  assert.equal(refreshed.length, before + 1);
  // Without the card hook a save is only a save.
  const bare = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536 });
  const res = response();
  await bare(request("PATCH", "/api/geo/projects/geo_mine", { producer }), res);
  assert.equal(res.json().data.cards, undefined);
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

test("a rename is one line of 1 to 40 characters, needs its hook, and is the project's name — not the brand's", async () => {
  const patched = /** @type {any[]} */ ([]), audited = /** @type {any[]} */ ([]);
  const store = { async ensureSessionUser() { return { user: { id: "editor" } }; }, async assertCsrf() {} };
  const service = {
    allows: () => true, isOperator: () => false,
    async updateProject(/** @type {any} */ _user, /** @type {string} */ id, /** @type {any} */ patch, /** @type {any} */ hooks) {
      patched.push([id, patch, typeof hooks?.renameControlProject]);
      return { id };
    },
  };
  const audit = async (/** @type {string} */ event, /** @type {string} */ status, /** @type {any} */ details) => { audited.push([event, status, details]); };
  const renamed = /** @type {any[]} */ ([]);
  const routes = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536, audit, projects: { create: async () => ({ id: "p", name: "p" }), bindSession: async () => ({ sessionId: "s", bound: true }), rename: async (...args) => { renamed.push(args); } } });
  for (const bad of ["", "   ", 7, null, "x".repeat(41)]) {
    await assert.rejects(routes(request("PATCH", "/api/geo/projects/geo_mine", { name: bad }), response()), { status: 400, code: "geo_project_name_invalid" });
  }
  assert.deepEqual(patched, [], "a refused name reaches no service");
  const res = response();
  await routes(request("PATCH", "/api/geo/projects/geo_mine", { name: "  波立维\n项目 " }), res);
  assert.deepEqual(patched, [["geo_mine", { name: "波立维 项目" }, "function"]]);
  assert.deepEqual(audited, [["geo.project.rename", "completed", { userId: "editor", code: "geo_mine" }]]);
  // Without the project hook a rename is a named 503 and nothing is patched.
  const bare = createGeoRoutes({ store, service, config, maxJsonBytes: 65_536 });
  await assert.rejects(bare(request("PATCH", "/api/geo/projects/geo_mine", { name: "新名字" }), response()), { status: 503, code: "geo_unavailable" });
  assert.equal(patched.length, 1);
  assert.deepEqual(renamed, [], "the route hands the hook over; the service is what calls it");
});

test("the service renames the owner's project for an editor, after the GEO row is patched, and a viewer cannot", async () => {
  const calls = /** @type {any[]} */ ([]);
  const project = { id: "geo_mine", userId: "owner", projectId: "ctl_1" };
  const store = {
    async getProjectAccess(/** @type {string} */ userId, /** @type {string} */ id) {
      if (id !== "geo_mine") return null;
      return { project, roles: userId === "owner" ? ["owner"] : userId === "editor" ? ["editor"] : ["viewer"] };
    },
    async updateProject(/** @type {string} */ ownerId, /** @type {string} */ id, /** @type {any} */ patch) { calls.push(["row", ownerId, id, patch]); return { id, tier: "base" }; },
  };
  const geo = new GeoService({ store: /** @type {any} */ (store), config, social: null, cards: null });
  const rename = async (/** @type {string} */ ownerId, /** @type {string} */ projectId, /** @type {string} */ name) => { calls.push(["rename", ownerId, projectId, name]); };
  const out = await geo.updateProject({ id: "editor" }, "geo_mine", { name: "新名字", tier: "base" }, { renameControlProject: rename });
  assert.deepEqual(calls, [["row", "owner", "geo_mine", { tier: "base" }], ["rename", "owner", "ctl_1", "新名字"]]);
  assert.equal(out.name, "新名字");
  calls.length = 0;
  await geo.updateProject({ id: "owner" }, "geo_mine", { tier: "base" }, { renameControlProject: rename });
  assert.deepEqual(calls.map((call) => call[0]), ["row"], "no name, no rename");
  await assert.rejects(geo.updateProject({ id: "reader" }, "geo_mine", { name: "x" }, { renameControlProject: rename }), { status: 403 });
  await assert.rejects(geo.updateProject({ id: "owner" }, "geo_mine", { name: "x" }), { status: 503, code: "geo_unavailable" });
  assert.equal(calls.length, 1, "a refusal wrote nothing more");
});
