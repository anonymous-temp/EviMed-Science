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
  await handler(request(body, options), res, options?.onFailure);
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

test("the endpoint the deployment writes is queried as it is, and a base URL gets search added", async () => {
  // Production's .env names the endpoint (`…:8080/search`); the gateway
  // appended `search` to it and asked `/search/search`, which SearXNG answers
  // 404 — every open-web search failed (2026-09-21).
  for (const [configured, expected] of [
    ["http://open-science-web-search:8080/search", "/search"],
    ["http://open-science-web-search:8080/search/", "/search"],
    ["http://open-science-web-search:8080/", "/search"],
    ["http://open-science-web-search:8080", "/search"],
    ["http://proxy.internal/searxng/", "/searxng/search"],
    ["http://proxy.internal/searxng/search", "/searxng/search"],
  ]) {
    let asked = null;
    const res = await run({ ...configured === "" ? {} : { webSearchUrl: configured }, webSearchTimeoutMs: 5_000 }, async (url) => {
      asked = new URL(String(url));
      return searxngResponse({ results: [{ title: "t", url: "https://example.org/x", engine: "quark" }] });
    }, { query: "SGLT2 HFpEF guideline" });
    assert.equal(res.statusCode, 200, configured);
    assert.equal(asked.pathname, expected, configured);
    assert.equal(asked.searchParams.get("q"), "SGLT2 HFpEF guideline");
  }
});

test("a backend refusal reaches the error ledger with the backend's own status", async () => {
  // 2026-09-21: 138 `web_search_upstream_error` in twelve hours, and not one
  // said what SearXNG had answered.
  const failures = [];
  const failed = await run(configured, async () => searxngResponse({}, { status: 503 }), { query: "x" },
    { onFailure: (failure) => failures.push(failure) });
  assert.equal(failed.statusCode, 502);
  assert.deepEqual(failures.map((failure) => [failure.code, failure.upstream]),
    [["web_search_upstream_error", { host: "open-science-web-search", status: 503 }]]);
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

function bailianResponse(results, { status = 200 } = {}) {
  return searxngResponse({ output: { search_info: { search_results: results } }, usage: { input_tokens: 3000 } }, { status });
}

const withBailian = { ...configured, webSearchBailianEnabled: true, dashscopeApiKey: "sk-test-key-not-real" };

test("Qwen's web search is merged with SearXNG's, interleaved, deduplicated, and the key never leaves in the answer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://dashscope.aliyuncs.com/")) {
      return bailianResponse([
        { title: "口服司美格鲁肽「说明书」更新", url: "https://mp.weixin.qq.com/s?__biz=MjM5&mid=1&idx=2&sn=abc", site_name: "腾讯网" },
        { title: "the same page again", url: "https://example.org/a?utm=x", site_name: "example" },
      ]);
    }
    return searxngResponse({ results: [
      { url: "https://example.org/a", title: "A", content: "first", engine: "bing" },
      { url: "https://example.org/b", title: "B", content: "second", engine: "google" },
    ] });
  };
  const res = await run(withBailian, fetchImpl, { query: "司美格鲁肽 说明书 修订" });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.deepEqual(data.results.map((row) => row.url), [
    "https://example.org/a",
    "https://mp.weixin.qq.com/s?__biz=MjM5&mid=1&idx=2&sn=abc",
    "https://example.org/b",
  ]);
  assert.deepEqual(data.engines, ["bailian", "bing", "google"]);
  assert.equal(data.results[1].snippet, "腾讯网", "the site name stands in for the snippet Bailian does not return");
  const bailian = calls.find((call) => call.url.startsWith("https://dashscope.aliyuncs.com/"));
  assert.equal(bailian.init.method, "POST");
  assert.equal(bailian.init.headers.authorization, "Bearer sk-test-key-not-real");
  const body = JSON.parse(bailian.init.body);
  assert.equal(body.model, "qwen-plus");
  assert.equal(body.input.messages[0].content, "司美格鲁肽 说明书 修订");
  assert.equal(body.parameters.enable_search, true);
  assert.deepEqual(body.parameters.search_options, { forced_search: true, enable_source: true, search_strategy: "turbo" });
  assert.ok(body.parameters.max_tokens <= 16, "the model's own answer is dropped, so it is kept to a few tokens");
  assert.ok(!res.body.includes("sk-test-key-not-real"));
});

