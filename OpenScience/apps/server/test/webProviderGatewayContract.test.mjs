// The runtime's `ctx.web` provider (`evimed-gateway`, packages/socket/plugins/web.mjs) read against what the gateways
// actually answer, not against a shape this file decided on. The web-search gateway runs for real here, its DeepSeek
// engine replaying the answers recorded from the live API on 2026-10-17 (fixtures/deepseek-tools); its HTTP body is
// what the provider is handed. The provider read `payload.results`, a field the gateway never sends (`data.results`),
// and answered rows the kernel does not read (`results` instead of `sources`), so every search through the registry came
// back empty and a consumer would have thrown on the cap step. The web read is the gateway's own result builder for a
// DeepSeek rendition. The contract is `@deepseek-ai/dsh-web`'s `WebSearchResult` / `WebFetchResult` at 0.2.1-rc.2.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { apply as applyWebProvider } from "../../../packages/socket/plugins/web.mjs";
import { deepseekRenditionResult } from "../src/deepseekTools.mjs";
import { createWebSearchGatewayHandler, WEB_SEARCH_GATEWAY_PATH } from "../src/webSearchGateway.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/deepseek-tools/recorded-2026-10-17.json", import.meta.url), "utf8")).answers;
const caller = { userId: "alice", projectId: "paper1", runId: null, dailyLimit: 0, weeklyLimit: 0 };
const deepseekAlone = { webSearchTimeoutMs: 5_000, deepseekApiKey: "sk-test-only-deepseek-key", deepseekBaseUrl: "https://api.deepseek.com" };

/** The gateway's own handler, its DeepSeek engine answering the recorded body. @param {any} body */
async function gatewayAnswer(body) {
  const upstream = JSON.stringify(recorded["search-basic"].body);
  const fetchImpl = async () => ({
    ok: true, status: 200, text: async () => upstream, body: { cancel: async () => {} },
    headers: new Headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(upstream)) }),
  });
  const handler = createWebSearchGatewayHandler(deepseekAlone, { assertActiveModelGatewayToken: () => caller }, { fetchImpl, attributeRun: async () => "run-1" });
  const payload = JSON.stringify(body);
  const stream = (async function* () { yield Buffer.from(payload, "utf8"); })();
  /** @type {Buffer[]} */
  const chunks = [];
  const res = { statusCode: 0, writeHead(/** @type {number} */ status) { this.statusCode = status; }, end(/** @type {any} */ chunk) { if (chunk) chunks.push(Buffer.from(chunk)); } };
  await handler(/** @type {any} */ ({ method: "POST", url: WEB_SEARCH_GATEWAY_PATH, headers: { authorization: "Bearer runtime-token" }, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() }), /** @type {any} */ (res));
  assert.equal(res.statusCode, 200, Buffer.concat(chunks).toString("utf8"));
  return Buffer.concat(chunks).toString("utf8");
}

/** The provider as the kernel mounts it, with `fetch` answering each gateway call through `answer`. */
async function provider(/** @type {(url: string, body: any) => Promise<string>} */ answer) {
  /** @type {Record<string, any>} */
  const registered = {};
  const ctx = {
    effect: (/** @type {() => unknown} */ fn) => fn(),
    get: (/** @type {string} */ name) => (name === "fs" ? { resolve: async (/** @type {string} */ file) => file, readText: async () => "runtime-token\n" } : undefined),
    web: {
      registerSearchProvider: (/** @type {any} */ value) => { registered.search = value; return () => {}; },
      registerFetchProvider: (/** @type {any} */ value) => { registered.fetch = value; return () => {}; },
    },
  };
  await applyWebProvider(ctx, { searchUrl: "http://open-science-web:8787/internal/web-search/v1/search", fetchUrl: "http://open-science-web:8787/internal/sources/v1/fetch", tokenFile: "/run/evimed/token", timeoutMs: 30_000 });
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => new Response(await answer(String(url), JSON.parse(init.body)), { status: 200, headers: { "content-type": "application/json" } }));
  return { registered, restore: () => { globalThis.fetch = original; } };
}

test("a ctx.web search through the gateway returns its rows as the kernel's sources, the engine's date as publishedAt", async () => {
  /** @type {any[]} */
  const asked = [];
  const { registered, restore } = await provider(async (_url, body) => { asked.push(body); return gatewayAnswer(body); });
  try {
    const found = await registered.search.search({ query: "DeepSeek 2026-10-17 发布", maxResults: 4 });
    assert.deepEqual(asked, [{ query: "DeepSeek 2026-10-17 发布", limit: 4 }], "the kernel's maxResults is the gateway's limit");
    assert.equal(found.truncated, false);
    assert.ok(found.sources.length > 0 && found.sources.length <= 4, `the gateway's rows arrived: ${JSON.stringify(found)}`);
    const recordedRows = recorded["search-basic"].body.results;
    for (const source of found.sources) {
      assert.deepEqual(Object.keys(source).filter((key) => !["url", "title", "snippet", "publishedAt"].includes(key)), [], "only the contract's fields");
      assert.match(source.url, /^https?:\/\//);
      assert.ok(recordedRows.some((/** @type {any} */ row) => row.url === source.url), `${source.url} is one of DeepSeek's recorded rows`);
    }
    assert.ok(found.sources.some((/** @type {any} */ source) => typeof source.publishedAt === "string" && source.publishedAt), "a dated row keeps its date");
  } finally {
    restore();
  }
});

test("a ctx.web fetch through the gateway is the page as text with its final address and status", async () => {
  const docs = recorded["fetch-docs"];
  const rendition = deepseekRenditionResult({ url: docs.request.url, title: "DeepSeek API Docs", content: docs.body.content, reason: "challenge" });
  const { registered, restore } = await provider(async (_url, body) => {
    assert.deepEqual(body, { webRead: { url: docs.request.url } });
    return JSON.stringify(rendition);
  });
  try {
    const page = await registered.fetch.fetch({ url: docs.request.url });
    assert.deepEqual(Object.keys(page).sort(), ["body", "statusCode", "truncated", "url"]);
    assert.equal(page.url, rendition.receipt.finalUrl);
    assert.equal(page.statusCode, 200);
    assert.equal(page.body.kind, "text");
    assert.equal(page.body.content, rendition.text);
    assert.equal(page.truncated, false);
  } finally {
    restore();
  }
});
