// What one project's runtime may ask of the public-source and web-search gateways.
//
// A runtime's token is readable by the model from its shell. It is bound to its account and project, so it cannot be used as
// anyone else, and until 2026-11-01 it could be used without bound against the two gateways that spend outside resources:
// web reading had its per-site pacing and per-runtime gate, and everything else (the official sources, the downloads, the
// search) had only global limits. These tests hold the two per-project limits that close that: a minute's ceiling on both
// gateways, and an in-flight cap on the buffered public-source requests.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_ERROR_CODES, errorCodeMessage, recoverableEvidenceSourceErrorCodes } from "@evimed/domain";
import { loadConfig } from "../src/config.mjs";
import { createProjectGatewayLimit, projectGatewayLimitMetricFamily, resetProjectGatewayLimitMetrics } from "../src/projectGatewayLimit.mjs";
import { createPublicSourceGatewayHandler } from "../src/publicSourceGateway.mjs";
import { createWebSearchGatewayHandler } from "../src/webSearchGateway.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const alice = { userId: "alice", projectId: "paper-1" };
const bob = { userId: "bob", projectId: "paper-9" };
const counted = (gateway, limit, action) => projectGatewayLimitMetricFamily().series
  .find((row) => row.labels.gateway === gateway && row.labels.limit === limit && row.labels.action === action)?.value;

test("the minute's ceiling is per project, resets with the window, and says when to come back", () => {
  resetProjectGatewayLimitMetrics();
  let clock = 1_000_000;
  const limit = createProjectGatewayLimit({ gateway: "sources", ratePerMinute: 3, now: () => clock });
  for (let call = 0; call < 3; call += 1) assert.equal(limit.admit(alice), null);
  clock += 20_000;
  assert.deepEqual(limit.admit(alice), { retryAfterSeconds: 40 });
  assert.equal(limit.admit(bob), null, "another project is not behind it");
  assert.equal(limit.admit({ userId: "alice", projectId: "paper-2" }), null, "nor is the same account's other project");
  assert.equal(counted("sources", "rate", "refused"), 1);
  clock += 40_001;
  assert.equal(limit.admit(alice), null, "a new minute starts at one");
  assert.equal(createProjectGatewayLimit({ gateway: "search", ratePerMinute: 0 }).admit(alice), null, "0 turns the ceiling off");
});

test("the in-flight cap queues behind a project's own requests, refuses past its queue, and holds nobody else", async () => {
  resetProjectGatewayLimitMetrics();
  const limit = createProjectGatewayLimit({ gateway: "sources", ratePerMinute: 0, concurrency: 1, queue: 1 });
  const first = await limit.enter(alice);
  assert.equal(typeof first, "function");
  let secondReady = false;
  const second = limit.enter(alice).then((place) => { secondReady = true; return place; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false, "the second waits its turn");
  assert.equal(await limit.enter(alice), null, "the third finds the queue full");
  const other = await limit.enter(bob);
  assert.equal(typeof other, "function", "another project's request is not behind alice's");
  first();
  const place = await second;
  assert.equal(secondReady, true);
  assert.equal(typeof place, "function");
  place();
  other();
  assert.deepEqual([counted("sources", "concurrency", "queued"), counted("sources", "concurrency", "refused")], [1, 1]);

  // A request that gives up while queued leaves the queue and holds nothing.
  const held = await limit.enter(alice);
  const controller = new AbortController();
  const waiting = limit.enter(alice, controller.signal);
  controller.abort(new Error("the caller hung up"));
  await assert.rejects(waiting, /hung up/);
  held();
  const after = await limit.enter(alice);
  assert.equal(typeof after, "function", "the abandoned request left no place taken");
  after();
  assert.equal(await createProjectGatewayLimit({ gateway: "search", ratePerMinute: 0 }).enter(alice) !== null, true, "no cap is no refusal");
});

const tokens = { "alice-token": alice, "bob-token": bob };
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (!tokens[token]) throw new Error("invalid token");
    return tokens[token];
  },
};

async function listen(t, handler) {
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections?.(); server.close(); await once(server, "close"); });
  return `http://127.0.0.1:${server.address().port}`;
}