test("Bailian is off unless the deployment switches it on, even with a DashScope key present", async () => {
  const urls = [];
  const res = await run({ ...configured, dashscopeApiKey: "sk-test-key-not-real" }, async (url) => {
    urls.push(String(url));
    return searxngResponse({ results: [{ url: "https://example.org/a", title: "A", engine: "bing" }] });
  }, { query: "semaglutide" });
  assert.equal(res.statusCode, 200);
  assert.ok(urls.every((url) => !url.startsWith("https://dashscope.aliyuncs.com/")));
});

test("one source failing is a thinner answer that names it; both failing is a refused search", async () => {
  const bailianOnly = await run(withBailian, async (url) => (String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? bailianResponse([{ title: "国家药监局公告", url: "https://www.nmpa.gov.cn/x.html", site_name: "国家药监局" }])
    : searxngResponse({ error: "down" }, { status: 502 })), { query: "国家药监局 公告" });
  assert.equal(bailianOnly.statusCode, 200);
  assert.deepEqual(bailianOnly.json().data.results.map((row) => row.url), ["https://www.nmpa.gov.cn/x.html"]);
  assert.ok(bailianOnly.json().data.unresponsiveEngines.includes("searxng"));

  const searxOnly = await run(withBailian, async (url) => (String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? bailianResponse([], { status: 401 })
    : searxngResponse({ results: [{ url: "https://example.org/a", title: "A", engine: "bing" }] })), { query: "semaglutide" });
  assert.equal(searxOnly.statusCode, 200);
  assert.ok(searxOnly.json().data.unresponsiveEngines.includes("bailian"));

  const neither = await run(withBailian, async (url) => (String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? bailianResponse([], { status: 500 })
    : searxngResponse({ error: "down" }, { status: 502 })), { query: "semaglutide" });
  assert.equal(neither.statusCode, 502);

  const bailianAlone = await run({ webSearchTimeoutMs: 5_000, webSearchBailianEnabled: true, dashscopeApiKey: "sk-test-key-not-real" },
    async () => bailianResponse([{ title: "t", url: "https://example.org/only", site_name: "s" }]), { query: "semaglutide" });
  assert.equal(bailianAlone.statusCode, 200, "Bailian alone is a configured search");
});

/** A usage ledger that records what the gateway asked of it. */
function fakeLedger({ refuse = null } = {}) {
  const calls = [];
  return {
    calls,
    async reserveModel(input) {
      calls.push(["reserve", input]);
      if (refuse) throw Object.assign(new Error("refused"), { code: refuse, status: 402 });
      return { id: input.id };
    },
    async settleModel(userId, id, input) { calls.push(["settle", { userId, id, ...input }]); },
    async markUncertain(userId, id, code, options) { calls.push(["uncertain", { userId, id, code, ...options }]); },
    async release(userId, id, code) { calls.push(["release", { userId, id, code }]); },
  };
}

const caller = { userId: "alice", projectId: "paper1", runId: null, dailyLimit: 0, weeklyLimit: 0 };
const identifying = { assertActiveModelGatewayToken: () => caller };

async function metered(config, fetchImpl, usageLedger, { attributeRun = async () => "run-7", runPurpose = null } = {}) {
  const handler = createWebSearchGatewayHandler(config, identifying, { fetchImpl, usageLedger, attributeRun, runPurpose });
  const res = response();
  await handler(request({ query: "司美格鲁肽 说明书" }), res);
  return res;
}

