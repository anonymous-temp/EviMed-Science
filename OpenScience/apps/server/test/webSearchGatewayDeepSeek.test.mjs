// DeepSeek's search API as the web-search gateway's third engine (2026-10-17). The answers replayed here were recorded
// from the live API that day (fixtures/deepseek-tools); the statuses DeepSeek would not produce on request (403, 429,
// 5xx) are built on the error envelope it was recorded answering.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { REFERENCE_PRICE_LIST, priceUsage } from "@evimed/domain";
import { createDeepSeekTools, deepseekResultDate, deepseekToolMetricFamilies } from "../src/deepseekTools.mjs";
import { providerRefusalCount } from "../src/providerRefusals.mjs";
import { createWebSearchGatewayHandler, WEB_SEARCH_GATEWAY_PATH } from "../src/webSearchGateway.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/deepseek-tools/recorded-2026-10-17.json", import.meta.url), "utf8")).answers;
const KEY = "sk-test-only-deepseek-key";
const caller = { userId: "alice", projectId: "paper1", runId: null, dailyLimit: 0, weeklyLimit: 0 };
const identifying = { assertActiveModelGatewayToken: () => caller };
const searxng = { webSearchUrl: "http://open-science-web-search:8080/", webSearchTimeoutMs: 5_000 };
const withDeepSeek = { ...searxng, deepseekApiKey: KEY, deepseekBaseUrl: "https://api.deepseek.com" };
const deepseekAlone = { webSearchTimeoutMs: 5_000, deepseekApiKey: KEY, deepseekBaseUrl: "https://api.deepseek.com" };

function request(body) {
  const payload = JSON.stringify(body);
  const stream = (async function* () { yield Buffer.from(payload, "utf8"); })();
  return { method: "POST", url: WEB_SEARCH_GATEWAY_PATH, headers: { authorization: "Bearer runtime-token" }, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() };
}

function response() {
  const chunks = [];
  return {
    statusCode: 0,
    writeHead(status) { this.statusCode = status; },
    end(chunk) { if (chunk) chunks.push(chunk); this.body = Buffer.concat(chunks).toString("utf8"); },
    json() { return JSON.parse(this.body); },
  };
}

function answer(payload, status = 200) {
  const body = JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }), text: async () => body, body: { cancel: async () => {} } };
}

/** A fetch that answers DeepSeek with `deepseek` and SearXNG with one page, recording what was sent. */
function upstreams(deepseek, { searx = [{ url: "https://example.org/searx-1", title: "SearXNG one", content: "one", engine: "bing" }] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    sent.push({ url: target, init });
    if (target.startsWith("https://api.deepseek.com/")) return typeof deepseek === "function" ? deepseek(init) : deepseek;
    return answer({ results: searx });
  };
  return { sent, fetchImpl };
}

function fakeLedger({ refuse = null } = {}) {
  const calls = [];
  return {
    calls,
    async reserveModel(input) { calls.push(["reserve", input]); if (refuse) throw Object.assign(new Error("refused"), { code: refuse }); return { id: input.id }; },
    async settleModel(userId, id, input) { calls.push(["settle", { userId, id, ...input }]); },
    async markUncertain(userId, id, code, options) { calls.push(["uncertain", { userId, id, code, ...options }]); },
    async release(userId, id, code) { calls.push(["release", { userId, id, code }]); },
  };
}

async function search(config, fetchImpl, body, { usageLedger = null, deepseekTools = null } = {}) {
  const handler = createWebSearchGatewayHandler(config, identifying, { fetchImpl, usageLedger, attributeRun: async () => "run-7", deepseekTools });
  const res = response();
  await handler(request(body), res);
  return res;
}

