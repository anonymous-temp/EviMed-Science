// 追踪's routes against a stub store and service: who sees them, what they hand the service, and the label a dashboard row gets.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createFrontierRoutes, frontierRoutePattern } from "../src/frontierRoutes.mjs";

/** @param {string} method @param {string} url */
function request(method, url) {
  return Object.assign(Readable.from([]), { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return {
    status: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}
function fixture(enabled = true) {
  const calls = /** @type {any[]} */ ([]);
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} };
  const service = {
    allows: () => true,
    async trackApprovals(user, params) { calls.push(["approvals", user.id, params.get("agency"), params.get("cursor")]); return { items: [], nextCursor: null }; },
    async trackGuidelines(user, params) { calls.push(["guidelines", user.id, params.get("specialty")]); return { items: [], nextCursor: null }; },
    async trackCongresses() { calls.push(["congresses"]); return { congresses: [] }; },
    async trackCongress(user, id) { calls.push(["congress", user.id, id]); return { congress: { id } }; },
  };
  return { routes: createFrontierRoutes({ store, service, config: { frontierEnabled: enabled, frontierAudience: "all" }, maxJsonBytes: 65_536 }), calls };
}

test("the four track routes hand the reader and their query to the service and answer in the envelope", async () => {
  const { routes, calls } = fixture();
  for (const [url, expected] of [
    ["/api/frontier/track/approvals?agency=fda&cursor=abc", { items: [], nextCursor: null }],
    ["/api/frontier/track/guidelines?specialty=oncology", { items: [], nextCursor: null }],
    ["/api/frontier/track/congresses", { congresses: [] }],
    ["/api/frontier/track/congresses/esmo-2026", { congress: { id: "esmo-2026" } }],
  ]) {
    const res = response();
    assert.equal(await routes(request("GET", url), res), true, url);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { data: expected });
  }
  assert.deepEqual(calls, [["approvals", "reader", "fda", "abc"], ["guidelines", "reader", "oncology"], ["congresses"], ["congress", "reader", "esmo-2026"]]);
});

test("the track routes are reads: a write, an unknown segment or a deeper path is a 404 by name; off, the module's own 404", async () => {
  const { routes } = fixture();
  for (const [method, url] of [["POST", "/api/frontier/track/approvals"], ["GET", "/api/frontier/track/nothing"], ["GET", "/api/frontier/track/approvals/x"], ["GET", "/api/frontier/track"]]) {
    await assert.rejects(routes(request(method, url), response()), (error) => /** @type {any} */ (error).status === 404 && /** @type {any} */ (error).code === "not_found", `${method} ${url}`);
  }
  const off = fixture(false);
  await assert.rejects(off.routes(request("GET", "/api/frontier/track/approvals"), response()), (error) => /** @type {any} */ (error).code === "frontier_not_enabled");
});

test("a dashboard row is a route: the congress's id folds, the segment stays", () => {
  assert.equal(frontierRoutePattern("/api/frontier/track/approvals"), "/api/frontier/track/approvals");
  assert.equal(frontierRoutePattern("/api/frontier/track/congresses"), "/api/frontier/track/congresses");
  assert.equal(frontierRoutePattern("/api/frontier/track/congresses/esmo-2026"), "/api/frontier/track/congresses/:id");
  // Anything else under track/ is one label: a request cannot mint a metric series.
  assert.equal(frontierRoutePattern("/api/frontier/track/x9f3k2"), "/api/frontier/track/:route");
  assert.equal(frontierRoutePattern("/api/frontier/track/approvals/extra"), "/api/frontier/track/:route");
});
