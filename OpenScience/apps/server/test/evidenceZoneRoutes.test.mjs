// The topic zones' GET routes against stubs: what each hands the read side, that a zone is addressed by its slug as by its id, that a
// zone the reads do not answer falls back to the old service, and that without the read side every route is what it was.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvidenceZoneRoutes } from "../src/evidenceZoneRoutes.mjs";

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

function fixture({ withReads = true, enabled = true, topic = true } = {}) {
  /** @type {any[]} */ const calls = [];
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf() {} };
  const service = {
    async list(user, params, zone) { calls.push(["service.list", user.id, params.get("scope"), zone ?? null]); return { items: [], total: 0 }; },
    async detail(user, id) { calls.push(["service.detail", id]); return { zone: { id, old: true }, feedback: [] }; },
    async act(user, id, action) { calls.push(["service.act", id, action]); return { zone: { id, old: true } }; },
  };
  const reads = {
    async resolveId(user, ref) { calls.push(["resolveId", ref]); return ref === "glp1-obesity" ? "ez_glp1" : ref; },
    async directory(user, params) { calls.push(["directory", user.id, params.get("view"), params.get("q")]); return { view: params.get("view"), groups: [], zones: [], total: 0 }; },
    async detail(user, id) { calls.push(["detail", id]); return topic ? { zone: { id, topic: true }, feedback: [] } : null; },
    async overview(user, id) { calls.push(["overview", id]); return { zoneId: id, modules: [] }; },
    async items(user, id, params) { calls.push(["items", id, params.get("role"), params.get("cursor")]); return { items: [], nextCursor: null }; },
    async cards(user, id) { calls.push(["cards", id]); return { cards: [], provider: "none" }; },
  };
  const routes = createEvidenceZoneRoutes({ store, service, frontier: { allows: () => true }, config: { frontierEnabled: enabled }, maxJsonBytes: 65_536, ...(withReads ? { reads } : {}) });
  return { routes, calls };
}

const get = async (routes, url) => { const res = response(); assert.equal(await routes(request("GET", url), res), true, url); assert.equal(res.status, 200); return res.json().data; };

test("a view makes the list the directory; without one the old list is what answers", async () => {
  const { routes, calls } = fixture();
  assert.equal((await get(routes, "/api/frontier/zones?view=community&q=%E5%87%8F%E9%87%8D")).view, "community");
  await get(routes, "/api/frontier/zones?scope=owned");
  assert.deepEqual(calls, [["directory", "reader", "community", "减重"], ["service.list", "reader", "owned", null]]);
});

test("a zone is addressed by its slug as by its id, and a topic zone's detail is the reads', any other zone's the old service's", async () => {
  const { routes, calls } = fixture();
  assert.deepEqual(await get(routes, "/api/frontier/zones/glp1-obesity"), { zone: { id: "ez_glp1", topic: true }, feedback: [] });
  assert.deepEqual(calls, [["resolveId", "glp1-obesity"], ["detail", "ez_glp1"]]);
  const other = fixture({ topic: false });
  assert.deepEqual(await get(other.routes, "/api/frontier/zones/ez_card_zone"), { zone: { id: "ez_card_zone", old: true }, feedback: [] });
  assert.deepEqual(other.calls, [["resolveId", "ez_card_zone"], ["detail", "ez_card_zone"], ["service.detail", "ez_card_zone"]]);
});

test("overview, the dynamics list and the cards are reads of the resolved zone with the query as it came", async () => {
  const { routes, calls } = fixture();
  assert.equal((await get(routes, "/api/frontier/zones/glp1-obesity/overview")).zoneId, "ez_glp1");
  await get(routes, "/api/frontier/zones/ez_glp1/items?role=research&cursor=abc");
  assert.deepEqual(await get(routes, "/api/frontier/zones/glp1-obesity/cards"), { cards: [], provider: "none" });
  assert.deepEqual(calls, [["resolveId", "glp1-obesity"], ["overview", "ez_glp1"], ["resolveId", "ez_glp1"], ["items", "ez_glp1", "research", "abc"],
    ["resolveId", "glp1-obesity"], ["cards", "ez_glp1"]]);
});

test("following a topic zone answers with the zone as its page holds it; the writer's words are not zones", async () => {
  const { routes, calls } = fixture();
  const res = response();
  const post = Object.assign(Readable.from([Buffer.from(JSON.stringify({ expectedRevision: 1 }))]), { method: "POST", url: "/api/frontier/zones/glp1-obesity/follow", headers: { "content-type": "application/json" } });
  assert.equal(await routes(post, res), true);
  assert.deepEqual(res.json().data, { zone: { id: "ez_glp1", topic: true } });
  assert.deepEqual(calls.map((call) => call[0]), ["resolveId", "service.act", "detail"]);
  const noTopic = fixture({ topic: false });
  const second = response();
  await noTopic.routes(Object.assign(Readable.from([Buffer.from(JSON.stringify({ expectedRevision: 1 }))]), { method: "POST", url: "/api/frontier/zones/ez_card_zone/follow", headers: { "content-type": "application/json" } }), second);
  assert.deepEqual(second.json().data, { zone: { id: "ez_card_zone", old: true } });
  // `draft` and `preview` are never looked up as a slug.
  const writer = fixture();
  await assert.rejects(writer.routes(request("POST", "/api/frontier/zones/draft"), response()), (error) => /** @type {any} */ (error).status === 404);
  assert.ok(!writer.calls.some((call) => call[0] === "resolveId"));
});

test("without the read side the routes are what they were; off, the module's own 404", async () => {
  const { routes, calls } = fixture({ withReads: false });
  for (const url of ["/api/frontier/zones/glp1-obesity/overview", "/api/frontier/zones/ez_x/items", "/api/frontier/zones/ez_x/cards"]) {
    await assert.rejects(routes(request("GET", url), response()), (error) => /** @type {any} */ (error).status === 404 && /** @type {any} */ (error).code === "not_found", url);
  }
  assert.deepEqual(await get(routes, "/api/frontier/zones?view=mine"), { items: [], total: 0 }, "a view parameter is the old list's to ignore");
  assert.deepEqual(await get(routes, "/api/frontier/zones/glp1-obesity"), { zone: { id: "glp1-obesity", old: true }, feedback: [] });
  assert.ok(calls.every((call) => String(call[0]).startsWith("service.")));
  const off = fixture({ enabled: false });
  await assert.rejects(off.routes(request("GET", "/api/frontier/zones/ez_x/overview"), response()), (error) => /** @type {any} */ (error).code === "frontier_not_enabled");
  const bad = fixture();
  await assert.rejects(bad.routes(request("GET", "/api/frontier/zones/a%20b/overview"), response()), (error) => /** @type {any} */ (error).code === "evidence_invalid");
});
