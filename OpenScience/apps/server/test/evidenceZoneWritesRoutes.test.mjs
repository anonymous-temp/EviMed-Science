// The zone routes' write paths against a stub store, service and write side: which body goes to which writer, and that a route the
// write side does not compose answers as an unknown path does.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvidenceZoneRoutes } from "../src/evidenceZoneRoutes.mjs";

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

function fixture({ topicZones = ["ez_topic", "slug-topic"], withWrites = true } = {}) {
  const calls = [];
  const store = { async ensureSessionUser() { return { user: { id: "reader" } }; }, async assertCsrf(_req, path) { calls.push(["csrf", path]); } };
  const frontier = { allows: () => true };
  const service = {
    async list() { return { zones: [] }; },
    async save(_user, body, zoneId) { calls.push(["old-save", zoneId ?? null, body]); return { zone: { id: zoneId ?? "ez_old" } }; },
    async detail() { return { zone: { id: "x" } }; },
  };
  const writes = withWrites ? {
    async draft(_user, body) { calls.push(["draft", body]); return { draft: {} }; },
    async preview(_user, body) { calls.push(["preview", body]); return { preview: {} }; },
    async create(_user, body) { calls.push(["create", body]); return { zone: { id: "ez_new" } }; },
    async update(_user, id, body) { calls.push(["update", id, body]); return { zone: { id } }; },
    async remove(_user, id) { calls.push(["remove", id]); return { deleted: true }; },
    async feedback(_user, id, item, body) { calls.push(["feedback", id, item, body]); return { accepted: true }; },
    async isTopicZone(_user, id) { return topicZones.includes(id); },
  } : null;
  const routes = createEvidenceZoneRoutes({ store, service, frontier, config: { frontierEnabled: true }, maxJsonBytes: 65_536, writes });
  return { routes, calls };
}

test("a sentence is drafted and a definition previewed through the write side, behind the same session and CSRF check", async () => {
  const { routes, calls } = fixture();
  const draft = response();
  assert.equal(await routes(request("POST", "/api/frontier/zones/draft", { text: "ADC" }), draft), true);
  assert.deepEqual(draft.json(), { data: { draft: {} } });
  await routes(request("POST", "/api/frontier/zones/preview", { definition: { type: "policy" } }), response());
  assert.deepEqual(calls.filter((call) => call[0] !== "csrf"), [["draft", { text: "ADC" }], ["preview", { definition: { type: "policy" } }]]);
  assert.equal(calls.filter((call) => call[0] === "csrf").length, 2);
  assert.equal(draft.headers["Cache-Control"], "private, no-store");
});

test("POST /zones with a definition is a topic zone; the old body, a name and a description, is still the old zone", async () => {
  const { routes, calls } = fixture();
  await routes(request("POST", "/api/frontier/zones", { title: "T", definition: { type: "policy" }, published: false }), response());
  await routes(request("POST", "/api/frontier/zones", { title: "Old", description: "d" }), response());
  assert.deepEqual(calls.filter((call) => call[0] !== "csrf").map((call) => call[0]), ["create", "old-save"]);
});

test("PATCH on a topic zone, by id or slug, is the topic write, whatever it changes; on any other zone it is the old one", async () => {
  const { routes, calls } = fixture();
  await routes(request("PATCH", "/api/frontier/zones/ez_topic", { title: "T", expectedRevision: 1 }), response());
  await routes(request("PATCH", "/api/frontier/zones/slug-topic", { published: true, expectedRevision: 2 }), response());
  await routes(request("PATCH", "/api/frontier/zones/ez_card_zone", { title: "Old", expectedRevision: 1 }), response());
  assert.deepEqual(calls.filter((call) => call[0] !== "csrf"), [
    ["update", "ez_topic", { title: "T", expectedRevision: 1 }],
    ["update", "slug-topic", { published: true, expectedRevision: 2 }],
    ["old-save", "ez_card_zone", { title: "Old", expectedRevision: 1 }],
  ]);
});

test("DELETE and an item's feedback are the write side's; a path with a bad part is refused before anything runs", async () => {
  const { routes, calls } = fixture();
  const removed = response();
  await routes(request("DELETE", "/api/frontier/zones/ez_topic"), removed);
  assert.deepEqual(removed.json(), { data: { deleted: true } });
  await routes(request("POST", "/api/frontier/zones/ez_topic/items/abcdef123456/feedback", { kind: "not-in" }), response());
  assert.deepEqual(calls.filter((call) => call[0] !== "csrf"), [["remove", "ez_topic"], ["feedback", "ez_topic", "abcdef123456", { kind: "not-in" }]]);
  await assert.rejects(routes(request("POST", "/api/frontier/zones/ez_topic/items/bad%20id/feedback", {}), response()), { code: "evidence_invalid" });
  await assert.rejects(routes(request("DELETE", "/api/frontier/zones/ez_topic/extra/parts"), response()), { status: 404 });
});

test("without a write side none of the new paths exists, and the old ones are as they were", async () => {
  const { routes, calls } = fixture({ withWrites: false });
  await assert.rejects(routes(request("POST", "/api/frontier/zones/draft", {}), response()), { status: 404 });
  await assert.rejects(routes(request("DELETE", "/api/frontier/zones/ez_topic"), response()), { status: 404 });
  await routes(request("POST", "/api/frontier/zones", { title: "Old", definition: "ignored by the old writer" }), response());
  assert.deepEqual(calls.filter((call) => call[0] === "old-save").length, 1);
});
