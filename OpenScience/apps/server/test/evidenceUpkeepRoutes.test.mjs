// The routes of keeping evidence current against stubs: the one switch, the same door as the zone routes (a signed-in account in the frontier's
// audience, CSRF), what each path hands to the module behind it, and that the zone's change log is read only by someone who may read the zone.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvidenceUpkeepRoutes } from "../src/evidenceUpkeepRoutes.mjs";

/** @param {string} method @param {string} url @param {any} [body] */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

/** @param {{ enabled?: boolean, allowed?: boolean, hidden?: boolean }} [state] */
function fixture({ enabled = true, allowed = true, hidden = false } = {}) {
  /** @type {any[]} */ const calls = [];
  const store = { async ensureSessionUser() { calls.push("session"); return { user: { id: "reader" } }; }, async assertCsrf() { calls.push("csrf"); } };
  const service = { database: { transaction: async (/** @type {any} */ work) => work({}) }, async zoneRow(/** @type {any} */ _client, /** @type {any} */ _user, /** @type {string} */ id) { if (hidden) throw Object.assign(new Error("hidden"), { status: 404, code: "evidence_not_found" }); calls.push(["zone", id]); return { id }; } };
  const challenges = {
    async submit(/** @type {any} */ user, /** @type {string} */ card, /** @type {any} */ body) { calls.push(["submit", user.id, card, body]); return { challenge: { id: "ch_1" } }; },
    async listFor(/** @type {any} */ user, /** @type {string} */ card) { calls.push(["mine", user.id, card]); return { items: [] }; },
  };
  const upkeep = { async setUpkeep(/** @type {any} */ user, /** @type {string} */ card, /** @type {any} */ body) { calls.push(["upkeep", user.id, card, body]); return { currency: "no_longer_updated" }; } };
  const changeLog = { async list(/** @type {any} */ query) { calls.push(["log", query]); return { items: [], nextBefore: null }; } };
  const routes = createEvidenceUpkeepRoutes({ store, service, frontier: { allows: () => allowed }, config: { frontierEnabled: true, evidenceUpkeepEnabled: enabled }, challenges, upkeep, changeLog, maxJsonBytes: 4096 });
  return { routes, calls };
}

test("other paths are not this factory's, and the zone routes' own are left to them", async () => {
  const { routes } = fixture();
  for (const path of ["/api/frontier/zones", "/api/frontier/zones/z1", "/api/frontier/zones/z1/evidence", "/api/frontier/evidence", "/api/frontier/items", "/api/inbox"])
    assert.equal(await routes(request("GET", path), response()), false, path);
  assert.equal(await routes(request("GET", "/api/frontier/evidence/c1/comments"), response()), false);
  assert.equal(await routes(request("GET", "/api/frontier/zones/z1/follow"), response()), false);
});

test("off, each of the four paths is a 404 by name and nothing is asked of anyone", async () => {
  const { routes, calls } = fixture({ enabled: false });
  for (const [method, path] of [["POST", "/api/frontier/evidence/c1/challenges"], ["GET", "/api/frontier/evidence/c1/challenges"], ["POST", "/api/frontier/evidence/c1/upkeep"], ["GET", "/api/frontier/zones/z1/changes"]])
    await assert.rejects(routes(request(method, path), response()), { status: 404, code: "evidence_upkeep_not_enabled" }, path);
  assert.deepEqual(calls, []);
  const bare = createEvidenceUpkeepRoutes({ store: {}, service: null, frontier: null, config: { frontierEnabled: true, evidenceUpkeepEnabled: true }, challenges: null, upkeep: null, changeLog: null, maxJsonBytes: 1024 });
  await assert.rejects(bare(request("GET", "/api/frontier/zones/z1/changes"), response()), { code: "evidence_upkeep_not_enabled" });
});

test("the same door as the zones: a signed-in account in the frontier's audience, and CSRF", async () => {
  await assert.rejects(fixture({ allowed: false }).routes(request("GET", "/api/frontier/zones/z1/changes"), response()), { status: 404, code: "frontier_not_enabled" });
  const { routes, calls } = fixture();
  await routes(request("POST", "/api/frontier/evidence/c1/challenges", { claimId: "CLM-1", reason: "原文不一致" }), response());
  assert.deepEqual(calls.slice(0, 2), ["session", "csrf"]);
  await assert.rejects(routes(request("GET", "/api/frontier/evidence/c%2F1/challenges"), response()), { code: "evidence_invalid" }, "a path segment is a plain id");
});

test("a challenge is posted with its claim and reason, the reader's own are listed, and the producer's word about a card is posted to /upkeep", async () => {
  const { routes, calls } = fixture();
  const posted = response();
  assert.equal(await routes(request("POST", "/api/frontier/evidence/ec_1/challenges", { claimId: "CLM-1", reason: "原文不一致" }), posted), true);
  assert.equal(posted.status, 200);
  assert.deepEqual(posted.json(), { data: { challenge: { id: "ch_1" } } });
  assert.equal(posted.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(calls.find((call) => call[0] === "submit"), ["submit", "reader", "ec_1", { claimId: "CLM-1", reason: "原文不一致" }]);
  await routes(request("GET", "/api/frontier/evidence/ec_1/challenges"), response());
  assert.deepEqual(calls.at(-1), ["mine", "reader", "ec_1"]);
  const word = response();
  await routes(request("POST", "/api/frontier/evidence/ec_1/upkeep", { action: "retire" }), word);
  assert.deepEqual(word.json(), { data: { currency: "no_longer_updated" } });
  assert.deepEqual(calls.at(-1), ["upkeep", "reader", "ec_1", { action: "retire" }]);
  await assert.rejects(routes(request("DELETE", "/api/frontier/evidence/ec_1/challenges"), response()), { status: 404, code: "not_found" });
  await assert.rejects(routes(request("GET", "/api/frontier/evidence/ec_1/upkeep"), response()), { status: 404, code: "not_found" });
});

test("the zone's change log is read only by someone who may read the zone, newest first, in pages", async () => {
  const { routes, calls } = fixture();
  const res = response();
  assert.equal(await routes(request("GET", "/api/frontier/zones/z1/changes?cardId=ec_1&limit=20&before=77"), res), true);
  assert.deepEqual(res.json(), { data: { items: [], nextBefore: null } });
  assert.deepEqual(calls.find((call) => call[0] === "log"), ["log", { zoneId: "z1", cardId: "ec_1", limit: 20, before: "77" }]);
  assert.deepEqual(calls.find((call) => call[0] === "zone"), ["zone", "z1"]);
  await routes(request("GET", "/api/frontier/zones/z1/changes"), response());
  assert.deepEqual(calls.at(-1), ["log", { zoneId: "z1", cardId: null, before: null }]);
  await assert.rejects(routes(request("GET", "/api/frontier/zones/z1/changes?cardId=a%2Fb"), response()), { code: "evidence_query_invalid" });
  await assert.rejects(routes(request("POST", "/api/frontier/zones/z1/changes", {}), response()), { status: 404, code: "not_found" }, "the log has no write path");
  const hidden = fixture({ hidden: true });
  await assert.rejects(hidden.routes(request("GET", "/api/frontier/zones/z1/changes"), response()), { status: 404, code: "evidence_not_found" });
  assert.equal(hidden.calls.some((call) => call[0] === "log"), false, "a zone the reader cannot see has no history for them either");
});
