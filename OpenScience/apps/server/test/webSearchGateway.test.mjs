// The open-web channel is the one evidence source that is not a bibliographic
// API, so it is also the one whose failure is easiest to misread: a run that
// gets an empty result set back has to be able to tell "no engine answered"
// from "nothing has been published on this".
import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchGatewayHandler, WEB_SEARCH_GATEWAY_PATH } from "../src/webSearchGateway.mjs";

const runtimeManager = { assertActiveModelGatewayToken() {} };
const rejectingRuntimeManager = {
  assertActiveModelGatewayToken() {
    throw new Error("no such token");
  },
};

function request(body, { method = "POST", path = WEB_SEARCH_GATEWAY_PATH, token = "runtime-token" } = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const stream = (async function* () {
    if (payload) yield Buffer.from(payload, "utf8");
  })();
  return {
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  };
}

function response() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
      this.body = Buffer.concat(chunks).toString("utf8");
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function searxngResponse(payload, { status = 200 } = {}) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

async function run(config, fetchImpl, body, options) {
  const handler = createWebSearchGatewayHandler(config, options?.runtimeManager ?? runtimeManager, { fetchImpl });
  const res = response();
  await handler(request(body, options), res);
  return res;
}

const configured = { webSearchUrl: "http://open-science-web-search:8080/", webSearchTimeoutMs: 5_000 };

test("a configured deployment returns normalized, deduplicated results", async () => {
  let requested = null;
  const res = await run(
    configured,
    async (url) => {
      requested = url;
      return searxngResponse({
        results: [
          { title: "  Aripiprazole  TDM ", url: "https://example.org/a?utm=1", content: "Trough  concentrations\nin adults", engine: "bing" },
          // Same page, different query string: one work, not two.
          { title: "Duplicate", url: "https://example.org/a?utm=2", content: "…", engine: "360search" },
          { title: "Ignored", url: "ftp://example.org/b", content: "not http", engine: "bing" },
          { title: "Second", url: "https://example.net/c", content: "second", engine: "marginalia" },
        ],
        unresponsive_engines: [["google", "timeout"], ["brave", "timeout"]],
      });
    },
    { query: "aripiprazole therapeutic drug monitoring", limit: 5, language: "en", timeRange: "year", categories: ["general", "science"] },
  );

  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.deepEqual(data.results.map((row) => row.url), ["https://example.org/a?utm=1", "https://example.net/c"]);
  assert.equal(data.results[0].title, "Aripiprazole TDM");
  assert.equal(data.results[0].snippet, "Trough concentrations in adults");
  // Which engines answered is part of the finding: one engine is a different
  // claim about the web than four.
  assert.deepEqual(data.engines, ["bing", "marginalia"]);
  assert.deepEqual(data.unresponsiveEngines, ["brave", "google"]);
  assert.equal(requested.pathname, "/search");
  assert.equal(requested.searchParams.get("format"), "json");
  assert.equal(requested.searchParams.get("categories"), "general,science");
  assert.equal(requested.searchParams.get("language"), "en");
  assert.equal(requested.searchParams.get("time_range"), "year");
});

test("an empty result set says so instead of reading as an unoccupied field", async () => {
  const res = await run(configured, async () => searxngResponse({ results: [] }), { query: "a topic nobody indexed" });
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.deepEqual(payload.data.results, []);
  assert.ok(payload.warnings.some((warning) => /not evidence that the topic is unoccupied/.test(warning)));
});

test("a deployment without a backend refuses with a reason and names what remains", async () => {
  const res = await run({ webSearchUrl: "" }, async () => {
    throw new Error("must not be called");
  }, { query: "anything" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "web_search_unconfigured");
  assert.match(res.json().error, /bibliographic channels remain available/);
});

test("the gateway rejects what it must", async () => {
  const cases = [
    { name: "an unauthenticated caller", body: { query: "x" }, options: { runtimeManager: rejectingRuntimeManager }, status: 401 },
    { name: "a caller with no token", body: { query: "x" }, options: { token: "" }, status: 401 },
    { name: "a GET", body: { query: "x" }, options: { method: "GET" }, status: 404 },
    { name: "another path", body: { query: "x" }, options: { path: "/internal/search/v2/query" }, status: 404 },
    { name: "an empty query", body: { query: "   " }, status: 400 },
    { name: "a query with a newline", body: { query: "a\nb" }, status: 400 },
    { name: "a limit past the cap", body: { query: "x", limit: 500 }, status: 400 },
    { name: "a category the deployment does not offer", body: { query: "x", categories: ["images"] }, status: 400 },
    { name: "a malformed language tag", body: { query: "x", language: "english" }, status: 400 },
    { name: "an unsupported time range", body: { query: "x", timeRange: "decade" }, status: 400 },
    { name: "a body that is not JSON", body: "{", status: 400 },
  ];
  for (const { name, body, options, status } of cases) {
    const res = await run(configured, async () => searxngResponse({ results: [] }), body, options);
    assert.equal(res.statusCode, status, `${name} was not rejected: ${res.body}`);
  }
});

test("a transient backend failure is retried once, then surfaced", async () => {
  let calls = 0;
  const recovered = await run(configured, async () => {
    calls += 1;
    return calls === 1 ? searxngResponse({}, { status: 502 }) : searxngResponse({ results: [{ title: "t", url: "https://example.org/x", engine: "bing" }] });
  }, { query: "x" });
  assert.equal(calls, 2);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().data.results.length, 1);

  let attempts = 0;
  const failed = await run(configured, async () => {
    attempts += 1;
    return searxngResponse({}, { status: 502 });
  }, { query: "x" });
  assert.equal(attempts, 2);
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().code, "web_search_upstream_error");
});

test("a non-JSON backend response is not passed through as a result set", async () => {
  const res = await run(configured, async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    text: async () => "<html>rate limited</html>",
    body: { cancel: async () => {} },
  }), { query: "x" });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, "web_search_response_invalid");
});