test("DeepSeek's rows lead each round of the merge, deduplicated by address, with the day, the site and its authority", async () => {
  const deepseekRows = recorded["search-basic"].body.results;
  // SearXNG found DeepSeek's second page too (another query string): one page, kept once, as DeepSeek's richer row.
  const { sent, fetchImpl } = upstreams(answer(recorded["search-basic"].body), {
    searx: [{ url: `${deepseekRows[1].url}?from=bing`, title: "dup", content: "dup", engine: "bing" }, { url: "https://example.org/searx-2", title: "Two", content: "two", engine: "bing" }],
  });
  const res = await search(withDeepSeek, fetchImpl, { query: "DeepSeek 2026-10-17 发布", limit: 6 });
  assert.equal(res.statusCode, 200);
  const { data } = res.json();
  assert.deepEqual(data.results.map((row) => row.engine), ["deepseek", "bing", "deepseek", "deepseek", "deepseek", "deepseek"]);
  assert.equal(data.results[0].url, deepseekRows[0].url, "DeepSeek's best (rerank_score 2.81) first");
  assert.equal(data.results[1].url, "https://example.org/searx-2", "SearXNG's duplicate of DeepSeek's second page is not repeated");
  assert.equal(data.results.filter((row) => row.url.startsWith(deepseekRows[1].url)).length, 1);
  const stcn = data.results.find((row) => row.url === "https://stcn.com/article/detail/4223928.html");
  assert.equal(stcn.publishedDate, "2026-10-17", "DeepSeek's 2026-10-16T16:00:00+00:00 is the 17th in Beijing, where the article is dated");
  assert.equal(stcn.site, "证券时报");
  assert.equal(stcn.authority, 4);
  assert.match(stcn.snippet, /V4\.1-Flash-1017/);
  assert.ok(!("rerankScore" in stcn), "the ordering key is not passed to the model");
  assert.ok(!("site" in data.results[1]) && !("authority" in data.results[1]), "fields an engine did not give are absent, not empty");
  assert.deepEqual(data.engines, ["bing", "deepseek"]);
  assert.deepEqual(data.unresponsiveEngines, []);
  const asked = sent.find((entry) => entry.url === "https://api.deepseek.com/v1/tools/search");
  assert.deepEqual(JSON.parse(asked.init.body), { query: "DeepSeek 2026-10-17 发布", count: 6 });
  assert.equal(asked.init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!res.body.includes(KEY), "the key never leaves in the answer");
});

test("a query over 128 characters is not sent to DeepSeek; the others answer it, and alone it is refused by name", async () => {
  const long = "x".repeat(129);
  const { sent, fetchImpl } = upstreams(answer(recorded["search-basic"].body));
  const res = await search(withDeepSeek, fetchImpl, { query: long });
  assert.equal(res.statusCode, 200);
  assert.ok(!sent.some((entry) => entry.url.startsWith("https://api.deepseek.com/")), "DeepSeek answers such a query 400 (recorded); it is not asked");
  assert.deepEqual(res.json().data.engines, ["bing"]);
  assert.deepEqual(res.json().data.unresponsiveEngines, [], "not asked is not unresponsive");
  assert.ok(res.json().warnings.some((warning) => /longer than 128 characters/.test(warning)));

  const alone = upstreams(answer(recorded["search-basic"].body));
  const refused = await search(deepseekAlone, alone.fetchImpl, { query: long });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().code, "web_search_query_invalid");
  assert.equal(alone.sent.length, 0);
  const exactly = await search(deepseekAlone, upstreams(answer(recorded["search-basic"].body)).fetchImpl, { query: "y".repeat(128) });
  assert.equal(exactly.statusCode, 200, "128 characters is within DeepSeek's limit");
});

