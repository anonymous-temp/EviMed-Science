// The operator's routes of the evidence programme against doubles: operators only, a session and CSRF, the switch, what each path hands to
// the programme and what it answers.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createEvidenceProgrammeRoutes } from "../src/evidenceProgrammeRoutes.mjs";

/** @param {string} method @param {string} url @param {any} [body] */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return { status: 0, headers: /** @type {Record<string, string>} */ ({}), body: "", writeHead(/** @type {number} */ status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
}

/** @param {{ enabled?: boolean, user?: string, run?: any }} [state] */
function fixture({ enabled = true, user = "operator", run = { state: "decided", id: "programme-decision-2026-10-06", decision: { day: "2026-10-06", source: "model", actions: [], outcomes: {}, costCny: 0.01 } } } = {}) {
  /** @type {any[]} */ const calls = [];
  const store = { async ensureSessionUser() { calls.push("session"); return { user: { id: user } }; }, async assertCsrf() { calls.push("csrf"); } };
  const programme = {
    enabled,
    async overview(/** @type {any} */ options) { calls.push(["overview", options]); return { enabled: true, decisions: [], zones: [] }; },
    async runDay() { calls.push("runDay"); return run; },
  };
  return { routes: createEvidenceProgrammeRoutes({ store, programme, config: { operatorUsers: ["operator"] }, maxJsonBytes: 4096 }), calls, store };
}

test("other paths are not this factory's", async () => {
  const { routes } = fixture();
  for (const path of ["/api/ops/metrics", "/api/ops/evidence-programme/other", "/api/frontier/zones", "/api/ops"]) assert.equal(await routes(request("GET", path), response()), false, path);
});

test("anyone who is not an operator is refused before anything is read, and a method the path does not take is a 404", async () => {
  const { routes, calls } = fixture({ user: "researcher" });
  for (const [method, path] of [["GET", "/api/ops/evidence-programme"], ["POST", "/api/ops/evidence-programme/run"]])
    await assert.rejects(routes(request(method, path), response()), { status: 403, code: "evidence_programme_operator_required" }, path);
  assert.deepEqual(calls.filter((call) => call !== "session" && call !== "csrf"), [], "no programme call for a non-operator");
  const operator = fixture();
  await assert.rejects(operator.routes(request("POST", "/api/ops/evidence-programme"), response()), { status: 404, code: "not_found" });
  await assert.rejects(operator.routes(request("GET", "/api/ops/evidence-programme/run"), response()), { status: 404, code: "not_found" });
});

test("a session and CSRF are asked for first; the programme off is a 404 by name and nothing is read", async () => {
  const on = fixture();
  await on.routes(request("POST", "/api/ops/evidence-programme/run", {}), response());
  assert.deepEqual(on.calls.slice(0, 2), ["session", "csrf"]);
  const off = fixture({ enabled: false });
  for (const [method, path] of [["GET", "/api/ops/evidence-programme"], ["POST", "/api/ops/evidence-programme/run"]])
    await assert.rejects(off.routes(request(method, path), response()), { status: 404, code: "evidence_programme_not_enabled" }, path);
  assert.deepEqual(off.calls.filter((call) => Array.isArray(call) || call === "runDay"), []);
  const bare = createEvidenceProgrammeRoutes({ store: off.store, programme: null, config: { operatorUsers: ["operator"] }, maxJsonBytes: 1024 });
  await assert.rejects(bare(request("GET", "/api/ops/evidence-programme"), response()), { code: "evidence_programme_not_enabled" });
});

test("the page is the programme's overview of the last fourteen decisions, and the run answers the day's decision as the operator reads it", async () => {
  const { routes, calls } = fixture();
  const page = response();
  assert.equal(await routes(request("GET", "/api/ops/evidence-programme"), page), true);
  assert.deepEqual(page.json(), { data: { enabled: true, decisions: [], zones: [] } });
  assert.equal(page.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(calls.find((call) => Array.isArray(call)), ["overview", { decisions: 14 }]);
  const ran = response();
  assert.equal(await routes(request("POST", "/api/ops/evidence-programme/run", {}), ran), true);
  assert.equal(calls.filter((call) => call === "runDay").length, 1);
  const { data } = ran.json();
  assert.equal(data.state, "decided");
  assert.deepEqual([data.decision.id, data.decision.day, data.decision.source, data.decision.costCny], ["programme-decision-2026-10-06", "2026-10-06", "model", 0.01]);
  await assert.rejects(routes(request("POST", "/api/ops/evidence-programme/run", [1]), response()), { status: 400, code: "invalid_json" });
});

test("a day the programme did not decide (it is off for this call) answers its state and no decision", async () => {
  const { routes } = fixture({ run: { state: "off" } });
  const res = response();
  await routes(request("POST", "/api/ops/evidence-programme/run"), res);
  assert.deepEqual(res.json(), { data: { state: "off", decision: null } });
});