test("a Bailian search is reserved against the researcher's caps and settled on the provider's own count, as web-search", async () => {
  const ledger = fakeLedger();
  const res = await metered({ ...withBailian, userDailySpendLimit: 20, userWeeklySpendLimit: 100, userRunSpendLimit: 5 }, async (url) => (String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? searxngResponse({
      request_id: "req-dashscope-1",
      output: { search_info: { search_results: [{ title: "公告", url: "https://www.nmpa.gov.cn/y.html", site_name: "国家药监局" }] } },
      usage: { input_tokens: 3_200, output_tokens: 8, prompt_tokens_details: { cached_tokens: 200 }, plugins: { search: { count: 1, strategy: "turbo" } } },
    })
    : searxngResponse({ results: [{ url: "https://example.org/a", title: "A", engine: "bing" }] })), ledger);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ledger.calls.map(([kind]) => kind), ["reserve", "settle"]);
  const [, reserve] = ledger.calls[0];
  assert.equal(reserve.purpose, "web-search");
  assert.equal(reserve.model, "qwen-plus");
  assert.equal(reserve.userId, "alice");
  assert.equal(reserve.projectId, "paper1");
  assert.equal(reserve.runId, "run-7", "charged to the run the project is running, like the kernel's calls");
  assert.equal(reserve.priceVersion, "evimed-reference-2026-09-28");
  assert.equal(reserve.dailyLimit, 20);
  assert.equal(reserve.weeklyLimit, 100);
  assert.equal(reserve.runLimit, 5);
  assert.ok(reserve.estimatedCost > 0 && reserve.estimatedCost < 0.02, `reserved ${reserve.estimatedCost}`);
  assert.match(reserve.requestFingerprint, /^[0-9a-f]{64}$/);
  const [, settle] = ledger.calls[1];
  assert.equal(settle.id, reserve.id);
  assert.deepEqual(settle.usage, { cacheHitTokens: 200, cacheMissTokens: 3_000, completionTokens: 8 });
  // ¥0.16/M × 200 + ¥0.8/M × 3,000 + ¥2/M × 8
  assert.equal(settle.actualCost, 0.002448);
  assert.equal(settle.priced, true);
  assert.equal(settle.providerRequestId, "req-dashscope-1");
});

test("a Bailian call with no count, a refusal, a failure after it left, and a spent budget each close the right way", async () => {
  const bailianAnd = (answer) => async (url) => (String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? answer()
    : searxngResponse({ results: [{ url: "https://example.org/a", title: "A", engine: "bing" }] }));

  let ledger = fakeLedger();
  let res = await metered(withBailian, bailianAnd(() => searxngResponse({ output: { search_info: { search_results: [] } } })), ledger);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["uncertain", "response_usage_missing"]]);

  ledger = fakeLedger();
  res = await metered(withBailian, bailianAnd(() => searxngResponse({}, { status: 401 })), ledger);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["release", "provider_refused_401"]],
    "refused in writing, nothing billed");

  ledger = fakeLedger();
  res = await metered(withBailian, bailianAnd(() => searxngResponse({}, { status: 503 })), ledger);
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["uncertain", "provider_response_incomplete"]],
    "sent and lost: possibly spent");

  ledger = fakeLedger({ refuse: "usage_budget_exceeded" });
  let asked = 0;
  res = await metered(withBailian, bailianAnd(() => { asked += 1; return searxngResponse({}); }), ledger);
  assert.equal(res.statusCode, 200, "the other engines still answer");
  assert.equal(asked, 0, "a search the caps refuse never leaves");
  assert.ok(res.json().data.unresponsiveEngines.includes("bailian"));

  // Bailian alone, over budget: a named refusal, not a crash.
  res = await metered({ webSearchTimeoutMs: 5_000, webSearchBailianEnabled: true, dashscopeApiKey: "sk-test-key-not-real" },
    bailianAnd(() => searxngResponse({})), fakeLedger({ refuse: "usage_budget_exceeded" }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "web_search_unavailable");

  // Where the ledger is required and absent, Bailian is not called at all.
  asked = 0;
  res = await metered({ ...withBailian, requireDurableUsageLedger: true }, bailianAnd(() => { asked += 1; return searxngResponse({}); }), null);
  assert.equal(res.statusCode, 200);
  assert.equal(asked, 0);
});

