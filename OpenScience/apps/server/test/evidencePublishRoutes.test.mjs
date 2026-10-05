// The co-creation routes against a stub store and doubles: the module off is a 404 by name, the audience check is the zone
// routes' own, every write passes the CSRF check, and each path reaches its one service with the caller's own account.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvidencePublishRoutes } from "../src/evidencePublishRoutes.mjs";

const RV = `rv_${"a".repeat(64)}`;

/** @param {string} method @param {string} url @param {any} [body] */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return {
    status: 0, headers: /** @type {Record<string, any>} */ ({}), body: "",
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

function fixture({ config = { frontierEnabled: true }, allows = true, composed = true } = {}) {
  const calls = /** @type {any[]} */ ([]);
  const audits = /** @type {any[]} */ ([]);
  const store = {
    async ensureSessionUser() { calls.push("session"); return { user: { id: "alice" } }; },
    async assertCsrf(_req, pathname) { calls.push(["csrf", pathname]); },
  };
  const routes = createEvidencePublishRoutes({
    store, config, maxJsonBytes: 65_536,
    frontier: composed ? { allows: () => allows } : null,
    publisher: composed ? { async publish(user, versionId, body) { calls.push(["publish", user.id, versionId, body]); return { created: body.projectId === "fresh", outcome: "created", evidence: { id: "ec_1" } }; } } : null,
    continuation: composed ? { async start(user, cardId, body) { calls.push(["continue", user.id, cardId, body]); return { library: { saved: [1], failed: [] }, originCardId: cardId }; } } : null,
    authors: composed ? {
      async page(user, authorId) { calls.push(["author", user.id, authorId]); return { author: { id: authorId } }; },
      async links(user, cardId) { calls.push(["links", user.id, cardId]); return { related: [] }; },
    } : null,
    audit: async (event, status, details) => { audits.push({ event, status, ...details }); },
  });
  return { routes, calls, audits };
}

test("other paths are not this factory's, and with the frontier off or not composed each of the four answers 404 by name", async () => {
  const { routes } = fixture();
  for (const path of ["/api/results", `/api/results/${RV}/export`, "/api/frontier/evidence", "/api/frontier/zones/ez_1", "/api/frontier/evidence/ec_1/other", "/api/frontier/authors"]) {
    assert.equal(await routes(request("GET", path), response()), false, path);
  }
  for (const make of [() => fixture({ config: { frontierEnabled: false } }), () => fixture({ composed: false })]) {
    const { routes: off } = make();
    for (const [method, path] of [["POST", `/api/results/${RV}/evidence-card`], ["POST", "/api/frontier/evidence/ec_1/continue"], ["GET", "/api/frontier/evidence/ec_1/links"], ["GET", "/api/frontier/authors/alice"]]) {
      await assert.rejects(off(request(method, path, method === "POST" ? {} : undefined), response()), { status: 404, code: "frontier_not_enabled" }, path);
    }
  }
});

test("the frontier audience check is the zone routes' own: a caller outside it gets the same 404", async () => {
  const { routes, calls } = fixture({ allows: false });
  await assert.rejects(routes(request("GET", "/api/frontier/authors/alice"), response()), { status: 404, code: "frontier_not_enabled" });
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] !== "csrf"), [], "no service was reached");
});

test("publishing a result passes the CSRF check, reaches the service with the caller and the result's id, and answers 201 for a new draft and 200 for the one that existed", async () => {
  const { routes, calls, audits } = fixture();
  const created = response();
  assert.equal(await routes(request("POST", `/api/results/${RV}/evidence-card`, { projectId: "fresh", zoneId: "ez_1" }), created), true);
  assert.equal(created.status, 201);
  assert.equal(created.json().data.evidence.id, "ec_1");
  assert.equal(created.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(calls.find((call) => call[0] === "publish"), ["publish", "alice", RV, { projectId: "fresh", zoneId: "ez_1" }]);
  assert.deepEqual(calls.find((call) => call[0] === "csrf"), ["csrf", `/api/results/${RV}/evidence-card`]);
  const again = response();
  await routes(request("POST", `/api/results/${RV}/evidence-card`, { projectId: "old", zoneId: "ez_1" }), again);
  assert.equal(again.status, 200);
  assert.equal(audits[0].event, "evidence.result_card");
  await assert.rejects(routes(request("GET", `/api/results/${RV}/evidence-card`), response()), { status: 405 });
  // A result id that is not a result id is not this route.
  assert.equal(await routes(request("POST", "/api/results/rv_short/evidence-card", {}), response()), false);
});

test("continuing and reading a card's links are the card's, and an author page is the author's", async () => {
  const { routes, calls } = fixture();
  const answer = response();
  await routes(request("POST", "/api/frontier/evidence/ec_1/continue", { projectId: "mine" }), answer);
  assert.equal(answer.status, 201);
  assert.equal(answer.json().data.originCardId, "ec_1");
  assert.deepEqual(calls.find((call) => call[0] === "continue"), ["continue", "alice", "ec_1", { projectId: "mine" }]);
  await assert.rejects(routes(request("GET", "/api/frontier/evidence/ec_1/continue"), response()), { status: 405 });
  const links = response();
  await routes(request("GET", "/api/frontier/evidence/ec_1/links"), links);
  assert.deepEqual(links.json(), { data: { related: [] } });
  await assert.rejects(routes(request("POST", "/api/frontier/evidence/ec_1/links", {}), response()), { status: 405 });
  const page = response();
  await routes(request("GET", "/api/frontier/authors/evimed-evidence-center"), page);
  assert.equal(page.json().data.author.id, "evimed-evidence-center");
  await assert.rejects(routes(request("POST", "/api/frontier/authors/alice", {}), response()), { status: 405 });
  const encoded = response();
  await routes(request("GET", "/api/frontier/authors/a%40b"), encoded);
  assert.equal(encoded.json().data.author.id, "a@b");
  await assert.rejects(routes(request("GET", "/api/frontier/authors/%E0%A4%A"), response()), { status: 400 });
});