const sourceRequest = (base, token, body) => fetch(`${base}/internal/sources/v1/fetch`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const idconv = { url: "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=1&format=json", accept: ["application/json"] };
const okFetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

test("the public-source gateway refuses a project's request past its minute, with a registered code and the wait", async (t) => {
  resetProjectGatewayLimitMetrics();
  const base = await listen(t, createPublicSourceGatewayHandler(
    { publicSourceGatewayTimeoutMs: 5_000, publicSourceProjectRatePerMinute: 3 }, runtimeManager, { fetchImpl: okFetch }));
  for (let call = 0; call < 3; call += 1) assert.equal((await sourceRequest(base, "alice-token", idconv)).status, 200);
  const limited = await sourceRequest(base, "alice-token", idconv);
  assert.equal(limited.status, 429);
  const { error } = await limited.json();
  assert.equal(error.code, "public_source_gateway_project_rate_limited");
  assert.ok(Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60);
  assert.equal(limited.headers.get("retry-after"), String(error.retryAfterSeconds), "the header a client already honours");
  assert.match(error.message, /3 public-source requests a minute/);
  assert.equal((await sourceRequest(base, "bob-token", idconv)).status, 200, "another project is served");
  assert.equal(counted("sources", "rate", "refused"), 1);
});

test("the public-source gateway holds a project's buffered requests to its in-flight cap, and leaves web reads to their own gate", async (t) => {
  resetProjectGatewayLimitMetrics();
  /** @type {Array<() => void>} */
  const releases = [];
  let started = 0;
  const slowFetch = () => { started += 1; return new Promise((resolve) => releases.push(() => resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })))); };
  // No web reader: a web read answers `web_read_unavailable` at once, which is how this test sees whether it was let in.
  const base = await listen(t, createPublicSourceGatewayHandler(
    { publicSourceGatewayTimeoutMs: 10_000, publicSourceProjectConcurrency: 1 }, runtimeManager, { fetchImpl: slowFetch }));
  const inFlight = sourceRequest(base, "alice-token", idconv);
  for (let wait = 0; wait < 100 && started < 1; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 1);
  const queued = [sourceRequest(base, "alice-token", idconv), sourceRequest(base, "alice-token", idconv)];
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(started, 1, "the project's other requests wait for its place");
  // The cap's queue is twice its size (two here): the fourth buffered request is refused by name.
  const refused = await sourceRequest(base, "alice-token", idconv);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error.code, "public_source_gateway_project_busy");
  const webRead = await sourceRequest(base, "alice-token", { webRead: { url: "https://example.org/notice" } });
  assert.notEqual((await webRead.json()).error.code, "public_source_gateway_project_busy", "a web read is not held behind the buffered requests");
  const otherProject = sourceRequest(base, "bob-token", idconv);
  for (let wait = 0; wait < 100 && started < 2; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 2, "another project's request starts while alice's wait");
  // Finishing one request hands its place to the next in the queue, in turn.
  for (let round = 0; round < 10 && releases.length; round += 1) {
    releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const answers = await Promise.all([inFlight, ...queued, otherProject]);
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200]);
  assert.equal(started, 4, "all four answered requests reached the source");
  assert.deepEqual([counted("sources", "concurrency", "queued"), counted("sources", "concurrency", "refused")], [2, 1]);
});

const searchRequest = (base, token, body) => fetch(`${base}/internal/search/v1/query`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the web-search gateway refuses a project's search past its minute, and the engines are not asked", async (t) => {
  resetProjectGatewayLimitMetrics();
  let asked = 0;
  const searxngFetch = async () => {
    asked += 1;
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const base = await listen(t, createWebSearchGatewayHandler(
    { webSearchUrl: "http://open-science-web-search:8080/", webSearchTimeoutMs: 5_000, webSearchProjectRatePerMinute: 2, webSearchDeepseekEnabled: false },
    runtimeManager, { fetchImpl: searxngFetch }));
  for (let call = 0; call < 2; call += 1) assert.equal((await searchRequest(base, "alice-token", { query: "aripiprazole" })).status, 200);
  const limited = await searchRequest(base, "alice-token", { query: "aripiprazole" });
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, "web_search_project_rate_limited");
  assert.match(body.error, /2 web searches a minute/);
  // When to come back is said in the body and in the header, as whole seconds inside the minute, so the runtime can pass the wait on.
  assert.ok(Number.isSafeInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 60, `${body.retryAfterSeconds}`);
  assert.equal(limited.headers.get("retry-after"), String(body.retryAfterSeconds));
  assert.equal(asked, 2, "the refused search spent nothing");
  assert.equal((await searchRequest(base, "bob-token", { query: "aripiprazole" })).status, 200);
  assert.equal(counted("search", "rate", "refused"), 1);
});

test("the limits have registered codes with a Chinese sentence, defaults a research run does not reach, and levers that can be turned off", () => {
  for (const code of ["public_source_gateway_project_rate_limited", "public_source_gateway_project_busy", "web_search_project_rate_limited"]) {
    assert.ok(ALL_ERROR_CODES.includes(code), `${code} is registered`);
    assert.ok(recoverableEvidenceSourceErrorCodes.has(code), `${code} is a source the run goes on without, not a failed run`);
    assert.match(errorCodeMessage(code), /[一-鿿]/, `${code} has a Chinese sentence`);
    assert.notEqual(errorCodeMessage(code), errorCodeMessage("public_source_not_a_code"), `${code} has a sentence of its own, not its family's`);
  }
  const saved = ["OPEN_SCIENCE_PUBLIC_SOURCE_PROJECT_RATE_PER_MINUTE", "OPEN_SCIENCE_PUBLIC_SOURCE_PROJECT_CONCURRENCY", "OPEN_SCIENCE_WEB_SEARCH_PROJECT_RATE_PER_MINUTE"];
  const config = loadConfig({ rootDir: repoRoot });
  assert.deepEqual([config.publicSourceProjectRatePerMinute, config.publicSourceProjectConcurrency, config.webSearchProjectRatePerMinute], [600, 16, 300]);
  assert.equal(loadConfig({ rootDir: repoRoot, publicSourceProjectRatePerMinute: 0 }).publicSourceProjectRatePerMinute, 0);
  assert.ok(saved.every((name) => process.env[name] === undefined), "the test ran on the defaults");
});
