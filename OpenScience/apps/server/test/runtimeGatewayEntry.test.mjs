import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createRuntimeGatewayEntry,
  publicRuntimeGatewayUrls,
  resolveRuntimeGatewayPath,
} from "../src/runtimeGatewayEntry.mjs";

// The public entry an AgentBay session reaches every gateway through
// (plan §3.1 #5): the same gateways, the same tokens, one prefix on 443, and a
// per-runtime rate limit because the address is on the internet.

/** A manager that knows one runtime's two tokens, as the real one would. */
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token === "model-alice") return { userId: "alice", projectId: "paper1" };
    throw Object.assign(new Error("inactive"), { code: "model_gateway_token_invalid" });
  },
  async assertActiveEviMedWorkloadToken(token) {
    if (token === "workload-alice") return { userId: "alice", projectId: "paper1" };
    if (token === "workload-bob") return { userId: "bob", projectId: "thesis" };
    throw Object.assign(new Error("inactive"), { code: "evimed_workload_token_invalid" });
  },
};

/** @param {http.Server} server @returns {Promise<number>} */
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server.address()).port)));
}

/**
 * The entry in front of a stand-in for the dispatch that follows it: a
 * rewritten request is answered with the path it was rewritten to.
 * @param {import("node:test").TestContext} t @param {Record<string, any>} config
 */
/** An AgentBay deployment with its public prefix: the only kind the entry answers for. */
const AGENTBAY = { runtimeProvider: "agentbay", runtimeGatewayPublicUrl: "https://evimed.example/runtime-gateway" };

