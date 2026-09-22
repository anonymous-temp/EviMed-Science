// The frontier routes against a stub store and service: who sees the module,
// who may operate it, the 304 path, and what a request body may carry.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { frontierAudienceAllows } from "../src/frontierService.mjs";
import { createFrontierRoutes, frontierRoutePattern } from "../src/frontierRoutes.mjs";

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

test("route labels fold ids so a dashboard row is a route", () => {
  assert.equal(frontierRoutePattern("/api/frontier/items"), "/api/frontier/items");
  assert.equal(frontierRoutePattern("/api/frontier/items/abc123"), "/api/frontier/items/:id");
  assert.equal(frontierRoutePattern("/api/frontier/items/abc123/star"), "/api/frontier/items/:id/:action");
  assert.equal(frontierRoutePattern("/api/frontier/follows/12"), "/api/frontier/follows/:id");
  assert.equal(frontierRoutePattern("/api/frontier/ops/sources/nejm/enabled"), "/api/frontier/ops/sources/:id/enabled");
  assert.equal(frontierRoutePattern("/api/frontier/events/e1"), "/api/frontier/events/:id");
  assert.equal(frontierRoutePattern("/api/frontier/whatever/x/y"), "/api/frontier/:route");
});