test("the node's SearXNG is searched first, and this host's answers when the node cannot", async () => {
  const edgeUrl = "http://127.0.0.1:8888/search";
  const config = { ...configured, webSearchEdgeUrl: edgeUrl };
  const local = [];
  const localFetch = async (url) => {
    local.push(String(url));
    return searxngResponse({ results: [{ url: "https://example.org/local", title: "local", engine: "quark" }] });
  };
  const viaNode = [];
  const edgeFetchImpl = async (url) => {
    viaNode.push(String(url));
    return searxngResponse({ results: [{ url: "https://example.org/tokyo", title: "tokyo", engine: "google" }] });
  };
  const handler = createWebSearchGatewayHandler(config, runtimeManager, { fetchImpl: localFetch, edge: { hosts: new Set() }, edgeFetchImpl });
  let res = response();
  await handler(request({ query: "semaglutide heart failure" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data.results.map((row) => row.url), ["https://example.org/tokyo"]);
  assert.equal(local.length, 0, "a node that answers leaves this host's SearXNG alone");
  assert.ok(viaNode[0].startsWith(`${edgeUrl}?q=semaglutide+heart+failure`));

  const downNode = createWebSearchGatewayHandler(config, runtimeManager, {
    fetchImpl: localFetch,
    edge: { hosts: new Set() },
    edgeFetchImpl: async () => { throw new Error("node down"); },
  });
  res = response();
  await downNode(request({ query: "semaglutide" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().data.results.map((row) => row.url), ["https://example.org/local"]);

  const noNode = createWebSearchGatewayHandler(config, runtimeManager, { fetchImpl: localFetch, edgeFetchImpl });
  res = response();
  await noNode(request({ query: "semaglutide" }), res);
  assert.deepEqual(res.json().data.results.map((row) => row.url), ["https://example.org/local"], "no node configured, the edge URL is ignored");
});

test("trusted evolution run purpose reserves paid search against its own budget", async () => {
  const ledger = fakeLedger();
  let identity;
  const res = await metered({ ...withBailian, evolutionDailyBudgetCny: 7, userDailySpendLimit: 1, userWeeklySpendLimit: 2, userRunSpendLimit: 0.01 }, async url => String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? searxngResponse({ output: { search_info: { search_results: [] } }, usage: { input_tokens: 10, output_tokens: 1 } })
    : searxngResponse({ results: [] }), ledger, { runPurpose: async input => { identity = input; return "evolution"; } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(identity, { userId: "alice", projectId: "paper1", runId: "run-7" });
  const reserve = ledger.calls.find(([kind]) => kind === "reserve")[1];
  assert.equal(reserve.purpose, "evolution");
  assert.equal(reserve.dailyLimit, 7);
  assert.equal(reserve.weeklyLimit, 0);
  assert.equal(reserve.runLimit, 0);
});

test("a run ledger that cannot be read does not cost the search its paid engine: the call is booked as web-search", async () => {
  const ledger = fakeLedger();
  const res = await metered({ ...withBailian, userDailySpendLimit: 1, userWeeklySpendLimit: 2 }, async url => String(url).startsWith("https://dashscope.aliyuncs.com/")
    ? searxngResponse({ output: { search_info: { search_results: [] } }, usage: { input_tokens: 10, output_tokens: 1 } })
    : searxngResponse({ results: [] }), ledger, { runPurpose: async () => { throw new Error("agent_runs_corrupt"); } });
  assert.equal(res.statusCode, 200);
  const reserve = ledger.calls.find(([kind]) => kind === "reserve")?.[1];
  assert.ok(reserve, "the Bailian leg still ran");
  assert.equal(reserve.purpose, "web-search");
});