async function entryServer(t, config) {
  const entry = createRuntimeGatewayEntry({ config: { ...AGENTBAY, ...config }, runtimeManager });
  const server = http.createServer(async (req, res) => {
    if (entry.matches(req) && await entry.handle(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ dispatched: req.url }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  return `http://127.0.0.1:${port}`;
}

test("a public gateway path maps to the gateway's own internal path, and nothing else does", () => {
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/model/v1/chat/completions"), { kind: "internal", url: "/internal/model/v1/chat/completions" });
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/sources/v1/fetch?x=1"), { kind: "internal", url: "/internal/sources/v1/fetch?x=1" });
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/capsules/v1/recall"), { kind: "internal", url: "/internal/capsules/v1/recall" });
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/geo-probe/v1"), { kind: "internal", url: "/internal/geo-probe/v1" });
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/specialist/meta/v1/run?job=1"), { kind: "specialist", adapter: "meta", suffix: "/v1/run?job=1" });
  for (const refused of [
    "/runtime-gateway/model/../api/me",
    "/runtime-gateway/model/v1/./x",
    "/runtime-gateway/admin/v1",
    "/runtime-gateway/",
    "/runtime-gateway/specialist/../model",
    "/runtime-gateway/specialist/",
    "/internal/model/v1/chat/completions",
    "/api/runtime-gateway/model/v1",
    "/runtime-gateway/connectors/v1/credential?connector=umls",
    // What the server's router decodes before it resolves: each reached
    // another handler through a literal-only `..` check (review, 2026-09-20).
    "/runtime-gateway/model/%2e%2e/usage/v1/engine",
    "/runtime-gateway/model/.%2E/usage/v1/engine",
    "/runtime-gateway/model/x/..\\..\\usage/v1/engine",
    "/runtime-gateway/kb/%2e%2e/%2e%2e/api/me",
    "/runtime-gateway/specialist/meta/%2e%2e/x",
    "/runtime-gateway/model%2fv1",
  ]) assert.equal(resolveRuntimeGatewayPath(refused), null, refused);
});

test("a Docker deployment, or one without a public prefix, has no public gateway entry", async (t) => {
  for (const config of [{ runtimeProvider: "docker" }, { runtimeProvider: "agentbay", runtimeGatewayPublicUrl: "" }]) {
    const entry = createRuntimeGatewayEntry({ config: { runtimeGatewayRateLimitPerMinute: 600, ...config }, runtimeManager });
    const server = http.createServer(async (req, res) => {
      if (entry.matches(req) && await entry.handle(req, res)) return;
      res.writeHead(200).end("dispatched");
    });
    const port = await listen(server);
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
    const answer = await fetch(`http://127.0.0.1:${port}/runtime-gateway/model/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer model-alice" },
    });
    assert.equal(answer.status, 404, JSON.stringify(config));
    assert.equal((await answer.json()).code, "runtime_gateway_not_found");
  }
});

test("a remote runtime is offered exactly the gateways a local one is, at the public prefix", () => {
  assert.equal(publicRuntimeGatewayUrls({}), null);
  const urls = publicRuntimeGatewayUrls({
    runtimeGatewayPublicUrl: "https://evimed.example/runtime-gateway/",
    publicSourceGatewayInternalUrl: "http://open-science-web:8787/internal/sources/v1/fetch",
    evimedAdapterUrls: { meta: "http://evimed-specialist-adapter:8090/meta", mr: "" },
  });
  assert.equal(urls?.model, "https://evimed.example/runtime-gateway/model/v1");
  assert.equal(urls?.publicSource, "https://evimed.example/runtime-gateway/sources/v1/fetch");
  assert.equal(urls?.webSearch, "", "no search backend here, so no search gateway there");
  assert.equal(urls?.capsule, "");
  assert.equal(urls?.revision, "");
  assert.equal(urls?.geoProbe, "");
  assert.equal(urls?.kbSearch, "", "knowledge-base search is off here, so it is not offered there");
  assert.deepEqual(urls?.adapters, { meta: "https://evimed.example/runtime-gateway/specialist/meta" });
  const withKb = publicRuntimeGatewayUrls({
    runtimeGatewayPublicUrl: "https://evimed.example/runtime-gateway",
    kbSearchEnabled: true, kbSearchGatewayInternalUrl: "http://open-science-web:8787/internal/kb/v1/search",
  });
  assert.equal(withKb?.kbSearch, "https://evimed.example/runtime-gateway/kb/v1/search");
  assert.deepEqual(resolveRuntimeGatewayPath("/runtime-gateway/kb/v1/search"), { kind: "internal", url: "/internal/kb/v1/search" });
});

test("only an active runtime's token passes, and the request goes on to its gateway", async (t) => {
  const base = await entryServer(t, { runtimeGatewayRateLimitPerMinute: 600 });
  const missing = await fetch(`${base}/runtime-gateway/model/v1/chat/completions`, { method: "POST" });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).code, "runtime_gateway_unauthenticated");
  const stranger = await fetch(`${base}/runtime-gateway/model/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer model-mallory" } });
  assert.equal(stranger.status, 401);
  await stranger.body?.cancel();

  const model = await fetch(`${base}/runtime-gateway/model/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer model-alice" } });
  assert.deepEqual(await model.json(), { dispatched: "/internal/model/v1/chat/completions" });
  const sources = await fetch(`${base}/runtime-gateway/sources/v1/fetch`, { method: "POST", headers: { authorization: "Bearer workload-alice" } });
  assert.deepEqual(await sources.json(), { dispatched: "/internal/sources/v1/fetch" }, "the workload token is the other one a runtime holds");

  const nowhere = await fetch(`${base}/runtime-gateway/admin/v1`, { headers: { authorization: "Bearer model-alice" } });
  assert.equal(nowhere.status, 404);
  assert.equal((await nowhere.json()).code, "runtime_gateway_not_found");
});

test("each runtime has its own request budget a minute", async (t) => {
  const base = await entryServer(t, { runtimeGatewayRateLimitPerMinute: 2 });
  const call = (token) => fetch(`${base}/runtime-gateway/search/v1/query`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal((await call("workload-alice")).status, 200);
  assert.equal((await call("model-alice")).status, 200, "both of a runtime's tokens count against one budget");
  const limited = await call("workload-alice");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "runtime_gateway_rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call("workload-bob")).status, 200, "another runtime is not slowed by it");
});

test("a specialist engine is relayed to its configured address with the runtime's own token, and never an unconfigured one", async (t) => {
  const seen = [];
  const adapter = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  const adapterPort = await listen(adapter);
  t.after(() => new Promise((resolve) => { adapter.closeAllConnections(); adapter.close(() => resolve(undefined)); }));
  const base = await entryServer(t, {
    runtimeGatewayRateLimitPerMinute: 600,
    evimedAdapterUrls: { meta: `http://127.0.0.1:${adapterPort}/meta` },
  });

  const relayed = await fetch(`${base}/runtime-gateway/specialist/meta/v1/jobs?wait=0`, {
    method: "POST",
    headers: { authorization: "Bearer workload-alice", cookie: "session=browser", "content-type": "application/json" },
    body: JSON.stringify({ topic: "aspirin" }),
  });
  assert.equal(relayed.status, 202);
  assert.deepEqual(await relayed.json(), { accepted: true });
  assert.deepEqual(seen, [{ url: "/meta/v1/jobs?wait=0", authorization: "Bearer workload-alice", cookie: undefined, body: '{"topic":"aspirin"}' }]);

  const unconfigured = await fetch(`${base}/runtime-gateway/specialist/mr/v1/jobs`, { method: "POST", headers: { authorization: "Bearer workload-alice" } });
  assert.equal(unconfigured.status, 404);
  assert.equal((await unconfigured.json()).code, "runtime_gateway_adapter_unconfigured");
  const unauthenticated = await fetch(`${base}/runtime-gateway/specialist/meta/v1/jobs`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  assert.equal(seen.length, 1, "a refused request never reaches the engine");
});