test("DeepSeek alone is a configured search; switched off by its lever, or without a key, it is never asked", async () => {
  const alone = await search(deepseekAlone, upstreams(answer(recorded["search-site"].body)).fetchImpl, { query: "site:api-docs.deepseek.com tools search" });
  assert.equal(alone.statusCode, 200);
  assert.ok(alone.json().data.results.every((row) => row.url.startsWith("https://api-docs.deepseek.com/")), "the site: operator is DeepSeek's own");

  for (const config of [{ ...withDeepSeek, webSearchDeepseekEnabled: false }, { ...withDeepSeek, deepseekApiKey: "" }]) {
    const { sent, fetchImpl } = upstreams(answer(recorded["search-basic"].body));
    const res = await search(config, fetchImpl, { query: "DeepSeek 2026-10-17 发布" });
    assert.equal(res.statusCode, 200);
    assert.ok(!sent.some((entry) => entry.url.startsWith("https://api.deepseek.com/")));
    assert.deepEqual(res.json().data.engines, ["bing"]);
  }
  const off = await search({ ...deepseekAlone, webSearchDeepseekEnabled: false }, upstreams(answer({})).fetchImpl, { query: "q" });
  assert.equal(off.statusCode, 503);
  assert.equal(off.json().code, "web_search_unconfigured");
});

test("a 429, a 5xx, a timeout or a refusal from DeepSeek is a thinner answer that names it; a content-policy 403 alone is its own code", async () => {
  const envelope = (status, type) => answer({ error: { message: `refused (request_id: <request-id>)`, type, param: null, code: type } }, status);
  for (const [status, type] of [[429, "rate_limit_error"], [500, "server_error"], [504, "gateway_timeout_error"], [402, "insufficient_balance"], [403, "content_policy_error"]]) {
    const res = await search(withDeepSeek, upstreams(envelope(status, type)).fetchImpl, { query: "q" });
    assert.equal(res.statusCode, 200, `HTTP ${status} from DeepSeek does not fail a search another engine answered`);
    assert.deepEqual(res.json().data.unresponsiveEngines, ["deepseek"]);
    assert.deepEqual(res.json().data.engines, ["bing"]);
    assert.ok(!res.body.includes("request_id"), "DeepSeek's own message is never passed on");
  }
  const cases = [[403, "web_search_content_refused", 403], [429, "web_search_rate_limited", 429], [500, "web_search_upstream_error", 502], [504, "web_search_timeout", 504], [401, "web_search_upstream_error", 502]];
  for (const [status, code, ours] of cases) {
    const res = await search(deepseekAlone, upstreams(status === 401 ? answer(recorded["search-bogus-key"].body, 401) : envelope(status, "x")).fetchImpl, { query: "q" });
    assert.equal(res.statusCode, ours, `DeepSeek ${status} alone`);
    assert.equal(res.json().code, code);
    assert.ok(!res.body.includes("****"), "not even the masked key of a 401 is repeated");
  }
  const before = providerRefusalCount("deepseek", 402);
  await search(deepseekAlone, upstreams(envelope(402, "insufficient_balance")).fetchImpl, { query: "q" });
  assert.equal(providerRefusalCount("deepseek", 402), before + 1, "an exhausted balance is counted for the operator's alert, as the model gateway's is");

  const lost = await search(withDeepSeek, upstreams(() => { throw new TypeError("fetch failed"); }).fetchImpl, { query: "q" });
  assert.equal(lost.statusCode, 200);
  assert.deepEqual(lost.json().data.unresponsiveEngines, ["deepseek"]);
});

