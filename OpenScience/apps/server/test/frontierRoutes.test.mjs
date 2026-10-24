// The frontier routes against a stub store and service: who sees the module,
// who may operate it, the 304 path, and what a request body may carry.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { frontierAudienceAllows } from "../src/frontierService.mjs";
import { createFrontierRoutes, frontierEventsBeacon, frontierRoutePattern } from "../src/frontierRoutes.mjs";

/** A request as the route reads one. @param {string} method @param {string} url @param {{ body?: any, headers?: Record<string, string> }} [options] */
function request(method, url, { body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json", ...headers } });
}

function response() {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

/** @param {Record<string, any>} config @param {string} userId */
function fixture(config, userId = "reader") {
  const calls = [];
  const audits = [];
  const store = {
    async ensureSessionUser() { return { user: { id: userId } }; },
    async assertCsrf() { calls.push("csrf"); },
  };
  const service = {
    allows: (user) => frontierAudienceAllows(config, user),
    isOperator: (user) => (config.operatorUsers ?? []).includes(user.id),
    async statusAnswer() { return { status: 200, etag: 'W/"status.1"', body: { enabled: true } }; },
    async listItems(_user, params, ifNoneMatch) {
      calls.push(["list", params.get("view")]);
      return ifNoneMatch === 'W/"1.0.abc"' ? { status: 304, etag: 'W/"1.0.abc"' } : { status: 200, etag: 'W/"1.0.abc"', body: { items: [], nextCursor: null, version: "1", mode: "list" } };
    },
    async getItem() { return { status: 200, etag: 'W/"1.0.item"', body: { item: { id: "abc" } } }; },
    async setItemState(_user, id, action) { calls.push([action, id]); return { state: { starred: action === "star", hidden: false, read: false } }; },
    async sources() { return { sources: [] }; },
    async listFollows() { return { follows: [] }; },
    async createFollow(_user, body) { return { follow: { id: "1", ...body } }; },
    async deleteFollow() { return { deleted: true }; },
    async operateItem(id, action, input) { calls.push([`ops-${action}`, id, input.reason]); return { item: { id, state: action === "withdraw" ? "withdrawn" : "published" } }; },
    async setSourceEnabled(id, enabled) { return { source: { id, enabled } }; },
    async weeklies(params) { return { weeklies: [{ weekStart: "2026-09-21", limit: params.get("limit") }] }; },
    async weeklyIssue(user, week) { calls.push(["weekly", user.id, week]); return { weekly: { weekStart: week } }; },
    async hot(params) { calls.push(["hot", params.get("window")]); return { window: params.get("window") ?? "current", events: [] }; },
    interactions: { async record(user, body) { calls.push(["events", user.id, body.events.length]); return { accepted: body.events.length, duplicates: 0, dropped: {} }; } },
    async prefs(user) { calls.push(["prefs", user.id]); return { role: null, specialties: [], interests: [], onboardedAt: null, skippedAt: null, interestTags: [] }; },
    async savePrefs(user, body) { calls.push(["save-prefs", user.id, body]); return { role: body.role ?? null }; },
  };
  const routes = createFrontierRoutes({ store, service, config, maxJsonBytes: 65_536,
    audit: async (event, status, details) => { audits.push({ event, status, ...details }); } });
  return { routes, calls, audits };
}

const on = { frontierEnabled: true, frontierAudience: "all", operatorUsers: ["ops"], frontierPreviewUsers: ["preview"] };

test("off, every frontier path is a 404 by name, and other paths are not this factory's", async () => {
  const { routes } = fixture({ ...on, frontierEnabled: false });
  assert.equal(await routes(request("GET", "/api/inbox"), response()), false);
  assert.equal(await routes(request("GET", "/api/frontierx"), response()), false);
  for (const path of ["/api/frontier", "/api/frontier/status", "/api/frontier/items?view=all", "/api/frontier/nope"]) {
    await assert.rejects(routes(request("GET", path), response()), { status: 404, code: "frontier_not_enabled" });
  }
  const noService = createFrontierRoutes({ store: {}, service: null, config: on, maxJsonBytes: 1024 });
  await assert.rejects(noService(request("GET", "/api/frontier/status"), response()), { code: "frontier_not_enabled" });
});

test("with the operators audience only operators and the preview list see it; everyone else gets the same 404", async () => {
  const audience = { ...on, frontierAudience: "operators" };
  await assert.rejects(fixture(audience, "reader").routes(request("GET", "/api/frontier/status"), response()), { code: "frontier_not_enabled" });
  for (const userId of ["ops", "preview"]) {
    const res = response();
    assert.equal(await fixture(audience, userId).routes(request("GET", "/api/frontier/status"), res), true);
    assert.equal(res.status, 200);
  }
});

test("lists carry their tag and answer a matching If-None-Match with an empty 304", async () => {
  const { routes } = fixture(on);
  const res = response();
  await routes(request("GET", "/api/frontier/items?view=all"), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers.ETag, 'W/"1.0.abc"');
  assert.equal(res.headers["Cache-Control"], "private, no-cache");
  assert.deepEqual(res.json(), { data: { items: [], nextCursor: null, version: "1", mode: "list" } });
  const cached = response();
  await routes(request("GET", "/api/frontier/items?view=all", { headers: { "if-none-match": 'W/"1.0.abc"' } }), cached);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");
  const item = response();
  await routes(request("GET", "/api/frontier/items/abc"), item);
  assert.deepEqual(item.json(), { data: { item: { id: "abc" } } });
});

test("a reader's writes take no fields they do not name, and the CSRF check runs on every request", async () => {
  const { routes, calls } = fixture(on);
  const res = response();
  await routes(request("POST", "/api/frontier/items/abc123def456/star", { body: {} }), res);
  assert.deepEqual(res.json(), { data: { state: { starred: true, hidden: false, read: false } } });
  assert.ok(calls.includes("csrf"));
  await assert.rejects(routes(request("POST", "/api/frontier/items/abc/star", { body: { extra: 1 } }), response()), { code: "frontier_payload_invalid" });
  await assert.rejects(routes(request("POST", "/api/frontier/items/abc/like", { body: {} }), response()), { code: "not_found" });
  const follow = response();
  await routes(request("POST", "/api/frontier/follows", { body: { kind: "drug", key: "semaglutide", label: "司美格鲁肽", muted: false } }), follow);
  assert.equal(follow.json().data.follow.key, "semaglutide");
  await assert.rejects(routes(request("POST", "/api/frontier/follows", { body: { kind: "drug", key: "x", owner: "someone" } }), response()), { code: "frontier_payload_invalid" });
  const removed = response();
  await routes(request("DELETE", "/api/frontier/follows/7"), removed);
  assert.deepEqual(removed.json(), { data: { deleted: true } });
});

test("operator routes answer 403 to anyone else, and an operator's change is audited", async () => {
  await assert.rejects(fixture(on, "preview").routes(request("POST", "/api/frontier/ops/items/abc/withdraw", { body: { reason: "x" } }), response()),
    { status: 403, code: "frontier_operator_required" }, "the preview list sees the module; it does not operate it");
  const { routes, audits, calls } = fixture(on, "ops");
  const res = response();
  await routes(request("POST", "/api/frontier/ops/items/abc/withdraw", { body: { reason: "Retracted" } }), res);
  assert.equal(res.json().data.item.state, "withdrawn");
  assert.deepEqual(calls.at(-1), ["ops-withdraw", "abc", "Retracted"]);
  assert.deepEqual(audits, [{ event: "frontier.item.withdraw", status: "completed", userId: "ops", code: "abc", detail: "Retracted" }]);
  await assert.rejects(routes(request("POST", "/api/frontier/ops/items/abc/pin", { body: { reason: 7 } }), response()), { code: "frontier_operation_invalid" });
  const source = response();
  await routes(request("POST", "/api/frontier/ops/sources/nejm/enabled", { body: { enabled: false } }), source);
  assert.deepEqual(source.json(), { data: { source: { id: "nejm", enabled: false } } });
  assert.equal(audits.at(-1).event, "frontier.source.enabled");
});

test("the hot list hands its window to the service: the current list by default, a week's or a month's ranking when asked", async () => {
  const { routes, calls } = fixture(on);
  const current = response();
  await routes(request("GET", "/api/frontier/hot"), current);
  assert.deepEqual(current.json(), { data: { window: "current", events: [] } });
  const week = response();
  await routes(request("GET", "/api/frontier/hot?window=week"), week);
  assert.deepEqual(week.json().data.window, "week");
  assert.deepEqual(calls.filter((call) => call[0] === "hot"), [["hot", null], ["hot", "week"]]);
  assert.equal(frontierRoutePattern("/api/frontier/hot"), "/api/frontier/hot");
});

test("route labels fold ids so a dashboard row is a route", () => {
  assert.equal(frontierRoutePattern("/api/frontier/items"), "/api/frontier/items");
  assert.equal(frontierRoutePattern("/api/frontier/items/abc123"), "/api/frontier/items/:id");
  assert.equal(frontierRoutePattern("/api/frontier/items/abc123/star"), "/api/frontier/items/:id/:action");
  assert.equal(frontierRoutePattern("/api/frontier/follows/12"), "/api/frontier/follows/:id");
  assert.equal(frontierRoutePattern("/api/frontier/ops/sources/nejm/enabled"), "/api/frontier/ops/sources/:id/enabled");
  assert.equal(frontierRoutePattern("/api/frontier/events/e1"), "/api/frontier/events/:id");
  assert.equal(frontierRoutePattern("/api/frontier/whatever/x/y"), "/api/frontier/:route");
});

test("weekly routes use the authenticated reader and preserve the archive envelope", async () => {
  const { routes, calls } = fixture(on, "ordinary-reader");
  const archive = response(); await routes(request("GET", "/api/frontier/weeklies?limit=5"), archive);
  assert.equal(archive.json().data.weeklies[0].weekStart, "2026-09-21");
  const issue = response(); await routes(request("GET", "/api/frontier/weeklies/2026-09-21?userId=another"), issue);
  assert.equal(issue.json().data.weekly.weekStart, "2026-09-21");
  assert.deepEqual(calls.filter(call => Array.isArray(call)), [["weekly", "ordinary-reader", "2026-09-21"]]);
  assert.equal(frontierRoutePattern("/api/frontier/weeklies/2026-09-21"), "/api/frontier/weeklies/:id");
});

test("events: a batch goes to the interactions with the reader, no field but the events and the token; without the module the route is unknown", async () => {
  const { routes, calls } = fixture(on);
  const accepted = response();
  await routes(request("POST", "/api/frontier/events", { body: { events: [{}, {}], csrf: "t" } }), accepted);
  assert.deepEqual(accepted.json(), { data: { accepted: 2, duplicates: 0, dropped: {} } });
  assert.deepEqual(calls.filter((call) => call[0] === "events"), [["events", "reader", 2]]);
  assert.ok(calls.includes("csrf"), "the CSRF check runs here too");
  const extra = response();
  await assert.rejects(routes(request("POST", "/api/frontier/events", { body: { events: [], url: "https://example.org" } }), extra), { code: "frontier_payload_invalid" });
  const noModule = createFrontierRoutes({ store: { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} },
    service: { allows: () => true, isOperator: () => false }, config: on, maxJsonBytes: 65_536 });
  await assert.rejects(noModule(request("POST", "/api/frontier/events", { body: { events: [{}] } }), response()), { code: "not_found" });
  assert.equal(frontierRoutePattern("/api/frontier/events"), "/api/frontier/events");
  assert.equal(frontierRoutePattern("/api/frontier/prefs"), "/api/frontier/prefs");
});

test("the beacon: its body's token is moved into the header the one CSRF check reads, for the events route alone, and the batch is kept for the route", async () => {
  const beacon = request("POST", "/api/frontier/events", { body: { events: [{ id: "x" }], csrf: "token-from-body" }, headers: { "content-type": "text/plain;charset=UTF-8" } });
  await frontierEventsBeacon(beacon);
  assert.equal(beacon.headers["x-open-science-csrf"], "token-from-body");
  assert.deepEqual(beacon.frontierEventsBody, { events: [{ id: "x" }], csrf: "token-from-body" });
  const withHeader = request("POST", "/api/frontier/events", { body: { events: [], csrf: "other" }, headers: { "x-open-science-csrf": "from-header" } });
  await frontierEventsBeacon(withHeader);
  assert.equal(withHeader.headers["x-open-science-csrf"], "from-header", "a request that set the header keeps it, and its body is not read here");
  assert.equal(withHeader.frontierEventsBody, undefined);
  const elsewhere = request("POST", "/api/frontier/items/abc/star", { body: { csrf: "smuggled" } });
  await frontierEventsBeacon(elsewhere);
  assert.equal(elsewhere.headers["x-open-science-csrf"], undefined, "no other route takes a token from its body");
  const noToken = request("POST", "/api/frontier/events", { body: { events: [] } });
  await frontierEventsBeacon(noToken);
  assert.equal(noToken.headers["x-open-science-csrf"], undefined, "without a token the CSRF check refuses it as it refuses any other");
  // The route reads the batch the beacon kept: the stream was read once.
  const { routes, calls } = fixture(on);
  await routes(beacon, response());
  assert.deepEqual(calls.filter((call) => call[0] === "events"), [["events", "reader", 1]]);
});

test("prefs: read and saved for the signed-in reader, with no field it does not name", async () => {
  const { routes, calls } = fixture(on);
  const read = response();
  await routes(request("GET", "/api/frontier/prefs"), read);
  assert.equal(read.json().data.role, null);
  const saved = response();
  await routes(request("PUT", "/api/frontier/prefs", { body: { role: "pharmacist", specialties: ["cardiology"], interests: [], done: true } }), saved);
  assert.equal(saved.json().data.role, "pharmacist");
  assert.deepEqual(calls.filter((call) => call[0] === "save-prefs")[0], ["save-prefs", "reader", { role: "pharmacist", specialties: ["cardiology"], interests: [], done: true }]);
  await assert.rejects(routes(request("PUT", "/api/frontier/prefs", { body: { email: "x" } }), response()), { code: "frontier_payload_invalid" });
});
