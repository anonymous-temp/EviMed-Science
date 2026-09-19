import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { KB_SEARCH_GATEWAY_PATH, createKbSearchGatewayHandler, kbSearchGatewayProviderUrl } from "../src/kbSearchGateway.mjs";

const SOURCE = `src_${"b".repeat(32)}`;
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== "runtime-token") throw new Error("inactive");
    return { userId: "user-1", projectId: "project-1" };
  },
};

async function withGateway(t, { config = {}, index = null } = {}) {
  const failures = [];
  const handler = createKbSearchGatewayHandler({ kbSearchEnabled: true, kbSearchTimeoutMs: 1_000, ...config }, runtimeManager, { index });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}${KB_SEARCH_GATEWAY_PATH}`;
  const call = async (body, { token = "runtime-token", method = "POST", path = KB_SEARCH_GATEWAY_PATH } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { url, call, failures };
}

test("the runtime's own token names the account and project searched, and the answer is the index's", async (t) => {
  const calls = [];
  const index = { async search(request) { calls.push(request); return { mode: "keyword", hits: [{ sourceId: SOURCE }] }; } };
  const { call } = await withGateway(t, { index });
  const answer = await call({ query: " 利伐沙班 ", limit: 3, sourceIds: [SOURCE, SOURCE] });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.data.hits, [{ sourceId: SOURCE }]);
  assert.deepEqual(calls, [{ userId: "user-1", projectId: "project-1", query: "利伐沙班", limit: 3, sourceIds: [SOURCE] }]);
  const defaults = await call({ query: "q" });
  assert.equal(defaults.status, 200);
  assert.deepEqual(calls[1], { userId: "user-1", projectId: "project-1", query: "q", limit: 8, sourceIds: null });
});

test("no token, a stale token, another route or another method is refused before the index is asked", async (t) => {
  let asked = 0;
  const { call } = await withGateway(t, { index: { async search() { asked += 1; return {}; } } });
  assert.deepEqual((await call({ query: "q" }, { token: "" })).body.code, "kb_search_gateway_token_missing");
  assert.deepEqual((await call({ query: "q" }, { token: "someone-elses" })).body.code, "kb_search_gateway_token_invalid");
  assert.equal((await call({ query: "q" }, { path: `${KB_SEARCH_GATEWAY_PATH}/x` })).status, 404);
  assert.equal((await call(null, { method: "GET" })).status, 404);
  assert.equal(asked, 0);
});

test("switched off, it says disabled and nothing else", async (t) => {
  const off = await withGateway(t, { config: { kbSearchEnabled: false }, index: { async search() { throw new Error("never"); } } });
  const answer = await off.call({ query: "q" });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, "kb_search_disabled");
  assert.match(answer.body.error, /read and grep/);
  assert.deepEqual(off.failures, [{ code: "kb_search_disabled", status: 503 }]);
  const unbuilt = await withGateway(t, { index: null });
  assert.equal((await unbuilt.call({ query: "q" })).body.code, "kb_search_disabled");
});

test("a request it cannot parse is named, field by field", async (t) => {
  const { call } = await withGateway(t, { index: { async search() { return {}; } } });
  for (const [body, code] of [
    ["not json", "kb_search_request_invalid"],
    [{ query: "q", extra: 1 }, "kb_search_request_invalid"],
    [{ query: "" }, "kb_search_query_invalid"],
    [{ query: "x".repeat(513) }, "kb_search_query_invalid"],
    [{ query: "q", limit: 21 }, "kb_search_limit_invalid"],
    [{ query: "q", limit: 1.5 }, "kb_search_limit_invalid"],
    [{ query: "q", sourceIds: ["../etc"] }, "kb_search_source_ids_invalid"],
  ]) {
    const answer = await call(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, code, JSON.stringify(body));
  }
});

test("a slow or failing index is a named answer that says what the run can do instead", async (t) => {
  const slow = await withGateway(t, { config: { kbSearchTimeoutMs: 1_000 }, index: { search: () => new Promise(() => {}) } });
  const timedOut = await slow.call({ query: "q" });
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.code, "kb_search_timeout");
  const broken = await withGateway(t, { index: { async search() { throw new Error("connection to 10.0.0.5 refused: internal detail"); } } });
  const failed = await broken.call({ query: "q" });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "kb_search_unavailable");
  assert.doesNotMatch(JSON.stringify(failed.body), /10\.0\.0\.5|internal detail/, "an internal error never reaches the runtime");
});

test("a runaway loop is bounded per project, not per request", async (t) => {
  const { call } = await withGateway(t, { index: { async search() { return { mode: "keyword", hits: [] }; } } });
  let last;
  for (let attempt = 0; attempt < 121; attempt += 1) last = await call({ query: "q" });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "kb_search_rate_limited");
});

test("the runtime learns the route only when the switch is on and the address is sound", () => {
  const url = "http://open-science-web:8787/internal/kb/v1/search";
  assert.equal(kbSearchGatewayProviderUrl({ kbSearchEnabled: true, kbSearchGatewayInternalUrl: url }), url);
  assert.equal(kbSearchGatewayProviderUrl({ kbSearchEnabled: false, kbSearchGatewayInternalUrl: url }), "");
  assert.equal(kbSearchGatewayProviderUrl({ kbSearchEnabled: true, kbSearchGatewayInternalUrl: "http://user:pw@host/x" }), "");
  assert.equal(kbSearchGatewayProviderUrl({ kbSearchEnabled: true, kbSearchGatewayInternalUrl: "not a url" }), "");
});