test("each search is reserved at its per-request price as web-search and settled on success; a failure is released, a lost answer uncertain", async () => {
  const price = priceUsage({ resourceType: "tool-request", tool: "deepseek-search", requests: 1, peak: true }).cost;
  assert.equal(price, 0.005, "¥5 per thousand successful requests");
  let ledger = fakeLedger();
  let res = await search({ ...withDeepSeek, userDailySpendLimit: 20, userRunSpendLimit: 5 }, upstreams(answer(recorded["search-basic"].body)).fetchImpl, { query: "q" }, { usageLedger: ledger });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ledger.calls.map(([kind]) => kind), ["reserve", "settle"]);
  const [, reserve] = ledger.calls[0];
  assert.equal(reserve.model, "deepseek-search");
  assert.equal(reserve.purpose, "web-search");
  assert.equal(reserve.runId, "run-7", "charged to the run the project is running");
  assert.equal(reserve.priceVersion, REFERENCE_PRICE_LIST.version);
  assert.equal(reserve.estimatedCost, price);
  assert.equal(reserve.dailyLimit, 20);
  assert.equal(reserve.runLimit, 5);
  assert.match(reserve.requestFingerprint, /^[0-9a-f]{64}$/);
  const [, settle] = ledger.calls[1];
  assert.equal(settle.id, reserve.id);
  assert.equal(settle.actualCost, price);
  assert.equal(settle.priced, true);
  assert.deepEqual(settle.usage, { cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0 });

  for (const [status, code] of [[400, "provider_refused_400"], [429, "provider_refused_429"], [403, "provider_refused_403"], [500, "provider_failed_500"], [504, "provider_failed_504"]]) {
    ledger = fakeLedger();
    res = await search(withDeepSeek, upstreams(answer(recorded["search-too-long"].body, status)).fetchImpl, { query: "q" }, { usageLedger: ledger });
    assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["release", code]], `HTTP ${status}: DeepSeek bills only a successful request`);
  }
  // A 200 with no result is not billed either ("搜索无结果…不计费"); a 200 whose body cannot be read may have been.
  ledger = fakeLedger();
  res = await search(withDeepSeek, upstreams(answer({ results: [] })).fetchImpl, { query: "q" }, { usageLedger: ledger });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["release", "provider_no_result"]]);
  assert.deepEqual(res.json().data.unresponsiveEngines, [], "an empty answer is an answer");
  ledger = fakeLedger();
  await search(withDeepSeek, upstreams({ ...answer({}), text: async () => "<html>gateway</html>" }).fetchImpl, { query: "q" }, { usageLedger: ledger });
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["uncertain", "response_usage_missing"]]);
  ledger = fakeLedger();
  await search(withDeepSeek, upstreams(() => { throw new TypeError("socket hang up"); }).fetchImpl, { query: "q" }, { usageLedger: ledger });
  assert.deepEqual(ledger.calls.map(([kind, input]) => [kind, input.code ?? null]), [["reserve", null], ["uncertain", "provider_response_incomplete"]]);
  assert.equal(ledger.calls[1][1].estimatedCost, price, "sent and lost: possibly served, bounded at one request");

  // Over budget: never sent; the others answer, and DeepSeek alone is a named refusal.
  let sentToDeepSeek = 0;
  const counting = upstreams(() => { sentToDeepSeek += 1; return answer(recorded["search-basic"].body); });
  res = await search(withDeepSeek, counting.fetchImpl, { query: "q" }, { usageLedger: fakeLedger({ refuse: "usage_budget_exceeded" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(sentToDeepSeek, 0, "a search the caps refuse never leaves");
  assert.deepEqual(res.json().data.unresponsiveEngines, ["deepseek"]);
  res = await search(deepseekAlone, counting.fetchImpl, { query: "q" }, { usageLedger: fakeLedger({ refuse: "usage_budget_exceeded" }) });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "web_search_unavailable");
  assert.match(res.json().error, /spending limit is reached/);
  // Where the ledger is required and absent, DeepSeek is not called at all.
  res = await search({ ...withDeepSeek, requireDurableUsageLedger: true }, counting.fetchImpl, { query: "q" });
  assert.equal(res.statusCode, 200);
  assert.equal(sentToDeepSeek, 0);
});

test("the process holds DeepSeek's five requests a second per tool: a burst waits its turn, and what would wait too long is shed and answered without it", async () => {
  let clock = 1_000_000;
  const waits = [];
  const tools = createDeepSeekTools(withDeepSeek, {
    fetchImpl: upstreams(answer(recorded["search-basic"].body)).fetchImpl,
    now: () => clock,
    wait: async (ms) => { waits.push(ms); },
  });
  const burst = await Promise.all(Array.from({ length: 12 }, () => search(withDeepSeek, upstreams(answer(recorded["search-basic"].body)).fetchImpl, { query: "q" }, { deepseekTools: tools })));
  // Slots 200 ms apart from one instant: the 2nd–11th wait 200…2000 ms, the 12th would wait 2200 ms and is shed.
  assert.deepEqual(waits, [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
  assert.equal(burst.filter((res) => res.json().data.engines.includes("deepseek")).length, 11);
  const shed = burst.filter((res) => res.json().data.unresponsiveEngines.includes("deepseek"));
  assert.equal(shed.length, 1);
  assert.ok(shed[0].json().data.results.length > 0, "the shed search is answered by the other engine");
  const stats = tools.stats();
  assert.deepEqual(stats.limiter.search, { waited: 10, refused: 1 });
  assert.equal(stats.outcomes.search.ok, 11);
  assert.equal(stats.outcomes.search.shed, 1);
  assert.deepEqual(stats.limiter.fetch, { waited: 0, refused: 0 }, "fetch has a pacer of its own");
  const families = deepseekToolMetricFamilies(stats);
  assert.ok(families[0].series.some((row) => row.labels.tool === "search" && row.labels.outcome === "shed" && row.value === 1));
  assert.ok(families[1].series.some((row) => row.labels.tool === "search" && row.labels.action === "waited" && row.value === 10));
  clock += 5_000;
  const later = await search(withDeepSeek, upstreams(answer(recorded["search-basic"].body)).fetchImpl, { query: "q" }, { deepseekTools: tools });
  assert.ok(later.json().data.engines.includes("deepseek"), "the rate frees again as time passes");
});

test("DeepSeek's day is read in Beijing; any other instant passes unchanged", () => {
  assert.equal(deepseekResultDate("2026-10-16T16:00:00+00:00"), "2026-10-17");
  assert.equal(deepseekResultDate("2026-08-12T16:00:00+00:00"), "2026-08-13");
  assert.equal(deepseekResultDate("2026-10-17T08:34:00+00:00"), "2026-10-17T08:34:00+00:00");
  assert.equal(deepseekResultDate(null), null);
  assert.equal(deepseekResultDate("not a date"), null);
});

test("a runtime is offered web_search whenever the gateway has an engine, the paid ones included", async () => {
  const { webSearchHasEngine } = await import("../src/webSearchGateway.mjs");
  const { webSearchGatewayProviderUrl } = await import("../src/runtimeManager.mjs");
  const internal = { webSearchGatewayInternalUrl: "http://open-science-web:8787/internal/search/v1/query" };
  const cases = [
    [{}, false],
    [{ webSearchUrl: "http://open-science-web-search:8080/search" }, true],
    [{ deepseekApiKey: KEY }, true, "DeepSeek alone: before 2026-10-17 such a runtime was told search was not configured"],
    [{ deepseekApiKey: KEY, webSearchDeepseekEnabled: false }, false],
    [{ dashscopeApiKey: "sk-dashscope-not-real", webSearchBailianEnabled: true }, true],
    [{ dashscopeApiKey: "sk-dashscope-not-real" }, false, "Bailian is off unless switched on"],
    [{ webSearchEdgeUrl: "http://127.0.0.1:8888/search", edgeProxyUrl: "https://edge.example.org/" }, true],
    [{ webSearchEdgeUrl: "http://127.0.0.1:8888/search" }, false, "the node's SearXNG needs the node"],
  ];
  for (const [config, expected, why] of cases) {
    assert.equal(webSearchHasEngine(config), expected, why ?? JSON.stringify(config));
    assert.equal(webSearchGatewayProviderUrl({ ...internal, ...config }), expected ? internal.webSearchGatewayInternalUrl : "");
  }
});
